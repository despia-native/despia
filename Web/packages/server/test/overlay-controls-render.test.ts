import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderToString } from "../src/render.ts";

test("SSR overlays emit semantic first-paint anatomy with deterministic document IDs", () => {
  const component = compileComponent("Overlays", "t", `<stack>
    <head>
      <variable as="sheetOpen">return true</variable>
      <variable as="alertOpen">return true</variable>
      <variable as="confirmOpen">return false</variable>
      <variable as="popoverOpen">return true</variable>
      <variable as="actions">return [{ label: "Delete", role: "destructive", action: "secret.erase", args: { token: "must-not-serialize" } }]</variable>
      <variable as="menuItems">return [{ title: "Edit" }, { title: "More", items: [{ title: "Duplicate" }] }]</variable>
    </head>
    <sheet class="authored-sheet" present="sheetOpen" mode="card" detents="content,full" inset="20" background="system" title="Settings" action="Save" actionIcon="star"><text value="Sheet body"/></sheet>
    <alert present="alertOpen" title="Saved" message="Your changes are safe" buttons="actions"/>
    <confirmDialog present="confirmOpen" title="Delete?" buttons="actions"/>
    <popover present="popoverOpen" arrow="bottom"><button label="Details"/><text slot="content" value="Popover body"/></popover>
    <menu menu="menuItems"><button label="Menu"/></menu>
    <contextmenu menu="menuItems"><button label="Context"/></contextmenu>
  </stack>`);
  const registry: Registry = { components: { "t.Overlays": component }, globalPool: {}, css: "", schemes: [] };
  const first = renderToString(registry, "t.Overlays");
  const second = renderToString(registry, "t.Overlays");

  assert.equal(first, second, "per-document overlay IDs reset for every render request");
  assert.ok(!first.includes("dsx-unsupported"));
  assert.ok(first.includes('class="dsx-overlay-host dsx-sheet-host authored-sheet"'));
  assert.ok(first.includes('class="dsx-overlay-panel dsx-sheet-panel" role="dialog" aria-modal="true"'));
  assert.ok(first.includes('id="dsx-sheet-title-1"'));
  assert.ok(first.includes('data-dsx-mode="card" data-dsx-detent="content" data-dsx-background="system" style="--dsx-sheet-inset: 20px"'));
  assert.ok(first.includes('data-dsx-background="system"'));
  assert.ok(first.includes('data-dsx-icon="star"'));
  assert.ok(first.includes('class="dsx-overlay-panel dsx-alert-panel" role="alertdialog" aria-modal="true"'));
  assert.ok(first.includes('data-dsx-role="destructive"'));
  assert.ok(first.includes('class="dsx-overlay-layer dsx-confirm-layer" role="presentation" hidden inert aria-hidden="true"'));
  assert.ok(first.includes('data-dsx-role="cancel"'), "confirmDialog appends its safe Cancel fallback");
  assert.ok(first.includes('class="dsx-floating-panel dsx-popover-panel" id="dsx-popover-panel-4" role="dialog" aria-modal="false"'));
  assert.ok(first.includes('class="dsx-floating-panel dsx-menu-panel" id="dsx-menu-panel-5" role="presentation"'));
  assert.ok(first.includes('class="dsx-menu-level" role="menu"'));
  assert.ok(first.includes('aria-haspopup="menu" aria-expanded="false"'));
  assert.ok(first.includes('class="dsx-menu-level dsx-submenu" role="menu" tabindex="-1" hidden inert'));
  assert.ok(!first.includes("secret.erase"), "action routes are client behaviour, not serialized markup");
  assert.ok(!first.includes("must-not-serialize"), "action arguments never leak into SSR HTML");
});

test("SSR closed presentations remain present for stable layout but inaccessible", () => {
  const component = compileComponent("Closed", "t", `<stack>
    <head><variable as="open">return false</variable></head>
    <sheet present="open"><text value="Hidden sheet"/></sheet>
    <popover present="open"><button label="Anchor"/><text slot="content" value="Hidden bubble"/></popover>
    <alert present="open" title="Hidden alert"/>
  </stack>`);
  const registry: Registry = { components: { "t.Closed": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Closed");
  assert.equal(html.split('hidden inert aria-hidden="true"').length - 1, 3);
  assert.ok(html.includes("Hidden sheet"));
  assert.ok(html.includes("Hidden bubble"));
  assert.ok(html.includes("Hidden alert"));
});
