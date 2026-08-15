//
//  plugin.test.ts — the plugin's hooks, driven directly. Vite is a PEER dependency and is
//  not installed here, which is exactly the point: the plugin is a plain object with the
//  hook shape Vite calls, so its whole contract is assertable without a bundler.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CssCollector } from "@despia/compiler";

import { dsx, compileDsx, emitModule, isDsxFile, schemeFor, collectPackageWeb, readPackageWebBlock, REGISTRY_ID, ROUTES_ID, type HotContext } from "../src/index.ts";

const APP = `<stack>
  <head>
    <variable as="n">return 1</variable>
    <action as="bump">dsx.variable.n = dsx.variable.n + 1</action>
  </head>
  <text value="{{ dsx.variable.n }}" style="color: red"/>
  <button label="Go" on:tap="dsx.action.bump()"/>
</stack>
`;

function fixture(files: { [path: string]: string }): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-vite-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("the plugin has the shape Vite calls, and runs before every other transform", () => {
  const plugin = dsx();
  assert.equal(plugin.name, "dsx");
  assert.equal(plugin.enforce, "pre");
  for (const hook of ["configResolved", "resolveId", "load", "transform", "handleHotUpdate"] as const) {
    assert.equal(typeof plugin[hook], "function", `${hook} is missing`);
  }
});

test("only .dsx ids are claimed — query strings included, everything else untouched", () => {
  assert.equal(isDsxFile("/a/App.dsx"), true);
  assert.equal(isDsxFile("/a/App.dsx?import"), true);
  assert.equal(isDsxFile("/a/App.ts"), false);
  assert.equal(isDsxFile("/a/dsx.json"), false);
  const plugin = dsx();
  assert.equal(plugin.transform("export default 1", "/a/main.ts"), null);
});

test("a .dsx import becomes an ES module exporting the compiled IR", () => {
  const plugin = dsx();
  const out = plugin.transform(APP, "/pkg/Components/App.dsx");
  assert.ok(out !== null);
  assert.equal(out.map, null);
  assert.match(out.code, /export const name = "App";/);
  assert.match(out.code, /export const qualified = "app\.App";/);
  assert.match(out.code, /export default ir;/);

  // the exported IR is the compiler's, including the head contract and reactivity stamps
  const ir = JSON.parse(/const ir = (\{[\s\S]*?\});\n/.exec(out.code)![1]!) as {
    name: string; scheme: string; reactive: boolean;
    head: { variables: Array<{ as: string }>; actions: Array<{ as: string }> };
  };
  assert.equal(ir.name, "App");
  assert.equal(ir.reactive, true);
  assert.deepEqual(ir.head.variables.map((v) => v.as), ["n"]);
  assert.deepEqual(ir.head.actions.map((a) => a.as), ["bump"]);
});

test("the scheme comes from the nearest dsx.json, then the option, then 'app'", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({ name: "shop", scheme: "shop" }),
    "Components/App.dsx": APP,
  });
  try {
    assert.equal(schemeFor(join(project.root, "Components")), "shop");
    const withManifest = dsx().transform(APP, join(project.root, "Components/App.dsx"))!;
    assert.match(withManifest.code, /export const scheme = "shop";/);
  } finally {
    project.cleanup();
  }
  assert.match(dsx({ scheme: "custom" }).transform(APP, "/nowhere/App.dsx")!.code, /export const scheme = "custom";/);
  assert.match(dsx().transform(APP, "/nowhere/App.dsx")!.code, /export const scheme = "app";/);
});

