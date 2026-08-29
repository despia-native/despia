//
//  application-controls.ts - adaptive Web twins for DSX application chrome.
//
//  Drawer and MenuBar intentionally use a neutral DSX skin. They preserve the
//  portable contracts (content ownership, selection, events, focus and dismissal)
//  without drawing a counterfeit UIKit tab bar or Material navigation surface.
//  Defaults live in the weak dsx-elements layer so ordinary application CSS wins.
//


import { isDict, number, string, truthy, type Dict } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import { ELEMENTS, iconSvg, type ElementApi, type ElementFactory } from "./elements.ts";
import type { MountCtx } from "./mount.ts";
import { TABS_WIDE_MEDIA } from "./structural-controls.ts";
import {
  activateLayer, bindPresentation, closeDeepestSubmenu, deactivateLayer, isTopLayer,
  layerPortal, menuLevel, normalizeOverlayItems, positionFloating,
  type MenuRender, type OverlayItem, type PresentationController,
} from "./overlay-controls.ts";

export const APPLICATION_CONTROL_TAGS: ReadonlySet<string> = new Set(["Drawer", "MenuBar"]);

/** The DESKTOP STEP for application chrome: the tabs sidebar breakpoint (one shared
 * width constant, never a fork) narrowed to real desktop input, because both wide
 * presentations (the standing drawer's drag hairline, the menubar's flyout roots)
 * are pointer idioms. Coarse-pointer tablets at the same width keep the compact
 * presentations. */
export const APPLICATION_WIDE_MEDIA = `${TABS_WIDE_MEDIA} and (hover: hover) and (pointer: fine)`;

/** The standing drawer's geometry contract (px): user resizes clamp to min/max,
 * keyboard resize moves by step, the collapsed rail is railWidth. CSS mirrors
 * defaultWidth/railWidth as literals; application-controls.test.ts pins the pair. */
export const DRAWER_STANDING = Object.freeze({
  minWidth: 200,
  defaultWidth: 288,
  maxWidth: 480,
  railWidth: 56,
  keyboardStep: 16,
});

export const APPLICATION_CONTROL_LIMITS = Object.freeze({
  menuItems: 32,
  textCharacters: 128,
  payloadFields: 32,
  payloadDepth: 4,
  payloadWork: 1_024,
  drawerChildren: 1_000,
  drawerDismissThreshold: 120,
});

export type MenuBarItem = Readonly<{
  key: string;
  id: string;
  name: string;
  icon: string;
  iconDeclared: boolean;
  disabled: boolean;
  index: number;
  payload: Dict;
  items: readonly OverlayItem[];
}>;

let applicationSequence = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = cls;
  return element;
}

function boundedText(value: unknown): string {
  // Bound data is untrusted: never invoke Symbol.toPrimitive/toString on objects.
  const primitive = typeof value === "string" ? value
    : typeof value === "number" && Number.isFinite(value) ? String(value)
      : typeof value === "boolean" || typeof value === "bigint" ? String(value)
        : "";
  return Array.from(primitive.substring(0, APPLICATION_CONTROL_LIMITS.textCharacters * 4))
    .slice(0, APPLICATION_CONTROL_LIMITS.textCharacters).join("");
}

type PayloadBudget = { remaining: number };

function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function boundedPayloadValue(value: unknown, depth: number, seen: WeakSet<object>, budget: PayloadBudget): unknown {
  if (depth >= APPLICATION_CONTROL_LIMITS.payloadDepth || budget.remaining <= 0) return null;
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  let array = false;
  try { array = Array.isArray(value); } catch { return null; }
  if (array) {
    const source = value as unknown[];
    if (seen.has(source)) return null;
    seen.add(source);
    const out: unknown[] = [];
    let length = 0;
    try { length = Math.min(source.length, APPLICATION_CONTROL_LIMITS.payloadFields); } catch { return null; }
    for (let index = 0; index < length && budget.remaining > 0; index += 1) {
      budget.remaining -= 1;
      out.push(boundedPayloadValue(ownDataValue(source, String(index)), depth + 1, seen, budget));
    }
    return out;
  }
  let dictionary = false;
  try { dictionary = isDict(value); } catch { return null; }
  if (dictionary) {
    if (seen.has(value as object)) return null;
    seen.add(value as object);
    const out: Dict = {};
    // `for..in` lets us stop at the shared field budget without eagerly creating
    // Object.entries for an attacker-sized object. Accessors are skipped so remote
    // event payload normalization never invokes application getters.
    try {
      let inspected = 0;
      for (const rawKey in value as Dict) {
        if (budget.remaining <= 0 || inspected >= APPLICATION_CONTROL_LIMITS.payloadFields) break;
        inspected += 1;
        budget.remaining -= 1;
        if (!Object.prototype.hasOwnProperty.call(value, rawKey)) continue;
        const key = boundedText(rawKey);
        if (key.length === 0 || key === "__proto__" || key === "constructor" || key === "prototype") continue;
        out[key] = boundedPayloadValue(ownDataValue(value as object, rawKey), depth + 1, seen, budget);
      }
    } catch { /* hostile proxies fail closed to the bounded prefix */ }
    return out;
  }
  return null;
}

/** Normalize remote menu data with a total work cap, deterministic keys and a
 * bounded event payload. Repeated ids remain distinct instead of aliasing DOM. */
export function normalizeMenuBarItems(input: unknown): MenuBarItem[] {
  try {
    if (!Array.isArray(input)) return [];
  } catch { return []; }
  const occurrences = new Map<string, number>();
  const work = { remaining: APPLICATION_CONTROL_LIMITS.payloadWork };
  const result: MenuBarItem[] = [];
  let length = 0;
  try { length = Math.min(input.length, APPLICATION_CONTROL_LIMITS.menuItems); } catch { return result; }
  for (let index = 0; index < length; index += 1) {
    // Do not invoke accessors on untrusted bound arrays. A missing/accessor entry is
    // still represented deterministically as an empty item at its original index.
    const entry = ownDataValue(input, String(index));
    let row: Dict;
    try { row = isDict(entry) ? entry as Dict : { name: entry }; } catch { row = { name: null }; }
    const read = (key: string): unknown => ownDataValue(row as object, key);
    const name = boundedText(read("name") ?? read("label") ?? "");
    const iconRaw = read("icon") ?? read("sf_symbol");
    const icon = boundedText(iconRaw ?? "circle");
    const id = boundedText(read("id") ?? index) || String(index);
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    let rawPayload: unknown = null;
    try { rawPayload = boundedPayloadValue(row, 0, new WeakSet<object>(), work); } catch { /* one hostile row fails closed */ }
    const payload: Dict = isDict(rawPayload) ? rawPayload as Dict : {};
    payload["name"] = name;
    payload["icon"] = icon;
    payload["id"] = id;
    payload["index"] = index;
    // A root's nested `items` become the desktop flyout, normalized by the SAME
    // bounded overlay-item grammar every menu speaks (per-root ledger of
    // OVERLAY_LIMITS.maxItems); compact presentations simply never read them.
    let nested: OverlayItem[] = [];
    try {
      const rawItems = read("items");
      if (rawItems !== undefined && rawItems !== null) nested = normalizeOverlayItems(rawItems);
    } catch { nested = []; }
    result.push(Object.freeze({
      key: `${id}:${occurrence}`,
      id,
      name,
      icon,
      iconDeclared: iconRaw !== undefined && iconRaw !== null && boundedText(iconRaw).trim().length > 0,
      disabled: truthy(read("disabled") ?? false),
      index,
      payload,
      items: nested,
    }));
  }
  return result;
}

