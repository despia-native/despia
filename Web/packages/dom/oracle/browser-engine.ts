import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserType,
} from "playwright-core";

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
  return browserType(engine).executablePath();
}

export async function launchBrowser(engine: BrowserEngine = browserEngine()): Promise<Browser> {
  const configured = process.env["DSX_BROWSER_EXECUTABLE"]?.trim();
  return browserType(engine).launch(configured ? { executablePath: configured } : {});
}
