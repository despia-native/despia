import { test } from "node:test";
import assert from "node:assert/strict";

import { ELEMENTS } from "../src/elements.ts";
import {
  MEDIA_SURFACE_ELEMENTS,
  MEDIA_SURFACE_LIMITS,
  MEDIA_SURFACE_TAGS,
  MEDIA_LIGHTBOX_CSS,
  MEDIA_PLAYBACK_CSS,
  MEDIA_SVG_CSS,
  MEDIA_SESSION_OWNER_SYMBOL,
  boundedMediaText,
  claimMediaSessionOwnership,
  mediaErrorMessage,
  normalizeLightboxColor,
  normalizeLightboxImages,
  normalizeMediaRate,
  parseLightboxUrls,
  registerMediaSurfaces,
  releaseMediaSessionOwnership,
  safeMediaUrl,
  sanitizeSvgMarkup,
  sanitizeSvgSource,
  svgFromPath,
} from "../src/media-surfaces.ts";

const MULTI_MEGABYTE_TEXT = "x".repeat(2 * 1024 * 1024);

test("Media Session ownership is shared across isolated bundles and stale disposal is harmless", (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, MEDIA_SESSION_OWNER_SYMBOL);
  t.after(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, MEDIA_SESSION_OWNER_SYMBOL);
    else Object.defineProperty(globalThis, MEDIA_SESSION_OWNER_SYMBOL, original);
  });
  Reflect.deleteProperty(globalThis, MEDIA_SESSION_OWNER_SYMBOL);
  const firstElement = {} as HTMLAudioElement;
  const secondElement = {} as HTMLAudioElement;
  let firstClears = 0;
  let secondClears = 0;
  const first = Object.freeze({ element: firstElement, clear: () => { firstClears += 1; } });
  const second = Object.freeze({ element: secondElement, clear: () => { secondClears += 1; } });

  assert.equal(claimMediaSessionOwnership(first), true);
  assert.equal(claimMediaSessionOwnership(second), true);
  assert.equal(firstClears, 1, "a newer independently bundled widget retires the prior owner");
  releaseMediaSessionOwnership(firstElement);
  assert.equal(secondClears, 0, "disposing stale widget A cannot clear widget B's handlers");
  assert.equal(
    Object.getOwnPropertyDescriptor(globalThis, MEDIA_SESSION_OWNER_SYMBOL)?.value,
    second,
    "all bundles converge on the Symbol.for page ledger",
  );
  releaseMediaSessionOwnership(secondElement);
  assert.equal(secondClears, 1);
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, MEDIA_SESSION_OWNER_SYMBOL)?.value, null);

  let poisonGets = 0;
  let poisonClears = 0;
  const poisonedTarget = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(poisonedTarget, {
    element: { configurable: true, enumerable: true, value: {} as HTMLAudioElement },
    clear: { configurable: true, enumerable: true, value: () => { poisonClears += 1; } },
  });
  const poisoned = new Proxy(poisonedTarget, {
    get() { poisonGets += 1; throw new Error("hostile owner get"); },
  });
  Object.defineProperty(globalThis, MEDIA_SESSION_OWNER_SYMBOL, {
    configurable: true, enumerable: false, writable: true, value: poisoned,
  });
  const thirdElement = {} as HTMLAudioElement;
  assert.doesNotThrow(() => claimMediaSessionOwnership(Object.freeze({ element: thirdElement, clear() {} })));
  assert.equal(poisonGets, 0, "ownership reads only proven data descriptors, never proxy properties");
  assert.equal(poisonClears, 1, "a descriptor-safe foreign owner is retired without invoking get traps");
  releaseMediaSessionOwnership(thirdElement);
});

