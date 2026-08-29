//
//  split.ts - `<split>`, the two/three-pane adaptive container (component-library.md W9,
//  the program's NavigationSplitView / list-detail primitive). The PLAN is the shared
//  grammar - `resolveSplit` executes OpenSource/Conformance/split/split.json, the same
//  corpus the Kotlin SplitPlan and Swift SplitPlan twins run - and this factory is the
//  web presentation of that plan: CSS grid columns with draggable hairline dividers on
//  desktop, a pinned-pair + overlay sidebar on tablet, and a stack push (the host pane
//  is the screen, an active detail pushes over it) on phone. Width is the CONTAINER's,
//  not the viewport's (the natives plan from BoxWithConstraints/the split host), so the
//  breakpoints are author-configurable attributes, never a pinned media query.
//

import { string } from "@despia/kernel";
import { iconSvg, type ElementFactory } from "./elements.ts";

export type SplitRole = "sidebar" | "content" | "detail";
export type SplitWidths = { min: number; ideal: number; max: number };
export type SplitPlan = {
  panes: number;
  roles: SplitRole[];
  presentation: "stack" | "columns";
  columns: SplitRole[];
  host: SplitRole;
  overlay: boolean;
  detail: boolean;
  resizable: boolean;
  collapseAt: number;
  expandAt: number;
  sidebar: SplitWidths;
  content: SplitWidths;
  detailMin: number;
};

