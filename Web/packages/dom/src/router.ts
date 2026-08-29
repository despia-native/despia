//
//  router.ts - the unified route surface (/web/04): ONE table maps URLs ↔ component
//  pushes. A routed push writes a real history entry (path params substituted, query
//  preserved); a PATHLESS push still gets a history entry with the URL unchanged
//  ("modal-class navigation"), so the browser Back button always pops the stack.
//  Deep links cold-load: the boot sequence mounts the entry frame, then opens the
//  matched route on top (Back works). Unmatched URLs open the `notFound` component
//  (the 404 page). Every transition publishes `route.{path,params,query,component}`
//  to the app-wide store — `{{ route.params.id }}` reads work everywhere.
//
//  Frames keep the kernel contract: fresh surface store per entry, pushed vars under
//  `vars` (path params as fields, query under `vars.query`).
//

import {
  DSXState, DSXEvents, DSXPathMatch, ModuleRegistry, ReactiveStore, JSE, ScreenReadiness,
  NATIVE_SURFACE, isDict, string, truthy, type Dict,
  orientationClaimPlan, orientationFrameSurface, orientationModalSurface,
  type OrientationSurface,
} from "@despia/kernel";
import { resolveComponent, type Registry } from "@despia/compiler/resolve";
import type { ComponentIR } from "@despia/compiler/component";
import { instantiate, type Instance } from "./mount.ts";
import { claimAdoptRoot } from "./adopt.ts";
import { PresentLedger } from "./present.ts";
import { coldRootHistoryUrl } from "./history.ts";
export { coldRootHistoryUrl } from "./history.ts";
import { SharedFlight, sharedSupport } from "./shared-transition.ts";
import {
  DSX_EASING, DSX_MS, IOS_DIM_PEAK, IOS_EASING, IOS_MS,
  IOS_PARALLAX, MASTER_DETAIL_DEFAULT, MD_EASING, MD_MS, MD_RISE_PX, MOTION_CSS,
  SWIPE_EDGE_PX, dsxRouteFrames, motionFor, splitMasterIndex, swipeCompletes, swipeEnabled,
  type MotionFamily, type MotionKind, type RouterMotionConfig,
} from "./motion.ts";

type RouteEntry = {
  path: string;
  component?: string;
  redirect?: string;
  render?: string;
  /** the wide lane pins this route's frame as the persistent pane */
  master?: boolean;
  /** per-route motion override (resolve.ts `motion`) */
  motion?: "dsx" | "ios" | "md" | "none";
  meta?: { title?: string; description?: string };
  /** capability gate — every named scheme must be shipped in THIS build (native parity) */
  requires?: string[];
  /** declarative guard — a bounded JSE predicate over `global.*` (session/entitlement
   *  state); falsy → follow `redirect` (depth-capped) or skip the entry (fail-open) */
  guard?: string;
};
type Frame = {
  /** Monotonic identity stamped onto every module call originating in this surface. */
  id: number;
  tier: "page" | "sheet" | "cover";
  name: string;
  el: HTMLElement;
  instance: Instance;
  route: { path: string; params: Dict; query: Dict } | null;
  /** the route flagged `master: true` — the wide lane pins this frame as the persistent pane */
  master: boolean;
  /** the route's per-route motion override (resolve.ts `motion`) — undefined = the lane's */
  motionOverride?: "dsx" | "ios" | "md" | "none";
  /** element that initiated this navigation, restored when the frame closes */
  restoreFocus: HTMLElement | null;
};

function parseQuery(search: string): Dict {
  const out: Dict = {};
  for (const [k, v] of new URLSearchParams(search)) out[k] = v;
  return out;
}

// ── per-history-entry SCROLL RESTORATION (/web/04 W4) ────────────────────────────────
//
//  BACK needs nothing: frames are stacked layers that keep their DOM, so a covered frame
//  keeps its scroll by construction — the native stack contract. What needs a ledger is
//  the REBUILD case: forward navigation and RELOAD build the frame again from scratch,
//  and a rebuilt frame starts at the top.
//
//  The ledger is keyed by HISTORY ENTRY, never by path: two entries can share a URL (a
//  pathless push, a re-visit) and must not share an offset. Every entry this router mints
//  carries a `dsxKey` in `history.state` beside `dsxDepth`; the browser preserves that
//  state across back/forward AND across a reload, which is exactly what makes the reload
//  case work. Offsets ride sessionStorage (per-tab, cleared with the tab), bounded.
//
//  A scroll box is addressed by its CHILD-INDEX PATH inside the frame layer, not by a
//  selector: the same component IR renders the same tree, and a path that no longer
//  resolves is skipped rather than guessed at.

const SCROLL_LEDGER_KEY = "dsx:scroll";
const SCROLL_LEDGER_MAX = 64;
/** how many animation frames a restore keeps re-asserting while content is still
 *  arriving (an `<api>` block, a bound list). Bounded — never a spin. */
const SCROLL_RESTORE_FRAMES = 30;

type ScrollMark = [path: string, top: number, left: number];

let scrollKeySeq = 0;
function mintEntryKey(): string {
  scrollKeySeq += 1;
  return `${Date.now().toString(36)}.${scrollKeySeq}`;
}

function entryKeyOf(state: unknown): string | null {
  const key = (state as { dsxKey?: unknown } | null)?.dsxKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function scrollStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch { return null; }   // a partitioned/blocked storage bucket is not an error here
}

function readScrollLedger(): { [key: string]: ScrollMark[] } {
  const store = scrollStore();
  if (store === null) return {};
  try {
    const raw = store.getItem(SCROLL_LEDGER_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return isDict(parsed) ? parsed as { [key: string]: ScrollMark[] } : {};
  } catch { return {}; }
}

function writeScrollLedger(key: string, marks: ScrollMark[]): void {
  const store = scrollStore();
  if (store === null) return;
  const ledger = readScrollLedger();
  delete ledger[key];                       // re-insert LAST so the trim drops the oldest
  if (marks.length > 0) ledger[key] = marks;
  const keys = Object.keys(ledger);
  for (const stale of keys.slice(0, Math.max(0, keys.length - SCROLL_LEDGER_MAX))) delete ledger[stale];
  try { store.setItem(SCROLL_LEDGER_KEY, JSON.stringify(ledger)); } catch { /* quota — best effort */ }
}

/** the child-index chain from `root` down to `el` ("" = the root itself) */
function scrollPath(root: Element, el: Element): string | null {
  const parts: number[] = [];
  let node: Element | null = el;
  while (node !== null && node !== root) {
    const parent: Element | null = node.parentElement;
    if (parent === null) return null;
    parts.push([...parent.children].indexOf(node));
    node = parent;
  }
  return node === root ? parts.reverse().join(".") : null;
}

function elementAtScrollPath(root: Element, path: string): HTMLElement | null {
  let node: Element = root;
  for (const part of path.split(".")) {
    if (part.length === 0) continue;
    const next = node.children[Number(part)];
    if (next === undefined) return null;
    node = next;
  }
  return node instanceof HTMLElement ? node : null;
}

function collectScrollMarks(root: Element): ScrollMark[] {
  const marks: ScrollMark[] = [];
  const visit = (el: Element): void => {
    if ((el.scrollTop > 0 || el.scrollLeft > 0) && el !== root) {
      const path = scrollPath(root, el);
      if (path !== null) marks.push([path, Math.round(el.scrollTop), Math.round(el.scrollLeft)]);
    }
    for (const child of el.children) visit(child);
  };
  if (root.scrollTop > 0 || root.scrollLeft > 0) {
    marks.push(["", Math.round(root.scrollTop), Math.round(root.scrollLeft)]);
  }
  visit(root);
  return marks;
}

/** Resolve and normalize the application URL prefix independently of the current
 *  SSR route. An explicit boot base prevents a nested export such as
 *  `/app/gallery/index.html` from incorrectly becoming the `/app/gallery/` app root. */
export function appBasePath(configuredBase: string | undefined, documentBase: string): string {
  const path = configuredBase === undefined
    ? new URL(".", documentBase).pathname
    : new URL(configuredBase, documentBase).pathname;
  return path.endsWith("/") ? path : `${path}/`;
}

/**
 * The popTo matching rule, shared verbatim with the Swift/Kotlin runtimes (Router.swift /
 * Router.kt `deepestMatch`): a frame matches when its CONCRETE path equals the target with the
 * query string stripped FROM BOTH SIDES (this runtime stores frame paths query-stripped, the
 * native runtimes store the full pushed path — stripping both sides is the one rule all three
 * can share); the DEEPEST match (nearest previous instance) wins. Never a route-table pattern.
 * Pathless frames (null) never match. Returns -1 when nothing matches or the target strips to
 * empty. Pinned by the SHARED corpus OpenSource/Conformance/router/popto.json — the dom test
 * and the Kotlin RouterTest execute the same file; Router.swift is the reference.
 */
export function deepestPathMatch(paths: (string | null)[], target: string): number {
  const want = target.split("?")[0]!;
  if (want.length === 0) return -1;
  for (let i = paths.length - 1; i >= 0; i -= 1) {
    const p = paths[i];
    if (p === null || p === undefined) continue;
    if (p.split("?")[0] === want) return i;
  }
  return -1;
}

/**
 * The deferred-readiness OPT-IN, read off a frame's compiled ROOT node
 * (screen-lifecycle.md; corpus OpenSource/Conformance/lifecycle/). `settle` is a
 * root-only universal attribute — enum `auto` (the default, never written) | `manual` —
 * and a root attribute is the one spelling all three renderers can read at frame-mount
 * time (the compiler strips `<head>`, but carries root attributes through verbatim).
 * Anything other than `manual` is the default: settle on the first render pass.
 */
export function settlesManually(attrs: { [k: string]: string } | undefined): boolean {
  return (attrs?.["settle"] ?? "").trim().toLowerCase() === "manual";
}

/**
 * A stable identity for one NAMED push/present — the web twin of Router.kt / Router.swift
 * `echoKey`: verb + component + caller path + the vars/attrs seeds (keys SORTED, so two opens
 * of the same component with DIFFERENT inputs produce DIFFERENT keys and both land; only a
 * byte-identical repeat reads as a double-tap echo). Pure — pinned directly (router.test.ts).
 */
export function echoKey(
  verb: string, component: string | null | undefined, path: string,
  vars?: Dict, attrs?: Dict, overrides?: Dict,
): string {
  const digest = (d: Dict | undefined): string => {
    if (d === undefined) return "";
    const keys = Object.keys(d).sort();
    return keys.length === 0 ? "" : keys.map((k) => `${k}=${string(d[k])}`).join("&");
  };
  return `${verb}:${component ?? ""}|${path}|${digest(vars)}|${digest(attrs)}|${digest(overrides)}`;
}

/**
 * The double-tap echo guard — Router.kt / Router.swift `isEcho` 1:1 (RouterTest-pinned). Two
 * taps land faster than a push/present transition covers the screen, so one row tap can
 * dispatch the same NAMED push/present twice — a duplicate page under Back, or two copies of
 * one sheet. An identical consecutive verb inside the 500 ms window is that echo, not intent —
 * dropped. A non-echo ARMS the memo; every stack REDUCTION and modal removal `clear()`s it, so
 * an intentional open → close → open replay is never eaten. The clock is injectable so the
 * rule is testable without leaning on wall-time (the native tests lean on real consecutive
 * `System.currentTimeMillis()`; here the injected clock makes the window deterministic).
 */
export class EchoGuard {
  private memo: { key: string; at: number } | null = null;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(windowMs = 500, now: () => number = () => Date.now()) {
    this.windowMs = windowMs;
    this.now = now;
  }
  /** true = this key is an echo of the one just before it (DROP); false = intent (ARMED). */
  isEcho(key: string): boolean {
    const last = this.memo;
    const at = this.now();
    if (last !== null && last.key === key && at - last.at < this.windowMs) return true;
    this.memo = { key, at };
    return false;
  }
  /** a stack reduction / modal removal re-arms the guard (native clears echoMemo the same way). */
  clear(): void { this.memo = null; }
}

/** Frame ids are allocated PER RENDERER, not per router — the readiness reporter
 *  (ScreenReadiness) is a renderer-wide singleton keyed by this id, and the ROOT PLAN
 *  builds one FrameRouter per candidate. A per-instance counter handed every candidate's
 *  root frame the id 1, so a dead candidate's queued `rendered(1)` microtask landed on the
 *  LIVE candidate's record and settled it before it had rendered — crowning it on its
 *  predecessor's signal. Monotonic across routers, ids are never reused and a stale report
 *  finds no record (readiness.json rule 8: an input for an unknown frame is a no-op). */
let nextFrameId = 1;

/** The next id the allocator will hand out. Read before and after a candidate mount, the
 *  two values BRACKET every frame that mount created (root + any cold deep-link/404 frame)
 *  — which is how the root plan attributes a readiness report to the attempt that owns it
 *  without depending on a router that may already be disposed (boot.ts). */
/** SHEET FRAGMENTS (/web/04 W4). A presented sheet/cover is a CHAIN frame: pathless, one
 *  history entry, dismissed by Back or by verb. Pathless meant the URL said nothing about
 *  it, so a presented sheet could not be linked, shared or restored on reload. The fragment
 *  carries it — `/orders#sheet=Filters` — WITHOUT touching the path or query, so the route
 *  table stays the single source of truth for pages and the sheet rides on top of whatever
 *  page the URL already names. Overlays deliberately do NOT participate: they take no
 *  history entry and are dismissed by verb only (the native contract). */
export const SHEET_FRAGMENT_PREFIX = "sheet=";

export function sheetFragmentUrl(href: string, name: string): string {
  const url = new URL(href);
  url.hash = `${SHEET_FRAGMENT_PREFIX}${encodeURIComponent(name)}`;
  return url.toString();
}

/** The component a URL fragment presents, or null. Only the exact `#sheet=<Name>` shape
 *  is honored — an ordinary in-page anchor (`#pricing`) must stay an anchor. */
export function sheetFragmentName(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith(SHEET_FRAGMENT_PREFIX)) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw.slice(SHEET_FRAGMENT_PREFIX.length));
  } catch {
    return null; // a malformed escape is not a component name
  }
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name) ? name : null;
}

