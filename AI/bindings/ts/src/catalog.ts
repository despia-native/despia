// catalog.ts - synthesising a catalog entry from a model registry's answer.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// ONE synthesis, two callers. `tools/hf-import.ts` runs it at AUTHORING time on
// a developer's machine and prints an entry for a curated catalog;
// `models.add` runs the same function at RUNTIME so an app can take any model
// its allowlist admits without a rebuild. Two implementations of entry
// synthesis is exactly the drift this repository legislates against, so there
// is one, it is pure, and both paths import it.
//
// THE REGISTRY DOCUMENT IS UNTRUSTED INPUT. It is a network document from a
// host, not a fact, and every field it supplies is treated as a claim:
//
//   - THE REGISTRY NEVER NAMES A HOST. Both URLs are expanded from TEMPLATES
//     the APP declared (`catalog.sources`), and the only things interpolated
//     into them are the caller's repo, a validated 40-hex commit, and a
//     validated relative path. A response cannot say where the next request
//     goes, which is why nothing here contains a hostname - and why the
//     package's no-network-literal gate passes over this file without an
//     exception.
//   - THE REVISION MUST BE AN IMMUTABLE COMMIT. `main` names different bytes on
//     different days, so a branch never reaches a stored entry: the response's
//     resolved commit is checked against /^[0-9a-f]{40}$/ and refused otherwise.
//   - THE DIGEST IS A CLAIM, NOT A VERIFICATION. It rides into `files[0].sha256`
//     so that the download verifies against it BEFORE the engine sees the file
//     (delivery.ts lock 2, delete-on-mismatch unchanged) - but the entry records
//     `provenance.sha256: "registry"`, so nothing can present a runtime-added
//     model as curated. A MALFORMED digest is DROPPED rather than stored: a
//     digest that can never match is worse than no digest, because the
//     pin-on-first-download path is the one that would have been safe.
//   - THE LICENCE IS THE REPO'S, and its ABSENCE is recorded rather than
//     invented. Engine is not weights.
//   - THE FILE OUTRANKS THE REGISTRY on anything the bytes can answer. Context
//     length, architecture and parameter count live in the GGUF header; an API
//     that is wrong about a context length produces a model that truncates
//     silently. Every field the entry carries says which source it came from.

import type { Dict } from './types.ts';

/** MiB, because that is the unit `requirements` is in and the unit
 *  check_model_catalog.rb checks `disk_mb` against. */
const MIB = 1024 * 1024;

/** The serving context a synthesised entry asks for when the file allows it.
 *  `context_length` is the context the engine SIZES ITS KV CACHE TO, not the
 *  model's maximum - the maximum rides `context_length_max` so a surface can
 *  offer it on a device that can pay for it. Picking the trained maximum here
 *  would quietly make every added model unfittable on a phone. */
export const DEFAULT_SERVING_CONTEXT = 4096;

// --- the app's source registry ------------------------------------------

/** One registry the APP declared, as URL templates. `{repo}`, `{revision}`,
 *  `{commit}` and `{path}` are the only placeholders, and every value
 *  substituted into them is validated first. */
export type SourceRow = {
  api: string;
  file: string;
  /** Where a human reads the repo's terms. Optional: with no template there is
   *  no licence URL, which is better than deriving one by string-surgery on the
   *  file template and getting it wrong for the next registry. */
  page?: string;
  default_revision?: string;
};

export type SourceRegistry = { [scheme: string]: SourceRow };

/** What a model registry's API answers. Hugging Face's shape, and the only
 *  shape a registry row can mean today - a second registry with a different
 *  document is a mapping step in front of this, not a second synthesis. */
export type RepoFile = { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } };
export type RepoInfo = {
  sha?: string;
  siblings?: RepoFile[];
  cardData?: { license?: string; language?: string | string[] };
  config?: { model_type?: string };
  /** The registry's OWN parse of the header. It is a convenience, not a
   *  source of truth: it is still the API talking about a file, so it ranks
   *  below the bytes and above nothing. */
  gguf?: { architecture?: string; context_length?: number };
};

