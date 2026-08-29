//
//  runner.ts - the action runner: executes `on:*` handler strings and `<action>` bodies.
//  TS twin of JseRunner.kt in CONTRACT (statement grammar, verbs, write routing, event
//  emission, budgets); structurally the web runner is async/await all the way down —
//  "on web, await is a real await; same observable ordering" (/web/07).
//
//  Statement grammar (the reference set):
//    • effect verbs: `fetch: dest = METHOD url …` · `remove: arr …` · `animate: k = e`
//    • assignment `path = expr` (dotted LHS; jsSugar rewrites `i++` / `x += e`)
//    • dsx.module.<scheme>.<m>({…}) · dsx.action.name() · dsx.component.push/present/dismiss
//    • dsx.event(name,{…}) · dsx.send(name,{…}) · dsx.broadcast(name,{…})
//    • setTimeout/setInterval(fn, ms[, key]) (interval min 250ms, keyed) · clearTimeout/Interval(key)
//    • array mutations: path.push/pop/shift/unshift/splice/sort(…)
//    • blocks: const/let/var · if/else · while · for / for…of · switch · try/catch/finally ·
//      break/continue/return/throw — loop budget 100 000 per entry event
//    • await on: fetch(…) · dsx.module.* · dsx.event(…) · Promise.* · any Promise value
//
//  Not carried to web v1 (logged, never a crash): `new WebSocket` statement sockets
//  (the WebSocket module owns sockets on web), `resolve:`/`error:` module-surface verbs.
//

import { JSE, JSESeams, StackStore, Parser, spreadValues, forInKeys, parseDeclarators, bindPattern, type Item } from "./jse/jse.ts";
import { cachedTokens, tokenize, type Token } from "./jse/tokens.ts";
import { NSNull, isDict, isLambda, number, string, truthy, safeInt, type Dict, type StackLambda } from "./jse/values.ts";
import { ReactiveStore, DSXState, rebuildStatePath, statePathParts } from "./store.ts";
import { ModuleRegistry, DSXEvents, ModuleCallError } from "./bus.ts";
import { reportLog } from "./logs.ts";
import type { JsTierEnv } from "./compile/jstier.ts";

/** The /web/15 escalation seam. Wired by `installJsTier()` (compile/jstier.ts) rather
 *  than imported here: the runner ships in EVERY bundle (self-contained embeds included)
 *  and the classifier+executor would otherwise ride along — the byte-scarcity lesson the
 *  screen seam above already encodes. Only a full surface (the dom boot/adopt hosts)
 *  installs it; an embed keeps the pre-W9 interpreter path for every body. */
export const RunnerJsTierSeam = {
  classify: null as ((body: string) => { tier: "jse" | "js"; reason: string | null }) | null,
  run: null as ((body: string, env: JsTierEnv) => Promise<void>) | null,
};
/**
 * The screen-readiness face of the runner — a SEAM, not an import, exactly like
 * `RunnerFetchSeam` below. `runner.ts` ships in EVERY bundle, including a self-contained
 * embed; a static `import { ScreenReadiness } from "./screen.ts"` therefore dragged the whole
 * per-frame readiness machine into every embed, which has no router and no frame lifecycle at
 * all — that cost ~230B gzip and left 3B of headroom under the hard 50176B media qualification.
 * The dom/router host wires this in `installScreenPhase()`; an embed never calls it, so the
 * machine stays out of its graph and `dsx.screen.settled()` is the documented silent no-op
 * there (Article 7, fail-open).
 */
export const RunnerScreenSeam = {
  settled: null as ((frameId: number) => void) | null,
};
import { formatLogArgs, mutateURLSearchParams } from "./jse/core.ts";

export type ComponentVerb = "push" | "present" | "update" | "dismiss" | "pop";

export type RunEnv = {
  store: ReactiveStore;
  /** row scope / payload (dsx.this) */
  item: Item;
  /** declared `<action>` table of this component: name → { body, inputs } */
  actions: Map<string, { body: string; inputs: Dict }>;
  /** declared `<api>` handles of this component: as → refresh/send/cancel */
  apis: Map<string, { refresh(): Promise<void>; send(args?: Dict): Promise<unknown>; cancel(): void }>;
  /** consumer event wiring: dsx.event('x') → the mounting side's on:x */
  emitEvent: (name: string, payload: Dict) => void;
  /** router seam: dsx.component.* */
  component: (verb: ComponentVerb, name: string, opts: Dict) => void;
  /** keyed timers (surface-scoped; cleared on unmount) */
  timers: Map<string, { id: ReturnType<typeof setTimeout>; interval: boolean }>;
  /** cookie write seam */
  cookieSet?: (name: string, value: unknown) => void;
  /** action recursion guard */
  actionDepth: number;
  /** shared loop budget per entry event */
  loopWork: { count: number };
  /** The kernel navigation frame this surface belongs to. Every module call is stamped
   *  with this opaque `__frame` key, matching StackStore.frameId on Swift/Kotlin, so
   *  frame-scoped verbs (notably route.chrome) target the CALLING screen instead of
   *  whichever screen happens to be top when an async/on:appear call is delivered. */
  frameId?: number;
  /** the surface's owning package scheme — the SOURCE an ambient `dsx.error(...)` records
   *  (error-system.md §3.4; portable components never hard-code their own scheme).
   *  Unset = app-level markup, recorded as "app". */
  ownerScheme?: string;
  /**
   * THE MODULE FUNNEL, OVERRIDABLE (backend-authoring.md D6). A surface's module calls go to
   * the process-global `ModuleRegistry`, which is exactly right for a surface: one app, one
   * registry, one set of modules for the process lifetime. A SERVER is the other case — the
   * modules a body may reach are request-scoped, because the repository they front carries
   * the CALLER's verified identity, and a global registry cannot hold a per-caller table
   * without two concurrent requests overwriting each other's.
   *
   * Unset (every surface) = the global registry, byte-identical to before. Set (the server
   * host) = this function receives the SAME dotted remainder the registry would have folded,
   * and owns resolution. This is the only kernel change the server-authoring program needs.
   */
  callModule?: (chain: string, args: Dict) => Promise<unknown>;
  /**
   * BOUNDED EXECUTION for a host that runs bodies it did not write (the server). All three are
   * unset on a surface, where the defaults below apply and nothing changes.
   *
   *   `loopCap`     — overrides LOOP_CAP for this entry (a request is not a UI event; a tighter
   *                   ceiling is appropriate when thousands of tenants share a deployment).
   *   `deadlineAt`  — wall-clock epoch ms after which the loop budget reports exceeded. A
   *                   deadline that only lives outside the runner cannot stop the loop it is
   *                   waiting on; checked at the same choke point the loop budget uses.
   *   `callBudget`  — how many module calls one entry may make. A body that cannot loop forever
   *                   can still call forever, and a call is the expensive verb here (it reaches
   *                   a database).
   */
  loopCap?: number;
  deadlineAt?: number;
  callBudget?: { count: number; cap: number };
  /**
   * EGRESS GATE. Unset (every surface) = the platform's own network reachability decides,
   * which is correct in a browser or an app where the sandbox is the OS's. On a server the
   * process can reach the cloud metadata endpoint and the whole private subnet, so a host
   * running third-party bodies decides per URL. A refused request never leaves the process;
   * it answers the invalid-request shape (status -2) — see `fetchFunnel`.
   */
  egress?: (url: string) => boolean;
};

export function makeRunEnv(store: ReactiveStore, partial?: Partial<RunEnv>): RunEnv {
  return {
    store,
    item: null,
    actions: new Map(),
    apis: new Map(),
    emitEvent: () => {},
    component: (verb, name) => { console.warn(`[dsx runner] no router bound: ${verb} ${name}`); },
    timers: new Map(),
    actionDepth: 0,
    loopWork: { count: 0 },
    ...partial,
  };
}

const LOOP_CAP = 100_000;
/** The one refused-egress answer (RunEnv.egress) — a frozen literal rather than a per-call
 *  object, because this file ships in every bundle including a self-contained embed. */
const REFUSED_FETCH: Dict = { ok: false, status: -2, data: null, error: "invalid_request" };
const ARRAY_VERBS = new Set(["push", "pop", "shift", "unshift", "splice", "sort"]);
/** The mutating `URLSearchParams` verbs — mutated through the owning url so href/search resync. */
const PARAM_VERBS = new Set(["set", "append", "delete"]);
const EFFECT_VERBS = new Set(["fetch", "remove", "animate", "resolve", "error"]);

type Flow = { kind: "break" } | { kind: "continue" } | { kind: "return"; value: unknown } | { kind: "throw"; value: unknown } | null;

/** AUTHORED locals in a scope (const/let declarations, for…of loop vars, catch vars) —
 *  the ONLY names an assignment may write in-scope. Every other write routes to the
 *  owning store (the reference store-always contract, actions corpus), so an entry-
 *  payload key riding dsx.this can never shadow a store write the way a plain
 *  hasOwnProperty check let it. Non-enumerable, so scope spreads don't carry it. */
const LOCALS = Symbol("dsx.locals");

function declareLocal(scope: Dict, name: string): void {
  let set = (scope as Record<symbol, unknown>)[LOCALS] as Set<string> | undefined;
  if (set === undefined) {
    set = new Set<string>();
    Object.defineProperty(scope, LOCALS, { value: set, enumerable: false, configurable: true });
  }
  set.add(name);
}

function isLocal(scope: Dict, name: string): boolean {
  return ((scope as Record<symbol, unknown>)[LOCALS] as Set<string> | undefined)?.has(name) === true;
}

/** Route a write to its owning store (the reference `write`). Bare single-segment
 *  names that are AUTHORED locals in `scope` write the scope (loop counters, awaited
 *  consts); names that merely EXIST in scope (item fields, the entry payload) write
 *  the store — the store-always reference behavior. */
function writePath(env: RunEnv, scope: Dict, rawPath: string, value: unknown): void {
  const authoredParts = statePathParts(rawPath);
  if (authoredParts === null) return;
  const first = authoredParts[0]!;
  if (!rawPath.startsWith("dsx.") && isLocal(scope, first) && Object.prototype.hasOwnProperty.call(scope, first)) {
    if (rawPath.includes(".")) {
      // dotted write into a local: read-modify-write the local container
      const rebuilt = rebuildStatePath(scope[first], authoredParts.slice(1), value);
      if (rebuilt.accepted) scope[first] = rebuilt.value;
    } else {
      scope[rawPath] = value ?? NSNull;
    }
    return;
  }
  const path = JSE.normalizeScope(rawPath);
  if (path.startsWith("global.")) { DSXState.set(path.substring(7), value); return; }
  if (path === "global") { console.warn("[dsx runner] cannot replace the whole global store"); return; }
  if (path.startsWith("route.") || path === "route") { DSXState.set(path, value); return; }
  if (path.startsWith("cookie.")) { env.cookieSet?.(path.substring(7), value); return; }
  env.store.setPath(path, value);
}

