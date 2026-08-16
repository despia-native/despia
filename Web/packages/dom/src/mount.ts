//
//  mount.ts - the binding engine (/web/01 rendering model): instantiate a component's
//  IR subtree, create DOM via the element library, bind exactly what is reactive —
//  static attrs set once; `{{ }}` bindings become effects; `visible-if` is a presence
//  toggle on a comment anchor (remove-from-tree semantics, NOT display:none); lists
//  reconcile keyed rows (the single place any diffing happens); slot content renders
//  in the CALLER's scope (/web/19).
//
//  Updates are O(changed bindings): every effect subscribes to exactly the store keys
//  its expression read, deduped by watchKey. No virtual DOM anywhere.
//

import {
  ReactiveStore, ActionRunner, makeRunEnv, writeBound, JSE, JSESeams, ApiBlock, ApiGraph, ModuleRegistry,
  string, truthy, number, isDict, watchKey, noteSurfaceRead, type Dict, type RunEnv, type ApiSpec, type ApiSeed,
} from "@despia/kernel";
import { legacyAttrToDecls, mapStyleValue, BRIDGE_ATTRS } from "@despia/compiler/cssmap";
import { resolveComponent, type Registry } from "@despia/compiler/resolve";
import type { XmlNode } from "@despia/compiler/xml";
import type { ComponentIR } from "@despia/compiler/component";
import {
  ELEMENTS, GLOBAL_ELEMENTS, UNSUPPORTED, BUTTON_ROLES, booleanWord, createMarquee, iconSvg,
  type ElementApi, type ElementFactory,
} from "./elements.ts";
import { asFacetComponent, type FacetComponent, type FacetCtx, type FacetInstance } from "./facet.ts";
import { registerInputDeclarations, onInputEdge } from "./input.ts";

export type SlotContent = {
  defaults: XmlNode[];
  named: Map<string, XmlNode[]>;
  /** the caller's mount context — slot content evaluates in the CALLER's data scope */
  ctx: MountCtx;
};

export type MountCtx = {
  registry: Registry;
  scheme: string;
  owner: string;
  store: ReactiveStore;
  runner: ActionRunner;
  env: RunEnv;
  item: Dict | null;
  disposers: Array<() => void>;
  slots: SlotContent | null;
  /** rowWrite target when inside a `<list bind=…>` row bound to a plain store path */
  rowBinding: { arrayPath: string; index: number } | null;
  /** Private row-local invalidation seam. Keyed collection rows keep their DOM
   * identity while `item.*` values/indexes change; this signal re-evaluates the
   * existing bindings without publishing a synthetic variable into app state. */
  itemRefresh?: { listeners: Set<() => void> } | null;
  /** Enclosing `<form as=…>` environment value inherited by descendant fields. */
  formNamespace?: string | null;
};

function subCtx(ctx: MountCtx, overrides: Partial<MountCtx> = {}): MountCtx {
  return { ...ctx, disposers: [], ...overrides };
}

function adoptDisposers(parent: MountCtx, child: MountCtx): void {
  parent.disposers.push(() => child.disposers.forEach((d) => d()));
}

/** cookie write seam — the bootloader wires document.cookie here (@despia/dom owns it) */
let cookieWriter: ((name: string, value: unknown) => void) | null = null;
export function setCookieWriter(fn: (name: string, value: unknown) => void): void {
  cookieWriter = fn;
}

/** link seam (`href=` — the anchor attribute, /web/04) — the bootloader wires the
 *  FrameRouter here: `url` renders the base-joined document URL an anchor carries,
 *  `navigate` SPA-pushes a clicked internal path (false = not ours, browser takes it). */
let linkSeam: { url(path: string): string; navigate(path: string): boolean } | null = null;
export function setLinkSeam(seam: { url(path: string): string; navigate(path: string): boolean } | null): void {
  linkSeam = seam;
}

/** element-motion seam — the universal motion attributes (enter/transition/keep/anim/
 *  animDuration). A SEAM, not an import, for the same reason as RunnerScreenSeam: mount.ts
 *  ships in every bundle including self-contained embeds, and the animation machinery
 *  (./element-motion.ts) must cost a motion-free embed nothing. Filled by
 *  registerElementMotion() — the app boot always; an embed entry only when its sliced
 *  markup carries a motion attribute. Empty seam = the pre-motion behavior, byte-identical. */
export const ElementMotionSeam = {
  impl: null as {
    enter(el: HTMLElement, attrs: Record<string, string>): void;
    vif(node: XmlNode, ctx: MountCtx, parent: ParentNode, expr: string): boolean;
  } | null,
};
/** the mount internals element-motion needs (private otherwise; bundlers strip unused exports) */
export const motionSubCtx = subCtx;
export function motionEffect<T>(ctx: MountCtx, read: () => T, apply: (value: T) => void): () => void {
  return contextEffect(ctx, read, apply);
}

/** adopt-hydration seam (W6, adopt.ts): fills instantiate's `adopt` path. A SEAM for
 *  the same reason as ElementMotionSeam — mount.ts ships in every bundle including
 *  self-contained embeds, and the adopt walk must cost a non-SSR bundle nothing.
 *  Registered by adopt.ts at module load; only boot/router pull that module in. */
export const AdoptSeam = {
  impl: null as ((ir: ComponentIR, ctx: MountCtx, server: Element) => HTMLElement) | null,
};
/** SSR api-hydration seam (W6, adopt.ts): an SSR boot carries `window.__DSX__.api`
 *  seeds; adopt.ts fills `claim` so a mounting `<api>` block adopts the server-resolved
 *  envelope (consumed once, by `as`) and skips its initial fetch. Empty seam (every
 *  non-SSR bundle, and embeds — adopt.ts is the only registrar) = the fetch-on-mount
 *  path, byte-identical to before. */
export const ApiSeedSeam = {
  claim: null as ((as: string) => ApiSeed | null) | null,
};

/** doc 02 out-of-order streaming (adopt.ts implements; embeds fold it away with adopt):
 *  every mounted `<api>` block is OFFERED so a late stream chunk can seed it in place —
 *  first-wins by `as`, the stream's own addressing (one route scope per document). */
export const StreamSeedSeam = {
  offer: null as ((as: string, block: ApiBlock) => void) | null,
};
/** the mount internals the adopt walk needs (adopt.ts; bundlers strip when unused) */
export const adoptInternals = {
  makeApi: (node: XmlNode, ctx: MountCtx, childCtx?: MountCtx): ElementApi => makeApi(node, ctx, childCtx),
  wireCommon: (el: HTMLElement, node: XmlNode, ctx: MountCtx, api: ElementApi): void => wireCommon(el, node, ctx, api),
  subCtx,
  contextEffect,
  adoptDisposers,
  mountComponent: (node: XmlNode, ctx: MountCtx, parent: ParentNode, adoptEl: Element): HTMLElement | null => {
    // positional derivation instead of a mountComponent return value: the return
    // would ride every embed's common path, and replaceWith preserves the sibling
    // chain, so the element now in adoptEl's slot IS the instance root (adopted, or
    // the fresh root an inner mismatch swapped in).
    const prev = adoptEl.previousSibling;
    mountComponent(node, ctx, parent, adoptEl);
    const placed = prev !== null ? prev.nextSibling : parent.firstChild;
    return placed !== null && placed.nodeType === 1 ? placed as HTMLElement : null;
  },
};

const BOUND_COLLECTION_TAGS = new Set(["list", "grid", "pager"]);
export const BOUND_COLLECTION_LIMIT = 1_000;
const SURFACE_NAMES = new Set(["glass", "ultraThin", "thin", "regular", "thick", "sheet"]);
/** structural attrs the renderer consumes — never forwarded to element factories */
const CONSUMED = new Set(["visible-if", "__css", "__style_reactive", "slot", "key", "scroll"]);

/** per-surface sequence for `container` scope keys (dsx.element.* backing store) */
let containerSeq = 0;

/** Renderer-neutral state machine for the authored hover pair. UI adapters decide
 * whether an enter came from a hover-capable device, then this class owns pointer
 * identity, deduplication, and teardown balancing. Its contract is shared in
 * OpenSource/Conformance/input/hover.json and executed by all three runtimes. */
export type HoverLifecycleAction = "start" | "end";
export class HoverLifecycle {
  readonly activePointers = new Set<string | number>();

  enter(pointerId: string | number, pointerType: string, hoverCapable: boolean): HoverLifecycleAction[] {
    if (!hoverCapable || pointerType === "touch" || this.activePointers.has(pointerId)) return [];
    const wasIdle = this.activePointers.size === 0;
    this.activePointers.add(pointerId);
    return wasIdle ? ["start"] : [];
  }

  leave(pointerId: string | number): HoverLifecycleAction[] {
    if (!this.activePointers.delete(pointerId) || this.activePointers.size !== 0) return [];
    return ["end"];
  }

  cancel(pointerId: string | number): HoverLifecycleAction[] { return this.leave(pointerId); }

  unmount(): HoverLifecycleAction[] {
    if (this.activePointers.size === 0) return [];
    this.activePointers.clear();
    return ["end"];
  }
}

export interface ShortcutKeyEvent {
  key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; editable: boolean;
}

/** Shared `shortcut=` accelerator match (OpenSource/Conformance/input/shortcut.json) — the twin
 *  of Swift/Kotlin StackDesktopInput.matchesShortcut. `cmd` matches meta OR ctrl; an unmodified
 *  shortcut is suppressed while an editable target holds focus. */
export function matchShortcut(shortcut: string, event: ShortcutKeyEvent): boolean {
  const parts = shortcut.toLowerCase().split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  const key = parts[parts.length - 1] ?? "";
  if (key === "" || event.key.toLowerCase() !== key) return false;
  const mods = new Set(parts.slice(0, -1));
  if (mods.has("cmd") && !(event.meta || event.ctrl)) return false;
  if (mods.has("ctrl") && !event.ctrl) return false;
  if (mods.has("alt") && !event.alt) return false;
  if (mods.has("shift") && !event.shift) return false;
  if (event.editable && !mods.has("cmd") && !mods.has("ctrl")) return false;
  return true;
}

/** Shared `focusOrder=` traversal resolution (OpenSource/Conformance/input/focusOrder.json).
 *  Disabled ⇒ -1 (out of traversal); a decimal-integer order ⇒ that index; absent/non-finite/
 *  empty ⇒ null (toolkit default). */
