// Pure custom-element entry generation shared by build-demo and focused slicing
// tests. Conditional imports remain testable without a destructive demo build.

import { BRIDGE_ATTRS } from "../src/cssmap.ts";
import type { Registry } from "../src/resolve.ts";
import type { XmlNode } from "../src/xml.ts";

// Kept in step with mount.ts by hand, which is the shape this file has always had: the
// tree-shaker cannot import the runtime it is deciding whether to include. `flow` joined on
// 2026-08-26 (runtime-pressure R29).
const BOUND_COLLECTION_TAGS: ReadonlySet<string> = new Set(["list", "grid", "pager", "flow"]);
const FULL_APPLICATION_CHROME_TAGS: ReadonlySet<string> = new Set(["Drawer", "MenuBar"]);
const FULL_APPLICATION_MEDIA_TAGS: ReadonlySet<string> = new Set(["svg", "lightbox"]);
const PLAYBACK_MEDIA_TAGS: ReadonlySet<string> = new Set(["audio", "video"]);

export function registryPlaybackMediaTags(registry: Registry): string[] {
  const found = new Set<string>();
  const visit = (node: XmlNode): void => {
    if (PLAYBACK_MEDIA_TAGS.has(node.tag)) found.add(node.tag);
    for (const child of node.children) visit(child);
  };
  for (const component of Object.values(registry.components)) visit(component.root);
  return [...found].sort();
}

export function registryFullApplicationTags(registry: Registry): string[] {
  const found = new Set<string>();
  const visit = (node: XmlNode): void => {
    if (FULL_APPLICATION_CHROME_TAGS.has(node.tag) || FULL_APPLICATION_MEDIA_TAGS.has(node.tag)) found.add(node.tag);
    for (const child of node.children) visit(child);
  };
  for (const component of Object.values(registry.components)) visit(component.root);
  return [...found].sort();
}

/** Drawer/MenuBar coordinate body-level portals, focus inerting and application
 * chrome. They are intentionally excluded from self-contained custom-element
 * embeds until that isolation contract can fit inside the default G10 widget budget. */
export function assertEmbedCompatible(registry: Registry, label = "component"): void {
  const tags = registryFullApplicationTags(registry);
  const media = tags.filter((tag) => FULL_APPLICATION_MEDIA_TAGS.has(tag));
  if (media.length > 0) {
    throw new Error(
      `[dsx embed] ${label} uses full-application-only media surface(s) ${media.map((tag) => `<${tag}>`).join(", ")}; `
      + "their minimal locked self-contained bundle exceeds both the default 40KiB G10 widget budget and the declared 49KiB media qualification, or requires host-level modal ownership. Use host-provided media/composition in an embed, or a full DSX app; the budget is not raised.",
    );
  }
  if (tags.some((tag) => FULL_APPLICATION_CHROME_TAGS.has(tag))) {
    throw new Error(
      `[dsx embed] ${label} uses Drawer/MenuBar, which are full-application chrome and cannot ship in a self-contained custom-element embed (host-level portals/inert and the unchanged G10 budget); use them in a full DSX app.`,
    );
  }
}

/** Bound collection reconciliation is the largest optional part of the shared DOM
 * runtime. Keep its detection next to embed entry generation so every caller uses
 * the same transitive, attribute-aware rule: static structural controls do not pay
 * for keyed collection reconciliation, while any nested `bind=` does. */
export function registryUsesBoundCollections(registry: Registry): boolean {
  const visit = (node: XmlNode): boolean => (
    (BOUND_COLLECTION_TAGS.has(node.tag) && node.attrs["bind"] !== undefined) ||
    node.children.some(visit)
  );
  return Object.values(registry.components).some((component) => visit(component.root));
}

/** Universal presentation features stay available by default, but an exposed
 * component that never authors one should not pay for its runtime branch. */
export function registryUsesAttribute(registry: Registry, attribute: string): boolean {
  const visit = (node: XmlNode): boolean => (
    node.attrs[attribute] !== undefined || node.children.some(visit)
  );
  return Object.values(registry.components).some((component) => visit(component.root));
}

