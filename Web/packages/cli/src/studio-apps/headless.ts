//
//  headless.ts — AN INTERFACE IS ONE CONSUMER OF AN APP (studio-apps.md §9).
//
//  The Studio mounts an app's surfaces; this file is the SAME app invoked with no surface
//  at all: `despia app run <scheme> <tool>` and the MCP face both land here, and what runs
//  is the SAME action body, under the SAME consented grants, through the SAME doors. Three
//  facts keep that sentence true rather than aspirational:
//
//    1. THE DOORS ARE THE EDIT MOUNT'S OWN. `createEditMount` is invoked in-process and
//       driven through a synthetic request — no listening socket, and no second
//       implementation of document containment, revision checks, storage namespacing or
//       the provenance ledger. A headless edit lands in `.despia/apps/activity.log` with
//       the same `app:<scheme>` byline a mounted one does.
//    2. THE FUNNEL IS THE SAME SEAM TABLE. `routeChain` below is the corpus-gated twin of
//       the module-owned web funnel (Core/Apps/web/scope.js) — both run against
//       OpenSource/Conformance/studio-apps/scope.json, so the CLI cannot quietly admit a
//       chain the Studio refuses or vice versa. (The web file cannot be imported here: its
//       bare `@despia-native/kernel` specifier resolves through a page's import map, not node.)
//    3. THE RUNNER IS THE KERNEL. The body executes on ActionRunner with the app-plane
//       budgets — the declared-handler recipe from @despia-native/server/actions, bound to the
//       studio residence instead of the server one.
//
//  What a headless run does NOT have is stated, never faked: no selection (reads null),
//  no toast surface (the line goes to stdout, stamped), no editor-session event lane
//  (a CLI invocation IS one entry), and no secret store (secrets are deploy-side).
//

import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { ActionRunner, isNSNull, makeRunEnv, ModuleCallError, ReactiveStore, type Dict } from "@despia-native/kernel";

import { loadConfig, packageRoots } from "../config.ts";
import { lockedModuleDirs } from "../registry-commands.ts";
import { createEditMount, mintAdmission, resolveDsxEditor, type EditorAssets } from "../edit.ts";
import { APP_BUDGETS, manifestGrants } from "./manifest.ts";
import { appChain, appHold, readNarrowedAppDoc, RUN } from "./automations.ts";
import { readVerifiedApprovals } from "./approval.ts";
import { discoverApps, readAppState, resolveFirstPartyApps, seedState, type DiscoveredApp } from "./host.ts";
import { flushAppChanges } from "./vcs.ts";

// ── the seam table (the corpus-gated twin of Core/Apps/web/scope.js) ────────────────────

export type ChainVerdict = Record<string, unknown>;

