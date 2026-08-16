//
//  error-leak.live.test.ts — the S1 boundary, proven against a REAL database error.
//
//  `host.security.test.ts` S1 proves the boundary redacts a handler that throws a string the
//  test wrote itself ("kaboom: SELECT * FROM users WHERE token='s3cr3t'"). That is necessary and
//  not sufficient: the thing S1 exists to stop is a DATABASE driver error — which carries the SQL
//  text, the table name, and sometimes the connection detail in a shape no test author invents —
//  riding out to the client verbatim. Only a real driver, failing for a real reason, produces one.
//
//  So this file installs the REAL Postgres transport, the REAL generated entities, and the REAL
//  declared-CRUD handlers, then makes Postgres itself fail (the schema is deliberately not
//  migrated, so every query hits `relation "dsx_note" does not exist`, error code 42P01, with the
//  offending SQL attached). It asserts two independent things:
//
//    • the CLIENT sees only { reason, message } with no SQL, no table name, no pg code, no stack;
//    • the failure SINK — config.onError, where the detail is meant to go — receives the real
//      error, tied to the same correlation id the client got. Redaction that also blinded the
//      operator would be its own defect.
//
//  SKIPPING: like every *.live suite here, it needs a Postgres it may create a database in and
//  SKIPS cleanly when none is reachable — a skip proves nothing, which is why S1 also runs
//  always-on against a scripted throw. Point it with DSX_TEST_ADMIN_URL.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { installEntities, crudHandler, type EntitySpec } from "../src/repo.ts";
import { installPostgresPool } from "../src/postgres.ts";
import { createHost, type HostConfig, type ServerRoute } from "../src/host.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ENTITIES = join(HERE, "..", "generated", "entities.json");
const ROLES = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_roles.sql");

const ADMIN = process.env["DSX_TEST_ADMIN_URL"] ?? "postgresql://localhost:5432/postgres";
const DB = "dsx_error_leak_test";
const ALICE = "11111111-1111-1111-1111-111111111111";

// The two secrets the boundary must never echo: they live in the connection, not in any thrown
// string, so a test that only checks a hand-written throw can never catch them leaking.
const PW = "leak-canary-pw";
const APP_ROLE = "dsx_leak_app";

function declaredEntities(): EntitySpec[] {
  const doc = JSON.parse(readFileSync(ENTITIES, "utf-8")) as { entities?: EntitySpec[] };
  const list = Array.isArray(doc) ? (doc as EntitySpec[]) : doc.entities;
  assert.ok(Array.isArray(list) && list.length > 0, "generated/entities.json must declare at least one entity");
  return list;
}

/**
 * The note routes as prepare_server emits them. `entity`/`op` are the EMITTER's fields — they pick
 * which generated handler a row gets and never reach the host — so the route rows here carry only
 * what a host route is, and the declared-CRUD handlers are bound below exactly as the barrel binds
 * them. The handler under test is therefore the real one.
 */
const ROUTES: ServerRoute[] = [
  { key: "list-notes", chain: "server.http", action: "listNotes", method: "GET", path: "/notes" },
  { key: "create-note", chain: "server.http", action: "createNote", method: "POST", path: "/notes" },
];

async function reachable(): Promise<string | false> {
  const probe = new pg.Client({ connectionString: ADMIN });
  try {
    await probe.connect();
    await probe.end();
    return false;
  } catch (e) {
    return `no postgres at ${ADMIN} (${e instanceof Error ? e.message : String(e)})`;
  }
}

const skip = await reachable();

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * A database WITH the app role and the entities installed but the schema NEVER migrated. Every
 * repository query therefore reaches a real planner and fails on a missing relation — the exact
 * driver error class S1 is about, produced by Postgres rather than by this file.
 */
