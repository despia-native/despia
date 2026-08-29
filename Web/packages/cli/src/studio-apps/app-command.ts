//
//  `despia app` — the READ face of the app plane (studio-apps.md §9): what is discovered,
//  what each app asked for versus what this project granted, whether every installed pin
//  still verifies, and WHAT EVERY APP DID TO THIS PROJECT. Install stays `despia add` (one
//  verb, one meaning — registry Q6) and consent stays the Studio's Apps panel, the one place
//  the grant dialog renders what the seam enforces.
//
//  `history` and `revert` are the headless half of the change plane (studio-apps.md §14):
//  the same records the panel renders, and the same restore the panel's Revert performs. An
//  agent that ran a tool through MCP can undo it from here without a browser.
//

import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { requireProjectRoot } from "../registry-commands.ts";
import { lockedModuleDirs } from "../registry-commands.ts";
import { treeHash } from "../registry-resolve.ts";
import { commandReview } from "../review.ts";
import { packageRoots } from "../config.ts";
import { loadConfig } from "../config.ts";
import { resolveDsxEditor } from "../edit.ts";
import { discoverApps, readAppState, resolveFirstPartyApps, resolveStudioApps, seedState } from "./host.ts";
import { listAppTools, runAppTool } from "./headless.ts";
import { readVerifiedApprovals } from "./approval.ts";
import { manifestGrants, readAppManifest } from "./manifest.ts";
import { readChangeRecords, readPolicy, revertChange } from "./vcs.ts";

type Io = { out: (line: string) => void; err: (line: string) => void };
type Flags = { [name: string]: string | boolean };

