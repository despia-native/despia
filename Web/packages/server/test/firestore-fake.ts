//
//  firestore-fake.ts — an in-process Firestore, for the portability suite.
//
//  WHY A FAKE AT ALL, and what it is allowed to prove.
//
//  The Postgres transport has PGlite: the real engine, in-process, so its suite proves policy
//  behaviour rather than modelled behaviour. Firestore has no such thing — the official emulator
//  is a Java service, not a library — so the honest options are (a) test nothing without
//  credentials, or (b) run the REAL transport against a faithful in-process wire and be explicit
//  about the boundary. This is (b), and the boundary is:
//
//    PROVEN HERE: everything in `src/firestore.ts` — the request each op builds, the value codec
//      both ways, the row shape, the status→result mapping, and (the part that matters) that an
//      owner-scoped query is expressible at all under the rules the emitter writes.
//    NOT PROVEN HERE: that Google's Firestore behaves as this file believes. That is what
//      `firestore.live.test.ts` is for, and it SKIPS without a project.
//
//  THE FAKE'S RULES ARE READ FROM THE EMITTED FILE. `rulesFromEmitted` parses
//  `deploy/firebase/firestore.rules` — the same bytes a deploy publishes — and classifies each
//  collection by the allow-clauses the emitter actually wrote. So if `prepare_server.rb` changes
//  what it emits, this fake changes with it rather than quietly continuing to model the old
//  policy. That link is the difference between a fake that tests the system and one that tests
//  the test.
//
//  THE ONE RULE SEMANTIC THAT SURPRISES PEOPLE, modelled deliberately: rules are NOT row
//  filters. A query that COULD return a document the rule denies is refused whole — Firestore
//  does not silently narrow it. So `runQuery` on an owner collection is refused unless the query
//  itself carries `owner_id == <the caller's uid>`. That is why the transport adds the filter,
//  and this fake is where that requirement is enforced rather than assumed.
//

import type { FetchLike, FirestoreValue } from "../src/firestore.ts";

export type Ownership = "owner" | "public-read" | "service";

/**
 * Classify each collection from the EMITTED rules text.
 *
 * Deliberately keyed off the exact clauses `prepare_server.rb` writes rather than off
 * `entities.json`: reading the ownership from the declaration would make this fake agree with the
 * transport by construction, and the whole point is to check the transport against what a deploy
 * would actually publish.
 */
export function rulesFromEmitted(text: string): Record<string, Ownership> {
  const out: Record<string, Ownership> = {};
  const blocks = text.matchAll(/match\s+\/([A-Za-z0-9_]+)\/\{docId\}\s*\{([\s\S]*?)\n\s*\}/g);
  for (const block of blocks) {
    const collection = block[1]!;
    const body = block[2]!;
    if (/request\.auth\.uid == resource\.data\.owner_id/.test(body)) out[collection] = "owner";
    else if (/allow read:\s*if true/.test(body)) out[collection] = "public-read";
    else if (/allow read, write:\s*if false/.test(body)) out[collection] = "service";
  }
  return out;
}

export interface FakeOptions {
  rules: Record<string, Ownership>;
  /** false turns the rules OFF — the negative control that proves the suite can fail */
  enforce?: boolean;
  /** the credential that BYPASSES rules, standing in for a service-account access token */
  serviceToken?: string;
  /** how a bearer maps to a uid; the suite's tokens are "<sub>.jwt.sig", matching the other tests */
  subjectOf?: (token: string) => string;
}

export interface FakeFirestore {
  fetch: FetchLike;
  serviceToken: string;
  /** every stored document, as raw Firestore field maps — the wire's own shape, not a row */
  store: Map<string, Map<string, Record<string, FirestoreValue>>>;
  /** what the transport asked for, in order — so a test can assert the wire, not just the result */
  calls: { method: string; url: string; body: unknown }[];
}

interface Denial {
  status: number;
  status_code: string;
  message: string;
}

function deny(status: number, code: string, message: string): Denial {
  return { status, status_code: code, message };
}

