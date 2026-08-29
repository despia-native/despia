//
//  live.test.ts — the relay's pure logic, proven from node without workerd: token compare,
//  bounded reads, batch re-validation (never trust kind/at), cursor parsing, the error/CORS
//  fold, and the worker routes that touch no Durable Object (/verify with the prose-wrapped
//  and AI-blob pastes, /pair failing closed, 404/405 shape). The end-to-end proof under real
//  workerd is test/workers/live.workers.test.ts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LIVE_BATCH_MAX_ROWS, LIVE_MESSAGE_CAP, liveReportSeal } from "@despia/kernel";

import {
  LIVE_KEY_HEADER,
  bearerToken,
  clampInt,
  corsHeaders,
  errorResponse,
  parseBatchBody,
  parseCursor,
  parsePositiveInt,
  readBoundedText,
  sanitizeRow,
  tokenEquals,
  withCors,
  type LiveEnv,
} from "../src/wire.ts";
import worker from "../src/worker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "..", "Conformance", "livelogs", "report.json"), "utf-8"),
) as { verdict: { name: string; text: string; expect: { verdict: string; assertion: boolean } }[] };

/** the routes under test here never reach the namespace — anything that would is a bug */
const doLessEnv: LiveEnv = {
  SESSIONS: {
    idFromName() {
      throw new Error("unit tests must not reach the Durable Object namespace");
    },
    get() {
      throw new Error("unit tests must not reach the Durable Object namespace");
    },
  },
};

// ── token compare ────────────────────────────────────────────────────────────────────────

test("tokenEquals: equal admits; a one-byte difference, a length difference, and null refuse", () => {
  assert.equal(tokenEquals("dt_00ff", "dt_00ff"), true);
  assert.equal(tokenEquals("dt_00fe", "dt_00ff"), false);
  assert.equal(tokenEquals("dt_00f", "dt_00ff"), false);
  assert.equal(tokenEquals(null, "dt_00ff"), false);
  assert.equal(tokenEquals(undefined, "dt_00ff"), false);
  assert.equal(tokenEquals("", ""), true);
});

test("bearerToken: extracts the RFC shape case-insensitively, refuses everything else", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("  Bearer   abc  "), "abc");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer"), null);
  assert.equal(bearerToken(null), null);
});

// ── bounded reads ────────────────────────────────────────────────────────────────────────

test("readBoundedText: under the cap reads whole, over the cap refuses, absent body is empty", async () => {
  const small = new Request("https://r.test/x", { method: "POST", body: "hello" });
  assert.deepEqual(await readBoundedText(small, 16), { ok: true, text: "hello" });
  const big = new Request("https://r.test/x", { method: "POST", body: "x".repeat(33) });
  assert.deepEqual(await readBoundedText(big, 32), { ok: false });
  const empty = new Request("https://r.test/x", { method: "POST" });
  assert.deepEqual(await readBoundedText(empty, 16), { ok: true, text: "" });
});

// ── row re-validation: the relay never trusts kind/at ────────────────────────────────────

test("sanitizeRow: a cap that would strand a high surrogate retreats one unit", () => {
  // The kernel's foldMessage law, held on the relay's rebuild path too: a lone surrogate has
  // no UTF-8 encoding and must never reach the ring, the archive, or a wire frame.
  const message = "x".repeat(1999) + "\u{1F600}"; // unit 2000 is the high surrogate
  const row = sanitizeRow({ kind: "log", message, at: 5 });
  assert.equal(row?.message?.length, 1999, "the stranded high surrogate is retreated, not kept");
  const meta = "m".repeat(127) + "\u{1F600}"; // unit 128 is the high surrogate (META_FIELD_CAP)
  const metaRow = sanitizeRow({ kind: "log", scheme: meta, at: 5 });
  assert.equal(metaRow?.scheme?.length, 127);
});

