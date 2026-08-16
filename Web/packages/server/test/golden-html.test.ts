//
//  golden-html.test.ts — the GOLDEN-HTML render suite (/web/10 W2, Gate G2).
//
//  The other server suites assert FRAGMENTS ("the output contains aria-expanded"). That
//  catches a regression only where somebody thought to look. This suite commits the WHOLE
//  rendered document for a set of representative components and compares byte-for-byte, so
//  an unintended change to any attribute, class, wrapper or ordering surfaces as a diff in
//  review rather than as silence.
//
//  The corpus lives beside this file in `golden/` and is authored here rather than pulled
//  from ClosedSource module sources on purpose: a golden must fail when the RENDERER
//  changes, not when an unrelated package edits its markup.
//
//  Re-record after an intentional change:   DSX_GOLDEN=update npm test
//  (then read the diff — an unexplained line in it IS the finding).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderToString } from "../src/render.ts";

const goldenDir = join(import.meta.dirname, "golden");
const recording = process.env["DSX_GOLDEN"] === "update";

/** One golden = one component source. Head blocks are allowed (and used) so the render
 *  exercises real store reads rather than literal attributes only. */
const CASES: Array<[name: string, markup: string]> = [
  ["layout", `<stack>
    <head><variable as="tight">return true</variable></head>
    <hstack><text value="left"/><spacer/><text value="right"/></hstack>
    <vstack surface="raised"><divider/><scroll axis="horizontal"><text value="scrolled"/></scroll></vstack>
    <zstack><text value="under"/><text value="over" visible-if="dsx.variable.tight"/></zstack>
    <flow><text value="a"/><text value="b"/></flow>
    <toolbar position="top"><button label="Done"/></toolbar>
  </stack>`],

  ["text", `<stack>
    <head><variable as="copy">return 'Read the **docs**, run \`dsx build\`, or [ask](https://dsx.dev/help).'</variable></head>
    <text value="plain"/>
    <text markdown="true" bind="dsx.variable.copy"/>
    <text markdown="false" value="**literal**"/>
    <text value="clamped" lineLimit="2"/>
    <label value="a label"/>
  </stack>`],

  ["buttons", `<stack>
    <button label="Save"/>
    <button label="Delete" role="destructive" variant="prominent"/>
    <button label="Docs" href="/docs"/>
    <pressable a11yLabel="Row"><text value="tap me"/></pressable>
    <glassButton label="Glass"/><transport label="Play"/>
  </stack>`],

  ["controls", `<stack>
    <head><variable as="form">return { name: 'Ada', bio: 'one\\ntwo', qty: 3, on: true, level: 0.4 }</variable></head>
    <textfield bind="dsx.variable.form.name" placeholder="Name" keyboard="email" contentType="emailAddress"/>
    <textfield secure="true" contentType="password" placeholder="Password"/>
    <textarea bind="dsx.variable.form.bio" minLines="2" maxLines="4" placeholder="Bio"/>
    <searchbar bind="dsx.variable.form.name"/>
    <searchbar placeholder="Find a track"/>
    <stepper bind="dsx.variable.form.qty" label="Guests" min="0" max="9"/>
    <stepper bind="dsx.variable.form.qty"/>
    <toggle bind="dsx.variable.form.on"/>
    <slider bind="dsx.variable.form.level"/>
    <progress bind="dsx.variable.form.level"/>
    <spinner a11yLabel="Loading orders"/>
  </stack>`],

  ["media-and-images", `<stack>
    <image src="/hero.png"/>
    <image src="/chart.png" a11yLabel="Quarterly revenue"/>
    <image asset="media/logo.svg" a11yLabel="Logo"/>
    <image asset="AppLogo" a11yLabel="App logo"/>
    <image icon="star" iconSize="18"/>
    <qrcode value="https://dsx.dev"/>
  </stack>`],

  ["globals", `<stack>
    <head><variable as="rows">return [{ name: 'Espresso', qty: 2, total: '$7.00' }, { name: 'Bun', qty: 1, total: '$3.50' }]</variable></head>
    <Table bind="dsx.variable.rows" columns="Item,Qty,Total" fields="name,qty,total"/>
    <Accordion title="Details" open="true"><text value="Body copy"/></Accordion>
    <Accordion title="Ignored"><text slot="header" value="Custom header"/><text value="Body"/></Accordion>
    <Checkbox label="I agree"/>
    <ChatBubble side="right" value="Hello"/>
    <Skeleton/><ProgressRing value="0.5"/>
  </stack>`],

  ["unsupported", `<stack>
    <lottie src="/anim.json"/>
    <Godot/>
    <StudioTimeline/>
  </stack>`],
];

