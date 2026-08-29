//
//  mcp-http.test.ts — the agent door: the toolchain MCP served over HTTP by `despia edit`
//  (07-agent-plane). The handler is the SAME handleRpc the stdio command runs; these tests
//  pin the transport envelope — one POST is one JSON-RPC exchange, a notification answers
//  202 with no body, anything that is not a POST is refused with the allowed verb, and the
//  presence record the Agents panel reads reflects who connected and how much they did.
//

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { createMcpHttpHandler, type AgentPresence } from "../src/edit.ts";

function serve(): Promise<{ url: string; server: Server; presence: AgentPresence }> {
  const { presence, handle } = createMcpHttpHandler();
  const server = createServer((req, res) => { void handle(req, res); });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}`, server, presence });
    });
  });
}

async function rpc(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

test("initialize answers the toolchain's server info and records the client", async () => {
  const { url, server, presence } = await serve();
  try {
    const res = await rpc(url, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.0.0" }, capabilities: {} },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { result: { serverInfo: { name: string } } };
    assert.equal(body.result.serverInfo.name, "despia-toolchain");
    assert.deepEqual(presence.client, { name: "claude-code", version: "2.0.0" });
    assert.ok(presence.lastSeen !== null);
  } finally { server.close(); }
});

test("tools/list carries the generated command table - lint is a tool, edit refuses to hang", async () => {
  const { url, server } = await serve();
  try {
    const res = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = await res.json() as { result: { tools: { name: string; description: string }[] } };
    const names = body.result.tools.map((t) => t.name);
    assert.ok(names.includes("despia_lint"));
    const edit = body.result.tools.find((t) => t.name === "despia_edit");
    assert.ok(edit !== undefined && edit.description.includes("long-running"));
  } finally { server.close(); }
});

test("a notification gets 202 and no body, and still counts as presence", async () => {
  const { url, server, presence } = await serve();
  try {
    const res = await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
    assert.ok(presence.lastSeen !== null);
  } finally { server.close(); }
});

test("tools/call runs the real command path and is counted", async () => {
  const { url, server, presence } = await serve();
  try {
    const res = await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "despia_edit", arguments: {} } });
    assert.equal(res.status, 200);
    const body = await res.json() as { result: { isError?: boolean; content: { text: string }[] } };
    // `edit` holds a server open, so the tool explains how to start it instead of hanging.
    assert.equal(body.result.isError, true);
    assert.ok(body.result.content[0]!.text.includes("despia edit"));
    assert.equal(presence.calls, 1);
  } finally { server.close(); }
});

test("GET is refused with the allowed verb - the door is POSTed JSON-RPC", async () => {
  const { url, server } = await serve();
  try {
    const res = await fetch(url);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  } finally { server.close(); }
});

test("unparseable JSON is a 400 with the JSON-RPC parse error, never a crash", async () => {
  const { url, server } = await serve();
  try {
    const res = await fetch(url, { method: "POST", body: "{nope" });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: number } };
    assert.equal(body.error.code, -32700);
  } finally { server.close(); }
});
