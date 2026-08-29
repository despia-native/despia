//
//  globals.ts - optional web twins for DSX's universal native global components.
//  Full apps install this set from boot.ts. Self-contained embeds only import it when
//  their transitive component slice uses one of these tags, so unused UI never taxes
//  the 40KB widget budget.
//

import {
  INK_STROKE_WIDTH, decodeInk, encodeInk,
  number, inkFarEnough, inkOps, inkPoint, truthy,
  type InkPoint, type InkStroke,
} from "@despia-native/kernel";
import { mapStyleValue } from "@despia-native/compiler/cssmap";
import type { ElementFactory } from "./elements.ts";

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

function componentColor(value: string | undefined, fallback: string): string {
  return mapStyleValue("color", value ?? fallback);
}

const checkbox: ElementFactory = (node, _ctx, api) => {
  const label = el("label", "dsx-checkbox");
  label.setAttribute("data-dsx-component", "checkbox");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("data-dsx-part", "input");
  const box = el("span", "dsx-checkbox-box");
  box.setAttribute("aria-hidden", "true");
  box.setAttribute("data-dsx-part", "indicator");
  const caption = el("span", "dsx-checkbox-label");
  caption.setAttribute("data-dsx-part", "label");
  label.append(input, box, caption);
  if (node.attrs["color"] !== undefined) {
    api.bindText(node.attrs["color"], (value) => {
      label.style.setProperty("--dsx-checkbox-color", componentColor(value, "accent"));
    });
  }
  if (node.attrs["label"] !== undefined) {
    api.bindText(node.attrs["label"], (value) => { caption.textContent = value; });
  }
  api.bindValue(node.attrs["bind"], (value) => { input.checked = truthy(value); });
  input.addEventListener("change", () => {
    api.writeBack(node.attrs["bind"], input.checked);
    api.handler("change", { value: input.checked });
  });
  // disabled= / disabled-if= (the W9 grammar wave): the real input carries the state,
  // so the sheet's input:disabled discipline and focusability follow natively.
  let declaredDisabled = false;
  let conditionalDisabled = false;
  const reflectDisabled = (): void => { input.disabled = declaredDisabled || conditionalDisabled; };
  if (node.attrs["disabled"] !== undefined) {
    api.bindText(node.attrs["disabled"], (value) => { declaredDisabled = truthy(value); reflectDisabled(); });
  }
  if (node.attrs["disabled-if"] !== undefined) {
    api.bindValue(node.attrs["disabled-if"], (value) => { conditionalDisabled = truthy(value); reflectDisabled(); });
  }
  return label;
};

const progressRing: ElementFactory = (node, _ctx, api) => {
  const size = Math.max(1, number(node.attrs["size"] ?? "88") ?? 88);
  const line = Math.max(1, number(node.attrs["lineWidth"] ?? "10") ?? 10);
  const radius = Math.max(1, 50 - (line / 2));
  const circumference = 2 * Math.PI * radius;
  const wrap = el("div", "dsx-progress-ring");
  wrap.setAttribute("role", "progressbar");
  wrap.setAttribute("aria-valuemin", "0");
  wrap.setAttribute("aria-valuemax", "1");
  wrap.setAttribute("aria-label", node.attrs["a11yLabel"] ?? "Progress");
  if (node.attrs["size"] !== undefined) wrap.style.setProperty("--dsx-ring-size", `${size}px`);
  if (node.attrs["trackColor"] !== undefined) {
    wrap.style.setProperty("--dsx-ring-track", componentColor(node.attrs["trackColor"], "fill"));
  }
  if (node.attrs["color"] !== undefined) {
    wrap.style.setProperty("--dsx-ring-color", componentColor(node.attrs["color"], "accent"));
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  const arc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const circle of [track, arc]) {
    circle.setAttribute("cx", "50");
    circle.setAttribute("cy", "50");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke-width", String(line));
  }
  track.setAttribute("stroke", "var(--dsx-ring-track)");
  arc.setAttribute("class", "dsx-progress-ring-arc");
  arc.setAttribute("stroke", "var(--dsx-ring-color)");
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", String(circumference));
  svg.append(track, arc);
  const label = el("span", "dsx-progress-ring-label");
  if (node.attrs["label"] !== undefined) {
    api.bindText(node.attrs["label"], (value) => {
      label.textContent = value;
      if (node.attrs["a11yLabel"] === undefined) wrap.setAttribute("aria-label", value);
    });
  }
  wrap.append(svg, label);

  let current = 0;
  let maximum = number(node.attrs["max"] ?? "1") ?? 1;
  const render = (): void => {
    const ratio = maximum === 0 ? 0 : current / maximum;
    const fraction = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
    arc.setAttribute("stroke-dashoffset", String(circumference * (1 - fraction)));
    wrap.setAttribute("aria-valuenow", String(fraction));
  };
  const bindNumber = (expr: string | undefined, apply: (value: number) => void): void => {
    if (expr === undefined) return;
    if (expr.includes("{{")) {
      api.bindText(expr, (value) => { apply(number(value) ?? 0); render(); });
    } else {
      api.bindValue(expr, (value) => { apply(number(value) ?? 0); render(); });
    }
  };
  bindNumber(node.attrs["bind"] ?? node.attrs["value"], (value) => { current = value; });
  if (node.attrs["max"]?.includes("{{")) {
    bindNumber(node.attrs["max"], (value) => { maximum = value; });
  }
  render();
  return wrap;
};

const skeleton: ElementFactory = (node) => {
  const block = el("div", "dsx-skeleton");
  block.setAttribute("aria-hidden", "true");
  if (node.attrs["height"] !== undefined) {
    block.style.setProperty("--dsx-skeleton-height", `${Math.max(1, number(node.attrs["height"]) ?? 14)}px`);
  }
  if (node.attrs["radius"] !== undefined) {
    block.style.setProperty("--dsx-skeleton-radius", `${Math.max(0, number(node.attrs["radius"]) ?? 8)}px`);
  }
  return block;
};

