import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { buildSync } from "esbuild";

import { STRUCTURAL_CONTROL_TAGS, STRUCTURAL_CONTROLS_CSS } from "@despia/dom/structural-controls";
import { compileComponent } from "../src/component.ts";
import { buildRegistry } from "../src/registry.ts";
import { readExpose, registryUsesAnyTag, sliceRegistry } from "../src/expose.ts";
import type { Registry } from "../src/resolve.ts";
import {
  embedEntrySource, registryUsesAttribute, registryUsesBoundCollections,
  registryUsesInterpolatedAttribute, type EmbedEntryFeatures,
} from "../bin/embed-entry.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

test("embed feature detection sees structural controls through transitive component slices", () => {
  const root = compileComponent("Root", "demo", `<stack><Nested/></stack>`);
  const nested = compileComponent("Nested", "demo", `<tabs>
    <vstack tabTitle="One"><text value="one"/></vstack>
    <vstack tabTitle="Two"><carousel><text value="a"/><text value="b"/></carousel></vstack>
  </tabs>`);
  const plain = compileComponent("Plain", "demo", `<vstack><text value="plain"/></vstack>`);
  const registry: Registry = {
    components: { "demo.Root": root, "demo.Nested": nested, "demo.Plain": plain },
    globalPool: {}, css: "", schemes: [],
  };

  const structural = sliceRegistry(registry, "demo.Root");
  assert.deepEqual(Object.keys(structural.components).sort(), ["demo.Nested", "demo.Root"]);
  assert.equal(registryUsesAnyTag(structural, STRUCTURAL_CONTROL_TAGS), true);
  assert.equal(registryUsesAnyTag(sliceRegistry(registry, "demo.Plain"), STRUCTURAL_CONTROL_TAGS), false);
});

test("every structural spelling is detectable and its optional sheet stays weak-layered", () => {
  for (const tag of ["flow", "toolbar", "list", "grid", "pager", "tabs", "tabview", "carousel"]) {
    const component = compileComponent("Feature", "t", `<stack><${tag}/></stack>`);
    const registry: Registry = {
      components: { "t.Feature": component }, globalPool: {}, css: "", schemes: [],
    };
    assert.equal(registryUsesAnyTag(registry, STRUCTURAL_CONTROL_TAGS), true, tag);
  }
  assert.ok(STRUCTURAL_CONTROLS_CSS.startsWith("@layer dsx-elements {"));
  assert.ok(!STRUCTURAL_CONTROLS_CSS.includes("!important"));
});

test("real EmbedCard remains structurally sliced and rides the DEFAULT 40KB widget law", () => {
  const root = repoRoot();
  const demoDir = join(root, "ClosedSource/DSX/Modules/Custom/Demo");
  const foundationDir = join(root, "ClosedSource/DSX/Modules/Mandatory/Foundation");
  const registry = buildRegistry([{ dir: demoDir }, { dir: foundationDir, scheme: "shared" }]);
  const slice = sliceRegistry(registry, "demo.EmbedCard");
  assert.equal(registryUsesAnyTag(slice, STRUCTURAL_CONTROL_TAGS), false,
    "an unrelated widget must not import structural factories or CSS");
  assert.ok(slice.css.length < registry.css.length,
    "an exposed component must not serialize the full application stylesheet");
  for (const unrelated of ["Flex", "Gallery", "Launcher", "Workspace"]) {
    assert.ok(!slice.css.includes(`[data-dsx-owner="${unrelated}"]`),
      `EmbedCard must not inherit the unrelated ${unrelated} sidecar`);
  }
  const requiredHandles = new Set<string>();
  const collectHandles = (node: (typeof slice.components)[string]["root"]): void => {
    for (const handle of (node.attrs["__css"] ?? "").split(/\s+/)) {
      if (handle.length > 0) requiredHandles.add(handle);
    }
    node.children.forEach(collectHandles);
  };
  collectHandles(slice.components["demo.EmbedCard"]!.root);
  for (const handle of requiredHandles) {
    assert.ok(slice.css.includes(`[data-dsx~="${handle}"]`),
      `closed CSS slice retains referenced generated rule ${handle}`);
  }

  const flexSlice = sliceRegistry(registry, "demo.Flex");
  assert.ok(flexSlice.css.includes(`[data-dsx-owner="Flex"]`),
    "the selected component keeps its owner-scoped sidecar");
  assert.ok(!flexSlice.css.includes(`[data-dsx-owner="Gallery"]`),
    "a selected sidecar does not pull an unrelated owner into the embed");

  const manifest = JSON.parse(readFileSync(join(demoDir, "dsx.json"), "utf8")) as {
    scheme: string;
    web: Parameters<typeof readExpose>[1];
  };
  const exposed = readExpose(manifest.scheme, manifest.web).find((entry) => entry.name === "EmbedCard");
  assert.equal(exposed?.budgetKB, 40, "EmbedCard must declare NO budgetKB — it rides the default G10 widget law");
  assert.equal(
    (manifest.web?.expose?.["EmbedCard"] as { budgetKB?: number } | undefined)?.budgetKB,
    undefined,
    "the retired 49KB tool-grade override must not come back",
  );
});