export function resolveFocusOrder(focusOrder: string | null | undefined, disabled: boolean): number | null {
  if (disabled) return -1;
  if (focusOrder === null || focusOrder === undefined) return null;
  const trimmed = focusOrder.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

// ── the element api ─────────────────────────────────────────────────────────────────

/** A normal store effect plus the row-local invalidation seam. The outer watchKey
 * guard is intentional: a keyed row refresh and a store write in the same tick
 * must not touch the DOM twice with the same value. */
function contextEffect<T>(ctx: MountCtx, read: () => T, apply: (value: T) => void): () => void {
  let initialized = false;
  let last = "";
  const deliver = (value: T): void => {
    const next = watchKey(value);
    if (initialized && next === last) return;
    initialized = true;
    last = next;
    apply(value);
  };
  const disposeStore = ctx.store.effect(read, deliver);
  const refresh = (): void => deliver(read());
  ctx.itemRefresh?.listeners.add(refresh);
  return () => {
    ctx.itemRefresh?.listeners.delete(refresh);
    disposeStore();
  };
}

function makeApi(node: XmlNode, ctx: MountCtx, childCtx: MountCtx = ctx): ElementApi {
  return {
    bindText(expr, apply) {
      if (expr === undefined) return;
      if (!expr.includes("{{")) { apply(expr); return; }
      ctx.disposers.push(contextEffect(ctx,
        () => ctx.store.interpolate(expr, ctx.item),
        (v) => apply(v),
      ));
    },
    bindValue(expr, apply) {
      if (expr === undefined) return;
      ctx.disposers.push(contextEffect(ctx,
        () => ctx.store.eval(expr, ctx.item),
        (v) => apply(v),
      ));
    },
    writeBack(path, value) {
      if (path === undefined) return;
      // rowWrite: bind="item.field" writes through to the bound array element
      if (path.startsWith("item.") && ctx.rowBinding) {
        ctx.store.setPath(`${ctx.rowBinding.arrayPath}.${ctx.rowBinding.index}.${path.substring(5)}`, value);
        return;
      }
      writeBound(ctx.env, path, value);
    },
    handler(name, payload = {}) {
      const h = node.attrs[`on:${name}`];
      if (h === undefined) return;
      runHandler(node, ctx, name, h, payload);
    },
    hasHandler(name) {
      return node.attrs[`on:${name}`] !== undefined;
    },
    children(parent, nodes = node.children, inherit = {}) {
      const inheritedCtx = inherit.formNamespace === undefined
        ? childCtx
        : { ...childCtx, formNamespace: inherit.formNamespace };
      for (const child of nodes) mountNode(child, inheritedCtx, parent);
    },
  };
}

/** run an on:* handler through its declared throttle/debounce gate */
const gateState = new WeakMap<XmlNode, Map<string, { last: number; timer: ReturnType<typeof setTimeout> | null }>>();

function runHandler(node: XmlNode, ctx: MountCtx, name: string, handler: string, payload: Dict): void {
  const throttle = node.attrs[`on:${name}.throttle`];
  const debounce = node.attrs[`on:${name}.debounce`];
  const fire = (): void => { void ctx.runner.run(handler, ctx.item, payload); };
  if (throttle === undefined && debounce === undefined) { fire(); return; }
  const gates = gateState.get(node) ?? new Map();
  gateState.set(node, gates);
  const gate = gates.get(name) ?? { last: 0, timer: null };
  gates.set(name, gate);
  if (debounce !== undefined) {
    const ms = number(debounce) ?? 0;
    if (gate.timer !== null) clearTimeout(gate.timer);
    gate.timer = setTimeout(fire, ms);
    return;
  }
  const ms = number(throttle) ?? 0;
  const now = Date.now();
  if (now - gate.last >= ms) {
    gate.last = now;
    fire();
  } else if (gate.timer === null) {
    gate.timer = setTimeout(() => {
      gate.timer = null;
      gate.last = Date.now();
      fire();
    }, ms - (now - gate.last));
  }
}

// ── node mounting ────────────────────────────────────────────────────────────────────

export function mountNode(node: XmlNode, ctx: MountCtx, parent: ParentNode): void {
  const vif = node.attrs["visible-if"];
  if (vif !== undefined && vif.startsWith("has:")) {
    // `visible-if="has:scheme"` — the capability-check special form (StackReference
    // "Bindings"): stripped BEFORE JSE and answered by the availability plane, the
    // exact twin of Stack.swift's `cond.hasPrefix("has:")` → `env.has(…)` and
    // StackNodeView.kt's `cond.startsWith("has:")` → `env.has(…)` (both trim the
    // scheme). It rides JSESeams.moduleAvailable — the same seam the JSE `has()`
    // builtin reads (ModuleRegistry.isAvailable). Availability is a build/boot fact,
    // not store state, so this decides once at mount: no anchor, no effect.
    if (!JSESeams.moduleAvailable(vif.slice(4).trim())) return;
    const inner: XmlNode = { ...node, attrs: { ...node.attrs } };
    delete inner.attrs["visible-if"];
    mountNode(inner, ctx, parent);
    return;
  }
  if (vif !== undefined) {
    // keep= / transition= make the flip ANIMATED — delegated to the element-motion seam
    // when its module is registered; an empty seam keeps the instant flip below.
    const motion = ElementMotionSeam.impl;
    if (motion !== null
        && (node.attrs["keep"] === "true" || node.attrs["transition"] !== undefined)
        && motion.vif(node, ctx, parent, vif)) return;
    const anchor = document.createComment("dsx:if");
    parent.appendChild(anchor);
    const inner: XmlNode = { ...node, attrs: { ...node.attrs } };
    delete inner.attrs["visible-if"];
    let mounted: { nodes: ChildNode[]; ctx: MountCtx } | null = null;
    const dispose = contextEffect(ctx,
      () => truthy(ctx.store.eval(vif, ctx.item)),
      (on) => {
        if (on && mounted === null) {
          const branch = subCtx(ctx);
          const frag = document.createDocumentFragment();
          mountNode(inner, branch, frag);
          const nodes = [...frag.childNodes];
          anchor.after(...nodes);
          mounted = { nodes, ctx: branch };
        } else if (!on && mounted !== null) {
          mounted.ctx.disposers.forEach((d) => d());
          mounted.nodes.forEach((n) => n.remove());
          mounted = null;
        }
      },
    );
    ctx.disposers.push(dispose, () => {
      mounted?.ctx.disposers.forEach((d) => d());
      mounted = null;
    });
    return;
  }

  if (node.tag === "slot") {
    mountSlot(node, ctx, parent);
    return;
  }
  if (node.tag === "head") return; // stripped by the compiler; ignore strays
  if (boundCollectionRuntime !== null && BOUND_COLLECTION_TAGS.has(node.tag) && node.attrs["bind"] !== undefined) {
    if (node.tag === "pager") boundCollectionRuntime.mountBoundPager(node, ctx, parent);
    else boundCollectionRuntime.mountList(node, ctx, parent);
    return;
  }
  // A small number of platform primitives have intentionally capitalized public
  // spellings (`<WebView>` mirrors the native type). Registered element-library
  // primitives must win before the generic Capitalized-component route; otherwise
  // the builtin factory is unreachable and a valid WebView degrades to `<?>`.
  const builtin = ELEMENTS[node.tag];
  if (builtin !== undefined) {
    mountElementFactory(node, ctx, parent, builtin);
    return;
  }
  if (/^[A-Z]/.test(node.tag) || node.tag.includes(".")) {
    mountComponent(node, ctx, parent);
    return;
  }

  mountElementFactory(node, ctx, parent, UNSUPPORTED);
}

/** Mount an element-library factory through the full universal wrapper contract.
 *  Native global components use this same path as lowercase primitives: styles,
 *  gestures, measure=, container scope, and cleanup must stay identical. */
function mountElementFactory(
  node: XmlNode,
  ctx: MountCtx,
  parent: ParentNode,
  factory: ElementFactory,
): void {
  let api = makeApi(node, ctx);
  let containerKey: string | null = null;
  if (node.attrs["container"] !== undefined) {
    // `container` — publish this element's live size to DESCENDANTS as
    // `dsx.element.width/height` (JSE resolves it to item.__element — the
    // StackContainer environment contract). The scope getters read through the
    // store with read-tracking, so `columns="{{ dsx.element.width > 360 ? 2 : 1 }}"`
    // re-flows live; outside any container dsx.element.* stays null.
    const key = (containerKey = `__container_${containerSeq++}`);
    const store = ctx.store;
    const scope = {
      get width(): unknown { noteSurfaceRead(key); return (store.vars.get(key) as Dict | undefined)?.["width"] ?? null; },
      get height(): unknown { noteSurfaceRead(key); return (store.vars.get(key) as Dict | undefined)?.["height"] ?? null; },
    };
    const childCtx: MountCtx = { ...ctx, item: { ...(ctx.item ?? {}), __element: scope } };
    api = makeApi(node, ctx, childCtx);
  }
  const element = factory(node, ctx, api);
  wireCommon(element, node, ctx, api);
  if (containerKey !== null) {
    const key = containerKey;
    const ro = new ResizeObserver(() => {
      const r = element.getBoundingClientRect();
      ctx.store.set(key, { width: r.width, height: r.height }); // deep-equal writes elided
    });
    ro.observe(element);
    ctx.disposers.push(() => ro.disconnect());
  }
  parent.appendChild(element);
  // enter= — entry animation on first appear, at final layout (the element-motion seam;
  // inert until registerElementMotion(), so a motion-free embed pays nothing).
  if (node.attrs["enter"] !== undefined) ElementMotionSeam.impl?.enter(element, node.attrs);
}

/** generic wiring every builtin gets: css handles, reactive styles, the legacy
 *  attribute bridge (reactive side), a11y attrs, and the universal event/measure
 *  surface — tap/appear/disappear/longpress, the on:drag pointer lifecycle,
 *  on:adjust, and measure= (the Stack.swift decorate() twins) */
function wireCommon(el: HTMLElement, node: XmlNode, ctx: MountCtx, api: ElementApi): void {
  wireStyles(el, node, ctx, api);
  wireGestures(el, node, ctx, api);
  wireMeasure(el, node, ctx);
  wireDeclaredInput(node, ctx, api);
}

/** G4 unified input (dsx-game.md §2): `on:input.<name>` on ANY element subscribes to the
 *  declared binding's press EDGE and dispatches through the standard gated handler path —
 *  `on:input.jump.throttle` / `.debounce` keep working because runHandler owns the gate.
 *  Zero cost when the element declares none. */
function wireDeclaredInput(node: XmlNode, ctx: MountCtx, api: ElementApi): void {
  // A sliceable feature: an embed that declares no `<input>` and authors no
  // `on:input.<name>` folds this whole block (and the input runtime with it) away.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_INPUT__?: boolean })
    .__DSX_OPTIONAL_INPUT__ === false) return;
  for (const name of Object.keys(node.attrs)) {
    if (!name.startsWith("on:input.") || name.endsWith(".throttle") || name.endsWith(".debounce")) continue;
    const binding = name.substring("on:input.".length);
    if (binding.length === 0) continue;
    ctx.disposers.push(onInputEdge(binding, (event) => {
      api.handler(`input.${binding}`, { name: event.name, x: event.x, y: event.y });
    }));
  }
}

/** the presentation half of the universal surface — css handles, class formulas, grow,
 *  reactive styles, the legacy attribute bridge, a11y attrs. Shared by builtin
 *  elements and facet hosts. Composed roots reuse only wireVisualStyles below:
 *  component role/a11y attrs remain props unless the component itself forwards them. */
function wireStyles(el: HTMLElement, node: XmlNode, ctx: MountCtx, api: ElementApi): void {
  wireVisualStyles(el, node, ctx, api);

  // ACCESSIBILITY — the cross-platform contract (StackReference §Accessibility), TWO
  // equal spellings per key: the DSX one (a11y*) and the web-standard aria one, which
  // this renderer emits VERBATIM (what a web developer writes is what the DOM gets).
  // role= passes through as-is ("group" included — the native twins map it to combine
  // semantics); a11yTrait keeps its header→heading nicety.
  const a = (dsx: string, aria: string): string | undefined => node.attrs[dsx] ?? node.attrs[aria];
  const roleAttr = node.attrs["role"];
  if (node.attrs["a11yGroup"] === "true" || roleAttr === "group") el.setAttribute("role", "group");
  if (node.attrs["a11yTrait"] === "header") { el.setAttribute("role", "heading"); el.setAttribute("aria-level", "2"); }
  else if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_ROLE__?: boolean })
    .__DSX_OPTIONAL_ROLE__ !== false && roleAttr !== undefined && roleAttr !== "group") {
    // role= passes through BOUND like aria-label below (an interpolated role resolves —
    // never the raw {{ }} template text) and guarded per RESOLVED value:
    // "destructive|cancel" on a button-family element is the semantic BUTTON role word
    // (system-defaults.md) — elements.ts consumes it as data-dsx-role; forwarding it
    // here would mint an invalid ARIA role. Every other resolved value lands verbatim.
    const buttonFamily = el.classList.contains("dsx-button") || el.classList.contains("dsx-pressable");
    api.bindText(roleAttr, (v) => {
      const t = v.trim();
      if (t.length === 0 || (buttonFamily && BUTTON_ROLES.has(t))) el.removeAttribute("role");
      else el.setAttribute("role", t);
    });
  }
  if (a("a11yHidden", "aria-hidden") === "true") el.setAttribute("aria-hidden", "true");
  const label = a("a11yLabel", "aria-label");
  if (label !== undefined && el.tagName !== "BUTTON") {
    api.bindText(label, (v) => el.setAttribute("aria-label", v));
  }
  const hint = a("a11yHint", "aria-description");
  if (hint !== undefined) {
    api.bindText(hint, (v) => el.setAttribute("aria-description", v));
  }
  const valueText = a("a11yValue", "aria-valuetext");
  if (valueText !== undefined) {
    api.bindText(valueText, (v) => el.setAttribute("aria-valuetext", v));
  }
  const pressed = a("a11yPressed", "aria-pressed");
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_PRESSED__?: boolean })
    .__DSX_OPTIONAL_PRESSED__ !== false && pressed !== undefined) {
    api.bindText(pressed, (value) => {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        el.setAttribute("aria-pressed", "true");
      } else if (normalized === "false" || normalized === "0") {
        el.setAttribute("aria-pressed", "false");
      } else if (normalized === "mixed") {
        el.setAttribute("aria-pressed", "mixed");
      } else {
        el.removeAttribute("aria-pressed");
      }
    });
  }
}

