//
//  screen.ts - the SCREEN-LIFECYCLE plane (reference/screen-lifecycle.md). Both halves
//  of OpenSource/Conformance/lifecycle/ live here, because the web renderer ships no
//  Lifecycle module — its kernel publishes the unified `screen.*` vocabulary directly
//  from the same table the native coordinator uses:
//
//    1. ScreenReadiness — the per-frame REPORTER (lifecycle/readiness.json). Nine
//       inputs (mount · manual · hostsWeb · rendered · settled · deadline · release,
//       plus the frameless webStart · webSettled); the MACHINE, never the call site,
//       decides when `surface.viewStart` / `surface.viewFinish` fire. That single funnel IS the
//       once-per-frame guarantee, and it owns the bounded settle DEADLINE so no
//       renderer can ship a screen that hangs the shell in `loading` forever.
//    2. installScreenPhase() — the stateless COORDINATOR (lifecycle/phase.json):
//       `dom*` (a hosted web surface) and `view*` (a DSX-rendered frame) both translate
//       into `screen.loading` / `screen.ready` + `global.screen.phase` / `.ready`.
//
//  WHY A WEB FRAME REPORTS `view*`, NOT `dom*`: the `surface` tag names the REPORTER,
//  not the renderer. `dom*` belongs to a hosted web VIEW (the composed WKWebView /
//  WebView the native shells embed) — on this renderer the browser document IS the
//  host, so there is no such view to report. A frame the DSX renderer paints itself is
//  the DSXView analogue on every renderer, so it reports through `view*` and an
//  authored `settle="manual"` screen defers readiness identically on all three.
//
//  WHY THIS RENDERER NEVER REPORTS `hostsWeb` / `webStart` / `webSettled`: those three
//  inputs describe a native frame that EMBEDS the app's web view (`<DSXWebView/>` inside a
//  DSX-rendered screen) and must not settle while that view is blank. Here the browser
//  document IS the host — there is no embedded app surface to wait for — so the inputs
//  exist (the machine is one machine, corpus-gated identically on all three renderers) and
//  simply never fire. Same reason `<DSXWebView/>` is `unsupported` in element-support.json.
//
//  DOM-free by law (this package renders nothing) — @despia-native/dom owns the wiring.
//

import { ModuleRegistry } from "./bus.ts";
import { DSXState } from "./store.ts";
import { isDict, isNSNull, type Dict } from "./jse/values.ts";
import { RunnerScreenSeam } from "./runner.ts";

/** the reporter tag a DSX-rendered frame carries (readiness.json rule 1) */
export const NATIVE_SURFACE = "native";

/**
 * THE BOUNDED FALLBACK (readiness.json `settleDeadlineMs`, rule 10 — Article 7, fail-open).
 *
 * Every tracked frame carries a settle deadline, armed by the machine itself at `mount` and
 * cancelled the moment the frame settles or is released. When it elapses the frame settles
 * ANYWAY. Without it a `settle="manual"` screen that never calls `dsx.screen.settled()` — or a
 * hosted web surface that never loads — pins `global.screen.phase` at `"loading"` FOREVER on
 * every renderer: Splash never reveals, Spinner holds `ui.loading`, Engagement never runs. On a
 * HYBRID app it would also block the WEB surface's consumers, because there is ONE shared phase.
 * A late reveal is a degraded screen; a permanent spinner is a dead app.
 *
 * The value is corpus-pinned and IDENTICAL on all three renderers (Swift
 * `DSXScreenReadiness.settleDeadlineMs`, Kotlin `ScreenReadiness.SETTLE_DEADLINE_MS`).
 */
export const SETTLE_DEADLINE_MS = 10_000;

/** the two APP surfaces the coordinator translates; anything else is a bare embedded
 *  `<WebView/>` named by its node and is dropped (phase.json rule 3) */
const APP_SURFACES: ReadonlySet<string> = new Set(["web", NATIVE_SURFACE]);

