//
//  mcp-face.ts — the MCP STREAMABLE-HTTP face of the server node (v0-live-plan W3).
//
//  MCP was client-for-the-world + loopback-server-for-the-device. This is the missing third
//  face: DECLARED actions served as MCP tools from the server node, over the protocol's
//  streamable HTTP transport — one handler at /mcp speaking initialize · tools/list ·
//  tools/call, dispatching into the SAME action handlers the route table dispatches into,
//  under the same identity boundary. A `<tool>` row on a `<server>` document is to MCP what
//  a `<route>` row is to HTTP: a second face over one action, never a second implementation.
//
//  WHAT THIS FILE DELIBERATELY REUSES. The CallToolResult shaping is the kernel's
//  (@despia-native/kernel/mcp — corpus-pinned by Conformance/mcp-apps/server.json), so a tool served
//  from a Worker and a tool served from the device loopback produce byte-identical envelopes:
//  one grammar, two protocols, three hosts. The failure discipline is host.ts's: a handler
//  exception NEVER reaches the wire (stack frames, SQL, secrets) — the caller gets a typed
//  isError result carrying a correlation id, and the detail goes to the server-side sink.
//
//  STATELESS BY CONSTRUCTION (the spec permits it): no session id is minted at initialize
//  and none is demanded later, because every workerd isolate would otherwise need shared
//  session storage before the first tool could answer. GET (the server-push channel) answers
//  405 — a server with no session has nothing to push.
//
//  JSON-RPC error vocabulary, used the way the spec means it: a PROTOCOL failure (parse,
//  bad request, unknown method, unknown tool) is a JSON-RPC error; a TOOL failure (the
//  handler threw) is a RESULT with isError, because the model — not the transport — is the
//  audience that can act on it.
//

import { mcpToolResult } from "@despia-native/kernel/mcp";

import { chargeSpend, spendHeaders } from "./spend.ts";
import type { HostConfig, HostContext } from "./host.ts";
import type { Identity } from "./identity.ts";
import { readTraceContext } from "./trace.ts";

/** One served tool row (generated/mcp-tools.json — a `<tool>` in a `<server>` document). */
export interface McpToolRow {
  /** the tool name a client sees (the row's `as`, default the action name) */
  name: string;
  /** the owning module's derived chain — picks the handlers bucket */
  chain: string;
  /** the declared action the tool dispatches */
  action: string;
  description: string;
  /** "required" gates the tool on a resolved identity, same word as a route row */
  auth?: string;
  /** truthy = the tool writes; surfaced to hosts as a destructive-hint annotation */
  mutates?: string;
  /** declared input names (the action's `inputs`), each accepted as any JSON value */
  inputs?: string[];
}

export interface McpFaceOptions {
  tools: McpToolRow[];
  /** chain → action → implementation — the SAME barrel the route host dispatches from */
  handlers: HostConfig["handlers"];
  buildInfo?: Record<string, unknown>;
  serverName?: string;
  serverVersion?: string;
  /** server-side failure sink, host.ts's default: the client never sees the exception text */
  onError?: (info: { correlationId: string; tool: string; error: unknown }) => void;
}