export function routeChain(chain: string, grants: Set<string>, args: Record<string, unknown> = {}): ChainVerdict {
  const parts = chain.split(".");
  const head = parts[0] ?? "";
  const verb = parts[parts.length - 1] ?? "";
  const need = (grant: string): ChainVerdict | null => (grants.has(grant) ? null : { verdict: "forbidden", grant });

  if (head === "studio" && parts.length === 3) {
    const area = parts[1];
    if (area === "project") {
      if (verb === "list") return need("project:read") ?? { verdict: "door", method: "GET", path: "/edit/api/documents", grant: "project:read" };
      if (verb === "read") {
        const name = typeof args["name"] === "string" ? args["name"] : "";
        if (name === "") return { verdict: "unknown_action", message: "studio.project.read needs `name` (a document path)" };
        return need("project:read") ?? { verdict: "door", method: "GET", path: `/edit/api/documents/${encodeURIComponent(name)}`, grant: "project:read" };
      }
      if (verb === "tree") {
        const name = typeof args["name"] === "string" ? args["name"] : "";
        if (name === "") return { verdict: "unknown_action", message: "studio.project.tree needs `name` (the document to read)" };
        return need("project:read") ?? { verdict: "door", method: "GET", path: `/edit/api/tree/${encodeURIComponent(name)}`, grant: "project:read" };
      }
      if (verb === "edit") {
        const name = typeof args["name"] === "string" ? args["name"] : "";
        if (name === "") return { verdict: "unknown_action", message: "studio.project.edit needs `name` (the document to splice)" };
        return need("project:write") ?? { verdict: "door", method: "POST", path: `/edit/api/edit/${encodeURIComponent(name)}`, grant: "project:write" };
      }
      if (verb === "create") {
        const name = typeof args["name"] === "string" ? args["name"] : "";
        const source = typeof args["source"] === "string" ? args["source"] : "";
        if (name === "") return { verdict: "unknown_action", message: "studio.project.create needs `name` (the document to add)" };
        if (source === "") return { verdict: "unknown_action", message: "studio.project.create needs `source` (the document body)" };
        return need("project:write") ?? {
          verdict: "door", method: "PUT", path: `/edit/api/documents/${encodeURIComponent(name)}`,
          grant: "project:write", text: true,
        };
      }
      return { verdict: "unknown_action", message: `studio.project has no action "${verb}"` };
    }
    if (area === "catalog") {
      if (verb === "elements" || verb === "styles" || verb === "graph") {
        return need("project:read") ?? { verdict: "door", method: "GET", path: `/edit/api/${verb}`, grant: "project:read" };
      }
      return { verdict: "unknown_action", message: `studio.catalog has no action "${verb}"` };
    }
    if (area === "selection" && verb === "get") {
      return need("selection:read") ?? { verdict: "local", seam: "selection", grant: "selection:read" };
    }
    if (area === "ui" && verb === "toast") {
      return { verdict: "local", seam: "toast", grant: null };
    }
    return { verdict: "unknown_action", message: `studio has no area "${area}"` };
  }

  if (head === "app" && parts.length === 3 && parts[1] === "storage") {
    if (verb === "get" || verb === "set" || verb === "remove" || verb === "list") {
      return { verdict: "storage", op: verb };
    }
    return { verdict: "unknown_action", message: `app.storage has no action "${verb}"` };
  }

  return { verdict: "unsupported", message: `a Studio app may not call "${chain}" — the studio residence seam list is closed (studio-api-v1.json)` };
}

/** HTTPS only, granted hosts only, suffix-matched — the server residence's rule verbatim. */
export function egressGate(hosts: readonly string[]): (url: string) => boolean {
  const allowed = hosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
  if (allowed.length === 0) return () => false;
  return (url) => {
    let host: string | null = null;
    try {
      const parsed = new URL(url);
      host = parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
    } catch { host = null; }
    if (host === null) return false;
    return allowed.some((allow) => host === allow || host.endsWith(`.${allow}`));
  };
}

type Door = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** The bound funnel — appScope's twin, throwing the kernel's own ModuleCallError so the
 *  runner's instanceof settle sees the identical class it sees under a mounted surface. */