test("a component's static CSS rides its module and injects once, under the DSX layers", () => {
  const out = dsx().transform(APP, "/pkg/Components/App.dsx")!;
  assert.match(out.code, /@layer dsx-inline \{/);
  assert.match(out.code, /color: red/);
  assert.match(out.code, /put\("dsx-layers"/);
  assert.match(out.code, /put\("dsx-css:app\.App"/);
  // the injector is idempotent — it reuses an existing <style> by id
  assert.match(out.code, /document\.getElementById\(id\)/);
});

test("injectCss: false leaves the cascade entirely to the app", () => {
  const out = dsx({ injectCss: false }).transform(APP, "/pkg/Components/App.dsx")!;
  assert.match(out.code, /export const css = /, "the CSS is still exported");
  assert.ok(!out.code.includes("document.createElement"), "but nothing is injected");
});

test("class handles stay unique across files — one collector for the whole build", () => {
  const plugin = dsx();
  const a = plugin.transform(`<stack><text value="a" style="color: red"/></stack>`, "/pkg/Components/A.dsx")!;
  const b = plugin.transform(`<stack><text value="b" style="color: blue"/></stack>`, "/pkg/Components/B.dsx")!;
  const handleOf = (code: string): string => /data-dsx~=\\"(\w+)\\"/.exec(code)![1]!;
  assert.notEqual(handleOf(a.code), handleOf(b.code), "two different declarations must not share a handle");
  // and an identical declaration dedupes to the same handle (the collector's contract)
  const c = plugin.transform(`<stack><text value="c" style="color: red"/></stack>`, "/pkg/Components/C.dsx")!;
  assert.equal(handleOf(c.code), handleOf(a.code));
});

test("compileDsx is pure over its inputs, so the emitted bytes are assertable", () => {
  const first = compileDsx("/pkg/Components/App.dsx", APP, new CssCollector());
  const second = compileDsx("/pkg/Components/App.dsx", APP, new CssCollector());
  assert.equal(first.code, second.code);
  assert.equal(emitModule(first.ir, first.css, false).includes("document"), false);
});

test("virtual:dsx-registry resolves to a private id and loads the compiled registry", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({ name: "shop", scheme: "shop" }),
    "Components/App.dsx": APP,
    "Components/Card.dsx": `<stack><text value="card"/></stack>`,
  });
  try {
    const plugin = dsx();
    plugin.configResolved({ root: project.root });
    const resolved = plugin.resolveId(REGISTRY_ID);
    assert.equal(resolved, `\0${REGISTRY_ID}`);
    assert.equal(plugin.resolveId("./main.ts"), null, "nothing else is claimed");
    assert.equal(plugin.load("./main.ts"), null);

    const code = plugin.load(resolved!);
    assert.ok(code !== null);
    const registry = JSON.parse(/export default ([\s\S]*);\n/.exec(code)![1]!) as {
      components: { [k: string]: unknown }; globalPool: { [k: string]: string }; css: string;
    };
    assert.deepEqual(Object.keys(registry.components).sort(), ["shop.App", "shop.Card"]);
    assert.equal(registry.globalPool["App"], "shop.App");
    assert.match(registry.css, /@layer dsx-tokens/);
  } finally {
    project.cleanup();
  }
});

test("an explicit `packages` option overrides the Vite root", () => {
  const project = fixture({
    "app/dsx.json": JSON.stringify({ name: "shop", scheme: "shop" }),
    "app/Components/App.dsx": APP,
    "other/dsx.json": JSON.stringify({ name: "kit", scheme: "kit" }),
    "other/Components/Widget.dsx": `<stack><text value="w"/></stack>`,
  });
  try {
    const plugin = dsx({ packages: [join(project.root, "app"), join(project.root, "other")] });
    plugin.configResolved({ root: project.root });
    const registry = JSON.parse(/export default ([\s\S]*);\n/.exec(plugin.load(`\0${REGISTRY_ID}`)!)![1]!) as {
      components: { [k: string]: unknown };
    };
    assert.deepEqual(Object.keys(registry.components).sort(), ["kit.Widget", "shop.App"]);
  } finally {
    project.cleanup();
  }
});

test("HMR v0.1: a .dsx change is a FULL PAGE RELOAD, and the registry is invalidated first", () => {
  const plugin = dsx();
  const sent: Array<{ type: string; path?: string }> = [];
  const invalidated: unknown[] = [];
  const registryModule = { id: `\0${REGISTRY_ID}` };
  const ctx: HotContext = {
    file: "/pkg/Components/App.dsx",
    server: {
      ws: { send: (payload) => sent.push(payload) },
      moduleGraph: {
        getModuleById: (id) => (id === `\0${REGISTRY_ID}` ? registryModule : undefined),
        invalidateModule: (mod) => invalidated.push(mod),
      },
    },
  };
  assert.deepEqual(plugin.handleHotUpdate(ctx), []);
  assert.deepEqual(sent, [{ type: "full-reload", path: "*" }]);
  assert.deepEqual(invalidated, [registryModule]);
});

test("HMR ignores non-.dsx files and survives a bare context", () => {
  const plugin = dsx();
  assert.equal(plugin.handleHotUpdate({ file: "/pkg/main.ts" }), undefined);
  assert.doesNotThrow(() => plugin.handleHotUpdate({ file: "/pkg/Components/App.dsx" }));
});

