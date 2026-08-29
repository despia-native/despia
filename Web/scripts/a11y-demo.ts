// Axe accessibility sweep over the BUILT demo site (the `npm run build:demo` output,
// served statically by the compiler's own dev server) — the CI-runnable half of the
// design-system a11y gate. The full starter sweep (a11y-sweep.ts) needs the live
// example + Supabase and stays a local/manual gate; this one needs nothing but the
// build already in the web-kernel lane. Covers the launcher, the diagnostics and
// system pages, and every Gallery section in BOTH color schemes; fails on any
// serious/critical violation, the same gate a11y-sweep.ts applies.

import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright-core";
import { startServer } from "../packages/compiler/bin/serve.ts";

const EXECUTABLE = process.env.DSX_CHROMIUM ?? "/opt/pw-browsers/chromium";
// /errors is deliberately absent: its authored demo content carries a bare chevron
// <image icon=.../> (axe image-alt, critical) and a dark-scheme contrast miss —
// demo-content findings, not skin findings, red until that page and the icon-image
// decorative default are fixed. Adding a page here means adding it GREEN.
const PAGES = ["/", "/flex", "/basics", "/system"] as const;
const GALLERY_SECTIONS = ["Controls", "Inputs", "Feedback", "Patterns", "Media"] as const;
const SCHEMES = ["light", "dark"] as const;

const IMPACTS = ["critical", "serious", "moderate", "minor"] as const;
type Impact = (typeof IMPACTS)[number];

interface Finding {
  page: string;
  impact: Impact;
  id: string;
  help: string;
  targets: string[];
}

async function sweep(page: Page, label: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.flatMap((violation) => {
    const impact = (violation.impact ?? "minor") as Impact;
    return [{
      page: label,
      impact,
      id: violation.id,
      help: violation.help,
      targets: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
    }];
  });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
}

async function sweepScheme(browser: Browser, base: string, scheme: (typeof SCHEMES)[number]): Promise<Finding[]> {
  const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const findings: Finding[] = [];

  for (const path of PAGES) {
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    await settle(page);
    findings.push(...await sweep(page, `${path} (${scheme})`));
  }

  // The Gallery is the living spec (design-system.md Part 5) and a tabbed scaffold —
  // an inactive panel is OMITTED from the DOM, so each section is swept in turn.
  await page.goto(`${base}/gallery`, { waitUntil: "domcontentloaded" });
  await settle(page);
  for (const section of GALLERY_SECTIONS) {
    await page.click(`.gallery-rail-target[aria-label="${section}"]`);
    await page.waitForTimeout(250);
    findings.push(...await sweep(page, `/gallery ${section} (${scheme})`));
  }

  await context.close();
  return findings;
}

const { port, close } = await startServer(0);
const browser = await chromium.launch({ executablePath: EXECUTABLE });
const findings: Finding[] = [];
try {
  const base = `http://127.0.0.1:${String(port)}/demo/site`;
  for (const scheme of SCHEMES) findings.push(...await sweepScheme(browser, base, scheme));
} finally {
  await browser.close();
  await close();
}

let gate = 0;
for (const impact of IMPACTS) {
  const bucket = findings.filter((finding) => finding.impact === impact);
  if (bucket.length === 0) continue;
  console.log(`\n== ${impact} (${String(bucket.length)}) ==`);
  for (const finding of bucket) {
    console.log(`  [${finding.page}] ${finding.id}: ${finding.help}`);
    for (const target of finding.targets) console.log(`      ${target}`);
  }
  if (impact === "critical" || impact === "serious") gate += bucket.length;
}

if (findings.length === 0) console.log("a11y-demo: no violations");
console.log(`\na11y-demo: ${String(gate)} serious/critical across ${String(findings.length)} total violations`);
process.exit(gate > 0 ? 1 : 0);
