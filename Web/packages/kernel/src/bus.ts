//
//  bus.ts - the DSX native message bus, web twin: modules provide, surfaces consume.
//  Mirrors Module.kt / Context.kt in contract: a scheme+alias ROUTE TABLE (one module
//  may answer several schemes — dsx.json `aliases` ride the generated registration,
//  the GeneratedModuleSchemes twin), envelope error codes from
//  OpenSource/Conformance/api/wire-contract.json (not_loaded / unsupported_platform),
//  fire/hook/claim/collect, declared state under `global.<scheme>.<var>`.
//
//  Constitution: the kernel names no module — everything arrives through register().
//  Export-presence is the web's file-presence gate (/web/03): a module without a web
//  entry is `dsx.has() === false`, never a crash.
//
//  Diagnostics: EVERY call failure (excluded / not_loaded / unsupported_platform /
//  unknown_action / a handler's error settle) reports to the ONE funnel before rejecting — a console.warn
//  plus the `module.callFailed` bus event ({ scheme, action, code, data?, delivered }) —
//  the three-renderer contract shared with Context.swift / Context.kt. `.post` failures
//  are `delivered: false`: the call site discards the rejection by shape, so the funnel
//  is the only place they can surface. Nothing on the bus fails invisibly.
//

import { DSXState } from "./store.ts";
import { JSESeams, isDesktopOS } from "./jse/jse.ts";
import { NSNull, isDict, string, truthy, type Dict } from "./jse/values.ts";
import { DSXLogs, reportLog, type DSXLogEntry } from "./logs.ts";
import { formatLogArgs } from "./jse/core.ts";

// ── envelopes (wire contract v3) ─────────────────────────────────────────────────────

export type Envelope = {
  id: string | null;
  scheme: string;
  host: string;
  event: string; // "result" | "error" | stream event name
  final: boolean;
  data: unknown;
  code: string | null;
  recoverable: boolean | null;
  message: string | null;
};

export class ModuleCallError extends Error {
  readonly code: string;
  readonly data: unknown;
  constructor(code: string, message: string, data: unknown = null) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// ── the CLIENT LINK: rung two of the resolution ladder ──────────────────────────────────
//
// facet-contracts.md: "a call resolves local → declared reach over the link → typed
// `unavailable`". Rung one (local) and rung three (typed absence) have always been here; this is
// the middle one. `dsx.module.orders.create()` runs a local action if the build has one, and
// otherwise reaches the server node that declared it — WITHOUT the caller ever spelling a route.
// That is the whole point: the same markup ships on every surface, and moving an action between
// client and server changes no call site.
//
// THE KERNEL NAMES NO TRANSPORT. `routes` is build data (the emitted client link table) and
// `invoke` is filled by whoever boots the surface — the empty-seam discipline used for
// `RunnerFetchSeam` and the server's `RepoSeam`. An unfilled seam is not a failure mode: with no
// transport the ladder falls through to exactly the typed absence it answered before, so adding
// a link to the kernel changes nothing for a build that has none.
//
// THE TABLE IS THE GATEWAY. `prepare_server.rb` omits every row whose action reaches no client
// surface, so an internal endpoint is not nameable here — the build-time twin of the 404 the
// host answers a non-service caller. The kernel does not re-derive that decision; it consumes it.

/** One client-reachable server route (generated/link.ts — `despia:client-link@1`). */
export interface LinkRoute {
  chain: string;
  action: string;
  method: string;
  path: string;
  auth?: string;
  reach?: readonly string[];
}

export const LinkSeam = {
  /** the emitted client link table; empty until a surface installs it */
  routes: [] as readonly LinkRoute[],
  /** the platform transport; null = no link, and the ladder falls through unchanged */
  invoke: null as ((route: LinkRoute, args: Dict) => Promise<unknown>) | null,
};

/** `unreachable` — the frozen pass-through spelling (durability P4, errors corpus). */
export const ERROR_UNREACHABLE = "unreachable";

export const ERROR_NOT_LOADED = "not_loaded";
export const ERROR_UNSUPPORTED_PLATFORM = "unsupported_platform";
/** typed absence (durability.md P4): this build dropped the module — the split out of
 *  not_loaded, driven by the build-excluded overlay (errors corpus) */
export const ERROR_EXCLUDED = "excluded";
/** the caller named an action the LOCAL module does not register — a caller bug, never absence */
export const ERROR_UNKNOWN_ACTION = "unknown_action";
/** typed absence (durability.md P4): the capability row PROMISES a local implementation on
 *  this facet and nothing stood it up (an unlinked framework, an OS floor, a dropped
 *  companion) — a different fact from "never here" and from "this build dropped it" */
export const ERROR_PREREQUISITES_MISSING = "prerequisites_missing";

// ── the FACET RESOLUTION LADDER (facet-contracts.md; corpus OpenSource/Conformance/facets) ──
//
// "A call resolves local → declared `reach` over the link → typed `unavailable`. The caller
// never spells the route; markup ships identically on every surface."
//
// THE KERNEL KNOWS NO FACET WORD. A runtime binds one registered word (`FacetSeam.facet`) and
// consumes a compiled capability table (`FacetSeam.rows`), both build data — exactly the
// empty-seam discipline `LinkSeam` uses. An UNBOUND runtime with an empty table answers what
// the funnel answered before the ladder existed: every facet-dependent rung is skipped, and
// the build-fact rungs (`excluded` / `not_loaded`) remain. That is what lets this land in a
// kernel whose build has no facets yet — an unfilled seam is not a failure mode.

/** One compiled capability row: the generated per-facet twin of an action's manifest contract. */
export interface FacetRow {
  /** the facets whose runtime implements this action LOCALLY */
  readonly provides: readonly string[];
  /** the facets that may invoke it OVER THEIR LINK. Fail-closed: absent admits nobody,
   *  explicit `false` is the deny (facet-contracts.md — "a call a table doesn't admit
   *  never fires"). */
  readonly reach?: readonly string[] | false;
}

/** chain → action → row. Exclusion-BLIND, like the platform catalog: a row survives its
 *  module being dropped, so absence is attributed instead of guessed. */
export type FacetTable = { readonly [chain: string]: { readonly [action: string]: FacetRow } };

export const FacetSeam = {
  /** the registered facet word THIS runtime binds; null = unbound (the honest default) */
  facet: null as string | null,
  /** the compiled capability table; empty until a build installs it */
  rows: {} as FacetTable,
  /** the reach transport; null = no link, and the ladder answers the typed `unreachable`
   *  instead of hanging (facet-contracts.md: absence is load-bearing) */
  invoke: null as ((call: { chain: string; action: string; facet: string }, args: Dict) => Promise<unknown>) | null,
};

/** The ladder's answer: the rung, and — for `unavailable` — exactly one frozen spelling
 *  from the corpus `codes` list. `via` names which transport rung two chose. */
export type FacetVerdict = {
  rung: "local" | "reach" | "unavailable";
  code: string | null;
  via: "facet" | "link" | null;
};

/** Everything the ladder is allowed to know, as FACTS rather than a lazy interface — the
 *  caller resolves them once, the corpus states them literally, and nothing here can reach
 *  back into a registry. Cheap by construction: eight fields, no closures. */
export type FacetFacts = {
  /** a registered module answers THIS action here */
  local: boolean;
  /** a module is registered for this chain (even if it does not answer this action) */
  module: boolean;
  /** the registered facet word this runtime binds; null = unbound */
  facet: string | null;
  /** the compiled capability row for this call, or null */
  row: FacetRow | null;
  /** a reach transport is installed */
  transport: boolean;
  /** a generated CLIENT-LINK route exists for this call AND its transport is installed */
  linked: boolean;
  /** the chain is in the build-excluded overlay */
  excluded: boolean;
  /** the platform catalog knows this scheme but not on this OS (the X-tier) */
  offPlatform: boolean;
  /** the platform catalog knows THIS ACTION and its manifest declares it off this OS
   *  (X2 §4 `platforms`). Separate from `offPlatform` because it OUTRANKS `unknown_action`:
   *  the module can be registered and correct here and still not run this action, and
   *  `unknown_action` names a caller bug the caller did not commit. Optional — a fact set
   *  only where an action-level row exists, so every existing construction is unchanged. */
  offPlatformAction?: boolean;
};

/** The action catalog's key. The manifest spells a nested action path with dots and the wire
 *  spells it with slashes, so both fold to one spelling here rather than at each call site. */
export function actionPlatformKey(chain: string, action: string): string {
  return `${chain.toLowerCase()}.${action.toLowerCase().replace(/\//g, ".")}`;
}

/**
 * THE LADDER, pure (`OpenSource/Conformance/facets/facets.json` drives exactly this):
 *
 *  1. **local** — a registered module answering this action wins before anything else is
 *     consulted, so a partly-local chain never pays for the table.
 *  2. **reach** — the row admits THIS facet ⇒ over the link; admitted with no transport ⇒
 *     the typed `unreachable`, never a hang. A generated client-link route is the same rung.
 *  3. **typed unavailable** — the reason IS the code (durability.md P4). Precedence is frozen
 *     by the shipped funnels and deliberate: `unknown_action` (the module IS here — a caller
 *     bug, not absence — but an ACTION the catalog declares off this platform outranks even
 *     that, since the caller asked for something declared impossible) > `unsupported_platform`
 *     (the platform catalog, then the row that
 *     neither provides nor reaches us — the NEVER-ON-THIS-FACET class, which keeps its
 *     shipping name; the draft spelling `never_on_facet` is retired) > `excluded` (a build
 *     fact beats a runtime one) > `prerequisites_missing` (the row promised a local
 *     implementation nothing stood up) > `not_loaded` (nothing known at all).
 */
export function resolveFacetLadder(f: FacetFacts): FacetVerdict {
  if (f.local) return { rung: "local", code: null, via: null };
  const reached = facetReach(f);
  if (reached !== null) return reached;
  if (f.linked) return { rung: "reach", code: null, via: "link" };

  let code = ERROR_NOT_LOADED;
  // The ACTION-level narrowing sits AHEAD of `unknown_action` — the one rung that can be
  // true while the module itself is present. Everything below it keeps the frozen order.
  if (f.offPlatformAction === true) code = ERROR_UNSUPPORTED_PLATFORM;
  else if (f.module) code = ERROR_UNKNOWN_ACTION;
  else if (f.offPlatform) code = ERROR_UNSUPPORTED_PLATFORM;
  else code = facetAbsence(f) ?? (f.excluded ? ERROR_EXCLUDED : ERROR_NOT_LOADED);
  return { rung: "unavailable", code, via: null };
}

// THE FOLD. The two functions below carry every facet-dependent rung, and each opens with
// the `__DSX_OPTIONAL_LINK__` guard the client link already rides — false in any bundle
// built with no peer node (every embed slice). Such a surface binds no facet word and
// installs no transport, so it can never take a facet rung; esbuild turns each guard into
// `if (true) return null`, drops the bodies, and the surface pays nothing for a ladder it
// cannot climb. Nothing is duplicated — the rungs live here once, and `resolveFacetLadder`
// reads as the whole law either way. (The guard is an early RETURN, not a folded local:
// esbuild constant-folds a condition, it does not propagate a `const` into later ones.)

/** Rung two, facet half: the row admits THIS facet ⇒ over the link; admitted with no
 *  transport ⇒ the typed `unreachable`, never a hang. `null` = not our rung. */
function facetReach(f: FacetFacts): FacetVerdict | null {
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_LINK__?: boolean })
    .__DSX_OPTIONAL_LINK__ === false) return null;
  const facet = f.facet;
  const reach = f.row?.reach;
  // fail-closed: absent `reach` admits nobody, explicit `false` is the deny
  if (facet === null || !Array.isArray(reach) || !reach.includes(facet)) return null;
  return f.transport
    ? { rung: "reach", code: null, via: "facet" }
    : { rung: "unavailable", code: ERROR_UNREACHABLE, via: null };
}