function readPath(env: RunEnv, scope: Dict, rawPath: string): unknown {
  return JSE.lookup(rawPath, env.store.jse, scope);
}

// ── token utilities ──────────────────────────────────────────────────────────────────

function isOpTok(t: Token | undefined, v: string): boolean { return !!t && t.kind === "op" && t.v === v; }
function isIdentTok(t: Token | undefined, v?: string): boolean {
  return !!t && t.kind === "ident" && (v === undefined || t.v === v);
}

/** `i++` / `i--` / `++i` / `--i` / `x += e` (and -=, *=, /=, %=, **=) → `x = x op (e)` —
 *  the jsSugar rewrite. The lexer emits `++` / `+=` / `**=` as single op tokens
 *  (syntax wave 1; the prefix forms are wave 3). */
function jsSugar(toks: Token[]): Token[] {
  // prefix `++i` / `--i` — the same statement rewrite as the postfix form
  if (toks.length === 2 && toks[0]!.kind === "op" && (toks[0]!.v === "++" || toks[0]!.v === "--") &&
      toks[1]!.kind === "ident") {
    return [toks[1]!, { kind: "op", v: "=" }, toks[1]!, { kind: "op", v: toks[0]!.v[0]! }, { kind: "num", v: 1 }];
  }
  if (toks.length >= 2 && toks[0]!.kind === "ident") {
    const t1 = toks[1]!;
    if (toks.length === 2 && t1.kind === "op" && (t1.v === "++" || t1.v === "--")) {
      return [toks[0]!, { kind: "op", v: "=" }, toks[0]!, { kind: "op", v: t1.v[0]! }, { kind: "num", v: 1 }];
    }
    if (t1.kind === "op" && ["+=", "-=", "*=", "/=", "%=", "**="].includes(t1.v)) {
      return [
        toks[0]!, { kind: "op", v: "=" }, toks[0]!, { kind: "op", v: t1.v.slice(0, -1) },
        { kind: "op", v: "(" }, ...toks.slice(2), { kind: "op", v: ")" },
      ];
    }
    // logical assigns `x ??= e` / `x &&= e` / `x ||= e` — the op lexes as [??][=]
    const t2 = toks.length >= 3 ? toks[2]! : null;
    if (t1.kind === "op" && ["??", "&&", "||"].includes(t1.v) && t2 !== null && t2.kind === "op" && t2.v === "=") {
      return [
        toks[0]!, { kind: "op", v: "=" }, toks[0]!, { kind: "op", v: t1.v },
        { kind: "op", v: "(" }, ...toks.slice(3), { kind: "op", v: ")" },
      ];
    }
  }
  return toks;
}

/** A `fetch:` URL span written BARE (no quotes): `https://…` / `api.example.com/…` —
 *  evaluating it as an expression yields "" (the idents aren't scope names). */
function looksLikeBareUrl(toks: Token[]): boolean {
  if (toks.length < 2 || toks[0]!.kind !== "ident") return false;
  const head = toks[0]! as { v: string };
  if ((head.v === "https" || head.v === "http") && isOpTok(toks[1], ":")) return true;
  return head.v.includes(".") && isOpTok(toks[1], "/");
}

/** Reassemble the bare URL from its token source forms, verbatim, no spaces. A path
 *  segment can lex as a REGEX token (`//host/path/` — `/` in prefix position); its
 *  source form is `/pattern/flags`. */
function rebuildBareUrl(toks: Token[]): string {
  let out = "";
  for (const t of toks) {
    if (t.kind === "ident" || t.kind === "op") out += t.v;
    else if (t.kind === "num") out += string(t.v);
    else if (t.kind === "str") out += t.v;
    else if (t.kind === "regex") out += "/" + t.pattern + "/" + t.flags;
  }
  return out;
}

// ── the runner ───────────────────────────────────────────────────────────────────────

/**
 * How an action was reached. There are exactly two kinds of call and only one of them has a
 * caller: a SURFACE call comes from another action or an `on:*` handler, which has a scope; an
 * ENTRY call comes from a host — an HTTP request, a CLI invocation, a queue message — which has
 * a payload and no scope at all. `callAction` needs to be told which, because a declared input
 * means a different (both correct) thing in each. See the note inside `callAction`.
 */
export interface CallActionOptions {
  /** true when a HOST is invoking this action from outside the document. */
  entry?: boolean;
}

export class ActionRunner {
  readonly env: RunEnv;
  constructor(env: RunEnv) {
    this.env = env;
  }

