//
//  The automation fold (studio-apps.md §7.2): a granted app's `automation` rows compile
//  INTO THE INSTALLING USER'S OWN server artifact — the custody law's answer to "where do
//  automations run". The app vendor runs no infrastructure; Despia executes nothing; the
//  event plane only ever delivers signed doorbells the person consented to.
//
//  The fold is fail-open per row (Article 7): a row that cannot land — consent missing,
//  a document that will not read, egress beyond the grant — becomes a NAMED refusal and
//  the build continues, because "your backend did not deploy" is never the right price
//  for "one app's automation is misconfigured". The narrowing is fail-closed per law: an
//  automation document contributes actions, secrets and egress and NOTHING else — routes,
//  entities, tools and budget rows belong to the project's own server documents, so an
//  app can never widen the deployment's surface or raise its spend ceilings.
//

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, packageRoots } from "../config.ts";
import { lockedModuleDirs } from "../registry-commands.ts";
import { readServerDocument, ServerDocumentError, type ServerDoc } from "../server-document.ts";
import { manifestGrants } from "./manifest.ts";
import { readVerifiedApprovals } from "./approval.ts";
import { discoverApps, readAppState, resolveFirstPartyApps, type AppState, type DiscoveredApp } from "./host.ts";

export type AppAutomation = {
  /** the app's scheme */
  app: string;
  /** the contribution row's id */
  contribution: string;
  /** the event kind this automation binds (editor or platform plane) */
  on: string;
  /** the namespaced handler chain in the emitted barrel (`app_<scheme>`) */
  chain: string;
  /** the action inside the app's server document */
  action: string;
  /** draft prepares and notifies; auto requires the consented automation:auto grant */
  mode: "draft" | "auto";
};

export type AppAutomationRefusal = { app: string; contribution: string; reason: string };

export type AppAutomationFold = {
  /** the apps' server documents, chains namespaced `app_<scheme>`, one per (app, file) */
  docs: ServerDoc[];
  automations: AppAutomation[];
  refusals: AppAutomationRefusal[];
};

export const RUN = /^([A-Za-z0-9_/.-]+\.dsx)#([a-zA-Z_][a-zA-Z0-9_]*)$/;

export function appChain(scheme: string): string {
  return `app_${scheme.replaceAll("-", "_")}`;
}

/** Read one app-owned `<server>`-grammar document, NARROWED (studio-apps.md §7.2): actions,
 *  secrets and egress only — and both of the latter inside the granted set. One reader for
 *  the automation fold and the headless tool runner, because two would drift. */
export function readNarrowedAppDoc(
  appDir: string, file: string, chain: string, rel: string, granted: ReadonlySet<string>,
): { doc: ServerDoc } | { refusal: string } {
  const abs = join(appDir, file);
  if (!existsSync(abs)) return { refusal: `run names ${file} which does not exist in the app package` };
  let doc: ServerDoc;
  try {
    doc = readServerDocument(readFileSync(abs, "utf8"), rel, chain, { reachedByEvents: true });
  } catch (e) {
    return { refusal: e instanceof ServerDocumentError ? e.message : String(e) };
  }
  const contraband: string[] = [];
  if (Object.keys(doc.api).length > 0) contraband.push("routes");
  if (Object.keys(doc.schema).length > 0) contraband.push("entities");
  if (Object.keys(doc.mcp).length > 0) contraband.push("tools");
  if (doc.budgets.length > 0) contraband.push("budget rows");
  if (contraband.length > 0) {
    return { refusal: `an app's document contributes actions, secrets and egress only — its ${contraband.join(", ")} belong to the project's own server documents` };
  }
  const ungrantedEgress = doc.egress.filter((h) => !granted.has(`net:${h}`));
  if (ungrantedEgress.length > 0) {
    return { refusal: `the document declares egress to ${ungrantedEgress.join(", ")} beyond the granted net: hosts` };
  }
  const ungrantedSecrets = doc.secrets.filter((s) => !granted.has(`secret:${s}`));
  if (ungrantedSecrets.length > 0) {
    return { refusal: `the document reads secret(s) ${ungrantedSecrets.join(", ")} beyond the granted secret: names` };
  }
  return { doc };
}

/** The holds every headless consumer applies before an app's code runs (the fold's rules,
 *  shared): missing, disabled, the shelf tier's verified-approval requirement, and the
 *  widened-manifest re-consent. `approvals` is scheme → the approved version
 *  (readVerifiedApprovals) — only installed apps consult it; dev and builtin trees are
 *  their own review. */
