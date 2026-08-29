//
//  live.workers.test.ts — the relay under REAL workerd (the server-workers precedent): the
//  worker plus the LiveSession Durable Object are bundled with esbuild and booted in
//  miniflare, which runs the actual workerd binary — not a simulation. End to end: pair →
//  batch → cursor read → idempotent replay → the SSE feed (replay, live push, viewer-count
//  backpressure, self-close) → sealed-report verdicts → the ungated verifier → the token
//  boundary → Durable Object restart persistence → the opt-in R2 archive fold.
//

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

import { liveReportSeal } from "@despia-native/kernel";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, "..", "..", "..", "..");
// INSIDE the package's gitignored dist/, not the OS tmpdir: workerd resolves the script
// relative to its starting directory and refuses any path that needs `..` to escape it.
const scratch = join(here, "..", "..", "dist", "test-workers");
mkdirSync(scratch, { recursive: true });
const bundle = join(scratch, "live-worker.js");

const ADMIN_KEY = "test-admin-key-0123456789abcdef";
/** short on purpose so the self-close assertion runs in test time, not 55s */
const FEED_MAX_MS = 1500;
/** short on purpose so the poll-window expiry assertion runs in test time, not 10s */
const ROWS_WINDOW_MS = 800;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let mf: Miniflare;
const disposers: Miniflare[] = [];

interface Pairing {
  ok: boolean;
  sid: string;
  deviceToken: string;
  viewerToken: string;
  ttlMs: number;
}

interface Ack {
  ok: boolean;
  accepted: boolean;
  viewers: number;
  ttlMs: number;
  last: number;
}

const liveOptions = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  modules: true,
  scriptPath: bundle,
  // the manifest's date: the SSE ReadableStream constructor is compat-gated in workerd
  compatibilityDate: "2025-08-01",
  durableObjects: { SESSIONS: { className: "LiveSession", useSQLite: true } },
  bindings: { LIVE_ADMIN_KEY: ADMIN_KEY, LIVE_FEED_MAX_MS: String(FEED_MAX_MS), LIVE_ROWS_VIEWER_WINDOW_MS: String(ROWS_WINDOW_MS) },
  ...extra,
});