/** The three FACET-seam facts, read once per call. Folded like its siblings: a peer-less
 *  bundle answers the unbound triple without ever touching `FacetSeam`, which then has no
 *  live reference left and drops out of the bundle entirely. */
function facetSeamFacts(chain: string, action: string): Pick<FacetFacts, "facet" | "row" | "transport"> {
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_LINK__?: boolean })
    .__DSX_OPTIONAL_LINK__ === false) return { facet: null, row: null, transport: false };
  const rows = FacetSeam.rows[chain];
  return {
    facet: FacetSeam.facet,
    row: rows === undefined ? null : (rows[action] ?? rows[action.toLowerCase()] ?? null),
    transport: FacetSeam.invoke !== null,
  };
}

/** Rung three, facet half — evaluated between the platform catalog and the excluded overlay,
 *  which is exactly the frozen precedence: a row that neither provides nor reaches us is
 *  NEVER-ON-THIS-FACET and outranks `excluded`, while a row that promises a local
 *  implementation yields to `excluded` (a build fact beats a runtime one) by answering null. */
function facetAbsence(f: FacetFacts): string | null {
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_LINK__?: boolean })
    .__DSX_OPTIONAL_LINK__ === false) return null;
  const facet = f.facet;
  const row = f.row;
  if (facet === null || row === null) return null;
  if (!row.provides.includes(facet)) return ERROR_UNSUPPORTED_PLATFORM;
  return f.excluded ? null : ERROR_PREREQUISITES_MISSING;
}

// ── the error system (architecture/proposals/error-system.md, ACCEPTED v1) ───────────
//
// Errors are VALUES on the bus: one shape, recorded in ONE ledger, regardless of whether
// they came from a failed call (origin "call", fed by reportCallFailure) or an ambient
// emission (origin "raised" — `dsx.error`/`dsx.fail` on the module handle, where there is
// no call to settle). The ledger is a capped ring (the KernelLogBuffer pattern, but values
// instead of lines), always on: appending a record is nanoseconds and programs — not just
// testers — read it (`dsx.errors.recent()`, the reactive `global.dsx.*` keys, DevSettings).

/** One recorded error — the wire shape plus ledger metadata. */
export type DSXErrorEntry = {
  code: string;
  message: string | null;
  recoverable: boolean;
  data: unknown;
  /** the SOURCE scheme (whose error this is) */
  scheme: string;
  /** "raised" (ambient emission) | "call" (a failed bus call) | "uncaught" (a throw that
   *  unwound a markup action to the top with no catch) | "root" (a root-plan boot attempt
   *  failure — the fold consumes it and advances the plan; root-plan.md §failure attribution) */
  origin: "raised" | "call" | "uncaught" | "root";
  /** origin "call" only — false = fire-and-forget: the call site never saw the error */
  delivered?: boolean;
  at: number;
};

class DSXErrorLedgerImpl {
  static readonly cap = 128;
  private entries: DSXErrorEntry[] = [];
  private total = 0;

  append(e: DSXErrorEntry): void {
    this.entries.push(e);
    this.total += 1;
    if (this.entries.length > DSXErrorLedgerImpl.cap) {
      this.entries.splice(0, this.entries.length - DSXErrorLedgerImpl.cap);
    }
  }
  /** the retained tail, oldest → newest (snapshot) */
  recent(): DSXErrorEntry[] { return [...this.entries]; }
  /** monotonic count of every error ever recorded (survives ring eviction) */
  count(): number { return this.total; }
  /** dev tooling only — drops the retained tail (the monotonic count stays) */
  clear(): void { this.entries = []; }
}

export const DSXErrors = new DSXErrorLedgerImpl();

// ── module authoring surface (web adapters) ──────────────────────────────────────────

export type ActionContext = {
  /** smart-typed argument read (NSNull → null) */
  args(key?: string): unknown;
  /** the scheme the call arrived on (a dsx.json alias, or the primary) and the action host —
   *  the web twin of the native `dsx.action.scheme` (NOT `dsx.command()?.scheme`, which on the
   *  native structured faces is the synthesized `dsx-call` carrier), so a catch-all handler
   *  (`actions["*"]`) can route a legacy bare-alias call (e.g. `shareapp` → the share action). */
  scheme: string;
  action: string;
  /** terminal: success (first terminal wins) */
  resolve(data?: unknown): void;
  /** terminal: structured error */
  error(code?: string, data?: unknown): void;
  fail(code: string, message?: string, recoverable?: boolean, data?: unknown): void;
  /** non-terminal stream event */
  event(name: string, value?: unknown): void;
  /** cross-package broadcast */
  broadcast(name: string, value?: unknown): void;
  /** the bound bus handle (modules reach other modules ONLY through this) */
  dsx: DsxContext;
};

