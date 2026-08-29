//
//  registry-cli.test.ts — `despia search · add · remove · list` against a REAL git remote: a
//  fixture repository in a temp directory, tagged and retagged by the tests themselves. The
//  network never appears; the git transport over a local path is the same code path.
//
//  The case that earns its keep is the retag: the whole supply-chain stance of the registry
//  is "a moved tag is a refusal, never a re-pin", and that is only true if a test moves one.
//

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  LOCK_FILENAME, commandAdd, commandList, commandRemove, commandSearch, firstPartyIndex,
  readLockfile,
} from "../src/registry-commands.ts";
import { newestSemverTag, treeHash } from "../src/registry-resolve.ts";
import { readExportProject } from "../src/export.ts";
import { loadConfig } from "../src/config.ts";

function git(cwd: string, ...args: string[]): string {
  const ran = spawnSync("git", ["-c", "user.email=t@test", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" });
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.stderr}`);
  return ran.stdout;
}

function writeTree(root: string, files: { [path: string]: string }): void {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
}

/** A fixture package repository: dsx.json at root, committed, tagged. */
function makeRemote(dir: string, files: { [path: string]: string }, ...tags: string[]): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  writeTree(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "release");
  for (const tag of tags) git(dir, "tag", tag);
}

function retag(dir: string, tag: string, mutate: { [path: string]: string }): void {
  git(dir, "tag", "-d", tag);
  writeTree(dir, mutate);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "moved");
  git(dir, "tag", tag);
}

function makeProject(root: string): void {
  writeTree(root, {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix", version: "0.1.0" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": `<stack><text value="hi"/></stack>\n`,
  });
}

type Line = string;
function io(): { out: Line[]; err: Line[]; io: { out: (l: string) => void; err: (l: string) => void } } {
  const out: Line[] = [];
  const err: Line[] = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-registry-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

const LIDAR = {
  "dsx.json": JSON.stringify({ name: "Lidar", scheme: "lidar", version: "1.2.0" }),
  "kotlin/Lidar.kt": "class Lidar\n",
  "README.md": "depth from the camera array\n",
};

test("add resolves the newest RELEASE tag, pins it, and records trust-on-first-use", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    // 2.0.0-beta.1 and v9.9.9 are both real tags and both must lose: a prerelease is never
    // what an unpinned add silently chooses, and `v9.9.9` is not the version grammar.
    makeRemote(remote, LIDAR, "0.9.0", "1.2.0", "2.0.0-beta.1", "v9.9.9", "release-candidate");
    const project = join(root, "project");
    makeProject(project);

    const t = io();
    const code = await commandAdd({ project }, ["github:acme/dsx-lidar"], t.io,
      { remotes: { "github:acme/dsx-lidar": remote }, cacheDir: join(root, "cache") });
    assert.equal(code, 0, t.err.join("\n"));

    const lock = readLockfile(project);
    const entry = lock.modules["github:acme/dsx-lidar"]!;
    assert.equal(entry.version, "1.2.0");
    assert.match(entry.sha256!, /^sha256-[0-9a-f]{64}$/);
    assert.match(entry.resolved!, /^[0-9a-f]{40}$/);
    assert.equal(entry.scheme, "lidar", "the scheme is recorded so collisions and `list` need no manifest re-read");
    assert.equal(entry.crossChecked, false, "no ledger was consulted, and that FACT is recorded, not implied");
    assert.ok(t.out.some((l) => l.includes("trust-on-first-use")), "TOFU is said out loud in the plan line");
    assert.ok(t.out.some((l) => l.includes("will pin github:acme/dsx-lidar 1.2.0")), "the plan prints before the pin");

    // The pinned hash is the canonical tree hash of the checkout the cache now holds.
    assert.equal(entry.sha256, treeHash(join(root, "cache", "github", "acme", "dsx-lidar", "1.2.0")));
  } finally { cleanup(); }
});

test("a prerelease resolves only by NAMING it", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    makeRemote(remote, LIDAR, "2.0.0-beta.1");
    const project = join(root, "project");
    makeProject(project);
    const bare = io();
    await assert.rejects(() => commandAdd({ project }, ["github:acme/dsx-lidar"], bare.io,
      { remotes: { "github:acme/dsx-lidar": remote }, cacheDir: join(root, "cache") }),
      /no release tag/, "runCli maps this throw to exit 1");
    const named = io();
    assert.equal(await commandAdd({ project }, ["github:acme/dsx-lidar@2.0.0-beta.1"], named.io,
      { remotes: { "github:acme/dsx-lidar": remote }, cacheDir: join(root, "cache") }), 0, named.err.join("\n"));
    assert.equal(readLockfile(project).modules["github:acme/dsx-lidar"]!.version, "2.0.0-beta.1");
  } finally { cleanup(); }
});

test("A MOVED TAG IS A REFUSAL — before bytes via the commit sha, and on bytes via the tree hash", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    makeRemote(remote, LIDAR, "1.2.0");
    const project = join(root, "project");
    makeProject(project);
    const cacheDir = join(root, "cache");
    const remotes = { "github:acme/dsx-lidar": remote };

    const first = io();
    assert.equal(await commandAdd({ project }, ["github:acme/dsx-lidar@1.2.0"], first.io, { remotes, cacheDir }), 0);
    const pinned = readLockfile(project).modules["github:acme/dsx-lidar"]!;

    retag(remote, "1.2.0", { "kotlin/Lidar.kt": "class Lidar { /* not what was reviewed */ }\n" });

    // Warm cache: ls-remote's commit sha disagrees with the pin — refused before any fetch.
    const warm = io();
    await assert.rejects(() => commandAdd({ project }, ["github:acme/dsx-lidar@1.2.0"], warm.io, { remotes, cacheDir }),
      /TAG MOVED.*Nothing was fetched/s);
    assert.deepEqual(readLockfile(project).modules["github:acme/dsx-lidar"], pinned, "the pin is untouched");

    // Cold cache and a lockfile that (like a hand-merged one) kept only the tree hash: the
    // fetch succeeds and the HASH refuses.
    rmSync(cacheDir, { recursive: true, force: true });
    const lockPath = join(project, LOCK_FILENAME);
    const stripped = JSON.parse(readFileSync(lockPath, "utf8")) as { modules: { [k: string]: { resolved?: string } } };
    delete stripped.modules["github:acme/dsx-lidar"]!.resolved;
    writeFileSync(lockPath, JSON.stringify(stripped, null, 2) + "\n");
    const cold = io();
    await assert.rejects(() => commandAdd({ project }, ["github:acme/dsx-lidar@1.2.0"], cold.io, { remotes, cacheDir }),
      /TAG MOVED.*different bytes/s);
  } finally { cleanup(); }
});

test("the ledger outvotes the remote when they disagree", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    makeRemote(remote, LIDAR, "1.2.0");
    const project = join(root, "project");
    makeProject(project);
    const bad = io();
    await assert.rejects(() => commandAdd({ project }, ["github:acme/dsx-lidar@1.2.0"], bad.io, {
      remotes: { "github:acme/dsx-lidar": remote }, cacheDir: join(root, "cache"),
      ledger: { "github:acme/dsx-lidar": { "1.2.0": "sha256-" + "0".repeat(64) } },
    }), /ledger and the remote disagree/);
    assert.ok(!existsSync(join(project, LOCK_FILENAME)), "nothing was pinned");
  } finally { cleanup(); }
});

test("BOTH TIERS INSTALL — premium prints the watermark line and is never blocked", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    makeRemote(remote, {
      "dsx.json": JSON.stringify({ name: "Stream", scheme: "stream", version: "1.0.0", tier: "premium" }),
    }, "1.0.0");
    const project = join(root, "project");
    makeProject(project);
    const t = io();
    assert.equal(await commandAdd({ project }, ["github:acme/dsx-stream"], t.io,
      { remotes: { "github:acme/dsx-stream": remote }, cacheDir: join(root, "cache") }), 0,
      "a premium module installs exactly like an open one — the gate is the watermark at ship time, not the CLI");
    const line = t.out.find((l) => l.includes("premium module"));
    assert.ok(line !== undefined && line.includes("$249") && line.includes("watermark"),
      "the install says what the watermark costs to remove, once, and moves on");
  } finally { cleanup(); }
});

test("transitive requires: the plan prints everything, --no-deps opts out, conflicts refuse", async () => {
  const { root, cleanup } = scratch();
  try {
    const depRemote = join(root, "dep");
    makeRemote(depRemote, { "dsx.json": JSON.stringify({ name: "Util", scheme: "acme-util", version: "1.0.0" }) }, "1.0.0", "2.0.0");
    const remote = join(root, "remote");
    makeRemote(remote, {
      "dsx.json": JSON.stringify({
        name: "Lidar", scheme: "lidar", version: "1.2.0",
        requires: { "github:acme/util": "1.0.0" },
      }),
    }, "1.2.0");
    const remotes = { "github:acme/dsx-lidar": remote, "github:acme/util": depRemote };

    const project = join(root, "project");
    makeProject(project);
    const t = io();
    assert.equal(await commandAdd({ project }, ["github:acme/dsx-lidar"], t.io,
      { remotes, cacheDir: join(root, "cache") }), 0, t.err.join("\n"));
    assert.ok(t.out.some((l) => l.includes("will pin github:acme/util 1.0.0")),
      "every package about to be pinned is printed, dependencies included");
    const lock = readLockfile(project);
    assert.equal(lock.modules["github:acme/util"]!.version, "1.0.0", "the dependency is PINNED, not floating");

    // A second project, --no-deps: only the named package.
    const solo = join(root, "solo");
    makeProject(solo);
    const s = io();
    assert.equal(await commandAdd({ project: solo, "no-deps": true }, ["github:acme/dsx-lidar"], s.io,
      { remotes, cacheDir: join(root, "cache") }), 0);
    assert.deepEqual(Object.keys(readLockfile(solo).modules), ["github:acme/dsx-lidar"]);

    // A third project already pinning util@2.0.0: the requirement conflicts and NAMES both.
    const clash = join(root, "clash");
    makeProject(clash);
    const pre = io();
    assert.equal(await commandAdd({ project: clash }, ["github:acme/util@2.0.0"], pre.io,
      { remotes, cacheDir: join(root, "cache") }), 0);
    const c = io();
    await assert.rejects(() => commandAdd({ project: clash }, ["github:acme/dsx-lidar"], c.io,
      { remotes, cacheDir: join(root, "cache") }),
      /version conflict.*1\.0\.0.*2\.0\.0/s, "the refusal names BOTH pins, never a silent winner");
  } finally { cleanup(); }
});

test("a scheme the project already routes cannot be claimed twice", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    // `fix` is the fixture project's OWN scheme.
    makeRemote(remote, { "dsx.json": JSON.stringify({ name: "Imposter", scheme: "fix", version: "1.0.0" }) }, "1.0.0");
    const project = join(root, "project");
    makeProject(project);
    const t = io();
    await assert.rejects(() => commandAdd({ project }, ["github:acme/imposter"], t.io,
      { remotes: { "github:acme/imposter": remote }, cacheDir: join(root, "cache") }),
      /scheme collision.*this project/s);
  } finally { cleanup(); }
});

test("--dry-run prints the plan and writes nothing; DSX_OFFLINE makes the network a hard error", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    makeRemote(remote, LIDAR, "1.2.0");
    const project = join(root, "project");
    makeProject(project);
    const t = io();
    assert.equal(await commandAdd({ project, "dry-run": true }, ["github:acme/dsx-lidar"], t.io,
      { remotes: { "github:acme/dsx-lidar": remote }, cacheDir: join(root, "cache") }), 0);
    assert.ok(t.out.some((l) => l.includes("dry run")));
    assert.ok(!existsSync(join(project, LOCK_FILENAME)), "a dry run never writes the lockfile");

    process.env["DSX_OFFLINE"] = "1";
    try {
      const off = io();
      await assert.rejects(() => commandAdd({ project }, ["github:acme/dsx-lidar"], off.io,
        { remotes: { "github:acme/dsx-lidar": remote }, cacheDir: join(root, "cache-cold") }),
        /DSX_OFFLINE/, "a hard error, never a hang — what CI wants");
    } finally { delete process.env["DSX_OFFLINE"]; }
  } finally { cleanup(); }
});

test("remove unpins and names what IS pinned when asked for a stranger; list reports cache truth", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    makeRemote(remote, LIDAR, "1.2.0");
    const project = join(root, "project");
    makeProject(project);
    const cacheDir = join(root, "cache");
    const t = io();
    assert.equal(await commandAdd({ project }, ["github:acme/dsx-lidar"], t.io,
      { remotes: { "github:acme/dsx-lidar": remote }, cacheDir }), 0);

    const listed = io();
    assert.equal(commandList({ project }, [], listed.io, cacheDir), 0);
    assert.ok(listed.out.some((l) => l.includes("github:acme/dsx-lidar") && l.includes("resolved") && l.includes("lidar")));
    assert.ok(listed.out.some((l) => l.includes("[never cross-checked]")), "TOFU pins are visible in list");

    rmSync(cacheDir, { recursive: true, force: true });
    const gone = io();
    assert.equal(commandList({ project }, [], gone.io, cacheDir), 1, "an unresolved pin fails the listing — that is what CI wants");
    assert.ok(gone.out.some((l) => l.includes("NOT FETCHED") && l.includes("despia add github:acme/dsx-lidar@1.2.0")));

    const wrong = io();
    // The stranger throws (the CLI layer maps it to exit 1), and the message names what IS pinned.
    assert.throws(() => commandRemove({ project }, ["github:acme/other"], wrong.io),
      /is not pinned.*github:acme\/dsx-lidar/s);

    const done = io();
    assert.equal(commandRemove({ project }, ["github:acme/dsx-lidar"], done.io), 0);
    assert.ok(!("github:acme/dsx-lidar" in readLockfile(project).modules));
  } finally { cleanup(); }
});

test("the first-party coordinate is a DEFINED refusal while the modules are unmirrored", async () => {
  const t = io();
  assert.equal(await commandAdd({}, ["Core/Camera"], t.io), 1);
  const text = t.err.join("\n");
  assert.ok(text.includes("first-party") && text.includes("despia.com/packages/core/camera"),
    "the refusal explains the two-tier state and points at the docs page — never a mystery:\n" + text);

  // A bare owner/repo parses as a first-party PATH (the load-bearing ambiguity), but it names
  // no module — so the refusal prints the github: correction instead of claiming it is one.
  const bare = io();
  assert.equal(await commandAdd({}, ["acme/lidar"], bare.io), 1);
  assert.ok(bare.err.some((l) => l.includes("despia add github:acme/lidar")),
    "the correction is the exact command to paste:\n" + bare.err.join("\n"));
});

test("search answers OFFLINE from the bundled first-party index, and merges a community index", async () => {
  const bundled = firstPartyIndex();
  assert.ok(bundled.packages.length >= 140, "the bundled index carries the framework's capabilities");
  assert.ok(bundled.packages.some((p) => p.scheme === "camera"));

  const offline = io();
  process.env["DSX_OFFLINE"] = "1";
  try {
    assert.equal(await commandSearch({}, ["camera"], offline.io), 0,
      "no network, no project, first run — search still answers");
  } finally { delete process.env["DSX_OFFLINE"]; }
  assert.ok(offline.out.some((l) => l.includes("camera") && l.includes("ships with the framework")));

  const { root, cleanup } = scratch();
  try {
    const indexPath = join(root, "index.json");
    writeFileSync(indexPath, JSON.stringify({
      version: 1, generated: "test",
      packages: [{ id: "github:acme/dsx-lidar", name: "Lidar", scheme: "lidar", summary: "depth",
        owner: "acme", repo: "dsx-lidar", version: "1.2.0", platforms: ["ios"], actions: ["scan"] }],
    }));
    const merged = io();
    assert.equal(await commandSearch({ index: indexPath }, ["lidar"], merged.io), 0);
    assert.ok(merged.out.some((l) => l.includes("despia add github:acme/dsx-lidar")),
      "a community hit prints the exact install line — that line is what the search was for");
  } finally { cleanup(); }
});

test("despia export reads the lockfile-cache as a second module source, same validation, no shadowing", async () => {
  const { root, cleanup } = scratch();
  try {
    const remote = join(root, "remote");
    makeRemote(remote, {
      "dsx.json": JSON.stringify({ name: "Lidar", scheme: "lidar", version: "1.2.0" }),
      "kotlin/Lidar.kt": "package acme\nclass Lidar : Module() {}\n",
      "Components/LidarView.dsx": `<stack><text value="{{ dsx.attribute.depth }}"/></stack>\n`,
    }, "1.2.0");
    const project = join(root, "project");
    makeProject(project);
    const cacheDir = join(root, "cache");
    const t = io();
    assert.equal(await commandAdd({ project }, ["github:acme/dsx-lidar"], t.io,
      { remotes: { "github:acme/dsx-lidar": remote }, cacheDir }), 0);

    process.env["DSX_CACHE_DIR"] = cacheDir;
    try {
      const model = readExportProject(loadConfig(project));
      const lidar = model.modules.find((m) => m.name === "dsx-lidar");
      assert.ok(lidar !== undefined, "the pinned package exports like a Modules/ folder");
      assert.equal(lidar.scheme, "lidar");
      assert.equal(lidar.components.length, 1, "its components ride along");

      // A local Modules/ folder of the same name would shadow the pin silently — refused, naming both.
      writeTree(project, { "Modules/dsx-lidar/dsx.json": JSON.stringify({ name: "Local", scheme: "locallidar", version: "0.0.1" }) });
      assert.throws(() => readExportProject(loadConfig(project)), /both export as module "dsx-lidar"/);
    } finally { delete process.env["DSX_CACHE_DIR"]; }
  } finally { cleanup(); }
});

test("newestSemverTag: releases only, bare grammar only", () => {
  assert.equal(newestSemverTag(["0.9.0", "1.2.0", "2.0.0-beta.1", "v9.9.9", "nightly", "10.0.0"]), "10.0.0",
    "10.0.0 beats 9.x numerically (no lexicographic trap), the beta and the v-prefix never win");
  assert.equal(newestSemverTag(["v1.0.0", "latest"]), null);
});
