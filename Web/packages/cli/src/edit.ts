//
//  edit.ts — `despia edit` (v0-live-plan W8): the OSS canvas editor, served LOCALLY against the
//  developer's own project. No account, no hosted anything: `npm create despia` then `despia edit`
//  is the whole loop — the same @despia-native/canvas-editor package the hosted dashboard consumes,
//  mounted by the CLI over the developer's files.
//
//  WHAT THE LOOP IS, precisely. The edit server wraps the dev server (build · serve · watch ·
//  reload) and mounts the editor surface beside it:
//    · /edit                  the editor page: document list, the canvas, the source pane
//    · /edit/sdk.js · element.js   the editor package's own files, resolved locally
//    · /edit/api/documents    list · read · write the project's .dsx documents
//  A save WRITES THE FILE; the dev server's own watcher sees the change, rebuilds, and every
//  preview tab reloads over the existing SSE channel — the editor adds no second pipeline.
//
//  TEXT IS THE SAVE AUTHORITY, deliberately. The canvas renders, simulates and structurally
//  edits the document (the SDK's whole surface), but the SDK has no tree→DSX serializer yet —
//  and a lossy one would silently DROP head entries it does not model (<api>, <watch>,
//  <formula>…), which is how an editor eats a file. Until the serializer exists (tracked as
//  the logic-editor import's sibling), the source pane is what saves, byte-for-byte what the
//  author typed. An honest editor loses presentation before it ever loses content.
//
//  THE WRITE BOUNDARY. The API reads and writes ONLY .dsx files under the project's component
//  roots — resolved, contained, extension-checked — the same fail-closed posture site-node.ts
//  takes at its filesystem boundary. The server binds to loopback by default.
//

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistry, compileComponent } from "@despia-native/compiler";
import { HEAD_INPUT_SKIP } from "@despia-native/compiler/component";
import { renderToString } from "@despia-native/server";
import {
  ELEMENTS_CSS, APPLICATION_ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, FORM_ELEMENTS_CSS,
  RICH_ELEMENTS_CSS, NATIVE_CONTROLS_CSS, GLOBAL_ELEMENTS_CSS, TOKENS_CSS, tokenizeCode,
} from "@despia-native/dom";
import { applyEdits, flattenTree, projectTree, SurgeryError, type Edit, type NodePath, type TreeNode } from "@despia-native/compiler/surgery";
import { buildScreenGraph, type GraphDocument, type GraphRoute } from "@despia-native/compiler/screengraph";
import { edgeGeometry, edgeMidpoint, layoutScreenGraph } from "@despia-native/compiler/screenlayout";
import { parseDsx, type XmlNode } from "@despia-native/compiler/xml";
import { projectTools, type ToolRow } from "@despia-native/kernel/mcp";

import { projectCfg, reconstruct } from "./cfg.ts";
import {
  appSurfacePayload, discoverApps, marketRows, readAppState, readAppStorage, resolveFirstPartyApps,
  resolveStudioApps, seedState, writeAppState, writeAppStorage, type DiscoveredApp,
} from "./studio-apps/host.ts";
import { readVerifiedApprovals } from "./studio-apps/approval.ts";
import { createAppEventHub, type AppEventHub } from "./studio-apps/events.ts";
import { manifestGrants, STUDIO_API } from "./studio-apps/manifest.ts";
import {
  changePlaneFor, readChangeRecords, readPolicy, revertChange, writePolicy, mergePolicy,
  type ChangeRecord,
} from "./studio-apps/vcs.ts";
import { commandAdd, lockedModuleDirs } from "./registry-commands.ts";
import { readServerDocument, ServerDocumentError, spendPlane, type RouteRow, type ServerDoc, type SpendPlaneRow } from "./server-document.ts";
import {
  projectFlow, applyFlowEdit, encodeForBody, insertCatalog, titleCase, scopeAt, valueMode,
  type Flow, type FlowEditOp, type ScopeName,
} from "./nodeflow.ts";
import { projectExpr, exprCatalog } from "./exprflow.ts";
import { resolveShotScope, type Dict, type ShotHead, type ShotHydrate, type ShotScopeResult } from "@despia-native/kernel";
import { loadShotConfig, SHOT_CONFIG_FILENAME, type ShotConfig, type ShotProfile } from "./shot.ts";
import { loadFilmDocument, FilmDocumentError } from "./film-document.ts";
import { renderFilm, ffmpegAvailable } from "./film-render.ts";
import { findWebRoot } from "./shot-render.ts";
import { launchShotBrowser } from "./shot-browser.ts";
import { decodeRange, lexExpression, parseExpression, type BodyContext, type Span } from "./expr.ts";

import { buildProject } from "./build.ts";
import { handleRpc } from "./mcp.ts";
import { componentFiles, packageRoots, type ProjectConfig } from "./config.ts";
import { devHeaders, startDevServer, type DevOptions, type DevServer } from "./dev.ts";

export class EditError extends Error {}

/** The resolved editor surface: the canvas scripts, plus the logic editor's when present. */
export interface EditorAssets {
  sdk: string;
  element: string;
  packageDir: string;
  /** @despia-native/logic-editor (W8.3) — the visual formula editor, same surface, optional */
  logicSdk?: string;
  logicElement?: string;
  /**
   * The COMPILED DSX editor: the directory `buildProject` wrote, served whole under /edit.
   *
   * Present whenever the editor's documents could be resolved, which is the M1 answer — the
   * chrome is a .dsx document our own compiler built. Absent, the source-pane page below
   * still serves, because `despia edit` losing its loop over a missing package would be a
   * worse failure than serving plain chrome.
   */
  dsxDir?: string;
}

/**
 * The DSX editor's own component root — the documents `despia edit` is supposed to serve.
 *
 * M1 says anything rendering the editor's chrome is a .dsx document compiled by our own
 * compiler, and M2 says the local loop and the hosted studio are the SAME documents. So this
 * resolves them the way the canvas SDK is already resolved: an installed package first, then a
 * walk up to the module in a repo checkout. Absent, the caller keeps the source-pane page —
 * `despia edit` must never stop working because the editor package is not installed.
 */
export function resolveDsxEditor(projectRoot: string): string | null {
  const candidates = [join(projectRoot, "node_modules", "@despia-native", "editor")];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    candidates.push(join(dir, "ClosedSource", "DSX", "Modules", "Custom", "Editor"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "Components", "Editor.dsx"))) return candidate;
  }
  return null;
}

/**
 * Compile the editor's documents into a servable site, once per process.
 *
 * The editor is a DSX app, so it is built by `buildProject` like any other — no second
 * pipeline, no special case in the compiler, and the M6 self-hosting claim stays honest
 * because the thing being served IS the thing the surgery gate runs against.
 *
 * `studioApi` and `studioPreview` are deliberately EMPTY. The editor interpolates them into
 * its URLs, so empty makes every call same-origin, which is exactly what the local loop wants
 * (the hosted studio sets them to its own API). Empty by INTENT, stated here, because the
 * ledger's R4 is the same shape by accident and the two must not be confused.
 */
/** The Flow package (OpenSource/Flow) - the flow-canvas library the Studio's map and logic
 *  views consume. Published shape first (a project's own node_modules), then the repo walk-up,
 *  the same two-step resolvePackage takes for the SDKs. */
function resolveFlowPackage(projectRoot: string): string | null {
  const candidates = [join(projectRoot, "node_modules", "@despia-native", "flow")];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    candidates.push(join(dir, "OpenSource", "Flow"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "dsx.json")) && existsSync(join(candidate, "Components"))) return candidate;
  }
  return null;
}

/** The Apps package (Core/Apps) - the module that owns app mounting: `apps.StudioAppSurface`
 *  and the AppMount facet the Studio's rail destinations and the Apps panel consume. Same
 *  two-step as the Flow package: published shape first, then the repo walk-up. */
function resolveAppsPackage(projectRoot: string): string | null {
  return resolveRepoPackage(projectRoot, "apps", "ClosedSource/DSX/Modules/Core/Apps");
}

/** Published shape first (`node_modules/@despia-native/<npm>`), then the repo walk-up — the
 *  two-step every editor-build package takes. */
function resolveRepoPackage(projectRoot: string, npm: string, repoRel: string): string | null {
  const candidates = [join(projectRoot, "node_modules", "@despia-native", npm)];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    candidates.push(join(dir, ...repoRel.split("/")));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "dsx.json")) && existsSync(join(candidate, "Components"))) return candidate;
  }
  return null;
}


export function buildDsxEditor(moduleDir: string, outDir: string): ProjectConfig {
  // MISSING IS LOUD, not a blank canvas: without the Flow package the map and logic views
  // would compile and render as empty panes, which is exactly the mockup failure mode (R7).
  // The throw is caught by resolveEditor, which falls back to the source pane and says why.
  const flow = resolveFlowPackage(moduleDir);
  if (flow === null) {
    throw new Error("the Flow package (OpenSource/Flow or @despia-native/flow) is required by the Studio's canvases and was not found");
  }
  // Same law for the Apps package: without it every rail destination an app contributes
  // would render blank while the panel still lists it — a mount that lies.
  const apps = resolveAppsPackage(moduleDir);
  if (apps === null) {
    throw new Error("the Apps package (ClosedSource/DSX/Modules/Core/Apps or @despia-native/apps) is required by the Studio's app mounts and was not found");
  }
  // BOOT-RESIDENT first-party apps (studio-apps.md §12): the Marketing Studio's pane
  // compiles into the editor bundle — a build fact the page learns through the bootApps
  // const, not a privilege. Missing is a smaller Studio, not a broken one: the fold then
  // never offers its rows. The Shots library rides along so the board's slide previews
  // (`<ShotPro/>`) resolve in the served Studio, not only in the self-hosted loop.
  const marketing = resolveRepoPackage(moduleDir, "app-marketing", "ClosedSource/StudioApps/MarketingStudio");
  const shots = resolveRepoPackage(moduleDir, "shots", "OpenSource/Shots");
  const bootApps = ["editor", ...(marketing !== null ? ["marketing"] : [])].join(" ");
  const config: ProjectConfig = {
    root: moduleDir,
    scheme: "editor",
    name: "Despia Studio",
    entry: "editor.Editor",
    outDir,
    packages: [flow, apps, ...(marketing !== null ? [marketing] : []), ...(shots !== null ? [shots] : [])],
    modules: [],
    routes: undefined as unknown as ProjectConfig["routes"],
    notFound: undefined,
    router: undefined as unknown as ProjectConfig["router"],
    lang: "en",
    theme: undefined,
    app: {},
    consts: { studioApi: "", studioPreview: "", bootApps },
  };
  buildProject(config);
  copyStudioFace(outDir);
  return config;
}

/**
 * The Studio's own face, beside the Studio.
 *
 * The sheet used to point at the PROJECT's `/fonts/InterVariable.woff2`, on the reasoning
 * that the dashboard and the site both ship one - so `despia edit` in anyone else's project
 * 404'd and the Studio silently rendered in DejaVu. That was the right call when the
 * framework had no face of its own; `OpenSource/Type` vendors one now (OFL-1.1, subsetted,
 * two unicode ranges), so the Studio carries it instead of hoping to find it.
 *
 * Best effort on purpose: `font-display: swap` plus a full system stack behind the family
 * means a missing file costs the face and nothing else, and a tool that refuses to open an
 * editor over a font is a worse tool than one that opens in DejaVu.
 */
function copyStudioFace(outDir: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "OpenSource/Type/vendor/inter");
    if (existsSync(candidate)) {
      const fonts = join(outDir, "fonts");
      mkdirSync(fonts, { recursive: true });
      for (const f of ["InterVariable-latin.woff2", "InterVariable-latin-ext.woff2", "LICENSE.txt"]) {
        const src = join(candidate, f);
        if (existsSync(src)) writeFileSync(join(fonts, f), readFileSync(src));
      }
      return;
    }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

function resolvePackage(projectRoot: string, npmName: string, repoFolder: string, files: [string, string]): { sdk: string; element: string; dir: string } | null {
  const candidates = [join(projectRoot, "node_modules", "@despia-native", npmName)];
  // the repo walk-up, from where this module actually runs (src/ or dist/src/)
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    candidates.push(join(dir, "OpenSource", repoFolder));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    const sdk = join(candidate, "src", files[0]);
    const element = join(candidate, "src", files[1]);
    if (existsSync(sdk) && existsSync(element)) return { sdk, element, dir: candidate };
  }
  return null;
}

/**
 * Find the editor surface: the project's own node_modules first (the published shape, what
 * cold-start proves), then this repository's OpenSource/ folders (in-repo development).
 * The canvas editor is REQUIRED — null means it is missing and the caller says exactly what
 * to install; the logic editor rides along whenever it resolves, one surface, two SDKs.
 */
export function resolveEditor(projectRoot: string, opts: { dsxOutDir?: string } = {}): EditorAssets | null {
  const canvas = resolvePackage(projectRoot, "canvas-editor", "CanvasEditor", ["canvas-editor.js", "stack-editor-element.js"]);
  if (canvas === null) return null;
  const logic = resolvePackage(projectRoot, "logic-editor", "LogicEditor", ["logic-editor.js", "logic-editor-element.js"]);
  // The DSX chrome is compiled ONCE, at resolve time, into a directory beside the project's
  // own build output. A compile failure is not fatal: it costs the DSX chrome and keeps the
  // loop, and it says so, because a silent downgrade to the plain page is how you ship the
  // thing M1 forbids while believing you did not.
  let dsxDir: string | undefined;
  const moduleDir = resolveDsxEditor(projectRoot);
  if (moduleDir !== null) {
    // OUTSIDE the project, deliberately. This is the developer's repository; a tool that
    // writes a build directory into it uninvited is a tool that shows up in their next
    // `git status` and, if they miss it, their next commit. Keyed by the module path so two
    // checkouts served at once cannot share one directory.
    const out = opts.dsxOutDir
      ?? join(tmpdir(), `despia-editor-${createHash("sha256").update(moduleDir).digest("hex").slice(0, 16)}`);
    try {
      buildDsxEditor(moduleDir, out);
      dsxDir = out;
    } catch (e) {
      console.warn(`[despia edit] the DSX editor did not compile, serving the source pane: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    sdk: canvas.sdk,
    element: canvas.element,
    packageDir: canvas.dir,
    ...(logic !== null ? { logicSdk: logic.sdk, logicElement: logic.element } : {}),
    ...(dsxDir !== undefined ? { dsxDir } : {}),
  };
}

/** The project's editable documents: every .dsx under the component roots, stable order. */
export function listDocuments(config: ProjectConfig): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const root of packageRoots(config)) {
    for (const file of componentFiles(root)) {
      out.push({ name: relative(config.root, file).split(sep).join("/"), path: file });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** [S-BOUNDARY] A document name from the wire, resolved INSIDE a component root, .dsx only. */
function resolveDocument(config: ProjectConfig, name: string): string | null {
  if (name.includes("\0") || !name.endsWith(".dsx")) return null;
  const abs = resolve(config.root, ...name.split("/"));
  for (const root of packageRoots(config)) {
    const componentsDir = resolve(root, "Components");
    if (abs.startsWith(componentsDir + sep)) return abs;
  }
  return null;
}

/**
 * [S-BOUNDARY] The STRUCTURAL-WRITE boundary of the ONE surgery endpoint (`/edit/api/edit/`):
 * a component document, or a server one addressed as `server/…`.
 *
 * Admitting `server/` here is a DECISION, not a default (platform/09-agent-tools.md WE7,
 * made after its containment test): a served capability's contract — the `<tool>` row's
 * attributes — is edited on the same audited splice path a screen's rows are, or the Studio
 * shows a face it cannot honour. The decision stays this narrow on purpose: the resolution
 * inside `server/` is `resolveServerDocument`'s own containment (no escape, .dsx only), and
 * the OTHER structural endpoints (tree, node, nid, head, the source-pane PUT) keep
 * `resolveDocument` — widening those would widen reads and saves nobody asked for.
 */
export function resolveEditableDocument(config: ProjectConfig, name: string): string | null {
  const component = resolveDocument(config, name);
  if (component !== null) return component;
  if (!name.startsWith("server/")) return null;
  return resolveServerDocument(config, name.slice("server/".length));
}

function readBody(req: IncomingMessage, cap = 4 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise((done, failed) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        req.destroy();
        done(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", failed);
  });
}

/** Paths the edit mount answers itself, so the compiled editor can never shadow them. */
const MOUNT_ROUTES = new Set(["/edit/sdk.js", "/edit/element.js", "/edit/logic-sdk.js", "/edit/logic-element.js"]);

const ASSET_TYPES: { [ext: string]: string } = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/**
 * [S-BOUNDARY] One file out of the compiled editor, addressed by the URL under /edit.
 *
 * Contained the same way the document API is: resolve, then require the result to still be
 * inside the directory. A URL is attacker-shaped input even on loopback, and the editor's
 * output sits next to the developer's own source. `/edit` and any unknown path fall to
 * index.html so the editor's client router owns its own routes.
 *
 * `/edit/api/*` is NEVER served from here — those are the live endpoints below, and a stale
 * file with that name would shadow them silently.
 */
function serveEditorAsset(dir: string, pathname: string): { body: Buffer; type: string } | null {
  // The mount owns these; a file of the same name in the compiled output must never shadow a
  // live route. `/edit/api/*` is the structural API and the four scripts are the canvas and
  // logic SDKs, both resolved from their packages rather than built into the editor.
  if (pathname.startsWith("/edit/api/") || MOUNT_ROUTES.has(pathname)) return null;
  const rest = pathname === "/edit" || pathname === "/edit/" ? "" : pathname.slice("/edit/".length);
  if (rest.includes("\0")) return null;
  const index = () => {
    const file = join(dir, "index.html");
    if (!existsSync(file)) return null;
    // ONE absolute path in an otherwise relative document. The build emits `./main.js` and a
    // relative import map, which resolve correctly under /edit/, but the PWA manifest link is
    // rooted — and rooted here means the developer's own project, not the editor. Rewriting
    // that single href is smaller and more honest than teaching the builder about mounts for
    // one link, and it is stated rather than silent.
    const html = readFileSync(file, "utf8").replace('href="/manifest.webmanifest"', 'href="./manifest.webmanifest"');
    return { body: Buffer.from(html, "utf8"), type: ASSET_TYPES[".html"]! };
  };
  if (rest === "") return index();
  const abs = resolve(dir, rest);
  if (abs !== dir && !abs.startsWith(dir + sep)) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    // A missing path with an EXTENSION is a missing file, and answering it with the document
    // is how a mistyped import becomes an unreadable parse error instead of a 404. Only
    // extensionless paths fall through to the editor's own client router.
    return /\.[a-z0-9]+$/i.test(rest) ? null : index();
  }
  const dot = abs.lastIndexOf(".");
  const type = (dot < 0 ? undefined : ASSET_TYPES[abs.slice(dot)]) ?? "application/octet-stream";
  return { body: readFileSync(abs), type };
}

/** A body-relative byte from the query string: absent or unreadable falls back, and every
 *  value is clamped into the body so a hand-typed offset can never address another file. */
function clampByte(raw: string | null, fallback: number, len: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(len, Math.trunc(n))) : fallback;
}

function isRecord(v: unknown): v is { [k: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── THE ADMISSION CREDENTIAL ─────────────────────────────────────────────────────────────
//
//  READ THIS BEFORE MISTAKING IT FOR SOMETHING IT IS NOT. What follows is a PER-RUN ADMISSION
//  SECRET FOR A LOCAL DEVELOPER TOOL, and nothing else. It is NOT an identity system: it names
//  no user, carries no claims, grants no roles, distinguishes nobody from anybody, and it dies
//  with the process that minted it. Accounts, roles, a grant store and a consent ledger are a
//  separate, specified, unbuilt program; when that lands it replaces nothing here, because
//  this answers a different question — "may this request reach the files on this machine at
//  all" — asked by a server whose whole job is writing into a developer's working tree.
//
//  Why it exists when the default bind is loopback: `--host` is one flag away, and turning it
//  on used to turn on an unauthenticated remote file write. Loopback is also not a boundary on
//  a shared machine, or inside a container whose port someone forwards.
//
//  THREE PRESENTATIONS, one secret. A header for programs, a query parameter for the URL the
//  command prints, and a cookie so the browser keeps it after that first navigation — the
//  editor page is a compiled application that knows nothing about any of this, and teaching
//  every fetch in it about a header would be a worse boundary, not a better one.
const ADMISSION_HEADER = "x-despia-edit";
const ADMISSION_QUERY = "token";
/** The query-parameter spelling, re-exported so the command can print a URL that carries it. */
export const ADMISSION_QUERY_NAME = ADMISSION_QUERY;
const ADMISSION_COOKIE = "despia_edit";

/** Constant-time equality over two secrets of any length. */
function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual THROWS on a length mismatch, which would leak the length through a 500.
  // Comparing digests instead keeps one code path and one duration for every input.
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/** The credential this request presents, by any of the three spellings. */
function presentedAdmission(req: IncomingMessage, query: string): { value: string; fromQuery: boolean } {
  const header = req.headers[ADMISSION_HEADER];
  if (typeof header === "string" && header !== "") return { value: header, fromQuery: false };
  const asked = new URLSearchParams(query).get(ADMISSION_QUERY);
  if (asked !== null && asked !== "") return { value: asked, fromQuery: true };
  for (const pair of (req.headers.cookie ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== ADMISSION_COOKIE) continue;
    return { value: decodeURIComponent(pair.slice(eq + 1).trim()), fromQuery: false };
  }
  return { value: "", fromQuery: false };
}

/**
 * A call from this server to ITS OWN door (the agent tools go through the audited HTTP API
 * rather than around it). It presents the credential like every other caller: exempting the
 * self-call would be a second, ungated way in, sitting behind the gate it bypasses.
 */
function selfFetch(admission: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(ADMISSION_HEADER, admission);
  return fetch(url, { ...init, headers });
}

/** A loopback bind — the only one that may be served without an explicitly chosen credential. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "localhost" || bare === "::1" || bare === "::ffff:127.0.0.1" || /^127\./.test(bare);
}

/** Mint one. 192 bits from the CSPRNG: guessing is not a threat model, it is arithmetic. */
export function mintAdmission(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * The revision of a document: the sha256 of its exact bytes.
 *
 * Content-addressed rather than mtime-based on purpose — two writes inside one filesystem
 * timestamp tick are exactly the race this precondition exists to lose safely, and a hash
 * cannot collide with itself the way a coarse clock can.
 */
export function documentRevision(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

/** The revision a caller is writing AGAINST, from `If-Match` or from the payload's `rev`. */
function requestedRevision(req: IncomingMessage, payload: unknown): string | null {
  const header = req.headers["if-match"];
  if (typeof header === "string" && header !== "") {
    const one = header.split(",")[0]!.trim().replace(/^W\//, "").replace(/^"/, "").replace(/"$/, "");
    if (one !== "" && one !== "*") return one;
  }
  if (isRecord(payload) && typeof payload["rev"] === "string" && payload["rev"] !== "") return payload["rev"];
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, devHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(body));
}

/**
 * A node's address, as one scalar. `[0, 2, 1]` is `"0.2.1"`; the root is `""`.
 *
 * The tree panel keys its rows on this and the inspector sends it straight back as the edit's
 * target, so a click in the tree and a splice in the file are LITERALLY the same string. The
 * alternative - a JSON array on the wire - would need a second representation for the list key
 * (`<list key=…>` takes a scalar) and a place where the two could drift.
 */
function pathId(path: NodePath): string {
  return path.join(".");
}

/** Parse an address back. Fail-closed: anything that is not dot-separated indices is refused
 *  rather than coerced, because a coerced path edits the WRONG element and still succeeds. */
function parsePathId(id: string): NodePath | null {
  if (id === "") return [];
  if (!/^\d+(\.\d+)*$/.test(id)) return null;
  return id.split(".").map((part) => Number(part));
}

function nodeAt(root: TreeNode, path: NodePath): TreeNode | null {
  let node: TreeNode = root;
  for (const index of path) {
    const child = node.children[index];
    if (child === undefined) return null;
    node = child;
  }
  return node;
}

/** Split a compound `style="a: 1; b: 2"` into the declarations an inspector shows as rows.
 *  Presentation only - `setStyleProperty` is what writes one back, and it rewrites that one
 *  declaration in place rather than re-serialising this list. */
function styleRows(value: string | undefined): { property: string; value: string }[] {
  if (value === undefined || value.trim() === "") return [];
  const rows: { property: string; value: string }[] = [];
  for (const part of value.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim();
    if (property === "") continue;
    rows.push({ property, value: part.slice(colon + 1).trim() });
  }
  return rows;
}

/**
 * The route table as the extractor wants it.
 *
 * A registry route names its component QUALIFIED (`app.Home`), because that is what makes two
 * packages able to ship a `Home`. The graph addresses a surface by its file, so it sees the
 * bare name. Strip the scheme when it is one this build actually has: dropping any prefix
 * would silently fuse `shop.Cart` and `admin.Cart` into one node, which is a wrong map rather
 * than an incomplete one.
 */
function graphRoutes(config: ProjectConfig): GraphRoute[] {
  const schemes = new Set([config.scheme]);
  for (const root of packageRoots(config)) {
    const manifest = join(root, "dsx.json");
    if (!existsSync(manifest)) continue;
    try {
      const scheme = (JSON.parse(readFileSync(manifest, "utf8")) as { scheme?: unknown }).scheme;
      if (typeof scheme === "string" && scheme !== "") schemes.add(scheme);
    } catch { /* a manifest we cannot read contributes no scheme; the build reports it */ }
  }
  const out: GraphRoute[] = [];
  for (const route of config.routes ?? []) {
    const component = route.component;
    if (component === undefined) { out.push({ path: route.path }); continue; }
    const dot = component.indexOf(".");
    const bare = dot > 0 && schemes.has(component.slice(0, dot)) ? component.slice(dot + 1) : component;
    out.push({ path: route.path, component: bare });
  }
  return out;
}

/** The root plan's entry surface, bare. Same scheme strip as a route's component: the config
 *  says `shop.Home`, the graph addresses the file, and the file is `Home`. */
function graphEntry(config: ProjectConfig): string | null {
  const entry = config.entry;
  if (entry === undefined || entry === "") return null;
  const dot = entry.indexOf(".");
  return dot > 0 ? entry.slice(dot + 1) : entry;
}

/** Every document the graph is derived from. A file that cannot be read is skipped rather
 *  than failing the whole map - one unreadable component must not blank the canvas. */
function graphDocuments(config: ProjectConfig): GraphDocument[] {
  const out: GraphDocument[] = [];
  for (const { name, path } of listDocuments(config)) {
    try {
      out.push({ file: name, source: readFileSync(path, "utf8") });
    } catch { /* skip */ }
  }
  return out;
}

//
//  THE SERVER PLANE — a backend is a document, so it projects like one.
//
//  A `<server>` document already declares everything a backend canvas needs: entities with
//  their ownership, routes with their auth and rate, workers with their queues and schedules.
//  So the three views are projections of the head and body the author wrote, exactly as the
//  screen map is a projection of the component tree. Nothing here is stored.
//
//  ITS OWN BOUNDARY, deliberately. Server documents live in `server/`, not under a component
//  root, so `resolveDocument` correctly refuses them — and widening that function to admit
//  them would widen the WRITE boundary of the three editing endpoints at the same time. This
//  one is read-only and resolves inside `server/` only.
//

/** [S-BOUNDARY] A server document name from the wire, resolved INSIDE `server/`, .dsx only. */
function resolveServerDocument(config: ProjectConfig, name: string): string | null {
  if (name.includes("\0") || !name.endsWith(".dsx")) return null;
  const serverDir = resolve(config.root, "server");
  const abs = resolve(serverDir, ...name.split("/"));
  return abs.startsWith(serverDir + sep) ? abs : null;
}

/** Every `<server>` document in the project, in stable order. */
function serverDocuments(config: ProjectConfig): string[] {
  const dir = join(config.root, "server");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".dsx")).sort();
}

/**
 * One document's three views.
 *
 * A worker is an api row with `worker` set (the drain endpoint's shape is not a decision), so
 * the split is on that field rather than on a second table.
 *
 * NO EDGES BETWEEN ENTITIES, and that is a decision rather than an omission: the schema
 * vocabulary is a closed set of SCALAR types with no relation in it, so there is nothing to
 * derive one from. Inferring `customer_id → customer` from the name would draw a constraint
 * the database does not have, which is the worst thing this surface could do.
 */
function serverViews(doc: ServerDoc, all: readonly ServerDoc[] = [doc]): {
  chain: string;
  routes: Array<RouteRow & { key: string }>;
  workers: Array<RouteRow & { key: string }>;
  entities: Array<{ name: string; ownership: string; indexes: string[]; fields: Array<{ name: string; type: string }> }>;
  actions: Array<{ name: string; inputs: string[]; steps: number }>;
  tools: Array<{ name: string; action: string; description: string; auth: string; mutates: string; inputs: string[] }>;
  secrets: string[];
  egress: string[];
  budgets: SpendPlaneRow[];
} {
  const rows = Object.entries(doc.api).map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // THE SPEND PLANE IS DEPLOYMENT-WIDE (cost-guardrails.md): one deployment, one set of
  // ceilings, merged over EVERY document — so each document's view shows the same plane,
  // because "what can this backend cost" has one answer, not one per file. A plane that
  // cannot merge (a budget naming a host no document declares) projects as empty rather
  // than blanking the whole view: the build is what refuses it, with the line.
  let budgets: SpendPlaneRow[];
  try {
    budgets = spendPlane(all);
  } catch {
    budgets = [];
  }
  return {
    chain: doc.chain,
    routes: rows.filter((r) => r.worker === undefined),
    workers: rows.filter((r) => r.worker !== undefined),
    entities: Object.entries(doc.schema).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, entity]) => ({
      name,
      ownership: entity.ownership,
      indexes: entity.indexes,
      fields: Object.entries(entity.fields).sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([field, type]) => ({ name: field, type })),
    })),
    actions: Object.entries(doc.actions).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, action]) => {
      const flow = projectFlow(action.body, name);
      return { name, inputs: Object.keys(action.inputs).sort(), steps: flow.statements };
    }),
    // The BACKEND MCP face (v0-live W3): a `<tool>` row is to MCP what a `<route>` row is
    // to HTTP, and the surface that shows routes and workers must show it or the document
    // has a face the editor pretends it does not have. `inputs` is the DERIVED shape - the
    // named action's declared inputs, never a second contract - so what an author reads
    // here is what a model receives at /mcp.
    tools: Object.entries(doc.mcp).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, row]) => ({
      name,
      action: row.action,
      description: row.description,
      auth: row.auth ?? "",
      mutates: row.mutates ?? "",
      inputs: Object.keys(doc.actions[row.action]?.inputs ?? {}),
    })),
    secrets: [...doc.secrets].sort(),
    egress: [...doc.egress].sort(),
    budgets,
  };
}