/** G4 unified input (dsx-game.md §2) — a SLICEABLE feature: an embed that declares no head
 *  `<input>` and authors no `on:input.<name>` handler strips the whole input runtime
 *  (@despia/dom input.ts + the kernel's resolver/machine) out of its bundle. Both halves count:
 *  the DECLARATION lives in the head, the CONSUMER is an `on:input.` prefixed attribute. */
export function registryUsesDeclaredInput(registry: Registry): boolean {
  const visit = (node: XmlNode): boolean => (
    Object.keys(node.attrs).some((name) => name.startsWith("on:input.")) || node.children.some(visit)
  );
  return Object.values(registry.components).some(
    (component) => component.head.inputs.length > 0 || visit(component.root),
  );
}

/** Every JS-globals entry point (core.ts `JSECore` + `JSECrypto`). The layer is
 *  reachable ONLY by NAME: `Math.round(x)`, `new Date()`, `URL(u)`, `new Map()`,
 *  `btoa(s)`, `crypto.randomUUID()`, `Infinity`, and the two string-side companions
 *  `"…".toHex()` / `"…".toBase64()`. Every dict SHAPE the layer consumes ({__date},
 *  {__url}, {__params}, {__map}, {__set}, {__textEncoder}) is minted by one of these
 *  names and nowhere else, so the shape-side methods (`getTime`, `toISOString`, …)
 *  need no entry of their own: without a constructor name no such shape can exist.
 *  A `dsx.module.` / `dsx.component.` call is included as the ONE foreign-value seam
 *  (a facet could in principle hand back such a dict), so the answer stays conservative. */
const JS_GLOBAL_NAMES: readonly string[] = [
  "Math", "JSON", "Object", "Date", "Intl", "Promise", "console", "performance",
  "URL", "URLSearchParams", "Headers", "Request", "Blob", "File", "FormData",
  "AbortController", "structuredClone", "encodeURI", "encodeURIComponent",
  "decodeURI", "decodeURIComponent", "parseInt", "parseFloat", "isNaN",
  "Number", "String", "Boolean", "Map", "Set", "Error", "RegExp", "WebSocket",
  "Array", "Uint8Array", "TextEncoder", "TextDecoder", "crypto", "btoa", "atob",
  "toHex", "toBase64", "Infinity", "NaN",
];
const JS_GLOBALS_RE = new RegExp(`\\b(?:${JS_GLOBAL_NAMES.join("|")})\\b|dsx\\.(?:module|component)\\.`);

/** The expression-bearing text of a closed slice: every attribute value and text body
 *  in the markup, plus every head block that carries JSE source. Deliberately a
 *  SUPERSET of what the evaluator sees — a plain label that happens to read "Set"
 *  keeps the layer, which is the safe direction. */
function sliceExpressionText(registry: Registry): string {
  const parts: string[] = [];
  const visit = (node: XmlNode): void => {
    for (const value of Object.values(node.attrs)) parts.push(value);
    parts.push(node.text);
    for (const child of node.children) visit(child);
  };
  for (const component of Object.values(registry.components)) {
    const head = component.head;
    for (const attribute of head.attributes) parts.push(attribute.default ?? "");
    for (const api of head.apis) parts.push(...Object.values(api.attrs));
    for (const variable of head.variables) parts.push(variable.body);
    for (const formula of head.formulas) parts.push(formula.body, ...Object.values(formula.inputs));
    for (const action of head.actions) parts.push(action.body, ...Object.values(action.inputs));
    for (const watch of head.watches) parts.push(watch.value, watch.handler);
    parts.push(...head.scripts, ...head.globalScripts);
    visit(component.root);
  }
  return parts.join("\n");
}

/** A capitalized tag that is not a component of this slice is a MODULE-PROVIDED facet
 *  mount (/web/18) or a rich native twin — code outside the closed slice, whose payload
 *  this build cannot read. Treated as a JS-globals user so the fold never reasons about
 *  values it did not compile. */
function registryMountsForeignComponent(registry: Registry): boolean {
  const known = new Set<string>();
  for (const qualified of Object.keys(registry.components)) {
    known.add(qualified);
    known.add(qualified.substring(qualified.indexOf(".") + 1));
  }
  const visit = (node: XmlNode): boolean => {
    const initial = node.tag.charAt(0);
    if (initial === initial.toUpperCase() && initial !== initial.toLowerCase() && !known.has(node.tag)) return true;
    return node.children.some(visit);
  };
  return Object.values(registry.components).some((component) => visit(component.root));
}

