//
//  elements.ts - the element library: DSX tag → DOM factory, each emitting the stable
//  `.dsx-*` class contract (/web/17: webClass; composite anatomy with webParts —
//  semantics ride real inputs, decorative parts aria-hidden). This base module stays
//  the slim primitive floor; optional native-global web twins register from
//  globals.ts so embeds that do not use them do not pay for them.
//

import { string, number, truthy, DSXEvents, ModuleRegistry, type Dict } from "@despia/kernel";
import { segmentOptions, type SegmentOption } from "@despia/compiler/options";
import { mapStyleValue } from "@despia/compiler/cssmap";
import { resolveComponent } from "@despia/compiler/resolve";
import { admitSrc } from "./src-gate.ts";
import { multilineReturn, type MountCtx } from "./mount.ts";
import type { XmlNode } from "@despia/compiler/xml";
import { qrMatrix, type QrCorrection } from "./qr.ts";
import { resolveAdaptiveShell } from "./adaptive-shell.ts";
import { ICON_FALLBACKS, ICON_VECTORS } from "./icons.generated.ts";
import { renderMarkdown } from "./markdown.ts";
import { markdownBlocksFragment } from "./markdown-blocks.ts";
import { applyScrollBehaviour } from "./scroll.ts";
import { TYPE_ROLES } from "./type-roles.ts";
import { applyImageAttributes } from "./image.ts";

export type ElementFactory = (node: XmlNode, ctx: MountCtx, api: ElementApi) => HTMLElement;

/** renderer services element factories may use (keeps factories DOM-pure + testable) */
export type ElementApi = {
  /** reactive read of an interpolatable attribute ("" when absent) */
  bindText(expr: string | undefined, apply: (v: string) => void): void;
  /** bindText THROUGH the localization seam (P12): for DISPLAY text only - text value /
   *  inner text, button labels, placeholders. Always an effect, even for a static
   *  template, so `global.locale` / `global.strings` writes re-resolve live surfaces;
   *  bound dynamic content (`bind=`) stays source-language per localization.md. */
  bindDisplay(expr: string | undefined, apply: (v: string) => void): void;
  /** reactive JSE read (visible-if / bind expressions — raw, no {{ }}) */
  bindValue(expr: string | undefined, apply: (v: unknown) => void): void;
  /** two-way write back to a bind= path */
  writeBack(path: string | undefined, value: unknown): void;
  /** run an on:* handler (payload rides dsx.this) */
  handler(name: string, payload?: Dict): void;
  hasHandler(name: string): boolean;
  /** mount this node's children into a parent (the default flow). `inherit` carries
   * renderer-owned environment values such as the enclosing form namespace, and — for
   * the factories that REMOUNT content (DSXView re-resolving `src`) — a private
   * disposer list so the previous mount's subscriptions can be torn down. */
  children(parent: HTMLElement, nodes?: readonly XmlNode[], inherit?: { formNamespace?: string; disposers?: Array<() => void> }): void;
};

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function bindSemanticColor(
  node: XmlNode,
  api: ElementApi,
  element: HTMLElement,
  property: string,
): void {
  const expression = node.attrs["color"];
  if (expression === undefined) return;
  api.bindText(expression, (value) => {
    const color = mapStyleValue("color", value);
    if (color.length === 0) element.style.removeProperty(property);
    else element.style.setProperty(property, color);
  });
}

/** Bound visual scale for the 20px spinner. This keeps remote markup useful without
 * allowing zero/negative disappearance or viewport-sized transform overflow. */
export const SPINNER_SCALE_LIMITS = { min: 0.25, max: 4 } as const;

export function normalizeSpinnerScale(value: unknown): number {
  const parsed = number(value);
  if (parsed === null || parsed === undefined || !Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(parsed, SPINNER_SCALE_LIMITS.min), SPINNER_SCALE_LIMITS.max);
}

/** the button ROLE words (system-defaults.md): `role="destructive|cancel"` on a
 *  button-family element is the semantic button role — SwiftUI's ButtonRole, M3's
 *  error emphasis — consumed here as a `data-dsx-role` stamp for the dsx-elements
 *  skin. NEVER a DOM ARIA role: mount.ts keeps these two words off the `role`
 *  attribute (every other value stays the verbatim ARIA pass-through). */
export const BUTTON_ROLES: ReadonlySet<string> = new Set(["destructive", "cancel"]);

// ── the SF Symbol icon tier (/web/08: bundled SVG subset + build warning for unmapped
//    names) ────────────────────────────────────────────────────────────────────────────
//
// The table is NOT web's to own. `icon=` is a semantic token resolved by the SAME name on
// every runtime (StackReference.md), and the ONE table behind it is
// OpenSource/Conformance/icons/sf-map.json — the same bytes Android packages as a :render
// asset. Web used to keep a private 27-name fork here, so 85 corpus names drew on
// iOS/Android and a placeholder circle in the browser. Both tables below are now GENERATED
// from that corpus (packages/dom/bin/generate-icons.ts, `npm run icons:generate`) and
// packages/dom/test/icons.test.ts fails on drift or on any corpus name web cannot draw.
//
// The render ladder mirrors Android's (StackIcons.kt): a 24x24 stroke path, else the
// corpus's plain unicode stand-in as <text>, else — only for a name the corpus does not
// know — the fail-open placeholder plus one build/dev warning.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Own-property lookup only: an icon name is authored data and must never reach
 *  `Object.prototype` members (`constructor`, `toString`, `__proto__`, …). */
function iconEntry(table: { readonly [name: string]: string }, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}

export function iconSvg(name: string, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  // AXIS v2 (sf-map.json _web_axis): the corpus web paths are Boxicons FILL paths,
  // painted with the current color - the stroke tier retired with the hand-drawn set.
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke", "none");
  svg.setAttribute("aria-hidden", "true");

  const d = iconEntry(ICON_VECTORS, name);
  if (d !== undefined) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
  }

  // rung 2 — the corpus fallback glyph. `fill`/`stroke` are re-declared locally because the
  // root is configured for the stroke tier; a glyph must PAINT, not outline.
  const glyph = iconEntry(ICON_FALLBACKS, name);
  if (glyph !== undefined) {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", "12");
    text.setAttribute("y", "12");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("font-size", "18");
    text.setAttribute("fill", "currentColor");
    text.setAttribute("stroke", "none");
    text.textContent = glyph;
    svg.appendChild(text);
    return svg;
  }

  console.warn(`[dsx dom] unmapped icon '${name}' — add its row to OpenSource/Conformance/icons/sf-map.json (the one cross-runtime table) or override with icon-web= (the /web/08 adapter contract)`);
  const placeholder = document.createElementNS(SVG_NS, "path");
  placeholder.setAttribute("d", "M12 4a8 8 0 100 16 8 8 0 000-16z");
  svg.appendChild(placeholder);
  return svg;
}

// ── factories ────────────────────────────────────────────────────────────────────────

const stack: ElementFactory = (node, _ctx, api) => {
  const cls = node.tag === "zstack" ? "dsx-stack dsx-zstack"
    : node.tag === "hstack" ? "dsx-stack dsx-hstack dsx-hstack-defaults"
    : node.tag === "vstack" ? "dsx-stack dsx-vstack"
    : "dsx-stack";
  const e = el("div", cls);
  if (node.attrs["flexDirection"] !== undefined) {
    api.bindText(node.attrs["flexDirection"], (value) => {
      if (node.tag === "stack") e.classList.toggle("dsx-hstack", value === "row");
    });
  }
  if (node.attrs["display"] !== undefined) {
    api.bindText(node.attrs["display"], (value) => {
      if (value === "grid") e.setAttribute("data-dsx-grid", "true");
      else e.removeAttribute("data-dsx-grid");
    });
  }
  api.children(e);
  return e;
};

const scaffold: ElementFactory = (node, ctx, api) => {
  const root = el("div", "dsx-scaffold");
  const resolvedAttrs: Record<string, string> = { shell: "custom", collapse: "platform" };
  let measuredWidth = 0;
  const top = node.children.filter((child) => child.attrs["pin"] === "top");
  const bottom = node.children.filter((child) => child.attrs["pin"] === "bottom");
  const unpinned = node.children.filter((child) => child.attrs["pin"] === undefined);
  const sidebar = unpinned.filter((child) => child.attrs["pane"] === "sidebar");
  const inspector = unpinned.filter((child) => child.attrs["pane"] === "inspector");
  const content = unpinned.filter((child) => {
    const pane = child.attrs["pane"];
    return pane === undefined || pane === "content";
  });

  const pin = (tag: "header" | "footer", cls: string, children: readonly XmlNode[]): HTMLElement => {
    const element = el(tag, cls);
    api.children(element, children);
    return element;
  };
  if (top.length > 0) root.appendChild(pin("header", "dsx-scaffold-pin dsx-scaffold-pin-top", top));

  const shell = el("div", "dsx-scaffold-shell");
  const custom = el("div", "dsx-scaffold-custom");
  const nav = el("nav", "dsx-scaffold-pane dsx-scaffold-sidebar");
  const main = el("main", "dsx-scaffold-pane dsx-scaffold-content");
  const aside = el("aside", "dsx-scaffold-pane dsx-scaffold-inspector");

  // Mount every authored body child exactly once, between stable range sentinels.
  // Switching a reactive shell between custom/adaptive moves those ranges; it never
  // remounts controls, loses focus/state, or duplicates subscriptions. The sentinels
  // also carry nodes inserted later by a child's reactive visible-if branch.
  const mounted = unpinned.map((child, index) => {
    const start = document.createComment(`dsx:scaffold:${index}:start`);
    const end = document.createComment(`dsx:scaffold:${index}:end`);
    custom.appendChild(start);
    api.children(custom, [child]);
    custom.appendChild(end);
    return { child, start, end };
  });
  shell.append(custom, nav, main, aside);
  root.appendChild(shell);
  if (bottom.length > 0) root.appendChild(pin("footer", "dsx-scaffold-pin dsx-scaffold-pin-bottom", bottom));

  let placedAdaptive: boolean | undefined;
  const moveRange = (target: HTMLElement, start: Comment, end: Comment): void => {
    let current: ChildNode | null = start;
    while (current !== null) {
      const next: ChildNode | null = current.nextSibling;
      target.appendChild(current);
      if (current === end) break;
      current = next;
    }
  };
  const place = (adaptive: boolean): void => {
    if (placedAdaptive === adaptive) return;
    for (const range of mounted) {
      const target = !adaptive ? custom
        : range.child.attrs["pane"] === "sidebar" ? nav
        : range.child.attrs["pane"] === "inspector" ? aside
        : main;
      moveRange(target, range.start, range.end);
    }
    placedAdaptive = adaptive;
  };

  const apply = (): void => {
    const plan = resolveAdaptiveShell(resolvedAttrs, measuredWidth, false, {
      sidebar: sidebar.length > 0,
      content: content.length > 0,
      inspector: inspector.length > 0,
    });
    place(plan.mode !== "custom" && sidebar.length > 0 && content.length > 0);
    shell.dataset["dsxLayout"] = plan.layout;
    shell.dataset["dsxMode"] = plan.mode;
    shell.dataset["dsxCollapse"] = plan.collapse;
    root.style.setProperty("--dsx-shell-compact-at", `${plan.compactAt}px`);
    root.style.setProperty("--dsx-sidebar-min", `${plan.sidebar.min}px`);
    root.style.setProperty("--dsx-sidebar-ideal", `${plan.sidebar.ideal}px`);
    root.style.setProperty("--dsx-sidebar-max", `${plan.sidebar.max}px`);
    root.style.setProperty("--dsx-inspector-min", `${plan.inspector.min}px`);
    root.style.setProperty("--dsx-inspector-ideal", `${plan.inspector.ideal}px`);
    root.style.setProperty("--dsx-inspector-max", `${plan.inspector.max}px`);
    nav.setAttribute("aria-label", resolvedAttrs["sidebarLabel"] || "Sidebar");
    main.setAttribute("aria-label", resolvedAttrs["contentLabel"] || "Content");
    aside.setAttribute("aria-label", resolvedAttrs["inspectorLabel"] || "Inspector");
  };

  for (const name of [
    "shell", "collapse", "compactAt",
    "sidebarMin", "sidebarIdeal", "sidebarMax",
    "inspectorMin", "inspectorIdeal", "inspectorMax",
    "sidebarLabel", "contentLabel", "inspectorLabel",
  ]) {
    const expression = node.attrs[name];
    if (expression !== undefined) api.bindText(expression, (value) => { resolvedAttrs[name] = value; apply(); });
  }
  apply();

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) { measuredWidth = width; apply(); }
    });
    observer.observe(root);
    ctx.disposers.push(() => observer.disconnect());
  } else {
    queueMicrotask(() => {
      measuredWidth = root.getBoundingClientRect?.().width ?? 0;
      apply();
    });
  }
  return root;
};

