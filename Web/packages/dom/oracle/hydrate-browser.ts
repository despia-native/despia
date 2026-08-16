//
//  hydrate-browser.ts - the W6 adopt-hydration gate in a REAL engine: every static
//  SSR route the demo exports is loaded cold, the boot ADOPTS the server DOM, and
//  the page must report ZERO hydration mismatches (globalThis.__DSX_HYDRATION__,
//  adopt.ts). Identity is proven, not inferred: an init-script MutationObserver
//  captures the server-rendered root DURING PARSE — before any module script can
//  run — and after boot that SAME element (===) must sit inside the live frame.
//  One route then proves adopted wiring end-to-end: a click on a server-rendered
//  button drives the store and the adopted text updates.
//
//    npm run browser:hydrate                  (chromium)
//    DSX_BROWSER=webkit npm run browser:hydrate
//
//  Requires a built site (npm run build:demo — the package.json script chains it).
//

import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type RouteRow = { path: string; component?: string; redirect?: string };
type Report = { mode: string; mismatches: number; adopted: number; rebuilt: number; inserted: number; discarded: number };

const web = resolve(import.meta.dirname, "../../..");
const registry = JSON.parse(readFileSync(join(web, "demo/site/registry.json"), "utf8")) as { routes?: RouteRow[] };
const ssrRoutes = (registry.routes ?? []).filter((route) =>
  route.path !== "/"
  && route.redirect === undefined
  && route.component !== undefined
  && !/[:{*]/.test(route.path));
if (ssrRoutes.length === 0) throw new Error("no static SSR routes in demo/site/registry.json — run build:demo");

const engine = browserEngine();
const errors: string[] = [];
const { port, close } = await startServer(0);
const browser = await launchBrowser(engine);
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // a hydration diagnostic in the console IS a gate failure even if counters lag
    if (m.type() === "error" || m.text().includes("[dsx hydrate]")) {
      errors.push(`console: ${m.text()}`);
    }
  });
  // Capture the FIRST server-rendered component root while the document is still
  // parsing — module scripts (the boot) run only after parse, so whatever we hold
  // here is by construction the server's element, never the client's.
  await page.addInitScript(() => {
    const w = window as unknown as { __SSR_ROOT__?: Element | null };
    w.__SSR_ROOT__ = null;
    const observer = new MutationObserver(() => {
      if (w.__SSR_ROOT__ != null) return;
      const el = document.querySelector("[data-dsx-hydrate] > [data-dsx-owner]");
      if (el !== null) { w.__SSR_ROOT__ = el; observer.disconnect(); }
    });
    // `document` itself: init scripts run before documentElement exists
    observer.observe(document, { childList: true, subtree: true });
  });

  let totalAdopted = 0;
  for (const route of ssrRoutes) {
    await page.goto(`http://localhost:${port}/demo/site${route.path}`, { waitUntil: "load" });
    await page.waitForSelector(".dsx-frame [data-dsx-owner]", { timeout: 10_000 });
    const result = await page.evaluate(() => {
      const w = window as unknown as { __DSX_HYDRATION__?: Report; __SSR_ROOT__?: Element | null };
      const report = w.__DSX_HYDRATION__ ?? null;
      const captured = w.__SSR_ROOT__ ?? null;
      return {
        report,
        capturedOwner: captured?.getAttribute("data-dsx-owner") ?? null,
        // THE identity proof: the exact element object captured during parse is
        // still connected, and it lives inside the live frame stack now.
        reused: captured !== null && captured.isConnected && captured.closest(".dsx-frame") !== null,
      };
    });
    const r = result.report;
    if (r === null) { errors.push(`${route.path}: no __DSX_HYDRATION__ report`); continue; }
    if (r.mode !== "adopted") errors.push(`${route.path}: mode=${r.mode} (expected adopted)`);
    if (r.mismatches !== 0) errors.push(`${route.path}: ${r.mismatches} hydration mismatch(es)`);
    if (r.adopted === 0) errors.push(`${route.path}: nothing adopted (adopted=0)`);
    if (!result.reused) {
      errors.push(`${route.path}: server root <${String(result.capturedOwner)}> was NOT reused (identity lost)`);
    }
    totalAdopted += r.adopted;
    console.log(
      `  ${route.path.padEnd(14)} mismatches=${r.mismatches} adopted=${r.adopted} `
      + `rebuilt=${r.rebuilt} inserted=${r.inserted} reused-root=${String(result.reused)}`,
    );
  }

  // adopted wiring end-to-end: the Flex page's direction flip is a server-rendered
  // button whose on:tap must be live on the ADOPTED element (screenshot-demo's
  // reactivity probe, now without a replace-mount underneath it)
  await page.goto(`http://localhost:${port}/demo/site/flex`, { waitUntil: "load" });
  await page.waitForSelector('.dsx-frame [data-dsx-owner="Flex"]', { timeout: 10_000 });
  const flip = page.getByRole("button", { name: /Flip flex-direction/ }).first();
  const before = await flip.textContent();
  await flip.click();
  await page.waitForTimeout(150);
  const after = await flip.textContent();
  if (before === after) errors.push(`adopted on:tap dead — flip label did not change (${String(before)})`);
  else console.log(`  interactivity: adopted flip button works (${String(before).trim()} -> ${String(after).trim()})`);

  if (totalAdopted === 0) errors.push("gate vacuous: zero elements adopted across the route set");
} finally {
  await browser.close();
  await close();
}

if (errors.length > 0) {
  console.error(`hydrate (${engine}): ${errors.length} failure(s) across ${ssrRoutes.length} SSR route(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`hydrate (${engine}): ${ssrRoutes.length} SSR routes adopted, mismatch=0 everywhere, server DOM reused`);
