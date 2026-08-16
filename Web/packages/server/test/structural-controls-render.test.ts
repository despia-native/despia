import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderToString } from "../src/render.ts";

test("SSR gives static structure controls the same semantic first-paint anatomy", () => {
  const component = compileComponent("Structures", "t", `<stack>
    <head><variable as="selected">return 1</variable></head>
    <flow spacing="6" lineSpacing="10"><text value="One"/><text value="Two"/></flow>
    <toolbar position="top"><button label="Cancel"/><button label="Done"/></toolbar>
    <list scroll="false"><text value="First"/><text value="Second"/></list>
    <grid><text value="A"/><text value="B"/></grid>
    <tabs value="selected">
      <vstack tabTitle="Home"><text value="Home pane"/></vstack>
      <vstack tabTitle="Inbox" tabBadge="3"><text value="Inbox pane"/></vstack>
    </tabs>
    <pager value="selected" dots="false"><text value="P1"/><text value="P2"/></pager>
    <carousel value="selected" peek="24"><text value="C1"/><text value="C2"/></carousel>
  </stack>`);
  const registry: Registry = { components: { "t.Structures": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Structures");

  assert.ok(!html.includes("dsx-unsupported"));
  assert.ok(html.includes("--dsx-flow-line-spacing: 10px"));
  assert.ok(html.includes('role="toolbar"'));
  assert.ok(html.includes('data-dsx-position="top"'));
  assert.ok(html.includes('class="dsx-row dsx-collection-row" role="listitem"'));
  assert.ok(html.includes('role="grid"'));
  assert.ok(html.includes('aria-colcount="3"'));
  assert.ok(html.includes('class="dsx-tablist" role="tablist"'));
  assert.ok(html.includes('aria-selected="true" data-dsx-selected="true" tabindex="0"'));
  assert.ok(html.includes('class="dsx-paged dsx-pager"'));
  assert.ok(html.includes('class="dsx-paged-dots" dir="ltr" role="group" aria-label="Choose slide" hidden'));
  assert.ok(html.includes('class="dsx-paged dsx-carousel"'));
  assert.ok(html.includes('data-dsx-peek="true"'));
  assert.ok(html.includes('aria-roledescription="slide"'));
});

test("SSR bound grids share the corrected three-column default and grid semantics", () => {
  const component = compileComponent("BoundGrid", "t", `<stack>
    <head><variable as="rows">return [{ id: 1 }, { id: 2 }]</variable></head>
    <grid bind="rows" key="id"><text value="{{ item.id }}"/></grid>
  </stack>`);
  const registry: Registry = { components: { "t.BoundGrid": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.BoundGrid");
  assert.ok(html.includes('role="grid" aria-colcount="3" aria-rowcount="1"'));
  assert.ok(!html.includes("--dsx-grid-columns"), "weak CSS owns the default column presentation");
  assert.ok(html.includes('class="dsx-grid-aria-row" role="row"'));
  assert.ok(html.includes('data-dsx-total-count="2" data-dsx-rendered-count="2" data-dsx-truncated="false"'));
  assert.equal(html.split('role="gridcell"').length - 1, 2);
});

test("SSR bound pagers use pager anatomy, bound item scope, selection and a finite page cap", () => {
  const rows = Array.from({ length: 1_005 }, (_, id) => ({ id, title: `Page ${id}` }));
  const component = compileComponent("BoundPager", "t", `<pager bind="rows" key="id" value="selected" class="authored-pager">
    <head>
      <variable as="rows">return ${JSON.stringify(rows)}</variable>
      <variable as="selected">return 2</variable>
    </head>
    <text value="{{ item.title }}"/>
  </pager>`);
  const registry: Registry = { components: { "t.BoundPager": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.BoundPager");
  assert.ok(html.includes('class="dsx-paged dsx-pager authored-pager"'));
  assert.ok(html.includes('aria-roledescription="carousel"'));
  assert.ok(html.includes('data-dsx-page="2"'));
  assert.ok(html.includes('Page 0'));
  assert.ok(html.includes('Page 999'));
  assert.ok(!html.includes('Page 1000'));
  assert.ok(html.includes('data-dsx-total-count="1005"'));
  assert.ok(html.includes('data-dsx-rendered-count="1000"'));
  assert.ok(html.includes('data-dsx-truncated="true"'));
  assert.ok(html.includes('class="dsx-paged-viewport" dir="ltr"'));
  assert.equal(html.split('aria-roledescription="slide"').length - 1, 1_000);
  assert.equal(html.split('class="dsx-paged-dot"').length - 1, 1_000);
});

test("SSR bound rows do not eagerly enumerate cyclic/hostile row objects", () => {
  const component = compileComponent("HostileBound", "t", `<list bind="vars.rows" key="id">
    <head><expects variable="vars"/></head><text value="{{ item.label }}"/>
  </list>`);
  const registry: Registry = { components: { "t.HostileBound": component }, globalPool: {}, css: "", schemes: [] };
  const raw: Record<string, unknown> = { id: "cycle", label: "Safe" };
  raw["self"] = raw;
  const hostile = new Proxy(raw, { ownKeys: () => { throw new Error("SSR eagerly enumerated a row"); } });
  const html = renderToString(registry, "t.HostileBound", { rows: [hostile] });
  assert.ok(html.includes(">Safe</span>"));
});

// ── the L-01 list constructs, SSR twin: the server paints the SAME first frame the
//    DOM reconciler builds (a bound collection is an adopt REBUILD, so a divergent
//    server shape would be a visible swap on hydrate).

test("SSR sections a group_by list in first-seen order with the same anatomy as the DOM", () => {
  const component = compileComponent("Grouped", "t", `<list bind="rows" key="id" group_by="cat">
    <head><variable as="rows">return [
      { id: 'a', cat: 'Fruit' }, { id: 'b', cat: 'Veg' }, { id: 'c', cat: 'Fruit' }
    ]</variable></head>
    <text value="{{ item.id }}"/>
  </list>`);
  const registry: Registry = { components: { "t.Grouped": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Grouped");
  assert.ok(html.includes('data-dsx-grouped="true"'));
  assert.equal(html.split('class="dsx-list-section"').length - 1, 2, "one section per first-seen group");
  assert.ok(html.indexOf('aria-label="Fruit"') < html.indexOf('aria-label="Veg"'), "first-seen group order");
  assert.ok(html.includes('<div class="dsx-list-section-header" data-dsx-part="section-header" aria-hidden="true">Fruit</div>'));
  const fruit = html.substring(html.indexOf('aria-label="Fruit"'), html.indexOf('aria-label="Veg"'));
  assert.equal(fruit.split('role="listitem"').length - 1, 2, "first-seen row order inside the section");
});

test("SSR paints the swipe rails and the reorder handle the client wires, never a different row", () => {
  const component = compileComponent("Constructs", "t", `<list bind="rows" key="id" swipeTrailing="actions" reorder="false" on:delete="noop = 1">
    <head>
      <variable as="rows">return [{ id: 'a', label: 'Alpha' }]</variable>
      <variable as="actions">return [{ label: 'Delete', icon: 'trash', role: 'destructive', event: 'delete' }]</variable>
      <variable as="noop">return 0</variable>
    </head>
    <text value="{{ item.label }}"/>
  </list>`);
  const registry: Registry = { components: { "t.Constructs": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Constructs");
  assert.ok(html.includes('data-dsx-swipeable="true"'));
  assert.ok(html.includes('data-dsx-reorder="false"'));
  assert.ok(html.includes('class="dsx-row dsx-collection-row dsx-row-constructs"'));
  assert.ok(html.includes('<div class="dsx-list-row" data-dsx-part="row-host" data-dsx-swipe="closed">'));
  assert.ok(html.includes('class="dsx-list-actions dsx-list-actions-trailing" data-dsx-part="actions-trailing"'));
  assert.ok(html.includes('data-dsx-role="destructive"'));
  assert.ok(html.includes('data-dsx-icon="trash"'));
  assert.ok(html.includes('<span class="dsx-list-action-label">Delete</span>'));
  // reorder="false" paints the handle hidden — the same element the client un-hides
  assert.ok(html.includes('class="dsx-list-reorder" type="button" data-dsx-part="reorder" aria-label="Reorder" title="Reorder" hidden'));
});

test("SSR stands the constructs down under scroll=\"false\" and a horizontal axis", () => {
  const component = compileComponent("FitContent", "t", `<list bind="rows" key="id" group_by="cat" scroll="false">
    <head><variable as="rows">return [{ id: 'a', cat: 'Fruit' }]</variable></head>
    <text value="{{ item.id }}"/>
  </list>`);
  const registry: Registry = { components: { "t.FitContent": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.FitContent");
  assert.ok(html.includes('data-dsx-grouped="false"'));
  assert.ok(!html.includes("dsx-list-section"));
});

test("SSR marks an autoscroll rail as not yet running — the marquee is a client rAF loop", () => {
  const component = compileComponent("Marquee", "t", `<list bind="rows" key="id" axis="horizontal" autoscroll="40">
    <head><variable as="rows">return [{ id: 'a' }, { id: 'b' }]</variable></head>
    <text value="{{ item.id }}"/>
  </list>`);
  const registry: Registry = { components: { "t.Marquee": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Marquee");
  assert.ok(html.includes('data-dsx-autoscroll="false"'));
  assert.equal(html.split('role="listitem"').length - 1, 2);
});