test("a malformed .dsx surfaces the compiler's own located error, never a silent empty module", () => {
  assert.throws(
    () => dsx().transform(`<stack><text value="a"></stack>`, "/pkg/Components/Bad.dsx"),
    /mismatched close/,
  );
});

// ── the dsx.json `web` BLOCK (M-10 / W3 breadth) ─────────────────────────────────────

test("the plugin consumes each package's dsx.json web block: routes, styles, links", () => {
  const { root, cleanup } = fixture({
    "Config/routes.json": JSON.stringify({ routes: [{ path: "/", component: "app.App" }], notFound: "app.Missing" }),
    "alpha/dsx.json": JSON.stringify({
      scheme: "alpha",
      web: {
        routes: [{ path: "/alpha", component: "Screen" }],
        styles: ["web/theme.css"],
        links: { appleAppIds: ["ABCDE12345.com.acme.app"] },
      },
    }),
    "alpha/web/theme.css": ".alpha-brand { color: rebeccapurple; }",
    "alpha/Components/Screen.dsx": `<stack><text value="alpha"/></stack>`,
    "beta/dsx.json": JSON.stringify({ scheme: "beta", web: { routes: [{ path: "/beta", component: "Screen" }] } }),
    "beta/Components/Screen.dsx": `<stack><text value="beta"/></stack>`,
    "Components/App.dsx": APP,
    "dsx.json": JSON.stringify({ scheme: "app" }),
  });
  try {
    const plugin = dsx({ packages: ["alpha", "beta", "."] });
    plugin.configResolved({ root });
    assert.equal(plugin.resolveId(ROUTES_ID), `\0${ROUTES_ID}`);
    assert.equal(plugin.resolveId("virtual:something-else"), null);

    const routesModule = plugin.load(`\0${ROUTES_ID}`)!;
    const paths = (JSON.parse(/export const routes = (\[.*?\]);/s.exec(routesModule)![1]!) as Array<{ path: string; component?: string }>);
    assert.deepEqual(paths.map((r) => [r.path, r.component]), [
      ["/", "app.App"],
      ["/alpha", "alpha.Screen"],
      ["/beta", "beta.Screen"],
    ], "the application table is authoritative and package routes merge underneath it");
    assert.match(routesModule, /export const notFound = "app.Missing";/);

    const registryModule = plugin.load(`\0${REGISTRY_ID}`)!;
    assert.match(registryModule, /alpha-brand/, "a package's declared stylesheet is folded into the build");
    assert.match(registryModule, /"\/beta"/);

    const collected = collectPackageWeb(
      ["alpha", "beta"].map((d) => join(root, d)),
      [{ path: "/" }, { path: "/orders/:id" }],
    );
    assert.deepEqual(collected.packages.map((p) => p.scheme), ["alpha", "beta"]);
    assert.deepEqual(collected.links.map((f) => f.path), [".well-known/apple-app-site-association"]);
    assert.match(collected.links[0]!.contents, /"\/orders\/\*"/, "the association is GENERATED from the route table");
  } finally {
    cleanup();
  }
});

test("a package route COLLISION fails the build instead of shipping order-dependent URLs", () => {
  const { root, cleanup } = fixture({
    "alpha/dsx.json": JSON.stringify({ scheme: "alpha", web: { routes: [{ path: "/x", component: "Screen" }] } }),
    "alpha/Components/Screen.dsx": `<stack/>`,
    "beta/dsx.json": JSON.stringify({ scheme: "beta", web: { routes: [{ path: "/x", component: "Screen" }] } }),
    "beta/Components/Screen.dsx": `<stack/>`,
  });
  try {
    const plugin = dsx({ packages: ["alpha", "beta"] });
    plugin.configResolved({ root });
    assert.throws(() => plugin.load(`\0${REGISTRY_ID}`), /collision on "\/x"/);
  } finally {
    cleanup();
  }
});

test("a package with no web block, or an unreadable manifest, contributes nothing", () => {
  const { root, cleanup } = fixture({
    "plain/dsx.json": JSON.stringify({ scheme: "plain" }),
    "broken/dsx.json": "{ not json",
  });
  try {
    assert.deepEqual(readPackageWebBlock(join(root, "plain")), { scheme: "plain" });
    assert.equal(readPackageWebBlock(join(root, "broken")), null);
    assert.equal(readPackageWebBlock(join(root, "absent")), null);
    const collected = collectPackageWeb([join(root, "plain"), join(root, "broken")], [{ path: "/" }]);
    assert.deepEqual(collected.styles, []);
    assert.deepEqual(collected.links, []);
  } finally {
    cleanup();
  }
});