export const SPLIT_ROLE_ORDER: readonly SplitRole[] = ["sidebar", "content", "detail"];
const ROLE_SET = new Set<string>(SPLIT_ROLE_ORDER);
const decimalNumber = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function finite(raw: string | undefined, fallback: number): number {
  const text = raw?.trim() ?? "";
  if (!decimalNumber.test(text)) return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

function widths(
  attrs: Readonly<Record<string, string>>,
  prefix: "sidebar" | "content",
  defaults: SplitWidths,
): SplitWidths {
  const min = Math.min(1024, Math.max(120, finite(attrs[`${prefix}Min`], defaults.min)));
  const ideal = Math.min(1600, Math.max(min, finite(attrs[`${prefix}Ideal`], defaults.ideal)));
  const max = Math.max(ideal, Math.min(1600, Math.max(120, finite(attrs[`${prefix}Max`], defaults.max))));
  return { min, ideal, max };
}

/** Per-child role resolution: an explicit, valid `paneRole` wins (first claimant keeps
 * a duplicated role); everything else fills positionally from the remaining canonical
 * roles for the pane count. Total by construction - corpus `cases[].roles`. */
export function resolveSplitRoles(childRoles: ReadonlyArray<string | null | undefined>): SplitRole[] {
  const bounded = childRoles.slice(0, 3);
  const explicit: Array<SplitRole | null> = bounded.map((raw) => {
    const word = raw?.trim().toLowerCase() ?? "";
    return ROLE_SET.has(word) ? (word as SplitRole) : null;
  });
  const taken = new Set<SplitRole>();
  const kept = explicit.map((role) => {
    if (role === null || taken.has(role)) return null;
    taken.add(role);
    return role;
  });
  const order: readonly SplitRole[] = bounded.length === 1 ? ["content"]
    : bounded.length === 2 ? ["sidebar", "detail"]
    : SPLIT_ROLE_ORDER;
  const pool = order.filter((role) => !taken.has(role));
  return kept.map((role) => role ?? pool.shift() ?? "content");
}

/** The shared planner - the fixture is OpenSource/Conformance/split/split.json (Kotlin
 * SplitPlan / Swift SplitPlan run the same file). Width is the split's own box. */
export function resolveSplit(
  attrs: Readonly<Record<string, string>>,
  childRoles: ReadonlyArray<string | null | undefined>,
  width: number,
): SplitPlan {
  const roles = resolveSplitRoles(childRoles);
  const collapseAt = Math.min(4096, Math.max(320, finite(attrs["collapseAt"], 760)));
  const expandAt = Math.max(collapseAt, Math.min(4096, Math.max(320, finite(attrs["expandAt"], 1104))));
  const boundedWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const hasSidebar = roles.includes("sidebar");
  const hasContent = roles.includes("content");
  const hasDetail = roles.includes("detail");
  const host: SplitRole = hasContent ? "content" : hasSidebar ? "sidebar" : hasDetail ? "detail" : "content";
  const presentation: SplitPlan["presentation"] = boundedWidth < collapseAt ? "stack" : "columns";
  const columns = presentation === "stack" ? [] : SPLIT_ROLE_ORDER.filter((role) => {
    if (!roles.includes(role)) return false;
    return !(role === "sidebar" && roles.length === 3 && boundedWidth < expandAt);
  });
  const overlay = hasSidebar
    && (presentation === "stack" ? host !== "sidebar" : !columns.includes("sidebar"));
  const authoredResizable = String(attrs["resizable"] ?? "true").trim().toLowerCase() !== "false";
  return {
    panes: roles.length,
    roles,
    presentation,
    columns,
    host,
    overlay,
    detail: hasDetail,
    resizable: authoredResizable && presentation === "columns" && columns.length >= 2,
    collapseAt,
    expandAt,
    sidebar: widths(attrs, "sidebar", { min: 220, ideal: 280, max: 360 }),
    content: widths(attrs, "content", { min: 280, ideal: 340, max: 480 }),
    detailMin: Math.min(1024, Math.max(120, finite(attrs["detailMin"], 360))),
  };
}

/** Selection routing: is a detail selected? `null`/`false`/blank = none; anything else
 * (stringified) is active, so numeric ids like 0 stay selectable - corpus `selection`. */
export function splitSelectionActive(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  return string(value).trim().length > 0;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const PANE_LABELS: Record<SplitRole, string> = { sidebar: "Sidebar", content: "Content", detail: "Detail" };
/** The sidebar-toggle glyph (SF `sidebar.leading` shape) - not in the icon corpus, so
 * the path lives here, byte-identical to the @despia/server twin. */
export const SPLIT_TOGGLE_PATH = "M4 5h16v14H4zM9 5v14";

function strokeIcon(d: string, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = cls;
  return element;
}

export const split: ElementFactory = (node, ctx, api) => {
  const root = el("div", "dsx-split");
  root.setAttribute("role", "group");
  if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined) {
    root.setAttribute("aria-label", "Split view");
  }

  const children = node.children.slice(0, 3);
  if (node.children.length > 3) {
    console.warn(`[dsx dom] <split> has ${node.children.length} children; rendering the first 3`);
  }
  const declaredRoles = children.map((child) => child.attrs["paneRole"] ?? null);
  const staticRoles = resolveSplitRoles(declaredRoles);
  // panes in CANONICAL role order (the child -> role map routes each child into its
  // column), dividers interleaved between them - the grid template mirrors this order.
  const paneOf = new Map<SplitRole, HTMLElement>();
  const orderedRoles = SPLIT_ROLE_ORDER.filter((role) => staticRoles.includes(role));

  const scrim = el("div", "dsx-split-scrim");
  scrim.hidden = true;
  scrim.setAttribute("aria-hidden", "true");
  root.appendChild(scrim);

  let toggle: HTMLButtonElement | null = null;
  let back: HTMLButtonElement | null = null;
  const dividers: Array<{ element: HTMLElement; controls: SplitRole }> = [];

  for (const [position, role] of orderedRoles.entries()) {
    if (position > 0) {
      const divider = el("div", "dsx-split-divider");
      divider.setAttribute("role", "separator");
      divider.setAttribute("aria-orientation", "vertical");
      const controls = orderedRoles[position - 1]!;
      divider.setAttribute("aria-label", `Resize ${PANE_LABELS[controls].toLowerCase()}`);
      divider.setAttribute("data-dsx-controls", controls);
      root.appendChild(divider);
      dividers.push({ element: divider, controls });
    }
    const pane = el("div", "dsx-split-pane");
    pane.setAttribute("role", "group");
    pane.setAttribute("data-dsx-pane", role);
    pane.setAttribute("aria-label", PANE_LABELS[role]);
    if (role === "detail" && staticRoles.length >= 2) {
      back = el("button", "dsx-split-back") as HTMLButtonElement;
      back.type = "button";
      back.setAttribute("aria-label", "Back");
      back.appendChild(iconSvg("chevron.left", 20));
      const backLabel = el("span", "dsx-split-back-label");
      backLabel.textContent = "Back";
      back.appendChild(backLabel);
      pane.appendChild(back);
    }
    const childIndex = staticRoles.indexOf(role);
    api.children(pane, [children[childIndex]!]);
    root.appendChild(pane);
    paneOf.set(role, pane);
  }

  if (staticRoles.includes("sidebar") && staticRoles.length === 3) {
    toggle = el("button", "dsx-split-toggle") as HTMLButtonElement;
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Show sidebar");
    toggle.setAttribute("aria-expanded", "false");
    toggle.appendChild(strokeIcon(SPLIT_TOGGLE_PATH, 20));
    root.insertBefore(toggle, scrim);
  }

  // ── live state: the resolved attrs (reactive), the container width, the selection ──
  const resolvedAttrs: Record<string, string> = {};
  let width = 0;
  let selectionActive = false;
  let sidebarOpen = false;
  let plan = resolveSplit(resolvedAttrs, declaredRoles, width);
  // divider drag state: authored column widths override the plan ideal until re-authored
  const authoredWidth = new Map<SplitRole, number>();

  const columnWidth = (role: SplitRole): number => {
    const bounds = role === "sidebar" ? plan.sidebar : plan.content;
    const authored = authoredWidth.get(role);
    return Math.min(bounds.max, Math.max(bounds.min, authored ?? bounds.ideal));
  };

  const gridTemplate = (): string => {
    const parts: string[] = [];
    plan.columns.forEach((role, index) => {
      if (index > 0) parts.push("auto");
      parts.push(
        index === plan.columns.length - 1
          ? `minmax(min(${plan.detailMin}px, 100%), 1fr)`
          : `${columnWidth(role)}px`,
      );
    });
    return parts.join(" ");
  };

  const reflect = (): void => {
    root.setAttribute("data-dsx-presentation", plan.presentation);
    root.setAttribute("data-dsx-panes", String(plan.panes));
    root.setAttribute("data-dsx-columns", plan.columns.join(" "));
    root.setAttribute("data-dsx-detail-active", String(plan.detail && selectionActive));
    root.setAttribute("data-dsx-overlay", String(plan.overlay));
    root.setAttribute("data-dsx-overlay-open", String(plan.overlay && sidebarOpen));
    root.setAttribute("data-dsx-resizable", String(plan.resizable));
    root.style.setProperty("--dsx-split-columns", plan.presentation === "columns" ? gridTemplate() : "minmax(0, 1fr)");
    for (const role of orderedRoles) {
      const pane = paneOf.get(role)!;
      const pinned = plan.columns.includes(role);
      const pushed = role === "detail" && plan.presentation === "stack" && selectionActive;
      const overlayOpen = role === "sidebar" && plan.overlay && sidebarOpen;
      const hosts = plan.presentation === "stack" && role === plan.host;
      const visible = pinned || pushed || overlayOpen || hosts;
      pane.inert = !visible;
      if (visible) pane.removeAttribute("aria-hidden");
      else pane.setAttribute("aria-hidden", "true");
      pane.setAttribute("data-dsx-visible", String(visible));
    }
    // the stack host stays in the DOM under a pushed detail (the push is a covering
    // layer, like a navigation stack), so only [data-dsx-visible] drives display.
    dividers.forEach(({ element, controls }) => {
      const next = plan.columns[plan.columns.indexOf(controls) + 1];
      const active = plan.presentation === "columns"
        && plan.columns.includes(controls) && next !== undefined;
      element.hidden = !active;
      if (active) {
        const bounds = controls === "sidebar" ? plan.sidebar : plan.content;
        element.setAttribute("aria-valuemin", String(bounds.min));
        element.setAttribute("aria-valuemax", String(bounds.max));
        element.setAttribute("aria-valuenow", String(columnWidth(controls)));
        element.tabIndex = plan.resizable ? 0 : -1;
        element.setAttribute("data-dsx-resizable", String(plan.resizable));
      }
    });
    if (toggle !== null) {
      // a pushed detail COVERS the host (and its top-leading chrome), so the toggle
      // yields to the Back pop while the push is up - it returns with the host.
      const covered = plan.presentation === "stack" && plan.detail && selectionActive;
      toggle.hidden = !plan.overlay || covered;
      toggle.setAttribute("aria-expanded", String(plan.overlay && sidebarOpen));
    }
    // the pane the toggle floats over reserves a chrome strip for it (the platform
    // split hosts do the same for their sidebar control) - none when it is hidden.
    const chromeRole: SplitRole | null = toggle !== null && !toggle.hidden
      ? (sidebarOpen ? "sidebar" : plan.presentation === "stack" ? plan.host : plan.columns[0] ?? null)
      : null;
    for (const role of orderedRoles) {
      const pane = paneOf.get(role)!;
      if (role === chromeRole) pane.setAttribute("data-dsx-chrome", "true");
      else pane.removeAttribute("data-dsx-chrome");
    }
    scrim.hidden = !(plan.overlay && sidebarOpen);
    if (back !== null) back.hidden = !(plan.presentation === "stack" && plan.detail);
  };

  const replan = (): void => {
    plan = resolveSplit(resolvedAttrs, declaredRoles, width);
    if (!plan.overlay) sidebarOpen = false;
    reflect();
  };

  for (const name of [
    "panes", "collapseAt", "expandAt", "resizable",
    "sidebarMin", "sidebarIdeal", "sidebarMax",
    "contentMin", "contentIdeal", "contentMax", "detailMin",
  ]) {
    const expression = node.attrs[name];
    if (expression === undefined) continue;
    api.bindText(expression, (value) => { resolvedAttrs[name] = value; replan(); });
  }

  const setSidebar = (open: boolean, focus: boolean): void => {
    if (!plan.overlay || sidebarOpen === open) return;
    sidebarOpen = open;
    reflect();
    const sidebar = paneOf.get("sidebar");
    if (open && focus && sidebar !== undefined) {
      sidebar.tabIndex = -1;
      sidebar.focus?.();
    } else if (!open && focus) {
      toggle?.focus?.();
    }
  };
  toggle?.addEventListener("click", () => setSidebar(!sidebarOpen, true));
  scrim.addEventListener("click", () => setSidebar(false, true));
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && plan.overlay && sidebarOpen) {
      event.preventDefault();
      setSidebar(false, true);
    }
  });

  // ── selection routing: value= is the selected detail identity; the kernel back
  // affordance clears it (writeBack + change), which is the stack pop.
  const applySelection = (value: unknown): void => {
    selectionActive = splitSelectionActive(value);
    reflect();
  };
  if (node.attrs["value"] !== undefined) {
    api.bindValue(node.attrs["value"], applySelection);
  }
  back?.addEventListener("click", () => {
    selectionActive = false;
    reflect();
    if (node.attrs["value"] !== undefined) api.writeBack(node.attrs["value"], "");
    api.handler("change", { value: "" });
    const host = paneOf.get(plan.host);
    if (host !== undefined) { host.tabIndex = -1; host.focus?.(); }
  });

  // ── desktop dividers: pointer drag + the ARIA window-splitter keyboard contract ──
  dividers.forEach(({ element, controls }) => {
    const apply = (next: number): void => {
      const bounds = controls === "sidebar" ? plan.sidebar : plan.content;
      authoredWidth.set(controls, Math.min(bounds.max, Math.max(bounds.min, next)));
      reflect();
    };
    element.addEventListener("pointerdown", (event) => {
      if (!plan.resizable) return;
      const pointer = event as PointerEvent;
      const startX = pointer.clientX;
      const startWidth = columnWidth(controls);
      const rtl = typeof getComputedStyle === "function" && getComputedStyle(root).direction === "rtl";
      element.setAttribute("data-dsx-dragging", "true");
      const move = (raw: Event): void => {
        const delta = ((raw as PointerEvent).clientX - startX) * (rtl ? -1 : 1);
        apply(startWidth + delta);
      };
      const up = (): void => {
        element.removeAttribute("data-dsx-dragging");
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
      event.preventDefault();
    });
    element.addEventListener("keydown", (event) => {
      if (!plan.resizable) return;
      const bounds = controls === "sidebar" ? plan.sidebar : plan.content;
      const rtl = typeof getComputedStyle === "function" && getComputedStyle(root).direction === "rtl";
      const step = 16 * (rtl ? -1 : 1);
      const next = event.key === "ArrowLeft" ? columnWidth(controls) - step
        : event.key === "ArrowRight" ? columnWidth(controls) + step
        : event.key === "Home" ? bounds.min
        : event.key === "End" ? bounds.max
        : null;
      if (next === null) return;
      event.preventDefault();
      apply(next);
    });
  });

  // ── container width (the natives' BoxWithConstraints twin) ──
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box === undefined) return;
      if (box.width !== width) { width = box.width; replan(); }
    });
    observer.observe(root);
    ctx.disposers.push(() => observer.disconnect());
  }

  replan();
  return root;
};

