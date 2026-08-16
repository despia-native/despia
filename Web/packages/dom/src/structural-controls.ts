//
//  structural-controls.ts - semantic browser twins for DSX's high-value
//  structure primitives. Layout chrome lives in the weak dsx-elements layer;
//  factories only stamp semantics, reactive values and interaction state so an
//  authored .dsx class or sheet remains the final visual authority.
//

import { number } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { MountCtx } from "./mount.ts";
import { ELEMENTS, createMarquee, iconSvg, type ElementApi, type ElementFactory } from "./elements.ts";

export const STRUCTURAL_CONTROL_TAGS: ReadonlySet<string> = new Set([
  "flow", "toolbar", "list", "grid", "pager", "tabs", "tabview", "carousel",
]);
export const STRUCTURAL_CHILD_LIMIT = 1_000;

let structuralSequence = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = cls;
  return element;
}

function finite(value: unknown, fallback: number): number {
  const parsed = number(value);
  return parsed !== null && parsed !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

/** Native structure flags are opt-out words (`dots != "false"`,
 * `scroll != "false"`), not JavaScript string truthiness. */
function enabledUnlessFalse(value: unknown): boolean {
  return String(value).trim().toLowerCase() !== "false";
}

function boundedChildren(node: XmlNode): readonly XmlNode[] {
  if (node.children.length > STRUCTURAL_CHILD_LIMIT) {
    console.warn(
      `[dsx dom] <${node.tag}> has ${node.children.length} children; rendering the first ${STRUCTURAL_CHILD_LIMIT}`,
    );
  }
  return node.children.slice(0, STRUCTURAL_CHILD_LIMIT);
}

/** Indices are always integral and clamped to a real child. Empty structures
 * retain index zero as their inert state, matching the native Int binding floor. */
export function normalizeStructuralIndex(value: unknown, count: number, fallback = 0): number {
  const safeCount = Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0));
  if (safeCount === 0) return 0;
  return Math.min(Math.max(Math.trunc(finite(value, fallback)), 0), safeCount - 1);
}

/** CSS gaps cannot represent SwiftUI's negative-spacing overlap. Keep remote or
 * malformed values finite and non-negative; authors can still opt into overlap
 * explicitly with ordinary CSS transforms/margins. */
export function normalizeStructuralGap(value: unknown, fallback: number): number {
  return Math.min(Math.max(finite(value, fallback), 0), 16_384);
}

function bindLength(
  node: XmlNode,
  api: ElementApi,
  name: string,
  fallback: number,
  root: HTMLElement,
  property: string,
): void {
  const expression = node.attrs[name];
  if (expression === undefined) return;
  api.bindText(expression, (value) => {
    root.style.setProperty(property, `${normalizeStructuralGap(value, fallback)}px`);
  });
}

export const flow: ElementFactory = (node, _ctx, api) => {
  const root = el("div", "dsx-flow");
  bindLength(node, api, "spacing", 8, root, "--dsx-flow-spacing");
  bindLength(node, api, "lineSpacing", 8, root, "--dsx-flow-line-spacing");
  api.children(root, boundedChildren(node));
  return root;
};

const TOOLBAR_FOCUSABLE = [
  "button:not([disabled])", "a[href]", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export const toolbar: ElementFactory = (node, _ctx, api) => {
  const root = el("div", "dsx-toolbar");
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-orientation", "horizontal");
  if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined) {
    root.setAttribute("aria-label", "Toolbar");
  }
  bindLength(node, api, "spacing", 12, root, "--dsx-toolbar-spacing");
  api.bindText(node.attrs["position"] ?? "bottom", (value) => {
    root.setAttribute("data-dsx-position", value === "top" ? "top" : "bottom");
  });
  api.children(root, boundedChildren(node));

  // WAI-ARIA toolbar keyboard convention: Tab enters/leaves the group; arrows,
  // Home and End move within it without activating a control.
  root.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const controls = [...root.querySelectorAll<HTMLElement>(TOOLBAR_FOCUSABLE)]
      .filter((control) => !control.hidden && control.getAttribute("aria-hidden") !== "true");
    if (controls.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const current = Math.max(0, controls.indexOf(active ?? controls[0]!));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? controls.length - 1
      : event.key === "ArrowRight" ? (current + 1) % controls.length
      : (current - 1 + controls.length) % controls.length;
    event.preventDefault();
    controls[next]?.focus();
  });
  return root;
};

