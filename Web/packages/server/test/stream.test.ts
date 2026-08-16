//
//  stream.test.ts - out-of-order SSR streaming (stream.ts, doc 02 "Streaming"): the
//  document flushes FIRST with the non-deferred seeds baked in and the deferred blocks'
//  loading branches, each `defer` block's seed flushes as its own late <script> chunk in
//  RESOLUTION order (not declaration order), the closing tags end the stream, failures
//  stay fail-open, and the live adapter's stream:true serves it all as a Response. The
//  transport is the shared RunnerFetchSeam; time is real but the seam resolves on
//  controlled promises, so ordering is deterministic.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunnerFetchSeam, ApiBlock, ReactiveStore, type ApiSpec, type Dict } from "@despia/kernel";
import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderPageStream, STREAM_ERROR_MARKER } from "../src/stream.ts";
import { createPageHandler } from "../src/live.ts";

function registryFor(markup: string, routes?: Registry["routes"]): Registry {
  const reg: Registry = {
    components: { "t.Page": compileComponent("Page", "t", markup) },
    globalPool: {}, css: "", schemes: [],
  };
  if (routes !== undefined) reg.routes = routes;
  return reg;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

const PAGE = `<stack>
  <head>
    <api as="fast" url="/api/fast"/>
    <api as="slowA" url="/api/slowA" defer="true"/>
    <api as="slowB" url="/api/slowB" defer="true"/>
  </head>
  <text value="{{ fast.data.title }}"/>
  <text visible-if="slowA.loading" value="loading A"/>
</stack>`;

test("stream: the document flushes with non-deferred data; defer chunks follow in RESOLUTION order", async () => {
  // slowB resolves BEFORE slowA — out-of-order is the point.
  let releaseA: () => void = () => {};
  const gateA = new Promise<void>((r) => { releaseA = r; });
  RunnerFetchSeam.impl = async (url: string): Promise<Dict> => {
    if (url === "/api/fast") return { ok: true, status: 200, data: { title: "first paint" } };
    if (url === "/api/slowA") { await gateA; return { ok: true, status: 200, data: "A" }; }
    if (url === "/api/slowB") {
      // resolve B, then open A's gate strictly after B's chunk is en route
      setTimeout(releaseA, 0);
      return { ok: true, status: 200, data: "B" };
    }
    return { ok: false, status: 404, data: null };
  };
  try {
    const html = await readAll(renderPageStream(registryFor(PAGE), "t.Page", {}, {}));
    assert.ok(html.includes("first paint"));                       // non-deferred data in the shell
    assert.ok(html.includes("window.__DSX_STREAM__=window.__DSX_STREAM__||[]")); // the hook
    const chunkB = html.indexOf('"as":"slowB"');
    const chunkA = html.indexOf('"as":"slowA"');
    assert.ok(chunkB !== -1 && chunkA !== -1, "both defer chunks flushed");
    assert.ok(chunkB < chunkA, "resolution order, not declaration order");
    assert.ok(html.indexOf("</body>") > chunkA, "chunks land inside the body");
    assert.ok(html.trimEnd().endsWith("</html>"));
    assert.ok(!html.includes(STREAM_ERROR_MARKER));
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("stream: a failed defer block flushes NO chunk and the stream still closes clean", async () => {
  RunnerFetchSeam.impl = async (url: string): Promise<Dict> =>
    url === "/api/fast"
      ? { ok: true, status: 200, data: { title: "shell" } }
      : { ok: false, status: 500, data: null };
  try {
    const html = await readAll(renderPageStream(registryFor(PAGE), "t.Page", {}, {}));
    assert.ok(html.includes("shell"));
    assert.ok(!html.includes('"as":"slowA"'));      // failed blocks keep the client-fetch path
    assert.ok(!html.includes(STREAM_ERROR_MARKER)); // a block failure is NOT a stream failure
    assert.ok(html.trimEnd().endsWith("</html>"));
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("stream: an unknown component streams the error marker, never a silent half-stream", async () => {
  const html = await readAll(renderPageStream(registryFor(PAGE), "t.Missing", {}, {}));
  assert.ok(html.includes(STREAM_ERROR_MARKER));
});

test("stream: the live adapter's stream:true serves the streamed body on a 200 GET only", async () => {
  RunnerFetchSeam.impl = async (url: string): Promise<Dict> =>
    ({ ok: true, status: 200, data: url.endsWith("fast") ? { title: "adapted" } : "late" });
  try {
    const handle = createPageHandler(registryFor(PAGE, [{ path: "/", component: "t.Page" }]),
                                     { stream: true });
    const res = await handle(new Request("http://x/"));
    assert.equal(res!.status, 200);
    assert.equal(res!.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res!.text();
    assert.ok(html.includes("adapted"));
    assert.ok(html.includes('"as":"slowA"') && html.includes('"as":"slowB"'));
    // HEAD keeps the buffered, body-less path even under stream:true
    const headRes = await handle(new Request("http://x/", { method: "HEAD" }));
    assert.equal(await headRes!.text(), "");
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("seedLate: a late seed settles a still-loading block once, and never overwrites settled data", async () => {
  // A gated fetch keeps the block in-flight while the late seed lands.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  RunnerFetchSeam.impl = async (): Promise<Dict> => { await gate; return { ok: true, status: 200, data: "from client" }; };
  try {
    const store = new ReactiveStore();
    const events: string[] = [];
    const spec = { as: "orders", url: "/api/orders", defer: "true" } as unknown as ApiSpec & { as: string; url: string };
    const block = new ApiBlock(spec, store, {}, { onEvent: (name) => { events.push(name); } });
    assert.equal(block.seedLate({ data: "from stream", fetchedAt: 111 }), true);
    const env = store.vars.get("orders") as Dict;
    assert.equal(env["data"], "from stream");
    assert.equal(env["loading"], false);
    assert.equal(env["fetchedAt"], 111);
    assert.deepEqual(events, ["success"]);
    // settled now — a second seed (or the raced client resolve) must not regress it
    assert.equal(block.seedLate({ data: "later chunk", fetchedAt: 222 }), false);
    assert.equal((store.vars.get("orders") as Dict)["data"], "from stream");
    release();                                        // let the superseded fetch finish
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((store.vars.get("orders") as Dict)["data"], "from stream"); // stale-suppressed
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("stream: a defer block inside a NESTED component streams too (the whole-tree walk)", async () => {
  const registry: Registry = {
    components: {
      "t.Page": compileComponent("Page", "t", `<stack><Widget/></stack>`),
      "t.Widget": compileComponent("Widget", "t", `<stack>
  <head><api as="nested" url="/api/nested" defer="true"/></head>
  <text value="{{ nested.data }}"/>
</stack>`),
    },
    globalPool: { Widget: "t.Widget" }, css: "", schemes: [],
  };
  RunnerFetchSeam.impl = async (): Promise<Dict> => ({ ok: true, status: 200, data: "deep" });
  try {
    const html = await readAll(renderPageStream(registry, "t.Page", {}, {}));
    assert.ok(html.includes('"as":"nested"'), "the nested component's defer chunk flushed");
    assert.ok(html.includes('"data":"deep"'));
    assert.ok(!html.includes(STREAM_ERROR_MARKER));
  } finally {
    RunnerFetchSeam.impl = null;
  }
});
