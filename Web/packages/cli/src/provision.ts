//
//  provision.ts — `despia provision`: Despia's own storage inside the customer's database.
//
//  THE PRODUCT LAW. Customer-owned infrastructure is not customer-managed plumbing. They connect
//  their database once; the reserved `dsx_` tables that the runtime needs — the spend and rate
//  counters, the event feed, a table per drained queue — are ours to create, converge and verify,
//  the way any framework owns its own migration table. Nobody is asked to run psql, and nobody
//  has to know these tables exist until something is wrong with one.
//
//  WHAT IT DOES, in the order the deploy needs it: inspect the live database, create what is
//  missing, verify by reading back, and record exactly what it did. Reporting is the default and
//  `--apply` is the act, the same posture `despia deploy` takes, because this touches a real
//  database holding real data.
//
//  WHAT IT DELIBERATELY DOES NOT DO. It never touches a table it did not create: the customer's
//  own entity tables are theirs, and a `dsx_` table somebody has altered is REPORTED rather than
//  rewritten (postgres.ts states why — a restored column is not a restored constraint). It also
//  never carries a database URL of its own: the address arrives in the environment the connected
//  account already sets, so a credential is never an argument in a process list.
//

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  inspectSystemStorage,
  provisionSystemStorage,
  type ProvisionOutcome,
  type SqlClient,
  type SystemTableStatus,
} from "@despia/server/postgres";

import type { ProjectConfig } from "./config.ts";
import { readServerDocument } from "./server-document.ts";

export class ProvisionError extends Error {}

/** The env name the connected database address arrives under — one spelling, shared with the
 *  runtime's own provider residence and the deploy's secret delivery. */
export const DATABASE_URL_ENV = "DSX_DATABASE_URL";

/** The record of a run, written where the deploy artifacts live. */
export const RECEIPT_PATH = "deploy/receipt.json";

/** How the command reaches a database. Injected so the whole path is testable against a real
 *  engine; the default resolves the driver the customer's own runtime already uses. */
export type ClientFactory = (url: string) => Promise<{ client: SqlClient; close: () => Promise<void> }>;

/**
 * The default connection: `pg`, imported at the moment it is needed.
 *
 * A static import would put a driver coordinate in the OSS core for a command most invocations
 * never run. A missing driver therefore answers with the one line that fixes it rather than a
 * module-resolution stack.
 */
export const connectWithPg: ClientFactory = async (url: string) => {
  let pg: { Client: new (config: { connectionString: string }) => SqlClient & { connect(): Promise<void>; end(): Promise<void> } };
  try {
    pg = (await import("pg")) as never;
  } catch {
    throw new ProvisionError(
      "the postgres driver is not installed here — run `npm install pg` in this project, then re-run.",
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return { client, close: () => client.end() };
};

/** Every queue this project drains, read from the same documents the migration was built from —
 *  so the tables provisioned are exactly the tables the emitted schema declares. */
export function projectQueues(config: ProjectConfig): string[] {
  const dir = join(config.root, "server");
  if (!existsSync(dir)) return [];
  const queues = new Set<string>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".dsx")).sort()) {
    // A document that does not parse is skipped rather than fatal: `despia build` is what
    // refuses it, with the line, and provisioning must not become a second syntax gate.
    try {
      const doc = readServerDocument(readFileSync(join(dir, name), "utf8"), `server/${name}`, name.replace(/\.dsx$/, ""));
      for (const row of Object.values(doc.api)) if (row.worker !== undefined) queues.add(row.worker);
    } catch { /* the build names it */ }
  }
  return [...queues].sort();
}

export interface ProvisionReport {
  /** what the database looks like now */
  tables: SystemTableStatus[];
  /** tables this run created (empty when reporting only, or when nothing was missing) */
  created: string[];
  /** tables present but unusable — named, never rewritten */
  damaged: string[];
  /** true when every required table is present and the right shape */
  ready: boolean;
  /** false when this was a report, so nothing was changed */
  applied: boolean;
}

