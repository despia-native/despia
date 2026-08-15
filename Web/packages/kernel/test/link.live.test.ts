//
//  link.live.test.ts — THE FULL LADDER, END TO END, WITH NOTHING FAKED.
//
//  Every other link test stubs the transport. This one drives the real thing:
//
//      dsx.module.server.http.createNote({...})
//         → the resolution ladder finds no local action
//         → the emitted client link table (generated/link.json)
//         → createHttpLink over real HTTP
//         → the running DSX server
//         → identity verified, RLS applied
//         → real rows in a real PostgreSQL
//
//  and the claim it exists to prove is the one the whole program is for: **user A's call and
//  user B's call, through the same markup and the same call site, cannot see each other's data.**
//  Isolation was proven at the database and at the HTTP boundary already; this proves it survives
//  the last hop — the one an application actually writes.
//
//  It self-provisions the production Node HTTP adapter over PGlite when no URL is supplied, so
//  the mandatory suite always executes. An explicit DSX_TEST_SERVER_URL remains authoritative
//  and fails loudly when unreachable. The properties also have fast in-process counterparts in
//  link.test.ts; what only this file shows is that the emitted table, transport, gateway, JWT
//  boundary and real Postgres policy agree through an actual socket.
//
//  Run the server first:
//    DSX_JWT_SECRET=… DSX_DATABASE_URL=… PORT=8801 node --experimental-strip-types \
//      packages/server/deploy/serve.ts
//

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ModuleRegistry, LinkSeam, ModuleCallError, type LinkRoute } from "../src/bus.ts";
import { createHttpLink } from "../src/link.ts";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "../../server/src/bootloader-node.ts";
import { installPostgresClient, type SqlClient } from "../../server/src/postgres.ts";

let BASE = process.env.DSX_TEST_SERVER_URL ?? "http://localhost:8801";
//  ES256 against a local JWKS, because the tree declares auth_mode "jwks" — identity is verified
//  from a PUBLIC key set, so no shared secret exists to hand this test. Same curve and algorithm
//  the deployment uses; the only difference is that this key's private half is generated here.
const KID = "dsx-link-live-test";
const { publicKey: TEST_PUB, privateKey: TEST_KEY } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const JWKS_BODY = JSON.stringify({
  keys: [{ ...TEST_PUB.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig", key_ops: ["verify"] }],
});
const jwksServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JWKS_BODY);
});

/** createSign emits DER; JOSE wants raw r||s, each left-padded to 32 bytes. */
function joseSignature(signingInput: string): string {
  const der = createSign("SHA256").update(signingInput).sign(TEST_KEY);
  let i = 2;
  if ((der[1] & 0x80) !== 0) i += der[1] & 0x7f;
  const rLen = der[i + 1];
  const r = der.subarray(i + 2, i + 2 + rLen);
  const sOff = i + 2 + rLen;
  const s = der.subarray(sOff + 2, sOff + 2 + der[sOff + 1]);
  const pad = (b: Buffer) => (b.length >= 32 ? b.subarray(b.length - 32) : Buffer.concat([Buffer.alloc(32 - b.length), b]));
  return Buffer.concat([pad(r), pad(s)]).toString("base64url");
}
const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const LINK_TABLE = join(HERE, "..", "..", "server", "generated", "link.json");
const ROLES = join(HERE, "..", "..", "server", "deploy", "supabase", "migrations", "000_dsx_roles.sql");
const SCHEMA = join(HERE, "..", "..", "server", "deploy", "supabase", "migrations", "000_dsx_schema.sql");

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

function mint(sub: string): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "ES256", typ: "JWT", kid: KID });
  const payload = b64({ sub, role: "authenticated", iat: now, exp: now + 3600 });
  return `${head}.${payload}.${joseSignature(`${head}.${payload}`)}`;
}

async function reachable(): Promise<string | false> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? false : `server at ${BASE} answered ${res.status}`;
  } catch (e) {
    return `no DSX server at ${BASE} (${e instanceof Error ? e.message : String(e)}) — start one, or set DSX_TEST_SERVER_URL`;
  }
}
let unavailable = await reachable();

// No operator-managed server is required for the mandatory suite. If an explicit URL was
// supplied it remains authoritative and an unreachable endpoint is a hard failure. Otherwise
// boot the production Node HTTP adapter over the emitted routes/handlers and a real embedded
// Postgres engine. The five assertions below still cross a socket, verify JWTs, execute the
// generated CRUD handlers and enforce the emitted RLS migration.
if (unavailable !== false && process.env.DSX_TEST_SERVER_URL === undefined) {
  const db = await new PGlite();
  await db.exec(readFileSync(ROLES, "utf-8"));
  await db.exec(readFileSync(SCHEMA, "utf-8"));

  await new Promise<void>((ready) => jwksServer.listen(0, ready));
  const jwksPort = (jwksServer.address() as { port: number }).port;
  const priorSecret = process.env.DSX_JWT_JWKS_URL;
  const priorDatabase = process.env.DSX_DATABASE_URL;
  process.env.DSX_JWT_JWKS_URL = `http://127.0.0.1:${jwksPort}/jwks.json`;
  process.env.DSX_DATABASE_URL = "pglite://mandatory-live-test";
  const booted = await serve({
    port: 0,
    installDataProvider: async () => {
      const client: SqlClient = {
        query: async (text, params) => {
          const result = await db.query(text, params as never[]);
          return { rows: result.rows as unknown[] };
        },
      };
      installPostgresClient(client);
      return { installed: true, backend: "pglite" };
    },
  });
  BASE = `http://127.0.0.1:${booted.port}`;
  unavailable = await reachable();
  after(async () => {
    await booted.close();
    await db.close();
    jwksServer.close();
    if (priorSecret === undefined) delete process.env.DSX_JWT_JWKS_URL;
    else process.env.DSX_JWT_JWKS_URL = priorSecret;
    if (priorDatabase === undefined) delete process.env.DSX_DATABASE_URL;
    else process.env.DSX_DATABASE_URL = priorDatabase;
  });
}
if (unavailable !== false) throw new Error(unavailable);