export function frameIdCursor(): number {
  return nextFrameId;
}

export class FrameRouter {
  private frames: Frame[] = [];
  private changeListeners = new Set<() => void>();
  private historyLive = false;
  /** presenting a sheet the COLD-LOAD fragment asked for — it must not mint a second entry */
  private restoringFragment = false;
  /** depth of an in-flight truncateTo() history jump — its popstate is an echo, not a user Back */
  private pendingTruncation: number | null = null;
  // ── OPT-IN DSX Web motion (/web/04 + motion.ts — config-plane; markup/API unchanged) ──
  /** `registry.router` — undefined keeps today's instant swaps everywhere */
  private motionCfg: RouterMotionConfig | undefined;
  /** `auto` is deliberately UA-independent: every Web browser gets DSX motion. */
  private motionTheme: MotionFamily = "dsx";
  /** THE SILENCE RULE: false through the whole boot path (entry mount, deep link, 404) —
   *  a server-rendered direct route replace-mounts with zero motion, zero DOM noise. */
  private interactive = false;
  /** an exit animation is mid-flight (blocks the gesture; pops stay queued behind history) */
  private animating = false;
  /** the next popstate pop is the tail of a completed swipe — its visual already played */
  private skipNextPopMotion = false;
  // ── the presentation machine (present.ts — planes, touch modes, topology) ──
  private ledger = new PresentLedger();
  private overlayViews = new Map<number, { el: HTMLElement; instance: Instance }>();
  private chainFrames = new Map<number, Frame>();
  private overlayPlaneEl: HTMLElement | null = null;
  private pendingFocusRestore: HTMLElement | null = null;
  /** Everything this router bound OUTSIDE its own DOM subtree — `window` listeners, the
   *  shared host's gesture listener, the `route.path` state sink — each paired with its
   *  remover. `dispose()` spends them. A router whose frames are gone must stop reacting:
   *  the ROOT PLAN builds one FrameRouter per candidate into the SAME host, so a dead
   *  candidate's popstate handler would otherwise keep asserting its own frame depth
   *  against the live router's URL. */
  private teardown: Array<() => void> = [];
  /** true once dispose() ran. Read by every callback that can outlive the router — the push and
   *  pop animation `done()`s and the swipe-back `finish()` — so a transition still in flight when
   *  the root plan advances cannot unmount a frame twice, clear the next candidate's motion state,
   *  or drive `history.back()` against a URL this router no longer owns. */
  private disposed = false;
  /** the double-tap echo guard (Router.kt/.swift isEcho) — a NAMED push/present identical to
   *  the one just before it, inside 500ms, is one tap dispatched twice, not intent. Reductions
   *  re-arm it. URL pushes (navigatePath) and boot/history re-mounts bypass it — native parity. */
  private readonly echoGuard = new EchoGuard();
  /** the `dsxKey` of the history entry currently on screen — the scroll ledger's key */
  private currentKey: string | null = null;
  // ── U03 shared element transitions (Conformance/router/shared.json) ──
  /** the flight between the two frames of the transition in the air, or null. Held on the
   *  router because the SWIPE-BACK has to be able to adopt one mid-air: that interruption is
   *  the whole acceptance test, and a flight owned by the animation callback cannot be found. */
  private sharedFlight: SharedFlight | null = null;
  // ── F07b `lockOrientation=` (Conformance/input/orientation-binding.json) ──
  /** what this router has claimed with the Orientation module, in claim order. The reconcile
   *  is a function of the LIVE SET, so every dismissal path funnels into the same release. */
  private orientationClaims: OrientationSurface[] = [];
  readonly registry: Registry;
  readonly host: HTMLElement;
  readonly routes: RouteEntry[];
  /** the app's URL prefix when served under a sub-path (auto-derived at start) */
  base = "/";

  constructor(registry: Registry, host: HTMLElement) {
    this.registry = registry;
    this.host = host;
    this.routes = registry.routes ?? [];
    this.motionCfg = registry.router;
    if (this.motionCfg !== undefined && typeof document !== "undefined") {
      if (document.getElementById("dsx-motion") === null) {
        const style = document.createElement("style");
        style.id = "dsx-motion";
        style.textContent = MOTION_CSS;
        document.head.appendChild(style);
      }
    }
    if (typeof window !== "undefined") {
      const onResize = (): void => this.applyLayout();
      window.addEventListener("resize", onResize);
      this.teardown.push(() => window.removeEventListener("resize", onResize));

      // Bank the offsets the page is LEAVING with. `captureScroll` otherwise runs only on a
      // router navigation, so a RELOAD — the case the ledger exists for, since it is the one
      // rebuild that keeps its history key — would restore from an entry nothing ever wrote.
      // `pagehide` rather than `beforeunload`: it fires for the bfcache path too, and
      // `beforeunload` makes a page ineligible for that cache in every current engine.
      const onPageHide = (): void => this.captureScroll();
      window.addEventListener("pagehide", onPageHide);
      this.teardown.push(() => window.removeEventListener("pagehide", onPageHide));

      if (this.motionCfg?.swipeBack === true) this.attachSwipeBack();
    }
  }

  /** Release everything this router owns outside its own frames: window/host listeners, the
   *  `route.path` sink, its readiness records, and every mounted instance (frames, chain
   *  frames, overlays). Idempotent.
   *
   *  The ROOT PLAN advance is the call site (boot.ts): candidates share one host element, so
   *  `host.replaceChildren()` alone strips the DOM while leaving the dead candidate's
   *  reactive subscriptions, gesture handler and history listener live — a zombie router
   *  re-asserting its frame depth against the live one's URL. Releasing the readiness records
   *  is the same law the native twins keep at teardown (rule 7): a frame that is gone must
   *  never emit a late `viewFinish`, or the fold would crown the SUCCESSOR candidate on the
   *  strength of its predecessor's settle. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.teardown.splice(0)) off();
    this.sharedFlight?.finish();   // a flight outliving its router would keep a dead plane on the host
    this.sharedFlight = null;
    this.changeListeners.clear();
    this.historyLive = false;
    this.interactive = false;
    for (const [, overlay] of this.overlayViews) {
      overlay.instance.unmount();
      overlay.el.remove();
    }
    this.overlayViews.clear();
    this.chainFrames.clear();
    this.overlayPlaneEl?.remove();
    this.overlayPlaneEl = null;
    for (const frame of this.frames) {
      ScreenReadiness.release(frame.id);
      frame.instance.unmount();
      frame.el.remove();
    }
    this.frames = [];
  }

  // ── change notifications (the route module's chrome consumes these) ────────────────

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private notify(): void {
    this.applyLayout();
    this.publishRoute();
    this.syncOrientation();   // F07b: the ONE funnel every dismissal path passes through
    for (const fn of [...this.changeListeners]) fn();
    const restore = this.pendingFocusRestore;
    this.pendingFocusRestore = null;
    if (restore !== null) {
      queueMicrotask(() => {
        if (restore.isConnected && !restore.closest("[inert]")) restore.focus({ preventScroll: true });
      });
    }
  }

  // ── the route table ────────────────────────────────────────────────────────────────

  private appPath(pathname: string): string {
    return pathname.startsWith(this.base) ? "/" + pathname.slice(this.base.length) : pathname;
  }

  private toUrl(routePath: string, params: Dict, query: Dict): string {
    // A param VALUE is percent-encoded into its path segment so it can't fabricate URL
    // structure — `push("User", { name: "x?admin=1" })` must yield `/users/x%3Fadmin%3D1`,
    // not a phantom `?admin=1` query. (An absent param keeps the literal placeholder — a
    // broken link, but not an injection.) The shared path MATCHER stays byte-for-byte with
    // its native twins (DSXPathMatch.swift / PathMatch.kt return raw segments), so decoding
    // is deliberately NOT added here — that is a tri-runtime decision, not a web-only one.
    const fill = (name: string, seg: string): string => {
      const v = params[name];
      return v === undefined ? seg : encodeURIComponent(string(v));
    };
    const filled = routePath
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) return fill(seg.substring(1), seg);
        if (seg.startsWith("{") && seg.endsWith("}")) return fill(seg.slice(1, -1), seg);
        return seg;
      })
      .join("/");
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) q.set(k, string(v));
    const qs = q.toString();
    return this.base + filled.replace(/^\//, "") + (qs.length > 0 ? `?${qs}` : "");
  }

  matchUrl(pathname: string): { route: RouteEntry; params: Dict } | null {
    const path = this.appPath(pathname);
    for (const route of this.routes) {
      const params = DSXPathMatch.match(path, route.path);
      if (params !== null) return { route, params };
    }
    return null;
  }

  /** guard predicates evaluate against a throwaway store — `global.*` reads reach DSXState
   *  through the JSE seam; the predicate can only READ state, never write (native parity) */
  private readonly guardStore = new ReactiveStore();

