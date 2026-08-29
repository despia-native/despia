//
//  render.ts - the string renderer (@despia-native/server v0, /web/02). Renders a component's IR
//  to HTML with the SAME resolution rules as @despia-native/dom — components, slots (caller
//  scope), visible-if, lists, interpolations, the css handle stamps — evaluated ONCE
//  against the initial store. The output is the SEO/first-paint document; with
//  `hydrate` on (renderPage) every element also carries `data-dsx-n` — its IR node
//  identity (stampNodeIds) — and the client boot ADOPTS the server DOM in place
//  (@despia-native/dom adopt.ts; mismatch = diagnostic + per-subtree replace, fail-open).
//  The compiler's per-node reactive stamps remain the islands input (later W6 slice).
//
//  DOM-free: runs in Node/edge. SSR-aware <api> execution (W6, doc 05/02) lives in
//  executeSsrApis + renderPageAsync (static.ts): an ssr-eligible GET runs during render,
//  its ok result seeds the body + the window.__DSX__ hydration payload, and the client
//  adopts that data instead of re-fetching (fail-open — any failure seeds null and the
//  client fetches on mount). Bare renderToString still seeds every envelope null.
//

import {
  ReactiveStore, ActionRunner, makeRunEnv, JSE, JSESeams, ModuleRegistry,
  executeApiForSSR, materializeApiRequest, ApiGraph, apiStreamEligible,
  string, truthy, number, isDict, overrideAttrName,
  INK_STROKE_WIDTH, decodeInk, inkPathData,
  type Dict, type ApiSpec, type ApiSeed, type InkStroke,
} from "@despia-native/kernel";
import { legacyAttrToDecls, mapStyleValue, parseStyleAttr, BRIDGE_ATTRS, BRIDGE_CONTEXT_ATTRS } from "@despia-native/compiler/cssmap";
import { segmentOptions } from "@despia-native/compiler/options";
import {
  BUTTON_ROLES, isoDatePickerValue, normalizeDatePickerMode, normalizeFormInput, normalizeFormOptions,
  normalizeSpinnerScale,
  normalizeNativeControlOptions, normalizeOtpLength, normalizeOtpValue, normalizeRangeBounds,
  normalizeStarCount, normalizeStructuralGap, normalizeStructuralIndex, parseNativeControlCsv,
  normalizeOverlayItems, normalizeSheetBackground, normalizeSheetDetents, resolveAdaptiveShell, validateFormValue,
  markdownHtml, markdownBlocksHtml, lineClampStyle, assetImageSource, applyKeyboardHintAttributes, textAreaLineCount,
  normalizeDataControlOptions, parseDataControlCsv, parseCalendarDate, calendarDateKey,
  calendarMonthGrid, calendarFirstWeekday, normalizeCalendarLocale, normalizeSegmentedSelection,
  normalizeMenuBarItems, normalizeMenuBarEnabledIndex, normalizeMenuBarTint,
  resolveSplit, splitSelectionActive, SPLIT_ROLE_ORDER, SPLIT_TOGGLE_PATH,
  type SplitRole,
  safeMediaUrl, sanitizeSvgSource, svgBundleKey, svgFromPath, normalizeAudioSessionCategory, normalizeLightboxImages, parseLightboxUrls,
  normalizeLightboxColor, boundedMediaText, MEDIA_SURFACE_LIMITS,
  OVERLAY_LIMITS, STRUCTURAL_CHILD_LIMIT, BOUND_COLLECTION_LIMIT, DATA_CONTROL_LIMITS,
  type FormFieldType, type NativeControlOption, type OverlayItem, type DataControlOption, type CalendarDate,
} from "@despia-native/dom";
import { resolveComponent, type Registry } from "@despia-native/compiler/resolve";
import type { XmlNode } from "@despia-native/compiler/xml";
import { stampNodeIds, type ComponentIR, type IRNode } from "@despia-native/compiler/component";

/** The `<searchbar>` chrome glyphs, emitted with the same geometry the DOM factory
 *  builds (elements.ts controlGlyph) so first paint and hydration agree exactly. */
const SEARCHBAR_GLYPHS = {
  glass: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4.2-4.2",
  clear: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 9l6 6M15 9l-6 6",
} as const;

function searchGlyph(d: string): string {
  return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"`
    + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<path d="${d}"></path></svg>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeStyleText(s: string): string {
  return s.replace(/<\/style/gi, "<\\/style");
}

const SURFACE_NAMES = new Set(["glass", "ultraThin", "thin", "regular", "thick", "sheet"]);

/** the static twin of the element library's tag/class contract */
const TAGS: { [dsx: string]: { tag: string; cls: string } } = {
  stack: { tag: "div", cls: "dsx-stack" },
  vstack: { tag: "div", cls: "dsx-stack dsx-vstack" },
  hstack: { tag: "div", cls: "dsx-stack dsx-hstack dsx-hstack-defaults" },
  zstack: { tag: "div", cls: "dsx-stack dsx-zstack" },
  scaffold: { tag: "div", cls: "dsx-scaffold" },
  text: { tag: "span", cls: "dsx-text" },
  label: { tag: "label", cls: "dsx-text" },
  markdown: { tag: "div", cls: "dsx-markdown" },
  button: { tag: "button", cls: "dsx-button" },
  pressable: { tag: "button", cls: "dsx-pressable" },
  glassButton: { tag: "button", cls: "dsx-button" },
  transport: { tag: "button", cls: "dsx-button" },
  row: { tag: "button", cls: "dsx-pressable" },
  image: { tag: "img", cls: "dsx-image" },
  scroll: { tag: "div", cls: "dsx-scroll" },
  spacer: { tag: "div", cls: "dsx-spacer" },
  divider: { tag: "div", cls: "dsx-divider" },
  flow: { tag: "div", cls: "dsx-flow" },
  toolbar: { tag: "div", cls: "dsx-toolbar" },
  list: { tag: "div", cls: "dsx-list" },
  grid: { tag: "div", cls: "dsx-list dsx-grid" },
  pager: { tag: "section", cls: "dsx-paged dsx-pager" },
  tabs: { tag: "div", cls: "dsx-tabs" },
  tabview: { tag: "div", cls: "dsx-tabs" },
  carousel: { tag: "section", cls: "dsx-paged dsx-carousel" },
  split: { tag: "div", cls: "dsx-split" },
  textfield: { tag: "input", cls: "dsx-textfield" },
  input: { tag: "input", cls: "dsx-textfield" },
  // <searchbar> is a COMPOSITE (/web/17): the host is presentational, the real search
  // input lives inside it with the leading glass and the trailing clear button.
  searchbar: { tag: "div", cls: "dsx-searchbar-field" },
  textarea: { tag: "textarea", cls: "dsx-textarea" },
  progress: { tag: "div", cls: "dsx-progress" },
  capsuleProgress: { tag: "div", cls: "dsx-progress" },
  spinner: { tag: "div", cls: "dsx-spinner" },
  activity: { tag: "div", cls: "dsx-spinner" },
  stepper: { tag: "div", cls: "dsx-stepper" },
  toggle: { tag: "label", cls: "dsx-toggle" },
  switch: { tag: "label", cls: "dsx-toggle" },
  slider: { tag: "input", cls: "dsx-slider" },
  picker: { tag: "label", cls: "dsx-native-choice dsx-picker" },
  wheelpicker: { tag: "label", cls: "dsx-native-choice dsx-wheelpicker" },
  datepicker: { tag: "label", cls: "dsx-datepicker" },
  date: { tag: "label", cls: "dsx-datepicker" },
  combobox: { tag: "div", cls: "dsx-combobox" },
  otp: { tag: "label", cls: "dsx-otp" },
  rangeslider: { tag: "div", cls: "dsx-rangeslider" },
  calendar: { tag: "section", cls: "dsx-calendar" },
  segmentedButton: { tag: "div", cls: "dsx-segmented-button" },
  refreshable: { tag: "section", cls: "dsx-refreshable" },
  refresh: { tag: "section", cls: "dsx-refreshable" },
  form: { tag: "form", cls: "dsx-form" },
  field: { tag: "div", cls: "dsx-field" },
  segmented: { tag: "div", cls: "dsx-segmented" },
  stars: { tag: "div", cls: "dsx-stars" },
  chart: { tag: "figure", cls: "dsx-chart" },
  map: { tag: "div", cls: "dsx-map" },
  WebView: { tag: "iframe", cls: "dsx-webview" },
  DSXWebView: { tag: "iframe", cls: "dsx-webview" },
  DSXView: { tag: "div", cls: "dsx-view" },
  qrcode: { tag: "span", cls: "dsx-qrcode" },
  // Universal native globals have DOM twins in globals.ts. They must also have
  // semantic server twins: otherwise static exports omit them entirely until the
  // client replace-mounts, producing an inaccessible first paint and layout shift.
  Checkbox: { tag: "label", cls: "dsx-checkbox" },
  ProgressRing: { tag: "div", cls: "dsx-progress-ring" },
  Skeleton: { tag: "div", cls: "dsx-skeleton" },
  ChatBubble: { tag: "div", cls: "dsx-chat-bubble" },
  Accordion: { tag: "div", cls: "dsx-accordion" },
  Signature: { tag: "div", cls: "dsx-signature" },
  Table: { tag: "div", cls: "dsx-table-frame" },
  RadioGroup: { tag: "div", cls: "dsx-radio-group" },
};

/** the reserved capitalized platform primitives — builtin wins over a colliding .dsx */
const RESERVED_SURFACE_TAGS = new Set(["WebView", "DSXWebView", "DSXView"]);
const BUTTON_FAMILY_TAGS = new Set(["button", "glassButton", "pressable", "transport", "row"]);
const TEXTFIELD_FAMILY_TAGS = new Set(["textfield", "input"]);
const TOGGLE_FAMILY_TAGS = new Set(["toggle", "switch"]);
const PROGRESS_FAMILY_TAGS = new Set(["progress", "capsuleProgress"]);
const SPINNER_FAMILY_TAGS = new Set(["spinner", "activity"]);

const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link"]);

type RenderSequences = { field: number; native: number; structural: number; overlay: number; application: number };

type RenderCtx = {
  registry: Registry;
  scheme: string;
  store: ReactiveStore;
  item: Dict | null;
  slots: { defaults: XmlNode[]; named: Map<string, XmlNode[]>; ctx: RenderCtx } | null;
  /** embed rendering (/web/13): top-level slots serialize as NATIVE <slot> elements */
  embed?: boolean;
  /** Enclosing Foundation form namespace, inherited by descendant fields. */
  formNamespace?: string;
  /** Per-document IDs: deterministic across requests and shared by nested components. */
  sequences: RenderSequences;
  /** adopt-hydration (W6): stamp every emitted element with its IR node identity
   *  (`data-dsx-n`, per-component preorder — stampNodeIds). renderPage turns this on;
   *  embeds and bare renderToString stay byte-identical to v0 output. */
  hydrate?: boolean;
  /** SSR api-hydration seeds (W6, doc 02) keyed by `as`, threaded to NESTED component
   *  renders so a child's ssr-resolved data paints on first render too (executeSsrApis
   *  collects them across the whole instance tree). Absent = every envelope seeds null. */
  apiSeeds?: { [as: string]: ApiSeed };
};

/** the hydration identity stamp for the GENERIC element path (appended last so the
 *  attribute order existing markup assertions rely on is untouched) */
function hydrationId(node: XmlNode, ctx: RenderCtx): string[] {
  if (ctx.hydrate !== true) return [];
  const nid = (node as IRNode).nid;
  return nid === undefined ? [] : [`data-dsx-n="${nid}"`];
}

/** same stamp injected onto a SPECIALIZED host's root tag (bound collections,
 *  overlay/application/media controls render whole strings) — right after the tag
 *  name, where the adopt walk reads it before anything else */
function stampHydrationId(html: string, node: XmlNode, ctx: RenderCtx): string {
  if (ctx.hydrate !== true) return html;
  const nid = (node as IRNode).nid;
  if (nid === undefined) return html;
  return html.replace(/^<([A-Za-z][A-Za-z0-9:-]*)/, `<$1 data-dsx-n="${nid}"`);
}

function safeStateName(value: string, fallback: string): string {
  const candidate = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate) ? candidate : fallback;
}

function fieldKind(value: string, secure: boolean): FormFieldType {
  if (secure) return "secure";
  return new Set(["text", "email", "number", "phone", "url", "secure", "toggle", "picker"]).has(value)
    ? value as FormFieldType
    : "text";
}

function booleanAttribute(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "1";
}

function ensureFormNamespace(ctx: RenderCtx, namespace: string): void {
  if (ctx.store.vars.has(namespace)) return;
  const initial = JSE.eval(namespace, ctx.store.jse, ctx.item);
  ctx.store.set(namespace, isDict(initial) ? { ...(initial as Dict) } : {});
}

function interp(ctx: RenderCtx, s: string): string {
  return s.includes("{{") ? JSE.interpolate(s, ctx.store.jse, ctx.item) : s;
}

/** The attrs map a bridge fold reads as CONTEXT (gradient modifiers, the one-property
 *  families), with every reactive context attribute resolved. Returns the raw map itself when
 *  nothing in it is reactive - callers use that identity to keep the static fast path, where
 *  the compiled class already carries the styles and SSR inlines only reactive values. */
function bridgeFoldContext(
  ctx: RenderCtx,
  attrs: Record<string, string>,
): Record<string, string> {
  let resolved: Record<string, string> | null = null;
  for (const key of BRIDGE_CONTEXT_ATTRS) {
    const raw = attrs[key];
    if (raw === undefined || !raw.includes("{{")) continue;
    resolved ??= { ...attrs };
    resolved[key] = interp(ctx, raw).trim();
  }
  return resolved ?? attrs;
}

/** The whole-attribute style hole's SSR half (`__style_list` — a sole `{{ }}` style
 *  attribute yielding a full declaration list, the css-typed override door): evaluate
 *  once, parse, map each declaration through the shared sanitizer. */
function styleListDecls(ctx: RenderCtx, template: string): string[] {
  const out: string[] = [];
  for (const [property, value] of parseStyleAttr(interp(ctx, template))) {
    const mapped = mapStyleValue(property, value);
    if (mapped.length > 0) out.push(`${property}: ${mapped}`);
  }
  return out;
}

function componentColor(value: string | undefined, fallback: string): string {
  const raw = (value ?? fallback).trim();
  // These values are concatenated into SSR style declarations. Use the compiler's
  // shared single-value sanitizer as well as its semantic token mapping: HTML
  // escaping cannot stop a semicolon from injecting an additional declaration.
  return mapStyleValue("color", raw);
}

/** The initial-value twin of globals.ts's bindValue helper. */
function boundNumber(ctx: RenderCtx, expr: string | undefined, fallback = 0): number {
  if (expr === undefined) return fallback;
  const value = expr.includes("{{")
    ? interp(ctx, expr)
    : JSE.eval(expr, ctx.store.jse, ctx.item);
  return number(value) ?? fallback;
}

/** The `<Signature>` bound stroke list, read the way globals.ts's bindValue reads it. */
function boundSignature(ctx: RenderCtx, expr: string | undefined): InkStroke[] {
  if (expr === undefined) return [];
  return decodeInk(expr.includes("{{")
    ? interp(ctx, expr)
    : JSE.eval(expr, ctx.store.jse, ctx.item));
}

/** globals.ts treats max as a static number except for the explicit {{ }} form. */
function progressMaximum(ctx: RenderCtx, expr: string | undefined): number {
  if (expr === undefined) return 1;
  return expr.includes("{{") ? boundNumber(ctx, expr, 0) : number(expr) ?? 1;
}

function nativeControlOptions(node: XmlNode, ctx: RenderCtx): NativeControlOption[] {
  if (node.attrs["optionsKey"] !== undefined) {
    return normalizeNativeControlOptions(
      JSE.eval(node.attrs["optionsKey"], ctx.store.jse, ctx.item),
      node.attrs["valueField"] ?? "id",
      node.attrs["labelField"] ?? "label",
    );
  }
  return parseNativeControlCsv(interp(ctx, node.attrs["options"] ?? ""));
}

function dataControlOptions(node: XmlNode, ctx: RenderCtx): DataControlOption[] {
  if (node.attrs["optionsKey"] !== undefined) {
    return normalizeDataControlOptions(
      JSE.eval(node.attrs["optionsKey"], ctx.store.jse, ctx.item),
      node.attrs["valueField"] ?? "id",
      node.attrs["labelField"] ?? "label",
    );
  }
  return parseDataControlCsv(interp(ctx, node.attrs["options"] ?? ""))
    .map((value) => ({ value, label: value }));
}

function dataText(value: unknown): string {
  return string(value).substring(0, DATA_CONTROL_LIMITS.textCharacters);
}

function serverCalendarDate(date: CalendarDate): Date {
  const value = new Date(0);
  value.setHours(12, 0, 0, 0);
  value.setFullYear(date.year, date.month - 1, date.day);
  return value;
}

function serverToday(): CalendarDate {
  const date = new Date();
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function compareCalendarDate(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

// The DECLARED word reads the strict component boolean the hydrating DOM (`declaredBool`),
// iOS (`dsx.bool`) and both Kotlin renderers share - NOT truthy(), whose string law makes
// truthy("false") true and would disable on the server a control the client enables.
// disabled-if keeps the truthy CONDITION read.
function declaredControlBool(value: string): boolean {
  const v = value.trim();
  if (v === "true") return true;
  const n = Number(v);
  return v !== "" && !Number.isNaN(n) && n !== 0;
}

function nativeControlDisabled(node: XmlNode, ctx: RenderCtx): boolean {
  const declared = node.attrs["disabled"] !== undefined && declaredControlBool(interp(ctx, node.attrs["disabled"]));
  const conditional = node.attrs["disabled-if"] !== undefined
    && truthy(JSE.eval(node.attrs["disabled-if"], ctx.store.jse, ctx.item));
  return declared || conditional;
}

function nativeRangeValues(node: XmlNode, ctx: RenderCtx): {
  bounds: ReturnType<typeof normalizeRangeBounds>;
  low: number;
  high: number;
} {
  const bounds = normalizeRangeBounds(node.attrs["min"], node.attrs["max"], node.attrs["step"]);
  const read = (attribute: "bindLow" | "bindHigh", fallback: number): number => {
    const expression = node.attrs[attribute];
    const parsed = expression === undefined ? null : number(JSE.eval(expression, ctx.store.jse, ctx.item));
    return parsed !== null && parsed !== undefined && Number.isFinite(parsed) ? parsed : fallback;
  };
  const low = Math.min(Math.max(read("bindLow", bounds.min), bounds.min), bounds.max);
  const high = Math.max(Math.min(read("bindHigh", bounds.max), bounds.max), low);
  return { bounds, low, high };
}

const OVERLAY_TAGS = new Set(["sheet", "alert", "confirmDialog", "popover", "menu", "contextmenu"]);
const APPLICATION_CONTROL_TAGS = new Set(["Drawer", "MenuBar"]);
const MEDIA_SURFACE_TAGS = new Set(["audio", "video", "svg", "lightbox"]);

function overlayText(value: unknown): string {
  return Array.from(string(value).substring(0, OVERLAY_LIMITS.maxTextCharacters * 4))
    .slice(0, OVERLAY_LIMITS.maxTextCharacters).join("");
}

function overlayPresent(node: XmlNode, ctx: RenderCtx): boolean {
  const expression = node.attrs["present"];
  return expression !== undefined && truthy(JSE.eval(expression, ctx.store.jse, ctx.item));
}

function overlayItems(node: XmlNode, ctx: RenderCtx, attribute: "buttons" | "menu"): OverlayItem[] {
  const expression = node.attrs[attribute];
  return normalizeOverlayItems(expression === undefined ? [] : JSE.eval(expression, ctx.store.jse, ctx.item));
}

function overlayHostAttributes(node: XmlNode, ctx: RenderCtx, base: string): string {
  const classes = ["dsx-overlay-host", base];
  const authored = node.attrs["class"];
  if (authored !== undefined) {
    for (const token of interp(ctx, authored).split(/\s+/)) if (token.length > 0) classes.push(token);
  }
  const surface = node.attrs["surface"] === undefined ? "" : interp(ctx, node.attrs["surface"]).trim();
  if (SURFACE_NAMES.has(surface)) classes.push(`dsx-surface-${surface}`);
  const attrs = [`class="${escapeHtml(classes.join(" "))}"`];
  const css = node.attrs["__css"];
  if (css !== undefined && css.length > 0) attrs.push(`data-dsx="${escapeHtml(css)}"`);
  const theme = node.attrs["theme"];
  if (theme !== undefined) {
    const value = interp(ctx, theme).trim();
    if (value === "dark" || value === "light") attrs.push(`data-dsx-theme="${value}"`);
  }
  // density= — the W9 subtree knob's SSR half: stamp the same validated initial value
  // the DOM renderer stamps (input/density.json fold), so first paint and hydration agree.
  const density = node.attrs["density"];
  if (density !== undefined) {
    const value = interp(ctx, density).trim();
    if (value === "comfortable" || value === "compact") attrs.push(`data-dsx-density="${value}"`);
  }
  return attrs.join(" ");
}

function renderOverlayMenuLevel(items: readonly OverlayItem[], nested = false): string {
  const rows = items.map((item) => {
    if (item.separator) return `<div class="dsx-menu-separator" role="separator"></div>`;
    const role = item.role === "normal" ? "" : ` data-dsx-role="${item.role}"`;
    const disabled = item.disabled ? " disabled" : "";
    const icon = item.icon.length === 0 ? ""
      : `<span class="dsx-menu-item-icon" aria-hidden="true" data-dsx-icon="${escapeHtml(item.icon)}"></span>`;
    if (item.items.length > 0) {
      return `<div class="dsx-menu-row"><button class="dsx-menu-item" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false"${role}${disabled}>`
        + `${icon}<span class="dsx-menu-item-label">${escapeHtml(item.title)}</span><span class="dsx-menu-item-arrow" aria-hidden="true">›</span></button>`
        + `${renderOverlayMenuLevel(item.items, true)}</div>`;
    }
    return `<div class="dsx-menu-row"><button class="dsx-menu-item" type="button" role="menuitem"${role}${disabled}>`
      + `${icon}<span class="dsx-menu-item-label">${escapeHtml(item.title)}</span></button></div>`;
  }).join("");
  return `<div class="dsx-menu-level${nested ? " dsx-submenu" : ""}" role="menu" tabindex="-1"${nested ? ' hidden inert' : ""}>${rows}</div>`;
}

function stampOverlayTrigger(markup: string, popup: "dialog" | "menu", panelId: string): {
  markup: string;
  wrapperAttributes: string;
  triggerId: string;
} {
  const match = /<(button|a|input|select|textarea)(\s[^>]*)?>/i.exec(markup);
  const triggerId = `${panelId}-trigger`;
  const semantic = ` aria-haspopup="${popup}" aria-expanded="false" aria-controls="${panelId}"`;
  if (match === null) {
    return {
      markup,
      wrapperAttributes: ` role="button" tabindex="0" id="${triggerId}"${semantic}`,
      triggerId,
    };
  }
  const tag = match[1]!;
  const rawAttrs = match[2] ?? "";
  const existingId = /\sid="([^"]+)"/i.exec(rawAttrs)?.[1];
  const id = existingId ?? triggerId;
  const replacement = `<${tag}${rawAttrs}${existingId === undefined ? ` id="${triggerId}"` : ""}${semantic}>`;
  return {
    markup: markup.substring(0, match.index) + replacement + markup.substring(match.index + match[0].length),
    wrapperAttributes: "",
    triggerId: id,
  };
}

