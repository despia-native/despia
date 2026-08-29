//
//  defaults-corpus.test.ts - the five new axes are a CONTRACT, not a document.
//
//  tokens.json ratified colour and theme.test.ts pinned it, and colour is the one foundation
//  axis that never drifted. Type, elevation, state, shape and motion were specified in
//  design-system.md Part 1 in 2026-08-17, shipped on web, and were pinned by nobody - so the
//  cross-runtime law lived in a CSS comment and the native columns were never written at all.
//  runtime-pressure.md R22 is the diagnosis; these files are the vocabulary; this is the gate.
//
//  WHAT IT ASSERTS, and why each half matters:
//
//  1. Every web value in the corpus is the value the sheet actually emits. A corpus that has
//     drifted from the renderer is worse than none: it reads as the law while describing
//     something that stopped being true.
//  2. Every role carries every platform column. The Apple and Compose columns are the whole
//     point of the file - they are what makes it cross-runtime rather than a second copy of
//     the CSS - and a missing one is how an axis quietly becomes web-only again.
//  3. Native columns are ROLE NAMES, never values. The moment a px or an ms appears in an ios
//     or android column, this repository has re-specified a system look, which is the mistake
//     the constitution refuses by name.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ELEMENTS_CSS, TOKENS_CSS, TYPE_ROLES } from "../src/theme.ts";

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../Conformance/defaults");
const NATIVE = ["ios", "watchos", "macos", "android", "wear", "windows", "linux"] as const;
const AXES = ["type", "elevation", "state", "shape", "motion"] as const;

type Row = { [k: string]: unknown; web: { [k: string]: string } };
const load = (axis: string): { [role: string]: Row } =>
  JSON.parse(readFileSync(join(CORPUS, `${axis}.json`), "utf8")).tokens;

/** The sheet's declared value for one custom property, whitespace-normalised. */
function declared(name: string): string | null {
  const m = new RegExp(`${name.replace(/[-]/g, "\\-")}:\\s*([^;]+);`).exec(TOKENS_CSS);
  return m ? m[1]!.replace(/\s+/g, " ").trim() : null;
}

test("every axis file exists and every role carries every platform column", () => {
  const present = readdirSync(CORPUS).filter((f) => f.endsWith(".json"));
  for (const axis of AXES) {
    assert.ok(present.includes(`${axis}.json`), `${axis}.json is missing from the corpus`);
    const rows = load(axis);
    assert.ok(Object.keys(rows).length > 0, `${axis}.json declares no roles`);
    for (const [role, row] of Object.entries(rows)) {
      for (const col of NATIVE) {
        assert.ok(typeof row[col] === "string" && (row[col] as string).length > 0,
          `${axis}.${role} has no ${col} column - the native columns are what make this corpus cross-runtime`);
      }
      assert.ok(row.web && typeof row.web === "object", `${axis}.${role} has no web column`);
      assert.ok(typeof row.web["css"] === "string", `${axis}.${role}.web names no css property`);
    }
  }
});

test("native columns are role names, never re-specified values", () => {
  // A number with a unit in a native column means this repo decided what the platform's system
  // component should measure, which is the re-specified-system-look mistake. Role names may
  // contain digits (title1, level2, short4, caption1); a UNIT is the tell.
  const UNIT = /\b\d+(\.\d+)?\s*(px|dp|pt|rem|em|ms|s)\b|#[0-9a-fA-F]{3,8}\b|\brgba?\(/;
  for (const axis of AXES) {
    for (const [role, row] of Object.entries(load(axis))) {
      for (const col of NATIVE) {
        const v = row[col] as string;
        assert.ok(!UNIT.test(v),
          `${axis}.${role}.${col} = "${v}" carries a value; native columns name the platform's own role`);
      }
    }
  }
});

