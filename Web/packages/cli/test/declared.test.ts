//
//  The declared-command host, driven by OpenSource/Conformance/cli/seams.json.
//
//  Each case builds a real document around the corpus body and runs it against a real
//  temporary directory, because the seams under test ARE filesystem, environment and process
//  access. A mocked filesystem would prove the mock.
//

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { readCliDocument } from "../src/document.ts";
import { FAULT_EXIT, runDeclaredCommand, type CommandIo } from "../src/declared.ts";

const corpusPath = join(import.meta.dirname, "..", "..", "..", "..", "Conformance", "cli", "seams.json");

interface SeamCase {
  name: string;
  body: string;
  declare?: { env?: string[]; exec?: string[]; roots?: { name: string; path: string }[] };
  environment?: Record<string, string>;
  files?: Record<string, string>;
  budget?: { loopCap?: number; deadlineMs?: number; calls?: number };
  expect?: { code: number; stdout: string[]; stderr: string[] };
  expectThrow?: { reason: string; contains: string };
  expectEnvelope?: { ok: boolean; error?: string };
  expectLintError?: { contains: string };
}

interface Corpus {
  exitCodes: {
    return: { value: unknown; code: number }[];
    throw: { reason: string; code: number }[];
    fault: { code: number };
  };
  cases: SeamCase[];
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;

function documentFor(testCase: SeamCase, body: string): string {
  const head: string[] = [];
  for (const name of testCase.declare?.env ?? []) head.push(`    <env as="${name}"/>`);
  for (const name of testCase.declare?.exec ?? []) head.push(`    <exec as="${name}"/>`);
  for (const root of testCase.declare?.roots ?? []) head.push(`    <root as="${root.name}" path="${root.path}"/>`);
  // The body is injected verbatim; it is code, and the reader reads it as raw text.
  head.push(`    <action as="main">${body}</action>`);
  return `<cli as="probe" version="1.0.0">\n  <head>\n${head.join("\n")}\n  </head>\n  <command as="main" action="main"/>\n</cli>\n`;
}

function workspace(files: Record<string, string> | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "dsx-cli-seams-"));
  for (const [path, contents] of Object.entries(files ?? {})) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function recorder(): CommandIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
}

test("cli seams corpus", async (t) => {
  assert.ok(corpus.cases.length > 0, "the corpus is empty");
  for (const testCase of corpus.cases) {
    // The surface-namespace rule is a LINT rule, not a host rule — a body naming
    // dsx.component is refused before it can run inert. lint_dsx.rb owns it and
    // lint_dsx.rb's own gate proves it; here it is recorded as deliberately not-host.
    if (testCase.expectLintError !== undefined) continue;

    await t.test(testCase.name, async () => {
      const document = readCliDocument(documentFor(testCase, testCase.body), "probe.dsx");
      const cwd = workspace(testCase.files);
      const io = recorder();
      const result = await runDeclaredCommand(document, document.actions.get("main")!, {}, {
        cwd,
        io,
        env: testCase.environment ?? {},
        ...(testCase.budget === undefined ? {} : { budget: testCase.budget }),
      });

      if (testCase.expectThrow !== undefined) {
        assert.equal(result.reason, testCase.expectThrow.reason, `reason for ${testCase.name} (message: ${result.message})`);
        assert.ok(
          (result.message ?? "").includes(testCase.expectThrow.contains),
          `message ${JSON.stringify(result.message)} does not contain ${JSON.stringify(testCase.expectThrow.contains)}`,
        );
        return;
      }

      // A refused seam SETTLES rather than throwing — the bus envelope, identical to what the
      // same call hands a tap handler. Asserting it here is what keeps the CLI on the one bus
      // contract instead of inventing a command-shaped one.
      if (testCase.expectEnvelope !== undefined) {
        const envelope = result.value as { ok?: unknown; error?: unknown } | null;
        assert.ok(envelope !== null && typeof envelope === "object", `expected an envelope, got ${JSON.stringify(result.value)}`);
        assert.equal(envelope.ok, testCase.expectEnvelope.ok);
        if (testCase.expectEnvelope.error !== undefined) assert.equal(envelope.error, testCase.expectEnvelope.error);
        return;
      }
      assert.equal(result.code, testCase.expect!.code, `exit code (reason: ${result.reason}, message: ${result.message})`);
      assert.deepEqual(io.stdout, testCase.expect!.stdout);
      assert.deepEqual(io.stderr, testCase.expect!.stderr);
    });
  }
});