const chatBubble: ElementFactory = (node, _ctx, api) => {
  const right = node.attrs["side"] === "right";
  const wrap = el("div", `dsx-chat-bubble ${right ? "dsx-chat-right" : "dsx-chat-left"}`);
  if (node.attrs["color"] !== undefined) {
    wrap.style.setProperty("--dsx-chat-color", componentColor(node.attrs["color"], right ? "accent" : "fill"));
  }
  if (node.attrs["maxWidth"] !== undefined) {
    wrap.style.setProperty("--dsx-chat-max", `${Math.max(1, number(node.attrs["maxWidth"]) ?? 280)}px`);
  }
  const body = el("div", "dsx-chat-bubble-body");
  if (node.attrs["value"] !== undefined) {
    const value = el("span", "dsx-chat-bubble-value");
    api.bindText(node.attrs["value"], (text) => { value.textContent = text; });
    body.appendChild(value);
  }
  api.children(body);
  wrap.appendChild(body);
  return wrap;
};

const accordion: ElementFactory = (node, _ctx, api) => {
  const wrap = el("div", "dsx-accordion");
  const header = el("button", "dsx-accordion-header") as HTMLButtonElement;
  header.type = "button";
  // Accordion.swift:16-18 — a named "header" slot REPLACES the default Text(title) +
  // chevron; the remaining children are the collapsible body. `slot=` is a renderer
  // word, so the split is on the CHILD NODES, not on a second mount pass.
  const headerNodes = node.children.filter((c) => (c.attrs["slot"] ?? "") === "header");
  const bodyNodes = node.children.filter((c) => (c.attrs["slot"] ?? "") !== "header");
  if (headerNodes.length > 0) {
    header.setAttribute("data-dsx-part", "header");
    api.children(header, headerNodes);
  } else {
    const title = el("span", "dsx-accordion-title");
    api.bindText(node.attrs["title"] ?? "", (value) => { title.textContent = value; });
    const chevron = el("span", "dsx-accordion-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";
    if (node.attrs["color"] !== undefined) {
      chevron.style.setProperty("color", componentColor(node.attrs["color"], "accent"));
    }
    header.append(title, chevron);
  }
  const body = el("div", "dsx-accordion-body");
  api.children(body, bodyNodes);
  let open = truthy(node.attrs["open"] ?? false);
  const render = (): void => {
    header.setAttribute("aria-expanded", String(open));
    body.setAttribute("aria-hidden", String(!open));
    body.toggleAttribute("inert", !open);
    wrap.classList.toggle("dsx-accordion-open", open);
  };
  header.addEventListener("click", () => {
    open = !open;
    render();
    api.handler("toggle", { open });
  });
  wrap.append(header, body);
  render();
  return wrap;
};

const signature: ElementFactory = (node, _ctx, api) => {
  const wrap = el("div", "dsx-signature");
  const canvas = document.createElement("canvas");
  canvas.className = "dsx-signature-canvas";
  const hint = el("span", "dsx-signature-placeholder");
  hint.setAttribute("data-dsx-part", "placeholder");
  wrap.append(canvas, hint);
  wrap.setAttribute("role", "img");

  let strokes: InkStroke[] = [];
  let live: InkPoint[] = [];
  let width = INK_STROKE_WIDTH;
  let readOnly = false;
  let label = "Signature";

  const box = (): { w: number; h: number } => ({ w: canvas.clientWidth, h: canvas.clientHeight });

  const paint = (): void => {
    const { w, h } = box();
    const ratio = globalThis.devicePixelRatio ?? 1;
    if (w <= 0 || h <= 0) return;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    const ctx2d = canvas.getContext("2d");
    if (ctx2d === null) return;
    ctx2d.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.lineCap = "round";
    ctx2d.lineJoin = "round";
    ctx2d.strokeStyle = getComputedStyle(wrap).getPropertyValue("--dsx-signature-ink").trim()
      || "currentColor";
    const draw = (points: readonly InkPoint[], lineWidth: number): void => {
      ctx2d.beginPath();
      for (const step of inkOps(points, w, h)) {
        if (step.op === "Q") ctx2d.quadraticCurveTo(step.cx, step.cy, step.x, step.y);
        else if (step.op === "M") ctx2d.moveTo(step.x, step.y);
        else ctx2d.lineTo(step.x, step.y);
      }
      ctx2d.lineWidth = lineWidth;
      ctx2d.stroke();
    };
    for (const stroke of strokes) draw(stroke.points, stroke.width);
    if (live.length > 0) draw(live, width);
  };

  const reflectEmpty = (): void => {
    const empty = strokes.length === 0 && live.length === 0;
    wrap.classList.toggle("dsx-signature-empty", empty);
    wrap.setAttribute("aria-label", `${label}, ${empty ? "empty" : "signed"}`);
  };

  api.bindText(node.attrs["placeholder"] ?? "", (value) => {
    hint.textContent = value;
    label = node.attrs["a11yLabel"] ?? (value.length > 0 ? value : "Signature");
    reflectEmpty();
  });
  api.bindText(node.attrs["color"] ?? "", (value) => {
    wrap.style.setProperty("--dsx-signature-ink", componentColor(value, "label"));
    paint();
  });
  // The pad's own geometry lives in the SHEET (@layer dsx-elements below), which is what
  // check_renderer_constants diffs against the Kotlin and Swift twins. An authored attribute
  // overrides the rung; an absent one leaves the sheet's default standing.
  if (node.attrs["height"] !== undefined) {
    api.bindText(node.attrs["height"], (value) => {
      const parsed = number(value);
      if (parsed !== null && parsed !== undefined) {
        wrap.style.setProperty("--dsx-signature-height", `${parsed}px`);
      }
      paint();
    });
  }
  if (node.attrs["radius"] !== undefined) {
    api.bindText(node.attrs["radius"], (value) => {
      const parsed = number(value);
      if (parsed !== null && parsed !== undefined) {
        wrap.style.setProperty("--dsx-signature-radius", `${parsed}px`);
      }
    });
  }
  api.bindText(node.attrs["strokeWidth"] ?? String(INK_STROKE_WIDTH), (value) => {
    const parsed = number(value);
    width = parsed === null || parsed === undefined ? INK_STROKE_WIDTH : parsed;
  });
  api.bindText(node.attrs["baseline"] ?? "true", (value) => {
    wrap.classList.toggle("dsx-signature-ruled", truthy(value));
  });
  api.bindText(node.attrs["readOnly"] ?? "false", (value) => { readOnly = truthy(value); });
  // The bound value is the ONLY channel: an author clearing (`sig = []`) or undoing
  // (`sig.slice(0, sig.length - 1)`) lands here, exactly like a remote value arriving.
  api.bindValue(node.attrs["bind"], (value) => {
    strokes = decodeInk(value);
    reflectEmpty();
    paint();
  });

  let pointer: number | null = null;
  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    if (readOnly || pointer !== null) return;
    const { w, h } = box();
    const rect = canvas.getBoundingClientRect();
    pointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    live = [inkPoint(event.clientX - rect.left, event.clientY - rect.top, w, h)];
    reflectEmpty();
    paint();
    api.handler("begin", { strokes: strokes.length });
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    if (pointer !== event.pointerId || live.length === 0) return;
    const { w, h } = box();
    const rect = canvas.getBoundingClientRect();
    const next = inkPoint(event.clientX - rect.left, event.clientY - rect.top, w, h);
    if (!inkFarEnough(live[live.length - 1]!, next, w, h)) return;
    live = [...live, next];
    paint();
  });
  const finish = (event: PointerEvent): void => {
    if (pointer !== event.pointerId) return;
    pointer = null;
    if (live.length === 0) return;
    const committed = [...strokes, { points: live, width }];
    live = [];
    strokes = committed;
    reflectEmpty();
    paint();
    // One store write per stroke — a moved finger never round-trips the store.
    api.writeBack(node.attrs["bind"], encodeInk(committed));
    api.handler("change");
    api.handler("end", {
      strokes: committed.length,
      points: committed[committed.length - 1]!.points.length,
    });
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { paint(); }).observe(canvas);
  reflectEmpty();
  return wrap;
};

