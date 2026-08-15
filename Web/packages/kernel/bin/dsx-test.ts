//
//  dsx-test.ts - the app-author test harness: unit-test YOUR actions the way the kernel
//  tests itself. It discovers fixture files named *.dsxtest.json — EXACTLY the actions-
//  corpus shape (OpenSource/Conformance/actions/actions.json) — and drives each case
//  through the REAL runner (ReactiveStore + ActionRunner, the same execution path the
//  corpus gates), so a green fixture here is the same promise the kernel makes to itself:
//  seed `scope` into the store, run `run` (a bare action name or a `dsx.action.x(…)`
//  call), then assert `expectStore` paths under JSE equality (a JSON null means
//  absent/nil) and `expectEvents` order. Every case gets a FRESH store — no bleed.
//
//  Usage: node packages/kernel/bin/dsx-test.ts [--json] [roots or files…]
//    roots default to the repo root (every *.dsxtest.json outside node_modules/.git)
//    --json    machine-readable results object instead of the human report
//  Exit code: 1 when any case fails (or any fixture is malformed), 0 otherwise.
//
//  Fixture shape (per case): { "name", "actions": { name: { "inputs"?, "body" } },
//  "scope", "run", "runItem"?, "expectStore": { path: value }, "expectEvents": [names] }.
//  Keys starting with "_" are notes and ignored at every level; an UNKNOWN key is a
//  failure (it is how a typo'd "expectstore" stays loud instead of silently asserting
//  nothing).
//

import { readFileSync, readdirSync, statSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ReactiveStore } from "../src/store.ts";
import { ActionRunner, makeRunEnv } from "../src/runner.ts";
import { JSE } from "../src/jse/jse.ts";
import { NSNull, string, type Dict } from "../src/jse/values.ts";

// ── model ────────────────────────────────────────────────────────────────────────────

export type DsxTestCase = {
  name: string;
  actions: { [name: string]: { inputs?: Dict; body: string } };
  scope: Dict;
  run: string;
  runItem?: Dict;
  expectStore: { [path: string]: unknown };
  expectEvents: string[];
};

export type CaseFailure = {
  kind: "store" | "events" | "error" | "shape";
  /** the mismatched expectStore path, or "expectEvents" */
  key?: string;
  /** JSE string coercion of what the run produced */
  actual: string;
  /** JSE string coercion of what the fixture expected */
  expected: string;
};

export type CaseResult = {
  file: string;
  name: string;
  ok: boolean;
  /** wall-clock for this case, milliseconds */
  ms: number;
  failures: CaseFailure[];
};

// ── JSON → JSE value mapping (identical to the corpus runner) ───────────────────────

/** A JSON null in a fixture maps to the present-null sentinel on the way IN (scope,
 *  runItem) so stored nulls read back as JSE's one missing value. */
export function toJse(v: unknown): unknown {
  if (v === null) return NSNull;
  if (Array.isArray(v)) return v.map(toJse);
  if (typeof v === "object") {
    const out: Dict = {};
    for (const [k, val] of Object.entries(v as Dict)) out[k] = toJse(val);
    return out;
  }
  return v;
}

// ── shape validation (loud on typos, silent on "_"-prefixed notes) ──────────────────

const CASE_KEYS = new Set(["name", "actions", "scope", "run", "runItem", "expectStore", "expectEvents"]);

