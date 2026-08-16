//
//  tokens.ts - the JSE tokenizer. TS twin of JSE.swift / Jse.kt `tokenize` — same token
//  kinds, same regex-literal heuristic, same dotted-ident rule (a.b.c is ONE token).
//
//  Syntax wave 1 (OpenSource/Conformance/jse/syntax-001.json): every tokenize entry runs
//  the shared source PREPROCESSOR first — comments stripped (`// …` to EOL, `/* … */` to
//  one space; regex literals and `://` protocol slashes are never comments), then the ASI
//  pass (a statement-boundary newline becomes `;` — the jsLeaf continuation heuristic,
//  so `x = 1\ny = 2` splits but `1 +\n2` and a leading `.method()` line join). String
//  literals carry the JS escape grammar; `` ` `` templates lex as one token with tokenized
//  `${ }` holes; numeric literals take exponents, 0x/0b/0o radix forms and `_` separators.
//

export type TemplatePart = { s: string } | { toks: Token[] };

export type Token =
  | { kind: "num"; v: number }
  | { kind: "str"; v: string }
  | { kind: "ident"; v: string }
  | { kind: "op"; v: string }
  | { kind: "regex"; pattern: string; flags: string }
  | { kind: "template"; parts: TemplatePart[] };

import { swiftDouble } from "./values.ts";

const threeCharOps = ["===", "!==", ">>>", "**=", "..."];
const twoCharOps = [
  "==", "!=", "<=", ">=", "&&", "||", "=>",
  "**", "??", "?.", "<<", ">>", "++", "--", "+=", "-=", "*=", "/=", "%=",
];

function isDigit(c: string): boolean { return c >= "0" && c <= "9"; }
function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}
function isLetter(c: string): boolean { return /\p{L}/u.test(c); }
function isWordChar(c: string): boolean { return isLetter(c) || isDigit(c) || c === "_"; }

// ── the shared source preprocessor (comments, then ASI) ─────────────────────────────
// The twins run the SAME two passes inside tokenize (JSE.swift / Jse.kt preprocessSource);
// the native statement runners additionally run pass 1 at the string level before jsLeaf.

/** `/` at `i` starts a regex literal — the standard JS lexer heuristic at CHAR level:
 *  prefix position = no previous significant char, or an operator char that is not a
 *  value terminator (`)`, `]`, quote, word). Mirrors the token-level rule below. */
function charAllowsRegex(prev: string | null): boolean {
  if (prev === null) return true;
  if (isWordChar(prev)) return false;
  return prev !== ")" && prev !== "]" && prev !== "'" && prev !== "\"" && prev !== "`";
}

/** Keywords a regex literal may DIRECTLY follow (`return /ab/.test(s)`, `case /a/…`,
 *  `typeof /x/`) — shared by the char-level scanners and the token-level rule. */
const regexKeywords = new Set(["return", "case", "typeof", "in", "of", "do", "else", "throw"]);

/** Char-level companion to charAllowsRegex: when the previous significant char is a word
 *  char, scan the word back in the emitted buffer (bounded) — a keyword still puts the
 *  `/` in regex position (`return /ab/`), an ident/number does not (`x / 2`). */
function regexAfterKeyword(out: string[]): boolean {
  let t = out.length - 1;
  while (t >= 0 && /\s/.test(out[t]!)) t -= 1;
  let w = "";
  while (t >= 0 && isWordChar(out[t]!) && w.length <= 8) { w = out[t]! + w; t -= 1; }
  if (t >= 0 && isWordChar(out[t]!)) return false; // longer word — not one of ours
  return regexKeywords.has(w);
}

/** Scan a regex literal starting at the `/` at `i` (backslash pairs + [class] aware).
 *  Returns the index one past the flags, or -1 if unterminated (→ it was division). */