test("media URL policy accepts application/CDN/blob sources and rejects executable or local schemes", () => {
  for (const value of [
    "./media/clip.mp4", "../audio/chime.wav", "/assets/photo.jpg", "media/song.m4a",
    "https://cdn.example.test/video.mp4", "http://127.0.0.1:8080/test.webm",
    "blob:https://app.example.test/1b590ab1-22ea-4aae-9cec-b489895bd705",
  ]) assert.equal(safeMediaUrl(value), value);
  for (const value of [
    "", " javascript:alert(1)", "data:video/mp4;base64,AAAA", "file:///etc/passwd",
    "ftp://example.test/movie.mp4", "custom:payload", "C:\\Users\\media.mp4", "https://x.test/\nattack",
    "http://[malformed-host/media.mp4",
    "x".repeat(MEDIA_SURFACE_LIMITS.urlCharacters + 1),
    MULTI_MEGABYTE_TEXT,
  ]) assert.equal(safeMediaUrl(value), null, value.slice(0, 80));
  assert.equal(safeMediaUrl({ toString: () => "https://example.test" }), null, "objects are never coerced into fetch URLs");
});

test("playback rate is finite and constrained to the interoperable HTML media range", () => {
  assert.equal(normalizeMediaRate(1.5), 1.5);
  assert.equal(normalizeMediaRate("0"), 0.25);
  assert.equal(normalizeMediaRate(999), 4);
  assert.equal(normalizeMediaRate(Infinity), 1);
  assert.equal(normalizeMediaRate("not-a-rate"), 1);
});

test("media errors use the numeric platform contract without assuming a global constructor", () => {
  assert.equal(mediaErrorMessage(1), "media loading was aborted");
  assert.equal(mediaErrorMessage(2), "media could not be loaded from the network");
  assert.equal(mediaErrorMessage(3), "media could not be decoded");
  assert.equal(mediaErrorMessage(4), "media source is not supported");
  assert.equal(mediaErrorMessage(undefined), "media playback failed");
});