const noOptionalFeatures = (): EmbedEntryFeatures => ({
  universalGlobals: false,
  controlElements: false,
  formElements: false,
  richElements: false,
  nativeControls: false,
  structuralControls: false,
  overlayControls: false,
  dataControls: false,
  audioSurface: false,
  videoSurface: false,
  boundCollections: false,
});

test("bound collection detection is transitive, bind-aware, and leaves static structure lean", () => {
  const root = compileComponent("Root", "t", `<stack><Nested/></stack>`);
  const nested = compileComponent("Nested", "t", `<list bind="rows"><text value="{{item.name}}"/></list>`);
  const staticPager = compileComponent("StaticPager", "t", `<pager><text value="one"/><text value="two"/></pager>`);
  const registry: Registry = {
    components: { "t.Root": root, "t.Nested": nested, "t.StaticPager": staticPager },
    globalPool: {}, css: "", schemes: [],
  };
  assert.equal(registryUsesBoundCollections(sliceRegistry(registry, "t.Root")), true);
  assert.equal(registryUsesBoundCollections(sliceRegistry(registry, "t.StaticPager")), false);
});

test("universal presentation detection is transitive and attribute-specific", () => {
  const root = compileComponent("Root", "t", `<stack><Nested/></stack>`);
  const nested = compileComponent("Nested", "t", `<stack surface="glass" theme="dark" class="state-{{ dsx.attribute.state }}">
    <pressable role="switch" aria-pressed="true"/><pressable a11yPressed="1" disabled-if="locked"/>
  </stack>`);
  const plain = compileComponent("Plain", "t", `<stack background="fill"><text value="plain"/></stack>`);
  const registry: Registry = {
    components: { "t.Root": root, "t.Nested": nested, "t.Plain": plain }, globalPool: {}, css: "", schemes: [],
  };
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Root"), "surface"), true);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Root"), "aria-pressed"), true);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Root"), "a11yPressed"), true);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Root"), "role"), true);
  assert.equal(registryUsesInterpolatedAttribute(sliceRegistry(registry, "t.Root"), "class"), true);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Root"), "theme"), true);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Root"), "disabled-if"), true);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Plain"), "surface"), false);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Plain"), "aria-pressed"), false);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Plain"), "a11yPressed"), false);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Plain"), "role"), false);
  assert.equal(registryUsesInterpolatedAttribute(sliceRegistry(registry, "t.Plain"), "class"), false);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Plain"), "theme"), false);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Plain"), "disabled"), false);
  assert.equal(registryUsesAttribute(sliceRegistry(registry, "t.Plain"), "disabled-if"), false);
});