export function headlessScope(opts: {
  scheme: string;
  grants: Set<string>;
  door: Door;
  storage: { read: () => Record<string, unknown>; write: (v: Record<string, unknown>) => void };
  toast?: (text: string) => void;
}): (chain: string, args: Dict) => Promise<unknown> {
  return async (chain, args) => {
    const routed = routeChain(chain, opts.grants, (args ?? {}) as Record<string, unknown>);
    switch (routed["verdict"]) {
      case "forbidden":
        throw new ModuleCallError("forbidden", `app "${opts.scheme}" does not hold the ${String(routed["grant"])} grant — declare it in facets.apps and reinstall`);
      case "unknown_action":
        throw new ModuleCallError("unknown_action", String(routed["message"]));
      case "unsupported":
        throw new ModuleCallError("unsupported", String(routed["message"]));
      case "local": {
        if (routed["seam"] === "selection") return null; // headless has no selection — typed absence
        const text = typeof (args as Record<string, unknown>)?.["text"] === "string" ? String((args as Record<string, unknown>)["text"]) : "";
        if (text === "") throw new ModuleCallError("bad_request", "studio.ui.toast needs `text`");
        opts.toast?.(text);
        return null;
      }
      case "storage": {
        const store = opts.storage.read();
        const record = (args ?? {}) as Record<string, unknown>;
        const key = typeof record["key"] === "string" ? record["key"] : "";
        if (routed["op"] === "list") return Object.keys(store).sort();
        if (key === "") throw new ModuleCallError("bad_request", `app.storage.${String(routed["op"])} needs \`key\``);
        if (routed["op"] === "get") return Object.hasOwn(store, key) ? store[key] : null;
        if (routed["op"] === "remove") {
          if (Object.hasOwn(store, key)) { delete store[key]; opts.storage.write(store); }
          return null;
        }
        store[key] = record["value"] ?? null;
        opts.storage.write(store);
        return null;
      }
      case "door": {
        const record = (args ?? {}) as Record<string, unknown>;
        const body = routed["text"] === true
          ? (typeof record["source"] === "string" ? record["source"] : "")
          : routed["method"] === "POST"
            ? {
              ...(record["edits"] !== undefined ? { edits: record["edits"] } : {}),
              ...(typeof record["rev"] === "string" ? { rev: record["rev"] } : {}),
            }
            : undefined;
        const res = await opts.door(String(routed["method"]), String(routed["path"]), body);
        if (res.status >= 200 && res.status < 300) return res.body;
        const answer = res.body !== null && typeof res.body === "object" ? res.body as Record<string, unknown> : {};
        const reason = answer["reason"];
        const message = answer["message"];
        const code = reason === "stale_revision" || reason === "refused_edit" ? "conflict"
          : reason === "unknown_document" ? "not_found"
          : res.status === 401 ? "forbidden" : "failed";
        throw new ModuleCallError(code, typeof message === "string" ? message : `the ${String(routed["path"])} door answered ${res.status}`);
      }
      default:
        throw new ModuleCallError("failed", "unreachable verdict");
    }
  };
}

// ── the in-process door: the edit mount driven with no socket ───────────────────────────

/** Fabricated EditorAssets: the api routes this door reaches never touch asset paths, and
 *  building the real editor page for a CLI invocation would cost seconds for nothing. */
const HEADLESS_ASSETS: EditorAssets = { sdk: "", element: "", packageDir: "" };

export function localMountDoor(projectRoot: string, scheme: string, io?: { out: (l: string) => void }): { door: Door; close: () => void } {
  const config = loadConfig(projectRoot);
  const admission = mintAdmission();
  const mount = createEditMount(config, HEADLESS_ASSETS, () => "", admission);
  const door: Door = async (method, path, body) => {
    //  A STRING body is a document (studio.project.create), not a JSON payload — the same
    //  distinction the mounted door makes, because it reaches the same endpoint.
    const isText = typeof body === "string";
    const payload = body === undefined ? null : Buffer.from(isText ? (body as string) : JSON.stringify(body));
    const req = Readable.from(payload === null ? [] : [payload]) as unknown as IncomingMessage;
    req.method = method;
    req.url = path;
    req.headers = {
      "x-despia-edit": admission,
      "x-despia-app": scheme,
      ...(payload !== null ? { "content-type": isText ? "text/plain; charset=utf-8" : "application/json" } : {}),
    };
    let status = 0;
    const chunks: Buffer[] = [];
    const res = {
      setHeader: () => res,
      getHeader: () => undefined,
      writeHead: (code: number) => { status = code; return res; },
      write: (chunk: unknown) => { chunks.push(Buffer.from(chunk as string)); return true; },
      end: (chunk?: unknown) => { if (chunk !== undefined) chunks.push(Buffer.from(chunk as string)); },
      on: () => res,
    } as unknown as ServerResponse;
    const answered = await mount(req, res);
    if (!answered) return { status: 404, body: { reason: "not_found", message: `${path} is outside the edit mount` } };
    const text = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown = null;
    try { parsed = text === "" ? null : JSON.parse(text); } catch { parsed = text; }
    return { status: status === 0 ? 200 : status, body: parsed };
  };
  void io;
  return { door, close: () => {} };
}

// ── the tool surface ────────────────────────────────────────────────────────────────────

