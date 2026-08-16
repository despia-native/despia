//
//  repo-portability.ts — THE FREEZE INSTRUMENT (full-stack.md T3).
//
//      "the repository/auth interfaces STABILIZE only when the Firebase provider also passes
//       them — the second implementation is what stops Supabase-isms from quietly becoming
//       'the generic interface.'"
//
//  That rule needs something to pass. Before this file there was no such thing: every server
//  suite was either about the repository's own logic (recording transports) or about Postgres
//  specifically (PGlite, RLS, connections). So "Firestore passes the same suite" had no referent.
//
//  This is that referent — ONE corpus of behaviours the repository interface promises, run
//  against every transport, written so that nothing in it can name a store. If a case here needs
//  a backend-specific spelling, the interface has leaked and the leak is the finding.
//
//  Each case opens a FRESH store, because a shared one makes an ordering bug look like a policy
//  bug. The last case is the NEGATIVE CONTROL: with the store's isolation turned off, the other
//  user MUST see the row. Without it, a suite that passed because nothing was ever written would
//  look exactly like a suite that passed because isolation works.
//

import { test } from "node:test";
import { readTraceContext } from "../src/trace.ts";
import assert from "node:assert/strict";

import { crudHandler, repoFor, serviceRepo, RepoError, type EntitySpec } from "../src/repo.ts";
import type { HostContext } from "../src/host.ts";

export const ALICE = "11111111-1111-1111-1111-111111111111";
export const BOB = "22222222-2222-2222-2222-222222222222";

/** The token spelling every server suite uses; the fake Firestore reads the uid back out of it. */
export const tokenFor = (sub: string): string => `${sub}.jwt.sig`;

export function ctxFor(sub: string | null, over: Partial<HostContext> = {}): HostContext {
  return {
    buildInfo: {},
    identity: sub === null ? null : { sub, role: "authenticated", claims: {}, token: tokenFor(sub) },
    env: () => undefined,
    query: {},
    body: {},
    params: {},
    correlationId: "portability",
    trace: readTraceContext(new Headers()),
    request: new Request("https://test.invalid/"),
    ...over,
  };
}

export interface PortabilityStore {
  close(): Promise<void>;
}

export interface PortabilityBackend {
  name: string;
  /** the entity the corpus writes to — `owner` ownership, as declared in generated/entities.json */
  entity: string;
  /** a `service`-ownership entity from the same declaration, or null if the tree declares none */
  serviceEntity: string | null;
  /**
   * A reason string SKIPS every case — how a LIVE backend stays green with no credentials
   * configured. A skip proves nothing, which is why every in-process backend must stay always-on.
   */
  skip?: string | false;
  /**
   * Can this backend turn its own isolation off? An in-process store can (that is the negative
   * control); a live one usually may not be asked to, so the control is skipped there WITH A
   * REASON rather than quietly dropped.
   */
  supportsIsolationToggle?: boolean;
  /**
   * Open a fresh store with the declared entities installed and `RepoSeam` filled.
   * `isolation: false` disables the store's own isolation — the negative control, and the only
   * option a backend has to implement beyond "work".
   */
  open(options?: { isolation?: boolean }): Promise<PortabilityStore>;
}

const rowsOf = (value: unknown): Record<string, unknown>[] => value as Record<string, unknown>[];

/**
 * Register the corpus against one backend. Called once per transport from
 * `repo-portability.test.ts`; the backend name prefixes every case so a failure names the store.
 */
