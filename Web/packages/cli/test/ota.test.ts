//
//  ota.test.ts — the W5 gates, run rather than promised: `ota build` twice is byte-identical;
//  a build round-trips through a PLAIN static file server and a device-shaped fetch resolves
//  the generation (the kernel's manifest acceptance rule, mimicked here — object + file list,
//  sha verified over the actual bytes); rollback repoints to the previous generation and a
//  second rollback rolls forward again; publish is plan-by-default with the dir: row executed
//  natively and history never leaving the machine.
//

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

import { runCli, type Io } from "../src/cli.ts";
import { otaBuild, otaPublishPlan, otaRollback, readManifest, OtaError, type OtaManifest } from "../src/ota.ts";

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

function contentFixture(files: { [path: string]: string }): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-ota-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, "content", path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

const FILES = {
  "index.dsx": "<stack><text value=\"v1\"/></stack>\n",
  "screens/detail.dsx": "<stack><text value=\"detail\"/></stack>\n",
  "media/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n",
};

test("ota build: twice is byte-identical — same manifest bytes, same generation", () => {
  const fx = contentFixture(FILES);
  try {
    const first = otaBuild(join(fx.root, "content"), join(fx.root, "out"));
    const firstManifest = readFileSync(join(fx.root, "out", "manifest.json"), "utf8");
    const second = otaBuild(join(fx.root, "content"), join(fx.root, "out"));
    const secondManifest = readFileSync(join(fx.root, "out", "manifest.json"), "utf8");
    assert.equal(first.generation, second.generation);
    assert.equal(firstManifest, secondManifest);
    assert.equal(first.changed, true);   // the first build IS a new generation
    assert.equal(second.changed, false); // same bytes, same generation — said honestly
  } finally {
    fx.cleanup();
  }
});

test("ota build: the manifest is the kernel's accepted shape — object, files[], sha256 + bytes per row", () => {
  const fx = contentFixture(FILES);
  try {
    otaBuild(join(fx.root, "content"), join(fx.root, "out"));
    const manifest = readManifest(join(fx.root, "out"));
    assert.equal(manifest.format, "despia:ota@1");
    assert.deepEqual(manifest.files.map((f) => f.path), ["index.dsx", "media/logo.svg", "screens/detail.dsx"]); // sorted
    for (const f of manifest.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.bytes > 0);
    }
  } finally {
    fx.cleanup();
  }
});

test("ota build: --out inside the content directory never ingests its own output", () => {
  const fx = contentFixture(FILES);
  try {
    const content = join(fx.root, "content");
    const out = join(content, "dist-ota");
    const first = otaBuild(content, out);
    const again = otaBuild(content, out); // if the walk ingested dist-ota, this generation would differ
    assert.equal(first.generation, again.generation);
    assert.equal(readManifest(out).files.some((f) => f.path.startsWith("dist-ota/")), false);
  } finally {
    fx.cleanup();
  }
});