  /** Resolve a pathname against the table with the NATIVE Router's total semantics
   *  (Router.swift `resolved`): the capability gate (`requires` must all be shipped, else
   *  `route:route_unavailable` + fall through), the declarative guard (a bounded JSE
   *  predicate over `global.*`; falsy → follow `redirect`, depth-capped 8, else skip —
   *  fail-open), and unconditional redirect entries (no component). Returns the FINAL
   *  entry + params + the final app path, so callers can rewrite the URL 301-style. */
  resolveUrl(pathname: string, depth = 0): { route: RouteEntry; params: Dict; path: string } | null {
    const path = this.appPath(pathname);
    for (const route of this.routes) {
      const params = DSXPathMatch.match(path, route.path);
      if (params === null) continue;
      // A capability is satisfied by a PACKAGE or by a compiled-in COMPONENT — the same union
      // both natives apply (Router.kt `available()`, Router.swift). Checking modules alone made
      // web the odd renderer out: a route requiring a component-only capability resolved on iOS
      // and Android and fell through to route_unavailable here, one manifest rendering two apps.
      const missing = (route.requires ?? []).filter(
        (s) => !ModuleRegistry.isAvailable(s) && !(s in this.registry.components));
      if (missing.length > 0) {
        DSXEvents.publish("route:route_unavailable", { path, missing, reason: "missing_capability" });
        continue;
      }
      if (route.guard !== undefined && route.guard.length > 0 &&
          !truthy(JSE.eval(route.guard, this.guardStore.jse, null))) {
        if (route.redirect !== undefined && route.redirect.length > 0 &&
            route.redirect !== path && depth < 8) {
          return this.resolveUrl(this.base + route.redirect.replace(/^\//, ""), depth + 1);
        }
        continue;
      }
      if (route.redirect !== undefined && route.component === undefined) {
        // unconditional redirect entry ({ path: "/home", redirect: "/" })
        if (depth < 8) return this.resolveUrl(this.base + route.redirect.replace(/^\//, ""), depth + 1);
        return null;
      }
      return { route, params, path };
    }
    return null;
  }

  routeForComponent(qualified: string): RouteEntry | null {
    return this.routes.find((r) => r.component === qualified && r.redirect === undefined) ?? null;
  }

  /** the route.path this router last published — the pure-state observer compares against
   *  it so the router's own publishes never re-navigate (the native lastResolvedPath) */
  private lastResolvedPath: string | null = null;

  private publishRoute(): void {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return;
    this.lastResolvedPath = top.route?.path ?? null;
    DSXState.set("route", {
      path: top.route?.path ?? null,
      params: top.route?.params ?? {},
      query: top.route?.query ?? {},
      component: top.name,
    });
    // ── nav: the back-affordance plane. The native routers publish this contract already
    // (Kotlin Router.apply(): nav = { stack, canPop, depth, … }, pinned by RouterTest;
    // StackReference documents the reads: `nav.canPop` / `nav.depth` "for back
    // affordances"), and this renderer kept the stack private — so the documented
    // guarded-back pattern silently read absent here. Only NAVIGATION frames count, the
    // same scoping readiness reporting and chrome claims apply: chain sheets/covers and
    // overlays never enter nav.stack on any renderer. The native `modal`/`chrome` planes
    // are render-host contracts, not author reads, and stay native-side.
    const pages = this.frames.filter((f) => f.tier === "page");
    DSXState.set("nav", {
      stack: pages.map((f) => ({
        path: f.route?.path ?? null,
        params: f.route?.params ?? {},
        component: f.name,
      })),
      canPop: pages.length > 1,
      depth: pages.length,
    });
    // route meta drives the document title (the static exporter emits the same)
    const entry = this.routes.find((r) => r.component === top.name && r.redirect === undefined);
    const title = entry?.meta?.title;
    if (title !== undefined && typeof document !== "undefined") document.title = title;
  }

  // ── the frame stack ────────────────────────────────────────────────────────────────

  private resolve(name: string): ComponentIR | null {
    const direct = this.registry.components[name];
    if (direct) return direct;
    const bare = name.includes(".") ? name.substring(name.indexOf(".") + 1) : name;
    return resolveComponent(this.registry, "", bare);
  }

  /** DEV HOT-SWAP (master plan P2): adopt a freshly compiled registry and re-instantiate
   *  every live NAV frame in place, carrying each frame's plain declared-variable state
   *  across, so an edit repaints the running app without a page load and without losing
   *  what the person typed. Dev-lane only — the production bundle never calls this (the
   *  dev reload client owns the door in boot.ts); overlays and chain sheets are transient
   *  and are not carried; the deterministic recovery hatch (PREVIEW HATCH: 30 swaps or
   *  20 minutes) still hard-reloads on its own cadence, so any drift this carry cannot
   *  express — a renamed variable, a changed head shape — is bounded by construction. */
  hotSwap(registry: Registry): void {
    // optional fold (G10): a sliced embed never hot-swaps — the body sheds with the flag
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_EDIT_TAGS__?: boolean })
      .__DSX_OPTIONAL_EDIT_TAGS__ === false) return;
    if (this.disposed) return;
    (this as { registry: Registry }).registry = registry;
    (this as { routes: RouteEntry[] }).routes = registry.routes ?? [];
    this.motionCfg = registry.router;
    for (const frame of this.frames) {
      const ir = this.resolve(frame.name);
      if (ir === null) continue;
      const old = frame.instance;
      // carry every non-computed declared variable's CURRENT value, plus the router's
      // own pushed vars — written pre-mount through opts.vars, the same door the router
      // itself uses, so computeds and api blocks see the carried state from their very
      // first evaluation instead of a flash of initials.
      const carried: Dict = {};
      for (const v of ir.head.variables) {
        if (v.computed) continue;
        if (old.ctx.store.jse.vars.has(v.as)) carried[v.as] = old.ctx.store.jse.vars.get(v.as) ?? null;
      }
      if (old.ctx.store.jse.vars.has("vars")) carried["vars"] = old.ctx.store.jse.vars.get("vars") ?? null;
      const attrs = old.ctx.item as Dict;
      // the style-override plane survives a rebuild the same way attrs do: the verb
      // door's raw values live in the instance's dsx.override var
      const carriedOverrides = old.ctx.store.jse.vars.get("dsx.override");
      old.unmount();
      const next = instantiate(ir, this.registry, {
        attrs,
        ...(isDict(carriedOverrides) ? { overrides: carriedOverrides } : {}),
        vars: carried,
        component: (verb, n, opts) => this.handle(verb, n, opts, ir.scheme),
        frameId: frame.id,
      });
      frame.el.replaceChildren(next.root);
      frame.instance = next;
    }
  }

  /** The concrete route path a frame ABOUT to mount will carry — the same computation
   *  push() runs to fill `frame.route`, hoisted so the readiness report can name the
   *  screen before the frame object exists. This is the report's copy, never router
   *  state. A pathless frame reports null; the ROOT frame reports the "/" floor start()
   *  stamps a few lines later (the native `entry(path:)` seed). */
  private framePath(qualified: string, vars: Dict): string | null {
    const route = this.routeForComponent(qualified);
    if (route === null) return this.frames.length === 0 ? "/" : null;
    const params: Dict = {};
    for (const seg of route.path.split("/")) {
      if (seg.startsWith(":")) params[seg.substring(1)] = vars[seg.substring(1)] ?? "";
      else if (seg.startsWith("{") && seg.endsWith("}")) params[seg.slice(1, -1)] = vars[seg.slice(1, -1)] ?? "";
    }
    return this.appPath(new URL(this.toUrl(route.path, params, {}), "http://x").pathname);
  }

  private mountFrame(name: string, vars: Dict, tier: "page" | "sheet" | "cover", attrs?: Dict, overrides?: Dict): Frame | null {
    const ir = this.resolve(name);
    if (ir === null) {
      console.warn(`[dsx router] unknown component: ${name}`);
      return null;
    }
    const layer = document.createElement("div");
    layer.className = tier === "page" ? "dsx-frame" : `dsx-frame dsx-frame-${tier}`;
    layer.tabIndex = -1;
    // PLANES (present.ts): page frames z 10+ < the overlay plane (500) < chain frames
    // (sheet/cover) z 1000+ — a drawer always covers a menu-bar overlay.
    layer.style.zIndex = String((tier === "page" ? 10 : 1000) + this.frames.length);
    const frameId = nextFrameId++;
    // ── SCREEN READINESS (lifecycle/readiness.json) ────────────────────────────────
    // A frame this renderer paints itself is the DSXView analogue, so it reports through
    // the `view*` reporter (screen.ts explains why the tag is "native" on web too). Only
    // NAVIGATION frames report — chain sheets/covers and overlays never enter nav.stack
    // on the native routers, the same scoping navigationFrameIds() already applies to
    // chrome claims. `manual` is registered from the compiled ROOT node's `settle`
    // attribute BEFORE instantiate() runs the first render pass; `rendered` lands on a
    // microtask STRICTLY AFTER it — the one ordering obligation the corpus cannot express
    // (Conformance/lifecycle/README.md), and the reason a deferred screen is never
    // settled out from under itself.
    const reports = tier === "page";
    if (reports) {
      ScreenReadiness.mount(frameId, this.framePath(`${ir.scheme}.${ir.name}`, vars), NATIVE_SURFACE);
      if (settlesManually(ir.root.attrs)) ScreenReadiness.manual(frameId);
    }
    // ADOPT-HYDRATION (W6): on an SSR boot the server-rendered root for THIS
    // component is claimed and bound in place (adopt.ts); appendChild below then
    // moves the live element into the frame layer — identity preserved. No session
    // or no matching owner = null = the ordinary fresh mount, unchanged.
    const adoptRoot = claimAdoptRoot(ir.name);
    const instance = instantiate(ir, this.registry, {
      ...(attrs !== undefined ? { attrs } : {}),   // THE input contract → the reactive dsx.attribute dict
      ...(overrides !== undefined ? { overrides } : {}),   // the STYLE contract's verb door → dsx.override
      ...(adoptRoot !== null ? { adopt: adoptRoot } : {}),
      vars: { vars },
      component: (verb, n, opts) => this.handle(verb, n, opts, ir.scheme),
      frameId,
    });
    if (reports) queueMicrotask(() => ScreenReadiness.rendered(frameId));
    layer.appendChild(instance.root);
    this.host.appendChild(layer);
    const active = document.activeElement;
    const frame: Frame = {
      id: frameId,
      tier,
      name: `${ir.scheme}.${ir.name}`,
      el: layer,
      instance,
      route: null,
      master: false,
      motionOverride: undefined,
      restoreFocus: active instanceof HTMLElement && active !== document.body ? active : null,
    };
    this.frames.push(frame);
    return frame;
  }

  private focusFrame(frame: Frame): void {
    if (!this.interactive) return;
    queueMicrotask(() => {
      if (frame === this.frames[this.frames.length - 1] && frame.el.isConnected && !frame.el.inert) {
        frame.el.focus({ preventScroll: true });
      }
    });
  }

  private prepareFocusRestore(frame: Frame): void {
    if (this.interactive && frame.restoreFocus?.isConnected === true) {
      this.pendingFocusRestore = frame.restoreFocus;
    }
  }

  private popFrame(): void {
    if (this.frames.length <= 1) return; // the root frame stays
    this.echoGuard.clear();              // a reduction re-arms the double-tap echo guard (native)
    const top = this.frames.pop()!;
    ScreenReadiness.release(top.id); // no late viewFinish after the screen is gone
    this.prepareFocusRestore(top);
    for (const [id, fr] of this.chainFrames) {
      if (fr === top) {
        // a chain frame popped by the stack itself (browser Back through a sheet) — keep
        // the presentation ledger truthful without re-running the dismissal topology
        this.chainFrames.delete(id);
        this.ledger.removeById(id);
        break;
      }
    }
    top.instance.unmount();
    top.el.remove();
    this.sharedFlight?.finish();   // an instant pop has no flight to finish; a torn-down one does
    this.clearMotionRest();
  }

  push(name: string, vars: Dict = {}, opts: { fromHistory?: boolean; query?: Dict; attrs?: Dict; overrides?: Dict; fromUrl?: boolean; entryKey?: string } = {}): void {
    if (this.disposed) return;   // see navigatePath: a disposed router mounts nothing, ever
    // bank the outgoing entry's scroll BEFORE the new frame mounts (a history-driven push
    // is the tail of a traversal that already banked, or of boot, which has nothing to bank)
    if (opts.fromHistory !== true) this.captureScroll();
    // The double-tap echo guard (Router.kt/.swift pushNative → isEcho): a NAMED push identical
    // to the one just before it, inside 500ms, is one tap dispatched twice while the transition
    // is still covering the screen — dropped, never a second frame. Boot/history re-mounts
    // (fromHistory) and URL pushes (navigatePath sets fromUrl — route.push/href/route.path stay
    // untouched, native rule) bypass it, exactly like the native call sites.
    if (opts.fromHistory !== true && opts.fromUrl !== true && name.length > 0 &&
        this.echoGuard.isEcho(echoKey("push", name, "", vars, opts.attrs, opts.overrides))) {
      console.warn(`[dsx router] push("${name}") dropped — identical to the push just before it (double-tap echo)`);
      return;
    }
    const frame = this.mountFrame(name, vars, "page", opts.attrs, opts.overrides);
    if (frame === null) return;
    const route = this.routeForComponent(frame.name);
    frame.master = route?.master === true;
    frame.motionOverride = route?.motion;
    const query = opts.query ?? {};
    if (route !== null) {
      const params: Dict = {};
      for (const seg of route.path.split("/")) {
        if (seg.startsWith(":")) params[seg.substring(1)] = vars[seg.substring(1)] ?? "";
        else if (seg.startsWith("{") && seg.endsWith("}")) params[seg.slice(1, -1)] = vars[seg.slice(1, -1)] ?? "";
      }
      frame.route = { path: this.appPath(new URL(this.toUrl(route.path, params, {}), "http://x").pathname), params, query };
      if (this.historyLive && opts.fromHistory !== true) {
        this.pushEntry(this.frames.length, this.toUrl(route.path, params, query), opts.entryKey);
      }
    } else if (this.historyLive && opts.fromHistory !== true) {
      // pathless frame — history entry, URL unchanged (/web/04)
      this.pushEntry(this.frames.length, location.href, opts.entryKey);
    }
    this.notify();
    // U03: the pairs fly BEFORE the frame animation, so the layer is already painted at
    // progress 0 when the first frame of the push renders (no one-frame flash of the
    // destination's real node).
    this.startSharedFlight(this.frames[this.frames.length - 2], frame, "forward");
    this.animatePush(frame);
    // A11Y: focus moves to the destination at transition START, not end, so a screen-reader
    // user is never narrating a moving snapshot (SHARED_A11Y_FOCUS).
    this.focusFrame(frame);
  }

  pop(): void {
    if (this.frames.length <= 1) return;
    if (this.historyLive) {
      history.back(); // the popstate handler pops the frame — one source of truth
      return;
    }
    this.popTop(this.frameKind(this.frames[this.frames.length - 1]!));
  }

  /** popTo — back to the deepest frame whose path matches (see deepestPathMatch): ONE
   *  truncation instead of N chained pops (RN popTo / Flutter popUntil parity). No match or
   *  already the top → no-op (the funnel's guard). KNOWN v1 DIVERGENCE, pinned: presented
   *  sheets ride this same frame stack as pathless frames (`present()` — /web/04), so a
   *  multi-pop passes THROUGH an open sheet and dismisses it; the native runtimes keep
   *  `nav.modal` presentations alive across stack verbs. Aligns when W4 moves web sheets onto
   *  the modal tier. */
  popTo(path: string): void {
    const idx = deepestPathMatch(this.frames.map((f) => f.route?.path ?? null), path);
    if (idx < 0) return;
    this.truncateTo(idx + 1);
  }

  /** popToRoot — back to the root frame (RN popToTop). At root → no-op. Same pinned sheet
   *  divergence as popTo. */
  popToRoot(): void {
    this.truncateTo(1);
  }

  /** The one multi-pop funnel. The FRAME stack truncates SYNCHRONOUSLY — a verb chained after
   *  this one in the same action sees the final stack, exactly like the native runtimes
   *  (history.go alone would leave the stack stale until its popstate lands). With live
   *  history, ONE `history.go` jump then re-aligns the URL; its popstate arrives later and is
   *  consumed as an echo (see the handler) — including the chained-push case, where the echo
   *  re-asserts the newer frames' entries instead of tearing them down. A no-op unless it
   *  strictly reduces depth (never below root) — the same guard as the native `truncate`. */
  private truncateTo(depth: number): void {
    if (depth < 1 || depth >= this.frames.length) return;
    const delta = depth - this.frames.length;
    while (this.frames.length > depth) this.popFrame();
    this.notify();
    if (this.historyLive) {
      this.pendingTruncation = depth;
      history.go(delta);
    }
  }

  // ── opt-in DSX Web motion (motion.ts owns the policy/constants; this is the DOM half) ──

  /** the lane decision for RIGHT NOW — reduced-motion always wins with "none" */
  private motionKind(): MotionKind {
    if (this.reducedMotion()) return "none";
    return motionFor(this.motionCfg, this.motionTheme, this.viewportWidth(), this.interactive);
  }

  /** a frame's effective motion: the route-level `motion` override rides the lane —
   *  "none" always wins; a family override applies only when the lane animates at all
   *  (interactive, breakpoint, reduced-motion still gate — the F7 options.animate /
   *  transition pair collapsed to one key). */
  private frameKind(frame: Frame): MotionKind {
    if (frame.motionOverride === "none") return "none";
    const lane = this.motionKind();
    if (lane === "none") return "none";
    return frame.motionOverride ?? lane;
  }

  private reducedMotion(): boolean {
    return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private viewportWidth(): number {
    return typeof window !== "undefined" ? window.innerWidth : Number.MAX_SAFE_INTEGER;
  }

  /** the under-page dim overlay (created on demand, removed when its transition ends) */
  private dimFor(el: HTMLElement): HTMLElement {
    let dim = el.querySelector<HTMLElement>(":scope > .dsx-motion-dim");
    if (dim === null) {
      dim = document.createElement("div");
      dim.className = "dsx-motion-dim";
      el.appendChild(dim);
    }
    return dim;
  }

  /** Expose the active family to CSS without leaving compatibility decoration behind
   *  after an animation settles. Only `ios` consumes an edge-shadow rule. */
  private markMotion(el: HTMLElement, kind: MotionFamily, active: boolean): void {
    el.classList.toggle("dsx-motion-top", active);
    for (const family of ["dsx", "ios", "md"] as const) {
      el.classList.toggle(`dsx-motion-${family}`, active && family === kind);
    }
  }

  /** reset persisted parallax/dim on the newly-revealed top (instant pops, lane flips) */
  private clearMotionRest(): void {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return;
    top.el.style.transform = "";
    this.markMotion(top.el, "dsx", false);
    top.el.querySelector(":scope > .dsx-motion-dim")?.remove();
  }

  /** master-detail split classes (wide lane) — cheap class toggles, runs on every notify
   *  + resize, so crossing the breakpoint re-lays-out live. The master pane is pinned by
   *  CSS (`transform: none !important`) and skipped by every animation below. */
  private applyLayout(): void {
    const bp = this.motionCfg?.masterDetailBreakpoint ?? MASTER_DETAIL_DEFAULT;
    const mi = this.motionCfg === undefined
      ? -1
      : splitMasterIndex(this.frames.map((f) => f.master), this.viewportWidth(), bp);
    this.host.classList.toggle("dsx-split", mi >= 0);
    this.frames.forEach((f, i) => {
      f.el.classList.toggle("dsx-master", i === mi);
      f.el.classList.toggle("dsx-detail", mi >= 0 && i > mi);
      // covered frames leave the a11y tree (the F7 aria-hidden sync): visible = the top,
      // plus the pinned master in a split
      const visible = i === this.frames.length - 1 || i === mi;
      f.el.setAttribute("aria-hidden", visible ? "false" : "true");
      f.el.inert = !visible;
    });
  }

  // ── U03 shared element transitions ────────────────────────────────────────────────────
  //
  // The router's whole part is: hand the two frame ELEMENTS to the flight at the moment a
  // transition starts, and hand the finger to it when a gesture interrupts one. Which ids
  // pair, where a pair is at a given progress, and what an interruption does are all the
  // platform-neutral core's (Conformance/router/shared.json).

  /** Fly the `shared=` pairs between two frames. A frame pair with nothing in common (or a
   *  browser with neither View Transitions nor WAAPI) returns null and the caller runs the
   *  ordinary transition untouched — the unmatched law: never an error, never a flash. */
  private startSharedFlight(source: Frame | undefined, destination: Frame | undefined,
                            direction: "forward" | "reverse"): void {
    this.sharedFlight?.finish();
    this.sharedFlight = null;
    // THE SILENCE RULE: boot-path mounts never fly a pair either.
    if (!this.interactive || source === undefined || destination === undefined) return;
    // Reduced motion does NOT disable the flight — the core downgrades `move` to `crossfade`,
    // which is an honest degradation rather than a feature the user loses.
    if (sharedSupport() === "unsupported") return;
    const flight = SharedFlight.create(this.host, source.el, destination.el, {
      reducedMotion: this.reducedMotion(),
      durationMs: this.frameKind(destination) === "md" ? MD_MS : IOS_MS,
    });
    if (flight === null) return;
    this.sharedFlight = flight;
    flight.begin(direction, () => { if (this.sharedFlight === flight) this.sharedFlight = null; });
  }

  /** The gesture asking to take an in-flight transition over. Returns the progress it adopted
   *  (1 when it armed a fresh flight), or null when there is nothing to fly. */
  private adoptSharedFlight(top: Frame, under: Frame | undefined): number | null {
    const live = this.sharedFlight;
    if (live !== null) return live.interrupt();
    if (under === undefined) return null;
    const flight = SharedFlight.create(this.host, under.el, top.el, {
      reducedMotion: this.reducedMotion(),
      durationMs: IOS_MS,
    });
    if (flight === null) return null;
    this.sharedFlight = flight;
    flight.beginInteractive(() => { if (this.sharedFlight === flight) this.sharedFlight = null; });
    return 1;
  }

  // ── F07b `lockOrientation=` ────────────────────────────────────────────────────────────

  /** Every live surface that declares `lockOrientation`, bottom-of-stack first — page frames
   *  in stack order, then the presented chain and overlay entries, which is the order the
   *  shared claim stack has to see them in. Read off the MOUNTED root, so a value the compiler
   *  could not know statically is the one that reaches the module. */
  private orientationSurfaces(): OrientationSurface[] {
    const out: OrientationSurface[] = [];
    const read = (el: HTMLElement, surface: string): void => {
      // The SURFACE ROOT only: a `lockOrientation` deeper in a screen is not this attribute
      // (F07 §3a — it is declared on a route frame or a presented surface, not on any box).
      const to = (el.firstElementChild as HTMLElement | null)
        ?.getAttribute("data-dsx-lock-orientation")?.trim();
      if (to !== undefined && to !== "") out.push({ surface, to });
    };
    for (const frame of this.frames) {
      if (this.chainFrames.size > 0 && [...this.chainFrames.values()].includes(frame)) continue;
      read(frame.el, orientationFrameSurface(frame.id));
    }
    for (const [id, frame] of this.chainFrames) read(frame.el, orientationModalSurface(id));
    for (const [id, overlay] of this.overlayViews) read(overlay.el, orientationModalSurface(id));
    return out;
  }

  /** Reconcile the claims against what is on screen NOW. Called from notify(), so a button pop,
   *  an edge-swipe back, a modal drag-dismiss and a deep link that replaces the whole stack all
   *  revert through this ONE funnel rather than five hand-written undo sites — and a merely
   *  COVERED screen (still in `frames`) correctly keeps its claim. */
  private syncOrientation(): void {
    const plan = orientationClaimPlan(this.orientationSurfaces(), this.orientationClaims);
    this.orientationClaims = plan.ledger;
    for (const op of plan.ops) {
      // Over the BUS, because the module is excludable: an absent `orientation` scheme means
      // the call rejects and nothing happens, which is exactly the pre-module behaviour
      // (Article 7). The kernel never names the module's internals or holds its claim stack.
      const args = op.op === "release" ? { surface: op.surface } : { surface: op.surface, to: op.to };
      ModuleRegistry.call(`orientation.${op.op}`, args).catch(() => {});
    }
  }

  /** animate an interactive push — boot-path mounts never reach here (the silence rule),
   *  sheets keep their own presentation, a master under-pane never moves. */
  private animatePush(frame: Frame): void {
    const kind = this.frameKind(frame);
    if (kind === "none" || frame.el.classList.contains("dsx-frame-sheet")
        || frame.el.classList.contains("dsx-frame-cover")) return;
    if (typeof frame.el.animate !== "function") return;
    const under = this.frames[this.frames.length - 2];
    this.animating = true;
    const done = (): void => {
      if (this.disposed) return;   // the plan advanced mid-animation; this router owns nothing now
      this.animating = false;
      this.markMotion(frame.el, kind, false);
    };
    this.markMotion(frame.el, kind, true);
    if (kind === "ios") {
      if (under !== undefined && !under.el.classList.contains("dsx-master")) {
        const dim = this.dimFor(under.el);
        dim.animate([{ opacity: "0" }, { opacity: String(IOS_DIM_PEAK) }],
                    { duration: IOS_MS, easing: IOS_EASING })
          .finished.then(() => dim.remove()).catch(() => dim.remove());
        under.el.animate([{ transform: "translateX(0)" }, { transform: `translateX(${IOS_PARALLAX}%)` }],
                         { duration: IOS_MS, easing: IOS_EASING });
        under.el.style.transform = `translateX(${IOS_PARALLAX}%)`; // the covered rest state (F7 page-previous)
      }
      const a = frame.el.animate([{ transform: "translateX(100%)" }, { transform: "translateX(0)" }],
                                 { duration: IOS_MS, easing: IOS_EASING });
      a.finished.then(done).catch(done);
    } else if (kind === "md") {
      const a = frame.el.animate([{ transform: `translateY(${MD_RISE_PX}px)`, opacity: "0" },
                                  { transform: "translateY(0)", opacity: "1" }],
                                 { duration: MD_MS, easing: MD_EASING });
      a.finished.then(done).catch(done);
    } else {
      const a = frame.el.animate(
        dsxRouteFrames("enter"),
        { duration: DSX_MS, easing: DSX_EASING },
      );
      a.finished.then(done).catch(done);
    }
  }

  /** pop the top frame WITH an exit animation: the frame leaves `frames` synchronously
   *  (state parity with the native runtimes — chained verbs see the final stack), its
   *  element stays for the way-out render and unmounts when the animation finishes — the
   *  web twin of the native release hold (Stack.swift releasePushed). */
  private popTop(kind: MotionKind): void {
    if (this.frames.length <= 1) return;
    this.echoGuard.clear();             // a reduction re-arms the double-tap echo guard (native)
    if (kind === "none" || typeof this.frames[this.frames.length - 1]!.el.animate !== "function") {
      this.popFrame();
      this.notify();
      return;
    }
    const top = this.frames.pop()!;
    ScreenReadiness.release(top.id); // the frame left the stack — the element lingers only for the way-out render
    this.prepareFocusRestore(top);
    top.el.inert = true;
    top.el.setAttribute("aria-hidden", "true");
    const under = this.frames[this.frames.length - 1];
    this.notify();
    // U03: the pop is the same flight run backwards — source is the frame being REVEALED,
    // destination the one leaving, so progress 1 is where the screen already is.
    this.startSharedFlight(under, top, "reverse");
    this.animating = true;
    const done = (): void => {
      // THIS frame is released unconditionally, disposed or not: `popTop` took it out of
      // `this.frames` before the animation started, and dispose() only walks `this.frames` —
      // so dispose() never saw it and this is its ONLY unmount. Skipping it would strand the
      // component's teardown forever: unmount() is what runs ctx.disposers, disposes every
      // <api> block, clears env timers and disposes the store, so a polling block on a dead
      // screen would keep firing into the state the live candidate reads.
      top.instance.unmount();
      top.el.remove();
      // The router-level tail is what a disposed router must not run: `animating` belongs to a
      // router nobody drives any more, and clearMotionRest() reaches into the host through a
      // reference the NEXT candidate now owns.
      if (this.disposed) return;
      this.animating = false;
      this.clearMotionRest();
    };
    this.markMotion(top.el, kind, true);
    if (kind === "ios") {
      if (under !== undefined && !under.el.classList.contains("dsx-master")) {
        const dim = this.dimFor(under.el);
        dim.animate([{ opacity: String(IOS_DIM_PEAK) }, { opacity: "0" }],
                    { duration: IOS_MS, easing: IOS_EASING })
          .finished.then(() => dim.remove()).catch(() => dim.remove());
        const from = under.el.style.transform === "" ? "translateX(0)" : under.el.style.transform;
        under.el.style.transform = "";
        under.el.animate([{ transform: from }, { transform: "translateX(0)" }],
                         { duration: IOS_MS, easing: IOS_EASING });
      }
      const a = top.el.animate([{ transform: "translateX(0)" }, { transform: "translateX(100%)" }],
                               { duration: IOS_MS, easing: IOS_EASING });
      a.finished.then(done).catch(done);
    } else if (kind === "md") {
      const a = top.el.animate([{ transform: "translateY(0)", opacity: "1" },
                                { transform: `translateY(${MD_RISE_PX}px)`, opacity: "0" }],
                               { duration: MD_MS, easing: MD_EASING });
      a.finished.then(done).catch(done);
    } else {
      const a = top.el.animate(
        dsxRouteFrames("exit"),
        { duration: DSX_MS, easing: DSX_EASING },
      );
      a.finished.then(done).catch(done);
    }
  }

  /** The F7 iosSwipeBack twin: ARM within SWIPE_EDGE_PX of the left edge, ENGAGE after a
   *  6px slop (so edge taps never flash the under-page), drag the top frame live with the
   *  under-page parallax + dim following the finger, and on release either complete —
   *  threshold distance or a flick (motion.ts swipeCompletes) — through the SAME history
   *  path a Back press takes, or spring back. Mobile-ios lane only (swipeEnabled). */
  private attachSwipeBack(): void {
    let armed = false, tracking = false;
    let startX = 0, startT = 0, width = 1;
    let top: Frame | null = null, under: Frame | null = null, dim: HTMLElement | null = null;

    /** the shared-element flight this gesture owns — armed fresh, or ADOPTED mid-push */
    let flight: SharedFlight | null = null;

    const cleanup = (): void => {
      armed = false; tracking = false; top = null; under = null; dim = null;
      flight = null;
      window.removeEventListener("pointermove", onMove);
    };

    const settle = (commit: boolean, dx: number): void => {
      if (top === null) { cleanup(); return; }
      const t = top, u = under, d = dim;
      const p = Math.min(1, dx / width);
      const ms = Math.max(80, IOS_MS * (commit ? 1 - p : p));
      this.animating = true;
      if (u !== null && !u.el.classList.contains("dsx-master")) {
        u.el.style.transform = "";
        u.el.animate([{ transform: `translateX(${IOS_PARALLAX * (1 - p)}%)` },
                      { transform: `translateX(${commit ? 0 : IOS_PARALLAX}%)` }],
                     { duration: ms, easing: IOS_EASING });
        if (!commit) u.el.style.transform = `translateX(${IOS_PARALLAX}%)`;
        if (d !== null) {
          d.animate([{ opacity: String(IOS_DIM_PEAK * (1 - p)) },
                     { opacity: commit ? "0" : String(IOS_DIM_PEAK) }],
                    { duration: ms, easing: IOS_EASING })
            .finished.then(() => d.remove()).catch(() => d.remove());
        }
      }
      // U03: the flight settles with the frame — commit reverses it home to the source, cancel
      // resumes it forward. Either way it travels only what is LEFT, never a full replay.
      flight?.release(commit);
      const a = t.el.animate([{ transform: `translateX(${dx}px)` },
                              { transform: commit ? "translateX(100%)" : "translateX(0)" }],
                             { duration: ms, easing: IOS_EASING });
      const finish = (): void => {
        // A swipe that lands after the root plan advanced must not drive history or pop a
        // stack this router no longer owns — `history.back()` here would move the LIVE
        // candidate's URL out from under it.
        if (this.disposed) return;
        this.animating = false;
        t.el.style.transform = commit ? "translateX(100%)" : "";
        if (!commit) this.markMotion(t.el, "ios", false);
        if (commit) {
          // the visual already played — the state pop rides the normal history path, instant
          this.skipNextPopMotion = true;
          if (this.historyLive) history.back();
          else { this.popFrame(); this.notify(); }
        }
      };
      a.finished.then(finish).catch(finish);
      cleanup();
    };

    const onMove = (e: PointerEvent): void => {
      if (!armed || top === null) return;
      const dx = Math.max(0, e.clientX - startX);
      if (!tracking) {
        if (dx < 6) return; // slop — edge taps never engage
        tracking = true;
        this.markMotion(top.el, "ios", true);
        // THE ACCEPTANCE TEST. A gesture starting while a push is still in the air ADOPTS that
        // flight where it is — it does not restart it and it does not snap it to either end.
        this.adoptSharedFlight(top, under ?? undefined);
        flight = this.sharedFlight;
        if (under !== null && !under.el.classList.contains("dsx-master")) {
          under.el.style.transform = `translateX(${IOS_PARALLAX}%)`;
          dim = this.dimFor(under.el);
          dim.style.opacity = String(IOS_DIM_PEAK);
        }
      }
      const p = Math.min(1, dx / width);
      top.el.style.transform = `translateX(${dx}px)`;
      if (under !== null && !under.el.classList.contains("dsx-master")) {
        under.el.style.transform = `translateX(${IOS_PARALLAX * (1 - p)}%)`;
        if (dim !== null) dim.style.opacity = String(IOS_DIM_PEAK * (1 - p));
      }
      // U03: the finger drives the pairs on the SAME progress axis as the frame. `1 - p`
      // because the gesture measures how far the top has travelled AWAY, while the flight
      // measures how close it still is TO the destination.
      flight?.drag(1 - p);
      e.preventDefault();
    };

    const onUp = (e: PointerEvent): void => {
      if (!armed) return;
      if (!tracking) { cleanup(); return; }
      const dx = Math.max(0, e.clientX - startX);
      settle(swipeCompletes(dx, width, e.timeStamp - startT), dx);
    };

    // Bound on the SHARED host element, so it must be removable: the host outlives this
    // router (the root plan reuses it for the next candidate) and would otherwise accumulate
    // one live edge-swipe handler per attempt.
    const onDown = (e: PointerEvent): void => {
      // U03: an in-flight SHARED transition is interruptible by contract, so `animating` no
      // longer bars the gesture when one is up — that bar is exactly what produces a snap.
      const interruptible = this.sharedFlight?.running === true;
      if (!e.isPrimary || e.clientX > SWIPE_EDGE_PX || this.reducedMotion()) return;
      if (this.animating && !interruptible) return;
      if (!swipeEnabled(this.motionCfg, this.motionTheme, this.viewportWidth(), this.frames.length)) return;
      const t = this.frames[this.frames.length - 1]!;
      if (t.el.classList.contains("dsx-frame-sheet") || t.el.classList.contains("dsx-frame-cover")) return;
      armed = true; tracking = false;
      if (interruptible) {
        // Stop the push mid-air and CONTINUE from the pose it reached: seeding startX with the
        // frame's live translation is what keeps the screen from jumping under the finger.
        for (const running of t.el.getAnimations()) running.cancel();
        const live = new DOMMatrixReadOnly(getComputedStyle(t.el).transform).m41;
        t.el.style.transform = `translateX(${live}px)`;
        this.animating = false;
        startX = e.clientX - live; startT = e.timeStamp;
      } else {
        startX = e.clientX; startT = e.timeStamp;
      }
      width = Math.max(1, this.host.clientWidth);
      top = t;
      under = this.frames[this.frames.length - 2] ?? null;
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp, { once: true });
      window.addEventListener("pointercancel", onUp, { once: true });
    };
    this.host.addEventListener("pointerdown", onDown);
    this.teardown.push(() => {
      this.host.removeEventListener("pointerdown", onDown);
      cleanup();   // a dispose mid-gesture must not leave the window move/up pair behind
    });
  }

  /** `dsx.component.present` — the state-backed presentation machine on this renderer
   *  (present.ts owns normalization + topology; present.json pins both). `opts`:
   *  `{ as?: "sheet"|"cover"|"overlay", touch?: "passthrough"|"block", vars? }`.
   *  sheet/cover mount as CHAIN frames (pathless, one history entry — the pinned v1 shape:
   *  they ride the frame stack); an OVERLAY mounts into the overlay PLANE — no frame, no
   *  history entry (dismissed by verb, never by Back — the native contract), with the touch
   *  mode expressed in CSS (theme.ts): passthrough keeps everything beside the overlay's
   *  interactive content live; block stops every pointer at the layer. */
  present(name: string, opts: Dict = {}): void {
    const rawVars = opts["vars"];
    const vars = (typeof rawVars === "object" && rawVars !== null ? rawVars : {}) as Dict;
    const rawAttrs = opts["attrs"];
    const attrs = (typeof rawAttrs === "object" && rawAttrs !== null ? rawAttrs : undefined) as Dict | undefined;
    const rawOverrides = opts["overrides"];
    const overrides = (isDict(rawOverrides) ? rawOverrides : undefined) as Dict | undefined;
    // The double-tap echo guard (Router.kt/.swift presentModal → isEcho): an identical
    // consecutive present of the same component + mode + seeds, inside 500ms, is one tap
    // dispatched twice — dropped before anything mounts (the ledger is untouched on a drop,
    // native ordering). The mode is the RAW `as` word (native keys on it too).
    const mode = typeof opts["as"] === "string" ? (opts["as"] as string) : "";
    if (name.length > 0 && this.echoGuard.isEcho(echoKey(`present:${mode}`, name, "", vars, attrs, overrides))) {
      console.warn(`[dsx router] present("${name}") dropped — identical to the present just before it (double-tap echo)`);
      return;
    }
    const entry = this.ledger.add(name, opts["as"] as string | undefined,
                                  opts["touch"] as string | undefined, attrs);
    if (entry.as === "overlay") {
      const ir = this.resolve(name);
      if (ir === null) {
        console.warn(`[dsx router] unknown component: ${name}`);
        this.ledger.removeById(entry.id);
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = entry.touch === "block" ? "dsx-overlay dsx-overlay-block" : "dsx-overlay";
      // Overlays receive a stamp too, but are intentionally absent from
      // navigationFrameIds(): a system NavBar inside a modal must not restyle the
      // application bar underneath it (native route.chrome targeting parity).
      const frameId = nextFrameId++;
      const instance = instantiate(ir, this.registry, {
        ...(entry.attrs !== undefined ? { attrs: entry.attrs as Dict } : {}),
        ...(overrides !== undefined ? { overrides } : {}),
        vars: { vars },
        component: (v, n, o) => this.handle(v, n, o, ir.scheme),
        frameId,
      });
      wrap.appendChild(instance.root);
      this.ensureOverlayPlane().appendChild(wrap);
      this.overlayViews.set(entry.id, { el: wrap, instance });
      this.notify();
      return;
    }
    const frame = this.mountFrame(name, vars, entry.as, attrs, overrides);
    if (frame === null) {
      this.ledger.removeById(entry.id);
      return;
    }
    this.chainFrames.set(entry.id, frame);
    // U03: `present` behaves exactly like `push` — the same pairs, the same schedule. The
    // sheet's own detent is the container's business, not the flight's.
    this.startSharedFlight(this.frames[this.frames.length - 2], frame, "forward");
    if (this.historyLive) {
      // The sheet's own history entry now CARRIES it: `#sheet=<Name>` on the current URL.
      // Back (or dismiss(), which drives history.go) unwinds to the previous entry and the
      // fragment goes with it — no bookkeeping, the browser owns the restore.
      const url = this.restoringFragment ? location.href : sheetFragmentUrl(location.href, name);
      if (this.restoringFragment) this.replaceEntry(this.frames.length, url);
      else { this.captureScroll(); this.pushEntry(this.frames.length, url); }
    }
    this.notify();
    this.focusFrame(frame);
  }

  /** dismiss([target]) — the topology lives in PresentLedger (present.json). Overlays unmount
   *  from the plane only; a chain removal truncates the frame stack to below the deepest
   *  removed chain frame (the pinned v1 sheets-on-stack divergence: pages pushed above it pop
   *  too). Empty ledger / unmatched target = documented no-op. */
  dismiss(target?: string): void {
    const gone = this.ledger.remove(target ?? null);
    if (gone.length === 0) return;
    this.echoGuard.clear();             // a modal removal re-arms the double-tap echo guard (native)
    let minChainIdx = -1;
    for (const e of gone) {
      const ov = this.overlayViews.get(e.id);
      if (ov !== undefined) {
        ov.instance.unmount();
        ov.el.remove();
        this.overlayViews.delete(e.id);
        continue;
      }
      const fr = this.chainFrames.get(e.id);
      if (fr !== undefined) {
        const i = this.frames.indexOf(fr);
        if (i > 0 && (minChainIdx < 0 || i < minChainIdx)) minChainIdx = i;
        this.chainFrames.delete(e.id);
      }
    }
    if (minChainIdx > 0) this.truncateTo(minChainIdx);
    else this.notify();
  }

  /** the overlay PLANE host (z 500 — between page frames and chain frames; theme.ts) */
  private ensureOverlayPlane(): HTMLElement {
    if (this.overlayPlaneEl !== null && this.overlayPlaneEl.isConnected) return this.overlayPlaneEl;
    const plane = document.createElement("div");
    plane.className = "dsx-overlay-plane";
    this.host.appendChild(plane);
    this.overlayPlaneEl = plane;
    return plane;
  }

  private discardTop(): void {
    const top = this.frames.pop();
    if (top === undefined) return;
    this.echoGuard.clear();             // replace/reset are reductions too — re-arm the guard (native)
    ScreenReadiness.release(top.id);
    top.instance.unmount();
    top.el.remove();
  }

  /** Navigate to a URL path — resolve it against the route table (guards, capability gates
   *  and redirects included — `resolveUrl`), then GROW (push), SWAP the top (replace), or
   *  CLEAR-to-root (reset) the frame stack. The web twin of the native
   *  route.push/replace/reset verbs; an unresolvable path warns and no-ops (never a blank
   *  frame). Returns whether the path resolved (the `href` interception's signal). */
  navigatePath(path: string, mode: "push" | "replace" | "reset"): boolean {
    // A DISPOSED router navigates nothing. Releasing the link seam stops `<a href>` from
    // reaching a dead router, but `configureRouter` already handed this instance to whoever
    // wanted it — the Routing package parks it in a module-level global with no unbind — so the
    // refusal has to live on the router itself. Without this, a `route.push` after the plan
    // exhausted appends a live frame on top of the kernel boot diagnostic.
    if (this.disposed) return false;
    const url = new URL(path, "http://x");
    const m = this.resolveUrl(url.pathname);
    if (m === null || m.route.component === undefined) {
      console.warn(`[dsx router] route.${mode}: no component route for ${path}`);
      return false;
    }
    const component = m.route.component;
    const query: Dict = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const vars: Dict = { ...m.params, ...query };
    // fromUrl: a route.push/href/route.path navigation is NOT a double-tap-prone named push —
    // the native runtimes leave URL pushes untouched by the echo guard (only dsx.component.push
    // is guarded). This is the one flag that keeps that split on web.
    if (mode === "push") { this.push(component, vars, { query, fromUrl: true }); return true; }
    // replace swaps the current top; reset first clears every frame above the root
    if (mode === "reset") { while (this.frames.length > 1) this.discardTop(); }
    this.discardTop();
    const frame = this.mountFrame(component, vars, "page");
    if (frame !== null) {
      frame.route = { path: m.path, params: m.params, query };
      if (this.historyLive) {
        this.replaceEntry(this.frames.length, this.toUrl(m.route.path, m.params, query));
      }
    }
    this.notify();
    if (frame !== null) this.focusFrame(frame);
    return true;
  }

  // ── links (`href=` — the anchor attribute) ─────────────────────────────────────────

  /** The document URL an `href` path renders as (base-joined, so anchors stay correct
   *  under any serving sub-path) — the crawlable/cmd-clickable form. */
  hrefUrl(path: string): string {
    if (!path.startsWith("/")) return path; // external / relative — the browser's business
    return this.base + path.replace(/^\//, "");
  }

  /** SPA-navigate a clicked link: resolves through the route table (guards included) and
   *  pushes. False = not ours (unmatched) — the caller lets the browser take the click. */
  navigateHref(path: string): boolean {
    return this.navigatePath(path, "push");
  }

  /** Re-publish the current route (route.sync) — the web route table is build-static, so
   *  beyond re-notifying there is nothing to re-resolve in v1 (the native verb re-resolves the
   *  live frame after an OTA route-table write). */
  sync(): void {
    this.notify();
  }

  handle(verb: string, name: string, opts: Dict, callerScheme: string): void {
    const qualified = name.includes(".") || name.length === 0 ? name : `${callerScheme}.${name}`;
    switch (verb) {
      case "push": {
        // the native contract: `attrs` is THE component input (the hard-coded-markup twin,
        // Router.swift/.kt pushComponent); `vars` stays the legacy seed namespace;
        // `overrides` is the style contract's verb door
        const rawVars = opts["vars"];
        const rawAttrs = opts["attrs"];
        const rawOverrides = opts["overrides"];
        this.push(qualified, (typeof rawVars === "object" && rawVars !== null ? rawVars : {}) as Dict, {
          ...(typeof rawAttrs === "object" && rawAttrs !== null ? { attrs: rawAttrs as Dict } : {}),
          ...(isDict(rawOverrides) ? { overrides: rawOverrides } : {}),
        });
        break;
      }
      case "present": this.present(qualified, opts); break;
      case "update": {
        const rawAttrs = opts["attrs"];
        const rawOverrides = opts["overrides"];
        this.updateAttrs(name.length > 0 ? qualified : undefined,
                         (typeof rawAttrs === "object" && rawAttrs !== null ? rawAttrs : {}) as Dict,
                         (isDict(rawOverrides) ? rawOverrides : {}) as Dict);
        break;
      }
      case "pop": this.pop(); break;
      case "dismiss": this.dismiss(name.length > 0 ? qualified : undefined); break;
      default: console.warn(`[dsx router] unknown verb: ${verb}`);
    }
  }

  /** LIVE attribute updates on an open frame/modal (the reactive half of the attribute
   *  contract): merges into the ledger entry's `attrs` (the state record) and re-seeds the
   *  mounted instance's reactive `dsx.attribute` store, so bindings recalc — presented
   *  entries first (the dismiss matching rule), then pushed page frames by component name.
   *  Unmatched = documented no-op. */
  updateAttrs(target: string | undefined, attrs: Dict, overrides: Dict = {}): void {
    if (Object.keys(attrs).length === 0 && Object.keys(overrides).length === 0) return;
    // one instance write per plane the caller supplied — attrs merge into the ledger
    // entry (the state record, native contract); overrides re-seed the live instance's
    // dsx.override var (the style plane keeps no entry record in v1)
    const reseed = (inst: Instance): void => {
      const store = inst.ctx.store;
      if (Object.keys(attrs).length > 0) {
        const current = (store.jse.vars.get("dsx.attribute") as Dict | undefined) ?? {};
        store.set("dsx.attribute", { ...current, ...attrs });
      }
      if (Object.keys(overrides).length > 0) {
        const current = (store.jse.vars.get("dsx.override") as Dict | undefined) ?? {};
        store.set("dsx.override", { ...current, ...overrides });
      }
    };
    const entry = Object.keys(attrs).length > 0
      ? this.ledger.updateAttrs(target ?? null, attrs)
      : this.ledger.find(target ?? null);
    if (entry !== null) {
      const ov = this.overlayViews.get(entry.id);
      const fr = this.chainFrames.get(entry.id);
      const inst = ov?.instance ?? fr?.instance;
      if (inst !== undefined) reseed(inst);
      return;
    }
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const f = this.frames[i]!;
      const bare = f.name.includes(".") ? f.name.substring(f.name.indexOf(".") + 1) : f.name;
      const matches = target === undefined ? i === this.frames.length - 1
        : (f.name === target || bare === target || (target.includes(".") && target.endsWith(`.${bare}`)));
      if (matches) {
        reseed(f.instance);
        return;
      }
    }
  }

  depth(): number {
    return this.frames.length;
  }

  // ── scroll restoration: the history-entry ledger (see the module note above) ────────

  /** A NEW history entry. Every `history.pushState` in this router goes through here.
   *  Banking the OUTGOING offsets is the caller's job (`captureScroll`) because a push
   *  mounts its frame first — by the time the entry is written the top frame is already
   *  the new one, and capturing here would bank zeros over the real offsets. */
  private pushEntry(depth: number, url: string, key?: string): void {
    this.currentKey = key ?? mintEntryKey();
    history.pushState({ dsxDepth: depth, dsxKey: this.currentKey }, "", url);
  }

  /** The SAME history entry, restated. It keeps whatever key the entry already carries —
   *  on a RELOAD that key is the one the pre-reload session banked offsets under. */
  private replaceEntry(depth: number, url: string, key?: string): void {
    this.currentKey = key ?? entryKeyOf(history.state) ?? this.currentKey ?? mintEntryKey();
    history.replaceState({ dsxDepth: depth, dsxKey: this.currentKey }, "", url);
  }

  /** The topmost NAVIGATION frame — chain sheets/covers are pathless presentations and
   *  never own a history entry's scroll. */
  private scrollFrame(): Frame | null {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i]!;
      if (frame.tier === "page") return frame;
    }
    return null;
  }

