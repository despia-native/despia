//
//  server-document.test.ts — the `<server>` compile step of `despia build` (backend-authoring.md):
//  the reader is a twin of ClosedSource/scripts/server_document.rb (closed vocabulary, raw
//  action bodies, derived keys), the emitter writes the barrel + migration a standalone
//  worker imports, and the whole step is deterministic and idempotent. Nothing is mocked;
//  every assertion is on bytes the step actually wrote.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  crudExportName, deriveKey, emitServerArtifacts, readServerDocument, ServerDocumentError, spendPlane,
} from "../src/server-document.ts";
import { buildProject } from "../src/build.ts";
import { loadConfig } from "../src/config.ts";

const NOTES = `<server>
  <head>
    <entity as="note" ownership="owner">
      <field as="title" type="text"/>
      <field as="body" type="text"/>
    </entity>
  </head>

  <route method="GET"    path="/api/notes"     entity="note" op="list"   auth="required"/>
  <route method="POST"   path="/api/notes"     entity="note" op="create" auth="required"/>
  <route method="GET"    path="/api/notes/:id" entity="note" op="get"    auth="required"/>
  <route method="PATCH"  path="/api/notes/:id" entity="note" op="update" auth="required"/>
  <route method="DELETE" path="/api/notes/:id" entity="note" op="delete" auth="required"/>
</server>
`;

function fixture(files: { [path: string]: string }): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-server-doc-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

// ── the reader ──────────────────────────────────────────────────────────────────────────

test("a declared-CRUD document reads into schema + api rows", () => {
  const doc = readServerDocument(NOTES, "server/notes.dsx", "notes");
  assert.deepEqual(Object.keys(doc.schema), ["note"]);
  assert.deepEqual(doc.schema["note"], { fields: { title: "text", body: "text" }, ownership: "owner", indexes: [] });
  assert.equal(Object.keys(doc.api).length, 5);
  assert.deepEqual(doc.api["get-api-notes"], { method: "GET", path: "/api/notes", auth: "required", op: "list", entity: "note" });
  assert.deepEqual(doc.api["patch-api-notes-id"], { method: "PATCH", path: "/api/notes/:id", auth: "required", op: "update", entity: "note" });
});

test("an <action> body is RAW text (JSE with <, && and quotes survives verbatim)", () => {
  const body = `\n    const r = await fetch('https://api.example.com/x')\n    if (r.status < 300 && r.ok) { return { ok: true, text: "<done>" } }\n    throw { reason: 'failed' }\n  `;
  const doc = readServerDocument(
    `<server><head><action as="ping">${body}</action></head><route method="GET" path="/ping" action="ping" reach="web"/></server>`,
    "server/x.dsx", "x",
  );
  assert.equal(doc.actions["ping"]!.body, body);
  assert.deepEqual(doc.reach["ping"], ["web"]);
  assert.deepEqual(doc.api["get-ping"], { method: "GET", path: "/ping", action: "ping" });
});

test("the vocabulary is CLOSED: unknown tags and attributes abort naming the line", () => {
  assert.throws(
    () => readServerDocument(`<server><head><entity as="a" ownership="owner" wat="1"><field as="t" type="text"/></entity></head><route method="GET" path="/x" entity="a" op="list"/></server>`, "server/a.dsx", "a"),
    (e: unknown) => e instanceof ServerDocumentError && e.message.includes('"wat"'),
  );
  assert.throws(
    () => readServerDocument(`<server><head/><banana/></server>`.replace("<head/>", "<head></head>") + "", "server/a.dsx", "a"),
    (e: unknown) => e instanceof ServerDocumentError && e.message.includes("<banana>"),
  );
});

