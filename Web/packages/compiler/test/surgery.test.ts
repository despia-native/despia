//
//  surgery.test.ts — the DSX-to-visual-to-DSX engine, which the vision calls the heart of the
//  whole thing (platform/00-vision.md M4).
//
//  TWO PROPERTIES, and the product rests on both.
//
//  1. IDENTITY. Parsing a document and applying no edits returns the same bytes. Asserted over
//     every `.dsx` in this repository rather than over samples, because the failure this guards
//     is "the editor reformatted my file", and the file it reformats will be the one nobody
//     wrote a sample for.
//
//  2. SURGICAL CHANGE. One edit changes one range. Everything else - comments, blank lines,
//     attribute order, quote style, indentation, the `<api>` block the editor does not model -
//     comes back untouched. That is what makes a visual pull request reviewable: a
//     one-attribute change is a one-line diff.
//
//  The refusals matter as much as the edits. An editor that cannot express a gesture must say
//  so; an editor that approximates it silently is one that eats files, and that is precisely why
//  `cli/src/edit.ts` never shipped a visual save.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Three tests below exercise the surgeon on REAL closed documents. An open drop skips
// those LOUDLY (the component-fold-conformance rule); everything else here runs anywhere.
function skipWithoutClosedSource(t: { skip(msg: string): void }): boolean {
  if (existsSync(join(repoRoot(), "ClosedSource"))) return false;
  t.skip("open drop without ClosedSource - the real documents under test ship closed");
  return true;
}

import { applyEdits, flattenTree, projectTree, SurgeryError, type Edit } from "../src/surgery.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname);
  for (;;) {
    // The conformance tree is the root marker every sibling suite uses: present in the
    // full repo AND in an open drop (CLAUDE.md is not part of the drop).
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

// The repository's AUTHORED corpus. Build output is not the repository: a machine that has run
// an Xcode build carries ClosedSource/build/DerivedData, and one checkout in there (GRDB.swift)
// contains a self-referential symlink that made statSync throw ELOOP after ~30 levels - so this
// suite passed on clean CI and died on every developer box that had built the app once. lstat,
// never stat, so a symlinked directory is skipped rather than followed into a cycle.
const NOT_SOURCE = new Set(["node_modules", ".git", "dist", "build", "DerivedData", ".gradle", "Pods"]);
function everyDsx(from: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (NOT_SOURCE.has(name)) continue;
      const full = join(dir, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(full);
      else if (name.endsWith(".dsx")) out.push(full);
    }
  };
  walk(from);
  return out;
}

// ── 1 · identity ──────────────────────────────────────────────────────────────────────────

test("no edits returns the document byte for byte, across every .dsx in the repository", () => {
  const files = everyDsx(repoRoot());
  // The size floors pin the FULL repo's corpus so a glob regression cannot hollow this
  // test out silently; an open drop walks its own (smaller) tree with the same law.
  const fullRepo = existsSync(join(repoRoot(), "ClosedSource"));
  assert.ok(files.length > (fullRepo ? 100 : 20), `expected the repo's real corpus, found ${files.length} documents`);
  let bytes = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    bytes += source.length;
    assert.equal(applyEdits(source, []).source, source, `identity lost: ${file}`);
  }
  assert.ok(bytes > (fullRepo ? 300_000 : 60_000), `expected a substantial corpus, walked ${bytes} bytes`);
});

test("every element in every document round-trips through its own recorded span", () => {
  // A span that is off by one is invisible in the identity test (nothing is spliced) and fatal
  // the first time somebody edits. This walks the tree and re-parses each node's own slice.
  const files = everyDsx(repoRoot());
  let nodes = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const walk = (node: ReturnType<typeof projectTree>): void => {
      nodes++;
      assert.ok(node.source.startsWith(`<${node.tag}`), `span does not start at the tag: ${file} <${node.tag}>`);
      assert.ok(
        node.source.endsWith(`</${node.tag}>`) || node.source.endsWith("/>"),
        `span does not end at the close: ${file} <${node.tag}>`,
      );
      node.children.forEach(walk);
    };
    walk(projectTree(source));
  }
  // Same full-repo/open-drop split as the identity test above.
  const nodeFloor = existsSync(join(repoRoot(), "ClosedSource")) ? 1000 : 300;
  assert.ok(nodes > nodeFloor, `expected a real corpus (> ${nodeFloor} nodes), walked ${nodes}`);
});

