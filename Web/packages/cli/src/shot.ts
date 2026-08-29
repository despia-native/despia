//
//  shot.ts - THE SHOT DRIVER (platform/10-screenshot-execution.md).
//
//  Store screenshots of a DSX app, rendered from the app's own documents, with no device and
//  no simulator. The driver is deliberately thin: every decision lives in the kernel's pure
//  halves (shot-scope.ts, shot-guards.ts, shot-devices.ts) and every ORDERING decision already
//  lived in the runtime (/web/11's api DAG). What is here is the browser plumbing - arm the
//  response plane, pin the world, boot, settle, collect, guard, capture.
//
//  THE ONE MECHANISM DECISION WORTH READING (§3a). Samples are answered through the kernel's
//  own fetch seam (`RunnerFetchSeam.impl`, checked inside the production fetch path), NOT
//  through `ApiBlockOpts.seed`. Seed skips only the INITIAL fetch: a block whose materialized
//  request later changes - an `on:appear` action writes a filter variable, an upstream lands -
//  refetches by design, and under seed-plus-deny-all that refetch hits the wall, the block
//  flips to error, and the guard refuses a perfectly legitimate shot. Through the seam, the
//  refetch is answered exactly like the first one and the whole DAG runs live against declared
//  responses.
//

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";

import { buildRegistry, LAYER_STATEMENT } from "@despia/compiler";
import { compileComponent } from "@despia/compiler/component";
import {
  resolveShotScope, evaluateShotGuards, shotDevice, shotPixelSize, checkStoreConstraints,
  type ShotMode, type ShotScopeResult, type FrameReport, type GuardFinding, type AllowEmpty,
  type ShotDevice, type ShotHydrate, type ShotSnapshot,
} from "@despia/kernel";
import { loadConfig, packageRoots, type ProjectConfig } from "./config.ts";

// ── the shot profile: the file that IS the state ─────────────────────────────────────

/** One image. Everything a render needs, and nothing that lives anywhere but the project. */
export type ShotProfile = {
  /** the component to render (bare name; qualified is derived from the project scheme) */
  document: string;
  /** output basename; defaults to the document name */
  as?: string;
  route?: string;
  routeParams?: { [k: string]: unknown };
  device?: string;
  rotate?: boolean;
  scheme?: "light" | "dark";
  locale?: string;
  /** the pinned instant - "byte-reproducible" is a lie the moment a screen renders Date.now() */
  at?: string;
  timezone?: string;
  /** the compile target this image DEPICTS */
  target?: string;
  mode?: ShotMode;
  skin?: "flat" | "glass" | "refract";
  allowEmpty?: AllowEmpty;
  vars?: { [k: string]: unknown };
  globals?: { [k: string]: unknown };
};

export type ShotConfig = {
  /** the app-wide sample plane - the one place `global.session.user.name` is authored */
  hydrate?: ShotHydrate;
  defaults?: Partial<ShotProfile>;
  shots: ShotProfile[];
  /** where images land, relative to the project root */
  outDir?: string;
  /** The environment `record`/`live` may reach. A store screenshot is a PUBLISHED artifact,
   *  so production data is never a default and never an accident: a run that resolves the
   *  production channel refuses both modes and says so. The declaration is explicit because
   *  the alternative - inferring it from a url - fails open, and this must fail closed. */
  environment?: { channel: "development" | "staging" | "production"; baseUrl?: string };
};

/** Is this run allowed to reach the network at all? */
export function egressAllowed(
  shotConfig: ShotConfig, mode: ShotMode,
): { allowed: boolean; reason: string } {
  if (mode === "sample") return { allowed: false, reason: "sample mode answers from declared samples" };
  const channel = shotConfig.environment?.channel;
  if (channel === undefined) {
    return { allowed: false, reason: `${mode} needs an explicit environment.channel; absent means production` };
  }
  if (channel === "production") {
    return {
      allowed: false,
      reason: `${mode} is refused against the production channel - a store screenshot is published permanently, `
        + "so it is never rendered from production data",
    };
  }
  return { allowed: true, reason: `${mode} against the ${channel} channel` };
}

