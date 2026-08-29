//
//  apps.ts - the MCP Apps VIEW protocol (architecture/proposals/mcp-apps.md), the half that
//  runs inside the host's sandboxed iframe. PURE: no DOM, no postMessage, no timers — the
//  transport is injected, which is what makes the corpus (Conformance/mcp-apps/apps.json)
//  runnable headless on every runtime that ever needs it. The DOM binding (window
//  postMessage, CSS custom properties, ResizeObserver) lives in @despia-native/dom, exactly the way
//  direct DOM access lives only there.
//
//  Implements the FINAL extension `modelcontextprotocol/ext-apps`, specification 2026-01-26:
//  the `ui/initialize` handshake, `ui/notifications/initialized`, the tool-input/tool-result
//  notifications, host-proxied `tools/call`, and `ui/notifications/size-changed`.
//
//  The laws this file exists to hold, all corpus-pinned:
//    1. The initialize REQUEST is the first frame out, and `initialized` follows the result.
//       A call issued before that is queued, never dropped and never reordered ahead.
//    2. Tool data arriving before ready is BUFFERED and replayed in order (Article 7: a host
//       that is out of spec degrades us, it does not brick us).
//    3. `tool-input-partial` is advisory and never settles the input channel — the spec says
//       a view must not rely on it.
//    4. First settle wins, per request id; an unmatched or duplicate response is a no-op.
//    5. Errors are VALUES (error-system.md): a failed call resolves `{ok:false, code, message}`
//       and nothing throws into the view.
//

/** A JSON-RPC frame in either direction. Loose by design: hosts are not our code. */
export type AppFrame = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type AppToolResult =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string };

export type AppToolInput = { toolName: string | null; arguments: Record<string, unknown> };

export type AppHostContext = {
  styles?: { variables?: Record<string, string>; css?: Record<string, unknown> };
  containerDimensions?: { width?: number; height?: number };
  [key: string]: unknown;
};

export type AppBridgeOptions = {
  /** Send one frame to the host. The DOM binding hands us `postMessage`. */
  send: (frame: AppFrame) => void;
  /** Display modes this view supports. The spec's `appCapabilities`. */
  displayModes?: string[];
  /** Called when the tool result settles (or re-settles on a later result). */
  onData?: (result: unknown) => void;
  /** Called when the tool input settles. */
  onInput?: (input: AppToolInput) => void;
  /** Called with the advisory partial channel. Never authoritative. */
  onPartial?: (partial: unknown) => void;
  /** Called once the handshake completes, with the host's context. */
  onReady?: (context: AppHostContext) => void;
};

const JSONRPC = "2.0";
const METHOD_NOT_FOUND = -32601;
const TRANSPORT_FAILED = -32000;

