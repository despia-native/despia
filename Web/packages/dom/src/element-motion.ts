//
//  element-motion.ts — the UNIVERSAL MOTION attributes on the web renderer:
//  `enter` · `transition` · `keep` · `anim` · `animDuration`.
//
//  Distinct from ./motion.ts, which is the config-plane ROUTER motion lane (page
//  transitions, swipe-back, master-detail). THIS module implements the per-element catalog
//  UNIVERSAL attributes (stack-elements.json universalAttributes) that the Studio offers on
//  every element on every renderer — and that, until this module, the web renderer silently
//  ignored: an authored `enter="fade"` did nothing here while animating on iOS and Android.
//  The native contract being mirrored is Stack.swift (StackEntry / visibilityBody /
//  StackStyle.animation / StackStyle.transition):
//
//    enter=fade|scale|slide-*        entry animation on FIRST APPEAR, at final layout —
//                                    the element lays out immediately and animates in via
//                                    opacity/transform (Stack.swift's own comment cites
//                                    HTML @starting-style as the model).
//    transition=fade|scale|slide-*   insert/remove animation when `visible-if` FLIPS.
//    keep="true"                     stay MOUNTED when hidden: opacity fade + hit-testing
//                                    off (native: .opacity + allowsHitTesting; default
//                                    0.18s easeOut).
//    anim=spring|linear|easeIn|easeOut|easeInOut    the curve (default easeInOut).
//    animDuration=<seconds>          duration — or, for spring, the RESPONSE.
//
//  THE CURVE NUMBERS ARE NOT LOCAL. Since the UI MOTION ENGINE landed
//  (architecture/proposals/ui-motion.md), `anim`/`animDuration` parse through the SHARED
//  kernel (@despia/kernel `parseMotion`), corpus-pinned in OpenSource/Conformance/motion/ and
//  executed by all three renderers — this module only maps a MotionSpec onto CSS. That
//  ended a real divergence: the web used to carry its own table (0.25s eased / 0.4s
//  spring, and `cubic-bezier(0.34, 1.28, 0.64, 1)` standing in for a spring) while iOS
//  animated a genuine SwiftUI spring at 0.35s curves. Curves map EXACTLY (CSS
//  `cubic-bezier` is the same math the kernel solves); the SPRING is sampled from the
//  kernel into a CSS `linear()` easing across its settle time — CSS has no spring
//  primitive, so sampling is the honest vehicle, and the approximation is NAMED here and
//  in the corpus README rather than hidden in a lookalike bezier.
//
//  DOCUMENTED APPROXIMATION: native slide-* is SwiftUI `.move(edge:)` (enters from the
//  container edge) combined with fade; the web twin is a 16px offset + fade — same read,
//  cheaper math, no layout thrash. Recorded in element-support.json universalAttributes.
//
//  BUNDLE BUDGET: this module is a SEAM FILLER, exactly like native-controls. mount.ts
//  carries only the nullable `ElementMotionSeam` (a few bytes in every bundle); the
//  machinery here is included ONLY where registerElementMotion() is called — the full app
//  boot, and an embed whose sliced markup actually uses a motion attribute (embed-entry's
//  `motion` flag, the nativeControls precedent). A motion-free embed pays nothing.
//

import { ElementMotionSeam, mountNode, motionSubCtx, motionEffect, type MountCtx } from "./mount.ts";
import { truthy, parseMotion, motionProgress, MOTION_PRESET_KEEP, type MotionSpec } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";

/** The motion attributes this module implements — the enforcement anchor the
 *  attribute-support ledger test pins (a ledger row may claim web support for a motion
 *  attribute ONLY if it is listed here). `exit` is deliberately absent: the root-only
 *  dismiss animation is a FRAME concern (the router owns unmount; ./motion.ts is its
 *  transition lane) and is recorded as an honest divergence in element-support.json,
 *  not silently dropped. */
export const MOTION_HANDLED = ["enter", "transition", "keep", "anim", "animDuration"] as const;

// ── the pure plan layer (unit-tested without a DOM) ──────────────────────────────────

/** How many samples the spring's `linear()` easing carries across its settle time. 60
 *  stops = one per frame at 60 Hz over a typical spring — CSS then interpolates linearly
 *  between kernel-exact points, which is the closest a CSS timing function can come to a
 *  real spring. Pinned here and named in ui-motion.md / the motion corpus README. */
export const SPRING_SAMPLE_STOPS = 60;

