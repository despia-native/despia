//
//  web-manifest.test.ts — the dsx.json `web` BLOCK (W3 breadth, W4 package route merging
//  + collision lint) and the NATIVE universal-links generator (W4).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readPackageWeb, mergePackageRoutes, resolveWebManifests,
} from "../src/web-manifest.ts";
import {
  readUniversalLinks, linkPattern, linkPatterns, universalLinkFiles,
} from "../src/universal-links.ts";
import { buildRegistry, cssForComponentSlice } from "../src/registry.ts";

// ── the block reader ────────────────────────────────────────────────────────────────

test("web.routes qualifies BARE components inside the declaring package", () => {
  const { web, diagnostics } = readPackageWeb("acme", {
    routes: [
      { path: "/pricing", component: "Pricing" },
      { path: "/legacy", redirect: "/pricing" },
      { path: "/shared", component: "other.Screen" },
    ],
  });
  assert.deepEqual(diagnostics.errors, []);
  assert.deepEqual(web.routes.map((r) => [r.path, r.component ?? r.redirect]), [
    ["/pricing", "acme.Pricing"],
    ["/legacy", "/pricing"],
    ["/shared", "other.Screen"],
  ]);
});

test("a malformed web block is REPORTED per key, never guessed at", () => {
  const { web, diagnostics } = readPackageWeb("acme", {
    routes: [
      { path: "pricing", component: "A" },              // not absolute
      { path: "/ok", component: "A" },
      { path: "/ok", component: "B" },                  // duplicate inside one package
      { path: "/orphan" },                              // neither component nor redirect
      { path: "/q?x=1", component: "A" },               // query in a path
      "nope",
    ] as unknown[],
    styles: ["../escape.css", "web/theme.css"],
    base: "app",
  });
  assert.deepEqual(web.routes.map((r) => r.path), ["/ok"]);
  assert.deepEqual(web.styles, ["web/theme.css"], "a .. path never becomes a build input");
  assert.equal(web.base, undefined);
  assert.equal(diagnostics.errors.length, 7, diagnostics.errors.join("\n"));
  assert.ok(diagnostics.errors.some((e) => e.includes("declared twice")));
  assert.ok(diagnostics.errors.some((e) => e.includes("neither a component nor a redirect")));
  assert.ok(diagnostics.errors.some((e) => e.includes('"base" must be an absolute path')));
});

test("web.base normalizes to a trailing slash; an absent block contributes nothing", () => {
  assert.equal(readPackageWeb("acme", { base: "/app" }).web.base, "/app/");
  const empty = readPackageWeb("acme", undefined).web;
  assert.deepEqual([empty.routes, empty.styles, empty.assets], [[], [], []]);
  assert.deepEqual(empty.dependencies, {});
  assert.equal(empty.entry, undefined);
});

// ── web.dependencies + web.entry (A3) ───────────────────────────────────────────────

test("web.dependencies + web.entry read into the package's browser contribution", () => {
  const { web, diagnostics } = readPackageWeb("editor", {
    dependencies: { "monaco-editor": "^0.52.0", "@scope/thing": "1.2.3" },
    entry: "web/editor.ts",
  });
  assert.deepEqual(diagnostics.errors, []);
  assert.deepEqual(web.dependencies, { "monaco-editor": "^0.52.0", "@scope/thing": "1.2.3" });
  assert.equal(web.entry, "web/editor.ts");
});

test("a browser entry with no dependencies is legal — not every package needs npm", () => {
  const { web, diagnostics } = readPackageWeb("plain", { entry: "web/boot.ts" });
  assert.deepEqual(diagnostics.errors, []);
  assert.equal(web.entry, "web/boot.ts");
  assert.deepEqual(web.dependencies, {});
});

test("dependencies with no entry is an ERROR — nothing would import them", () => {
  // The silent-no-op class: npm installs, the bundle is unchanged, and the author believes
  // a library shipped.
  const { diagnostics } = readPackageWeb("ghost", { dependencies: { "left-pad": "1.3.0" } });
  assert.ok(diagnostics.errors.some((e) => e.includes('"dependencies" without an "entry"')));
});