export const SHOT_CONFIG_FILENAME = "dsx.shots.json";

export function loadShotConfig(root: string): ShotConfig {
  const path = join(root, SHOT_CONFIG_FILENAME);
  if (!existsSync(path)) return { shots: [] };
  return JSON.parse(readFileSync(path, "utf8")) as ShotConfig;
}

function merged(profile: ShotProfile, defaults: Partial<ShotProfile> | undefined): ShotProfile {
  return { ...(defaults ?? {}), ...profile };
}

// ── the cassette: the audit trail, and why it carries no credentials ─────────────────

export type CassetteEntry = {
  as?: string;
  method: string;
  url: string;
  /** sha256 of the request body, never the body: a body can carry personal data too */
  bodyHash: string | null;
  status: number;
  data: unknown;
};

export type Cassette = { version: 1; recordedAt: string; entries: CassetteEntry[] };

/**
 * Headers a cassette must never carry.
 *
 * A cassette is git-tracked and reviewable - that is the whole point of it - so a recorder
 * that wrote request headers verbatim would commit a staging bearer token into a customer's
 * repository, at customer scale, forever. Stripping is not a setting; the recorder simply has
 * no field to put them in, which is the only version of this that survives contact with
 * thousands of projects.
 */
export const CASSETTE_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "authorization", "cookie", "set-cookie", "proxy-authorization",
  "x-api-key", "api-key", "x-auth-token", "authentication",
]);

function bodyHash(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return createHash("sha256").update(text).digest("hex").substring(0, 32);
}

export function cassetteKey(method: string, url: string, body: unknown): string {
  return `${method.toUpperCase()} ${url} ${bodyHash(body) ?? "-"}`;
}

/** Scan a cassette for anything that must never have been written. Runs as a gate, so a
 *  regression in the recorder is caught by a test rather than by a security review. */
export function auditCassette(cassette: Cassette): string[] {
  const problems: string[] = [];
  const text = JSON.stringify(cassette).toLowerCase();
  for (const header of CASSETTE_FORBIDDEN_HEADERS) {
    if (text.includes(`"${header}"`)) problems.push(`cassette carries a ${header} field`);
  }
  if (/\bbearer\s+[a-z0-9._-]{8,}/i.test(JSON.stringify(cassette))) {
    problems.push("cassette carries what looks like a bearer token");
  }
  return problems;
}

// ── the report ───────────────────────────────────────────────────────────────────────

export type ShotOutcome = {
  profile: ShotProfile;
  name: string;
  ok: boolean;
  /** written only when ok */
  path?: string;
  width?: number;
  height?: number;
  scope?: ShotScopeResult;
  findings: GuardFinding[];
  unresolved: ShotScopeResult["unresolved"];
  storeFailures: Array<{ rule: string; detail: string }>;
  errors: string[];
};

export function outcomeReport(outcome: ShotOutcome): string {
  if (outcome.ok) {
    return `  ok   ${outcome.name}  ${outcome.width}x${outcome.height}  ${outcome.path}`;
  }
  const lines = [`  FAIL ${outcome.name}`];
  for (const u of outcome.unresolved) {
    lines.push(`       G-unresolved  ${u.kind} ${u.name}: ${u.reason}`);
    lines.push(`                     fix: ${u.fix}`);
  }
  for (const f of outcome.findings) {
    lines.push(`       ${f.guard}  ${f.subject}: ${f.reason}`);
    lines.push(`                     fix: ${f.fix}`);
  }
  for (const s of outcome.storeFailures) lines.push(`       store  ${s.rule}: ${s.detail}`);
  for (const e of outcome.errors) lines.push(`       error  ${e}`);
  return lines.join("\n");
}

// ── the static plan tier (no render) ─────────────────────────────────────────────────

