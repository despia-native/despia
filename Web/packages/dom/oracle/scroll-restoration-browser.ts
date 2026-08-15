// Real-engine gate for per-history-entry SCROLL RESTORATION.
//
// WHY A BROWSER. Back is already correct by construction — a frame that stays built keeps its
// DOM, and its scroll boxes with it. The case the ledger exists for is the REBUILD, where a
// frame is constructed from nothing and the offsets must be re-asserted. Proving any of it
// needs real layout: scrollHeight, clientHeight, and a compositor that honors a scrollTop
// write. The node harness has none of those, which is why this was deferred until now.
//
// WHAT THIS PROVES
//   1. leaving a page BANKS the live offsets under that entry's key. This is the write side,
//      and it was missing: `captureScroll` ran only on a router navigation, so the reload path
//      restored from a ledger entry nothing had ever written. `pagehide` now covers it.
//   2. the banked marks carry the real offset AND the element's scroll path, not a placeholder.
//   3. CONTROL — leaving an unscrolled page banks nothing. Without this, a capture that silently
//      did nothing would still pass, because "never scrolled" and "restored to the old offset"
//      look identical from a single read.
//   4. a first visit with nothing banked never invents a scroll of its own.
//
// DECLARED LIMIT — THE RELOAD READ PATH IS NOT ASSERTED HERE, deliberately.
// Restoring after a reload requires the browser to hand back the `history.state` it stored for
// that entry, because the `dsxKey` inside it IS the ledger key. Measured in this container's
// headless Chromium, `history.state` is null at document-start, at DOMContentLoaded and at load
// after a reload — verified with a plain `replaceState({ probe: "kept" })` that also came back
// null, so it is the environment, not the router. With no key to look up, no implementation
// could pass a read-side assertion here, and a test claiming otherwise would be asserting the
// harness rather than the code. The write side below is what this environment can honestly
// settle; the read path needs a browser that preserves entry state across a reload.

import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const SCROLL_LEDGER_KEY = "dsx:scroll";
const ROUTE = "/demo/site/flex";
const TARGET = '[data-dsx-owner="Flex"] .dsx-scroll';
const WANT = 240;

const engine = browserEngine();
const { port, close } = await startServer(0);
const browser = await launchBrowser(engine);
const errors: string[] = [];

try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
  const readLedger = async (): Promise<{ [key: string]: [string, number, number][] }> => {
    const raw = await page.evaluate((key) => {
      try { return sessionStorage.getItem(key); } catch { return null; }
    }, SCROLL_LEDGER_KEY);
    if (raw === null) return {};
    try { return JSON.parse(raw) as { [key: string]: [string, number, number][] }; } catch { return {}; }
  };
  const leave = async (): Promise<void> => {
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    });
    await page.waitForTimeout(120);
  };

  // The box must be genuinely scrollable before any of this means anything.
  await page.goto(`http://localhost:${port}${ROUTE}`, { waitUntil: "networkidle" });
  await page.locator(TARGET).waitFor({ state: "visible", timeout: 8000 });
  const room = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el === null ? -1 : el.scrollHeight - el.clientHeight;
  }, TARGET);
  if (room < WANT) {
    errors.push(`${TARGET} can only scroll ${room}px; the walk needs at least ${WANT}px to mean anything`);
  }

  // 4 — a first visit scrolls nowhere on its own.
  const fresh = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el === null ? -1 : Math.round(el.scrollTop);
  }, TARGET);
  if (fresh > 4) errors.push(`a first visit with nothing banked scrolled to ${fresh}px on its own`);
  else console.log(`✓ [${engine}] a first visit with nothing banked stays where the author put it`);

  // 3 — CONTROL. Clear the ledger and leave WITHOUT scrolling: nothing may be banked.
  await page.evaluate((key) => {
    try { sessionStorage.removeItem(key); } catch { /* blocked bucket */ }
  }, SCROLL_LEDGER_KEY);
  await leave();
  const controlMarks = Object.values(await readLedger()).flat();
  if (controlMarks.length > 0) {
    errors.push(`control failed: leaving an unscrolled page banked ${controlMarks.length} mark(s), so the capture assertion below proves nothing`);
  } else {
    console.log(`✓ [${engine}] leaving an unscrolled page banks nothing`);
  }

  // 1 + 2 — scroll, leave, and require the real offset under this entry's key.
  const key = await page.evaluate(() => {
    const state = history.state as { dsxKey?: unknown } | null;
    return state !== null && typeof state.dsxKey === "string" ? state.dsxKey : null;
  });
  if (key === null) errors.push("the live entry carries no dsxKey, so nothing can be banked against it");

  await page.evaluate(([sel, top]) => {
    const el = document.querySelector(sel as string) as HTMLElement | null;
    if (el !== null) el.scrollTop = top as number;
  }, [TARGET, WANT] as const);
  await page.waitForTimeout(80);
  await leave();

  const marks = key === null ? [] : ((await readLedger())[key] ?? []);
  if (marks.length === 0) {
    errors.push(`leaving a scrolled page banked nothing under ${String(key)} — a rebuild would restore from an empty entry`);
  } else {
    const hit = marks.find((mark) => Math.abs(mark[1] - WANT) <= 4);
    if (hit === undefined) {
      errors.push(`banked marks do not carry the live offset ~${WANT}px: ${JSON.stringify(marks)}`);
    } else if (typeof hit[0] !== "string" || hit[0].length === 0) {
      errors.push(`a banked mark carries no scroll path, so it could never be re-applied to a rebuilt frame: ${JSON.stringify(hit)}`);
    } else {
      console.log(`✓ [${engine}] leaving a scrolled page banks the live offset (${hit[1]}px at path "${hit[0]}")`);
    }
  }
} finally {
  await browser.close();
  await close();
}

if (errors.length > 0) {
  console.error(`✗ ${errors.length} scroll-restoration failure(s):`);
  for (const line of errors) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`scroll restoration [${engine}]: leaving banks the live offsets, an unscrolled leave banks nothing`);