export const UNIVERSAL_GLOBAL_ELEMENTS: Readonly<Record<string, ElementFactory>> = {
  Checkbox: checkbox,
  ProgressRing: progressRing,
  Skeleton: skeleton,
  ChatBubble: chatBubble,
  Accordion: accordion,
  Signature: signature,
};

export const UNIVERSAL_GLOBAL_TAGS: ReadonlySet<string> = new Set(
  Object.keys(UNIVERSAL_GLOBAL_ELEMENTS),
);

export const GLOBAL_ELEMENTS_CSS = `@layer dsx-elements {
  .dsx-checkbox {
    --dsx-checkbox-color: var(--dsx-accent);
    --dsx-checkbox-size: 1.25rem;
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 44px;
    font-family: var(--dsx-font);
    font-size: var(--dsx-type-body);
    font-weight: var(--dsx-type-label-weight);
    color: var(--dsx-label);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .dsx-checkbox input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    opacity: 0;
  }
  .dsx-checkbox-box {
    position: relative;
    box-sizing: border-box;
    width: var(--dsx-checkbox-size);
    height: var(--dsx-checkbox-size);
    flex: none;
    border: 1px solid var(--dsx-secondary-label);
    border-radius: calc(var(--dsx-radius-sm) - 1px);
    /* FLAT. This was a 165deg gradient over an inner bevel and a bottom highlight - the
       skeuomorphic control treatment, and the single most dating thing on the page. An
       unchecked box is a bordered empty surface on both native platforms and here. */
    background: var(--dsx-background);
    transition:
      background var(--dsx-dur-base) ease,
      border-color var(--dsx-dur-base) ease,
      box-shadow var(--dsx-dur-base) var(--dsx-ease-out),
      transform var(--dsx-dur-fast) var(--dsx-ease-out);
  }
  .dsx-checkbox-box::after {
    content: "";
    position: absolute;
    left: 0.36rem;
    top: 0.13rem;
    width: 0.31rem;
    height: 0.59rem;
    border: solid var(--dsx-on-accent);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg) scale(0);
    transform-origin: 58% 58%;
    transition: transform var(--dsx-dur-base) var(--dsx-ease-out);
  }
  .dsx-checkbox input:checked + .dsx-checkbox-box {
    border-color: color-mix(in srgb, var(--dsx-checkbox-color) 78%, var(--dsx-label));
    /* a checked box is its accent, flat: no lightened top stop, no inner highlight. */
    background: var(--dsx-checkbox-color);
  }
  .dsx-checkbox input:checked + .dsx-checkbox-box::after { transform: rotate(45deg) scale(1); }
  .dsx-checkbox input:focus-visible + .dsx-checkbox-box {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-checkbox-color);
    outline-offset: var(--dsx-focus-ring-offset);
  }
  .dsx-checkbox input:not(:disabled):active + .dsx-checkbox-box { transform: scale(.91); }
  .dsx-checkbox input:disabled + .dsx-checkbox-box,
  .dsx-checkbox input:disabled ~ .dsx-checkbox-label { opacity: .5; }
  .dsx-checkbox-label { color: var(--dsx-label); }
  @media (hover: hover) and (pointer: fine) {
    .dsx-checkbox {
      --dsx-checkbox-size: 1.125rem;
      min-height: var(--dsx-control-height);
      font-size: var(--dsx-type-label);
    }
    .dsx-checkbox-box::after {
      left: 0.31rem;
      top: 0.09rem;
      width: 0.28rem;
      height: 0.53rem;
    }
    .dsx-checkbox input:not(:disabled):not(:checked):hover + .dsx-checkbox-box {
      border-color: var(--dsx-label);
    }
  }
  @media (pointer: coarse) {
    .dsx-checkbox {
      --dsx-checkbox-size: 1.25rem;
      min-height: 44px;
      font-size: var(--dsx-type-body);
    }
    .dsx-checkbox-box::after {
      left: 0.36rem;
      top: 0.13rem;
      width: 0.31rem;
      height: 0.59rem;
    }
  }

  .dsx-progress-ring {
    --dsx-ring-size: 88px;
    --dsx-ring-track: var(--dsx-fill);
    --dsx-ring-color: var(--dsx-accent);
    position: relative;
    display: inline-grid;
    place-items: center;
    width: var(--dsx-ring-size);
    height: var(--dsx-ring-size);
    flex: none;
    font-family: var(--dsx-font);
  }
  .dsx-progress-ring svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .dsx-progress-ring-arc { transition: stroke-dashoffset var(--dsx-dur-base) var(--dsx-ease); }
  .dsx-progress-ring-label {
    position: relative;
    color: var(--dsx-label);
    font-size: var(--dsx-type-callout-size);
    font-weight: var(--dsx-type-headline-weight);
  }

  .dsx-skeleton {
    --dsx-skeleton-height: 14px;
    --dsx-skeleton-radius: 8px;
    position: relative;
    width: 100%;
    height: var(--dsx-skeleton-height);
    flex: none;
    overflow: hidden;
    border-radius: var(--dsx-skeleton-radius);
    background: var(--dsx-fill);
  }
  .dsx-skeleton::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 20%,
      color-mix(in srgb, var(--dsx-label) 9%, transparent) 50%,
      transparent 80%
    );
    transform: translateX(-100%);
    animation: dsx-skeleton-shimmer var(--dsx-dur-loop-slow) ease-in-out infinite;
  }
  @keyframes dsx-skeleton-shimmer { to { transform: translateX(100%); } }

  .dsx-chat-bubble {
    --dsx-chat-max: 280px;
    --dsx-chat-color: var(--dsx-fill);
    --dsx-chat-foreground: var(--dsx-label);
    display: flex;
    width: 100%;
  }
  .dsx-chat-right {
    --dsx-chat-color: var(--dsx-accent);
    --dsx-chat-foreground: var(--dsx-on-accent);
    justify-content: flex-end;
  }
  .dsx-chat-left { justify-content: flex-start; }
  .dsx-chat-bubble-body {
    max-width: min(var(--dsx-chat-max), 85%);
    padding: 0.625rem 0.875rem;
    border-radius: var(--dsx-radius-sheet);
    background: var(--dsx-chat-color);
    color: var(--dsx-chat-foreground);
    overflow-wrap: anywhere;
  }
  .dsx-chat-left .dsx-chat-bubble-body { border-bottom-left-radius: 0.25rem; }
  .dsx-chat-right .dsx-chat-bubble-body {
    border-bottom-right-radius: 0.25rem;
    box-shadow: var(--dsx-shadow-xs);
  }

  /* a content card: the 3-layer shadow-1 (ambient + drop + contact line / inner
     highlight) replaces the hard hairline border (component-fidelity, wave 7) */
  .dsx-accordion {
    display: grid;
    grid-template-rows: auto 0fr;
    width: 100%;
    overflow: hidden;
    border-radius: var(--dsx-radius-card);
    background: var(--dsx-surface-raised);
    box-shadow: var(--dsx-shadow-1);
    transition: grid-template-rows var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-accordion-open { grid-template-rows: auto 1fr; }
  .dsx-accordion-header {
    appearance: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--dsx-space-3);
    width: 100%;
    min-height: 44px;
    padding: var(--dsx-space-3) var(--dsx-space-4);
    border: none;
    background: none;
    color: var(--dsx-label);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background-color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-accordion-header:active { background: color-mix(in srgb, var(--dsx-fill) 94%, var(--dsx-label)); }
  /* the card clips (overflow: hidden + radius), so the ring stays inset at the
     shared width */
  .dsx-accordion-header:focus-visible { outline: none; box-shadow: inset var(--dsx-focus-ring); }
  .dsx-accordion-title {
    font-size: var(--dsx-type-headline-size);
    font-weight: var(--dsx-type-headline-weight);
    letter-spacing: var(--dsx-type-headline-tracking);
  }
  .dsx-accordion-chevron {
    flex: none;
    color: var(--dsx-accent);
    font-size: var(--dsx-glyph-size-lg);
    line-height: var(--dsx-type-leading-none);
    transform: rotate(0);
    transition: transform var(--dsx-dur-slow) var(--dsx-ease-spring);
  }
  [dir="rtl"] .dsx-accordion-chevron { transform: rotate(180deg); }
  .dsx-accordion-open .dsx-accordion-chevron { transform: rotate(90deg); }
  .dsx-accordion-body {
    min-height: 0;
    overflow: hidden;
    padding: 0 var(--dsx-space-4);
    border-top: 0 solid var(--dsx-separator);
  }
  .dsx-accordion-open .dsx-accordion-body {
    padding: var(--dsx-space-3) var(--dsx-space-4) var(--dsx-space-4);
    border-top-width: var(--dsx-hairline);
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-accordion-header:hover { background: var(--dsx-fill); }
    .dsx-accordion-header:active { background: color-mix(in srgb, var(--dsx-fill) 94%, var(--dsx-label)); }
  }

  ` +
