//
//  highlight.ts - source spans for the `<code>` element. TS twin of Highlight.swift /
//  Highlight.kt; the shared corpus is OpenSource/Conformance/code/tokens.json.
//
//  THIS IS NOT `tokenize`. The evaluator's lexer strips comments, runs ASI and hands back
//  values with no idea where they came from - correct for running code, useless for drawing
//  it. A highlighter needs the opposite: every byte accounted for, comments and whitespace
//  included, in source order, with offsets. So it is its own scanner, deliberately, and it
//  shares the ONE thing that must not drift - the rule that decides whether a `/` opens a
//  regex or divides - with the evaluator's `charAllowsRegex`.
//
//  The output TILES the source: spans are contiguous, non-overlapping, and cover every code
//  unit from 0 to length. That makes the corpus expressible as a MASK - one letter per code
//  unit - which a person can read against the source and check by eye, and which fails with
//  an aligned diff rather than a list of offsets.
//

export type HiKind =
  | "plain"      // whitespace, and anything the scanner has no opinion about
  | "comment"
  | "string"     // a quoted literal, and a template's backticks and literal chunks
  | "number"
  | "regex"
  | "keyword"
  | "literal"    // true false null undefined - a value, not a control word
  | "call"       // an identifier a `(` follows: what this line DOES
  | "property"   // an identifier a `.` precedes
  | "ident"
  | "operator"
  | "punct";

export type HiToken = { start: number; end: number; kind: HiKind };

/** One letter per kind, for the corpus mask and for a compact class name. */
export const HI_LETTER: Record<HiKind, string> = {
  plain: ".", comment: "c", string: "s", number: "n", regex: "r", keyword: "k",
  literal: "l", call: "f", property: "p", ident: "i", operator: "o", punct: "x",
};

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "break", "continue", "switch", "case", "default", "try", "catch", "finally", "throw",
  "new", "typeof", "instanceof", "in", "of", "delete", "void", "await", "async", "yield",
  "this",
]);
const LITERALS = new Set(["true", "false", "null", "undefined"]);
const PUNCT = new Set(["(", ")", "[", "]", "{", "}", ",", ";"]);
const OPERATOR = new Set("+-*/%=<>!&|^~?:.".split(""));

function isDigit(c: string): boolean { return c >= "0" && c <= "9"; }
function isWordStart(c: string): boolean { return /[\p{L}_$]/u.test(c); }
function isWordChar(c: string): boolean { return /[\p{L}\p{N}_$]/u.test(c); }

/** The regex-vs-division rule, kept identical to the evaluator's `charAllowsRegex`: a `/` is
 *  a regex when nothing valued precedes it. `x / 2` divides, `return /ab/` does not. */
export function opensRegex(src: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(src[i]!)) i--;
  if (i < 0) return true;
  const prev = src[i]!;
  if (prev === ")" || prev === "]" || prev === "'" || prev === '"' || prev === "`") return false;
  if (!isWordChar(prev)) return true;
  // a word: a keyword still leaves the slash in prefix position, a value does not
  let j = i;
  while (j >= 0 && isWordChar(src[j]!)) j--;
  const word = src.slice(j + 1, i + 1);
  return KEYWORDS.has(word) && word !== "this";
}

/** Where a regex literal ends, character class and escapes respected, flags included. */
export function endOfRegex(src: string, at: number): number {
  let i = at + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") { i = Math.min(i + 2, src.length); continue; }
    if (c === "\n") return i;               // unterminated: it was division after all
    if (c === "[") { inClass = true; i++; continue; }
    if (c === "]") { inClass = false; i++; continue; }
    if (c === "/" && !inClass) { i++; break; }
    i++;
  }
  while (i < src.length && /[a-z]/.test(src[i]!)) i++;
  return i;
}

/** Where a numeric literal ends: radix forms, exponents and `_` separators. */
export function endOfNumber(src: string, at: number): number {
  let i = at;
  if (src[i] === "0" && i + 1 < src.length && /[xXbBoO]/.test(src[i + 1]!)) {
    i += 2;
    while (i < src.length && /[0-9a-fA-F_]/.test(src[i]!)) i++;
    return i;
  }
  while (i < src.length && (isDigit(src[i]!) || src[i] === "_")) i++;
  if (src[i] === "." && isDigit(src[i + 1] ?? "")) {
    i++;
    while (i < src.length && (isDigit(src[i]!) || src[i] === "_")) i++;
  }
  if (i < src.length && (src[i] === "e" || src[i] === "E")) {
    let k = i + 1;
    if (src[k] === "+" || src[k] === "-") k++;
    if (isDigit(src[k] ?? "")) { k++; while (k < src.length && isDigit(src[k]!)) k++; i = k; }
  }
  return i;
}

