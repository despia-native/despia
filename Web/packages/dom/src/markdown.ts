//
//  markdown.ts - the `<text markdown="true">` inline twin.
//
//  The native reference is `Text(AttributedString(markdown: raw))` (Text.swift:16-17).
//  SwiftUI's Text renders the INLINE intents of that attributed string — emphasis,
//  strong emphasis, code, strikethrough, links — and collapses block-level intents
//  (headings/lists/quotes keep their literal run of text; they do not become blocks).
//  This module implements exactly that inline vocabulary, so the same authored string
//  reads the same on iOS and in the browser.
//
//  SAFETY: the parser NEVER touches innerHTML. The DOM sink emits nodes it constructs
//  itself and the SSR sink escapes every run, so authored or BOUND markdown is
//  structurally incapable of injecting markup, script or event handlers. Link targets
//  ride an http/https/mailto/tel/relative allowlist, and the whole pass is bounded
//  (input length, node count, nesting depth) so a hostile string cannot allocate
//  without limit.
//
//  Byte law (/web/13): this module is imported by elements.ts but referenced ONLY
//  inside the `__DSX_OPTIONAL_MARKDOWN__` fold, so an embed slice that authors no
//  `markdown=` tree-shakes the whole file away — the base <text> path is
//  byte-identical to before.
//

/** Hostile-input ceilings. A markdown string is authored OR bound data; none of these
 *  bounds is reachable by real copy, and each one caps a different allocation axis. */
export const MARKDOWN_LIMITS = {
  /** characters examined; the remainder renders as plain text */
  characters: 16_384,
  /** emitted inline elements (text runs are not counted) */
  nodes: 512,
  /** nested emphasis depth before further markers render literally */
  depth: 8,
} as const;