const PERMISSION_DENIED = deny(403, "PERMISSION_DENIED", "Missing or insufficient permissions.");
const NOT_FOUND = deny(404, "NOT_FOUND", "Document not found.");

function stringOf(value: FirestoreValue | undefined): string | null {
  if (value === undefined) return null;
  return typeof value["stringValue"] === "string" ? value["stringValue"] : null;
}

/** Walk a structuredQuery `where` looking for `owner_id EQUAL <uid>` at any AND depth. */
function queryNamesOwner(where: unknown, uid: string | null): boolean {
  if (where === null || typeof where !== "object") return false;
  const node = where as Record<string, unknown>;
  const field = node["fieldFilter"] as { field?: { fieldPath?: string }; op?: string; value?: FirestoreValue } | undefined;
  if (field !== undefined) {
    return field.field?.fieldPath === "owner_id" && field.op === "EQUAL" && stringOf(field.value) === uid && uid !== null;
  }
  const composite = node["compositeFilter"] as { op?: string; filters?: unknown[] } | undefined;
  if (composite !== undefined && composite.op === "AND") {
    return (composite.filters ?? []).some((f) => queryNamesOwner(f, uid));
  }
  return false;
}

function matchesFilters(document: Record<string, FirestoreValue>, where: unknown): boolean {
  if (where === null || where === undefined || typeof where !== "object") return true;
  const node = where as Record<string, unknown>;
  const field = node["fieldFilter"] as { field?: { fieldPath?: string }; op?: string; value?: FirestoreValue } | undefined;
  if (field !== undefined) {
    const stored = document[field.field?.fieldPath ?? ""];
    return JSON.stringify(stored ?? null) === JSON.stringify(field.value ?? null);
  }
  const composite = node["compositeFilter"] as { op?: string; filters?: unknown[] } | undefined;
  if (composite !== undefined) return (composite.filters ?? []).every((f) => matchesFilters(document, f));
  return true;
}

