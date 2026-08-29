//
//  linkpreview-conformance.test.ts — the SHARED LINK-PREVIEW corpus
//  (OpenSource/Conformance/preview/metadata.json) through the TS core, the REFERENCE leg of
//  Core/Preview (F17.1). The Kotlin twin (:core LinkPreviewConformanceTest) and the Swift
//  twin (Engine/iOS/LinkPreview.swift, record lane) read the SAME file, so `og:image` cannot
//  resolve to three different URLs on three renderers.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  PREVIEW_MAX_BYTES, PREVIEW_MAX_REDIRECTS, PREVIEW_DEFAULT_TIMEOUT_MS,
  PREVIEW_MIN_TIMEOUT_MS, PREVIEW_MAX_TIMEOUT_MS,
  clampPreviewTimeout, resolvePreviewTarget, resolvePreviewReference,
  decodePreviewEntities, collapsePreviewText, previewSiteFallback, parseLinkPreview,
  type PreviewTarget,
} from "../src/linkpreview.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/preview");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("preview corpus not found");
    dir = parent;
  }
}

type Doc = {
  budget: { maxBytes: number; maxRedirects: number; defaultTimeoutMs: number; minTimeoutMs: number; maxTimeoutMs: number };
  timeout: { name: string; raw: unknown; expect: number }[];
  url: { name: string; raw: string; ok: boolean; value?: Record<string, string>; error?: string }[];
  reference: { name: string; base: string; ref: string; expect: string }[];
  entities: { name: string; raw: string; expect: string }[];
  collapse: { name: string; raw: string; expect: string }[];
  siteFallback: { name: string; host: string; expect: string }[];
  parse: { name: string; requestUrl: string; html: string; expect: Record<string, string> }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "metadata.json"), "utf-8")) as Doc;

assert.ok(doc.url.length >= 18, "preview/url corpus is suspiciously small");
assert.ok(doc.reference.length >= 14, "preview/reference corpus is suspiciously small");
assert.ok(doc.parse.length >= 14, "preview/parse corpus is suspiciously small");

test("preview — the pinned fetch budget", () => {
  assert.equal(PREVIEW_MAX_BYTES, doc.budget.maxBytes);
  assert.equal(PREVIEW_MAX_REDIRECTS, doc.budget.maxRedirects);
  assert.equal(PREVIEW_DEFAULT_TIMEOUT_MS, doc.budget.defaultTimeoutMs);
  assert.equal(PREVIEW_MIN_TIMEOUT_MS, doc.budget.minTimeoutMs);
  assert.equal(PREVIEW_MAX_TIMEOUT_MS, doc.budget.maxTimeoutMs);
});

for (const c of doc.timeout) {
  test(`preview/timeout — ${c.name}`, () => {
    assert.equal(clampPreviewTimeout(c.raw), c.expect);
  });
}

for (const c of doc.url) {
  test(`preview/url — ${c.name}`, () => {
    const got = resolvePreviewTarget(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) {
      assert.deepEqual(
        { url: got.value.url, origin: got.value.origin, host: got.value.host, scheme: got.value.scheme, path: got.value.path },
        c.value,
      );
    } else {
      assert.equal(got.error, c.error, "error");
    }
  });
}

function targetOf(raw: string): PreviewTarget {
  const got = resolvePreviewTarget(raw);
  assert.ok(got.ok, `corpus base is not a valid URL: ${raw}`);
  return got.value;
}

for (const c of doc.reference) {
  test(`preview/reference — ${c.name}`, () => {
    assert.equal(resolvePreviewReference(targetOf(c.base), c.ref), c.expect);
  });
}

for (const c of doc.entities) {
  test(`preview/entities — ${c.name}`, () => {
    assert.equal(decodePreviewEntities(c.raw), c.expect);
  });
}

for (const c of doc.collapse) {
  test(`preview/collapse — ${c.name}`, () => {
    assert.equal(collapsePreviewText(c.raw), c.expect);
  });
}

for (const c of doc.siteFallback) {
  test(`preview/siteFallback — ${c.name}`, () => {
    assert.equal(previewSiteFallback(c.host), c.expect);
  });
}

for (const c of doc.parse) {
  test(`preview/parse — ${c.name}`, () => {
    const got = parseLinkPreview(c.html, targetOf(c.requestUrl));
    assert.deepEqual(
      {
        title: got.title, description: got.description, image: got.image,
        siteName: got.siteName, favicon: got.favicon, type: got.type, canonical: got.canonical,
      },
      c.expect,
    );
  });
}
