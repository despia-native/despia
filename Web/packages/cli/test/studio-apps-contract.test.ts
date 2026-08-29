//
//  The Studio API contract artifact (support/studio-api-v1.json) is the one pinned statement
//  of what an app may name. This test holds the artifact, the validator's exported constants
//  and the corpus vocabulary to byte-agreement, so none of the three can drift — the
//  public-api-contract discipline applied to the app surface. A change that fails here is a
//  CONTRACT change: additive within the major (update artifact + corpus + code together in
//  one commit), anything else bumps studioApi.
//

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { routeChain as headlessRoute } from "../src/studio-apps/headless.ts";
import {
  APP_BUDGETS,
  APP_MANIFEST_CODES,
  APP_SLOTS,
  EDITOR_EVENTS,
  FIXED_GRANTS,
  PLATFORM_EVENTS,
  STUDIO_API,
} from "../src/studio-apps/manifest.ts";

const artifactPath = resolve(import.meta.dirname ?? ".", join("..", "..", "..", "support", "studio-api-v1.json"));

test("studio-apps/contract: the artifact and the code state the same law", () => {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
    studioApi: number;
    slots: string[];
    grants: { fixed: string[]; parameterized: string[] };
    events: { editor: string[]; platform: string[] };
    seams: string[];
    budgets: Record<string, number>;
    issueCodes: string[];
  };
  assert.equal(artifact.studioApi, STUDIO_API);
  assert.deepEqual(artifact.slots, [...APP_SLOTS]);
  assert.deepEqual(artifact.grants.fixed, [...FIXED_GRANTS]);
  assert.deepEqual(artifact.grants.parameterized, ["net:<host>", "secret:<NAME>", "data:<entity>"]);
  assert.deepEqual(artifact.events.editor, [...EDITOR_EVENTS]);
  assert.deepEqual(artifact.events.platform, [...PLATFORM_EVENTS]);
  assert.deepEqual(artifact.budgets, { ...APP_BUDGETS });
  assert.deepEqual(artifact.issueCodes, [...APP_MANIFEST_CODES]);
  // THE SEAM LIST IS NOT A LABEL. Every name the artifact publishes must actually route on
  // the funnel an app reaches — an artifact that advertises a seam nobody implements is the
  // catalogue lying about the runtime, which is the Article 10 failure in miniature.
  const SAMPLE: Record<string, Record<string, unknown>> = {
    "studio.project.read": { name: "Components/App.dsx" },
    "studio.project.tree": { name: "Components/App.dsx" },
    "studio.project.edit": { name: "Components/App.dsx" },
    "studio.project.create": { name: "Components/New.dsx", source: "<stack/>" },
    "studio.ui.toast": { text: "x" },
  };
  const all = new Set([...FIXED_GRANTS, "net:acme.dev"]);
  for (const seam of artifact.seams) {
    const verdict = headlessRoute(seam, all, SAMPLE[seam] ?? {});
    assert.notEqual(verdict["verdict"], "unsupported", `${seam} is published but unroutable`);
    assert.notEqual(verdict["verdict"], "unknown_action", `${seam} is published but unknown: ${String(verdict["message"])}`);
  }

  // The seam list is pinned here and implemented by studio-apps/scope.ts; its test asserts
  // every chain it serves appears in this artifact (never the reverse — additive law).
  assert.ok(artifact.seams.length >= 12, "the seam list only grows within a major");
});
