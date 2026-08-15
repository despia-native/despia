//
//  The config validation grammar (D1), driven by OpenSource/Conformance/config/validation.json.
//
//  The corpus is the source of truth and this file is only a harness: config_schema.rb and
//  the Kotlin twin run the same cases, so a rule that drifts on one plane fails here too.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIG_VALIDATION_LIMITS, checkConfigRules, validateConfigValue,
} from "../src/config-validate.ts";  // subpath export: @despia/kernel/config-validate

const corpusPath = join(import.meta.dirname, "..", "..", "..", "..", "Conformance", "config", "validation.json");

interface Case {
  name: string;
  entry: { pattern?: string; validate?: string; message?: string; patternRepeat?: { unit: string; count: number } };
  value: unknown;
  expect: { ok: boolean; message?: string };
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  limits: { maxPatternCharacters: number; maxMessageCharacters: number };
  cases: Case[];
};

test("the corpus limits are the implementation's limits", () => {
  assert.equal(CONFIG_VALIDATION_LIMITS.maxPatternCharacters, corpus.limits.maxPatternCharacters);
  assert.equal(CONFIG_VALIDATION_LIMITS.maxMessageCharacters, corpus.limits.maxMessageCharacters);
});

test("config validation corpus", async (t) => {
  assert.ok(corpus.cases.length > 0, "the corpus is empty");
  for (const testCase of corpus.cases) {
    await t.test(testCase.name, () => {
      // `patternRepeat` keeps a 600-character pattern out of the JSON as a literal.
      const rules = { ...testCase.entry };
      if (rules.patternRepeat !== undefined) {
        rules.pattern = rules.patternRepeat.unit.repeat(rules.patternRepeat.count);
        delete rules.patternRepeat;
      }
      const result = validateConfigValue(testCase.value, rules);
      assert.equal(result.ok, testCase.expect.ok, `ok (message: ${result.message})`);
      if (testCase.expect.message !== undefined) assert.equal(result.message, testCase.expect.message);
      if (result.ok) assert.equal(result.message, undefined);
    });
  }
});

test("checkConfigRules catches an unrunnable pattern when it is AUTHORED, not when a user types", () => {
  assert.deepEqual(checkConfigRules({ pattern: "^[a-z]+$" }), []);
  assert.deepEqual(checkConfigRules({}), []);

  assert.match(checkConfigRules({ pattern: "^(a+)+$" })[0] ?? "", /catastrophic-backtracking/);
  assert.match(checkConfigRules({ pattern: "^([a-z]$" })[0] ?? "", /not a valid regular expression/);
  assert.match(checkConfigRules({ pattern: "a".repeat(600) })[0] ?? "", /longer than 512/);
  assert.match(checkConfigRules({ message: "m".repeat(300) })[0] ?? "", /longer than 200/);
});

test("a failure message is truncated rather than allowed to be unbounded", () => {
  const result = validateConfigValue("x", { validate: `'${"z".repeat(400)}'` });
  assert.equal(result.ok, false);
  assert.equal(result.message?.length, CONFIG_VALIDATION_LIMITS.maxMessageCharacters);
});
