//
//  overlay-controls.ts - declarative presentation primitives for DSX Web.
//
//  The browser implementation deliberately uses neutral DSX chrome instead of
//  imitating UIKit or Material. Behaviour is the portable contract: real dialog /
//  menu semantics, focus ownership, bounded remote data, collision-aware floating
//  placement, and two-way `present` dismissal. Presentation CSS stays in the weak
//  dsx-elements layer so an application sheet or unlayered author CSS wins normally.
//

import { ModuleRegistry, isDict, number, string, truthy, type Dict } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import { ELEMENTS, iconSvg, type ElementApi, type ElementFactory } from "./elements.ts";
import type { MountCtx } from "./mount.ts";

export const OVERLAY_CONTROL_TAGS: ReadonlySet<string> = new Set([
  "sheet", "alert", "confirmDialog", "popover", "menu", "contextmenu",
]);

/** Allocation and recursion boundaries for remotely supplied overlay data. */
export const OVERLAY_LIMITS = Object.freeze({
  maxItems: 256,
  maxDepth: 8,
  maxOpenDepth: 16,
  maxTextCharacters: 512,
  maxActionCharacters: 256,
  maxArgumentEntries: 64,
  maxArgumentDepth: 4,
  maxChildren: 1_000,
});

export type OverlayRole = "normal" | "cancel" | "destructive";
export type OverlayItem = Readonly<{
  title: string;
  icon: string;
  role: OverlayRole;
  action: string;
  args: Dict;
  disabled: boolean;
  separator: boolean;
  items: readonly OverlayItem[];
}>;

export type SheetDetent = "content" | "half" | "full";
export type FloatingPreference = "top" | "bottom" | "leading" | "trailing";
export type FloatingPlacement = Readonly<{
  x: number;
  y: number;
  placement: "top" | "bottom" | "left" | "right";
}>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = cls;
  return element;
}

function boundedText(value: unknown): string {
  // Slice before code-point iteration so hostile multi-megabyte values have a fixed
  // temporary allocation ceiling. Four UTF-16 units per retained character allows
  // normal surrogate/combining sequences while keeping work bounded.
  return Array.from(string(value).substring(0, OVERLAY_LIMITS.maxTextCharacters * 4))
    .slice(0, OVERLAY_LIMITS.maxTextCharacters).join("");
}

function boundedAction(value: unknown): string {
  const candidate = string(value).substring(0, OVERLAY_LIMITS.maxActionCharacters).trim();
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(candidate) ? candidate : "";
}

function boundedArgument(value: unknown, depth = 0): unknown {
  if (depth >= OVERLAY_LIMITS.maxArgumentDepth) return null;
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, OVERLAY_LIMITS.maxArgumentEntries)
      .map((entry) => boundedArgument(entry, depth + 1));
  }
  if (isDict(value)) {
    const out: Dict = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value as Dict)) {
      if (count >= OVERLAY_LIMITS.maxArgumentEntries) break;
      const safeKey = boundedText(key);
      if (safeKey.length === 0 || safeKey === "__proto__" || safeKey === "constructor" || safeKey === "prototype") continue;
      out[safeKey] = boundedArgument(entry, depth + 1);
      count += 1;
    }
    return out;
  }
  return null;
}

/** Normalize the shared alert/menu item tree without trusting its size, shape or
 * acyclicity. A single total item ledger spans every submenu. */
export function normalizeOverlayItems(input: unknown): OverlayItem[] {
  const source = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",").map((title) => ({ title: title.trim() })).filter((item) => item.title.length > 0)
      : [];
  const seen = new WeakSet<object>();
  const seenEntries = new WeakSet<object>();
  let remaining = OVERLAY_LIMITS.maxItems;

  const level = (raw: unknown, depth: number): OverlayItem[] => {
    if (!Array.isArray(raw) || depth >= OVERLAY_LIMITS.maxDepth || remaining <= 0) return [];
    if (seen.has(raw)) return [];
    seen.add(raw);
    const out: OverlayItem[] = [];
    for (const entry of raw) {
      if (remaining <= 0) break;
      if (entry !== null && typeof entry === "object") {
        if (seenEntries.has(entry as object)) continue;
        seenEntries.add(entry as object);
      }
      remaining -= 1;
      const row: Dict = isDict(entry) ? entry as Dict : { title: entry };
      const roleRaw = string(row["role"]);
      const role: OverlayRole = roleRaw === "cancel" || roleRaw === "destructive" ? roleRaw : "normal";
      out.push(Object.freeze({
        title: boundedText(row["label"] ?? row["title"] ?? ""),
        icon: boundedText(row["icon"] ?? ""),
        role,
        action: boundedAction(row["action"]),
        args: (boundedArgument(row["args"] ?? {}, 0) as Dict | null) ?? {},
        disabled: truthy(row["disabled"] ?? false),
        separator: truthy(row["separator"] ?? false),
        items: level(row["items"], depth + 1),
      }));
    }
    return out;
  };
  return level(source, 0);
}

export function normalizeSheetDetents(input: unknown): SheetDetent[] {
  const out: SheetDetent[] = [];
  for (const raw of string(input || "half,full").split(",")) {
    const token = raw.trim();
    if ((token === "content" || token === "half" || token === "full") && !out.includes(token)) out.push(token);
  }
  return out.length > 0 ? out : ["half", "full"];
}

/** Resolve the documented cross-platform StackStyle color vocabulary without
 * allowing an authored value to smuggle extra CSS declarations into SSR. Eight
 * digit literals follow DSX's native #AARRGGBB contract (not CSS #RRGGBBAA). */
