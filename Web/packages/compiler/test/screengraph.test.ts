//
//  screengraph.test.ts - the map has to be TRUE before it can be a picture.
//
//  The canvas's whole claim (v4-launch/platform/02-canvas.md) is that it is derived, so a
//  wrong map is a bug here rather than a stale drawing. These cases pin the derivation: which
//  documents become nodes, which navigations become edges, what gesture a person performs to
//  traverse one, and - the part that pays for the feature - which surfaces nothing can reach.
//
//  The last block runs the extractor over the repo's OWN shipped documents. A fixture proves
//  the rules; only real markup proves they survive contact with markup somebody wrote for a
//  different reason.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  buildScreenGraph, humanise, matchRoute,
  type GraphDocument, type GraphRoute, type ScreenEdge,
} from "../src/screengraph.ts";

const ROUTES: GraphRoute[] = [
  { path: "/", component: "Home" },
  { path: "/apps", component: "Apps" },
  { path: "/apps/:id", component: "AppDetail" },
  { path: "/settings", component: "Settings" },
];

function doc(file: string, source: string): GraphDocument { return { file, source }; }

function edge(edges: ScreenEdge[], from: string, to: string | null): ScreenEdge | undefined {
  return edges.find((e) => e.from === from && e.to === to);
}

// -- names, which a person reads --------------------------------------------------------

test("a surface is named what the author typed, spaced out - never a generated name", () => {
  assert.equal(humanise("RestaurantMenu"), "Restaurant Menu");
  assert.equal(humanise("AppDetail"), "App Detail");
  assert.equal(humanise("restaurant-menu"), "Restaurant Menu");
  assert.equal(humanise("uber_one_checkout"), "Uber One Checkout");
  // An acronym stays whole: DSXWebView is not D S X Web View.
  assert.equal(humanise("DSXWebView"), "DSX Web View");
  assert.equal(humanise("Home"), "Home");
});

// -- routes, which decide what a screen IS ----------------------------------------------

test("a written target resolves to the route PATTERN, because the pattern is the screen", () => {
  assert.equal(matchRoute("/apps", ROUTES)?.component, "Apps");
  assert.equal(matchRoute("/apps/42", ROUTES)?.component, "AppDetail");
  // The id is data. An interpolated segment is a wildcard, not a literal to fail on.
  assert.equal(matchRoute("/apps/{{ item.id }}", ROUTES)?.component, "AppDetail");
  assert.equal(matchRoute("/apps/42?tab=builds", ROUTES)?.component, "AppDetail");
  // A concrete segment beats a param when both could match.
  const withStatic = [...ROUTES, { path: "/apps/new", component: "AppNew" }];
  assert.equal(matchRoute("/apps/new", withStatic)?.component, "AppNew");
  assert.equal(matchRoute("/apps/7", withStatic)?.component, "AppDetail");
  assert.equal(matchRoute("/nope", ROUTES), null);
});

// -- edges, and the gesture that causes them --------------------------------------------

test("href is an edge, and the gesture is a tap", () => {
  const g = buildScreenGraph([
    doc("Components/Apps.dsx", `<stack><row href="/apps/{{ item.id }}"><text value="x"/></row></stack>`),
    doc("Components/AppDetail.dsx", `<stack><text value="detail"/></stack>`),
  ], ROUTES);
  const e = edge(g.edges, "Apps", "AppDetail");
  assert.ok(e !== undefined, JSON.stringify(g.edges));
  assert.equal(e.kind, "push");
  assert.equal(e.gesture, "TAP");
  assert.equal(e.dynamic, true);
});

