//
//  licence-sign.test.ts — `despia licence sign`, the step between a purchase and a working app.
//
//  This is the money path and its failure is silent: if the signer emits a file no device
//  accepts, the customer downloads a licence, ships it, and sees the watermark anyway. So the
//  happy path here does not stop at "the command exited 0" — it takes the bytes the command
//  posted back and VERIFIES them the way the device would, against the public half of the key.
//
//  The refusals matter for a different reason. This command is run by an operator against a
//  production platform with a signing key in hand, so every way it can half-work is a way to
//  mint something wrong: no key, no token, a claim set that does not validate, a platform that
//  rejects the post. Each answers non-zero and says which.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { runCli, type Io } from "../src/cli.ts";
import { verifyEntitlement, type EntitlementClaims } from "../src/entitlement.ts";

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function keyFile(pem = PRIVATE_PEM): string {
  const dir = mkdtempSync(join(tmpdir(), "despia-key-"));
  const path = join(dir, "signing.pem");
  writeFileSync(path, pem);
  return path;
}

interface Stub {
  url: string;
  posted: { id: string; entitlement: EntitlementClaims }[];
  authHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/** A stand-in for the platform's two internal routes. */
async function stub(pending: unknown[], options: { postStatus?: number } = {}): Promise<Stub> {
  const posted: { id: string; entitlement: EntitlementClaims }[] = [];
  const authHeaders: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    authHeaders.push(req.headers["authorization"]);
    if (req.url === "/internal/licences/pending") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pending }));
      return;
    }
    const match = /^\/internal\/licences\/([^/]+)\/entitlement$/.exec(req.url ?? "");
    if (match !== null && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += String(c); });
      req.on("end", () => {
        const status = options.postStatus ?? 200;
        if (status === 200) {
          posted.push({ id: decodeURIComponent(match[1]!), entitlement: JSON.parse(body).entitlement });
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status === 200 }));
      });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    posted,
    authHeaders,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

const CLAIMS = {
  id: "lic_row_1",
  claims: {
    appId: "com.acme.myapp", issued: "2026-08-21", licenceId: "lic_abc",
    majorVersion: 4, platform: "ios", variants: [],
  },
};

test("licence sign: the posted entitlement verifies the way the device would", async () => {
  const server = await stub([CLAIMS]);
  try {
    const io = capture();
    const code = await runCli(
      ["licence", "sign", "--api", server.url, "--key", keyFile(), "--token", "svc_token"],
      io,
    );
    assert.equal(code, 0, io.errors.join("\n"));
    assert.equal(server.posted.length, 1);
    assert.equal(server.posted[0]!.id, "lic_row_1");

    // THE ASSERTION THAT MATTERS. Not "a signature is present" — the full device rule, against
    // the public half of the key that signed it.
    const verdict = verifyEntitlement(server.posted[0]!.entitlement, PUBLIC_PEM, {
      app: "com.acme.myapp", platform: "ios", major: 4,
    });
    assert.deepEqual(verdict, { ok: true });
    assert.match(io.lines.join("\n"), /signed {2}lic_row_1/);
  } finally {
    await server.close();
  }
});

test("licence sign: the signed claims are the ones the platform recorded, not invented", async () => {
  // A signer that quietly substitutes its own values mints a licence for the wrong app. The
  // platform's attach route rejects a mismatch, but only if the mismatch is visible there — pin
  // the claims here too, so a drift in this command fails in this file rather than in production.
  const server = await stub([CLAIMS]);
  try {
    assert.equal(await runCli(
      ["licence", "sign", "--api", server.url, "--key", keyFile(), "--token", "t"], capture(),
    ), 0);
    const signed = server.posted[0]!.entitlement;
    assert.equal(signed.appId, "com.acme.myapp");
    assert.equal(signed.licenseId, "lic_abc", "the platform spells it licenceId; the file spells it licenseId");
    assert.equal(signed.majorVersion, 4);
    assert.equal(signed.issued, "2026-08-21", "the recorded issue date, not today");
    assert.deepEqual(signed.variants, []);
  } finally {
    await server.close();
  }
});

