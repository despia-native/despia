//
//  registry.test.ts — the package registry's own rules.
//
//  The model is SPM's: git is the source of truth, a `packages.json` list is the submission
//  process, and the generated index is discovery only. So the cases that matter are the ones
//  about REFUSING to guess — a package manager that resolves an ambiguous coordinate by
//  heuristic installs the wrong thing on somebody's machine and is very hard to un-teach.
//

import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePackageRef, refId, gitRemote, searchIndex, emptyLockfile, lockAdd, lockRemove,
  serializeLockfile, RegistryError, type RegistryIndex,
} from "../src/registry.ts";

test("a coordinate names its host explicitly, or it is a framework path", () => {
  assert.deepEqual(parsePackageRef("github:acme/dsx-lidar@1.2.0"),
    { kind: "git", host: "github", owner: "acme", repo: "dsx-lidar", version: "1.2.0" });
  assert.deepEqual(parsePackageRef("Core/Camera"), { kind: "first-party", path: "Core/Camera" });

  // THE LOAD-BEARING REFUSAL. `acme/dsx-lidar` is shaped exactly like `Core/Camera`, so a bare
  // owner/repo cannot be told apart from a framework module path. Guessing here installs a
  // stranger's repository when the user meant a first-party module, or the reverse.
  assert.throws(() => parsePackageRef("acme/dsx-lidar@1.2.0"), RegistryError);
  assert.throws(() => parsePackageRef("gitlab:a/b"), /only third-party host is github/);
});

test("the version is optional, but a version that is not semver is refused", () => {
  const bare = parsePackageRef("github:acme/b");
  assert.equal(bare.kind, "git");
  assert.equal(bare.kind === "git" ? bare.version : "unreachable", null,
    "omitted means newest-at-resolve-time, which the lockfile then pins forever");
  for (const bad of ["v1.2.0", "latest", "1.2", "main", "01.2.0"]) {
    assert.throws(() => parsePackageRef(`github:acme/b@${bad}`), /is not a version/,
      `${bad} must be refused: a moving target in a lockfile is not a lock`);
  }
  const pre = parsePackageRef("github:acme/b@1.2.0-beta.1");
  assert.equal(pre.kind === "git" ? pre.version : "unreachable", "1.2.0-beta.1",
    "a prerelease is a real tag and resolves like any other");
});

test("ids are stable and case-insensitive, and the remote is https", () => {
  assert.equal(refId(parsePackageRef("github:Acme/DSX-Lidar@1.0.0")), "github:acme/dsx-lidar");
  assert.equal(refId(parsePackageRef("Core/Camera")), "core/camera");
  assert.equal(gitRemote(parsePackageRef("github:acme/b") as never), "https://github.com/acme/b.git",
    "never ssh: a fresh CI runner has no key, and that is the machine that matters most");
});

const INDEX: RegistryIndex = {
  version: 1, generated: "2026-08-21",
  packages: [
    { id: "core/camera", name: "Camera", scheme: "camera", summary: "Take a photo",
      owner: "despia-native", version: "1.0.0", platforms: ["ios", "android"],
      actions: ["capture", "burst"], stars: 0 },
    { id: "github:acme/lidar", name: "Lidar", scheme: "lidar", summary: "Depth from the camera array",
      owner: "acme", repo: "lidar", version: "1.2.0", platforms: ["ios"],
      actions: ["scan", "capture"], stars: 900 },
    { id: "github:zeta/photo-kit", name: "PhotoKit", scheme: "photokit",
      summary: "A camera and gallery kit", owner: "zeta", repo: "photo-kit", version: "0.3.0",
      platforms: ["ios", "android"], actions: ["pick"], stars: 5000 },
  ],
};

test("search ranks by WHERE the match landed, and stars only break ties", () => {
  const hits = searchIndex(INDEX, "camera").map((e) => e.id);
  assert.deepEqual(hits, ["core/camera", "github:zeta/photo-kit", "github:acme/lidar"],
    "the exact scheme wins outright: a 5000-star package whose description merely says 'camera' " +
    "must not outrank the module actually named Camera. The other two BOTH match only in their " +
    "summary, so they are genuinely tied on relevance and stars is the honest tie-break — that " +
    "is the one job popularity has here, and it never crosses a rank boundary.");

  assert.deepEqual(searchIndex(INDEX, "scan").map((e) => e.id), ["github:acme/lidar"],
    "an action name is a first-class search key: people search for the verb, not the package");
  assert.deepEqual(searchIndex(INDEX, "nothing-matches-this"), []);
});

test("the lockfile is deterministic, so it does not conflict in every pull request", () => {
  let a = emptyLockfile();
  a = lockAdd(a, "github:z/z", { version: "1.0.0", source: "github:z/z", sha256: "aa" });
  a = lockAdd(a, "core/camera", { version: "1.0.0", source: "first-party" });

  let b = emptyLockfile();
  b = lockAdd(b, "core/camera", { version: "1.0.0", source: "first-party" });
  b = lockAdd(b, "github:z/z", { version: "1.0.0", source: "github:z/z", sha256: "aa" });

  assert.equal(serializeLockfile(a), serializeLockfile(b),
    "the bytes must not depend on the order somebody happened to run `despia add`");
  assert.deepEqual(Object.keys(a.modules), ["core/camera", "github:z/z"]);

  const bumped = lockAdd(a, "core/camera", { version: "2.0.0", source: "first-party" });
  assert.equal(bumped.modules["core/camera"]!.version, "2.0.0", "adding again re-pins in place");
  assert.equal(Object.keys(lockRemove(bumped, "core/camera").modules).length, 1);
});
