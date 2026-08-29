//
//  telemetry-conformance.test.ts — the SHARED telemetry corpus through the TS kernel
//  (OpenSource/Conformance/telemetry/{scrub,queue}.json). The Kotlin twin (:core
//  TelemetryConformanceTest) and the Swift reference (TelemetryPolicy) run the SAME files, so a
//  redaction rule cannot fire on one renderer and not another — which would be a privacy incident
//  with a platform column — and a crash loop cannot send a count on one platform and ten thousand
//  events on the next.
//
//  Imports the module directly rather than through the barrel: the export line in src/index.ts is
//  a shared file and lands with the coordinator's pass (see the F10 handoff block).
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  TELEMETRY_PLACEHOLDERS, TELEMETRY_SCRUB_ORDER, telemetryScrubText, telemetryScrubValue,
  telemetryIsSensitiveKey, telemetryArgShape, telemetryFingerprint, telemetryCollapseMessage,
  telemetrySampled, telemetryBackoffMs, TelemetryQueue,
} from "../src/telemetry.ts";

type TextCase = { name: string; input: string; expect: string };
type KeyCase = { key: string; sensitive: boolean };
type ValueCase = { name: string; key: string; value: string; expect: string };
type FingerprintCase = { name: string; source: string; code: string; message: string | null; expect: string };
type SamplingCase = { fingerprint: string; rate: number; expect: boolean };
type BackoffCase = { attempt: number; expect: number };
type QueueStep = { offer?: string; at?: number; batch?: boolean; ack?: number };
type QueueExpect = { outcome?: string; size?: number; dropped?: number; count?: number; batch?: string[] };
type QueueCase = {
  name: string; capacity: number; windowMs: number; maxBatch: number;
  steps: QueueStep[]; expect: QueueExpect[];
};

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/telemetry");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/telemetry not found");
    dir = parent;
  }
}

function corpus(file: string): { [k: string]: unknown } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as { [k: string]: unknown };
  assert.equal(doc["version"], 1, `${file}: version`);
  return doc;
}

test("telemetry: the placeholders and the rule order agree with the corpus", () => {
  const doc = corpus("scrub.json");
  assert.deepEqual(doc["placeholders"], { ...TELEMETRY_PLACEHOLDERS });
  assert.deepEqual(doc["order"], [...TELEMETRY_SCRUB_ORDER]);
});

test("telemetry: every redaction rule agrees with the corpus", () => {
  const cases = corpus("scrub.json")["text"] as TextCase[];
  assert.ok(cases.length > 0, "scrub text corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(telemetryScrubText(testCase.input), testCase.expect, testCase.name);
  }
});

test("telemetry: the non-matches survive untouched", () => {
  const cases = corpus("scrub.json")["survives"] as TextCase[];
  assert.ok(cases.length > 0, "scrub survives corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(testCase.expect, testCase.input, `${testCase.name}: a survivor's expect IS its input`);
    assert.equal(telemetryScrubText(testCase.input), testCase.input, testCase.name);
  }
});

test("telemetry: scrubbing is idempotent — a queued event is never scrubbed twice into mush", () => {
  const doc = corpus("scrub.json");
  for (const testCase of [...(doc["text"] as TextCase[]), ...(doc["survives"] as TextCase[])]) {
    assert.equal(telemetryScrubText(testCase.expect), testCase.expect, testCase.name);
  }
});

test("telemetry: the sensitive-key set agrees with the corpus", () => {
  const cases = corpus("scrub.json")["keys"] as KeyCase[];
  assert.ok(cases.length > 0, "key corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(telemetryIsSensitiveKey(testCase.key), testCase.sensitive, testCase.key);
  }
});

test("telemetry: key/value redaction agrees with the corpus", () => {
  const cases = corpus("scrub.json")["values"] as ValueCase[];
  assert.ok(cases.length > 0, "value corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(telemetryScrubValue(testCase.key, testCase.value), testCase.expect, testCase.name);
  }
});

test("telemetry: an arg shape carries keys and types, never values", () => {
  const shape = telemetryArgShape({ amount: 9.99, token: "sk_live_abc", ok: true, items: [1, 2], note: null });
  assert.deepEqual(shape, { amount: "number", items: "array", note: "null", ok: "boolean", token: "string" });
  assert.equal(JSON.stringify(shape).includes("sk_live_abc"), false, "no value may survive into the shape");
  assert.deepEqual(telemetryArgShape(null), {});
});

test("telemetry: the fingerprint fold agrees with the corpus", () => {
  const cases = corpus("queue.json")["fingerprint"] as FingerprintCase[];
  assert.ok(cases.length > 0, "fingerprint corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(telemetryFingerprint(testCase.source, testCase.code, testCase.message), testCase.expect, testCase.name);
  }
  assert.equal(telemetryCollapseMessage(null), "", "an absent message is an empty tail");
});

test("telemetry: sampling is deterministic and agrees with the corpus", () => {
  const cases = corpus("queue.json")["sampling"] as SamplingCase[];
  assert.ok(cases.length > 0, "sampling corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(telemetrySampled(testCase.fingerprint, testCase.rate), testCase.expect,
                 `${testCase.fingerprint} @ ${testCase.rate}`);
    assert.equal(telemetrySampled(testCase.fingerprint, testCase.rate), testCase.expect, "and again, identically");
  }
});

test("telemetry: the backoff schedule agrees with the corpus", () => {
  const cases = corpus("queue.json")["backoff"] as BackoffCase[];
  assert.ok(cases.length > 0, "backoff corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(telemetryBackoffMs(testCase.attempt), testCase.expect, `attempt ${testCase.attempt}`);
  }
});

test("telemetry: the bounded dedupe queue agrees with the corpus", () => {
  const cases = corpus("queue.json")["queue"] as QueueCase[];
  assert.ok(cases.length > 0, "queue corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(testCase.steps.length, testCase.expect.length, `${testCase.name}: one expectation per step`);
    const queue = new TelemetryQueue(testCase.capacity, testCase.windowMs, testCase.maxBatch);
    testCase.steps.forEach((step, index) => {
      const expected = testCase.expect[index]!;
      const where = `${testCase.name}: step ${index}`;
      if (step.offer !== undefined) {
        const actual = queue.offer(step.offer, step.at as number);
        assert.equal(actual.outcome, expected.outcome, `${where}: outcome`);
        assert.equal(actual.size, expected.size, `${where}: size`);
        assert.equal(actual.dropped, expected.dropped, `${where}: dropped`);
        assert.equal(actual.count, expected.count, `${where}: count`);
      } else if (step.batch === true) {
        assert.deepEqual(queue.batch(), expected.batch, `${where}: batch`);
      } else if (step.ack !== undefined) {
        assert.equal(queue.ack(step.ack).size, expected.size, `${where}: size after ack`);
      } else {
        throw new Error(`${where} names no operation`);
      }
    });
  }
});

test("telemetry: revoked consent clears the queue without counting the drop", () => {
  const queue = new TelemetryQueue(8, 1000, 4);
  queue.offer("a", 0);
  queue.offer("b", 10);
  queue.clear();
  assert.equal(queue.size, 0);
  assert.equal(queue.dropped, 0, "consent revocation is not a delivery failure");
});