type FrameRecord = {
  /** the route this frame carries; rides both events verbatim */
  path: string | null;
  /** the root declared `settle="manual"` — a first render pass no longer settles it */
  manual: boolean;
  /** this frame mounted a `<DSXWebView/>` app web surface, so it must not report settled while
   *  that surface is still blank (readiness.json rule 9). Registered by the COMPONENT, never
   *  by the author; released by the surface's own `webSettled()`. */
  hostsWeb: boolean;
  /** the once-per-frame latch: after this, every further input is a no-op */
  settled: boolean;
  /** cancels this frame's bounded settle deadline (rule 10); null once it has been spent */
  cancelDeadline: (() => void) | null;
};

/** The deadline timer seam. Default is a plain unref'd timeout — swapped by the conformance
 *  runner (which drives the `deadline` step directly) and by any host that owns its own clock.
 *  Returns the canceller. */
function scheduleDeadlineDefault(ms: number, fire: () => void): () => void {
  const handle = setTimeout(fire, ms);
  // Node: a pending 10s timeout must never hold a test process (or a CLI render) open.
  // Browsers return a number, so the optional call is simply absent there.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => { clearTimeout(handle); };
}

/**
 * The native readiness reporter — one record per LIVE frame id (the Router's `nav.stack`
 * frame id). Pinned by OpenSource/Conformance/lifecycle/readiness.json; the Swift
 * `DSXScreenReadiness` and Kotlin `ScreenReadiness` are the same machine.
 *
 * DEFAULT is auto (`rendered` settles the frame); OPT-IN is manual (`settle="manual"`
 * on the root registers `manual`, so only the screen's own `dsx.screen.settled()`
 * settles it). An explicit settle always wins; a released frame never settles late.
 */
class ScreenReadinessImpl {
  private frames = new Map<number, FrameRecord>();

  /** Has the app web surface settled since its last start? A LATCH, not a counter: a frame
   *  that mounts while the page is already up must not wait for a load that will never come
   *  (readiness.json "a frame mounted while the page is ALREADY settled never waits for it"),
   *  and `webStart()` re-arms it for the next load. */
  private webIsSettled = false;

  /** the bounded-deadline timer seam (rule 10) — replaceable for tests and custom hosts */
  scheduleDeadline: (ms: number, fire: () => void) => () => void = scheduleDeadlineDefault;

  /** a frame entered the stack. Ignored outright unless the surface is native — a
   *  hosted web surface reports `dom*`, so a hybrid app never double-reports. One
   *  `surface.viewStart` per frame INSTANCE: idempotent while the record lives. Arming the
   *  bounded deadline HERE (not at the call site) is what makes the fallback impossible
   *  for a renderer to forget. */
  mount(frame: number, path: string | null | undefined, surface: string): void {
    if (surface !== NATIVE_SURFACE) return;
    if (this.frames.has(frame)) return;
    const route = path ?? null;
    const rec: FrameRecord = {
      path: route, manual: false, hostsWeb: false, settled: false, cancelDeadline: null,
    };
    this.frames.set(frame, rec);
    rec.cancelDeadline = this.scheduleDeadline(SETTLE_DEADLINE_MS, () => { this.deadline(frame) });
    ModuleRegistry.foldDelegate("surface.viewStart", { path: route, surface: NATIVE_SURFACE, frame }, "void");
  }

  /** the frame's root declared `settle="manual"`. A no-op for an unknown frame and for
   *  an already-settled one — it can never re-open a settled frame. */
  manual(frame: number): void {
    const rec = this.frames.get(frame);
    if (rec === undefined || rec.settled) return;
    rec.manual = true;
  }

  /** this frame mounted the app's `<DSXWebView/>` web surface (rule 9 — the HYBRID ordering law).
   *  A native frame that hosts a web view must not report settled while that view is still
   *  blank, or Splash reveals over nothing and the page's own `surface.domStart` re-opens the phase a
   *  beat later. Gated exactly like `manual`, released by `webSettled()`. No gate when the
   *  page has ALREADY settled — the content is on screen, so the frame is free to settle on
   *  its first render. */
  hostsWeb(frame: number): void {
    const rec = this.frames.get(frame);
    if (rec === undefined || rec.settled || this.webIsSettled) return;
    rec.hostsWeb = true;
  }

  /** the frame completed its FIRST render pass — settles an `auto` screen. */
  rendered(frame: number): void {
    const rec = this.frames.get(frame);
    if (rec === undefined || rec.settled || rec.manual || rec.hostsWeb) return;
    this.finish(frame, rec);
  }