  private captureScroll(): void {
    if (this.currentKey === null) return;
    const frame = this.scrollFrame();
    if (frame === null) return;
    writeScrollLedger(this.currentKey, collectScrollMarks(frame.el));
  }

  /** Re-assert the banked offsets on a REBUILT frame. Content can still be arriving, so
   *  the boxes are re-applied for a bounded number of frames until each one is deep
   *  enough to hold its offset — never a spin, and never a scroll the user did not make
   *  (an entry with nothing banked does nothing at all). */
  private restoreScroll(key: string | null): void {
    if (key === null || typeof requestAnimationFrame !== "function") return;
    const marks = readScrollLedger()[key];
    if (marks === undefined || marks.length === 0) return;
    const frame = this.scrollFrame();
    if (frame === null) return;
    let frames = 0;
    const apply = (): void => {
      if (this.disposed || !frame.el.isConnected) return;
      let pending = false;
      for (const [path, top, left] of marks) {
        const el = elementAtScrollPath(frame.el, path);
        if (el === null) { pending = true; continue; }
        if (top > el.scrollHeight - el.clientHeight || left > el.scrollWidth - el.clientWidth) pending = true;
        el.scrollTop = top;
        el.scrollLeft = left;
      }
      frames += 1;
      if (pending && frames < SCROLL_RESTORE_FRAMES) requestAnimationFrame(apply);
    };
    requestAnimationFrame(apply);
  }

