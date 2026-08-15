//
//  link.test.ts — RUNG TWO OF THE RESOLUTION LADDER.
//
//  facet-contracts.md: "a call resolves local → declared reach over the link → typed
//  `unavailable`". These pin the middle rung, and — just as importantly — that adding it changed
//  nothing about the other two. The properties under test are the ones a link can quietly break:
//
//    1. A LOCAL action always wins. The link is a fallback, never an interception; a build that
//       ships an action locally must not start making network calls for it.
//    2. NO LINK ⇒ NO CHANGE. With no transport installed, every typed-absence answer
//       (`not_loaded`, `excluded`, `unsupported_platform`, `unknown_action`) is byte-identical
//       to what it was before the rung existed. A table without a transport must not swallow
//       them either, or a caller goes hunting for a network fault that does not exist.
//    3. The failure vocabulary is CLOSED. A transport failure is `unreachable` — the spelling
//       durability P4 froze and the errors corpus pins. A SERVER answer keeps the server's own
//       reason, because "the network failed" and "the server said no" are different facts and a
//       caller acts on them differently.
//    4. The token never leaves its origin, and a path argument is DATA — it cannot add segments.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ModuleRegistry, defineModule, LinkSeam, ModuleCallError, type LinkRoute } from "../src/bus.ts";
import { createHttpLink } from "../src/link.ts";

const NOTES: LinkRoute = { chain: "server.http", action: "listNotes", method: "GET", path: "/notes", auth: "required" };
const ONE_NOTE: LinkRoute = { chain: "server.http", action: "getNote", method: "GET", path: "/notes/:id", auth: "required" };
const CREATE: LinkRoute = { chain: "server.http", action: "createNote", method: "POST", path: "/notes", auth: "required" };

function reset(): void {
  LinkSeam.routes = [];
  LinkSeam.invoke = null;
}

/** A transport that records what it was asked for and answers with a fixed value. */
function recorder(answer: unknown = { ok: true }): { invoke: (r: LinkRoute, a: Record<string, unknown>) => Promise<unknown>; calls: { route: LinkRoute; args: Record<string, unknown> }[] } {
  const calls: { route: LinkRoute; args: Record<string, unknown> }[] = [];
  return {
    calls,
    invoke: async (route, args) => {
      calls.push({ route, args });
      return answer;
    },
  };
}

// ── 1. the ladder's order ────────────────────────────────────────────────────────────────

test("ladder: a LOCAL action wins — the link is a fallback, never an interception", async () => {
  reset();
  let localRan = false;
  ModuleRegistry.register(defineModule({ scheme: "orderslocal", actions: { create: async () => { localRan = true; return "local"; } } }));
  const rec = recorder("FROM THE SERVER");
  LinkSeam.routes = [{ chain: "orderslocal", action: "create", method: "POST", path: "/orders" }];
  LinkSeam.invoke = rec.invoke;

  const result = await ModuleRegistry.dispatch("orderslocal", "create", {});
  assert.equal(result, "local", "the link answered a call the build implements locally");
  assert.ok(localRan);
  assert.equal(rec.calls.length, 0, "the transport was consulted even though a local action exists");
  reset();
});

test("ladder: no local module ⇒ the call goes over the link", async () => {
  reset();
  const rec = recorder({ rows: 2 });
  LinkSeam.routes = [NOTES];
  LinkSeam.invoke = rec.invoke;

  const result = await ModuleRegistry.dispatch("server.http", "listNotes", { pinned: "true" });
  assert.deepEqual(result, { rows: 2 });
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]!.route.path, "/notes");
  assert.deepEqual(rec.calls[0]!.args, { pinned: "true" }, "the caller's arguments must reach the route unchanged");
  reset();
});

test("ladder: a chain that is PARTLY local links per-ACTION, not per-chain", async () => {
  reset();
  ModuleRegistry.register(defineModule({ scheme: "orders", actions: { draft: async () => "local-draft" } }));
  const rec = recorder("server-submit");
  LinkSeam.routes = [{ chain: "orders", action: "submit", method: "POST", path: "/orders/submit" }];
  LinkSeam.invoke = rec.invoke;

  assert.equal(await ModuleRegistry.dispatch("orders", "draft", {}), "local-draft");
  assert.equal(await ModuleRegistry.dispatch("orders", "submit", {}), "server-submit", "a server-only action on a partly-local chain never reached the link");
  reset();
});