test("SVG sanitizer emits only the bounded static DSX shape subset", () => {
  const valid = sanitizeSvgMarkup(`
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="22" height="22" rx="4" fill="#3366ff" opacity="0.9"/>
      <path d="M 5 12 L 10 17 L 19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `);
  assert.ok(valid !== null);
  assert.match(valid, /^<svg viewBox="0 0 24 24" xmlns="http:\/\/www\.w3\.org\/2000\/svg">/);
  assert.equal(valid.match(/xmlns=/g)?.length, 1, "canonical output never duplicates the namespace");
  assert.match(valid, /<rect /);
  assert.match(valid, /<path /);
  assert.doesNotMatch(valid, /style=|on[a-z]+=|href=|url\(/i);

  const generated = svgFromPath("M0 0 L100 0 L50 100 Z", "0 0 100 100", "accent");
  assert.ok(generated?.includes('d="M 0 0 L 100 0 L 50 100 Z"'));
  assert.ok(generated?.includes('fill="var(--dsx-accent)"'));
  assert.match(sanitizeSvgMarkup('<svg><rect width="10" height="10" fill="#803366ff"/></svg>') ?? "", /fill="#803366ff"/,
    "SVG eight-digit paint preserves the native renderer's CSS #RRGGBBAA contract");
  assert.ok(sanitizeSvgMarkup(`<svg width="${MEDIA_SURFACE_LIMITS.svgDimension}" height="1"><rect width="1" height="1"/></svg>`) !== null);
  assert.equal(sanitizeSvgMarkup(`<svg width="${MEDIA_SURFACE_LIMITS.svgDimension + 1}" height="1"><rect width="1" height="1"/></svg>`), null,
    "intrinsic SVG dimensions are bounded before DOM insertion");
  assert.equal(boundedMediaText("😀".repeat(2_000)).length, MEDIA_SURFACE_LIMITS.eventMessageCharacters * 2,
    "bounded text counts code points without splitting surrogate pairs");
});

test("SVG sanitizer rejects active content, references, unknown grammar and hostile allocation", () => {
  for (const source of [
    '<svg><script>alert(1)</script><path d="M0 0L1 1"/></svg>',
    '<svg><foreignObject><div>HTML</div></foreignObject></svg>',
    '<svg><image href="https://tracker.example/pixel"/></svg>',
    '<svg><use href="#payload"/></svg>',
    '<svg><path onload="alert(1)" d="M0 0L1 1"/></svg>',
    '<svg><path d="M0 0 A5 5 0 0 1 10 10"/></svg>',
    '<svg><path d="M0 L1 1"/></svg>',
    '<svg><path d="M0 0L1 1" style="fill:url(https://x)"/></svg>',
    '<svg><g><path d="M0 0L1 1"/></g></svg>',
    '<svg><path d="M0 0L1 1" fill="var(--remote)"/></svg>',
  ]) assert.equal(sanitizeSvgMarkup(source), null, source);
  assert.equal(sanitizeSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null,
    "an explicit namespace is not miscounted as a drawable primitive");
  assert.equal(sanitizeSvgMarkup("<svg>" + " ".repeat(MEDIA_SURFACE_LIMITS.svgCharacters) + "</svg>"), null);
  assert.equal(sanitizeSvgMarkup(MULTI_MEGABYTE_TEXT), null, "multi-megabyte markup fails before trim/tokenization");
  assert.equal(sanitizeSvgSource(MULTI_MEGABYTE_TEXT), null, "multi-megabyte sources fail before trim/wrapping");
  assert.equal(svgFromPath(MULTI_MEGABYTE_TEXT), null, "multi-megabyte paths fail before wrapper concatenation");
  assert.equal(svgFromPath("M0 0L1 1", MULTI_MEGABYTE_TEXT, "#000"), null,
    "multi-megabyte viewBox values fail before wrapper concatenation");
  assert.equal(svgFromPath("M0 0L1 1", "0 0 1 1", MULTI_MEGABYTE_TEXT), null,
    "multi-megabyte paint values fail before wrapper concatenation");
  const tooMany = `<svg>${Array.from({ length: MEDIA_SURFACE_LIMITS.svgPrimitives + 1 }, () => '<circle cx="1" cy="1" r="1"/>').join("")}</svg>`;
  assert.equal(sanitizeSvgMarkup(tooMany), null);
});

test("lightbox sources are bounded, field-safe and scheme-filtered", () => {
  assert.deepEqual(normalizeLightboxImages([
    { url: "https://img.example.test/one.jpg" },
    { url: "javascript:alert(1)" },
    "./two.jpg",
    { url: 42 },
  ], "url"), [
    { src: "https://img.example.test/one.jpg" },
    { src: "./two.jpg" },
  ]);
  assert.deepEqual(
    normalizeLightboxImages([{ src: "/safe.jpg", constructor: "https://bad.example" }], "constructor"),
    [{ src: "/safe.jpg" }],
    "unsafe field names fall back to src",
  );
  assert.deepEqual(parseLightboxUrls(" /one.jpg, https://img.example.test/two.jpg, javascript:alert(1) "), [
    { src: "/one.jpg" }, { src: "https://img.example.test/two.jpg" },
  ]);
  const many = normalizeLightboxImages(Array.from(
    { length: MEDIA_SURFACE_LIMITS.lightboxImages + 20 },
    (_, index) => `/image-${index}.jpg`,
  ));
  assert.equal(many.length, MEDIA_SURFACE_LIMITS.lightboxImages);

  let getterReads = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "src", {
    enumerable: true,
    get() { getterReads += 1; return "https://tracker.example.test/getter.jpg"; },
  });
  assert.deepEqual(normalizeLightboxImages([accessor]), []);
  assert.equal(getterReads, 0, "normalization never invokes row accessors");
  const hostileProxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("descriptor trap"); } });
  assert.deepEqual(normalizeLightboxImages([hostileProxy]), [], "descriptor proxies fail closed");

  let entryReads = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    configurable: true,
    get() { entryReads += 1; return "/tracker.jpg"; },
  });
  accessorArray.length = 1;
  assert.deepEqual(normalizeLightboxImages(accessorArray), []);
  assert.equal(entryReads, 0, "normalization never invokes array entry accessors");
  const hostileArray = new Proxy(["/safe.jpg"], {
    getOwnPropertyDescriptor(target, property) {
      if (property === "length") throw new Error("length descriptor trap");
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  assert.deepEqual(normalizeLightboxImages(hostileArray), [], "hostile Array proxies fail closed");
  const revokedArray = Proxy.revocable(["/safe.jpg"], {});
  revokedArray.revoke();
  assert.deepEqual(normalizeLightboxImages(revokedArray.proxy), [], "revoked Array proxies fail closed");
  const revokedRow = Proxy.revocable({ src: "/safe.jpg" }, {});
  revokedRow.revoke();
  assert.deepEqual(normalizeLightboxImages([revokedRow.proxy]), [], "revoked row proxies fail closed");
  assert.deepEqual(normalizeLightboxImages([{ src: "/safe.jpg" }], MULTI_MEGABYTE_TEXT), [{ src: "/safe.jpg" }],
    "oversized source-field names fail closed to the bounded src fallback before trim");

  const csv = Array.from({ length: MEDIA_SURFACE_LIMITS.lightboxImages + 500 }, (_, index) => `/image-${index}.jpg`).join(",");
  assert.equal(parseLightboxUrls(csv).length, MEDIA_SURFACE_LIMITS.lightboxImages,
    "CSV parsing stops after the bounded output ledger");
  assert.deepEqual(parseLightboxUrls("x".repeat(MEDIA_SURFACE_LIMITS.lightboxCsvCharacters + 1)), [],
    "oversized CSV input fails closed before split-like allocation");
  assert.deepEqual(parseLightboxUrls(",".repeat(500_000) + "/too-late.jpg"), [],
    "invalid CSV fields still consume the 256-field inspection ledger");
  assert.equal(normalizeLightboxColor("#803366ff"), "#3366ff80", "StackStyle eight-digit lightbox colors are ARGB");
  assert.equal(normalizeLightboxColor("destructive"), "var(--dsx-destructive)");
  assert.equal(normalizeLightboxColor("red;position:fixed"), "#ffffff");
  assert.equal(normalizeLightboxColor(MULTI_MEGABYTE_TEXT), "#ffffff", "oversized colors fail before trim");
});

test("media surfaces are optional, exhaustively registered, and weakly styled for platform preferences", () => {
  assert.equal(MEDIA_SURFACE_LIMITS.loadTimeoutMilliseconds, 15_000, "bad media endpoints have a bounded native-parity deadline");
  for (const tag of MEDIA_SURFACE_TAGS) assert.equal(ELEMENTS[tag], undefined, `${tag} begins outside the base floor`);
  registerMediaSurfaces();
  for (const tag of ["audio", "video", "svg", "lightbox"]) {
    assert.equal(ELEMENTS[tag], MEDIA_SURFACE_ELEMENTS[tag]);
    assert.equal(MEDIA_SURFACE_TAGS.has(tag), true);
  }
  for (const css of [MEDIA_PLAYBACK_CSS, MEDIA_SVG_CSS, MEDIA_LIGHTBOX_CSS]) {
    assert.ok(css.startsWith("@layer dsx-elements {"));
    assert.doesNotMatch(css, /!important|linear-gradient/);
  }
  assert.match(MEDIA_PLAYBACK_CSS + MEDIA_LIGHTBOX_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(MEDIA_PLAYBACK_CSS + MEDIA_SVG_CSS + MEDIA_LIGHTBOX_CSS, /@media \(forced-colors: active\)/);
  assert.match(MEDIA_LIGHTBOX_CSS, /\[dir="rtl"\]/);
});
