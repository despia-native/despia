//
//  Postgres provider — server residence (plan B5: the transport, INSTALLED).
//
//  This file is why `packages/server/src/postgres.ts` never names a driver: the DRIVER is the
//  provider module's own concern, carried in its own residence, so that EXCLUDING the module
//  removes the dependency along with the migration and the capability — one switch, all planes.
//  Fanned into generated/modules/postgres/ by prepare_server.rb like every server residence;
//  the emitted providers barrel binds `installDataProvider` and the bootloaders call it BEFORE
//  the port opens. Structurally typed, imports nothing outside the workspace by path — sources
//  are COPIED, so relative paths must not matter beyond the package root.
//
//  THE DRIVER LOADS LAZILY, BY NAME, in two spellings:
//    • "pg"      — Node (docker/custom): resolved from node_modules; the emitted Dockerfile
//                  installs it because this module's manifest declares it (web.server_dependencies).
//    • "npm:pg"  — Deno (Supabase edge): the npm specifier the Deno runtime resolves natively.
//  Both are EXTERNAL to every bundle (build-targets reads generated/providers.json), so the
//  bundler never inlines a vendor client into the platform-free host — the import happens at
//  boot, on the platform, in the platform's own way.
//
//  The connection string arrives via DSX_DATABASE_URL — the SAME env name the module's
//  config.json entry declares (`database_url`, type secret, required while data_backend is
//  "postgres"). By the time this runs, the B4 boot check has already refused to start without
//  it, so the empty-URL branch here is a defensive report, not a diagnostic surface.
//

import {
  installPostgresPool,
  type PostgresPoolGuardOptions,
  type SqlPool,
} from "../../../src/postgres.ts";

export interface PostgresDriverPoolConfig {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  query_timeout: number;
  statement_timeout: number;
  lock_timeout: number;
  idle_in_transaction_session_timeout: number;
}

export interface PostgresProviderRuntimeConfig {
  pool: PostgresDriverPoolConfig;
  guards: Required<PostgresPoolGuardOptions>;
}

/**
 * Safe shipped ceilings. `pg` otherwise defaults every timeout here to false/zero and keeps an
 * unbounded checkout queue. Operators may choose a TIGHTER positive value through the named env
 * variables or URL parameters; they cannot turn a ceiling off or silently loosen this profile.
 */
export const POSTGRES_SAFE_DEFAULTS = Object.freeze({
  poolSize: 10,
  maxInFlight: 100,
  connectionTimeoutMs: 5_000,
  queryTimeoutMs: 15_000,
  statementTimeoutMs: 12_000,
  lockTimeoutMs: 5_000,
  idleTransactionTimeoutMs: 15_000,
});

function tighter(raw: string | null | undefined, ceiling: number, name: string, multiplier = 1): number {
  if (raw === null || raw === undefined || raw === "") return ceiling;
  const parsed = Number(raw) * multiplier;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`@despia/server: ${name} must be a positive finite number (got ${JSON.stringify(raw)})`);
  }
  return Math.max(1, Math.min(ceiling, Math.trunc(parsed)));
}

