import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { DATA_CONTROL_LIMITS } from "../../dom/src/data-controls.ts";
import { renderToString } from "../src/render.ts";

function registry(component: ReturnType<typeof compileComponent>): Registry {
  return { components: { [`${component.scheme}.${component.name}`]: component }, globalPool: {}, css: "", schemes: [] };
}

test("SSR gives all structured data controls semantic, populated first paint", () => {
  const component = compileComponent("DataSSR", "t", `<vstack>
    <head>
      <variable as="rows">return [{ item: "Espresso", qty: 2 }, { item: "Tea", qty: 1 }]</variable>
      <variable as="day">return "2026-07-23"</variable>
      <variable as="marks">return [{ date: "2026-07-23", color: "destructive" }]</variable>
      <variable as="plans">return [{ id: "free", label: "Free" }, { id: "pro", label: "Pro" }]</variable>
      <variable as="plan">return "pro"</variable>
      <variable as="filters">return "Day,Month"</variable>
      <variable as="view">return "Grid"</variable>
      <variable as="busy">return true</variable>
    </head>
    <Table bind="rows" columns="Item,Qty" fields="item,qty" color="destructive"/>
    <calendar bind="day" min="2026-07-10" marks="marks"/>
    <RadioGroup bind="plan" optionsKey="plans"/>
    <segmentedButton bind="filters" options="Day,Week,Month"/>
    <segmentedButton bind="view" options="List,Grid" multiple="false"/>
    <refreshable busy="busy"><text value="Refresh child"/></refreshable>
  </vstack>`);
  const html = renderToString(registry(component), "t.DataSSR");

  assert.ok(!html.includes("dsx-unsupported"));
  assert.ok(html.includes('class="dsx-table" aria-rowcount="3" aria-colcount="2"'));
  assert.equal(html.split('<th scope="col">').length - 1, 2);
  assert.equal(html.split('<tr aria-label=').length - 1, 2);
  assert.ok(html.includes("--dsx-table-color: var(--dsx-destructive)"));
  assert.ok(html.includes('data-dsx-month="2026-07"'));
  assert.equal(html.split('class="dsx-calendar-day"').length - 1, 31);
  assert.ok(html.includes('data-dsx-date="2026-07-23"'));
  assert.ok(html.includes('data-dsx-selected="true" data-dsx-today='));
  assert.ok(html.includes('data-dsx-date="2026-07-09" data-dsx-intrinsic-disabled="true"'));
  assert.ok(html.includes('class="dsx-calendar-mark"'));
  assert.equal(html.split('class="dsx-radio-input"').length - 1, 2);
  assert.ok(/value="pro" checked/.test(html));
  assert.ok(html.includes('class="dsx-segmented-button" role="group"'));
  assert.ok(html.includes('role="radiogroup" data-dsx-multiple="false"'));
  assert.ok(html.includes('aria-checked="true" tabindex="0"'));
  assert.ok(html.includes('class="dsx-refreshable" aria-busy="true"'));
  assert.ok(html.includes("Refresh child"));
  assert.equal(renderToString(registry(component), "t.DataSSR"), html, "per-document IDs remain deterministic");
});

test("SSR caps hostile table allocation and declares truncation honestly", () => {
  const component = compileComponent("HostileTable", "t", `<Table bind="vars.rows" columns="Value" fields="value"/>`);
  const rows = Array.from({ length: DATA_CONTROL_LIMITS.tableRows + 25 }, (_, value) => ({ value }));
  const html = renderToString(registry(component), "t.HostileTable", { rows });
  assert.equal(html.split('<tr aria-label=').length - 1, DATA_CONTROL_LIMITS.tableRows);
  assert.ok(html.includes('data-dsx-truncated="true"'));
  assert.ok(html.length < 150_000);
});

test("authored capitalized components retain precedence over data-control global fallbacks", () => {
  const customTable = compileComponent("Table", "t", `<text value="Authored table"/>`);
  const host = compileComponent("Host", "t", `<Table/>`);
  const source: Registry = {
    components: { "t.Table": customTable, "t.Host": host }, globalPool: {}, css: "", schemes: [],
  };
  const html = renderToString(source, "t.Host");
  assert.ok(html.includes("Authored table"));
  assert.ok(!html.includes("dsx-table-frame"));
});
