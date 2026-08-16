import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderPage } from "../src/static.ts";

test("static SSR shell carries the complete runtime CSS closure in boot order", () => {
  const component = compileComponent("StaticMedia", "t", `<stack>
    <audio src="/track.wav"/><video src="/movie.mp4"/><svg d="M0 0 L1 1"/><lightbox urls="/photo.jpg"/>
  </stack>`);
  const registry: Registry = {
    components: { "t.StaticMedia": component }, globalPool: {}, css: "", schemes: [],
  };
  const page = renderPage(registry, "t.StaticMedia", {}, { title: "Static media" });
  const body = page.indexOf('<div id="app"');
  const markers = [
    ".dsx-overlay-layer",
    ".dsx-calendar",
    ".dsx-drawer-layer",
    ".dsx-video",
    ".dsx-svg",
    ".dsx-lightbox-layer",
  ];
  let previous = -1;
  for (const marker of markers) {
    const position = page.indexOf(marker);
    assert.ok(position > previous, `${marker} is present in the same deterministic order as DOM boot`);
    assert.ok(position < body, `${marker} arrives before SSR body paint`);
    previous = position;
  }
});
