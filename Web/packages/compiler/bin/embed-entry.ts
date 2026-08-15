// Pure custom-element entry generation shared by build-demo and focused slicing
// tests. Conditional imports remain testable without a destructive demo build.

import type { Registry } from "../src/resolve.ts";
import type { XmlNode } from "../src/xml.ts";

const BOUND_COLLECTION_TAGS: ReadonlySet<string> = new Set(["list", "grid", "pager"]);
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
    `const registry = JSON.parse(${JSON.stringify(JSON.stringify(options.registry))});`,
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