  /** Live navigation frame identities, root → top. Chain sheets/covers and overlays
   *  are deliberately excluded: their stamped chrome claims are inert, just as on
   *  the native routers where modal frames never enter nav.stack. */
  navigationFrameIds(): number[] {
    return this.frames.filter((frame) => frame.tier === "page").map((frame) => frame.id);
  }

  top(): string | null {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1]!.name : null;
  }

  // ── the devtools state door (boot.ts exposes it as window.__DSX_STATE__) ────────────
  //
  //  The ACTIVE screen's variable store, as data — the web twin of the DevSettings
  //  drawer, and what the studio's live data-store panel reads and writes. Deliberately
  //  a narrow façade: names and values in, one set() out, never the store object itself.
  //  Not a security surface: this is the page's own JS heap, already open in devtools.

  /** The `global.*` plane as data - the door's READ half.
   *
   *  The WRITE half already reached the whole state plane (runtime-pressure R16: a `global.*`
   *  name writes the app-wide store), but the snapshot returned only the top frame's vars, so
   *  "freeze exactly what I am looking at" silently lost the half of the state carrying
   *  session, user, entitlement and theme - the half a screenshot shows the most of. Additive:
   *  `screen` and `vars` keep their shape, so every existing consumer parses unchanged. */
  private globalPlane(): Dict {
    const out: Dict = {};
    for (const [k, v] of Object.entries(DSXState.vars)) out[k] = v;
    return out;
  }

  devState(): { screen: string | null; vars: { name: string; value: unknown }[]; globals: Dict } {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return { screen: null, vars: [], globals: this.globalPlane() };
    // The declared names live in three places by design: `vars` holds only what was
    // WRITTEN, `initials` the evaluated defaults, `computed` the reactive bodies. The
    // panel wants the RESOLVED value per name, so evaluate each name through the same
    // scope resolution a binding uses — written beats initial beats computed.
    const store = top.instance.ctx.store;
    const names = new Set<string>([
      ...store.jse.initials.keys(),
      ...store.jse.computed.keys(),
      ...store.jse.vars.keys(),
    ]);
    names.delete("dsx.attribute"); // internal pseudo-key, not an authored variable
    const vars: { name: string; value: unknown }[] = [];
    for (const name of names) {
      let value: unknown = null;
      try { value = store.eval(name); } catch { value = null; }
      vars.push({ name, value });
    }
    return { screen: top.name, vars, globals: this.globalPlane() };
  }

  devSetState(name: string, value: unknown): boolean {
    // The door reaches the WHOLE state plane (runtime-pressure R16): a `global.*` name
    // writes the app-wide store - the preview's locale switch is one `global.locale`
    // write - anything else the active screen's own vars, the same split the runner's
    // writePath keeps. Before this, the door decided "state" meant only the top screen.
    if (name.startsWith("global.")) {
      DSXState.set(name.substring("global.".length), value);
      return true;
    }
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return false;
    top.instance.ctx.store.set(name, value);
    return true;
  }

  /** Fire on writes to the ACTIVE screen's store. Navigation retires the subscription
   *  with its frame, so a long-lived listener re-arms on a cadence — the dev client does. */
  devSinkState(fn: () => void): () => void {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return () => {};
    return top.instance.ctx.store.sink(() => fn());
  }

  /** Run a declared action on the ACTIVE screen as an ENTRY call — the studio's "Try it"
   *  (platform/09-agent-tools.md WE6). The same call shape every other entry uses (HTTP
   *  route, CLI command, queue message, WebMCP dispatch): a payload and no caller scope.
   *  Same reach-not-access reasoning as the doors above; a deliberate throw is the ANSWER
   *  and comes back as the error string, exactly as the WebMCP adapter shapes it. */
  async devCallAction(action: string, args: { [k: string]: unknown }): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return { ok: false, error: "no screen is mounted" };
    const runner = top.instance.ctx.runner;
    if (!runner.env.actions.has(action)) {
      return { ok: false, error: `${top.name} declares no action "${action}"` };
    }
    try {
      const value = await runner.callAction(action, {}, null, args as Dict, { entry: true });
      const thrown = runner.takeThrow();
      if (thrown !== null) {
        const t = thrown.value;
        return { ok: false, error: typeof t === "string" ? t : JSON.stringify(t) };
      }
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── boot + history integration ─────────────────────────────────────────────────────

  /** Mount the entry frame, deep-link the current URL on top of it, wire popstate. */
  start(entry: string, vars: Dict = {}, configuredBase?: string, attrs?: Dict): void {
    // derive the serving base from the document (works under any sub-path)
    if (typeof document !== "undefined") {
      this.base = appBasePath(configuredBase, document.baseURI);
    }
    const hasHistory = typeof history !== "undefined" && typeof location !== "undefined";
    this.historyLive = hasHistory && this.routes.length > 0;

    this.push(entry, vars, { fromHistory: true, ...(attrs !== undefined ? { attrs } : {}) }); // the root frame — no extra entry
    // Native boot always seeds the root frame with the concrete path "/" (Router.swift/.kt
    // `entry(path:)`); an entry component with no route-table row would otherwise leave the
    // web root PATHLESS — `popTo("/")` would no-op here while truncating to root on native,
    // and `route.path` would publish null instead of "/". Stamp the same floor.
    const rootFrame = this.frames[0];
    if (rootFrame !== undefined && rootFrame.route === null) {
      rootFrame.route = { path: "/", params: {}, query: {} };
      this.notify();
    }
    if (!this.historyLive) {
      this.interactive = true; // boot is over — motion may begin (the silence rule)
      return;
    }

    // Frames are stacked layers that keep their DOM (and so their scroll) while covered —
    // scroll restoration on Back is BY CONSTRUCTION, like the native stack. Manual mode
    // stops the browser fighting it with stale document-level offsets; the REBUILD case
    // (forward navigation and RELOAD) is the ledger's, keyed by this entry's `dsxKey`.
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    // The key this browser entry ALREADY carries. On a reload it is the key the previous
    // session banked its offsets under — the whole reason the reload case can work.
    const coldKey = entryKeyOf(history.state);
    this.replaceEntry(1, location.href);
    // resolve the cold-load URL: guards, capability gates and redirect chains included
    const match = this.resolveUrl(location.pathname);
    if (match !== null && match.path !== this.appPath(location.pathname)) {
      // a redirect (unconditional or guard) moved us — rewrite the URL, 301-style
      this.replaceEntry(1, this.base + match.path.replace(/^\//, ""));
    }
    const query = parseQuery(location.search);
    const routedDetail = match !== null && match.route.component !== undefined
      && match.route.component !== this.frames[0]!.name;
    const unresolvedPath = this.appPath(location.pathname);
    const notFound = match === null && unresolvedPath !== "/"
      ? this.registry.notFound
      : undefined;
    const stacksSecondary = routedDetail || (notFound !== undefined && notFound.length > 0);
    const secondaryHref = location.href;
    if (stacksSecondary) {
      // The current browser entry becomes the mounted entry frame. The routed/404
      // surface gets its own entry below, so pointer Back, keyboard Back and Reload
      // all agree on both DOM and URL.
      this.replaceEntry(1, coldRootHistoryUrl(this.base, secondaryHref), mintEntryKey());
    }
    if (routedDetail) {
      // deep link: the routed page opens ON TOP of the entry, so Back works (a URL-derived
      // cold-load push — fromUrl, so the echo guard never eats a legitimate deep link)
      // the reloaded entry IS this deep link, so its banked offsets ride onto its entry
      this.push(match!.route.component!, { ...match!.params, query, path: match!.route.path },
        { query, fromUrl: true, ...(coldKey !== null ? { entryKey: coldKey } : {}) });
    } else if (match === null && unresolvedPath !== "/") {
      if (notFound !== undefined && notFound.length > 0) {
        this.push(notFound, { path: unresolvedPath });
        // A notFound component is deliberately pathless, so push() uses the current
        // (now-root) URL. Restore the originally requested URL on its depth-2 entry.
        this.replaceEntry(this.frames.length, secondaryHref, coldKey ?? undefined);
      } else {
        console.warn(`[dsx router] no route for ${unresolvedPath} (no 404 page declared)`);
      }
    }

    // COLD LOAD with a sheet fragment: the URL says a sheet was open, so re-present it on
    // top of whatever page the path resolved to. It reuses this entry (replaceState) — the
    // page underneath already owns one, and a second would make Back a no-op.
    const fragment = sheetFragmentName(location.hash);
    if (fragment !== null) {
      if (this.resolve(fragment) === null) {
        console.warn(`[dsx router] #sheet=${fragment} names no component — fragment ignored`);
      } else {
        this.restoringFragment = true;
        try { this.present(fragment, { as: "sheet" }); } finally { this.restoringFragment = false; }
      }
    }

    const onPopState = (e: PopStateEvent): void => {
      const target = Math.max(1, Number((e.state as { dsxDepth?: number } | null)?.dsxDepth ?? 1));
      // The echo of a truncateTo() jump — the frame stack was already truncated synchronously.
      // If a verb chained after the truncation has ALREADY pushed new frames (popToRoot →
      // push in one action), re-assert their entries forward (each with its own URL) so
      // history lands aligned with the frame stack instead of tearing the new frames down.
      if (this.pendingTruncation !== null && target === this.pendingTruncation) {
        const pending = this.pendingTruncation;
        this.pendingTruncation = null;
        for (let d = pending + 1; d <= this.frames.length; d += 1) {
          const fr = this.frames[d - 1]!;
          const url = fr.route !== null ? this.toUrl(fr.route.path, fr.route.params, fr.route.query) : location.href;
          this.pushEntry(d, url);
        }
        return;
      }
      this.pendingTruncation = null; // any other traversal supersedes a stale echo guard
      if (target < this.frames.length) {
        const kind = this.skipNextPopMotion
          ? "none"
          : this.frameKind(this.frames[this.frames.length - 1]!);
        this.skipNextPopMotion = false;
        if (this.frames.length - target === 1 && kind !== "none") {
          this.popTop(kind);                                     // one user Back — the native exit
        } else {
          while (this.frames.length > target) this.popFrame();   // multi-pop stays instant
          this.notify();
        }
      } else if (target > this.frames.length) {
        // forward: re-open whatever the URL says (state is not kept for forward)
        const m = this.resolveUrl(location.pathname);
        if (m !== null && m.route.component !== undefined) {
          const q = parseQuery(location.search);
          this.push(m.route.component, { ...m.params, query: q, path: m.route.path }, { fromHistory: true, query: q });
        }
      }
    };
    window.addEventListener("popstate", onPopState);
    this.teardown.push(() => window.removeEventListener("popstate", onPopState));

    // NAVIGATION IS PURE STATE (the native Router's route.path observer, Router.swift
    // `resolveIfPathChanged`): a plain `route.path` write — `set: route.path = '/x'`,
    // `despia.navigate(...)`, a module's global.set — navigates in place (REPLACE,
    // preserving single-route semantics; history entries stay opt-in via route.push).
    // The router's own publishes sync `lastResolvedPath`, so only EXTERNAL writes fire.
    this.teardown.push(DSXState.sink(() => {
      const path = DSXState.get("route.path");
      if (typeof path !== "string" || path.length === 0) return;
      if (path === this.lastResolvedPath) return;
      this.lastResolvedPath = path;   // sync BEFORE navigating (re-entrant publishes no-op)
      this.navigatePath(path, "replace");
    }));

    // Boot is over — every mount above (entry, deep link, 404) rendered with zero motion;
    // from here navigation is the user's and may animate (the silence rule, motion.ts).
    this.interactive = true;
  }
}