function renderOverlayNode(node: XmlNode, ctx: RenderCtx): string {
  const sequence = ++ctx.sequences.overlay;
  const visible = overlayPresent(node, ctx);
  const closed = visible ? "" : ' hidden inert aria-hidden="true"';
  const renderChildren = (slot?: string): string => node.children
    .filter((child) => slot === undefined
      ? child.attrs["slot"] === undefined || child.attrs["slot"] === ""
      : child.attrs["slot"] === slot)
    .slice(0, OVERLAY_LIMITS.maxChildren)
    .map((child) => renderNode(child, ctx)).join("");

  if (node.tag === "menu" || node.tag === "contextmenu") {
    const context = node.tag === "contextmenu";
    const hostClass = context ? "dsx-contextmenu-host" : "dsx-menu-host";
    const items = overlayItems(node, ctx, "menu");
    const panelId = `dsx-menu-panel-${sequence}`;
    const trigger = stampOverlayTrigger(renderChildren(), "menu", panelId);
    return `<span ${overlayHostAttributes(node, ctx, hostClass)}><span class="dsx-menu-trigger"${trigger.wrapperAttributes}>`
      + `${trigger.markup}</span><div class="dsx-floating-layer dsx-menu-layer" hidden inert aria-hidden="true">`
      + `<div class="dsx-floating-panel dsx-menu-panel" id="${panelId}" role="presentation" tabindex="-1">${renderOverlayMenuLevel(items)}</div></div></span>`;
  }

  if (node.tag === "popover") {
    const rawArrow = interp(ctx, node.attrs["arrow"] ?? "top");
    const arrow = rawArrow === "bottom" || rawArrow === "leading" || rawArrow === "trailing" ? rawArrow : "top";
    const panelId = `dsx-popover-panel-${sequence}`;
    const trigger = stampOverlayTrigger(renderChildren(), "dialog", panelId);
    return `<span ${overlayHostAttributes(node, ctx, "dsx-popover-host")}><span class="dsx-popover-anchor"${trigger.wrapperAttributes}>${trigger.markup}</span>`
      + `<div class="dsx-floating-layer dsx-popover-layer"${closed}><section class="dsx-floating-panel dsx-popover-panel" id="${panelId}" role="dialog" aria-modal="false" tabindex="-1" aria-labelledby="${escapeHtml(trigger.triggerId)}" data-dsx-arrow="${arrow}">`
      + `${renderChildren("content")}</section></div></span>`;
  }

  if (node.tag === "sheet") {
    const rawMode = interp(ctx, node.attrs["mode"] ?? "sheet");
    const mode = rawMode === "card" || rawMode === "cover" ? rawMode : "sheet";
    const detents = normalizeSheetDetents(interp(ctx, node.attrs["detents"] ?? "half,full"));
    const title = overlayText(interp(ctx, node.attrs["title"] ?? ""));
    const action = overlayText(interp(ctx, node.attrs["action"] ?? ""));
    const actionIcon = overlayText(interp(ctx, node.attrs["actionIcon"] ?? ""));
    const hasChrome = ["title", "action", "actionIcon", "close"].some((name) => node.attrs[name] !== undefined);
    const closeSide = interp(ctx, node.attrs["close"] ?? "leading") === "trailing" ? "trailing" : "leading";
    const actionSide = interp(ctx, node.attrs["actionSide"] ?? "trailing") === "leading" ? "leading" : "trailing";
    const closeVisible = hasChrome && interp(ctx, node.attrs["close"] ?? "leading") !== "none";
    const close = closeVisible
      ? `<button class="dsx-sheet-close" type="button" aria-label="Close"><span aria-hidden="true">×</span></button>` : "";
    const actionMarkup = action.length > 0 || actionIcon.length > 0
      ? `<button class="dsx-sheet-action" type="button">${actionIcon.length > 0 ? `<span aria-hidden="true" data-dsx-icon="${escapeHtml(actionIcon)}"></span>` : ""}${escapeHtml(action)}</button>` : "";
    const leading = `${closeSide === "leading" ? close : ""}${actionSide === "leading" ? actionMarkup : ""}`;
    const trailing = `${closeSide === "trailing" ? close : ""}${actionSide === "trailing" ? actionMarkup : ""}`;
    const sheetStyles: string[] = [];
    if (node.attrs["inset"] !== undefined) {
      const parsed = number(interp(ctx, node.attrs["inset"]!));
      const value = parsed !== null && parsed !== undefined && Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 128) : 14;
      sheetStyles.push(`--dsx-sheet-inset: ${value}px`);
    }
    let backgroundAttribute = "";
    if (node.attrs["background"] !== undefined) {
      const background = normalizeSheetBackground(interp(ctx, node.attrs["background"]!));
      backgroundAttribute = ` data-dsx-background="${background === null ? "system" : "authored"}"`;
      if (background !== null) sheetStyles.push(`--dsx-sheet-background: ${background}`);
    }
    const sheetStyle = sheetStyles.length === 0 ? "" : ` style="${escapeHtml(sheetStyles.join("; "))}"`;
    const titleId = `dsx-sheet-title-${sequence}`;
    return `<span ${overlayHostAttributes(node, ctx, "dsx-sheet-host")}><div class="dsx-overlay-layer dsx-sheet-layer" role="presentation"${closed}>`
      + `<div class="dsx-overlay-scrim" aria-hidden="true"></div><section class="dsx-overlay-panel dsx-sheet-panel" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="${titleId}" data-dsx-mode="${mode}" data-dsx-detent="${detents[0]}"${backgroundAttribute}${sheetStyle}>`
      + `<button class="dsx-sheet-grabber" type="button" aria-label="Resize sheet" aria-valuetext="${detents[0]}" aria-valuemin="1" aria-valuemax="${detents.length}" aria-valuenow="1"${mode === "cover" ? " hidden" : ""}></button>`
      + `<header class="dsx-sheet-chrome"${hasChrome ? "" : " hidden"}><div class="dsx-sheet-chrome-side dsx-sheet-chrome-leading">${leading}</div>`
      + `<h2 class="dsx-sheet-title" id="${titleId}">${escapeHtml(title)}</h2><div class="dsx-sheet-chrome-side dsx-sheet-chrome-trailing">${trailing}</div></header>`
      + `<div class="dsx-sheet-content">${renderChildren()}</div></section></div></span>`;
  }

  const confirm = node.tag === "confirmDialog";
  let items = overlayItems(node, ctx, "buttons");
  if (!confirm && items.length === 0) items = normalizeOverlayItems([{ label: "OK" }]);
  if (confirm && !items.some((item) => item.role === "cancel")) {
    items = [...items, ...normalizeOverlayItems([{ label: "Cancel", role: "cancel" }])];
  }
  const kind = confirm ? "confirm" : "alert";
  const title = overlayText(interp(ctx, node.attrs["title"] ?? ""));
  const message = overlayText(interp(ctx, node.attrs["message"] ?? ""));
  const titleId = `dsx-${kind}-title-${sequence}`;
  const messageId = `dsx-${kind}-message-${sequence}`;
  const actions = items.map((item) => item.separator
    ? `<div class="dsx-dialog-separator" role="separator"></div>`
    : `<button class="dsx-dialog-action" type="button"${item.role === "normal" ? "" : ` data-dsx-role="${item.role}"`}${item.disabled ? " disabled" : ""}>${escapeHtml(item.title)}</button>`,
  ).join("");
  return `<span ${overlayHostAttributes(node, ctx, `dsx-${kind}-host`)}><div class="dsx-overlay-layer dsx-${kind}-layer" role="presentation"${closed}>`
    + `<div class="dsx-overlay-scrim" aria-hidden="true"></div><section class="dsx-overlay-panel dsx-${kind}-panel" role="${confirm ? "dialog" : "alertdialog"}" aria-modal="true" tabindex="-1" aria-labelledby="${titleId}" aria-describedby="${messageId}">`
    + `<div class="dsx-dialog-body"><h2 class="dsx-dialog-title" id="${titleId}">${escapeHtml(title)}</h2><p class="dsx-dialog-message" id="${messageId}">${escapeHtml(message)}</p></div>`
    + `<div class="dsx-dialog-actions">${actions}</div></section></div></span>`;
}

function applicationHostAttributes(node: XmlNode, ctx: RenderCtx, base: string): string {
  const classes = ["dsx-application-control-host", base];
  const authored = node.attrs["class"];
  if (authored !== undefined) {
    for (const token of interp(ctx, authored).split(/\s+/)) if (token.length > 0) classes.push(token);
  }
  const surface = node.attrs["surface"] === undefined ? "" : interp(ctx, node.attrs["surface"]).trim();
  if (SURFACE_NAMES.has(surface)) classes.push(`dsx-surface-${surface}`);
  const attrs = [`class="${escapeHtml(classes.join(" "))}"`];
  const css = node.attrs["__css"];
  if (css !== undefined && css.length > 0) attrs.push(`data-dsx="${escapeHtml(css)}"`);
  const universal = applicationUniversalAttributes(node, ctx, true);
  attrs.push(...universal.attrs);
  if (universal.styles.length > 0) attrs.push(`style="${escapeHtml(universal.styles.join("; "))}"`);
  return attrs.join(" ");
}

function applicationUniversalAttributes(
  node: XmlNode,
  ctx: RenderCtx,
  includeLabel: boolean,
): { attrs: string[]; styles: string[] } {
  const attrs: string[] = [];
  const styles: string[] = [];
  const grow = node.attrs["grow"];
  if (grow !== undefined) {
    const value = interp(ctx, grow);
    if (value === "true" || value === "width" || value === "height") attrs.push(`data-dsx-grow="${value}"`);
  }
  const theme = node.attrs["theme"];
  if (theme !== undefined) {
    const value = interp(ctx, theme).trim();
    if (value === "dark" || value === "light") attrs.push(`data-dsx-theme="${value}"`);
  }
  // density= — the W9 subtree knob's SSR half: stamp the same validated initial value
  // the DOM renderer stamps (input/density.json fold), so first paint and hydration agree.
  const density = node.attrs["density"];
  if (density !== undefined) {
    const value = interp(ctx, density).trim();
    if (value === "comfortable" || value === "compact") attrs.push(`data-dsx-density="${value}"`);
  }
  const reactiveStyle = node.attrs["__style_reactive"];
  if (reactiveStyle !== undefined) {
    for (const declaration of reactiveStyle.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = interp(ctx, declaration.slice(colon + 1)).trim();
      if (value.length > 0) styles.push(`${property}: ${mapStyleValue(property, value)}`);
    }
  }
  const styleListAttr = node.attrs["__style_list"];
  if (styleListAttr !== undefined) styles.push(...styleListDecls(ctx, styleListAttr));
  // A fold whose CONTEXT is reactive lost its compiled class too (css.ts bails on the whole
  // node), so SSR must inline every bridge attr on such a node - not just the ones whose own
  // value carries a template - or the server page ships those styles nowhere and the first
  // paint flashes unstyled until hydration. The context map is resolved for the same reason
  // the runtime resolves it: a fold handed "{{ ... }}" as a stop list parses nothing.
  const foldContext = bridgeFoldContext(ctx, node.attrs);
  for (const [name, source] of Object.entries(node.attrs)) {
    if (!BRIDGE_ATTRS.has(name)) continue;
    if (!source.includes("{{") && foldContext === node.attrs) continue;
    for (const [property, value] of legacyAttrToDecls(name, interp(ctx, source).trim(), foldContext) ?? []) {
      styles.push(`${property}: ${value}`);
    }
  }
  const accessibility = (dsx: string, aria: string): string | undefined => node.attrs[dsx] ?? node.attrs[aria];
  const role = node.attrs["role"];
  if (node.attrs["a11yGroup"] === "true" || role === "group") attrs.push('role="group"');
  else if (node.attrs["a11yTrait"] === "header") attrs.push('role="heading"', 'aria-level="2"');
  else if (role !== undefined) {
    const value = interp(ctx, role).trim();
    if (value.length > 0) attrs.push(`role="${escapeHtml(value)}"`);
  }
  if (accessibility("a11yHidden", "aria-hidden") === "true") attrs.push('aria-hidden="true"');
  if (includeLabel) {
    const label = accessibility("a11yLabel", "aria-label");
    if (label !== undefined) attrs.push(`aria-label="${escapeHtml(interp(ctx, label))}"`);
  }
  const hint = accessibility("a11yHint", "aria-description");
  if (hint !== undefined) attrs.push(`aria-description="${escapeHtml(interp(ctx, hint))}"`);
  const valueText = accessibility("a11yValue", "aria-valuetext");
  if (valueText !== undefined) attrs.push(`aria-valuetext="${escapeHtml(interp(ctx, valueText))}"`);
  const pressed = accessibility("a11yPressed", "aria-pressed");
  if (pressed !== undefined) {
    const value = interp(ctx, pressed).trim().toLowerCase();
    if (value === "true" || value === "1") attrs.push('aria-pressed="true"');
    else if (value === "false" || value === "0") attrs.push('aria-pressed="false"');
    else if (value === "mixed") attrs.push('aria-pressed="mixed"');
  }
  return { attrs, styles };
}

function applicationSeedValue(node: XmlNode, ctx: RenderCtx, name: string): unknown {
  const explicit = node.attrs[name];
  if (explicit !== undefined) {
    return explicit.includes("{{") ? interp(ctx, explicit) : JSE.eval(explicit, ctx.store.jse, ctx.item);
  }
  const topLevel = JSE.eval(name, ctx.store.jse, ctx.item);
  return topLevel === null || topLevel === undefined
    ? JSE.eval(`vars.${name}`, ctx.store.jse, ctx.item)
    : topLevel;
}

function renderApplicationControlNode(node: XmlNode, ctx: RenderCtx): string {
  if (node.tag === "Drawer") {
    const sequence = ++ctx.sequences.application;
    const presentExpression = node.attrs["present"];
    const visible = presentExpression === undefined
      || truthy(JSE.eval(presentExpression, ctx.store.jse, ctx.item));
    const closed = visible ? "" : ' hidden inert aria-hidden="true"';
    const label = interp(ctx, node.attrs["a11yLabel"] ?? node.attrs["title"] ?? "Drawer").trim() || "Drawer";
    const body = node.children.slice(0, 1_000).map((child) => renderNode(child, ctx)).join("");
    return `<span ${applicationHostAttributes(node, ctx, "dsx-drawer-host")}><div class="dsx-drawer-layer" role="presentation"${closed}>`
      + `<div class="dsx-drawer-scrim" aria-hidden="true"></div><section class="dsx-drawer-panel" id="dsx-drawer-panel-${sequence}" role="dialog" aria-modal="true" tabindex="-1" aria-label="${escapeHtml(label)}">`
      + `<button class="dsx-drawer-handle" type="button" aria-label="Dismiss drawer"></button>`
      + `<div class="dsx-drawer-content">${body}</div></section></div></span>`;
  }

  const items = normalizeMenuBarItems(applicationSeedValue(node, ctx, "items"));
  // Native MenuBar deliberately ignores selected=; selection is surface state.
  const selectedSeed = JSE.eval("selected", ctx.store.jse, ctx.item);
  const selected = normalizeMenuBarEnabledIndex(
    items,
    selectedSeed === null || selectedSeed === undefined
      ? JSE.eval("vars.selected", ctx.store.jse, ctx.item)
      : selectedSeed,
  );
  const darkValue = applicationSeedValue(node, ctx, "dark");
  const dark = darkValue === null || darkValue === undefined ? true : truthy(darkValue);
  const label = interp(ctx, node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? "Primary navigation").trim()
    || "Primary navigation";
  const classes = ["dsx-menu-bar"];
  const authored = node.attrs["class"];
  if (authored !== undefined) {
    for (const token of interp(ctx, authored).split(/\s+/)) if (token.length > 0) classes.push(token);
  }
  const surface = node.attrs["surface"] === undefined ? "" : interp(ctx, node.attrs["surface"]).trim();
  if (SURFACE_NAMES.has(surface)) classes.push(`dsx-surface-${surface}`);
  const extra: string[] = [];
  const css = node.attrs["__css"];
  if (css !== undefined && css.length > 0) extra.push(`data-dsx="${escapeHtml(css)}"`);
  const universal = applicationUniversalAttributes(node, ctx, false);
  extra.push(...universal.attrs);
  const styles = [...universal.styles];
  const tintValue = applicationSeedValue(node, ctx, "tint");
  const tint = normalizeMenuBarTint(string(tintValue));
  if (tint !== null) styles.push(`--dsx-menu-bar-tint: ${tint}`);
  if (styles.length > 0) extra.push(`style="${escapeHtml(styles.join("; "))}"`);
  const buttons = items.map((item, index) => {
    const active = selected !== null && index === selected;
    return `<button class="dsx-menu-bar-item" type="button" role="menuitemradio" aria-checked="${String(active)}" aria-current="${active ? "page" : "false"}" aria-disabled="${String(item.disabled)}" aria-label="${escapeHtml(item.name || `Item ${index + 1}`)}" data-dsx-key="${escapeHtml(item.key)}" data-dsx-index="${index}" data-dsx-selected="${String(active)}" tabindex="${active ? 0 : -1}"${item.disabled ? " disabled" : ""}>`
      + `<span class="dsx-menu-bar-icon" aria-hidden="true" data-dsx-icon="${escapeHtml(item.icon)}"></span>`
      + `<span class="dsx-menu-bar-label">${escapeHtml(item.name)}</span></button>`;
  }).join("");
  return `<nav class="${escapeHtml(classes.join(" "))}" aria-label="${escapeHtml(label)}" data-dsx-tone="${dark ? "dark" : "light"}" data-dsx-empty="${String(items.length === 0)}"${items.length === 0 ? " hidden" : ""}${extra.length > 0 ? ` ${extra.join(" ")}` : ""}>`
    + `<div class="dsx-menu-bar-list" role="menubar" aria-orientation="horizontal" aria-label="${escapeHtml(label)}" aria-disabled="${String(selected === null)}" tabindex="${selected === null ? 0 : -1}"><span class="dsx-menu-bar-pill" aria-hidden="true"${selected === null ? " hidden" : ""}></span>${buttons}</div></nav>`;
}

