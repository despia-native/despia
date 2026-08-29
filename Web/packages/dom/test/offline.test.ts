//
//  offline.test.ts — the bundled floor's PAGE-half pure helpers (offline.ts): the tolerant
//  manifest reader (the kernel ContentManifest parser's dialect, verbatim), the
//  never|stale|live derivation (the DSXSource.publish state rule), and generation naming
//  (same manifest IS same generation). The worker's own copies of these are line-for-line
//  twins (a classic SW cannot import) — these tests pin the shared semantics.
//

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOfflineManifest, deriveState, generationName, navigationFallbackCandidates, matchRoutePattern } from "@despia-native/dom/offline";

test("offline manifest: the native seed dialect normalizes 1:1", () => {
  const m = normalizeOfflineManifest({
    entry: "index.html",
    assets: [
      { path: "index.html", sha256: "AB12" },
      "app.js",                                   // hash-less string form
      { path: "./styles/site.css" },              // ./ strip
      { path: "/despia/dsx/home.dsx" },           // leading-slash strip
    ],
  });
  assert.ok(m);
  assert.equal(m.entry, "index.html");
  assert.deepEqual(m.assets, [
    { path: "index.html", sha256: "AB12" },
    { path: "app.js" },
    { path: "styles/site.css" },
    { path: "despia/dsx/home.dsx" },
  ]);
});

test("offline manifest: files/bundles aliases are absorbed (the tolerant parser)", () => {
  assert.ok(normalizeOfflineManifest({ files: ["a.bin"] }));
  assert.ok(normalizeOfflineManifest({ bundles: [{ path: "pack.pck" }] }));
});

test("offline manifest: hostile or unusable documents are refused whole", () => {
  // an SPA catch-all 200 (HTML parsed as nothing) can never poison the floor
  assert.equal(normalizeOfflineManifest(null), null);
  assert.equal(normalizeOfflineManifest([]), null);
  assert.equal(normalizeOfflineManifest({ entry: "x" }), null);
  // per-entry rejection: escapes and absolute URLs vanish, the rest survives
  const m = normalizeOfflineManifest({ assets: ["../etc/passwd", "https://evil.example/x.js", "ok.js"] });
  assert.ok(m);
  assert.deepEqual(m.assets, [{ path: "ok.js" }]);
});

test("source state derivation is the DSXSource rule", () => {
  assert.equal(deriveState(true, false), "live");   // the origin answered this session
  assert.equal(deriveState(true, true), "live");
  assert.equal(deriveState(false, true), "stale");  // answered before, serving a copy now
  assert.equal(deriveState(false, false), "never"); // this install has never reached it
});

test("generation names are stable per manifest digest", () => {
  assert.equal(generationName("abcdef0123456789ff"), "dsx-gen-abcdef0123456789");
  assert.equal(generationName("abcdef0123456789ff"), generationName("abcdef0123456789ff"));
});

test("nav strategy: a DECLARED manifest key — swr accepted, anything else defaults off", () => {
  assert.equal(normalizeOfflineManifest({ assets: ["a.js"], nav: "swr" })?.nav, "swr");
  assert.equal(normalizeOfflineManifest({ assets: ["a.js"], nav: "yolo" })?.nav, undefined);
  assert.equal(normalizeOfflineManifest({ assets: ["a.js"] })?.nav, undefined);
});

test("dynamic patterns: the DSXPathMatch twin — params, braces, literals, trailing star", () => {
  assert.deepEqual(matchRoutePattern("/user/321", "/user/:id"), { id: "321" });
  assert.deepEqual(matchRoutePattern("/user/321/posts/9", "/user/{uid}/posts/:pid"), { uid: "321", pid: "9" });
  assert.equal(matchRoutePattern("/user", "/user/:id"), null);          // missing segment
  assert.equal(matchRoutePattern("/user/1/extra", "/user/:id"), null);  // too many segments
  assert.equal(matchRoutePattern("/account/1", "/user/:id"), null);     // literal mismatch
  assert.deepEqual(matchRoutePattern("/docs/a/b/c", "/docs/*"), {});    // trailing * soaks
  assert.deepEqual(matchRoutePattern("/anything", "*"), {});
});

test("dynamic routes ride the manifest: declared { pattern, page }, unsafe pages dropped", () => {
  const m = normalizeOfflineManifest({
    assets: ["index.html"],
    routes: [
      { pattern: "/user/:id", page: "/user/__param__/index.html" },   // leading slash normalized
      { pattern: "/evil/:x", page: "../outside.html" },               // escape → dropped
      { pattern: "", page: "x.html" },                                // empty pattern → dropped
    ],
  });
  assert.deepEqual(m?.routes, [{ pattern: "/user/:id", page: "user/__param__/index.html" }]);
});

test("navigation fallback: the route's own SSR export beats the shell (the exportStatic convention)", () => {
  assert.deepEqual(navigationFallbackCandidates("/"), ["index.html"]);
  assert.deepEqual(navigationFallbackCandidates("/gallery"), ["gallery/index.html", "gallery.html", "index.html"]);
  assert.deepEqual(navigationFallbackCandidates("/a/b/"), ["a/b/index.html", "a/b.html", "index.html"]);
  // a custom entry rides as the last resort exactly once
  assert.deepEqual(navigationFallbackCandidates("/x", "app.html"), ["x/index.html", "x.html", "app.html"]);
});
