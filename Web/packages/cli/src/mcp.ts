//
//  mcp.ts — the TOOLCHAIN MCP server: every `despia` command, exposed to a coding agent that
//  cannot run a shell.
//
//  NOT to be confused with OpenSource/MCP, which is the RUNTIME MCP (an app being, or talking
//  to, an MCP server on a device). This is the build-time face: an agent asks to lint, add a
//  package, or export a project, and the same code path the terminal runs answers.
//
//  THE TOOL LIST IS GENERATED FROM `dsx.cli.dsx`, the same `<cli>` document `cli.ts` parses.
//  That is the whole design. Parity between the CLI and the MCP is not a promise somebody has
//  to keep as commands are added; it is a consequence of there being ONE command table with
//  three faces — the argv parser, `--help`, and this. A command cannot exist in the terminal
//  and be missing here, and a flag cannot mean one thing in each, because neither is written
//  twice.
//
//  WHAT IS DELIBERATELY REFUSED: `dev` and `edit` hold a server open and never return. An MCP
//  tool that never returns hangs the agent that called it, so they answer with the terminal
//  command to run instead. Refusing loudly beats appearing to work and then hanging.
//

import { CLI_DOCUMENT, runCli, type Io } from "./cli.ts";
import { listAppTools, runAppTool, type AppToolRow } from "./studio-apps/headless.ts";
import type { CliDocument, CommandDecl } from "./document.ts";

/** Commands that never return. An agent calling one would hang until its own timeout. */
export const LONG_RUNNING: ReadonlySet<string> = new Set(["dev", "edit"]);

export interface McpToolSchema {
  type: "object";
  properties: { [name: string]: { type: string; description: string } };
  required: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpToolSchema;
}

/** `build` → `despia_build`. Namespaced so it cannot collide with another server's tools. */
export function toolName(command: string): string {
  return `despia_${command.replace(/-/g, "_")}`;
}

export function commandName(tool: string): string | null {
  if (!tool.startsWith("despia_")) return null;
  return tool.substring("despia_".length).replace(/_/g, "-");
}

function schemaFor(command: CommandDecl): McpToolSchema {
  const properties: McpToolSchema["properties"] = {};
  const required: string[] = [];
  for (const flag of command.flags) {
    properties[flag.name] = {
      type: flag.type === "boolean" ? "boolean" : "string",
      description: flag.summary,
    };
  }
  for (const positional of command.positionals) {
    properties[positional.name] = {
      // A variadic positional takes a list; the dispatcher spreads it back onto argv.
      type: positional.variadic ? "array" : "string",
      description: positional.summary,
    };
    // Positionals are how a command names its subject (`export ios`, `add <package>`), so a
    // non-variadic one is required: omitting it produces a usage error the agent must then
    // parse out of stderr, which is a worse experience than a schema that says so up front.
    if (!positional.variadic) required.push(positional.name);
  }
  return { type: "object", properties, required };
}

/** Every declared command as an MCP tool. Derived, never hand-listed. */
export function toolsFromDocument(document: CliDocument = CLI_DOCUMENT): McpTool[] {
  return document.commands.map((command) => ({
    name: toolName(command.name),
    description: LONG_RUNNING.has(command.name)
      ? `${command.summary} (long-running: this tool explains how to start it rather than blocking)`
      : command.summary,
    inputSchema: schemaFor(command),
  }));
}

// ── the installed-app tool surface (studio-apps.md §9) ──────────────────────────────────
//
//  An interface is ONE consumer of an app. Every installed app's `tool` rows project here
//  as first-class MCP tools beside the toolchain's own — install an app and an agent's
//  toolbox grows, disable it and the tool says so instead of vanishing. The call lands in
//  the SAME headless runner `despia app run` uses: the same consented grants, the same
//  narrowed document, the same seam table the Studio mounts enforce.

/** `marketing` + `draftFilm` → `app_marketing_draftFilm`. The `app_` namespace keeps app
 *  tools apart from `despia_*` and from every other server's tools. */
export function appToolName(scheme: string, tool: string): string {
  return `app_${scheme.replace(/-/g, "_")}_${tool}`;
}

export function appToolsFromProject(projectRoot: string): McpTool[] {
  let rows: AppToolRow[];
  try {
    rows = listAppTools(projectRoot);
  } catch {
    return []; // outside a project the app plane has nothing to project
  }
  return rows.map((row) => ({
    name: appToolName(row.app, row.name),
    description: row.hold !== null
      ? `${row.description} (currently held: ${row.hold})`
      : `${row.description} — a tool of the installed "${row.app}" Despia app, run under its consented grants`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(row.inputs.map((name) => [name, {
        type: "string",
        description: `the action's declared \`${name}\` input (JSON values pass through)`,
      }])),
      required: [],
    },
  }));
}

