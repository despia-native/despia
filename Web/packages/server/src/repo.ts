//
//  repo.ts — the T3 runtime repository (full-stack.md decision 1: "the data interface is
//  NARROW, forever") and the declared-CRUD handler factory.
//
//  THE ONE INVARIANT THIS FILE EXISTS TO ENFORCE:
//
//      a user request must never reach the database with service-role authority.
//
//  The server runs with a service key that BYPASSES row-level security, so every other
//  protection is downstream of that single rule. It is enforced structurally, not by review:
//
//    • TWO CLIENTS, TYPE-DISTINCT. `RepoScope` (what a handler receives) exposes only
//      user-scoped operations, and carries the caller's bearer token so Postgres RLS evaluates
//      `auth.uid()` for real. The service client lives behind `ServiceRepo`, a DIFFERENT type
//      reachable only from `serviceRepo(...)` — a user-facing handler is never handed one, so
//      "accidentally ran as service-role" is not a mistake this code can express.
//    • THE FIELD ALLOWLIST IS THE SCHEMA. Writes keep only the entity's DECLARED fields
//      (generated/entities.json, the same declaration the migration and the Firestore rules
//      compile from). `id` and `owner_id` are server-assigned, so a client that posts
//      {"owner_id":"someone-else"} writes a row it owns — not one it stole.
//    • ANONYMOUS NEVER WRITES. Without an identity there is no `auth.uid()`, so an insert
//      could only succeed by falling back to service authority. It is refused instead.
//
//  Provider-agnostic by construction: the transport is a seam (`RepoTransport`) that the
//  enabled provider module fills — Postgres/PostgREST today, Firestore next. Nothing here
//  knows a vendor, which is what lets `full-stack.md`'s two-implementation freeze rule bite.
//

import type { HostContext, HostHandler } from "./host.ts";

// ── the declared schema, as the runtime sees it ──────────────────────────────────────────

export interface EntitySpec {
  entity: string;
  /** declared field name → the narrow type vocabulary (text · integer · real · boolean · timestamptz · jsonb · uuid) */
  fields: Record<string, string>;
  /** owner | public-read | service — the ONE word that decides every policy */
  ownership: string;
  indexes?: string[];
}

/** The generated table (prepare_server.rb → generated/entities.json), installed at boot. */
let registry: Record<string, EntitySpec> = {};

export function installEntities(specs: readonly EntitySpec[]): void {
  const next: Record<string, EntitySpec> = {};
  for (const spec of specs) next[spec.entity] = spec;
  registry = next;
}

export function entitySpec(entity: string): EntitySpec | null {
  return Object.prototype.hasOwnProperty.call(registry, entity) ? registry[entity]! : null;
}

// ── the transport seam (a provider module fills it) ──────────────────────────────────────

export interface RepoQuery {
  entity: string;
  op: "list" | "get" | "create" | "update" | "delete";
  /** the row id for get/update/delete */
  id?: string;
  /** already field-allowlisted by the time a provider sees it */
  values?: Record<string, unknown>;
  /** equality filters for list */
  filters?: Record<string, string>;
  /** page size for list — always bounded (see LIST_LIMIT) */
  limit?: number;
  /**
   * The caller's bearer token, or null for the SERVICE client. A provider MUST send this as
   * the request's Authorization when present: that is what makes Postgres evaluate RLS as the
   * user rather than as the service role.
   */
  token: string | null;
  /**
   * The caller's VERIFIED subject claim, or null when there is no identity. A transport that
   * speaks SQL rather than HTTP needs the subject itself (to set the request's `auth.uid()`),
   * and must never have to decode the token to find it — decoding is not verifying, and a
   * transport that learned to parse a JWT would be one refactor away from trusting an
   * unverified one. Populated ONLY from `Identity.sub`, which identity.ts sets after the
   * signature, expiry, issuer and audience checks have all passed.
   */
  subject: string | null;
  /**
   * WHICH FACE ISSUED THIS QUERY — and therefore how much authority it may run with.
   *
   * Without it, an ANONYMOUS user read and a SERVICE read are byte-identical on this wire
   * (both carry `token: null`, `subject: null`), so a transport cannot tell "nobody is logged
   * in" from "this is the server's own internal job". It would then have to pick one, and
   * picking wrong in the safe-looking direction — treating anonymous as service — hands
   * RLS-bypassing authority to any unauthenticated request. The two faces are distinct types
   * in this file precisely so that distinction is never lost; this field carries it across the
   * seam to the provider.
   */
  scope: "user" | "service";
}

