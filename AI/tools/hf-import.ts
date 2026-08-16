// hf-import.ts - turn a Hugging Face model file into a catalog entry.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Importing a model has to be EASY or people will paste a URL and skip the
// compliance fields; it has to be COMPLIANT or the catalog starts lying about
// licences. So the tool fills them in: repo plus file goes in, and out comes an
// entry with an immutable revision, a digest, the licence id, and the size.
//
// THE SYNTHESIS ITSELF IS NOT HERE. It is `bindings/ts/src/catalog.ts`, shared
// with the `models.add` host action, because the runtime and the authoring tool
// must produce the SAME entry from the same inputs or the catalog quietly grows
// two dialects. What lives in this file is the part that is genuinely
// tool-shaped: the Hugging Face coordinates, the network calls, the CLI, and
// the stricter stance an authoring tool can afford - a repo that declares no
// licence is REFUSED here, where a human can go fix it, while the runtime
// records `unknown` and lets the surface decide.
//
// Three properties the shared synthesis guarantees, restated because this tool
// is where a developer meets them:
//
//   1. THE REVISION IS IMMUTABLE. `main` is a moving target, so the branch is
//      resolved to its commit SHA and THAT is written into the URL.
//   2. THE DIGEST IS RECORDED when the origin publishes one, and when it does
//      not the entry says so and the device pins on first download instead.
//   3. THE LICENCE COMES FROM THE REPO, not from the person importing.
//
// This is an authoring tool, not runtime. It is the one file in the package
// allowed to name a hostname, and ai_package_gate.rb records that explicitly
// rather than leaving the "no network path" claim vague.
//
//   node tools/hf-import.ts <org/repo> <file.gguf> [--revision main] [--id my-model]
//                           [--header]   # also read the GGUF header for context length

import {
  DEFAULT_SERVING_CONTEXT, formatFor, languagesFrom, parseSource, pickFile, slugFor, synthesize,
} from '../bindings/ts/src/catalog.ts';
import type {
  CatalogEntry, GgufKV, RepoFile, RepoInfo, SourceRow,
} from '../bindings/ts/src/catalog.ts';

export type HfFile = RepoFile;
export type HfModelInfo = RepoInfo;
export { formatFor, slugFor, languagesFrom };
export type { CatalogEntry };

const HF = 'https://huggingface.co';

/** Hugging Face's coordinates, in the same TEMPLATE shape an app declares in
 *  `catalog.sources`. Stating them once, here, is what lets the synthesis stay
 *  hostname-free: a registry's answer can never say where the next request
 *  goes, because the app said. */
export const HF_REGISTRY: SourceRow = {
  // `?blobs=true` is not decoration: WITHOUT it the response omits `lfs`, so the
  // entry gets no digest and no size - which is how an importer silently produces
  // an entry with neither, as this one did until the real API was run against it.
  api: `${HF}/api/models/{repo}/revision/{revision}?blobs=true`,
  file: `${HF}/{repo}/resolve/{commit}/{path}`,
  page: `${HF}/{repo}`,
  default_revision: 'main',
};

export type ImportOptions = {
  repo: string;
  file: string;
  revision?: string;
  id?: string;
  /** Injected so the synthesis is testable without a network. */
  fetchInfo?: (repo: string, revision: string) => Promise<HfModelInfo>;
  /** Injected the same way: reads the GGUF metadata table off the file's first
   *  bytes. Absent, the entry falls back to the registry and says so. */
  fetchHeader?: (url: string) => Promise<GgufKV | undefined>;
};

async function fetchInfoOverNetwork(repo: string, revision: string): Promise<HfModelInfo> {
  const response = await fetch(
    `${HF}/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`);
  if (!response.ok) {
    throw new Error(`Hugging Face returned ${response.status} for ${repo}@${revision}`);
  }
  return await response.json() as HfModelInfo;
}

// --- the GGUF header, read over the wire ----------------------------------

const GGUF_PREFIX_BYTES = 1 << 20;   // 1 MiB clears the metadata table of every catalog model

const SCALAR_WIDTH: { [type: number]: number } = {
  0: 1, 1: 1, 7: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 10: 8, 11: 8, 12: 8,
};

/**
 * Reads the GGUF metadata table out of a PREFIX of the file.
 *
 * The same walk `engine/src/preflight.hpp` does, with one difference: preflight
 * SKIPS every value because it only has to prove the table is well formed,
 * while an importer wants three of them. Bounds discipline is identical -
 * nothing is allocated from a number read out of the file, no length is used
 * before it is checked against what is actually left, and running out of buffer
 * is reported as "give me more bytes" rather than blamed on the file.
 *
 * On device this job belongs to the engine, which already walks the header
 * before any tensor loader maps the file. This is the tool's own reader for the
 * tool's own lane.
 */
