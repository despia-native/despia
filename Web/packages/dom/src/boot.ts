//
//  boot.ts - the bootloader (constitution: hosts are bootloaders — mount the kernel,
//  register chunks, hand off; app behavior lives in packages). Injects the cascade
//  (layer statement → tokens → elements → compiled app css), seeds the app-wide
//  store (screen metrics, app identity), registers module chunks, mounts the entry.
//

import {
  DSXState, DSXStrings, ModuleRegistry, JSESeams, installScreenPhase, installJsTier, invalidateCookies, string,
  type WebModule, type Dict,
} from "@despia-native/kernel";
import { LAYER_STATEMENT } from "@despia-native/compiler/cssmap";
import type { Registry } from "@despia-native/compiler/resolve";
import { FrameRouter, frameIdCursor } from "./router.ts";
import { routeModule } from "./route-module.ts";
import { setCookieWriter, setLinkSeam, WebMcpSeam } from "./mount.ts";
import { abandonAdopt, applyStreamChunk, beginAdopt, finishAdopt, seedApiEnvelopes } from "./adopt.ts";
import { bindWebMcpTools } from "./webmcp.ts";
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
import { CANVAS_CSS, registerCanvasSurface } from "./canvas.ts";
import { installButtonKeyboardActivation } from "./keyboard.ts";
import {
  TOKENS_CSS, APPLICATION_ELEMENTS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS,
} from "./theme.ts";
import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "./globals.ts";
import { PROSE_CSS } from "./prose.ts";
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
  /** THE PLATFORM CATALOG — `ModulePlatformSupport.generated.json` verbatim (X2 §4). The
   *  browser has no compiled-in table like the two natives, so the build hands it here and
   *  the kernel folds it against this OS. Without it a native-only action answers
   *  `not_loaded`, which the bus defines as a caller bug and which is a lie when a manifest
   *  already said the action cannot run in a browser. */
  platformSupport?: { byScheme?: Record<string, string[]>; byAction?: Record<string, string[]> };
  /** app identity seeded under global.app */
  app?: Dict;
  /** app-wide constants (App.json `consts`) seeded under the reactive `dsx.const.*`
   *  plane — networking.md N0. Flat public scalars; a remote `consts_url` may sharpen
   *  them later (the host re-sets this key and screens update). */
  consts?: Dict;
  /** surface integration hook, invoked after construction but before any frame mounts */
  configureRouter?: (router: FrameRouter) => void;
};

/** The strings BUILD tier's loader over the registry's folded tables (P12): DSXStrings
 *  wants JSON TEXT per candidate tag (the same contract as the native bundle reads), so
 *  the fold serializes on demand - a page that never leaves its source language never
 *  pays for it. Absent tables mean a null loader answer, which is the fail-open floor. */
function wireStringsLoader(registry: Registry): void {
  const tables = registry.strings;
  DSXStrings.loader = tables === undefined
    ? null
    : (lang) => (tables[lang] === undefined ? null : JSON.stringify(tables[lang]));
}

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
  registerCanvasSurface();  // <canvas> (parity/U04) — the 2-D drawing surface
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
  injectStyle(CANVAS_CSS, "dsx-canvas");
  injectStyle(GLOBAL_ELEMENTS_CSS, "dsx-global-elements");
  // The prose plane rides the markdown fold: checked INSIDE the condition like the
  // element factory (elements.ts), so a build defining the flag false folds the sheet
  // away with the vocabulary it skins (/web/13 byte law).
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_MARKDOWN__?: boolean })
    .__DSX_OPTIONAL_MARKDOWN__ !== false) {
    injectStyle(PROSE_CSS, "dsx-prose");
  }
  injectStyle(opts.registry.css, "dsx-app-css");

  // The strings BUILD tier (P12): the registry carries the app's Strings.<tag>.json
  // tables, and the kernel seam gets its synchronous loader over them - wired BEFORE
  // mount so the first paint already localizes. The define is checked inside the
  // condition (the markdown fold's pattern) so embeds shed the tier entirely.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STRINGS__?: boolean })
    .__DSX_OPTIONAL_STRINGS__ !== false) {
    wireStringsLoader(opts.registry);
  }

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
  // WebMCP (proposals/webmcp.md §3): fill the seam mount.ts holds, so a document's `<tool>`
  // rows can reach the user agent. Wired HERE rather than by a side-effect import in the
  // adapter, because this package declares `sideEffects: false` and a bundler is entitled
  // to drop an import whose exports nobody names — which is exactly what happened the first
  // time, silently. An embed never boots, so it still never carries the adapter.
  WebMcpSeam.bind = bindWebMcpTools;
  // BEFORE any module registers: a call can be made from a boot hook, and the catalog is the
  // only thing that keeps its failure honest.
  if (opts.platformSupport !== undefined) ModuleRegistry.setPlatformSupport(opts.platformSupport);
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
  // The claimed host is the app's one landmark: everything this boot mounts (frames,
  // chrome, overlays) lives inside it, so `main` here puts all content in a landmark
  // (axe `region`). Author-set roles win; a <body> host cannot be a landmark itself.
  if (!opts.host.hasAttribute("role") && opts.host.tagName !== "BODY") {
    opts.host.setAttribute("role", "main");
  }

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
      // `dsx.module.route` — the programmatic twin of `href=`, same names as both natives
      // (route-module.ts). FALLBACK registration: a bundled Routing facet (chrome, the
      // component verbs) already owns the scheme and must stay the owner — an unmarked
      // registration here shadowed it and killed the web system bar (NavBar's
      // route.chrome claim → unknown_action). A later boot still replaces the previous
      // fallback instance; a provided module is never replaced.
      ModuleRegistry.register(routeModule(router), { fallback: true });
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
  const handle = liveRouter ?? new FrameRouter(opts.registry, opts.host);
  // The devtools state door: the live data-store panel (despia edit) and anything else
  // debugging this page read the active screen's variables here. A page's own JS heap is
  // already open in devtools, so this exposes reach, not access.
  (globalThis as typeof globalThis & { __DSX_STATE__?: unknown }).__DSX_STATE__ = {
    snapshot: () => handle.devState(),
    set: (name: string, value: unknown) => handle.devSetState(name, value),
    sink: (fn: () => void) => handle.devSinkState(fn),
    // "Try it" (platform/09 WE6): the studio runs a declared action here as an entry call.
    call: (action: string, args: { [k: string]: unknown }) => handle.devCallAction(action, args),
  };
  // The devtools SWAP door (master plan P2): the dev reload client hands a freshly
  // compiled registry here instead of reloading the page — new css injected over the
  // same style node, every live frame re-instantiated with its variable state carried.
  // Same reach-not-access reasoning as the state door; production pages simply never
  // receive the swap event that would call it.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_EDIT_TAGS__?: boolean })
    .__DSX_OPTIONAL_EDIT_TAGS__ !== false) {
    (globalThis as typeof globalThis & { __DSX_SWAP__?: unknown }).__DSX_SWAP__ = (registry: Registry): void => {
      injectStyle(registry.css, "dsx-app-css");
      // a swapped registry may carry different strings tables; the seam's cache keys on
      // (lang, version), so re-wire AND drop it or a stale table survives the swap
      if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STRINGS__?: boolean })
        .__DSX_OPTIONAL_STRINGS__ !== false) {
        wireStringsLoader(registry);
        DSXStrings.reset();
      }
      handle.hotSwap(registry);
    };
  }
  return handle;
}