export const SPLIT_CSS = `@layer dsx-elements {
  .dsx-split {
    position: relative;
    display: grid;
    grid-template-columns: var(--dsx-split-columns, minmax(0, 1fr));
    grid-template-rows: minmax(0, 1fr);
    align-items: stretch;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    color: var(--dsx-label);
    background: var(--dsx-background);
  }
  .dsx-split-pane {
    position: relative;
    grid-row: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden auto;
    outline: none;
  }
  .dsx-split-pane[data-dsx-visible="false"] { display: none; }
  /* the floating sidebar toggle's reserved chrome strip (8 + 36 + 8) */
  .dsx-split-pane[data-dsx-chrome="true"] { padding-block-start: calc(max(8px, env(safe-area-inset-top)) + 44px); }
  .dsx-split-pane > * { flex: 1 0 auto; }
  .dsx-split-pane > .dsx-split-back { flex: none; }
  .dsx-split-pane[data-dsx-pane="sidebar"] { background: var(--dsx-secondary-background); }

  /* THE STACK (phone): one column; the host pane is the screen. An ACTIVE detail is a
     PUSHED layer covering it - transform-only spring, the navigation-push idiom. */
  .dsx-split[data-dsx-presentation="stack"] > .dsx-split-pane { grid-column: 1; }
  .dsx-split[data-dsx-presentation="stack"][data-dsx-detail-active="true"] > .dsx-split-pane[data-dsx-pane="detail"] {
    position: absolute;
    inset: 0;
    z-index: 2;
    background: var(--dsx-background);
    animation: dsx-split-push var(--dsx-dur-slow) var(--dsx-ease-spring-soft);
  }
  @keyframes dsx-split-push { from { transform: translateX(100%); } }
  [dir="rtl"] .dsx-split[data-dsx-presentation="stack"][data-dsx-detail-active="true"] > .dsx-split-pane[data-dsx-pane="detail"] {
    animation-name: dsx-split-push-rtl;
  }
  @keyframes dsx-split-push-rtl { from { transform: translateX(-100%); } }

  /* THE COLUMNS (tablet/desktop): the grid template carries the pinned panes; each
     divider is its own auto column, so panes and dividers share one row. */
  .dsx-split[data-dsx-presentation="columns"] > .dsx-split-pane,
  .dsx-split[data-dsx-presentation="columns"] > .dsx-split-divider { grid-column: auto; }
  .dsx-split-divider {
    position: relative;
    grid-row: 1;
    width: var(--dsx-hairline);
    background: var(--dsx-separator);
    outline: none;
  }
  .dsx-split-divider[hidden] { display: none; }
  .dsx-split-divider::before {
    content: "";
    position: absolute;
    inset: 0 -5px;
    z-index: 1;
  }
  .dsx-split-divider:focus-visible {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-accent);
    outline-offset: var(--dsx-focus-ring-offset);
  }
  .dsx-split-divider[data-dsx-dragging="true"] { background: var(--dsx-accent); }

  /* THE OVERLAY SIDEBAR (a three-pane split below the expand step): a leading sheet
     over a scrim - shadow-3 elevation, spring-in, Escape/scrim to close. */
  .dsx-split[data-dsx-overlay="true"] > .dsx-split-pane[data-dsx-pane="sidebar"] {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    z-index: 4;
    width: min(85%, 20rem);
    border-inline-end: var(--dsx-hairline) solid var(--dsx-separator);
    box-shadow: var(--dsx-shadow-3);
    animation: dsx-split-overlay-in var(--dsx-dur-slow) var(--dsx-ease-spring-soft);
  }
  @keyframes dsx-split-overlay-in { from { transform: translateX(-100%); } }
  [dir="rtl"] .dsx-split[data-dsx-overlay="true"] > .dsx-split-pane[data-dsx-pane="sidebar"] {
    animation-name: dsx-split-overlay-in-rtl;
  }
  @keyframes dsx-split-overlay-in-rtl { from { transform: translateX(100%); } }
  .dsx-split-scrim {
    position: absolute;
    inset: 0;
    z-index: 3;
    background: var(--dsx-split-scrim, color-mix(in srgb, black 32%, transparent));
    animation: dsx-split-fade var(--dsx-dur-base) linear both;
  }
  .dsx-split-scrim[hidden] { display: none; }
  @keyframes dsx-split-fade { from { opacity: 0; } }

  /* kernel chrome: the sidebar toggle (overlay presentations) + the stack back pop */
  .dsx-split-toggle {
    appearance: none;
    position: absolute;
    top: max(8px, env(safe-area-inset-top));
    inset-inline-start: max(8px, env(safe-area-inset-left));
    z-index: 5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: var(--dsx-radius-control);
    color: var(--dsx-secondary-label);
    background: transparent;
    cursor: pointer;
    transition: color var(--dsx-dur-fast) var(--dsx-ease), background-color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-split-toggle[hidden] { display: none; }
  .dsx-split-toggle:focus-visible {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-accent);
    outline-offset: var(--dsx-focus-ring-offset);
  }
  .dsx-split-back {
    appearance: none;
    display: none;
    align-items: center;
    gap: 2px;
    align-self: flex-start;
    min-height: 44px;
    margin: max(4px, env(safe-area-inset-top)) 8px 0;
    padding: 0 12px 0 4px;
    border: 0;
    border-radius: var(--dsx-radius-control);
    color: var(--dsx-accent);
    background: transparent;
    font: inherit;
    font-size: var(--dsx-type-callout-size);
    cursor: pointer;
  }
  .dsx-split[data-dsx-presentation="stack"] > .dsx-split-pane > .dsx-split-back { display: inline-flex; }
  .dsx-split-back[hidden], .dsx-split[data-dsx-presentation="stack"] > .dsx-split-pane > .dsx-split-back[hidden] { display: none; }
  .dsx-split-back:focus-visible {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-accent);
    outline-offset: var(--dsx-focus-ring-offset);
    z-index: 1;
  }
  [dir="rtl"] .dsx-split-back svg { transform: scaleX(-1); }

  @media (hover: hover) and (pointer: fine) {
    .dsx-split-toggle:hover { color: var(--dsx-label); background: var(--dsx-fill); }
    .dsx-split[data-dsx-resizable="true"] .dsx-split-divider { cursor: col-resize; }
    .dsx-split[data-dsx-resizable="true"] .dsx-split-divider:hover { background: var(--dsx-outline-soft); }
  }

  @media (prefers-reduced-motion: reduce) {
    .dsx-split[data-dsx-presentation="stack"][data-dsx-detail-active="true"] > .dsx-split-pane[data-dsx-pane="detail"],
    .dsx-split[data-dsx-overlay="true"] > .dsx-split-pane[data-dsx-pane="sidebar"],
    .dsx-split-scrim { animation: none; }
    .dsx-split-toggle, .dsx-split-back { transition-duration: 0s; }
  }

  @media (forced-colors: active) {
    .dsx-split-divider { background: CanvasText; }
    .dsx-split[data-dsx-overlay="true"] > .dsx-split-pane[data-dsx-pane="sidebar"] { border-inline-end-color: CanvasText; background: Canvas; }
    .dsx-split-divider:focus-visible, .dsx-split-toggle:focus-visible, .dsx-split-back:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: -2px;
      box-shadow: none;
    }
  }
}`;