/** `lineLimit=` — the native `Text.lineLimit(n)` + tail truncation (Stack.swift:6124).
 *  The browser twin is the line-clamp box: n visual lines, an ellipsis on the last.
 *  Returned as DECLARATIONS (not a sheet rule) so the common `<text>` path in a sliced
 *  embed pays nothing for an attribute it does not author, and so the SSR twin emits a
 *  byte-identical inline style. "" = no clamp (absent, zero, negative, unparseable). */
export const LINE_CLAMP_MAX = 1_000;

/** A bare BOOLEAN attribute word (`markdown="true"`). Deliberately NOT `truthy()`:
 *  every non-empty string is JSE-truthy, so `markdown="false"` would turn markdown ON.
 *  The native reference compares the string (`dsx.string("markdown") == "true"`), and
 *  @despia/server's `booleanAttribute` is the same predicate. */
export function booleanWord(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "1";
}

/** The DECLARED control-boolean read (`disabled="false"`, `disabled="{{ locked }}"`).
 *  Mirrors the Swift component reader (`dsx.bool`: `s == "true" || Double(s) != 0`) and the
 *  Kotlin `SelectionControl.declaredBool` twin, NOT `truthy()`: truthy("false") is true by
 *  the JSE string law, so the truthy read DISABLED a control the author explicitly enabled —
 *  on web and Android, while iOS honored the author. A bound `{{ locked }}` arrives "1"/""
 *  here, which is why the empty string stays false (unlike `booleanWord`, whose bare-word
 *  spelling has no bound form). */
export function declaredBool(value: string): boolean {
  const v = value.trim();
  if (v === "true") return true;
  const n = Number(v);
  return v !== "" && !Number.isNaN(n) && n !== 0;
}

// ── the `<list axis="horizontal" autoscroll="N">` MARQUEE (List.swift StackMarquee) ──
//
//  N is points/second. The loop is SEAMLESS with no cloned DOM: once the leading row has
//  scrolled fully out it is appended and the offset rewound by its extent, so a keyed
//  bound collection keeps exactly the rows its reconciler owns (a duplicated track would
//  fork row identity). Reduced motion stands the whole thing down, and the rail pauses
//  under the pointer — a marquee the reader cannot stop is an accessibility failure.
//  Shared by the static factory (structural-controls.ts) and the bound reconciler
//  (mount.ts); both reach it through this base module, so neither imports the other.
export const MARQUEE_MAX_SPEED = 10_000;

export type Marquee = { setSpeed(value: unknown): void; sync(): void; stop(): void };

export function createMarquee(container: HTMLElement, horizontal: () => boolean): Marquee {
  let speed = 0;
  let frame = 0;
  let last = 0;
  const reduced = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const paused = (): boolean =>
    typeof container.matches === "function" && (container.matches(":hover") || container.matches(":focus-within"));
  const step = (now: number): void => {
    frame = requestAnimationFrame(step);
    if (last === 0) { last = now; return; }
    const seconds = Math.min(now - last, 100) / 1000;
    last = now;
    if (paused()) return;
    container.scrollLeft += speed * seconds;
    const first = container.children[0] as HTMLElement | undefined;
    if (first === undefined) return;
    const second = container.children[1] as HTMLElement | undefined;
    const left = first.getBoundingClientRect().left;
    const extent = Math.max(1, second === undefined
      ? first.getBoundingClientRect().width
      : second.getBoundingClientRect().left - left);
    if (container.scrollLeft >= extent) {
      container.appendChild(first);
      container.scrollLeft -= extent;
    }
  };
  const stop = (): void => {
    if (frame === 0) return;
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  };
  const sync = (): void => {
    const run = speed > 0 && horizontal() && !reduced && typeof requestAnimationFrame === "function";
    if (run && frame === 0) frame = requestAnimationFrame(step);
    if (!run) stop();
    container.setAttribute("data-dsx-autoscroll", run ? String(speed) : "false");
  };
  return {
    setSpeed(value) {
      const parsed = number(value);
      speed = parsed !== null && parsed !== undefined && Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, 0), MARQUEE_MAX_SPEED) : 0;
      sync();
    },
    sync,
    stop,
  };
}

export function lineClampLines(raw: string): number | null {
  const lines = number(raw);
  if (lines === null || lines === undefined || !Number.isFinite(lines) || lines < 1) return null;
  return Math.min(Math.trunc(lines), LINE_CLAMP_MAX);
}

export function lineClampStyle(raw: string): string {
  const clamp = lineClampLines(raw);
  return clamp === null
    ? ""
    : `display: -webkit-box; -webkit-line-clamp: ${clamp}; -webkit-box-orient: vertical; overflow: hidden;`;
}

export function applyLineClamp(host: HTMLElement, raw: string): void {
  const clamp = lineClampLines(raw);
  if (clamp === null) {
    host.style.removeProperty("display");
    host.style.removeProperty("-webkit-line-clamp");
    host.style.removeProperty("-webkit-box-orient");
    host.style.removeProperty("overflow");
    return;
  }
  host.style.setProperty("display", "-webkit-box");
  host.style.setProperty("-webkit-line-clamp", String(clamp));
  host.style.setProperty("-webkit-box-orient", "vertical");
  host.style.setProperty("overflow", "hidden");
}

/** `<markdown>` — the BLOCK vocabulary (A4): headings, lists, tables, fenced code,
 *  quotes, images, rules. The inline twin stays on `<text markdown="true">`, which
 *  renders what SwiftUI's Text renders and nothing more.
 *
 *  Folded behind its own define exactly like the inline path, so a slice that authors no
 *  `<markdown>` strips this file: the check lives INSIDE the condition, because a flag
 *  hoisted into a const does not tree-shake (/web/13 byte law). */
const markdownEl: ElementFactory = (node, _ctx, api) => {
  const e = el("div", "dsx-markdown");
  const write = (v: string): void => {
    // Rebuilt rather than patched: a README is written once and re-rendered rarely, and
    // a fragment swap is structurally incapable of leaving half a document on screen.
    while (e.firstChild !== null) e.removeChild(e.firstChild);
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_MARKDOWN__?: boolean })
      .__DSX_OPTIONAL_MARKDOWN__ !== false) {
      e.appendChild(markdownBlocksFragment(v));
    } else {
      e.textContent = v;
    }
  };
  // Same precedence AND the same evaluation split <text> uses: bind= is a JSE
  // expression (the SSR twin evals it, render.ts <markdown> branch), value=/inner
  // text interpolate. Folding bind into bindText rendered the expression string
  // literally on the client while the server painted the real document.
  if (node.attrs["bind"] !== undefined) {
    api.bindValue(node.attrs["bind"], (v) => { write(string(v)); });
  } else if (node.attrs["value"] !== undefined) {
    api.bindText(node.attrs["value"], write);
  } else if (node.text.trim().length > 0) {
    api.bindText(node.text.trim(), write);
  } else {
    write("");
  }
  return e;
};

const textEl: ElementFactory = (node, _ctx, api) => {
  const e = el(node.tag === "label" ? "label" : "span", "dsx-text");
  let write = (v: string): void => { if (e.textContent !== v) e.textContent = v; };
  // `markdown="true"` renders the INLINE markdown vocabulary the native reference
  // renders (`Text(AttributedString(markdown:))`, Text.swift:16). The define is checked
  // INSIDE the `if` CONDITION on purpose: esbuild then folds the whole block away for a
  // slice that authors no `markdown=`, taking markdown.ts with it (/web/13 byte law —
  // a flag checked around a call site, or hoisted into a const, does NOT tree-shake).
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_MARKDOWN__?: boolean })
    .__DSX_OPTIONAL_MARKDOWN__ !== false && node.attrs["markdown"] !== undefined) {
    let on = false;
    let last = "";
    write = (v: string): void => {
      last = v;
      if (on) renderMarkdown(e, v);
      else e.textContent = v;
    };
    // Bound like every other attribute, so an interpolated `markdown=` flips live.
    api.bindText(node.attrs["markdown"], (v) => {
      const next = booleanWord(v);
      if (next === on) return;
      on = next;
      write(last);
    });
  }
  if (node.attrs["bind"] !== undefined) {
    api.bindValue(node.attrs["bind"], (v) => { write(string(v)); });
  } else if (node.attrs["value"] !== undefined) {
    api.bindDisplay(node.attrs["value"], (v) => { write(v); });
  } else if (node.text.trim().length > 0) {
    api.bindDisplay(node.text.trim(), (v) => { write(v); });
  }
  if (node.attrs["lineLimit"] !== undefined) {
    api.bindText(node.attrs["lineLimit"], (v) => applyLineClamp(e, v));
  }
  // `type=` names a rung of the ratified ramp; the element layer carries one rule per role
  // (theme.ts TYPE_ROLE_RULES). Bound like every other attribute so an interpolated role
  // flips live, and an unknown word is DROPPED rather than written: a typo must fall back to
  // the body default, never leave the element styled by an attribute nothing matches.
  if (node.attrs["type"] !== undefined) {
    api.bindText(node.attrs["type"], (v) => {
      const role = v.trim();
      if ((TYPE_ROLES as readonly string[]).includes(role)) e.dataset["dsxType"] = role;
      else delete e.dataset["dsxType"];
    });
  }
  return e;
};

const buttonEl: ElementFactory = (node, _ctx, api) => {
  // `href=` upgrades the control to a REAL anchor (crawlable, cmd/middle-clickable — the
  // /web/04 link contract); the class set and children stay identical, and the click /
  // keyboard / URL wiring rides the generic mount layer (mount.ts href block).
  const hasHref = node.attrs["href"] !== undefined;
  const isPressable = node.tag === "pressable" || node.tag === "row";
  const e = el(hasHref ? "a" : "button", isPressable ? "dsx-pressable" : "dsx-button") as HTMLElement;
  e.setAttribute("data-dsx-component", isPressable ? "pressable" : "button");
  if (!hasHref) (e as HTMLButtonElement).type = "button";
  // variant="bordered|prominent" + role="destructive|cancel" — the system-space
  // variant words (system-defaults.md: select AMONG system renderings, never eject).
  // Stamped as data attributes; the dsx-elements layer carries the tonal / filled /
  // danger / cancel skins, tokens-only. Bound like any attribute, so an interpolated
  // variant swaps live; only the two role WORDS ever stamp (anything else keeps its
  // ARIA meaning in mount.ts).
  if (node.attrs["variant"] !== undefined) {
    api.bindText(node.attrs["variant"], (v) => {
      const t = v.trim();
      if (t.length > 0) e.setAttribute("data-dsx-variant", t);
      else e.removeAttribute("data-dsx-variant");
    });
  }
  if (node.attrs["role"] !== undefined) {
    api.bindText(node.attrs["role"], (v) => {
      const t = v.trim();
      if (BUTTON_ROLES.has(t)) e.setAttribute("data-dsx-role", t);
      else e.removeAttribute("data-dsx-role");
    });
  }
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_DISABLED__?: boolean })
    .__DSX_OPTIONAL_DISABLED__ !== false
    && (node.attrs["disabled"] !== undefined || node.attrs["disabled-if"] !== undefined)) {
    const focusOrder = Number(node.attrs["focusOrder"]);
    const hasFocusOrder = node.attrs["focusOrder"] !== undefined && Number.isFinite(focusOrder);
    let declaredDisabled = false;
    let conditionalDisabled = false;
    let disabled = false;
    const reflectDisabled = (): void => {
      disabled = declaredDisabled || conditionalDisabled;
      if (e.tagName === "BUTTON") {
        (e as HTMLButtonElement).disabled = disabled;
      } else if (disabled) {
        e.setAttribute("aria-disabled", "true");
        e.tabIndex = -1;
      } else {
        e.removeAttribute("aria-disabled");
        // The generic mount layer applies focusOrder after this factory returns. A
        // later reactive enable must restore that authored order instead of erasing
        // it, while an ordinary link returns to its native anchor tab stop.
        if (hasFocusOrder) e.tabIndex = focusOrder;
        else e.removeAttribute("tabindex");
      }
    };
    if (node.attrs["disabled"] !== undefined) {
      api.bindText(node.attrs["disabled"], (value) => {
        declaredDisabled = declaredBool(value);
        reflectDisabled();
      });
    }
    if (node.attrs["disabled-if"] !== undefined) {
      api.bindValue(node.attrs["disabled-if"], (value) => {
        conditionalDisabled = truthy(value);
        reflectDisabled();
      });
    }
    if (hasHref) {
      e.addEventListener("click", (event) => {
        if (!disabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true });
    }
  }
  const iconName = node.attrs["icon-web"] ?? node.attrs["icon"];
  if (
    (globalThis as typeof globalThis & { __DSX_OPTIONAL_ICONS__?: boolean })
      .__DSX_OPTIONAL_ICONS__ !== false
    && iconName !== undefined
  ) {
    const defaultIconSize = node.attrs["label"] === undefined ? 20 : 17;
    const size = number(node.attrs["iconSize"] ?? String(defaultIconSize)) ?? defaultIconSize;
    api.bindText(iconName, (v) => {
      e.querySelector("svg")?.remove();
      if (v.length > 0) {
        const icon = iconSvg(v, size);
        icon.setAttribute("data-dsx-part", "icon");
        e.prepend(icon);
      }
    });
  }
  if (node.attrs["label"] !== undefined) {
    const span = document.createElement("span");
    span.setAttribute("data-dsx-part", "label");
    e.appendChild(span);
    api.bindDisplay(node.attrs["label"], (v) => { span.textContent = v; });
  }
  // Pressables/rows always own arbitrary content. A canonical button falls back to
  // its slot only when neither label nor icon is supplied, matching native precedence.
  if (isPressable || (node.attrs["label"] === undefined && iconName === undefined)) api.children(e);
  if (node.attrs["a11yLabel"] !== undefined) {
    api.bindText(node.attrs["a11yLabel"], (v) => e.setAttribute("aria-label", v));
  }
  // on:tap wiring is generic (mount.ts) — buttons only contribute semantics here.
  // on:doubleTap fires ADDITIONALLY on the second tap (Pressable.swift: on:tap keeps
  // firing on each tap of a double — the double is a simultaneous gesture).
  if (api.hasHandler("doubleTap")) e.addEventListener("dblclick", () => api.handler("doubleTap"));
  return e;
};

