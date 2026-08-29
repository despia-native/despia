//
//  live-adapter.test.ts - the per-request LIVE SSR adapter (live.ts, the "open adapters
//  seam"): route matching per request (dynamic patterns included), the client's vars
//  seed ({ ...params, ...query }), real 302s for redirect entries, the notFound 404,
//  the `requires` capability gate, HEAD's header-only answer, ssr-api seeding through
//  renderPageAsync, and the dev/prod failure split. No real network: the api transport
//  is the shared RunnerFetchSeam; requests are plain web Requests.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunnerFetchSeam, type Dict } from "@despia-native/kernel";
import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { createPageHandler } from "../src/live.ts";

function registryOf(
  sources: { [qualified: string]: string },
  routes: Registry["routes"],
  extra: Partial<Registry> = {},
): Registry {
  const components: Registry["components"] = {};
  for (const [qualified, markup] of Object.entries(sources)) {
    const scheme = qualified.substring(0, qualified.indexOf("."));
    const name = qualified.substring(qualified.indexOf(".") + 1);
    components[qualified] = compileComponent(name, scheme, markup);
  }
  return { components, globalPool: {}, css: "", schemes: [], routes, ...extra };
}

const HOME = `<stack><text value="home sweet home"/></stack>`;
const USER = `<stack><text value="user {{ vars.id }} tab {{ vars.tab }}"/></stack>`;
const LOST = `<stack><text value="nothing here"/></stack>`;

test("live adapter: a concrete route serves the SSR document with page headers", async () => {
  const handle = createPageHandler(registryOf({ "t.Home": HOME }, [
    { path: "/", component: "t.Home", meta: { title: "Home" } },
  ]));
  const res = await handle(new Request("http://x/"));
  assert.notEqual(res, null);
  assert.equal(res!.status, 200);
  assert.equal(res!.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res!.headers.get("cache-control"), "no-store");
  const html = await res!.text();
  assert.ok(html.includes("home sweet home"));
  assert.ok(html.includes("<title>Home</title>"));
});

test("live adapter: a dynamic route binds path params AND query as vars (the client seed)", async () => {
  const handle = createPageHandler(registryOf({ "t.User": USER }, [
    { path: "/users/:id", component: "t.User" },
  ]));
  const res = await handle(new Request("http://x/users/42?tab=orders"));
  const html = await res!.text();
  assert.ok(html.includes("user 42 tab orders"));
});

test("live adapter: first match wins in table order", async () => {
  const handle = createPageHandler(registryOf({ "t.Home": HOME, "t.User": USER }, [
    { path: "/users/me", component: "t.Home" },
    { path: "/users/:id", component: "t.User" },
  ]));
  const html = await (await handle(new Request("http://x/users/me")))!.text();
  assert.ok(html.includes("home sweet home"));
});

test("live adapter: a redirect entry answers a real 302", async () => {
  const handle = createPageHandler(registryOf({ "t.Home": HOME }, [
    { path: "/old", redirect: "/" },
    { path: "/", component: "t.Home" },
  ]));
  const res = await handle(new Request("http://x/old"));
  assert.equal(res!.status, 302);
  assert.equal(res!.headers.get("location"), "/");
});

test("live adapter: unmatched serves the notFound component as a 404 — or null without one", async () => {
  const with404 = createPageHandler(registryOf({ "t.Home": HOME, "t.Lost": LOST }, [
    { path: "/", component: "t.Home" },
  ], { notFound: "t.Lost" }));
  const res = await with404(new Request("http://x/nope"));
  assert.equal(res!.status, 404);
  assert.ok((await res!.text()).includes("nothing here"));

  const bare = createPageHandler(registryOf({ "t.Home": HOME }, [
    { path: "/", component: "t.Home" },
  ]));
  assert.equal(await bare(new Request("http://x/nope")), null);
});

test("live adapter: `requires` naming an unshipped scheme resolves to notFound", async () => {
  const handle = createPageHandler(registryOf({ "t.Home": HOME, "t.Lost": LOST }, [
    { path: "/", component: "t.Home", requires: ["camera"] },
  ], { notFound: "t.Lost", schemes: ["t"] }));
  const res = await handle(new Request("http://x/"));
  assert.equal(res!.status, 404);
});

