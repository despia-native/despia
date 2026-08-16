//
//  boot.ts - the bootloader (constitution: hosts are bootloaders — mount the kernel,
//  register chunks, hand off; app behavior lives in packages). Injects the cascade
//  (layer statement → tokens → elements → compiled app css), seeds the app-wide
//  store (screen metrics, app identity), registers module chunks, mounts the entry.
//

import {
  DSXState, ModuleRegistry, JSESeams, installScreenPhase, installJsTier, invalidateCookies, string,
  type WebModule, type Dict,
} from "@despia/kernel";
import { LAYER_STATEMENT } from "@despia/compiler/cssmap";
import type { Registry } from "@despia/compiler/resolve";
import { FrameRouter, frameIdCursor } from "./router.ts";
import { setCookieWriter, setLinkSeam } from "./mount.ts";
import { abandonAdopt, applyStreamChunk, beginAdopt, finishAdopt, seedApiEnvelopes } from "./adopt.ts";
import { ELEMENTS, registerGlobalElements, registerRichElements } from "./elements.ts";
import { FORM_ELEMENTS, FORM_ELEMENTS_CSS } from "./forms.ts";
import { NATIVE_CONTROLS_CSS, registerNativeControls } from "./native-controls.ts";
import { registerElementMotion } from "./element-motion.ts";
import { STRUCTURAL_CONTROLS_CSS, registerStructuralControls } from "./structural-controls.ts";
import { OVERLAY_CONTROLS_CSS, registerOverlayControls } from "./overlay-controls.ts";
import { DATA_CONTROLS_CSS, registerDataControls } from "./data-controls.ts";
import { APPLICATION_CONTROLS_CSS, registerApplicationControls } from "./application-controls.ts";
import {
  MEDIA_LIGHTBOX_CSS, MEDIA_PLAYBACK_CSS, MEDIA_SVG_CSS, registerMediaSurfaces,
} from "./media-surfaces.ts";
import { SCENE_CSS, registerSceneSurface } from "./scene.ts";
import { installButtonKeyboardActivation } from "./keyboard.ts";
import {
  TOKENS_CSS, APPLICATION_ELEMENTS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS,
} from "./theme.ts";
import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "./globals.ts";
import { normalizePlan, RootPlanFold, type PlanCandidate } from "./root-plan.ts";

export type BootOptions = {
  registry: Registry;
  host: HTMLElement;
  /** the ROOT PLAN (root-plan.md): a qualified component ("demo.Launcher") as the
   *  one-candidate shorthand, or the ordered `entry.surfaces` candidate list —
   *  first-ready fold, failure always advances, exhaustion renders the boot
   *  diagnostic. Corpus: Conformance/router/root-plan.json. */
  entry: string | Array<string | PlanCandidate>;
  /** URL path prefix for the app root; defaults to the document directory */
  base?: string;
  vars?: Dict;
  /** reactive component attributes supplied to the entry surface */
  attrs?: Dict;
  /** module chunks present in THIS build (export-presence = the gate, /web/03) */
  modules?: WebModule[];
  /** app identity seeded under global.app */
  app?: Dict;
  /** app-wide constants (App.json `consts`) seeded under the reactive `dsx.const.*`
   *  plane — networking.md N0. Flat public scalars; a remote `consts_url` may sharpen
   *  them later (the host re-sets this key and screens update). */
  consts?: Dict;
  /** surface integration hook, invoked after construction but before any frame mounts */
  configureRouter?: (router: FrameRouter) => void;
};

