//
//  xml.ts - the DSX markup parser (TS twin of StackXML). NOT generic XML: it carries
//  the runtime's exact quirks, which the lint blesses (lint_dsx.rb):
//
//    • namespace processing OFF — `on:tap`, `on:change.throttle`, `scheme.Name` are
//      plain names (colon/dot are ordinary characters)
//    • CODE TAGS (`script action formula variable var let`) hold raw JS lifted 1:1
//      BEFORE structural parsing — `<`, `&&`, `>` inside are never markup
//    • smart-entity normalization: a bare `&` not starting a valid entity is literal;
//      a `<` inside a QUOTED attribute value is literal; valid entities only
//      `&amp; &lt; &gt; &quot; &apos; &#DDD; &#xHHH;`
//    • comments (`<!-- -->`) skipped; CDATA verbatim; exactly one root element
//

export type XmlNode = {
  tag: string;
  attrs: { [name: string]: string };
  children: XmlNode[];
  /** concatenated text content (code-tag bodies land here verbatim) */
  text: string;
};

/** Hard parser boundaries for authored and remotely supplied DSX documents.
 *  These are deliberately generous relative to the first-party corpus (currently
 *  < 200 KiB, < 1,200 nodes, and < 16 levels), while keeping malformed input from
 *  exhausting the JS stack or allocating an unbounded AST. Limits are inclusive. */
export const DSX_PARSE_LIMITS = Object.freeze({
  maxDocumentBytes: 4 * 1024 * 1024,
  maxNodes: 50_000,
  maxDepth: 256,
});

const CODE_TAGS = new Set(["script", "action", "formula", "variable", "var", "let", "functions"]);

function isXmlCharacter(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0A || codePoint === 0x0D ||
    (codePoint >= 0x20 && codePoint <= 0xD7FF) ||
    (codePoint >= 0xE000 && codePoint <= 0xFFFD) ||
    (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
}

/** Reject characters XML 1.0 cannot carry in structural/text regions. The error-line
 *  callback stays lazy so ordinary text runs remain linear even late in a document.
 *  Raw code-tag bodies intentionally do not pass here: native StackXML lifts them
 *  before SAX parsing, and valid JavaScript may use VT/FF as whitespace. */
function assertXmlCharacters(source: string, errorLine: () => number): void {
  let relativeLine = 0;
  for (let i = 0; i < source.length;) {
    const codePoint = source.codePointAt(i)!;
    if (!isXmlCharacter(codePoint)) {
      throw new DsxParseError("literal is not a valid XML character", errorLine() + relativeLine);
    }
    if (codePoint === 0x0A) relativeLine += 1;
    i += codePoint > 0xFFFF ? 2 : 1;
  }
}

function decodeEntities(s: string, errorLine: () => number): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch !== "&") {
      const codePoint = s.codePointAt(i)!;
      if (!isXmlCharacter(codePoint)) {
        throw new DsxParseError("literal is not a valid XML character", errorLine());
      }
      out += String.fromCodePoint(codePoint);
      i += codePoint > 0xFFFF ? 2 : 1;
      continue;
    }
    const rest = s.substring(i);
    const named = /^&(amp|lt|gt|quot|apos);/.exec(rest);
    if (named) {
      out += { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named[1] as "amp"];
      i += named[0].length;
      continue;
    }
    const dec = /^&#(\d+);/.exec(rest);
    const hex = /^&#x([0-9a-fA-F]+);/.exec(rest);
    if (dec || hex) {
      const entity = (dec ?? hex)!;
      const codePoint = parseInt(entity[1]!, dec ? 10 : 16);
      if (!Number.isInteger(codePoint) || !isXmlCharacter(codePoint)) {
        throw new DsxParseError("numeric entity is not a valid XML character", errorLine());
      }
      out += String.fromCodePoint(codePoint);
      i += entity[0].length;
      continue;
    }
    out += "&"; // bare & — literal (the smart-entity rule)
    i += 1;
  }
  return out;
}