/**
 * `shot.plan` - everything knowable WITHOUT running the app: the ladder, response-plane
 * coverage, url-template collisions, missing route params, an unknown device.
 *
 * Split from the render tier deliberately. An agent's loop is plan, read the missing names,
 * write samples, plan again - and that loop only works if the cheap half is honest about being
 * the cheap half. Row counts and settle CANNOT be predicted here; claiming otherwise would send
 * an implementer chasing a static emptiness analysis that cannot exist.
 */
export function planShot(
  config: ProjectConfig,
  shotConfig: ShotConfig,
  profile: ShotProfile,
): { scope: ShotScopeResult; device: ShotDevice | null; errors: string[] } {
  const errors: string[] = [];
  const deviceKey = profile.device ?? "iphone-6.9";
  const device = shotDevice(deviceKey);
  if (device === null) errors.push(`unknown device "${deviceKey}"`);

  const file = findDocument(config, profile.document);
  if (file === null) {
    errors.push(`no document "${profile.document}" in the project`);
    return {
      scope: { attrs: {}, vars: {}, globals: {}, apiSeeds: {}, seamPlan: [], unresolved: [] },
      device, errors,
    };
  }
  const head = compileComponent(
    profile.document, config.scheme, readFileSync(file, "utf8"),
    { target: profile.target ?? "ios" },
  ).head;

  const scope = resolveShotScope({
    head,
    hydrate: shotConfig.hydrate,
    overrides: { vars: profile.vars, globals: profile.globals },
    routeParams: profile.routeParams,
    mode: profile.mode ?? "sample",
  });
  return { scope, device, errors };
}