test("licence sign: the service-role token rides every internal call", async () => {
  const server = await stub([CLAIMS]);
  try {
    await runCli(["licence", "sign", "--api", server.url, "--key", keyFile(), "--token", "svc_abc"], capture());
    assert.ok(server.authHeaders.length >= 2, "both the list and the post were made");
    for (const header of server.authHeaders) assert.equal(header, "Bearer svc_abc");
  } finally {
    await server.close();
  }
});

test("licence sign: --dry-run signs nothing and posts nothing", async () => {
  const server = await stub([CLAIMS]);
  try {
    const io = capture();
    // No --key at all: a dry run must not require the one secret that matters, or an operator
    // cannot see what is waiting without unlocking it.
    const code = await runCli(["licence", "sign", "--api", server.url, "--token", "t", "--dry-run"], io);
    assert.equal(code, 0, io.errors.join("\n"));
    assert.deepEqual(server.posted, []);
    assert.match(io.lines.join("\n"), /would sign lic_row_1/);
  } finally {
    await server.close();
  }
});

test("licence sign: an empty queue is success, not an error", async () => {
  const server = await stub([]);
  try {
    const io = capture();
    assert.equal(await runCli(["licence", "sign", "--api", server.url, "--key", keyFile(), "--token", "t"], io), 0);
    assert.match(io.lines.join("\n"), /nothing is waiting/);
  } finally {
    await server.close();
  }
});

test("licence sign: a claim set that does not validate is refused, and the run fails", async () => {
  const server = await stub([
    CLAIMS,
    { id: "lic_bad", claims: { ...CLAIMS.claims, platform: "windows" } },
  ]);
  try {
    const io = capture();
    const code = await runCli(["licence", "sign", "--api", server.url, "--key", keyFile(), "--token", "t"], io);
    assert.equal(code, 1, "a partial run is a failure — the operator must see it");
    assert.equal(server.posted.length, 1, "the good one still went through");
    assert.match(io.errors.join("\n"), /refused lic_bad — platform must be one of ios, android/);
  } finally {
    await server.close();
  }
});

test("licence sign: a platform that rejects the post fails loudly", async () => {
  const server = await stub([CLAIMS], { postStatus: 409 });
  try {
    const io = capture();
    assert.equal(await runCli(["licence", "sign", "--api", server.url, "--key", keyFile(), "--token", "t"], io), 1);
    assert.match(io.errors.join("\n"), /rejected lic_row_1 — the platform answered 409/);
  } finally {
    await server.close();
  }
});

test("licence sign: the arguments that must be present are demanded, one at a time", async () => {
  const io1 = capture();
  assert.equal(await runCli(["licence", "sign", "--token", "t", "--key", keyFile()], io1), 2);
  assert.match(io1.errors.join("\n"), /--api is required/);

  const io2 = capture();
  assert.equal(await runCli(["licence", "sign", "--api", "https://x.test", "--key", keyFile()], io2), 2);
  assert.match(io2.errors.join("\n"), /--token is required/);

  const io3 = capture();
  assert.equal(await runCli(["licence", "sign", "--api", "https://x.test", "--token", "t"], io3), 2);
  assert.match(io3.errors.join("\n"), /--key is required/);
});

test("licence sign: a non-ed25519 key fails before anything is posted", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const server = await stub([CLAIMS]);
  try {
    const io = capture();
    const code = await runCli([
      "licence", "sign", "--api", server.url, "--token", "t",
      "--key", keyFile(rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    ], io);
    assert.equal(code, 1);
    assert.match(io.errors.join("\n"), /is rsa, not ed25519/);
    assert.deepEqual(server.posted, []);
  } finally {
    await server.close();
  }
});

test("licence: the only verb is sign", async () => {
  const io = capture();
  assert.equal(await runCli(["licence", "revoke", "--api", "https://x.test", "--token", "t"], io), 2);
  assert.match(io.errors.join("\n"), /unknown verb "revoke"/);
});
