//
//  argv → invocation, driven by OpenSource/Conformance/cli/dispatch.json.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { readCliDocument } from "../src/document.ts";
import { DispatchError, dispatch } from "../src/dispatch.ts";

const corpusPath = join(import.meta.dirname, "..", "..", "..", "..", "Conformance", "cli", "dispatch.json");

interface DispatchCase {
  name: string;
  argv: string[];
  expect?: { command: string; inputs: Record<string, unknown> };
  refuse?: { reason: string; contains: string };
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { document: string; cases: DispatchCase[] };
const document = readCliDocument(corpus.document, "dispatch.dsx");

test("cli dispatch corpus", async (t) => {
  assert.ok(corpus.cases.length > 0, "the corpus is empty");
  for (const testCase of corpus.cases) {
    await t.test(testCase.name, () => {
      if (testCase.refuse !== undefined) {
        let error: DispatchError | null = null;
        try {
          dispatch(document, testCase.argv);
        } catch (thrown) {
          assert.ok(thrown instanceof DispatchError, `threw ${String(thrown)}, expected DispatchError`);
          error = thrown;
        }
        assert.ok(error !== null, `${testCase.name} was accepted but the corpus expects a refusal`);
        assert.equal(error.reason, testCase.refuse.reason);
        assert.ok(
          error.message.includes(testCase.refuse.contains),
          `message ${JSON.stringify(error.message)} does not contain ${JSON.stringify(testCase.refuse.contains)}`,
        );
        return;
      }
      const invocation = dispatch(document, testCase.argv);
      assert.equal(invocation.command.name, testCase.expect!.command);
      assert.deepEqual(invocation.inputs, testCase.expect!.inputs);
    });
  }
});
