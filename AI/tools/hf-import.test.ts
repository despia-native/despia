// hf-import.test.ts - the importer fills the compliance fields, or refuses.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The network call is injected, so these run offline and deterministically. What
// is under test is the part that matters: that an entry cannot come out of this
// tool pointing at a moving target, missing its licence, or claiming a format
// the engine does not carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importEntry, formatFor, slugFor, languagesFrom } from './hf-import.ts';
import type { HfModelInfo } from './hf-import.ts';

const INFO: HfModelInfo = {
  sha: 'abc123def456abc123def456abc123def456abcd',
  siblings: [
    { rfilename: 'model-q4.gguf', lfs: { sha256: 'f'.repeat(64), size: 397000000 } },
    { rfilename: 'README.md', size: 4096 },
  ],
  cardData: { license: 'apache-2.0', language: ['en', 'ar'] },
  config: { model_type: 'qwen3' },
};

const fetchInfo = async () => INFO;

test('the revision is pinned to a commit, never left as a branch', async () => {
  const entry = await importEntry({ repo: 'org/model', file: 'model-q4.gguf', revision: 'main', fetchInfo });
  assert.ok(entry.files[0].urls[0].includes(INFO.sha!),
            'the URL must carry the commit, not the branch');
  assert.ok(!entry.files[0].urls[0].includes('/main/'),
            'a branch name in a catalog entry is a promise nobody can keep');
});

test('the digest and size come from the origin', async () => {
  const entry = await importEntry({ repo: 'org/model', file: 'model-q4.gguf', fetchInfo });
  assert.equal(entry.files[0].sha256, 'f'.repeat(64));
  assert.equal(entry.files[0].bytes, 397000000);
  assert.equal(entry._note, undefined, 'a digest was published, so no pin-on-first-download note');
});

test('a file with no published digest ships without one and says so', async () => {
  const info: HfModelInfo = { ...INFO, siblings: [{ rfilename: 'model-q4.gguf', size: 123 }] };
  const entry = await importEntry({ repo: 'org/model', file: 'model-q4.gguf', fetchInfo: async () => info });
  assert.equal(entry.files[0].sha256, undefined);
  assert.match(entry._note ?? '', /pins one on first download/,
               'the entry must say which digest path it is on');
});

test('the licence comes from the repo, and its absence is a refusal', async () => {
  const entry = await importEntry({ repo: 'org/model', file: 'model-q4.gguf', fetchInfo });
  assert.equal(entry.license.id, 'apache-2.0');

  const unlicensed: HfModelInfo = { ...INFO, cardData: {} };
  await assert.rejects(
    () => importEntry({ repo: 'org/model', file: 'model-q4.gguf', fetchInfo: async () => unlicensed }),
    /declares no licence/,
    'engine is not weights: an entry without terms would make the catalog lie');
});

test('an unresolvable revision is refused rather than pinned hopefully', async () => {
  const noCommit: HfModelInfo = { ...INFO, sha: undefined };
  await assert.rejects(
    () => importEntry({ repo: 'org/model', file: 'model-q4.gguf', fetchInfo: async () => noCommit }),
    /moving target/);
});

test('a missing file is refused and lists what is actually there', async () => {
  await assert.rejects(
    () => importEntry({ repo: 'org/model', file: 'nope.gguf', fetchInfo }),
    /Available: model-q4\.gguf/);
});

test('a format this build does not carry is refused at import time', async () => {
  const info: HfModelInfo = { ...INFO, siblings: [{ rfilename: 'model.safetensors', size: 1 }] };
  await assert.rejects(
    () => importEntry({ repo: 'org/model', file: 'model.safetensors', fetchInfo: async () => info }),
    /not a format this build carries/,
    'better here than at load time on someone else phone');
});

test('languages and family ride along so routing and fit can answer honestly', async () => {
  const entry = await importEntry({ repo: 'org/model', file: 'model-q4.gguf', fetchInfo });
  assert.deepEqual(entry.languages, ['en', 'ar']);
  assert.equal(entry.family, 'qwen3');
  assert.deepEqual(entry.inputs, ['text']);
});

test('the derived id is stable and url-safe', () => {
  assert.equal(slugFor('Qwen/Qwen3-0.6B', 'Qwen3-0.6B-Q4_K_M.gguf'), 'qwen3-0.6b-qwen3-0.6b-q4-k-m');
  assert.equal(formatFor('x.gguf'), 'gguf');
  assert.equal(formatFor('x.safetensors'), null);
  assert.deepEqual(languagesFrom({ cardData: { language: 'en' } }), ['en']);
});