export function normalizeSheetBackground(input: unknown): string | null {
  const raw = boundedText(input).trim();
  if (raw === "system") return null;
  const tokens: Readonly<Record<string, string>> = {
    white: "#ffffff",
    black: "#000000",
    clear: "transparent",
    accent: "var(--dsx-accent)",
    label: "var(--dsx-label)",
    text: "var(--dsx-label)",
    secondary: "var(--dsx-secondary-label)",
    secondaryLabel: "var(--dsx-secondary-label)",
    tertiary: "var(--dsx-tertiary-label)",
    tertiaryLabel: "var(--dsx-tertiary-label)",
    background: "var(--dsx-background)",
    systemBackground: "var(--dsx-background)",
    secondaryBackground: "var(--dsx-secondary-background)",
    tertiaryBackground: "var(--dsx-tertiary-background)",
    groupedBackground: "var(--dsx-grouped-background)",
    secondaryGroupedBackground: "var(--dsx-secondary-grouped-background)",
    fill: "var(--dsx-fill)",
    fillFaint: "color-mix(in srgb, var(--dsx-fill) 50%, transparent)",
    separator: "var(--dsx-separator)",
    destructive: "var(--dsx-destructive)",
  };
  if (tokens[raw] !== undefined) return tokens[raw]!;
  if (/^#[0-9a-f]{3}$/i.test(raw) || /^#[0-9a-f]{6}$/i.test(raw)) return raw;
  const argb = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(raw);
  if (argb !== null) {
    const alpha = Number.parseInt(argb[1]!, 16) / 255;
    const rgb = argb[2]!;
    return `rgb(${Number.parseInt(rgb.slice(0, 2), 16)} ${Number.parseInt(rgb.slice(2, 4), 16)} ${Number.parseInt(rgb.slice(4, 6), 16)} / ${alpha.toFixed(4)})`;
  }
  if (/^rgba?\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+(?:\s*,\s*[0-9.]+)?\s*\)$/i.test(raw)) return raw;
  return "var(--dsx-background)";
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** Pure collision solver shared by menu, context menu and popover. `top` follows
 * the DSX arrow contract: the bubble is below the anchor and its top edge points
 * back; `bottom` is the inverse. Leading/trailing are direction aware. */
export function placeFloating(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  preference: FloatingPreference = "top",
  rtl = false,
  margin = 8,
  gap = 8,
): FloatingPlacement {
  const leading = rtl ? "right" : "left";
  const trailing = rtl ? "left" : "right";
  const desired = preference === "top" ? "bottom"
    : preference === "bottom" ? "top"
    : preference === "leading" ? trailing : leading;
  const opposite = desired === "bottom" ? "top" : desired === "top" ? "bottom" : desired === "left" ? "right" : "left";
  const fits = (side: string): boolean => side === "bottom" ? anchor.bottom + gap + panel.height <= viewport.height - margin
    : side === "top" ? anchor.top - gap - panel.height >= margin
    : side === "right" ? anchor.right + gap + panel.width <= viewport.width - margin
    : anchor.left - gap - panel.width >= margin;
  const side = fits(desired) || !fits(opposite) ? desired : opposite;
  let x = side === "right" ? anchor.right + gap
    : side === "left" ? anchor.left - panel.width - gap
    : rtl ? anchor.right - panel.width : anchor.left;
  let y = side === "bottom" ? anchor.bottom + gap
    : side === "top" ? anchor.top - panel.height - gap
    : anchor.top;
  x = clamp(x, margin, viewport.width - panel.width - margin);
  y = clamp(y, margin, viewport.height - panel.height - margin);
  return { x, y, placement: side } as FloatingPlacement;
}

// ── shared layer/focus/background coordinator ───────────────────────────────────────

type ActiveLayer = { layer: HTMLElement; modal: boolean };
const activeLayers: ActiveLayer[] = [];
const changedBackground = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
let savedDocumentOverflow: string | null = null;

function restoreBackground(): void {
  for (const [element, prior] of changedBackground) {
    element.inert = prior.inert;
    if (prior.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", prior.ariaHidden);
  }
  changedBackground.clear();
}

function lockSibling(element: HTMLElement): void {
  if (!changedBackground.has(element)) {
    changedBackground.set(element, { inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") });
  }
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

/** Inert every branch outside the active modal's ancestor path. Keeping the layer
 * in its component tree preserves owner-scoped author CSS and subtree tokens while
 * still giving assistive technology a single active surface. */
function refreshBackgroundLock(): void {
  restoreBackground();
  let modalIndex = -1;
  for (let index = activeLayers.length - 1; index >= 0; index -= 1) {
    if (activeLayers[index]?.modal === true) { modalIndex = index; break; }
  }
  const modal = modalIndex < 0 ? undefined : activeLayers[modalIndex];
  if (modal === undefined) {
    if (savedDocumentOverflow !== null) {
      document.documentElement.style.overflow = savedDocumentOverflow;
      savedDocumentOverflow = null;
    }
    return;
  }
  if (savedDocumentOverflow === null) {
    savedDocumentOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
  }
  // Layers opened above the active modal (for example a menu or popover launched
  // from a Drawer) are part of the foreground, even though body portalling makes
  // their scopes siblings of the modal scope. Mark every ancestor branch for the
  // active modal and all later layers as exempt before locking background siblings.
  // A newer modal still correctly inerts older modal/non-modal layers below it.
  const foregroundBranches = new Set<HTMLElement>();
  for (const entry of activeLayers.slice(modalIndex)) {
    let branch: HTMLElement | null = entry.layer;
    while (branch !== null) {
      foregroundBranches.add(branch);
      branch = branch.parentElement;
    }
  }
  let current: HTMLElement | null = modal.layer;
  while (current?.parentElement !== null && current?.parentElement !== undefined) {
    const parent: HTMLElement = current.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === current || !(sibling instanceof HTMLElement)) continue;
      if (foregroundBranches.has(sibling)) continue;
      if (sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE" || sibling.tagName === "LINK") continue;
      lockSibling(sibling);
    }
    current = parent;
  }
}

function activateLayer(layer: HTMLElement, modal: boolean): boolean {
  if (activeLayers.some((entry) => entry.layer === layer)) return true;
  if (activeLayers.length >= OVERLAY_LIMITS.maxOpenDepth) {
    console.warn(`[dsx dom] refusing overlay depth above ${OVERLAY_LIMITS.maxOpenDepth}`);
    return false;
  }
  activeLayers.push({ layer, modal });
  layer.style.setProperty("--dsx-overlay-level", String(activeLayers.length));
  refreshBackgroundLock();
  return true;
}

function deactivateLayer(layer: HTMLElement): void {
  const index = activeLayers.findIndex((entry) => entry.layer === layer);
  if (index >= 0) activeLayers.splice(index, 1);
  layer.style.removeProperty("--dsx-overlay-level");
  // Closing an underlying modal while a newer popover remains must not leave a
  // hole in the level ledger: the next layer otherwise ties its z-index.
  activeLayers.forEach((entry, remainingIndex) => {
    entry.layer.style.setProperty("--dsx-overlay-level", String(remainingIndex + 1));
  });
  refreshBackgroundLock();
}

function isTopLayer(layer: HTMLElement): boolean {
  return activeLayers.at(-1)?.layer === layer;
}

const FOCUSABLE = [
  "button:not([disabled])", "a[href]", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((candidate) => {
    let current: HTMLElement | null = candidate;
    while (current !== null && panel.contains(current)) {
      if (current.hidden || current.inert || current.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (current === panel) break;
      current = current.parentElement;
    }
    // Real browsers expose layout boxes; DOM-only test shims often do not. Keep the
    // ancestor checks testable there while excluding clipped/non-rendered targets in
    // production engines.
    return typeof window.matchMedia !== "function" || candidate.getClientRects().length > 0;
  });
}

type LayerPortal = Readonly<{ mount(): void; unmount(): void }>;

/** Fixed overlays must escape a router frame's z-index stacking context: the system
 * route bar is a body-level sibling. A body portal keeps modal chrome above it while
 * a lightweight scope preserves the component owner/classes and computed DSX tokens
 * that ordinary sidecar CSS relies on. */
function layerPortal(layer: HTMLElement, ctx: MountCtx): LayerPortal {
  const home = layer.parentElement;
  if (home === null) throw new Error("overlay layer must have a host before binding");
  const scope = el("div", "dsx-overlay-portal-scope");
  scope.setAttribute("data-dsx-owner", ctx.owner);
  let mounted = false;
  let observer: MutationObserver | null = null;
  const copiedProperties = new Set<string>();

  const syncScope = (): void => {
    scope.className = `dsx-overlay-portal-scope ${home.className}`.trim();
    const computed = getComputedStyle(home);
    const nextProperties = new Set<string>();
    for (let index = 0; index < computed.length; index += 1) {
      const property = computed.item(index);
      if (!property.startsWith("--dsx-")) continue;
      nextProperties.add(property);
      scope.style.setProperty(property, computed.getPropertyValue(property));
    }
    for (const property of copiedProperties) {
      if (!nextProperties.has(property)) scope.style.removeProperty(property);
    }
    copiedProperties.clear();
    for (const property of nextProperties) copiedProperties.add(property);
    scope.dir = computed.direction === "rtl" ? "rtl" : "ltr";
    scope.style.setProperty("direction", computed.direction);
    scope.style.setProperty("writing-mode", computed.writingMode);
    scope.style.setProperty("color-scheme", computed.colorScheme);
    const language = home.closest<HTMLElement>("[lang]")?.lang || document.documentElement.lang;
    if (language.length > 0) scope.lang = language;
    else scope.removeAttribute("lang");
  };
  const observeScopeInputs = (): void => {
    observer?.disconnect();
    if (typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(syncScope);
    let current: HTMLElement | null = home;
    while (current !== null) {
      observer.observe(current, {
        attributes: true,
        attributeFilter: ["class", "style", "dir", "lang", "data-theme"],
      });
      current = current.parentElement;
    }
  };
  return {
    mount() {
      if (mounted) { syncScope(); return; }
      syncScope();
      scope.appendChild(layer);
      document.body.appendChild(scope);
      observeScopeInputs();
      mounted = true;
    },
    unmount() {
      if (!mounted) return;
      observer?.disconnect();
      observer = null;
      home.appendChild(layer);
      scope.remove();
      mounted = false;
    },
  };
}

function semanticTrigger(anchor: HTMLElement, panel: HTMLElement, popup: "dialog" | "menu"): HTMLElement {
  const trigger = anchor.querySelector<HTMLElement>(FOCUSABLE) ?? anchor;
  if (trigger === anchor) {
    trigger.setAttribute("role", "button");
    trigger.tabIndex = 0;
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      trigger.click();
    });
  }
  trigger.setAttribute("aria-haspopup", popup);
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", panel.id);
  if (popup === "dialog") {
    if (trigger.id.length === 0) trigger.id = `${panel.id}-trigger`;
    panel.setAttribute("aria-labelledby", trigger.id);
  }
  return trigger;
}

export type PresentationController = Readonly<{
  show(): void;
  dismiss(reason: string): void;
  isOpen(): boolean;
}>;

/** Shared focus/stack/portal coordinator for optional DSX presentation controls.
 * Kept here so Drawer participates in the same top-layer Escape and inert ledger
 * as sheet/popover/menu instead of creating an independent modal universe. */
export function bindPresentation(
  node: XmlNode,
  ctx: MountCtx,
  api: ElementApi,
  layer: HTMLElement,
  panel: HTMLElement,
  options: {
    modal: boolean;
    initialFocus?: () => HTMLElement | null;
    restoreFocus?: () => HTMLElement | null;
    onOpen?: () => void;
    onClose?: () => void;
  },
): PresentationController {
  const portal = layerPortal(layer, ctx);
  let open = false;
  let hadOpened = false;
  let pendingReason = "";
  let restoreFocus: HTMLElement | null = null;
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let listening = false;

  const onKey = (event: KeyboardEvent): void => {
    if (!open || !isTopLayer(layer)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss("escape");
      return;
    }
    if (event.key !== "Tab") return;
    if (!options.modal) {
      dismiss("tab");
      return;
    }
    const candidates = focusables(panel);
    if (candidates.length === 0) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? candidates.indexOf(active) : -1;
    const targetIndex = activeIndex < 0 ? (event.shiftKey ? candidates.length - 1 : 0)
      : (activeIndex + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length;
    // Own modal Tab traversal rather than relying on the host's keyboard-access
    // preference. Safari/WebKit may omit buttons from native Tab order even though
    // they are programmatically focusable, which would otherwise escape to body.
    event.preventDefault();
    candidates[targetIndex]!.focus({ preventScroll: true });
  };
  const onFocus = (event: FocusEvent): void => {
    if (!open || !options.modal || !isTopLayer(layer) || panel.contains(event.target as Node)) return;
    (focusables(panel)[0] ?? panel).focus({ preventScroll: true });
  };
  const attachDocumentListeners = (): void => {
    if (listening) return;
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    listening = true;
  };
  const detachDocumentListeners = (): void => {
    if (!listening) return;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocus, true);
    listening = false;
  };

  const setOpen = (next: boolean, reason = "programmatic"): void => {
    if (next === open) return;
    if (restoreTimer !== null) { clearTimeout(restoreTimer); restoreTimer = null; }
    open = next;
    generation += 1;
    const ticket = generation;
    if (next) {
      attachDocumentListeners();
      hadOpened = true;
      restoreFocus = options.restoreFocus?.()
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      layer.hidden = false;
      layer.inert = false;
      layer.removeAttribute("aria-hidden");
      queueMicrotask(() => {
        if (!open || ticket !== generation) return;
        portal.mount();
        if (!activateLayer(layer, options.modal)) {
          detachDocumentListeners();
          portal.unmount();
          open = false;
          layer.hidden = true;
          layer.inert = true;
          layer.setAttribute("aria-hidden", "true");
          return;
        }
        options.onOpen?.();
        (options.initialFocus?.() ?? focusables(panel)[0] ?? panel).focus({ preventScroll: true });
      });
      return;
    }
    detachDocumentListeners();
    deactivateLayer(layer);
    options.onClose?.();
    layer.hidden = true;
    layer.inert = true;
    layer.setAttribute("aria-hidden", "true");
    portal.unmount();
    const focusTarget = restoreFocus;
    restoreFocus = null;
    if (hadOpened) api.handler("dismiss", { reason: pendingReason || reason });
    pendingReason = "";
    // WebKit may apply the clicked control's default focus after its handler has
    // synchronously closed the layer. Restore on the next task so the trigger wins
    // after that default action, while never stealing focus from a newer layer.
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      if (ticket !== generation || focusTarget?.isConnected !== true) return;
      const top = activeLayers.at(-1);
      if (top !== undefined && !top.layer.contains(focusTarget)) return;
      focusTarget.focus({ preventScroll: true });
    }, 0);
  };

  const dismiss = (reason: string): void => {
    if (!open) return;
    pendingReason = boundedText(reason);
    if (node.attrs["present"] !== undefined) api.writeBack(node.attrs["present"], false);
    // A malformed/non-writeable expression cannot leave a user-dismissed modal
    // trapping focus. The store callback, when synchronous, already performed this.
    if (open) setOpen(false, reason);
  };

  ctx.disposers.push(() => {
    detachDocumentListeners();
    if (restoreTimer !== null) clearTimeout(restoreTimer);
    restoreTimer = null;
    if (open) deactivateLayer(layer);
    portal.unmount();
    open = false;
  });

  layer.hidden = true;
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");
  if (node.attrs["present"] !== undefined) {
    api.bindValue(node.attrs["present"], (value) => setOpen(truthy(value), "programmatic"));
  }
  return { show: () => setOpen(true, "programmatic"), dismiss, isOpen: () => open };
}

function boundedChildren(node: XmlNode, slot?: string): readonly XmlNode[] {
  const children = slot === undefined
    ? node.children.filter((child) => child.attrs["slot"] === undefined || child.attrs["slot"] === "")
    : node.children.filter((child) => child.attrs["slot"] === slot);
  if (children.length > OVERLAY_LIMITS.maxChildren) {
    console.warn(`[dsx dom] <${node.tag}> content exceeds ${OVERLAY_LIMITS.maxChildren} nodes; truncating`);
  }
  return children.slice(0, OVERLAY_LIMITS.maxChildren);
}

let overlaySequence = 0;

function modalParts(kind: "sheet" | "alert" | "confirm"): {
  host: HTMLElement;
  layer: HTMLElement;
  scrim: HTMLElement;
  panel: HTMLElement;
} {
  const host = el("span", `dsx-overlay-host dsx-${kind}-host`);
  const layer = el("div", `dsx-overlay-layer dsx-${kind}-layer`);
  const scrim = el("div", "dsx-overlay-scrim");
  const panel = el("section", `dsx-overlay-panel dsx-${kind}-panel`);
  layer.setAttribute("role", "presentation");
  scrim.setAttribute("aria-hidden", "true");
  panel.setAttribute("role", kind === "alert" ? "alertdialog" : "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.tabIndex = -1;
  layer.append(scrim, panel);
  host.appendChild(layer);
  return { host, layer, scrim, panel };
}

function bindLabel(api: ElementApi, expression: string | undefined, target: HTMLElement, fallback = ""): void {
  api.bindText(expression ?? fallback, (value) => { target.textContent = boundedText(value); });
}

function dispatchItem(item: OverlayItem): void {
  if (item.action.length === 0 || item.disabled) return;
  void ModuleRegistry.call(item.action, item.args).catch((error: unknown) => {
    console.warn(`[dsx dom] overlay action ${item.action} failed:`, error);
  });
}

function dialogItems(
  node: XmlNode,
  api: ElementApi,
  host: HTMLElement,
  controller: () => PresentationController,
  confirm: boolean,
): void {
  const render = (value: unknown): void => {
    let items = normalizeOverlayItems(value);
    if (!confirm && items.length === 0) items = normalizeOverlayItems([{ label: "OK" }]);
    if (confirm && !items.some((item) => item.role === "cancel")) {
      items = [...items, ...normalizeOverlayItems([{ label: "Cancel", role: "cancel" }])];
    }
    host.replaceChildren(...items.map((item) => {
      if (item.separator) {
        const separator = el("div", "dsx-dialog-separator");
        separator.setAttribute("role", "separator");
        return separator;
      }
      const button = el("button", "dsx-dialog-action") as HTMLButtonElement;
      button.type = "button";
      button.textContent = item.title;
      button.disabled = item.disabled;
      if (item.role !== "normal") button.setAttribute("data-dsx-role", item.role);
      button.addEventListener("click", () => {
        dispatchItem(item);
        controller().dismiss(item.role === "cancel" ? "cancel" : "action");
      });
      return button;
    }));
  };
  if (node.attrs["buttons"] === undefined) render([]);
  else api.bindValue(node.attrs["buttons"], render);
}

export const alert: ElementFactory = (node, ctx, api) => {
  const { host, layer, scrim, panel } = modalParts("alert");
  const body = el("div", "dsx-dialog-body");
  const title = el("h2", "dsx-dialog-title");
  const message = el("p", "dsx-dialog-message");
  const actions = el("div", "dsx-dialog-actions");
  const id = ++overlaySequence;
  title.id = `dsx-alert-title-${id}`;
  message.id = `dsx-alert-message-${id}`;
  panel.setAttribute("aria-labelledby", title.id);
  panel.setAttribute("aria-describedby", message.id);
  bindLabel(api, node.attrs["title"], title);
  bindLabel(api, node.attrs["message"], message);
  body.append(title, message);
  panel.append(body, actions);
  let controller!: PresentationController;
  controller = bindPresentation(node, ctx, api, layer, panel, { modal: true });
  dialogItems(node, api, actions, () => controller, false);
  // Alert scrims consume the click but do not dismiss; choosing an action or Escape
  // is deliberate and preserves the native alert safety model.
  scrim.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); });
  return host;
};

