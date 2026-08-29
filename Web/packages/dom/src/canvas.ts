//
//  canvas.ts - the web `<canvas>` element (parity/U04-canvas.md): the 2-D drawing surface.
//  Every NUMBER lives in the platform-neutral kernel (@despia-native/kernel canvas-core.ts - corpus
//  OpenSource/Conformance/canvas/); this module only owns the browser adapter: a real
//  `<canvas>` 2D context, the retained tier-1 repaint, the tier-2 command replay, the
//  display-linked `on:frame` loop under the kernel's 60/s budget, and the declared
//  accessibility overlay. Zero dependencies, no WebGL, no Skia - the deliberate §3d decision.
//
//  TIER 1 is RETAINED: the child tree is a display list, the kernel diffs it by key, and a
//  repaint is scheduled only when a bound attribute actually changed. TIER 2 is IMMEDIATE: a
//  `commands` list is replayed over the whole surface, tier 1 painting first (the corpus pins
//  the ordering). Mixing the two in one canvas is allowed and is the `<signature>` shape:
//  declarative chrome underneath, the live stroke on top.
//
//  TIER 2 IS A COMMAND LIST, NOT A LIVE `ctx` OBJECT. The corpus models it that way
//  (`tier2.json` `script` is an array of arrays) and the handler payload seam carries DATA,
//  not live handles - so the author builds commands and the renderer replays them through the
//  SAME kernel recorder all three renderers run. `on:draw` fires before each replay so an
//  author can refresh the list; it is a notification, never a mutable graphics handle.
//
//  SSR: `canvasSvgMarkup` serialises the tier-1 tree to SVG so a server-rendered page shows
//  the drawing before hydration; the client paints the identical display list onto the canvas
//  and drops the SVG in the same frame, so there is no repaint flash.
//

import {
  buildCanvasDisplayList, canvasToSvg, canvasA11y, canvasGradientT, sampleCanvasStops,
  runCanvasScript, CanvasFrameLoop, number,
  INK_LINECAP, INK_LINEJOIN, INK_STROKE_WIDTH, decodeInk, encodeInk, inkFarEnough, inkNodes,
  inkOps, inkPoint, type InkPoint,
  type CanvasMarkupNode, type CanvasOp, type CanvasSegment, type CanvasPaint,
  type CanvasMatrix, type CanvasGradient, type CanvasEffect, type CanvasCommand,
} from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
import { ELEMENTS, type ElementApi } from "./elements.ts";

/* Surfaces waiting to hear that an ancestor's transform moved. ONE window listener for the
   whole document, and entries whose host has left the tree are dropped as the event passes -
   the element contract has no teardown hook, so the registry has to heal itself rather than
   hold a detached node alive. */
const TRANSFORM_WATCH = new Set<{ host: HTMLElement; run: () => void }>();
let transformBound = false;

function watchTransform(host: HTMLElement, run: () => void): void {
  TRANSFORM_WATCH.add({ host, run });
  if (transformBound || typeof window === "undefined") return;
  transformBound = true;
  window.addEventListener("dsx:transform", (event: Event) => {
    const from = (event as CustomEvent<{ el?: Element }>).detail?.el;
    for (const entry of TRANSFORM_WATCH) {
      if (!entry.host.isConnected) { TRANSFORM_WATCH.delete(entry); continue; }
      if (from !== undefined && from !== entry.host && !from.contains(entry.host)) continue;
      entry.run();
    }
  });
}
import { hasGestureFamily, wireGestureFamily } from "./gestures.ts";
import type { MountCtx } from "./mount.ts";

/** the drawing tags a canvas child may be; anything else is the kernel's one diagnostic */
const DRAWING_TAGS = new Set([
  "path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "text", "image",
  "group", "blur", "shadow", "blend", "gradient", "stop",
  // `<ink>` is a drawing child AND the surface's pointer capture (canvas/ink.json): its
  // COMMITTED strokes expand to ordinary stroked paths, so the display list, the diff and
  // the SVG serialisation treat it like authored geometry; only the in-flight stroke is
  // transient paint, and it never round-trips the store.
  "ink",
]);

/** the tier-1 attributes that carry a value we must re-resolve when the store publishes */
type BoundNode = { node: XmlNode; attrs: { [name: string]: unknown }; children: BoundNode[] };

function inkStroke(bound: BoundNode): string {
  const paint = bound.attrs["stroke"];
  const text = typeof paint === "string" ? paint.trim() : "";
  return text.length > 0 ? text : "label";
}

