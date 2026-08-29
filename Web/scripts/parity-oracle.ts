//
//  parity-oracle.ts - the WEB REFERENCE PLANE of the parity contract
//  (OpenSource/Conformance/parity/README.md; design-system.md "The parity contract",
//  stage 1). Each fixture in OpenSource/Conformance/parity/fixtures/*.dsx boots
//  through the REAL app path (compileComponent -> bootDsx -> the full element set and
//  the full weak-layer CSS stack) in the locked Playwright engine, and its settled
//  render is measured AT BOTH LOCKED VIEWPORTS - the phone plane (390x844@2x,
//  touch) and the desktop plane (1366x1024@2x, fine pointer + hover, so the
//  wide-chrome and desktop-density media steps engage): per-node layout boxes,
//  resolved colors (light AND dark), radii, type metrics, and the resolved
//  --dsx-* token tables, plus a light and a dark reference screenshot per width.
//  Reference files are keyed by width: <fixture>.w390.json / .w390.light.png /
//  .w1366.dark.png and so on.
//
//    node scripts/parity-oracle.ts record   -> (re)write the committed reference
//                                             plane under Conformance/parity/reference/web/
//    node scripts/parity-oracle.ts          -> VERIFY: re-render and compare against
//                                             the stored plane within budget
//
//  The verify budget is the stage-1 contract: colors, tokens, radii, font size and
//  weight EXACT; layout boxes within DSX_PARITY_BOX_TOLERANCE (default 1 CSS px);
//  line-height within 0.5px; screenshots byte-equal or within
//  DSX_PARITY_PIXEL_BUDGET (default 2% of pixels differing by more than 6/255 per
//  channel). Both modes also enforce the scheme law in-harness: dark may move
//  COLORS only - its layout boxes must match light's within 0.5px.
//
//  References are captured under prefers-reduced-motion (the skin's own collapse)
//  with animations disabled at the screenshot, so the plane pins REST geometry -
//  motion parity is the motion corpus's dimension, not this one.
//

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { inflateSync } from "node:zlib";

import { buildSync } from "esbuild";

import { compileComponent } from "@despia-native/compiler/component";
import { CssCollector, extractComponentCss, LAYER_STATEMENT } from "@despia-native/compiler";
import { TOKENS_CSS } from "@despia-native/dom/theme";
import { DEV_FONT_FILES, interFontFaceCss } from "../packages/cli/src/dev.ts";
import { browserEngine, launchBrowser } from "../packages/dom/oracle/browser-engine.ts";

type Box = [number, number, number, number];
type NodeMetrics = {
  path: string;
  id: string;
  box: Box;
  radius: string;
  light: { color: string; background: string };
  dark: { color: string; background: string };
  text: { size: string; weight: string; line: string } | null;
};
type Typeface = { family: string; postScriptName: string } | null;
type FixtureMetrics = {
  _note: string;
  fixture: string;
  component: string;
  engine: string;
  /** The face the host actually resolved --dsx-font to. See THE INTENDED FACE below. */
  typeface?: Typeface;
  /** process.platform of the recorder. Boxes and colors are face-pinned and portable;
   *  the raster (screenshot) axis is not - FreeType and CoreText antialias the same
   *  glyphs differently - so the pixel diff runs only on the recording platform. */
  platform?: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  tokens: { light: Record<string, string>; dark: Record<string, string> };
  nodes: NodeMetrics[];
};
type SchemePass = {
  nodes: Array<{
    path: string;
    id: string;
    box: Box;
    radius: string;
    color: string;
    background: string;
    text: { size: string; weight: string; line: string } | null;
  }>;
  tokens: Record<string, string>;
};

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const root = repoRoot();
const webRoot = join(root, "OpenSource/Web");
const fixturesDir = join(root, "OpenSource/Conformance/parity/fixtures");
const referenceDir = join(root, "OpenSource/Conformance/parity/reference/web");