export const confirmDialog: ElementFactory = (node, ctx, api) => {
  const { host, layer, scrim, panel } = modalParts("confirm");
  const body = el("div", "dsx-dialog-body");
  const title = el("h2", "dsx-dialog-title");
  const message = el("p", "dsx-dialog-message");
  const actions = el("div", "dsx-dialog-actions");
  const id = ++overlaySequence;
  title.id = `dsx-confirm-title-${id}`;
  message.id = `dsx-confirm-message-${id}`;
  panel.setAttribute("aria-labelledby", title.id);
  panel.setAttribute("aria-describedby", message.id);
  bindLabel(api, node.attrs["title"], title);
  bindLabel(api, node.attrs["message"], message);
  body.append(title, message);
  panel.append(body, actions);
  let controller!: PresentationController;
  controller = bindPresentation(node, ctx, api, layer, panel, { modal: true });
  dialogItems(node, api, actions, () => controller, true);
  scrim.addEventListener("click", () => controller.dismiss("outside"));
  return host;
};

export const sheet: ElementFactory = (node, ctx, api) => {
  const { host, layer, scrim, panel } = modalParts("sheet");
  const grabber = el("button", "dsx-sheet-grabber") as HTMLButtonElement;
  const chrome = el("header", "dsx-sheet-chrome");
  const leading = el("div", "dsx-sheet-chrome-side dsx-sheet-chrome-leading");
  const heading = el("h2", "dsx-sheet-title");
  const trailing = el("div", "dsx-sheet-chrome-side dsx-sheet-chrome-trailing");
  const content = el("div", "dsx-sheet-content");
  const close = el("button", "dsx-sheet-close") as HTMLButtonElement;
  const action = el("button", "dsx-sheet-action") as HTMLButtonElement;
  const id = ++overlaySequence;
  heading.id = `dsx-sheet-title-${id}`;
  panel.setAttribute("aria-labelledby", heading.id);
  grabber.type = "button";
  grabber.setAttribute("aria-label", "Resize sheet");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.appendChild(iconSvg("xmark", 18));
  action.type = "button";
  bindLabel(api, node.attrs["title"], heading);
  const actionLabel = el("span", "dsx-sheet-action-label");
  let actionText = "";
  let actionIcon = "";
  const renderAction = (): void => {
    action.replaceChildren();
    if (actionIcon.length > 0) action.appendChild(iconSvg(actionIcon, 18));
    actionLabel.textContent = actionText;
    if (actionText.length > 0) action.appendChild(actionLabel);
    // An icon-only action must still have a name. Authors can provide the exact
    // localized name with action; the bounded icon identifier is a safe fallback.
    if (actionText.length === 0 && actionIcon.length > 0) action.setAttribute("aria-label", actionIcon);
    else action.removeAttribute("aria-label");
  };
  if (node.attrs["action"] !== undefined) {
    api.bindText(node.attrs["action"], (value) => { actionText = boundedText(value); renderAction(); });
  }
  if (node.attrs["actionIcon"] !== undefined) {
    api.bindText(node.attrs["actionIcon"], (value) => { actionIcon = boundedText(value); renderAction(); });
  }
  api.children(content, boundedChildren(node));
  chrome.append(leading, heading, trailing);
  panel.append(grabber, chrome, content);

  let controller!: PresentationController;
  controller = bindPresentation(node, ctx, api, layer, panel, { modal: true });
  close.addEventListener("click", () => controller.dismiss("close"));
  action.addEventListener("click", () => api.handler("action"));
  scrim.addEventListener("click", () => controller.dismiss("outside"));

  let detents = normalizeSheetDetents(node.attrs["detents"]);
  let detentIndex = 0;
  const reflectDetent = (): void => {
    detentIndex = Math.min(Math.max(detentIndex, 0), Math.max(detents.length - 1, 0));
    const current = detents[detentIndex] ?? "half";
    panel.setAttribute("data-dsx-detent", current);
    grabber.setAttribute("aria-valuetext", current);
    grabber.setAttribute("aria-valuenow", String(detentIndex + 1));
    grabber.setAttribute("aria-valuemin", "1");
    grabber.setAttribute("aria-valuemax", String(detents.length));
  };
  api.bindText(node.attrs["detents"] ?? "half,full", (value) => {
    const prior = detents[detentIndex];
    detents = normalizeSheetDetents(value);
    detentIndex = Math.max(0, prior === undefined ? 0 : detents.indexOf(prior));
    reflectDetent();
  });
  const moveDetent = (delta: number): void => {
    detentIndex = Math.min(Math.max(detentIndex + delta, 0), detents.length - 1);
    reflectDetent();
  };
  grabber.addEventListener("click", () => moveDetent(detentIndex < detents.length - 1 ? 1 : -detentIndex));
  grabber.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") { event.preventDefault(); moveDetent(1); }
    if (event.key === "ArrowDown") { event.preventDefault(); moveDetent(-1); }
    if (event.key === "Home") { event.preventDefault(); detentIndex = 0; reflectDetent(); }
    if (event.key === "End") { event.preventDefault(); detentIndex = detents.length - 1; reflectDetent(); }
  });

  api.bindText(node.attrs["mode"] ?? "sheet", (value) => {
    const mode = value === "card" || value === "cover" ? value : "sheet";
    panel.setAttribute("data-dsx-mode", mode);
    grabber.hidden = mode === "cover";
  });
  const hasChrome = ["title", "action", "actionIcon", "close"].some((name) => node.attrs[name] !== undefined);
  chrome.hidden = !hasChrome;
  const closeSide = node.attrs["close"] === "trailing" ? "trailing" : "leading";
  const actionSide = node.attrs["actionSide"] === "leading" ? "leading" : "trailing";
  const closeVisible = hasChrome && node.attrs["close"] !== "none";
  close.hidden = !closeVisible;
  action.hidden = node.attrs["action"] === undefined && node.attrs["actionIcon"] === undefined;
  (closeSide === "leading" ? leading : trailing).appendChild(close);
  (actionSide === "leading" ? leading : trailing).appendChild(action);
  if (node.attrs["inset"] !== undefined) {
    api.bindText(node.attrs["inset"], (value) => {
      const parsed = number(value);
      panel.style.setProperty("--dsx-sheet-inset", `${parsed !== null && Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 128) : 14}px`);
    });
  }
  if (node.attrs["background"] !== undefined) {
    api.bindText(node.attrs["background"], (value) => {
      const background = normalizeSheetBackground(value);
      panel.setAttribute("data-dsx-background", background === null ? "system" : "authored");
      if (background === null) panel.style.removeProperty("--dsx-sheet-background");
      else panel.style.setProperty("--dsx-sheet-background", background);
    });
  }
  return host;
};