export function readGgufHeader(buffer: Uint8Array): GgufKV | undefined {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let p = 0;
  const left = (): number => buffer.byteLength - p;
  if (left() < 24) return undefined;
  if (String.fromCharCode(...buffer.subarray(0, 4)) !== 'GGUF') return undefined;
  p = 4;
  const version = view.getUint32(p, true); p += 4;
  if (version < 2 || version > 3) return undefined;
  const tensorCount = Number(view.getBigUint64(p, true)); p += 8;
  const kvCount = Number(view.getBigUint64(p, true)); p += 8;
  if (tensorCount > (1 << 20) || kvCount > (1 << 16)) return undefined;

  const str = (): string | undefined => {
    if (left() < 8) return undefined;
    const len = Number(view.getBigUint64(p, true)); p += 8;
    if (len > (1 << 22) || len > left()) return undefined;
    const text = new TextDecoder().decode(buffer.subarray(p, p + len));
    p += len;
    return text;
  };

  const value = (type: number, depth: number): number | string | undefined | null => {
    if (depth > 2) return undefined;
    const width = SCALAR_WIDTH[type];
    if (width !== undefined) {
      if (left() < width) return undefined;
      let out: number;
      switch (type) {
        case 0: out = view.getUint8(p); break;
        case 1: out = view.getInt8(p); break;
        case 7: out = view.getUint8(p); break;
        case 2: out = view.getUint16(p, true); break;
        case 3: out = view.getInt16(p, true); break;
        case 4: out = view.getUint32(p, true); break;
        case 5: out = view.getInt32(p, true); break;
        case 6: out = view.getFloat32(p, true); break;
        case 10: out = Number(view.getBigUint64(p, true)); break;
        case 11: out = Number(view.getBigInt64(p, true)); break;
        default: out = view.getFloat64(p, true); break;
      }
      p += width;
      return out;
    }
    if (type === 8) {
      const text = str();
      return text === undefined ? undefined : text;
    }
    if (type === 9) {
      if (left() < 12) return undefined;
      const elem = view.getUint32(p, true); p += 4;
      const count = Number(view.getBigUint64(p, true)); p += 8;
      if (count > (1 << 20)) return undefined;
      const w = SCALAR_WIDTH[elem];
      if (w !== undefined) {
        if (left() < w * count) return undefined;
        p += w * count;
        return null;            // an array is not a fact this importer reads
      }
      for (let i = 0; i < count; i++) {
        if (value(elem, depth + 1) === undefined) return undefined;
      }
      return null;
    }
    return undefined;           // unknown type id: stop, do not guess a width
  };

  const out: GgufKV = {};
  for (let i = 0; i < kvCount; i++) {
    const key = str();
    if (key === undefined) break;      // the prefix ended; keep what we read
    if (left() < 4) break;
    const type = view.getUint32(p, true); p += 4;
    const v = value(type, 0);
    if (v === undefined) break;
    if (v !== null) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function fetchHeaderOverNetwork(url: string): Promise<GgufKV | undefined> {
  // A ranged read: the header is at the FRONT of the file, so a megabyte
  // clears a model of any size. A server that ignores the range costs bytes,
  // never correctness - the walk stops at the end of what it was given.
  const response = await fetch(url, { headers: { Range: `bytes=0-${GGUF_PREFIX_BYTES - 1}` } });
  if (!response.ok) return undefined;
  const buffer = new Uint8Array(await response.arrayBuffer());
  return readGgufHeader(buffer);
}

export async function importEntry(options: ImportOptions): Promise<CatalogEntry> {
  const revision = options.revision ?? HF_REGISTRY.default_revision ?? 'main';
  const parsed = parseSource(`hf:${options.repo}`);
  if (!parsed.ok) throw new Error(parsed.message ?? parsed.code);
  const ref = { ...parsed.value, path: options.file };

  const info = await (options.fetchInfo ?? fetchInfoOverNetwork)(options.repo, revision);

  const chosen = pickFile(info, { path: options.file });
  if (!chosen.ok) {
    if (chosen.code === 'file_not_found') {
      const available = (chosen.data?.available ?? []) as string[];
      throw new Error(`${options.repo}@${info.sha ?? revision} has no file ${options.file}` +
                      (available.length ? `. Available: ${available.join(', ')}` : ''));
    }
    throw new Error(chosen.message ?? chosen.code);
  }

  // The format check has to answer before the header read, or an import of a
  // .safetensors file would spend a megabyte of transfer to learn what the
  // filename already said.
  if (!formatFor(options.file)) {
    throw new Error(`${options.file} is not a format this build carries (gguf)`);
  }

  let header: GgufKV | undefined;
  if (options.fetchHeader) {
    const commit = typeof info.sha === 'string' ? info.sha : revision;
    header = await options.fetchHeader(
      HF_REGISTRY.file.replace('{repo}', options.repo)
                      .replace('{commit}', commit)
                      .replace('{path}', options.file));
  }

  const outcome = synthesize({
    ref, registry: HF_REGISTRY, info, file: chosen.value, header,
    id: options.id, license: 'require',
  });
  if (!outcome.ok) {
    if (outcome.code === 'revision_not_immutable') {
      throw new Error(`could not resolve ${options.repo}@${revision} to a commit - ` +
                      'refusing to pin a moving target');
    }
    if (outcome.code === 'license_unknown') {
      throw new Error(`${options.repo} declares no licence. An entry without one would make the ` +
                      'catalog lie about terms - add it upstream or record it by hand, deliberately.');
    }
    throw new Error(outcome.message ?? outcome.code);
  }
  return outcome.value;
}

async function main(argv: string[]): Promise<void> {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const [repo, file] = positional;
  if (!repo || !file) {
    console.error('usage: node tools/hf-import.ts <org/repo> <file.gguf> ' +
                  '[--revision main] [--id my-model] [--header]');
    process.exit(2);
  }
  const entry = await importEntry({
    repo, file, revision: flag('revision'), id: flag('id'),
    ...(argv.includes('--header') ? { fetchHeader: fetchHeaderOverNetwork } : {}),
  });
  // Straight to stdout: the output is a catalog entry, so it pipes into the
  // app's own models.json rather than being written somewhere by this tool.
  console.log(JSON.stringify(entry, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith('hf-import.ts')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`hf-import: ${(err as Error).message}`);
    process.exit(1);
  });
}

export { DEFAULT_SERVING_CONTEXT };
