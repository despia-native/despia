import { test } from "node:test";
import assert from "node:assert/strict";

import { OVERLAY_CONTROL_TAGS, OVERLAY_CONTROLS_CSS } from "../../dom/src/overlay-controls.ts";
import { compileComponent } from "../src/component.ts";
import { registryUsesAnyTag, sliceRegistry } from "../src/expose.ts";
import type { Registry } from "../src/resolve.ts";
import { embedEntrySource, type EmbedEntryFeatures } from "../bin/embed-entry.ts";

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

test("overlay feature detection traverses component slices", () => {
  const root = compileComponent("Root", "t", `<stack><Nested/></stack>`);
  const nested = compileComponent("Nested", "t", `<stack><sheet present="open"><text value="Body"/></sheet><menu menu="items"><button label="More"/></menu></stack>`);
  const plain = compileComponent("Plain", "t", `<stack><text value="Plain"/></stack>`);
  const registry: Registry = {
    components: { "t.Root": root, "t.Nested": nested, "t.Plain": plain }, globalPool: {}, css: "", schemes: [],
  };
  assert.equal(registryUsesAnyTag(sliceRegistry(registry, "t.Root"), OVERLAY_CONTROL_TAGS), true);
  assert.equal(registryUsesAnyTag(sliceRegistry(registry, "t.Plain"), OVERLAY_CONTROL_TAGS), false);
});

test("all overlay spellings are detectable and the presentation sheet stays weak", () => {
  for (const tag of ["sheet", "alert", "confirmDialog", "popover", "menu", "contextmenu"]) {
    const component = compileComponent("Feature", "t", `<stack><${tag}/></stack>`);
    const registry: Registry = { components: { "t.Feature": component }, globalPool: {}, css: "", schemes: [] };
    assert.equal(registryUsesAnyTag(registry, OVERLAY_CONTROL_TAGS), true, tag);
  }
  assert.ok(OVERLAY_CONTROLS_CSS.startsWith("@layer dsx-elements {"));
  assert.ok(!OVERLAY_CONTROLS_CSS.includes("!important"));
});

test("generated embed entries import, register and style overlays only when selected", () => {
  const component = compileComponent("Overlay", "t", `<sheet present="open"><text value="Body"/></sheet>`);
  const registry: Registry = { components: { "t.Overlay": component }, globalPool: {}, css: "", schemes: [] };
  const overlay = embedEntrySource({
    registry, tag: "t-overlay", component: "t.Overlay",
    features: { ...noOptionalFeatures(), overlayControls: true },
  });
  assert.match(overlay, /@despia-native\/dom\/overlay-controls/);
  assert.match(overlay, /OVERLAY_CONTROLS_CSS/);
  assert.match(overlay, /registerOverlayControls\(\)/);

  const plain = embedEntrySource({
    registry, tag: "t-plain", component: "t.Overlay", features: noOptionalFeatures(),
  });
  assert.doesNotMatch(plain, /overlay-controls|OVERLAY_CONTROLS_CSS|registerOverlayControls/);
});
