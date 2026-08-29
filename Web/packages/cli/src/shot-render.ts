//
//  shot-render.ts - the BROWSER half of the shot driver (platform/10 §1, §2).
//
//  Node-only (playwright, esbuild, fs), kept out of shot.ts so the pure planning half stays
//  importable anywhere - the MCP face and the linter want the plan without a browser.
//
//  SETTLE IS A CONJUNCTION, NEVER A TIMEOUT. A sleep(2000) is how a screenshot farm ships
//  blank images at 3am. Every condition here is observable, each has a budget, and a budget
//  exhausted is a FAILED shot naming which condition never held - never a captured frame with
//  a caveat.
//

import { buildSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateShotGuards, settleHolds, shotPixelSize, checkStoreConstraints,
  type FrameRect, type FrameReport, type FrameSettle, type ShotDevice,
} from "@despia/kernel";
import { shotSkinCss, SHOT_SKIN_TOKENS_CSS, SHOT_REFRACTION_SVG } from "@despia/dom";
import type { ProjectConfig } from "./config.ts";
import {
  planShot, buildProjectRegistry, harnessSource, resolveDocument, SHOT_PAGE_HTML,
  type ShotConfig, type ShotProfile, type ShotOutcome, type Cassette,
} from "./shot.ts";

const SHOT_ORIGIN = "http://dsx-shot.local";

/** Per-condition settle budgets. Generous enough for a real app's page-load action chain,
 *  bounded enough that a hung shot fails in seconds rather than blocking a batch. */
export const SETTLE_BUDGET_MS = 12_000;
const SETTLE_POLL_MS = 100;
/** The rest-state rule the parity oracle already uses: three identical consecutive snapshots. */
const STABLE_SNAPSHOTS = 3;

/** The web workspace root (the directory whose node_modules resolves @despia/*), found by
 *  walking up from the calling module to the first directory that contains packages/cli.
 *  A fixed number of `..` steps is layout arithmetic: it silently means a different
 *  directory from `dist/src/` than from `src/`, and Node 22 runs both. */
export function findWebRoot(moduleUrl: string): string {
  // fileURLToPath, never URL.pathname: pathname keeps percent-encoding and the leading
  // slash before a Windows drive letter, both of which existsSync will never match
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(join(dir, "packages", "cli"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`the web workspace root was not found above ${moduleUrl}`);
    dir = parent;
  }
}

export function bundleHarness(webRoot: string): string {
  const out = buildSync({
    stdin: { contents: harnessSource(), loader: "ts", resolveDir: webRoot, sourcefile: "shot-harness.ts" },
    bundle: true, write: false, format: "iife", target: "es2022", logLevel: "silent",
  }).outputFiles[0]?.text;
  if (out === undefined) throw new Error("the shot harness did not bundle");
  return out;
}

/** Freeze every continuous surface, and NAME what will not freeze.
 *
 *  A video, a lottie or a canvas loop never reaches three identical snapshots, so without this
 *  a perfectly good screen fails settle for a reason nobody can see. Anything still moving is
 *  reported by selector rather than timing out anonymously. */
const FREEZE_SCRIPT = `
  for (const v of Array.from(document.querySelectorAll("video"))) {
    try { v.pause(); v.currentTime = 0; } catch {}
  }
  for (const a of document.getAnimations === undefined ? [] : document.getAnimations()) {
    try { a.pause(); } catch {}
  }
`;