export type RepoTransport = (query: RepoQuery) => Promise<unknown>;

/**
 * The provider seam — EMPTY by default, exactly like the kernel's other seams
 * (RunnerScreenSeam, AppManifest.legacyOriginSource). An unfilled seam makes every repository
 * call fail CLOSED with a message naming the fix, never fall back to some ambient client.
 */
export const RepoSeam = { transport: null as RepoTransport | null };

// ── policy ──────────────────────────────────────────────────────────────────────────────

/** Hard ceiling on a list page. An unbounded list is a data-exfiltration primitive and a DoS. */
export const LIST_LIMIT = 100;

/** Columns the SERVER owns. A client may never write these, whatever it sends. */
const SERVER_ASSIGNED = new Set(["id", "owner_id", "created_at"]);

/**
 * The closed vocabulary of repository failures.
 *
 * `saturated` is distinct from `no_provider` on purpose: a provider IS installed and configured,
 * it just cannot take more work right now. They want opposite responses — `no_provider` is a
 * deployment mistake a human must fix, `saturated` is transient and a caller may retry. Reporting
 * saturation as "no provider installed" would send an operator hunting a configuration bug that
 * does not exist while the real cause (a stalled connection) went unnamed.
 */
export type RepoErrorCode = "no_provider" | "unknown_entity" | "forbidden" | "bad_request" | "saturated";

export class RepoError extends Error {
  // a plain field, not a constructor parameter property: the workspace compiles under
  // `erasableSyntaxOnly` (types must vanish without emit), which forbids that shorthand
  readonly code: RepoErrorCode;
  constructor(message: string, code: RepoErrorCode) {
    super(message);
    this.name = "RepoError";
    this.code = code;
  }
}

/**
 * Keep ONLY the entity's declared fields, and never a server-assigned one. This is the single
 * function standing between a caller-controlled object and a write — the reason
 * `ctx.body` is separable from the merged args at all (host.ts, plan S4).
 */
export function allowedValues(spec: EntitySpec, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SERVER_ASSIGNED.has(key)) continue;          // silently dropped: it is not the caller's to set
    if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) continue; // undeclared ⇒ not storage
    out[key] = value;
  }
  return out;
}

function bearerOf(ctx: HostContext): string | null {
  const identity = ctx.identity as { token?: unknown } | null;
  const token = identity?.token;
  return typeof token === "string" && token !== "" ? token : null;
}

function subOf(ctx: HostContext): string | null {
  const identity = ctx.identity as { sub?: unknown } | null;
  return typeof identity?.sub === "string" && identity.sub !== "" ? identity.sub : null;
}

async function run(query: RepoQuery): Promise<unknown> {
  const transport = RepoSeam.transport;
  if (transport === null) {
    throw new RepoError(
      "no data provider is installed — enable Core/Server/Providers/Postgres (or Firestore) and configure its connection",
      "no_provider",
    );
  }
  return transport(query);
}

// ── the USER-SCOPED face (what a handler gets) ───────────────────────────────────────────

/**
 * Every call carries the caller's token, so the database evaluates RLS as the user. There is
 * deliberately no escape hatch on this type: reaching service authority requires naming
 * `serviceRepo` explicitly, which a generated CRUD handler never does.
 */
export interface RepoScope {
  list(entity: string, opts?: { filters?: Record<string, string>; limit?: number }): Promise<unknown>;
  get(entity: string, id: string): Promise<unknown>;
  create(entity: string, values: Record<string, unknown>): Promise<unknown>;
  update(entity: string, id: string, values: Record<string, unknown>): Promise<unknown>;
  remove(entity: string, id: string): Promise<unknown>;
}

function requireSpec(entity: string): EntitySpec {
  const spec = entitySpec(entity);
  if (spec === null) {
    throw new RepoError(`entity "${entity}" is not declared by any enabled module's schema facet`, "unknown_entity");
  }
  return spec;
}