test("ota round-trip: a plain static server serves it and a device-shaped fetch resolves the generation", async () => {
  const fx = contentFixture(FILES);
  try {
    const out = join(fx.root, "out");
    const built = otaBuild(join(fx.root, "content"), out);

    // The dumbest possible host, on purpose: files by path, nothing else.
    const server = createServer((req, res) => {
      const path = join(out, ...(req.url ?? "/").split("/").filter((s) => s !== "" && s !== ".."));
      if (!existsSync(path)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": extname(path) === ".json" ? "application/json" : "application/octet-stream" });
      res.end(readFileSync(path));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      // The DEVICE-SHAPED resolution (Content.swift's acceptance rule + acquisition, mimicked):
      // a JSON OBJECT carrying a files array, every file fetched by path and verified against
      // its declared sha — any mismatch abandons the generation.
      const manifestRes = await fetch(`${base}/manifest.json`);
      assert.equal(manifestRes.status, 200);
      const manifest = (await manifestRes.json()) as OtaManifest;
      assert.ok(!Array.isArray(manifest) && typeof manifest === "object" && Array.isArray(manifest.files), "acceptance rule");
      for (const entry of manifest.files) {
        const fileRes = await fetch(`${base}/${entry.path}`);
        assert.equal(fileRes.status, 200, entry.path);
        const bytes = Buffer.from(await fileRes.arrayBuffer());
        assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${entry.path} verifies`);
        assert.equal(bytes.length, entry.bytes);
      }
      // the generation recomputes from what was served — the id is the content, not a counter
      const canonical = manifest.files.map((f) => `${f.path}\n${f.sha256}\n`).join("");
      assert.equal(createHash("sha256").update(canonical, "utf8").digest("hex"), built.generation);
    } finally {
      server.close();
    }
  } finally {
    fx.cleanup();
  }
});

test("ota rollback: repoints to the previous generation, restores its files, and toggles", () => {
  const fx = contentFixture(FILES);
  try {
    const content = join(fx.root, "content");
    const out = join(fx.root, "out");
    const a = otaBuild(content, out);
    const manifestA = readFileSync(join(out, "manifest.json"), "utf8");

    writeFileSync(join(content, "index.dsx"), "<stack><text value=\"v2\"/></stack>\n");
    const b = otaBuild(content, out);
    assert.notEqual(a.generation, b.generation);
    assert.ok(readFileSync(join(out, "index.dsx"), "utf8").includes("v2"));

    const back = otaRollback(out);
    assert.equal(back.from, b.generation);
    assert.equal(back.to, a.generation);
    assert.equal(readFileSync(join(out, "manifest.json"), "utf8"), manifestA); // byte-identical repoint
    assert.ok(readFileSync(join(out, "index.dsx"), "utf8").includes("v1"));   // the files came back too

    const forward = otaRollback(out); // the pointer pair is a toggle, like the device store
    assert.equal(forward.to, b.generation);
    assert.ok(readFileSync(join(out, "index.dsx"), "utf8").includes("v2"));
  } finally {
    fx.cleanup();
  }
});

test("ota rollback: refuses honestly when only one generation exists", () => {
  const fx = contentFixture(FILES);
  try {
    const out = join(fx.root, "out");
    otaBuild(join(fx.root, "content"), out);
    assert.throws(() => otaRollback(out), /no previous generation/);
  } finally {
    fx.cleanup();
  }
});

test("ota publish: dir: target copies the servable tree and NEVER the history", async () => {
  const fx = contentFixture(FILES);
  try {
    const out = join(fx.root, "out");
    otaBuild(join(fx.root, "content"), out);
    const dest = join(fx.root, "www");
    const io = capture();
    const code = await runCli(["ota", "publish", "--out", out, "--target", `dir:${dest}`, "--apply"], io);
    assert.equal(code, 0, io.errors.join("\n"));
    assert.ok(existsSync(join(dest, "manifest.json")));
    assert.ok(existsSync(join(dest, "screens", "detail.dsx")));
    assert.equal(existsSync(join(dest, ".history")), false, "history is the publisher's memory, never uploaded");
  } finally {
    fx.cleanup();
  }
});

test("ota publish: plan by default — the vendor row prints its exact command and runs nothing", async () => {
  const fx = contentFixture(FILES);
  try {
    const out = join(fx.root, "out");
    otaBuild(join(fx.root, "content"), out);
    const io = capture();
    const code = await runCli(["ota", "publish", "--out", out, "--target", "s3://bucket/dsx"], io);
    assert.equal(code, 0);
    assert.ok(io.lines.some((l) => l.includes("aws s3 sync") && l.includes("--exclude .history/*")), io.lines.join("\n"));
    assert.ok(io.lines.some((l) => l.includes("plan only")));
    const unknown = otaPublishPlan; // the table refuses what it does not know, at plan time
    assert.throws(() => unknown(out, "ftp://nope"), OtaError);
  } finally {
    fx.cleanup();
  }
});

test("ota: the CLI surface — unknown verb refused, build wired through runCli", async () => {
  const fx = contentFixture(FILES);
  try {
    const io = capture();
    const code = await runCli(
      ["ota", "build", "--in", join(fx.root, "content"), "--out", join(fx.root, "out")],
      io,
    );
    assert.equal(code, 0, io.errors.join("\n"));
    assert.ok(io.lines.some((l) => l.includes("generation ")));
    const bad = capture();
    assert.equal(await runCli(["ota", "sideways", "--out", join(fx.root, "out")], bad), 1);
    assert.ok(bad.errors.some((l) => l.includes("build | publish | rollback")));
  } finally {
    fx.cleanup();
  }
});

// ── the staged-rollout / runtimeVersion gate ────────────────────────────────────────────────
//
// F18 built the device's half of this — evaluateGeneration, corpus-pinned on three renderers —
// and nothing on either end called it: the publisher never wrote the fields and the content
// plane never read them. So every OTA reached 100% of installs with no check that the installed
// binary could run it. These cases pin the publisher half.

test("ota build: the gate is declared in the manifest, and its absence means everyone", () => {
  const fx = contentFixture(FILES);
  try {
    const plain = otaBuild(join(fx.root, "content"), join(fx.root, "out"));
    const plainManifest = readManifest(join(fx.root, "out"));
    assert.equal(plainManifest.runtimeVersion, undefined, "no flag means no constraint, not a 100% one");
    assert.equal(plainManifest.rollout, undefined);
    assert.deepEqual(plain.gate, {});

    const gated = otaBuild(join(fx.root, "content"), join(fx.root, "out2"), {
      runtimeVersion: "1.4.0",
      rolloutFraction: 0.1,
    });
    const manifest = readManifest(join(fx.root, "out2"));
    assert.equal(manifest.runtimeVersion, "1.4.0");
    assert.equal(manifest.rollout?.fraction, 0.1);
    assert.equal(manifest.rollout?.salt, gated.generation,
      "the salt defaults to the generation, so each release re-buckets rather than always canarying the same installs");
  } finally { fx.cleanup(); }
});

test("ota build: the gate is NOT part of the generation id", () => {
  const fx = contentFixture(FILES);
  try {
    const wide = otaBuild(join(fx.root, "content"), join(fx.root, "a"));
    const narrow = otaBuild(join(fx.root, "content"), join(fx.root, "b"), { rolloutFraction: 0.25 });
    assert.equal(narrow.generation, wide.generation,
      "widening a rollout must republish the SAME generation — a device that already has these bytes must not re-download them because the publisher changed its mind about who gets them");
  } finally { fx.cleanup(); }
});

test("ota build: a fraction at or above 1 emits no rollout at all", () => {
  const fx = contentFixture(FILES);
  try {
    const result = otaBuild(join(fx.root, "content"), join(fx.root, "out"), { rolloutFraction: 1 });
    assert.equal(readManifest(join(fx.root, "out")).rollout, undefined,
      "the device verdict is identical, and a manifest that says nothing is smaller and honest");
    assert.equal(result.gate.rollout, undefined, "the report says what the manifest says, never what the flag said");
  } finally { fx.cleanup(); }
});

test("ota build: the publisher refuses exactly what the device would refuse", () => {
  const fx = contentFixture(FILES);
  try {
    assert.throws(() => otaBuild(join(fx.root, "content"), join(fx.root, "out"), { runtimeVersion: ">=1.4.0" }),
      /not a version the device gate can read/,
      "a RANGE is the mistake people make here: the field is a plain minimum, and a range the device cannot parse would be a release that silently reaches nobody");
    assert.throws(() => otaBuild(join(fx.root, "content"), join(fx.root, "out"), { rolloutFraction: 1.5 }),
      /out of range/);
    assert.throws(() => otaBuild(join(fx.root, "content"), join(fx.root, "out"), { rolloutFraction: -1 }),
      /out of range/);
  } finally { fx.cleanup(); }
});

test("ota build: the device gate reads back exactly what the publisher wrote", async () => {
  const { evaluateGeneration } = await import("@despia-native/kernel");
  const fx = contentFixture(FILES);
  try {
    otaBuild(join(fx.root, "content"), join(fx.root, "out"), { runtimeVersion: "1.4.0", rolloutFraction: 0.5, rolloutSalt: "fixed" });
    const manifest = readManifest(join(fx.root, "out"));

    assert.equal(evaluateGeneration(manifest, { runtimeVersion: "1.3.0", installationId: "a" }).verdict,
      "runtime_too_old", "an install below the floor keeps what it has");
    assert.equal(evaluateGeneration(manifest, { runtimeVersion: "1.4.0", installationId: "a" }).verdict === "apply"
      || evaluateGeneration(manifest, { runtimeVersion: "1.4.0", installationId: "a" }).verdict === "rollout_excluded",
      true, "a satisfied runtime then falls to the rollout bucket, either way a decision and never a silent bypass");
    assert.equal(evaluateGeneration(manifest, { runtimeVersion: "1.4.0" }).verdict,
      "no_installation_id", "a staged rollout without an install identity refuses rather than guessing");
  } finally { fx.cleanup(); }
});