/** A spring as a CSS `linear()` easing function, sampled from the KERNEL — the honest
 *  vehicle for a curve CSS has no primitive for. Sample points are exact; values between
 *  two stops are linearly interpolated. Underdamped springs overshoot past 1, which
 *  `linear()` carries fine (it is not clamped to [0,1]). */
export function springLinearEasing(spec: MotionSpec, stops: number = SPRING_SAMPLE_STOPS): string {
  const out: string[] = [];
  for (let i = 0; i <= stops; i += 1) {
    const p = motionProgress(spec, (spec.durationMs * i) / stops);
    out.push(p.toFixed(5).replace(/\.?0+$/, "") || "0");
  }
  return `linear(${out.join(",")})`;
}

/** The CSS timing function for a parsed spec. Curves map EXACTLY (`cubic-bezier` is the
 *  same math the kernel solves); the spring is the sampled `linear()` above. */
export function motionCssCurve(spec: MotionSpec): string {
  if (spec.kind === "spring") return springLinearEasing(spec);
  if (spec.name === "linear") return "linear";
  return `cubic-bezier(${spec.x1},${spec.y1},${spec.x2},${spec.y2})`;
}

export type MotionTiming = { durMs: number; curve: string };

/** anim/animDuration → CSS timing, THROUGH THE SHARED MOTION KERNEL (`parseMotion`), so
 *  the numbers are the corpus-pinned ones the SwiftUI and Compose renderers also derive
 *  from — the web no longer holds its own curve table. A curve's duration is the authored
 *  seconds or the pinned 0.35s default; a SPRING's duration is its SETTLE time, and its
 *  `animDuration` set the response, not the length. The `fallback` arm carries the
 *  keep-mode preset (0.18s easeOut) when the author set no anim=. */
export function motionTiming(
  attrs: Record<string, string | undefined>,
  fallback?: MotionSpec,
): MotionTiming {
  const spec = attrs["anim"] === undefined && fallback !== undefined
    ? fallback
    : parseMotion(attrs["anim"], attrs["animDuration"]);
  return { durMs: Math.round(spec.durationMs), curve: motionCssCurve(spec) };
}

export type MotionFrom = { opacity: string; transform: string };

/** The hidden-state pose for a transition/enter token — StackStyle.transition's table:
 *  every token combines with fade; unknown tokens degrade to fade (native `default:`). */
export function motionFrom(token: string): MotionFrom {
  switch (token) {
    case "scale":        return { opacity: "0", transform: "scale(0.92)" };
    case "slide-top":    return { opacity: "0", transform: "translateY(-16px)" };
    case "slide-bottom": return { opacity: "0", transform: "translateY(16px)" };
    case "slide-left":   return { opacity: "0", transform: "translateX(-16px)" };
    case "slide-right":  return { opacity: "0", transform: "translateX(16px)" };
    default:             return { opacity: "0", transform: "" }; // fade (and the fallback)
  }
}

/** keep-mode's native default when the author sets no anim=: the kernel's pinned `keep`
 *  preset (0.18s easeOut — "feels quick, not faded", Stack.swift visibilityAnimation).
 *  The corpus (`motion/curves.json` `presets.keep`) is what holds the three renderers to it. */
export const KEEP_DEFAULT: MotionSpec = MOTION_PRESET_KEEP;

// ── the DOM layer ────────────────────────────────────────────────────────────────────

function animateIn(el: HTMLElement, token: string, t: MotionTiming): void {
  const from = motionFrom(token);
  const prior = { opacity: el.style.opacity, transform: el.style.transform };
  el.style.opacity = from.opacity;
  if (from.transform !== "") el.style.transform = from.transform;
  // Force the hidden pose to land before transitioning out of it — the @starting-style
  // shape: final layout on frame one, paint animates.
  void el.offsetWidth;
  el.style.transition = `opacity ${t.durMs}ms ${t.curve}, transform ${t.durMs}ms ${t.curve}`;
  el.style.opacity = prior.opacity;
  el.style.transform = prior.transform;
  window.setTimeout(() => { el.style.transition = ""; }, t.durMs + 40);
}

function animateOut(el: HTMLElement, token: string, t: MotionTiming): void {
  const from = motionFrom(token);
  el.style.transition = `opacity ${t.durMs}ms ${t.curve}, transform ${t.durMs}ms ${t.curve}`;
  el.style.opacity = from.opacity;
  if (from.transform !== "") el.style.transform = from.transform;
}

function htmlElements(nodes: ChildNode[]): HTMLElement[] {
  return nodes.filter((n): n is HTMLElement => n instanceof HTMLElement);
}

