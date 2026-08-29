//
//  ota.ts — the two decisions a device makes about an OTA generation BEFORE it applies one:
//  is this device inside the staged rollout, and can the installed binary actually run what
//  the generation references. The law is the corpus, OpenSource/Conformance/ota/rollout.json
//  (parity/P05-ota.md 4b + 4c); the Kotlin twin is :core OtaGeneration.kt and the Swift twin
//  is Engine/iOS/OtaGeneration.swift.
//
//  Everything platform-shaped lives OUTSIDE this file. Fetching, signing, the content store
//  and the anti-rollback high-water mark are the load gate's business (RemoteBundleGate);
//  this file is pure arithmetic and comparison, which is exactly why one corpus can judge
//  three renderers. A device either takes an update or it does not, identically everywhere.
//
//  Two properties the design is built on:
//    • no coordination — the bucket is a hash of the device's own installation id, so a
//      staged rollout needs no server, no assignment call and no state anywhere;
//    • monotonic — the hash is stable, so raising the fraction only grows the population.
//      A device that took generation N at 10 percent still has it at 50 percent.
//

/** FNV-1a 32-bit constants. Not a cryptographic hash and not pretending to be one: this is a
 *  bucketing function, and it is FNV rather than SHA-256 because the gate is synchronous at
 *  load time while the web platform's only hash (crypto.subtle) is async-only. */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const BUCKET_DIVISOR = 4294967296; // 2^32

/** The staged-rollout declaration a manifest carries: `{ "rollout": { "fraction": 0.1, "salt": "gen-8a3f" } }`. */
export interface OtaRollout {
  readonly fraction: number;
  readonly salt: string;
}

/** What the gate decided. Every value other than `apply` means the device keeps the
 *  generation it already has, and says why. There is no silent bypass. */
export type OtaVerdict =
  | "apply"
  | "rollout_excluded"
  | "runtime_too_old"
  | "runtime_unknown"
  | "invalid_rollout"
  | "invalid_runtime_version"
  | "no_installation_id";

/** The manifest half of the decision: what the generation declares about itself. */
export interface OtaGenerationDeclaration {
  readonly runtimeVersion?: unknown;
  readonly rollout?: unknown;
}

/** The device half: what this install is. */
export interface OtaClient {
  readonly runtimeVersion?: unknown;
  readonly installationId?: unknown;
}

/** The decision, plus the bucket when one was computed (for logging a held device honestly). */
export interface OtaDecision {
  readonly verdict: OtaVerdict;
  readonly bucket?: number;
}

/** FNV-1a 32-bit over the UTF-8 bytes of `text`, as an unsigned 32-bit integer. */
export function otaHash32(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    // Math.imul keeps the multiply in 32-bit two's complement; >>> 0 reads it back unsigned.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** This device's stable position in [0,1) for one salt. The salt is per generation, so
 *  changing it deliberately reshuffles the whole population. */
export function rolloutBucket(installationId: string, salt: string): number {
  return otaHash32(`${installationId}:${salt}`) / BUCKET_DIVISOR;
}

/** Is this device inside the fraction? The edges are explicit rather than emergent: 1 takes
 *  every device including the highest bucket, 0 takes none including bucket zero. */
export function rolloutApplies(installationId: string, salt: string, fraction: number): boolean {
  if (fraction >= 1) return true;
  if (fraction <= 0) return false;
  return rolloutBucket(installationId, salt) < fraction;
}

interface ParsedVersion {
  readonly core: readonly number[];
  readonly pre: readonly string[];
}

const CORE_COMPONENT = /^(0|[1-9][0-9]*)$/;
const PRE_IDENTIFIER = /^[0-9A-Za-z-]+$/;
const NUMERIC_IDENTIFIER = /^(0|[1-9][0-9]*)$/;

/** Parse a `runtimeVersion`, or `null` when it is not one. Semver 2.0.0 with the one
 *  concession every real version table needs: a missing minor or patch is zero, so "4" and
 *  "4.0.0" are the same contract. Nothing else is forgiven — no `v` prefix, no leading zeros,
 *  no fourth component — because a version this gate guesses at is a version that can let an
 *  OTA reach a binary missing the module it references. */
export function parseRuntimeVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text === "") return null;

  const plus = text.indexOf("+");
  if (plus >= 0) text = text.substring(0, plus); // build metadata takes no part in precedence
  if (text === "") return null;

  let pre: string[] = [];
  const dash = text.indexOf("-");
  if (dash >= 0) {
    const preText = text.substring(dash + 1);
    text = text.substring(0, dash);
    if (preText === "") return null;
    pre = preText.split(".");
    if (pre.some((id) => id === "" || !PRE_IDENTIFIER.test(id))) return null;
  }

  const parts = text.split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  if (parts.some((part) => !CORE_COMPONENT.test(part))) return null;
  const core = [0, 1, 2].map((i) => (i < parts.length ? Number(parts[i]) : 0));
  return { core, pre };
}

