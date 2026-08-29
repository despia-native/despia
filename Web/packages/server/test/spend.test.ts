//
//  spend.test.ts — the SPEND PLANE (cost-guardrails.md): the corpus, the write-behind flush,
//  and the wiring into every seam that costs money.
//
//  The corpus half executes OpenSource/Conformance/spend/spend.json — the platform-neutral
//  laws (window arithmetic, budget resolution, verdict transitions). The rest pins what a
//  corpus cannot: ORDER (a tripped deployment refuses before identity and body work), COST
//  (N charges are ONE store statement — the meter must never become the bill), FAILURE (a
//  store outage loses no units and holds the last known verdict), and the doorbell's shape
//  (one signed POST per transition, verifiable, absent unless configured).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHost, type HostConfig, type ServerRoute } from "../src/host.ts";
import { hostOptions, readServerConfig } from "../src/config.ts";
import { declaredHandler } from "../src/actions.ts";
import {
  chargeSpend,
  configureSpend,
  flushSpendIfDue,
  flushSpendNow,
  queueDepthCeiling,
  resetSpend,
  SpendSeam,
  spendHeaders,
  spendSnapshot,
  windowEnd,
  windowStart,
  type SpendBudget,
} from "../src/spend.ts";
import { RealtimeSeam, type RealtimeTransport } from "../src/realtime.ts";
import { enqueueMessage, QueueSeam, type QueueEnqueueRequest, type QueueTransport } from "../src/queue.ts";
import { buildQueueEnqueueStatement, buildSpendAddStatement, buildSpendReadStatement } from "../src/postgres.ts";
import { installEntities, RepoSeam } from "../src/repo.ts";
import { createMcpFace } from "../src/mcp-face.ts";
import { RunnerFetchSeam } from "@despia-native/kernel";

// ── the corpus ──────────────────────────────────────────────────────────────────────────

function corpusPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "OpenSource/Conformance/spend/spend.json");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("OpenSource/Conformance/spend/spend.json not found above the test directory");
}

interface Corpus {
  windows: { name: string; per: SpendBudget["per"]; nowMs: number; startMs: number; endMs: number }[];
  resolution: { name: string; budgets: string[]; kind: string; match: string | null }[];
  verdicts: {
    name: string;
    budget: SpendBudget;
    charges: number;
    allowedCount: number;
    transitions: string[];
    finalCount?: number;
    advanceMs?: number;
    chargesAfter?: number;
    allowedAfter?: number;
  }[];
}

const corpus = JSON.parse(readFileSync(corpusPath(), "utf8")) as Corpus;

/** Every test starts from a bare plane and bare seams — a leaked configuration is a test that
 *  passes for the wrong deployment. */
function bare(): void {
  resetSpend();
  SpendSeam.store = null;
  RealtimeSeam.transport = null;
  QueueSeam.transport = null;
  RepoSeam.transport = null;
}

function feedSink(): { published: { channel: string; payload: Record<string, unknown> }[] } {
  const published: { channel: string; payload: Record<string, unknown> }[] = [];
  const transport: RealtimeTransport = {
    publish: async (event) => {
      published.push({ channel: event.channel, payload: event.payload });
      return String(published.length);
    },
    read: async () => [],
  };
  RealtimeSeam.transport = transport;
  return { published };
}

test("spend corpus: window arithmetic", () => {
  for (const row of corpus.windows) {
    assert.equal(windowStart(row.per, row.nowMs), row.startMs, row.name);
    assert.equal(windowEnd(row.per, row.startMs), row.endMs, `${row.name} (end)`);
  }
});

test("spend corpus: budget resolution", () => {
  for (const row of corpus.resolution) {
    bare();
    // Finite ceiling of 0 units: the FIRST charge on a matched budget refuses and names it,
    // so `match` is observable without reaching into the plane's internals.
    configureSpend(row.budgets.map((of) => ({ of, per: "day", max: 0 })));
    const verdict = chargeSpend(row.kind);
    if (row.match === null) {
      assert.equal(verdict.allowed, true, row.name);
      assert.equal(verdict.budget, null, row.name);
    } else {
      assert.equal(verdict.allowed, false, row.name);
      assert.equal(verdict.budget, row.match, row.name);
    }
  }
});