test("the reader's guard rails: auth typos, both handlers, undeclared actions, empty documents", () => {
  // a route naming neither an action nor entity+op
  assert.throws(
    () => readServerDocument(`<server><head></head><route method="GET" path="/x"/></server>`, "s", "s"),
    /needs either action=.* or entity=/,
  );
  // both an action and an entity
  assert.throws(
    () => readServerDocument(`<server><head><entity as="a" ownership="owner"><field as="t" type="text"/></entity><action as="f">return 1</action></head><route method="GET" path="/x" action="f" entity="a" op="list"/></server>`, "s", "s"),
    /BOTH action and entity/,
  );
  // an undeclared action
  assert.throws(
    () => readServerDocument(`<server><head></head><route method="GET" path="/x" action="ghost"/></server>`, "s", "s"),
    /names action "ghost", which this document does not declare/,
  );
  // a document that would emit nothing
  assert.throws(
    () => readServerDocument(`<server><head><entity as="a" ownership="owner"><field as="t" type="text"/></entity></head></server>`, "s", "s"),
    /declares no routes and no tools/,
  );
  // a secret must be declared as its env name (the B4 silent class)
  assert.throws(
    () => readServerDocument(`<server><head><secret as="stripe" env="STRIPE_KEY"/><action as="f">return 1</action></head><route method="GET" path="/x" action="f"/></server>`, "s", "s"),
    /must be declared as its env name/,
  );
});

test("schema vocabulary: types, ownership, reserved fields and index targets are validated", () => {
  assert.throws(
    () => readServerDocument(`<server><head><entity as="a" ownership="owner"><field as="t" type="varchar"/></entity></head><route method="GET" path="/x" entity="a" op="list" auth="required"/></server>`, "s", "s"),
    /type "varchar" is not one of text/,
  );
  assert.throws(
    () => readServerDocument(`<server><head><entity as="a" ownership="mine"><field as="t" type="text"/></entity></head><route method="GET" path="/x" entity="a" op="list"/></server>`, "s", "s"),
    /ownership "mine" must be one of owner/,
  );
  assert.throws(
    () => readServerDocument(`<server><head><entity as="a" ownership="owner"><field as="owner_id" type="uuid"/></entity></head><route method="GET" path="/x" entity="a" op="list"/></server>`, "s", "s"),
    /RESERVED/,
  );
  assert.throws(
    () => readServerDocument(`<server><head><entity as="a" ownership="owner"><field as="t" type="text"/><index on="ghost"/></entity></head><route method="GET" path="/x" entity="a" op="list" auth="required"/></server>`, "s", "s"),
    /index "ghost" names no declared field/,
  );
});

test("a <worker> fills in the whole drain shape: POST, auth required, internal reach", () => {
  const doc = readServerDocument(
    `<server><head><action as="settle">return 1</action></head><worker queue="billing_jobs" action="settle" schedule="*/5 * * * *" idempotencyKey="order"/></server>`,
    "s", "s",
  );
  const row = doc.api["post-internal-billing-jobs-drain"];
  assert.deepEqual(row, {
    method: "POST", path: "/internal/billing-jobs/drain", action: "settle",
    auth: "required", worker: "billing_jobs", schedule: "*/5 * * * *", idempotencyKey: "order",
  });
  assert.deepEqual(doc.reach["settle"], []);
});

test("key derivation and the crud export namespace", () => {
  assert.equal(deriveKey("POST", "/orders/:id"), "post-orders-id");
  assert.equal(deriveKey("GET", "/"), "get-root");
  assert.equal(crudExportName("list-notes"), "listNotes");
  assert.equal(crudExportName("get-api-notes-id"), "getApiNotesId");
});

// ── the emitter, driven through `despia build` (the real integration surface) ─────────────

const APP = `<stack><head><variable as="n">return 0</variable></head><text value="hi"/></stack>\n`;

function project(): { root: string; cleanup: () => void } {
  return fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
    "server/notes.dsx": NOTES,
  });
}

