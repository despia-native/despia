//
//  `<api>` joins the egress funnel (studio-apps.md §8; the block-tier twin of
//  RunEnv.egress). The gate cases ride the shared corpus's egress section
//  (OpenSource/Conformance/studio-apps/scope.json) so the block tier and the module
//  funnel can never disagree about what a granted host means.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ApiBlock, ReactiveStore, RunnerFetchSeam, type ApiSpec, type Dict } from "../src/index.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/studio-apps/scope.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/studio-apps/scope.json not found");
    dir = parent;
  }
}

const egressCases = (JSON.parse(readFileSync(corpusFile(), "utf-8")) as {
  egress: Array<{ name: string; hosts: string[]; url: string; allow: boolean }>;
}).egress;
assert.ok(egressCases.length > 0, "egress cases missing");

/** the corpus gate, restated once here (suffix match, https only) — the block consumes a
 *  predicate, so the test proves CONSULTATION, not the fold (scope.js owns the fold) */
function gateOf(hosts: string[]): (url: string) => boolean {
  const allowed = hosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
  if (allowed.length === 0) return () => false;
  return (url: string): boolean => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      const host = parsed.hostname.toLowerCase();
      return allowed.some((a) => host === a || host.endsWith(`.${a}`));
    } catch { return false; }
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

test("api-egress: a gated block never reaches the transport for a refused URL — the refused envelope settles", async () => {
  let fetched = 0;
  RunnerFetchSeam.impl = () => { fetched += 1; return Promise.resolve({ ok: true, status: 200, data: { hit: true } }); };
  try {
    const store = new ReactiveStore();
    const spec = { as: "leak", url: "https://evil.tld/x", auto: "true" } as unknown as ApiSpec;
    const block = new ApiBlock(spec, store, {}, { egress: gateOf(["acme.dev"]) });
    void block;
    await settle();
    assert.equal(fetched, 0, "the transport must never see a refused URL");
    const envelope = store.jse.vars.get("leak") as Dict;
    assert.notEqual(envelope["error"], null, "the block settles its declared error shape");
    assert.equal(envelope["loading"], false);
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api-egress: a granted URL fetches exactly as before", async () => {
  let fetched = 0;
  RunnerFetchSeam.impl = () => { fetched += 1; return Promise.resolve({ ok: true, status: 200, data: { hit: true } }); };
  try {
    const store = new ReactiveStore();
    const spec = { as: "ok", url: "https://api.acme.dev/v1", auto: "true" } as unknown as ApiSpec;
    const block = new ApiBlock(spec, store, {}, { egress: gateOf(["acme.dev"]) });
    void block;
    await settle();
    assert.equal(fetched, 1);
    const envelope = store.jse.vars.get("ok") as Dict;
    assert.deepEqual(envelope["data"], { hit: true });
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api-egress: an ungated block is byte-identical to before — the option is opt-in", async () => {
  let fetched = 0;
  RunnerFetchSeam.impl = () => { fetched += 1; return Promise.resolve({ ok: true, status: 200, data: null }); };
  try {
    const store = new ReactiveStore();
    const spec = { as: "plain", url: "https://anywhere.example/x", auto: "true" } as unknown as ApiSpec;
    const block = new ApiBlock(spec, store, {}, {});
    void block;
    await settle();
    assert.equal(fetched, 1);
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

for (const c of egressCases) {
  test(`api-egress/gate: ${c.name}`, () => {
    assert.equal(gateOf(c.hosts)(c.url), c.allow);
  });
}
