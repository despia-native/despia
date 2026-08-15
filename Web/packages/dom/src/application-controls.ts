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
import { bindPresentation } from "./overlay-controls.ts";

export const APPLICATION_CONTROL_TAGS: ReadonlySet<string> = new Set(["Drawer", "MenuBar"]);

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
  disabled: boolean;
  index: number;
  payload: Dict;
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
    const icon = boundedText(read("icon") ?? read("sf_symbol") ?? "circle");
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
    result.push(Object.freeze({
      key: `${id}:${occurrence}`,
      id,
      name,
      icon,
      disabled: truthy(read("disabled") ?? false),
      index,
      payload,
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
  const content = el("div", "dsx-drawer-content");
  const sequence = ++applicationSequence;

  panel.id = `dsx-drawer-panel-${sequence}`;
  layer.setAttribute("role", "presentation");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.tabIndex = -1;
  handle.type = "button";
  handle.setAttribute("aria-label", "Dismiss drawer");
  scrim.setAttribute("aria-hidden", "true");
  api.bindText(node.attrs["a11yLabel"] ?? node.attrs["title"] ?? "Drawer", (value) => {
    panel.setAttribute("aria-label", value.trim() || "Drawer");
  });
  api.children(content, boundedChildren(node));
  panel.append(handle, content);
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
  const controller = bindPresentation(node, ctx, presentationApi, layer, panel, {
    modal: true,
    initialFocus: () => handle,
    onClose: resetGesture,
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
  ctx.disposers.push(resetGesture);

  if (node.attrs["present"] === undefined) controller.show();
  return host;
};

export const MenuBar: ElementFactory = (node, ctx, api) => {
  const root = el("nav", "dsx-menu-bar");
  const list = el("div", "dsx-menu-bar-list");
  const pill = el("span", "dsx-menu-bar-pill");
  const buttons = new Map<string, HTMLButtonElement>();
  let items: MenuBarItem[] = [];
  let selectedValue: unknown;
  let selected: number | null = null;
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

  list.setAttribute("role", "menubar");
  list.setAttribute("aria-orientation", "horizontal");
  pill.setAttribute("aria-hidden", "true");
  list.appendChild(pill);
  root.appendChild(list);
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

  const reflect = (): void => {
    root.hidden = items.length === 0;
    root.setAttribute("data-dsx-empty", String(items.length === 0));
    selected = normalizeMenuBarEnabledIndex(items, selectedValue, selected ?? 0);
    const enabled = selected !== null;
    list.tabIndex = enabled ? -1 : 0;
    list.setAttribute("aria-disabled", String(!enabled));
    for (const button of buttons.values()) {
      const index = Number(button.dataset["dsxIndex"] ?? -1);
      const active = enabled && index === selected;
      button.setAttribute("aria-checked", String(active));
      button.setAttribute("aria-current", active ? "page" : "false");
      button.setAttribute("data-dsx-selected", String(active));
      button.tabIndex = active ? 0 : -1;
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
        button = el("button", "dsx-menu-bar-item");
        button.type = "button";
        button.setAttribute("role", "menuitemradio");
        button.addEventListener("click", () => activate(Number(button!.dataset["dsxIndex"]), true));
        buttons.set(item.key, button);
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

  list.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || items.length === 0) return;
    const rtl = getComputedStyle(list).direction === "rtl";
    const forward = event.key === "ArrowRight" ? !rtl : event.key === "ArrowLeft" ? rtl : true;
    const direction = forward ? 1 : -1;
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
    [...buttons.values()].find((button) => button.dataset["dsxIndex"] === String(next))?.focus();
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
  ctx.disposers.push(() => {
    disposed = true;
    cancelFrame(measureTicket);
    observer?.disconnect();
    directionObserver?.disconnect();
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
  .dsx-drawer-scrim { position: absolute; inset: 0; background: rgb(0 0 0 / .44); }
  .dsx-drawer-panel {
    position: absolute;
    inset: auto 0 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: 100%;
    max-height: calc(100dvh - max(8px, env(safe-area-inset-top)));
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--dsx-separator) 88%, transparent);
    border-bottom: 0;
    border-radius: var(--dsx-drawer-radius, 24px) var(--dsx-drawer-radius, 24px) 0 0;
    color: var(--dsx-label);
    background: var(--dsx-drawer-surface, var(--dsx-background));
    transform: translateY(var(--dsx-drawer-drag-y, 0));
    transition: transform 220ms cubic-bezier(.2,.8,.2,1);
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
    background: transparent;
    touch-action: none;
    cursor: ns-resize;
  }
  .dsx-drawer-handle::after {
    content: "";
    display: block;
    width: 36px;
    height: 5px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--dsx-label) 25%, transparent);
  }
  .dsx-drawer-handle:focus-visible { outline: 2px solid var(--dsx-accent); outline-offset: 2px; border-radius: 999px; }
  .dsx-drawer-content {
    display: grid;
    gap: var(--dsx-drawer-content-spacing, 12px);
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 0 max(20px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
  }

  .dsx-menu-bar {
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
    min-height: calc(50px + env(safe-area-inset-bottom));
    padding: 0 max(6px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(6px, env(safe-area-inset-left));
    color: var(--dsx-menu-bar-label, var(--dsx-background));
    background: var(--dsx-menu-bar-surface, color-mix(in srgb, var(--dsx-label) 94%, var(--dsx-background)));
  }
  .dsx-menu-bar[hidden] { display: none; }
  .dsx-menu-bar[data-dsx-tone="light"] {
    color-scheme: light;
    --dsx-menu-bar-label: var(--dsx-menu-bar-light-label, CanvasText);
    --dsx-menu-bar-surface: var(--dsx-menu-bar-light-surface, Canvas);
  }
  .dsx-menu-bar[data-dsx-tone="dark"] {
    color-scheme: dark;
    --dsx-menu-bar-label: var(--dsx-menu-bar-dark-label, CanvasText);
    --dsx-menu-bar-surface: var(--dsx-menu-bar-dark-surface, Canvas);
  }
  .dsx-menu-bar-list {
    position: relative;
    display: flex;
    align-items: stretch;
    gap: 4px;
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
    border-radius: 999px;
    background: color-mix(in srgb, var(--dsx-menu-bar-tint, currentColor) 16%, transparent);
    transform: translate3d(var(--dsx-menu-bar-pill-x, 0), var(--dsx-menu-bar-pill-y, 0), 0);
    transition: width 240ms cubic-bezier(.2,.8,.2,1), height 240ms cubic-bezier(.2,.8,.2,1), transform 240ms cubic-bezier(.2,.8,.2,1);
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
    gap: 3px;
    min-width: 60px;
    min-height: 50px;
    padding: 4px 8px;
    border: 0;
    border-radius: 999px;
    color: color-mix(in srgb, currentColor 62%, transparent);
    background: transparent;
    font: inherit;
    cursor: pointer;
  }
  .dsx-menu-bar-item[data-dsx-selected="true"] { color: currentColor; }
  .dsx-menu-bar-item:disabled { opacity: .42; cursor: default; }
  .dsx-menu-bar-item:focus-visible { outline: 2px solid var(--dsx-menu-bar-tint, var(--dsx-accent)); outline-offset: -3px; }
  .dsx-menu-bar-icon { display: grid; place-items: center; width: 18px; height: 18px; }
  .dsx-menu-bar-icon svg { display: block; }
  .dsx-menu-bar-label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: .625rem;
    font-weight: 560;
    line-height: 1.1;
  }

  @media (min-width: 48rem) {
    .dsx-drawer-panel {
      inset-inline: auto;
      left: 50%;
      right: auto;
      bottom: max(16px, env(safe-area-inset-bottom));
      width: min(calc(100vw - 48px), 38rem);
      border-bottom: 1px solid color-mix(in srgb, var(--dsx-separator) 88%, transparent);
      border-radius: var(--dsx-drawer-radius, 24px);
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
      min-width: 76px;
      min-height: 38px;
      padding: 5px 12px;
    }
    .dsx-menu-bar-label { font-size: .75rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-drawer-panel, .dsx-menu-bar-pill { transition-duration: 0s; }
  }
  @media (forced-colors: active) {
    .dsx-drawer-scrim { background: rgb(0 0 0 / .6); }
    .dsx-drawer-panel, .dsx-menu-bar { border: 1px solid CanvasText; color: CanvasText; background: Canvas; forced-color-adjust: auto; }
    .dsx-menu-bar-pill { border: 2px solid Highlight; background: transparent; }
    .dsx-drawer-handle:focus-visible, .dsx-menu-bar-item:focus-visible { outline-color: Highlight; }
  }
}`;