  /** Entry: run an `on:*` handler string or an `<action>` body. A fresh entry event
   *  (depth 0) resets the bounded-execution ledgers and any stray flow signal; the
   *  32-frame recursion cap is owned by callAction (the action-call frame), matching
   *  the JseRunner contract exactly. */
  async run(action: string, item: Item = null, args: Dict = {}): Promise<void> {
    const body = action.trim();
    if (body.length === 0) return;
    this.entryBody = body; // uncaught-throw context (reportUncaught's `snippet`)
    await this.runExclusive(async () => {
      // bare action name → the declared <action> (callAction counts the frame)
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(body) && this.env.actions.has(body)) {
        await this.callAction(body, {}, item, args);
        return;
      }
      const scope: Dict = { ...(this.env.item ?? {}), ...(item ?? {}), ...args };
      // /web/15: an action-tier body beyond the JSE subset ESCALATES — ordinary JS in
      // the /web/12 sandbox — instead of lossy-compiling into wrong behavior.
      if (RunnerJsTierSeam.classify?.(body).tier === "js" && RunnerJsTierSeam.run !== null) {
        await this.runJsTierBody(body, scope);
        return;
      }
      const walker = new StmtWalker(cachedTokens(body));
      await this.runStatements(walker, scope, true);
    });
  }

  /**
   * Read and CLEAR a pending throw — the server's half of an action call
   * (backend-authoring.md; `@despia/server` shapes the outcome, this only hands over the signal).
   *
   * A surface entry is fire-and-forget: a tap has no caller waiting, so `run()` reports an
   * uncaught throw to the ledger and swallows it. A request has a caller, and the throw IS the
   * answer — a deliberate `throw { reason: 'invalid' }` is a 400, not a server fault, and must
   * not be filed as an unobserved runtime error. Kept to four lines on purpose: this method
   * ships in every bundle including a self-contained embed, so the outcome shaping lives in the
   * server package where no embed can pay for it.
   */
  takeThrow(): { value: unknown } | null {
    const flow = this.currentFlow();
    if (flow === null || flow.kind !== "throw") return null;
    this.flow = null;
    return { value: flow.value };
  }

  /** Run one ESCALATED body (/web/15 law 3): the jstier executor with this runner's
   *  read/write routing, its depth-guarded action re-entry, and the ONE module funnel.
   *  A thrown value lands in the same flow signal the interpreter uses, so callers'
   *  try/catch and the uncaught fan-out behave identically across tiers. */
  private async runJsTierBody(body: string, scope: Dict): Promise<void> {
    const run = RunnerJsTierSeam.run;
    if (run === null) return;
    try {
      await run(body, {
        read: (path) => readPath(this.env, scope, path),
        write: (path, value) => writePath(this.env, scope, path, value),
        callAction: (name, args) => this.callAction(name, args),
        callModule: (chain, args) => {
          const argObj = this.env.frameId === undefined ? args : { ...args, __frame: this.env.frameId };
          return this.callModuleFunnel(chain, argObj);
        },
        emitEvent: (name, payload) => {
          this.env.emitEvent(name, payload);
          DSXEvents.publish(name, payload);
        },
        log: (args) => { reportLog(this.env.ownerScheme ?? "app", "log", formatLogArgs(args)); },
        error: (code, message) => {
          ModuleRegistry.reportAmbientError(this.env.ownerScheme ?? "app", code,
                                            { message, recoverable: true });
        },
      });
    } catch (e) {
      this.flow = { kind: "throw", value: e instanceof Error ? { message: e.message } : e };
    }
  }

  /** the tail of the in-flight top-level entry (an async mutex — see runExclusive) */
  private entryLock: Promise<void> = Promise.resolve();

  /** How long a NEW entry waits for the in-flight one before proceeding anyway (ms).
   *  The exclusivity below exists to protect the per-entry ledgers while a body is
   *  suspended at an `await` — but an entry whose awaited module call NEVER settles
   *  (a clipboard read hanging on permission, an interactive paywall held open) must
   *  not freeze every later tap on the surface forever: bounded execution is the JSE
   *  law, and the iOS runner (the reference) interleaves entries freely at suspension
   *  points. Interleaving is ledger-safe there by construction — at any suspension
   *  point the flow signal is null (signals unwind synchronously) and a reset loop
   *  budget only ever REFRESHES the suspended entry's allowance — so proceeding after
   *  a bounded wait trades a theoretical budget refresh for never bricking the page. */
  private static readonly ENTRY_LOCK_BOUND_MS = 1500;

  /** Run a top-level entry (an `on:*` handler, an `<action>` body, or a fired timer lambda)
   *  with EXCLUSIVE access to this runner's per-entry ledgers — the flow signal, the loop
   *  budget (`loopWork`), and the action-recursion depth. ONE ActionRunner is shared across
   *  all of a component's handlers, and those ledgers are mutable instance/env state; because
   *  the web runner awaits mid-body, a second entry that started while another was suspended
   *  at an `await` would reset them under the suspended one (its loop budget zeroed, its flow
   *  cleared). Chaining on `entryLock` keeps entries one-at-a-time whenever they finish
   *  promptly — but the wait is BOUNDED (ENTRY_LOCK_BOUND_MS): an entry suspended on a
   *  never-settling module call releases the surface instead of jamming every later tap
   *  (proven by the demo Device-info page: one hung clipboard.read froze the whole page).
   *  Nested action calls go through callAction (not this), so they never re-enter
   *  the lock — no deadlock, no self-wait. */
  private async runExclusive(work: () => Promise<void>): Promise<void> {
    const prior = this.entryLock;
    let release!: () => void;
    this.entryLock = new Promise<void>((r) => { release = r; });
    await Promise.race([prior, new Promise<void>((r) => setTimeout(r, ActionRunner.ENTRY_LOCK_BOUND_MS))]);
    // fresh entry: the previous one has fully unwound (depth back to 0) — clear the ledgers.
    // callBudget joins them because its contract ("how many module calls one ENTRY may
    // make", the type doc above) was per-entry all along — the single-entry hosts (a CLI
    // invocation, a server request) never noticed the missing reset, and a long-lived
    // scoped surface (studio-apps.md §5) is the first multi-entry env that would have
    // starved after its cap's worth of taps.
    this.env.actionDepth = 0;
    this.env.loopWork.count = 0;
    if (this.env.callBudget !== undefined) this.env.callBudget.count = 0;
    this.flow = null;
    try {
      await work();
    } finally {
      // An uncaught `throw` that unwound the whole entry used to vanish here — now it
      // reports through the ambient fan-out with origin "uncaught" (errors corpus): the
      // ledger, module.error, the page channel + dsx mirror, the reactive keys. The
      // window.onerror analogue for markup actions; control flow is already unwound, so
      // recording changes nothing (Article 7 — observe, never crash).
      // (read through a method so TS doesn't over-narrow the mutated instance field)
      const f = this.currentFlow();
      if (f !== null && f.kind === "throw") this.reportUncaught(f.value);
      this.flow = null;
      release();
    }
  }

  /** The body of the entry (or nested action) currently running — a throw that unwinds
   *  keeps the THROWING body here (callAction skips the restore on throw, like `flow`),
   *  so reportUncaught's `snippet` says WHAT threw. */
  private entryBody = "";

  /** Derive the canonical error fields from an uncaught thrown value (corpus-pinned): a
   *  dict with a string `code` keeps its code/message/recoverable/data; a codeless dict
   *  with a string `message` (a JSE `new Error("…")`, the browser-parity throw) keeps the
   *  message and rides whole as data; any other dict rides as data; anything else records
   *  code "uncaught" with the JSE string coercion as message. RUNTIME ERROR CONTEXT: the
   *  data additionally carries `snippet` — the first 120 chars of the body that threw —
   *  so a ledger entry says WHAT threw, not just that something did (dict data gains the
   *  key unless the author set one; scalar data rides untouched; expects stay green — the
   *  errors corpus subset-matches). */
  private reportUncaught(value: unknown): void {
    let code = "uncaught";
    let message: string | null = null;
    let recoverable = false;
    let data: unknown;
    if (isDict(value)) {
      const d = value as Dict;
      const c = d["code"];
      if (typeof c === "string" && c.length > 0) {
        code = c;
        const m = d["message"];
        message = m === undefined || m === null || m === NSNull ? null : string(m);
        recoverable = truthy(d["recoverable"]);
        if (d["data"] !== undefined) data = d["data"];
      } else if (typeof d["message"] === "string" && (d["message"] as string).length > 0) {
        message = d["message"] as string;
        data = d;
      } else {
        data = d;
      }
    } else {
      message = string(value);
    }
    const snippet = this.entryBody.slice(0, 120);
    if (isDict(data)) {
      if ((data as Dict)["snippet"] === undefined) data = { ...(data as Dict), snippet };
    } else if (data === undefined || data === null || data === NSNull) {
      data = { snippet };
    }
    ModuleRegistry.reportAmbientError(this.env.ownerScheme ?? "app", code,
      { message, recoverable, data, origin: "uncaught" });
  }

  /** Invoke a declared `<action as=…>` — declared inputs evaluated in CALLER scope,
   *  first-arg object merges into the action scope, payload rides dsx.this. Actions
   *  ARE workflows: they call each other (`dsx.action.x()` / bare `x()`), chain, and
   *  pass args — depth-capped at 32 so a recursive workflow is bounded, never a hang
   *  (the JseRunner contract). Each call runs with its OWN flow signal, so a nested
   *  action's `return`/`break` can't abort the caller.
   *
   *  RETURNING ACTIONS (actions corpus): resolves to the callee's OWN `return <expr>`
   *  value — captured from its flow signal {kind:"return", value} BEFORE the caller's
   *  flow is swapped back, so a nested call's leftover can never masquerade as this
   *  callee's return. Null when the body never returned (or returned bare). Only an
   *  AWAITING `dsx.action` caller consumes it; every other call site ignores it. */
  async callAction(
    name: string,
    callArgs: Dict,
    item: Item = null,
    payload: Dict = {},
    options: CallActionOptions = {},
  ): Promise<unknown> {
    const decl = this.env.actions.get(name);
    if (!decl) { console.warn(`[dsx runner] unknown action: ${name}`); return null; }
    if (this.env.actionDepth >= 32) {
      console.warn(`[dsx runner] action depth (32) exceeded at ${name} — recursion contained`);
      return null;
    }
    const callerScope: Dict = { ...(this.env.item ?? {}), ...(item ?? {}) };
    const scope: Dict = { ...callerScope, ...payload };
    for (const [k, expr] of Object.entries(decl.inputs)) {
      // AN ENTRY CALL HAS NO CALLER, so it has no caller scope to evaluate against, and a
      // declared input names a payload KEY rather than an expression to compute. The two
      // readings of `inputs="message"` are both correct and they are not the same: at a surface
      // call site the caller HAS a `message` in scope and the action means "take that one"; at
      // an entry the value arrives from outside and the action means "I accept one".
      //
      // Collapsing them cost a shipped bug. The surface rule ran unconditionally, so an entry
      // evaluated the input against an empty scope, got nothing, and OVERWROTE the host's
      // payload with the absent sentinel — a `<server>` action declaring `inputs="title, total"`
      // received null for both, which made declaring the contract strictly worse than omitting
      // it. Every host then coped differently: the CLI node discarded declared inputs entirely,
      // the queue drain routed its message through `callArgs`, and the HTTP path just shipped
      // the nulls. One unspecified case, three workarounds, one live defect.
      if (options.entry === true) {
        // The expression still resolves when the payload is silent, so a default that reads the
        // store (`inputs="limit: defaults.limit"`) keeps working at an entry point.
        // OWN keys only. `k in payload` walks the prototype chain, so an input named `toString`
        // or `constructor` would read as supplied when it was not — and the Kotlin twin
        // (`containsKey`) and the Swift twin (a dictionary subscript) both test own keys, so
        // `in` would be a silent three-renderer divergence on exactly those names.
        if (Object.prototype.hasOwnProperty.call(payload, k)) continue;
        scope[k] = JSE.evalBlock(string(expr), this.env.store.jse, {}) ?? NSNull;
        continue;
      }
      scope[k] = JSE.evalBlock(string(expr), this.env.store.jse, callerScope) ?? NSNull;
    }
    Object.assign(scope, callArgs);
    const savedFlow = this.flow; // isolate the callee's control flow from the caller
    const savedBody = this.entryBody;
    this.flow = null;
    this.entryBody = decl.body; // uncaught-throw context: the body that threw (see reportUncaught)
    this.env.actionDepth += 1;
    let returned: unknown = null;
    try {
      // /web/15: a declared <action> beyond the subset escalates like an entry body
      if (RunnerJsTierSeam.classify?.(decl.body).tier === "js" && RunnerJsTierSeam.run !== null) {
        await this.runJsTierBody(decl.body, scope);
      } else {
        const walker = new StmtWalker(cachedTokens(decl.body));
        await this.runStatements(walker, scope, true);
      }
    } finally {
      this.env.actionDepth -= 1;
      // a `throw` propagates to the caller (real exception → its try/catch); a
      // `return`/`break`/`continue` is LOCAL to the action (it just ends the body).
      // (read through a method so TS doesn't over-narrow the mutated instance field)
      const f = this.currentFlow();
      if (f !== null && f.kind === "return") returned = f.value ?? null;
      if (!this.threw()) { this.flow = savedFlow; this.entryBody = savedBody; }
    }
    return returned;
  }

  /** the current flow signal is a `throw` (a real exception to propagate) */
  private threw(): boolean {
    const f: Flow = this.flow;
    return f !== null && f.kind === "throw";
  }

  /** the current flow signal, read through a method (TS over-narrows the mutated field) */
  private currentFlow(): Flow {
    return this.flow;
  }

  // ── statement machinery ────────────────────────────────────────────────────────────

  private flow: Flow = null;
  /** event callbacks passed as the 2nd arg of the in-flight `dsx.action.x(args, { evt: fn })`
   *  call — an event the callee raises runs the matching callback (native store.actionEvents). */
  private actionEvents: Dict | null = null;

  private async runStatements(w: StmtWalker, scope: Dict, topLevel: boolean): Promise<void> {
    for (;;) {
      if (this.flow !== null) return;
      const tk = w.cur();
      if (tk === null) return;
      if (isOpTok(tk, "}")) return;
      if (isOpTok(tk, ";")) { w.i += 1; continue; }
      const before = w.i;
      await this.statement(w, scope, topLevel);
      if (w.i === before) w.i += 1; // never spin
    }
  }

  private async statement(w: StmtWalker, scope: Dict, topLevel: boolean): Promise<void> {
    const tk = w.cur();
    if (tk === null) return;
    if (isIdentTok(tk, "function")) { w.skipFunction(); return; }
    if (isIdentTok(tk, "if")) { await this.ifStmt(w, scope, topLevel); return; }
    if (isIdentTok(tk, "while")) { await this.whileStmt(w, scope); return; }
    if (isIdentTok(tk, "do")) { await this.doWhileStmt(w, scope); return; }
    if (isIdentTok(tk, "for")) { await this.forStmt(w, scope); return; }
    if (isIdentTok(tk, "switch")) { await this.switchStmt(w, scope); return; }
    if (isIdentTok(tk, "try")) { await this.tryStmt(w, scope); return; }
    if (isIdentTok(tk, "const") || isIdentTok(tk, "let") || isIdentTok(tk, "var")) {
      await this.declStmt(w, scope);
      return;
    }
    if (isIdentTok(tk, "return")) {
      w.i += 1;
      const toks = w.capture(new Set([";"]));
      if (isOpTok(w.cur() ?? undefined, ";")) w.i += 1;
      const v = toks.length === 0 ? null : await this.evalMaybeAsync(toks, scope);
      this.flow = { kind: "return", value: v };
      return;
    }
    if (isIdentTok(tk, "break")) { w.i += 1; this.flow = { kind: "break" }; return; }
    if (isIdentTok(tk, "continue")) { w.i += 1; this.flow = { kind: "continue" }; return; }
    if (isIdentTok(tk, "throw")) {
      w.i += 1;
      const toks = w.capture(new Set([";"]));
      if (isOpTok(w.cur() ?? undefined, ";")) w.i += 1;
      this.flow = { kind: "throw", value: await this.evalMaybeAsync(toks, scope) };
      return;
    }
    // effect verbs: `fetch:` `remove:` `animate:` …
    if (tk.kind === "ident" && EFFECT_VERBS.has(tk.v) && isOpTok(w.t[w.i + 1], ":")) {
      const verb = tk.v;
      w.i += 2;
      const toks = w.capture(new Set([";"]));
      if (isOpTok(w.cur() ?? undefined, ";")) w.i += 1;
      await this.effectVerb(verb, toks, scope);
      return;
    }
    if (isOpTok(tk, "{")) { // bare block scope
      w.i += 1;
      await this.runStatements(w, scope, topLevel);
      if (isOpTok(w.cur() ?? undefined, "}")) w.i += 1;
      return;
    }
    const toks = w.capture(new Set([";"]));
    if (isOpTok(w.cur() ?? undefined, ";")) w.i += 1;
    if (toks.length > 0) await this.leafStatement(toks, scope);
  }

  private async ifStmt(w: StmtWalker, scope: Dict, topLevel: boolean): Promise<void> {
    w.i += 1;
    const c = w.captureParen();
    const cond = truthy(this.evalSync(c, scope));
    await this.branch(w, scope, cond, topLevel);
    if (isIdentTok(w.cur() ?? undefined, "else")) {
      w.i += 1;
      if (isIdentTok(w.cur() ?? undefined, "if")) {
        if (cond) { w.skipIfChain(); return; }
        await this.ifStmt(w, scope, topLevel);
      } else {
        await this.branch(w, scope, !cond, topLevel);
      }
    }
  }

  private async branch(w: StmtWalker, scope: Dict, execute: boolean, topLevel: boolean): Promise<void> {
    if (!execute) { w.skipBranch(); return; }
    if (isOpTok(w.cur() ?? undefined, "{")) {
      const start = w.i;
      w.i += 1;
      await this.runStatements(w, scope, topLevel);
      if (isOpTok(w.cur() ?? undefined, "}")) {
        w.i += 1;
      } else {
        // a flow signal stopped execution MID-block (statements remain after a
        // throw/return) — realign the walker to the block's end, so the owning
        // construct (try's catch, if's else) still sees what follows. The natives
        // are immune by construction (they capture the branch text first).
        w.i = start;
        w.skipBranch();
      }
    } else {
      await this.statement(w, scope, topLevel);
    }
  }

  private async whileStmt(w: StmtWalker, scope: Dict): Promise<void> {
    w.i += 1;
    const c = w.captureParen();
    const bodyStart = w.i;
    for (;;) {
      if (!truthy(this.evalSync(c, scope))) { w.i = bodyStart; w.skipBranch(); return; }
      if (this.budgetExceeded()) { w.i = bodyStart; w.skipBranch(); return; }
      w.i = bodyStart;
      await this.branch(w, scope, true, false);
      if (this.flow?.kind === "break") { this.flow = null; w.i = bodyStart; w.skipBranch(); return; }
      if (this.flow?.kind === "continue") this.flow = null;
      if (this.flow !== null) { w.i = bodyStart; w.skipBranch(); return; }
    }
  }

  /** `do { … } while (cond)` — body-first, budgeted, break/continue honored. */
  private async doWhileStmt(w: StmtWalker, scope: Dict): Promise<void> {
    w.i += 1; // 'do'
    const bodyStart = w.i;
    w.skipBranch();
    let cond: Token[] = [];
    if (isIdentTok(w.cur() ?? undefined, "while")) { w.i += 1; cond = w.captureParen(); }
    const afterLoop = w.i;
    for (;;) {
      if (this.budgetExceeded()) break;
      w.i = bodyStart;
      await this.branch(w, scope, true, false);
      if (this.flow?.kind === "break") { this.flow = null; break; }
      if (this.flow?.kind === "continue") this.flow = null;
      if (this.flow !== null) break;
      if (!truthy(this.evalSync(cond, scope))) break;
    }
    w.i = afterLoop;
  }

  private async forStmt(w: StmtWalker, scope: Dict): Promise<void> {
    w.i += 1;
    const header = w.captureParen();
    // for (const x of arr) — detect a top-level `of`
    const ofIdx = header.findIndex((t, i) => i > 0 && t.kind === "ident" && t.v === "of");
    const bodyStart = w.i;
    if (ofIdx >= 0) {
      let nameIdx = 0;
      if (isIdentTok(header[0], "const") || isIdentTok(header[0], "let") || isIdentTok(header[0], "var")) nameIdx = 1;
      // loop var: an ident, or a flat `[a, b]` / `{a, b}` pattern (parseDeclarators reads it)
      const decls = parseDeclarators(header.slice(nameIdx, ofIdx));
      const pattern = decls.length > 0 ? decls[0]!.pattern : null;
      const arr = spreadValues(this.evalSync(header.slice(ofIdx + 1), scope)); // arrays, strings, Set, Map
      for (const e of arr) {
        if (this.budgetExceeded()) break;
        if (pattern !== null) {
          bindPattern(pattern, e, (n, val) => { scope[n] = val ?? NSNull; declareLocal(scope, n); },
                      (toks) => this.evalSync(toks, scope));
        }
        w.i = bodyStart;
        await this.branch(w, scope, true, false);
        if (this.flow?.kind === "break") { this.flow = null; break; }
        if (this.flow?.kind === "continue") this.flow = null;
        if (this.flow !== null) break;
      }
      w.i = bodyStart;
      w.skipBranch();
      return;
    }
    // top-level semicolons — the classic-for splitter AND the for…in gate below
    const semis: number[] = [];
    let depth = 0;
    header.forEach((t, i) => {
      if (t.kind === "op" && ["(", "[", "{"].includes(t.v)) depth += 1;
      if (t.kind === "op" && [")", "]", "}"].includes(t.v)) depth -= 1;
      if (t.kind === "op" && t.v === ";" && depth === 0) semis.push(i);
    });
    // for (const k in obj) — dict OWN keys ("__"-internal skipped) / array indices
    // 0..n-1; ONLY when the header has NO top-level `;`, because a classic for's
    // condition may contain the `in` OPERATOR (`for (i = 0; 'a' in d; ++i)`).
    if (semis.length === 0) {
      let d2 = 0;
      let inIdx = -1;
      for (let i = 1; i < header.length; i++) {
        const t = header[i]!;
        if (t.kind === "op" && ["(", "[", "{"].includes(t.v)) d2 += 1;
        else if (t.kind === "op" && [")", "]", "}"].includes(t.v)) d2 -= 1;
        else if (d2 === 0 && t.kind === "ident" && t.v === "in") { inIdx = i; break; }
      }
      if (inIdx >= 0) {
        let nameIdx = 0;
        if (isIdentTok(header[0], "const") || isIdentTok(header[0], "let") || isIdentTok(header[0], "var")) nameIdx = 1;
        const decls = parseDeclarators(header.slice(nameIdx, inIdx));
        const pattern = decls.length > 0 ? decls[0]!.pattern : null;
        const keys = forInKeys(this.evalSync(header.slice(inIdx + 1), scope));
        for (const k of keys) {
          if (this.budgetExceeded()) break;
          if (pattern !== null) {
            bindPattern(pattern, k, (n, val) => { scope[n] = val ?? NSNull; declareLocal(scope, n); },
                        (toks) => this.evalSync(toks, scope));
          }
          w.i = bodyStart;
          await this.branch(w, scope, true, false);
          if (this.flow?.kind === "break") { this.flow = null; break; }
          if (this.flow?.kind === "continue") this.flow = null;
          if (this.flow !== null) break;
        }
        w.i = bodyStart;
        w.skipBranch();
        return;
      }
    }
    // classic for(init; cond; step)
    const init = semis.length > 0 ? header.slice(0, semis[0]!) : header;
    const cond = semis.length > 1 ? header.slice(semis[0]! + 1, semis[1]!) : [];
    const step = semis.length > 1 ? header.slice(semis[1]! + 1) : [];
    if (init.length > 0) {
      const iw = new StmtWalker(init);
      await this.statement(iw, scope, false);
    }
    for (;;) {
      if (cond.length > 0 && !truthy(this.evalSync(cond, scope))) break;
      if (this.budgetExceeded()) break;
      w.i = bodyStart;
      await this.branch(w, scope, true, false);
      if (this.flow?.kind === "break") { this.flow = null; break; }
      if (this.flow?.kind === "continue") this.flow = null;
      if (this.flow !== null) break;
      if (step.length > 0) await this.leafStatement(jsSugar(step), scope);
    }
    w.i = bodyStart;
    w.skipBranch();
  }

  private async switchStmt(w: StmtWalker, scope: Dict): Promise<void> {
    w.i += 1;
    const subject = this.evalSync(w.captureParen(), scope);
    if (!isOpTok(w.cur() ?? undefined, "{")) return;
    w.i += 1;
    let matched = false;
    for (;;) {
      const tk = w.cur();
      if (tk === null) return;
      if (isOpTok(tk, "}")) { w.i += 1; break; }
      if (isIdentTok(tk, "case")) {
        w.i += 1;
        const caseToks = w.capture(new Set([":"]));
        if (isOpTok(w.cur() ?? undefined, ":")) w.i += 1;
        if (!matched) matched = JSE.equals(subject, this.evalSync(caseToks, scope));
        continue;
      }
      if (isIdentTok(tk, "default")) {
        w.i += 1;
        if (isOpTok(w.cur() ?? undefined, ":")) w.i += 1;
        matched = true;
        continue;
      }
      if (matched) {
        const before = w.i;
        await this.statement(w, scope, false);
        if (this.flow?.kind === "break") { this.flow = null; w.skipToBlockEnd(); return; }
        if (this.flow !== null) { w.skipToBlockEnd(); return; }
        if (w.i === before) w.i += 1;
      } else {
        w.skipCaseStatement();
      }
    }
  }

  private async tryStmt(w: StmtWalker, scope: Dict): Promise<void> {
    w.i += 1;
    await this.branch(w, scope, true, false);
    const threw = this.flow?.kind === "throw" ? this.flow : null;
    if (threw) this.flow = null;
    if (isIdentTok(w.cur() ?? undefined, "catch")) {
      w.i += 1;
      let errName = "";
      if (isOpTok(w.cur() ?? undefined, "(")) {
        const p = w.captureParen();
        if (p.length > 0 && p[0]!.kind === "ident") errName = p[0]!.v;
      }
      if (threw) {
        if (errName.length > 0) { scope[errName] = threw.value ?? NSNull; declareLocal(scope, errName); }
        await this.branch(w, scope, true, false);
      } else {
        w.skipBranch();
      }
    } else if (threw) {
      this.flow = threw; // no catch — rethrow upward
    }
    if (isIdentTok(w.cur() ?? undefined, "finally")) {
      w.i += 1;
      const saved = this.flow;
      this.flow = null;
      await this.branch(w, scope, true, false);
      if (this.flow === null) this.flow = saved;
    }
  }

  private async declStmt(w: StmtWalker, scope: Dict): Promise<void> {
    w.i += 1;
    const toks = w.capture(new Set([";"]));
    if (isOpTok(w.cur() ?? undefined, ";")) w.i += 1;
    // multi-declarators + flat destructuring: `let a = 1, b = 2` · `const {x, y: r} = o` ·
    // `const [p, q] = await Promise.all([…])` — each initializer keeps the async routing.
    for (const d of parseDeclarators(toks)) {
      const v = d.expr.length === 0 ? null : await this.evalMaybeAsync(d.expr, scope);
      bindPattern(
        d.pattern, v,
        (n, val) => { scope[n] = val ?? NSNull; declareLocal(scope, n); },
        // A `= default` is evaluated in the SCOPE BEING BUILT, so an earlier position in the
        // same pattern is already visible to a later one's default — the JS rule.
        (toks) => this.evalSync(toks, scope),
      );
    }
  }

  /** One leaf statement (assignment / call / mutation) — the runJSStatement table. */
  private async leafStatement(rawToks: Token[], scope: Dict): Promise<void> {
    const toks = jsSugar(rawToks);
    // a BARE action name as a statement invokes it — the native runVerb parity: a body like
    // `x = 1; copyDemo; y = 2` runs copyDemo mid-body (the paren form is handled below).
    if (toks.length === 1 && toks[0]!.kind === "ident" && this.env.actions.has(toks[0]!.v)) {
      await this.callAction(toks[0]!.v, {}, scope, {});
      return;
    }
    // DESTRUCTURING ASSIGNMENT `[a, b] = [b, a]` (syntax-005) — the declaration-less
    // pattern write. parseDeclarators reads `pattern = expr` exactly as it does after a
    // `const`; only the binder differs: writePath routes each name as an ordinary
    // assignment (an authored local stays local, everything else is the store), so the
    // statement writes wherever `a = …` would have. The RHS evaluates ONCE, before any
    // binding — which is what makes a swap a swap.
    if (toks.length >= 4 && isOpTok(toks[0], "[")) {
      const decls = parseDeclarators(toks);
      const d0 = decls.length === 1 ? decls[0]! : null;
      if (d0 !== null && d0.pattern.kind === "array" && d0.expr.length > 0 &&
          (d0.pattern.items.some((it) => it !== null) || d0.pattern.rest !== undefined)) {
        const v = await this.evalMaybeAsync(d0.expr, scope);
        bindPattern(d0.pattern, v, (n, val) => writePath(this.env, scope, n, val ?? NSNull),
                    (dts) => this.evalSync(dts, scope));
        return;
      }
    }
    // assignment: single dotted-ident LHS `=` RHS
    if (toks.length >= 2 && toks[0]!.kind === "ident" && isOpTok(toks[1], "=")) {
      const lhs = toks[0]!.v;
      const value = await this.evalMaybeAsync(toks.slice(2), scope);
      writePath(this.env, scope, lhs, value);
      return;
    }
    // indexed assignment: `name[expr] = rhs` (one index level) — the index evaluates and
    // the write routes through the dotted path (`arr.0` / `o.key`), same as `set:` paths
    if (toks.length >= 5 && toks[0]!.kind === "ident" && isOpTok(toks[1], "[")) {
      let d = 0;
      let close = -1;
      for (let i = 1; i < toks.length; i++) {
        const t = toks[i]!;
        if (t.kind === "op" && (t.v === "[" || t.v === "(" || t.v === "{")) d += 1;
        else if (t.kind === "op" && (t.v === "]" || t.v === ")" || t.v === "}")) { d -= 1; if (d === 0) { close = i; break; } }
      }
      if (close > 1 && isOpTok(toks[close + 1], "=")) {
        const idxVal = this.evalSync(toks.slice(2, close), scope);
        const value = await this.evalMaybeAsync(toks.slice(close + 2), scope);
        const n = number(idxVal);
        const seg = n !== null && Number.isFinite(n) && Math.trunc(n) === n ? String(safeInt(n)) : string(idxVal);
        writePath(this.env, scope, `${toks[0]!.v}.${seg}`, value);
        return;
      }
    }
    // call-shaped statements
    if (toks.length >= 2 && toks[0]!.kind === "ident" && isOpTok(toks[1], "(")) {
      const callee = toks[0]!.v;
      // timers
      if (callee === "setTimeout" || callee === "setInterval") { this.timerStatement(callee, toks, scope); return; }
      if (callee === "clearTimeout" || callee === "clearInterval") {
        const args = this.parseArgs(toks.slice(1), scope);
        const key = string(args[0]);
        const t = this.env.timers.get(key);
        if (t) { (t.interval ? clearInterval : clearTimeout)(t.id); this.env.timers.delete(key); }
        return;
      }
      // array mutations on a dotted path — INCLUDING the explicit dsx.variable.x.push
      // form (checked before the generic dsx.* dispatch); dsx.component.push (the router
      // verb), dsx.module.*.push, and dsx.action.<verb> (a point-to-point call to an
      // action named push/pop/sort/… — the natives strip the prefix and invoke it) are
      // excluded so they route as calls, not as a garbage store mutation.
      const dot = callee.lastIndexOf(".");
      const lastSeg = dot >= 0 ? callee.substring(dot + 1) : "";
      // `<url>.searchParams.set|append|delete(…)` mutates THROUGH the owning url, so `href` and
      // `search` stay true — the twin of JseRunner.kt's `receiver.endsWith(".searchParams")`
      // branch. Mutating the params dict on its own leaves the url advertising a query it no
      // longer has, and `href` is what callers pass to fetch/navigate.
      if (dot >= 0 && PARAM_VERBS.has(lastSeg)) {
        const receiver = callee.substring(0, dot);
        // A build without the JS-globals layer (__DSX_OPTIONAL_JS_GLOBALS__ false) can
        // never mint a {__url} dict, so the parent-walk is unreachable there; the same
        // define folds it, and core.ts's params/href plumbing tree-shakes behind it.
        if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_JS_GLOBALS__?: boolean })
          .__DSX_OPTIONAL_JS_GLOBALS__ !== false && receiver.endsWith(".searchParams")) {
          const parent = receiver.substring(0, receiver.length - ".searchParams".length);
          const owner = readPath(this.env, scope, parent);
          const next = mutateURLSearchParams(owner, lastSeg, this.parseArgs(toks.slice(1), scope));
          if (next !== null) { writePath(this.env, scope, parent, next); return; }
        }
      }
      if (dot >= 0 && ARRAY_VERBS.has(lastSeg) &&
          !callee.startsWith("dsx.component.") && !callee.startsWith("dsx.module.") &&
          !callee.startsWith("dsx.action.")) {
        this.mutateArray(callee.substring(0, dot), lastSeg, this.parseArgs(toks.slice(1), scope), scope);
        return;
      }
      // dsx.* statement forms
      if (callee.startsWith("dsx.")) { await this.dsxStatement(callee, toks, scope, false); return; }
      // declared <api> handles: orders.refresh() / orders.send({…}) / orders.cancel()
      const apiDot = callee.indexOf(".");
      if (apiDot > 0) {
        const handle = this.env.apis.get(callee.substring(0, apiDot));
        const verb = callee.substring(apiDot + 1);
        if (handle && ["refresh", "send", "cancel"].includes(verb)) {
          const args = this.parseArgs(toks.slice(1), scope);
          if (verb === "cancel") handle.cancel();
          else if (verb === "refresh") void handle.refresh();
          else void handle.send(isDict(args[0]) ? (args[0] as Dict) : undefined).catch(() => {});
          return;
        }
      }
      // named <action> call
      if (dot < 0 && this.env.actions.has(callee)) {
        const args = this.parseArgs(toks.slice(1), scope);
        const argObj = isDict(args[0]) ? (args[0] as Dict) : {};
        await this.callAction(callee, argObj, scope, {});
        return;
      }
    }
    // anything else: evaluate as an expression (await if it yields a promise)
    await this.evalMaybeAsync(toks, scope);
  }

  /** dsx.module / dsx.event / dsx.send / dsx.broadcast / dsx.component / dsx.action */
  private async dsxStatement(callee: string, toks: Token[], scope: Dict, awaited: boolean): Promise<unknown> {
    const args = this.parseArgs(toks.slice(1), scope);
    if (callee === "dsx.event") {
      const name = string(args[0]);
      const payload = isDict(args[1]) ? (args[1] as Dict) : {};
      // a callback passed at the action call runs (native emitEventUp's callback path; payload
      // rides dsx.this) — but the wildcard/recorder and the bus still see EVERY event, callback
      // or not: native fires anyHandlers + publishNative "consumed or not" (Stack.swift /
      // JseRunner.kt), and emitEvent is the web wildcard analogue. So the callback is ADDITIVE,
      // never a suppressor of the broadcast.
      const cb = this.actionEvents?.[name];
      if (isLambda(cb)) await this.runLambdaInline(cb, payload);
      this.env.emitEvent(name, payload);
      DSXEvents.publish(name, payload);
      return null;
    }
    if (callee === "dsx.send" || callee === "dsx.broadcast") {
      const name = string(args[0]);
      const payload = isDict(args[1]) ? (args[1] as Dict) : {};
      DSXEvents.publish(name, payload);
      return null;
    }
    if (callee === "dsx.error") {
      // The AMBIENT error hat in markup (error-system.md §3.4) — a markup action never holds
      // a call to settle, so this is always the emission form: records to the ledger and fans
      // out (module.error hook, page channel + dsx mirror, global.dsx.* keys). NEVER unwinds
      // control flow — it is not a throw, it records; the statement after it still runs.
      const code = string(args[0]) || "error";
      const opts = isDict(args[1]) ? (args[1] as Dict) : {};
      ModuleRegistry.reportAmbientError(this.env.ownerScheme ?? "app", code, {
        message: opts["message"] === undefined || opts["message"] === null ? null : string(opts["message"]),
        recoverable: truthy(opts["recoverable"]),
        data: opts["data"],
      });
      return null;
    }
    if (callee === "dsx.log") {
      // The unified console primitive (logs corpus): console.log-shaped variadic args,
      // house formatting (JSE coercions + canonical JSON + credential masking), recorded
      // in the log ring attributed to the surface's owning scheme + one console mirror
      // line. Records, never unwinds, never throws.
      reportLog(this.env.ownerScheme ?? "app", "log", formatLogArgs(args));
      return null;
    }
    if (callee === "dsx.screen.settled") {
      // The DEFERRED-READINESS report (screen-lifecycle.md; corpus lifecycle/readiness.json):
      // "this screen has settled". Zero-arg, past tense — a REPORT, never a request. It is a
      // CALL and never collides with the reactive PROPERTIES `dsx.screen.ready` (Bool) /
      // `dsx.screen.phase` (String), which stay read-only state. The machine decides whether
      // anything fires (once per frame, an explicit settle always wins), so this records and
      // never unwinds — same shape as dsx.log. Outside a router frame there is nothing to
      // settle, which is a documented silent no-op (Article 7, fail-open).
      if (this.env.frameId !== undefined) RunnerScreenSeam.settled?.(this.env.frameId);
      return null;
    }
    if (callee.startsWith("dsx.component.")) {
      const verb = callee.substring("dsx.component.".length) as ComponentVerb;
      if (["push", "present", "update", "dismiss", "pop"].includes(verb)) {
        this.env.component(verb, string(args[0] ?? ""), isDict(args[1]) ? (args[1] as Dict) : {});
      } else {
        console.warn(`[dsx runner] unknown component verb: ${verb}`);
      }
      return null;
    }
    if (callee.startsWith("dsx.action.")) {
      const name = callee.substring("dsx.action.".length);
      const argObj = isDict(args[0]) ? (args[0] as Dict) : {};
      // 2nd arg = event callbacks: `dsx.action.x(args, { done: () => … })`. They frame the
      // callee so an event it raises invokes the caller's callback (native store.actionEvents),
      // saved/restored so a nested action's callbacks don't leak into the caller's.
      const handlers = isDict(args[1]) ? (args[1] as Dict) : null;
      const savedEvents = this.actionEvents;
      if (handlers !== null) this.actionEvents = handlers;
      let value: unknown = null;
      try {
        value = await this.callAction(name, argObj, scope, {});
      } finally {
        this.actionEvents = savedEvents;
      }
      // RETURNING ACTIONS (actions corpus): an AWAITED action call binds the ENVELOPE
      // { ok: true, data: <the callee's `return <expr>` value, null when it never
      // returned> } — the dsx.module success shape, so `const r = await dsx.action.x()`
      // reads like `await dsx.module.x.y()`. No { ok:false } arm exists here: an action
      // has no error channel but `throw`, and a throw that unwinds the callee keeps
      // propagating as a real exception to the caller's try/catch (never enveloped) —
      // exactly the un-awaited contract. Fire-and-forget calls stay null-returning.
      if (awaited && !this.threw()) return { ok: true, data: value ?? null };
      return null;
    }
    if (callee.startsWith("dsx.module.")) {
      // The FULL dotted remainder rides to the ONE funnel — the bus FOLD resolves module
      // identity vs action path (OpenSource/Conformance/chains); the runner never assumes
      // the legacy scheme.method two-segment shape (a nested chain's call folds there).
      const rest = callee.substring("dsx.module.".length);
      const authoredArgs = isDict(args[0]) ? (args[0] as Dict) : {};
      // Internal framing wins over any authored lookalike. ActionContext.args() hides
      // `__*` keys from whole-object reads while frame-aware modules may request the
      // exact key, the same wire contract used by the native statement runners.
      const argObj = this.env.frameId === undefined
        ? authoredArgs
        : { ...authoredArgs, __frame: this.env.frameId };
      const promise = this.callModuleFunnel(rest, argObj);
      if (awaited) {
        // An awaited module call binds the ENVELOPE, never the raw payload, and never
        // throws — identical to the native runners (Stack.swift continueAwaitPackage /
        // JseRunner.kt): resolve → { ok:true, data }, error → { ok:false, error[, data] }.
        // The same shape `await fetch(...)` already binds, so a portable `.dsx` action
        // (`const r = await dsx.module.x.y(); r.ok ? r.data : r.error`) reads the same on
        // every renderer instead of hitting an undefined `.ok` and aborting on web.
        try {
          const data = await promise;
          return { ok: true, data: data ?? null };
        } catch (e) {
          if (e instanceof ModuleCallError) {
            const env: Dict = { ok: false, error: e.code };
            if (e.data !== null && e.data !== undefined) env.data = e.data;
            return env;
          }
          return { ok: false, error: "error", message: String(e) };
        }
      }
      promise.catch(() => {}); // fire-and-forget: cross-module calls are `try?`
      return null;
    }
    if (callee.startsWith("dsx.state.")) {
      // module-authored markup publishing declared state — routed via the global store
      const name = callee.substring("dsx.state.".length);
      if (name === "set") { DSXState.set(string(args[0]), args[1] ?? null); return null; }
    }
    console.warn(`[dsx runner] unhandled dsx statement: ${callee}`);
    return null;
  }

  private timerStatement(callee: string, toks: Token[], scope: Dict): void {
    const args = this.parseArgs(toks.slice(1), scope);
    const fn = args[0];
    if (!isLambda(fn)) return;
    const interval = callee === "setInterval";
    let ms = safeInt(number(args[1]) ?? 0);
    if (interval) ms = Math.max(ms, 250); // min interval — the reference floor
    const key = args.length > 2 ? string(args[2]) : `__anon_${this.env.timers.size}_${Math.random().toString(36).slice(2)}`;
    const existing = this.env.timers.get(key);
    if (existing) { (existing.interval ? clearInterval : clearTimeout)(existing.id); this.env.timers.delete(key); }
    const fire = (): void => {
      JSE.afterRender(() => {
        void this.invokeLambdaAsAction(fn, scope);
      });
    };
    const id = interval ? setInterval(fire, ms) : setTimeout(() => { this.env.timers.delete(key); fire(); }, ms);
    this.env.timers.set(key, { id, interval });
  }

  /** Timer/handler lambdas run as ACTION bodies (statements, store writes allowed) — a fresh
   *  top-level entry, so it takes the same exclusive lock as run() (a timer must never fire
   *  into the middle of a suspended handler's ledger). */
  private async invokeLambdaAsAction(fn: StackLambda, scope: Dict): Promise<void> {
    if (fn.native) { fn.native([], scope); return; }
    await this.runExclusive(async () => {
      const merged: Dict = { ...fn.captured, ...scope };
      const walker = new StmtWalker(fn.body);
      await this.runStatements(walker, merged, false);
    });
  }

  /** Run an action-event CALLBACK lambda inline within the CURRENT entry — it fires from
   *  inside a running action (dsx.event), so it must NOT take the entry lock (that would
   *  deadlock on the very entry it runs under); it nests under the shared 32-frame action
   *  depth instead, like the native emitEventUp. The payload rides dsx.this. */
  private async runLambdaInline(fn: StackLambda, payload: Dict): Promise<void> {
    if (fn.native) { fn.native([], payload); return; }
    if (this.env.actionDepth >= 32) {
      console.warn("[dsx runner] event callback depth (32) exceeded — contained");
      return;
    }
    const scope: Dict = { ...fn.captured, ...payload };
    const savedFlow = this.flow;
    this.flow = null;
    this.env.actionDepth += 1;
    try {
      await this.runStatements(new StmtWalker(fn.body), scope, false);
    } finally {
      this.env.actionDepth -= 1;
      if (!this.threw()) this.flow = savedFlow;
    }
  }

  private mutateArray(path: string, verb: string, args: unknown[], scope: Dict): void {
    const base = readPath(this.env, scope, path);
    const arr = Array.isArray(base) ? [...base] : [];
    switch (verb) {
      case "push": arr.push(...args.map((a) => a ?? NSNull)); break;
      case "pop": arr.pop(); break;
      case "shift": arr.shift(); break;
      case "unshift": arr.unshift(...args.map((a) => a ?? NSNull)); break;
      case "splice": {
        const start = safeInt(number(args[0]) ?? 0);
        const del = args.length > 1 ? safeInt(number(args[1]) ?? 0) : arr.length - start;
        arr.splice(start, del, ...args.slice(2).map((a) => a ?? NSNull));
        break;
      }
      case "sort": {
        const sorted = JSE.sortedArray(arr, isLambda(args[0]) ? args[0] : null, this.env.store.jse);
        writePath(this.env, scope, path, sorted);
        return;
      }
      default: return;
    }
    writePath(this.env, scope, path, arr);
  }

  /** fetch: / remove: / animate: effect verbs. */
  private async effectVerb(verb: string, toks: Token[], scope: Dict): Promise<void> {
    if (verb === "animate") {
      // animate: key = expr — assign (view transitions ride the CSS layer on web)
      if (toks.length >= 2 && toks[0]!.kind === "ident" && isOpTok(toks[1], "=")) {
        writePath(this.env, scope, toks[0]!.v, await this.evalMaybeAsync(toks.slice(2), scope));
      }
      return;
    }
    if (verb === "remove") {
      // remove: arr where <pred>  |  remove: arr = <value> [key=<field>]
      if (toks.length === 0 || toks[0]!.kind !== "ident") return;
      const path = toks[0]!.v;
      const base = readPath(this.env, scope, path);
      const rows = Array.isArray(base) ? base : [];
      if (isIdentTok(toks[1], "where")) {
        const pred = toks.slice(2);
        const kept = rows.filter((row) => {
          const rowScope = isDict(row) ? { ...scope, ...(row as Dict) } : scope;
          return !truthy(this.evalSync(pred, rowScope));
        });
        writePath(this.env, scope, path, kept);
        return;
      }
      if (isOpTok(toks[1], "=")) {
        // value match on a key field (default id): key=<field> suffix
        let valueToks = toks.slice(2);
        let field = "id";
        const kIdx = valueToks.findIndex((t, i) => t.kind === "ident" && t.v === "key" && isOpTok(valueToks[i + 1], "="));
        if (kIdx >= 0) {
          const f = valueToks[kIdx + 2];
          if (f && f.kind === "ident") field = f.v;
          valueToks = valueToks.slice(0, kIdx);
        }
        const value = this.evalSync(valueToks, scope);
        const kept = rows.filter((row) => !(isDict(row) && JSE.equals((row as Dict)[field], value)));
        writePath(this.env, scope, path, kept);
      }
      return;
    }
    if (verb === "fetch") {
      // fetch: dest = METHOD url [body=expr] [headers=expr]
      if (toks.length < 3 || toks[0]!.kind !== "ident" || !isOpTok(toks[1], "=")) return;
      const dest = toks[0]!.v;
      let i = 2;
      let method = "GET";
      if (toks[i] && toks[i]!.kind === "ident" && /^[A-Z]+$/.test((toks[i]! as { v: string }).v)) {
        method = (toks[i]! as { v: string }).v;
        i += 1;
      }
      // url = everything to `body=`/`headers=` (interpolated string or expression)
      const stop = (t: Token, k: number): boolean =>
        t.kind === "ident" && (t.v === "body" || t.v === "headers") && isOpTok(toks[k + 1], "=");
      const urlToks: Token[] = [];
      while (i < toks.length && !stop(toks[i]!, i)) { urlToks.push(toks[i]!); i += 1; }
      let bodyExpr: Token[] = [];
      let headersExpr: Token[] = [];
      while (i < toks.length) {
        const t = toks[i]!;
        if (t.kind === "ident" && t.v === "body" && isOpTok(toks[i + 1], "=")) {
          i += 2;
          while (i < toks.length && !stop(toks[i]!, i)) { bodyExpr.push(toks[i]!); i += 1; }
        } else if (t.kind === "ident" && t.v === "headers" && isOpTok(toks[i + 1], "=")) {
          i += 2;
          while (i < toks.length && !stop(toks[i]!, i)) { headersExpr.push(toks[i]!); i += 1; }
        } else i += 1;
      }
      let url = string(this.evalSync(urlToks, scope));
      if (url.length === 0 && looksLikeBareUrl(urlToks)) url = rebuildBareUrl(urlToks);
      writePath(this.env, scope, `${dest}.loading`, true);
      writePath(this.env, scope, `${dest}.error`, null);
      try {
        const res = await this.fetchFunnel(url, {
          method,
          body: bodyExpr.length > 0 ? this.evalSync(bodyExpr, scope) : undefined,
          headers: headersExpr.length > 0 ? this.evalSync(headersExpr, scope) : undefined,
        });
        this.env.store.batch(() => {
          writePath(this.env, scope, `${dest}.loading`, false);
          if (isDict(res) && truthy((res as Dict)["ok"])) {
            writePath(this.env, scope, `${dest}.data`, (res as Dict)["data"] ?? null);
          } else {
            const status = number(isDict(res) ? (res as Dict)["status"] : 0) ?? 0;
            writePath(this.env, scope, `${dest}.error`, status > 0 ? `http ${status}` : "network");
          }
        });
      } catch {
        this.env.store.batch(() => {
          writePath(this.env, scope, `${dest}.loading`, false);
          writePath(this.env, scope, `${dest}.error`, "network");
        });
      }
      return;
    }
    console.warn(`[dsx runner] verb ${verb}: not carried to web v1`);
  }

  // ── expression plumbing ────────────────────────────────────────────────────────────

  private evalSync(toks: Token[], scope: Dict): unknown {
    if (toks.length === 0) return null;
    const p = new Parser(toks, this.env.store.jse, scope);
    return p.expression();
  }

  /** Evaluate statement-position expressions: strips a leading `await`, routes
   *  `fetch(…)` / `dsx.module…` / `dsx.event…` to their async implementations, and
   *  awaits any Promise the expression yields. */
  private async evalMaybeAsync(rawToks: Token[], scope: Dict): Promise<unknown> {
    let toks = rawToks;
    let awaited = false;
    if (toks.length > 0 && isIdentTok(toks[0], "await")) { awaited = true; toks = toks.slice(1); }
    if (toks.length >= 2 && toks[0]!.kind === "ident" && isOpTok(toks[1], "(")) {
      const callee = toks[0]!.v;
      const apiDot = callee.indexOf(".");
      if (apiDot > 0) {
        const handle = this.env.apis.get(callee.substring(0, apiDot));
        const verb = callee.substring(apiDot + 1);
        if (handle && ["refresh", "send", "cancel"].includes(verb)) {
          const args = this.parseArgs(toks.slice(1), scope);
          if (verb === "cancel") { handle.cancel(); return null; }
          const p = verb === "refresh" ? handle.refresh() : handle.send(isDict(args[0]) ? (args[0] as Dict) : undefined);
          if (awaited) { try { return await p; } catch { return null; } }
          void (p as Promise<unknown>).catch(() => {});
          return null;
        }
      }
      if (callee === "fetch") {
        const args = this.parseArgs(toks.slice(1), scope);
        return await this.fetchFunnel(string(args[0]), isDict(args[1]) ? (args[1] as Dict) : {});
      }
      if (callee.startsWith("dsx.module.") || callee === "dsx.event" || callee.startsWith("dsx.component.") ||
          callee.startsWith("dsx.action.") || callee === "dsx.send" || callee === "dsx.broadcast" ||
          callee === "dsx.error" || callee === "dsx.log" || callee === "dsx.screen.settled" ||
          callee.startsWith("dsx.state.")) {
        return await this.dsxStatement(callee, toks, scope, awaited);
      }
      //  A BARE ACTION CALL IN EXPRESSION POSITION. `x()` in statement position already
      //  routes here (runJSStatement's named-action branch), but `await x({ … })` and
      //  `const v = await x()` reached the SYNCHRONOUS evaluator, which knows nothing about
      //  declared actions — so the action never ran and its argument object vanished, with
      //  no diagnostic. Actions ARE workflows and the docs tell authors to call them this
      //  way. Both native runners had the same hole — their await matcher claimed only the
      //  `dsx.action.` spelling — and the corpus now pins all three. The object argument
      //  rides `callArgs`, which is applied over the declared inputs: a passed argument
      //  beats the caller-scope reading of the same name, exactly as the statement path
      //  and both twins do it. The BARE form is an ordinary call expression, so its value
      //  is the return value itself; only `await dsx.action.x()` binds the { ok, data }
      //  envelope.
      if (apiDot < 0 && this.env.actions.has(callee)) {
        const callArgs = this.parseArgs(toks.slice(1), scope);
        return await this.callAction(callee, isDict(callArgs[0]) ? (callArgs[0] as Dict) : {}, scope, {});
      }
    }
    // an INTERIOR await (not statement-leading) cannot suspend — the evaluator coerces
    // any live Promise it meets to null; tell the author to restructure
    if (toks.some((t) => t.kind === "ident" && t.v === "await")) {
      console.warn("[dsx runner] interior await is not supported — restructure as `const x = await …` first");
    }
    const v = this.evalSync(toks, scope);
    if (awaited && v instanceof Promise) {
      try { return await v; } catch (e) { this.flow = { kind: "throw", value: String(e) }; return null; }
    }
    if (v instanceof Promise) { v.catch(() => {}); return null; } // un-awaited promise — drop
    return v;
  }

  /** Parse a call's `( … )` argument list from a token slice starting at `(`. */
  private parseArgs(toks: Token[], scope: Dict): unknown[] {
    if (toks.length === 0 || !isOpTok(toks[0], "(")) return [];
    // find the matching close paren
    let d = 0;
    let end = -1;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.kind === "op" && t.v === "(") d += 1;
      else if (t.kind === "op" && t.v === ")") { d -= 1; if (d === 0) { end = i; break; } }
    }
    const inner = toks.slice(1, end < 0 ? toks.length : end);
    // split top-level commas
    const parts: Token[][] = [];
    let cur: Token[] = [];
    let depth = 0;
    for (const t of inner) {
      if (t.kind === "op" && ["(", "[", "{"].includes(t.v)) depth += 1;
      if (t.kind === "op" && [")", "]", "}"].includes(t.v)) depth -= 1;
      if (t.kind === "op" && t.v === "," && depth === 0) { parts.push(cur); cur = []; continue; }
      cur.push(t);
    }
    if (cur.length > 0) parts.push(cur);
    // `...expr` splices the coerced iterable (call-position spread, wave 3)
    const out: unknown[] = [];
    for (const p of parts) {
      if (p.length > 0 && isOpTok(p[0], "...")) out.push(...spreadValues(this.evalSync(p.slice(1), scope)));
      else out.push(this.evalSync(p, scope));
    }
    return out;
  }

  private budgetExceeded(): boolean {
    this.env.loopWork.count += 1;
    const cap = this.env.loopCap ?? LOOP_CAP;
    if (this.env.loopWork.count > cap) {
      console.warn(`[dsx runner] loop budget (${cap}) exceeded — loop contained`);
      return true;
    }
    // The wall clock is checked HERE and nowhere else for the same reason the loop count is:
    // this is the one point every iteration passes through. A deadline enforced only by the
    // caller racing a promise abandons the response while the body keeps burning the isolate.
    const deadline = this.env.deadlineAt;
    return deadline !== undefined && Date.now() > deadline;
  }

  /** THE ONE network funnel. A surface reaches the platform fetch through every guard
   *  `runnerFetch` already applies. A host that runs bodies it did not write binds
   *  `env.egress`, and a refused URL answers the invalid-request shape (status -2) WITHOUT
   *  the request ever leaving the process — which is the property that matters. The refusal
   *  stays distinguishable from an unreachable host (status 0) on purpose: the allowlist is
   *  the author's own declaration, so hiding it from them buys nothing and costs every
   *  debugging session. */
  private fetchFunnel(url: string, opts: Dict): Promise<Dict> {
    const gate = this.env.egress;
    if (gate !== undefined && !gate(url)) return Promise.resolve(REFUSED_FETCH);
    return runnerFetch(url, opts);
  }

  /** THE ONE module funnel: the env's override when a host bound one (the server's
   *  request-scoped table), the global registry otherwise. Both tiers charge the same
   *  call budget, so an escalated body cannot buy calls the interpreter would refuse. */
  private callModuleFunnel(chain: string, args: Dict): Promise<unknown> {
    const budget = this.env.callBudget;
    if (budget !== undefined && ++budget.count > budget.cap) {
      return Promise.reject(new ModuleCallError("budget_exceeded", chain));
    }
    const override = this.env.callModule;
    return override === undefined ? ModuleRegistry.call(chain, args) : override(chain, args);
  }
}