/** -1 / 0 / 1, or `null` when either side is unparseable. */
export function compareRuntimeVersions(a: unknown, b: unknown): number | null {
  const left = parseRuntimeVersion(a);
  const right = parseRuntimeVersion(b);
  if (left === null || right === null) return null;

  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  // A pre-release ranks below the release it leads to; two releases are equal.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;

  const shared = Math.min(left.pre.length, right.pre.length);
  for (let i = 0; i < shared; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === r) continue;
    const lNumeric = NUMERIC_IDENTIFIER.test(l);
    const rNumeric = NUMERIC_IDENTIFIER.test(r);
    if (lNumeric && rNumeric) {
      // Numeric identifiers compare NUMERICALLY. Compared by length then ascii rather than
      // by parsing: leading zeros are already rejected, so the longer decimal is the larger
      // one, and no runtime's integer width can round a 40-digit build number into
      // agreeing with a different one.
      if (l.length !== r.length) return l.length < r.length ? -1 : 1;
      return l < r ? -1 : 1;
    }
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1; // numeric ranks below alphanumeric
    return l < r ? -1 : 1;                               // ascii order
  }
  if (left.pre.length === right.pre.length) return 0;
  return left.pre.length < right.pre.length ? -1 : 1;    // a prefix ranks below its extension
}

/** Does the installed binary meet what the generation declares? `null` when either version is
 *  unparseable, so the caller reports `invalid_runtime_version` rather than deciding. */
export function runtimeVersionSatisfied(required: unknown, current: unknown): boolean | null {
  const order = compareRuntimeVersions(current, required);
  return order === null ? null : order >= 0;
}

/** Read a manifest's `rollout` block. Returns the declaration, `undefined` when absent (no
 *  staging, everyone takes it), or `null` when present but malformed — refused rather than
 *  clamped, because a fraction of 1.5 is an authoring mistake and shipping to everyone is the
 *  most expensive possible interpretation of it. */
function readRollout(raw: unknown): OtaRollout | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as { fraction?: unknown; salt?: unknown };
  const { fraction, salt } = record;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  if (fraction < 0 || fraction > 1) return null;
  if (typeof salt !== "string") return null;
  return { fraction, salt };
}

/**
 * The gate. `runtimeVersion` is checked FIRST: a generation the installed binary cannot run is
 * refused whatever the rollout says, because that refusal is the one that stops an OTA
 * referencing a module the binary does not contain, which is how OTA systems brick apps.
 * A held or refused generation always leaves the last good one in place.
 */
export function evaluateGeneration(
  manifest: OtaGenerationDeclaration,
  client: OtaClient,
): OtaDecision {
  const declared = manifest.runtimeVersion;
  if (declared !== undefined && declared !== null) {
    if (parseRuntimeVersion(declared) === null) return { verdict: "invalid_runtime_version" };
    const installed = client.runtimeVersion;
    if (installed === undefined || installed === null || installed === "") {
      return { verdict: "runtime_unknown" };
    }
    const satisfied = runtimeVersionSatisfied(declared, installed);
    if (satisfied === null) return { verdict: "invalid_runtime_version" };
    if (!satisfied) return { verdict: "runtime_too_old" };
  }

  const rollout = readRollout(manifest.rollout);
  if (rollout === null) return { verdict: "invalid_rollout" };
  if (rollout !== undefined) {
    if (rollout.fraction >= 1) return { verdict: "apply" };
    if (rollout.fraction <= 0) return { verdict: "rollout_excluded" };
    const id = client.installationId;
    if (typeof id !== "string" || id === "") return { verdict: "no_installation_id" };
    const bucket = rolloutBucket(id, rollout.salt);
    return { verdict: bucket < rollout.fraction ? "apply" : "rollout_excluded", bucket };
  }

  return { verdict: "apply" };
}