export class DsxParseError extends Error {
  readonly line: number;
  // `line` is OPTIONAL: the tokenizer/structural throws carry the exact source line,
  // while post-parse head validations (e.g. <api as>) run on the already-built tree
  // with no cursor position — they raise the SAME structured type rather than a bare
  // Error, and simply omit the line instead of fabricating one. `.line` stays a number
  // (0 = unknown) so every existing reader is unaffected.
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.line = line ?? 0;
  }
}

class Cursor {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  line(): number {
    let n = 1;
    for (let k = 0; k < this.i && k < this.s.length; k++) if (this.s[k] === "\n") n += 1;
    return n;
  }
  eof(): boolean { return this.i >= this.s.length; }
  peek(): string { return this.s[this.i] ?? ""; }
  startsWith(prefix: string): boolean { return this.s.startsWith(prefix, this.i); }
  skipWs(): void { while (!this.eof() && /[ \t\r\n]/.test(this.s[this.i]!)) this.i += 1; }
}

function isNameChar(c: string): boolean {
  return /[A-Za-z0-9_.:\-]/.test(c);
}

function readName(c: Cursor): string {
  let out = "";
  while (!c.eof() && isNameChar(c.peek())) { out += c.peek(); c.i += 1; }
  return out;
}

/** Parse one element starting at `<`. */
type ParseBudget = { nodes: number };

function parseElement(c: Cursor, budget: ParseBudget, depth: number): XmlNode {
  if (depth > DSX_PARSE_LIMITS.maxDepth) {
    throw new DsxParseError(`nesting depth exceeds ${DSX_PARSE_LIMITS.maxDepth}-level limit`, c.line());
  }
  budget.nodes += 1;
  if (budget.nodes > DSX_PARSE_LIMITS.maxNodes) {
    throw new DsxParseError(`node count exceeds ${DSX_PARSE_LIMITS.maxNodes}-node limit`, c.line());
  }
  if (c.peek() !== "<") throw new DsxParseError("expected '<'", c.line());
  c.i += 1;
  const tag = readName(c);
  if (tag.length === 0) throw new DsxParseError("empty tag name", c.line());
  const node: XmlNode = { tag, attrs: {}, children: [], text: "" };
  // attributes
  for (;;) {
    c.skipWs();
    if (c.eof()) throw new DsxParseError(`unterminated <${tag}>`, c.line());
    if (c.startsWith("/>")) { c.i += 2; return node; }
    if (c.peek() === ">") { c.i += 1; break; }
    const name = readName(c);
    if (name.length === 0) throw new DsxParseError(`bad attribute in <${tag}>`, c.line());
    c.skipWs();
    if (c.peek() !== "=") { node.attrs[name] = ""; continue; } // bare attribute
    c.i += 1;
    c.skipWs();
    const q = c.peek();
    if (q !== '"' && q !== "'") throw new DsxParseError(`unquoted value for ${name} in <${tag}>`, c.line());
    c.i += 1;
    let value = "";
    while (!c.eof() && c.peek() !== q) { value += c.peek(); c.i += 1; } // `<` inside is literal
    if (c.eof()) throw new DsxParseError(`unterminated value for ${name} in <${tag}>`, c.line());
    c.i += 1;
    node.attrs[name] = decodeEntities(value, () => c.line());
  }
  // CODE TAGS: raw body to the matching close — never markup
  if (CODE_TAGS.has(tag)) {
    const close = `</${tag}>`;
    const end = c.s.indexOf(close, c.i);
    if (end < 0) throw new DsxParseError(`unterminated <${tag}> code body`, c.line());
    node.text = c.s.substring(c.i, end);
    c.i = end + close.length;
    return node;
  }
  // children + text
  for (;;) {
    if (c.eof()) throw new DsxParseError(`unterminated <${tag}>`, c.line());
    if (c.startsWith("<!--")) {
      const end = c.s.indexOf("-->", c.i + 4);
      if (end < 0) throw new DsxParseError("unterminated comment", c.line());
      assertXmlCharacters(c.s.substring(c.i + 4, end), () => c.line());
      c.i = end + 3;
      continue;
    }
    if (c.startsWith("<![CDATA[")) {
      const end = c.s.indexOf("]]>", c.i + 9);
      if (end < 0) throw new DsxParseError("unterminated CDATA", c.line());
      const text = c.s.substring(c.i + 9, end);
      assertXmlCharacters(text, () => c.line());
      node.text += text;
      c.i = end + 3;
      continue;
    }
    if (c.startsWith(`</`)) {
      const save = c.i;
      c.i += 2;
      const closeName = readName(c);
      c.skipWs();
      if (c.peek() !== ">") throw new DsxParseError(`malformed close tag </${closeName}`, c.line());
      c.i += 1;
      if (closeName !== tag) {
        c.i = save;
        throw new DsxParseError(`mismatched close: expected </${tag}>, found </${closeName}>`, c.line());
      }
      return node;
    }
    if (c.peek() === "<" && isNameChar(c.s[c.i + 1] ?? "")) {
      node.children.push(parseElement(c, budget, depth + 1));
      continue;
    }
    // A `<` that opens no child/comment/CDATA/close tag is not literal text here (the
    // authoring rule is `&lt;`, lint-enforced) — fail fast with a located error. Without
    // this the text run below reads zero characters and the for(;;) spins forever: a
    // build/SSR hang on any `.dsx` with a bare `<` in body text (`score < 10`).
    if (c.peek() === "<") throw new DsxParseError("unexpected '<' in text — write '&lt;'", c.line());
    // text run (stops at the next `<`, which the branches above have first claim on)
    let text = "";
    while (!c.eof() && c.peek() !== "<") { text += c.peek(); c.i += 1; }
    node.text += decodeEntities(text, () => c.line());
  }
}

