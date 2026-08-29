//
//  config.ts — the DECLARED SETTINGS of the server node (plan B4: config, not env).
//
//  THE FAILURE THIS FILE EXISTS TO DELETE:
//
//      the server boots, reports healthy, and refuses every caller with a bare 401
//      because nobody set the signing secret.
//
//  Nothing anywhere said so. `identity.ts` reads its configuration from the environment
//  and — correctly, for a verifier — treats anything unverifiable as "no identity, not an
//  error". So an UNSET secret is indistinguishable from a forged token: fail-closed, and
//  completely silent. For a no-coder or an AI agent reading only the response, that is an
//  unexplainable support ticket, and it is the single most likely way to misconfigure a
//  backend nobody wrote code for.
//
//  The fix has two halves and this is the second:
//    • BUILD TIME — `prepare_server.rb` reads Core/Server/config.json and ABORTS when a
//      route needs a capability no setting provides (auth: "required" with login checking
//      off). The message names the setting and the values that would fix it.
//    • BOOT TIME — this file. A setting the emitter marked REQUIRED but the environment
//      does not carry makes the server REFUSE TO START, naming the setting, why it became
//      required, and the variable that carries it. A server that will refuse everyone
//      should never look healthy.
//
//  Secrets never travel in the generated table (`prepare_server.rb` emits the requirement,
//  never the value): they go config → deploy → the platform's secret store → env. Every
//  NON-secret setting is emitted as a declared default, and the environment still wins, so
//  a deploy can point staging at a different issuer without a rebuild.
//
//  Platform-free, like host.ts — env arrives as a function; nothing here names node: or Deno.
//

import type { SpendBudget } from "./spend.ts";

/** One setting the server must not start without (emitted by prepare_server.rb). */
export interface ServerRequirement {
  /** the config.json key */
  key: string;
  /** the environment variable that carries it */
  env: string;
  /** the dashboard label ("Signing key") — what a non-technical owner will recognise */
  friendlyName: string;
  /** where to set it, as a repo path */
  setting: string;
  /** the condition that made it required ("auth_mode is \"secret\"") */
  because?: string;
}

/** The emitted settings table (generated/config.json — `despia:server-config@1`). */
export interface ServerConfig {
  format?: string;
  module?: string;
  /** declared key → committed value. NEVER contains a `secret` entry's value. */
  settings: Record<string, unknown>;
  /** declared key → the environment variable that overrides it */
  env: Record<string, string>;
  required: ServerRequirement[];
}

/**
 * What a tree with no emitted config means: nothing is declared, so nothing is required.
 * Absence must not invent requirements — a fabricated one would refuse to boot a server
 * that is correctly configured, which is a worse failure than the one this file removes.
 */
