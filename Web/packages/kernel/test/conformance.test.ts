//
//  conformance.test.ts - the cross-runtime conformance runner (TS twin of
//  Engine/Android ConformanceTest.kt). Executes every fixture in
//  OpenSource/Conformance/jse through this runtime's JSE and asserts with JSE's own
//  equality. Runs BOTH TS paths — the interpreter AND the compiled-JS closures — per
//  /web/07 ("the conformance corpus runs against BOTH TS paths").
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift
//  starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { JSE, StackStore } from "../src/jse/jse.ts";
import { evalCompiled } from "../src/compile/codegen.ts";
import { string, NSNull, isDict, type Dict } from "../src/jse/values.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/jse");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`OpenSource/Conformance/jse not found walking up from ${import.meta.dirname}`);
    dir = parent;
  }
}

/** JSON → JSE values: explicit nulls become the present-null sentinel (the twins'
 *  json() mapping), numbers are doubles already. */
function toJseValue(v: unknown): unknown {
  if (v === null) return NSNull;
  if (Array.isArray(v)) return v.map(toJseValue);
  if (typeof v === "object") {
    const out: Dict = {};
    for (const [k, val] of Object.entries(v as Dict)) out[k] = toJseValue(val);
    return out;
  }
  return v;
}

type Case = { name: string; scope: Dict; expression: string; expected: unknown };

const files = readdirSync(corpusDir()).filter((f) => f.endsWith(".json")).sort();
assert.ok(files.length > 0, "conformance corpus is empty — OpenSource/Conformance/jse/*.json");

for (const file of files) {
  const doc = JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as { cases?: Case[] };
  const cases = doc.cases;
  assert.ok(Array.isArray(cases), `${file}: no cases[]`);
  for (const c of cases!) {
    const expected = toJseValue(c.expected ?? null);
    const seed = (): StackStore => {
      const store = new StackStore();
      for (const [k, v] of Object.entries(c.scope ?? {})) store.vars.set(k, toJseValue(v));
      return store;
    };
    test(`${file.replace(/\.json$/, "")}/${c.name} [interpreter]`, () => {
      const actual = JSE.eval(c.expression, seed(), null);
      assert.ok(
        JSE.equals(actual, expected),
        `expression \`${c.expression}\` -> ${string(actual)} (expected ${string(expected)})`,
      );
    });
    test(`${file.replace(/\.json$/, "")}/${c.name} [compiled]`, () => {
      const actual = evalCompiled(c.expression, seed(), null);
      assert.ok(
        JSE.equals(actual, expected),
        `expression \`${c.expression}\` -> ${string(actual)} (expected ${string(expected)})`,
      );
    });
  }
}

// keep the import "used" for erasable-syntax type stripping
void isDict;
