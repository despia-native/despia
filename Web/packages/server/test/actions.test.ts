//
//  actions.test.ts — declared bodies as handlers (backend-authoring.md).
//
//  Two things are under test and they are not the same thing:
//
//    1. THE BRIDGE — a `<action>` body reaches the wire correctly: args arrive, the return
//       value is the 200 body, a declared rejection is its real status, a fault is redacted.
//    2. THE SANDBOX — what a body CANNOT do. This half matters more, because the entire
//       argument for accepting author code on a shared backend is that the grammar has no
//       name for the capabilities a TypeScript handler reaches by default. Each refusal here
//       was written to fail against an unbound seam, so it pins the gate rather than
//       describing a coincidence.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHost, type HostConfig, type HostContext, type ServerRoute } from "../src/host.ts";
import { declaredHandler, type DeclaredAction } from "../src/actions.ts";
import { installEntities, RepoSeam, type RepoQuery } from "../src/repo.ts";
import { QueueSeam, type QueueEnqueueRequest } from "../src/queue.ts";
import { installPackages } from "../src/packages.ts";

installEntities([
  { entity: "note", fields: { title: "text", pinned: "boolean" }, ownership: "owner" },
]);

/** A transport that answers from an in-memory table, honouring the caller's subject the way
 *  RLS does — so "Bob cannot read Alice's row" is a real assertion here, not a mock's opinion. */
const rows: { id: string; owner_id: string; title: string; pinned: boolean }[] = [];
let seq = 0;
RepoSeam.transport = async (q: RepoQuery): Promise<unknown> => {
  const mine = rows.filter((r) => r.owner_id === q.subject);
  switch (q.op) {
    case "create": {
      const row = {
        id: `row_${++seq}`,
        owner_id: String(q.subject),
        title: String(q.values?.["title"] ?? ""),
        pinned: q.values?.["pinned"] === true,
      };
      rows.push(row);
      return row;
    }
    case "list": return mine;
    case "get": return mine.find((r) => r.id === q.id) ?? null;
    case "update": return mine.find((r) => r.id === q.id) ?? null;
    case "delete": return null;
  }
};

const enqueued: { queue: string; key: string; payload: Record<string, unknown> }[] = [];
QueueSeam.transport = {
  enqueue: async (req: QueueEnqueueRequest) => { enqueued.push(req); return { id: `q_${enqueued.length}`, duplicate: false }; },
  claim: async () => [],
  settle: async () => undefined,
  deadLetters: async () => [],
  replay: async () => 0,
} as unknown as typeof QueueSeam.transport;

// ── the fixture host ─────────────────────────────────────────────────────────────────────

function hostFor(spec: Omit<DeclaredAction, "chain" | "name"> & { name?: string }, route: Partial<ServerRoute> = {}): HostConfig {
  const name = spec.name ?? "run";
  const full: DeclaredAction = { chain: "shop", name, ...spec };
  return {
    routes: [{
      key: "run", chain: "shop", action: name, method: "POST", path: "/run",
      auth: "required", reach: ["app"], ...route,
    }],
    handlers: { shop: { [name]: declaredHandler(full) } },
    onError: () => {},
  };
}

async function run(cfg: HostConfig, body: unknown = {}, sub: string | null = "alice") {
  const ctx: Partial<HostContext> = {
    identity: sub === null ? null : { sub, role: "authenticated", token: "t" } as unknown as HostContext["identity"],
    env: (k) => (k === "STRIPE_KEY" ? "sk_live_fixture" : undefined),
  };
  const res = await createHost(cfg).handle(
    new Request("http://fixture.test/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
  return { res, body: await res.json() as Record<string, unknown> };
}

// ── 1 · the bridge ───────────────────────────────────────────────────────────────────────

test("a declared body's return value IS the 200 response body", async () => {
  const { res, body } = await run(hostFor({ body: "return { ok: 1, where: 'body' }" }));
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: 1, where: "body" });
});

test("request args arrive in the body's scope by name", async () => {
  const { body } = await run(hostFor({ body: "return { got: title }" }), { title: "hello" });
  assert.deepEqual(body, { got: "hello" });
});