/** Spans covering every code unit of `source`, in order, with no gaps and no overlap. */
export function highlight(source: string): HiToken[] {
  const out: HiToken[] = [];
  const push = (start: number, end: number, kind: HiKind): void => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === kind && last.end === start) { last.end = end; return; }
    out.push({ start, end, kind });
  };
  // a template's `${ … }` hole is scanned by the same loop, so the stack only has to
  // remember that a `}` at depth zero closes the hole and returns to string mode
  const holes: number[] = [];
  let depth = 0;
  let i = 0;

  while (i < source.length) {
    const c = source[i]!;

    if (/\s/.test(c)) { const s = i; while (i < source.length && /\s/.test(source[i]!)) i++; push(s, i, "plain"); continue; }

    if (c === "/" && source[i + 1] === "/") {
      const s = i;
      while (i < source.length && source[i] !== "\n") i++;
      push(s, i, "comment");
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const s = i;
      const close = source.indexOf("*/", i + 2);
      i = close < 0 ? source.length : close + 2;
      push(s, i, "comment");
      continue;
    }
    if (c === "/" && opensRegex(source, i)) { const s = i; i = endOfRegex(source, i); push(s, i, "regex"); continue; }

    if (c === "'" || c === '"') {
      const s = i;
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i = Math.min(i + 2, source.length); continue; }
        if (source[i] === quote) { i++; break; }
        // an unterminated literal stops at the line end rather than eating the file
        if (source[i] === "\n") break;
        i++;
      }
      push(s, i, "string");
      continue;
    }

    if (c === "`") {
      const s = i;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i = Math.min(i + 2, source.length); continue; }
        if (source[i] === "`") { i++; break; }
        if (source[i] === "$" && source[i + 1] === "{") break;
        i++;
      }
      push(s, i, "string");
      if (source[i] === "$" && source[i + 1] === "{") {
        push(i, i + 2, "operator");
        i += 2;
        holes.push(depth);
        depth = 0;
      }
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      const s = i;
      i = endOfNumber(source, i);
      push(s, i, "number");
      continue;
    }

    if (isWordStart(c)) {
      const s = i;
      while (i < source.length && isWordChar(source[i]!)) i++;
      const word = source.slice(s, i);
      let j = i;
      while (j < source.length && /[ \t]/.test(source[j]!)) j++;
      let k = s - 1;
      while (k >= 0 && /[ \t]/.test(source[k]!)) k--;
      // keyword and literal outrank shape: `if (` is not a call, `default:` is not a property
      const kind: HiKind = KEYWORDS.has(word) ? "keyword"
        : LITERALS.has(word) ? "literal"
        : source[j] === "(" ? "call"
        // `.b` and `?.b` reach a property; `...rows` does not - the third dot of a spread is
        // not member access, and reading it as one coloured the spread argument as a field
        : k >= 0 && source[k] === "." && source[k - 1] !== "." ? "property"
        : "ident";
      push(s, i, kind);
      continue;
    }

    if (c === "}" && holes.length > 0 && depth === 0) {
      // the hole closes: back to the template's literal run, which resumes at the backtick
      push(i, i + 1, "operator");
      i++;
      depth = holes.pop()!;
      const s = i;
      while (i < source.length) {
        if (source[i] === "\\") { i = Math.min(i + 2, source.length); continue; }
        if (source[i] === "`") { i++; break; }
        if (source[i] === "$" && source[i + 1] === "{") break;
        i++;
      }
      push(s, i, "string");
      if (source[i] === "$" && source[i + 1] === "{") {
        push(i, i + 2, "operator");
        i += 2;
        holes.push(depth);
        depth = 0;
      }
      continue;
    }

    if (PUNCT.has(c)) {
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth = Math.max(0, depth - 1);
      push(i, i + 1, "punct");
      i++;
      continue;
    }
    if (OPERATOR.has(c)) { const s = i; while (i < source.length && OPERATOR.has(source[i]!)) i++; push(s, i, "operator"); continue; }

    push(i, i + 1, "plain");
    i++;
  }
  return out;
}

/** The corpus form: one letter per code unit. A wrong length fails before a wrong colour. */
export function highlightMask(source: string): string {
  const mask: string[] = [];
  for (const tok of highlight(source)) {
    for (let i = tok.start; i < tok.end; i++) mask.push(HI_LETTER[tok.kind]);
  }
  return mask.join("");
}

export type HiSpan = { text: string; kind: HiKind };
export type HiLine = { line: number; spans: HiSpan[] };

/**
 * The markup-facing shape: one row per source line, each a run of `{ text, kind }`.
 *
 * A code editor draws line by line - a gutter number, then the coloured runs - so the
 * builtin hands back exactly that rather than offsets a page would have to slice. Spans
 * never straddle a line break, so a row's texts concatenate to its line and the rows
 * concatenate to the source.
 */
export function highlightLines(source: string): HiLine[] {
  const out: HiLine[] = [{ line: 1, spans: [] }];
  for (const tok of highlight(source)) {
    const parts = source.slice(tok.start, tok.end).split("\n");
    for (const [i, part] of parts.entries()) {
      if (i > 0) out.push({ line: out.length + 1, spans: [] });
      if (part === "") continue;
      const row = out[out.length - 1]!;
      const last = row.spans[row.spans.length - 1];
      if (last !== undefined && last.kind === tok.kind) { last.text += part; continue; }
      row.spans.push({ text: part, kind: tok.kind });
    }
  }
  return out;
}
