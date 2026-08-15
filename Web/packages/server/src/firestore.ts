//
//  firestore.ts — the SECOND repository transport (full-stack.md T3; A0-SWEEP L-07).
//
//  WHY THIS FILE IS THE POINT OF THE INTERFACE, not just another backend:
//
//      "Build against Supabase first; the repository/auth interfaces STABILIZE only when the
//       Firebase provider also passes them — the second implementation is what stops
//       Supabase-isms from quietly becoming 'the generic interface.'"    — full-stack.md, T3
//
//  So the job here is deliberately narrow: fill `RepoSeam` for Firestore WITHOUT changing
//  `RepoQuery`. Every place the two stores disagree is absorbed on this side of the seam, and
//  each of those places is called out below — if any of them had needed a new field, that field
//  would have been a Postgres-ism the interface had been carrying all along.
//
//  WHERE THE TWO STORES GENUINELY DIFFER, and how each is absorbed:
//
//   1. RULES ARE NOT ROW FILTERS. Postgres RLS filters a `select` down to the rows the policy
//      allows, so a list needs no owner predicate. Firestore evaluates rules against the QUERY:
//      a list that could return a document the rule denies is refused WHOLESALE — not filtered,
//      refused. So an owner-scoped list must carry `owner_id == <the caller's verified subject>`
//      or it fails for everyone. This transport adds that filter. It is NOT a second opinion
//      about who may read what: the emitted `deploy/firebase/firestore.rules` remains the only
//      authority, and a request that lies about the filter is refused by the rules exactly as it
//      was before. The filter is what makes an HONEST request expressible.
//   2. THERE ARE NO COLUMN DEFAULTS. The Postgres migration writes
//      `owner_id uuid not null default auth.uid()`, so the database stamps ownership. Firestore
//      has no defaults, and the emitted create rule is
//      `request.auth.uid == request.resource.data.owner_id`, so the document must arrive
//      carrying it. This transport writes `owner_id` from `RepoQuery.subject` — the same
//      verified claim `postgres.ts` puts into `set_config('request.jwt.claim.sub', …)`, and the
//      same one the repository's field allowlist already refuses to let a client supply. Same
//      fact, same source, stamped one layer further out because that is where the store's
//      contract puts it.
//   3. DENIAL IS AN ERROR, NOT AN EMPTY RESULT. An RLS-filtered `get` is indistinguishable from
//      a row that does not exist — deliberately, since confirming existence to someone not
//      allowed to read it is itself a leak. Firestore answers PERMISSION_DENIED. Single-document
//      reads and writes therefore map 403 and 404 to the SAME `null` the SQL transport returns,
//      preserving the interface's semantics rather than the vendor's.
//   4. VALUES ARE TYPED ON THE WIRE. SQL sends a parameter and lets the column decide; Firestore
//      names the type in the payload (`stringValue`/`integerValue`/…). The declared schema —
//      the same `generated/entities.json` the migration and the rules compile from — is what
//      resolves it, so the narrow type vocabulary earns its keep a second time.
//
//  SECURITY POSTURE — WHAT THIS FILE DELIBERATELY DOES NOT DO:
//
//  It verifies nothing, mints nothing, and decides nothing about identity. `RepoQuery.token` is
//  a token identity.ts already verified; this transport attaches it so Firestore's rules
//  evaluate `request.auth` for real, which is the exact analogue of forwarding the bearer to
//  PostgREST. The SERVICE credential is INJECTED (`serviceToken`), never derived here: turning a
//  service-account key into an access token is JWT minting, it belongs to the provider module's
//  own residence and its platform's metadata server, and a transport that learned to do it would
//  be one refactor away from doing it with the wrong key.
//
//  ZERO DEPENDENCIES BY CONSTRUCTION. This speaks the Firestore REST API over `fetch`, which is
//  web-standard on Node 22, Deno and every edge runtime — so unlike the Postgres transport there
//  is no driver for a provider module to carry and nothing for a bundler to mark external. The
//  `fetch` seam is injectable so the wire is testable in-process.
//

import { entitySpec, RepoError, RepoSeam, type EntitySpec, type RepoQuery } from "./repo.ts";