function mediaSeedValue(node: XmlNode, ctx: RenderCtx, name: string): unknown {
  const expression = node.attrs[name];
  if (expression === undefined) return undefined;
  return expression.includes("{{") ? interp(ctx, expression) : JSE.eval(expression, ctx.store.jse, ctx.item);
}

function mediaHostAttributes(
  node: XmlNode,
  ctx: RenderCtx,
  baseClass: string,
  includeLabel: boolean,
  styles: string[] = [],
): string {
  const classes = [baseClass];
  if (node.attrs["class"] !== undefined) {
    for (const token of interp(ctx, node.attrs["class"]!).split(/\s+/)) if (token.length > 0) classes.push(token);
  }
  const surface = node.attrs["surface"] === undefined ? "" : interp(ctx, node.attrs["surface"]!).trim();
  if (SURFACE_NAMES.has(surface)) classes.push(`dsx-surface-${surface}`);
  const attrs = [`class="${escapeHtml(classes.join(" "))}"`];
  const css = node.attrs["__css"];
  if (css !== undefined && css.length > 0) attrs.push(`data-dsx="${escapeHtml(css)}"`);
  const universal = applicationUniversalAttributes(node, ctx, false);
  attrs.push(...universal.attrs);
  if (includeLabel) {
    const source = node.attrs["a11yLabel"] ?? node.attrs["aria-label"];
    if (source !== undefined) attrs.push(`aria-label="${escapeHtml(boundedMediaText(interp(ctx, source)))}"`);
  }
  // Factory defaults land first on the client; generic authored/reactive styles
  // run afterward and therefore must win in SSR declaration order as well.
  const allStyles = [...styles, ...universal.styles];
  if (allStyles.length > 0) attrs.push(`style="${escapeHtml(allStyles.join("; "))}"`);
  return attrs.join(" ");
}

function renderMediaSurfaceNode(node: XmlNode, ctx: RenderCtx): string {
  if (node.tag === "audio" || node.tag === "video") {
    const src = safeMediaUrl(interp(ctx, node.attrs["src"] ?? ""));
    const loop = booleanAttribute(interp(ctx, node.attrs["loop"] ?? "false")) ? " loop" : "";
    const muted = booleanAttribute(interp(ctx, node.attrs["muted"] ?? "false")) ? " muted" : "";
    if (node.tag === "audio") {
      const source = src === null ? "" : ` src="${escapeHtml(src)}"`;
      const attrs = mediaHostAttributes(node, ctx, "dsx-audio", true);
      const hidden = attrs.includes(' aria-hidden="') ? "" : ' aria-hidden="true"';
      const session = normalizeAudioSessionCategory(interp(ctx, node.attrs["session"] ?? ""), "audio");
      return `<audio ${attrs} preload="metadata" tabindex="-1" data-dsx-session="${session}"${hidden}${source}${loop}${muted}></audio>`;
    }
    const gravity = interp(ctx, node.attrs["gravity"] ?? "fill") === "fit" ? "contain" : "cover";
    const attrs = mediaHostAttributes(node, ctx, "dsx-video", true, [`object-fit: ${gravity}`]);
    const label = node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined
      ? ' aria-label="Video"' : "";
    const source = src === null ? "" : ` src="${escapeHtml(src)}"`;
    const session = normalizeAudioSessionCategory(interp(ctx, node.attrs["audio"] ?? ""), "video");
    return `<video ${attrs} preload="metadata" playsinline data-dsx-session="${session}"${label}${source}${loop}${muted}></video>`;
  }

  if (node.tag === "svg") {
    const asset = interp(ctx, node.attrs["asset"] ?? "").slice(0, MEDIA_SURFACE_LIMITS.svgCharacters + 1);
    const src = interp(ctx, node.attrs["src"] ?? "").slice(0, MEDIA_SURFACE_LIMITS.svgCharacters + 1);
    const d = interp(ctx, node.attrs["d"] ?? "").slice(0, MEDIA_SURFACE_LIMITS.svgCharacters + 1);
    const viewBox = interp(ctx, node.attrs["viewBox"] ?? "0 0 100 100")
      .slice(0, MEDIA_SURFACE_LIMITS.svgViewBoxCharacters + 1);
    const fill = interp(ctx, node.attrs["fill"] ?? "#000000")
      .slice(0, MEDIA_SURFACE_LIMITS.svgPaintCharacters + 1);
    const graphic = sanitizeSvgSource(asset) ?? sanitizeSvgSource(src)
      ?? (d.length > 0 ? svgFromPath(d, viewBox, fill) : null);
    const styles: string[] = [];
    for (const dimension of ["width", "height"] as const) {
      if (node.attrs[dimension] === undefined) continue;
      const raw = number(interp(ctx, node.attrs[dimension]!));
      const value = raw !== null && raw !== undefined && Number.isFinite(raw)
        ? Math.min(Math.max(raw, 0), MEDIA_SURFACE_LIMITS.svgDimension) : 0;
      styles.push(`${dimension}: ${value}px`);
    }
    const hasLabel = node.attrs["a11yLabel"] !== undefined || node.attrs["aria-label"] !== undefined;
    const authoredRole = node.attrs["role"] !== undefined || node.attrs["a11yGroup"] === "true"
      || node.attrs["a11yTrait"] === "header";
    const attrs = mediaHostAttributes(node, ctx, "dsx-svg", hasLabel, styles);
    const semantic = hasLabel ? (authoredRole ? "" : ' role="img"')
      : attrs.includes(' aria-hidden="') ? "" : ' aria-hidden="true"';
    const bundleKey = graphic === null ? svgBundleKey(asset, src) : null;
    const unresolved = bundleKey === null ? "" : ` data-dsx-unresolved="${bundleKey}"`;
    return `<span ${attrs} data-dsx-valid="${String(graphic !== null)}"${unresolved}${semantic}>${graphic ?? ""}</span>`;
  }

  const visible = overlayPresent(node, ctx);
  const sourceField = interp(ctx, node.attrs["srcField"] ?? "src");
  const images = node.attrs["images"] !== undefined
    ? normalizeLightboxImages(mediaSeedValue(node, ctx, "images"), sourceField)
    : parseLightboxUrls(interp(ctx, node.attrs["urls"] ?? ""));
  const rawIndex = number(mediaSeedValue(node, ctx, "index")) ?? 0;
  const index = images.length === 0 ? 0 : Math.min(Math.max(Math.trunc(rawIndex), 0), images.length - 1);
  const current = images[index];
  const closed = visible ? "" : ' hidden inert aria-hidden="true"';
  const label = boundedMediaText(interp(
    ctx, node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? "Photo viewer",
  )).trim() || "Photo viewer";
  const image = current === undefined
    ? '<img class="dsx-lightbox-image" hidden alt="">'
    : `<img class="dsx-lightbox-image"${visible ? ` src="${escapeHtml(current.src)}"` : ""} alt="Photo ${index + 1} of ${images.length}">`;
  const empty = `<p class="dsx-lightbox-empty"${current === undefined ? "" : " hidden"}>No photos available</p>`;
  const counter = images.length === 0 ? "0 / 0" : `${index + 1} / ${images.length}`;
  const counterLabel = images.length === 0 ? "No photos" : `Photo ${index + 1} of ${images.length}`;
  const previousDisabled = images.length < 2 || index <= 0 ? " disabled" : "";
  const nextDisabled = images.length < 2 || index >= images.length - 1 ? " disabled" : "";
  const color = normalizeLightboxColor(interp(ctx, node.attrs["color"] ?? "white"));
  return `<span ${mediaHostAttributes(node, ctx, "dsx-lightbox-host", true)}><div class="dsx-lightbox-layer" style="--dsx-lightbox-color: ${escapeHtml(color)}"${closed}>`
    + `<button class="dsx-lightbox-scrim" type="button" tabindex="-1" aria-label="Close photo viewer"></button>`
    + `<section class="dsx-lightbox-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}" tabindex="-1">`
    + `<div class="dsx-lightbox-stage">${image}${empty}</div><div class="dsx-lightbox-chrome">`
    + `<button class="dsx-lightbox-previous" type="button" aria-label="Previous photo"${previousDisabled}>‹</button>`
    + `<span class="dsx-lightbox-counter" aria-live="polite" aria-atomic="true" aria-label="${escapeHtml(counterLabel)}">${counter}</span>`
    + `<button class="dsx-lightbox-next" type="button" aria-label="Next photo"${nextDisabled}>›</button>`
    + `<button class="dsx-lightbox-close" type="button" aria-label="Close photo viewer">×</button>`
    + `</div></section></div></span>`;
}