function findDocument(config: ProjectConfig, name: string): string | null {
  for (const root of packageRoots(config)) {
    for (const sub of ["Components", "components", "."]) {
      const candidate = join(root, sub, `${name}.dsx`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ── the render tier ──────────────────────────────────────────────────────────────────

/** The in-page harness. Bundled once and evaluated before boot, so the seam is armed and the
 *  world is pinned BEFORE the first api block can fire. */
export function harnessSource(): string {
  return String.raw`
import { bootDsx } from "@despia/dom/boot";
import { RunnerFetchSeam, DSXState } from "@despia/kernel";

type Route = { as: string; method: string; pattern: string; data: unknown };
type CassetteRow = { key: string; status: number; data: unknown };
type W = typeof globalThis & {
  __dsxShotBoot: (
    registry: unknown, entry: string,
    globals: Record<string, unknown>, vars: Record<string, unknown>, attrs: Record<string, unknown>,
    consts?: Record<string, unknown>,
  ) => void;
  __dsxShotArm: (routes: Route[], mode: string, cassette?: CassetteRow[]) => void;
  __dsxShotRecorded: Array<{ method: string; url: string; status: number; data: unknown }>;
  __dsxShotLiveFetch?: (url: string, init: unknown) => Promise<unknown>;
  __dsxShotReport: (refNames?: string[]) => unknown;
  __dsxShotMisses: string[];
  __dsxShotInFlight: number;
  __dsxShotSeen: Array<{ method: string; url: string; body: unknown }>;
};
const w = globalThis as W;
w.__dsxShotMisses = [];
w.__dsxShotInFlight = 0;
w.__dsxShotSeen = [];
w.__dsxShotRecorded = [];

w.__dsxShotArm = (routes, mode, cassette) => {
  const compiled = routes.map((r) => ({ ...r, re: new RegExp(r.pattern) }));
  // Replay matches EXACTLY (method + url + body hash), because a cassette is a recording of
  // real requests and a template would let one entry answer a request it never saw. Sample
  // matches by TEMPLATE, because there the hole's value is whatever the DAG interpolated at
  // fire time and no recording exists to be exact about.
  const replay = new Map((cassette ?? []).map((e) => [e.key, e]));
  RunnerFetchSeam.impl = async (url, init) => {
    const method = String((init as { method?: string }).method ?? "GET").toUpperCase();
    const body = (init as { body?: unknown }).body ?? null;
    w.__dsxShotSeen.push({ method, url, body });
    w.__dsxShotInFlight += 1;
    try {
      if (mode === "replay") {
        const exact = replay.get(method + " " + url);
        if (exact !== undefined) return { ok: exact.status < 400, status: exact.status, data: exact.data };
      }
      const hit = compiled.find((r) => r.method === method && r.re.test(url));
      if (hit !== undefined) return { ok: true, status: 200, data: hit.data };
      if (mode === "record" || mode === "live") {
        // The one path that really reaches out. It is gated OUTSIDE the page (egressAllowed),
        // so by the time control is here the channel has already been checked.
        const real = w.__dsxShotLiveFetch;
        if (real !== undefined) {
          const answer = await real(url, init);
          w.__dsxShotRecorded.push({
            method, url,
            status: Number((answer as { status?: number }).status ?? 0),
            data: (answer as { data?: unknown }).data ?? null,
          });
          return answer;
        }
      }
      w.__dsxShotMisses.push(method + " " + url);
      return { ok: false, status: 0, data: null, error: "shot_unarmed_request" };
    } finally {
      w.__dsxShotInFlight -= 1;
    }
  };
};

// THE SEED ORDER IS LOAD-BEARING, and both halves of it are.
//
// GLOBALS BEFORE BOOT. An on:appear action runs during boot, so a global written afterwards
// is one the lifecycle never saw. That failure renders as a screen with a blank where a name
// should be: nothing throws, no list is empty, no binding is unresolved, and NO GUARD CAN SEE
// IT - an empty interpolation is not an error. Ordering is the only fix.
//
// SCREEN VARS SYNCHRONOUSLY AFTER BOOT, IN THIS SAME TURN. A frame's store does not exist
// until its frame mounts, so a variable cannot be seeded earlier - but on:appear is dispatched
// via queueMicrotask (mount.ts), and a microtask cannot run until this synchronous function
// returns. Seeding here therefore lands BEFORE any appear handler, which is what makes a
// sampled leaf visible to the page-load action that reads it.
//
// bootDsx's own vars= is NOT this: it becomes a scope entry named vars (route/mount params),
// not the variable scope, so it seeds nothing a <variable> reads.
// CONSTS ARE A BUILD FACT, so they belong to the boot rather than to the store: a surface
// that reads the const plane (the Studio's own shell reads which app schemes compiled into
// its bundle) renders a different, emptier thing without them, and the shot would be a
// picture of that emptier thing. Optional, so every existing caller keeps its behaviour.
w.__dsxShotBoot = (registry, entry, globals, vars, attrs, consts) => {
  for (const [k, v] of Object.entries(globals)) DSXState.set(k, v);
  bootDsx({
    registry: registry as never,
    host: document.getElementById("app") as HTMLElement,
    entry,
    base: "/",
    attrs,
    ...(consts !== undefined ? { consts: consts as never } : {}),
    app: { name: "Shot", version: "0.0.0", build: "web", env: "debug" },
  });
  const door = (globalThis as { __DSX_STATE__?: { set(n: string, v: unknown): boolean } }).__DSX_STATE__;
  if (door !== undefined) {
    for (const [k, v] of Object.entries(vars)) door.set(k, v);
  }
};

w.__dsxShotReport = (refNames: string[] = []) => {
  const door = (globalThis as { __DSX_STATE__?: { snapshot: () => { vars: Array<{ name: string; value: unknown }> } } }).__DSX_STATE__;
  const snapshot = door === undefined ? { vars: [] } : door.snapshot();
  // An <api> publishes its facts on RESERVED PATHS (/web/05) - reading them is reading the
  // block's own contract, not guessing at internals.
  const apis: unknown[] = [];
  for (const row of snapshot.vars) {
    const v = row.value as Record<string, unknown> | null;
    if (v === null || typeof v !== "object") continue;
    if (!("status" in v) || !("loading" in v) || !("blockedBy" in v)) continue;
    apis.push({
      as: row.name,
      status: String(v["status"] ?? "ready"),
      loading: v["loading"] === true,
      refreshing: v["refreshing"] === true,
      blockedBy: Array.isArray(v["blockedBy"])
        ? (v["blockedBy"] as unknown[]).map((b) => (b !== null && typeof b === "object" && "name" in b ? String((b as { name: unknown }).name) : String(b)))
        : [],
      error: v["error"] ?? null,
    });
  }
  // A BOUND COLLECTION that rendered zero rows is the "No data found" screenshot. The
  // renderer stamps data-dsx-bind on every bound list/grid/pager, so this counts what
  // actually PAINTED rather than predicting what should have - the render tier's whole job.
  //
  // NAMING: allowEmpty points at an author's ref= name, so each candidate name is RESOLVED
  // through the ref registry (RefRegistry.resolve - the same public handle capture.element
  // uses; the table is deliberately not enumerable, so resolve-by-name is the only correct
  // read). A collection with no ref= is named by its bind expression, so allowEmpty always
  // has something real to point at either way.
  const registry = (globalThis as { [k: symbol]: unknown })[Symbol.for("dsx.refs.v1")] as
    { resolve(n: string): { ok: boolean; view?: unknown } } | undefined;
  const named = new Map<Element, string>();
  for (const candidate of refNames) {
    const hit = registry === undefined ? { ok: false } : registry.resolve(candidate);
    if (hit.ok && hit.view instanceof Element) named.set(hit.view, candidate);
  }
  const collections: unknown[] = [];
  for (const el of Array.from(document.querySelectorAll("[data-dsx-bind]"))) {
    const kind = el.getAttribute("data-dsx-component") ?? el.tagName.toLowerCase();
    const bind = el.getAttribute("data-dsx-bind") ?? "";
    const track = el.querySelector(".dsx-paged-track");
    const rowHost = track ?? el;
    collections.push({
      ref: named.get(el) ?? (bind.length > 0 ? bind : kind),
      tag: kind,
      rows: rowHost.childElementCount,
    });
  }
  // INK: what actually painted. A slide with neither text nor an image is a rectangle of
  // background colour, which every other guard happily passes.
  const inkText = (document.body.innerText ?? "").replace(/\s+/g, "").length;
  const images = Array.from(document.images);
  // THE SCENE LANDMARKS: a composed slide names its structural boxes with the universal id=
  // attribute (shot-screen, shot-crop, shot-veil, shot-decor-<row id>), and the report
  // measures where each actually LANDED - getBoundingClientRect of the settled frame, so a
  // transformed decoration reports its painted box. The G-cover containment law is scored
  // off these numbers; a document with no landmarks reports a null screen and opts out.
  const rectOf = (id: string) => {
    const el = document.getElementById(id);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const decorBoxes: unknown[] = [];
  for (const el of Array.from(document.querySelectorAll('[id^="shot-decor-"]'))) {
    const r = el.getBoundingClientRect();
    decorBoxes.push({
      id: el.id.slice("shot-decor-".length),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    });
  }
  return {
    apis,
    collections,
    seamMisses: w.__dsxShotMisses.slice(),
    imagesDecoded: images.every((img) => img.complete && img.naturalWidth > 0),
    ink: { text: inkText, images: images.filter((i) => i.complete && i.naturalWidth > 0).length },
    scene: {
      screen: rectOf("shot-screen"),
      card: rectOf("shot-card"),
      device: rectOf("shot-device"),
      crop: rectOf("shot-crop"),
      veil: rectOf("shot-veil"),
      decor: decorBoxes,
    },
    transportIdle: w.__dsxShotInFlight === 0,
    html: document.body.innerHTML.length,
  };
};
`;
}

/** The page the shot renders into. Kept minimal on purpose: every pixel that is not the app
 *  is a pixel the store asset should not carry. */
export const SHOT_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Shot</title>
<link rel="icon" href="data:,">
<style>html, body { margin: 0; height: 100%; }</style>
</head>
<body>
<div id="app"></div>
</body>
</html>
`;

export type RenderDeps = {
  /** the bundled harness (esbuild output) */
  bundle: string;
  /** playwright browser */
  browser: {
    newContext(options: unknown): Promise<PageContext>;
  };
};

type PageContext = {
  newPage(): Promise<ShotPage>;
  close(): Promise<void>;
  addInitScript(script: { content: string }): Promise<void>;
  clock?: { install(opts: { time: Date }): Promise<void> };
};

type ShotPage = {
  on(event: string, fn: (arg: never) => void): void;
  route(pattern: string, handler: (route: { fulfill(o: unknown): Promise<void>; abort(): Promise<void>; request(): { url(): string } }) => void): Promise<void>;
  goto(url: string, opts?: unknown): Promise<unknown>;
  addScriptTag(opts: { content: string }): Promise<unknown>;
  addStyleTag(opts: { content: string }): Promise<unknown>;
  evaluate<T>(fn: unknown, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: unknown): Promise<Buffer>;
  clock?: { install(o: unknown): Promise<void>; setFixedTime(t: Date): Promise<void> };
};

/** The project's registry, compiled FOR THE TARGET THE IMAGE DEPICTS. `buildRegistry` already
 *  emits the one compiled stylesheet, so nothing here re-collects css. */
export function buildProjectRegistry(config: ProjectConfig, target: string): {
  registry: { components: Record<string, unknown>; css: string };
} {
  const roots = packageRoots(config);
  const registry = buildRegistry(
    roots.map((dir) => (dir === config.root ? { dir, scheme: config.scheme, app: true } : { dir })),
    [],
    { routes: config.routes, notFound: config.notFound, target },
  ) as unknown as { components: Record<string, unknown>; css: string };
  return { registry };
}

/** Resolve a profile's `document` to a registry key.
 *
 *  A slide template usually lives in a PACKAGE rather than in the project: the Shots library
 *  ships `ShotPro` under its own scheme so the CLI, the Studio's board and a project all render
 *  the same component. Qualifying with the project scheme alone would make a template usable
 *  only by copying it into every project, which is the drift this library exists to prevent.
 *  The project still WINS - a project may override a template by declaring its own - and a name
 *  that matches nothing returns null so the caller can say so precisely. */
export function resolveDocument(
  registry: { components: Record<string, unknown> },
  scheme: string,
  document: string,
): string | null {
  if (document.includes(".")) {
    return registry.components[document] === undefined ? null : document;
  }
  const own = `${scheme}.${document}`;
  if (registry.components[own] !== undefined) return own;
  const suffix = `.${document}`;
  const hits = Object.keys(registry.components).filter((key) => key.endsWith(suffix));
  return hits.length === 1 ? hits[0]! : null;
}

export { LAYER_STATEMENT, loadConfig, resolve as resolvePath, dirname, mkdirSync, writeFileSync };


// ── cassette io ──────────────────────────────────────────────────────────────────────

export const CASSETTE_FILENAME = "dsx.cassette.json";

export function loadCassette(root: string): Cassette | null {
  const path = join(root, CASSETTE_FILENAME);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Cassette;
}

/**
 * Write a cassette, refusing to write one that carries credential material.
 *
 * The refusal is the point. A recorder that merely TRIED to strip headers would leak the day
 * someone added a field; auditing at the write boundary means a leak cannot reach disk, let
 * alone a commit.
 */
export function writeCassette(root: string, cassette: Cassette): void {
  const problems = auditCassette(cassette);
  if (problems.length > 0) {
    throw new Error(`refusing to write a cassette carrying credentials: ${problems.join("; ")}`);
  }
  writeFileSync(join(root, CASSETTE_FILENAME), `${JSON.stringify(cassette, null, 2)}\n`);
}

/** The names a cassette can answer, for the scope resolver's `replay` tier. */
export function cassetteNames(cassette: Cassette | null): string[] {
  if (cassette === null) return [];
  return [...new Set(cassette.entries.map((e) => e.as ?? "").filter((a) => a.length > 0))];
}