test("spend corpus: verdicts and transitions", async () => {
  for (const row of corpus.verdicts) {
    bare();
    const { published } = feedSink();
    let nowMs = 1_000_000; // inside the first epoch day
    configureSpend([row.budget], { now: () => nowMs });

    let allowed = 0;
    for (let i = 0; i < row.charges; i++) if (chargeSpend(row.budget.of).allowed) allowed++;
    assert.equal(allowed, row.allowedCount, row.name);

    if (row.advanceMs !== undefined) {
      nowMs += row.advanceMs;
      let allowedAfter = 0;
      for (let i = 0; i < (row.chargesAfter ?? 0); i++) if (chargeSpend(row.budget.of).allowed) allowedAfter++;
      assert.equal(allowedAfter, row.allowedAfter ?? 0, `${row.name} (after roll)`);
    }

    await flushSpendNow();
    assert.deepEqual(
      published.map((e) => e.payload["kind"]),
      row.transitions,
      `${row.name} (transitions)`,
    );
    for (const e of published) assert.equal(e.channel, "dsx_spend", row.name);

    if (row.finalCount !== undefined) {
      const snapshot = spendSnapshot();
      assert.equal(snapshot.budgets[0]?.count, row.finalCount, `${row.name} (count)`);
    }
  }
});

// ── the flush: cost, failure, reconciliation ────────────────────────────────────────────

function countingStore(): { adds: number; reads: number; counts: Map<string, number>; fail: boolean } {
  const state = { adds: 0, reads: 0, counts: new Map<string, number>(), fail: false };
  SpendSeam.store = {
    add: async (entries) => {
      if (state.fail) throw new Error("store down");
      state.adds++;
      return entries.map((e) => {
        const key = `${e.bucket}@${e.windowStartMs}`;
        const next = (state.counts.get(key) ?? 0) + e.n;
        state.counts.set(key, next);
        return { bucket: e.bucket, count: next };
      });
    },
    read: async (entries) => {
      if (state.fail) throw new Error("store down");
      state.reads++;
      return entries.map((e) => ({ bucket: e.bucket, count: state.counts.get(`${e.bucket}@${e.windowStartMs}`) ?? 0 }));
    },
  };
  return state;
}

test("the meter is not the bill: a thousand charges are ONE store statement", async () => {
  bare();
  const store = countingStore();
  configureSpend([{ of: "requests", per: "day", max: 1_000_000 }]);
  for (let i = 0; i < 1000; i++) chargeSpend("requests");
  await flushSpendNow();
  assert.equal(store.adds, 1);
  assert.equal(store.counts.get(`spend|requests@${windowStart("day", Date.now())}`), 1000);
  // …and a second flush with nothing new does not even reach the store's add path.
  await flushSpendNow();
  assert.equal(store.adds, 1);
});

test("a store outage loses no units — they carry to the next flush", async () => {
  bare();
  const store = countingStore();
  configureSpend([{ of: "requests", per: "day", max: 100 }]);
  for (let i = 0; i < 5; i++) chargeSpend("requests");
  store.fail = true;
  await flushSpendNow(); // swallowed, reported to the sink, units kept
  store.fail = false;
  for (let i = 0; i < 3; i++) chargeSpend("requests");
  await flushSpendNow();
  assert.equal(store.counts.get(`spend|requests@${windowStart("day", Date.now())}`), 8);
});

test("another isolate's spending trips this one at the flush — without re-ringing the bell", async () => {
  bare();
  const store = countingStore();
  const { published } = feedSink();
  configureSpend([{ of: "requests", per: "day", max: 10 }]);
  // The other isolate has already burned the whole ceiling.
  store.counts.set(`spend|requests@${windowStart("day", Date.now())}`, 50);
  chargeSpend("requests");
  await flushSpendNow();
  // This isolate is now tripped by reconciliation…
  assert.equal(chargeSpend("requests").allowed, false);
  // …and emitted NO trip transition of its own: the isolate that crossed the line rang the bell.
  assert.deepEqual(published.map((e) => e.payload["kind"]), []);
});