before(async () => {
  await build({
    entryPoints: [join(here, "..", "..", "src", "index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["import"],
    mainFields: ["module", "main"],
    outfile: bundle,
    logLevel: "silent",
  });
  mf = new Miniflare(liveOptions() as ConstructorParameters<typeof Miniflare>[0]);
  disposers.push(mf);
});

after(async () => {
  for (const instance of disposers) await instance.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

async function pairSession(instance: Miniflare): Promise<Pairing> {
  const res = await instance.dispatchFetch("https://live.test/pair", {
    method: "POST",
    headers: { "x-dsx-live-key": ADMIN_KEY },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Pairing;
}

async function postBatch(
  instance: Miniflare,
  session: Pairing,
  n: number,
  rows: unknown[],
  token?: string,
): Promise<Response> {
  return (await instance.dispatchFetch(`https://live.test/s/${session.sid}/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token ?? session.deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ v: 1, sid: session.sid, n, rows }),
  })) as unknown as Response;
}

async function readRows(instance: Miniflare, session: Pairing, after_: number): Promise<{
  ok: boolean;
  rows: { seq: number; row: { message?: string } }[];
  gap: boolean;
  last: number;
}> {
  const res = await instance.dispatchFetch(
    `https://live.test/s/${session.sid}/rows?after=${after_}&token=${session.viewerToken}`,
  );
  assert.equal(res.status, 200);
  return (await res.json()) as never;
}

/** pull an SSE body chunk by chunk, resolving when `wanted` appears — with a deadline so a
 *  regression fails instead of hanging the suite */
function feedTranscript(body: ReadableStream<Uint8Array>): {
  waitFor(wanted: string, ms: number): Promise<string>;
  end(ms: number): Promise<string>;
  cancel(): Promise<void>;
} {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let transcript = "";
  let done = false;
  const pump = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      transcript += decoder.decode(chunk.value, { stream: true });
    }
    done = true;
  })();
  return {
    async waitFor(wanted: string, ms: number): Promise<string> {
      const deadline = Date.now() + ms;
      while (!transcript.includes(wanted)) {
        if (done || Date.now() > deadline) {
          throw new Error(`feed never carried ${JSON.stringify(wanted)}; transcript so far:\n${transcript}`);
        }
        await sleep(20);
      }
      return transcript;
    },
    async end(ms: number): Promise<string> {
      const deadline = Date.now() + ms;
      while (!done) {
        if (Date.now() > deadline) throw new Error(`feed did not self-close; transcript:\n${transcript}`);
        await sleep(25);
      }
      await pump;
      return transcript;
    },
    async cancel(): Promise<void> {
      // through the reader — it holds the lock, so body.cancel() would throw
      await reader.cancel();
      await pump.catch(() => undefined);
    },
  };
}

// One session threads through the ordered wire tests below (node:test runs them serially).
let session: Pairing;

test("workerd: /pair without the admin key reads exactly like an unknown route", async () => {
  const bare = await mf.dispatchFetch("https://live.test/pair", { method: "POST" });
  const wrong = await mf.dispatchFetch("https://live.test/pair", {
    method: "POST",
    headers: { "x-dsx-live-key": "guess-key-0123456789abcdef00000" },
  });
  const unknown = await mf.dispatchFetch("https://live.test/definitely-not-a-route", { method: "POST" });
  assert.equal(bare.status, 404);
  assert.equal(wrong.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await bare.json(), await unknown.json());
});

test("workerd: /pair mints a session — sid shape, distinct tokens, a real ttl", async () => {
  session = await pairSession(mf);
  assert.equal(session.ok, true);
  assert.match(session.sid, /^s_[0-9a-f]{12}$/);
  assert.match(session.deviceToken, /^dt_[0-9a-f]{32}$/);
  assert.match(session.viewerToken, /^vt_[0-9a-f]{32}$/);
  assert.notEqual(session.deviceToken, session.viewerToken);
  assert.ok(session.ttlMs > 0);
});

test("workerd: batch n=1 lands two rows and acks {ok, viewers: 0, ttlMs}", async () => {
  const res = await postBatch(mf, session, 1, [
    { kind: "log", scheme: "app", level: "log", message: "checkout ready", at: 1756280000000 },
    { kind: "error", scheme: "dom", code: "eval_failed", recoverable: false, origin: "call", at: 1756280001000 },
  ]);
  assert.equal(res.status, 200);
  const ack = (await res.json()) as Ack;
  assert.equal(ack.ok, true);
  assert.equal(ack.accepted, true);
  assert.equal(ack.viewers, 0);
  assert.ok(ack.ttlMs > 0);
  assert.equal(ack.last, 2);
});

test("workerd: rows from cursor 0 replays both rows with monotonic seqs", async () => {
  const read = await readRows(mf, session, 0);
  assert.equal(read.gap, false);
  assert.equal(read.last, 2);
  assert.deepEqual(read.rows.map((entry) => entry.seq), [1, 2]);
  assert.equal(read.rows[0]!.row.message, "checkout ready");
});

test("workerd: a replayed batch index is refused once — rows cannot double", async () => {
  const res = await postBatch(mf, session, 1, [{ kind: "log", message: "retry duplicate", at: 1756280002000 }]);
  const ack = (await res.json()) as Ack;
  assert.equal(ack.ok, true);
  assert.equal(ack.accepted, false);
  const read = await readRows(mf, session, 0);
  assert.equal(read.rows.length, 2);
  assert.equal(read.last, 2);
});

test("workerd: batch n=2 continues the seq space", async () => {
  const ack = (await (await postBatch(mf, session, 2, [{ kind: "kernel", message: "booted", at: 1756280003000 }])).json()) as Ack;
  assert.equal(ack.accepted, true);
  assert.equal(ack.last, 3);
});

test("workerd: a recent rows poll counts as one viewer in the next ack, then expires", async () => {
  // The dashboard's R1 posture is plain polling — no feed. The ack must still tell the
  // device somebody is watching, or the wire pauses while the panel is open.
  await readRows(mf, session, 0);
  const polled = (await (await postBatch(mf, session, 3, [])).json()) as Ack;
  assert.equal(polled.viewers, 1);
  await sleep(ROWS_WINDOW_MS + 250);
  const expired = (await (await postBatch(mf, session, 4, [])).json()) as Ack;
  assert.equal(expired.viewers, 0);
});

test("workerd: the SSE feed replays from the cursor, carries live rows, moves the viewer count, and self-closes", async () => {
  const res = await mf.dispatchFetch(
    `https://live.test/s/${session.sid}/feed?after=0&token=${session.viewerToken}`,
  );
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));
  assert.ok(res.body !== null);
  const feed = feedTranscript(res.body as unknown as ReadableStream<Uint8Array>);

  // the replay leg: everything after cursor 0, in order, as `id:` events
  const replayed = await feed.waitFor("id: 3", 5_000);
  assert.ok(replayed.includes("retry: "));
  assert.ok(replayed.indexOf("id: 1") < replayed.indexOf("id: 2"));
  assert.ok(replayed.indexOf("id: 2") < replayed.indexOf("id: 3"));
  assert.ok(replayed.includes("checkout ready"));

  // the live leg + backpressure: with the feed open, the next ack counts one viewer
  const ack = (await (await postBatch(mf, session, 5, [{ kind: "log", message: "live row", at: 1756280004000 }])).json()) as Ack;
  assert.equal(ack.viewers, 1);
  const live = await feed.waitFor("id: 4", 5_000);
  assert.ok(live.includes("live row"));

  // the self-close: the stream ends at LIVE_FEED_MAX_MS so clients re-attach with a cursor
  await feed.end(FEED_MAX_MS + 5_000);

  // and once the viewer is gone the next ack says so
  const afterClose = (await (await postBatch(mf, session, 6, [])).json()) as Ack;
  assert.equal(afterClose.viewers, 0);
});

test("workerd: a feed resumed via Last-Event-ID replays only what the cursor missed", async () => {
  const res = await mf.dispatchFetch(
    `https://live.test/s/${session.sid}/feed?after=0&token=${session.viewerToken}`,
    { headers: { "last-event-id": "3" } },
  );
  const feed = feedTranscript(res.body as unknown as ReadableStream<Uint8Array>);
  const transcript = await feed.waitFor("id: 4", 5_000);
  assert.ok(!transcript.includes("id: 1"), "Last-Event-ID must beat the stale ?after= parameter");
  await feed.cancel();
});

test("workerd: the token boundary — garbage is 401, the other role's token is 403", async () => {
  const garbageBatch = await postBatch(mf, session, 9, [], "dt_ffffffffffffffffffffffffffffffff");
  assert.equal(garbageBatch.status, 401);
  const viewerWrites = await postBatch(mf, session, 9, [], session.viewerToken);
  assert.equal(viewerWrites.status, 403);
  const deviceReads = await mf.dispatchFetch(
    `https://live.test/s/${session.sid}/rows?after=0&token=${session.deviceToken}`,
  );
  assert.equal(deviceReads.status, 403);
  const bareRead = await mf.dispatchFetch(`https://live.test/s/${session.sid}/rows?after=0`);
  assert.equal(bareRead.status, 401);
  const bearerRead = await mf.dispatchFetch(`https://live.test/s/${session.sid}/rows?after=0`, {
    headers: { authorization: `Bearer ${session.viewerToken}` },
  });
  assert.equal(bearerRead.status, 200);
  const wrongFeed = await mf.dispatchFetch(`https://live.test/s/${session.sid}/feed?after=0&token=nope`);
  assert.equal(wrongFeed.status, 401);
});

test("workerd: an unpaired sid answers 404 even with a token", async () => {
  const res = await mf.dispatchFetch("https://live.test/s/s_000000000000/rows?after=0&token=vt_x");
  assert.equal(res.status, 404);
});

test("workerd: a sealed report uploads genuine; a tampered one reads modified", async () => {
  const sealed = liveReportSeal({
    kind: "dsxreport",
    v: 1,
    app: { bundle: "com.example.app", build: "42", channel: "testflight" },
    rings: { logs: [], errors: [], kernel: [] },
    totals: { logs: 0, errors: 0 },
  });
  const genuine = await mf.dispatchFetch(`https://live.test/s/${session.sid}/report`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.deviceToken}` },
    body: sealed.text,
  });
  assert.equal(genuine.status, 200);
  assert.deepEqual(await genuine.json(), { ok: true, verdict: "genuine", assertion: false });

  const tampered = await mf.dispatchFetch(`https://live.test/s/${session.sid}/report`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.deviceToken}` },
    body: sealed.text.replace('"build":"42"', '"build":"43"'),
  });
  assert.deepEqual(await tampered.json(), { ok: true, verdict: "modified", assertion: false });
});

