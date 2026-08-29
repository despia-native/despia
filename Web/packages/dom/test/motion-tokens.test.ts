//
//  motion-tokens.test.ts - the wave-4 motion system gate (design-system.md "Motion
//  system"): the two spring easings ship as real sampled linear() curves behind
//  @supports, over cubic-bezier fallbacks that hold the pre-linear() browser floor;
//  both live ONCE in the shared (scheme-independent) token plane, never in the four
//  color tables; the duration ramp stays sane; and the reduced-motion collapse
//  neutralizes the springs (durations to 0ms AND the curves pinned back to the
//  non-overshooting standard ease).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOKENS_CSS } from "../src/theme.ts";

// ── the sheet's regions, sliced the way the sibling suites slice them ───────────────
const rootStart = TOKENS_CSS.indexOf(":root, :host {");
const mediaStart = TOKENS_CSS.indexOf("@media (prefers-color-scheme: dark)");
const darkPinStart = TOKENS_CSS.indexOf(`[data-dsx-theme="dark"]`);
const lightPinStart = TOKENS_CSS.indexOf(`[data-dsx-theme="light"]`);
const aliasStart = TOKENS_CSS.indexOf(":root, :host, [data-dsx-theme] {");
const aliasBlock = TOKENS_CSS.slice(aliasStart, TOKENS_CSS.indexOf("}", aliasStart));
const schemeTables = TOKENS_CSS.slice(rootStart, aliasStart);

const supportsStart = TOKENS_CSS.indexOf("@supports (transition-timing-function: linear(0, 1))");
const supportsBlock = supportsStart < 0 ? "" : TOKENS_CSS.slice(
  supportsStart,
  TOKENS_CSS.indexOf("@media", supportsStart),
);
const reduceStart = TOKENS_CSS.indexOf("@media (prefers-reduced-motion: reduce)");
const reduceBlock = reduceStart < 0 ? "" : TOKENS_CSS.slice(
  reduceStart,
  TOKENS_CSS.indexOf("/*", reduceStart),
);

const SPRINGS = ["--dsx-ease-spring", "--dsx-ease-spring-soft"] as const;

function linearStops(block: string, token: string): number[] {
  const match = block.match(new RegExp(`${token}: linear\\(([^)]+)\\);`));
  assert.ok(match, `${token} declares a linear() curve in the block`);
  return match[1]!.split(",").map((stop) => {
    const value = Number.parseFloat(stop.trim());
    assert.ok(Number.isFinite(value), `${token}: stop "${stop}" parses`);
    return value;
  });
}

function duration(block: string, token: string): number {
  const match = block.match(new RegExp(`${token}: (\\d+)ms;`));
  assert.ok(match, `${token} declares a literal ms duration`);
  return Number(match[1]);
}

test("both spring easings exist once, in the shared scheme-independent plane", () => {
  assert.ok(aliasStart > lightPinStart, "the shared alias plane follows the pin tables");
  for (const token of SPRINGS) {
    assert.ok(aliasBlock.includes(`${token}: cubic-bezier(`), `${token} fallback lives in the shared plane`);
    assert.ok(!schemeTables.includes(`${token}:`),
      `${token} is never quadruplicated into the per-scheme color tables`);
  }
  // the ratified fallback pair (design-system.md): standard settle + barely-there
  assert.ok(aliasBlock.includes("--dsx-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);"));
  assert.ok(aliasBlock.includes("--dsx-ease-spring-soft: cubic-bezier(0.22, 1.2, 0.36, 1);"));
});

test("the linear() upgrade rides @supports, after the fallbacks, on the shared selector", () => {
  assert.ok(supportsStart >= 0, "the @supports (transition-timing-function: linear(0, 1)) guard exists");
  assert.ok(supportsStart > aliasStart, "the upgrade follows the bezier fallbacks so source order resolves it");
  assert.ok(supportsBlock.includes(":root, :host, [data-dsx-theme]"),
    "the upgrade re-declares on the same shared selector (equal specificity, later wins)");
});

test("spring curves are real sampled springs: >= 20 stops, 0 to 1, transform-safe overshoot", () => {
  const spring = linearStops(supportsBlock, "--dsx-ease-spring");
  const soft = linearStops(supportsBlock, "--dsx-ease-spring-soft");
  for (const [name, stops] of [["--dsx-ease-spring", spring], ["--dsx-ease-spring-soft", soft]] as const) {
    assert.ok(stops.length >= 20, `${name} carries >= 20 stops (has ${stops.length})`);
    assert.equal(stops[0], 0, `${name} starts at 0`);
    assert.equal(stops[stops.length - 1], 1, `${name} ends settled at exactly 1`);
    const peak = Math.max(...stops);
    assert.ok(peak > 1, `${name} genuinely overshoots (a spring, not an ease)`);
    assert.ok(stops.every((value) => value >= 0), `${name} never undershoots below 0`);
    const settleTail = stops.slice(Math.floor(stops.length * 0.75));
    assert.ok(settleTail.every((value) => Math.abs(value - 1) <= 0.02),
      `${name} is settled (within 2%) across its final quarter`);
  }
  // the ruling's two characters: subtle overshoot vs barely-there bounce
  const springPeak = Math.max(...spring);
  const softPeak = Math.max(...soft);
  assert.ok(springPeak >= 1.01 && springPeak <= 1.03,
    `--dsx-ease-spring overshoot is subtle, not bouncy (peak ${springPeak})`);
  assert.ok(softPeak > 1 && softPeak <= 1.01,
    `--dsx-ease-spring-soft overshoot is barely-there (peak ${softPeak})`);
  assert.ok(softPeak < springPeak, "the soft curve bounces less than the standard curve");
});

test("the duration ramp is sane and the spec's --dsx-duration-* names resolve onto it", () => {
  const fast = duration(aliasBlock, "--dsx-dur-fast");
  const base = duration(aliasBlock, "--dsx-dur-base");
  const slow = duration(aliasBlock, "--dsx-dur-slow");
  assert.ok(fast < base && base < slow, `durations are ordered fast < base < slow (${fast}/${base}/${slow})`);
  for (const speed of ["fast", "base", "slow"]) {
    assert.ok(aliasBlock.includes(`--dsx-duration-${speed}: var(--dsx-dur-${speed});`),
      `--dsx-duration-${speed} aliases the canonical token so the reduced-motion collapse reaches it`);
  }
});

test("the reduced-motion collapse neutralizes the springs: 0ms durations AND no overshoot", () => {
  assert.ok(reduceStart > supportsStart, "the collapse follows the linear() upgrade so it wins source order");
  for (const token of ["--dsx-dur-fast", "--dsx-dur-base", "--dsx-dur-slow", "--dsx-motion-fast", "--dsx-motion-standard"]) {
    assert.ok(reduceBlock.includes(`${token}: 0ms;`), `${token} collapses to 0ms`);
  }
  for (const token of SPRINGS) {
    assert.ok(reduceBlock.includes(`${token}: var(--dsx-ease);`),
      `${token} loses its overshoot under prefers-reduced-motion`);
  }
});