function bindCollectionAxis(
  node: XmlNode,
  api: ElementApi,
  root: HTMLElement,
  onAxis: (horizontal: boolean) => void = () => {},
): void {
  const expression = node.attrs["axis"] ?? node.attrs["direction"] ?? "vertical";
  api.bindText(expression, (value) => {
    const horizontal = value === "horizontal";
    root.setAttribute("data-dsx-axis", horizontal ? "horizontal" : "vertical");
    onAxis(horizontal);
  });
}

function collection(node: XmlNode, api: ElementApi, kind: "list" | "grid"): HTMLElement {
  const root = el("div", kind === "grid" ? "dsx-list dsx-grid" : "dsx-list");
  root.setAttribute("role", kind);
  root.setAttribute("data-dsx-component", kind);
  if (kind === "list") root.setAttribute("data-dsx-appearance", "automatic");
  let columns = 3;
  const cells: HTMLElement[] = [];
  const layoutGrid = (): void => {
    if (kind !== "grid") return;
    const groups: HTMLElement[] = [];
    for (let start = 0; start < cells.length; start += columns) {
      const row = el("div", "dsx-grid-aria-row");
      row.setAttribute("role", "row");
      row.setAttribute("aria-rowindex", String(Math.floor(start / columns) + 1));
      cells.slice(start, start + columns).forEach((cell, offset) => {
        cell.setAttribute("aria-colindex", String(offset + 1));
        row.appendChild(cell);
      });
      groups.push(row);
    }
    root.replaceChildren(...groups);
    root.setAttribute("aria-rowcount", String(Math.ceil(cells.length / columns)));
  };
  // `autoscroll="N"` (pts/sec) turns a horizontal rail into the looping marquee — the
  // same driver the bound reconciler uses, reached through the base element module.
  let axisHorizontal = false;
  let syncMarquee: () => void = () => {};
  bindCollectionAxis(node, api, root, (horizontal) => { axisHorizontal = horizontal; syncMarquee(); });
  if (kind === "list" && node.attrs["autoscroll"] !== undefined) {
    const marquee = createMarquee(root, () => axisHorizontal);
    syncMarquee = marquee.sync;
    api.bindText(node.attrs["autoscroll"], (value) => { marquee.setSpeed(value); });
  }
  bindLength(node, api, "spacing", kind === "grid" ? 10 : 0, root, "--dsx-collection-spacing");
  api.bindText(node.attrs["scroll"] ?? "true", (value) => {
    root.setAttribute("data-dsx-scroll", enabledUnlessFalse(value) ? "true" : "false");
  });
  api.bindText(node.attrs["align"] ?? "leading", (value) => {
    root.setAttribute(
      "data-dsx-align",
      value === "center" || value === "trailing" ? value : "leading",
    );
  });
  if (kind === "grid") {
    root.setAttribute("aria-colcount", "3");
    if (node.attrs["columns"] !== undefined) {
      api.bindText(node.attrs["columns"], (value) => {
        columns = Math.min(Math.max(Math.trunc(finite(value, 3)), 1), 256);
        root.style.setProperty("--dsx-grid-columns", String(columns));
        root.setAttribute("aria-colcount", String(columns));
        layoutGrid();
      });
    }
  }
  boundedChildren(node).forEach((child) => {
    const row = el("div", "dsx-row dsx-collection-row");
    row.setAttribute("data-dsx-part", "row");
    row.setAttribute("role", kind === "grid" ? "gridcell" : "listitem");
    api.children(row, [child]);
    cells.push(row);
    if (kind === "list") root.appendChild(row);
  });
  layoutGrid();
  return root;
}

export const list: ElementFactory = (node, _ctx, api) => collection(node, api, "list");
export const grid: ElementFactory = (node, _ctx, api) => collection(node, api, "grid");

function addTabIcon(host: HTMLElement, expression: string, api: ElementApi): void {
  api.bindText(expression, (value) => {
    host.replaceChildren();
    if (value.trim().length > 0) host.appendChild(iconSvg(value.trim(), 20));
  });
}

