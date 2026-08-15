//
//  router.test.ts — the FrameRouter's pure half: the popTo matching rule
//  (`deepestPathMatch`), pinned by the SHARED corpus OpenSource/Conformance/router/popto.json
//  (the Kotlin RouterTest drives the same file end-to-end through a real Router; Router.swift
//  is the compile-pending reference — the three-runtime law). The DOM-bound half (synchronous
//  truncation, the history echo, frame teardown) is exercised by build:demo + the
//  layout/screenshot oracles.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EchoGuard, FrameRouter, appBasePath, coldRootHistoryUrl, deepestPathMatch, echoKey , sheetFragmentName, sheetFragmentUrl } from "../src/router.ts";

test("an explicit app base survives a nested SSR route", () => {
  const nested = "https://example.test/apps/despia/gallery/index.html";
  assert.equal(appBasePath(undefined, nested), "/apps/despia/gallery/");
  assert.equal(appBasePath("/apps/despia/", nested), "/apps/despia/");
  assert.equal(appBasePath("../", nested), "/apps/despia/");
  assert.equal(appBasePath("../../", nested), "/apps/");
});

test("a cold detail route gets a distinct root history entry, so Back and Reload agree", () => {
  const detail = "https://example.test/demo/site/flex?density=compact";
  const root = coldRootHistoryUrl("/demo/site/", detail);
  assert.equal(root, "https://example.test/demo/site/");

  const historyStack = [root, detail];
  historyStack.pop(); // pointer Back and keyboard Back use the same browser traversal
  assert.equal(historyStack.at(-1), root, "revealing the root frame also reveals its root URL");
  assert.equal(new URL(historyStack.at(-1)!).pathname, "/demo/site/", "Reload stays on the root");
});

type Case = { name: string; paths: (string | null)[]; target: string; expect: number };
const corpus = JSON.parse(
  readFileSync(new URL("../../../../Conformance/router/popto.json", import.meta.url), "utf8"),
) as { cases: Case[] };

test("the shared popTo corpus runs and is non-trivial", () => {
  assert.ok(corpus.cases.length >= 10, `expected a populated corpus, got ${corpus.cases.length}`);
});

for (const c of corpus.cases) {
  test(`popto corpus: ${c.name}`, () => {
    assert.equal(deepestPathMatch(c.paths, c.target), c.expect);
  });
}

//
//  The SHARED resolution corpus (Conformance/router/resolve.json) — the unified table
//  grammar: `component` mounts, params+query→vars with QUERY WINNING (navigatePath's
//  `{ ...m.params, ...query }`), `meta.title`. Driven over the REAL FrameRouter.resolveUrl
//  (guards/requires/redirects included) plus navigatePath's own URL decomposition — the
//  Kotlin RouterTest runs the same file end-to-end through a real Router; Router.swift
//  resolved()/materialize() is the compile-pending reference (the three-runtime law).
//

type ResolveCase = {
  name: string;
  table: Record<string, unknown>[];
  path: string;
  expect: { component: string | null; vars: Record<string, string>; title: string | null };
};
const resolveCorpus = JSON.parse(
  readFileSync(new URL("../../../../Conformance/router/resolve.json", import.meta.url), "utf8"),
) as { cases: ResolveCase[] };

test("the shared resolve corpus runs and is non-trivial", () => {
  assert.ok(resolveCorpus.cases.length >= 8, `expected a populated corpus, got ${resolveCorpus.cases.length}`);
});

for (const c of resolveCorpus.cases) {
  test(`resolve corpus: ${c.name}`, () => {
    const fr = new FrameRouter(
      { components: {}, routes: c.table } as unknown as ConstructorParameters<typeof FrameRouter>[0],
      null as unknown as HTMLElement,
    );
    // navigatePath's exact decomposition: pathname resolves, the query parses separately…
    const url = new URL(c.path, "http://x");
    const m = fr.resolveUrl(url.pathname);
    if (c.expect.component === null) {
      assert.ok(m === null || m.route.component === undefined, "expected no component route");
      return;
    }
    assert.ok(m !== null, "expected a match");
    assert.equal(m.route.component, c.expect.component);
    // …and vars are params + query merged, query winning (the corpus-pinned rule).
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    assert.deepEqual({ ...m.params, ...query }, c.expect.vars);
    assert.equal(m.route.meta?.title ?? null, c.expect.title);
  });
}

//
//  The double-tap echo guard (S-08 / demo-followups §C.0) — a NAMED push/present identical to
//  the one just before it, inside 500ms, is one tap dispatched twice, not intent. This is the
//  PURE half (echoKey + EchoGuard), the web twin of Router.kt/Router.swift `echoKey`/`isEcho`
//  pinned by RouterTest.doubleTapEchoPushesAndPresentsAreDroppedAndReductionsRearm. The
//  DOM-bound wiring (push()/present() consulting the guard; reductions clearing it) rides the
//  demo walk, exactly like the rest of this router's DOM-bound half. The clock is injected so
//  the 500ms window is deterministic instead of leaning on wall-time.
//