export const NO_CONFIG: ServerConfig = { settings: {}, env: {}, required: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse + shape-check an emitted table; anything malformed is rejected, never half-read. */
export function readServerConfig(parsed: unknown): ServerConfig {
  if (!isRecord(parsed)) throw new Error("@despia-native/server: generated/config.json must be a JSON object");
  const settings = isRecord(parsed["settings"]) ? parsed["settings"] : {};
  const env: Record<string, string> = {};
  if (isRecord(parsed["env"])) {
    for (const [key, name] of Object.entries(parsed["env"])) if (typeof name === "string") env[key] = name;
  }
  const required: ServerRequirement[] = [];
  for (const row of Array.isArray(parsed["required"]) ? parsed["required"] : []) {
    if (!isRecord(row)) continue;
    const key = row["key"];
    const name = row["env"];
    // A requirement with no env name could never be satisfied at runtime, so honouring it
    // would deadlock the boot. prepare_server.rb already aborts on that case; drop it here
    // rather than trust the file.
    if (typeof key !== "string" || typeof name !== "string" || name === "") continue;
    required.push({
      key,
      env: name,
      friendlyName: typeof row["friendlyName"] === "string" ? row["friendlyName"] : key,
      setting: typeof row["setting"] === "string" ? row["setting"] : key,
      ...(typeof row["because"] === "string" ? { because: row["because"] } : {}),
    });
  }
  return { settings, env, required };
}

/**
 * The env fn every consumer should use: the PLATFORM environment first, the declared value
 * second. Env winning is deliberate — a deploy overrides staging's issuer without a rebuild,
 * and a secret (which is never in the table at all) can only ever come from the environment.
 */
export function configuredEnv(
  config: ServerConfig,
  platformEnv: (key: string) => string | undefined,
): (key: string) => string | undefined {
  const declared = new Map<string, string>();
  for (const [key, name] of Object.entries(config.env)) {
    const value = config.settings[key];
    // Only scalars belong in an environment variable; a list/object setting is read from
    // `settings` by its consumer (hostOptions below), never stringified into env.
    if (typeof value === "string" && value !== "") declared.set(name, value);
  }
  return (key: string): string | undefined => platformEnv(key) ?? declared.get(key);
}

/** Requirements the environment does not satisfy. Empty = the server may start. */
export function missingRequirements(
  config: ServerConfig,
  platformEnv: (key: string) => string | undefined,
): ServerRequirement[] {
  return config.required.filter((r) => {
    const value = platformEnv(r.env);
    return value === undefined || value === "";
  });
}

/** The message a person (or an agent reading stderr) can act on without reading this repo. */
export function missingConfigMessage(missing: readonly ServerRequirement[]): string {
  const lines = missing.map((r) => {
    const why = r.because === undefined ? "" : `\n      required because ${r.because}`;
    return `  ✖ "${r.friendlyName}" — ${r.setting}${why}\n      carried by the environment variable ${r.env}, which is unset`;
  });
  return [
    "@despia-native/server: MISSING REQUIRED CONFIG — refusing to start.",
    "",
    ...lines,
    "",
    "Starting anyway would look healthy and fail silently: every route that needs this would",
    "refuse every caller with a bare 401 and no diagnostic. Set the value for this app and",
    "redeploy (`despia deploy <target> --apply`), or export the variable for a local run.",
  ].join("\n");
}

/** Throw unless every declared requirement is satisfied. Called by both bootloaders at boot. */
export function assertConfigured(config: ServerConfig, platformEnv: (key: string) => string | undefined): void {
  const missing = missingRequirements(config, platformEnv);
  if (missing.length > 0) throw new Error(missingConfigMessage(missing));
}

/**
 * The declared settings the HOST takes as options. A malformed value THROWS rather than
 * falling back to the default: silently reverting `service_roles` to `["service_role"]`
 * because someone typed a string would re-open the internal-route hole B2 closed.
 */
/**
 * The variable that delivers the internal-caller shared secret (host.ts `internalKey`).
 *
 * Named here rather than in host.ts because host.ts is platform-free by construction and must not
 * know that environment variables exist — the bootloaders read it and hand the value in.
 */
export const INTERNAL_KEY_ENV = "DSX_INTERNAL_KEY";

/**
 * The declared event-history window (Core/Server config `event_retention_hours`) — the bound on
 * the "a disconnected subscriber misses nothing" promise, consumed by the bootloaders' retention
 * sweeps. Lives here because it reads the DECLARED table: bootloader-node's private copy read a
 * `values` key the emitter never writes, so the declaration was silently ignored and the 24h
 * default always won.
 */
export function eventRetentionHours(config: ServerConfig): number {
  const hours = Number(config.settings["event_retention_hours"]);
  return Number.isFinite(hours) && hours > 0 ? Math.trunc(hours) : 24;
}

export function hostOptions(config: ServerConfig): { maxBodyBytes?: number; serviceRoles?: string[]; internalKey?: string; spend?: SpendBudget[] } {
  const out: { maxBodyBytes?: number; serviceRoles?: string[]; internalKey?: string; spend?: SpendBudget[] } = {};
  const max = config.settings["max_body_bytes"];
  if (max !== undefined) {
    if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
      throw new Error(`@despia-native/server: config "max_body_bytes" must be a positive number (got ${JSON.stringify(max)})`);
    }
    out.maxBodyBytes = max;
  }
  const roles = config.settings["service_roles"];
  if (roles !== undefined) {
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string")) {
      throw new Error(`@despia-native/server: config "service_roles" must be a list of role names (got ${JSON.stringify(roles)})`);
    }
    out.serviceRoles = roles as string[]; // an EMPTY list is meaningful: no caller is internal
  }
  // The spend plane's emitted table (cost-guardrails.md). The emitter validated the grammar and
  // applied the guarded defaults; what is shape-checked here is the same class every other
  // setting gets — a malformed table THROWS at boot rather than silently guarding nothing,
  // because a deployment that believes it is guarded and is not is this plane's worst outcome.
  const budgets = config.settings["spend_budgets"];
  if (budgets !== undefined) {
    if (!Array.isArray(budgets)) {
      throw new Error(`@despia-native/server: config "spend_budgets" must be a list of budget rows (got ${JSON.stringify(budgets)})`);
    }
    const rows: SpendBudget[] = [];
    for (const row of budgets) {
      if (
        typeof row !== "object" || row === null ||
        typeof (row as { of?: unknown }).of !== "string" ||
        !["hour", "day", "month"].includes(String((row as { per?: unknown }).per)) ||
        // A numeric max must be a positive integer: NaN passes a bare typeof check and then
        // every >= / > comparison in chargeSpend is false forever - the deployment believes it
        // is guarded and is not, which is this block's own definition of the worst outcome.
        !((typeof (row as { max?: unknown }).max === "number" &&
           Number.isInteger((row as { max?: unknown }).max) && ((row as { max?: unknown }).max as number) > 0) ||
          (row as { max?: unknown }).max === "unbounded")
      ) {
        throw new Error(`@despia-native/server: config "spend_budgets" carries a malformed row: ${JSON.stringify(row)}`);
      }
      rows.push(row as unknown as SpendBudget);
    }
    out.spend = rows;
  }
  return out;
}
