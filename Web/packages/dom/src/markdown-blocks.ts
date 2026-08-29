//
//  markdown-blocks.ts — BLOCK-level markdown (A4), the `<markdown>` element.
//
//  The twin of, not a replacement for, `<text markdown="true">`. That path renders the
//  INLINE intents only, because SwiftUI's Text collapses block intents and the web twin
//  matches it deliberately; it is untouched. This is the block vocabulary a package README
//  needs: headings, paragraphs, lists, fenced code, blockquotes, tables, images and rules.
//
//  THE OUTPUT IS A NEUTRAL TREE, not DOM and not HTML. That is what makes the corpus
//  (OpenSource/Conformance/markdown/blocks.json) implementable by the Kotlin and Swift
//  renderers without being rewritten for them: they parse to the same shape and render it
//  with their own primitives. The DOM and SSR renderers in this file are two consumers of
//  that tree, not the definition of it.
//
//  INLINE CONTENT IS NOT RE-PARSED HERE. Each block carries its raw inline source and the
//  existing inline parser (markdown.ts) handles it, so there is exactly one implementation
//  of emphasis, code spans, links and the link allowlist.
//
//  SAFETY: no path reaches innerHTML. A README fetched from a registry is untrusted input,
//  so raw HTML in the source is TEXT, and image targets ride the same allowlist the inline
//  parser uses — a refused target renders as prose rather than as a live element.
//

import { markdownFragment, markdownHtml, safeMarkdownHref } from "./markdown.ts";
import { tokenizeCode } from "./prose.ts";
import { admitSrc } from "./src-gate.ts";

/** Hostile-input ceilings. A markdown document here is authored copy or fetched data;
 *  past a bound the remainder renders as plain text rather than throwing. */
export const MARKDOWN_BLOCK_LIMITS = {
  characters: 65_536,
  blocks: 512,
  listDepth: 6,
} as const;

export type MarkdownBlock =
  | { type: "paragraph"; inline: string }
  | { type: "heading"; level: number; inline: string }
  | { type: "code"; language: string; text: string }
  | { type: "quote"; blocks: MarkdownBlock[] }
  | { type: "rule" }
  | { type: "image"; src: string; alt: string }
  | { type: "list"; ordered: boolean; start?: number; items: MarkdownListItem[] }
  | { type: "table"; header: string[]; rows: string[][] };

export interface MarkdownListItem {
  inline: string;
  blocks?: MarkdownBlock[];
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const IMAGE_ONLY = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((c) => c.trim());
}

/** Indentation in spaces, tabs counted as two — the width lists are authored at. */
function indentOf(raw: string): number {
  let n = 0;
  for (const ch of raw) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

/** Would this line open a NEW block in the main loop (rather than lazily continuing an
 *  open paragraph)? Branch order mirrors parseLines exactly, so laziness can never
 *  swallow a construct the outer loop would have taken. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (FENCE.test(trimmed)) return true;
  if (RULE.test(line) && !BULLET.test(line)) return true;
  if (HEADING.test(trimmed)) return true;
  if (QUOTE.test(line)) return true;
  if (trimmed.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) return true;
  if (BULLET.test(line) || ORDERED.test(line)) return true;
  const image = IMAGE_ONLY.exec(trimmed);
  return image !== null && safeMarkdownHref(image[2]!) !== null;
}

/** Does `prev` (the last line inside an open container) leave a PARAGRAPH open? Lazy
 *  continuation is a paragraph law: only then may an unmarked line keep its container. */
function leavesParagraphOpen(prev: string): boolean {
  const trimmed = prev.trim();
  if (trimmed.length === 0) return false;
  if (FENCE.test(trimmed)) return false;
  if (RULE.test(prev) && !BULLET.test(prev)) return false;
  if (HEADING.test(trimmed)) return false;
  const image = IMAGE_ONLY.exec(trimmed);
  return image === null || safeMarkdownHref(image[2]!) === null;
}

/**
 * Parse a markdown document into the neutral block tree the corpus defines.
 *
 * Line-oriented and single-pass: every branch either consumes its lines and emits a block
 * or falls through to paragraph accumulation, so no input can leave the loop without
 * advancing.
 */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const text = source.length > MARKDOWN_BLOCK_LIMITS.characters
    ? source.slice(0, MARKDOWN_BLOCK_LIMITS.characters)
    : source;
  const lines = text.split(/\r\n|\r|\n/);
  return parseLines(lines, 0);
}

