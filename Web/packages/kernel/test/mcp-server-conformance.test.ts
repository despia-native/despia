//
//  The MCP Apps SERVER-half corpus, run against the TS shaping.
//  Corpus: OpenSource/Conformance/mcp-apps/server.json — the same file the Kotlin and
//  Swift routers run as they land, which is what keeps the metadata and the fallback
//  from drifting per platform.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { hostSupportsUi, mcpToolResult, uiResourceUri } from "../src/mcp/result.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    try {
      readFileSync(join(dir, "OpenSource/Conformance/README.md"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("repo root not found");
      dir = parent;
    }
  }
}

type Case = {
  name: string;
  derive?: { scheme: string; action: string };
  capabilities?: unknown;
  value?: unknown;
  options?: Record<string, any>;
  expect: Record<string, any>;
};

const corpus = JSON.parse(
  readFileSync(join(repoRoot(), "OpenSource/Conformance/mcp-apps/server.json"), "utf8"),
) as { cases: Case[] };

for (const testCase of corpus.cases) {
  test(`mcp-server: ${testCase.name}`, () => {
    if (testCase.expect.uri !== undefined) {
      const d = testCase.derive as { scheme: string; action: string };
      assert.equal(uiResourceUri(d.scheme, d.action), testCase.expect.uri);
    }
    if (testCase.expect.supportsUi !== undefined) {
      assert.equal(hostSupportsUi(testCase.capabilities), testCase.expect.supportsUi);
    }
    if (testCase.expect.result !== undefined) {
      assert.deepEqual(mcpToolResult(testCase.value, testCase.options ?? {}), testCase.expect.result);
    }
  });
}