export type CatalogEntry = {
  schema_version: number;
  id: string;
  name: string;
  family?: string;
  category?: string;
  engine: string;
  format: string;
  status: string;
  requires?: Dict;
  files: Array<{ name: string; bytes?: number; sha256?: string; urls: string[] }>;
  license: { id: string; url?: string };
  languages?: string[];
  inputs: string[];
  outputs: string[];
  context_length?: number;
  context_length_max?: number;
  parameters?: number;
  requirements?: Dict;
  origin?: Dict;
  _note?: string;
};

export type Refusal = { code: string; data?: Dict; message?: string };
export type Outcome<T> = { ok: true; value: T } | ({ ok: false } & Refusal);

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = <T>(code: string, data?: Dict, message?: string): Outcome<T> =>
  ({ ok: false, code, ...(data ? { data } : {}), ...(message ? { message } : {}) });

// --- the reference --------------------------------------------------------

export type SourceRef = { scheme: string; repo: string; path?: string };

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `hf:org/repo` or `hf:org/repo/some/file.gguf`.
 *
 *  The reference is caller input and ends up inside a URL, so every segment is
 *  validated rather than trusted: no `..`, no scheme, no query, no absolute
 *  path. The first two segments are the repo and everything after is the file
 *  path, which is how a repo with a subdirectory addresses its files. */
export function parseSource(source: string): Outcome<SourceRef> {
  const raw = String(source ?? '').trim();
  const colon = raw.indexOf(':');
  if (colon <= 0) {
    return no('source_malformed', { source: raw },
              'A model source looks like "hf:org/repo/file.gguf" or "hf:org/repo" with a prefer.');
  }
  const scheme = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  if (!SEGMENT.test(scheme) || rest.includes('?') || rest.includes('#') || rest.includes('\\')) {
    return no('source_malformed', { source: raw }, 'That source is not a registry reference.');
  }
  const parts = rest.split('/').filter((p) => p.length > 0);
  if (parts.length < 2 || parts.some((p) => !SEGMENT.test(p))) {
    return no('source_malformed', { source: raw },
              'A model source needs an owner and a repository, like "hf:org/repo".');
  }
  const repo = `${parts[0]}/${parts[1]}`;
  const path = parts.length > 2 ? parts.slice(2).join('/') : undefined;
  return ok({ scheme, repo, path });
}

/** Template expansion. The template is the APP's; the values are validated
 *  before they get here. Anything the template does not name is not
 *  substitutable, which is the point of it being a template rather than a
 *  concatenation. */
export function expand(template: string, values: Dict): string {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => {
    const value = values[key];
    return value === undefined ? whole : String(value);
  });
}

// --- the file -------------------------------------------------------------

/** Formats known to this build. A file the engine cannot serve is refused when
 *  it is ADDED rather than at load time on someone's phone. */
export function formatFor(filename: string): string | null {
  if (filename.endsWith('.gguf')) return 'gguf';
  return null;
}

/** `model-00001-of-00003.gguf`. A shard is not a model file: an entry names one
 *  file, and half a model that passes every lock is still half a model. */
const SHARD = /-\d{5}-of-\d{5}\.gguf$/;

const RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

function ggufFiles(info: RepoInfo): RepoFile[] {
  return (info.siblings ?? []).filter((s) => typeof s.rfilename === 'string' &&
                                              s.rfilename.endsWith('.gguf'));
}

/**
 * Which file this add is about.
 *
 * Named explicitly, or chosen by a quant preference among the repo's GGUFs.
 * The choice is DETERMINISTIC - shortest matching name, then lexicographic -
 * because "pick the first one the API happened to list" makes the entry a
 * function of the response's ordering, and a repo that reorders its files
 * would silently change which model an app installs.
 */
