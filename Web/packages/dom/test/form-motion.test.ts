//
//  form-motion.test.ts - the wave-4 form-plane fidelity contract. Motion is part of
//  the default, so the per-state intent (transition property lists, spring easing on
//  transform only, press geometry, reveal animations, reduced-motion collapse) is
//  pinned here against the weak element-layer sheets, plus the retained ARIA anatomy.
//
//  The checkbox / radio / stepper FACTORIES live outside the form plane's two files
//  (globals.ts, data-controls.ts, elements.ts), so their form-plane pass is the
//  deterministic-specificity CSS adaptation asserted below: the check mark draws via
//  a two-stage pseudo-element reveal (the CSS twin of an SVG dashoffset draw), not an
//  SVG child, because this plane may not edit those factories.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FORM_ELEMENTS_CSS } from "../src/forms.ts";
import { NATIVE_CONTROLS_CSS } from "../src/native-controls.ts";

/** All bodies of `@media <marker> ... { ... }` blocks, brace-matched. */
function mediaBlocks(css: string, marker: string): string[] {
  const out: string[] = [];
  for (let from = css.indexOf(marker); from >= 0; from = css.indexOf(marker, from + 1)) {
    const open = css.indexOf("{", from);
    let depth = 1;
    let index = open + 1;
    while (index < css.length && depth > 0) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") depth -= 1;
      index += 1;
    }
    out.push(css.slice(open + 1, index - 1));
  }
  return out;
}