export function repoPortability(backend: PortabilityBackend): void {
  const NOTE = backend.entity;
  const label = (what: string): string => `portability[${backend.name}]: ${what}`;
  const skip = backend.skip ?? false;
  const caseOptions = { skip };

  const withStore = async (fn: () => Promise<void>, open?: { isolation?: boolean }): Promise<void> => {
    const store = await backend.open(open);
    try {
      await fn();
    } finally {
      await store.close();
    }
  };

  // ── ownership is assigned by the server, from the verified identity ───────────────────

  test(label("a create stamps ownership from the VERIFIED identity, never from the payload"), caseOptions, async () => {
    await withStore(async () => {
      const created = (await crudHandler(NOTE, "create")(
        {},
        { ...ctxFor(ALICE), body: { title: "alice private", body: "her secret", pinned: true, owner_id: BOB, id: "33333333-3333-3333-3333-333333333333" } },
      )) as Record<string, unknown>;

      assert.equal(created["title"], "alice private");
      assert.equal(created["owner_id"], ALICE, "a posted owner_id was written — the row would belong to someone else");
      assert.notEqual(created["id"], "33333333-3333-3333-3333-333333333333", "a posted id was written");
      assert.ok(typeof created["id"] === "string" && created["id"] !== "", "the store must assign an id");
      assert.ok(created["created_at"] !== null && created["created_at"] !== undefined, "the store must stamp created_at");
    });
  });

  // ── THE CLAIM ─────────────────────────────────────────────────────────────────────────

  test(label("user A cannot read, update or delete user B's rows"), caseOptions, async () => {
    await withStore(async () => {
      const created = (await crudHandler(NOTE, "create")(
        {},
        { ...ctxFor(ALICE), body: { title: "alice private", body: "her secret", pinned: true } },
      )) as Record<string, unknown>;
      const id = String(created["id"]);

      assert.equal(rowsOf(await repoFor(ctxFor(ALICE)).list(NOTE)).length, 1, "the owner cannot see her own row");

      assert.deepEqual(await repoFor(ctxFor(BOB)).list(NOTE), [], "BOB READ ALICE'S ROWS");
      assert.equal(await repoFor(ctxFor(BOB)).get(NOTE, id), null, "Bob fetched Alice's row by id");
      assert.equal(await repoFor(ctxFor(BOB)).update(NOTE, id, { title: "defaced" }), null, "Bob updated Alice's row");
      assert.equal(await repoFor(ctxFor(BOB)).remove(NOTE, id), null, "Bob deleted Alice's row");

      const after = rowsOf(await repoFor(ctxFor(ALICE)).list(NOTE));
      assert.equal(after.length, 1);
      assert.equal(after[0]!["title"], "alice private", "Alice's row did not survive Bob's attempts");
    });
  });

  test(label("an anonymous caller reads nothing — 'no identity' is not 'the server itself'"), caseOptions, async () => {
    await withStore(async () => {
      await crudHandler(NOTE, "create")({}, { ...ctxFor(ALICE), body: { title: "alice private" } });
      assert.deepEqual(await repoFor(ctxFor(null)).list(NOTE), [], "an anonymous read reached another user's data");
    });
  });

  test(label("an anonymous caller cannot write at all"), caseOptions, async () => {
    await withStore(async () => {
      await assert.rejects(() => repoFor(ctxFor(null)).create(NOTE, { title: "x" }), (e: unknown) => {
        assert.ok(e instanceof RepoError);
        assert.equal((e as RepoError).code, "forbidden");
        return true;
      });
    });
  });

  // ── the ordinary shape of the five operations ────────────────────────────────────────

  test(label("an update changes the named fields and leaves the rest alone"), caseOptions, async () => {
    await withStore(async () => {
      const created = (await crudHandler(NOTE, "create")(
        {},
        { ...ctxFor(ALICE), body: { title: "before", body: "kept", pinned: true } },
      )) as Record<string, unknown>;
      const updated = (await repoFor(ctxFor(ALICE)).update(NOTE, String(created["id"]), { title: "after" })) as Record<string, unknown>;

      assert.equal(updated["title"], "after");
      assert.equal(updated["body"], "kept", "an unnamed field was lost — an update must patch, not replace");
      assert.equal(updated["pinned"], true);
      assert.equal(updated["id"], created["id"]);
      assert.equal(updated["owner_id"], ALICE, "ownership must survive an update");
    });
  });

  test(label("a delete removes the row, and deleting it again answers null"), caseOptions, async () => {
    await withStore(async () => {
      const created = (await crudHandler(NOTE, "create")({}, { ...ctxFor(ALICE), body: { title: "doomed" } })) as Record<string, unknown>;
      const id = String(created["id"]);

      assert.notEqual(await repoFor(ctxFor(ALICE)).remove(NOTE, id), null, "a successful delete must report something");
      assert.equal(await repoFor(ctxFor(ALICE)).get(NOTE, id), null, "the row survived its delete");
      assert.equal(await repoFor(ctxFor(ALICE)).remove(NOTE, id), null, "deleting a row that is gone must be null, not an error");
      assert.deepEqual(await repoFor(ctxFor(ALICE)).list(NOTE), []);
    });
  });

  test(label("a get of an id that never existed is null, exactly like one that is filtered out"), caseOptions, async () => {
    await withStore(async () => {
      assert.equal(await repoFor(ctxFor(ALICE)).get(NOTE, "44444444-4444-4444-4444-444444444444"), null);
    });
  });

  // ── the declared schema decides types, not the string that arrived ───────────────────

  test(label("a list filter is typed by the DECLARED schema, not by the query string"), caseOptions, async () => {
    await withStore(async () => {
      await crudHandler(NOTE, "create")({}, { ...ctxFor(ALICE), body: { title: "pinned one", pinned: true } });
      await crudHandler(NOTE, "create")({}, { ...ctxFor(ALICE), body: { title: "loose one", pinned: false } });

      // "true" arrives as a STRING (it came off a query string) against a `boolean` field.
      const pinned = rowsOf(await repoFor(ctxFor(ALICE)).list(NOTE, { filters: { pinned: "true" } }));
      assert.equal(pinned.length, 1, "a boolean filter spelled as a string did not select one row");
      assert.equal(pinned[0]!["title"], "pinned one");

      // An UNDECLARED filter is not a query — the repository drops it rather than passing it on.
      const all = rowsOf(await repoFor(ctxFor(ALICE)).list(NOTE, { filters: { nonsense: "x" } }));
      assert.equal(all.length, 2, "an undeclared filter changed the result — it reached the store");
    });
  });

  test(label("a list page is bounded by the caller's limit"), caseOptions, async () => {
    await withStore(async () => {
      for (const title of ["a", "b", "c"]) {
        await crudHandler(NOTE, "create")({}, { ...ctxFor(ALICE), body: { title } });
      }
      assert.equal(rowsOf(await repoFor(ctxFor(ALICE)).list(NOTE, { limit: 2 })).length, 2);
      assert.equal(rowsOf(await repoFor(ctxFor(ALICE)).list(NOTE)).length, 3);
    });
  });

  test(label("an entity no module declares is refused before any round trip"), caseOptions, async () => {
    await withStore(async () => {
      await assert.rejects(() => repoFor(ctxFor(ALICE)).list("not_declared"), (e: unknown) => {
        assert.ok(e instanceof RepoError);
        assert.equal((e as RepoError).code, "unknown_entity");
        return true;
      });
    });
  });

  // ── the two FACES are not interchangeable ────────────────────────────────────────────

  const SERVICE_ENTITY = backend.serviceEntity;
  if (SERVICE_ENTITY !== null) {
    test(label("a `service` entity is invisible to a user and reachable only through the service face"), caseOptions, async () => {
      await withStore(async () => {
        const written = (await serviceRepo().create(SERVICE_ENTITY, {
          source: "stripe",
          payload: { type: "invoice.paid", lines: [1, 2, 3], nested: { ok: true } },
          received_at: "2026-05-04T10:00:00.000Z",
        })) as Record<string, unknown>;
        assert.ok(typeof written["id"] === "string" && written["id"] !== "", "the service face could not write its own table");

        const asService = rowsOf(await serviceRepo().list(SERVICE_ENTITY));
        assert.equal(asService.length, 1, "the service face cannot read what it just wrote");
        assert.equal(asService[0]!["source"], "stripe");
        assert.deepEqual(
          asService[0]!["payload"],
          { type: "invoice.paid", lines: [1, 2, 3], nested: { ok: true } },
          "a nested JSON payload did not survive the round trip intact",
        );

        // A user has no business here at all: the ownership word says so, and both stores agree.
        assert.deepEqual(await repoFor(ctxFor(ALICE)).list(SERVICE_ENTITY), [], "a user listed a service-only table");
        assert.equal(await repoFor(ctxFor(ALICE)).get(SERVICE_ENTITY, String(written["id"])), null, "a user read a service-only row");
      });
    });
  }

  // ── the negative control: this corpus must be capable of failing ─────────────────────

  const controlSkip =
    skip !== false
      ? skip
      : backend.supportsIsolationToggle === false
        ? "this backend's isolation cannot be turned off from a test — the always-on in-process backends carry the control"
        : false;

  test(label("NEGATIVE CONTROL — with isolation OFF, user B DOES read user A's row"), { skip: controlSkip }, async () => {
    await withStore(async () => {
      const created = (await crudHandler(NOTE, "create")({}, { ...ctxFor(ALICE), body: { title: "alice private" } })) as Record<string, unknown>;
      // Addressed BY ID on purpose. A list is refused or filtered partly by the query the
      // transport builds, so "B's list is empty" can be true for a reason that is not the
      // store's policy — on Firestore the transport must name the owner in the query for it to
      // be expressible at all. A get carries no such constraint: whether B sees this document is
      // decided entirely by the store, so it is the one operation whose failure proves the
      // policy is what was doing the work.
      const stolen = await repoFor(ctxFor(BOB)).get(NOTE, String(created["id"]));
      assert.notEqual(
        stolen,
        null,
        "even with isolation disabled B read nothing — this corpus is not exercising the store's policy at all",
      );
    }, { isolation: false });
  });
}

/** Read the declared entities the corpus runs against, so it never invents a schema. */
export function declaredEntities(entitiesJson: string): EntitySpec[] {
  const parsed = JSON.parse(entitiesJson) as { entities?: EntitySpec[] };
  return parsed.entities ?? [];
}
