//
//  result.ts - the SERVER half of MCP Apps (proposals/mcp-apps.md §4/§5): the tool metadata
//  that links a row to its view, and the CallToolResult shaping that makes the text fallback
//  a property of the grammar instead of a discipline someone has to remember.
//
//  Pure and platform-neutral on purpose — the Kotlin and Swift routers serve the same rows,
//  so the shaping they must agree on lives in a file with no I/O in it.
//
//  Two laws, both corpus-pinned (Conformance/mcp-apps/server.json):
//    1. NESTED META ONLY. `_meta.ui.resourceUri`. The flat `_meta["ui/resourceUri"]` is
//       deprecated upstream and this file will not emit it.
//    2. A UI TOOL IS A TEXT TOOL THAT ALSO HAS A VIEW. Every result carries a meaningful
//       `content` array whether or not the host can render, because the spec requires the
//       tool to keep working text-only and Article 7 requires absence to degrade.
//

/** The `ui://` authority every DSX-emitted view resource lives under. */
export const UI_SCHEME = "ui://";

/** The one content type the MVP admits. */
export const UI_MIME = "text/html;profile=mcp-app";

/** The capability key a host sets when it can render views. */
export const UI_CAPABILITY = "io.modelcontextprotocol/ui";

export type UiVisibility = "model" | "app";

export type UiCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type UiMeta = {
  ui: {
    resourceUri: string;
    visibility?: UiVisibility[];
    csp?: UiCsp;
  };
};

export type ToolContent = { type: "text"; text: string };

export type CallToolResult = {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: UiMeta;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The canonical resource URI for one module action's view.
 * `ui://despia/<scheme>.<action>` — stable, so a host can prefetch and cache it.
 */
export function uiResourceUri(scheme: string, action: string): string {
  return `${UI_SCHEME}despia/${scheme}.${action}`;
}

/**
 * Does this host speak MCP Apps? Servers must ask BEFORE advertising a UI-enabled tool,
 * so an unaware host never sees metadata it would have to ignore.
 */
export function hostSupportsUi(clientCapabilities: unknown): boolean {
  if (!isRecord(clientCapabilities)) return false;
  const ext = clientCapabilities["extensions"];
  if (!isRecord(ext)) return false;
  const ui = ext[UI_CAPABILITY];
  if (!isRecord(ui)) return false;
  const mimes = ui["mimeTypes"];
  // A declared extension with no mimeTypes list means "the defaults", which include ours.
  if (!Array.isArray(mimes)) return true;
  return mimes.some((m) => typeof m === "string" && m.split(";")[0]?.trim() === "text/html");
}

/** The nested tool metadata. Never the deprecated flat spelling. */
export function uiToolMeta(
  resourceUri: string,
  options: { visibility?: UiVisibility[]; csp?: UiCsp } = {},
): UiMeta {
  const ui: UiMeta["ui"] = { resourceUri };
  if (options.visibility !== undefined) ui.visibility = options.visibility;
  // An omitted csp is the locked-down default and MUST stay omitted: writing an empty
  // object would read as "declared, allowing nothing extra" to some hosts and as a
  // relaxation request to others. Absence is the unambiguous spelling.
  if (options.csp !== undefined && Object.keys(options.csp).length > 0) ui.csp = options.csp;
  return { ui };
}

/**
 * Render a resolved action value as the text a host without views will show. Deliberately
 * plain and deterministic: this is a fallback, not a formatting engine, and a model reads
 * it as well as a person does.
 */
export function fallbackText(value: unknown): string {
  if (value === null || value === undefined) return "(no result)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(no items)";
    return value.map((v, i) => `${i + 1}. ${fallbackText(v)}`).join("\n");
  }
  if (isRecord(value)) {
    // Keys are SORTED, not insertion-ordered, because this text is pinned by a corpus that
    // runs on three renderers and a Swift dictionary has no order to preserve. Sorting is
    // the only ordering all three can produce identically, and a fallback rendering has no
    // semantic key order to lose (`structuredContent` carries the value itself).
    const entries = Object.entries(value).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (entries.length === 0) return "(empty)";
    return entries.map(([k, v]) => `${k}: ${scalarish(v)}`).join("\n");
  }
  return String(value);
}

/** One level of nesting is summarized rather than exploded — a fallback stays readable. */
function scalarish(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

/**
 * Build a CallToolResult from a resolved action value.
 *
 * The result ALWAYS carries text. `resourceUri` is attached only when the host declared UI
 * support, so the same server serves both host classes off one code path — which is the
 * only way the two representations cannot drift.
 */
export function mcpToolResult(
  value: unknown,
  options: {
    resourceUri?: string | null;
    uiSupported?: boolean;
    visibility?: UiVisibility[];
    csp?: UiCsp;
    text?: string;
    isError?: boolean;
  } = {},
): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: options.text ?? fallbackText(value) }],
    structuredContent: value,
  };
  if (options.isError === true) result.isError = true;
  if (options.uiSupported === true && typeof options.resourceUri === "string" && options.resourceUri !== "") {
    result._meta = uiToolMeta(options.resourceUri, { visibility: options.visibility, csp: options.csp });
  }
  return result;
}