//
//  THE LOGIC PLANE — every code body in a document, and the drawing of one.
//
//  A document's business logic is not one thing in one place: it is the head's named actions,
//  its computed variables and formulas, and every inline `on:*` handler in the markup. A
//  canvas that showed only the named actions would be showing a fraction of the behaviour and
//  looking complete while doing it, which is the failure mode this repo keeps hitting.
//
//  Bodies are addressed the same way the tree addresses elements — a dotted path of child
//  indices — so selecting a handler on the logic canvas and selecting its element in the tree
//  are the same address, not two addressing schemes that have to be kept in step.
//

type LogicBody = {
  id: string;
  kind: "action" | "formula" | "variable" | "handler";
  name: string;
  /** RAW bytes as they sit in the file (entities intact) — spans and splices address these. */
  source: string;
  /** Byte range of `source` within the document, when the parser recorded one. */
  span?: { start: number; end: number };
  /** Where the body lives: element text, or an on:* attribute value (quotes reserved too). */
  context: "text" | "attr";
};

/** Every code body in a document, in document order. */
function logicBodies(source: string): LogicBody[] {
  let root: XmlNode;
  try {
    root = parseDsx(source);
  } catch {
    return [];
  }
  const out: LogicBody[] = [];
  const head = root.children.find((c) => c.tag === "head");
  for (const decl of head?.children ?? []) {
    const name = decl.attrs["as"];
    if (name === undefined) continue;
    const body = decl.text ?? "";
    if (body.trim() === "") continue;
    // A plain <variable> is a seed, not logic. A computed one is a function of the store and
    // is exactly the kind of thing people get wrong without being able to see it.
    if (decl.tag === "action" || decl.tag === "formula"
        || (decl.tag === "variable" && decl.attrs["computed"] === "true")) {
      const span = decl.textSpan;
      out.push({
        id: `${decl.tag}:${name}`, kind: decl.tag as LogicBody["kind"], name,
        // the RAW slice, so every span the projection hands out addresses file bytes
        source: span !== undefined ? source.substring(span.start, span.end) : body,
        ...(span !== undefined ? { span } : {}),
        context: "text",
      });
    }
  }
  const walk = (node: XmlNode, path: number[]): void => {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (!name.startsWith("on:") || value.trim() === "") continue;
      const span = node.attrSpans?.[name]?.value;
      out.push({
        id: `${name}@${path.join(".")}`, kind: "handler", name: `<${node.tag}> ${name}`,
        source: span !== undefined ? source.substring(span.start, span.end) : value,
        ...(span !== undefined ? { span } : {}),
        context: "attr",
      });
    }
    node.children.forEach((child, index) => walk(child, [...path, index]));
  };
  root.children.forEach((child, index) => { if (child.tag !== "head") walk(child, [index]); });
  return out;
}

/** `inputs="amount, currency"` on the action this body belongs to. */
function declaredInputs(source: string, bodyId: string): string[] {
  const [tag, name] = bodyId.split(":");
  if (tag === undefined || name === undefined) return [];
  let root: XmlNode;
  try { root = parseDsx(source); } catch { return []; }
  const head = root.children.find((c) => c.tag === "head");
  const decl = head?.children.find((c) => c.tag === tag && c.attrs["as"] === name);
  return (decl?.attrs["inputs"] ?? "").split(",").map((w) => w.trim()).filter((w) => w !== "");
}

/** Everything the document itself declares: the store, the requests, the actions, the props. */
function documentNames(source: string): ScopeName[] {
  let root: XmlNode;
  try { root = parseDsx(source); } catch { return []; }
  const head = root.children.find((c) => c.tag === "head");
  const out: ScopeName[] = [];
  for (const decl of head?.children ?? []) {
    const name = decl.attrs["as"];
    if (name === undefined) continue;
    const from = decl.tag === "variable" && decl.attrs["computed"] === "true" ? "<variable computed>" : `<${decl.tag}>`;
    out.push({ name, origin: "document", from });
  }
  // the ambient handles every body may reach, named once so the picker can offer them
  for (const name of ["dsx.variable", "dsx.action", "dsx.module", "dsx.attribute", "dsx.const", "dsx.env"]) {
    out.push({ name, origin: "ambient", from: "the bus" });
  }
  return out;
}

//
//  THE PANEL CATALOGS - resolved the same two-step way the Flow package is: a published
//  @despia-native/references package first, then the repo walk-up to Documentation/reference.
//

/** The web workspace root, for bundling the film harness. */
function repoWebRoot(): string {
  return findWebRoot(import.meta.url);
}

let referenceCache: Map<string, unknown> | null = null;

function referenceJson(name: string): unknown | null {
  referenceCache ??= new Map();
  if (referenceCache.has(name)) return referenceCache.get(name)!;
  const candidates: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    candidates.push(join(dir, "OpenSource", "Documentation", "reference", name));
    candidates.push(join(dir, "Documentation", "reference", name));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // outside a checkout, the copies the package ships (dist/src/reference) are the catalogs
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), "reference", name));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      referenceCache.set(name, parsed);
      return parsed;
    } catch { /* keep looking */ }
  }
  referenceCache.set(name, null);
  return null;
}

// ── the shot scope, projected for the Data panel ─────────────────────────────────────

/** A slide names a COMPONENT, not a path. Resolve it the way the capture does - own scheme
 *  first, then a unique suffix - against the documents on disk, and compile its head. */
function documentHead(config: ProjectConfig, document: string): ShotHead | null {
  if (document.length === 0) return null;
  const bare = document.includes(".") ? document.substring(document.lastIndexOf(".") + 1) : document;
  const hits = listDocuments(config).filter((d) => basename(d.name, ".dsx") === bare);
  if (hits.length !== 1) return null;
  try {
    return compileComponent(bare, config.scheme, readFileSync(hits[0]!.path, "utf8")).head;
  } catch {
    // an unparsable document has no scope to show; the tree view is where its error belongs
    return null;
  }
}

/** One row per NAME the slide's render will need, carrying the resolved value AND the tier it
 *  came from. The tier is the point: an author looking at a screenshot that renders the wrong
 *  number needs to know whether it came from their override, the document's `sample=`, or the
 *  project plane, and every one of those is a different file to open. */
function scopeRows(
  head: ShotHead, shot: ShotProfile, shotConfig: ShotConfig, result: ShotScopeResult,
): Array<{ kind: string; name: string; value: string; tier: string; fix: string; over: boolean }> {
  const overVars = (shot.vars ?? {}) as { [k: string]: unknown };
  const overGlobals = (shot.globals ?? {}) as { [k: string]: unknown };
  const hydrate = ((shotConfig.hydrate ?? {}) as ShotHydrate).global ?? {};
  const failed = new Map(result.unresolved.map((row) => [`${row.kind}:${row.name}`, row.fix]));
  const has = (bag: object, k: string): boolean => Object.prototype.hasOwnProperty.call(bag, k);
  const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? "");
  const rows: Array<{ kind: string; name: string; value: string; tier: string; fix: string; over: boolean }> = [];

  const push = (kind: string, name: string, value: unknown, tier: string, over: boolean): void => {
    rows.push({ kind, name, value: value === undefined ? "" : text(value), tier,
                fix: failed.get(`${kind}:${name}`) ?? "", over });
  };

  for (const row of head.attributes) {
    const over = has(overVars, row.as);
    const tier = over ? "override"
      : row.sample !== undefined ? "sample"
      : row.default !== undefined && row.default.trim().length > 0 ? "default"
      : "unresolved";
    push("attribute", row.as, over ? overVars[row.as] : result.attrs[row.as], tier, over);
  }
  for (const name of head.expects ?? []) {
    const over = has(overVars, name);
    push("expects", name, over ? overVars[name] : result.vars[name],
         over ? "override" : has(hydrate, name) ? "hydrate" : "unresolved", over);
  }
  for (const row of head.variables) {
    if (row.computed) continue;   // a derivation has no leaf to seed: seed its inputs instead
    const over = has(overVars, row.as);
    push("variable", row.as, over ? overVars[row.as] : result.vars[row.as],
         over ? "override" : row.sample !== undefined ? "sample" : "body", over);
  }
  for (const row of head.apis) {
    // an api row NEVER takes a var override - resolveShotScope seeds it from sample= or a
    // cassette regardless of the slide's vars - so the panel must not show "override" for
    // a name the ladder will ignore: the chip would disagree with the capture, which is
    // the exact failure this panel exists to prevent
    push("api", row.as, result.apiSeeds[row.as]?.data,
         row.sample !== undefined ? "sample" : "unresolved", false);
  }
  // The global plane has no declaration site, so its rows ARE the values that exist: the
  // project hydrate names, plus anything this slide overrides on top of them.
  const globalNames = [...new Set([...Object.keys(hydrate), ...Object.keys(overGlobals)])].sort();
  for (const name of globalNames) {
    const over = has(overGlobals, name);
    push("global", name, result.globals[name], over ? "override" : "hydrate", over);
  }
  return rows;
}

/** The conformance twin of referenceJson: walk up for OpenSource/Conformance/<name> (or a
 *  drop's bare Conformance/<name>). The theme sheet feeds on the SAME token corpus every
 *  renderer's skin is drift-gated against, so the vocabulary cannot fork from the runtime. */
function conformanceJson(name: string): unknown | null {
  referenceCache ??= new Map();
  const key = `conformance:${name}`;
  if (referenceCache.has(key)) return referenceCache.get(key)!;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const candidate of [join(dir, "OpenSource", "Conformance", name), join(dir, "Conformance", name)]) {
      if (!existsSync(candidate)) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
        referenceCache.set(key, parsed);
        return parsed;
      } catch { /* keep looking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  referenceCache.set(key, null);
  return null;
}

// ── the PROJECT THEME FILE (master plan P15, dsx-css §4.2) ──────────────────────────────
//
//  One file, `theme.css` at the project root, discovered by presence and folded into
//  `@layer dsx-theme` after every package sheet (the compiler's project token tier). The
//  Studio writes it in the floor-safe twin shape the kernel skin itself uses — base light
//  `:root`, the OS-dark media guard, the explicit `[data-dsx-theme="dark"]` pin — and the
//  reader parses exactly those blocks, so the round trip is total for Studio-written files
//  and tolerant of hand edits that keep the shape (it is ordinary CSS either way).

const THEME_TOKEN_NAME = /^--[a-z][a-z0-9-]*$/i;

function themeDecls(block: string): { [css: string]: string } {
  const out: { [css: string]: string } = {};
  for (const part of block.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (THEME_TOKEN_NAME.test(prop) && value.length > 0) out[prop] = value;
  }
  return out;
}

export function parseProjectTheme(source: string): { light: { [css: string]: string }; dark: { [css: string]: string } } {
  // the bare :root block is the light plane; the media-guarded twin is `:root:not(...)`,
  // which this regex deliberately does not match
  const light = source.match(/(?:^|\n)\s*:root\s*\{([^}]*)\}/);
  const dark = source.match(/\[data-dsx-theme="dark"\]\s*\{([^}]*)\}/);
  return {
    light: light === null ? {} : themeDecls(light[1]!),
    dark: dark === null ? {} : themeDecls(dark[1]!),
  };
}

export function emitProjectTheme(light: { [css: string]: string }, dark: { [css: string]: string }): string {
  const rows = (map: { [css: string]: string }, indent: string): string =>
    Object.keys(map).sort().map((css) => `${indent}${css}: ${map[css]!};`).join("\n");
  const parts: string[] = [
    "/* theme.css - the project design tokens (the dsx-css app-theme file, master plan P15).",
    "   Written by the Studio theme sheet; hand edits keep working - this is ordinary CSS,",
    "   folded into the dsx-theme layer after every package sheet. */",
  ];
  if (Object.keys(light).length > 0) parts.push(`:root {\n${rows(light, "  ")}\n}`);
  if (Object.keys(dark).length > 0) {
    parts.push(`@media (prefers-color-scheme: dark) {\n  :root:not([data-dsx-theme="light"]) {\n${rows(dark, "    ")}\n  }\n}`);
    parts.push(`[data-dsx-theme="dark"] {\n${rows(dark, "  ")}\n}`);
  }
  return parts.join("\n") + "\n";
}

/**
 * One element's contract from the census: its declared attributes (name, type, enum options)
 * and its event vocabulary. Null for a tag the census does not know (a project component) —
 * the panel then offers only what the node already carries, which is the honest floor.
 */
/** the declared `<override>` knobs of a catalogued component (style-overrides.md) — the
 *  editor catalog extracts them from .dsx heads and native web.components[]; this is the
 *  read the style panel renders typed controls from. Bare component names only: the
 *  catalog keys components unqualified, and a tag with a scheme prefix falls back to its
 *  base name so `shots.ShotPro` finds `ShotPro`. */
function componentOverrides(tag: string): Array<{ as: string; type: string; default?: string; options?: string[]; min?: string; max?: string; doc?: string }> {
  const catalog = referenceJson("stack-elements.json") as {
    components?: { [name: string]: { overrides?: { [as: string]: { type?: string; default?: string; options?: string[]; min?: string; max?: string; doc?: string } } } };
  } | null;
  const components = catalog?.components ?? {};
  const base = tag.includes(".") ? tag.slice(tag.lastIndexOf(".") + 1) : tag;
  const entry = components[tag] ?? components[base];
  const rows = entry?.overrides ?? {};
  return Object.entries(rows).map(([as, spec]) => ({ as, type: spec.type ?? "text", ...spec }));
}

function elementSchema(tag: string): unknown | null {
  const catalog = referenceJson("stack-elements.json");
  const elements = isRecord(catalog) && isRecord(catalog["elements"]) ? catalog["elements"] : {};
  const el = elements[tag];
  if (!isRecord(el)) return null;
  const attrs = isRecord(el["attributes"]) ? el["attributes"] : {};
  return {
    category: typeof el["category"] === "string" ? el["category"] : "",
    events: Array.isArray(el["events"]) ? el["events"] : [],
    attributes: Object.entries(attrs)
      .filter(([name]) => !name.startsWith("on:"))
      .map(([name, spec]) => ({
        name,
        type: isRecord(spec) && typeof spec["type"] === "string" ? spec["type"] : "string",
        options: isRecord(spec) && Array.isArray(spec["enum"]) ? spec["enum"] : [],
      })),
  };
}

/** The add panel's shape: named categories of icon tiles, insertion markup included. The
 *  head grammar (category `structural`) and the app-shell web surfaces never appear - the
 *  panel adds what a page shows, not what a document declares. */
const PANEL_CATEGORIES: [id: string, label: string, icon: string][] = [
  ["layout", "Layout", "dsx.el.stack"],
  ["structure", "Structure", "dsx.el.grid"],
  ["display", "Display", "note.text"],
  ["input", "Input", "dsx.el.control"],
  ["forms", "Forms", "doc.on.clipboard"],
  ["media", "Media", "play.rectangle.fill"],
  ["overlay", "Overlays", "dsx.el.popover"],
  ["data", "Data", "dsx.el.chart"],
  ["scene", "Scenes", "gyroscope"],
];

// A TILE PICTURES ITS ELEMENT, AND NOTHING ELSE IN THE STUDIO WEARS THAT PICTURE.
//
// This table is read three times over - the add panel's tiles, the Layers rows, the
// inspector's element header - so a mark chosen here is an element's identity everywhere.
// It used to borrow from the rail and the toolbars: Stack and Vstack shared one layered
// diamond that was ALSO the Map destination, Scaffold wore the Screen window, Flow wore the
// Agent wand, Hstack wore a bare right arrow, Button wore the select cursor and Textfield an
// edit pencil - marks for OTHER operations, so the shelf said "select" and "edit" where it
// meant "a button" and "a field".
//
// The element vocabulary is now its own tier: `dsx.el.*` in the icon corpus, drawn for the
// shape of the thing (a column of bars is a vstack; a row of bars is an hstack; a page
// skeleton is a scaffold; a field outline with a caret is a textfield; a filled rounded rect
// with a label knocked out of it is a button). Every name here resolves in
// OpenSource/Conformance/icons/sf-map.json - an unmapped name draws the placeholder ring,
// which is exactly the wrong look for a shelf.
const ELEMENT_ICONS: Record<string, string> = {
  stack: "dsx.el.stack", vstack: "dsx.el.vstack", hstack: "dsx.el.hstack",
  // Depth, not a plain box: without a row here a Zstack fell through to the default mark and
  // wore the same rounded square as a Stack - two different containers, one bitmap.
  zstack: "dsx.el.zstack",
  scroll: "chevron.up.chevron.down", spacer: "arrow.up.left.and.arrow.down.right",
  divider: "minus", scaffold: "dsx.el.scaffold", flow: "dsx.el.flow", grid: "dsx.el.grid",
  list: "music.note.list", carousel: "dsx.el.carousel", pager: "dsx.el.pager",
  split: "dsx.el.split",
  refreshable: "arrow.clockwise", Accordion: "chevron.down", MenuBar: "ellipsis",
  ChatBubble: "person.wave.2", ProgressRing: "timer", Skeleton: "dsx.el.skeleton",
  Table: "doc.on.clipboard", image: "photo.on.rectangle", progress: "timer",
  qrcode: "faceid", spinner: "dsx.el.spinner", text: "note.text", button: "dsx.el.button",
  textfield: "dsx.el.textfield", textarea: "note.text", toggle: "checkmark.circle.fill",
  slider: "slider.horizontal.3", calendar: "clock.fill", datepicker: "clock.fill",
  picker: "chevron.up.chevron.down", combobox: "chevron.up.chevron.down",
  Checkbox: "checkmark.square.fill", RadioGroup: "record.circle", otp: "lock.fill",
  form: "doc.on.clipboard", field: "dsx.el.textfield", video: "play.rectangle.fill",
  audio: "waveform", lottie: "dsx.el.animation", rive: "dsx.el.animation",
  chart: "dsx.el.chart",
  map: "dsx.el.map", sheet: "square.and.arrow.up", alert: "exclamationmark.triangle.fill",
  menu: "ellipsis", contextmenu: "ellipsis", popover: "dsx.el.popover",
  Drawer: "dsx.el.drawer",
  lightbox: "photo.on.rectangle", confirmDialog: "checkmark.circle.fill",
  WebView: "dsx.el.webview", DSXWebView: "dsx.el.webview", DSXView: "dsx.el.surface",
  canvas: "pencil.line",
  Scene3D: "gyroscope", Scene360: "dsx.el.scene",
};

/** Default markup per inserted element: self-closed, with the one attribute that makes it
 *  visible immediately (a text needs text; a button needs a label). */
