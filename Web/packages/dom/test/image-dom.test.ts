//
//  image-dom.test.ts — the `<image>` WEB ADAPTER (U05, packages/dom/src/image.ts).
//
//  The DECISIONS are judged by the shared corpus on three renderers
//  (OpenSource/Conformance/image/resolution.json — kernel/test/image-core.test.ts here). What
//  this file judges is the part the corpus cannot state: the browser MAPPINGS, and the four
//  behaviours that only exist once a real element is on the page — the transition gate against a
//  memory hit, the recycling clear, the fallback swap, and the `on:load` payload.
//
//  In-process fake DOM, the same shape hover.test.ts and tooltip.test.ts use: no jsdom, no
//  browser, so the assertions are about our code rather than about someone's shim.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyImageAttributes, objectFitValue, objectPositionValue, fetchHints,
  placeholderStyle, pixelsToBmpDataUrl,
} from "../src/image.ts";

// ── the fake element ──────────────────────────────────────────────────────────────

type Listener = () => void;

class FakeStyle {
  readonly values: Record<string, string> = {};
  setProperty(name: string, value: string): void { this.values[name] = value; }
  removeProperty(name: string): void { delete this.values[name]; }
}

class FakeImage {
  readonly style = new FakeStyle();
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, Listener[]> = {};
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  removeAttribute(name: string): void { delete this.attributes[name]; }
  addEventListener(type: string, run: Listener): void { (this.listeners[type] ??= []).push(run); }
  fire(type: string): void { for (const run of this.listeners[type] ?? []) run(); }
}

function hooks(bound: string[] = [], sink: Array<{ name: string; payload?: Record<string, unknown> }> = []) {
  return {
    calls: sink,
    hasHandler: (name: string): boolean => bound.includes(name),
    handler: (name: string, payload?: Record<string, unknown>): void => { sink.push({ name, payload }); },
  };
}

function apply(attrs: Record<string, string | undefined>, bound: string[] = []) {
  const image = new FakeImage();
  const h = hooks(bound);
  applyImageAttributes(image as unknown as HTMLImageElement, attrs, h);
  return { image, h };
}

// ── the pure mappings ─────────────────────────────────────────────────────────────

test("contentFit maps to object-fit, and only scaleDown changes spelling", () => {
  assert.equal(objectFitValue("cover"), "cover");
  assert.equal(objectFitValue("contain"), "contain");
  assert.equal(objectFitValue("fill"), "fill");
  assert.equal(objectFitValue("none"), "none");
  assert.equal(objectFitValue("scaleDown"), "scale-down");
  // An unknown word is `cover`, exactly as the core folds it — never an unset property.
  assert.equal(objectFitValue("bogus"), "cover");
  assert.equal(objectFitValue(undefined), "cover");
});

test("contentPosition maps to object-position percentages, named or numeric", () => {
  assert.equal(objectPositionValue(undefined), "50% 50%");
  assert.equal(objectPositionValue("top"), "50% 0%");
  assert.equal(objectPositionValue("bottomTrailing"), "100% 100%");
  assert.equal(objectPositionValue("25% 75%"), "25% 75%");
  assert.equal(objectPositionValue("0.1 0.9"), "10% 90%", "no binary-fraction noise in a CSS string");
  assert.equal(objectPositionValue("33.3333% 0"), "33.3333% 0%");
});

test("priority maps to fetchpriority, and only `low` earns lazy loading", () => {
  assert.deepEqual(fetchHints("high"), { fetchpriority: "high", loading: "eager" });
  assert.deepEqual(fetchHints(undefined), { fetchpriority: "auto", loading: "eager" });
  assert.deepEqual(fetchHints("low"), { fetchpriority: "low", loading: "lazy" });
});