function parseLines(lines: string[], depth: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    const inline = paragraph.join(" ").trim();
    paragraph = [];
    if (inline.length > 0 && blocks.length < MARKDOWN_BLOCK_LIMITS.blocks) {
      blocks.push({ type: "paragraph", inline });
    }
  };
  const push = (block: MarkdownBlock): void => {
    if (blocks.length < MARKDOWN_BLOCK_LIMITS.blocks) blocks.push(block);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed.length === 0) { flush(); i += 1; continue; }

    // A fence wins over everything: its contents are bytes, never markdown. An
    // unterminated fence closes at the end of the document rather than swallowing it.
    const fence = FENCE.exec(trimmed);
    if (fence !== null) {
      flush();
      const marker = fence[1]!;
      const language = fence[2] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i]!.trim() !== marker) { body.push(lines[i]!); i += 1; }
      if (i < lines.length) i += 1;
      push({ type: "code", language, text: body.join("\n") });
      continue;
    }

    if (RULE.test(line) && !BULLET.test(line)) { flush(); push({ type: "rule" }); i += 1; continue; }

    const heading = HEADING.exec(trimmed);
    if (heading !== null) {
      flush();
      push({ type: "heading", level: heading[1]!.length, inline: heading[2]!.trim() });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flush();
      const inner: string[] = [quote[1]!];
      i += 1;
      while (i < lines.length) {
        const next = QUOTE.exec(lines[i]!);
        if (next !== null) { inner.push(next[1]!); i += 1; continue; }
        // CommonMark laziness: an unmarked paragraph line keeps the quote open, but only
        // while the quote's innermost open block is still a paragraph.
        if (startsBlock(lines, i) || !leavesParagraphOpen(inner[inner.length - 1]!)) break;
        inner.push(lines[i]!);
        i += 1;
      }
      push({ type: "quote", blocks: depth >= MARKDOWN_BLOCK_LIMITS.listDepth ? [] : parseLines(inner, depth + 1) });
      continue;
    }

    // A table needs its divider on the NEXT line; without one these are ordinary
    // paragraph lines that happen to contain pipes.
    if (trimmed.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      flush();
      const header = cells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().includes("|")) {
        const row = cells(lines[i]!);
        // Padded rather than dropped: a short row is an authoring slip, and dropping it
        // loses content the author wrote.
        while (row.length < header.length) row.push("");
        rows.push(row.slice(0, header.length));
        i += 1;
      }
      push({ type: "table", header, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      flush();
      const consumed = parseList(lines, i, depth);
      push(consumed.block);
      i = consumed.next;
      continue;
    }

    const image = IMAGE_ONLY.exec(trimmed);
    if (image !== null) {
      const src = safeMarkdownHref(image[2]!);
      if (src !== null) {
        flush();
        push({ type: "image", src, alt: image[1] ?? "" });
        i += 1;
        continue;
      }
      // A refused target falls through to prose: the label survives, nothing becomes live.
    }

    paragraph.push(trimmed);
    i += 1;
  }
  flush();
  return blocks;
}

/** One list, from `start`, including any nested lists its items carry. */
function parseList(lines: string[], start: number, depth: number): { block: MarkdownBlock; next: number } {
  const first = lines[start]!;
  const firstOrdered = ORDERED.exec(first);
  const ordered = firstOrdered !== null;
  const baseIndent = indentOf(first);
  const items: MarkdownListItem[] = [];
  const startNumber = ordered ? Number.parseInt(firstOrdered[2]!, 10) : 0;

  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().length === 0) break;
    const bullet = BULLET.exec(line);
    const numbered = ORDERED.exec(line);
    const match = ordered ? numbered : bullet;
    if (match === null) {
      // No marker: CommonMark laziness — an unmarked line that opens no new block is
      // the previous item's paragraph continuing (wrapped source), at any indent.
      const owner = items[items.length - 1];
      if (owner === undefined || startsBlock(lines, i)) break;
      owner.inline = `${owner.inline} ${line.trim()}`;
      i += 1;
      continue;
    }
    const indent = indentOf(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // Deeper: belongs to the item just emitted, as a nested list.
      const nested = parseList(lines, i, depth + 1);
      const owner = items[items.length - 1];
      if (owner !== undefined && depth + 1 < MARKDOWN_BLOCK_LIMITS.listDepth) {
        owner.blocks = [...(owner.blocks ?? []), nested.block];
      }
      i = nested.next;
      continue;
    }
    items.push({ inline: (ordered ? match[3] : match[3])!.trim() });
    i += 1;
  }

  const block: MarkdownBlock = ordered
    ? { type: "list", ordered: true, start: startNumber, items }
    : { type: "list", ordered: false, items };
  return { block, next: i };
}

// ── renderers: two consumers of the tree, never the definition of it ────────────────

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** Build a DOM fragment. Every node is constructed; innerHTML is never touched. */
export function markdownBlocksFragment(source: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const block of parseMarkdownBlocks(source)) fragment.appendChild(blockElement(block, doc));
  return fragment;
}

