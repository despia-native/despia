//
//  jse-audit.ts - the JSE coverage gate: an authoring-time audit of every JSE code site
//  in .dsx markup. JSE is JS-shaped but runs with NO JS engine, and an unsupported JS
//  construct fails OPEN at runtime (it silently evaluates to null). This tool turns that
//  into a fail-LOUD authoring-time error: it extracts every code site (`{{ }}` segments,
//  `on:*` handler bodies, head code blocks, `visible-if`, `<watch value>`), runs the
//  kernel's OWN tokenizer/parser over each (the public exports are the oracle — no
//  grammar is duplicated here), and reports every construct the engine does not run,
//  with the JSE spelling to use instead. Satellite surfaces (Apple Watch, keyboards)
//  have no JS fallback by hardware reality — this gate is the fallback. One rule flags
//  code that RUNS but lossily: `unsafe-number-literal` — a numeric literal above 2^53
//  silently loses integer precision in doubles (the 64-bit backend-ID hazard).
//
//  Usage: node packages/kernel/bin/jse-audit.ts [--strict] [--json] [roots or files…]
//    roots default to the repo root (every .dsx outside node_modules/.git)
//    --strict  exit 1 on any finding (CI mode); default prints and exits 0
//    --json    machine-readable findings array instead of the human report
//
//  Known blind spot (deliberate): the bare-URL argument of a legacy `fetch:` effect
//  verb line is verb grammar, not JSE tokens — it is masked before scanning so `@`/`#`
//  inside a URL never read as unsupported syntax.
//

import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseDsx, type XmlNode } from "@despia-native/compiler/xml";
import { tokenize, stripComments, type Token } from "../src/jse/tokens.ts";
import { Parser, StackStore } from "../src/jse/jse.ts";

// ── model ────────────────────────────────────────────────────────────────────────────

export type SiteKind = "expr" | "statements";

export type Site = {
  file: string;
  kind: SiteKind;
  /** the raw JSE source of the site (exactly what the kernel would evaluate) */
  code: string;
  /** where it came from: `on:tap`, `{{ }} in label=`, `<action as="save">`, … */
  context: string;
  /** 1-based best-effort line of the site's first code line */
  line: number;
  /** true when `code` was located verbatim in the source (line math is then exact) */
  exact: boolean;
};

export type Finding = {
  file: string;
  line: number;
  rule: string;
  severity: "error";
  message: string;
  /** one trimmed code line for display ("" when unavailable) */
  snippet: string;
  /** 0-based caret column into snippet, -1 = none */
  caret: number;
  context: string;
};

// ── the known-operator set (everything the kernel grammar handles) ──────────────────

export const KNOWN_OPS: ReadonlySet<string> = new Set([
  "(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "?.", "?", "!", "=",
  "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "~",
  "==", "!=", "===", "!==", "<=", ">=", "&&", "||", "=>", "??", "**",
  "<<", ">>", ">>>", "++", "--", "+=", "-=", "*=", "/=", "%=", "**=", "...", "\n",
]);

// ── site extraction ──────────────────────────────────────────────────────────────────

/** head/code elements whose TEXT is a JSE statement/expression block */
const CODE_TEXT_TAGS = new Set([
  "action", "variable", "var", "let", "script", "functions", "function", "formula", "watch",
]);
/** attributes whose whole value is a bare JSE expression (mount.ts: store.eval) */
const EXPR_ATTRS = new Set(["visible-if"]);
/** `on:<event>.<modifier>` attributes carry gate PARAMETERS (numbers), not code */
const ON_MODIFIERS = new Set(["throttle", "debounce"]);

/** Split a value into its `{{ … }}` segments EXACTLY like JSE.interpolate: first `}}`
 *  after each `{{` closes it (no nesting); an unterminated `{{` passes through raw. */
export function moustacheSegments(value: string): string[] {
  if (!value.includes("{{")) return [];
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const open = value.indexOf("{{", idx);
    if (open < 0) break;
    const close = value.indexOf("}}", open + 2);
    if (close < 0) break; // kernel emits the tail raw — not a code site
    out.push(value.substring(open + 2, close));
    idx = close + 2;
  }
  return out;
}