/** The notifications a host may push at a view. Anything else is ignored silently. */
const HOST_NOTIFICATIONS = new Set([
  "ui/notifications/tool-input",
  "ui/notifications/tool-input-partial",
  "ui/notifications/tool-result",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read a tool-input notification tolerantly. The envelope carries `arguments`, but a host
 * that passes the bare argument dict is read the same way rather than dropped: the
 * fail-open reading costs nothing and a lost input is a blank view.
 */
function readInput(params: unknown): AppToolInput {
  if (!isRecord(params)) return { toolName: null, arguments: {} };
  const args = isRecord(params["arguments"]) ? (params["arguments"] as Record<string, unknown>) : null;
  const name = typeof params["toolName"] === "string" ? (params["toolName"] as string) : null;
  if (args !== null) return { toolName: name, arguments: args };
  // No `arguments` key: the params dict IS the argument dict, minus any envelope key.
  const bare: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (k !== "toolName") bare[k] = v;
  return { toolName: name, arguments: bare };
}

export type AppBridge = {
  /** Invoke a tool through the host proxy. Resolves a value, never rejects. */
  callTool: (name: string, args?: Record<string, unknown>) => Promise<AppToolResult>;
  /** Feed one host→view frame in. */
  receive: (frame: AppFrame) => void;
  /** Report an observed content size. No-op unless the container is flexible. */
  reportSize: (width: number, height: number) => void;
  /** The handshake completed. */
  isReady: () => boolean;
  /** The handshake was answered with an error. The view still renders. */
  handshakeFailed: () => boolean;
  /** The host's theme table, verbatim. Empty when the host sent none. */
  tokens: () => Record<string, string>;
  /** The host context from the handshake result, or null before it lands. */
  hostContext: () => AppHostContext | null;
  /** The host's own identification, or null. */
  hostInfo: () => Record<string, unknown> | null;
  /** The settled tool result, or null. */
  data: () => unknown;
  /** The settled tool input, or null. */
  input: () => AppToolInput | null;
  /** The advisory partial channel, or null. */
  partial: () => unknown;
  /** How many pre-ready frames were buffered. Diagnostics; the corpus asserts it. */
  bufferedCount: () => number;
};

/**
 * Create the view-side bridge and immediately emit the initialize request — the spec's
 * ordering is not a suggestion, so there is no "start()" to forget to call.
 */
export function createAppBridge(options: AppBridgeOptions): AppBridge {
  const { send } = options;

  let seq = 0;
  const nextId = (): string => `dsx-${++seq}`;

  const pending = new Map<string, (frame: AppFrame) => void>();
  const queued: AppFrame[] = [];
  const buffered: AppFrame[] = [];

  let ready = false;
  let failed = false;
  let context: AppHostContext | null = null;
  let info: Record<string, unknown> | null = null;
  let themeTokens: Record<string, string> = {};
  let settledData: unknown = null;
  let settledInput: AppToolInput | null = null;
  let partialInput: unknown = null;
  let lastSize: string | null = null;
  // Counted rather than derived from `buffered`, so the diagnostic survives the flush.
  let bufferedSeen = 0;

  const flushQueued = (): void => {
    while (queued.length > 0) send(queued.shift() as AppFrame);
  };

  const applyNotification = (frame: AppFrame): void => {
    switch (frame.method) {
      case "ui/notifications/tool-input": {
        settledInput = readInput(frame.params);
        partialInput = null; // a settled input closes the advisory channel
        options.onInput?.(settledInput);
        return;
      }
      case "ui/notifications/tool-input-partial": {
        if (settledInput !== null) return; // law 3: never overwrite the real thing
        partialInput = frame.params ?? null;
        options.onPartial?.(partialInput);
        return;
      }
      case "ui/notifications/tool-result": {
        settledData = frame.params ?? null;
        options.onData?.(settledData);
        return;
      }
      default:
        return;
    }
  };

  const completeHandshake = (frame: AppFrame): void => {
    if (frame.error !== undefined) {
      // The host does not speak the extension. We are still a working HTML view, and any
      // data it pushes anyway still renders — Article 7, one layer up.
      failed = true;
    } else {
      const result = isRecord(frame.result) ? frame.result : {};
      context = isRecord(result["hostContext"]) ? (result["hostContext"] as AppHostContext) : {};
      info = isRecord(result["hostInfo"]) ? (result["hostInfo"] as Record<string, unknown>) : null;
      const styles = isRecord(context["styles"]) ? (context["styles"] as Record<string, unknown>) : null;
      const vars = styles !== null && isRecord(styles["variables"]) ? styles["variables"] : null;
      themeTokens = {};
      if (vars !== null) {
        for (const [k, v] of Object.entries(vars)) if (typeof v === "string") themeTokens[k] = v;
      }
      ready = true;
      send({ jsonrpc: JSONRPC, method: "ui/notifications/initialized" });
      options.onReady?.(context);
    }
    flushQueued();
    while (buffered.length > 0) applyNotification(buffered.shift() as AppFrame);
  };

  const handshakeId = nextId();
  pending.set(handshakeId, completeHandshake);
  send({
    jsonrpc: JSONRPC,
    id: handshakeId,
    method: "ui/initialize",
    params: { appCapabilities: { displayModes: options.displayModes ?? ["inline"] } },
  });

  const receive = (frame: AppFrame): void => {
    if (!isRecord(frame)) return;

    // A response settles exactly one outstanding request, exactly once.
    if (frame.id !== undefined && frame.method === undefined) {
      const key = String(frame.id);
      const settle = pending.get(key);
      if (settle === undefined) return; // law 4: unmatched or already settled
      pending.delete(key);
      settle(frame);
      return;
    }

    if (typeof frame.method !== "string") return;

    // A host REQUEST we do not implement gets an honest JSON-RPC error, never silence
    // and never a crash. Notifications (no id) are ignored instead — that is the
    // JSON-RPC rule, not a choice.
    if (!HOST_NOTIFICATIONS.has(frame.method)) {
      if (frame.id !== undefined) {
        send({
          jsonrpc: JSONRPC,
          id: frame.id,
          error: { code: METHOD_NOT_FOUND, message: `method not found: ${frame.method}` },
        });
      }
      return;
    }

    if (!ready && !failed) {
      buffered.push(frame); // law 2
      bufferedSeen += 1;
      return;
    }
    applyNotification(frame);
  };

  const callTool = (name: string, args: Record<string, unknown> = {}): Promise<AppToolResult> =>
    new Promise<AppToolResult>((resolve) => {
      const id = nextId();
      pending.set(id, (frame) => {
        if (frame.error !== undefined) {
          resolve({
            ok: false,
            code: typeof frame.error.code === "number" ? frame.error.code : TRANSPORT_FAILED,
            message: typeof frame.error.message === "string" ? frame.error.message : "tool call failed",
          });
          return;
        }
        resolve({ ok: true, result: frame.result ?? null });
      });
      const frame: AppFrame = { jsonrpc: JSONRPC, id, method: "tools/call", params: { name, arguments: args } };
      if (ready || failed) send(frame);
      else queued.push(frame); // law 1: behind the handshake, never ahead of it
    });

  const reportSize = (width: number, height: number): void => {
    const dims = context?.containerDimensions;
    // Fixed dimensions mean the host owns the box; reporting into it is noise.
    if (dims === undefined) return;
    if (typeof dims.width === "number" || typeof dims.height === "number") return;
    const key = `${width}x${height}`;
    if (key === lastSize) return; // law 6: coalesce repeats
    lastSize = key;
    send({ jsonrpc: JSONRPC, method: "ui/notifications/size-changed", params: { width, height } });
  };

  return {
    callTool,
    receive,
    reportSize,
    isReady: () => ready,
    handshakeFailed: () => failed,
    tokens: () => ({ ...themeTokens }),
    hostContext: () => context,
    hostInfo: () => info,
    data: () => settledData,
    input: () => settledInput,
    partial: () => partialInput,
    bufferedCount: () => bufferedSeen,
  };
}
