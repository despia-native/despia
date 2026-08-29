//
//  registry-index.ts — build `index.json` from GitHub, for the discovery site and `despia search`.
//
//  THE SOURCE OF TRUTH IS GIT, NOT THIS FILE. Nothing here participates in resolution: `despia add`
//  reads a git tag and verifies bytes, and it works when this index is stale, wrong, or gone.
//  That is the whole reason the registry can be a JSON file in a repo instead of a service with
//  an uptime obligation.
//
//  SUBMISSION IS A PULL REQUEST, the Swift Package Index shape: `packages.json` is a flat list
//  of `owner/repo` and adding yourself is a one-line diff. No account, no API key, no dashboard,
//  and moderation is reviewing a PR — which costs nothing until it has to.
//
//  WHAT MAKES THE PAGE WORTH READING. A Swift package declares no machine-readable API, so the
//  Swift Package Index can only ever show a README and a compatibility badge. Every `dsx.json`
//  declares each action's args, its resolve shape, its error codes WITH human messages, and
//  executable tests. So this index carries the real API surface and the site can render a page
//  per ACTION, not merely per package — which is the difference between one page that ranks for
//  a package name and hundreds that each answer one "how do I X" question.
//

export class IndexError extends Error {}

/** What a third-party repository must have. Deliberately short: a manifest and a tag. */
export interface PackageManifest {
  name?: unknown;
  scheme?: unknown;
  version?: unknown;
  summary?: unknown;
  platforms?: unknown;
  actions?: unknown;
}

/** What GitHub tells us. Everything is optional — the index degrades, it never fails. */
export interface RepoFacts {
  owner: string;
  repo: string;
  description?: string | null;
  stars?: number;
  license?: string | null;
  pushedAt?: string | null;
  latestTag?: string | null;
}

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

/** Why a candidate did not make the index. Reported, never silently dropped: a submitted
 *  package that vanishes without explanation is an issue somebody has to open to find out. */
export interface IndexRejection {
  id: string;
  reason: string;
}

export interface IndexResult {
  packages: IndexEntry[];
  rejected: IndexRejection[];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).sort();
}

/**
 * The action names a manifest declares, from either shape.
 *
 * `actions` is a flat map of dotted names and `methods` is a tree whose leaves are actions.
 * Reading only one reports a methods-declared package as having no API at all, which is exactly
 * the kind of quiet wrongness a generated page must not have — the reader has no way to tell it
 * from a package that really does nothing.
 */
export function manifestActions(manifest: { [k: string]: unknown }): string[] {
  const out = new Set<string>();
  const flat = manifest["actions"];
  if (flat !== null && typeof flat === "object" && !Array.isArray(flat)) {
    for (const key of Object.keys(flat as object)) if (!key.startsWith("_")) out.add(key);
  }
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as { [k: string]: unknown })) {
      if (key.startsWith("_")) continue;
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const spec = value as { [k: string]: unknown };
      const name = prefix === "" ? key : `${prefix}.${key}`;
      if ("resolves" in spec || "args" in spec || "errors" in spec || "tests" in spec) out.add(name);
      else walk(value, name);
    }
  };
  walk(manifest["methods"], "");
  return [...out].sort();
}

/**
 * Fold one candidate into an index row, or say why not.
 *
 * A missing `scheme` is the only hard rejection. A module with no scheme declares no bus
 * surface, so there is nothing for a page to document and nothing for anyone to call — listing
 * it would be listing a name.
 */
export function foldPackage(facts: RepoFacts, manifest: { [k: string]: unknown } | null): IndexEntry | IndexRejection {
  const id = `github:${facts.owner}/${facts.repo}`.toLowerCase();
  if (manifest === null) {
    return { id, reason: "no dsx.json at the newest tag — a package is a repository with a manifest at its root" };
  }
  const scheme = typeof manifest["scheme"] === "string" ? manifest["scheme"].trim() : "";
  if (scheme === "") {
    return { id, reason: "the manifest declares no `scheme`, so the module exposes nothing callable" };
  }
  const version = stringOr(manifest["version"], facts.latestTag ?? "");
  if (version === "") {
    return { id, reason: "no version — tag a release (1.0.0) or declare `version` in the manifest" };
  }
  return {
    id,
    name: stringOr(manifest["name"], facts.repo),
    scheme,
    // The manifest's own words win over GitHub's description: the author wrote one to describe
    // the module and the other to describe the repository, and they are not the same sentence.
    summary: stringOr(manifest["summary"], stringOr(facts.description, "")),
    owner: facts.owner,
    repo: facts.repo,
    version,
    platforms: stringList(manifest["platforms"]),
    actions: manifestActions(manifest),
    ...(typeof facts.stars === "number" ? { stars: facts.stars } : {}),
    ...(typeof facts.license === "string" && facts.license !== "" ? { license: facts.license } : {}),
    ...(typeof facts.pushedAt === "string" && facts.pushedAt !== "" ? { updated: facts.pushedAt } : {}),
  };
}