// ── 2 · surgical change ───────────────────────────────────────────────────────────────────

const DOC = `<!-- a comment the editor must not touch -->
<stack grow="true" style="gap: 1rem">
  <head>
    <variable as="count">return 0</variable>
    <api as="rows" url="/rows"/>
  </head>

  <text value="Hello"   style="color: secondary"/>
  <button label='Press' on:tap="count = count + 1"/>
</stack>
`;

/** What actually changed, as a plain before/after of the differing region. */
function diff(before: string, after: string): { from: number; removed: string; added: string } {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;
  return {
    from: head,
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail),
  };
}

test("setAttribute rewrites the value and nothing else", () => {
  const edit: Edit = { kind: "setAttribute", path: [1], name: "value", value: "Goodbye" };
  const { source } = applyEdits(DOC, [edit]);
  assert.deepEqual(diff(DOC, source), { from: DOC.indexOf("Hello"), removed: "Hello", added: "Goodbye" });
  // The oddities around it survive: the doubled spaces before `style`, the comment, the head.
  assert.ok(source.includes(`<text value="Goodbye"   style="color: secondary"/>`));
  assert.ok(source.startsWith("<!-- a comment the editor must not touch -->"));
});

test("setAttribute keeps the author's quote style", () => {
  const { source } = applyEdits(DOC, [{ kind: "setAttribute", path: [2], name: "label", value: "Tap" }]);
  assert.ok(source.includes(`label='Tap'`), "a single-quoted attribute stays single-quoted");
});

test("setAttribute encodes only what would break the document", () => {
  const { source } = applyEdits(DOC, [{ kind: "setAttribute", path: [1], name: "value", value: `a < b & "c"` }]);
  // `<` and `&` must be encoded; the double quote must be, inside a double-quoted value.
  assert.ok(source.includes(`value="a &lt; b &amp; &quot;c&quot;"`), source.split("\n")[7]);
  // An apostrophe is left alone in a double-quoted value: encoding it would make the file
  // harder to read for no gain.
  const withApostrophe = applyEdits(DOC, [{ kind: "setAttribute", path: [1], name: "value", value: "it's" }]);
  assert.ok(withApostrophe.source.includes(`value="it's"`));
});

test("setAttribute adds an absent attribute inside the tag", () => {
  const { source } = applyEdits(DOC, [{ kind: "setAttribute", path: [1], name: "grow", value: "width" }]);
  assert.ok(source.includes(`<text value="Hello"   style="color: secondary" grow="width"/>`), source);
});

test("removeAttribute takes its whitespace with it", () => {
  const { source } = applyEdits(DOC, [{ kind: "removeAttribute", path: [2], name: "on:tap" }]);
  assert.ok(source.includes(`<button label='Press'/>`), source.split("\n")[8]);
});

test("setText replaces a code body and leaves the tags alone", () => {
  const { source } = applyEdits(DOC, [{ kind: "setText", path: [0, 0], text: "return 42" }]);
  assert.ok(source.includes(`<variable as="count">return 42</variable>`));
  assert.equal(diff(DOC, source).removed, "0");
});

test("removeNode deletes the element and its line, not a blank line", () => {
  const { source } = applyEdits(DOC, [{ kind: "removeNode", path: [2] }]);
  assert.ok(!source.includes("Press"));
  assert.ok(!source.includes("\n\n</stack>"), "a stranded blank line was left behind");
  assert.ok(source.includes(`<text value="Hello"`), "the sibling survived");
});

test("moveNode carries the element's ORIGINAL bytes, formatting and all", () => {
  const { source } = applyEdits(DOC, [{ kind: "moveNode", path: [2], toIndex: 1 }]);
  const button = source.indexOf("<button");
  const text = source.indexOf("<text");
  assert.ok(button < text, "the button did not move above the text");
  // Its odd spacing is the author's and must survive a move.
  assert.ok(source.includes(`<text value="Hello"   style="color: secondary"/>`));
  assert.ok(source.includes(`<button label='Press' on:tap="count = count + 1"/>`));
});

test("insertNode places a child at the sibling indentation", () => {
  const { source } = applyEdits(DOC, [
    { kind: "insertNode", path: [], index: 1, markup: `<text value="Inserted"/>` },
  ]);
  assert.ok(source.includes(`\n  <text value="Inserted"/>\n  <text value="Hello"`), source);
});

