// Axe accessibility sweep over the running starter app (worker/local.ts on :8788).
// Covers the public pages and the signed-in notes surface; fails on serious/critical.

import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "playwright-core";

const BASE = process.env.A11Y_BASE ?? "http://127.0.0.1:8788";
const EXECUTABLE = process.env.DSX_CHROMIUM ?? "/opt/pw-browsers/chromium";
const PROBE_EMAIL = "probe-a@despia-example.test";
const PROBE_PASSWORD = "Probe-Password-A1";

const IMPACTS = ["critical", "serious", "moderate", "minor"] as const;
type Impact = (typeof IMPACTS)[number];

interface Finding {
  page: string;
  impact: Impact;
  id: string;
  help: string;
  targets: string[];
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2500);
}

/** Hydration can clobber early keystrokes; fill, verify the value stuck, retry. */
async function fillSticky(page: Page, selector: string, value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.fill(selector, value);
    await page.waitForTimeout(300);
    if ((await page.inputValue(selector)) === value) return;
  }
  throw new Error(`fill did not stick: ${selector}`);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/signin`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await fillSticky(page, 'input[name="email"]', PROBE_EMAIL);
  await fillSticky(page, 'input[name="password"]', PROBE_PASSWORD);
  await page.click("button.dsx-form-submit");
  await page.waitForURL("**/notes", { timeout: 15_000 });
  // Full load of the gated page with the auth cookie now in the context: the analyzed
  // state is the canonical signed-in /notes document, not a mid-transition stack.
  await page.goto(`${BASE}/notes`, { waitUntil: "domcontentloaded" });
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

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const context = await browser.newContext();
const page = await context.newPage();
const findings: Finding[] = [];

for (const path of ["/", "/signin"]) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await settle(page);
  findings.push(...await sweep(page, path));
}

await signIn(page);
await settle(page);
findings.push(...await sweep(page, "/notes (signed in)"));

await browser.close();

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

if (findings.length === 0) console.log("a11y-sweep: no violations");
console.log(`\na11y-sweep: ${String(gate)} serious/critical across ${String(findings.length)} total violations`);
process.exit(gate > 0 ? 1 : 0);