export function fakeFirestore(options: FakeOptions): FakeFirestore {
  const enforce = options.enforce ?? true;
  const serviceToken = options.serviceToken ?? "service-account-access-token";
  const subjectOf = options.subjectOf ?? ((token: string): string => token.split(".")[0] ?? "");
  const store = new Map<string, Map<string, Record<string, FirestoreValue>>>();
  const calls: { method: string; url: string; body: unknown }[] = [];

  const collection = (name: string): Map<string, Record<string, FirestoreValue>> => {
    let c = store.get(name);
    if (c === undefined) {
      c = new Map();
      store.set(name, c);
    }
    return c;
  };

  const respond = (status: number, body: unknown): { status: number; text(): Promise<string> } => ({
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  const refuse = (d: Denial): { status: number; text(): Promise<string> } =>
    respond(d.status, { error: { code: d.status, status: d.status_code, message: d.message } });

  const fetchLike: FetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, url: rawUrl, body });

    const bearer = (init?.headers ?? {})["authorization"]?.replace(/^Bearer\s+/i, "") ?? null;
    const isService = bearer !== null && bearer === serviceToken;
    const uid = bearer === null || isService ? null : subjectOf(bearer);

    // /projects/<p>/databases/<db>/documents[...]
    const documentsAt = url.pathname.indexOf("/documents");
    if (documentsAt < 0) return refuse(deny(400, "INVALID_ARGUMENT", "not a documents path"));
    const tail = url.pathname.slice(documentsAt + "/documents".length);

    // ── runQuery ──────────────────────────────────────────────────────────────────────
    if (tail === ":runQuery") {
      const query = (body as { structuredQuery?: Record<string, unknown> })?.structuredQuery ?? {};
      const from = (query["from"] as { collectionId?: string }[] | undefined)?.[0]?.collectionId ?? "";
      const ownership = options.rules[from];
      if (enforce && ownership === "service" && !isService) return refuse(PERMISSION_DENIED);
      if (enforce && ownership === "owner" && !isService && !queryNamesOwner(query["where"], uid)) {
        // RULES ARE NOT ROW FILTERS: a query that could return a denied document is refused,
        // not narrowed. This is the branch the transport's owner filter exists to satisfy.
        return refuse(PERMISSION_DENIED);
      }
      const rows = [...collection(from).entries()]
        .filter(([, fields]) => matchesFilters(fields, query["where"]))
        .sort(([, a], [, b]) => String(b["created_at"]?.["timestampValue"] ?? "").localeCompare(String(a["created_at"]?.["timestampValue"] ?? "")))
        .slice(0, Number(query["limit"] ?? 100))
        .map(([id, fields]) => ({ document: { name: `${url.pathname.slice(0, documentsAt + 10)}/${from}/${id}`, fields }, readTime: "2026-01-01T00:00:00Z" }));
      return respond(200, rows.length === 0 ? [{ readTime: "2026-01-01T00:00:00Z" }] : rows);
    }

    const segments = tail.split("/").filter((s) => s !== "");
    const name = segments[0] ?? "";
    const docId = segments[1];
    const ownership = options.rules[name];
    const docs = collection(name);

    // ── create ────────────────────────────────────────────────────────────────────────
    if (method === "POST" && docId === undefined) {
      const id = url.searchParams.get("documentId") ?? "";
      const fields = ((body as { fields?: Record<string, FirestoreValue> })?.fields ?? {});
      if (enforce) {
        if (ownership === "service" && !isService) return refuse(PERMISSION_DENIED);
        if (ownership === "public-read" && !isService) return refuse(PERMISSION_DENIED);
        if (ownership === "owner" && !isService && (uid === null || stringOf(fields["owner_id"]) !== uid)) {
          return refuse(PERMISSION_DENIED);
        }
      }
      if (docs.has(id)) return refuse(deny(409, "ALREADY_EXISTS", "Document already exists."));
      docs.set(id, fields);
      return respond(200, { name: `${url.pathname}/${id}`.replace(/\?.*$/, ""), fields });
    }

    const existing = docId === undefined ? undefined : docs.get(docId);
    const readable = (): boolean => {
      if (!enforce || isService) return true;
      if (ownership === "public-read") return true;
      if (ownership === "service") return false;
      return uid !== null && stringOf(existing?.["owner_id"]) === uid;
    };
    const writable = (): boolean => {
      if (!enforce || isService) return true;
      if (ownership === "public-read" || ownership === "service") return false;
      return uid !== null && stringOf(existing?.["owner_id"]) === uid;
    };

    if (method === "GET") {
      if (existing === undefined) return refuse(NOT_FOUND);
      if (!readable()) return refuse(PERMISSION_DENIED);
      return respond(200, { name: url.pathname, fields: existing });
    }

    if (method === "PATCH") {
      if (url.searchParams.get("currentDocument.exists") === "true" && existing === undefined) return refuse(NOT_FOUND);
      if (!writable()) return refuse(PERMISSION_DENIED);
      const mask = url.searchParams.getAll("updateMask.fieldPaths");
      const patch = ((body as { fields?: Record<string, FirestoreValue> })?.fields ?? {});
      const merged: Record<string, FirestoreValue> = { ...(existing ?? {}) };
      for (const field of mask) {
        if (field in patch) merged[field] = patch[field]!;
        else delete merged[field]; // a masked field with no value is a delete, per the REST contract
      }
      docs.set(docId!, merged);
      return respond(200, { name: url.pathname.replace(/\?.*$/, ""), fields: merged });
    }

    if (method === "DELETE") {
      if (url.searchParams.get("currentDocument.exists") === "true" && existing === undefined) return refuse(NOT_FOUND);
      if (!writable()) return refuse(PERMISSION_DENIED);
      docs.delete(docId!);
      return respond(200, {});
    }

    return refuse(deny(405, "METHOD_NOT_ALLOWED", `${method} is not supported`));
  };

  return { fetch: fetchLike, serviceToken, store, calls };
}
