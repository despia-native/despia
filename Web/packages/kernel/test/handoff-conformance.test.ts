//
//  handoff-conformance.test.ts — the SHARED CONTINUITY corpus
//  (OpenSource/Conformance/handoff/activity.json) through the TS core, the REFERENCE leg of
//  Core/Handoff (F17.8). The Kotlin twin (:core HandoffConformanceTest) and the Swift twin
//  (Engine/iOS/Handoff.swift) read the SAME file, so the payload ceiling is the same number of
//  the same bytes everywhere.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  HANDOFF_MAX_PAYLOAD_BYTES, HANDOFF_MAX_TITLE_CHARS,
  normalizeActivityType, normalizeHandoffUrl, canonicalHandoffJson, utf8ByteLength,
  handoffPayloadBytes, normalizeHandoff, parseHandoffContinuation,
  type RawHandoff,
} from "../src/handoff.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/handoff");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("handoff corpus not found");
    dir = parent;
  }
}

type Doc = {
  limits: Record<string, number>;
  activityType: { name: string; raw: string; ok: boolean; expect?: string; error?: string }[];
  url: { name: string; raw: string; ok: boolean; expect?: string; error?: string }[];
  canonical: { name: string; payload: unknown; ok: boolean; text?: string; bytes?: number; error?: string }[];
  activity: { name: string; raw: RawHandoff; ok: boolean; expect?: Record<string, unknown>; error?: string }[];
  oversize: { key: string; filler: string; repeat: number; error: string };
  continuation: { name: string; raw: RawHandoff; expect: Record<string, unknown> }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "activity.json"), "utf-8")) as Doc;

assert.ok(doc.activityType.length >= 9, "handoff/activityType corpus is suspiciously small");
assert.ok(doc.canonical.length >= 12, "handoff/canonical corpus is suspiciously small");

test("handoff — the pinned limits", () => {
  assert.equal(HANDOFF_MAX_PAYLOAD_BYTES, doc.limits["maxPayloadBytes"]);
  assert.equal(HANDOFF_MAX_TITLE_CHARS, doc.limits["maxTitleChars"]);
});

for (const c of doc.activityType) {
  test(`handoff/activityType — ${c.name}`, () => {
    const got = normalizeActivityType(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.url) {
  test(`handoff/url — ${c.name}`, () => {
    const got = normalizeHandoffUrl(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.canonical) {
  test(`handoff/canonical — ${c.name}`, () => {
    const got = canonicalHandoffJson(c.payload);
    assert.equal(got.ok, c.ok, got.ok ? "ok" : `ok (${(got as { detail?: string }).detail ?? ""})`);
    if (got.ok) {
      assert.equal(got.value, c.text, "canonical text");
      assert.equal(utf8ByteLength(got.value), c.bytes, "utf-8 bytes");
      const bytes = handoffPayloadBytes(c.payload);
      assert.ok(bytes.ok);
      if (bytes.ok) assert.equal(bytes.value, c.bytes, "handoffPayloadBytes");
    } else {
      assert.equal(got.error, c.error, "error");
    }
  });
}

for (const c of doc.activity) {
  test(`handoff/activity — ${c.name}`, () => {
    const got = normalizeHandoff(c.raw);
    assert.equal(got.ok, c.ok, got.ok ? "ok" : `ok (${(got as { detail?: string }).detail ?? ""})`);
    if (got.ok) {
      assert.equal(got.value.activity, c.expect!["activity"], "activity");
      assert.equal(got.value.title, c.expect!["title"], "title");
      assert.equal(got.value.url, c.expect!["url"], "url");
      assert.equal(got.value.payloadBytes, c.expect!["payloadBytes"], "payloadBytes");
    } else {
      assert.equal(got.error, c.error, "error");
    }
  });
}

test("handoff/oversize — a payload past the ceiling is refused with both numbers", () => {
  const blob = doc.oversize.filler.repeat(doc.oversize.repeat);
  const payload: Record<string, unknown> = { [doc.oversize.key]: blob };
  const bytes = handoffPayloadBytes(payload);
  assert.ok(bytes.ok);
  if (bytes.ok) {
    assert.ok(bytes.value > HANDOFF_MAX_PAYLOAD_BYTES,
      `the corpus filler must actually exceed the ceiling (${bytes.value})`);
  }
  const got = normalizeHandoff({ activity: "com.example.viewing", payload });
  assert.equal(got.ok, false);
  if (!got.ok) assert.equal(got.error, doc.oversize.error);
});

test("handoff/oversize — one byte under the ceiling still passes", () => {
  // `{"blob":"…"}` is 11 characters of envelope around the value.
  const envelope = utf8ByteLength('{"blob":""}');
  const blob = "a".repeat(HANDOFF_MAX_PAYLOAD_BYTES - envelope);
  const got = normalizeHandoff({ activity: "com.example.viewing", payload: { blob } });
  assert.equal(got.ok, true, "the exact ceiling is inclusive");
  if (got.ok) assert.equal(got.value.payloadBytes, HANDOFF_MAX_PAYLOAD_BYTES);
});

for (const c of doc.continuation) {
  test(`handoff/continuation — ${c.name}`, () => {
    const got = parseHandoffContinuation(c.raw);
    assert.equal(got.ok, true, "a continuation is normalised, not refused");
    if (!got.ok) return;
    assert.equal(got.value.activity, c.expect["activity"], "activity");
    assert.equal(got.value.title, c.expect["title"], "title");
    assert.equal(got.value.url, c.expect["url"], "url");
    assert.equal(got.value.payloadBytes, c.expect["payloadBytes"], "payloadBytes");
  });
}
