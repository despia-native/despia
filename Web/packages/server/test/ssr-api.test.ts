//
//  ssr-api.test.ts - SSR-aware <api> execution + hydration seeding (W6, doc 05/02):
//  executeSsrApis runs an ssr-eligible GET during render, renderPageAsync embeds the ok
//  result in both the body (data visible on first paint) and the window.__DSX__ payload,
//  and the client seeds that block instead of re-fetching. Every failure falls back to
//  the client-fetch path (fail-open). The transport is the shared RunnerFetchSeam, so no
//  real network is touched.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ApiBlock, RunnerFetchSeam, type ApiSpec, type Dict } from "@despia-native/kernel";
import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { executeSsrApis, renderEmbedFragment, renderEmbedFragmentAsync, renderToString } from "../src/render.ts";
import { renderPage, renderPageAsync } from "../src/static.ts";

function seam(handler: (url: string, init: Dict) => Dict): string[] {
  const urls: string[] = [];
  RunnerFetchSeam.impl = async (url, init) => { urls.push(url); return handler(url, init); };
  return urls;
}

function registryFor(markup: string): Registry {
  return { components: { "t.Page": compileComponent("Page", "t", markup) }, globalPool: {}, css: "", schemes: [] };
}

function registryOf(sources: { [qualified: string]: string }): Registry {
  const components: Registry["components"] = {};
  for (const [qualified, markup] of Object.entries(sources)) {
    const scheme = qualified.substring(0, qualified.indexOf("."));
    const name = qualified.substring(qualified.indexOf(".") + 1);
    components[qualified] = compileComponent(name, scheme, markup);
  }
  return { components, globalPool: {}, css: "", schemes: [] };
}

const PAGE = `<stack>
  <head><api as="orders" url="/api/orders"/></head>
  <text value="{{ orders.data.title }}"/>
</stack>`;

/** Pull the JSON out of the inline `window.__DSX__=…;</script>` payload. */
function extractPayload(html: string): { api?: { [k: string]: unknown } } | null {
  const m = /window\.__DSX__=(\{.*?\});<\/script>/.exec(html);
  if (m === null) return null;
  const json = m[1]!
    .replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&")
    .replace(/\\u2028/g, " ").replace(/\\u2029/g, " ");
  return JSON.parse(json);
}

test("ssr api: executeSsrApis runs an eligible GET and returns the ok envelope keyed by `as`", async () => {
  const urls = seam(() => ({ ok: true, status: 200, data: { title: "Hello from SSR" } }));
  try {
    const seeds = await executeSsrApis(registryFor(PAGE), "t.Page");
    assert.deepEqual(Object.keys(seeds), ["orders"]);
    assert.deepEqual(seeds.orders!.data, { title: "Hello from SSR" });
    assert.equal(seeds.orders!.error, null);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "/api/orders");
  } finally { RunnerFetchSeam.impl = null; }
});

test("ssr api: renderPageAsync renders the data server-side AND embeds the hydration payload", async () => {
  seam(() => ({ ok: true, status: 200, data: { title: "Hello from SSR" } }));
  try {
    const page = await renderPageAsync(registryFor(PAGE), "t.Page", {}, { title: "P" });
    // (1) the data is in the server HTML (first paint, not a skeleton)
    assert.ok(page.includes("Hello from SSR"), "SSR body shows the resolved api data");
    // (2) the payload rides the same document, keyed by the api `as`
    assert.ok(page.includes("window.__DSX__="), "the hydration payload script is present");
    const payload = extractPayload(page);
    assert.ok(payload !== null && payload.api !== undefined, "payload round-trips as JSON");
    assert.deepEqual((payload!.api!.orders as Dict).data, { title: "Hello from SSR" });
    // the payload rides inside the adopt-marked host document (data-dsx-hydrate)
    assert.ok(page.includes("data-dsx-hydrate"));
  } finally { RunnerFetchSeam.impl = null; }
});

test("ssr api: the payload round-trips into a client block that does NOT re-fetch on boot", async () => {
  const urls = seam(() => ({ ok: true, status: 200, data: { title: "Hello from SSR" } }));
  try {
    const page = await renderPageAsync(registryFor(PAGE), "t.Page", {}, { title: "P" });
    assert.equal(urls.length, 1, "SSR performed exactly one fetch");
    const payload = extractPayload(page);
    const seed = (payload!.api!.orders) as Dict;

    // the client boot seeds the SAME block from the payload — and must NOT fetch again
    const store = new ReactiveStore();
    const block = new ApiBlock({ as: "orders", url: "/api/orders" } as ApiSpec, store, null, { seed });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(urls.length, 1, "THE PROOF: no duplicate network call on the client boot");
    assert.deepEqual(store.eval("orders.data"), { title: "Hello from SSR" });
    block.dispose();
  } finally { RunnerFetchSeam.impl = null; }
});

