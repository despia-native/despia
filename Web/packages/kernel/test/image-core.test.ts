//
//  image-core.test.ts — the SHARED <image> resolution corpus through the TS kernel
//  (OpenSource/Conformance/image/resolution.json). The Kotlin twin is :core
//  ImageResolutionConformanceTest and the Swift reference is Engine/iOS/ImageCore.swift, both
//  reading the SAME file — so `contentFit="cover"` cannot crop one way on one renderer and
//  another way on the next, and a blurhash placeholder cannot decode to different pixels.
//
//  Missing corpus = loud failure: a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  CONTENT_FITS, POSITION_ANCHORS, TRANSITION_EFFECTS, CACHE_POLICIES,
  solveImageRect, resolveContentPosition, resolveCachePolicy, resolveTransition,
  shouldTransition, resolveDecodeSize, classifyPlaceholder, resolveRecycling,
  decodeBlurhash, decodeThumbhash, cacheTypeFor, resolveImagePriority, imageMediaType,
} from "../src/image-core.ts";

const EPSILON = 1e-6;

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/image");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/image not found");
    dir = parent;
  }
}

let cached: { [key: string]: unknown } | null = null;
function corpus(): { [key: string]: unknown } {
  if (cached === null) {
    cached = JSON.parse(readFileSync(join(corpusDir(), "resolution.json"), "utf-8")) as { [key: string]: unknown };
    assert.equal(cached["version"], 1, "resolution.json: version");
  }
  return cached;
}

function section<T>(name: string): T[] {
  const rows = corpus()[name] as T[] | undefined;
  assert.ok(Array.isArray(rows) && rows.length > 0, `${name}: corpus section must not be empty`);
  return rows;
}

function near(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < EPSILON, `${label}: expected ${expected}, got ${actual}`);
}

test("image: the vocabularies agree with the corpus", () => {
  assert.deepEqual([...CONTENT_FITS], corpus()["contentFits"]);
  assert.deepEqual([...TRANSITION_EFFECTS], corpus()["transitionEffects"]);
  assert.deepEqual([...CACHE_POLICIES], corpus()["cachePolicies"]);
  const anchors = corpus()["positionAnchors"] as { [k: string]: { x: number; y: number } };
  for (const name of Object.keys(anchors)) {
    assert.deepEqual(resolveContentPosition(name), anchors[name], `anchor ${name}`);
  }
  assert.deepEqual(Object.keys(POSITION_ANCHORS).sort(), Object.keys(anchors).sort());
});

test("image: the defaults agree with the corpus", () => {
  const defaults = corpus()["defaults"] as { [k: string]: unknown };
  assert.equal(resolveCachePolicy(null, null).policy, defaults["cachePolicy"]);
  assert.equal(resolveImagePriority(null), defaults["priority"]);
  assert.deepEqual(resolveTransition(null), defaults["transition"]);
  const rect = solveImageRect(null, null, { width: 100, height: 100 }, { width: 100, height: 100 });
  const covered = solveImageRect(defaults["contentFit"] as string, defaults["contentPosition"] as string,
    { width: 100, height: 100 }, { width: 100, height: 100 });
  assert.deepEqual(rect, covered, "an undeclared fit/position is the declared default");
});

test("image: the contentFit x contentPosition geometry solver agrees with the corpus", () => {
  type Case = {
    name: string; fit: string; position: string;
    source: { width: number; height: number };
    container: { width: number; height: number };
    expect: { x: number; y: number; width: number; height: number; scale: number };
  };
  for (const row of section<Case>("geometry")) {
    const got = solveImageRect(row.fit, row.position, row.source, row.container);
    near(got.x, row.expect.x, `${row.name}: x`);
    near(got.y, row.expect.y, `${row.name}: y`);
    near(got.width, row.expect.width, `${row.name}: width`);
    near(got.height, row.expect.height, `${row.name}: height`);
    near(got.scale, row.expect.scale, `${row.name}: scale`);
  }
});

test("image: the cache-policy ladder agrees with the corpus", () => {
  type Case = {
    name: string; cachePolicy: string | null; cache: string | null;
    expect: { policy: string; memory: boolean; disk: boolean; revalidate: boolean };
  };
  for (const row of section<Case>("cache")) {
    assert.deepEqual(resolveCachePolicy(row.cachePolicy, row.cache), row.expect, row.name);
  }
  // The legacy binary attribute still routes — the whole point of the fold.
  assert.equal(resolveCachePolicy(null, "none").policy, "none");
  assert.equal(resolveCachePolicy(null, "default").policy, "memoryDisk");
});

test("image: the transition fold and its gate agree with the corpus", () => {
  type Case = {
    name: string; transition: unknown;
    expect: { duration: number; effect: string };
    gate: { memory: boolean; disk: boolean; none: boolean };
  };
  for (const row of section<Case>("transition")) {
    const resolved = resolveTransition(row.transition as never);
    assert.deepEqual(resolved, row.expect, `${row.name}: fold`);
    for (const kind of ["memory", "disk", "none"] as const) {
      assert.equal(shouldTransition(resolved, kind), row.gate[kind], `${row.name}: gate/${kind}`);
    }
  }
});