test("every web value in the corpus is what the token sheet actually emits", () => {
  const drift: string[] = [];
  const check = (label: string, css: string, expected: string): void => {
    const got = declared(css);
    if (got === null) { drift.push(`${label}: ${css} is not declared in TOKENS_CSS`); return; }
    if (got !== expected) drift.push(`${label}: ${css} sheet="${got}" corpus="${expected}"`);
  };
  for (const [role, r] of Object.entries(load("type"))) {
    const w = r.web;
    for (const [axis, key] of [["size", "size"], ["weight", "weight"],
                               ["tracking", "tracking"], ["leading", "leading"]] as const) {
      check(`type.${role}`, `${w["css"]}-${axis}`, w[key]!);
    }
  }
  // Elevation is a SCHEME TWIN, so both halves are pinned: the sheet declares the light value in
  // the base block and overrides it in the dark one, and a corpus that recorded only the first
  // would let the dark rung drift silently, which is the scheme nobody screenshots as often.
  for (const [role, r] of Object.entries(load("elevation"))) {
    const all = [...TOKENS_CSS.matchAll(
      new RegExp(`${r.web["css"]!.replace(/[-]/g, "\\-")}:\\s*([^;]+);`, "g"))]
      .map((m) => m[1]!.replace(/\s+/g, " ").trim());
    if (all[0] !== r.web["light"]) drift.push(`elevation.${role} light: sheet="${all[0]}" corpus="${r.web["light"]}"`);
    if (all[1] !== r.web["dark"]) drift.push(`elevation.${role} dark: sheet="${all[1]}" corpus="${r.web["dark"]}"`);
  }
  for (const [role, r] of Object.entries(load("shape"))) {
    // `control` and `card` are declared as aliases onto the base rungs; compare what they resolve
    // to rather than the spelling, since an alias is one value with two names.
    const got = declared(r.web["css"]!);
    assert.ok(got !== null, `shape.${role}: ${r.web["css"]} is not declared`);
    const resolved = /^var\(([^)]+)\)$/.test(got!) ? declared(/^var\(([^)]+)\)$/.exec(got!)![1]!) : got;
    if (resolved !== r.web["radius"]) {
      drift.push(`shape.${role}: sheet resolves to "${resolved}" corpus="${r.web["radius"]}"`);
    }
  }
  for (const [role, r] of Object.entries(load("motion"))) {
    if (r.web["duration"]) check(`motion.${role}`, r.web["css"]!, r.web["duration"]!);
    if (r.web["curve"]) check(`motion.${role}`, r.web["css"]!, r.web["curve"]!);
  }
  for (const [role, r] of Object.entries(load("state"))) {
    const want = r.web["opacity"] ?? r.web["value"];
    if (want) check(`state.${role}`, r.web["css"]!, want);
  }
  assert.deepEqual(drift, [],
    `the corpus and the sheet disagree. The corpus RATIFIES what ships, so either the sheet `
    + `changed without the corpus or the corpus was edited without the renderer:\n  ${drift.join("\n  ")}`);
});

test("the motion alias is declared and the canonical ramp is what the sheet reads", () => {
  for (const speed of ["fast", "base", "slow"]) {
    assert.equal(declared(`--dsx-duration-${speed}`), `var(--dsx-dur-${speed})`,
      `--dsx-duration-${speed} is a published alias onto the canonical ramp, not a second family`);
  }
});

test("the state layer derives from ONE tint, so an accent region restyles every state at once", () => {
  for (const role of ["hover", "focus", "pressed", "dragged", "selected"]) {
    const layer = declared(`--dsx-state-layer-${role}`);
    assert.ok(layer?.includes("var(--dsx-state-tint)"),
      `--dsx-state-layer-${role} must compose the shared tint, not a fixed colour`);
    assert.ok(layer?.includes(`var(--dsx-state-${role})`),
      `--dsx-state-layer-${role} must read its own strength rung`);
  }
});

// THE RAMP IS ONLY RATIFIED IF AN AUTHOR CAN NAME A RUNG. Twelve roles sat in the corpus
// with every native column filled and no markup word to reach them, and the Studio wrote
// font-size 152 times as a result (runtime-pressure.md R24). `<text type="...">` is that
// word, and these three assertions are what keep the word and the corpus one thing: a role
// added to the corpus without a rule is a role the web silently ignores, and a rule without
// a corpus row is a rung no other renderer has.
test("every corpus type role is reachable as <text type=...>, and no rule invents one", () => {
  const corpus = Object.keys(load("type"));
  assert.deepEqual([...TYPE_ROLES], corpus,
    "TYPE_ROLES is the corpus key order; a role added to one must be added to the other");
  const emitted = [...ELEMENTS_CSS.matchAll(/\.dsx-text\[data-dsx-type="([a-z0-9]+)"\]/g)]
    .map((m) => m[1]!);
  assert.deepEqual(emitted, corpus, "one element-layer rule per corpus role, in corpus order");
});

test("a type rule only POINTS at the ramp - it never decides a value", () => {
  for (const role of TYPE_ROLES) {
    const rule = ELEMENTS_CSS.match(
      new RegExp(`\\.dsx-text\\[data-dsx-type="${role}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    assert.notEqual(rule, "", `no rule for ${role}`);
    for (const prop of ["size", "weight", "tracking", "leading"]) {
      const css = { size: "font-size", weight: "font-weight", tracking: "letter-spacing", leading: "line-height" }[prop]!;
      assert.ok(rule.includes(`${css}: var(--dsx-type-${role}-${prop})`),
        `${role} must take ${css} from --dsx-type-${role}-${prop}, not from a literal`);
    }
    assert.ok(!/:\s*[^;]*\b\d/.test(rule.replace(/var\([^)]*\)/g, "")),
      `${role} rule carries a literal number outside a var()`);
  }
});