// ── wave-4 fidelity, the ACTIONS plane (design-system.md "the fidelity ruling").
// The button/segmented BASE sheets live in theme.ts, outside this plane's files, so
// the press spring, the hover lift, THE WIDTH LAW and the sliding-thumb spring land
// here: boot injects this sheet LAST, so an equal-specificity declaration
// deterministically wins over the base. A sliced embed without this sheet keeps the
// static base skin. Focus rings are deliberately untouched.
`  .dsx-button {
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease),
      filter var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-slow) var(--dsx-ease-spring);
  }
  .dsx-button:not(:disabled):not([aria-disabled="true"]):active {
    transform: scale(0.97);
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease),
      filter var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-fast) var(--dsx-ease);
  }
  ` +
// the height ramp is the density-plane control tokens (32/40/48 comfortable,
// 28/32/36 compact): variants ride the LARGE step (StackReference:
// controlSize(.large)); the plain button keeps the 40px REGULAR visual on coarse
// pointers too — the base sheet's padded hit area carries the 44px floor (W9).
`  .dsx-button[data-dsx-variant] { --dsx-button-min-height: var(--dsx-control-height-lg); }
  @media (hover: hover) and (pointer: fine) {
    .dsx-button[data-dsx-variant="prominent"]:not(:disabled):not([aria-disabled="true"]):hover {
      filter: brightness(1.05);
    }
    /* the stepper's +/- ride the button family's fine-pointer hover discipline
       (W9 audit fix): the plain button's fill wash on rest, brightness on press. */
    .dsx-stepper-btn:not(:disabled):hover {
      background: color-mix(in srgb, var(--dsx-fill) 72%, transparent);
    }
    /* hoverable CARDS step their material one level (component-fidelity, wave 7):
       thin -> level-2, regular -> level-3, thick/sheet -> the highlight cap */
    .dsx-pressable.dsx-surface-thin:not(:disabled):not([aria-disabled="true"]):hover { background: var(--dsx-surface-level-2); }
    .dsx-pressable.dsx-surface-regular:not(:disabled):not([aria-disabled="true"]):hover { background: var(--dsx-surface-level-3); }
    .dsx-pressable:is(.dsx-surface-thick, .dsx-surface-sheet):not(:disabled):not([aria-disabled="true"]):hover { background: var(--dsx-surface-highlight); }
  }
  ` +