function lineAt(source: string, offset: number): number {
  let n = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) if (source[i] === "\n") n += 1;
  return n;
}

/** nth-occurrence source search — repeated identical snippets locate in document
 *  order because each needle advances its own occurrence counter. */
class SourceLocator {
  readonly source: string;
  private readonly counts = new Map<string, number>();
  constructor(source: string) {
    this.source = source;
  }
  locate(needle: string): number | null {
    if (needle.length === 0) return null;
    const n = this.counts.get(needle) ?? 0;
    this.counts.set(needle, n + 1);
    let idx = -1;
    for (let k = 0; k <= n; k++) {
      idx = this.source.indexOf(needle, idx + 1);
      if (idx < 0) return null;
    }
    return idx;
  }
}

function firstNonBlankLine(code: string): string {
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "";
}

type Needle = { needle: string; delta: number; exact: boolean };

function makeSite(
  file: string, locator: SourceLocator, kind: SiteKind, code: string, context: string,
  needles: Needle[],
): Site {
  let line = 1;
  let exact = false;
  for (const cand of needles) {
    if (cand.needle.length === 0) continue;
    const found = locator.locate(cand.needle);
    if (found !== null) {
      line = lineAt(locator.source, found + cand.delta);
      exact = cand.exact;
      break;
    }
  }
  return { file, kind, code, context, line, exact };
}

/** fallback needles when the exact code text is not in the source verbatim (entity
 *  decoding) — first non-blank line, then a short prefix; best effort by design. */
function fallbackNeedles(code: string): Needle[] {
  const out: Needle[] = [];
  const first = firstNonBlankLine(code);
  if (first.length > 0) out.push({ needle: first, delta: 0, exact: false });
  const prefix = code.trim().slice(0, 16);
  if (prefix.length > 0 && prefix !== first) out.push({ needle: prefix, delta: 0, exact: false });
  return out;
}