function wireVisualStyles(el: HTMLElement, node: XmlNode, ctx: MountCtx, api: ElementApi): void {
  wireRootStyleContract(el, node, api);

  // `surface=` is a universal StackStyle material, not a button-only decoration.
  // Resolve the enum into a stable class instead of forwarding raw remote markup;
  // unknown values fail open to no material and can never throw in DOMTokenList.
  let currentSurface = "";
  const surface = node.attrs["surface"];
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_SURFACES__?: boolean })
    .__DSX_OPTIONAL_SURFACES__ !== false && surface !== undefined) {
    api.bindText(surface, (value) => {
      if (currentSurface.length > 0) el.classList.remove(`dsx-surface-${currentSurface}`);
      const candidate = value.trim();
      currentSurface = SURFACE_NAMES.has(candidate) ? candidate : "";
      if (currentSurface.length > 0) el.classList.add(`dsx-surface-${currentSurface}`);
    });
  }

  const grow = node.attrs["grow"];
  if (grow !== undefined) {
    api.bindText(grow, (v) => {
      if (v === "true" || v === "width" || v === "height") el.setAttribute("data-dsx-grow", v);
      else el.removeAttribute("data-dsx-grow");
    });
  }
  // theme="dark|light" — the per-subtree color-scheme pin (kernel: environment colorScheme
  // + preferredColorScheme). Here it stamps data-dsx-theme, whose UNANCHORED token override
  // in theme.ts re-themes this element and everything under it.
  const theme = node.attrs["theme"];
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_THEME__?: boolean })
    .__DSX_OPTIONAL_THEME__ !== false && theme !== undefined) {
    api.bindText(theme, (v) => {
      const t = v.trim();
      if (t === "dark" || t === "light") el.setAttribute("data-dsx-theme", t);
      else el.removeAttribute("data-dsx-theme");
    });
  }

  // reactive legacy attrs ({{ }} in grow/background/color/…) — runtime bridge
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!BRIDGE_ATTRS.has(name) || !value.includes("{{")) continue;
    const applied = new Set<string>();
    api.bindText(value, (v) => {
      const decls = legacyAttrToDecls(name, v.trim());
      for (const prop of applied) el.style.removeProperty(prop);
      applied.clear();
      for (const [prop, val] of decls ?? []) {
        el.style.setProperty(prop, val);
        applied.add(prop);
      }
    });
  }
}

/** The narrow authored-root contract shared by primitives and composed invocations.
 * Component-only props (role/theme/grow/surface/a11y/legacy attrs) intentionally stay
 * out: the child decides whether to forward those. */
function wireRootStyleContract(el: HTMLElement, node: XmlNode, api: ElementApi): void {
  const css = node.attrs["__css"];
  if (css !== undefined && css.length > 0) {
    const own = el.getAttribute("data-dsx");
    el.setAttribute("data-dsx", own === null || own.length === 0 ? css : `${own} ${css}`);
  }

  if (node.attrs["__row"] === "1") el.classList.add("dsx-hstack"); // static row axis

  const cls = node.attrs["class"];
  if (cls !== undefined && cls.length > 0) {
    if (cls.includes("{{")) {
      if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_CLASS_FORMULAS__?: boolean })
        .__DSX_OPTIONAL_CLASS_FORMULAS__ !== false) {
        // class FORMULAS (S1 semantics: interpolate then match — doc 01); the element's
        // own/state classes stay intact; only the previous authored tokens are swapped.
        // Resetting className wholesale would erase a live surface/state class.
        const fixed = new Set(el.className.split(/\s+/).filter((name) => name.length > 0));
        const authored = new Set<string>();
        api.bindText(cls, (v) => {
          for (const c of authored) el.classList.remove(c);
          authored.clear();
          for (const c of v.split(/\s+/)) {
            if (c.length === 0) continue;
            el.classList.add(c);
            if (!fixed.has(c)) authored.add(c);
          }
        });
      }
    } else {
      for (const c of cls.split(/\s+/)) if (c.length > 0) el.classList.add(c); // sheets JUST WORK (/web/06)
    }
  }
  const reactiveStyle = node.attrs["__style_reactive"];
  if (reactiveStyle !== undefined) {
    for (const decl of reactiveStyle.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const prop = decl.substring(0, colon).trim();
      const value = decl.substring(colon + 1);
      api.bindText(value, (v) => {
        const mapped = mapStyleValue(prop, v.trim());
        if (mapped.length === 0 || v.trim().length === 0) el.style.removeProperty(prop);
        else el.style.setProperty(prop, mapped);
        if (prop === "flex-direction") el.classList.toggle("dsx-hstack", v.trim().startsWith("row"));
      });
    }
  }

}

/** the input half — tap/link, appear/disappear, longpress, the on:drag pointer
 *  lifecycle, on:adjust (builtin elements only; facets own their own input) */
function wireGestures(el: HTMLElement, node: XmlNode, ctx: MountCtx, api: ElementApi): void {
  // a recognized long-press consumes the release tap (the reference gesture
  // exclusivity: a hold that fired on:longpress must not ALSO read as on:tap)
  let suppressTap = false;

  const href = node.attrs["href"];
  if (href !== undefined) {
    // `href=` — the ANCHOR attribute (/web/04): tapping runs `on:tap` (if any), then
    // navigates the route table — the declarative twin of `dsx.module.route.push({path})`
    // on every renderer. On web it is a REAL link: buttons/pressables render as `<a>`
    // (elements.ts), the document URL is base-joined (crawlable, cmd/middle-clickable),
    // and a plain left-click on an internal path SPA-navigates; modified clicks and
    // external or unmatched URLs keep the browser default.
    api.bindText(href, (v) => {
      el.setAttribute("data-dsx-href", v);
      if (el instanceof HTMLAnchorElement) el.href = v.startsWith("/") && linkSeam !== null ? linkSeam.url(v) : v;
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (suppressTap) { suppressTap = false; e.preventDefault(); return; }
      if (api.hasHandler("tap")) api.handler("tap");
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const raw = el.getAttribute("data-dsx-href") ?? "";
      if (raw.startsWith("/") && linkSeam !== null && linkSeam.navigate(raw)) e.preventDefault();
    });
    if (el.tagName !== "A" && el.tagName !== "BUTTON") {
      // non-anchor linkables get link semantics (the a11y mapping, /web/08)
      el.setAttribute("role", "link");
      el.tabIndex = 0;
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (el as HTMLElement).click();
        }
      });
      el.classList.add("dsx-tappable");
    }
  } else if (api.hasHandler("tap")) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (suppressTap) { suppressTap = false; return; }
      api.handler("tap");
    });
    if (el.tagName !== "BUTTON") {
      // non-button tappables get button semantics (the a11y mapping, /web/08)
      el.setAttribute("role", "button");
      el.tabIndex = 0;
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          api.handler("tap");
        }
      });
      el.classList.add("dsx-tappable");
    }
  }
  if (api.hasHandler("appear")) {
    queueMicrotask(() => api.handler("appear"));
  }
  // on:disappear — the unmount half of the appear lifecycle: fires when the element
  // leaves the tree (surface unmount, a visible-if toggle-off, a reconciled row
  // removal) — the onDisappear twin.
  if (api.hasHandler("disappear")) {
    ctx.disposers.push(() => api.handler("disappear"));
  }

  // on:longpress — the hold gesture (the reference wiring: recognized at 500ms,
  // cancelled by >10px movement or release; no payload). Pointer events so mouse,
  // touch, and pen behave alike.
  // longpress · drag · adjust are the interactive pointer/keyboard GESTURES — a passive
  // display embed (e.g. a bare <audio>/<video>) authors none of them and strips all three
  // via the build's __DSX_OPTIONAL_GESTURES__ define (inlined per-block so esbuild folds
  // it to dead code). Full pages keep them (flag unset).
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_GESTURES__?: boolean })
    .__DSX_OPTIONAL_GESTURES__ !== false && api.hasHandler("longpress")) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sx = 0, sy = 0;
    const cancel = (): void => { if (timer !== null) { clearTimeout(timer); timer = null; } };
    el.addEventListener("pointerdown", (e) => {
      sx = e.clientX; sy = e.clientY;
      suppressTap = false;
      cancel();
      timer = setTimeout(() => { timer = null; suppressTap = true; api.handler("longpress"); }, 500);
    });
    el.addEventListener("pointermove", (e) => {
      if (timer !== null && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
    });
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerleave", cancel);
  }

  // on:hoverStart / on:hoverEnd — the pointer-hover lifecycle (desktop-platforms.md;
  // the input-grammar addition, fixtures-first). Gated per event by REAL hover
  // capability — `(any-hover: hover)` plus a non-touch pointer — so a touch-primary
  // hybrid can still use its mouse/trackpad while touch-synthesized pointerenter never
  // fakes a hover state. Once started, End is paired regardless of a mid-gesture media
  // query change, preventing a permanently-stuck authored hover state. Native twins:
  // SwiftUI `.onHover` (Stack.swift) · Compose hover pointer
  // events (StackNodeView.kt); phones without pointers degrade identically there.
  // The desktop input grammar (hover · shortcut · focusOrder) is a sliceable feature:
  // a passive embed that authors none of it strips this whole block (and HoverLifecycle)
  // via the build's __DSX_OPTIONAL_DESKTOP_INPUT__ define — full pages keep it (flag unset).
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_DESKTOP_INPUT__?: boolean })
    .__DSX_OPTIONAL_DESKTOP_INPUT__ !== false
    && (api.hasHandler("hoverStart") || api.hasHandler("hoverEnd"))) {
    const hover = new HoverLifecycle();
    const dispatchHover = (actions: HoverLifecycleAction[]): void => {
      for (const action of actions) {
        const handler = action === "start" ? "hoverStart" : "hoverEnd";
        if (api.hasHandler(handler)) api.handler(handler);
      }
    };
    const canHover = (e: PointerEvent): boolean =>
      typeof matchMedia === "function" && matchMedia("(any-hover: hover)").matches;
    el.addEventListener("pointerenter", (e) => {
      dispatchHover(hover.enter(e.pointerId, e.pointerType, canHover(e)));
    });
    const endHover = (e: PointerEvent): void => dispatchHover(hover.leave(e.pointerId));
    const cancelHover = (e: PointerEvent): void => dispatchHover(hover.cancel(e.pointerId));
    el.addEventListener("pointerleave", endHover);
    el.addEventListener("pointercancel", cancelHover);
    ctx.disposers.push(() => dispatchHover(hover.unmount()));
  }

  // shortcut="cmd+s" — the declared keyboard accelerator (desktop-platforms.md input
  // grammar): fires this element's tap while mounted. `cmd` is the PRIMARY modifier
  // (⌘ on Apple, Ctrl elsewhere — matched as either here); `ctrl`/`alt`/`shift`
  // literal; the key is the last token. An unmodified shortcut never steals keys
  // from an editable target, and a match preventDefaults (the browser's own cmd+s
  // must lose). Touch surfaces simply never fire it (Article 7). Native desktops
  // route accelerators through the Menu module (M1) where the OS gives them real
  // menu-item semantics — the element-level native twins land there.
  const shortcut = (globalThis as typeof globalThis & { __DSX_OPTIONAL_DESKTOP_INPUT__?: boolean })
    .__DSX_OPTIONAL_DESKTOP_INPUT__ !== false ? node.attrs["shortcut"] : undefined;
  if (shortcut !== undefined && (api.hasHandler("tap") || node.attrs["href"] !== undefined)) {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
      const editable = t !== null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable === true);
      if (!matchShortcut(shortcut, {
        key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, editable,
      })) return;
      e.preventDefault();
      if (api.hasHandler("tap")) api.handler("tap");
      else el.click();
    };
    document.addEventListener("keydown", onKey as EventListener);
    ctx.disposers.push(() => { document.removeEventListener("keydown", onKey as EventListener); });
  }

  // focusOrder — the traversal primitive (desktop-platforms.md input grammar): the
  // web maps it to tabIndex verbatim; the native twins map it to the platform focus
  // engines with M1/D1. Keyboard users get a declared order, touch loses nothing.
  const focusOrder = (globalThis as typeof globalThis & { __DSX_OPTIONAL_DESKTOP_INPUT__?: boolean })
    .__DSX_OPTIONAL_DESKTOP_INPUT__ !== false ? node.attrs["focusOrder"] : undefined;
  if (focusOrder !== undefined && el.getAttribute("aria-disabled") !== "true") {
    // A disabled linked button is represented by an anchor, so aria-disabled plus
    // tabindex=-1 is its native-button-disabled equivalent (elements.ts owns that
    // factory state and restores the authored order on re-enable). For an enabled
    // element, resolve the shared traversal index (input/focusOrder.json).
    const index = resolveFocusOrder(focusOrder, false);
    if (index !== null) el.tabIndex = index;
  }

  // on:drag / on:dragStart / on:dragEnd — the raw pointer lifecycle on ANY element
  // (the StackDrag contract): dsx.this = { x, y (local point), width, height,
  // fraction, fractionY (clamped 0–1), dx, dy (translation from start), phase }.
  // minimumDistance-0 semantics: the press itself fires on:drag too (tap-to-seek),
  // and with no on:dragEnd the release runs the on:drag handler with phase "end".
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_GESTURES__?: boolean })
    .__DSX_OPTIONAL_GESTURES__ !== false
    && (api.hasHandler("drag") || api.hasHandler("dragStart") || api.hasHandler("dragEnd"))) {
    el.style.touchAction = "none"; // the element owns its pointer, like a native gesture
    el.style.userSelect = "none";
    let activeId: number | null = null;
    let sx = 0, sy = 0;
    const dragPayload = (e: PointerEvent, phase: string): Dict => {
      const r = el.getBoundingClientRect();
      const w = Math.max(r.width, 1), h = Math.max(r.height, 1);
      const x = e.clientX - r.left, y = e.clientY - r.top;
      return {
        x, y, width: w, height: h,
        fraction: Math.min(Math.max(x / w, 0), 1),
        fractionY: Math.min(Math.max(y / h, 0), 1),
        dx: e.clientX - sx, dy: e.clientY - sy, phase,
      };
    };
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== activeId) return;
      api.handler("drag", dragPayload(e, "move"));
    };
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== activeId) return;
      activeId = null;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      api.handler(api.hasHandler("dragEnd") ? "dragEnd" : "drag", dragPayload(e, "end"));
    };
    el.addEventListener("pointerdown", (e) => {
      if (activeId !== null) return; // one pointer owns the gesture
      if (e.pointerType === "mouse" && e.button !== 0) return;
      activeId = e.pointerId;
      sx = e.clientX; sy = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch { /* foreign/detached pointer */ }
      api.handler("dragStart", dragPayload(e, "start")); // press / grab
      api.handler("drag", dragPayload(e, "move"));       // min-distance 0: the press is a move
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
  }

  // on:adjust — the assistive adjustable action for a custom on:drag control. The
  // web adjustable pattern is keyboard arrows on a focusable element: ArrowUp/Right
  // → increment, ArrowDown/Left → decrement. dsx.this = { direction, phase }.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_GESTURES__?: boolean })
    .__DSX_OPTIONAL_GESTURES__ !== false && api.hasHandler("adjust")) {
    if (el.tabIndex < 0) el.tabIndex = 0;
    el.addEventListener("keydown", (e) => {
      const direction = e.key === "ArrowUp" || e.key === "ArrowRight" ? "increment"
        : e.key === "ArrowDown" || e.key === "ArrowLeft" ? "decrement" : null;
      if (direction === null) return;
      e.preventDefault();
      api.handler("adjust", { direction, phase: "adjust" });
    });
  }
}