test("coordinates are held to the SAME shapes prepare_server.rb applies to server_dependencies", () => {
  const bad = readPackageWeb("acme", {
    entry: "web/x.ts",
    dependencies: { "Bad Name": "1.0.0", ok: "not-a-version", "*": "1.0.0" },
  });
  assert.ok(bad.diagnostics.errors.some((e) => e.includes("is not a plain npm package name")));
  assert.ok(bad.diagnostics.errors.some((e) => e.includes("is not a plain npm version range")));
  // A wildcard name is the one that matters: on the server it externalises the whole bundle.
  assert.equal(bad.web.dependencies["*"], undefined);
  assert.deepEqual(bad.web.dependencies, {});

  const shapes = readPackageWeb("acme", { entry: "web/x.ts", dependencies: { pg: "^8.11.3", a: "~1.0.0", b: "1.0.0-rc.1" } });
  assert.deepEqual(shapes.diagnostics.errors, []);
  assert.deepEqual(Object.keys(shapes.web.dependencies).sort(), ["a", "b", "pg"]);
});

test("a traversing or malformed entry is refused", () => {
  for (const entry of ["../outside.ts", "/absolute.ts", "web/../../escape.ts"]) {
    const { web, diagnostics } = readPackageWeb("acme", { entry });
    assert.equal(web.entry, undefined, entry);
    assert.ok(diagnostics.errors.some((e) => e.includes('"entry" must be a package-relative module path')), entry);
  }
});

// ── merging + the collision lint ────────────────────────────────────────────────────

test("the APPLICATION table wins; a package↔package collision is an ERROR", () => {
  const app = [{ path: "/", component: "app.Home" }, { path: "/pricing", component: "app.Pricing" }];
  const one = readPackageWeb("alpha", { routes: [
    { path: "/pricing", component: "Pricing" },   // collides with the app: dropped + warned
    { path: "/alpha", component: "Screen" },
    { path: "/shared", component: "Screen" },
  ] }).web;
  const two = readPackageWeb("beta", { routes: [
    { path: "/beta", component: "Screen" },
    { path: "/shared", component: "Screen" },     // collides with alpha: ERROR
  ] }).web;

  const merged = mergePackageRoutes(app, [one, two]);
  assert.deepEqual(merged.routes.map((r) => r.path), ["/", "/pricing", "/alpha", "/shared", "/beta"]);
  assert.equal(merged.routes.find((r) => r.path === "/pricing")?.component, "app.Pricing",
    "the application's own component is never replaced by a package's");
  assert.equal(merged.diagnostics.warnings.length, 1);
  assert.match(merged.diagnostics.warnings[0]!, /alpha contributes route "\/pricing".*application table wins/s);
  assert.equal(merged.diagnostics.errors.length, 1);
  assert.match(merged.diagnostics.errors[0]!, /collision on "\/shared".*alpha and beta/s);
});

test("resolveWebManifests THROWS on a collision — a build must not ship order-dependent URLs", () => {
  const manifests = [
    { scheme: "alpha", web: { routes: [{ path: "/x", component: "A" }] } },
    { scheme: "beta", web: { routes: [{ path: "/x", component: "B" }] } },
  ];
  assert.throws(() => resolveWebManifests(undefined, manifests), /collision on "\/x"/);
  const ok = resolveWebManifests([{ path: "/", component: "app.Home" }], [manifests[0]!]);
  assert.deepEqual(ok.routes.map((r) => r.path), ["/", "/x"]);
  assert.deepEqual(ok.warnings, []);
});