/** Monotonic, deterministic cache-bust key for `cache="none"` (never Math.random —
 *  the runtime forbids it, and a reproducible key keeps a diff readable). */
let cacheBustCounter = 0;
function nextCacheBustKey(): string {
  cacheBustCounter += 1;
  return `${Date.now().toString(36)}${cacheBustCounter.toString(36)}`;
}

/** `asset=` is the NATIVE bundled-image-set key (Image.swift:28). A browser has no app
 *  bundle, so the only value web can honor is one that already reads as a URL/path —
 *  which is exactly what a web author writes. A bare key ("AppLogo") is a native-only
 *  spelling: it is REPORTED on the element, never silently swallowed. */
export function assetImageSource(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) return null;
  if (value.includes("/") || value.includes("\\") || /\.[a-z0-9]{2,5}$/i.test(value)) return value;
  return null;
}

const imageEl: ElementFactory = (node, _ctx, api) => {
  // Image.swift:17 — an image with NO a11yLabel is DECORATIVE and hidden from assistive
  // technology; an authored label promotes it to a named image.
  const a11yLabel = node.attrs["a11yLabel"];
  const iconName = node.attrs["icon-web"] ?? node.attrs["icon"] ?? node.attrs["systemImage"];
  if (
    (globalThis as typeof globalThis & { __DSX_OPTIONAL_ICONS__?: boolean })
      .__DSX_OPTIONAL_ICONS__ !== false
    && iconName !== undefined
  ) {
    // iconSize ?? fontSize ?? 24 — the fixture default verbatim (Image.swift:20-21).
    const size = number(node.attrs["iconSize"] ?? node.attrs["fontSize"] ?? "24") ?? 24;
    const wrap = el("span", "dsx-image dsx-icon");
    if (a11yLabel === undefined) wrap.setAttribute("aria-hidden", "true");
    else {
      wrap.setAttribute("role", "img");
      api.bindText(a11yLabel, (v) => wrap.setAttribute("aria-label", v));
    }
    // An unstyled symbol rides the semantic label slot; an authored color wins.
    bindSemanticColor(node, api, wrap, "color");
    api.bindText(iconName, (v) => {
      wrap.replaceChildren();
      if (v.length > 0) wrap.appendChild(iconSvg(v, size));
    });
    return wrap;
  }
  const e = el("img", "dsx-image") as HTMLImageElement;
  // alt="" is the DOM spelling of "decorative": the a11y tree skips it entirely.
  e.alt = node.attrs["alt"] ?? "";
  if (a11yLabel !== undefined) api.bindText(a11yLabel, (v) => { e.alt = v; });
  // `cache="none"` must fetch fresh (Image.swift:38). The browser twin of "skip the
  // cached bytes" is a per-mount cache-bust key; the default rides the normal HTTP
  // cache, which IS the platform's own memory/disk tier.
  const bust = node.attrs["cache"] === "none" ? `dsx-nc=${nextCacheBustKey()}` : "";
  // U05: contentFit/contentPosition/placeholder/transition/priority/cachePolicy and the
  // load+error handlers, all off the shared image core (Conformance/image/resolution.json).
  const dsxImage = applyImageAttributes(e, node.attrs, api);
  const setSource = (raw: string): void => {
    const v = admitSrc(e, raw);
    if (v.length === 0) return;
    const url = bust.length === 0 ? v : `${v}${v.includes("?") ? "&" : "?"}${bust}`;
    // `update` runs FIRST and only manages the recycling ladder: on a reused row it drops the
    // stale src in the same turn as the identity change, which is the whole point of clearing
    // before the new bytes arrive. It does not assign the source, so the write below still is
    // the assignment.
    dsxImage.update({ src: url });
    e.src = url;
  };
  if (node.attrs["src"] !== undefined) api.bindText(node.attrs["src"], setSource);
  else if (node.attrs["asset"] !== undefined) {
    api.bindText(node.attrs["asset"], (v) => {
      const source = assetImageSource(v);
      if (source !== null) {
        e.removeAttribute("data-dsx-unresolved");
        setSource(source);
        return;
      }
      // A native bundle key: nothing for a browser to load. Marked so the gap is
      // inspectable (and keeps its accessible name) rather than a mystery blank box.
      e.removeAttribute("src");
      e.setAttribute("data-dsx-unresolved", "asset");
    });
  }
  return e;
};

const scroll: ElementFactory = (node, _ctx, api) => {
  const e = el("div", "dsx-scroll");
  api.bindText(node.attrs["axis"] ?? node.attrs["direction"] ?? "vertical", (value) => {
    e.classList.toggle("dsx-scroll-x", value === "horizontal");
  });
  api.children(e);
  // U01: metrics, snap, paging, insets, the scroll-linked custom properties and the
  // scroll/scrollEnd/reachEnd handlers (Conformance/scroll/*.json).
  applyScrollBehaviour(e, node.attrs, api);
  return e;
};

const spacer: ElementFactory = () => el("div", "dsx-spacer");
const divider: ElementFactory = (node, _ctx, api) => {
  const line = el("div", "dsx-divider");
  bindSemanticColor(node, api, line, "--dsx-divider-color");
  return line;
};

/** disabled= / disabled-if= on the interactive control set (the W9 grammar wave): the
 *  pair reflects into the factory's real control(s) — native `disabled`, so the CSS
 *  state selectors, focusability, and event suppression all follow the platform —
 *  exactly the button family's contract above, sharing its define. Zero cost when the
 *  element authors neither spelling. */
function bindControlDisabled(
  node: XmlNode,
  api: ElementApi,
  apply: (disabled: boolean) => void,
): void {
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_DISABLED__?: boolean })
    .__DSX_OPTIONAL_DISABLED__ === false) return;
  if (node.attrs["disabled"] === undefined && node.attrs["disabled-if"] === undefined) return;
  let declared = false;
  let conditional = false;
  const reflect = (): void => apply(declared || conditional);
  if (node.attrs["disabled"] !== undefined) {
    api.bindText(node.attrs["disabled"], (value) => { declared = declaredBool(value); reflect(); });
  }
  if (node.attrs["disabled-if"] !== undefined) {
    api.bindValue(node.attrs["disabled-if"], (value) => { conditional = truthy(value); reflect(); });
  }
}

const toggle: ElementFactory = (node, _ctx, api) => {
  // the /web/17 anatomy verbatim: semantics ride the real <input>, parts are aria-hidden
  const label = el("label", "dsx-toggle");
  label.setAttribute("data-dsx-component", "toggle");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.setAttribute("data-dsx-part", "input");
  const track = el("span", "dsx-toggle-track");
  track.setAttribute("aria-hidden", "true");
  track.setAttribute("data-dsx-part", "track");
  const thumb = el("span", "dsx-toggle-thumb");
  thumb.setAttribute("data-dsx-part", "thumb");
  bindSemanticColor(node, api, label, "--dsx-control-tint");
  track.appendChild(thumb);
  label.append(input, track);
  api.bindValue(node.attrs["bind"], (v) => { input.checked = truthy(v); });
  input.addEventListener("change", () => {
    api.writeBack(node.attrs["bind"], input.checked);
    api.handler("change", { value: input.checked });
  });
  bindControlDisabled(node, api, (disabled) => { input.disabled = disabled; });
  return label;
};

const slider: ElementFactory = (node, _ctx, api) => {
  const input = el("input", "dsx-slider") as HTMLInputElement;
  input.type = "range";
  input.setAttribute("data-dsx-component", "slider");
  input.setAttribute("data-dsx-part", "control");
  input.min = node.attrs["min"] ?? "0";
  input.max = node.attrs["max"] ?? "1";
  input.step = node.attrs["step"] ?? "any";
  bindSemanticColor(node, api, input, "--dsx-control-tint");
  const reflectPosition = (): void => {
    const minimum = Number(input.min);
    const maximum = Number(input.max);
    const value = Number(input.value);
    const position = Number.isFinite(minimum) && Number.isFinite(maximum) && Number.isFinite(value) && maximum > minimum
      ? Math.min(100, Math.max(0, ((value - minimum) / (maximum - minimum)) * 100))
      : 0;
    input.style.setProperty("--dsx-slider-position", `${position}%`);
  };
  api.bindValue(node.attrs["bind"], (v) => {
    input.value = string(number(v) ?? 0);
    reflectPosition();
  });
  // An unbound native range defaults to its midpoint. Paint the custom fill from
  // that real DOM value too, rather than leaving a misleading zero-percent rail.
  reflectPosition();
  input.addEventListener("input", () => {
    reflectPosition();
    api.writeBack(node.attrs["bind"], Number(input.value));
    api.handler("change", { value: Number(input.value) });
  });
  bindControlDisabled(node, api, (disabled) => { input.disabled = disabled; });
  return input;
};

/** `keyboard=` → the browser's soft-keyboard contract. The DSX token set is
 *  TextField.swift's map (:78-90); each row picks the `inputmode` (which keyboard the
 *  OS raises) and, where a real input TYPE exists, the type that carries the same
 *  semantics. `type` is never changed for a secure or search field. */
export const KEYBOARD_MODES: {
  readonly [token: string]: { readonly inputMode: string; readonly type?: string };
} = {
  email: { inputMode: "email", type: "email" },
  number: { inputMode: "numeric" },
  decimal: { inputMode: "decimal" },
  phone: { inputMode: "tel", type: "tel" },
  url: { inputMode: "url", type: "url" },
  ascii: { inputMode: "text" },
  twitter: { inputMode: "text" },
  websearch: { inputMode: "search" },
};

/** `contentType=` → the HTML autofill token. The DSX spelling is UITextContentType's
 *  (TextField.swift:41); the values below are the WHATWG autofill field names that mean
 *  the same thing, so a browser password manager fills what iOS AutoFill fills. */
export const CONTENT_TYPE_AUTOCOMPLETE: { readonly [token: string]: string } = {
  name: "name", givenName: "given-name", familyName: "family-name",
  middleName: "additional-name", namePrefix: "honorific-prefix", nameSuffix: "honorific-suffix",
  nickname: "nickname", jobTitle: "organization-title", organizationName: "organization",
  emailAddress: "email", telephoneNumber: "tel", URL: "url",
  username: "username", password: "current-password", newPassword: "new-password",
  oneTimeCode: "one-time-code",
  fullStreetAddress: "street-address", streetAddressLine1: "address-line1",
  streetAddressLine2: "address-line2", addressCity: "address-level2",
  addressState: "address-level1", postalCode: "postal-code", countryName: "country-name",
  creditCardNumber: "cc-number", creditCardName: "cc-name",
  creditCardExpiration: "cc-exp", creditCardExpirationMonth: "cc-exp-month",
  creditCardExpirationYear: "cc-exp-year", creditCardSecurityCode: "cc-csc",
  none: "off",
};

/** Resolve the two keyboard-hint attributes to their DOM spelling. Own-property lookup
 *  only, so an authored token can never reach `Object.prototype`; an unknown token
 *  leaves the platform default in place, exactly as an unknown UITextContentType does
 *  on iOS. DOM-free on purpose — @despia/server emits the SAME answer during SSR. */
