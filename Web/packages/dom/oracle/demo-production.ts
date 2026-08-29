//
// demo-production.ts — responsive/a11y production gate over the COMPLETE built DSX
// Demo. Unlike screenshot approval, this oracle walks every declared component route
// through phone, tablet, and desktop contexts and asserts behavioral invariants. It is
// intentionally data-driven from routes.json and the emitted module chunks so a new
// demo page or capability cannot silently escape the gate.
//

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";

import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

type Route = { path: string; component?: string; redirect?: string };
type MatrixEntry = {
  name: string;
  viewport: { width: number; height: number };
  userAgent: string;
  hasTouch: boolean;
  mobile: boolean;
};

function repoRoot(): string {
  let dir = resolve(dirname(fileURLToPath(import.meta.url)));
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const root = repoRoot();
const webRoot = join(root, "OpenSource/Web");
const site = join(webRoot, "demo/site");
const routes = (JSON.parse(readFileSync(
  join(root, "ClosedSource/DSX/Modules/Config/routes.json"),
  "utf8",
)) as { routes: Route[] }).routes.filter(
  (route): route is Route & { component: string } =>
    route.redirect === undefined && typeof route.component === "string",
);

if (routes.length < 22) {
  throw new Error(`expected the complete DSX Demo route table (>=22 component routes), got ${routes.length}`);
}
if (!existsSync(join(site, "main.js"))) {
  throw new Error("built Demo missing; run `node packages/compiler/bin/build-demo.ts` first");
}

const engine = browserEngine();
const matrix: MatrixEntry[] = [
  {
    name: "ios-phone",
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
    hasTouch: true,
    mobile: true,
  },
  {
    name: "android-phone",
    viewport: { width: 412, height: 915 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Chrome/136.0.0.0 Mobile Safari/537.36",
    hasTouch: true,
    mobile: true,
  },
  {
    name: "ipad",
    viewport: { width: 820, height: 1180 },
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
    hasTouch: true,
    mobile: true,
  },
  {
    name: "desktop",
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
    hasTouch: false,
    mobile: false,
  },
  {
    name: "wide-desktop",
    viewport: { width: 2048, height: 1152 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
    hasTouch: false,
    mobile: false,
  },
];

const failures: string[] = [];
const { port, close } = await startServer(0);
const origin = `http://localhost:${port}`;
const appUrl = (path: string): string => `${origin}/demo/site${path === "/" ? "/" : path}`;

function fail(scope: string, message: string): void {
  failures.push(`${scope}: ${message}`);
}

async function newContext(browser: Browser, entry: MatrixEntry): Promise<BrowserContext> {
  return await browser.newContext({
    viewport: entry.viewport,
    userAgent: entry.userAgent,
    hasTouch: entry.hasTouch,
    deviceScaleFactor: entry.mobile ? 2 : 1,
    // Playwright's Firefox backend does not implement the isMobile context flag.
    ...(engine === "firefox" ? {} : { isMobile: entry.mobile }),
    reducedMotion: "reduce",
  });
}

function observeErrors(page: Page, scope: () => string): void {
  page.on("pageerror", (error) => fail(scope(), `pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") fail(scope(), `console.error: ${message.text()}`);
  });
}

async function routeAudit(page: Page, matrixName: string, route: Route & { component: string }): Promise<void> {
  const scope = `${matrixName} ${route.path}`;
  const owner = route.component.includes(".")
    ? route.component.substring(route.component.indexOf(".") + 1)
    : route.component;
  await page.goto(appUrl(route.path), { waitUntil: "domcontentloaded" });
  // Static exports contain the same owner in their SSR paint. Require the hydrated
  // router frame so the audit can never pass against HTML that client boot later loses.
  const surface = page.locator(`[data-dsx-root] .dsx-frame [data-dsx-owner="${owner}"]`).last();
  try {
    await surface.waitFor({ state: "visible", timeout: 8000 });
  } catch {
    fail(scope, `component ${route.component} did not render`);
    return;
  }
  await page.waitForTimeout(50);

  const audit = await page.evaluate((activeOwner) => {
    const root = document.documentElement;
    const body = document.body;
    const active = [...document.querySelectorAll<HTMLElement>(`[data-dsx-owner="${CSS.escape(activeOwner)}"]`)]
      .find((node) => node.getClientRects().length > 0) ?? null;
    const visibleFrames = [...document.querySelectorAll<HTMLElement>(".dsx-frame")]
      .filter((frame) => frame.getAttribute("aria-hidden") !== "true" && frame.getClientRects().length > 0);
    const mainScroll = active === null
      ? null
      : [...active.children].find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("dsx-scroll")) ?? null;
    const mainContentCandidate = mainScroll?.firstElementChild;
    // Gallery and Workspace are application canvases, not the ordinary
    // owner > scroll > content reading-page anatomy. Measure their explicit
    // bounded page root against the active detail frame.
    const applicationContent = active?.querySelector<HTMLElement>(".gallery-page,.workspace-page") ?? null;
    const mainContent = applicationContent
      ?? (mainContentCandidate instanceof HTMLElement ? mainContentCandidate : null);
    const scrollRect = applicationContent !== null
      ? active?.getBoundingClientRect() ?? null
      : mainScroll?.getBoundingClientRect() ?? null;
    const contentRect = mainContent?.getBoundingClientRect() ?? null;
    const scrollClientLeft = applicationContent !== null
      ? scrollRect?.left ?? 0
      : scrollRect === null || mainScroll === null ? 0 : scrollRect.left + mainScroll.clientLeft;
    const scrollClientRight = applicationContent !== null
      ? scrollRect?.right ?? 0
      : mainScroll === null ? 0 : scrollClientLeft + mainScroll.clientWidth;
    return {
      documentOverflow: Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth,
      unsupported: active?.querySelectorAll(".dsx-unsupported").length ?? -1,
      content: (active?.innerText ?? "").trim().length,
      controls: active?.querySelectorAll("button,input,select,textarea,a,[role=button],svg,canvas,iframe").length ?? 0,
      visibleFrames: visibleFrames.length,
      split: document.querySelector("[data-dsx-root].dsx-split") !== null,
      mainContentWidth: contentRect?.width ?? 0,
      mainContentBalance: scrollRect !== null && contentRect !== null
        ? Math.abs((contentRect.left - scrollClientLeft) - (scrollClientRight - contentRect.right))
        : 0,
    };
  }, owner);

  if (audit.documentOverflow > 1) fail(scope, `horizontal document overflow ${audit.documentOverflow}px`);
  if (audit.unsupported !== 0) fail(scope, `${audit.unsupported} visible .dsx-unsupported marker(s)`);
  if (audit.content === 0 && audit.controls === 0) fail(scope, "rendered an empty surface");

  if (matrixName.endsWith("desktop") && route.path !== "/") {
    if (!audit.split) fail(scope, "deep link did not enter the desktop master-detail layout");
    if (audit.visibleFrames !== 2) fail(scope, `expected master + detail visible, got ${audit.visibleFrames} frame(s)`);
  } else if (audit.visibleFrames !== 1) {
    fail(scope, `expected one visible frame, got ${audit.visibleFrames}`);
  }
  if (matrixName === "wide-desktop" && route.path !== "/") {
    // Reading pages keep the 72rem measure. Gallery and Workspace are explicit
    // application surfaces and locally opt into a bounded 100rem canvas.
    const applicationSurface = route.path === "/workspace" || route.path === "/gallery";
    const maximum = applicationSurface ? 1601 : 1441;
    if (audit.mainContentWidth <= 0 || audit.mainContentWidth > maximum) {
      fail(scope, `wide detail content width ${audit.mainContentWidth}px escaped its ${applicationSurface ? "100rem application" : "reading"} measure`);
    }
    if (audit.mainContentBalance > 2) {
      fail(scope, `wide detail content is off-center by ${audit.mainContentBalance}px`);
    }
  }
}

const badgeModule: Record<string, string | null> = {
  "Device qualification": "qualification",
  "Component catalog": null,
  "Desktop app shape": null,
  "Navigation bar": null,
  "Flex layout": null,
  Gestures: null,
  Basics: "haptic",
  "System & app": null,
  "Device info": null,
  Device: "biometric",
  "Local push": "localpush",
  "Live surfaces": null,
  "Apple Watch": null,
  "Media & files": "fileviewer",
  "Sensors & voice": "scanner",
  "App chrome": "quickactions",
  Appearance: "appearance",
  "Data & integrations": "writevalue",
  "Store & paywall": "store",
  "Charts & maps": null,
  "3D · AR": "scene3d",
  "Bus round-trip": null,
  "Errors & logs": null,
  "Web surface": null,
};

async function capabilityBadgeAudit(page: Page): Promise<void> {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  const launcherRows = page.locator('[data-dsx-root] .dsx-frame [data-dsx-owner="Launcher"] .launcher-row');
  await launcherRows.first().waitFor({ state: "visible", timeout: 8000 });
  const rows = await launcherRows.evaluateAll((nodes) =>
    nodes.map((node) => {
      const text = [...node.querySelectorAll(".dsx-text")].map((part) => part.textContent?.trim() ?? "");
      let badge = "";
      for (let index = text.length - 1; index >= 0; index -= 1) {
        const value = text[index];
        if (value === "Setup") { badge = value; break; }
      }
      return { title: text[0] ?? "", badge };
    }),
  );
  const byTitle = new Map(rows.map((row) => [row.title, row.badge]));
  if (rows.length !== Object.keys(badgeModule).length) {
    fail("capability badges", `expected ${Object.keys(badgeModule).length} rows, got ${rows.length}`);
  }
  for (const [title, moduleName] of Object.entries(badgeModule)) {
    const emitted = moduleName === null || existsSync(join(site, "modules", `${moduleName}.js`));
    const expected = emitted ? "" : "Setup";
    const actual = byTitle.get(title);
    if (actual !== expected) fail("capability badges", `${title}: expected ${expected}, got ${String(actual)}`);
  }
}

async function authoredOverrideAudit(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl("/gallery"), { waitUntil: "domcontentloaded" });
  const probe = page.locator('[data-dsx-owner="Gallery"] .gallery-override-probe').last();
  await probe.waitFor({ state: "visible", timeout: 8000 });
  const computed = await probe.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderRadius: Number.parseFloat(style.borderRadius),
      minHeight: Number.parseFloat(style.minHeight),
      renderedHeight: element.getBoundingClientRect().height,
    };
  });
  if (Math.abs(computed.borderRadius - 10) > .1) {
    fail("authored overrides", `segmented border-radius=${computed.borderRadius}px; expected 10px`);
  }
  if (computed.minHeight < 48 || computed.renderedHeight < 48) {
    fail(
      "authored overrides",
      `segmented min-height=${computed.minHeight}px, rendered=${computed.renderedHeight}px; expected at least 48px`,
    );
  }
}

async function breakpointLayoutAudit(page: Page): Promise<void> {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await page.locator('[data-dsx-root] .dsx-frame [data-dsx-owner="Launcher"] .launcher-row').first().waitFor({ state: "visible", timeout: 8000 });
  const boundaries = [
    { width: 360, height: 800, columns: 1 },
    { width: 599, height: 900, columns: 1 },
    { width: 600, height: 900, columns: 1 },
    { width: 767, height: 1024, columns: 2 },
    { width: 768, height: 1024, columns: 2 },
    { width: 834, height: 1112, columns: 2 },
    { width: 1023, height: 768, columns: 2 },
    { width: 1024, height: 768, columns: 2 },
    { width: 1280, height: 800, columns: 3 },
    { width: 1440, height: 900, columns: 3 },
    { width: 1600, height: 1000, columns: 3 },
    { width: 2048, height: 1152, columns: 3 },
  ];
  for (const viewport of boundaries) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(50);
    const audit = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const panes = document.querySelector<HTMLElement>('[data-dsx-owner="Launcher"] .launcher-panes');
      const columns = panes === null
        ? 0
        : getComputedStyle(panes).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
      return {
        overflow: Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth,
        columns,
      };
    });
    const scope = `viewport ${viewport.width}x${viewport.height}`;
    if (audit.overflow > 1) fail(scope, `horizontal document overflow ${audit.overflow}px`);
    if (audit.columns !== viewport.columns) {
      fail(scope, `launcher used ${audit.columns} pane columns; expected ${viewport.columns}`);
    }
  }

  // The detail page is the shape that exposed the original stretched-desktop bug.
  // Exercise every tier live in one hydrated router so breakpoint crossings also
  // prove that split/inert state and CSS media queries converge without a reload.
  await page.goto(appUrl("/navigation"), { waitUntil: "domcontentloaded" });
  await page.locator('[data-dsx-owner="Navigation"]').last().waitFor({ state: "visible", timeout: 8000 });
  const detailBoundaries = [
    { width: 360, height: 800, split: false, sidebar: 0, grid: false },
    { width: 768, height: 1024, split: false, sidebar: 0, grid: false },
    { width: 834, height: 1112, split: false, sidebar: 0, grid: false },
    { width: 1024, height: 768, split: true, sidebar: 288, grid: false },
    { width: 1280, height: 800, split: true, sidebar: 320, grid: false },
    { width: 1600, height: 1000, split: true, sidebar: 352, grid: true },
    { width: 2048, height: 1152, split: true, sidebar: 352, grid: true },
  ];
  for (const viewport of detailBoundaries) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(50);
    const audit = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-dsx-root]");
      const master = document.querySelector<HTMLElement>('.dsx-master:has([data-dsx-owner="Launcher"])');
      const detail = document.querySelector<HTMLElement>('.dsx-frame:has([data-dsx-owner="Navigation"])');
      const scroll = document.querySelector<HTMLElement>('[data-dsx-owner="Navigation"] > .dsx-scroll');
      const content = document.querySelector<HTMLElement>('[data-dsx-owner="Navigation"] > .dsx-scroll > .navigation-layout');
      const scrollRect = scroll?.getBoundingClientRect() ?? null;
      const contentRect = content?.getBoundingClientRect() ?? null;
      const detailRect = detail?.getBoundingClientRect() ?? null;
      const scrollClientLeft = scrollRect === null || scroll === null ? 0 : scrollRect.left + scroll.clientLeft;
      const scrollClientRight = scroll === null ? 0 : scrollClientLeft + scroll.clientWidth;
      const columns = content === null || getComputedStyle(content).display !== "grid"
        ? 1
        : getComputedStyle(content).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
      return {
        split: root?.classList.contains("dsx-split") ?? false,
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
        sidebarWidth: master?.getBoundingClientRect().width ?? 0,
        detailLeft: detailRect?.left ?? -1,
        detailWidth: detailRect?.width ?? 0,
        contentWidth: contentRect?.width ?? 0,
        contentBalance: scrollRect !== null && contentRect !== null
          ? Math.abs((contentRect.left - scrollClientLeft) - (scrollClientRight - contentRect.right))
          : Number.POSITIVE_INFINITY,
        columns,
      };
    });
    const scope = `navigation ${viewport.width}x${viewport.height}`;
    if (audit.overflow > 1) fail(scope, `horizontal document overflow ${audit.overflow}px`);
    if (audit.split !== viewport.split) fail(scope, `split=${String(audit.split)}; expected ${String(viewport.split)}`);
    if (viewport.split) {
      if (Math.abs(audit.sidebarWidth - viewport.sidebar) > 1) {
        fail(scope, `sidebar width ${audit.sidebarWidth}px; expected ${viewport.sidebar}px`);
      }
      if (Math.abs(audit.detailLeft - audit.sidebarWidth) > 1) {
        fail(scope, `detail starts at ${audit.detailLeft}px but sidebar is ${audit.sidebarWidth}px`);
      }
    } else if (Math.abs(audit.detailWidth - viewport.width) > 1) {
      fail(scope, `single-pane detail width ${audit.detailWidth}px; expected ${viewport.width}px`);
    }
    if (audit.contentWidth <= 0 || audit.contentWidth > audit.detailWidth + 1) {
      fail(scope, `content width ${audit.contentWidth}px is invalid for ${audit.detailWidth}px detail`);
    }
    if (audit.contentBalance > 2) fail(scope, `content is off-center by ${audit.contentBalance}px`);
    if ((audit.columns === 2) !== viewport.grid) {
      fail(scope, `navigation layout used ${audit.columns} column(s); expected ${viewport.grid ? 2 : 1}`);
    }
    if (viewport.width === 2048 && audit.contentWidth > 1441) {
      fail(scope, `2048px content stretched to ${audit.contentWidth}px (80rem/1440px cap expected)`);
    }
  }
}

async function designQualityAudit(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  const row = page.locator('[data-dsx-owner="Launcher"] .launcher-row').first();
  await row.waitFor({ state: "visible", timeout: 8000 });
  const launcher = await row.evaluate((element) => {
    const card = element.querySelector<HTMLElement>(".launcher-card");
    const texts = card?.querySelectorAll<HTMLElement>(".dsx-text") ?? [];
    const resolveRgb = (value: string, under: [number, number, number] = [255, 255, 255]): [number, number, number] | null => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return null;
      context.fillStyle = `rgb(${under[0]} ${under[1]} ${under[2]})`;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      return [red ?? 0, green ?? 0, blue ?? 0];
    };
    const luminance = (rgb: [number, number, number]): number => {
      const channel = (value: number): number => {
        const normalized = value / 255;
        return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
      };
      return .2126 * channel(rgb[0]) + .7152 * channel(rgb[1]) + .0722 * channel(rgb[2]);
    };
    const contrast = (foreground: string, background: string): number => {
      const bg = resolveRgb(background);
      const fg = bg === null ? null : resolveRgb(foreground, bg);
      if (fg === null || bg === null) return 0;
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const cardStyle = card === null ? null : getComputedStyle(card);
    const libraryStyle = card?.closest(".launcher-library") instanceof HTMLElement
      ? getComputedStyle(card.closest(".launcher-library") as HTMLElement)
      : null;
    const titleStyle = texts[0] === undefined ? null : getComputedStyle(texts[0]);
    const subtitleStyle = texts[1] === undefined ? null : getComputedStyle(texts[1]);
    const rect = card?.getBoundingClientRect();
    const effectiveBackground = libraryStyle?.backgroundColor ?? cardStyle?.backgroundColor ?? "";
    return {
      height: rect?.height ?? 0,
      radius: Number.parseFloat(cardStyle?.borderRadius ?? "0"),
      padding: Number.parseFloat(cardStyle?.paddingTop ?? "0"),
      surfaceBackground: effectiveBackground,
      canvasBackground: getComputedStyle(document.querySelector<HTMLElement>("[data-dsx-root]")!).backgroundColor,
      titleSize: Number.parseFloat(titleStyle?.fontSize ?? "0"),
      titleContrast: contrast(titleStyle?.color ?? "", effectiveBackground),
      subtitleContrast: contrast(subtitleStyle?.color ?? "", effectiveBackground),
      separator: cardStyle?.boxShadow ?? "",
      transitionDuration: cardStyle?.transitionDuration ?? "",
    };
  });
  if (launcher.height < 56) fail("design quality", `launcher row is only ${launcher.height}px tall`);
  if (launcher.radius > 1) fail("design quality", `continuous launcher row unexpectedly has ${launcher.radius}px corners`);
  if (launcher.padding < 10) fail("design quality", `launcher row padding is only ${launcher.padding}px`);
  if (launcher.surfaceBackground === launcher.canvasBackground) fail("design quality", "launcher library has no contextual surface separation");
  if (!launcher.separator.includes("inset")) fail("design quality", "launcher row is missing its inset physical separator");
  if (launcher.titleSize < 14) fail("design quality", `launcher title is only ${launcher.titleSize}px`);
  if (launcher.titleContrast < 4.5) fail("design quality", `launcher title contrast is ${launcher.titleContrast.toFixed(2)}:1`);
  if (launcher.subtitleContrast < 3) fail("design quality", `launcher supporting-text contrast is ${launcher.subtitleContrast.toFixed(2)}:1`);
  if (!launcher.transitionDuration.split(",").every((value) => Number.parseFloat(value) === 0)) {
    fail("design quality", `reduced-motion card still transitions (${launcher.transitionDuration})`);
  }

  await page.goto(appUrl("/gallery"), { waitUntil: "domcontentloaded" });
  const gallery = page.locator('[data-dsx-owner="Gallery"]').last();
  await gallery.waitFor({ state: "visible", timeout: 8000 });
  const controls = await gallery.evaluate((surface) => {
    const visible = (node: Element): node is HTMLElement => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false;
      const style = getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    // Native-looking switches/checkboxes use a visually-hidden input inside the
    // real label hit target. Audit that effective target instead of flagging the
    // hidden 1px implementation node as a user-facing control.
    const raw = [...surface.querySelectorAll("button,input,textarea,select,[role=switch],[role=radio]")].filter(visible);
    const all = [...new Set(raw.map((node) => {
      if (node instanceof HTMLInputElement && getComputedStyle(node).opacity === "0" && node.parentElement instanceof HTMLElement) {
        return node.parentElement;
      }
      return node;
    }))];
    const tooSmall = all.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height < 40
        && !node.classList.contains("dsx-slider")
        // The visual switch itself is the web capsule polyfill (63x28 comfortable);
        // it is normally embedded in a full-width tappable row.
        && !node.classList.contains("dsx-toggle")
        && node.getAttribute("role") !== "switch"
        && node.getAttribute("role") !== "radio";
    }).map((node) => `${node.tagName.toLowerCase()}.${node.className}:${Math.round(node.getBoundingClientRect().height)}`);
    const probe = surface.querySelector<HTMLElement>(".gallery-override-probe");
    const probeStyle = probe === null ? null : getComputedStyle(probe);
    return {
      tooSmall: tooSmall.slice(0, 12),
      unsupported: surface.querySelectorAll(".dsx-unsupported").length,
      probe: probeStyle === null ? null : {
        radius: Number.parseFloat(probeStyle.borderRadius),
        minHeight: Number.parseFloat(probeStyle.minHeight),
      },
    };
  });
  if (controls.unsupported !== 0) fail("design quality", `Gallery contains ${controls.unsupported} unsupported component(s)`);
  if (controls.tooSmall.length > 0) fail("design quality", `sub-40px controls: ${controls.tooSmall.join(", ")}`);
  if (controls.probe === null) fail("design quality", "Gallery is missing its authored override probe");
  else {
    if (Math.abs(controls.probe.radius - 10) > .1) fail("design quality", `authored radius lost (${controls.probe.radius}px)`);
    if (controls.probe.minHeight < 48) fail("design quality", `authored min-height lost (${controls.probe.minHeight}px)`);
  }
  await gallery.locator('[aria-label="Inputs"]').click();
  const textfield = gallery.locator('.dsx-textfield:not(.dsx-searchbar)');
  await textfield.waitFor({ state: "visible", timeout: 2000 });
  const textfieldMetrics = await textfield.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    radius: Number.parseFloat(getComputedStyle(element).borderRadius),
  }));
  if (textfieldMetrics.height < 44) fail("design quality", `textfield height is ${textfieldMetrics.height}px`);
  if (textfieldMetrics.radius < 7) fail("design quality", `textfield radius is ${textfieldMetrics.radius}px`);
}

async function desktopInteractionQualityAudit(page: Page): Promise<void> {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  const row = page.locator('[data-dsx-owner="Launcher"] .launcher-row').first();
  await row.waitFor({ state: "visible", timeout: 8000 });
  const before = await row.evaluate((element) => {
    const card = element.querySelector<HTMLElement>(".launcher-card")!;
    const style = getComputedStyle(card);
    return { background: style.backgroundColor, border: style.borderColor, transform: style.transform };
  });
  await row.hover();
  await page.waitForTimeout(180);
  const after = await row.evaluate((element) => {
    const card = element.querySelector<HTMLElement>(".launcher-card")!;
    const style = getComputedStyle(card);
    return { background: style.backgroundColor, border: style.borderColor, transform: style.transform };
  });
  if (before.background === after.background && before.border === after.border && before.transform === after.transform) {
    fail("desktop interactions", "launcher card has no pointer-hover feedback");
  }
  await row.focus();
  const focus = await row.evaluate((element) => {
    const style = getComputedStyle(element);
    return { boxShadow: style.boxShadow, outline: style.outlineStyle };
  });
  if ((focus.boxShadow === "none" || focus.boxShadow === "") && (focus.outline === "none" || focus.outline === "")) {
    fail("desktop interactions", "keyboard focus has no visible indicator");
  }

  await page.goto(appUrl("/gallery"), { waitUntil: "domcontentloaded" });
  const gallery = page.locator('[data-dsx-owner="Gallery"]').last();
  await gallery.waitFor({ state: "visible", timeout: 8000 });
  await gallery.locator('[aria-label="Inputs"]').click();
  const projectField = gallery.locator('.dsx-textfield:not(.dsx-searchbar)');
  await projectField.waitFor({ state: "visible", timeout: 2000 });
  const fieldHeight = await projectField.evaluate((element) => element.getBoundingClientRect().height);
  await gallery.locator('[aria-label="Controls"]').click();
  await gallery.locator('.gallery-override-probe').waitFor({ state: "visible", timeout: 2000 });
  const density = await gallery.evaluate((surface) => {
    const button = surface.querySelector<HTMLElement>(".dsx-button[data-dsx-variant=\"prominent\"]");
    const override = surface.querySelector<HTMLElement>(".gallery-override-probe");
    return {
      token: getComputedStyle(document.documentElement).getPropertyValue("--dsx-control-height").trim(),
      button: button?.getBoundingClientRect().height ?? 0,
      override: override?.getBoundingClientRect().height ?? 0,
    };
  });
  if (density.token !== "32px") fail("desktop density", `control token is ${density.token}; expected 32px`);
  for (const [name, height] of [["textfield", fieldHeight], ["button", density.button]] as const) {
    if (height < 30 || height > 34) fail("desktop density", `${name} is ${height}px; expected precision density`);
  }
  if (density.override < 48) fail("desktop density", `authored 48px override collapsed to ${density.override}px`);

  const prominent = gallery.locator('.dsx-button[data-dsx-variant="prominent"]').first();
  const idleShadow = await prominent.evaluate((element) => getComputedStyle(element).boxShadow);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 80; index += 1) {
    // macOS WebKit follows Safari's keyboard preference: Option+Tab reaches all
    // controls even when ordinary Tab is limited to text fields and lists.
    await page.keyboard.press(engine === "webkit" ? "Alt+Tab" : "Tab");
    if (await prominent.evaluate((element) => element === document.activeElement)) break;
  }
  const focusedShadow = await prominent.evaluate((element) => ({
    shadow: getComputedStyle(element).boxShadow,
    outline: getComputedStyle(element).outlineStyle,
    focusVisible: element.matches(":focus-visible"),
  }));
  const shadowAddsFocus = focusedShadow.shadow !== "none" && focusedShadow.shadow !== ""
    && focusedShadow.shadow !== idleShadow;
  const outlineAddsFocus = focusedShadow.outline !== "none" && focusedShadow.outline !== "";
  if (!focusedShadow.focusVisible || (!shadowAddsFocus && !outlineAddsFocus)) {
    fail("desktop interactions", `prominent keyboard focus is hidden by its elevation shadow `
      + `(focus-visible=${String(focusedShadow.focusVisible)}, outline=${focusedShadow.outline}, shadow-changed=${String(shadowAddsFocus)})`);
  }

  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });
  const workspace = page.locator('[data-dsx-owner="Workspace"]').last();
  await workspace.waitFor({ state: "visible", timeout: 8000 });
  const workspaceDensity = await workspace.evaluate((surface) => ({
    button: surface.querySelector<HTMLElement>('.dsx-button[data-dsx-variant="prominent"]')
      ?.getBoundingClientRect().height ?? 0,
    disabledPublish: [...surface.querySelectorAll<HTMLButtonElement>("button[disabled]")]
      .filter((button) => /publish/i.test(button.textContent ?? "")).length,
  }));
  if (workspaceDensity.button < 30 || workspaceDensity.button > 34) {
    fail("desktop density", `workspace button is ${workspaceDensity.button}px; expected precision density`);
  }
  if (workspaceDensity.disabledPublish !== 2) {
    fail("desktop density", `workspace lost ${2 - workspaceDensity.disabledPublish} gated publish action(s)`);
  }
}

async function workspaceLayoutAudit(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl("/workspace"), { waitUntil: "domcontentloaded" });
  const workspace = page.locator('[data-dsx-owner="Workspace"]').last();
  await workspace.waitFor({ state: "visible", timeout: 8000 });

  const viewports = [
    { width: 390, height: 844, columns: 1, nav: "column", density: "40px" },
    { width: 820, height: 1180, columns: 2, nav: "column", density: "40px" },
    // The outer Launcher master leaves a compact detail container here; container
    // queries intentionally keep the nested workspace at two panes.
    // This audit intentionally retains a touch-capable context while resizing, so
    // large tablet/window layouts keep the 40px density token with 48px effective
    // targets. The desktop audit above separately proves the 32px precision tier.
    { width: 1440, height: 900, columns: 2, nav: "column", density: "40px" },
    { width: 2048, height: 1152, columns: 3, nav: "column", density: "40px" },
  ] as const;
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(75);
    const audit = await workspace.evaluate((surface) => {
      const shell = surface.querySelector<HTMLElement>(".workspace-shell");
      const nav = surface.querySelector<HTMLElement>(".workspace-sidebar-nav");
      const shellStyle = shell === null ? null : getComputedStyle(shell);
      const navStyle = nav === null ? null : getComputedStyle(nav);
      const columns = shellStyle?.gridTemplateColumns.split(/\s+/).filter(Boolean).length ?? 0;
      const shadows = [...surface.querySelectorAll<HTMLElement>(
        ".workspace-shell,.workspace-readiness,.workspace-section",
      )].map((node) => getComputedStyle(node).boxShadow);
      return {
        columns,
        nav: navStyle?.flexDirection ?? "",
        density: getComputedStyle(document.documentElement).getPropertyValue("--dsx-control-height").trim(),
        disabledPublish: [...surface.querySelectorAll<HTMLButtonElement>("button[disabled]")]
          .filter((button) => /publish/i.test(button.textContent ?? "")).length,
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
          - document.documentElement.clientWidth,
        shadows,
      };
    });
    const scope = `workspace ${viewport.width}x${viewport.height}`;
    if (audit.columns !== viewport.columns) fail(scope, `used ${audit.columns} columns; expected ${viewport.columns}`);
    if (audit.nav !== viewport.nav) fail(scope, `navigation direction is ${audit.nav}; expected ${viewport.nav}`);
    if (audit.density !== viewport.density) fail(scope, `control density is ${audit.density}; expected ${viewport.density}`);
    if (audit.disabledPublish !== 2) fail(scope, `expected two gated publish actions, got ${audit.disabledPublish}`);
    if (audit.overflow > 1) fail(scope, `horizontal document overflow ${audit.overflow}px`);
    if (audit.shadows.some((shadow) => shadow !== "none" && !shadow.includes("inset"))) {
      fail(scope, `work surfaces gained exterior decorative elevation (${audit.shadows.join(", ")})`);
    }
  }

  const focusTarget = workspace.locator(".workspace-check-pressable").first();
  await focusTarget.focus();
  const focus = await focusTarget.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  if ((focus.outline === "none" || focus.outline === "") && (focus.shadow === "none" || focus.shadow === "")) {
    fail("workspace keyboard", "release-check rows have no visible focus indication");
  }
}

async function forcedColorsAudit(page: Page): Promise<void> {
  await page.goto(appUrl("/gallery"), { waitUntil: "domcontentloaded" });
  const gallery = page.locator('[data-dsx-owner="Gallery"]').last();
  await gallery.waitFor({ state: "visible", timeout: 8000 });
  const focusTarget = gallery.locator(".dsx-button").first();
  await focusTarget.focus();
  const audit = await gallery.evaluate((surface) => ({
    content: (surface.textContent ?? "").trim().length,
    visibleControls: [...surface.querySelectorAll<HTMLElement>("button,input,textarea,select")]
      .filter((control) => control.getClientRects().length > 0).length,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    focusOutline: (() => {
      const target = surface.querySelector<HTMLElement>(".dsx-button:focus");
      return target === null ? "missing" : getComputedStyle(target).outlineStyle;
    })(),
  }));
  if (audit.content === 0 || audit.visibleControls < 8) fail("forced colors", "Gallery content or controls disappeared");
  if (audit.documentOverflow > 1) fail("forced colors", `horizontal overflow ${audit.documentOverflow}px`);
  if (audit.focusOutline === "none" || audit.focusOutline === "missing") {
    fail("forced colors", `focused control outline is ${audit.focusOutline}`);
  }
}

async function focusAndInertAudit(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  const launcher = page.locator('.dsx-frame:has([data-dsx-owner="Launcher"])').first();
  const trigger = launcher.locator("button", { hasText: "Flex layout" }).first();
  await trigger.waitFor({ state: "visible", timeout: 8000 });
  await trigger.focus();
  await trigger.press("Enter");
  const flex = page.locator('[data-dsx-owner="Flex"]').last();
  await flex.waitFor({ state: "visible", timeout: 8000 });
  try {
    await page.waitForFunction(() => {
      const top = document.querySelector<HTMLElement>('.dsx-frame:not([aria-hidden="true"]):has([data-dsx-owner="Flex"])');
      return top !== null && top.contains(document.activeElement);
    }, undefined, { timeout: 2000 });
  } catch {
    fail("focus/inert", "pushed Flex frame did not receive focus");
  }
  const covered = await launcher.evaluate((frame) => ({
    ariaHidden: frame.getAttribute("aria-hidden"),
    inert: (frame as HTMLElement).inert || frame.hasAttribute("inert"),
  }));
  if (covered.ariaHidden !== "true") fail("focus/inert", `covered launcher aria-hidden=${String(covered.ariaHidden)}`);
  if (!covered.inert) fail("focus/inert", "covered launcher was not inert");

  await page.getByRole("button", { name: "Back" }).first().click();
  await launcher.waitFor({ state: "visible", timeout: 8000 });
  try {
    await page.waitForFunction(() => document.activeElement?.textContent?.includes("Flex layout") === true, undefined, { timeout: 2000 });
  } catch {
    fail("focus/inert", "Back did not restore focus to the launcher trigger");
  }
}

async function chromeAudit(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl("/navigation"), { waitUntil: "domcontentloaded" });
  await page.locator('[data-dsx-owner="Navigation"]').last().waitFor({ state: "visible", timeout: 8000 });
  const bar = page.locator('[data-dsx-module="route"]').first();
  await bar.waitFor({ state: "visible", timeout: 8000 });
  const initial = await bar.evaluate((element) => {
    const back = element.querySelector<HTMLElement>('button[aria-label="Back"]');
    const r = element.getBoundingClientRect();
    const b = back?.getBoundingClientRect();
    const app = document.querySelector("#app");
    return {
      height: r.height,
      beforeApp: app !== null && (element.compareDocumentPosition(app) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      backWidth: b?.width ?? 0,
      backHeight: b?.height ?? 0,
    };
  });
  if (initial.height < 88) fail("navigation chrome", `large title bar was only ${initial.height}px high`);
  if (!initial.beforeApp) fail("navigation chrome", "system bar follows #app in DOM/tab order");
  if (initial.backWidth < 44 || initial.backHeight < 44) {
    fail("navigation chrome", `Back target is ${initial.backWidth}x${initial.backHeight}, below 44x44`);
  }

  await page.getByRole("button", { name: "Inline title" }).click();
  await page.waitForFunction(() => {
    const bar = document.querySelector<HTMLElement>('[data-dsx-module="route"]');
    return bar !== null && bar.getBoundingClientRect().height <= 70;
  });
  await page.getByRole("button", { name: "Retitle live" }).click();
  if (!((await bar.textContent()) ?? "").includes("Retitled live ✦")) fail("navigation chrome", "live retitle did not update the bar");

  await page.getByRole("button", { name: "Release the bar" }).click();
  const released = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-dsx-module="route"]');
    return {
      display: element === null ? "absent" : getComputedStyle(element).display,
      inset: document.documentElement.style.getPropertyValue("--dsx-chrome-inset"),
    };
  });
  if ((released.display !== "none" && released.display !== "absent") || released.inset.trim() !== "0px") {
    fail("navigation chrome", `release left display=${released.display}, inset=${released.inset}`);
  }

  await page.getByRole("button", { name: "Large title" }).click();
  await bar.waitFor({ state: "visible", timeout: 2000 });
  const scroller = page.locator('[data-dsx-owner="Navigation"] .dsx-scroll').last();
  await scroller.evaluate((node) => { node.scrollTop = Math.min(300, node.scrollHeight - node.clientHeight); });
  try {
    await page.waitForFunction(() => {
      const bar = document.querySelector<HTMLElement>('[data-dsx-module="route"]');
      return bar !== null && bar.getBoundingClientRect().height <= 70;
    }, undefined, { timeout: 2000 });
  } catch {
    fail("navigation chrome", "large title did not condense after the active screen scrolled");
  }

  await page.getByRole("button", { name: "Back" }).first().click();
  await page.locator('[data-dsx-root] .dsx-frame [data-dsx-owner="Launcher"]').waitFor({ state: "visible", timeout: 8000 });
  const reclaimed = await bar.evaluate((element) => ({
    display: getComputedStyle(element).display,
    backVisible: (() => {
      const back = element.querySelector<HTMLElement>('button[aria-label="Back"]');
      return back !== null
        && getComputedStyle(element).display !== "none"
        && getComputedStyle(back).visibility !== "hidden"
        && back.getClientRects().length > 0;
    })(),
    commandbarVisible: (() => {
      const commandbar = document.querySelector<HTMLElement>(
        '[data-dsx-owner="Launcher"] .launcher-commandbar',
      );
      return commandbar !== null
        && getComputedStyle(commandbar).display !== "none"
        && commandbar.getClientRects().length > 0;
    })(),
  }));
  if (!reclaimed.commandbarVisible) {
    fail("navigation chrome", "Back did not restore the root DSX command bar");
  }
  if (reclaimed.display !== "none") {
    fail("navigation chrome", "detail system chrome remained above the root command bar");
  }
  if (reclaimed.backVisible) {
    fail("navigation chrome", "root kept a visible Back control");
  }
}

const browser = await launchBrowser(engine);
try {
  for (const entry of matrix) {
    const context = await newContext(browser, entry);
    const page = await context.newPage();
    let current = entry.name;
    observeErrors(page, () => current);
    for (const route of routes) {
      current = `${entry.name} ${route.path}`;
      try {
        await routeAudit(page, entry.name, route);
      } catch (error) {
        fail(current, String(error));
      }
    }
    console.log(`✓ [${engine}] ${entry.name}: walked ${routes.length} component routes`);
    await context.close();
  }

  const behaviorContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
  const behaviorPage = await behaviorContext.newPage();
  let behaviorScope = "behavior";
  observeErrors(behaviorPage, () => behaviorScope);
  for (const [name, run] of [
    ["capability badges", capabilityBadgeAudit],
    ["authored overrides", authoredOverrideAudit],
    ["viewport boundaries", breakpointLayoutAudit],
    ["design quality", designQualityAudit],
    ["workspace layouts", workspaceLayoutAudit],
    ["focus/inert", focusAndInertAudit],
    ["navigation chrome", chromeAudit],
  ] as const) {
    behaviorScope = name;
    try {
      await run(behaviorPage);
      console.log(`✓ [${engine}] ${name}`);
    } catch (error) {
      fail(name, String(error));
    }
  }
  await behaviorContext.close();

  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: false,
    reducedMotion: "no-preference",
  });
  const desktopPage = await desktopContext.newPage();
  observeErrors(desktopPage, () => "desktop interactions");
  try {
    await desktopInteractionQualityAudit(desktopPage);
    console.log(`✓ [${engine}] desktop hover + focus quality`);
  } catch (error) {
    fail("desktop interactions", String(error));
  }
  await desktopContext.close();

  const contrastContext = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const contrastPage = await contrastContext.newPage();
  observeErrors(contrastPage, () => "forced colors");
  try {
    await forcedColorsAudit(contrastPage);
    console.log(`✓ [${engine}] forced-colors quality`);
  } catch (error) {
    fail("forced colors", String(error));
  }
  await contrastContext.close();
} finally {
  await browser.close();
  await close();
}

if (failures.length > 0) {
  console.error(`\n✗ [${engine}] demo production oracle: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\n✓ [${engine}] demo production oracle: ${routes.length} routes × ${matrix.length} responsive contexts, visual quality, workspace breakpoints, authored overrides, hover, focus, forced colors, inertness, and chrome`);
