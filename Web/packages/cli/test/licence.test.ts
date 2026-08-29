//
//  licence.test.ts — the export gate. The cases that matter are the refusals AND the free path,
//  because a gate that only knows how to say "pay us" is the one the owner explicitly forbade.
//

import test from "node:test";
import assert from "node:assert/strict";

import {
  ENTITLEMENT_FILENAME, coversApp, exportGate, splitByShelf, type Entitlement,
} from "../src/licence.ts";

const LICENCE: Entitlement = {
  appId: "com.acme.myapp", platform: "ios", majorVersion: 4, licenseId: "lic_1", variants: [],
};

test("an open-only project exports freely, forever, with no licence", () => {
  const r = exportGate({ platform: "ios", appId: "com.acme.myapp", majorVersion: 4, premium: [], entitlement: null });
  assert.equal(r.allowed, true);
  assert.equal(r.message, "", "no premium modules means the gate is not even a question");
});

test("premium without a licence refuses, and the refusal offers a FREE path", () => {
  const r = exportGate({
    platform: "ios", appId: "com.acme.myapp", majorVersion: 4,
    premium: ["core/dom", "core/revenuecat"], entitlement: null,
  });
  assert.equal(r.allowed, false);
  assert.ok(r.message.includes("core/dom, core/revenuecat"), "it names what is blocking");
  assert.ok(r.message.includes("despia.com/license?app=com.acme.myapp&platform=ios"),
    "the purchase link is pre-filled so buying is one click from the terminal");
  assert.ok(r.message.includes("despia remove core/dom core/revenuecat"),
    "THE FREE PATH: a copy-pasteable command that makes export work at no cost");
  assert.ok(r.message.includes("free, no watermark, no licence"));
});

test("a valid licence allows the export AND says premium source rides along", () => {
  const r = exportGate({
    platform: "ios", appId: "com.acme.myapp", majorVersion: 4,
    premium: ["core/dom"], entitlement: LICENCE,
  });
  assert.equal(r.allowed, true);
  assert.ok(r.note?.includes("lic_1"));
  assert.ok(r.note?.includes("includes source"), "they paid, so they own their build");
});

test("the licence does not travel: another app, another platform, another major", () => {
  const other = exportGate({ platform: "ios", appId: "com.other.app", majorVersion: 4, premium: ["core/dom"], entitlement: LICENCE });
  assert.equal(other.allowed, false);
  assert.ok(other.message.includes("not this app"));

  const android = exportGate({ platform: "android", appId: "com.acme.myapp", majorVersion: 4, premium: ["core/dom"], entitlement: LICENCE });
  assert.equal(android.allowed, false);
  assert.ok(android.message.includes("each platform is its own licence"));

  const v5 = exportGate({ platform: "ios", appId: "com.acme.myapp", majorVersion: 5, premium: ["core/dom"], entitlement: LICENCE });
  assert.equal(v5.allowed, false);
  assert.ok(v5.message.includes("a major version is a new licence"));
});

test("TestFlight child ids are covered; another customer's app never is", () => {
  for (const suffix of [".dev", ".staging", ".beta", ".internal", ".debug"]) {
    assert.ok(coversApp(LICENCE, `com.acme.myapp${suffix}`), `${suffix} is a release build of the same app`);
  }
  assert.ok(!coversApp(LICENCE, "com.rival.app.dev"));
  assert.ok(coversApp({ ...LICENCE, variants: ["com.acme.internal-build"] }, "com.acme.internal-build"));
});

test("shelf split: PREMIUM NEEDS THE EXPLICIT MARKER, so your own module is never blocked", () => {
  const split = splitByShelf([
    { id: "core/camera", manifest: { shelf: "open" } },
    { id: "core/dom", manifest: { shelf: "premium" } },
    { id: "my-own-module", manifest: {} },
  ]);
  assert.deepEqual(split.premium, ["core/dom"]);
  assert.deepEqual(split.open, ["core/camera", "my-own-module"],
    "a module with no shelf is somebody's OWN: blocking it would break the DIY-is-free deal. " +
    "This is deliberately the OPPOSITE default to Config/tiers.json, where unclassified means " +
    "'we have not decided' and giving it away is the irreversible mistake.");
});

test("the entitlement filename is the one the signer writes", () => {
  assert.equal(ENTITLEMENT_FILENAME, "despia-entitlement.json");
});

