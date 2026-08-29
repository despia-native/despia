//
//  shot-browser.ts - launching the engine a HOST actually has.
//
//  The same resolution the browser oracles use (packages/dom/oracle/browser-engine.ts): a
//  pinned playwright revision names a directory keyed to the installed playwright-core, and a
//  host that provisions its browsers out of band (PLAYWRIGHT_BROWSERS_PATH plus
//  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, which is how CI images are built) carries a different
//  revision. Without this the shot driver dies on a path instead of producing a finding.
//
//  Duplicated rather than imported because the oracle folder is not a package export and a
//  cross-package relative import would break the cli's own build root. Kept to the chromium
//  case the shot renderer supports.
//

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Browser, chromium as Chromium } from "playwright-core";

/** playwright-core is an OPTIONAL, HEAVY capability: `dsx shot` and `dsx film` need a
 *  browser and `dsx build` must not. It is not a declared dependency of this package, and
 *  a STATIC import of it here made the whole CLI unloadable for anyone who installed it
 *  from the registry - cli.ts reaches this module through the shot/film commands, so
 *  `despia build` exited 1 before printing a thing (caught by verify-cold-start, which
 *  builds a scaffold from the packed tarballs with no monorepo on the path). Resolved on
 *  demand instead, so its absence is an honest error from the commands that need it. */
function playwright(): { chromium: typeof Chromium } | null {
  try {
    return createRequire(import.meta.url)("playwright-core") as { chromium: typeof Chromium };
  } catch {
    return null;
  }
}

const CHROMIUM_SHAPES = [
  "chrome-linux/chrome",
  "chrome-linux64/chrome",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
];

function hostProvided(): string | null {
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"]?.trim();
  if (root === undefined || root === "" || !existsSync(root)) return null;
  const direct = join(root, "chromium");
  for (const tail of CHROMIUM_SHAPES) {
    const candidate = join(direct, tail);
    if (existsSync(candidate)) return candidate;
  }
  const revisions = readdirSync(root, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith("chromium-"))
    .map((e) => e.name)
    .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
  for (const rev of revisions) {
    for (const tail of CHROMIUM_SHAPES) {
      const candidate = join(root, rev, tail);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function shotBrowserExecutable(): string | null {
  const configured = process.env["DSX_BROWSER_EXECUTABLE"]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const pinned = (() => {
    const pw = playwright();
    if (pw === null) return "";
    try { return pw.chromium.executablePath(); } catch { return ""; }
  })();
  if (pinned !== "" && existsSync(pinned)) return null;
  return hostProvided();
}

/** Chromium's own reftest determinism set. The compositor re-rasters scale-animated layers
 *  on its own schedule, and WHICH raster a capture sees is wall-time roulette - it surfaced
 *  as a handful of frames inside film camera zooms hashing differently across otherwise
 *  identical runs, each run internally stable. These flags make every capture a complete,
 *  synchronous rendering pass, which is what a deterministic pixel pipeline needs. */
const DETERMINISTIC_ARGS = [
  "--deterministic-mode",
  "--run-all-compositor-stages-before-draw",
  "--disable-checker-imaging",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
];

export async function launchShotBrowser(): Promise<Browser> {
  const pw = playwright();
  if (pw === null) {
    throw new Error("this command needs a browser: install playwright-core (npm i -D playwright-core) "
      + "or point DSX_BROWSER_EXECUTABLE at a Chromium binary");
  }
  const executablePath = shotBrowserExecutable();
  return pw.chromium.launch({
    args: DETERMINISTIC_ARGS,
    ...(executablePath === null ? {} : { executablePath }),
  });
}