/** Does this closed slice reach the JS-globals layer at all? (core.ts "the JS-GLOBALS
 *  FOLD"). False lets the build strip Date/URL/Intl/JSON/Math/Map/Set/crypto/base64 —
 *  the single largest optional block left in a minimal embed. */
export function registryUsesJsGlobals(registry: Registry): boolean {
  return JS_GLOBALS_RE.test(sliceExpressionText(registry)) || registryMountsForeignComponent(registry);
}

/** The runner's NETWORK machine — `fetch(…)` as a call and `fetch:` as an effect verb — plus
 *  any `<api>` block, whose own transport shares the guards. False lets the build strip ~9 KB of
 *  request encoder, ceilings, header validation, response reader and https-downgrade check
 *  (runner.ts "THE NETWORK MACHINE IS OPTIONAL"), which most self-contained embeds never reach.
 *
 *  A SUPERSET test, like the JS-globals fold above: a label reading "fetch" keeps the machine.
 *  A foreign component mount also keeps it, because this build cannot read that payload. */
export function registryUsesFetch(registry: Registry): boolean {
  if (Object.values(registry.components).some((c) => (c.head?.apis?.length ?? 0) > 0)) return true;
  return /\bfetch\b/.test(sliceExpressionText(registry)) || registryMountsForeignComponent(registry);
}

export function registryUsesInterpolatedAttribute(registry: Registry, attribute: string): boolean {
  const visit = (node: XmlNode): boolean => (
    node.attrs[attribute]?.includes("{{") === true || node.children.some(visit)
  );
  return Object.values(registry.components).some((component) => visit(component.root));
}

/** The JSE REGEX ENGINE is optional (regex.ts JSE_REGEX_FULL/ABSENT, the JS-globals fold's
 *  sibling): a regex VALUE is minted only by a `/…/` literal, the `RegExp` global, or the
 *  `regex()` builtin — or handed back by code outside the closed slice. A SUPERSET text
 *  test, like the folds above: any `/` (division, a URL in a label) keeps the engine, which
 *  is the safe direction; the string-pattern halves of replace/split stay real either way. */
/** BLOCK ITERATION (loops in expression blocks, corpus core-004 + block-scope mutation,
 *  core-003): reachable only through a loop keyword, a block-bodied lambda / function
 *  (any brace body can mutate its locals), or ++/--. Foreign payloads keep it — the
 *  usual superset direction: a mention anywhere keeps the subsystem. */
