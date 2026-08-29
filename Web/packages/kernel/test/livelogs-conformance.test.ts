//
//  livelogs-conformance.test.ts — the SHARED live-logs corpus through the TS kernel
//  (OpenSource/Conformance/livelogs/{wire,report}.json). The Kotlin twin (:core
//  LiveLogsConformanceTest) and the Swift twin (LiveLogs) run the SAME files, so what leaves a
//  device, how the relay assigns and replays seq, and what the report verifier says about a
//  pasted blob cannot differ by renderer — the verdicts ARE the support macro, and a verdict
//  that flips per platform would re-open the exact incident the feature exists to close.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  LIVE_WIRE_VERSION, LIVE_MESSAGE_CAP, LIVE_BATCH_MAX_ROWS, LIVE_QUEUE_CAP,
  LIVE_IDLE_ACK_PAUSE, LIVE_RING_CAP,
  liveRowFromLog, liveRowFromError, liveRowFromKernel, liveBatchBody,
  liveAckStart, liveAckFold, liveAckExpire, LiveQueue, LiveRing,
  liveCanonical, liveSha256Hex, liveReportSeal, liveReportVerdict,
  type LiveAckState,
} from "../src/livelogs.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/livelogs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/livelogs not found");
    dir = parent;
  }
}

function corpus(file: string): { [k: string]: unknown } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as { [k: string]: unknown };
  assert.equal(doc["version"], 1, `${file}: version`);
  return doc;
}

function cases<T>(file: string, key: string): T[] {
  const list = corpus(file)[key] as T[];
  assert.ok(Array.isArray(list) && list.length > 0, `${file} ${key} corpus must not be empty`);
  return list;
}

test("livelogs: the constants agree with the corpus", () => {
  const constants = corpus("wire.json")["constants"] as { [k: string]: number };
  assert.equal(constants["wireVersion"], LIVE_WIRE_VERSION);
  assert.equal(constants["messageCap"], LIVE_MESSAGE_CAP);
  assert.equal(constants["batchMaxRows"], LIVE_BATCH_MAX_ROWS);
  assert.equal(constants["queueCap"], LIVE_QUEUE_CAP);
  assert.equal(constants["idleAckPause"], LIVE_IDLE_ACK_PAUSE);
  assert.equal(constants["ringCap"], LIVE_RING_CAP);
});

type RowCase = { name: string; kind: string; entry: { [k: string]: unknown }; at: number; expect: { [k: string]: unknown } };

test("livelogs: every row fold agrees with the corpus", () => {
  for (const testCase of cases<RowCase>("wire.json", "rows")) {
    let row: unknown;
    if (testCase.kind === "log") {
      row = liveRowFromLog(testCase.entry as { scheme: string; level: string; message: string }, testCase.at);
    } else if (testCase.kind === "error") {
      row = liveRowFromError(testCase.entry as {
        scheme: string; code: string; message?: string | null; recoverable: boolean; origin: string;
      }, testCase.at);
    } else if (testCase.kind === "kernel") {
      row = liveRowFromKernel((testCase.entry as { line: string }).line, testCase.at);
    } else {
      throw new Error(`${testCase.name}: unknown kind ${testCase.kind}`);
    }
    assert.deepEqual(row, testCase.expect, testCase.name);
  }
});

type BatchCase = { name: string; sid: string; n: number; rows: never[]; expect?: unknown; canonical?: string };

test("livelogs: the batch body agrees with the corpus", () => {
  for (const testCase of cases<BatchCase>("wire.json", "batch")) {
    const body = liveBatchBody(testCase.sid, testCase.n, testCase.rows);
    if (testCase.expect !== undefined) assert.deepEqual(body, testCase.expect, testCase.name);
    if (testCase.canonical !== undefined) assert.equal(liveCanonical(body), testCase.canonical, testCase.name);
  }
});

type AckStep = { ack?: { ok: boolean; viewers: number; ttlMs: number }; expire?: boolean; at: number };
type AckExpect = { [k: string]: unknown };
type AckCase = { name: string; steps: AckStep[]; expect: AckExpect[] };

test("livelogs: the ack fold agrees with the corpus", () => {
  for (const testCase of cases<AckCase>("wire.json", "ack")) {
    assert.equal(testCase.steps.length, testCase.expect.length, `${testCase.name}: one expectation per step`);
    let state: LiveAckState = liveAckStart();
    testCase.steps.forEach((step, index) => {
      const where = `${testCase.name}: step ${index}`;
      if (step.ack !== undefined) state = liveAckFold(state, step.ack, step.at);
      else if (step.expire === true) state = liveAckExpire(state, step.at);
      else throw new Error(`${where} names no operation`);
      for (const [key, value] of Object.entries(testCase.expect[index]!)) {
        assert.deepEqual((state as unknown as { [k: string]: unknown })[key], value, `${where}: ${key}`);
      }
    });
  }
});