function renderNode(node: XmlNode, ctx: RenderCtx): string {
  const vif = node.attrs["visible-if"];
  if (vif !== undefined && vif.startsWith("has:")) {
    // `visible-if="has:scheme"` — the capability-check special form: stripped BEFORE
    // JSE, answered by the availability plane through JSESeams.moduleAvailable (the
    // @despia-native/dom mountNode twin; natives: Stack.swift/StackNodeView.kt `env.has`, scheme
    // trimmed). SSR answers with whatever the rendering process registered — an
    // unregistered scheme renders nothing, exactly the client's remove-from-tree.
    if (!JSESeams.moduleAvailable(vif.slice(4).trim())) return "";
  } else if (vif !== undefined && !truthy(JSE.eval(vif, ctx.store.jse, ctx.item))) return "";

  if (node.tag === "head") return "";
  if (node.tag === "slot") {
    const slots = ctx.slots;
    if (slots === null) {
      if (ctx.embed === true) {
        // embed fragment: a NATIVE <slot> — the host page's light DOM projects
        // through the declarative shadow root; DSX children are the fallback
        const name = node.attrs["name"];
        const nameAttr = name !== undefined && name.length > 0 ? ` name="${escapeHtml(name)}"` : "";
        return `<slot${nameAttr}>${node.children.map((c) => renderNode(c, ctx)).join("")}</slot>`;
      }
      return "";
    }
    const name = node.attrs["name"];
    const content = name !== undefined && name.length > 0 ? slots.named.get(name) ?? [] : slots.defaults;
    return content.map((c) => renderNode(c, {
      ...slots.ctx,
      formNamespace: ctx.formNamespace ?? slots.ctx.formNamespace,
    })).join(""); // caller state scope + inherited renderer environment
  }
  if ((node.tag === "list" || node.tag === "grid") && node.attrs["bind"] !== undefined) {
    return stampHydrationId(renderList(node, ctx), node, ctx);
  }
  if (OVERLAY_TAGS.has(node.tag)) return stampHydrationId(renderOverlayNode(node, ctx), node, ctx);
  if (APPLICATION_CONTROL_TAGS.has(node.tag)) return stampHydrationId(renderApplicationControlNode(node, ctx), node, ctx);
  if (MEDIA_SURFACE_TAGS.has(node.tag)) return stampHydrationId(renderMediaSurfaceNode(node, ctx), node, ctx);
  if (node.tag === "scene") {
    // <scene> (dsx-scene.md P1): SSR emits the SIZED box only — the canvas is
    // client-only, and the scene subtree is scene-space, never DOM children (a generic
    // walk would paint dsx-unsupported divs for <box>/<sphere>). The client replaces.
    const attrs = mediaHostAttributes(node, ctx, "dsx-scene", true);
    const label = node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined
      ? ' aria-label="3D scene"' : "";
    return stampHydrationId(`<div ${attrs} role="img"${label} data-dsx-component="scene"></div>`, node, ctx);
  }
  if (node.tag === "canvas") {
    // <canvas> (parity/U04): SSR emits the SIZED, LABELLED box only. The shared display list
    // has an SVG serialisation, but painting it here would ship a first frame the client
    // immediately replaces with a raster, and the tier-1 subtree is drawing space rather than
    // DOM children (a generic walk would paint dsx-unsupported divs for <path>/<circle>). The
    // accessible name is the part that must survive to the first paint, so it does.
    const attrs = mediaHostAttributes(node, ctx, "dsx-canvas", true);
    return stampHydrationId(`<div ${attrs} data-dsx-component="canvas"></div>`, node, ctx);
  }
  if (/^[A-Z]/.test(node.tag) || node.tag.includes(".")) {
    // The web-surface primitives (WebView + the DSXWebView/DSXView surface tags) are
    // the intentionally capitalized reserved platform primitives. The DOM renderer
    // dispatches them before component lookup; SSR must do the same or a colliding
    // WebView.dsx would paint one tree and replace-mount another.
    const reservedBuiltin = RESERVED_SURFACE_TAGS.has(node.tag) && TAGS[node.tag] !== undefined;
    // Composition has the same precedence as the DOM renderer: a local/shared .dsx
    // component named Checkbox still wins, followed by a module facet; the universal
    // global is only the fallback. Facets are DOM-owned and cannot be safely executed
    // by this renderer, so leave their first paint empty instead of emitting markup
    // for the wrong built-in component before the client mounts the real facet.
    if (!reservedBuiltin && (resolveComponent(ctx.registry, ctx.scheme, node.tag) !== null ||
        ModuleRegistry.facetComponent(node.tag) !== null || TAGS[node.tag] === undefined)) {
      return renderComponentNode(node, ctx);
    }
  }

  const unsupported = TAGS[node.tag] === undefined;
  const spec = TAGS[node.tag] ?? { tag: "div", cls: "dsx-unsupported" };
  const classes: string[] = spec.cls.split(" ");
  if (node.attrs["__row"] === "1" && !classes.includes("dsx-hstack")) classes.push("dsx-hstack");
  if (node.tag === "stack" && node.attrs["flexDirection"] !== undefined
      && interp(ctx, node.attrs["flexDirection"]) === "row" && !classes.includes("dsx-hstack")) {
    classes.push("dsx-hstack");
  }
  if (node.tag === "scroll"
      && interp(ctx, node.attrs["axis"] ?? node.attrs["direction"] ?? "vertical") === "horizontal") {
    classes.push("dsx-scroll-x");
  }
  if (node.attrs["surface"] !== undefined) {
    const surface = interp(ctx, node.attrs["surface"]).trim();
    if (SURFACE_NAMES.has(surface)) classes.push(`dsx-surface-${surface}`);
  }
  if (node.tag === "ChatBubble") {
    classes.push(node.attrs["side"] === "right" ? "dsx-chat-right" : "dsx-chat-left");
  }
  if (node.tag === "Accordion" && truthy(node.attrs["open"] ?? false)) {
    classes.push("dsx-accordion-open");
  }
  if (node.tag === "Signature") {
    if (truthy(interp(ctx, node.attrs["baseline"] ?? "true"))) classes.push("dsx-signature-ruled");
    if (boundSignature(ctx, node.attrs["bind"]).length === 0) classes.push("dsx-signature-empty");
  }
  if (node.tag === "form" && booleanAttribute(interp(ctx, node.attrs["scroll"] ?? "false"))) classes.push("dsx-form-scroll");
  const clsAttr = node.attrs["class"];
  if (clsAttr !== undefined && clsAttr.length > 0) {
    for (const c of interp(ctx, clsAttr).split(/\s+/)) if (c.length > 0) classes.push(c);
  }

  const attrs: string[] = [`class="${escapeHtml(classes.join(" "))}"`];
  const css = node.attrs["__css"];
  if (css !== undefined && css.length > 0) attrs.push(`data-dsx="${escapeHtml(css)}"`);
  if (unsupported) attrs.push(`data-tag="${escapeHtml(node.tag)}"`);
  const grow = node.attrs["grow"];
  if (grow !== undefined) {
    const g = interp(ctx, grow);
    if (g === "true" || g === "width" || g === "height") attrs.push(`data-dsx-grow="${g}"`);
  }
  if (node.tag === "stack" && node.attrs["display"] !== undefined
      && interp(ctx, node.attrs["display"]) === "grid") {
    attrs.push(`data-dsx-grid="true"`);
  }
  // The DOM renderer pins a subtree's color scheme on every element family, not
  // just application controls. Stamp the same validated initial value so first
  // paint and replace-mount agree (invalid tokens deliberately fail open).
  const theme = node.attrs["theme"];
  if (theme !== undefined) {
    const value = interp(ctx, theme).trim();
    if (value === "dark" || value === "light") attrs.push(`data-dsx-theme="${value}"`);
  }
  // density= — the W9 subtree knob's SSR half: stamp the same validated initial value
  // the DOM renderer stamps (input/density.json fold), so first paint and hydration agree.
  const density = node.attrs["density"];
  if (density !== undefined) {
    const value = interp(ctx, density).trim();
    if (value === "comfortable" || value === "compact") attrs.push(`data-dsx-density="${value}"`);
  }
  // reactive styles + reactive legacy attrs — evaluated once into inline style
  const styleParts: string[] = [];
  let resolvedScaffoldAttrs: Record<string, string> | null = null;
  let initialScaffoldPlan: ReturnType<typeof resolveAdaptiveShell> | null = null;
  const reactiveStyle = node.attrs["__style_reactive"];
  if (reactiveStyle !== undefined) {
    for (const decl of reactiveStyle.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const prop = decl.substring(0, colon).trim();
      const value = interp(ctx, decl.substring(colon + 1)).trim();
      if (value.length > 0) styleParts.push(`${prop}: ${mapStyleValue(prop, value)}`);
    }
  }
  const styleListAttr = node.attrs["__style_list"];
  if (styleListAttr !== undefined) styleParts.push(...styleListDecls(ctx, styleListAttr));
  // Same reactive-context rule as renderStack's fold above: a node whose gradient modifiers
  // (or another context attribute) are reactive has NO compiled class, so every bridge attr on
  // it must fold inline here, against a RESOLVED context.
  const bridgeContext = bridgeFoldContext(ctx, node.attrs);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!BRIDGE_ATTRS.has(name)) continue;
    if (!value.includes("{{") && bridgeContext === node.attrs) continue;
    for (const [prop, v] of legacyAttrToDecls(name, interp(ctx, value).trim(), bridgeContext) ?? []) {
      styleParts.push(`${prop}: ${v}`);
    }
  }
  const tintProperty: Record<string, string> = {
    divider: "--dsx-divider-color",
    toggle: "--dsx-control-tint",
    switch: "--dsx-control-tint",
    slider: "--dsx-control-tint",
    spinner: "--dsx-spinner-color",
    activity: "--dsx-spinner-color",
    stepper: "--dsx-stepper-color",
    Checkbox: "--dsx-checkbox-color",
  };
  if (node.attrs["color"] !== undefined && tintProperty[node.tag] !== undefined) {
    styleParts.push(`${tintProperty[node.tag]}: ${componentColor(interp(ctx, node.attrs["color"]), "accent")}`);
  }
  if (SPINNER_FAMILY_TAGS.has(node.tag) && node.attrs["scale"] !== undefined) {
    styleParts.push(`--dsx-spinner-scale: ${normalizeSpinnerScale(interp(ctx, node.attrs["scale"]))}`);
  }
  if (node.tag === "flow") {
    if (node.attrs["spacing"] !== undefined) {
      styleParts.push(`--dsx-flow-spacing: ${normalizeStructuralGap(interp(ctx, node.attrs["spacing"]), 8)}px`);
    }
    if (node.attrs["lineSpacing"] !== undefined) {
      styleParts.push(`--dsx-flow-line-spacing: ${normalizeStructuralGap(interp(ctx, node.attrs["lineSpacing"]), 8)}px`);
    }
  } else if (node.tag === "toolbar") {
    if (node.attrs["spacing"] !== undefined) {
      styleParts.push(`--dsx-toolbar-spacing: ${normalizeStructuralGap(interp(ctx, node.attrs["spacing"]), 12)}px`);
    }
  } else if (node.tag === "split") {
    // width-0 (stack) grid template - the client's replan() restamps on mount
    styleParts.push(`--dsx-split-columns: minmax(0, 1fr)`);
  } else if ((node.tag === "list" || node.tag === "grid") && node.attrs["bind"] === undefined) {
    const fallback = node.tag === "grid" ? 10 : 0;
    if (node.attrs["spacing"] !== undefined) {
      styleParts.push(`--dsx-collection-spacing: ${normalizeStructuralGap(interp(ctx, node.attrs["spacing"]), fallback)}px`);
    }
    if (node.tag === "grid" && node.attrs["columns"] !== undefined) {
      const rawColumns = number(interp(ctx, node.attrs["columns"]));
      const columns = rawColumns !== null && rawColumns !== undefined && Number.isFinite(rawColumns)
        ? Math.min(Math.max(1, Math.trunc(rawColumns)), 256) : 3;
      styleParts.push(`--dsx-grid-columns: ${columns}`);
    }
  } else if (node.tag === "carousel") {
    if (node.attrs["peek"] !== undefined) {
      styleParts.push(`--dsx-carousel-peek: ${normalizeStructuralGap(interp(ctx, node.attrs["peek"]), 0)}px`);
    }
    if (node.attrs["spacing"] !== undefined) {
      styleParts.push(`--dsx-carousel-spacing: ${normalizeStructuralGap(interp(ctx, node.attrs["spacing"]), 12)}px`);
    }
  } else if (node.tag === "scaffold") {
    resolvedScaffoldAttrs = Object.fromEntries(
      Object.entries(node.attrs).map(([name, value]) => [name, interp(ctx, value)]),
    );
    const childAttr = (child: XmlNode, name: string): string | undefined => {
      const value = child.attrs[name];
      return value === undefined ? undefined : interp(ctx, value);
    };
    const unpinned = node.children.filter((child) => childAttr(child, "pin") === undefined);
    initialScaffoldPlan = resolveAdaptiveShell(resolvedScaffoldAttrs, 0, false, {
      sidebar: unpinned.some((child) => childAttr(child, "pane") === "sidebar"),
      content: unpinned.some((child) => {
        const pane = childAttr(child, "pane");
        return pane === undefined || pane === "content";
      }),
      inspector: unpinned.some((child) => childAttr(child, "pane") === "inspector"),
    });
    const plan = initialScaffoldPlan;
    styleParts.push(
      `--dsx-shell-compact-at: ${plan.compactAt}px`,
      `--dsx-sidebar-min: ${plan.sidebar.min}px`,
      `--dsx-sidebar-ideal: ${plan.sidebar.ideal}px`,
      `--dsx-sidebar-max: ${plan.sidebar.max}px`,
      `--dsx-inspector-min: ${plan.inspector.min}px`,
      `--dsx-inspector-ideal: ${plan.inspector.ideal}px`,
      `--dsx-inspector-max: ${plan.inspector.max}px`,
    );
  } else if (node.tag === "form") {
    if (node.attrs["spacing"] !== undefined) {
      const spacing = Math.max(0, number(interp(ctx, node.attrs["spacing"])) ?? 12);
      styleParts.push(`--dsx-form-spacing: ${spacing}px`);
    }
  } else if (["picker", "wheelpicker", "datepicker", "date", "combobox", "otp", "rangeslider"].includes(node.tag)) {
    if (node.attrs["color"] !== undefined) {
      styleParts.push(`--dsx-control-tint: ${componentColor(interp(ctx, node.attrs["color"]), "accent")}`);
    }
    if (node.tag === "otp") {
      if (node.attrs["boxSize"] !== undefined) {
        const rawSize = number(interp(ctx, node.attrs["boxSize"])) ?? 48;
        const boxSize = Number.isFinite(rawSize) ? Math.min(Math.max(rawSize, 24), 96) : 48;
        styleParts.push(`--dsx-otp-box-size: ${boxSize}px`);
      }
    } else if (node.tag === "rangeslider") {
      const { bounds, low, high } = nativeRangeValues(node, ctx);
      const span = bounds.degenerate ? 1 : bounds.max - bounds.min;
      styleParts.push(
        `--dsx-range-low: ${((low - bounds.min) / span) * 100}%`,
        `--dsx-range-high: ${((high - bounds.min) / span) * 100}%`,
      );
    }
  } else if (["Table", "calendar", "RadioGroup", "segmentedButton"].includes(node.tag)) {
    if (node.tag === "Table") {
      // the DOM factory's twin: the sheet turns the count into the table's
      // min-inline-size so first paint scrolls inside the frame, never crushes
      const columnCount = Math.max(
        parseDataControlCsv(interp(ctx, node.attrs["columns"] ?? ""), DATA_CONTROL_LIMITS.tableColumns).length,
        parseDataControlCsv(interp(ctx, node.attrs["fields"] ?? ""), DATA_CONTROL_LIMITS.tableColumns).length,
        1,
      );
      styleParts.push(`--dsx-table-columns: ${columnCount}`);
    }
    if (node.attrs["color"] !== undefined) {
      const property = node.tag === "Table" ? "--dsx-table-color" : "--dsx-data-tint";
      const fallback = node.tag === "Table" ? "label" : "accent";
      styleParts.push(`${property}: ${componentColor(interp(ctx, node.attrs["color"]), fallback)}`);
    }
  } else if (node.tag === "ProgressRing") {
    if (node.attrs["size"] !== undefined) {
      const size = Math.max(1, number(interp(ctx, node.attrs["size"])) ?? 88);
      styleParts.push(`--dsx-ring-size: ${size}px`);
    }
    if (node.attrs["trackColor"] !== undefined) {
      styleParts.push(`--dsx-ring-track: ${componentColor(interp(ctx, node.attrs["trackColor"]), "fill")}`);
    }
    if (node.attrs["color"] !== undefined) {
      styleParts.push(`--dsx-ring-color: ${componentColor(interp(ctx, node.attrs["color"]), "accent")}`);
    }
  } else if (node.tag === "Skeleton") {
    if (node.attrs["height"] !== undefined) {
      const height = Math.max(1, number(interp(ctx, node.attrs["height"])) ?? 14);
      styleParts.push(`--dsx-skeleton-height: ${height}px`);
    }
    if (node.attrs["radius"] !== undefined) {
      const radius = Math.max(0, number(interp(ctx, node.attrs["radius"])) ?? 8);
      styleParts.push(`--dsx-skeleton-radius: ${radius}px`);
    }
  } else if (node.tag === "ChatBubble") {
    const right = node.attrs["side"] === "right";
    if (node.attrs["color"] !== undefined) {
      const color = componentColor(interp(ctx, node.attrs["color"]), right ? "accent" : "fill");
      styleParts.push(`--dsx-chat-color: ${color}`);
    }
    if (node.attrs["maxWidth"] !== undefined) {
      const maxWidth = Math.max(1, number(interp(ctx, node.attrs["maxWidth"])) ?? 280);
      styleParts.push(`--dsx-chat-max: ${maxWidth}px`);
    }
  }
  if ((node.tag === "text" || node.tag === "label") && node.attrs["lineLimit"] !== undefined) {
    const clamp = lineClampStyle(interp(ctx, node.attrs["lineLimit"]));
    if (clamp.length > 0) styleParts.push(clamp.replace(/;\s*$/, ""));
  }
  if (styleParts.length > 0) attrs.push(`style="${escapeHtml(styleParts.join("; "))}"`);
  if (node.tag === "toolbar") {
    if (node.attrs["role"] === undefined) attrs.push(`role="toolbar"`);
    attrs.push(
      `aria-orientation="horizontal"`,
      `data-dsx-position="${interp(ctx, node.attrs["position"] ?? "bottom") === "top" ? "top" : "bottom"}"`,
    );
    if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined) {
      attrs.push(`aria-label="Toolbar"`);
    } else if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] !== undefined) {
      attrs.push(`aria-label="${escapeHtml(interp(ctx, node.attrs["aria-label"]))}"`);
    }
  }
  if (node.tag === "Signature") {
    if (node.attrs["role"] === undefined) attrs.push(`role="img"`);
    if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined) {
      const named = node.attrs["placeholder"] !== undefined
        ? interp(ctx, node.attrs["placeholder"]) : "";
      const signed = boundSignature(ctx, node.attrs["bind"]).length > 0;
      attrs.push(`aria-label="${escapeHtml(`${named.length > 0 ? named : "Signature"}, ${signed ? "signed" : "empty"}`)}"`);
    }
  }
  if (node.tag === "split") {
    if (node.attrs["role"] === undefined) attrs.push(`role="group"`);
    if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined) {
      attrs.push(`aria-label="Split view"`);
    }
    const declaredRoles = node.children.slice(0, 3).map((child) => child.attrs["paneRole"] ?? null);
    const resolvedAttrs: Record<string, string> = {};
    for (const name of [
      "panes", "collapseAt", "expandAt", "resizable",
      "sidebarMin", "sidebarIdeal", "sidebarMax",
      "contentMin", "contentIdeal", "contentMax", "detailMin",
    ]) {
      if (node.attrs[name] !== undefined) resolvedAttrs[name] = interp(ctx, node.attrs[name]!);
    }
    const plan = resolveSplit(resolvedAttrs, declaredRoles, 0);
    const active = plan.detail && node.attrs["value"] !== undefined
      && splitSelectionActive(JSE.eval(node.attrs["value"]!, ctx.store.jse, ctx.item));
    attrs.push(
      `data-dsx-presentation="${plan.presentation}"`,
      `data-dsx-panes="${plan.panes}"`,
      `data-dsx-columns="${plan.columns.join(" ")}"`,
      `data-dsx-detail-active="${String(active)}"`,
      `data-dsx-overlay="${String(plan.overlay)}"`,
      `data-dsx-overlay-open="false"`,
      `data-dsx-resizable="${String(plan.resizable)}"`,
    );
  }
  if ((node.tag === "list" || node.tag === "grid") && node.attrs["bind"] === undefined) {
    if (node.attrs["role"] === undefined) attrs.push(`role="${node.tag}"`);
    const axis = interp(ctx, node.attrs["axis"] ?? node.attrs["direction"] ?? "vertical") === "horizontal"
      ? "horizontal" : "vertical";
    const scroll = interp(ctx, node.attrs["scroll"] ?? "true").trim().toLowerCase() === "false" ? "false" : "true";
    attrs.push(`data-dsx-axis="${axis}"`, `data-dsx-scroll="${scroll}"`);
    // unset align = STRETCH (the base rule) — no stamp (wave-7 F3), matching the client mount
    if (node.attrs["align"] !== undefined) {
      const authoredAlign = interp(ctx, node.attrs["align"]);
      attrs.push(`data-dsx-align="${authoredAlign === "center" || authoredAlign === "trailing" ? authoredAlign : "leading"}"`);
    }
    if (node.tag === "grid") {
      const rawColumns = number(interp(ctx, node.attrs["columns"] ?? "3"));
      const columns = rawColumns !== null && rawColumns !== undefined && Number.isFinite(rawColumns)
        ? Math.min(Math.max(1, Math.trunc(rawColumns)), 256) : 3;
      attrs.push(`aria-colcount="${columns}"`);
    }
  }
  if (node.tag === "pager" || node.tag === "carousel") {
    if (node.attrs["role"] === undefined) attrs.push(`role="region"`);
    attrs.push(`aria-roledescription="carousel"`);
    if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined) {
      attrs.push(`aria-label="${node.tag === "carousel" ? "Carousel" : "Pager"}"`);
    } else if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] !== undefined) {
      attrs.push(`aria-label="${escapeHtml(interp(ctx, node.attrs["aria-label"]))}"`);
    }
    const axis = node.tag === "pager" && interp(ctx, node.attrs["axis"] ?? "horizontal") === "vertical"
      ? "vertical" : "horizontal";
    attrs.push(`data-dsx-axis="${axis}"`);
    if (node.tag === "carousel") {
      const peek = normalizeStructuralGap(interp(ctx, node.attrs["peek"] ?? "0"), 0);
      attrs.push(`data-dsx-peek="${peek > 0 ? "true" : "false"}"`);
    }
  }
  if (node.tag === "image") {
    // Image.swift:17 — no a11yLabel means DECORATIVE, which in the DOM is alt="".
    const label = node.attrs["a11yLabel"] === undefined ? (node.attrs["alt"] ?? "") : interp(ctx, node.attrs["a11yLabel"]);
    if (node.attrs["src"] !== undefined) {
      attrs.push(`src="${escapeHtml(interp(ctx, node.attrs["src"]))}"`, `alt="${escapeHtml(label)}"`);
    } else if (node.attrs["asset"] !== undefined) {
      const resolved = assetImageSource(interp(ctx, node.attrs["asset"]));
      if (resolved !== null) attrs.push(`src="${escapeHtml(resolved)}"`);
      else attrs.push(`data-dsx-unresolved="asset"`);
      attrs.push(`alt="${escapeHtml(label)}"`);
    } else if (label.length > 0) attrs.push(`alt="${escapeHtml(label)}"`);
  }
  if (node.tag === "form") {
    const namespace = safeStateName(interp(ctx, node.attrs["as"] ?? "form"), "form");
    attrs.push(`data-dsx-form="${escapeHtml(namespace)}"`, `novalidate`);
  }
  if (node.tag === "field") {
    const namespace = safeStateName(interp(ctx, node.attrs["form"] ?? ctx.formNamespace ?? "form"), ctx.formNamespace ?? "form");
    ensureFormNamespace(ctx, namespace);
    const name = safeStateName(interp(ctx, node.attrs["name"] ?? ""), `field_${ctx.sequences.field + 1}`);
    const kind = fieldKind(interp(ctx, node.attrs["type"] ?? "text"), booleanAttribute(interp(ctx, node.attrs["secure"] ?? "false")));
    attrs.push(`data-dsx-field-name="${escapeHtml(name)}"`, `data-dsx-field-type="${kind}"`);
    const value = ctx.store.getPath(`${namespace}.values.${name}`);
    const error = validateFormValue(value, kind, node.attrs["validate"] ?? "", node.attrs["pattern"] ?? "", node.attrs["message"] ?? "");
    attrs.push(`data-dsx-invalid="${String(error.length > 0)}"`);
  }
  if (TEXTFIELD_FAMILY_TAGS.has(node.tag)) {
    // `secure` is a structural choice in the DOM factory (not a live binding).
    const secure = node.attrs["secure"] === "true";
    const hints = applyKeyboardHintAttributes(node.attrs, secure, false);
    attrs.push(`type="${hints.type ?? (secure ? "password" : "text")}"`);
    if (hints.inputmode !== undefined) attrs.push(`inputmode="${hints.inputmode}"`);
    if (hints.autocomplete !== undefined) attrs.push(`autocomplete="${escapeHtml(hints.autocomplete)}"`);
    if (node.attrs["placeholder"] !== undefined) attrs.push(`placeholder="${escapeHtml(interp(ctx, node.attrs["placeholder"]))}"`);
    if (node.attrs["bind"] !== undefined) {
      attrs.push(`value="${escapeHtml(string(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item)))}"`);
    }
  }
  if (node.tag === "searchbar") attrs.push(`data-dsx-component="search-field"`);
  if (node.tag === "textarea") {
    const declaredMin = textAreaLineCount(interp(ctx, node.attrs["minLines"] ?? "3"), 3);
    const declaredMax = textAreaLineCount(interp(ctx, node.attrs["maxLines"] ?? "8"), 8);
    const minLines = Math.min(declaredMin, declaredMax);
    const maxLines = Math.max(declaredMin, declaredMax);
    const value = node.attrs["bind"] === undefined
      ? "" : string(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    const wanted = value.length === 0 ? minLines : value.split("\n").length;
    attrs.push(`rows="${Math.min(Math.max(wanted, minLines), maxLines)}"`);
    if (node.attrs["placeholder"] !== undefined) {
      attrs.push(`placeholder="${escapeHtml(interp(ctx, node.attrs["placeholder"]))}"`);
    }
  }
  if (node.tag === "WebView" || node.tag === "DSXWebView") {
    // DSXWebView is the composed APP surface: on web the app IS the web, so `path`
    // resolves against the page's own origin (an explicit `origin` wins) — the same
    // default the DOM factory applies (elements.ts dsxWebView).
    const raw = node.tag === "DSXWebView"
      ? (node.attrs["src"] ?? (node.attrs["origin"] !== undefined
        ? `${node.attrs["origin"]}${node.attrs["path"] ?? "/"}`
        : (node.attrs["path"] ?? "/")))
      : (node.attrs["src"] ?? "about:blank");
    const src = interp(ctx, raw);
    if (/^(https?:|about:blank$|[./])/i.test(src)) attrs.push(`src="${escapeHtml(src)}"`);
    attrs.push(`title="${escapeHtml(interp(ctx, node.attrs["a11yLabel"] ?? node.attrs["title"] ?? "Web content"))}"`);
    if (truthy(node.attrs["ephemeral"] ?? false)) {
      // The SAME token set the DOM factory applies (elements.ts webView) — SSR must
      // not be a second opinion about the ephemeral sandbox; a skew here means a
      // modal/popup/download works after hydration but not before it. `credentialless`
      // is a plain boolean content attribute: supporting engines strengthen the
      // opaque-origin boundary, others ignore it (mirrors the factory's feature check).
      attrs.push(`sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"`, "credentialless");
    }
  }
  if (node.tag === "Table") {
    const value = node.attrs["bind"] === undefined ? [] : JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item);
    const total = Array.isArray(value) ? value.length : 0;
    attrs.push(`role="region"`, `tabindex="0"`, `data-dsx-truncated="${String(total > DATA_CONTROL_LIMITS.tableRows)}"`);
    if (node.attrs["a11yLabel"] === undefined) {
      attrs.push(`aria-label="${escapeHtml(interp(ctx, node.attrs["label"] ?? "Data table"))}"`);
    }
  } else if (node.tag === "calendar") {
    const selected = node.attrs["bind"] === undefined ? null : parseCalendarDate(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    const anchor = selected ?? serverToday();
    attrs.push(`data-dsx-month="${calendarDateKey({ ...anchor, day: 1 }).slice(0, 7)}"`);
  } else if (node.tag === "RadioGroup") {
    attrs.push(`role="radiogroup"`);
    if (node.attrs["a11yLabel"] === undefined) {
      attrs.push(`aria-label="${escapeHtml(interp(ctx, node.attrs["label"] ?? "Options"))}"`);
    }
  } else if (node.tag === "segmentedButton") {
    const multiple = interp(ctx, node.attrs["multiple"] ?? "true").trim().toLowerCase() !== "false";
    attrs.push(`role="${multiple ? "group" : "radiogroup"}"`, `data-dsx-multiple="${String(multiple)}"`);
    if (node.attrs["a11yLabel"] === undefined) {
      attrs.push(`aria-label="${escapeHtml(interp(ctx, node.attrs["label"] ?? "Options"))}"`);
    }
  } else if (node.tag === "refreshable" || node.tag === "refresh") {
    const busy = node.attrs["busy"] !== undefined && truthy(JSE.eval(node.attrs["busy"], ctx.store.jse, ctx.item));
    attrs.push(`aria-busy="${String(busy)}"`, `data-dsx-refreshing="false"`, `data-dsx-armed="false"`);
  }
  if (PROGRESS_FAMILY_TAGS.has(node.tag)) {
    const maximum = progressMaximum(ctx, node.attrs["max"]);
    const current = boundNumber(ctx, node.attrs["bind"] ?? node.attrs["value"]);
    const ratio = maximum === 0 ? 0 : current / maximum;
    const fraction = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
    if (node.attrs["role"] === undefined) attrs.push(`role="progressbar"`);
    attrs.push(`aria-valuemin="0"`, `aria-valuemax="1"`, `aria-valuenow="${fraction}"`);
    const label = node.attrs["a11yLabel"] ?? node.attrs["aria-label"];
    if (label !== undefined) attrs.push(`aria-label="${escapeHtml(interp(ctx, label))}"`);
  } else if (SPINNER_FAMILY_TAGS.has(node.tag)) {
    if (node.attrs["role"] === undefined) attrs.push(`role="status"`);
    const label = node.attrs["a11yLabel"] ?? node.attrs["aria-label"];
    attrs.push(`aria-label="${escapeHtml(label === undefined ? "Loading" : interp(ctx, label))}"`);
  } else if (node.tag === "stepper") {
    const label = interp(ctx, node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? node.attrs["label"] ?? "Value").trim() || "Value";
    attrs.push(`role="group"`, `aria-label="${escapeHtml(label)}"`);
  } else if (node.tag === "ProgressRing") {
    const maximum = progressMaximum(ctx, node.attrs["max"]);
    const current = boundNumber(ctx, node.attrs["bind"] ?? node.attrs["value"]);
    const ratio = maximum === 0 ? 0 : current / maximum;
    const fraction = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
    const explicitLabel = node.attrs["a11yLabel"] ?? node.attrs["aria-label"];
    const label = explicitLabel !== undefined
      ? interp(ctx, explicitLabel)
      : node.attrs["label"] !== undefined
        ? interp(ctx, node.attrs["label"])
        : "Progress";
    if (node.attrs["a11yTrait"] === "header") {
      attrs.push(`role="heading"`, `aria-level="2"`);
    } else if (node.attrs["a11yGroup"] === "true" || node.attrs["role"] === "group") {
      attrs.push(`role="group"`);
    } else if (node.attrs["role"] !== undefined) {
      const role = interp(ctx, node.attrs["role"]).trim();
      if (role.length > 0) attrs.push(`role="${escapeHtml(role)}"`);
    } else {
      attrs.push(`role="progressbar"`);
    }
    attrs.push(
      `aria-valuemin="0"`,
      `aria-valuemax="1"`,
      `aria-valuenow="${fraction}"`,
      `aria-label="${escapeHtml(label)}"`,
    );
  } else if (node.tag === "Skeleton") {
    attrs.push(`aria-hidden="true"`);
  } else if (node.attrs["a11yLabel"] !== undefined) {
    attrs.push(`aria-label="${escapeHtml(interp(ctx, node.attrs["a11yLabel"]))}"`);
  }
  const authoredPressed = node.attrs["a11yPressed"] ?? node.attrs["aria-pressed"];
  if (authoredPressed !== undefined) {
    const value = interp(ctx, authoredPressed).trim().toLowerCase();
    if (value === "true" || value === "1") attrs.push('aria-pressed="true"');
    else if (value === "false" || value === "0") attrs.push('aria-pressed="false"');
    else if (value === "mixed") attrs.push('aria-pressed="mixed"');
  }
  // the system-space button words (system-defaults.md) — the SSR twin of elements.ts:
  // variant stamps verbatim; role stamps ONLY the button-role words (data-dsx-role,
  // never the DOM ARIA `role` attribute)
  if (BUTTON_FAMILY_TAGS.has(node.tag)) {
    const variant = node.attrs["variant"];
    if (variant !== undefined) {
      const v = interp(ctx, variant).trim();
      if (v.length > 0) attrs.push(`data-dsx-variant="${escapeHtml(v)}"`);
    }
    const roleWord = node.attrs["role"];
    if (roleWord !== undefined) {
      const r = interp(ctx, roleWord).trim();
      if (BUTTON_ROLES.has(r)) attrs.push(`data-dsx-role="${r}"`);
    }
  }
  // ACCESSIBILITY role= — the SSR twin of mount.ts's guarded pass-through, so server
  // markup and hydrated DOM agree: interpolation resolved first, then the button role
  // WORDS on a button-family control suppress (they are the data-dsx-role skin above,
  // never a DOM ARIA role — the client removes them the same way); a11yTrait="header"
  // defers to the client's heading stamp. Every other resolved value emits verbatim.
  const roleAttr = node.attrs["role"];
  if (roleAttr !== undefined && node.attrs["a11yTrait"] !== "header" && node.tag !== "ProgressRing") {
    const r = interp(ctx, roleAttr).trim();
    const buttonFamily = BUTTON_FAMILY_TAGS.has(node.tag);
    if (r.length > 0 && !(buttonFamily && BUTTON_ROLES.has(r))) attrs.push(`role="${escapeHtml(r)}"`);
  }
  // `href=` (the /web/04 link contract): a button-family control server-renders as a REAL
  // anchor — the crawlable link graph is exactly why links must exist at SSR time.
  const href = node.attrs["href"];
  const tag = href !== undefined && spec.tag === "button" ? "a" : spec.tag;
  const disabled = BUTTON_FAMILY_TAGS.has(node.tag) && nativeControlDisabled(node, ctx);
  if (tag === "button") attrs.push(`type="button"`, ...(disabled ? ["disabled"] : []));
  if (tag === "a" && href !== undefined) {
    attrs.push(`href="${escapeHtml(interp(ctx, href))}"`, ...(disabled ? ['aria-disabled="true"', 'tabindex="-1"'] : []));
  }

  let inner = "";
  let appendChildren = true;
  if (node.tag === "Table") {
    const columns = parseDataControlCsv(interp(ctx, node.attrs["columns"] ?? ""), DATA_CONTROL_LIMITS.tableColumns);
    const authoredFields = parseDataControlCsv(interp(ctx, node.attrs["fields"] ?? ""), DATA_CONTROL_LIMITS.tableColumns);
    const fields = authoredFields.length > 0 ? authoredFields : columns.map((column) => column.toLowerCase());
    const source = node.attrs["bind"] === undefined ? [] : JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item);
    const rows = Array.isArray(source) ? source.slice(0, DATA_CONTROL_LIMITS.tableRows) : [];
    const header = columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("");
    const body = rows.map((raw) => {
      const row: Dict = isDict(raw) ? raw as Dict : { value: raw };
      const values = fields.map((field) => dataText(row[field]));
      return `<tr aria-label="${escapeHtml(values.join(", "))}">${values.map((value) => `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`).join("")}</tr>`;
    }).join("");
    inner = `<table class="dsx-table" aria-rowcount="${rows.length + (columns.length > 0 ? 1 : 0)}" aria-colcount="${Math.max(columns.length, fields.length)}">`
      + `<thead${columns.length === 0 ? " hidden" : ""}><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
    appendChildren = false;
  } else if (node.tag === "calendar") {
    const locale = normalizeCalendarLocale("en");
    const selected = node.attrs["bind"] === undefined ? null : parseCalendarDate(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    const anchor = selected ?? serverToday();
    const min = node.attrs["min"] === undefined ? null : parseCalendarDate(interp(ctx, node.attrs["min"]));
    const max = node.attrs["max"] === undefined ? null : parseCalendarDate(interp(ctx, node.attrs["max"]));
    const disabledAll = nativeControlDisabled(node, ctx);
    const firstWeekday = calendarFirstWeekday(locale);
    const month = calendarMonthGrid(anchor.year, anchor.month, firstWeekday);
    const monthDate = serverCalendarDate({ year: anchor.year, month: anchor.month, day: 1 });
    const monthName = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(monthDate);
    const markDateField = node.attrs["markDateField"] ?? "date";
    const markColorField = node.attrs["markColorField"] ?? "color";
    const markSource = node.attrs["marks"] === undefined ? [] : JSE.eval(node.attrs["marks"], ctx.store.jse, ctx.item);
    const marks = new Map<string, string>();
    if (Array.isArray(markSource)) {
      for (const raw of markSource.slice(0, DATA_CONTROL_LIMITS.marks)) {
        if (!isDict(raw)) continue;
        const date = parseCalendarDate((raw as Dict)[markDateField]);
        if (date === null) continue;
        const color = dataText((raw as Dict)[markColorField]);
        marks.set(calendarDateKey(date), componentColor(color, "accent"));
      }
    }
    const weekdays = Array.from({ length: 7 }, (_, index) => {
      const weekday = (firstWeekday + index) % 7;
      const date = new Date(2024, 0, 7 + weekday, 12);
      const full = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
      const narrow = new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(date);
      return `<span class="dsx-calendar-weekday" role="columnheader" aria-label="${escapeHtml(full)}">${escapeHtml(narrow)}</span>`;
    }).join("");
    const blanks = Array.from({ length: month.leading }, () =>
      `<span class="dsx-calendar-cell dsx-calendar-blank" role="gridcell" aria-hidden="true"></span>`).join("");
    const today = serverToday();
    const days = Array.from({ length: month.days }, (_, index) => {
      const date: CalendarDate = { year: anchor.year, month: anchor.month, day: index + 1 };
      const key = calendarDateKey(date);
      const active = selected !== null && compareCalendarDate(selected, date) === 0;
      const isToday = compareCalendarDate(today, date) === 0;
      const disabled = disabledAll || (min !== null && compareCalendarDate(date, min) < 0)
        || (max !== null && compareCalendarDate(date, max) > 0);
      const label = new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(serverCalendarDate(date));
      const mark = marks.get(key);
      return `<span class="dsx-calendar-cell" role="gridcell" aria-selected="${String(active)}">`
        + `<button class="dsx-calendar-day" type="button" data-dsx-date="${key}" data-dsx-intrinsic-disabled="${String(disabled)}"`
        + ` data-dsx-selected="${String(active)}" data-dsx-today="${String(isToday)}" aria-label="${escapeHtml(label)}"`
        + ` aria-pressed="${String(active)}" tabindex="${active || (selected === null && index === 0) ? 0 : -1}"${disabled ? " disabled" : ""}>`
        + `<span class="dsx-calendar-day-number">${index + 1}</span>`
        + `${mark === undefined ? "" : `<span class="dsx-calendar-mark" aria-hidden="true" style="--dsx-calendar-mark: ${escapeHtml(mark)}"></span>`}`
        + `</button></span>`;
    }).join("");
    inner = `<div class="dsx-calendar-header"><button class="dsx-calendar-page dsx-calendar-previous" type="button" aria-label="Previous month"${disabledAll ? " disabled" : ""}>‹</button>`
      + `<h2 class="dsx-calendar-title" aria-live="polite">${escapeHtml(monthName)}</h2>`
      + `<button class="dsx-calendar-page dsx-calendar-next" type="button" aria-label="Next month"${disabledAll ? " disabled" : ""}>›</button></div>`
      + `<div class="dsx-calendar-weekdays" role="row">${weekdays}</div>`
      + `<div class="dsx-calendar-grid" role="grid" aria-label="${escapeHtml(monthName)}">${blanks}${days}</div>`;
    appendChildren = false;
  } else if (node.tag === "RadioGroup") {
    const options = dataControlOptions(node, ctx);
    const selected = node.attrs["bind"] === undefined ? "" : dataText(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    const disabled = nativeControlDisabled(node, ctx);
    const name = `dsx-radio-ssr-${++ctx.sequences.native}`;
    inner = options.map((option) => `<label class="dsx-radio-option"><input class="dsx-radio-input" type="radio" name="${name}" value="${escapeHtml(option.value)}"`
      + `${option.value === selected ? " checked" : ""}${disabled ? " disabled" : ""}>`
      + `<span class="dsx-radio-mark" aria-hidden="true"></span><span class="dsx-radio-label">${escapeHtml(option.label)}</span></label>`).join("");
    attrs.push(`data-dsx-disabled="${String(disabled)}"`);
    appendChildren = false;
  } else if (node.tag === "segmentedButton") {
    const ids = parseDataControlCsv(interp(ctx, node.attrs["options"] ?? ""));
    const icons = parseDataControlCsv(interp(ctx, node.attrs["icons"] ?? ""));
    const selected = normalizeSegmentedSelection(
      node.attrs["bind"] === undefined ? "" : JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item), ids,
    );
    const multiple = interp(ctx, node.attrs["multiple"] ?? "true").trim().toLowerCase() !== "false";
    const disabled = nativeControlDisabled(node, ctx);
    inner = ids.map((id, index) => {
      const active = selected.includes(id);
      const icon = icons[index];
      return `<button class="dsx-segmented-button-item" type="button" data-dsx-selected="${String(active)}"`
        + `${multiple ? ` aria-pressed="${String(active)}"` : ` role="radio" aria-checked="${String(active)}" tabindex="${active || (selected.length === 0 && index === 0) ? 0 : -1}"`}`
        + `${disabled ? " disabled" : ""}>${icon === undefined ? "" : `<span class="dsx-segmented-button-icon" aria-hidden="true" data-dsx-icon="${escapeHtml(icon)}"></span>`}`
        + `<span class="dsx-segmented-button-label">${escapeHtml(id)}</span></button>`;
    }).join("");
    attrs.push(`data-dsx-disabled="${String(disabled)}"`);
    appendChildren = false;
  } else if (node.tag === "refreshable" || node.tag === "refresh") {
    const label = interp(ctx, node.attrs["a11yLabel"] ?? "Refresh");
    const viewportLabel = node.attrs["a11yLabel"] !== undefined
      ? `${interp(ctx, node.attrs["a11yLabel"])} content` : "Refreshable content";
    inner = `<div class="dsx-refresh-affordance"><button class="dsx-refresh-button" type="button" aria-label="${escapeHtml(label)}"><span class="dsx-refresh-symbol" aria-hidden="true">↻</span></button>`
      + `<span class="dsx-refresh-status" role="status" aria-live="polite"></span></div>`
      + `<div class="dsx-refresh-viewport" role="region" aria-label="${escapeHtml(viewportLabel)}" tabindex="0">${node.children.map((child) => renderNode(child, ctx)).join("")}</div>`;
    appendChildren = false;
  } else if (node.tag === "flow" || node.tag === "toolbar") {
    inner = node.children.slice(0, STRUCTURAL_CHILD_LIMIT).map((child) => renderNode(child, ctx)).join("");
    appendChildren = false;
  } else if ((node.tag === "list" || node.tag === "grid") && node.attrs["bind"] === undefined) {
    const children = node.children.slice(0, STRUCTURAL_CHILD_LIMIT);
    if (node.tag === "list") {
      inner = children.map((child) =>
        `<div class="dsx-row dsx-collection-row" role="listitem">${renderNode(child, ctx)}</div>`,
      ).join("");
    } else {
      const rawColumns = number(interp(ctx, node.attrs["columns"] ?? "3"));
      const columns = rawColumns !== null && rawColumns !== undefined && Number.isFinite(rawColumns)
        ? Math.min(Math.max(1, Math.trunc(rawColumns)), 256) : 3;
      const groups: string[] = [];
      for (let start = 0; start < children.length; start += columns) {
        const cells = children.slice(start, start + columns).map((child, offset) =>
          `<div class="dsx-row dsx-collection-row" role="gridcell" aria-colindex="${offset + 1}">${renderNode(child, ctx)}</div>`,
        ).join("");
        groups.push(`<div class="dsx-grid-aria-row" role="row" aria-rowindex="${Math.floor(start / columns) + 1}">${cells}</div>`);
      }
      attrs.push(`aria-rowcount="${Math.ceil(children.length / columns)}"`);
      inner = groups.join("");
    }
    appendChildren = false;
  } else if (node.tag === "tabs" || node.tag === "tabview") {
    const sequence = ++ctx.sequences.structural;
    const children = node.children.slice(0, STRUCTURAL_CHILD_LIMIT);
    const selected = normalizeStructuralIndex(boundNumber(ctx, node.attrs["value"]), children.length);
    const panels: string[] = [];
    const buttons: string[] = [];
    children.forEach((child, index) => {
      const active = index === selected;
      const tabId = `dsx-tab-${sequence}-${index}`;
      const panelId = `dsx-tab-panel-${sequence}-${index}`;
      const label = interp(ctx, child.attrs["tabTitle"] ?? `Tab ${index + 1}`) || `Tab ${index + 1}`;
      const iconValue = child.attrs["tabIcon"] === undefined ? "" : interp(ctx, child.attrs["tabIcon"]).trim();
      const icon = iconValue.length === 0 ? "" : `<span class="dsx-tab-icon" aria-hidden="true" data-dsx-icon="${escapeHtml(iconValue)}"></span>`;
      const badgeValue = child.attrs["tabBadge"] === undefined ? "" : interp(ctx, child.attrs["tabBadge"]);
      const badge = badgeValue.length === 0 ? "" : `<span class="dsx-tab-badge" aria-label="Notifications">${escapeHtml(badgeValue)}</span>`;
      buttons.push(
        `<button class="dsx-tab" type="button" id="${tabId}" role="tab" aria-controls="${panelId}"`
        + ` aria-selected="${String(active)}" data-dsx-selected="${String(active)}" tabindex="${active ? 0 : -1}">`
        + `${icon}<span class="dsx-tab-label">${escapeHtml(label)}</span>${badge}</button>`,
      );
      panels.push(
        `<div class="dsx-tab-panel" id="${panelId}" role="tabpanel" aria-labelledby="${tabId}"`
        + `${active ? "" : ' hidden inert aria-hidden="true"'}>${renderNode(child, ctx)}</div>`,
      );
    });
    const tabLabel = interp(ctx, node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? "Tabs");
    inner = `<div class="dsx-tab-panels">${panels.join("")}</div>`
      + `<div class="dsx-tablist" role="tablist" aria-label="${escapeHtml(tabLabel)}">${buttons.join("")}</div>`;
    appendChildren = false;
  } else if (node.tag === "pager" || node.tag === "carousel") {
    const pageBodies: string[] = [];
    let pageTotal = node.children.length;
    if (node.tag === "pager" && node.attrs["bind"] !== undefined) {
      const value = JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item);
      pageTotal = Array.isArray(value) ? value.length : 0;
      const data = Array.isArray(value) ? value.slice(0, BOUND_COLLECTION_LIMIT) : [];
      data.forEach((raw, index) => {
        const rowCtx: RenderCtx = { ...ctx, item: renderCollectionItem(ctx.item, raw, index) };
        pageBodies.push(node.children.map((child) => renderNode(child, rowCtx)).join(""));
      });
    } else {
      pageBodies.push(...node.children.slice(0, STRUCTURAL_CHILD_LIMIT).map((child) => renderNode(child, ctx)));
    }
    const selected = normalizeStructuralIndex(boundNumber(ctx, node.attrs["value"]), pageBodies.length);
    attrs.push(`data-dsx-page="${selected}"`);
    if (node.tag === "pager" && node.attrs["bind"] !== undefined) {
      attrs.push(
        `data-dsx-total-count="${pageTotal}"`,
        `data-dsx-rendered-count="${pageBodies.length}"`,
        `data-dsx-truncated="${String(pageTotal > BOUND_COLLECTION_LIMIT)}"`,
      );
    }
    const pages = pageBodies.map((body, index) => {
      const active = index === selected;
      return `<div class="dsx-paged-page" role="group" aria-roledescription="slide"`
        + ` aria-label="${index + 1} of ${pageBodies.length}"${active ? "" : ' inert aria-hidden="true"'}>`
        + `${body}</div>`;
    }).join("");
    const dotButtons = pageBodies.map((_, index) => {
      const active = index === selected;
      return `<button class="dsx-paged-dot" type="button" aria-label="Go to slide ${index + 1}"`
        + ` aria-current="${String(active)}" data-dsx-selected="${String(active)}"></button>`;
    }).join("");
    const hideDots = interp(ctx, node.attrs["dots"] ?? "true").trim().toLowerCase() === "false";
    inner = `<div class="dsx-paged-viewport" dir="ltr" tabindex="0" aria-live="off"><div class="dsx-paged-track">${pages}</div></div>`
      + `<div class="dsx-paged-dots" dir="ltr" role="group" aria-label="Choose slide"${hideDots ? " hidden" : ""}>${dotButtons}</div>`;
    appendChildren = false;
  } else if (node.tag === "split") {
    // The SSR twin plans at width 0 (mobile-first stack), exactly like the client
    // factory before its ResizeObserver reports the real container box; the client
    // re-stamps on mount. Same DOM, same attributes, same canonical pane order.
    const children = node.children.slice(0, 3);
    const declaredRoles = children.map((child) => child.attrs["paneRole"] ?? null);
    const resolvedAttrs: Record<string, string> = {};
    for (const name of [
      "panes", "collapseAt", "expandAt", "resizable",
      "sidebarMin", "sidebarIdeal", "sidebarMax",
      "contentMin", "contentIdeal", "contentMax", "detailMin",
    ]) {
      if (node.attrs[name] !== undefined) resolvedAttrs[name] = interp(ctx, node.attrs[name]!);
    }
    const plan = resolveSplit(resolvedAttrs, declaredRoles, 0);
    const active = plan.detail && node.attrs["value"] !== undefined
      && splitSelectionActive(JSE.eval(node.attrs["value"]!, ctx.store.jse, ctx.item));
    const paneLabels: Record<SplitRole, string> = { sidebar: "Sidebar", content: "Content", detail: "Detail" };
    const orderedRoles = SPLIT_ROLE_ORDER.filter((role) => plan.roles.includes(role));
    // the toggle yields while a pushed detail covers the host (the client reflect() twin)
    const toggleHtml = plan.roles.includes("sidebar") && plan.roles.length === 3
      ? `<button class="dsx-split-toggle" type="button" aria-label="Show sidebar" aria-expanded="false"`
        + `${plan.overlay && !active ? "" : " hidden"}><svg viewBox="0 0 24 24" width="20" height="20" fill="none"`
        + ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`
        + ` aria-hidden="true"><path d="${SPLIT_TOGGLE_PATH}"></path></svg></button>`
      : "";
    const toggleShown = toggleHtml.length > 0 && plan.overlay && !active;
    const panes = orderedRoles.map((role, position) => {
      const visible = (role === "detail" && active) || role === plan.host;
      const chrome = toggleShown && role === plan.host ? ` data-dsx-chrome="true"` : "";
      const backHtml = role === "detail" && plan.roles.length >= 2
        ? `<button class="dsx-split-back" type="button" aria-label="Back"${plan.detail ? "" : " hidden"}>`
          + `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"`
          + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>`
          + `<span class="dsx-split-back-label">Back</span></button>`
        : "";
      const divider = position === 0 ? "" :
        `<div class="dsx-split-divider" role="separator" aria-orientation="vertical"`
        + ` aria-label="Resize ${paneLabels[orderedRoles[position - 1]!].toLowerCase()}"`
        + ` data-dsx-controls="${orderedRoles[position - 1]}" hidden></div>`;
      const body = renderNode(children[plan.roles.indexOf(role)]!, ctx);
      return `${divider}<div class="dsx-split-pane" role="group" data-dsx-pane="${role}"`
        + ` aria-label="${paneLabels[role]}" data-dsx-visible="${String(visible)}"${chrome}`
        + `${visible ? "" : ` inert aria-hidden="true"`}>${backHtml}${body}</div>`;
    }).join("");
    inner = `${toggleHtml}<div class="dsx-split-scrim" aria-hidden="true" hidden></div>${panes}`;
    appendChildren = false;
  } else if (node.tag === "scaffold") {
    const childAttr = (child: XmlNode, name: string): string | undefined => {
      const value = child.attrs[name];
      return value === undefined ? undefined : interp(ctx, value);
    };
    const top = node.children.filter((child) => childAttr(child, "pin") === "top");
    const bottom = node.children.filter((child) => childAttr(child, "pin") === "bottom");
    const unpinned = node.children.filter((child) => childAttr(child, "pin") === undefined);
    const sidebar = unpinned.filter((child) => childAttr(child, "pane") === "sidebar");
    const inspector = unpinned.filter((child) => childAttr(child, "pane") === "inspector");
    const content = unpinned.filter((child) => {
      const pane = childAttr(child, "pane");
      return pane === undefined || pane === "content";
    });
    const scaffoldAttrs = resolvedScaffoldAttrs ?? {};
    const plan = initialScaffoldPlan ?? resolveAdaptiveShell(scaffoldAttrs, 0, false, {
      sidebar: sidebar.length > 0, content: content.length > 0, inspector: inspector.length > 0,
    });
    const render = (nodes: readonly XmlNode[]): string => nodes.map((child) => renderNode(child, ctx)).join("");
    const topHtml = top.length === 0 ? "" : `<header class="dsx-scaffold-pin dsx-scaffold-pin-top">${render(top)}</header>`;
    const bottomHtml = bottom.length === 0 ? "" : `<footer class="dsx-scaffold-pin dsx-scaffold-pin-bottom">${render(bottom)}</footer>`;
    const adaptive = plan.mode !== "custom" && sidebar.length > 0 && content.length > 0;
    const shell = adaptive
      ? `<div class="dsx-scaffold-shell" data-dsx-layout="${plan.layout}" data-dsx-mode="${plan.mode}" data-dsx-collapse="${plan.collapse}">`
        + `<div class="dsx-scaffold-custom"></div>`
        + `<nav class="dsx-scaffold-pane dsx-scaffold-sidebar" aria-label="${escapeHtml(scaffoldAttrs["sidebarLabel"] ?? "Sidebar")}">${render(sidebar)}</nav>`
        + `<main class="dsx-scaffold-pane dsx-scaffold-content" aria-label="${escapeHtml(scaffoldAttrs["contentLabel"] ?? "Content")}">${render(content)}</main>`
        + `<aside class="dsx-scaffold-pane dsx-scaffold-inspector" aria-label="${escapeHtml(scaffoldAttrs["inspectorLabel"] ?? "Inspector")}">${render(inspector)}</aside></div>`
      : `<div class="dsx-scaffold-shell" data-dsx-layout="custom" data-dsx-mode="custom" data-dsx-collapse="${plan.collapse}">`
        + `<div class="dsx-scaffold-custom">${render(unpinned)}</div>`
        + `<nav class="dsx-scaffold-pane dsx-scaffold-sidebar"></nav><main class="dsx-scaffold-pane dsx-scaffold-content"></main><aside class="dsx-scaffold-pane dsx-scaffold-inspector"></aside></div>`;
    inner = topHtml + shell + bottomHtml;
    appendChildren = false;
  } else if (node.tag === "form") {
    const namespace = safeStateName(interp(ctx, node.attrs["as"] ?? "form"), "form");
    ensureFormNamespace(ctx, namespace);
    const childCtx: RenderCtx = { ...ctx, formNamespace: namespace };
    inner = node.children.map((child) => renderNode(child, childCtx)).join("");
    const valid = truthy(ctx.store.getPath(`${namespace}.valid`));
    attrs.push(`data-dsx-valid="${String(valid)}"`);
    if (node.attrs["submit"] !== undefined) {
      inner += `<button type="submit" class="dsx-button dsx-form-submit" data-dsx-valid="${String(valid)}">${escapeHtml(interp(ctx, node.attrs["submit"]))}</button>`;
    }
    appendChildren = false;
  } else if (node.tag === "field") {
    const sequence = ++ctx.sequences.field;
    const namespace = safeStateName(interp(ctx, node.attrs["form"] ?? ctx.formNamespace ?? "form"), ctx.formNamespace ?? "form");
    ensureFormNamespace(ctx, namespace);
    const name = safeStateName(interp(ctx, node.attrs["name"] ?? ""), `field_${sequence}`);
    const kind = fieldKind(interp(ctx, node.attrs["type"] ?? "text"), booleanAttribute(interp(ctx, node.attrs["secure"] ?? "false")));
    const valuePath = `${namespace}.values.${name}`;
    const value = ctx.store.getPath(valuePath);
    const validation = node.attrs["validate"] ?? "";
    const required = validation.split(",").some((rule) => rule.trim() === "required");
    const error = validateFormValue(value, kind, validation, node.attrs["pattern"] ?? "", node.attrs["message"] ?? "");
    const fieldsValue = ctx.store.getPath(`${namespace}.fields`);
    const fields: Dict = isDict(fieldsValue) ? { ...(fieldsValue as Dict) } : {};
    const prior = isDict(fields[name]) ? fields[name] as Dict : {};
    fields[name] = { ...prior, touched: truthy(prior["touched"]), dirty: truthy(prior["dirty"]), error };
    const orderValue = ctx.store.getPath(`${namespace}.fieldOrder`);
    const order = Array.isArray(orderValue) ? orderValue.map(string) : [];
    if (!order.includes(name)) order.push(name);
    ctx.store.batch(() => {
      ctx.store.setPath(`${namespace}.fields`, fields);
      ctx.store.setPath(`${namespace}.fieldOrder`, order);
      ctx.store.setPath(`${namespace}.valid`, order.length > 0 && order.every((fieldName) => {
        const meta = fields[fieldName];
        return isDict(meta) && string((meta as Dict)["error"]).length === 0;
      }));
    });

    const id = `dsx-ssr-field-${sequence}`;
    const errorId = `${id}-error`;
    const label = interp(ctx, node.attrs["label"] ?? "");
    const placeholder = interp(ctx, node.attrs["placeholder"] ?? (kind === "picker" ? "Select" : ""));
    const touched = truthy(prior["touched"]);
    const submitted = truthy(ctx.store.getPath(`${namespace}.submitted`));
    const visibleError = error.length > 0 && (touched || submitted);
    const common = `id="${id}" name="${escapeHtml(name)}" aria-describedby="${errorId}" aria-invalid="${String(error.length > 0)}"${visibleError ? ` aria-errormessage="${errorId}"` : ""}${required ? " required" : ""}${label.length === 0 ? ` aria-label="${escapeHtml(placeholder || name)}"` : ""}`;
    let control = "";
    if (kind === "picker") {
      const rawOptions = node.attrs["optionsKey"] !== undefined
        ? JSE.eval(node.attrs["optionsKey"], ctx.store.jse, ctx.item)
        : (node.attrs["options"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
      const options = normalizeFormOptions(rawOptions, node.attrs["valueField"] ?? "id", node.attrs["labelField"] ?? "label");
      const current = string(value);
      const placeholderOption = placeholder.length === 0 ? "" : `<option value=""${required ? " disabled" : ""}${current.length === 0 ? " selected" : ""}>${escapeHtml(placeholder)}</option>`;
      const optionMarkup = options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === current ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
      control = `<select class="dsx-field-control dsx-field-select" ${common}>${placeholderOption}${optionMarkup}</select>`;
    } else if (kind === "toggle") {
      control = `<input class="dsx-field-toggle-input" type="checkbox" role="switch" ${common}${truthy(value) ? " checked" : ""}>`;
    } else if (kind === "text" && booleanAttribute(interp(ctx, node.attrs["multiline"] ?? "false"))) {
      // the client factory's textarea twin (wave-7 F5): same well class, rows=3 floor
      control = `<textarea class="dsx-field-control dsx-field-multiline" rows="3" ${common}${placeholder.length > 0 ? ` placeholder="${escapeHtml(placeholder)}"` : ""}>${escapeHtml(normalizeFormInput(string(value)))}</textarea>`;
    } else {
      const inputType = kind === "phone" ? "tel" : kind === "secure" ? "password" : kind;
      const autocomplete = kind === "email" ? "email" : kind === "secure" ? "current-password" : kind === "phone" ? "tel" : "";
      control = `<input class="dsx-field-control" type="${inputType}" ${common} value="${escapeHtml(normalizeFormInput(string(value)))}"${placeholder.length > 0 ? ` placeholder="${escapeHtml(placeholder)}"` : ""}${autocomplete.length > 0 ? ` autocomplete="${autocomplete}"` : ""}>`;
    }
    const labelMarkup = kind === "toggle"
      ? `<label class="dsx-field-toggle-label" for="${id}"><span class="dsx-field-label-copy">${escapeHtml(label)}</span>${control}</label>`
      : `${label.length > 0 ? `<label class="dsx-field-label" for="${id}"><span class="dsx-field-label-copy">${escapeHtml(label)}</span></label>` : ""}${control}`;
    inner = labelMarkup + `<span id="${errorId}" class="dsx-field-error" role="alert" aria-live="polite"${visibleError ? "" : " hidden"}>${escapeHtml(error)}</span>`;
    appendChildren = false;
  } else if (node.tag === "text" || node.tag === "label") {
    const bind = node.attrs["bind"];
    const value = node.attrs["value"];
    let source: string | null = null;
    if (bind !== undefined) source = string(JSE.eval(bind, ctx.store.jse, ctx.item));
    else if (value !== undefined) source = interp(ctx, value);
    else if (node.text.trim().length > 0) source = interp(ctx, node.text.trim());
    if (source !== null) {
      // `markdown="true"` runs the SAME parser the DOM twin runs (markdown.ts), so the
      // server paints the inline emphasis/code/link vocabulary and the adopt walk sees
      // identical DOM instead of a text-only first paint.
      const markdown = node.attrs["markdown"] !== undefined
        && booleanAttribute(interp(ctx, node.attrs["markdown"]));
      inner = markdown ? markdownHtml(source) : escapeHtml(source);
      appendChildren = false;
    }
  } else if (node.tag === "markdown") {
    // The BLOCK vocabulary (A4), server-painted with the same emitter the corpus pins —
    // without this branch a docs page SSR'd an empty div and the content arrived only when
    // the client mounted, which is the opposite of what a documentation site renders for.
    // Same source precedence as the DOM factory: bind > value > inner text.
    const bind = node.attrs["bind"];
    const value = node.attrs["value"];
    let source: string | null = null;
    if (bind !== undefined) source = string(JSE.eval(bind, ctx.store.jse, ctx.item));
    else if (value !== undefined) source = interp(ctx, value);
    else if (node.text.trim().length > 0) source = interp(ctx, node.text.trim());
    if (source !== null) {
      inner = markdownBlocksHtml(source);
      appendChildren = false;
    }
  } else if (node.tag === "textarea") {
    // A <textarea>'s value IS its content — without this the bound text never painted
    // server-side and the first paint was an empty box until the client mounted.
    inner = node.attrs["bind"] === undefined
      ? "" : escapeHtml(string(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item)));
    appendChildren = false;
  } else if (node.tag === "searchbar") {
    // the composite anatomy: leading glass · the real input · the clear button
    const value = node.attrs["bind"] === undefined
      ? "" : string(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    const secure = node.attrs["secure"] === "true";
    const hints = applyKeyboardHintAttributes(node.attrs, secure, true);
    const placeholder = interp(ctx, node.attrs["placeholder"] ?? "Search");
    inner = `<span class="dsx-searchbar-icon" aria-hidden="true" data-dsx-part="icon">${searchGlyph(SEARCHBAR_GLYPHS.glass)}</span>`
      + `<input class="dsx-textfield dsx-searchbar" type="${hints.type ?? "search"}"`
      + ` data-dsx-component="search-input" data-dsx-part="control"`
      + `${hints.inputmode === undefined ? "" : ` inputmode="${hints.inputmode}"`}`
      + `${hints.autocomplete === undefined ? "" : ` autocomplete="${escapeHtml(hints.autocomplete)}"`}`
      + ` placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">`
      + `<button class="dsx-searchbar-clear" type="button" data-dsx-part="clear" aria-label="Clear search"`
      + `${value.length === 0 ? " hidden" : ""}>${searchGlyph(SEARCHBAR_GLYPHS.clear)}</button>`;
    appendChildren = false;
  } else if (TOGGLE_FAMILY_TAGS.has(node.tag)) {
    const checked = node.attrs["bind"] !== undefined
      && truthy(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    inner = `<input type="checkbox" role="switch"${checked ? " checked" : ""}>`
      + `<span class="dsx-toggle-track" aria-hidden="true"><span class="dsx-toggle-thumb"></span></span>`;
    appendChildren = false;
  } else if (PROGRESS_FAMILY_TAGS.has(node.tag)) {
    const maximum = progressMaximum(ctx, node.attrs["max"]);
    const current = boundNumber(ctx, node.attrs["bind"] ?? node.attrs["value"]);
    const ratio = maximum === 0 ? 0 : current / maximum;
    const fraction = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
    inner = `<div class="dsx-progress-fill" aria-hidden="true" style="width: ${fraction * 100}%"></div>`;
    appendChildren = false;
  } else if (SPINNER_FAMILY_TAGS.has(node.tag)) {
    appendChildren = false;
  } else if (node.tag === "stepper") {
    const value = boundNumber(ctx, node.attrs["bind"]);
    const label = interp(ctx, node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? node.attrs["label"] ?? "Value").trim() || "Value";
    const caption = node.attrs["label"] === undefined ? "" : interp(ctx, node.attrs["label"]);
    inner = (node.attrs["label"] === undefined ? ""
      : `<span class="dsx-stepper-label" data-dsx-part="label"${caption.trim().length === 0 ? " hidden" : ""}>${escapeHtml(caption)}</span>`)
      + `<button class="dsx-stepper-btn" type="button" aria-label="${escapeHtml(`Decrease ${label}`)}">−</button>`
      + `<span class="dsx-stepper-value" aria-live="polite" aria-atomic="true">${value}</span>`
      + `<button class="dsx-stepper-btn" type="button" aria-label="${escapeHtml(`Increase ${label}`)}">+</button>`;
    appendChildren = false;
  } else if (BUTTON_FAMILY_TAGS.has(node.tag)) {
    const label = node.attrs["label"];
    if (label !== undefined) inner = `<span>${escapeHtml(interp(ctx, label))}</span>`;
  } else if (node.tag === "picker" || node.tag === "wheelpicker") {
    const options = nativeControlOptions(node, ctx);
    const selected = node.attrs["bind"] === undefined
      ? ""
      : string(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    const optionHtml = options.map((option) => {
      const on = option.value === selected ? " selected" : "";
      return `<option value="${escapeHtml(option.value)}"${on}>${escapeHtml(option.label)}</option>`;
    }).join("");
    const wheel = node.tag === "wheelpicker";
    const label = interp(ctx, node.attrs["a11yLabel"] ?? node.attrs["label"] ?? (wheel ? "Wheel selection" : "Selection"));
    inner = `<select class="${wheel ? "dsx-wheelpicker-select" : "dsx-picker-select"}"`
      + `${wheel ? ' size="5"' : ""} aria-label="${escapeHtml(label)}"`
      + `${nativeControlDisabled(node, ctx) ? " disabled" : ""}>${optionHtml}</select>`;
    appendChildren = false;
  } else if (node.tag === "datepicker" || node.tag === "date") {
    const mode = normalizeDatePickerMode(node.attrs["mode"]);
    const bound = node.attrs["bind"] === undefined
      ? undefined
      : JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item);
    const value = isoDatePickerValue(bound, mode);
    const label = interp(ctx, node.attrs["label"] ?? "");
    const accessible = interp(ctx, (node.attrs["a11yLabel"] ?? label) || "Date and time");
    inner = `<span class="dsx-datepicker-label"${label.length === 0 ? " hidden" : ""}>${escapeHtml(label)}</span>`
      + `<input class="dsx-datepicker-input" type="${mode === "datetime" ? "datetime-local" : mode}"`
      + ` value="${escapeHtml(value)}" aria-label="${escapeHtml(accessible)}"`
      + `${nativeControlDisabled(node, ctx) ? " disabled" : ""}>`;
    appendChildren = false;
  } else if (node.tag === "combobox") {
    const query = node.attrs["bind"] === undefined
      ? ""
      : string(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item)).slice(0, 2_048);
    const placeholder = interp(ctx, node.attrs["placeholder"] ?? "");
    const accessible = interp(ctx, (node.attrs["a11yLabel"] ?? placeholder) || "Search options");
    const listId = `dsx-combobox-ssr-${++ctx.sequences.native}`;
    inner = `<input class="dsx-combobox-input" type="text" value="${escapeHtml(query)}"`
      + ` placeholder="${escapeHtml(placeholder)}" autocomplete="off" role="combobox"`
      + ` aria-autocomplete="list" aria-controls="${listId}" aria-expanded="false"`
      + ` aria-label="${escapeHtml(accessible)}"${nativeControlDisabled(node, ctx) ? " disabled" : ""}>`
      + `<div class="dsx-combobox-listbox" id="${listId}" role="listbox" hidden></div>`;
    appendChildren = false;
  } else if (node.tag === "otp") {
    const length = normalizeOtpLength(node.attrs["length"]);
    const raw = node.attrs["bind"] === undefined ? "" : string(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    const digits = Array.from(normalizeOtpValue(raw, length));
    const accessible = interp(ctx, node.attrs["a11yLabel"] ?? "One-time code");
    const boxes = Array.from({ length }, (_, index) =>
      `<span class="dsx-otp-box" aria-hidden="true" data-active="false">${escapeHtml(digits[index] ?? "")}</span>`
    ).join("");
    inner = `<input class="dsx-otp-input" type="text" inputmode="numeric" autocomplete="one-time-code"`
      + ` pattern="[0-9]*" value="${escapeHtml(raw.slice(0, 2_048))}" aria-label="${escapeHtml(accessible)}"`
      + `${nativeControlDisabled(node, ctx) ? " disabled" : ""}>`
      + `<span class="dsx-otp-boxes">${boxes}</span>`;
    appendChildren = false;
  } else if (node.tag === "rangeslider") {
    const { bounds, low, high } = nativeRangeValues(node, ctx);
    const domMax = bounds.degenerate ? bounds.min + 1 : bounds.max;
    const disabled = nativeControlDisabled(node, ctx) || bounds.degenerate;
    const step = bounds.step === null ? "any" : String(bounds.step);
    if (node.attrs["a11yLabel"] === undefined) attrs.push(`aria-label="Value range"`);
    attrs.push(`role="group"`);
    inner = `<span class="dsx-rangeslider-track"></span><span class="dsx-rangeslider-selected"></span>`
      + `<input class="dsx-rangeslider-input dsx-rangeslider-low" type="range" min="${bounds.min}" max="${high}" step="${step}" value="${low}" aria-label="${escapeHtml(interp(ctx, node.attrs["a11yLowLabel"] ?? "Lower value"))}" aria-valuenow="${low}"${disabled ? " disabled" : ""}>`
      + `<input class="dsx-rangeslider-input dsx-rangeslider-high" type="range" min="${low}" max="${domMax}" step="${step}" value="${bounds.degenerate ? domMax : high}" aria-label="${escapeHtml(interp(ctx, node.attrs["a11yHighLabel"] ?? "Upper value"))}" aria-valuenow="${high}"${disabled ? " disabled" : ""}>`;
    appendChildren = false;
  } else if (node.tag === "segmented") {
    const selected = node.attrs["bind"] === undefined
      ? undefined
      : JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item);
    const valueField = node.attrs["valueField"] ?? "id";
    const labelField = node.attrs["labelField"] ?? "label";
    const optionInput = node.attrs["optionsKey"] !== undefined
      ? JSE.eval(node.attrs["optionsKey"], ctx.store.jse, ctx.item)
      : (node.attrs["options"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    const options = segmentOptions(optionInput, valueField, labelField);
    const sameValue = (a: unknown, b: unknown): boolean => Object.is(a, b) || string(a) === string(b);
    const selectedIndex = options.findIndex((option) => sameValue(option.value, selected));
    const tabStop = selectedIndex >= 0 ? selectedIndex : 0;
    inner = options.map((option, index) => `<button type="button" role="radio" aria-checked="${String(index === selectedIndex)}" tabindex="${index === tabStop ? "0" : "-1"}">${escapeHtml(option.label)}</button>`).join("");
    attrs.push(`role="radiogroup"`, `aria-label="${escapeHtml(node.attrs["a11yLabel"] ?? node.attrs["label"] ?? "Selection")}"`);
    appendChildren = false;
  } else if (node.tag === "stars") {
    const rating = node.attrs["bind"] === undefined ? 0 : number(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item)) ?? 0;
    const count = normalizeStarCount(node.attrs["count"] ?? "5");
    const label = interp(ctx, node.attrs["a11yLabel"] ?? node.attrs["label"] ?? "Rating");
    inner = `<span aria-hidden="true">${"★".repeat(Math.max(0, Math.min(count, Math.round(rating))))}${"☆".repeat(Math.max(0, count - Math.round(rating)))}</span>`;
    attrs.push(`role="img"`, `aria-label="${escapeHtml(`${label}: ${rating} of ${count} stars`)}"`);
    appendChildren = false;
  } else if (node.tag === "chart") {
    inner = `<span class="dsx-static-status">Chart</span>`;
    attrs.push(`role="img"`, `aria-label="Chart"`);
    appendChildren = false;
  } else if (node.tag === "map") {
    inner = `<span class="dsx-static-status">Offline coordinate map</span>`;
    attrs.push(`role="img"`, `aria-label="Offline coordinate map"`);
    appendChildren = false;
  } else if (node.tag === "qrcode") {
    inner = `<span class="dsx-static-status">QR code</span>`;
    attrs.push(`role="img"`, `aria-label="${escapeHtml(node.attrs["a11yLabel"] ?? "QR code")}"`);
    appendChildren = false;
  } else if (node.tag === "Checkbox") {
    const checked = node.attrs["bind"] !== undefined
      && truthy(JSE.eval(node.attrs["bind"], ctx.store.jse, ctx.item));
    const label = node.attrs["label"] !== undefined ? interp(ctx, node.attrs["label"]) : "";
    inner = `<input type="checkbox"${checked ? " checked" : ""}>`
      + `<span class="dsx-checkbox-box" aria-hidden="true"></span>`
      + `<span class="dsx-checkbox-label">${escapeHtml(label)}</span>`;
    appendChildren = false;
  } else if (node.tag === "ProgressRing") {
    const line = Math.max(1, number(node.attrs["lineWidth"] ?? "10") ?? 10);
    const radius = Math.max(1, 50 - (line / 2));
    const circumference = 2 * Math.PI * radius;
    const maximum = progressMaximum(ctx, node.attrs["max"]);
    const current = boundNumber(ctx, node.attrs["bind"] ?? node.attrs["value"]);
    const ratio = maximum === 0 ? 0 : current / maximum;
    const fraction = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
    const label = node.attrs["label"] !== undefined ? interp(ctx, node.attrs["label"]) : "";
    inner = `<svg viewBox="0 0 100 100" aria-hidden="true">`
      + `<circle cx="50" cy="50" r="${radius}" fill="none" stroke-width="${line}" stroke="var(--dsx-ring-track)"></circle>`
      + `<circle cx="50" cy="50" r="${radius}" fill="none" stroke-width="${line}" class="dsx-progress-ring-arc" stroke="var(--dsx-ring-color)" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - fraction)}"></circle>`
      + `</svg><span class="dsx-progress-ring-label">${escapeHtml(label)}</span>`;
    appendChildren = false;
  } else if (node.tag === "Signature") {
    // The committed ink SSRs as an inline SVG in the SAME normalized space the canvas
    // draws in (viewBox 0 0 1 1, preserveAspectRatio="none", non-scaling strokes), so a
    // signed document has a real, printable first paint before the client mounts a pad.
    const strokes = boundSignature(ctx, node.attrs["bind"]);
    const placeholder = node.attrs["placeholder"] !== undefined
      ? interp(ctx, node.attrs["placeholder"]) : "";
    const ink = strokes.map((stroke) =>
      `<path d="${escapeHtml(inkPathData(stroke.points, 1, 1))}" fill="none"`
      + ` stroke="currentColor" stroke-width="${stroke.width || INK_STROKE_WIDTH}"`
      + ` stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>`)
      .join("");
    inner = `<svg class="dsx-signature-ink" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">${ink}</svg>`
      + `<span class="dsx-signature-placeholder" data-dsx-part="placeholder">${escapeHtml(placeholder)}</span>`;
    appendChildren = false;
  } else if (node.tag === "Skeleton") {
    appendChildren = false;
  } else if (node.tag === "ChatBubble") {
    const value = node.attrs["value"] !== undefined
      ? `<span class="dsx-chat-bubble-value">${escapeHtml(interp(ctx, node.attrs["value"]))}</span>`
      : "";
    inner = `<div class="dsx-chat-bubble-body">${value}${node.children.map((c) => renderNode(c, ctx)).join("")}</div>`;
    appendChildren = false;
  } else if (node.tag === "Accordion") {
    const open = truthy(node.attrs["open"] ?? false);
    const title = node.attrs["title"] !== undefined ? interp(ctx, node.attrs["title"]) : "";
    // the named "header" slot REPLACES the default title + chevron (Accordion.swift:16)
    const headerNodes = node.children.filter((c) => (c.attrs["slot"] ?? "") === "header");
    const bodyNodes = node.children.filter((c) => (c.attrs["slot"] ?? "") !== "header");
    const body = bodyNodes.map((c) => renderNode(c, ctx)).join("");
    const headerInner = headerNodes.length > 0
      ? headerNodes.map((c) => renderNode(c, ctx)).join("")
      : `<span class="dsx-accordion-title">${escapeHtml(title)}</span>`
        + `<span class="dsx-accordion-chevron" aria-hidden="true"${node.attrs["color"] === undefined ? "" : ` style="color: ${escapeHtml(componentColor(interp(ctx, node.attrs["color"]), "accent"))}"`}>›</span>`;
    inner = `<button class="dsx-accordion-header" type="button" aria-expanded="${open}"${headerNodes.length > 0 ? ` data-dsx-part="header"` : ""}>`
      + `${headerInner}</button><div class="dsx-accordion-body"${open ? "" : " hidden"}>${body}</div>`;
    appendChildren = false;
  } else if (unsupported) {
    inner = `<span class="dsx-unsupported-label">&lt;${escapeHtml(node.tag)}&gt; — native-only on this platform</span>`;
  }
  if (appendChildren) inner += node.children.map((c) => renderNode(c, ctx)).join("");

  attrs.push(...hydrationId(node, ctx));
  if (VOID_TAGS.has(tag)) return `<${tag} ${attrs.join(" ")}>`;
  return `<${tag} ${attrs.join(" ")}>${inner}</${tag}>`;
}

function renderCollectionItem(parentItem: Dict | null, raw: unknown, index: number): Dict {
  const row = isDict(raw) ? raw as Dict : null;
  const parent = parentItem ?? {};
  const own = (key: PropertyKey): boolean => typeof key === "string" && (
    key === "index" || (row !== null && Object.prototype.hasOwnProperty.call(row, key))
    || (row === null && key === "value") || Object.prototype.hasOwnProperty.call(parent, key)
  );
  return new Proxy({} as Dict, {
    get: (_target, key) => {
      if (key === "index") return index;
      if (row !== null && Object.prototype.hasOwnProperty.call(row, key)) return row[key as string];
      if (row === null && key === "value") return raw;
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

/** SSR twin of mount.ts's `normalizeListActions` — a swipe-button dict, same caps. */
type ServerListAction = {
  label: string; icon: string; destructive: boolean; color: string;
};
const LIST_ACTION_LIMIT = 8;
const LIST_ACTION_TEXT_LIMIT = 120;

function serverListActions(input: unknown): ServerListAction[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, LIST_ACTION_LIMIT).map((raw) => {
    const row: Dict = isDict(raw) ? raw as Dict : { label: raw };
    const text = (value: unknown): string => string(value).substring(0, LIST_ACTION_TEXT_LIMIT);
    return {
      label: text(row["label"] ?? row["title"] ?? ""),
      icon: text(row["icon"] ?? "").trim(),
      destructive: string(row["role"]) === "destructive",
      color: text(row["color"] ?? "").trim(),
    };
  });
}

function serverActionRail(edge: "leading" | "trailing", actions: readonly ServerListAction[], live: boolean): string {
  const buttons = actions.map((action) => {
    const tint = action.color.length === 0 ? "" : mapStyleValue("color", action.color);
    const style = tint.length === 0 ? "" : ` style="--dsx-list-action-tint: ${escapeHtml(tint)}"`;
    const role = action.destructive ? ' data-dsx-role="destructive"' : "";
    const icon = action.icon.length === 0
      ? ""
      : `<span class="dsx-list-action-icon" aria-hidden="true" data-dsx-icon="${escapeHtml(action.icon)}"></span>`;
    const label = action.label.length === 0
      ? ` aria-label="${escapeHtml(action.icon)}"`
      : "";
    const text = action.label.length === 0 ? "" : `<span class="dsx-list-action-label">${escapeHtml(action.label)}</span>`;
    return `<button class="dsx-list-action" type="button" data-dsx-part="action"${role}${label}${style}>${icon}${text}</button>`;
  }).join("");
  return `<div class="dsx-list-actions dsx-list-actions-${edge}" data-dsx-part="actions-${edge}"${live ? "" : " hidden"}>${buttons}</div>`;
}

function renderList(node: XmlNode, ctx: RenderCtx): string {
  const rowsValue = JSE.eval(node.attrs["bind"]!, ctx.store.jse, ctx.item);
  const total = Array.isArray(rowsValue) ? rowsValue.length : 0;
  const data = Array.isArray(rowsValue) ? rowsValue.slice(0, BOUND_COLLECTION_LIMIT) : [];
  const baseClass = node.tag === "grid" ? "dsx-list dsx-grid" : "dsx-list";
  const authoredClass = node.attrs["class"] === undefined ? "" : ` ${interp(ctx, node.attrs["class"]).trim()}`;
  const cls = `${baseClass}${authoredClass}`.trim();
  // ── the LIST CONSTRUCTS, SSR twin (mount.ts's mountList is the reference; the two
  //    must paint the same first frame because a bound collection is an adopt REBUILD).
  //    `scroll="false"` and a horizontal axis WIN over all three, exactly like the DOM.
  const ssrAxis = interp(ctx, node.attrs["axis"] ?? node.attrs["direction"] ?? "vertical") === "horizontal"
    ? "horizontal" : "vertical";
  const ssrScroll = interp(ctx, node.attrs["scroll"] ?? "true").trim().toLowerCase() !== "false";
  const constructsFit = node.tag === "list" && ssrAxis === "vertical" && ssrScroll;
  const groupAttr = node.tag === "list" ? node.attrs["group_by"] ?? node.attrs["groupBy"] : undefined;
  const groupField = groupAttr === undefined ? "" : interp(ctx, groupAttr).trim();
  const grouping = constructsFit && groupField.length > 0;
  const declaresReorder = node.attrs["reorder"] !== undefined;
  const reordering = constructsFit && !grouping && declaresReorder
    && booleanAttribute(interp(ctx, node.attrs["reorder"]!));
  const leadingActions = node.attrs["swipeLeading"] === undefined
    ? [] : serverListActions(JSE.eval(node.attrs["swipeLeading"], ctx.store.jse, ctx.item));
  const trailingActions = node.attrs["swipeTrailing"] === undefined
    ? [] : serverListActions(JSE.eval(node.attrs["swipeTrailing"], ctx.store.jse, ctx.item));
  const declaresSwipe = node.attrs["swipeLeading"] !== undefined || node.attrs["swipeTrailing"] !== undefined;
  const swiping = constructsFit && !reordering && (leadingActions.length > 0 || trailingActions.length > 0);
  const rowConstructs = node.tag === "list" && (declaresSwipe || declaresReorder);
  const cells = data.map((raw, i) => {
    const rowCtx: RenderCtx = { ...ctx, item: renderCollectionItem(ctx.item, raw, i) };
    const inner = node.children.map((c) => renderNode(c, rowCtx)).join("");
    const role = node.tag === "list"
      ? ` role="listitem" aria-posinset="${i + 1}" aria-setsize="${total}"`
      : ' role="gridcell"';
    if (!rowConstructs) return `<div class="dsx-row dsx-collection-row"${role}>${inner}</div>`;
    // The reorder DRAG is inherently interactive; the server paints the same handle the
    // client wires (and the same keyboard target), never a different row shape.
    const handle = declaresReorder
      ? `<button class="dsx-list-reorder" type="button" data-dsx-part="reorder" aria-label="Reorder" title="Reorder"${reordering ? "" : " hidden"}></button>`
      : "";
    const leadingRail = node.attrs["swipeLeading"] === undefined
      ? "" : serverActionRail("leading", leadingActions, swiping);
    const trailingRail = node.attrs["swipeTrailing"] === undefined
      ? "" : serverActionRail("trailing", trailingActions, swiping);
    return `<div class="dsx-row dsx-collection-row dsx-row-constructs"${role}>`
      + `<div class="dsx-list-row" data-dsx-part="row-host" data-dsx-swipe="closed">`
      + `${leadingRail}<div class="dsx-list-row-content" data-dsx-part="row-content">${handle}${inner}</div>${trailingRail}`
      + `</div></div>`;
  });
  const rawColumns = number(interp(ctx, node.attrs["columns"] ?? "3"));
  const columns = rawColumns !== null && rawColumns !== undefined && Number.isFinite(rawColumns)
    ? Math.min(Math.max(1, Math.trunc(rawColumns)), 256) : 3;
  const spacingFallback = node.tag === "grid" ? 10 : 0;
  const styles: string[] = [];
  if (node.attrs["spacing"] !== undefined) {
    const spacing = normalizeStructuralGap(interp(ctx, node.attrs["spacing"]), spacingFallback);
    styles.push(`--dsx-collection-spacing: ${spacing}px`);
  }
  if (node.tag === "grid" && node.attrs["columns"] !== undefined) styles.push(`--dsx-grid-columns: ${columns}`);
  const axis = ssrAxis;
  const scroll = ssrScroll ? "true" : "false";
  // unset align = STRETCH (the base rule) — no stamp (wave-7 F3), matching the client mount
  const authoredAlign = node.attrs["align"] === undefined ? null : interp(ctx, node.attrs["align"]);
  const alignAttr = authoredAlign === null
    ? ""
    : ` data-dsx-align="${authoredAlign === "center" || authoredAlign === "trailing" ? authoredAlign : "leading"}"`;
  const role = node.tag === "list" ? ' role="list"' : node.tag === "grid" ? ' role="grid"' : "";
  const gridMeta = node.tag === "grid"
    ? ` aria-colcount="${columns}" aria-rowcount="${Math.ceil(total / columns)}"` : "";
  const style = styles.length > 0 ? ` style="${styles.join("; ")}"` : "";
  let rows = cells.join("");
  if (node.tag === "grid") {
    const groups: string[] = [];
    for (let start = 0; start < cells.length; start += columns) {
      const groupCells = cells.slice(start, start + columns).map((cell, offset) =>
        cell.replace(' role="gridcell"', ` role="gridcell" aria-colindex="${offset + 1}"`),
      ).join("");
      groups.push(`<div class="dsx-grid-aria-row" role="row" aria-rowindex="${Math.floor(start / columns) + 1}">${groupCells}</div>`);
    }
    rows = groups.join("");
  } else if (grouping) {
    // FIRST-SEEN order for groups AND rows; the stringified field value IS the header
    const order: string[] = [];
    const buckets = new Map<string, string[]>();
    data.forEach((raw, i) => {
      const value = isDict(raw) ? string((raw as Dict)[groupField] ?? "") : "";
      const bucket = buckets.get(value);
      if (bucket === undefined) { order.push(value); buckets.set(value, [cells[i]!]); }
      else bucket.push(cells[i]!);
    });
    rows = order.map((value) =>
      `<div class="dsx-list-section" role="group" data-dsx-part="section" aria-label="${escapeHtml(value)}">`
      + `<div class="dsx-list-section-header" data-dsx-part="section-header" aria-hidden="true">${escapeHtml(value)}</div>`
      + `${(buckets.get(value) ?? []).join("")}</div>`,
    ).join("");
  }
  const bounds = ` data-dsx-total-count="${total}" data-dsx-rendered-count="${cells.length}" data-dsx-truncated="${String(total > BOUND_COLLECTION_LIMIT)}"`;
  const themeValue = node.attrs["theme"] === undefined ? "" : interp(ctx, node.attrs["theme"]).trim();
  const theme = themeValue === "dark" || themeValue === "light" ? ` data-dsx-theme="${themeValue}"` : "";
  // The construct stamps the client re-derives: the server states the SAME answer so the
  // first frame is not a different list. `autoscroll` paints the rail STATICALLY — the
  // marquee itself is a rAF loop and starts when the client mounts (declared in the ledger).
  const constructMeta =
    (groupAttr === undefined ? "" : ` data-dsx-grouped="${String(grouping)}"`)
    + (declaresReorder ? ` data-dsx-reorder="${String(reordering)}"` : "")
    + (declaresSwipe ? ` data-dsx-swipeable="${String(swiping)}"` : "")
    + (node.attrs["autoscroll"] === undefined ? "" : ` data-dsx-autoscroll="false"`);
  return `<div class="${cls}"${role}${gridMeta} data-dsx-axis="${axis}" data-dsx-scroll="${scroll}"${alignAttr}${bounds}${constructMeta}${theme}${style}>${rows}</div>`;
}

function renderComponentNode(node: XmlNode, ctx: RenderCtx): string {
  const ir = resolveComponent(ctx.registry, ctx.scheme, node.tag);
  if (ir === null) return "";
  const attrs: Dict = {};
  const overrides: Dict = {};
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name.startsWith("on:") || name.startsWith("__") || name === "slot" || name === "visible-if") continue;
    // the style-override split (corpus OpenSource/Conformance/overrides): the server
    // evaluates once and rides the same item-scope vehicle the client uses, so first
    // paint and adopt read identical values
    const override = overrideAttrName(name);
    if (override !== null) { overrides[override] = value.includes("{{") ? interp(ctx, value) : value; continue; }
    attrs[name] = value.includes("{{") ? interp(ctx, value) : value;
  }
  if (Object.keys(overrides).length > 0) attrs["__overrides"] = overrides;
  const defaults = node.children.filter((c) => (c.attrs["slot"] ?? "") === "");
  const named = new Map<string, XmlNode[]>();
  for (const c of node.children) {
    const s = c.attrs["slot"];
    if (s !== undefined && s.length > 0) named.set(s, [...(named.get(s) ?? []), c]);
  }
  const html = renderInstance(
    ir, ctx.registry, attrs, { defaults, named, ctx }, undefined, ctx.embed, ctx.formNamespace,
    ctx.sequences, ctx.hydrate, ctx.apiSeeds,
  );
  return decorateComponentRoot(html, node, ctx);
}

/** SSR twin of mount.ts's additive composed-root presentation contract. Generated
 * handles and authored classes are merged into (never substituted for) the component
 * root's own attributes; caller-reactive style declarations serialize after the
 * component's initial inline declarations so first paint has the same precedence. */
function decorateComponentRoot(html: string, node: XmlNode, ctx: RenderCtx): string {
  let decorated = mergeRootTokens(html, "data-dsx", (node.attrs["__css"] ?? "").split(/\s+/));
  if (node.attrs["__row"] === "1") decorated = mergeRootTokens(decorated, "class", ["dsx-hstack"]);
  const cls = node.attrs["class"];
  if (cls !== undefined) decorated = mergeRootTokens(decorated, "class", interp(ctx, cls).split(/\s+/));

  const styles: string[] = [];
  const reactiveStyle = node.attrs["__style_reactive"];
  if (reactiveStyle !== undefined) {
    for (const decl of reactiveStyle.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const prop = decl.substring(0, colon).trim();
      const value = interp(ctx, decl.substring(colon + 1)).trim();
      const mapped = mapStyleValue(prop, value);
      if (value.length > 0 && mapped.length > 0) styles.push(`${prop}: ${mapped}`);
    }
  }
  const styleListAttr = node.attrs["__style_list"];
  if (styleListAttr !== undefined) styles.push(...styleListDecls(ctx, styleListAttr));
  return styles.length > 0 ? appendRootAttribute(decorated, "style", styles.join("; ")) : decorated;
}

function mergeRootTokens(html: string, name: string, additions: string[]): string {
  const tokens = additions.filter((token) => token.length > 0);
  if (tokens.length === 0) return html;
  return html.replace(/^<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/, (opening) => {
    const pattern = new RegExp(`\\s${name}="([^"]*)"`);
    const found = pattern.exec(opening);
    const existing = found?.[1]?.split(/\s+/).filter(Boolean) ?? [];
    const merged = [...new Set([...existing, ...tokens.map(escapeHtml)])].join(" ");
    if (found !== null) return opening.replace(pattern, ` ${name}="${merged}"`);
    return opening.replace(/>$/, ` ${name}="${merged}">`);
  });
}

function appendRootAttribute(html: string, name: string, value: string): string {
  const escaped = escapeHtml(value);
  return html.replace(/^<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/, (opening) => {
    const pattern = new RegExp(`\\s${name}="([^"]*)"`);
    const found = pattern.exec(opening);
    if (found !== null) {
      const separator = found[1]!.trim().length > 0 ? "; " : "";
      return opening.replace(pattern, ` ${name}="${found[1]}${separator}${escaped}"`);
    }
    return opening.replace(/>$/, ` ${name}="${escaped}">`);
  });
}

/** the head's initial-state tier (attributes, function libraries, variables, formulas)
 *  — the scope url/headers/body interpolate against. Shared by renderInstance's body
 *  render and executeSsrApis's prefetch so both materialize identical requests. */
function setupHeadScope(store: ReactiveStore, ir: ComponentIR, attrs: Dict): void {
  store.jse.vars.set("dsx.attribute", { ...attrs });
  for (const a of ir.head.attributes) {
    if (a.default !== undefined) store.jse.attrDefaults.set(a.as, a.default);
  }
  // the style contract — declared knobs register so dsx.override.* resolves (the raw
  // values ride attrs.__overrides, the same item-scope door the client reads)
  for (const o of ir.head.overrides ?? []) store.jse.overrideDecls.set(o.as, o);
  // `<functions global="true">` — the app-wide function library (the @despia-native/dom
  // instantiate twin): global registration first, then the per-surface blocks.
  for (const s of ir.head.globalScripts) JSE.registerGlobalFunctions(s);
  for (const s of ir.head.scripts) JSE.registerFunctions(s, store.jse);
  for (const v of ir.head.variables) {
    if (v.computed) store.jse.computed.set(v.as, v.body);
    else store.jse.initials.set(v.as, JSE.evalBlock(v.body, store.jse, attrs));
  }
  for (const f of ir.head.formulas) store.jse.formulas.set(f.as, { inputs: f.inputs, body: f.body });
}

// ── SSR api execution: the route component AND every nested instance it renders ──────
// The client mounts every component instance and each auto-fetches its own <api> blocks
// (parallel). executeSsrApis mirrors that walk: a nested component's ssr-eligible GET
// runs during render and seeds the payload too, so the client adopts a CHILD's data
// instead of re-fetching it on mount. The payload is keyed by `as` — the client's
// ApiSeedSeam consumes by `as`, first mounter wins — so a name shared across instances
// resolves to ONE seed (the outermost, first-collected) and the rest fetch on mount
// (fail-open). Bounded by depth; the cross-block dependency graph (doc 11) and
// streaming/`defer` (doc 02) stay open — a `defer`red block is never awaited here.

const SSR_MAX_DEPTH = 32;

type SsrSlots = { defaults: XmlNode[]; named: Map<string, XmlNode[]>; wctx: SsrWalkCtx };
type SsrWalkCtx = {
  registry: Registry;
  scheme: string;
  store: ReactiveStore;
  item: Dict | null;
  slots: SsrSlots | null;
};

/** Discover the nested component references the server would render under `node`
 *  (visible-if honored, has:-gate honored, the first bound-collection row walked, slot
 *  content walked in CALLER scope) and hand each resolved instance to `emit`. Pure
 *  synchronous discovery — no I/O — mirroring renderNode's dispatch. */
function walkSsrComponents(
  node: XmlNode,
  wctx: SsrWalkCtx,
  emit: (ir: ComponentIR, attrs: Dict, slots: SsrSlots | null) => void,
): void {
  const vif = node.attrs["visible-if"];
  if (vif !== undefined && vif.startsWith("has:")) {
    if (!JSESeams.moduleAvailable(vif.slice(4).trim())) return;
  } else if (vif !== undefined && !truthy(JSE.eval(vif, wctx.store.jse, wctx.item))) return;

  if (node.tag === "head") return;
  if (node.tag === "slot") {
    const slots = wctx.slots;
    if (slots === null) return;
    const name = node.attrs["name"];
    const content = name !== undefined && name.length > 0 ? slots.named.get(name) ?? [] : slots.defaults;
    for (const child of content) walkSsrComponents(child, slots.wctx, emit); // caller scope
    return;
  }
  if ((node.tag === "list" || node.tag === "grid") && node.attrs["bind"] !== undefined) {
    // rows share one child template and the payload is `as`-keyed, so only the FIRST
    // row contributes a distinct seed (the client's row 0 consumes it); the rest
    // collide. Walk row 0 in its item scope; an empty binding has nothing to seed.
    const rowsValue = JSE.eval(node.attrs["bind"]!, wctx.store.jse, wctx.item);
    const rows = Array.isArray(rowsValue) ? rowsValue : [];
    if (rows.length === 0) return;
    const rowItem = renderCollectionItem(wctx.item, rows[0], 0);
    for (const child of node.children) walkSsrComponents(child, { ...wctx, item: rowItem }, emit);
    return;
  }
  if ((/^[A-Z]/.test(node.tag) || node.tag.includes(".")) && !RESERVED_SURFACE_TAGS.has(node.tag)) {
    const ir = resolveComponent(wctx.registry, wctx.scheme, node.tag);
    if (ir === null) return; // facet / universal global / unresolved — no ssr apis to seed
    const attrs: Dict = {};
    const overrides: Dict = {};
    for (const [name, value] of Object.entries(node.attrs)) {
      if (name.startsWith("on:") || name.startsWith("__") || name === "slot" || name === "visible-if") continue;
      const override = overrideAttrName(name);
      const plane = override !== null ? overrides : attrs;
      plane[override ?? name] = value.includes("{{") ? JSE.interpolate(value, wctx.store.jse, wctx.item) : value;
    }
    if (Object.keys(overrides).length > 0) attrs["__overrides"] = overrides;
    const defaults = node.children.filter((c) => (c.attrs["slot"] ?? "") === "");
    const named = new Map<string, XmlNode[]>();
    for (const c of node.children) {
      const s = c.attrs["slot"];
      if (s !== undefined && s.length > 0) named.set(s, [...(named.get(s) ?? []), c]);
    }
    emit(ir, attrs, { defaults, named, wctx }); // the ref's children are caller-scoped slots
    return; // the component's OWN body is walked when its instance recurses below
  }
  for (const child of node.children) walkSsrComponents(child, wctx, emit);
}

/** Execute one instance's ssr-eligible apis in ITS scope, then recurse into the nested
 *  instances it renders. Seeds accumulate by `as` (first-wins across the whole tree). */
async function runInstanceSsrApis(
  ir: ComponentIR,
  registry: Registry,
  attrs: Dict,
  vars: Dict | undefined,
  slots: SsrSlots | null,
  seeds: { [as: string]: ApiSeed },
  opts: { now?: () => number; timeoutMs?: number },
  depth: number,
): Promise<void> {
  if (depth > SSR_MAX_DEPTH) return;
  const store = new ReactiveStore();
  setupHeadScope(store, ir, attrs);
  if (vars !== undefined) store.jse.vars.set("vars", vars); // pushed vars → {{ vars.path }}
  // null-seed every envelope so a url that reads another block's `.data` resolves (doc 05)
  for (const a of ir.head.apis) {
    if (store.jse.vars.get(a.as) === undefined) {
      store.jse.vars.set(a.as, {
        data: null, loading: false, refreshing: false, error: null, fetchedAt: null,
        status: "ready", blockedBy: [], progress: null,
      });
    }
  }
  const pending: Array<Promise<void>> = [];
  // this instance's OWN apis, walked as the doc-11 DAG: every runnable block starts
  // TOGETHER and a dependent starts the moment its upstream resolves — the waterfall
  // exists ONLY where the data demands it, which is what makes 05's "parallel by
  // default" precise. A block still gated at flush time is simply not seeded: it
  // serializes as `waiting` and the client resolves its chain.
  const specs = ir.head.apis.map((a) => a.attrs as unknown as ApiSpec);
  const graph = new ApiGraph(specs);
  const remaining = new Map<string, ApiSpec>(specs.map((spec) => [spec.as, spec]));
  const resolved = new Set<string>();
  const runnable = (spec: ApiSpec): boolean => {
    for (const up of graph.upstreamsOf(spec.as)) if (!resolved.has(up)) return false;
    const missing = materializeApiRequest(spec, store, attrs)["_missing"];
    return !(Array.isArray(missing) && missing.length > 0);
  };
  pending.push((async () => {
    for (;;) {
      const wave = [...remaining.values()].filter(runnable);
      if (wave.length === 0) return;
      for (const spec of wave) remaining.delete(spec.as);
      await Promise.all(wave.map(async (spec) => {
        const outcome = await executeApiForSSR(spec, store, attrs, opts);
        if (outcome.status !== "seed") return;
        resolved.add(spec.as);
        if (seeds[spec.as] === undefined) seeds[spec.as] = outcome.envelope;
        // publish into THIS render scope so a dependent's url materializes whole
        store.jse.vars.set(spec.as, {
          data: outcome.envelope.data ?? null,
          loading: false, refreshing: false, error: null,
          fetchedAt: outcome.envelope.fetchedAt ?? null,
          status: "ready", blockedBy: [], progress: null,
        });
      }));
    }
  })());
  // the nested instances the server would render, each recursing in its own scope
  walkSsrComponents(
    ir.root,
    { registry, scheme: ir.scheme, store, item: attrs, slots },
    (childIr, childAttrs, childSlots) => {
      pending.push(runInstanceSsrApis(childIr, registry, childAttrs, undefined, childSlots, seeds, opts, depth + 1));
    },
  );
  await Promise.all(pending);
  store.dispose();
}

/** Execute a route's SSR-eligible `<api>` blocks during server render (doc 05 "SSR
 *  semantics" — parallel), across the route component AND the nested components it
 *  renders. Returns the ok envelopes keyed by `as` for the hydration payload;
 *  ineligible or failed blocks are omitted, so the client fetches them on mount
 *  (fail-open, never a broken page). */
export async function executeSsrApis(
  registry: Registry,
  qualified: string,
  vars: Dict = {},
  opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<{ [as: string]: ApiSeed }> {
  const ir = registry.components[qualified];
  if (ir === undefined) return {};
  const seeds: { [as: string]: ApiSeed } = {};
  await runInstanceSsrApis(ir, registry, {}, vars, null, seeds, opts, 0);
  return seeds;
}

/** doc 02 out-of-order streaming — the STREAM pass (stream.ts renderPageStream): run the
 *  DEFERRED, otherwise-ssr-eligible `<api>` blocks across the route component AND the
 *  nested components it renders (the runInstanceSsrApis walk), after the initial flush,
 *  reporting each resolved seed the moment it lands (out of order — Promise.all is the
 *  barrier for CLOSING the stream, not for flushing). Each scope seeds the initial
 *  pass's envelopes first, so a deferred url reading a non-deferred block's `.data`
 *  materializes exactly like it would client-side. Seeds are FIRST-WINS by `as` across
 *  the whole tree — the same flat key space as the hydration payload, and the same
 *  addressing the client applies chunks by. */
export async function executeStreamApis(
  registry: Registry,
  qualified: string,
  vars: Dict,
  initialSeeds: { [as: string]: ApiSeed },
  opts: { now?: () => number; timeoutMs?: number },
  onSeed: (as: string, seed: ApiSeed) => void,
): Promise<void> {
  const ir = registry.components[qualified];
  if (ir === undefined) return;
  // A key the initial pass already seeded is owned — a deferred twin of the same name
  // anywhere in the tree must not re-flush it (the payload's first-wins rule).
  const claimed = new Set<string>(Object.keys(initialSeeds));
  await runInstanceStreamApis(ir, registry, {}, vars, null, initialSeeds, claimed, opts, onSeed, 0);
}

/** One instance's deferred blocks in ITS scope, then the nested instances it renders —
 *  the runInstanceSsrApis shape with the deferred filter and the streaming first-wins. */
async function runInstanceStreamApis(
  ir: ComponentIR,
  registry: Registry,
  attrs: Dict,
  vars: Dict | undefined,
  slots: SsrSlots | null,
  initialSeeds: { [as: string]: ApiSeed },
  claimed: Set<string>,
  opts: { now?: () => number; timeoutMs?: number },
  onSeed: (as: string, seed: ApiSeed) => void,
  depth: number,
): Promise<void> {
  if (depth > SSR_MAX_DEPTH) return;
  const store = new ReactiveStore();
  setupHeadScope(store, ir, attrs);
  if (vars !== undefined) store.jse.vars.set("vars", vars);
  for (const a of ir.head.apis) {
    if (store.jse.vars.get(a.as) === undefined) {
      const seed = initialSeeds[a.as];
      store.jse.vars.set(a.as, seed !== undefined
        ? { data: seed.data ?? null, loading: false, refreshing: false, error: seed.error ?? null,
            fetchedAt: seed.fetchedAt ?? null, status: "ready", blockedBy: [], progress: null }
        : { data: null, loading: false, refreshing: false, error: null, fetchedAt: null,
            status: "ready", blockedBy: [], progress: null });
    }
  }
  const pending: Array<Promise<void>> = [];
  const deferred = ir.head.apis
    .map((a) => a.attrs as unknown as ApiSpec)
    .filter(apiStreamEligible);
  for (const spec of deferred) {
    pending.push((async () => {
      const outcome = await executeApiForSSR(spec, store, attrs, { ...opts, allowDeferred: true });
      if (outcome.status !== "seed") return;
      if (claimed.has(spec.as)) return;
      claimed.add(spec.as);
      onSeed(spec.as, outcome.envelope);
    })());
  }
  walkSsrComponents(
    ir.root,
    { registry, scheme: ir.scheme, store, item: attrs, slots },
    (childIr, childAttrs, childSlots) => {
      pending.push(runInstanceStreamApis(childIr, registry, childAttrs, undefined, childSlots,
                                         initialSeeds, claimed, opts, onSeed, depth + 1));
    },
  );
  await Promise.all(pending);
  store.dispose();
}

function renderInstance(
  ir: ComponentIR,
  registry: Registry,
  attrs: Dict,
  slots: RenderCtx["slots"],
  vars?: Dict,
  embed?: boolean,
  formNamespace?: string,
  sequences: RenderSequences = { field: 0, native: 0, structural: 0, overlay: 0, application: 0 },
  hydrate?: boolean,
  apiSeeds?: { [as: string]: ApiSeed },
): string {
  if (hydrate === true) stampNodeIds(ir.root as IRNode);
  const store = new ReactiveStore();
  // the head, initial-state only (actions/apis/watches are client machinery)
  setupHeadScope(store, ir, attrs);
  for (const a of ir.head.apis) {
    // envelopes seed null (data null until first client resolve — doc 05), OR the
    // SSR-resolved value when a hydration seed for this block is supplied so first
    // paint shows the data (doc 02 — renderPageAsync executes + seeds them).
    if (store.jse.vars.get(a.as) === undefined) {
      const seed = apiSeeds?.[a.as];
      store.jse.vars.set(a.as, seed !== undefined
        ? { data: seed.data ?? null, loading: false, refreshing: false, error: seed.error ?? null, fetchedAt: seed.fetchedAt ?? null }
        : { data: null, loading: false, refreshing: false, error: null, fetchedAt: null });
    }
  }
  if (vars) for (const [k, v] of Object.entries(vars)) store.jse.vars.set(k, v);

  const ctx: RenderCtx = {
    registry, scheme: ir.scheme, store, item: attrs, slots, sequences,
    ...(embed === true ? { embed: true } : {}),
    ...(formNamespace !== undefined ? { formNamespace } : {}),
    ...(hydrate === true ? { hydrate: true } : {}),
    ...(apiSeeds !== undefined ? { apiSeeds } : {}),
  };
  const html = renderNode(ir.root, ctx);
  store.dispose();
  // stamp the owner on the root element (the first tag)
  return html.replace(/^<([a-zA-Z0-9]+) /, `<$1 data-dsx-owner="${escapeHtml(ir.name)}" `);
}

/** Render one component (qualified name) to an HTML string. `hydrate: true` stamps
 *  every emitted element with `data-dsx-n` (its IR node identity, stampNodeIds) —
 *  the alignment key the client adopt walk verifies (W6). Off by default so bare
 *  string rendering and embed fragments stay byte-identical to v0 output. */
export function renderToString(
  registry: Registry,
  qualified: string,
  vars: Dict = {},
  opts: { hydrate?: boolean; apiSeeds?: { [as: string]: ApiSeed } } = {},
): string {
  const ir = registry.components[qualified];
  if (ir === undefined) throw new Error(`unknown component: ${qualified}`);
  return renderInstance(
    ir, registry, {}, null, { vars }, undefined, undefined,
    { field: 0, native: 0, structural: 0, overlay: 0, application: 0 },
    opts.hydrate === true,
    opts.apiSeeds,
  );
}

/** Serialize an embed's SSR api-seed payload for the DSD `<script type="application/json"
 *  data-dsx-ssr>` — same `<`/`>`/`&`/line-separator neutralization as the page payload. */
function serializeEmbedSeeds(seeds: { [as: string]: ApiSeed }): string {
  return JSON.stringify(seeds)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Assemble the DSD fragment around a component: the host tag with echoed attributes,
 *  the inline style stack, an OPTIONAL SSR seed script (only when apis resolved), and
 *  the pre-rendered body (seeded with the same data). */
function assembleEmbedFragment(
  registry: Registry,
  ir: ComponentIR,
  tag: string,
  css: string,
  attrs: Dict,
  apiSeeds: { [as: string]: ApiSeed },
): string {
  const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const echo = Object.entries(attrs)
    .map(([k, v]) => ` ${kebab(k)}="${escapeHtml(isDict(v) || Array.isArray(v) ? JSON.stringify(v) : string(v))}"`)
    .join("");
  const seeded = Object.keys(apiSeeds).length > 0;
  const html = renderInstance(
    ir, registry, attrs, null, undefined, true, undefined,
    { field: 0, native: 0, structural: 0, overlay: 0, application: 0 },
    false, seeded ? apiSeeds : undefined,
  );
  // the embed's api-seed payload rides INSIDE the shadow root so the upgrade adopts the
  // server-resolved data and skips the initial fetch (the page path's window.__DSX__ twin,
  // scoped per custom-element instance — @despia-native/element readEmbedSeeds). Absent when nothing
  // resolved, so a no-api / CSR-only embed stays byte-identical to v0 output.
  const seedScript = seeded
    ? `<script type="application/json" data-dsx-ssr>${serializeEmbedSeeds(apiSeeds)}</script>`
    : "";
  return `<${tag}${echo}><template shadowrootmode="open"><style>${escapeStyleText(css)}</style>${seedScript}${html}</template></${tag}>`;
}

/** Render an EXPOSED component as a declarative-shadow-DOM fragment (/web/13): the
 *  custom-element tag wrapping `<template shadowrootmode="open">` — the style stack
 *  inline (adopted sheets don't serialize) + the pre-rendered body, attributes
 *  echoed on the host tag (rich values as JSON text, the attribute form). A third-
 *  party server inlines this for first paint; the embed script upgrades in place.
 *  SYNC / no-fetch — every api envelope seeds null (the client fetches on upgrade);
 *  renderEmbedFragmentAsync is the SSR-executing twin. */
export function renderEmbedFragment(
  registry: Registry,
  qualified: string,
  tag: string,
  css: string,
  attrs: Dict = {},
): string {
  const ir = registry.components[qualified];
  if (ir === undefined) throw new Error(`unknown component: ${qualified}`);
  return assembleEmbedFragment(registry, ir, tag, css, attrs, {});
}

/** The SSR-executing embed fragment (/web/13 scenario 2, W6): run the exposed
 *  component's ssr-eligible `<api>` GET blocks (and its nested instances') during
 *  render, paint their data into the fragment body AND embed the seed payload in the
 *  DSD, so a third party's inlined fragment shows real data on first paint and the
 *  embed upgrade adopts it instead of re-fetching. Fail-open exactly like the page
 *  path: any ineligible/failed block is absent from the payload and fetches on the
 *  client. This is what the live per-request fragment endpoint (serve.ts) calls. */
export async function renderEmbedFragmentAsync(
  registry: Registry,
  qualified: string,
  tag: string,
  css: string,
  attrs: Dict = {},
  opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<string> {
  const ir = registry.components[qualified];
  if (ir === undefined) throw new Error(`unknown component: ${qualified}`);
  const seeds: { [as: string]: ApiSeed } = {};
  await runInstanceSsrApis(ir, registry, attrs, undefined, null, seeds, opts, 0);
  return assembleEmbedFragment(registry, ir, tag, css, attrs, seeds);
}

// keep kernel imports referenced (erasable-only builds)
void ActionRunner;
void makeRunEnv;