  /** `dsx.screen.settled()` — the screen reports readiness itself. Always wins: it
   *  settles an auto frame early and clears a pending `manual` / `hostsWeb` gate. */
  settled(frame: number): void {
    const rec = this.frames.get(frame);
    if (rec === undefined || rec.settled) return;
    this.finish(frame, rec);
  }

  /** the frame's bounded settle deadline elapsed (rule 10) — settle whatever it was waiting
   *  for. Deliberately blind to `manual` / `hostsWeb`: the deadline exists precisely for the
   *  screens those flags would otherwise hold open forever. A released or already-settled
   *  frame is a silent no-op. */
  deadline(frame: number): void {
    const rec = this.frames.get(frame);
    if (rec === undefined || rec.settled) return;
    this.finish(frame, rec);
  }

  /** the app web surface began loading (the relay's `surface.domStart`) — re-arms the hosted gate for
   *  frames that mount during this load. Frameless: there is exactly ONE app web surface. */
  webStart(): void {
    this.webIsSettled = false;
  }

  /** the app web surface settled (the relay's `surface.domFinish` OR `surface.domFail` — a failed load is
   *  still settled). Releases every frame gated on it, ascending, so a hybrid app's splash
   *  reveals over the loaded page instead of over a blank web view. A frame that ALSO declared
   *  `settle="manual"` keeps its own ownership and is untouched. */
  webSettled(): void {
    this.webIsSettled = true;
    // snapshot before firing: a consumer of `surface.viewFinish` may push a screen and mount a frame
    const gated = [...this.frames.keys()].sort((a, b) => a - b);
    for (const id of gated) {
      const rec = this.frames.get(id);
      if (rec === undefined || rec.settled || rec.manual || !rec.hostsWeb) continue;
      this.finish(id, rec);
    }
  }

  /** the frame left the stack — drops the record, so no late `surface.viewFinish` can fire and
   *  a re-mount of the same id is a fresh instance. */
  release(frame: number): void {
    const rec = this.frames.get(frame);
    if (rec !== undefined) this.cancel(rec);
    this.frames.delete(frame);
  }

  /** live frames that have NOT settled (the corpus `expectPending`), ascending. */
  pending(): number[] {
    const out: number[] = [];
    for (const [id, rec] of this.frames) if (!rec.settled) out.push(id);
    return out.sort((a, b) => a - b);
  }

  /** drop every record — test/teardown seam, never a runtime path. */
  reset(): void {
    for (const rec of this.frames.values()) this.cancel(rec);
    this.frames.clear();
    this.webIsSettled = false;
  }

  private finish(frame: number, rec: FrameRecord): void {
    rec.settled = true;
    rec.manual = false;
    rec.hostsWeb = false;
    this.cancel(rec);
    ModuleRegistry.foldDelegate("surface.viewFinish", { path: rec.path, surface: NATIVE_SURFACE, frame }, "void");
  }

  private cancel(rec: FrameRecord): void {
    const cancel = rec.cancelDeadline;
    rec.cancelDeadline = null;
    if (cancel !== null) cancel();
  }
}

/** the ONE per-renderer readiness reporter */
export const ScreenReadiness = new ScreenReadinessImpl();

// ── the coordinator (lifecycle/phase.json) ───────────────────────────────────────────

/** The APP-SURFACE guard. An untagged payload counts as the app surface (fail-open,
 *  Article 7 — the legacy bare-string input keeps working); any tag that is neither
 *  "web" nor "native" is a bare embedded surface named by its node and is DROPPED, so
 *  an embedded player loading a page can never flip the app's phase. */
export function screenIsAppSurface(input: unknown): boolean {
  if (!isDict(input)) return true;
  const tag = (input as Dict)["surface"];
  if (tag === undefined || tag === null || isNSNull(tag)) return true;
  return typeof tag === "string" && APP_SURFACES.has(tag);
}

/** The route the re-fired `screen.*` event carries: the plain ROUTE STRING, never the
 *  reporter's dict — `url` when present (a hosted web surface), else `path` (a frame),
 *  else the input itself when it is already a string, else null. */
