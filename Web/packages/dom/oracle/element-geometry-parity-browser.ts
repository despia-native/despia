//
//  element-geometry-parity-browser.ts - the MEASURING leg of the element contract's geometry gate
//  (runtime-pressure.md R23). The ledger, the harness documents and the reasons live next door in
//  element-geometry-parity.ts; this file mounts each harness in the locked Playwright engine and
//  runs each probe against the real, laid-out box.
//
//  Usage:  node packages/dom/oracle/element-geometry-parity-browser.ts
//          node packages/dom/oracle/element-geometry-parity-browser.ts --report   (print every row)
//
//  HOW IT FAILS, which is the only interesting part of a gate:
//    - an `assert` key whose measurement differs from the reference by more than its tolerance,
//    - a `drift`/`adapt` key whose measurement moved off its PINNED web value (the divergence is
//      allowed to exist, not to grow),
//    - a probe that cannot find its target (null), which is a broken probe, never a pass,
//    - a corpus key with no ledger entry at all.
//  Every drift and every adaptation is PRINTED on every run, green or red, so the allowlist is a
//  visible bill rather than a quiet exemption.
//

import { buildSync } from "esbuild";
import type { Page } from "playwright-core";

import { browserEngine, launchBrowser } from "./browser-engine.ts";
import { CASES, LEDGER, MEASUREMENT_CONTEXT, census, geometryKeys } from "./element-geometry-parity.ts";

const report = process.argv.includes("--report");

const entrySource = `
  import { compileComponent } from "@despia-native/compiler/component";
  import { LAYER_STATEMENT } from "@despia-native/compiler/cssmap";
  import { instantiate } from "@despia-native/dom/mount";
  import {
    TOKENS_CSS, APPLICATION_ELEMENTS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS,
  } from "@despia-native/dom/theme";
  import { FORM_ELEMENTS, FORM_ELEMENTS_CSS } from "@despia-native/dom/forms";
  import { ELEMENTS, registerGlobalElements, registerRichElements } from "@despia-native/dom/elements";
  import { NATIVE_CONTROLS_CSS, registerNativeControls } from "@despia-native/dom/native-controls";
  import { STRUCTURAL_CONTROLS_CSS, registerStructuralControls } from "@despia-native/dom/structural-controls";
  import { OVERLAY_CONTROLS_CSS, registerOverlayControls } from "@despia-native/dom/overlay-controls";
  import { DATA_CONTROLS_CSS, registerDataControls } from "@despia-native/dom/data-controls";
  import { APPLICATION_CONTROLS_CSS, registerApplicationControls } from "@despia-native/dom/application-controls";
  import { registerElementMotion } from "@despia-native/dom/element-motion";
  import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "@despia-native/dom/globals";

  Object.assign(ELEMENTS, FORM_ELEMENTS);
  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();
  registerNativeControls();
  registerElementMotion();
  registerStructuralControls();
  registerOverlayControls();
  registerDataControls();
  registerApplicationControls();

  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, APPLICATION_ELEMENTS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS,
    FORM_ELEMENTS_CSS, RICH_ELEMENTS_CSS, NATIVE_CONTROLS_CSS, STRUCTURAL_CONTROLS_CSS,
    OVERLAY_CONTROLS_CSS, DATA_CONTROLS_CSS, APPLICATION_CONTROLS_CSS, GLOBAL_ELEMENTS_CSS,
    "body { margin: 0; }",
    // The harness host is a plain full-width block so it contributes no spacing of its own to
    // any measurement: no padding, no gap, no max-width.
    ".dsx-probe-host { display: block; width: 100%; padding: 0; margin: 0; }",
  ].join("\\n");
  document.head.appendChild(style);

  const CASES = __CASES__;
  const live = new Map();
  const build = (entry) => {
    const host = document.querySelector('[data-probe-case="' + entry.id + '"]');
    const ir = compileComponent("Probe_" + entry.id, "probe", entry.markup);
    const registry = { components: { ["probe.Probe_" + entry.id]: ir }, globalPool: {}, css: "", schemes: [] };
    const instance = instantiate(ir, registry);
    host.replaceChildren(instance.root);
    live.set(entry.id, instance);
  };
  for (const entry of CASES) {
    const host = document.createElement("div");
    host.className = "dsx-probe-host";
    host.setAttribute("data-probe-case", entry.id);
    document.body.appendChild(host);
    build(entry);
  }
  window.__dsxProbeRemount = (id) => {
    const instance = live.get(id);
    if (instance !== undefined) instance.ctx.disposers.forEach((d) => d());
    build(CASES.find((c) => c.id === id));
  };
  window.__DSX_PROBE_READY__ = true;
`.replace("__CASES__", JSON.stringify(CASES));

