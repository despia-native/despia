//
//  The mount-table fold, driven by the shared corpus. Each case's manifests pass through
//  readAppManifest first, so the fold provably consumes exactly what the grammar admits.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readAppManifest } from "../src/studio-apps/manifest.ts";
import { resolveStudioApps, type DiscoveredApp, type StudioAppsTable } from "../src/studio-apps/host.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/studio-apps/slots.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/studio-apps/slots.json not found");
    dir = parent;
  }
}

type Case = {
  name: string;
  apps: Array<{ kind: DiscoveredApp["kind"]; lockId?: string; manifest: unknown }>;
  state: Record<string, { enabled: boolean; version: string; grants: string[]; grantedAt: string }>;
  opts?: { studioApi?: number; denylist?: string[]; approvals?: Record<string, string> };
  expect: Partial<Record<keyof StudioAppsTable, string[]>> & { refusals?: Array<{ app: string; reason: string }> };
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length > 0, "slots corpus is empty");

const LANES: ReadonlyArray<keyof StudioAppsTable> = ["panels", "rail", "styleSections", "inspectorSections", "cards", "tools", "automations"];

for (const c of doc.cases) {
  test(`studio-apps/slots: ${c.name}`, () => {
    const apps: DiscoveredApp[] = c.apps.map((a) => {
      const { info, issues } = readAppManifest(a.manifest);
      assert.ok(info !== null, `corpus manifest must be valid (got ${JSON.stringify(issues)})`);
      return { kind: a.kind, dir: `/fixture/${info.scheme}`, info, lockId: a.lockId ?? "" };
    });
    const { table, refusals } = resolveStudioApps(apps, c.state, c.opts ?? {});
    for (const lane of LANES) {
      const expected = c.expect[lane];
      if (expected === undefined) continue;
      assert.deepEqual(table[lane].map((r) => `${r.app}#${r.contribution.id}`), expected, lane);
    }
    const expectedRefusals = c.expect.refusals ?? [];
    assert.equal(refusals.length, expectedRefusals.length,
      `refusal count (got ${JSON.stringify(refusals)})`);
    for (const expected of expectedRefusals) {
      const hit = refusals.find((r) => r.app === expected.app && r.reason.includes(expected.reason));
      assert.ok(hit !== undefined, `expected a refusal for ${expected.app} containing ${JSON.stringify(expected.reason)} (got ${JSON.stringify(refusals)})`);
    }
  });
}