test("each router verb is its own kind of edge, because they are not the same navigation", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack>
      <button on:tap="dsx.module.route.push({ path: '/apps' })"/>
      <button on:tap="dsx.module.route.replace({ path: '/settings' })"/>
      <button on:tap="dsx.module.route.reset({ path: '/' })"/>
      <button on:tap="dsx.module.route.pop()"/>
    </stack>`),
    doc("Components/Apps.dsx", `<stack/>`),
    doc("Components/Settings.dsx", `<stack/>`),
  ], ROUTES);
  assert.equal(edge(g.edges, "Home", "Apps")?.kind, "push");
  assert.equal(edge(g.edges, "Home", "Settings")?.kind, "replace");
  assert.equal(edge(g.edges, "Home", "Home")?.kind, "reset");
  // pop has no literal target: a return along the stack, not a new destination.
  assert.ok(g.edges.some((e) => e.kind === "back" && e.to === null));
});

test("route.path = is a REPLACE, and a built target keeps its literal prefix", () => {
  const g = buildScreenGraph([
    doc("Components/Apps.dsx", `<stack>
      <head><action as="openApp" inputs="id">dsx.route.path = '/apps/' + id</action></head>
      <button on:tap="openApp({ id: item.id })"/>
    </stack>`),
    doc("Components/AppDetail.dsx", `<stack/>`),
  ], ROUTES);
  const e = edge(g.edges, "Apps", "AppDetail");
  // The navigation lives in a NAMED ACTION and the button only calls it. The gesture reported
  // is the one a person actually performs, not "called an action".
  assert.ok(e !== undefined, JSON.stringify(g.edges));
  assert.equal(e.kind, "replace");
  assert.equal(e.gesture, "TAP");
  assert.equal(e.dynamic, true);
});

test("the gesture is whichever handler the navigation sits in", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack>
      <form on:submit="dsx.module.route.push({ path: '/apps' })"/>
      <stack on:appear="dsx.module.route.replace({ path: '/settings' })"/>
    </stack>`),
    doc("Components/Apps.dsx", `<stack/>`),
    doc("Components/Settings.dsx", `<stack/>`),
  ], ROUTES);
  assert.equal(edge(g.edges, "Home", "Apps")?.gesture, "SUBMIT");
  assert.equal(edge(g.edges, "Home", "Settings")?.gesture, "ON APPEAR");
});

test("two ways to the same screen collapse to ONE edge that says how many", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack>
      <button on:tap="dsx.module.route.push({ path: '/apps' })"/>
      <row on:tap="dsx.module.route.push({ path: '/apps' })"/>
    </stack>`),
    doc("Components/Apps.dsx", `<stack/>`),
  ], ROUTES);
  const to = g.edges.filter((e) => e.from === "Home" && e.to === "Apps");
  // One line, not two on top of each other. That collapse is what keeps a real map readable.
  assert.equal(to.length, 1);
  assert.equal(to[0]!.count, 2);
  assert.equal(to[0]!.gesture, "TAP");
});

test("two DIFFERENT gestures to the same screen say so", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack>
      <button on:tap="dsx.module.route.push({ path: '/apps' })"/>
      <form on:submit="dsx.module.route.push({ path: '/apps' })"/>
    </stack>`),
    doc("Components/Apps.dsx", `<stack/>`),
  ], ROUTES);
  assert.equal(edge(g.edges, "Home", "Apps")?.gesture, "2 WAYS");
});

test("a sheet is a presented child of its own document, not a separate screen", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><sheet present="dsx.variable.open"><text value="x"/></sheet></stack>`),
  ], ROUTES);
  const e = g.edges.find((x) => x.kind === "present");
  assert.ok(e !== undefined);
  assert.equal(e.from, "Home");
  assert.equal(e.to, "Home");
});

// -- the findings the map exists to surface ----------------------------------------------

test("a surface nothing can reach is FLAGGED, which is the whole point of a map", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><row href="/apps"/></stack>`),
    doc("Components/Apps.dsx", `<stack/>`),
    doc("Components/Orphan.dsx", `<stack><text value="nothing points here"/></stack>`),
  ], ROUTES);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("Home")!.reachable, true);
  assert.equal(byId.get("Apps")!.reachable, true);
  // Dead code with a picture. Invisible in a folder, obvious on a map.
  assert.equal(byId.get("Orphan")!.reachable, false);
});

test("reachability is transitive, so a screen deep behind a link is not reported as dead", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><row href="/apps"/></stack>`),
    doc("Components/Apps.dsx", `<stack><row href="/apps/1"/></stack>`),
    doc("Components/AppDetail.dsx", `<stack/>`),
  ], ROUTES);
  assert.equal(g.nodes.find((n) => n.id === "AppDetail")!.reachable, true);
});

test("a component composed into a live screen is NOT dead code", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><Card/><Sidebar/></stack>`),
    doc("Components/Card.dsx", `<stack><text value="card"/></stack>`),
    doc("Components/Sidebar.dsx", `<stack><Badge/></stack>`),
    doc("Components/Badge.dsx", `<stack/>`),
    doc("Components/Orphan.dsx", `<stack/>`),
  ], [{ path: "/", component: "Home" }]);
  const reachable = (id: string): boolean => g.nodes.find((n) => n.id === id)!.reachable;
  assert.equal(reachable("Card"), true);
  assert.equal(reachable("Sidebar"), true);
  // Transitively: Home composes Sidebar composes Badge.
  assert.equal(reachable("Badge"), true);
  assert.equal(reachable("Orphan"), false, "the one real orphan is the only thing flagged");
  // Composition is NOT navigation and must never be drawn as an edge - a screen that contains
  // a card is not a screen that navigates to one.
  assert.equal(g.edges.length, 0, JSON.stringify(g.edges));
});