test("sanitizeRow: a lawful row is rebuilt with known keys only", () => {
  const row = sanitizeRow({ kind: "log", scheme: "app", level: "warn", message: "m", at: 5, extra: "dropped" });
  assert.deepEqual(row, { kind: "log", scheme: "app", level: "warn", message: "m", at: 5 });
});

test("sanitizeRow: unknown kind, non-integer at, negative at, wrong-typed fields all refuse", () => {
  assert.equal(sanitizeRow({ kind: "root", at: 5 }), null);
  assert.equal(sanitizeRow({ kind: "log", at: 5.5 }), null);
  assert.equal(sanitizeRow({ kind: "log", at: -1 }), null);
  assert.equal(sanitizeRow({ kind: "log", at: "5" }), null);
  assert.equal(sanitizeRow({ kind: "log", at: 5, scheme: 7 }), null);
  assert.equal(sanitizeRow({ kind: "error", at: 5, recoverable: "yes" }), null);
  assert.equal(sanitizeRow("not a row"), null);
  assert.equal(sanitizeRow(null), null);
});

test("sanitizeRow: an oversize message is clipped to the corpus cap, not refused", () => {
  const row = sanitizeRow({ kind: "kernel", message: "x".repeat(LIVE_MESSAGE_CAP + 50), at: 1 });
  assert.equal(row?.message?.length, LIVE_MESSAGE_CAP);
});

test("parseBatchBody: a lawful batch parses; an empty rows array is a lawful heartbeat", () => {
  const good = parseBatchBody(JSON.stringify({ v: 1, sid: "s_9f2c00000000", n: 3, rows: [{ kind: "log", message: "hi", at: 1 }] }));
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.batch.n, 3);
    assert.deepEqual(good.batch.rows, [{ kind: "log", message: "hi", at: 1 }]);
  }
  const heartbeat = parseBatchBody(JSON.stringify({ v: 1, sid: "s_9f2c00000000", n: 4, rows: [] }));
  assert.equal(heartbeat.ok, true);
});

test("parseBatchBody: wrong version, bad sid, bad n, bad rows and a bad row all refuse with a named reason", () => {
  const sid = "s_9f2c00000000";
  const cases: [string, string][] = [
    [JSON.stringify({ v: 2, sid, n: 1, rows: [] }), "unsupported wire version"],
    [JSON.stringify({ v: 1, sid: "nope", n: 1, rows: [] }), "sid"],
    [JSON.stringify({ v: 1, sid, n: 0, rows: [] }), "n"],
    [JSON.stringify({ v: 1, sid, n: 1.5, rows: [] }), "n"],
    [JSON.stringify({ v: 1, sid, n: 1, rows: "x" }), "rows"],
    [JSON.stringify({ v: 1, sid, n: 1, rows: [{ kind: "nope", at: 1 }] }), "row 0 invalid"],
    ["not json", "body is not JSON"],
    ["[1,2]", "body is not an object"],
  ];
  for (const [text, message] of cases) {
    const parsed = parseBatchBody(text);
    assert.equal(parsed.ok, false, text);
    if (!parsed.ok) assert.equal(parsed.message, message);
  }
  const tooMany = parseBatchBody(
    JSON.stringify({ v: 1, sid, n: 1, rows: new Array(LIVE_BATCH_MAX_ROWS + 1).fill({ kind: "log", at: 1 }) }),
  );
  assert.equal(tooMany.ok, false);
});

// ── cursors + knobs ──────────────────────────────────────────────────────────────────────

test("parseCursor: decimal reads, everything else means from-the-beginning", () => {
  assert.equal(parseCursor("17"), 17);
  assert.equal(parseCursor(" 17 "), 17);
  assert.equal(parseCursor("0"), 0);
  assert.equal(parseCursor("-1"), 0);
  assert.equal(parseCursor("abc"), 0);
  assert.equal(parseCursor(null), 0);
  assert.equal(parseCursor("9".repeat(20)), 0);
});

