//
//  api.test.ts - the `<api>` block web half against the doc-05 contract: auto-fetch,
//  dep-tracked refetch, the reserved envelope paths, abort-stale, retry, send/cancel,
//  and the runner integration (orders.refresh() from an action body). These are the
//  fixture shapes W5's cross-platform gate graduates to the shared corpus.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, flushEffects, invalidateCookies } from "../src/store.ts";
import { ApiBlock, clearApiCache, executeApiForSSR, apiSsrEnabled, type ApiSpec } from "../src/api.ts";
import { ActionRunner, makeRunEnv, RunnerFetchSeam } from "../src/runner.ts";
import { JSESeams } from "../src/jse/jse.ts";
import { type Dict } from "../src/jse/values.ts";

function tick(n = 3): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

type Call = { url: string; init: Dict };

function seam(handler: (call: Call) => Dict | Promise<Dict>): Call[] {
  const calls: Call[] = [];
  RunnerFetchSeam.impl = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

test("api: invalid as identifiers fail before state mutation or transport", () => {
  const calls = seam(() => ({ ok: true, status: 200, data: null }));
  try {
    const store = new ReactiveStore();
    assert.throws(
      () => new ApiBlock({ as: "payload.-1", url: "/api/data" } as ApiSpec, store, null),
      /ASCII identifier/,
    );
    assert.equal(calls.length, 0);
    assert.equal(store.vars.size, 0);
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api: GET auto-fetches on mount; envelope paths land", async () => {
  const calls = seam(() => ({ ok: true, status: 200, data: { orders: [1, 2, 3] } }));
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({ as: "orders", url: "/api/orders" } as ApiSpec, store, null);
    assert.equal(store.eval("orders.loading"), true); // in flight immediately
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "/api/orders");
    assert.equal(store.eval("orders.loading"), false);
    assert.deepEqual(store.eval("orders.data.orders"), [1, 2, 3]);
    assert.equal(store.eval("orders.error"), null);
    assert.ok((store.eval("orders.fetchedAt") as number) > 0);
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api: non-GET does not auto-fire; send() fires with body override", async () => {
  const calls = seam(() => ({ ok: true, status: 200, data: { saved: true } }));
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({ as: "save", url: "/api/save", method: "POST" } as ApiSpec, store, null);
    await tick();
    assert.equal(calls.length, 0); // auto defaults false off GET (doc 05)
    const res = await block.send({ name: "x" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.init["body"], { name: "x" });
    assert.equal((res as Dict)["ok"], true);
    assert.deepEqual(store.eval("save.data.saved"), true);
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api: url dependencies refetch reactively (read-tracked, debounced)", async () => {
  const calls = seam((c) => ({ ok: true, status: 200, data: { for: c.url } }));
  try {
    const store = new ReactiveStore();
    store.set("user", { id: 7 });
    const block = new ApiBlock({ as: "feed", url: "/api/feed?user={{ user.id }}" } as ApiSpec, store, null);
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "/api/feed?user=7");
    store.setPath("user.id", 9); // the tracked dep changes …
    flushEffects();
    await tick();
    assert.equal(calls.length, 2); // … so the block refetches
    assert.equal(calls[1]!.url, "/api/feed?user=9");
    assert.equal(store.eval("feed.data.for"), "/api/feed?user=9");
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api: http errors land as {status, message, body}; data survives a failed refresh", async () => {
  let fail = false;
  seam(() => (fail
    ? { ok: false, status: 500, data: { reason: "boom" } }
    : { ok: true, status: 200, data: { n: 1 } }));
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({ as: "thing", url: "/api/thing" } as ApiSpec, store, null);
    await tick();
    assert.equal(store.eval("thing.data.n"), 1);
    fail = true;
    await block.refresh();
    assert.equal(store.eval("thing.error.status"), 500);
    assert.deepEqual(store.eval("thing.error.body.reason"), "boom");
    assert.equal(store.eval("thing.data.n"), 1); // stale data kept — the doc-05 posture
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api: abort-stale — the newest request owns the store", async () => {
  let release1: ((v: Dict) => void) | null = null;
  let n = 0;
  seam(() => {
    n += 1;
    if (n === 1) return new Promise<Dict>((r) => { release1 = r; }); // slow first
    return { ok: true, status: 200, data: { winner: "second" } };
  });
  try {
    const store = new ReactiveStore();
    store.set("q", "a");
    const block = new ApiBlock({ as: "search", url: "/api/s?q={{ q }}" } as ApiSpec, store, null);
    await tick();
    store.set("q", "b"); // supersedes while the first is in flight
    flushEffects();
    await tick();
    release1!({ ok: true, status: 200, data: { winner: "first" } }); // straggler resolves late
    await tick();
    assert.equal(store.eval("search.data.winner"), "second");
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api: network errors retry per the retry attr", async () => {
  let n = 0;
  seam(() => {
    n += 1;
    return n < 3 ? { ok: false, status: 0, data: null, error: "network" } : { ok: true, status: 200, data: { n } };
  });
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({ as: "flaky", url: "/api/flaky", retry: "2" } as ApiSpec, store, null);
    await tick();
    assert.equal(n, 3);
    assert.equal(store.eval("flaky.data.n"), 3);
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api: the runner routes orders.refresh() / await orders.send()", async () => {
  const calls = seam(() => ({ ok: true, status: 200, data: { ok: 1 } }));
  try {
    const store = new ReactiveStore();
    const env = makeRunEnv(store);
    const block = new ApiBlock({ as: "orders", url: "/api/orders" } as ApiSpec, store, null);
    env.apis.set("orders", block);
    const runner = new ActionRunner(env);
    await tick();
    assert.equal(calls.length, 1);
    await runner.run("orders.refresh()");
    await tick();
    assert.equal(calls.length, 2);
    await runner.run("const r = await orders.send({ q: 1 }); dsx.variable.status = r.status");
    assert.equal(calls.length, 3);
    assert.equal(store.eval("status"), 200);
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("api cache: headers partition identities within one surface", async () => {
  clearApiCache();
  const calls = seam((call) => ({
    ok: true,
    status: 200,
    data: { authorization: (call.init["headers"] as Dict)["authorization"] },
  }));
  try {
    const store = new ReactiveStore();
    const mount = (token: string): ApiBlock => new ApiBlock({
      as: "profile",
      url: "/api/profile",
      headers: `{ Authorization: '${token}' }`,
      cache: "max-age(60)",
    }, store, null);

    let block = mount("Bearer A");
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(store.eval("profile.data.authorization"), "Bearer A");
    block.dispose();

    block = mount("Bearer A");
    await tick();
    assert.equal(calls.length, 1, "same identity should reuse its fresh entry");
    assert.equal(store.eval("profile.data.authorization"), "Bearer A");
    block.dispose();

    block = mount("Bearer B");
    await tick();
    assert.equal(calls.length, 2, "a different Authorization header must hit the network");
    assert.equal(store.eval("profile.data.authorization"), "Bearer B");
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api cache: header names and expect modes are normalized before keying", async () => {
  clearApiCache();
  const calls = seam((_call) => ({ ok: true, status: 200, data: { ok: true } }));
  try {
    const store = new ReactiveStore();
    let block = new ApiBlock({
      as: "first",
      url: "/api/normalized",
      headers: "{ Authorization: 'Bearer A' }",
      expect: "JSON",
      cache: "max-age(60)",
    }, store, null);
    await tick();
    block.dispose();

    block = new ApiBlock({
      as: "second",
      url: "/api/normalized",
      headers: "{ authorization: 'Bearer A' }",
      expect: "json",
      cache: "max-age(60)",
    }, store, null);
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(store.eval("second.data.ok"), true);
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api cache: entries never cross ReactiveStore surface boundaries", async () => {
  clearApiCache();
  const calls = seam((_call) => ({ ok: true, status: 200, data: { call: 1 } }));
  try {
    const spec = { as: "cfg", url: "/api/cfg", cache: "max-age(60)" } as ApiSpec;
    const first = new ApiBlock(spec, new ReactiveStore(), null);
    await tick();
    first.dispose();
    const second = new ApiBlock(spec, new ReactiveStore(), null);
    await tick();
    second.dispose();
    assert.equal(calls.length, 2, "a new surface/session must not inherit cached data");
  } finally {
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api cache: bounded LRU evicts the oldest request after 256 entries", async () => {
  clearApiCache();
  const calls = seam((call) => ({ ok: true, status: 200, data: { url: call.url } }));
  try {
    const store = new ReactiveStore();
    const blocks: ApiBlock[] = [];
    for (let i = 0; i <= 256; i += 1) {
      blocks.push(new ApiBlock({
        as: `entry${i}`,
        url: `/api/cache/${i}`,
        cache: "max-age(60)",
      }, store, null));
    }
    await tick();
    assert.equal(calls.length, 257);
    blocks.forEach((block) => block.dispose());

    const firstAgain = new ApiBlock({
      as: "entry0",
      url: "/api/cache/0",
      cache: "max-age(60)",
    }, store, null);
    await tick();
    assert.equal(calls.length, 258, "the least-recently-used entry must be evicted");
    firstAgain.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api SSE: messages render before a persistent response reaches EOF", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let responseEnded = false;
  const events: string[] = [];
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({ as: "live", url: "/api/live" }, store, null, {
      onEvent: (name) => events.push(name),
    });
    await tick();
    streamController!.enqueue(encoder.encode("data: {\"token\":\"hel"));
    streamController!.enqueue(encoder.encode("lo\"}\r\n\r\n"));
    await tick();

    assert.equal(responseEnded, false);
    assert.equal(store.eval("live.data.0.token"), "hello");
    assert.equal(store.eval("live.loading"), false);
    assert.deepEqual(events, ["message"], "message must arrive while the connection remains open");

    responseEnded = true;
    streamController!.close();
    await tick();
    assert.deepEqual(events, ["message", "success"]);
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api expect=blob: preserves bounded binary bytes and media type", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([0, 1, 2, 254, 255]), {
    status: 200,
    headers: { "content-type": "application/octet-stream; version=1" },
  });
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({ as: "asset", url: "/api/asset", expect: "blob" }, store, null);
    await tick();
    assert.equal(store.eval("asset.data.__blob"), "AAEC/v8=");
    assert.equal(store.eval("asset.data.type"), "application/octet-stream");
    assert.equal(store.eval("asset.data.size"), 5);
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api response guard: actual bytes are bounded and terminal failures do not retry", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  const oneMiB = new Uint8Array(1024 * 1024);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    let emitted = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 17) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(oneMiB);
      },
    }), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  };
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({
      as: "oversized",
      url: "/api/oversized",
      expect: "blob",
      retry: "3",
    }, store, null);
    await tick();
    assert.equal(calls, 1, "a deterministic size rejection must not amplify through retries");
    assert.equal(store.eval("oversized.error.status"), -2);
    assert.equal(store.eval("oversized.error.message"), "response_too_large");
    assert.equal(store.eval("oversized.data"), null);
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api response guard: malformed JSON is terminal and preserves stale data", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{broken", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const store = new ReactiveStore();
    store.set("payload", {
      data: { stable: true },
      loading: false,
      refreshing: false,
      error: null,
      fetchedAt: 1,
    });
    const block = new ApiBlock({
      as: "payload",
      url: "/api/malformed",
      retry: "3",
    }, store, null);
    await tick();
    assert.equal(calls, 1);
    assert.equal(store.eval("payload.error.status"), -2);
    assert.equal(store.eval("payload.error.message"), "invalid_response");
    assert.equal(store.eval("payload.data.stable"), true);
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api transport: an HTTPS to HTTP redirect downgrade is terminal and never retried", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const response = new Response("unsafe", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "http://api.example.test/private",
    });
    return response;
  };
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({
      as: "secure",
      url: "https://api.example.test/private",
      retry: "3",
    }, store, null);
    await tick();
    assert.equal(calls, 1);
    assert.equal(store.eval("secure.error.status"), -2);
    assert.equal(store.eval("secure.error.message"), "insecure_redirect");
    assert.equal(store.eval("secure.data"), null);
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api request guard: a body over 4 MiB is rejected before fetch and never retried", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({
      as: "upload",
      url: "/api/upload",
      method: "POST",
      retry: "3",
    }, store, null);
    const response = await block.send({ payload: "x".repeat(4 * 1024 * 1024 + 1) }) as Dict;
    assert.equal(calls, 0);
    assert.equal(response["status"], -2);
    assert.equal(store.eval("upload.error.status"), -2);
    assert.equal(store.eval("upload.error.message"), "request_too_large");
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api request guard: cycles, deep graphs, and oversized UTF-8 strings fail before fetch", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({
      as: "guarded",
      url: "/api/guarded",
      method: "POST",
      retry: "3",
    }, store, null);

    const cyclic: Dict = {};
    cyclic["self"] = cyclic;
    const cycleResult = await block.send(cyclic) as Dict;
    assert.equal(cycleResult["error"], "invalid_request");

    let deep: Dict = { leaf: true };
    for (let depth = 0; depth < 130; depth += 1) deep = { next: deep };
    const depthResult = await block.send(deep) as Dict;
    assert.equal(depthResult["error"], "request_too_complex");

    // UTF-16 length remains under 4 MiB while UTF-8 bytes exceed it.
    const utf8Result = await block.send("😀".repeat(1_048_577) as unknown as Dict) as Dict;
    assert.equal(utf8Result["error"], "request_too_large");
    assert.equal(store.eval("guarded.error.status"), -2);
    assert.equal(calls, 0);
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api request guard: URL and header metadata are bounded before fetch", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  try {
    const urlStore = new ReactiveStore();
    const longUrl = new ApiBlock({
      as: "longUrl",
      url: "/" + "u".repeat(16 * 1024 + 1),
      method: "POST",
    }, urlStore, null);
    const urlResult = await longUrl.send({}) as Dict;
    assert.equal(urlResult["error"], "request_too_large");
    longUrl.dispose();

    const headerStore = new ReactiveStore();
    headerStore.set("requestHeaders", Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`x-test-${index}`, "v"]),
    ));
    const manyHeaders = new ApiBlock({
      as: "manyHeaders",
      url: "/api/headers",
      method: "POST",
      headers: "requestHeaders",
    }, headerStore, null);
    const countResult = await manyHeaders.send({}) as Dict;
    assert.equal(countResult["error"], "request_too_large");
    manyHeaders.dispose();

    headerStore.set("requestHeaders", { "x-large": "v".repeat(64 * 1024 + 1) });
    const largeHeader = new ApiBlock({
      as: "largeHeader",
      url: "/api/header-bytes",
      method: "POST",
      headers: "requestHeaders",
    }, headerStore, null);
    const bytesResult = await largeHeader.send({}) as Dict;
    assert.equal(bytesResult["error"], "request_too_large");
    assert.equal(calls, 0);
    largeHeader.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api cache: decoded expect mode partitions otherwise identical requests", async () => {
  clearApiCache();
  RunnerFetchSeam.impl = null;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{\"value\":1}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const store = new ReactiveStore();
    const json = new ApiBlock({
      as: "jsonData", url: "/api/same", expect: "json", cache: "max-age(60)",
    }, store, null);
    await tick();
    json.dispose();
    const text = new ApiBlock({
      as: "textData", url: "/api/same", expect: "text", cache: "max-age(60)",
    }, store, null);
    await tick();
    text.dispose();
    assert.equal(calls, 2);
    assert.equal(store.eval("jsonData.data.value"), 1);
    assert.equal(store.eval("textData.data"), "{\"value\":1}");
  } finally {
    globalThis.fetch = originalFetch;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api cache: a cache hit supersedes and aborts an older in-flight request", async () => {
  clearApiCache();
  let releaseA: ((value: Dict) => void) | null = null;
  const calls = seam((call) => {
    if (call.url.endsWith("q=a")) {
      return new Promise<Dict>((resolve) => { releaseA = resolve; });
    }
    return { ok: true, status: 200, data: { winner: "cached-b" } };
  });
  try {
    const store = new ReactiveStore();
    store.set("q", "b");
    const spec = {
      as: "search",
      url: "/api/search?q={{ q }}",
      cache: "max-age(60)",
    } as ApiSpec;

    let block = new ApiBlock(spec, store, null);
    await tick();
    assert.equal(calls.length, 1);
    block.dispose();

    store.set("q", "a");
    block = new ApiBlock(spec, store, null);
    await tick();
    assert.equal(calls.length, 2);
    store.set("q", "b");
    flushEffects();
    await tick();
    assert.equal(calls.length, 2, "B should resolve from its fresh cache entry");
    assert.equal(store.eval("search.data.winner"), "cached-b");

    releaseA!({ ok: true, status: 200, data: { winner: "late-a" } });
    await tick();
    assert.equal(store.eval("search.data.winner"), "cached-b");
    assert.equal(store.eval("search.loading"), false);
    assert.equal(store.eval("search.refreshing"), false);
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api cache: live cookies partition reads and successful mutations invalidate them", async () => {
  clearApiCache();
  const originalCookieJar = JSESeams.cookieJar;
  let cookie = "session-a";
  const calls = seam((call) => ({
    ok: true,
    status: 200,
    data: { url: call.url, cookie, call: calls.length },
  }));
  JSESeams.cookieJar = () => ({ session: cookie });
  try {
    const store = new ReactiveStore();
    const readSpec = { as: "me", url: "/api/me", cache: "max-age(60)" } as ApiSpec;
    let read = new ApiBlock(readSpec, store, null);
    await tick();
    read.dispose();

    cookie = "session-b";
    read = new ApiBlock(readSpec, store, null);
    await tick();
    assert.equal(calls.length, 2, "a changed cookie identity must miss the prior cache");
    read.dispose();

    cookie = "session-a";
    read = new ApiBlock(readSpec, store, null);
    await tick();
    assert.equal(calls.length, 2, "the original identity can reuse its own entry");
    read.dispose();

    const mutation = new ApiBlock({
      as: "login", url: "/api/login", method: "POST",
    }, store, null);
    await mutation.send({ user: "next" });
    mutation.dispose();
    assert.equal(calls.length, 3);

    read = new ApiBlock(readSpec, store, null);
    await tick();
    assert.equal(calls.length, 4, "a successful mutation invalidates prior-session reads");
    read.dispose();
  } finally {
    JSESeams.cookieJar = originalCookieJar;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("api: cookie identity changes reactively refetch a mounted GET block", async () => {
  clearApiCache();
  const originalCookieJar = JSESeams.cookieJar;
  let cookie = "session-a";
  const calls = seam((call) => ({
    ok: true,
    status: 200,
    data: { authorization: (call.init["headers"] as Dict)["authorization"] },
  }));
  JSESeams.cookieJar = () => ({ session: cookie });
  try {
    const store = new ReactiveStore();
    const block = new ApiBlock({
      as: "me",
      url: "/api/me",
      headers: "{ Authorization: cookie.session }",
    }, store, null);
    await tick();
    assert.equal(store.eval("me.data.authorization"), "session-a");

    cookie = "session-b";
    invalidateCookies();
    flushEffects();
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(store.eval("me.data.authorization"), "session-b");
    block.dispose();
  } finally {
    JSESeams.cookieJar = originalCookieJar;
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

// ── SSR execution + hydration seeding (W6, doc 05/02) ─────────────────────────────────

test("ssr: apiSsrEnabled — GET default true, ssr='false' opts out, non-GET never eligible", () => {
  assert.equal(apiSsrEnabled({ as: "a", url: "/a" } as ApiSpec), true);            // GET default
  assert.equal(apiSsrEnabled({ as: "a", url: "/a", ssr: "true" } as ApiSpec), true);
  assert.equal(apiSsrEnabled({ as: "a", url: "/a", ssr: "false" } as ApiSpec), false);
  assert.equal(apiSsrEnabled({ as: "a", url: "/a", method: "POST" } as ApiSpec), false); // mutation
  assert.equal(apiSsrEnabled({ as: "a", url: "/a", method: "POST", ssr: "true" } as ApiSpec), false);
});

test("ssr: executeApiForSSR seeds an eligible GET; ssr='false', non-GET and auto='false' opt out", async () => {
  const calls = seam(() => ({ ok: true, status: 200, data: { orders: [1, 2] } }));
  try {
    const store = new ReactiveStore();
    const ok = await executeApiForSSR({ as: "orders", url: "/api/orders" } as ApiSpec, store, null);
    assert.equal(ok.status, "seed");
    if (ok.status === "seed") {
      assert.deepEqual(ok.envelope.data, { orders: [1, 2] });
      assert.equal(ok.envelope.error, null);
      assert.ok((ok.envelope.fetchedAt as number) > 0);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init["method"], "GET");

    // opt-outs never touch the network
    assert.equal((await executeApiForSSR({ as: "x", url: "/api/x", ssr: "false" } as ApiSpec, store, null)).status, "skip");
    assert.equal((await executeApiForSSR({ as: "y", url: "/api/y", method: "POST", ssr: "true" } as ApiSpec, store, null)).status, "skip");
    assert.equal((await executeApiForSSR({ as: "z", url: "/api/z", auto: "false" } as ApiSpec, store, null)).status, "skip");
    assert.equal(calls.length, 1, "only the eligible GET hit the seam");
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("ssr: executeApiForSSR materializes reactive urls against the render scope", async () => {
  const calls = seam(() => ({ ok: true, status: 200, data: { ok: 1 } }));
  try {
    const store = new ReactiveStore();
    store.set("user", { id: 42 });
    const out = await executeApiForSSR({ as: "u", url: "/api/u?user={{ user.id }}" } as ApiSpec, store, null);
    assert.equal(out.status, "seed");
    assert.equal(calls[0]!.url, "/api/u?user=42");
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("ssr: executeApiForSSR falls back to the client on http error, network error and timeout", async () => {
  seam(() => ({ ok: false, status: 500, data: { reason: "boom" } }));
  try {
    const store = new ReactiveStore();
    assert.equal((await executeApiForSSR({ as: "a", url: "/api/a" } as ApiSpec, store, null)).status, "client");
  } finally { RunnerFetchSeam.impl = null; }

  seam(() => ({ ok: false, status: 0, data: null }));
  try {
    const store = new ReactiveStore();
    assert.equal((await executeApiForSSR({ as: "b", url: "/api/b" } as ApiSpec, store, null)).status, "client");
  } finally { RunnerFetchSeam.impl = null; }

  // a hung upstream is bounded by the timeout and falls back (never a stalled render)
  RunnerFetchSeam.impl = () => new Promise<Dict>(() => {});
  try {
    const store = new ReactiveStore();
    const started = Date.now();
    const out = await executeApiForSSR({ as: "c", url: "/api/c" } as ApiSpec, store, null, { timeoutMs: 20 });
    assert.equal(out.status, "client");
    if (out.status === "client") assert.equal(out.code, "ssr_timeout");
    assert.ok(Date.now() - started < 2000, "the SSR fetch is bounded by the timeout");
  } finally { RunnerFetchSeam.impl = null; }
});

test("ssr seed: a seeded block adopts the data and does NOT fetch on boot; a dep change refetches", async () => {
  const calls = seam(() => ({ ok: true, status: 200, data: { fresh: true } }));
  try {
    const store = new ReactiveStore();
    store.set("user", { id: 7 });
    const block = new ApiBlock(
      { as: "orders", url: "/api/orders?user={{ user.id }}" } as ApiSpec,
      store, null,
      { seed: { data: { seeded: true }, error: null, fetchedAt: 1000 } },
    );
    await tick();
    // THE proof: the server-resolved data is live immediately and NO boot fetch happened
    assert.equal(calls.length, 0, "no duplicate network call on boot");
    assert.deepEqual(store.eval("orders.data"), { seeded: true });
    assert.equal(store.eval("orders.loading"), false);
    assert.equal(store.eval("orders.fetchedAt"), 1000);

    // the seed is a one-time skip: a materialized-request change refetches normally
    store.set("user", { id: 9 });
    flushEffects();
    await tick();
    assert.equal(calls.length, 1, "a dep change fetches");
    assert.equal(calls[0]!.url, "/api/orders?user=9");
    assert.deepEqual(store.eval("orders.data"), { fresh: true });
    block.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});

test("ssr seed: a cacheable seed primes the surface cache (a fresh-window remount is a hit)", async () => {
  const calls = seam(() => ({ ok: true, status: 200, data: { network: true } }));
  try {
    const store = new ReactiveStore();
    let clock = 1000;
    const now = (): number => clock;
    const a = new ApiBlock({ as: "cfg", url: "/api/cfg", cache: "max-age(3600)" } as ApiSpec, store, null,
      { seed: { data: { seeded: true }, fetchedAt: 1000 }, now });
    await tick();
    assert.equal(calls.length, 0);
    a.dispose();
    // a remount inside the fresh window (no new seed) serves the primed entry — no call
    clock = 1000 + 30_000;
    const b = new ApiBlock({ as: "cfg", url: "/api/cfg", cache: "max-age(3600)" } as ApiSpec, store, null, { now });
    await tick();
    assert.equal(calls.length, 0, "remount inside the fresh window is a cache hit, no network");
    assert.deepEqual(store.eval("cfg.data"), { seeded: true });
    b.dispose();
  } finally {
    RunnerFetchSeam.impl = null;
    clearApiCache();
  }
});