export function normalizeMenuBarIndex(value: unknown, count: number, fallback = 0): number {
  const total = Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0));
  if (total === 0) return 0;
  const parsed = number(value);
  const candidate = parsed !== null && parsed !== undefined && Number.isFinite(parsed)
    ? Math.trunc(parsed) : fallback;
  return Math.min(Math.max(candidate, 0), total - 1);
}

export function normalizeMenuBarEnabledIndex(
  items: readonly Pick<MenuBarItem, "disabled">[],
  value: unknown,
  fallback = 0,
  direction: 1 | -1 = 1,
): number | null {
  if (items.length === 0) return null;
  let index = normalizeMenuBarIndex(value, items.length, fallback);
  for (let count = 0; count < items.length; count += 1) {
    if (!items[index]!.disabled) return index;
    index = (index + direction + items.length) % items.length;
  }
  return null;
}

export function normalizeMenuBarTint(value: string): string | null {
  const raw = value.trim();
  const semantic: Readonly<Record<string, string>> = {
    accent: "var(--dsx-accent)",
    label: "var(--dsx-label)",
    text: "var(--dsx-label)",
    secondary: "var(--dsx-secondary-label)",
    tertiary: "var(--dsx-tertiary-label)",
    destructive: "var(--dsx-destructive)",
  };
  if (semantic[raw] !== undefined) return semantic[raw]!;
  if (/^#[0-9a-f]{3}$/i.test(raw) || /^#[0-9a-f]{6}$/i.test(raw)) return raw;
  const argb = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(raw);
  if (argb === null) return null;
  const alpha = Number.parseInt(argb[1]!, 16) / 255;
  const rgb = argb[2]!;
  return `rgb(${Number.parseInt(rgb.slice(0, 2), 16)} ${Number.parseInt(rgb.slice(2, 4), 16)} ${Number.parseInt(rgb.slice(4, 6), 16)} / ${alpha.toFixed(4)})`;
}

function boundedChildren(node: XmlNode): readonly XmlNode[] {
  if (node.children.length > APPLICATION_CONTROL_LIMITS.drawerChildren) {
    console.warn(
      `[dsx dom] <Drawer> has ${node.children.length} children; rendering the first ${APPLICATION_CONTROL_LIMITS.drawerChildren}`,
    );
  }
  return node.children.slice(0, APPLICATION_CONTROL_LIMITS.drawerChildren);
}

export const Drawer: ElementFactory = (node, ctx, api) => {
  const host = el("span", "dsx-application-control-host dsx-drawer-host");
  const layer = el("div", "dsx-drawer-layer");
  const scrim = el("div", "dsx-drawer-scrim");
  const panel = el("section", "dsx-drawer-panel");
  const handle = el("button", "dsx-drawer-handle");
  const collapse = el("button", "dsx-drawer-collapse");
  const resizer = el("div", "dsx-drawer-resizer");
  const content = el("div", "dsx-drawer-content");
  const sequence = ++applicationSequence;

  panel.id = `dsx-drawer-panel-${sequence}`;
  content.id = `dsx-drawer-content-${sequence}`;
  // The mount pipeline writes an authored a11yLabel/aria-label onto this returned
  // host span, and a nameless generic may not carry one (axe aria-prohibited-attr).
  // role=group is the honest wrapper semantic in every state: closed (empty group),
  // open modal (group > dialog), standing (group > complementary).
  host.setAttribute("role", "group");
  layer.setAttribute("role", "presentation");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.tabIndex = -1;
  handle.type = "button";
  handle.setAttribute("aria-label", "Dismiss drawer");
  collapse.type = "button";
  collapse.setAttribute("aria-controls", content.id);
  collapse.appendChild(iconSvg("chevron.left", 18));
  // The drag hairline is the ARIA window-splitter idiom: a focusable vertical
  // separator with a real value, arrow-key steps, Home/End bounds and Enter for
  // the rail toggle.
  resizer.tabIndex = 0;
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("aria-label", "Resize drawer");
  resizer.setAttribute("aria-controls", content.id);
  resizer.setAttribute("aria-valuemin", String(DRAWER_STANDING.minWidth));
  resizer.setAttribute("aria-valuemax", String(DRAWER_STANDING.maxWidth));
  resizer.setAttribute("aria-valuenow", String(DRAWER_STANDING.defaultWidth));
  scrim.setAttribute("aria-hidden", "true");
  api.bindText(node.attrs["a11yLabel"] ?? node.attrs["title"] ?? "Drawer", (value) => {
    panel.setAttribute("aria-label", value.trim() || "Drawer");
  });
  api.children(content, boundedChildren(node));
  panel.append(handle, collapse, content, resizer);
  layer.append(scrim, panel);
  host.appendChild(layer);

  // Drawer speaks `close`; the shared presentation controller speaks `dismiss`.
  // Adapt only the event name so stacking, focus, portals and scroll locking remain
  // exactly the same coordinator used by the other overlay primitives.
  const presentationApi: ElementApi = {
    ...api,
    handler(name, payload) {
      if (name === "dismiss") api.handler("close", payload);
      else api.handler(name, payload);
    },
  };
  let pointer: number | null = null;
  let startY = 0;
  let dragY = 0;
  const resetGesture = (): void => {
    const captured = pointer;
    pointer = null;
    startY = 0;
    dragY = 0;
    if (captured !== null) {
      try {
        if (handle.hasPointerCapture(captured)) handle.releasePointerCapture(captured);
      } catch { /* a detached/lost pointer is already released */ }
    }
    panel.style.removeProperty("--dsx-drawer-drag-y");
    panel.removeAttribute("data-dsx-dragging");
  };
  // The Drawer owns its `present` state because ONE document carries TWO DECLARED
  // presentations: the modal drawer (compact) and the standing drawer pinned in
  // flow at APPLICATION_WIDE_MEDIA. The controller runs only the modal half.
  const wide = typeof matchMedia === "function" ? matchMedia(APPLICATION_WIDE_MEDIA) : null;
  const standing = (): boolean => wide?.matches === true;
  let presented = node.attrs["present"] === undefined;
  let collapsed = false;
  let standingWidth: number = DRAWER_STANDING.defaultWidth;

  const controller = bindPresentation(node, ctx, presentationApi, layer, panel, {
    modal: true,
    bindPresent: false,
    initialFocus: () => handle,
    onClose: resetGesture,
  });

  const measuredWidth = (): number => {
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 ? rect.width : standingWidth;
  };
  const applyWidth = (width: number): void => {
    standingWidth = Math.round(Math.min(Math.max(width, DRAWER_STANDING.minWidth), DRAWER_STANDING.maxWidth));
    host.style.setProperty("--dsx-drawer-standing-width", `${standingWidth}px`);
    resizer.setAttribute("aria-valuenow", String(standingWidth));
  };
  const reflectStanding = (): void => {
    const rail = standing() && collapsed;
    host.setAttribute("data-dsx-collapsed", String(rail));
    collapse.setAttribute("aria-expanded", String(!rail));
    collapse.setAttribute("aria-label", rail ? "Expand drawer" : "Collapse drawer");
    content.hidden = rail;
    handle.hidden = standing();
    collapse.hidden = !standing();
    resizer.hidden = !standing() || rail;
  };
  const reflectPresentation = (): void => {
    const presentation = standing() ? "standing" : "modal";
    host.setAttribute("data-dsx-presentation", presentation);
    layer.setAttribute("data-dsx-presentation", presentation);
    panel.setAttribute("data-dsx-presentation", presentation);
    if (standing()) {
      // A media flip is a presentation swap, not a dismissal: the modal machinery
      // releases silently (no on:close, present= keeps its value) and the same
      // panel stands in flow as a labelled complementary region, never aria-modal.
      if (controller.isOpen()) controller.hide();
      panel.setAttribute("role", "complementary");
      panel.removeAttribute("aria-modal");
      host.setAttribute("data-dsx-open", String(presented));
      layer.hidden = !presented;
      layer.inert = !presented;
      if (presented) layer.removeAttribute("aria-hidden");
      else layer.setAttribute("aria-hidden", "true");
    } else {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      host.removeAttribute("data-dsx-open");
      if (presented && !controller.isOpen()) controller.show();
      else if (!presented && controller.isOpen()) controller.close();
      else if (!controller.isOpen()) {
        layer.hidden = true;
        layer.inert = true;
        layer.setAttribute("aria-hidden", "true");
      }
    }
    reflectStanding();
  };

  collapse.addEventListener("click", () => {
    collapsed = !collapsed;
    reflectStanding();
  });

  let resizePointer: number | null = null;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  const releaseResize = (): void => {
    const captured = resizePointer;
    resizePointer = null;
    if (captured !== null) {
      try {
        if (resizer.hasPointerCapture(captured)) resizer.releasePointerCapture(captured);
      } catch { /* released with the pointer */ }
    }
    host.removeAttribute("data-dsx-resizing");
    panel.removeAttribute("data-dsx-resizing");
  };
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || resizePointer !== null || !standing()) return;
    resizePointer = event.pointerId;
    resizeStartX = event.clientX;
    resizeStartWidth = measuredWidth();
    resizer.setPointerCapture(event.pointerId);
    host.setAttribute("data-dsx-resizing", "true");
    panel.setAttribute("data-dsx-resizing", "true");
    event.preventDefault();
  });
  resizer.addEventListener("pointermove", (event) => {
    if (resizePointer !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      releaseResize();
      return;
    }
    const rtl = getComputedStyle(panel).direction === "rtl";
    applyWidth(resizeStartWidth + ((event.clientX - resizeStartX) * (rtl ? -1 : 1)));
  });
  resizer.addEventListener("pointerup", releaseResize);
  resizer.addEventListener("pointercancel", releaseResize);
  resizer.addEventListener("lostpointercapture", (event) => {
    if (resizePointer === event.pointerId) releaseResize();
  });
  resizer.addEventListener("keydown", (event) => {
    const rtl = getComputedStyle(panel).direction === "rtl";
    const grow = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
    const shrink = event.key === (rtl ? "ArrowRight" : "ArrowLeft");
    if (grow || shrink) {
      event.preventDefault();
      applyWidth(measuredWidth() + (grow ? DRAWER_STANDING.keyboardStep : -DRAWER_STANDING.keyboardStep));
    } else if (event.key === "Home") {
      event.preventDefault();
      applyWidth(DRAWER_STANDING.minWidth);
    } else if (event.key === "End") {
      event.preventDefault();
      applyWidth(DRAWER_STANDING.maxWidth);
    } else if (event.key === "Enter") {
      event.preventDefault();
      collapsed = true;
      reflectStanding();
      collapse.focus({ preventScroll: true });
    }
  });

  scrim.addEventListener("pointerdown", (event) => {
    if (event.target === scrim) controller.dismiss("outside");
  });
  handle.addEventListener("click", (event) => {
    // A keyboard click has detail zero. Pointer taps preserve the native handle's
    // drag-only behavior instead of becoming a surprising one-tap close target.
    if (event.detail === 0) controller.dismiss("handle");
  });

  const finish = (event: PointerEvent, cancelled: boolean): void => {
    if (pointer !== event.pointerId) return;
    const dismiss = !cancelled && dragY > APPLICATION_CONTROL_LIMITS.drawerDismissThreshold;
    resetGesture();
    if (dismiss) controller.dismiss("drag");
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointer !== null) return;
    pointer = event.pointerId;
    startY = event.clientY;
    dragY = 0;
    handle.setPointerCapture(event.pointerId);
    panel.setAttribute("data-dsx-dragging", "true");
  });
  handle.addEventListener("pointermove", (event) => {
    if (pointer !== event.pointerId) return;
    // Firefox can report capture release as a final move with buttons=0 without a
    // pointerup on the captured node. Finish from the last valid drag sample so a
    // lost release cannot strand the panel in its dragging state.
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finish(event, false);
      return;
    }
    dragY = Math.max(0, Math.min(event.clientY - startY, window.innerHeight));
    panel.style.setProperty("--dsx-drawer-drag-y", `${dragY}px`);
  });
  handle.addEventListener("pointerup", (event) => finish(event, false));
  handle.addEventListener("pointercancel", (event) => finish(event, true));
  handle.addEventListener("lostpointercapture", (event) => {
    if (pointer === event.pointerId) resetGesture();
  });
  ctx.disposers.push(resetGesture, releaseResize);

  if (node.attrs["present"] !== undefined) {
    api.bindValue(node.attrs["present"], (value) => {
      presented = truthy(value);
      if (standing()) reflectPresentation();
      else if (presented) controller.show();
      else controller.close();
    });
  }
  if (wide !== null) {
    wide.addEventListener("change", reflectPresentation);
    ctx.disposers.push(() => wide.removeEventListener("change", reflectPresentation));
  }
  reflectPresentation();
  return host;
};

