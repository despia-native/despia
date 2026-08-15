//
//  cors-embed.test.ts — the embed CORS enforcement (/web/13 §32, S-06). serve.ts sends CORS
//  for /embed assets per a package's web.embed.origins allowlist. The G10 Playwright walk only
//  ever drives an origins:["*"] package, so before this file the DENY branch and the
//  EXACT-ORIGIN-MATCH branch of corsDecision were executed by ZERO gates. This drives the pure
//  decision over the fixtures/cors-embed-cases.json table (build-independent — demo/site is a
//  gitignored build output, so a test that leans on a built manifest would fail in a clean CI).
//  CORS is web-only embed-server infrastructure (no native twin), so the corpus is web-local.
//

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { corsDecision } from "../bin/serve.ts";

type Case = {
  name: string;
  origins: string[];
  requestOrigin: string | null;
  expect: Record<string, string>;
};
const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/cors-embed-cases.json", import.meta.url), "utf8"),
) as { cases: Case[] };

test("the CORS corpus is populated and reaches BOTH non-star branches (else the gate is vacuous)", () => {
  assert.ok(corpus.cases.length >= 10, `expected a populated corpus, got ${corpus.cases.length}`);
  // exact-match branch present: a case whose non-star allowlist echoes the request origin
  assert.ok(
    corpus.cases.some((c) => !c.origins.includes("*") && c.expect["access-control-allow-origin"] === c.requestOrigin && c.requestOrigin !== null),
    "corpus must exercise the EXACT-ORIGIN-MATCH branch",
  );
  // deny branch present: a case whose non-star allowlist echoes NOTHING for the request origin
  assert.ok(
    corpus.cases.some((c) => !c.origins.includes("*") && Object.keys(c.expect).length === 0),
    "corpus must exercise the DENY branch",
  );
});

for (const c of corpus.cases) {
  test(`cors: ${c.name}`, () => {
    const decision = corsDecision(c.origins, c.requestOrigin ?? undefined);
    assert.deepEqual(decision, c.expect);
    // the exact-match branch must ALWAYS carry vary:origin so a shared cache never serves one
    // origin's allow-header to another; the * and deny branches must never carry it
    if (c.expect["access-control-allow-origin"] !== undefined && c.expect["access-control-allow-origin"] !== "*") {
      assert.equal(decision["vary"], "origin", "an exact-origin allow must set vary:origin");
    } else {
      assert.equal(decision["vary"], undefined, "the * and deny branches never set vary");
    }
  });
}
