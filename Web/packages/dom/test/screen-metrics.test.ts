import { test } from "node:test";
import assert from "node:assert/strict";

import { screenMetrics } from "../src/boot.ts";

test("screen metrics use the canonical DSX breakpoint boundary table", () => {
  const cases = [
    { width: 0, height: 1, breakpoint: "sm", sizeClass: "compact", orientation: "portrait" },
    { width: 479, height: 800, breakpoint: "sm", sizeClass: "compact", orientation: "portrait" },
    { width: 480, height: 800, breakpoint: "md", sizeClass: "compact", orientation: "portrait" },
    { width: 767, height: 800, breakpoint: "md", sizeClass: "compact", orientation: "portrait" },
    { width: 768, height: 1024, breakpoint: "lg", sizeClass: "regular", orientation: "portrait" },
    { width: 1023, height: 768, breakpoint: "lg", sizeClass: "regular", orientation: "landscape" },
    { width: 1024, height: 1366, breakpoint: "xl", sizeClass: "regular", orientation: "portrait" },
  ] as const;

  for (const expected of cases) {
    assert.deepEqual(screenMetrics(expected.width, expected.height), expected);
  }
});

test("a square viewport is landscape on every renderer", () => {
  assert.deepEqual(screenMetrics(768, 768), {
    width: 768,
    height: 768,
    breakpoint: "lg",
    sizeClass: "regular",
    orientation: "landscape",
  });
});
