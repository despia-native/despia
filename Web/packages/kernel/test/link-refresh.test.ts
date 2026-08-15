//
//  link-refresh.test.ts — the signed refresh that keeps a SHIPPED app in sync.
//
//  The fixtures here are signed by the REAL reference signer
//  (`ClosedSource/scripts/sign_manifest.rb`, Ed25519), not by this file. That matters: a test that
//  signs with the same code it verifies with proves only self-consistency, and the whole point of
//  the byte/format contract in remote-bundle-signing.md is that a Ruby signer at deploy time and a
//  WebCrypto verifier on the device agree byte for byte. If either side drifts, these go red.
//
//  What is pinned:
//    • a genuine table INSTALLS, and only after its signature is checked
//    • an unsigned table is REFUSED — HTTPS authenticates the channel, not the author
//    • a tampered byte is REFUSED, including a change that keeps the JSON valid
//    • a REPLAYED older table is refused even though it verifies perfectly (C1 anti-rollback):
//      restoring a route you deliberately withdrew is exactly what an attacker wants
//    • every rejection LEAVES THE CURRENT TABLE ALONE — the floor in the binary is the worst case
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LinkSeam, type LinkRoute } from "../src/bus.ts";
import { refreshLink } from "../src/link-refresh.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "link-signing");

const PUBLIC_KEY = readFileSync(join(FIXTURES, "public-key.b64"), "utf-8").trim();
const V1_BYTES = readFileSync(join(FIXTURES, "link-v1.json"));
const V1_SIG = readFileSync(join(FIXTURES, "link-v1.json.sig"), "utf-8").trim();
const V0_BYTES = readFileSync(join(FIXTURES, "link-v0.json"));
const V0_SIG = readFileSync(join(FIXTURES, "link-v0.json.sig"), "utf-8").trim();

const FLOOR: LinkRoute[] = [{ chain: "bundled", action: "floor", method: "GET", path: "/floor" }];

/** Serve exact bytes with the detached signature in the header, like a deploy does. */
function server(body: Buffer, signature: string | null, opts: { status?: number; sidecar?: string | null } = {}): typeof fetch {
  return (async (url: string) => {
    if (url.endsWith(".sig")) {
      return opts.sidecar == null ? new Response("", { status: 404 }) : new Response(opts.sidecar, { status: 200 });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== null) headers["x-dsx-signature"] = signature;
    return new Response(body as unknown as BodyInit, { status: opts.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

function withFloor(): void {
  LinkSeam.routes = FLOOR;
}

test("refresh: a genuinely signed table installs", async () => {
  withFloor();
  const out = await refreshLink({ url: "https://api.example.com/dsx/link.json", publicKey: PUBLIC_KEY, fetchImpl: server(V1_BYTES, V1_SIG) });
  assert.equal(out.ok, true, `expected an install, got ${JSON.stringify(out)}`);
  assert.equal(out.ok && out.version, 1);
  assert.ok(LinkSeam.routes.some((r) => r.action === "createNote"), "the refreshed table was not installed");
  withFloor();
});

test("refresh: the signature is read from the .sig SIDECAR when no header is present", async () => {
  withFloor();
  const out = await refreshLink({
    url: "https://api.example.com/dsx/link.json",
    publicKey: PUBLIC_KEY,
    fetchImpl: server(V1_BYTES, null, { sidecar: V1_SIG }),
  });
  assert.equal(out.ok, true, `the sidecar transport was not honoured: ${JSON.stringify(out)}`);
  withFloor();
});

test("refresh: an UNSIGNED table is refused — HTTPS authenticates the channel, not the author", async () => {
  withFloor();
  const out = await refreshLink({ url: "https://api.example.com/dsx/link.json", publicKey: PUBLIC_KEY, fetchImpl: server(V1_BYTES, null) });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "unsigned");
  assert.deepEqual(LinkSeam.routes, FLOOR, "an unsigned table replaced the working one");
});

test("refresh: a TAMPERED byte is refused, even when the result is still valid JSON", async () => {
  withFloor();
  // repoint a route at an attacker's path — the classic reason this gate exists
  const tampered = Buffer.from(V1_BYTES.toString("utf-8").replace('"/notes"', '"/steal"'), "utf-8");
  assert.notEqual(tampered.toString(), V1_BYTES.toString(), "the fixture did not actually change");
  const out = await refreshLink({ url: "https://api.example.com/dsx/link.json", publicKey: PUBLIC_KEY, fetchImpl: server(tampered, V1_SIG) });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "bad_signature");
  assert.deepEqual(LinkSeam.routes, FLOOR, "a tampered table was installed");
});

test("refresh: a table signed by ANOTHER key is refused", async () => {
  withFloor();
  const otherKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const out = await refreshLink({ url: "https://api.example.com/dsx/link.json", publicKey: otherKey, fetchImpl: server(V1_BYTES, V1_SIG) });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "bad_signature");
  assert.deepEqual(LinkSeam.routes, FLOOR);
});

test("refresh: C1 ANTI-ROLLBACK — a genuinely signed OLDER table is still refused", async () => {
  withFloor();
  // v0 verifies perfectly; it is refused because replaying an old table is how a withdrawn
  // route gets restored. "Cryptographically valid" and "safe to install" are different questions.
  const out = await refreshLink({
    url: "https://api.example.com/dsx/link.json",
    publicKey: PUBLIC_KEY,
    minVersion: 1,
    fetchImpl: server(V0_BYTES, V0_SIG),
  });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "rollback_detected");
  assert.deepEqual(LinkSeam.routes, FLOOR, "a replayed older table was installed");
});

test("refresh: the same table at or above the floor is accepted", async () => {
  withFloor();
  const out = await refreshLink({ url: "https://api.example.com/dsx/link.json", publicKey: PUBLIC_KEY, minVersion: 1, fetchImpl: server(V1_BYTES, V1_SIG) });
  assert.equal(out.ok, true, `version 1 should satisfy a floor of 1: ${JSON.stringify(out)}`);
  withFloor();
});

test("refresh: a server that is DOWN leaves the bundled floor in place", async () => {
  withFloor();
  const out = await refreshLink({
    url: "https://api.example.com/dsx/link.json",
    publicKey: PUBLIC_KEY,
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch,
  });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "unreachable");
  assert.deepEqual(LinkSeam.routes, FLOOR, "an offline refresh damaged the working table — the floor must survive");
});

test("refresh: a misconfigured trust anchor refuses rather than trusting anything", async () => {
  withFloor();
  const out = await refreshLink({ url: "https://api.example.com/dsx/link.json", publicKey: "not-base64!!", fetchImpl: server(V1_BYTES, V1_SIG) });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "not_configured");
  assert.deepEqual(LinkSeam.routes, FLOOR);
});
