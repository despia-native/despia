// run.ts - the TS runner for the Despia AI conformance corpus.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Runs OpenSource/Conformance/ai/** against the reference host in VERIFY mode.
// Nothing here records or regenerates a fixture: these files are hand-authored
// from the program doc and this runner's only job is to agree or disagree with
// them (the inverse of the jse corpus, which is recorded from Swift).
//
// The corpus path resolves two ways on purpose: `../../Conformance/ai` in the
// monorepo, and `../conformance/ai` inside the published mirror, where the
// slice is vendored next to the package. One runner, both trees.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Host } from '../bindings/ts/src/host.ts';
import type { CaseSpec, Dict } from '../bindings/ts/src/host.ts';

// --- corpus location ---------------------------------------------------

export function corpusRoot(kind: string): string {
  let dir = resolve(import.meta.dirname ?? '.');
  for (;;) {
    for (const candidate of [
      join(dir, 'OpenSource', 'Conformance', kind),   // the monorepo
      join(dir, 'conformance', kind),                 // the published mirror
      join(dir, '..', 'Conformance', kind),
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

// --- the native G2P corpus ---------------------------------------------

/** G2P is a native frontend shared by every platform binding, not a TypeScript
 *  reimplementation.  Its corpus therefore has its own runner beside the C++
 *  implementation.  Running that strict runner here is materially different
 *  from adding its expect keys to IMPLEMENTED_EXPECT_KEYS: the latter would
 *  make 63 cases green without loading a pack or phonemizing one byte.
 *
 *  The source is header-only and compiles in seconds.  A missing compiler is a
 *  hard failure, never a skip, because a green conformance lane must mean these
 *  cases executed. */
function runNativeG2pCorpus(root: string): { cases: number; failures: number } {
  let dir = resolve(import.meta.dirname ?? '.');
  let packageRoot = '';
  for (;;) {
    for (const candidate of [join(dir, 'OpenSource', 'AI'), dir]) {
      if (existsSync(join(candidate, 'engine', 'test', 'g2p_corpus.cpp'))) {
        packageRoot = candidate;
        break;
      }
    }
    if (packageRoot) break;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('OpenSource/AI/engine/test/g2p_corpus.cpp was not found');
    dir = parent;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'despia-ai-g2p-ts-'));
  const binary = join(scratch, process.platform === 'win32' ? 'g2p_corpus.exe' : 'g2p_corpus');
  const compiler = process.env.CXX || (process.platform === 'win32' ? 'clang++.exe' : 'c++');
  try {
    const build = spawnSync(compiler, [
      '-std=c++17', '-O1', '-Wall', '-Wextra', '-o', binary,
      join(packageRoot, 'engine', 'test', 'g2p_corpus.cpp'),
    ], { encoding: 'utf8' });
    if (build.error || build.status !== 0) {
      throw new Error(`${compiler} could not build the required G2P corpus runner:\n${
        build.error?.message ?? `${build.stdout}${build.stderr}`}`);
    }

    const execution = spawnSync(binary, [root], { encoding: 'utf8' });
    const output = `${execution.stdout ?? ''}${execution.stderr ?? ''}`;
    process.stdout.write(output);
    const summary = output.match(/g2p_corpus:\s+(\d+) cases\s+[^\d]+\s*(\d+) failures/);
    if (!summary) throw new Error('the G2P runner did not emit its machine-checked case summary');
    const cases = Number(summary[1]);
    const failures = Number(summary[2]);
    if (execution.error || execution.status !== 0 || failures !== 0) {
      return { cases, failures: Math.max(failures, 1) };
    }
    return { cases, failures };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

// --- the checks --------------------------------------------------------

type Failure = string;

function checkEvents(expected: Dict[], host: Host, fail: (f: Failure) => void): void {
  // Ordered SUBSEQUENCE: the listed events must appear in the listed relative
  // order. Unlisted events between them are allowed, so a case can name its
  // landmarks without restating the whole stream.
  let cursor = 0;
  for (const want of expected) {
    let found = -1;
    for (let i = cursor; i < host.events.length; i++) {
      const got = host.events[i];
      if (want.req !== undefined && got.req !== want.req) continue;
      if (want.event !== undefined && got.event !== want.event) continue;
      if (want.final !== undefined && got.final !== want.final) continue;
      if (want.data !== undefined && !subsetMatch(want.data, got.data)) continue;
      found = i;
      break;
    }
    if (found < 0) {
      fail(`expected event ${show(want)} was not found after index ${cursor}\n      got: ${
        show(host.events.map((e) => ({ req: e.req, event: e.event })))}`);
      return;
    }
    cursor = found + 1;
  }
}

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

/** Binary never rides JSON. A reference block carries a url and the native side
 *  owns the bytes; anything that looks like inline payload fails here. */
function checkNoInlineBytes(host: Host, fail: (f: Failure) => void): void {
  const suspectKeys = new Set(['pcm', 'base64', 'buffer', 'audio_data', 'image_data']);
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      if (v.length > 64 && v.every((x) => typeof x === 'number')) {
        fail(`inline byte array at ${path}`);
      }
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Dict)) {
        if (suspectKeys.has(k)) fail(`inline binary key '${k}' at ${path}`);
        if (typeof val === 'string' && val.length > 512) {
          fail(`suspiciously long string at ${path}.${k} (${val.length} chars)`);
        }
        walk(val, `${path}.${k}`);
      }
    }
  };
  for (const e of host.events) walk(e.data, `${e.req}:${e.event}`);
  for (const r of host.engine.requests) walk(r, 'request');
}

function runCase(c: Dict, fail: (f: Failure) => void): void {
  const host = new Host(c as CaseSpec);
  const expect: Dict = (c.expect ?? {}) as Dict;

  // A build-abort case asserts a PREPARE-time refusal, so it is answered by
  // the derivation and never by a running request.
  if (expect.buildAbort) {
    if (!host.buildAbort) fail(`expected a build abort, the derivation produced none`);
    else if (!subsetMatch(expect.buildAbort, host.buildAbort)) {
      fail(`buildAbort: expected ${show(expect.buildAbort)}, got ${show(host.buildAbort)}`);
    }
    return;
  }

  for (const step of (c.steps ?? []) as Dict[]) {
    if (step.call) host.call(step.call as Dict);
    else if (step.cancel) host.cancel(String((step.cancel as Dict).target));
    else if (step.resync) host.resync(String((step.resync as Dict).target));
    else if (step.approve) {
      const a = step.approve as Dict;
      host.approve(String(a.id), a.decision === 'deny' ? 'deny' : 'approve');
    } else if (step.tick) host.tick(Number((step.tick as Dict).ms ?? 0));
    else if (step.serverRequest) host.serverRequest(step.serverRequest as Dict);
    else fail(`unknown step: ${show(step)}`);
  }

  if (expect.events) checkEvents(expect.events as Dict[], host, fail);

  if (expect.eventCounts) {
    for (const [name, want] of Object.entries(expect.eventCounts as Dict)) {
      const got = host.events.filter((e) => e.event === name).length;
      if (got !== want) fail(`eventCounts.${name}: expected ${want}, got ${got}`);
    }
  }

  if (expect.distinctRids) {
    const rids = (expect.distinctRids as string[]).map((l) => host.ridOf[l]);
    if (new Set(rids).size !== rids.length || rids.some((r) => r === undefined)) {
      fail(`distinctRids: labels did not map to distinct request ids (${show(rids)})`);
    }
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
  if (expect.notices) checkList('notices', expect.notices as Dict[], host.notices, fail);
  if (expect.catalogNotices) {
    checkList('catalogNotices', expect.catalogNotices as Dict[], host.catalogNotices, fail);
  }
  if (expect.dispatched) checkList('dispatched', expect.dispatched as Dict[], host.dispatched, fail);
  if (expect.engineRequests) {
    checkList('engineRequests', expect.engineRequests as Dict[], host.engine.requests as Dict[], fail);
  }
  if (expect.remoteRequests) {
    checkList('remoteRequests', expect.remoteRequests as Dict[], host.remoteRequests, fail);
  }
  if (expect.rows) checkList('rows', expect.rows as Dict[], host.rows, fail);
  if (expect.downloadAttempts) {
    checkList('downloadAttempts', expect.downloadAttempts as Dict[], host.downloadAttempts, fail);
  }
  if (expect.resolveAttempts) {
    checkList('resolveAttempts', expect.resolveAttempts as Dict[], host.resolveAttempts, fail);
  }
  if (expect.downloaded) checkList('downloaded', expect.downloaded as Dict[], host.downloaded, fail);
  if (expect.deletedOnMismatch) {
    const want = expect.deletedOnMismatch as string[];
    if (JSON.stringify(want) !== JSON.stringify(host.deletedOnMismatch)) {
      fail(`deletedOnMismatch: expected ${show(want)}, got ${show(host.deletedOnMismatch)}`);
    }
  }
  if (expect.pinnedDigests) {
    for (const [model, want] of Object.entries(expect.pinnedDigests as Dict)) {
      if (host.pinnedDigests[model] !== want) {
        fail(`pinnedDigests.${model}: expected ${show(want)}, got ${show(host.pinnedDigests[model])}`);
      }
    }
  }
  if (expect.providers) checkList('providers', expect.providers as Dict[], host.providers, fail);
  if (expect.transcript) checkList('transcript', expect.transcript as Dict[], host.transcript, fail);
  if (expect.serverResponses) {
    checkList('serverResponses', expect.serverResponses as Dict[], host.serverResponses, fail);
  }

  if (expect.dispatchGroups) {
    const want = expect.dispatchGroups as string[][];
    if (JSON.stringify(want) !== JSON.stringify(host.dispatchGroups)) {
      fail(`dispatchGroups: expected ${show(want)}, got ${show(host.dispatchGroups)}`);
    }
  }

  const counts: Array<[string, number | undefined, number]> = [
    ['dispatchCount', expect.dispatchCount as number | undefined, host.dispatched.length],
    ['engineRequestCount', expect.engineRequestCount as number | undefined, host.engine.requests.length],
    ['remoteRequestCount', expect.remoteRequestCount as number | undefined, host.remoteRequests.length],
    ['downloadCount', expect.downloadCount as number | undefined, host.downloadCount],
    ['mcpConnectCount', expect.mcpConnectCount as number | undefined, host.mcpConnectCount],
    ['downloadAttemptCount', expect.downloadAttemptCount as number | undefined, host.downloadAttempts.length],
    ['resolveAttemptCount', expect.resolveAttemptCount as number | undefined, host.resolveAttempts.length],
    ['engineLoadCount', expect.engineLoadCount as number | undefined, host.engineLoadCount],
  ];
  for (const [name, want, got] of counts) {
    if (want !== undefined && want !== got) fail(`${name}: expected ${want}, got ${got}`);
  }

  if (expect.verdicts) {
    for (const [id, want] of Object.entries(expect.verdicts as Dict)) {
      const got = host.verdicts.get(id);
      if (!got) fail(`verdicts.${id}: no verdict was computed`);
      else if (!subsetMatch(want, got)) {
        fail(`verdicts.${id}: expected ${show(want)}, got ${show(got)}`);
      }
    }
  }

  if (expect.maxEventBytes !== undefined) {
    // The bound applies to INCREMENTAL events; sync and complete are snapshots
    // by design. A cumulative-snapshot-per-token wire fails this.
    const bound = Number(expect.maxEventBytes);
    for (const e of host.events) {
      if (e.event === 'sync' || e.event === 'complete') continue;
      const size = JSON.stringify(e.data).length;
      if (size > bound) {
        fail(`maxEventBytes: a ${e.event} event serialized to ${size} bytes, over the ${bound} bound`);
        break;
      }
    }
  }

  if (expect.noInlineBytes) checkNoInlineBytes(host, fail);
  if (expect.noErrors && host.errors.length > 0) {
    fail(`noErrors: the case produced ${show(host.errors)}`);
  }

  const flags: Array<[string, boolean]> = [
    ['dispatchedAfterApproval', host.dispatchedAfterApproval],
    ['snapshotBeforeWrite', host.snapshotBeforeWrite],
    ['snapshotBeforeFirstWrite', host.snapshotBeforeFirstWrite],
    ['boundLoopbackOnly', host.boundLoopbackOnly],
    ['transcriptTransmitted', host.transcriptTransmitted],
    ['tokenInUrl', host.tokenInUrl],
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
}

// --- entry point -------------------------------------------------------

/** Every expect key runCase() actually reads. A corpus file's `requires` array
 *  is checked against this, and a key that is not here fails the FILE.
 *
 *  This exists because the alternative already happened. The G2P corpus landed
 *  63 cases using 14 expect keys this runner had never heard of. runCase() reads
 *  the keys it knows and ignores the rest, so all 63 were counted, none was
 *  checked, and the lane reported 186/186 with 34% of the corpus asserting
 *  nothing. The corpus author saw that coming and put `requires` in every file
 *  precisely to prevent it. Nothing read it.
 *
 *  So: adding a key to a corpus without teaching a runner to check it now turns
 *  that runner RED. That is the point. A conformance harness whose failure mode
 *  is silent success is worse than no harness, because the green is what stops
 *  anyone looking. */
const IMPLEMENTED_EXPECT_KEYS = new Set([
  'buildAbort', 'events', 'eventCounts', 'distinctRids', 'results',
  'absences', 'errors', 'logs', 'state', 'discoveryFile',
]);

export function run(kinds: string[] = ['ai']): number {
  let total = 0;
  let failed = 0;
  let skippedFiles = 0;
  let skippedCases = 0;
  for (const kind of kinds) {
    const root = corpusRoot(kind);
    const g2pRoot = join(root, 'g2p');
    if (existsSync(join(g2pRoot, 'fixture-pack.json'))) {
      const expected = corpusFiles(g2pRoot).reduce((sum, file) => {
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        return sum + (Array.isArray(doc.cases) ? doc.cases.length : 0);
      }, 0);
      total += expected;
      try {
        const result = runNativeG2pCorpus(g2pRoot);
        if (result.cases !== expected) {
          failed++;
          console.log(`FAIL g2p native corpus\n    expected ${expected} source cases, runner executed ${result.cases}`);
        } else {
          failed += result.failures;
        }
      } catch (err) {
        failed++;
        console.log(`FAIL g2p native corpus\n    ${(err as Error).message}`);
      }
    }
    for (const file of corpusFiles(root)) {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      const rel = file.slice(root.length + 1);

      // These files were executed as one native corpus above.  Keeping their
      // shared fixture and cross-file invariants in one process is part of the
      // G2P runner's contract; executing them again through Host would be a
      // vacuous pass because Host does not implement the native frontend.
      if (rel === 'g2p' || rel.startsWith(`g2p/`)) continue;

      // The requires guard, before any case in the file runs. A file this
      // runner cannot serve is SKIPPED and SAID OUT LOUD, never counted as
      // passing. Some corpora exercise a subsystem that lives in one lane only:
      // the G2P cases drive C++ that has no TypeScript equivalent, so skipping
      // them here is correct and silently counting them was not.
      //
      // The skip is loud on purpose, and the count is in the summary line, so
      // "186/186 passed" can never again mean "123 checked and 63 waved
      // through". A file that is skipped by EVERY runner is a file nothing
      // executes, which is the state this corpus was in.
      const requires: string[] = Array.isArray(doc.requires) ? doc.requires : [];
      const missing = requires.filter((k) => !IMPLEMENTED_EXPECT_KEYS.has(k));
      if (missing.length > 0) {
        const count = (doc.cases ?? []).length;
        skippedFiles++;
        skippedCases += count;
        console.log(`SKIP ${rel} (${count} cases) requires [${missing.join(', ')}]`);
        continue;
      }

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
  const skipNote = skippedFiles > 0
    ? `, ${skippedCases} cases in ${skippedFiles} files SKIPPED (this runner cannot serve them)`
    : '';
  console.log(`\nconformance: ${total - failed}/${total} cases passed${skipNote}`);
  return failed;
}

if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  const kinds = process.argv.slice(2);
  process.exit(run(kinds.length > 0 ? kinds : ['ai']) === 0 ? 0 : 1);
}