export function collectSites(file: string, source: string): {
  sites: Site[];
  parseError: { message: string; line: number } | null;
} {
  let root: XmlNode;
  try {
    root = parseDsx(source);
  } catch (e) {
    const line = (e as { line?: number }).line ?? 1;
    return { sites: [], parseError: { message: (e as Error).message, line } };
  }
  const locator = new SourceLocator(source);
  const sites: Site[] = [];

  const addExpr = (code: string, context: string, wrapped: boolean): void => {
    if (code.trim().length === 0) return;
    const needles: Needle[] = wrapped
      ? [{ needle: `{{${code}}}`, delta: 2, exact: true }, { needle: code, delta: 0, exact: true }]
      : [{ needle: code, delta: 0, exact: true }];
    needles.push(...fallbackNeedles(code));
    sites.push(makeSite(file, locator, "expr", code, context, needles));
  };
  const addStatements = (code: string, context: string): void => {
    if (code.trim().length === 0) return;
    const needles: Needle[] = [{ needle: code, delta: 0, exact: true }, ...fallbackNeedles(code)];
    sites.push(makeSite(file, locator, "statements", code, context, needles));
  };

  const walk = (node: XmlNode): void => {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (name.startsWith("on:")) {
        const modDot = name.indexOf(".", 3);
        if (modDot >= 0 && ON_MODIFIERS.has(name.substring(modDot + 1))) continue; // gate param
        addStatements(value, `${name} on <${node.tag}>`);
        continue;
      }
      if (node.tag === "watch" && name === "value") {
        addExpr(value, `<watch value>`, false);
        continue;
      }
      if (EXPR_ATTRS.has(name)) {
        // `visible-if="has:scheme"` is the documented capability-check special form —
        // the condition evaluator strips it BEFORE JSE (Stack.swift `cond.hasPrefix("has:")`;
        // callable twin `has('scheme')` in JSE.swift). Not a JSE site.
        if (name === "visible-if" && value.startsWith("has:")) continue;
        addExpr(value, `${name} on <${node.tag}>`, false);
        continue;
      }
      for (const seg of moustacheSegments(value)) addExpr(seg, `{{ }} in ${name}= on <${node.tag}>`, true);
    }
    if (CODE_TEXT_TAGS.has(node.tag)) {
      const as = node.attrs["as"];
      addStatements(node.text, as !== undefined ? `<${node.tag} as="${as}">` : `<${node.tag}>`);
    } else {
      for (const seg of moustacheSegments(node.text)) addExpr(seg, `{{ }} in <${node.tag}> text`, true);
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return { sites, parseError: null };
}

// ── detection ────────────────────────────────────────────────────────────────────────

/** `fetch: dest = METHOD url …` — the bare URL is effect-verb grammar, not JSE tokens;
 *  mask it so URL characters (`@`, `#`) never read as unsupported syntax. */
export function maskFetchEffectUrls(code: string): string {
  if (!code.includes("fetch")) return code;
  return code.replace(
    /^([ \t]*fetch[ \t]*:[ \t]*[A-Za-z_][\w.]*[ \t]*=[ \t]*[A-Z]+[ \t]+)([^\s{]+)/gm,
    "$1_url_",
  );
}

/** every token stream in a site: the top-level one plus each template-literal hole */
function* tokenStreams(toks: Token[]): Generator<Token[]> {
  yield toks;
  for (const t of toks) {
    if (t.kind === "template") {
      for (const part of t.parts) if ("toks" in part) yield* tokenStreams(part.toks);
    }
  }
}

type Add = (rule: string, message: string, lexeme: string | null, word: boolean) => void;

function isOpTok(t: Token | null, v: string): boolean {
  return t !== null && t.kind === "op" && t.v === v;
}
function isIdentTok(t: Token | null): t is Token & { kind: "ident" } {
  return t !== null && t.kind === "ident";
}

const BANNED_IDENTS: { [word: string]: string } = {
  class: "JS `class` is not supported in JSE — model data as plain dicts; put behavior in <action>/<function>",
  extends: "`extends` (class inheritance) is not supported — compose plain dicts and share logic via <function>/<action>",
  yield: "generators (`yield`) are not supported — build the array up front with map/filter or a for…of loop",
  import: "`import` is not supported — JSE has no module syntax; share logic via <function>/<action> or a dsx.module.* capability",
  export: "`export` is not supported — JSE has no module syntax; declared <action>/<function>/<formula> are the sharing surface",
  void: "the `void` operator is not supported — JSE has one missing value; write `null`",
  instanceof: "`instanceof` is not supported — use typeof, Array.isArray(x), or shape checks (`'key' in obj`)",
};

function scanBanned(stream: Token[], add: Add): void {
  const at = (i: number): Token | null => (i >= 0 && i < stream.length ? stream[i]! : null);
  for (let i = 0; i < stream.length; i++) {
    const t = stream[i]!;
    if (t.kind !== "ident") continue;
    const prev = at(i - 1);
    const next = at(i + 1);
    // `{ class: 1 }` is a legal dict key; `x().class` is a legal member read — the
    // tokenizer's dotted-ident rule already folds `a.class` into one token.
    const objectKey = isOpTok(next, ":") && (isOpTok(prev, "{") || isOpTok(prev, ","));
    const member = isOpTok(prev, ".") || isOpTok(prev, "?.");
    if (objectKey || member) continue;
    const banned = BANNED_IDENTS[t.v];
    if (banned !== undefined) {
      add("banned-construct", banned, t.v, true);
      continue;
    }
    if (t.v === "delete" && isIdentTok(next)) {
      add("banned-construct",
        "the `delete` operator is not supported — rebuild the dict without the key " +
        "(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'x')))",
        "delete", true);
      continue;
    }
    if (t.v === "async") {
      const n2 = at(i + 2);
      const asyncFn = (isIdentTok(next) && next.v === "function") || isOpTok(next, "(") ||
        (isIdentTok(next) && isOpTok(n2, "=>"));
      if (asyncFn) {
        add("banned-construct",
          "`async` function syntax is not supported — action/handler bodies already run statement-level `await` directly; drop the wrapper",
          "async", true);
      }
      continue;
    }
    if (t.v === "function" && isOpTok(next, "*")) {
      add("banned-construct",
        "generators (`function*`) are not supported — build the array up front with map/filter or a for…of loop",
        "function", true);
      continue;
    }
    if (t.v === "new" && isIdentTok(next) && (next.v === "Promise" || next.v.startsWith("Promise."))) {
      add("banned-construct",
        "`new Promise(…)` is not supported — async work is `await fetch(…)` / `await dsx.module.…` / `crypto.subtle.…` at statement level; combine with Promise.all/race/any/allSettled",
        "Promise", true);
    }
  }
}

/** Statement bodies only: `await` anywhere but statement-leading position cannot
 *  suspend — the evaluator coerces the Promise to null (`1 + await f()` is a bug).
 *  Leading positions (where the runner DOES strip and await): the start of a statement
 *  (after `;` `{` `}` or the body start), an initializer/assignment RHS (`= await …`),
 *  a declarator after a top-level comma, and `return` / `throw`. */
function scanInteriorAwait(stream: Token[], add: Add): void {
  const at = (i: number): Token | null => (i >= 0 && i < stream.length ? stream[i]! : null);
  for (let i = 0; i < stream.length; i++) {
    const t = stream[i]!;
    if (t.kind !== "ident" || t.v !== "await") continue;
    const prev = at(i - 1);
    const leading = prev === null ||
      (prev.kind === "op" && (prev.v === ";" || prev.v === "{" || prev.v === "}" || prev.v === "=" || prev.v === ",")) ||
      (prev.kind === "ident" && (prev.v === "return" || prev.v === "throw"));
    if (!leading) {
      add("interior-await",
        "interior `await` is not supported — the Promise coerces to null mid-expression; restructure as `const x = await …` first",
        "await", true);
    }
  }
}

const CHAIN_METHODS = ["then", "catch", "finally"];

function scanUnsupportedCalls(stream: Token[], add: Add): void {
  const at = (i: number): Token | null => (i >= 0 && i < stream.length ? stream[i]! : null);
  for (let i = 0; i < stream.length; i++) {
    const t = stream[i]!;
    if (t.kind !== "ident" || !isOpTok(at(i + 1), "(")) continue;
    const prev = at(i - 1);
    // `x.then(` folds into one dotted ident; `x().then(` / `x?.then(` arrive as `.`+ident.
    // A bare `catch`/`finally` after `}` is try/catch grammar and never matches here.
    const viaDot = isOpTok(prev, ".") || isOpTok(prev, "?.");
    for (const m of CHAIN_METHODS) {
      if (t.v.endsWith("." + m) || (viaDot && t.v === m)) {
        add("promise-chain",
          `Promise chaining (\`.${m}(…)\`) is not supported — use statement-level \`await\`; failures come back as values (\`r.ok\` / \`r.error\`), or wrap in try/catch`,
          "." + m + "(", false);
      }
    }
    if (t.v.endsWith(".localeCompare") || (viaDot && t.v === "localeCompare")) {
      add("unsupported-method",
        "`localeCompare` is deliberately not implemented (ICU collation diverges across hosts) — sort with an explicit comparator ((a, b) => a < b ? -1 : a > b ? 1 : 0)",
        ".localeCompare(", false);
    }
    if (t.v.endsWith(".toPrecision") || (viaDot && t.v === "toPrecision")) {
      add("unsupported-method",
        "`toPrecision` is deliberately not implemented — use toFixed or Intl.NumberFormat with maximumSignificantDigits",
        ".toPrecision(", false);
    }
  }
}

function scanUnknownOps(stream: Token[], add: Add): void {
  for (const t of stream) {
    if (t.kind !== "op" || KNOWN_OPS.has(t.v)) continue;
    const shown = t.v.replace(/\n/g, "\\n");
    add("unknown-op",
      `unsupported syntax \`${shown}\` — JSE does not lex this token; the expression will not evaluate as written`,
      t.v, false);
  }
}

/** 2^53 — the largest magnitude at which a double still holds EVERY integer exactly. */
export const MAX_EXACT_DOUBLE_INT = 9007199254740992;

/** Every numeric-literal spelling in the (comment-stripped) site code that parses to
 *  the token's value — best-effort source recovery (tokens carry no positions yet). */
function numericLexemes(code: string, v: number): string[] {
  const out: string[] = [];
  const re = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    if (Number(m[0]!.replace(/_/g, "")) === v) out.push(m[0]!);
  }
  return out;
}

/** The EXACT integer a literal spelling denotes (BigInt reads the digits, not the
 *  rounded double) — null for fractional/exponent forms. */
function literalDigitsValue(lexeme: string): bigint | null {
  const flat = lexeme.replace(/_/g, "");
  if (!/^([0-9]+|0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+)$/.test(flat)) return null;
  try {
    return BigInt(flat);
  } catch {
    return null;
  }
}

/** Numeric literals with magnitude > 2^53 — legal, and they run, but lossily: a double
 *  cannot hold the integer exactly, so a 64-bit backend ID written (or compared) as a
 *  number is silently a DIFFERENT number. Detection is token-value based (comments and
 *  strings never tokenize as numbers); the one value the check alone would miss is the
 *  textbook literal 2^53+1, whose double rounds DOWN to exactly 2^53 — at that boundary
 *  the source DIGITS decide (and only when every candidate spelling is over — a site
 *  that also contains an exact 2^53 spelling stays conservative). */
function scanUnsafeNumbers(stream: Token[], lexSource: string, add: Add): void {
  for (const t of stream) {
    if (t.kind !== "num") continue;
    const mag = Math.abs(t.v);
    if (mag < MAX_EXACT_DOUBLE_INT) continue;
    const candidates = numericLexemes(lexSource, t.v);
    if (mag === MAX_EXACT_DOUBLE_INT) {
      const allOver = candidates.length > 0 && candidates.every((c) => {
        const d = literalDigitsValue(c);
        return d !== null && d > BigInt(MAX_EXACT_DOUBLE_INT);
      });
      if (!allOver) continue; // exactly-2^53 spellings are still exact
    }
    const shown = candidates[0] ?? String(t.v);
    const digits = literalDigitsValue(shown);
    let stored = "";
    try {
      if (digits !== null && digits !== BigInt(t.v)) stored = ` (it is stored as ${String(BigInt(t.v))})`;
    } catch {
      stored = ""; // non-integral double (1e400 → Infinity) — no exact rendering
    }
    add("unsafe-number-literal",
      `numeric literal \`${shown}\` exceeds 2^53 (${MAX_EXACT_DOUBLE_INT}) — doubles cannot hold this integer exactly${stored}; ` +
      `backend IDs above 2^53 must ride as STRINGS ('${shown}')`,
      candidates[0] ?? null, false);
  }
}

/** Labeled statements — deliberately NARROW to stay false-positive-free around object
 *  literals and ternaries: only `ident:` at line start DIRECTLY followed by a loop
 *  keyword (the `outer: for (…)` shape `break outer` depends on). */
function scanLabels(code: string, add: Add): void {
  const src = stripComments(code);
  const re = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*(?=(?:for|while|do)\b)/gm;
  const skip = new Set(["case", "default", "fetch", "remove", "animate", "resolve", "error"]);
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const name = m[1]!;
    if (skip.has(name)) continue;
    add("banned-construct",
      `labeled statement \`${name}:\` is not supported — use a flag variable, or extract the inner loop into an <action> and \`return\` from it`,
      name, true);
  }
}