test("live adapter: non-GET returns null and HEAD answers headers without a body", async () => {
  const handle = createPageHandler(registryOf({ "t.Home": HOME }, [
    { path: "/", component: "t.Home" },
  ]));
  assert.equal(await handle(new Request("http://x/", { method: "POST" })), null);
  const res = await handle(new Request("http://x/", { method: "HEAD" }));
  assert.equal(res!.status, 200);
  assert.equal(res!.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await res!.text(), "");
});

test("live adapter: ssr-eligible <api> blocks execute per request and seed the payload", async () => {
  const PAGE = `<stack>
  <head><api as="orders" url="/api/orders/{{ vars.id }}"/></head>
  <text value="{{ orders.data.title }}"/>
</stack>`;
  const urls: string[] = [];
  RunnerFetchSeam.impl = async (url: string): Promise<Dict> => {
    urls.push(url);
    return { ok: true, status: 200, data: { title: `order ${url.split("/").pop()}` } };
  };
  try {
    const handle = createPageHandler(registryOf({ "t.Page": PAGE }, [
      { path: "/orders/:id", component: "t.Page" },
    ]));
    const html = await (await handle(new Request("http://x/orders/7")))!.text();
    assert.deepEqual(urls, ["/api/orders/7"]);          // executed during THIS request's render
    assert.ok(html.includes("order 7"));                // data on first paint
    assert.ok(html.includes("window.__DSX__"));         // and in the hydration payload
  } finally {
    RunnerFetchSeam.impl = null;
  }
});

test("live adapter: a render failure answers an opaque 500 — dev mode carries diagnostics", async () => {
  // An unknown component name makes renderPageAsync throw at resolution.
  const table: Registry["routes"] = [{ path: "/", component: "t.Missing" }];
  const prod = createPageHandler(registryOf({ "t.Home": HOME }, table));
  const opaque = await prod(new Request("http://x/"));
  assert.equal(opaque!.status, 500);
  assert.equal(await opaque!.text(), "Internal Server Error");

  const dev = createPageHandler(registryOf({ "t.Home": HOME }, table), { dev: true });
  const loud = await dev(new Request("http://x/"));
  assert.equal(loud!.status, 500);
  assert.ok((await loud!.text()).includes("SSR render failed"));
});

test("live adapter: a malicious route table fails at CREATION, not at the Nth request", () => {
  assert.throws(() => createPageHandler(registryOf({ "t.Home": HOME }, [
    { path: "/../escape", component: "t.Home" },
  ])));
});

test("live adapter: the registry's BAKED shell serves a deep-linked param route with the module script, depth-rebased", async () => {
  // wave-7 F1: dsx build bakes the document shell into registry.json, so a host built
  // from the registry ALONE (createSiteHandler(dist, registry) with no options) still
  // serves live-SSR'd documents that load the client boot.
  const handle = createPageHandler(registryOf({ "t.User": USER }, [
    { path: "/notes/:id", component: "t.User" },
  ], {
    shell: {
      appName: "Field Notes",
      importMapJson: JSON.stringify({ imports: { "@despia-native/kernel": "./vendor/kernel/index.js" } }),
      mainSrc: "./main.js",
      manifestHref: "/manifest.webmanifest",
    },
  }));
  const html = await (await handle(new Request("http://x/notes/abc123")))!.text();
  assert.ok(html.includes(`<script type="module" src="../main.js"></script>`),
    "the module script is present AND rebased for the served depth");
  assert.ok(html.includes(`"@despia-native/kernel": "../vendor/kernel/index.js"`),
    "the inlined import map rebases with the document");
  assert.ok(html.includes(`<link rel="manifest" href="/manifest.webmanifest">`));
});

test("live adapter: explicit caller shell options win over the baked registry shell, per key", async () => {
  const handle = createPageHandler(registryOf({ "t.Home": HOME }, [
    { path: "/", component: "t.Home" },
  ], {
    shell: { appName: "Baked", mainSrc: "./main.js" },
  }), { mainSrc: "./custom.js", appName: undefined });
  const html = await (await handle(new Request("http://x/")))!.text();
  assert.ok(html.includes(`src="./custom.js"`), "the caller's mainSrc wins");
  assert.ok(html.includes("<title>Baked</title>"),
    "an explicitly-undefined caller key does NOT erase the baked value");
});