const mode = process.argv[2] === "record" ? "record" : "verify";
const BOX_TOLERANCE = Number(process.env["DSX_PARITY_BOX_TOLERANCE"] ?? "1");
const LINE_TOLERANCE = 0.5;
const SCHEME_BOX_TOLERANCE = 0.5;
const PIXEL_BUDGET = Number(process.env["DSX_PARITY_PIXEL_BUDGET"] ?? "0.02");
// DSX_PARITY_FACE=any: this host is KNOWN not to share the plane's typeface, so verify the
// host-independent axes (colours, radii, tokens, declared type, node identity) and report the
// geometry as unverified instead of failing. Only a lane that cannot match the face sets it, and
// it names itself in the summary - the default is fail-closed, so a developer running the oracle
// locally still learns that their host cannot check the plane.
const FACE_MAY_DIFFER = (process.env["DSX_PARITY_FACE"] ?? "").trim().toLowerCase() === "any";
const PIXEL_CHANNEL_DELTA = 6;
const SCALE = 2;
/** The locked measurement planes. `touch` decides the input-modality emulation, so
 *  the phone plane keeps the touch media results (coarse pointer, no hover) and the
 *  desktop plane engages the fine-pointer/hover steps (wide chrome, desktop density). */
type ViewportPlane = { key: string; width: number; height: number; touch: boolean };
const VIEWPORTS: readonly ViewportPlane[] = [
  { key: "w390", width: 390, height: 844, touch: true },
  { key: "w1366", width: 1366, height: 1024, touch: false },
];

const componentName = (file: string): string =>
  basename(file, ".dsx").split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0)
    .map((p) => p[0]!.toUpperCase() + p.substring(1)).join("");

const tokenNames = [...new Set(TOKENS_CSS.match(/--dsx-[a-z0-9-]+/g) ?? [])].sort();
if (tokenNames.length === 0) throw new Error("no --dsx-* tokens found in TOKENS_CSS");

const fixtureFiles = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((f) => f.endsWith(".dsx")).sort()
  : [];
if (fixtureFiles.length === 0) throw new Error(`no fixtures in ${fixturesDir}`);

// One bundle for every fixture: the boot + measure harness over the BUILT packages
// (the same dist a shipped application resolves).
const harnessSource = String.raw`
  import { bootDsx } from "@despia-native/dom/boot";
  (window as unknown as { __dsxParityBoot: (registry: unknown, entry: string) => void }).__dsxParityBoot =
    (registry, entry) => {
      bootDsx({
        registry: registry as never,
        host: document.getElementById("app") as HTMLElement,
        entry,
        base: "/",
        app: { name: "Parity", version: "0.0.0", build: "web", env: "debug" },
      });
    };
  (window as unknown as { __dsxParityMeasure: (tokens: string[]) => unknown }).__dsxParityMeasure =
    (tokens) => {
      const round = (v: number): number => Math.round(v * 100) / 100;
      const nodes: unknown[] = [];
      const walk = (el: Element, path: string): void => {
        const tag = el.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "link") return;
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? "";
        const hasText = [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
        );
        nodes.push({
          path,
          id: cls.length > 0 ? tag + "." + cls : tag,
          box: [round(rect.x), round(rect.y), round(rect.width), round(rect.height)],
          radius: cs.borderTopLeftRadius,
          color: cs.color,
          background: cs.backgroundColor,
          text: hasText
            ? { size: cs.fontSize, weight: cs.fontWeight, line: cs.lineHeight }
            : null,
        });
        let index = 0;
        for (const child of el.children) { walk(child, path === "" ? String(index) : path + "." + index); index += 1; }
      };
      let index = 0;
      for (const child of document.body.children) { walk(child, String(index)); index += 1; }
      const tokenTable: Record<string, string> = {};
      const rootStyle = getComputedStyle(document.documentElement);
      for (const name of tokens) tokenTable[name] = rootStyle.getPropertyValue(name).trim();
      return { nodes, tokens: tokenTable };
    };
`;

