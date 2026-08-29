//
//  style-overrides-render.test.ts — the SSR half of the style-override plane: the
//  server splits `override:<name>` at the component reference, resolves through the
//  same core (Conformance/overrides), and first paint carries the resolved look —
//  a typed read in text, a deep element's bridged style, and the css-typed whole-list
//  door (`style="{{ dsx.override.extra }}"`) as a real inline style attribute.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { compileComponent } from "@despia/compiler/component";
import { CssCollector, extractComponentCss, buildRegistry } from "@despia/compiler";
import type { Registry } from "@despia/compiler/resolve";
import { renderToString } from "../src/render.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

function mini(components: { [name: string]: string }): Registry {
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: ["t"] };
  const collector = new CssCollector();
  for (const [name, source] of Object.entries(components)) {
    const ir = compileComponent(name, "t", source);
    extractComponentCss(ir, collector);
    registry.components[`t.${name}`] = ir;
  }
  return registry;
}

test("ssr: a literal override resolves typed and lands in first paint; defaults answer unset knobs", () => {
  const registry = mini({
    Probe: `<stack>
      <head>
        <override as="radius" type="length" default="12"/>
        <override as="label" type="text" default="stock"/>
      </head>
      <text value="r={{ dsx.override.radius }} l={{ dsx.override.label }}"/>
    </stack>`,
    Host: `<stack><Probe override:radius="6"/></stack>`,
  });
  const html = renderToString(registry, "t.Host");
  assert.ok(html.includes("r=6 l=stock"), html);
});

test("ssr: an invalid override degrades to its default on the server too", () => {
  const registry = mini({
    Probe: `<stack>
      <head><override as="surface" type="enum" options="raised cut" default="raised"/></head>
      <text value="s={{ dsx.override.surface }}"/>
    </stack>`,
    Host: `<stack><Probe override:surface="velvet"/></stack>`,
  });
  assert.ok(renderToString(registry, "t.Host").includes("s=raised"));
});

test("ssr: a deep element's bridged style carries the override value", () => {
  const registry = mini({
    Deep: `<stack>
      <head><override as="tint" type="color" default="accent"/></head>
      <stack><stack><text value="tinted" color="{{ dsx.override.tint }}"/></stack></stack>
    </stack>`,
    Host: `<stack><Deep override:tint="#FF0000"/></stack>`,
  });
  const html = renderToString(registry, "t.Host");
  assert.match(html, /style="[^"]*color: #FF0000/);
});

test("ssr: the shipped <Callout> spends its overrides at depth (the adoption proof)", (t) => {
  // The Foundation sources ship closed; an open drop skips LOUDLY, never silently green.
  const modules = join(repoRoot(), "ClosedSource/DSX/Modules");
  if (!existsSync(modules)) { t.skip("open drop without ClosedSource"); return; }
  const registry = buildRegistry([{ dir: join(modules, "Mandatory/Foundation"), scheme: "shared" }], [], {});
  const host = compileComponent("Host", "t", `<stack>
    <Callout title="Heads up" override:radius="6" override:barWidth="8"><text value="body"/></Callout>
    <Callout title="Stock"><text value="body"/></Callout>
  </stack>`);
  registry.components["t.Host"] = host;
  const html = renderToString(registry, "t.Host");
  // the overridden instance: panel radius 6 on the ROOT, bar width 8 + derived radius 4
  // on the DEEP accent-bar element; the stock instance keeps its declared defaults
  assert.match(html, /border-radius: 6px/);
  assert.match(html, /width: 8px/);
  assert.match(html, /border-radius: 4px/);
  assert.match(html, /border-radius: 10px/);
  assert.match(html, /width: 4px/);
});

test("ssr: the css-typed whole-list door emits a real inline style", () => {
  const registry = mini({
    Skin: `<stack>
      <head><override as="extra" type="css" default="opacity: 0.5"/></head>
      <stack class="skinned" style="{{ dsx.override.extra }}"><text value="x"/></stack>
    </stack>`,
    Host: `<stack><Skin override:extra="border-radius: 6px; opacity: 0.9"/></stack>`,
  });
  const html = renderToString(registry, "t.Host");
  assert.match(html, /style="[^"]*border-radius: 6px/);
  assert.match(html, /style="[^"]*opacity: 0.9/);
});