// ── the wire vocabulary ─────────────────────────────────────────────────────────────────

/** A Firestore `Value` — one of a closed set of typed wrappers. */
export type FirestoreValue = Record<string, unknown>;

export interface FirestoreDocument {
  /** projects/<p>/databases/<db>/documents/<collection>/<id> */
  name?: string;
  fields?: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface FirestoreEndpoint {
  projectId: string;
  /** Firestore database id — "(default)" unless the project uses named databases. */
  databaseId?: string;
  /** REST root. An emulator or an in-process fake points this elsewhere. */
  baseUrl?: string;
  /**
   * The SERVICE credential, for `scope: "service"` queries. A function, because an access token
   * expires and the caller — the provider residence — owns refreshing it. Returning null means
   * the deployment has no service credential, and a service query then fails CLOSED rather than
   * silently running unauthenticated.
   */
  serviceToken?: () => string | null | Promise<string | null>;
  /** the wire; defaults to the runtime's own `fetch` */
  fetch?: FetchLike;
  /** injectable clock — `created_at` has no server-side default in Firestore (see the header) */
  now?: () => Date;
  /** injectable id source — the analogue of the table's `default gen_random_uuid()` */
  newId?: () => string;
}

interface ResolvedEndpoint {
  projectId: string;
  databaseId: string;
  baseUrl: string;
  serviceToken: () => string | null | Promise<string | null>;
  wire: FetchLike;
  now: () => Date;
  newId: () => string;
}

/** Collection names mirror the tables exactly — `dsx_<entity>`, one spelling across all emitters. */
const COLLECTION_PREFIX = "dsx_";

/**
 * Same snake_case grammar `prepare_server.rb` enforces on a declaration and `postgres.ts`
 * re-checks at the point of SQL concatenation. Firestore has no injection surface the way SQL
 * does — every name lands in a JSON field path or a URL segment — but a name that is not a legal
 * identifier names nothing the emitters ever created, and saying so beats a 404 from Google.
 */
const IDENT = /^[a-z][a-z0-9_]*$/;

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) throw new RepoError(`${what} "${name}" is not a legal identifier`, "bad_request");
  return name;
}

const collectionOf = (entity: string): string => COLLECTION_PREFIX + ident(entity, "entity");

/** Columns the SERVER owns, mirrored from repo.ts — they are not part of the declared fields map. */
const ID_FIELD = "id";
const OWNER_FIELD = "owner_id";
const CREATED_FIELD = "created_at";

// ── the value codec ─────────────────────────────────────────────────────────────────────

/** Free-form JSON (the `jsonb` type) → a Firestore Value, recursively. */
export function encodeJson(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeJson) } };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "object") {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields[k] = encodeJson(v);
    return { mapValue: { fields } };
  }
  // A function, a symbol or a bigint is not storage. Refusing beats writing "[object Object]".
  return { nullValue: null };
}

/**
 * A declared field's value → a Firestore Value, using the DECLARED type rather than the runtime
 * shape of what arrived. This is what makes `?pinned=true` from a query string store a boolean
 * here and compare as one in a filter, exactly as the SQL transport's parameter binds to a
 * `boolean` column. Guessing from the JS type instead would make the same request mean different
 * things on the two stores, which is precisely the divergence the freeze rule exists to catch.
 */
export function encodeValue(declaredType: string | undefined, value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  switch (declaredType) {
    case "text":
    case "uuid":
      return { stringValue: String(value) };
    case "integer": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new RepoError(`"${String(value)}" is not an integer`, "bad_request");
      return { integerValue: String(Math.trunc(n)) };
    }
    case "real": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new RepoError(`"${String(value)}" is not a number`, "bad_request");
      return { doubleValue: n };
    }
    case "boolean": {
      if (typeof value === "boolean") return { booleanValue: value };
      const s = String(value).toLowerCase();
      if (s === "true" || s === "false") return { booleanValue: s === "true" };
      throw new RepoError(`"${String(value)}" is not a boolean`, "bad_request");
    }
    case "timestamptz": {
      const d = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(d.getTime())) throw new RepoError(`"${String(value)}" is not a timestamp`, "bad_request");
      return { timestampValue: d.toISOString() };
    }
    case "jsonb":
      return encodeJson(value);
    default:
      // An undeclared field cannot reach here — the repository's allowlist drops it long before —
      // so this is the belt to that braces: store it as text rather than inventing a type.
      return { stringValue: String(value) };
  }
}