/**
 * Inspect, and on `apply` create what is missing and verify.
 *
 * Both paths answer the same shape, so the caller renders one report and the receipt records one
 * kind of fact — the difference between a plan and an act is a field, not a second function.
 */
export async function provision(
  client: SqlClient,
  queues: readonly string[],
  options: { apply: boolean },
): Promise<ProvisionReport> {
  if (!options.apply) {
    const tables = await inspectSystemStorage(client, queues);
    return {
      tables,
      created: [],
      damaged: tables.filter((t) => t.present && !t.ok).map((t) => t.table),
      ready: tables.every((t) => t.ok),
      applied: false,
    };
  }
  const outcome: ProvisionOutcome = await provisionSystemStorage(client, queues);
  return {
    tables: outcome.tables,
    created: outcome.created,
    damaged: outcome.damaged,
    ready: outcome.verified,
    applied: true,
  };
}

/**
 * The lines a person reads. Written as sentences about their deployment rather than as a table
 * of schema objects: somebody who has never heard of `dsx_rate_counter` should still learn from
 * this what is wrong and what happens next.
 */
export function renderReport(report: ProvisionReport): string[] {
  const lines: string[] = [];
  const missing = report.tables.filter((t) => !t.present);
  if (report.ready && report.created.length === 0) {
    lines.push(`Despia system storage is healthy — ${report.tables.length} internal table(s) present.`);
  } else if (report.ready) {
    lines.push(`Despia system storage provisioned — created ${report.created.length} internal table(s):`);
    for (const name of report.created) lines.push(`  + ${name}`);
  } else {
    const count = missing.length + report.damaged.length;
    lines.push(`Despia system storage needs repair — ${count} internal table(s) need attention.`);
  }
  for (const table of report.tables) {
    if (table.ok) continue;
    const what = table.present ? `altered — missing ${table.missingColumns.join(", ")}` : "missing";
    lines.push(`  ! ${table.table} (${what})`);
    lines.push(`      ${table.purpose}`);
  }
  if (!report.ready && !report.applied && missing.length > 0) {
    lines.push("");
    lines.push("Run `despia provision --apply` to create them. Nothing else in your database is touched.");
  }
  if (report.damaged.length > 0) {
    lines.push("");
    lines.push(
      "A table Despia owns has been altered. It is left exactly as it is: restoring a column does " +
        "not restore the constraint it carried, so repairing it silently could leave the deployment " +
        "broken while reporting success. Drop it and re-run to have it rebuilt.",
    );
  }
  return lines;
}

/**
 * Record what was provisioned, beside the deploy artifacts.
 *
 * The receipt is the answer to "what did Despia do to my database", and it is deliberately a
 * file in the project rather than a line in a log: it is diffable, it survives the terminal, and
 * a support conversation can start from it.
 */
export function writeReceipt(config: ProjectConfig, report: ProvisionReport, at: string): string {
  const path = join(config.root, RECEIPT_PATH);
  const body = {
    _note:
      "Written by `despia provision` / `despia deploy`. What Despia provisioned inside YOUR database: " +
      "only the reserved dsx_ system tables the runtime requires. Your own tables are never touched.",
    at,
    ready: report.ready,
    applied: report.applied,
    created: report.created,
    damaged: report.damaged,
    tables: report.tables.map((t) => ({ table: t.table, present: t.present, ok: t.ok, purpose: t.purpose })),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return RECEIPT_PATH;
}

/** The database address the connected account provides, or the one line that explains its
 *  absence. Never an argument: a URL in argv is a credential in every process list on the box. */
export function databaseUrl(env: (name: string) => string | undefined): string {
  const url = (env(DATABASE_URL_ENV) ?? "").trim();
  if (url === "") {
    throw new ProvisionError(
      `no database address — set ${DATABASE_URL_ENV} to your Postgres connection string ` +
        "(Supabase: Project Settings -> Database -> Connection string, the pooler address).",
    );
  }
  return url;
}
