//
//  registry.ts — the package registry, which is GitHub.
//
//  THE MODEL IS SPM's, DELIBERATELY. A package is a git repository with a `dsx.json` at its
//  root and semver git tags. There is no publish step, no account, no server that can go down
//  and take the ecosystem with it. `despia add github:acme/dsx-lidar@1.2.0` resolves a tag,
//  verifies bytes against a hash it records, and writes a lockfile. Apple shipped an optional
//  registry protocol years after SwiftPM and almost nobody adopted it: git had already won,
//  because a git tag is a thing every author already knows how to make.
//
//  DISCOVERY IS A SEPARATE, OPTIONAL LAYER — the Swift Package Index shape. `packages.json` in
//  the registry repo is a flat list of `owner/repo`, and a PR to that file is the entire
//  submission process. A nightly job reads GitHub's API, fetches each package's `dsx.json` at
//  its newest tag, and writes `index.json`. `despia search` reads that index. If it is stale or
//  unreachable, `despia add` still works, because resolution never consults it.
//
//  WHAT DESPIA HAS THAT SPI CANNOT: a Swift package declares no machine-readable API, so an
//  index page can only show a README. Every `dsx.json` declares each action's args, resolve
//  shape, error codes with human messages, and executable tests. The index therefore carries
//  the real API surface, generated, and the site can render a page per ACTION rather than only
//  per package.
//
//  FIRST-PARTY IS BUNDLED, NOT FETCHED. The 150 modules in the framework ship their index
//  inside the CLI, so `despia search camera` answers offline and on the first run, before any
//  network call and before the user has heard of the registry.
//

export class RegistryError extends Error {}

/** A coordinate the CLI accepts on the command line. */
export type PackageRef =
  | { kind: "first-party"; path: string }
  | { kind: "git"; host: "github"; owner: string; repo: string; version: string | null };

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
/** `Core/Camera`, `core/camera`, `Mandatory/Foundation/Components` — a tree path, nothing else. */
const FIRST_PARTY_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * Parse a coordinate.
 *
 * `github:owner/repo@1.2.0` is the third-party form and the `@version` is OPTIONAL — omitted
 * means "the newest tag when I resolve it", which the lockfile then pins forever. A bare
 * `owner/repo` is NOT accepted as third-party: it is ambiguous with the first-party tree path
 * (`Core/Camera` is two segments too), and guessing between "a module in the framework" and "a
 * stranger's repository" is the one ambiguity in a package manager that must never be resolved
 * by heuristic.
 */
export function parsePackageRef(raw: string): PackageRef {
  const text = raw.trim();
  if (text === "") throw new RegistryError("empty package reference");

  const colon = text.indexOf(":");
  if (colon >= 0) {
    const host = text.substring(0, colon);
    if (host !== "github") {
      throw new RegistryError(
        `unknown host ${JSON.stringify(host)} — the only third-party host is github: ` +
        "(write github:owner/repo@1.2.0)",
      );
    }
    let rest = text.substring(colon + 1);
    let version: string | null = null;
    const at = rest.lastIndexOf("@");
    if (at > 0) {
      version = rest.substring(at + 1);
      rest = rest.substring(0, at);
      if (!SEMVER.test(version)) {
        throw new RegistryError(
          `${JSON.stringify(version)} is not a version. Write a semver tag: 1.2.0. ` +
          "Omit @version entirely to take the newest tag and pin it in the lockfile.",
        );
      }
    }
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1 || rest.indexOf("/", slash + 1) >= 0) {
      throw new RegistryError(`${JSON.stringify(rest)} is not owner/repo`);
    }
    const owner = rest.substring(0, slash);
    const repo = rest.substring(slash + 1);
    if (!OWNER.test(owner)) throw new RegistryError(`${JSON.stringify(owner)} is not a GitHub owner`);
    if (!REPO.test(repo)) throw new RegistryError(`${JSON.stringify(repo)} is not a GitHub repository name`);
    return { kind: "git", host: "github", owner, repo, version };
  }

  if (!FIRST_PARTY_PATH.test(text)) {
    throw new RegistryError(
      `${JSON.stringify(text)} is neither a framework module path (Core/Camera) nor a ` +
      "third-party coordinate (github:owner/repo@1.2.0)",
    );
  }
  return { kind: "first-party", path: text };
}