// ── floating presentations (popover/menu/context menu) ─────────────────────────────

function positionFloating(
  anchor: HTMLElement,
  panel: HTMLElement,
  preference: FloatingPreference,
  point?: { x: number; y: number },
): void {
  const source = point === undefined
    ? anchor.getBoundingClientRect()
    : { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 } as DOMRect;
  const rect = panel.getBoundingClientRect();
  const rtl = getComputedStyle(anchor).direction === "rtl";
  const placed = placeFloating(source, { width: rect.width, height: rect.height }, {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
  }, preference, rtl);
  panel.style.left = `${placed.x}px`;
  panel.style.top = `${placed.y}px`;
  panel.setAttribute("data-dsx-placement", placed.placement);
}

function floatingController(
  node: XmlNode,
  ctx: MountCtx,
  api: ElementApi,
  host: HTMLElement,
  layer: HTMLElement,
  panel: HTMLElement,
  anchor: HTMLElement,
  preference: () => FloatingPreference,
  point: () => { x: number; y: number } | undefined,
  trigger?: HTMLElement,
): PresentationController {
  const reposition = (): void => {
    if (!layer.hidden) positionFloating(anchor, panel, preference(), point());
  };
  host.appendChild(layer);
  const controller = bindPresentation(node, ctx, api, layer, panel, {
    modal: false,
    restoreFocus: () => trigger ?? anchor,
    onOpen: () => { trigger?.setAttribute("aria-expanded", "true"); reposition(); },
    onClose: () => { trigger?.setAttribute("aria-expanded", "false"); },
  });
  const outside = (event: PointerEvent): void => {
    if (!controller.isOpen()) return;
    const target = event.target as Node | null;
    if (target !== null && (panel.contains(target) || anchor.contains(target))) return;
    controller.dismiss("outside");
  };
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", reposition);
  document.addEventListener("scroll", reposition, true);
  ctx.disposers.push(() => {
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", reposition);
    document.removeEventListener("scroll", reposition, true);
  });
  return controller;
}