test("generated exposed-component entries conditionally register and style structural controls", () => {
  const component = compileComponent("Structural", "t", `<tabs>
    <vstack tabTitle="One"><flow><text value="one"/></flow></vstack>
    <vstack tabTitle="Two"><carousel><text value="two"/></carousel></vstack>
  </tabs>`);
  const registry: Registry = {
    components: { "t.Structural": component }, globalPool: {}, css: "", schemes: [],
  };
  const structural = embedEntrySource({
    registry, tag: "t-structural", component: "t.Structural",
    features: { ...noOptionalFeatures(), structuralControls: true },
  });
  assert.match(structural, /import \{ registerStructuralControls, STRUCTURAL_CONTROLS_CSS \} from "@despia\/dom\/structural-controls"/);
  assert.match(structural, /registry\.css = \[STRUCTURAL_CONTROLS_CSS, registry\.css\]/);
  assert.match(structural, /registerStructuralControls\(\);/);
  const bundled = buildSync({
    stdin: {
      contents: structural, sourcefile: "structural-entry.ts",
      resolveDir: join(repoRoot(), "OpenSource/Web"), loader: "ts",
    },
    bundle: true, minify: true, format: "esm", target: "es2022", write: false, logLevel: "silent",
    define: {
      "globalThis.__DSX_OPTIONAL_LINK__": "false",
      "globalThis.__DSX_OPTIONAL_ADOPT__": "false",
      "globalThis.__DSX_OPTIONAL_APIS__": "false",
      "globalThis.__DSX_OPTIONAL_GLOBALS__": "false",
      "globalThis.__DSX_OPTIONAL_RICH__": "false",
      "globalThis.__DSX_OPTIONAL_ICONS__": "false",
      "globalThis.__DSX_OPTIONAL_BOUND_COLLECTIONS__": "false",
      "globalThis.__DSX_OPTIONAL_SURFACES__": "false",
      "globalThis.__DSX_OPTIONAL_PRESSED__": "false",
      "globalThis.__DSX_OPTIONAL_ROLE__": "false",
      "globalThis.__DSX_OPTIONAL_CLASS_FORMULAS__": "false",
      "globalThis.__DSX_OPTIONAL_THEME__": "false",
      "globalThis.__DSX_OPTIONAL_DISABLED__": "false",
    },
  }).outputFiles[0]!.contents;
  assert.ok(Buffer.from(bundled).includes(Buffer.from("--dsx-flow-spacing")),
    "the self-contained structural embed carries its weak-layer component sheet");

  const plain = embedEntrySource({
    registry, tag: "t-plain", component: "t.Structural", features: noOptionalFeatures(),
  });
  assert.doesNotMatch(plain, /structural-controls|STRUCTURAL_CONTROLS_CSS|registerStructuralControls/);

  const builder = readFileSync(join(repoRoot(), "OpenSource/Web/packages/compiler/bin/build-demo.ts"), "utf8");
  assert.match(builder, /embedEntrySource\(\{/);
  assert.match(builder, /structuralControls: usesStructuralControls/);
  assert.match(builder, /boundCollections: usesBoundCollections/);
  assert.match(builder, /__DSX_OPTIONAL_BOUND_COLLECTIONS__/);
  assert.match(builder, /__DSX_OPTIONAL_SURFACES__/);
  assert.match(builder, /__DSX_OPTIONAL_PRESSED__/);
  assert.match(builder, /__DSX_OPTIONAL_ROLE__/);
  assert.match(builder, /__DSX_OPTIONAL_CLASS_FORMULAS__/);
  assert.match(builder, /__DSX_OPTIONAL_THEME__/);
  assert.match(builder, /__DSX_OPTIONAL_DISABLED__/);
  assert.match(builder, /__DSX_OPTIONAL_DESKTOP_INPUT__/);
  assert.match(builder, /__DSX_OPTIONAL_GESTURES__/);
  assert.match(builder, /__DSX_OPTIONAL_SCAFFOLD__/);
  assert.match(builder, /__DSX_OPTIONAL_STATIC_ELEMENTS__/);
  assert.match(builder, /__DSX_OPTIONAL_CONTROLS__/);
  assert.match(builder, /__DSX_OPTIONAL_MARKDOWN__/);
  assert.match(builder, /__DSX_OPTIONAL_JS_GLOBALS__/);
});

test("bundle slicing keeps EmbedCard below the 40KiB G10 widget law, with no override", () => {
  const root = repoRoot();
  const web = join(root, "OpenSource/Web");
  const demoDir = join(root, "ClosedSource/DSX/Modules/Custom/Demo");
  const foundationDir = join(root, "ClosedSource/DSX/Modules/Mandatory/Foundation");
  const registry = buildRegistry([{ dir: demoDir }, { dir: foundationDir, scheme: "shared" }]);
  const slice = sliceRegistry(registry, "demo.EmbedCard");
  const entry = embedEntrySource({
    registry: slice,
    tag: "demo-embedcard",
    component: "demo.EmbedCard",
    features: noOptionalFeatures(),
    facetSrc: join(demoDir, "web/index.js"),
  });
  const result = buildSync({
    stdin: { contents: entry, sourcefile: "embed-card-entry.ts", resolveDir: web, loader: "ts" },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    write: false,
    absWorkingDir: web,
    logLevel: "silent",
    define: {
      "globalThis.__DSX_OPTIONAL_LINK__": "false",
      "globalThis.__DSX_OPTIONAL_ADOPT__": "false",
      "globalThis.__DSX_OPTIONAL_APIS__": "false",
      "globalThis.__DSX_OPTIONAL_GLOBALS__": "false",
      "globalThis.__DSX_OPTIONAL_RICH__": "false",
      "globalThis.__DSX_OPTIONAL_ICONS__": "false",
      "globalThis.__DSX_OPTIONAL_BOUND_COLLECTIONS__": "false",
      "globalThis.__DSX_OPTIONAL_SURFACES__": "false",
      "globalThis.__DSX_OPTIONAL_PRESSED__": "false",
      "globalThis.__DSX_OPTIONAL_ROLE__": "false",
      "globalThis.__DSX_OPTIONAL_CLASS_FORMULAS__": "false",
      "globalThis.__DSX_OPTIONAL_THEME__": "false",
      "globalThis.__DSX_OPTIONAL_DISABLED__": "false",
      "globalThis.__DSX_OPTIONAL_DESKTOP_INPUT__": "false",
      "globalThis.__DSX_OPTIONAL_INPUT__": "false",
      "globalThis.__DSX_OPTIONAL_GESTURES__": "false",
      "globalThis.__DSX_OPTIONAL_SCAFFOLD__": "false",
      "globalThis.__DSX_OPTIONAL_STATIC_ELEMENTS__": "false",
      "globalThis.__DSX_OPTIONAL_CONTROLS__": "false",
      "globalThis.__DSX_OPTIONAL_MARKDOWN__": "false",
      "globalThis.__DSX_OPTIONAL_JS_GLOBALS__": "false",
      "globalThis.__DSX_OPTIONAL_FETCH__": "false",
    },
  });
  const bundle = result.outputFiles[0]!.contents;
  const gzipBytes = gzipSync(bundle).length;
  assert.ok(gzipBytes <= 40 * 1024,
    `EmbedCard is ${gzipBytes}B (${(gzipBytes / 1024).toFixed(1)}KB) gz; the G10 widget law is ${40 * 1024}B and there is no override`);
  const readme = readFileSync(join(web, "README.md"), "utf8");
  assert.ok(readme.includes(`EmbedCard slice is ${gzipBytes.toLocaleString("en-US")} bytes gzip`),
    `README must pin the current EmbedCard size (${gzipBytes}B gzip)`);
  assert.ok(!Buffer.from(bundle).includes(Buffer.from("--dsx-flow-spacing")),
    "structural CSS must not leak into an unrelated embed");
  assert.ok(!Buffer.from(bundle).includes(Buffer.from("data-dsx-truncated")),
    "bound collection reconciliation must not leak into an unrelated embed");
});