export const tabs: ElementFactory = (node, _ctx, api) => {
  const root = el("div", "dsx-tabs");
  const panels = el("div", "dsx-tab-panels");
  const tablist = el("div", "dsx-tablist");
  const instance = ++structuralSequence;
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", node.attrs["a11yLabel"] ?? "Tabs");

  const buttons: HTMLButtonElement[] = [];
  const panelElements: HTMLElement[] = [];
  const children = boundedChildren(node);
  children.forEach((child, index) => {
    const tab = el("button", "dsx-tab") as HTMLButtonElement;
    const panel = el("div", "dsx-tab-panel");
    const tabId = `dsx-tab-${instance}-${index}`;
    const panelId = `dsx-tab-panel-${instance}-${index}`;
    tab.type = "button";
    tab.id = tabId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId);
    panel.id = panelId;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tabId);

    const iconExpression = child.attrs["tabIcon"];
    if (iconExpression !== undefined) {
      const icon = el("span", "dsx-tab-icon");
      icon.setAttribute("aria-hidden", "true");
      addTabIcon(icon, iconExpression, api);
      tab.appendChild(icon);
    }
    const label = el("span", "dsx-tab-label");
    api.bindText(child.attrs["tabTitle"] ?? `Tab ${index + 1}`, (value) => {
      label.textContent = value.length > 0 ? value : `Tab ${index + 1}`;
    });
    tab.appendChild(label);
    if (child.attrs["tabBadge"] !== undefined) {
      const badge = el("span", "dsx-tab-badge");
      badge.setAttribute("aria-label", "Notifications");
      api.bindText(child.attrs["tabBadge"], (value) => {
        badge.textContent = value;
        badge.hidden = value.length === 0;
      });
      tab.appendChild(badge);
    }
    api.children(panel, [child]);
    tablist.appendChild(tab);
    panels.appendChild(panel);
    buttons.push(tab);
    panelElements.push(panel);
  });
  root.append(panels, tablist);

  let selected = 0;
  const reflect = (): void => {
    buttons.forEach((button, index) => {
      const active = index === selected;
      button.setAttribute("aria-selected", String(active));
      button.setAttribute("data-dsx-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      const panel = panelElements[index]!;
      panel.hidden = !active;
      panel.inert = !active;
      if (active) panel.removeAttribute("aria-hidden");
      else panel.setAttribute("aria-hidden", "true");
    });
  };
  const select = (value: unknown, user: boolean): void => {
    const next = normalizeStructuralIndex(value, buttons.length, selected);
    if (next === selected) { reflect(); return; }
    selected = next;
    reflect();
    if (user) {
      if (node.attrs["value"] !== undefined) api.writeBack(node.attrs["value"], next);
      api.handler("change", { value: next });
    }
  };
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select(index, true));
    button.addEventListener("keydown", (event) => {
      const next = event.key === "Home" ? 0
        : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowRight" ? (index + 1) % buttons.length
        : event.key === "ArrowLeft" ? (index - 1 + buttons.length) % buttons.length
        : null;
      if (next === null) return;
      event.preventDefault();
      select(next, true);
      buttons[next]?.focus();
    });
  });
  if (node.attrs["value"] !== undefined) api.bindValue(node.attrs["value"], (value) => select(value, false));
  reflect();
  return root;
};

