//
//  registry-fetch.ts — the network half of the discovery index: GitHub facts + the manifest at
//  the newest tag, for each candidate in `packages.json`. Calls nothing but public endpoints,
//  and hands everything to registry-index.ts's PURE fold — which is why that fold has tests
//  and this file barely needs them beyond its ceilings.
//
//  A HOSTILE REPOSITORY IS AN INPUT HERE, so the fetch has ceilings rather than trust: a
//  manifest over 1 MiB is rejected with its size in the reason (the largest real manifest in
//  the tree is two orders of magnitude under that), the JSON parse is wrapped, and one
//  repository's failure never stops the run — the nightly output is always the whole list,
//  each row either indexed or rejected with why.
//
//  ETags make a no-change night nearly free: pass the map a previous run returned, and any
//  304 reuses the previous row instead of refetching and refolding it.
//

import type { RepoFacts } from "./registry-index.ts";
import { newestSemverTag } from "./registry-resolve.ts";

export const MANIFEST_BYTE_CAP = 1024 * 1024;

export type FetchLike = (url: string, init?: { headers?: { [k: string]: string } }) =>
  Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null };
    text(): Promise<string>; json(): Promise<unknown> }>;

export interface FetchRowOptions {
  /** A GitHub token (Actions: the read-only GITHUB_TOKEN) — 5000 requests/hour instead of 60. */
  token?: string;
  /** ETags from a previous run, url → etag. Mutated in place with this run's values. */
  etags?: { [url: string]: string };
  /** Rows from the previous run keyed by id, reused on 304. */
  previous?: { [id: string]: FetchedRow };
  /** Versions to exclude from the newest-tag pick (the yanked list). */
  excludeVersions?: readonly string[];
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface FetchedRow {
  facts: RepoFacts;
  manifest: { [k: string]: unknown } | null;
}

export type FetchOutcome =
  | { id: string; row: FetchedRow }
  | { id: string; rejection: string };

async function get(url: string, opts: FetchRowOptions): Promise<{ status: number; body: string; etag: string | null }> {
  const impl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const headers: { [k: string]: string } = { "user-agent": "despia-registry-index" };
  if (opts.token !== undefined && opts.token !== "") headers["authorization"] = `Bearer ${opts.token}`;
  const known = opts.etags?.[url];
  if (known !== undefined) headers["if-none-match"] = known;
  const response = await impl(url, { headers });
  const etag = response.headers.get("etag");
  if (etag !== null && opts.etags !== undefined) opts.etags[url] = etag;
  return { status: response.status, body: response.status === 304 ? "" : await response.text(), etag };
}

/**
 * One candidate → its facts + manifest, or a rejection reason. Never throws for anything the
 * remote did: a throw here would let one repository stop the nightly run for all of them.
 */
export async function fetchCandidate(owner: string, repo: string, opts: FetchRowOptions = {}): Promise<FetchOutcome> {
  const id = `github:${owner}/${repo}`.toLowerCase();
  try {
    const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const repoRes = await get(repoUrl, opts);
    if (repoRes.status === 304 && opts.previous?.[id] !== undefined) {
      // Unchanged since last night. Tags and manifest ride the repo's pushed_at: a new tag
      // updates the repo resource, so a 304 here means the whole row is still current.
      return { id, row: opts.previous[id]! };
    }
    if (repoRes.status === 404) return { id, rejection: "repository not found (deleted, renamed, or private)" };
    if (repoRes.status !== 200) return { id, rejection: `GitHub answered ${repoRes.status} for the repository` };
    let repoDoc: { description?: string | null; stargazers_count?: number; pushed_at?: string | null;
      license?: { spdx_id?: string | null } | null };
    try { repoDoc = JSON.parse(repoRes.body) as typeof repoDoc; } catch { return { id, rejection: "the repository response is not JSON" }; }

    const tags: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const tagRes = await get(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=100&page=${page}`,
        { ...opts, etags: undefined });
      if (tagRes.status !== 200) break;
      let list: Array<{ name?: string }>;
      try { list = JSON.parse(tagRes.body) as typeof list; } catch { break; }
      tags.push(...list.map((t) => t.name ?? ""));
      if (list.length < 100) break;
    }
    const excluded = new Set(opts.excludeVersions ?? []);
    const latestTag = newestSemverTag(tags.filter((t) => !excluded.has(t)));
    if (latestTag === null) {
      return { id, rejection: `no release tag — a package release is a bare semver git tag (1.0.0); the repository has ${tags.length} tag(s)` };
    }

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${latestTag}/dsx.json`;
    const manifestRes = await get(rawUrl, { ...opts, etags: undefined });
    let manifest: { [k: string]: unknown } | null = null;
    if (manifestRes.status === 200) {
      if (manifestRes.body.length > MANIFEST_BYTE_CAP) {
        return { id, rejection: `dsx.json at ${latestTag} is ${manifestRes.body.length} bytes — the cap is ${MANIFEST_BYTE_CAP} (a manifest is a contract, not a payload)` };
      }
      try { manifest = JSON.parse(manifestRes.body) as { [k: string]: unknown }; }
      catch { return { id, rejection: `dsx.json at ${latestTag} is not valid JSON` }; }
    }

    return {
      id,
      row: {
        facts: {
          owner, repo,
          description: repoDoc.description ?? null,
          ...(typeof repoDoc.stargazers_count === "number" ? { stars: repoDoc.stargazers_count } : {}),
          license: repoDoc.license?.spdx_id ?? null,
          pushedAt: repoDoc.pushed_at ?? null,
          latestTag,
        },
        manifest,
      },
    };
  } catch (e) {
    // Network refusal, DNS, a proxy 500 — the row is rejected with the reason, the run goes on.
    return { id, rejection: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The whole list, sequentially — a nightly job has hours, and burstless is polite. */
export async function fetchAllCandidates(
  list: ReadonlyArray<{ owner: string; repo: string }>,
  opts: FetchRowOptions = {},
  yanked: { [id: string]: { [version: string]: string } } = {},
): Promise<{ rows: Array<{ id: string; row: FetchedRow }>; rejected: Array<{ id: string; reason: string }> }> {
  const rows: Array<{ id: string; row: FetchedRow }> = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  for (const { owner, repo } of list) {
    const id = `github:${owner}/${repo}`.toLowerCase();
    const outcome = await fetchCandidate(owner, repo, {
      ...opts,
      excludeVersions: Object.keys(yanked[id] ?? {}),
    });
    if ("row" in outcome) rows.push(outcome);
    else rejected.push({ id: outcome.id, reason: outcome.rejection });
  }
  return { rows, rejected };
}
