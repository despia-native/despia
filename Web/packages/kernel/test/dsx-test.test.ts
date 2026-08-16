//
//  dsx-test.test.ts - the app-author test harness: fixture discovery (*.dsxtest.json),
//  the corpus-shape execution contract (fresh store per case, scope seeding, event
//  collection, JSE-equality expectStore incl. the JSON-null → absent/nil mapping),
//  loud shape errors on typo'd keys, the CLI contract (per-case pass/FAIL lines with
//  the mismatched key, summary line, exit 1 on any failure, --json shape), and the
//  in-repo example fixture (Conformance/examples/cart.dsxtest.json) staying green.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  runCase, runFile, findTestFiles, caseShapeError,
  type DsxTestCase, type CaseResult,
} from "../bin/dsx-test.ts";

const BIN = fileURLToPath(new URL("../bin/dsx-test.ts", import.meta.url));

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance");
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

// ── the execution contract, driven through the API ──────────────────────────────────

test("dsx-test: a passing case is green — scope seeds, actions chain, null means absent", async () => {
  const c: DsxTestCase = {
    name: "chain",
    actions: {
      start: { body: "dsx.variable.a = dsx.variable.seed + 1; dsx.action.next()" },
      next: { body: "dsx.variable.b = dsx.variable.a * 2" },
    },
    scope: { seed: 4 },
    run: "start",
    expectStore: { a: 5, b: 10, untouched: null },
    expectEvents: [],
  };
  assert.deepEqual(await runCase(c), []);
});

test("dsx-test: a store mismatch reports the key with actual vs expected (JSE coercion)", async () => {
  const c: DsxTestCase = {
    name: "wrong",
    actions: { go: { body: "dsx.variable.total = 5" } },
    scope: {},
    run: "go",
    expectStore: { total: 7 },
    expectEvents: [],
  };
  const failures = await runCase(c);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.kind, "store");
  assert.equal(failures[0]!.key, "total");
  assert.equal(failures[0]!.actual, "5");
  assert.equal(failures[0]!.expected, "7");
});

test("dsx-test: expectEvents asserts emission order", async () => {
  const c: DsxTestCase = {
    name: "events",
    actions: {
      publish: { body: "dsx.event('started', { at: 1 }); dsx.action.done()" },
      done: { body: "dsx.event('finished', { at: 2 })" },
    },
    scope: {},
    run: "publish",
    expectStore: {},
    expectEvents: ["started", "finished"],
  };
  assert.deepEqual(await runCase(c), []);
  // wrong order fails with the events key and both arrays rendered
  const wrong = { ...c, expectEvents: ["finished", "started"] };
  const failures = await runCase(wrong);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.kind, "events");
  assert.equal(failures[0]!.key, "expectEvents");
  assert.equal(failures[0]!.actual, `["started","finished"]`);
  assert.equal(failures[0]!.expected, `["finished","started"]`);
});

test("dsx-test: the full modern grammar runs — template + destructuring + await Promise.all", async () => {
  const c: DsxTestCase = {
    name: "modern",
    actions: {
      go: {
        body: "const { id, name: title } = dsx.variable.user\n" +
          "const [first, , third] = dsx.variable.tags\n" +
          "const pair = await Promise.all([ id * 2, `hi ${title}` ])\n" +
          "dsx.variable.out = `${pair[1]}:${pair[0]}:${first}:${third}`",
      },
    },
    scope: { user: { id: 21, name: "Ada" }, tags: ["a", "b", "c"] },
    run: "go",
    expectStore: { out: "hi Ada:42:a:c" },
    expectEvents: [],
  };
  assert.deepEqual(await runCase(c), []);
});

test("dsx-test: cases are isolated — a fresh store per case, no bleed", async () => {
  const writer: DsxTestCase = {
    name: "writer",
    actions: { go: { body: "dsx.variable.leak = 'yes'" } },
    scope: {}, run: "go", expectStore: { leak: "yes" }, expectEvents: [],
  };
  const reader: DsxTestCase = {
    name: "reader",
    actions: { go: { body: "x = 1" } },
    scope: {}, run: "go", expectStore: { leak: null }, expectEvents: [],
  };
  assert.deepEqual(await runCase(writer), []);
  assert.deepEqual(await runCase(reader), []);
});

