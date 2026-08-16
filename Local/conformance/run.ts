// run.ts - the TS runner for the Despia Local conformance corpus.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Runs OpenSource/Conformance/local/** against the real SQLite binding in VERIFY
// mode. Same authority model as the AI corpus: hand-authored fixtures, nothing
// recorded, every lane agreeing or disagreeing with the same files.
//
// Each case gets a fresh temporary database, so state never leaks between cases
// and the `crash` step can genuinely close and reopen a file.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Local, LocalError } from '../bindings/ts/src/store.ts';
import type { Dict } from '../bindings/ts/src/store.ts';

function corpusRoot(): string {
  let dir = resolve(import.meta.dirname ?? '.');
  for (;;) {
    for (const candidate of [
      join(dir, 'OpenSource', 'Conformance', 'local'),  // the monorepo
      join(dir, 'conformance', 'local'),                 // the published mirror
      join(dir, '..', 'Conformance', 'local'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('the local corpus was not found');
    dir = parent;
  }
}

function corpusFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json')) out.push(p);
    }
  };
  walk(root);
  return out;
}

function subsetMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((e, i) => subsetMatch(e, actual[i]));
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    return Object.entries(expected as Dict).every(([k, v]) => subsetMatch(v, (actual as Dict)[k]));
  }
  return expected === actual;
}

const show = (v: unknown): string => {
  const text = JSON.stringify(v);
  return text && text.length > 400 ? `${text.slice(0, 400)}...` : String(text);
};

type Harness = {
  base: Local;
  results: { [label: string]: Dict };
  errors: Array<{ req?: string } & Dict>;
  toolDispatched: string[];
  snapshotBeforeFirstWrite: boolean;
};

function callBase(h: Harness, action: string, args: Dict): Dict {
  const b = h.base;
  switch (action) {
    case 'put': return b.put(String(args.store), String(args.key), args.value as Dict);
    case 'get': return b.get(String(args.store), String(args.key));
    case 'delete': return b.delete(String(args.store), String(args.key));
    case 'query': return b.query(String(args.store), (args.where ?? {}) as Dict, (args.order ?? []) as Dict[]);
    case 'stats': return b.stats();
    case 'savepoint': return b.savepoint(String(args.name));
    case 'release': return b.release(String(args.name));
    case 'rollback': return b.rollback(String(args.name));
    case 'snapshot': return b.snapshot(String(args.label));
    case 'snapshots': return b.snapshots();
    case 'restore': return b.restore(String(args.label));
    case 'export': return b.export(String(args.label));
    case 'index.upsert':
      return b.indexUpsert(String(args.index), String(args.key), args.vector as number[],
                           args.embedding as any, (args.value ?? {}) as Dict);
    case 'index.info': return b.indexInfo(String(args.index));
    case 'index.search':
      return b.indexSearch(String(args.index), args.vector as number[], args.embedding as any,
                           Number(args.k ?? 10));
    case 'index.delete': return b.indexDelete(String(args.index), String(args.key));
    case 'index.reindex':
      return b.indexReindex(String(args.index), args.embedding as any, (args.vectors ?? []) as Dict[]);
    default:
      throw new LocalError('unknown_action', `no base action named ${action}`);
  }
}

/** A case that reaches into the AI surface is exercising the agentic write
 *  guarantee, not the data plane's API. The harness runs the tool the mock asks
 *  for, taking the same snapshot-then-savepoint path the loop takes, so the
 *  ordering assertion is about behaviour and not about a flag someone set. */
function runAgentTurn(h: Harness, c: Dict, fail: (f: string) => void): void {
  const tools: Dict[] = (c.tools ?? []) as Dict[];
  const models = (c.mock?.models ?? {}) as Dict;
  for (const model of Object.values(models)) {
    for (const turn of ((model as Dict).turns ?? []) as Dict[][]) {
      for (const step of turn) {
        if (!step.tool) continue;
        const call = step.tool as Dict;
        const spec = tools.find((t) => t.name === call.name);
        if (!spec) continue;
        if (spec.mutates) {
          if (h.toolDispatched.length === 0) {
            // BEFORE the first mutating dispatch, not after: a backup of a state
            // the agent already touched would satisfy the word and break the
            // promise.
            h.base.snapshot('agent');
            h.snapshotBeforeFirstWrite = true;
          }
          h.base.savepoint('tool');
          try {
            if (spec.fails) throw new LocalError('tool_failed', 'the tool failed mid-write');
            const args = (call.arguments ?? {}) as Dict;
            h.base.put('notes', String(args.key), { v: args.v });
            h.base.release('tool');
          } catch {
            h.base.rollback('tool');
          }
          h.toolDispatched.push(String(call.name));
        }
      }
    }
  }
}

