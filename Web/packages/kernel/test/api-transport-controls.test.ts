//
//  api-transport-controls.test.ts - networking.md N2 "Layer 1 completeness", the half the
//  seamed corpus cannot express: what the REAL transport does with the declared controls.
//  The declarations themselves (stream/timeout/redirect/encode/parts/via) are pinned on
//  all three runtimes by OpenSource/Conformance/api/api-blocks.json; this suite proves the
//  web transport honours them.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, flushEffects } from "../src/store.ts";
import { ApiBlock, materializeApiRequest, type ApiSpec } from "../src/api.ts";
import { string, type Dict } from "../src/jse/values.ts";

function tick(n = 4): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

/** run one block against a stubbed global fetch and return its settled envelope paths */
async function runBlock(
  spec: ApiSpec,
  impl: (url: string, init: RequestInit) => Promise<Response>,
  scope: Dict = {},
  waitMs = 0,
): Promise<{ store: ReactiveStore; events: string[]; init: RequestInit | null; url: string }> {
  const originalFetch = globalThis.fetch;
  const store = new ReactiveStore();
  for (const [k, v] of Object.entries(scope)) store.jse.vars.set(k, v);
  const events: string[] = [];
  let seen: RequestInit | null = null;
  let seenUrl = "";
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    seen = init;
    seenUrl = String(input);
    return impl(String(input), init);
  }) as typeof globalThis.fetch;
  try {
    const block = new ApiBlock(spec, store, null, { onEvent: (name) => events.push(name) });
    flushEffects();
    // A fixed number of zero-delay turns does not prove that a positive timeout elapsed:
    // on a fast or lightly loaded runner four turns can finish inside 5 ms. Wait for the
    // block's public terminal state, with a bounded wall-clock guard, before disposing it.
    const deadline = Date.now() + 250;
    while (store.getPath(`${spec.as}.loading`) !== false && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { store, events, init: seen, url: seenUrl };
}

test("N2 timeout: a declared per-request timeout aborts with its own terminal reason", async () => {
  const { store } = await runBlock(
    { as: "slow", url: "/api/slow", timeout: "5" } as ApiSpec,
    (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
    {},
    20,
  );
  assert.equal(string(store.getPath("slow.error.message")), "timeout");
  assert.equal(string(store.getPath("slow.status")), "error");
  assert.equal(store.getPath("slow.loading"), false);
});

test("N2 stream=false: a declared non-stream reads an event-stream body as ordinary data", async () => {
  const { store, events } = await runBlock(
    { as: "quiet", url: "/api/sse", expect: "text", stream: "false" } as ApiSpec,
    async () => new Response("data: {\"tick\":1}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
  assert.deepEqual(events, ["success"], "no message events — streaming was declared off");
  assert.match(string(store.getPath("quiet.data")), /^data: /);
});

test("N2 stream=true: a declared stream chunks a newline-delimited non-SSE body", async () => {
  const { store, events } = await runBlock(
    { as: "live", url: "/api/ndjson", stream: "true" } as ApiSpec,
    async () => new Response('{"tick":1}\n{"tick":2}\n', {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    }),
  );
  assert.deepEqual(events, ["message", "message", "success"]);
  assert.equal((store.getPath("live.data") as unknown[]).length, 2);
  assert.equal(((store.getPath("live.data") as Dict[])[1]!)["tick"], 2);
});

test("N2 redirect: the declared policy rides through to the transport", async () => {
  const { init } = await runBlock(
    { as: "strict", url: "/api/strict", redirect: "error" } as ApiSpec,
    async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.equal((init as unknown as { redirect?: string }).redirect, "error");
});

test("N2 multipart: declared parts become a real FormData body", async () => {
  const store = new ReactiveStore();
  store.jse.vars.set("payload", { title: "hi", file: { __blob: "QUJD", type: "image/png", name: "a.png" } });
  const spec = {
    as: "upload", url: "/api/upload", method: "POST", encode: "multipart", body: "payload",
  } as ApiSpec;
  const req = materializeApiRequest(spec, store, null);
  assert.equal(req["encode"], "multipart");
  const parts = req["parts"] as Dict[];
  assert.equal(parts.length, 2);
  assert.equal(string(parts[0]!["name"]), "file");        // sorted by field name
  assert.equal(string(parts[0]!["filename"]), "a.png");
  assert.equal(string(parts[1]!["value"]), "hi");

  const originalFetch = globalThis.fetch;
  let body: unknown = null;
  globalThis.fetch = (async (_input: string, init: RequestInit) => {
    body = init.body;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const block = new ApiBlock(spec, store, null, {});
    await block.send();
    await tick();
    block.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(body instanceof FormData, "a multipart request puts a real FormData on the wire");
  const form = body as FormData;
  assert.equal(form.get("title"), "hi");
  const file = form.get("file");
  assert.ok(file instanceof Blob);
  assert.equal(await (file as Blob).text(), "ABC");
});

test("N2 form: a declared urlencoded body is materialized by the kernel, sorted + encoded", () => {
  const store = new ReactiveStore();
  const req = materializeApiRequest(
    { as: "signin", url: "/api/signin", method: "POST", encode: "form", body: "{ user: 'a b', pass: 'x&y' }" } as ApiSpec,
    store,
    null,
  );
  assert.equal(req["wire"], "pass=x%26y&user=a%20b");
  assert.equal((req["headers"] as Dict)["content-type"], "application/x-www-form-urlencoded;charset=UTF-8");
});