test("an edit the engine cannot express is REFUSED, never approximated", () => {
  // Each of these is a way an editor could quietly do the wrong thing instead of saying no.
  assert.throws(() => applyEdits(DOC, [{ kind: "removeAttribute", path: [1], name: "nope" }]), SurgeryError);
  assert.throws(() => applyEdits(DOC, [{ kind: "setText", path: [1], text: "x" }]), SurgeryError,
    "a self-closing element has no text body");
  assert.throws(() => applyEdits(DOC, [{ kind: "insertNode", path: [1], index: 0, markup: "<text/>" }]), SurgeryError,
    "adding a child to a self-closing element must be refused, not guessed");
  assert.throws(() => applyEdits(DOC, [{ kind: "setAttribute", path: [9], name: "a", value: "b" }]), SurgeryError,
    "a path that does not exist");
  assert.throws(() => applyEdits(DOC, [{ kind: "moveNode", path: [1], toIndex: 7 }]), SurgeryError,
    "a move past the end of the siblings");
});

test("two edits to the same bytes are refused rather than one silently winning", () => {
  assert.throws(() => applyEdits(DOC, [
    { kind: "setAttribute", path: [1], name: "value", value: "one" },
    { kind: "setAttribute", path: [1], name: "value", value: "two" },
  ]), SurgeryError);
});

test("independent edits compose, and each still touches only its own range", () => {
  const { source, touched } = applyEdits(DOC, [
    { kind: "setAttribute", path: [1], name: "value", value: "Goodbye" },
    { kind: "setAttribute", path: [2], name: "label", value: "Tap" },
    { kind: "setText", path: [0, 0], text: "return 7" },
  ]);
  assert.equal(touched.length, 3);
  assert.ok(source.includes(`value="Goodbye"`));
  assert.ok(source.includes(`label='Tap'`));
  assert.ok(source.includes(`>return 7<`));
  // The untouched half of the document is still identical.
  assert.ok(source.includes(`<api as="rows" url="/rows"/>`));
  assert.ok(source.startsWith("<!-- a comment the editor must not touch -->"));
});

test("a real repository document survives an edit with only the edited line changed", (t) => {
  if (skipWithoutClosedSource(t)) return;
  // The strongest form of the claim: take a document nobody wrote for this test, change one
  // attribute, and assert that a line-by-line comparison differs in exactly one line.
  const file = join(repoRoot(), "ClosedSource/DSX/Modules/Custom/Platform/Components/Apps.dsx");
  const source = readFileSync(file, "utf8");
  const tree = projectTree(source);
  const path = tree.children.findIndex((c) => c.tag === "head") === 0 ? [1] : [0];
  const target = tree.children[path[0]!]!;
  const attr = Object.keys(target.attrs)[0];
  assert.ok(attr !== undefined, `<${target.tag}> has no attribute to edit`);

  const edited = applyEdits(source, [{ kind: "setAttribute", path, name: attr, value: "EDITED" }]).source;
  const before = source.split("\n");
  const after = edited.split("\n");
  assert.equal(before.length, after.length, "the line count moved");
  const differing = before.map((line, i) => (line === after[i] ? -1 : i)).filter((i) => i >= 0);
  assert.equal(differing.length, 1, `expected one changed line, got ${differing.length}`);
  assert.ok(after[differing[0]!]!.includes("EDITED"));
});

// ── 3 · the read model ────────────────────────────────────────────────────────────────────

test("projectTree addresses every node by the path applyEdits takes", () => {
  const tree = projectTree(DOC);
  assert.equal(tree.tag, "stack");
  assert.deepEqual(tree.path, []);
  assert.deepEqual(tree.children.map((c) => c.tag), ["head", "text", "button"]);
  assert.deepEqual(tree.children[2]!.path, [2]);
  assert.equal(tree.children[0]!.children[0]!.tag, "variable");
  assert.deepEqual(tree.children[0]!.children[0]!.path, [0, 0]);
  // The path the projection reports is the one the edit takes.
  const { source } = applyEdits(DOC, [
    { kind: "setAttribute", path: tree.children[0]!.children[0]!.path, name: "as", value: "total" },
  ]);
  assert.ok(source.includes(`<variable as="total">`));
});

test("a node's projected source is exactly its own bytes", () => {
  const tree = projectTree(DOC);
  assert.equal(tree.children[1]!.source, `<text value="Hello"   style="color: secondary"/>`);
  assert.equal(tree.children[0]!.children[0]!.source, `<variable as="count">return 0</variable>`);
  assert.equal(tree.children[0]!.children[0]!.code, true);
  assert.equal(tree.children[1]!.code, false);
});

