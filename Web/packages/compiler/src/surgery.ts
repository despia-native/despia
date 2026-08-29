//
//  surgery.ts — the DSX side of the visual editor, and the reason the editor can be trusted.
//
//  THE MANDATE (platform/00-vision.md M4): the `.dsx` file is the single source of truth, the
//  visual is a projection of it, and an edit made visually produces clean DSX. Never a JSON blob
//  beside the code, never a runtime shaped around an editor.
//
//  THE MOVE, and it is the same one `cli/src/cfg.ts` makes for action bodies: an edit does not
//  re-print the tree. It SPLICES the author's own bytes. Every node and every attribute carries
//  a span into the source (xml.ts), so changing one attribute rewrites exactly that attribute's
//  range and leaves every other byte alone - comments, blank lines, attribute order, quote style,
//  indentation, the lot.
//
//  WHY THAT IS THE WHOLE BALLGAME. A serializer that re-prints has to model every construct it
//  might meet, and the day it meets one it does not model, it drops it. That is how an editor
//  eats a file: the author opens their document, moves a button, saves, and their `<api>` block
//  is gone. `edit.ts` refused to ship a visual save for exactly this reason and made a textarea
//  the save authority instead. Splicing inverts the risk: an edit this module cannot express is
//  REFUSED, and an edit it can express cannot disturb anything it did not name. The worst case
//  is "the editor would not let me do that", never "the editor deleted my work".
//
//  It is also what makes a visual pull request honest. The diff a reviewer sees is a real diff of
//  real DSX - a one-attribute change is a one-line diff, not a whole-file reformat that buries
//  the change nobody can then review.
//

import { parseDsx, type XmlNode, type XmlSpan } from "./xml.ts";

export class SurgeryError extends Error {}

/** A node's location in the tree: the child index at each level from the root down. */
export type NodePath = readonly number[];

/**
 * The edits the visual editor can express. Deliberately a CLOSED set: each one is a byte range
 * this module can compute exactly. A gesture with no entry here is refused rather than
 * approximated, which is the trade that keeps a save lossless.
 */
export type Edit =
  /** change an attribute's value, or add it when absent */
  | { kind: "setAttribute"; path: NodePath; name: string; value: string }
  /** remove an attribute entirely, whitespace and all */
  | { kind: "removeAttribute"; path: NodePath; name: string }
  /** replace a code-tag / text body, leaving the tags untouched */
  | { kind: "setText"; path: NodePath; text: string }
  /** delete an element and the whitespace run that preceded it on its own line */
  | { kind: "removeNode"; path: NodePath }
  /** move an element to a new index among its CURRENT siblings (a reorder, not a reparent) */
  /** Same-parent: `toIndex` is the target POSITION among the current siblings.
   *  With `toParent` (P5 cross-container drag): `toIndex` is an INSERTION SLOT
   *  (0..children.length) in the target parent - including the source parent itself,
   *  so one spelling serves every drop and the caller never mixes semantics. */
  | { kind: "moveNode"; path: NodePath; toIndex: number; toParent?: NodePath }
  /** insert raw DSX as a child at `index`, matching the surrounding indentation */
  | { kind: "insertNode"; path: NodePath; index: number; markup: string }
  /**
   * Set ONE property inside a compound `style="…"` value, or remove it with `null`.
   *
   * The inspector's main job, and the reason it is its own edit rather than a `setAttribute`
   * with a re-serialised string: rebuilding the whole declaration list would reorder the
   * author's properties and normalise their spacing on every colour tweak. This rewrites the
   * one declaration's value and leaves the rest of the string exactly as typed.
   */
  | { kind: "setStyleProperty"; path: NodePath; property: string; value: string | null }
  /** change an element's tag, rewriting BOTH tags of a pair */
  | { kind: "renameTag"; path: NodePath; tag: string }
  /** copy an element and place the copy directly after it */
  | { kind: "duplicateNode"; path: NodePath }
  /** put an element inside a new parent — the Webflow gesture */
  | { kind: "wrapNode"; path: NodePath; tag: string; attrs?: string }
  /** remove an element but keep its children in its place */
  | { kind: "unwrapNode"; path: NodePath };