export const MenuBar: ElementFactory = (node, ctx, api) => {
  const root = el("nav", "dsx-menu-bar");
  const list = el("div", "dsx-menu-bar-list");
  const pill = el("span", "dsx-menu-bar-pill");
  // The flyout's portal scope clones its HOME's classes onto a body-level scope, so
  // the layer homes in a neutral display:contents host, never the styled nav itself.
  const flyoutHost = el("span", "dsx-application-control-host dsx-menu-bar-flyout-host");
  const flyoutLayer = el("div", "dsx-floating-layer dsx-menu-layer dsx-menu-bar-flyout-layer");
  const flyoutPanel = el("div", "dsx-floating-panel dsx-menu-panel dsx-menu-bar-flyout");
  const buttons = new Map<string, HTMLButtonElement>();
  let items: MenuBarItem[] = [];
  let selectedValue: unknown;
  let selected: number | null = null;
  let roving: number | null = null;
  let flyoutRoot: number | null = null;
  // Canonical native contract: selected is surface state, not an element attr.
  // Reads fall through the two state namespaces and user activation always creates
  // or updates the top-level value. An authored selected= literal is ignored.
  const selectedReadExpression = "selected ?? vars.selected";
  let measureTicket = 0;
  let disposed = false;
  const requestFrame: (callback: FrameRequestCallback) => number = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame.bind(globalThis)
    : (callback) => {
      queueMicrotask(() => { if (!disposed) callback(Date.now()); });
      return 0;
    };
  const cancelFrame: (handle: number) => void = typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame.bind(globalThis)
    : () => {};

  // The desktop menubar presentation (WAI-ARIA menubar): text roots across a slim
  // strip; a root with nested `items` opens a shadow-3 flyout re-using the SAME
  // menu machinery as <menu>. Compact keeps the pill dock below unchanged.
  const wide = typeof matchMedia === "function" ? matchMedia(APPLICATION_WIDE_MEDIA) : null;
  const bar = (): boolean => wide?.matches === true;

  list.setAttribute("role", "menubar");
  list.setAttribute("aria-orientation", "horizontal");
  pill.setAttribute("aria-hidden", "true");
  flyoutPanel.id = `dsx-menu-bar-flyout-${++applicationSequence}`;
  flyoutPanel.setAttribute("role", "presentation");
  flyoutPanel.tabIndex = -1;
  flyoutLayer.hidden = true;
  flyoutLayer.inert = true;
  flyoutLayer.setAttribute("aria-hidden", "true");
  flyoutLayer.appendChild(flyoutPanel);
  flyoutHost.appendChild(flyoutLayer);
  list.appendChild(pill);
  root.appendChild(list);
  root.appendChild(flyoutHost);
  api.bindText(node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? "Primary navigation", (value) => {
    const label = value.trim() || "Primary navigation";
    root.setAttribute("aria-label", label);
    list.setAttribute("aria-label", label);
  });
  api.bindValue(node.attrs["dark"] ?? "dark ?? vars.dark", (value) => {
    const dark = value === null || value === undefined ? true : truthy(value);
    root.setAttribute("data-dsx-tone", dark ? "dark" : "light");
  });
  const applyTint = (value: unknown): void => {
    const color = normalizeMenuBarTint(string(value));
    if (color === null) root.style.removeProperty("--dsx-menu-bar-tint");
    else root.style.setProperty("--dsx-menu-bar-tint", color);
  };
  api.bindValue(node.attrs["tint"] ?? "tint ?? vars.tint", applyTint);

  const schedulePill = (): void => {
    cancelFrame(measureTicket);
    measureTicket = requestFrame(() => {
      if (disposed) return;
      const button = [...buttons.values()].find((candidate) => candidate.dataset["dsxSelected"] === "true");
      if (button === undefined || button.hidden) {
        pill.hidden = true;
        return;
      }
      const listRect = list.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      pill.hidden = false;
      pill.style.setProperty("--dsx-menu-bar-pill-x", `${buttonRect.left - listRect.left + list.scrollLeft}px`);
      pill.style.setProperty("--dsx-menu-bar-pill-y", `${buttonRect.top - listRect.top + list.scrollTop}px`);
      pill.style.setProperty("--dsx-menu-bar-pill-width", `${buttonRect.width}px`);
      pill.style.setProperty("--dsx-menu-bar-pill-height", `${buttonRect.height}px`);
    });
  };

  const rootButton = (index: number | null): HTMLButtonElement | undefined =>
    index === null ? undefined
      : [...buttons.values()].find((button) => button.dataset["dsxIndex"] === String(index));

  const flyoutPortal = layerPortal(flyoutLayer, ctx);
  let flyoutRender: MenuRender = { first: () => null };
  const flyoutController: PresentationController = {
    show: () => {},
    dismiss: (reason) => closeFlyout(reason === "selection" || reason === "escape"),
    close: () => closeFlyout(false),
    hide: () => closeFlyout(false),
    isOpen: () => flyoutRoot !== null,
  };
  const outsideFlyout = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (flyoutRoot === null || (target !== null && (flyoutPanel.contains(target) || list.contains(target)))) return;
    closeFlyout(false);
  };
  const flyoutKey = (event: KeyboardEvent): void => {
    if (flyoutRoot === null || !isTopLayer(flyoutLayer)) return;
    if (event.key === "Escape") {
      // Escape WALKS UP: deepest open submenu first, then the flyout back to its root.
      event.preventDefault();
      if (!closeDeepestSubmenu(flyoutPanel)) closeFlyout(true);
    } else if (event.key === "Tab") {
      closeFlyout(true);
    }
  };
  const repositionFlyout = (): void => {
    const anchor = rootButton(flyoutRoot);
    if (anchor !== undefined) positionFloating(anchor, flyoutPanel, "top", undefined);
  };
  let flyoutListening = false;
  const attachFlyoutListeners = (): void => {
    if (flyoutListening) return;
    document.addEventListener("pointerdown", outsideFlyout, true);
    document.addEventListener("keydown", flyoutKey, true);
    window.addEventListener("resize", repositionFlyout);
    document.addEventListener("scroll", repositionFlyout, true);
    flyoutListening = true;
  };
  const detachFlyoutListeners = (): void => {
    if (!flyoutListening) return;
    document.removeEventListener("pointerdown", outsideFlyout, true);
    document.removeEventListener("keydown", flyoutKey, true);
    window.removeEventListener("resize", repositionFlyout);
    document.removeEventListener("scroll", repositionFlyout, true);
    flyoutListening = false;
  };
  function closeFlyout(focusRoot: boolean): void {
    if (flyoutRoot === null) return;
    const button = rootButton(flyoutRoot);
    flyoutRoot = null;
    detachFlyoutListeners();
    deactivateLayer(flyoutLayer);
    flyoutLayer.hidden = true;
    flyoutLayer.inert = true;
    flyoutLayer.setAttribute("aria-hidden", "true");
    flyoutPortal.unmount();
    flyoutPanel.replaceChildren();
    flyoutRender = { first: () => null };
    reflect();
    if (focusRoot) button?.focus({ preventScroll: true });
  }
  function presentFlyout(index: number, focus: "first" | "last" | "none"): void {
    const anchor = rootButton(index);
    if (anchor === undefined) return;
    flyoutPanel.replaceChildren();
    flyoutRender = menuLevel(items[index]!.items, () => flyoutController, flyoutPanel);
    reflect();
    positionFloating(anchor, flyoutPanel, "top", undefined);
    if (focus === "none") return;
    if (focus === "first") {
      (flyoutRender.first() ?? flyoutPanel).focus({ preventScroll: true });
      return;
    }
    const enabled = [...flyoutPanel.querySelectorAll<HTMLButtonElement>(
      ":scope > .dsx-menu-level > .dsx-menu-row > .dsx-menu-item:not(:disabled)",
    )];
    (enabled.at(-1) ?? flyoutRender.first() ?? flyoutPanel).focus({ preventScroll: true });
  }
  function openFlyout(index: number, focus: "first" | "last" | "none"): void {
    const item = items[index];
    if (!bar() || item === undefined || item.disabled || item.items.length === 0) return;
    if (flyoutRoot !== null) {
      flyoutRoot = index;
      presentFlyout(index, focus);
      return;
    }
    flyoutRoot = index;
    flyoutLayer.hidden = false;
    flyoutLayer.inert = false;
    flyoutLayer.removeAttribute("aria-hidden");
    reflect();
    queueMicrotask(() => {
      // The root may have hopped before this ran; mount for whichever root is
      // current, and stand down if the flyout closed in between.
      if (flyoutRoot === null) return;
      flyoutPortal.mount();
      if (!activateLayer(flyoutLayer, false)) {
        flyoutRoot = null;
        flyoutLayer.hidden = true;
        flyoutLayer.inert = true;
        flyoutLayer.setAttribute("aria-hidden", "true");
        flyoutPortal.unmount();
        reflect();
        return;
      }
      attachFlyoutListeners();
      presentFlyout(flyoutRoot, focus);
    });
  }
  // Root hop from INSIDE the flyout (WAI-ARIA menubar): an unconsumed ArrowLeft/
  // ArrowRight (leaf item, or leftwards at the top level) moves to the neighbor
  // root, opening its menu when it has one. menuLevel's own submenu keys arrive
  // here either consumed (defaultPrevented) or stopped, so they never double-act.
  flyoutPanel.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || flyoutRoot === null) return;
    const rtl = getComputedStyle(flyoutPanel).direction === "rtl";
    const forward = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
    const backward = event.key === (rtl ? "ArrowRight" : "ArrowLeft");
    if (!forward && !backward) return;
    event.preventDefault();
    event.stopPropagation();
    const direction: 1 | -1 = forward ? 1 : -1;
    const from = flyoutRoot;
    const next = normalizeMenuBarEnabledIndex(items, (from + direction + items.length) % items.length, from, direction);
    if (next === null || next === from) return;
    if (items[next]!.items.length > 0) openFlyout(next, "first");
    else {
      closeFlyout(false);
      rootButton(next)?.focus({ preventScroll: true });
    }
  });

  const reflect = (): void => {
    root.hidden = items.length === 0;
    root.setAttribute("data-dsx-empty", String(items.length === 0));
    selected = normalizeMenuBarEnabledIndex(items, selectedValue, selected ?? 0);
    const enabled = selected !== null;
    const barMode = bar();
    // Dock: the selected item is the tab stop (today's contract). Bar: WAI-ARIA
    // roving tabindex follows the last-focused root, falling back to selection.
    const stop = !barMode ? selected
      : roving !== null && items[roving] !== undefined && !items[roving]!.disabled ? roving
      : selected;
    list.tabIndex = stop !== null ? -1 : 0;
    list.setAttribute("aria-disabled", String(!enabled));
    for (const button of buttons.values()) {
      const index = Number(button.dataset["dsxIndex"] ?? -1);
      const item = items[index];
      const submenu = barMode && item !== undefined && item.items.length > 0;
      const active = !submenu && enabled && index === selected;
      button.tabIndex = index === stop ? 0 : -1;
      button.setAttribute("data-dsx-selected", String(active));
      if (submenu) {
        button.setAttribute("role", "menuitem");
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", String(flyoutRoot === index));
        if (flyoutRoot === index) button.setAttribute("aria-controls", flyoutPanel.id);
        else button.removeAttribute("aria-controls");
        button.removeAttribute("aria-checked");
        button.removeAttribute("aria-current");
      } else {
        button.setAttribute("role", "menuitemradio");
        button.removeAttribute("aria-haspopup");
        button.removeAttribute("aria-expanded");
        button.removeAttribute("aria-controls");
        button.setAttribute("aria-checked", String(active));
        button.setAttribute("aria-current", active ? "page" : "false");
      }
      const icon = button.querySelector<HTMLElement>(".dsx-menu-bar-icon");
      if (icon !== null) icon.hidden = barMode && item !== undefined && !item.iconDeclared;
    }
    schedulePill();
  };

  const activate = (index: number, user: boolean): void => {
    if (items.length === 0 || items[index] === undefined || items[index]!.disabled) return;
    selectedValue = index;
    selected = index;
    reflect();
    if (!user) return;
    api.writeBack("selected", index);
    api.handler("select", items[index]!.payload);
  };

  const reconcile = (value: unknown): void => {
    const hadFocus = list.contains(document.activeElement);
    const focusedKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset["dsxKey"] : undefined;
    items = normalizeMenuBarItems(value);
    const nextKeys = new Set(items.map((item) => item.key));
    for (const [key, button] of buttons) {
      if (nextKeys.has(key)) continue;
      button.remove();
      buttons.delete(key);
    }
    items.forEach((item, index) => {
      let button = buttons.get(item.key);
      if (button === undefined) {
        const created = el("button", "dsx-menu-bar-item");
        button = created;
        created.type = "button";
        created.addEventListener("click", () => {
          const at = Number(created.dataset["dsxIndex"]);
          const current = items[at];
          if (current === undefined || current.disabled) return;
          if (bar() && current.items.length > 0) {
            // A submenu root toggles its flyout; Enter/Space arrive here as native
            // button clicks, which is exactly the menubar open convention.
            if (flyoutRoot === at) closeFlyout(true);
            else openFlyout(at, "first");
            return;
          }
          activate(at, true);
        });
        created.addEventListener("pointerenter", () => {
          // Classic menubar hover: while one flyout is open, pointing at another
          // root moves the open menu (or closes it over a plain root).
          if (!bar() || flyoutRoot === null) return;
          const at = Number(created.dataset["dsxIndex"]);
          if (flyoutRoot === at || items[at]?.disabled !== false) return;
          if ((items[at]?.items.length ?? 0) > 0) openFlyout(at, "none");
          else closeFlyout(false);
        });
        buttons.set(item.key, created);
      }
      button.dataset["dsxKey"] = item.key;
      button.dataset["dsxIndex"] = String(index);
      button.disabled = item.disabled;
      button.setAttribute("aria-disabled", String(item.disabled));
      button.setAttribute("aria-label", item.name || `Item ${index + 1}`);
      const icon = el("span", "dsx-menu-bar-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.appendChild(iconSvg(item.icon, 18));
      const label = el("span", "dsx-menu-bar-label");
      label.textContent = item.name;
      button.replaceChildren(icon, label);
      list.appendChild(button);
    });
    list.prepend(pill);
    reflect();
    if (hadFocus) {
      const keyed = focusedKey === undefined ? undefined : buttons.get(focusedKey);
      const target = keyed?.disabled === false ? keyed
        : [...buttons.values()].find((button) => button.tabIndex === 0);
      (target ?? list).focus({ preventScroll: true });
    }
  };

  api.bindValue(node.attrs["items"] ?? "items ?? vars.items", reconcile);
  api.bindValue(selectedReadExpression, (value) => {
    selectedValue = value;
    reflect();
  });

  list.addEventListener("focusin", (event) => {
    const index = Number((event.target as HTMLElement | null)?.dataset?.["dsxIndex"] ?? Number.NaN);
    if (!Number.isFinite(index) || roving === index) return;
    roving = index;
    if (bar()) reflect();
  });
  list.addEventListener("keydown", (event) => {
    if (items.length === 0) return;
    const rtl = getComputedStyle(list).direction === "rtl";
    const barMode = bar();
    if (barMode && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      // WAI-ARIA menubar: Down opens the focused root's menu on its first item,
      // Up opens it on its last.
      const index = Number((event.target as HTMLElement | null)?.dataset?.["dsxIndex"] ?? Number.NaN);
      const item = Number.isFinite(index) ? items[index] : undefined;
      if (item !== undefined && !item.disabled && item.items.length > 0) {
        event.preventDefault();
        openFlyout(index, event.key === "ArrowUp" ? "last" : "first");
      }
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const forward = event.key === "ArrowRight" ? !rtl : event.key === "ArrowLeft" ? rtl : true;
    const direction: 1 | -1 = forward ? 1 : -1;
    if (barMode) {
      // Bar roots rove FOCUS (selection stays put); an open flyout follows the
      // focused root, per the menubar pattern.
      const current = roving ?? selected ?? 0;
      const next = event.key === "Home" ? normalizeMenuBarEnabledIndex(items, 0, 0, 1)
        : event.key === "End" ? normalizeMenuBarEnabledIndex(items, items.length - 1, items.length - 1, -1)
        : normalizeMenuBarEnabledIndex(items, (current + direction + items.length) % items.length, current, direction);
      event.preventDefault();
      if (next === null) { list.focus({ preventScroll: true }); return; }
      rootButton(next)?.focus();
      if (flyoutRoot !== null && flyoutRoot !== next) {
        if (items[next]!.items.length > 0) openFlyout(next, "none");
        else closeFlyout(false);
      }
      return;
    }
    const next = event.key === "Home" ? normalizeMenuBarEnabledIndex(items, 0, 0, 1)
      : event.key === "End" ? normalizeMenuBarEnabledIndex(items, items.length - 1, items.length - 1, -1)
      : normalizeMenuBarEnabledIndex(
        items,
        selected === null
          ? (direction > 0 ? 0 : items.length - 1)
          : (selected + direction + items.length) % items.length,
        selected ?? 0,
        direction,
      );
    event.preventDefault();
    if (next === null) { list.focus({ preventScroll: true }); return; }
    activate(next, true);
    rootButton(next)?.focus();
  });

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedulePill);
  if (observer !== null) observer.observe(list);
  const directionObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedulePill);
  directionObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["dir"],
    subtree: true,
  });
  directionObserver?.observe(root, {
    attributes: true,
    attributeFilter: ["class", "style", "dir"],
  });
  void document.fonts?.ready.then(() => { if (!disposed) schedulePill(); });
  const reflectPresentation = (): void => {
    root.setAttribute("data-dsx-presentation", bar() ? "bar" : "dock");
    if (!bar()) closeFlyout(false);
    reflect();
  };
  if (wide !== null) {
    wide.addEventListener("change", reflectPresentation);
    ctx.disposers.push(() => wide.removeEventListener("change", reflectPresentation));
  }
  reflectPresentation();
  ctx.disposers.push(() => {
    disposed = true;
    cancelFrame(measureTicket);
    observer?.disconnect();
    directionObserver?.disconnect();
    detachFlyoutListeners();
    if (flyoutRoot !== null) {
      flyoutRoot = null;
      deactivateLayer(flyoutLayer);
      flyoutPortal.unmount();
    }
  });
  return root;
};