// THE GUTTER LAW: classic-scrollbar platforms (Windows, Linux, any fine-pointer
// window) reserve the scrollbar gutter on ONE edge, shoving the whole page column
// off-center by the bar's width even when nothing scrolls - measured 24px left vs
// 39px right margins. Symmetric reservation keeps the column centered whether or
// not the bar shows; thin bars shrink both gutters. Coarse pointers (real phones,
// overlay bars) reserve nothing, matching the base sheet's exception.
`  .dsx-scroll.dsx-scroll { scrollbar-gutter: stable both-edges; scrollbar-width: thin; }
  @media (pointer: coarse) {
    .dsx-scroll.dsx-scroll { scrollbar-gutter: auto; }
  }
  ` +
// classic-bar refinement (web-face F3): thin bars everywhere they draw, a quiet
// ink-mix thumb at rest, and a container-hover deepen — scrollbar-color is the
// modern two-token surface, so the deepen rides the scrollport's own :hover
// (no legacy pseudo parts; platforms without scrollbar-color keep their native
// overlay bars).
`  @media (hover: hover) and (pointer: fine) {
    .dsx-scroll.dsx-scroll, .dsx-list {
      scrollbar-color: color-mix(in srgb, var(--dsx-tertiary-label) 52%, transparent) transparent;
    }
    .dsx-scroll.dsx-scroll:hover, .dsx-list:hover {
      scrollbar-color: color-mix(in srgb, var(--dsx-tertiary-label) 78%, transparent) transparent;
    }
  }
  ` +
// THE HUG LAW's two exceptions, every viewport: an only-child scroll is a VIEWPORT,
// not a chip - it stretches to its stack's cross axis so page columns inside it can
// actually center (max-width + align-self: center); and a field is a form ROW - it
// spans its vertical stack so a settings-row toggle reaches the card's trailing
// edge. Authored align-self wins over both.
`  .dsx-stack > .dsx-scroll:only-child { align-self: stretch; }
  .dsx-stack:not(.dsx-hstack):not(.dsx-zstack):not([data-dsx-grid]) > :is(.dsx-field, .dsx-pressable) { align-self: stretch; }
  ` +
// THE SPACER FILL LAW, the hug law's third exception. A spacer exists to consume free
// space; under the hug law a row has none, so the spacer collapses to zero, the trailing
// content sits mid-container instead of at the edge, and the row's own border-bottom stops
// short of the column it is supposed to underline. MEASURED on the parity plane before this
// rule: landing-hero's brand bar was 306px inside a 688px column at w1366, and its hairline
// ended where the button ended.
// BOTH NATIVE RENDERERS ALREADY FILL, which makes this a parity defect and not a taste call:
// SwiftUI's HStack with a Spacer() takes its VStack's width, and Compose gives a weight(1f)
// child the parent's max constraint - StackNodeView.FlexRowChildren emits exactly that for an
// unsized spacer. This is the web's half of that agreement.
// The trigger is the DOCUMENT, not an authoring opt-in: a row holding a child that asks to
// grow along the row is asking to fill, and :has() reads that straight off the tree. The
// signals are the DSX vocabulary - a spacer, or grow= on a child - so a raw inline flex stays
// the author's own escape hatch. An authored align-self still wins: it lands as an element
// style, a later layer than this sheet.
`  :is(.dsx-stack:not(.dsx-hstack):not(.dsx-zstack):not([data-dsx-grid]),
      .dsx-scroll:not(.dsx-scroll-x)) > .dsx-hstack:has(> :is(
    .dsx-spacer, [data-dsx-grow="width"], [data-dsx-grow="true"], [data-dsx-grow="both"]
  )) { align-self: stretch; }
  /* The transpose: a column inside a row, whose flexible child wants vertical space. */
  .dsx-hstack > .dsx-stack:not(.dsx-hstack):not(.dsx-zstack):not([data-dsx-grid]):has(> :is(
    .dsx-spacer, [data-dsx-grow="height"], [data-dsx-grow="true"], [data-dsx-grow="both"]
  )) { align-self: stretch; }
  ` +