/** measure= — write the element's live { width, height } to a state path (the
 *  StackMeasure contract: an assignment through the runner, only when the size
 *  actually changes; the first observation is the onAppear write). */
function wireMeasure(el: HTMLElement, node: XmlNode, ctx: MountCtx): void {
  const measureKey = node.attrs["measure"];
  if (measureKey !== undefined && measureKey.length > 0) {
    let lastW = -1, lastH = -1;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width === lastW && r.height === lastH) return;
      lastW = r.width; lastH = r.height;
      void ctx.runner.run(`${measureKey} = { width: ${r.width}, height: ${r.height} }`, ctx.item);
    });
    ro.observe(el);
    ctx.disposers.push(() => ro.disconnect());
  }
}

// ── slots (caller-scope semantics, /web/19) ─────────────────────────────────────────

function mountSlot(node: XmlNode, ctx: MountCtx, parent: ParentNode): void {
  const slots = ctx.slots;
  if (slots === null) {
    // top-level mount with no DSX caller: in EMBED mode the slot is a NATIVE
    // <slot> — the host page's light DOM projects through the shadow boundary
    // (/web/13); DSX children render inside it as the fallback content.
    if (JSESeams.platformEmbed) {
      const el = document.createElement("slot");
      const name = node.attrs["name"];
      if (name !== undefined && name.length > 0) el.setAttribute("name", name);
      for (const child of node.children) mountNode(child, ctx, el);
      parent.appendChild(el);
    }
    return;
  }
  const name = node.attrs["name"];
  const content = name !== undefined && name.length > 0 ? slots.named.get(name) ?? [] : slots.defaults;
  for (const child of content) {
    // State/data remain in the CALLER's scope, while renderer environment values
    // (notably an enclosing form namespace) flow through the slot like SwiftUI's
    // Environment does.
    mountNode(child, { ...slots.ctx, formNamespace: ctx.formNamespace ?? slots.ctx.formNamespace }, parent);
  }
}

// ── lists (keyed reconciliation — the one diffing site) ─────────────────────────────

type BoundCollectionRuntime = {
  mountList(node: XmlNode, ctx: MountCtx, parent: ParentNode): void;
  mountBoundPager(node: XmlNode, ctx: MountCtx, parent: ParentNode): void;
};

/** Bound collections are self-contained behind a pure factory so exposed-component
 * builds can remove the complete reconciler when their transitive component slice
 * has no list/grid/pager `bind=`. Full applications and collection embeds default
 * to enabled; only the embed builder substitutes the explicit false literal. */
