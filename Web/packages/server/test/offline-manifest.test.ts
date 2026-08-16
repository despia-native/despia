//
//  offline-manifest.test.ts — the build-time manifest emitter (the ruby auto-compiler's TS
//  twin, bundled-floor.md): deterministic walk + sha256 + entry detection, one dialect for
//  native seeds, the native offline sync, and the web service worker.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { offlineManifest, offlineManifestText } from "@despia/server";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsx-offline-"));
  writeFileSync(join(dir, "index.html"), "<html>floor</html>");
  writeFileSync(join(dir, "app.js"), "console.log('hi')");
  mkdirSync(join(dir, "despia"), { recursive: true });
  writeFileSync(join(dir, "despia", "extra.json"), "{}");
  return dir;
}

test("emitter: sorted, sha-pinned, entry-detected — the auto-compiled seed shape", () => {
  const dir = fixture();
  try {
    const m = offlineManifest(dir);
    assert.equal(m.entry, "index.html");
    assert.deepEqual(m.assets.map((a) => a.path), ["app.js", "despia/extra.json", "index.html"]);
    const expected = createHash("sha256").update("<html>floor</html>").digest("hex");
    assert.equal(m.assets.find((a) => a.path === "index.html")?.sha256, expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("emitter: deterministic text (same tree, same bytes, same generation id)", () => {
  const dir = fixture();
  try {
    assert.equal(offlineManifestText(dir), offlineManifestText(dir));
    assert.ok(offlineManifestText(dir).endsWith("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("emitter: the include filter keeps the manifest out of its own asset list", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "despia", "local.json"), "{}");
    const m = offlineManifest(dir, { include: (rel) => rel !== "despia/local.json" });
    assert.ok(!m.assets.some((a) => a.path === "despia/local.json"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
