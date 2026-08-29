//
//  capture-conformance.test.ts - the SHARED capture corpus through the TS kernel
//  (OpenSource/Conformance/capture/{element,offscreen,secure}.json). The Kotlin twin is
//  :core CaptureConformanceTest and the Swift reference is Engine/iOS/CaptureCore.swift.
//
//  Rasterising is platform work and is not pinned here. The arithmetic is: a card asked for
//  at 1200x630 must come out at 1200x630 on every renderer, and the 20000x20000 request has
//  to be refused BEFORE any allocation, which is the difference between an error and a
//  crash. The invariants that arithmetic cannot express (an Android video subtree not
//  capturing as black, an offscreen host never being visible, a secure surface refusing) are
//  declared in the corpus and asserted by each facet's own tests; this runner checks that
//  the declarations are present and coherent, so they cannot quietly disappear.
//
//  Missing corpus = loud failure.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  CAPTURE_FORMATS, CAPTURE_MAX_PIXELS, PDF_PAGE_SIZES,
  foldCaptureFormat, captureQuality, resolveCaptureScale, capturePixelSize,
  pdfPageSize, pdfMargins,
} from "../src/capture-core.ts";

type Dict = { [k: string]: unknown };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/capture");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/capture not found");
    dir = parent;
  }
}

function corpus(name: string): Dict {
  const doc = JSON.parse(readFileSync(join(corpusDir(), name), "utf-8")) as Dict;
  assert.equal(doc["version"], 1, `${name}: version`);
  return doc;
}

function rows<T>(doc: Dict, key: string): T[] {
  const list = doc[key];
  assert.ok(Array.isArray(list) && list.length > 0, `${key} must be a non-empty array`);
  return list as T[];
}

/** Every size row in both corpora shares one expect shape: a size, or an error. */
function assertSize(got: ReturnType<typeof capturePixelSize>, expect: Dict, label: string): void {
  if (expect["error"] !== undefined) {
    assert.equal(got.ok, false, `${label}: expected a refusal, got ${JSON.stringify(got)}`);
    assert.equal((got as { error: string }).error, expect["error"], `${label}: error`);
    return;
  }
  assert.equal(got.ok, true, `${label}: expected a size, got ${JSON.stringify(got)}`);
  const size = got as { width: number; height: number };
  assert.equal(size.width, expect["width"], `${label}: width`);
  assert.equal(size.height, expect["height"], `${label}: height`);
}

// ── element.json ─────────────────────────────────────────────────────────────────────────

test("capture element: the budget constant", () => {
  const budget = corpus("element.json")["budget"] as Dict;
  assert.equal(CAPTURE_MAX_PIXELS, budget["maxPixels"]);
});

test("capture element: the format fold", () => {
  for (const row of rows<Dict>(corpus("element.json"), "formats")) {
    assert.equal(foldCaptureFormat(row["input"] as string), row["expect"], row["name"] as string);
  }
  for (const format of CAPTURE_FORMATS) assert.equal(foldCaptureFormat(format), format);
});

test("capture element: quality is clamped, and a percent is read as a percent", () => {
  for (const row of rows<Dict>(corpus("element.json"), "quality")) {
    assert.equal(captureQuality(row["input"]), row["expect"], row["name"] as string);
  }
});

test("capture element: scale resolution", () => {
  for (const row of rows<Dict>(corpus("element.json"), "scale")) {
    const got = resolveCaptureScale(row["input"], row["deviceScale"] as number);
    const expect = row["expect"];
    if (typeof expect === "object" && expect !== null) {
      assert.equal(got.ok, false, `${row["name"]}: expected a refusal`);
      assert.equal((got as { error: string }).error, (expect as Dict)["error"], row["name"] as string);
      continue;
    }
    assert.equal(got.ok, true, `${row["name"]}: expected a scale`);
    assert.equal((got as { scale: number }).scale, expect, row["name"] as string);
  }
});

test("capture element: point size becomes exactly the pinned pixel size", () => {
  for (const row of rows<Dict>(corpus("element.json"), "pixels")) {
    assertSize(
      capturePixelSize(row["pointWidth"] as number, row["pointHeight"] as number, row["scale"] as number),
      row["expect"] as Dict, row["name"] as string);
  }
});

test("capture element: the invariants are declared", () => {
  const invariants = corpus("element.json")["invariants"] as Dict;
  for (const key of ["transparentByDefault", "videoSurfaceIsNotBlack", "refIsSurfaceScoped",
                     "notRenderedIsDistinct", "screenIsOurWindow"]) {
    assert.equal(typeof invariants[key], "string", `element.json must declare the ${key} invariant`);
    assert.ok((invariants[key] as string).length > 40, `${key} must say what the promise is`);
  }
});

// ── offscreen.json ───────────────────────────────────────────────────────────────────────

test("capture offscreen: a size the screen never held comes out exactly as asked", () => {
  for (const row of rows<Dict>(corpus("offscreen.json"), "sizes")) {
    assertSize(
      capturePixelSize(row["width"] as number, row["height"] as number, row["scale"] as number),
      row["expect"] as Dict, row["name"] as string);
  }
});