function scanRegexEnd(c: string[], i: number): number {
  let j = i + 1;
  let inClass = false;
  let closed = false;
  while (j < c.length) {
    const rc = c[j]!;
    if (rc === "\\" && j + 1 < c.length) { j += 2; continue; }
    if (rc === "[") inClass = true;
    if (rc === "]") inClass = false;
    if (rc === "/" && !inClass) { closed = true; j += 1; break; }
    if (rc === "\n") break; // literals don't span lines
    j += 1;
  }
  if (!closed || j === i + 1) return -1;
  while (j < c.length && isLetter(c[j]!)) j += 1;
  return j;
}

/** Copy a quoted span (`'` / `"`) verbatim, honoring backslash pairs. `i` is at the
 *  open quote; returns the index one past the close quote (or end). */
function copyQuoted(c: string[], i: number, out: string[]): number {
  const q = c[i]!;
  out.push(q);
  let j = i + 1;
  while (j < c.length) {
    const ch = c[j]!;
    if (ch === "\\" && j + 1 < c.length) { out.push(ch, c[j + 1]!); j += 2; continue; }
    out.push(ch);
    j += 1;
    if (ch === q) break;
  }
  return j;
}

/** Copy a template span verbatim (`\`` … `\``), honoring backslash pairs and `${ }`
 *  hole depth so a `}` inside a hole and a backtick inside a hole don't close it.
 *  Inside a hole, quoted spans delegate to copyQuoted and nested backticks recurse (a
 *  `'{'` string literal in a hole must not skew the depth); recursion is depth-capped
 *  (past ~32 a backtick copies as a plain char — bounded, never a stack overflow). */
function copyTemplate(c: string[], i: number, out: string[], depth = 0): number {
  out.push("`");
  let j = i + 1;
  let hole = 0;
  while (j < c.length) {
    const ch = c[j]!;
    if (ch === "\\" && j + 1 < c.length) { out.push(ch, c[j + 1]!); j += 2; continue; }
    if (hole === 0 && ch === "`") { out.push(ch); j += 1; break; }
    if (hole > 0 && (ch === "'" || ch === "\"")) { j = copyQuoted(c, j, out); continue; }
    if (hole > 0 && ch === "`" && depth < 32) { j = copyTemplate(c, j, out, depth + 1); continue; }
    if (ch === "$" && j + 1 < c.length && c[j + 1] === "{") { out.push("$", "{"); hole += 1; j += 2; continue; }
    if (hole > 0 && ch === "{") hole += 1;
    if (hole > 0 && ch === "}") hole -= 1;
    out.push(ch);
    j += 1;
  }
  return j;
}

/** Pass 1 — strip JS comments: `// …` to end of line (newline kept — it is the statement
 *  break) and `/* … *​/` to ONE space. Quote-, template- and regex-literal-aware, so
 *  `replace(/\//g, '-')` and `'https://x'` survive; `://` outside a string is protocol
 *  syntax (the fetch-effect URL form), never a comment. */