/** A Firestore Value → plain JSON. The inverse of `encodeJson`, dispatching on the present key. */
export function decodeValue(value: FirestoreValue | undefined): unknown {
  if (value === undefined || value === null) return null;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return Boolean(value["booleanValue"]);
  if ("stringValue" in value) return String(value["stringValue"]);
  if ("integerValue" in value) return Number(value["integerValue"]);
  if ("doubleValue" in value) return Number(value["doubleValue"]);
  if ("timestampValue" in value) return String(value["timestampValue"]);
  if ("bytesValue" in value) return String(value["bytesValue"]);
  if ("referenceValue" in value) return String(value["referenceValue"]);
  if ("geoPointValue" in value) return value["geoPointValue"];
  if ("arrayValue" in value) {
    const inner = (value["arrayValue"] ?? {}) as { values?: FirestoreValue[] };
    return (inner.values ?? []).map((v) => decodeValue(v));
  }
  if ("mapValue" in value) {
    const inner = (value["mapValue"] ?? {}) as { fields?: Record<string, FirestoreValue> };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inner.fields ?? {})) out[k] = decodeValue(v);
    return out;
  }
  return null;
}

/**
 * A document → the row shape the repository's callers already expect from Postgres:
 * `id` plus every stored field. `select *` returns the server-assigned columns too, so this does
 * — a caller that reads `created.owner_id` (the RLS suites do, and so does any handler checking
 * what it just wrote) must get the same answer from either store.
 */
export function decodeDocument(document: FirestoreDocument, spec?: EntitySpec): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  // Absent is NULL, not missing. `select *` yields every column of a Postgres row including the
  // ones nobody wrote; a Firestore document simply has no key for them. Filling the declared
  // shape is what makes `row.owner_id === null` true on both stores instead of `undefined` on
  // one — the sort of difference a caller only discovers after switching backends.
  if (spec !== undefined) {
    row[OWNER_FIELD] = null;
    row[CREATED_FIELD] = null;
    for (const field of Object.keys(spec.fields)) row[field] = null;
  }
  for (const [key, value] of Object.entries(document.fields ?? {})) row[key] = decodeValue(value);
  const name = document.name ?? "";
  const id = name.slice(name.lastIndexOf("/") + 1);
  if (id !== "") row[ID_FIELD] = id;
  return row;
}

// ── the request builder (pure — no wire, no credential) ─────────────────────────────────

export interface FirestoreRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** path + query, relative to `baseUrl` */
  url: string;
  body?: unknown;
}

interface BuildContext {
  projectId: string;
  databaseId: string;
  spec: EntitySpec;
  now: () => Date;
  newId: () => string;
}

const documentsRoot = (ctx: BuildContext): string =>
  `/projects/${ctx.projectId}/databases/${ctx.databaseId}/documents`;

/**
 * Does this query have to name its owner to be expressible at all?
 *
 * Only for an owner-scoped entity read by a USER — see header note 1. A `service` scope reaches
 * Firestore with a credential that bypasses rules (the Admin path the emitted rules assume), and
 * a `public-read` or `service` entity's rules do not mention `owner_id`.
 */
function ownerFilterRequired(spec: EntitySpec, query: RepoQuery): boolean {
  return spec.ownership === "owner" && query.scope === "user";
}