/** A bound child becomes ONE markup node, except `<ink>`, which becomes one stroked path per
 *  committed stroke — in the surface's own pixel space, which is why the size is passed in. */
function expandMarkup(bound: BoundNode, width: number, height: number): CanvasMarkupNode[] {
  if (bound.node.tag === "ink") {
    return inkNodes(decodeInk(bound.attrs["bind"]), width, height, inkStroke(bound));
  }
  return [{
    kind: bound.node.tag,
    attrs: bound.attrs,
    children: bound.children.flatMap((child) => expandMarkup(child, width, height)),
  }];
}

function toMarkup(bound: BoundNode): CanvasMarkupNode {
  return {
    kind: bound.node.tag,
    attrs: bound.attrs,
    children: bound.children.map(toMarkup),
  };
}

/** Resolve a css custom property to a concrete colour. A semantic token survives the kernel
 *  UNRESOLVED on purpose; the theme owns it, and the theme on the web is a variable. */
function tokenColor(element: HTMLElement, token: string): string {
  const property = CANVAS_TOKEN_PROPERTIES[token];
  if (property === undefined) return "transparent";
  const value = getComputedStyle(element).getPropertyValue(property).trim();
  return value === "" ? "currentColor" : value;
}

/** the same map the kernel serialiser uses for SSR, in the shape the canvas painter needs */
const CANVAS_TOKEN_PROPERTIES: { [word: string]: string } = {
  clear: "",
  label: "--dsx-label",
  text: "--dsx-label",
  secondary: "--dsx-secondary-label",
  secondaryLabel: "--dsx-secondary-label",
  tertiary: "--dsx-tertiary-label",
  tertiaryLabel: "--dsx-tertiary-label",
  quaternary: "--dsx-tertiary-label",
  accent: "--dsx-accent",
  destructive: "--dsx-destructive",
  separator: "--dsx-separator",
  fill: "--dsx-fill",
  fillFaint: "--dsx-fill",
  background: "--dsx-background",
  systemBackground: "--dsx-background",
  secondaryBackground: "--dsx-secondary-background",
  tertiaryBackground: "--dsx-tertiary-background",
  groupedBackground: "--dsx-grouped-background",
  secondaryGroupedBackground: "--dsx-secondary-grouped-background",
};

