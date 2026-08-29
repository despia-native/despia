//
//  expr.ts - ONE JSE EXPRESSION, as a tree with byte spans.
//
//  The statement projection (cfg.ts / nodeflow.ts) answers "what runs next". This answers the
//  other question an author has: "where does this value come from". They are orthogonal, and
//  the second one needs something the first never did - the SHAPE of an expression, not just
//  its text - so this is a real parser rather than a scanner.
//
//  WHY A THIRD READER OF JSE. The evaluator (jse.ts) is a direct-execution recursive descent:
//  it produces values and throws the positions away, so it cannot say which bytes an operand
//  occupies. The highlighter (highlight.ts) produces spans but flattens structure. Neither can
//  answer "replace the left operand of this comparison". This parser mirrors the evaluator's
//  grammar exactly - the same precedence ladder, the same dotted-ident rule, the same
//  higher-order arms - and keeps every span, so a visual edit is a splice like every other
//  edit in this editor. The ONE rule that must never drift between the three, whether a `/`
//  opens a regex or divides, is imported rather than re-implemented.
//
//  TOTAL, LIKE THE REST. Any input yields a tree. A form the parser does not recognise becomes
//  an `unknown` node holding its own bytes - the same discipline as Custom Code in the
//  statement projection - so a drawing is always possible and `exact` records whether it is
//  also authoritative enough to write through.
//
//  THE WRITE CONTRACT is the tree analogue of the statement projection's tiling: every node's
//  span is CONTAINED in its parent's, siblings are DISJOINT and in source order, and the root
//  covers the whole expression. A splice inside one node therefore cannot disturb another, and
//  `exprInvariants` checks all three on any tree.
//

import { endOfRegex, endOfJseNumber, higherOrderFns, methodFns } from "@despia-native/kernel";

export type Span = { start: number; end: number };

// ── the lexer: the evaluator's tokens, with the positions it discards ────────────────

export type TokKind = "num" | "str" | "tpl" | "regex" | "ident" | "op";
export type Tok = {
  kind: TokKind;
  /** The token's source text, exactly. */
  v: string;
  start: number;
  end: number;
  /** Template only: the `${ }` hole ranges, in order, for recursive parsing. */
  holes?: Span[];
};

const THREE = ["===", "!==", ">>>", "**=", "..."];
const TWO = [
  "==", "!=", "<=", ">=", "&&", "||", "=>",
  "**", "??", "?.", "<<", ">>", "++", "--", "+=", "-=", "*=", "/=", "%=",
];

function isDigit(c: string): boolean { return c >= "0" && c <= "9"; }
/** The evaluator's identifier alphabet, exactly: letters, digits, `_` and the DOT. `$` is not
 *  one - it lexes as an operator there, so it must lex as one here. */
function isLetter(c: string): boolean { return /\p{L}/u.test(c); }
function isIdentStart(c: string): boolean { return isLetter(c) || c === "_"; }
function isIdentPart(c: string): boolean { return isLetter(c) || isDigit(c) || c === "_" || c === "."; }

/** Tokens for `src[from, to)`. Comments are skipped, not stripped: an expression has no
 *  statement boundaries, so there is no ASI pass and nothing is rewritten. */
