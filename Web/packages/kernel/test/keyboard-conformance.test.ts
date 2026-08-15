//
//  keyboard-conformance.test.ts — the soft-keyboard viewport corpus runner (TS lane).
//  Executes OpenSource/Conformance/keyboard/viewport.json against resolveKeyboardViewport;
//  the Kotlin (:core) and Swift twins run the SAME file.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import {
  resolveKeyboardViewport,
  parseKeyboardMode,
  modeForOverlaysContent,
  supportsViewportModes,
  type KeyboardPlatform,
} from "../src/keyboard.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/keyboard/viewport.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/keyboard/viewport.json not found");
    dir = parent;
  }
}

interface Case {
  name: string;
  declared: string | null;
  requested?: boolean | null;
  platform: KeyboardPlatform;
  api?: number;
  keyboard: { visible: boolean; height: number };
  viewport: { width: number; height: number };
  expect: {
    mode: string;
    degraded: boolean;
    insetHeight: number;
    overlaysContent: boolean;
    boundingRect: { x: number; y: number; width: number; height: number };
  };
}

const corpus = JSON.parse(readFileSync(corpusFile(), "utf8")) as { cases: Case[] };

test("keyboard viewport corpus", () => {
  assert.ok(corpus.cases.length > 0, "corpus is empty");
  for (const c of corpus.cases) {
    const got = resolveKeyboardViewport({
      declared: c.declared,
      requested: c.requested ?? null,
      platform: c.platform,
      api: c.api ?? null,
      keyboard: c.keyboard,
      viewport: c.viewport,
    });
    assert.deepEqual(
      {
        mode: got.mode,
        degraded: got.degraded,
        insetHeight: got.insetHeight,
        overlaysContent: got.overlaysContent,
        boundingRect: got.boundingRect,
      },
      c.expect,
      c.name,
    );
  }
});

test("mode parsing is total — no input throws, everything unknown is legacy", () => {
  for (const word of ["resize", "RESIZE", " overlay ", "legacy"]) {
    assert.ok(["legacy", "resize", "overlay"].includes(parseKeyboardMode(word)), word);
  }
  for (const junk of [null, undefined, "", "   ", "shrink", "true", "1", "resize;overlay"]) {
    assert.equal(parseKeyboardMode(junk as string), "legacy", String(junk));
  }
});

test("only android has an API floor, and it is 30", () => {
  assert.equal(supportsViewportModes("android", 29), false);
  assert.equal(supportsViewportModes("android", 30), true);
  assert.equal(supportsViewportModes("android", 36), true);
  // An unknown API level on android fails CLOSED — a mode that half-works is worse than legacy.
  assert.equal(supportsViewportModes("android", null), false);
  assert.equal(supportsViewportModes("android", undefined), false);
  assert.equal(supportsViewportModes("ios", null), true);
  assert.equal(supportsViewportModes("web", null), true);
});

test("the inset never goes negative and never exceeds the viewport", () => {
  const viewport = { width: 400, height: 800 };
  for (const height of [-1000, -1, 0, 799, 800, 801, 10_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const mode of ["legacy", "overlay"]) {
      const got = resolveKeyboardViewport({
        declared: mode,
        platform: "ios",
        keyboard: { visible: true, height },
        viewport,
      });
      assert.ok(got.insetHeight >= 0, `inset went negative for ${height}`);
      assert.ok(got.insetHeight <= viewport.height, `inset exceeded the viewport for ${height}`);
      assert.ok(got.boundingRect.y >= 0, `rect origin went negative for ${height}`);
      assert.ok(
        got.boundingRect.y + got.boundingRect.height <= viewport.height,
        `rect overflowed the viewport for ${height}`,
      );
    }
  }
});

test("the runtime plane reaches the two live states and never legacy", () => {
  assert.equal(modeForOverlaysContent(true), "overlay");
  assert.equal(modeForOverlaysContent(false), "resize");
});

test("a runtime assignment outranks every declared word, including an unrecognized one", () => {
  const geometry = {
    platform: "ios" as KeyboardPlatform,
    keyboard: { visible: true, height: 300 },
    viewport: { width: 400, height: 800 },
  };
  for (const declared of ["legacy", "resize", "overlay", "shrink", "", null]) {
    assert.equal(resolveKeyboardViewport({ ...geometry, declared, requested: false }).mode, "resize", String(declared));
    assert.equal(resolveKeyboardViewport({ ...geometry, declared, requested: true }).mode, "overlay", String(declared));
    // Absent, not merely falsy: `false` is a real request and must not read as "never asked".
    assert.equal(
      resolveKeyboardViewport({ ...geometry, declared, requested: null }).mode,
      parseKeyboardMode(declared),
      String(declared),
    );
  }
});

test("resize publishes a zero inset but a REAL rect — they answer different questions", () => {
  const got = resolveKeyboardViewport({
    declared: "resize",
    platform: "ios",
    keyboard: { visible: true, height: 300 },
    viewport: { width: 400, height: 800 },
  });
  assert.equal(got.insetHeight, 0, "the viewport already shrank; a non-zero inset double-counts");
  assert.equal(got.overlaysContent, false);
  assert.deepEqual(got.boundingRect, { x: 0, y: 500, width: 400, height: 300 });
});