// ── 2. absence is unchanged when there is no link ────────────────────────────────────────

test("no transport installed ⇒ the typed absence answers are exactly as before", async () => {
  reset();
  await assert.rejects(ModuleRegistry.dispatch("nosuch", "thing", {}), (e: ModuleCallError) => {
    assert.equal(e.code, "not_loaded");
    return true;
  });
  reset();
});

test("a link TABLE without a transport must not swallow `not_loaded`", async () => {
  reset();
  // the build emitted the table but nothing installed a transport — reporting `unreachable`
  // here would send a caller looking for a network problem that does not exist
  LinkSeam.routes = [NOTES];
  LinkSeam.invoke = null;
  await assert.rejects(ModuleRegistry.dispatch("server.http", "listNotes", {}), (e: ModuleCallError) => {
    assert.equal(e.code, "not_loaded", "a table with no transport changed the absence answer");
    return true;
  });
  reset();
});

test("an action absent from BOTH the build and the link table is still `unknown_action`", async () => {
  reset();
  ModuleRegistry.register(defineModule({ scheme: "orders", actions: { draft: async () => "d" } }));
  LinkSeam.routes = [NOTES]; // a different chain entirely
  LinkSeam.invoke = recorder().invoke;
  await assert.rejects(ModuleRegistry.dispatch("orders", "nope", {}), (e: ModuleCallError) => {
    assert.equal(e.code, "unknown_action");
    return true;
  });
  reset();
});

// ── 3. the closed failure vocabulary ─────────────────────────────────────────────────────

test("a transport failure is `unreachable` — the frozen spelling, not an invented one", async () => {
  reset();
  LinkSeam.routes = [NOTES];
  LinkSeam.invoke = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(ModuleRegistry.dispatch("server.http", "listNotes", {}), (e: ModuleCallError) => {
    assert.equal(e.code, "unreachable", "a link failure must use the vocabulary durability P4 froze");
    return true;
  });
  reset();
});

test("a SERVER answer keeps the server's reason — it is not flattened to `unreachable`", async () => {
  reset();
  LinkSeam.routes = [NOTES];
  LinkSeam.invoke = async () => {
    throw new ModuleCallError("unauthenticated", "route requires an authenticated identity");
  };
  await assert.rejects(ModuleRegistry.dispatch("server.http", "listNotes", {}), (e: ModuleCallError) => {
    assert.equal(e.code, "unauthenticated", "the server answered precisely and the link overwrote it");
    return true;
  });
  reset();
});

test("a link failure reaches the error ledger through the ORDINARY call path", async () => {
  reset();
  LinkSeam.routes = [NOTES];
  LinkSeam.invoke = async () => {
    throw new Error("ECONNREFUSED");
  };
  const seen: { code: string }[] = [];
  const off = ModuleRegistry.registerDelegate("module.callFailed", 0, (payload: unknown) => {
    seen.push(payload as { code: string });
    return null;
  });
  await assert.rejects(ModuleRegistry.dispatch("server.http", "listNotes", {}));
  off();
  assert.ok(seen.some((s) => s.code === "unreachable"), "the link failure never reached module.callFailed — it must use the ordinary funnel, not a side channel");
  reset();
});