export async function commandApp(flags: Flags, positional: string[], io: Io): Promise<number> {
  const verb = positional[0] ?? "list";
  const VERBS = ["list", "grants", "verify", "tools", "run", "history", "revert"];
  if (!VERBS.includes(verb)) {
    io.err(`despia app: unknown verb '${verb}' — list | grants [scheme] | verify | tools [scheme] | run <scheme> <tool> | history [scheme] | revert <change>`);
    return 1;
  }
  const project = requireProjectRoot(flags);

  // ── the change plane's headless half (studio-apps.md §14) ──
  if (verb === "history") {
    const only = positional[1];
    const rows = readChangeRecords(project.root, 200).filter((r) => only === undefined || r.app === only);
    if (rows.length === 0) {
      io.out(only === undefined ? "no app has changed this project yet" : `app "${only}" has not changed this project`);
      return 0;
    }
    const policy = readPolicy(project.root);
    io.out(`commit: ${policy.commit ? "on" : "off"} · push: ${policy.push} · pull requests: ${policy.pullRequests ? "on" : "off"} · protected: ${policy.protected.join(", ")}`);
    io.out("");
    for (const r of rows) {
      const mark = r.revertedBy !== "" ? "reverted" : r.kind === "structural" ? "proposed" : "committed";
      io.out(`${r.id}  ${r.app.padEnd(12)} ${mark.padEnd(9)} ${r.title}`);
      const bits = [
        r.commit !== "" ? `commit ${r.commit}` : "",
        r.branch !== "" && r.kind === "structural" ? `branch ${r.branch}` : "",
        r.pushed ? "pushed" : "",
        r.pull !== "" ? r.pull : "",
        r.note !== "" ? r.note : "",
      ].filter((b) => b !== "");
      if (bits.length > 0) io.out(`${"".padEnd(14)}${bits.join(" · ")}`);
      for (const reason of r.reasons) io.out(`${"".padEnd(14)}${reason}`);
    }
    io.out("");
    io.out("despia app revert <change>  restores the documents a change touched");
    return 0;
  }
  if (verb === "revert") {
    const id = positional[1] ?? "";
    if (id === "") {
      io.err("despia app revert <change> — despia app history lists the change ids");
      return 1;
    }
    const result = revertChange(project.root, id);
    if (!result.ok) {
      io.err(`despia app revert: ${result.reason} — ${result.message}`);
      return 1;
    }
    for (const doc of result.restored) io.out(`restored ${doc}`);
    for (const doc of result.removed) io.out(`removed  ${doc} (the app had created it)`);
    if (result.record.commit !== "") io.out(`commit   ${result.record.commit}`);
    if (result.record.note !== "") io.out(`note     ${result.record.note}`);
    return 0;
  }

  // ── the programmatic surface (studio-apps.md §9): an interface is ONE consumer ──
  if (verb === "tools") {
    const only = positional[1];
    const rows = listAppTools(project.root).filter((t) => only === undefined || t.app === only);
    if (rows.length === 0) {
      io.out(only === undefined ? "no app tools in this project — a tool is a facets.apps row with slot \"tool\""
        : `app "${only}" exposes no tools`);
      return 0;
    }
    for (const t of rows) {
      const call = `despia app run ${t.app} ${t.name}`;
      io.out(`${t.app.padEnd(14)} ${t.name.padEnd(18)} ${t.hold !== null ? `HELD — ${t.hold}` : call}${t.inputs.length > 0 ? `  (args: ${t.inputs.join(", ")})` : ""}`);
      io.out(`${"".padEnd(14)} ${t.description}`);
    }
    return 0;
  }
  if (verb === "run") {
    const scheme = positional[1] ?? "";
    const tool = positional[2] ?? "";
    if (scheme === "" || tool === "") {
      io.err("despia app run <scheme> <tool> [--args '{\"key\": …}'] — despia app tools lists what is runnable");
      return 1;
    }
    let args: Record<string, unknown> = {};
    const raw = typeof flags["args"] === "string" ? flags["args"] : "";
    if (raw !== "") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        io.err("despia app run: --args is a JSON object, e.g. --args '{\"release\": {\"version\": \"1.2.0\"}}'");
        return 1;
      }
    }
    const result = await runAppTool(project.root, scheme, tool, args, io);
    if (!result.ok) {
      io.err(`despia app run: ${result.reason} — ${result.message}`);
      return 1;
    }
    io.out(JSON.stringify(result.value, null, 2));
    return 0;
  }

  // verify FIRST materializes each pin (the tree-hash re-check), so a corrupt cache is a
  // named row here rather than a throw that hides the healthy ones
  let lockedDirs: Array<{ id: string; dir: string }> = [];
  const corrupt: string[] = [];
  try {
    lockedDirs = lockedModuleDirs(project.root);
  } catch (e) {
    corrupt.push(e instanceof Error ? e.message : String(e));
  }
  const editorDir = resolveDsxEditor(project.root);
  const builtinDirs = [...(editorDir !== null ? [editorDir] : []), ...resolveFirstPartyApps(project.root)];
  const apps = discoverApps({
    projectRoot: project.root,
    packageDirs: packageRoots(loadConfig(project.root)),
    lockedDirs,
    ...(builtinDirs.length > 0 ? { builtinDirs } : {}),
  });
  const seeded = seedState(apps, readAppState(project.root));

  if (verb === "list") {
    const { table, refusals } = resolveStudioApps(apps, seeded.state, { approvals: readVerifiedApprovals(project.root, apps).approvals });
    const mountedBy = new Map<string, number>();
    for (const rows of Object.values(table)) {
      for (const row of rows) mountedBy.set(row.app, (mountedBy.get(row.app) ?? 0) + 1);
    }
    if (apps.length === 0) { io.out("no apps discovered — a package with facets.apps rows is an app"); return 0; }
    for (const app of apps) {
      const row = seeded.state[app.info.scheme];
      const refusal = refusals.find((r) => r.app === app.info.scheme);
      const state = refusal !== undefined ? `HELD — ${refusal.reason}`
        : row?.enabled === true ? `enabled, ${mountedBy.get(app.info.scheme) ?? 0} mounted` : "disabled";
      io.out(`${app.info.scheme.padEnd(16)} ${app.info.version.padEnd(9)} ${app.kind.padEnd(10)} ${state}`);
    }
    io.out(`${apps.length} app(s)`);
    return 0;
  }

  if (verb === "grants") {
    const only = positional[1];
    const chosen = only === undefined ? apps : apps.filter((a) => a.info.scheme === only);
    if (chosen.length === 0) { io.err(`despia app grants: no app "${only ?? ""}" in this project`); return 1; }
    for (const app of chosen) {
      const asked = manifestGrants(app.info);
      const row = seeded.state[app.info.scheme];
      const held = new Set(row?.grants ?? []);
      io.out(`${app.info.scheme} ${app.info.version} (${app.kind})${row?.grantedAt !== undefined && row.grantedAt !== "" ? ` — consented ${row.grantedAt}` : ""}`);
      if (asked.length === 0) { io.out("  asks for no permissions"); continue; }
      for (const grant of asked) {
        io.out(`  ${held.has(grant) ? "granted" : "ASKED  "} ${grant}`);
      }
    }
    return 0;
  }

  // verify: every installed pin re-hashed (materialize above), plus the approval chain —
  // signature, coordinate, version, treeHash-vs-pin, grant coverage (studio-apps.md §11)
  let bad = corrupt.length;
  for (const line of corrupt) io.out(`CORRUPT   ${line}`);
  const shelf = readVerifiedApprovals(project.root, apps);
  for (const app of apps) {
    const scheme = app.info.scheme;
    if (app.kind !== "installed") {
      io.out(`ok        ${scheme.padEnd(16)} ${app.kind} — ${app.kind === "dev" ? "working tree, verified by you" : "ships with the toolchain"}`);
      continue;
    }
    const problem = shelf.problems.find((p) => p.app === scheme);
    if (problem !== undefined) {
      bad += 1;
      io.out(`HELD      ${scheme.padEnd(16)} ${app.lockId} — tree hash verified against dsx.lock.json; approval broken: ${problem.reason}`);
      continue;
    }
    if (shelf.approvals[scheme] !== undefined) {
      io.out(`ok        ${scheme.padEnd(16)} ${app.lockId} — tree hash verified; approval verified for ${shelf.approvals[scheme]}`);
    } else {
      bad += 1;
      io.out(`HELD      ${scheme.padEnd(16)} ${app.lockId} — tree hash verified; NO approval record (.despia/apps/approvals/${scheme}.json) — the Studio and headless faces refuse to run it`);
    }
  }
  if (apps.length === 0 && corrupt.length === 0) io.out("nothing to verify — no apps discovered");
  return bad > 0 ? 1 : 0;
}