const bundle = buildSync({
  stdin: { contents: entrySource, loader: "ts", resolveDir: process.cwd(), sourcefile: "element-geometry-parity-entry.ts" },
  bundle: true, write: false, format: "iife", target: "es2022", logLevel: "silent",
}).outputFiles[0]?.text;
if (bundle === undefined) throw new Error("the geometry probe harness did not bundle");

/** Probes whose answer is an INTERACTION, not a static box. Each one drives the real control and
 *  returns the number the fixture names, so a threshold or a press treatment that quietly stops
 *  existing turns the run red instead of going unnoticed. */
const INTERACTIONS: { [where: string]: (page: Page) => Promise<number | null> } = {
  /** Bisect the drag distance that dismisses the drawer: drag the handle by d, ask whether the
   *  panel is gone, remount, repeat. 8 rounds over [0, 512] pins the threshold to 2px. */
  "Drawer.dismissThreshold": async (page) => {
    const dragged = async (distance: number): Promise<boolean> => {
      await page.evaluate(() => {
        (window as unknown as { __dsxProbeRemount: (id: string) => void }).__dsxProbeRemount("drawer");
      });
      await page.waitForTimeout(80);
      const handle = page.locator(".dsx-drawer-handle");
      const box = await handle.boundingBox();
      if (box === null) return false;
      const x = box.x + (box.width / 2);
      const y = box.y + (box.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + distance, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(120);
      return await page.locator(".dsx-drawer-panel").count() === 0
        || await page.locator(".dsx-drawer-layer").evaluate((el) => (el as HTMLElement).hidden) === true;
    };
    let low = 0;
    let high = 512;
    if (!await dragged(high)) return null;
    for (let round = 0; round < 8; round += 1) {
      const mid = Math.round((low + high) / 2);
      if (await dragged(mid)) high = mid; else low = mid;
    }
    return low;
  },
  /** Hold the labelled button down and read the scale actually applied to it. */
  "button.pressScale": async (page) => {
    const button = page.locator('[data-probe-case="button"] .dsx-button').nth(1);
    const box = await button.boundingBox();
    if (box === null) return null;
    await page.mouse.move(box.x + (box.width / 2), box.y + (box.height / 2));
    await page.mouse.down();
    await page.waitForTimeout(220);
    const scale = await button.evaluate((el) => {
      const t = getComputedStyle(el).transform;
      const m = new DOMMatrixReadOnly(t === "none" ? "" : t);
      return Math.hypot(m.a, m.b);
    });
    await page.mouse.up();
    return scale;
  },
};

/** Page-side preparation a case needs before its probes can see the state they measure. */
const SETUP: { [caseId: string]: (page: Page) => Promise<void> } = {
  // The active digit box only exists while the field holds focus - that IS the active state.
  otp: async (page) => {
    await page.locator('[data-probe-case="otp"] .dsx-otp-input').focus();
    await page.waitForTimeout(60);
  },
};

const engine = browserEngine();
const browser = await launchBrowser(engine);
const failures: string[] = [];
const rows: string[] = [];
let asserted = 0;
let pinned = 0;

try {
  const page = await browser.newPage({
    viewport: { ...MEASUREMENT_CONTEXT.viewport },
    deviceScaleFactor: MEASUREMENT_CONTEXT.deviceScaleFactor,
    hasTouch: MEASUREMENT_CONTEXT.hasTouch,
    isMobile: MEASUREMENT_CONTEXT.isMobile,
    colorScheme: MEASUREMENT_CONTEXT.colorScheme,
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console.error: ${message.text()}`);
  });
  await page.setContent(
    "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>",
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(
    () => (window as unknown as { __DSX_PROBE_READY__?: boolean }).__DSX_PROBE_READY__ === true,
  );
  // Enter animations (the drawer's rise) and state transitions (the accordion chevron) settle
  // before anything is measured; a mid-transition rect is not a contract.
  await page.waitForTimeout(900);

  // A phone reference measured against a desktop skin would manufacture drift that is really a
  // designed adaptation, so the context is asserted rather than assumed.
  const pointer = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    hoverless: matchMedia("(hover: none)").matches,
    width: window.innerWidth,
  }));
  if (!pointer.coarse || !pointer.hoverless || pointer.width !== MEASUREMENT_CONTEXT.viewport.width) {
    failures.push(
      `the measurement context is not the phone this corpus was extracted from: `
      + `pointer coarse=${pointer.coarse}, hover none=${pointer.hoverless}, width=${pointer.width}`,
    );
  }

  for (const caseId of Object.keys(SETUP)) await SETUP[caseId]!(page);

  for (const { where, value, src } of geometryKeys()) {
    const entry = LEDGER[where];
    if (entry === undefined) { failures.push(`${where}: no ledger entry`); continue; }
    if (entry.kind === "absent") {
      if (report) rows.push(`  ·  ${where.padEnd(34)} not measurable here - ${entry.note}`);
      continue;
    }
    if (value === null) { failures.push(`${where}: the fixture value is not a number`); continue; }

    const interaction = INTERACTIONS[where];
    let measured: number | null;
    if (entry.measure === null) {
      if (interaction === undefined) {
        failures.push(`${where}: the ledger declares an interaction probe and the runner has none`);
        continue;
      }
      measured = await interaction(page);
    } else {
      measured = await page.evaluate(({ src: fnSource, id }) => {
        const host = document.querySelector(`[data-probe-case="${id}"]`);
        if (host === null) return null;
        const fn = (0, eval)(`(${fnSource})`) as (root: HTMLElement) => number | null;
        const out = fn(host as HTMLElement);
        return typeof out === "number" && Number.isFinite(out) ? out : null;
      }, { src: entry.measure.toString(), id: entry.case });
    }

    if (measured === null) {
      failures.push(`${where}: the probe found nothing to measure (${entry.probe}) - a broken probe is not a pass`);
      continue;
    }
    const round = (n: number): string => String(Math.round(n * 10000) / 10000);
    const tol = entry.tol ?? 0.05;

    if (entry.kind === "assert") {
      asserted += 1;
      if (Math.abs(measured - value) > tol) {
        failures.push(
          `${where}: reference ${value}, web ${round(measured)}\n      probe: ${entry.probe}\n      _src: ${src}`,
        );
      } else if (report) {
        rows.push(`  ok ${where.padEnd(34)} ${round(measured)} == ${value}`);
      }
      continue;
    }

    pinned += 1;
    const label = entry.kind === "drift" ? "DRIFT" : "ADAPT";
    rows.push(`  ${label} ${where.padEnd(32)} reference ${value}, web ${round(measured)} - ${entry.note}`);
    if (Math.abs(measured - entry.web) > tol) {
      failures.push(
        `${where}: this divergence is pinned at web ${entry.web} and the web value is now ${round(measured)}. `
        + `The web renderer moved; re-pin it deliberately, or - if it now agrees with the reference `
        + `${value} - promote the entry to kind "assert".`,
      );
    }
  }
} finally {
  await browser.close();
}

const numbers = census();
if (numbers.unclassified.length > 0) {
  failures.push(`corpus geometry keys with no ledger entry: ${numbers.unclassified.join(", ")}`);
}
if (numbers.stale.length > 0) {
  failures.push(`ledger entries naming keys the corpus no longer has: ${numbers.stale.join(", ")}`);
}

console.log(`\n── ELEMENT GEOMETRY PARITY [${engine}] ── ${MEASUREMENT_CONTEXT.viewport.width}x${MEASUREMENT_CONTEXT.viewport.height}, coarse pointer\n`);
for (const row of rows) console.log(row);
console.log(
  `\n  ${numbers.asserted} asserted · ${numbers.allowlisted} allowlisted with a reason `
  + `(${numbers.drift} measured drift, ${numbers.adapt} deliberate adaptation) · ${numbers.absent} not measurable here`
  + `\n  of ${numbers.total} geometry keys in OpenSource/Conformance/elements`
  + `\n  ${asserted} assertions and ${pinned} pins ran in the browser this pass`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} geometry parity violation(s):\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("\n  no element geometry moved.\n");