const SAFE_LINK_SCHEME = /^(?:https?:|mailto:|tel:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The link allowlist: absolute http(s)/mailto/tel, or a relative/same-document target.
 *  Anything else (javascript:, data:, vbscript:, an unknown scheme, a protocol-relative
 *  origin) is refused and the label renders as plain text — never a live navigation the
 *  author did not write. */
export function safeMarkdownHref(raw: string): string | null {
  const href = raw.trim();
  if (href.length === 0 || href.length > 2_048) return null;
  if (CONTROL_CHARS.test(href)) return null;
  if (SAFE_LINK_SCHEME.test(href)) return href;
  if (ANY_SCHEME.test(href)) return null;
  if (href.startsWith("//")) return null; // protocol-relative — an absolute origin in disguise
  return href;
}


/** The parser is renderer-agnostic: it drives a SINK, so the DOM twin and the SSR
 *  string twin are the same grammar by construction (one parser, two emitters — the
 *  house rule that keeps first paint and hydration identical). */
export type MarkdownSink = {
  text(value: string): void;
  open(tag: "strong" | "em" | "del" | "code" | "a", href?: string): void;
  close(): void;
};

type Marker = { readonly token: string; readonly tag: "strong" | "em" | "del" };

// Longest-first so `**` wins over `*` and `~~` over a stray `~`.
const MARKERS: readonly Marker[] = [
  { token: "**", tag: "strong" },
  { token: "__", tag: "strong" },
  { token: "~~", tag: "del" },
  { token: "*", tag: "em" },
  { token: "_", tag: "em" },
];

/** Scan `source` from `start` into `sink` until `closer` (or the end). Returns the
 *  index just past the closer, or -1 when the closer was never found — the caller then
 *  emits its own opening marker literally, exactly like CommonMark. */
function scan(
  source: string,
  start: number,
  sink: MarkdownSink,
  closer: string | null,
  depth: number,
  budget: { nodes: number },
): number {
  let i = start;
  let literal = "";
  const flush = (): void => {
    if (literal.length === 0) return;
    sink.text(literal);
    literal = "";
  };
  while (i < source.length) {
    const ch = source[i]!;

    if (ch === "\\" && i + 1 < source.length) {
      // A backslash escape makes the next character literal — the one way an author
      // writes a real asterisk or bracket inside markdown copy.
      literal += source[i + 1]!;
      i += 2;
      continue;
    }

    if (closer !== null && source.startsWith(closer, i)) {
      flush();
      return i + closer.length;
    }

    if (ch === "`" && budget.nodes > 0) {
      const end = source.indexOf("`", i + 1);
      if (end !== -1) {
        budget.nodes -= 1;
        flush();
        sink.open("code");
        sink.text(source.slice(i + 1, end));
        sink.close();
        i = end + 1;
        continue;
      }
    }

    if (ch === "[" && budget.nodes > 0 && depth < MARKDOWN_LIMITS.depth) {
      const close = source.indexOf("]", i + 1);
      if (close !== -1 && source[close + 1] === "(") {
        const paren = source.indexOf(")", close + 2);
        if (paren !== -1) {
          const href = safeMarkdownHref(source.slice(close + 2, paren));
          if (href !== null) {
            budget.nodes -= 1;
            flush();
            sink.open("a", href);
            scan(source, i + 1, sink, "]", depth + 1, budget);
            sink.close();
            i = paren + 1;
            continue;
          }
        }
      }
    }

    if (depth < MARKDOWN_LIMITS.depth && budget.nodes > 0) {
      const marker = MARKERS.find((m) => source.startsWith(m.token, i));
      // An emphasis run needs content: a marker immediately followed by its own closer
      // is literal text, matching CommonMark (and AttributedString) over an empty tag.
      if (marker !== undefined && !source.startsWith(marker.token, i + marker.token.length)) {
        // Look ahead on a THROWAWAY sink first: an unterminated run must render as
        // literal text, and nothing may have been emitted for it.
        const spent = budget.nodes;
        const end = scan(source, i + marker.token.length, NULL_SINK, marker.token, depth + 1, { nodes: spent });
        if (end !== -1) {
          budget.nodes = spent - 1;
          flush();
          sink.open(marker.tag);
          scan(source, i + marker.token.length, sink, marker.token, depth + 1, budget);
          sink.close();
          i = end;
          continue;
        }
        literal += marker.token;
        i += marker.token.length;
        continue;
      }
    }

    literal += ch;
    i += 1;
  }
  flush();
  return closer === null ? i : -1;
}

const NULL_SINK: MarkdownSink = { text() {}, open() {}, close() {} };

/** Drive `sink` over the inline markdown of `source`. */
export function parseMarkdown(source: string, sink: MarkdownSink): void {
  const bounded = source.length > MARKDOWN_LIMITS.characters
    ? source.slice(0, MARKDOWN_LIMITS.characters)
    : source;
  scan(bounded, 0, sink, null, 0, { nodes: MARKDOWN_LIMITS.nodes });
  if (bounded.length < source.length) sink.text(source.slice(bounded.length));
}

/** Render the inline markdown subset of `source` into a fresh DOM fragment. */
export function markdownFragment(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  buildMarkdownInto(fragment, source);
  return fragment;
}

/** Build the inline markdown of `source` as children of `root` (no fragment hop). */
function buildMarkdownInto(root: Node, source: string): void {
  const stack: Node[] = [root];
  parseMarkdown(source, {
    text(value) {
      const parent = stack[stack.length - 1]!;
      const last = parent.lastChild;
      if (last !== null && last.nodeType === 3) last.textContent = `${last.textContent ?? ""}${value}`;
      else parent.appendChild(document.createTextNode(value));
    },
    open(tag, href) {
      const node = document.createElement(tag);
      if (tag === "a" && href !== undefined) {
        node.setAttribute("href", href);
        node.setAttribute("data-dsx-part", "link");
        node.setAttribute("rel", "noopener noreferrer");
      }
      stack[stack.length - 1]!.appendChild(node);
      stack.push(node);
    },
    close() { if (stack.length > 1) stack.pop(); },
  });
}

/** Replace `host`'s children with the rendered markdown of `source`. */
export function renderMarkdown(host: HTMLElement, source: string): void {
  host.replaceChildren();
  buildMarkdownInto(host, source);
}

function escapeMarkdownHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The SSR twin: the SAME parse, emitted as escaped HTML. Used by @despia/server so a
 *  `markdown=` text paints on first render and the adopt walk sees identical DOM. */
export function markdownHtml(source: string): string {
  const out: string[] = [];
  const open: string[] = [];
  parseMarkdown(source, {
    text(value) { out.push(escapeMarkdownHtml(value)); },
    open(tag, href) {
      out.push(tag === "a" && href !== undefined
        ? `<a href="${escapeMarkdownHtml(href)}" data-dsx-part="link" rel="noopener noreferrer">`
        : `<${tag}>`);
      open.push(tag);
    },
    close() {
      const tag = open.pop();
      if (tag !== undefined) out.push(`</${tag}>`);
    },
  });
  while (open.length > 0) out.push(`</${open.pop()!}>`);
  return out.join("");
}
