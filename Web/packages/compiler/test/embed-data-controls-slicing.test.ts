import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DATA_CONTROL_TAGS, DATA_CONTROLS_CSS } from "../../dom/src/data-controls.ts";
import { compileComponent } from "../src/component.ts";
import { registryUsesAnyTag } from "../src/expose.ts";
import type { Registry } from "../src/resolve.ts";
import { embedEntrySource, type EmbedEntryFeatures } from "../bin/embed-entry.ts";

const noFeatures = (): EmbedEntryFeatures => ({
  universalGlobals: false, controlElements: false, formElements: false, richElements: false,
  nativeControls: false, structuralControls: false, overlayControls: false, dataControls: false,
  audioSurface: false, videoSurface: false,
  boundCollections: false,
});

test("every data-control spelling is slice-detectable and its sheet stays weak", () => {
  for (const tag of ["Table", "calendar", "RadioGroup", "segmentedButton", "refreshable", "refresh"]) {
    const component = compileComponent("Feature", "t", `<stack><${tag}/></stack>`);
    const registry: Registry = { components: { "t.Feature": component }, globalPool: {}, css: "", schemes: [] };
    assert.equal(registryUsesAnyTag(registry, DATA_CONTROL_TAGS), true, tag);
  }
  assert.ok(DATA_CONTROLS_CSS.startsWith("@layer dsx-elements {"));
  assert.ok(!DATA_CONTROLS_CSS.includes("!important"));
});

test("embed source conditionally registers data controls and builder enables global fallback dispatch", () => {
  const component = compileComponent("Data", "t", `<Table bind="rows" columns="Name"/>`);
  const registry: Registry = { components: { "t.Data": component }, globalPool: {}, css: "", schemes: [] };
  const enabled = embedEntrySource({
    registry, tag: "t-data", component: "t.Data", features: { ...noFeatures(), dataControls: true },
  });
  assert.match(enabled, /@despia\/dom\/data-controls/);
  assert.match(enabled, /DATA_CONTROLS_CSS/);
  assert.match(enabled, /registerDataControls\(\)/);
  const disabled = embedEntrySource({ registry, tag: "t-data", component: "t.Data", features: noFeatures() });
  assert.doesNotMatch(disabled, /data-controls|DATA_CONTROLS_CSS|registerDataControls/);

  const builder = readFileSync(join(resolve(import.meta.dirname, "../../.."), "packages/compiler/bin/build-demo.ts"), "utf8");
  assert.match(builder, /dataControls: usesDataControls/);
  assert.match(builder, /usesUniversalGlobals \|\| usesDataControls/);
});