/** The first flat `selector { ... }` body. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule: ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

test("the web switch polyfill is the 63x28 iOS-26-ish capsule: flat crossfade track, white pill thumb", () => {
  const label = rule(FORM_ELEMENTS_CSS, ".dsx-field-toggle-label");
  assert.ok(label.includes("--dsx-field-toggle-width: 63px"));
  assert.ok(label.includes("--dsx-field-toggle-height: 28px"));
  assert.ok(label.includes("--dsx-field-toggle-thumb-width: 36px"));
  assert.ok(label.includes("--dsx-field-toggle-thumb: 24px"));
  assert.ok(label.includes("--dsx-field-toggle-inset: 2px"));
  assert.ok(label.includes("--dsx-field-toggle-stretch: 6px"));
  assert.ok(
    label.includes("--dsx-field-toggle-travel: calc(var(--dsx-field-toggle-width) - var(--dsx-field-toggle-thumb-width) - 2 * var(--dsx-field-toggle-inset))"),
    "travel derives from the geometry so density variants stay consistent",
  );

  const track = rule(FORM_ELEMENTS_CSS, ".dsx-field-toggle-input");
  assert.ok(track.includes("background-color var(--dsx-dur-base) var(--dsx-ease)"),
    "the track crossfades fill to accent over the base duration");
  assert.ok(!track.includes("linear-gradient"), "a gradient track cannot crossfade; the pill is flat");
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-field-toggle-input:checked").includes("background: var(--dsx-switch-on)"));

  const thumb = rule(FORM_ELEMENTS_CSS, ".dsx-field-toggle-input::after");
  assert.ok(thumb.includes("background: var(--dsx-control-knob)"), "white thumb in both schemes via the knob token");
  assert.ok(thumb.includes("box-shadow: var(--dsx-shadow-1)"), "the small shadow in both schemes");
  assert.ok(thumb.includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"), "travel and settle spring");
  assert.ok(thumb.includes("width var(--dsx-dur-fast) var(--dsx-ease)"), "the stretch is plain ease: overshoot on transform only");
  assert.ok(thumb.includes("will-change: transform"), "the one justified transform-gpu hint: the moving thumb");
});

test("pressing the switch stretches the thumb 6px toward center on the checked side, RTL mirrored", () => {
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-field-toggle-input:not(:disabled):active::after")
    .includes("width: calc(var(--dsx-field-toggle-thumb-width) + var(--dsx-field-toggle-stretch))"));
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-field-toggle-input:checked:not(:disabled):active::after")
    .includes("translateX(calc(var(--dsx-field-toggle-travel) - var(--dsx-field-toggle-stretch)))"),
    "checked press subtracts the stretch so the far edge stays planted");
  assert.ok(FORM_ELEMENTS_CSS.includes('[dir="rtl"] .dsx-field-toggle-input:not(:checked):not(:disabled):active::after'));
  assert.ok(FORM_ELEMENTS_CSS.includes('[dir="rtl"] .dsx-field-toggle-input:checked:not(:disabled):active::after { transform: translateX(0); }'));
  // Keyboard parity: the switch is a real checkbox input (Space holds :active), so the
  // same :active rules animate keyboard and pointer identically.
  const source = readFileSync(new URL("../src/forms.ts", import.meta.url), "utf8");
  assert.ok(source.includes('if (type === "toggle") input.setAttribute("role", "switch")'));
  // Hit target: the padded label row keeps the 44px-class target, 48px on coarse pointers.
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-field-toggle-label").includes("min-height: var(--dsx-control-height)"));
  const coarse = mediaBlocks(FORM_ELEMENTS_CSS, "@media (pointer: coarse)")[0]!;
  assert.ok(coarse.includes(".dsx-field-toggle-label { min-height: 48px;"));
  // Density: the compact 51x24 capsule rides the fine-pointer desktop media.
  const desktop = mediaBlocks(FORM_ELEMENTS_CSS, "@media (min-width: 64rem) and (hover: hover) and (pointer: fine)")
    .find((block) => block.includes("--dsx-field-toggle-width"));
  assert.ok(desktop !== undefined);
  assert.ok(desktop.includes("--dsx-field-toggle-width: 51px"));
  assert.ok(desktop.includes("--dsx-field-toggle-height: 24px"));
  assert.ok(desktop.includes("--dsx-field-toggle-thumb-width: 30px"));
  assert.ok(desktop.includes("--dsx-field-toggle-thumb: 20px"));
});

test("fields: focus ring + border-ink lift + label shift; error slides 4px, never shakes", () => {
  const control = rule(FORM_ELEMENTS_CSS, ".dsx-field-control");
  for (const item of [
    "border-color var(--dsx-dur-base) var(--dsx-ease)",
    "background-color var(--dsx-dur-fast) var(--dsx-ease)",
    "box-shadow var(--dsx-dur-base) var(--dsx-ease)",
  ]) assert.ok(control.includes(item), item);
  const focused = rule(FORM_ELEMENTS_CSS, ".dsx-field-control:focus-visible");
  assert.ok(focused.includes("box-shadow: var(--dsx-focus-ring)"));
  assert.ok(focused.includes("border-color: var(--dsx-label)"),
    "focus animates the well border to label ink alongside the ring");
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-field-label").includes("transition: color var(--dsx-dur-base) var(--dsx-ease)"));
  assert.ok(FORM_ELEMENTS_CSS.includes(".dsx-field:focus-within > .dsx-field-label { color: var(--dsx-accent); }"));

  assert.ok(FORM_ELEMENTS_CSS.includes(
    ".dsx-field-error:not([hidden]) { animation: dsx-field-error-in var(--dsx-dur-base) var(--dsx-ease); }",
  ));
  const keyframes = mediaBlocks(FORM_ELEMENTS_CSS, "@keyframes dsx-field-error-in")[0]!;
  assert.ok(keyframes.includes("translateY(-4px)"));
  assert.ok(!keyframes.includes("translateX"), "no shake: the reveal is a 4px slide, not a wobble");
  // Press scale never lands on text inputs.
  assert.ok(!FORM_ELEMENTS_CSS.includes(".dsx-field-control:active"));
});

test("the field WELL: xs elevation seat + soft fill + size-rhythm radius, and a reserved error slot", () => {
  const control = rule(FORM_ELEMENTS_CSS, ".dsx-field-control");
  assert.ok(control.includes("box-shadow: var(--dsx-shadow-xs)"),
    "the well sits on the xs whisper (contact line light, inner highlight dark)");
  assert.ok(control.includes("background: var(--dsx-surface-recessed)"), "the soft recessed fill");
  assert.ok(control.includes("border: 1px solid var(--dsx-outline-soft)"),
    "the hard separator hairline relaxes where the contact line defines the edge");
  assert.ok(control.includes("border-radius: var(--dsx-field-well-radius, var(--dsx-radius-lg))"),
    "the radius rides the size rhythm: 14px mobile scale, 12px at the 64rem fine step, 8px via the compact re-pin");
  // Focus keeps the well seated under the ring, on the valid and the danger path.
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-field-control:focus-visible")
    .includes("box-shadow: var(--dsx-focus-ring), var(--dsx-shadow-xs)"));
  assert.ok(rule(FORM_ELEMENTS_CSS,
    '.dsx-field[data-dsx-invalid="true"] .dsx-field-control[aria-errormessage]:focus-visible')
    .includes("var(--dsx-shadow-xs)"));

  // The helper/error slot is reserved: hidden keeps the exact one-line box, so a
  // revealing error never jumps layout.
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-field-error").includes("min-height: 1.35em"));
  assert.ok(FORM_ELEMENTS_CSS.includes(".dsx-field-error[hidden] { display: block; visibility: hidden; }"));
  assert.ok(!FORM_ELEMENTS_CSS.includes(".dsx-field-error[hidden] { display: none; }"));

  // The native-control wells share the same surface contract.
  const nativeWell = rule(NATIVE_CONTROLS_CSS, ".dsx-picker-select, .dsx-datepicker-input, .dsx-combobox-input");
  assert.ok(nativeWell.includes("box-shadow: var(--dsx-shadow-xs)"));
  assert.ok(nativeWell.includes("background: var(--dsx-surface-recessed)"));
  assert.ok(nativeWell.includes("border-radius: var(--dsx-field-well-radius, var(--dsx-radius-lg))"));
  assert.ok(nativeWell.includes("background-color var(--dsx-dur-fast) var(--dsx-ease)"));
  assert.ok(rule(NATIVE_CONTROLS_CSS,
    ".dsx-picker-select:focus-visible,\n  .dsx-datepicker-input:focus-visible, .dsx-combobox-input:focus-visible")
    .includes("border-color: var(--dsx-label)"));
});

test("the form submit control obeys the width law and the press standard", () => {
  const submit = rule(FORM_ELEMENTS_CSS, ".dsx-button.dsx-form-submit");
  assert.ok(submit.includes("width: 100%"), "a form's submit control is full-width by default");
  assert.ok(submit.includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"), "release springs back");
  assert.ok(submit.includes("opacity var(--dsx-dur-fast) linear"), "opacity stays linear");
  const active = rule(FORM_ELEMENTS_CSS, '.dsx-button.dsx-form-submit:not(:disabled):not([aria-disabled="true"]):active');
  assert.ok(active.includes("transform: scale(0.97)"));
  assert.ok(active.includes("transition-duration: var(--dsx-dur-fast)"), "press-in is fast; the spring is for release");
});

test("checkbox adaptation: fill pops 0.5 to 1, the check draws in two staged strokes, uncheck snaps", () => {
  const fill = rule(FORM_ELEMENTS_CSS, '.dsx-checkbox[data-dsx-component="checkbox"] .dsx-checkbox-box::before');
  assert.ok(fill.includes("transform: scale(.5)"));
  assert.ok(fill.includes("opacity: 0"));
  assert.ok(fill.includes("transition: none"), "the resting state owns the instant reverse");
  const checkedFill = rule(FORM_ELEMENTS_CSS,
    '.dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box::before');
  assert.ok(checkedFill.includes("transform: scale(1)"));
  assert.ok(checkedFill.includes("opacity var(--dsx-dur-base) linear"));

  const mark = rule(FORM_ELEMENTS_CSS, '.dsx-checkbox[data-dsx-component="checkbox"] .dsx-checkbox-box::after');
  assert.ok(mark.includes("width: 0"));
  assert.ok(mark.includes("height: 0"));
  assert.ok(mark.includes("transform-origin: 100% 100%"), "the vertex anchors the rotation while the strokes grow");
  assert.ok(mark.includes("transition: none"), "uncheck reverses instantly");
  const drawn = rule(FORM_ELEMENTS_CSS,
    '.dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box::after');
  // The 90/200 and 160/290 pins were the same choreography written as arithmetic the
  // reader had to redo: stroke one waits out the fill, stroke two starts the instant
  // stroke one lands. Both delays are now that relation, so the ramp moves them together
  // and the reduced-motion override collapses the whole mark to 0ms.
  assert.ok(drawn.includes("width var(--dsx-dur-fast) var(--dsx-ease) var(--dsx-dur-base)"),
    "stroke one waits out the fill pop, which is one base rung");
  assert.ok(drawn.includes("height var(--dsx-dur-base) var(--dsx-ease) calc(var(--dsx-dur-base) + var(--dsx-dur-fast))"),
    "stroke two starts exactly when stroke one lands: the fill rung plus stroke one's own");
  assert.ok(rule(FORM_ELEMENTS_CSS,
    '.dsx-checkbox[data-dsx-component="checkbox"] input:not(:disabled):active + .dsx-checkbox-box')
    .includes("transform: scale(.95)"), "wrapper press is the selection-control 0.95");
  assert.ok(rule(FORM_ELEMENTS_CSS, '.dsx-checkbox[data-dsx-component="checkbox"]')
    .includes("--dsx-checkbox-size: 20px"));
});

test("radio and stepper adaptation: springing mark with 0.95 press, stepper buttons press at 0.97", () => {
  const mark = rule(FORM_ELEMENTS_CSS, '.dsx-radio-group[role="radiogroup"] .dsx-radio-mark');
  assert.ok(mark.includes("border-color var(--dsx-dur-base) var(--dsx-ease)"), "the ring color transition");
  assert.ok(mark.includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"));
  assert.ok(rule(FORM_ELEMENTS_CSS, '.dsx-radio-group[role="radiogroup"] .dsx-radio-option:active .dsx-radio-mark')
    .includes("transform: scale(.95)"));
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-stepper .dsx-stepper-btn:not(:disabled):active")
    .includes("transform: scale(0.97)"));
  assert.ok(rule(FORM_ELEMENTS_CSS, ".dsx-stepper .dsx-stepper-btn")
    .includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"));
});

test("OTP active digits lift 1.04x on the spring", () => {
  const box = rule(NATIVE_CONTROLS_CSS, ".dsx-otp-box");
  assert.ok(box.includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"),
    "the active-digit lift releases on the spring");
  assert.ok(rule(NATIVE_CONTROLS_CSS, '.dsx-otp-box[data-active="true"]').includes("transform: scale(1.04)"));
  const nativeReduce = mediaBlocks(NATIVE_CONTROLS_CSS, "@media (prefers-reduced-motion: reduce)")[0]!;
  assert.ok(nativeReduce.includes(".dsx-otp-box") && nativeReduce.includes("transition: none"),
    "OTP boxes collapse under reduced motion");
});

test("the range slider thumb grows 1.15x while grabbed and springs back on release, both engines", () => {
  for (const engine of ["-webkit-slider-thumb", "-moz-range-thumb"]) {
    const base = rule(NATIVE_CONTROLS_CSS, `.dsx-rangeslider-input::${engine}`);
    assert.ok(base.includes("transform var(--dsx-dur-base) var(--dsx-ease-spring)"), engine);
    const grabbed = rule(NATIVE_CONTROLS_CSS, `.dsx-rangeslider-input:not(:disabled):active::${engine}`);
    assert.ok(grabbed.includes("transform: scale(1.15)"), engine);
    assert.ok(grabbed.includes("transition-duration: var(--dsx-dur-fast)"), engine);
  }
  // Native-control fields share the field state-change standard: base-duration color work.
  assert.ok(NATIVE_CONTROLS_CSS.includes("border-color var(--dsx-dur-base) var(--dsx-ease)"));
});

test("spring easing rides transform only; color and opacity never overshoot", () => {
  for (const css of [FORM_ELEMENTS_CSS, NATIVE_CONTROLS_CSS]) {
    const springs = css.split("var(--dsx-ease-spring)").length - 1;
    const transformSprings = (css.match(/transform var\(--dsx-dur-(?:fast|base|slow)\) var\(--dsx-ease-spring\)/g) ?? []).length;
    assert.ok(springs > 0);
    assert.equal(springs, transformSprings, "every spring is a transform transition");
  }
});

test("hover styling stays behind hover:hover, and everything collapses under reduced motion", () => {
  const hover = mediaBlocks(FORM_ELEMENTS_CSS, "@media (hover: hover) and (pointer: fine)")[0]!;
  assert.ok(hover.includes(".dsx-field-control:hover:not(:focus-visible):not(:disabled)"));
  assert.ok(hover.includes("background: color-mix(in srgb, var(--dsx-surface-recessed) 95%, var(--dsx-label))"),
    "hover deepens the well fill one step");
  assert.ok(hover.includes(".dsx-field-select:hover:not(:focus-visible):not(:disabled)"),
    "selects are :read-only by spec, so the deepening names them explicitly");
  assert.ok(hover.includes(".dsx-field-toggle-input:not(:checked):not(:disabled):hover"));
  const nativeHover = mediaBlocks(NATIVE_CONTROLS_CSS, "@media (hover: hover) and (pointer: fine)");
  assert.ok(nativeHover.some((block) => block.includes(":hover::-webkit-slider-thumb")));
  assert.ok(nativeHover.some((block) => block.includes(".dsx-combobox-clear:hover")),
    "the clear affordance's polish stays behind hover:hover");

  const reduce = mediaBlocks(FORM_ELEMENTS_CSS, "@media (prefers-reduced-motion: reduce)")[0]!;
  for (const still of [
    ".dsx-field-toggle-input::after",
    ".dsx-button.dsx-form-submit",
    '.dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box::after',
    '.dsx-radio-group[role="radiogroup"] .dsx-radio-mark',
    ".dsx-stepper .dsx-stepper-btn",
  ]) assert.ok(reduce.includes(still), still);
  assert.ok(reduce.includes(".dsx-field-error:not([hidden]) { animation: none; }"));
  const nativeReduce = mediaBlocks(NATIVE_CONTROLS_CSS, "@media (prefers-reduced-motion: reduce)")[0]!;
  assert.ok(nativeReduce.includes(".dsx-rangeslider-input::-webkit-slider-thumb { transition: none; }"));
  assert.ok(nativeReduce.includes(".dsx-rangeslider-input::-moz-range-thumb { transition: none; }"));
  assert.ok(nativeReduce.includes(".dsx-combobox-clear"), "the clear affordance goes still too");
});

test("the picker chevron rests on secondary ink and springs open on focus-within", () => {
  const chevron = rule(NATIVE_CONTROLS_CSS, ".dsx-picker::after");
  assert.ok(chevron.includes("border: 0 solid var(--dsx-secondary-label)"),
    "rest ink is secondary, not the accent");
  assert.ok(chevron.includes("inset-inline-end: var(--dsx-control-padding-inline)"),
    "the chevron is logical, not pinned to the physical right");
  assert.ok(!chevron.includes("inset:"), "physical inset would stay on the wrong edge in RTL");
  assert.ok(chevron.includes("transform var(--dsx-dur-slow) var(--dsx-ease-spring)"),
    "open/close rides the spring");
  const open = rule(NATIVE_CONTROLS_CSS, ".dsx-picker:focus-within::after");
  assert.ok(open.includes("transform: rotate(225deg)"), "open flips the chevron");
  assert.ok(open.includes("border-color: var(--dsx-accent)"), "focus takes the accent");
  const reduce = mediaBlocks(NATIVE_CONTROLS_CSS, "@media (prefers-reduced-motion: reduce)").join("\n");
  assert.ok(reduce.includes(".dsx-picker::after"), "reduced motion silences the chevron");
});

test("the datepicker indicator is native chrome, brightened on hover and focus", () => {
  const indicator = rule(NATIVE_CONTROLS_CSS, ".dsx-datepicker-input::-webkit-calendar-picker-indicator");
  assert.ok(indicator.includes("opacity: .72"));
  assert.ok(indicator.includes("opacity var(--dsx-dur-fast) var(--dsx-ease)"));
  assert.ok(NATIVE_CONTROLS_CSS.includes(
    ".dsx-datepicker-input:hover::-webkit-calendar-picker-indicator",
  ));
});

test("the ARIA contract of the form plane is retained", () => {
  const forms = readFileSync(new URL("../src/forms.ts", import.meta.url), "utf8");
  for (const kept of [
    'input.setAttribute("role", "switch")',
    'control.setAttribute("aria-describedby", errorId)',
    'control.setAttribute("aria-invalid", String(shownError.length > 0))',
    'control.setAttribute("aria-errormessage", errorId)',
    'error.setAttribute("role", "alert")',
    'error.setAttribute("aria-live", "polite")',
  ]) assert.ok(forms.includes(kept), kept);
  const native = readFileSync(new URL("../src/native-controls.ts", import.meta.url), "utf8");
  for (const kept of [
    'wrap.setAttribute("role", "group")',
    'lowInput.setAttribute("aria-valuenow", String(low))',
    'input.setAttribute("role", "combobox")',
  ]) assert.ok(native.includes(kept), kept);
});
