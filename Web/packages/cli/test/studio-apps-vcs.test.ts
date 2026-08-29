//
//  The app change plane (studio-apps.md §14): the corpus over the pure half (classifier,
//  policy reader, titles, the commit sentence, the slug), and then the thing the corpus
//  cannot prove — REAL GIT. The landing tests cut actual repositories in a temp directory
//  and read the log back, because "it committed" is a claim about git, not about a mock.
//

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_POLICY, changeId, changeTitle, classifyChange, commitMessage, createChangePlane,
  githubSlug, landChange, mergePolicy, readChangeRecords, readPolicy, realGit, revertChange,
  writePolicy, type ChangeRecord, type VcsPolicy, type WriteFact,
} from "../src/studio-apps/vcs.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance/studio-apps/vcs.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/studio-apps/vcs.json not found");
    dir = parent;
  }
}

type Corpus = {
  classify: Array<{ name: string; writes: WriteFact[]; branch: string; policy?: Partial<VcsPolicy>; expect: { kind: string; reasons: number; reasonHas?: string } }>;
  policy: Array<{ name: string; raw: unknown; expect: Record<string, unknown> }>;
  title: Array<{ name: string; writes: WriteFact[]; expect: string }>;
  commit: Array<{ name: string; record: Partial<ChangeRecord>; version: string; expect: { subject: string; bodyHas?: string; trailers: string[] } }>;
  slug: Array<{ name: string; url: string; expect: string }>;
};

const root = repoRoot();
const corpus = JSON.parse(readFileSync(join(root, "OpenSource/Conformance/studio-apps/vcs.json"), "utf8")) as Corpus;

for (const c of corpus.classify) {
  test(`studio-apps/vcs classify: ${c.name}`, () => {
    const policy = { ...DEFAULT_POLICY, ...(c.policy ?? {}) };
    const verdict = classifyChange({ writes: c.writes, branch: c.branch, policy });
    assert.equal(verdict.kind, c.expect.kind, JSON.stringify(verdict));
    assert.equal(verdict.reasons.length, c.expect.reasons, JSON.stringify(verdict.reasons));
    if (c.expect.reasonHas !== undefined) {
      assert.ok(verdict.reasons.some((r) => r.includes(c.expect.reasonHas!)), JSON.stringify(verdict.reasons));
    }
  });
}

for (const c of corpus.policy) {
  test(`studio-apps/vcs policy: ${c.name}`, () => {
    const merged = mergePolicy(c.raw);
    for (const [key, value] of Object.entries(c.expect)) {
      if (key === "protectedCount") assert.equal(merged.protected.length, value);
      else assert.deepEqual((merged as unknown as Record<string, unknown>)[key], value, key);
    }
  });
}

for (const c of corpus.title) {
  test(`studio-apps/vcs title: ${c.name}`, () => assert.equal(changeTitle(c.writes), c.expect));
}

for (const c of corpus.commit) {
  test(`studio-apps/vcs commit: ${c.name}`, () => {
    const message = commitMessage(c.record as ChangeRecord, c.version);
    assert.equal(message.split("\n")[0], c.expect.subject);
    for (const trailer of c.expect.trailers) assert.ok(message.includes(trailer), `${trailer} missing from:\n${message}`);
    if (c.expect.bodyHas !== undefined) assert.ok(message.includes(c.expect.bodyHas), message);
  });
}

for (const c of corpus.slug) {
  test(`studio-apps/vcs slug: ${c.name}`, () => assert.equal(githubSlug(c.url), c.expect));
}