function render(name: string, markup: string): string {
  const ir = compileComponent("Golden", "t", markup);
  const registry: Registry = { components: { "t.Golden": ir }, globalPool: {}, css: "", schemes: [] };
  // One element per line: a golden is only useful if its diff is readable.
  return `<!-- golden: ${name} -->\n${renderToString(registry, "t.Golden").replace(/></g, ">\n<")}\n`;
}

test("golden HTML: every recorded component renders byte-for-byte", () => {
  mkdirSync(goldenDir, { recursive: true });
  const stale: string[] = [];
  for (const [name, markup] of CASES) {
    const file = join(goldenDir, `${name}.html`);
    const actual = render(name, markup);
    if (recording) {
      writeFileSync(file, actual);
      continue;
    }
    assert.ok(existsSync(file),
      `${name}: no golden recorded — run DSX_GOLDEN=update npm test and REVIEW the new file`);
    const expected = readFileSync(file, "utf8");
    if (expected === actual) continue;
    const a = expected.split("\n");
    const b = actual.split("\n");
    const at = a.findIndex((line, i) => line !== b[i]);
    stale.push(`${name}.html line ${at + 1}\n  recorded: ${a[at] ?? "(end of file)"}\n  rendered: ${b[at] ?? "(end of file)"}`);
  }
  assert.deepEqual(stale, [],
    "golden HTML drift — if the change is intended, re-record with DSX_GOLDEN=update npm test and review the diff");
});

test("golden HTML: the corpus on disk matches the declared case list (no orphans)", () => {
  if (recording) return;
  const recorded = readdirSync(goldenDir).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).sort();
  assert.deepEqual(recorded, CASES.map(([name]) => name).sort(),
    "a golden file with no case (or a case with no file) means the suite is not covering what it claims");
});

test("golden HTML: the corpus actually exercises the class contract it is guarding", () => {
  // A golden suite that recorded empty documents would pass forever. Pin the shape.
  const all = CASES.map(([name, markup]) => render(name, markup)).join("\n");
  for (const cls of [
    "dsx-stack", "dsx-hstack", "dsx-text", "dsx-button", "dsx-pressable", "dsx-image",
    "dsx-textfield", "dsx-searchbar-field", "dsx-textarea", "dsx-stepper", "dsx-toggle",
    "dsx-slider", "dsx-progress", "dsx-spinner", "dsx-table-frame", "dsx-accordion",
    "dsx-checkbox", "dsx-chat-bubble", "dsx-skeleton", "dsx-progress-ring", "dsx-qrcode",
    "dsx-toolbar", "dsx-flow", "dsx-divider", "dsx-spacer", "dsx-scroll", "dsx-unsupported",
  ]) {
    assert.ok(all.includes(`class="${cls}`) || all.includes(` ${cls}"`) || all.includes(`${cls} `),
      `${cls}: the golden corpus must exercise it, or it is unguarded`);
  }
  assert.ok(all.includes("<strong>docs</strong>"), "the markdown twin is inside the golden corpus");
  assert.ok(all.includes("data-dsx-unresolved=\"asset\""), "the unresolved-asset marker is inside the golden corpus");
});