async function unmigrated(): Promise<{ pool: pg.Pool; url: string; end: () => Promise<void> }> {
  await admin(`drop database if exists ${DB}`);
  await admin(`drop role if exists ${APP_ROLE}`);
  await admin(`create role ${APP_ROLE} login password '${PW}'`);
  await admin(`create database ${DB} owner ${APP_ROLE}`);
  // The ROLES half of the emitted migration only — the request roles exist and the app role is a
  // member, so the transaction's identity preamble succeeds and the failure lands where this file
  // wants it: on the missing TABLE. Without this the first error is `permission denied to set role
  // "authenticated"` — a real driver error too, and the one 000_dsx_roles.sql documents, but not
  // the SQL-carrying class under test.
  await admin(readFileSync(ROLES, "utf-8"));
  const url = ADMIN.replace(/\/[^/]*$/, `/${DB}`).replace(/^postgresql:\/\//, `postgresql://${APP_ROLE}:${PW}@`);
  const grant = new pg.Client({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${DB}`) });
  await grant.connect();
  try {
    await grant.query(`grant anon, authenticated to ${APP_ROLE}`);
  } finally {
    await grant.end();
  }
  const pool = new pg.Pool({ connectionString: url });
  const end = async (): Promise<void> => {
    await pool.end().catch(() => {});
    await admin(`drop database if exists ${DB}`).catch(() => {});
    await admin(`drop role if exists ${APP_ROLE}`).catch(() => {});
  };
  return { pool, url, end };
}

/**
 * The forbidden strings: anything that would identify the query, the table, or the connection.
 *
 * Each needle is the EXACT text a leak would carry, not a fragment of it. A loose needle is worse
 * than none — a bare "relation" matches the `x-dsx-correlation-id` header this file requires to be
 * present, so the assertion would fail on correct behaviour and be silenced rather than trusted.
 */
const FORBIDDEN = ['relation "', "does not exist", "42P01", "dsx_note", "select ", "SELECT ", "insert into", "INSERT INTO", PW, APP_ROLE, DB, "at Object", "at async", ".ts:", "node_modules"];

function assertNoLeak(serialized: string, what: string): void {
  for (const needle of FORBIDDEN) {
    assert.ok(!serialized.includes(needle), `the ${what} leaked ${JSON.stringify(needle)}: ${serialized}`);
  }
}

test("error-leak.live: a REAL Postgres driver error never reaches the client", { skip }, async () => {
  const { pool, end } = await unmigrated();
  try {
    installEntities(declaredEntities());
    installPostgresPool(pool);

    const seen: { correlationId: string; route: string; error: unknown }[] = [];
    const cfg: HostConfig = {
      routes: ROUTES,
      handlers: { "server.http": { listNotes: crudHandler("note", "list"), createNote: crudHandler("note", "create") } },
      onError: (info) => seen.push(info),
    };
    const host = createHost(cfg);

    // A list that hits `relation "dsx_note" does not exist` — a genuine 42P01 with SQL attached.
    const listReq = new Request("https://x/notes", { headers: { authorization: bearer(ALICE) } });
    const listRes = await host.handle(listReq, { identity: { sub: ALICE, role: null, claims: {}, token: "t" } });
    const listBody = await listRes.text();

    assert.equal(listRes.status, 500, "a driver failure is a 500, not a leak and not a success");
    assertNoLeak(listBody, "client response body");
    assertNoLeak(JSON.stringify(Object.fromEntries(listRes.headers)), "response headers"); // not smuggled in a header either
    const parsed = JSON.parse(listBody) as { reason?: string; message?: string; correlationId?: string };
    assert.equal(parsed.reason, "handler_failed", "the client gets the generic reason, nothing more");

    // The OPERATOR half: the same failure, in full, tied to the id the client can quote.
    assert.equal(seen.length, 1, "the failure sink must receive exactly one detail record");
    const detail = seen[0]!;
    const correlation = listRes.headers.get("x-dsx-correlation-id");
    assert.ok(correlation, "the client must get a correlation id to quote");
    assert.equal(detail.correlationId, correlation, "the sink's id must match the client's, or the redaction blinded the operator");
    assert.match(String((detail.error as Error)?.message ?? detail.error), /dsx_note|relation|does not exist/, "the sink must carry the REAL error, undedacted");

    // And the write side, whose failure carries the INSERT rather than the SELECT.
    const createReq = new Request("https://x/notes", { method: "POST", headers: { authorization: bearer(ALICE), "content-type": "application/json" }, body: JSON.stringify({ title: "t", body: "b", pinned: false }) });
    const createRes = await host.handle(createReq, { identity: { sub: ALICE, role: null, claims: {}, token: "t" } });
    const createBody = await createRes.text();
    assert.equal(createRes.status, 500);
    assertNoLeak(createBody, "create response body");
  } finally {
    await end();
  }
});

const b64url = (value: string): string => Buffer.from(value, "utf-8").toString("base64url");
function bearer(uid: string): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: uid }));
  return `Bearer ${header}.${payload}.`;
}