/** The one protocol revision this face speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The path the face owns, after the bootloader's mount strip. */
export const MCP_PATH = "/mcp";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function rpcResult(id: unknown, result: unknown): Response {
  return json(200, { jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return json(200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function correlationId(): string {
  return (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.()
    ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** The declared inputs as a JSON Schema. Inputs are UNTYPED by declaration (the action's JSE
 *  coerces), so each property admits any JSON value — an honest schema, never an invented one. */
function inputSchema(row: McpToolRow): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of row.inputs ?? []) properties[name] = {};
  return { type: "object", properties };
}

/**
 * Build the /mcp face. Returns null for any request outside its path so the caller chains it
 * with the site face and the API host (which stays last — it can never signal "not mine").
 */
export function createMcpFace(
  options: McpFaceOptions,
): (req: Request, ctx: { identity: Identity | Record<string, unknown> | null; env: (key: string) => string | undefined }) => Promise<Response | null> {
  const byName = new Map<string, McpToolRow>();
  for (const row of options.tools) {
    // Two rows, one name: the second would be unreachable forever. Same loudness as the
    // route table's duplicate-key abort, at the same moment (creation, not the Nth call).
    if (byName.has(row.name)) throw new Error(`[dsx.mcp] duplicate tool name ${JSON.stringify(row.name)}`);
    byName.set(row.name, row);
  }
  const onError = options.onError ?? ((info): void => {
    // eslint-disable-next-line no-console -- the default server-side failure sink, as in host.ts
    console.error(`[dsx.mcp] tool ${info.tool} failed (${info.correlationId}):`, info.error);
  });
  const serverInfo = {
    name: options.serverName ?? "despia-server",
    version: options.serverVersion ?? String((options.buildInfo ?? {})["digest"] ?? "0"),
  };

  return async function handle(req, ctx): Promise<Response | null> {
    const { pathname } = new URL(req.url);
    if (pathname !== MCP_PATH) return null;
    if (req.method.toUpperCase() !== "POST") {
      // GET is the streamable-HTTP server-push channel; a stateless server has nothing to
      // push and says so with the spec's spelling, not a hang.
      return json(405, { reason: "method_not_allowed", message: "the /mcp face accepts POST" }, { allow: "POST" });
    }
    // THE SPEND CEILING applies to this face exactly as to a route (cost-guardrails.md): a tool
    // call dispatches the same declared handlers with the same platform cost, and an agent in a
    // loop is this plane's founding scenario — an /mcp door the ceiling cannot see would be the
    // runaway's front entrance. Refused at the transport with the HTTP status, like the face's
    // own 401: an HTTP-level refusal is spec-legal on streamable HTTP and is one a model client
    // cannot route around in-band. Charged before the body is read, same order as the host.
    const spendVerdict = chargeSpend("requests");
    if (!spendVerdict.allowed) {
      return json(
        429,
        { reason: "spend_capped", message: `the deployment's "${spendVerdict.budget}" budget is spent for this window` },
        spendHeaders(spendVerdict),
      );
    }
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return rpcError(null, -32700, "request body is not JSON");
    }
    if (Array.isArray(parsed)) {
      // JSON-RPC batching was REMOVED in protocol 2025-06-18; refusing is compliance.
      return rpcError(null, -32600, "batching is not part of MCP 2025-06-18");
    }
    if (typeof parsed !== "object" || parsed === null) {
      return rpcError(null, -32600, "expected a JSON-RPC request object");
    }
    const rpc = parsed as JsonRpcRequest;
    const method = typeof rpc.method === "string" ? rpc.method : "";
    if (method === "") return rpcError(rpc.id, -32600, "request has no method");

    // A NOTIFICATION gets its 202 and no body — including notifications/initialized, which a
    // client sends before its first real call.
    if (rpc.id === undefined && method.startsWith("notifications/")) {
      return new Response(null, { status: 202 });
    }

    switch (method) {
      case "initialize":
        return rpcResult(rpc.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });
      case "ping":
        return rpcResult(rpc.id, {});
      case "tools/list":
        return rpcResult(rpc.id, {
          tools: [...byName.values()].map((row) => ({
            name: row.name,
            description: row.description,
            inputSchema: inputSchema(row),
            ...(row.mutates !== undefined && row.mutates !== "" ? { annotations: { destructiveHint: true } } : {}),
          })),
        });
      case "tools/call": {
        const params = (typeof rpc.params === "object" && rpc.params !== null ? rpc.params : {}) as Record<string, unknown>;
        const name = typeof params["name"] === "string" ? params["name"] : "";
        const row = byName.get(name);
        if (row === undefined) return rpcError(rpc.id, -32602, `unknown tool ${JSON.stringify(name)}`);
        if (row.auth === "required" && ctx.identity === null) {
          // The same boundary a route row's auth draws, at the transport layer where the
          // spec puts authorization — never an isError a model might route around.
          return json(401, { reason: "unauthenticated", message: `tool ${JSON.stringify(name)} requires a signed-in caller` });
        }
        const handler = options.handlers[row.chain]?.[row.action];
        if (handler === undefined) return rpcError(rpc.id, -32602, `tool ${JSON.stringify(name)} names unregistered action ${row.chain}.${row.action}`);
        const args = (typeof params["arguments"] === "object" && params["arguments"] !== null && !Array.isArray(params["arguments"])
          ? params["arguments"]
          : {}) as Record<string, unknown>;
        const cid = correlationId();
        const hostCtx: HostContext = {
          buildInfo: options.buildInfo ?? {},
          identity: ctx.identity,
          env: ctx.env,
          query: {},
          body: args,
          params: {},
          correlationId: cid,
          trace: readTraceContext(req.headers),
          request: req,
        };
        try {
          const value = await handler(args, hostCtx);
          return rpcResult(rpc.id, mcpToolResult(value === undefined ? null : value));
        } catch (error) {
          onError({ correlationId: cid, tool: name, error });
          // The tool FAILED; the protocol did not — so this is a result, and the text the
          // model reads carries the id an operator can grep, never the exception.
          return rpcResult(rpc.id, mcpToolResult(null, { isError: true, text: `internal error (correlation ${cid})` }));
        }
      }
      default:
        return rpcError(rpc.id, -32601, `unknown method ${JSON.stringify(method)}`);
    }
  };
}
