//
//  registry-resolve.ts — turn a coordinate into verified bytes on disk.
//
//  RESOLUTION NEVER READS THE INDEX. `despia add github:acme/dsx-lidar@1.2.0` is `git ls-remote`
//  for the tags, a shallow fetch of the one tag, and a hash over the checkout — the discovery
//  index can be stale, wrong or gone and this file does not notice. That is the SPM property
//  the whole registry design leans on.
//
//  THE TREE HASH IS THE OTA FOLD, NOT AN INVENTION: sha256 over the sorted (path, sha256,
//  bytes) table of the checkout, `.git` excluded. Deterministic across OS, checkout and clock,
//  for the same reason the OTA generation id is. The lockfile records it SRI-style
//  (`sha256-<hex>`) plus the tag's commit SHA, so a moved tag is detectable even before bytes
//  are fetched — and a moved tag is a REFUSAL, never a re-pin, because "the same version with
//  different bytes" is either an author mistake or an attack, and both end the same way.
//
//  THE CACHE IS NOT TRUSTED. `~/.dsx/cache` holds checkouts keyed by id + version, and every
//  materialize re-hashes what it is about to hand out against the lockfile's pin. A cache hit
//  that skipped verification would be the one place where corrupt or tampered bytes reach a
//  build silently.
//

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { gitRemote, refId, type LockEntry, type PackageRef } from "./registry.ts";

export class ResolveError extends Error {}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

/** `1.2.0-beta.1` is a real tag, but never what an UNPINNED add silently chooses. */
function isPrerelease(version: string): boolean {
  return version.includes("-");
}

function compareRelease(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}

/**
 * The highest release tag, prereleases excluded. Tags that are not plain semver are ignored,
 * not errors — repositories tag all sorts of things — and that includes `v1.2.0`: the version
 * grammar here is the same one `parsePackageRef` enforces and the same one SwiftPM taught a
 * decade of package authors, bare `1.2.0`.
 */
export function newestSemverTag(tags: readonly string[]): string | null {
  const releases = tags.filter((t) => SEMVER.test(t) && !isPrerelease(t));
  if (releases.length === 0) return null;
  return releases.sort(compareRelease)[releases.length - 1]!;
}

export interface ResolveOptions {
  /** Override the remote — tests point this at a local fixture repository. */
  remote?: string;
  /** Cache root; default `~/.dsx/cache`, or `DSX_CACHE_DIR`. */
  cacheDir?: string;
  /** With `DSX_OFFLINE=1` any network need is a hard error instead of a hang — CI's choice. */
  offline?: boolean;
  /** Known-good tree hashes for this package, version → `sha256-<hex>` — the registry's
   *  append-only ledger, when the caller has it. Fetched bytes disagreeing with the ledger is
   *  a refusal; no ledger entry means trust-on-first-use, RECORDED as `crossChecked: false`. */
  ledger?: { [version: string]: string } | null;
}

export function defaultCacheDir(): string {
  const env = process.env["DSX_CACHE_DIR"];
  return env !== undefined && env !== "" ? resolve(env) : join(homedir(), ".dsx", "cache");
}

export function isOffline(): boolean {
  const env = process.env["DSX_OFFLINE"];
  return env !== undefined && env !== "" && env !== "0";
}

function runGit(args: string[], cwd?: string): string {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (ran.error !== undefined) throw new ResolveError(`git is required to resolve packages: ${ran.error.message}`);
  if (ran.status !== 0) {
    const detail = (ran.stderr ?? "").trim().split("\n")[0] ?? "";
    throw new ResolveError(`git ${args[0]} failed${detail !== "" ? `: ${detail}` : ""}`);
  }
  return ran.stdout;
}

function requireOnline(offline: boolean, what: string): void {
  if (offline) {
    throw new ResolveError(`DSX_OFFLINE is set and ${what} needs the network — a hard error beats a hang in CI`);
  }
}