export function registryUsesBlockIteration(registry: Registry): boolean {
  return /(?:^|[^\w.$])(?:for|while|do)\s*\(|=>\s*\{|\bfunction\b|\+\+|--/.test(sliceExpressionText(registry))
    || registryMountsForeignComponent(registry);
}

/** The SOURCE HIGHLIGHTER (highlight.ts, the `<code>` surface's scanner) is optional: it is
 *  reachable only through the `highlight()` builtin, which a document either names or does
 *  not. Superset by construction, like every fold above - the word anywhere keeps it. */
export function registryUsesHighlight(registry: Registry): boolean {
  return /\bhighlight\b/.test(sliceExpressionText(registry))
    || registryMountsForeignComponent(registry);
}

/** Every element name the slice actually authors. */
function sliceTags(registry: Registry): Set<string> {
  const tags = new Set<string>();
  const visit = (node: XmlNode): void => {
    tags.add(node.tag);
    for (const child of node.children) visit(child);
  };
  for (const component of Object.values(registry.components)) visit(component.root);
  return tags;
}

/** THE ZOOM ANNOUNCEMENT (R21) is reachable only by a document that has a `<canvas>` AND a
 *  `transform` to put it under: a widget with neither cannot observe the event, so the
 *  announcement folds out of the renderer's style binder entirely. Superset by
 *  construction like every fold here - either half anywhere in the slice keeps it. */
export function registryUsesCanvasZoom(registry: Registry): boolean {
  return (sliceTags(registry).has("canvas") && /\btransform\b/.test(sliceExpressionText(registry)))
    || registryMountsForeignComponent(registry);
}

export function registryUsesRegex(registry: Registry): boolean {
  return /[/]|\bRegExp\b|\bregex\b/.test(sliceExpressionText(registry))
    || registryMountsForeignComponent(registry);
}

/** A literal spelling anywhere in the slice's authored text (attrs, text bodies, head
 *  JSE) or its compiled css — the safety net for css folds whose classes/attributes an
 *  author can also hand-write (`class="dsx-surface-thin"`, a `[data-dsx-theme]` sidecar
 *  rule). Superset by construction: a mention anywhere keeps the subsystem. */
export function registryMentions(registry: Registry, needle: string): boolean {
  return sliceExpressionText(registry).includes(needle) || registry.css.includes(needle);
}

/** The NON-DEFAULT button skin (theme.ts BUTTON_VARIANTS_CSS_*): variant="bordered" and
 *  the destructive/cancel role words stamp data attributes only from authored variant=/
 *  role= (elements.ts buttonEl), so a slice that authors none of those spellings folds
 *  the skin. Interpolated variant/role can resolve to any word at runtime, so either
 *  keeps it — the usual superset direction. */
export function registryUsesButtonVariants(registry: Registry): boolean {
  return /\b(?:bordered|destructive|cancel)\b/.test(sliceExpressionText(registry))
    || registryUsesInterpolatedAttribute(registry, "variant")
    || registryUsesInterpolatedAttribute(registry, "role")
    || registryMountsForeignComponent(registry);
}

/** The RUNTIME STYLE-FORMULA bridge (cssmap.ts vocabulary tables + the legacy-attr
 *  runtime half) is optional: static styles are mapped at BUILD time, so only a
 *  `{{ }}`-reactive style/bridge attr, a semantic `color=` (elements bind it live), or
 *  rows arriving from data (bound collections carry tinted swipe actions) can reach the
 *  mapper at runtime. Foreign payloads keep it, as everywhere: this build cannot read them. */
export function registryUsesStyleFormulas(registry: Registry): boolean {
  if (registryUsesInterpolatedAttribute(registry, "style")) return true;
  // the compiled spelling of a sole-`{{ }}` style attribute (css.ts rewrites it into a
  // whole-declaration-list hole) — the mapper is exactly what consumes it at runtime
  if (registryUsesAttribute(registry, "__style_list")) return true;
  for (const attr of BRIDGE_ATTRS) {
    if (registryUsesInterpolatedAttribute(registry, attr)) return true;
  }
  return registryUsesAttribute(registry, "color")
    || registryUsesBoundCollections(registry)
    || registryMountsForeignComponent(registry);
}

/** The STYLE-OVERRIDE plane (kernel style-overrides.ts + the mount split, the
 *  instantiate seed and the JSE `dsx.override` branch) is optional: a knob is
 *  reachable only through a declared `<override>` head, an `override:` usage
 *  spelling on a component tag, or a `dsx.override` read — a slice that authors
 *  none of them can never mint or resolve one, so the resolver and both doors
 *  fold away. Superset as everywhere: foreign payloads keep it. */
export function registryUsesStyleOverrides(registry: Registry): boolean {
  if (Object.values(registry.components).some((c) => (c.head?.overrides?.length ?? 0) > 0)) return true;
  const visit = (node: XmlNode): boolean => (
    Object.keys(node.attrs).some((name) => name.startsWith("override:")) || node.children.some(visit)
  );
  if (Object.values(registry.components).some((component) => visit(component.root))) return true;
  return /\bdsx\.override\b/.test(sliceExpressionText(registry))
    || registryMountsForeignComponent(registry);
}

export type EmbedEntryFeatures = {
  universalGlobals: boolean;
  controlElements: boolean;
  formElements: boolean;
  richElements: boolean;
  nativeControls: boolean;
  structuralControls: boolean;
  overlayControls: boolean;
  dataControls: boolean;
  audioSurface: boolean;
  videoSurface: boolean;
  boundCollections: boolean;
};

export type EmbedEntryOptions = {
  registry: Registry;
  tag: string;
  component: string;
  features: EmbedEntryFeatures;
  facetSrc?: string;
};

export function embedEntrySource(options: EmbedEntryOptions): string {
  assertEmbedCompatible(options.registry, options.component);
  const f = options.features;
  const detectedPlayback = registryPlaybackMediaTags(options.registry);
  const audioSurface = f.audioSurface || detectedPlayback.includes("audio");
  const videoSurface = f.videoSurface || detectedPlayback.includes("video");
  const playback = audioSurface || videoSurface;
  // Universal motion attrs (enter/transition/keep) — auto-detected like playback, never a
  // caller flag: they are markup facts. A motion-free embed ships only mount.ts's empty
  // ElementMotionSeam (a few bytes); an embed that authors one pulls the machinery in.
  // anim/animDuration alone do nothing (they only parameterize the other three), so they
  // do not trigger the import.
  const motion = ["enter", "transition", "keep"]
    .some((attribute) => registryUsesAttribute(options.registry, attribute));
  const withOptionalCss = f.controlElements || f.formElements || f.richElements ||
    f.nativeControls || f.structuralControls || f.overlayControls || f.dataControls || playback || f.universalGlobals;
  // The compiled default `overrides: []` on every head is dead payload in a widget: the
  // runtime reads the field absence-tolerantly (mount.ts `?? []`), so empty rows are
  // dropped from the embedded registry rather than shipped once per component.
  const components: Registry["components"] = {};
  for (const [name, component] of Object.entries(options.registry.components)) {
    if ((component.head?.overrides?.length ?? 0) > 0) { components[name] = component; continue; }
    const { overrides: _empty, ...head } = component.head;
    components[name] = { ...component, head: head as typeof component.head };
  }
  const payload = { ...options.registry, components };
  return [
    `import { defineDsxElement } from "@despia/element";`,
    ...(f.universalGlobals ? [
      `import { registerGlobalElements } from "@despia/dom/elements";`,
      `import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "@despia/dom/globals";`,
    ] : []),
    ...(f.controlElements ? [`import { CONTROL_ELEMENTS_CSS } from "@despia/dom/theme";`] : []),
    ...(f.formElements ? [
      `import { ELEMENTS } from "@despia/dom/elements";`,
      `import { FORM_ELEMENTS } from "@despia/dom/forms";`,
      `import { FORM_ELEMENTS_CSS } from "@despia/dom/theme";`,
    ] : []),
    ...(f.richElements ? [
      `import { registerRichElements } from "@despia/dom/elements";`,
      `import { RICH_ELEMENTS_CSS } from "@despia/dom/theme";`,
    ] : []),
    ...(f.nativeControls
      ? [`import { registerNativeControls, NATIVE_CONTROLS_CSS } from "@despia/dom/native-controls";`] : []),
    ...(motion ? [`import { registerElementMotion } from "@despia/dom/element-motion";`] : []),
    ...(f.structuralControls
      ? [`import { registerStructuralControls, STRUCTURAL_CONTROLS_CSS } from "@despia/dom/structural-controls";`] : []),
    ...(f.overlayControls
      ? [`import { registerOverlayControls, OVERLAY_CONTROLS_CSS } from "@despia/dom/overlay-controls";`] : []),
    ...(f.dataControls
      ? [`import { registerDataControls, DATA_CONTROLS_CSS } from "@despia/dom/data-controls";`] : []),
    ...(playback ? [`import { ${[
      ...(audioSurface ? ["registerAudioSurface"] : []),
      ...(videoSurface ? ["registerVideoSurface"] : []),
      "MEDIA_PLAYBACK_CSS",
    ].join(", ")} } from "@despia/dom/media-surfaces";`] : []),
    ...(options.facetSrc !== undefined ? [`import facet from ${JSON.stringify(options.facetSrc)};`] : []),
    `const registry = JSON.parse(${JSON.stringify(JSON.stringify(payload))});`,
    ...(withOptionalCss ? [`registry.css = [${[
      ...(f.controlElements ? ["CONTROL_ELEMENTS_CSS"] : []),
      ...(f.formElements ? ["FORM_ELEMENTS_CSS"] : []),
      ...(f.richElements ? ["RICH_ELEMENTS_CSS"] : []),
      ...(f.nativeControls ? ["NATIVE_CONTROLS_CSS"] : []),
      ...(f.structuralControls ? ["STRUCTURAL_CONTROLS_CSS"] : []),
      ...(f.overlayControls ? ["OVERLAY_CONTROLS_CSS"] : []),
      ...(f.dataControls ? ["DATA_CONTROLS_CSS"] : []),
      ...(playback ? ["MEDIA_PLAYBACK_CSS"] : []),
      ...(f.universalGlobals ? ["GLOBAL_ELEMENTS_CSS"] : []),
      "registry.css",
    ].join(", ")}].join("\\n");`] : []),
    ...(f.universalGlobals ? [`registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);`] : []),
    ...(f.formElements ? [`Object.assign(ELEMENTS, FORM_ELEMENTS);`] : []),
    ...(f.richElements ? [`registerRichElements();`] : []),
    ...(f.nativeControls ? [`registerNativeControls();`] : []),
    ...(motion ? [`registerElementMotion();`] : []),
    ...(f.structuralControls ? [`registerStructuralControls();`] : []),
    ...(f.overlayControls ? [`registerOverlayControls();`] : []),
    ...(f.dataControls ? [`registerDataControls();`] : []),
    ...(audioSurface ? [`registerAudioSurface();`] : []),
    ...(videoSurface ? [`registerVideoSurface();`] : []),
    `defineDsxElement({ tag: ${JSON.stringify(options.tag)}, component: ${JSON.stringify(options.component)}, registry${options.facetSrc !== undefined ? ", modules: [facet]" : ""} });`,
    "",
  ].join("\n");
}

/** Every `__DSX_OPTIONAL_*` fold an embed build sets, in ONE place. The map used to be
 *  hand-written at each call site — the demo builder and three test harnesses — and two of
 *  those copies had already drifted a fold behind, so the same slice measured one size in
 *  the gate and another in the build. Adding a fold is now a single edit here, and a gate
 *  cannot go green on a bundle the builder would ship differently. */
export type EmbedFolds = {
  apis: boolean; webmcp: boolean; globals: boolean; rich: boolean; icons: boolean;
  boundCollections: boolean; surfaces: boolean; pressed: boolean; role: boolean;
  classFormulas: boolean; theme: boolean; density: boolean; disabled: boolean;
  desktopInput: boolean; declaredInput: boolean; gestures: boolean; scaffold: boolean;
  staticElements: boolean; controls: boolean; controlMetrics: boolean; markdown: boolean;
  jsGlobals: boolean; fetch: boolean; regex: boolean; highlight: boolean; canvasZoom: boolean;
  blockIteration: boolean; styleFormulas: boolean; styleOverrides: boolean;
  buttonVariants: boolean; spring: boolean;
};

/** The fold names, enumerable at runtime so a gate can prove the builder sets every one. */
export const EMBED_FOLD_KEYS: readonly (keyof EmbedFolds)[] = [
  "apis", "webmcp", "globals", "rich", "icons", "boundCollections", "surfaces", "pressed",
  "role", "classFormulas", "theme", "density", "controlMetrics", "disabled", "desktopInput",
  "declaredInput", "gestures", "scaffold", "staticElements", "controls", "markdown",
  "jsGlobals", "fetch", "regex", "highlight", "canvasZoom", "blockIteration",
  "styleFormulas", "styleOverrides", "buttonVariants", "spring",
];

export function embedDefines(folds: Partial<EmbedFolds> = {}): Record<string, string> {
  const on = (key: keyof EmbedFolds): string => (folds[key] ? "true" : "false");
  return {
    // A self-contained embed is mounted by a host page, not by a DSX app boot, so nothing
    // ever installs a link transport into it — the route walk and its unreachable mapping
    // are dead weight in every widget. (The link seam itself was already tree-shaken; what
    // shipped was the dispatch rungs in bus.ts, which no seam can remove.)
    "globalThis.__DSX_OPTIONAL_LINK__": "false",
    // embeds replace-mount on upgrade by design (/web/13 v1) — the adopt walk
    // and its instantiate seam are app-boot machinery, never embed payload.
    "globalThis.__DSX_OPTIONAL_ADOPT__": "false",
    // a sliced widget is never edited in place — the P5 editability stamps shed
    "globalThis.__DSX_OPTIONAL_EDIT_TAGS__": "false",
    // the src-origin gate belongs to a Studio app mount (studio-apps.md §8); an embed
    // has no such mount, so the gate and its policy map shed with it
    "globalThis.__DSX_OPTIONAL_APPSCOPE__": "false",
    "globalThis.__DSX_OPTIONAL_STRINGS__": "false",
    "globalThis.__DSX_OPTIONAL_APIS__": on("apis"),
    "globalThis.__DSX_OPTIONAL_WEBMCP__": on("webmcp"),
    "globalThis.__DSX_OPTIONAL_GLOBALS__": on("globals"),
    "globalThis.__DSX_OPTIONAL_RICH__": on("rich"),
    "globalThis.__DSX_OPTIONAL_ICONS__": on("icons"),
    "globalThis.__DSX_OPTIONAL_BOUND_COLLECTIONS__": on("boundCollections"),
    "globalThis.__DSX_OPTIONAL_SURFACES__": on("surfaces"),
    "globalThis.__DSX_OPTIONAL_PRESSED__": on("pressed"),
    "globalThis.__DSX_OPTIONAL_ROLE__": on("role"),
    "globalThis.__DSX_OPTIONAL_CLASS_FORMULAS__": on("classFormulas"),
    "globalThis.__DSX_OPTIONAL_THEME__": on("theme"),
    "globalThis.__DSX_OPTIONAL_DENSITY__": on("density"),
    "globalThis.__DSX_OPTIONAL_CONTROL_METRICS__": on("controlMetrics"),
    "globalThis.__DSX_OPTIONAL_DISABLED__": on("disabled"),
    "globalThis.__DSX_OPTIONAL_DESKTOP_INPUT__": on("desktopInput"),
    "globalThis.__DSX_OPTIONAL_INPUT__": on("declaredInput"),
    "globalThis.__DSX_OPTIONAL_GESTURES__": on("gestures"),
    "globalThis.__DSX_OPTIONAL_SCAFFOLD__": on("scaffold"),
    "globalThis.__DSX_OPTIONAL_STATIC_ELEMENTS__": on("staticElements"),
    "globalThis.__DSX_OPTIONAL_CONTROLS__": on("controls"),
    "globalThis.__DSX_OPTIONAL_MARKDOWN__": on("markdown"),
    "globalThis.__DSX_OPTIONAL_JS_GLOBALS__": on("jsGlobals"),
    "globalThis.__DSX_OPTIONAL_FETCH__": on("fetch"),
    "globalThis.__DSX_OPTIONAL_REGEX__": on("regex"),
    "globalThis.__DSX_OPTIONAL_HIGHLIGHT__": on("highlight"),
    "globalThis.__DSX_OPTIONAL_CANVAS_ZOOM__": on("canvasZoom"),
    "globalThis.__DSX_OPTIONAL_BLOCK_ITERATION__": on("blockIteration"),
    "globalThis.__DSX_OPTIONAL_STYLE_FORMULAS__": on("styleFormulas"),
    "globalThis.__DSX_OPTIONAL_STYLE_OVERRIDES__": on("styleOverrides"),
    "globalThis.__DSX_OPTIONAL_BUTTON_VARIANTS__": on("buttonVariants"),
    "globalThis.__DSX_OPTIONAL_SPRING__": on("spring"),
  };
}

/** The density plane's toggle / slider / field / textarea metrics (theme.ts
 *  CONTROL_METRICS_CSS): read only by the control sheets, so a slice that imports none of
 *  them folds 28 token declarations. Universal globals count — their toggle factory reads
 *  the same metrics — and so does a sheet that names one of the tokens by hand. */
export function registryUsesControlMetrics(registry: Registry, features: EmbedEntryFeatures): boolean {
  return features.controlElements || features.formElements || features.nativeControls
    || features.structuralControls || features.overlayControls || features.dataControls
    || features.universalGlobals
    || ["--dsx-toggle-", "--dsx-slider-", "--dsx-field-density", "--dsx-textarea-density"]
      .some((token) => registryMentions(registry, token));
}
