import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderToString } from "../src/render.ts";

test("SSR application chrome has deterministic dialog and navigation semantics", () => {
  const component = compileComponent("Chrome", "t", `<stack>
    <head>
      <variable as="open">return false</variable>
      <variable as="selected">return 1</variable>
      <variable as="dark">return true</variable>
      <variable as="tint">return "destructive"</variable>
      <variable as="alpha">return 0.5</variable>
      <variable as="items">return [
        { id: "home", name: "Home", icon: "house", secret: "never-serialize" },
        { id: "search", name: "Search", icon: "magnifyingglass" },
        { id: "settings", name: "Settings", icon: "gear", disabled: true }
      ]</variable>
    </head>
    <Drawer class="authored-drawer" present="open" a11yLabel="Project drawer" a11yHint="Drawer hint" grow="width" theme="dark" opacity="{{ alpha }}"><button label="Close"/></Drawer>
    <Drawer><text value="Always open"/></Drawer>
    <MenuBar class="authored-menu" surface="regular" items="items" selected="0" dark="false" tint="'accent'" grow="height" theme="light" a11yHint="Menu hint"/>
    <MenuBar class="seeded-menu"/>
  </stack>`);
  const registry: Registry = { components: { "t.Chrome": component }, globalPool: {}, css: "", schemes: [] };
  const first = renderToString(registry, "t.Chrome");
  const second = renderToString(registry, "t.Chrome");

  assert.equal(first, second, "per-document IDs reset for each render");
  assert.ok(!first.includes("dsx-unsupported"));
  assert.ok(first.includes('class="dsx-application-control-host dsx-drawer-host authored-drawer"'));
  assert.match(first, /class="dsx-application-control-host dsx-drawer-host authored-drawer"[^>]*data-dsx-grow="width"[^>]*data-dsx-theme="dark"[^>]*aria-description="Drawer hint"[^>]*style="opacity: 0.5"/);
  assert.ok(first.includes('class="dsx-drawer-layer" role="presentation" hidden inert aria-hidden="true"'));
  assert.ok(first.includes('id="dsx-drawer-panel-1" role="dialog" aria-modal="true"'));
  assert.ok(first.includes('id="dsx-drawer-panel-2" role="dialog" aria-modal="true"'));
  assert.ok(first.includes('aria-label="Project drawer"'));
  assert.ok(first.includes('class="dsx-menu-bar authored-menu dsx-surface-regular"'));
  assert.match(first, /class="dsx-menu-bar authored-menu dsx-surface-regular"[^>]*data-dsx-grow="height"[^>]*data-dsx-theme="light"[^>]*aria-description="Menu hint"/);
  assert.ok(first.includes('role="menubar" aria-orientation="horizontal" aria-label="Primary navigation"'));
  assert.equal(first.split('role="menuitemradio"').length - 1, 6);
  assert.match(first, /class="dsx-menu-bar authored-menu dsx-surface-regular"[^>]*data-dsx-tone="light"[^>]*style="--dsx-menu-bar-tint: var\(--dsx-accent\)"/);
  assert.match(first, /class="dsx-menu-bar seeded-menu"[^>]*data-dsx-tone="dark"[^>]*style="--dsx-menu-bar-tint: var\(--dsx-destructive\)"/);
  assert.ok(first.includes('data-dsx-index="1" data-dsx-selected="true" tabindex="0"'));
  assert.ok(!first.includes('data-dsx-index="0" data-dsx-selected="true"'), "authored selected= cannot override surface state");
  assert.ok(first.includes('aria-disabled="true"'));
  assert.ok(!first.includes("never-serialize"), "event payload fields do not leak into HTML");
});

test("SSR attribute-less MenuBar follows top-level then vars seed precedence", () => {
  const component = compileComponent("Seeded", "t", `<MenuBar a11yLabel="Workspace"/>`);
  const registry: Registry = { components: { "t.Seeded": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Seeded", {
    items: [
      { id: "disabled", name: "Disabled", disabled: true },
      { id: "ready", name: "Ready" },
    ],
    selected: 0,
    dark: false,
    tint: "accent",
  });
  assert.match(html, /class="dsx-menu-bar"[^>]*data-dsx-tone="light"[^>]*style="--dsx-menu-bar-tint: var\(--dsx-accent\)"/);
  assert.ok(html.includes('role="menubar" aria-orientation="horizontal" aria-label="Workspace" aria-disabled="false" tabindex="-1"'));
  assert.ok(html.includes('data-dsx-index="1" data-dsx-selected="true" tabindex="0"'));
});

test("SSR all-disabled MenuBar exposes one focusable disabled group and no active item", () => {
  const component = compileComponent("Disabled", "t", `<MenuBar items="items" selected="0"/>`);
  const registry: Registry = { components: { "t.Disabled": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Disabled", {
    items: [{ name: "One", disabled: true }, { name: "Two", disabled: true }],
  });
  assert.ok(html.includes('aria-disabled="true" tabindex="0"><span class="dsx-menu-bar-pill" aria-hidden="true" hidden>'));
  assert.equal(html.split('data-dsx-selected="true"').length - 1, 0);
  assert.equal(html.split('tabindex="0"').length - 1, 1);
});

test("SSR empty MenuBar is retained for stable replacement but hidden accessibly", () => {
  const component = compileComponent("Empty", "t", `<MenuBar items="[]"/>`);
  const registry: Registry = { components: { "t.Empty": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Empty");
  assert.ok(html.includes('data-dsx-empty="true" hidden'));
  assert.equal(html.split('role="menuitemradio"').length - 1, 0);
});