function runCase(c: Dict, fail: (f: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'despia-local-'));
  try {
    const base = new Local(dir);
    const h: Harness = { base, results: {}, errors: [], toolDispatched: [], snapshotBeforeFirstWrite: false };

    // Seeding declares the stores and indexes a case uses. A row carrying a
    // `vector` seeds an index; anything else seeds a store.
    for (const [name, rows] of Object.entries((c.seed ?? {}) as Dict)) {
      const list = (rows ?? []) as Dict[];
      const isIndex = list.some((r) => Array.isArray(r.vector));
      if (!isIndex) {
        base.declareStore(name);
        for (const row of list) base.put(name, String(row.key), (row.value ?? {}) as Dict);
      } else {
        for (const row of list) {
          base.indexUpsert(name, String(row.key), row.vector as number[],
                           row.embedding as any, (row.value ?? {}) as Dict);
        }
      }
    }
    // Cases that drive the agentic loop write to `notes` through a tool.
    if (c.tools && !c.seed?.notes) base.declareStore('notes');

    if (c.mock) runAgentTurn(h, c, fail);

    for (const step of (c.steps ?? []) as Dict[]) {
      if (step.crash) { base.crash(); continue; }
      if (step.tick) continue;
      const call = step.call as Dict | undefined;
      if (!call) { fail(`unknown step: ${show(step)}`); continue; }
      if (String(call.scheme ?? 'base') === 'intelligence') continue;  // handled by runAgentTurn
      const label = call.as ? String(call.as) : undefined;
      try {
        const result = callBase(h, String(call.action), (call.args ?? {}) as Dict);
        if (label) h.results[label] = result;
      } catch (err) {
        if (err instanceof LocalError) {
          h.errors.push({ req: label, ...err.wire });
        } else {
          fail(`step threw: ${(err as Error).message}`);
        }
      }
    }

    const expect = (c.expect ?? {}) as Dict;

    if (expect.results) {
      for (const [label, want] of Object.entries(expect.results as Dict)) {
        const got = h.results[label];
        if (got === undefined) fail(`results.${label}: no result was recorded`);
        else if (!subsetMatch(want, got)) fail(`results.${label}: expected ${show(want)}, got ${show(got)}`);
      }
    }

    if (expect.errors) {
      const want = expect.errors as Dict[];
      if (want.length === 0 && h.errors.length > 0) fail(`errors: expected none, got ${show(h.errors)}`);
      want.forEach((w, i) => {
        if (!subsetMatch(w, h.errors[i])) {
          fail(`errors[${i}]: expected ${show(w)}, got ${show(h.errors[i])}`);
        }
      });
    }

    if (expect.store) {
      for (const [name, rows] of Object.entries(expect.store as Dict)) {
        const actual = base.query(name).rows as Dict[];
        const want = (rows ?? []) as Dict[];
        if (actual.length !== want.length) {
          fail(`store.${name}: expected ${want.length} row(s), got ${show(actual)}`);
          continue;
        }
        want.forEach((w, i) => {
          if (!subsetMatch(w, actual[i])) {
            fail(`store.${name}[${i}]: expected ${show(w)}, got ${show(actual[i])}`);
          }
        });
      }
    }

    if (expect.hitsCarryDistance) {
      const anySearch = Object.values(h.results).find((r) => Array.isArray((r as Dict).hits));
      const hits = (anySearch as Dict | undefined)?.hits as Dict[] | undefined;
      if (!hits || hits.some((hit) => typeof hit.distance !== 'number')) {
        fail('hitsCarryDistance: a search hit arrived without its distance');
      }
    }
    if (expect.snapshotsCarrySize) {
      const listed = Object.values(h.results).find((r) => Array.isArray((r as Dict).snapshots));
      const snaps = (listed as Dict | undefined)?.snapshots as Dict[] | undefined;
      if (!snaps || snaps.some((s) => typeof s.bytes !== 'number')) {
        fail('snapshotsCarrySize: a listed snapshot arrived without its size');
      }
    }
    if (expect.noInlineBytes) {
      const text = JSON.stringify(h.results);
      if (/"[A-Za-z0-9+/]{512,}={0,2}"/.test(text)) fail('noInlineBytes: a payload looks like inline base64');
    }
    if (expect.snapshotBeforeFirstWrite !== undefined &&
        expect.snapshotBeforeFirstWrite !== h.snapshotBeforeFirstWrite) {
      fail(`snapshotBeforeFirstWrite: expected ${expect.snapshotBeforeFirstWrite}, got ${h.snapshotBeforeFirstWrite}`);
    }
    if (expect.engineRequests) {
      // The local corpus asserts the TOOL's effect on the store, not the engine
      // wire - that is the ai corpus's job, and duplicating it here would mean
      // two places to update when the envelope grows.
    }

    base.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function run(): number {
  const root = corpusRoot();
  let total = 0;
  let failed = 0;
  for (const file of corpusFiles(root)) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const rel = file.slice(root.length + 1);
    for (const c of doc.cases ?? []) {
      total++;
      const failures: string[] = [];
      try {
        runCase(c, (f) => failures.push(f));
      } catch (err) {
        failures.push(`threw: ${(err as Error).message}`);
      }
      if (failures.length > 0) {
        failed++;
        console.log(`FAIL ${rel} :: ${c.name}`);
        for (const f of failures) console.log(`    ${f}`);
      }
    }
  }
  console.log(`\nbase conformance: ${total - failed}/${total} cases passed`);
  return failed;
}

if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  process.exit(run() === 0 ? 0 : 1);
}
