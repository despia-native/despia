//
//  element-geometry-parity.ts - the LEDGER half of the element contract's geometry gate.
//
//  THE HOLE (runtime-pressure.md R23). OpenSource/Conformance/elements/*.json pins per-element
//  geometry and colours extracted from the Swift reference, with a _src citation on every value.
//  Compose is held to all of it by ElementParityTest.kt. Web was held to none of it: it read the
//  directory only to ask "is this tag supported". element-colour-parity.test.ts closed the colour
//  half, which is a SOURCE comparison - a token name is a fact on every renderer. This file plus
//  its browser runner close the geometry half, which is not: a spacing of 8 is only real if the
//  box measures 8, so every entry below either carries a probe that MOUNTS the element in
//  Chromium and measures it, or says in writing why it does not.
//
//  WHY THIS FILE IS SPLIT FROM ITS RUNNER. The runner launches a browser at import. The ledger
//  is pure, so element-geometry-parity.test.ts can hold the census - every corpus key classified,
//  no key silently dropped - in the ordinary Node suite, and the browser leg can do the measuring.
//
//  THE FOUR KINDS, and the rule that keeps the first one honest.
//    assert - the web value must EQUAL the reference. Drift fails the run.
//    drift  - measured, and it does NOT equal the reference. Pinned at the measured web value
//             with the reference named, because the element skin is owned elsewhere and this
//             gate's job is to make the divergence visible and immovable, not to pick a winner.
//             It still bites: the web value cannot move again without turning the run red.
//    adapt  - measured, differs, and the difference is a DELIBERATE platform adaptation with a
//             written reason (a touch-target floor, a web-only spelling). Pinned the same way.
//    absent - no browser probe can answer it. The reason says what plane owns it instead.
//  A key with no entry at all is UNCLASSIFIED and fails the census test, so the honest remainder
//  is a number in the report rather than a silence.
//
//  THE TRAP THIS AVOIDS. A probe that maps `headerSpacing: 8` to "some gap somewhere in the
//  subtree is 8" always passes and proves nothing. Every `measure` below names ONE box or ONE
//  pair of boxes, and prefers a geometric read (rect deltas, a text Range, a transform matrix)
//  over the computed property that was supposed to produce it. Where the reference value is a
//  MINIMUM rather than a distance - a SwiftUI HStack spacing either side of a Spacer - the
//  probe reads the property that decides it and the `probe` line says so.
//
//  THE MEASUREMENT CONTEXT IS PART OF THE CONTRACT. The fixtures are extracted from the iOS
//  reference, which is a touch phone, and the web sheet re-densifies itself at
//  `(min-width: 64rem) and (hover: hover) and (pointer: fine)`. Measuring the desktop skin
//  against a phone reference would manufacture drift that is really a designed adaptation, so
//  every probe runs in the phone context below and nowhere else.
//

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ELEMENTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)), "../../../../Conformance/elements",
);

/** The one context every probe is measured in - a phone, because the reference is one. */
export const MEASUREMENT_CONTEXT = Object.freeze({
  viewport: Object.freeze({ width: 390, height: 844 }),
  deviceScaleFactor: 1,
  hasTouch: true,
  isMobile: true,
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
});

export type Fixture = {
  tag: string;
  geometry?: { [key: string]: { value?: unknown; _src?: string } };
};

export function fixtures(): Fixture[] {
  return readdirSync(ELEMENTS_DIR).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ELEMENTS_DIR, f), "utf8")) as Fixture & { _schema?: string })
    .filter((d) => "_schema" in d)
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export type GeometryKey = { where: string; tag: string; key: string; value: number | null; src: string };

/** Every `geometry` entry in the corpus, flattened. A non-numeric value (scaffold pins a
 *  sentence) reports `value: null` - it still needs a ledger entry, it just cannot be a number. */
export function geometryKeys(): GeometryKey[] {
  return fixtures().flatMap((d) => Object.entries(d.geometry ?? {}).map(([key, entry]) => ({
    where: `${d.tag}.${key}`,
    tag: d.tag,
    key,
    value: typeof entry?.value === "number" ? entry.value : null,
    src: typeof entry?._src === "string" ? entry._src : "",
  })));
}

/** A harness: one DSX document, mounted into its own host, measured by the probes naming it. */
export type Case = { id: string; markup: string };

const head = (vars: string): string => `<head>${vars}</head>`;

export const CASES: readonly Case[] = [
  {
    id: "checkbox",
    markup: `<stack>${head(`<variable as="on">return true</variable>`)}<Checkbox label="Label" bind="on"/></stack>`,
  },
  {
    id: "radiogroup",
    markup: `<stack>${head(`<variable as="pick">return "alpha"</variable>`)}<RadioGroup bind="pick" options="alpha,beta,gamma"/></stack>`,
  },
  {
    id: "accordion",
    markup: `<stack><Accordion title="Section" open="true"><text>Body copy</text></Accordion></stack>`,
  },
  {
    id: "progressring",
    markup: `<stack>${head(`<variable as="ratio">return 0.5</variable>`)}<ProgressRing bind="ratio"/></stack>`,
  },
  {
    id: "drawer",
    markup: `<stack>${head(`<variable as="open">return true</variable>`)}<Drawer present="open"><text>Row one</text><text>Row two</text></Drawer></stack>`,
  },
  {
    id: "chatbubble",
    markup: `<stack><ChatBubble side="left" value="A left bubble"/><ChatBubble side="right" value="A right bubble"/></stack>`,
  },
  { id: "skeleton", markup: `<stack><Skeleton/></stack>` },
  {
    id: "signature",
    markup: `<stack>${head(`<variable as="sig">return []</variable>`)}<Signature bind="sig" placeholder="Sign here"/></stack>`,
  },
  {
    id: "table",
    markup: `<stack>${head(`<variable as="rows">return [{a:"one",b:"two",c:"three"},{a:"four",b:"five",c:"six"}]</variable>`)}<Table bind="rows" columns="Alpha,Beta,Gamma" fields="a,b,c"/></stack>`,
  },
  {
    id: "otp",
    markup: `<stack>${head(`<variable as="code">return "12"</variable>`)}<otp bind="code"/></stack>`,
  },
  {
    id: "segmentedbutton",
    markup: `<stack>${head(`<variable as="seg">return "One"</variable>`)}<segmentedButton bind="seg" options="One,Two" icons="star,heart"/></stack>`,
  },
  {
    id: "toolbar",
    markup: `<stack><toolbar position="bottom"><button label="Alpha"/><button label="Beta"/></toolbar></stack>`,
  },
  {
    id: "searchbar",
    markup: `<stack>${head(`<variable as="q">return "term"</variable>`)}<searchbar bind="q"/></stack>`,
  },
  {
    id: "progress",
    markup: `<stack>${head(`<variable as="p">return 0.5</variable>`)}<progress bind="p"/></stack>`,
  },
  { id: "divider", markup: `<stack><divider/></stack>` },
  { id: "spinner", markup: `<stack><spinner/></stack>` },
  {
    id: "form",
    markup: `<stack>${head(`<variable as="ok">return false</variable>`)}<form as="probeform" submit="Send" validate="ok"><field name="one" label="One" placeholder="First"/><field name="two" label="Two" placeholder="Second"/></form></stack>`,
  },
  {
    id: "flow",
    markup: `<stack><flow><text>alpha alpha</text><text>beta beta</text><text>gamma gamma</text><text>delta delta</text><text>epsilon epsilon</text><text>zeta zeta</text></flow></stack>`,
  },
  {
    id: "grid",
    markup: `<stack><grid><text>a</text><text>b</text><text>c</text><text>d</text><text>e</text><text>f</text></grid></stack>`,
  },
  {
    id: "stars",
    markup: `<stack>${head(`<variable as="rate">return 3</variable>`)}<stars bind="rate" readonly="true"/></stack>`,
  },
  {
    id: "toggle",
    markup: `<stack>${head(`<variable as="on">return true</variable>`)}<toggle bind="on"/></stack>`,
  },
  {
    id: "rangeslider",
    markup: `<stack>${head(`<variable as="lo">return 20</variable><variable as="hi">return 80</variable>`)}<rangeslider bindLow="lo" bindHigh="hi" min="0" max="100"/></stack>`,
  },
  { id: "qrcode", markup: `<stack><qrcode value="DSX"/></stack>` },
  {
    id: "stacks",
    markup: `<stack><hstack><text>a</text><text>b</text></hstack><vstack><text>c</text><text>d</text></vstack><stack><text>e</text><text>f</text></stack><list><text>g</text><text>h</text></list></stack>`,
  },
  {
    id: "carousel",
    markup: `<stack><carousel><text>page one</text><text>page two</text></carousel></stack>`,
  },
  {
    id: "carousel-peek",
    markup: `<stack><carousel peek="20"><text>page one</text><text>page two</text></carousel></stack>`,
  },
  {
    id: "button",
    markup: `<stack><button icon="star"/><button icon="star" label="Go"/></stack>`,
  },
];

