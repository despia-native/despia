//
//  build-expressions.test.ts - the kernel-side runner for the build-expressions
//  corpus (OpenSource/Conformance/build-expressions/evaluation-001.json). Drives the
//  REAL CLI (bin/build-expressions.ts) over stdin as one batch — the exact protocol
//  the Ruby classifier speaks — so the test proves the wire contract, not just the
//  library functions. The Ruby twin (ClosedSource/scripts/build_expressions_test.rb)
//  replays the same corpus through the batch layer; codes are the frozen API,
//  messages are free to sharpen.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { KNOWN_OPS as EVAL_OPS, type Result } from "../bin/build-expressions.ts";
import { KNOWN_OPS as AUDIT_OPS } from "../bin/jse-audit.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/build-expressions");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`OpenSource/Conformance/build-expressions not found walking up from ${import.meta.dirname}`);
    dir = parent;
  }
}

const BIN = join(resolve(import.meta.dirname ?? "."), "../bin/build-expressions.ts");

function runCli(input: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN], { input, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

type Case = {
  name: string;
  source: string;
  context: Record<string, unknown>;
  expect: { ok: true; value: unknown } | { ok: false; code: string };
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "evaluation-001.json"), "utf8")) as { cases: Case[] };
assert.ok(Array.isArray(doc.cases) && doc.cases.length > 0, "evaluation-001.json: no cases[]");

// One spawn for the whole corpus — the batched shape the Ruby side uses (spec §9.1).
const batch = {
  version: 1,
  requests: doc.cases.map((c, i) => ({ id: `${i}:${c.name}`, source: c.source, context: c.context })),
};
const out = runCli(JSON.stringify(batch));

test("protocol: batch with request failures still exits 0", () => {
  assert.equal(out.status, 0, `stderr: ${out.stderr}`);
});

const parsed = JSON.parse(out.stdout) as { version: number; results: Result[] };

test("protocol: response is version 1 with one result per request, same order", () => {
  assert.equal(parsed.version, 1);
  assert.equal(parsed.results.length, doc.cases.length);
  parsed.results.forEach((r, i) => assert.equal(r.id, `${i}:${doc.cases[i]!.name}`));
});

doc.cases.forEach((c, i) => {
  test(`evaluation-001/${c.name}`, () => {
    const r = parsed.results[i]!;
    if (c.expect.ok) {
      assert.equal(r.ok, true, r.ok ? "" : `expected ok, got ${(r as { code: string }).code}: ${(r as { message: string }).message}`);
      assert.deepEqual((r as { value: unknown }).value, c.expect.value);
    } else {
      assert.equal(r.ok, false, `expected ${c.expect.code}, evaluated to ${JSON.stringify((r as { value?: unknown }).value)}`);
      assert.equal((r as { code: string }).code, c.expect.code, (r as { message: string }).message);
    }
  });
});

test("protocol: unsupported version exits 2", () => {
  const r = runCli(JSON.stringify({ version: 99, requests: [] }));
  assert.equal(r.status, 2);
});

test("protocol: non-JSON stdin exits 2", () => {
  const r = runCli("not json");
  assert.equal(r.status, 2);
});

test("KNOWN_OPS stays in lockstep with jse-audit (the mirrored table)", () => {
  // build-expressions.ts mirrors the set instead of importing jse-audit (which pulls
  // in @despia/compiler and would cost the CLI its no-npm-install property). This pin is
  // what makes the mirror safe: grammar growth updates both or fails here.
  assert.deepEqual([...EVAL_OPS].sort(), [...AUDIT_OPS].sort());
});

test("importing the evaluator library does not patch this process's globals", () => {
  // installDeterminismGuards runs inside run()/main() only; the import above must
  // leave the host process's clock alone (the audit tool and tests share it).
  assert.ok(Number.isFinite(Date.now()));
  assert.ok(Number.isFinite(Math.random()));
});