// ── 4 · the tree panel's row model ────────────────────────────────────────────────────────

test("flattenTree gives one row per element, with the path an edit takes", () => {
  const rows = flattenTree(DOC);
  assert.deepEqual(rows.map((r) => `${" ".repeat(r.depth)}${r.tag}`), [
    "stack", " head", "  variable", "  api", " text", " button",
  ]);
  assert.deepEqual(rows[0]!.path, []);
  assert.deepEqual(rows[2]!.path, [0, 0]);
  assert.deepEqual(rows[2]!.parent, [0]);
  assert.equal(rows[0]!.hasChildren, true);
  assert.equal(rows[4]!.hasChildren, false);
});

test("a row is labelled by what the author wrote, never by a generated name", () => {
  // The M3 rule applied to the tree: `text "Hello"`, never `text-block-14`.
  const rows = flattenTree(DOC);
  assert.equal(rows.find((r) => r.tag === "text")!.label, "Hello");
  assert.equal(rows.find((r) => r.tag === "button")!.label, "Press");
  assert.equal(rows.find((r) => r.tag === "variable")!.label, "count");
  assert.equal(rows.find((r) => r.tag === "api")!.label, "rows");
  assert.equal(rows.find((r) => r.tag === "head")!.label, "", "an element with nothing to name it says nothing");
});

test("a row says when the element is conditionally visible - the static fact only", () => {
  const rows = flattenTree(`<stack>
  <text value="always"/>
  <text value="sometimes" visible-if="user.pro"/>
  <stack visible-if="has:module.push"><text value="nested"/></stack>
</stack>
`);
  assert.equal(rows.find((r) => r.label === "always")!.visibleIf, false);
  assert.equal(rows.find((r) => r.label === "sometimes")!.visibleIf, true);
  assert.equal(rows.filter((r) => r.tag === "stack")[1]!.visibleIf, true);
  // the CHILD of a conditional container carries no badge of its own - the container owns it
  assert.equal(rows.find((r) => r.label === "nested")!.visibleIf, false);
});

test("a row carries its stylesheet identity and its bound-ness", () => {
  const rows = flattenTree(`<stack class="hero {{ on ? 'lit' : '' }}">
  <text value="{{ user.name }}"/>
  <button class="cta primary" label="Go"/>
</stack>
`);
  // The first STATIC class is the identity; the interpolated token never is.
  assert.equal(rows[0]!.klass, "hero");
  assert.equal(rows[2]!.klass, "cta");
  assert.equal(rows[1]!.klass, "");
  // A bound label is marked so the tree can show fx instead of pretending it is prose.
  assert.equal(rows[1]!.bound, true);
  assert.equal(rows[2]!.bound, false);
});

test("the tree scales: a deep, wide real document flattens without recursion limits", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const file = join(repoRoot(), "ClosedSource/DSX/Modules/Custom/Demo/Components/Gallery.dsx");
  const rows = flattenTree(readFileSync(file, "utf8"));
  assert.ok(rows.length > 200, `expected a large document, got ${rows.length} rows`);
  assert.ok(Math.max(...rows.map((r) => r.depth)) > 5, "expected real nesting");
  // Every row's path resolves, which is what makes a click in the tree an address in the file.
  const source = readFileSync(file, "utf8");
  for (const row of rows.slice(0, 50)) {
    assert.doesNotThrow(() => applyEdits(source, [{ kind: "setAttribute", path: row.path, name: "data-probe", value: "1" }]));
  }
});

// ── 5 · the new gestures ──────────────────────────────────────────────────────────────────

test("setStyleProperty rewrites ONE declaration and leaves the author's string alone", () => {
  const doc = `<stack style="gap: 1rem; background: groupedBackground; padding: 8px"/>\n`;
  const { source } = applyEdits(doc, [{ kind: "setStyleProperty", path: [], property: "background", value: "fill" }]);
  assert.equal(source, `<stack style="gap: 1rem; background: fill; padding: 8px"/>\n`);
});

test("setStyleProperty appends a property the style does not have yet", () => {
  const doc = `<stack style="gap: 1rem"/>\n`;
  const { source } = applyEdits(doc, [{ kind: "setStyleProperty", path: [], property: "padding", value: "8px" }]);
  assert.equal(source, `<stack style="gap: 1rem; padding: 8px"/>\n`);
});