export function repoFor(ctx: HostContext): RepoScope {
  const token = bearerOf(ctx);
  const subject = subOf(ctx);
  const scope = "user" as const;
  const boundedLimit = (want?: number): number =>
    Math.max(1, Math.min(LIST_LIMIT, Number.isFinite(want) ? Number(want) : LIST_LIMIT));
  const mustWrite = (): void => {
    // No identity ⇒ no auth.uid() ⇒ the write could only land under service authority.
    if (subOf(ctx) === null) throw new RepoError("a write requires an authenticated identity", "forbidden");
  };
  // Every method is `async`, so a refusal REJECTS rather than throwing synchronously. A
  // Promise-returning API that sometimes throws before returning a promise is a real footgun:
  // `try { repo.create(...) } catch` catches one shape and misses the other, so a caller can
  // believe it handled the failure while the rejection escapes unhandled.
  return {
    list: async (entity, opts) => {
      const spec = requireSpec(entity);
      const filters: Record<string, string> = {};
      for (const [k, v] of Object.entries(opts?.filters ?? {})) {
        if (Object.prototype.hasOwnProperty.call(spec.fields, k)) filters[k] = v; // undeclared filters are not queries
      }
      return run({ entity, op: "list", filters, limit: boundedLimit(opts?.limit), token, subject, scope });
    },
    get: async (entity, id) => { requireSpec(entity); return run({ entity, op: "get", id, token, subject, scope }); },
    create: async (entity, values) => {
      const spec = requireSpec(entity);
      mustWrite();
      return run({ entity, op: "create", values: allowedValues(spec, values), token, subject, scope });
    },
    update: async (entity, id, values) => {
      const spec = requireSpec(entity);
      mustWrite();
      return run({ entity, op: "update", id, values: allowedValues(spec, values), token, subject, scope });
    },
    remove: async (entity, id) => { requireSpec(entity); mustWrite(); return run({ entity, op: "delete", id, token, subject, scope }); },
  };
}

// ── the SERVICE face (a different type, named explicitly) ────────────────────────────────

/**
 * Service-role access: RLS does NOT apply. Reaching this is an explicit act — `serviceRepo()`
 * cannot be obtained from a `HostContext`, so a handler that wanted user scoping cannot get it
 * by accident. Reserve it for internal work (queue drains, admin jobs) on routes the gateway
 * already marks internal (`reach: []`, service-role callers only — host.ts).
 */
export interface ServiceRepo extends RepoScope {
  readonly service: true;
}

export function serviceRepo(): ServiceRepo {
  const noToken: string | null = null;
  const base: RepoScope = {
    list: async (entity, opts) => {
      requireSpec(entity);
      return run({ entity, op: "list", filters: opts?.filters ?? {}, limit: Math.max(1, Math.min(LIST_LIMIT, opts?.limit ?? LIST_LIMIT)), token: noToken, subject: null, scope: "service" });
    },
    get: async (entity, id) => { requireSpec(entity); return run({ entity, op: "get", id, token: noToken, subject: null, scope: "service" }); },
    create: async (entity, values) => run({ entity, op: "create", values: allowedValues(requireSpec(entity), values), token: noToken, subject: null, scope: "service" }),
    update: async (entity, id, values) => run({ entity, op: "update", id, values: allowedValues(requireSpec(entity), values), token: noToken, subject: null, scope: "service" }),
    remove: async (entity, id) => { requireSpec(entity); return run({ entity, op: "delete", id, token: noToken, subject: null, scope: "service" }); },
  };
  return { ...base, service: true };
}

// ── the declared-CRUD handler factory ────────────────────────────────────────────────────

/**
 * `crudHandler("order", "create")` IS the whole handler for a declared-CRUD row — the emitter
 * writes one line per row (generated/modules/<chain>/crud.generated.ts) and no author code
 * exists. Values come from `ctx.body` ONLY: the merged args bag mixes in query and path
 * segments, and a write must never be reachable from a query string.
 */
export function crudHandler(entity: string, op: EntitySpec extends never ? never : RepoQuery["op"]): HostHandler {
  return async (_args: Record<string, unknown>, ctx: HostContext): Promise<unknown> => {
    const repo = repoFor(ctx);
    const id = typeof ctx.params["id"] === "string" ? ctx.params["id"] : "";
    switch (op) {
      case "list":
        return repo.list(entity, { filters: ctx.query, limit: Number(ctx.query["limit"] ?? LIST_LIMIT) });
      case "get":
        return repo.get(entity, id);
      case "create":
        return repo.create(entity, ctx.body);
      case "update":
        return repo.update(entity, id, ctx.body);
      case "delete":
        return repo.remove(entity, id);
    }
  };
}