// ── 4. the HTTP transport itself ─────────────────────────────────────────────────────────

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: string }): typeof fetch {
  return (async (input: string, init: RequestInit = {}) => {
    const { status = 200, body } = handler(String(input), init);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("http: a :param is filled from args, URL-encoded, and not repeated in the query", async () => {
  let seenUrl = "";
  const link = createHttpLink({
    baseUrl: "https://api.example.com",
    fetchImpl: fakeFetch((url) => {
      seenUrl = url;
      return { body: JSON.stringify({ id: 1 }) };
    }),
  });
  await link(ONE_NOTE, { id: "a b/c", extra: "1" });
  assert.ok(seenUrl.startsWith("https://api.example.com/notes/a%20b%2Fc"), `a path argument added structure to the URL: ${seenUrl}`);
  assert.ok(!seenUrl.includes("id="), "the consumed path argument was ALSO sent as a query parameter");
  assert.ok(seenUrl.includes("extra=1"), "a non-path argument should ride in the query for a GET");
});

test("http: a missing :param fails before any request is made", async () => {
  let called = false;
  const link = createHttpLink({
    baseUrl: "https://api.example.com",
    fetchImpl: fakeFetch(() => {
      called = true;
      return { body: "{}" };
    }),
  });
  await assert.rejects(link(ONE_NOTE, {}), /needs a "id" argument/);
  assert.equal(called, false, "a malformed call still went out over the network");
});

test("http: the bearer token is attached for the configured origin, read per call", async () => {
  const seen: string[] = [];
  let current: string | null = "token-one";
  const link = createHttpLink({
    baseUrl: "https://api.example.com",
    token: () => current,
    fetchImpl: fakeFetch((_url, init) => {
      seen.push(String((init.headers as Record<string, string>).authorization ?? ""));
      return { body: JSON.stringify(null) };
    }),
  });
  await link(NOTES, {});
  current = "token-two"; // a refresh must be picked up without reinstalling the link
  await link(NOTES, {});
  current = null;
  await link(NOTES, {});
  assert.deepEqual(seen, ["Bearer token-one", "Bearer token-two", ""], "the token is not read per call");
});

test("http: a route that would resolve off-origin is refused — the token never follows it", async () => {
  const link = createHttpLink({ baseUrl: "https://api.example.com", token: () => "secret", fetchImpl: fakeFetch(() => ({ body: "{}" })) });
  await assert.rejects(
    link({ ...NOTES, path: "//evil.example.net/steal" }, {}),
    /resolves outside https:\/\/api\.example\.com/,
  );
});

test("http: a POST sends its arguments as a JSON body, not a query string", async () => {
  let body = "";
  let url = "";
  const link = createHttpLink({
    baseUrl: "https://api.example.com",
    fetchImpl: fakeFetch((u, init) => {
      url = u;
      body = String(init.body ?? "");
      return { body: JSON.stringify({ id: "x" }) };
    }),
  });
  await link(CREATE, { title: "hello", pinned: true });
  assert.deepEqual(JSON.parse(body), { title: "hello", pinned: true });
  assert.ok(!url.includes("title="), "a POST leaked its arguments into the URL, where they land in access logs");
});

test("http: a failure status carries its reason through, and a non-JSON body does not leak", async () => {
  const refusing = createHttpLink({
    baseUrl: "https://api.example.com",
    fetchImpl: fakeFetch(() => ({ status: 401, body: JSON.stringify({ reason: "unauthenticated", message: "nope" }) })),
  });
  await assert.rejects(refusing(NOTES, {}), (e: ModuleCallError) => {
    assert.equal(e.code, "unauthenticated");
    return true;
  });

  const proxied = createHttpLink({
    baseUrl: "https://api.example.com",
    fetchImpl: fakeFetch(() => ({ status: 502, body: "<html>gateway error — internal.host.local</html>" })),
  });
  await assert.rejects(proxied(NOTES, {}), (e: ModuleCallError) => {
    assert.equal(e.code, "handler_failed");
    assert.ok(!/internal\.host\.local/.test(e.message), "the proxy's HTML body leaked into the caller's error");
    return true;
  });
});

// ── the wire shape: HTTP is the envelope ────────────────────────────────────────────────

test("http: a success returns the server's value VERBATIM — there is no envelope to unwrap", async () => {
  // The server adds no wrapper of its own (host.ts), so the body IS the value. This pins the
  // exact regression that reaching for a `data` key reintroduces: with `return record["data"]`
  // every successful call resolves to `undefined`, and every other test in this file still
  // passes because none of them assert on the resolved value.
  const link = createHttpLink({
    baseUrl: "https://api.example.com",
    fetchImpl: fakeFetch(() => ({ body: JSON.stringify([{ id: 1 }, { id: 2 }]) })),
  });
  assert.deepEqual(await link(NOTES, {}), [{ id: 1 }, { id: 2 }], "the server's value did not survive the link");
});

test("http: a 200 whose body CONTAINS reason/message is a success — the status decides, not the body", async () => {
  // This is the whole argument for dropping the server envelope rather than teaching the client
  // to unwrap one. A handler may legitimately return a payload carrying these keys, and any
  // rule that sniffs the BODY for them turns this success into an error. Only the status can
  // answer the question, which is precisely the job status codes exist to do.
  const link = createHttpLink({
    baseUrl: "https://api.example.com",
    fetchImpl: fakeFetch(() => ({ body: JSON.stringify({ reason: "seasonal", message: "spring drop" }) })),
  });
  assert.deepEqual(
    await link(NOTES, {}),
    { reason: "seasonal", message: "spring drop" },
    "a 200 payload that happens to look like an error was thrown as one",
  );
});
