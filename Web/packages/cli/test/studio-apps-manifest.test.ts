//
//  The manifest grammar, driven by the shared corpus — the TS half of the two-validator
//  contract (the ruby half is ClosedSource/scripts/check_studio_apps.rb, same fixtures).
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift starts.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  APP_MANIFEST_CODES,
  APP_SLOTS,
  APP_BUDGETS,
  EDITOR_EVENTS,
  PLATFORM_EVENTS,
  manifestGrants,
  readAppManifest,
  STUDIO_API,
} from "../src/studio-apps/manifest.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/studio-apps/manifest.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`OpenSource/Conformance/studio-apps/manifest.json not found walking up from ${import.meta.dirname}`);
    dir = parent;
  }
}

type Case = {
  name: string;
  manifest: unknown;
  expect: { app?: false; ok?: boolean; contributions?: number; grants?: string[]; order?: string[]; codes?: string[] };
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as {
  vocabulary: { studioApi: number; slots: string[]; editorEvents: string[]; platformEvents: string[]; budgets: Record<string, number> };
  cases: Case[];
};
assert.ok(doc.cases.length > 0, "studio-apps manifest corpus is empty");

test("studio-apps/manifest: the corpus vocabulary and the validator's constants agree", () => {
  assert.equal(doc.vocabulary.studioApi, STUDIO_API);
  assert.deepEqual(doc.vocabulary.slots, [...APP_SLOTS]);
  assert.deepEqual(doc.vocabulary.editorEvents, [...EDITOR_EVENTS]);
  assert.deepEqual(doc.vocabulary.platformEvents, [...PLATFORM_EVENTS]);
  assert.deepEqual(doc.vocabulary.budgets, { ...APP_BUDGETS });
});

for (const c of doc.cases) {
  test(`studio-apps/manifest: ${c.name}`, () => {
    const { info, issues } = readAppManifest(c.manifest);
    if (c.expect.app === false) {
      assert.equal(info, null, "not-an-app answers no info");
      assert.equal(issues.length, 0, `not-an-app answers no issues (got ${JSON.stringify(issues)})`);
      return;
    }
    if (c.expect.ok === true) {
      assert.equal(issues.length, 0, `expected a valid app, got issues: ${JSON.stringify(issues)}`);
      assert.ok(info !== null, "a valid app answers info");
      if (c.expect.contributions !== undefined) assert.equal(info.contributions.length, c.expect.contributions);
      if (c.expect.grants !== undefined) assert.deepEqual(manifestGrants(info), c.expect.grants);
      if (c.expect.order !== undefined) assert.deepEqual(info.contributions.map((r) => r.id), c.expect.order);
      return;
    }
    assert.equal(info, null, "an invalid app never answers info — fail-closed");
    const codes = [...new Set(issues.map((i) => i.code))].sort();
    assert.deepEqual(codes, [...(c.expect.codes ?? [])].sort(), `issue codes (messages are free, codes are the contract)`);
    for (const i of issues) {
      assert.ok((APP_MANIFEST_CODES as readonly string[]).includes(i.code), `${i.code} is not in the closed code vocabulary`);
      assert.ok(i.path.length >= 0 && i.message.length > 0, "every issue carries a path and a sentence");
    }
  });
}
