//
//  mcp.test.ts — the toolchain MCP. The load-bearing property is PARITY BY CONSTRUCTION: the
//  tool list is derived from the same `<cli>` document the terminal parses, so a command cannot
//  exist in one face and be missing from the other. The tests assert the derivation, not a
//  hand-kept list, because a hand-kept list is the thing this design exists to avoid.
//

import test from "node:test";
import assert from "node:assert/strict";

import { CLI_DOCUMENT } from "../src/cli.ts";
import {
  LONG_RUNNING, PROTOCOL_VERSION, argvFor, callTool, commandName, handleRpc, toolName,
  toolsFromDocument,
} from "../src/mcp.ts";

test("PARITY: every declared command is a tool, and nothing else is", () => {
  const tools = toolsFromDocument().map((t) => t.name).sort();
  const expected = CLI_DOCUMENT.commands.map((c) => toolName(c.name)).sort();
  assert.deepEqual(tools, expected,
    "the tool list is DERIVED from the command table; if this ever needs a manual fix, the " +
    "derivation broke and parity is no longer structural");
  assert.ok(tools.includes("despia_add") && tools.includes("despia_export") && tools.includes("despia_lint"));
});

test("the name mapping round-trips, including hyphenated commands", () => {
  for (const command of CLI_DOCUMENT.commands) {
    assert.equal(commandName(toolName(command.name)), command.name);
  }
  assert.equal(commandName("not_ours"), null);
});

test("schemas come from the declared flags and positionals", () => {
  const add = toolsFromDocument().find((t) => t.name === "despia_add")!;
  assert.equal(add.inputSchema.properties["package"]?.type, "string");
  assert.equal(add.inputSchema.properties["dry-run"]?.type, "boolean");
  assert.ok(add.inputSchema.required.includes("package"),
    "a non-variadic positional is required, so the agent learns it from the schema rather than from a usage error");

  const lint = toolsFromDocument().find((t) => t.name === "despia_lint")!;
  assert.equal(lint.inputSchema.properties["files"]?.type, "array", "a variadic positional takes a list");
  assert.ok(!lint.inputSchema.required.includes("files"));
});

test("argv is rebuilt in the order the parser expects, with --flag=value", () => {
  const add = CLI_DOCUMENT.commands.find((c) => c.name === "add")!;
  assert.deepEqual(
    argvFor(add, { package: "github:acme/x@1.0.0", project: "/tmp/p", "dry-run": true }),
    ["add", "github:acme/x@1.0.0", "--project=/tmp/p", "--dry-run"]);

  // The joined form is not cosmetic: an agent-supplied value may begin with a dash, and the
  // two-token form would have the parser read it as the next flag.
  assert.deepEqual(argvFor(add, { package: "p", project: "--sneaky" }),
    ["add", "p", "--project=--sneaky"]);

  // A false boolean is absent, not `--flag=false`, which the parser would read as true.
  assert.deepEqual(argvFor(add, { package: "p", "dry-run": false }), ["add", "p"]);
});

test("LONG-RUNNING commands refuse instead of hanging the agent", async () => {
  assert.deepEqual([...LONG_RUNNING].sort(), ["dev", "edit"]);
  for (const command of LONG_RUNNING) {
    const result = await callTool(toolName(command));
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes(`despia ${command}`),
      "it names the terminal command to run instead");
    assert.ok(result.content[0]!.text.includes("never returns"));
  }
});

test("a tool call runs the REAL command and reports the exit code as isError", async () => {
  const ok = await callTool("despia_search", { query: "camera" });
  assert.equal(ok.isError, false);
  assert.ok(ok.content[0]!.text.includes("camera"), "the actual command output comes back");

  // A first-party coordinate is a defined refusal, and the agent must see it as an error.
  const bad = await callTool("despia_add", { package: "Core/Camera" });
  assert.equal(bad.isError, true, "a non-zero exit is an error to the agent, the way a shell reports it");
  assert.ok(bad.content[0]!.text.includes("first-party"));
});

test("an unknown tool lists what does exist rather than failing blankly", async () => {
  const result = await callTool("despia_nope");
  assert.equal(result.isError, true);
  assert.ok(result.content[0]!.text.includes("despia_build"));
});

test("the JSON-RPC surface: initialize, tools/list, tools/call", async () => {
  const init = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }) as
    { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: object } };
  assert.equal(init.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(init.result.serverInfo.name, "despia-toolchain");
  assert.ok("tools" in init.result.capabilities);

  const listed = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as
    { result: { tools: Array<{ name: string }> } };
  // every declared command projects, and installed Despia apps may add `app_*` tools
  // beside them (studio-apps.md §9) — the toolchain set stays exact, the app set additive
  assert.equal(listed.result.tools.filter((t) => t.name.startsWith("despia_")).length, CLI_DOCUMENT.commands.length);
  assert.ok(listed.result.tools.every((t) => t.name.startsWith("despia_") || t.name.startsWith("app_")));

  const called = await handleRpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "despia_search", arguments: { query: "camera" } },
  }) as { result: { isError: boolean } };
  assert.equal(called.result.isError, false);
});

test("a NOTIFICATION gets no reply, and an unknown method with an id gets an error", async () => {
  assert.equal(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null,
    "answering a notification is a protocol error some hosts treat as a fatal desync");
  const unknown = await handleRpc({ jsonrpc: "2.0", id: 9, method: "does/not/exist" }) as
    { error: { code: number } };
  assert.equal(unknown.error.code, -32601);
});
