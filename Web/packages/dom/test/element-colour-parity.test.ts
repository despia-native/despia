//
//  element-colour-parity.test.ts - web is held to the element contract's COLOUR half.
//
//  THE HOLE THIS PARTLY CLOSES (runtime-pressure.md R23). Conformance/elements pins per-element
//  geometry and colours extracted from the Swift reference, with a _src citation on every value.
//  Compose is held to all of it by ElementParityTest.kt. Web read the same directory only to
//  assert that a TAG IS SUPPORTED - no colour, no geometry - so the web renderer was
//  contractually free to look like anything, and it took the offer.
//
//  WHY COLOUR AND NOT GEOMETRY. A colour in that corpus is a TOKEN NAME, which is a source fact
//  on every renderer and compares exactly. A geometry value is a measurement, and a spacing of 8
//  is only real if the box measures 8 - that needs a browser and a per-element probe, which is
//  the honest remainder reported below rather than faked here with a loose selector.
//
//  WHAT IS ASSERTED. Every semantic token the corpus names must have a web twin in the token
//  plane. That is the cross-runtime claim: a fixture cannot name a colour role the web renderer
//  has never heard of, which is precisely how one renderer drifts out of the contract.
//
//  AND WHAT IT FOUND. Four fixtures pin a RAW COLOUR rather than a role. That is a finding about
//  the REFERENCE, not about web: a hardcoded #2C2C2E cannot follow a scheme, a theme or an accent
//  on any of the three renderers. They are listed by name so they are visible rather than
//  averaged away, and the count is pinned so a fifth cannot appear quietly.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { TOKENS_CSS } from "../src/theme.ts";

const ELEMENTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../Conformance/elements");

/** corpus role -> the custom property the web renderer resolves it to. */
const WEB_TWIN: Readonly<Record<string, string>> = {
  accent: "--dsx-accent",
  label: "--dsx-label",
  secondary: "--dsx-secondary-label",
  tertiary: "--dsx-tertiary-label",
  separator: "--dsx-separator",
  fill: "--dsx-fill",
  destructive: "--dsx-destructive",
  background: "--dsx-background",
  secondaryBackground: "--dsx-secondary-background",
  groupedBackground: "--dsx-grouped-background",
  secondaryGroupedBackground: "--dsx-secondary-grouped-background",
  onAccent: "--dsx-on-accent",
  // `white`/`black` are ABSOLUTES on purpose: the ink on an accent fill and the two colours a
  // QR code may use. They are scheme-invariant by definition, so they have no token and are
  // not drift - the web twin of "white" is white.
  white: null as unknown as string,
  black: null as unknown as string,
  // A UIKit slot the corpus names directly. It is a real iOS role with no ratified web twin,
  // which is a NAMED divergence rather than a missing token.
  secondarySystemFill: null as unknown as string,
};

type Fixture = { tag: string; colors?: { [k: string]: { token?: string } } };

function fixtures(): Fixture[] {
  return readdirSync(ELEMENTS).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ELEMENTS, f), "utf8")) as Fixture & { _schema?: string })
    .filter((d) => "_schema" in d);
}

const colourKeys = (): { where: string; token: string }[] =>
  fixtures().flatMap((d) => Object.entries(d.colors ?? [])
    .filter(([, v]) => typeof v?.token === "string")
    .map(([k, v]) => ({ where: `${d.tag}.${k}`, token: v.token! })));

test("every semantic colour role the element corpus names has a web twin the sheet declares", () => {
  const missing: string[] = [];
  for (const { where, token } of colourKeys()) {
    if (token.startsWith("#")) continue;                      // raw colours: the test below
    if (!(token in WEB_TWIN)) {
      missing.push(`${where}: the corpus names role "${token}" and web has no mapping for it`);
      continue;
    }
    const css = WEB_TWIN[token];
    if (css === null || css === undefined) continue;          // absolute or named divergence
    if (!TOKENS_CSS.includes(`${css}:`)) {
      missing.push(`${where}: role "${token}" maps to ${css}, which the token sheet never declares`);
    }
  }
  assert.deepEqual(missing, [],
    `web cannot honour a colour role it does not have:\n  ${missing.join("\n  ")}`);
});

test("the reference pins four raw colours, and no more", () => {
  // Pinned so a fifth cannot land quietly. Each of these is a place the Swift reference wrote a
  // literal instead of a role, so it cannot follow scheme, theme or accent on ANY renderer.
  const KNOWN = [
    "ChatBubble.leftBubble", "ProgressRing.track",   // both #2C2C2E: a dark-scheme grey, frozen
    "chart.y2",                                       // #FF9500: a series colour
    "stars.fill",                                     // #FFCC00: the rating fill
  ].sort();
  const found = colourKeys().filter((c) => c.token.startsWith("#")).map((c) => c.where).sort();
  assert.deepEqual(found, KNOWN,
    "a fixture pinned a raw colour instead of a role. That is a defect in the REFERENCE - a "
    + "literal cannot follow a scheme on any renderer - so fix the fixture or add it here with "
    + "the reason it must be absolute.");
});

test("the parity coverage is reported honestly, asserted against unmapped", () => {
  const all = fixtures();
  const colours = colourKeys().length;
  const geometry = all.reduce((n, d) =>
    n + Object.keys((d as unknown as { geometry?: object }).geometry ?? {}).length, 0);
  // THE HONEST NUMBER. Colour is asserted; geometry is not, and pretending otherwise by mapping
  // a fixture key to "some box in the subtree" is the theatre R23 exists to avoid. This census
  // moves DOWN as browser probes land, and it fails if it moves up without being noticed.
  assert.equal(colours, 54, "colour keys in the corpus");   // +4: <Signature> ink/border/baseline/placeholder
  assert.equal(geometry, 113, "geometry keys in the corpus, none asserted against web yet (R23)");  // +7: <Signature>'s pad chrome (the ink law moved to canvas/ink.json)
  // 80 -> 79 (2026-08-29): Godot.json removed with the Core/Godot module, superseded
  // by the in-house Scene3D engine. One fixture, one named cause, nothing re-counted.
  assert.equal(all.length, 79, "fixtures in the corpus");
});
