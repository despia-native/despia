// The default Node runner has no DOM and the Firestore leg needs the official emulator.
// Keep one mandatory `npm test` while routing those assertions to the engines that can
// actually execute them. The browser boot corpus lives only in its Playwright harness; this
// exclusion contains the Firestore suite that `test:firestore` runs immediately after this
// process exits green. No assertion is dropped or replaced with a Node-only stand-in.

import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packages = join(root, "packages");
const engineOwned = new Set([
  "packages/server/test/firestore.live.test.ts",
]);

const tests: string[] = [];
for (const packageName of readdirSync(packages).sort()) {
  const testDir = join(packages, packageName, "test");
  let names: string[];
  try {
    names = readdirSync(testDir).sort();
  } catch {
    continue;
  }
  for (const name of names) {
    if (!name.endsWith(".test.ts")) continue;
    const path = join(testDir, name);
    const local = relative(root, path);
    if (!engineOwned.has(local)) tests.push(path);
  }
}

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