export const popover: ElementFactory = (node, ctx, api) => {
  const host = el("span", "dsx-overlay-host dsx-popover-host");
  const anchor = el("span", "dsx-popover-anchor");
  const layer = el("div", "dsx-floating-layer dsx-popover-layer");
  const panel = el("section", "dsx-floating-panel dsx-popover-panel");
  panel.id = `dsx-popover-panel-${++overlaySequence}`;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.tabIndex = -1;
  api.children(anchor, boundedChildren(node));
  api.children(panel, boundedChildren(node, "content"));
  layer.appendChild(panel);
  host.appendChild(anchor);
  const trigger = semanticTrigger(anchor, panel, "dialog");
  let arrow: FloatingPreference = "top";
  api.bindText(node.attrs["arrow"] ?? "top", (value) => {
    arrow = value === "bottom" || value === "leading" || value === "trailing" ? value : "top";
    panel.setAttribute("data-dsx-arrow", arrow);
  });
  floatingController(node, ctx, api, host, layer, panel, anchor, () => arrow, () => undefined, trigger);
  return host;
};

type MenuRender = { first: () => HTMLButtonElement | null };

function menuLevel(
  items: readonly OverlayItem[],
  controller: () => PresentationController,
  root: HTMLElement,
): MenuRender {
  const menu = el("div", "dsx-menu-level");
  menu.setAttribute("role", "menu");
  const buttons: HTMLButtonElement[] = [];
  const closeSubmenus: Array<() => void> = [];

  const focusAt = (index: number): void => {
    const active = buttons.filter((button) => !button.disabled && !button.hidden);
    if (active.length === 0) { menu.focus(); return; }
    active[((index % active.length) + active.length) % active.length]?.focus();
  };

  for (const item of items) {
    if (item.separator) {
      const separator = el("div", "dsx-menu-separator");
      separator.setAttribute("role", "separator");
      menu.appendChild(separator);
      continue;
    }
    const row = el("div", "dsx-menu-row");
    const button = el("button", "dsx-menu-item") as HTMLButtonElement;
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.disabled = item.disabled;
    if (item.role !== "normal") button.setAttribute("data-dsx-role", item.role);
    if (item.icon.length > 0) button.appendChild(iconSvg(item.icon, 18));
    const label = el("span", "dsx-menu-item-label");
    label.textContent = item.title;
    button.appendChild(label);
    row.appendChild(button);
    buttons.push(button);

    if (item.items.length > 0) {
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      const arrow = el("span", "dsx-menu-item-arrow");
      arrow.textContent = "›";
      arrow.setAttribute("aria-hidden", "true");
      button.appendChild(arrow);
      const submenu = menuLevel(item.items, controller, root);
      const submenuHost = submenu.first()?.closest(".dsx-menu-level") as HTMLElement | null;
      if (submenuHost !== null) {
        submenuHost.classList.add("dsx-submenu");
        submenuHost.id = `dsx-submenu-${++overlaySequence}`;
        button.setAttribute("aria-controls", submenuHost.id);
        submenuHost.hidden = true;
        row.appendChild(submenuHost);
      }
      const close = (): void => {
        if (submenuHost === null) return;
        submenuHost.hidden = true;
        submenuHost.inert = true;
        button.setAttribute("aria-expanded", "false");
      };
      const open = (): void => {
        for (const closeOther of closeSubmenus) closeOther();
        if (submenuHost === null) return;
        submenuHost.hidden = false;
        submenuHost.inert = false;
        button.setAttribute("aria-expanded", "true");
        const rowRect = button.getBoundingClientRect();
        const subRect = submenuHost.getBoundingClientRect();
        const rtl = getComputedStyle(root).direction === "rtl";
        const preferRight = !rtl;
        const roomRight = rowRect.right + subRect.width + 6 <= document.documentElement.clientWidth - 8;
        const roomLeft = rowRect.left - subRect.width - 6 >= 8;
        const useRight = preferRight ? (roomRight || !roomLeft) : !(roomLeft || !roomRight);
        submenuHost.style.left = `${useRight ? rowRect.width + 4 : -subRect.width - 4}px`;
        submenuHost.style.top = "0px";
        submenuHost.setAttribute("data-dsx-placement", useRight ? "right" : "left");
        submenu.first()?.focus();
      };
      closeSubmenus.push(close);
      button.addEventListener("click", (event) => { event.stopPropagation(); open(); });
      button.addEventListener("keydown", (event) => {
        const rtl = getComputedStyle(root).direction === "rtl";
        if (event.key === (rtl ? "ArrowLeft" : "ArrowRight")) { event.preventDefault(); open(); }
      });
    } else {
      button.addEventListener("click", () => {
        dispatchItem(item);
        controller().dismiss("selection");
      });
    }
    menu.appendChild(row);
  }

  menu.tabIndex = -1;
  menu.addEventListener("keydown", (event) => {
    const enabled = buttons.filter((button) => !button.disabled);
    const index = Math.max(0, enabled.indexOf(document.activeElement as HTMLButtonElement));
    if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); focusAt(index + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); focusAt(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); event.stopPropagation(); focusAt(0); }
    else if (event.key === "End") { event.preventDefault(); event.stopPropagation(); focusAt(-1); }
    else {
      const rtl = getComputedStyle(root).direction === "rtl";
      if (event.key === (rtl ? "ArrowRight" : "ArrowLeft") && menu.classList.contains("dsx-submenu")) {
        event.preventDefault();
        event.stopPropagation();
        (menu.parentElement?.querySelector(":scope > .dsx-menu-item") as HTMLElement | null)?.focus();
        menu.hidden = true;
        menu.inert = true;
      }
    }
  });
  root.appendChild(menu);
  return { first: () => buttons.find((button) => !button.disabled) ?? null };
}