type Browser = {
  newContext(o: unknown): Promise<{
    newPage(): Promise<Page>;
    close(): Promise<void>;
    addInitScript(s: { content: string }): Promise<void>;
    clock: { install(o: { time: Date }): Promise<void>; setFixedTime(t: Date): Promise<void> };
  }>;
};
export type ShotPage = {
  on(e: string, fn: (a: never) => void): void;
  route(p: string, h: (r: RouteHandle) => void): Promise<void>;
  goto(u: string, o?: unknown): Promise<unknown>;
  addScriptTag(o: { content: string }): Promise<unknown>;
  addStyleTag(o: { content: string }): Promise<unknown>;
  evaluate<T>(fn: unknown, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(o: unknown): Promise<Buffer>;
};
type Page = ShotPage;
type RouteHandle = {
  fulfill(o: unknown): Promise<void>;
  abort(): Promise<void>;
  fallback?(): Promise<void>;
  request(): { url(): string; method(): string };
};

export type RenderOptions = {
  webRoot: string;
  outDir: string;
  /** the project root - the ONLY directory a shot may read assets from */
  projectRoot: string;
  bundle?: string;
  /** deny-all belt: record what the PAGE (not the seam) tried to reach */
  onEgress?: (url: string) => void;
  /** replay source */
  cassette?: Cassette | null;
  /** granted OUTSIDE the page, only after egressAllowed() cleared the channel */
  allowEgress?: boolean;
  egressOrigin?: string;
  /** record sink - what the seam actually reached, for the cassette writer */
  onRecorded?: (rows: Array<{ method: string; url: string; status: number; data: unknown }>) => void;
};

/**
 * Render one profile to a PNG, or refuse with a report.
 */
export async function renderShot(
  browser: Browser,
  config: ProjectConfig,
  shotConfig: ShotConfig,
  profile: ShotProfile,
  opts: RenderOptions,
): Promise<ShotOutcome> {
  const name = profile.as ?? profile.document;
  const errors: string[] = [];
  const egress: string[] = [];

  // ── the static tier first: never boot a browser for a shot that cannot resolve ──
  const plan = planShot(config, shotConfig, profile);
  errors.push(...plan.errors);
  const device = plan.device;
  if (device === null || plan.scope.unresolved.length > 0 || errors.length > 0) {
    return {
      profile, name, ok: false, findings: [], unresolved: plan.scope.unresolved,
      storeFailures: [], errors, scope: plan.scope,
    };
  }

  const target = profile.target ?? "ios";
  const { registry } = buildProjectRegistry(config, target);
  const qualified = resolveDocument(registry, config.scheme, profile.document);
  if (qualified === null) {
    errors.push(`component ${profile.document} is not in the registry (project scheme ${config.scheme}, or a package)`);
    return { profile, name, ok: false, findings: [], unresolved: [], storeFailures: [], errors };
  }

  const bundle = opts.bundle ?? bundleHarness(opts.webRoot);
  const size = shotPixelSize(device, profile.rotate === true);

  const context = await browser.newContext({
    viewport: {
      width: profile.rotate === true ? device.height : device.width,
      height: profile.rotate === true ? device.width : device.height,
    },
    deviceScaleFactor: device.scale,
    isMobile: device.touch,
    hasTouch: device.touch,
    colorScheme: profile.scheme ?? "light",
    reducedMotion: "reduce",
    locale: profile.locale ?? "en-US",
    timezoneId: profile.timezone ?? "UTC",
  });

  // ── the determinism plane (§1a) ──
  // A pinned clock and a seeded random, installed BEFORE any page script runs, so a screen
  // that renders "2 hours ago" renders it identically in every future render.
  const at = profile.at !== undefined ? new Date(profile.at) : new Date("2026-01-01T09:41:00Z");
  await context.clock.install({ time: at });
  await context.addInitScript({
    content: `(() => {
      let seed = 0x2545f491;
      Math.random = () => {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return ((seed >>> 0) % 1e9) / 1e9;
      };
    })();`,
  });

  const page = await context.newPage();
  page.on("pageerror", (e: never) => errors.push(`pageerror: ${(e as Error).message}`));
  page.on("console", (m: never) => {
    const msg = m as unknown as { type(): string; text(): string };
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(SHOT_ORIGIN)) {
      const path = url.substring(SHOT_ORIGIN.length).split("?")[0] ?? "/";
      if (path === "/" || path === "") {
        await route.fulfill({ contentType: "text/html", body: SHOT_PAGE_HTML });
        return;
      }
      // THE APP'S OWN FILES ARE NOT EGRESS. An icon, a bundled image, a rendered screen a
      // composition template layers - these are the project's own bytes, and refusing them
      // would make every asset a blank box. What the belt exists to stop is a REMOTE fetch
      // pulling a customer's production asset into a public marketing image, which is a
      // different thing entirely. Resolution is confined to the project root, so a template
      // cannot walk out of it.
      const asset = safeProjectPath(opts.projectRoot, path);
      if (asset !== null && existsSync(asset)) {
        await route.fulfill({ contentType: contentTypeFor(asset), body: readFileSync(asset) });
        return;
      }
      egress.push(url);
      await route.abort();
      return;
    }
    // THE DENY-ALL BELT. The seam catches every <api>; this catches everything else a page
    // can reach - an <img src>, a font, a script - so a shot can never quietly pull a
    // customer's production asset into a public marketing image. Only an explicitly granted
    // non-production origin is let through, and only in record/live.
    if (opts.allowEgress === true && opts.egressOrigin !== undefined && url.startsWith(opts.egressOrigin)) {
      await route.fallback?.() ?? await route.abort();
      return;
    }
    egress.push(url);
    opts.onEgress?.(url);
    await route.abort();
  });

  await page.goto(`${SHOT_ORIGIN}/`, { waitUntil: "load" });
  await page.addScriptTag({ content: bundle });

  // Arm the response plane BEFORE boot: the first api block must find the seam already there.
  const mode = profile.mode ?? "sample";
  const replayRows = (opts.cassette?.entries ?? []).map((e) => ({
    key: `${e.method.toUpperCase()} ${e.url}`, status: e.status, data: e.data,
  }));
  await page.evaluate(
    ([routes, m, rows]: [unknown, string, unknown]) =>
      (globalThis as unknown as { __dsxShotArm: (r: unknown, m: string, c: unknown) => void })
        .__dsxShotArm(routes, m, rows),
    [plan.scope.seamPlan, mode, replayRows],
  );
  // The one place real egress is granted, and it is granted OUTSIDE the page so the decision
  // cannot be reached by anything the page runs.
  if (opts.allowEgress === true && (mode === "record" || mode === "live")) {
    await page.evaluate(() => {
      (globalThis as unknown as { __dsxShotLiveFetch?: unknown }).__dsxShotLiveFetch =
        async (url: string, init: unknown) => {
          const res = await fetch(url, init as RequestInit);
          const text = await res.text();
          let data: unknown = null;
          try { data = JSON.parse(text) as unknown; } catch { data = text; }
          return { ok: res.ok, status: res.status, data };
        };
    });
  }

  // The face FIRST, before the app sheet: a screen captured in a font-swap window ships the
  // wrong typeface, and the app screenshot inside the device frame is as much of the asset as
  // the headline over it.
  const faceCss = bundledFaceCss(opts.webRoot);
  if (faceCss.length > 0) await page.addStyleTag({ content: faceCss });

  // The app's own compiled sheet, then the shot skin over it.
  await page.addStyleTag({ content: registry.css });
  const skin = profile.skin ?? "glass";
  if (skin !== "flat") {
    await page.addStyleTag({ content: SHOT_SKIN_TOKENS_CSS });
    await page.addStyleTag({ content: shotSkinCss(skin) });
    if (skin === "refract") {
      await page.evaluate((svg: string) => {
        document.body.insertAdjacentHTML("beforeend", svg);
      }, SHOT_REFRACTION_SVG);
    }
  }

  // Boot AND seed in ONE synchronous turn (§1 steps 5-6). See the harness for why the order
  // inside it is load-bearing: globals precede bootDsx, screen vars follow it synchronously,
  // and both land before the first on:appear microtask.
  await page.evaluate(
    ([reg, entry, globals, vars, attrs]: [unknown, string, unknown, unknown, unknown]) =>
      (globalThis as unknown as {
        __dsxShotBoot: (r: unknown, e: string, g: unknown, v: unknown, a: unknown) => void;
      }).__dsxShotBoot(reg, entry, globals, vars, attrs),
    [registry, qualified, plan.scope.globals, plan.scope.vars,
      { ...plan.scope.attrs, ...(profile.routeParams ?? {}) }],
  );

  // ── settle (§2) ──
  const settle = await waitForSettle(page);
  // The allowEmpty names are the candidates the report resolves through the ref registry -
  // it cannot enumerate the table, so it has to be told which names to look for.
  // Array.isArray, not a truthiness split: dsx.shots.json is unvalidated author input, and
  // `"allowEmpty": false` (a natural spelling of "no empties") must mean the default, never
  // a `[...false]` TypeError that kills the whole batch mid-render.
  const refNames = Array.isArray(profile.allowEmpty) ? [...profile.allowEmpty] : [];
  const collected = await page.evaluate(
    (names: string[]) =>
      (globalThis as unknown as { __dsxShotReport: (n: string[]) => unknown }).__dsxShotReport(names),
    refNames,
  );
  const report: FrameReport = {
    ...(collected as Omit<FrameReport, "settle">),
    settle,
  };

  // Pair the MEASURED decoration boxes with what their data rows DECLARED. The declaration
  // (`over: "screen"`, the licence to cover readable app UI) lives on the profile's decor
  // rows - the same rows an agent writes - keyed by the row `id` the rendered box carries in
  // its landmark. A measured box with no declaring row stays undeclared, which is the strict
  // reading: markup-authored decor that covers the screen must move its rows into the
  // profile to say so.
  if (report.scene !== undefined) {
    const declared = new Map<string, { over?: string; kind?: string; bleed?: boolean }>();
    const rows = (profile.vars ?? {})["decor"];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row === null || typeof row !== "object") continue;
        const r = row as { id?: unknown; over?: unknown; kind?: unknown; bleed?: unknown };
        if (r.id === undefined) continue;
        declared.set(String(r.id), {
          over: typeof r.over === "string" ? r.over : undefined,
          kind: typeof r.kind === "string" ? r.kind : undefined,
          bleed: r.bleed === true ? true : undefined,
        });
      }
    }
    const raw = report.scene.decor as unknown as Array<{ id: string; rect: FrameRect }>;
    report.scene = {
      ...report.scene,
      decor: raw.map((d) => {
        const row = declared.get(d.id);
        return { label: `${row?.kind ?? "decor"}:${d.id}`, rect: d.rect, over: row?.over, bleed: row?.bleed };
      }),
    };
  }

  if (opts.onRecorded !== undefined) {
    type Recorded = Array<{ method: string; url: string; status: number; data: unknown }>;
    const rows = await page.evaluate<Recorded>(() =>
      (globalThis as unknown as { __dsxShotRecorded: Recorded }).__dsxShotRecorded);
    opts.onRecorded(rows);
  }

  // A measurement hook for authoring templates: DSX_SHOT_PROBE=1 prints the settled box of
  // every element carrying a class, so a layout question is answered with numbers instead of
  // by squinting at a 1320px-wide PNG.
  if (process.env["DSX_SHOT_PROBE"] === "1") {
    const boxes = await page.evaluate<Array<{ id: string; box: number[] }>>(() =>
      Array.from(document.querySelectorAll("[class]")).slice(0, 40).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").split(/\s+/)[0]}`,
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        };
      }));
    for (const b of boxes) console.log(`    probe ${b.id} x=${b.box[0]} y=${b.box[1]} w=${b.box[2]} h=${b.box[3]}`);
    const imgs = await page.evaluate<Array<{ src: string; ok: boolean; w: number }>>(() =>
      Array.from(document.images).map((i) => ({ src: i.getAttribute("src") ?? "", ok: i.complete, w: i.naturalWidth })));
    for (const i of imgs) console.log(`    probe img src=${JSON.stringify(i.src)} complete=${i.ok} natural=${i.w}`);
    if (process.env["DSX_SHOT_PROBE_DECOR"] === "1") {
      const rows = await page.evaluate<Array<Record<string, string>>>(() =>
        Array.from(document.querySelectorAll(".dsx-list > *")).map((el) => {
          const cs = getComputedStyle(el as HTMLElement);
          const r = el.getBoundingClientRect();
          const parent = (el as HTMLElement).offsetParent;
          return {
            tag: el.tagName.toLowerCase(), position: cs.position, top: cs.top, left: cs.left,
            box: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
            offsetParent: parent === null ? "null" : `${parent.tagName.toLowerCase()}.${(parent.getAttribute("class") ?? "").split(/\s+/)[0]} ${parent.clientHeight}h`,
          };
        }));
      for (const r of rows) console.log(`    decor ${JSON.stringify(r)}`);
    }
  }

  const findings = evaluateShotGuards(report, { allowEmpty: profile.allowEmpty });
  if (findings.length > 0 || errors.length > 0) {
    await context.close();
    return {
      profile, name, ok: false, findings, unresolved: [], storeFailures: [],
      errors: errors.concat(egress.length > 0 ? [`blocked egress: ${egress.slice(0, 3).join(", ")}`] : []),
      scope: plan.scope,
    };
  }

  // ── capture ──
  // `omitBackground: false` keeps the page's own opaque ground, which is what makes the PNG
  // alpha-free without a second pass; both stores refuse an alpha channel.
  const png = await page.screenshot({ animations: "disabled", caret: "hide", type: "png", scale: "device" });
  await context.close();

  const raster = pngSize(png);
  const storeFailures = device.store !== undefined
    ? checkStoreConstraints({ ...raster, hasAlpha: pngHasAlpha(png) }, device.store)
    : [];
  if (raster.width !== size.width || raster.height !== size.height) {
    storeFailures.push({
      rule: "exact-size",
      detail: `rendered ${raster.width}x${raster.height}, the ${device.label} asset is ${size.width}x${size.height}`,
    });
  }
  if (storeFailures.length > 0) {
    return { profile, name, ok: false, findings, unresolved: [], storeFailures, errors, scope: plan.scope };
  }

  const outPath = join(opts.outDir, `${name}.png`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  return {
    profile, name, ok: true, path: outPath, width: raster.width, height: raster.height,
    findings: [], unresolved: [], storeFailures: [], errors: [], scope: plan.scope,
  };
}