export function applyKeyboardHintAttributes(
  attrs: { readonly [k: string]: string },
  secure: boolean,
  search: boolean,
): { type?: string; inputmode?: string; autocomplete?: string } {
  const out: { type?: string; inputmode?: string; autocomplete?: string } = {};
  if (secure) out.type = "password";
  else if (search) out.type = "search";
  const keyboard = attrs["keyboard"];
  if (keyboard !== undefined && Object.prototype.hasOwnProperty.call(KEYBOARD_MODES, keyboard)) {
    const mode = KEYBOARD_MODES[keyboard]!;
    out.inputmode = mode.inputMode;
    if (mode.type !== undefined && !secure && !search) out.type = mode.type;
  }
  const contentType = attrs["contentType"];
  if (contentType !== undefined
    && Object.prototype.hasOwnProperty.call(CONTENT_TYPE_AUTOCOMPLETE, contentType)) {
    out.autocomplete = CONTENT_TYPE_AUTOCOMPLETE[contentType]!;
  }
  return out;
}

function applyKeyboardHints(node: XmlNode, input: HTMLInputElement, secure: boolean, search: boolean): void {
  const hints = applyKeyboardHintAttributes(node.attrs, secure, search);
  if (hints.type !== undefined) input.type = hints.type;
  if (hints.inputmode !== undefined) input.setAttribute("inputmode", hints.inputmode);
  if (hints.autocomplete !== undefined) input.setAttribute("autocomplete", hints.autocomplete);
}

/** The two `<searchbar>` chrome glyphs. These are control PARTS (like the toggle's
 *  track/thumb or the stepper's − / +), not `icon=` tokens, so they are drawn here
 *  rather than looked up in the shared SF table: a chrome affordance must never depend
 *  on a name being present in the cross-runtime icon corpus. */
export const SEARCHBAR_GLYPHS = {
  glass: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4.2-4.2",
  clear: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 9l6 6M15 9l-6 6",
} as const;

function controlGlyph(d: string, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  // AXIS v2 (sf-map.json _web_axis): the corpus web paths are Boxicons FILL paths,
  // painted with the current color - the stroke tier retired with the hand-drawn set.
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

/** `<searchbar>` composite anatomy (/web/17): the semantics ride the SAME real input,
 *  wrapped by the leading magnifying glass and the trailing clear button
 *  SearchBar.swift draws (`magnifyingglass` + `xmark.circle.fill`, the clear present
 *  only while the field is non-empty). Clearing writes the bound path back to "" and
 *  fires `on:change` then `on:clear` (SearchBar.swift:50-52), keeping keyboard focus
 *  exactly like the native @FocusState does. */
function searchBarShell(node: XmlNode, api: ElementApi, input: HTMLInputElement): HTMLElement {
  const wrap = el("div", "dsx-searchbar-field");
  wrap.setAttribute("data-dsx-component", "search-field");
  // The wrapper is presentational; the input keeps every semantic. Its own component
  // stamp moves off the input so a11y and adopt still see exactly one search field.
  input.setAttribute("data-dsx-component", "search-input");
  const lead = el("span", "dsx-searchbar-icon");
  lead.setAttribute("aria-hidden", "true");
  lead.setAttribute("data-dsx-part", "icon");
  lead.appendChild(controlGlyph(SEARCHBAR_GLYPHS.glass, 17));
  wrap.appendChild(lead);
  const clear = el("button", "dsx-searchbar-clear") as HTMLButtonElement;
  clear.type = "button";
  clear.setAttribute("data-dsx-part", "clear");
  clear.setAttribute("aria-label", "Clear search");
  clear.appendChild(controlGlyph(SEARCHBAR_GLYPHS.clear, 17));
  const reflectClear = (): void => { clear.hidden = input.value.length === 0; };
  input.addEventListener("input", reflectClear);
  const clearField = (): void => {
    input.value = "";
    reflectClear();
    api.writeBack(node.attrs["bind"], "");
    api.handler("change", { value: "" });
    api.handler("clear", { value: "" });
  };
  clear.addEventListener("click", () => {
    clearField();
    input.focus();
  });
  // A browser `type=search` also clears from its own cancel affordance / Escape and
  // raises `search`; route that through the SAME contract instead of a silent write.
  input.addEventListener("search", () => { if (input.value.length === 0) clearField(); });
  bindSemanticColor(node, api, wrap, "--dsx-searchbar-color");
  wrap.append(input, clear);
  reflectClear();
  // The bound value arrives on the first effect flush, after this factory returns.
  queueMicrotask(reflectClear);
  return wrap;
}

const textfield: ElementFactory = (node, _ctx, api) => {
  const search = node.tag === "searchbar";
  const secure = node.attrs["secure"] === "true";
  const input = el("input", search ? "dsx-textfield dsx-searchbar" : "dsx-textfield") as HTMLInputElement;
  input.type = secure ? "password" : search ? "search" : "text";
  input.setAttribute("data-dsx-component", search ? "search-field" : "text-field");
  input.setAttribute("data-dsx-part", "control");
  applyKeyboardHints(node, input, secure, search);
  if (node.attrs["placeholder"] !== undefined || search) {
    // SearchBar.swift:41 — the placeholder DEFAULT is "Search", not empty.
    api.bindDisplay(node.attrs["placeholder"] ?? (search ? "Search" : ""), (v) => { input.placeholder = v; });
  }
  api.bindValue(node.attrs["bind"], (v) => {
    const s = string(v);
    if (input.value !== s) input.value = s;
  });
  input.addEventListener("input", () => {
    api.writeBack(node.attrs["bind"], input.value);
    api.handler("change", { value: input.value });
  });
  // on:focus / on:blur / on:submit — the TextField.swift contract (submit = the
  // return key); payload rides dsx.this as { value }, like on:change.
  if (api.hasHandler("focus")) input.addEventListener("focus", () => api.handler("focus", { value: input.value }));
  if (api.hasHandler("blur")) input.addEventListener("blur", () => api.handler("blur", { value: input.value }));
  if (api.hasHandler("submit")) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") api.handler("submit", { value: input.value });
    });
  }
  bindControlDisabled(node, api, (disabled) => { input.disabled = disabled; });
  return search ? searchBarShell(node, api, input) : input;
};

/** minLines/maxLines normalization — the twin of `DSXFoundationInputPolicy
 *  .textAreaLineCount` (TextArea.swift:34-40): a bounded positive integer, and a
 *  reversed pair (max < min) normalizes by swapping, never by trapping. */
export const TEXTAREA_LINE_LIMITS = { min: 1, max: 64 } as const;

export function textAreaLineCount(value: unknown, fallback: number): number {
  const parsed = number(value);
  if (parsed === null || parsed === undefined || !Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), TEXTAREA_LINE_LIMITS.min), TEXTAREA_LINE_LIMITS.max);
}

const textareaEl: ElementFactory = (node, _ctx, api) => {
  const area = el("textarea", "dsx-textarea") as HTMLTextAreaElement;
  let submitOnEnter = false;
  area.setAttribute("data-dsx-component", "text-area");
  area.setAttribute("data-dsx-part", "control");
  const declaredMin = textAreaLineCount(node.attrs["minLines"] ?? "3", 3);
  const declaredMax = textAreaLineCount(node.attrs["maxLines"] ?? "8", 8);
  const minLines = Math.min(declaredMin, declaredMax);
  const maxLines = Math.max(declaredMin, declaredMax);
  area.rows = minLines;
  // `lineLimit(min...max)` on iOS grows the field with its RENDERED lines and then scrolls,
  // and the floor is minLines rather than a fixed height. Both bounds ride the sheet so the
  // box is sized by the author's numbers, never by a hardcoded rem.
  area.style.setProperty("--dsx-textarea-max-lines", String(maxLines));
  area.style.setProperty("--dsx-textarea-min-lines", String(minLines));
  // GROWTH IS MEASURED, NOT COUNTED. Counting "\n" grows the box for typed newlines and
  // ignores every SOFT-wrapped line, so a tagline typed as one long sentence stayed one row
  // tall on the web while iOS grew it - the field scrolled its own content away as you
  // typed. Measuring the laid-out content is the only definition that matches what the
  // reader sees, and it is what makes the three renderers agree.
  const autoGrow = (): void => {
    const counted = area.value.length === 0 ? minLines : area.value.split("\n").length;
    let wanted = counted;
    // A DOM SHIM HAS NO LAYOUT, and it is a legitimate host: the unit suites mount elements
    // against one, and a server render has no view either. Reach for the window defensively
    // and fall through to the counted estimate rather than throwing inside an input handler.
    const view = area.ownerDocument?.defaultView ?? null;
    if (view !== null && typeof view.getComputedStyle === "function") {
      // Shrink to the floor first: scrollHeight reports the LARGER of content and box, so a
      // box already grown never reports a smaller content and the field could only ever
      // ratchet upward.
      area.rows = minLines;
      const cs = view.getComputedStyle(area);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const inner = area.scrollHeight - pad;
      // Environments without layout (a server render, a DOM shim) report 0 here; the counted
      // fallback keeps those correct rather than collapsing every field to one line.
      if (line > 0 && inner > 0) wanted = Math.max(Math.round(inner / line), 1);
    }
    const rows = Math.min(Math.max(wanted, minLines), maxLines);
    if (area.rows !== rows) area.rows = rows;
  };
  if (node.attrs["placeholder"] !== undefined) {
    api.bindText(node.attrs["placeholder"], (v) => { area.placeholder = v; });
  }
  api.bindValue(node.attrs["bind"], (v) => {
    const s = string(v);
    if (area.value !== s) area.value = s;
    autoGrow();
  });
  // MEASURE AGAIN ONCE THERE IS A LAYOUT. The initial value arrives through bindValue while
  // the element is still being built, so it is not in the document yet: getComputedStyle
  // answers for an unattached node, scrollHeight is 0, and the measured path falls through to
  // the counted estimate - one row for a value that wraps to three. The field then opened
  // clipped and only corrected itself when someone typed in it. One deferred pass fixes every
  // bound textarea; it is a no-op when the counted estimate was already right.
  queueMicrotask(autoGrow);
  area.addEventListener("input", () => {
    autoGrow();
    api.writeBack(node.attrs["bind"], area.value);
    api.handler("change", { value: area.value });
  });
  // A USER-RESIZABLE BOX IS A DECISION, and it belongs to the author. The default stays
  // `vertical` - prose fields want it - but a textarea laid UNDER a highlighted view (a code
  // surface) cannot have its height dragged out from under the layer it is aligned to, and
  // there was no spelling for saying so. Native text views have no user resize handle, so
  // `none` is what iOS and Android already do; this is the web catching up to them.
  if (node.attrs["resize"] === "none") area.style.resize = "none";
  // `on:submit` on a MULTILINE field. Return already means "newline" here and keeps meaning it;
  // what this adds is the two ways a hardware keyboard says "send" - the primary-modifier chord
  // (Cmd/Ctrl+Return), always available, and bare Return when the author wrote `submitOnEnter`.
  // The decision itself is the shared grammar (Conformance/input/multiline-submit.json), so the
  // browser cannot drift from the native lanes on which chord does what.
  if (api.hasHandler("submit")) {
    // The exact word `true`, NOT JSE truthy(): truthy("false") is true by the JSE string law,
    // so the truthy read made `submitOnEnter="false"` submit on web while all three native
    // renderers (== "true" / the strict bool read) inserted the newline the author asked for.
    api.bindText(node.attrs["submitOnEnter"] ?? "", (raw) => { submitOnEnter = raw.trim() === "true"; });
    area.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      const action = multilineReturn(
        { key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey },
        submitOnEnter, true,
      );
      // `ignore` is NOT `newline`: it means this grammar has no opinion, so the event must
      // reach the field untouched rather than being consumed into nothing.
      if (action !== "submit") return;
      e.preventDefault();
      api.handler("submit", { value: area.value });
    });
  }
  // focus/blur mirror textfield
  if (api.hasHandler("focus")) area.addEventListener("focus", () => api.handler("focus", { value: area.value }));
  if (api.hasHandler("blur")) area.addEventListener("blur", () => api.handler("blur", { value: area.value }));
  bindControlDisabled(node, api, (disabled) => { area.disabled = disabled; });
  return area;
};

const progress: ElementFactory = (node, _ctx, api) => {
  const wrap = el("div", "dsx-progress");
  wrap.setAttribute("role", "progressbar");
  wrap.setAttribute("aria-valuemin", "0");
  wrap.setAttribute("aria-valuemax", "1");
  const fill = el("div", "dsx-progress-fill");
  fill.setAttribute("aria-hidden", "true");
  wrap.appendChild(fill);
  const max = number(node.attrs["max"] ?? "1") ?? 1;
  const apply = (v: unknown): void => {
    const n = Math.min(Math.max((number(v) ?? 0) / (max === 0 ? 1 : max), 0), 1);
    fill.style.width = `${n * 100}%`;
    wrap.setAttribute("aria-valuenow", String(n));
  };
  // both spellings, like ProgressRing's bindNumber: "{{ expr }}" interpolates, bare evals -
  // the same value= must mean the same thing on every progress surface
  const expr = node.attrs["bind"] ?? node.attrs["value"];
  if (expr !== undefined && expr.includes("{{")) api.bindText(expr, (v) => apply(v));
  else api.bindValue(expr, apply);
  return wrap;
};