test("flushSpendIfDue: quiet until the cadence, immediate when a transition waits", () => {
  bare();
  countingStore();
  let nowMs = 5_000_000;
  configureSpend([{ of: "requests", per: "day", max: 2 }], { now: () => nowMs });
  assert.equal(flushSpendIfDue(), null); // nothing charged, nothing due
  chargeSpend("requests");
  assert.equal(flushSpendIfDue(), null); // charged, but the cadence has not elapsed
  nowMs += 6_000;
  assert.notEqual(flushSpendIfDue(), null); // due and dirty
  chargeSpend("requests");
  chargeSpend("requests"); // the trip
  const urgent = flushSpendIfDue();
  assert.notEqual(urgent, null, "a waiting transition must not sit out the interval");
});

// ── the doorbell ────────────────────────────────────────────────────────────────────────

test("the beacon: one signed POST per trip, verifiable, and absent unless BOTH halves are configured", async () => {
  bare();
  feedSink();
  const rings: { url: string; body: string; signature: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    rings.push({
      url: String(input),
      body: String(init?.body ?? ""),
      signature: new Headers(init?.headers).get("x-dsx-signature"),
    });
    return new Response("ok");
  }) as typeof fetch;
  try {
    configureSpend([{ of: "requests", per: "day", max: 1 }]);
    chargeSpend("requests");
    chargeSpend("requests"); // trip
    // Half-configured: URL without key → silence. An unsigned beacon is never sent.
    await flushSpendNow((key) => (key === "DSX_SPEND_BEACON_URL" ? "https://ingest.example.test/spend" : undefined));
    assert.equal(rings.length, 0);

    bare();
    feedSink();
    configureSpend([{ of: "requests", per: "day", max: 1 }]);
    chargeSpend("requests");
    chargeSpend("requests");
    chargeSpend("requests"); // further refusals are NOT further transitions
    const env = (key: string): string | undefined =>
      key === "DSX_SPEND_BEACON_URL"
        ? "https://ingest.example.test/spend"
        : key === "DSX_SPEND_BEACON_KEY"
          ? "hunter2"
          : key === "DSX_SPEND_BEACON_APP"
            ? "app_123"
            : undefined;
    await flushSpendNow(env);
    await flushSpendNow(env);
    assert.equal(rings.length, 1, "edge-triggered: one trip, one ring, however many refusals follow");
    const ring = rings[0]!;
    assert.equal(ring.url, "https://ingest.example.test/spend");
    const expected = createHmac("sha256", "hunter2").update(ring.body).digest("hex");
    assert.equal(ring.signature, expected, "the ingest side must be able to verify before doing any work");
    const payload = JSON.parse(ring.body) as Record<string, unknown>;
    assert.equal(payload["app"], "app_123", "the ingest attributes and picks the verification key BY the app id");
    assert.equal(payload["kind"], "spend.tripped");
    assert.equal(payload["budget"], "requests");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── the host wiring ─────────────────────────────────────────────────────────────────────

function hostWith(routes: ServerRoute[], extra?: Partial<HostConfig>): ReturnType<typeof createHost> {
  const handlers: HostConfig["handlers"] = { t: { run: async () => ({ done: true }) } };
  return createHost({ routes, handlers, ...extra });
}

const CALL = (path = "/x", init?: RequestInit): Request => new Request(`https://server.test${path}`, { method: "POST", ...init });

test("a tripped deployment answers 429 spend_capped BEFORE identity and body work — and names the budget", async () => {
  bare();
  configureSpend([{ of: "requests", per: "day", max: 1 }]);
  const host = hostWith([{ key: "x", chain: "t", action: "run", method: "POST", path: "/x", auth: "required" }]);
  // First request: charged, then refused by auth — the charge sits before the 401 on purpose
  // (a stranger's request is exactly the traffic the ceiling must see).
  assert.equal((await host.handle(CALL())).status, 401);
  const refused = await host.handle(CALL());
  assert.equal(refused.status, 429);
  const body = (await refused.json()) as Record<string, unknown>;
  assert.equal(body["reason"], "spend_capped");
  assert.equal(refused.headers.get("x-dsx-spend-budget"), "requests");
  assert.ok(Number(refused.headers.get("retry-after")) >= 1);
});

test("internal dispatch is never charged: a spent request ceiling cannot stop the queue draining", async () => {
  bare();
  configureSpend([{ of: "requests", per: "day", max: 0 }]); // spent from the first external request
  const host = hostWith(
    [{ key: "drain", chain: "t", action: "run", method: "POST", path: "/internal/q/drain", auth: "required", reach: [], worker: "q" }],
    { internalKey: "k" },
  );
  const res = await host.handle(CALL("/internal/q/drain", { headers: { "x-dsx-internal-key": "k" } }));
  assert.equal(res.status, 200);
});

test("a declared-CRUD row charges the data plane at dispatch, before the body is read", async () => {
  bare();
  configureSpend([{ of: "data:writes", per: "day", max: 1 }]);
  const host = hostWith([{ key: "make", chain: "t", action: "run", method: "POST", path: "/notes", entity: "note", op: "create" }]);
  assert.equal((await host.handle(CALL("/notes"))).status, 200);
  const refused = await host.handle(CALL("/notes"));
  assert.equal(refused.status, 429);
  assert.equal(((await refused.json()) as Record<string, unknown>)["reason"], "spend_capped");
});

// ── the review's second round: regressions pinned before the dev merge ──────────────────

test("flushSpendNow coalesces with an in-flight flush: the same units are never billed twice", async () => {
  bare();
  // A store whose FIRST add blocks until released, so a second flush can arrive mid-flight.
  const counts = new Map<string, number>();
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = new Promise<void>((r) => { release = r; });
  SpendSeam.store = {
    add: async (entries) => {
      const wait = gate;
      gate = null;
      if (wait !== null) await wait;
      return entries.map((e) => {
        const key = `${e.bucket}@${e.windowStartMs}`;
        const next = (counts.get(key) ?? 0) + e.n;
        counts.set(key, next);
        return { bucket: e.bucket, count: next };
      });
    },
    read: async () => [],
  };
  configureSpend([{ of: "requests", per: "day", max: 1_000_000 }]);
  for (let i = 0; i < 100; i++) chargeSpend("requests");
  const first = flushSpendNow();
  const second = flushSpendNow(); // the scheduled tick arriving while the first is mid store.add
  release!();
  await Promise.all([first, second]);
  assert.equal(
    counts.get(`spend|requests@${windowStart("day", Date.now())}`), 100,
    "a concurrent forced flush must chain behind the in-flight one, not re-bill its snapshot",
  );
});

test("a multi-unit charge that jumps past the ceiling still emits the warning before the trip", async () => {
  bare();
  countingStore();
  const { published } = feedSink();
  configureSpend([{ of: "requests", per: "day", max: 10 }]);
  assert.equal(chargeSpend("requests", 12).allowed, false);
  await flushSpendNow();
  assert.deepEqual(
    published.map((e) => e.payload["kind"]), ["spend.warning", "spend.tripped"],
    "the dashboard sequence is warning-then-trip even when one charge spans both lines",
  );
});

test("hostOptions refuses a budget max that is NaN, zero, negative or fractional", () => {
  for (const max of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => hostOptions(readServerConfig({ settings: { spend_budgets: [{ of: "requests", per: "day", max }] } })),
      /malformed row/,
      `max=${max} guards nothing and must throw at boot`,
    );
  }
  const ok = hostOptions(readServerConfig({ settings: { spend_budgets: [{ of: "requests", per: "day", max: 5 }, { of: "data:reads", per: "hour", max: "unbounded" }] } }));
  assert.equal(ok.spend?.length, 2);
});

test("an internal declared-CRUD dispatch is metered by the data plane but never refused by it", async () => {
  bare();
  configureSpend([{ of: "data:writes", per: "day", max: 0 }]); // spent before the first write
  const host = hostWith(
    [{ key: "sweep", chain: "t", action: "run", method: "POST", path: "/internal/sweep", auth: "required", reach: [], worker: "q", entity: "note", op: "create" }],
    { internalKey: "k" },
  );
  const res = await host.handle(CALL("/internal/sweep", { headers: { "x-dsx-internal-key": "k" } }));
  assert.equal(res.status, 200, "a spent data ceiling must not stop the server working on its own behalf");
});

test("a worker body's data seam is metered but never refused: a budget trip must not dead-letter the queue", async () => {
  bare();
  configureSpend([{ of: "data:writes", per: "day", max: 0 }]);
  const written: string[] = [];
  installEntities([{ entity: "sweepnote", fields: { a: "number" }, ownership: "public" }]);
  RepoSeam.transport = async (q) => {
    if (q.op === "create") written.push(q.entity);
    return { id: "1" };
  };
  const handler = declaredHandler({ chain: "t", name: "run", body: "const row = await dsx.module.data.sweepnote.create({ values: { a: 1 } })\nreturn { ok: row.ok }", egress: [] });
  const host = createHost({
    routes: [{ key: "drain", chain: "t", action: "run", method: "POST", path: "/internal/q/drain", auth: "required", reach: [], worker: "q" }],
    handlers: { t: { run: handler } },
    serviceRoles: ["service"],
  });
  const service = { role: "service", sub: "svc" };
  const res = await host.handle(CALL("/internal/q/drain"), { identity: service });
  assert.equal(res.status, 200);
  assert.equal(written.length, 1, "the write itself must go through — the ceiling meters internal work, it does not park it");
  assert.equal(((await res.json()) as { ok?: unknown }).ok, true);
  // The same body on an EXTERNAL route is refused: the exemption is the dispatch's, not the verb's.
  const outside = createHost({
    routes: [{ key: "x", chain: "t", action: "run", method: "POST", path: "/x" }],
    handlers: { t: { run: handler } },
  });
  const refused = await outside.handle(CALL(), { identity: service });
  const body = (await refused.json()) as Record<string, unknown>;
  assert.notEqual((body as { ok?: unknown }).ok, true, "an external caller still meets the ceiling");
  assert.equal(written.length, 1, "the refused external write must never reach the transport");
});

test("the spend face preflight never advertises the internal key as a browser header", async () => {
  bare();
  configureSpend([{ of: "requests", per: "day", max: 100 }]);
  const host = hostWith([], { internalKey: "k" });
  const preflight = await host.handle(new Request("https://server.test/dsx-internal/spend", { method: "OPTIONS" }));
  const allowed = preflight.headers.get("access-control-allow-headers") ?? "";
  assert.ok(allowed.includes("x-dsx-spend-token"), "the read token is the browser path");
  assert.ok(!allowed.includes("x-dsx-internal-key"),
    "advertising the internal key invites the service credential into browser-held storage");
});

// ── the internal read face ──────────────────────────────────────────────────────────────

test("/dsx-internal/spend: 404 to strangers, the snapshot to the key, the read token, and CORS for the browser", async () => {
  bare();
  configureSpend([{ of: "requests", per: "day", max: 100 }]);
  chargeSpend("requests");
  const host = hostWith([], { internalKey: "k" });
  const url = "/dsx-internal/spend";

  const stranger = await host.handle(new Request(`https://server.test${url}`));
  assert.equal(stranger.status, 404); // the prober's answer, byte-identical to an absent route

  const keyed = await host.handle(new Request(`https://server.test${url}`, { headers: { "x-dsx-internal-key": "k" } }));
  assert.equal(keyed.status, 200);
  const snapshot = (await keyed.json()) as { budgets: { of: string; count: number }[] };
  assert.equal(snapshot.budgets[0]?.of, "requests");
  assert.equal(snapshot.budgets[0]?.count, 1);
  assert.equal(keyed.headers.get("access-control-allow-origin"), "*");

  const env = (key: string): string | undefined => (key === "DSX_SPEND_READ_TOKEN" ? "tok" : undefined);
  const wrongToken = await host.handle(new Request(`https://server.test${url}`, { headers: { "x-dsx-spend-token": "nope" } }), { env });
  assert.equal(wrongToken.status, 404);
  const token = await host.handle(new Request(`https://server.test${url}`, { headers: { "x-dsx-spend-token": "tok" } }), { env });
  assert.equal(token.status, 200);

  const preflight = await host.handle(new Request(`https://server.test${url}`, { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.ok((preflight.headers.get("access-control-allow-headers") ?? "").includes("x-dsx-spend-token"));

  const posted = await host.handle(new Request(`https://server.test${url}`, { method: "POST", headers: { "x-dsx-internal-key": "k" } }));
  assert.equal(posted.status, 404); // read-only: any other verb is the same absent route
});

// ── the seams inside a declared body ────────────────────────────────────────────────────

function actionHost(body: string, options: { egress?: string[] } = {}): ReturnType<typeof createHost> {
  const handler = declaredHandler({ chain: "t", name: "run", body, egress: options.egress ?? [] });
  return createHost({
    routes: [{ key: "x", chain: "t", action: "run", method: "POST", path: "/x" }],
    handlers: { t: { run: handler } },
  });
}

async function runBody(host: ReturnType<typeof createHost>, args: Record<string, unknown> = {}): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await host.handle(new Request("https://server.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  }));
  return { res, body: (await res.json()) as Record<string, unknown> };
}

test("egress ceiling: the admitted call is counted, the capped one never leaves the process", async () => {
  bare();
  configureSpend([{ of: "egress:api.stripe.com", per: "day", max: 1 }]);
  const fetched: string[] = [];
  RunnerFetchSeam.impl = async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, data: {} };
  };
  try {
    const host = actionHost(
      "const a = await fetch('https://api.stripe.com/v1/charges')\nconst b = await fetch('https://api.stripe.com/v1/charges')\nreturn { a: a.status, b: b.status }",
      { egress: ["api.stripe.com"] },
    );
    const { body } = await runBody(host);
    assert.equal(body["a"], 200);
    // The capped call answers the refused shape (-2): the request NEVER left the process, which
    // is the property that matters. The named reason lives on the feed and the snapshot.
    assert.equal(body["b"], -2);
    assert.equal(fetched.length, 1, "a refused call must not reach the network seam");
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("queue ceiling: a capped push answers spend_capped at the seam, and the depth ceiling travels to the transport", async () => {
  bare();
  // max 0: the very first SEAM push refuses. (The direct enqueueMessage below is deliberately
  // uncharged — the charge lives at the module seam, host-tier code meters itself.)
  configureSpend([{ of: "queue:billing", per: "day", max: 0, depth: 7 }]);
  const seen: QueueEnqueueRequest[] = [];
  const transport: QueueTransport = {
    enqueue: async (request) => {
      seen.push(request);
      return { id: "1", duplicate: false };
    },
    claim: async () => [],
    settle: async () => ({ acked: 0, released: 0 }),
    deadLetter: async () => 0,
    listDeadLetters: async () => [],
    replayDeadLetters: async () => 0,
  };
  QueueSeam.transport = transport;

  assert.equal(queueDepthCeiling("billing"), 7);
  await enqueueMessage("billing", "k1", {});
  assert.equal(seen[0]?.maxPending, 7, "the declared depth must reach the transport's statement");

  const host = actionHost("const r = await dsx.module.queue.billing.push({ key: 'k2', payload: {} })\nreturn { ok: r.ok, error: r.error }");
  const { body } = await runBody(host);
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "spend_capped");
  assert.equal(seen.length, 1, "a capped push must not reach the transport");
});

test("data ceiling: the seam refuses with spend_capped once data:writes is spent", async () => {
  bare();
  configureSpend([{ of: "data:writes", per: "day", max: 0 }]);
  const host = actionHost("const r = await dsx.module.data.sweepnote.create({ title: 'x' })\nreturn { ok: r.ok, error: r.error }");
  const { body } = await runBody(host);
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "spend_capped");
});

// ── the statements ──────────────────────────────────────────────────────────────────────

test("the spend statements: one multi-row upsert, one read, both over the rate-counter table", () => {
  const add = buildSpendAddStatement([
    { bucket: "spend|requests", windowStartMs: 0, windowMs: 86_400_000, n: 12 },
    { bucket: "spend|data:writes", windowStartMs: 0, windowMs: 86_400_000, n: 3 },
  ]);
  assert.ok(add.text.includes("insert into dsx_rate_counter"));
  assert.ok(add.text.includes("count = dsx_rate_counter.count + excluded.count"));
  assert.ok(add.text.includes("returning bucket, count"));
  assert.equal(add.params.length, 8);

  const read = buildSpendReadStatement([{ bucket: "spend|requests", windowStartMs: 0 }]);
  assert.ok(read.text.startsWith("select bucket, count from dsx_rate_counter"));
});

test("the capped enqueue statement carries the ceiling, the pending count and the duplicate answer in ONE statement", () => {
  const plain = buildQueueEnqueueStatement({ queue: "billing", key: "k", payload: {} });
  assert.ok(!plain.text.includes("pending"), "no ceiling, no cap CTE — the fast path is unchanged");
  const capped = buildQueueEnqueueStatement({ queue: "billing", key: "k", payload: {}, maxPending: 10 });
  assert.ok(capped.text.includes("with cap as"));
  assert.ok(capped.text.includes("processed_at is null and dead_lettered_at is null"), "the count predicate must match the pending index");
  assert.ok(capped.text.includes("existing"), "a stored delivery's retry must answer duplicate even at the ceiling");
  assert.deepEqual(capped.params[2], 10);
});

// ── the review's findings, pinned (each of these failed before its fix) ─────────────────

function deferredStore(): {
  release(): void;
  total(bucket: string): number;
  settle: Promise<void>;
} {
  let releaseAdd: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseAdd = resolve; });
  const counts = new Map<string, number>();
  let settled: () => void = () => {};
  const settle = new Promise<void>((resolve) => { settled = resolve; });
  SpendSeam.store = {
    add: async (entries) => {
      await gate; // holds the flush in flight so the test can act "during the await"
      const out = entries.map((e) => {
        const key = `${e.bucket}@${e.windowStartMs}`;
        const next = (counts.get(key) ?? 0) + e.n;
        counts.set(key, next);
        return { bucket: e.bucket, count: next };
      });
      settled();
      return out;
    },
    read: async () => [],
  };
  return {
    release: () => releaseAdd(),
    total: (bucket: string) => [...counts.entries()].filter(([k]) => k.startsWith(`${bucket}@`)).reduce((n, [, c]) => n + c, 0),
    settle,
  };
}

test("units charged WHILE a flush is in flight are never dropped — the writeback subtracts what was sent", async () => {
  bare();
  const store = deferredStore();
  configureSpend([{ of: "requests", per: "day", max: 1_000_000 }]);
  for (let i = 0; i < 5; i++) chargeSpend("requests");
  const inFlight = flushSpendNow(); // snapshots 5, then awaits the gated store
  for (let i = 0; i < 3; i++) chargeSpend("requests"); // land during the await
  store.release();
  await inFlight;
  await flushSpendNow(); // the 3 held-back units go now
  assert.equal(store.total("spend|requests"), 8, "5 sent + 3 charged mid-flight must all reach the durable counter");
});

test("a window that rolls during an in-flight flush does not inherit the old window's total or its trip", async () => {
  bare();
  const store = deferredStore();
  let nowMs = 10_000_000;
  configureSpend([{ of: "requests", per: "hour", max: 10 }], { now: () => nowMs });
  for (let i = 0; i < 5; i++) chargeSpend("requests");
  const inFlight = flushSpendNow();
  nowMs += 3_600_000; // the hour rolls while the store round trip is pending
  assert.equal(chargeSpend("requests").allowed, true); // fresh window, count 1
  store.release();
  await inFlight;
  const snapshot = spendSnapshot();
  assert.equal(snapshot.budgets[0]?.count, 1, "the new window must not inherit the old window's flushed total");
  assert.equal(snapshot.budgets[0]?.tripped, false);
  assert.equal(chargeSpend("requests").allowed, true);
});

test("a transition arriving during an in-flight flush is carried by the promise the caller waits on", async () => {
  bare();
  const store = deferredStore();
  const { published } = feedSink();
  let nowMs = 20_000_000;
  configureSpend([{ of: "requests", per: "day", max: 1 }], { now: () => nowMs });
  chargeSpend("requests");
  nowMs += 10_000; // past the cadence so the first flushIfDue runs
  const first = flushSpendIfDue();
  assert.notEqual(first, null);
  chargeSpend("requests"); // the trip lands while the first flush awaits the store
  const second = flushSpendIfDue(); // urgent: must CHAIN a follow-up, not hand back the stale promise
  assert.notEqual(second, first, "the in-flight promise cannot cover a transition it never snapshotted");
  store.release();
  await second;
  // The warning fired on the first charge (max 1: one unit is already 80%); the trip arrived
  // mid-flight and is what the chained promise exists to carry.
  assert.deepEqual(published.map((e) => e.payload["kind"]), ["spend.warning", "spend.tripped"]);
});

test("the /mcp face is charged like a route: a spent request ceiling refuses a tool call at the transport", async () => {
  bare();
  configureSpend([{ of: "requests", per: "day", max: 0 }]);
  const face = createMcpFace({ tools: [{ name: "noteSummary", description: "d", action: "noteSummary", chain: "t", inputs: [] }], handlers: { t: { noteSummary: async () => ({}) } }, buildInfo: {} });
  const res = await face(
    new Request("https://server.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    { identity: null, env: () => undefined },
  );
  assert.equal(res?.status, 429);
  assert.equal(((await res?.json()) as Record<string, unknown>)["reason"], "spend_capped");
  assert.equal(res?.headers.get("x-dsx-spend-budget"), "requests");
});

test("an unknown data verb is never charged, and at a spent ceiling still answers unknown_action", async () => {
  bare();
  configureSpend([{ of: "data:writes", per: "day", max: 0 }]);
  const host = actionHost("const r = await dsx.module.data.note.query({})\nreturn { ok: r.ok, error: r.error }");
  const { body } = await runBody(host);
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "unknown_action", "a typo must not be diagnosed as a spent budget");
  assert.equal(spendSnapshot().budgets[0]?.count, 0, "an operation that never executes must cost nothing");
});

test("CRASH-BEFORE-FLUSH, measured: isolate death loses AT MOST the unflushed tail — the bound, not zero", async () => {
  //  The claim the plane is allowed to make is scoped: a STORE FAILURE loses nothing (units are
  //  held and retried — pinned above), but an ISOLATE DYING between flushes loses exactly the
  //  units charged since its last flush, and nothing else. That lost tail is also the ceiling's
  //  overshoot allowance from a crash: an undercounted window can admit that many extra units.
  //  This test measures the bound instead of letting anyone believe it is zero.
  bare();
  const store = countingStore();
  configureSpend([{ of: "requests", per: "day", max: 100 }]);
  for (let i = 0; i < 7; i++) chargeSpend("requests");
  await flushSpendNow(); // durable: 7
  for (let i = 0; i < 3; i++) chargeSpend("requests"); // the unflushed tail
  // The isolate dies: a fresh configure IS a new isolate — nothing in memory survives.
  configureSpend([{ of: "requests", per: "day", max: 100 }]);
  await flushSpendNow(); // idle read reconciles the fresh isolate to the durable truth
  const key = `spend|requests@${windowStart("day", Date.now())}`;
  assert.equal(store.counts.get(key), 7, "the durable count holds everything up to the last flush");
  //  10 were charged in the isolate's life, 7 survived: the loss is EXACTLY the 3-unit tail, so
  //  the bound is `charges since the last flush` — one flush cadence of traffic per isolate, and
  //  on Workers the per-request waitUntil flush keeps that window to the cadence, not the
  //  isolate's lifetime.
  chargeSpend("requests");
  await flushSpendNow();
  assert.equal(store.counts.get(key), 8, "the fresh isolate resumes from the durable truth");
});

test("spendHeaders: a refusal names its budget and its reset; an allowance adds nothing", () => {
  assert.deepEqual(spendHeaders({ allowed: true, budget: null, retryAfterSeconds: 0 }), {});
  const refused = spendHeaders({ allowed: false, budget: "egress:api.openai.com", retryAfterSeconds: 90 });
  assert.equal(refused["retry-after"], "90");
  assert.equal(refused["x-dsx-spend-budget"], "egress:api.openai.com");
});
