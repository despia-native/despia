//
//  config.test.ts — the declared-settings boundary (plan B4).
//
//  THE FAILURE UNDER TEST:
//
//      the server starts, reports healthy, and refuses every caller with a bare 401
//      because nobody set the signing secret — and nothing anywhere says so.
//
//  These pin the runtime half: a setting the emitter marked REQUIRED but the environment does
//  not carry must stop the boot with a message a non-technical owner can act on. The build half
//  (auth: "required" routes with login checking off = a build ABORT) is pinned by
//  ClosedSource/scripts/server_config_guards_test.rb, which also proves no `secret` VALUE can
//  reach a generated artifact.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertConfigured, configuredEnv, hostOptions, missingRequirements, readServerConfig,
  NO_CONFIG, type ServerConfig,
} from "../src/config.ts";
import { serve } from "../src/bootloader-node.ts";

const SECRET_REQUIRED: ServerConfig = {
  settings: { auth_mode: "secret", auth_issuer: "" },
  env: { auth_issuer: "DSX_JWT_ISSUER" },
  required: [{
    key: "auth_secret",
    env: "DSX_JWT_SECRET",
    friendlyName: "Signing key",
    setting: "ClosedSource/DSX/Modules/Core/Server/config.json → auth_secret",
    because: 'auth_mode is "secret"',
  }],
};

const envOf = (map: Record<string, string>) => (key: string): string | undefined => map[key];

// ── refusing to start ────────────────────────────────────────────────────────────────────

test("config: a required setting the environment does not carry REFUSES the boot", () => {
  assert.throws(
    () => assertConfigured(SECRET_REQUIRED, envOf({})),
    (e: unknown) => {
      const message = e instanceof Error ? e.message : "";
      // Everything an owner needs, without reading this repo: the label they will recognise,
      // where to set it, why it became required, and the variable that carries it.
      assert.match(message, /Signing key/);
      assert.match(message, /Core\/Server\/config\.json → auth_secret/);
      assert.match(message, /auth_mode is "secret"/);
      assert.match(message, /DSX_JWT_SECRET/);
      return true;
    },
  );
});

test("config: an EMPTY value is missing — an exported-but-blank secret must not pass", () => {
  assert.equal(missingRequirements(SECRET_REQUIRED, envOf({ DSX_JWT_SECRET: "" })).length, 1);
  assert.equal(missingRequirements(SECRET_REQUIRED, envOf({ DSX_JWT_SECRET: "s" })).length, 0);
  assert.doesNotThrow(() => assertConfigured(SECRET_REQUIRED, envOf({ DSX_JWT_SECRET: "s" })));
});

test("config: NO declaration requires nothing — absence must never invent a requirement", () => {
  // The inverse failure: refusing to boot a correctly-configured server because a tree
  // declared no config at all would be worse than the silence B4 removes.
  assert.doesNotThrow(() => assertConfigured(NO_CONFIG, envOf({})));
});

test("config: a requirement with no env name is dropped — it could never be satisfied", () => {
  // Honouring it would deadlock every boot with no way out. The emitter already aborts on
  // this case; the runtime refuses to trust the file anyway.
  const parsed = readServerConfig({ required: [{ key: "orphan", friendlyName: "Orphan" }, { key: "ok", env: "DSX_OK" }] });
  assert.deepEqual(parsed.required.map((r) => r.key), ["ok"]);
});

// ── env layering ─────────────────────────────────────────────────────────────────────────

test("config: the platform environment WINS over the declared value", () => {
  const env = configuredEnv(
    { ...SECRET_REQUIRED, settings: { auth_issuer: "https://declared.test" } },
    envOf({ DSX_JWT_ISSUER: "https://deployed.test" }),
  );
  assert.equal(env("DSX_JWT_ISSUER"), "https://deployed.test"); // a deploy retargets staging without a rebuild
});

test("config: the declared value fills in when the environment is silent", () => {
  const env = configuredEnv({ ...SECRET_REQUIRED, settings: { auth_issuer: "https://declared.test" } }, envOf({}));
  assert.equal(env("DSX_JWT_ISSUER"), "https://declared.test");
});