function cssRgba(rgba: readonly number[]): string {
  const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgba(${byte(rgba[0] ?? 0)}, ${byte(rgba[1] ?? 0)}, ${byte(rgba[2] ?? 0)}, ${rgba[3] ?? 1})`;
}

function gradientStyle(
  context: CanvasRenderingContext2D, host: HTMLElement, gradient: CanvasGradient,
): string | CanvasGradient2D {
  const g = gradient.geom;
  const stops = gradient.stops;
  if (stops.length === 0) return "transparent";
  // A token stop stays a theme colour: its `stop-opacity` already rode the kernel's
  // normalisation for rgba stops, and a custom property has no alpha channel to fold into.
  const colorAt = (index: number): string => {
    const stop = stops[index]!;
    return "rgba" in stop ? cssRgba(stop.rgba) : tokenColor(host, stop.token);
  };
  if (gradient.kind === "linear") {
    const paint = context.createLinearGradient(g[0] ?? 0, g[1] ?? 0, g[2] ?? 0, g[3] ?? 0);
    stops.forEach((stop, i) => paint.addColorStop(Math.min(1, Math.max(0, stop.offset)), colorAt(i)));
    return paint;
  }
  if (gradient.kind === "radial") {
    const paint = context.createRadialGradient(g[0] ?? 0, g[1] ?? 0, 0, g[0] ?? 0, g[1] ?? 0, g[2] ?? 0);
    stops.forEach((stop, i) => paint.addColorStop(Math.min(1, Math.max(0, stop.offset)), colorAt(i)));
    return paint;
  }
  // An angular sweep: browsers that ship createConicGradient get the real thing; the rest get
  // the kernel's own projection sampled into a radial approximation rather than nothing.
  const factory = (context as unknown as {
    createConicGradient?: (angle: number, x: number, y: number) => CanvasGradient2D;
  }).createConicGradient;
  if (typeof factory === "function") {
    const paint = factory.call(context, ((g[2] ?? 0) * Math.PI) / 180, g[0] ?? 0, g[1] ?? 0);
    stops.forEach((stop, i) => paint.addColorStop(Math.min(1, Math.max(0, stop.offset)), colorAt(i)));
    return paint;
  }
  const sampled = sampleCanvasStops(stops, canvasGradientT("angular", g, g[0] ?? 0, g[1] ?? 0));
  return sampled === null ? colorAt(0) : cssRgba(sampled);
}

type CanvasGradient2D = ReturnType<CanvasRenderingContext2D["createLinearGradient"]>;

function paintStyle(
  context: CanvasRenderingContext2D, host: HTMLElement,
  paint: CanvasPaint | null | undefined, gradients: { [id: string]: CanvasGradient },
): string | CanvasGradient2D | null {
  if (paint === null || paint === undefined) return null;
  if (paint.kind === "rgba") return cssRgba(paint.rgba);
  if (paint.kind === "token") return tokenColor(host, paint.token);
  const gradient = gradients[paint.id];
  return gradient === undefined ? null : gradientStyle(context, host, gradient);
}

function path2d(segments: readonly CanvasSegment[]): Path2D {
  const path = new Path2D();
  for (const seg of segments) {
    if (seg[0] === "M") path.moveTo(seg[1], seg[2]);
    else if (seg[0] === "L") path.lineTo(seg[1], seg[2]);
    else if (seg[0] === "Q") path.quadraticCurveTo(seg[1], seg[2], seg[3], seg[4]);
    else if (seg[0] === "C") path.bezierCurveTo(seg[1], seg[2], seg[3], seg[4], seg[5], seg[6]);
    else path.closePath();
  }
  return path;
}

function setMatrix(context: CanvasRenderingContext2D, scale: number, m: CanvasMatrix): void {
  context.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3],
                       scale * m[4], scale * m[5]);
}

function applyEffects(
  context: CanvasRenderingContext2D, host: HTMLElement, effects: readonly CanvasEffect[],
): void {
  const filters: string[] = [];
  for (const effect of effects) {
    if (effect.kind === "blur") {
      filters.push(`blur(${effect.radius / 2}px)`);
    } else if (effect.kind === "shadow") {
      context.shadowOffsetX = effect.dx;
      context.shadowOffsetY = effect.dy;
      context.shadowBlur = effect.radius;
      const color = effect.color.kind === "rgba" ? cssRgba(effect.color.rgba)
        : effect.color.kind === "token" ? tokenColor(host, effect.color.token) : "transparent";
      context.shadowColor = color;
    } else {
      context.globalCompositeOperation = effect.mode as GlobalCompositeOperation;
    }
  }
  if (filters.length > 0) context.filter = filters.join(" ");
}

/** paint one display-list op. The matrix rides beside the path, so a transform animation
 *  repaints the same geometry under a new CTM - the retained-mode promise. */
function paintOp(
  context: CanvasRenderingContext2D, host: HTMLElement, scale: number,
  op: CanvasOp, gradients: { [id: string]: CanvasGradient },
): void {
  context.save();
  context.globalAlpha = op.opacity;
  applyEffects(context, host, op.effects ?? []);
  if (op.clip !== undefined) {
    setMatrix(context, scale, op.clip.transform);
    context.clip(path2d(op.clip.path));
  }
  setMatrix(context, scale, op.transform);
  if (op.kind === "text") {
    context.font = `${op.fontSize ?? 16}px var(--dsx-font, system-ui)`;
    context.textAlign = (op.textAnchor === "middle" ? "center"
      : op.textAnchor === "end" ? "right" : "left") as CanvasTextAlign;
    const fill = paintStyle(context, host, op.fill, gradients);
    if (fill !== null) {
      context.fillStyle = fill;
      context.fillText(op.text ?? "", op.x ?? 0, op.y ?? 0);
    }
  } else if (op.kind === "image") {
    const image = imageFor(op.src ?? "", () => host.dispatchEvent(new CustomEvent("dsx-canvas-repaint")));
    if (image !== null && image.complete && image.naturalWidth > 0) {
      const w = op.width ?? image.naturalWidth;
      const h = op.height ?? image.naturalHeight;
      context.drawImage(image, op.x ?? 0, op.y ?? 0, w, h);
    }
  } else {
    const path = path2d(op.path ?? []);
    const fill = paintStyle(context, host, op.fill, gradients);
    if (fill !== null) {
      context.fillStyle = fill;
      context.fill(path, (op.fillRule ?? "nonzero") as CanvasFillRule);
    }
    const stroke = paintStyle(context, host, op.stroke, gradients);
    if (stroke !== null) {
      context.strokeStyle = stroke;
      context.lineWidth = op.strokeWidth ?? 1;
      context.lineCap = (op.strokeLinecap ?? "butt") as CanvasLineCap;
      context.lineJoin = (op.strokeLinejoin ?? "miter") as CanvasLineJoin;
      context.stroke(path);
    }
  }
  context.restore();
}

/** one shared decode cache: a repeated `<image src>` across repaints must not re-fetch */
const IMAGE_CACHE = new Map<string, HTMLImageElement>();

function imageFor(src: string, onLoad: () => void): HTMLImageElement | null {
  if (src === "") return null;
  const cached = IMAGE_CACHE.get(src);
  if (cached !== undefined) return cached;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.addEventListener("load", onLoad, { once: true });
  image.src = src;
  IMAGE_CACHE.set(src, image);
  return image;
}

/** replay a tier-2 command list: the kernel recorder folds it to the SAME draw stream the
 *  Kotlin and Swift renderers replay, so the picture is one contract, not three */
function replayCommands(
  context: CanvasRenderingContext2D, host: HTMLElement, scale: number,
  commands: readonly CanvasCommand[], width: number, height: number,
): void {
  const result = runCanvasScript(commands);
  for (const entry of result.log) {
    context.save();
    context.globalAlpha = entry.alpha;
    // The recorder has already baked the CTM into every path point, so the surface stays in
    // device space and only the raster scale applies.
    context.setTransform(scale, 0, 0, scale, 0, 0);
    if (entry.clip !== undefined) {
      context.clip(path2d(entry.clip.path), entry.clip.rule as CanvasFillRule);
    }
    if (entry.shadow !== undefined) {
      context.shadowOffsetX = entry.shadow.dx;
      context.shadowOffsetY = entry.shadow.dy;
      context.shadowBlur = entry.shadow.radius;
      context.shadowColor = entry.shadow.color.kind === "rgba"
        ? cssRgba(entry.shadow.color.rgba) : tokenColor(host, "label");
    }
    if (entry.blend !== undefined) {
      context.globalCompositeOperation = entry.blend as GlobalCompositeOperation;
    }
    const style = paintStyle(context, host, entry.style, {});
    if (entry.op === "fill" && style !== null) {
      context.fillStyle = style;
      context.fill(path2d(entry.path ?? []), (entry.rule ?? "nonzero") as CanvasFillRule);
    } else if (entry.op === "stroke" && style !== null) {
      context.strokeStyle = style;
      context.lineWidth = entry.lineWidth ?? 1;
      context.lineCap = (entry.cap ?? "butt") as CanvasLineCap;
      context.lineJoin = (entry.join ?? "miter") as CanvasLineJoin;
      context.stroke(path2d(entry.path ?? []));
    } else if (entry.op === "clear") {
      const rect = entry.rect ?? null;
      if (rect === null) context.clearRect(0, 0, width, height);
      else context.clearRect(rect[0], rect[1], rect[2], rect[3]);
    } else if (entry.op === "drawImage") {
      const image = imageFor(entry.src ?? "", () => host.dispatchEvent(new CustomEvent("dsx-canvas-repaint")));
      if (image !== null && image.complete && image.naturalWidth > 0) {
        context.drawImage(image, entry.x ?? 0, entry.y ?? 0,
                          entry.width ?? image.naturalWidth, entry.height ?? image.naturalHeight);
      }
    } else if ((entry.op === "fillText" || entry.op === "strokeText") && style !== null) {
      context.font = `${entry.fontSize ?? 10}px var(--dsx-font, system-ui)`;
      if (entry.op === "fillText") {
        context.fillStyle = style;
        context.fillText(entry.text ?? "", entry.x ?? 0, entry.y ?? 0);
      } else {
        context.strokeStyle = style;
        context.lineWidth = entry.lineWidth ?? 1;
        context.strokeText(entry.text ?? "", entry.x ?? 0, entry.y ?? 0);
      }
    }
    context.restore();
  }
}

/** The SSR half: the same display list, serialised. Exported so the server package can put a
 *  real picture in the first byte instead of an empty box. */
export function canvasSvgMarkup(tree: readonly CanvasMarkupNode[], width: number, height: number): string {
  return canvasToSvg(buildCanvasDisplayList(tree), width, height);
}

/** Author-supplied drawing commands arrive as plain JSE data, so the tuple shape is VERIFIED
 *  once at the boundary rather than asserted: a command is a non-empty array whose head is the
 *  method name. Anything else never reaches the recorder. */
function isCanvasCommand(row: unknown): row is CanvasCommand {
  return Array.isArray(row) && row.length > 0 && typeof row[0] === "string";
}

function readCommands(value: unknown): CanvasCommand[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).filter(isCanvasCommand);
}

function readA11yChildren(value: unknown): { role?: string; label?: string; value?: string | null }[] {
  if (!Array.isArray(value)) return [];
  const out: { role?: string; label?: string; value?: string | null }[] = [];
  for (const row of value) {
    if (row === null || typeof row !== "object") continue;
    const record = row as { [k: string]: unknown };
    out.push({
      role: record["role"] === undefined ? undefined : String(record["role"]),
      label: record["label"] === undefined ? undefined : String(record["label"]),
      value: record["value"] === undefined || record["value"] === null
        ? null : String(record["value"]),
    });
  }
  return out;
}

function canvasFactory(node: XmlNode, _ctx: MountCtx, api: ElementApi): HTMLElement {
  const host = document.createElement("div");
  host.className = "dsx-canvas";
  const surface = document.createElement("canvas");
  surface.className = "dsx-canvas-surface";
  host.appendChild(surface);

  const attrs: { [name: string]: unknown } = {};
  for (const [name, value] of Object.entries(node.attrs)) attrs[name] = value;

  let commands: CanvasCommand[] = [];
  let a11yChildren: { role?: string; label?: string; value?: string | null }[] = [];
  let frame = 0;

  // THE IN-FLIGHT STROKE. It lives here, in view state, and is painted on top of the display
  // list — never written to the store, which is the whole point of the primitive: a moved
  // finger must not rebuild a display list. The store is written ONCE, on pointer-up.
  let live: InkPoint[] = [];

  const schedule = (): void => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };

  // Tier-1 children: every interpolatable attribute rides the SAME reactive read every other
  // element attribute uses, and a change schedules one coalesced repaint.
  const bind = (source: XmlNode): BoundNode => {
    const bound: BoundNode = { node: source, attrs: {}, children: [] };
    for (const [name, expression] of Object.entries(source.attrs)) {
      bound.attrs[name] = expression;
      // `<ink bind>` carries a stroke LIST, not text: read the value plane, exactly as the
      // canvas already does for `commands` and `a11yChildren`.
      if (source.tag === "ink" && name === "bind") {
        api.bindValue(expression, (value) => {
          bound.attrs[name] = value;
          schedule();
        });
        continue;
      }
      api.bindText(expression, (value) => {
        bound.attrs[name] = value;
        schedule();
      });
    }
    for (const child of source.children) {
      if (!DRAWING_TAGS.has(child.tag)) {
        // The kernel owns the diagnostic; a non-drawing child still reaches it so the count
        // matches the corpus on every renderer.
        bound.children.push({ node: child, attrs: { ...child.attrs }, children: [] });
        continue;
      }
      bound.children.push(bind(child));
    }
    return bound;
  };

  const inkChild = (): BoundNode | undefined =>
    root.children.find((child) => child.node.tag === "ink");

  const paintLiveStroke = (
    context: CanvasRenderingContext2D, scale: number, width: number, height: number,
  ): void => {
    const ink = inkChild();
    if (ink === undefined || live.length === 0) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.beginPath();
    for (const step of inkOps(live, width, height)) {
      if (step.op === "Q") context.quadraticCurveTo(step.cx, step.cy, step.x, step.y);
      else if (step.op === "M") context.moveTo(step.x, step.y);
      else context.lineTo(step.x, step.y);
    }
    context.lineCap = INK_LINECAP;
    context.lineJoin = INK_LINEJOIN;
    context.lineWidth = number(ink.attrs["strokeWidth"]) ?? INK_STROKE_WIDTH;
    context.strokeStyle = tokenColor(host, inkStroke(ink));
    context.stroke();
  };

  const root: BoundNode = { node, attrs, children: [] };
  for (const [name, expression] of Object.entries(node.attrs)) {
    api.bindText(expression, (value) => {
      attrs[name] = value;
      if (name === "a11yLabel") applySemantics();
      schedule();
    });
  }
  for (const child of node.children) root.children.push(bind(child));

  /* THE SURFACE IS SIZED FROM THE LAYOUT BOX, AND RASTERISED FOR WHERE IT LANDS.
     Two different questions, and conflating them is how a canvas inside a zoomable world
     drew itself at a fraction of its own size. `getBoundingClientRect()` reports the
     COMPOSITED rect - every ancestor `transform: scale()` folded in - so a canvas under a
     world at 0.53 asked for a 53% backing store, had its own CSS width overwritten with
     that shrunken number, and then received a display list authored in untransformed
     units. Everything past 53% of each axis fell off the bitmap: wires stopped short of
     their nodes and arrowheads, the last op in the list, were never drawn at all.
     `offsetWidth` is the layout box and is transform-independent, so it answers the size
     question; the ratio between the two answers the resolution question exactly. */
  const cssScale = (): number => {
    const rect = host.getBoundingClientRect();
    const laid = host.offsetWidth;
    if (laid <= 0 || rect.width <= 0) return 1;
    const ratio = rect.width / laid;
    return ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
  };

  /* A ZOOM IS A REPAINT, and nothing used to say so. The backing store is sized for where
     the surface LANDS, so an ancestor `transform: scale()` changes the right answer - but a
     transform moves no layout box, so no ResizeObserver fires and the raster stayed at the
     scale of the last paint. Wires went soft the moment somebody zoomed and stayed soft
     until an unrelated edit happened to repaint them. The renderer KNEW the transform
     changed; it just told nobody. `dsx:transform` is that missing word. */
  const scaleWatch = (): void => {
    watchTransform(host, () => {
      if (Math.abs(cssScale() - paintedAt) > 0.001) schedule();
    });
  };
  let paintedAt = 1;

  const raster = (): number => {
    const requested = String(attrs["scale"] ?? "device");
    const device = requested === "1" ? 1 : requested === "2" ? 2
      : Math.max(1, window.devicePixelRatio || 1);
    // a wire in a world magnified 2x needs twice the samples, or it is an upscaled bitmap
    return Math.max(1, Math.min(8, device * cssScale()));
  };

  const paint = (): void => {
    // the LAYOUT box: what the author asked for, in the units the display list is in
    const width = Math.max(1, Math.round(host.offsetWidth || host.getBoundingClientRect().width));
    const height = Math.max(1, Math.round(host.offsetHeight || host.getBoundingClientRect().height || 0));
    const scale = raster();
    paintedAt = cssScale();
    const backingW = Math.max(1, Math.round(width * scale));
    const backingH = Math.max(1, Math.round(height * scale));
    if (surface.width !== backingW || surface.height !== backingH) {
      surface.width = backingW;
      surface.height = backingH;
      surface.style.width = `${width}px`;
      surface.style.height = `${height}px`;
      api.handler("layout", { width, height });
    }
    const opaque = String(attrs["opaque"] ?? "false") === "true";
    const context = surface.getContext("2d", { alpha: !opaque });
    if (context === null) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, surface.width, surface.height);
    const list = buildCanvasDisplayList(
      root.children.flatMap((child) => expandMarkup(child, width, height)),
    );
    for (const op of list.ops) paintOp(context, host, scale, op, list.gradients);
    if (api.hasHandler("draw")) api.handler("draw", { width, height });
    if (commands.length > 0) replayCommands(context, host, scale, commands, width, height);
    paintLiveStroke(context, scale, width, height);
  };

  scaleWatch();

  api.bindValue(node.attrs["commands"], (value) => {
    commands = readCommands(value);
    schedule();
  });
  api.bindValue(node.attrs["a11yChildren"], (value) => {
    a11yChildren = readA11yChildren(value);
    applySemantics();
  });

  function applySemantics(): void {
    const verdict = canvasA11y(attrs, a11yChildren);
    while (host.lastElementChild !== null && host.lastElementChild !== surface) {
      host.removeChild(host.lastElementChild);
    }
    if (verdict.hidden) {
      host.setAttribute("aria-hidden", "true");
      host.removeAttribute("role");
      host.removeAttribute("aria-label");
      return;
    }
    host.removeAttribute("aria-hidden");
    host.setAttribute("role", verdict.role === "button" ? "button" : verdict.role === "image" ? "img" : "group");
    if (verdict.label !== null) host.setAttribute("aria-label", verdict.label);
    else host.removeAttribute("aria-label");
    if (verdict.role === "button") host.tabIndex = 0;
    // The declared overlay: each child is a REAL accessibility element, positioned off the
    // painted surface but in the reading order the author declared (the accessible bar-chart
    // pattern). Screen readers walk a tree; a canvas has none, so this is the tree.
    for (const child of verdict.children) {
      const item = document.createElement("span");
      item.className = "dsx-canvas-a11y";
      item.setAttribute("role", child.role === "button" ? "button" : "img");
      item.setAttribute("aria-label", child.label);
      if (child.value !== null) item.setAttribute("aria-valuetext", child.value);
      host.appendChild(item);
    }
  }

  applySemantics();

  // POINTER CAPTURE. Installed only when the surface actually declares an editable `<ink>`
  // child, so an ordinary canvas keeps its pointer behaviour untouched.
  const ink = inkChild();
  if (ink !== undefined && String(ink.attrs["readOnly"] ?? "false") !== "true") {
    let pointer: number | null = null;
    const box = (): { w: number; h: number } => ({ w: surface.clientWidth, h: surface.clientHeight });
    const at = (event: PointerEvent): InkPoint => {
      const rect = surface.getBoundingClientRect();
      const { w, h } = box();
      return inkPoint(event.clientX - rect.left, event.clientY - rect.top, w, h);
    };
    surface.addEventListener("pointerdown", (event: PointerEvent) => {
      if (pointer !== null) return;
      pointer = event.pointerId;
      surface.setPointerCapture(event.pointerId);
      live = [at(event)];
      schedule();
      api.handler("strokeStart", { strokes: decodeInk(ink.attrs["bind"]).length });
      event.preventDefault();
    });
    surface.addEventListener("pointermove", (event: PointerEvent) => {
      if (pointer !== event.pointerId || live.length === 0) return;
      const { w, h } = box();
      const next = at(event);
      if (!inkFarEnough(live[live.length - 1]!, next, w, h)) return;
      live = [...live, next];
      schedule();
    });
    const finish = (event: PointerEvent): void => {
      if (pointer !== event.pointerId) return;
      pointer = null;
      if (live.length === 0) return;
      const width = number(ink.attrs["strokeWidth"]) ?? INK_STROKE_WIDTH;
      const committed = [...decodeInk(ink.attrs["bind"]), { points: live, width }];
      live = [];
      // One store write per stroke. The bound value then flows back through bindValue and the
      // stroke reappears as ordinary tier-1 geometry.
      api.writeBack(ink.node.attrs["bind"], encodeInk(committed));
      schedule();
      api.handler("strokeEnd", {
        strokes: committed.length,
        points: committed[committed.length - 1]!.points.length,
      });
    };
    surface.addEventListener("pointerup", finish);
    surface.addEventListener("pointercancel", finish);
    host.style.touchAction = "none";
  }

  if (hasGestureFamily(api)) wireGestureFamily(host, node, api);

  // The frame loop is the kernel's: installed only while a handler is bound AND the canvas is
  // mounted AND on screen. An always-running display link is a battery bug, and the corpus
  // asserts the install/uninstall counts.
  const loop = new CanvasFrameLoop(api.hasHandler("frame"));
  let rafId = 0;
  const pump = (nowMs: number): void => {
    if (!loop.installed) { rafId = 0; return; }
    const payload = loop.tick(nowMs);
    if (payload !== null) api.handler("frame", { ...payload });
    rafId = requestAnimationFrame(pump);
  };
  const settle = (): void => {
    if (loop.installed && rafId === 0) rafId = requestAnimationFrame(pump);
    if (!loop.installed && rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0; }
  };

  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) loop.setVisible(entry.isIntersecting);
        settle();
      })
    : null;
  const resize = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => schedule())
    : null;

  host.addEventListener("dsx-canvas-repaint", () => schedule());

  queueMicrotask(() => {
    loop.setMounted(host.isConnected);
    observer?.observe(host);
    resize?.observe(host);
    settle();
    paint();
  });

  return host;
}

export function registerCanvasSurface(): void {
  ELEMENTS["canvas"] = canvasFactory;
}

export const CANVAS_CSS = `@layer dsx-elements {
  .dsx-canvas {
    position: relative;
    display: block;
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 100%;
    block-size: 100%;
    overflow: hidden;
  }
  .dsx-canvas-surface {
    display: block;
    inline-size: 100%;
    block-size: 100%;
    touch-action: none;
  }
  .dsx-canvas-a11y {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}`;