test("a colour placeholder paints a background; an unparseable one paints nothing", () => {
  assert.deepEqual(placeholderStyle("#102030", "cover"), { backgroundColor: "#102030" });
  assert.deepEqual(placeholderStyle("", "cover"), {});
  // A short base64-shaped string classifies as a thumbhash and fails to decode: the contract is
  // no placeholder, never a broken-image box.
  assert.deepEqual(placeholderStyle("AAAAAAAA", "cover"), {});
});

test("a blurhash placeholder becomes a self-contained BMP data URL", () => {
  const resolved = placeholderStyle("LEHV6nWB2yk8pyo0adR*.7kCMdnj", "cover");
  assert.ok(resolved.backgroundImage !== undefined);
  assert.match(resolved.backgroundImage, /^url\("data:image\/bmp;base64,[A-Za-z0-9+/=]+"\)$/);
  assert.equal(resolved.backgroundSize, "cover");
});

test("the BMP encoder writes a well-formed 24-bit bottom-up header", () => {
  const url = pixelsToBmpDataUrl({ width: 2, height: 2, rgba: Uint8ClampedArray.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]) });
  const bytes = Buffer.from(url.slice("data:image/bmp;base64,".length), "base64");
  assert.equal(bytes[0], 0x42);
  assert.equal(bytes[1], 0x4d);
  assert.equal(bytes.readUInt32LE(10), 54, "pixel data starts after the two headers");
  assert.equal(bytes.readInt32LE(18), 2, "width");
  assert.equal(bytes.readInt32LE(22), 2, "height");
  assert.equal(bytes.readUInt16LE(28), 24, "bits per pixel");
  // Bottom-up: the FIRST row written is the LAST row of the image, and channels are BGR.
  assert.deepEqual([bytes[54], bytes[55], bytes[56]], [255, 0, 0], "row 1 pixel 0 is blue as BGR");
  assert.equal(bytes.length, 54 + 2 * (2 * 3 + 2), "two padded rows of two pixels");
});

// ── the behaviours only a live element has ────────────────────────────────────────

test("a cold image fades in; a memory hit renders in the same frame with no transition", () => {
  const cold = apply({ src: "https://x/a.jpg" });
  assert.equal(cold.image.style.values["opacity"], "0");
  assert.equal(cold.image.style.values["transition"], "opacity 200ms ease");

  const warm = new FakeImage();
  warm.complete = true;
  applyImageAttributes(warm as unknown as HTMLImageElement, { src: "https://x/a.jpg" }, hooks());
  assert.equal(warm.style.values["opacity"], "1");
  assert.equal(warm.style.values["transition"], undefined, "a memory hit must not fade");
});

test("transition=0 and transition=none both skip the fade entirely", () => {
  for (const spec of ["0", "none"]) {
    const { image } = apply({ src: "https://x/a.jpg", transition: spec });
    assert.equal(image.style.values["opacity"], "1", spec);
    assert.equal(image.style.values["transition"], undefined, spec);
  }
});

test("cachePolicy=none forbids reporting a memory hit, so the fade still runs", () => {
  const warm = new FakeImage();
  warm.complete = true;
  applyImageAttributes(warm as unknown as HTMLImageElement,
    { src: "https://x/a.jpg", cachePolicy: "none" }, hooks());
  assert.equal(warm.style.values["opacity"], "0");
});

test("on:load reports the payload the corpus pins, media type included", () => {
  const sink: Array<{ name: string; payload?: Record<string, unknown> }> = [];
  const image = new FakeImage();
  image.setAttribute("src", "https://cdn/photo.WEBP?v=2");
  applyImageAttributes(image as unknown as HTMLImageElement,
    { src: "https://cdn/photo.WEBP?v=2" }, hooks(["load"], sink));
  image.naturalWidth = 1200;
  image.naturalHeight = 800;
  image.fire("load");
  assert.equal(sink.length, 1);
  assert.deepEqual(sink[0]?.payload, {
    width: 1200, height: 800, mediaType: "image/webp", cacheType: "none",
  });
  assert.equal(image.style.values["opacity"], "1", "the load event always lands at full opacity");
});

