// run.ts - the TS runner for the Despia MCP conformance corpus.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Runs the `mcp` slice of the shared AI corpus against the reference host in
// VERIFY mode. Nothing here records or regenerates a fixture: the cases are
// hand-authored from the program doc, and this runner's only job is to agree or
// disagree with them.
//
// The corpus path resolves two ways on purpose, the same trick the sibling
// packages use: `OpenSource/Conformance/ai/mcp` in the monorepo, and
// `conformance/mcp` inside the published mirror, where mirror.json grafts the
// slice in next to this file. One runner, both trees, no flags.
//
//   node conformance/run.ts            # the mcp slice
//   node conformance/run.ts mcp        # the same thing, named
//
// `ClosedSource/scripts/check_despia_mcp.rb` runs the second spelling, and the
// mirror lane refuses to publish when it exits non-zero.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Host } from './host.ts';
import type { CaseSpec, Dict } from './host.ts';

// --- corpus location ---------------------------------------------------

export function corpusRoot(kind: string): string {
  let dir = resolve(import.meta.dirname ?? '.');
  for (;;) {
    for (const candidate of [
      join(dir, 'OpenSource', 'Conformance', 'ai', kind),   // the monorepo
      join(dir, 'conformance', kind),                       // the published mirror
      join(dir, '..', 'Conformance', 'ai', kind),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`the ${kind} corpus was not found`);
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

// --- subset matching ---------------------------------------------------

/** Every object comparison in the corpus is a SUBSET match: listed keys must
 *  compare deep-equal, unlisted keys are ignored. That is what lets a fixture
 *  pin the part of a payload it cares about without freezing fields a later
 *  release is allowed to add. */
export function subsetMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((e, i) => subsetMatch(e, actual[i]));
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    return Object.entries(expected as Dict).every(([k, v]) =>
      subsetMatch(v, (actual as Dict)[k]));
  }
  return expected === actual;
}

function show(v: unknown): string {
  const text = JSON.stringify(v);
  return text && text.length > 400 ? `${text.slice(0, 400)}...` : String(text);
}

type Failure = string;

function checkList(name: string, expected: Dict[], actual: Dict[], fail: (f: Failure) => void): void {
  if (actual.length < expected.length) {
    fail(`${name}: expected at least ${expected.length} entries, got ${actual.length}: ${show(actual)}`);
    return;
  }
  expected.forEach((want, i) => {
    if (!subsetMatch(want, actual[i])) {
      fail(`${name}[${i}]: expected ${show(want)}, got ${show(actual[i])}`);
    }
  });
  if (expected.length === 0 && actual.length > 0) {
    fail(`${name}: expected none, got ${show(actual)}`);
  }
}

/** The token is the boundary, so it must never land anywhere a URL lands.
 *  Nothing the host recorded may carry it in a path or a query string. */
function checkTokenNeverInUrl(host: Host, fail: (f: Failure) => void): void {
  const suspect = /[?&](?:token|access_token|key|auth)=/i;
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (suspect.test(v)) fail(`a token-shaped query parameter appears at ${path}: ${show(v)}`);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Dict)) walk(val, `${path}.${k}`);
    }
  };
  walk(host.serverResponses, 'serverResponses');
  walk(host.discoveryFile, 'discoveryFile');
  walk(host.engineRequests, 'engineRequests');
}

function runCase(c: Dict, fail: (f: Failure) => void): void {
  const host = new Host(c as CaseSpec);
  const expect: Dict = (c.expect ?? {}) as Dict;

  for (const step of (c.steps ?? []) as Dict[]) {
    if (step.call) host.call(step.call as Dict);
    else if (step.serverRequest) host.serverRequest(step.serverRequest as Dict);
    else if (step.approve) {
      const a = step.approve as Dict;
      host.approve(String(a.id), a.decision === 'deny' ? 'deny' : 'approve');
    } else fail(`unknown step: ${show(step)}`);
  }

  if (expect.results) {
    for (const [label, want] of Object.entries(expect.results as Dict)) {
      const got = host.results[label];
      if (got === undefined) fail(`results.${label}: no result was recorded`);
      else if (!subsetMatch(want, got)) {
        fail(`results.${label}: expected ${show(want)}, got ${show(got)}`);
      }
    }
  }

  if (expect.errors) checkList('errors', expect.errors as Dict[], host.errors, fail);
  if (expect.absent) checkList('absent', expect.absent as Dict[], host.absent, fail);
  if (expect.dispatched) checkList('dispatched', expect.dispatched as Dict[], host.dispatched, fail);
  if (expect.engineRequests) {
    checkList('engineRequests', expect.engineRequests as Dict[], host.engineRequests as Dict[], fail);
  }
  if (expect.serverResponses) {
    checkList('serverResponses', expect.serverResponses as Dict[], host.serverResponses, fail);
  }

  const counts: Array<[string, number | undefined, number]> = [
    ['dispatchCount', expect.dispatchCount as number | undefined, host.dispatched.length],
    ['engineRequestCount', expect.engineRequestCount as number | undefined, host.engineRequests.length],
    ['mcpConnectCount', expect.mcpConnectCount as number | undefined, host.mcpConnectCount],
  ];
  for (const [name, want, got] of counts) {
    if (want !== undefined && want !== got) fail(`${name}: expected ${want}, got ${got}`);
  }

  const flags: Array<[string, boolean]> = [
    ['boundLoopbackOnly', host.boundLoopbackOnly],
    ['tokenInUrl', host.tokenInUrl],
    ['snapshotBeforeWrite', host.snapshotBeforeWrite],
    ['dispatchedAfterApproval', host.dispatchedAfterApproval],
  ];
  for (const [name, got] of flags) {
    if (expect[name] !== undefined && expect[name] !== got) {
      fail(`${name}: expected ${expect[name]}, got ${got}`);
    }
  }

  if (expect.discoveryFile) {
    if (!host.discoveryFile) fail('discoveryFile: none was written');
    else if (!subsetMatch(expect.discoveryFile, host.discoveryFile)) {
      fail(`discoveryFile: expected ${show(expect.discoveryFile)}, got ${show(host.discoveryFile)}`);
    }
  }

  // Unconditional, on every case: a leak does not announce itself in an
  // `expect` block, so this one is not opt-in.
  checkTokenNeverInUrl(host, fail);
}

// --- entry point -------------------------------------------------------

export function run(kinds: string[] = ['mcp']): number {
  let total = 0;
  let failed = 0;
  for (const kind of kinds) {
    const root = corpusRoot(kind);
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
  }
  console.log(`\nconformance: ${total - failed}/${total} cases passed`);
  return failed;
}

if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  const kinds = process.argv.slice(2);
  process.exit(run(kinds.length > 0 ? kinds : ['mcp']) === 0 ? 0 : 1);
}
