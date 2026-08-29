//
//  studio-apps/vcs.ts — the app change plane (studio-apps.md §14): an app write is never
//  just a write. It joins a CHANGE SET, the change set is CLASSIFIED, and the classification
//  decides where it lands:
//
//    local      → its own commit on the branch you are already on, scoped to exactly the
//                 files the app touched (never `git add -A`, so your own work in flight is
//                 not swept into an app's commit)
//    structural → a branch of its own plus a pull request, and the working branch goes back
//                 to how it was. An app that reshapes the project PROPOSES; a person merges.
//
//  Both are recoverable without git at all: every set carries the pre-change bytes of every
//  file it touched, so `despia app revert <id>` is a byte restore through the same door the
//  app wrote through — the revert is itself a recorded, attributed change.
//
//  ARTICLE 7 THROUGHOUT. No git, no remote, no `gh`, a detached HEAD, a push that is refused:
//  none of them refuse the edit. Each degrades to the next rung and writes what happened into
//  the record, because a person who is told "committed locally, not pushed — no remote named"
//  can act, and a silent failure is how a backup plane becomes a lie.
//
//  The classifier is PURE and corpus-driven: OpenSource/Conformance/studio-apps/vcs.json.
//

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";

// ── the policy (.despia/apps/vcs.json) ──────────────────────────────────────────────────

export type PushPolicy = "off" | "structural" | "always";

export type VcsPolicy = {
  /** commit app changes at all (a project that is not a git repo ignores this) */
  commit: boolean;
  /** off · structural (only the branches a pull request needs) · always (every commit) */
  push: PushPolicy;
  remote: string;
  /** a write while on one of these is structural by itself: apps never commit to main */
  protected: string[];
  /** more documents than this in one change set is a fan-out, and a fan-out is structural */
  fanOut: number;
  /** structural changes open a pull request; off leaves the branch pushed and named */
  pullRequests: boolean;
};

export const DEFAULT_POLICY: VcsPolicy = {
  commit: true,
  //  STRUCTURAL, not always: a branch that carries a pull request MUST reach the provider,
  //  and everything else stays local until the person pushes their own work. "Back up every
  //  app change" is one switch away in the Apps panel — it is opt-in because pushing is an
  //  outward-facing act on someone else's account, not because the backup is optional.
  push: "structural",
  remote: "origin",
  protected: ["main", "master", "trunk", "release"],
  fanOut: 3,
  pullRequests: true,
};

export function policyFile(projectRoot: string): string {
  return join(projectRoot, ".despia", "apps", "vcs.json");
}

