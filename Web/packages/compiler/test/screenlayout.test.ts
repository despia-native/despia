//
//  screenlayout.test.ts - the map must land in the same place every time.
//
//  Determinism is not a nice property here, it is the whole contract: a layout that drifts
//  between runs makes screenshots useless, diffs meaningless, and "why did that node move"
//  unanswerable. So the first and last cases pin stability, and the ones between pin the
//  five passes doing what 02-canvas.md says they do.
//

import test from "node:test";
import assert from "node:assert/strict";

import { buildScreenGraph, type GraphDocument, type GraphRoute } from "../src/screengraph.ts";
import { layoutScreenGraph, edgeGeometry, edgeMidpoint, edgePath, COLUMN_PITCH, NODE_SIZE } from "../src/screenlayout.ts";

const ROUTES: GraphRoute[] = [
  { path: "/", component: "Home" },
  { path: "/apps", component: "Apps" },
  { path: "/apps/:id", component: "AppDetail" },
  { path: "/settings", component: "Settings" },
];

function doc(file: string, source: string): GraphDocument { return { file, source }; }

/** Home links to Apps and Settings; Apps links on to AppDetail. Three ranks. */
function chain(): GraphDocument[] {
  return [
    doc("Components/Home.dsx", `<stack><row href="/apps"/><row href="/settings"/></stack>`),
    doc("Components/Apps.dsx", `<stack><row href="/apps/1"/></stack>`),
    doc("Components/AppDetail.dsx", `<stack/>`),
    doc("Components/Settings.dsx", `<stack/>`),
  ];
}

const at = (l: ReturnType<typeof layoutScreenGraph>, id: string) => l.nodes.find((n) => n.id === id)!;

test("an empty project lays out to nothing rather than throwing", () => {
  const l = layoutScreenGraph({ nodes: [], edges: [], dangling: [], entry: null });
  assert.deepEqual(l.nodes, []);
  assert.equal(l.width, 0);
  assert.equal(l.height, 0);
});