const ELEMENT_MARKUP: Record<string, string> = {
  text: '<text value="Text"/>',
  button: '<button value="Button"/>',
  image: '<image src="https://placehold.co/200" style="width: 200px; height: 200px"/>',
  stack: '<stack style="padding: 12px; gap: 0.5rem"></stack>',
  hstack: '<hstack style="gap: 0.5rem; align-items: center"></hstack>',
  scroll: "<scroll></scroll>",
  textfield: '<textfield placeholder="Type here"/>',
};

function elementPanel(catalog: unknown): unknown[] {
  const elements = isRecord(catalog) && isRecord(catalog["elements"]) ? catalog["elements"] : {};
  const out: unknown[] = [];
  for (const [id, label, icon] of PANEL_CATEGORIES) {
    const items = Object.entries(elements)
      .filter(([, v]) => isRecord(v) && v["category"] === id)
      .map(([tag]) => ({
        tag,
        label: titleCase(tag),
        icon: ELEMENT_ICONS[tag] ?? icon,
        markup: ELEMENT_MARKUP[tag] ?? `<${tag}/>`,
      }))
      .sort((a, b) => (a.label < b.label ? -1 : 1));
    if (items.length > 0) out.push({ id, label, items });
  }
  return out;
}

/** The start pill's human name: what makes this body run. */
/**
 * The AGENT FACE of one document, keyed by the action each tool names.
 *
 * Both faces answer here, because the logic plane draws both kinds of document and an
 * author asking "can an agent run this?" is asking one question either way: a `<tool>` head
 * row in a screen is WebMCP (the agent in the user's own browser), a `<tool>` body row in a
 * `<server>` document is the /mcp face (any MCP client). The arguments are DERIVED from the
 * named action in both cases - this function never invents a shape.
 */
type AgentFace = {
  name: string;
  description: string;
  mutates: string;
  inputs: string[];
  face: "page" | "server";
};

function agentFaceOf(name: string, source: string): Map<string, AgentFace> {
  const out = new Map<string, AgentFace>();
  if (name.startsWith("server/")) {
    try {
      const doc = readServerDocument(source, name, basename(name).replace(/\.dsx$/, ""));
      for (const [tool, row] of Object.entries(doc.mcp)) {
        out.set(row.action, {
          name: tool,
          description: row.description,
          mutates: row.mutates ?? "",
          inputs: Object.keys(doc.actions[row.action]?.inputs ?? {}),
          face: "server",
        });
      }
    } catch {
      // An unreadable backend is the server endpoint's story to tell, not the logic plane's.
    }
    return out;
  }
  let root: XmlNode;
  try {
    root = parseDsx(source);
  } catch {
    return out;
  }
  const head = root.children.find((c) => c.tag === "head");
  const rows: ToolRow[] = [];
  const inputs = new Map<string, readonly string[]>();
  for (const decl of head?.children ?? []) {
    if (decl.tag === "tool") {
      const row: ToolRow = { action: decl.attrs["action"] ?? "", description: decl.attrs["description"] ?? "" };
      if (decl.attrs["as"] !== undefined) row.as = decl.attrs["as"];
      if (decl.attrs["mutates"] !== undefined) row.mutates = decl.attrs["mutates"];
      rows.push(row);
    }
    const as = decl.attrs["as"];
    if (decl.tag === "action" && as !== undefined) {
      inputs.set(as, Object.keys(decl.attrs).filter((k) => !HEAD_INPUT_SKIP.has(k)));
    }
  }
  for (const descriptor of projectTools(rows, inputs).descriptors) {
    const row = rows.find((r) => (r.as ?? r.action) === descriptor.name);
    if (row === undefined) continue;
    out.set(row.action, {
      name: descriptor.name,
      description: descriptor.description,
      mutates: row.mutates ?? "",
      inputs: Object.keys(descriptor.inputSchema.properties),
      face: "page",
    });
  }
  return out;
}

function triggerTitle(body: LogicBody, agent?: AgentFace): string {
  // A tool-backed action is not started by a tap or a route: an AGENT starts it. The entry
  // node of the drawing is exactly where that belongs, so the canvas reads "Agent · addTodo"
  // and the arguments below it are the ones a model supplies.
  if (agent !== undefined) return `Agent \u00b7 ${agent.name}`;
  if (body.kind === "handler") {
    const m = /^on:([\w.]+)/.exec(body.id);
    return m === null ? body.name : `On ${titleCase(m[1]!.split(".")[0]!)}`;
  }
  const label = body.kind === "action" ? "Action" : body.kind === "formula" ? "Formula" : "Computed";
  return `${label} · ${titleCase(body.name)}`;
}

/** The optional `within` a flow edit may name: the formula the operand belongs to. */
function parseWithin(raw: unknown, length: number): Span | undefined {
  if (!isRecord(raw)) return undefined;
  const start = raw["start"], end = raw["end"];
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= length;
  return ok(start) && ok(end) && start < end ? { start, end } : undefined;
}

/** Validate one wire op into a FlowEditOp, bounds-checked against the body. */
function parseFlowOp(raw: Record<string, unknown>, length: number): FlowEditOp | null {
  const within = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= length;
  const span = (v: unknown): { start: number; end: number } | null =>
    isRecord(v) && within(v["start"]) && within(v["end"]) && (v["start"] as number) <= (v["end"] as number)
      ? { start: v["start"] as number, end: v["end"] as number }
      : null;
  if (raw["op"] === "insert" && within(raw["at"]) && typeof raw["text"] === "string" && raw["text"].length > 0 && raw["text"].length < 10_000) {
    return { op: "insert", at: raw["at"], text: raw["text"] };
  }
  if (raw["op"] === "replace" && typeof raw["text"] === "string" && raw["text"].length < 10_000) {
    const sp = span(raw["span"]);
    return sp === null ? null : { op: "replace", span: sp, text: raw["text"] };
  }
  if (raw["op"] === "remove") {
    const sp = span(raw["span"]);
    return sp === null ? null : { op: "remove", span: sp };
  }
  if (raw["op"] === "move" && within(raw["to"])) {
    const sp = span(raw["span"]);
    return sp === null ? null : { op: "move", span: sp, to: raw["to"] as number };
  }
  return null;
}

// ── the write gate: what a graph is allowed to put in a file ─────────────────────────
//
//  A text editor may let an author type garbage; a graph must never write garbage FOR them.
//  Four properties stand between a visual edit and the file - faithful encoding, the operand
//  rule, the seam, and the formula the operand sits in - and every one is checked before a
//  byte moves. They live here rather than in the projection deliberately: the projection is
//  one client of this door, and a door that trusts its client is not a door.

/** A COMPLETE expression: it parses exactly, it spells at least one token, and every literal
 *  it opens is closed. Both halves are needed. The lexer runs an unterminated quote to the
 *  end of its input, so `'` alone reads as a well-formed string and only the closing
 *  character settles it; and a span holding nothing but a comment lexes to no tokens at all,
 *  which parses fine and is still not a value. */
function completeExpression(text: string): boolean {
  const parsed = parseExpression(text, { start: 0, end: text.length }, "none");
  if (!parsed.exact || parsed.tokens === 0) return false;
  for (const tok of lexExpression(text, 0, text.length)) {
    const raw = text.slice(tok.start, tok.end);
    if (tok.kind === "str" && (raw.length < 2 || raw[raw.length - 1] !== raw[0])) return false;
    if (tok.kind === "tpl" && (raw.length < 2 || !raw.endsWith("`"))) return false;
    if (tok.kind === "regex" && !/\/[a-z]*$/.test(raw)) return false;
  }
  return true;
}

/** The encoder must be able to carry the author's characters INTO the file and back out
 *  again. A code-tag body resolves its three entities only OUTSIDE quoted spans, so an
 *  encoder that escapes `&` everywhere turns a literal ampersand into the four characters
 *  `&amp;` on the way in and never turns it back: the string the program holds stops being
 *  the string the author typed, and every further edit adds another `amp;`. Refusing beats
 *  writing a value nobody asked for. */
function encodesFaithfully(text: string, context: BodyContext): boolean {
  if (context === "none") return true;
  const encoded = encodeForBody(text, context);
  return decodeRange(encoded, { start: 0, end: encoded.length }, context).plain === text;
}

type SeamToken = { kind: string; text: string };

/** The token runs on either side of a changed region, plus whether the region's own edges
 *  fall BETWEEN tokens rather than inside one. */
function seamOf(src: string, from: number, to: number): { head: SeamToken[]; tail: SeamToken[]; clean: boolean } {
  const head: SeamToken[] = [];
  const tail: SeamToken[] = [];
  let clean = true;
  for (const tok of lexExpression(src, 0, src.length)) {
    if (tok.end <= from) head.push({ kind: tok.kind, text: src.slice(tok.start, tok.end) });
    else if (tok.start >= to) tail.push({ kind: tok.kind, text: src.slice(tok.start, tok.end) });
    else if (tok.start < from || tok.end > to) clean = false;
  }
  return { head, tail, clean };
}

function sameTokens(a: SeamToken[], b: SeamToken[]): boolean {
  return a.length === b.length && a.every((t, i) => t.kind === b[i]!.kind && t.text === b[i]!.text);
}

/** THE SEAM LAW: a splice may change only the bytes it names, and only the TOKENS those
 *  bytes spell. Writing `0` over the receiver of `rows[0].items` touches no byte outside the
 *  span and still corrupts the file, because the `0` and the `.` beside it fuse into one
 *  number - the damage lands at the seam, in bytes nobody edited. Comparing the token runs
 *  outside the changed region catches every such fusion, whichever operation produced it. */
function seamHolds(prev: string, next: string, from: number, to: number): boolean {
  const before = seamOf(prev, from, to);
  const after = seamOf(next, from, to + (next.length - prev.length));
  return before.clean && after.clean
    && sameTokens(before.head, after.head) && sameTokens(before.tail, after.tail);
}

/** The region an op rewrites, in the body's own bytes. Everything outside it is untouched by
 *  construction, which is what makes the seam comparison meaningful. A move rewrites two
 *  places, so its region is their hull. */
function editedRegion(op: FlowEditOp): Span {
  if (op.op === "insert") return { start: op.at, end: op.at };
  if (op.op === "move") {
    return { start: Math.min(op.span.start, op.to), end: Math.max(op.span.end, op.to) };
  }
  return { start: op.span.start, end: op.span.end };
}

/** The spans an author types FREE TEXT into: a whole statement, and the comment a statement
 *  owns. Everything else a replace can address is an OPERAND inside a statement - which is
 *  exactly what the expression canvas edits - and an operand may only ever be replaced by
 *  another complete expression. */
function freeTextSpans(flow: Flow): Set<string> {
  const out = new Set<string>();
  for (const node of flow.nodes) {
    if (node.span !== undefined) out.add(`${node.span.start}:${node.span.end}`);
    if (node.note !== undefined) out.add(`${node.note.span.start}:${node.note.span.end}`);
  }
  return out;
}

/** THE SPLICE GATE, expressed over the bytes rather than over the operation: what the file
 *  held at `at`, what it holds there now, and nothing about who asked. Both doors share it -
 *  the statement canvas through `refuseUnsafeEdit`, the expression canvas through the same
 *  replace - and the safety harness drives it directly. */
export function refuseUnsafeSplice(
  prev: string, next: string, at: Span, context: BodyContext, freeText: ReadonlySet<string>,
  within?: Span,
): string | null {
  if (!freeText.has(`${at.start}:${at.end}`)) {
    const held = decodeRange(prev, at, context).plain;
    const wrote = decodeRange(next, { start: at.start, end: at.end + (next.length - prev.length) }, context).plain;
    if (!completeExpression(held)) {
      return "this span is not a complete expression, so its drawing is not authoritative - "
        + "edit the whole statement instead";
    }
    if (!completeExpression(wrote)) {
      return "an operand may only be replaced by a complete expression";
    }
  }
  if (!seamHolds(prev, next, at.start, at.end)) {
    return "that edit would change how the bytes AROUND it read - the new text fuses with "
      + "the code beside it";
  }
  // THE FORMULA THE OPERAND SITS IN. A splice can be locally perfect and still break the
  // expression around it: `{ id }` is one span that is both a key and a value, so writing
  // any other expression over it produces an object with no key at all. Nothing local can
  // see that, so whoever knows the enclosing range names it - the expression canvas knows it
  // because it is the range it asked for a drawing of.
  if (within !== undefined) {
    const heldWithin = decodeRange(prev, within, context).plain;
    if (completeExpression(heldWithin)) {
      const after = { start: within.start, end: within.end + (next.length - prev.length) };
      if (!completeExpression(decodeRange(next, after, context).plain)) {
        return "that edit would break the formula around it";
      }
    }
  }
  return null;
}

/** The formula an operand sits inside, when the body itself says what it is: the enclosing
 *  statement's own bytes, but only where they spell one complete expression. A statement like
 *  `let sum = 0` is not an expression and answers nothing, which is the honest outcome - the
 *  client that drew the formula is the one that knows its range, and names it. */
function enclosingFormula(body: string, at: Span, context: BodyContext, flow: Flow): Span | undefined {
  let best: Span | undefined;
  for (const node of flow.nodes) {
    const span = node.span;
    if (span === undefined) continue;
    if (span.start > at.start || span.end < at.end) continue;
    if (best !== undefined && span.end - span.start >= best.end - best.start) continue;
    if (completeExpression(decodeRange(body, span, context).plain)) best = span;
  }
  return best;
}

/** The write gate, in one place: the reason this edit must not reach the file, or null.
 *
 *  Order matters only for the message a person reads - each clause is independent, and each
 *  one is a way a visual editor has corrupted a file rather than a hypothetical. */
function refuseUnsafeEdit(
  prev: string, next: string, op: FlowEditOp, context: BodyContext, flow: Flow,
  namedWithin?: Span,
): string | null {
  if ((op.op === "insert" || op.op === "replace") && !encodesFaithfully(op.text, context)) {
    return "that text cannot be written into this body without changing what it says - "
      + "an entity inside a string literal would be escaped again on the way in";
  }
  // An OPERAND, not a statement and not a comment: the only thing a formula canvas addresses,
  // and the one span where free text is not the author's to type. A graph that can put a lone
  // `)` or an unclosed quote into an argument is a graph that can break a file by being used.
  // An insert or a move never lands inside one - it addresses a connector or a whole
  // statement - so only a replace is measured against the operand rule.
  const region = editedRegion(op);
  const key = `${region.start}:${region.end}`;
  const freeText = op.op === "replace" ? freeTextSpans(flow) : new Set([key]);
  const within = op.op === "replace" && !freeText.has(key)
    ? (namedWithin ?? enclosingFormula(prev, region, context, flow)) : undefined;
  return refuseUnsafeSplice(prev, next, region, context, freeText, within);
}

/**
 * [S-BOUNDARY] A document for the READ-ONLY projections: a component document, or a server
 * one addressed by its project-relative `server/…` path.
 *
 * Separate from `resolveDocument` on purpose. That function is the WRITE boundary the three
 * editing endpoints share, and widening it to reach `server/` would widen all three at once.
 * The logic and graph projections never write, so they can see more, and the difference being
 * two functions rather than a flag is what keeps that true when somebody edits one of them.
 */
function resolveReadableDocument(config: ProjectConfig, name: string): string | null {
  const component = resolveDocument(config, name);
  if (component !== null) return component;
  if (!name.startsWith("server/")) return null;
  return resolveServerDocument(config, name.slice("server/".length));
}

/** Read a document for the structural endpoints, or answer why it could not be read. */
function readDocument(
  config: ProjectConfig,
  name: string,
  res: ServerResponse,
): { abs: string; source: string } | null {
  const abs = resolveDocument(config, name);
  if (abs === null) {
    sendJson(res, 404, { reason: "unknown_document", message: `${name} is not a .dsx under a component root` });
    return null;
  }
  if (!existsSync(abs)) {
    sendJson(res, 404, { reason: "unknown_document", message: `${name} does not exist` });
    return null;
  }
  return { abs, source: readFileSync(abs, "utf8") };
}

// ── THE CONTEXT BUNDLE (master plan P16): their model sees what they see ──────────────────
//
//  We render and simulate the app server-side, so an agent's context is a FUNCTION CALL,
//  not a screenshot request. One bundle per document: the source bytes, the live state
//  snapshot the running page last posted (the same channel the data-store panel reads),
//  the SSR of that screen WITH that state (renderToString - text-first, cheap, diffable),
//  and the P3 sample declarations. Exposed as MCP resources on /edit/mcp, so the in-Studio
//  composer and any outside agent get the SAME eyes. The vision raster (P4's local-Chromium
//  tier) is the recorded later increment - never assumed.

export type ContextBundle = {
  document: string;
  source: string;
  /** the live snapshot verbatim (null until the app page posts one) */
  state: unknown;
  /** SSR of this document with the snapshot's vars; null when it does not compile alone */
  ssr: string | null;
  samples: Array<{ kind: "attribute" | "variable" | "api"; name: string; sample: string }>;
};

export function buildContextBundle(config: ProjectConfig, name: string, stateJson: string): ContextBundle | null {
  const file = resolveDocument(config, name);
  if (file === null || !existsSync(file)) return null;
  const source = readFileSync(file, "utf8");

  let state: unknown = null;
  if (stateJson !== "") {
    try { state = JSON.parse(stateJson); } catch { state = null; }
  }
  // the snapshot's vars become the SSR scope - the same values the running page holds
  const vars: { [k: string]: unknown } = {};
  const varRows = (state as { vars?: Array<{ name?: unknown; value?: unknown }> } | null)?.vars;
  if (Array.isArray(varRows)) {
    for (const row of varRows) {
      if (row !== null && typeof row === "object" && typeof row.name === "string") vars[row.name] = row.value;
    }
  }

  const componentName = basename(file, ".dsx");
  const roots = packageRoots(config);
  let ssr: string | null = null;
  try {
    const registry = buildRegistry(
      roots.map((dir) => (dir === config.root ? { dir, scheme: config.scheme, app: true } : { dir })),
    );
    const qualified = `${config.scheme}.${componentName}`;
    if (registry.components[qualified] !== undefined) {
      ssr = renderToString(registry, qualified, vars as Parameters<typeof renderToString>[2]);
    }
  } catch { ssr = null; }

  const samples: ContextBundle["samples"] = [];
  try {
    const head = compileComponent(componentName, config.scheme, source).head;
    for (const row of head.attributes) {
      if (row.sample !== undefined) samples.push({ kind: "attribute", name: row.as, sample: row.sample });
    }
    for (const row of head.variables) {
      if (row.sample !== undefined) samples.push({ kind: "variable", name: row.as, sample: row.sample });
    }
    for (const row of head.apis) {
      if (row.sample !== undefined) samples.push({ kind: "api", name: row.as, sample: row.sample });
    }
  } catch { /* an uncompilable head simply carries no samples */ }

  return { document: name, source, state, ssr, samples };
}

// ── THE AGENT TURN (master plan P16 / agent-experience G2): the in-Studio agent ─────────
//
//  A turn is a LIFECYCLE, not a request: POST starts it and answers immediately with a
//  turn id, GET polls the live state (which tool is running, what it changed), and the
//  Studio renders the run as it happens - the reference-class agent feel without a
//  streaming transport. The P16 context bundle folds into the system prompt (their model
//  sees what they see) and the model's hands are the AUDITED DOORS - every tool call is
//  a loopback request to this same server, so the agent can do exactly what the Studio
//  can and nothing else. Three guarantees the surface is built on:
//
//  · EVERY WRITE IS A CARD: a save carries +/- line counts and a unified diff, computed
//    against the bytes it replaced - the user reviews what happened, not a claim.
//  · EVERY TURN IS A CHECKPOINT: the first write to each file records the bytes before,
//    and one revert restores all of them (a file the turn created is removed again).
//  · A SECRET NEVER MEETS THE MODEL: request_secret PARKS the turn and the Studio renders
//    a secure input; the value lands write-only in the project .env (gitignore-guarded)
//    and the process environment, the transcript records only the NAME, and no endpoint
//    ever reads it back. Write-only, like a platform secret store.

const AI_CHAT_ROUNDS = 8;
const AI_TURN_CAP = 16;
const AI_SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

const AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_document",
      description: "Read the current source of a project document (a .dsx file), e.g. Components/App.dsx.",
      parameters: {
        type: "object",
        properties: { document: { type: "string", description: "the document name as listed" } },
        required: ["document"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_document",
      description: "Replace the full source of a project document. Send the COMPLETE new .dsx source; keep every line you are not changing byte-for-byte.",
      parameters: {
        type: "object",
        properties: {
          document: { type: "string", description: "the document name, e.g. Components/App.dsx" },
          source: { type: "string", description: "the complete new document source" },
        },
        required: ["document", "source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_theme_tokens",
      description: "Set project theme tokens (CSS custom properties like --dsx-accent) with a light and a dark value each. Tokens you do not name keep their current values.",
      parameters: {
        type: "object",
        properties: {
          tokens: {
            type: "object",
            description: '{"--dsx-accent": {"light": "#e11d48", "dark": "#fb7185"}}',
            additionalProperties: {
              type: "object",
              properties: { light: { type: "string" }, dark: { type: "string" } },
            },
          },
        },
        required: ["tokens"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_secret",
      description: "Ask the user for a secret (an API key, a token, a credential) through a secure input in the studio. The value is stored write-only in the project environment under the name you give and is NEVER shown to you - read it by name where secrets are declared. Use ENV_STYLE names like STRIPE_SECRET_KEY.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "the environment name, e.g. STRIPE_SECRET_KEY" },
          reason: { type: "string", description: "one plain sentence: what the secret is for" },
        },
        required: ["name", "reason"],
      },
    },
  },
];

function buildAgentSystem(config: ProjectConfig, document: string, stateJson: string, extras: string[] = []): string {
  const lines = [
    "You are the Despia Studio agent. The user is building an app whose UI is DSX markup:",
    "each .dsx document is a <head> of declarations (variables, apis, actions) and a body of",
    "elements. You change the project ONLY through the tools; keep edits minimal and preserve",
    "everything you are not changing byte-for-byte. When a feature needs an API key or other",
    "credential, use request_secret - never ask for it in plain chat and never invent one.",
    "Answer in one or two plain sentences - what you changed, or what you found.",
  ];
  for (const extra of extras) lines.push("", extra);
  const bundle = document === "" ? null : buildContextBundle(config, document, stateJson);
  if (bundle !== null) {
    lines.push("", `The user is looking at ${bundle.document}. Its source:`, "", bundle.source);
    if (bundle.state !== null) lines.push("", "The running app's live state:", JSON.stringify(bundle.state));
    if (bundle.ssr !== null) lines.push("", "The screen as currently rendered (server-side):", bundle.ssr.slice(0, 6000));
    if (bundle.samples.length > 0) lines.push("", "Declared sample values:", JSON.stringify(bundle.samples));
  }
  return lines.join("\n");
}

/** A line diff for the edit cards: +/- counts and a compact unified body. Plain LCS over
 *  lines - documents are small, and the card needs review truth, not patch tooling. */
export function lineDiff(before: string, after: string): { added: number; removed: number; text: string } {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");
  const n = a.length, m = b.length;
  const CAP = 400;
  if (n > CAP || m > CAP) {
    return { added: m, removed: n, text: "(the change is too large to diff line by line)" };
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const rows: string[] = [];
  let added = 0, removed = 0, i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push(`  ${a[i]}`); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { rows.push(`- ${a[i]}`); removed++; i++; }
    else { rows.push(`+ ${b[j]}`); added++; j++; }
  }
  for (; i < n; i++) { rows.push(`- ${a[i]}`); removed++; }
  for (; j < m; j++) { rows.push(`+ ${b[j]}`); added++; }
  // keep only changed hunks with one context line each side - the card is a review, not the file
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.startsWith("+") || row.startsWith("-")) { keep.add(index - 1); keep.add(index); keep.add(index + 1); }
  });
  const out: string[] = [];
  let last = -2;
  rows.forEach((row, index) => {
    if (!keep.has(index)) return;
    if (index > last + 1 && out.length > 0) out.push("\u22ef");
    out.push(row);
    last = index;
  });
  const text = out.join("\n");
  return { added, removed, text: text.length > 4000 ? `${text.slice(0, 4000)}\n\u22ef` : text };
}

// ── THE VISUAL MARKUP DIFF: what changed, drawn on the real render ─────────────────────
//
//  A structural diff of the markup trees (checkpoint vs file of record), addressed by the
//  SAME preorder nids the SSR stamps as data-dsx-n - so an annotation is a box around the
//  real element, not a guess. Additions and attribute edits annotate the AFTER render
//  (green +, amber ±); removals annotate the BEFORE render (red −, the element faded and
//  struck in place, where it used to live). Scale is handled by GROUPING: an added subtree
//  is ONE box at its root, and a run of consecutive added/removed siblings is ONE box
//  labeled with the element count - half a page removed reads as one region, never as a
//  hundred glowing borders.