test("return values map to exit codes exactly as the corpus states", async (t) => {
  for (const row of corpus.exitCodes.return) {
    await t.test(`return ${JSON.stringify(row.value)} → ${row.code}`, async () => {
      const body = row.value === null ? "return" : `return ${JSON.stringify(row.value)}`;
      const document = readCliDocument(documentFor({ name: "x", body }, body), "probe.dsx");
      const result = await runDeclaredCommand(document, document.actions.get("main")!, {}, {
        cwd: workspace({}),
        io: recorder(),
        env: {},
      });
      assert.equal(result.code, row.code);
    });
  }
});

test("thrown reasons map to exit codes exactly as the corpus states", async (t) => {
  for (const row of corpus.exitCodes.throw) {
    await t.test(`throw ${row.reason} → ${row.code}`, async () => {
      const body = `throw { reason: '${row.reason}', message: 'nope' }`;
      const document = readCliDocument(documentFor({ name: "x", body }, body), "probe.dsx");
      const result = await runDeclaredCommand(document, document.actions.get("main")!, {}, {
        cwd: workspace({}),
        io: recorder(),
        env: {},
      });
      assert.equal(result.code, row.code, `reason ${row.reason}`);
      assert.equal(result.reason, row.reason);
    });
  }
});

test("an unrecognised throw is a fault, not a message to the user", async () => {
  const body = "throw { reason: 'something_we_never_named', message: 'internal detail' }";
  const document = readCliDocument(documentFor({ name: "x", body }, body), "probe.dsx");
  const result = await runDeclaredCommand(document, document.actions.get("main")!, {}, {
    cwd: workspace({}),
    io: recorder(),
    env: {},
  });
  assert.equal(result.code, corpus.exitCodes.fault.code);
  assert.equal(result.code, FAULT_EXIT);
  assert.equal(result.reason, "fault");
});

test("a body may call a sibling action, so a command decomposes", async () => {
  const source = `<cli as="probe" version="1.0.0">
  <head>
    <action as="shout" inputs="text">
      dsx.module.out.print({ text: text })
    </action>
    <action as="main">
      dsx.action.shout({ text: 'from a sibling' })
      return 0
    </action>
  </head>
  <command as="main" action="main"/>
</cli>
`;
  const document = readCliDocument(source, "probe.dsx");
  const io = recorder();
  const result = await runDeclaredCommand(document, document.actions.get("main")!, {}, { cwd: workspace({}), io, env: {} });
  assert.equal(result.code, 0);
  assert.deepEqual(io.stdout, ["from a sibling"]);
});

test("declared inputs arrive in the body's scope by name", async () => {
  const source = `<cli as="probe" version="1.0.0">
  <head>
    <action as="main" inputs="who, loud">
      dsx.module.out.print({ text: loud ? who.toUpperCase() : who })
      return 0
    </action>
  </head>
  <command as="main" action="main">
    <flag as="who" type="string"/>
    <flag as="loud" type="boolean"/>
  </command>
</cli>
`;
  const document = readCliDocument(source, "probe.dsx");
  assert.deepEqual(document.actions.get("main")!.inputs, ["who", "loud"]);
  const io = recorder();
  const result = await runDeclaredCommand(document, document.actions.get("main")!, { who: "despia", loud: true }, {
    cwd: workspace({}),
    io,
    env: {},
  });
  assert.equal(result.code, 0);
  assert.deepEqual(io.stdout, ["DESPIA"]);
});
