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
  registryUsesInterpolatedAttribute, registryUsesRegex, registryUsesStyleFormulas,
  registryUsesButtonVariants, embedDefines, EMBED_FOLD_KEYS,
  type EmbedEntryFeatures,
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

test("real EmbedCard remains structurally sliced and rides the DEFAULT 40KB widget law", (t) => {
  const root = repoRoot();
  // Real-registry check over the closed Demo/Foundation sources; an open drop skips
  // LOUDLY (the component-fold-conformance rule) - the synthetic slicing tests above still run.
  if (!existsSync(join(root, "ClosedSource"))) {
    t.skip("open drop without ClosedSource - the Demo/Foundation sources ship closed");
    return;
  }
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
    define: embedDefines(),
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
  // The fold map (embed-entry.ts embedDefines) is the single source of truth the builder,
  // this gate and the media gate all build with, so a fold can no longer be set in one and
  // missed in another. What is left to prove is that each fold drives its own define and
  // that the BUILDER supplies every one: a key left out defaults to false and would ship
  // the payload it was meant to drop, silently and only in the real build.
  const off = embedDefines();
  const driven = new Map<string, string>();
  for (const key of EMBED_FOLD_KEYS) {
    const one = embedDefines({ [key]: true });
    const flipped = Object.keys(one).filter((name) => one[name] !== off[name]);
    assert.deepEqual(flipped.length, 1, `fold ${key} must drive exactly one __DSX_OPTIONAL_*__`);
    assert.ok(!driven.has(flipped[0]!), `${flipped[0]} is driven by both ${driven.get(flipped[0]!)} and ${key}`);
    driven.set(flipped[0]!, key);
    assert.match(builder, new RegExp(`\\b${key}: uses`), `build-demo must set the ${key} fold`);
  }
});

test("regex and style-formula detection stay conservative supersets", () => {
  const literal = compileComponent("Literal", "t", `<stack><text value="{{ 'a,b'.split(/,/) }}"/></stack>`);
  const division = compileComponent("Division", "t", `<stack><text value="{{ 4 / 2 }}"/></stack>`);
  const plain = compileComponent("Plain", "t", `<stack style="background: fill"><text value="{{ dsx.attribute.n }}"/></stack>`);
  const reg = (component: ReturnType<typeof compileComponent>, name: string): Registry => ({
    components: { [name]: component }, globalPool: {}, css: "", schemes: [],
  });
  assert.equal(registryUsesRegex(reg(literal, "t.Literal")), true, "a /…/ literal keeps the engine");
  assert.equal(registryUsesRegex(reg(division, "t.Division")), true, "the superset keeps division too");
  assert.equal(registryUsesRegex(reg(plain, "t.Plain")), false, "a slash-free slice folds the engine");

  const reactive = compileComponent("Reactive", "t", `<stack style="color: {{ tint }}"><text value="x"/></stack>`);
  const bridged = compileComponent("Bridged", "t", `<stack background="{{ tone }}"><text value="x"/></stack>`);
  const tinted = compileComponent("Tinted", "t", `<stack><text value="x" color="accent"/></stack>`);
  assert.equal(registryUsesStyleFormulas(reg(reactive, "t.Reactive")), true, "a {{ }} style keeps the mapper");
  assert.equal(registryUsesStyleFormulas(reg(bridged, "t.Bridged")), true, "a reactive bridge attr keeps the mapper");
  assert.equal(registryUsesStyleFormulas(reg(tinted, "t.Tinted")), true, "a semantic color= keeps the mapper");
  assert.equal(registryUsesStyleFormulas(reg(plain, "t.Plain")), false, "static styles were mapped at build time");

  const bordered = compileComponent("Bordered", "t", `<stack><button label="Go" variant="bordered"/></stack>`);
  const dyn = compileComponent("Dyn", "t", `<stack><button label="Go" variant="{{ dsx.attribute.kind }}"/></stack>`);
  const prominent = compileComponent("Prominent", "t", `<stack><button label="Go" variant="prominent"/></stack>`);
  assert.equal(registryUsesButtonVariants(reg(bordered, "t.Bordered")), true, "the bordered word keeps the variant skin");
  assert.equal(registryUsesButtonVariants(reg(dyn, "t.Dyn")), true, "an interpolated variant can resolve to any word");
  assert.equal(registryUsesButtonVariants(reg(prominent, "t.Prominent")), false, "a prominent-only slice folds the rest");
});

test("bundle slicing keeps EmbedCard below the 40KiB G10 widget law, with no override", (t) => {
  const root = repoRoot();
  if (!existsSync(join(root, "ClosedSource"))) {
    t.skip("open drop without ClosedSource - the Demo/Foundation sources ship closed");
    return;
  }
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
    define: embedDefines(),
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
  assert.ok(!Buffer.from(bundle).includes(Buffer.from("linear(0,.069")),
    "the sampled spring table must not leak into a spring-free embed");
  assert.ok(!Buffer.from(bundle).includes(Buffer.from(".dsx-pager")),
    "collection fallback rules must not leak into a collection-free embed");
});