test("buildRegistry merges package routes from real dsx.json files on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-web-"));
  try {
    for (const [scheme, routes] of [["alpha", "/alpha"], ["beta", "/beta"]] as const) {
      const pkg = join(dir, scheme);
      mkdirSync(join(pkg, "Components"), { recursive: true });
      writeFileSync(join(pkg, "dsx.json"), JSON.stringify({
        scheme, web: { routes: [{ path: routes, component: "Screen" }] },
      }));
      writeFileSync(join(pkg, "Components/Screen.dsx"), `<stack><text value="${scheme}"/></stack>`);
    }
    const registry = buildRegistry(
      [{ dir: join(dir, "alpha") }, { dir: join(dir, "beta") }],
      [],
      { routes: [{ path: "/", component: "alpha.Screen" }] },
    );
    assert.deepEqual(registry.routes?.map((r) => [r.path, r.component]), [
      ["/", "alpha.Screen"],
      ["/alpha", "alpha.Screen"],
      ["/beta", "beta.Screen"],
    ]);
    assert.deepEqual(registry.packageWeb?.map((p) => p.scheme), ["alpha", "beta"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRegistry refuses a route whose malformed component was skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-web-routed-broken-"));
  try {
    mkdirSync(join(dir, "Components"), { recursive: true });
    writeFileSync(join(dir, "dsx.json"), JSON.stringify({
      scheme: "broken", web: { routes: [{ path: "/broken", component: "Screen" }] },
    }));
    writeFileSync(join(dir, "Components/Screen.dsx"), `<stack><text value="broken"></stack>`);
    assert.throws(
      () => buildRegistry([{ dir }]),
      /routed component did not compile: "\/broken" → "broken\.Screen"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the universal-links generator ───────────────────────────────────────────────────

const APPLE = "ABCDE12345.com.acme.app";
const PRINT = Array.from({ length: 32 }, () => "AA").join(":");

test("a route path becomes an association PATTERN, params collapsing to one component", () => {
  assert.equal(linkPattern("/orders/:id"), "/orders/*");
  assert.equal(linkPattern("/orders/{id}/items/{sku}"), "/orders/*/items/*");
  assert.equal(linkPattern("/docs/*"), "/docs/*");
  assert.equal(linkPattern("/"), "/");
  assert.deepEqual(
    linkPatterns([{ path: "/" }, { path: "/orders/:id" }, { path: "/orders/{id}" }], ["/admin/*"]),
    ["NOT /admin/*", "/", "/orders/*"],
    "exclusions come FIRST (Apple matches in order) and duplicates collapse",
  );
});

test("a links block is validated as a whole — a half-valid association never ships", () => {
  assert.equal(readUniversalLinks(undefined), null);
  assert.throws(() => readUniversalLinks({ appleAppIds: ["com.acme.app"] }), /10-char TeamID/);
  assert.throws(() => readUniversalLinks({ androidPackages: [{ package: "com.acme.app" }] }), /SHA-256/);
  assert.throws(() => readUniversalLinks({ exclude: ["/ok"] }), /declares neither appleAppIds nor androidPackages/);
  const links = readUniversalLinks({
    appleAppIds: [APPLE],
    androidPackages: [{ package: "com.acme.app", sha256: [PRINT.toLowerCase()] }],
    exclude: ["/admin/*"],
  })!;
  assert.deepEqual(links.appleAppIds, [APPLE]);
  assert.deepEqual(links.androidPackages, [{ package: "com.acme.app", sha256: [PRINT] }]);
});

test("the two association files are generated from the route table, or not at all", () => {
  const routes = [{ path: "/" }, { path: "/orders/:id" }];
  assert.deepEqual(universalLinkFiles(null, routes), [], "no declaration ⇒ NOTHING published");
  assert.deepEqual(
    universalLinkFiles(readUniversalLinks({ appleAppIds: [APPLE] }), []), [],
    "an empty route table publishes nothing rather than an association that matches nothing",
  );

  const files = universalLinkFiles(readUniversalLinks({
    appleAppIds: [APPLE],
    androidPackages: [{ package: "com.acme.app", sha256: [PRINT] }],
    exclude: ["/admin/*"],
  }), routes);
  assert.deepEqual(files.map((f) => f.path),
    [".well-known/apple-app-site-association", ".well-known/assetlinks.json"]);
  const aasa = JSON.parse(files[0]!.contents) as {
    applinks: { details: Array<{ appID: string; paths: string[] }> };
    webcredentials: { apps: string[] };
  };
  assert.equal(aasa.applinks.details[0]?.appID, APPLE);
  assert.deepEqual(aasa.applinks.details[0]?.paths, ["NOT /admin/*", "/", "/orders/*"]);
  assert.deepEqual(aasa.webcredentials.apps, [APPLE]);
  assert.ok(!files[0]!.path.endsWith(".json"), "Apple serves the AASA with no extension");

  const assetlinks = JSON.parse(files[1]!.contents) as Array<{
    relation: string[]; target: { package_name: string; sha256_cert_fingerprints: string[] };
  }>;
  assert.deepEqual(assetlinks[0]?.relation, ["delegate_permission/common.handle_all_urls"]);
  assert.equal(assetlinks[0]?.target.package_name, "com.acme.app");
  assert.deepEqual(assetlinks[0]?.target.sha256_cert_fingerprints, [PRINT]);
});

test("a links block reaches the generator through the package web block", () => {
  const { web, diagnostics } = readPackageWeb("acme", {
    links: { appleAppIds: [APPLE] },
    routes: [{ path: "/pricing", component: "Pricing" }],
  });
  assert.deepEqual(diagnostics.errors, []);
  const files = universalLinkFiles(web.links ?? null, web.routes);
  assert.equal(files.length, 1);
  assert.match(files[0]!.contents, /"\/pricing"/);

  const bad = readPackageWeb("acme", { links: { appleAppIds: ["nope"] } });
  assert.equal(bad.web.links, undefined);
  assert.equal(bad.diagnostics.errors.length, 1, "a bad links block is an error, not a silent skip");
});

// ── `web.styles`: the declared application stylesheet (C1) ─────────────────────────────
//
// Before this, `styles` parsed, validated and was then read by nobody: a project could
// declare a design system and ship a build with none of it. These cases pin that the sheet
// reaches registry.css, lands in the layer that lets a component still override it, and
// that a declared-but-missing file stops the build instead of vanishing.

function stylesProject(root: string, sheet: string | null): string {
  mkdirSync(join(root, "Components"), { recursive: true });
  mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(join(root, "dsx.json"), JSON.stringify({
    scheme: "styled", web: { styles: ["web/tokens.css"] },
  }));
  writeFileSync(join(root, "Components/Screen.dsx"),
    `<stack style="color: var(--brand)"><text value="hi"/></stack>`);
  if (sheet !== null) writeFileSync(join(root, "web/tokens.css"), sheet);
  return root;
}

test("a package's web.styles is folded into registry.css, in the dsx-theme layer", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-web-styles-"));
  try {
    stylesProject(dir, ":root { --brand: rebeccapurple; }");
    const registry = buildRegistry([{ dir }]);
    assert.match(registry.css, /@layer dsx-theme \{[\s\S]*--brand: rebeccapurple;[\s\S]*\}/);
    // The layer statement declares dsx-theme WEAKER than dsx-sheets and dsx-inline, so a
    // component can still override the application's design layer — which is the whole
    // reason it is a layer and not a prepended blob.
    const order = registry.css.slice(0, registry.css.indexOf(";") + 1);
    assert.ok(
      order.indexOf("dsx-theme") < order.indexOf("dsx-sheets"),
      `the theme layer must sit under component sheets: ${order}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a declared stylesheet that does not exist stops the build", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-web-styles-missing-"));
  try {
    stylesProject(dir, null);
    assert.throws(
      () => buildRegistry([{ dir }]),
      /web\.styles declares "web\/tokens\.css" but .* does not exist/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an embed slice carries the application theme — otherwise its var() reads resolve to nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-web-styles-slice-"));
  try {
    stylesProject(dir, ":root { --brand: rebeccapurple; }");
    const registry = buildRegistry([{ dir }]);
    assert.match(cssForComponentSlice(registry, ["styled.Screen"]), /--brand: rebeccapurple;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