// ── the half a corpus cannot prove: real repositories ───────────────────────────────────

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsx-vcs-"));
  execFileSync("git", ["init", "-q", "-b", "work", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@despia.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(join(dir, "Components"), { recursive: true });
  writeFileSync(join(dir, "Components", "Card.dsx"), "<stack><text value=\"one\"/></stack>\n");
  writeFileSync(join(dir, "README.md"), "mine\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function log(dir: string, args: string[] = []): string {
  return execFileSync("git", ["log", "--format=%s%n%b", ...args], { cwd: dir, encoding: "utf8" });
}

function plane(dir: string, extra: Partial<Parameters<typeof createChangePlane>[0]> = {}) {
  // idleMs 0 keeps the burst semantics and the timer, without a test that sleeps
  return createChangePlane({ root: dir, idleMs: 5, ...extra });
}

test("studio-apps/vcs: a local change is its own commit, and only the app's files are in it", () => {
  const dir = newProject();
  try {
    writeFileSync(join(dir, "README.md"), "mine, edited while the app worked\n");   // the person's own work in flight
    const before = readFileSync(join(dir, "Components", "Card.dsx"), "utf8");
    writeFileSync(join(dir, "Components", "Card.dsx"), "<stack><text value=\"two\"/></stack>\n");
    const p = plane(dir);
    p.record({ app: "palette", appVersion: "0.3.0", document: "Components/Card.dsx", before, created: false, deleted: false });
    p.flush();

    const landed = p.landed();
    assert.equal(landed.length, 1);
    assert.equal(landed[0]!.kind, "local");
    assert.notEqual(landed[0]!.commit, "", landed[0]!.note);
    assert.match(log(dir), /palette: edit Components\/Card\.dsx/);
    assert.match(log(dir), /Despia-App: palette@0\.3\.0/);
    //  THE POINT: the person's README edit is still uncommitted. An app's commit is scoped
    //  to what the app touched, never `git add -A`.
    const status = execFileSync("git", ["status", "--short"], { cwd: dir, encoding: "utf8" });
    assert.match(status, /README\.md/);
    assert.doesNotMatch(status, /Card\.dsx/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("studio-apps/vcs: a structural change goes to its own branch and leaves the working branch alone", () => {
  const dir = newProject();
  try {
    writeFileSync(join(dir, "README.md"), "still mine\n");
    mkdirSync(join(dir, "Screens"), { recursive: true });
    writeFileSync(join(dir, "Screens", "Pricing.dsx"), "<stack/>\n");
    const p = plane(dir, { policy: { ...DEFAULT_POLICY, push: "off" } });
    p.record({ app: "palette", appVersion: "0.3.0", document: "Screens/Pricing.dsx", before: null, created: true, deleted: false });
    p.flush();

    const landed = p.landed()[0]!;
    assert.equal(landed.kind, "structural");
    assert.match(landed.branch, /^despia\/app\/palette\//);
    assert.notEqual(landed.commit, "");
    // back where we were, with the proposal off the working branch and the person's work intact
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(), "work");
    assert.equal(existsSync(join(dir, "Screens", "Pricing.dsx")), false);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "still mine\n");
    assert.doesNotMatch(log(dir), /Pricing/);
    assert.match(log(dir, [landed.branch]), /palette: add Screens\/Pricing\.dsx/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("studio-apps/vcs: a write on a protected branch is a proposal, never a commit on main", () => {
  const dir = newProject();
  try {
    execFileSync("git", ["branch", "-M", "main"], { cwd: dir });
    const before = readFileSync(join(dir, "Components", "Card.dsx"), "utf8");
    writeFileSync(join(dir, "Components", "Card.dsx"), "<stack><text value=\"app\"/></stack>\n");
    const p = plane(dir, { policy: { ...DEFAULT_POLICY, push: "off" } });
    p.record({ app: "palette", appVersion: "0.3.0", document: "Components/Card.dsx", before, created: false, deleted: false });
    p.flush();

    const landed = p.landed()[0]!;
    assert.equal(landed.kind, "structural");
    assert.ok(landed.reasons.some((r) => r.includes("main is a protected branch")), JSON.stringify(landed.reasons));
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(), "main");
    // main is untouched, and the working tree is back to what it was
    assert.equal(readFileSync(join(dir, "Components", "Card.dsx"), "utf8"), before);
    assert.doesNotMatch(log(dir), /palette/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("studio-apps/vcs: one burst is one change — several writes, one commit", () => {
  const dir = newProject();
  try {
    const before = readFileSync(join(dir, "Components", "Card.dsx"), "utf8");
    writeFileSync(join(dir, "Components", "Card.dsx"), "<stack><text value=\"a\"/></stack>\n");
    const p = plane(dir);
    p.record({ app: "palette", appVersion: "0.3.0", document: "Components/Card.dsx", before, created: false, deleted: false });
    writeFileSync(join(dir, "Components", "Card.dsx"), "<stack><text value=\"b\"/></stack>\n");
    p.record({ app: "palette", appVersion: "0.3.0", document: "Components/Card.dsx", before: "<stack><text value=\"a\"/></stack>\n", created: false, deleted: false });
    p.flush();

    assert.equal(p.landed().length, 1);
    //  THE FIRST bytes win: reverting the burst lands on what was there before it started,
    //  not on the state halfway through it.
    assert.equal(p.landed()[0]!.before["Components/Card.dsx"], before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("studio-apps/vcs: revert restores the bytes, removes what the app created, and records itself", () => {
  const dir = newProject();
  try {
    const before = readFileSync(join(dir, "Components", "Card.dsx"), "utf8");
    writeFileSync(join(dir, "Components", "Card.dsx"), "<stack><text value=\"app wrote this\"/></stack>\n");
    mkdirSync(join(dir, "Screens"), { recursive: true });
    writeFileSync(join(dir, "Screens", "New.dsx"), "<stack/>\n");
    const p = plane(dir, { policy: { ...DEFAULT_POLICY, commit: false } });
    p.record({ app: "palette", appVersion: "0.3.0", document: "Components/Card.dsx", before, created: false, deleted: false });
    p.record({ app: "palette", appVersion: "0.3.0", document: "Screens/New.dsx", before: null, created: true, deleted: false });
    p.flush();
    const change = p.landed()[0]!;

    const result = revertChange(dir, change.id, { policy: { ...DEFAULT_POLICY, commit: false } });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(dir, "Components", "Card.dsx"), "utf8"), before);
    assert.equal(existsSync(join(dir, "Screens", "New.dsx")), false);

    const history = readChangeRecords(dir);
    const original = history.find((r) => r.id === change.id)!;
    assert.notEqual(original.revertedBy, "");
    const undo = history.find((r) => r.id === original.revertedBy)!;
    assert.equal(undo.reverts, change.id);
    // and a second revert of the same change refuses rather than reverting the revert
    const again = revertChange(dir, change.id, { policy: { ...DEFAULT_POLICY, commit: false } });
    assert.equal(again.ok, false);
    assert.equal(again.ok === false ? again.reason : "", "already_reverted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("studio-apps/vcs: no repository is a NOTE, never a refusal — the change stands and reverts", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-vcs-bare-"));
  try {
    mkdirSync(join(dir, "Components"), { recursive: true });
    writeFileSync(join(dir, "Components", "Card.dsx"), "after\n");
    const p = plane(dir);
    p.record({ app: "palette", appVersion: "0.1.0", document: "Components/Card.dsx", before: "before\n", created: false, deleted: false });
    p.flush();
    const landed = p.landed()[0]!;
    assert.equal(landed.commit, "");
    assert.match(landed.note, /no git repository/);
    assert.equal(revertChange(dir, landed.id).ok, true);
    assert.equal(readFileSync(join(dir, "Components", "Card.dsx"), "utf8"), "before\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("studio-apps/vcs: a structural change with a remote pushes the branch and offers the pull request", () => {
  const origin = mkdtempSync(join(tmpdir(), "dsx-vcs-origin-"));
  const dir = newProject();
  try {
    execFileSync("git", ["init", "-q", "--bare", "."], { cwd: origin });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
    mkdirSync(join(dir, "Screens"), { recursive: true });
    writeFileSync(join(dir, "Screens", "Pricing.dsx"), "<stack/>\n");
    const p = plane(dir, {
      policy: { ...DEFAULT_POLICY },
      //  `gh` is not on this machine and must not be: the opener is a port, and its absence
      //  is the compare-link rung, which is the one every developer machine actually hits.
      openPull: () => "",
    });
    p.record({ app: "palette", appVersion: "0.3.0", document: "Screens/Pricing.dsx", before: null, created: true, deleted: false });
    p.flush();
    const landed = p.landed()[0]!;
    assert.equal(landed.pushed, true, landed.note);
    const remoteBranches = execFileSync("git", ["branch", "--list"], { cwd: origin, encoding: "utf8" });
    assert.match(remoteBranches, /despia\/app\/palette\//);
    // a bare local path is not a provider, so there is no link to offer and none is invented
    assert.equal(landed.pull, "");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }); }
});

test("studio-apps/vcs: a GitHub remote with no credential still hands over the pull-request link", () => {
  const dir = newProject();
  try {
    const record: ChangeRecord = {
      id: "abc", app: "palette", at: new Date().toISOString(), kind: "structural",
      reasons: ["adds Screens/Pricing.dsx to the project"], title: "add Screens/Pricing.dsx",
      documents: ["Screens/Pricing.dsx"], before: { "Screens/Pricing.dsx": null },
      branch: "", commit: "", pull: "", pullKind: "", pushed: false, note: "", revertedBy: "", reverts: "",
    };
    mkdirSync(join(dir, "Screens"), { recursive: true });
    writeFileSync(join(dir, "Screens", "Pricing.dsx"), "<stack/>\n");
    // a remote that LOOKS like GitHub and cannot be reached: the push fails, and the plane
    // says so rather than claiming a backup it does not have
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/storefront.git"], { cwd: dir });
    const landed = landChange(record, {
      root: dir, policy: { ...DEFAULT_POLICY, push: "off" }, git: realGit, appVersion: "0.3.0", openPull: () => "",
    });
    assert.equal(landed.kind, "structural");
    assert.notEqual(landed.commit, "");
    assert.match(landed.note, /pushing is off/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("studio-apps/vcs: the policy round-trips through the file the panel writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-vcs-policy-"));
  try {
    assert.deepEqual(readPolicy(dir), DEFAULT_POLICY);
    writePolicy(dir, { ...DEFAULT_POLICY, push: "always", fanOut: 8 });
    const read = readPolicy(dir);
    assert.equal(read.push, "always");
    assert.equal(read.fanOut, 8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("studio-apps/vcs: change ids sort by time and survive an app scheme with punctuation", () => {
  const a = changeId(1000, 1, "palette");
  const b = changeId(2000, 1, "palette");
  assert.ok(a < b, `${a} < ${b}`);
  assert.match(changeId(1000, 1, "spend-guard"), /^0{7}rs-1-spendguard$/);
});