test("a built target does not also emit a phantom edge to its literal prefix", () => {
  const g = buildScreenGraph([
    doc("Components/Apps.dsx", `<stack><row on:tap="dsx.route.path = '/apps/' + item.id"/></stack>`),
    doc("Components/AppDetail.dsx", `<stack/>`),
  ], ROUTES);
  // `route.path = '/apps/' + id` is ONE navigation. Matching both the plain-literal and the
  // concatenation rule produced a second edge to `/apps/` and a phantom dangling report -
  // found by running this over the repo's own dashboard.
  assert.equal(g.edges.length, 1, JSON.stringify(g.edges));
  assert.deepEqual(g.dangling, []);
  assert.equal(g.edges[0]!.to, "AppDetail");
});

test("a link to a screen that does not exist is KEPT and reported, never silently dropped", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><row href="/checkout"/></stack>`),
  ], ROUTES);
  // Dropping it would hide exactly the bug this view should surface.
  assert.deepEqual(g.dangling, ["/checkout"]);
  const e = g.edges.find((x) => x.target === "/checkout");
  assert.ok(e !== undefined);
  assert.equal(e.to, null);
});

test("a link to the toolchain's own /edit route is not a dangling screen", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><row href="/edit"/><row href="/nowhere"/></stack>`),
  ], ROUTES);
  // The Studio door is real in the serving loop; only the genuinely unknown target reports.
  assert.deepEqual(g.dangling, ["/nowhere"]);
});

test("an unparseable document is still a node - a broken file must not vanish from the map", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><row href="/apps"/></stack>`),
    doc("Components/Broken.dsx", `<stack><text value="unclosed"`),
    doc("Components/Apps.dsx", `<stack/>`),
  ], ROUTES);
  assert.ok(g.nodes.some((n) => n.id === "Broken"), "a broken document disappeared");
});

// -- kinds ------------------------------------------------------------------------------

test("a surface's kind says how it is reached, and server and cli are surfaces too", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack/>`),
    doc("Components/Card.dsx", `<stack/>`),
    doc("api.server.dsx", `<server><route path="/x"/></server>`),
    doc("dsx.cli.dsx", `<cli/>`),
  ], ROUTES);
  const kind = (id: string): string => g.nodes.find((n) => n.id === id)!.kind;
  assert.equal(kind("Home"), "route");
  assert.equal(kind("Card"), "part");
  assert.equal(kind("api"), "server");
  assert.equal(kind("dsx"), "cli");
  assert.equal(g.nodes.find((n) => n.id === "Home")!.path, "/");
});

// -- determinism, which the layout downstream depends on ---------------------------------

test("the same project gives byte-identical output whatever order it arrives in", () => {
  const docs = [
    doc("Components/Home.dsx", `<stack><row href="/apps"/><row href="/settings"/></stack>`),
    doc("Components/Apps.dsx", `<stack><row href="/apps/1"/></stack>`),
    doc("Components/AppDetail.dsx", `<stack/>`),
    doc("Components/Settings.dsx", `<stack/>`),
  ];
  const forward = JSON.stringify(buildScreenGraph(docs, ROUTES));
  const backward = JSON.stringify(buildScreenGraph([...docs].reverse(), ROUTES));
  // A map that drifts between runs makes screenshots useless and diffs meaningless.
  assert.equal(forward, backward);
});

// -- the repo's own documents ------------------------------------------------------------

function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i += 1) {
    if (readdirSync(dir).includes("OpenSource")) return dir;
    dir = join(dir, "..");
  }
  throw new Error("repo root not found");
}

function collect(dir: string, base: string, out: GraphDocument[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { collect(full, `${base}${name}/`, out); continue; }
    if (name.endsWith(".dsx")) out.push({ file: `${base}${name}`, source: readFileSync(full, "utf8") });
  }
}