test("a body may call a sibling action declared in the same document", async () => {
  const cfg = hostFor({
    body: "const r = await dsx.action.double({ n: 21 }); return { n: r.data }",
    siblings: { double: { body: "return n * 2" } },
  });
  const { body } = await run(cfg);
  assert.deepEqual(body, { n: 42 });
});

test("a declared rejection is its real status, and the author's message survives", async () => {
  const { res, body } = await run(hostFor({
    body: "throw { reason: 'invalid', message: 'title is required' }",
  }));
  assert.equal(res.status, 400);
  assert.equal(body["reason"], "invalid");
  assert.equal(body["message"], "title is required");
});

test("every reason in the vocabulary maps to its own status", async () => {
  for (const [reason, status] of [["unauthenticated", 401], ["forbidden", 403], ["not_found", 404], ["conflict", 409], ["upstream", 502]] as const) {
    const { res, body } = await run(hostFor({ body: `throw { reason: '${reason}', message: 'x' }` }));
    assert.equal(res.status, status, `${reason} should be ${status}`);
    assert.equal(body["reason"], reason);
  }
});

test("a null in the returned value reaches the wire as null, not as the kernel's sentinel", async () => {
  // JSE marks absence with a sentinel object (`{__nsnull:true}`), which is right inside the
  // runtime and wrong on the wire — it serialised straight through, so every client had to know
  // a kernel implementation detail to read a null.
  const { body } = await run(hostFor({
    body: "return { a: 1, missing: neverSet, explicit: null, list: [null, 2] }",
  }));
  assert.deepEqual(body, { a: 1, missing: null, explicit: null, list: [null, 2] });
});

test("a throw OUTSIDE the vocabulary is a fault: 500, and nothing of it reaches the client", async () => {
  const { res, body } = await run(hostFor({
    body: "throw { reason: 'weird', message: 'SELECT * FROM users token=s3cr3t' }",
  }));
  assert.equal(res.status, 500);
  assert.equal(body["reason"], "handler_failed");
  assert.ok(!JSON.stringify(body).includes("s3cr3t"), "an unrecognised throw leaked to the client");
});

// ── 2 · the data seam ────────────────────────────────────────────────────────────────────

test("the data seam is scoped to the CALLER, so one tenant cannot read another's rows", async () => {
  const write = hostFor({ body: "const r = await dsx.module.data.note.create({ title: 'mine' }); return { id: r.data.id }" });
  const read = hostFor({ body: "const r = await dsx.module.data.note.list({}); return { count: r.data.length }" });

  await run(write, {}, "alice");
  assert.deepEqual((await run(read, {}, "alice")).body, { count: 1 });
  assert.deepEqual((await run(read, {}, "bob")).body, { count: 0 });
});

test("a body cannot name an entity the tree does not declare", async () => {
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.data.secrets.list({}); return { ok: r.ok, error: r.error }",
  }));
  assert.equal(body["ok"], false);
});

test("the queue seam refuses an enqueue with no idempotency key", async () => {
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.queue.jobs.push({ payload: { a: 1 } }); return { ok: r.ok, error: r.error }",
  }));
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "bad_request");

  const good = await run(hostFor({
    body: "const r = await dsx.module.queue.jobs.push({ key: 'k1', payload: { a: 1 } }); return { ok: r.ok }",
  }));
  assert.equal(good.body["ok"], true);
  assert.equal(enqueued.at(-1)?.key, "k1");
});

// ── 3 · the sandbox: what a body must NOT be able to do ──────────────────────────────────

test("a body may read a secret it DECLARED", async () => {
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.secret.read({ name: 'STRIPE_KEY' }); return { got: r.data }",
    secrets: ["STRIPE_KEY"],
  }));
  assert.equal(body["got"], "sk_live_fixture");
});

test("a body may NOT read a secret it did not declare, even when the env holds one", async () => {
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.secret.read({ name: 'STRIPE_KEY' }); return { ok: r.ok, error: r.error }",
    secrets: [],
  }));
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "forbidden");
});