/** The stable id a lockfile and the index key on. */
export function refId(ref: PackageRef): string {
  return ref.kind === "first-party" ? ref.path.toLowerCase() : `github:${ref.owner}/${ref.repo}`.toLowerCase();
}

/** The git remote a `git` ref resolves from. HTTPS, never ssh: a package manager that needs a
 *  configured key to read a public repository fails on the machine that matters most, which is
 *  a fresh CI runner. */
export function gitRemote(ref: Extract<PackageRef, { kind: "git" }>): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}

/** One row of `index.json` — what discovery knows, and nothing resolution depends on. */
export interface IndexEntry {
  id: string;
  name: string;
  scheme: string;
  summary: string;
  owner: string;
  repo?: string;
  version: string;
  platforms: string[];
  actions: string[];
  stars?: number;
  license?: string;
  updated?: string;
}

export interface RegistryIndex {
  version: 1;
  generated: string;
  packages: IndexEntry[];
}

/**
 * Rank matches for `despia search`.
 *
 * Ordering is by WHERE the match landed, not by how many times it appears: an exact scheme is
 * what somebody typing `camera` almost always wants, and a package whose description happens to
 * say "camera" four times is not more relevant than the one named Camera. Stars break ties and
 * nothing else, so a popular package cannot outrank an exact name.
 */
export function searchIndex(index: RegistryIndex, query: string, limit = 25): IndexEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scored: Array<{ entry: IndexEntry; rank: number }> = [];
  for (const entry of index.packages) {
    const name = entry.name.toLowerCase();
    const scheme = entry.scheme.toLowerCase();
    let rank: number | null = null;
    if (scheme === q || name === q) rank = 0;
    else if (scheme.startsWith(q) || name.startsWith(q)) rank = 1;
    else if (entry.actions.some((a) => a.toLowerCase() === q)) rank = 2;
    else if (name.includes(q) || scheme.includes(q)) rank = 3;
    else if (entry.summary.toLowerCase().includes(q)) rank = 4;
    else if (entry.actions.some((a) => a.toLowerCase().includes(q))) rank = 5;
    if (rank !== null) scored.push({ entry, rank });
  }
  scored.sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank
      : (b.entry.stars ?? 0) !== (a.entry.stars ?? 0) ? (b.entry.stars ?? 0) - (a.entry.stars ?? 0)
      : a.entry.id.localeCompare(b.entry.id));
  return scored.slice(0, limit).map((s) => s.entry);
}

/** One pinned dependency. `sha256` is over the resolved tree, so a retagged release is caught. */
export interface LockEntry {
  version: string;
  source: string;
  resolved?: string;
  sha256?: string;
  /** The bus scheme the package fronts — recorded so `despia add` can refuse a collision without
   *  re-reading every cached manifest, and `despia list` can say what each pin provides. */
  scheme?: string;
  /** false = the hash was recorded trust-on-first-use, with no registry ledger to agree with.
   *  Recorded rather than implied, so "which pins were never cross-checked" is a grep. */
  crossChecked?: boolean;
}

export interface Lockfile {
  version: 1;
  modules: { [id: string]: LockEntry };
}

export function emptyLockfile(): Lockfile {
  return { version: 1, modules: {} };
}

/**
 * Add or replace a pin, and emit the lockfile deterministically.
 *
 * Keys are sorted on write. A lockfile whose diff depends on the order somebody happened to run
 * `despia add` is a lockfile that conflicts in every pull request, and the merge conflicts teach
 * people to delete it.
 */
export function lockAdd(lock: Lockfile, id: string, entry: LockEntry): Lockfile {
  const modules: { [id: string]: LockEntry } = {};
  for (const key of Object.keys({ ...lock.modules, [id]: entry }).sort()) {
    modules[key] = key === id ? entry : lock.modules[key]!;
  }
  return { version: 1, modules };
}

export function lockRemove(lock: Lockfile, id: string): Lockfile {
  const modules: { [id: string]: LockEntry } = {};
  for (const key of Object.keys(lock.modules).sort()) {
    if (key !== id) modules[key] = lock.modules[key]!;
  }
  return { version: 1, modules };
}

export function serializeLockfile(lock: Lockfile): string {
  return JSON.stringify(lock, null, 2) + "\n";
}