/** `<contextmenu>` opens on the platform's own long-press timing. UIKit's
 *  UILongPressGestureRecognizer (which UIContextMenuInteraction drives, and which
 *  ContextMenu.swift rides through SwiftUI's `.contextMenu`) fires at its default
 *  `minimumPressDuration` of 0.5 s, with a small slop before the press is abandoned.
 *  Naming both makes the browser twin's timing a DECLARED parity choice rather than a
 *  magic number, and overlay-controls.test.ts fails if either drifts. */
export const CONTEXT_MENU_PRESS = { durationMs: 500, slopPx: 10 } as const;

function menuFactory(longPress: boolean): ElementFactory {
  return (node, ctx, api) => {
    const host = el("span", `dsx-overlay-host ${longPress ? "dsx-contextmenu-host" : "dsx-menu-host"}`);
    const anchor = el("span", "dsx-menu-trigger");
    const layer = el("div", "dsx-floating-layer dsx-menu-layer");
    const panel = el("div", "dsx-floating-panel dsx-menu-panel");
    panel.id = `dsx-menu-panel-${++overlaySequence}`;
    panel.setAttribute("role", "presentation");
    panel.tabIndex = -1;
    api.children(anchor, boundedChildren(node));
    layer.appendChild(panel);
    host.appendChild(anchor);
    host.appendChild(layer);
    const trigger = semanticTrigger(anchor, panel, "menu");
    const portal = layerPortal(layer, ctx);
    layer.hidden = true;
    layer.inert = true;
    layer.setAttribute("aria-hidden", "true");
    let point: { x: number; y: number } | undefined;
    let rendered: MenuRender = { first: () => null };
    let controller!: PresentationController;
    const render = (value: unknown): void => {
      panel.replaceChildren();
      rendered = menuLevel(normalizeOverlayItems(value), () => controller, panel);
    };
    if (node.attrs["menu"] !== undefined) api.bindValue(node.attrs["menu"], render);
    else render([]);

    let ownedOpen = false;
    const open = (nextPoint?: { x: number; y: number }): void => {
      if (ownedOpen) return;
      point = nextPoint;
      ownedOpen = true;
      layer.hidden = false;
      layer.inert = false;
      layer.removeAttribute("aria-hidden");
      trigger.setAttribute("aria-expanded", "true");
      queueMicrotask(() => {
        if (!ownedOpen) return;
        portal.mount();
        if (!activateLayer(layer, false)) {
          ownedOpen = false;
          layer.hidden = true;
          layer.inert = true;
          layer.setAttribute("aria-hidden", "true");
          trigger.setAttribute("aria-expanded", "false");
          portal.unmount();
          return;
        }
        positionFloating(anchor, panel, "top", point);
        (rendered.first() ?? panel).focus({ preventScroll: true });
      });
    };
    const close = (reason: string): void => {
      if (!ownedOpen) return;
      ownedOpen = false;
      deactivateLayer(layer);
      layer.hidden = true;
      layer.inert = true;
      layer.setAttribute("aria-hidden", "true");
      portal.unmount();
      trigger.setAttribute("aria-expanded", "false");
      trigger.focus({ preventScroll: true });
      api.handler("dismiss", { reason });
    };
    controller = { show: () => open(), dismiss: close, isOpen: () => ownedOpen };

    const outside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!ownedOpen || (target !== null && (panel.contains(target) || anchor.contains(target)))) return;
      close("outside");
    };
    const onKey = (event: KeyboardEvent): void => {
      if (!ownedOpen || !isTopLayer(layer)) return;
      if (event.key === "Escape") { event.preventDefault(); close("escape"); }
      else if (event.key === "Tab") close("tab");
    };
    const reposition = (): void => { if (ownedOpen) positionFloating(anchor, panel, "top", point); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    ctx.disposers.push(() => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
      if (ownedOpen) deactivateLayer(layer);
      portal.unmount();
      ownedOpen = false;
    });

    if (!longPress) {
      anchor.addEventListener("click", (event) => {
        if ((event as MouseEvent).button !== 0 || (event.target as Element | null)?.closest(".dsx-menu-panel") !== null) return;
        event.preventDefault();
        ownedOpen ? close("trigger") : open();
      }, true);
    } else {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let startX = 0;
      let startY = 0;
      const cancel = (): void => { if (timer !== null) { clearTimeout(timer); timer = null; } };
      anchor.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        open({ x: event.clientX, y: event.clientY });
      });
      anchor.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        startX = event.clientX;
        startY = event.clientY;
        cancel();
        timer = setTimeout(() => {
          timer = null;
          open({ x: startX, y: startY });
        }, CONTEXT_MENU_PRESS.durationMs);
      });
      anchor.addEventListener("pointermove", (event) => {
        if (timer !== null
          && Math.hypot(event.clientX - startX, event.clientY - startY) > CONTEXT_MENU_PRESS.slopPx) cancel();
      });
      anchor.addEventListener("pointerup", cancel);
      anchor.addEventListener("pointercancel", cancel);
      ctx.disposers.push(cancel);
    }
    return host;
  };
}