export type ActionHandler = (ctx: ActionContext) => unknown | Promise<unknown>;

export type WebModule = {
  scheme: string;
  /** action table: host name (lowercased on dispatch) → handler. The special key `"*"` is a
   *  catch-all invoked when no named action matches — the web analogue of a native catch-all
   *  facet (it reads `ctx.scheme`/`ctx.action` to route a legacy bare-alias call). */
  actions: { [name: string]: ActionHandler };
  /** declared live state defaults — published under `global.<scheme>.<var>` */
  state?: Dict;
  /** bus hooks: event name → handler (claim answers by returning non-null) */
  hooks?: { [event: string]: (input: unknown) => unknown };
  /** boot hook — runs at register time (the web "module load") */
  boot?: (dsx: DsxContext) => void;
  /** exported object handles (dsx.module.<scheme>.object(name)) */
  objects?: { [name: string]: () => unknown };
  /** module-provided COMPONENTS (/web/18): Capitalized name → the platform facet
   *  implementation. Stored OPAQUELY — the kernel names no DOM (the renderer owns
   *  the mount contract, @despia-native/dom facet.ts); resolution rides facetComponent(). */
  components?: { [name: string]: unknown };
};

export function defineModule(m: WebModule): WebModule {
  return m;
}

// ── module-identity chains (OpenSource/Conformance/chains — the frozen contract) ─────
//
// A module's identity is its dotted CHAIN (watch.health) derived from Modules/ nesting;
// the chain is both the API face (dsx.module.watch.health.heartRate) and the wire scheme
// token (watch.health://heartRate). Resolution is the incremental FOLD at the ONE
// dispatch funnel — never dot-counting, never a first-dot split: normalize the arriving
// HEAD through the alias map to its primary chain, then while chain + "." + next is in
// the IDENTITY SET (registered chains ∪ build-excluded chains — the honest universe),
// fold that segment into the chain; the remainder is the action path (empty = the bare
// call). A leading RESERVED word in the remainder routes to the MEMBER plane, never an
// action. The build-time bidirectional ban (a child segment can never equal a parent
// action/group first-segment or a reserved member) is what makes the fold total.

/** The reserved MEMBER words — never actions. CLOSED and FROZEN (chains corpus):
 *  growth is a major-version event. */
export const RESERVED_MEMBERS: ReadonlySet<string> = new Set([
  "on", "available", "excluded", "state", "context", "object", "delegate", "dsx", "then",
]);

/** R1 PROXY SAFETY (chains corpus proxySafety): a property get of any of these names —
 *  or ANY Symbol — on a module/member proxy returns undefined, so `await proxy` never
 *  half-calls (no `then`), JSON.stringify never fires a phantom call (no `toJSON`;
 *  functions serialize as nothing), and console/inspect never dispatch. */
export const PROXY_DENYLIST: ReadonlySet<string> = new Set([
  "then", "toString", "valueOf", "toJSON", "constructor", "__proto__",
]);

/** The identity-table view the fold resolves against — the live one comes from the
 *  registry (chainTable()); the conformance runner builds one from the corpus fixture. */
export type ChainTable = {
  /** chain ∈ the identity set: registered PRIMARY chains ∪ build-excluded chains
   *  (alias route keys are spellings, not identities — consulted at head only). */
  isIdentity(chain: string): boolean;
  /** alias → its primary chain (HEAD position only); null when the head is no alias. */
  aliasTarget(head: string): string | null;
  /** chain ∈ the build-excluded overlay. */
  isExcluded(chain: string): boolean;
};

export type ChainResolution = {
  /** the resolved primary identity (lowercase dotted chain) */
  chain: string;
  /** the scheme AS CALLED — the alias token on an alias call, else the chain as it
   *  arrived (ctx.scheme / error attribution echo this; identity stays `chain`) */
  spelling: string;
  /** the remaining action path segments, case preserved ([] = the bare call) */
  action: string[];
  /** the reserved-member route (the leading remainder token), or null — never an action */
  member: string | null;
  /** the remainder after the member ([] when none) */
  rest: string[];
  /** chain ∈ the identity set (false = module_not_found attribution against the head) */
  known: boolean;
  /** identity resolved through the excluded overlay */
  excluded: boolean;
};

/** The corpus fold, pure. `segments` carry the caller's natural segmentation: the
 *  dotted-callee face splits on dots (head = the first segment); the wire face passes
 *  its scheme token as ONE head segment (a legacy hyphenated alias, or an already-dotted
 *  chain token) plus the action-path segments. */
export function resolveChain(segments: readonly string[], table: ChainTable): ChainResolution {
  const parts = segments.filter((s) => s.length > 0);
  const head = parts[0] ?? "";
  const aliased = table.aliasTarget(head.toLowerCase());
  let chain = aliased ?? head.toLowerCase();
  let spelling = head;
  let i = 1;
  while (i < parts.length && table.isIdentity(`${chain}.${parts[i]!.toLowerCase()}`)) {
    chain = `${chain}.${parts[i]!.toLowerCase()}`;
    // the arriving spelling tracks the folded segments — unless the head was an alias,
    // whose single token stays the spelling (legacy grammar arrives as one word)
    if (aliased === null) spelling = `${spelling}.${parts[i]!}`;
    i += 1;
  }
  const remainder = parts.slice(i);
  const known = chain.length > 0 && table.isIdentity(chain);
  const excluded = table.isExcluded(chain);
  const first = remainder[0] ?? "";
  if (first.length > 0 && RESERVED_MEMBERS.has(first.toLowerCase())) {
    return { chain, spelling, action: [], member: first.toLowerCase(), rest: remainder.slice(1), known, excluded };
  }
  return { chain, spelling, action: remainder, member: null, rest: [], known, excluded };
}

// ── the registry ─────────────────────────────────────────────────────────────────────

type Hook = { event: string; priority: number; fn: (input: unknown) => unknown };

/** How a delegate fold combines its listeners' answers — the twin of the natives'
 *  `ModuleRegistry.Combine` (Module.kt / Module.swift), same five cases and same
 *  meanings. This IS the difference the four deleted legacy verbs used to encode. */
export type Combine = "void" | "any" | "claim" | "collect" | "veto";

class ModuleRegistryImpl {
  private modules = new Map<string, WebModule>();
  private hooks: Hook[] = [];
  /** the build-excluded overlay (facet-contracts.md build visibility): chain → its
   *  DespiaExcluded-shaped entry. Part of the fold's identity set so an excluded child
   *  still resolves for attribution — never a phantom action on its parent. */
  private excludedIdentities = new Map<string, { reason: "excluded" } | { reason: "cascade"; from: string }>();
  /** legacy alias spelling → the excluded chain it belongs to (excludedFact answers). */
  private excludedAliases = new Map<string, string>();
  /** schemes whose CURRENT registrant arrived via `register(…, { fallback: true })` —
   *  a later provided module replaces it and clears the mark; a later fallback may too. */
  private fallbackSchemes = new Set<string>();
  /** platform catalog — schemes that exist in the product but not on this OS (X-tier),
   *  each mapped to the platforms that DO implement it. Populated from the build manifest
   *  (`setPlatformSupport`) so `unsupported_platform` is honest. PRE-FILTERED by design: a
   *  chain is in this map only when the current OS is absent from its list, which is what
   *  lets `offPlatform` be a `.has()` and the ladder stay a pure function of facts. */
  readonly unsupportedPlatforms = new Map<string, string[]>();
  /** the same, keyed "<chain>.<action>" — the actions whose manifest NARROWS their module's
   *  platform set (X2 §4). Sparse: an action with no narrowing has no row and inherits. */
  readonly unsupportedActionPlatforms = new Map<string, string[]>();
  /** module-call diagnostics funnel: true while `module.callFailed` hooks are delivering
   *  (fire is synchronous), so a hook whose own body makes a failing call can't feed the
   *  funnel its own output (fire → hook → failing call → fire → …). */
  private reportingCallFailure = false;