export function readPolicy(projectRoot: string): VcsPolicy {
  const path = policyFile(projectRoot);
  if (!existsSync(path)) return { ...DEFAULT_POLICY };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return mergePolicy(raw);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

/** A stored policy is a partial override of the defaults, and a nonsense value is ignored
 *  rather than obeyed — a hand-edited `push: "yes"` must not read as "always". */
export function mergePolicy(raw: unknown): VcsPolicy {
  const out: VcsPolicy = { ...DEFAULT_POLICY, protected: [...DEFAULT_POLICY.protected] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const row = raw as Record<string, unknown>;
  if (typeof row["commit"] === "boolean") out.commit = row["commit"];
  if (row["push"] === "off" || row["push"] === "structural" || row["push"] === "always") out.push = row["push"];
  if (typeof row["remote"] === "string" && row["remote"].trim() !== "") out.remote = row["remote"].trim();
  if (Array.isArray(row["protected"])) {
    out.protected = row["protected"].filter((b): b is string => typeof b === "string" && b.trim() !== "").map((b) => b.trim());
  }
  if (typeof row["fanOut"] === "number" && Number.isFinite(row["fanOut"]) && row["fanOut"] >= 1) {
    out.fanOut = Math.floor(row["fanOut"]);
  }
  if (typeof row["pullRequests"] === "boolean") out.pullRequests = row["pullRequests"];
  return out;
}

export function writePolicy(projectRoot: string, policy: VcsPolicy): void {
  const path = policyFile(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`);
  renameSync(tmp, path);
}

// ── the classifier (pure, corpus-gated) ─────────────────────────────────────────────────

export type WriteFact = {
  /** the project-relative document path the app wrote */
  document: string;
  /** the file did not exist before this write */
  created: boolean;
  /** the file existed and no longer does */
  deleted: boolean;
};

export type ChangeFacts = {
  writes: readonly WriteFact[];
  /** the branch the working tree is on; "" when there is no repository or HEAD is detached */
  branch: string;
  policy: VcsPolicy;
};

export type ChangeKind = "local" | "structural";

/**
 * ONE QUESTION: could a person's next build depend on this having been reviewed? Adding or
 * removing a document changes what the router reaches; a fan-out across many documents is a
 * refactor nobody asked to have applied silently; and a write onto a protected branch is one
 * an app may propose but never perform. Everything else is an in-place edit of one document,
 * which the file of record plus a commit already makes safe.
 */
export function classifyChange(facts: ChangeFacts): { kind: ChangeKind; reasons: string[] } {
  const reasons: string[] = [];
  const created = facts.writes.filter((w) => w.created).map((w) => w.document);
  const deleted = facts.writes.filter((w) => w.deleted).map((w) => w.document);
  if (created.length > 0) reasons.push(`adds ${created.join(", ")} to the project`);
  if (deleted.length > 0) reasons.push(`removes ${deleted.join(", ")} from the project`);
  const documents = new Set(facts.writes.map((w) => w.document));
  if (documents.size > facts.policy.fanOut) {
    reasons.push(`touches ${documents.size} documents in one change (the fan-out limit is ${facts.policy.fanOut})`);
  }
  if (facts.branch !== "" && facts.policy.protected.includes(facts.branch)) {
    reasons.push(`${facts.branch} is a protected branch`);
  }
  return { kind: reasons.length > 0 ? "structural" : "local", reasons };
}

// ── the git port ────────────────────────────────────────────────────────────────────────

export type GitRun = { code: number; out: string; err: string };
export type GitPort = { run: (args: readonly string[], cwd: string) => GitRun; has: (bin: string) => boolean };

export const realGit: GitPort = {
  run(args, cwd) {
    const ran = spawnSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (ran.error !== undefined) return { code: 127, out: "", err: ran.error.message };
    return { code: ran.status ?? 1, out: (ran.stdout ?? "").trim(), err: (ran.stderr ?? "").trim() };
  },
  has(bin) {
    const ran = spawnSync(bin, ["--version"], { encoding: "utf8" });
    return ran.error === undefined && (ran.status ?? 1) === 0;
  },
};

export type GitFacts = {
  repo: boolean;
  /** the repository root, which is not always the project root */
  top: string;
  branch: string;
  remote: string;
  /** owner/repo when the remote is a GitHub one, "" otherwise */
  slug: string;
};

export function gitFacts(port: GitPort, root: string, policy: VcsPolicy): GitFacts {
  const top = port.run(["rev-parse", "--show-toplevel"], root);
  if (top.code !== 0) return { repo: false, top: "", branch: "", remote: "", slug: "" };
  const branch = port.run(["branch", "--show-current"], root);
  const remote = port.run(["remote", "get-url", policy.remote], root);
  return {
    repo: true,
    top: top.out,
    branch: branch.code === 0 ? branch.out : "",
    remote: remote.code === 0 ? remote.out : "",
    slug: remote.code === 0 ? githubSlug(remote.out) : "",
  };
}

/** `git@github.com:acme/app.git` and `https://github.com/acme/app` both read as `acme/app`. */
export function githubSlug(remoteUrl: string): string {
  const url = remoteUrl.trim();
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (https !== null) return `${https[1]}/${https[2]}`;
  return "";
}

// ── the change record (.despia/apps/history/) ───────────────────────────────────────────

export type ChangeRecord = {
  id: string;
  app: string;
  at: string;
  kind: ChangeKind;
  reasons: string[];
  /** the summary a person reads in the panel and in the commit subject */
  title: string;
  documents: string[];
  /** document → the bytes before this change; null means the document did not exist */
  before: { [document: string]: string | null };
  branch: string;
  commit: string;
  pull: string;
  /** "pull_request" · "compare" · "" — a compare link is a person one click from the PR */
  pullKind: "pull_request" | "compare" | "";
  pushed: boolean;
  /** the named degradation when a rung of the ladder could not be reached */
  note: string;
  /** the id of the change that reverted this one */
  revertedBy: string;
  /** the id of the change this one reverted */
  reverts: string;
};

export function historyDir(projectRoot: string): string {
  return join(projectRoot, ".despia", "apps", "history");
}

export function writeChangeRecord(projectRoot: string, record: ChangeRecord): void {
  const dir = historyDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Newest first — ids sort lexically by time because the stamp leads. */
export function readChangeRecords(projectRoot: string, limit = 50): ChangeRecord[] {
  const dir = historyDir(projectRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  const out: ChangeRecord[] = [];
  for (const file of files) {
    if (out.length >= limit) break;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (parsed !== null && typeof parsed === "object") out.push(parsed as ChangeRecord);
    } catch { /* a corrupt record is skipped, never fatal: the rest of the history still reads */ }
  }
  return out;
}

export function readChangeRecord(projectRoot: string, id: string): ChangeRecord | null {
  if (!/^[0-9a-z-]+$/.test(id)) return null;
  const path = join(historyDir(projectRoot), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as ChangeRecord) : null;
  } catch {
    return null;
  }
}

// ── the commit sentence ─────────────────────────────────────────────────────────────────

/** The trailers are the machine half of provenance: `git log --grep` finds every change one
 *  app ever made, and the change id ties the commit back to the record that can revert it. */
export function commitMessage(record: ChangeRecord, appVersion: string): string {
  const subject = `${record.app}: ${record.title}`;
  const body = record.reasons.length > 0 ? `\n${record.reasons.map((r) => `- ${r}`).join("\n")}\n` : "";
  return `${subject}\n${body}\nDespia-App: ${record.app}@${appVersion}\nDespia-Change: ${record.id}\nDespia-Kind: ${record.kind}\n`;
}

export function branchName(record: ChangeRecord): string {
  return `despia/app/${record.app}/${record.id}`;
}

// ── landing ─────────────────────────────────────────────────────────────────────────────

export type LandOpts = {
  root: string;
  policy: VcsPolicy;
  git: GitPort;
  appVersion: string;
  /** opens a pull request when the branch is pushed; absent, the compare link is the answer */
  openPull?: (opts: { slug: string; base: string; head: string; title: string; body: string }) => string;
};

/**
 * Land a classified change set. Returns the record, mutated with everything that actually
 * happened — the caller writes it. Never throws: every rung that cannot be reached becomes a
 * `note` and the change stays applied and revertible.
 */
export function landChange(record: ChangeRecord, opts: LandOpts): ChangeRecord {
  const { root, policy, git } = opts;
  if (!policy.commit) return { ...record, note: "app commits are off in this project's .despia/apps/vcs.json" };
  const facts = gitFacts(git, root, policy);
  if (!facts.repo) {
    return { ...record, note: "no git repository here — the change is applied in place and revertible from the Apps panel" };
  }
  //  Paths are given to git RELATIVE TO THE REPOSITORY ROOT and terminated by `--`, so a
  //  document called `--force` is a path and never an option.
  const paths = record.documents.map((doc) => gitPath(root, facts.top, doc));
  const landed: ChangeRecord = { ...record, branch: facts.branch };

  if (record.kind === "local") {
    const staged = git.run(["add", "--", ...paths], root);
    if (staged.code !== 0) return { ...landed, note: `git add refused: ${firstLine(staged.err)}` };
    const committed = git.run(["commit", "-m", commitMessage(record, opts.appVersion), "--", ...paths], root);
    if (committed.code !== 0) return { ...landed, note: `git commit refused: ${firstLine(committed.err)}` };
    landed.commit = headSha(git, root);
    if (policy.push === "always") pushBranch(git, root, policy, facts, landed);
    return landed;
  }

  //  STRUCTURAL. The branch is cut from where you already are, the app's files are committed
  //  onto it, and the working branch is restored — so the working tree goes back to what it
  //  was and the proposal lives somewhere a person reviews. Other dirty files travel with the
  //  switch untouched, which is exactly why the commit is path-scoped.
  const head = branchName(record);
  const base = facts.branch;
  const cut = git.run(["switch", "-c", head], root);
  if (cut.code !== 0) {
    //  A detached HEAD or an existing branch name: commit in place rather than lose the work,
    //  and say so. Applied-and-named beats refused-and-silent.
    const staged = git.run(["add", "--", ...paths], root);
    if (staged.code !== 0) return { ...landed, note: `git add refused: ${firstLine(staged.err)}` };
    const committed = git.run(["commit", "-m", commitMessage(record, opts.appVersion), "--", ...paths], root);
    if (committed.code !== 0) return { ...landed, note: `git commit refused: ${firstLine(committed.err)}` };
    landed.commit = headSha(git, root);
    landed.note = `could not branch (${firstLine(cut.err)}) — committed in place on ${base || "this checkout"}`;
    return landed;
  }
  landed.branch = head;
  const staged = git.run(["add", "--", ...paths], root);
  const committed = staged.code === 0
    ? git.run(["commit", "-m", commitMessage(record, opts.appVersion), "--", ...paths], root)
    : { code: 1, out: "", err: staged.err };
  if (committed.code !== 0) {
    git.run(["switch", base === "" ? "-" : base], root);
    git.run(["branch", "-D", head], root);
    return { ...landed, branch: base, note: `git commit refused: ${firstLine(committed.err)}` };
  }
  landed.commit = headSha(git, root);
  const back = git.run(["switch", base === "" ? "-" : base], root);
  if (back.code !== 0) {
    landed.note = `left you on ${head}: switching back to ${base} refused (${firstLine(back.err)})`;
  }
  if (policy.push !== "off") {
    pushBranch(git, root, policy, facts, landed, head);
    if (landed.pushed && policy.pullRequests) openPullFor(landed, { ...opts, facts, base, head });
  } else {
    landed.note = landed.note === ""
      ? `proposed on ${head} — pushing is off, so no pull request was opened`
      : landed.note;
  }
  return landed;
}

function openPullFor(
  record: ChangeRecord,
  opts: LandOpts & { facts: GitFacts; base: string; head: string },
): void {
  const title = `${record.app}: ${record.title}`;
  const body = pullBody(record);
  if (opts.openPull !== undefined && opts.facts.slug !== "") {
    const url = opts.openPull({ slug: opts.facts.slug, base: opts.base, head: opts.head, title, body });
    if (url !== "") {
      record.pull = url;
      record.pullKind = "pull_request";
      return;
    }
  }
  if (opts.facts.slug !== "" && opts.base !== "") {
    record.pull = `https://github.com/${opts.facts.slug}/compare/${encodeURIComponent(opts.base)}...${encodeURIComponent(opts.head)}?expand=1`;
    record.pullKind = "compare";
    if (record.note === "") record.note = "no GitHub credential here — the branch is pushed and the link opens the pull request";
  }
}

export function pullBody(record: ChangeRecord): string {
  const why = record.reasons.length > 0 ? record.reasons.map((r) => `- ${r}`).join("\n") : "- a change the app proposed";
  return [
    `The **${record.app}** app proposed this change from the Despia Studio.`,
    "",
    "Why it is a proposal and not a commit on your branch:",
    why,
    "",
    `Documents: ${record.documents.map((d) => `\`${d}\``).join(", ")}`,
    "",
    `Revert it locally with \`despia app revert ${record.id}\`.`,
  ].join("\n");
}

/** `gh` when the person already has it (their auth, not ours), and nothing else: this plane
 *  never asks for a token it could store, and never stores one it was handed. */
export function ghPullOpener(git: GitPort, root: string): LandOpts["openPull"] {
  return ({ base, head, title, body }) => {
    if (!git.has("gh")) return "";
    const ran = spawnSync("gh", ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body], {
      cwd: root, encoding: "utf8",
    });
    if (ran.error !== undefined || (ran.status ?? 1) !== 0) return "";
    const url = /(https:\/\/github\.com\/\S+\/pull\/\d+)/.exec(ran.stdout ?? "");
    return url === null ? "" : url[1]!;
  };
}

function pushBranch(git: GitPort, root: string, policy: VcsPolicy, facts: GitFacts, record: ChangeRecord, head?: string): void {
  if (facts.remote === "") {
    record.note = record.note === "" ? `committed locally — no ${policy.remote} remote to back up to` : record.note;
    return;
  }
  const ref = head ?? facts.branch;
  if (ref === "") return;
  const pushed = git.run(["push", "-u", policy.remote, ref], root);
  if (pushed.code !== 0) {
    record.note = `committed locally — the push to ${policy.remote} was refused (${firstLine(pushed.err)})`;
    return;
  }
  record.pushed = true;
}

function headSha(git: GitPort, root: string): string {
  const sha = git.run(["rev-parse", "HEAD"], root);
  return sha.code === 0 ? sha.out.slice(0, 12) : "";
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).filter((l) => l !== "")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/** A directory as the filesystem itself spells it, so two paths for one directory compare equal.
 *  git always answers with symlinks resolved; a caller's root need not be (on macOS `/var` is a
 *  symlink to `/private/var`, so an unresolved root sent `relative()` climbing out of the repo). */
function realDir(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** A document path is project-relative; git wants it relative to the repository root. */
export function gitPath(projectRoot: string, top: string, document: string): string {
  if (top === "") return document;
  const rel = relative(realDir(top), join(realDir(projectRoot), document));
  return rel.split(sep).join("/");
}

// ── the change plane: bursts in, landed changes out ─────────────────────────────────────

export type AppWrite = {
  app: string;
  appVersion: string;
  document: string;
  /** the bytes before the app touched it; null means the document did not exist */
  before: string | null;
  created: boolean;
  deleted: boolean;
};

export type ChangePlane = {
  /** join a write to the app's open change set, opening one if the burst is new */
  record: (write: AppWrite) => void;
  /** close every open set now and land it; safe to call when nothing is open */
  flush: () => void;
  /** the ids landed since the plane was created, oldest first (the panel reads the files) */
  landed: () => ChangeRecord[];
  /** drop timers without landing — process teardown in tests */
  dispose: () => void;
};

type OpenSet = {
  app: string;
  appVersion: string;
  at: string;
  id: string;
  writes: Map<string, WriteFact & { before: string | null }>;
  timer: ReturnType<typeof setTimeout> | null;
};

export type PlaneOpts = {
  root: string;
  git?: GitPort;
  policy?: VcsPolicy;
  now?: () => number;
  /** how long a burst may stay open. One button press in a panel is one change, not five. */
  idleMs?: number;
  openPull?: LandOpts["openPull"];
  onLanded?: (record: ChangeRecord) => void;
};

export function createChangePlane(opts: PlaneOpts): ChangePlane {
  const git = opts.git ?? realGit;
  const now = opts.now ?? (() => Date.now());
  const idleMs = opts.idleMs ?? 1200;
  const open = new Map<string, OpenSet>();
  const out: ChangeRecord[] = [];
  let counter = 0;

  const close = (app: string): void => {
    const set = open.get(app);
    if (set === undefined) return;
    open.delete(app);
    if (set.timer !== null) clearTimeout(set.timer);
    const writes = [...set.writes.values()];
    if (writes.length === 0) return;
    const policy = opts.policy ?? readPolicy(opts.root);
    const facts = gitFacts(git, opts.root, policy);
    const { kind, reasons } = classifyChange({ writes, branch: facts.branch, policy });
    const record: ChangeRecord = {
      id: set.id,
      app: set.app,
      at: set.at,
      kind,
      reasons,
      title: changeTitle(writes),
      documents: writes.map((w) => w.document),
      before: Object.fromEntries(writes.map((w) => [w.document, w.before])),
      branch: "",
      commit: "",
      pull: "",
      pullKind: "",
      pushed: false,
      note: "",
      revertedBy: "",
      reverts: "",
    };
    const landedRecord = landChange(record, {
      root: opts.root, policy, git, appVersion: set.appVersion,
      openPull: opts.openPull ?? ghPullOpener(git, opts.root),
    });
    writeChangeRecord(opts.root, landedRecord);
    out.push(landedRecord);
    opts.onLanded?.(landedRecord);
  };

  return {
    record(write) {
      let set = open.get(write.app);
      if (set === undefined) {
        counter += 1;
        set = {
          app: write.app,
          appVersion: write.appVersion,
          at: new Date(now()).toISOString(),
          id: changeId(now(), counter, write.app),
          writes: new Map(),
          timer: null,
        };
        open.set(write.app, set);
      }
      set.appVersion = write.appVersion !== "" ? write.appVersion : set.appVersion;
      const existing = set.writes.get(write.document);
      //  The FIRST before-bytes win: two writes to one document inside one burst is still one
      //  change, and reverting it must land on what was there before the burst, not between.
      set.writes.set(write.document, {
        document: write.document,
        created: existing?.created ?? write.created,
        deleted: write.deleted,
        before: existing !== undefined ? existing.before : write.before,
      });
      if (set.timer !== null) clearTimeout(set.timer);
      set.timer = setTimeout(() => close(write.app), idleMs);
      if (typeof set.timer === "object" && set.timer !== null && "unref" in set.timer) set.timer.unref();
    },
    flush() {
      for (const app of [...open.keys()]) close(app);
    },
    landed() {
      return [...out];
    },
    dispose() {
      for (const set of open.values()) if (set.timer !== null) clearTimeout(set.timer);
      open.clear();
    },
  };
}

/** `<base36 stamp>-<counter>-<app>`: sorts by time, unique inside a millisecond, and reads
 *  as itself in a commit trailer and a branch name. The stamp is PADDED because the history
 *  is ordered by filename — unpadded base36 sorts `rs` after `1jk`, which would put an old
 *  change at the top of a person's list. */
export function changeId(at: number, counter: number, app: string): string {
  return `${at.toString(36).padStart(9, "0")}-${counter.toString(36)}-${app.replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
}

export function changeTitle(writes: readonly WriteFact[]): string {
  const created = writes.filter((w) => w.created);
  const deleted = writes.filter((w) => w.deleted);
  if (writes.length === 1) {
    const one = writes[0]!;
    if (one.deleted) return `remove ${one.document}`;
    return `${one.created ? "add" : "edit"} ${one.document}`;
  }
  if (created.length === writes.length) return `add ${writes.length} documents`;
  if (deleted.length === writes.length) return `remove ${writes.length} documents`;
  return `edit ${writes.length} documents`;
}

// ── one plane per project root ──────────────────────────────────────────────────────────

const planes = new Map<string, ChangePlane>();

export function changePlaneFor(root: string, opts: Omit<PlaneOpts, "root"> = {}): ChangePlane {
  const existing = planes.get(root);
  if (existing !== undefined) return existing;
  const plane = createChangePlane({ root, ...opts });
  planes.set(root, plane);
  return plane;
}

/** Close every open burst in this process — `despia app run` before it returns, and the dev
 *  server on the way down. A change that never closed is a commit that never happened. */
export function flushAppChanges(root?: string): void {
  if (root !== undefined) {
    planes.get(root)?.flush();
    return;
  }
  for (const plane of planes.values()) plane.flush();
}

export function resetChangePlanes(): void {
  for (const plane of planes.values()) plane.dispose();
  planes.clear();
}

// ── revert ──────────────────────────────────────────────────────────────────────────────

export type RevertResult =
  | { ok: true; record: ChangeRecord; restored: string[]; removed: string[] }
  | { ok: false; reason: "unknown_change" | "already_reverted" | "write_failed"; message: string };

/**
 * Restore every document a change touched to its pre-change bytes. A document the change
 * CREATED is removed, which is what makes a structural add recoverable. The revert is itself
 * a change — recorded, attributed, and landed by the same ladder — so undoing an app is as
 * legible in the history as the app was.
 */
export function revertChange(root: string, id: string, opts: { git?: GitPort; policy?: VcsPolicy; now?: () => number } = {}): RevertResult {
  const record = readChangeRecord(root, id);
  if (record === null) return { ok: false, reason: "unknown_change", message: `no change ${id} in this project's history` };
  if (record.revertedBy !== "") {
    return { ok: false, reason: "already_reverted", message: `change ${id} was already reverted by ${record.revertedBy}` };
  }
  const now = opts.now ?? (() => Date.now());
  const policy = opts.policy ?? readPolicy(root);
  const git = opts.git ?? realGit;
  const restored: string[] = [];
  const removed: string[] = [];
  const writes: (WriteFact & { before: string | null })[] = [];
  for (const document of record.documents) {
    const abs = join(root, document);
    const before = record.before[document] ?? null;
    const existsNow = existsSync(abs);
    const current = existsNow ? readFileSync(abs, "utf8") : null;
    try {
      if (before === null) {
        if (existsNow) {
          //  Never `rm`: the file is emptied of the app's creation by being moved aside into
          //  the history folder, so a revert of a revert is still bytes on disk.
          const grave = join(historyDir(root), `${record.id}.${document.replace(/[^A-Za-z0-9._-]/g, "_")}`);
          mkdirSync(dirname(grave), { recursive: true });
          renameSync(abs, grave);
          removed.push(document);
        }
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, before);
        restored.push(document);
      }
    } catch (e) {
      return { ok: false, reason: "write_failed", message: e instanceof Error ? e.message : String(e) };
    }
    writes.push({ document, created: false, deleted: before === null, before: current });
  }
  const facts = gitFacts(git, root, policy);
  const { kind, reasons } = classifyChange({ writes, branch: facts.branch, policy });
  const undo: ChangeRecord = {
    id: changeId(now(), 0, `revert${record.app}`),
    app: record.app,
    at: new Date(now()).toISOString(),
    kind,
    reasons,
    title: `revert ${record.title}`,
    documents: writes.map((w) => w.document),
    before: Object.fromEntries(writes.map((w) => [w.document, w.before])),
    branch: "", commit: "", pull: "", pullKind: "", pushed: false, note: "", revertedBy: "", reverts: record.id,
  };
  const landed = landChange(undo, { root, policy, git, appVersion: "", openPull: ghPullOpener(git, root) });
  writeChangeRecord(root, landed);
  writeChangeRecord(root, { ...record, revertedBy: landed.id });
  return { ok: true, record: landed, restored, removed };
}