export const APPLICATION_CONTROL_ELEMENTS: Readonly<Record<string, ElementFactory>> = Object.freeze({
  Drawer,
  MenuBar,
});

export function registerApplicationControls(): void {
  Object.assign(ELEMENTS, APPLICATION_CONTROL_ELEMENTS);
}

export const APPLICATION_CONTROLS_CSS = `@layer dsx-elements {
  .dsx-application-control-host, .dsx-overlay-portal-scope { display: contents; }
  .dsx-drawer-layer {
    position: fixed;
    inset: 0;
    z-index: calc(var(--dsx-overlay-z-index, 10000) + var(--dsx-overlay-level, 0));
    color: var(--dsx-label);
    font-family: var(--dsx-font);
  }
  .dsx-drawer-layer[hidden] { display: none; }
  .dsx-drawer-layer * { box-sizing: border-box; }
  .dsx-drawer-scrim {
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.32);
    animation: dsx-drawer-fade var(--dsx-dur-base) linear both;
  }
  .dsx-drawer-panel {
    position: absolute;
    inset: auto 0 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: 100%;
    max-height: calc(100dvh - max(8px, env(safe-area-inset-top)));
    overflow: hidden;
    border: var(--dsx-hairline) solid var(--dsx-outline-soft);
    border-bottom: 0;
    border-radius: var(--dsx-drawer-radius, var(--dsx-radius-sheet)) var(--dsx-drawer-radius, var(--dsx-radius-sheet)) 0 0;
    color: var(--dsx-label);
    background: var(--dsx-drawer-surface, var(--dsx-background));
    box-shadow: var(--dsx-shadow-4);
    transform: translateY(var(--dsx-drawer-drag-y, 0));
    transition: transform var(--dsx-dur-base) var(--dsx-ease-spring-soft);
    animation:
      dsx-drawer-rise var(--dsx-dur-slow) var(--dsx-ease-spring-soft) both,
      dsx-drawer-fade var(--dsx-dur-base) linear both;
    overscroll-behavior: contain;
  }
  .dsx-drawer-panel:focus { outline: none; }
  .dsx-drawer-panel[data-dsx-dragging="true"] { transition-duration: 0s; user-select: none; }
  .dsx-drawer-handle {
    appearance: none;
    justify-self: center;
    width: 44px;
    height: 44px;
    margin: 0;
    padding: 19px 4px;
    border: 0;
    border-radius: var(--dsx-radius-full);
    background: transparent;
    touch-action: none;
    cursor: ns-resize;
  }
  .dsx-drawer-handle::after {
    content: "";
    display: block;
    width: 36px;
    height: 5px;
    border-radius: var(--dsx-radius-full);
    background: color-mix(in srgb, var(--dsx-label) 25%, transparent);
    transition: background-color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-drawer-handle:active::after { background: color-mix(in srgb, var(--dsx-label) 45%, transparent); }
  .dsx-drawer-handle:focus-visible {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-accent);
    outline-offset: var(--dsx-focus-ring-offset);
    z-index: 1;
  }
  .dsx-drawer-content {
    display: grid;
    gap: var(--dsx-drawer-content-spacing, 12px);
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 0 max(20px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
  }
  .dsx-drawer-handle[hidden], .dsx-drawer-collapse[hidden], .dsx-drawer-resizer[hidden],
  .dsx-drawer-content[hidden], .dsx-menu-bar-icon[hidden] { display: none; }
  .dsx-drawer-collapse {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    justify-self: end;
    width: 36px;
    height: 36px;
    margin: 10px 10px 2px;
    padding: 0;
    border: 0;
    border-radius: var(--dsx-radius-control);
    color: var(--dsx-secondary-label);
    background: transparent;
    cursor: pointer;
    transition: background-color var(--dsx-dur-fast) var(--dsx-ease), color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-drawer-collapse:focus-visible {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-accent);
    outline-offset: var(--dsx-focus-ring-offset);
    z-index: 1;
  }
  .dsx-drawer-collapse svg { transition: transform var(--dsx-dur-base) var(--dsx-ease); }
  .dsx-drawer-host[data-dsx-collapsed="true"] .dsx-drawer-collapse { justify-self: center; margin-inline: auto; }
  .dsx-drawer-host[data-dsx-collapsed="true"] .dsx-drawer-collapse svg { transform: rotate(180deg); }
  [dir="rtl"] .dsx-drawer-collapse svg { transform: scaleX(-1); }
  [dir="rtl"] .dsx-drawer-host[data-dsx-collapsed="true"] .dsx-drawer-collapse svg { transform: none; }
  .dsx-drawer-resizer {
    position: absolute;
    z-index: 1;
    inset-block: 0;
    inset-inline-end: 0;
    width: 8px;
    cursor: col-resize;
    touch-action: none;
    background: transparent;
  }
  .dsx-drawer-resizer::after {
    content: "";
    position: absolute;
    inset-block: 0;
    inset-inline-end: 0;
    width: 2px;
    background: transparent;
    transition: background-color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-drawer-resizer:focus-visible { outline: none; }
  .dsx-drawer-resizer:focus-visible::after,
  .dsx-drawer-panel[data-dsx-resizing="true"] .dsx-drawer-resizer::after { background: var(--dsx-accent); }

  ` +