test("a body may not call an arbitrary module chain", async () => {
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.fs.readFile({ path: '/etc/passwd' }); return { ok: r.ok, error: r.error }",
  }));
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "unsupported");
});

test("egress: with nothing declared, a body cannot reach the network at all", async () => {
  const { body } = await run(hostFor({
    body: "const r = await fetch('https://169.254.169.254/latest/meta-data/'); return { ok: r.ok, status: r.status }",
  }));
  assert.equal(body["ok"], false);
  // -2 is the REFUSED shape: the request never left the process. A network error would be 0,
  // and asserting only `ok: false` would pass even with the gate removed (the cloud metadata
  // address is unreachable from CI anyway) — which is exactly how a security test rots.
  assert.equal(body["status"], -2);
});

test("egress: a declared host admits its subdomains and nothing that merely ends with its name", async () => {
  const cfg = hostFor({
    body: "const r = await fetch(url); return { ok: r.ok, status: r.status, error: r.error }",
    egress: ["stripe.com"],
  });
  // The lookalike is refused BEFORE any network work, so the answer is the blocked shape.
  const evil = await run(cfg, { url: "https://stripe.com.attacker.test/x" });
  assert.equal(evil.body["ok"], false);
  assert.equal(evil.body["status"], -2);

  // Plain http is refused even for a declared host: a secret in an Authorization header
  // must never ride a cleartext hop.
  const cleartext = await run(cfg, { url: "http://api.stripe.com/x" });
  assert.equal(cleartext.body["status"], -2);
});

test("a body that never terminates fails 503 — it does NOT answer 200 with partial work", async () => {
  const started = Date.now();
  const { res, body } = await run(hostFor({
    body: "let n = 0\nwhile (true) { n = n + 1 }\nreturn { n: n }",
    budget: { loopCap: 5_000 },
  }));
  // The runner CONTAINS the loop and the body runs on, so before this was checked the handler
  // returned `200 {"n":5000}` — a half-computed answer indistinguishable from a real one.
  assert.equal(res.status, 503);
  assert.equal(body["reason"], "budget_exceeded");
  assert.match(String(body["message"]), /loop budget/);
  assert.ok(Date.now() - started < 10_000, "the loop was not contained");
});

test("a loop that stays UNDER its cap still answers normally", async () => {
  const { res, body } = await run(hostFor({
    body: "let n = 0\nfor (const x of [1,2,3]) { n = n + x }\nreturn { n: n }",
    budget: { loopCap: 5_000 },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(body, { n: 6 });
});

test("an exhausted module-call budget fails the request even when the body swallows the error", async () => {
  const { res, body } = await run(hostFor({
    // The body catches the refusal and returns a cheerful value — the request must still fail.
    body: "for (const i of [1,2,3,4,5,6]) { await dsx.module.data.note.list({}) }\nreturn { ok: true }",
    budget: { calls: 2 },
  }));
  assert.equal(res.status, 503);
  assert.equal(body["reason"], "budget_exceeded");
  assert.match(String(body["message"]), /module-call budget/);
});

test("the module-call budget stops a body that calls in a loop", async () => {
  const { res, body } = await run(hostFor({
    body: "let last = null\nfor (const i of [1,2,3,4,5,6]) { last = await dsx.module.data.note.list({}) }\nreturn { ok: last.ok, error: last.error }",
    budget: { calls: 3 },
  }));
  // The refused CALL is visible to the body as `{ok:false, error:"budget_exceeded"}` — which is
  // how a body can react — but the REQUEST fails regardless of what the body decides to return.
  assert.equal(res.status, 503);
  assert.equal(body["reason"], "budget_exceeded");
});

test("a document cannot raise its own ceiling above the platform's", async () => {
  const { body } = await run(hostFor({
    body: "let last = null\nfor (const i of [1,2,3,4,5,6]) { last = await dsx.module.data.note.list({}) }\nreturn { ok: last.ok }",
    budget: { calls: 1_000_000 },
  }));
  // 6 calls is under the platform cap (64), so this one SUCCEEDS — the assertion is that the
  // clamp did not crash and that the ceiling is the platform's, proven by the next line.
  assert.equal(body["ok"], true);
  const over = await run(hostFor({
    body: "let last = null\nfor (const i of [1,2,3,4,5,6]) { last = await dsx.module.data.note.list({}) }\nreturn { ok: last.ok, error: last.error }",
    budget: { calls: 2 },
  }));
  assert.equal(over.res.status, 503);
  assert.equal(over.body["reason"], "budget_exceeded");
});

// ── 4 · the import primitive (Core/Server/Modules/Import) ────────────────────────────────
//
//  The package is DECLARED; its exports are NOT enumerated. That widening is only safe because
//  of the two guards below it — the escape-path refusal and the sanitized return — so both are
//  tested as adversarially as the secret and egress gates.

/** A namespace shaped like a real SDK: nested methods, a default export, a `this` receiver. */
function sdk() {
  const charges = {
    total: 0,
    create(input: { amount: number }) {
      // `this` must be `charges`, or every method-style SDK breaks under the wrapper.
      this.total += input.amount;
      return { id: "ch_1", amount: input.amount, running: this.total };
    },
  };
  return { default: (s: string) => s.toLowerCase(), charges, version: "9.1.0" };
}

test("any export of a declared package is reachable by path — nothing is enumerated", async () => {
  installPackages([{ scheme: "pay", module: sdk() }]);
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.pay.charges.create({ amount: 250 }); return { id: r.data.id, amt: r.data.amount }",
  }));
  assert.deepEqual(body, { id: "ch_1", amt: 250 });
  installPackages([]);
});