  /** EVERY module-call failure lands here — the web twin of Context.reportCallFailure
   *  (Swift/Kotlin): a console.warn (the web's kernelLog), a LEDGER entry (origin "call" —
   *  the error system's unified record, error-system.md §3.3a), and the `module.callFailed`
   *  bus event, payload { scheme, action, code, data?, delivered } — the global observer
   *  seam (`dsx.delegate.listen("module.callFailed")`) for dev tooling. `delivered: false` marks a
   *  `.post` (fire-and-forget) failure: the call site discarded the rejection by shape,
   *  so this funnel is the only place it can surface. Observing never swallows — the
   *  awaited caller still gets the typed ModuleCallError rejection. `message`/`recoverable`
   *  arrive from the handler's own `fail(...)` when it authored them (full fidelity in the
   *  record even where the caller envelope stays narrow). */
  private reportCallFailure(scheme: string, action: string, code: string, data: unknown, delivered: boolean,
                            message: string | null = null, recoverable = false): void {
    console.warn(`[dsx.module] ${scheme}.${action} → ${code}${delivered ? "" : " (fire-and-forget — the error never reaches the call site)"}`);
    if (this.reportingCallFailure) return;
    this.reportingCallFailure = true;
    try {
      DSXErrors.append({ code, message, recoverable, data: data ?? null, scheme, origin: "call", delivered, at: Date.now() });
      // `dsx.errorCount` tracks the ledger's monotonic total from EVERY feeder (a stale
      // counter between ambient emissions would jump unpredictably); `dsx.lastError` stays
      // ambient-only (semantic errors, not transport noise like card_declined).
      DSXState.set("dsx.errorCount", DSXErrors.count());
      const payload: Dict = { scheme, action, code, delivered };
      if (data !== undefined && data !== null) payload["data"] = data;
      this.foldDelegate("module.callFailed", payload, "void");
    } finally {
      this.reportingCallFailure = false;
    }
  }

  /** The AMBIENT error hat (error-system.md §3.2/3.3) — `dsx.error`/`dsx.fail` on the module
   *  handle, where there is no call to settle: the error reports to the APP instead, and is
   *  REPEATABLE by design (no settle guard — the property the old accidental registrar path
   *  fatally lacked). Deterministic fan-out: the ledger + reactive keys
   *  (`global.dsx.lastError` / `global.dsx.errorCount` — error state IS observable state),
   *  the `module.error` hook (the semantic sibling of the transport-level
   *  `module.callFailed`), and the page channel — the module's OWN scheme, event "error",
   *  plus the reserved `dsx` mirror so an app builds ONE global error listener. A nested
   *  emission from inside a hook or page handler stays log-only (the guard below) — the
   *  fan-out never feeds an observer its own output. */
  reportAmbientError(scheme: string, code: string,
                     opts: { message?: string | null; recoverable?: boolean; data?: unknown;
                             origin?: "raised" | "uncaught" } = {}): void {
    const message = opts.message ?? null;
    const origin = opts.origin ?? "raised";
    console.warn(`[dsx.error] ${scheme} → ${code}${origin === "uncaught" ? " (uncaught)" : ""}${message ? ` — ${message}` : ""}`);
    if (this.reportingAmbientError) return;   // nested inside the fan-out below → log-only
    this.reportingAmbientError = true;
    try {
      const wire: Dict = { code, message, recoverable: opts.recoverable ?? false, scheme, origin };
      if (opts.data !== undefined && opts.data !== null) wire["data"] = opts.data;
      DSXErrors.append({ code, message, recoverable: opts.recoverable ?? false,
                         data: opts.data ?? null, scheme, origin, at: Date.now() });
      DSXState.set("dsx.lastError", wire);
      DSXState.set("dsx.errorCount", DSXErrors.count());
      this.foldDelegate("module.error", wire, "void");
      DSXEvents.publish(`${scheme}:error`, wire);
      if (scheme !== "dsx") DSXEvents.publish("dsx:error", wire);
    } finally {
      this.reportingAmbientError = false;
    }
  }
  private reportingAmbientError = false;

  register(module: WebModule, opts: { aliases?: string[]; fallback?: boolean } = {}): void {
    const scheme = module.scheme.toLowerCase();
    // `dsx` is RESERVED (the error-system's global mirror channel, error-system.md §3.3b) —
    // a module claiming it would shadow every app's global error listener. Refused, loudly.
    if (scheme === "dsx" || (opts.aliases ?? []).some((a) => a.toLowerCase() === "dsx")) {
      console.warn(`[dsx bus] scheme "dsx" is reserved (the error-system mirror) — module refused`);
      return;
    }
    // A FALLBACK registration (the surface's built-in twin, e.g. boot's route module)
    // yields to a PROVIDED module: it lands only while the scheme is unowned or owned by
    // a previous fallback — a re-boot replaces its own stale instance, never a facet's.
    // Modules provide, surfaces consume; the built-in twin must never shadow the module.
    if (opts.fallback === true) {
      if (this.modules.has(scheme) && !this.fallbackSchemes.has(scheme)) return;
      this.fallbackSchemes.add(scheme);
    } else {
      this.fallbackSchemes.delete(scheme);
    }
    this.modules.set(scheme, module);
    // dsx.json `aliases` — extra schemes routed to the SAME module (the
    // GeneratedModuleSchemes twin: the build reads the manifest and passes them
    // here; a facet never hand-declares its aliases). Route-table entries only —
    // identity (declared state, boot, event names) stays the primary scheme.
    for (const alias of opts.aliases ?? []) this.modules.set(alias.toLowerCase(), module);
    if (module.state) {
      for (const [k, v] of Object.entries(module.state)) {
        if (DSXState.get(`${scheme}.${k}`) === null) DSXState.set(`${scheme}.${k}`, v);
      }
    }
    if (module.hooks) {
      for (const [event, fn] of Object.entries(module.hooks)) {
        this.hooks.push({ event, priority: 0, fn });
      }
    }
    module.boot?.(makeDsx(scheme));
  }

  isAvailable(scheme: string): boolean {
    return this.modules.has(scheme.toLowerCase());
  }

  /** The build seam for the excluded-identities overlay — chains that exist in the
   *  product but are excluded from THIS build. Default empty; the build wires it (the
   *  runtime.js `despia.excluded` twin). A chain whose nearest ancestor is also excluded
   *  carries the cascade entry shape ({ reason: "cascade", from: <parent chain> }).
   *  An entry may carry the module's legacy alias spellings — an excluded module is
   *  unregistered, so nothing else can normalize them; `excludedFact` answers them 1:1
   *  with the page's matchesEntry (bare strings stay accepted — alias-less overlay). */
  setExcludedIdentities(chains: Array<string | { chain: string; aliases?: string[] }>): void {
    this.excludedIdentities.clear();
    this.excludedAliases.clear();
    const entries = chains.map((c) =>
      typeof c === "string" ? { chain: c.toLowerCase(), aliases: [] as string[] }
                            : { chain: c.chain.toLowerCase(), aliases: c.aliases ?? [] });
    const set = new Set(entries.map((e) => e.chain));
    for (const { chain, aliases } of entries) {
      let from: string | null = null;
      for (let i = chain.lastIndexOf("."); i > 0; i = chain.lastIndexOf(".", i - 1)) {
        const parent = chain.substring(0, i);
        if (set.has(parent)) { from = parent; break; }
      }
      this.excludedIdentities.set(chain, from === null ? { reason: "excluded" } : { reason: "cascade", from });
      for (const alias of aliases) this.excludedAliases.set(alias.toLowerCase(), chain);
    }
  }

  /** The build seam for the PLATFORM CATALOG — the twin of `setExcludedIdentities`, and the
   *  thing whose absence made `unsupported_platform` unreachable on this renderer (X1 H3: the
   *  ladder and the table both shipped; nothing ever filled the table outside a test, so 359
   *  native-only actions answered `not_loaded`, which the bus itself documents as a caller bug).
   *
   *  Takes the FULL catalog — every chain and every narrowed action, exactly as
   *  `ClosedSource/Registry/ModulePlatformSupport.generated.json` carries it — and folds it
   *  against this runtime's OS, so what lands in the maps is only what is off-platform HERE.
   *  Filtering at install rather than at lookup is what keeps the ladder a pure function of
   *  facts and the `.has()` reads honest. Re-callable; each call replaces both tables. */
  setPlatformSupport(catalog: { byScheme?: Record<string, string[]>; byAction?: Record<string, string[]> },
                     os: string = JSESeams.platformOS): void {
    this.unsupportedPlatforms.clear();
    this.unsupportedActionPlatforms.clear();
    for (const [chain, platforms] of Object.entries(catalog.byScheme ?? {})) {
      if (!platforms.includes(os)) this.unsupportedPlatforms.set(chain.toLowerCase(), [...platforms]);
    }
    for (const [key, platforms] of Object.entries(catalog.byAction ?? {})) {
      if (!platforms.includes(os)) this.unsupportedActionPlatforms.set(key.toLowerCase(), [...platforms]);
    }
  }