// THE STANDING DRAWER (APPLICATION_WIDE_MEDIA, stamped by the factory): the same
// document pins open IN FLOW alongside content - no scrim, no focus trap, honest
// complementary semantics - with a collapse-to-rail control and a drag-hairline
// resize between the exported min/max. Below the step, the modal drawer above
// renders unchanged. Flat premium surface, mirroring the tabs sidebar rail.
`  .dsx-drawer-host[data-dsx-presentation="standing"] {
    display: block;
    position: relative;
    flex: 0 0 auto;
    align-self: stretch;
    width: var(--dsx-drawer-standing-width, 288px);
    min-width: 0;
    min-height: 0;
    transition: width var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-drawer-host[data-dsx-presentation="standing"][data-dsx-resizing="true"] { transition: none; }
  .dsx-drawer-host[data-dsx-presentation="standing"][data-dsx-collapsed="true"] { width: 56px; }
  .dsx-drawer-host[data-dsx-presentation="standing"][data-dsx-open="false"] { display: none; }
  .dsx-drawer-layer[data-dsx-presentation="standing"] {
    position: static;
    inset: auto;
    z-index: auto;
    height: 100%;
  }
  .dsx-drawer-layer[data-dsx-presentation="standing"] .dsx-drawer-scrim { display: none; }
  .dsx-drawer-panel[data-dsx-presentation="standing"] {
    position: relative;
    inset: auto;
    left: auto;
    right: auto;
    bottom: auto;
    width: 100%;
    height: 100%;
    max-height: none;
    border: 0;
    border-inline-end: var(--dsx-hairline) solid var(--dsx-separator);
    border-radius: 0;
    background: var(--dsx-secondary-background);
    box-shadow: none;
    transform: none;
    animation: none;
    transition: none;
  }
  .dsx-drawer-panel[data-dsx-presentation="standing"] .dsx-drawer-content {
    align-content: start;
    padding: 4px 14px max(14px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left));
  }

  .dsx-menu-bar {
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
    min-height: calc(50px + env(safe-area-inset-bottom));
    padding: 0 max(6px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(6px, env(safe-area-inset-left));
    border-top: var(--dsx-hairline) solid color-mix(in srgb, currentColor 14%, transparent);
    font-family: var(--dsx-font);
    color: var(--dsx-menu-bar-label, var(--dsx-background));
    background: var(--dsx-menu-bar-surface, color-mix(in srgb, var(--dsx-label) 94%, var(--dsx-background)));
    -webkit-backdrop-filter: blur(20px) saturate(1.25);
    backdrop-filter: blur(20px) saturate(1.25);
  }
  .dsx-menu-bar[hidden] { display: none; }
  .dsx-menu-bar[data-dsx-tone="light"] {
    color-scheme: light;
    --dsx-menu-bar-label: var(--dsx-menu-bar-light-label, CanvasText);
    --dsx-menu-bar-surface: var(--dsx-menu-bar-light-surface, color-mix(in srgb, Canvas 88%, transparent));
  }
  .dsx-menu-bar[data-dsx-tone="dark"] {
    color-scheme: dark;
    --dsx-menu-bar-label: var(--dsx-menu-bar-dark-label, CanvasText);
    --dsx-menu-bar-surface: var(--dsx-menu-bar-dark-surface, color-mix(in srgb, Canvas 88%, transparent));
  }
  .dsx-menu-bar-list {
    position: relative;
    display: flex;
    align-items: stretch;
    gap: var(--dsx-space-1);
    width: min(100%, 52rem);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .dsx-menu-bar-list::-webkit-scrollbar { display: none; }
  .dsx-menu-bar-pill {
    position: absolute;
    inset: 0 auto auto 0;
    width: var(--dsx-menu-bar-pill-width, 0);
    height: var(--dsx-menu-bar-pill-height, 0);
    border-radius: var(--dsx-radius-full);
    background: color-mix(in srgb, var(--dsx-menu-bar-tint, currentColor) 16%, transparent);
    transform: translate3d(var(--dsx-menu-bar-pill-x, 0), var(--dsx-menu-bar-pill-y, 0), 0);
    transition:
      width var(--dsx-dur-base) var(--dsx-ease),
      height var(--dsx-dur-base) var(--dsx-ease),
      transform var(--dsx-dur-base) var(--dsx-ease-spring);
    pointer-events: none;
  }
  .dsx-menu-bar-item {
    appearance: none;
    position: relative;
    z-index: 1;
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--dsx-space-1);
    min-width: 60px;
    min-height: 50px;
    padding: 5px 10px;
    border: 0;
    border-radius: var(--dsx-radius-full);
    color: color-mix(in srgb, currentColor 66%, transparent);
    background: transparent;
    font: inherit;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition:
      color var(--dsx-dur-fast) var(--dsx-ease),
      background-color var(--dsx-dur-fast) var(--dsx-ease);
  }
  /* the tint anchors to the bar's own label so an authored accent stays legible on
     either tone; with no tint the mix collapses to the plain label color. */
  .dsx-menu-bar-item[data-dsx-selected="true"] {
    color: color-mix(in srgb, var(--dsx-menu-bar-tint, currentColor) 62%, currentColor);
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-menu-bar-item:not(:disabled):hover { background: color-mix(in srgb, currentColor 10%, transparent); }
    .dsx-menu-bar-item:not(:disabled):not([data-dsx-selected="true"]):hover {
      color: color-mix(in srgb, currentColor 88%, transparent);
    }
    .dsx-drawer-handle:hover::after { background: color-mix(in srgb, var(--dsx-label) 40%, transparent); }
    .dsx-drawer-collapse:hover { color: var(--dsx-label); background: var(--dsx-fill); }
    .dsx-drawer-resizer:hover::after { background: var(--dsx-accent); }
  }
  .dsx-menu-bar-item:not(:disabled):active { background: color-mix(in srgb, currentColor 15%, transparent); }
  .dsx-menu-bar-item:disabled { opacity: .45; filter: saturate(.5); cursor: not-allowed; }
  /* the pill dock clips (radius + glass), so the ring stays inset at the shared width */
  .dsx-menu-bar-item:focus-visible {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-menu-bar-tint, currentColor);
    outline-offset: -3px;
    box-shadow: none;
  }
  .dsx-menu-bar-icon {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    transition: transform var(--dsx-dur-slow) var(--dsx-ease-spring);
  }
  .dsx-menu-bar-item[data-dsx-selected="true"] .dsx-menu-bar-icon { transform: scale(1.06); }
  .dsx-menu-bar-icon svg { display: block; }
  .dsx-menu-bar-label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--dsx-type-caption2-size);
    font-weight: var(--dsx-type-headline-weight);
    letter-spacing: var(--dsx-type-caption2-tracking);
    line-height: var(--dsx-type-display-leading);
  }

  ` +