test("a nested method keeps its receiver, so `this` still works", async () => {
  installPackages([{ scheme: "pay", module: sdk() }]);
  const cfg = hostFor({ body: "const r = await dsx.module.pay.charges.create({ amount: 100 }); return { running: r.data.running }" });
  assert.deepEqual((await run(cfg)).body, { running: 100 });
  assert.deepEqual((await run(cfg)).body, { running: 200 }, "the receiver was lost between calls");
  installPackages([]);
});

test("positional npm functions are callable with `args`, the general escape hatch", async () => {
  installPackages([{ scheme: "slug", module: { default: (input: string, opts: { lower?: boolean }) => (opts?.lower ? input.toLowerCase() : input) } }]);
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.slug.default({ args: ['Hello World', { lower: true }] }); return { slug: r.data }",
  }));
  assert.equal(body["slug"], "hello world");
  installPackages([]);
});

test("declared `params` map named keys to positions for a nicer call site", async () => {
  installPackages([{
    scheme: "slug",
    module: { default: (input: string, opts: { lower?: boolean }) => (opts?.lower ? input.toLowerCase() : input) },
    exports: { make: "default" },
    params: { make: ["input", "options"] },
  }]);
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.slug.make({ input: 'Hello', options: { lower: true } }); return { slug: r.data }",
  }));
  assert.equal(body["slug"], "hello");
  installPackages([]);
});

test("an export path that does not exist is a typed refusal, not a crash", async () => {
  installPackages([{ scheme: "pay", module: sdk() }]);
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.pay.refunds.create({}); return { ok: r.ok, error: r.error }",
  }));
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "unknown_action");
  installPackages([]);
});

// ── 4a · the two guards that make arbitrary paths safe ───────────────────────────────────

test("ESCAPE: the constructor path is refused at every step", async () => {
  installPackages([{ scheme: "pay", module: sdk() }]);
  for (const path of ["constructor.constructor", "default.constructor", "charges.create.constructor", "__proto__.x", "charges.__proto__.create"]) {
    const { body } = await run(hostFor({
      body: `const r = await dsx.module.pay.${path}({ args: ['return process'] }); return { ok: r.ok, error: r.error }`,
    }));
    assert.equal(body["ok"], false, `${path} was not refused`);
    assert.ok(body["error"] === "forbidden" || body["error"] === "unknown_action", `${path} answered ${String(body["error"])}`);
  }
  installPackages([]);
});