function injectStyle(css: string, id: string): void {
  if (document.getElementById(id) !== null) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

/** the live cookie jar: `dsx.cookie.name` reads + `dsx.cookie.name = v` writes
 *  ride document.cookie (session auth headers like Nordcraft's
 *  `Bearer {{ cookies.access_token }}` work verbatim as `{{ cookie.access_token }}`) */
function wireCookies(): void {
  JSESeams.cookieJar = () => {
    const jar: Dict = {};
    for (const part of document.cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.substring(0, eq).trim();
      try { jar[k] = decodeURIComponent(part.substring(eq + 1)); } catch { jar[k] = part.substring(eq + 1); }
    }
    return jar;
  };
  setCookieWriter((name, value) => {
    if (value === null || value === undefined) {
      document.cookie = `${name}=; path=/; max-age=0`;
    } else {
      document.cookie = `${name}=${encodeURIComponent(string(value))}; path=/`;
    }
    invalidateCookies();
  });
}

/** Canonical DSX screen contract shared with the native renderers. Keeping the
 * boundary calculation pure makes resize/orientation behavior corpus-testable. */
export function screenMetrics(width: number, height: number): Dict {
  return {
    width,
    height,
    sizeClass: width >= 768 ? "regular" : "compact",
    orientation: width >= height ? "landscape" : "portrait",
    breakpoint: width >= 1024 ? "xl" : width >= 768 ? "lg" : width >= 480 ? "md" : "sm",
  };
}

function seedScreen(): void {
  const apply = (): void => {
    const width = window.innerWidth;
    // visualViewport tracks the usable height when a mobile software keyboard is
    // visible. Width stays layout-viewport based so opening a keyboard cannot flip
    // a phone into a different responsive layout.
    const height = window.visualViewport?.height ?? window.innerHeight;
    // OVERLAY the metric keys, never replace the object: `screen.*` also carries the
    // lifecycle keys `phase`/`ready` (screen.ts), so a whole-object write would wipe the
    // screen phase on every rotation and keyboard open. The native twin
    // (DSXScreenMetrics) overlays for exactly this reason; phase.json's last row is the
    // mirror-image guard (a phase publish must never wipe the metrics).
    const current = DSXState.get("screen");
    const base = typeof current === "object" && current !== null && !Array.isArray(current)
      ? (current as Dict)
      : {};
    DSXState.set("screen", { ...base, ...screenMetrics(width, height) });
  };
  apply();
  window.addEventListener("resize", apply);
  window.visualViewport?.addEventListener("resize", apply);
}

/** The boot this process is running — the web's stand-in for the natives' single `Router.shared`.
 *  A second `bootDsx()` (an embedder re-booting in-process, a hydration replay) must not leave the
 *  previous fold subscribed: its `screen.ready` hook would answer the NEW boot's frame ids against
 *  the OLD `attemptOfFrame`, find them unmapped, and settle its own still-live candidate — firing a
 *  duplicate `root.ready` with the wrong view and index.
 *  The ROUTER is reached through a thunk, not a field: `liveRouter` is assigned inside bootDsx
 *  AFTER this record is built (the first candidate's mount is what creates it), so capturing the
 *  value here would always capture `null`. Reading it at retire time gets whichever router the
 *  previous boot ended up with. */
let activeBoot: { fold: RootPlanFold; offs: Array<() => void>; router: () => FrameRouter | null } | null = null;

export function bootDsx(opts: BootOptions): FrameRouter {
  // Retire the previous boot BEFORE anything else: close the fold (late timers and signals go
  // inert), drop its bus hooks, which `ModuleRegistry.hook` hands back and nothing else owns,
  // and DISPOSE its router — otherwise the old one keeps its window resize/popstate listeners,
  // the shared host's pointerdown handler, its `route.path` state sink and its frames'
  // ScreenReadiness records (only dispose() releases those). Two live routers on one host means
  // every route write mounts twice, and a queued `rendered()` on a retained id reaches the new
  // fold as an UNMAPPED settle — crowning the new boot's candidate, the exact failure above.
  if (activeBoot !== null) {
    activeBoot.fold.close();
    for (const off of activeBoot.offs) off();
    activeBoot.router()?.dispose();
    activeBoot = null;
  }
  installButtonKeyboardActivation();
  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();
  Object.assign(ELEMENTS, FORM_ELEMENTS);
  registerNativeControls();
  registerElementMotion();  // universal enter/transition/keep/anim/animDuration (element-motion.ts)
  registerStructuralControls();
  registerOverlayControls();
  registerDataControls();
  registerApplicationControls();
  registerMediaSurfaces();
  registerSceneSurface();   // <scene> (dsx-scene.md P1) — full apps only; embeds slice it out
  // the cascade: the FIRST layer statement fixes the order, weakest → strongest
  injectStyle(LAYER_STATEMENT, "dsx-layers");
  injectStyle(TOKENS_CSS, "dsx-tokens");
  injectStyle(APPLICATION_ELEMENTS_CSS, "dsx-application-elements");
  injectStyle(ELEMENTS_CSS, "dsx-elements");
  injectStyle(CONTROL_ELEMENTS_CSS, "dsx-control-elements");
  injectStyle(FORM_ELEMENTS_CSS, "dsx-form-elements");
  injectStyle(RICH_ELEMENTS_CSS, "dsx-rich-elements");
  injectStyle(NATIVE_CONTROLS_CSS, "dsx-native-controls");
  injectStyle(STRUCTURAL_CONTROLS_CSS, "dsx-structural-controls");
  injectStyle(OVERLAY_CONTROLS_CSS, "dsx-overlay-controls");
  injectStyle(DATA_CONTROLS_CSS, "dsx-data-controls");
  injectStyle(APPLICATION_CONTROLS_CSS, "dsx-application-controls");
  injectStyle(MEDIA_PLAYBACK_CSS, "dsx-media-playback");
  injectStyle(MEDIA_SVG_CSS, "dsx-media-svg");
  injectStyle(MEDIA_LIGHTBOX_CSS, "dsx-media-lightbox");
  injectStyle(SCENE_CSS, "dsx-scene");
  injectStyle(GLOBAL_ELEMENTS_CSS, "dsx-global-elements");
  injectStyle(opts.registry.css, "dsx-app-css");

  DSXState.batch(() => {
    DSXState.set("app", {
      // Fail CLOSED to production, exactly like the native seam (appEnvironment() →
      // "appstore") and the markup `env` word: an app that doesn't declare its channel
      // must never expose dev affordances (staging-and-testing.md §7 release checklist).
      // The demo passes env explicitly, so nothing dev-facing regresses.
      env: "appstore",
      name: document.title || "DSX",
      ...(opts.app ?? {}),
    });
    // The app-wide constants floor (App.json `consts`) — read as `dsx.const.*`
    // (networking.md N0). Empty by design; the app ships its own. A dynamic
    // `consts_url` fetch (host machinery) may re-set this key later — it is reactive.
    DSXState.set("const", { ...(opts.consts ?? {}) });
  });
  // The screen-lifecycle coordinator (screen-lifecycle.md; corpus lifecycle/phase.json) —
  // bound BEFORE the entry frame mounts so the root frame's own viewStart/viewFinish
  // translate into `screen.loading`/`screen.ready` + `global.screen.phase`/`.ready`. The
  // web renderer ships no Lifecycle module; this kernel publishes the same table.
  installScreenPhase();
  installJsTier();   // /web/15: full surfaces escalate; embeds never install this
  seedScreen();

  wireCookies();
  for (const m of opts.modules ?? []) ModuleRegistry.register(m);

  // ADOPT-HYDRATION (W6, adopt.ts): a renderPage document marks its host
  // data-dsx-hydrate and stamps per-node identities — keep the server DOM in place
  // and let each frame mount CLAIM its component's root (mismatch = fail-open
  // replace, counted). Anything else (the "/" client shell, an old unstamped
  // export) keeps the v0 replace-mount path byte-for-byte.
  abandonAdopt(); // a previous boot's unfinished session must never leak roots
  const adopting = opts.host.hasAttribute("data-dsx-hydrate") && opts.host.firstElementChild !== null;
  if (adopting) {
    beginAdopt(opts.host);
    // SSR api-hydration payload (doc 02: window.__DSX__.api): register the server-
    // resolved envelopes so each entry <api> block adopts its data and skips the
    // initial fetch (adopt.ts + api.ts). Absent payload = the fetch-on-mount path.
    const payload = (globalThis as typeof globalThis & { __DSX__?: { api?: unknown } }).__DSX__;
    if (payload?.api !== undefined) seedApiEnvelopes(payload.api);
    // Out-of-order streaming (doc 02: window.__DSX_STREAM__): drain the chunks the
    // server flushed before this boot ran, then install the applier so every later
    // chunk applies the moment its <script> executes. A chunk for a block that
    // already mounted seeds it in place (seedLate — the client's own settled data
    // wins); one arriving before its mount stashes into the boot-seed map above.
    const g = globalThis as typeof globalThis & {
      __DSX_STREAM__?: unknown[];
      __DSX_STREAM_APPLY__?: () => void;
    };
    const drainStream = (): void => {
      const queue = g.__DSX_STREAM__;
      if (!Array.isArray(queue)) return;
      while (queue.length > 0) applyStreamChunk(queue.shift());
    };
    g.__DSX_STREAM_APPLY__ = drainStream;
    drainStream();
  } else {
    opts.host.replaceChildren();
  }
  opts.host.setAttribute("data-dsx-root", "");

  // ── the ROOT PLAN fold (root-plan.ts — the corpus-pinned engine). Each candidate
  // gets a fresh FrameRouter into the same host; the seam closures read `liveRouter`
  // so `href=` links always target the live one. The returned handle is the FIRST
  // live router — a post-fallback external reference is stale, which is acceptable:
  // a web app's own origin serves it, so surface fallback is the rare path here.
  const plan = normalizePlan(typeof opts.entry === "string" ? [opts.entry] : opts.entry);
  let liveRouter: FrameRouter | null = null;
  // FRAME → ATTEMPT. Readiness reports name their frame (`screen.frame`); the plan needs to
  // know whose settle it just saw. Frame ids are monotonic per RENDERER (router.ts), so a
  // report from a retired candidate's frame resolves to ITS index and the fold drops it as
  // stale instead of crowning whoever is live. A report with no frame — the web relay's
  // frameless `dom*` — resolves to undefined and settles the live attempt, unchanged.
  const attemptOfFrame = new Map<number, number>();
  const fold = new RootPlanFold(plan, {
    mount(c, i) {
      // RETIRE THE PREVIOUS CANDIDATE before the next one exists — the web twin of both
      // natives' `screen.ready = false` at mount. `replaceChildren()` only strips the DOM:
      // the dead router keeps its popstate/resize listeners, its `route.path` state sink and
      // its readiness records, so it would go on asserting its own frame depth against the
      // live router's URL — and a late `viewFinish` from one of its frames would crown THIS
      // candidate before it rendered a pixel. dispose() spends all of it (router.ts).
      liveRouter?.dispose();
      if (i > 0) {
        // a fallback candidate never adopts: the failed candidate owns the failure
        // (the fold ledgers it) and its server DOM must not haunt the successor
        abandonAdopt();
        opts.host.replaceChildren();
      }
      const firstFrame = frameIdCursor();
      const router = new FrameRouter(opts.registry, opts.host);
      liveRouter = router;
      setLinkSeam({ url: (p) => router.hrefUrl(p), navigate: (p) => router.navigateHref(p) });
      // Bind system chrome/history consumers before start mounts the entry and any cold
      // deep-link frame. Binding after start collapses both chrome claims onto depth one.
      opts.configureRouter?.(router);
      router.start(c.view, opts.vars ?? {}, opts.base, { ...(opts.attrs ?? {}), ...(c.config ?? {}) }); // deep links + history + 404 (/web/04)
      // CLAIM every frame this attempt allocated (root, plus a cold deep-link or 404 frame).
      // Bracketing the allocator beats asking the router: `start` can drive the fold
      // SYNCHRONOUSLY — the `screen.ready` hook fires inside it — and a mount that advances
      // the plan disposes this very router before we get here, leaving it frameless. Ids
      // already claimed belong to that nested, LATER attempt; they keep their owner.
      for (let id = firstFrame; id < frameIdCursor(); id += 1) {
        if (!attemptOfFrame.has(id)) attemptOfFrame.set(id, i);
      }
    },
    now: () => Date.now(),
    setTimer(ms, fire) {
      const t = setTimeout(fire, ms);
      return () => clearTimeout(t);
    },
    send: (event, payload) => { ModuleRegistry.foldDelegate(event, payload, "void"); },
    registered: (view) => view in opts.registry.components,
    // The exhaustion diagnostic — kernel-owned pixels, deliberately NOT a component
    // (root-plan.md §9: it must survive a broken component system). Same split as both
    // natives (RouterHost.swift BootDiagnostic / MainActivity.kt): TEST channels get the
    // full attempt ledger, production gets a neutral line — view names, failure codes and
    // timings are internals, and this page is served to end users. Fail-CLOSED like the
    // `app.env` seed itself: anything that isn't a known test channel is production.
    diagnostic(ledger) {
      // The last candidate never reached another `mount`, so nothing has retired it — and the
      // diagnostic replaces the host's children out from under it. Spend it here or its
      // listeners and state sink outlive the app they failed to boot. `liveRouter` KEEPS the
      // disposed router: nulling it would send the `?? new FrameRouter(...)` tail below down
      // the construction path on every exhausted boot, binding a fresh resize listener nothing
      // will ever spend — the very leak dispose() exists to close — and handing the caller a
      // frameless stranger instead of the candidate that actually ran.
      liveRouter?.dispose();
      // The link seam is a MODULE global pointing at this router's closures; leaving it bound
      // to a disposed router means a later `href` click calls navigateHref → push → indexes an
      // emptied `frames` array and appends a frame over the diagnostic. Nothing owns the seam
      // once the plan is dead, so release it (mount.ts accepts null).
      setLinkSeam(null);
      abandonAdopt(); // the diagnostic replaces the host — the session is over, silently
      const app = DSXState.get("app");
      const env = typeof app === "object" && app !== null ? (app as Dict).env : undefined;
      const isTest = env === "simulator" || env === "debug" || env === "testflight" || env === "adhoc";
      const box = document.createElement("div");
      box.setAttribute("data-dsx-boot-diagnostic", "");
      const pre = document.createElement("pre");
      pre.textContent = isTest
        ? [
            "Root plan exhausted · target: web",
            ...ledger.map((a) => `  ${a.index}  ${a.id}  ${a.code}  ${(a.elapsedMs / 1000).toFixed(1)}s`),
            "Plan: App.json entry.surfaces · details in dsx.errors",
          ].join("\n")
        : "Something went wrong";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      // The natives re-run the plan in-process; on the web a reload IS that — boot runs the
      // whole fold again from candidate 0, which is exactly what retryRootPlan does there.
      retry.addEventListener("click", () => { window.location.reload(); });
      box.replaceChildren(pre, retry);
      opts.host.replaceChildren(box);
    },
  }, "web");
  // Frame settle = the phase coordinator's unified fire, bound to the attempt that owns the
  // REPORTING frame (`screen.frame`, published by the coordinator before this event —
  // screen.ts). A frame this plan mounted resolves to its attempt: once the fold has moved
  // on, that index is stale and the fold drops the signal instead of crowning the live
  // candidate on a dead one's settle. An unmapped or frameless report (the relay's `dom*`
  // names no frame; a frame mounted outside the plan is not the plan's business) settles
  // the live attempt exactly as before. After root.ready the fold drops everything anyway.
  const offs: Array<() => void> = [];
  offs.push(ModuleRegistry.registerDelegate("screen.ready", 0, () => {
    const frame = DSXState.get("screen.frame");
    const attempt = typeof frame === "number" ? attemptOfFrame.get(frame) : undefined;
    fold.settle(attempt);
    return null;
  }));
  // Root-attributed FAILURES reach the fold through the same error plane as the
  // natives (`module.error` with origin "root" — root-plan.md §failure attribution):
  // no web module produces one today (the page IS its origin), but the channel is
  // wired so a future surface module advances the plan without kernel edits. Any
  // other origin is an ordinary error and never touches the root.
  offs.push(ModuleRegistry.registerDelegate("module.error", 0, (input) => {
    const e = input as { origin?: string; code?: string; data?: { attempt?: unknown } } | null;
    // An attempt-BOUND failure (the surface stamped `data.attempt` from the kernel-owned
    // `root.attempt`) is delivered only while that attempt is live; an unstamped one stays
    // unbound and lands on the live attempt, as before. Twin of the two natives' error arm.
    if (e?.origin === "root") {
      const stamped = typeof e.data?.attempt === "number" ? e.data.attempt : undefined;
      fold.rootError(e.code ?? "error", "root", stamped);
    }
    return null;
  }));
  activeBoot = { fold, offs, router: () => liveRouter };
  fold.start();
  // The first candidate mounted synchronously inside start() — every frame that will
  // ever claim a server root has claimed it. A root no frame wanted is a divergence:
  // finishAdopt counts it, says so once, and removes it (fail-open). Later fallback
  // candidates go through mount(c, i>0), which abandons any residue anyway.
  finishAdopt();
  return liveRouter ?? new FrameRouter(opts.registry, opts.host);
}