/** Two-way `bind=` writes from input elements — the SAME routing as action
 *  assignments (global./route./cookie./surface), exported for @despia/dom. */
export function writeBound(env: RunEnv, path: string, value: unknown): void {
  writePath(env, env.item ?? {}, path, value);
}

// ── fetch (the runner's network face) ────────────────────────────────────────────────

/** wired by the host for tests / SSR proxying; defaults to the platform fetch. */
export const RunnerFetchSeam = {
  impl: null as ((url: string, init: Dict) => Promise<Dict>) | null,
};

const MAX_RUNNER_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RUNNER_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RUNNER_REQUEST_NODES = 250_000;
const MAX_RUNNER_REQUEST_DEPTH = 128;
const MAX_RUNNER_URL_BYTES = 16 * 1024;
const MAX_RUNNER_HEADER_BYTES = 64 * 1024;
const MAX_RUNNER_HEADER_COUNT = 100;

class RunnerFetchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function runnerUtf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function runnerEscapedJsonBytes(value: string, limit: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code <= 0x1f) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** Bound authored fetch bodies before JSON.stringify can recurse or allocate an
 * unbounded intermediate value on the UI thread. */
function prepareRunnerBody(rawBody: unknown): string | undefined {
  if (rawBody === undefined || rawBody === null) return undefined;
  if (typeof rawBody === "string") {
    if (rawBody.length > MAX_RUNNER_REQUEST_BYTES
      || runnerUtf8Bytes(rawBody, MAX_RUNNER_REQUEST_BYTES) > MAX_RUNNER_REQUEST_BYTES) {
      throw new RunnerFetchError("request_too_large");
    }
    return rawBody;
  }

  type Frame = { value?: unknown; depth: number; exit?: object };
  const stack: Frame[] = [{ value: rawBody, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const add = (count: number): void => {
    bytes += count;
    if (bytes > MAX_RUNNER_REQUEST_BYTES) throw new RunnerFetchError("request_too_large");
  };
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit !== undefined) {
      ancestors.delete(frame.exit);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_RUNNER_REQUEST_NODES || frame.depth > MAX_RUNNER_REQUEST_DEPTH) {
      throw new RunnerFetchError("request_too_complex");
    }
    const next = frame.value;
    if (next === null || next === undefined || next === NSNull) add(4);
    else if (typeof next === "string") add(runnerEscapedJsonBytes(next, MAX_RUNNER_REQUEST_BYTES - bytes));
    else if (typeof next === "number") add(Number.isFinite(next) ? String(next).length : 4);
    else if (typeof next === "boolean") add(next ? 4 : 5);
    else if (Array.isArray(next)) {
      if (ancestors.has(next)) throw new RunnerFetchError("invalid_request");
      ancestors.add(next);
      add(2 + Math.max(0, next.length - 1));
      stack.push({ depth: frame.depth, exit: next });
      for (let index = next.length - 1; index >= 0; index -= 1) {
        stack.push({ value: next[index], depth: frame.depth + 1 });
      }
    } else if (isDict(next)) {
      if (ancestors.has(next)) throw new RunnerFetchError("invalid_request");
      ancestors.add(next);
      const entries = Object.entries(next as Dict);
      add(2 + Math.max(0, entries.length - 1));
      stack.push({ depth: frame.depth, exit: next });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, entryValue] = entries[index]!;
        add(runnerEscapedJsonBytes(key, MAX_RUNNER_REQUEST_BYTES - bytes) + 1);
        stack.push({ value: entryValue, depth: frame.depth + 1 });
      }
    } else throw new RunnerFetchError("invalid_request");
  }

  const encoded = JSON.stringify(rawBody, (_key, value: unknown) => (value === NSNull ? null : value));
  if (encoded === undefined) throw new RunnerFetchError("invalid_request");
  if (runnerUtf8Bytes(encoded, MAX_RUNNER_REQUEST_BYTES) > MAX_RUNNER_REQUEST_BYTES) {
    throw new RunnerFetchError("request_too_large");
  }
  return encoded;
}