export function pickFile(info: RepoInfo, want: { path?: string; prefer?: string }): Outcome<RepoFile> {
  const available = ggufFiles(info);
  if (want.path) {
    const named = (info.siblings ?? []).find((s) => s.rfilename === want.path);
    if (!named) {
      return no('file_not_found', { file: want.path, available: available.map((f) => f.rfilename) },
                `That repository has no file called ${want.path}.`);
    }
    if (SHARD.test(named.rfilename)) {
      return no('unsupported', { reason: 'sharded_model', file: named.rfilename },
                'That file is one shard of a split model, and an entry names a single file.');
    }
    return ok(named);
  }

  const whole = available.filter((f) => !SHARD.test(f.rfilename));
  if (want.prefer) {
    const token = want.prefer.toLowerCase();
    const matches = whole.filter((f) => f.rfilename.toLowerCase().includes(token));
    if (matches.length === 0) {
      const shardedOnly = available.filter((f) => f.rfilename.toLowerCase().includes(token));
      if (shardedOnly.length > 0) {
        return no('unsupported', { reason: 'sharded_model', prefer: want.prefer },
                  `Every ${want.prefer} file in that repository is a split model.`);
      }
      return no('no_matching_file', { prefer: want.prefer, available: whole.map((f) => f.rfilename) },
                `No file in that repository matches ${want.prefer}.`);
    }
    matches.sort((a, b) => a.rfilename.length - b.rfilename.length ||
                           a.rfilename.localeCompare(b.rfilename));
    return ok(matches[0]);
  }

  if (whole.length === 1) return ok(whole[0]);
  if (whole.length === 0) {
    return no('no_matching_file', { available: [] },
              'That repository publishes no GGUF file this build can serve.');
  }
  return no('ambiguous_file', { available: whole.map((f) => f.rfilename) },
            'That repository publishes several GGUF files. Name one, or pass a prefer like "Q4_K_M".');
}

// --- what the FILE says ---------------------------------------------------

/** The GGUF metadata table, as key/value pairs read off the header. The reader
 *  that produces it is the caller's (the engine's pre-flight walk on device, a
 *  ranged read in the authoring tool, a fixture in the corpus) - this file only
 *  interprets what it was handed, which is why the interpretation is testable
 *  with no bytes and no network. */
export type GgufKV = { [key: string]: number | string | undefined };

export type GgufFacts = {
  architecture?: string;
  parameters?: number;
  contextLength?: number;
  blockCount?: number;
  embeddingLength?: number;
  headCount?: number;
  headCountKv?: number;
  headDim?: number;
  /** `<arch>.pooling_type`, when the file declares one ABOVE zero. Zero is the
   *  vocabulary's own "no pooling", so it is read as absence rather than as a
   *  value - which is why this rides through the same positive-only `num` every
   *  other fact does. */
  pooling?: number;
};

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/** Normalises the raw header table. Everything except `general.*` is namespaced
 *  by the architecture the file itself declares, so the architecture is read
 *  first and the rest is read through it. */
export function ggufFacts(kv: GgufKV | undefined): GgufFacts | undefined {
  if (!kv) return undefined;
  const arch = typeof kv['general.architecture'] === 'string'
    ? String(kv['general.architecture']) : undefined;
  const at = (suffix: string): number | undefined => (arch ? num(kv[`${arch}.${suffix}`]) : undefined);

  const embedding = at('embedding_length');
  const heads = at('attention.head_count');
  const facts: GgufFacts = {
    architecture: arch,
    parameters: num(kv['general.parameter_count']),
    contextLength: at('context_length'),
    blockCount: at('block_count'),
    embeddingLength: embedding,
    headCount: heads,
    headCountKv: at('attention.head_count_kv') ?? heads,
    headDim: at('attention.key_length') ??
             (embedding && heads ? Math.round(embedding / heads) : undefined),
    pooling: at('pooling_type'),
  };
  return facts;
}

// --- what KIND of model this is -------------------------------------------

/**
 * Architecture → category, and the table is EVIDENCE rather than recollection.
 *
 * It is exactly what the shipped catalog's eleven rows say, and nothing else:
 * three `family: "gemma3"` rows and two `family: "qwen3"` rows carry
 * `category: "text"`, four `family: "whisper"` rows carry `category: "asr"`.
 * `family` is the architecture slot - `synthesize` fills it from
 * `general.architecture` - so those rows ARE an architecture table somebody
 * measured and shipped.
 *
 * The eleventh row is why this table is not the whole answer:
 * `qwen3-embedding-0.6b-q8_0` is `family: "qwen3"` and `category: "embedding"`.
 * One architecture, two categories, so the architecture alone cannot decide -
 * see `categoryFor`.
 *
 * ANYTHING NOT LISTED IS `unknown`, deliberately. Adding `llama`, `phi3`,
 * `bert` and friends from memory would be the same class of mistake as the
 * footprint coefficient: a plausible number nobody measured, which the rest of
 * the system then treats as a fact. An honest `unknown` costs a substitution
 * this build was never entitled to make.
 */