/**
 * `despia submit` — the exact pull-request recipe for the apps shelf (studio-apps.md §11,
 * CONTRIBUTING-APPS.md). Validates the package as an app, runs the app lint tier, computes
 * the tree hash, and prints the apps.json row VERBATIM — nothing here talks to the network
 * or to GitHub: submission is a pull request a human opens and a human merges.
 */
export function commandSubmit(flags: Flags, _positional: string[], io: Io): number {
  const cwd = process.cwd();
  const root = typeof flags["project"] === "string" ? resolvePath(cwd, flags["project"]) : cwd;
  if (!existsSync(join(root, "dsx.json"))) {
    io.err(`despia submit: ${root} has no dsx.json — point --project at the app package.`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(join(root, "dsx.json"), "utf8")) as Record<string, unknown>;
  const { info, issues } = readAppManifest(manifest);
  if (info === null && issues.length === 0) {
    io.err("despia submit: this package declares no facets.apps rows — it is a package, and packages need no submission (despia add works today).");
    return 1;
  }
  if (info === null || issues.length > 0) {
    io.err("despia submit: the manifest does not validate as an app:");
    for (const issue of issues) io.err(`  ${issue.code} at ${issue.path}: ${issue.message}`);
    return 1;
  }
  const lintLines: string[] = [];
  const lintCode = commandReview({ app: true, strict: true, project: root }, [], { out: (l) => lintLines.push(l), err: (l) => lintLines.push(l) });
  if (lintCode !== 0) {
    for (const line of lintLines) io.out(line);
    io.err("despia submit: `despia review --app --strict` must be clean before a submission — the shelf runs the same gate.");
    return 1;
  }
  const hash = treeHash(root);
  const coordinate = typeof flags["coordinate"] === "string" ? flags["coordinate"] : "github:<owner>/<repo>";
  const grants = manifestGrants(info);
  const row = {
    coordinate,
    version: info.version,
    treeHash: hash,
    scheme: info.scheme,
    name: info.name,
    summary: info.summary,
    grants,
    contributions: info.contributions.map((c) => ({ id: c.id, slot: c.slot, ...(c.title !== undefined ? { title: c.title } : {}) })),
    approval: `approvals/${coordinate.replace(/^github:/, "")}/${info.version}.json`,
    reviewedAt: "<set by the merge>",
  };
  io.out(`despia submit — "${info.name}" (${info.scheme}) ${info.version} is submission-ready.`);
  io.out("");
  io.out("1. Tag this exact tree in your repository:");
  io.out(`     git tag ${info.version} && git push origin ${info.version}`);
  io.out("2. Fork despia-native/registry and add this row to apps.json:");
  io.out("");
  for (const line of JSON.stringify(row, null, 2).split("\n")) io.out(`   ${line}`);
  io.out("");
  io.out("3. Open the pull request. The submission workflow re-hashes your tag against the row,");
  io.out("   validates the manifest, and runs `despia review --app --strict` — your code is");
  io.out("   compiled and linted, never executed. A capability disclosure is posted for the");
  io.out("   reviewer; a human decides (CONTRIBUTING-APPS.md).");
  io.out("4. After approval the owner signs (coordinate, version, treeHash, grants) offline and");
  io.out("   the merge lands your row and the approval file together.");
  return 0;
}