export function lexExpression(src: string, from: number, to: number): Tok[] {
  const out: Tok[] = [];
  let i = from;
  while (i < to) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    // The evaluator's `expression()` steps over a leading separator rather than refusing
    // the statement; a reader that bailed here drew Custom Code for `; a + b`.
    if (c === ";" && out.length === 0) { i++; continue; }
    // A COMMENT IS NEVER A REGEX. Guarding these two branches with `opensRegex` refused
    // exactly the comments that follow an operator or an open bracket - the prefix position
    // - and then minted a regex out of the rest of the line, so `a + /* why */ b` drew as a
    // division by a pattern. The evaluator strips comments unconditionally and requires the
    // next character not to be `/` or `*` before it will open a regex; so does this now.
    if (c === "/" && src[i + 1] === "/") { while (i < to && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 || close + 2 > to ? to : close + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const s = i;
      i++;
      // A RAW NEWLINE DOES NOT CLOSE A STRING HERE, because it does not close one in the
      // runner (`copyQuoted` runs to the matching quote or the end). An attribute body
      // carrying `&#10;` decodes to exactly that, so a reader that stopped at the newline
      // would split one string into two and draw a formula nobody wrote.
      while (i < to) {
        if (src[i] === "\\") { i = Math.min(i + 2, to); continue; }
        if (src[i] === c) { i++; break; }
        i++;
      }
      out.push({ kind: "str", v: src.slice(s, i), start: s, end: i });
      continue;
    }
    if (c === "`") {
      const s = i;
      const holes: Span[] = [];
      i++;
      while (i < to) {
        if (src[i] === "\\") { i = Math.min(i + 2, to); continue; }
        if (src[i] === "`") { i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") {
          const open = i + 2;
          let depth = 1;
          i += 2;
          while (i < to && depth > 0) {
            const h = src[i]!;
            if (h === "'" || h === '"' || h === "`") { i = skipQuoted(src, i, to); continue; }
            if (h === "{") depth++;
            else if (h === "}") depth--;
            i++;
          }
          // `i` sits past the `}` when there was one and at `to` when the template ran off
          // the end; an unterminated hole must not lose its last character to the fallback.
          holes.push({ start: open, end: Math.max(open, depth === 0 ? i - 1 : i) });
          continue;
        }
        i++;
      }
      out.push({ kind: "tpl", v: src.slice(s, i), start: s, end: i, holes });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const s = i;
      // The RUNNER's rule, not the highlighter's: the two differ on a trailing `.`, a bare
      // `0x` and a trailing `_`, and on `1.map(f)` that difference is the whole meaning.
      i = Math.min(endOfJseNumber(src, i), to);
      if (i <= s) i = s + 1;
      out.push({ kind: "num", v: src.slice(s, i), start: s, end: i });
      continue;
    }
    if (isIdentStart(c)) {
      const s = i;
      while (i < to && isIdentPart(src[i]!)) i++;
      out.push({ kind: "ident", v: src.slice(s, i), start: s, end: i });
      continue;
    }
    if (c === "/" && regexHere(src, out, i, to)) {
      const s = i;
      i = Math.min(endOfRegex(src, i), to);
      out.push({ kind: "regex", v: src.slice(s, i), start: s, end: i });
      continue;
    }
    const three = src.slice(i, i + 3);
    if (i + 3 <= to && THREE.includes(three)) { out.push({ kind: "op", v: three, start: i, end: i + 3 }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (i + 2 <= to && TWO.includes(two)) {
      // `?.` before a digit is a ternary and a number (`x ?.5 : y`), the JS lookahead rule
      if (two === "?." && isDigit(src[i + 2] ?? "")) { out.push({ kind: "op", v: "?", start: i, end: i + 1 }); i += 1; continue; }
      out.push({ kind: "op", v: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    out.push({ kind: "op", v: c, start: i, end: i + 1 });
    i++;
  }
  return out;
}

function skipQuoted(src: string, at: number, to: number): number {
  const quote = src[at]!;
  let i = at + 1;
  while (i < to) {
    if (src[i] === "\\") { i = Math.min(i + 2, to); continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** Regex-or-division at TOKEN level, the evaluator's rule: a `/` after a value divides. The
 *  char-level companion is imported, so the two readings of a slash cannot drift apart. */
const REGEX_KEYWORDS = new Set(["return", "case", "typeof", "in", "of", "do", "else", "throw"]);
/** A regex literal is a VALUE, so the `/` after one divides. The character-level test
 *  cannot see that: the byte before is the regex's own closing slash, which is not a word
 *  character, so it reads as prefix position and mints a second pattern out of the rest of
 *  the line. A flagged regex escapes by accident (the flag letters read as a word); a bare
 *  one did not. The token stream knows, so the token stream decides. */
function regexHere(src: string, out: Tok[], at: number, to: number): boolean {
  if (at + 1 >= to || src[at + 1] === "/" || src[at + 1] === "*") return false;
  const last = out[out.length - 1];
  if (last === undefined) return closedRegex(src, at, to);
  if (last.kind === "op") {
    return last.v !== ")" && last.v !== "]" && last.v !== "++" && last.v !== "--"
      && closedRegex(src, at, to);
  }
  if (last.kind === "ident") return REGEX_KEYWORDS.has(last.v) && closedRegex(src, at, to);
  // num, str, tpl and REGEX are all values: the `/` after one divides.
  return false;
}

/** The runner will not open a pattern it cannot close: `a / b` on one line is a division,
 *  not an unterminated regex swallowing the rest of the statement. */
function closedRegex(src: string, at: number, to: number): boolean {
  const end = Math.min(endOfRegex(src, at), to);
  return end > at + 1 && src.lastIndexOf("/", end - 1) > at;
}

// ── the tree ─────────────────────────────────────────────────────────────────────────

/** A named parameter of a lambda, with the span of its own name so it can be renamed. */
export type Param = { name: string; span: Span; rest: boolean; def: Span | null };

/** One element of an array, one argument of a call: the value, and whether it spreads. */
export type Arg = { value: Expr; spread: boolean; span: Span };

/** One `key: value` of an object literal. `computed` is `{ [expr]: v }`; `shorthand` is
 *  `{ id }`, where the key and the value are the same bytes. */
export type ObjEntry = {
  key: string;
  keySpan: Span;
  value: Expr;
  span: Span;
  computed: boolean;
  shorthand: boolean;
  spread: boolean;
};

export type Expr =
  | { kind: "number" | "string" | "boolean" | "null" | "regex"; span: Span; text: string }
  | { kind: "template"; span: Span; text: string; holes: Expr[] }
  | { kind: "ref"; span: Span; path: string }
  | { kind: "unary"; span: Span; op: string; opSpan: Span; arg: Expr }
  | { kind: "binary"; span: Span; op: string; opSpan: Span; left: Expr; right: Expr }
  | { kind: "ternary"; span: Span; test: Expr; then: Expr; other: Expr }
  /** A bare call: `upper(s)`, `map(rows, fn)`, `dsx.module.a.b(x)` - the callee is a name,
   *  not an expression, because that is the only callee shape the evaluator accepts. */
  | { kind: "call"; span: Span; callee: string; calleeSpan: Span; args: Arg[]; higher: boolean }
  /** `receiver.name(args)` - the postfix call arm. */
  | { kind: "method"; span: Span; name: string; nameSpan: Span; receiver: Expr; args: Arg[]; higher: boolean; optional?: boolean }
  | { kind: "member"; span: Span; receiver: Expr; name: string; nameSpan: Span; optional: boolean }
  | { kind: "index"; span: Span; receiver: Expr; index: Expr; optional: boolean }
  | { kind: "array"; span: Span; items: Arg[] }
  | { kind: "object"; span: Span; entries: ObjEntry[] }
  /** A lambda. An expression body is a tree; a BLOCK body is a statement list, which the
   *  statement projection already knows how to draw, so it is carried as a span. */
  | { kind: "lambda"; span: Span; params: Param[]; body: Expr | null; block: Span | null }
  | { kind: "group"; span: Span; inner: Expr }
  | { kind: "unknown"; span: Span; text: string };

/** The higher-order set, byte-identical to the evaluator's: these take a FUNCTION, so a
 *  drawing must show the lambda rather than a text blob. */
/** The nineteen the runner dispatches a lambda into - ITS set, not a copy of it. */
export const HIGHER_ORDER: ReadonlySet<string> = higherOrderFns;
/** Every name a dotted call dispatches as a method on the path in front of it. */
export const METHOD_NAMES: ReadonlySet<string> = methodFns;

/** Names `JSECore` answers itself: `Math.round(n)` is a function call, not `round` dispatched
 *  on `Math`. The runner checks `JSECore.handles`; this is that list as the parser needs it. */
const CORE_STATIC = new Set([
  "Math.round", "Math.floor", "Math.ceil", "Math.abs", "Math.min", "Math.max", "Math.pow",
  "Math.sqrt", "Math.random", "Math.sign", "Math.trunc", "Math.log", "Math.exp", "Math.hypot",
  "Math.cbrt", "Math.atan2", "Math.sin", "Math.cos", "Math.tan", "Math.asin", "Math.acos",
  "Math.atan", "Math.log2", "Math.log10",
  "Object.keys", "Object.values", "Object.entries", "Object.assign", "Object.freeze",
  "Object.fromEntries", "Object.groupBy",
  "Array.from", "Array.isArray", "Array.of",
  "JSON.parse", "JSON.stringify",
  "Number.parseInt", "Number.parseFloat", "Number.isFinite", "Number.isInteger",
  "Number.isNaN", "Number.toFixed",
  "String.fromCharCode", "String.raw",
  "Date.now", "Date.parse", "Date.UTC",
  "Promise.all", "Promise.race", "Promise.resolve", "Promise.reject",
]);

/** Words the evaluator treats as transparent in expression position. */
const TRANSPARENT = new Set(["new", "await"]);
/** PROTOTYPE-FREE, and every lookup table in this reader is. A bare object literal answers
 *  `toString`, `constructor` and `valueOf` with inherited functions, so `constructor` lexed
 *  as an identifier came back with a FUNCTION as its node kind - a tree that then passed
 *  every invariant and drew as Custom Code. The same hazard crashed the projection outright
 *  on `x.toString()`, which is a method JSE genuinely dispatches. */
const WORD_LITERAL: Record<string, Expr["kind"]> = Object.assign(Object.create(null) as Record<string, Expr["kind"]>, {
  true: "boolean" as const, false: "boolean" as const, null: "null" as const,
  nil: "null" as const, undefined: "null" as const,
});

/** WHERE AN EXPRESSION LIVES DECIDES WHAT ITS ENTITIES MEAN, and the two answers are not
 *  the same one. A reader that picks either rule alone draws a formula the runtime does not
 *  run.
 *
 *  · A CODE TAG body (`<action>`, `<formula>`, a computed `<variable>`) is lifted out of the
 *    document 1:1, so the bytes reach the evaluator untouched and IT decodes them - which it
 *    does for exactly three entities (`&amp;`, `&lt;`, `&gt;`) and only OUTSIDE quoted,
 *    template and regex spans. `'a &amp; b'` is therefore a nine-character string at
 *    runtime, and a drawing that shows `a & b` is lying about what the program computes.
 *  · An ATTRIBUTE body (`on:tap="…"`) is decoded by the XML reader before the evaluator ever
 *    sees it, all five entities plus the numeric forms, everywhere - inside literals too.
 *
 *  `logicBodies` already knows which a body is, so the caller passes it through. */
export type BodyContext = "text" | "attr" | "none";

const OPERATOR_ENTITY: [string, string][] = [["&amp;", "&"], ["&lt;", "<"], ["&gt;", ">"]];
const ATTR_ENTITY: [string, string][] = [
  ["&lt;", "<"], ["&gt;", ">"], ["&quot;", '"'], ["&apos;", "'"], ["&amp;", "&"],
];

/** `src[span]` with entities resolved under the rule its CONTEXT actually uses, plus the RAW
 *  offset every decoded character came from. `map` has one more entry than `plain` has
 *  characters, so an exclusive end index translates without a special case. */
export function decodeRange(
  src: string, span: Span, context: BodyContext = "text",
): { plain: string; map: number[] } {
  let plain = "";
  const map: number[] = [];
  let i = span.start;
  const take = (n: number, ch: string): void => { map.push(i); plain += ch; i += n; };

  if (context === "none") {
    // Already-decoded text re-entering the parser (a template hole): identity, with a map.
    while (i < span.end) take(1, src[i]!);
    map.push(span.end);
    return { plain, map };
  }

  if (context === "attr") {
    outer: while (i < span.end) {
      for (const [entity, ch] of ATTR_ENTITY) {
        if (src.startsWith(entity, i) && i + entity.length <= span.end) { take(entity.length, ch); continue outer; }
      }
      // `&#10;` and `&#x2014;`: the XML reader resolves these too, so a body that reached
      // the evaluator through an attribute has them as characters already.
      const numeric = /^&#(x[0-9a-fA-F]+|[0-9]+);/.exec(src.slice(i, Math.min(span.end, i + 12)));
      if (numeric !== null) {
        const digits = numeric[1]!;
        const code = digits[0] === "x" ? parseInt(digits.slice(1), 16) : parseInt(digits, 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          const text = String.fromCodePoint(code);
          // A code point outside the BMP is two UTF-16 units; the map needs one entry each.
          for (const unit of text) take(unit === text ? numeric[0]!.length : 0, unit);
          continue;
        }
      }
      take(1, src[i]!);
    }
    map.push(span.end);
    return { plain, map };
  }

  // The code-tag rule, mirroring the evaluator's `decodeOperatorEntities`: three entities,
  // and never inside a literal, because decoding `&quot;` there would move the literal's own
  // boundary and turn one string into two.
  let prev: string | null = null;
  outer: while (i < span.end) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = skipQuoted(src, i, span.end);
      while (i < close) take(1, src[i]!);
      prev = ch;
      continue;
    }
    if (ch === "/" && charOpensRegex(prev)) {
      const end = endOfRegex(src, i);
      if (end > i + 1 && end <= span.end && src[end - 1] !== "\n") {
        while (i < end) take(1, src[i]!);
        prev = src[end - 1]!;
        continue;
      }
    }
    if (ch === "&") {
      for (const [entity, out] of OPERATOR_ENTITY) {
        if (src.startsWith(entity, i) && i + entity.length <= span.end) {
          take(entity.length, out);
          prev = out;
          continue outer;
        }
      }
    }
    take(1, ch);
    if (!/\s/.test(ch)) prev = ch;
  }
  map.push(span.end);
  return { plain, map };
}

/** The prefix-position test on the character before a `/`, matching the evaluator's own. */
function charOpensRegex(prev: string | null): boolean {
  if (prev === null) return true;
  return "([{,;:!&|?+-*%~^<>=".includes(prev);
}

export type ParseResult = {
  root: Expr;
  /** `src[span]` with entities resolved - the text the tree was actually parsed over, and
   *  the text a person is shown. Spans stay in the DECODED coordinate until `rawSpans`. */
  plain: string;
  /** Decoded index -> raw index, one entry longer than `plain`. */
  map: number[];
  /** Every token was consumed and the root covers the whole range: the drawing is the
   *  expression, not a prefix of it. A write is refused when this is false. */
  exact: boolean;
  tokens: number;
};

/** Parse `src[span]` as one expression. Never throws; an unrecognised form becomes `unknown`. */
export function parseExpression(src: string, span: Span, context: BodyContext = "text"): ParseResult {
  const { plain, map } = decodeRange(src, span, context);
  const toks = lexExpression(plain, 0, plain.length);
  if (toks.length === 0) {
    return {
      root: { kind: "unknown", span: { start: span.start, end: span.start }, text: "" },
      exact: true, tokens: 0, plain, map,
    };
  }
  const p = new ExprParser(plain, toks);
  const root = p.expression();
  const consumed = p.pos >= toks.length;
  const covers = root.span.start === toks[0]!.start && root.span.end === toks[toks.length - 1]!.end;
  // The tree is handed back in the CALLER's coordinate, always: a template hole re-enters
  // here with a span of its own, and a tree that answered in decoded-local offsets would
  // land every nested node at the top of the file.
  rawSpans(root, map);
  return { root, exact: consumed && covers && !hasUnknown(root), tokens: toks.length, plain, map };
}

/** The inverse of a decode map: a raw offset back to its index in `plain`. An offset that
 *  falls INSIDE an entity answers that entity's single character, so a span can never split
 *  `&amp;` down the middle. */
export function plainIndex(map: number[], raw: number): number {
  let lo = 0, hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid]! < raw) lo = mid + 1; else hi = mid;
  }
  return map[lo]! > raw && lo > 0 ? lo - 1 : lo;
}

/** Translate a tree parsed over the DECODED text back onto the file's own bytes. Called once,
 *  at the end, by whoever is going to hand spans out - a splice addresses the file. */
export function rawSpans(root: Expr, map: number[]): void {
  const at = (i: number): number => map[Math.max(0, Math.min(map.length - 1, i))]!;
  walkExpr(root, (n) => {
    n.span = { start: at(n.span.start), end: at(n.span.end) };
    if (n.kind === "unary" || n.kind === "binary") n.opSpan = { start: at(n.opSpan.start), end: at(n.opSpan.end) };
    if (n.kind === "call") n.calleeSpan = { start: at(n.calleeSpan.start), end: at(n.calleeSpan.end) };
    if (n.kind === "method" || n.kind === "member") n.nameSpan = { start: at(n.nameSpan.start), end: at(n.nameSpan.end) };
    if (n.kind === "array") for (const a of n.items) a.span = { start: at(a.span.start), end: at(a.span.end) };
    if (n.kind === "call" || n.kind === "method") for (const a of n.args) a.span = { start: at(a.span.start), end: at(a.span.end) };
    if (n.kind === "object") {
      for (const e of n.entries) {
        e.keySpan = { start: at(e.keySpan.start), end: at(e.keySpan.end) };
        e.span = { start: at(e.span.start), end: at(e.span.end) };
      }
    }
    if (n.kind === "lambda") {
      for (const q of n.params) {
        q.span = { start: at(q.span.start), end: at(q.span.end) };
        if (q.def) q.def = { start: at(q.def.start), end: at(q.def.end) };
      }
      if (n.block) n.block = { start: at(n.block.start), end: at(n.block.end) };
    }
  });
}

function hasUnknown(e: Expr): boolean {
  let found = false;
  walkExpr(e, (n) => { if (n.kind === "unknown") found = true; });
  return found;
}

/** Every node of a tree, parents before children. */
export function walkExpr(e: Expr, visit: (n: Expr) => void): void {
  visit(e);
  for (const child of childrenOf(e)) walkExpr(child, visit);
}

/** A node's sub-expressions, in source order. The one place the shape is enumerated. */
export function childrenOf(e: Expr): Expr[] {
  switch (e.kind) {
    case "template": return e.holes;
    case "unary": return [e.arg];
    case "binary": return [e.left, e.right];
    case "ternary": return [e.test, e.then, e.other];
    case "call": return e.args.map((a) => a.value);
    case "method": return [e.receiver, ...e.args.map((a) => a.value)];
    case "member": return [e.receiver];
    case "index": return [e.receiver, e.index];
    case "array": return e.items.map((a) => a.value);
    case "object": return e.entries.map((x) => x.value);
    case "lambda": return e.body === null ? [] : [e.body];
    case "group": return [e.inner];
    default: return [];
  }
}

/** Postfix bases a `(` may call. A literal is not one: `1(2)` is a typo, not a call, and
 *  drawing it as one would invent a shape the author did not write. */
const CALLABLE = new Set<Expr["kind"]>(["lambda", "group", "index", "method", "call", "member"]);

// ── the parser: the evaluator's ladder, span by span ─────────────────────────────────

class ExprParser {
  pos = 0;
  private depth = 0;
  private readonly src: string;
  private readonly t: Tok[];
  constructor(src: string, tokens: Tok[]) {
    this.src = src;
    this.t = tokens;
  }

  private peek(): Tok | null { return this.pos < this.t.length ? this.t[this.pos]! : null; }
  private op(s: string): boolean { const k = this.peek(); return k !== null && k.kind === "op" && k.v === s; }
  private anyOp(list: string[]): Tok | null {
    const k = this.peek();
    return k !== null && k.kind === "op" && list.includes(k.v) ? k : null;
  }
  private word(s: string): boolean { const k = this.peek(); return k !== null && k.kind === "ident" && k.v === s; }
  private advance(): void { this.pos += 1; }
  private at(index: number): Tok | null { return index < this.t.length ? this.t[index]! : null; }
  private from(a: Expr, b: Expr | Tok): Span { return { start: a.span.start, end: "span" in b ? b.span.end : b.end }; }

  expression(): Expr {
    if (this.depth >= 200) return this.bail();
    this.depth += 1;
    const v = this.ternary();
    this.depth -= 1;
    return v;
  }

  private bail(): Expr {
    const k = this.peek();
    const start = k === null ? (this.t[this.t.length - 1]?.end ?? 0) : k.start;
    const end = this.t[this.t.length - 1]?.end ?? start;
    this.pos = this.t.length;
    return { kind: "unknown", span: { start, end }, text: this.src.slice(start, end) };
  }

  private ternary(): Expr {
    const cond = this.nullish();
    if (!this.op("?")) return cond;
    this.advance();
    const then = this.expression();
    if (this.op(":")) this.advance();
    const other = this.expression();
    return { kind: "ternary", span: this.from(cond, other), test: cond, then, other };
  }

  /** One left-associative binary level. The ladder below is the evaluator's, in its order. */
  private level(ops: string[], next: () => Expr): Expr {
    let left = next();
    for (;;) {
      const tok = this.anyOp(ops);
      if (tok === null) break;
      this.advance();
      const right = next();
      left = {
        kind: "binary", span: this.from(left, right), op: tok.v,
        opSpan: { start: tok.start, end: tok.end }, left, right,
      };
    }
    return left;
  }

  private nullish(): Expr { return this.level(["??"], () => this.logicalOr()); }
  private logicalOr(): Expr { return this.level(["||"], () => this.logicalAnd()); }
  private logicalAnd(): Expr { return this.level(["&&"], () => this.bitOr()); }
  private bitOr(): Expr { return this.level(["|"], () => this.bitXor()); }
  private bitXor(): Expr { return this.level(["^"], () => this.bitAnd()); }
  private bitAnd(): Expr { return this.level(["&"], () => this.equality()); }
  private equality(): Expr { return this.level(["===", "!==", "==", "!="], () => this.comparison()); }

  private comparison(): Expr {
    let left = this.shift();
    for (;;) {
      const tok = this.anyOp(["<", "<=", ">", ">="]);
      if (tok !== null) {
        this.advance();
        const right = this.shift();
        left = { kind: "binary", span: this.from(left, right), op: tok.v, opSpan: { start: tok.start, end: tok.end }, left, right };
        continue;
      }
      // `in` sits at the relational level and is spelled as an identifier
      const k = this.peek();
      if (k !== null && k.kind === "ident" && k.v === "in") {
        this.advance();
        const right = this.shift();
        left = { kind: "binary", span: this.from(left, right), op: "in", opSpan: { start: k.start, end: k.end }, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private shift(): Expr { return this.level(["<<", ">>", ">>>"], () => this.additive()); }
  private additive(): Expr { return this.level(["+", "-"], () => this.multiplicative()); }
  private multiplicative(): Expr { return this.level(["*", "/", "%"], () => this.power()); }

  private power(): Expr {
    const left = this.unary();
    if (!this.op("**")) return left;
    const tok = this.peek()!;
    this.advance();
    const right = this.power(); // right-associative: 2 ** 3 ** 2
    return { kind: "binary", span: this.from(left, right), op: "**", opSpan: { start: tok.start, end: tok.end }, left, right };
  }

  private unary(): Expr {
    const tok = this.anyOp(["!", "-", "+", "~"]);
    if (tok !== null) {
      this.advance();
      const arg = this.unary();
      return { kind: "unary", span: { start: tok.start, end: arg.span.end }, op: tok.v, opSpan: { start: tok.start, end: tok.end }, arg };
    }
    const k = this.peek();
    if (k !== null && k.kind === "ident" && k.v === "typeof") {
      this.advance();
      const arg = this.unary();
      return { kind: "unary", span: { start: k.start, end: arg.span.end }, op: "typeof", opSpan: { start: k.start, end: k.end }, arg };
    }
    return this.postfix();
  }

  /** The postfix chain: `[i]`, `.name`, `?.name`, `?.[i]`, `.name(args)`, and a call on a
   *  lambda value. Mirrors the evaluator's loop, including the dotted-run split before a
   *  method call - `arr[0].items.join(x)` lexes `items.join` as ONE identifier. */
  private postfix(): Expr {
    let base = this.primary();
    for (;;) {
      if (this.op("[")) {
        const open = this.peek()!;
        this.advance();
        const index = this.expression();
        const close = this.op("]") ? this.peek()! : null;
        if (close !== null) this.advance();
        base = {
          kind: "index", span: { start: base.span.start, end: close?.end ?? index.span.end },
          receiver: base, index, optional: false,
        };
        void open;
        continue;
      }
      if (this.op(".") || this.op("?.")) {
        const optional = this.op("?.");
        this.advance();
        if (optional && this.op("[")) {
          this.advance();
          const index = this.expression();
          const close = this.op("]") ? this.peek()! : null;
          if (close !== null) this.advance();
          base = {
            kind: "index", span: { start: base.span.start, end: close?.end ?? index.span.end },
            receiver: base, index, optional: true,
          };
          continue;
        }
        if (optional && this.op("(")) {
          // `f?.()` - the ONE genuine short-circuit left in the language: a nullish callee
          // skips its arguments unevaluated. It is drawn as a call that SAYS so, not as a
          // cold edge, because every other operand in JSE is eager.
          const args = this.argumentList();
          base = {
            kind: "method", span: { start: base.span.start, end: args.end }, name: "",
            nameSpan: { start: base.span.end, end: base.span.end },
            receiver: base, args: args.list, higher: false, optional: true,
          };
          continue;
        }
        const name = this.peek();
        if (name === null || name.kind !== "ident") break;
        this.advance();
        if (this.op("(")) {
          base = this.methodCall(base, name);
          continue;
        }
        base = this.memberRun(base, name, optional);
        continue;
      }
      // A call on a VALUE: `(x => x * 2)(4)`, `f(1)(2)`, `fs[1](5)`. The evaluator consumes
      // the `(` only when the base evaluates to a lambda; a parser has no values, so it
      // consumes on the syntax and lets the drawing say "call the thing on the left".
      if (this.op("(") && CALLABLE.has(base.kind)) {
        const args = this.argumentList();
        base = {
          kind: "method", span: { start: base.span.start, end: args.end }, name: "",
          nameSpan: { start: base.span.end, end: base.span.end }, receiver: base, args: args.list, higher: false,
        };
        continue;
      }
      break;
    }
    return base;
  }

  /** The receiver of a dispatched dotted call. It is ONE ref rather than a member chain: the
   *  lexer never split it, so no segment has a span the author can edit separately, and a
   *  chain of one-row cards for `a.b.c` is noise the drawing does not need. */
  private pathRun(path: string, span: Span): Expr {
    return { kind: "ref", span: { ...span }, path };
  }

  /** `.a.b.c` where the lexer handed back one dotted identifier: one member node per segment,
   *  each spanning up to the end of its own segment so a rename touches only that word. */
  private memberRun(base: Expr, name: Tok, optional: boolean): Expr {
    let out = base;
    let at = name.start;
    for (const seg of name.v.split(".")) {
      const segSpan = { start: at, end: at + seg.length };
      out = {
        kind: "member", span: { start: base.span.start, end: segSpan.end },
        receiver: out, name: seg, nameSpan: segSpan, optional: optional && at === name.start,
      };
      at = segSpan.end + 1;
    }
    return out;
  }

  /** `receiver.maybe.dotted.method(args)` - the leading segments are members, the last is the
   *  dispatched method, exactly as the evaluator splits it. */
  private methodCall(base: Expr, name: Tok): Expr {
    let receiver = base;
    let method = name.v;
    let methodSpan = { start: name.start, end: name.end };
    const dot = method.lastIndexOf(".");
    if (dot >= 0) {
      const lead = method.substring(0, dot);
      let at = name.start;
      for (const seg of lead.split(".")) {
        const segSpan = { start: at, end: at + seg.length };
        receiver = {
          kind: "member", span: { start: base.span.start, end: segSpan.end },
          receiver, name: seg, nameSpan: segSpan, optional: false,
        };
        at = segSpan.end + 1;
      }
      method = method.substring(dot + 1);
      methodSpan = { start: at, end: name.end };
    }
    const higher = HIGHER_ORDER.has(method);
    const args = this.argumentList();
    return {
      kind: "method", span: { start: base.span.start, end: args.end },
      name: method, nameSpan: methodSpan, receiver, args: args.list, higher,
    };
  }

  /** `( a, ...b )` - consumes the parentheses and returns the arguments with the closing
   *  position, so a caller can span to it. */
  private argumentList(): { list: Arg[]; end: number } {
    const open = this.peek();
    if (open === null || !this.op("(")) return { list: [], end: this.t[this.pos - 1]?.end ?? 0 };
    this.advance();
    const list: Arg[] = [];
    while (this.peek() !== null && !this.op(")")) {
      const before = this.pos;
      list.push(this.argument());
      if (this.op(",")) this.advance();
      if (this.pos === before) { this.advance(); break; }
    }
    const close = this.op(")") ? this.peek()! : null;
    if (close !== null) this.advance();
    return { list, end: close?.end ?? (list[list.length - 1]?.span.end ?? open.end) };
  }

  private argument(): Arg {
    if (this.op("...")) {
      const dots = this.peek()!;
      this.advance();
      const value = this.expression();
      return { value, spread: true, span: { start: dots.start, end: value.span.end } };
    }
    const value = this.expression();
    return { value, spread: false, span: value.span };
  }

  /** How far a bracketed form REACHES when its closer never arrived. Falling back to the
   *  open bracket's own end collapses the node onto one character while its children keep
   *  their real spans, which breaks containment - the one law a splice depends on. The
   *  honest answer is the last token the form actually consumed. */
  private reach(close: Tok | null, open: Tok, parts: { span: Span }[]): number {
    if (close !== null) return close.end;
    const consumed = this.t[this.pos - 1]?.end ?? open.end;
    const last = parts.length > 0 ? parts[parts.length - 1]!.span.end : open.end;
    return Math.max(open.end, consumed, last);
  }

  private primary(): Expr {
    const t = this.peek();
    if (t === null) return this.bail();

    if (t.kind === "num") { this.advance(); return { kind: "number", span: { start: t.start, end: t.end }, text: t.v }; }
    if (t.kind === "str") { this.advance(); return { kind: "string", span: { start: t.start, end: t.end }, text: t.v }; }
    if (t.kind === "regex") { this.advance(); return { kind: "regex", span: { start: t.start, end: t.end }, text: t.v }; }
    if (t.kind === "tpl") {
      this.advance();
      // The holes are re-parsed out of ALREADY-DECODED text, so no regime applies twice.
      const holes = (t.holes ?? []).map((h) => parseExpression(this.src, h, "none").root);
      return { kind: "template", span: { start: t.start, end: t.end }, text: t.v, holes };
    }

    if (t.kind === "ident") {
      // `new X(…)` and `await x` are transparent in expression position
      if (TRANSPARENT.has(t.v)) {
        this.advance();
        const inner = this.primary();
        return { kind: "group", span: { start: t.start, end: inner.span.end }, inner };
      }
      this.advance();
      // `x => …` - the one-parameter arrow with no parentheses
      if (this.op("=>")) {
        this.advance();
        return this.lambdaBody([{ name: t.v, span: { start: t.start, end: t.end }, rest: false, def: null }], t.start);
      }
      if (this.op("(")) {
        const dot = t.v.lastIndexOf(".");
        const tail = dot >= 0 ? t.v.substring(dot + 1) : t.v;
        const higher = HIGHER_ORDER.has(tail);
        // `rows.map(f)` and `user.name.trim()` lex as ONE dotted identifier, and the runner
        // splits the trailing segment off and dispatches it on the path in front. So does
        // this: leaving the receiver inside a callee STRING would hide the value the call
        // reads from, which is the one thing a dataflow drawing exists to show. A core
        // static (`Math.round`, `Object.keys`) is not a method on `Math`, and stays whole.
        if (dot >= 0 && (higher || METHOD_NAMES.has(tail)) && !CORE_STATIC.has(t.v)) {
          const headSpan = { start: t.start, end: t.start + dot };
          const head = this.pathRun(t.v.substring(0, dot), headSpan);
          const nameSpan = { start: t.start + dot + 1, end: t.end };
          const args = this.argumentList();
          return {
            kind: "method", span: { start: t.start, end: args.end }, name: tail,
            nameSpan, receiver: head, args: args.list, higher,
          };
        }
        const args = this.argumentList();
        return {
          kind: "call", span: { start: t.start, end: args.end }, callee: t.v,
          calleeSpan: { start: t.start, end: t.end }, args: args.list, higher,
        };
      }
      const lit = WORD_LITERAL[t.v];
      if (lit !== undefined) return { kind: lit, span: { start: t.start, end: t.end }, text: t.v } as Expr;
      return { kind: "ref", span: { start: t.start, end: t.end }, path: t.v };
    }

    if (t.v === "[") {
      this.advance();
      const items: Arg[] = [];
      while (this.peek() !== null && !this.op("]")) {
        const before = this.pos;
        items.push(this.argument());
        if (this.op(",")) this.advance();
        if (this.pos === before) { this.advance(); break; }
      }
      const close = this.op("]") ? this.peek()! : null;
      if (close !== null) this.advance();
      return { kind: "array", span: { start: t.start, end: this.reach(close, t, items) }, items };
    }

    if (t.v === "{") {
      this.advance();
      const entries: ObjEntry[] = [];
      while (this.peek() !== null && !this.op("}")) {
        const before = this.pos;
        const entry = this.objectEntry();
        if (entry !== null) entries.push(entry);
        if (this.op(",")) this.advance();
        if (this.pos === before) { this.advance(); break; }
      }
      const close = this.op("}") ? this.peek()! : null;
      if (close !== null) this.advance();
      return { kind: "object", span: { start: t.start, end: this.reach(close, t, entries) }, entries };
    }

    if (t.v === "(") {
      const lam = this.tryArrow();
      if (lam !== null) return lam;
      this.advance();
      const inner = this.expression();
      const close = this.op(")") ? this.peek()! : null;
      if (close !== null) this.advance();
      return { kind: "group", span: { start: t.start, end: close?.end ?? inner.span.end }, inner };
    }

    return this.bail();
  }

  private objectEntry(): ObjEntry | null {
    if (this.op("...")) {
      const dots = this.peek()!;
      this.advance();
      const value = this.expression();
      return {
        key: "", keySpan: { start: dots.start, end: dots.end }, value,
        span: { start: dots.start, end: value.span.end }, computed: false, shorthand: false, spread: true,
      };
    }
    const kt = this.peek();
    if (kt === null) return null;
    let key: string;
    let keySpan: Span;
    let computed = false;
    if (this.op("[")) {
      const open = kt;
      this.advance();
      const inner = this.expression();
      const close = this.op("]") ? this.peek()! : null;
      if (close !== null) this.advance();
      key = this.src.slice(inner.span.start, inner.span.end);
      keySpan = { start: open.start, end: close?.end ?? inner.span.end };
      computed = true;
    } else if (kt.kind === "ident" || kt.kind === "str" || kt.kind === "num") {
      key = kt.kind === "str" ? kt.v.slice(1, -1) : kt.v;
      keySpan = { start: kt.start, end: kt.end };
      this.advance();
    } else {
      return null;
    }
    if (this.op(":")) {
      this.advance();
      const value = this.expression();
      return { key, keySpan, value, span: { start: keySpan.start, end: value.span.end }, computed, shorthand: false, spread: false };
    }
    // `{ id }` - the key and the value are the same bytes, so the value reads that name
    const value: Expr = computed
      ? { kind: "null", span: keySpan, text: "null" }
      : { kind: "ref", span: keySpan, path: key };
    return { key, keySpan, value, span: keySpan, computed, shorthand: !computed, spread: false };
  }

  /** `(params) => body`, detected by an `=>` after the matching `)` - the evaluator's own
   *  lookahead, so a parenthesised expression and a lambda are told apart the same way. */
  private tryArrow(): Expr | null {
    let d = 0;
    let j = this.pos;
    while (j < this.t.length) {
      const k = this.t[j]!;
      if (k.kind === "op" && k.v === "(") d += 1;
      else if (k.kind === "op" && k.v === ")") { d -= 1; if (d === 0) break; }
      j += 1;
    }
    const after = this.at(j + 1);
    if (after === null || after.kind !== "op" || after.v !== "=>") return null;
    const open = this.peek()!;
    this.advance();
    const params: Param[] = [];
    while (this.pos < j) {
      const k = this.peek();
      if (k === null) break;
      if (k.kind === "op" && k.v === ",") { this.advance(); continue; }
      if (k.kind === "op" && k.v === "...") {
        this.advance();
        const name = this.peek();
        if (name !== null && name.kind === "ident") {
          params.push({ name: name.v, span: { start: name.start, end: name.end }, rest: true, def: null });
          this.advance();
        }
        continue;
      }
      if (k.kind === "ident") {
        this.advance();
        let def: Span | null = null;
        if (this.op("=")) {
          this.advance();
          const start = this.peek()?.start ?? k.end;
          let end = start;
          let depth = 0;
          while (this.pos < j) {
            const d2 = this.peek()!;
            if (d2.kind === "op" && (d2.v === "(" || d2.v === "[" || d2.v === "{")) depth++;
            else if (d2.kind === "op" && (d2.v === ")" || d2.v === "]" || d2.v === "}")) depth--;
            else if (d2.kind === "op" && d2.v === "," && depth === 0) break;
            end = d2.end;
            this.advance();
          }
          def = { start, end };
        }
        params.push({ name: k.v, span: { start: k.start, end: k.end }, rest: false, def });
        continue;
      }
      // a destructured parameter `{a, b}` - carried as one opaque name so it still renders
      if (k.kind === "op" && k.v === "{") {
        const start = k.start;
        let depth = 0;
        let end = k.end;
        while (this.pos < j) {
          const d2 = this.peek()!;
          if (d2.kind === "op" && d2.v === "{") depth++;
          else if (d2.kind === "op" && d2.v === "}") { depth--; end = d2.end; this.advance(); if (depth === 0) break; continue; }
          end = d2.end;
          this.advance();
        }
        params.push({ name: this.src.slice(start, end), span: { start, end }, rest: false, def: null });
        continue;
      }
      this.advance();
    }
    this.pos = j + 1;      // past the `)`
    if (this.op("=>")) this.advance();
    return this.lambdaBody(params, open.start);
  }

  /** A lambda's body. An expression body parses into a tree; a BLOCK body is a statement
   *  list, which the statement projection owns, so it is carried as a span and drawn by that
   *  editor rather than half-drawn by this one. */
  private lambdaBody(params: Param[], start: number): Expr {
    if (this.op("{")) {
      const open = this.peek()!;
      let depth = 0;
      let end = open.end;
      while (this.pos < this.t.length) {
        const k = this.peek()!;
        if (k.kind === "op" && k.v === "{") depth++;
        else if (k.kind === "op" && k.v === "}") {
          depth--;
          end = k.end;
          this.advance();
          if (depth === 0) break;
          continue;
        }
        end = k.end;
        this.advance();
      }
      return {
        kind: "lambda", span: { start, end }, params, body: null,
        block: { start: open.end, end: Math.max(open.end, end - 1) },
      };
    }
    const body = this.expression();
    return { kind: "lambda", span: { start, end: body.span.end }, params, body, block: null };
  }
}

// ── the write contract, checkable ────────────────────────────────────────────────────

export type Violation = { node: string; detail: string };

/**
 * The tree analogue of the statement projection's tiling. A splice on one node must not be
 * able to disturb another, which is exactly: every child inside its parent, siblings disjoint
 * and in source order, and no empty span on a node that has children.
 */
export function exprInvariants(root: Expr): Violation[] {
  const out: Violation[] = [];
  walkExpr(root, (node) => {
    const kids = childrenOf(node);
    let previous = -1;
    for (const kid of kids) {
      if (kid.span.start < node.span.start || kid.span.end > node.span.end) {
        out.push({ node: node.kind, detail: `${kid.kind} [${kid.span.start},${kid.span.end}) escapes [${node.span.start},${node.span.end})` });
      }
      if (kid.span.start < previous) {
        out.push({ node: node.kind, detail: `${kid.kind} starts at ${kid.span.start}, before the previous child ended at ${previous}` });
      }
      previous = kid.span.end;
      if (kid.span.end < kid.span.start) out.push({ node: kid.kind, detail: "inverted span" });
    }
  });
  return out;
}

/** Replace one node's bytes. The only write this editor makes, and the reason every node
 *  carries a span rather than a path. */
export function spliceExpr(source: string, span: Span, text: string): string {
  if (source.slice(span.start, span.end) === text) return source;
  return source.slice(0, span.start) + text + source.slice(span.end);
}