/** The tags a remote advertises, annotated tags peeled to their commit. */
export function listRemoteTags(remote: string, offline = isOffline()): Array<{ tag: string; sha: string }> {
  requireOnline(offline, `listing tags of ${remote}`);
  const out = new Map<string, string>();
  for (const line of runGit(["ls-remote", "--tags", remote]).split("\n")) {
    const m = /^([0-9a-f]{40,64})\trefs\/tags\/(.+)$/.exec(line.trim());
    if (m === null) continue;
    const [, sha, name] = m;
    // The peeled `tag^{}` row is the COMMIT an annotated tag points at, which is the sha a
    // checkout of the tag actually lands on — it wins over the tag object's own sha.
    if (name!.endsWith("^{}")) out.set(name!.slice(0, -3), sha!);
    else if (!out.has(name!)) out.set(name!, sha!);
  }
  return [...out.entries()].map(([tag, sha]) => ({ tag, sha }));
}

/**
 * The canonical tree hash: sha256 over the sorted (path, sha256, bytes) table, `.git`
 * excluded, SRI-prefixed. Two refusals live at the hash site because this is the one walk
 * every fetched byte passes through: a symbolic link (the zip-slip of a git checkout — a link
 * pointing out of the tree turns a later copy into a write anywhere), and a checkout over
 * 200 MiB (a package is source, not a dataset; the cap turns a resource-exhaustion repo into
 * one line of refusal).
 */
export function treeHash(dir: string): string {
  const rows: string[] = [];
  let total = 0;
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      if (name === ".git") continue;
      const abs = join(at, name);
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) {
        throw new ResolveError(
          `${relative(dir, abs)} is a symbolic link — refused: a link in a package checkout ` +
          "can point outside the tree, which turns materializing it into a write anywhere",
        );
      }
      if (info.isDirectory()) { walk(abs); continue; }
      if (!info.isFile()) continue;
      total += info.size;
      if (total > 200 * 1024 * 1024) {
        throw new ResolveError("the checkout exceeds 200 MiB — a package is source, not a dataset");
      }
      const data = readFileSync(abs);
      const hash = createHash("sha256").update(data).digest("hex");
      rows.push(`${relative(dir, abs).split(sep).join("/")}\n${hash}\n${data.length}\n`);
    }
  };
  walk(dir);
  rows.sort();
  return "sha256-" + createHash("sha256").update(rows.join(""), "utf8").digest("hex");
}

export interface ResolvedPackage {
  id: string;
  version: string;
  /** The tag's commit SHA — a moved tag is detectable from this alone, before any bytes. */
  resolved: string;
  /** The canonical tree hash, `sha256-<hex>`. */
  sha256: string;
  manifest: { [k: string]: unknown };
  /** The verified checkout in the cache. */
  dir: string;
  /** false = trust-on-first-use: no ledger had this version, so the hash is self-recorded. */
  crossChecked: boolean;
}

export function cachePath(cacheDir: string, id: string, version: string): string {
  // `github:acme/x` → `github/acme/x/1.2.0`. The id grammar (registry.ts) admits no `..`, no
  // separators beyond the one slash, so the path cannot escape the cache root.
  return join(cacheDir, ...id.split(":").join("/").split("/"), version);
}

/**
 * Resolve one git coordinate to verified bytes in the cache.
 *
 * `lock` is the existing pin for this id if there is one: same version + different hash is the
 * moved-tag refusal. The fetch lands in a staging directory and is renamed into place only
 * after the hash, the manifest read, and every check passed — the cache never holds a
 * half-verified checkout.
 */