test("despia build compiles server/*.dsx into the barrel + migration the worker imports", () => {
  const p = project();
  try {
    const result = buildProject(loadConfig(p.root));
    assert.notEqual(result.server, null);
    assert.deepEqual(result.server!.documents, ["notes"]);
    assert.equal(result.server!.routes, 5);
    assert.equal(result.server!.entities, 1);

    const barrel = readFileSync(join(p.root, "server/generated/index.ts"), "utf8");
    // entities — the EntitySpec table installEntities() consumes
    assert.match(barrel, /"entity": "note"/);
    assert.match(barrel, /"ownership": "owner"/);
    // route rows — chain = the document's name, action = the crud export
    assert.match(barrel, /"key": "get-api-notes"/);
    assert.match(barrel, /"chain": "notes"/);
    assert.match(barrel, /"action": "getApiNotes"/);
    // handlers — one crudHandler per row, keyed by chain
    assert.match(barrel, /"notes": \{/);
    assert.match(barrel, /getApiNotes: crudHandler\("note", "list"\)/);
    assert.match(barrel, /postApiNotes: crudHandler\("note", "create"\)/);
    assert.match(barrel, /deleteApiNotesId: crudHandler\("note", "delete"\)/);
    // no declared actions in this document → no declaredHandler import
    assert.ok(!barrel.includes("declaredHandler"));

    const migration = readFileSync(join(p.root, "server/generated/migration.sql"), "utf8");
    assert.match(migration, /create table if not exists dsx_note/);
    assert.match(migration, /owner_id uuid not null default auth\.uid\(\)/);
    assert.match(migration, /alter table dsx_note force row level security/);
    assert.match(migration, /create policy dsx_note_owner_all/);
    assert.match(migration, /grant select, insert, update, delete on dsx_note to authenticated/);
    assert.match(barrel, /export const migrationSql = /);

    // idempotent: the second build rewrites nothing (same bytes, same mtimes)
    const before = statSync(join(p.root, "server/generated/index.ts")).mtimeMs;
    buildProject(loadConfig(p.root));
    assert.equal(statSync(join(p.root, "server/generated/index.ts")).mtimeMs, before);
  } finally {
    p.cleanup();
  }
});

test("a declared action compiles to a declaredHandler entry with its raw body", () => {
  const p = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
    "server/api.dsx": `<server>
  <head>
    <secret as="STRIPE_KEY" env="STRIPE_KEY"/>
    <egress host="api.stripe.com"/>
    <action as="charge" inputs="order">
      const key = await dsx.module.secret.read({ name: 'STRIPE_KEY' })
      if (!key.ok) { throw { reason: 'unavailable' } }
      return { ok: true }
    </action>
  </head>
  <route method="POST" path="/charge" action="charge" auth="required" reach="web"/>
</server>
`,
  });
  try {
    const result = buildProject(loadConfig(p.root));
    assert.deepEqual(result.server!.documents, ["api"]);
    const barrel = readFileSync(join(p.root, "server/generated/index.ts"), "utf8");
    assert.match(barrel, /import \{ declaredHandler \} from "@despia-native\/server\/actions";/);
    assert.match(barrel, /charge: declaredHandler\(\{/);
    assert.match(barrel, /secrets: \["STRIPE_KEY"\]/);
    assert.match(barrel, /egress: \["api\.stripe\.com"\]/);
    assert.match(barrel, /dsx\.module\.secret\.read/);
    // the row carries the declared reach
    assert.match(barrel, /"reach": \[\s*"web"\s*\]/);
  } finally {
    p.cleanup();
  }
});

test("removing the last server document removes the generated folder (and only ours)", () => {
  const p = project();
  try {
    buildProject(loadConfig(p.root));
    assert.ok(existsSync(join(p.root, "server/generated/index.ts")));
    rmSync(join(p.root, "server/notes.dsx"));
    const result = buildProject(loadConfig(p.root));
    assert.equal(result.server, null);
    assert.ok(!existsSync(join(p.root, "server/generated")));
  } finally {
    p.cleanup();
  }
});

test("merge gates: an owner entity exposed without auth, and colliding method+path, abort the build", () => {
  const noAuth = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
    "server/notes.dsx": `<server><head><entity as="note" ownership="owner"><field as="t" type="text"/></entity></head><route method="GET" path="/api/notes" entity="note" op="list"/></server>`,
  });
  try {
    assert.throws(() => buildProject(loadConfig(noAuth.root)), /does not declare auth="required"/);
  } finally {
    noAuth.cleanup();
  }
  const dupe = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
    "server/a.dsx": `<server><head><entity as="a" ownership="public-read"><field as="t" type="text"/></entity></head><route as="a-list" method="GET" path="/api/x" entity="a" op="list"/></server>`,
    "server/b.dsx": `<server><head><entity as="b" ownership="public-read"><field as="t" type="text"/></entity></head><route as="b-list" method="GET" path="/api/x" entity="b" op="list"/></server>`,
  });
  try {
    assert.throws(() => buildProject(loadConfig(dupe.root)), /route "GET \/api\/x" is declared twice/);
  } finally {
    dupe.cleanup();
  }
});