test("workerd: /verify on the corpus's AI-blob paste answers not_report, ungated", async () => {
  const corpus = JSON.parse(
    readFileSync(join(workspace, "..", "Conformance", "livelogs", "report.json"), "utf-8"),
  ) as { verdict: { name: string; text: string }[] };
  const blob = corpus.verdict.find((c) => c.name.includes("AI-fabricated"))!;
  const res = await mf.dispatchFetch("https://live.test/verify", { method: "POST", body: blob.text });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, verdict: "not_report", assertion: false });
});

test("workerd: /s/:sid/attest stores a bounded envelope verbatim and refuses non-JSON", async () => {
  const stored = await mf.dispatchFetch(`https://live.test/s/${session.sid}/attest`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.deviceToken}` },
    body: JSON.stringify({ platform: "ios", keyId: "abc", assertion: "base64-bytes" }),
  });
  assert.deepEqual(await stored.json(), { ok: true });
  const refused = await mf.dispatchFetch(`https://live.test/s/${session.sid}/attest`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.deviceToken}` },
    body: "not json",
  });
  assert.equal(refused.status, 400);
});

test("workerd: Durable Object restart — the persisted wire survives a full instance teardown", async () => {
  const persist = join(scratch, "persist");
  const options = liveOptions({ durableObjectsPersist: persist }) as ConstructorParameters<typeof Miniflare>[0];
  const first = new Miniflare(options);
  let survivor: Pairing;
  try {
    survivor = await pairSession(first);
    const ack = (await (await postBatch(first, survivor, 1, [
      { kind: "log", message: "before restart", at: 1756280000000 },
      { kind: "log", message: "also before", at: 1756280000500 },
    ])).json()) as Ack;
    assert.equal(ack.last, 2);
  } finally {
    await first.dispose();
  }

  const second = new Miniflare(options);
  disposers.push(second);
  // rows survived, with the same seqs
  const read = await readRows(second, survivor!, 0);
  assert.deepEqual(read.rows.map((entry) => entry.seq), [1, 2]);
  assert.equal(read.rows[0]!.row.message, "before restart");
  // the idempotency key survived: a replay of batch 1 cannot double rows after restart
  const replay = (await (await postBatch(second, survivor!, 1, [{ kind: "log", message: "dup", at: 1 }])).json()) as Ack;
  assert.equal(replay.accepted, false);
  assert.equal((await readRows(second, survivor!, 0)).rows.length, 2);
  // and the seq space continues where it stopped
  const next = (await (await postBatch(second, survivor!, 2, [{ kind: "log", message: "after restart", at: 2 }])).json()) as Ack;
  assert.equal(next.last, 3);
});

