//
//  facets-conformance.test.ts - the facet resolution-ladder corpus runner (TS lane).
//  Executes OpenSource/Conformance/facets/facets.json: every case through the PURE ladder
//  (resolveFacetLadder) over facts assembled from the corpus world, then the LIVE funnel
//  end-to-end through FacetSeam — the reach transport, the typed absence answers, and the
//  empty-seam floor that keeps a facet-less build answering exactly what it always did.
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  ModuleRegistry, ModuleCallError, defineModule, makeDsx,
  resolveFacetLadder, FacetSeam,
  type FacetFacts, type FacetRow, type FacetTable,
} from "../src/bus.ts";
import { type Dict } from "../src/jse/values.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/facets/facets.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`OpenSource/Conformance/facets/facets.json not found walking up from ${import.meta.dirname}`);
    dir = parent;
  }
}

type FacetCase = {
  name: string;
  facet?: string | null;
  transport?: boolean;
  local?: Record<string, string[]>;
  call: string;
  expect: { rung: "local" | "reach" | "unavailable"; code?: string };
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as {
  world: {
    table: FacetTable;
    excluded: Record<string, { reason: string; from?: string }>;
    platforms: Record<string, string[]>;
  };
  cases: FacetCase[];
  codes: string[];
  retired: Record<string, string>;
};
assert.ok(doc.cases.length > 0, "facets corpus is empty — OpenSource/Conformance/facets/facets.json");

/** `chain/action` — the corpus's one call spelling (the native array-path convention). */
function split(call: string): [string, string] {
  const i = call.indexOf("/");
  return i < 0 ? [call, ""] : [call.substring(0, i), call.substring(i + 1)];
}

/** The corpus world + one case, as the eight facts the pure ladder consumes. `linked` is
 *  always false here: the CLIENT-LINK table is a web-only rung (Kotlin ships no client link),
 *  so the platform-neutral corpus never asserts it — bus.ts's own link tests cover it. */
function factsFor(c: FacetCase): FacetFacts {
  const [chain, action] = split(c.call);
  const local = c.local ?? {};
  const rows = doc.world.table[chain];
  const row: FacetRow | null = rows === undefined ? null : (rows[action] ?? null);
  return {
    local: (local[chain] ?? []).includes(action),
    module: Object.prototype.hasOwnProperty.call(local, chain),
    facet: c.facet ?? null,
    row,
    transport: c.transport === true,
    linked: false,
    excluded: Object.prototype.hasOwnProperty.call(doc.world.excluded, chain),
    offPlatform: Object.prototype.hasOwnProperty.call(doc.world.platforms, chain),
  };
}

// ── the pure ladder, every case ──────────────────────────────────────────────────────

for (const c of doc.cases) {
  test(`facets/${c.name}`, () => {
    const v = resolveFacetLadder(factsFor(c));
    assert.equal(v.rung, c.expect.rung, `rung (got code ${v.code})`);
    assert.equal(v.code, c.expect.code ?? null, "code");
    if (v.rung !== "unavailable") assert.equal(v.code, null, "only the unavailable rung carries a code");
    else assert.ok(doc.codes.includes(v.code!), `${v.code} is not one of the corpus's frozen codes`);
    assert.equal(v.via !== null, v.rung === "reach", "via is set exactly on the reach rung");
  });
}

test("facets: the retired spellings never appear as an answer", () => {
  // durability.md P4 kept `unsupported_platform` as the never-on-facet class; `never_on_facet`
  // is retired grammar and must never be produced by any runtime.
  const produced = new Set(doc.cases.map((c) => resolveFacetLadder(factsFor(c)).code).filter((x) => x !== null));
  for (const [retired, kept] of Object.entries(doc.retired)) {
    assert.ok(!produced.has(retired), `${retired} is retired — the kept spelling is ${kept}`);
    assert.ok(doc.codes.includes(kept), `${kept} must be a frozen code`);
  }
  assert.ok(produced.size > 0, "the corpus must exercise the unavailable rung");
});

test("facets: the ladder is TOTAL — no input hangs and none answers an untyped absence", () => {
  // Every combination of the boolean facts, against every row shape the world declares plus
  // the row-less case: the answer is always one rung, and an `unavailable` always carries a
  // frozen code. This is the "never a hang, never an untyped throw" law as a fixture.
  const rows: Array<FacetRow | null> = [null];
  for (const chainRows of Object.values(doc.world.table)) for (const row of Object.values(chainRows)) rows.push(row);
  let seen = 0;
  for (const row of rows) {
    for (const facet of [null, "app", "watch", "widget", "activity", "unregistered"]) {
      for (let bits = 0; bits < 64; bits += 1) {
        const v = resolveFacetLadder({
          local: (bits & 1) !== 0, module: (bits & 2) !== 0, facet, row,
          transport: (bits & 4) !== 0, linked: (bits & 8) !== 0,
          excluded: (bits & 16) !== 0, offPlatform: (bits & 32) !== 0,
        });
        seen += 1;
        assert.ok(["local", "reach", "unavailable"].includes(v.rung), `rung ${v.rung}`);
        if (v.rung === "unavailable") assert.ok(doc.codes.includes(v.code!), `untyped absence ${v.code}`);
        else assert.equal(v.code, null);
      }
    }
  }
  assert.equal(seen, rows.length * 6 * 64);
});

// ── the LIVE funnel: the ladder where it actually decides ────────────────────────────
//
// The registry is a per-file singleton (node:test forks a process per file), so the world is
// built once and each test varies only the SEAM — which is the point: the facet plane is
// build data, and nothing else about the bus changes when it arrives.

ModuleRegistry.register(defineModule({
  scheme: "loc",
  actions: { locate: () => ({ lat: 1, lng: 2 }) },
}));
ModuleRegistry.setExcludedIdentities(Object.keys(doc.world.excluded));
ModuleRegistry.unsupportedPlatforms.set("ar", doc.world.platforms["ar"]!);

async function withSeam(facet: string | null, invoke: typeof FacetSeam.invoke, body: () => Promise<void>): Promise<void> {
  FacetSeam.facet = facet;
  FacetSeam.rows = doc.world.table;
  FacetSeam.invoke = invoke;
  try { await body(); } finally {
    FacetSeam.facet = null;
    FacetSeam.rows = {};
    FacetSeam.invoke = null;
  }
}

async function failureOf(callee: string): Promise<{ error: ModuleCallError; funnel: Dict }> {
  const seen: Dict[] = [];
  const off = ModuleRegistry.registerDelegate("module.callFailed", 0, (input) => { seen.push(input as Dict); return null; });
  try {
    await ModuleRegistry.call(callee, {});
    assert.fail(`${callee} resolved — expected a typed failure`);
  } catch (e) {
    assert.ok(e instanceof ModuleCallError, `${callee} threw ${String(e)} — every absence is typed`);
    assert.equal(seen.length, 1, "every failure reports to the ONE diagnostics funnel");
    return { error: e, funnel: seen[0]! };
  } finally { off(); }
}

test("facets: rung one still wins with a seam installed — a local action never consults the table", async () => {
  const reached: unknown[] = [];
  await withSeam("app", async (call, args) => { reached.push([call, args]); return null; }, async () => {
    assert.deepEqual(await ModuleRegistry.call("loc.locate", {}), { lat: 1, lng: 2 });
    assert.deepEqual(reached, [], "the transport must not be touched when the action is local");
  });
});

test("facets: rung two invokes the transport with the resolved chain, action and facet", async () => {
  const reached: unknown[] = [];
  await withSeam("widget", async (call, args) => { reached.push([call, args]); return { ok: true }; }, async () => {
    // `loc.locate` IS local here, but the widget facet is not in its `provides` — the corpus
    // world reaches it instead. Use `loc.relayOnly`, which no local module answers.
    assert.deepEqual(await ModuleRegistry.call("loc.relayOnly", { q: 1 }), { ok: true });
    assert.deepEqual(reached, [[{ chain: "loc", action: "relayOnly", facet: "widget" }, { q: 1 }]]);
  });
});

test("facets: admitted by reach with NO transport is the typed unreachable, never a hang", async () => {
  await withSeam("widget", null, async () => {
    const { error, funnel } = await failureOf("loc.relayOnly");
    assert.equal(error.code, "unreachable");
    assert.equal(funnel["code"], "unreachable");
    assert.deepEqual(error.data, { scheme: "loc", action: "relayOnly", facet: "widget" });
  });
});

test("facets: a transport failure becomes unreachable; the far node's own typed answer passes through", async () => {
  await withSeam("widget", async () => { throw new Error("socket closed"); }, async () => {
    const { error } = await failureOf("loc.relayOnly");
    assert.equal(error.code, "unreachable");
    assert.match(error.message, /socket closed/);
  });
  await withSeam("widget", async () => { throw new ModuleCallError("unauthenticated", "no token"); }, async () => {
    const { error } = await failureOf("loc.relayOnly");
    assert.equal(error.code, "unauthenticated", "a server's typed answer is never flattened to unreachable");
  });
});

test("facets: never-on-this-facet answers unsupported_platform with the facet-shaped data", async () => {
  await withSeam("activity", async () => null, async () => {
    const { error } = await failureOf("beacon.ping");
    assert.equal(error.code, "unsupported_platform");
    assert.deepEqual(error.data, { scheme: "beacon", action: "ping", facet: "activity" });
  });
});

test("facets: the platform catalog keeps its own envelope shape", async () => {
  await withSeam("app", null, async () => {
    const { error } = await failureOf("ar.scan");
    assert.equal(error.code, "unsupported_platform");
    assert.deepEqual((error.data as Dict)["supportedPlatforms"], doc.world.platforms["ar"]);
  });
});

test("facets: a promised local implementation nobody stood up is prerequisites_missing", async () => {
  await withSeam("app", null, async () => {
    const { error } = await failureOf("beacon.ping");
    assert.equal(error.code, "prerequisites_missing");
    assert.deepEqual(error.data, { scheme: "beacon", action: "ping", facet: "app" });
  });
  // …while a chain that IS registered here keeps answering `unknown_action` for a name it
  // does not register: the module is present, so that is a caller bug, never absence.
  await withSeam("app", null, async () => {
    assert.equal((await failureOf("loc.geofence")).error.code, "unknown_action");
  });
});

test("facets: a build fact still beats a runtime one — excluded outranks prerequisites_missing", async () => {
  await withSeam("app", null, async () => {
    const { error } = await failureOf("quarantined.ping");
    assert.equal(error.code, "excluded");
    assert.deepEqual(error.data, { reason: "excluded" }, "the DespiaExcluded entry rides verbatim");
  });
});

test("facets: the EMPTY seam answers exactly what the funnel answered before the ladder", async () => {
  // No facet word, no table, no transport: every facet rung is skipped and the build-fact
  // rungs are all that remain — `unknown_action`, `excluded`, `not_loaded`, unchanged.
  assert.equal(FacetSeam.facet, null);
  assert.deepEqual(FacetSeam.rows, {});
  assert.equal((await failureOf("loc.geofence")).error.code, "unknown_action", "the module IS here");
  assert.equal((await failureOf("quarantined.ping")).error.code, "excluded");
  assert.equal((await failureOf("ghost.run")).error.code, "not_loaded");
  // …and the module proxy face agrees, because it rides the same funnel
  const dsx = makeDsx("facets-test");
  await assert.rejects(() => dsx.module["ghost"]!["run"]!({}),
    (e: unknown) => e instanceof ModuleCallError && e.code === "not_loaded");
});