const bundle = buildSync({
  stdin: { contents: harnessSource, loader: "ts", resolveDir: webRoot, sourcefile: "parity-harness-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (bundle === undefined) throw new Error("parity harness did not bundle");

// THE INTENDED FACE, loaded rather than hoped for. --dsx-font names InterVariable first
// and the repo vendors exactly those subsets in the Type satellite (OFL-1.1, pinned),
// but a page that never declares the @font-face falls through to the HOST's system-ui -
// which is what kept this plane host-bound and mac-recorded. The harness page loads the
// satellite's woff2 as data: URIs (the same declarations `despia dev` injects), so every
// host shapes text with the SAME glyph advances and the plane is portable; the face
// guard below still records what actually resolved and fails a host where the load
// broke. A checkout without the satellite degrades to the host face, and says so.
const interDir = join(root, "OpenSource/Type/vendor/inter");
const INTENDED_FACE_STYLE = DEV_FONT_FILES.every((f) => existsSync(join(interDir, f)))
  ? `<style>${interFontFaceCss((f) => `data:font/woff2;base64,${readFileSync(join(interDir, f)).toString("base64")}`)}</style>`
  : "";

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Parity</title>
<link rel="icon" href="data:,">
${INTENDED_FACE_STYLE}<style>html, body { margin: 0; height: 100%; }</style>
</head>
<body>
<div id="app"></div>
</body>
</html>
`;

// ── PNG decode (for the budgeted screenshot diff; RGB/RGBA, 8-bit, non-interlaced) ──

type Png = { width: number; height: number; pixels: Uint8Array };

function decodePng(buffer: Buffer): Png {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buffer.length < 8 || signature.some((b, i) => buffer[i] !== b)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, color type ${colorType}, interlace ${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + 1 + x]!;
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      let reconstructed: number;
      if (filter === 0) reconstructed = value;
      else if (filter === 1) reconstructed = value + left;
      else if (filter === 2) reconstructed = value + up;
      else if (filter === 3) reconstructed = value + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        reconstructed = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else throw new Error(`unsupported PNG filter ${filter}`);
      current[x] = reconstructed & 0xff;
    }
    for (let px = 0; px < width; px += 1) {
      const src = px * channels;
      const dst = (y * width + px) * 4;
      pixels[dst] = current[src]!;
      pixels[dst + 1] = current[src + 1]!;
      pixels[dst + 2] = current[src + 2]!;
      pixels[dst + 3] = channels === 4 ? current[src + 3]! : 255;
    }
    previous.set(current);
  }
  return { width, height, pixels };
}

function screenshotDiff(stored: Buffer, fresh: Buffer): { verdict: string; ok: boolean } {
  if (stored.equals(fresh)) return { verdict: "byte-identical", ok: true };
  const a = decodePng(stored);
  const b = decodePng(fresh);
  if (a.width !== b.width || a.height !== b.height) {
    return { verdict: `dimensions ${a.width}x${a.height} -> ${b.width}x${b.height}`, ok: false };
  }
  let differing = 0;
  const total = a.width * a.height;
  for (let i = 0; i < total * 4; i += 4) {
    const dr = Math.abs(a.pixels[i]! - b.pixels[i]!);
    const dg = Math.abs(a.pixels[i + 1]! - b.pixels[i + 1]!);
    const db = Math.abs(a.pixels[i + 2]! - b.pixels[i + 2]!);
    if (Math.max(dr, dg, db) > PIXEL_CHANNEL_DELTA) differing += 1;
  }
  const fraction = differing / total;
  return {
    verdict: `${(fraction * 100).toFixed(3)}% pixels differ (budget ${(PIXEL_BUDGET * 100).toFixed(1)}%)`,
    ok: fraction <= PIXEL_BUDGET,
  };
}

// ── the render pass ─────────────────────────────────────────────────────────────────

const engine = browserEngine();
const browser = await launchBrowser(engine);
const failures: string[] = [];

async function renderScheme(
  registry: unknown,
  qualified: string,
  owner: string,
  scheme: "light" | "dark",
  plane: ViewportPlane,
): Promise<{ metrics: SchemePass; shot: Buffer; errors: string[]; typeface: Typeface }> {
  const errors: string[] = [];
  const context = await browser.newContext({
    viewport: { width: plane.width, height: plane.height },
    deviceScaleFactor: SCALE,
    isMobile: plane.touch,
    hasTouch: plane.touch,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  await page.route("http://parity.local/**", (route) => {
    void route.fulfill({ contentType: "text/html", body: PAGE_HTML });
  });
  await page.goto("http://parity.local/", { waitUntil: "load" });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(([reg, entry]) => {
    (window as unknown as { __dsxParityBoot: (registry: unknown, entry: unknown) => void })
      .__dsxParityBoot(reg, entry);
  }, [registry, qualified]);
  await page.waitForSelector(`[data-dsx-owner="${owner}"]`, { timeout: 8000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
  await page.waitForTimeout(150);
  const metrics = await page.evaluate(
    (tokens) => (window as unknown as { __dsxParityMeasure: (tokens: string[]) => unknown }).__dsxParityMeasure(tokens),
    tokenNames,
  ) as SchemePass;
  const shot = await page.screenshot({ animations: "disabled", caret: "hide" });
  const typeface = await resolvedTypeface(page);
  await context.close();
  return { metrics, shot, errors, typeface };
}

// THE FACE GUARD. Historically `--dsx-font` resolved to the HOST's system-ui (macOS .SF NS,
// Linux whatever fontconfig answers), every glyph advance differed, and the plane was
// host-bound - measured 2026-08-22, a plane recorded on one host reported 575 problems on
// the other, 571 of them that single fact. The harness now loads the skin's DECLARED face
// (InterVariable, see THE INTENDED FACE above), so the face should resolve identically on
// every host; this query records what ACTUALLY rendered, and a mismatch (satellite missing,
// data: URI failed to decode) still holds the geometry axes back and fails a strict verify
// rather than measuring a lie. Chromium only: the platform-font query is a CDP call, and
// the other engines record null and skip the check rather than pretend.
async function resolvedTypeface(page: import("playwright-core").Page): Promise<Typeface> {
  if (browserEngine() !== "chromium") return null;
  try {
    const client = await page.context().newCDPSession(page);
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument", { depth: -1 }) as { root: { nodeId: number } };
    const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".dsx-text" }) as { nodeId: number };
    if (!nodeId) return null;
    const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId }) as {
      fonts: Array<{ familyName: string; postScriptName: string; glyphCount: number }>;
    };
    const primary = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
    return primary ? { family: primary.familyName, postScriptName: primary.postScriptName } : null;
  } catch {
    return null;
  }
}

function combinePasses(
  label: string,
  fixture: string,
  component: string,
  plane: ViewportPlane,
  light: SchemePass,
  dark: SchemePass,
): FixtureMetrics | null {
  if (light.nodes.length !== dark.nodes.length) {
    failures.push(`${label}: scheme law broken - light renders ${light.nodes.length} nodes, dark ${dark.nodes.length}`);
    return null;
  }
  const nodes: NodeMetrics[] = [];
  for (let i = 0; i < light.nodes.length; i += 1) {
    const l = light.nodes[i]!;
    const d = dark.nodes[i]!;
    if (l.path !== d.path || l.id !== d.id) {
      failures.push(`${label}: scheme law broken at index ${i} - light ${l.path} ${l.id}, dark ${d.path} ${d.id}`);
      return null;
    }
    const drift = l.box.map((v, axis) => Math.abs(v - d.box[axis]!));
    if (drift.some((v) => v > SCHEME_BOX_TOLERANCE)) {
      failures.push(`${label} [${l.path} ${l.id}]: scheme law broken - dark moved the box ` +
        `[${l.box.join(", ")}] -> [${d.box.join(", ")}] (color may change, geometry may not)`);
      return null;
    }
    nodes.push({
      path: l.path,
      id: l.id,
      box: l.box,
      radius: l.radius,
      light: { color: l.color, background: l.background },
      dark: { color: d.color, background: d.background },
      text: l.text,
    });
  }
  return {
    _note: "GENERATED by OpenSource/Web/scripts/parity-oracle.ts record - the web reference plane " +
      "of the parity contract (Conformance/parity/README.md). Boxes are CSS px in viewport " +
      `coordinates at ${plane.width}x${plane.height}@${SCALE}x (${plane.touch ? "touch" : "fine pointer + hover"}), ` +
      "reduced motion; light/dark carry resolved colors per scheme.",
    fixture,
    component,
    engine,
    viewport: { width: plane.width, height: plane.height, deviceScaleFactor: SCALE },
    tokens: { light: light.tokens, dark: dark.tokens },
    nodes,
  };
}

function verifyFixture(
  fixture: string,
  stored: FixtureMetrics,
  fresh: FixtureMetrics,
  sameFace = true,
): string[] {
  const problems: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    for (const name of tokenNames) {
      const want = stored.tokens[scheme][name];
      const got = fresh.tokens[scheme][name];
      if (want !== got) problems.push(`token ${name} (${scheme}): want "${want}", got "${got}"`);
    }
  }
  const freshByPath = new Map(fresh.nodes.map((n) => [n.path, n]));
  const storedByPath = new Map(stored.nodes.map((n) => [n.path, n]));
  for (const node of fresh.nodes) {
    if (!storedByPath.has(node.path)) problems.push(`[${node.path} ${node.id}]: node not in the reference (structure changed - re-record)`);
  }
  for (const want of stored.nodes) {
    const got = freshByPath.get(want.path);
    if (got === undefined) { problems.push(`[${want.path} ${want.id}]: node missing from the render`); continue; }
    if (want.id !== got.id) problems.push(`[${want.path}]: identity "${want.id}" -> "${got.id}"`);
    if (sameFace) {
      const delta = want.box.map((v, axis) => Math.abs(v - got.box[axis]!));
      if (delta.some((v) => v > BOX_TOLERANCE)) {
        problems.push(`[${want.path} ${want.id}]: box want [${want.box.join(", ")}] got [${got.box.join(", ")}] (tolerance ${BOX_TOLERANCE}px)`);
      }
    }
    if (want.radius !== got.radius) problems.push(`[${want.path} ${want.id}]: radius "${want.radius}" -> "${got.radius}"`);
    for (const scheme of ["light", "dark"] as const) {
      if (want[scheme].color !== got[scheme].color) problems.push(`[${want.path} ${want.id}]: ${scheme} color "${want[scheme].color}" -> "${got[scheme].color}"`);
      if (want[scheme].background !== got[scheme].background) problems.push(`[${want.path} ${want.id}]: ${scheme} background "${want[scheme].background}" -> "${got[scheme].background}"`);
    }
    if ((want.text === null) !== (got.text === null)) {
      problems.push(`[${want.path} ${want.id}]: text presence changed`);
    } else if (want.text !== null && got.text !== null) {
      if (want.text.size !== got.text.size) problems.push(`[${want.path} ${want.id}]: font-size "${want.text.size}" -> "${got.text.size}"`);
      if (want.text.weight !== got.text.weight) problems.push(`[${want.path} ${want.id}]: font-weight "${want.text.weight}" -> "${got.text.weight}"`);
      const wantLine = Number.parseFloat(want.text.line);
      const gotLine = Number.parseFloat(got.text.line);
      const lineAgrees = Number.isFinite(wantLine) && Number.isFinite(gotLine)
        ? Math.abs(wantLine - gotLine) <= LINE_TOLERANCE
        : want.text.line === got.text.line;
      // size and weight are DECLARED and stay enforced across hosts; line-height resolves
      // through the face's own metrics when it is unitless, so it rides the typeface clause.
      if (sameFace && !lineAgrees) problems.push(`[${want.path} ${want.id}]: line-height "${want.text.line}" -> "${got.text.line}"`);
    }
  }
  return problems.map((p) => `${fixture}: ${p}`);
}

const faceNotes: string[] = [];
const rasterNotes: string[] = [];
try {
  if (mode === "record") mkdirSync(referenceDir, { recursive: true });
  for (const file of fixtureFiles) {
    const fixture = basename(file, ".dsx");
    const name = componentName(file);
    const qualified = `parity.${name}`;
    const source = readFileSync(join(fixturesDir, file), "utf-8");
    // The REAL compile path: static style="" folds into collector-emitted classes
    // exactly as buildRegistry does for an application - the runtime only ever sees
    // what a shipped app would see.
    const ir = compileComponent(name, "parity", source);
    const collector = new CssCollector();
    extractComponentCss(ir, collector);
    const css = [LAYER_STATEMENT, collector.emit()].filter((s) => s.length > 0).join("\n\n");
    const registry = { components: { [qualified]: ir }, globalPool: {}, css, schemes: [] };

    for (const plane of VIEWPORTS) {
      const label = `${fixture}@${plane.key}`;
      const light = await renderScheme(registry, qualified, name, "light", plane);
      const dark = await renderScheme(registry, qualified, name, "dark", plane);
      for (const e of [...light.errors, ...dark.errors]) failures.push(`${label}: ${e}`);
      if (light.errors.length > 0 || dark.errors.length > 0) { console.log(`✗ [${engine}] ${label} - page errors`); continue; }

      const combined = combinePasses(label, fixture, qualified, plane, light.metrics, dark.metrics);
      if (combined === null) { console.log(`✗ [${engine}] ${label} - scheme law`); continue; }
      combined.typeface = light.typeface;
      combined.platform = process.platform;

      if (mode === "record") {
        writeFileSync(join(referenceDir, `${fixture}.${plane.key}.json`), JSON.stringify(combined, null, 1) + "\n");
        writeFileSync(join(referenceDir, `${fixture}.${plane.key}.light.png`), light.shot);
        writeFileSync(join(referenceDir, `${fixture}.${plane.key}.dark.png`), dark.shot);
        console.log(`✓ [${engine}] ${label} - recorded ${combined.nodes.length} nodes, ${tokenNames.length} tokens x2 schemes, 2 screenshots`);
      } else {
        const referenceFile = join(referenceDir, `${fixture}.${plane.key}.json`);
        if (!existsSync(referenceFile)) { failures.push(`${label}: no stored reference - run record first`); console.log(`✗ [${engine}] ${label} - unrecorded`); continue; }
        const stored = JSON.parse(readFileSync(referenceFile, "utf-8")) as FixtureMetrics;
        // The face guard: a face mismatch makes every geometry axis meaningless, so say THAT
        // once and hold the host-independent axes (colors, radii, tokens, declared type) to the
        // plane anyway - those are the ones that still mean something across hosts.
        const sameFace = stored.typeface == null || combined.typeface == null
          || stored.typeface.family === combined.typeface.family;
        // The raster clause: with the face pinned, boxes and line-heights travel across
        // platforms (same woff2, same advances) but ANTIALIASING does not - FreeType and
        // CoreText paint different edge pixels - so the screenshot diff runs only on the
        // platform that recorded the plane, and says so instead of failing.
        const samePlatform = stored.platform == null || stored.platform === process.platform;
        const problems = verifyFixture(label, stored, combined, sameFace);
        if (!sameFace) {
          const note = `${label}: the host resolved --dsx-font to "${combined.typeface?.family}" but the `
            + `plane was recorded against "${stored.typeface?.family}" - geometry is not verified here.`;
          if (FACE_MAY_DIFFER) faceNotes.push(note);
          else problems.push(`${note} Re-record on this host, verify on a matching one, or set DSX_PARITY_FACE=any.`);
        }
        if (sameFace && !samePlatform) {
          rasterNotes.push(`${label}: screenshots were recorded on "${stored.platform}" and this host is `
            + `"${process.platform}" - the pixel diff is rasterizer-bound and was not verified here.`);
        }
        for (const scheme of ["light", "dark"] as const) {
          if (!sameFace || !samePlatform) continue;
          const shotFile = join(referenceDir, `${fixture}.${plane.key}.${scheme}.png`);
          if (!existsSync(shotFile)) { problems.push(`${label}: missing reference screenshot ${fixture}.${plane.key}.${scheme}.png`); continue; }
          const diff = screenshotDiff(readFileSync(shotFile), scheme === "light" ? light.shot : dark.shot);
          if (!diff.ok) problems.push(`${label}: ${scheme} screenshot diverged - ${diff.verdict}`);
        }
        failures.push(...problems);
        console.log(`${problems.length === 0 ? "✓" : "✗"} [${engine}] ${label} - ${combined.nodes.length} nodes vs the reference${problems.length > 0 ? ` (${problems.length} problem(s))` : ""}`);
      }
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} parity problem(s):`);
  for (const f of failures.slice(0, 60)) console.error("  " + f);
  if (failures.length > 60) console.error(`  ... and ${failures.length - 60} more`);
  process.exit(1);
}
if (faceNotes.length > 0) {
  console.log(`\n! ${faceNotes.length} fixture-width(s) could not have their GEOMETRY verified on this host:`);
  for (const n of faceNotes.slice(0, 4)) console.log("  " + n);
  if (faceNotes.length > 4) console.log(`  ... and ${faceNotes.length - 4} more, same face`);
  console.log("  Colours, radii, tokens, declared type and node identity WERE verified.");
}
if (rasterNotes.length > 0) {
  console.log(`\n! ${rasterNotes.length} fixture-width(s) held back their SCREENSHOT diff on this host:`);
  for (const n of rasterNotes.slice(0, 2)) console.log("  " + n);
  if (rasterNotes.length > 2) console.log(`  ... and ${rasterNotes.length - 2} more, same platform pair`);
  console.log("  Boxes, line-heights, colours, radii, tokens and type WERE verified.");
}
console.log(`\nparity oracle [${engine}] ${mode}: ${fixtureFiles.length}/${fixtureFiles.length} fixtures x ${VIEWPORTS.length} widths (${VIEWPORTS.map((p) => p.width).join("/")}) ${mode === "record" ? "recorded" : faceNotes.length > 0 ? "agree on the host-independent plane" : "agree with the stored reference plane"}`);
