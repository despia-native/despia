// Execute the portability corpus against Google's official Firestore emulator. The CLI version
// is pinned and fetched into npm's external cache, so it never enters this package's dependency
// graph or audit surface. The emulator writes its diagnostic log into the disposable directory,
// keeping a test run from dirtying the repository.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "dsx-firestore-emulator-"));
const config = join(root, "packages", "server", "deploy", "firebase", "firebase.json");
const testFile = join(root, "packages", "server", "test", "firestore.live.test.ts");
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const command = `${quote(process.execPath)} --test --test-concurrency=1 ${quote(testFile)}`;
const executable = process.platform === "win32" ? "npx.cmd" : "npx";

let status = 1;
try {
  const result = spawnSync(executable, [
    "--yes", "firebase-tools@15.26.0",
    "--config", config,
    "--project", "dsx-portability",
    "emulators:exec",
    "--only", "firestore",
    "--log-verbosity", "QUIET",
    command,
  ], {
    cwd: scratch,
    env: {
      ...process.env,
      DSX_TEST_FIRESTORE_URL: "http://127.0.0.1:8080/v1",
      DSX_TEST_FIRESTORE_PROJECT: "dsx-portability",
    },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  status = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