export const CATEGORY_BY_ARCHITECTURE: { [architecture: string]: string } = {
  gemma3: 'text',
  qwen3: 'text',
  whisper: 'asr',
};

/** The category a build records when the evidence does not name one. It is a
 *  REAL value, not an absence: a surface can say "we do not know what this is",
 *  and the fallback matcher declines to substitute across it. */
export const CATEGORY_UNKNOWN = 'unknown';

export type CategoryVerdict = { category: string; from: 'pooling' | 'architecture' | 'unknown' };

/**
 * What kind of model this file is, from the header.
 *
 * Two signals, in this order, because the second cannot answer what the first
 * can:
 *
 *   1. `<arch>.pooling_type` above zero → `embedding`. A model that pools its
 *      hidden states into one vector is an embedding model; that is what the
 *      key means. It is checked FIRST because it is the only thing that
 *      separates the two kinds of `qwen3` - verified against the real files:
 *      Qwen3-Embedding-0.6B-Q8_0 declares `qwen3.pooling_type = 3` and
 *      Qwen3-0.6B-Q8_0 declares no pooling key at all, while
 *      nomic-embed-text-v1.5 declares `nomic-bert.pooling_type = 1` and neither
 *      gemma-3-1b, gemma-3-4b nor LFM2-350M declares one.
 *   2. the architecture table above → its category.
 *
 * Otherwise `unknown`. A GGUF with no header read, an architecture nothing here
 * has evidence about, and a file whose keys say nothing about its kind all land
 * in the same place, which is the correct place: this build does not know.
 */
export function categoryFor(facts: GgufFacts | undefined): CategoryVerdict {
  if (facts?.pooling !== undefined) return { category: 'embedding', from: 'pooling' };
  const arch = facts?.architecture;
  const known = arch ? CATEGORY_BY_ARCHITECTURE[arch] : undefined;
  if (known) return { category: known, from: 'architecture' };
  return { category: CATEGORY_UNKNOWN, from: 'unknown' };
}

/** What a category eats and what it produces, taken from the same eleven rows:
 *  the `embedding` row is `outputs: ["embedding"]`, the four `asr` rows are
 *  `inputs: ["audio"]`, and text is text. An entry whose declared `inputs`
 *  contradicted its category would be refused at the seam
 *  (`unsupported_input`) for a reason that is this file's fault. */
export function modalityFor(category: string): { inputs: string[]; outputs: string[] } {
  if (category === 'embedding') return { inputs: ['text'], outputs: ['embedding'] };
  if (category === 'asr') return { inputs: ['audio'], outputs: ['text-stream'] };
  return { inputs: ['text'], outputs: ['text-stream'] };
}

const roundUp32 = (mb: number): number => Math.max(32, Math.ceil(mb / 32) * 32);

/**
 * `requirements`, derived from the real file size and the GGUF header.
 *
 * The three numbers mean different things and are derived differently:
 *
 *   - `disk_mb` IS the file size. Nothing is estimated about it.
 *   - `mapped_mb` is what the loader memory-maps. The gguf backend mmaps its
 *     weights, so file-backed RSS tracks the file size. It deliberately never
 *     counts toward the memory verdict (fit.ts) - mmap'd pages are clean and
 *     evictable - and rides the verdict as detail so a UI can explain thrash.
 *   - `footprint_mb` is the resident, non-file-backed cost, and it is the only
 *     ESTIMATE here. The KV cache is computed exactly from the header
 *     (2 planes x blocks x kv-heads x head-dim x context, f16); the compute
 *     buffers are not in the header at all, so they are allowed for as a
 *     fraction of the weights and the whole thing carries the catalog's own
 *     1.5x prompt-and-allocator margin, rounded up to 32 MB.
 *
 * MEASURED ERROR, and the cause of the worst case is NOT what it looks like.
 * Against the shipped catalog's measured rows this lands high for text models,
 * which is the safe direction, and LOW for gemma-3-4b-it-Q4_K_M by 39%: derived
 * 1,888 MB against a measured 3,104 MB. Under-estimating is the error that gets
 * a user killed by the OOM reaper, so it deserves a real explanation rather than
 * a plausible one.
 *
 * The plausible explanation was that the model is multimodal and its vision
 * tower is invisible to these fields. That was checked by reading the real
 * header off the real file with a ranged request, and it is WRONG: the file
 * declares 40 keys in exactly three namespaces, general, gemma3 and tokenizer.
 * There are no vision keys, no clip keys and no mm keys. Gemma 3 ships its
 * vision tower as a separate mmproj file; this one is text only.
 *
 * So the cause is unidentified. What the numbers say is that the resident
 * non-file-backed cost EXCEEDS the whole mapped file (3,104 against 2,375),
 * which the `0.3 x disk` compute allowance cannot express. Fitting a new
 * coefficient to one data point would be curve fitting, and clamping the
 * estimate to the pessimistic bound (1.5 x disk) is safe but useless: it would
 * put gemma-3-1b at 1,154 MB against a measured 352, refusing on any device
 * with under a gigabyte free a model that needs a third of that.
 *
 * THE FIX IS NOT A BETTER FORMULA, AND IT HAS LANDED. `fit.ts`
 * (`calibrationFootprintMb`) prefers the resident footprint measured on the
 * FIRST SUCCESSFUL LOAD of this model on this device, recorded beside
 * `decode_tps` in the same per-model, per-device calibration store. What stays
 * here is therefore what it always should have been: the number used ONCE, on
 * the launch before anybody has measured anything, chosen to fail toward
 * refusing a model that would have run rather than accepting one that will not.
 * A verdict computed from it says `predicted`; a verdict computed from the
 * measurement does not.
 */