function isPlainObject(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** null = valid; otherwise the human-readable shape complaint. */
export function caseShapeError(c: unknown): string | null {
  if (!isPlainObject(c)) return "case is not an object";
  for (const k of Object.keys(c)) {
    if (!k.startsWith("_") && !CASE_KEYS.has(k)) {
      return `unknown key "${k}" — known keys: ${[...CASE_KEYS].join(", ")} (prefix notes with "_")`;
    }
  }
  if (typeof c["name"] !== "string" || c["name"].length === 0) return `"name" must be a non-empty string`;
  if (typeof c["run"] !== "string" || c["run"].trim().length === 0) return `"run" must be an action name or a dsx.action call`;
  if (!isPlainObject(c["actions"])) return `"actions" must be an object of { name: { inputs?, body } }`;
  for (const [name, decl] of Object.entries(c["actions"])) {
    if (!isPlainObject(decl) || typeof decl["body"] !== "string") {
      return `action "${name}" must be { inputs?, body } with a string body`;
    }
    if (decl["inputs"] !== undefined && !isPlainObject(decl["inputs"])) return `action "${name}" inputs must be an object`;
  }
  if (c["scope"] !== undefined && !isPlainObject(c["scope"])) return `"scope" must be an object`;
  if (c["runItem"] !== undefined && !isPlainObject(c["runItem"])) return `"runItem" must be an object`;
  if (c["expectStore"] !== undefined && !isPlainObject(c["expectStore"])) return `"expectStore" must be an object of { path: value }`;
  if (c["expectEvents"] !== undefined && !Array.isArray(c["expectEvents"])) return `"expectEvents" must be an array of event names`;
  return null;
}

// ── one case through the REAL runner (fresh store — per-case isolation) ─────────────

export async function runCase(c: DsxTestCase): Promise<CaseFailure[]> {
  const failures: CaseFailure[] = [];
  const store = new ReactiveStore();
  for (const [k, v] of Object.entries(c.scope ?? {})) store.jse.vars.set(k, toJse(v));
  const events: string[] = [];
  const env = makeRunEnv(store, { emitEvent: (name) => { events.push(name); } });
  for (const [name, decl] of Object.entries(c.actions ?? {})) {
    env.actions.set(name, { body: decl.body, inputs: (decl.inputs ?? {}) as Dict });
  }
  const runner = new ActionRunner(env);
  try {
    await runner.run(c.run, c.runItem ? (toJse(c.runItem) as Dict) : null);
  } catch (e) {
    failures.push({ kind: "error", actual: String(e), expected: "run completes" });
  } finally {
    // a fixture that set keyed timers must not keep the CLI process alive
    for (const t of env.timers.values()) (t.interval ? clearInterval : clearTimeout)(t.id);
    env.timers.clear();
  }
  const nil = (v: unknown): unknown => (v === null || v === undefined || v === NSNull ? null : v);
  for (const [path, expected] of Object.entries(c.expectStore ?? {})) {
    const actual = JSE.eval(path, store.jse, null);
    // a JSON null in expectStore means "absent/nil" — matches null OR the NSNull sentinel
    const expectVal = expected === null ? null : toJse(expected);
    if (!JSE.equals(nil(actual), expectVal)) {
      failures.push({ kind: "store", key: path, actual: string(actual), expected: string(expected) });
    }
  }
  const wantEvents = (c.expectEvents ?? []).map((e) => String(e));
  if (JSON.stringify(events) !== JSON.stringify(wantEvents)) {
    failures.push({
      kind: "events", key: "expectEvents",
      actual: JSON.stringify(events), expected: JSON.stringify(wantEvents),
    });
  }
  return failures;
}

// ── one fixture file ─────────────────────────────────────────────────────────────────

function shapeResult(file: string, name: string, complaint: string): CaseResult {
  return {
    file, name, ok: false, ms: 0,
    failures: [{ kind: "shape", actual: complaint, expected: "the actions-corpus case shape" }],
  };
}

export async function runFixture(doc: unknown, file: string): Promise<CaseResult[]> {
  if (!isPlainObject(doc) || !Array.isArray(doc["cases"])) {
    return [shapeResult(file, "(fixture)", `fixture must be { "cases": [ … ] }`)];
  }
  const results: CaseResult[] = [];
  for (const raw of doc["cases"]) {
    const complaint = caseShapeError(raw);
    if (complaint !== null) {
      const name = isPlainObject(raw) && typeof raw["name"] === "string" ? raw["name"] : "(case)";
      results.push(shapeResult(file, name, complaint));
      continue;
    }
    const c = raw as DsxTestCase;
    const t0 = performance.now();
    const failures = await runCase(c);
    results.push({
      file, name: c.name, ok: failures.length === 0,
      ms: performance.now() - t0, failures,
    });
  }
  return results;
}

export async function runFile(file: string): Promise<CaseResult[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return [shapeResult(file, "(fixture)", `fixture does not parse as JSON: ${(e as Error).message}`)];
  }
  return runFixture(doc, file);
}