// A FORM IS A BLOCK, AND AN INPUT IS ITS CONTAINER'S, at every width. The width law below is
// scoped to compact for a reason that is only true of BUTTONS; a form and a text input were
// riding along with it and changing shape at 48rem. MEASURED before this rule: form-screen at
// w1366 rendered the whole sign-in - label, both inputs, the submit - as a 178px sliver, because
// the form hugged and each input hugged to the UA's own size default; the same document at
// w390 filled its 326px measure correctly. One document, two shapes, on the axis the parity
// contract exists to deny.
// A text input has no intrinsic width worth honouring - size=20 is a 1994 artifact, not a
// design - so its width is the container's decision on every platform. A form is a block of
// related controls, which is why the compact law already treated it as one. Neither depends on
// the viewport, so neither belongs behind a media query. The AUTHOR still owns the measure: a
// page column sets max-width and align-self (parity/fixtures/landing-hero.dsx does), and an
// authored width or align-self is an element style, a later layer than this sheet.
// A LIST AND A TABLE ARE BLOCKS TOO. `.dsx-list` is structurally the same thing as a column
// stack - `display: flex; flex-direction: column` - it simply does not carry `.dsx-stack`, so
// this allowlist walked straight past the single most common child a card ever has. MEASURED:
// the worked example's feed put its list in a `secondaryGroupedBackground` card and the list
// shrank to its content (319px inside a 338px card), leaving a dead white gutter down the right
// of every row and stranding each row's trailing rating mid-row instead of flush to the edge -
// the "the card is broken" read at a glance. The allowlist was the decision that over-reached,
// so it grows to cover the blocks it always meant; an authored width or align-self still wins.
`  :is(.dsx-stack:not(.dsx-hstack):not(.dsx-zstack):not([data-dsx-grid]),
      .dsx-scroll:not(.dsx-scroll-x)) > :is(
    .dsx-form, .dsx-textfield, .dsx-textarea, .dsx-select, .dsx-list, .dsx-table,
    .dsx-stack:not(.dsx-hstack):not(.dsx-zstack):not([data-dsx-grid])
  ) { align-self: stretch; }
  .dsx-form .dsx-field-control, .dsx-form .dsx-textfield, .dsx-form .dsx-textarea, .dsx-form .dsx-select {
    width: 100%;
  }
  ` +
// THE WIDTH LAW: on a compact viewport (below the 48rem regular step) a button that
// is a direct child of a VERTICAL stack context stretches full width; buttons in
// hstack/toolbar/flow/inline contexts keep hugging, and an authored align-self or
// width always wins (inline styles outrank every layer rule). A BUTTON is the one control
// whose width is genuinely its own: full-width is a phone idiom and a 1366px button is not a
// button, so this one stays behind the media query while the form and the inputs above do not.
`  @media (max-width: 47.9375rem) {
    :is(.dsx-stack:not(.dsx-hstack):not(.dsx-zstack):not([data-dsx-grid]), .dsx-scroll:not(.dsx-scroll-x)) > .dsx-button {
      align-self: stretch;
    }
  }
  ` +