  /** The `.excluded` build fact: false, or the DespiaExcluded-shaped entry
   *  ({ reason: "excluded" } | { reason: "cascade", from }) — build facts must answer.
   *  Legacy ALIAS spellings answer the owning chain's entry (never an identity of
   *  their own — aliases stay head-position spellings, outside the fold universe). */
  excludedFact(chain: string): false | { reason: "excluded" } | { reason: "cascade"; from: string } {
    const key = chain.toLowerCase();
    const direct = this.excludedIdentities.get(key);
    if (direct !== undefined) return { ...direct };
    const target = this.excludedAliases.get(key);
    const viaAlias = target === undefined ? undefined : this.excludedIdentities.get(target);
    return viaAlias === undefined ? false : { ...viaAlias };
  }

  /** chain → its legacy alias spellings (the live view over the route table, sorted) —
   *  the emission fan-out reads this so an alias-channel subscriber hears a module's
   *  events no matter which spelling it subscribed under. */
  aliasesFor(identity: string): string[] {
    const chain = identity.toLowerCase();
    const out: string[] = [];
    for (const [spelling, m] of this.modules) {
      if (spelling !== chain && m.scheme.toLowerCase() === chain) out.push(spelling);
    }
    return out.sort();
  }

  /** Resolve a dotted callee against the LIVE identity table (the chains-corpus fold) —
   *  the introspection seam the chain proxy and the conformance runner share. */
  resolve(callee: string): ChainResolution {
    return resolveChain(callee.split("."), this.chainTable());
  }

  /** The live ChainTable view: registered PRIMARY chains ∪ the excluded overlay form the
   *  identity set; alias route-table keys are spellings (head position only), never
   *  identities. */
  private chainTable(): ChainTable {
    return {
      isIdentity: (chain) => {
        const m = this.modules.get(chain);
        return (m !== undefined && m.scheme.toLowerCase() === chain) || this.excludedIdentities.has(chain);
      },
      aliasTarget: (head) => {
        const m = this.modules.get(head);
        if (m === undefined) return null;
        const primary = m.scheme.toLowerCase();
        return primary === head ? null : primary;
      },
      isExcluded: (chain) => this.excludedIdentities.has(chain),
    };
  }

  /** The module's PRIMARY (identity) scheme for a possibly-alias scheme — declared state,
   *  boot, and event names all live under this, never under an alias route. */
  primaryScheme(scheme: string): string {
    return this.modules.get(scheme.toLowerCase())?.scheme.toLowerCase() ?? scheme.toLowerCase();
  }

  schemes(): string[] {
    return [...this.modules.keys()];
  }