/** `keep="true"` — mount ONCE, toggle opacity + hit-testing on the visible-if value
 *  (never insert/remove). The native twin keeps the view in the hierarchy the same way,
 *  so appear/disappear hooks firing once at mount is parity, not a divergence. */
function mountKeep(inner: XmlNode, ctx: MountCtx, parent: ParentNode, expr: string): void {
  const branch = motionSubCtx(ctx);
  const frag = document.createDocumentFragment();
  mountNode(inner, branch, frag);
  const nodes = [...frag.childNodes];
  parent.append(...nodes);
  const els = htmlElements(nodes);
  const t = motionTiming(inner.attrs, KEEP_DEFAULT);
  let first = true;
  const apply = (on: boolean): void => {
    for (const el of els) {
      if (!first) el.style.transition = `opacity ${t.durMs}ms ${t.curve}`;
      el.style.opacity = on ? "" : "0";
      el.style.pointerEvents = on ? "" : "none";
      el.setAttribute("aria-hidden", on ? "false" : "true");
      // `aria-hidden` alone hides the subtree from the accessibility tree and leaves every
      // control in it FOCUSABLE, so a hidden keep= mints phantom tab stops that a sighted
      // keyboard user lands on with nothing on screen. `inert` is the half that removes them.
      el.inert = !on;
    }
    first = false;
  };
  const dispose = motionEffect(ctx, () => truthy(ctx.store.eval(expr, ctx.item)), apply);
  ctx.disposers.push(dispose, () => { branch.disposers.forEach((d) => d()); });
}

/** `transition=` — the animated twin of mount.ts's own visible-if branch: same anchor,
 *  same subCtx lifecycle, same eval; inserts animate in, removals animate out and are
 *  physically removed after the duration (belt-and-braces timer — a transitionend can be
 *  swallowed by display:none ancestors). */
function mountTransition(inner: XmlNode, ctx: MountCtx, parent: ParentNode, expr: string): void {
  const anchor = document.createComment("dsx:if");
  parent.appendChild(anchor);
  const token = inner.attrs["transition"] ?? "fade";
  const t = motionTiming(inner.attrs);
  let mounted: { nodes: ChildNode[]; ctx: MountCtx } | null = null;
  let leaving: ChildNode[] | null = null;
  const reap = (): void => { leaving?.forEach((n) => n.remove()); leaving = null; };
  const dispose = motionEffect(ctx,
    () => truthy(ctx.store.eval(expr, ctx.item)),
    (on) => {
      if (on && mounted === null) {
        reap(); // a re-show mid-exit replaces the leaving copy (fresh state, like native)
        const branch = motionSubCtx(ctx);
        const frag = document.createDocumentFragment();
        mountNode(inner, branch, frag);
        const nodes = [...frag.childNodes];
        anchor.after(...nodes);
        mounted = { nodes, ctx: branch };
        htmlElements(nodes).forEach((el) => animateIn(el, token, t));
      } else if (!on && mounted !== null) {
        const going = mounted;
        mounted = null;
        going.ctx.disposers.forEach((d) => d()); // effects die first; the exit is a freeze-frame
        leaving = going.nodes;
        for (const n of going.nodes) {
          if (n instanceof HTMLElement) animateOut(n, token, t);
          else n.remove();
        }
        window.setTimeout(reap, t.durMs + 80);
      }
    });
  ctx.disposers.push(dispose, () => {
    mounted?.ctx.disposers.forEach((d) => d());
    mounted?.nodes.forEach((n) => n.remove());
    mounted = null;
    reap();
  });
}

// ── registration ─────────────────────────────────────────────────────────────────────

/** Fill the mount seam. Idempotent; called by the app boot always, and by an embed entry
 *  whose sliced markup carries a motion attribute (embed-entry `motion` flag). */
export function registerElementMotion(): void {
  if (ElementMotionSeam.impl !== null) return;
  ElementMotionSeam.impl = {
    enter(el: HTMLElement, attrs: Record<string, string>): void {
      animateIn(el, attrs["enter"] ?? "fade", motionTiming(attrs));
    },
    vif(node: XmlNode, ctx: MountCtx, parent: ParentNode, expr: string): boolean {
      const inner: XmlNode = { ...node, attrs: { ...node.attrs } };
      delete inner.attrs["visible-if"];
      if (node.attrs["keep"] === "true") { mountKeep(inner, ctx, parent, expr); return true; }
      if (node.attrs["transition"] !== undefined) { mountTransition(inner, ctx, parent, expr); return true; }
      return false;
    },
  };
}