// ── file discovery ───────────────────────────────────────────────────────────────────

const SUFFIX = ".dsxtest.json";
const SKIP_DIRS = new Set(["node_modules", ".git", ".gradle", "build", "DerivedData", "Pods"]);

export function findTestFiles(roots: string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(SUFFIX)) {
        out.push(join(dir, e.name));
      }
    }
  };
  for (const root of roots) {
    const st = statSync(root, { throwIfNoEntry: false });
    if (st === undefined) {
      console.error(`dsx-test: no such path: ${root}`);
      continue;
    }
    if (st.isFile()) {
      if (root.endsWith(SUFFIX)) out.push(root);
      else console.error(`dsx-test: not a ${SUFFIX} file: ${root}`);
    } else {
      visit(root);
    }
  }
  return [...new Set(out)].sort();
}

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd(); // outside the repo — search the cwd
    dir = parent;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────

function relPath(file: string): string {
  const r = relative(process.cwd(), file);
  return r.length > 0 && !r.startsWith("..") ? r : file;
}

function fmtMs(ms: number): string {
  return ms >= 100 ? `${Math.round(ms)}ms` : `${ms.toFixed(1)}ms`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let json = false;
  const paths: string[] = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      console.log(`usage: node packages/kernel/bin/dsx-test.ts [--json] [roots or ${SUFFIX} files…]`);
      return 0;
    } else paths.push(a);
  }
  const roots = (paths.length > 0 ? paths : [repoRoot()]).map((p) => resolve(p));
  const files = findTestFiles(roots);
  const t0 = performance.now();
  const results: CaseResult[] = [];
  for (const file of files) results.push(...(await runFile(file)));
  const totalMs = performance.now() - t0;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  if (json) {
    console.log(JSON.stringify({
      files: files.length, cases: results.length, passed, failed,
      ms: Math.round(totalMs * 10) / 10,
      results: results.map((r) => ({ ...r, file: relPath(r.file), ms: Math.round(r.ms * 10) / 10 })),
    }, null, 2));
    return failed > 0 ? 1 : 0;
  }

  let lastFile = "";
  for (const r of results) {
    if (r.file !== lastFile) {
      console.log(`\n${relPath(r.file)}`);
      lastFile = r.file;
    }
    console.log(`  ${r.ok ? "pass" : "FAIL"} ${r.name} (${fmtMs(r.ms)})`);
    for (const f of r.failures) {
      if (f.kind === "store") console.log(`       expectStore ${f.key} -> ${f.actual} (expected ${f.expected})`);
      else if (f.kind === "events") console.log(`       expectEvents -> ${f.actual} (expected ${f.expected})`);
      else if (f.kind === "error") console.log(`       run threw: ${f.actual}`);
      else console.log(`       fixture shape: ${f.actual}`);
    }
  }
  console.log("");
  if (files.length === 0) {
    console.log(`dsx-test: no *${SUFFIX.slice(0, -5)}.json files found under ${roots.map(relPath).join(", ")}`);
    return 0;
  }
  const tally = failed > 0 ? `${passed} passed, ${failed} failed` : `${passed} passed`;
  console.log(`dsx-test: ${tally} — ${results.length} case(s) in ${files.length} file(s) (${fmtMs(totalMs)})`);
  return failed > 0 ? 1 : 0;
}

let invokedDirectly = false;
try {
  const entry = process.argv[1];
  invokedDirectly = entry !== undefined &&
    realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) process.exitCode = await main();
