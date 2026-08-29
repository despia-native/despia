//
//  registry-fetch.test.ts — the network half of the index, against RECORDED responses (a stub
//  fetch): the ceilings, the per-repo failure isolation, the ETag reuse, and the yanked pick.
//  The pure fold it feeds is tested in registry-index.test.ts; here the subject is what the
//  fetch does when GitHub answers badly, hugely, or not at all.
//

import test from "node:test";
import assert from "node:assert/strict";

import {
  MANIFEST_BYTE_CAP, fetchAllCandidates, fetchCandidate, type FetchLike,
} from "../src/registry-fetch.ts";

type Canned = { status: number; body?: string; etag?: string };

/** A recorded GitHub: url → response. Anything unlisted answers 404. */
function recorded(responses: { [url: string]: Canned }, log: string[] = []): FetchLike {
  return async (url, init) => {
    log.push(`${url}${init?.headers?.["if-none-match"] !== undefined ? " [conditional]" : ""}`);
    const canned = responses[url] ?? { status: 404, body: "{}" };
    return {
      status: canned.status,
      ok: canned.status >= 200 && canned.status < 300,
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? canned.etag ?? null : null) },
      text: async () => canned.body ?? "",
      json: async () => JSON.parse(canned.body ?? "null"),
    };
  };
}

const REPO_URL = "https://api.github.com/repos/acme/dsx-lidar";
const TAGS_URL = "https://api.github.com/repos/acme/dsx-lidar/tags?per_page=100&page=1";
const RAW = (tag: string) => `https://raw.githubusercontent.com/acme/dsx-lidar/${tag}/dsx.json`;

const HAPPY: { [url: string]: Canned } = {
  [REPO_URL]: {
    status: 200, etag: "W/\"abc\"",
    body: JSON.stringify({ description: "depth", stargazers_count: 42, pushed_at: "2026-08-01T00:00:00Z",
      license: { spdx_id: "MIT" } }),
  },
  [TAGS_URL]: { status: 200, body: JSON.stringify([{ name: "1.2.0" }, { name: "0.9.0" }, { name: "v9.9.9" }]) },
  [RAW("1.2.0")]: { status: 200, body: JSON.stringify({ name: "Lidar", scheme: "lidar", version: "1.2.0" }) },
};

test("a candidate folds to facts + manifest at its newest release tag", async () => {
  const outcome = await fetchCandidate("acme", "dsx-lidar", { fetchImpl: recorded(HAPPY) });
  assert.ok("row" in outcome, JSON.stringify(outcome));
  assert.equal(outcome.row.facts.latestTag, "1.2.0", "v9.9.9 is not the version grammar and never wins");
  assert.equal(outcome.row.facts.stars, 42);
  assert.equal(outcome.row.facts.license, "MIT");
  assert.equal((outcome.row.manifest as { scheme?: string }).scheme, "lidar");
});

test("the failure modes are rejections with reasons, never throws", async () => {
  const gone = await fetchCandidate("acme", "dsx-lidar", { fetchImpl: recorded({}) });
  assert.ok("rejection" in gone && gone.rejection.includes("not found"));

  const untagged = await fetchCandidate("acme", "dsx-lidar", {
    fetchImpl: recorded({ ...HAPPY, [TAGS_URL]: { status: 200, body: JSON.stringify([{ name: "nightly" }]) } }),
  });
  assert.ok("rejection" in untagged && untagged.rejection.includes("no release tag"));

  const huge = await fetchCandidate("acme", "dsx-lidar", {
    fetchImpl: recorded({ ...HAPPY, [RAW("1.2.0")]: { status: 200, body: `{"pad":"${"x".repeat(MANIFEST_BYTE_CAP)}"}` } }),
  });
  assert.ok("rejection" in huge && huge.rejection.includes(String(MANIFEST_BYTE_CAP)),
    "the cap rejection names the size — a manifest is a contract, not a payload");

  const garbled = await fetchCandidate("acme", "dsx-lidar", {
    fetchImpl: recorded({ ...HAPPY, [RAW("1.2.0")]: { status: 200, body: "not json {" } }),
  });
  assert.ok("rejection" in garbled && garbled.rejection.includes("not valid JSON"));
});

test("one repository's failure never stops the run — the output is always the whole list", async () => {
  const impl: FetchLike = async (url) => {
    if (url.includes("exploding")) throw new Error("connection reset by peer");
    return recorded(HAPPY)(url);
  };
  const { rows, rejected } = await fetchAllCandidates(
    [{ owner: "acme", repo: "exploding" }, { owner: "acme", repo: "dsx-lidar" }],
    { fetchImpl: impl },
  );
  assert.equal(rows.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason.includes("connection reset"), "the reason survives into the report");
});

test("a 304 with a previous row reuses it — a no-change night is nearly free", async () => {
  const log: string[] = [];
  const etags: { [url: string]: string } = {};
  const first = await fetchCandidate("acme", "dsx-lidar", { fetchImpl: recorded(HAPPY, log), etags });
  assert.ok("row" in first);
  assert.equal(etags[REPO_URL], "W/\"abc\"", "the etag was recorded for the next run");

  const second = await fetchCandidate("acme", "dsx-lidar", {
    fetchImpl: recorded({ [REPO_URL]: { status: 304 } }, log),
    etags,
    previous: { "github:acme/dsx-lidar": first.row },
  });
  assert.ok("row" in second);
  assert.deepEqual(second.row, first.row);
  assert.ok(log[log.length - 1]!.includes("[conditional]"), "the request carried If-None-Match");
  assert.equal(log.filter((l) => l.includes("/tags")).length, 1, "the 304 run fetched no tags and no manifest");
});

test("a yanked version is never picked as newest — the next release down is", async () => {
  const outcome = await fetchCandidate("acme", "dsx-lidar", {
    fetchImpl: recorded({ ...HAPPY, [RAW("0.9.0")]: { status: 200, body: JSON.stringify({ name: "Lidar", scheme: "lidar", version: "0.9.0" }) } }),
    excludeVersions: ["1.2.0"],
  });
  assert.ok("row" in outcome);
  assert.equal(outcome.row.facts.latestTag, "0.9.0",
    "cargo semantics: yanked still resolves for pinned projects, and is never chosen fresh");
});