  /** The kernel-INTERNAL append. `dsx.delegate.listen` is its one public spelling — the
   *  natives deleted the public `hook` for exactly this reason (delegates.md phase 4: two
   *  competing attach idioms is the failure the collapse exists to end). Named
   *  `registerDelegate` because `register` on this class is already MODULE registration —
   *  the natives can call it `register` only because theirs hangs off `Context`. */
  registerDelegate(event: string, priority: number, fn: (input: unknown) => unknown): () => void {
    const h: Hook = { event, priority, fn };
    this.hooks.push(h);
    return () => {
      const i = this.hooks.indexOf(h);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** THE delegate fold — the ONE place every cross-module event collapses, and the twin of
   *  the natives' `ModuleRegistry.dispatch`. `combine` IS the difference between the four
   *  legacy verbs, and there is no verb in between. It is named `foldDelegate` rather than
   *  the natives' `dispatch` only because `dispatch` on this class is already the CALL path.
   *
   *  The combines, matching the natives bit for bit: `void` runs every listener and answers
   *  nothing; `any` and `claim` both stop at the first non-nil answer (a claim is answered by
   *  ONE owner) and differ in intent, not mechanism; `collect` runs all and gathers the
   *  non-nil; `veto` stops at the first `false` and otherwise allows. A listener that throws
   *  is skipped and never settles the fold — one bad watcher cannot silently deny an event. */
  foldDelegate(event: string, input: unknown = null, combine: Combine = "claim"): unknown {
    const collected: unknown[] = [];
    for (const h of [...this.hooks].sort((a, b) => b.priority - a.priority)) {
      if (h.event !== event) continue;
      let value: unknown;
      try { value = h.fn(input); }
      catch (e) { console.warn(`[dsx bus] ${combine} ${event}:`, e); continue; }
      if (combine === "void") continue;
      if (combine === "veto") { if (value === false) return false; continue; }
      if (value === null || value === undefined) continue;
      if (combine === "collect") collected.push(value);
      else return value;                      // any | claim — first non-nil settles it
    }
    if (combine === "collect") return collected;
    if (combine === "veto") return true;
    return null;
  }

  /** Point-to-point call, the legacy WIRE face (URL navigations, the v3 string
   *  transport): a scheme token (a primary chain, a dotted chain token, or a legacy
   *  alias — ONE head unit, never re-split) + a slash-joined action path. EXEMPT from
   *  the reserved-member refusal (corpus _note): reserved words are banned from
   *  MANIFESTS, never from the wire, so a code-only legacy shim registered under a
   *  reserved spelling (biometric://available, bluetooth://state) keeps answering
   *  shipped pages. Resolves with the module's resolve() data; rejects with
   *  ModuleCallError (excluded / not_loaded / unsupported_platform / action code). Every failure —
   *  thrown here or settled by the handler — also reports to the diagnostics funnel
   *  (reportCallFailure above); `fireAndForget` marks a `.post` call, whose rejection
   *  the call site discards by shape (delivered: false in the funnel event). */
  async dispatch(scheme: string, host: string, args: Dict, opts: { events?: (name: string, value: unknown) => void; fireAndForget?: boolean } = {}): Promise<unknown> {
    return this.dispatchSegments([scheme, ...host.split("/").filter((s) => s.length > 0)], args, opts, "wire");
  }

  /** The dotted-CALLEE face — the text after `dsx.module.` arrives WHOLE (the runner's
   *  statements, the chain proxy); the funnel folds identity vs action. A MODERN face:
   *  a reserved member arriving here as a call is refused (`reserved_member`). */
  async call(callee: string, args: Dict, opts: { events?: (name: string, value: unknown) => void; fireAndForget?: boolean } = {}): Promise<unknown> {
    return this.dispatchSegments(callee.split(".").filter((s) => s.length > 0), args, opts, "modern");
  }

  /** THE dispatch funnel (chains corpus): every call face lands here with its natural
   *  segmentation, and the FOLD (resolveChain) settles module identity vs action path
   *  against the live identity table before any route is taken. Errors echo the scheme
   *  AS CALLED (the alias spelling) while identity — state, events, the bound dsx —
   *  stays the primary chain. The `face` splits the reserved-member law: MODERN faces
   *  (the chain proxy, the dotted-callee `call`) refuse a member route as an action;
   *  the legacy WIRE face routes it DIRECT under the arriving spelling. */
  /**
   * Rung two lookup. `null` means "this call is not linked", and the caller must fall through to
   * the answer it would have given anyway — never a substitute failure.
   *
   * Requires BOTH a transport and a listed route: a table with no transport (a build that emitted
   * the link but never installed one) must not swallow `not_loaded`, because a caller told
   * "unreachable" would go looking for a network problem that does not exist.
   */
  private linkRouteFor(chain: string, action: string): LinkRoute | null {
    // A bundle that reaches no server should not carry the route walk. esbuild cannot
    // tree-shake a class METHOD (it is a prototype property), so the flag has to fold
    // inside the body — `define` turns this into `if (true) return null` and the rest
    // of the body becomes dead code. Default (undefined) keeps the full behaviour.
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_LINK__?: boolean })
      .__DSX_OPTIONAL_LINK__ === false) return null;
    if (LinkSeam.invoke === null) return null;
    const wanted = action.toLowerCase();
    for (const route of LinkSeam.routes) {
      if (route.chain === chain && route.action.toLowerCase() === wanted) return route;
    }
    return null;
  }

  /**
   * Invoke over the link, and map failure onto the ONE closed vocabulary.
   *
   * A `ModuleCallError` from the transport is the SERVER's own typed answer (`unauthenticated`,
   * `bad_request`, …) and passes through with its reason intact — flattening it to `unreachable`
   * would tell a caller the network failed when in fact the server answered, precisely.
   * Everything else IS a link failure and becomes `unreachable`, the spelling durability P4
   * froze for exactly this and the errors corpus already pins on the ordinary call path.
   */
  private async callOverLink(route: LinkRoute, scheme: string, host: string, args: Dict, delivered: boolean): Promise<unknown> {
    // Unreachable when the link is compiled out (linkRouteFor already returned null), so the
    // same fold drops this body too — see the note there.
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_LINK__?: boolean })
      .__DSX_OPTIONAL_LINK__ === false) {
      throw new ModuleCallError(ERROR_UNREACHABLE, `${scheme}.${host} has no link transport`, { chain: route.chain });
    }
    const invoke = LinkSeam.invoke;
    if (invoke === null) throw new ModuleCallError(ERROR_UNREACHABLE, `${scheme}.${host} has no link transport`, { chain: route.chain });
    try {
      return await invoke(route, args);
    } catch (e) {
      if (e instanceof ModuleCallError) {
        this.reportCallFailure(scheme, host, e.code, e.data, delivered, e.message);
        throw e;
      }
      const message = e instanceof Error ? e.message : String(e);
      const data = { chain: route.chain, action: route.action, method: route.method, path: route.path };
      this.reportCallFailure(scheme, host, ERROR_UNREACHABLE, data, delivered, message);
      throw new ModuleCallError(ERROR_UNREACHABLE, `${scheme}.${host} could not reach the server: ${message}`, data);
    }
  }

  /** The live FACTS for one call — the registry read once, so the pure ladder above decides
   *  on exactly what ships and the conformance runner can state the same eight fields
   *  literally. The facet half folds out of a peer-less bundle with the ladder's own guard. */
  private facetFacts(chain: string, action: string, hasModule: boolean, hasHandler: boolean): FacetFacts {
    return {
      local: hasModule && hasHandler,
      module: hasModule,
      ...facetSeamFacts(chain, action),
      linked: this.linkRouteFor(chain, action) !== null,
      // the OVERLAY identity set, exactly what the fold's `excluded` flag reads — an alias
      // spelling is not an identity here (excludedFact answers those on the member plane)
      excluded: this.excludedIdentities.has(chain),
      offPlatform: this.unsupportedPlatforms.has(chain),
      // only when the MODULE itself is on-platform: otherwise the module-level rung already
      // says it, and the two would race to describe the same absence
      offPlatformAction: !this.unsupportedPlatforms.has(chain) &&
        this.unsupportedActionPlatforms.has(actionPlatformKey(chain, action)),
    };
  }

  /**
   * Rung two over the FACET link (the sibling of `callOverLink`, which rides the server
   * node's client-link table). A `ModuleCallError` from the transport is the far node's own
   * typed answer and passes through with its reason intact; anything else IS a link failure
   * and becomes `unreachable`, the spelling durability P4 froze for exactly this.
   */
  private async callOverReach(chain: string, scheme: string, host: string, args: Dict, delivered: boolean): Promise<unknown> {
    // The same fold as the rungs (see resolveFacetLadder): with the facet rungs compiled out
    // the ladder can never answer `reach` via "facet", so this body is dead weight there.
    const invoke = (globalThis as typeof globalThis & { __DSX_OPTIONAL_LINK__?: boolean })
      .__DSX_OPTIONAL_LINK__ === false ? null : FacetSeam.invoke;
    const facet = FacetSeam.facet ?? "";
    // one shape for the code, wherever it is raised — who was asked, for what, on which
    // facet (the scheme AS CALLED, like every other envelope on this funnel)
    const data = { scheme, action: host, facet, chain };
    if (invoke === null) {
      this.reportCallFailure(scheme, host, ERROR_UNREACHABLE, data, delivered);
      throw new ModuleCallError(ERROR_UNREACHABLE, `${scheme}.${host} has no reach transport`, data);
    }
    try {
      return await invoke({ chain, action: host, facet }, args);
    } catch (e) {
      if (e instanceof ModuleCallError) {
        this.reportCallFailure(scheme, host, e.code, e.data, delivered, e.message);
        throw e;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.reportCallFailure(scheme, host, ERROR_UNREACHABLE, data, delivered, message);
      throw new ModuleCallError(ERROR_UNREACHABLE, `${scheme}.${host} could not reach its facet: ${message}`, data);
    }
  }

  /** The wire payload each typed-absence code has always carried — the ladder picks the code,
   *  this composes the envelope, so the shipped shapes (errors corpus) are untouched. The two
   *  facet-only codes carry the same triple: who was asked, for what, on which facet. */
  private absencePayload(code: string, scheme: string, host: string, chain: string): unknown {
    if (code === ERROR_UNKNOWN_ACTION) return { action: host };
    if (code === ERROR_EXCLUDED) {
      // the DespiaExcluded-shaped entry rides VERBATIM — the same fact `.excluded` answers
      return this.excludedFact(chain);
    }
    if (code === ERROR_UNSUPPORTED_PLATFORM) {
      // the ACTION row first — it is the more specific claim (facetFacts pins the precedence)
      const platforms = this.unsupportedActionPlatforms.get(actionPlatformKey(chain, host)) ??
        this.unsupportedPlatforms.get(chain);
      // the platform catalog's own shape when it owns the answer; otherwise the FACET
      // shape — the row exists and neither provides nor reaches this runtime's word
      if (platforms) return { scheme, platform: JSESeams.platformOS, supportedPlatforms: platforms };
    } else if (code === ERROR_NOT_LOADED) {
      return { scheme };
    }
    return { scheme, action: host, facet: FacetSeam.facet };
  }

  private async dispatchSegments(segments: string[], args: Dict, opts: { events?: (name: string, value: unknown) => void; fireAndForget?: boolean } = {}, face: "modern" | "wire" = "modern"): Promise<unknown> {
    const delivered = !opts.fireAndForget;
    // The KERNEL answers the reserved scheme's verbs before any module route (the scheme
    // is refused to modules, so there is never a collision): the `dsx.log` / `dsx.error`
    // verbs are how the DSXWebView PAGE reaches the log ring and the ambient error fan-out
    // (window.dsx + window.onerror forwarding — runtime.js; dot notation IS the API, the
    // scheme is only a bus routing key). `dsx.has("dsx")` stays false — a kernel channel,
    // not a module.
    if ((segments[0] ?? "").toLowerCase() === "dsx") {
      return this.kernelVerb(segments.slice(1).join("/"), args, delivered);
    }
    const r = resolveChain(segments, this.chainTable());
    const scheme = r.spelling;
    let host = r.action.join("/");
    if (r.member !== null) {
      if (face === "modern") {
        // a reserved member is a MEMBER route, never an action — the modern faces
        // refuse it (impossible through the proxies themselves, i.e. a caller bug)
        const data = { member: r.member, rest: r.rest.join("/") };
        this.reportCallFailure(scheme, [r.member, ...r.rest].join("/"), "reserved_member", data, delivered);
        throw new ModuleCallError("reserved_member", `${scheme}.${r.member} is a member route, never an action`, data);
      }
      // The legacy WIRE face is EXEMPT and routes DIRECT to the owner (corpus _note):
      // reserved words are banned from MANIFESTS, never from the v3 wire — the compat
      // shims exist exactly for this. The remainder rides through with its arriving
      // spelling; an unregistered name still answers unknown_action honestly below.
      const parts = segments.filter((s) => s.length > 0);
      host = parts.slice(parts.length - (1 + r.rest.length)).join("/");
    }
    // THE FACET RESOLUTION LADDER (facet-contracts.md, corpus Conformance/facets): local →
    // reach over the link → typed unavailable, decided ONCE by the pure function so every
    // face of this funnel answers identically and the corpus can drive the decision without
    // driving a call. Rung two applies per-ACTION, not just per-chain: a chain may be PARTLY
    // local, and a module that gained one remote action must not answer `unknown_action` for
    // it while its siblings resolve here.
    const module = this.modules.get(r.chain);
    const handler = module === undefined
      ? undefined
      : (module.actions[host] ?? module.actions[host.toLowerCase()] ?? module.actions["*"]);
    if (module === undefined || handler === undefined) {
      const verdict = resolveFacetLadder(
        this.facetFacts(r.chain, host, module !== undefined, handler !== undefined));
      if (verdict.rung === "reach") {
        const linked = verdict.via === "link" ? this.linkRouteFor(r.chain, host) : null;
        return linked === null
          ? this.callOverReach(r.chain, scheme, host, args, delivered)
          : this.callOverLink(linked, scheme, host, args, delivered);
      }
      // TYPED ABSENCE (durability.md P4, errors + facets corpora): the reason IS the code,
      // carried on the ordinary call-failure path into the ledger — never a side channel.
      // The ladder chose the code; the funnel composes the wire payload each code has always
      // carried, so the shipped envelopes are unchanged.
      const code = verdict.code!;
      const data = this.absencePayload(code, scheme, host, r.chain);
      this.reportCallFailure(scheme, host, code, data, delivered);
      throw new ModuleCallError(code, `${scheme}.${host} → ${code}`, data);
    }
    // A call may arrive through an alias; the module's IDENTITY (its bound dsx,
    // declared-state writes, event names) is always the primary scheme — errors
    // keep echoing the scheme as called, like the native envelope.
    const identity = module.scheme.toLowerCase();
    // Funnel handle for the settle paths below (object-literal methods own their `this`).
    const report = (code: string, data: unknown, message: string | null = null, recoverable = false) =>
      this.reportCallFailure(scheme, host, code, data, delivered, message, recoverable);
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      let settled = false;
      const ctx: ActionContext = {
        scheme,
        action: host,
        args(k?: string): unknown {
          if (k === undefined) {
            const out: Dict = {};
            for (const [kk, v] of Object.entries(args)) if (!kk.startsWith("__")) out[kk] = v;
            return out;
          }
          const v = args[k];
          return v === NSNull ? null : v ?? null;
        },
        resolve(data: unknown = null): void {
          if (settled) return;
          settled = true;
          resolvePromise(data);
        },
        error(code = "error", data: unknown = null): void {
          if (settled) return;
          settled = true;
          report(code, data);
          rejectPromise(new ModuleCallError(code, `${scheme}.${host} failed: ${code}`, data));
        },
        fail(code: string, message?: string, recoverable = false, data: unknown = null): void {
          if (settled) return;
          settled = true;
          report(code, data, message ?? null, recoverable);   // full fidelity into the record
          rejectPromise(new ModuleCallError(code, message ?? `${scheme}.${host} failed: ${code}`, data));
        },
        event(name: string, value: unknown = null): void {
          opts.events?.(name, value);
          DSXEvents.publish(`${identity}:${name}`, value);
          // ALIAS fan-out (the native fire/broadcast twin): the same event also
          // rides each legacy alias channel, so a subscriber holding the old
          // spelling keeps hearing the module it always heard.
          for (const alias of ModuleRegistry.aliasesFor(identity)) DSXEvents.publish(`${alias}:${name}`, value);
        },
        broadcast(name: string, value: unknown = null): void {
          DSXEvents.publish(name, value);
        },
        dsx: makeDsx(identity),
      };
      Promise.resolve()
        .then(() => handler(ctx))
        .then((v) => {
          // returned value = implicit resolve (the lean authoring shape)
          if (!settled && v !== undefined) ctx.resolve(v ?? null);
          else if (!settled && v === undefined) ctx.resolve(null);
        })
        .catch((e) => {
          if (settled) return;
          settled = true;
          const err = e instanceof ModuleCallError ? e : new ModuleCallError("error", String(e));
          report(err.code, err.data ?? String(e));
          rejectPromise(err);
        });
    });
  }

  object(scheme: string, name: string): unknown {
    const module = this.modules.get(scheme.toLowerCase());
    return module?.objects?.[name]?.() ?? null;
  }

  /** Resolve a module-provided component (/web/18). `Scheme.Name` → that module's
   *  facet directly; bare `Name` → the ONE registered module providing it (a cross-
   *  package ambiguity resolves to none, loudly — qualify the tag). The impl stays
   *  opaque here (kernel DOM-free law); the renderer holds it to its contract. */
  facetComponent(tag: string): { scheme: string; name: string; impl: unknown } | null {
    if (tag.includes(".")) {
      const scheme = tag.substring(0, tag.indexOf(".")).toLowerCase();
      const name = tag.substring(tag.indexOf(".") + 1);
      const impl = this.modules.get(scheme)?.components?.[name];
      return impl === undefined ? null : { scheme: this.primaryScheme(scheme), name, impl };
    }
    const hits: Array<{ scheme: string; name: string; impl: unknown }> = [];
    const seen = new Set<WebModule>(); // alias routes map one module under several schemes
    for (const m of this.modules.values()) {
      if (seen.has(m)) continue;
      seen.add(m);
      const impl = m.components?.[tag];
      if (impl !== undefined) hits.push({ scheme: m.scheme.toLowerCase(), name: tag, impl });
    }
    if (hits.length > 1) {
      console.warn(`[dsx bus] component <${tag}> is provided by ${hits.map((h) => h.scheme).join(" + ")} — qualify the tag (<${hits[0]!.scheme}.${tag}>)`);
      return null;
    }
    return hits[0] ?? null;
  }

  /** The reserved scheme's kernel verbs (logs corpus / errors corpus): `log` records one
   *  line ({ message, scheme? } — source defaults to "page", the bridge's caller), `error`
   *  runs the ambient fan-out ({ code, message?, recoverable?, data?, scheme? }). Both
   *  resolve null. Anything else answers `unknown_action` honestly — never `not_loaded`
   *  (the kernel does own this scheme). */
  private async kernelVerb(host: string, args: Dict, delivered: boolean): Promise<unknown> {
    const action = host.toLowerCase();
    const source = string(args["scheme"] ?? "") || "page";
    if (action === "log") {
      reportLog(source, "log", string(args["message"] ?? ""));
      return null;
    }
    if (action === "error") {
      const m = args["message"];
      this.reportAmbientError(source, string(args["code"] ?? "") || "error", {
        message: m === undefined || m === null || m === NSNull ? null : string(m),
        recoverable: truthy(args["recoverable"]),
        data: args["data"],
      });
      return null;
    }
    this.reportCallFailure("dsx", host, "unknown_action", { action }, delivered);
    throw new ModuleCallError("unknown_action", `dsx.${host} is not a kernel verb`, { action });
  }
}

