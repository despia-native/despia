//
//  The app-lint tier (studio-apps.md §13): the open twin of the editor's dogfood
//  discipline — token-only colour, the remote-literal ban, the byte budget — plus the
//  proof obligation that StudioKit itself passes the bar it sets for everyone else.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { lintAppSource, lintAppBudget } from "../src/studio-apps/applint.ts";
import { commandReview } from "../src/review.ts";

test("applint: a colour literal fails with the token plane named — hex, functional, inline", () => {
  for (const [source, kind] of [
    [".a { color: #ff0000; }", "css"],
    [".a {\n  background: hsl(2, 3%, 4%);\n}", "css"],
    ['<stack style="background: rgb(1,2,3)"/>', "dsx"],
  ] as const) {
    const findings = lintAppSource("x", source, kind);
    assert.equal(findings.length, 1, source);
    assert.equal(findings[0]!.level, "error");
    assert.match(findings[0]!.message, /var\(--dsx-/, source);
  }
});

test("applint: the token plane, keywords and mixes over tokens pass", () => {
  for (const [source, kind] of [
    [".a { color: var(--dsx-label); box-shadow: inset 0 0 0 1px var(--dsx-separator); }", "css"],
    [".a { background: color-mix(in srgb, var(--dsx-accent) 12%, transparent); }", "css"],
    [".a { background: transparent; outline-color: currentColor; }", "css"],
    ['<stack style="background: var(--dsx-fill)"/>', "dsx"],
    ['<stack style="opacity: 0.5; width: 200px"/>', "dsx"],
  ] as const) {
    assert.deepEqual(lintAppSource("x", source, kind), [], source);
  }
});

test("applint: a remote literal fails outside comments, in markup, sheets and the web facet", () => {
  assert.equal(lintAppSource("x", '<image src="https://evil.example/x.png"/>', "dsx").length, 1);
  assert.equal(lintAppSource("x", '.a { background: url("http://cdn.example/bg.png"); }', "css").length, 1);
  assert.equal(lintAppSource("x", 'fetch("https://api.example/v1")', "js").length, 1);
  assert.equal(lintAppSource("x", "<!-- docs: https://example.test -->", "dsx").length, 0);
  assert.equal(lintAppSource("x", "// see https://example.test", "js").length, 0);
});

test("applint: the byte budget caps the authored surface at 1 MB", () => {
  assert.equal(lintAppBudget([{ file: "a", bytes: 512 * 1024 }, { file: "b", bytes: 400 * 1024 }]).length, 0);
  const over = lintAppBudget([{ file: "a", bytes: 2 * 1024 * 1024 }]);
  assert.equal(over.length, 1);
  assert.match(over[0]!.message, /content plane/);
});

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/StudioKit/dsx.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/StudioKit not found");
    dir = parent;
  }
}

test("applint: StudioKit itself passes `despia review --app` — the kit holds its own bar", () => {
  const kit = join(repoRoot(), "OpenSource/StudioKit");
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  const code = commandReview({ app: true, strict: true, project: kit }, [], io);
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines[lines.length - 1] ?? "", /0 errors · 0 warnings/);
});

test("applint: the kit's own vocabulary colours only from the token plane (the dogfood scan, direct)", () => {
  const css = readFileSync(join(repoRoot(), "OpenSource/StudioKit/kit.css"), "utf8");
  assert.deepEqual(lintAppSource("kit.css", css, "css"), [],
    "the sheet the lint holds every app author to must itself pass that lint");
});

test("applint: the kit ships the whole component census, and every one is authored markup", () => {
  const dir = join(repoRoot(), "OpenSource/StudioKit/Components");
  // THE CENSUS. An app kit that quietly loses a component leaves authors inventing the shape
  // it used to provide, which is the second-design-system failure the kit exists to prevent.
  const EXPECTED = [
    "Badge", "Button", "Card", "Chip", "Divider", "EmptyState", "Field", "PanelHeader",
    "PropertyRow", "RailPane", "Row", "Section", "Segmented", "Select", "SidePanel",
    "Stat", "Toast", "Toolbar",
  ];
  const shipped = readdirSync(dir).filter((f) => f.endsWith(".dsx")).map((f) => f.replace(/\.dsx$/, "")).sort();
  assert.deepEqual(shipped, EXPECTED);
  // and the vocabulary is UNSCOPED (web.styles), or an author's own markup cannot use it
  const manifest = JSON.parse(readFileSync(join(repoRoot(), "OpenSource/StudioKit/dsx.json"), "utf8")) as
    { web?: { styles?: string[] } };
  assert.deepEqual(manifest.web?.styles, ["kit.css"]);
});
