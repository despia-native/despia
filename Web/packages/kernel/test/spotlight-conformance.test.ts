//
//  spotlight-conformance.test.ts — the SHARED SEARCH-INDEX corpus
//  (OpenSource/Conformance/spotlight/index.json) through the TS core, the REFERENCE leg of
//  Core/Spotlight (F17.7). The Kotlin twin (:core SpotlightConformanceTest) and the Swift twin
//  (Engine/iOS/Spotlight.swift) read the SAME file, so a tap on an indexed item resolves to the
//  same route on every platform.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  SPOTLIGHT_BATCH_MAX, SPOTLIGHT_MAX_ID_CHARS, SPOTLIGHT_MAX_TITLE_CHARS,
  SPOTLIGHT_MAX_DESCRIPTION_CHARS, SPOTLIGHT_MAX_KEYWORDS,
  normalizeSearchDomain, searchUniqueId, parseSearchUniqueId, normalizeSearchKeywords,
  normalizeSearchItem, normalizeSearchItems, chunkSearchItems,
  type RawSearchItem,
} from "../src/spotlight.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/spotlight");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("spotlight corpus not found");
    dir = parent;
  }
}

type Doc = {
  limits: Record<string, number>;
  domain: { name: string; raw: unknown; ok: boolean; expect?: string; error?: string }[];
  uniqueId: { name: string; domain: string; id: string; expect: string }[];
  parseUniqueId: { name: string; raw: string; ok: boolean; domain?: string; id?: string }[];
  keywords: { name: string; raw: unknown; expect: string[] }[];
  item: { name: string; raw: RawSearchItem; ok: boolean; expect?: unknown; error?: string }[];
  batch: { name: string; raw: unknown; ok: boolean; count?: number; error?: string }[];
  chunk: { name: string; count: number; max: number; sizes: number[] }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "index.json"), "utf-8")) as Doc;

assert.ok(doc.item.length >= 10, "spotlight/item corpus is suspiciously small");
assert.ok(doc.parseUniqueId.length >= 5, "spotlight/parseUniqueId corpus is suspiciously small");

test("spotlight — the pinned limits", () => {
  assert.equal(SPOTLIGHT_BATCH_MAX, doc.limits["batchMax"]);
  assert.equal(SPOTLIGHT_MAX_ID_CHARS, doc.limits["maxIdChars"]);
  assert.equal(SPOTLIGHT_MAX_TITLE_CHARS, doc.limits["maxTitleChars"]);
  assert.equal(SPOTLIGHT_MAX_DESCRIPTION_CHARS, doc.limits["maxDescriptionChars"]);
  assert.equal(SPOTLIGHT_MAX_KEYWORDS, doc.limits["maxKeywords"]);
});

for (const c of doc.domain) {
  test(`spotlight/domain — ${c.name}`, () => {
    const got = normalizeSearchDomain(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.uniqueId) {
  test(`spotlight/uniqueId — ${c.name}`, () => {
    const encoded = searchUniqueId(c.domain, c.id);
    assert.equal(encoded, c.expect);
    // Every encode case is also a round trip: the encoding's only real contract.
    assert.deepEqual(parseSearchUniqueId(encoded), { domain: c.domain, id: c.id });
  });
}

for (const c of doc.parseUniqueId) {
  test(`spotlight/parseUniqueId — ${c.name}`, () => {
    const got = parseSearchUniqueId(c.raw);
    if (c.ok) assert.deepEqual(got, { domain: c.domain, id: c.id });
    else assert.equal(got, null);
  });
}

for (const c of doc.keywords) {
  test(`spotlight/keywords — ${c.name}`, () => {
    assert.deepEqual([...normalizeSearchKeywords(c.raw)], c.expect);
  });
}

for (const c of doc.item) {
  test(`spotlight/item — ${c.name}`, () => {
    const got = normalizeSearchItem(c.raw);
    assert.equal(got.ok, c.ok, got.ok ? "ok" : `ok (${(got as { detail?: string }).detail ?? ""})`);
    if (got.ok) assert.deepEqual(JSON.parse(JSON.stringify(got.value)), c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.batch) {
  test(`spotlight/batch — ${c.name}`, () => {
    const got = normalizeSearchItems(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value.length, c.count);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.chunk) {
  test(`spotlight/chunk — ${c.name}`, () => {
    const items = Array.from({ length: c.count }, (_, i) => i);
    assert.deepEqual(chunkSearchItems(items, c.max).map((g) => g.length), c.sizes);
  });
}