const boundCollectionRuntime: BoundCollectionRuntime | null =
  (globalThis as typeof globalThis & { __DSX_OPTIONAL_BOUND_COLLECTIONS__?: boolean })
    .__DSX_OPTIONAL_BOUND_COLLECTIONS__ === false
    ? null
    : (() => {

type Row = { key: string; ctx: MountCtx; raw: unknown; index: number; wrapper: HTMLElement };

/** Collection values can be large host/API arrays. ReactiveStore.effect's general
 * deep equality key is intentionally precise for ordinary bindings, but recursively
 * fingerprinting 100k/cyclic host rows would defeat collection work caps. Collection
 * reconciliation follows the state layer's copy-on-write contract instead: compare
 * the evaluated collection reference, with an explicit force for parent-row refresh. */
function collectionContextEffect(ctx: MountCtx, read: () => unknown, apply: (value: unknown) => void): () => void {
  let initialized = false;
  let previous: unknown;
  const evaluate = (force = false): void => {
    const value = read();
    if (!force && initialized && Object.is(value, previous)) return;
    initialized = true;
    previous = value;
    apply(value);
  };
  const disposeStore = ctx.store.sink(() => evaluate());
  const refresh = (): void => evaluate(true);
  ctx.itemRefresh?.listeners.add(refresh);
  return () => {
    ctx.itemRefresh?.listeners.delete(refresh);
    disposeStore();
  };
}

function boundedCollection(value: unknown, tag: string, lastWarned: { size: number }): readonly unknown[] {
  if (!Array.isArray(value)) return [];
  if (value.length > BOUND_COLLECTION_LIMIT && value.length !== lastWarned.size) {
    lastWarned.size = value.length;
    console.warn(`[dsx dom] <${tag} bind> has ${value.length} rows; mounting the first ${BOUND_COLLECTION_LIMIT}`);
  }
  return value.length > BOUND_COLLECTION_LIMIT ? value.slice(0, BOUND_COLLECTION_LIMIT) : value;
}

function keyedCollectionValue(raw: unknown, index: number, keyField: string, counts: Map<string, number>): string {
  const base = isDict(raw) ? string((raw as Dict)[keyField] ?? index) : string(raw);
  const duplicate = counts.get(base) ?? 0;
  counts.set(base, duplicate + 1);
  return duplicate === 0 ? base : `${base}·${duplicate}`;
}

function collectionItem(parentItem: Dict | null, raw: unknown, index: number): Dict {
  // A row may be a host-provided object with a huge property table. Copying it on
  // every reconciliation defeats the live-row cap, so expose an O(1) overlay view;
  // ordinary item.field lookup stays identical and enumeration remains available
  // on demand for event scopes.
  const row = isDict(raw) ? raw as Dict : null;
  const scalar = row === null ? raw : undefined;
  const parent = parentItem ?? {};
  const own = (key: PropertyKey): boolean => typeof key === "string" && (
    key === "index" || (row !== null && Object.prototype.hasOwnProperty.call(row, key))
    || (row === null && key === "value") || Object.prototype.hasOwnProperty.call(parent, key)
  );
  return new Proxy({} as Dict, {
    get: (_target, key) => {
      if (key === "index") return index;
      if (row !== null && Object.prototype.hasOwnProperty.call(row, key)) return row[key as string];
      if (row === null && key === "value") return scalar;
      return parent[key as string];
    },
    has: (_target, key) => own(key),
    ownKeys: () => [...new Set([
      ...Object.keys(parent), ...(row === null ? ["value"] : Object.keys(row)), "index",
    ])],
    getOwnPropertyDescriptor: (_target, key) => own(key)
      ? { configurable: true, enumerable: true, writable: false, value: undefined }
      : undefined,
  });
}

function refreshRow(row: Row, item: Dict, raw: unknown, index: number): void {
  const changed = row.raw !== raw || row.index !== index;
  row.ctx.item = item;
  row.raw = raw;
  row.index = index;
  if (row.ctx.rowBinding) row.ctx.rowBinding.index = index;
  if (changed) for (const listener of [...(row.ctx.itemRefresh?.listeners ?? [])]) listener();
}

function preserveFocusedNode(run: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  run();
  if (active !== null && document.activeElement !== active && typeof active.focus === "function") {
    active.focus({ preventScroll: true });
  }
}

// ── the LIST CONSTRUCTS (List.swift's construct paths: group_by · swipe · reorder) ────
//
//  The native contract, mirrored word for word (Conformance/elements/list.json `notes`):
//  group_by partitions by the STRINGIFIED field value in FIRST-SEEN order for groups AND
//  rows, the value being the section header; a GROUPED list ignores reorder and an active
//  reorder suppresses swipe (one mode per list); `scroll="false"` (fit-content) and a
//  horizontal axis WIN over all three; on:reachEnd rides the GLOBAL last row regardless
//  of section; a reorder drop rewrites the bound array through the bind seam and fires
//  on:move with { from, to } as FINAL indices.

/** A swipe-action button dict: `{ "label"|"title", "icon", "role", "color" }` plus one or
 *  both firing shapes — "event" fires the list's own `on:<event>` with the ROW as scope,
 *  "action"(+"args") dispatches on the bus. Both may be present; the event fires first. */
type ListAction = {
  label: string; icon: string; destructive: boolean; color: string;
  event: string; action: string; args: Dict;
};

/** Remote/bound action lists are authored data: cap the rail and the label the same way
 *  the overlay item model caps its tree, so a hostile array cannot mint unbounded DOM. */
const LIST_ACTION_LIMIT = 8;
const LIST_ACTION_TEXT_LIMIT = 120;

function listActionText(value: unknown): string {
  return string(value).substring(0, LIST_ACTION_TEXT_LIMIT);
}

function normalizeListActions(input: unknown): ListAction[] {
  if (!Array.isArray(input)) return [];
  const out: ListAction[] = [];
  for (const raw of input.slice(0, LIST_ACTION_LIMIT)) {
    const row: Dict = isDict(raw) ? raw as Dict : { label: raw };
    const action = listActionText(row["action"]).trim();
    out.push({
      label: listActionText(row["label"] ?? row["title"] ?? ""),
      icon: listActionText(row["icon"] ?? "").trim(),
      destructive: string(row["role"]) === "destructive",
      color: listActionText(row["color"] ?? "").trim(),
      event: listActionText(row["event"] ?? "").trim(),
      action: /^[A-Za-z_][A-Za-z0-9_.]*$/.test(action) ? action : "",
      args: isDict(row["args"]) ? row["args"] as Dict : {},
    });
  }
  return out;
}

function mountList(node: XmlNode, ctx: MountCtx, parent: ParentNode): void {
  const kind = node.tag === "grid" ? "grid" : "list";
  const cls = kind === "grid" ? "dsx-list dsx-grid" : "dsx-list";
  const container = document.createElement("div");
  container.className = cls;
  container.setAttribute("role", kind);
  container.setAttribute("data-dsx-component", kind);
  if (kind === "list") container.setAttribute("data-dsx-appearance", "automatic");
  const api = makeApi(node, ctx);
  let columns = 3;
  let collectionAxis: "horizontal" | "vertical" = "vertical";
  let rows: Row[] = [];

  const bindExpr = node.attrs["bind"]!;
  const keyField = node.attrs["key"] ?? "id";
  // a plain dotted path can host rowWrite two-way binds — and is what a reorder drop
  // writes the moved array back through (List.swift's `dsx.setBound` seam)
  const arrayPath = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(bindExpr.trim()) ? JSE.normalizeScope(bindExpr.trim()) : null;

  // ── construct state (see the LIST CONSTRUCTS note above) ──────────────────────────
  const declaresSwipe = node.attrs["swipeLeading"] !== undefined || node.attrs["swipeTrailing"] !== undefined;
  const declaresReorder = node.attrs["reorder"] !== undefined;
  const groupAttr = kind === "list" ? node.attrs["group_by"] ?? node.attrs["groupBy"] : undefined;
  const rowConstructs = kind === "list" && (declaresSwipe || declaresReorder);
  let groupField = "";
  let reorderWord = false;
  let leadingActions: ListAction[] = [];
  let trailingActions: ListAction[] = [];
  let fullLeading = false;
  let fullTrailing = false;
  let scrollWord = true;
  /** filled by the marquee below (a horizontal `autoscroll=` rail); the axis binder
   *  above it re-syncs through this handle rather than reaching forward into a TDZ */
  let syncMarquee: () => void = () => {};
  /** `scroll="false"` (fit-content) and a horizontal axis WIN over all three constructs,
   *  exactly like List.swift — a construct List is greedy and needs a scrolling viewport. */
  const constructsFit = (): boolean => kind === "list" && collectionAxis === "vertical" && scrollWord;
  const grouping = (): boolean => constructsFit() && groupField.length > 0;
  const reordering = (): boolean => constructsFit() && reorderWord && !grouping() && arrayPath !== null;
  const swiping = (): boolean => constructsFit() && !reordering()
    && (leadingActions.length > 0 || trailingActions.length > 0);

  const layoutRows = (): void => {
    preserveFocusedNode(() => {
      if (kind === "list" && grouping()) {
        // FIRST-SEEN order for groups AND rows; the stringified field value IS the header.
        const order: string[] = [];
        const buckets = new Map<string, Row[]>();
        for (const row of rows) {
          const value = isDict(row.raw) ? string((row.raw as Dict)[groupField] ?? "") : "";
          const bucket = buckets.get(value);
          if (bucket === undefined) { order.push(value); buckets.set(value, [row]); }
          else bucket.push(row);
        }
        container.replaceChildren(...order.map((value) => {
          const section = document.createElement("div");
          section.className = "dsx-list-section";
          section.setAttribute("role", "group");
          section.setAttribute("data-dsx-part", "section");
          section.setAttribute("aria-label", value);
          const header = document.createElement("div");
          header.className = "dsx-list-section-header";
          header.setAttribute("data-dsx-part", "section-header");
          // the group value is already the section's accessible NAME — the visible header
          // is its presentation, never a second announcement
          header.setAttribute("aria-hidden", "true");
          header.textContent = value;
          section.appendChild(header);
          for (const row of buckets.get(value) ?? []) section.appendChild(row.wrapper);
          return section;
        }));
        return;
      }
      if (kind === "list") {
        // a grouped→flat flip leaves emptied sections behind; drop them, then re-append
        if (container.firstElementChild?.classList.contains("dsx-list-section") === true) {
          container.replaceChildren();
        }
        for (const row of rows) container.appendChild(row.wrapper);
        return;
      }
      const groups: HTMLElement[] = [];
      for (let start = 0; start < rows.length; start += columns) {
        const group = document.createElement("div");
        group.className = "dsx-grid-aria-row";
        group.setAttribute("role", "row");
        group.setAttribute("aria-rowindex", String(Math.floor(start / columns) + 1));
        rows.slice(start, start + columns).forEach((row, offset) => {
          row.wrapper.setAttribute("aria-colindex", String(offset + 1));
          group.appendChild(row.wrapper);
        });
        groups.push(group);
      }
      container.replaceChildren(...groups);
      container.setAttribute("aria-rowcount", String(Math.ceil(rows.length / columns)));
    });
  };

  if (kind === "grid") {
    container.setAttribute("aria-colcount", "3");
    if (node.attrs["columns"] !== undefined) {
      api.bindText(node.attrs["columns"], (value) => {
        const raw = number(value);
        columns = raw !== null && raw !== undefined && Number.isFinite(raw)
          ? Math.min(Math.max(1, Math.trunc(raw)), 256) : 3;
        container.style.setProperty("--dsx-grid-columns", String(columns));
        container.setAttribute("aria-colcount", String(columns));
        layoutRows();
      });
    }
  }
  if (node.attrs["spacing"] !== undefined) {
    api.bindText(node.attrs["spacing"], (value) => {
      const raw = number(value);
      const spacing = raw !== null && raw !== undefined && Number.isFinite(raw)
        ? Math.min(Math.max(0, raw), 16_384) : kind === "grid" ? 10 : 0;
      container.style.setProperty("--dsx-collection-spacing", `${spacing}px`);
    });
  }
  api.bindText(node.attrs["axis"] ?? node.attrs["direction"] ?? "vertical", (value) => {
    const axis = value === "horizontal" ? "horizontal" : "vertical";
    collectionAxis = axis;
    container.setAttribute("data-dsx-axis", axis);
    container.classList.toggle("dsx-scroll-x", axis === "horizontal");
    refreshConstructs();
    syncMarquee();
  });
  api.bindText(node.attrs["scroll"] ?? "true", (value) => {
    scrollWord = value.trim().toLowerCase() !== "false";
    container.setAttribute("data-dsx-scroll", scrollWord ? "true" : "false");
    refreshConstructs();
  });
  api.bindText(node.attrs["align"] ?? "leading", (value) => {
    container.setAttribute("data-dsx-align", value === "center" || value === "trailing" ? value : "leading");
  });

  // ── row-construct anatomy: one host box per row, the content it slides, and the two
  //    action rails it slides over. Built only when the list DECLARES swipe/reorder, so
  //    an ordinary bound list keeps its exact previous DOM. ──────────────────────────
  type RowParts = {
    host: HTMLElement; content: HTMLElement;
    leading: HTMLElement | null; trailing: HTMLElement | null;
    handle: HTMLButtonElement | null;
    open: "leading" | "trailing" | null;
  };
  const rowParts = new WeakMap<HTMLElement, RowParts>();

  const actionButton = (action: ListAction, wrapper: HTMLElement): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dsx-list-action";
    button.setAttribute("data-dsx-part", "action");
    if (action.destructive) button.setAttribute("data-dsx-role", "destructive");
    if (action.color.length > 0) {
      const color = mapStyleValue("color", action.color);
      if (color.length > 0) button.style.setProperty("--dsx-list-action-tint", color);
    }
    if (
      (globalThis as typeof globalThis & { __DSX_OPTIONAL_ICONS__?: boolean })
        .__DSX_OPTIONAL_ICONS__ !== false
      && action.icon.length > 0
    ) {
      button.appendChild(iconSvg(action.icon, 20));
    }
    if (action.label.length > 0) {
      const label = document.createElement("span");
      label.className = "dsx-list-action-label";
      label.textContent = action.label;
      button.appendChild(label);
    } else if (action.icon.length > 0) {
      button.setAttribute("aria-label", action.icon);
    }
    button.addEventListener("click", () => {
      closeRow(wrapper);
      // the ROW is the handler scope (its fields read top-level), exactly like
      // `dsx.run(event, payload: rowItem)`; the bus dispatch is the alert/menu model
      if (action.event.length > 0) {
        const row = rows.find((r) => r.wrapper === wrapper);
        api.handler(action.event, isDict(row?.raw) ? row!.raw as Dict : {});
      }
      if (action.action.length > 0) void ModuleRegistry.call(action.action, action.args).catch(() => {});
    });
    return button;
  };

  const setOffset = (parts: RowParts, px: number): void => {
    parts.content.style.setProperty("--dsx-swipe-offset", `${px}px`);
  };
  function closeRow(wrapper: HTMLElement): void {
    const parts = rowParts.get(wrapper);
    if (parts === undefined) return;
    parts.open = null;
    parts.host.setAttribute("data-dsx-swipe", "closed");
    setOffset(parts, 0);
  }
  const railWidth = (rail: HTMLElement | null): number =>
    rail === null ? 0 : Math.max(0, rail.getBoundingClientRect().width);
  const openRow = (wrapper: HTMLElement, edge: "leading" | "trailing"): void => {
    const parts = rowParts.get(wrapper);
    if (parts === undefined || !swiping()) return;
    const rail = edge === "leading" ? parts.leading : parts.trailing;
    const width = railWidth(rail);
    if (width === 0) { closeRow(wrapper); return; }
    parts.open = edge;
    parts.host.setAttribute("data-dsx-swipe", edge);
    setOffset(parts, edge === "leading" ? width : -width);
  };

  const renderRails = (wrapper: HTMLElement): void => {
    const parts = rowParts.get(wrapper);
    if (parts === undefined) return;
    if (parts.leading !== null) parts.leading.replaceChildren(...leadingActions.map((a) => actionButton(a, wrapper)));
    if (parts.trailing !== null) parts.trailing.replaceChildren(...trailingActions.map((a) => actionButton(a, wrapper)));
    closeRow(wrapper);
  };

  /** A drop MOVES the row in the bound array (written back through the bind seam) and
   *  fires `on:move` with { from, to } — both FINAL indices after the move. */
  const moveRow = (from: number, to: number): void => {
    if (arrayPath === null || from === to) return;
    const current = ctx.store.eval(bindExpr, ctx.item);
    if (!Array.isArray(current)) return;
    if (from < 0 || from >= current.length) return;
    const landing = Math.min(Math.max(to, 0), current.length - 1);
    if (landing === from) return;
    const next = current.slice();
    const [moved] = next.splice(from, 1);
    next.splice(landing, 0, moved);
    ctx.store.setPath(arrayPath, next);
    api.handler("move", { from, to: landing });
  };

  const rowIndexAt = (clientY: number): number => {
    let best = -1;
    rows.forEach((row, index) => {
      const rect = row.wrapper.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) best = index;
    });
    return best;
  };

  const wireRowConstructs = (wrapper: HTMLElement, parts: RowParts): void => {
    rowParts.set(wrapper, parts);
    if (parts.handle !== null) {
      const handle = parts.handle;
      let dragFrom = -1;
      handle.addEventListener("keydown", (event: KeyboardEvent) => {
        if (!reordering()) return;
        const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        if (delta === 0) return;
        event.preventDefault();
        const index = rows.findIndex((r) => r.wrapper === wrapper);
        if (index >= 0) moveRow(index, index + delta);
      });
      handle.addEventListener("pointerdown", (event: PointerEvent) => {
        if (!reordering()) return;
        dragFrom = rows.findIndex((r) => r.wrapper === wrapper);
        if (dragFrom < 0) return;
        wrapper.setAttribute("data-dsx-dragging", "true");
        container.setAttribute("data-dsx-reordering", "true");
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
      const endDrag = (event: PointerEvent): void => {
        if (dragFrom < 0) return;
        const target = rowIndexAt(event.clientY);
        wrapper.removeAttribute("data-dsx-dragging");
        container.removeAttribute("data-dsx-reordering");
        handle.releasePointerCapture?.(event.pointerId);
        const from = dragFrom;
        dragFrom = -1;
        if (target >= 0) moveRow(from, target);
      };
      handle.addEventListener("pointerup", endDrag);
      handle.addEventListener("pointercancel", (event: PointerEvent) => {
        dragFrom = -1;
        wrapper.removeAttribute("data-dsx-dragging");
        container.removeAttribute("data-dsx-reordering");
        handle.releasePointerCapture?.(event.pointerId);
      });
    }
    if (parts.leading === null && parts.trailing === null) return;
    // Tabbing/AT-navigating into a rail OPENS it, so the focused action is visible —
    // the web-honest twin of the native rotor actions (the buttons are real buttons).
    parts.host.addEventListener("focusin", (event: FocusEvent) => {
      if (!swiping()) return;
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      if (parts.leading?.contains(target) === true) openRow(wrapper, "leading");
      else if (parts.trailing?.contains(target) === true) openRow(wrapper, "trailing");
    });
    parts.host.addEventListener("focusout", (event: FocusEvent) => {
      const next = event.relatedTarget as HTMLElement | null;
      if (next === null || !parts.host.contains(next)) closeRow(wrapper);
    });
    let startX = 0;
    let startY = 0;
    let base = 0;
    let active = false;
    let tracking = false;
    parts.content.addEventListener("pointerdown", (event: PointerEvent) => {
      if (!swiping() || event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      base = parts.open === "leading" ? railWidth(parts.leading)
        : parts.open === "trailing" ? -railWidth(parts.trailing) : 0;
      tracking = true;
      active = false;
    });
    parts.content.addEventListener("pointermove", (event: PointerEvent) => {
      if (!tracking) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!active) {
        if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
        active = true;
        parts.content.setPointerCapture?.(event.pointerId);
        parts.host.setAttribute("data-dsx-swipe", "dragging");
      }
      event.preventDefault();
      const offset = base + dx;
      const maxLeading = fullLeading && leadingActions.length > 0
        ? parts.host.getBoundingClientRect().width : railWidth(parts.leading);
      const maxTrailing = fullTrailing && trailingActions.length > 0
        ? parts.host.getBoundingClientRect().width : railWidth(parts.trailing);
      setOffset(parts, Math.min(Math.max(offset, -maxTrailing), maxLeading));
    });
    const settle = (event: PointerEvent): void => {
      if (!tracking) return;
      tracking = false;
      if (!active) return;
      active = false;
      parts.content.releasePointerCapture?.(event.pointerId);
      const dx = base + (event.clientX - startX);
      const full = parts.host.getBoundingClientRect().width * 0.5;
      const commitFirst = (rail: HTMLElement | null): void => {
        closeRow(wrapper);
        (rail?.firstElementChild as HTMLElement | null | undefined)?.click();
      };
      // full-swipe commits the FIRST button of that edge — opt-in per edge
      if (dx >= full && fullLeading && leadingActions.length > 0) { commitFirst(parts.leading); return; }
      if (-dx >= full && fullTrailing && trailingActions.length > 0) { commitFirst(parts.trailing); return; }
      if (dx >= railWidth(parts.leading) * 0.5 && leadingActions.length > 0) openRow(wrapper, "leading");
      else if (-dx >= railWidth(parts.trailing) * 0.5 && trailingActions.length > 0) openRow(wrapper, "trailing");
      else closeRow(wrapper);
    };
    parts.content.addEventListener("pointerup", settle);
    parts.content.addEventListener("pointercancel", (event: PointerEvent) => {
      tracking = false;
      active = false;
      parts.content.releasePointerCapture?.(event.pointerId);
      closeRow(wrapper);
    });
  };

  /** Build a row's construct anatomy and return the element the row TEMPLATE mounts into
   *  (the sliding content when constructs are declared, the wrapper itself otherwise). */
  const buildRowHost = (wrapper: HTMLElement): HTMLElement => {
    if (!rowConstructs) return wrapper;
    wrapper.classList.add("dsx-row-constructs");
    const host = document.createElement("div");
    host.className = "dsx-list-row";
    host.setAttribute("data-dsx-part", "row-host");
    host.setAttribute("data-dsx-swipe", "closed");
    const content = document.createElement("div");
    content.className = "dsx-list-row-content";
    content.setAttribute("data-dsx-part", "row-content");
    let handle: HTMLButtonElement | null = null;
    if (declaresReorder) {
      handle = document.createElement("button");
      handle.type = "button";
      handle.className = "dsx-list-reorder";
      handle.setAttribute("data-dsx-part", "reorder");
      handle.setAttribute("aria-label", "Reorder");
      handle.setAttribute("title", "Reorder");
      content.appendChild(handle);
    }
    let leading: HTMLElement | null = null;
    let trailing: HTMLElement | null = null;
    if (node.attrs["swipeLeading"] !== undefined) {
      leading = document.createElement("div");
      leading.className = "dsx-list-actions dsx-list-actions-leading";
      leading.setAttribute("data-dsx-part", "actions-leading");
      host.appendChild(leading);
    }
    host.appendChild(content);
    if (node.attrs["swipeTrailing"] !== undefined) {
      trailing = document.createElement("div");
      trailing.className = "dsx-list-actions dsx-list-actions-trailing";
      trailing.setAttribute("data-dsx-part", "actions-trailing");
      host.appendChild(trailing);
    }
    wrapper.appendChild(host);
    wireRowConstructs(wrapper, { host, content, leading, trailing, handle, open: null });
    return content;
  };

  function refreshConstructs(): void {
    if (kind !== "list") return;
    const grouped = grouping();
    const reorder = reordering();
    const swipe = swiping();
    if (groupAttr !== undefined) container.setAttribute("data-dsx-grouped", String(grouped));
    if (declaresReorder) container.setAttribute("data-dsx-reorder", String(reorder));
    if (declaresSwipe) container.setAttribute("data-dsx-swipeable", String(swipe));
    for (const row of rows) {
      const parts = rowParts.get(row.wrapper);
      if (parts === undefined) continue;
      if (parts.handle !== null) parts.handle.hidden = !reorder;
      if (parts.leading !== null) parts.leading.hidden = !swipe;
      if (parts.trailing !== null) parts.trailing.hidden = !swipe;
      if (!swipe) closeRow(row.wrapper);
    }
    layoutRows();
  }

  if (groupAttr !== undefined) {
    api.bindText(groupAttr, (value) => { groupField = value.trim(); refreshConstructs(); });
  }
  if (declaresReorder) {
    api.bindText(node.attrs["reorder"], (value) => { reorderWord = booleanWord(value); refreshConstructs(); });
  }
  if (node.attrs["swipeLeading"] !== undefined) {
    api.bindValue(node.attrs["swipeLeading"], (value) => {
      leadingActions = normalizeListActions(value);
      for (const row of rows) renderRails(row.wrapper);
      refreshConstructs();
    });
  }
  if (node.attrs["swipeTrailing"] !== undefined) {
    api.bindValue(node.attrs["swipeTrailing"], (value) => {
      trailingActions = normalizeListActions(value);
      for (const row of rows) renderRails(row.wrapper);
      refreshConstructs();
    });
  }
  if (node.attrs["swipeFullLeading"] !== undefined) {
    api.bindText(node.attrs["swipeFullLeading"], (value) => { fullLeading = booleanWord(value); });
  }
  if (node.attrs["swipeFullTrailing"] !== undefined) {
    api.bindText(node.attrs["swipeFullTrailing"], (value) => { fullTrailing = booleanWord(value); });
  }
  if (node.attrs["autoscroll"] !== undefined) {
    const marquee = createMarquee(container, () => collectionAxis === "horizontal");
    syncMarquee = marquee.sync;
    api.bindText(node.attrs["autoscroll"], (value) => { marquee.setSpeed(value); });
    ctx.disposers.push(marquee.stop);
  }

  wireCommon(container, node, ctx, api);
  parent.appendChild(container);

  const warned = { size: -1 };
  let reachObserver: IntersectionObserver | null = null;
  let reachedToken = "";
  let reachCheck = (): void => {};
  container.addEventListener("scroll", () => reachCheck(), { passive: true });

  const observeTerminal = (sourceLength: number, truncated: boolean): void => {
    reachObserver?.disconnect();
    reachObserver = null;
    if (!api.hasHandler("reachEnd") || truncated || rows.length === 0 || typeof IntersectionObserver === "undefined") {
      if (rows.length === 0) reachedToken = "";
      return;
    }
    const terminal = rows.at(-1)!;
    const token = `${sourceLength}:${terminal.key}`;
    if (token === reachedToken) return;
    const fire = (): void => {
      if (reachedToken === token) return;
      reachedToken = token;
      reachObserver?.disconnect();
      reachObserver = null;
      reachCheck = () => {};
      api.handler("reachEnd");
    };
    reachCheck = () => {
      const atEnd = collectionAxis === "horizontal"
        ? container.scrollWidth > 0 && container.scrollLeft + container.clientWidth >= container.scrollWidth - 1
        : container.scrollHeight > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
      if (atEnd) fire();
    };
    reachObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.target === terminal.wrapper && entry.isIntersecting)) return;
      fire();
    }, { root: container, threshold: 0.01 });
    reachObserver.observe(terminal.wrapper);
  };

  const reconcile = (value: unknown): void => {
    const sourceLength = Array.isArray(value) ? value.length : 0;
    const data = boundedCollection(value, node.tag, warned);
    const next: Row[] = [];
    const existing = new Map<string, Row>();
    for (const r of rows) existing.set(r.key, r);
    const keyCounts = new Map<string, number>();

    data.forEach((raw, i) => {
      const item = collectionItem(ctx.item, raw, i);
      const key = keyedCollectionValue(raw, i, keyField, keyCounts);
      const prior = existing.get(key);
      if (prior !== undefined) {
        refreshRow(prior, item, raw, i);
        next.push(prior);
        existing.delete(key);
        return;
      }
      const wrapper = document.createElement("div");
      wrapper.className = "dsx-row dsx-collection-row";
      wrapper.setAttribute("data-dsx-part", "row");
      wrapper.setAttribute("role", kind === "grid" ? "gridcell" : "listitem");
      const rowCtx = subCtx(ctx, {
        item,
        rowBinding: arrayPath !== null ? { arrayPath, index: i } : null,
        itemRefresh: { listeners: new Set() },
      });
      const host = buildRowHost(wrapper);
      for (const child of node.children) mountNode(child, rowCtx, host);
      if (rowConstructs) renderRails(wrapper);
      next.push({ key, ctx: rowCtx, raw, index: i, wrapper });
    });

    for (const gone of existing.values()) {
      gone.ctx.disposers.forEach((d) => d());
      gone.wrapper.remove();
    }
    rows = next;
    if (rowConstructs || groupAttr !== undefined) refreshConstructs();
    else layoutRows();
    const truncated = sourceLength > BOUND_COLLECTION_LIMIT;
    container.setAttribute("data-dsx-total-count", String(sourceLength));
    container.setAttribute("data-dsx-rendered-count", String(rows.length));
    container.setAttribute("data-dsx-truncated", String(truncated));
    if (kind === "list") {
      rows.forEach((row, index) => {
        row.wrapper.setAttribute("aria-posinset", String(index + 1));
        row.wrapper.setAttribute("aria-setsize", String(sourceLength));
      });
    } else {
      container.setAttribute("aria-rowcount", String(Math.ceil(sourceLength / columns)));
    }
    observeTerminal(sourceLength, truncated);
  };

  ctx.disposers.push(
    collectionContextEffect(ctx, () => ctx.store.eval(bindExpr, ctx.item), reconcile),
    () => {
      reachObserver?.disconnect();
      rows.forEach((r) => r.ctx.disposers.forEach((d) => d()));
    },
  );
}