// THE DESKTOP MENU BAR (APPLICATION_WIDE_MEDIA, stamped by the factory): the same
// document renders the WAI-ARIA menubar idiom - a slim start-aligned strip of
// text-first roots whose nested items open shadow-3 flyouts - while compact keeps
// the pill dock above unchanged. The strip is APP CHROME (the toolbar surface
// idiom), so it rides the ambient scheme tokens: the authored dark= tone is the
// floating dock's Liquid-Glass knob and never pins desktop chrome against the
// page's own scheme.
`  .dsx-menu-bar[data-dsx-presentation="bar"] {
    justify-content: flex-start;
    min-height: 40px;
    padding: 0 max(10px, env(safe-area-inset-right)) 0 max(10px, env(safe-area-inset-left));
    border-top: 0;
    border-bottom: var(--dsx-hairline) solid var(--dsx-separator);
    color-scheme: normal;
    color: var(--dsx-label);
    background: color-mix(in srgb, var(--dsx-background) 88%, transparent);
  }
  .dsx-menu-bar[data-dsx-presentation="bar"] .dsx-menu-bar-list {
    justify-content: flex-start;
    align-items: center;
    gap: 2px;
    width: 100%;
    min-width: 0;
  }
  .dsx-menu-bar[data-dsx-presentation="bar"] .dsx-menu-bar-item {
    flex: 0 0 auto;
    flex-direction: row;
    gap: var(--dsx-control-gap);
    min-width: 0;
    min-height: 30px;
    padding: 4px 12px;
    border-radius: var(--dsx-radius-control);
  }
  .dsx-menu-bar[data-dsx-presentation="bar"] .dsx-menu-bar-item[aria-expanded="true"] {
    color: currentColor;
    background: color-mix(in srgb, currentColor 12%, transparent);
  }
  .dsx-menu-bar[data-dsx-presentation="bar"] .dsx-menu-bar-label {
    font-size: var(--dsx-type-callout-size);
    font-weight: var(--dsx-type-label-weight);
    letter-spacing: var(--dsx-type-callout-tracking);
  }

  @media (min-width: 48rem) {
    .dsx-drawer-panel {
      inset-inline: auto;
      left: 50%;
      right: auto;
      bottom: max(16px, env(safe-area-inset-bottom));
      width: min(calc(100vw - 48px), 38rem);
      border-bottom: var(--dsx-hairline) solid var(--dsx-outline-soft);
      border-radius: var(--dsx-drawer-radius, var(--dsx-radius-sheet));
      transform: translate(-50%, var(--dsx-drawer-drag-y, 0));
    }
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-drawer-panel { width: min(calc(100vw - 64px), 32rem); max-height: min(78dvh, 44rem); }
    .dsx-drawer-content { padding-inline: 20px; }
    .dsx-menu-bar { min-height: 44px; padding-block: 3px; }
    .dsx-menu-bar-list { width: fit-content; min-width: min(100%, 28rem); max-width: 100%; }
    .dsx-menu-bar-item {
      flex: 0 1 8rem;
      flex-direction: row;
      gap: var(--dsx-control-gap);
      min-width: 76px;
      min-height: 38px;
      padding: 5px 12px;
    }
    .dsx-menu-bar-label { font-size: var(--dsx-type-caption-size); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-drawer-panel, .dsx-menu-bar-pill, .dsx-menu-bar-item, .dsx-menu-bar-icon, .dsx-drawer-handle::after,
    .dsx-drawer-host[data-dsx-presentation="standing"], .dsx-drawer-collapse, .dsx-drawer-collapse svg,
    .dsx-drawer-resizer::after { transition-duration: 0s; }
    .dsx-drawer-scrim, .dsx-drawer-panel { animation: none; }
  }
  @media (forced-colors: active) {
    .dsx-drawer-scrim { background: rgb(0 0 0 / .6); }
    .dsx-drawer-panel, .dsx-menu-bar { border: 1px solid CanvasText; color: CanvasText; background: Canvas; forced-color-adjust: auto; }
    .dsx-drawer-handle::after { background: CanvasText; }
    .dsx-drawer-resizer::after { background: CanvasText; }
    .dsx-menu-bar-pill { border: 2px solid Highlight; background: transparent; }
    .dsx-drawer-handle:focus-visible, .dsx-menu-bar-item:focus-visible, .dsx-drawer-collapse:focus-visible,
    .dsx-drawer-resizer:focus-visible { outline: 2px solid Highlight; box-shadow: none; }
  }
  @keyframes dsx-drawer-fade { from { opacity: 0; } }
  @keyframes dsx-drawer-rise { from { translate: 0 16px; } }
}`;
