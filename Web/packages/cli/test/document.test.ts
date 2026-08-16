//
//  The `<cli>` document reader, driven by OpenSource/Conformance/cli/document.json.
//
//  The corpus is the source of truth and this file is only a harness: a case added there
//  runs here with no edit, which is the property that lets a Kotlin or Swift CLI host
//  implement the same document without the fixtures being rewritten for it.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CliDocumentError, readCliDocument, usage, type CliDocument } from "../src/document.ts";

const corpusDir = join(import.meta.dirname, "..", "..", "..", "..", "Conformance", "cli");

interface DocumentCase {
  name: string;
  source: string;
  expect?: Record<string, unknown>;
  expectActionBodyContains?: string[];
  abort?: { contains: string; line: number };
}

const corpus = JSON.parse(readFileSync(join(corpusDir, "document.json"), "utf8")) as { cases: DocumentCase[] };

/** The document, reduced to exactly what the corpus states — so a case never asserts on a
 *  host type and stays portable to another implementation. */
function shape(document: CliDocument): Record<string, unknown> {
  return {
    name: document.name,
    version: document.version,
    summary: document.summary,
    env: [...document.env].sort(),
    exec: [...document.exec].sort(),
    roots: document.roots,
    actions: [...document.actions.keys()],
    commands: document.commands.map((command) => ({
      name: command.name,
      ...(command.action === undefined ? {} : { action: command.action }),
      ...(command.handler === undefined ? {} : { handler: command.handler }),
      summary: command.summary,
      flags: command.flags,
      positionals: command.positionals,
    })),
  };
}

test("cli document corpus", async (t) => {
  assert.ok(corpus.cases.length > 0, "the corpus is empty");
  for (const testCase of corpus.cases) {
    await t.test(testCase.name, () => {
      if (testCase.abort !== undefined) {
        let error: CliDocumentError | null = null;
        try {
          readCliDocument(testCase.source, "doc.dsx");
        } catch (thrown) {
          assert.ok(thrown instanceof CliDocumentError, `threw ${String(thrown)}, expected CliDocumentError`);
          error = thrown;
        }
        assert.ok(error !== null, `${testCase.name} was accepted but the corpus expects an abort`);
        assert.ok(
          error.message.includes(testCase.abort.contains),
          `message ${JSON.stringify(error.message)} does not contain ${JSON.stringify(testCase.abort.contains)}`,
        );
        assert.equal(error.line, testCase.abort.line, `abort line for ${testCase.name}`);
        return;
      }
      const document = readCliDocument(testCase.source, "doc.dsx");
      if (testCase.expect !== undefined) assert.deepEqual(shape(document), testCase.expect);
      if (testCase.expectActionBodyContains !== undefined) {
        const body = [...document.actions.values()][0]?.body ?? "";
        for (const fragment of testCase.expectActionBodyContains) {
          assert.ok(body.includes(fragment), `action body lost ${JSON.stringify(fragment)}: ${JSON.stringify(body)}`);
        }
      }
    });
  }
});

test("usage is derived from the document, not written twice", () => {
  const document = readCliDocument(
    `<cli as="tool" version="1.0.0" summary="a tool">
  <head><action as="run">return 0</action></head>
  <command as="run" action="run" summary="run it">
    <flag as="strict" type="boolean" summary="warnings fail too"/>
    <positional as="files" variadic="true"/>
  </command>
</cli>
`,
    "doc.dsx",
  );
  const text = usage(document);
  assert.match(text, /tool — a tool/);
  assert.match(text, /tool run \[--strict\] \[<files> …\]/);
  assert.match(text, /run\s+run it/);
  assert.match(text, /--strict\s+warnings fail too/);
  // The two the host answers itself appear in the same block a reader scans.
  assert.match(text, /--help/);
  assert.match(text, /--version/);
  // One Options heading, not two.
  assert.equal(text.split("\n").filter((line) => line === "Options").length, 1);
});
