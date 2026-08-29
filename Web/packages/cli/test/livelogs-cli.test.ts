//
//  livelogs-cli.test.ts — the CLI legs of live-logs (proposals/live-logs.md P1):
//  `despia report verify` (the support macro as a command, exit codes = verdicts) and the dev
//  server's logs door (a device batch-POSTs, the terminal tails, the same rows answer the
//  relay-shaped poll read). The verdict LAW lives in the livelogs corpus; what is proven here
//  is the plumbing around it — extraction from prose, exit codes, the door's validation, the
//  idempotent batch index, and that a malformed paste dies exactly like the motivating
//  incident's AI-fabricated blob.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { liveReportSeal, LiveRing, LIVE_RING_CAP } from "@despia-native/kernel";

import { runCli, type Io } from "../src/cli.ts";
import { handleLogsDoor, formatLiveRow, devLogsAck, LOGS_PATH } from "../src/dev.ts";

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

function sealedReport(): string {
  return liveReportSeal({
    v: 1, kind: "dsxreport",
    app: { name: "Fittest", version: "2.1.0", build: 260, bundle: "com.acme.fittest", channel: "testflight", host: "" },
    device: { model: "iPhone17,2", os: "ios", osVersion: "26.5", locale: "en_US" },
    capturedAt: 1756280010000,
    totals: { logs: 1, errors: 0, kernel: 0 },
    rows: [{ kind: "log", scheme: "app", level: "log", message: "checkout ready", at: 1756280000000 }],
  }).text;
}