`  /* THE STANDALONE TOGGLE is the web polyfill: iOS-26-ish capsule (elongated
     track, pill thumb), glass-free, token-driven. Authors restyle via
     --dsx-toggle-* / --dsx-control-tint / color=. iOS and Android host the
     real system switch and never read this sheet. */
  :root, :host {
    --dsx-toggle-track-width: 63px;
    --dsx-toggle-track-height: 28px;
    --dsx-toggle-thumb-width: 36px;
    --dsx-toggle-thumb-size: 24px;
    --dsx-toggle-thumb-inset: 2px;
    --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
    --dsx-toggle-box-width: var(--dsx-toggle-track-width);
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    :root, :host {
      --dsx-toggle-track-width: 51px;
      --dsx-toggle-track-height: 24px;
      --dsx-toggle-thumb-width: 30px;
      --dsx-toggle-thumb-size: 20px;
      --dsx-toggle-thumb-inset: 2px;
      --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
      --dsx-toggle-box-width: var(--dsx-toggle-track-width);
    }
  }
  [data-dsx-density="comfortable"], :host([data-dsx-density="comfortable"]) {
    --dsx-toggle-track-width: 63px;
    --dsx-toggle-track-height: 28px;
    --dsx-toggle-thumb-width: 36px;
    --dsx-toggle-thumb-size: 24px;
    --dsx-toggle-thumb-inset: 2px;
    --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
    --dsx-toggle-box-width: var(--dsx-toggle-track-width);
  }
  [data-dsx-density="compact"], :host([data-dsx-density="compact"]) {
    --dsx-toggle-track-width: 51px;
    --dsx-toggle-track-height: 24px;
    --dsx-toggle-thumb-width: 30px;
    --dsx-toggle-thumb-size: 20px;
    --dsx-toggle-thumb-inset: 2px;
    --dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width) - 2 * var(--dsx-toggle-thumb-inset));
    --dsx-toggle-box-width: var(--dsx-toggle-track-width);
  }
  .dsx-toggle.dsx-toggle {
    --dsx-toggle-stretch: 6px;
    --dsx-control-tint: var(--dsx-switch-on);
  }
  .dsx-toggle.dsx-toggle .dsx-toggle-track {
    border: 0;
    background: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    box-shadow: inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-label) 10%, transparent);
    transition:
      background-color var(--dsx-dur-base) var(--dsx-ease),
      box-shadow var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-toggle.dsx-toggle input:checked + .dsx-toggle-track {
    background: var(--dsx-control-tint);
    box-shadow: inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-control-tint) 84%, var(--dsx-label));
  }
  .dsx-toggle.dsx-toggle input:focus-visible + .dsx-toggle-track {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-control-tint);
    outline-offset: var(--dsx-focus-ring-offset);
  }
  .dsx-toggle.dsx-toggle .dsx-toggle-thumb {
    width: var(--dsx-toggle-thumb-width);
    height: var(--dsx-toggle-thumb-size);
    margin: var(--dsx-toggle-thumb-inset);
    border: 0;
    border-radius: var(--dsx-radius-full);
    background: var(--dsx-control-knob);
    box-shadow: var(--dsx-shadow-1);
    will-change: transform;
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-spring),
      width var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-toggle.dsx-toggle input:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    width: calc(var(--dsx-toggle-thumb-width) + var(--dsx-toggle-stretch));
    transform: none;
    box-shadow: var(--dsx-shadow-1);
  }
  .dsx-toggle.dsx-toggle input:checked:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: translateX(calc(var(--dsx-toggle-travel) - var(--dsx-toggle-stretch)));
  }
  [dir="rtl"] .dsx-toggle.dsx-toggle .dsx-toggle-track .dsx-toggle-thumb { transform: translateX(var(--dsx-toggle-travel)); }
  [dir="rtl"] .dsx-toggle.dsx-toggle input:checked + .dsx-toggle-track .dsx-toggle-thumb { transform: translateX(0); }
  [dir="rtl"] .dsx-toggle.dsx-toggle input:not(:checked):not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb {
    transform: translateX(calc(var(--dsx-toggle-travel) - var(--dsx-toggle-stretch)));
  }
  [dir="rtl"] .dsx-toggle.dsx-toggle input:checked:not(:disabled):active + .dsx-toggle-track .dsx-toggle-thumb { transform: none; }
  /* the compact capsule (51x24, thumb 30x20) rides the DENSITY PLANE's compact table
     (theme.ts): the desktop fine-pointer default and the density= pin resolve the same
     tokens, so this sheet no longer re-declares them. The 6px press stretch is the
     polyfill's own number and holds at every density, exactly like the form twin. */
  /* segmented: the selected thumb SLIDES between segments on the spring (geometry
     only); its reveal stays plain ease. Labels crossfade weight under the thumb.
     BETWEEN SEGMENTS is the whole of it, so this is gated on [data-animate] like the
     element-layer rule it overrides: unqualified it also animated the FIRST position,
     which is taken pre-layout while option one still spans the track - the pill entered
     310px wide over three of its four options and shrank into place on every load. */
  .dsx-segmented-indicator[data-animate="true"] {
    transition:
      left var(--dsx-dur-slow) var(--dsx-ease-spring),
      top var(--dsx-dur-slow) var(--dsx-ease-spring),
      width var(--dsx-dur-slow) var(--dsx-ease-spring),
      height var(--dsx-dur-slow) var(--dsx-ease-spring),
      opacity var(--dsx-dur-fast) ease;
  }
  .dsx-segmented > .dsx-segmented-option {
    font-weight: var(--dsx-type-label-weight);
    transition:
      color var(--dsx-dur-fast) ease,
      opacity var(--dsx-dur-fast) ease,
      font-weight var(--dsx-dur-base) var(--dsx-ease),
      transform var(--dsx-dur-slow) var(--dsx-ease-spring);
  }
  .dsx-segmented > .dsx-segmented-option:not(:disabled):active {
    transition:
      color var(--dsx-dur-fast) ease,
      opacity var(--dsx-dur-fast) ease,
      font-weight var(--dsx-dur-base) var(--dsx-ease),
      transform var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-segmented > .dsx-segmented-option[data-selected="true"] { font-weight: var(--dsx-type-headline-weight); }

  ` +