// ── the spend plane (cost-guardrails.md — the standalone twin of prepare_server.rb) ─────

const GUARDED = `<server>
  <head>
    <entity as="note" ownership="public-read">
      <field as="title" type="text"/>
    </entity>
    <egress host="api.openai.com"/>
    <egress host="hooks.example.com" self="allow"/>
    <budget of="egress:api.openai.com" per="hour" max="2000"/>
    <budget of="queue:mail" max="9000"/>
    <budget of="requests" max="unbounded"/>
    <action as="digest">
      return 1
    </action>
  </head>
  <route method="GET" path="/api/notes" entity="note" op="list"/>
  <worker queue="mail" action="digest"/>
</server>
`;

test("budget rows read with the closed grammar: seam, per default, max, depth, self ack", () => {
  const doc = readServerDocument(GUARDED, "server/guarded.dsx", "guarded");
  assert.deepEqual(doc.budgets.map((b) => [b.of, b.per, b.max]), [
    ["egress:api.openai.com", "hour", 2000],
    ["queue:mail", "day", 9000],
    ["requests", "day", "unbounded"],
  ]);
  // every declared row knows its line — the Studio points a reader at the declaration
  assert.ok(doc.budgets.every((b) => Number.isInteger(b.line) && b.line > 1));
  assert.deepEqual(doc.egressSelf, ["hooks.example.com"]);

  const abort = (source: string, expected: RegExp): void => {
    assert.throws(() => readServerDocument(source, "server/x.dsx", "x"),
      (e: unknown) => e instanceof ServerDocumentError && expected.test(e.message), source);
  };
  const wrap = (head: string): string =>
    `<server><head><entity as="a" ownership="public-read"><field as="t" type="text"/></entity>${head}</head><route method="GET" path="/x" entity="a" op="list"/></server>`;
  // the seam list is CLOSED — a typo must not read as a guard
  abort(wrap(`<budget of="request" max="10"/>`), /not a metered seam/);
  abort(wrap(`<budget of="egress:api.x.com" max="1"/><budget of="egress:api.x.com" max="2"/>`), /declared twice/);
  abort(wrap(`<budget of="requests" per="week" max="10"/>`), /must be one of hour · day · month/);
  abort(wrap(`<budget of="requests" max="0"/>`), /positive whole number of units/);
  abort(wrap(`<budget of="requests" max="10" depth="5"/>`), /belongs on a queue budget only/);
  abort(wrap(`<budget of="queue:q" max="10" depth="lots"/>`), /positive whole number of messages/);
  abort(wrap(`<egress host="a.com" self="deny"/>`), /the only value is "allow"/);
});