export function buildFirestoreRequest(ctx: BuildContext, query: RepoQuery): FirestoreRequest {
  const collection = collectionOf(query.entity);
  const root = documentsRoot(ctx);

  switch (query.op) {
    case "get":
      return { method: "GET", url: `${root}/${collection}/${encodeURIComponent(String(query.id ?? ""))}` };

    case "list": {
      const filters: FirestoreValue[] = [];
      for (const [field, value] of Object.entries(query.filters ?? {})) {
        filters.push(fieldFilter(ident(field, "filter"), encodeValue(ctx.spec.fields[field], value)));
      }
      if (ownerFilterRequired(ctx.spec, query)) {
        // The verified subject, not anything the caller sent. A list with no identity would then
        // filter on null and match nothing — which is the same empty answer the `anon` role gets
        // from an owner-policy table in Postgres.
        filters.push(fieldFilter(OWNER_FIELD, { stringValue: query.subject ?? "" }));
      }
      const where =
        filters.length === 0
          ? undefined
          : filters.length === 1
            ? filters[0]
            : { compositeFilter: { op: "AND", filters } };
      return {
        method: "POST",
        url: `${root}:runQuery`,
        body: {
          structuredQuery: {
            from: [{ collectionId: collection }],
            ...(where === undefined ? {} : { where }),
            // Same order the SQL transport asks for, so paging reads the same on both stores.
            orderBy: [{ field: { fieldPath: CREATED_FIELD }, direction: "DESCENDING" }],
            limit: query.limit ?? 100,
          },
        },
      };
    }

    case "create": {
      const id = ctx.newId();
      const fields: Record<string, FirestoreValue> = {};
      for (const [field, value] of Object.entries(query.values ?? {})) {
        fields[ident(field, "column")] = encodeValue(ctx.spec.fields[field], value);
      }
      // The two columns the migration gives Postgres as DEFAULTS, and Firestore cannot (header
      // note 2). `owner_id` comes from the verified subject and nowhere else.
      if (ctx.spec.ownership === "owner") fields[OWNER_FIELD] = { stringValue: query.subject ?? "" };
      fields[CREATED_FIELD] = { timestampValue: ctx.now().toISOString() };
      return {
        method: "POST",
        url: `${root}/${collection}?documentId=${encodeURIComponent(id)}`,
        body: { fields },
      };
    }

    case "update": {
      const fields: Record<string, FirestoreValue> = {};
      const mask: string[] = [];
      for (const [field, value] of Object.entries(query.values ?? {})) {
        const name = ident(field, "column");
        fields[name] = encodeValue(ctx.spec.fields[field], value);
        mask.push(name);
      }
      if (mask.length === 0) throw new RepoError("an update needs at least one declared field", "bad_request");
      // The mask is what makes this a PATCH and not a replace: a field the caller did not name
      // must survive, exactly as `update … set title = $1` leaves every other column alone.
      // `currentDocument.exists=true` is what makes an update of a missing row answer 404 (→ null)
      // instead of silently creating it, which is what an unmasked Firestore PATCH does.
      const params = [...mask.map((m) => `updateMask.fieldPaths=${encodeURIComponent(m)}`), "currentDocument.exists=true"];
      return {
        method: "PATCH",
        url: `${root}/${collection}/${encodeURIComponent(String(query.id ?? ""))}?${params.join("&")}`,
        body: { fields },
      };
    }

    case "delete":
      return {
        method: "DELETE",
        url: `${root}/${collection}/${encodeURIComponent(String(query.id ?? ""))}?currentDocument.exists=true`,
      };
  }
}

function fieldFilter(field: string, value: FirestoreValue): FirestoreValue {
  return { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value } };
}

// ── the transport ───────────────────────────────────────────────────────────────────────

/**
 * The three failure classes, kept apart because they mean genuinely different things.
 *
 * `403 PERMISSION_DENIED` is THE RULES SPEAKING — a policy decision about this identity and this
 * document, which for a single document is the same fact an RLS-filtered row carries (header
 * note 3), so it becomes `null`.
 *
 * `401 UNAUTHENTICATED` is not a policy decision at all: it says the CREDENTIAL is missing or
 * expired. Folding it into the same `null` would let an expired service token read as "the
 * database is empty" — every drain quiet, every list blank, nothing anywhere naming the cause.
 * It throws.
 */
const RULES_DENIED = 403;
const UNAUTHENTICATED = 401;
const MISSING = 404;
const OVERLOADED = new Set([429, 503, 504]);