test("setStyleProperty creates the style attribute when there is none", () => {
  const doc = `<stack grow="true"/>\n`;
  const { source } = applyEdits(doc, [{ kind: "setStyleProperty", path: [], property: "gap", value: "4px" }]);
  assert.equal(source, `<stack grow="true" style="gap: 4px"/>\n`);
});

test("setStyleProperty with null removes the declaration and its separator", () => {
  const doc = `<stack style="gap: 1rem; background: fill; padding: 8px"/>\n`;
  const { source } = applyEdits(doc, [{ kind: "setStyleProperty", path: [], property: "background", value: null }]);
  assert.equal(source, `<stack style="gap: 1rem; padding: 8px"/>\n`);
});

test("setStyleProperty does not match a property that is a suffix of another", () => {
  // `padding` must not be found inside `padding-left`, which a naive indexOf would do.
  const doc = `<stack style="padding-left: 4px; padding: 8px"/>\n`;
  const { source } = applyEdits(doc, [{ kind: "setStyleProperty", path: [], property: "padding", value: "12px" }]);
  assert.equal(source, `<stack style="padding-left: 4px; padding: 12px"/>\n`);
});

test("renameTag rewrites both tags and touches nothing between them", () => {
  const doc = `<stack grow="true">\n  <!-- kept -->\n  <text value="hi"/>\n</stack>\n`;
  const { source } = applyEdits(doc, [{ kind: "renameTag", path: [], tag: "hstack" }]);
  assert.equal(source, `<hstack grow="true">\n  <!-- kept -->\n  <text value="hi"/>\n</hstack>\n`);
});

test("renameTag on a self-closing element rewrites the one tag", () => {
  const { source } = applyEdits(`<text value="hi"/>\n`, [{ kind: "renameTag", path: [], tag: "label" }]);
  assert.equal(source, `<label value="hi"/>\n`);
});

test("duplicateNode copies the original bytes, comments and all", () => {
  const doc = `<stack>\n  <text value="one"   style="color: secondary"/>\n</stack>\n`;
  const { source } = applyEdits(doc, [{ kind: "duplicateNode", path: [0] }]);
  assert.equal(source,
    `<stack>\n  <text value="one"   style="color: secondary"/>\n  <text value="one"   style="color: secondary"/>\n</stack>\n`);
});

test("wrapNode puts an element inside a new parent and re-indents only it", () => {
  const doc = `<stack>\n  <text value="hi"/>\n  <text value="bye"/>\n</stack>\n`;
  const { source } = applyEdits(doc, [{ kind: "wrapNode", path: [0], tag: "hstack", attrs: `grow="width"` }]);
  assert.equal(source,
    `<stack>\n  <hstack grow="width">\n    <text value="hi"/>\n  </hstack>\n  <text value="bye"/>\n</stack>\n`);
});

test("unwrapNode keeps the children and drops the container", () => {
  const doc = `<stack>\n  <hstack>\n    <text value="hi"/>\n    <text value="bye"/>\n  </hstack>\n</stack>\n`;
  const { source } = applyEdits(doc, [{ kind: "unwrapNode", path: [0] }]);
  assert.equal(source, `<stack>\n  <text value="hi"/>\n  <text value="bye"/>\n</stack>\n`);
});

test("unwrapNode refuses an element with nothing to keep", () => {
  assert.throws(() => applyEdits(`<stack>\n  <text value="x"/>\n</stack>\n`, [{ kind: "unwrapNode", path: [0] }]),
    SurgeryError, "unwrapping a leaf would be a delete wearing the wrong name");
});

// ── 6 · M6: the Studio must be able to author the Studio ──────────────────────────────────