test("capture offscreen: attrs are data, never markup", () => {
  const attrs = corpus("offscreen.json")["attrs"] as Dict;
  for (const row of attrs["cases"] as Dict[]) {
    const given = row["attrs"] === null ? {} : row["attrs"];
    assert.deepEqual(given, row["expect"], row["name"] as string);
  }
  assert.equal(typeof attrs["neverMarkup"], "string");
});

test("capture offscreen: the invariants are declared", () => {
  const invariants = corpus("offscreen.json")["invariants"] as Dict;
  for (const key of ["neverVisible", "sizeIsIndependentOfScreen", "oneLayoutPass", "disposal",
                     "sameComponentRegistry", "noSideEffects"]) {
    assert.equal(typeof invariants[key], "string", `offscreen.json must declare the ${key} invariant`);
    assert.ok((invariants[key] as string).length > 40, `${key} must say what the promise is`);
  }
});

// ── secure.json ──────────────────────────────────────────────────────────────────────────

test("capture secure: the refusal covers every action that touches the live surface", () => {
  const doc = corpus("secure.json");
  const refusing = new Set<string>();
  const allowed = new Set<string>();
  for (const row of rows<Dict>(doc, "cases")) {
    const expect = row["expect"] as Dict;
    if (row["protected"] !== true) {
      assert.equal(expect["ok"], true, `${row["name"]}: an unprotected surface must capture`);
      continue;
    }
    if (expect["error"] === "secure_content") refusing.add(row["action"] as string);
    else allowed.add(row["action"] as string);
  }
  assert.deepEqual([...refusing].sort(), ["element", "pdf", "screen"],
    "every action that reads the live surface must refuse");
  assert.deepEqual([...allowed], ["offscreen"],
    "offscreen is the one allowed action, and that ruling must stay explicit");
});

test("capture secure: the refusal takes no override", () => {
  const spec = corpus("secure.json")["notOverridable"] as Dict;
  assert.equal(spec["code"], "secure_content");
  assert.equal(spec["recoverable"], false);
  const banned = spec["forbiddenArgs"] as string[];
  assert.ok(banned.length >= 4, "the forbidden-argument list must be more than a token gesture");
  // The manifest must not declare any of them on any action.
  const manifestPath = join(corpusDir(), "../../../ClosedSource/DSX/Modules/Core/Capture/dsx.json");
  if (existsSync(manifestPath)) {
    const actions = (JSON.parse(readFileSync(manifestPath, "utf-8")) as Dict)["actions"] as Dict;
    for (const [name, spec2] of Object.entries(actions)) {
      if (name === "_note" || typeof spec2 !== "object" || spec2 === null) continue;
      const args = ((spec2 as Dict)["args"] as Dict) ?? {};
      for (const arg of banned) {
        assert.ok(!(arg in args), `capture.${name} must not take '${arg}'`);
      }
    }
  }
});

test("capture secure: excludeSecure is not an override", () => {
  const spec = corpus("secure.json")["excludeSecure"] as Dict;
  const full = (spec["cases"] as Dict[]).find((c) => c["protected"] === true);
  assert.ok(full, "a fully protected case must be pinned");
  assert.equal((full["expect"] as Dict)["error"], "secure_content",
    "excludeSecure must not turn a fully protected surface into a capture");
});

// ── the PDF geometry (shared by capture.pdf) ─────────────────────────────────────────────

test("capture pdf: named page boxes are one size everywhere", () => {
  assert.deepEqual(pdfPageSize("a4"), { ok: true, width: 595.28, height: 841.89 });
  assert.deepEqual(pdfPageSize(""), { ok: true, width: 595.28, height: 841.89 });
  assert.deepEqual(pdfPageSize("Letter"), { ok: true, width: 612, height: 792 });
  assert.deepEqual(pdfPageSize("legal"), { ok: true, width: 612, height: 1008 });
  assert.deepEqual(pdfPageSize("a4/landscape"), { ok: true, width: 841.89, height: 595.28 });
  assert.deepEqual(pdfPageSize({ width: 300, height: 400 }), { ok: true, width: 300, height: 400 });
  assert.deepEqual(pdfPageSize("a9"), { ok: false, error: "invalid_page_size" });
  assert.deepEqual(pdfPageSize({ width: 0, height: 400 }), { ok: false, error: "invalid_page_size" });
  for (const name of Object.keys(PDF_PAGE_SIZES)) {
    const got = pdfPageSize(name);
    assert.equal(got.ok, true, `${name} must resolve`);
  }
});

test("capture pdf: margins fill from a number or an object", () => {
  assert.deepEqual(pdfMargins(undefined), { top: 36, right: 36, bottom: 36, left: 36 });
  assert.deepEqual(pdfMargins(0), { top: 0, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(pdfMargins(12), { top: 12, right: 12, bottom: 12, left: 12 });
  assert.deepEqual(pdfMargins({ top: 10 }), { top: 10, right: 36, bottom: 36, left: 36 });
  assert.deepEqual(pdfMargins({ top: 1, right: 2, bottom: 3, left: 4 }), { top: 1, right: 2, bottom: 3, left: 4 });
  assert.deepEqual(pdfMargins({ top: -5 }), { top: 36, right: 36, bottom: 36, left: 36 });
});