/** One resolved byte replacement. Non-overlapping by construction; applied right to left. */
interface Splice { start: number; end: number; text: string }

/** Walk a path to its node, with an error that says where it broke rather than throwing on null. */
function at(root: XmlNode, path: NodePath): XmlNode {
  let node = root;
  for (const [depth, index] of path.entries()) {
    const child = node.children[index];
    if (child === undefined) {
      throw new SurgeryError(`no node at path [${path.join(", ")}] (index ${index} at depth ${depth} does not exist)`);
    }
    node = child;
  }
  return node;
}

function parentOf(root: XmlNode, path: NodePath): { parent: XmlNode; index: number } {
  if (path.length === 0) throw new SurgeryError("the root element has no parent");
  return { parent: at(root, path.slice(0, -1)), index: path[path.length - 1]! };
}

function requireSpan(node: XmlNode, what: string): XmlSpan {
  const span = node.span;
  if (span === undefined) throw new SurgeryError(`<${node.tag}> carries no source span, so ${what} cannot be located`);
  return span;
}

/**
 * The whitespace run immediately before `start`, back to (and including) the newline that begins
 * its line. Removing a node without this leaves a blank indented line behind, and inserting
 * without it puts the new element on the end of somebody else's line.
 */
function indentBefore(source: string, start: number): { from: number; indent: string } {
  let i = start;
  while (i > 0 && (source[i - 1] === " " || source[i - 1] === "\t")) i--;
  const indent = source.slice(i, start);
  if (i > 0 && source[i - 1] === "\n") return { from: i - 1, indent };
  return { from: start, indent };
}

/** The `"` or `'` an attribute was written with, so a rewrite keeps the author's quoting. */
function quoteOf(source: string, value: XmlSpan): string {
  const before = source[value.start - 1];
  return before === "'" ? "'" : '"';
}

/**
 * ATTRIBUTE VALUES ARE ENTITY-ENCODED ON THE WAY IN, and only the four characters that would
 * break the document. Encoding more (`'`, every non-ASCII) would be "safe" and would also rewrite
 * text the author can read into text they cannot, which for a value like a JSE expression makes
 * the file worse every time it is touched.
 */