function blockElement(block: MarkdownBlock, doc: Document): Node {
  switch (block.type) {
    case "heading": {
      const el = doc.createElement(HEADING_TAGS[Math.min(block.level, 6) - 1] ?? "h6");
      el.className = "dsx-md-heading";
      el.appendChild(markdownFragment(block.inline));
      return el;
    }
    case "code": {
      const pre = doc.createElement("pre");
      pre.className = "dsx-md-code";
      const code = doc.createElement("code");
      if (block.language.length > 0) code.className = `language-${block.language}`;
      // The syntax tint (prose.ts) is presentation over the SAME bytes: every token is
      // written through textContent/createTextNode, never innerHTML, and the token
      // texts concatenate back to the exact sample. An unknown language is one plain
      // token, so the untinted path stays byte-identical to the pre-tint renderer.
      for (const token of tokenizeCode(block.language, block.text)) {
        if (token.kind === "plain") {
          code.appendChild(doc.createTextNode(token.text));
        } else {
          const span = doc.createElement("span");
          span.className = `dsx-tok-${token.kind}`;
          span.textContent = token.text;
          code.appendChild(span);
        }
      }
      pre.appendChild(code);
      return pre;
    }
    case "quote": {
      const el = doc.createElement("blockquote");
      el.className = "dsx-md-quote";
      for (const inner of block.blocks) el.appendChild(blockElement(inner, doc));
      return el;
    }
    case "rule": {
      const el = doc.createElement("hr");
      el.className = "dsx-md-rule";
      return el;
    }
    case "image": {
      const el = doc.createElement("img");
      el.className = "dsx-md-image";
      el.setAttribute("src", admitSrc(el, block.src));
      el.setAttribute("alt", block.alt);
      el.setAttribute("loading", "lazy");
      return el;
    }
    case "list": {
      const el = doc.createElement(block.ordered ? "ol" : "ul");
      el.className = "dsx-md-list";
      if (block.ordered && block.start !== undefined && block.start !== 1) {
        el.setAttribute("start", String(block.start));
      }
      for (const item of block.items) {
        const li = doc.createElement("li");
        li.appendChild(markdownFragment(item.inline));
        for (const inner of item.blocks ?? []) li.appendChild(blockElement(inner, doc));
        el.appendChild(li);
      }
      return el;
    }
    case "table": {
      // The wrap div is the card AND the scroll container (prose.ts): a wide table
      // scrolls inside its own overflow-x box instead of stretching the page.
      const wrap = doc.createElement("div");
      wrap.className = "dsx-md-table-wrap";
      const table = doc.createElement("table");
      table.className = "dsx-md-table";
      const thead = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      for (const cell of block.header) {
        const th = doc.createElement("th");
        th.appendChild(markdownFragment(cell));
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = doc.createElement("tbody");
      for (const row of block.rows) {
        const tr = doc.createElement("tr");
        for (const cell of row) {
          const td = doc.createElement("td");
          td.appendChild(markdownFragment(cell));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      return wrap;
    }
    default: {
      const el = doc.createElement("p");
      el.className = "dsx-md-paragraph";
      el.appendChild(markdownFragment(block.inline));
      return el;
    }
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The SSR twin. Every run is escaped, so the same document renders identically and
 *  inertly on the server. */
export function markdownBlocksHtml(source: string): string {
  return parseMarkdownBlocks(source).map(blockHtml).join("");
}

function blockHtml(block: MarkdownBlock): string {
  switch (block.type) {
    case "heading": {
      const tag = HEADING_TAGS[Math.min(block.level, 6) - 1] ?? "h6";
      return `<${tag} class="dsx-md-heading">${markdownHtml(block.inline)}</${tag}>`;
    }
    case "code": {
      const cls = block.language.length > 0 ? ` class="language-${escapeAttribute(block.language)}"` : "";
      // The same tint the DOM consumer paints, escaped run by run — the two renderers
      // share one tokenizer so the adopted DOM and this string stay congruent.
      const body = tokenizeCode(block.language, block.text)
        .map((token) => token.kind === "plain"
          ? escapeText(token.text)
          : `<span class="dsx-tok-${token.kind}">${escapeText(token.text)}</span>`)
        .join("");
      return `<pre class="dsx-md-code"><code${cls}>${body}</code></pre>`;
    }
    case "quote":
      return `<blockquote class="dsx-md-quote">${block.blocks.map(blockHtml).join("")}</blockquote>`;
    case "rule":
      return `<hr class="dsx-md-rule">`;
    case "image":
      return `<img class="dsx-md-image" src="${escapeAttribute(block.src)}" alt="${escapeAttribute(block.alt)}" loading="lazy">`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const start = block.ordered && block.start !== undefined && block.start !== 1
        ? ` start="${block.start}"` : "";
      const items = block.items
        .map((item) => `<li>${markdownHtml(item.inline)}${(item.blocks ?? []).map(blockHtml).join("")}</li>`)
        .join("");
      return `<${tag} class="dsx-md-list"${start}>${items}</${tag}>`;
    }
    case "table": {
      const head = block.header.map((c) => `<th>${markdownHtml(c)}</th>`).join("");
      const body = block.rows
        .map((row) => `<tr>${row.map((c) => `<td>${markdownHtml(c)}</td>`).join("")}</tr>`)
        .join("");
      return `<div class="dsx-md-table-wrap"><table class="dsx-md-table">`
        + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
    default:
      return `<p class="dsx-md-paragraph">${markdownHtml(block.inline)}</p>`;
  }
}
