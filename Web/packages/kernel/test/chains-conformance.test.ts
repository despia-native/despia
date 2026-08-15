//
//  chains-conformance.test.ts - the module-identity chain corpus runner (TS lane).
//  Executes OpenSource/Conformance/chains/chains.json: every resolution case through
//  the PURE fold (resolveChain) against the fixture table AND against the LIVE
//  registry (the same universe built through register() + setExcludedIdentities),
//  then the proxySafety block against the kernel's module proxy with a spy on the
//  dispatch funnel, plus the member-plane surfaces (.available / .excluded / .on)
//  and the funnel integration end-to-end (proxy face + runner face).
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift
//  starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  ModuleRegistry, DSXEvents, ModuleCallError, defineModule, makeDsx,
  resolveChain, RESERVED_MEMBERS, PROXY_DENYLIST, type ChainTable,
} from "../src/bus.ts";
import { DSXState, ReactiveStore } from "../src/store.ts";
import { ActionRunner, makeRunEnv } from "../src/runner.ts";
import { type Dict } from "../src/jse/values.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/chains/chains.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`OpenSource/Conformance/chains/chains.json not found walking up from ${import.meta.dirname}`);
    dir = parent;
  }
}

type ChainCase = {
  name: string;
  input: string;
  expect: {
    chain: string; action?: string; spelling?: string;
    known?: boolean; excluded?: boolean; member?: string; rest?: string;
  };
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as {
  table: { chains: string[]; aliases: Record<string, string>; excluded: string[] };
  cases: ChainCase[];
  proxySafety: { denylist: string[] };
  reserved: string[];
};
assert.ok(doc.cases.length > 0, "chains corpus is empty — OpenSource/Conformance/chains/chains.json");

// ── the fixture table (the corpus's synthetic identity universe) ─────────────────────

const identitySet = new Set([...doc.table.chains, ...doc.table.excluded]);
const excludedSet = new Set(doc.table.excluded);
const fixtureTable: ChainTable = {
  isIdentity: (c) => identitySet.has(c),
  aliasTarget: (h) => doc.table.aliases[h] ?? null,
  isExcluded: (c) => excludedSet.has(c),
};

// ── the LIVE registry mirror of the same universe ────────────────────────────────────
// Registered chains = the non-excluded fixture chains (an excluded module's file is
// dropped — it exists only in the overlay); aliases ride their target's registration;
// the excluded overlay arrives through the build seam. Each module's catch-all records
// the arriving spelling/action (ctx parity) and emits a "called" event on its identity.

let lastCall: { scheme: string; action: string } | null = null;
for (const chain of doc.table.chains) {
  if (excludedSet.has(chain)) continue;
  const aliases = Object.entries(doc.table.aliases)
    .filter(([, target]) => target === chain)
    .map(([alias]) => alias);
  ModuleRegistry.register(defineModule({
    scheme: chain,
    actions: {
      "*": (ctx) => {
        lastCall = { scheme: ctx.scheme, action: ctx.action };
        ctx.event("called", ctx.action);
        return { ok: true };
      },
    },
  }), { aliases });
}
ModuleRegistry.setExcludedIdentities(doc.table.excluded);

// ── the frozen sets are 1:1 with the corpus ──────────────────────────────────────────

test("chains: reserved-member and proxy-denylist sets match the corpus exactly", () => {
  assert.deepEqual([...RESERVED_MEMBERS].sort(), [...doc.reserved].sort());
  assert.deepEqual([...PROXY_DENYLIST].sort(), [...doc.proxySafety.denylist].sort());
});

// ── every resolution case, on BOTH tables ────────────────────────────────────────────

for (const c of doc.cases) {
  test(`chains/${c.name}`, () => {
    const results = [
      ["fixture-table", resolveChain(c.input.split("."), fixtureTable)],
      ["live-registry", ModuleRegistry.resolve(c.input)],
    ] as const;
    for (const [lane, r] of results) {
      assert.equal(r.chain, c.expect.chain, `${lane}: chain`);
      assert.equal(r.spelling, c.expect.spelling ?? c.expect.chain, `${lane}: spelling`);
      assert.equal(r.known, c.expect.known ?? true, `${lane}: known`);
      assert.equal(r.excluded, c.expect.excluded ?? false, `${lane}: excluded`);
      if (c.expect.member !== undefined) {
        assert.equal(r.member, c.expect.member, `${lane}: member`);
        assert.equal(r.rest.join("/"), c.expect.rest ?? "", `${lane}: rest`);
        assert.deepEqual(r.action, [], `${lane}: a member route carries no action`);
      } else {
        assert.equal(r.member, null, `${lane}: member`);
        assert.equal(r.action.join("/"), c.expect.action ?? "", `${lane}: action`);
        assert.deepEqual(r.rest, [], `${lane}: rest`);
      }
    }
  });
}

// ── funnel integration: the fold at the ONE dispatch funnel, every call face ─────────

test("chains: the proxy face folds a nested chain call (spelling to the module, identity to the bus)", async () => {
  const dsx = makeDsx("chains-test");
  assert.deepEqual(await dsx.module["watch"]!["health"]!["heartRate"]!({}), { ok: true });
  assert.deepEqual(lastCall, { scheme: "watch.health", action: "heartRate" });
  // a flat legacy alias arrives with its spelling visible (ctx.scheme), identity folded
  assert.deepEqual(await dsx.module["watchhealth"]!["heartRate"]!({}), { ok: true });
  assert.deepEqual(lastCall, { scheme: "watchhealth", action: "heartRate" });
  // an action group stays an action path (the ban guarantees rag is no child)
  await dsx.module["intelligence"]!["rag"]!["add"]!({});
  assert.deepEqual(lastCall, { scheme: "intelligence", action: "rag/add" });
  // a hyphenated wire alias is a bare call at depth 1
  await dsx.module["get-uuid"]!({});
  assert.deepEqual(lastCall, { scheme: "get-uuid", action: "" });
});

test("chains: the runner face passes the full dotted remainder; the funnel folds", async () => {
  const store = new ReactiveStore();
  const runner = new ActionRunner(makeRunEnv(store));
  await runner.run("const r = await dsx.module.watch.health.workout.zones.set({ z: 5 }); dsx.variable.ok = r.ok");
  assert.equal(store.eval("ok"), true);
  assert.deepEqual(lastCall, { scheme: "watch.health", action: "workout/zones/set" });
});

test("chains: an excluded chain attributes honestly at the funnel (never a phantom parent action)", async () => {
  // TYPED ABSENCE (durability.md P4, errors corpus): the reason IS the code — an
  // overlay-known chain answers `excluded` (never `not_loaded`), its DespiaExcluded
  // entry riding verbatim as the failure data.
  const seen: Dict[] = [];
  const off = ModuleRegistry.registerDelegate("module.callFailed", 0, (input) => { seen.push(input as Dict); return null; });
  try {
    await assert.rejects(
      () => ModuleRegistry.call("off.grid.run", {}),
      (e: unknown) => e instanceof ModuleCallError && e.code === "excluded",
    );
    assert.deepEqual(seen.map((p) => [p["scheme"], p["action"], p["code"], p["data"]]),
      [["off.grid", "run", "excluded", { reason: "cascade", from: "off" }]]);
  } finally { off(); }
});

test("chains: a reserved member arriving at a MODERN call face is refused as an action", async () => {
  await assert.rejects(
    () => ModuleRegistry.call("watch.health.state.bpm", {}),
    (e: unknown) => e instanceof ModuleCallError && e.code === "reserved_member",
  );
});

test("chains: the legacy WIRE face is exempt — a code-only shim under a reserved spelling keeps answering", async () => {
  // Reserved words are banned from MANIFESTS, never from the v3 wire (corpus _note):
  // the shipped-page compat shim pattern (biometric://available, bluetooth://state).
  let answered = 0;
  ModuleRegistry.register(defineModule({
    scheme: "biometric",
    actions: {
      available: () => { answered += 1; return { available: true }; },
      state: (ctx) => ({ echoed: ctx.args("q") }),
    },
  }));
  assert.deepEqual(await ModuleRegistry.dispatch("biometric", "available", {}), { available: true });
  assert.equal(answered, 1);
  assert.deepEqual(await ModuleRegistry.dispatch("biometric", "state", { q: 1 }), { echoed: 1 });
  // the MODERN faces still refuse the very same spelling…
  await assert.rejects(
    () => ModuleRegistry.call("biometric.available", {}),
    (e: unknown) => e instanceof ModuleCallError && e.code === "reserved_member",
  );
  // …and the wire face still answers unknown_action honestly for a reserved name the
  // module never shipped (direct routing, no phantom member success)
  await assert.rejects(
    () => ModuleRegistry.dispatch("biometric", "delegate", {}),
    (e: unknown) => e instanceof ModuleCallError && e.code === "unknown_action",
  );
});

test("chains: on the wire face the fold still ROUTES a nested chain even under a reserved remainder", async () => {
  // Frozen cross-runtime semantics (corpus _note): chfx://sub/state dispatches action
  // 'state' on the FOLDED chfx.sub — the owner and the attribution are the same on
  // every runtime; only the refusal is face-gated. The child ships a code-only shim
  // literally named 'state'; the parent has no 'sub' action (the bidirectional ban).
  ModuleRegistry.register(defineModule({ scheme: "chfx", actions: {} }));
  ModuleRegistry.register(defineModule({
    scheme: "chfx.sub",
    actions: { state: (ctx) => ({ shim: true, q: ctx.args("q") }) },
  }));
  // the fold routes chfx://sub/state to the CHILD, whose shim answers
  assert.deepEqual(await ModuleRegistry.dispatch("chfx", "sub/state", { q: 7 }), { shim: true, q: 7 });
  // an unregistered name answers unknown_action attributed to chfx.sub (the folded
  // owner), never a phantom 'sub/nope' on the parent
  const seen: Dict[] = [];
  const off = ModuleRegistry.registerDelegate("module.callFailed", 0, (input) => { seen.push(input as Dict); return null; });
  try {
    await assert.rejects(
      () => ModuleRegistry.dispatch("chfx", "sub/nope", {}),
      (e: unknown) => e instanceof ModuleCallError && e.code === "unknown_action",
    );
    assert.deepEqual(seen.map((p) => [p["scheme"], p["action"], p["code"]]),
      [["chfx.sub", "nope", "unknown_action"]]);
  } finally { off(); }
  // the MODERN face still refuses the same nested spelling — the face gate, pinned
  await assert.rejects(
    () => ModuleRegistry.call("chfx.sub.state", {}),
    (e: unknown) => e instanceof ModuleCallError && e.code === "reserved_member",
  );
});

// ── the member plane on the module handle ────────────────────────────────────────────

test("chains: build facts answer as members — available / excluded (cascade shape)", () => {
  const dsx = makeDsx("chains-test");
  assert.equal(dsx.module["watch"]!["health"]!["available"], true);
  assert.equal(dsx.module["ghost"]!["available"], false);
  assert.equal(dsx.module["off"]!["available"], false);
  assert.equal(dsx.module["off"]!["grid"]!["available"], false);
  assert.equal(dsx.module["watch"]!["excluded"], false);
  assert.deepEqual(dsx.module["off"]!["excluded"], { reason: "excluded" });
  assert.deepEqual(dsx.module["off"]!["grid"]!["excluded"], { reason: "cascade", from: "off" });
});

test("chains: .context (canonical) and .state (alias) read the same declared-vars plane", () => {
  // a registered module's DECLARED var answers under both spellings — one plane
  ModuleRegistry.register(defineModule({ scheme: "ctxmod", state: { mode: "idle" }, actions: {} }));
  const dsx = makeDsx("chains-test");
  assert.equal(dsx.module["ctxmod"]!["context"]!["mode"], "idle");
  assert.equal(dsx.module["ctxmod"]!["state"]!["mode"], "idle");
  // a NESTED chain reads the same plane under its primary identity, both spellings
  DSXState.set("watch.health.bpm", 72);
  assert.equal(dsx.module["watch"]!["health"]!["context"]!["bpm"], 72);
  assert.equal(dsx.module["watch"]!["health"]!["state"]!["bpm"], 72);
});

test("chains: .on subscribes the chain's events — one kind, or all of them; unsubscribe works", async () => {
  const dsx = makeDsx("chains-test");
  const kinds: unknown[] = [];
  const fire: Array<[unknown, string | undefined]> = [];
  const offKind = dsx.module["watch"]!["health"]!.on("called", (v) => { kinds.push(v); });
  const offAll = dsx.module["watch"]!["health"]!.on((v, k) => { fire.push([v, k]); });
  // an alias-spelled CALL still publishes on the identity channel
  await dsx.module["watchhealth"]!["heartRate"]!({});
  assert.deepEqual(kinds, ["heartRate"]);
  assert.deepEqual(fire, [["heartRate", "called"]]);
  DSXEvents.publish("watch.health:error", { code: "x" });
  assert.equal(kinds.length, 1);                 // kind-scoped: untouched
  assert.equal(fire.length, 2);                  // firehose: sees every kind
  assert.deepEqual(fire[1], [{ code: "x" }, "error"]);
  offKind();
  offAll();
  await dsx.module["watch"]!["health"]!["heartRate"]!({});
  assert.equal(kinds.length, 1);
  assert.equal(fire.length, 2);
});

// ── proxySafety: the R1 denylist on every JS plane the kernel builds ─────────────────

test("chains: proxySafety — denylisted names and Symbols are undefined; stringify/inspect never dispatch", () => {
  const rawDispatch = ModuleRegistry.dispatch;
  const rawCall = ModuleRegistry.call;
  let fired = 0;
  type Reg = { dispatch: typeof rawDispatch; call: typeof rawCall };
  (ModuleRegistry as unknown as Reg).dispatch = function (...a: Parameters<typeof rawDispatch>) {
    fired += 1;
    return rawDispatch.apply(ModuleRegistry, a);
  };
  (ModuleRegistry as unknown as Reg).call = function (...a: Parameters<typeof rawCall>) {
    fired += 1;
    return rawCall.apply(ModuleRegistry, a);
  };
  try {
    const dsx = makeDsx("chains-test");
    const surfaces: Array<[string, unknown]> = [
      ["dsx.module", dsx.module],
      ["chain node", dsx.module["watch"]],
      ["nested identity", dsx.module["watch"]!["health"]],
      ["action node", dsx.module["watch"]!["health"]!["heartRate"]],
      ["context member proxy (canonical)", dsx.module["watch"]!["health"]!["context"]],
      ["state member proxy (alias)", dsx.module["watch"]!["health"]!["state"]],
    ];
    for (const [label, s] of surfaces) {
      for (const name of doc.proxySafety.denylist) {
        assert.equal((s as Record<string, unknown>)[name], undefined, `${label}: ${name} must be undefined`);
      }
      assert.equal((s as Record<symbol, unknown>)[Symbol.for("dsx.probe")], undefined, `${label}: Symbol get`);
      assert.equal((s as Record<symbol, unknown>)[Symbol.iterator], undefined, `${label}: Symbol.iterator`);
      assert.equal((s as Record<symbol, unknown>)[Symbol.toPrimitive], undefined, `${label}: Symbol.toPrimitive`);
    }
    // JSON.stringify treats the handles as plain values (functions serialize as nothing)
    assert.equal(JSON.stringify(dsx.module["watch"]!["health"]), undefined);
    assert.equal(JSON.stringify({ m: dsx.module["watch"] }), "{}");
    assert.equal(JSON.stringify(dsx.module), "{}");
    assert.equal(fired, 0, "no phantom dispatch may fire from property gets or stringify");
  } finally {
    (ModuleRegistry as unknown as Reg).dispatch = rawDispatch;
    (ModuleRegistry as unknown as Reg).call = rawCall;
  }
});

// ── the alias planes (review round 3): excluded-overlay aliases + emission fan-out ───

test("chains: excludedFact answers an excluded module's legacy alias spellings", () => {
  // The entry-shaped seam: an excluded module is unregistered, so only the overlay
  // can know its spellings — the alias answers the OWNING chain's entry, 1:1 with
  // the page's matchesEntry. Bare strings stay accepted (alias-less overlay).
  ModuleRegistry.setExcludedIdentities([
    { chain: "off.grid", aliases: ["offgrid-legacy"] },
    "off",
  ]);
  try {
    assert.deepEqual(ModuleRegistry.excludedFact("off.grid"), { reason: "cascade", from: "off" });
    assert.deepEqual(ModuleRegistry.excludedFact("offgrid-legacy"), { reason: "cascade", from: "off" });
    assert.equal(ModuleRegistry.excludedFact("offgrid-nope"), false);
    // Aliases stay SPELLINGS, never identities: the fold universe is unchanged.
    assert.equal(ModuleRegistry.resolve("offgrid-legacy").known, false);
  } finally {
    ModuleRegistry.setExcludedIdentities(doc.table.excluded);
  }
});

test("chains: a module's events fan out to its legacy alias channels", async () => {
  // The emission-side twin of the native fire/broadcast fan-out: a subscriber
  // holding the OLD spelling's channel keeps hearing the module it always heard.
  const heard: unknown[] = [];
  const off = DSXEvents.on("watchhealth:called", (v) => { heard.push(v); });
  try {
    const dsx = makeDsx("chains-test");
    await dsx.module["watch"]!["health"]!["heartRate"]!({});
    assert.deepEqual(heard, ["heartRate"], "the alias channel hears the primary chain's emission");
  } finally {
    off();
  }
});
