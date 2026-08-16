//
//  lint.test.ts - the TS lint twin (doc 09 step 2) + the anti-drift corpus (step 3):
//  every fixture under OpenSource/Conformance/lint/cases/ runs through lintSource /
//  lintRoutes and must produce EXACTLY the expected (line, level, rule) set — message
//  wording is deliberately uncompared. cases/shared also runs on the Ruby linter
//  (ClosedSource/scripts/lint_conformance.rb) so rule logic cannot drift one-sided.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { lintSource, lintRoutes, type LintDiagnostic } from "../src/lint.ts";

const CASES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "Conformance", "lint", "cases");

function key(d: { line: number; level: string; rule: string }): string {
  return `${d.line}:${d.level}:${d.rule}`;
}

function expectFor(dir: string, name: string): string[] {
  const raw = JSON.parse(readFileSync(join(CASES, dir, name), "utf8")) as Array<{ line: number; level: string; rule: string }>;
  return raw.map(key).sort();
}

for (const dir of ["shared", "web"]) {
  for (const file of readdirSync(join(CASES, dir)).filter((f) => f.endsWith(".dsx"))) {
    test(`lint corpus ${dir}/${file}`, () => {
      const source = readFileSync(join(CASES, dir, file), "utf8");
      const got = lintSource(source, { file }).map(key).sort();
      assert.deepEqual(got, expectFor(dir, file.replace(/\.dsx$/, ".expected.json")));
    });
  }
}

test("lint corpus web/routes.json", () => {
  const table = JSON.parse(readFileSync(join(CASES, "web", "routes.json"), "utf8")) as { routes: unknown[] };
  const got = lintRoutes(table.routes as never[]).map(key).sort();
  assert.deepEqual(got, expectFor("web", "routes.expected.json"));
});

test("lintRoutes: the known-components gate flags an unregistered target", () => {
  const diags: LintDiagnostic[] = lintRoutes(
    [{ path: "/", component: "t.Missing" }],
    { knownComponents: ["t.Home"] },
  );
  assert.deepEqual(diags.map((d) => d.rule), ["route-unknown-component"]);
});

test("lint tiers (/web/15 law 4): visible by default, assertable, strict-modeable", () => {
  const src = `<stack>
  <head>
    <action as="portable">count = count + 1</action>
    <action as="fancy">class Foo {}</action>
    <action as="pinned" tier="jse">yield 1</action>
  </head>
  <button on:tap="with (o) { x = 1 }" label="go"/>
</stack>`;
  const dflt = lintSource(src, { file: "t.dsx" });
  assert.deepEqual(
    dflt.filter((d) => d.rule.startsWith("js-tier") || d.rule.startsWith("tier")).map((d) => `${d.level}:${d.rule}`).sort(),
    ["error:tier-assert", "notice:js-tier", "notice:js-tier"],
  );
  const strict = lintSource(src, { file: "t.dsx", strictTiers: true });
  assert.equal(strict.filter((d) => d.rule === "strict-escalation").length, 2);
  assert.equal(strict.filter((d) => d.rule === "tier-assert").length, 1);
});