function renderToken(t: Token): string {
  switch (t.kind) {
    case "num": return String(t.v);
    case "str": return `'${t.v}'`;
    case "ident": return t.v;
    case "op": return t.v.replace(/\n/g, "\\n");
    case "regex": return `/${t.pattern}/${t.flags}`;
    case "template": return "`…`";
  }
}

function renderTokens(toks: Token[], cap: number): string {
  let out = "";
  for (const t of toks) {
    const piece = renderToken(t);
    out = out.length === 0 ? piece : out + " " + piece;
    if (out.length > cap) return out.slice(0, cap) + "…";
  }
  return out;
}

/** Expression sites only: drive the kernel's own Parser and flag leftover tokens —
 *  the kernel evaluates the prefix and silently ignores the tail. */
function scanResidue(toks: Token[], add: Add): void {
  if (toks.length === 0) return;
  const p = new Parser(toks, new StackStore(), null);
  try {
    p.expression();
  } catch {
    return; // evaluation blew a budget — not a parse verdict; stay conservative
  }
  if (p.pos >= toks.length) return;
  const tail = renderTokens(toks.slice(p.pos), 60);
  add("parse-residue",
    `expression did not fully parse — the tail \`${tail}\` is dead (JSE evaluates the prefix and silently ignores the rest)`,
    renderToken(toks[p.pos]!), false);
}

