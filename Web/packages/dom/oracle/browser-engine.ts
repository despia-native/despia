import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserType,
} from "playwright-core";

/** Container-shipped Chromium when the Playwright-pinned build is absent.
 *  Never run `playwright install` here: the image pins an older build on purpose. */

export const BROWSER_ENGINES = ["chromium", "firefox", "webkit"] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];

export function browserEngine(value: string | undefined = process.env["DSX_BROWSER"]): BrowserEngine {
  const normalized = (value ?? "chromium").trim().toLowerCase();
  if ((BROWSER_ENGINES as readonly string[]).includes(normalized)) return normalized as BrowserEngine;
  throw new Error(
    `unsupported DSX_BROWSER ${JSON.stringify(value)}; expected ${BROWSER_ENGINES.join(", ")}`,
  );
}

export function browserType(engine: BrowserEngine): BrowserType {
  return { chromium, firefox, webkit }[engine];
}

export function browserExecutablePath(engine: BrowserEngine): string {
  return resolvedExecutable(engine) ?? browserType(engine).executablePath();
}

/* THE BROWSER A LANE ACTUALLY HAS, not the one this playwright-core would download.
   `executablePath()` names a revision directory keyed to the installed playwright-core; a
   host that provisions its browsers out-of-band (PLAYWRIGHT_BROWSERS_PATH plus
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, which is how the sandboxes here are built) carries a
   different revision, and every browser oracle then dies on a path rather than a finding.
   The order is deliberate: an explicit DSX_BROWSER_EXECUTABLE wins, then the pinned
   revision if it is really on disk, then the host's own provisioned binary. Nothing here
   loosens the pixel gate - `appearance-gate.ts` records `browserVersion` in the manifest
   and reports a mismatch AS a toolchain mismatch, so a fallback browser that renders
   differently is reported, never quietly re-baselined. */
export function resolvedExecutable(engine: BrowserEngine): string | null {
  const configured = process.env["DSX_BROWSER_EXECUTABLE"]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const pinned = (() => {
    try { return browserType(engine).executablePath(); } catch { return ""; }
  })();
  if (pinned !== "" && existsSync(pinned)) return null;
  return hostProvided(engine);
}

/** A host-provisioned binary under PLAYWRIGHT_BROWSERS_PATH, by revision, newest first. */
function hostProvided(engine: BrowserEngine): string | null {
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"]?.trim();
  if (root === undefined || root === "" || !existsSync(root)) return null;
  const shape: Record<BrowserEngine, string[]> = {
    chromium: ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"],
    firefox: ["firefox/firefox", "firefox/Nightly.app/Contents/MacOS/firefox"],
    webkit: ["pw_run.sh", "minibrowser-gtk/bin/MiniBrowser"],
  };
  const direct = join(root, engine);
  if (existsSync(direct)) return direct;
  const revisions = readdirSync(root, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith(`${engine}-`))
    .map((e) => e.name)
    .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
  for (const rev of revisions) {
    for (const tail of shape[engine]) {
      const candidate = join(root, rev, tail);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function launchBrowser(engine: BrowserEngine = browserEngine()): Promise<Browser> {
  const executablePath = resolvedExecutable(engine);
  return browserType(engine).launch(executablePath === null ? {} : { executablePath });
}