function encodeAttribute(value: string, quote: string): string {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return quote === "'" ? escaped.replace(/'/g, "&apos;") : escaped.replace(/"/g, "&quot;");
}

/**
 * Find one declaration inside a `style="a: 1; b: 2"` value.
 *
 * Deliberately a scan rather than a parse-and-rebuild. The value belongs to the author and the
 * only bytes an inspector has any business touching are the ones for the property it is
 * changing. Returns the ranges of the whole declaration and of its value alone.
 */
function findDeclaration(text: string, property: string): { whole: XmlSpan; value: XmlSpan } | null {
  let at = 0;
  while (at < text.length) {
    let end = text.indexOf(";", at);
    if (end < 0) end = text.length;
    const chunk = text.slice(at, end);
    const colon = chunk.indexOf(":");
    if (colon >= 0 && chunk.slice(0, colon).trim() === property) {
      let valueStart = at + colon + 1;
      while (valueStart < end && /\s/.test(text[valueStart] ?? "")) valueStart++;
      let valueEnd = end;
      while (valueEnd > valueStart && /\s/.test(text[valueEnd - 1] ?? "")) valueEnd--;
      return { whole: { start: at, end }, value: { start: valueStart, end: valueEnd } };
    }
    at = end + 1;
  }
  return null;
}

/** Re-indent a block by `by` spaces per line, leaving its first line (already placed) alone. */
function reindent(block: string, by: number): string {
  const pad = " ".repeat(Math.abs(by));
  return block.split("\n").map((line, i) => {
    if (i === 0 || line.trim() === "") return line;
    return by > 0 ? pad + line : line.startsWith(pad) ? line.slice(pad.length) : line.replace(/^\s+/, "");
  }).join("\n");
}

function spliceFor(source: string, root: XmlNode, edit: Edit): Splice {
  switch (edit.kind) {
    case "setAttribute": {
      const node = at(root, edit.path);
      const existing = node.attrSpans?.[edit.name];
      if (existing !== undefined) {
        // Rewrite the VALUE only. The name, the equals sign, the quote style and the whitespace
        // around them are the author's and survive untouched.
        const quote = quoteOf(source, existing.value);
        return { start: existing.value.start, end: existing.value.end, text: encodeAttribute(edit.value, quote) };
      }
      // A new attribute goes immediately before the open tag's terminator, which keeps it inside
      // the tag whether that tag is `>` or `/>`.
      const open = node.openTag;
      if (open === undefined) throw new SurgeryError(`<${node.tag}> carries no open-tag span`);
      // Land it immediately after the LAST attribute, not immediately before the terminator.
      // Those differ whenever the author wrote `<tag … />`: inserting before `/>` would eat
      // their space on one document and add one on another. Walking back over the whitespace
      // and letting it follow the new attribute preserves either style exactly.
      const selfClosing = source.slice(open.end - 2, open.end) === "/>";
      let insertAt = open.end - (selfClosing ? 2 : 1);
      while (insertAt > open.start && /\s/.test(source[insertAt - 1] ?? "")) insertAt--;
      return {
        start: insertAt, end: insertAt,
        text: ` ${edit.name}="${encodeAttribute(edit.value, '"')}"`,
      };
    }
    case "removeAttribute": {
      const node = at(root, edit.path);
      const existing = node.attrSpans?.[edit.name];
      if (existing === undefined) {
        throw new SurgeryError(`<${node.tag}> has no attribute "${edit.name}" to remove`);
      }
      // Take the whitespace in front of it too, or removing the last attribute leaves `<tag  />`.
      const { from } = indentBefore(source, existing.whole.start);
      let start = existing.whole.start;
      while (start > 0 && /[ \t]/.test(source[start - 1] ?? "")) start--;
      // Keep the line break when the attribute sat on its own line; drop only the spaces.
      return { start: from === start - 1 ? start : start, end: existing.whole.end, text: "" };
    }
    case "setText": {
      const node = at(root, edit.path);
      if (node.textSpan === undefined) {
        throw new SurgeryError(`<${node.tag}> has no text body to set (it is not a code tag or text element)`);
      }
      return { start: node.textSpan.start, end: node.textSpan.end, text: edit.text };
    }
    case "removeNode": {
      const node = at(root, edit.path);
      const span = requireSpan(node, "the removal");
      const { from } = indentBefore(source, span.start);
      return { start: from, end: span.end, text: "" };
    }
    case "insertNode": {
      const node = at(root, edit.path);
      const open = node.openTag;
      const span = requireSpan(node, "the insertion");
      if (open === undefined) throw new SurgeryError(`<${node.tag}> carries no open-tag span`);
      if (source.slice(open.end - 2, open.end) === "/>") {
        // Inserting a child into `<tag/>` means giving it a body, which rewrites the tag itself.
        // Refused rather than guessed: the editor should expand the element first, visibly.
        throw new SurgeryError(`<${node.tag}> is self-closing — expand it to a paired tag before adding children`);
      }
      const count = node.children.length;
      if (edit.index < 0 || edit.index > count) {
        throw new SurgeryError(`cannot insert at index ${edit.index} of <${node.tag}> (it has ${count} child(ren))`);
      }
      const anchor = edit.index === count
        ? { point: findCloseTagStart(source, node, span), indent: childIndent(source, node) }
        : { point: indentBefore(source, requireSpan(node.children[edit.index]!, "the insertion").start).from + 1,
            indent: indentBefore(source, requireSpan(node.children[edit.index]!, "the insertion").start).indent };
      return { start: anchor.point, end: anchor.point, text: `${anchor.indent}${edit.markup}\n` };
    }
    case "setStyleProperty": {
      const node = at(root, edit.path);
      const style = node.attrSpans?.["style"];
      if (style === undefined) {
        if (edit.value === null) throw new SurgeryError(`<${node.tag}> has no style attribute`);
        // No style yet: this reduces to adding the attribute, which setAttribute already knows
        // how to place inside the tag.
        return spliceFor(source, root, {
          kind: "setAttribute", path: edit.path, name: "style", value: `${edit.property}: ${edit.value}`,
        });
      }
      const text = source.slice(style.value.start, style.value.end);
      const found = findDeclaration(text, edit.property);
      if (found === null) {
        if (edit.value === null) {
          throw new SurgeryError(`<${node.tag}> style has no "${edit.property}" to remove`);
        }
        // Append, matching whether the author separates with "; " or ";".
        const trimmed = text.trimEnd();
        const separator = trimmed.endsWith(";") ? " " : "; ";
        const point = style.value.start + trimmed.length;
        return { start: point, end: point, text: `${separator}${edit.property}: ${edit.value}` };
      }
      if (edit.value === null) {
        // Take the TRAILING separator, not the leading whitespace: removing both would close up
        // the gap between the declarations either side and quietly restyle the author's string.
        let start = style.value.start + found.whole.start;
        while (start < style.value.end && /\s/.test(source[start] ?? "")) start++;
        let end = style.value.start + found.whole.end;
        while (end < style.value.end && /[;\s]/.test(source[end] ?? "")) end++;
        // A removal at the very end leaves a dangling `; ` behind it instead; pull that back.
        if (end >= style.value.end) {
          while (start > style.value.start && /[;\s]/.test(source[start - 1] ?? "")) start--;
        }
        return { start, end, text: "" };
      }
      return {
        start: style.value.start + found.value.start,
        end: style.value.start + found.value.end,
        text: edit.value,
      };
    }
    case "renameTag": {
      throw new SurgeryError("renameTag is resolved by applyEdits, not spliceFor");
    }
    case "duplicateNode": {
      const node = at(root, edit.path);
      const span = requireSpan(node, "the duplicate");
      const { indent } = indentBefore(source, span.start);
      // The copy is the ORIGINAL bytes, so a duplicated subtree keeps its comments and its
      // formatting rather than being re-printed into something the author did not write.
      return { start: span.end, end: span.end, text: `\n${indent}${source.slice(span.start, span.end)}` };
    }
    case "wrapNode": {
      const node = at(root, edit.path);
      const span = requireSpan(node, "the wrap");
      const { indent } = indentBefore(source, span.start);
      const inner = reindent(source.slice(span.start, span.end), 2);
      const attrs = edit.attrs === undefined || edit.attrs === "" ? "" : ` ${edit.attrs}`;
      // The wrapped subtree IS re-indented, and that is part of the edit rather than collateral:
      // its depth changed, so its indentation is now wrong by definition. Nothing outside it moves.
      return {
        start: span.start, end: span.end,
        text: `<${edit.tag}${attrs}>\n${indent}  ${inner}\n${indent}</${edit.tag}>`,
      };
    }
    case "unwrapNode": {
      const node = at(root, edit.path);
      const span = requireSpan(node, "the unwrap");
      if (node.children.length === 0) {
        throw new SurgeryError(`<${node.tag}> has no children to keep — remove it instead`);
      }
      const first = requireSpan(node.children[0]!, "the unwrap");
      const last = requireSpan(node.children[node.children.length - 1]!, "the unwrap");
      const kept = reindent(source.slice(first.start, last.end), -2);
      return { start: span.start, end: span.end, text: kept };
    }
    case "moveNode": {
      throw new SurgeryError("moveNode is resolved by applyEdits, not spliceFor");
    }
  }
}

/** Where `</tag>` begins, so an appended child lands before it rather than after. */
function findCloseTagStart(source: string, node: XmlNode, span: XmlSpan): number {
  const close = `</${node.tag}`;
  const index = source.lastIndexOf(close, span.end);
  if (index < 0) throw new SurgeryError(`could not locate the close tag of <${node.tag}>`);
  return indentBefore(source, index).from + 1;
}

/** The indentation this element's children use, or its own plus two spaces when it has none yet. */
function childIndent(source: string, node: XmlNode): string {
  const first = node.children[0];
  if (first?.span !== undefined) return indentBefore(source, first.span.start).indent;
  const own = indentBefore(source, node.span!.start).indent;
  return `${own}  `;
}

/**
 * A reorder, expressed as two splices: lift the element's bytes out and put them back at the new
 * position. Done as one operation rather than remove+insert so the moved text is the author's
 * ORIGINAL bytes - a moved subtree keeps its comments and its formatting exactly.
 */
function moveSplices(source: string, root: XmlNode, edit: Extract<Edit, { kind: "moveNode" }>): Splice[] {
  const { parent, index } = parentOf(root, edit.path);

  // CROSS-CONTAINER (P5b): lift the node's exact bytes and land them with insertNode's
  // own anchor discipline - close-tag anchor + child indent for the end slot, the
  // target sibling's indent otherwise - so a dropped element is indented like a typed
  // one. `toIndex` is an insertion SLOT here; a toParent naming the source parent is
  // translated to the position semantics of the plain move below.
  if (edit.toParent !== undefined) {
    const sourceParentPath = edit.path.slice(0, -1);
    const sameParent = edit.toParent.length === sourceParentPath.length
      && edit.toParent.every((seg, i) => seg === sourceParentPath[i]);
    if (sameParent) {
      const slots = parent.children.length;
      if (edit.toIndex < 0 || edit.toIndex > slots) {
        throw new SurgeryError(`cannot move to slot ${edit.toIndex} of ${slots} sibling(s)`);
      }
      const position = edit.toIndex > index ? edit.toIndex - 1 : edit.toIndex;
      return moveSplices(source, root, { kind: "moveNode", path: edit.path, toIndex: position });
    }
    const inOwnSubtree = edit.toParent.length >= edit.path.length
      && edit.path.every((seg, i) => seg === edit.toParent![i]);
    if (inOwnSubtree) throw new SurgeryError("cannot move an element into its own subtree");

    const target = at(root, edit.toParent);
    const open = target.openTag;
    const targetSpan = requireSpan(target, "the move");
    if (open === undefined) throw new SurgeryError(`<${target.tag}> carries no open-tag span`);
    if (source.slice(open.end - 2, open.end) === "/>") {
      throw new SurgeryError(`<${target.tag}> is self-closing — expand it to a paired tag before moving children into it`);
    }
    const slots = target.children.length;
    if (edit.toIndex < 0 || edit.toIndex > slots) {
      throw new SurgeryError(`cannot move to slot ${edit.toIndex} of <${target.tag}> (it has ${slots} child(ren))`);
    }
    const moving = parent.children[index]!;
    const span = requireSpan(moving, "the move");
    const lift = indentBefore(source, span.start);
    const anchor = edit.toIndex === slots
      ? { point: findCloseTagStart(source, target, targetSpan), indent: childIndent(source, target) }
      : { point: indentBefore(source, requireSpan(target.children[edit.toIndex]!, "the move").start).from + 1,
          indent: indentBefore(source, requireSpan(target.children[edit.toIndex]!, "the move").start).indent };
    return [
      { start: lift.from, end: span.end, text: "" },
      { start: anchor.point, end: anchor.point, text: `${anchor.indent}${source.slice(span.start, span.end)}\n` },
    ];
  }

  const count = parent.children.length;
  if (edit.toIndex < 0 || edit.toIndex >= count) {
    throw new SurgeryError(`cannot move to index ${edit.toIndex} of ${count} sibling(s)`);
  }
  if (edit.toIndex === index) return [];

  const moving = parent.children[index]!;
  const span = requireSpan(moving, "the move");
  const lift = indentBefore(source, span.start);
  const text = source.slice(lift.from, span.end);

  // The insertion point is computed against the ORIGINAL source, before the lift is applied.
  // Applying right-to-left below is what keeps both offsets valid.
  const target = parent.children[edit.toIndex]!;
  const targetSpan = requireSpan(target, "the move");
  const point = edit.toIndex < index
    ? indentBefore(source, targetSpan.start).from
    : targetSpan.end;

  return [
    { start: lift.from, end: span.end, text: "" },
    { start: point, end: point, text },
  ];
}

/**
 * Renaming an element rewrites the tag NAME in both tags and nothing else, so every attribute,
 * every child and the whitespace between them survive. A self-closing element has one tag to
 * rewrite; a paired one has two.
 */
function renameSplices(source: string, root: XmlNode, edit: Extract<Edit, { kind: "renameTag" }>): Splice[] {
  const node = at(root, edit.path);
  const span = requireSpan(node, "the rename");
  const open = node.openTag;
  if (open === undefined) throw new SurgeryError(`<${node.tag}> carries no open-tag span`);
  if (!/^[A-Za-z_][\w.:-]*$/.test(edit.tag)) throw new SurgeryError(`"${edit.tag}" is not a tag name`);

  const splices: Splice[] = [
    { start: open.start + 1, end: open.start + 1 + node.tag.length, text: edit.tag },
  ];
  if (source.slice(open.end - 2, open.end) !== "/>") {
    const closeStart = source.lastIndexOf(`</${node.tag}`, span.end);
    if (closeStart < 0) throw new SurgeryError(`could not locate the close tag of <${node.tag}>`);
    splices.push({ start: closeStart + 2, end: closeStart + 2 + node.tag.length, text: edit.tag });
  }
  return splices;
}

export interface SurgeryResult {
  /** the edited document */
  source: string;
  /** the byte ranges of the ORIGINAL document that were replaced, for a precise diff view */
  touched: readonly XmlSpan[];
}

/**
 * Apply edits to a document, returning its new bytes.
 *
 * Every edit's span is computed against the ORIGINAL source and the splices are applied from the
 * end backwards, so no edit shifts another's offsets. Overlapping edits are refused: two changes
 * to one range have no defined result, and picking one silently is how an editor loses half of
 * what a user just did.
 *
 * With no edits this returns the input unchanged, byte for byte. That is not a special case, it
 * is the identity of the whole design, and the corpus asserts it over every `.dsx` in the tree.
 */
export function applyEdits(source: string, edits: readonly Edit[]): SurgeryResult {
  if (edits.length === 0) return { source, touched: [] };
  const root = parseDsx(source);

  const splices: Splice[] = [];
  for (const edit of edits) {
    if (edit.kind === "moveNode") splices.push(...moveSplices(source, root, edit));
    else if (edit.kind === "renameTag") splices.push(...renameSplices(source, root, edit));
    else splices.push(spliceFor(source, root, edit));
  }

  const ordered = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.start < previous.end) {
      throw new SurgeryError(
        `two edits touch the same bytes (${previous.start}..${previous.end} and ${current.start}..${current.end}) — apply them one at a time`,
      );
    }
  }

  let out = source;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const splice = ordered[i]!;
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  }
  return { source: out, touched: ordered.map((s) => ({ start: s.start, end: s.end })) };
}

