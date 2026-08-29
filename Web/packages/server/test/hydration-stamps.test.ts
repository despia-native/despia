//
//  hydration-stamps.test.ts - the adopt-hydration stamp contract (W6 slice 1):
//  renderPage/renderToString({hydrate}) emit `data-dsx-n` — each element's IR node
//  identity (stampNodeIds preorder) — which the @despia-native/dom adopt walk verifies while
//  claiming server DOM. Off by default: bare renders and embed fragments must stay
//  byte-identical to v0 output (embeds replace-mount on upgrade, /web/13).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent, stampNodeIds, type IRNode } from "../../compiler/src/component.ts";
import { CssCollector, extractComponentCss } from "../../compiler/src/css.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderEmbedFragment, renderToString } from "../src/render.ts";
import { renderPage } from "../src/static.ts";

function mini(name: string, source: string, extra: { [qualified: string]: string } = {}): Registry {
  const components: Registry["components"] = {};
  const collector = new CssCollector();
  const first = compileComponent(name, "t", source);
  extractComponentCss(first, collector);
  components[`t.${name}`] = first;
  for (const [qualified, markup] of Object.entries(extra)) {
    const ir = compileComponent(qualified.substring(qualified.indexOf(".") + 1), qualified.substring(0, qualified.indexOf(".")), markup);
    extractComponentCss(ir, collector);
    components[qualified] = ir;
  }
  return { components, globalPool: {}, css: collector.emit(), schemes: [] };
}

test("stampNodeIds: preorder identity over the compiled tree, idempotent, serialization-stable", () => {
  const ir = compileComponent("Ids", "t", `<stack>
    <head><variable as="x">return 1</variable></head>
    <text value="a"/>
    <stack><text value="b"/></stack>
  </stack>`);
  stampNodeIds(ir.root as IRNode);
  const root = ir.root as IRNode;
  assert.equal(root.nid, 0);
  assert.equal((root.children[0] as IRNode).nid, 1);            // <text a> (head was stripped)
  assert.equal((root.children[1] as IRNode).nid, 2);            // inner <stack>
  assert.equal((root.children[1]!.children[0] as IRNode).nid, 3); // <text b>
  stampNodeIds(ir.root as IRNode); // idempotent
  assert.equal((root.children[1]!.children[0] as IRNode).nid, 3);
  // the browser receives the IR through registry.json — the same tree re-derives
  // the same identities after a JSON round trip
  const revived = JSON.parse(JSON.stringify(compileComponent("Ids", "t", `<stack>
    <head><variable as="x">return 1</variable></head>
    <text value="a"/>
    <stack><text value="b"/></stack>
  </stack>`))) as { root: IRNode };
  stampNodeIds(revived.root);
  assert.equal((revived.root.children[1]!.children[0] as IRNode).nid, 3);
});

test("hydrate off (the default) emits no stamps — v0 byte parity for bare renders and embeds", () => {
  const registry = mini("Plain", `<stack><text value="hello"/><button label="go"/></stack>`);
  const html = renderToString(registry, "t.Plain");
  assert.ok(!html.includes("data-dsx-n"), "bare renderToString must stay unstamped");
  const fragment = renderEmbedFragment(registry, "t.Plain", "t-plain", "");
  assert.ok(!fragment.includes("data-dsx-n"), "embed fragments replace-mount on upgrade (/web/13) and stay unstamped");
});

test("hydrate on stamps every emitted element with its IR node identity", () => {
  const registry = mini("Stamped", `<stack>
    <text value="hello"/>
    <stack><button label="go"/></stack>
  </stack>`);
  const html = renderToString(registry, "t.Stamped", {}, { hydrate: true });
  assert.ok(html.includes('data-dsx-owner="Stamped"'));
  assert.ok(html.includes('data-dsx-n="0"'), "the instance root carries nid 0");
  assert.ok(html.includes('data-dsx-n="1"'), "first child");
  assert.ok(html.includes('data-dsx-n="2"'), "inner stack");
  assert.ok(html.includes('data-dsx-n="3"'), "the button");
  // the inner label <span> is factory machinery, not an IR node — never stamped
  assert.match(html, /<button [^>]*data-dsx-n="3"[^>]*><span>go<\/span><\/button>/);
  // rendering twice is deterministic (the walk reads, never re-numbers)
  assert.equal(html, renderToString(registry, "t.Stamped", {}, { hydrate: true }));
});

test("hydrate stamps ride specialized hosts (bound lists) and skip suppressed branches", () => {
  const registry = mini("Hosts", `<stack>
    <head><variable as="rows">return [{ id: 'a' }]</variable></head>
    <list bind="rows"><text value="{{ item.id }}"/></list>
    <text visible-if="false" value="never"/>
    <text value="after"/>
  </stack>`);
  const html = renderToString(registry, "t.Hosts", {}, { hydrate: true });
  assert.match(html, /<div [^>]*data-dsx-n="1"[^>]*class="dsx-list"/, "the bound-list host carries the injected stamp");
  assert.ok(!html.includes("never"), "a false visible-if renders nothing");
  // the suppressed branch's identity (nid 3) is absent, the next sibling keeps its own
  assert.ok(!html.includes('data-dsx-n="3"'), "suppressed subtree emits no stamp");
  assert.ok(html.includes('data-dsx-n="4"'), "the sibling after it keeps its compile-order identity");
});

test("hydrate stamps cross component boundaries with per-component numbering", () => {
  const registry = mini("Outer", `<stack><t.Inner/><text value="tail"/></stack>`, {
    "t.Inner": `<stack><text value="inner"/></stack>`,
  });
  const html = renderToString(registry, "t.Outer", {}, { hydrate: true });
  // the child instance root: its own tree's nid 0 plus the owner stamp
  assert.match(html, /<div data-dsx-owner="Inner" data-dsx-n="0"|<div [^>]*data-dsx-owner="Inner"[^>]*data-dsx-n="0"/);
  assert.match(html, /Inner[\s\S]*data-dsx-n="1"[^>]*>inner</);
});

test("renderPage marks the host data-dsx-hydrate and stamps the body", () => {
  const registry = mini("Page", `<stack><text value="page body"/></stack>`);
  const page = renderPage(registry, "t.Page", {}, { title: "Page" });
  assert.ok(page.includes("data-dsx-hydrate"), "the client's adopt opt-in marker");
  assert.ok(page.includes('data-dsx-n="0"'));
  assert.ok(page.includes('data-dsx-n="1"'));
});
