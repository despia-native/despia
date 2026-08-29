//
//  registry-index.test.ts — the discovery index, built from GitHub.
//
//  Every case here is about the index being HONEST rather than complete. It is generated
//  nightly from other people's repositories, so it will meet malformed manifests, retagged
//  releases and scheme collisions, and the only safe behaviour is to say what it dropped and
//  why. A generator that silently omits a submitted package produces an issue nobody can debug.
//

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIndex, foldPackage, manifestActions, parsePackageList, IndexError,
  type RepoFacts,
} from "../src/registry-index.ts";

const FACTS: RepoFacts = {
  owner: "acme", repo: "dsx-lidar", description: "the repo blurb",
  stars: 12, license: "MIT", pushedAt: "2026-08-20T00:00:00Z", latestTag: "1.2.0",
};

test("actions are read from BOTH declaration shapes", () => {
  assert.deepEqual(manifestActions({ actions: { capture: { resolves: {} }, _note: "skipped" } }), ["capture"]);
  assert.deepEqual(manifestActions({ methods: { rag: { add: { args: {} }, query: { resolves: {} } } } }),
    ["rag.add", "rag.query"]);
  assert.deepEqual(manifestActions({ actions: { a: { resolves: {} } }, methods: { b: { c: { args: {} } } } }),
    ["a", "b.c"],
    "reading only `actions` reports a methods-declared package as having no API at all, which a " +
    "reader cannot tell apart from a package that really does nothing");
});

test("a package with no scheme is refused, and the refusal says why", () => {
  const noManifest = foldPackage(FACTS, null) as { reason: string };
  assert.match(noManifest.reason, /no dsx\.json/);
  const noScheme = foldPackage(FACTS, { name: "Lidar", version: "1.0.0" }) as { reason: string };
  assert.match(noScheme.reason, /no `scheme`/,
    "a module with no bus surface has nothing for a page to document and nothing to call");
  const noVersion = foldPackage({ ...FACTS, latestTag: null }, { scheme: "lidar" }) as { reason: string };
  assert.match(noVersion.reason, /tag a release/);
});

test("the manifest's own words beat the repository description", () => {
  const row = foldPackage(FACTS, { scheme: "lidar", summary: "Depth from the camera array" }) as { summary: string; name: string; version: string };
  assert.equal(row.summary, "Depth from the camera array",
    "an author writes one sentence to describe the module and another to describe the repo");
  assert.equal(row.name, "dsx-lidar", "no declared name falls back to the repo, never to blank");
  assert.equal(row.version, "1.2.0", "no declared version falls back to the newest tag");

  const blurb = foldPackage(FACTS, { scheme: "lidar" }) as { summary: string };
  assert.equal(blurb.summary, "the repo blurb", "with no manifest summary, GitHub's is better than nothing");
});

test("two packages cannot front one scheme, and the loser is told", () => {
  const result = buildIndex([
    { facts: FACTS, manifest: { scheme: "lidar", version: "1.2.0" } },
    { facts: { owner: "zeta", repo: "lidar-too" }, manifest: { scheme: "lidar", version: "0.1.0" } },
  ]);
  assert.deepEqual(result.packages.map((p) => p.id), ["github:acme/dsx-lidar"]);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.reason, /already listed by github:acme\/dsx-lidar/,
    "a duplicate scheme breaks a consumer's build at prepare time with a duplicate chain — " +
    "refusing the newcomer here beats letting someone install it and meet a red build");
});

test("the framework's own schemes are reserved, and the squatter is told whose it is", () => {
  const result = buildIndex(
    [
      { facts: { owner: "x", repo: "y" }, manifest: { scheme: "camera", version: "1.0.0" } },
      { facts: { owner: "a", repo: "ok" }, manifest: { scheme: "lidar", version: "1.0.0" } },
    ],
    { Camera: "core/camera" },
  );
  assert.deepEqual(result.packages.map((p) => p.id), ["github:a/ok"]);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.reason, /already listed by core\/camera/,
    "without the seed, github:x/y claiming `camera` wins first-listed and squats the framework " +
    "namespace; the refusal must name the first-party module so the author knows it is not a " +
    "race. The seed key is lowercased on entry, so a mixed-case reservation still reserves.");
});

test("a scheme the dispatch funnel cannot route is refused, not listed as uncallable", () => {
  const result = buildIndex([
    { facts: { owner: "x", repo: "y" }, manifest: { scheme: "My Scheme!", version: "1.0.0" } },
    { facts: { owner: "a", repo: "b" }, manifest: { scheme: "get-uuid2", version: "1.0.0" } },
  ]);
  assert.deepEqual(result.packages.map((p) => p.scheme), ["get-uuid2"],
    "hyphens are legal — get-uuid and writevalue are real framework schemes");
  assert.match(result.rejected[0]!.reason, /dispatch funnel can route/,
    "listing a package nobody can call is worse than refusing it with the grammar in the message");
});

test("the index is sorted, so a nightly regeneration is not a churning diff", () => {
  const result = buildIndex([
    { facts: { owner: "z", repo: "z" }, manifest: { scheme: "z", version: "1.0.0" } },
    { facts: { owner: "a", repo: "a" }, manifest: { scheme: "a", version: "1.0.0" } },
  ]);
  assert.deepEqual(result.packages.map((p) => p.id), ["github:a/a", "github:z/z"]);
});

test("packages.json accepts what people actually paste, and refuses what it cannot resolve", () => {
  assert.deepEqual(
    parsePackageList('["acme/lidar", "https://github.com/z/y.git", "ACME/lidar"]'),
    [{ owner: "acme", repo: "lidar" }, { owner: "z", repo: "y" }],
    "a full URL is what a submitter copies out of the address bar, and a case-different " +
    "duplicate is a merge artifact rather than a second package");
  assert.deepEqual(parsePackageList('{"packages": ["a/b"]}'), [{ owner: "a", repo: "b" }]);
  assert.throws(() => parsePackageList("not json"), IndexError);
  assert.throws(() => parsePackageList('["justaname"]'), /is not owner\/repo/);
  assert.throws(() => parsePackageList('[123]'), /non-string entry/);
  assert.throws(() => parsePackageList('["-bad/repo"]'), /is not a GitHub owner/,
    "the list enforces the SAME grammar resolution does, so a name the list accepts can never " +
    "be one despia add refuses");
  assert.throws(() => parsePackageList('["ok/re po"]'), /is not a GitHub repository name/);
});