export type AppToolRow = {
  app: string;
  name: string;
  title: string;
  description: string;
  /** the run pointer, `Doc.dsx#action` */
  run: string;
  /** the action's declared input names — the CLI/MCP argument surface */
  inputs: string[];
  /** a hold that keeps this tool from running right now (disabled, re-consent), or null */
  hold: string | null;
};

export function discoverProjectApps(projectRoot: string): {
  apps: DiscoveredApp[];
  state: ReturnType<typeof seedState>["state"];
  approvals: Record<string, string>;
} {
  let lockedDirs: Array<{ id: string; dir: string }> = [];
  try { lockedDirs = lockedModuleDirs(projectRoot); } catch { /* despia add reports pins */ }
  let packageDirs: readonly string[];
  try { packageDirs = packageRoots(loadConfig(projectRoot)); } catch { packageDirs = [projectRoot]; }
  const editorDir = resolveDsxEditor(projectRoot);
  const builtinDirs = [...(editorDir !== null ? [editorDir] : []), ...resolveFirstPartyApps(projectRoot)];
  const apps = discoverApps({
    projectRoot, packageDirs, lockedDirs,
    ...(builtinDirs.length > 0 ? { builtinDirs } : {}),
  });
  return {
    apps,
    state: seedState(apps, readAppState(projectRoot)).state,
    approvals: readVerifiedApprovals(projectRoot, apps).approvals,
  };
}

/** Every installed app's tool rows, resolved to their input names — the surface the CLI
 *  lists and the MCP face projects. A held tool is LISTED with its hold named, because a
 *  tool that silently vanishes when disabled reads as a broken toolchain. */
export function listAppTools(projectRoot: string): AppToolRow[] {
  const { apps, state, approvals } = discoverProjectApps(projectRoot);
  const out: AppToolRow[] = [];
  for (const app of apps) {
    const rows = app.info.contributions.filter((c) => c.slot === "tool");
    if (rows.length === 0) continue;
    const hold = appHold(app, state, approvals);
    const granted = new Set(state[app.info.scheme]?.grants ?? []);
    for (const row of rows) {
      const run = row.run ?? "";
      const match = RUN.exec(run);
      let inputs: string[] = [];
      if (match !== null) {
        const read = readNarrowedAppDoc(app.dir, match[1]!, appChain(app.info.scheme), `${app.info.scheme}/${match[1]}`, granted);
        if (!("refusal" in read)) inputs = Object.keys(read.doc.actions[match[2]!]?.inputs ?? {});
      }
      out.push({
        app: app.info.scheme,
        name: row.action ?? row.id,
        title: row.title ?? row.id,
        description: row.description ?? row.title ?? row.id,
        run,
        inputs,
        hold,
      });
    }
  }
  return out.sort((a, b) => (a.app + a.name).localeCompare(b.app + b.name));
}

export type AppRunResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; message: string };

/**
 * Run one installed app's tool, headless: the same holds the fold applies, the same
 * narrowed document, the same seam table, the kernel runner, the app-plane budgets.
 */