export const menu = menuFactory(false);
export const contextmenu = menuFactory(true);

export const OVERLAY_CONTROL_ELEMENTS: Readonly<Record<string, ElementFactory>> = Object.freeze({
  sheet, alert, confirmDialog, popover, menu, contextmenu,
});

export function registerOverlayControls(): void {
  Object.assign(ELEMENTS, OVERLAY_CONTROL_ELEMENTS);
}

/** Neutral adaptive defaults. This layer owns no !important declaration and writes
 * no default value inline, preserving sidecar/theme/unlayered author precedence. */
export const OVERLAY_CONTROLS_CSS = `@layer dsx-elements {
  .dsx-overlay-host { display: contents; }
  .dsx-overlay-portal-scope { display: contents; }
  .dsx-overlay-layer, .dsx-floating-layer {
    position: fixed;
    inset: 0;
    z-index: calc(var(--dsx-overlay-z-index, 10000) + var(--dsx-overlay-level, 0));
    color: var(--dsx-label);
    font-family: var(--dsx-font);
  }
  .dsx-overlay-layer *, .dsx-floating-layer * { box-sizing: border-box; }
  .dsx-overlay-layer[hidden], .dsx-floating-layer[hidden] { display: none; }
  .dsx-overlay-scrim { position: absolute; inset: 0; background: rgb(0 0 0 / .44); }
  .dsx-overlay-panel, .dsx-floating-panel {
    color: var(--dsx-label);
    border: 1px solid color-mix(in srgb, var(--dsx-separator) 88%, transparent);
    background: color-mix(in srgb, var(--dsx-background) 94%, transparent);
    box-shadow: 0 24px 70px rgb(0 0 0 / .24), 0 2px 8px rgb(0 0 0 / .12);
    -webkit-backdrop-filter: blur(24px) saturate(1.16);
    backdrop-filter: blur(24px) saturate(1.16);
  }
  .dsx-overlay-panel:focus, .dsx-floating-panel:focus { outline: none; }

  .dsx-alert-panel {
    position: absolute;
    inset: 50% auto auto 50%;
    width: min(calc(100vw - 32px), 26rem);
    max-height: min(80dvh, 42rem);
    overflow: auto;
    border-radius: var(--dsx-radius-lg);
    transform: translate(-50%, -50%);
  }
  .dsx-confirm-panel {
    position: absolute;
    inset: auto max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
    max-height: min(82dvh, 44rem);
    overflow: auto;
    border-radius: var(--dsx-radius-lg);
  }
  .dsx-dialog-body { display: grid; gap: 6px; padding: 22px 20px 18px; text-align: center; }
  .dsx-dialog-title, .dsx-dialog-message { margin: 0; overflow-wrap: anywhere; }
  .dsx-dialog-title { font-size: 1.0625rem; line-height: 1.3; letter-spacing: -.015em; }
  .dsx-dialog-message { color: var(--dsx-secondary-label); font-size: .875rem; line-height: 1.45; }
  .dsx-dialog-title:empty, .dsx-dialog-message:empty { display: none; }
  .dsx-dialog-actions { display: grid; border-top: 1px solid var(--dsx-separator); }
  .dsx-dialog-action {
    appearance: none;
    min-height: 48px;
    padding: 10px 16px;
    border: 0;
    border-top: 1px solid var(--dsx-separator);
    color: var(--dsx-accent);
    background: transparent;
    font: inherit;
    font-weight: 560;
    cursor: pointer;
  }
  .dsx-dialog-action:first-child { border-top: 0; }
  .dsx-dialog-action[data-dsx-role="destructive"] { color: var(--dsx-destructive); }
  .dsx-dialog-action[data-dsx-role="cancel"] { font-weight: 700; }
  .dsx-dialog-action:hover { background: var(--dsx-fill); }
  .dsx-dialog-action:focus-visible { outline: 2px solid var(--dsx-accent); outline-offset: -3px; }

  .dsx-sheet-panel {
    position: absolute;
    inset: auto 0 0;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    width: 100%;
    max-height: calc(100dvh - env(safe-area-inset-top) - 8px);
    overflow: hidden;
    border-radius: 22px 22px 0 0;
    background: var(--dsx-sheet-background, var(--dsx-background));
    transition: height 220ms cubic-bezier(.2,.8,.2,1), transform 220ms cubic-bezier(.2,.8,.2,1);
  }
  .dsx-sheet-panel[data-dsx-background="system"] { background: color-mix(in srgb, var(--dsx-background) 94%, transparent); }
  .dsx-sheet-panel[data-dsx-detent="content"] { height: auto; max-height: 90dvh; }
  .dsx-sheet-panel[data-dsx-detent="half"] { height: 50dvh; }
  .dsx-sheet-panel[data-dsx-detent="full"] { height: calc(100dvh - env(safe-area-inset-top) - 8px); }
  .dsx-sheet-panel[data-dsx-mode="card"] {
    inset-inline: var(--dsx-sheet-inset, 14px);
    width: auto;
    bottom: max(var(--dsx-sheet-inset, 14px), env(safe-area-inset-bottom));
    border-radius: 22px;
  }
  .dsx-sheet-panel[data-dsx-mode="card"][data-dsx-detent="full"] { inset-inline: 0; bottom: 0; border-radius: 22px 22px 0 0; }
  .dsx-sheet-panel[data-dsx-mode="cover"] { inset: 0; width: 100%; height: 100dvh; max-height: none; border-radius: 0; }
  .dsx-sheet-grabber {
    appearance: none;
    justify-self: center;
    width: 52px;
    height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: ns-resize;
  }
  .dsx-sheet-grabber::after { content: ""; display: block; width: 34px; height: 4px; margin: auto; border-radius: 99px; background: var(--dsx-tertiary-label); }
  .dsx-sheet-grabber:focus-visible { outline: 2px solid var(--dsx-accent); outline-offset: -2px; border-radius: 99px; }
  .dsx-sheet-chrome { display: grid; grid-template-columns: minmax(72px,1fr) minmax(0,auto) minmax(72px,1fr); align-items: center; min-height: 48px; padding: 4px 12px; border-bottom: 1px solid var(--dsx-separator); }
  .dsx-sheet-chrome[hidden] { display: none; }
  .dsx-sheet-title { grid-column: 2; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1rem; line-height: 1.25; }
  .dsx-sheet-chrome-side { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .dsx-sheet-chrome-leading { justify-self: start; }
  .dsx-sheet-chrome-trailing { justify-self: end; }
  .dsx-sheet-close, .dsx-sheet-action {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 44px;
    min-height: 44px;
    padding: 6px 9px;
    border: 0;
    border-radius: 999px;
    color: var(--dsx-accent);
    background: var(--dsx-fill);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .dsx-sheet-action:empty { display: none; }
  .dsx-sheet-content { min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }

  .dsx-popover-anchor, .dsx-menu-trigger { display: inline-flex; min-width: 0; }
  .dsx-floating-layer { inset: 0; pointer-events: none; }
  .dsx-floating-panel { position: fixed; pointer-events: auto; }
  .dsx-popover-panel { width: max-content; max-width: min(22rem, calc(100vw - 16px)); max-height: min(70dvh, 36rem); overflow: auto; padding: 14px; border-radius: var(--dsx-radius-lg); }
  .dsx-menu-panel { width: min(17rem, calc(100vw - 16px)); max-height: min(72dvh, 40rem); overflow: auto; border-radius: var(--dsx-radius); }
  .dsx-menu-level { position: relative; min-width: 14rem; padding: 5px; }
  .dsx-menu-level[hidden] { display: none; }
  .dsx-menu-row { position: relative; }
  .dsx-menu-item {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 42px;
    padding: 8px 10px;
    border: 0;
    border-radius: calc(var(--dsx-radius-sm) - 2px);
    color: var(--dsx-label);
    background: transparent;
    text-align: start;
    font: inherit;
    cursor: pointer;
  }
  .dsx-menu-item:hover, .dsx-menu-item:focus-visible { outline: none; background: var(--dsx-fill); }
  .dsx-menu-item[data-dsx-role="destructive"] { color: var(--dsx-destructive); }
  .dsx-menu-item:disabled { opacity: .46; cursor: default; }
  .dsx-menu-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dsx-menu-item-arrow { color: var(--dsx-secondary-label); font-size: 1.25rem; line-height: 1; }
  [dir="rtl"] .dsx-menu-item-arrow { transform: scaleX(-1); }
  .dsx-menu-separator { height: 1px; margin: 5px 7px; background: var(--dsx-separator); }
  .dsx-submenu { position: absolute; z-index: 1; width: 15rem; max-height: min(65dvh, 36rem); overflow: auto; border: 1px solid var(--dsx-separator); border-radius: var(--dsx-radius); background: var(--dsx-background); box-shadow: 0 18px 48px rgb(0 0 0 / .22); }

  @media (min-width: 48rem) {
    .dsx-confirm-panel { inset: 50% auto auto 50%; width: min(calc(100vw - 48px), 32rem); transform: translate(-50%, -50%); }
    .dsx-sheet-panel:not([data-dsx-mode="cover"]) { inset-inline: 50% auto; width: min(calc(100vw - 48px), 44rem); transform: translateX(-50%); border-radius: 22px 22px 0 0; }
    .dsx-sheet-panel[data-dsx-mode="card"] { bottom: max(18px, env(safe-area-inset-bottom)); border-radius: 22px; }
    .dsx-sheet-panel[data-dsx-mode="card"][data-dsx-detent="full"] { inset-inline: 50% auto; width: min(calc(100vw - 48px), 44rem); bottom: 0; border-radius: 22px 22px 0 0; }
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-dialog-action { min-height: 42px; padding-block: 7px; }
    .dsx-sheet-close, .dsx-sheet-action { min-width: 36px; min-height: 36px; }
    .dsx-sheet-panel[data-dsx-detent="half"] { height: min(60dvh, 42rem); }
    .dsx-menu-item { min-height: 34px; padding-block: 5px; font-size: .875rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-sheet-panel { transition-duration: 0s; }
  }
  @media (forced-colors: active) {
    .dsx-overlay-scrim { background: rgb(0 0 0 / .6); }
    .dsx-overlay-panel, .dsx-floating-panel, .dsx-submenu { border-color: CanvasText; background: Canvas; box-shadow: none; forced-color-adjust: auto; }
    .dsx-dialog-action:focus-visible, .dsx-sheet-grabber:focus-visible, .dsx-menu-item:focus-visible { outline-color: Highlight; }
    .dsx-menu-item:hover, .dsx-menu-item:focus-visible { color: HighlightText; background: Highlight; }
  }
}`;