export function stripComments(s: string): string {
  if (!s.includes("//") && !s.includes("/*")) return s;
  const c = Array.from(s);
  const out: string[] = [];
  let i = 0;
  let prevSig: string | null = null; // last significant (non-whitespace) char copied
  while (i < c.length) {
    const ch = c[i]!;
    if (ch === "'" || ch === "\"") { i = copyQuoted(c, i, out); prevSig = ch; continue; }
    if (ch === "`") { i = copyTemplate(c, i, out); prevSig = "`"; continue; }
    if (ch === "/" && i + 1 < c.length && c[i + 1] === "/" && prevSig !== ":") {
      while (i < c.length && c[i] !== "\n") i += 1; // drop to EOL (keep the newline)
      continue;
    }
    if (ch === "/" && i + 1 < c.length && c[i + 1] === "*") {
      i += 2;
      while (i + 1 < c.length && !(c[i] === "*" && c[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, c.length);
      out.push(" "); // never glue the surrounding tokens
      continue;
    }
    if (ch === "/" && (charAllowsRegex(prevSig) || (prevSig !== null && isWordChar(prevSig) && regexAfterKeyword(out)))) {
      const end = scanRegexEnd(c, i);
      if (end > 0) {
        for (let k = i; k < end; k++) out.push(c[k]!);
        i = end;
        prevSig = c[end - 1]!;
        continue;
      }
    }
    out.push(ch);
    if (!/\s/.test(ch)) prevSig = ch;
    i += 1;
  }
  return out.join("");
}

/** The jsLeaf continuation heuristic (the native runners' ASI rule), char-level:
 *  a depth-0 newline ends the statement UNLESS the line is clearly unfinished
 *  (ends in a binary operator / dot / comma — but not `++`/`--`) or the next line can
 *  only be a continuation (starts `.` / `?` / `:` / `&&` / `||`). */
function lineContinues(out: string[], c: string[], after: number): boolean {
  let t = out.length - 1;
  while (t >= 0 && (out[t] === " " || out[t] === "\t" || out[t] === "\r")) t -= 1;
  if (t >= 0) {
    const last = out[t]!;
    const isIncDec = (last === "+" || last === "-") && t >= 1 && out[t - 1] === last;
    if (!isIncDec && "+-*/%&|<>=!?:,.".includes(last)) return true;
  }
  let j = after + 1;
  while (j < c.length && /\s/.test(c[j]!)) j += 1;
  if (j >= c.length) return false;
  const ch = c[j]!;
  if (ch === "." || ch === "?" || ch === ":") return true;
  if ((ch === "&" || ch === "|") && j + 1 < c.length && c[j + 1] === ch) return true;
  return false;
}

/** Scan the WORD that starts the next line (past whitespace) — bounded. */
function nextWord(c: string[], after: number): string {
  let j = after + 1;
  while (j < c.length && /\s/.test(c[j]!)) j += 1;
  let w = "";
  while (j < c.length && isWordChar(c[j]!) && w.length <= 8) { w += c[j]; j += 1; }
  return w;
}

/** True when the `{` being pushed opens a `do` block (the word before it is `do`). */
function braceOpensDo(out: string[]): boolean {
  let t = out.length - 1;
  while (t >= 0 && /\s/.test(out[t]!)) t -= 1;
  if (t < 1 || out[t] !== "o" || out[t - 1] !== "d") return false;
  return t - 2 < 0 || !isWordChar(out[t - 2]!);
}

/** A newline here must NOT become `;` because the next line's keyword ATTACHES to the
 *  just-closed `{ }` block: `}` + `else`/`catch`/`finally` (an if/try branch), and `}` +
 *  `while` when that brace closed a `do` block. Braceless branches keep the `;` — there
 *  the separator is load-bearing (the statement capture stops at it). */
function keywordJoinsBlock(c: string[], after: number, prevSig: string | null, closedDo: boolean): boolean {
  if (prevSig !== "}") return false;
  const w = nextWord(c, after);
  if (w === "else" || w === "catch" || w === "finally") return true;
  return w === "while" && closedDo;
}

/** Pass 2 — ASI: replace each statement-boundary newline with `;`. A newline is a
 *  boundary only where a statement can end: at bracket-stack depth zero or directly
 *  inside a `{ }` body (never inside `( )` / `[ ]`, where newlines stay soft), and only
 *  when the continuation heuristic says the statement is complete. Never before a line
 *  whose `else`/`while`/`catch`/`finally` attaches to the `}` block just closed. */
export function asiSemicolons(s: string): string {
  if (!s.includes("\n")) return s;
  const c = Array.from(s);
  const out: string[] = [];
  const stack: string[] = []; // "(" / "[" / "{" / "D" (a `{` opened by `do`)
  let i = 0;
  let prevSig: string | null = null;
  let justClosedDo = false; // the last significant char was a `}` closing a do-block
  while (i < c.length) {
    const ch = c[i]!;
    if (ch === "'" || ch === "\"") { i = copyQuoted(c, i, out); prevSig = ch; justClosedDo = false; continue; }
    if (ch === "`") { i = copyTemplate(c, i, out); prevSig = "`"; justClosedDo = false; continue; }
    if (ch === "/" && (charAllowsRegex(prevSig) || (prevSig !== null && isWordChar(prevSig) && regexAfterKeyword(out)))) {
      const end = scanRegexEnd(c, i);
      if (end > 0) {
        for (let k = i; k < end; k++) out.push(c[k]!);
        prevSig = c[end - 1]!;
        justClosedDo = false;
        i = end;
        continue;
      }
    }
    let closesDo = false;
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch === "{" && braceOpensDo(out) ? "D" : ch);
    else if (ch === ")" || ch === "]" || ch === "}") { const p = stack.pop(); closesDo = ch === "}" && p === "D"; }
    else if (ch === "\n") {
      const innermost = stack.length > 0 ? stack[stack.length - 1]! : null;
      if ((innermost === null || innermost === "{" || innermost === "D") && !lineContinues(out, c, i) &&
          !keywordJoinsBlock(c, i, prevSig, justClosedDo)) {
        out.push(";");
        i += 1;
        continue;
      }
    }
    out.push(ch);
    if (!/\s/.test(ch)) { prevSig = ch; justClosedDo = closesDo; }
    i += 1;
  }
  return out.join("");
}

/** The shared entry: lone `\r` line endings normalized, comments out, then
 *  statement-boundary newlines to `;`. */
export function preprocessSource(s: string): string {
  const normalized = s.includes("\r") ? s.replace(/\r(?!\n)/g, "\n") : s;
  return asiSemicolons(stripComments(normalized));
}

// ── string-literal escapes (the JS set; unknown escape = the char itself) ───────────

function unescapeInto(str: string[], c: string[], j: number): number {
  // `c[j]` is the char AFTER the backslash; returns the next index to resume at.
  const e = c[j]!;
  switch (e) {
    case "n": str.push("\n"); return j + 1;
    case "t": str.push("\t"); return j + 1;
    case "r": str.push("\r"); return j + 1;
    case "b": str.push("\b"); return j + 1;
    case "f": str.push("\f"); return j + 1;
    case "v": str.push("\v"); return j + 1;
    case "0": str.push("\0"); return j + 1;
    case "\n": return j + 1; // line continuation
    case "x": {
      if (j + 2 < c.length && isHexDigit(c[j + 1]!) && isHexDigit(c[j + 2]!)) {
        str.push(String.fromCharCode(parseInt(c[j + 1]! + c[j + 2]!, 16)));
        return j + 3;
      }
      str.push(e);
      return j + 1;
    }
    case "u": {
      if (j + 1 < c.length && c[j + 1] === "{") {
        let k = j + 2;
        let hex = "";
        while (k < c.length && isHexDigit(c[k]!)) { hex += c[k]; k += 1; }
        if (k < c.length && c[k] === "}" && hex.length >= 1 && hex.length <= 6) {
          const cp = parseInt(hex, 16);
          if (cp <= 0x10ffff) { str.push(String.fromCodePoint(cp)); return k + 1; }
        }
        str.push(e);
        return j + 1;
      }
      if (j + 4 < c.length && isHexDigit(c[j + 1]!) && isHexDigit(c[j + 2]!) &&
          isHexDigit(c[j + 3]!) && isHexDigit(c[j + 4]!)) {
        str.push(String.fromCharCode(parseInt(c.slice(j + 1, j + 5).join(""), 16)));
        return j + 5;
      }
      str.push(e);
      return j + 1;
    }
    default: str.push(e); return j + 1; // \' \" \` \\ \/ and every unknown → the char
  }
}

// ── numeric literals ─────────────────────────────────────────────────────────────────

/** Scan a numeric literal at `i` (a digit, or `.` + digit). Underscore separators are
 *  consumed only BETWEEN digits of the active alphabet. Returns [value, nextIndex]. */
function scanNumber(c: string[], i: number): [number, number] {
  const radix = (pfx: string, digit: (ch: string) => boolean, base: number): [number, number] | null => {
    if (!(c[i] === "0" && i + 1 < c.length && (c[i + 1] === pfx || c[i + 1] === pfx.toUpperCase()))) return null;
    let j = i + 2;
    let any = false;
    let v = 0;
    while (j < c.length) {
      const ch = c[j]!;
      if (digit(ch)) { v = v * base + parseInt(ch, base); any = true; j += 1; continue; }
      if (ch === "_" && any && j + 1 < c.length && digit(c[j + 1]!)) { j += 1; continue; }
      break;
    }
    if (!any) return null; // bare `0x` → the plain 0, `x…` lexes on
    return [v, j];
  };
  const hex = radix("x", isHexDigit, 16);
  if (hex) return hex;
  const bin = radix("b", (ch) => ch === "0" || ch === "1", 2);
  if (bin) return bin;
  const oct = radix("o", (ch) => ch >= "0" && ch <= "7", 8);
  if (oct) return oct;
  // decimal: digits [. digits] [ (e|E) [+-] digits ] with `_` between digits
  let j = i;
  let n = "";
  let seenDot = false;
  while (j < c.length) {
    const ch = c[j]!;
    if (isDigit(ch)) { n += ch; j += 1; continue; }
    if (ch === "." && !seenDot && j + 1 < c.length && isDigit(c[j + 1]!)) { seenDot = true; n += ch; j += 1; continue; }
    if (ch === "." && !seenDot && n.length > 0) { seenDot = true; n += ch; j += 1; continue; } // trailing `1.`
    if (ch === "_" && n.length > 0 && isDigit(c[j - 1]!) && j + 1 < c.length && isDigit(c[j + 1]!)) { j += 1; continue; }
    break;
  }
  if (j < c.length && (c[j] === "e" || c[j] === "E")) {
    let k = j + 1;
    if (k < c.length && (c[k] === "+" || c[k] === "-")) k += 1;
    if (k < c.length && isDigit(c[k]!)) {
      let exp = c[j]!;
      let m = j + 1;
      while (m < c.length && (isDigit(c[m]!) || ((c[m] === "+" || c[m] === "-") && m === j + 1))) { exp += c[m]; m += 1; }
      n += exp;
      j = m;
    }
  }
  return [swiftDouble(n) ?? 0, j];
}

// ── the tokenizer ────────────────────────────────────────────────────────────────────

export function tokenize(s: string): Token[] {
  return tokenizeRaw(preprocessSource(s));
}

function tokenizeRaw(s: string, holeDepth = 0): Token[] {
  const toks: Token[] = [];
  const c = Array.from(s); // per-code-point, like the Kotlin CharArray walk on BMP text
  let i = 0;
  while (i < c.length) {
    const ch = c[i]!;
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "'" || ch === '"') {
      // string literal — the JS escape grammar (unknown escape = the char itself)
      const q = ch;
      i += 1;
      const str: string[] = [];
      while (i < c.length && c[i] !== q) {
        if (c[i] === "\\" && i + 1 < c.length) { i = unescapeInto(str, c, i + 1); continue; }
        str.push(c[i]!);
        i += 1;
      }
      if (i < c.length) i += 1; // closing quote
      toks.push({ kind: "str", v: str.join("") });
      continue;
    }
    if (ch === "`") {
      // template literal — literal parts (escaped) + tokenized `${ }` holes
      i += 1;
      const parts: TemplatePart[] = [];
      let lit: string[] = [];
      while (i < c.length && c[i] !== "`") {
        if (c[i] === "\\" && i + 1 < c.length) { i = unescapeInto(lit, c, i + 1); continue; }
        if (c[i] === "$" && i + 1 < c.length && c[i + 1] === "{") {
          if (lit.length > 0) { parts.push({ s: lit.join("") }); lit = []; }
          i += 2;
          let depth = 1;
          const src: string[] = [];
          while (i < c.length) {
            const hc = c[i]!;
            if (hc === "'" || hc === "\"") { i = copyQuoted(c, i, src); continue; }
            if (hc === "`") { i = copyTemplate(c, i, src); continue; }
            if (hc === "{") depth += 1;
            else if (hc === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
            src.push(hc);
            i += 1;
          }
          // hole recursion is depth-capped (~32): past it the hole rides as literal
          // text — bounded, never a stack overflow on adversarial nesting
          if (holeDepth < 32) parts.push({ toks: tokenizeRaw(src.join(""), holeDepth + 1) });
          else parts.push({ s: src.join("") });
          continue;
        }
        lit.push(c[i]!);
        i += 1;
      }
      if (i < c.length) i += 1; // closing backtick
      if (lit.length > 0) parts.push({ s: lit.join("") });
      toks.push({ kind: "template", parts });
      continue;
    }
    if (isDigit(ch) || (ch === "." && i + 1 < c.length && isDigit(c[i + 1]!))) {
      const [v, next] = scanNumber(c, i);
      toks.push({ kind: "num", v });
      i = next;
      continue;
    }
    if (isLetter(ch) || ch === "_") {
      // identifier / dotted path (dsx.this, item.index…) — dots stay in the token
      let id = "";
      while (i < c.length && (isLetter(c[i]!) || isDigit(c[i]!) || c[i] === "_" || c[i] === ".")) { id += c[i]; i += 1; }
      toks.push({ kind: "ident", v: id });
      continue;
    }
    if (ch === "/") {
      // Regex literal vs division — the standard JS lexer heuristic: `/` in PREFIX
      // position starts a regex; after a value (or postfix `++`/`--`) it's division.
      // A keyword ident (`return` / `case` / `typeof` / …) is prefix position too.
      // `//` and `/*` never start a regex (they are comments, already stripped).
      const last = toks.length > 0 ? toks[toks.length - 1]! : null;
      const prevAllowsRegex = last === null ||
        (last.kind === "op" && last.v !== ")" && last.v !== "]" && last.v !== "++" && last.v !== "--") ||
        (last.kind === "ident" && regexKeywords.has(last.v));
      if (prevAllowsRegex && i + 1 < c.length && c[i + 1] !== "/" && c[i + 1] !== "*") {
        let j = i + 1;
        let pat = "";
        let inClass = false;
        let closed = false;
        while (j < c.length) {
          const rc = c[j]!;
          if (rc === "\\" && j + 1 < c.length) { pat += rc + c[j + 1]; j += 2; continue; }
          if (rc === "[") inClass = true;
          if (rc === "]") inClass = false;
          if (rc === "/" && !inClass) { closed = true; j += 1; break; }
          if (rc === "\n") break; // literals don't span lines
          pat += rc; j += 1;
        }
        if (closed && pat.length > 0) {
          let flags = "";
          while (j < c.length && isLetter(c[j]!)) { flags += c[j]; j += 1; }
          toks.push({ kind: "regex", pattern: pat, flags });
          i = j;
          continue;
        }
      }
    }
    const three = c.slice(i, i + 3).join("");
    if (three.length === 3 && threeCharOps.includes(three)) { toks.push({ kind: "op", v: three }); i += 3; continue; }
    const two = c.slice(i, i + 2).join("");
    if (two.length === 2 && twoCharOps.includes(two)) {
      // `?.` followed by a digit is a ternary + number (`x ?.5 : y`), the JS lookahead rule
      if (two === "?." && i + 2 < c.length && isDigit(c[i + 2]!)) {
        toks.push({ kind: "op", v: "?" });
        i += 1;
        continue;
      }
      toks.push({ kind: "op", v: two });
      i += 2;
      continue;
    }
    toks.push({ kind: "op", v: ch }); // single-char op / paren
    i += 1;
  }
  return toks;
}

// ── the token pre-parse cache (same key, same bound, same eviction as the twins) ──
const tokenCache = new Map<string, Token[]>();

export function cachedTokens(s: string): Token[] {
  const hit = tokenCache.get(s);
  if (hit) return hit;
  const toks = tokenize(s);
  if (tokenCache.size > 512) tokenCache.clear();
  tokenCache.set(s, toks);
  return toks;
}