export function screenRouteString(input: unknown): string | null {
  if (isDict(input)) {
    const url = (input as Dict)["url"];
    if (typeof url === "string") return url;
    const path = (input as Dict)["path"];
    if (typeof path === "string") return path;
    return null;
  }
  return typeof input === "string" ? input : null;
}

/** The IDENTITY of the report that produced the current phase: the reporting frame id for
 *  a native report (`surface.viewStart`/`surface.viewFinish` carry `frame`), or null for a frameless one —
 *  the web relay's `dom*`, which describes the ONE app web surface and names no frame.
 *  Published so a level reader can tell WHOSE settle it is looking at (root-plan.md §5). */
export function screenReportFrame(input: unknown): number | null {
  if (!isDict(input)) return null;
  const frame = (input as Dict)["frame"];
  return typeof frame === "number" && Number.isInteger(frame) ? frame : null;
}

/** `global.screen.phase` + `global.screen.ready` + `global.screen.frame`. Written as DOTTED
 *  paths so the publish MERGES into the `screen` object that also carries the window
 *  metrics — a phase publish must never wipe width/height/sizeClass (phase.json rule 5;
 *  boot.ts seedScreen holds the mirror image of this invariant). */
function publishPhase(phase: "loading" | "ready", frame: number | null): void {
  // IDENTITY BEFORE LEVEL — `screen.frame` first, `screen.ready` last. A level-triggered
  // reader wakes on every one of these writes (the Kotlin twin's sink runs INLINE), and a
  // `ready` published ahead of its frame would pair a true level with the PREVIOUS report's
  // identity, which is precisely the stale binding the root plan guards against.
  DSXState.set("screen.frame", frame);
  DSXState.set("screen.phase", phase);
  DSXState.set("screen.ready", phase === "ready");
}

let uninstall: (() => void) | null = null;

/**
 * Bind the coordinator: every surface's PRIVATE readiness report → the ONE unified
 * vocabulary. Stateless and level-triggered — it never dedupes, never orders, never
 * remembers; de-duplication is the REPORTER's job (ScreenReadiness above).
 *
 * A failed load is SETTLED, so `surface.domFail` translates identically to `surface.domFinish` (no stuck
 * spinner). There is deliberately no `viewFail`: a frame always settles, and a native
 * screen's failure is a value on the error plane (`dsx.error`), never a lifecycle phase.
 *
 * Idempotent; returns the unbind (test seam — boot never unbinds).
 */
export function installScreenPhase(): () => void {
  if (uninstall !== null) return uninstall;
  // Wire the runner's screen seam HERE rather than letting runner.ts import this module: the
  // runner ships in every bundle (a self-contained embed included) and would otherwise drag the
  // whole machine along. Only a real router host calls installScreenPhase(), so only a real
  // router host pays for it.
  RunnerScreenSeam.settled = (frameId: number) => { ScreenReadiness.settled(frameId) };
  const loading = (input: unknown): unknown => {
    if (!screenIsAppSurface(input)) return null;
    publishPhase("loading", screenReportFrame(input));
    ModuleRegistry.foldDelegate("screen.loading", screenRouteString(input), "void");
    return null;
  };
  const settled = (input: unknown): unknown => {
    if (!screenIsAppSurface(input)) return null;
    // State BEFORE the event, so a `screen.ready` hook can read `screen.frame` and learn
    // WHICH frame settled — the binding the root-plan fold needs (boot.ts).
    publishPhase("ready", screenReportFrame(input));
    ModuleRegistry.foldDelegate("screen.ready", screenRouteString(input), "void");
    return null;
  };
  const off: Array<() => void> = [
    ModuleRegistry.registerDelegate("surface.domStart", 0, loading),
    ModuleRegistry.registerDelegate("surface.viewStart", 0, loading),
    ModuleRegistry.registerDelegate("surface.domFinish", 0, settled),
    ModuleRegistry.registerDelegate("surface.domFail", 0, settled),
    ModuleRegistry.registerDelegate("surface.viewFinish", 0, settled),
  ];
  uninstall = (): void => {
    for (const drop of off) drop();
    RunnerScreenSeam.settled = null;   // symmetric with the install above
    uninstall = null;
  };
  return uninstall;
}