function resolve(endpoint: FirestoreEndpoint): ResolvedEndpoint {
  const wire = endpoint.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike | undefined);
  if (wire === undefined) {
    throw new RepoError("this runtime has no fetch — pass one to installFirestore", "no_provider");
  }
  return {
    projectId: endpoint.projectId,
    databaseId: endpoint.databaseId ?? "(default)",
    baseUrl: (endpoint.baseUrl ?? "https://firestore.googleapis.com/v1").replace(/\/+$/, ""),
    serviceToken: endpoint.serviceToken ?? ((): null => null),
    wire,
    now: endpoint.now ?? ((): Date => new Date()),
    newId: endpoint.newId ?? ((): string => {
      const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
      return c?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    }),
  };
}

/**
 * WHICH CREDENTIAL THIS QUERY TRAVELS WITH — the whole of this transport's authority story.
 *
 *   user  → the caller's own verified bearer, so Firestore evaluates its rules as that user.
 *           No token means no identity, and the rules answer accordingly (an owner collection
 *           yields nothing) — the same place an anonymous SQL request lands as `anon`.
 *   service → the injected service credential, which bypasses rules. That is the Admin path the
 *           emitted rules already assume for `service` entities ("allow read, write: if false"
 *           plus a bypassing credential is how those collections are reachable at all).
 *
 * A service query with no configured credential FAILS. It must never fall through to an
 * unauthenticated request that the rules would then judge as a stranger — the failure would be a
 * confusing permission error instead of the deployment mistake it actually is.
 */
async function authorizationFor(endpoint: ResolvedEndpoint, query: RepoQuery): Promise<string | null> {
  if (query.scope === "service") {
    const token = await endpoint.serviceToken();
    if (token === null || token === "") {
      throw new RepoError(
        "a service-scoped query needs Firestore's service credential — configure the provider module's serviceToken",
        "no_provider",
      );
    }
    return token;
  }
  return query.token;
}

interface WireFailure {
  status: number;
  status_code: string;
  message: string;
}

function failureOf(status: number, text: string): WireFailure {
  // Google's error envelope is `{ "error": { "code", "message", "status" } }`. Parsed for the
  // named status only; the free-text message is kept for the SERVER log (host.ts never lets a
  // handler's failure text reach a client) and never re-interpreted.
  let statusCode = "";
  let message = "";
  try {
    const parsed = JSON.parse(text) as { error?: { status?: unknown; message?: unknown } };
    statusCode = typeof parsed.error?.status === "string" ? parsed.error.status : "";
    message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
  } catch {
    message = text.slice(0, 200);
  }
  return { status, status_code: statusCode, message };
}

function throwFor(query: RepoQuery, failure: WireFailure): never {
  if (OVERLOADED.has(failure.status)) {
    throw new RepoError(`firestore is unavailable (${failure.status} ${failure.status_code})`, "saturated");
  }
  if (failure.status === UNAUTHENTICATED) {
    throw new RepoError(
      `firestore rejected the credential on this ${query.op} (${failure.status_code || failure.status}) — ` +
        "the caller's token or the service credential is missing, malformed or expired",
      "forbidden",
    );
  }
  if (failure.status === RULES_DENIED) {
    throw new RepoError(
      `firestore refused this ${query.op} on "${query.entity}" (${failure.status_code || failure.status}) — ` +
        "the security rules did not allow it for this identity",
      "forbidden",
    );
  }
  if (failure.status === 400) {
    throw new RepoError(`firestore rejected the ${query.op} on "${query.entity}": ${failure.message}`, "bad_request");
  }
  throw new RepoError(`firestore ${query.op} on "${query.entity}" failed (${failure.status} ${failure.status_code})`, "bad_request");
}

/**
 * Fill the repository seam with a Firestore transport.
 *
 * `list` returns the rows; every single-row op returns the row or null — the same contract the
 * SQL transport keeps, which is the contract that has to hold for `RepoQuery` to be an interface
 * rather than a description of Postgres.
 *
 * The QUEUE seam (queue.ts) is deliberately left ALONE. A queue needs an atomic claim two drains
 * cannot both win; in Firestore that is a transaction with a per-document precondition and a
 * retry loop, which is a different protocol from SKIP LOCKED and deserves to be written as one
 * rather than approximated. Leaving the seam empty means `drainQueue` fails closed naming the
 * fix, which is the honest answer until it is written.
 */