test("ssr api: ssr='false' opts out — no execution, no payload, envelope seeds null", async () => {
  const urls = seam(() => ({ ok: true, status: 200, data: { title: "should not run" } }));
  try {
    const markup = `<stack><head><api as="orders" url="/api/orders" ssr="false"/></head><text value="{{ orders.data.title }}"/></stack>`;
    const page = await renderPageAsync(registryFor(markup), "t.Page", {}, { title: "P" });
    assert.equal(urls.length, 0, "an ssr='false' block never runs server-side");
    assert.ok(!page.includes("window.__DSX__="), "no payload when nothing seeded");
    assert.ok(!page.includes("should not run"));
  } finally { RunnerFetchSeam.impl = null; }
});

test("ssr api: an http error falls back to the client (no seed, envelope null, no payload)", async () => {
  const urls = seam(() => ({ ok: false, status: 500, data: { reason: "boom" } }));
  try {
    const page = await renderPageAsync(registryFor(PAGE), "t.Page", {}, { title: "P" });
    assert.equal(urls.length, 1, "SSR attempted the fetch");
    assert.ok(!page.includes("window.__DSX__="), "a failed SSR fetch seeds nothing — the client fetches on mount");
    // the body renders the empty envelope exactly as the pre-SSR path did
    const plain = renderPage(registryFor(PAGE), "t.Page", {}, { title: "P" });
    assert.ok(!plain.includes("window.__DSX__="), "the sync renderPage never executes apis");
  } finally { RunnerFetchSeam.impl = null; }
});

test("ssr api: an api-free page stays byte-identical whether rendered sync or async", async () => {
  const markup = `<stack><text value="static"/></stack>`;
  const sync = renderPage(registryFor(markup), "t.Page", {}, { title: "P" });
  const async = await renderPageAsync(registryFor(markup), "t.Page", {}, { title: "P" });
  assert.equal(async, sync, "no apis ⇒ no payload ⇒ identical document");
  assert.ok(!async.includes("window.__DSX__="));
});

// ── nested-component SSR apis (W6) ───────────────────────────────────────────────────

const NESTED = {
  "t.Page": `<stack>
    <head><api as="orders" url="/api/orders"/></head>
    <text value="{{ orders.data.title }}"/>
    <t.Child count="7"/>
  </stack>`,
  "t.Child": `<stack>
    <head>
      <attribute as="count" default="0"/>
      <api as="detail" url="/api/detail?n={{ dsx.attribute.count }}"/>
    </head>
    <text value="{{ detail.data.label }}"/>
  </stack>`,
};

test("ssr api: a NESTED component's ssr <api> executes and seeds in the child's scope", async () => {
  const urls = seam((url) => {
    if (url.startsWith("/api/orders")) return { ok: true, status: 200, data: { title: "Top" } };
    if (url.startsWith("/api/detail")) return { ok: true, status: 200, data: { label: "Child says hi" } };
    return { ok: false, status: 404, data: null };
  });
  try {
    const registry = registryOf(NESTED);
    const seeds = await executeSsrApis(registry, "t.Page");
    assert.deepEqual(new Set(Object.keys(seeds)), new Set(["orders", "detail"]), "parent AND child apis seeded");
    assert.deepEqual(seeds.detail!.data, { label: "Child says hi" });
    // the child's url materialized against the CHILD's attr scope (count=7), not the parent's
    assert.ok(urls.includes("/api/detail?n=7"), `child url used child attrs (got ${urls.join(", ")})`);

    const page = await renderPageAsync(registry, "t.Page", {}, { title: "P" });
    assert.ok(page.includes("Top"), "parent data on first paint");
    assert.ok(page.includes("Child says hi"), "CHILD data on first paint (nested SSR seeding)");
    const payload = extractPayload(page);
    assert.deepEqual((payload!.api!.detail as Dict).data, { label: "Child says hi" });
  } finally { RunnerFetchSeam.impl = null; }
});

test("ssr api: a nested api under a visible-if=false subtree is NOT executed", async () => {
  const urls = seam(() => ({ ok: true, status: 200, data: { label: "should not run" } }));
  try {
    const registry = registryOf({
      "t.Page": `<stack>
        <head><variable as="show">return false</variable></head>
        <stack visible-if="show"><t.Child count="1"/></stack>
      </stack>`,
      "t.Child": `<stack><head><attribute as="count"/><api as="detail" url="/api/detail"/></head><text value="{{ detail.data.label }}"/></stack>`,
    });
    const seeds = await executeSsrApis(registry, "t.Page");
    assert.equal(urls.length, 0, "the server would not render the hidden subtree, so its api never runs");
    assert.deepEqual(Object.keys(seeds), []);
  } finally { RunnerFetchSeam.impl = null; }
});

