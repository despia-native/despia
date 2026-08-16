//
//  repo-portability.test.ts — THE SAME SUITE, TWO STORES (full-stack.md T3, A0-SWEEP L-07).
//
//  `repo-portability.ts` holds the corpus; this file supplies the backends and runs it against
//  both. That is the whole two-implementation freeze rule, made executable:
//
//    postgres  — PGlite (the real engine) over the EMITTED migration, byte for byte.
//    firestore — the real `src/firestore.ts` over an in-process wire whose rules are PARSED from
//                the EMITTED firestore.rules (see firestore-fake.ts for what that does and does
//                not prove).
//
//  BOTH BACKENDS READ THE SAME DECLARATION: `generated/entities.json`, the file the migration and
//  the rules are themselves compiled from. Nothing in the corpus knows a table name, a document
//  path, a policy or a driver — if a case had needed one, `RepoQuery` would have been carrying a
//  Postgres-ism, which is exactly the finding this arrangement exists to produce.
//

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { installEntities, RepoSeam, type EntitySpec } from "../src/repo.ts";
import { installPostgresClient, type SqlClient } from "../src/postgres.ts";
import { installFirestore } from "../src/firestore.ts";
import { fakeFirestore, rulesFromEmitted } from "./firestore-fake.ts";
import { declaredEntities, repoPortability, type PortabilityBackend } from "./repo-portability.ts";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "..", "deploy", "supabase", "migrations", "000_dsx_schema.sql");
const RULES = join(HERE, "..", "deploy", "firebase", "firestore.rules");
const ENTITIES = join(HERE, "..", "generated", "entities.json");

const ENTITY_SPECS: EntitySpec[] = declaredEntities(readFileSync(ENTITIES, "utf-8"));
const OWNED = ENTITY_SPECS.find((e) => e.ownership === "owner");
if (OWNED === undefined) throw new Error("no owner-scoped entity is declared — the corpus has nothing to prove isolation with");
const SERVICE = ENTITY_SPECS.find((e) => e.ownership === "service");

/** What a hosted Supabase project already provides, and the emitted migration therefore assumes. */
const PLATFORM_PREAMBLE = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
`;

const postgres: PortabilityBackend = {
  name: "postgres",
  entity: OWNED.entity,
  serviceEntity: SERVICE?.entity ?? null,
  open: async (options) => {
    const db = await new PGlite();
    await db.exec(PLATFORM_PREAMBLE);
    await db.exec(readFileSync(MIGRATION, "utf-8")); // the EMITTED migration, byte for byte
    await db.exec(`
      grant usage on schema public to anon, authenticated;
      grant all on all tables in schema public to anon, authenticated;
    `);
    if (options?.isolation === false) {
      // The negative control. PGlite's own superuser bypasses RLS unconditionally, which is why
      // the transport drops to `authenticated` for a user query — turning the policy off is the
      // only way to make B's read succeed, and therefore the only way to prove it normally fails.
      await db.exec(`alter table dsx_${OWNED.entity} disable row level security`);
    }
    installEntities(ENTITY_SPECS);
    const client: SqlClient = {
      query: async (text, params) => {
        const r = await db.query(text, params as never[]);
        return { rows: r.rows as unknown[] };
      },
    };
    installPostgresClient(client);
    return { close: async () => { await db.close(); } };
  },
};

const firestore: PortabilityBackend = {
  name: "firestore",
  entity: OWNED.entity,
  serviceEntity: SERVICE?.entity ?? null,
  open: async (options) => {
    const fake = fakeFirestore({
      rules: rulesFromEmitted(readFileSync(RULES, "utf-8")), // the EMITTED rules, parsed
      enforce: options?.isolation !== false,
    });
    installEntities(ENTITY_SPECS);
    // A monotonic clock, because `created_at` has no server-side default in Firestore and two
    // documents written in the same millisecond would otherwise sort arbitrarily.
    let tick = 0;
    installFirestore({
      projectId: "dsx-portability",
      baseUrl: "http://firestore.local/v1",
      fetch: fake.fetch,
      serviceToken: () => fake.serviceToken,
      now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000),
      newId: () => globalThis.crypto.randomUUID(),
    });
    return { close: async () => { RepoSeam.transport = null; } };
  },
};

repoPortability(postgres);
repoPortability(firestore);