// ── wave-7 fidelity, the SURFACES + ACTIONS plane (component-fidelity-spec, ACTIONS
// half re-ratified by the owner 2026-08-27): buttons are FLAT. The 2px border step and
// the accent glow read as a raised 2010 chip on every preview and are withdrawn - the
// base sheet's quiet fill (bordered) and solid accent (prominent) are the whole rest
// look, hover/active move one flat level, and the press spring carries the physicality.
// Still here: disabled settles on the 0.5 discipline; and a pressable carrying an
// OPAQUE surface material is a CARD, not a row - it rests on shadow-1's contact line,
// presses to 0.97 landing fast and releasing on the spring. Rows (bare pressables)
// keep the base background flash - no scale. Glass materials stay chrome, not cards.
// Reduced motion collapses every duration/spring token, so these rules silence
// themselves by construction.
`  .dsx-button:disabled, .dsx-button[aria-disabled="true"],
  .dsx-pressable:disabled, .dsx-pressable[aria-disabled="true"] { opacity: .5; }
  .dsx-pressable:is(.dsx-surface-thin, .dsx-surface-regular, .dsx-surface-thick, .dsx-surface-sheet) {
    border-radius: var(--dsx-radius-card);
    box-shadow: var(--dsx-shadow-1);
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease),
      box-shadow var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-slow) var(--dsx-ease-spring);
  }
  .dsx-pressable:is(.dsx-surface-thin, .dsx-surface-regular, .dsx-surface-thick, .dsx-surface-sheet):not(:disabled):not([aria-disabled="true"]):active {
    transform: scale(0.97);
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease),
      box-shadow var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-badge {
    display: inline-grid;
    place-items: center;
    min-width: 1.2rem;
    min-height: 1.2rem;
    padding-inline: 0.3rem;
    border-radius: var(--dsx-radius-full);
  }
  .dsx-badge-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--dsx-radius-full);
  }

  /* Foundation Chip is a pressable without a surface material, so the card press
     above does not reach it. The pill still needs the same 0.97 / spring language. */
  .dsx-chip {
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease),
      box-shadow var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-slow) var(--dsx-ease-spring);
  }
  .dsx-chip:not(:disabled):not([aria-disabled="true"]):active {
    transform: scale(0.97);
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease),
      box-shadow var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-banner {
    position: relative;
    box-shadow: var(--dsx-shadow-1);
    animation: dsx-banner-in var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-banner::before {
    content: "";
    width: 3px;
    align-self: stretch;
    flex: none;
    margin-block: 2px;
    border-radius: var(--dsx-radius-full);
    background: var(--dsx-info);
  }
  .dsx-banner-success::before { background: var(--dsx-success); }
  .dsx-banner-warning::before { background: var(--dsx-warning); }
  .dsx-banner-error::before { background: var(--dsx-destructive); }
  .dsx-banner-info::before { background: var(--dsx-info); }
  @keyframes dsx-banner-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }
  .dsx-callout {
    box-shadow: inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft);
  }
  .dsx-card-raised {
    box-shadow: var(--dsx-shadow-1);
  }
  .dsx-card-cut {
    box-shadow: inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft);
  }
  .dsx-empty-state-icon {
    opacity: .72;
    transition: transform var(--dsx-dur-slow) var(--dsx-ease-spring), opacity var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-avatar {
    isolation: isolate;
  }
  .dsx-avatar-status {
    box-shadow: 0 0 0 2px var(--dsx-secondary-grouped-background);
  }
  .dsx-fab {
    transition: transform var(--dsx-dur-slow) var(--dsx-ease-spring), box-shadow var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-fab:not(:disabled):not([aria-disabled="true"]):active {
    transform: scale(0.94);
    transition: transform var(--dsx-dur-fast) var(--dsx-ease), box-shadow var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-settings-row {
    position: relative;
    border-radius: var(--dsx-radius);
    transition: background-color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-settings-row-action {
    position: absolute;
    inset: 0;
    opacity: 0;
  }
  .dsx-settings-row:has(.dsx-settings-row-action:active) {
    background: color-mix(in srgb, var(--dsx-fill) 70%, transparent);
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-settings-row:has(.dsx-settings-row-action:hover) {
      background: color-mix(in srgb, var(--dsx-fill) 55%, transparent);
    }
    .dsx-fab:not(:disabled):not([aria-disabled="true"]):hover {
      filter: brightness(1.05);
    }
  }
  .dsx-pressable.dsx-surface-thin:not(:disabled):not([aria-disabled="true"]):active { background: var(--dsx-surface-level-2); }
  .dsx-pressable.dsx-surface-regular:not(:disabled):not([aria-disabled="true"]):active { background: var(--dsx-surface-level-3); }
  .dsx-pressable:is(.dsx-surface-thick, .dsx-surface-sheet):not(:disabled):not([aria-disabled="true"]):active { background: var(--dsx-surface-highlight); }

  /* <Signature> — the pad geometry is the fixture's (elements/Signature.json geometry):
     180 high, radius 12, a 1px separator border, the signing rule inset 24 from each edge
     and 36 above the bottom, and a 15px placeholder. The SSR twin renders the committed
     ink as an inline SVG into the same box, so a signed document has real first paint. */
  .dsx-signature {
    --dsx-signature-height: 180px;
    --dsx-signature-radius: 12px;
    --dsx-signature-ink: var(--dsx-label);
    position: relative;
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: var(--dsx-signature-height);
    border: 1px solid var(--dsx-separator);
    border-radius: var(--dsx-signature-radius);
    overflow: hidden;
    color: var(--dsx-signature-ink);
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
  }
  .dsx-signature-canvas,
  .dsx-signature-ink {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
  .dsx-signature-ruled::before {
    content: "";
    position: absolute;
    left: 24px;
    right: 24px;
    bottom: 36px;
    height: 1px;
    background: var(--dsx-separator);
  }
  .dsx-signature-placeholder {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    font-family: var(--dsx-font);
    font-size: var(--dsx-type-body-size); /* the fixture's 15pt placeholder, as the ratified rung */
    color: var(--dsx-secondary-label);
    pointer-events: none;
  }
  .dsx-signature-empty > .dsx-signature-placeholder { display: flex; }

  @media (prefers-reduced-motion: reduce) {
    .dsx-skeleton::after { animation: none; }
    .dsx-progress-ring-arc, .dsx-checkbox-box, .dsx-checkbox-box::after,
    .dsx-accordion, .dsx-accordion-chevron, .dsx-button, .dsx-segmented-indicator,
    .dsx-segmented > .dsx-segmented-option, .dsx-chip, .dsx-fab,
    .dsx-empty-state-icon, .dsx-progress-ring-arc { transition: none; }
    .dsx-banner { animation: none; }
  }
  @media (forced-colors: active) {
    .dsx-checkbox-box { border-color: CanvasText; forced-color-adjust: auto; }
    .dsx-accordion { border: 1px solid CanvasText; box-shadow: none; forced-color-adjust: auto; }
    .dsx-checkbox input:checked + .dsx-checkbox-box { border-color: Highlight; background: Highlight; }
    .dsx-checkbox input:checked + .dsx-checkbox-box::after { border-color: HighlightText; }
    .dsx-checkbox input:focus-visible + .dsx-checkbox-box,
    .dsx-accordion-header:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: 2px;
      box-shadow: none;
    }
  }
}`;