test("echoKey is stable, order-insensitive over seeds, and separates verb/component/mode", () => {
  // identical inputs → identical key; the vars digest sorts keys, so field order never matters
  assert.equal(
    echoKey("push", "Cart", "", { a: "1", b: "2" }),
    echoKey("push", "Cart", "", { b: "2", a: "1" }),
    "seed field order must not change identity",
  );
  // DIFFERENT vars = intent, not an echo → different key
  assert.notEqual(echoKey("push", "Cart", "", { sku: "gold" }), echoKey("push", "Cart", "", {}));
  // attrs participate too (both seeds, native 1:1)
  assert.notEqual(echoKey("push", "Cart", "", {}, { size: "L" }), echoKey("push", "Cart", "", {}));
  // verb + component + present mode all separate the identity
  assert.notEqual(echoKey("push", "Cart", ""), echoKey("present:sheet", "Cart", ""));
  assert.notEqual(echoKey("present:sheet", "Paywall", ""), echoKey("present:cover", "Paywall", ""));
  assert.notEqual(echoKey("push", "Cart", ""), echoKey("push", "Checkout", ""));
});

test("EchoGuard drops an identical consecutive key inside the window and arms on a non-echo", () => {
  let now = 1000;
  const g = new EchoGuard(500, () => now);
  const cart = echoKey("push", "Cart", "");
  assert.equal(g.isEcho(cart), false, "first push arms the memo, always lands");
  assert.equal(g.isEcho(cart), true, "the identical consecutive push is the double-tap echo — dropped");
  // DIFFERENT input is intent — it lands AND re-arms the memo on the new key
  const cartGold = echoKey("push", "Cart", "", { sku: "gold" });
  assert.equal(g.isEcho(cartGold), false, "different vars = intent, lands");
  assert.equal(g.isEcho(cartGold), true, "…and now IT is the armed key");
  // outside the 500ms window the same key is no longer an echo
  now += 500;                                        // exactly the boundary is NOT inside (< 500)
  assert.equal(g.isEcho(cartGold), false, "past the window the repeat lands again");
});

test("EchoGuard.clear re-arms so an intentional open→close→open replay is never eaten", () => {
  let now = 5000;
  const g = new EchoGuard(500, () => now);
  const paywall = echoKey("present:sheet", "Paywall", "");
  assert.equal(g.isEcho(paywall), false);
  assert.equal(g.isEcho(paywall), true, "the echo is dropped");
  g.clear();                                         // a dismissal / stack reduction re-arms
  assert.equal(g.isEcho(paywall), false, "after clear the same present lands — replay is intent");
});

test("EchoGuard reproduces the native RouterTest double-tap scenario end to end", () => {
  // mirrors RouterTest.doubleTapEchoPushesAndPresentsAreDroppedAndReductionsRearm, over the pure
  // guard: push Cart, push Cart (echo, dropped), push Cart{sku} (intent), a reduction re-arms,
  // replay lands; then the same for a present + a dismissal re-arm.
  let now = 0;
  const g = new EchoGuard(500, () => now);
  const cart = echoKey("push", "Cart", "");
  assert.equal(g.isEcho(cart), false);               // root + ONE Cart
  assert.equal(g.isEcho(cart), true);                // the echo — no second Cart
  const cartGold = echoKey("push", "Cart", "", { sku: "gold" });
  assert.equal(g.isEcho(cartGold), false);           // different vars = intent, lands
  g.clear();                                         // pop() — a reduction re-arms
  assert.equal(g.isEcho(cartGold), false);           // the replay after the pop lands
  const paywall = echoKey("present:sheet", "Paywall", "");
  assert.equal(g.isEcho(paywall), false);
  assert.equal(g.isEcho(paywall), true);             // identical consecutive present = echo
  g.clear();                                         // dismiss() — a modal removal re-arms
  assert.equal(g.isEcho(paywall), false);            // the re-present lands
});

// ── SHEET FRAGMENTS (W4) ────────────────────────────────────────────────────────────

test("a sheet fragment is only the exact #sheet= shape, and never an ordinary anchor", () => {
  assert.equal(sheetFragmentName("#sheet=Filters"), "Filters");
  assert.equal(sheetFragmentName("sheet=demo.Filters"), "demo.Filters");
  assert.equal(sheetFragmentName("#sheet=Order%20Filters"), null, "a space is not a component name");
  assert.equal(sheetFragmentName("#pricing"), null, "an in-page anchor stays an anchor");
  assert.equal(sheetFragmentName("#sheet="), null);
  assert.equal(sheetFragmentName("#sheet=%E0%A4%A"), null, "a malformed escape is refused, never thrown");
  assert.equal(sheetFragmentName(""), null);
});

test("a sheet fragment rides ON the current URL — path and query are untouched", () => {
  assert.equal(
    sheetFragmentUrl("https://app.example/orders?page=2", "Filters"),
    "https://app.example/orders?page=2#sheet=Filters",
  );
  assert.equal(
    sheetFragmentUrl("https://app.example/orders#pricing", "demo.Filters"),
    "https://app.example/orders#sheet=demo.Filters",
    "an existing anchor is replaced by the sheet fragment, not appended to",
  );
  // Round-trips: what the router writes is what it reads back on a cold load.
  for (const name of ["Filters", "demo.Filters", "A_1"]) {
    assert.equal(sheetFragmentName(new URL(sheetFragmentUrl("https://x.example/p", name)).hash), name);
  }
});