export interface VisualAnnotation { kind: "add" | "del" | "chg"; nids: number[]; label: string; }

function treeSig(node: TreeNode): string {
  if (node.code || node.children.length === 0) return node.source;
  return `${node.tag}|${JSON.stringify(node.attrs)}|[${node.children.map(treeSig).join(",")}]`;
}

function subtreeCount(node: TreeNode): number {
  return 1 + node.children.reduce((n, c) => n + subtreeCount(c), 0);
}

/** the nid door's numbering, verbatim: preorder from the root (0), head subtree skipped */
function nidsOf(root: TreeNode): Map<TreeNode, number> {
  const map = new Map<TreeNode, number>();
  let count = -1;
  const walk = (node: TreeNode): void => {
    count += 1;
    map.set(node, count);
    for (const child of node.children) {
      if (node.path.length === 0 && child.tag === "head") continue;
      walk(child);
    }
  };
  walk(root);
  return map;
}

function shallowDiffers(b: TreeNode, a: TreeNode): boolean {
  if (JSON.stringify(b.attrs) !== JSON.stringify(a.attrs)) return true;
  const leafB = b.code || b.children.length === 0;
  const leafA = a.code || a.children.length === 0;
  return leafB !== leafA || (leafA && b.source !== a.source);
}

export function markupDiff(beforeSrc: string, afterSrc: string): { before: VisualAnnotation[]; after: VisualAnnotation[] } {
  const out = { before: [] as VisualAnnotation[], after: [] as VisualAnnotation[] };
  let beforeRoot: TreeNode | null = null;
  let afterRoot: TreeNode | null = null;
  try { afterRoot = projectTree(afterSrc); } catch { return out; }
  try { beforeRoot = beforeSrc === "" ? null : projectTree(beforeSrc); } catch { beforeRoot = null; }
  const nidA = nidsOf(afterRoot);
  if (beforeRoot === null) {
    out.after.push({ kind: "add", nids: [0], label: `+${subtreeCount(afterRoot)}` });
    return out;
  }
  const nidB = nidsOf(beforeRoot);

  const pushRun = (list: VisualAnnotation[], kind: "add" | "del", run: TreeNode[], nids: Map<TreeNode, number>): void => {
    if (run.length === 0 || list.length >= 40) return;
    const count = run.reduce((n, node) => n + subtreeCount(node), 0);
    const glyph = kind === "add" ? "+" : "\u2212";
    list.push({ kind, nids: run.map((n) => nids.get(n)!), label: count === 1 ? glyph : `${glyph}${count}` });
  };

  const align = (bKids: TreeNode[], aKids: TreeNode[]): void => {
    const n = bKids.length, m = aKids.length;
    if (n > 400 || m > 400) return;
    const sigB = bKids.map(treeSig), sigA = aKids.map(treeSig);
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = sigB[i] === sigA[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0, j = 0;
    const gaps: Array<{ b: TreeNode[]; a: TreeNode[] }> = [];
    let gap = { b: [] as TreeNode[], a: [] as TreeNode[] };
    while (i < n && j < m) {
      if (sigB[i] === sigA[j]) { gaps.push(gap); gap = { b: [], a: [] }; i++; j++; }
      else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { gap.b.push(bKids[i]!); i++; }
      else { gap.a.push(aKids[j]!); j++; }
    }
    for (; i < n; i++) gap.b.push(bKids[i]!);
    for (; j < m; j++) gap.a.push(aKids[j]!);
    gaps.push(gap);

    for (const g of gaps) {
      // same-tag items pair up as EDITS of one element; the rest are true adds/removals
      const paired = Math.min(g.b.length, g.a.length);
      let k = 0;
      for (; k < paired; k++) {
        const bn = g.b[k]!, an = g.a[k]!;
        if (bn.tag !== an.tag) break;
        if (shallowDiffers(bn, an) && out.after.length < 40) {
          out.after.push({ kind: "chg", nids: [nidA.get(an)!], label: "\u00b1" });
        }
        align(bn.children.filter((c) => c.tag !== "head"), an.children.filter((c) => c.tag !== "head"));
      }
      pushRun(out.before, "del", g.b.slice(k), nidB);
      pushRun(out.after, "add", g.a.slice(k), nidA);
    }
  };

  align(
    beforeRoot.children.filter((c) => c.tag !== "head"),
    afterRoot.children.filter((c) => c.tag !== "head"),
  );
  return out;
}

/** which canvas the card shows: removals live on the before render, everything else after */
export function visualMode(beforeSrc: string, afterSrc: string): "none" | "before" | "after" | "both" {
  const ann = markupDiff(beforeSrc, afterSrc);
  const dels = ann.before.length > 0;
  const adds = ann.after.length > 0;
  if (dels && adds) return "both";
  if (dels) return "before";
  if (adds) return "after";
  return "none";
}

/** One tool-activity row as the Studio renders it. */
export interface AgentActivity {
  tool: string;
  detail: string;
  ok: boolean;
  document?: string;
  added?: number;
  removed?: number;
  diff?: string;
  /** the diff as TOKENIZED lines for the reviewer-grade render: m = "+" | "-" | " " | "e"
   *  (elision), toks = syntax tokens from the shared prose tokenizer */
  lines?: Array<{ m: string; toks: Array<{ k: string; t: string }> }>;
  /** which annotated canvas the card shows (visualMode over checkpoint vs disk) */
  visual?: "none" | "before" | "after" | "both";
}

/** The card's diff, tokenized line by line so the Studio renders it reviewer-grade. */
function tokenizedDiff(diffText: string, language: string): AgentActivity["lines"] {
  if (diffText === "") return [];
  return diffText.split("\n").slice(0, 200).map((row) => {
    if (row === "\u22ef") return { m: "e", toks: [] };
    const m = row.startsWith("+") ? "+" : row.startsWith("-") ? "-" : " ";
    const body = row.length >= 2 ? row.slice(2) : "";
    return { m, toks: tokenizeCode(language, body).map((t) => ({ k: t.kind, t: t.text })) };
  });
}

/** One agent turn's full lifecycle state, held in-process beside the session key. */
export interface AgentTurn {
  id: string;
  status: "running" | "needs_secret" | "done" | "failed";
  document: string;
  model: string;
  reply: string;
  error: string;
  activity: AgentActivity[];
  secretRequest: { name: string; reason: string } | null;
  /** file (project-relative) -> bytes before this turn's first write; null = did not exist */
  checkpoint: { [file: string]: string | null };
  reverted: boolean;
  rounds: number;
  transcript: unknown[];
  pendingSecretCall: string | null;
}

function agentTurnView(turn: AgentTurn): object {
  return {
    turn: turn.id,
    status: turn.status,
    reply: turn.reply,
    error: turn.error,
    activity: turn.activity,
    secretRequest: turn.secretRequest,
    edits: Object.keys(turn.checkpoint).length,
    reverted: turn.reverted,
  };
}

/** The project's write-only secret store: .env at the root, guarded by .gitignore, loaded
 *  into this process so locally served <server> routes resolve the name immediately. The
 *  value is never logged and no endpoint reads it back. */
export function writeProjectSecret(root: string, name: string, value: string): void {
  const envPath = join(root, ".env");
  const lines = existsSync(envPath)
    ? readFileSync(envPath, "utf8").split("\n").filter((line) => line.length > 0)
    : [];
  const kept = lines.filter((line) => !line.startsWith(`${name}=`));
  kept.push(`${name}=${value}`);
  writeFileSync(envPath, `${kept.join("\n")}\n`);
  const ignorePath = join(root, ".gitignore");
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  if (!ignore.split("\n").some((line) => line.trim() === ".env")) {
    writeFileSync(ignorePath, ignore.length === 0 || ignore.endsWith("\n") ? `${ignore}.env\n` : `${ignore}\n.env\n`);
  }
  process.env[name] = value;
}

/** Load an existing .env into the serving process at mount time (names only win when unset). */
function loadProjectEnv(root: string): void {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!AI_SECRET_NAME.test(name) || process.env[name] !== undefined) continue;
    process.env[name] = line.slice(eq + 1);
  }
}

/** Run one tool call through the audited doors. `self` is this server's own base URL. */
async function runAgentTool(
  config: ProjectConfig,
  self: string,
  admission: string,
  turn: AgentTurn,
  name: string,
  args: { [k: string]: unknown },
): Promise<{ ok: boolean; result: string; detail: string }> {
  const doc = typeof args["document"] === "string" ? args["document"] : "";
  if (name === "read_document") {
    const r = await selfFetch(admission, `${self}/edit/api/documents/${encodeURIComponent(doc)}`);
    if (!r.ok) return { ok: false, result: `refused (${r.status}): ${await r.text()}`, detail: `Could not read ${doc}` };
    return { ok: true, result: await r.text(), detail: `Read ${doc}` };
  }
  if (name === "save_document") {
    const source = typeof args["source"] === "string" ? args["source"] : "";
    const absolute = resolveDocument(config, doc);
    const before = absolute !== null && existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    const r = await selfFetch(admission, `${self}/edit/api/documents/${encodeURIComponent(doc)}`, { method: "PUT", body: source });
    if (!r.ok) return { ok: false, result: `refused (${r.status}): ${await r.text()}`, detail: `Could not save ${doc}` };
    checkpointOnWrite(turn, doc, before);
    const diff = lineDiff(before ?? "", source);
    const row = turn.activity[turn.activity.length - 1]!;
    row.document = doc;
    row.added = diff.added;
    row.removed = diff.removed;
    row.diff = diff.text;
    row.lines = tokenizedDiff(diff.text, "dsx");
    row.visual = visualMode(before ?? "", source);
    return { ok: true, result: "saved", detail: `${before === null ? "Created" : "Edited"} ${doc}` };
  }
  if (name === "set_theme_tokens") {
    // named tokens land OVER the current pins - the door's write is a full-map rewrite,
    // so the tool merges first; the sanitizing and the twin-shape emission stay the door's
    const themePath = join(config.root, "theme.css");
    const before = existsSync(themePath) ? readFileSync(themePath, "utf8") : null;
    const current = before !== null ? parseProjectTheme(before) : { light: {}, dark: {} };
    const tokens: { [css: string]: { light?: string; dark?: string } } = {};
    for (const css of new Set([...Object.keys(current.light), ...Object.keys(current.dark)])) {
      tokens[css] = { light: current.light[css], dark: current.dark[css] };
    }
    const named = isRecord(args["tokens"]) ? args["tokens"] : {};
    for (const [css, pair] of Object.entries(named)) {
      if (!isRecord(pair)) continue;
      tokens[css] = {
        light: typeof pair["light"] === "string" ? pair["light"] : tokens[css]?.light,
        dark: typeof pair["dark"] === "string" ? pair["dark"] : tokens[css]?.dark,
      };
    }
    const r = await selfFetch(admission, `${self}/edit/api/theme`, { method: "PUT", body: JSON.stringify({ tokens }) });
    if (!r.ok) return { ok: false, result: `refused (${r.status}): ${await r.text()}`, detail: "Could not write the theme" };
    checkpointOnWrite(turn, "theme.css", before);
    const after = existsSync(themePath) ? readFileSync(themePath, "utf8") : "";
    const diff = lineDiff(before ?? "", after);
    const row = turn.activity[turn.activity.length - 1]!;
    row.document = "theme.css";
    row.added = diff.added;
    row.removed = diff.removed;
    row.diff = diff.text;
    row.lines = tokenizedDiff(diff.text, "css");
    row.visual = "none";
    return { ok: true, result: "saved", detail: "Updated the theme" };
  }
  return { ok: false, result: `unknown tool: ${name}`, detail: `Unknown tool ${name}` };
}

function checkpointOnWrite(turn: AgentTurn, file: string, before: string | null): void {
  if (!Object.prototype.hasOwnProperty.call(turn.checkpoint, file)) turn.checkpoint[file] = before;
}

/** Drive a turn forward until it answers, parks on a secret, or runs out of rounds. Every
 *  await is against either the model endpoint or this server's own doors. */
async function continueAgentTurn(
  config: ProjectConfig,
  self: string,
  admission: string,
  aiBase: string,
  key: () => string | null,
  turn: AgentTurn,
): Promise<void> {
  try {
    while (turn.rounds < AI_CHAT_ROUNDS) {
      const sessionKey = key();
      if (sessionKey === null) { turn.status = "failed"; turn.error = "the model was disconnected mid-turn"; return; }
      turn.rounds += 1;
      const answer = await fetch(`${aiBase}/api/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: turn.model, messages: turn.transcript, tools: AI_TOOLS }),
      });
      if (!answer.ok) { turn.status = "failed"; turn.error = `the model endpoint answered ${answer.status}`; return; }
      const payload = (await answer.json()) as {
        choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
      };
      const message = payload.choices?.[0]?.message;
      if (message === undefined) { turn.status = "failed"; turn.error = "the completion carried no message"; return; }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (calls.length === 0) {
        turn.reply = typeof message.content === "string" ? message.content : "";
        turn.status = "done";
        return;
      }
      turn.transcript.push(message);
      for (const call of calls) {
        const name = call.function?.name ?? "";
        let args: { [k: string]: unknown } = {};
        try {
          const parsed = JSON.parse(call.function?.arguments ?? "{}");
          if (isRecord(parsed)) args = parsed;
        } catch { /* the tool answers through its refusal path */ }
        if (name === "request_secret") {
          const secretName = typeof args["name"] === "string" ? args["name"] : "";
          const reason = typeof args["reason"] === "string" ? args["reason"] : "";
          if (!AI_SECRET_NAME.test(secretName)) {
            turn.activity.push({ tool: name, detail: `Refused secret name ${JSON.stringify(secretName)}`, ok: false });
            turn.transcript.push({ role: "tool", tool_call_id: call.id ?? "", content: "refused: the name must be ENV_STYLE (A-Z, digits, underscores)" });
            continue;
          }
          if (turn.pendingSecretCall !== null) {
            turn.transcript.push({ role: "tool", tool_call_id: call.id ?? "", content: "refused: one secret request at a time" });
            continue;
          }
          // PARK: the tool's answer is written when the user provides the value
          turn.pendingSecretCall = call.id ?? "";
          turn.secretRequest = { name: secretName, reason };
          turn.activity.push({ tool: name, detail: `Requested ${secretName}`, ok: true });
          turn.status = "needs_secret";
          return;
        }
        turn.activity.push({ tool: name, detail: name === "read_document" ? `Reading ${args["document"] ?? ""}` : "Working", ok: true });
        const done = await runAgentTool(config, self, admission, turn, name, args);
        const row = turn.activity[turn.activity.length - 1]!;
        row.detail = done.detail;
        row.ok = done.ok;
        turn.transcript.push({ role: "tool", tool_call_id: call.id ?? "", content: done.result });
      }
    }
    turn.status = "failed";
    turn.error = "the turn ran out of rounds before the model answered";
  } catch (e) {
    turn.status = "failed";
    turn.error = e instanceof Error ? e.message : String(e);
  }
}

// ── THE CAPABILITY CHIPS (agent-experience G3): the composer menu IS the platform ──────
//
//  The reference products hardcode their native-feature menus; ours is GENERATED from the
//  package catalog, so it can never lag the platform. A picked chip resolves to the
//  module's real scheme and its config declaration, and rides the turn as catalog FACTS
//  in the system prompt - "add push" arrives as the push module with its required keys
//  attached. A bare OSS checkout without the catalog gets an honest empty list.

interface CapabilityChip {
  scheme: string;
  name: string;
  icon: string;
  tier: string;
  config: Array<{ key: string; name: string; desc: string; type: string }>;
}

function resolvePackageCatalog(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "ClosedSource", "PackageCatalog.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let capabilityRows: CapabilityChip[] | null = null;
function loadCapabilities(): CapabilityChip[] {
  if (capabilityRows !== null) return capabilityRows;
  const path = resolvePackageCatalog();
  if (path === null) return (capabilityRows = []);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      packages?: Array<{
        name?: unknown; scheme?: unknown; icon?: unknown; tier?: unknown; mandatory?: unknown;
        config?: { [key: string]: { friendly_name?: unknown; friendly_description?: unknown; type?: unknown } };
      }>;
    };
    capabilityRows = (raw.packages ?? [])
      .filter((row) => typeof row.scheme === "string" && row.scheme.length > 0 && typeof row.name === "string")
      .map((row) => ({
        scheme: row.scheme as string,
        name: row.name as string,
        icon: typeof row.icon === "string" ? row.icon : "",
        tier: typeof row.tier === "string" ? row.tier : "",
        config: Object.entries(row.config ?? {}).map(([key, c]) => ({
          key,
          name: typeof c.friendly_name === "string" ? c.friendly_name : key,
          desc: typeof c.friendly_description === "string" ? c.friendly_description.slice(0, 200) : "",
          type: typeof c.type === "string" ? c.type : "string",
        })),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch { capabilityRows = []; }
  return capabilityRows;
}

/** The attached chips as catalog FACTS for the system prompt. */
function capabilityFacts(schemes: string[]): string[] {
  const rows = loadCapabilities();
  const facts: string[] = [];
  for (const scheme of schemes.slice(0, 8)) {
    const row = rows.find((r) => r.scheme === scheme);
    if (row === undefined) continue;
    const keys = row.config.map((c) => `${c.key} (${c.name}${c.desc === "" ? "" : `: ${c.desc}`})`).join("; ");
    facts.push(`The user attached the ${row.name} capability - the module's bus scheme is \`${scheme}\` `
      + `(call it as dsx.module.${scheme}.<action>).${keys === "" ? "" : ` Its config declaration: ${keys}.`}`);
  }
  return facts;
}

// ── THE STRINGS TABLE (master plan P12): the per-key surface over the extractor ─────────
//
//  The English source string is the key (gettext-style, localization.md), so the table's
//  rows are EXTRACTED from the documents - exactly the strings the runtime localizes
//  (text/label value + inner text, the button family's label, field placeholders; static
//  templates only, an interpolation resolves before the seam). Columns are the languages
//  the project carries as `Strings.<tag>.json`. A write is BYTE-MINIMAL by construction:
//  the file is kept sorted-keys/2-space, so one key's change is one line's diff (the
//  plan's quantified gate).

const STRINGS_LANG = /^[a-z][a-z0-9-]*$/;
/** display attribute per tag - the mirror of the dom layer's bindDisplay call sites */
const DISPLAY_TAGS: { [tag: string]: "value" | "label" | "placeholder" } = {
  text: "value", label: "value",
  button: "label", pressable: "label", glassButton: "label", transport: "label", row: "label",
  textfield: "placeholder", input: "placeholder", securefield: "placeholder", searchbar: "placeholder",
};

function collectDisplayStrings(node: XmlNode, into: Map<string, number>): void {
  if (node.tag === "head") return;
  const attr = DISPLAY_TAGS[node.tag];
  if (attr !== undefined) {
    const value = attr === "value"
      ? (node.attrs["value"] ?? (node.text.trim().length > 0 ? node.text.trim() : undefined))
      : node.attrs[attr];
    if (value !== undefined && value.length > 0 && !value.includes("{{") && node.attrs["bind"] === undefined) {
      into.set(value, (into.get(value) ?? 0) + 1);
    }
  }
  for (const child of node.children) collectDisplayStrings(child, into);
}

function stringsTablePath(config: ProjectConfig, lang: string): string {
  return join(config.root, `Strings.${lang}.json`);
}

function readStringsTable(config: ProjectConfig, lang: string): { [key: string]: string } {
  const path = stringsTablePath(config, lang);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: { [key: string]: string } = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return {}; }
}