export function appHold(
  app: DiscoveredApp, state: AppState, approvals?: Readonly<Record<string, string>>,
): string | null {
  const record = state[app.info.scheme];
  if (record?.enabled !== true) return "the app is disabled — enable it in the Studio's Apps panel";
  if (app.kind === "installed") {
    const approved = approvals?.[app.info.scheme];
    if (approved === undefined) {
      return "no verified approval for this app — the apps shelf signs (coordinate, version, treeHash, grants); dev mode runs a working tree instead";
    }
    if (approved !== app.info.version) {
      return `the approval covers ${approved}, the pin is ${app.info.version} — update or re-submit`;
    }
  }
  const granted = new Set(record.grants ?? []);
  const widened = manifestGrants(app.info).filter((g) => !granted.has(g));
  if (widened.length > 0) return `the manifest now asks for ${widened.join(", ")} — re-consent in the Apps panel first`;
  return null;
}

/** Every granted automation in this project, read and narrowed, ready for the server emit. */
export function collectAppAutomations(projectRoot: string): AppAutomationFold {
  let lockedDirs: Array<{ id: string; dir: string }> = [];
  try {
    lockedDirs = lockedModuleDirs(projectRoot);
  } catch {
    // an unmaterializable pin is `despia add`'s report to give — the fold sees fewer apps
  }
  let packageDirs: readonly string[];
  try {
    packageDirs = packageRoots(loadConfig(projectRoot));
  } catch {
    packageDirs = [projectRoot];
  }
  const builtinDirs = resolveFirstPartyApps(projectRoot);
  const apps = discoverApps({
    projectRoot, packageDirs, lockedDirs,
    ...(builtinDirs.length > 0 ? { builtinDirs } : {}),
  });
  //  THE BUILD DOES NOT SEED CONSENT. Seeding is the Studio's act - a person opening the Apps
  //  panel - and a build that seeded it would compile an app's automations into someone's
  //  deployment because a framework tree happened to sit above their project. An app with no
  //  RECORDED row contributes nothing here, which is the same sentence the seam enforces.
  const state = readAppState(projectRoot);
  return foldAutomations(apps, state, readVerifiedApprovals(projectRoot, apps).approvals);
}

/** The pure half: discovered apps + the consent state (+ the verified-approval map for the
 *  shelf tier) → the fold. Filesystem reads stay (each app's own documents); discovery,
 *  state seeding and approval verification are the caller's. */
export function foldAutomations(
  apps: readonly DiscoveredApp[], state: AppState, approvals?: Readonly<Record<string, string>>,
): AppAutomationFold {
  const out: AppAutomationFold = { docs: [], automations: [], refusals: [] };

  for (const app of apps) {
    const rows = app.info.contributions.filter((c) => c.slot === "automation");
    if (rows.length === 0) continue;
    const scheme = app.info.scheme;
    const record = state[scheme];
    const granted = new Set(record?.grants ?? []);
    const refuse = (contribution: string, reason: string): void => {
      out.refusals.push({ app: scheme, contribution, reason });
    };
    const hold = appHold(app, state, approvals);
    if (hold !== null) {
      for (const row of rows) refuse(row.id, hold);
      continue;
    }
    // Re-consent law: an automation deploys only what the manifest asked AND the person
    // granted; the widened-manifest hold above already covers a manifest that grew.
    if (!granted.has("automation:deploy")) {
      for (const row of rows) refuse(row.id, "automation:deploy is not granted — allow it in the Studio's Apps panel");
      continue;
    }

    const chain = appChain(scheme);
    const docsByFile = new Map<string, ServerDoc>();
    for (const row of rows) {
      const run = row.run ?? "";
      const match = RUN.exec(run);
      if (match === null || run.includes("..") || run.startsWith("/")) {
        refuse(row.id, `run ${JSON.stringify(run)} is not a package-relative \`Doc.dsx#action\``);
        continue;
      }
      const [, file, action] = match;
      let doc = docsByFile.get(file!);
      if (doc === undefined) {
        const read = readNarrowedAppDoc(app.dir, file!, chain, `${scheme}/${file}`, granted);
        if ("refusal" in read) {
          refuse(row.id, read.refusal);
          continue;
        }
        doc = read.doc;
        docsByFile.set(file!, doc);
      }
      if (!Object.hasOwn(doc.actions, action!)) {
        refuse(row.id, `run names action "${action}" which ${scheme}/${file} does not declare`);
        continue;
      }
      // draft is the floor ("draft, never auto-publish"): auto runs only under the
      // CONSENTED automation:auto grant — a declared-but-unconsented auto clamps, loudly
      let mode: "draft" | "auto" = row.mode === "auto" ? "auto" : "draft";
      if (mode === "auto" && !granted.has("automation:auto")) {
        refuse(row.id, "mode=auto requires the automation:auto grant — running as draft until it is allowed");
        mode = "draft";
      }
      out.automations.push({ app: scheme, contribution: row.id, on: row.on ?? "", chain, action: action!, mode });
    }
    for (const doc of docsByFile.values()) out.docs.push(doc);
  }

  out.automations.sort((a, b) => (a.app + a.contribution).localeCompare(b.app + b.contribution));
  out.docs.sort((a, b) => a.chain.localeCompare(b.chain));
  return out;
}
