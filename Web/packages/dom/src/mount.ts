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
  RefRegistry, refKey, attributeBinding, DSXStrings, overrideAttrName,
} from "@despia/kernel";
import { legacyAttrToDecls, mapStyleValue, parseStyleAttr, BRIDGE_ATTRS, BRIDGE_CONTEXT_ATTRS } from "@despia/compiler/cssmap";
import { resolveComponent, type Registry } from "@despia/compiler/resolve";
import type { XmlNode } from "@despia/compiler/xml";
import { stampNodeIds, type ComponentIR, type IRNode } from "@despia/compiler/component";
import {
  ELEMENTS, GLOBAL_ELEMENTS, UNSUPPORTED, BUTTON_ROLES, booleanWord, createMarquee, iconSvg,
  type ElementApi, type ElementFactory,
} from "./elements.ts";
import { asFacetComponent, type FacetComponent, type FacetCtx, type FacetInstance } from "./facet.ts";
import { registerInputDeclarations, onInputEdge } from "./input.ts";
import { placeFloating } from "./overlay-controls.ts";
import { bindLength } from "./structural-controls.ts";

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
  /** Component-expansion depth from the surface root. See COMPONENT_DEPTH_CAP. */
  depth?: number;
};

/** How deep a component may expand before the renderer stops.
 *
 *  NOT a budget, and never to be tuned for taste. A component that names itself is a
 *  legitimate and common shape - a tree, an outliner, a comment thread, a file browser -
 *  and it terminates because the DATA terminates. This exists for the one case where the
 *  data does not: a cycle or a corrupt child list, where the only alternatives are an
 *  unbounded render and a dead stack. Bounded output beats a crash, and legitimate nesting
 *  must never reach it. Uniform on all three renderers (corpus
 *  Conformance/composition/attribute-binding.json `recursion`) so a tree that draws on one
 *  draws on all of them. */
export const COMPONENT_DEPTH_CAP = 256;

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

/** WebMCP tool registration (proposals/webmcp.md §3; webmcp.ts implements, boot.ts pulls
 *  it in). A SEAM for the same reason as AdoptSeam: mount.ts ships in every bundle
 *  including self-contained embeds, and a document that declares no `<tool>` row must not
 *  pay for the spec adapter — nor should an embed, which has no user agent to register
 *  with. The row type is structural on purpose so this declaration imports nothing. */