/** Parse a .dsx document: comments/prolog allowed around EXACTLY ONE root element. */
export function parseDsx(source: string): XmlNode {
  // Check UTF-16 length first: an over-limit ASCII document is rejected without
  // allocating a second attacker-sized buffer. A source inside that bound may use
  // multi-byte Unicode, so the encoded-byte check remains authoritative.
  if (source.length > DSX_PARSE_LIMITS.maxDocumentBytes) {
    throw new DsxParseError(`document exceeds ${DSX_PARSE_LIMITS.maxDocumentBytes}-byte limit`, 1);
  }
  if (new TextEncoder().encode(source).byteLength > DSX_PARSE_LIMITS.maxDocumentBytes) {
    throw new DsxParseError(`document exceeds ${DSX_PARSE_LIMITS.maxDocumentBytes}-byte limit`, 1);
  }
  const c = new Cursor(source);
  const budget: ParseBudget = { nodes: 0 };
  let root: XmlNode | null = null;
  for (;;) {
    c.skipWs();
    if (c.eof()) break;
    if (c.startsWith("<!--")) {
      const end = c.s.indexOf("-->", c.i + 4);
      if (end < 0) throw new DsxParseError("unterminated comment", c.line());
      assertXmlCharacters(c.s.substring(c.i + 4, end), () => c.line());
      c.i = end + 3;
      continue;
    }
    if (c.startsWith("<?")) {
      const end = c.s.indexOf("?>", c.i + 2);
      if (end < 0) throw new DsxParseError("unterminated prolog", c.line());
      assertXmlCharacters(c.s.substring(c.i + 2, end), () => c.line());
      c.i = end + 2;
      continue;
    }
    if (c.peek() === "<") {
      const el = parseElement(c, budget, 1);
      if (root !== null) throw new DsxParseError("more than one root element", c.line());
      root = el;
      continue;
    }
    // stray top-level text — skip whitespace-only, reject content
    const ch = c.peek();
    if (/[ \t\r\n]/.test(ch)) { c.i += 1; continue; }
    throw new DsxParseError(`unexpected top-level content '${ch}'`, c.line());
  }
  if (root === null) throw new DsxParseError("no root element", 1);
  return root;
}
