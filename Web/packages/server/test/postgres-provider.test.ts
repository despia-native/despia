// The shipped provider owns the node-postgres options. Its defaults are part of the production
// boundary: pg's own false/zero timeout defaults and unbounded waiter queue are not acceptable.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  POSTGRES_SAFE_DEFAULTS,
  postgresProviderConfig,
} from "../generated/modules/postgres/index.ts";

const envOf = (values: Record<string, string>) => (key: string): string | undefined => values[key];

test("postgres provider: every shipped connection/query/transaction timeout is finite and nonzero", () => {
  const config = postgresProviderConfig("postgresql://app:secret@db.fixture/app", () => undefined);
  assert.deepEqual(config.pool, {
    connectionString: "postgresql://app:secret@db.fixture/app",
    max: 10,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    statement_timeout: 12000,
    lock_timeout: 5000,
    idle_in_transaction_session_timeout: 15000,
  });
  assert.deepEqual(config.guards, { maxInFlight: 100, acquireTimeoutMs: 5000 });
  for (const [name, value] of Object.entries(config.pool)) {
    if (name === "connectionString" || name === "max") continue;
    assert.equal(typeof value, "number");
    assert.ok((value as number) > 0, `${name} fell back to pg's unbounded false/zero default`);
  }
});

test("postgres provider: operators may tighten limits, and URL values cannot override them later", () => {
  const config = postgresProviderConfig(
    "postgresql://app:secret@db.fixture/app?connect_timeout=2&query_timeout=9000&statement_timeout=8000&lock_timeout=3000&idle_in_transaction_session_timeout=7000",
    envOf({
      DSX_DATABASE_CONNECTION_TIMEOUT_MS: "3000",
      DSX_DATABASE_QUERY_TIMEOUT_MS: "10000",
      DSX_DATABASE_POOL_SIZE: "4",
      DSX_DATABASE_MAX_IN_FLIGHT: "40",
    }),
  );
  assert.equal(config.pool.connectionTimeoutMillis, 2000);
  assert.equal(config.pool.query_timeout, 9000);
  assert.equal(config.pool.statement_timeout, 8000);
  assert.equal(config.pool.lock_timeout, 3000);
  assert.equal(config.pool.idle_in_transaction_session_timeout, 7000);
  assert.equal(config.pool.max, 4);
  assert.deepEqual(config.guards, { maxInFlight: 40, acquireTimeoutMs: 2000 });
  const sanitized = new URL(config.pool.connectionString);
  for (const name of [
    "connect_timeout", "connectionTimeoutMillis", "query_timeout", "statement_timeout",
    "lock_timeout", "idle_in_transaction_session_timeout",
  ]) assert.equal(sanitized.searchParams.has(name), false, `${name} was left to override constructor safety`);
});

test("postgres provider: zero/false/malformed attempts fail boot rather than disabling a deadline", () => {
  assert.throws(
    () => postgresProviderConfig("postgresql://app:secret@db.fixture/app", envOf({ DSX_DATABASE_QUERY_TIMEOUT_MS: "0" })),
    /must be a positive finite number/,
  );
  assert.throws(
    () => postgresProviderConfig("postgresql://app:secret@db.fixture/app?statement_timeout=false", () => undefined),
    /must be a positive finite number/,
  );
  assert.throws(
    () => postgresProviderConfig("https://db.fixture/app", () => undefined),
    /unsupported scheme/,
  );
  assert.equal(POSTGRES_SAFE_DEFAULTS.maxInFlight, 100);
});

test("postgres provider: canonical residence and emitted provider stay source-identical", () => {
  const generated = readFileSync(fileURLToPath(new URL("../generated/modules/postgres/index.ts", import.meta.url)), "utf-8");
  const canonical = readFileSync(
    fileURLToPath(new URL("../../../../../ClosedSource/DSX/Modules/Core/Server/Providers/Postgres/web/server/index.ts", import.meta.url)),
    "utf-8",
  );
  assert.equal(generated, canonical, "prepare_server's provider copy drifted from its canonical source");
});
