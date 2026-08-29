//
//  jstier.ts - the JS-TIER executor on web (/web/15 "Where each tier runs": JS-tier
//  bodies are ORDINARY JavaScript in the /web/12 sandbox). Before this file, a
//  beyond-subset action body LOSSY-COMPILED into a valid-but-wrong emission (the
//  pinned W9 finding) — now the runner classifies (tier.ts) and routes an escalated
//  body here, where it runs with REAL JS semantics and the three /web/15 law-3
//  guarantees:
//
//  • Store writes keep working, as OPERATIONS: a bare-identifier or `dsx.variable.*`
//    assignment records a write op; reads resolve through the live scope OVERLAID with
//    pending writes (read-after-write behaves normally); ops apply on the JSE side,
//    batched when the body settles. The engine never touches live state.
//  • The `dsx.*` call surface is identical: module calls ride the ONE funnel
//    (envelope-normalized, exclusion-safe), action calls re-enter the depth-guarded
//    runner, events fan out through the same emitters.
//  • The AMBIENT-ISOLATION FENCE holds for what it is: a `with` proxy claims every
//    FREE IDENTIFIER, so a body cannot name window/document/globalThis and a curated
//    stdlib allowlist passes through. Say plainly what it is NOT: a security sandbox.
//    The value plane is real JS — `Object.constructor("return globalThis")()` walks
//    out, exactly the escape class packages.ts refuses on the server — which is fine
//    HERE because this tier runs AUTHORED first-party bodies only (OTA escalation is
//    flagged off below; hostile code never routes here). And the /web/12 watchdog
//    RELEASES THE AWAITER on timeout — it cannot interrupt a synchronous loop, and an
//    async body keeps running after the caller is released. Correctness fence, not a
//    trust boundary; the trust boundary work is the OTA provenance consult below.
//
//  The scoping trick is the classic `with (proxy)` fence: `has` claims EVERY name, so
//  no lookup ever escapes to the real global scope; `get` serves the stdlib allowlist,
//  the `dsx` facade, or a store read; `set` records a store write op. Authored
//  `let`/`const` inside the body stay real JS locals (block scope beats `with`).
//

import type { Dict } from "../jse/values.ts";
import { RunnerJsTierSeam } from "../runner.ts";
import { classifyBody } from "./tier.ts";

/** Wire the runner's escalation seam (the installScreenPhase pattern — only a full
 *  surface pays for the classifier+executor; embeds never call this). Idempotent. */
export function installJsTier(): void {
  RunnerJsTierSeam.classify = (body) => classifyBody(body);
  RunnerJsTierSeam.run = runJsTier;
}

export type JsTierEnv = {
  /** live read (the runner's readPath — store + scope + globals) */
  read(path: string): unknown;
  /** batched write application (the runner's writePath — store-always routing) */
  write(path: string, value: unknown): void;
  /** re-enter the depth-guarded action runner (dsx.action.name / bare known names) */
  callAction(name: string, args: Dict): Promise<unknown>;
  /** the ONE module funnel — returns the settle envelope ({ok,data}|{ok:false,error}) */
  callModule(chain: string, args: Dict): Promise<unknown>;
  emitEvent(name: string, payload: Dict): void;
  log(args: unknown[]): void;
  /** the ambient error hat (records, never unwinds) */
  error(code: string, message: string): void;
  /** /web/12 watchdog (ms). Default 5000. */
  timeoutMs?: number;
};

/** The stdlib that passes through the fence — pure-computation globals only; nothing
 *  that reaches the document, the network, or timers (those go through dsx.*). */
const STDLIB = new Set([
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp",
  "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Promise", "Error", "TypeError",
  "RangeError", "SyntaxError", "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "structuredClone",
  "NaN", "Infinity", "undefined", "console",
]);

const JS_TIER_TIMEOUT_MS = 5000;

/** The OTA escalation policy (/web/15 law 3): "Markup delivered over the air executes
 *  JSE tier only by default. Escalation for OTA content is a flag (aligned with the W0
 *  recommendation that OTA-on-web ships behind a flag). Locally bundled first-party
 *  markup escalates freely." — the spec, verbatim. WIRED ON WEB TODAY: the flag exists
 *  with the safe default (off). NOT WIRED: the consult at the escalation seam — the
 *  runner threads no per-body markup provenance to `RunnerJsTierSeam.run` (the dev/OTA
 *  interpreter path does not mark a body's origin), so the seam stays unconditional
 *  and the consult lands with the source-plane integration. No fake provenance channel
 *  until then. */
