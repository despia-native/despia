//
//  token-contrast.test.ts - the WCAG token gate: every semantic foreground/surface
//  pair the neutral skin ships must hold its contrast floor, per scheme. Values are
//  parsed out of TOKENS_CSS itself (never a copied table), and each scheme is checked
//  in BOTH of its spellings: the OS cascade (base :root / the prefers-color-scheme
//  twin) and the [data-dsx-theme] pin tables, which are full value tables that can
//  drift on their own for the non-corpus status tokens. Translucent surfaces (the
//  muted status chips) are composited over the scheme background before measuring,
//  which is exactly what the eye receives.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOKENS_CSS } from "../src/theme.ts";

type Rgba = { r: number; g: number; b: number; a: number };

// ── the sheet's value tables, sliced in ratified order (/web/17) ────────────────────
const rootStart = TOKENS_CSS.indexOf(":root, :host {");
const mediaStart = TOKENS_CSS.indexOf("@media (prefers-color-scheme: dark)");
const darkPinStart = TOKENS_CSS.indexOf(`[data-dsx-theme="dark"]`);
const lightPinStart = TOKENS_CSS.indexOf(`[data-dsx-theme="light"]`);
const aliasStart = TOKENS_CSS.indexOf(":root, :host, [data-dsx-theme] {");

function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--dsx-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim());
  }
  return out;
}

function merged(...layers: Map<string, string>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const layer of layers) for (const [name, value] of layer) out.set(name, value);
  return out;
}

const base = declarations(TOKENS_CSS.slice(rootStart, mediaStart));
const osDark = declarations(TOKENS_CSS.slice(mediaStart, darkPinStart));
const pinDark = declarations(TOKENS_CSS.slice(darkPinStart, lightPinStart));
const pinLight = declarations(TOKENS_CSS.slice(lightPinStart, aliasStart));
const aliases = declarations(TOKENS_CSS.slice(aliasStart, TOKENS_CSS.indexOf("}", aliasStart)));

const SCHEMES: { [scheme: string]: Map<string, string> } = {
  "light (OS)": merged(base, aliases),
  "dark (OS)": merged(base, osDark, aliases),
  "light (pin)": merged(base, pinLight, aliases),
  "dark (pin)": merged(base, pinDark, aliases),
};

function resolve(scheme: Map<string, string>, name: string): string {
  let value = scheme.get(name);
  for (let hop = 0; hop < 8 && value !== undefined; hop += 1) {
    const reference = /^var\((--dsx-[a-z0-9-]+)\)$/.exec(value);
    if (!reference) return value;
    value = scheme.get(reference[1]!);
  }
  return assert.fail(`token ${name} does not resolve to a literal value`);
}

function parseColor(name: string, raw: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex[1]!.slice(offset, offset + 2), 16));
    return { r: r!, g: g!, b: b!, a: 1 };
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(raw);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  }
  return assert.fail(`token ${name} is not a plain hex/rgb color: ${raw}`);
}

// ── WCAG 2.x relative luminance + contrast ratio, alpha composited ──────────────────
function linear(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Rgba): number {
  return (0.2126 * linear(color.r)) + (0.7152 * linear(color.g)) + (0.0722 * linear(color.b));
}

function over(foreground: Rgba, background: Rgba): Rgba {
  const mix = (front: number, back: number) => (foreground.a * front) + ((1 - foreground.a) * back);
  return { r: mix(foreground.r, background.r), g: mix(foreground.g, background.g), b: mix(foreground.b, background.b), a: 1 };
}

function contrast(first: Rgba, second: Rgba): number {
  const one = luminance(first);
  const two = luminance(second);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

// ── the shipped pairs and their floors ──────────────────────────────────────────────
const PAIRS = [
  { fg: "--dsx-label", bg: "--dsx-background", floor: 7, why: "body copy holds AAA" },
  { fg: "--dsx-secondary-label", bg: "--dsx-background", floor: 4.5, why: "secondary copy holds AA" },
  { fg: "--dsx-tertiary-label", bg: "--dsx-background", floor: 3, why: "tertiary/large copy holds AA-large" },
  { fg: "--dsx-on-accent", bg: "--dsx-accent", floor: 4.5, why: "prominent control labels hold AA" },
  { fg: "--dsx-danger", bg: "--dsx-danger-muted", floor: 4.5, why: "danger copy on its muted chip holds AA" },
  { fg: "--dsx-success", bg: "--dsx-success-muted", floor: 4.5, why: "success copy on its muted chip holds AA" },
  { fg: "--dsx-warning", bg: "--dsx-warning-muted", floor: 4.5, why: "warning copy on its muted chip holds AA" },
  { fg: "--dsx-label", bg: "--dsx-secondary-background", floor: 4.5, why: "labels on the grouped surface hold AA" },
] as const;

test("the token sheet parses into four complete scheme tables", () => {
  assert.ok(rootStart >= 0, "the :root base block exists");
  assert.ok(mediaStart > rootStart, "the OS-dark media block follows :root");
  assert.ok(darkPinStart > mediaStart, "the dark pin table follows the media block");
  assert.ok(lightPinStart > darkPinStart, "the light pin table follows the dark pin");
  assert.ok(aliasStart > lightPinStart, "the derived-alias block follows the pin tables");
  // the dark tables genuinely overrode the base values, so no scheme is light twice
  assert.notEqual(resolve(SCHEMES["dark (OS)"]!, "--dsx-label"), resolve(SCHEMES["light (OS)"]!, "--dsx-label"));
  assert.notEqual(resolve(SCHEMES["dark (pin)"]!, "--dsx-label"), resolve(SCHEMES["light (pin)"]!, "--dsx-label"));
  for (const [scheme, table] of Object.entries(SCHEMES)) {
    for (const pair of PAIRS) {
      parseColor(pair.fg, resolve(table, pair.fg));
      parseColor(pair.bg, resolve(table, pair.bg));
    }
    assert.equal(parseColor("--dsx-background", resolve(table, "--dsx-background")).a, 1, `${scheme}: the base background is opaque`);
  }
});

for (const [scheme, table] of Object.entries(SCHEMES)) {
  test(`${scheme}: every shipped foreground/surface pair holds its WCAG floor`, () => {
    const ground = parseColor("--dsx-background", resolve(table, "--dsx-background"));
    for (const pair of PAIRS) {
      const surface = over(parseColor(pair.bg, resolve(table, pair.bg)), ground);
      const foreground = over(parseColor(pair.fg, resolve(table, pair.fg)), surface);
      const ratio = contrast(foreground, surface);
      assert.ok(
        ratio >= pair.floor,
        `${scheme}: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}:1, floor ${pair.floor}:1 (${pair.why})`,
      );
    }
  });
}