export const ModuleRegistry = new ModuleRegistryImpl();

// availability seam for `has(scheme)` / `visible-if="has:x"`
JSESeams.moduleAvailable = (scheme) => ModuleRegistry.isAvailable(scheme);

// ── DSXEvents (scheme:event pub/sub — the `despia.on` / dsx.hook twin) ───────────────

class DSXEventsImpl {
  private listeners = new Map<string, Set<(value: unknown) => void>>();

  on(name: string, fn: (value: unknown) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
    return () => set.delete(fn);
  }

  publish(name: string, value: unknown): void {
    for (const fn of this.listeners.get(name) ?? []) {
      try { fn(value); } catch (e) { console.warn(`[dsx events] ${name}:`, e); }
    }
    // the `<chain>:*` wildcard — the module handle's kind-less `.on(handler)`: every
    // event published under the chain, delivered as handler(value, kind)
    const colon = name.indexOf(":");
    if (colon > 0) {
      const kind = name.substring(colon + 1);
      for (const fn of this.listeners.get(`${name.substring(0, colon)}:*`) ?? []) {
        try { (fn as (value: unknown, kind?: string) => void)(value, kind); } catch (e) { console.warn(`[dsx events] ${name}:`, e); }
      }
    }
  }
}

export const DSXEvents = new DSXEventsImpl();

// ── the bound dsx handle for module code (the ONE bus handle) ────────────────────────

