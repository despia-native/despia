//
//  globals.ts - optional web twins for DSX's universal native global components.
//  Full apps install this set from boot.ts. Self-contained embeds only import it when
//  their transitive component slice uses one of these tags, so unused UI never taxes
//  the 40KB widget budget.
//

import { number, truthy } from "@despia/kernel";
import { mapStyleValue } from "@despia/compiler/cssmap";
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
    body.hidden = !open;
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

export const UNIVERSAL_GLOBAL_ELEMENTS: Readonly<Record<string, ElementFactory>> = {
  Checkbox: checkbox,
  ProgressRing: progressRing,
  Skeleton: skeleton,
  ChatBubble: chatBubble,
  Accordion: accordion,
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
    font-weight: 500;
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
    background: linear-gradient(
      165deg,
      var(--dsx-surface-highlight),
      var(--dsx-surface-recessed)
    );
    box-shadow:
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 8%, transparent),
      0 1px 0 color-mix(in srgb, var(--dsx-control-knob) 42%, transparent);
    transition:
      background var(--dsx-motion-standard) ease,
      border-color var(--dsx-motion-standard) ease,
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out),
      transform var(--dsx-motion-fast) var(--dsx-ease-out);
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
    transition: transform var(--dsx-motion-standard) var(--dsx-ease-out);
  }
  .dsx-checkbox input:checked + .dsx-checkbox-box {
    border-color: color-mix(in srgb, var(--dsx-checkbox-color) 78%, var(--dsx-label));
    background: linear-gradient(
      165deg,
      color-mix(in srgb, var(--dsx-checkbox-color) 90%, var(--dsx-control-knob)),
      var(--dsx-checkbox-color)
    );
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--dsx-control-knob) 28%, transparent),
      0 1px 2px color-mix(in srgb, var(--dsx-checkbox-color) 20%, transparent);
  }
  .dsx-checkbox input:checked + .dsx-checkbox-box::after { transform: rotate(45deg) scale(1); }
  .dsx-checkbox input:focus-visible + .dsx-checkbox-box {
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 0 0 3px var(--dsx-checkbox-color);
  }
  .dsx-checkbox input:not(:disabled):active + .dsx-checkbox-box { transform: scale(.91); }
  .dsx-checkbox input:disabled + .dsx-checkbox-box,
  .dsx-checkbox input:disabled ~ .dsx-checkbox-label { opacity: .42; }
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
  .dsx-progress-ring-arc { transition: stroke-dashoffset .2s ease; }
  .dsx-progress-ring-label {
    position: relative;
    color: var(--dsx-label);
    font-size: 0.875rem;
    font-weight: 600;
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
    animation: dsx-skeleton-shimmer 1.35s ease-in-out infinite;
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
    border-radius: 1.1rem;
    background: var(--dsx-chat-color);
    color: var(--dsx-chat-foreground);
    overflow-wrap: anywhere;
  }
  .dsx-chat-left .dsx-chat-bubble-body { border-bottom-left-radius: 0.3rem; }
  .dsx-chat-right .dsx-chat-bubble-body { border-bottom-right-radius: 0.3rem; }

  .dsx-accordion {
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--dsx-separator);
    border-radius: var(--dsx-radius);
    background: var(--dsx-background);
  }
  .dsx-accordion-header {
    appearance: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.625rem 0.875rem;
    border: none;
    background: none;
    color: var(--dsx-label);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .dsx-accordion-header:focus-visible { outline: none; box-shadow: var(--dsx-focus-ring); }
  .dsx-accordion-chevron {
    flex: none;
    color: var(--dsx-accent);
    font-size: 1.5rem;
    line-height: 1;
    transform: rotate(0);
    transition: transform .15s ease;
  }
  [dir="rtl"] .dsx-accordion-chevron { transform: rotate(180deg); }
  .dsx-accordion-open .dsx-accordion-chevron { transform: rotate(90deg); }
  .dsx-accordion-body {
    padding: 0 0.875rem 0.75rem;
    border-top: 1px solid var(--dsx-separator);
  }
  .dsx-accordion-body[hidden] { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .dsx-skeleton::after { animation: none; }
    .dsx-progress-ring-arc, .dsx-checkbox-box, .dsx-checkbox-box::after,
    .dsx-accordion-chevron { transition: none; }
  }
  @media (forced-colors: active) {
    .dsx-checkbox-box, .dsx-accordion { border-color: CanvasText; forced-color-adjust: auto; }
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