type QueueStep = { push?: string; batch?: number; ack?: number };
type QueueExpect = { size?: number; dropped?: number; batch?: string[] };
type QueueCase = { name: string; cap: number; steps: QueueStep[]; expect: QueueExpect[] };

test("livelogs: the bounded device queue agrees with the corpus", () => {
  for (const testCase of cases<QueueCase>("wire.json", "queue")) {
    assert.equal(testCase.steps.length, testCase.expect.length, `${testCase.name}: one expectation per step`);
    const queue = new LiveQueue<string>(testCase.cap);
    testCase.steps.forEach((step, index) => {
      const expected = testCase.expect[index]!;
      const where = `${testCase.name}: step ${index}`;
      if (step.push !== undefined) {
        const actual = queue.push(step.push);
        assert.equal(actual.size, expected.size, `${where}: size`);
        assert.equal(actual.dropped, expected.dropped, `${where}: dropped`);
      } else if (step.batch !== undefined) {
        assert.deepEqual(queue.batch(step.batch), expected.batch, `${where}: batch`);
      } else if (step.ack !== undefined) {
        assert.equal(queue.ack(step.ack).size, expected.size, `${where}: size after ack`);
      } else {
        throw new Error(`${where} names no operation`);
      }
    });
  }
});

type RingStep = { appendBatch?: { n: number; rows: string[] }; read?: { after: number; limit: number } };
type RingExpect = { accepted?: boolean; last?: number; seqs?: number[]; gap?: boolean };
type RingCase = { name: string; cap: number; steps: RingStep[]; expect: RingExpect[] };

test("livelogs: the relay ring agrees with the corpus", () => {
  for (const testCase of cases<RingCase>("wire.json", "ring")) {
    assert.equal(testCase.steps.length, testCase.expect.length, `${testCase.name}: one expectation per step`);
    const ring = new LiveRing<string>(testCase.cap);
    testCase.steps.forEach((step, index) => {
      const expected = testCase.expect[index]!;
      const where = `${testCase.name}: step ${index}`;
      if (step.appendBatch !== undefined) {
        const actual = ring.appendBatch(step.appendBatch.n, step.appendBatch.rows);
        assert.equal(actual.accepted, expected.accepted, `${where}: accepted`);
        assert.equal(actual.last, expected.last, `${where}: last`);
      } else if (step.read !== undefined) {
        const actual = ring.read(step.read.after, step.read.limit);
        assert.deepEqual(actual.rows.map((entry) => entry.seq), expected.seqs, `${where}: seqs`);
        assert.equal(actual.gap, expected.gap, `${where}: gap`);
      } else {
        throw new Error(`${where} names no operation`);
      }
    });
  }
});

type ShaCase = { input: string; expect: string };

test("livelogs: sha256 agrees with the standard vectors", () => {
  for (const testCase of cases<ShaCase>("report.json", "sha256")) {
    assert.equal(liveSha256Hex(testCase.input), testCase.expect, JSON.stringify(testCase.input.slice(0, 24)));
  }
});

type CanonicalCase = { name: string; value: unknown; expect: string };

test("livelogs: canonical bytes agree with the corpus", () => {
  for (const testCase of cases<CanonicalCase>("report.json", "canonical")) {
    assert.equal(liveCanonical(testCase.value), testCase.expect, testCase.name);
  }
});

test("livelogs: what has no canonical form is refused", () => {
  for (const testCase of cases<{ name: string; value: unknown }>("report.json", "canonicalRejects")) {
    assert.throws(() => liveCanonical(testCase.value), testCase.name);
  }
});

type SealCase = { name: string; body: { [k: string]: unknown }; hash: string; text: string };

test("livelogs: the report seal agrees with the corpus", () => {
  for (const testCase of cases<SealCase>("report.json", "seal")) {
    const sealed = liveReportSeal(testCase.body);
    assert.equal(sealed.hash, testCase.hash, `${testCase.name}: hash`);
    assert.equal(sealed.text, testCase.text, `${testCase.name}: text`);
    assert.deepEqual(liveReportVerdict(sealed.text), { verdict: "genuine", assertion: false },
                     `${testCase.name}: a fresh seal verifies`);
  }
});

type VerdictCase = { name: string; text: string; expect: { verdict: string; assertion: boolean } };

test("livelogs: the verifier verdicts agree with the corpus", () => {
  for (const testCase of cases<VerdictCase>("report.json", "verdict")) {
    assert.deepEqual(liveReportVerdict(testCase.text), testCase.expect, testCase.name);
  }
});