test("dsx-test: shape typos are loud — unknown keys, missing fields, non-JSON files", async () => {
  assert.match(caseShapeError({ name: "x", actions: {}, run: "go", expectstore: {} }) ?? "",
    /unknown key "expectstore"/);
  assert.match(caseShapeError({ actions: {}, run: "go" }) ?? "", /"name"/);
  assert.match(caseShapeError({ name: "x", actions: { a: { body: 1 } }, run: "go" }) ?? "", /string body/);
  assert.equal(caseShapeError({ name: "x", actions: { a: { body: "y = 1" } }, run: "go", _note: "ignored" }), null);
  const dir = mkdtempSync(join(tmpdir(), "dsx-test-"));
  try {
    writeFileSync(join(dir, "broken.dsxtest.json"), "{ not json");
    const results = await runFile(join(dir, "broken.dsxtest.json"));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.failures[0]!.kind, "shape");
    assert.match(results[0]!.failures[0]!.actual, /does not parse as JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── discovery + the CLI contract ────────────────────────────────────────────────────

const PASSING_FIXTURE = JSON.stringify({
  cases: [{
    name: "adds",
    actions: { go: { body: "dsx.variable.sum = dsx.variable.a + dsx.variable.b" } },
    scope: { a: 2, b: 3 },
    run: "go",
    expectStore: { sum: 5 },
    expectEvents: [],
  }],
});

const FAILING_FIXTURE = JSON.stringify({
  cases: [{
    name: "expects-the-wrong-total",
    actions: { go: { body: "dsx.variable.total = 41" } },
    scope: {},
    run: "go",
    expectStore: { total: 42 },
    expectEvents: [],
  }],
});

test("dsx-test CLI: discovery, per-case report with the mismatched key, exit 1 on failure, --json", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-test-cli-"));
  try {
    mkdirSync(join(dir, "nested"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "ok.dsxtest.json"), PASSING_FIXTURE);
    writeFileSync(join(dir, "nested", "bad.dsxtest.json"), FAILING_FIXTURE);
    writeFileSync(join(dir, "node_modules", "skipped.dsxtest.json"), FAILING_FIXTURE);
    writeFileSync(join(dir, "notatest.json"), FAILING_FIXTURE);

    assert.deepEqual(findTestFiles([dir]).map((f) => f.split("/").pop()).sort(),
      ["bad.dsxtest.json", "ok.dsxtest.json"]);

    const run = spawnSync(process.execPath, [BIN, dir], { encoding: "utf8" });
    assert.equal(run.status, 1, `expected exit 1 — stderr: ${run.stderr}`);
    assert.match(run.stdout, /pass adds \(/);
    assert.match(run.stdout, /FAIL expects-the-wrong-total \(/);
    assert.match(run.stdout, /expectStore total -> 41 \(expected 42\)/);
    assert.match(run.stdout, /dsx-test: 1 passed, 1 failed — 2 case\(s\) in 2 file\(s\)/);

    const green = spawnSync(process.execPath, [BIN, join(dir, "ok.dsxtest.json")], { encoding: "utf8" });
    assert.equal(green.status, 0, `expected exit 0 — stderr: ${green.stderr}`);
    assert.match(green.stdout, /dsx-test: 1 passed — 1 case\(s\) in 1 file\(s\)/);

    const json = spawnSync(process.execPath, [BIN, "--json", dir], { encoding: "utf8" });
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.stdout) as {
      files: number; cases: number; passed: number; failed: number; results: CaseResult[];
    };
    assert.equal(parsed.files, 2);
    assert.equal(parsed.cases, 2);
    assert.equal(parsed.passed, 1);
    assert.equal(parsed.failed, 1);
    for (const r of parsed.results) {
      assert.equal(typeof r.name, "string");
      assert.equal(typeof r.ok, "boolean");
      assert.equal(typeof r.ms, "number");
    }
    const bad = parsed.results.find((r) => !r.ok)!;
    assert.deepEqual(bad.failures, [{ kind: "store", key: "total", actual: "41", expected: "42" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the in-repo example authors copy from ───────────────────────────────────────────

test("dsx-test: the repo example (Conformance/examples/cart.dsxtest.json) is green", async () => {
  const cart = join(repoRoot(), "OpenSource/Conformance/examples/cart.dsxtest.json");
  assert.ok(existsSync(cart), `missing example fixture: ${cart}`);
  const results = await runFile(cart);
  assert.equal(results.length, 3, "the cart example ships three cases");
  for (const r of results) {
    assert.deepEqual(r.failures, [], `cart case "${r.name}" failed`);
    assert.equal(r.ok, true);
  }
});
