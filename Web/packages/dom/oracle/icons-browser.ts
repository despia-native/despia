// Real-engine proof that the generated icon tables actually PAINT.
//
// packages/dom/test/icons.test.ts proves coverage against the shared corpus
// (OpenSource/Conformance/icons/sf-map.json) in a fake DOM: every corpus name reaches a
// vector or a fallback rung. That cannot prove the glyph is visible — a browser silently
// renders NOTHING for a syntactically wrong path `d`, which is exactly the failure mode
// this whole seam exists to kill. So here every generated name is mounted in a real engine
// and must report a non-degenerate ink box.
//
//   npm run browser:icons                 (chromium)
//   DSX_BROWSER=webkit npm run browser:icons

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";
import { ICON_FALLBACKS, ICON_VECTORS } from "../src/icons.generated.ts";

const names = [...Object.keys(ICON_VECTORS), ...Object.keys(ICON_FALLBACKS)];

const source = String.raw`
  import { iconSvg } from "@despia-native/dom/elements";
  const host = document.createElement("div");
  host.style.cssText = "font-size:24px; color:#111; display:flex; flex-wrap:wrap; gap:4px";
  for (const name of ${JSON.stringify(names)}) {
    const cell = document.createElement("span");
    cell.dataset.icon = name;
    cell.appendChild(iconSvg(name, 24));
    host.appendChild(cell);
  }
  document.body.replaceChildren(host);
  window.__DSX_ICONS_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "icons-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("icon browser harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    // an unmapped-icon warning here means the generated table disagrees with the corpus
    if (message.type() === "error" || message.type() === "warning") {
      errors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  await page.setContent("<!doctype html><html><head><meta charset=utf-8></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_ICONS_READY__?: boolean }).__DSX_ICONS_READY__ === true);

  const measured = await page.evaluate(() => {
    const rows: Array<{ name: string; width: number; height: number; kind: string }> = [];
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>("[data-icon]"))) {
      const glyph = cell.querySelector("svg")?.firstElementChild as SVGGraphicsElement | null;
      const box = glyph === null ? null : glyph.getBBox();
      rows.push({
        name: cell.dataset["icon"] ?? "",
        width: box?.width ?? 0,
        height: box?.height ?? 0,
        kind: glyph?.tagName ?? "none",
      });
    }
    return rows;
  });

  if (measured.length !== names.length) {
    errors.push(`mounted ${measured.length} icons, expected ${names.length}`);
  }
  for (const row of measured) {
    if (row.kind !== "path" && row.kind !== "text") {
      errors.push(`${row.name}: unexpected glyph node <${row.kind}>`);
      continue;
    }
    // A malformed path parses to an EMPTY geometry and measures 0x0 — the silent failure
    // this gate hunts. One axis may legitimately be 0 (`minus` is a horizontal rule, and
    // getBBox excludes stroke width), so the test is: real extent on at least one axis.
    if (Math.max(row.width, row.height) < 4) {
      errors.push(`${row.name}: <${row.kind}> painted a degenerate ${row.width}x${row.height} box`);
    }
  }
} finally {
  await browser.close();
}

if (errors.length > 0) {
  console.error(`icon oracle [${engine}]: ${errors.length} failure(s)`);
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exitCode = 1;
} else {
  console.log(`icon oracle [${engine}]: ${names.length}/${names.length} generated glyphs paint a real box`);
}