export const WebMcpSeam = {
  bind: null as ((
    rows: ReadonlyArray<{ as?: string; action: string; description: string; mutates?: string }>,
    options: {
      actionInputs: ReadonlyMap<string, readonly string[]>;
      dispatch: (action: string, args: Record<string, unknown>) => Promise<unknown>;
    },
  ) => () => void) | null,
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

// `flow` is here as of 2026-08-26 (runtime-pressure R29): the wrap layout was the one layout
// with no repeater, so a wrapping run of chips or tags could not be driven by data at all.
const BOUND_COLLECTION_TAGS = new Set(["list", "grid", "pager", "flow"]);
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

/** The Return-key spellings the toolkits use (DOM `Enter`/`NumpadEnter`, Compose `Enter`,
 *  AppKit `Return`). */
export const RETURN_KEYS = new Set(["enter", "return", "numpadenter"]);

export type MultilineReturn = "submit" | "newline" | "ignore";

/** What Return should do in a MULTILINE field (OpenSource/Conformance/input/multiline-submit.json)
 *  - the twin of Swift/Kotlin StackDesktopInput.multilineReturn.
 *
 *  Return already means "newline" in a multiline field and must keep meaning it on a soft
 *  keyboard, so this grammar decides HARDWARE key events only. `ignore` and `newline` are
 *  DIFFERENT answers: `ignore` means no opinion and the caller must not consume the event. */
export function multilineReturn(
  event: { key: string; shift: boolean; meta: boolean; ctrl: boolean; alt: boolean },
  submitOnEnter: boolean,
  hasSubmit: boolean,
): MultilineReturn {
  if (!RETURN_KEYS.has(event.key.toLowerCase())) return "ignore";
  // The explicit line-break chords win over everything, including an authored submitOnEnter:
  // turning Enter-to-send on must not take away the way out of it.
  if (event.shift || event.alt) return "newline";
  if (event.meta || event.ctrl) return hasSubmit ? "submit" : "ignore";
  if (submitOnEnter && hasSubmit) return "submit";
  return "newline";
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

/** Shared `tooltip=` / `tooltipSide=` resolution (OpenSource/Conformance/input/tooltip.json —
 *  the universal element hint, design-system.md Wave 3 (c)1). Whitespace-only text drops the
 *  tooltip; the side vocabulary is the floating-preference set, exact lowercase after trim,
 *  with `top` the default AND the fallback. A resolved tooltip always doubles as the element's
 *  accessibility description (aria-describedby here, the platform hint slots native), so its
 *  content is never gated behind hover (Article 7). */
export type TooltipSide = "top" | "bottom" | "leading" | "trailing";
export function resolveTooltip(
  tooltip: string | null | undefined,
  side: string | null | undefined,
): { text: string; side: TooltipSide } | null {
  const text = (tooltip ?? "").trim();
  if (text.length === 0) return null;
  const trimmed = (side ?? "").trim();
  const resolved: TooltipSide = trimmed === "top" || trimmed === "bottom" || trimmed === "leading" || trimmed === "trailing"
    ? trimmed
    : "top";
  return { text, side: resolved };
}

/** Shared `density=` resolution (OpenSource/Conformance/input/density.json — the universal
 *  subtree density knob, component-library.md W9). The vocabulary is exactly
 *  `comfortable | compact`, exact lowercase after trim; anything else is NO pin, so the
 *  element stays transparent to its ancestors' density. */
export type StackDensityValue = "comfortable" | "compact";
export function resolveDensity(raw: string | null | undefined): StackDensityValue | null {
  const trimmed = (raw ?? "").trim();
  return trimmed === "comfortable" || trimmed === "compact" ? trimmed : null;
}

/** The shared subtree law (density.json `effective[]`): `chain` is the authored raw
 *  density attributes from the root to the element; the NEAREST resolving pin wins — an
 *  invalid nearer value never masks an outer pin — and with no pin the platform default
 *  applies (compact on a desktop fine pointer, comfortable everywhere else). On web the
 *  CSS custom-property cascade IS this fold (the stamped data-dsx-density token tables in
 *  theme.ts inherit exactly this way); the native kernels run it directly. */
export function effectiveDensity(
  chain: readonly (string | null | undefined)[],
  finePointer: boolean,
): StackDensityValue {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const pinned = resolveDensity(chain[index]);
    if (pinned !== null) return pinned;
  }
  return finePointer ? "compact" : "comfortable";
}

/** Renderer-neutral show/dismiss state machine for the resolved tooltip, shared in
 *  OpenSource/Conformance/input/tooltip.json and executed by all three runtimes. Events are
 *  INTENT-qualified — the UI adapter owns its hover-intent delay and pointer identity, then
 *  reports each source with its own hover capability: a non-capable source (touch) is never
 *  even tracked. visible = (hovered || focused) && !dismissed; Escape dismisses and
 *  suppresses re-show until hover and focus have BOTH cleared. No authored events exist. */
export type TooltipAction = "show" | "hide";
export class TooltipLifecycle {
  private hovered = false;
  private focused = false;
  private dismissed = false;

  get visible(): boolean { return (this.hovered || this.focused) && !this.dismissed; }

  hoverStart(hoverCapable: boolean): TooltipAction[] {
    return this.transition(() => { if (hoverCapable) this.hovered = true; });
  }

  hoverEnd(): TooltipAction[] { return this.transition(() => { this.hovered = false; }); }

  focus(hoverCapable: boolean): TooltipAction[] {
    return this.transition(() => { if (hoverCapable) this.focused = true; });
  }

  blur(): TooltipAction[] { return this.transition(() => { this.focused = false; }); }

  escape(): TooltipAction[] { return this.transition(() => { if (this.visible) this.dismissed = true; }); }

  unmount(): TooltipAction[] { return this.transition(() => { this.hovered = false; this.focused = false; }); }

  private transition(mutate: () => void): TooltipAction[] {
    const before = this.visible;
    mutate();
    if (!this.hovered && !this.focused) this.dismissed = false;
    const after = this.visible;
    return before === after ? [] : [after ? "show" : "hide"];
  }
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

/** Read one consumer attribute the way its template asks to be read: a sole `{{ … }}`
 *  carries the VALUE (an object stays an object), a mixed template carries the sentence,
 *  a template with no hole is its own text. The fold is the kernel's, shared with the
 *  Kotlin and Swift twins - see `attributeBinding`. */
function readAttribute(ctx: MountCtx, template: string): unknown {
  const binding = attributeBinding(template);
  if (binding.kind === "value") return ctx.store.eval(binding.expr, ctx.item);
  if (binding.kind === "text") return ctx.store.interpolate(template, ctx.item);
  return template;
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
    bindDisplay(expr, apply) {
      if (expr === undefined) return;
      // The define is checked INSIDE the condition on purpose (the markdown fold's
      // pattern): an embed build pins __DSX_OPTIONAL_STRINGS__ false and esbuild folds
      // the whole localization tier away, keeping widgets under the G10 byte law -
      // there bindDisplay degrades to bindText semantics.
      if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STRINGS__?: boolean })
        .__DSX_OPTIONAL_STRINGS__ !== false) {
        // ALWAYS an effect: localize reads global.locale / global.strings through the
        // tracked door, so even a static "Save" re-resolves when the locale flips - the
        // in-app language switcher is one state write (localization.md).
        ctx.disposers.push(contextEffect(ctx,
          () => DSXStrings.localize(expr.includes("{{") ? ctx.store.interpolate(expr, ctx.item) : expr),
          (v) => apply(v),
        ));
        return;
      }
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
      const inheritedCtx = inherit.formNamespace === undefined && inherit.disposers === undefined
        ? childCtx
        : {
            ...childCtx,
            ...(inherit.formNamespace !== undefined ? { formNamespace: inherit.formNamespace } : {}),
            ...(inherit.disposers !== undefined ? { disposers: inherit.disposers } : {}),
          };
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
  if (node.tag === "node" || node.tag === "dynamic") {
    mountDynamicTag(node, ctx, parent);
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

  const facet = facetElement(node.tag);
  if (facet !== null) {
    mountFacet(node, ctx, parent, facet.qualified, facet.impl);
    return;
  }
  mountElementFactory(node, ctx, parent, UNSUPPORTED);
}

/** `<node tag="…">` / `<dynamic>` — the data-driven tag (StackReference "node"; the
 *  Stack.swift `case "node","dynamic"` / StackNodeView.kt twins). The `tag=`
 *  indirection resolves BEFORE factory lookup; an empty resolution (a bare `<node>`,
 *  or an expression that resolves to nothing) falls through to the children; an
 *  interpolated tag re-resolves live through the same anchor/remount contract
 *  `visible-if` established. */
function mountDynamicTag(node: XmlNode, ctx: MountCtx, parent: ParentNode): void {
  const expr = node.attrs["tag"] ?? "";
  const mountResolved = (tag: string, target: ParentNode, branch: MountCtx): void => {
    if (tag.length === 0) {
      for (const child of node.children) mountNode(child, branch, target);
      return;
    }
    const inner: XmlNode = { ...node, tag, attrs: { ...node.attrs } };
    delete inner.attrs["tag"];
    mountResolvedTag(inner, branch, target);
  };
  if (!expr.includes("{{")) {
    mountResolved(expr.trim(), parent, ctx);
    return;
  }
  const anchor = document.createComment("dsx:node");
  parent.appendChild(anchor);
  let mounted: { nodes: ChildNode[]; ctx: MountCtx } | null = null;
  const unmount = (): void => {
    if (mounted === null) return;
    mounted.ctx.disposers.forEach((d) => d());
    mounted.nodes.forEach((n) => n.remove());
    mounted = null;
  };
  ctx.disposers.push(contextEffect(ctx,
    () => ctx.store.interpolate(expr, ctx.item).trim(),
    (tag) => {
      unmount();
      const branch = subCtx(ctx);
      const frag = document.createDocumentFragment();
      mountResolved(tag, frag, branch);
      const nodes = [...frag.childNodes];
      anchor.after(...nodes);
      mounted = { nodes, ctx: branch };
    },
  ), unmount);
}

/** Dispatch a RESOLVED dynamic tag. The name reaches only what is compiled into THIS
 *  build — registered element factories, bound collections, and resolvable components
 *  — and an unknown name renders NOTHING: the capability boundary stays silent (a
 *  remote route can never name a view this build can't render — the grammar's rule),
 *  never the `<x>?` unsupported box a LITERAL unknown tag earns. */
function mountResolvedTag(node: XmlNode, ctx: MountCtx, parent: ParentNode): void {
  if (boundCollectionRuntime !== null && BOUND_COLLECTION_TAGS.has(node.tag) && node.attrs["bind"] !== undefined) {
    if (node.tag === "pager") boundCollectionRuntime.mountBoundPager(node, ctx, parent);
    else boundCollectionRuntime.mountList(node, ctx, parent);
    return;
  }
  const builtin = ELEMENTS[node.tag];
  if (builtin !== undefined) {
    mountElementFactory(node, ctx, parent, builtin);
    return;
  }
  if (!/^[A-Z]/.test(node.tag) && !node.tag.includes(".")) {
    const facet = facetElement(node.tag);
    if (facet !== null) mountFacet(node, ctx, parent, facet.qualified, facet.impl);
    return;
  }
  const globals = (globalThis as typeof globalThis & { __DSX_OPTIONAL_GLOBALS__?: boolean })
    .__DSX_OPTIONAL_GLOBALS__ !== false;
  if (resolveComponent(ctx.registry, ctx.scheme, node.tag) !== null
      || ModuleRegistry.facetComponent(node.tag) !== null
      || (globals && GLOBAL_ELEMENTS[node.tag] !== undefined)) {
    mountComponent(node, ctx, parent);
  }
}

/** The module-provided ELEMENT half of the /web/18 facet loader (design-system.md Wave 3
 *  (b)3): a lowercase tag no builtin claims resolves through the SAME `components` table
 *  Capitalized facet tags already ride — the web twin of a module-registered native
 *  global element (`<lottie>` = Core/Lottie's GlobalStackComponent). Consulted only
 *  AFTER the builtin table (a shipped tag of the same name always wins), and an
 *  absent/excluded module answers null so each caller keeps its honest degradation:
 *  the labelled unsupported box for a literal tag, nothing for a resolved dynamic one. */
function facetElement(tag: string): { qualified: string; impl: FacetComponent } | null {
  const facet = ModuleRegistry.facetComponent(tag);
  const impl = facet !== null ? asFacetComponent(facet.impl) : null;
  return facet !== null && impl !== null
    ? { qualified: `${facet.scheme}.${facet.name}`, impl }
    : null;
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
    // A live VIEW over the enclosing item, never a snapshot. In a component body,
    // ctx.item IS the instance's attrs object, and the consumer's reactive-prop effects
    // mutate that same object in place — a `{ ...item }` spread here froze every
    // attribute for the whole subtree the moment its root declared `container`, and the
    // dsx.attribute store fallback never fired because the stale copy answered first
    // (found by Flow's fit staying at the pre-fetch extent). The prototype chain keeps
    // attribute reads live and layers only the element scope on top.
    const childItem = Object.create(ctx.item ?? null) as Dict;
    Object.defineProperty(childItem, "__element", { value: scope, enumerable: true });
    const childCtx: MountCtx = { ...ctx, item: childItem };
    api = makeApi(node, ctx, childCtx);
  }
  const element = factory(node, ctx, api);
  // The element's IR identity, stamped on CLIENT mounts the same way SSR stamps it
  // (render.ts hydrate mode): `data-dsx-n` is the per-component preorder nid and
  // `data-dsx-owner` the owning component. The editor's select-on-the-real-render
  // (master plan P5) reads these to address a click as a source splice; same
  // reach-not-access reasoning as the state door, and ONE code path — no dev/prod
  // divergence to drift. Optional fold: embeds shed it (G10 widget law).
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_EDIT_TAGS__?: boolean })
    .__DSX_OPTIONAL_EDIT_TAGS__ !== false) {
    const irNid = (node as IRNode).nid;
    if (irNid !== undefined) {
      element.setAttribute("data-dsx-n", String(irNid));
      element.setAttribute("data-dsx-owner", ctx.owner);
    }
  }
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
  wireTooltip(el, node, ctx, api);
  wireMeasure(el, node, ctx);
  wireRef(el, node, ctx);
  wireDeclaredInput(node, ctx, api);
}