function validateRunnerRequest(url: string, headers: Dict): void {
  if (runnerUtf8Bytes(url, MAX_RUNNER_URL_BYTES) > MAX_RUNNER_URL_BYTES) {
    throw new RunnerFetchError("request_too_large");
  }
  const entries = Object.entries(headers).filter(([name]) => !name.startsWith("__"));
  if (entries.length > MAX_RUNNER_HEADER_COUNT) throw new RunnerFetchError("request_too_large");
  let bytes = 0;
  for (const [name, value] of entries) {
    bytes += runnerUtf8Bytes(name, MAX_RUNNER_HEADER_BYTES - bytes)
      + runnerUtf8Bytes(string(value), MAX_RUNNER_HEADER_BYTES - bytes) + 4;
    if (bytes > MAX_RUNNER_HEADER_BYTES) throw new RunnerFetchError("request_too_large");
  }
}

async function readRunnerResponse(res: Response): Promise<Uint8Array> {
  const advertised = Number(res.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_RUNNER_RESPONSE_BYTES) {
    try { await res.body?.cancel("response_too_large"); } catch { /* already closed */ }
    throw new RunnerFetchError("response_too_large");
  }
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RUNNER_RESPONSE_BYTES) {
      try { await reader.cancel("response_too_large"); } catch { /* already closed */ }
      throw new RunnerFetchError("response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function runnerHttpsDowngrade(requestUrl: string, responseUrl: string): boolean {
  if (responseUrl.length === 0) return false;
  try {
    const base = typeof location !== "undefined" ? location.href : undefined;
    return new URL(requestUrl, base).protocol === "https:" && new URL(responseUrl).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * THE NETWORK MACHINE IS OPTIONAL (the `__DSX_OPTIONAL_JS_GLOBALS__` precedent in jse/core.ts).
 *
 * `runnerFetchFull` below is ~9 KB of source — the request guards, the body encoder with its
 * node/depth/byte ceilings, the header validator, the response reader and the https-downgrade
 * check. All of it is mandatory for a body that reaches the network and DEAD WEIGHT for one
 * that does not, which is most self-contained embeds: a card that renders a component has no
 * `fetch(` and no `fetch:` verb anywhere in its bodies.
 *
 * The bundler folds the flag and drops the whole machine with its helpers, because this is its
 * only reference. A build that does not set the flag keeps everything, so the default is the
 * full runtime and only a build that has PROVEN the absence pays nothing.
 */
const runnerFetch: (url: string, opts: Dict) => Promise<Dict> =
  (globalThis as typeof globalThis & { __DSX_OPTIONAL_FETCH__?: boolean })
    .__DSX_OPTIONAL_FETCH__ !== false
    ? runnerFetchFull
    : () => Promise.resolve(REFUSED_FETCH);

async function runnerFetchFull(url: string, opts: Dict): Promise<Dict> {
  const method = string(opts["method"] ?? "GET") || "GET";
  const headers: { [k: string]: string } = {};
  if (isDict(opts["headers"])) {
    for (const [k, v] of Object.entries(opts["headers"] as Dict)) {
      if (!k.startsWith("__")) headers[k] = string(v);
    }
  }
  let body: string | undefined;
  try {
    validateRunnerRequest(url, isDict(opts["headers"]) ? opts["headers"] as Dict : {});
    body = prepareRunnerBody(opts["body"]);
    if (body !== undefined && typeof opts["body"] !== "string"
      && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  } catch (error) {
    return { ok: false, status: -2, data: null, error: (error as { code?: string }).code ?? "invalid_request" };
  }

  // Host seams receive the authored shape for backwards compatibility, but only
  // after the same request guard as the real transport has accepted it.
  if (RunnerFetchSeam.impl) return RunnerFetchSeam.impl(url, opts);

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      return { ok: false, status: -1, aborted: true, data: null };
    }
    return { ok: false, status: 0, data: null, error: "network" };
  }

  const outHeaders: Dict = {};
  res.headers.forEach((value, key) => { outHeaders[key] = value; });
  if (runnerHttpsDowngrade(url, res.url)) {
    try { await res.body?.cancel("insecure_redirect"); } catch { /* already closed */ }
    return { ok: false, status: -2, data: null, headers: outHeaders, error: "insecure_redirect" };
  }

  try {
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const bytes = await readRunnerResponse(res);
    const text = new TextDecoder().decode(bytes);
    let data: unknown;
    if (contentType.includes("json")) {
      data = text.length > 0 ? JSON.parse(text) : null;
    } else data = text;
    return { ok: res.ok, status: res.status, data, headers: outHeaders };
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      return { ok: false, status: -1, aborted: true, data: null, headers: outHeaders };
    }
    return {
      ok: false,
      status: -2,
      data: null,
      headers: outHeaders,
      error: (error as { code?: string }).code ?? "invalid_response",
    };
  }
}

// ── statement token walker (shared shape with JSEval) ────────────────────────────────

class StmtWalker {
  i = 0;
  readonly t: Token[];
  constructor(t: Token[]) {
    this.t = t;
  }
  cur(): Token | null { return this.i < this.t.length ? this.t[this.i]! : null; }

  capture(stops: Set<string>): Token[] {
    const out: Token[] = [];
    let d = 0;
    for (;;) {
      const tk = this.cur();
      if (tk === null) break;
      if (tk.kind === "op") {
        const o = tk.v;
        if (["(", "[", "{"].includes(o)) { d += 1; out.push(tk); this.i += 1; continue; }
        if ([")", "]", "}"].includes(o)) { if (d === 0) break; d -= 1; out.push(tk); this.i += 1; continue; }
        if (d === 0 && stops.has(o)) break;
      }
      out.push(tk);
      this.i += 1;
    }
    return out;
  }

  captureParen(): Token[] {
    const out: Token[] = [];
    if (!isOpTok(this.cur() ?? undefined, "(")) return out;
    this.i += 1;
    let d = 1;
    for (;;) {
      const tk = this.cur();
      if (tk === null) break;
      if (tk.kind === "op" && tk.v === "(") d += 1;
      else if (tk.kind === "op" && tk.v === ")") { d -= 1; if (d === 0) { this.i += 1; break; } }
      out.push(tk);
      this.i += 1;
    }
    return out;
  }

  skipBranch(): void {
    if (isOpTok(this.cur() ?? undefined, "{")) {
      let d = 0;
      for (;;) {
        const tk = this.cur();
        if (tk === null) return;
        if (tk.kind === "op" && tk.v === "{") d += 1;
        else if (tk.kind === "op" && tk.v === "}") { d -= 1; this.i += 1; if (d === 0) return; continue; }
        this.i += 1;
      }
    } else {
      for (;;) {
        const tk = this.cur();
        if (tk === null) return;
        if (tk.kind === "op" && tk.v === ";") { this.i += 1; return; }
        if (tk.kind === "op" && tk.v === "}") return;
        this.i += 1;
      }
    }
  }

  /** skip a full `if (…) branch [else if … else branch]` chain */
  skipIfChain(): void {
    if (!isIdentTok(this.cur() ?? undefined, "if")) return;
    this.i += 1;
    this.captureParen();
    this.skipBranch();
    if (isIdentTok(this.cur() ?? undefined, "else")) {
      this.i += 1;
      if (isIdentTok(this.cur() ?? undefined, "if")) this.skipIfChain();
      else this.skipBranch();
    }
  }

  /** inside a switch body: skip one statement of a non-matching case */
  skipCaseStatement(): void {
    const tk = this.cur();
    if (tk === null) return;
    if (isIdentTok(tk, "case") || isIdentTok(tk, "default") || isOpTok(tk, "}")) {
      // handled by the switch loop
      if (isIdentTok(tk, "case")) { this.i += 1; this.capture(new Set([":"])); if (isOpTok(this.cur() ?? undefined, ":")) this.i += 1; }
      else if (isIdentTok(tk, "default")) { this.i += 1; if (isOpTok(this.cur() ?? undefined, ":")) this.i += 1; }
      return;
    }
    if (isOpTok(tk, "{")) { this.skipBranch(); return; }
    if (isIdentTok(tk, "if")) { this.skipIfChain(); return; }
    this.capture(new Set([";"]));
    if (isOpTok(this.cur() ?? undefined, ";")) this.i += 1;
  }

  skipToBlockEnd(): void {
    let d = 1;
    for (;;) {
      const tk = this.cur();
      if (tk === null) return;
      if (tk.kind === "op" && tk.v === "{") d += 1;
      else if (tk.kind === "op" && tk.v === "}") { d -= 1; this.i += 1; if (d === 0) return; continue; }
      this.i += 1;
    }
  }

  skipFunction(): void {
    for (;;) {
      const tk = this.cur();
      if (tk === null) return;
      if (tk.kind === "op" && tk.v === "{") break;
      this.i += 1;
    }
    this.skipBranch();
  }
}

export { tokenize };
