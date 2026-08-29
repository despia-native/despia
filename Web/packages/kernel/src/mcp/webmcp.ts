//
//  webmcp.ts - the platform-neutral half of WebMCP (proposals/webmcp.md), both directions.
//
//  OUTBOUND (§3): a `<tool>` head row PROJECTED as a W3C WebMCP tool descriptor. The row
//  names a declared action and nothing else, so every field of the descriptor is derived
//  from something the author already wrote - there is no `schema` field on the row and
//  there never will be, for the same reason `facets.mcp` has none: the action's declared
//  inputs already ARE the shape, and restating them creates a second place to drift.
//
//  INBOUND (§4): the page tool table a shell keeps when a page registers through
//  `document.modelContext`. Policy-free by construction - it records, validates and
//  forgets. Approval, ordering and dispatch belong to the consumer, exactly as the bridge
//  relays and never decides.
//
//  Pure on purpose: no DOM, no `document`, no WebKit. The Kotlin and Swift twins run the
//  same corpus (Conformance/webmcp/{project,registry}.json), and the browser API spellings
//  live in one adapter per platform so a CG rename is a one-file follow rather than a
//  grammar change.
//
import { mcpToolResult, type CallToolResult } from "./result.ts";

/** The spec's tool-name grammar: 1..128 chars of ASCII alphanumeric plus `_`, `-`, `.`. */
export const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** The spec's annotations. Hints, and explicitly untrusted where a page supplied them. */
export type WebMcpAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

/** An `<tool>` head row, verbatim. `as` is optional and defaults to `action`. */
export type ToolRow = {
  as?: string;
  action: string;
  description: string;
  mutates?: string;
};

export type ToolInputSchema = {
  type: "object";
  properties: { [k: string]: unknown };
};

/** What `registerTool` receives, minus the `execute` callback the binding supplies. */
export type WebMcpDescriptor = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: WebMcpAnnotations;
};

export type ToolProjectionErrorCode =
  | "unknown_action"
  | "duplicate_tool"
  | "invalid_name"
  | "missing_description";

export type ToolProjectionError = {
  code: ToolProjectionErrorCode;
  name: string;
  message: string;
};

export type ToolProjection = {
  descriptors: WebMcpDescriptor[];
  errors: ToolProjectionError[];
};

/** The name a row projects under: `as` when given, the action name otherwise. */
export function toolName(row: ToolRow): string {
  const as = (row.as ?? "").trim();
  return as.length > 0 ? as : row.action;
}

/**
 * The declared inputs as a JSON Schema.
 *
 * A document action's inputs are UNTYPED by declaration (the JSE body coerces), so every
 * property is the empty schema: an invented `"type": "string"` would claim a validation
 * the runtime does not perform. Deliberately not a bare `{"type":"object"}` either, which
 * would say "any object at all" rather than "these arguments, types unknown".
 */
export function toolInputSchema(inputs: readonly string[]): ToolInputSchema {
  const properties: { [k: string]: unknown } = {};
  for (const name of inputs) properties[name] = {};
  return { type: "object", properties };
}

/**
 * Project a document's `<tool>` rows into WebMCP descriptors.
 *
 * `actionInputs` maps every action the document declares to its declared input names, in
 * declaration order. A row naming anything absent from that map is the stale-target class
 * and comes back as an error: the caller (the compiler) fails the build with it, so a typo
 * is a build message with the name in it rather than a tool that registers and then answers
 * "unknown" to every agent that tries it.
 */
export function projectTools(
  rows: readonly ToolRow[],
  actionInputs: ReadonlyMap<string, readonly string[]>,
): ToolProjection {
  const descriptors: WebMcpDescriptor[] = [];
  const errors: ToolProjectionError[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const name = toolName(row);
    if (!TOOL_NAME_RE.test(name)) {
      errors.push({
        code: "invalid_name",
        name,
        message: `tool name ${JSON.stringify(name)} must be 1 to 128 characters of ASCII letters, digits, "_", "-" or "."`,
      });
      continue;
    }
    if (seen.has(name)) {
      errors.push({
        code: "duplicate_tool",
        name,
        message: `tool ${JSON.stringify(name)} is declared twice - the second registration would be refused by the browser and the tool would silently not exist`,
      });
      continue;
    }
    const description = row.description.trim();
    if (description.length === 0) {
      errors.push({
        code: "missing_description",
        name,
        message: `tool ${JSON.stringify(name)} has an empty description - the description is the whole basis on which an agent chooses this tool`,
      });
      continue;
    }
    const inputs = actionInputs.get(row.action);
    if (inputs === undefined) {
      errors.push({
        code: "unknown_action",
        name: row.action,
        message: `tool ${JSON.stringify(name)} names action ${JSON.stringify(row.action)}, which this document does not declare`,
      });
      continue;
    }
    seen.add(name);
    const descriptor: WebMcpDescriptor = {
      name,
      description,
      inputSchema: toolInputSchema(inputs),
    };
    // The hint is DERIVED from the row. A row with `mutates` emits no annotations at all:
    // the spec's dictionary default for readOnlyHint is already false, and restating it
    // would be a second place for the same fact to live.
    if ((row.mutates ?? "").trim().length === 0) descriptor.annotations = { readOnlyHint: true };
    descriptors.push(descriptor);
  }

  return { descriptors, errors };
}

