//
//  The SHOT corpus on the TS runner (reference). OpenSource/Conformance/shot/{scope,guards}.json
//  drive the two pure halves of the screenshot plane - the scope ladder and the guard set.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveShotScope, templateToPattern, seamCollisions, evaluateShotGuards,
  type ShotHead, type ShotSeamRoute, type FrameSettle,
} from "../dist/index.js";

const corpusDir = join(import.meta.dirname, "../../../../Conformance/shot");
const scope = JSON.parse(readFileSync(join(corpusDir, "scope.json"), "utf8"));
const guards = JSON.parse(readFileSync(join(corpusDir, "guards.json"), "utf8"));

type Case = {
  name: string;
  head: ShotHead;
  hydrate?: unknown;
  snapshot?: unknown;
  overrides?: unknown;
  routeParams?: Record<string, unknown>;
  mode?: "sample" | "replay" | "live";
  cassetteKeys?: string[];
  expectVars?: Record<string, unknown>;
  expectAttrs?: Record<string, unknown>;
  expectGlobals?: Record<string, unknown>;
  expectSeeds?: Record<string, unknown>;
  expectRoutes?: Array<{ as: string; method: string; template: string }>;
  expectUnresolved: Array<{ kind: string; name: string }>;
};

for (const section of ["ladder", "variables", "expects", "globals", "responsePlane"] as const) {
  for (const c of scope[section] as Case[]) {
    test(`shot/scope ${section}: ${c.name}`, () => {
      const got = resolveShotScope({
        head: c.head,
        hydrate: c.hydrate as never,
        snapshot: c.snapshot as never,
        overrides: c.overrides as never,
        routeParams: c.routeParams,
        mode: c.mode,
        cassetteKeys: c.cassetteKeys,
      });
      if (c.expectVars !== undefined) {
        assert.deepEqual(got.vars, c.expectVars, "vars");
      }
      if (c.expectAttrs !== undefined) {
        assert.deepEqual(got.attrs, c.expectAttrs, "attrs");
      }
      if (c.expectGlobals !== undefined) {
        assert.deepEqual(got.globals, c.expectGlobals, "globals");
      }
      if (c.expectSeeds !== undefined) {
        const seeds: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(got.apiSeeds)) seeds[k] = v.data;
        assert.deepEqual(seeds, c.expectSeeds, "apiSeeds");
      }
      if (c.expectRoutes !== undefined) {
        assert.deepEqual(
          got.seamPlan.map((r) => ({ as: r.as, method: r.method, template: r.template })),
          c.expectRoutes,
          "seamPlan",
        );
      }
      assert.deepEqual(
        got.unresolved.map((u) => ({ kind: u.kind, name: u.name })),
        c.expectUnresolved,
        "unresolved",
      );
      // Every unresolved row carries a fix an author can act on - the report IS the product
      // surface, so a bare "missing" would make the agent loop useless.
      for (const u of got.unresolved) {
        assert.ok(u.fix.length > 0, `unresolved ${u.name} carries no fix`);
        assert.ok(u.reason.length > 0, `unresolved ${u.name} carries no reason`);
      }
    });
  }
}

for (const t of scope.templates as Array<{ name: string; template: string; matches: string[]; rejects: string[] }>) {
  test(`shot/scope template: ${t.name}`, () => {
    const re = new RegExp(templateToPattern(t.template));
    for (const url of t.matches) assert.ok(re.test(url), `${t.template} should match ${url}`);
    for (const url of t.rejects) assert.ok(!re.test(url), `${t.template} should NOT match ${url}`);
  });
}

for (const c of scope.collisions as Array<{ name: string; routes: ShotSeamRoute[]; expect: Array<{ a: string; b: string }> }>) {
  test(`shot/scope collision: ${c.name}`, () => {
    const routes = c.routes.map((r) => ({ ...r, pattern: templateToPattern(r.template) }));
    assert.deepEqual(seamCollisions(routes), c.expect);
  });
}

const DEFAULT_SETTLE = guards._settleDefault as FrameSettle;

for (const c of guards.cases as Array<{
  name: string;
  allowEmpty?: true | string[];
  settle?: FrameSettle;
  report: { apis: never[]; collections: never[]; seamMisses: string[] };
  expect: Array<{ guard: string; subject: string }>;
}>) {
  test(`shot/guards: ${c.name}`, () => {
    const findings = evaluateShotGuards(
      { ...c.report, settle: c.settle ?? DEFAULT_SETTLE },
      { allowEmpty: c.allowEmpty },
    );
    assert.deepEqual(
      findings.map((f) => ({ guard: f.guard, subject: f.subject })),
      c.expect,
    );
    for (const f of findings) assert.ok(f.fix.length > 0, `${f.subject} carries no fix`);
  });
}