const spinner: ElementFactory = (node, _ctx, api) => {
  const e = el("div", "dsx-spinner");
  e.setAttribute("role", "status");
  e.setAttribute("aria-label", node.attrs["a11yLabel"] ?? "Loading");
  bindSemanticColor(node, api, e, "--dsx-spinner-color");
  if (node.attrs["scale"] !== undefined) {
    api.bindText(node.attrs["scale"], (value) => {
      e.style.setProperty("--dsx-spinner-scale", String(normalizeSpinnerScale(value)));
    });
  }
  return e;
};

/** Press-and-hold repeat, the twin of SwiftUI Stepper's own auto-repeat: one immediate
 *  step, a hold delay, then accelerating repeats down to a floor interval. */
export const STEPPER_REPEAT: {
  readonly delayMs: number; readonly startMs: number; readonly minMs: number; readonly decay: number;
} = { delayMs: 500, startMs: 240, minMs: 60, decay: 0.82 };

const stepper: ElementFactory = (node, _ctx, api) => {
  const wrap = el("div", "dsx-stepper");
  wrap.setAttribute("role", "group");
  const minus = el("button", "dsx-stepper-btn") as HTMLButtonElement;
  minus.type = "button";
  minus.textContent = "−";
  const valueEl = el("span", "dsx-stepper-value");
  valueEl.setAttribute("aria-live", "polite");
  valueEl.setAttribute("aria-atomic", "true");
  const plus = el("button", "dsx-stepper-btn") as HTMLButtonElement;
  plus.type = "button";
  plus.textContent = "+";
  const visibleLabel = node.attrs["label"];
  const label = node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? visibleLabel ?? "Value";
  api.bindText(label, (value) => {
    const name = value.trim() || "Value";
    wrap.setAttribute("aria-label", name);
    minus.setAttribute("aria-label", `Decrease ${name}`);
    plus.setAttribute("aria-label", `Increase ${name}`);
  });
  // `label` is a VISIBLE caption on the native control (Stepper.swift:19 renders it as
  // the Stepper's own label view) as well as the accessible name of the group. It only
  // exists in the DOM when authored — an unlabelled stepper stays exactly ± value ±.
  if (visibleLabel !== undefined) {
    const caption = el("span", "dsx-stepper-label");
    caption.setAttribute("data-dsx-part", "label");
    wrap.appendChild(caption);
    api.bindText(visibleLabel, (value) => {
      caption.textContent = value;
      caption.hidden = value.trim().length === 0;
    });
  }
  bindSemanticColor(node, api, wrap, "--dsx-stepper-color");
  wrap.append(minus, valueEl, plus);
  const step = number(node.attrs["step"] ?? "1") ?? 1;
  const min = number(node.attrs["min"] ?? "0") ?? 0;
  const max = number(node.attrs["max"] ?? "100") ?? 100;
  let current = 0;
  let forced = false;
  const reflect = (): void => {
    valueEl.textContent = string(current);
    minus.disabled = forced || current <= min;
    plus.disabled = forced || current >= max;
  };
  bindControlDisabled(node, api, (disabled) => { forced = disabled; reflect(); });
  api.bindValue(node.attrs["bind"], (v) => {
    current = number(v) ?? 0;
    reflect();
  });
  const bump = (delta: number): void => {
    let next = current + delta;
    if (next < min) next = min;
    if (next > max) next = max;
    if (next === current) return;
    current = next;
    reflect();
    api.writeBack(node.attrs["bind"], next);
    api.handler("change", { value: next });
  };
  // Press-and-hold acceleration. Only a POINTER hold repeats — a keyboard Enter repeat
  // is the platform's own and must not double-step.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopRepeat = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const startRepeat = (button: HTMLButtonElement, delta: number): void => {
    stopRepeat();
    let interval = STEPPER_REPEAT.startMs;
    const tick = (): void => {
      if (button.disabled) { stopRepeat(); return; }
      bump(delta);
      interval = Math.max(STEPPER_REPEAT.minMs, interval * STEPPER_REPEAT.decay);
      timer = setTimeout(tick, interval);
    };
    timer = setTimeout(tick, STEPPER_REPEAT.delayMs);
  };
  for (const [button, delta] of [[minus, -step], [plus, step]] as const) {
    button.addEventListener("click", () => bump(delta));
    button.addEventListener("pointerdown", () => startRepeat(button, delta));
    for (const stop of ["pointerup", "pointercancel", "pointerleave", "blur"]) {
      button.addEventListener(stop, stopRepeat);
    }
  }
  return wrap;
};

// ── richer native primitives ───────────────────────────────────────────────────────

export { segmentOptions } from "@despia/compiler/options";

const segmented: ElementFactory = (node, ctx, api) => {
  const group = el("div", "dsx-segmented");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", node.attrs["label"] ?? node.attrs["a11yLabel"] ?? "Selection");
  group.setAttribute("data-dsx-component", "segmented");
  const indicator = el("span", "dsx-segmented-indicator");
  indicator.setAttribute("data-dsx-part", "indicator");
  indicator.setAttribute("aria-hidden", "true");

  const valueField = node.attrs["valueField"] ?? "id";
  const labelField = node.attrs["labelField"] ?? "label";
  let options: SegmentOption[] = [];
  let selected: unknown = undefined;
  let controls: HTMLButtonElement[] = [];
  let resizeObserver: ResizeObserver | null = null;

  // WHICH OPTION decides whether the pill glides - not which call site asked, and not the
  // measurements. `choose` writes back to the bound store, which re-reflects this control
  // through its own subscription, so one tap positions twice in an order neither call
  // controls; the second measurement also drifts a pixel (76px -> 75px) as the selected
  // label takes its own weight, so "did the size change" reads that noise as a layout
  // event. The selected INDEX is the actual question. A first placement has no option to
  // come from and lands as a fact - that one used to animate the pill in from the whole
  // track's width, because the first measurement is taken pre-layout while option one
  // still spans it. A same-option correction leaves the flag untouched so it retargets a
  // glide already in flight instead of cancelling it, and transitionend clears the flag so
  // a later resize lands instantly.
  let placedIndex = -1;
  let placed: { x: number; y: number; width: number; height: number } | null = null;
  indicator.addEventListener("transitionend", () => indicator.removeAttribute("data-animate"));
  const positionIndicator = (): void => {
    const selectedIndex = options.findIndex((option) => sameValue(option.value, selected));
    const control = controls[selectedIndex];
    if (control === undefined) return;
    const x = control.offsetLeft;
    const y = control.offsetTop;
    const width = control.offsetWidth;
    const height = control.offsetHeight;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
    // Nothing moved: return before touching a single attribute, so a redundant reflect
    // cannot disturb a glide that is still running.
    if (placed !== null && placed.x === x && placed.y === y
      && placed.width === width && placed.height === height) return;
    // A transition that first applies in the same style recalculation as the value change
    // does not run: dropping the flag alongside the write is what makes a placement land
    // instantly, and committing it first is what lets a slide actually animate.
    if (placedIndex >= 0 && placedIndex !== selectedIndex) {
      indicator.setAttribute("data-animate", "true");
      void indicator.offsetWidth;
    } else if (placedIndex < 0) {
      indicator.removeAttribute("data-animate");
    }
    group.style.setProperty("--dsx-segment-indicator-x", `${x}px`);
    group.style.setProperty("--dsx-segment-indicator-y", `${y}px`);
    group.style.setProperty("--dsx-segment-indicator-width", `${width}px`);
    group.style.setProperty("--dsx-segment-indicator-height", `${height}px`);
    placed = { x, y, width, height };
    placedIndex = selectedIndex;
    indicator.setAttribute("data-positioned", "true");
  };
  const scheduleIndicator = (): void => queueMicrotask(positionIndicator);
  const observeGeometry = (): void => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (typeof ResizeObserver === "undefined") return;
    resizeObserver = new ResizeObserver(() => positionIndicator());
    resizeObserver.observe(group);
    controls.forEach((control) => resizeObserver?.observe(control));
  };
  ctx.disposers.push(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  const sameValue = (a: unknown, b: unknown): boolean => Object.is(a, b) || string(a) === string(b);
  let forced = false;
  const reflect = (): void => {
    const selectedIndex = options.findIndex((option) => sameValue(option.value, selected));
    const tabStop = selectedIndex >= 0 ? selectedIndex : 0;
    group.style.setProperty("--dsx-segment-count", String(Math.max(options.length, 1)));
    indicator.hidden = selectedIndex < 0 || options.length === 0;
    if (indicator.hidden) { indicator.removeAttribute("data-positioned"); placed = null; placedIndex = -1; }
    controls.forEach((control, index) => {
      const on = sameValue(options[index]?.value, selected);
      control.disabled = forced;
      control.setAttribute("aria-checked", String(on));
      control.dataset["selected"] = String(on);
      control.tabIndex = index === tabStop ? 0 : -1;
    });
    scheduleIndicator();
  };
  const choose = (index: number, focus = false): void => {
    const option = options[index];
    if (option === undefined) return;
    selected = option.value;
    api.writeBack(node.attrs["bind"], selected);
    api.handler("change", { value: selected });
    reflect();
    if (focus) controls[index]?.focus();
  };
  const render = (next: SegmentOption[]): void => {
    options = next;
    controls = options.map((option, index) => {
      const control = el("button", "dsx-button dsx-segmented-option") as HTMLButtonElement;
      control.type = "button";
      control.setAttribute("role", "radio");
      control.setAttribute("data-dsx-part", "segment");
      control.textContent = option.label;
      control.addEventListener("click", () => choose(index));
      return control;
    });
    // Keep the option buttons first for DOM/back-compat; the absolutely positioned
    // indicator is decorative and deliberately comes last.
    group.replaceChildren(...controls, indicator);
    observeGeometry();
    reflect();
  };

  group.addEventListener("keydown", (event) => {
    if (forced || controls.length === 0) return;
    const current = Math.max(0, options.findIndex((o) => sameValue(o.value, selected)));
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % controls.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + controls.length) % controls.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = controls.length - 1;
    if (next !== null) {
      event.preventDefault();
      choose(next, true);
    }
  });

  if (node.attrs["optionsKey"] !== undefined) {
    api.bindValue(node.attrs["optionsKey"], (v) => render(segmentOptions(v, valueField, labelField)));
  } else {
    api.bindText(node.attrs["options"] ?? "", (v) => {
      render(segmentOptions(v.split(",").map((part) => part.trim()).filter((part) => part.length > 0)));
    });
  }
  api.bindValue(node.attrs["bind"], (v) => { selected = v; reflect(); });
  bindControlDisabled(node, api, (disabled) => { forced = disabled; reflect(); });
  return group;
};

let starClipSequence = 0;