/**
 * The editor's read model: the tree, with every node addressable by the path `applyEdits` takes.
 *
 * Returned as a projection rather than a stored document, which is the M4 rule in one function:
 * open the file, project it, edit the projection, splice the file. Nothing persists between those
 * steps that could drift from the bytes on disk.
 */
export interface TreeNode {
  tag: string;
  path: NodePath;
  attrs: { readonly [name: string]: string };
  children: TreeNode[];
  /** the exact source of this element, for a code view that shows what is really there */
  source: string;
  /** true when the element has a raw body (a code tag) rather than child elements */
  code: boolean;
}

/**
 * One row of the tree panel. FLAT, with a depth, rather than a nested render.
 *
 * A nested component that renders itself is the obvious shape and the wrong one here. The
 * editor has to stay usable on a document with thousands of elements (the vision's own bar is a
 * fifty-thousand-line pull request), and a flat row list is what can be windowed: render the
 * hundred rows in view, not the whole tree. It is also what makes keyboard navigation a matter
 * of moving an index instead of walking a structure.
 */
export interface TreeRow {
  path: NodePath;
  /** the parent's path, so a client can collapse a subtree without re-deriving the tree */
  parent: NodePath | null;
  tag: string;
  depth: number;
  hasChildren: boolean;
  /**
   * What to show beside the tag. The FIRST identifying attribute the element actually carries,
   * in the order a person would look for one - never a generated name. This is the M3 rule
   * applied to the tree itself: a row reads `text "Hello"`, never `text-block-14`.
   */
  label: string;
  /**
   * The element's identity the way a stylesheet would say it: the first STATIC class token
   * (`hero` for `stack.hero`). An interpolated class is a computed fact, not an identity,
   * so it never lands here — the row's fx mark covers that case.
   */
  klass: string;
  /** true when the label is a bound expression rather than literal text — the tree shows fx */
  bound: boolean;
  /**
   * True when the element carries a `visible-if` condition. The tree wears an eye on such a
   * row: the element is conditionally shown, so the layer list is honest about the fact that
   * what you see rendered may not be everything the file declares. This is the STATIC fact
   * only — whether the condition is currently true belongs to the live snapshot, not the file.
   */
  visibleIf: boolean;
  /**
   * The WORDS this element puts on screen, and the attribute holding them. Distinct from
   * `label`, which answers "how do I recognise this row" and may be an `as` name, a binding
   * or a src path. This answers "what does a reader of the app see here", which is what a
   * copy pass, a translation pass and a reading-level pass all need — and without it every
   * consumer re-parses the document to find out. Empty when the element shows no literal
   * text (a bound value is a computed fact, never copy someone can edit here).
   */
  text: string;
  textAttr: string;
}

