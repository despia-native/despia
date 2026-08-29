//
//  approval.ts — THE APPS SHELF'S SIGNATURE (studio-apps.md §11, T5): a human reviewed the
//  app, and the owner signed exactly what was reviewed — `(coordinate, version, treeHash,
//  grants)` — offline, with a key that never enters CI (the entitlement-signer discipline,
//  PUBLISH.md). The Studio and the headless faces refuse an installed third-party app that
//  carries no verified approval; dev mode mounts a working tree instead, which is what dev
//  mode is for.
//
//  Canonicalization mirrors entitlement.ts verbatim: top-level keys sorted, `signature`
//  excluded, JSON.stringify semantics — plus ONE approval-specific rule stated here rather
//  than discovered later: `grants` is sorted inside the canonical bytes, so two honest
//  signers of the same review can never disagree over array order.
//
//  The verify chain is three links, each cheap:
//    approval.signature  verifies over the canonical bytes with the shelf public key
//    approval.treeHash   equals the LOCKFILE pin (which materialize() re-hashes against
//                        the actual bytes on every handout — the expensive check already
//                        exists and runs)
//    approval.version    equals the manifest the discovery read
//

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readLockfile } from "../registry-commands.ts";
import { manifestGrants } from "./manifest.ts";
import type { DiscoveredApp } from "./host.ts";

export interface AppApproval {
  /** the registry coordinate, `github:owner/repo` */
  coordinate: string;
  version: string;
  /** the `sha256-…` tree hash the review covered — registry-resolve's treeHash */
  treeHash: string;
  /** the grants disclosed at review time, sorted */
  grants: string[];
  /** who signed (the shelf key id) — informational; the PEM decides */
  keyId?: string;
  /** base64 Ed25519 over the canonical bytes */
  signature?: string;
}

export function approvalCanonicalBytes(approval: AppApproval | Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(approval).filter((k) => k !== "signature").sort()) {
    const value = (approval as Record<string, unknown>)[key];
    body[key] = key === "grants" && Array.isArray(value) ? [...value].map(String).sort() : value;
  }
  return JSON.stringify(body);
}

/** Sign an approval — the corpus self-test and the DEV loop; the production ceremony is
 *  `ClosedSource/scripts/sign_app_approval.rb`, offline, owner-local. */
export function signApproval(approval: AppApproval, privateKeyPem: string): AppApproval {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`the approval signing key is ${key.asymmetricKeyType ?? "unknown"}, not ed25519`);
  }
  const signature = cryptoSign(null, Buffer.from(approvalCanonicalBytes(approval), "utf8"), key);
  return { ...approval, signature: signature.toString("base64") };
}

export function verifyApproval(
  approval: AppApproval, publicKeyPem: string,
): { ok: true } | { ok: false; reason: string } {
  const signature = approval.signature ?? "";
  if (signature === "") return { ok: false, reason: "the approval carries no signature" };
  const raw = Buffer.from(signature, "base64");
  if (raw.length !== 64) return { ok: false, reason: "the signature is not 64 bytes (Ed25519 raw)" };
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "the shelf public key is not a readable PEM" };
  }
  const ok = cryptoVerify(null, Buffer.from(approvalCanonicalBytes(approval), "utf8"), key, raw);
  return ok ? { ok: true } : { ok: false, reason: "the signature does not verify: the approval was altered or signed by another key" };
}

/** The shelf public key this toolchain trusts. The checked-in key is a DEV key by name and
 *  by file: the production key is minted offline at the owner ceremony (01-apps-shelf.md §7)
 *  and replaces `support/apps-shelf-key.json` in a release — verify fails closed either way. */
export function shelfPublicKey(): { keyId: string; publicKeyPem: string } | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "support", "apps-shelf-key.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { keyId?: unknown; publicKeyPem?: unknown };
        if (typeof parsed.keyId === "string" && typeof parsed.publicKeyPem === "string") {
          return { keyId: parsed.keyId, publicKeyPem: parsed.publicKeyPem };
        }
      } catch { /* fall through to the walk — an unreadable key file trusts nothing */ }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** An installed app's approval record, as `despia add` lays it down beside the state. */
export function approvalFile(projectRoot: string, scheme: string): string {
  return join(projectRoot, ".despia", "apps", "approvals", `${scheme}.json`);
}

/**
 * The verified approvals map the resolve fold consumes: scheme → approved version, with
 * every link checked. An approval that fails ANY link is absent from the map — the fold's
 * refusal then names what to do, and `despia app verify` prints the specific broken link.
 */
export function readVerifiedApprovals(
  projectRoot: string, apps: readonly DiscoveredApp[],
): { approvals: Record<string, string>; problems: Array<{ app: string; reason: string }> } {
  const approvals: Record<string, string> = {};
  const problems: Array<{ app: string; reason: string }> = [];
  const key = shelfPublicKey();
  let lock: ReturnType<typeof readLockfile> | null = null;
  for (const app of apps) {
    if (app.kind !== "installed") continue;
    const scheme = app.info.scheme;
    const path = approvalFile(projectRoot, scheme);
    if (!existsSync(path)) continue; // absent is the fold's own typed refusal
    let record: AppApproval;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as AppApproval;
    } catch {
      problems.push({ app: scheme, reason: "the approval file is not readable JSON" });
      continue;
    }
    if (key === null) {
      problems.push({ app: scheme, reason: "no shelf public key in this toolchain — cannot verify any approval" });
      continue;
    }
    const verdict = verifyApproval(record, key.publicKeyPem);
    if (!verdict.ok) {
      problems.push({ app: scheme, reason: verdict.reason });
      continue;
    }
    if (record.coordinate !== app.lockId) {
      problems.push({ app: scheme, reason: `the approval covers ${record.coordinate}, the pin is ${app.lockId}` });
      continue;
    }
    if (record.version !== app.info.version) {
      problems.push({ app: scheme, reason: `the approval covers ${record.version}, the manifest says ${app.info.version}` });
      continue;
    }
    lock ??= readLockfile(projectRoot);
    const pinned = lock.modules[app.lockId]?.sha256;
    if (pinned === undefined || pinned !== record.treeHash) {
      problems.push({ app: scheme, reason: `the approval's treeHash does not match the lockfile pin — the reviewed tree is not the installed tree` });
      continue;
    }
    // the reviewed grants must cover what the manifest asks TODAY — a manifest that grew
    // past its review is unreviewed surface
    const asked = manifestGrants(app.info);
    const covered = new Set(record.grants);
    const beyond = asked.filter((g) => !covered.has(g));
    if (beyond.length > 0) {
      problems.push({ app: scheme, reason: `the manifest asks for ${beyond.join(", ")} beyond the reviewed grants` });
      continue;
    }
    approvals[scheme] = record.version;
  }
  return { approvals, problems };
}