export async function runAppTool(
  projectRoot: string,
  scheme: string,
  tool: string,
  args: Record<string, unknown> = {},
  io: { out: (l: string) => void } = { out: () => {} },
): Promise<AppRunResult> {
  const { apps, state, approvals } = discoverProjectApps(projectRoot);
  const app = apps.find((a) => a.info.scheme === scheme);
  if (app === undefined) return { ok: false, reason: "not_found", message: `no app "${scheme}" in this project — despia app list names what is` };
  const row = app.info.contributions.find((c) => c.slot === "tool" && (c.action === tool || c.id === tool));
  if (row === undefined) return { ok: false, reason: "not_found", message: `app "${scheme}" declares no tool "${tool}" — despia app tools ${scheme} lists its surface` };
  const hold = appHold(app, state, approvals);
  if (hold !== null) return { ok: false, reason: "forbidden", message: hold };

  const granted = new Set(state[scheme]?.grants ?? []);
  const match = RUN.exec(row.run ?? "");
  if (match === null) return { ok: false, reason: "bad_request", message: `tool "${tool}" carries no runnable \`run\` pointer` };
  const [, file, action] = match;
  const read = readNarrowedAppDoc(app.dir, file!, appChain(scheme), `${scheme}/${file}`, granted);
  if ("refusal" in read) return { ok: false, reason: "forbidden", message: read.refusal };
  const doc = read.doc;
  if (!Object.hasOwn(doc.actions, action!)) {
    return { ok: false, reason: "not_found", message: `run names action "${action}" which ${scheme}/${file} does not declare` };
  }

  const { door, close } = localMountDoor(projectRoot, scheme, io);
  try {
    // storage is the same write-through convenience the mounted funnel binds, over the
    // same /edit/api/apps/storage door (namespacing enforced there, not here). A mounted
    // surface may fire-and-forget; a CLI invocation FLUSHES before it returns, because a
    // write lost after process exit is data loss with no surface left to notice it.
    let storageCache: Record<string, unknown> = {};
    const pendingWrites: Promise<unknown>[] = [];
    const stored = await door("GET", `/edit/api/apps/storage/${encodeURIComponent(scheme)}`);
    if (stored.status === 200 && stored.body !== null && typeof stored.body === "object") {
      const value = (stored.body as Record<string, unknown>)["value"];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) storageCache = value as Record<string, unknown>;
    }
    const callModule = headlessScope({
      scheme,
      grants: granted,
      door,
      storage: {
        read: () => storageCache,
        write: (value) => {
          storageCache = value;
          pendingWrites.push(door("PUT", `/edit/api/apps/storage/${encodeURIComponent(scheme)}`, value)
            .catch(() => io.out(`[despia app] ${scheme}: storage write failed`)));
        },
      },
      toast: (text) => io.out(`[${scheme}] ${text}`),
    });

    const store = new ReactiveStore();
    const deadlineAt = Date.now() + APP_BUDGETS.deadlineMs;
    const env = makeRunEnv(store, {
      ownerScheme: scheme,
      callModule,
      egress: egressGate(doc.egress),
      loopCap: APP_BUDGETS.loopCap,
      deadlineAt,
      callBudget: { count: 0, cap: APP_BUDGETS.calls },
      component: () => {},
    });
    for (const [name, decl] of Object.entries(doc.actions)) {
      env.actions.set(name, { body: decl.body, inputs: (decl.inputs ?? {}) as Dict });
    }
    const runner = new ActionRunner(env);
    const value = await runner.callAction(action!, {}, null, args as Dict, { entry: true });
    await Promise.all(pendingWrites);

    const overLoop = env.loopWork.count > APP_BUDGETS.loopCap;
    const overCalls = (env.callBudget?.count ?? 0) > APP_BUDGETS.calls;
    const overClock = Date.now() > deadlineAt;
    if (overLoop || overCalls || overClock) {
      const which = overLoop ? "loop" : overCalls ? "module-call" : "time";
      return { ok: false, reason: "budget_exceeded", message: `the run exceeded its ${which} budget` };
    }
    const thrown = runner.takeThrow();
    if (thrown !== null) {
      const t = thrown.value as { reason?: unknown; message?: unknown } | null;
      const reason = t !== null && typeof t === "object" && typeof t.reason === "string" ? t.reason : "failed";
      const message = t !== null && typeof t === "object" && typeof t.message === "string" ? t.message
        : t instanceof Error ? t.message : String(t);
      return { ok: false, reason, message };
    }
    return { ok: true, value: toPlain(value) };
  } finally {
    //  A CLI invocation is one change set, and this is where it ends. A burst left open when
    //  the process exits is a commit that never happened, so the plane closes here — before
    //  the door does — and the run's writes land as one attributed commit.
    flushAppChanges(projectRoot);
    close();
  }
}

/** The wire pass: the runner's NSNull sentinel reads as null everywhere outside it. */
function toPlain(value: unknown): unknown {
  if (value === undefined || isNSNull(value)) return null;
  if (Array.isArray(value)) return value.map(toPlain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlain(v)]));
  }
  return value;
}