test("image: a memory-cache hit never fades", () => {
  const resolved = resolveTransition(300);
  assert.equal(shouldTransition(resolved, "memory"), false);
  assert.equal(shouldTransition(resolved, "disk"), true);
  assert.equal(shouldTransition(resolved, "none"), true);
  const policy = resolveCachePolicy("memoryDisk", null);
  assert.equal(cacheTypeFor(policy, { memory: true, disk: true }), "memory");
  assert.equal(cacheTypeFor(policy, { memory: false, disk: true }), "disk");
  assert.equal(cacheTypeFor(policy, {}), "none");
  assert.equal(cacheTypeFor(resolveCachePolicy("none", null), { memory: true, disk: true }), "none");
});

test("image: the decode-at-display-size ladder agrees with the corpus", () => {
  type Case = {
    name: string; fit: string;
    source: { width: number; height: number };
    display: { width: number; height: number };
    scale: number; allowDownscaling: boolean;
    expect: { width: number; height: number; downscaled: boolean };
  };
  for (const row of section<Case>("downscale")) {
    const got = resolveDecodeSize({
      fit: row.fit, source: row.source, display: row.display,
      scale: row.scale, allowDownscaling: row.allowDownscaling,
    });
    assert.deepEqual(got, row.expect, row.name);
  }
});

test("image: a 4000px source in a 48pt avatar decodes at 96px, not 4000", () => {
  const got = resolveDecodeSize({
    fit: "cover", source: { width: 4000, height: 4000 },
    display: { width: 48, height: 48 }, scale: 2, allowDownscaling: true,
  });
  assert.deepEqual(got, { width: 96, height: 96, downscaled: true });
  // The memory saving this represents, stated as the assertion it actually is.
  assert.equal(4000 * 4000 * 4 / (got.width * got.height * 4), 1736.111111111111);
});

test("image: placeholder classification agrees with the corpus", () => {
  type Case = { name: string; placeholder: string; expect: { kind: string; value: string } };
  for (const row of section<Case>("placeholder")) {
    assert.deepEqual(classifyPlaceholder(row.placeholder), row.expect, row.name);
  }
});

test("image: the recycling identity agrees with the corpus", () => {
  type Case = {
    name: string; recyclingKey: string | null; rowKey: string | null;
    src: string | null; asset: string | null; previousKey: string;
    expect: { key: string; clear: boolean };
  };
  for (const row of section<Case>("recycling")) {
    assert.deepEqual(resolveRecycling(row), row.expect, row.name);
  }
});

test("image: the blurhash decoder produces the pinned pixels", () => {
  type Case = { name: string; hash: string; width: number; height: number; rgba: number[] };
  for (const row of section<Case>("blurhash")) {
    const decoded = decodeBlurhash(row.hash, row.width, row.height);
    assert.ok(decoded !== null, `${row.name}: decoded`);
    assert.equal(decoded!.width, row.width);
    assert.equal(decoded!.height, row.height);
    assert.deepEqual([...decoded!.rgba], row.rgba, `${row.name}: pixels`);
  }
  assert.equal(decodeBlurhash("nope", 4, 4), null, "a malformed hash degrades, never throws");
  assert.equal(decodeBlurhash("LEHV6nWB2yk8pyo0adR*.7kCMdnj", 0, 4), null);
});

test("image: the thumbhash decoder produces the pinned pixels and the hash's own aspect", () => {
  type Case = { name: string; hash: string; expect: { width: number; height: number; rgba: number[] } };
  for (const row of section<Case>("thumbhash")) {
    const decoded = decodeThumbhash(row.hash);
    assert.ok(decoded !== null, `${row.name}: decoded`);
    assert.equal(decoded!.width, row.expect.width, `${row.name}: width`);
    assert.equal(decoded!.height, row.expect.height, `${row.name}: height`);
    assert.deepEqual([...decoded!.rgba], row.expect.rgba, `${row.name}: pixels`);
    // The transport prefix is accepted and stripped.
    assert.deepEqual([...decodeThumbhash(`thumbhash:${row.hash}`)!.rgba], row.expect.rgba);
  }
  assert.equal(decodeThumbhash("!!!!"), null, "a malformed hash degrades, never throws");
});

test("image: the on:load media type maps by extension and passes types through", () => {
  assert.equal(imageMediaType("jpg"), "image/jpeg");
  assert.equal(imageMediaType(".PNG"), "image/png");
  assert.equal(imageMediaType("image/webp"), "image/webp");
  assert.equal(imageMediaType("xyz"), "unknown");
  assert.equal(imageMediaType(null), "unknown");
});
