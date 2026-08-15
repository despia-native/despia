// The un-forked-icon-table gate.
//
// `icon=` is a semantic token resolved by the SAME name on every runtime, and the ONE table
// behind it is OpenSource/Conformance/icons/sf-map.json. Web previously carried a private
// 27-name fork inside elements.ts, so 85 corpus names rendered on iOS/Android and drew a
// placeholder circle in the browser — silently, because nothing measured the two tables against
// each other. These tests are that measurement:
//
//   1. every corpus row is DRAWABLE on web (rung 1 vector or rung 2 fallback glyph) — a row
//      added to the corpus without a web resolution fails HERE, not on a user's screen;
//   2. the shipped tables are byte-identical to what the generator derives from the corpus, so
//      the fork cannot creep back by hand-editing icons.generated.ts;
//   3. web adds no icon the shared table does not name (the divergence is recorded in the
//      corpus's own `web_extra` section, never invented in the web package);
//   4. an unknown name still fails open to the placeholder, exactly as the corpus requires.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// ── a minimal SVG-capable fake document (each dom suite carries its own) ──────────────
class FakeNode {
  readonly tagName: string;
  textContent = "";
  private readonly attrs = new Map<string, string>();
  private readonly kids: FakeNode[] = [];
  constructor(tag: string) { this.tagName = tag; }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  appendChild(child: FakeNode): FakeNode { this.kids.push(child); return child; }
  childAt(index: number): FakeNode {
    const child = this.kids[index];
    if (child === undefined) throw new Error(`no child at ${index}`);
    return child;
  }
  get childCount(): number { return this.kids.length; }
}
(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
};

const { iconSvg } = await import("../src/elements.ts");
const { ICON_FALLBACKS, ICON_VECTORS } = await import("../src/icons.generated.ts");
const {
  GENERATED_PATH, SF_MAP_PATH, iconTables, readSfMap, renderIconsModule,
} = await import("../bin/generate-icons.ts");

const map = readSfMap();
const corpusNames = Object.keys(map.icons);
const webExtraNames = Object.keys(map.web_extra ?? {});
const PLACEHOLDER = "M12 4a8 8 0 100 16 8 8 0 000-16z";

/** iconSvg's ladder rung, read off the produced SVG. */
function rungOf(name: string): "vector" | "fallback" | "placeholder" {
  const svg = iconSvg(name, 16) as unknown as FakeNode;
  assert.equal(svg.childCount, 1, `${name}: one glyph child`);
  const child = svg.childAt(0);
  if (child.tagName === "text") {
    assert.ok(child.textContent.length > 0, `${name}: the fallback rung drew an empty glyph`);
    return "fallback";
  }
  assert.equal(child.tagName, "path", `${name}: unexpected glyph node`);
  const d = child.getAttribute("d") ?? "";
  assert.ok(d.length > 0, `${name}: empty path`);
  return d === PLACEHOLDER ? "placeholder" : "vector";
}

function withCapturedWarnings<T>(run: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown): void => { warnings.push(String(message)); };
  try {
    return { value: run(), warnings };
  } finally {
    console.warn = original;
  }
}

test("the web renderer can draw every name in the shared sf-map corpus", () => {
  assert.ok(corpusNames.length >= 90, `expected a populated corpus, got ${corpusNames.length}`);
  const { value: rungs, warnings } = withCapturedWarnings(() =>
    corpusNames.map((name) => [name, rungOf(name)] as const));
  const undrawable = rungs.filter(([, rung]) => rung === "placeholder").map(([name]) => name);
  assert.deepEqual(undrawable, [],
    "corpus names the web renderer cannot draw — add a `web` path or a `fallback` glyph to " +
    "OpenSource/Conformance/icons/sf-map.json for each");
  assert.deepEqual(warnings, [], "a corpus name must never hit the unmapped-icon warning");
});

test("web_extra names — the recorded divergence — draw as real vectors", () => {
  const { value: rungs, warnings } = withCapturedWarnings(() =>
    webExtraNames.map((name) => [name, rungOf(name)] as const));
  for (const [name, rung] of rungs) {
    assert.equal(rung, "vector", `${name}: web_extra rows exist to carry a web path`);
  }
  assert.deepEqual(warnings, []);
});

test("the corpus fallback rung is used, and it is the corpus's own glyph", () => {
  const fallbackNames = Object.keys(ICON_FALLBACKS);
  assert.ok(fallbackNames.length > 0, "the fallback rung must stay exercised, not vestigial");
  for (const name of fallbackNames) {
    assert.equal(rungOf(name), "fallback", `${name}: expected the text rung`);
    assert.equal(ICON_FALLBACKS[name], map.icons[name]?.fallback,
      `${name}: the shipped fallback glyph must be the corpus's own`);
    assert.equal(ICON_VECTORS[name], undefined,
      `${name}: a name with a vector must not also ship a fallback (dead bytes)`);
  }
});

test("shipped icon tables are exactly what the corpus generates (no hand-edited fork)", () => {
  const generated = renderIconsModule(map);
  const shipped = readFileSync(GENERATED_PATH, "utf8");
  assert.equal(shipped, generated,
    `packages/dom/src/icons.generated.ts drifted from ${SF_MAP_PATH} — run: npm run icons:generate`);
});

test("web names no icon the shared table does not name", () => {
  const known = new Set([...corpusNames, ...webExtraNames]);
  const unknown = [...Object.keys(ICON_VECTORS), ...Object.keys(ICON_FALLBACKS)]
    .filter((name) => !known.has(name));
  assert.deepEqual(unknown, [],
    "the web package invented icon names; add them to sf-map.json (`icons`, or `web_extra` " +
    "with the reason) instead of forking the table");
});

test("every generated vector is a bounded SVG path and every fallback is short text", () => {
  const { vectors, fallbacks } = iconTables(map);
  for (const [name, d] of vectors) {
    assert.match(d, /^M[MmLlHhVvCcSsQqTtAaZz0-9 .,\-]*$/, `${name}: not a plain SVG path`);
    assert.ok(d.length <= 320, `${name}: ${d.length}-char path — the web tier stays compact`);
  }
  for (const [name, glyph] of fallbacks) {
    assert.ok([...glyph].length <= 2, `${name}: a fallback is a glyph, not a string`);
  }
});

test("an unknown icon still fails open to the placeholder with one warning", () => {
  const { value, warnings } = withCapturedWarnings(() => rungOf("not.a.symbol"));
  assert.equal(value, "placeholder");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /unmapped icon 'not\.a\.symbol'/);
  assert.match(warnings[0] ?? "", /sf-map\.json/);
});

test("prototype members are not icons", () => {
  for (const hostile of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const { value } = withCapturedWarnings(() => rungOf(hostile));
    assert.equal(value, "placeholder", `${hostile}: prototype lookup leaked into the icon table`);
  }
});