test("spendPlane: guarded defaults with zero declarations, per-attribute override, validation", () => {
  const doc = readServerDocument(GUARDED, "server/guarded.dsx", "guarded");
  const plane = spendPlane([doc]);
  assert.deepEqual(plane.map((r) => r.of), [
    "data:reads", "data:writes", "egress:api.openai.com", "egress:hooks.example.com", "queue:mail", "requests",
  ]);
  // the three globals are the guarded defaults, undeclared
  assert.deepEqual(plane.find((r) => r.of === "data:reads"), { of: "data:reads", per: "day", max: 2_500_000, declared: false });
  assert.deepEqual(plane.find((r) => r.of === "data:writes"), { of: "data:writes", per: "day", max: 500_000, declared: false });
  // an undeclared egress host still gets its own default ceiling
  assert.deepEqual(plane.find((r) => r.of === "egress:hooks.example.com"), { of: "egress:hooks.example.com", per: "day", max: 25_000, declared: false });
  // a declared row overrides and carries its provenance
  const openai = plane.find((r) => r.of === "egress:api.openai.com")!;
  assert.equal(openai.per, "hour");
  assert.equal(openai.max, 2000);
  assert.equal(openai.declared, true);
  assert.equal(openai.chain, "guarded");
  assert.ok(typeof openai.line === "number");
  // PER-ATTRIBUTE override: tuning a queue's max keeps the default depth guarded
  const mail = plane.find((r) => r.of === "queue:mail")!;
  assert.equal(mail.max, 9000);
  assert.equal(mail.depth, 10_000);
  // the loud opt-out survives the merge as the word, not an absence
  assert.equal(plane.find((r) => r.of === "requests")!.max, "unbounded");

  const wrap = (head: string, body = `<route method="GET" path="/x" entity="a" op="list"/>`): string =>
    `<server><head><entity as="a" ownership="public-read"><field as="t" type="text"/></entity>${head}</head>${body}</server>`;
  // a ceiling on a host nothing can call is a typo, and a typo must not read as a guard
  assert.throws(
    () => spendPlane([readServerDocument(wrap(`<budget of="egress:api.stripe.com" max="10"/>`), "server/x.dsx", "x")]),
    /names a host no <egress> declares/,
  );
  assert.throws(
    () => spendPlane([readServerDocument(wrap(`<budget of="queue:ghost" max="10"/>`), "server/x.dsx", "x")]),
    /names a queue no <worker> drains/,
  );
  // a SUFFIX-PARENT is the aggregate-vendor ceiling the runtime's resolution defines — it builds
  const parent = spendPlane([readServerDocument(wrap(`<egress host="api.stripe.com"/><budget of="egress:stripe.com" max="500"/>`), "server/x.dsx", "x")]);
  assert.equal(parent.find((r) => r.of === "egress:stripe.com")!.max, 500);
  assert.equal(parent.find((r) => r.of === "egress:api.stripe.com")!.max, 25_000);
});

test("despia build emits the merged plane as spendBudgets and prints the opt-out loudly", () => {
  const fx = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
    "server/guarded.dsx": GUARDED,
  });
  try {
    const result = buildProject(loadConfig(fx.root));
    assert.equal(result.server!.spend.ceilings, 6);
    assert.deepEqual(result.server!.spend.unbounded, ["requests"]);
    const barrel = readFileSync(join(fx.root, "server/generated/index.ts"), "utf8");
    assert.match(barrel, /type SpendBudget/);
    assert.match(barrel, /export const spendBudgets: SpendBudget\[\] =/);
    const rows = JSON.parse(/export const spendBudgets: SpendBudget\[\] = (\[[\s\S]*?\]);/.exec(barrel)![1]!) as
      { of: string; per: string; max: number | string; depth?: number; declared?: unknown; line?: unknown }[];
    assert.deepEqual(rows.map((r) => r.of), [
      "data:reads", "data:writes", "egress:api.openai.com", "egress:hooks.example.com", "queue:mail", "requests",
    ]);
    // the barrel carries budget rows only — provenance and lines are Studio detail
    assert.ok(rows.every((r) => r.declared === undefined && r.line === undefined));
    assert.deepEqual(rows.find((r) => r.of === "queue:mail"), { of: "queue:mail", per: "day", max: 9000, depth: 10_000 });
    assert.deepEqual(rows.find((r) => r.of === "requests"), { of: "requests", per: "day", max: "unbounded" });
    // idempotent: the second build rewrites nothing
    const before = statSync(join(fx.root, "server/generated/index.ts")).mtimeMs;
    buildProject(loadConfig(fx.root));
    assert.equal(statSync(join(fx.root, "server/generated/index.ts")).mtimeMs, before);
  } finally {
    fx.cleanup();
  }
});