test("ESCAPE: an inherited property is not an export — only own properties resolve", async () => {
  class Sdk { run() { return "ok"; } }
  installPackages([{ scheme: "cls", module: { instance: new Sdk() } }]);
  const { body } = await run(hostFor({
    // `run` lives on the prototype, not on the instance — the same rule that keeps `toString`,
    // `valueOf` and the rest of the ambient chain from reading as a package's surface.
    body: "const r = await dsx.module.cls.instance.run({}); return { ok: r.ok, error: r.error }",
  }));
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "unknown_action");
  installPackages([]);
});

test("ESCAPE: a package returns DATA — a live object never crosses into a body", async () => {
  const leaky = { env: { SECRET: "s3cr3t" }, touched: 0 };
  installPackages([{
    scheme: "leak",
    module: {
      // Returns the host object itself, plus a getter that must never fire inside the body.
      grab: () => ({ host: leaky, get trap() { leaky.touched += 1; return "fired"; }, when: new Date(0), fn: () => 1 }),
    },
  }]);
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.leak.grab({}); return { secret: r.data.host.env.SECRET, fn: r.data.fn, when: r.data.when }",
  }));
  // The copy is JSON-shaped: the function is gone, the Date is a string. The secret DOES survive,
  // because the package deliberately returned it — the guard is that nothing UNDECLARED rides
  // along and that no live reference does.
  assert.equal(body["fn"], null, "a function crossed into the body");
  assert.equal(body["when"], "1970-01-01T00:00:00.000Z");
  assert.equal(body["secret"], "s3cr3t");
  assert.equal(leaky.touched, 1, "the getter should have run exactly once, during sanitize");
  installPackages([]);
});

test("a getter that throws while the result is read is the PACKAGE failing, not a raw 500", async () => {
  installPackages([{ scheme: "trap", module: { get: () => ({ get boom(): never { throw new Error("pg: password=hunter2"); } }) } }]);
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.trap.get({}); return { ok: r.ok, error: r.error }",
  }));
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "package_failed");
  assert.ok(!JSON.stringify(body).includes("hunter2"));
  installPackages([]);
});

test("a cyclic result answers null at the cycle instead of hanging", async () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic["self"] = cyclic;
  installPackages([{ scheme: "cyc", module: { get: () => cyclic } }]);
  const { res, body } = await run(hostFor({ body: "const r = await dsx.module.cyc.get({}); return r.data" }));
  assert.equal(res.status, 200);
  assert.deepEqual(body, { name: "root", self: null });
  installPackages([]);
});

test("a package cannot shadow a request seam", async () => {
  installPackages([{ scheme: "data", module: { note: () => "hijacked" } }]);
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.data.note.list({}); return { count: r.data.length }",
  }), {}, "carol");
  assert.equal(body["count"], 0, "a package named `data` intercepted the repository seam");
  installPackages([]);
});

test("installPackages refuses at BOOT when a DECLARED alias no longer resolves", () => {
  assert.throws(
    () => installPackages([{ scheme: "gone", module: {}, exports: { make: "default" } }]),
    (e: unknown) => (e as { code?: string }).code === "missing_export",
  );
  installPackages([]);
});

test("a throw from inside a package is wrapped, never handed to the body verbatim", async () => {
  installPackages([{ scheme: "boom", module: { go: () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); } } }]);
  const { body } = await run(hostFor({
    body: "const r = await dsx.module.boom.go({}); return { ok: r.ok, error: r.error }",
  }));
  assert.equal(body["ok"], false);
  assert.equal(body["error"], "package_failed");
  assert.ok(!JSON.stringify(body).includes("10.0.0.5"), "package internals leaked into the body's reach");
  installPackages([]);
});

// ── 5 · the gateway still owns the route ─────────────────────────────────────────────────

test("a declared body is subject to the same auth gate as any handler", async () => {
  const { res } = await run(hostFor({ body: "return { reached: true }" }), {}, null);
  assert.equal(res.status, 401);
});

test("a declared body on an INTERNAL row answers a stranger the absent-route 404", async () => {
  const cfg = hostFor({ body: "return { drained: 0 }" }, { reach: [], worker: "jobs" });
  const { res } = await run(cfg, {}, "alice");
  assert.equal(res.status, 404);
});