export const JsTierPolicy = { otaEscalation: false };

/** Run one escalated body. Resolves when the body settles (writes applied); a thrown
 *  value re-throws AFTER the pre-throw writes apply (the interpreter writes as it
 *  goes — batching must not swallow completed work). */
export async function runJsTier(body: string, env: JsTierEnv): Promise<void> {
  const pending = new Map<string, unknown>();
  const overlayRead = (path: string): unknown =>
    pending.has(path) ? pending.get(path) : env.read(path);

  // dsx.module.<chain…> — a callable chain proxy; apply sends the folded remainder
  const moduleChain = (chain: string): unknown => new Proxy(function () {}, {
    get: (_t, key) => {
      if (typeof key !== "string") return undefined;
      if (key === "then") return undefined;   // not a thenable — awaiting a CALL is the shape
      return moduleChain(chain.length === 0 ? key : `${chain}.${key}`);
    },
    apply: (_t, _this, args: unknown[]) =>
      env.callModule(chain, (args[0] !== null && typeof args[0] === "object" ? args[0] : {}) as Dict),
  });

  // data-plane roots read/write the store through the overlay (value semantics, not proxies)
  const dataRoot = (root: string): unknown => new Proxy({}, {
    get: (_t, key) => (typeof key === "string" ? overlayRead(`dsx.${root}.${key}`) : undefined),
    set: (_t, key, value) => {
      if (typeof key === "string") pending.set(`dsx.${root}.${key}`, value);
      return true;
    },
    has: () => true,
  });

  const dsx = {
    variable: dataRoot("variable"),
    global: dataRoot("global"),
    cookie: dataRoot("cookie"),
    get this() { return overlayRead("dsx.this"); },
    get item() { return overlayRead("dsx.item"); },
    get index() { return overlayRead("dsx.index"); },
    get route() { return overlayRead("dsx.route"); },
    get query() { return overlayRead("dsx.query"); },
    get app() { return overlayRead("dsx.app"); },
    get screen() { return overlayRead("dsx.screen"); },
    action: new Proxy({}, {
      get: (_t, key) => (typeof key === "string"
        ? (args?: unknown) => env.callAction(key, (args ?? {}) as Dict)
        : undefined),
    }),
    module: moduleChain(""),
    event: (name: unknown, payload?: unknown) =>
      env.emitEvent(String(name), (payload ?? {}) as Dict),
    send: (name: unknown, payload?: unknown) =>
      env.emitEvent(String(name), (payload ?? {}) as Dict),
    broadcast: (name: unknown, payload?: unknown) =>
      env.emitEvent(String(name), (payload ?? {}) as Dict),
    log: (...args: unknown[]) => env.log(args),
    error: (code: unknown, message?: unknown) =>
      env.error(String(code), message === undefined ? "" : String(message)),
  };

  // the fence: every free identifier resolves HERE, never in the real global scope
  const fence = new Proxy({}, {
    has: () => true,
    get: (_t, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (typeof key !== "string") return undefined;
      if (key === "dsx") return dsx;
      if (STDLIB.has(key)) return (globalThis as Record<string, unknown>)[key];
      return overlayRead(key);
    },
    set: (_t, key, value) => {
      if (typeof key === "string") pending.set(key, value);
      return true;
    },
  });

  // sloppy-mode wrapper (new Function) so `with` is legal; the body runs async inside
  const fn = new Function("$fence", `with ($fence) { return (async () => {\n${body}\n})(); }`) as
    (fence: unknown) => Promise<unknown>;

  const timeoutMs = env.timeoutMs ?? JS_TIER_TIMEOUT_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchdog = new Promise<void>((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
  });

  try {
    await Promise.race([fn(fence), watchdog]);
    if (timedOut) {
      env.error("js_tier_timeout", `JS-tier body exceeded ${timeoutMs}ms — the watchdog released the surface (/web/12); writes recorded before the timeout applied`);
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
    // batched application — including the pre-throw/pre-timeout prefix
    for (const [path, value] of pending) env.write(path, value);
  }
}