export function deriveRequirements(bytes: number | undefined, facts: GgufFacts | undefined,
                                   context: number | undefined): Dict {
  const diskMb = bytes ? Math.ceil(bytes / MIB) : 0;
  const measurable = facts?.blockCount && facts?.headCountKv && facts?.headDim && context;
  // Without the header the KV cache is not computable, and pretending it is
  // zero is the one error that gets a user killed by the OOM reaper. Across
  // the eleven measured catalog rows the cache runs from 0.14x to 0.73x the
  // file, so the headerless estimate takes the TOP of that range. It refuses
  // models that would in fact have run - which a `predicted` verdict lets a
  // surface offer anyway - and it never accepts one that would not.
  const kvMb = measurable
    ? (2 * facts!.blockCount! * facts!.headCountKv! * facts!.headDim! * context! * 2) / MIB
    : 0.7 * diskMb;
  const compute = 0.3 * diskMb;
  return {
    footprint_mb: roundUp32(1.5 * (kvMb + compute)),
    mapped_mb: diskMb,
    disk_mb: diskMb,
  };
}

// --- identity -------------------------------------------------------------

export function slugFor(repo: string, file: string): string {
  const base = file.replace(/\.[^.]+$/, '');
  return `${repo.split('/').pop()}-${base}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
}

export function languagesFrom(info: RepoInfo): string[] | undefined {
  const raw = info.cardData?.language;
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw : [raw];
}

// --- the synthesis --------------------------------------------------------

export type SynthesisInput = {
  ref: SourceRef;
  registry: SourceRow;
  /** The registry's answer. UNTRUSTED. */
  info: RepoInfo;
  file: RepoFile;
  /** What the FILE said, when the header could be read. */
  header?: GgufKV;
  id?: string;
  /** `require` refuses an unlicensed repo (the authoring tool's stance);
   *  `record` writes `license.id: "unknown"` and lets the surface decide. */
  license?: 'require' | 'record';
  servingContext?: number;
};

export function synthesize(input: SynthesisInput): Outcome<CatalogEntry> {
  const { ref, registry, info, file } = input;

  // 1. The revision must be an immutable commit. A branch name in a stored
  //    entry is a promise nobody can keep, and the digest cannot catch a change
  //    it would simply be recomputed for.
  const commit = typeof info.sha === 'string' ? info.sha.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return no('revision_not_immutable', { repo: ref.repo, sha: info.sha ?? null },
              'That repository did not resolve to a commit, and a moving revision is never stored.');
  }

  const path = file.rfilename;
  if (!RELATIVE_PATH.test(path) || path.split('/').includes('..')) {
    return no('source_malformed', { file: path }, 'That file path is not one this build will store.');
  }

  const format = formatFor(path);
  if (!format) {
    return no('unsupported', { reason: 'format_not_carried', file: path },
              `${path} is not a format this build carries (gguf).`);
  }

  // 2. The licence is the repo's, not the adder's. Engine is not weights.
  const declaredLicense = typeof info.cardData?.license === 'string' ? info.cardData.license : undefined;
  if (!declaredLicense && (input.license ?? 'require') === 'require') {
    return no('license_unknown', { repo: ref.repo },
              `${ref.repo} declares no licence. An entry without one would make the catalog lie ` +
              'about terms - add it upstream or record it by hand, deliberately.');
  }

  // 3. A digest is a CLAIM. Well-formed, it rides into the entry and the
  //    download verifies against it; malformed, it is dropped and the device
  //    pins what it actually downloaded instead.
  const claimed = typeof file.lfs?.sha256 === 'string' ? file.lfs.sha256.toLowerCase() : undefined;
  const digest = claimed && /^[0-9a-f]{64}$/.test(claimed) ? claimed : undefined;
  const bytes = num(file.lfs?.size) ?? num(file.size);

  // 4. The file outranks the registry on anything the bytes can answer. Three
  //    tiers, in order: what the HEADER said, what the registry CLAIMS about
  //    the header, and this build's default. An API that is wrong about a
  //    context length produces a model that truncates silently, so the tier
  //    each field came from rides in the entry rather than being forgotten.
  const facts = ggufFacts(input.header);
  const trained = facts?.contextLength ?? num(info.gguf?.context_length);
  const contextFrom = facts?.contextLength ? 'file' : (num(info.gguf?.context_length) ? 'registry' : 'default');
  const want = input.servingContext ?? DEFAULT_SERVING_CONTEXT;
  const serving = trained ? Math.min(want, trained) : want;
  const family = facts?.architecture ?? info.gguf?.architecture ?? info.config?.model_type;
  const familyFrom = facts?.architecture ? 'file'
    : ((info.gguf?.architecture ?? info.config?.model_type) ? 'registry' : 'unknown');
  // WHAT KIND of model this is, from the same bytes. It used to be the literal
  // "text" on every entry, which made a Whisper GGUF or an embedding model a
  // chat model as far as everything downstream could tell - and the fallback
  // matcher, which offers "another model of the same kind", would answer a
  // refused speech model with something that cannot hear.
  const kind = categoryFor(facts);
  const modality = modalityFor(kind.category);

  const url = expand(registry.file, { repo: ref.repo, commit, path });

  const provenance: Dict = {
    revision: 'registry',
    bytes: bytes === undefined ? 'unknown' : 'registry',
    sha256: digest ? 'registry' : (claimed ? 'discarded_malformed' : 'none'),
    license: declaredLicense ? 'repo_card' : 'unknown',
    family: familyFrom,
    category: kind.from,
    context_length: contextFrom,
    parameters: facts?.parameters ? 'file' : 'unknown',
    requirements: facts?.blockCount ? 'derived_from_header' : 'estimated_from_size',
  };

  const entry: CatalogEntry = {
    schema_version: 1,
    id: input.id ?? slugFor(ref.repo, path.split('/').pop() ?? path),
    name: `${ref.repo.split('/').pop()} (${path.split('/').pop()})`,
    ...(family ? { family } : {}),
    category: kind.category,
    engine: 'gguf',
    format,
    status: 'active',
    requires: { abi: 1 },
    files: [{
      name: path.split('/').pop() ?? path,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(digest ? { sha256: digest } : {}),
      urls: [url],
    }],
    license: {
      id: declaredLicense ?? 'unknown',
      ...(registry.page ? { url: expand(registry.page, { repo: ref.repo, commit }) } : {}),
    },
    ...(languagesFrom(info) ? { languages: languagesFrom(info) } : {}),
    inputs: modality.inputs,
    outputs: modality.outputs,
    context_length: serving,
    ...(trained ? { context_length_max: trained } : {}),
    ...(facts?.parameters ? { parameters: facts.parameters } : {}),
    requirements: deriveRequirements(bytes, facts, serving),
    origin: {
      added: true,
      registry: ref.scheme,
      source: ref.path ? `${ref.scheme}:${ref.repo}/${ref.path}` : `${ref.scheme}:${ref.repo}`,
      repo: ref.repo,
      revision: commit,
      provenance,
    },
    ...(digest ? {} : {
      _note: 'The registry published no usable digest for this file, so the device pins one on ' +
             'first download and verifies against it forever after.',
    }),
  };
  return ok(entry);
}