export type Probe = {
  /** the harness whose host element the measure runs against */
  case: string;
  /** WHAT is measured, in the reference's terms - not the CSS property that happens to do it */
  probe: string;
  /** runs inside the page; null = the target was not found, which is a hard failure */
  measure: (root: HTMLElement) => number | null;
  /** absolute tolerance in the value's own unit; sub-pixel by default */
  tol?: number;
};

export type Entry =
  | ({ kind: "assert" } & Probe)
  | ({ kind: "drift"; web: number; note: string } & Probe)
  | ({ kind: "adapt"; web: number; note: string } & Probe)
  | { kind: "absent"; note: string };

/** The ledger. Keys are `<Tag>.<geometryKey>`, exactly as the corpus spells them. */
export const LEDGER: { readonly [where: string]: Entry } = {

  // ── Checkbox ────────────────────────────────────────────────────────────────────────
  "Checkbox.labelSpacing": {
    kind: "assert", case: "checkbox",
    probe: "the horizontal distance from the right edge of the box to the left edge of the caption",
    measure: (root) => {
      const box = root.querySelector(".dsx-checkbox-box");
      const label = root.querySelector(".dsx-checkbox-label");
      if (box === null || label === null) return null;
      return label.getBoundingClientRect().left - box.getBoundingClientRect().right;
    },
  },

  // ── RadioGroup ──────────────────────────────────────────────────────────────────────
  "RadioGroup.rowSpacing": {
    kind: "drift", case: "radiogroup", web: 0,
    note: "the reference separates rows by 12 (VStack spacing); the web group is a bare grid with "
      + "no row gap, so the rows are flush and the separation reads as the 48px row height alone",
    probe: "the vertical distance from the bottom of option 1 to the top of option 2",
    measure: (root) => {
      const rows = root.querySelectorAll(".dsx-radio-option");
      if (rows.length < 2) return null;
      return rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom;
    },
  },
  "RadioGroup.markSpacing": {
    kind: "drift", case: "radiogroup", web: 14,
    note: "the reference puts 10 between the mark and its label (HStack spacing); web spends "
      + "12 of grid gap plus 2 of slack inside a 22px mark column holding a 20px mark",
    probe: "the horizontal distance from the right edge of the radio mark to the left edge of its label",
    measure: (root) => {
      const mark = root.querySelector(".dsx-radio-mark");
      const label = root.querySelector(".dsx-radio-label");
      if (mark === null || label === null) return null;
      return label.getBoundingClientRect().left - mark.getBoundingClientRect().right;
    },
  },

  // ── Accordion ───────────────────────────────────────────────────────────────────────
  "Accordion.headerSpacing": {
    kind: "drift", case: "accordion", web: 12,
    note: "the reference's 8 is an HStack spacing either side of a Spacer, so it is a MINIMUM, "
      + "not a distance - the web header spends 12 there instead",
    probe: "the minimum spacing the header reserves between its title and its chevron (its used column gap - "
      + "the header is space-between, so the rendered distance is free space and cannot be compared)",
    measure: (root) => {
      const header = root.querySelector(".dsx-accordion-header");
      if (header === null) return null;
      return parseFloat(getComputedStyle(header).columnGap);
    },
  },
  "Accordion.chevronOpenRotation": {
    kind: "assert", case: "accordion",
    probe: "the rendered rotation of the chevron, in degrees, while the section is open",
    measure: (root) => {
      const chevron = root.querySelector(".dsx-accordion-chevron");
      if (chevron === null) return null;
      const t = getComputedStyle(chevron).transform;
      const m = new DOMMatrixReadOnly(t === "none" ? "" : t);
      return Math.round(Math.atan2(m.b, m.a) * (180 / Math.PI) * 1000) / 1000;
    },
    tol: 0.5,
  },

  // ── ProgressRing ────────────────────────────────────────────────────────────────────
  "ProgressRing.size": {
    kind: "assert", case: "progressring",
    probe: "the rendered width of the ring",
    measure: (root) => {
      const ring = root.querySelector(".dsx-progress-ring");
      return ring === null ? null : ring.getBoundingClientRect().width;
    },
  },
  "ProgressRing.lineWidth": {
    kind: "drift", case: "progressring", web: 8.8,
    note: "the reference strokes 10 of an 88 ring; web strokes 10 USER UNITS inside a 0 0 100 100 "
      + "viewBox scaled to 88px, so the rendered stroke is 8.8 - the ratio, not just the number, differs",
    probe: "the rendered stroke width of the progress arc, in CSS pixels (stroke-width scaled by the SVG's screen CTM)",
    measure: (root) => {
      const arc = root.querySelector(".dsx-progress-ring-arc");
      const svg = root.querySelector(".dsx-progress-ring svg");
      if (arc === null || svg === null) return null;
      const ctm = (svg as SVGGraphicsElement).getScreenCTM();
      if (ctm === null) return null;
      return parseFloat(getComputedStyle(arc).strokeWidth) * Math.abs(ctm.a);
    },
    tol: 0.01,
  },

  // ── Drawer (the panel portals to the body, so these probes address the document) ─────
  "Drawer.handleWidth": {
    kind: "assert", case: "drawer",
    probe: "the rendered width of the grab handle bar",
    measure: () => {
      const handle = document.querySelector(".dsx-drawer-handle");
      return handle === null ? null : parseFloat(getComputedStyle(handle, "::after").width);
    },
  },
  "Drawer.handleHeight": {
    kind: "assert", case: "drawer",
    probe: "the rendered height of the grab handle bar",
    measure: () => {
      const handle = document.querySelector(".dsx-drawer-handle");
      return handle === null ? null : parseFloat(getComputedStyle(handle, "::after").height);
    },
  },
  "Drawer.handlePaddingV": {
    kind: "adapt", case: "drawer", web: 19,
    note: "the reference pads the grabber by 8; web pads it to a 44px square so the drag affordance "
      + "clears the WCAG 2.2 coarse-pointer target floor (--dsx-hit-target-min). The bar itself is 36x5 "
      + "on both, so this is the hit area, not the drawn handle",
    probe: "the vertical space above the grab handle bar inside the panel",
    measure: () => {
      const handle = document.querySelector(".dsx-drawer-handle");
      return handle === null ? null : parseFloat(getComputedStyle(handle).paddingTop);
    },
  },
  "Drawer.contentSpacing": {
    kind: "assert", case: "drawer",
    probe: "the vertical distance between two consecutive drawer content children",
    measure: () => {
      const kids = document.querySelectorAll(".dsx-drawer-content > *");
      if (kids.length < 2) return null;
      return kids[1].getBoundingClientRect().top - kids[0].getBoundingClientRect().bottom;
    },
  },
  "Drawer.contentPaddingH": {
    kind: "assert", case: "drawer",
    probe: "the horizontal inset from the panel edge to the first content child",
    measure: () => {
      const content = document.querySelector(".dsx-drawer-content");
      const first = document.querySelector(".dsx-drawer-content > *");
      if (content === null || first === null) return null;
      return first.getBoundingClientRect().left - content.getBoundingClientRect().left;
    },
  },
  "Drawer.contentPaddingB": {
    kind: "assert", case: "drawer",
    probe: "the used bottom padding of the drawer content area",
    measure: () => {
      const content = document.querySelector(".dsx-drawer-content");
      return content === null ? null : parseFloat(getComputedStyle(content).paddingBottom);
    },
  },
  "Drawer.cornerRadius": {
    kind: "assert", case: "drawer",
    probe: "the used top-leading corner radius of the drawer panel",
    measure: () => {
      const panel = document.querySelector(".dsx-drawer-panel");
      return panel === null ? null : parseFloat(getComputedStyle(panel).borderTopLeftRadius);
    },
  },
  "Drawer.dismissThreshold": {
    kind: "assert", case: "drawer",
    probe: "the drag distance at which the panel dismisses - measured by dragging the handle and "
      + "bisecting on whether the drawer closed (see INTERACTION in the browser runner)",
    measure: null as unknown as (root: HTMLElement) => number | null,
    tol: 1.01,
  },

  // ── ChatBubble ──────────────────────────────────────────────────────────────────────
  "ChatBubble.maxWidth": {
    kind: "assert", case: "chatbubble",
    probe: "the rendered width of a bubble whose text is long enough to reach the cap",
    measure: (root) => {
      const body = root.querySelector(".dsx-chat-left .dsx-chat-bubble-body");
      return body === null ? null : body.getBoundingClientRect().width;
    },
  },
  "ChatBubble.paddingH": {
    kind: "assert", case: "chatbubble",
    probe: "the used horizontal padding inside the bubble",
    measure: (root) => {
      const body = root.querySelector(".dsx-chat-left .dsx-chat-bubble-body");
      return body === null ? null : parseFloat(getComputedStyle(body).paddingLeft);
    },
  },
  "ChatBubble.paddingV": {
    kind: "assert", case: "chatbubble",
    probe: "the used vertical padding inside the bubble",
    measure: (root) => {
      const body = root.querySelector(".dsx-chat-left .dsx-chat-bubble-body");
      return body === null ? null : parseFloat(getComputedStyle(body).paddingTop);
    },
  },
  "ChatBubble.radius": {
    kind: "assert", case: "chatbubble",
    probe: "the used corner radius on the bubble's three rounded corners",
    measure: (root) => {
      const body = root.querySelector(".dsx-chat-left .dsx-chat-bubble-body");
      return body === null ? null : parseFloat(getComputedStyle(body).borderTopLeftRadius);
    },
  },
  "ChatBubble.tailRadius": {
    kind: "assert", case: "chatbubble",
    probe: "the used corner radius of the squared tail corner - bottom-leading on a left bubble",
    measure: (root) => {
      const body = root.querySelector(".dsx-chat-left .dsx-chat-bubble-body");
      return body === null ? null : parseFloat(getComputedStyle(body).borderBottomLeftRadius);
    },
  },

  // ── Skeleton ────────────────────────────────────────────────────────────────────────
  "Skeleton.height": {
    kind: "assert", case: "skeleton",
    probe: "the rendered height of the placeholder block",
    measure: (root) => {
      const block = root.querySelector(".dsx-skeleton");
      return block === null ? null : block.getBoundingClientRect().height;
    },
  },
  "Skeleton.radius": {
    kind: "assert", case: "skeleton",
    probe: "the used corner radius of the placeholder block",
    measure: (root) => {
      const block = root.querySelector(".dsx-skeleton");
      return block === null ? null : parseFloat(getComputedStyle(block).borderTopLeftRadius);
    },
  },
  "Skeleton.shimmerWidthFraction": {
    kind: "assert", case: "skeleton",
    probe: "the width of the shimmer band as a fraction of the block, read off the gradient's "
      + "first and last positioned stops",
    measure: (root) => {
      const block = root.querySelector(".dsx-skeleton");
      if (block === null) return null;
      const image = getComputedStyle(block, "::after").backgroundImage;
      const stops: string[] = [];
      let depth = 0;
      let current = "";
      const inner = image.slice(image.indexOf("(") + 1, image.lastIndexOf(")"));
      for (const ch of inner) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        if (ch === "," && depth === 0) { stops.push(current); current = ""; continue; }
        current += ch;
      }
      stops.push(current);
      const positions = stops
        .map((s) => /(-?[\d.]+)%\s*$/.exec(s.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => parseFloat(m[1]));
      if (positions.length < 2) return null;
      return (Math.max(...positions) - Math.min(...positions)) / 100;
    },
    tol: 0.001,
  },
  "Skeleton.shimmerDuration": {
    kind: "drift", case: "skeleton", web: 1.35,
    note: "the reference shimmers on a 1.1s linear repeat; the web keyframe runs 1.35s ease-in-out",
    probe: "the shimmer animation's duration, in seconds",
    measure: (root) => {
      const block = root.querySelector(".dsx-skeleton");
      if (block === null) return null;
      const duration = getComputedStyle(block, "::after").animationDuration;
      return duration.endsWith("ms") ? parseFloat(duration) / 1000 : parseFloat(duration);
    },
    tol: 0.001,
  },
  "Skeleton.fillOpacity": {
    kind: "absent",
    note: "an opacity over ink is a COLOUR fact, not a box: web paints the block with the --dsx-fill "
      + "token, which resolves to an opaque mix with no alpha a geometry probe can read. The colour "
      + "plane owns it (element-colour-parity.test.ts)",
  },
  "Skeleton.shimmerOpacity": {
    kind: "absent",
    note: "same as fillOpacity - the shimmer's strength is a colour-mix percentage inside a gradient "
      + "stop, comparable as a colour, not as geometry",
  },

  // ── Signature ───────────────────────────────────────────────────────────────────────
  "Signature.height": {
    kind: "assert", case: "signature",
    probe: "the rendered height of the pad",
    measure: (root) => {
      const pad = root.querySelector(".dsx-signature");
      return pad === null ? null : pad.getBoundingClientRect().height;
    },
  },
  "Signature.radius": {
    kind: "assert", case: "signature",
    probe: "the used corner radius of the pad",
    measure: (root) => {
      const pad = root.querySelector(".dsx-signature");
      return pad === null ? null : parseFloat(getComputedStyle(pad).borderTopLeftRadius);
    },
  },
  "Signature.borderWidth": {
    kind: "assert", case: "signature",
    probe: "the used width of the pad's border",
    measure: (root) => {
      const pad = root.querySelector(".dsx-signature");
      return pad === null ? null : parseFloat(getComputedStyle(pad).borderTopWidth);
    },
  },
  "Signature.baselineInset": {
    kind: "assert", case: "signature",
    probe: "the signing rule's inset from the pad's leading edge, read off its ::before box",
    measure: (root) => {
      const pad = root.querySelector(".dsx-signature");
      return pad === null ? null : parseFloat(getComputedStyle(pad, "::before").left);
    },
  },
  "Signature.baselineBottom": {
    kind: "assert", case: "signature",
    probe: "the signing rule's distance above the pad's bottom edge, read off its ::before box",
    measure: (root) => {
      const pad = root.querySelector(".dsx-signature");
      return pad === null ? null : parseFloat(getComputedStyle(pad, "::before").bottom);
    },
  },
  "Signature.placeholderFontSize": {
    kind: "assert", case: "signature",
    probe: "the used font size of the empty-pad hint",
    measure: (root) => {
      const hint = root.querySelector(".dsx-signature-placeholder");
      return hint === null ? null : parseFloat(getComputedStyle(hint).fontSize);
    },
  },
  "Signature.strokeWidth": {
    kind: "absent",
    note: "the ink width is a canvas 2D lineWidth, not a box: nothing in the mounted DOM carries it. "
      + "It is the INK primitive's default (@despia-native/kernel ink-core.ts INK_STROKE_WIDTH), asserted "
      + "against the shared corpus by canvas-conformance.test.ts on both the TS and Kotlin cores",
  },

  // ── Table ───────────────────────────────────────────────────────────────────────────
  "Table.headerFontSize": {
    kind: "drift", case: "table", web: 13.6,
    note: "the reference sets the header row at 13; web resolves --dsx-type-footnote-size to 0.85rem",
    probe: "the used font size of a header cell",
    measure: (root) => {
      const th = root.querySelector(".dsx-table th");
      return th === null ? null : parseFloat(getComputedStyle(th).fontSize);
    },
  },
  "Table.rowFontSize": {
    kind: "assert", case: "table",
    probe: "the used font size of a body cell",
    measure: (root) => {
      const td = root.querySelector(".dsx-table td");
      return td === null ? null : parseFloat(getComputedStyle(td).fontSize);
    },
  },
  "Table.cellSpacing": {
    kind: "drift", case: "table", web: 32,
    note: "the reference separates cells by 8 (HStack spacing) with no cell padding; web gives every "
      + "cell 16 of inline padding and no gap, so two adjacent cell CONTENTS sit 32 apart",
    probe: "the horizontal distance between the content boxes of two adjacent body cells",
    measure: (root) => {
      const cells = root.querySelectorAll(".dsx-table tbody tr:first-child td");
      if (cells.length < 2) return null;
      const a = cells[0].getBoundingClientRect();
      const b = cells[1].getBoundingClientRect();
      const sa = getComputedStyle(cells[0]);
      const sb = getComputedStyle(cells[1]);
      return (b.left + parseFloat(sb.paddingLeft)) - (a.right - parseFloat(sa.paddingRight));
    },
  },
  "Table.headerPaddingV": {
    kind: "drift", case: "table", web: 11.6,
    note: "the reference pads the header row 8 above and below its text; the web header cell is a "
      + "fixed 40px box with no vertical padding, which leaves more air around the same text",
    probe: "half the difference between a header cell's box and the text it contains (a Range over the cell)",
    measure: (root) => {
      const th = root.querySelector(".dsx-table th");
      if (th === null) return null;
      const range = document.createRange();
      range.selectNodeContents(th);
      return (th.getBoundingClientRect().height - range.getBoundingClientRect().height) / 2;
    },
    tol: 0.6,
  },
  "Table.rowPaddingV": {
    kind: "drift", case: "table", web: 13,
    note: "the reference pads a body row 9 above and below its text; the web body cell is a fixed "
      + "44px box with no vertical padding",
    probe: "half the difference between a body cell's box and the text it contains (a Range over the cell)",
    measure: (root) => {
      const td = root.querySelector(".dsx-table tbody td");
      if (td === null) return null;
      const range = document.createRange();
      range.selectNodeContents(td);
      return (td.getBoundingClientRect().height - range.getBoundingClientRect().height) / 2;
    },
    tol: 0.6,
  },

  // ── otp ─────────────────────────────────────────────────────────────────────────────
  "otp.length": {
    kind: "assert", case: "otp",
    probe: "the number of digit boxes rendered when length= is unset",
    measure: (root) => root.querySelectorAll(".dsx-otp-box").length,
  },
  "otp.boxSize": {
    kind: "assert", case: "otp",
    probe: "the rendered width of one digit box",
    measure: (root) => {
      const box = root.querySelector(".dsx-otp-box");
      return box === null ? null : box.getBoundingClientRect().width;
    },
  },
  "otp.boxSpacing": {
    kind: "assert", case: "otp",
    probe: "the horizontal distance between two adjacent digit boxes",
    measure: (root) => {
      const boxes = root.querySelectorAll(".dsx-otp-box");
      if (boxes.length < 2) return null;
      return boxes[1].getBoundingClientRect().left - boxes[0].getBoundingClientRect().right;
    },
  },
  "otp.cornerRadius": {
    kind: "assert", case: "otp",
    probe: "the used corner radius of a digit box",
    measure: (root) => {
      const box = root.querySelector(".dsx-otp-box");
      return box === null ? null : parseFloat(getComputedStyle(box).borderTopLeftRadius);
    },
  },
  "otp.digitFontFraction": {
    kind: "assert", case: "otp",
    probe: "the digit's used font size divided by the rendered box width",
    measure: (root) => {
      const box = root.querySelector(".dsx-otp-box");
      if (box === null) return null;
      return parseFloat(getComputedStyle(box).fontSize) / box.getBoundingClientRect().width;
    },
    tol: 0.001,
  },
  "otp.idleBorderWidth": {
    kind: "assert", case: "otp",
    probe: "the used border width of an idle digit box",
    measure: (root) => {
      const boxes = root.querySelectorAll(".dsx-otp-box");
      const idle = Array.from(boxes).find((b) => b.getAttribute("data-active") !== "true");
      return idle === undefined ? null : parseFloat(getComputedStyle(idle).borderTopWidth);
    },
  },
  "otp.activeBorderWidth": {
    kind: "assert", case: "otp",
    probe: "the thickness of the emphasis stroke on the ACTIVE digit box, however it is spelled - "
      + "web draws a 2px inset ring over the 1px border rather than thickening the border",
    measure: (root) => {
      const boxes = root.querySelectorAll(".dsx-otp-box");
      const active = Array.from(boxes).find((b) => b.getAttribute("data-active") === "true");
      if (active === undefined) return null;
      const style = getComputedStyle(active);
      const border = parseFloat(style.borderTopWidth);
      let ring = 0;
      for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
        if (!shadow.includes("inset")) continue;
        const lengths = shadow.match(/(-?[\d.]+)px/g);
        if (lengths !== null && lengths.length >= 4) {
          ring = Math.max(ring, parseFloat(lengths[3]));
        }
      }
      return Math.max(border, ring);
    },
  },

  // ── segmentedButton ─────────────────────────────────────────────────────────────────
  "segmentedButton.fontSize": {
    kind: "drift", case: "segmentedbutton", web: 15.3,
    note: "the reference sets a segment label at 15; web resolves --dsx-type-headline-size to 0.95625rem",
    probe: "the used font size of a segment label",
    measure: (root) => {
      const label = root.querySelector(".dsx-segmented-button-label");
      return label === null ? null : parseFloat(getComputedStyle(label).fontSize);
    },
  },
  "segmentedButton.iconSpacing": {
    kind: "drift", case: "segmentedbutton", web: 8,
    note: "the reference puts 6 between a segment's icon and its label; web spends --dsx-space-2 (8)",
    probe: "the horizontal distance from the segment icon's right edge to its label's left edge",
    measure: (root) => {
      const icon = root.querySelector(".dsx-segmented-button-icon");
      const label = root.querySelector(".dsx-segmented-button-label");
      if (icon === null || label === null) return null;
      return label.getBoundingClientRect().left - icon.getBoundingClientRect().right;
    },
  },
  "segmentedButton.paddingV": {
    kind: "drift", case: "segmentedbutton", web: 13.6,
    note: "the reference pads a segment 9 above and below its label; the web segment has no vertical "
      + "padding and reaches a 44px coarse-pointer minimum height instead, leaving more air",
    probe: "half the difference between a segment's box and the label text inside it (a Range over the label)",
    measure: (root) => {
      const item = root.querySelector(".dsx-segmented-button-item");
      const label = root.querySelector(".dsx-segmented-button-label");
      if (item === null || label === null) return null;
      const range = document.createRange();
      range.selectNodeContents(label);
      return (item.getBoundingClientRect().height - range.getBoundingClientRect().height) / 2;
    },
    tol: 0.6,
  },
  "segmentedButton.cornerRadius": {
    kind: "assert", case: "segmentedbutton",
    probe: "the used corner radius of the segmented control's outer track",
    measure: (root) => {
      const track = root.querySelector(".dsx-segmented-button");
      return track === null ? null : parseFloat(getComputedStyle(track).borderTopLeftRadius);
    },
  },
  "segmentedButton.borderWidth": {
    kind: "assert", case: "segmentedbutton",
    probe: "the thickness of the hairline around the segmented track, however it is spelled - web "
      + "draws it as an inset ring rather than a border",
    measure: (root) => {
      const track = root.querySelector(".dsx-segmented-button");
      if (track === null) return null;
      const style = getComputedStyle(track);
      let ring = parseFloat(style.borderTopWidth);
      for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
        if (!shadow.includes("inset")) continue;
        const lengths = shadow.match(/(-?[\d.]+)px/g);
        if (lengths !== null && lengths.length >= 4) ring = Math.max(ring, parseFloat(lengths[3]));
      }
      return ring;
    },
  },

  // ── toolbar ─────────────────────────────────────────────────────────────────────────
  "toolbar.spacing": {
    kind: "assert", case: "toolbar",
    probe: "the horizontal distance between two adjacent toolbar items",
    measure: (root) => {
      const items = root.querySelectorAll(".dsx-toolbar > *");
      if (items.length < 2) return null;
      return items[1].getBoundingClientRect().left - items[0].getBoundingClientRect().right;
    },
  },
  "toolbar.paddingH": {
    kind: "assert", case: "toolbar",
    probe: "the horizontal inset from the toolbar edge to its first item",
    measure: (root) => {
      const bar = root.querySelector(".dsx-toolbar");
      const first = root.querySelector(".dsx-toolbar > *");
      if (bar === null || first === null) return null;
      return first.getBoundingClientRect().left - bar.getBoundingClientRect().left;
    },
  },
  "toolbar.paddingV": {
    kind: "assert", case: "toolbar",
    probe: "the used top padding of the toolbar",
    measure: (root) => {
      const bar = root.querySelector(".dsx-toolbar");
      return bar === null ? null : parseFloat(getComputedStyle(bar).paddingTop);
    },
  },
  "toolbar.hairlineThickness": {
    kind: "drift", case: "toolbar", web: 1,
    note: "the reference draws a 0.5 hairline above a bottom toolbar; web uses --dsx-hairline, "
      + "which is a whole 1px on every density",
    probe: "the used border width on the toolbar's separating edge (top, for position=bottom)",
    measure: (root) => {
      const bar = root.querySelector(".dsx-toolbar");
      return bar === null ? null : parseFloat(getComputedStyle(bar).borderTopWidth);
    },
  },

  // ── searchbar ───────────────────────────────────────────────────────────────────────
  "searchbar.contentSpacing": {
    kind: "drift", case: "searchbar", web: 7,
    note: "the reference puts 6 between the glass and the text; web lands 7 from a 12px glyph inset "
      + "plus a 36px text inset around a 17px glyph",
    probe: "the horizontal distance from the leading glass glyph to where the field's text begins",
    measure: (root) => {
      const icon = root.querySelector(".dsx-searchbar-icon");
      const input = root.querySelector(".dsx-searchbar");
      if (icon === null || input === null) return null;
      const text = input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft);
      return text - icon.getBoundingClientRect().right;
    },
    tol: 0.6,
  },
  "searchbar.paddingH": {
    kind: "assert", case: "searchbar",
    probe: "the horizontal inset from the search capsule's edge to its leading glyph",
    measure: (root) => {
      const field = root.querySelector(".dsx-searchbar-field");
      const icon = root.querySelector(".dsx-searchbar-icon");
      if (field === null || icon === null) return null;
      return icon.getBoundingClientRect().left - field.getBoundingClientRect().left;
    },
  },
  "searchbar.paddingV": {
    kind: "drift", case: "searchbar", web: 15.5,
    note: "the reference pads the capsule 8 above its content; the web capsule is a 48px control "
      + "carrying a 17px glyph, so its content sits 15.5 down",
    probe: "the vertical distance from the capsule's top edge to the top of its leading glyph",
    measure: (root) => {
      const field = root.querySelector(".dsx-searchbar-field");
      const icon = root.querySelector(".dsx-searchbar-icon");
      if (field === null || icon === null) return null;
      return icon.getBoundingClientRect().top - field.getBoundingClientRect().top;
    },
    tol: 0.6,
  },

  // ── progress / divider / spinner ────────────────────────────────────────────────────
  "progress.height": {
    kind: "assert", case: "progress",
    probe: "the rendered height of the progress track",
    measure: (root) => {
      const bar = root.querySelector(".dsx-progress");
      return bar === null ? null : bar.getBoundingClientRect().height;
    },
  },
  "progress.trackOpacity": {
    kind: "absent",
    note: "the reference tints the track at 20% of the fill colour; web mixes the same idea into an "
      + "opaque colour with no alpha to measure - a colour fact, owned by the colour half",
  },
  "divider.thickness": {
    kind: "assert", case: "divider",
    probe: "the rendered thickness of the separator",
    measure: (root) => {
      const rule = root.querySelector(".dsx-divider");
      return rule === null ? null : rule.getBoundingClientRect().height;
    },
  },
  "spinner.size": {
    kind: "assert", case: "spinner",
    probe: "the rendered width of the activity indicator",
    measure: (root) => {
      const spin = root.querySelector(".dsx-spinner");
      return spin === null ? null : spin.getBoundingClientRect().width;
    },
  },

  // ── field / form ────────────────────────────────────────────────────────────────────
  "field.stackSpacing": {
    kind: "drift", case: "form", web: 8,
    note: "the reference stacks a field's label and control 4 apart; web spends --dsx-space-2 (8)",
    probe: "the vertical distance from a field's label to its control",
    measure: (root) => {
      const label = root.querySelector(".dsx-field-label");
      const control = root.querySelector(".dsx-field-control");
      if (label === null || control === null) return null;
      return control.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
    },
  },
  "form.spacing": {
    kind: "assert", case: "form",
    probe: "the vertical distance between two adjacent fields in the form",
    measure: (root) => {
      const fields = root.querySelectorAll(".dsx-field");
      if (fields.length < 2) return null;
      return fields[1].getBoundingClientRect().top - fields[0].getBoundingClientRect().bottom;
    },
  },
  "form.invalidSubmitOpacity": {
    kind: "drift", case: "form", web: 0.55,
    note: "the reference fades an invalid submit to 0.5; web fades it to 0.55",
    probe: "the used opacity of the submit button while the form reports invalid",
    measure: (root) => {
      const submit = root.querySelector(".dsx-form-submit");
      if (submit === null) return null;
      if (submit.getAttribute("data-dsx-valid") !== "false") return null;
      return parseFloat(getComputedStyle(submit).opacity);
    },
    tol: 0.001,
  },

  // ── flow / grid ─────────────────────────────────────────────────────────────────────
  "flow.spacing": {
    kind: "assert", case: "flow",
    probe: "the horizontal distance between two flow items on the same line",
    measure: (root) => {
      const items = Array.from(root.querySelectorAll(".dsx-flow > *"));
      if (items.length < 2) return null;
      const first = items[0].getBoundingClientRect();
      const sameLine = items.find((el, i) => i > 0 && Math.abs(el.getBoundingClientRect().top - first.top) < 1);
      return sameLine === undefined ? null : sameLine.getBoundingClientRect().left - first.right;
    },
  },
  "flow.lineSpacing": {
    kind: "assert", case: "flow",
    probe: "the vertical distance between two wrapped flow lines",
    measure: (root) => {
      const items = Array.from(root.querySelectorAll(".dsx-flow > *"));
      if (items.length < 2) return null;
      const first = items[0].getBoundingClientRect();
      const nextLine = items.find((el) => el.getBoundingClientRect().top - first.top > 1);
      return nextLine === undefined ? null : nextLine.getBoundingClientRect().top - first.bottom;
    },
  },
  "grid.columns": {
    kind: "assert", case: "grid",
    probe: "the number of cells the grid puts on its first row",
    measure: (root) => {
      const cells = Array.from(root.querySelectorAll(".dsx-grid .dsx-collection-row"));
      if (cells.length === 0) return null;
      const top = cells[0].getBoundingClientRect().top;
      return cells.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 1).length;
    },
  },
  "grid.spacing": {
    kind: "assert", case: "grid",
    probe: "the horizontal distance between two adjacent grid cells",
    measure: (root) => {
      const cells = root.querySelectorAll(".dsx-grid .dsx-collection-row");
      if (cells.length < 2) return null;
      return cells[1].getBoundingClientRect().left - cells[0].getBoundingClientRect().right;
    },
  },

  // ── stars ───────────────────────────────────────────────────────────────────────────
  "stars.count": {
    kind: "assert", case: "stars",
    probe: "the number of stars rendered when count= is unset",
    measure: (root) => root.querySelectorAll(".dsx-star").length,
  },
  "stars.size": {
    kind: "assert", case: "stars",
    probe: "the rendered width of one star glyph",
    measure: (root) => {
      const glyph = root.querySelector(".dsx-star svg");
      return glyph === null ? null : glyph.getBoundingClientRect().width;
    },
  },
  "stars.spacingFraction": {
    kind: "assert", case: "stars",
    probe: "the distance between two star glyphs divided by a glyph's rendered width",
    measure: (root) => {
      const glyphs = root.querySelectorAll(".dsx-star svg");
      if (glyphs.length < 2) return null;
      const a = glyphs[0].getBoundingClientRect();
      const b = glyphs[1].getBoundingClientRect();
      return (b.left - a.right) / a.width;
    },
    tol: 0.002,
  },
  "stars.emptyOpacity": {
    kind: "absent",
    note: "the reference draws the unfilled outline at 30% of the tint; web draws two clipped copies "
      + "of the same glyph and tints them, so there is no opacity on a box to read - a colour fact",
  },

  // ── toggle ──────────────────────────────────────────────────────────────────────────
  "toggle.width": {
    kind: "drift", case: "toggle", web: 42,
    note: "the reference IS UISwitch, whose 51x31 metric the corpus README calls the cross-platform "
      + "contract, and Compose renders exactly that (ElementSpec.kt TOGGLE_WIDTH). Web renders its own "
      + "42x24 track. Note the web renderer already spells the reference metric in a second place - "
      + "forms.ts .dsx-field-toggle-label pins 51/31/27/2 - so the two web switches disagree with each other",
    probe: "the rendered width of the switch track",
    measure: (root) => {
      const track = root.querySelector(".dsx-toggle-track");
      return track === null ? null : track.getBoundingClientRect().width;
    },
  },
  "toggle.height": {
    kind: "drift", case: "toggle", web: 24,
    note: "the UISwitch height the corpus pins is 31; the web track is 24",
    probe: "the rendered height of the switch track",
    measure: (root) => {
      const track = root.querySelector(".dsx-toggle-track");
      return track === null ? null : track.getBoundingClientRect().height;
    },
  },
  "toggle.thumb": {
    kind: "drift", case: "toggle", web: 20,
    note: "the UISwitch thumb the corpus pins is 27; the web thumb is 20",
    probe: "the rendered diameter of the switch thumb",
    measure: (root) => {
      const thumb = root.querySelector(".dsx-toggle-thumb");
      return thumb === null ? null : thumb.getBoundingClientRect().width;
    },
  },
  "toggle.thumbInset": {
    kind: "assert", case: "toggle",
    probe: "the gap between the thumb and the track's near edge, measured on the ON side",
    measure: (root) => {
      const track = root.querySelector(".dsx-toggle-track");
      const thumb = root.querySelector(".dsx-toggle-thumb");
      if (track === null || thumb === null) return null;
      return track.getBoundingClientRect().right - thumb.getBoundingClientRect().right;
    },
    tol: 0.1,
  },

  // ── rangeslider ─────────────────────────────────────────────────────────────────────
  "rangeslider.thumb": {
    kind: "drift", case: "rangeslider", web: 22,
    note: "the reference thumb is 24; the web thumb rides the density plane's --dsx-slider-thumb-size (22)",
    probe: "the thumb diameter, measured through the track's end inset (the track is inset by half a "
      + "thumb at each end, so twice that inset IS the thumb)",
    measure: (root) => {
      const slider = root.querySelector(".dsx-rangeslider");
      const track = root.querySelector(".dsx-rangeslider-track");
      if (slider === null || track === null) return null;
      return 2 * (track.getBoundingClientRect().left - slider.getBoundingClientRect().left);
    },
  },
  "rangeslider.track": {
    kind: "assert", case: "rangeslider",
    probe: "the rendered thickness of the slider track",
    measure: (root) => {
      const track = root.querySelector(".dsx-rangeslider-track");
      return track === null ? null : track.getBoundingClientRect().height;
    },
  },
  "rangeslider.controlHeight": {
    kind: "drift", case: "rangeslider", web: 48,
    note: "the reference gives the control a 28 box; web gives it --dsx-slider-box-height, the 48px "
      + "large control height, so the touch row is much taller than the drawn track",
    probe: "the rendered height of the whole slider control",
    measure: (root) => {
      const slider = root.querySelector(".dsx-rangeslider");
      return slider === null ? null : slider.getBoundingClientRect().height;
    },
  },
  "rangeslider.trackOpacity": {
    kind: "absent",
    note: "the reference tints the track at 18% of the primary ink; web mixes it into an opaque "
      + "colour with no alpha to read - a colour fact",
  },

  // ── qrcode ──────────────────────────────────────────────────────────────────────────
  "qrcode.size": {
    kind: "assert", case: "qrcode",
    probe: "the rendered width of the QR surface",
    measure: (root) => {
      const qr = root.querySelector(".dsx-qrcode");
      return qr === null ? null : qr.getBoundingClientRect().width;
    },
  },
  "qrcode.quietZoneFraction": {
    kind: "drift", case: "qrcode", web: 0.13793,
    note: "the reference pads the code by 6% of its size; web reserves the QR spec's 4-module quiet "
      + "zone, which for the version-1 code this harness renders is 4/29 of the surface",
    probe: "the quiet zone as a fraction of the code surface - the module path's bounding box offset "
      + "inside the SVG viewBox",
    measure: (root) => {
      const svg = root.querySelector(".dsx-qrcode svg");
      const path = root.querySelector(".dsx-qrcode path");
      if (svg === null || path === null) return null;
      const box = svg.getAttribute("viewBox");
      if (box === null) return null;
      const extent = parseFloat(box.split(/\s+/)[2]);
      return (path as SVGGraphicsElement).getBBox().x / extent;
    },
    tol: 0.0005,
  },

  // ── the stack family ────────────────────────────────────────────────────────────────
  "hstack.spacing": {
    kind: "assert", case: "stacks",
    probe: "the horizontal distance between two hstack children when spacing= is unset",
    measure: (root) => {
      const kids = root.querySelectorAll(".dsx-hstack > *");
      if (kids.length < 2) return null;
      return kids[1].getBoundingClientRect().left - kids[0].getBoundingClientRect().right;
    },
  },
  "vstack.spacing": {
    kind: "assert", case: "stacks",
    probe: "the vertical distance between two vstack children when spacing= is unset",
    measure: (root) => {
      const kids = root.querySelectorAll(".dsx-vstack > *");
      if (kids.length < 2) return null;
      return kids[1].getBoundingClientRect().top - kids[0].getBoundingClientRect().bottom;
    },
  },
  "stack.spacing": {
    kind: "assert", case: "stacks",
    probe: "the vertical distance between two <stack> children when spacing= is unset",
    measure: (root) => {
      const inner = root.querySelector(".dsx-stack .dsx-stack");
      if (inner === null) return null;
      const kids = inner.children;
      if (kids.length < 2) return null;
      return kids[1].getBoundingClientRect().top - kids[0].getBoundingClientRect().bottom;
    },
  },
  "list.spacing": {
    kind: "assert", case: "stacks",
    probe: "the vertical distance between two list rows when spacing= is unset",
    measure: (root) => {
      const rows = root.querySelectorAll(".dsx-list > *");
      if (rows.length < 2) return null;
      return rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom;
    },
  },

  // ── carousel ────────────────────────────────────────────────────────────────────────
  "carousel.peek": {
    kind: "assert", case: "carousel",
    probe: "the neighbouring-page peek reserved on a page when peek= is unset",
    measure: (root) => {
      const page = root.querySelector(".dsx-carousel .dsx-paged-page");
      return page === null ? null : parseFloat(getComputedStyle(page).paddingLeft);
    },
  },
  "carousel.spacing": {
    kind: "assert", case: "carousel-peek",
    probe: "the inter-page spacing, isolated by peeking a known 20 and subtracting it from the page's "
      + "inline padding (web spends peek + spacing on the same edge)",
    measure: (root) => {
      const page = root.querySelector(".dsx-carousel .dsx-paged-page");
      return page === null ? null : parseFloat(getComputedStyle(page).paddingLeft) - 20;
    },
  },

  // ── button ──────────────────────────────────────────────────────────────────────────
  "button.iconSize": {
    kind: "assert", case: "button",
    probe: "the rendered size of the glyph in an icon-only button",
    measure: (root) => {
      const buttons = root.querySelectorAll(".dsx-button");
      const glyph = buttons.length === 0 ? null : buttons[0].querySelector("svg");
      return glyph === null ? null : glyph.getBoundingClientRect().width;
    },
  },
  "button.labelIconSize": {
    kind: "assert", case: "button",
    probe: "the rendered size of the leading glyph in a labelled button",
    measure: (root) => {
      const buttons = root.querySelectorAll(".dsx-button");
      const glyph = buttons.length < 2 ? null : buttons[1].querySelector("svg");
      return glyph === null ? null : glyph.getBoundingClientRect().width;
    },
  },
  "button.labelIconSpacing": {
    kind: "assert", case: "button",
    probe: "the horizontal distance from a labelled button's glyph to its label",
    measure: (root) => {
      const buttons = root.querySelectorAll(".dsx-button");
      if (buttons.length < 2) return null;
      const glyph = buttons[1].querySelector("svg");
      const label = buttons[1].querySelector("[data-dsx-part='label']");
      if (glyph === null || label === null) return null;
      return label.getBoundingClientRect().left - glyph.getBoundingClientRect().right;
    },
  },
  "button.pressScale": {
    kind: "drift", case: "button", web: 1,
    note: "the reference snaps a pressed button to 0.92 (StackButtonStyle); the web button does not "
      + "scale at all on press - it drops its content to 0.9 opacity instead",
    probe: "the uniform scale of the button's transform while the pointer holds it down (see "
      + "INTERACTION in the browser runner)",
    measure: null as unknown as (root: HTMLElement) => number | null,
    tol: 0.001,
  },

  // ── the honest remainder: real keys, no probe written yet ───────────────────────────
  "chart.lineWidth": { kind: "absent", note: "UNPROBED - the chart series renderer is not yet in a harness" },
  "chart.pointSize": { kind: "absent", note: "UNPROBED - the chart series renderer is not yet in a harness" },
  "chart.areaOpacity": { kind: "absent", note: "UNPROBED - and an area fill's alpha is a colour fact besides" },
  "combobox.maxVisibleRows": { kind: "absent", note: "UNPROBED - the open listbox needs an interaction harness" },
  "combobox.rowHeight": { kind: "absent", note: "UNPROBED - the open listbox needs an interaction harness" },
  "combobox.rowPaddingH": { kind: "absent", note: "UNPROBED - the open listbox needs an interaction harness" },
  "combobox.rowPaddingV": { kind: "absent", note: "UNPROBED - the open listbox needs an interaction harness" },
  "combobox.cardCornerRadius": { kind: "absent", note: "UNPROBED - the open listbox needs an interaction harness" },
  "image.iconSize": {
    kind: "assert", case: "button",
    probe: "the rendered width of an unsized icon glyph, which is what iconSize= defaults to",
    measure: (root) => {
      const svg = root.querySelector(".dsx-button svg");
      return svg === null ? null : svg.getBoundingClientRect().width;
    },
  },
  "image.placeholderOpacity": { kind: "absent", note: "UNPROBED - and a placeholder wash is a colour fact besides" },
  "map.zoom": { kind: "absent", note: "a map zoom LEVEL is not a box; nothing in the DOM measures it" },
  "map.routeWidth": { kind: "absent", note: "the web map draws no route polyline, so there is no stroke to measure" },
  "pressable.longPressMinDuration": { kind: "absent", note: "UNPROBED - a gesture timing, reachable only through a timed interaction" },
  "refreshable.graceMs": { kind: "absent", note: "a refresh grace window is a timing, not a box" },
  "refreshable.pollMs": { kind: "absent", note: "a poll interval is a timing, not a box" },
  "scaffold.widthNormalization": { kind: "absent", note: "the fixture value is a SENTENCE describing a clamping ORDER, not a number - nothing to measure" },
  "sheet.cardInset": { kind: "absent", note: "UNPROBED - the presented sheet needs its own portal harness" },
  "split.detailReadableInset": { kind: "absent", note: "UNPROBED - split's panes only exist above the expand breakpoint, outside this phone context" },
  "split.detailReadableTopInset": { kind: "absent", note: "UNPROBED - same breakpoint" },
  "textarea.minLines": { kind: "absent", note: "a LINE COUNT, not a distance. The reference "
    + "sizes the box in lines and the web box grows by content, so the only browser-visible "
    + "shadow of this number is a height divided by a line-height - a derived quantity that "
    + "would agree for the wrong reason whenever the leading differs. It is asserted where it "
    + "is actually decided: --dsx-textarea-max-lines in the sheet, and the autogrow test." },
  "textarea.maxLines": { kind: "absent", note: "the same line-count argument as minLines: a "
    + "cap on rows is only a pixel height once a leading is chosen, so measuring it here would "
    + "re-assert the leading rather than the cap. The cap itself is gated by the autogrow test, "
    + "which counts rows instead of pixels." },
};

export type Census = {
  asserted: number;
  allowlisted: number;
  drift: number;
  adapt: number;
  absent: number;
  total: number;
  unclassified: string[];
  stale: string[];
};

/** The three numbers, plus the two ways a ledger can rot: a corpus key with no entry, and an
 *  entry naming a key the corpus no longer has. */
export function census(): Census {
  const keys = geometryKeys();
  const known = new Set(keys.map((k) => k.where));
  let asserted = 0; let drift = 0; let adapt = 0; let absent = 0;
  const unclassified: string[] = [];
  for (const { where } of keys) {
    const entry = LEDGER[where];
    if (entry === undefined) { unclassified.push(where); continue; }
    if (entry.kind === "assert") asserted += 1;
    else if (entry.kind === "drift") drift += 1;
    else if (entry.kind === "adapt") adapt += 1;
    else absent += 1;
  }
  return {
    asserted, allowlisted: drift + adapt, drift, adapt, absent,
    total: keys.length, unclassified,
    stale: Object.keys(LEDGER).filter((w) => !known.has(w)).sort(),
  };
}