test("the extractor survives the repo's own shipped markup", (t) => {
  // The Studio's own documents ship in ClosedSource; an open drop skips LOUDLY
  // (the component-fold-conformance rule) - the fixture-driven tests above still run.
  if (!existsSync(join(repoRoot(), "ClosedSource"))) {
    t.skip("open drop without ClosedSource - the Studio markup ships closed");
    return;
  }
  const editor = join(repoRoot(), "ClosedSource/DSX/Modules/Custom/Editor/Components");
  const platform = join(repoRoot(), "ClosedSource/DSX/Modules/Custom/Platform/Components");
  const docs: GraphDocument[] = [];
  for (const dir of [editor, platform]) {
    try { collect(dir, "Components/", docs); } catch { /* module not present */ }
  }
  assert.ok(docs.length >= 4, `expected the Studio's own documents, found ${docs.length}`);

  const g = buildScreenGraph(docs, [
    { path: "/", component: "Apps" },
    { path: "/apps/:id", component: "AppDetail" },
  ]);
  assert.equal(g.nodes.length, docs.length, "every document is a node");
  assert.ok(g.nodes.every((n) => n.name.length > 0 && !/^\s*$/.test(n.name)));
  // A generated-looking name would mean the humaniser fell through to a path fragment.
  assert.ok(g.nodes.every((n) => !n.name.includes("/") && !n.name.includes(".dsx")));

  // The dashboard's own `openApp` action writes `dsx.route.path = '/apps/' + id` from an
  // `on:tap`. If the extractor cannot see THAT, it cannot see a real app.
  const apps = g.nodes.find((n) => n.id === "Apps");
  if (apps !== undefined) {
    const out = g.edges.filter((e) => e.from === "Apps" && e.to === "AppDetail");
    assert.equal(out.length, 1, `expected Apps -> AppDetail, got ${JSON.stringify(g.edges)}`);
    assert.equal(out[0]!.gesture, "TAP");
    assert.equal(out[0]!.kind, "replace");
  }
});

// ── ancestors: "how does anyone GET here" ─────────────────────────────────────────────
//
//  A transitive fact, derived once here because that is where it can be tested. The canvas
//  consumes it directly: a `<variable computed>` is branch-only by law, so a walk expressed
//  in markup would be a loop that silently does not run.

test("a surface lists every surface it is transitively reachable from", () => {
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><row href="/apps"/></stack>`),
    doc("Components/Apps.dsx", `<stack><row href="/apps/1"/></stack>`),
    doc("Components/AppDetail.dsx", `<stack/>`),
    doc("Components/Orphan.dsx", `<stack/>`),
  ], [
    { path: "/", component: "Home" },
    { path: "/apps", component: "Apps" },
    { path: "/apps/:id", component: "AppDetail" },
  ]);
  const at = (id: string) => g.nodes.find((n) => n.id === id)!;
  assert.deepEqual(at("Home").ancestors, []);
  assert.deepEqual(at("Apps").ancestors, ["Home"]);
  // TRANSITIVE, not one hop: the point of the trace is the whole path back to a start.
  assert.deepEqual(at("AppDetail").ancestors, ["Apps", "Home"]);
  assert.deepEqual(at("Orphan").ancestors, []);
});

test("a cycle terminates and both surfaces list each other", () => {
  const g = buildScreenGraph([
    doc("Components/A.dsx", `<stack><row href="/b"/></stack>`),
    doc("Components/B.dsx", `<stack><row href="/a"/></stack>`),
  ], [{ path: "/a", component: "A" }, { path: "/b", component: "B" }]);
  const at = (id: string) => g.nodes.find((n) => n.id === id)!;
  assert.deepEqual(at("A").ancestors, ["B"]);
  assert.deepEqual(at("B").ancestors, ["A"]);
});

test("composition reaches but does not navigate, so it is not an ancestor", () => {
  // A part embedded in a screen is why the part is not dead code; it is not a place you
  // were standing before you arrived, and listing it would invent a route.
  const g = buildScreenGraph([
    doc("Components/Home.dsx", `<stack><Card/></stack>`),
    doc("Components/Card.dsx", `<stack/>`),
  ], [{ path: "/", component: "Home" }]);
  const card = g.nodes.find((n) => n.id === "Card")!;
  assert.equal(card.reachable, true, "composition must still make it reachable");
  assert.deepEqual(card.ancestors, []);
});

test("a component that MENTIONS <server> in a comment is not a backend", () => {
  // A substring test over the source draws the Studio's own documents as backends, because
  // they explain in a comment why the inspector is hidden for one. The kind is the root
  // element, and a wrong kind on the map is exactly what this surface may never produce.
  const g = buildScreenGraph([
    doc("Components/Editor.dsx", `<!-- A <server> document has no element tree. -->\n<stack/>`),
    doc("Components/Api.dsx", `<server><route path="/x"/></server>`),
  ], [{ path: "/", component: "Editor" }]);
  assert.equal(g.nodes.find((n) => n.id === "Editor")!.kind, "route");
  assert.equal(g.nodes.find((n) => n.id === "Api")!.kind, "server");
});