// ── the gate wired into the real command ────────────────────────────────────────────────

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli.ts";

function project(root: string, files: { [path: string]: string }): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

const BASE = {
  "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix", version: "0.1.0" }),
  "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
  "Components/App.dsx": `<stack><text value="hi"/></stack>\n`,
};

test("despia export: an OPEN-only project exports with no licence at all", async () => {
  const root = mkdtempSync(join(tmpdir(), "lic-open-"));
  try {
    project(root, {
      ...BASE,
      "Modules/Badge/dsx.json": JSON.stringify({ name: "Badge", scheme: "badge", version: "1.0.0", shelf: "open" }),
      "Modules/Badge/swift/Badge.swift": "class Badge: Module {}\n",
    });
    const err: string[] = [];
    const code = await runCli(["export", "ios", "--project", root, "--out", join(root, "out")],
      { out: () => {}, err: (l) => err.push(l) });
    assert.equal(code, 0, err.join("\n"));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("despia export: a PREMIUM module without a licence refuses, with both paths printed", async () => {
  const root = mkdtempSync(join(tmpdir(), "lic-prem-"));
  try {
    project(root, {
      ...BASE,
      "Modules/Paywall/dsx.json": JSON.stringify({ name: "Paywall", scheme: "paywall", version: "1.0.0", shelf: "premium" }),
      "Modules/Paywall/swift/Paywall.swift": "class Paywall: Module {}\n",
    });
    const err: string[] = [];
    const code = await runCli(["export", "ios", "--project", root, "--out", join(root, "out")],
      { out: () => {}, err: (l) => err.push(l) });
    const text = err.join("\n");
    assert.equal(code, 1, text);
    assert.ok(text.includes("paywall"), "names the blocking module");
    assert.ok(text.includes("despia remove paywall"), "THE FREE PATH is printed");
    assert.ok(text.includes("despia.com/license?app=com.example.fix"), "the purchase link carries the real app id");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("despia export: a matching entitlement unblocks it, and --bundle-id is what is checked", async () => {
  const root = mkdtempSync(join(tmpdir(), "lic-ok-"));
  try {
    project(root, {
      ...BASE,
      "Modules/Paywall/dsx.json": JSON.stringify({ name: "Paywall", scheme: "paywall", version: "1.0.0", shelf: "premium" }),
      "Modules/Paywall/swift/Paywall.swift": "class Paywall: Module {}\n",
      "despia-entitlement.json": JSON.stringify({
        appId: "com.acme.real", platform: "ios", majorVersion: 4, licenseId: "lic_9", variants: [],
      }),
    });
    const out: string[] = [];
    const err: string[] = [];
    const ok = await runCli(["export", "ios", "--project", root, "--out", join(root, "out"),
      "--bundle-id", "com.acme.real"], { out: (l) => out.push(l), err: (l) => err.push(l) });
    assert.equal(ok, 0, err.join("\n"));
    assert.ok(out.join("\n").includes("lic_9"), "it says the export is licensed and includes premium source");

    // the SAME entitlement under a different bundle id is refused: the licence does not travel
    const err2: string[] = [];
    const bad = await runCli(["export", "ios", "--project", root, "--out", join(root, "out2"),
      "--bundle-id", "com.acme.different"], { out: () => {}, err: (l) => err2.push(l) });
    assert.equal(bad, 1);
    assert.ok(err2.join("\n").includes("not this app"));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("despia export: A DEVELOPER'S OWN MODULE never needs a licence (the DIY-is-free deal)", async () => {
  const root = mkdtempSync(join(tmpdir(), "lic-own-"));
  try {
    project(root, {
      ...BASE,
      // No shelf, because a developer writing their own module does not know the word exists.
      "Modules/Mystery/dsx.json": JSON.stringify({ name: "Mystery", scheme: "mystery", version: "1.0.0" }),
      "Modules/Mystery/swift/Mystery.swift": "class Mystery: Module {}\n",
    });
    const err: string[] = [];
    const code = await runCli(["export", "ios", "--project", root, "--out", join(root, "out")],
      { out: () => {}, err: (l) => err.push(l) });
    assert.equal(code, 0,
      "if a developer spends a month building their own module, exporting it is free forever:\n" + err.join("\n"));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