test("parsePositiveInt and clampInt fall back on garbage and clamp on bounds", () => {
  assert.equal(parsePositiveInt("2500", 99), 2500);
  assert.equal(parsePositiveInt("0", 99), 99);
  assert.equal(parsePositiveInt("nope", 99), 99);
  assert.equal(parsePositiveInt(undefined, 99), 99);
  assert.equal(clampInt("50", 200, 1, 2000), 50);
  assert.equal(clampInt("999999999", 200, 1, 2000), 2000);
  assert.equal(clampInt("junk", 200, 1, 2000), 200);
  assert.equal(clampInt(null, 200, 1, 2000), 200);
});

// ── the response fold ────────────────────────────────────────────────────────────────────

test("errorResponse wears the one shape and withCors keeps body and status intact", async () => {
  const refused = withCors(errorResponse(405, "method_not_allowed", "POST only", { allow: "POST" }), "https://d.test");
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get("allow"), "POST");
  assert.equal(refused.headers.get("access-control-allow-origin"), "https://d.test");
  assert.deepEqual(await refused.json(), { ok: false, error: { code: "method_not_allowed", message: "POST only" } });
  assert.ok(corsHeaders("*")["access-control-allow-headers"]!.includes("last-event-id"));
});

// ── the DO-less worker routes ────────────────────────────────────────────────────────────

test("/verify: the corpus's AI-fabricated blob is not a report, in one paste", async () => {
  const blob = corpus.verdict.find((c) => c.name.includes("AI-fabricated"))!;
  const res = await worker.fetch(new Request("https://r.test/verify", { method: "POST", body: blob.text }), doLessEnv);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, verdict: "not_report", assertion: false });
});

test("/verify: a sealed report wrapped in chat prose is rescued and reads genuine", async () => {
  const sealed = liveReportSeal({ kind: "dsxreport", v: 1, app: { bundle: "com.x", build: "7" }, rings: { logs: [] } });
  const paste = `hi support, my app broke {again}. here is the export:\n${sealed.text}\nthanks!`;
  const res = await worker.fetch(new Request("https://r.test/verify", { method: "POST", body: paste }), doLessEnv);
  assert.deepEqual(await res.json(), { ok: true, verdict: "genuine", assertion: false });
});

test("/verify: prose alone is not a report; an oversized paste is refused 413", async () => {
  const prose = await worker.fetch(new Request("https://r.test/verify", { method: "POST", body: "here are my logs: everything broke" }), doLessEnv);
  assert.deepEqual(await prose.json(), { ok: true, verdict: "not_report", assertion: false });
  const huge = await worker.fetch(new Request("https://r.test/verify", { method: "POST", body: "x".repeat(300_000) }), doLessEnv);
  assert.equal(huge.status, 413);
});

test("/pair fails closed: no admin key configured reads exactly like an unknown route", async () => {
  const paired = await worker.fetch(
    new Request("https://r.test/pair", { method: "POST", headers: { [LIVE_KEY_HEADER]: "anything" } }),
    doLessEnv,
  );
  const missing = await worker.fetch(new Request("https://r.test/nope", { method: "POST" }), doLessEnv);
  assert.equal(paired.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await paired.json(), await missing.json());
});

test("route shape: wrong methods answer 405 with allow; OPTIONS preflights answer CORS", async () => {
  const got = await worker.fetch(new Request("https://r.test/verify", { method: "GET" }), doLessEnv);
  assert.equal(got.status, 405);
  assert.equal(got.headers.get("allow"), "POST");
  const feed = await worker.fetch(new Request("https://r.test/s/s_9f2c00000000/feed", { method: "POST" }), doLessEnv);
  assert.equal(feed.status, 405);
  assert.equal(feed.headers.get("allow"), "GET");
  const preflight = await worker.fetch(new Request("https://r.test/s/s_9f2c00000000/batch", { method: "OPTIONS" }), doLessEnv);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
});

test("a malformed sid never reaches the namespace: 404 before idFromName", async () => {
  const res = await worker.fetch(new Request("https://r.test/s/../secrets/rows?token=x", { method: "GET" }), doLessEnv);
  assert.equal(res.status, 404);
});