function isRejection(row: IndexEntry | IndexRejection): row is IndexRejection {
  return (row as IndexRejection).reason !== undefined;
}

/** The scheme grammar the framework itself uses: a lowercase identifier, hyphens allowed
 *  (`get-uuid` and `writevalue` are real schemes). Anything else would be unroutable at the
 *  dispatch funnel, so listing it would advertise a package that cannot be called. */
const SCHEME = /^[a-z][a-z0-9-]*$/;

/**
 * Build the index from already-fetched facts. Pure: the network lives in the caller, so this is
 * testable without one, which is the difference between a generator with tests and a generator
 * whose only test is "it ran in CI last night".
 */
export function buildIndex(
  rows: Array<{ facts: RepoFacts; manifest: { [k: string]: unknown } | null }>,
  reservedSchemes: { [scheme: string]: string } = {},
): IndexResult {
  const packages: IndexEntry[] = [];
  const rejected: IndexRejection[] = [];
  // SEEDED with the framework's own schemes before any community row is read. Without this,
  // `github:x/y` claiming `camera` wins first-listed and squats the framework namespace; with
  // it, the refusal names the first-party module the newcomer collided with.
  const seen = new Map<string, string>();
  for (const [scheme, owner] of Object.entries(reservedSchemes)) seen.set(scheme.toLowerCase(), owner);
  for (const row of rows) {
    const folded = foldPackage(row.facts, row.manifest);
    if (isRejection(folded)) { rejected.push(folded); continue; }
    if (!SCHEME.test(folded.scheme)) {
      rejected.push({ id: folded.id, reason:
        `scheme ${JSON.stringify(folded.scheme)} is not a scheme the dispatch funnel can route ` +
        "(lowercase identifier, hyphens allowed) — the package would be listed but uncallable" });
      continue;
    }
    // Two packages fronting one scheme is the collision that breaks a consumer's build at
    // prepare time with a duplicate chain. Better to refuse the newcomer in the index than to
    // let someone install it and discover the clash from a red build.
    const owner = seen.get(folded.scheme.toLowerCase());
    if (owner !== undefined) {
      rejected.push({ id: folded.id, reason: `scheme "${folded.scheme}" is already listed by ${owner}` });
      continue;
    }
    seen.set(folded.scheme.toLowerCase(), folded.id);
    packages.push(folded);
  }
  packages.sort((a, b) => a.id.localeCompare(b.id));
  rejected.sort((a, b) => a.id.localeCompare(b.id));
  return { packages, rejected };
}

/** Read `packages.json`: a flat list of `owner/repo`, and a PR to it is the whole submission. */
export function parsePackageList(raw: string): Array<{ owner: string; repo: string }> {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { throw new IndexError("packages.json is not valid JSON"); }
  const list = Array.isArray(doc) ? doc : (doc as { packages?: unknown })?.packages;
  if (!Array.isArray(list)) throw new IndexError("packages.json must be an array of \"owner/repo\", or { packages: [...] }");
  const out: Array<{ owner: string; repo: string }> = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") throw new IndexError(`packages.json holds a non-string entry: ${JSON.stringify(item)}`);
    const text = item.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    const slash = text.indexOf("/");
    if (slash <= 0 || slash === text.length - 1 || text.indexOf("/", slash + 1) >= 0) {
      throw new IndexError(`packages.json entry ${JSON.stringify(item)} is not owner/repo`);
    }
    const owner = text.substring(0, slash);
    const repo = text.substring(slash + 1);
    // The SAME grammar resolution enforces (registry.ts), so a name the list accepts can never
    // be one `despia add` refuses — the two ends of the pipeline agreeing is what makes a listing
    // installable by construction.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
      throw new IndexError(`packages.json entry ${JSON.stringify(item)}: ${JSON.stringify(owner)} is not a GitHub owner`);
    }
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      throw new IndexError(`packages.json entry ${JSON.stringify(item)}: ${JSON.stringify(repo)} is not a GitHub repository name`);
    }
    const key = text.toLowerCase();
    if (seen.has(key)) continue;   // a duplicate line is a merge artifact, not an error
    seen.add(key);
    out.push({ owner, repo });
  }
  return out;
}