test("M6 self-hosting: every gesture this interface needs works on the editor's OWN markup", (t) => {
  if (skipWithoutClosedSource(t)) return;
  // The acceptance test for the whole editor, the way a compiler compiling itself is the
  // acceptance test for a compiler. A gesture that only works on a sample screen and not on a
  // real one is the gap every visual tool ships with, so the corpus here is our own document.
  const file = join(repoRoot(), "ClosedSource/DSX/Modules/Custom/Editor/Components/Editor.dsx");
  const source = readFileSync(file, "utf8");
  const rows = flattenTree(source);

  // A container to restyle, a container to rename, a leaf to duplicate and wrap.
  const container = rows.find((r) => r.hasChildren && r.depth > 0 && r.tag !== "head");
  const leaf = rows.find((r) => !r.hasChildren && r.depth > 1);
  assert.ok(container !== undefined && leaf !== undefined, "the editor's own document has no editable structure");

  const gestures: { name: string; edit: Edit }[] = [
    { name: "restyle one property", edit: { kind: "setStyleProperty", path: container.path, property: "gap", value: "2rem" } },
    // Renamed to something it demonstrably is not, or the gesture is a no-op and the assertion
    // below passes for the wrong reason.
    { name: "rename a container", edit: { kind: "renameTag", path: container.path, tag: container.tag === "hstack" ? "vstack" : "hstack" } },
    { name: "duplicate a row", edit: { kind: "duplicateNode", path: leaf.path } },
    { name: "wrap a selection", edit: { kind: "wrapNode", path: leaf.path, tag: "stack" } },
    { name: "add an attribute", edit: { kind: "setAttribute", path: leaf.path, name: "a11yHidden", value: "true" } },
  ];

  for (const { name, edit } of gestures) {
    const result = applyEdits(source, [edit]);
    assert.notEqual(result.source, source, `${name}: nothing changed`);
    // The result is still a parseable DSX document — an edit that produces something the
    // compiler cannot read is worse than no edit at all.
    assert.doesNotThrow(() => flattenTree(result.source), `${name}: produced an unparseable document`);
    // And it changed ONE region, so the diff a reviewer sees is the gesture and not a reformat.
    assert.equal(result.touched.length, name === "rename a container" ? 2 : 1,
      `${name}: touched ${result.touched.length} regions`);
  }
});

test("M6 self-hosting: the whole editor's markup survives a round trip untouched", (t) => {
  if (skipWithoutClosedSource(t)) return;
  // Every Studio document, opened and saved with no edit, byte for byte.
  const dir = join(repoRoot(), "ClosedSource/DSX/Modules/Custom/Editor/Components");
  const files = readdirSync(dir).filter((n) => n.endsWith(".dsx"));
  assert.ok(files.length > 0, "the Studio has no documents");
  for (const name of files) {
    const source = readFileSync(join(dir, name), "utf8");
    assert.equal(applyEdits(source, []).source, source, `identity lost on the editor's own ${name}`);
  }
});

// ── cross-container moveNode (P5b): toParent + insertion-slot semantics ────────────────

const NESTED = `<stack>
  <hstack>
    <text value="A"/>
    <text value="B"/>
  </hstack>
  <vstack>
    <text value="C"/>
  </vstack>
  <group/>
</stack>
`;

test("moveNode with toParent lifts the exact bytes into another container, re-indented like a typed child", () => {
  const { source } = applyEdits(NESTED, [{ kind: "moveNode", path: [0, 1], toIndex: 1, toParent: [1] }]);
  assert.ok(source.includes(`  <hstack>\n    <text value="A"/>\n  </hstack>`), source);
  assert.ok(source.includes(`  <vstack>\n    <text value="C"/>\n    <text value="B"/>\n  </vstack>`), source);
});

test("moveNode with toParent lands slot 0 before the target's first child", () => {
  const { source } = applyEdits(NESTED, [{ kind: "moveNode", path: [0, 0], toIndex: 0, toParent: [1] }]);
  assert.ok(source.includes(`  <vstack>\n    <text value="A"/>\n    <text value="C"/>\n  </vstack>`), source);
});

test("moveNode with toParent naming the SOURCE parent translates slot to position", () => {
  // slot 2 among [A, B] = after B; moving A there is position 1
  const { source } = applyEdits(NESTED, [{ kind: "moveNode", path: [0, 0], toIndex: 2, toParent: [0] }]);
  assert.ok(source.includes(`  <hstack>\n    <text value="B"/>\n    <text value="A"/>\n  </hstack>`), source);
  // and the no-op slot (its own position) changes nothing, byte for byte
  const same = applyEdits(NESTED, [{ kind: "moveNode", path: [0, 0], toIndex: 0, toParent: [0] }]);
  assert.equal(same.source, NESTED);
});

test("moveNode refuses a self-closing target and its own subtree", () => {
  assert.throws(
    () => applyEdits(NESTED, [{ kind: "moveNode", path: [0, 0], toIndex: 0, toParent: [2] }]),
    /self-closing/,
  );
  assert.throws(
    () => applyEdits(NESTED, [{ kind: "moveNode", path: [0], toIndex: 0, toParent: [0, 0] }]),
    /own subtree/,
  );
});
