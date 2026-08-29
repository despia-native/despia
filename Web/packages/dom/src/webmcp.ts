//
//  webmcp.ts - the browser adapter for WebMCP (proposals/webmcp.md §3).
//
//  The ONE file that knows the spec's spellings. Everything it decides - which rows
//  project, under what name, with what schema, shaped into what result - is the pure fold
//  in @despia/kernel/mcp, corpus-pinned on three renderers. That split is deliberate: the
//  CG draft has already moved its entry point once (navigator.modelContext ->
//  document.modelContext) and its declarative half is still TBD, so a rename upstream is a
//  diff in this file rather than a change to a grammar apps are written against.
//
//  ABSENCE IS THE COMMON CASE and it costs one typeof (Article 7). Today no shipping
//  browser outside the Chrome 149 / Edge 150 origin trials and ChatGPT Desktop has the API;
//  a page in any other browser registers nothing and behaves exactly as it did before.
//
import { projectTools, webMcpResult, webMcpErrorResult, type ToolRow } from "@despia/kernel/mcp";

/** The slice of the spec's ModelContext this adapter touches. */
type ModelContextLike = {
  registerTool: (
    tool: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
};

/** One tool call, dispatched by the caller as an ENTRY call into the declared action. */
export type ToolDispatch = (action: string, args: Record<string, unknown>) => Promise<unknown>;

export type WebMcpBindingOptions = {
  /** Every action the document declares, mapped to its declared input names in order. */
  actionInputs: ReadonlyMap<string, readonly string[]>;
  /** Runs one action as an entry call and resolves its value, or throws. */
  dispatch: ToolDispatch;
  /** Correlation ids for failed calls; injectable so the corpus and tests stay determinate. */
  correlationId?: () => string;
};

function modelContext(): ModelContextLike | null {
  const doc = globalThis.document as unknown as { modelContext?: ModelContextLike } | undefined;
  const mc = doc?.modelContext;
  return mc !== undefined && typeof mc.registerTool === "function" ? mc : null;
}

function defaultCorrelationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `t${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Register a document's `<tool>` rows with the user agent, and return the disposer that
 * unregisters them.
 *
 * Registration follows the MOUNT: the rows exist while their document is on screen and the
 * abort at unmount takes them away, so the tool set an agent sees is always the set the
 * current screen can actually honour, and the spec's `toolchange` fires for free. No
 * availability logic is written anywhere - head declarations already have this lifetime.
 *
 * The disposer is safe to call when nothing registered (no API, no rows), which is the
 * common case and the reason the caller never has to test for it.
 */
export function bindWebMcpTools(
  rows: readonly ToolRow[],
  options: WebMcpBindingOptions,
): () => void {
  if (rows.length === 0) return () => {};
  const mc = modelContext();
  if (mc === null) return () => {};

  const { descriptors, errors } = projectTools(rows, options.actionInputs);
  // The compiler already failed the build on any of these, so reaching here means a
  // hand-built IR. Registering the good rows and dropping the bad ones is the fail-open
  // reading: a malformed row costs its own tool, never the screen.
  if (errors.length > 0 && descriptors.length === 0) return () => {};

  const correlationId = options.correlationId ?? defaultCorrelationId;
  const controller = new AbortController();
  // A row's action is looked up by NAME at call time rather than captured, because `as`
  // may rename the tool and the descriptor no longer carries the action it came from.
  const actionOf = new Map<string, string>();
  for (const row of rows) {
    const name = (row.as ?? "").trim();
    actionOf.set(name.length > 0 ? name : row.action, row.action);
  }

  for (const descriptor of descriptors) {
    const action = actionOf.get(descriptor.name);
    if (action === undefined) continue;
    // The projection pre-validates everything the spec lets a UA reject today, but the API
    // is young and a UA-side refusal (a competing registrar's duplicate, a future quota)
    // must cost that one tool quietly - never an unhandled rejection in the page console.
    Promise.resolve(mc.registerTool(
      {
        ...descriptor,
        execute: async (input: unknown): Promise<unknown> => {
          const args = (typeof input === "object" && input !== null && !Array.isArray(input)
            ? input
            : {}) as Record<string, unknown>;
          try {
            return webMcpResult(await options.dispatch(action, args));
          } catch {
            // The TOOL failed; the protocol did not. A rejected promise would tell the
            // agent the call never happened, and the thrown value may quote arguments the
            // model supplied, so the text carries an id an operator can grep instead.
            return webMcpErrorResult(correlationId());
          }
        },
      },
      { signal: controller.signal },
    )).catch(() => {});
  }

  return () => controller.abort();
}
