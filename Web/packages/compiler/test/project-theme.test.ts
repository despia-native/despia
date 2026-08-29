//
//  project-theme.test.ts — the PROJECT TOKEN TIER (master plan P15, dsx-css §4.2)
//  against the shared corpus OpenSource/Conformance/defaults/project-theme.json.
//
//  The tier is one file-presence convention plus a cascade position, so the gate is
//  structural: under the CSS layer spec, layer order + source order INSIDE a layer
//  fully determine which equal-specificity declaration wins. Each corpus case names
//  the structural fact its effective value depends on; this suite asserts those facts
//  on the REAL buildRegistry over real temp projects — no cascade simulation, just
//  the two orders the spec resolves with.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildRegistry, LAYER_STATEMENT } from "../src/index.ts";

const corpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/defaults/project-theme.json", import.meta.url),
  "utf8",
)) as { cases: Array<{ name: string }> };

function scaffold(files: { [relative: string]: string }): string {
  const root = mkdtempSync(join(tmpdir(), "dsx-project-theme-"));
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const APP_MANIFEST = JSON.stringify({ name: "fixture", scheme: "fix" });
const APP_COMPONENT = `<stack><button label="Go"/></stack>\n`;

test("the corpus carries the five layering cases this suite pins", () => {
  assert.deepEqual(corpus.cases.map((c) => c.name), [
    "project-repins-a-kernel-token",
    "project-beats-a-package-sheet",
    "component-sheet-beats-the-project",
    "geometry-token-repaints-the-skin",
    "absent-file-is-no-tier",
  ]);
});

test("project-repins-a-kernel-token + geometry-token-repaints-the-skin: theme.css beside the app manifest folds into dsx-theme by file presence", () => {
  const root = scaffold({
    "dsx.json": APP_MANIFEST,
    "theme.css": ":root { --dsx-accent: #ff2d55; --dsx-radius: 2px; }",
    "Components/App.dsx": APP_COMPONENT,
  });
  try {
    const registry = buildRegistry([{ dir: root, scheme: "fix", app: true }]);
    assert.ok(registry.css.startsWith(LAYER_STATEMENT), "the layer statement rules the sheet");
    const theme = registry.css.match(/@layer dsx-theme \{\n([\s\S]*?)\n\}/);
    assert.ok(theme !== null, "the project tier produced a dsx-theme block");
    assert.match(theme![1]!, /--dsx-accent: #ff2d55/);
    assert.match(theme![1]!, /--dsx-radius: 2px/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-repins-a-kernel-token: a module NOT flagged app never auto-folds its theme.css", () => {
  const root = scaffold({
    "dsx.json": APP_MANIFEST,
    "theme.css": ":root { --dsx-accent: #ff2d55; }",
    "Components/App.dsx": APP_COMPONENT,
  });
  try {
    const registry = buildRegistry([{ dir: root, scheme: "fix" }]);
    assert.ok(!registry.css.includes("#ff2d55"),
      "auto-discovery is scoped to the application root - a package opts in via web.styles");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-beats-a-package-sheet: inside dsx-theme the package sheet folds first, the project theme last", () => {
  const pkg = scaffold({
    "dsx.json": JSON.stringify({ name: "kit", scheme: "kit", web: { styles: ["web/theme.css"] } }),
    "web/theme.css": ":root { --dsx-accent: #34c759; }",
    "Components/Card.dsx": `<stack><text value="card"/></stack>\n`,
  });
  const app = scaffold({
    "dsx.json": APP_MANIFEST,
    "theme.css": ":root { --dsx-accent: #ff2d55; }",
    "Components/App.dsx": APP_COMPONENT,
  });
  try {
    const registry = buildRegistry([
      { dir: app, scheme: "fix", app: true },
      { dir: pkg },
    ]);
    const theme = registry.css.match(/@layer dsx-theme \{\n([\s\S]*?)\n\}/);
    assert.ok(theme !== null);
    const packageAt = theme![1]!.indexOf("#34c759");
    const projectAt = theme![1]!.indexOf("#ff2d55");
    assert.ok(packageAt >= 0 && projectAt >= 0, "both sheets landed in dsx-theme");
    assert.ok(projectAt > packageAt,
      "the project theme must fold AFTER package sheets - equal layer, later wins, the app owns its design");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(app, { recursive: true, force: true });
  }
});

test("component-sheet-beats-the-project: a sidecar lands in dsx-sheets, a stronger layer than dsx-theme", () => {
  const root = scaffold({
    "dsx.json": APP_MANIFEST,
    "theme.css": ":root { --dsx-accent: #ff2d55; }",
    "Components/App.dsx": APP_COMPONENT,
    "Components/App.css": ".hero { --dsx-accent: #5e5ce6; }",
  });
  try {
    const registry = buildRegistry([{ dir: root, scheme: "fix", app: true }]);
    const sheets = registry.css.match(/@layer dsx-sheets \{\n([\s\S]*?)\n\}/);
    assert.ok(sheets !== null, "the sidecar produced a dsx-sheets block");
    assert.match(sheets![1]!, /--dsx-accent: #5e5ce6/);
    const order = LAYER_STATEMENT;
    assert.ok(order.indexOf("dsx-theme") < order.indexOf("dsx-sheets"),
      "the layer statement ranks dsx-sheets above dsx-theme, so the component re-map keeps authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent-file-is-no-tier: a project without theme.css emits no theme block at all", () => {
  const root = scaffold({
    "dsx.json": APP_MANIFEST,
    "Components/App.dsx": APP_COMPONENT,
  });
  try {
    const registry = buildRegistry([{ dir: root, scheme: "fix", app: true }]);
    assert.ok(!registry.css.includes("@layer dsx-theme"),
      "no file, no tier - the renderer defaults stand exactly as shipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
