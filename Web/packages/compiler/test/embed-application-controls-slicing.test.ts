import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APPLICATION_CONTROL_TAGS,
} from "../../dom/src/application-controls.ts";
import { compileComponent } from "../src/component.ts";
import { registryUsesAnyTag, sliceRegistry } from "../src/expose.ts";
import type { Registry } from "../src/resolve.ts";
import { assertEmbedCompatible, embedEntrySource, type EmbedEntryFeatures } from "../bin/embed-entry.ts";

const noFeatures = (): EmbedEntryFeatures => ({
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

test("full-application chrome is rejected directly and through a closed embed slice", () => {
  const root = compileComponent("Root", "t", `<stack><Chrome/></stack>`);
  const chrome = compileComponent("Chrome", "t", `<stack><MenuBar items="items"/><Drawer><text value="Body"/></Drawer></stack>`);
  const plain = compileComponent("Plain", "t", `<stack><text value="Plain"/></stack>`);
  const registry: Registry = {
    components: { "t.Root": root, "t.Chrome": chrome, "t.Plain": plain },
    globalPool: {}, css: "", schemes: [],
  };
  const nested = sliceRegistry(registry, "t.Root");
  const plainSlice = sliceRegistry(registry, "t.Plain");
  assert.equal(registryUsesAnyTag(nested, APPLICATION_CONTROL_TAGS), true);
  assert.equal(registryUsesAnyTag(plainSlice, APPLICATION_CONTROL_TAGS), false);
  const message = /Drawer\/MenuBar.*full-application chrome.*self-contained custom-element embed/;
  assert.throws(() => assertEmbedCompatible({ ...registry, components: { "t.Chrome": chrome } }, "t.Chrome"), message);
  assert.throws(() => assertEmbedCompatible(nested, "t.Root"), message);
  assert.throws(() => embedEntrySource({
    registry: nested, tag: "t-root", component: "t.Root", features: noFeatures(),
  }), message, "entry generation cannot bypass the full-app policy");
  assert.doesNotThrow(() => assertEmbedCompatible(plainSlice, "t.Plain"));
});

test("self-contained embed source has no application-chrome feature path", () => {
  const component = compileComponent("Plain", "t", `<text value="Plain"/>`);
  const registry: Registry = { components: { "t.Plain": component }, globalPool: {}, css: "", schemes: [] };
  const source = embedEntrySource({
    registry,
    tag: "t-plain",
    component: "t.Plain",
    features: noFeatures(),
  });
  assert.doesNotMatch(source, /application-controls|APPLICATION_CONTROLS_CSS|registerApplicationControls/);
});