// ── module-provided components (/web/18: the web-facet loader) ───────────────────────

type PagerRow = Row & { dot: HTMLButtonElement };

function normalizeBoundIndex(value: unknown, count: number, fallback = 0): number {
  const raw = number(value);
  const finite = raw !== null && raw !== undefined && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  if (count <= 0) return 0;
  return Math.min(Math.max(finite, 0), count - 1);
}

/** Data-bound pager: `bind` is the page collection and `value` is the independent
 * two-way selected index, matching the Swift fixture. It deliberately shares the
 * static pager's DOM/ARIA/CSS anatomy instead of falling through to a list. */
function mountBoundPager(node: XmlNode, ctx: MountCtx, parent: ParentNode): void {
  const root = document.createElement("section");
  const viewport = document.createElement("div");
  const track = document.createElement("div");
  const dots = document.createElement("div");
  root.className = "dsx-paged dsx-pager";
  viewport.className = "dsx-paged-viewport";
  track.className = "dsx-paged-track";
  dots.className = "dsx-paged-dots";
  root.setAttribute("role", "region");
  root.setAttribute("aria-roledescription", "carousel");
  root.setAttribute("aria-label", node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? "Pager");
  viewport.tabIndex = 0;
  // One scroll-coordinate model in every engine. Page content is restored to RTL
  // by the weak :dir(rtl) rule; keyboard intent mirrors with the outer direction.
  viewport.setAttribute("dir", "ltr");
  viewport.setAttribute("aria-live", "off");
  dots.setAttribute("dir", "ltr");
  dots.setAttribute("role", "group");
  dots.setAttribute("aria-label", "Choose slide");
  viewport.appendChild(track);
  root.append(viewport, dots);

  const api = makeApi(node, ctx);
  wireCommon(root, node, ctx, api);
  parent.appendChild(root);

  const bindExpr = node.attrs["bind"]!;
  const keyField = node.attrs["key"] ?? "id";
  const arrayPath = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(bindExpr.trim()) ? JSE.normalizeScope(bindExpr.trim()) : null;
  const warned = { size: -1 };
  let rows: PagerRow[] = [];
  let axis: "horizontal" | "vertical" = "horizontal";
  let selected = 0;
  let requestedSelected: unknown = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const pageExtent = (): number => {
    const rect = viewport.getBoundingClientRect();
    return Math.max(1, axis === "vertical" ? viewport.clientHeight || rect.height : viewport.clientWidth || rect.width);
  };
  const align = (): void => {
    const offset = selected * pageExtent();
    if (axis === "vertical") viewport.scrollTop = offset;
    else viewport.scrollLeft = offset;
  };
  const reflect = (): void => {
    rows.forEach((row, index) => {
      const active = index === selected;
      row.wrapper.setAttribute("aria-label", `${index + 1} of ${rows.length}`);
      row.wrapper.inert = !active;
      if (active) row.wrapper.removeAttribute("aria-hidden");
      else row.wrapper.setAttribute("aria-hidden", "true");
      row.dot.setAttribute("aria-label", `Go to slide ${index + 1}`);
      row.dot.setAttribute("aria-current", active ? "true" : "false");
      row.dot.setAttribute("data-dsx-selected", String(active));
    });
    root.setAttribute("data-dsx-page", String(selected));
  };
  const select = (value: unknown, user: boolean, move = true): void => {
    if (rows.length === 0) { selected = 0; reflect(); return; }
    const next = normalizeBoundIndex(value, rows.length, selected);
    if (user) requestedSelected = next;
    if (next === selected) { reflect(); if (move) align(); return; }
    selected = next;
    reflect();
    if (move) align();
    if (user) {
      if (node.attrs["value"] !== undefined) api.writeBack(node.attrs["value"], next);
      api.handler("change", { value: next });
    }
  };
  const rightToLeft = (): boolean => typeof getComputedStyle === "function"
    && getComputedStyle(root).direction === "rtl";

  viewport.addEventListener("keydown", (event) => {
    const rtl = rightToLeft();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
      : axis === "horizontal" && event.key === "ArrowRight" ? selected + (rtl ? -1 : 1)
      : axis === "horizontal" && event.key === "ArrowLeft" ? selected + (rtl ? 1 : -1)
      : axis === "vertical" && event.key === "ArrowDown" ? selected + 1
      : axis === "vertical" && event.key === "ArrowUp" ? selected - 1
      : null;
    if (next === null || rows.length === 0) return;
    event.preventDefault();
    select(next, true);
  });
  viewport.addEventListener("scroll", () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const offset = axis === "vertical" ? viewport.scrollTop : viewport.scrollLeft;
      select(Math.round(offset / pageExtent()), true, false);
    }, 80);
  }, { passive: true });
  api.bindText(node.attrs["axis"] ?? "horizontal", (value) => {
    axis = value === "vertical" ? "vertical" : "horizontal";
    root.setAttribute("data-dsx-axis", axis);
    align();
  });
  api.bindText(node.attrs["dots"] ?? "true", (value) => {
    dots.hidden = value.trim().toLowerCase() === "false";
  });
  if (node.attrs["value"] !== undefined) {
    api.bindValue(node.attrs["value"], (value) => {
      requestedSelected = value;
      select(value, false);
    });
  }

  const reconcile = (value: unknown): void => {
    const sourceLength = Array.isArray(value) ? value.length : 0;
    const data = boundedCollection(value, node.tag, warned);
    const existing = new Map(rows.map((row) => [row.key, row]));
    const keyCounts = new Map<string, number>();
    const next: PagerRow[] = [];
    data.forEach((raw, index) => {
      const key = keyedCollectionValue(raw, index, keyField, keyCounts);
      const item = collectionItem(ctx.item, raw, index);
      const prior = existing.get(key);
      if (prior !== undefined) {
        existing.delete(key);
        refreshRow(prior, item, raw, index);
        next.push(prior);
        return;
      }
      const wrapper = document.createElement("div");
      wrapper.className = "dsx-paged-page";
      wrapper.setAttribute("role", "group");
      wrapper.setAttribute("aria-roledescription", "slide");
      const rowCtx = subCtx(ctx, {
        item,
        rowBinding: arrayPath !== null ? { arrayPath, index } : null,
        itemRefresh: { listeners: new Set() },
      });
      for (const child of node.children) mountNode(child, rowCtx, wrapper);
      const dot = document.createElement("button");
      dot.className = "dsx-paged-dot";
      dot.type = "button";
      const row: PagerRow = { key, ctx: rowCtx, raw, index, wrapper, dot };
      dot.addEventListener("click", () => select(row.index, true));
      next.push(row);
    });
    for (const gone of existing.values()) {
      gone.ctx.disposers.forEach((dispose) => dispose());
      gone.wrapper.remove();
      gone.dot.remove();
    }
    rows = next;
    preserveFocusedNode(() => {
      for (const row of rows) {
        track.appendChild(row.wrapper);
        dots.appendChild(row.dot);
      }
    });
    selected = normalizeBoundIndex(requestedSelected, rows.length, selected);
    root.setAttribute("data-dsx-total-count", String(sourceLength));
    root.setAttribute("data-dsx-rendered-count", String(rows.length));
    root.setAttribute("data-dsx-truncated", String(sourceLength > BOUND_COLLECTION_LIMIT));
    reflect();
    align();
  };

  ctx.disposers.push(
    collectionContextEffect(ctx, () => ctx.store.eval(bindExpr, ctx.item), reconcile),
    () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      rows.forEach((row) => row.ctx.disposers.forEach((dispose) => dispose()));
    },
  );
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(align);
    observer.observe(viewport);
    ctx.disposers.push(() => observer.disconnect());
  }
}

