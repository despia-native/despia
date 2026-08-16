import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSER_ENGINES,
  browserExecutablePath,
} from "../packages/dom/oracle/browser-engine.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(engine: string, args: string[]): void {
  const result = spawnSync(process.execPath, args, {
    cwd: webRoot,
    env: { ...process.env, DSX_BROWSER: engine },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${engine}: ${args.join(" ")} failed with exit ${String(result.status)}`);
  }
}

for (const engine of BROWSER_ENGINES) {
  const executable = browserExecutablePath(engine);
  if (!existsSync(executable)) {
    throw new Error(
      `${engine}: locked Playwright executable is missing at ${executable}; ` +
      "run `node node_modules/playwright-core/cli.js install chromium firefox webkit`",
    );
  }
  console.log(`\n[browser:matrix] ${engine} -> ${executable}`);
  run(engine, ["packages/dom/oracle/run.ts"]);
  run(engine, [
    "packages/dom/oracle/screenshot-demo.ts",
    join(webRoot, "demo", "shots", engine),
  ]);
  run(engine, ["packages/dom/oracle/demo-production.ts"]);
  run(engine, ["packages/dom/oracle/icons-browser.ts"]);
  run(engine, ["packages/dom/oracle/forms-browser.ts"]);
  run(engine, ["packages/dom/oracle/native-controls-browser.ts"]);
  run(engine, ["packages/dom/oracle/fixture-controls-browser.ts"]);
  run(engine, ["packages/dom/oracle/overlay-controls-browser.ts"]);
  run(engine, ["packages/dom/oracle/data-controls-browser.ts"]);
  run(engine, ["packages/dom/oracle/application-controls-browser.ts"]);
  run(engine, ["packages/dom/oracle/media-surfaces-browser.ts"]);
  run(engine, ["packages/dom/oracle/input-browser.ts"]);
  run(engine, ["packages/dom/oracle/game-browser.ts"]);
  run(engine, ["packages/dom/oracle/sprites-browser.ts"]);
  run(engine, ["packages/dom/oracle/playthrough-browser.ts"]);
  run(engine, ["packages/dom/oracle/structural-bound-browser.ts"]);
  run(engine, ["packages/dom/oracle/scroll-restoration-browser.ts"]);
  run(engine, ["packages/dom/oracle/editor-element-smoke.ts"]);
}

console.log(`\n[browser:matrix] PASS: ${BROWSER_ENGINES.join(", ")}`);
