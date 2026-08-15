//
//  tier-conformance.test.ts - the SHARED tier-verdict corpus
//  (OpenSource/Conformance/tier/verdicts.json) through the TS classifier — the REFERENCE
//  leg of the W9 tier-equivalence lane (rendering-1.0-finalization.md). The Kotlin
//  (TierConformanceTest.kt) and Swift (ConformanceHosts.TierConformance) twins run the
//  SAME file, so the three classifiers cannot drift: since the strict-rejection
//  hardening the TS verdict is the compiler's subset gate (JSESubsetError on "js"), so
//  a disagreement means a body compiles on one renderer and escalates on another.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { classifyBody } from "../src/compile/tier.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/tier/verdicts.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("tier corpus not found");
    dir = parent;
  }
}

type Case = {
  name: string;
  body: string;
  tier: "jse" | "js";
  /** stated for every js case; matched as a SUBSTRING of the reason (wording differs
   *  per runner — the corpus README names the stable fragments) */
  reasonContains: string | null;
  note?: string;
};

const doc = JSON.parse(readFileSync(corpusFile(), "utf-8")) as { cases: Case[] };
assert.ok(doc.cases.length >= 20, "tier corpus is suspiciously small");

for (const c of doc.cases) {
  test(`tier-corpus/${c.name}`, () => {
    const v = classifyBody(c.body);
    assert.equal(v.tier, c.tier,
      `${c.name}: classified ${v.tier} (expected ${c.tier}) — reason ${v.reason ?? "null"}`);
    if (c.tier === "js") {
      // corpus discipline: every js case names its stable reason fragment — a missing
      // substring is a malformed case, not a skippable one (silent skips are how drift starts)
      assert.ok(typeof c.reasonContains === "string" && c.reasonContains.length > 0,
        `${c.name}: a js case must state reasonContains`);
      assert.ok((v.reason ?? "").includes(c.reasonContains),
        `${c.name}: reason ${JSON.stringify(v.reason)} does not contain ${JSON.stringify(c.reasonContains)}`);
    } else {
      assert.equal(v.reason, null, `${c.name}: a jse verdict carries no reason`);
    }
  });
}
