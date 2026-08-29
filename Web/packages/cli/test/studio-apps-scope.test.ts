//
//  The studio residence seam table, driven by the shared corpus — runs on the MODULE-OWNED
//  implementation (Core/Apps/web/scope.js), because the policy lives with its owner and a
//  test that drove a copy would prove the copy.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance/studio-apps/scope.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/studio-apps/scope.json not found");
    dir = parent;
  }
}

const root = repoRoot();
const corpus = JSON.parse(readFileSync(join(root, "OpenSource/Conformance/studio-apps/scope.json"), "utf-8")) as {
  cases: Array<{ name: string; grants: string[]; chain: string; args?: Record<string, unknown>; expect: Record<string, unknown> }>;
  egress: Array<{ name: string; hosts: string[]; url: string; allow: boolean }>;
};
assert.ok(corpus.cases.length > 0, "scope corpus is empty");


// The module's bare `@despia-native/kernel` import resolves through the page's import map in a
// build; node has no map here, so the shim rewrites it to the workspace's own kernel —
// the SAME class identity the runner's instanceof check sees in a real page.
import { mkdtempSync, writeFileSync as writeTmp } from "node:fs";
import { tmpdir } from "node:os";
async function importScopeModule(root: string): Promise<Record<string, any>> {
  const source = readFileSync(join(root, "ClosedSource/DSX/Modules/Core/Apps/web/scope.js"), "utf8");
  const kernel = pathToFileURL(join(root, "OpenSource/Web/node_modules/@despia-native/kernel/dist/index.js")).href;
  const rewritten = source.replace('from "@despia-native/kernel"', `from ${JSON.stringify(kernel)}`);
  const dir = mkdtempSync(join(tmpdir(), "dsx-scope-"));
  const file = join(dir, "scope.mjs");
  writeTmp(file, rewritten);
  return await import(pathToFileURL(file).href) as Record<string, any>;
}

const scopeModule = await importScopeModule(root) as {
  routeChain: (chain: string, grants: Set<string>, args?: Record<string, unknown>) => Record<string, unknown>;
  egressGate: (hosts: readonly string[]) => (url: string) => boolean;
  appScope: (opts: unknown) => (chain: string, args: Record<string, unknown>) => Promise<unknown>;
  handlerName: (kind: string) => string;
};

// TWO IMPLEMENTATIONS, ONE CORPUS: the module-owned web funnel (a mounted surface's seam
// table) and the CLI's headless twin (`despia app run`, the MCP face). An interface is one
// consumer of an app — this loop is what keeps the other consumers honest.
import { routeChain as headlessRoute, egressGate as headlessEgress } from "../src/studio-apps/headless.ts";

const IMPLEMENTATIONS: Array<[string, { routeChain: (c: string, g: Set<string>, a?: Record<string, unknown>) => Record<string, unknown>; egressGate: (h: readonly string[]) => (u: string) => boolean }]> = [
  ["web", scopeModule as never],
  ["headless", { routeChain: headlessRoute, egressGate: headlessEgress }],
];

for (const [impl, table] of IMPLEMENTATIONS) {
  for (const c of corpus.cases) {
    test(`studio-apps/scope [${impl}]: ${c.name}`, () => {
      const verdict = table.routeChain(c.chain, new Set(c.grants), c.args ?? {});
      for (const [key, value] of Object.entries(c.expect)) {
        assert.equal(verdict[key], value, `${key} (got ${JSON.stringify(verdict)})`);
      }
    });
  }
  for (const e of corpus.egress) {
    test(`studio-apps/scope egress [${impl}]: ${e.name}`, () => {
      assert.equal(table.egressGate(e.hosts)(e.url), e.allow);
    });
  }
}

test("studio-apps/scope: the bound funnel refuses with the frozen vocabulary and names the grant", async () => {
  const funnel = scopeModule.appScope({
    scheme: "acmecopy",
    grants: new Set<string>(),
    door: () => Promise.resolve({ status: 200, body: null }),
    storage: { read: () => ({}), write: () => {} },
  });
  await assert.rejects(() => funnel("studio.project.list", {}), (e: { code?: string; message?: string }) => {
    assert.equal(e.code, "forbidden");
    assert.match(e.message ?? "", /project:read/);
    return true;
  });
  await assert.rejects(() => funnel("pay.charge", {}), (e: { code?: string }) => e.code === "unsupported");
});

test("studio-apps/scope: storage is namespaced convenience — set, get, list, remove round-trip", async () => {
  let store: Record<string, unknown> = {};
  const funnel = scopeModule.appScope({
    scheme: "acmecopy",
    grants: new Set<string>(),
    door: () => Promise.resolve({ status: 200, body: null }),
    storage: { read: () => store, write: (v: Record<string, unknown>) => { store = v; } },
  });
  await funnel("app.storage.set", { key: "draft", value: { n: 1 } });
  assert.deepEqual(await funnel("app.storage.get", { key: "draft" }), { n: 1 });
  assert.deepEqual(await funnel("app.storage.list", {}), ["draft"]);
  await funnel("app.storage.remove", { key: "draft" });
  assert.equal(await funnel("app.storage.get", { key: "draft" }), null);
});

test("studio-apps/scope: a door conflict maps to `conflict` — the app re-reads and retries", async () => {
  const funnel = scopeModule.appScope({
    scheme: "acmecopy",
    grants: new Set(["project:write"]),
    door: () => Promise.resolve({ status: 409, body: { reason: "stale_revision", message: "the file changed" } }),
    storage: { read: () => ({}), write: () => {} },
  });
  await assert.rejects(() => funnel("studio.project.edit", { name: "Components/App.dsx", edits: [] }),
    (e: { code?: string }) => e.code === "conflict");
});