function writeTemp(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dsx-report-"));
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

test("report verify: a genuine seal exits 0, even wrapped in Copy-report prose", async () => {
  const paste = `DSX diagnostics — Fittest v2.1.0 (260) · channel: testflight\n`
    + `── verifiable envelope (.dsxreport) ──\n${sealedReport()}\nthanks!`;
  const io = capture();
  assert.equal(await runCli(["report", "verify", writeTemp("paste.txt", paste)], io), 0);
  assert.match(io.lines.join("\n"), /genuine/);
});

test("report verify: an edited report exits 2 as modified", async () => {
  const tampered = sealedReport().replace("checkout ready", "checkout was ready");
  const io = capture();
  assert.equal(await runCli(["report", "verify", writeTemp("tampered.txt", tampered)], io), 2);
  assert.match(io.lines.join("\n"), /modified/);
});

test("report verify: the motivating incident's AI blob exits 3 as not a report", async () => {
  const blob = JSON.stringify({
    capturedAt: "2026-08-27T09:03:33.001Z",
    sessionId: "ca0fbd90-b537-40e6-9c19-544bb5eee408",
    platform: { userAgent: "despia-iphone", isDespia: true },
    context: { workout_lifecycle_v2: { state: "active" } },
    events: [{ kind: "v2_binding_ok" }],
  });
  const io = capture();
  assert.equal(await runCli(["report", "verify", writeTemp("blob.json", blob)], io), 3);
  assert.match(io.lines.join("\n"), /not a report/);
});

test("report verify: usage errors exit 1", async () => {
  assert.equal(await runCli(["report", "verify"], capture()), 1);
  assert.equal(await runCli(["report", "frobnicate", "x"], capture()), 1);
  assert.equal(await runCli(["report", "verify", "/nonexistent/definitely-missing"], capture()), 1);
});

test("the logs door: batches land, tail, dedupe by n, and answer the poll read", async () => {
  const ring = new LiveRing<unknown>(LIVE_RING_CAP);
  const tail: string[] = [];
  const server = createServer((req, res) => {
    if (!handleLogsDoor(req, res, ring, (line) => tail.push(line))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const rows = [
      { kind: "log", scheme: "app", level: "log", message: "hello", at: 1756280000000 },
      { kind: "error", scheme: "dom", code: "eval_failed", recoverable: false, origin: "call", at: 1756280001000 },
    ];
    const post = (body: unknown) => fetch(`${base}${LOGS_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const first = await post({ v: 1, sid: "s_1", n: 1, rows });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), JSON.parse(devLogsAck()));
    assert.equal(tail.length, 2, "both rows tailed");
    assert.match(tail[1]!, /CALL FAILED dom -> eval_failed/);

    const replay = await post({ v: 1, sid: "s_1", n: 1, rows });
    assert.equal(replay.status, 200, "a retried batch still acks");
    assert.equal(tail.length, 2, "but never tails twice");

    const bad = await post({ v: 2, n: 1, rows: [] });
    assert.equal(bad.status, 400);

    const read = await fetch(`${base}${LOGS_PATH}?after=0&limit=10`);
    const feed = await read.json() as { rows: Array<{ seq: number }>; gap: boolean; last: number };
    assert.deepEqual(feed.rows.map((r) => r.seq), [1, 2]);
    assert.equal(feed.gap, false);
    assert.equal(feed.last, 2);

    const resume = await fetch(`${base}${LOGS_PATH}?after=1&limit=10`);
    const rest = await resume.json() as { rows: Array<{ seq: number }> };
    assert.deepEqual(rest.rows.map((r) => r.seq), [2]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("the logs door: the relay's own /s/:sid/* shape answers on the same ring", async () => {
  const ring = new LiveRing<unknown>(LIVE_RING_CAP);
  const tail: string[] = [];
  const server = createServer((req, res) => {
    if (!handleLogsDoor(req, res, ring, (line) => tail.push(line))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // a DEVICE paired with relay=<this server> posts the module's exact transport shape
    const posted = await fetch(`${base}/s/s_abc/batch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, sid: "s_abc", n: 1, rows: [
        { kind: "log", scheme: "app", level: "log", message: "paired hello", at: 1756280000000 },
      ] }),
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(await posted.json(), JSON.parse(devLogsAck()));
    assert.equal(tail.length, 1);

    const read = await fetch(`${base}/s/s_abc/rows?after=0&limit=10`);
    const feed = await read.json() as { rows: Array<{ seq: number }>; last: number };
    assert.deepEqual(feed.rows.map((r) => r.seq), [1]);

    const report = await fetch(`${base}/s/s_abc/report`, { method: "POST", body: sealedReport() });
    assert.deepEqual(await report.json(), { ok: true, verdict: "genuine", assertion: false });
    assert.match(tail.join("\n"), /report received — verdict genuine/);

    const attest = await fetch(`${base}/s/s_abc/attest`, {
      method: "POST", body: JSON.stringify({ platform: "ios", keyId: "k", assertion: "b64" }),
    });
    assert.deepEqual(await attest.json(), { ok: true });

    const wrongVerb = await fetch(`${base}/s/s_abc/batch`);
    assert.equal(wrongVerb.status, 405);
    const notADoor = await fetch(`${base}/s/s_abc/frobnicate`);
    assert.equal(notADoor.status, 404);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("formatLiveRow: the Console's plain-English tags, one line each", () => {
  assert.equal(
    formatLiveRow({ kind: "log", scheme: "app", level: "log", message: "hi", at: 1756280000000 }),
    "[live 07:33:20] app: hi",
  );
  assert.match(
    formatLiveRow({ kind: "error", scheme: "app", code: "uncaught", origin: "uncaught", message: "boom", at: 1756280000000 }),
    /CRASH app -> uncaught : boom/,
  );
  assert.match(formatLiveRow({ kind: "kernel", message: "booted", at: 1756280000000 }), /kernel \| booted/);
  assert.match(formatLiveRow({ kind: "log", scheme: "console", level: "warn", message: "slow", at: 0 }), /WARN console: slow/);
});

test("formatLiveRow: hostile rows cannot break the terminal or throw", () => {
  // ANSI escapes and control characters print as spaces — a device writes the tail line's
  // CONTENT, never the terminal's state
  const hostile = formatLiveRow({
    kind: "log", scheme: "app\u001b[2J", level: "log",
    message: "a\u001b]0;owned\u0007b\r\nc", at: 1756280000000,
  });
  assert.ok(!hostile.includes("\u001b"));
  assert.ok(!hostile.includes("\r"));
  assert.ok(!hostile.includes("\u0007"));
  // a forged timestamp past the Date range falls back instead of throwing
  assert.match(formatLiveRow({ kind: "log", message: "x", at: 9e15 }), /--:--:--/);
  assert.match(formatLiveRow({ kind: "log", message: "x", at: Number.MAX_SAFE_INTEGER }), /--:--:--/);
});