return { mountList, mountBoundPager };
})();

/** Mount a facet component: a host div carries the universal wrapper styles + measure=
 *  (door 1 of the /web/18 override table); the facet renders inside it — light DOM by
 *  default, an attached shadow root when the facet declares isolation. Consumer attrs
 *  split exactly like a .dsx component: props (typed when the attribute is exactly ONE
 *  `{{ }}` binding — rich data flows through; string-interpolated otherwise) versus
 *  on:* handlers, which the facet reaches only through ctx.emit — a facet never runs
 *  deck actions itself and never writes the store. */
function mountFacet(node: XmlNode, ctx: MountCtx, parent: ParentNode, qualified: string, facet: FacetComponent): void {
  const host = document.createElement("div");
  host.className = "dsx-facet";
  host.setAttribute("data-dsx-facet", qualified);
  const api = makeApi(node, ctx);
  wireStyles(host, node, ctx, api);
  wireMeasure(host, node, ctx);

  const attrs: Dict = {};
  const reactive: Array<[name: string, expr: string]> = [];
  const handlers = new Map<string, string>();
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name.startsWith("on:")) { handlers.set(name.substring(3), value); continue; }
    if (CONSUMED.has(name) || name.startsWith("__")) continue;
    if (value.includes("{{")) { reactive.push([name, value]); attrs[name] = null; }
    else attrs[name] = value;
  }

  const control = new AbortController();
  const facetCtx: FacetCtx = {
    attrs,
    emit(event, payload = {}) {
      const h = handlers.get(event);
      if (h === undefined) return;
      runHandler(node, ctx, event, h, payload);
    },
    signal: control.signal,
  };

  let target: HTMLElement = host;
  if (facet.isolation === "shadow") {
    const root = host.attachShadow({ mode: "open" });
    target = document.createElement("div");
    target.className = "dsx-facet-root";
    root.appendChild(target);
  }

  // reactive props BEFORE mount: effects apply immediately, so attrs carries live
  // initial values when mount() reads it; after mount each change pokes update().
  let instance: FacetInstance | null = null;
  for (const [name, value] of reactive) {
    const t = value.trim();
    const single = t.startsWith("{{") && t.endsWith("}}") && t.indexOf("{{", 2) === -1
      ? t.slice(2, -2)
      : null;
    ctx.disposers.push(contextEffect(ctx,
      single !== null ? () => ctx.store.eval(single, ctx.item) : () => ctx.store.interpolate(value, ctx.item),
      (v) => {
        attrs[name] = v;
        instance?.update?.([name]);
      },
    ));
  }
  instance = facet.mount(target, facetCtx) ?? null;
  ctx.disposers.push(() => {
    instance?.destroy?.();
    instance = null;
    control.abort();
  });
  parent.appendChild(host);
}