test("config: a secret can ONLY come from the environment — it is not in the table to leak", () => {
  // The emitter never writes a `secret` VALUE into generated/, so there is no declared
  // fallback for it: an unset variable stays unset rather than quietly resolving.
  assert.equal(configuredEnv(SECRET_REQUIRED, envOf({}))("DSX_JWT_SECRET"), undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(SECRET_REQUIRED.settings, "auth_secret"), false);
});

// ── the host options a no-coder can actually set ─────────────────────────────────────────

test("config: declared max_body_bytes / service_roles reach the host", () => {
  const opts = hostOptions({ ...NO_CONFIG, settings: { max_body_bytes: 4096, service_roles: ["admin", "service_role"] } });
  assert.deepEqual(opts, { maxBodyBytes: 4096, serviceRoles: ["admin", "service_role"] });
});

test("config: an EMPTY service_roles list survives — no caller is internal, which is fail-closed", () => {
  assert.deepEqual(hostOptions({ ...NO_CONFIG, settings: { service_roles: [] } }).serviceRoles, []);
});

test("config: a malformed setting THROWS rather than silently reverting to the default", () => {
  // Silently defaulting service_roles back to ["service_role"] because someone typed a string
  // would re-open the internal-route hole B2 closed, and nothing would say so.
  assert.throws(() => hostOptions({ ...NO_CONFIG, settings: { service_roles: "service_role" } }), /service_roles/);
  assert.throws(() => hostOptions({ ...NO_CONFIG, settings: { max_body_bytes: 0 } }), /max_body_bytes/);
  assert.throws(() => hostOptions({ ...NO_CONFIG, settings: { max_body_bytes: "1mb" } }), /max_body_bytes/);
});

// ── the real boot path (not a fixture of the check — the check IN the bootloader) ─────────

test("node bootloader: a missing required setting stops the boot BEFORE the port opens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-generated-config-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "routes.json"), JSON.stringify([{ key: "health", chain: "server.http", action: "health", method: "GET", path: "/health" }]));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ digest: "d3" }));
    writeFileSync(join(dir, "handlers.ts"), 'export const handlers = { "server.http": { health: () => ({ up: true }) } };\n');
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      format: "despia:server-config@1",
      settings: {},
      env: {},
      required: [{ key: "auth_secret", env: "DSX_B4_UNSET_ON_PURPOSE", friendlyName: "Signing key", setting: "Core/Server → auth_secret", because: 'auth_mode is "secret"' }],
    }));
    // Revert the assertConfigured call in bootloader-node.ts and this goes green-by-serving:
    // the server would come up healthy and 401 every caller, which is the whole point.
    await assert.rejects(() => serve({ port: 0, generatedDir: dir }), /MISSING REQUIRED CONFIG[\s\S]*Signing key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("node bootloader: the same tree boots once the variable is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-generated-config-ok-"));
  process.env["DSX_B4_SET_ON_PURPOSE"] = "value";
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "routes.json"), JSON.stringify([
      { key: "health", chain: "server.http", action: "health", method: "GET", path: "/health" },
      { key: "echo", chain: "server.http", action: "echo", method: "POST", path: "/echo" },
    ]));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ digest: "d4" }));
    writeFileSync(join(dir, "handlers.ts"), 'export const handlers = { "server.http": { health: () => ({ up: true }), echo: (a) => a } };\n');
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      settings: { max_body_bytes: 2048 },
      env: {},
      required: [{ key: "auth_secret", env: "DSX_B4_SET_ON_PURPOSE", friendlyName: "Signing key", setting: "Core/Server → auth_secret" }],
    }));
    const booted = await serve({ port: 0, generatedDir: dir });
    try {
      const health = await fetch(`http://localhost:${booted.port}/health`);
      assert.equal(health.status, 200); // the `ok: true` this deepEqual used to carry now lives here
      assert.deepEqual(await health.json(), { up: true });
      // and the DECLARED body ceiling is the one in force — 2 KiB, not the 1 MiB code default.
      // This is what "config, not env" buys: a no-coder moves a number in the dashboard and the
      // running server obeys it, with no bootloader edit anywhere.
      const big = await fetch(`http://localhost:${booted.port}/echo`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: "y".repeat(4096) }),
      });
      assert.equal(big.status, 413);
    } finally {
      await booted.close();
    }
  } finally {
    delete process.env["DSX_B4_SET_ON_PURPOSE"];
    rmSync(dir, { recursive: true, force: true });
  }
});