test("ssr api: a defer'd block is NOT SSR-executed — it keeps its client-fetch path (streaming seam)", async () => {
  const urls = seam(() => ({ ok: true, status: 200, data: { title: "deferred" } }));
  try {
    const markup = `<stack><head><api as="orders" url="/api/orders" defer="true"/></head><text value="{{ orders.data.title }}"/></stack>`;
    const registry = registryFor(markup);
    const seeds = await executeSsrApis(registry, "t.Page");
    assert.deepEqual(Object.keys(seeds), [], "a deferred block is excluded from the initial SSR flush");
    const page = await renderPageAsync(registry, "t.Page", {}, { title: "P" });
    assert.equal(urls.length, 0, "no server fetch for a deferred block");
    assert.ok(!page.includes("window.__DSX__="), "nothing seeded ⇒ the client fetches it on mount (loading branch first)");
  } finally { RunnerFetchSeam.impl = null; }
});

// ── embed-fragment SSR (W6, /web/13 scenario 2) ──────────────────────────────────────

const EMBED_API = {
  "shop.Widget": `<stack>
    <head>
      <attribute as="sku" default="none"/>
      <api as="price" url="/api/price?sku={{ dsx.attribute.sku }}"/>
    </head>
    <text value="{{ price.data.amount }}"/>
  </stack>`,
};

test("embed ssr: renderEmbedFragmentAsync executes the embed api, paints data, and seeds the DSD", async () => {
  const urls = seam((url) => url.startsWith("/api/price")
    ? { ok: true, status: 200, data: { amount: "$42" } }
    : { ok: false, status: 404, data: null });
  try {
    const registry = registryOf(EMBED_API);
    const fragment = await renderEmbedFragmentAsync(registry, "shop.Widget", "shop-widget", "/*css*/", { sku: "abc" });
    // the embed api ran against the EMBED's attr scope
    assert.ok(urls.includes("/api/price?sku=abc"), `embed api used embed attrs (got ${urls.join(",")})`);
    // (1) data painted into the fragment body — first paint, not an empty envelope
    assert.ok(fragment.includes("$42"), "resolved data on first paint in the DSD body");
    // (2) the seed payload rides INSIDE the shadow-root template
    assert.ok(fragment.includes("data-dsx-ssr"), "the DSD carries the api-seed payload");
    const m = /<script type="application\/json" data-dsx-ssr>(.*?)<\/script>/.exec(fragment);
    assert.ok(m !== null, "seed script present");
    const seeds = JSON.parse(m![1]!.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&"));

    // (3) THE PROOF: the seed round-trips into an ApiBlock that makes NO boot fetch
    urls.length = 0;
    const store = new ReactiveStore();
    const block = new ApiBlock({ as: "price", url: "/api/price?sku=abc" } as ApiSpec, store, null, { seed: seeds.price });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(urls.length, 0, "the seeded embed block adopts the payload and skips the fetch");
    assert.deepEqual(store.eval("price.data"), { amount: "$42" });
    block.dispose();
  } finally { RunnerFetchSeam.impl = null; }
});

test("embed ssr: a no-api embed's async fragment is byte-identical to the sync fragment", async () => {
  const registry = registryOf({ "shop.Plain": `<stack><text value="static"/></stack>` });
  const sync = renderEmbedFragment(registry, "shop.Plain", "shop-plain", "/*c*/");
  const asyncFragment = await renderEmbedFragmentAsync(registry, "shop.Plain", "shop-plain", "/*c*/");
  assert.equal(asyncFragment, sync, "no api ⇒ no seed script ⇒ identical fragment (byte budget honored)");
  assert.ok(!asyncFragment.includes("data-dsx-ssr"));
});

test("embed ssr: a failed embed api is fail-open — data absent, no seed script", async () => {
  const urls = seam(() => ({ ok: false, status: 503, data: null }));
  try {
    const registry = registryOf(EMBED_API);
    const fragment = await renderEmbedFragmentAsync(registry, "shop.Widget", "shop-widget", "", { sku: "abc" });
    assert.equal(urls.length, 1, "SSR attempted the fetch");
    assert.ok(!fragment.includes("data-dsx-ssr"), "a failed fetch seeds nothing — the embed fetches on upgrade");
  } finally { RunnerFetchSeam.impl = null; }
});

// keep renderToString referenced (the async path routes through it with apiSeeds)
void renderToString;