/** The attributes worth showing in a tree row, most identifying first. */
const LABEL_ATTRS = ["as", "label", "title", "value", "name", "bind", "src", "path", "icon"];

/** The attributes that carry LITERAL WORDS, in the order an element uses them. */
const TEXT_ATTRS = ["value", "label", "title", "subtitle", "placeholder", "caption", "hint", "text"];

/**
 * Flatten a document into tree rows. Every row carries the path `applyEdits` takes, so a click
 * in the tree and an edit to the file are the same address.
 */
export function flattenTree(source: string): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number, parent: NodePath | null): void => {
    const named = LABEL_ATTRS.map((name) => node.attrs[name]).find((v) => v !== undefined && v !== "");
    const textAttr = TEXT_ATTRS.find((name) => {
      const value = node.attrs[name];
      return value !== undefined && value !== "" && !value.includes("{{");
    }) ?? "";
    const klass = (node.attrs["class"] ?? "").split(/\s+/).find((c) => c !== "" && !c.includes("{")) ?? "";
    rows.push({
      path: node.path,
      parent,
      tag: node.tag,
      depth,
      hasChildren: node.children.length > 0,
      label: named ?? "",
      klass,
      bound: (named ?? "").includes("{{"),
      visibleIf: node.attrs["visible-if"] !== undefined,
      text: textAttr === "" ? "" : node.attrs[textAttr] ?? "",
      textAttr,
    });
    for (const child of node.children) walk(child, depth + 1, node.path);
  };
  walk(projectTree(source), 0, null);
  return rows;
}

export function projectTree(source: string): TreeNode {
  const walk = (node: XmlNode, path: NodePath): TreeNode => ({
    tag: node.tag,
    path,
    attrs: node.attrs,
    children: node.children.map((child, i) => walk(child, [...path, i])),
    source: node.span === undefined ? "" : source.slice(node.span.start, node.span.end),
    code: node.textSpan !== undefined && node.children.length === 0,
  });
  return walk(parseDsx(source), []);
}