function paged(node: XmlNode, ctx: MountCtx, api: ElementApi, kind: "pager" | "carousel"): HTMLElement {
  const root = el("section", `dsx-paged dsx-${kind}`);
  const viewport = el("div", "dsx-paged-viewport");
  const track = el("div", "dsx-paged-track");
  const dots = el("div", "dsx-paged-dots");
  root.setAttribute("role", "region");
  root.setAttribute("aria-roledescription", "carousel");
  root.setAttribute("aria-label", node.attrs["a11yLabel"] ?? (kind === "carousel" ? "Carousel" : "Pager"));
  viewport.tabIndex = 0;
  viewport.setAttribute("dir", "ltr");
  viewport.setAttribute("aria-live", "off");
  dots.setAttribute("dir", "ltr");
  dots.setAttribute("role", "group");
  dots.setAttribute("aria-label", "Choose slide");

  const pages: HTMLElement[] = [];
  const dotButtons: HTMLButtonElement[] = [];
  const children = boundedChildren(node);
  children.forEach((child, index) => {
    const page = el("div", "dsx-paged-page");
    page.setAttribute("role", "group");
    page.setAttribute("aria-roledescription", "slide");
    page.setAttribute("aria-label", `${index + 1} of ${children.length}`);
    api.children(page, [child]);
    track.appendChild(page);
    pages.push(page);

    const dot = el("button", "dsx-paged-dot") as HTMLButtonElement;
    dot.type = "button";
    dot.setAttribute("aria-label", `Go to slide ${index + 1}`);
    dots.appendChild(dot);
    dotButtons.push(dot);
  });
  viewport.appendChild(track);
  root.append(viewport, dots);

  let axis: "horizontal" | "vertical" = "horizontal";
  let selected = 0;
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
    pages.forEach((page, index) => {
      const active = index === selected;
      page.inert = !active;
      if (active) page.removeAttribute("aria-hidden");
      else page.setAttribute("aria-hidden", "true");
    });
    dotButtons.forEach((dot, index) => {
      const active = index === selected;
      dot.setAttribute("aria-current", active ? "true" : "false");
      dot.setAttribute("data-dsx-selected", String(active));
    });
    root.setAttribute("data-dsx-page", String(selected));
  };
  const select = (value: unknown, user: boolean, move = true): void => {
    const next = normalizeStructuralIndex(value, pages.length, selected);
    if (next === selected) { reflect(); if (move) align(); return; }
    selected = next;
    reflect();
    if (move) align();
    if (user) {
      if (node.attrs["value"] !== undefined) api.writeBack(node.attrs["value"], next);
      api.handler("change", { value: next });
    }
  };

  dotButtons.forEach((dot, index) => dot.addEventListener("click", () => select(index, true)));
  viewport.addEventListener("keydown", (event) => {
    const rtl = typeof getComputedStyle === "function" && getComputedStyle(root).direction === "rtl";
    const next = event.key === "Home" ? 0
      : event.key === "End" ? pages.length - 1
      : axis === "horizontal" && event.key === "ArrowRight" ? selected + (rtl ? -1 : 1)
      : axis === "horizontal" && event.key === "ArrowLeft" ? selected + (rtl ? 1 : -1)
      : axis === "vertical" && event.key === "ArrowDown" ? selected + 1
      : axis === "vertical" && event.key === "ArrowUp" ? selected - 1
      : null;
    if (next === null) return;
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
  ctx.disposers.push(() => { if (settleTimer !== null) clearTimeout(settleTimer); });

  api.bindText(kind === "pager" ? node.attrs["axis"] ?? "horizontal" : "horizontal", (value) => {
    axis = value === "vertical" ? "vertical" : "horizontal";
    root.setAttribute("data-dsx-axis", axis);
    align();
  });
  api.bindText(node.attrs["dots"] ?? "true", (value) => { dots.hidden = !enabledUnlessFalse(value); });
  if (kind === "carousel") {
    root.setAttribute("data-dsx-peek", "false");
    if (node.attrs["peek"] !== undefined) {
      api.bindText(node.attrs["peek"], (value) => {
        const peek = normalizeStructuralGap(value, 0);
        root.style.setProperty("--dsx-carousel-peek", `${peek}px`);
        root.setAttribute("data-dsx-peek", peek > 0 ? "true" : "false");
      });
    }
    bindLength(node, api, "spacing", 12, root, "--dsx-carousel-spacing");
  }
  if (node.attrs["value"] !== undefined) api.bindValue(node.attrs["value"], (value) => select(value, false));
  reflect();
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(align);
    observer.observe(viewport);
    ctx.disposers.push(() => observer.disconnect());
  }
  return root;
}

export const pager: ElementFactory = (node, ctx, api) => paged(node, ctx, api, "pager");
export const carousel: ElementFactory = (node, ctx, api) => paged(node, ctx, api, "carousel");

export const STRUCTURAL_CONTROL_ELEMENTS: Readonly<Record<string, ElementFactory>> = {
  flow,
  toolbar,
  list,
  grid,
  pager,
  tabs,
  tabview: tabs,
  carousel,
};

export function registerStructuralControls(): void {
  Object.assign(ELEMENTS, STRUCTURAL_CONTROL_ELEMENTS);
}