/** Poll the conjunction until every condition holds, or the budget runs out. */
export async function waitForSettle(page: Page): Promise<FrameSettle> {
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  let stable = 0;
  let lastHtml = -1;
  let settle: FrameSettle = {
    fontsReady: false, imagesDecoded: false, domStable: false,
    actionsIdle: false, transportIdle: false, restless: [],
  };
  while (Date.now() < deadline) {
    await page.evaluate(FREEZE_SCRIPT);
    type SettleProbe = {
      fontsReady: boolean; imagesDecoded: boolean; transportIdle: boolean;
      html: number; restless: string[];
    };
    const probe = await page.evaluate<SettleProbe>(async () => {
      await document.fonts.ready;
      const w = globalThis as unknown as {
        __dsxShotReport: (n: string[]) => { imagesDecoded: boolean; transportIdle: boolean; html: number };
      };
      const r = w.__dsxShotReport([]);
      const running = document.getAnimations === undefined
        ? []
        : document.getAnimations().filter((a) => a.playState === "running");
      return {
        fontsReady: document.fonts.status === "loaded",
        imagesDecoded: r.imagesDecoded,
        transportIdle: r.transportIdle,
        html: r.html,
        restless: running.map((a) => {
          const target = (a as unknown as { effect?: { target?: Element } }).effect?.target;
          return target === undefined || target === null
            ? "animation"
            : `${target.tagName.toLowerCase()}.${(target.getAttribute("class") ?? "").split(/\s+/)[0] ?? ""}`;
        }),
      };
    });
    stable = probe.html === lastHtml ? stable + 1 : 0;
    lastHtml = probe.html;
    // The action queue has no public counter, so its proxy is the honest one: a DOM that has
    // stopped changing while the transport is idle means nothing is still writing state.
    const actionsIdle = stable >= STABLE_SNAPSHOTS && probe.transportIdle;
    settle = {
      fontsReady: probe.fontsReady,
      imagesDecoded: probe.imagesDecoded,
      domStable: stable >= STABLE_SNAPSHOTS,
      actionsIdle,
      transportIdle: probe.transportIdle,
      restless: [...new Set(probe.restless)],
    };
    if (settleHolds(settle)) return settle;
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  return settle;
}

// ── PNG facts, read straight from the header ─────────────────────────────────────────


/**
 * The bundled face, inlined.
 *
 * WITHOUT THIS EVERY SHOT IS A LIE ABOUT TYPOGRAPHY. `--dsx-font` names InterVariable first
 * and then falls through the system stack, so a renderer that never links the face resolves
 * `system-ui` to whatever fontconfig answers - measured on this host: DejaVu Sans. DejaVu
 * carries 400 and 700 only, so a ramp naming 450 and 800 renders as two weights instead of
 * four, and the app screenshot inside the frame is in the wrong face too. Both were true of
 * every image this pipeline produced before this function existed.
 *
 * Inlined as data: URIs rather than served, because the shot page has no stable base URL and
 * the deny-all belt would otherwise have to grow an exception per asset. 108KB of woff2 for a
 * render that is already spending a browser is not a cost worth engineering around.
 *
 * Licence: OFL-1.1 (OpenSource/Type/vendor/inter/LICENSE.txt), which travels with the bytes.
 */
export function bundledFaceCss(webRoot: string): string {
  const dir = resolve(webRoot, "../Type/vendor/inter");
  const face = (file: string, range: string): string => {
    const path = join(dir, file);
    if (!existsSync(path)) return "";
    const b64 = readFileSync(path).toString("base64");
    return `@font-face{font-family:"InterVariable";`
      + `src:url(data:font/woff2;base64,${b64}) format("woff2");`
      + `font-weight:100 900;font-style:normal;font-display:block;unicode-range:${range};}`;
  };
  // font-display: BLOCK, not swap. A shot waits for settle anyway, and `swap` means a capture
  // taken in the swap window silently ships the fallback face - the exact failure the settle
  // conjunction's fonts.ready condition exists to prevent, made impossible here instead.
  return face("InterVariable-latin.woff2", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD")
    + face("InterVariable-latin-ext.woff2", "U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+2113,U+2C60-2C7F,U+A720-A7FF");
}

export function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Colour type 4 (grey+alpha) and 6 (RGBA) carry an alpha channel; both stores refuse one. */
export function pngHasAlpha(buf: Buffer): boolean {
  const colorType = buf[25];
  return colorType === 4 || colorType === 6;
}

export { resolve as resolveShotPath };


/** Resolve a page-requested path inside the project, or null if it escapes.
 *
 *  Confinement is the whole contract: a template is authored content, and authored content
 *  must not be able to read the filesystem by asking for ../../etc/passwd. Both candidate
 *  roots are the project's own, and the resolved path has to stay under one of them. */
export function safeProjectPath(projectRoot: string, requestPath: string): string | null {
  const decoded = (() => {
    try { return decodeURIComponent(requestPath); } catch { return requestPath; }
  })();
  // Both roots are the project's own. `shots/` is tried first so a template can name a
  // rendered screen by bare filename, then the project root for everything else it ships.
  //
  // EXISTENCE is part of the resolution, not an afterthought: returning the first CONFINED
  // path rather than the first that EXISTS let `shots/` shadow every root-level asset, so a
  // frame PNG at the project root resolved to a shots/ path that was never there and the
  // image silently failed to load.
  const roots = [join(projectRoot, "shots"), projectRoot];
  let firstConfined: string | null = null;
  for (const root of roots) {
    const candidate = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
    const base = resolve(root);
    if (candidate !== base && !candidate.startsWith(`${base}/`)) continue;
    if (existsSync(candidate)) return candidate;
    firstConfined ??= candidate;
  }
  return firstConfined;
}

const CONTENT_TYPES: { [ext: string]: string } = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  svg: "image/svg+xml", gif: "image/gif", avif: "image/avif",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
  css: "text/css", js: "text/javascript", json: "application/json",
};

export function contentTypeFor(path: string): string {
  const ext = path.substring(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
