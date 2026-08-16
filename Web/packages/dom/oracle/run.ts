//
//  run.ts - the layout oracle, browser leg (/web/06: "the Taffy conformance fixtures
//  become the cross-renderer parity gate"). Each fixture in
//  ClosedSource/scripts/dsxcss/fixtures/*.json renders as a plain CSS tree in headless
//  the selected locked Playwright engine; child rects (relative to the root) must
//  match `expect` within 0.5px. Taffy (native) and Chromium/Firefox/WebKit (web)
//  answering identically is what makes "same layout on every renderer" a MEASURED
//  claim, not a hope.
//

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

type Fixture = {
  name: string;
  viewport: { width: number; height: number };
  tree: FixtureNode;
  expect: { [path: string]: [number, number, number, number] };
};
type FixtureNode = { style: { [k: string]: string }; children?: FixtureNode[] };

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const fixturesDir = join(repoRoot(), "ClosedSource/scripts/dsxcss/fixtures");
const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) throw new Error(`no fixtures in ${fixturesDir}`);

const engine = browserEngine();
const browser = await launchBrowser(engine);
let failures = 0;

try {
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf-8")) as Fixture;
    const page = await browser.newPage({ viewport: fixture.viewport });
    const html = (node: FixtureNode, path: string): string => {
      const style = Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join("; ");
      const kids = (node.children ?? []).map((c, i) => html(c, path === "" ? String(i) : `${path}.${i}`)).join("");
      return `<div data-path="${path}" style="${style}">${kids}</div>`;
    };
    await page.setContent(
      `<!doctype html><html><head><style>
         * { margin: 0; padding: 0; box-sizing: border-box; }
         [data-path=""] { position: relative; }
       </style></head><body>${html(fixture.tree, "")}</body></html>`,
      { waitUntil: "load" },
    );
    const rects = await page.evaluate(() => {
      const root = document.querySelector('[data-path=""]')!;
      const origin = root.getBoundingClientRect();
      const out: { [path: string]: [number, number, number, number] } = {};
      for (const el of document.querySelectorAll("[data-path]")) {
        const r = el.getBoundingClientRect();
        out[el.getAttribute("data-path")!] = [r.x - origin.x, r.y - origin.y, r.width, r.height];
      }
      return out;
    });
    let ok = true;
    for (const [path, want] of Object.entries(fixture.expect)) {
      const got = rects[path];
      if (!got) { console.error(`  ✗ ${file} [${path}]: node missing`); ok = false; continue; }
      const delta = want.map((w, i) => Math.abs(w - got[i]!));
      if (delta.some((d) => d > 0.5)) {
        console.error(`  ✗ ${file} [${path}]: want [${want.join(", ")}] got [${got.map((g) => g.toFixed(1)).join(", ")}]`);
        ok = false;
      }
    }
    console.log(`${ok ? "✓" : "✗"} [${engine}] ${file} — ${fixture.name}`);
    if (!ok) failures += 1;
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures}/${files.length} fixtures diverged`);
  process.exit(1);
}
console.log(`\nlayout oracle [${engine}]: ${files.length}/${files.length} fixtures agree with the reference`);