export type DsxContext = {
  readonly scheme: string;
  has(scheme: string): boolean;
  module: ModuleProxy;
  /** The delegate plane — the ONE attach/emit pair, matching the natives after the phase-4
   *  collapse. `listen` is the only public spelling of the append; `send` names its
   *  `combine` EXPLICITLY at every site, because an omitted combine falls back to `claim`,
   *  which SHORT-CIRCUITS — and an excluded owner declares nothing, so leaving it implicit
   *  lets a build profile quietly turn a broadcast into a first-wins call. */
  delegate: {
    listen(event: string, fn: (input: unknown) => unknown, priority?: number): () => void;
    send(event: string, payload?: unknown, combine?: Combine): unknown;
  };
  /** the AMBIENT error hat (error-system.md): no call to settle here, so `error`/`fail`
   *  report to the app — ledger + module.error + page channel + reactive keys. Repeatable.
   *  (Inside an ACTION handler, `ctx.error`/`ctx.fail` stay the terminal settle — the hat
   *  is the type: ActionContext settles, DsxContext reports.) */
  error(code: string, data?: unknown): void;
  fail(code: string, message?: string, recoverable?: boolean, data?: unknown): void;
  /** the error ledger read API — recent (retained ring), count (monotonic), clear (dev) */
  errors: { recent(): DSXErrorEntry[]; count(): number; clear(): void };
  /** the unified console primitive (logs corpus): console.log-shaped variadic formatting,
   *  recorded in the log ring attributed to THIS module's scheme + one console line */
  log(...args: unknown[]): void;
  /** the log ring read API — recent (retained ring), count (monotonic), clear (dev) */
  logs: { recent(): DSXLogEntry[]; count(): number; clear(): void };
  /** declared live state publish: writes `global.<scheme>.<var>` */
  state: { set(name: string, value: unknown): void; get(name: string): unknown };
  global: { get(path: string): unknown; set(path: string, value: unknown): void };
  env(): string;
  platform: { os: string; native: boolean; desktop: boolean; embed: boolean };
  events: DSXEventsImpl;
};

/** One node of the `dsx.module` chain plane — callable at any depth (the funnel folds
 *  identity vs action), traversable a segment at a time, with the web-surfaced reserved
 *  members at identity position. Dynamic by construction; the runtime proxy is the truth. */
export type ModuleHandle = {
  (args?: Dict): Promise<unknown>;
  post: (args?: Dict) => void;
  object: (name: string) => unknown;
  /** the declared-vars plane — `.context.<var>` is CANONICAL (facet-contracts.md) */
  context: { [varName: string]: unknown };
  /** the pre-rename alias of `.context` — the same plane, kept for the transition */
  state: { [varName: string]: unknown };
  available: boolean;
  excluded: false | { reason: "excluded" } | { reason: "cascade"; from: string };
  on: (kindOrHandler?: string | ((value: unknown, kind?: string) => void),
       handler?: (value: unknown, kind?: string) => void) => () => void;
} & { [segment: string]: ModuleHandle };

export type ModuleProxy = { [scheme: string]: ModuleHandle };

/** The declared-vars read plane — served under BOTH member spellings: `.context`
 *  (canonical, facet-contracts.md) and `.state` (the pre-rename alias). Vars live under
 *  the PRIMARY chain; a read via an alias route must resolve there (register() publishes
 *  `global.<primary>.<var>`, never under an alias). A member proxy — the R1 safety
 *  denylist applies here too. */
function stateProxy(chain: string): unknown {
  const primary = ModuleRegistry.primaryScheme(chain);
  return new Proxy({}, {
    get(_t, varName: string | symbol) {
      if (typeof varName !== "string" || PROXY_DENYLIST.has(varName)) return undefined;
      return DSXState.get(`${primary}.${varName}`);
    },
  });
}

/** One dotted-chain node (`dsx.module.watch.health.heartRate`): each property get
 *  extends the path one segment; a call at any depth rides the ONE funnel (the fold
 *  settles identity vs action — a bare chain call included). At an IDENTITY position
 *  (no action segments yet) the reserved members answer the MEMBER plane; past it,
 *  `.post` is the fire-and-forget verb on the bound action. */
function chainProxy(path: string[]): unknown {
  const target = () => {};   // arrow fn: no own `prototype` to collide with the traps
  return new Proxy(target, {
    apply(_t, _this, argArray: unknown[]) {
      return ModuleRegistry.call(path.join("."), isDict(argArray[0]) ? (argArray[0] as Dict) : {});
    },
    get(_t, key: string | symbol) {
      // R1 proxy safety: Symbols and the denylist never traverse, never call
      if (typeof key !== "string" || PROXY_DENYLIST.has(key)) return undefined;
      const r = ModuleRegistry.resolve(path.join("."));
      if (r.action.length === 0 && r.member === null) {
        // identity position — the reserved words are MEMBER routes, never actions
        if (key === "object") return (name: string) => ModuleRegistry.object(r.chain, name);
        // the declared-vars plane: `.context.<var>` is CANONICAL (facet-contracts.md);
        // `.state` is the pre-rename alias — ONE reader, two spellings
        if (key === "context" || key === "state") return stateProxy(r.chain);
        if (key === "available") return ModuleRegistry.isAvailable(r.chain) && ModuleRegistry.excludedFact(r.chain) === false;
        if (key === "excluded") return ModuleRegistry.excludedFact(r.chain);
        if (key === "on") {
          // event sugar over the module's DSXEvents channel (`<chain>:<kind>` — the same
          // names ctx.event and the ambient error fan-out publish): on(kind, fn) →
          // fn(value) for that kind; on(fn) → every event of the chain, fn(value, kind).
          // Returns the unsubscribe function either way. Identity, not spelling: an
          // alias handle subscribes the primary chain's channel.
          return (kindOrHandler?: unknown, maybeHandler?: unknown): (() => void) => {
            const all = typeof kindOrHandler === "function";
            const handler = (all ? kindOrHandler : maybeHandler) as ((value: unknown, kind?: string) => void) | undefined;
            if (typeof handler !== "function") return () => {};
            const name = all ? `${r.chain}:*` : `${r.chain}:${String(kindOrHandler)}`;
            return DSXEvents.on(name, handler as (value: unknown) => void);
          };
        }
        if (RESERVED_MEMBERS.has(key)) return undefined;   // delegate/dsx: no web surface
      } else if (key === "post") {
        // Fire-and-forget on the bound action: the rejection is discarded by shape — the
        // funnel reports it (module.callFailed, delivered: false) before rejecting, so
        // the catch here swallows a rejection that is already observable, never a silent
        // one. (At identity position `post` stays a plain first action segment.)
        return (args: Dict = {}) => {
          ModuleRegistry.call(path.join("."), args, { fireAndForget: true }).catch(() => {});
        };
      }
      return chainProxy([...path, key]);
    },
  });
}

function makeModuleProxy(): ModuleProxy {
  return new Proxy({}, {
    get(_t, scheme: string | symbol) {
      if (typeof scheme !== "string" || PROXY_DENYLIST.has(scheme)) return undefined;
      return chainProxy([scheme]);
    },
  }) as ModuleProxy;
}

export function makeDsx(scheme: string): DsxContext {
  return {
    scheme,
    has: (s) => ModuleRegistry.isAvailable(s),
    module: makeModuleProxy(),
    delegate: {
      listen: (event, fn, priority = 0) => ModuleRegistry.registerDelegate(event, priority, fn),
      send: (event, payload = null, combine = "claim") => ModuleRegistry.foldDelegate(event, payload, combine),
    },
    error: (code, data = null) => ModuleRegistry.reportAmbientError(scheme, code, { data }),
    fail: (code, message, recoverable = false, data = null) =>
      ModuleRegistry.reportAmbientError(scheme, code, { message, recoverable, data }),
    errors: DSXErrors,
    log: (...args: unknown[]) => reportLog(scheme, "log", formatLogArgs(args)),
    logs: DSXLogs,
    state: {
      set: (name, value) => DSXState.set(`${scheme}.${name}`, value),
      get: (name) => DSXState.get(`${scheme}.${name}`),
    },
    global: {
      get: (path) => DSXState.get(path),
      set: (path, value) => DSXState.set(path, value),
    },
    env: () => string(DSXState.get("app.env")) || JSESeams.appEnvironment(),
    platform: {
      os: JSESeams.platformOS,
      native: JSESeams.platformOS !== "web",
      desktop: isDesktopOS(JSESeams.platformOS),
      embed: JSESeams.platformEmbed,
    },
    events: DSXEvents,
  };
}

export { isDict };
