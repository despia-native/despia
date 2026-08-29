//
//  provision.test.ts — `despia provision` driven end to end against a REAL Postgres (PGlite).
//
//  The command is what stands between a customer and writing SQL, so it is tested the way they
//  meet it: run it against a database that has never seen Despia, read the lines it prints, and
//  read the receipt it leaves. The connection factory is a parameter for exactly this reason —
//  the engine is real, only the address is not.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import type { SqlClient } from "@despia-native/server/postgres";

import { commandProvision } from "../src/cli.ts";
import { DATABASE_URL_ENV, databaseUrl, projectQueues, ProvisionError, RECEIPT_PATH } from "../src/provision.ts";
import { loadConfig } from "../src/config.ts";

const PLATFORM_PREAMBLE = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
`;

const SERVER_DOC = `<server>
  <head>
    <entity as="note" ownership="public-read">
      <field as="title" type="text"/>
    </entity>
    <action as="digest">
      return 1
    </action>
  </head>
  <route method="GET" path="/api/notes" entity="note" op="list"/>
  <worker queue="mail" action="digest"/>
</server>
`;

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-provision-"));
  for (const [path, contents] of Object.entries({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": `<stack><text value="x"/></stack>\n`,
    "server/notes.dsx": SERVER_DOC,
  })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

/** A real engine behind the command's connection seam. `close` is asserted, because a command
 *  that leaks a customer's database connection on every run is a real defect. */
async function engine(): Promise<{ db: PGlite; connect: () => Promise<{ client: SqlClient; close: () => Promise<void> }>; closed: () => number }> {
  const db = await new PGlite();
  await db.exec(PLATFORM_PREAMBLE);
  let closes = 0;
  const client: SqlClient = {
    query: async (text, params) => {
      const r = await db.query(text, params as never[]);
      return { rows: r.rows as unknown[] };
    },
  };
  return {
    db,
    connect: async () => ({ client, close: async () => { closes += 1; } }),
    closed: () => closes,
  };
}

/** The address arrives in the environment the connected account sets — the command insists on
 *  one before it connects, so the run supplies it exactly as a deploy would. The injected engine
 *  is embedded, so the value is only ever proof that the plumbing is real. */
async function run(root: string, flags: Record<string, string | boolean>, connect: () => Promise<{ client: SqlClient; close: () => Promise<void> }>): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
  const prior = process.env[DATABASE_URL_ENV];
  process.env[DATABASE_URL_ENV] = "postgres://connected.example/db";
  try {
    const code = await commandProvision({ ...flags, project: root }, io, connect, () => "2026-08-27T00:00:00.000Z");
    return { code, out };
  } finally {
    if (prior === undefined) delete process.env[DATABASE_URL_ENV];
    else process.env[DATABASE_URL_ENV] = prior;
  }
}

test("provision: the queues come from the documents the migration was built from", () => {
  const fx = project();
  try {
    assert.deepEqual(projectQueues(loadConfig(fx.root)), ["mail"]);
  } finally {
    fx.cleanup();
  }
});

test("provision: reporting on an untouched database names what is missing and changes nothing", async () => {
  const fx = project();
  const e = await engine();
  try {
    const { code, out } = await run(fx.root, {}, e.connect);
    const text = out.join("\n");
    assert.equal(code, 1, "a database that cannot serve the runtime is not a success");
    assert.match(text, /Despia system storage needs repair — 3 internal table\(s\) need attention/);
    assert.match(text, /dsx_rate_counter \(missing\)/);
    assert.match(text, /dsx_event \(missing\)/);
    assert.match(text, /dsx_queue_mail \(missing\)/);
    //  The report is for a person: every row says what the table is FOR, not just its name.
    assert.match(text, /spend ceilings/);
    assert.match(text, /despia provision --apply/);

    //  REPORTING CHANGES NOTHING. The tables are still absent afterwards.
    const after = await e.db.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_name like 'dsx_%'",
    );
    assert.equal(after.rows[0]!.n, 0);
    assert.equal(e.closed(), 1, "the connection must be closed even on the reporting path");
  } finally {
    await e.db.close();
    fx.cleanup();
  }
});

test("provision --apply: creates the reserved tables, verifies, and writes the receipt", async () => {
  const fx = project();
  const e = await engine();
  try {
    const { code, out } = await run(fx.root, { apply: true }, e.connect);
    const text = out.join("\n");
    assert.equal(code, 0);
    assert.match(text, /provisioned — created 3 internal table\(s\)/);
    assert.match(text, /\+ dsx_rate_counter/);

    const live = await e.db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_name like 'dsx_%' order by table_name",
    );
    assert.deepEqual(live.rows.map((r) => r.table_name), ["dsx_event", "dsx_queue_mail", "dsx_rate_counter"]);

    //  THE RECEIPT: what Despia did to a database it does not own, written down.
    const receipt = JSON.parse(readFileSync(join(fx.root, RECEIPT_PATH), "utf8")) as {
      at: string; ready: boolean; applied: boolean; created: string[]; damaged: string[];
      tables: { table: string; ok: boolean }[]; _note: string;
    };
    assert.equal(receipt.ready, true);
    assert.equal(receipt.applied, true);
    assert.equal(receipt.at, "2026-08-27T00:00:00.000Z");
    assert.deepEqual(receipt.created.sort(), ["dsx_event", "dsx_queue_mail", "dsx_rate_counter"]);
    assert.deepEqual(receipt.damaged, []);
    assert.ok(receipt.tables.every((t) => t.ok));
    assert.match(receipt._note, /Your own tables are never touched/);

    //  Idempotent through the command, not only the engine: running it again is healthy, not
    //  a second creation, and it still records a receipt.
    const again = await run(fx.root, { apply: true }, e.connect);
    assert.equal(again.code, 0);
    assert.match(again.out.join("\n"), /healthy — 3 internal table\(s\) present/);
    const second = JSON.parse(readFileSync(join(fx.root, RECEIPT_PATH), "utf8")) as { created: string[] };
    assert.deepEqual(second.created, []);
  } finally {
    await e.db.close();
    fx.cleanup();
  }
});

test("provision --apply: an altered Despia table is named, left alone, and fails the run", async () => {
  const fx = project();
  const e = await engine();
  try {
    await run(fx.root, { apply: true }, e.connect);
    await e.db.exec("alter table dsx_rate_counter drop column expires_at;");

    const { code, out } = await run(fx.root, { apply: true }, e.connect);
    const text = out.join("\n");
    assert.equal(code, 1, "a damaged system table must not report success");
    assert.match(text, /needs repair — 1 internal table\(s\) need attention/);
    assert.match(text, /dsx_rate_counter \(altered — missing expires_at\)/);
    //  It says WHY it did not silently fix it, in the sentence a person needs.
    assert.match(text, /restoring a column does not restore the constraint it carried/);

    const receipt = JSON.parse(readFileSync(join(fx.root, RECEIPT_PATH), "utf8")) as { ready: boolean; damaged: string[] };
    assert.equal(receipt.ready, false);
    assert.deepEqual(receipt.damaged, ["dsx_rate_counter"]);
  } finally {
    await e.db.close();
    fx.cleanup();
  }
});

test("provision: a missing database address is one sentence, and a URL is never an argument", () => {
  assert.throws(() => databaseUrl(() => undefined), (e: unknown) =>
    e instanceof ProvisionError && /set DSX_DATABASE_URL/.test(e.message));
  assert.throws(() => databaseUrl(() => "   "), ProvisionError);
  assert.equal(databaseUrl((n) => (n === DATABASE_URL_ENV ? "postgres://x" : undefined)), "postgres://x");
});
