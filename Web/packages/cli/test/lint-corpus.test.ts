//
//  lint-corpus.test.ts — the shipped linter, tethered to the shared corpus.
//
//  There are two TS linters in this repository on purpose: compiler/src/lint.ts (the
//  dev-loop twin, repo-anchored, reads facts.json at runtime) and this package's
//  src/lint.ts (ships in @despia/cli, must run with no repo checkout, so its rule tables
//  are literals). A literal copy of a rule table is exactly the thing that drifts, and it
//  HAD drifted — the twelve scene-3D tags were missing from BUILTIN_TAGS while facts.json
//  and the Ruby gate both carried them — with every gate green, because nothing compared
//  the copy to the source. These tests are that comparison.
//
//  Two tethers:
//    1. BUILTIN_TAGS must equal facts.json's builtinTags exactly — not superset, EQUAL,
//       because an extra tag here means `dsx lint` waves through markup the repo gate and
//       the runtimes would reject.
//    2. Every shared corpus case must produce the expected (line, level, rule) set for the
//       MAPPED ruleset — the same comparison lint_conformance.rb makes for the Ruby gate.
//       This linter reports messages, not rule IDs, so rules are derived the way the Ruby
//       runner derives them: by the stable phrase that names the defect (the message
//       wording is a deliberate copy of lint_dsx.rb's). Findings outside the mapped set
//       are uncompared here, exactly as they are for Ruby — they stay covered by this
//       package's own lint.test.ts.
//

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { BUILTIN_TAGS, lintSource, type Finding, type LintContext } from "../src/lint.ts";

const lintDir = join(import.meta.dirname, "..", "..", "..", "..", "Conformance", "lint");
const facts = JSON.parse(readFileSync(join(lintDir, "facts.json"), "utf8")) as { builtinTags: string[] };

// lint_conformance.rb's RULE_MAP, ported verbatim: message → corpus rule id, anchored on
// the STABLE phrase naming the defect, never the full wording.
const RULE_MAP: Array<[RegExp, string]> = [
  [/unknown element tag/, "unknown-tag"],
  [/outside <head> — declarations live/, "decl-outside-head"],
  [/<watch> outside <head>/, "watch-outside-head"],
  [/only declarations belong in the head/, "head-purity"],
  [/^head order:/, "head-order"],
  [/the legacy name= identifier was removed/, "legacy-name"],
  [/missing as= — registration is a silent no-op/, "missing-as"],
  [/must be an ASCII identifier/, "api-as-identifier"],
  [/<expects> missing variable=/, "expects-variable"],
  [/without key= — rows need a stable identity/, "bind-without-key"],
];

function ruleOf(message: string): string | null {
  for (const [pattern, rule] of RULE_MAP) if (pattern.test(message)) return rule;
  return null;
}

// The shared fixtures are context-free by design (they exercise structural rules, not the
// scheme universe), so a permissive context keeps scheme rules out of the comparison.
function corpusContext(): LintContext {
  return {
    pool: new Map(),
    schemes: new Set(),
    schemeOf: () => null,
    styleEjects: new Set<string>(),
    schemesComplete: false,
  };
}

test("BUILTIN_TAGS equals facts.json builtinTags — the copy cannot drift silently again", () => {
  const shipped = [...BUILTIN_TAGS].sort();
  const truth = [...new Set(facts.builtinTags)].sort();
  assert.deepEqual(
    shipped,
    truth,
    "src/lint.ts BUILTIN_TAGS diverged from Conformance/lint/facts.json — edit facts.json first, then mirror it here",
  );
});

test("shared lint corpus: the shipped linter produces the expected diagnostics", async (t) => {
  const casesDir = join(lintDir, "cases", "shared");
  const sources = readdirSync(casesDir).filter((name) => name.endsWith(".dsx")).sort();
  assert.ok(sources.length > 0, "the shared corpus is empty");

  for (const name of sources) {
    await t.test(name, () => {
      const source = readFileSync(join(casesDir, name), "utf8");
      const expected = JSON.parse(
        readFileSync(join(casesDir, name.replace(/\.dsx$/, ".expected.json")), "utf8"),
      ) as Array<{ line: number; level: string; rule: string }>;

      const findings = lintSource(join("/corpus", name), source, corpusContext());
      const got = findings
        .map((f: Finding) => ({ f, rule: ruleOf(f.message) }))
        .filter((entry): entry is { f: Finding; rule: string } => entry.rule !== null)
        .map(({ f, rule }) => `${f.line}:${f.level}:${rule}`)
        .sort();
      const want = expected.map((e) => `${e.line}:${e.level}:${e.rule}`).sort();
      assert.deepEqual(
        got,
        want,
        `${name}: shipped linter diagnostics diverge from the corpus\n` +
          findings.map((f) => `  got  ${f.line}:${f.level} ${f.message}`).join("\n") +
          "\n" +
          expected.map((e) => `  want ${e.line}:${e.level} (${e.rule})`).join("\n"),
      );
    });
  }
});