export function installFirestore(endpoint: FirestoreEndpoint): void {
  const resolved = resolve(endpoint);

  RepoSeam.transport = async (query: RepoQuery): Promise<unknown> => {
    const spec = entitySpec(query.entity);
    if (spec === null) {
      // repoFor() already checks this; a transport is reachable directly (the CRUD emitter binds
      // it, tests drive it) and the declared schema is what tells this file a field's type.
      throw new RepoError(`entity "${query.entity}" is not declared by any enabled module's schema facet`, "unknown_entity");
    }
    // A READ WHOSE ANSWER IS KNOWABLY EMPTY FROM THE DECLARATION IS ANSWERED WITHOUT ASKING.
    //
    // Two cases, and in both of them the two stores spell the same "nothing" differently while
    // only one spelling is honest:
    //
    //   • no identity, owner-scoped entity. In Postgres the request runs as `anon`, the owner
    //     policy compares `owner_id = auth.uid()` against a NULL uid, and the answer is no rows.
    //     Firestore's emitted rule opens with `request.auth != null`, so the same request is
    //     REFUSED outright.
    //   • a user reading a `service` entity. Postgres has RLS on and no policy, so a list yields
    //     nothing; Firestore's emitted rule is `allow read, write: if false`, so it is refused.
    //
    // A refusal is also exactly what a missing composite index or a botched rules deploy looks
    // like, so mapping those 403s to an empty list would make a real misconfiguration
    // indistinguishable from an empty result. Deciding them here instead keeps both facts
    // legible: this is the answer the DECLARATION already gives, and any 403 that does reach the
    // caller is a genuine one.
    //
    // This can only ever DENY — it consults no credential, grants nothing, and covers only reads.
    // Writes go to the store and are refused there (the repository already refuses an anonymous
    // write before any transport is called), so the rules remain the sole authority on every
    // request whose answer is not already fixed by the schema.
    const knowablyEmpty =
      query.scope === "user" &&
      (query.op === "list" || query.op === "get") &&
      ((spec.ownership === "owner" && query.subject === null) || spec.ownership === "service");
    if (knowablyEmpty) return query.op === "list" ? [] : null;

    const request = buildFirestoreRequest(
      { projectId: resolved.projectId, databaseId: resolved.databaseId, spec, now: resolved.now, newId: resolved.newId },
      query,
    );
    const authorization = await authorizationFor(resolved, query);

    const response = await resolved.wire(resolved.baseUrl + request.url, {
      method: request.method,
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization: `Bearer ${authorization}` }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    const text = await response.text();

    if (response.status < 200 || response.status >= 300) {
      const failure = failureOf(response.status, text);
      // HEADER NOTE 3, in one line: for a single document, "you may not see it" and "it is not
      // there" must be the same answer, because the SQL transport cannot tell them apart either.
      const single = query.op === "get" || query.op === "update" || query.op === "delete";
      if (single && (failure.status === MISSING || failure.status === RULES_DENIED)) return null;
      throwFor(query, failure);
    }

    const parsed: unknown = text === "" ? {} : JSON.parse(text);

    if (query.op === "list") {
      // runQuery streams `{document?, readTime, skippedResults?}` entries; entries without a
      // document are cursors/heartbeats, not rows.
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const rows: Record<string, unknown>[] = [];
      for (const entry of entries) {
        const document = (entry as { document?: FirestoreDocument }).document;
        if (document !== undefined) rows.push(decodeDocument(document, spec));
      }
      return rows;
    }

    if (query.op === "delete") {
      // Firestore answers `{}`; the SQL transport answers the deleted id. Same information, and
      // a caller that checks for null to mean "nothing was deleted" keeps working.
      return { [ID_FIELD]: String(query.id ?? "") };
    }

    return decodeDocument(parsed as FirestoreDocument, spec);
  };
}