function writeStringsTable(config: ProjectConfig, lang: string, table: { [key: string]: string }): void {
  const path = stringsTablePath(config, lang);
  const keys = Object.keys(table).sort();
  // sorted keys + fixed indent = a one-key change is a one-line diff, deterministically
  const body = keys.length === 0
    ? "{}"
    : `{\n${keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(table[k]!)}`).join(",\n")}\n}`;
  writeFileSync(path, body + "\n");
}

function projectLanguages(config: ProjectConfig): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(config.root)) {
    const match = /^Strings\.([a-z][a-z0-9-]*)\.json$/.exec(entry);
    if (match !== null && match[1] !== "en") out.push(match[1]!);
  }
  return out.sort();
}

// ── CONSUMED TOKENS (master plan P15): which vocabulary each token actually drives ──────
//
//  A PURE PROJECTION over the css the app really ships - the kernel skin blocks (the
//  same set the SSR document embeds) plus the project's own compiled registry css - so
//  the theme sheet can say "radius drives button, textfield, card" without inventing a
//  runtime. Selectors humanize to their vocabulary word (`.dsx-button:hover` → button);
//  a project selector keeps its authored class name.

const SKIN_CSS_BLOCKS = [
  ELEMENTS_CSS, APPLICATION_ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, FORM_ELEMENTS_CSS,
  RICH_ELEMENTS_CSS, NATIVE_CONTROLS_CSS, GLOBAL_ELEMENTS_CSS,
];

function consumerName(selector: string): string | null {
  // a compiled sidecar selector is `[data-dsx-owner="App"] .hero` - the AUTHORED class
  // is the meaningful name, so the scope prefix is dropped before humanizing
  const scoped = /^\[data-dsx-owner="[^"]*"\]\s*(.*)$/.exec(selector.trim());
  const bare = (scoped !== null ? scoped[1]! : selector).trim();
  const first = bare.split(/[\s>+~(]/)[0] ?? "";
  const match = /^[.]([A-Za-z][\w-]*)/.exec(first) ?? /^([a-z][\w-]*)/.exec(first);
  if (match === null) return null;
  const raw = match[1]!;
  if (raw === "root" || raw === "host") return null;
  return raw.startsWith("dsx-") ? raw.slice(4) : raw;
}

/** Every rule in `css` whose body references `var(<token>` contributes its selectors'
 *  humanized names. Brace-depth tracked so @layer/@media groupings never read as rules. */
export function tokenConsumersIn(rawCss: string, tokens: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // comments first - prose like "(so the fill crossfades)" must never read as a selector
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
  let cursor = 0;
  const selectorStack: string[] = [];
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    const close = css.indexOf("}", cursor);
    if (open >= 0 && (close < 0 || open < close)) {
      const header = css.slice(cursor, open).trim();
      selectorStack.push(header);
      cursor = open + 1;
      continue;
    }
    if (close < 0) break;
    const body = css.slice(cursor, close);
    const header = selectorStack.pop() ?? "";
    if (!header.startsWith("@") && body.includes("var(")) {
      for (const token of tokens) {
        if (!body.includes(`var(${token}`)) continue;
        for (const part of header.split(",")) {
          const name = consumerName(part);
          if (name === null) continue;
          let set = out.get(token);
          if (set === undefined) out.set(token, set = new Set());
          set.add(name);
        }
      }
    }
    cursor = close + 1;
  }
  return out;
}

/** The resource face the edit-server MCP door adds over the toolchain tools. */
export type McpResourceContext = {
  list: () => Array<{ uri: string; name: string; description: string; mimeType: string }>;
  read: (uri: string) => { mimeType: string; text: string } | null;
  /** the project this door belongs to — every INSTALLED app's tool rows project as MCP
   *  tools from here (studio-apps.md §9.1), so the agent sitting in the Studio reaches a
   *  plugin the same way the terminal does. Absent, the toolchain's own tools still serve. */
  projectRoot?: string;
};

/** Who is on the other side of the MCP door. `lastSeen` is any rpc, not just initialize,
 *  so the Agents panel can say "connected" about a host that skipped a fresh handshake. */
export interface AgentPresence {
  client: { name: string; version: string } | null;
  lastSeen: number | null;
  calls: number;
}

/** The agent door (07-agent-plane): the SAME toolchain MCP the stdio command serves, over
 *  HTTP, so a host that speaks streamable HTTP connects to the RUNNING studio with one URL -
 *  no config file, no API key, loopback only (the edit server's own binding). Stateless by
 *  design: every POST is one JSON-RPC exchange, a notification answers 202, and the absence
 *  of a session id is the spec's stateless mode, not an omission. */
export function createMcpHttpHandler(context?: McpResourceContext): {
  presence: AgentPresence;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
} {
  const presence: AgentPresence = { client: null, lastSeen: null, calls: 0 };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== "POST") {
      res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
      res.end(JSON.stringify({ reason: "method_not_allowed", message: "MCP over HTTP is POSTed JSON-RPC" }));
      return true;
    }
    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { reason: "too_large", message: "request body exceeds the cap" });
      return true;
    }
    let request: { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: { [k: string]: unknown } };
    try {
      request = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return true;
    }
    presence.lastSeen = Date.now();
    if (request.method === "initialize") {
      const info = (request.params as { clientInfo?: { name?: unknown; version?: unknown } } | undefined)?.clientInfo;
      if (info !== undefined && typeof info.name === "string") {
        presence.client = { name: info.name, version: typeof info.version === "string" ? info.version : "" };
      }
    }
    if (request.method === "tools/call") presence.calls += 1;
    // The RESOURCE face (P16): the context bundles, answered here because they belong to
    // the RUNNING studio (project + live state), not to the stateless toolchain in mcp.ts.
    if (context !== undefined && request.method === "resources/list") {
      sendJson(res, 200, { jsonrpc: "2.0", id: request.id ?? null, result: { resources: context.list() } });
      return true;
    }
    if (context !== undefined && request.method === "resources/read") {
      const uri = String((request.params as { uri?: unknown } | undefined)?.uri ?? "");
      const content = context.read(uri);
      if (content === null) {
        sendJson(res, 200, {
          jsonrpc: "2.0", id: request.id ?? null,
          error: { code: -32002, message: `unknown resource ${uri}` },
        });
        return true;
      }
      sendJson(res, 200, {
        jsonrpc: "2.0", id: request.id ?? null,
        result: { contents: [{ uri, mimeType: content.mimeType, text: content.text }] },
      });
      return true;
    }
    const response = await handleRpc(request, undefined, context?.projectRoot ?? process.cwd());
    if (context !== undefined && request.method === "initialize" && response !== null) {
      // the same handshake the toolchain answers, plus the resources capability this door adds
      (response as { result?: { capabilities?: { resources?: object } } }).result!.capabilities!.resources = {};
    }
    if (response === null) {
      // a notification gets no body, per JSON-RPC; 202 is the streamable-HTTP spelling
      res.writeHead(202, devHeaders("application/json; charset=utf-8"));
      res.end();
      return true;
    }
    sendJson(res, 200, response);
    return true;
  };
  return { presence, handle };
}

/** The mount the dev server tries before its static handler. True = owned and answered.
 *  `state` reads the dev server's latest state-door snapshot (late-bound by
 *  startEditServer, since the mount is created before the server exists). */
export function createEditMount(
  config: ProjectConfig,
  editor: EditorAssets,
  state: () => string = () => "",
  /** this run's admission credential — REQUIRED, and there is deliberately no default:
   *  a mount that could be built without one is a mount somebody eventually builds without
   *  one. `mintAdmission()` is the only way a caller should obtain it. */
  admission: string,
  run: (action: string, args: { [k: string]: unknown }) =>
    Promise<{ answered: boolean; ok: boolean; value: unknown; error: string | null }> =
    () => Promise.resolve({ answered: false, ok: false, value: null, error: null }),
  /** the editor-session event hub (studio-apps.md §7.1) — startEditServer shares one with
   *  the dev server's rebuild tap; a bare mount (tests) gets its own. */
  hub: AppEventHub = createAppEventHub(),
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  if (admission === "") {
    throw new EditError("the edit mount cannot be built without an admission credential (mintAdmission()).");
  }
  // ── DESPIA APPS (studio-apps.md §8): discovery is filesystem truth, cached briefly —
  //    a 2s stamp keeps the rail live against installs without a walk per keystroke.
  const appEvents = hub;
  let appsCache: { at: number; apps: DiscoveredApp[] } | null = null;
  const invalidateApps = (): void => { appsCache = null; };
  const discoveredApps = (): DiscoveredApp[] => {
    if (appsCache !== null && Date.now() - appsCache.at < 2000) return appsCache.apps;
    let lockedDirs: Array<{ id: string; dir: string }> = [];
    try { lockedDirs = lockedModuleDirs(config.root); } catch (e) {
      console.warn(`[despia apps] lockfile materialize failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const editorDir = resolveDsxEditor(config.root);
    const builtinDirs = [...(editorDir !== null ? [editorDir] : []), ...resolveFirstPartyApps(config.root)];
    const apps = discoverApps({
      projectRoot: config.root,
      packageDirs: packageRoots(config),
      lockedDirs,
      ...(builtinDirs.length > 0 ? { builtinDirs } : {}),
    });
    appsCache = { at: Date.now(), apps };
    return apps;
  };

  //  APP PROVENANCE, ONE READING. The header is provenance, not authority — the scoped
  //  funnel already gated the grant before the request was made — so it is validated as a
  //  scheme and nothing more.
  const appHeader = (req: IncomingMessage): string => {
    const raw = req.headers["x-despia-app"];
    return typeof raw === "string" && /^[a-z][a-z0-9_-]*$/.test(raw) ? raw : "";
  };
  //  The version rides the commit trailer, so "which build of this app touched my project"
  //  survives an update. It is read from the DISCOVERED app — the code that actually ran —
  //  and only falls back to the consent row, which a headless run may not have seeded yet.
  const recordAppWrite = (
    cfg: ProjectConfig,
    app: string,
    write: { document: string; before: string | null; created: boolean; deleted: boolean },
  ): void => {
    try {
      const found = discoveredApps().find((a) => a.info.scheme === app);
      const version = found?.info.version ?? readAppState(cfg.root)[app]?.version ?? "";
      changePlaneFor(cfg.root).record({ app, appVersion: version, ...write });
    } catch (e) {
      //  Article 7: a change plane that cannot run must never refuse the edit that already
      //  happened. The edit stands; the person is told the version of it that is true.
      console.warn(`[despia apps] change plane: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const mcp = createMcpHttpHandler({
    projectRoot: config.root,
    list: () => [
      {
        uri: "despia://state",
        name: "Live state",
        description: "The running app's active screen and its variables, exactly as last posted through the state door.",
        mimeType: "application/json",
      },
      ...listDocuments(config).map((doc) => ({
        uri: `despia://context/${doc.name}`,
        name: `Context bundle - ${doc.name}`,
        description: "Source, live state, the SSR of this screen with that state, and its sample declarations - what the user is looking at, as data.",
        mimeType: "application/json",
      })),
    ],
    read: (uri) => {
      if (uri === "despia://state") {
        const snapshot = state();
        return { mimeType: "application/json", text: snapshot === "" ? '{"screen":null,"vars":[]}' : snapshot };
      }
      if (uri.startsWith("despia://context/")) {
        const bundle = buildContextBundle(config, uri.slice("despia://context/".length), state());
        return bundle === null ? null : { mimeType: "application/json", text: JSON.stringify(bundle) };
      }
      return null;
    },
  });

  // ── OpenRouter, LOCAL custody (master plan P16): the key lives in THIS process only -
  //    session-scoped, never logged, never written to disk, never echoed by any endpoint.
  //    Registration-free PKCE: the auth page gets a S256 challenge, the callback exchanges
  //    the code + verifier at the keys endpoint. The base is overridable for tests only.
  const ai: { verifier: string | null; key: string | null } = { verifier: null, key: null };
  const aiTurns = new Map<string, AgentTurn>();
  const aiModels: { rows: Array<{ id: string; name: string }> | null; at: number } = { rows: null, at: 0 };
  const aiBase = (): string => process.env["DSX_OPENROUTER_BASE"] ?? "https://openrouter.ai";
  loadProjectEnv(config.root);
  const b64url = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return async (req, res) => {
    const raw = req.url ?? "/";
    const qi = raw.indexOf("?");
    const pathname = qi < 0 ? raw : raw.slice(0, qi);
    //  ── ADMISSION, IN FRONT OF THE WHOLE MOUNT ──────────────────────────────────────────
    //
    //  Everything under /edit is gated, not just /edit/api: the MCP door is a write surface
    //  too, the AI doors spend the developer's credit, and gating the page as well is what
    //  lets the credential arrive once, as a cookie, instead of being taught to every fetch
    //  in a compiled application. A refusal is uniform — the same 401 for a path that exists
    //  and a path that does not, so this door answers no questions about the tree behind it.
    if (pathname === "/edit" || pathname.startsWith("/edit/")) {
      const presented = presentedAdmission(req, qi < 0 ? "" : raw.slice(qi + 1));
      if (!sameSecret(presented.value, admission)) {
        res.writeHead(401, devHeaders("application/json; charset=utf-8"));
        res.end(JSON.stringify({
          reason: "unauthorized",
          message: "despia edit requires this run's admission credential — open the URL the command printed, " +
            `or send it as the ${ADMISSION_HEADER} header.`,
        }));
        return true;
      }
      if (presented.fromQuery) {
        //  The URL carried it, so the browser keeps it from here: Lax rather than Strict
        //  because an OAuth provider redirects back into /edit/ai/callback as a top-level
        //  navigation, and Lax still withholds the cookie from every cross-site fetch and
        //  form POST — which is the shape an attack on a loopback port actually takes.
        res.setHeader("set-cookie",
          `${ADMISSION_COOKIE}=${encodeURIComponent(admission)}; Path=/edit; SameSite=Lax; HttpOnly`);
      }
    }
    if (pathname === "/edit/mcp") return mcp.handle(req, res);
    if (pathname === "/edit/api/agents") {
      const seen = mcp.presence.lastSeen;
      sendJson(res, 200, {
        endpoint: "/edit/mcp",
        connected: seen !== null && Date.now() - seen < 5 * 60_000,
        client: mcp.presence.client,
        lastSeen: seen === null ? null : new Date(seen).toISOString(),
        calls: mcp.presence.calls,
      });
      return true;
    }
    if (pathname === "/edit/api/ai/connect" && req.method === "POST") {
      const verifier = b64url(randomBytes(48));
      ai.verifier = verifier;
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const callback = `http://${req.headers.host ?? "127.0.0.1"}/edit/ai/callback`;
      sendJson(res, 200, {
        url: `${aiBase()}/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`,
      });
      return true;
    }
    if (pathname === "/edit/ai/callback") {
      const code = new URL(req.url ?? "/", "http://x").searchParams.get("code") ?? "";
      if (ai.verifier === null || code === "") {
        sendJson(res, 400, { reason: "no_flow", message: "no connect flow is in progress - start from the studio" });
        return true;
      }
      try {
        const exchange = await fetch(`${aiBase()}/api/v1/auth/keys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, code_verifier: ai.verifier, code_challenge_method: "S256" }),
        });
        const payload = (await exchange.json()) as { key?: unknown };
        if (!exchange.ok || typeof payload.key !== "string" || payload.key.length === 0) {
          sendJson(res, 502, { reason: "exchange_failed", message: `the key exchange answered ${exchange.status}` });
          return true;
        }
        ai.key = payload.key;
      } catch (e) {
        sendJson(res, 502, { reason: "exchange_failed", message: e instanceof Error ? e.message : String(e) });
        return true;
      } finally {
        ai.verifier = null;
      }
      res.writeHead(302, devHeaders("text/plain; charset=utf-8", { location: "/edit/" }));
      res.end("connected");
      return true;
    }
    if (pathname === "/edit/api/ai/status") {
      sendJson(res, 200, { provider: "openrouter", connected: ai.key !== null });
      return true;
    }
    if (pathname === "/edit/api/ai/capabilities") {
      sendJson(res, 200, { capabilities: loadCapabilities() });
      return true;
    }
    if (pathname === "/edit/api/ai/models") {
      // the picker's list, proxied so the page never talks to the model host itself.
      // Auto leads (the recommended default); the account's reachable models follow.
      const now = Date.now();
      if (aiModels.rows !== null && now - aiModels.at < 10 * 60_000) {
        sendJson(res, 200, { models: aiModels.rows });
        return true;
      }
      try {
        const answer = await fetch(`${aiBase()}/api/v1/models`, {
          headers: ai.key === null ? {} : { authorization: `Bearer ${ai.key}` },
        });
        const payload = (await answer.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
        const rows = [{ id: "openrouter/auto", name: "Auto" }].concat(
          (payload.data ?? [])
            .filter((m) => typeof m.id === "string" && m.id !== "openrouter/auto")
            .map((m) => ({ id: m.id as string, name: typeof m.name === "string" ? m.name : (m.id as string) })),
        );
        aiModels.rows = rows;
        aiModels.at = now;
        sendJson(res, 200, { models: rows });
      } catch {
        sendJson(res, 200, { models: [{ id: "openrouter/auto", name: "Auto" }] });
      }
      return true;
    }
    if (pathname === "/edit/api/ai/disconnect" && req.method === "POST") {
      ai.key = null;
      sendJson(res, 200, { provider: "openrouter", connected: false });
      return true;
    }
    if (pathname === "/edit/api/ai/chat" && req.method === "POST") {
      if (ai.key === null) {
        sendJson(res, 409, { reason: "not_connected", message: "connect a model first - the chat runs on the user's own key" });
        return true;
      }
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { reason: "too_large", message: "the transcript exceeds the size cap" });
        return true;
      }
      let body: { [k: string]: unknown };
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (!isRecord(parsed)) throw new Error("not an object");
        body = parsed;
      } catch {
        sendJson(res, 400, { reason: "bad_json", message: "the chat turn is a JSON body: { document?, model?, messages }" });
        return true;
      }
      const turns: Array<{ role: string; content: string }> = [];
      for (const entry of Array.isArray(body["messages"]) ? body["messages"] : []) {
        if (!isRecord(entry)) continue;
        const role = entry["role"];
        const content = entry["content"];
        if ((role === "user" || role === "assistant") && typeof content === "string" && content.length > 0) {
          turns.push({ role, content });
        }
      }
      if (turns.length === 0 || turns[turns.length - 1]!.role !== "user") {
        sendJson(res, 400, { reason: "bad_request", message: "messages must end on a user turn" });
        return true;
      }
      const document = typeof body["document"] === "string" ? body["document"] : "";
      const model = typeof body["model"] === "string" && body["model"].length > 0 ? body["model"] : "openrouter/auto";
      const chipSchemes = (Array.isArray(body["capabilities"]) ? body["capabilities"] : [])
        .filter((c): c is string => typeof c === "string");
      const self = `http://${req.headers.host ?? "127.0.0.1"}`;
      const turn: AgentTurn = {
        id: randomBytes(8).toString("hex"),
        status: "running",
        document,
        model,
        reply: "",
        error: "",
        activity: [],
        secretRequest: null,
        checkpoint: {},
        reverted: false,
        rounds: 0,
        transcript: [{ role: "system", content: buildAgentSystem(config, document, state(), capabilityFacts(chipSchemes)) }, ...turns],
        pendingSecretCall: null,
      };
      aiTurns.set(turn.id, turn);
      while (aiTurns.size > AI_TURN_CAP) {
        const oldest = aiTurns.keys().next().value as string;
        aiTurns.delete(oldest);
      }
      // the lifecycle answer: the id now, the run through GET polls - never awaited here
      void continueAgentTurn(config, self, admission, aiBase(), () => ai.key, turn);
      sendJson(res, 200, agentTurnView(turn));
      return true;
    }
    if (pathname === "/edit/api/ai/chat" && req.method === "GET") {
      const id = new URL(req.url ?? "/", "http://x").searchParams.get("turn") ?? "";
      const turn = aiTurns.get(id);
      if (turn === undefined) {
        sendJson(res, 404, { reason: "unknown_turn", message: "that turn is not held by this session" });
        return true;
      }
      sendJson(res, 200, agentTurnView(turn));
      return true;
    }
    if (pathname === "/edit/api/ai/render") {
      // THE VISUAL BEFORE/AFTER: the changed component rendered server-side - "before"
      // from the turn's checkpoint bytes (the registry entry substituted in memory,
      // nothing written), "after" from the file of record. The page carries the real
      // token plane + kernel skin + the project's own sheets, so what the card shows
      // is what the app renders - not a mock.
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const turn = aiTurns.get(q.get("turn") ?? "");
      const file = q.get("file") ?? "";
      const which = q.get("which") ?? "after";
      if (turn === undefined || !file.endsWith(".dsx")) {
        sendJson(res, 404, { reason: "unknown_render", message: "the render needs a held turn and a .dsx file" });
        return true;
      }
      const componentName = basename(file, ".dsx");
      const qualified = `${config.scheme}.${componentName}`;
      let body = "";
      try {
        const roots = packageRoots(config);
        const registry = buildRegistry(
          roots.map((dir) => (dir === config.root ? { dir, scheme: config.scheme, app: true } : { dir })),
        );
        if (!Object.prototype.hasOwnProperty.call(turn.checkpoint, file)) {
          sendJson(res, 404, { reason: "unknown_render", message: "this turn did not touch that file" });
          return true;
        }
        const beforeSource = turn.checkpoint[file] ?? "";
        const absolute = resolveDocument(config, file);
        const afterSource = absolute !== null && existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
        if (which === "before") {
          if (beforeSource === "") {
            body = "";
          } else {
            registry.components[qualified] = compileComponent(componentName, config.scheme, beforeSource);
            body = renderToString(registry, qualified, {}, { hydrate: true });
          }
        } else {
          if (registry.components[qualified] === undefined) {
            sendJson(res, 404, { reason: "unknown_render", message: `${qualified} is not a component of this project` });
            return true;
          }
          body = renderToString(registry, qualified, {}, { hydrate: true });
        }
        // THE ANNOTATION PLANE: the structural diff drawn on the real render - green +
        // boxes around what arrived, amber \u00b1 on what changed (this page), red \u2212
        // with the element faded and struck in place on the before page. Grouped runs
        // keep a large change one region, not a page of borders.
        const ann = markupDiff(beforeSource, afterSource);
        const marks = which === "before" ? ann.before : ann.after;
        const annCss = `.dsx-ann{position:absolute;border:2px solid;border-radius:6px;pointer-events:none;z-index:9999}
.dsx-ann-add{border-color:#2ea043}.dsx-ann-del{border-color:#f85149}.dsx-ann-chg{border-color:#d29922}
.dsx-ann-chip{position:absolute;top:-9px;left:6px;font:600 10px/1.6 ui-monospace,monospace;color:#fff;padding:0 5px;border-radius:4px}
.dsx-ann-add .dsx-ann-chip{background:#2ea043}.dsx-ann-del .dsx-ann-chip{background:#f85149}.dsx-ann-chg .dsx-ann-chip{background:#d29922}`;
        const annScript = marks.length === 0 ? "" : `<script>const ANN=${JSON.stringify(marks)};
addEventListener("load",()=>{for(const a of ANN){
const els=a.nids.map(n=>document.querySelector('[data-dsx-n="'+n+'"]')).filter(Boolean);
if(!els.length)continue;let b=null;
for(const el of els){const r=el.getBoundingClientRect();
b=b?{l:Math.min(b.l,r.left),t:Math.min(b.t,r.top),r:Math.max(b.r,r.right),b:Math.max(b.b,r.bottom)}:{l:r.left,t:r.top,r:r.right,b:r.bottom};
if(a.kind==="del"){el.style.opacity="0.45";el.style.textDecoration="line-through";}}
const o=document.createElement("div");o.className="dsx-ann dsx-ann-"+a.kind;
o.style.left=(b.l+scrollX-3)+"px";o.style.top=(b.t+scrollY-3)+"px";
o.style.width=(b.r-b.l+6)+"px";o.style.height=(b.b-b.t+6)+"px";
const c=document.createElement("span");c.className="dsx-ann-chip";c.textContent=a.label;
o.appendChild(c);document.body.appendChild(o);}});</script>`;
        const css = ["@layer dsx-tokens, dsx-elements, dsx-theme, dsx-sheets, dsx-inline, dsx-attrs;",
          TOKENS_CSS, ...SKIN_CSS_BLOCKS, registry.css, annCss].join("\n");
        res.writeHead(200, devHeaders("text/html; charset=utf-8", { "cache-control": "no-store" }));
        res.end(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
          + `<meta name="viewport" content="width=device-width, initial-scale=1">`
          + `<style>${css}</style></head>`
          + `<body style="margin:0;padding:10px 0"><div data-dsx-root style="width:100%">${body === "" ? "" : body}</div>${annScript}</body></html>\n`);
      } catch (e) {
        sendJson(res, 500, { reason: "render_failed", message: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (pathname === "/edit/api/ai/secret" && req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { reason: "too_large", message: "request body exceeds the cap" });
        return true;
      }
      let body: { [k: string]: unknown };
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (!isRecord(parsed)) throw new Error("not an object");
        body = parsed;
      } catch {
        sendJson(res, 400, { reason: "bad_json", message: "the secret write is a JSON body: { name, value, turn? }" });
        return true;
      }
      const name = typeof body["name"] === "string" ? body["name"] : "";
      const value = typeof body["value"] === "string" ? body["value"] : "";
      if (!AI_SECRET_NAME.test(name) || value.length === 0) {
        sendJson(res, 400, { reason: "bad_request", message: "a secret needs an ENV_STYLE name and a non-empty value" });
        return true;
      }
      // WRITE-ONLY: the value lands in .env + this process and is never readable back
      writeProjectSecret(config.root, name, value);
      const turnId = typeof body["turn"] === "string" ? body["turn"] : "";
      const turn = aiTurns.get(turnId);
      if (turn !== undefined && turn.status === "needs_secret" && turn.secretRequest?.name === name) {
        // the parked tool call gets its answer - the NAME, never the value - and the run resumes
        turn.transcript.push({
          role: "tool",
          tool_call_id: turn.pendingSecretCall ?? "",
          content: `${name} is now set in the project environment. Read it by name; the value is never shown.`,
        });
        turn.pendingSecretCall = null;
        turn.secretRequest = null;
        turn.status = "running";
        const self = `http://${req.headers.host ?? "127.0.0.1"}`;
        void continueAgentTurn(config, self, admission, aiBase(), () => ai.key, turn);
      }
      sendJson(res, 200, { stored: name });
      return true;
    }
    if (pathname === "/edit/api/ai/revert" && req.method === "POST") {
      const raw = await readBody(req);
      const parsed = raw === null ? null : (() => { try { return JSON.parse(raw.toString("utf8")); } catch { return null; } })();
      const turnId = isRecord(parsed) && typeof parsed["turn"] === "string" ? parsed["turn"] : "";
      const turn = aiTurns.get(turnId);
      if (turn === undefined) {
        sendJson(res, 404, { reason: "unknown_turn", message: "that turn is not held by this session" });
        return true;
      }
      if (turn.status === "running" || turn.status === "needs_secret") {
        sendJson(res, 409, { reason: "turn_running", message: "the turn is still working - revert lands when it settles" });
        return true;
      }
      if (turn.reverted) {
        sendJson(res, 200, { reverted: true, files: 0 });
        return true;
      }
      // restore every checkpointed file to its pre-turn bytes; a file the turn created is
      // removed again. Restores ride the documents door (the rebuild pipeline); the theme
      // file and deletions act on paths the checkpoint itself audited at write time.
      const self = `http://${req.headers.host ?? "127.0.0.1"}`;
      let files = 0;
      for (const [file, before] of Object.entries(turn.checkpoint)) {
        files += 1;
        if (file === "theme.css") {
          const themePath = join(config.root, "theme.css");
          if (before === null) rmSync(themePath, { force: true });
          else writeFileSync(themePath, before);
          continue;
        }
        if (before === null) {
          const absolute = resolveDocument(config, file);
          if (absolute !== null) rmSync(absolute, { force: true });
          continue;
        }
        await selfFetch(admission, `${self}/edit/api/documents/${encodeURIComponent(file)}`, { method: "PUT", body: before });
      }
      turn.reverted = true;
      sendJson(res, 200, { reverted: true, files });
      return true;
    }
    // THE CHROME IS A DSX APP (M1). What serves here is the output of our own compiler over
    // the editor's own .dsx documents — the same documents the hosted studio runs (M2) and
    // the same ones the surgery gate edits (M6). The hand-written page below is the fallback
    // for an install that has no editor documents, never the default.
    if (editor.dsxDir !== undefined && pathname === "/edit") {
      // The document addresses main.js, the import map and every vendored module RELATIVELY,
      // which is what lets one build serve under any mount — but `/edit` without the slash
      // resolves them against the root, i.e. the developer's project. Redirect, don't guess.
      res.writeHead(308, devHeaders("text/plain; charset=utf-8", { location: "/edit/" }));
      res.end("/edit/");
      return true;
    }
    if (editor.dsxDir !== undefined && pathname.startsWith("/edit/")) {
      const asset = serveEditorAsset(editor.dsxDir, pathname);
      if (asset !== null) {
        res.writeHead(200, devHeaders(asset.type));
        res.end(asset.body);
        return true;
      }
    }
    if (pathname === "/edit" || pathname === "/edit/") {
      res.writeHead(200, devHeaders("text/html; charset=utf-8"));
      res.end(editorPage(config.name, editor.logicSdk !== undefined));
      return true;
    }
    const scripts: { [path: string]: string | undefined } = {
      "/edit/sdk.js": editor.sdk,
      "/edit/element.js": editor.element,
      "/edit/logic-sdk.js": editor.logicSdk,
      "/edit/logic-element.js": editor.logicElement,
    };
    const script = scripts[pathname];
    if (script !== undefined) {
      res.writeHead(200, devHeaders("text/javascript; charset=utf-8"));
      res.end(readFileSync(script));
      return true;
    }
    if (pathname === "/edit/api/try") {
      // "TRY IT" (platform/09-agent-tools.md WE6): run a declared action in the LIVE app
      // page as an entry call - the same call shape an agent's tool invocation uses - and
      // answer with the settled result. The run rides the dev server's SSE lane; no page
      // answering inside the timeout is an honest 409, never an invented result: a
      // capability can only be tried against the app it would really run in.
      if (req.method !== "POST") {
        res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
        res.end(JSON.stringify({ reason: "method_not_allowed", message: "POST { action, args } to try a capability" }));
        return true;
      }
      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { reason: "bad_request", message: "request exceeds the size cap" });
        return true;
      }
      let parsed: { action?: unknown; args?: unknown };
      try {
        parsed = JSON.parse(body.toString("utf8")) as typeof parsed;
      } catch {
        sendJson(res, 400, { reason: "bad_request", message: "the body must be JSON: { action, args }" });
        return true;
      }
      const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
      if (action === "") {
        sendJson(res, 400, { reason: "bad_request", message: "name the action to run" });
        return true;
      }
      const args = parsed.args !== null && typeof parsed.args === "object" && !Array.isArray(parsed.args)
        ? parsed.args as { [k: string]: unknown }
        : {};
      const result = await run(action, args);
      if (!result.answered) {
        sendJson(res, 409, {
          reason: "no_live_preview",
          message: "no running preview answered - open the app preview (the Screen view) or the app in a tab, then try again",
        });
        return true;
      }
      sendJson(res, 200, { ok: result.ok, value: result.value, error: result.error });
      return true;
    }
    if (pathname === "/edit/api/documents") {
      // PAGES AND COMPONENTS, never "documents" and never a file extension: the visual
      // editor is a visual-only experience, so a surface is named by what the author built
      // (the humanised name the map already uses) and split by what it IS - a page the
      // router reaches, or a component pages compose. The file name still travels as the
      // ID, because the file is the model; it just never reaches a label.
      const graph = buildScreenGraph(graphDocuments(config), graphRoutes(config), graphEntry(config));
      const surfaces = graph.nodes.filter((n) => n.kind === "route" || n.kind === "part" || n.kind === "pushed" || n.kind === "sheet");
      const pages = surfaces.filter((n) => n.kind !== "part");
      const components = surfaces.filter((n) => n.kind === "part");
      sendJson(res, 200, {
        documents: listDocuments(config).map((d) => d.name),
        pages: pages.map((n) => ({ id: n.file, name: n.name, ...(n.path !== undefined ? { path: n.path } : {}) })),
        components: components.map((n) => ({ id: n.file, name: n.name })),
      });
      return true;
    }
    // ── the PANEL CATALOGS: the add panel and the style panel are DATA, not code ────
    //
    //  Both panels render from the same machine-readable references the runtime is gated
    //  against (stack-elements.json via the element census, stack-style-properties.json via
    //  check_style_catalog) - so the editor can never offer an element or a property the
    //  renderers do not have, and a new element reaches the panel by landing in the
    //  reference, never by editing the editor.
    if (pathname === "/edit/api/elements") {
      const catalog = referenceJson("stack-elements.json");
      if (catalog === null) {
        sendJson(res, 404, { reason: "missing_reference", message: "stack-elements.json was not found next to the toolchain" });
        return true;
      }
      sendJson(res, 200, { categories: elementPanel(catalog) });
      return true;
    }
    if (pathname === "/edit/api/styles") {
      const catalog = referenceJson("stack-style-properties.json");
      if (catalog === null) {
        sendJson(res, 404, { reason: "missing_reference", message: "stack-style-properties.json was not found next to the toolchain" });
        return true;
      }
      const cast = catalog as { groups?: unknown; controlTypes?: unknown; colorTokens?: unknown };
      sendJson(res, 200, { groups: cast.groups ?? [], controlTypes: cast.controlTypes ?? {}, colorTokens: cast.colorTokens ?? [] });
      return true;
    }

    // ── DESPIA APPS (studio-apps.md §8): the app plane's doors. All admission-gated by
    //    the /edit prefix above; the mount table is the pure fold over filesystem truth. ──
    if (pathname === "/edit/api/apps") {
      const apps = discoveredApps();
      const seeded = seedState(apps, readAppState(config.root));
      if (seeded.changed) writeAppState(config.root, seeded.state);
      // the shelf tier: an installed app mounts only under a VERIFIED approval (studio-apps.md §11)
      const shelf = readVerifiedApprovals(config.root, apps);
      const { table, refusals } = resolveStudioApps(apps, seeded.state, { approvals: shelf.approvals });
      for (const problem of shelf.problems) refusals.push({ app: problem.app, contribution: null, reason: problem.reason });
      sendJson(res, 200, {
        studioApi: STUDIO_API,
        apps: apps.map((a) => ({
          scheme: a.info.scheme,
          name: a.info.name,
          summary: a.info.summary,
          version: a.info.version,
          kind: a.kind,
          enabled: seeded.state[a.info.scheme]?.enabled === true,
          grants: seeded.state[a.info.scheme]?.grants ?? [],
          asked: manifestGrants(a.info),
          contributions: a.info.contributions.map((c) => ({
            id: c.id, slot: c.slot, title: c.title ?? a.info.name, icon: c.icon ?? "", on: c.on ?? "", mode: c.mode,
          })),
        })),
        table,
        refusals,
        events: appEvents.counts(),
      });
      return true;
    }
    //  THE CHANGE HISTORY (studio-apps.md §14): what every app did to this project, what it
    //  became in git, and the one control that undoes it. Read by the Apps panel and by
    //  `despia app history` through the same door.
    if (pathname === "/edit/api/apps/history") {
      changePlaneFor(config.root).flush();
      const params = new URL(raw, "http://x").searchParams;
      const app = params.get("app") ?? "";
      const rows = readChangeRecords(config.root, 100)
        .filter((r: ChangeRecord) => app === "" || r.app === app)
        .map((r: ChangeRecord) => ({
          id: r.id, app: r.app, at: r.at, kind: r.kind, title: r.title, reasons: r.reasons,
          documents: r.documents, branch: r.branch, commit: r.commit, pull: r.pull,
          pullKind: r.pullKind, pushed: r.pushed, note: r.note, revertedBy: r.revertedBy, reverts: r.reverts,
        }));
      sendJson(res, 200, { changes: rows, policy: readPolicy(config.root) });
      return true;
    }
    if (pathname === "/edit/api/apps/revert") {
      if (req.method !== "POST") {
        res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
        res.end(JSON.stringify({ reason: "method_not_allowed", message: "POST { change }" }));
        return true;
      }
      const body = await readBody(req);
      let payload: unknown = null;
      try { payload = body === null ? null : JSON.parse(body.toString("utf8")); } catch { payload = null; }
      const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as { [k: string]: unknown } : null;
      const id = record !== null && typeof record["change"] === "string" ? record["change"] : "";
      if (id === "") { sendJson(res, 400, { reason: "bad_request", message: "revert needs `change` (a change id)" }); return true; }
      //  A revert is a PERSON's act on their own project, never an app's: it is not on the
      //  seam list, and this door is behind the editor's admission gate like every other.
      changePlaneFor(config.root).flush();
      const result = revertChange(config.root, id);
      if (!result.ok) {
        sendJson(res, result.reason === "unknown_change" ? 404 : 409, { reason: result.reason, message: result.message });
        return true;
      }
      for (const document of result.restored) {
        appEvents.emit("document.saved", { name: document, rev: documentRevision(readFileSync(join(config.root, document))), by: "studio" });
      }
      sendJson(res, 200, {
        reverted: id, change: result.record.id, restored: result.restored, removed: result.removed,
        commit: result.record.commit, note: result.record.note,
      });
      return true;
    }
    if (pathname === "/edit/api/apps/vcs") {
      if (req.method === "GET") { sendJson(res, 200, { policy: readPolicy(config.root) }); return true; }
      if (req.method !== "POST") {
        res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "GET, POST" }));
        res.end(JSON.stringify({ reason: "method_not_allowed", message: "GET reads the policy, POST sets it" }));
        return true;
      }
      const body = await readBody(req);
      let payload: unknown = null;
      try { payload = body === null ? null : JSON.parse(body.toString("utf8")); } catch { payload = null; }
      const merged = mergePolicy({ ...readPolicy(config.root), ...(payload !== null && typeof payload === "object" ? payload : {}) });
      writePolicy(config.root, merged);
      sendJson(res, 200, { policy: merged });
      return true;
    }
    if (pathname === "/edit/api/apps/market") {
      const q = new URL(raw, "http://x").searchParams.get("q") ?? "";
      const apps = discoveredApps();
      const seeded = seedState(apps, readAppState(config.root));
      sendJson(res, 200, { rows: marketRows(apps, seeded.state, q) });
      return true;
    }
    if (pathname === "/edit/api/apps/surface") {
      const params = new URL(raw, "http://x").searchParams;
      const scheme = params.get("app") ?? "";
      const id = params.get("contribution") ?? "";
      const apps = discoveredApps();
      const app = apps.find((a) => a.info.scheme === scheme);
      const contribution = app?.info.contributions.find((c) => c.id === id);
      if (app === undefined || contribution === undefined) {
        sendJson(res, 404, { reason: "unknown_app", message: `no contribution ${scheme}#${id}` });
        return true;
      }
      const seeded = seedState(apps, readAppState(config.root));
      const shelf = readVerifiedApprovals(config.root, apps);
      const { table, refusals } = resolveStudioApps(apps, seeded.state, { approvals: shelf.approvals });
      for (const problem of shelf.problems) refusals.push({ app: problem.app, contribution: null, reason: problem.reason });
      const mounted = Object.values(table).some((rows) => rows.some((r) => r.app === scheme && r.contribution.id === id));
      if (!mounted) {
        const refusal = refusals.find((r) => r.app === scheme);
        sendJson(res, 403, { reason: "refused_mount", message: refusal?.reason ?? "the contribution is not mounted — enable the app in the Apps panel" });
        return true;
      }
      try {
        sendJson(res, 200, appSurfacePayload(app, contribution, config.root));
      } catch (e) {
        sendJson(res, 409, { reason: "compile_failed", message: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (pathname.startsWith("/edit/api/apps/storage/")) {
      const scheme = decodeURIComponent(pathname.slice("/edit/api/apps/storage/".length));
      if (!/^[a-z][a-z0-9_-]*$/.test(scheme)) {
        sendJson(res, 400, { reason: "bad_request", message: "an app storage namespace is the app's scheme" });
        return true;
      }
      if (req.method === "GET") {
        sendJson(res, 200, { value: readAppStorage(config.root, scheme) });
        return true;
      }
      if (req.method === "PUT" || req.method === "POST") {
        const body = await readBody(req);
        if (body === null) { sendJson(res, 413, { reason: "too_large", message: "app storage exceeds the body cap" }); return true; }
        try {
          const parsed: unknown = JSON.parse(body.toString("utf8") === "" ? "{}" : body.toString("utf8"));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          writeAppStorage(config.root, scheme, parsed as { [k: string]: unknown });
          sendJson(res, 200, { saved: scheme });
        } catch {
          sendJson(res, 400, { reason: "bad_request", message: "app storage is a JSON object" });
        }
        return true;
      }
      res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "GET, PUT" }));
      res.end(JSON.stringify({ reason: "method_not_allowed", message: "GET reads, PUT saves" }));
      return true;
    }
    if (pathname === "/edit/api/apps/state") {
      if (req.method !== "POST") {
        res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
        res.end(JSON.stringify({ reason: "method_not_allowed", message: "POST { app, enabled?, grants? }" }));
        return true;
      }
      const body = await readBody(req);
      let payload: unknown = null;
      try { payload = body === null ? null : JSON.parse(body.toString("utf8")); } catch { payload = null; }
      const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as { [k: string]: unknown } : null;
      const scheme = record !== null && typeof record["app"] === "string" ? record["app"] : "";
      if (scheme === "") { sendJson(res, 400, { reason: "bad_request", message: "state needs `app`" }); return true; }
      const apps = discoveredApps();
      const app = apps.find((a) => a.info.scheme === scheme);
      if (app === undefined) { sendJson(res, 404, { reason: "unknown_app", message: `no app "${scheme}"` }); return true; }
      const state = seedState(apps, readAppState(config.root)).state;
      const row = state[scheme] ?? { enabled: false, version: app.info.version, grants: [], grantedAt: "" };
      if (record !== null && record["grants"] === true) {
        // consent / re-consent: record exactly what the manifest asks TODAY — the diff the
        // panel showed is the diff this write closes
        row.grants = manifestGrants(app.info);
        row.grantedAt = new Date().toISOString();
        row.version = app.info.version;
      }
      if (record !== null && typeof record["enabled"] === "boolean") {
        row.enabled = record["enabled"];
      }
      state[scheme] = row;
      writeAppState(config.root, state);
      invalidateApps();
      if (record !== null && typeof record["enabled"] === "boolean") {
        appEvents.emit(record["enabled"] ? "app.enabled" : "app.disabled", { app: scheme });
      }
      sendJson(res, 200, { app: scheme, enabled: row.enabled, grants: row.grants });
      return true;
    }
    if (pathname === "/edit/api/apps/install") {
      if (req.method !== "POST") {
        res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
        res.end(JSON.stringify({ reason: "method_not_allowed", message: "POST { ref }" }));
        return true;
      }
      const body = await readBody(req);
      let payload: unknown = null;
      try { payload = body === null ? null : JSON.parse(body.toString("utf8")); } catch { payload = null; }
      const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as { [k: string]: unknown } : null;
      const ref = record !== null && typeof record["ref"] === "string" ? record["ref"] : "";
      if (ref === "") { sendJson(res, 400, { reason: "bad_request", message: "install needs `ref` (github:owner/repo@version)" }); return true; }
      const lines: string[] = [];
      const io = { out: (l: string) => { lines.push(l); }, err: (l: string) => { lines.push(l); } };
      const code = await commandAdd({ project: config.root }, [ref], io);
      if (code !== 0) { sendJson(res, 409, { reason: "install_failed", message: lines.join("\n") }); return true; }
      invalidateApps();
      appEvents.emit("app.installed", { ref });
      sendJson(res, 200, { installed: ref, log: lines });
      return true;
    }
    if (pathname === "/edit/api/apps/uninstall") {
      if (req.method !== "POST") {
        res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
        res.end(JSON.stringify({ reason: "method_not_allowed", message: "POST { app, deleteData? }" }));
        return true;
      }
      const body = await readBody(req);
      let payload: unknown = null;
      try { payload = body === null ? null : JSON.parse(body.toString("utf8")); } catch { payload = null; }
      const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as { [k: string]: unknown } : null;
      const scheme = record !== null && typeof record["app"] === "string" ? record["app"] : "";
      if (scheme === "") { sendJson(res, 400, { reason: "bad_request", message: "uninstall needs `app`" }); return true; }
      const state = readAppState(config.root);
      const app = discoveredApps().find((a) => a.info.scheme === scheme);
      delete state[scheme];
      writeAppState(config.root, state);
      if (record !== null && record["deleteData"] === true) {
        rmSync(join(config.root, ".despia", "apps", scheme), { recursive: true, force: true });
      }
      invalidateApps();
      appEvents.emit("app.disabled", { app: scheme });
      sendJson(res, 200, {
        app: scheme,
        // the state row is gone; a pinned package stays pinned — unpinning is the lockfile's
        // own verb, said here rather than done silently
        note: app !== undefined && app.lockId !== "" ? `still pinned in dsx.lock.json — run: despia remove ${app.lockId}` : "",
        dataKept: !(record !== null && record["deleteData"] === true),
      });
      return true;
    }
    if (pathname === "/edit/api/apps/events") {
      res.writeHead(200, devHeaders("text/event-stream; charset=utf-8", { connection: "keep-alive" }));
      appEvents.subscribe(res);
      return true;
    }

    // ── the THEME: the project token tier (master plan P15, dsx-css §4.2) ────────────
    //
    //  GET overlays the project's theme.css re-pins on the corpus vocabulary; PUT/POST
    //  writes that ONE file (or removes it when every override clears - absence is the
    //  fresh-project state, not an error). The dev watcher sees the write, rebuilds, and
    //  the preview repaints over the hot-swap lane; no token ever lands in a component.
    if (pathname === "/edit/api/theme") {
      const themePath = join(config.root, "theme.css");
      if (req.method === "PUT" || req.method === "POST") {
        const raw = await readBody(req);
        if (raw === null) {
          sendJson(res, 413, { reason: "too_large", message: "request body exceeds the cap" });
          return true;
        }
        let body: { tokens?: { [css: string]: { light?: unknown; dark?: unknown } } };
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { reason: "bad_json", message: "the theme write is a JSON body: { tokens: { \"--css-name\": { light, dark } } }" });
          return true;
        }
        const light: { [css: string]: string } = {};
        const dark: { [css: string]: string } = {};
        for (const [css, pair] of Object.entries(body.tokens ?? {})) {
          if (!THEME_TOKEN_NAME.test(css) || pair === null || typeof pair !== "object") continue;
          // strip structure characters so a value can never escape its declaration
          const clean = (v: unknown): string => typeof v === "string" ? v.replace(/[{};]/g, "").trim() : "";
          const lightValue = clean(pair.light);
          const darkValue = clean(pair.dark);
          if (lightValue.length > 0) light[css] = lightValue;
          if (darkValue.length > 0) dark[css] = darkValue;
        }
        if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
          rmSync(themePath, { force: true });
        } else {
          writeFileSync(themePath, emitProjectTheme(light, dark));
        }
        sendJson(res, 200, { ok: true, file: existsSync(themePath) });
        return true;
      }
      const corpus = conformanceJson(join("defaults", "tokens.json")) as
        { tokens?: { [name: string]: { web?: { css?: string; light?: string; dark?: string } } } } | null;
      if (corpus === null || corpus.tokens === undefined) {
        sendJson(res, 404, { reason: "missing_corpus", message: "Conformance/defaults/tokens.json was not found next to the toolchain" });
        return true;
      }
      const overrides = existsSync(themePath)
        ? parseProjectTheme(readFileSync(themePath, "utf8"))
        : { light: {}, dark: {} };
      // consumed tokens (P15): the kernel skin + the project's own compiled css, scanned
      // once per sheet load - a pure projection, recomputed like every editor read
      const vocabulary = Object.values(corpus.tokens)
        .map((row) => row.web?.css)
        .filter((css): css is string => css !== undefined)
        .concat("--dsx-radius");
      const consumers = new Map<string, Set<string>>();
      const cssSources = [...SKIN_CSS_BLOCKS];
      try {
        const roots = packageRoots(config);
        cssSources.push(buildRegistry(
          roots.map((dir) => (dir === config.root ? { dir, scheme: config.scheme, app: true } : { dir })),
        ).css);
      } catch { /* an uncompilable project simply contributes no author consumers */ }
      for (const css of cssSources) {
        for (const [token, names] of tokenConsumersIn(css, vocabulary)) {
          let set = consumers.get(token);
          if (set === undefined) consumers.set(token, set = new Set());
          for (const name of names) set.add(name);
        }
      }
      const consumersOf = (css: string): string[] => [...(consumers.get(css) ?? [])].sort();
      const tokens = Object.entries(corpus.tokens)
        .filter(([, row]) => row.web?.css !== undefined)
        .map(([name, row]) => ({
          name,
          css: row.web!.css!,
          kind: "color",
          defaultLight: row.web!.light ?? "",
          defaultDark: row.web!.dark ?? "",
          light: overrides.light[row.web!.css!] ?? "",
          dark: overrides.dark[row.web!.css!] ?? "",
          consumers: consumersOf(row.web!.css!),
        }));
      // geometry rides the same plane: the control radius every skinned element computes.
      // (The kernel resolves 10px mobile / 8px fine-desktop; the sheet edits the override.)
      tokens.push({
        name: "radius",
        css: "--dsx-radius",
        kind: "length",
        defaultLight: "10px",
        defaultDark: "10px",
        light: overrides.light["--dsx-radius"] ?? "",
        dark: overrides.dark["--dsx-radius"] ?? "",
        consumers: consumersOf("--dsx-radius"),
      });
      sendJson(res, 200, { file: existsSync(themePath), tokens });
      return true;
    }

    // ── the STRINGS table (master plan P12): rows extracted, columns per language ────
    if (pathname === "/edit/api/strings") {
      if (req.method === "PUT" || req.method === "POST") {
        const raw = await readBody(req);
        if (raw === null) {
          sendJson(res, 413, { reason: "too_large", message: "request body exceeds the cap" });
          return true;
        }
        let body: { lang?: unknown; key?: unknown; value?: unknown; addLanguage?: unknown };
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { reason: "bad_json", message: "a strings write is JSON: { lang, key, value } or { addLanguage }" });
          return true;
        }
        if (typeof body.addLanguage === "string") {
          const lang = body.addLanguage.toLowerCase();
          if (!STRINGS_LANG.test(lang) || lang === "en") {
            sendJson(res, 400, { reason: "bad_language", message: "a language is a lowercase BCP-47 tag, and en is the source language" });
            return true;
          }
          if (!existsSync(stringsTablePath(config, lang))) writeStringsTable(config, lang, {});
          sendJson(res, 200, { ok: true, languages: projectLanguages(config) });
          return true;
        }
        const lang = typeof body.lang === "string" ? body.lang.toLowerCase() : "";
        const key = typeof body.key === "string" ? body.key : "";
        const value = typeof body.value === "string" ? body.value : "";
        if (!STRINGS_LANG.test(lang) || lang === "en" || key.length === 0) {
          sendJson(res, 400, { reason: "bad_write", message: "a table edit names a non-en language and a source-string key" });
          return true;
        }
        const table = readStringsTable(config, lang);
        if (value.length === 0) delete table[key];
        else table[key] = value;
        // an emptied table keeps its file: the language column survives clearing its
        // last cell (absence of the FILE is how a language is removed, by hand for now)
        writeStringsTable(config, lang, table);
        sendJson(res, 200, { ok: true });
        return true;
      }
      const uses = new Map<string, number>();
      for (const doc of listDocuments(config)) {
        try {
          collectDisplayStrings(parseDsx(readFileSync(doc.path, "utf8")), uses);
        } catch { /* an unparsable document contributes no rows - the tree view shows the error */ }
      }
      const languages = projectLanguages(config);
      const tables: { [lang: string]: { [key: string]: string } } = {};
      for (const lang of languages) tables[lang] = readStringsTable(config, lang);
      // extraction ∪ table keys: a translated string whose source line moved on still
      // shows, flagged by uses=0, instead of silently vanishing from the table
      const keys = new Set<string>(uses.keys());
      for (const lang of languages) for (const k of Object.keys(tables[lang]!)) keys.add(k);
      const rows = [...keys].sort().map((key) => ({
        key,
        uses: uses.get(key) ?? 0,
        values: Object.fromEntries(languages.map((lang) => [lang, tables[lang]![key] ?? ""])),
      }));
      sendJson(res, 200, { languages, keys: rows });
      return true;
    }

    // ── DISTRIBUTION: the store screenshot set, and the scope each slide will render with ──
    //
    //  THE FILE IS THE STATE. `dsx.shots.json` is what `despia shot` reads, so the board edits
    //  that file and nothing else - there is no editor-side copy of a screenshot set to drift
    //  from the one the capture uses.
    //
    //  THE SCOPE IS RESOLVED HERE, NOT DESCRIBED HERE. Every slide is run through
    //  `resolveShotScope` - the same pure resolver the capture runs - so the Data panel shows
    //  the value the image will actually be rendered with and the tier it came from, including
    //  the rows that are UNRESOLVED and would refuse to produce an image. A panel that merely
    //  listed the declarations would be a second opinion about the ladder, and the first time
    //  it disagreed the author would trust the panel and ship nothing.
    if (pathname === "/edit/api/shots") {
      const shotsPath = join(config.root, SHOT_CONFIG_FILENAME);
      if (req.method === "PUT" || req.method === "POST") {
        const raw = await readBody(req);
        if (raw === null) {
          sendJson(res, 413, { reason: "too_large", message: "request body exceeds the cap" });
          return true;
        }
        let body: { shots?: unknown; hydrate?: unknown; defaults?: unknown };
        try {
          body = JSON.parse(raw.toString("utf8")) as typeof body;
        } catch {
          sendJson(res, 400, { reason: "bad_json", message: "a shots write is JSON: { shots, hydrate?, defaults? }" });
          return true;
        }
        if (!Array.isArray(body.shots)) {
          sendJson(res, 400, { reason: "bad_write", message: "a shots write carries the whole `shots` array" });
          return true;
        }
        // MERGE, never replace: `outDir`, `environment` and anything a later version of the
        // file grows are not the board's to know about, and a writer that emitted only the
        // keys it understands would silently delete the egress channel declaration.
        const existing = existsSync(shotsPath)
          ? JSON.parse(readFileSync(shotsPath, "utf8")) as { [k: string]: unknown }
          : {};
        existing["shots"] = body.shots;
        if (body.hydrate !== undefined) existing["hydrate"] = body.hydrate;
        if (body.defaults !== undefined) existing["defaults"] = body.defaults;
        writeFileSync(shotsPath, `${JSON.stringify(existing, null, 2)}\n`);
        sendJson(res, 200, { ok: true, shots: (body.shots as unknown[]).length });
        return true;
      }
      const shotConfig = loadShotConfig(config.root);
      const schema = referenceJson("shot-properties.json");
      if (schema === null) {
        sendJson(res, 404, { reason: "missing_reference", message: "shot-properties.json was not found next to the toolchain" });
        return true;
      }
      const heads = new Map<string, ShotHead | null>();
      const scopes: { [as: string]: unknown } = {};
      for (const shot of shotConfig.shots) {
        const merged = { ...(shotConfig.defaults ?? {}), ...shot };
        const document = String(merged.document ?? "");
        if (!heads.has(document)) heads.set(document, documentHead(config, document));
        const head = heads.get(document) ?? null;
        const as = String(shot.as ?? document);
        if (head === null) {
          scopes[as] = { document, ok: false, rows: [], missing: true };
          continue;
        }
        const result = resolveShotScope({
          head,
          hydrate: shotConfig.hydrate,
          overrides: { vars: merged.vars as Dict | undefined, globals: merged.globals as Dict | undefined },
          routeParams: merged.routeParams,
          mode: merged.mode ?? "sample",
        });
        scopes[as] = {
          document,
          ok: result.unresolved.length === 0,
          missing: false,
          rows: scopeRows(head, merged, shotConfig, result),
        };
      }
      // THE DEVICE IS A FACT ABOUT THE SET (a listing is uploaded per size), so it is read
      // off the defaults tier first and only falls back to the first slide's own.
      const device = shotConfig.defaults?.device ?? shotConfig.shots[0]?.device ?? "iphone-6.9";
      sendJson(res, 200, {
        shots: shotConfig.shots,
        defaults: shotConfig.defaults ?? {},
        hydrate: shotConfig.hydrate ?? { global: {} },
        device,
        outDir: shotConfig.outDir ?? "",
        schema,
        scopes,
      });
      return true;
    }

    // ── DISTRIBUTION, THE FILM HALF (12-marketing-video.md): the compositions on disk ──
    //
    //  THE FILE IS THE STATE, exactly as the screenshot set: a film is
    //  marketing/<name>/composition.dsx, the same document `despia film` renders, so the
    //  board lists what is really there and a render writes beside the source. The listing
    //  carries each composition's CHECK verdict - a refused film is shown refused, with the
    //  guard's own words, because an unlawful film produces no video anywhere.
    if (pathname === "/edit/api/films") {
      const films: Array<{
        path: string; id: string; durationMs: number; fps: number;
        width: number; height: number; scenes: number;
        problems: Array<{ code: string; message: string }>;
      }> = [];
      const marketingDir = join(config.root, "marketing");
      if (existsSync(marketingDir)) {
        for (const entry of readdirSync(marketingDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const compPath = join(marketingDir, entry.name, "composition.dsx");
          if (!existsSync(compPath)) continue;
          const rel = relative(config.root, compPath).split(sep).join("/");
          try {
            const { film, problems } = loadFilmDocument(compPath);
            films.push({
              path: rel, id: film.id, durationMs: film.durationMs, fps: film.fps,
              width: film.format.width, height: film.format.height,
              scenes: film.scenes.length, problems,
            });
          } catch (e) {
            films.push({
              path: rel, id: entry.name, durationMs: 0, fps: 0, width: 0, height: 0, scenes: 0,
              problems: [{ code: "parse", message: e instanceof FilmDocumentError ? e.message : String(e) }],
            });
          }
        }
      }
      sendJson(res, 200, { films, ffmpeg: ffmpegAvailable() });
      return true;
    }
    if (pathname === "/edit/api/films/render" && req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { reason: "too_large", message: "request body exceeds the cap" });
        return true;
      }
      let body: { path?: unknown; frames?: unknown };
      try { body = JSON.parse(raw.toString("utf8")) as typeof body; } catch {
        sendJson(res, 400, { reason: "bad_json", message: "a render request is JSON: { path, frames? }" });
        return true;
      }
      const rel = typeof body.path === "string" ? body.path : "";
      const compPath = resolve(config.root, ...rel.split("/"));
      if (!compPath.startsWith(config.root + sep) || !compPath.endsWith("composition.dsx") || !existsSync(compPath)) {
        sendJson(res, 400, { reason: "bad_path", message: "path names a marketing composition inside the project" });
        return true;
      }
      let loaded;
      try { loaded = loadFilmDocument(compPath); } catch (e) {
        sendJson(res, 422, { reason: "unlawful", message: e instanceof Error ? e.message : String(e) });
        return true;
      }
      if (loaded.problems.length > 0) {
        sendJson(res, 422, { reason: "refused", problems: loaded.problems });
        return true;
      }
      const browser = await launchShotBrowser();
      try {
        const outcome = await renderFilm(browser, config, loaded.film, {
          webRoot: repoWebRoot(), projectRoot: config.root, outDir: dirname(compPath),
          encoder: "webm",
          frameLimit: typeof body.frames === "number" ? body.frames : undefined,
        });
        if (!outcome.ok) {
          sendJson(res, 422, { reason: "render_failed", errors: outcome.errors });
          return true;
        }
        sendJson(res, 200, {
          ok: true,
          video: relative(config.root, outcome.videoPath!).split(sep).join("/"),
          frames: outcome.frameCount,
        });
      } finally {
        await (browser as unknown as { close(): Promise<void> }).close();
      }
      return true;
    }

    // ── the STRUCTURAL endpoints: the same document, addressed by element ────────────
    //
    //  These are what make the editor an editor rather than a text box with a preview. All
    //  three run on the surgery engine, which splices the author's own bytes, so a visual
    //  change lands as the one-line diff a reviewer expects instead of a reformat.

    // ── the MAP: every surface in the project and what reaches it ───────────────────
    //
    //  DERIVED, never stored (02-canvas.md §0). There is no canvas file, so there is nothing
    //  to go stale and nothing to merge: the answer is a pure function of the documents on
    //  disk plus the route table, recomputed per request. The layout is deterministic for the
    //  same reason - a node that moves between two reads would make the picture untrustworthy
    //  in exactly the way a hand-drawn diagram is.
    if (pathname === "/edit/api/graph") {
      const graph = buildScreenGraph(graphDocuments(config), graphRoutes(config), graphEntry(config));
      const layout = layoutScreenGraph(graph);
      const placed = new Map(layout.nodes.map((n) => [n.id, n]));
      sendJson(res, 200, {
        width: layout.width,
        height: layout.height,
        nodes: layout.nodes,
        // The path travels WITH the edge: the client draws it, but it must not be the client
        // that decides the geometry, or two surfaces would disagree about the same map.
        edges: graph.edges.map((edge) => {
          const from = placed.get(edge.from);
          const to = edge.to === null ? undefined : placed.get(edge.to);
          if (from === undefined || to === undefined || to.id === from.id) return { ...edge };
          const geometry = edgeGeometry(from, to);
          return { ...edge, geometry, mid: edgeMidpoint(geometry) };
        }),
        dangling: graph.dangling,
      });
      return true;
    }

    // ── the LOGIC of one document: the business logic, drawn true to the code ───────
    //
    //  Two shapes, because they answer two questions. Without `?body=` it is the INDEX: what
    //  logic this document contains and how big each piece is. With one, it is the DRAWING.
    //
    //  The drawing is derived the same way the map is, and it carries its own compaction
    //  measurement, so the claim that this stays readable as a body grows is checkable from
    //  the response rather than taken on trust.
    if (pathname.startsWith("/edit/api/logic/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/logic/".length));
      // A backend's actions are code too, and "click a route, see its logic" is the whole
      // reason the two views are one product. `server/notes.dsx` addresses one.
      const abs = resolveReadableDocument(config, name);
      if (abs === null || !existsSync(abs)) {
        sendJson(res, 404, { reason: "unknown_document", message: `${name} is not a readable .dsx` });
        return true;
      }
      const logicSource = readFileSync(abs, "utf8");
      const bodies = logicBodies(logicSource);
      // The agent face of this document, keyed by action. A tool is not a separate KIND of
      // body - it is the same declared action with a second caller - so it rides as a fact
      // ON the body rather than as a second list that could disagree with the first.
      const agents = agentFaceOf(name, logicSource);
      const agentOf = (body: LogicBody): AgentFace | undefined =>
        body.kind === "action" ? agents.get(body.name) : undefined;
      const wanted = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("body");
      if (wanted === null) {
        sendJson(res, 200, {
          document: name,
          bodies: bodies.map((body) => {
            const agent = agentOf(body);
            return {
              id: body.id, kind: body.kind, name: body.name,
              steps: projectFlow(body.source, body.name).statements,
              ...(agent !== undefined ? { agent } : {}),
            };
          }),
        });
        return true;
      }
      const body = bodies.find((b) => b.id === wanted);
      if (body === undefined) {
        sendJson(res, 404, { reason: "unknown_body", message: `${name} has no code body ${JSON.stringify(wanted)}` });
        return true;
      }
      // THE ROUND TRIP, CHECKED PER REQUEST. The drawing is only allowed to be authoritative
      // because reconstructing it reproduces the author's bytes exactly (`exact` in the
      // flow), and the write endpoint refuses a body whose projection is not exact - so the
      // flowchart can never outrank the file.
      const surface = name.startsWith("server/") ? "backend" as const : "frontend" as const;
      const agent = agentOf(body);
      const flow = projectFlow(body.source, triggerTitle(body, agent));
      sendJson(res, 200, {
        document: name, body: body.id, kind: body.kind, name: body.name, surface,
        writable: body.span !== undefined,
        insertable: insertCatalog(surface),
        ...(agent !== undefined ? { agent } : {}),
        ...flow,
      });
      return true;
    }

    // ── the EXPRESSION at a span, as a dataflow drawing ─────────────────────────────
    //
    //  The logic view answers "what runs next" and draws it downward. This answers the other
    //  half of the same file - "where does this value come from" - and draws it rightward,
    //  ending in a fixed Result. It addresses a SPAN inside a body, which is exactly the
    //  coordinate an argument row on the logic canvas already hands out, so tapping a row
    //  opens its formula with no new identity to track. With no span it projects the whole
    //  body, which is what a formula body or a computed variable wants.
    //
    //  There is no write endpoint here on purpose: an expression edit is a `replace` over a
    //  body-relative span, which is a flow op, so it goes through /edit/api/flowedit and
    //  gets the same stale-revision check, the same byte-exactness refusal and the same
    //  whole-document reparse before anything is written.
    if (pathname.startsWith("/edit/api/expr/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/expr/".length));
      const abs = resolveReadableDocument(config, name);
      if (abs === null || !existsSync(abs)) {
        sendJson(res, 404, { reason: "unknown_document", message: `${name} is not a readable .dsx` });
        return true;
      }
      const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const source = readFileSync(abs, "utf8");
      const bodies = logicBodies(source);
      const body = bodies.find((b) => b.id === query.get("body"));
      if (body === undefined) {
        sendJson(res, 404, { reason: "unknown_body", message: `${name} has no code body ${JSON.stringify(query.get("body"))}` });
        return true;
      }
      const len = body.source.length;
      const start = clampByte(query.get("at"), 0, len);
      const end = clampByte(query.get("to"), len, len);
      if (end <= start) {
        sendJson(res, 400, { reason: "bad_request", message: "`to` must be past `at`, both body-relative bytes" });
        return true;
      }
      // THE BODY'S OWN ENTITY REGIME, never the default. An `on:tap` body is decoded by the
      // XML reader before the evaluator sees it (five entities plus the numeric forms,
      // inside literals too); a code-tag body is decoded by the evaluator (three entities,
      // outside literals only). Projecting a handler under the code-tag rule drew `&quot;x&quot;`
      // as part of the expression rather than as the string `x`, and every value that
      // drawing handed out was the transport rather than the language - which is a rewritten
      // string literal the moment anything is saved.
      const flow = projectExpr(body.source, { start, end }, body.context);
      const statements = projectFlow(body.source, body.name);
      sendJson(res, 200, {
        document: name, body: body.id, name: body.name,
        // The write door's own preconditions, answered here so the surface can draw itself
        // read-only rather than discovering the refusal on save. `flow.exact` belongs in the
        // list: a drawing that cannot reproduce its own bytes is a second source of truth,
        // and the door refuses to write through one.
        writable: body.span !== undefined && statements.exact && flow.exact,
        rev: statements.rev,
        scope: scopeAt(body.source, start, declaredInputs(source, body.id), documentNames(source)),
        catalog: exprCatalog(),
        ...flow,
      });
      return true;
    }

    // ── the SCOPE of one expression: what a formula at this byte may name ───────────
    //
    //  An argument row is a formula, and a formula is only writable if the author knows what
    //  is in scope where it sits. Every one of those names is derivable from the file - the
    //  action's inputs, the binders of each enclosing loop or callback, the locals declared
    //  above, and the document's own declarations - so the editor asks rather than making the
    //  author remember. `at` is a body-relative byte offset, the same coordinate the drawing
    //  hands out; `text` is optional and, when given, comes back classified into its mode.
    if (pathname.startsWith("/edit/api/scope/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/scope/".length));
      const abs = resolveReadableDocument(config, name);
      if (abs === null || !existsSync(abs)) {
        sendJson(res, 404, { reason: "unknown_document", message: `${name} is not a readable .dsx` });
        return true;
      }
      const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const source = readFileSync(abs, "utf8");
      const bodies = logicBodies(source);
      const body = bodies.find((b) => b.id === query.get("body"));
      if (body === undefined) {
        sendJson(res, 404, { reason: "unknown_body", message: `${name} has no code body ${JSON.stringify(query.get("body"))}` });
        return true;
      }
      const at = clampByte(query.get("at"), 0, body.source.length);
      const inputs = declaredInputs(source, body.id);
      const names = scopeAt(body.source, at, inputs, documentNames(source));
      const text = query.get("text");
      sendJson(res, 200, {
        document: name, body: body.id, at,
        names,
        ...(text === null ? {} : { mode: valueMode(text) }),
      });
      return true;
    }

    // ── the FLOW WRITE: a visual edit becomes a text splice, verified twice ──────────
    //
    //  The client names the body, the revision it drew, and ONE operation in body-relative
    //  byte offsets (the offsets the projection itself handed out). The server re-reads the
    //  file, refuses a stale revision, refuses a body whose projection is not exact, splices,
    //  re-parses the whole document, and only then writes. A refusal is a 409 with the
    //  reason - never a corrupted file, never a lost byte outside the named span.
    //
    //  Deliberately resolved through the READ boundary: backend logic (`server/*.dsx`
    //  actions) edits through the same flow the frontend does - one logic editor, two
    //  vocabularies - and this endpoint touches only code bodies, never markup.
    if (pathname.startsWith("/edit/api/flowedit/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/flowedit/".length));
      if (req.method !== "POST") {
        res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
        res.end(JSON.stringify({ reason: "method_not_allowed", message: "POST applies a flow edit" }));
        return true;
      }
      const abs = resolveReadableDocument(config, name);
      if (abs === null || !existsSync(abs)) {
        sendJson(res, 404, { reason: "unknown_document", message: `${name} is not a readable .dsx` });
        return true;
      }
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { reason: "bad_request", message: "edit exceeds the size cap" });
        return true;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(res, 400, { reason: "bad_request", message: "body is not JSON" });
        return true;
      }
      if (!isRecord(payload) || typeof payload["body"] !== "string" || typeof payload["rev"] !== "string" || !isRecord(payload["op"])) {
        sendJson(res, 400, { reason: "bad_request", message: "a flow edit names { body, rev, op } and may name { within }" });
        return true;
      }
      const source = readFileSync(abs, "utf8");
      const bodies = logicBodies(source);
      const body = bodies.find((b) => b.id === payload["body"]);
      if (body === undefined || body.span === undefined) {
        sendJson(res, 404, { reason: "unknown_body", message: `${name} has no addressable body ${JSON.stringify(payload["body"])}` });
        return true;
      }
      // INLINE HANDLERS EDIT TOO. They are 55.8% of the logic in this repo, and the refusal
      // here was protecting against a splice that could not escape for an attribute context -
      // `encodeForBody` now escapes the quote and the newline, `applyFlowEdit` is identity on
      // an unchanged replace, and every splice still has to reparse the whole document below
      // before a byte is written. dist/flow/attr.ts is the round trip over all three.
      const flow = projectFlow(body.source, body.name);
      if (flow.rev !== payload["rev"]) {
        sendJson(res, 409, { reason: "stale_revision", message: "the file changed since this drawing - reload the flow" });
        return true;
      }
      if (!flow.exact) {
        sendJson(res, 409, { reason: "refused_edit", message: "this body's projection is not byte-exact, so visual edits are disabled for it" });
        return true;
      }
      const op = parseFlowOp(payload["op"], body.source.length);
      if (op === null) {
        sendJson(res, 400, { reason: "bad_request", message: "op must be insert{at,text} | replace{span,text} | remove{span} | move{span,to} within the body" });
        return true;
      }
      const nextBody = applyFlowEdit(body.source, op, body.context);
      // A no-op reaches the file as nothing at all: no write, no mtime, no rebuild, and none
      // of the gates below - pressing Save on an untouched row must be free.
      if (nextBody !== body.source) {
        // `within` is the range the client DREW: an expression edit is a replace over an
        // operand, and only the surface that asked for that drawing knows which formula the
        // operand belongs to. Optional, because the statement canvas has no such range - the
        // server derives what it can either way, so omitting it narrows the check rather
        // than turning it off.
        const named = parseWithin(payload["within"], body.source.length);
        const refusal = refuseUnsafeEdit(body.source, nextBody, op, body.context, flow, named);
        if (refusal !== null) {
          sendJson(res, 409, { reason: "refused_edit", message: refusal });
          return true;
        }
      }
      const nextSource = source.slice(0, body.span.start) + nextBody + source.slice(body.span.end);
      try {
        parseDsx(nextSource);
      } catch (e) {
        sendJson(res, 409, {
          reason: "refused_edit",
          message: `that edit would break the document: ${e instanceof Error ? e.message : String(e)}`,
        });
        return true;
      }
      if (nextSource !== source) writeFileSync(abs, nextSource);
      sendJson(res, 200, {
        saved: name, body: body.id,
        rev: projectFlow(nextBody, body.name).rev,
        bytes: Buffer.byteLength(nextSource),
      });
      return true;
    }

    // ── the SERVER: routes, data and work, projected from the document ──────────────
    //
    //  Without a name it lists the project's `<server>` documents. With one it is the three
    //  views. A document that does not parse answers 422 with the reader's own message, which
    //  names the line and the accepted attributes - the server grammar validates itself, and
    //  passing that through is worth more than a generic failure.
    if (pathname === "/edit/api/server" || pathname.startsWith("/edit/api/server/")) {
      const name = pathname === "/edit/api/server"
        ? "" : decodeURIComponent(pathname.slice("/edit/api/server/".length));
      if (name === "") {
        sendJson(res, 200, { documents: serverDocuments(config) });
        return true;
      }
      const abs = resolveServerDocument(config, name);
      if (abs === null || !existsSync(abs)) {
        sendJson(res, 404, { reason: "unknown_document", message: `${name} is not a .dsx under server/` });
        return true;
      }
      try {
        const source = readFileSync(abs, "utf8");
        const doc = readServerDocument(source, `server/${name}`, name.replace(/\.dsx$/, ""));
        // The siblings feed the deployment-wide spend plane. One that does not parse is
        // skipped here — it fails ITS OWN view with the reader's message, and a broken
        // neighbour must not blank the document a person is looking at.
        const all: ServerDoc[] = [doc];
        for (const sibling of serverDocuments(config)) {
          if (sibling === name) continue;
          const sibAbs = resolveServerDocument(config, sibling);
          if (sibAbs === null || !existsSync(sibAbs)) continue;
          try {
            all.push(readServerDocument(readFileSync(sibAbs, "utf8"), `server/${sibling}`, sibling.replace(/\.dsx$/, "")));
          } catch { /* its own view names the line */ }
        }
        const views = serverViews(doc, all);
        // Each tool row's SURGERY ADDRESS (WE7): `<tool>` rows are children of the root
        // `<server>` element, so the address is one index — computed on the same parse the
        // edit door runs, which is what keeps the address and the splice in agreement.
        const paths = new Map<string, string>();
        try {
          const root = parseDsx(source);
          for (const [i, child] of root.children.entries()) {
            if (child.tag !== "tool") continue;
            paths.set(child.attrs["as"] ?? child.attrs["action"] ?? "", String(i));
          }
        } catch { /* an unparseable body already answered 422 above */ }
        const tools = views.tools.map((t) => ({ ...t, path: paths.get(t.name) ?? "" }));
        sendJson(res, 200, { document: name, ...views, tools });
      } catch (e) {
        const known = e instanceof ServerDocumentError;
        sendJson(res, known ? 422 : 500, {
          reason: known ? "unreadable_document" : "server_failed",
          message: e instanceof Error ? e.message : String(e),
        });
      }
      return true;
    }

    // ── the HEAD: the document's state-and-logic half, as declarations ─────────────
    //
    //  The data-store surface lists what the document DECLARES — plain variables (the
    //  seeds the logic index deliberately leaves out), computed variables, formulas,
    //  actions and api blocks — and pairs each with the RUNNING value from the live
    //  channel. Declarations here, drawings on /edit/api/logic, values on the dev
    //  server's state path: three projections, one file.
    if (pathname.startsWith("/edit/api/head/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/head/".length));
      const doc = readDocument(config, name, res);
      if (doc === null) return true;
      let root;
      try {
        root = parseDsx(doc.source);
      } catch (e) {
        sendJson(res, 422, { reason: "unparseable_document", message: e instanceof Error ? e.message : String(e) });
        return true;
      }
      const head = root.children.find((c) => c.tag === "head");
      const declarations: { kind: string; name: string; preview: string; sample?: string }[] = [];
      for (const decl of head?.children ?? []) {
        const as = decl.attrs["as"];
        if (as === undefined) continue;
        const kind = decl.tag === "variable"
          ? (decl.attrs["computed"] === "true" ? "computed" : "variable")
          : decl.tag;
        if (kind !== "variable" && kind !== "computed" && kind !== "formula" && kind !== "action" && kind !== "api") continue;
        const body = kind === "api" ? (decl.attrs["url"] ?? "") : (decl.text ?? "").trim();
        const oneLine = body.replace(/\s+/g, " ").trim();
        const entry: { kind: string; name: string; preview: string; sample?: string; inputs?: string[] } = {
          kind, name: as, preview: oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine,
        };
        // An action's declared inputs ARE its agent-facing shape (proposals/webmcp.md): a
        // surface that lets someone choose an action needs them before any tool row exists.
        if (kind === "action") entry.inputs = Object.keys(decl.attrs).filter((k) => !HEAD_INPUT_SKIP.has(k));
        // the sample-value plane (master plan P3): verbatim JSON text, v1 kinds only -
        // the Studio resolves live-beats-sample-beats-initial and badges sample-fed pills
        if (decl.attrs["sample"] !== undefined && (kind === "variable" || kind === "api")) {
          entry.sample = decl.attrs["sample"];
        }
        declarations.push(entry);
      }
      // The AGENT SURFACE of this document (proposals/webmcp.md §3): its `<tool>` rows,
      // projected the SAME way the runtime projects them, so the editor shows exactly the
      // descriptor an agent receives - including the derived schema, which is the whole
      // point of the row carrying no schema of its own. A row that would fail the build
      // comes back as an ERROR rather than a tool, because an author must see the broken
      // one, not a shorter list.
      const toolRows: ToolRow[] = [];
      // The NodePath of each row, so the Studio can EDIT it: the surgery door addresses a
      // node by dotted child indices, and a surface that can only read is a surface that
      // sends people back to the file. `0` is the head (the first child of the root).
      const toolPaths = new Map<string, string>();
      const headIndex = root.children.findIndex((c) => c.tag === "head");
      for (const [i, decl] of (head?.children ?? []).entries()) {
        if (decl.tag !== "tool") continue;
        const row: ToolRow = { action: decl.attrs["action"] ?? "", description: decl.attrs["description"] ?? "" };
        if (decl.attrs["as"] !== undefined) row.as = decl.attrs["as"];
        if (decl.attrs["mutates"] !== undefined) row.mutates = decl.attrs["mutates"];
        toolRows.push(row);
        toolPaths.set(row.as ?? row.action, `${headIndex}.${i}`);
      }
      const declaredInputs = new Map<string, readonly string[]>();
      for (const decl of head?.children ?? []) {
        const as = decl.attrs["as"];
        if (decl.tag !== "action" || as === undefined) continue;
        declaredInputs.set(as, Object.keys(decl.attrs).filter((k) => !HEAD_INPUT_SKIP.has(k)));
      }
      const projected = projectTools(toolRows, declaredInputs);
      const tools = projected.descriptors.map((d) => ({
        name: d.name,
        description: d.description,
        action: toolRows.find((r) => (r.as ?? r.action) === d.name)?.action ?? "",
        mutates: toolRows.find((r) => (r.as ?? r.action) === d.name)?.mutates ?? "",
        inputs: Object.keys(d.inputSchema.properties),
        readOnly: d.annotations?.readOnlyHint === true,
        path: toolPaths.get(d.name) ?? "",
      }));
      const toolErrors = projected.errors.map((e) => ({ code: e.code, name: e.name, message: e.message }));
      // `headChildren` is the append slot for insertNode - counted on the SAME parse the
      // surgery door will run, so "insert at the end of the head" cannot drift from what
      // the door considers the end (platform/09-agent-tools.md WE5, the one-batch gesture).
      sendJson(res, 200, {
        document: name, declarations, tools, toolErrors,
        headPath: String(headIndex), headChildren: head?.children.length ?? 0,
      });
      return true;
    }

    if (pathname.startsWith("/edit/api/nid/")) {
      // SELECT ON THE REAL RENDER (master plan P5): the running preview reports a pick
      // as (owner, nid) — the IR identity every element wears (data-dsx-n). This
      // endpoint turns a nid back into the SOURCE address an edit takes: nid is the
      // preorder index over the source tree minus the head subtree (compileComponent
      // splices the head child out; foldTree keeps structure 1:1), recomputed here from
      // the file of record, so the answer is always as fresh as the bytes on disk.
      const name = decodeURIComponent(pathname.slice("/edit/api/nid/".length));
      const doc = readDocument(config, name, res);
      if (doc === null) return true;
      const wanted = Number.parseInt(new URL(req.url ?? "/", "http://localhost").searchParams.get("nid") ?? "", 10);
      if (!Number.isInteger(wanted) || wanted < 0) {
        sendJson(res, 400, { reason: "invalid", message: "nid must be a non-negative integer" });
        return true;
      }
      let root: TreeNode;
      try {
        root = projectTree(doc.source);
      } catch (e) {
        sendJson(res, 422, { reason: "unparseable_document", message: e instanceof Error ? e.message : String(e) });
        return true;
      }
      let count = -1;
      let hit: TreeNode | null = null;
      const walk = (node: TreeNode): void => {
        if (hit !== null) return;
        count += 1;
        if (count === wanted) { hit = node; return; }
        for (const child of node.children) {
          if (node.path.length === 0 && child.tag === "head") continue;
          walk(child);
        }
      };
      walk(root);
      if (hit === null) {
        sendJson(res, 404, { reason: "not_found", detail: "nid" });
        return true;
      }
      const found: TreeNode = hit;
      // the node's STATIC DISPLAY STRING (P12 mapping view) - the same rule the strings
      // extractor applies, so a canvas pick can land on its translation row
      let display = "";
      const displayAttr = DISPLAY_TAGS[found.tag];
      if (displayAttr !== undefined && found.attrs["bind"] === undefined) {
        const inner = found.children.length === 0 && !found.code
          ? (/>\s*([^<]+?)\s*</.exec(found.source)?.[1] ?? undefined)
          : undefined;
        const raw = displayAttr === "value" ? (found.attrs["value"] ?? inner) : found.attrs[displayAttr];
        if (raw !== undefined && raw.length > 0 && !raw.includes("{{")) display = raw;
      }
      sendJson(res, 200, {
        document: name,
        nid: wanted,
        path: pathId(found.path),
        parent: found.path.length === 0 ? null : pathId(found.path.slice(0, -1)),
        index: found.path.length === 0 ? null : found.path[found.path.length - 1],
        tag: found.tag,
        display,
      });
      return true;
    }

    if (pathname.startsWith("/edit/api/tree/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/tree/".length));
      const doc = readDocument(config, name, res);
      if (doc === null) return true;
      let rows;
      try {
        rows = flattenTree(doc.source);
      } catch (e) {
        sendJson(res, 422, { reason: "unparseable_document", message: e instanceof Error ? e.message : String(e) });
        return true;
      }
      // THE TREE IS THE BODY (06 §2): visual elements and components only. The <head> is
      // the document's OTHER half — state and logic — and it has its own surface (the
      // State view over /edit/api/logic + the live store), so its subtree never renders
      // as layers. Paths stay the file's real paths: rows are filtered, never renumbered.
      const headRows = new Set(
        rows.filter((row) => row.tag === "head" && row.path.length === 1).map((row) => pathId(row.path)),
      );
      const inHead = (row: (typeof rows)[number]): boolean => {
        if (row.path.length === 0) return false;
        return headRows.has(pathId(row.path.slice(0, 1)));
      };
      sendJson(res, 200, {
        document: name,
        rows: rows.filter((row) => !inHead(row)).map((row) => ({
          id: pathId(row.path),
          parent: row.parent === null ? null : pathId(row.parent),
          tag: row.tag,
          label: row.label,
          klass: row.klass,
          bound: row.bound,
          visibleIf: row.visibleIf,
          depth: row.depth,
          hasChildren: row.hasChildren,
          // the literal words this row puts on screen, and which attribute holds them — a
          // copy pass addresses the edit with exactly these two fields plus the id
          text: row.text,
          textAttr: row.textAttr,
          // the same glyph the add panel shows for this element, so an element looks like
          // ITSELF everywhere; a project component gets the component glyph
          icon: ELEMENT_ICONS[row.tag] ?? (row.tag[0] === row.tag[0]?.toUpperCase() ? "dsx.el.component" : "dsx.el.stack"),
        })),
      });
      return true;
    }

    if (pathname.startsWith("/edit/api/node/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/node/".length));
      const doc = readDocument(config, name, res);
      if (doc === null) return true;
      const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const path = parsePathId(query.get("path") ?? "");
      if (path === null) {
        sendJson(res, 400, { reason: "bad_request", message: "path must be dot-separated child indices" });
        return true;
      }
      let node;
      try {
        node = nodeAt(projectTree(doc.source), path);
      } catch (e) {
        sendJson(res, 422, { reason: "unparseable_document", message: e instanceof Error ? e.message : String(e) });
        return true;
      }
      if (node === null) {
        sendJson(res, 404, { reason: "unknown_node", message: `no element at ${query.get("path") ?? ""}` });
        return true;
      }
      // `style` is BOTH: it stays in `attributes` so the author can edit the whole declaration
      // list as text, and it is split into `styles` so the panel can offer one control per
      // property. Neither is derived from the other at write time - each has its own edit.
      sendJson(res, 200, {
        document: name,
        path: pathId(node.path),
        tag: node.tag,
        icon: ELEMENT_ICONS[node.tag] ?? "dsx.el.stack",
        childCount: node.children.length,
        code: node.code,
        attributes: Object.entries(node.attrs).map(([attribute, value]) => ({ name: attribute, value })),
        styles: styleRows(node.attrs["style"]),
        // The element's own contract from the census, so the Attributes and Events tabs offer
        // only what the schema declares — an unknown attribute is a lint error the editor
        // refuses to create, and the event vocabulary is the element's, never a hand list.
        schema: elementSchema(node.tag),
        // The component's typed STYLE contract (style-overrides.md): the declared knobs from
        // the same generated catalog, so the style panel can finally render them as controls.
        // Current values ride `attributes` as `override:<name>` rows; a write is an ordinary
        // setAttribute splice through the one door.
        overrides: componentOverrides(node.tag),
      });
      return true;
    }

    if (pathname.startsWith("/edit/api/edit/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/edit/".length));
      if (req.method !== "POST") {
        res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "POST" }));
        res.end(JSON.stringify({ reason: "method_not_allowed", message: "POST applies an edit" }));
        return true;
      }
      // the WE7 boundary: components, plus `server/` documents — see resolveEditableDocument
      const abs = resolveEditableDocument(config, name);
      if (abs === null) {
        sendJson(res, 404, { reason: "unknown_document", message: `${name} is not an editable .dsx (a component, or server/…)` });
        return true;
      }
      if (!existsSync(abs)) {
        sendJson(res, 404, { reason: "unknown_document", message: `${name} does not exist` });
        return true;
      }
      const doc = { abs, source: readFileSync(abs, "utf8") };
      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { reason: "bad_request", message: "edit exceeds the size cap" });
        return true;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(res, 400, { reason: "bad_request", message: "body is not JSON" });
        return true;
      }
      // ONE edit or a batch, same route: a batch is what a multi-property change or a paste
      // is, and applyEdits resolves every splice against the ORIGINAL source, so a batch is
      // not the same thing as N sequential requests (whose paths would shift under each other).
      const raw = Array.isArray(payload) ? payload
        : isRecord(payload) && Array.isArray(payload["edits"]) ? payload["edits"]
        : [payload];
      const edits: Edit[] = [];
      for (const entry of raw) {
        if (!isRecord(entry) || typeof entry["kind"] !== "string") {
          sendJson(res, 400, { reason: "bad_request", message: "each edit needs a kind" });
          return true;
        }
        const path = parsePathId(typeof entry["path"] === "string" ? entry["path"] : "");
        if (path === null) {
          sendJson(res, 400, { reason: "bad_request", message: "path must be dot-separated child indices" });
          return true;
        }
        // the cross-container move (P5b) names its target parent by the same path grammar
        if (typeof entry["toParent"] === "string") {
          const toParent = parsePathId(entry["toParent"]);
          if (toParent === null) {
            sendJson(res, 400, { reason: "bad_request", message: "toParent must be dot-separated child indices" });
            return true;
          }
          edits.push({ ...entry, path, toParent } as Edit);
          continue;
        }
        edits.push({ ...entry, path } as Edit);
      }
      //  THE PRECONDITION (plan E1, defect D4). Every visual drag comes through here, and this
      //  door used to be last-writer-wins: two editors on one file, and the slower one's paths
      //  resolved against a source that no longer existed. A caller that states which revision
      //  it drew against is now answered 409 instead of silently winning. Stating it is
      //  OPTIONAL, and that is a real limitation rather than a preference: the compiled editor
      //  does not send one yet, and refusing every request it makes would take the editor off
      //  the air to fix a race. Every response carries the current revision, so a client can
      //  start presenting it without this door changing again.
      const currentRev = documentRevision(doc.source);
      const against = requestedRevision(req, isRecord(payload) ? payload : undefined);
      if (against !== null && against !== currentRev) {
        sendJson(res, 409, {
          reason: "stale_revision",
          message: "the file changed since this edit was drawn — reload the document",
          rev: currentRev,
        });
        return true;
      }
      let result;
      try {
        result = applyEdits(doc.source, edits);
      } catch (e) {
        // A REFUSAL, not a 500: the engine refuses overlapping edits, unknown paths and
        // gestures that would change meaning (unwrapping a leaf). The author gets told which.
        const refused = e instanceof SurgeryError;
        sendJson(res, refused ? 409 : 500, {
          reason: refused ? "refused_edit" : "edit_failed",
          message: e instanceof Error ? e.message : String(e),
        });
        return true;
      }
      //  REPARSE BEFORE WRITING, the discipline /edit/api/flowedit/ already keeps: a splice
      //  that produces something the compiler cannot read must never reach disk, because the
      //  next thing to touch that file is a build, and a build failing on a file the editor
      //  wrote is the editor eating the document.
      try {
        parseDsx(result.source);
      } catch (e) {
        sendJson(res, 409, {
          reason: "refused_edit",
          message: `that edit would break the document: ${e instanceof Error ? e.message : String(e)}`,
          rev: currentRev,
        });
        return true;
      }
      // The file is the model. The dev server's watcher rebuilds and reloads every tab from
      // here, exactly as it does for a source-pane save - the editor adds no second pipeline.
      writeFileSync(doc.abs, result.source);
      const savedRev = documentRevision(result.source);
      // APP PROVENANCE (studio-apps.md §5): an edit that arrived through an app's scoped
      // funnel carries the x-despia-app header, and the ledger line lands BESIDE the state
      // it edits (.despia/apps/activity.log) so "what changed my project" has one answer.
      // The header is provenance, not authority — the funnel already gated the grant.
      const viaApp = appHeader(req);
      if (viaApp !== "") {
        try {
          mkdirSync(join(config.root, ".despia", "apps"), { recursive: true });
          appendFileSync(
            join(config.root, ".despia", "apps", "activity.log"),
            JSON.stringify({ at: new Date().toISOString(), app: viaApp, document: name, edits: edits.length, rev: savedRev }) + "\n",
          );
        } catch { /* the ledger is best-effort — a full disk must not refuse the edit itself */ }
        //  THE CHANGE SET (studio-apps.md §14). The write joins the app's open burst with the
        //  bytes that were there before it; when the burst closes the plane classifies it and
        //  it becomes a commit, or a branch and a pull request. `before` is why a revert never
        //  needs git at all.
        recordAppWrite(config, viaApp, { document: name, before: doc.source, created: false, deleted: false });
      }
      appEvents.emit("document.saved", { name, rev: savedRev, by: viaApp !== "" ? `app:${viaApp}` : "studio" });
      res.setHeader("etag", `"${savedRev}"`);
      sendJson(res, 200, {
        saved: name,
        bytes: Buffer.byteLength(result.source),
        touched: result.touched.length,
        edits: edits.length,
        rev: savedRev,
      });
      return true;
    }

    if (pathname.startsWith("/edit/api/documents/")) {
      const name = decodeURIComponent(pathname.slice("/edit/api/documents/".length));
      const abs = resolveDocument(config, name);
      if (abs === null) {
        sendJson(res, 404, { reason: "unknown_document", message: `${name} is not a .dsx under a component root` });
        return true;
      }
      if (req.method === "GET") {
        if (!existsSync(abs)) {
          sendJson(res, 404, { reason: "unknown_document", message: `${name} does not exist` });
          return true;
        }
        const bytes = readFileSync(abs);
        // The revision travels with the read, so a client that wants the precondition below
        // never has to compute it — take this back as `If-Match` and the write is conditional.
        res.writeHead(200, devHeaders("text/plain; charset=utf-8", { etag: `"${documentRevision(bytes)}"` }));
        res.end(bytes);
        return true;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        if (body === null) {
          sendJson(res, 413, { reason: "bad_request", message: "document exceeds the size cap" });
          return true;
        }
        if (body.length === 0) {
          sendJson(res, 400, { reason: "bad_request", message: "refusing to write an empty document" });
          return true;
        }
        const parentDir = dirname(abs);
        if (!existsSync(parentDir)) {
          sendJson(res, 404, { reason: "unknown_document", message: `${name}'s folder does not exist` });
          return true;
        }
        //  THE PRECONDITION (plan E1, defect D4). This body is the whole file, so a save that
        //  raced another one used to discard it entirely and answer 200. `If-Match` carries
        //  the revision the author started from; a mismatch is a 409 and nothing is written.
        //  A creating PUT (no file yet) has no revision to match, so `If-Match` on one is a
        //  precondition that cannot hold and is refused as such.
        const current = existsSync(abs) ? documentRevision(readFileSync(abs)) : null;
        const against = requestedRevision(req, undefined);
        if (against !== null && against !== current) {
          sendJson(res, 409, {
            reason: "stale_revision",
            message: current === null
              ? `${name} does not exist yet, so there is no revision to write against`
              : "the file changed since it was read — reload before saving",
            ...(current === null ? {} : { rev: current }),
          });
          return true;
        }
        //  REFUSE DSX THAT DOES NOT PARSE. The source pane is the save authority for the whole
        //  document, which made it the one door through which an unreadable file could reach
        //  disk — and the next reader of that file is a build. The reader's own message names
        //  the line, so passing it through is worth more than a generic failure.
        const text = body.toString("utf8");
        try {
          parseDsx(text);
        } catch (e) {
          sendJson(res, 409, {
            reason: "refused_edit",
            message: `refusing to write a document that does not parse: ${e instanceof Error ? e.message : String(e)}`,
            ...(current === null ? {} : { rev: current }),
          });
          return true;
        }
        const beforeBytes = current === null ? null : readFileSync(abs, "utf8");
        writeFileSync(abs, body);
        // The dev server's own watcher takes it from here: rebuild, then reload every tab.
        const savedRev = documentRevision(body);
        //  `studio.project.create` reaches this door, so the whole-document save carries the
        //  same provenance and the same change set the splice door does — a document an app
        //  ADDED is the structural case the pull-request lane exists for.
        const viaApp = appHeader(req);
        if (viaApp !== "") {
          recordAppWrite(config, viaApp, { document: name, before: beforeBytes, created: beforeBytes === null, deleted: false });
        }
        appEvents.emit("document.saved", { name, rev: savedRev, by: viaApp !== "" ? `app:${viaApp}` : "studio" });
        res.setHeader("etag", `"${savedRev}"`);
        sendJson(res, 200, { saved: name, bytes: body.length, rev: savedRev });
        return true;
      }
      res.writeHead(405, devHeaders("application/json; charset=utf-8", { allow: "GET, PUT" }));
      res.end(JSON.stringify({ reason: "method_not_allowed", message: "GET reads, PUT saves" }));
      return true;
    }
    return false;
  };
}