/**
 * The result of one tool call, MCP-shaped.
 *
 * Off the SAME shaping path the MCP faces use, so a WebMCP agent and an MCP client cannot
 * be told different things about one call.
 */
export function webMcpResult(value: unknown): CallToolResult {
  return mcpToolResult(value === undefined ? null : value);
}

/**
 * A thrown action is an error RESULT, never a rejected promise: a rejection tells the agent
 * the call never happened. The text carries the id an operator can grep and never the
 * exception, which may quote arguments the model supplied.
 */
export function webMcpErrorResult(correlationId: string): CallToolResult {
  return mcpToolResult(null, { isError: true, text: `tool failed (correlation ${correlationId})` });
}

// ── inbound: the page tool table ───────────────────────────────────────────────────────

export type PageToolRegistration = {
  name: string;
  description: string;
  inputSchema?: { [k: string]: unknown };
  annotations?: WebMcpAnnotations;
};

/**
 * One recorded page tool.
 *
 * `approval` is DERIVED and always `required` in v1: a page vouching for its own tool is not
 * evidence, so `annotations.readOnlyHint` is recorded (a consumer may weigh it) and never
 * lowers the gate. `origin` and `surface` are the provenance a consumer needs to tell the
 * app's own page from an embedded one.
 */
export type PageTool = {
  surface: string;
  origin: string;
  name: string;
  description: string;
  inputSchema: { [k: string]: unknown };
  annotations?: WebMcpAnnotations;
  approval: "required";
};

export type PageToolRejectionReason = "invalid_name" | "missing_description" | "duplicate_name";

export type PageToolRejection = {
  reason: PageToolRejectionReason;
  name: string;
};

/**
 * The page tool table.
 *
 * Every mutation that changes the VISIBLE SET emits exactly one change for its surface, so a
 * consumer re-reads once instead of diffing; a mutation that changes nothing (a refused
 * registration, a commit with an empty table, an abort of a row already gone) emits none,
 * because an event for an unchanged set is a lie a consumer acts on.
 */
export class PageToolTable {
  private readonly rows: PageTool[] = [];
  private readonly onChange: (surface: string) => void;

  constructor(onChange: (surface: string) => void = () => {}) {
    this.onChange = onChange;
  }

  /** Record one registration, or refuse it typed. Returns null when it was recorded. */
  register(surface: string, origin: string, tool: PageToolRegistration): PageToolRejection | null {
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!TOOL_NAME_RE.test(name)) return { reason: "invalid_name", name };
    const description = typeof tool.description === "string" ? tool.description.trim() : "";
    if (description.length === 0) return { reason: "missing_description", name };
    if (this.rows.some((r) => r.surface === surface && r.name === name)) {
      // The spec rejects the second registerTool. Last-write-wins would let a page swap a
      // tool's behaviour under an agent that had already read its description.
      return { reason: "duplicate_name", name };
    }
    const row: PageTool = {
      surface,
      origin,
      name,
      // The page wrote the schema, so the page's schema is the contract: `oneOf`, patterns,
      // formats and nesting ride through untouched. An ABSENT schema is normalized to the
      // empty-object shape, which is a default rather than a rewrite.
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      description: tool.description,
      approval: "required",
    };
    if (tool.annotations !== undefined) row.annotations = tool.annotations;
    this.rows.push(row);
    this.onChange(surface);
    return null;
  }

  /**
   * A navigation committed on this surface: every row the previous document registered is
   * gone. A same-origin reload drops them too, because it is a NEW document whose callback
   * registry the old rows named and no longer exists.
   */
  commit(surface: string, _origin: string): boolean {
    return this.dropWhere((r) => r.surface === surface, surface);
  }

  /** The spec's unregister path: the AbortSignal passed at registration fired. */
  abort(surface: string, name: string): boolean {
    return this.dropWhere((r) => r.surface === surface && r.name === name, surface);
  }

  /** Every recorded row, in registration order; one surface's when named. */
  tools(surface?: string): PageTool[] {
    return surface === undefined ? [...this.rows] : this.rows.filter((r) => r.surface === surface);
  }

  private dropWhere(match: (row: PageTool) => boolean, surface: string): boolean {
    let changed = false;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i];
      if (row !== undefined && match(row)) {
        this.rows.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.onChange(surface);
    return changed;
  }
}