/** hover-intent delay before a tooltip shows (the platform hint feel; keyboard focus shows
 *  immediately). The reveal motion itself rides the motion tokens in the dsx-elements sheet. */
export const TOOLTIP_INTENT_DELAY_MS = 300;

/** per-document sequence for tooltip node ids (the aria-describedby identity) */
let tooltipSeq = 0;

/** tooltip= / tooltipSide= — the universal element hint (design-system.md Wave 3 (c)1; the
 *  shared law: input/tooltip.json). The bubble is a real `role="tooltip"` node the element
 *  references via aria-describedby the whole time it is mounted, so assistive tech reads the
 *  text with or without a pointer — the visual reveal is the only part gated on a REAL fine
 *  pointer (`(hover: hover)`), which is why a touch surface never fires it and loses nothing
 *  (Article 7). Placement reuses the floating-layer solver (placeFloating, data-dsx-placement).
 *  Part of the desktop input grammar slice: an embed that authors none of it strips this whole
 *  block via the build's __DSX_OPTIONAL_DESKTOP_INPUT__ define — full pages keep it (flag unset). */
function wireTooltip(el: HTMLElement, node: XmlNode, ctx: MountCtx, api: ElementApi): void {
  const attr = (globalThis as typeof globalThis & { __DSX_OPTIONAL_DESKTOP_INPUT__?: boolean })
    .__DSX_OPTIONAL_DESKTOP_INPUT__ !== false ? node.attrs["tooltip"] : undefined;
  if (attr === undefined) return;

  const bubble = document.createElement("div");
  bubble.className = "dsx-tooltip";
  bubble.id = `dsx-tooltip-${++tooltipSeq}`;
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;

  const lifecycle = new TooltipLifecycle();
  let current: { text: string; side: TooltipSide } | null = null;
  let rawText = "";
  let rawSide = "";

  const describe = (on: boolean): void => {
    const tokens = (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/).filter((token) => token.length > 0 && token !== bubble.id);
    if (on) tokens.push(bubble.id);
    if (tokens.length === 0) el.removeAttribute("aria-describedby");
    else el.setAttribute("aria-describedby", tokens.join(" "));
  };

  const position = (): void => {
    if (current === null || typeof el.getBoundingClientRect !== "function") return;
    const doc = document.documentElement as HTMLElement | null;
    const viewport = {
      width: (doc?.clientWidth ?? 0) || (globalThis as { innerWidth?: number }).innerWidth || 0,
      height: (doc?.clientHeight ?? 0) || (globalThis as { innerHeight?: number }).innerHeight || 0,
    };
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const rect = bubble.getBoundingClientRect();
    const rtl = typeof getComputedStyle === "function" && getComputedStyle(el).direction === "rtl";
    // placeFloating's preference names the ARROW side (the popover contract: the bubble
    // sits opposite it); tooltipSide names where the BUBBLE is — so pass the opposite.
    const preference = current.side === "top" ? "bottom"
      : current.side === "bottom" ? "top"
      : current.side === "leading" ? "trailing" : "leading";
    const placed = placeFloating(el.getBoundingClientRect(), { width: rect.width, height: rect.height },
      viewport, preference, rtl);
    bubble.style.setProperty("left", `${placed.x}px`);
    bubble.style.setProperty("top", `${placed.y}px`);
    bubble.setAttribute("data-dsx-placement", placed.placement);
  };
  const reposition = (): void => { if (!bubble.hidden) position(); };
  const win = typeof window === "undefined" ? null : window;
  const onEscape = (e: KeyboardEvent): void => { if (e.key === "Escape") dispatch(lifecycle.escape()); };
  const dispatch = (actions: TooltipAction[]): void => {
    for (const action of actions) {
      if (action === "show") {
        bubble.hidden = false;
        position();
        document.addEventListener("keydown", onEscape as EventListener, true);
        win?.addEventListener("resize", reposition);
        document.addEventListener("scroll", reposition, true);
      } else {
        bubble.hidden = true;
        document.removeEventListener("keydown", onEscape as EventListener, true);
        win?.removeEventListener("resize", reposition);
        document.removeEventListener("scroll", reposition, true);
      }
    }
  };

  // reactive resolution: text and side both interpolate; text going empty drops the
  // tooltip mid-flight (description off, an active show hidden through the machine)
  const sync = (): void => {
    current = resolveTooltip(rawText, rawSide);
    bubble.textContent = current === null ? "" : current.text;
    describe(current !== null);
    if (current === null) dispatch(lifecycle.unmount());
    else reposition();
  };
  api.bindText(attr, (v) => { rawText = v; sync(); });
  const sideAttr = node.attrs["tooltipSide"];
  if (sideAttr !== undefined) api.bindText(sideAttr, (v) => { rawSide = v; sync(); });
  (document.body as HTMLElement | null)?.appendChild(bubble);

  // the visual reveal, gated per source on a REAL fine pointer — never touch
  const canHover = (): boolean =>
    typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
  let intentTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelIntent = (): void => {
    if (intentTimer !== null) { clearTimeout(intentTimer); intentTimer = null; }
  };
  el.addEventListener("pointerenter", (e: PointerEvent) => {
    if (e.pointerType === "touch" || !canHover() || current === null) return;
    cancelIntent();
    intentTimer = setTimeout(() => {
      intentTimer = null;
      dispatch(lifecycle.hoverStart(true));
    }, TOOLTIP_INTENT_DELAY_MS);
  });
  const endHover = (): void => { cancelIntent(); dispatch(lifecycle.hoverEnd()); };
  el.addEventListener("pointerleave", endHover);
  el.addEventListener("pointercancel", endHover);
  el.addEventListener("pointerdown", cancelIntent); // a press is activation, not hover intent
  const focusVisible = (): boolean => {
    if (typeof el.matches !== "function") return true;
    try { return el.matches(":focus-visible"); } catch { return true; }
  };
  el.addEventListener("focus", () => {
    if (current !== null && focusVisible()) dispatch(lifecycle.focus(canHover()));
  });
  el.addEventListener("blur", () => dispatch(lifecycle.blur()));

  ctx.disposers.push(() => {
    cancelIntent();
    dispatch(lifecycle.unmount());
    bubble.remove();
  });
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

  // id= is the universal "stable id for imperative patches" (the editor catalog declares it
  // on every element) and the web twin never emitted it — so ui.node("#id"), tests and the
  // shot pipeline's frame measurement had nothing to address. Emitted BOUND like aria-label
  // below: an interpolated id resolves, never the raw {{ }} template text.
  const stableId = node.attrs["id"];
  if (stableId !== undefined) {
    api.bindText(stableId, (v) => {
      const t = v.trim();
      if (t === "") el.removeAttribute("id");
      else el.setAttribute("id", t);
    });
  }

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
  // `passthrough="true"` — decorative and non-interactive: the finger falls through to whatever
  // is behind. iOS `.allowsHitTesting(false)`, Compose a Box that does not consume, and here the
  // CSS twin. Without it a legibility scrim over a tappable video, or a fade bar over a scroller,
  // silently eats every touch in its own rectangle.
  if (node.attrs["passthrough"] === "true") el.style.setProperty("pointer-events", "none");
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
  // U03 shared elements + F07b lockOrientation: stamped as data attributes rather than read
  // off the node, because the router's reconcile runs over the LIVE DOM after a navigation and
  // never sees the node tree that produced it.
  for (const [attr, data] of [["shared", "data-dsx-shared"], ["sharedMode", "data-dsx-shared-mode"],
                              ["sharedAnim", "data-dsx-shared-anim"], ["sharedOrder", "data-dsx-shared-order"],
                              ["lockOrientation", "data-dsx-lock-orientation"]] as const) {
    const raw = node.attrs[attr];
    if (raw === undefined) continue;
    api.bindText(raw, (t) => {
      const v = t.trim();
      if (v === "") el.removeAttribute(data);
      else el.setAttribute(data, v);
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
  // density="comfortable|compact" — the subtree density knob (the theme= pin's twin;
  // shared law: input/density.json). Stamps data-dsx-density, whose token tables in
  // theme.ts re-derive the control metrics for this element and everything under it —
  // custom-property inheritance IS the nearest-ancestor fold, and the fine-pointer
  // platform default rides the same tokens' media query, so an authored pin always wins.
  const density = node.attrs["density"];
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_DENSITY__?: boolean })
    .__DSX_OPTIONAL_DENSITY__ !== false && density !== undefined) {
    api.bindText(density, (v) => {
      const resolved = resolveDensity(v);
      if (resolved === null) el.removeAttribute("data-dsx-density");
      else el.setAttribute("data-dsx-density", resolved);
    });
  }

  // reactive legacy attrs ({{ }} in grow/background/color/…) — runtime bridge
  //
  // A fold is reactive when its OWN value carries a template or when one of the attributes it
  // READS does (BRIDGE_CONTEXT_ATTRS: the gradient modifiers, the Dynamic Type opt-in). The
  // context is resolved into its own live map, because `node.attrs` holds the raw templates and
  // a fold handed "{{ dsx.variable.x }}" as a stop list parses nothing and silently degrades.
  // ONE shared resolved-context map and ONE subscription per dynamic context attribute, not
  // one per (bridge attr x context attr): the first shape registered N*M store watches and N
  // context copies for the same facts, and a single gradientStops tick refolded through M
  // duplicate callbacks. The context is shared because it is one truth; each attr keeps only
  // its own latest value and applied set.
  const dynamicContext = [...BRIDGE_CONTEXT_ATTRS]
    .filter((name) => (node.attrs[name] ?? "").includes("{{"));
  const context: Record<string, string | undefined> = { ...node.attrs };
  const refolds: Array<() => void> = [];
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!BRIDGE_ATTRS.has(name)) continue;
    if (!value.includes("{{") && dynamicContext.length === 0) continue;
    const applied = new Set<string>();
    let latest = value;
    const refold = (): void => {
      const decls = legacyAttrToDecls(name, latest.trim(), context);
      for (const prop of applied) el.style.removeProperty(prop);
      applied.clear();
      for (const [prop, val] of decls ?? []) {
        el.style.setProperty(prop, val);
        applied.add(prop);
      }
    };
    refolds.push(refold);
    if (value.includes("{{")) api.bindText(value, (v) => { latest = v; refold(); });
    else refold();
  }
  if (refolds.length > 0) {
    for (const key of dynamicContext) {
      api.bindText(node.attrs[key] ?? "", (resolved) => {
        context[key] = resolved;
        for (const refold of refolds) refold();
      });
    }
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
        // A transform changes no layout box, so nothing downstream can observe it - and a
        // canvas under a zoomable world sizes its backing store for where it LANDS. Say it
        // out loud once here rather than have every surface poll for it. Optional, and
        // reachable only from a document that draws: an embed with no <canvas> in a scaled
        // container folds the announcement out entirely (R21).
        if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_CANVAS_ZOOM__?: boolean })
          .__DSX_OPTIONAL_CANVAS_ZOOM__ !== false
          && prop === "transform" && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("dsx:transform", { detail: { el } }));
        }
      });
    }
  }

  // Whole-attribute style hole: `style="{{ expr }}"` yields a full declaration LIST
  // (the css-typed override consumption door). The native renderers interpolate the
  // whole style string before parsing; this is the web twin. Properties from the
  // previous evaluation are removed before the next lands, so a shrinking list cannot
  // strand stale declarations on the element. Rides the style-formula fold: the door
  // maps through cssmap's vocabulary, and `registryUsesStyleFormulas` counts the
  // compiled `__style_list` spelling, so a slice that authors the hole keeps both.
  // The define is read INSIDE the condition (the markdown-fold pattern) — that is what
  // lets esbuild delete the block and drop the parseStyleAttr/mapStyleValue refs.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_FORMULAS__?: boolean })
    .__DSX_OPTIONAL_STYLE_FORMULAS__ !== false) {
    const styleList = node.attrs["__style_list"];
    if (styleList !== undefined) {
      const applied = new Set<string>();
      // flex-direction toggles dsx-hstack; when a later list DROPS the declaration the
      // class restores to the element's own base state, not to whatever the last value
      // left behind — retraction covers the class contract, not just inline properties.
      const baseHstack = el.classList.contains("dsx-hstack");
      api.bindText(styleList, (v) => {
        const seen = new Set<string>();
        for (const [prop, value] of parseStyleAttr(v)) {
          const mapped = mapStyleValue(prop, value);
          if (mapped.length === 0) continue;
          el.style.setProperty(prop, mapped);
          seen.add(prop);
          if (prop === "flex-direction") el.classList.toggle("dsx-hstack", value.startsWith("row"));
        }
        for (const prop of applied) if (!seen.has(prop)) el.style.removeProperty(prop);
        if (applied.has("flex-direction") && !seen.has("flex-direction")) {
          el.classList.toggle("dsx-hstack", baseHstack);
        }
        applied.clear();
        for (const prop of seen) applied.add(prop);
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

/** ref="name" — publish this element into the shared-handle registry so a MODULE can reach it
 *  (capture.element, scroll.toElement, Spotlight). The law is Conformance/input/ref.json and the
 *  RefRegistry core; the kernel names no consumer. Teardown checks provider identity, because a
 *  recycled list row mounts the incoming element BEFORE unmounting the outgoing one. */
function wireRef(el: HTMLElement, node: XmlNode, ctx: MountCtx): void {
  const name = node.attrs["ref"];
  if (name === undefined || refKey(name) === null) return;
  domRefs().provide(name, el);
  ctx.disposers.push(() => domRefs().clear(name, el));
}

/** The one process-wide ref table, keyed off a well-known symbol so every bundle in a page
 *  shares it (an embedded surface and its host must resolve the same names). */
function domRefs(): RefRegistry<HTMLElement> {
  const slot = Symbol.for("dsx.refs.v1");
  const g = globalThis as unknown as { [k: symbol]: RefRegistry<HTMLElement> | undefined };
  return (g[slot] ??= new RefRegistry<HTMLElement>());
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

/** What a row's item view currently reads. Mutable ON PURPOSE - see `collectionItem`. */
type ItemSource = { parent: Dict; raw: unknown; index: number };

/** The item view for one row: an O(1) overlay over the bound element and the enclosing
 *  scope, and - the part that matters - ONE object for as long as the row lives.
 *
 *  A keyed row keeps its DOM identity while its data changes underneath it; that is what
 *  a key MEANS. The item view has to keep its identity for exactly the same reason. It
 *  used to be rebuilt on every reconciliation and re-pointed onto `row.ctx.item`, which
 *  works only for a reader holding that one context object. Every other reader holds a
 *  COPY: `{...ctx}` is how an element scope, a slot mount and a component's props all
 *  descend, and a copy froze `item` at the value it had when the row mounted. So a
 *  binding written straight into the row updated and the identical binding one component
 *  deep did not - the row rendered live and stale data side by side, silently, forever.
 *  It was found by putting the same expression in both places and reading the screen.
 *
 *  Re-pointing every copy is not reachable (a spread is a value copy by definition), so
 *  the identity stops moving instead: the view is stable and its SOURCE is a cell the
 *  reconciler updates. Every holder, however it was copied, reads through to live data. */
function collectionItem(parentItem: Dict | null, raw: unknown, index: number): Dict {
  const source: ItemSource = { parent: parentItem ?? {}, raw, index };
  const row = (): Dict | null => (isDict(source.raw) ? source.raw as Dict : null);
  const own = (key: PropertyKey): boolean => {
    if (typeof key !== "string") return false;
    const r = row();
    return key === "index" || (r !== null && Object.prototype.hasOwnProperty.call(r, key))
      || (r === null && key === "value") || Object.prototype.hasOwnProperty.call(source.parent, key);
  };
  const view = new Proxy({} as Dict, {
    get: (_target, key) => {
      if (key === "index") return source.index;
      const r = row();
      if (r !== null && Object.prototype.hasOwnProperty.call(r, key)) return r[key as string];
      if (r === null && key === "value") return source.raw;
      return source.parent[key as string];
    },
    has: (_target, key) => own(key),
    ownKeys: () => {
      const r = row();
      return [...new Set([
        ...Object.keys(source.parent), ...(r === null ? ["value"] : Object.keys(r)), "index",
      ])];
    },
    getOwnPropertyDescriptor: (_target, key) => own(key)
      ? { configurable: true, enumerable: true, writable: false, value: undefined }
      : undefined,
  });
  itemSources.set(view, source);
  return view;
}

/** The cell behind each live item view. Weak, so a dropped row's cell goes with it. */
const itemSources = new WeakMap<Dict, ItemSource>();

function refreshRow(row: Row, raw: unknown, index: number): void {
  const changed = row.raw !== raw || row.index !== index;
  const source = itemSources.get(row.ctx.item as Dict);
  if (source !== undefined) { source.raw = raw; source.index = index; }
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
  const kind = node.tag === "grid" ? "grid" : node.tag === "flow" ? "flow" : "list";
  // A bound `<flow>` is the STATIC flow's box - the same `.dsx-flow` flex-wrap and the same two
  // spacing custom properties - with rows in it. It takes none of the list chrome (no grouping,
  // no swipe, no reorder, no appearance), which falls out of the `kind === "list"` guards below
  // rather than needing its own branch. `.dsx-row` is `display: contents`, so each row's content
  // becomes a direct flex item and wraps like any authored child would.
  const cls = kind === "grid" ? "dsx-list dsx-grid" : kind === "flow" ? "dsx-flow" : "dsx-list";
  const container = document.createElement("div");
  container.className = cls;
  container.setAttribute("role", kind === "flow" ? "list" : kind);
  container.setAttribute("data-dsx-component", kind);
  if (kind === "list") container.setAttribute("data-dsx-appearance", "automatic");
  const api = makeApi(node, ctx);
  if (kind === "flow") {
    bindLength(node, api, "spacing", 8, container, "--dsx-flow-spacing");
    bindLength(node, api, "lineSpacing", 8, container, "--dsx-flow-line-spacing");
  }
  let columns = 3;
  let collectionAxis: "horizontal" | "vertical" = "vertical";
  let rows: Row[] = [];

  const bindExpr = node.attrs["bind"]!;
  const keyField = node.attrs["key"] ?? "id";
  // A bound collection SAYS SO in the DOM. Inert for layout and free at runtime, and it makes
  // the collection self-describing to every tool that has to reason about it from outside -
  // the editor's tree, a test, and the shot guard that refuses a "No data found" screenshot
  // (platform/10 §4). A collection that does not declare its binding is opaque to all three,
  // and the alternative was each of them re-deriving it from the IR by position.
  container.setAttribute("data-dsx-bind", bindExpr.trim());
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
      if (kind === "list" || kind === "flow") {
        // a grouped→flat flip leaves emptied sections behind; drop them, then re-append
        if (container.firstElementChild?.classList.contains("dsx-list-section") === true) {
          container.replaceChildren();
        }
        // A flow appends its rows FLAT and takes no aria grid rows: the grid's row/col grouping
        // below is a real block element per row, which would put every chip on one line and
        // make a wrap that does not wrap.
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
  // unset align = STRETCH (the base rule) — stamp nothing (wave-7 F3), authored keeps meaning
  if (node.attrs["align"] !== undefined) {
    api.bindText(node.attrs["align"], (value) => {
      container.setAttribute("data-dsx-align", value === "center" || value === "trailing" ? value : "leading");
    });
  }

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
      const key = keyedCollectionValue(raw, i, keyField, keyCounts);
      const prior = existing.get(key);
      if (prior !== undefined) {
        // A surviving row keeps its item view; only what the view reads is updated.
        refreshRow(prior, raw, i);
        next.push(prior);
        existing.delete(key);
        return;
      }
      const item = collectionItem(ctx.item, raw, i);
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
  // Same self-description as the bound list/grid: the collection declares its binding.
  root.setAttribute("data-dsx-bind", (node.attrs["bind"] ?? "").trim());

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
      const prior = existing.get(key);
      if (prior !== undefined) {
        existing.delete(key);
        refreshRow(prior, raw, index);
        next.push(prior);
        return;
      }
      const item = collectionItem(ctx.item, raw, index);
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
  wireRef(host, node, ctx);

  const attrs: Dict = {};
  const overrides: Dict = {};
  const reactive: Array<[name: string, expr: string, plane: Dict]> = [];
  const handlers = new Map<string, string>();
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name.startsWith("on:")) { handlers.set(name.substring(3), value); continue; }
    if (CONSUMED.has(name) || name.startsWith("__")) continue;
    const override = (globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_OVERRIDES__?: boolean })
      .__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false ? overrideAttrName(name) : null;
    const plane = override !== null ? overrides : attrs;
    const key = override ?? name;
    if (value.includes("{{")) { reactive.push([key, value, plane]); plane[key] = null; }
    else plane[key] = value;
  }

  const control = new AbortController();
  const facetCtx: FacetCtx = {
    attrs,
    overrides,
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

  // reactive props BEFORE mount: effects apply immediately, so attrs (and overrides)
  // carry live initial values when mount() reads them; after mount each change pokes
  // update() — override changes report as `override:<name>` so a facet can tell the
  // planes apart.
  let instance: FacetInstance | null = null;
  for (const [name, value, plane] of reactive) {
    ctx.disposers.push(contextEffect(ctx,
      () => readAttribute(ctx, value),
      (v) => {
        plane[name] = v;
        instance?.update?.([(globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_OVERRIDES__?: boolean })
          .__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false && plane === overrides ? `override:${name}` : name]);
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
    // SLOT CHILDREN ARE THE AUTHOR'S EXCLUSION FALLBACK, and they are the whole reason an
    // excludable module element is safe to write. iOS (Stack.swift) and Android
    // (StackNodeView.kt) both render the children of a tag nothing resolves; this renderer
    // dropped them, which made the guarantee two-of-three and silently discarded markup an
    // author wrote precisely for the excluded build. Rendering them here is what makes
    // `<rive src="…"><image src="poster.png"/></rive>` mean the same thing on all three.
    //
    // The marker still appears when there is NOTHING to fall back to, because a blank space
    // where a component should be is the failure that is hardest to diagnose; an author who
    // supplied a fallback has already said what should be there instead.
    if (node.children.length > 0) {
      for (const child of node.children) mountNode(child, ctx, parent);
      return;
    }
    const missing = document.createElement("div");
    missing.className = "dsx-unsupported";
    missing.textContent = `<${node.tag}>?`;
    parent.appendChild(missing);
    return;
  }

  // THE RECURSION FLOOR. A component that names itself expands until the data runs out,
  // which is the whole point of typed props - a tree hands its own children down. When the
  // data is cyclic or corrupt it never runs out, and this renderer had no floor at all: the
  // page hung and took the tab with it. Stopping here renders the subtree short instead,
  // which is a visible, diagnosable wrong answer rather than a dead surface. The marker
  // says which tag stopped, because a silently truncated tree looks like missing data.
  if ((ctx.depth ?? 0) >= COMPONENT_DEPTH_CAP) {
    console.warn(`[dsx dom] <${node.tag}> stopped at the component depth cap (${COMPONENT_DEPTH_CAP}) — cyclic data?`);
    const capped = document.createElement("div");
    capped.className = "dsx-depth-capped";
    capped.setAttribute("data-dsx-depth-capped", node.tag);
    parent.appendChild(capped);
    return;
  }

  // split consumer attrs: props (static + reactive) vs override:<name> style knobs vs
  // on:* event handlers (the split law — corpus OpenSource/Conformance/overrides)
  const attrs: Dict = {};
  const reactiveAttrs: Array<[string, string]> = [];
  const overrides: Dict = {};
  const reactiveOverrides: Array<[string, string]> = [];
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
    const override = (globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_OVERRIDES__?: boolean })
      .__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false ? overrideAttrName(name) : null;
    if (override !== null) {
      if (value.includes("{{")) reactiveOverrides.push([override, value]);
      overrides[override] = value.includes("{{") ? readAttribute(ctx, value) : value;
      continue;
    }
    if (value.includes("{{")) {
      reactiveAttrs.push([name, value]);
      attrs[name] = readAttribute(ctx, value);
    } else attrs[name] = value;
  }
  // The tag door rides the item scope (the `__overrides` dict inside attrs — the same
  // vehicle `__element` rides), so a component's first pass reads live values with no
  // effect having run, exactly like attributes. Present even when empty only if a
  // reactive override may later write it.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_OVERRIDES__?: boolean })
    .__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false
    && (Object.keys(overrides).length > 0 || reactiveOverrides.length > 0)) attrs["__overrides"] = overrides;

  // folds away in embeds with the rest of the adopt machinery (define above)
  const adopting = (globalThis as typeof globalThis & { __DSX_OPTIONAL_ADOPT__?: boolean })
    .__DSX_OPTIONAL_ADOPT__ !== false && adoptEl !== undefined;
  const inheritedEnv = scopedEnvOf(ctx.env);
  const instance = instantiate(ir, ctx.registry, {
    attrs,
    ...(inheritedEnv !== null ? { env: inheritedEnv } : {}),
    ...(adopting && adoptEl !== undefined ? { adopt: adoptEl } : {}),
    emitEvent: (name, payload) => {
      const h = handlers.get(name);
      if (h === undefined) return;
      runHandler(node, ctx, name, h, payload);
    },
    component: ctx.env.component,
    formNamespace: ctx.formNamespace,
    depth: (ctx.depth ?? 0) + 1,
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
      () => readAttribute(ctx, value),
      (v) => {
        attrs[name] = v;
        instance.ctx.store.set("dsx.attribute", { ...attrs });
      },
    ));
  }
  // reactive overrides: same discipline on the style plane — mutate the live dict the
  // item scope reads, then poke the child's "dsx.override" pseudo-key so every effect
  // that read any knob re-runs (jse.ts lookup tracks that key).
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_OVERRIDES__?: boolean })
    .__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false) {
    for (const [name, value] of reactiveOverrides) {
      ctx.disposers.push(contextEffect(ctx,
        () => readAttribute(ctx, value),
        (v) => {
          overrides[name] = v;
          instance.ctx.store.set("dsx.override", { ...overrides });
        },
      ));
    }
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

/** the seams a scoping host may thread through a mount (all landed kernel seams — B6) */
export type ScopedEnv = Pick<RunEnv, "callModule" | "egress" | "ownerScheme" | "loopCap" | "deadlineAt" | "callBudget" | "loopWork">;

/** the inheritable slice of a mount's env — SAME objects on purpose (shared budgets) */
function scopedEnvOf(env: RunEnv): ScopedEnv | null {
  if (env.callModule === undefined && env.egress === undefined) return null;
  return {
    ...(env.callModule !== undefined ? { callModule: env.callModule } : {}),
    ...(env.egress !== undefined ? { egress: env.egress } : {}),
    ...(env.ownerScheme !== undefined ? { ownerScheme: env.ownerScheme } : {}),
    ...(env.loopCap !== undefined ? { loopCap: env.loopCap } : {}),
    ...(env.deadlineAt !== undefined ? { deadlineAt: env.deadlineAt } : {}),
    ...(env.callBudget !== undefined ? { callBudget: env.callBudget } : {}),
    loopWork: env.loopWork,
  };
}

export function instantiate(
  ir: ComponentIR,
  registry: Registry,
  opts: {
    attrs?: Dict;
    /** style-override raw values for the VERB doors (`dsx.component.push/present`,
     *  native mounts) — the tag door rides `attrs.__overrides` instead. Seeded into the
     *  instance store's `dsx.override` var before the body mounts. */
    overrides?: Dict;
    vars?: Dict;
    emitEvent?: (name: string, payload: Dict) => void;
    component?: RunEnv["component"];
    /** Component-expansion depth of the INVOCATION, so the floor survives nesting. */
    depth?: number;
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
    /** THE SCOPED ENVIRONMENT (studio-apps.md §8): a host mounting a subtree it did not
     *  write threads the kernel's landed seams — the module funnel (`callModule`), the
     *  egress gate, owner attribution and the execution budgets. INHERITED by every
     *  nested component expansion as the SAME objects (a shared call budget and loop
     *  counter are what make the ceiling subtree-wide — without the inheritance hop a
     *  child component would silently reach the process-global registry, which would
     *  void the whole containment story). Unset = the global registry and platform
     *  networking, byte-identical to before. */
    env?: ScopedEnv;
  } = {},
): Instance {
  // Fresh client mounts carry the same IR identity SSR emits (idempotent; adopt and
  // renderPage already stamp): every element gets data-dsx-n/-owner below, which is
  // what lets the editor address a click on the REAL render as a source splice (P5).
  // An OPTIONAL FOLD (the R11 discipline): embeds shed it under the G10 widget law —
  // a sliced widget is never edited in place, so it never pays for editability.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_EDIT_TAGS__?: boolean })
    .__DSX_OPTIONAL_EDIT_TAGS__ !== false) {
    stampNodeIds(ir.root as IRNode);
  }
  const store = new ReactiveStore();
  const attrs = opts.attrs ?? {};
  const env = makeRunEnv(store, {
    item: attrs,
    emitEvent: opts.emitEvent ?? (() => {}),
    ...(opts.component !== undefined ? { component: opts.component } : {}),
    ...(opts.frameId !== undefined ? { frameId: opts.frameId } : {}),
    ...(cookieWriter !== null ? { cookieSet: cookieWriter } : {}),
    // the scoped seams, when a host threaded them (studio-apps.md §8) — spread LAST so a
    // scoping host's funnel/gate/budgets are what this subtree actually runs under
    ...(opts.env ?? {}),
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
    depth: opts.depth ?? 0,
  };

  // the head, in canonical order
  store.jse.vars.set("dsx.attribute", { ...attrs });
  for (const a of ir.head.attributes) {
    if (a.default !== undefined) store.jse.attrDefaults.set(a.as, a.default);
  }
  // the style contract: declared knobs register before anything reads, the verb door's
  // raw values seed the store var (the tag door already rides attrs.__overrides).
  // Folds with the rest of the plane in a knob-free embed (define read in-condition).
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_OVERRIDES__?: boolean })
    .__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false) {
    for (const o of ir.head.overrides ?? []) store.jse.overrideDecls.set(o.as, o);
    if (opts.overrides !== undefined) store.jse.vars.set("dsx.override", { ...opts.overrides });
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
  // WebMCP (proposals/webmcp.md §3): the document's `<tool>` rows register with the user
  // agent for exactly as long as this document is mounted, so the tool set an agent sees
  // is always the set the current screen can honour. A slice that declares no row folds
  // this away entirely (__DSX_OPTIONAL_WEBMCP__), so an embed pays nothing for a surface
  // it never uses — the /web/13 byte budget, same discipline as `<api>`. A call arrives
  // as an ENTRY call — the
  // agent is a host with a payload and no caller scope, the same shape an HTTP route, a
  // CLI command and a queue message already use (Conformance/actions entry-* cases).
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_WEBMCP__?: boolean })
    .__DSX_OPTIONAL_WEBMCP__ !== false && ir.head.tools.length > 0 && WebMcpSeam.bind !== null) {
    const actionInputs = new Map<string, readonly string[]>();
    for (const a of ir.head.actions) actionInputs.set(a.as, Object.keys(a.inputs));
    ctx.disposers.push(WebMcpSeam.bind(ir.head.tools, {
      actionInputs,
      dispatch: async (action, args) => {
        const value = await runner.callAction(action, {}, null, args as Dict, { entry: true });
        // A deliberate throw is the ANSWER, not an unobserved fault: taking it off the
        // runner here is what lets the adapter shape it into an isError result instead of
        // the ledger filing it as an uncaught surface error.
        const thrown = runner.takeThrow();
        if (thrown !== null) throw thrown.value;
        return value;
      },
    }));
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
        // a scoped mount's egress gate reaches `<api>` too — the funnel law, block tier
        ...(env.egress !== undefined ? { egress: env.egress } : {}),
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

  // watches attach AFTER mount and never fire on subscribe — the reference semantics — EXCEPT
  // under `immediate`, which is the element's documented "also fire once on mount" and is how a
  // component seeds a writable local from a read-only prop.
  for (const w of ir.head.watches) {
    ctx.disposers.push(store.watch(
      () => store.eval(w.value, ctx.item),
      (v) => { void runner.run(w.handler, ctx.item, { value: v }); },
    ));
    if (w.immediate === true) {
      void runner.run(w.handler, ctx.item, { value: store.eval(w.value, ctx.item) });
    }
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