export interface EditOptions extends DevOptions {
  /** an explicitly chosen admission credential; absent, one is minted for this run */
  token?: string;
}

/** Boot the edit server: the dev server plus the editor mount. */
export async function startEditServer(
  config: ProjectConfig,
  opts: EditOptions = {},
): Promise<DevServer & { editor: EditorAssets; admission: string }> {
  const editor = resolveEditor(config.root);
  if (editor === null) {
    throw new EditError(
      "the editor package is not installed — run `npm install --save-dev @despia-native/canvas-editor` " +
      "in the project (the same package the hosted dashboard runs).",
    );
  }
  //  REFUSING IS BETTER THAN SERVING. A bind beyond loopback publishes a file-write API onto a
  //  network, so it may only happen with a credential the operator CHOSE — a minted one would
  //  be printed to a log nobody reads and rotate on every restart, which is a credential in
  //  name only. The refusal names the exact thing to pass.
  const host = opts.host ?? "127.0.0.1";
  const chosen = opts.token ?? "";
  if (chosen === "" && !isLoopbackHost(host)) {
    throw new EditError(
      `refusing to serve the editor on ${host}: that publishes a file-write API beyond this machine.\n` +
      "    Choose the admission credential yourself and pass it, or drop --host and stay on loopback:\n" +
      "      DESPIA_EDIT_TOKEN=$(openssl rand -base64 24) despia edit --host " + host,
    );
  }
  const admission = chosen === "" ? mintAdmission() : chosen;
  // the mount exists before the server does, so the state read and the run door are
  // both late-bound
  let liveState: () => string = () => "";
  let liveRun: (action: string, args: { [k: string]: unknown }) =>
    Promise<{ answered: boolean; ok: boolean; value: unknown; error: string | null }> =
    () => Promise.resolve({ answered: false, ok: false, value: null, error: null });
  const appEvents = createAppEventHub();
  const mount = createEditMount(config, editor, () => liveState(), admission, (action, args) => liveRun(action, args), appEvents);
  const { token: _token, ...dev } = opts;
  const server = await startDevServer(config, {
    ...dev, host, mount,
    onRebuilt: (result) => appEvents.emit("build.finished", { result }),
  });
  liveState = () => server.stateSnapshot();
  liveRun = (action, args) => server.runInApp(action, args);
  return { ...server, editor, admission };
}