// ── components ───────────────────────────────────────────────────────────────────────

function mountComponent(node: XmlNode, ctx: MountCtx, parent: ParentNode, adoptEl?: Element): void {
  const ir = resolveComponent(ctx.registry, ctx.scheme, node.tag);
  if (ir === null) {
    // module-provided component (/web/18): the .dsx registry always wins — a facet
    // only fills a tag no composition claims (compose before you facet).
    const facet = ModuleRegistry.facetComponent(node.tag);
    const impl = facet !== null ? asFacetComponent(facet.impl) : null;
    if (facet !== null && impl !== null) {
      mountFacet(node, ctx, parent, `${facet.scheme}.${facet.name}`, impl);
      return;
    }
    if (
      (globalThis as typeof globalThis & { __DSX_OPTIONAL_GLOBALS__?: boolean })
        .__DSX_OPTIONAL_GLOBALS__ !== false
    ) {
      const globalFactory = GLOBAL_ELEMENTS[node.tag];
      if (globalFactory !== undefined) {
        mountElementFactory(node, ctx, parent, globalFactory);
        return;
      }
    }
    console.warn(`[dsx dom] unresolved component <${node.tag}> (scheme ${ctx.scheme})`);
    const missing = document.createElement("div");
    missing.className = "dsx-unsupported";
    missing.textContent = `<${node.tag}>?`;
    parent.appendChild(missing);
    return;
  }

  // split consumer attrs: props (static + reactive) vs on:* event handlers
  const attrs: Dict = {};
  const reactiveAttrs: Array<[string, string]> = [];
  const handlers = new Map<string, string>();
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name.startsWith("on:")) { handlers.set(name.substring(3), value); continue; }
    if (CONSUMED.has(name) || name.startsWith("__")) continue;
    // An interpolated attribute is seeded with its VALUE NOW, not with "". The effect
    // below still owns every later change; what the seed fixes is the first instant.
    // instantiate() runs the component's own first pass — including any `visible-if`
    // over `dsx.attribute.*` — before that effect has ever run, so a "" seed made the
    // component decide from a value it was never given. On a fresh mount the effect
    // corrected it a tick later and nobody saw it; on ADOPT the same tick is a
    // divergence: the server rendered the branch from the real value, the client's
    // first pass said no, and the server's element became an unmatched leftover that
    // replace-mounted the subtree. Found by the dashboard's own section labels.
    if (value.includes("{{")) {
      reactiveAttrs.push([name, value]);
      attrs[name] = ctx.store.interpolate(value, ctx.item);
    } else attrs[name] = value;
  }

  // folds away in embeds with the rest of the adopt machinery (define above)
  const adopting = (globalThis as typeof globalThis & { __DSX_OPTIONAL_ADOPT__?: boolean })
    .__DSX_OPTIONAL_ADOPT__ !== false && adoptEl !== undefined;
  const instance = instantiate(ir, ctx.registry, {
    attrs,
    ...(adopting && adoptEl !== undefined ? { adopt: adoptEl } : {}),
    emitEvent: (name, payload) => {
      const h = handlers.get(name);
      if (h === undefined) return;
      runHandler(node, ctx, name, h, payload);
    },
    component: ctx.env.component,
    formNamespace: ctx.formNamespace,
    ...(ctx.env.frameId !== undefined ? { frameId: ctx.env.frameId } : {}),
    slots: {
      defaults: node.children.filter((c) => (c.attrs["slot"] ?? "") === ""),
      named: node.children.reduce((m, c) => {
        const s = c.attrs["slot"];
        if (s !== undefined && s.length > 0) {
          const list = m.get(s) ?? [];
          list.push(c);
          m.set(s, list);
        }
        return m;
      }, new Map<string, XmlNode[]>()),
      ctx,
    },
  });

  // reactive props: parent-side effects update the live attrs dict + poke the child.
  // ONE store.set — it writes jse.vars itself; the old manual pre-write made the
  // deep-equal dedupe see prev == next and ELIDE the child notification (stale props).
  for (const [name, value] of reactiveAttrs) {
    ctx.disposers.push(contextEffect(ctx,
      () => ctx.store.interpolate(value, ctx.item),
      (v) => {
        attrs[name] = v;
        instance.ctx.store.set("dsx.attribute", { ...attrs });
      },
    ));
  }

  // Invocation presentation decorates the expanded root, while its ordinary attrs
  // remain component props above. The narrow root contract merges generated handles
  // additively, so neither side's style/class contract is replaced.
  wireRootStyleContract(instance.root, node, makeApi(node, ctx));
  adoptDisposers(ctx, instance.ctx);
  // An adopted child root is already positioned in the server DOM (or was swapped in
  // place by the walk's fallback) — appending would tear it out of claim order.
  if (!adopting) parent.appendChild(instance.root);
}

export type Instance = {
  root: HTMLElement;
  ctx: MountCtx;
  unmount: () => void;
};

export function instantiate(
  ir: ComponentIR,
  registry: Registry,
  opts: {
    attrs?: Dict;
    vars?: Dict;
    emitEvent?: (name: string, payload: Dict) => void;
    component?: RunEnv["component"];
    /** Opaque router frame identity propagated through every nested .dsx component. */
    frameId?: number;
    /** Renderer environment inherited from the caller. */
    formNamespace?: string | null;
    slots?: SlotContent | null;
    /** adopt-hydration (W6): a server-rendered root to bind IN PLACE instead of
     *  building fresh DOM. Honored only when adopt.ts registered the AdoptSeam;
     *  otherwise (and in every non-SSR bundle) the fresh-mount path runs unchanged. */
    adopt?: Element;
    /** SSR api-hydration seeds keyed by `as` (W6, doc 02/13), passed PER INSTANCE — the
     *  embed path's twin of the page boot's global ApiSeedSeam. A seeded block adopts the
     *  server-resolved envelope and skips its initial fetch. Takes precedence over the
     *  global seam; absent = the ordinary fetch-on-mount path. */
    apiSeeds?: { [as: string]: ApiSeed };
  } = {},
): Instance {
  const store = new ReactiveStore();
  const attrs = opts.attrs ?? {};
  const env = makeRunEnv(store, {
    item: attrs,
    emitEvent: opts.emitEvent ?? (() => {}),
    ...(opts.component !== undefined ? { component: opts.component } : {}),
    ...(opts.frameId !== undefined ? { frameId: opts.frameId } : {}),
    ...(cookieWriter !== null ? { cookieSet: cookieWriter } : {}),
  });
  const runner = new ActionRunner(env);
  const ctx: MountCtx = {
    registry,
    scheme: ir.scheme,
    owner: ir.name,
    store,
    runner,
    env,
    item: attrs,
    disposers: [],
    slots: opts.slots ?? null,
    rowBinding: null,
    formNamespace: opts.formNamespace ?? null,
  };

  // the head, in canonical order
  store.jse.vars.set("dsx.attribute", { ...attrs });
  for (const a of ir.head.attributes) {
    if (a.default !== undefined) store.jse.attrDefaults.set(a.as, a.default);
  }
  // `<functions global="true">` — the GLOBAL FUNCTION LIBRARY blocks (js-core.md
  // "Shared logic", corpus Conformance/functions): app-wide registration, last write
  // wins, BEFORE the surface scripts so lookup shadowing (surface table over global)
  // is a table fact, never a registration race. Then the per-surface blocks.
  // G4 unified input: the head `<input>` device bindings register BEFORE the body mounts,
  // so an `on:input.<name>` handler inside the body always finds its declaration, and
  // `dsx.input.<name>` reads its seeded resting value on the very first render pass.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_INPUT__?: boolean })
    .__DSX_OPTIONAL_INPUT__ !== false && ir.head.inputs.length > 0) {
    ctx.disposers.push(registerInputDeclarations(ctx, ir.head.inputs));
  }
  for (const s of ir.head.globalScripts) JSE.registerGlobalFunctions(s);
  for (const s of ir.head.scripts) JSE.registerFunctions(s, store.jse);
  for (const v of ir.head.variables) {
    if (v.computed) store.jse.computed.set(v.as, v.body);
    else store.jse.initials.set(v.as, JSE.evalBlock(v.body, store.jse, attrs));
  }
  for (const f of ir.head.formulas) {
    store.jse.formulas.set(f.as, { inputs: f.inputs, body: f.body });
  }
  for (const a of ir.head.actions) {
    env.actions.set(a.as, { body: a.body, inputs: a.inputs });
  }
  // pushed vars (`<expects variable="vars"/>` — the router seeds them)
  if (opts.vars) {
    for (const [k, v] of Object.entries(opts.vars)) store.jse.vars.set(k, v);
  }
  // declarative data (/web/05): api blocks seed their envelopes BEFORE the body
  // mounts, auto-fetch after it, and are callable from actions (orders.refresh())
  const apiBlocks: ApiBlock[] = [];
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_APIS__?: boolean })
    .__DSX_OPTIONAL_APIS__ !== false) {
    // doc 11: ONE graph per component scope. Every block mounts (and seeds its
    // envelope) before any fires, so the runnable set is computed against the whole
    // scope rather than against declaration order.
    const apiGraph = new ApiGraph(ir.head.apis.map((a) => a.attrs as unknown as ApiSpec));
    for (const a of ir.head.apis) {
      // SSR hydration (doc 02): if this boot carried a seed for this block, adopt the
      // server-resolved envelope and skip the initial fetch. A per-instance seed (the
      // embed path — opts.apiSeeds) wins over the page boot's global ApiSeedSeam.
      const seed = opts.apiSeeds?.[a.as] ?? (ApiSeedSeam.claim !== null ? ApiSeedSeam.claim(a.as) : null);
      const block = new ApiBlock(a.attrs as unknown as ApiSpec & { as: string; url: string }, store, attrs, {
        onEvent: (name, payload) => {
          // the tag's on:success / on:error / on:message handlers (the api workflows)
          const h = a.attrs[`on:${name}`];
          if (h !== undefined) void runner.run(h, attrs, payload);
        },
        ...(seed !== null ? { seed } : {}),
        graph: apiGraph,
      });
      apiBlocks.push(block);
      env.apis.set(a.as, block);
      // out-of-order streaming: a late chunk seeds this block in place (adopt.ts).
      StreamSeedSeam.offer?.(a.as, block);
    }
    apiGraph.start();
  }

  let root: HTMLElement;
  // adopt-hydration is a sliceable feature: a self-contained embed replace-mounts
  // by design (/web/13) and must not carry the seam — the build's
  // __DSX_OPTIONAL_ADOPT__ define folds this whole branch (and AdoptSeam) away.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_ADOPT__?: boolean })
    .__DSX_OPTIONAL_ADOPT__ !== false && opts.adopt !== undefined && AdoptSeam.impl !== null) {
    // adopt-hydration: bind the server-rendered tree in place (adopt.ts). The walk
    // returns the adopted root, or the fresh root it swapped in on a root mismatch.
    root = AdoptSeam.impl(ir, ctx, opts.adopt);
  } else {
    const frag = document.createDocumentFragment();
    mountNode(ir.root, ctx, frag);
    root = (frag.firstElementChild ?? document.createElement("div")) as HTMLElement;
  }
  root.setAttribute("data-dsx-owner", ir.name);

  // watches attach AFTER mount (never fire on subscribe — the reference semantics)
  for (const w of ir.head.watches) {
    ctx.disposers.push(store.watch(
      () => store.eval(w.value, ctx.item),
      (v) => { void runner.run(w.handler, ctx.item, { value: v }); },
    ));
  }

  const unmount = (): void => {
    ctx.disposers.forEach((d) => d());
    for (const block of apiBlocks) block.dispose();
    for (const t of env.timers.values()) (t.interval ? clearInterval : clearTimeout)(t.id);
    env.timers.clear();
    store.dispose();
    root.remove();
  };
  return { root, ctx, unmount };
}