export function resolveGitPackage(
  ref: Extract<PackageRef, { kind: "git" }>,
  lock: LockEntry | null,
  opts: ResolveOptions = {},
): ResolvedPackage {
  const id = refId(ref);
  const remote = opts.remote ?? gitRemote(ref);
  const offline = opts.offline ?? isOffline();
  const cacheDir = opts.cacheDir ?? defaultCacheDir();

  const tags = listRemoteTags(remote, offline);
  const version = ref.version ?? newestSemverTag(tags.map((t) => t.tag));
  if (version === null) {
    throw new ResolveError(
      `${id} has no release tag — a package release is a bare semver git tag (1.0.0). ` +
      (tags.length > 0 ? `The remote has ${tags.length} tag(s), none of them semver releases.`
        : "The remote has no tags at all."),
    );
  }
  const tagged = tags.find((t) => t.tag === version);
  if (tagged === undefined) {
    throw new ResolveError(`${id} has no tag ${version} — the remote advertises ${tags.length} tag(s)`);
  }

  if (lock !== null && lock.version === version && lock.resolved !== undefined && lock.resolved !== tagged.sha) {
    throw new ResolveError(
      `TAG MOVED: ${id}@${version} was pinned at commit ${lock.resolved.slice(0, 12)} and the ` +
      `remote now serves ${tagged.sha.slice(0, 12)} for the same tag. A version whose bytes ` +
      "changed is either an author mistake or an attack — ask the author to publish a NEW " +
      "version instead. Nothing was fetched.",
    );
  }

  const finalDir = cachePath(cacheDir, id, version);
  let dir = finalDir;
  let fromCache = false;
  if (existsSync(finalDir)) {
    fromCache = true;
  } else {
    requireOnline(offline, `fetching ${id}@${version}`);
    const staging = `${finalDir}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(staging, ".."), { recursive: true });
    runGit(["clone", "--quiet", "--depth", "1", "--branch", version,
      "-c", "advice.detachedHead=false", remote, staging]);
    const head = runGit(["rev-parse", "HEAD"], staging).trim();
    if (head !== tagged.sha) {
      rmSync(staging, { recursive: true, force: true });
      throw new ResolveError(
        `${id}@${version}: the checkout landed on ${head.slice(0, 12)} but ls-remote advertised ` +
        `${tagged.sha.slice(0, 12)} — the remote changed between the two reads; re-run`,
      );
    }
    rmSync(join(staging, ".git"), { recursive: true, force: true });
    dir = staging;
  }

  let sha256: string;
  let manifest: { [k: string]: unknown };
  try {
    sha256 = treeHash(dir);
    const manifestPath = join(dir, "dsx.json");
    if (!existsSync(manifestPath)) {
      throw new ResolveError(`${id}@${version} has no dsx.json at its root — a package is a repository with a manifest`);
    }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { [k: string]: unknown };
    } catch (e) {
      throw new ResolveError(`${id}@${version}: dsx.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (lock !== null && lock.version === version && lock.sha256 !== undefined && lock.sha256 !== sha256) {
      // A cache hit that disagrees is local corruption; a fresh fetch that disagrees is the
      // moved tag. Conflating them sends the user chasing an attack that is a bad disk.
      throw new ResolveError(fromCache
        ? `${id}@${version}: the cached checkout hashes to ${sha256.slice(0, 26)}… but the ` +
          `lockfile pins ${lock.sha256.slice(0, 26)}… — the cache is corrupt. Delete ${dir} and re-run.`
        : `TAG MOVED: ${id}@${version} is pinned as ${lock.sha256.slice(0, 26)}… and the fetched ` +
          `tree hashes to ${sha256.slice(0, 26)}… — same version, different bytes. Refused; ask ` +
          "the author to publish a NEW version.",
      );
    }
    const known = opts.ledger?.[version];
    if (known !== undefined && known !== sha256) {
      throw new ResolveError(
        `${id}@${version}: the registry ledger records ${known.slice(0, 26)}… and the fetched ` +
        `tree hashes to ${sha256.slice(0, 26)}… — the ledger and the remote disagree; refused`,
      );
    }

    if (!fromCache) renameSync(dir, finalDir);
  } catch (e) {
    if (!fromCache) rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  return {
    id, version, resolved: tagged.sha, sha256, manifest, dir: finalDir,
    crossChecked: opts.ledger?.[version] !== undefined,
  };
}

/**
 * Hand out a cached checkout, RE-VERIFIED against the lockfile's pin. A missing checkout says
 * how to repopulate it (`despia add` of the pinned coordinate re-fetches and re-verifies); a
 * hash mismatch says the cache is corrupt rather than pretending the build input is fine.
 */
export function materialize(id: string, entry: LockEntry, cacheDir = defaultCacheDir()): string {
  const dir = cachePath(cacheDir, id, entry.version);
  if (!existsSync(dir)) {
    throw new ResolveError(
      `${id}@${entry.version} is pinned but not in the cache — run \`despia add ${id}@${entry.version}\` ` +
      "to re-fetch it (the lockfile's hash re-verifies the bytes)",
    );
  }
  if (entry.sha256 !== undefined) {
    const actual = treeHash(dir);
    if (actual !== entry.sha256) {
      throw new ResolveError(
        `${id}@${entry.version}: the cached checkout hashes to ${actual.slice(0, 26)}… but the ` +
        `lockfile pins ${entry.sha256.slice(0, 26)}… — the cache is corrupt. Delete ${dir} and ` +
        `re-run \`despia add ${id}@${entry.version}\`.`,
      );
    }
  }
  return dir;
}