/** The editor page. Self-contained on purpose: the package scripts and this markup are
 *  the whole surface — no CDN, no bundler, no framework, which is the same zero-dependency
 *  law the SDKs themselves keep. With the logic editor resolved, the same page carries the
 *  formula surface (`<despia-logic-editor>` registers alongside the canvas element). */
function editorPage(projectName: string, withLogic: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>despia edit — ${escapeHtml(projectName)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0b0c; color: #eee; font: 14px/1.5 system-ui, sans-serif; display: grid; grid-template-columns: 15rem 1fr; grid-template-rows: 3rem 1fr; height: 100vh; }
  header { grid-column: 1 / 3; display: flex; align-items: center; gap: 1rem; padding: 0 1rem; border-bottom: 1px solid #222; }
  header b { font-size: 0.95rem; }
  header .hint { color: #9a9aa0; font-size: 0.8rem; }
  header a { color: #7ab7ff; text-decoration: none; margin-left: auto; }
  nav { border-right: 1px solid #222; overflow: auto; padding: 0.5rem; }
  nav button { display: block; width: 100%; text-align: left; background: none; border: 0; color: #ddd; padding: 0.4rem 0.6rem; border-radius: 6px; cursor: pointer; font: inherit; }
  nav button.active, nav button:hover { background: #1c1c1e; }
  main { display: grid; grid-template-rows: 1fr 14rem; min-height: 0; }
  #canvas-host { min-height: 0; position: relative; }
  despia-stack-editor { position: absolute; inset: 0; }
  #source-pane { display: grid; grid-template-rows: 2rem 1fr; border-top: 1px solid #222; min-height: 0; }
  #source-bar { display: flex; align-items: center; gap: 0.75rem; padding: 0 0.75rem; color: #9a9aa0; font-size: 0.8rem; }
  #source-bar button { background: #2861ff; color: white; border: 0; border-radius: 6px; padding: 0.25rem 0.9rem; cursor: pointer; font: inherit; }
  #source-bar button:disabled { background: #333; color: #888; cursor: default; }
  #status { margin-left: auto; }
  textarea { background: #101012; color: #e6e6e6; border: 0; resize: none; padding: 0.75rem; font: 12px/1.5 ui-monospace, monospace; outline: none; }
</style>
</head>
<body>
<header>
  <b>despia edit</b>
  <span class="hint">${escapeHtml(projectName)} — the canvas renders and simulates; the source pane saves. Saving rebuilds and reloads every preview tab.</span>
  <a href="/" target="_blank" rel="noopener">open the running app ↗</a>
</header>
<nav id="documents"></nav>
<main>
  <div id="canvas-host"><despia-stack-editor id="editor"></despia-stack-editor></div>
  <div id="source-pane">
    <div id="source-bar">
      <button id="save" disabled>Save</button>
      <span>the file on disk is the truth — the canvas re-reads it on every save</span>
      <span id="status"></span>
    </div>
    <textarea id="source" spellcheck="false" aria-label="document source"></textarea>
  </div>
</main>
<script src="/edit/sdk.js"></script>
<script src="/edit/element.js"></script>
${withLogic ? '<script src="/edit/logic-sdk.js"></script>\n<script src="/edit/logic-element.js"></script>' : ""}
<script>
(function () {
  var nav = document.getElementById("documents");
  var editor = document.getElementById("editor");
  var source = document.getElementById("source");
  var save = document.getElementById("save");
  var status = document.getElementById("status");
  var current = null;
  var loadedText = "";

  function setStatus(text) { status.textContent = text; }

  function renderList(names) {
    nav.textContent = "";
    names.forEach(function (name) {
      var b = document.createElement("button");
      b.textContent = name;
      b.className = name === current ? "active" : "";
      b.addEventListener("click", function () { open(name); });
      nav.appendChild(b);
    });
  }

  function refreshCanvas(text) {
    try {
      editor.loadDSX(text);
      setStatus("");
    } catch (e) {
      setStatus("canvas: " + (e && e.message ? e.message : e));
    }
  }

  function open(name) {
    fetch("/edit/api/documents/" + encodeURIComponent(name)).then(function (r) { return r.text(); }).then(function (text) {
      current = name;
      loadedText = text;
      source.value = text;
      save.disabled = true;
      refreshCanvas(text);
      load();
    });
  }

  function load() {
    fetch("/edit/api/documents").then(function (r) { return r.json(); }).then(function (doc) {
      renderList(doc.documents);
    });
  }

  source.addEventListener("input", function () {
    save.disabled = source.value === loadedText;
  });

  save.addEventListener("click", function () {
    if (current === null) return;
    fetch("/edit/api/documents/" + encodeURIComponent(current), { method: "PUT", body: source.value })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (out) {
        if (!out.ok) { setStatus("save failed: " + (out.body.message || out.body.reason)); return; }
        loadedText = source.value;
        save.disabled = true;
        setStatus("saved " + out.body.bytes + " bytes — rebuilding");
        refreshCanvas(source.value);
      });
  });

  load();
  fetch("/edit/api/documents").then(function (r) { return r.json(); }).then(function (doc) {
    if (doc.documents.length > 0) open(doc.documents[0]);
  });
})();
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