test("reordering the input changes no coordinate", () => {
  const docs = chain();
  const a = layoutScreenGraph(buildScreenGraph(docs, ROUTES));
  const b = layoutScreenGraph(buildScreenGraph([...docs].reverse(), ROUTES));
  // Byte-identical, not merely equivalent. This is the property the whole file exists for.
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("running it twice on the same graph is byte-identical", () => {
  const g = buildScreenGraph(chain(), ROUTES);
  assert.equal(JSON.stringify(layoutScreenGraph(g)), JSON.stringify(layoutScreenGraph(g)));
});

test("rank is the LONGEST path from a root, so edges point downward", () => {
  const l = layoutScreenGraph(buildScreenGraph(chain(), ROUTES));
  assert.equal(at(l, "Home").rank, 0);
  // Apps and Settings are both routed, so both are also roots - but Apps is navigated to
  // from Home, and the longest path wins, which is what stops an edge doubling back.
  assert.ok(at(l, "Apps").rank >= 1, `Apps at rank ${at(l, "Apps").rank}`);
  assert.ok(at(l, "AppDetail").rank > at(l, "Apps").rank, "a child must rank below its parent");
  assert.ok(at(l, "AppDetail").y > at(l, "Apps").y, "and must be placed below it");
});

test("a screen reachable both early and late sits at its DEEPEST position", () => {
  // Home -> A -> B, and Home -> B directly. B belongs under A, not beside it.
  const l = layoutScreenGraph(buildScreenGraph([
    doc("Components/Home.dsx", `<stack><row href="/a"/><row href="/b"/></stack>`),
    doc("Components/A.dsx", `<stack><row href="/b"/></stack>`),
    doc("Components/B.dsx", `<stack/>`),
  ], [{ path: "/", component: "Home" }, { path: "/a", component: "A" }, { path: "/b", component: "B" }]));
  assert.ok(at(l, "B").rank > at(l, "A").rank, `B ${at(l, "B").rank} vs A ${at(l, "A").rank}`);
});

test("a cycle terminates and does not fold the map flat", () => {
  // A pushes B, B pops back to A. Normal in an app, and the back edge must not rank A
  // beneath its own child.
  const l = layoutScreenGraph(buildScreenGraph([
    doc("Components/A.dsx", `<stack><row href="/b"/></stack>`),
    doc("Components/B.dsx", `<stack><button on:tap="dsx.module.route.popTo({ path: '/a' })"/></stack>`),
  ], [{ path: "/a", component: "A" }, { path: "/b", component: "B" }]));
  assert.equal(at(l, "A").rank, 0);
  assert.equal(at(l, "B").rank, 1);
});

test("a graph that is nothing but a cycle still lays out", () => {
  const l = layoutScreenGraph(buildScreenGraph([
    doc("Components/A.dsx", `<stack><row href="/b"/></stack>`),
    doc("Components/B.dsx", `<stack><row href="/a"/></stack>`),
  ], [{ path: "/a", component: "A" }, { path: "/b", component: "B" }]));
  assert.equal(l.nodes.length, 2);
  assert.ok(l.height > 0);
});

test("server and cli surfaces sit in their own bands beneath the screens", () => {
  const l = layoutScreenGraph(buildScreenGraph([
    doc("Components/Home.dsx", `<stack/>`),
    doc("api.server.dsx", `<server><route path="/x"/></server>`),
    doc("tool.cli.dsx", `<cli/>`),
  ], [{ path: "/", component: "Home" }]));
  // The phone map stays a phone map, and a call edge crosses one visible boundary.
  assert.equal(at(l, "Home").band, "screen");
  assert.equal(at(l, "api").band, "server");
  assert.equal(at(l, "tool").band, "cli");
  assert.ok(at(l, "api").y > at(l, "Home").y, "the server band is below the screens");
  assert.ok(at(l, "tool").y > at(l, "api").y, "the cli band is below the server band");
  // They are short, because there is nothing to render.
  assert.equal(at(l, "api").height, NODE_SIZE.server.height);
  assert.ok(at(l, "api").height < at(l, "Home").height);
});

test("an unreachable surface is placed in a band of its own, never dropped", () => {
  const l = layoutScreenGraph(buildScreenGraph([
    doc("Components/Home.dsx", `<stack/>`),
    doc("Components/Orphan.dsx", `<stack/>`),
  ], [{ path: "/", component: "Home" }]));
  const orphan = at(l, "Orphan");
  assert.ok(orphan !== undefined, "an unreachable node vanished from the layout");
  assert.ok(orphan.rank > at(l, "Home").rank, "it sits below everything reachable");
  assert.equal(orphan.reachable, false);
});

test("siblings share a row and are spaced by the column pitch", () => {
  const l = layoutScreenGraph(buildScreenGraph(chain(), ROUTES));
  const apps = at(l, "Apps");
  const settings = at(l, "Settings");
  if (apps.rank === settings.rank) {
    assert.equal(apps.y, settings.y, "same rank means same row");
    assert.equal(Math.abs(apps.x - settings.x), COLUMN_PITCH);
  }
  // Nothing overlaps, whatever the ranks worked out to.
  for (const a of l.nodes) {
    for (const b of l.nodes) {
      if (a.id >= b.id) continue;
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
});

test("the extent covers every node, so a fit-to-content actually fits", () => {
  const l = layoutScreenGraph(buildScreenGraph(chain(), ROUTES));
  for (const n of l.nodes) {
    assert.ok(n.x + n.width <= l.width, `${n.id} runs past the right edge`);
    assert.ok(n.y + n.height <= l.height, `${n.id} runs past the bottom edge`);
  }
});

test("an edge leaves the bottom anchor and arrives at the top one", () => {
  const l = layoutScreenGraph(buildScreenGraph(chain(), ROUTES));
  const from = at(l, "Apps");
  const to = at(l, "AppDetail");
  const d = edgePath(from, to);
  // Perpendicular departure and arrival is what makes the map read as a flow, not a web.
  assert.ok(d.startsWith(`M ${from.x + from.width / 2} ${from.y + from.height} C `), d);
  assert.ok(d.endsWith(`${to.x + to.width / 2} ${to.y}`), d);
});

test("the geometry and the path string are the same curve", () => {
  const l = layoutScreenGraph(buildScreenGraph(chain(), ROUTES));
  const g = edgeGeometry(at(l, "Apps"), at(l, "AppDetail"));
  assert.equal(edgePath(at(l, "Apps"), at(l, "AppDetail")), `M ${g[0]} ${g[1]} C ${g[2]} ${g[3]}, ${g[4]} ${g[5]}, ${g[6]} ${g[7]}`);
  // The midpoint is on the curve, between the endpoints - a pill outside the span would sit
  // over a node instead of over its own edge.
  const mid = edgeMidpoint(g);
  assert.ok(mid.y > g[1] && mid.y < g[7], `midpoint ${mid.y} outside ${g[1]}..${g[7]}`);
});

test("a CYCLIC app does not lay out as one column", () => {
  // The shape every real app has: a funnel that returns to its start. Relaxing longest paths
  // over a cycle raises each node one rank per lap until every node has a rank of its own, and
  // the map becomes a column N screens tall that fit-to-content zooms to nothing. Measured on
  // an eight-screen storefront, which drew one 3500px column before the cycle break.
  const paths = ["/", "/catalog", "/product", "/cart", "/checkout", "/orders", "/account"];
  const names = ["Home", "Catalog", "Product", "Cart", "Checkout", "Orders", "Account"];
  const routes = paths.map((path, i) => ({ path, component: names[i]! }));
  const docs = [
    doc("Components/Home.dsx", `<stack><row href="/catalog"/><row href="/orders"/><row href="/account"/></stack>`),
    doc("Components/Catalog.dsx", `<stack><row href="/product"/><row href="/cart"/></stack>`),
    doc("Components/Product.dsx", `<stack><row href="/cart"/></stack>`),
    doc("Components/Cart.dsx", `<stack><row href="/checkout"/></stack>`),
    doc("Components/Checkout.dsx", `<stack><row href="/orders"/></stack>`),
    doc("Components/Orders.dsx", `<stack><row href="/"/></stack>`),      // the cycle
    doc("Components/Account.dsx", `<stack/>`),
  ];
  const l = layoutScreenGraph(buildScreenGraph(docs, routes, "Home"));
  const at = (id: string) => l.nodes.find((n) => n.id === id)!;

  // ONE RANK PER LAP is the bug: seven screens must not occupy seven ranks when the longest
  // acyclic path through them is six.
  const ranks = new Set(l.nodes.map((n) => n.rank)).size;
  assert.ok(ranks <= 6, `seven screens landed in ${ranks} ranks`);

  // THE ENTRY IS THE TOP. Every routed screen is a root, so without the root plan's entry the
  // order the roots are visited in decides what ends up first - and a storefront opened with
  // `Cart` at the top and `Home` three rows down.
  assert.equal(at("Home").rank, 0, "the app's declared entry is not at the top");
  assert.ok(at("Checkout").rank > at("Cart").rank, "the funnel does not read in order");
  assert.ok(at("Cart").rank > at("Catalog").rank, "the funnel does not read in order");

  // Screens that branch off the entry share its next rank rather than stacking.
  assert.equal(at("Account").rank, at("Catalog").rank);
  assert.notEqual(at("Account").x, at("Catalog").x);

  // The cycle edge is still DRAWN, and still counts: excluded from ranking is not excluded
  // from the map.
  assert.ok(l.nodes.every((n) => n.reachable), "every screen is reachable in a cycle");
  assert.equal(at("Orders").rank > 0, true);
});