// ── finding assembly (line/snippet/caret are best-effort by design) ─────────────────

function leadingBlankLines(code: string): number {
  let n = 0;
  for (const line of code.split("\n")) {
    if (line.trim().length > 0) break;
    n += 1;
  }
  return n;
}

function locateInSite(site: Site, lexeme: string | null, word: boolean): {
  line: number; snippet: string; caret: number;
} {
  const code = site.code;
  let idx = -1;
  if (lexeme !== null && lexeme.length > 0) {
    if (word) {
      const re = new RegExp(`(?<![A-Za-z0-9_.])${lexeme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
      const m = re.exec(code);
      idx = m === null ? -1 : m.index;
    } else {
      idx = code.indexOf(lexeme);
    }
  }
  if (idx < 0) {
    const snippet = firstNonBlankLine(code).slice(0, 140);
    return { line: site.line, snippet, caret: -1 };
  }
  let linesBefore = 0;
  for (let i = 0; i < idx; i++) if (code[i] === "\n") linesBefore += 1;
  // non-exact sites were located by their first NON-blank line — align to it
  const line = site.line + linesBefore - (site.exact ? 0 : leadingBlankLines(code));
  const lineStart = code.lastIndexOf("\n", idx - 1) + 1;
  const lineEndRaw = code.indexOf("\n", idx);
  const lineEnd = lineEndRaw < 0 ? code.length : lineEndRaw;
  let snippet = code.slice(lineStart, lineEnd).replace(/\t/g, " ");
  let caret = idx - lineStart;
  const trimmed = snippet.replace(/^ +/, "");
  caret -= snippet.length - trimmed.length;
  snippet = trimmed;
  if (snippet.length > 140) {
    const from = Math.max(0, Math.min(caret - 60, snippet.length - 140));
    snippet = (from > 0 ? "…" : "") + snippet.slice(from, from + 140) + "…";
    caret = caret - from + (from > 0 ? 1 : 0);
  }
  return { line: Math.max(1, line), snippet, caret: Math.max(-1, caret) };
}

export function auditSite(site: Site): Finding[] {
  const scanSource = site.kind === "statements" ? maskFetchEffectUrls(site.code) : site.code;
  const toks = tokenize(scanSource);
  const found: Finding[] = [];
  const seen = new Set<string>();
  const add: Add = (rule, message, lexeme, word) => {
    const key = rule + "|" + message;
    if (seen.has(key)) return;
    seen.add(key);
    const loc = locateInSite(site, lexeme, word);
    found.push({
      file: site.file, line: loc.line, rule, severity: "error", message,
      snippet: loc.snippet, caret: loc.caret, context: site.context,
    });
  };
  const lexSource = stripComments(site.code);
  for (const stream of tokenStreams(toks)) {
    scanBanned(stream, add);
    scanUnsupportedCalls(stream, add);
    scanUnknownOps(stream, add);
    scanUnsafeNumbers(stream, lexSource, add);
  }
  if (site.kind === "statements") {
    scanLabels(site.code, add);
    scanInteriorAwait(toks, add); // top stream only — position logic is statement-level
  }
  if (site.kind === "expr") scanResidue(toks, add);
  return found;
}

export function auditSource(file: string, source: string): { sites: number; findings: Finding[] } {
  const { sites, parseError } = collectSites(file, source);
  if (parseError !== null) {
    return {
      sites: 0,
      findings: [{
        file, line: parseError.line, rule: "dsx-parse", severity: "error",
        message: `file does not parse — no JSE sites can be audited: ${parseError.message}`,
        snippet: "", caret: -1, context: "document",
      }],
    };
  }
  const findings: Finding[] = [];
  for (const site of sites) findings.push(...auditSite(site));
  return { sites: sites.length, findings };
}

export function auditFile(file: string): { sites: number; findings: Finding[] } {
  return auditSource(file, readFileSync(file, "utf8"));
}

// ── file discovery ───────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".gradle", "build", "DerivedData", "Pods"]);

export function findDsxFiles(roots: string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(".dsx")) {
        out.push(join(dir, e.name));
      }
    }
  };
  for (const root of roots) {
    const st = statSync(root, { throwIfNoEntry: false });
    if (st === undefined) {
      console.error(`jse-audit: no such path: ${root}`);
      continue;
    }
    if (st.isFile()) {
      if (root.endsWith(".dsx")) out.push(root);
    } else {
      visit(root);
    }
  }
  return [...new Set(out)].sort();
}

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd(); // outside the repo — audit the cwd
    dir = parent;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────

function relPath(file: string): string {
  const r = relative(process.cwd(), file);
  return r.length > 0 && !r.startsWith("..") ? r : file;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let strict = false;
  let json = false;
  const paths: string[] = [];
  for (const a of argv) {
    if (a === "--strict") strict = true;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node packages/kernel/bin/jse-audit.ts [--strict] [--json] [roots or .dsx files…]");
      return 0;
    } else paths.push(a);
  }
  const roots = (paths.length > 0 ? paths : [repoRoot()]).map((p) => resolve(p));
  const files = findDsxFiles(roots);
  const findings: Finding[] = [];
  let siteCount = 0;
  for (const file of files) {
    const res = auditFile(file);
    siteCount += res.sites;
    findings.push(...res.findings);
  }
  if (json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) {
      const list = byFile.get(f.file) ?? [];
      list.push(f);
      byFile.set(f.file, list);
    }
    for (const file of [...byFile.keys()].sort()) {
      console.log("");
      for (const f of byFile.get(file)!.sort((a, b) => a.line - b.line)) {
        console.log(`${relPath(file)}:${f.line}  [${f.rule}]  ${f.message}`);
        if (f.snippet.length > 0) {
          console.log(`    ${f.snippet}`);
          if (f.caret >= 0) console.log(`    ${" ".repeat(f.caret)}^`);
        }
      }
    }
    if (findings.some((f) => f.rule === "unsafe-number-literal")) {
      console.log("");
      console.log(
        "advisory — 64-bit ID handling: JSE numbers are IEEE-754 doubles on every renderer, so\n" +
        `integers above 2^53 (${MAX_EXACT_DOUBLE_INT}) silently lose precision — and 64-bit backend\n` +
        "IDs (Snowflake IDs, Twitter/X IDs, many SQL bigint keys) live exactly there. Keep such IDs\n" +
        "as STRINGS end to end: quote them in literals and fixtures, never coerce them with\n" +
        "Number()/parseInt, compare with ===, and ask APIs for string IDs where offered —\n" +
        "JSON.parse of a bare 64-bit number mangles it before any of your code runs.");
    }
    console.log("");
    if (findings.length === 0) {
      console.log(`jse-audit: clean — 0 findings (${siteCount} JSE sites in ${files.length} .dsx files)`);
    } else {
      const fileCount = new Set(findings.map((f) => f.file)).size;
      console.log(`jse-audit: ${findings.length} error(s) across ${fileCount} file(s) (${siteCount} JSE sites in ${files.length} .dsx files)`);
    }
  }
  return strict && findings.length > 0 ? 1 : 0;
}

let invokedDirectly = false;
try {
  const entry = process.argv[1];
  invokedDirectly = entry !== undefined &&
    realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) process.exitCode = main();