async function callAppTool(tool: string, args: { [k: string]: unknown }, projectRoot: string): Promise<ToolResult> {
  const rows = listAppTools(projectRoot);
  const row = rows.find((r) => appToolName(r.app, r.name) === tool);
  if (row === undefined) {
    return text(`unknown app tool ${JSON.stringify(tool)}. Installed: ${rows.map((r) => appToolName(r.app, r.name)).join(", ") || "none"}`, true);
  }
  const lines: string[] = [];
  const result = await runAppTool(projectRoot, row.app, row.name, args, { out: (l) => lines.push(l) });
  if (!result.ok) return text([...lines, `${result.reason}: ${result.message}`].join("\n"), true);
  return text([...lines, JSON.stringify(result.value, null, 2)].join("\n").trim());
}

/** Rebuild an argv from tool arguments, in the order the parser expects. */
export function argvFor(command: CommandDecl, args: { [k: string]: unknown }): string[] {
  const argv: string[] = [command.name];
  for (const positional of command.positionals) {
    const value = args[positional.name];
    if (value === undefined) continue;
    if (Array.isArray(value)) argv.push(...value.map(String));
    else argv.push(String(value));
  }
  for (const flag of command.flags) {
    const value = args[flag.name];
    if (value === undefined || value === null) continue;
    if (flag.type === "boolean") {
      if (value === true) argv.push(`--${flag.name}`);
      continue;
    }
    // `--flag=value`, never `--flag value`: an agent-supplied value can begin with a dash, and
    // the two-token form would have the parser read it as the next flag.
    argv.push(`--${flag.name}=${String(value)}`);
  }
  return argv;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], isError };
}

/**
 * Run one tool call through the SAME `runCli` the terminal uses. Output is captured rather than
 * printed, and the exit code decides `isError`, so an agent learns about a failure the way a
 * shell does instead of having to read prose.
 */
export async function callTool(
  tool: string, args: { [k: string]: unknown } = {}, document: CliDocument = CLI_DOCUMENT,
): Promise<ToolResult> {
  const name = commandName(tool);
  const command = name === null ? undefined : document.commands.find((c) => c.name === name);
  if (command === undefined) {
    return text(`unknown tool ${JSON.stringify(tool)}. Available: ` +
      toolsFromDocument(document).map((t) => t.name).join(", "), true);
  }
  if (LONG_RUNNING.has(command.name)) {
    return text(
      `\`despia ${command.name}\` holds a server open and never returns, so it cannot be a tool ` +
      `call: it would hang until your timeout. Run it in a terminal instead:\n\n` +
      `    despia ${command.name}\n\n` +
      `Everything else in the toolchain is available here.`, true);
  }

  const lines: string[] = [];
  const io: Io = { out: (l) => lines.push(l), err: (l) => lines.push(l) };
  let code: number;
  try {
    code = await runCli(argvFor(command, args), io);
  } catch (e) {
    return text(`despia ${command.name} threw: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  const body = lines.join("\n").trim();
  return text(body === "" ? `despia ${command.name}: exit ${code}` : body, code !== 0);
}

// ── the stdio JSON-RPC loop ─────────────────────────────────────────────────────────────
//
//  Streamed line-delimited JSON on stdin/stdout, which is what an agent host launches. Kept
//  dependency-free on purpose: the toolchain must be installable with no transitive surface,
//  and the three methods an agent needs are small enough that a client library would be more
//  code than it saves.

interface RpcRequest { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: { [k: string]: unknown } }

export const PROTOCOL_VERSION = "2025-06-18";

export async function handleRpc(
  request: RpcRequest, document: CliDocument = CLI_DOCUMENT, projectRoot: string = process.cwd(),
): Promise<object | null> {
  const reply = (result: object): object => ({ jsonrpc: "2.0", id: request.id ?? null, result });
  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "despia-toolchain", version: document.version },
      });
    case "tools/list":
      return reply({ tools: [...toolsFromDocument(document), ...appToolsFromProject(projectRoot)] });
    case "tools/call": {
      const params = (request.params ?? {}) as { name?: string; arguments?: { [k: string]: unknown } };
      const name = String(params.name ?? "");
      const result = name.startsWith("app_")
        ? await callAppTool(name, params.arguments ?? {}, projectRoot)
        : await callTool(name, params.arguments ?? {}, document);
      return reply(result);
    }
    default:
      // A notification (no id) gets no reply, per JSON-RPC. Answering one is a protocol error
      // that some hosts treat as a fatal desync.
      if (request.id === undefined || request.id === null) return null;
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } };
  }
}

/** Serve on stdio until stdin closes. Returns the exit code. */
export async function serveMcp(): Promise<number> {
  const { createInterface } = await import("node:readline");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let request: RpcRequest;
    try {
      request = JSON.parse(trimmed) as RpcRequest;
    } catch {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" },
      }) + "\n");
      continue;
    }
    const response = await handleRpc(request);
    if (response !== null) process.stdout.write(JSON.stringify(response) + "\n");
  }
  return 0;
}