export function normalizeStarCount(value: unknown): number {
  const parsed = number(value);
  if (parsed === null || !Number.isFinite(parsed)) return 5;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

export function normalizeStarSize(value: unknown): number {
  const parsed = number(value);
  if (parsed === null || !Number.isFinite(parsed)) return 24;
  return Math.min(256, Math.max(1, parsed));
}

/** Accessible name for the read-only rating image. Interactive ratings keep the
 * group label because each child radio already announces its own value/state. */
export function starAccessibleName(label: string, current: number, count: number): string {
  return `${label}: ${current} of ${count} stars`;
}

function starCell(size: number, fraction: number): { svg: SVGSVGElement; clip: SVGRectElement } {
  // `<stars>` paints the same corpus glyph as `icon="star"`, filled + clipped rather than
  // stroked. Read INSIDE the factory on purpose: a module-scope read of the generated table
  // pins it into every slice, and an embed that draws no icon must not pay for the icon
  // table (the /web/13 embed budgets). Pinned by packages/dom/test/icons.test.ts.
  const STAR_PATH: string = ICON_VECTORS["star"] ?? "";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const outline = document.createElementNS(ns, "path");
  outline.setAttribute("d", STAR_PATH);
  outline.setAttribute("fill", "currentColor");
  outline.setAttribute("stroke", "currentColor");
  outline.setAttribute("stroke-width", "1.5");
  outline.setAttribute("opacity", ".3");
  const defs = document.createElementNS(ns, "defs");
  const clipPath = document.createElementNS(ns, "clipPath");
  const id = `dsx-star-clip-${++starClipSequence}`;
  clipPath.setAttribute("id", id);
  const clip = document.createElementNS(ns, "rect");
  clip.setAttribute("x", "0");
  clip.setAttribute("y", "0");
  clip.setAttribute("height", "24");
  clip.setAttribute("width", String(Math.min(Math.max(fraction, 0), 1) * 24));
  clipPath.appendChild(clip);
  defs.appendChild(clipPath);
  const fill = document.createElementNS(ns, "path");
  fill.setAttribute("d", STAR_PATH);
  fill.setAttribute("fill", "currentColor");
  fill.setAttribute("clip-path", `url(#${id})`);
  svg.append(defs, outline, fill);
  return { svg, clip };
}

const stars: ElementFactory = (node, _ctx, api) => {
  const wrap = el("div", "dsx-stars");
  const count = normalizeStarCount(node.attrs["count"] ?? "5");
  const size = normalizeStarSize(node.attrs["size"] ?? "24");
  const readonly = truthy(node.attrs["readonly"] ?? false);
  const accessibleLabel = node.attrs["a11yLabel"] ?? node.attrs["label"] ?? "Rating";
  wrap.style.setProperty("--dsx-star-size", `${size}px`);
  wrap.style.setProperty("--dsx-star-gap", `${size * 0.18}px`);
  wrap.setAttribute("aria-label", accessibleLabel);
  wrap.setAttribute("role", readonly ? "img" : "radiogroup");
  let current = 0;
  let forced = false;
  const cells: Array<{ host: HTMLElement; clip: SVGRectElement }> = [];

  const reflect = (): void => {
    cells.forEach(({ host, clip }, index) => {
      const fraction = Math.min(Math.max(current - index, 0), 1);
      clip.setAttribute("width", String(fraction * 24));
      if (host instanceof HTMLButtonElement) {
        host.setAttribute("aria-checked", String(Math.round(current) === index + 1));
        host.tabIndex = Math.max(1, Math.round(current)) === index + 1 ? 0 : -1;
      }
    });
    // aria-valuetext is only valid on range widgets, not role=img/radiogroup.
    // Read-only stars therefore carry their numeric value in the valid name;
    // interactive stars expose it through the checked child radio instead.
    if (readonly) wrap.setAttribute("aria-label", starAccessibleName(accessibleLabel, current, count));
  };
  const choose = (value: number): void => {
    current = Math.min(Math.max(value, 1), count);
    api.writeBack(node.attrs["bind"], current);
    api.handler("change", { value: current });
    reflect();
  };

  for (let i = 0; i < count; i++) {
    const host = el(readonly ? "span" : "button", readonly ? "dsx-star" : "dsx-button dsx-star") as HTMLElement;
    if (!readonly) {
      const button = host as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", `${i + 1} of ${count} stars`);
      button.addEventListener("click", () => choose(i + 1));
    }
    host.style.setProperty(
      "--dsx-star-hit-size",
      readonly ? `${size}px` : `max(${size}px, var(--dsx-control-height))`,
    );
    const cell = starCell(size, 0);
    host.appendChild(cell.svg);
    wrap.appendChild(host);
    cells.push({ host, clip: cell.clip });
  }
  if (!readonly) {
    wrap.addEventListener("keydown", (event) => {
      if (forced) return;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); choose(current + 1); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); choose(current - 1); }
      else if (event.key === "Home") { event.preventDefault(); choose(1); }
      else if (event.key === "End") { event.preventDefault(); choose(count); }
    });
    bindControlDisabled(node, api, (disabled) => {
      forced = disabled;
      for (const { host } of cells) {
        if (host instanceof HTMLButtonElement) host.disabled = disabled;
      }
    });
  }
  api.bindValue(node.attrs["bind"], (v) => { current = number(v) ?? 0; reflect(); });
  return wrap;
};

export type ChartPoint = { x: string; y: number; source: Dict };
export type ChartSeries = { name: string; points: ChartPoint[] };
export const CHART_RENDER_POINT_LIMIT = 2_000;
export const CHART_SERIES_LIMIT = 24;
const CHART_DEFAULT_PALETTE = ["var(--dsx-accent)", "#FF9500", "#34C759", "#AF52DE", "#FF3B30"];

export function chartPoints(rows: unknown, xKey: string, yKey: string): ChartPoint[] {
  if (!Array.isArray(rows)) return [];
  const result: ChartPoint[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Dict;
    const y = number(row[yKey]);
    if (y === null || y === undefined || !Number.isFinite(y)) continue;
    result.push({ x: string(row[xKey] ?? result.length + 1), y, source: row });
  }
  return result;
}

/** Group rows by `series=` the way the desktop Compose twin does (`desktopChartSeries`).
 *  An empty series key is one series. Caps at CHART_SERIES_LIMIT so a hostile bind cannot
 *  allocate an SVG path per unique string. */
export function chartSeries(
  rows: unknown,
  xKey: string,
  yKey: string,
  seriesKey = "",
): ChartSeries[] {
  if (!Array.isArray(rows)) return [];
  const groups = new Map<string, ChartPoint[]>();
  rows.slice(0, 10_000).forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
    const row = raw as Dict;
    const y = number(row[yKey]);
    if (y === null || y === undefined || !Number.isFinite(y)) return;
    const x = string(row[xKey] ?? index + 1).slice(0, 128);
    const name = seriesKey === ""
      ? "Series"
      : (string(row[seriesKey] ?? "").slice(0, 128) || "Series");
    const list = groups.get(name) ?? [];
    list.push({ x, y, source: row });
    groups.set(name, list);
  });
  return [...groups.entries()].slice(0, CHART_SERIES_LIMIT).map(([name, points]) => ({ name, points }));
}

export function chartPalette(raw: string | undefined, fallback: string): string[] {
  const parts = String(raw ?? "")
    .split(/[|,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => mapStyleValue("color", part) || part);
  return parts.length > 0 ? parts : [fallback, ...CHART_DEFAULT_PALETTE.slice(1)];
}

/** Deterministic min/max bucket sampling. It preserves the first and last points and
 * every bucket's local extrema (therefore the global extrema) while bounding SVG DOM.
 * Points remain in source order so line/area geometry stays representative. */
export function downsampleChartPoints(
  points: readonly ChartPoint[],
  limit = CHART_RENDER_POINT_LIMIT,
): ChartPoint[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(4, Math.trunc(limit)) : CHART_RENDER_POINT_LIMIT;
  if (points.length <= safeLimit) return [...points];
  const bucketCount = Math.max(1, Math.floor((safeLimit - 2) / 2));
  const interior = points.length - 2;
  const sampled: ChartPoint[] = [points[0]!];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor(bucket * interior / bucketCount);
    const end = 1 + Math.floor((bucket + 1) * interior / bucketCount);
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      if (points[index]!.y < points[minIndex]!.y) minIndex = index;
      if (points[index]!.y > points[maxIndex]!.y) maxIndex = index;
    }
    if (minIndex <= maxIndex) {
      sampled.push(points[minIndex]!);
      if (maxIndex !== minIndex) sampled.push(points[maxIndex]!);
    } else {
      sampled.push(points[maxIndex]!, points[minIndex]!);
    }
  }
  sampled.push(points[points.length - 1]!);
  return sampled;
}

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

