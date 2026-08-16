//
//  upload-conformance.test.ts — the file-input routing corpus runner (TS lane).
//  Executes OpenSource/Conformance/upload/routing.json against routeFilePicker; the Kotlin
//  (:core) and Swift twins run the SAME file.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import { routeFilePicker, cameraMediaScope, acceptEntries } from "../src/upload.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/upload/routing.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/upload/routing.json not found");
    dir = parent;
  }
}

const corpus = JSON.parse(readFileSync(corpusFile(), "utf8")) as {
  cases: Array<{
    name: string;
    accept: string | null;
    capture: string | null;
    nativeInterception?: boolean;
    expect: Record<string, unknown>;
  }>;
};

test("file-input routing corpus", () => {
  assert.ok(corpus.cases.length > 0, "corpus is empty");
  for (const c of corpus.cases) {
    const got = routeFilePicker({
      accept: c.accept,
      capture: c.capture,
      nativeInterception: c.nativeInterception,
    });
    assert.deepEqual(got, c.expect, c.name);
  }
});

test("an accept list is normalized, never trusted as written", () => {
  assert.deepEqual(acceptEntries(" .PDF ,, image/PNG ,"), [".pdf", "image/png"]);
  assert.deepEqual(acceptEntries(null), []);
  assert.deepEqual(acceptEntries(",,,"), []);
});

test("scope is 'both' exactly when there is nothing to narrow", () => {
  assert.equal(cameraMediaScope(null), "both");
  assert.equal(cameraMediaScope("image/*,video/*"), "both");
  assert.equal(cameraMediaScope("image/*,.pdf"), "both");
  assert.equal(cameraMediaScope("image/*"), "imagesOnly");
  assert.equal(cameraMediaScope("video/mp4,video/quicktime"), "videosOnly");
});

test("a document route never hands back an EMPTY type list", () => {
  // An empty list would be a picker that can select nothing at all — worse than an unfiltered one.
  for (const accept of [".pdf", "application/octet-stream", "image/*,.pdf", "text/plain"]) {
    const got = routeFilePicker({ accept, capture: null });
    if (got.route === "documents") assert.ok(got.types.length > 0, accept);
  }
});