/** Pure so the exact driver/engine limits are regression-testable without opening a socket. */
export function postgresProviderConfig(
  connectionString: string,
  env: (key: string) => string | undefined,
): PostgresProviderRuntimeConfig {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("@despia/server: DSX_DATABASE_URL must be a valid postgres:// or postgresql:// URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`@despia/server: DSX_DATABASE_URL uses unsupported scheme ${parsed.protocol}`);
  }

  const takeUrl = (name: string, ceiling: number, multiplier = 1): number => {
    const value = tighter(parsed.searchParams.get(name), ceiling, `DSX_DATABASE_URL ${name}`, multiplier);
    // pg-connection-string applies URL fields AFTER constructor fields. Delete the consumed value
    // so a `...?statement_timeout=0` cannot override the safe value we pass to the driver.
    parsed.searchParams.delete(name);
    return value;
  };
  const envLimit = (name: string, ceiling: number): number => tighter(env(name), ceiling, name);

  let connectionTimeoutMs = envLimit("DSX_DATABASE_CONNECTION_TIMEOUT_MS", POSTGRES_SAFE_DEFAULTS.connectionTimeoutMs);
  connectionTimeoutMs = Math.min(connectionTimeoutMs, takeUrl("connectionTimeoutMillis", connectionTimeoutMs));
  // libpq's spelling is seconds; node-postgres's constructor spelling above is milliseconds.
  connectionTimeoutMs = Math.min(connectionTimeoutMs, takeUrl("connect_timeout", connectionTimeoutMs, 1000));
  let queryTimeoutMs = envLimit("DSX_DATABASE_QUERY_TIMEOUT_MS", POSTGRES_SAFE_DEFAULTS.queryTimeoutMs);
  queryTimeoutMs = Math.min(queryTimeoutMs, takeUrl("query_timeout", queryTimeoutMs));
  let statementTimeoutMs = envLimit("DSX_DATABASE_STATEMENT_TIMEOUT_MS", POSTGRES_SAFE_DEFAULTS.statementTimeoutMs);
  statementTimeoutMs = Math.min(statementTimeoutMs, takeUrl("statement_timeout", statementTimeoutMs));
  let lockTimeoutMs = envLimit("DSX_DATABASE_LOCK_TIMEOUT_MS", POSTGRES_SAFE_DEFAULTS.lockTimeoutMs);
  lockTimeoutMs = Math.min(lockTimeoutMs, takeUrl("lock_timeout", lockTimeoutMs));
  let idleTransactionTimeoutMs = envLimit(
    "DSX_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
    POSTGRES_SAFE_DEFAULTS.idleTransactionTimeoutMs,
  );
  idleTransactionTimeoutMs = Math.min(
    idleTransactionTimeoutMs,
    takeUrl("idle_in_transaction_session_timeout", idleTransactionTimeoutMs),
  );

  const max = envLimit("DSX_DATABASE_POOL_SIZE", POSTGRES_SAFE_DEFAULTS.poolSize);
  const maxInFlight = envLimit("DSX_DATABASE_MAX_IN_FLIGHT", POSTGRES_SAFE_DEFAULTS.maxInFlight);
  return {
    pool: {
      connectionString: parsed.toString(),
      max,
      connectionTimeoutMillis: connectionTimeoutMs,
      query_timeout: queryTimeoutMs,
      statement_timeout: statementTimeoutMs,
      lock_timeout: lockTimeoutMs,
      idle_in_transaction_session_timeout: idleTransactionTimeoutMs,
    },
    guards: { maxInFlight, acquireTimeoutMs: connectionTimeoutMs },
  };
}

/** The two spellings of the driver, tried in platform order. */
async function loadDriver(): Promise<{ Pool: new (cfg: PostgresDriverPoolConfig) => SqlPool }> {
  try {
    const mod = (await import("pg")) as { default?: { Pool: unknown }; Pool?: unknown };
    return (mod.default ?? mod) as { Pool: new (cfg: PostgresDriverPoolConfig) => SqlPool };
  } catch {
    // The Deno (Supabase edge) spelling, built at runtime rather than written as a literal.
    // `import("npm:pg")` is resolvable by Deno and NOT by tsc, so as a literal it failed the
    // workspace typecheck (`Cannot find module 'npm:pg'`) — red for every reader of this tree,
    // in a file nobody hand-edits. A computed specifier keeps Deno's resolution byte-identical
    // while leaving tsc nothing to resolve statically; the cast below is unchanged either way.
    // THE VERSION IS PART OF THE SPECIFIER. Supabase's edge runtime resolves npm: imports against
    // a declared package set, so a bare `npm:pg` fails at boot with "Could not find constraint
    // 'pg' in the list of packages" — measured on a live deploy, and fatal: it rejects inside a
    // top-level await, killing the isolate before any handler exists. The range is this module's
    // own `server_dependencies` declaration; `postgres_driver_specifier_test.rb` fails if the two
    // ever drift, so the manifest stays the single source.
    const denoSpecifier = `npm:${"pg"}@^8.22.0`;
    const mod = (await import(denoSpecifier)) as { default?: { Pool: unknown }; Pool?: unknown };
    return (mod.default ?? mod) as { Pool: new (cfg: PostgresDriverPoolConfig) => SqlPool };
  }
}

/**
 * Fill the repository seam with a pooled Postgres transport.
 *
 * Returns what it did, so the bootloader can log an honest line. A missing URL returns
 * `installed: false` rather than throwing — the required-config gate is the loud failure
 * (it names the field and the env var); failing here again would shadow that message.
 */
export async function installDataProvider(
  env: (key: string) => string | undefined,
): Promise<{ installed: boolean; backend: string }> {
  const url = env("DSX_DATABASE_URL");
  if (url === undefined || url === "") return { installed: false, backend: "postgres" };
  const { Pool } = await loadDriver();
  const config = postgresProviderConfig(url, env);
  // One pool per boot. postgres.ts holds each transaction on ONE checked-out connection
  // (the confirmed pool-scatter leak), so pool size is throughput tuning, never correctness.
  installPostgresPool(new Pool(config.pool), config.guards);
  return { installed: true, backend: "postgres" };
}