export function chartLinePath(
  points: Array<{ x: number; y: number }>,
  interpolation = "linear",
): string {
  if (points.length === 0) return "";
  if (interpolation === "step") {
    let path = `M${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      path += ` L${points[i]!.x.toFixed(2)} ${points[i - 1]!.y.toFixed(2)} L${points[i]!.x.toFixed(2)} ${points[i]!.y.toFixed(2)}`;
    }
    return path;
  }
  const smooth = interpolation === "smooth" || interpolation === "monotone";
  if (!smooth || points.length < 3) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  }
  let path = `M${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const d = points[Math.min(points.length - 1, i + 2)]!;
    const c1x = b.x + (c.x - a.x) / 6;
    const c1y = b.y + (c.y - a.y) / 6;
    const c2x = c.x - (d.x - b.x) / 6;
    const c2y = c.y - (d.y - b.y) / 6;
    path += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)},${c2x.toFixed(2)} ${c2y.toFixed(2)},${c.x.toFixed(2)} ${c.y.toFixed(2)}`;
  }
  return path;
}

const chart: ElementFactory = (node, _ctx, api) => {
  const figure = el("figure", "dsx-chart");
  figure.setAttribute("role", "img");
  const svg = svgNode("svg");
  svg.setAttribute("viewBox", "0 0 600 240");
  svg.setAttribute("preserveAspectRatio", "none");
  // The svg fills its figure; the 180px DEFAULT floor lives on .dsx-chart in the theme
  // sheet, so an authored height (a 44px sparkline) is honored instead of overridden -
  // an inline min-height here decided the floor on the author's behalf.
  svg.style.cssText = "display:block;width:100%;height:100%;overflow:visible";
  figure.appendChild(svg);
  bindSemanticColor(node, api, figure, "color");
  const xKey = node.attrs["x"] ?? "x";
  const yKey = node.attrs["y"] ?? "y";
  const seriesKey = node.attrs["series"] ?? "";
  const type = (node.attrs["type"] ?? "line").toLowerCase();
  const showPoints = truthy(node.attrs["showPoints"] ?? type === "point");
  const lineWidth = Math.max(0.5, number(node.attrs["lineWidth"] ?? "2") ?? 2);
  const areaOpacity = Math.min(Math.max(number(node.attrs["areaOpacity"] ?? ".25") ?? .25, 0), 1);
  const palette = chartPalette(node.attrs["colors"], "currentColor");

  api.bindValue(node.attrs["data"], (raw) => {
    const grouped = chartSeries(raw, xKey, yKey, seriesKey);
    const sourcePoints = grouped.flatMap((entry) => entry.points);
    const series = grouped.map((entry) => ({
      name: entry.name,
      points: downsampleChartPoints(entry.points),
    }));
    svg.replaceChildren();
    if (sourcePoints.length === 0) {
      const label = svgNode("text");
      label.setAttribute("x", "300");
      label.setAttribute("y", "120");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("fill", "currentColor");
      label.setAttribute("opacity", ".65");
      label.textContent = "No chart data";
      svg.appendChild(label);
      figure.setAttribute("aria-label", "Chart with no data");
      return;
    }
    let min = 0;
    let max = 0;
    for (const point of sourcePoints) {
      if (point.y < min) min = point.y;
      if (point.y > max) max = point.y;
    }
    if (min === max) { min -= 1; max += 1; }
    const left = 42;
    const right = 584;
    const top = 14;
    const bottom = 205;
    const maxPoints = Math.max(1, ...series.map((entry) => entry.points.length));
    const xAt = (index: number): number => maxPoints === 1 ? (left + right) / 2 : left + index / (maxPoints - 1) * (right - left);
    const yAt = (value: number): number => bottom - (value - min) / (max - min) * (bottom - top);
    const axisPoints = series.reduce((best, entry) => entry.points.length > best.length ? entry.points : best, series[0]!.points);

    const yHide = truthy(node.attrs["yHide"] ?? false);
    const yGridOn = !yHide && (node.attrs["yGrid"] === undefined || truthy(node.attrs["yGrid"]));
    const xGridOn = truthy(node.attrs["xGrid"] ?? false);
    if (!yHide) {
      for (let i = 0; i <= 4; i++) {
        const y = top + i / 4 * (bottom - top);
        if (yGridOn) {
          const grid = svgNode("line");
          grid.setAttribute("data-dsx-grid", "y");
          grid.setAttribute("x1", String(left)); grid.setAttribute("x2", String(right));
          grid.setAttribute("y1", String(y)); grid.setAttribute("y2", String(y));
          grid.setAttribute("stroke", "var(--dsx-separator)"); grid.setAttribute("stroke-width", "1");
          svg.appendChild(grid);
        }
        const label = svgNode("text");
        label.setAttribute("x", String(left - 6)); label.setAttribute("y", String(y + 4));
        label.setAttribute("text-anchor", "end"); label.setAttribute("fill", "var(--dsx-secondary-label)");
        label.setAttribute("font-size", "10"); label.textContent = (max - i / 4 * (max - min)).toFixed(0);
        svg.appendChild(label);
      }
    }
    series.forEach((entry, seriesIndex) => {
      const tint = palette[seriesIndex % palette.length]!;
      const geometry = entry.points.map((p, i) => ({ x: xAt(i), y: yAt(p.y) }));
      if (type === "bar") {
        const slot = (right - left) / maxPoints;
        const barWidth = Math.max(1, Math.min(32, slot * .68) / series.length);
        geometry.forEach((p, i) => {
          const rect = svgNode("rect");
          const zero = yAt(0);
          const offset = (seriesIndex - (series.length - 1) / 2) * barWidth;
          rect.setAttribute("x", String(p.x + offset - barWidth / 2));
          rect.setAttribute("y", String(Math.min(zero, p.y)));
          rect.setAttribute("width", String(barWidth));
          rect.setAttribute("height", String(Math.max(1, Math.abs(zero - p.y))));
          rect.setAttribute("rx", "3"); rect.setAttribute("fill", tint);
          rect.setAttribute("data-dsx-series", entry.name);
          rect.setAttribute("aria-label", `${entry.name} ${entry.points[i]!.x}: ${entry.points[i]!.y}`);
          svg.appendChild(rect);
        });
        return;
      }
      const d = chartLinePath(geometry, node.attrs["interpolation"] ?? "linear");
      if (type === "area") {
        const area = svgNode("path");
        area.setAttribute("d", `${d} L${geometry.at(-1)!.x} ${bottom} L${geometry[0]!.x} ${bottom} Z`);
        area.setAttribute("fill", tint); area.setAttribute("opacity", String(areaOpacity));
        area.setAttribute("data-dsx-series", entry.name);
        svg.appendChild(area);
      }
      if (type !== "point") {
        const path = svgNode("path");
        path.setAttribute("d", d); path.setAttribute("fill", "none");
        path.setAttribute("stroke", tint); path.setAttribute("stroke-width", String(lineWidth));
        path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("data-dsx-series", entry.name);
        svg.appendChild(path);
      }
      if (showPoints || type === "point") {
        geometry.forEach((p, i) => {
          const point = svgNode("circle");
          point.setAttribute("cx", String(p.x)); point.setAttribute("cy", String(p.y));
          point.setAttribute("r", String(Math.max(2, Math.sqrt(number(node.attrs["pointSize"] ?? "40") ?? 40) / 2)));
          point.setAttribute("fill", tint);
          point.setAttribute("data-dsx-series", entry.name);
          point.setAttribute("aria-label", `${entry.name} ${entry.points[i]!.x}: ${entry.points[i]!.y}`);
          svg.appendChild(point);
        });
      }
    });
    if (!truthy(node.attrs["xHide"] ?? false)) {
      const stride = Math.max(1, Math.ceil(axisPoints.length / 7));
      axisPoints.forEach((point, i) => {
        if (i % stride !== 0 && i !== axisPoints.length - 1) return;
        if (xGridOn) {
          const grid = svgNode("line");
          grid.setAttribute("data-dsx-grid", "x");
          grid.setAttribute("x1", String(xAt(i))); grid.setAttribute("x2", String(xAt(i)));
          grid.setAttribute("y1", String(top)); grid.setAttribute("y2", String(bottom));
          grid.setAttribute("stroke", "var(--dsx-separator)"); grid.setAttribute("stroke-width", "1");
          svg.appendChild(grid);
        }
        const label = svgNode("text");
        label.setAttribute("x", String(xAt(i))); label.setAttribute("y", "226");
        label.setAttribute("text-anchor", "middle"); label.setAttribute("fill", "var(--dsx-secondary-label)");
        label.setAttribute("font-size", "10"); label.textContent = point.x;
        svg.appendChild(label);
      });
    }
    const sampled = series.reduce((sum, entry) => sum + entry.points.length, 0);
    const sampling = sampled < sourcePoints.length ? `; showing ${sampled} representative marks` : "";
    const seriesNote = series.length > 1 ? `; ${series.length} series` : "";
    figure.setAttribute("aria-label", `${type} chart with ${sourcePoints.length} points${seriesNote}${sampling}; values range from ${min} to ${max}`);
  });
  return figure;
};

function mercator(lat: number, lon: number): { x: number; y: number } {
  const safeLat = Math.min(Math.max(lat, -85.05112878), 85.05112878);
  const radians = safeLat * Math.PI / 180;
  return {
    x: (lon + 180) / 360,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
  };
}

export function projectMapPoint(
  centerLat: number,
  centerLon: number,
  pointLat: number,
  pointLon: number,
  zoom: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const center = mercator(centerLat, centerLon);
  const point = mercator(pointLat, pointLon);
  const world = 256 * 2 ** Math.min(Math.max(zoom, 0), 22);
  let dx = (point.x - center.x) * world;
  if (dx > world / 2) dx -= world;
  if (dx < -world / 2) dx += world;
  return { x: width / 2 + dx, y: height / 2 + (point.y - center.y) * world };
}

const mapEl: ElementFactory = (node, ctx, api) => {
  const wrap = el("div", "dsx-map");
  wrap.setAttribute("role", "application");
  wrap.setAttribute("aria-roledescription", "interactive coordinate map");
  wrap.tabIndex = 0;
  const pinsLayer = el("div", "dsx-map-pins");
  const attribution = el("span", "dsx-map-status");
  const controls = el("div", "dsx-map-controls");
  const zoomIn = el("button", "dsx-button dsx-map-control") as HTMLButtonElement;
  const zoomOut = el("button", "dsx-button dsx-map-control") as HTMLButtonElement;
  for (const [button, label, glyph] of [[zoomIn, "Zoom in", "+"], [zoomOut, "Zoom out", "−"]] as const) {
    button.type = "button"; button.setAttribute("aria-label", label); button.textContent = glyph;
    controls.appendChild(button);
  }
  wrap.append(pinsLayer, attribution, controls);

  const interaction = (node.attrs["interaction"] ?? "all") !== "none";
  if (!interaction) { wrap.style.touchAction = "auto"; controls.hidden = true; }
  let centerLat = number(node.attrs["lat"] ?? "0") ?? 0;
  let centerLon = number(node.attrs["lon"] ?? "0") ?? 0;
  let zoom = Math.min(Math.max(number(node.attrs["zoom"] ?? "12") ?? 12, 0), 22);
  let pins: unknown[] = [];
  const pinLat = node.attrs["pinLat"] ?? "lat";
  const pinLon = node.attrs["pinLon"] ?? "lng";
  const pinTitle = node.attrs["pinTitle"] ?? "title";
  const pinSubtitle = node.attrs["pinSubtitle"] ?? "subtitle";

  const render = (): void => {
    const rect = wrap.getBoundingClientRect();
    const width = Math.max(1, rect.width || 600);
    const height = Math.max(1, rect.height || 300);
    pinsLayer.replaceChildren();
    for (const raw of pins) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Dict;
      const lat = number(row[pinLat]);
      const lon = number(row[pinLon]);
      if (lat === null || lat === undefined || lon === null || lon === undefined) continue;
      const point = projectMapPoint(centerLat, centerLon, lat, lon, zoom, width, height);
      if (point.x < -24 || point.y < -24 || point.x > width + 24 || point.y > height + 24) continue;
      const pin = el("button", "dsx-button dsx-map-pin") as HTMLButtonElement;
      const title = string(row[pinTitle] ?? "Map pin");
      const subtitle = string(row[pinSubtitle] ?? "");
      pin.type = "button";
      pin.setAttribute("aria-label", `${title}${subtitle.length > 0 ? `, ${subtitle}` : ""}; ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
      pin.title = title;
      pin.textContent = "●";
      pin.style.cssText =
        `position:absolute;left:${point.x}px;top:${point.y}px;transform:translate(-50%,-100%);pointer-events:auto;` +
        "width:44px;height:44px;padding:0;border:0;background:transparent;color:var(--dsx-accent);" +
        "font-size:var(--dsx-glyph-size-xl);line-height:var(--dsx-type-leading-none);text-shadow:0 1px 2px var(--dsx-background);cursor:pointer";
      pinsLayer.appendChild(pin);
    }
    const state = `${centerLat.toFixed(5)}, ${centerLon.toFixed(5)} · z${zoom.toFixed(1)}`;
    attribution.textContent = `Offline coordinate map · ${state}`;
    wrap.setAttribute("aria-label", `Interactive offline coordinate map centered at ${state}; ${pinsLayer.childElementCount} pins`);
  };
  const setZoom = (next: number): void => { zoom = Math.min(Math.max(next, 0), 22); render(); };
  zoomIn.addEventListener("click", () => setZoom(zoom + 1));
  zoomOut.addEventListener("click", () => setZoom(zoom - 1));
  let drag: { id: number; x: number; y: number } | null = null;
  if (interaction) {
    wrap.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest("button")) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      wrap.setPointerCapture?.(event.pointerId);
    });
    wrap.addEventListener("pointermove", (event) => {
      if (drag === null || drag.id !== event.pointerId) return;
      const world = 256 * 2 ** zoom;
      centerLon -= (event.clientX - drag.x) / world * 360;
      const centerWorld = mercator(centerLat, centerLon);
      const nextY = centerWorld.y - (event.clientY - drag.y) / world;
      centerLat = 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * nextY)));
      drag = { id: drag.id, x: event.clientX, y: event.clientY };
      render();
    });
    const endDrag = (event: PointerEvent): void => { if (drag?.id === event.pointerId) drag = null; };
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);
    wrap.addEventListener("wheel", (event) => {
      event.preventDefault();
      setZoom(zoom + (event.deltaY < 0 ? .5 : -.5));
    }, { passive: false });
    wrap.addEventListener("keydown", (event) => {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom(zoom + 1); }
      else if (event.key === "-") { event.preventDefault(); setZoom(zoom - 1); }
    });
  }
  api.bindText(node.attrs["lat"] ?? "0", (v) => { centerLat = number(v) ?? 0; render(); });
  api.bindText(node.attrs["lon"] ?? "0", (v) => { centerLon = number(v) ?? 0; render(); });
  api.bindText(node.attrs["zoom"] ?? "12", (v) => { zoom = Math.min(Math.max(number(v) ?? 12, 0), 22); render(); });
  api.bindValue(node.attrs["pins"], (v) => { pins = Array.isArray(v) ? v : []; render(); });
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(render);
    observer.observe(wrap);
    ctx.disposers.push(() => observer.disconnect());
  }
  queueMicrotask(render);
  return wrap;
};

export type WebSurfaceController = {
  readonly frame: HTMLIFrameElement;
  load(url: string): void;
  reload(): void;
  back(): void;
  forward(): void;
  stop(): void;
  eval(script: string): unknown;
  call(name: string, args: unknown[]): unknown;
  set(name: string, value: unknown): void;
  css(property: string, value: string): void;
};

const WEB_SURFACES_KEY = Symbol.for("dsx.web-surfaces.v1");

export function webSurfaceRegistry(): Map<string, WebSurfaceController> {
  const scope = globalThis as typeof globalThis & { [WEB_SURFACES_KEY]?: Map<string, WebSurfaceController> };
  if (scope[WEB_SURFACES_KEY] === undefined) scope[WEB_SURFACES_KEY] = new Map();
  return scope[WEB_SURFACES_KEY];
}

function safeWebSurfaceUrl(raw: string): string {
  const url = new URL(raw, document.baseURI);
  if (url.protocol === "http:" || url.protocol === "https:" || (url.protocol === "about:" && url.href === "about:blank")) {
    return url.href;
  }
  throw new TypeError(`WebView blocked unsafe URL scheme '${url.protocol}'`);
}

function surfaceWindow(frame: HTMLIFrameElement): Window & typeof globalThis {
  const target = frame.contentWindow;
  if (target === null) throw new Error("WebView is not mounted");
  // Reading location.href is the same-origin gate. Cross-origin access throws before
  // any script/callback/global can be reached, matching the native origin policy.
  void target.location.href;
  return target as Window & typeof globalThis;
}

const UNSAFE_WEB_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

export function webSurfacePathParts(name: string): string[] {
  const parts = name.split(".").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) =>
    !/^[A-Za-z_$][\w$]*$/.test(part) || UNSAFE_WEB_PATH_PARTS.has(part))) {
    throw new TypeError("WebView callback/global name is invalid");
  }
  return parts;
}

