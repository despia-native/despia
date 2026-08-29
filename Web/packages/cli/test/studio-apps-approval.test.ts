//
//  The approval-signature corpus, TS runner (studio-apps.md §11): canonical bytes, the
//  deterministic Ed25519 round-trip, and every tamper case. The ruby twin is
//  ClosedSource/scripts/sign_app_approval.rb --self-test — two implementations, one corpus.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  approvalCanonicalBytes, approvalFile, readVerifiedApprovals, signApproval, verifyApproval,
  type AppApproval,
} from "../src/studio-apps/approval.ts";
import { readAppManifest } from "../src/studio-apps/manifest.ts";
import { resolveStudioApps, type DiscoveredApp } from "../src/studio-apps/host.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance/studio-apps/approval.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("approval.json not found");
    dir = parent;
  }
}

const corpus = JSON.parse(readFileSync(join(repoRoot(), "OpenSource/Conformance/studio-apps/approval.json"), "utf8")) as {
  keys: { privateKeyPem: string; publicKeyPem: string; keyId: string };
  canonical: string;
  record: AppApproval & { signature: string };
  cases: Array<{ name: string; tamper: Record<string, unknown> | null; expect: { ok: boolean } }>;
};

test("approval: the canonical bytes match the corpus pin exactly", () => {
  assert.equal(approvalCanonicalBytes(corpus.record), corpus.canonical);
});

test("approval: Ed25519 is deterministic — signing the record reproduces the corpus signature byte for byte", () => {
  const signed = signApproval({ ...corpus.record, signature: undefined } as AppApproval, corpus.keys.privateKeyPem);
  assert.equal(signed.signature, corpus.record.signature,
    "a signature drift here is a canonicalization drift — the exact defect the corpus exists to catch");
});

for (const c of corpus.cases) {
  test(`approval: ${c.name}`, () => {
    const record = { ...corpus.record, ...(c.tamper ?? {}) } as AppApproval;
    assert.equal(verifyApproval(record, corpus.keys.publicKeyPem).ok, c.expect.ok);
  });
}

// ── the chain: a laid-down approval admits an installed app through the fold ───────────

function installedFixture(): { root: string; app: DiscoveredApp; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-approval-"));
  const manifest = {
    name: "CopyStudio", scheme: "copystudio", version: "1.2.0", studioApi: 1,
    facets: { apps: { panel: {
      slot: "studio.rail", component: "Components/Panel.dsx", title: "Copy", icon: "text.badge.star",
      grants: ["project:read"],
    } } },
  };
  const dir = join(root, "cache", "copystudio");
  mkdirSync(join(dir, "Components"), { recursive: true });
  writeFileSync(join(dir, "dsx.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "Components", "Panel.dsx"), "<stack/>\n");
  writeFileSync(join(root, "dsx.lock.json"), JSON.stringify({
    version: 1,
    modules: { "github:acme/copy-studio": { version: "1.2.0", source: "github:acme/copy-studio", resolved: "abc", sha256: "sha256-feedface" } },
  }));
  const { info } = readAppManifest(manifest);
  const app: DiscoveredApp = { kind: "installed", dir, info: info!, lockId: "github:acme/copy-studio" };
  return { root, app, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("approval: the full chain — signed + pin-matched admits; each broken link holds with its reason", () => {
  const fx = installedFixture();
  try {
    const state = { copystudio: { enabled: true, version: "1.2.0", grants: ["project:read"], grantedAt: "x" } };

    // no approval on disk → the fold's own refusal names the shelf
    const bare = resolveStudioApps([fx.app], state, { approvals: readVerifiedApprovals(fx.root, [fx.app]).approvals });
    assert.match(bare.refusals[0]!.reason, /no verified approval/);

    // a verified approval whose treeHash matches the lockfile pin admits the app
    const good = signApproval({
      coordinate: "github:acme/copy-studio", version: "1.2.0", treeHash: "sha256-feedface",
      grants: ["project:read"], keyId: corpus.keys.keyId,
    }, corpus.keys.privateKeyPem);
    mkdirSync(dirname(approvalFile(fx.root, "copystudio")), { recursive: true });
    writeFileSync(approvalFile(fx.root, "copystudio"), JSON.stringify(good));
    const verified = readVerifiedApprovals(fx.root, [fx.app]);
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.approvals["copystudio"], "1.2.0");
    const admitted = resolveStudioApps([fx.app], state, { approvals: verified.approvals });
    assert.equal(admitted.refusals.length, 0);
    assert.equal(admitted.table.rail.length, 1);

    // a treeHash that does not match the lockfile pin — the reviewed tree is not the installed tree
    const wrongTree = signApproval({ ...good, signature: undefined, treeHash: "sha256-deadbeef" } as AppApproval, corpus.keys.privateKeyPem);
    writeFileSync(approvalFile(fx.root, "copystudio"), JSON.stringify(wrongTree));
    const held = readVerifiedApprovals(fx.root, [fx.app]);
    assert.equal(held.approvals["copystudio"], undefined);
    assert.match(held.problems[0]!.reason, /treeHash/);
  } finally {
    fx.cleanup();
  }
});