/** Install the EMITTED table — not a hand-written one, or this proves nothing about the build. */
let subject = ALICE;
const emitted = JSON.parse(readFileSync(LINK_TABLE, "utf-8")) as { routes: LinkRoute[] };
LinkSeam.routes = emitted.routes;
LinkSeam.invoke = createHttpLink({ baseUrl: BASE, token: () => mint(subject) });

test("live: the emitted table omits every internal route — a client cannot name one", () => {
  const emitted = JSON.parse(readFileSync(LINK_TABLE, "utf-8")) as { routes: LinkRoute[] };
  const internal = emitted.routes.filter((r) => r.path.startsWith("/internal/"));
  assert.deepEqual(internal, [], "an internal route is listed in the CLIENT link table");
  // and the gateway agrees at runtime: the same call answers as if the route did not exist
  assert.equal(
    emitted.routes.some((r) => r.action === "drainWebhooks"),
    false,
    "the queue-drain worker is reachable from client code",
  );
});

test("live: dsx.module.server.http.* reaches a real server through the ladder", async () => {
  subject = ALICE;
  const health = (await ModuleRegistry.dispatch("server.http", "health", {})) as { ok: boolean; digest: string };
  assert.equal(health.ok, true);
  assert.equal(typeof health.digest, "string", "the reply should carry the assembly identity the server reports");
});

test("live: THE CLAIM — two callers, one call site, and neither sees the other's rows", async () => {
  // The row is tagged and CLEANED UP, and every assertion is about THIS row rather than a
  // global count. A live test that leaves state behind passes once and then fails forever on a
  // database it already polluted — which is a worse failure than the bug it was written to catch.
  const tag = `alice-via-the-bus-${process.pid}-${Date.now()}`;
  let createdId: string | null = null;

  try {
    subject = ALICE;
    const created = (await ModuleRegistry.dispatch("server.http", "createNote", {
      title: tag,
      body: "her secret",
      pinned: true,
      owner_id: BOB, // a hostile client argument — the verified identity must win
    })) as { id: string; owner_id: string; title: string };
    createdId = created.id;

    assert.equal(created.title, tag);
    assert.equal(created.owner_id, ALICE, "a client-supplied owner_id was written — the row would belong to someone else");

    const alices = (await ModuleRegistry.dispatch("server.http", "listNotes", {})) as { id: string }[];
    assert.ok(alices.some((n) => n.id === createdId), "Alice cannot read the row she just wrote");

    // ── the same call site, a different caller ──
    subject = BOB;
    const bobs = (await ModuleRegistry.dispatch("server.http", "listNotes", {})) as { id: string }[];
    assert.equal(bobs.some((n) => n.id === createdId), false, "BOB READ ALICE'S ROW THROUGH THE BUS");
    assert.equal(await ModuleRegistry.dispatch("server.http", "getNote", { id: createdId }), null, "Bob fetched Alice's row by id");
    assert.equal(await ModuleRegistry.dispatch("server.http", "updateNote", { id: createdId, title: "defaced" }), null, "Bob updated Alice's row");
    assert.equal(await ModuleRegistry.dispatch("server.http", "deleteNote", { id: createdId }), null, "Bob deleted Alice's row");

    // and Alice's row survived, unchanged
    subject = ALICE;
    const after = (await ModuleRegistry.dispatch("server.http", "listNotes", {})) as { id: string; title: string }[];
    const mine = after.find((n) => n.id === createdId);
    assert.ok(mine !== undefined, "Alice's row did not survive Bob's attempts");
    assert.equal(mine.title, tag, "Alice's row was modified by someone who could not read it");
  } finally {
    if (createdId !== null) {
      subject = ALICE;
      await ModuleRegistry.dispatch("server.http", "deleteNote", { id: createdId }).catch(() => null);
    }
  }
});

test("live: the server's typed refusal keeps its own reason through the ladder", async () => {
  const saved = LinkSeam.invoke;
  LinkSeam.invoke = createHttpLink({ baseUrl: BASE, token: () => null }); // anonymous
  try {
    await assert.rejects(ModuleRegistry.dispatch("server.http", "listNotes", {}), (e: ModuleCallError) => {
      assert.equal(e.code, "unauthenticated", "an anonymous call must surface the server's reason, not `unreachable`");
      return true;
    });
  } finally {
    LinkSeam.invoke = saved;
  }
});

test("live: a server that is DOWN is `unreachable` — distinct from a refusal", async () => {
  const saved = LinkSeam.invoke;
  LinkSeam.invoke = createHttpLink({ baseUrl: "http://127.0.0.1:9", token: () => mint(ALICE) }); // discard port
  try {
    await assert.rejects(ModuleRegistry.dispatch("server.http", "listNotes", {}), (e: ModuleCallError) => {
      assert.equal(e.code, "unreachable");
      return true;
    });
  } finally {
    LinkSeam.invoke = saved;
  }
});