test("an unbound on:load costs nothing", () => {
  const sink: Array<{ name: string }> = [];
  const image = new FakeImage();
  applyImageAttributes(image as unknown as HTMLImageElement, { src: "https://x/a.jpg" }, hooks([], sink));
  image.fire("load");
  assert.equal(sink.length, 0);
});

test("fallback swaps the source once; a failing fallback then reports on:error", () => {
  const sink: Array<{ name: string; payload?: Record<string, unknown> }> = [];
  const image = new FakeImage();
  image.setAttribute("src", "https://x/gone.jpg");
  applyImageAttributes(image as unknown as HTMLImageElement,
    { src: "https://x/gone.jpg", fallback: "https://x/fallback.png" }, hooks(["error"], sink));
  image.fire("error");
  assert.equal(image.getAttribute("src"), "https://x/fallback.png");
  assert.equal(sink.length, 0, "the swap is not an error the author has to handle");
  image.fire("error");
  assert.deepEqual(sink[0], {
    name: "error",
    payload: { error: "image_load_failed", url: "https://x/fallback.png" },
  });
});

test("recyclingKey clears the previous image the moment the identity changes", () => {
  const image = new FakeImage();
  image.setAttribute("src", "https://x/1.jpg");
  const binding = applyImageAttributes(image as unknown as HTMLImageElement,
    { src: "https://x/1.jpg", recyclingKey: "item-1" }, hooks());
  assert.equal(image.getAttribute("src"), "https://x/1.jpg", "the first mount keeps its bytes");

  // The row is reused for item 47 and its bytes have not arrived: the OLD image must go NOW.
  assert.equal(binding.update({ src: "https://x/47.jpg", recyclingKey: "item-47" }), true);
  assert.equal(image.getAttribute("src"), null, "the stale image is gone in the same turn");
  assert.equal(image.style.values["opacity"], "0");

  // The same identity again is not a recycle, so a re-render never blanks a good image.
  image.setAttribute("src", "https://x/47.jpg");
  assert.equal(binding.update({ src: "https://x/47.jpg", recyclingKey: "item-47" }), false);
  assert.equal(image.getAttribute("src"), "https://x/47.jpg");
});

test("with no author key the identity falls to the row key, then to src", () => {
  const image = new FakeImage();
  image.setAttribute("src", "https://x/1.jpg");
  const binding = applyImageAttributes(image as unknown as HTMLImageElement,
    { src: "https://x/1.jpg" }, hooks());
  // A <list> that sets the row key automatically wins over src, which is what makes the correct
  // behaviour the DEFAULT rather than an attribute the author has to remember.
  assert.equal(binding.update({ src: "https://x/1.jpg", rowKey: "row-9" }), true);
  image.setAttribute("src", "https://x/1.jpg");
  assert.equal(binding.update({ src: "https://x/2.jpg", rowKey: "row-9" }), false,
    "the row key pins the identity, so a src swap inside one row is not a recycle");
});

test("on:progress is marked unsupported rather than faked", () => {
  const { image } = apply({ src: "https://x/a.jpg" }, ["progress"]);
  assert.equal(image.getAttribute("data-dsx-unsupported"), "progress");
  const quiet = apply({ src: "https://x/a.jpg" });
  assert.equal(quiet.image.getAttribute("data-dsx-unsupported"), null);
});

test("blurRadius and tint write real CSS, and absence writes nothing", () => {
  const { image } = apply({ src: "https://x/a.jpg", blurRadius: "8", tint: "#ff0000" });
  assert.equal(image.style.values["filter"], "blur(8px)");
  assert.equal(image.style.values["mask-image"], 'url("https://x/a.jpg")');
  assert.equal(image.style.values["background-color"], "#ff0000");
  const plain = apply({ src: "https://x/a.jpg" });
  assert.equal(plain.image.style.values["filter"], undefined);
  assert.equal(plain.image.style.values["mask-image"], undefined);
});