test("workerd: the opt-in ARCHIVE fold — an ended session lands as one R2 object", async () => {
  const archived = new Miniflare(
    liveOptions({
      r2Buckets: ["ARCHIVE"],
      bindings: {
        LIVE_ADMIN_KEY: ADMIN_KEY,
        LIVE_FEED_MAX_MS: String(FEED_MAX_MS),
        LIVE_SESSION_TTL_MS: "400",
      },
    }) as ConstructorParameters<typeof Miniflare>[0],
  );
  disposers.push(archived);
  const short = await pairSession(archived);
  const ack = (await (await postBatch(archived, short, 1, [{ kind: "log", message: "kept", at: 1 }])).json()) as Ack;
  assert.equal(ack.accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const late = await postBatch(archived, short, 2, [{ kind: "log", message: "too late", at: 2 }]);
  assert.equal(late.status, 410);
  // structural, not miniflare's ReplaceWorkersTypes mapping — only get/text is needed here
  const bucket = (await archived.getR2Bucket("ARCHIVE")) as unknown as {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
  const object = await bucket.get(`sessions/${short.sid}.json`);
  assert.ok(object !== null, "the ended session was not archived");
  const body = JSON.parse(await object!.text()) as { sid: string; rows: { row: { message?: string } }[] };
  assert.equal(body.sid, short.sid);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0]!.row.message, "kept");
});
