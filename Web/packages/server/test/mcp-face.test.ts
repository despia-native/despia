//
//  mcp-face.test.ts — the MCP server-transport corpus through the face directly (the node
//  leg; the workerd leg in test/workers/ runs the same file through the bundled bootloader).
//  Plus the face's own creation-time seams the corpus cannot express: the duplicate-name
//  abort and the not-mine null for foreign paths.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { createMcpFace } from "../src/mcp-face.ts";
import { caseRequest, checkCase, corpusHandlers, type McpTransportCorpus } from "./mcp-transport-runner.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/ai/mcp/server-transport.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("mcp server-transport corpus not found");
    dir = parent;
  }
}

const corpus = JSON.parse(readFileSync(corpusFile(), "utf-8")) as McpTransportCorpus;
assert.ok(corpus.cases.length > 0, "server-transport corpus is empty");

const face = createMcpFace({
  tools: corpus.tools,
  handlers: corpusHandlers(corpus),
  buildInfo: { digest: "fixture-digest" },
  onError: () => {}, // the corpus's leak case exercises the wire, not the sink
});

const env = (): string | undefined => undefined;

for (const c of corpus.cases) {
  test(`mcp-transport/${c.name}`, async () => {
    const res = await face(caseRequest(c, "https://mcp.test"), { identity: c.identity ?? null, env });
    assert.ok(res !== null, "the face disowned its own path");
    const failures = await checkCase(c, res);
    assert.equal(failures.length, 0, failures.join("\n"));
  });
}

test("mcp-face: a foreign path is not mine — null, so the host chain continues", async () => {
  const res = await face(new Request("https://mcp.test/health"), { identity: null, env });
  assert.equal(res, null);
});

test("mcp-face: two tools with one name refuse at creation, not the Nth call", () => {
  assert.throws(
    () => createMcpFace({
      tools: [
        { name: "t", chain: "a", action: "x", description: "one" },
        { name: "t", chain: "b", action: "y", description: "two" },
      ],
      handlers: {},
    }),
    /duplicate tool name/,
  );
});

test("mcp-face: a tool naming an unregistered action is a protocol error, not a crash", async () => {
  const lone = createMcpFace({ tools: [{ name: "ghost", chain: "nowhere", action: "gone", description: "x" }], handlers: {} });
  const res = await lone(caseRequest({
    name: "", request: { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ghost" } } }, expect: { status: 200 },
  }, "https://mcp.test"), { identity: null, env });
  const body = (await res!.json()) as { error?: { code: number; message: string } };
  assert.equal(body.error?.code, -32602);
  assert.ok(body.error?.message.includes("nowhere.gone"));
});