export const STRUCTURAL_CONTROLS_CSS = `@layer dsx-elements {
  .dsx-flow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    min-width: 0;
    gap: var(--dsx-flow-line-spacing, 8px) var(--dsx-flow-spacing, 8px);
  }

  .dsx-toolbar {
    display: flex;
    align-items: center;
    gap: var(--dsx-toolbar-spacing, 12px);
    min-width: 0;
    min-height: 44px;
    padding: 10px max(16px, env(safe-area-inset-left));
    color: var(--dsx-label);
    background: color-mix(in srgb, var(--dsx-background) 86%, transparent);
    -webkit-backdrop-filter: blur(18px) saturate(1.2);
    backdrop-filter: blur(18px) saturate(1.2);
  }
  .dsx-toolbar[data-dsx-position="bottom"] { border-top: 1px solid var(--dsx-separator); }
  .dsx-toolbar[data-dsx-position="top"] { border-bottom: 1px solid var(--dsx-separator); }

  .dsx-list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-width: 0;
    min-height: 0;
    gap: var(--dsx-collection-spacing, 0px);
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .dsx-list[data-dsx-axis="horizontal"], .dsx-list.dsx-scroll-x {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .dsx-list[data-dsx-scroll="false"] { overflow: visible; }
  .dsx-list[data-dsx-align="leading"] { align-items: flex-start; }
  .dsx-list[data-dsx-align="center"] { align-items: center; }
  .dsx-list[data-dsx-align="trailing"] { align-items: flex-end; }
  .dsx-list > .dsx-row { min-width: 0; }
  .dsx-list[data-dsx-axis="horizontal"] > .dsx-row, .dsx-scroll-x > .dsx-row { flex: 0 0 auto; }
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"],
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]),
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"]:has(> .dsx-row > .dsx-settings-row) {
    --dsx-list-row-height: 48px;
    --dsx-list-padding-inline: 16px;
    --dsx-list-separator-inset: 16px;
    overflow: hidden auto;
    border-radius: var(--dsx-radius-lg);
    background: var(--dsx-surface-raised);
    box-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 0 var(--dsx-inner-highlight);
  }
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"] > .dsx-row,
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]) > .dsx-row,
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"]:has(> .dsx-row > .dsx-settings-row) > .dsx-row {
    position: relative;
    display: flex;
    align-items: stretch;
    width: 100%;
    min-height: var(--dsx-list-row-height);
  }
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"]:not(:has(> .dsx-row > .dsx-settings-row)) > .dsx-row + .dsx-row::before {
    content: "";
    position: absolute;
    z-index: 1;
    inset: 0 0 auto var(--dsx-list-separator-inset);
    height: var(--dsx-hairline);
    background: var(--dsx-outline-soft);
    pointer-events: none;
  }
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]) > .dsx-row + .dsx-row::before {
    content: "";
    position: absolute;
    z-index: 1;
    inset: 0 0 auto var(--dsx-list-separator-inset);
    height: var(--dsx-hairline);
    background: var(--dsx-outline-soft);
    pointer-events: none;
  }
  [dir="rtl"] .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"]:not(:has(> .dsx-row > .dsx-settings-row)) > .dsx-row + .dsx-row::before {
    inset: 0 var(--dsx-list-separator-inset) auto 0;
  }
  [dir="rtl"] .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]) > .dsx-row + .dsx-row::before {
    inset: 0 var(--dsx-list-separator-inset) auto 0;
  }
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"] > .dsx-row > .dsx-pressable:not(.dsx-settings-row) {
    width: 100%;
    min-height: var(--dsx-list-row-height);
    padding-inline: var(--dsx-list-padding-inline);
    border-radius: 0;
  }
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]) > .dsx-row > .dsx-pressable:not(.dsx-settings-row) {
    width: 100%;
    min-height: var(--dsx-list-row-height);
    padding-inline: var(--dsx-list-padding-inline);
    border-radius: 0;
  }
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"] > .dsx-row > :not(.dsx-pressable) {
    width: 100%;
    padding: 0.625rem var(--dsx-list-padding-inline);
  }
  .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]) > .dsx-row > :not(.dsx-pressable) {
    width: 100%;
    padding: 0.625rem var(--dsx-list-padding-inline);
  }
  /* the LIST CONSTRUCTS — sections (group_by), the swipe rails, the reorder handle */
  .dsx-list-section { display: flex; flex-direction: column; min-width: 0; }
  .dsx-list-section-header {
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 6px var(--dsx-list-padding-inline, 16px);
    color: var(--dsx-secondary-label);
    background: color-mix(in srgb, var(--dsx-background) 92%, transparent);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    font-size: .8125rem;
    font-weight: 600;
    text-transform: none;
  }
  .dsx-list-section-header:empty { display: none; }
  .dsx-row-constructs { display: block; min-width: 0; }
  .dsx-list-row {
    position: relative;
    display: flex;
    align-items: stretch;
    min-width: 0;
    overflow: hidden;
  }
  .dsx-list-row-content {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
    background: inherit;
    touch-action: pan-y;
    transform: translateX(var(--dsx-swipe-offset, 0px));
    transition: transform 180ms ease;
  }
  .dsx-list-row[data-dsx-swipe="dragging"] > .dsx-list-row-content { transition: none; }
  .dsx-list-actions {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: stretch;
  }
  .dsx-list-actions[hidden] { display: none; }
  .dsx-list-actions-leading { inset-inline-start: 0; transform: translateX(-100%); }
  .dsx-list-actions-trailing { inset-inline-end: 0; transform: translateX(100%); }
  .dsx-list-action {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 72px;
    padding: 0 14px;
    border: 0;
    color: var(--dsx-background);
    background: var(--dsx-list-action-tint, var(--dsx-fill-strong, var(--dsx-secondary-label)));
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .dsx-list-action[data-dsx-role="destructive"] { background: var(--dsx-list-action-tint, var(--dsx-destructive)); }
  .dsx-list-action:focus-visible { outline: 2px solid currentColor; outline-offset: -3px; }
  .dsx-list-reorder {
    appearance: none;
    flex: none;
    width: 32px;
    align-self: stretch;
    padding: 0;
    border: 0;
    color: var(--dsx-secondary-label);
    background: transparent;
    cursor: grab;
    touch-action: none;
  }
  .dsx-list-reorder[hidden] { display: none; }
  .dsx-list-reorder::before {
    content: "";
    display: block;
    width: 16px;
    height: 10px;
    margin: 0 auto;
    border-block: 2px solid currentColor;
  }
  .dsx-list-reorder:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
  .dsx-row-constructs[data-dsx-dragging="true"] { opacity: .6; }
  .dsx-list[data-dsx-reordering="true"] { cursor: grabbing; }
  .dsx-list[data-dsx-autoscroll]:not([data-dsx-autoscroll="false"]) { scrollbar-width: none; }
  .dsx-list[data-dsx-autoscroll]:not([data-dsx-autoscroll="false"])::-webkit-scrollbar { display: none; }

  .dsx-grid {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: var(--dsx-collection-spacing, 10px);
  }
  .dsx-grid > .dsx-grid-aria-row {
    display: grid;
    grid-template-columns: repeat(var(--dsx-grid-columns, 3), minmax(0, 1fr));
    width: 100%;
    gap: var(--dsx-collection-spacing, 10px);
  }
  .dsx-grid > .dsx-grid-aria-row > .dsx-row { min-width: 0; }

  .dsx-tabs {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    color: var(--dsx-accent);
    background: var(--dsx-background);
  }
  .dsx-tab-panels { min-width: 0; min-height: 0; overflow: auto; color: var(--dsx-label); }
  .dsx-tab-panel { min-width: 0; min-height: 0; }
  .dsx-tab-panel[hidden] { display: none; }
  .dsx-tablist {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    align-items: stretch;
    min-width: 0;
    padding: 6px max(8px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
    border-top: 1px solid var(--dsx-separator);
    background: color-mix(in srgb, var(--dsx-background) 88%, transparent);
    -webkit-backdrop-filter: blur(20px) saturate(1.25);
    backdrop-filter: blur(20px) saturate(1.25);
  }
  .dsx-tab {
    appearance: none;
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: 1fr auto 1fr;
    place-items: center;
    align-content: center;
    min-width: 0;
    min-height: 48px;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--dsx-radius-sm);
    color: var(--dsx-secondary-label);
    background: transparent;
    font: inherit;
    cursor: pointer;
    transition: color 150ms ease, background-color 150ms ease, transform 100ms ease;
  }
  .dsx-tab[data-dsx-selected="true"] { color: currentColor; background: var(--dsx-fill); }
  .dsx-tab:active { transform: scale(.98); }
  .dsx-tab:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; box-shadow: var(--dsx-focus-ring); }
  .dsx-tab-icon { grid-column: 2; display: inline-flex; width: 20px; height: 20px; }
  .dsx-tab-label {
    grid-column: 1 / -1;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: .75rem;
    font-weight: 600;
    line-height: 1.2;
  }
  .dsx-tab-badge {
    grid-column: 3;
    grid-row: 1;
    justify-self: start;
    min-width: 18px;
    max-width: 3.5rem;
    padding: 1px 5px;
    overflow: hidden;
    border-radius: 999px;
    color: var(--dsx-background);
    background: var(--dsx-destructive);
    text-overflow: ellipsis;
    font-size: .6875rem;
    font-weight: 700;
    line-height: 16px;
  }

  .dsx-paged {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    color: var(--dsx-accent);
  }
  .dsx-paged-viewport {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
    scroll-snap-type: x mandatory;
  }
  .dsx-paged:dir(rtl) .dsx-paged-page { direction: rtl; }
  .dsx-paged-viewport::-webkit-scrollbar { display: none; }
  .dsx-paged[data-dsx-axis="vertical"] .dsx-paged-viewport { scroll-snap-type: y mandatory; }
  .dsx-paged-track { display: flex; min-width: 100%; min-height: 100%; }
  .dsx-paged[data-dsx-axis="vertical"] .dsx-paged-track { flex-direction: column; height: 100%; }
  .dsx-paged-page {
    flex: 0 0 100%;
    min-width: 0;
    min-height: 100%;
    scroll-snap-align: start;
    scroll-snap-stop: always;
  }
  .dsx-paged[data-dsx-axis="vertical"] .dsx-paged-page { min-height: 100%; }
  .dsx-carousel .dsx-paged-page {
    padding-inline: calc(var(--dsx-carousel-peek, 0px) + var(--dsx-carousel-spacing, 12px));
  }
  .dsx-carousel[data-dsx-peek="false"] .dsx-paged-page { padding-inline: 0; }
  .dsx-paged-dots {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    padding: 7px 12px;
  }
  .dsx-paged-dots[hidden] { display: none; }
  .dsx-paged-dot {
    appearance: none;
    width: 8px;
    height: 8px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: currentColor;
    opacity: .28;
    cursor: pointer;
    transition: width 150ms ease, opacity 150ms ease, transform 100ms ease;
  }
  .dsx-paged-dot[data-dsx-selected="true"] { width: 20px; opacity: 1; }
  .dsx-paged-dot:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
  .dsx-paged-dot:active { transform: scale(.9); }

  @media (min-width: 48rem) {
    .dsx-tablist {
      width: min(calc(100% - 32px), 44rem);
      justify-self: center;
      margin: 0 16px max(12px, env(safe-area-inset-bottom));
      padding: 6px;
      border: 1px solid var(--dsx-separator);
      border-radius: var(--dsx-radius-lg);
      box-shadow: 0 12px 32px color-mix(in srgb, var(--dsx-label) 10%, transparent);
    }
    .dsx-paged-dots { gap: 8px; }
  }

  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="grouped"],
    .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"][class="dsx-list"]:not([style]),
    .dsx-list[data-dsx-axis="vertical"][data-dsx-appearance="automatic"]:has(> .dsx-row > .dsx-settings-row) {
      --dsx-list-row-height: 40px;
      --dsx-list-padding-inline: 12px;
      --dsx-list-separator-inset: 12px;
    }
    .dsx-toolbar { min-height: 40px; padding-block: 7px; }
    .dsx-tab { min-height: 42px; grid-template-rows: auto; grid-template-columns: auto auto auto; gap: 7px; }
    .dsx-tab-icon, .dsx-tab-label, .dsx-tab-badge { grid-row: 1; grid-column: auto; }
    .dsx-tab-label { font-size: .8125rem; }
    .dsx-paged-dot:hover, .dsx-tab:hover { opacity: 1; background-color: var(--dsx-fill); }
  }

  @media (prefers-reduced-motion: reduce) {
    .dsx-tab, .dsx-paged-dot, .dsx-list-row-content { transition-duration: 0s; }
  }

  @media (forced-colors: active) {
    .dsx-toolbar, .dsx-tablist { border-color: CanvasText; background: Canvas; }
    .dsx-tab[data-dsx-selected="true"], .dsx-paged-dot[data-dsx-selected="true"] { forced-color-adjust: none; color: Highlight; }
    .dsx-tab:focus-visible, .dsx-paged-dot:focus-visible { outline-color: Highlight; box-shadow: none; }
  }
}`;