const webView: ElementFactory = (node, ctx, api) => {
  const frame = el("iframe", "dsx-webview") as HTMLIFrameElement;
  frame.title = node.attrs["a11yLabel"] ?? node.attrs["title"] ?? "Web content";
  frame.loading = "eager";
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  if (truthy(node.attrs["ephemeral"] ?? false)) {
    // An opaque sandbox origin is the cross-browser storage boundary. `credentialless`
    // strengthens it where implemented, but cannot be the only control (Safari and
    // Firefox may not expose it). Scripts/forms still work; same-origin storage and
    // parent DOM access intentionally do not survive the ephemeral node.
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads",
    );
    if ("credentialless" in frame) {
      (frame as HTMLIFrameElement & { credentialless: boolean }).credentialless = true;
    }
  }
  const name = node.attrs["name"] ?? "web";
  const registry = webSurfaceRegistry();
  const controller: WebSurfaceController = {
    frame,
    load(url) {
      const safe = admitSrc(frame, safeWebSurfaceUrl(url));
      if (safe.length === 0) { frame.src = "about:blank"; return; }
      api.handler("start", { url: safe });
      frame.src = safe;
    },
    reload() { try { frame.contentWindow?.location.reload(); } catch { frame.src = frame.src; } },
    back() { surfaceWindow(frame).history.back(); },
    forward() { surfaceWindow(frame).history.forward(); },
    stop() { try { frame.contentWindow?.stop(); } catch { /* cross-origin stop is browser-controlled */ } },
    eval(script) {
      if (script.trim().length === 0) throw new TypeError("A non-empty script is required");
      return surfaceWindow(frame).eval(script);
    },
    call(path, args) {
      const parts = webSurfacePathParts(path);
      let owner: unknown = surfaceWindow(frame);
      for (const part of parts.slice(0, -1)) owner = (owner as Record<string, unknown>)[part];
      const fn = (owner as Record<string, unknown>)[parts.at(-1)!];
      if (typeof fn !== "function") throw new TypeError(`WebView callback '${path}' does not exist`);
      return fn.apply(owner, args);
    },
    set(path, value) {
      const parts = webSurfacePathParts(path);
      let owner: Record<string, unknown> = surfaceWindow(frame) as unknown as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) {
        const next = owner[part];
        if (next === null || (typeof next !== "object" && typeof next !== "function")) owner[part] = {};
        owner = owner[part] as Record<string, unknown>;
      }
      owner[parts.at(-1)!] = value;
    },
    css(property, value) {
      if (!/^--[A-Za-z0-9_-]+$/.test(property)) throw new TypeError("Only CSS custom properties may be set");
      const doc = surfaceWindow(frame).document;
      doc.documentElement.style.setProperty(property, value);
      doc.body?.style.setProperty(property, value);
    },
  };
  registry.set(name, controller);
  const onMessage = (event: MessageEvent): void => {
    if (event.source === frame.contentWindow) api.handler("message", { data: event.data });
  };
  window.addEventListener("message", onMessage);
  frame.addEventListener("load", () => {
    try {
      const target = surfaceWindow(frame) as Window & typeof globalThis & { app?: Record<string, unknown> };
      const previous = target.app !== null && typeof target.app === "object" ? target.app : {};
      target.app = { ...previous, send: (data: unknown) => api.handler("message", { data }) };
    } catch { /* cross-origin frames stay intentionally isolated */ }
    api.handler("finish", { url: frame.src });
  });
  frame.addEventListener("error", () => api.handler("fail", {
    url: frame.src,
    error: "The embedded page could not be loaded.",
    code: "load_failed",
  }));
  ctx.disposers.push(() => {
    window.removeEventListener("message", onMessage);
    if (registry.get(name) === controller) registry.delete(name);
    try { frame.src = "about:blank"; } catch { /* already detached */ }
  });
  const initial = node.attrs["src"] ?? (node.attrs["origin"] !== undefined
    ? `${node.attrs["origin"]}${node.attrs["path"] ?? "/"}`
    : "about:blank");
  api.bindText(initial, (url) => {
    try { controller.load(url.length > 0 ? url : "about:blank"); }
    catch (error) {
      api.handler("fail", { url, error: String(error), code: "unsafe_url" });
      frame.src = "about:blank";
    }
  });
  return frame;
};

/** `<DSXWebView/>` — the composed APP web surface (web-surface-policy.md). On this
 *  renderer the app IS the web, so the surface is the page's own origin: `path`
 *  resolves against it (an explicit `origin` still wins) and the embed rides the same
 *  policy-constrained iframe `<WebView>` mounts, including the named-surface controls
 *  the Dom facet targets (default name "web" — `dsx.module.dom.*` reaches this surface
 *  exactly like the native app surface). Nothing native is faked: there is no BridgeKit
 *  twin, so the embedded page gets the plain `window.app.send` channel and the
 *  bridge-gate `on:denied` event never fires here. */
const dsxWebView: ElementFactory = (node, ctx, api) => {
  const attrs = { ...node.attrs };
  if (attrs["src"] === undefined && attrs["origin"] === undefined) attrs["src"] = attrs["path"] ?? "/";
  return webView({ ...node, attrs }, ctx, api);
};

/** "player/Scrubber.dsx" → "Scrubber" (the DSXView.swift componentName rule); a folder
 *  src ("…/player/") folds to its folder name. */
function dsxViewComponentName(src: string): string | null {
  const path = src.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const last = path.split("/").filter((part) => part.length > 0).at(-1) ?? "";
  const name = last.endsWith(".dsx") ? last.slice(0, -4) : last;
  return name.length > 0 ? name : null;
}

/** `<DSXView/>` — the remote/native DSX surface. On this renderer every screen is
 *  already native DSX (the router-painted frame is the DSXView analogue), so the honest
 *  mapping renders the screen `src` names FROM THIS BUILD's compiled registry — the web
 *  reading of the native rule "a shipped tag of the same name always wins", where the
 *  build is all there is. Remote fetch, screen-folder manifests, and the DSXRemoteCache
 *  policy are native-only (`origin` is not consumed); a src this build does not ship
 *  renders a labelled unavailable card, never blank. Lifecycle mirrors the native
 *  contract on the stable `dsx-view` scheme (loading/ready/failed/disappear). */
const dsxView: ElementFactory = (node, ctx, api) => {
  const host = el("div", "dsx-view");
  let inner: Array<() => void> | null = null;
  const clear = (): void => {
    inner?.forEach((dispose) => dispose());
    inner = null;
    host.replaceChildren();
  };
  const origin = node.attrs["origin"] ?? "";
  let lastSrc: string | null = null;
  ctx.disposers.push(() => {
    clear();
    if (lastSrc !== null) DSXEvents.publish("dsx-view:disappear", { src: lastSrc, origin });
  });
  api.bindText(node.attrs["src"] ?? "", (raw) => {
    clear();
    const src = raw.trim();
    lastSrc = src;
    DSXEvents.publish("dsx-view:loading", { src, origin });
    const name = dsxViewComponentName(src);
    // The mount tag must preserve exactly the resolution that shipped it: a
    // Capitalized/dotted name rides mountNode's own component ladder; a lowercase
    // screen name (a folder src) is qualified so the component route still fires.
    let target: string | null = null;
    if (name !== null) {
      if (/^[A-Z]/.test(name) || name.includes(".")) {
        target = resolveComponent(ctx.registry, ctx.scheme, name) !== null
          || ModuleRegistry.facetComponent(name) !== null
          || GLOBAL_ELEMENTS[name] !== undefined ? name : null;
      } else if (resolveComponent(ctx.registry, ctx.scheme, `${ctx.scheme}.${name}`) !== null) {
        target = `${ctx.scheme}.${name}`;
      } else if (resolveComponent(ctx.registry, ctx.scheme, `shared.${name}`) !== null) {
        target = `shared.${name}`;
      }
    }
    if (target === null) {
      const message = el("span", "dsx-view-unavailable");
      message.setAttribute("role", "status");
      message.textContent = src.length === 0
        ? "Screen is not configured. Add a valid src to DSXView."
        : `Screen unavailable: this build does not ship "${name ?? src}".`;
      host.appendChild(message);
      DSXEvents.publish("dsx-view:failed", { src, origin });
      return;
    }
    inner = [];
    api.children(host, [{ tag: target, attrs: {}, children: [], text: "" }], { disposers: inner });
    DSXEvents.publish("dsx-view:ready", { src, origin });
  });
  return host;
};

const qrcode: ElementFactory = (node, _ctx, api) => {
  const wrap = el("span", "dsx-qrcode");
  const size = Math.max(1, number(node.attrs["size"] ?? node.attrs["width"] ?? node.attrs["height"] ?? "200") ?? 200);
  wrap.style.setProperty("--dsx-qr-size", `${size}px`);
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", node.attrs["a11yLabel"] ?? "QR code");
  let moduleColor = node.attrs["color"] ?? "black";
  let background = node.attrs["background"] ?? "white";
  let value = "";
  const render = (): void => {
    wrap.replaceChildren();
    if (value.length === 0) { wrap.hidden = true; return; }
    wrap.hidden = false;
    try {
      const correction = (node.attrs["correction"] ?? "M").toUpperCase() as QrCorrection;
      const matrix = qrMatrix(value, correction);
      const svg = svgNode("svg");
      const extent = matrix.size + 8;
      svg.setAttribute("viewBox", `0 0 ${extent} ${extent}`);
      svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.setAttribute("shape-rendering", "crispEdges"); svg.setAttribute("aria-hidden", "true");
      const base = svgNode("rect");
      base.setAttribute("width", String(extent)); base.setAttribute("height", String(extent));
      base.setAttribute("fill", background);
      const path = svgNode("path");
      const commands: string[] = [];
      matrix.modules.forEach((row, y) => row.forEach((dark, x) => {
        if (dark) commands.push(`M${x + 4} ${y + 4}h1v1h-1z`);
      }));
      path.setAttribute("d", commands.join("")); path.setAttribute("fill", moduleColor);
      svg.append(base, path);
      wrap.appendChild(svg);
      wrap.setAttribute("data-dsx-qr-version", String(matrix.version));
      wrap.setAttribute("aria-label", node.attrs["a11yLabel"] ?? `QR code containing ${value}`);
    } catch (error) {
      const message = el("span", "dsx-qrcode-error");
      message.setAttribute("role", "status");
      message.textContent = `QR unavailable: ${error instanceof Error ? error.message : String(error)}`;
      wrap.appendChild(message);
      wrap.removeAttribute("data-dsx-qr-version");
    }
  };
  api.bindText(node.attrs["color"] ?? "black", (v) => { moduleColor = v; render(); });
  api.bindText(node.attrs["background"] ?? "white", (v) => { background = v; render(); });
  api.bindText(node.attrs["value"], (v) => { value = v; render(); });
  return wrap;
};

/** honest placeholder for native-only elements (X-tier, /web/08) — never a crash */
const unsupported: ElementFactory = (node, _ctx, api) => {
  const e = el("div", "dsx-unsupported");
  e.dataset["tag"] = node.tag;
  const label = el("span", "dsx-unsupported-label");
  label.textContent = `<${node.tag}> — native-only on this platform`;
  e.appendChild(label);
  api.children(e);
  return e;
};

// The base table's OPTIONAL GROUPS (/web/13 embed size law). Each spread is written
// inline so esbuild folds the whole ternary against the build's `__DSX_OPTIONAL_*`
// define and then tree-shakes the now-unreferenced factories (and everything only
// they import — `scaffold` drags the entire adaptive-shell resolver behind it). A
// full application never sets the defines, so `undefined !== false` keeps every
// group: the table below is byte-identical for anything that is not a sliced embed.
export const ELEMENTS: { [tag: string]: ElementFactory } = {
  stack, vstack: stack, hstack: stack, zstack: stack,
  // <scaffold> is the APPLICATION shell (sidebar/inspector/pane layout + the adaptive
  // breakpoint resolver). A widget embed that never authors one strips both.
  ...((globalThis as typeof globalThis & { __DSX_OPTIONAL_SCAFFOLD__?: boolean })
    .__DSX_OPTIONAL_SCAFFOLD__ !== false ? { scaffold } : {}),
  text: textEl, label: textEl,
  // <markdown> is the block vocabulary; a slice that never authors one folds it away.
  ...((globalThis as typeof globalThis & { __DSX_OPTIONAL_MARKDOWN__?: boolean })
    .__DSX_OPTIONAL_MARKDOWN__ !== false ? { markdown: markdownEl } : {}),
  button: buttonEl, pressable: buttonEl, glassButton: buttonEl,
  transport: buttonEl, row: buttonEl,
  // image/scroll/spacer/divider — the static presentation primitives.
  ...((globalThis as typeof globalThis & { __DSX_OPTIONAL_STATIC_ELEMENTS__?: boolean })
    .__DSX_OPTIONAL_STATIC_ELEMENTS__ !== false
    ? { image: imageEl, scroll, spacer, divider } : {}),
  // the interactive control floor (the same set `CONTROL_ELEMENTS_CSS` styles) —
  // an embed whose closed slice authors none of these tags cannot reach them.
  ...((globalThis as typeof globalThis & { __DSX_OPTIONAL_CONTROLS__?: boolean })
    .__DSX_OPTIONAL_CONTROLS__ !== false ? {
      toggle, switch: toggle,
      slider, textfield, input: textfield, searchbar: textfield,
      textarea: textareaEl,
      progress, capsuleProgress: progress, spinner, activity: spinner,
      stepper,
    } : {}),
  // list/grid are handled by the binding engine (keyed rows) — registered in mount.ts
};

/** Optional richer native twins. They deliberately stay out of the base table so a
 * component embed that only uses text/layout/buttons does not pay for charts, maps,
 * WebView control or the QR encoder. Full applications install this set at boot;
 * sliced embeds install it only when their registry actually references one. */
export const RICH_ELEMENT_TAGS: ReadonlySet<string> = new Set([
  "segmented", "stars", "chart", "map", "WebView", "DSXWebView", "DSXView", "qrcode",
]);

export function registerRichElements(): void {
  Object.assign(ELEMENTS, {
    segmented,
    stars,
    chart,
    map: mapEl,
    WebView: webView,
    DSXWebView: dsxWebView,
    DSXView: dsxView,
    qrcode,
  });
}

/** The live optional-global table read by mount.ts. Full apps install the universal
 *  native twins at boot; an embed installs them only when its sliced component tree
 *  references one, preserving the self-contained embed size law. */
export const GLOBAL_ELEMENTS: { [tag: string]: ElementFactory } = {};

export function registerGlobalElements(factories: Readonly<Record<string, ElementFactory>>): void {
  Object.assign(GLOBAL_ELEMENTS, factories);
}

export const UNSUPPORTED: ElementFactory = unsupported;
