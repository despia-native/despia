//
//  render.test.ts - @despia/server v0 against the REAL Demo sources: the string renderer
//  resolves components/slots/lists/interpolations exactly like the DOM leg; pages emit
//  title/meta; redirects emit meta-refresh; the exporter writes static routes.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ModuleRegistry, JSE } from "@despia/kernel";
import { buildRegistry } from "../../compiler/src/registry.ts";
import { compileComponent, type IRNode } from "../../compiler/src/component.ts";
import { CssCollector, extractComponentCss } from "../../compiler/src/css.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderEmbedFragment, renderToString } from "../src/render.ts";
import { createPageHandler } from "../src/live.ts";
import {
  renderPage,
  renderRedirect,
  exportStatic,
  assertSafeRedirectTarget,
  assertSafeRouteTable,
  resolveRouteOutput,
} from "../src/static.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const modules = join(repoRoot(), "ClosedSource/DSX/Modules");

// The suite's shared registry compiles the REAL closed Demo/Foundation sources. An
// open drop skips the tests that use it LOUDLY (the component-fold-conformance rule);
// every mini-registry test here runs anywhere.
const hasClosedSource = existsSync(join(repoRoot(), "ClosedSource"));
function skipWithoutClosedSource(t: { skip(msg: string): void }): boolean {
  if (hasClosedSource) return false;
  t.skip("open drop without ClosedSource - the Demo/Foundation sources ship closed");
  return true;
}
const registry = !hasClosedSource ? (null as unknown as Registry) : buildRegistry(
  [
    { dir: join(modules, "Custom/Demo") },
    { dir: join(modules, "Mandatory/Foundation"), scheme: "shared" },
  ],
  [],
  {
    routes: [
      { path: "/", component: "demo.Launcher", meta: { title: "DSX demo", description: "walk every capability" } },
      { path: "/home", redirect: "/" },
      { path: "/flex", component: "demo.Flex", meta: { title: "Flex layout" } },
      { path: "/docs/getting-started", component: "demo.Flex", meta: { title: "Nested route" } },
      { path: "/orders/:id", component: "demo.Basics" },
    ],
  },
);

test("ssr: Flex renders with interpolations, owner stamp, sheet classes", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const html = renderToString(registry, "demo.Flex");
  assert.ok(html.includes('data-dsx-owner="Flex"'));
  assert.ok(html.includes("Flip flex-direction (row)")); // {{ dsx.variable.dir }} evaluated
  assert.ok(html.includes('class="dsx-text chip"') || html.includes("chip")); // sidecar classes are literal
  assert.ok(html.includes("dsx-hstack")); // static row axes stamped
});

test("ssr: Launcher renders its 25 rows from the computed variable", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const html = renderToString(registry, "demo.Launcher", {});
  const rows = html.split('class="dsx-pressable launcher-row"').length - 1;
  assert.equal(rows, 25);   // 25th: the Analytics dashboard (the complex-dashboard proof)
  assert.ok(html.includes("Component catalog"));
  assert.ok(html.includes("Errors &amp; logs")); // the diagnostics-spine page is listed
  assert.ok(html.includes(">Setup<")); // omitted availability fails closed
});

test("ssr: Foundation chips expose selected state without relying on color", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const html = renderToString(registry, "demo.Gallery");
  assert.match(html, /class="dsx-pressable dsx-chip"[^>]*aria-pressed="true"/);
  assert.match(html, /class="dsx-pressable dsx-chip"[^>]*aria-pressed="false"/);
});

test("ssr: rich web primitives keep semantic, non-placeholder first paint", () => {
  const ir = compileComponent("Rich", "t", `<stack>
    <searchbar placeholder="Search"/>
    <segmented options="One,Two"/>
    <stars a11yLabel="Customer rating"/>
    <chart/><map/><qrcode value="hello"/>
    <WebView src="about:blank" ephemeral="true"/>
  </stack>`);
  const mini: Registry = { components: { "t.Rich": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Rich");
  assert.ok(!html.includes("dsx-unsupported"));
  for (const className of ["dsx-searchbar", "dsx-segmented", "dsx-stars", "dsx-chart", "dsx-map", "dsx-qrcode", "dsx-webview"]) {
    assert.ok(html.includes(className), `${className} has an SSR twin`);
  }
  // the exact DOM-factory token set (elements.ts webView) — SSR/client sandbox parity
  assert.ok(html.includes('sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"'));
  assert.ok(html.includes(" credentialless"));
  assert.ok(html.includes('aria-label="Customer rating: 0 of 5 stars"'));
  assert.ok(!html.includes("aria-valuetext"));
});

test("ssr: Foundation form/field paint as labeled semantic controls with inherited state", () => {
  const ir = compileComponent("Form", "t", `<stack>
    <head><variable as="account">return { values: { email: 'bad', password: '' }, submitted: true }</variable></head>
    <form as="account" submit="Continue" spacing="16">
      <field name="email" type="email" label="Email" placeholder="you@example.com" validate="required,email"/>
      <field name="password" type="secure" label="Password" validate="required,minLength:8"/>
      <field name="plan" type="picker" label="Plan" options="Free,Pro" validate="required"/>
      <field name="terms" type="toggle" label="Accept terms" validate="required"/>
    </form>
  </stack>`);
  const mini: Registry = { components: { "t.Form": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Form");
  assert.ok(html.includes('<form class="dsx-form"'));
  assert.ok(html.includes('data-dsx-form="account"'));
  assert.ok(html.includes("--dsx-form-spacing: 16px"));
  assert.ok(html.includes('type="email"'));
  assert.ok(html.includes('type="password"'));
  assert.ok(html.includes('<select class="dsx-field-control dsx-field-select"'));
  assert.ok(html.includes('type="checkbox" role="switch"'));
  assert.ok(html.includes('aria-errormessage='), "submitted invalid fields expose their messages");
  assert.ok(html.includes("Enter a valid email"));
  assert.ok(html.includes('data-dsx-valid="false"'));
  assert.ok(html.includes('class="dsx-button dsx-form-submit" data-dsx-valid="false"'));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "field/error IDs stay unique");
  for (const target of [...html.matchAll(/<label[^>]+for="([^"]+)"/g)].map((match) => match[1])) {
    assert.ok(ids.includes(target), `label target ${target} exists`);
  }
});

test("ssr: a multiline field paints a real three-row textarea in the same well (wave-7 F5)", () => {
  const ir = compileComponent("Prose", "t", `<stack>
    <head><variable as="editor">return { values: { body: 'line one' } }</variable></head>
    <form as="editor">
      <field name="body" label="Note" multiline="true" placeholder="Write it down"/>
      <field name="title" label="Title"/>
    </form>
  </stack>`);
  const mini: Registry = { components: { "t.Prose": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Prose");
  assert.match(html, /<textarea class="dsx-field-control dsx-field-multiline" rows="3" [^>]*name="body"[^>]*placeholder="Write it down"[^>]*>line one<\/textarea>/);
  assert.match(html, /<input class="dsx-field-control" type="text" [^>]*name="title"/, "a plain field stays a single-line input");
});

test("ssr: a prefilled valid form reports valid and keeps errors hidden", () => {
  const ir = compileComponent("ValidForm", "t", `<form as="login" submit="Sign in">
    <head><variable as="login">return { values: { email: 'person@example.com', password: '12345678' } }</variable></head>
    <field name="email" type="email" label="Email" validate="required,email"/>
    <field name="password" type="secure" label="Password" validate="required,minLength:8"/>
  </form>`);
  const mini: Registry = { components: { "t.ValidForm": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.ValidForm");
  assert.ok(html.includes('data-dsx-valid="true"'));
  assert.ok(html.includes('class="dsx-button dsx-form-submit" data-dsx-valid="true"'));
  assert.ok(!html.includes("--dsx-form-spacing"), "absent spacing uses the weak author-overridable CSS default");
  assert.ok(!html.includes("aria-errormessage="));
});

test("ssr: explicit false form booleans stay false", () => {
  const ir = compileComponent("FalseFormFlags", "t", `<form as="plain" scroll="false">
    <field name="name" type="text" secure="false" label="Name"/>
  </form>`);
  const mini: Registry = { components: { "t.FalseFormFlags": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.FalseFormFlags");
  assert.ok(!html.includes("dsx-form-scroll"));
  assert.ok(html.includes('type="text"'));
  assert.ok(!html.includes('type="password"'));
});

test("ssr: adaptive scaffold uses the cross-runtime default pane labels", () => {
  const ir = compileComponent("Adaptive", "t", `<scaffold shell="automatic">
    <text pane="sidebar" value="Library"/>
    <text pane="content" value="Now Playing"/>
    <text pane="inspector" value="Details"/>
  </scaffold>`);
  const mini: Registry = { components: { "t.Adaptive": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Adaptive");
  assert.ok(html.includes('aria-label="Sidebar"'));
  assert.ok(html.includes('aria-label="Content"'));
  assert.ok(html.includes('aria-label="Inspector"'));
});

test("ssr: adaptive scaffold resolves interpolated policy, sizing, labels, and pane markers", () => {
  const ir = compileComponent("AdaptiveBound", "t", `<scaffold
      shell="{{ vars.shell }}" collapse="{{ vars.collapse }}"
      compactAt="{{ vars.breakpoint }}" sidebarMin="{{ vars.sidebarMin }}"
      sidebarLabel="{{ vars.sidebarLabel }}">
    <text pane="{{ vars.sidebarPane }}" value="Library"/>
    <text pane="content" value="Now Playing"/>
    <text pane="inspector" value="Details"/>
  </scaffold>`);
  const mini: Registry = { components: { "t.AdaptiveBound": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.AdaptiveBound", {
    shell: "automatic", collapse: "none", breakpoint: 880,
    sidebarMin: 260, sidebarLabel: "Library navigation", sidebarPane: "sidebar",
  });
  assert.ok(html.includes('data-dsx-layout="split3"'));
  assert.ok(html.includes('data-dsx-mode="automatic"'));
  assert.ok(html.includes('data-dsx-collapse="none"'));
  assert.ok(html.includes('--dsx-shell-compact-at: 880px'));
  assert.ok(html.includes('--dsx-sidebar-min: 260px'));
  assert.ok(html.includes('aria-label="Library navigation"'));
  assert.ok(!html.includes("{{"), "the first paint never leaks template expressions");
});

test("ssr: hostile star counts stay finite and bounded", () => {
  const ir = compileComponent("Stars", "t", `<stars count="1e309" a11yLabel="Rating"/>`);
  const mini: Registry = { components: { "t.Stars": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Stars");
  assert.ok(html.includes('aria-label="Rating: 0 of 5 stars"'));
  assert.ok(html.length < 2_000);
});

test("ssr: segmented optionsKey preserves typed object values like the client", () => {
  const ir = compileComponent("Segments", "t", `<stack>
    <head>
      <variable as="choices">return [{ id: 10, title: 'Ten' }, { id: false, title: 'Off' }]</variable>
      <variable as="selected">return false</variable>
    </head>
    <segmented bind="dsx.variable.selected" optionsKey="dsx.variable.choices" valueField="id" labelField="title"/>
  </stack>`);
  const mini: Registry = { components: { "t.Segments": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Segments");
  assert.ok(html.includes('aria-checked="false" tabindex="-1">Ten</button>'));
  assert.ok(html.includes('aria-checked="true" tabindex="0">Off</button>'));
});

test("ssr: components + slots resolve (NavBar inside Flex, caller scope)", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const html = renderToString(registry, "demo.Flex");
  // NavBar defaults to the SYSTEM bar → its custom bar is visible-if'd OUT of the html
  assert.ok(html.includes('data-dsx-owner="Flex"'));
  assert.ok(!html.includes("dsx-unsupported"), "no unresolved elements in the Flex page");
});

test("ssr: composed invocation class and generated styles decorate the expanded root additively", () => {
  const child = compileComponent("Card", "t", `<stack class="card-root" style="padding: 4px">
    <head>
      <attribute as="class"/><attribute as="role"/><attribute as="theme"/>
      <attribute as="grow"/><attribute as="surface"/>
    </head>
    <text value="{{ dsx.attribute.class }}|{{ dsx.attribute.role }}|{{ dsx.attribute.theme }}|{{ dsx.attribute.grow }}|{{ dsx.attribute.surface }}"/>
  </stack>`);
  const caller = compileComponent("Screen", "t", `<stack>
    <Card class="consumer-card" role="destructive" theme="dark" grow="width" surface="regular"
          style="margin: 7px; color: {{ 'accent' }}"/>
  </stack>`);
  const collector = new CssCollector();
  extractComponentCss(child, collector);
  extractComponentCss(caller, collector);
  const childHandle = child.root.attrs["__css"]!;
  const callerHandle = caller.root.children[0]!.attrs["__css"]!;
  const mini: Registry = {
    components: { "t.Card": child, "t.Screen": caller },
    globalPool: { Card: "t.Card", Screen: "t.Screen" },
    css: collector.emit(),
    schemes: ["t"],
  };

  const html = renderToString(mini, "t.Screen");
  assert.match(
    html,
    new RegExp(`<div data-dsx-owner="Card" class="dsx-stack card-root consumer-card"[^>]*data-dsx="${childHandle} ${callerHandle}"[^>]*style="color: var\\(--dsx-accent\\)"`),
  );
  assert.ok(
    html.includes(">consumer-card|destructive|dark|width|regular</span>"),
    "invocation attrs are still delivered through dsx.attribute",
  );
  const opening = html.match(/<div data-dsx-owner="Card"[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(opening, /\srole=|data-dsx-theme|data-dsx-grow|dsx-surface-/,
    "SSR and DOM keep non-style props child-owned instead of implicitly forwarding them");
});

test("ssr: renderPage emits title, description, og tags, the cascade and the app html", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const page = renderPage(registry, "demo.Launcher", {}, { title: "DSX demo", description: "walk every capability" }, { theme: "dark" });
  assert.ok(page.includes("<title>DSX demo</title>"));
  assert.ok(page.includes('name="description" content="walk every capability"'));
  assert.ok(page.includes('property="og:title"'));
  assert.ok(page.includes("@layer dsx-tokens, dsx-elements"));
  for (const marker of [
    ".dsx-overlay-layer", ".dsx-calendar", ".dsx-drawer-layer",
    ".dsx-video", ".dsx-svg", ".dsx-lightbox-layer",
  ]) assert.ok(page.includes(marker), `SSR shell inlines ${marker} runtime CSS before boot`);
  assert.ok(page.includes('data-dsx-ssr'));
  assert.ok(page.includes("Component catalog"));
  assert.ok(page.includes('data-dsx-theme="dark"'));
  assert.ok(page.includes('content="width=device-width, initial-scale=1, viewport-fit=cover"'));
  assert.ok(!page.includes("interactive-widget"), "the SSR shell must stay valid in WebKit");
});

test("ssr: pushed vars seed exactly one vars plane", () => {
  const ir = compileComponent("PushedVars", "t", `<stack>
    <text value="{{ vars.message }}"/>
    <text value="{{ vars.vars.message || 'no-double-wrap' }}"/>
  </stack>`);
  const mini: Registry = { components: { "t.PushedVars": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.PushedVars", { message: "مرحبا — שלום — 👩🏽‍💻" });
  assert.ok(html.includes("مرحبا — שלום — 👩🏽‍💻"));
  assert.ok(html.includes("no-double-wrap"), "vars.vars must not be required or populated");
});

test("ssr: renderPage and static export expose route state at vars.path", () => {
  const ir = compileComponent("RouteVars", "t", `<stack><text value="{{ vars.path }}"/></stack>`);
  const mini: Registry = {
    components: { "t.RouteVars": ir },
    globalPool: {},
    css: "",
    schemes: [],
    routes: [{ path: "/state/مرحبا", component: "t.RouteVars" }],
  };
  const page = renderPage(mini, "t.RouteVars", { path: "/direct/שלום" }, {});
  assert.ok(page.includes("/direct/שלום"));

  const out = mkdtempSync(join(tmpdir(), "dsx-static-vars-"));
  try {
    assert.deepEqual(exportStatic(mini, out), ["state/مرحبا/index.html"]);
    const exported = readFileSync(join(out, "state/مرحبا/index.html"), "utf-8");
    assert.ok(exported.includes("/state/مرحبا"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("ssr: CSS cannot break out of document or declarative-shadow style elements", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const hostileCss = `body{color:red}</style><script id="css-breakout">bad()</script><style>`;
  const hostile: Registry = { ...registry, css: hostileCss };
  const page = renderPage(hostile, "demo.Flex", {}, {});
  assert.ok(!page.includes('</style><script id="css-breakout">'));
  assert.ok(page.includes('<\\/style><script id="css-breakout">'));

  const fragment = renderEmbedFragment(
    hostile,
    "demo.EmbedCard",
    "demo-embedcard",
    hostileCss,
  );
  assert.ok(!fragment.includes('</style><script id="css-breakout">'));
  assert.ok(fragment.includes('<\\/style><script id="css-breakout">'));
});

test("ssr: button variant/role words stamp data attributes, never ARIA (the system-defaults twin)", () => {
  const ir = compileComponent("VariantBtn", "t",
    `<stack><button label="Delete" variant="prominent" role="destructive"/><button label="Keep" role="cancel"/></stack>`);
  const mini: Registry = { components: { "t.VariantBtn": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.VariantBtn");
  assert.ok(html.includes('data-dsx-variant="prominent"'));
  assert.ok(html.includes('data-dsx-role="destructive"'));
  assert.ok(html.includes('data-dsx-role="cancel"'));
  assert.ok(!html.includes(' role="destructive"'), "the button role word never mints an ARIA role");
});

test("ssr: canonical button disabled gates match the hydrated DOM contract", () => {
  const ir = compileComponent("DisabledButtons", "t", `<stack>
    <button label="Declared" disabled="true"/>
    <button label="Conditional" disabled-if="true"/>
    <button label="Enabled" disabled-if="false"/>
    <button label="Linked" href="/target" disabled="true" focusOrder="7"/>
  </stack>`);
  const mini: Registry = { components: { "t.DisabledButtons": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.DisabledButtons");
  assert.equal(html.match(/<button\b[^>]*\sdisabled(?:\s|>)/g)?.length, 2);
  assert.match(html, /<a\b[^>]*href="\/target"[^>]*aria-disabled="true"[^>]*tabindex="-1"/);
  assert.doesNotMatch(html, /<a\b[^>]*href="\/target"[^>]*tabindex="7"/,
    "SSR keeps a disabled linked control out of traversal even when focusOrder is authored");
});

test("ssr: generic theme pins every element family with the same validated initial value as the DOM", () => {
  const ir = compileComponent("ThemePins", "t", `<stack theme="{{ vars.mode }}">
    <head><variable as="rows">return [{ label: 'Bound row' }]</variable></head>
    <text value="Light island" theme="light"/>
    <text value="Invalid island" theme="sepia"/>
    <list bind="rows" theme="dark"><text value="{{ item.label }}"/></list>
  </stack>`);
  const mini: Registry = { components: { "t.ThemePins": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.ThemePins", { mode: "dark" });
  assert.match(html, /<div\b[^>]*class="dsx-stack"[^>]*data-dsx-theme="dark"/);
  assert.match(html, /<span\b[^>]*class="dsx-text"[^>]*data-dsx-theme="light"[^>]*>Light island<\/span>/);
  assert.match(html, /<div\b[^>]*class="dsx-list"[^>]*data-dsx-theme="dark"[^>]*>.*Bound row.*<\/div>/);
  assert.equal(html.match(/data-dsx-theme=/g)?.length, 3, "invalid theme tokens fail open instead of leaking to HTML");
});

test("ssr: functional fixture aliases keep canonical link, disabled, content, and control semantics", () => {
  const ir = compileComponent("Aliases", "t", `<stack>
    <transport label="Play" variant="prominent" role="destructive" disabled-if="vars.locked"/>
    <transport label="Docs" href="/docs" disabled="true"/>
    <row href="/detail"><text value="Open detail"/></row>
    <row href="/locked" disabled-if="vars.locked"><text value="Locked detail"/></row>
    <switch bind="vars.enabled" a11yLabel="Wi-Fi"/>
    <input bind="vars.name" placeholder="Account name" secure="true"/>
    <capsuleProgress value="0.5" a11yLabel="Upload"/>
    <activity a11yLabel="Syncing"/>
  </stack>`);
  const mini: Registry = { components: { "t.Aliases": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Aliases", {
    locked: true,
    enabled: true,
    name: "Ada & Grace",
  });

  assert.ok(!html.includes("dsx-unsupported"), "every fixture alias resolves to its canonical web twin");
  assert.match(html, /<button\b[^>]*class="dsx-button"[^>]*data-dsx-variant="prominent"[^>]*data-dsx-role="destructive"[^>]*type="button"[^>]*disabled[^>]*><span>Play<\/span><\/button>/);
  assert.match(html, /<a\b[^>]*class="dsx-button"[^>]*href="\/docs"[^>]*aria-disabled="true"[^>]*tabindex="-1"[^>]*><span>Docs<\/span><\/a>/);
  assert.match(html, /<a\b[^>]*class="dsx-pressable"[^>]*href="\/detail"[^>]*><span class="dsx-text">Open detail<\/span><\/a>/);
  assert.match(html, /<a\b[^>]*class="dsx-pressable"[^>]*href="\/locked"[^>]*aria-disabled="true"[^>]*tabindex="-1"/);
  assert.match(html, /<label\b[^>]*class="dsx-toggle"[^>]*aria-label="Wi-Fi"[^>]*><input type="checkbox" role="switch" checked>/);
  assert.match(html, /<input\b[^>]*class="dsx-textfield"[^>]*type="password"[^>]*placeholder="Account name"[^>]*value="Ada &amp; Grace"/);
  assert.match(html, /<div\b[^>]*class="dsx-progress"[^>]*role="progressbar"[^>]*aria-valuenow="0\.5"[^>]*aria-label="Upload"[^>]*><div class="dsx-progress-fill" aria-hidden="true" style="width: 50%"><\/div><\/div>/);
  assert.match(html, /<div\b[^>]*class="dsx-spinner"[^>]*role="status"[^>]*aria-label="Syncing"[^>]*><\/div>/);
});

test("ssr: fixture layout, tint, spinner scale, and stepper semantics match first client paint", () => {
  const ir = compileComponent("FixtureChrome", "t", `<stack flexDirection="row" alignItems="center" display="grid">
    <hstack><text value="Defaults"/></hstack>
    <scroll direction="horizontal"><text value="Across"/></scroll>
    <divider color="destructive"/>
    <toggle bind="vars.enabled" color="secondary"/>
    <slider bind="vars.amount" color="tertiary"/>
    <spinner color="secondary" scale="1.5"/>
    <stepper bind="vars.quantity" label="Quantity" color="destructive"/>
    <Checkbox bind="vars.enabled" label="Enabled" color="destructive"/>
  </stack>`);
  const mini: Registry = { components: { "t.FixtureChrome": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.FixtureChrome", { enabled: true, amount: 0.5, quantity: 2 });

  assert.match(html, /class="dsx-stack dsx-hstack"[^>]*data-dsx-grid="true"/);
  assert.ok(html.includes('class="dsx-stack dsx-hstack dsx-hstack-defaults"'));
  assert.ok(html.includes('class="dsx-scroll dsx-scroll-x"'));
  assert.ok(html.includes("--dsx-divider-color: var(--dsx-destructive)"));
  assert.ok(html.includes("--dsx-control-tint: var(--dsx-secondary-label)"));
  assert.ok(html.includes("--dsx-spinner-color: var(--dsx-secondary-label)"));
  assert.ok(html.includes("--dsx-spinner-scale: 1.5"));
  assert.ok(html.includes("--dsx-checkbox-color: var(--dsx-destructive)"));
  assert.match(html, /class="dsx-stepper"[^>]*role="group"[^>]*aria-label="Quantity"/);
  assert.ok(html.includes('aria-label="Decrease Quantity"'));
  assert.ok(html.includes('class="dsx-stepper-value" aria-live="polite" aria-atomic="true">2</span>'));
  assert.ok(html.includes('aria-label="Increase Quantity"'));
});

test("ssr: hostile spinner scales stay inside the shared 0.25x to 4x rendering bound", () => {
  const ir = compileComponent("SpinnerScale", "t", `<spinner scale="{{ vars.scale }}"/>`);
  const mini: Registry = { components: { "t.SpinnerScale": ir }, globalPool: {}, css: "", schemes: [] };
  for (const [scale, expected] of [
    [Number.NEGATIVE_INFINITY, 1],
    [-100, 0.25],
    [0, 0.25],
    [1.5, 1.5],
    [1e100, 4],
  ] as const) {
    const html = renderToString(mini, "t.SpinnerScale", { scale });
    assert.ok(html.includes(`--dsx-spinner-scale: ${expected}`), `${scale} normalizes to ${expected}`);
  }
});

test("ssr: role= emits the mount twin — interpolation resolved, button words suppressed, plain roles pass through", () => {
  const ir = compileComponent("Roles", "t",
    `<stack role="tablist">
       <text value="x" role="{{ true ? 'note' : 'article' }}"/>
       <button label="Del" role="destructive"/>
       <button label="Go" role="tab"/>
     </stack>`);
  const mini: Registry = { components: { "t.Roles": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Roles");
  assert.ok(html.includes(' role="tablist"'), "a static non-button role passes through");
  assert.ok(html.includes(' role="note"'), "an interpolated role resolves server-side");
  assert.ok(!html.includes("{{"), "no template text leaks into the markup");
  assert.ok(!html.includes(' role="destructive"'), "the button role word stays off the ARIA attribute");
  assert.ok(html.includes('data-dsx-role="destructive"'), "…and rides the skin stamp instead");
  assert.ok(html.includes(' role="tab"'), "a NON-word role on a button is a legitimate ARIA pass-through");
});

test("ssr: universal surface material resolves safely and matches the DOM class contract", () => {
  const ir = compileComponent("Surfaces", "t",
    `<stack surface="{{ vars.material }}"><text value="card"/><stack surface="thin thick"/></stack>`);
  const mini: Registry = { components: { "t.Surfaces": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Surfaces", { material: "regular" });
  assert.ok(html.includes('class="dsx-stack dsx-surface-regular"'));
  assert.ok(!html.includes("dsx-surface-thin thick"), "compound remote values cannot mint classes");
  assert.ok(!html.includes("dsx-surface-{{"), "template text never reaches a class token");
});

test("ssr: universal globals have semantic, stateful first-paint markup", () => {
  const ir = compileComponent("UniversalGlobals", "t",
    `<stack>
       <Checkbox bind="true" label="Accept terms"/>
       <ProgressRing value="25" max="100" label="25%" size="64" lineWidth="8"/>
       <Skeleton height="18" radius="6"/>
       <ChatBubble value="Hello &amp; welcome" side="right" color="accent"/>
       <Accordion title="Details">
         <text value="Still present while collapsed"/>
       </Accordion>
       <Accordion title="Open details" open="true">
         <text value="Visible details"/>
       </Accordion>
     </stack>`);
  const mini: Registry = { components: { "t.UniversalGlobals": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.UniversalGlobals");

  assert.ok(html.includes('class="dsx-checkbox"'), "Checkbox is not omitted as an unresolved component");
  assert.ok(html.includes('<input type="checkbox" checked>'));
  assert.ok(html.includes("Accept terms"));
  assert.ok(html.includes('class="dsx-progress-ring"'));
  assert.ok(html.includes('role="progressbar"'));
  assert.ok(html.includes('aria-valuenow="0.25"'));
  assert.ok(html.includes('aria-label="25%"'));
  assert.ok(html.includes("dsx-progress-ring-arc"));
  assert.ok(html.includes("--dsx-ring-size: 64px"));
  assert.ok(html.includes('class="dsx-skeleton"'));
  assert.ok(html.includes('aria-hidden="true"'));
  assert.ok(html.includes("--dsx-skeleton-height: 18px"));
  assert.ok(html.includes("dsx-chat-bubble dsx-chat-right"));
  assert.ok(html.includes("Hello &amp; welcome"));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes('class="dsx-accordion-body" hidden'));
  assert.ok(html.includes("Still present while collapsed"));
  assert.ok(html.includes("dsx-accordion dsx-accordion-open"));
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes("Visible details"));
  assert.ok(!html.includes("dsx-unsupported"), "all five globals use their semantic SSR twins");
});

test("ssr: universal-global presentation defaults stay in the weak stylesheet", () => {
  const ir = compileComponent("GlobalDefaults", "t",
    `<stack><ProgressRing value="0.5"/><Skeleton/><ChatBubble value="Hello"/><Accordion title="Details"/></stack>`);
  const mini: Registry = { components: { "t.GlobalDefaults": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.GlobalDefaults");
  assert.ok(!html.includes("--dsx-ring-size:"), "default ring size is author-overridable CSS");
  assert.ok(!html.includes("--dsx-skeleton-height:"), "default skeleton geometry is author-overridable CSS");
  assert.ok(!html.includes("--dsx-chat-color:"), "default bubble palette is author-overridable CSS");
  assert.ok(!html.includes("--dsx-chat-max:"), "default bubble width is author-overridable CSS");
  assert.ok(html.includes('stroke="var(--dsx-ring-track)"'));
  assert.ok(html.includes('stroke="var(--dsx-ring-color)"'));
  assert.ok(html.includes('<span class="dsx-accordion-chevron" aria-hidden="true">›</span>'));
});

test("ssr: generated control IDs are deterministic per document and unique within it", () => {
  const ir = compileComponent("DeterministicIds", "t", `<stack>
    <form as="profile"><field name="email" label="Email"/><field label="Fallback"/></form>
    <combobox options="One,Two"/><combobox options="Three,Four"/>
    <tabs><stack tabTitle="One"/><stack tabTitle="Two"/></tabs>
  </stack>`);
  const mini: Registry = { components: { "t.DeterministicIds": ir }, globalPool: {}, css: "", schemes: [] };
  const first = renderToString(mini, "t.DeterministicIds");
  const second = renderToString(mini, "t.DeterministicIds");
  assert.equal(second, first, "request history cannot perturb SSR output or hydration IDs");
  assert.ok(first.includes('id="dsx-ssr-field-1"'));
  assert.ok(first.includes('id="dsx-ssr-field-2"'));
  assert.ok(first.includes('aria-controls="dsx-combobox-ssr-1"'));
  assert.ok(first.includes('aria-controls="dsx-combobox-ssr-2"'));
  assert.ok(first.includes('id="dsx-tab-1-0"'));
});

test("ssr: universal-global colors cannot inject additional style declarations", () => {
  const payload = "red;position:fixed;top:0;left:0;width:100vw;height:100vh}x{color:blue<script>";
  const ir = compileComponent("GlobalColorSafety", "t",
    `<stack><ChatBubble color="${payload}" value="safe"/><Accordion color="${payload}" title="safe"/></stack>`);
  const mini: Registry = { components: { "t.GlobalColorSafety": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.GlobalColorSafety");
  const chatColor = /--dsx-chat-color: ([^;\"]*)/.exec(html)?.[1] ?? "";
  const accordionColor = /dsx-accordion-chevron[^>]*style="color: ([^\"]*)"/.exec(html)?.[1] ?? "";
  assert.ok(chatColor.length > 0 && !/[;{}<>]/.test(chatColor), chatColor);
  assert.ok(accordionColor.length > 0 && !/[;{}<>]/.test(accordionColor), accordionColor);
  assert.ok(!html.includes("position:fixed;"), "the payload cannot mint a second declaration");
  assert.ok(!html.includes("<script>"), "the payload cannot mint markup");
});

test("ssr: a composed component named like a universal global keeps precedence", () => {
  const host = compileComponent("Host", "t", `<stack><Checkbox/></stack>`);
  const replacement = compileComponent("Checkbox", "t", `<text value="Custom checkbox component"/>`);
  const mini: Registry = {
    components: { "t.Host": host, "t.Checkbox": replacement },
    globalPool: {},
    css: "",
    schemes: [],
  };
  const html = renderToString(mini, "t.Host");
  assert.ok(html.includes("Custom checkbox component"));
  assert.ok(!html.includes("dsx-checkbox"), "the built-in global is only a resolution fallback");
});

test("ssr: reserved WebView stays the builtin even when a component collides", () => {
  const custom = compileComponent("WebView", "t", `<text value="wrong custom tree"/>`);
  const host = compileComponent("Host", "t", `<WebView src="about:blank"/>`);
  const mini: Registry = {
    components: { "t.WebView": custom, "t.Host": host },
    globalPool: {}, css: "", schemes: [],
  };
  const html = renderToString(mini, "t.Host");
  assert.ok(html.includes('class="dsx-webview"'));
  assert.ok(html.includes('src="about:blank"'));
  assert.ok(!html.includes("wrong custom tree"));
});

test("ssr: ProgressRing resolves interpolated max, clamps safely, and emits no duplicate root attributes", () => {
  const ir = compileComponent("RingEdges", "t",
    `<stack>
       <ProgressRing value="4" max="{{ 10 }}" size="{{ 64 }}" label="{{ '4 of 10' }}" style="opacity: {{ 0.75 }}"/>
       <ProgressRing value="99" max="{{ 0 }}" a11yLabel="No maximum"/>
       <ProgressRing value="{{ 0 / 0 }}" max="bad"/>
     </stack>`);
  const mini: Registry = { components: { "t.RingEdges": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.RingEdges");
  assert.ok(html.includes('aria-valuenow="0.4"'));
  assert.ok(html.includes('aria-label="4 of 10"'));
  assert.ok(html.includes('aria-valuenow="0"'), "zero and invalid ratios fail closed to zero");
  for (const [index, match] of [...html.matchAll(/<div class="dsx-progress-ring"([^>]*)>/g)].entries()) {
    const styles = match[1]!.match(/\bstyle=/g)?.length ?? 0;
    assert.ok(styles <= 1, "reactive and explicit component styles share at most one attribute");
    if (index === 0) assert.equal(styles, 1, "the authored reactive style remains present");
    assert.equal(match[1]!.match(/\baria-label=/g)?.length ?? 0, 1, "the accessible label is emitted once");
  }
});

test("ssr: the real Gallery exercises every universal global across its catalogSection tabs", (t) => {
  if (skipWithoutClosedSource(t)) return;
  // The Gallery is an adaptive tabbed scaffold (the `catalogSection` state): each tab
  // renders exactly one panel via visible-if, so the SSR first paint holds only the
  // default 'Controls' tab and the universal globals are partitioned across the Inputs /
  // Feedback / Patterns tabs. The sibling test above already proves each universal global
  // emits semantic, stateful first-paint markup; here we assert the canonical demo still
  // EXERCISES every one of them — present in the compiled tree, so each renders in the SSR
  // first paint of its own tab (a component variable's default cannot be overridden through
  // the pushed `vars` plane, so we verify usage in the tree rather than re-seeding the tab).
  const gallery = registry.components["demo.Gallery"]!;
  const tags = new Set<string>();
  const collect = (node: IRNode): void => {
    tags.add(node.tag);
    for (const child of node.children) collect(child as IRNode);
  };
  collect(gallery.root);
  for (const tag of ["Checkbox", "ProgressRing", "Skeleton", "ChatBubble", "Accordion"]) {
    assert.ok(tags.has(tag), `the Gallery exercises the ${tag} universal global`);
  }
  // and the default 'Controls' tab still yields a valid, non-empty SSR first paint
  const firstPaint = renderToString(registry, "demo.Gallery");
  assert.ok(firstPaint.includes("gallery-page"), "the Gallery shell renders in the SSR first paint");
});

test("ssr: redirects emit meta-refresh + canonical", () => {
  const page = renderRedirect("/");
  assert.ok(page.includes('http-equiv="refresh"'));
  assert.ok(page.includes('rel="canonical"'));
  assert.doesNotThrow(() => assertSafeRedirectTarget("/account?next=%2Forders#ready"));
  assert.doesNotThrow(() => assertSafeRedirectTarget("https://example.test/account"));
  for (const target of [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "//evil.test/path",
    "http://example.test/plaintext",
    "https://user:secret@example.test/path",
    "relative/path",
    "/%2e%2e/admin",
    "/safe%2f..%2fadmin",
    "/bad\u0000target",
  ]) {
    assert.throws(() => renderRedirect(target), /unsafe/);
  }
});

test("ssr: exportStatic writes non-param routes and skips dynamic ones", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const out = mkdtempSync(join(tmpdir(), "dsx-static-"));
  try {
    const written = exportStatic(registry, out, { appName: "DSX demo" });
    assert.ok(written.includes("index.html"));
    assert.ok(written.includes("flex/index.html"));
    assert.ok(written.includes("docs/getting-started/index.html"));
    assert.ok(written.includes("home/index.html")); // the redirect page
    assert.ok(!written.some((w) => w.includes("orders"))); // :id — dynamic, W6
    const flex = readFileSync(join(out, "flex/index.html"), "utf-8");
    assert.ok(flex.includes("<title>Flex layout</title>"));
    assert.ok(flex.includes("Flip flex-direction (row)"));
    const home = readFileSync(join(out, "home/index.html"), "utf-8");
    assert.ok(home.includes('http-equiv="refresh"'));
    const nested = readFileSync(join(out, "docs/getting-started/index.html"), "utf-8");
    assert.ok(nested.includes("<title>Nested route</title>"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("ssr: route output contract preserves valid root, nested, encoded, and dynamic skeleton paths", () => {
  const out = resolve(tmpdir(), "dsx-static-contract");
  assert.deepEqual(resolveRouteOutput(out, "/"), {
    relativePath: "index.html",
    outputPath: join(out, "index.html"),
  });
  assert.deepEqual(resolveRouteOutput(out, "/docs/getting-started/"), {
    relativePath: "docs/getting-started/index.html",
    outputPath: join(out, "docs/getting-started/index.html"),
  });
  assert.equal(resolveRouteOutput(out, "/caf%C3%A9").relativePath, "caf%C3%A9/index.html");
  assert.equal(
    resolveRouteOutput(out, "/orders/:id", { parameterPlaceholder: "__param__" }).relativePath,
    "orders/__param__/index.html",
  );
  assert.throws(() => resolveRouteOutput(out, "/orders/:id", { parameterPlaceholder: "" }), /placeholder/);
});

test("ssr: unsafe route paths fail before any output and cannot traverse outside the root", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const attacks = [
    "../escape",
    "C:\\escape",
    "//server/share",
    "/../escape",
    "/safe/../../escape",
    "/safe\\..\\escape",
    "/%2e%2e/escape",
    "/%252e%252e/escape",
    "/safe%2f..%2fescape",
    "/safe%255c..%255cescape",
    "/%00escape",
    "/nul\u0000escape",
    "/C:/escape",
    "/file:stream/escape",
    "/%3aescape",
    "/folder./escape",
    "/NUL/escape",
    "/files/*/tail",
    "/safe//escape",
    "/bad%2",
  ];

  for (const path of attacks) {
    const container = mkdtempSync(join(tmpdir(), "dsx-static-traversal-"));
    try {
      const unsafe: Registry = {
        ...registry,
        routes: [{ path, component: "demo.Flex" }],
      };
      assert.throws(() => exportStatic(unsafe, join(container, "site")), /unsafe route path/);
      assert.deepEqual(readdirSync(container), [], `${JSON.stringify(path)} wrote outside/preflight output`);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  }
});

test("ssr: route tables reject resource exhaustion and portable output collisions", () => {
  assert.throws(
    () => assertSafeRouteTable(["/" + "a".repeat(256)]),
    /segment exceeds/,
  );
  assert.throws(
    () => assertSafeRouteTable(["/" + Array.from({ length: 129 }, () => "a").join("/")]),
    /path segments/,
  );
  assert.throws(
    () => assertSafeRouteTable(["/Docs", "/docs/"]),
    /collides/,
  );
  assert.throws(
    () => assertSafeRouteTable(["/caf%C3%A9", "/cafe\u0301"]),
    /collides/,
  );
  assert.throws(
    () => assertSafeRouteTable(["/orders/:id", "/orders/{slug}"]),
    /collides/,
  );
});

test("ssr: an existing output symlink cannot redirect a route write outside the root", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const container = mkdtempSync(join(tmpdir(), "dsx-static-symlink-"));
  const site = join(container, "site");
  const outside = join(container, "outside");
  mkdirSync(site);
  mkdirSync(outside);
  symlinkSync(outside, join(site, "linked"), process.platform === "win32" ? "junction" : "dir");
  try {
    const unsafe: Registry = {
      ...registry,
      routes: [{ path: "/linked/escaped", component: "demo.Flex" }],
    };
    assert.throws(() => exportStatic(unsafe, site), /symlink outside/);
    assert.equal(existsSync(join(outside, "escaped/index.html")), false);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

// ── web-component embeds (/web/13): the DSD fragment + the exposure manifest ────────

test("embed: renderEmbedFragment emits the DSD template with attrs echoed and native slots", async (t) => {
  if (skipWithoutClosedSource(t)) return;
  const { renderEmbedFragment } = await import("../src/render.ts");
  const html = renderEmbedFragment(registry, "demo.EmbedCard", "demo-embedcard", "/*css*/", { title: "T", count: 5 });
  assert.ok(html.startsWith('<demo-embedcard title="T" count="5">'), html.slice(0, 60));
  assert.ok(html.includes('<template shadowrootmode="open">'));
  assert.ok(html.includes("<style>/*css*/</style>"));
  assert.ok(html.includes('<slot name="footer">')); // the NATIVE slot (embed mode)
  assert.ok(html.includes("attribute count: 5")); // attrs seeded the render
  assert.ok(html.endsWith("</demo-embedcard>"));
});

test("embed: expose manifest — default tags, dash law, collisions are build errors", async () => {
  const { readExpose, mergeExposed } = await import("../../compiler/src/expose.ts");
  const demo = readExpose("demo", { expose: { EmbedCard: {} }, embed: { origins: ["*"] } });
  assert.equal(demo[0]!.tag, "demo-embedcard");
  assert.deepEqual(demo[0]!.origins, ["*"]);
  const custom = readExpose("shop", { expose: { Paywall: { tag: "acme-paywall" } } });
  assert.equal(custom[0]!.tag, "acme-paywall");
  assert.deepEqual(custom[0]!.origins, []); // embeds OFF unless origins declared
  assert.throws(() => mergeExposed([demo, readExpose("demo2", { expose: { X: { tag: "demo-embedcard" } } })]), /tag collision/);
  assert.throws(() => readExpose("solo", { expose: { X: { tag: "nodash" } } }), /needs a dash/);
});

test("embed: sliceRegistry carries the component, deps, and only their closed css", async (t) => {
  if (skipWithoutClosedSource(t)) return;
  const { sliceRegistry } = await import("../../compiler/src/expose.ts");
  const slice = sliceRegistry(registry, "demo.Flex"); // Flex uses NavBar
  assert.ok(slice.components["demo.Flex"]);
  assert.ok(Object.keys(slice.components).length >= 2); // transitive deps rode along
  assert.ok(slice.css.length < registry.css.length);
  assert.match(slice.css, /\[data-dsx-owner="Flex"\]/);
  assert.doesNotMatch(slice.css, /\[data-dsx-owner="(?:Gallery|Launcher|Workspace)"\]/,
    "unrelated application sidecars do not leak into a self-contained embed");
  for (const component of Object.values(slice.components)) {
    const visit = (node: typeof component.root): void => {
      for (const handle of (node.attrs["__css"] ?? "").split(/\s+/).filter(Boolean)) {
        assert.ok(slice.css.includes(`[data-dsx~="${handle}"]`), `missing generated CSS rule ${handle}`);
      }
      node.children.forEach(visit);
    };
    visit(component.root);
  }
  assert.deepEqual(slice.schemes, []); // the honest subset — no module claims
});

test("ssr: visible-if=has: is the capability check — stripped before JSE, availability-answered (the dom mount twin)", () => {
  ModuleRegistry.register({ scheme: "ssrcam", actions: {} });
  const ir = compileComponent("Caps", "t",
    `<stack>
       <text visible-if="has:ssrcam" value="cam-on"/>
       <text visible-if="has: ssrcam " value="cam-trimmed"/>
       <text visible-if="has:neverinstalled" value="cam-off"/>
     </stack>`);
  const mini: Registry = { components: { "t.Caps": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Caps");
  assert.ok(html.includes("cam-on"), "an available scheme renders");
  assert.ok(html.includes("cam-trimmed"), "the scheme is trimmed like the native twins");
  assert.ok(!html.includes("cam-off"), "an unavailable scheme renders nothing (remove-from-tree, like the client)");
});

test("ssr: <functions global> registers app-wide and the body renders through it (the instantiate twin)", () => {
  const ir = compileComponent("GFnSsr", "t",
    `<stack>
       <head><functions global="true">function gtaxssr(n) { return n * 0.2 }</functions></head>
       <text value="{{ gtaxssr(50) }}"/>
     </stack>`);
  const mini: Registry = { components: { "t.GFnSsr": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.GFnSsr");
  assert.ok(html.includes(">10<"), "the interpolation resolves through the global table server-side");
  JSE.clearGlobalFunctions();
});

// NOTE: this block sits ABOVE the facet-collision test on purpose — that test registers a
// module facet literally named `Accordion` into the process-wide ModuleRegistry, and a facet
// always outranks the universal global (by design). Ordering keeps both honest.
test("ssr: <Accordion> named header slot replaces the default title, body keeps the rest", () => {
  const ir = compileComponent("Acc", "t", `<stack>
    <Accordion title="Ignored" open="true">
      <text slot="header" value="Custom header"/>
      <text value="Body copy"/>
    </Accordion>
    <Accordion title="Details"><text value="Body"/></Accordion>
  </stack>`);
  const mini: Registry = { components: { "t.Acc": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Acc");
  assert.ok(html.includes('aria-expanded="true" data-dsx-part="header"'));
  assert.ok(html.includes("Custom header"));
  assert.ok(html.includes("Details"), "the un-slotted accordion keeps its default title");
  assert.equal(html.match(/dsx-accordion-title/g)?.length, 1, "a custom header emits NO default title span");
  assert.equal(html.match(/Custom header/g)?.length, 1, "header content never doubles into the body");
});

test("ssr: a module facet named like a universal global takes precedence", () => {
  ModuleRegistry.register({
    scheme: "ssrfacetcollision",
    actions: {},
    components: { Accordion: {} },
  });
  const ir = compileComponent("FacetCollision", "t", `<stack><Accordion title="Wrong built-in"/></stack>`);
  const mini: Registry = { components: { "t.FacetCollision": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.FacetCollision");
  assert.ok(!html.includes("dsx-accordion"), "SSR must not substitute built-in markup for the facet");
  assert.ok(!html.includes("Wrong built-in"));
});

// ── L-01 element-ledger closure: the SSR twins ────────────────────────────────────
//  Every row that moved to `supported` in support/element-support.json must paint its
//  contract on the SERVER too, or first paint and the adopt walk diverge.

test("ssr: <text markdown> paints the inline vocabulary, and hostile data stays escaped", () => {
  const ir = compileComponent("Md", "t", `<stack>
    <head><variable as="copy">return '**bold** and \`code\` and [x](https://a.example/b)'</variable></head>
    <text markdown="true" bind="dsx.variable.copy"/>
    <text markdown="false" value="**not bold**"/>
    <text markdown="true" value="&lt;img src=x onerror=y&gt; [t](javascript:alert(1))"/>
  </stack>`);
  const mini: Registry = { components: { "t.Md": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Md");
  assert.ok(html.includes("<strong>bold</strong>"), "emphasis paints server-side");
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes('<a href="https://a.example/b" data-dsx-part="link" rel="noopener noreferrer">x</a>'));
  assert.ok(html.includes("**not bold**"), 'markdown="false" is OFF — every non-empty string is JSE-truthy, the word is not');
  assert.ok(!html.includes("<img src=x"), "authored markup in a markdown body never becomes markup");
  assert.ok(html.includes("&lt;img src=x onerror=y&gt;"));
  assert.ok(!html.includes("javascript:alert(1)\""), "a refused link target never reaches an href");
});

test("ssr: <text lineLimit> emits the same clamp declarations the DOM factory sets", () => {
  const ir = compileComponent("Clamp", "t",
    `<stack><text value="copy" lineLimit="2"/><text value="copy" lineLimit="0"/></stack>`);
  const mini: Registry = { components: { "t.Clamp": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Clamp");
  assert.equal(html.match(/-webkit-line-clamp: 2/g)?.length, 1);
  assert.ok(html.includes("display: -webkit-box"));
  assert.ok(!html.includes("-webkit-line-clamp: 0"), "0 is no clamp, not a zero-height box");
});

test("ssr: <image> paints a11yLabel, resolves asset paths and reports native bundle keys", () => {
  const ir = compileComponent("Img", "t", `<stack>
    <image src="/a.png"/>
    <image src="/b.png" a11yLabel="Chart of sales"/>
    <image asset="media/logo.svg" a11yLabel="Logo"/>
    <image asset="AppLogo" a11yLabel="App logo"/>
  </stack>`);
  const mini: Registry = { components: { "t.Img": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Img");
  assert.ok(html.includes('src="/a.png" alt=""'), "no a11yLabel = decorative = alt=\"\"");
  assert.ok(html.includes('src="/b.png" alt="Chart of sales"'));
  assert.ok(html.includes('src="media/logo.svg" alt="Logo"'));
  assert.ok(html.includes('data-dsx-unresolved="asset" alt="App logo"'));
});

test("ssr: audio/video reflect the normalized AVAudioSession category pair", () => {
  const ir = compileComponent("Media", "t", `<stack>
    <audio class="a-default" src="/clip.wav"/>
    <audio class="a-ambient" session="ambient" src="/clip.wav"/>
    <video class="v-default" src="/clip.mp4"/>
    <video class="v-playback" audio="playback" src="/clip.mp4"/>
  </stack>`);
  const mini: Registry = { components: { "t.Media": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Media");
  const tag = (marker: string): string => html.match(new RegExp(`<(?:audio|video)[^>]*${marker}[^>]*>`))?.[0] ?? "";
  assert.match(tag("a-default"), /data-dsx-session="playback"/, "audio.json session default");
  assert.match(tag("a-ambient"), /data-dsx-session="ambient"/);
  assert.match(tag("v-default"), /data-dsx-session="ambient"/, "video.json audio= default");
  assert.match(tag("v-playback"), /data-dsx-session="playback"/);
});

test("ssr: <svg> renders the safe subset and reports a native bundle key like <image>", () => {
  const ir = compileComponent("Svg", "t", `<stack>
    <svg class="path-form" d="M0 0 L100 0 L50 100 Z" viewBox="0 0 100 100" fill="accent" a11yLabel="Triangle"/>
    <svg class="inline-form" src="&lt;svg viewBox='0 0 10 10'&gt;&lt;rect width='10' height='10' fill='#3366ff'/&gt;&lt;/svg&gt;"/>
    <svg class="bundle-form" asset="AppMark"/>
    <svg class="invalid-form" src="&lt;svg&gt;&lt;g&gt;&lt;rect width='1' height='1'/&gt;&lt;/g&gt;&lt;/svg&gt;"/>
  </stack>`);
  const mini: Registry = { components: { "t.Svg": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Svg");
  const span = (marker: string): string => html.match(new RegExp(`<span[^>]*${marker}[^>]*>`))?.[0] ?? "";
  assert.match(span("path-form"), /data-dsx-valid="true"/);
  assert.match(span("path-form"), /role="img"/);
  assert.ok(html.includes('d="M 0 0 L 100 0 L 50 100 Z"'), "the d= convenience form canonicalizes the path");
  assert.ok(html.includes('fill="var(--dsx-accent)"'), "semantic paint tokens resolve on the d= form");
  assert.match(span("inline-form"), /data-dsx-valid="true"/);
  assert.doesNotMatch(span("inline-form"), /data-dsx-unresolved/);
  assert.match(span("bundle-form"), /data-dsx-valid="false" data-dsx-unresolved="asset"/,
    "a native app-bundle key is reported, not swallowed (the image precedent)");
  assert.match(span("invalid-form"), /data-dsx-valid="false"/);
  assert.doesNotMatch(span("invalid-form"), /data-dsx-unresolved/, "refused markup is invalid, not a bundle key");
});

test("ssr: <searchbar> paints the composite anatomy the DOM factory builds", () => {
  const ir = compileComponent("Search", "t", `<stack>
    <head><variable as="q">return 'coffee'</variable></head>
    <searchbar bind="dsx.variable.q"/>
    <searchbar placeholder="Find a track"/>
  </stack>`);
  const mini: Registry = { components: { "t.Search": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Search");
  assert.ok(html.includes('class="dsx-searchbar-field"'));
  assert.ok(html.includes('class="dsx-searchbar-icon" aria-hidden="true" data-dsx-part="icon"'));
  assert.ok(html.includes('class="dsx-textfield dsx-searchbar" type="search"'));
  assert.ok(html.includes('placeholder="Search" value="coffee"'), "the fixture placeholder default is Search");
  assert.ok(html.includes('placeholder="Find a track"'));
  assert.ok(html.includes('class="dsx-searchbar-clear" type="button" data-dsx-part="clear" aria-label="Clear search"'));
  assert.equal(html.match(/dsx-searchbar-clear[^>]*hidden/g)?.length, 1, "only the EMPTY field hides its clear button");
});

test("ssr: <textfield> keyboard/contentType map to inputmode/type/autocomplete", () => {
  const ir = compileComponent("Fields", "t", `<stack>
    <textfield keyboard="email" contentType="emailAddress"/>
    <textfield secure="true" contentType="password"/>
    <textfield keyboard="number" contentType="oneTimeCode"/>
  </stack>`);
  const mini: Registry = { components: { "t.Fields": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Fields");
  assert.ok(html.includes('type="email" inputmode="email" autocomplete="email"'));
  assert.ok(html.includes('type="password" autocomplete="current-password"'));
  assert.ok(html.includes('type="text" inputmode="numeric" autocomplete="one-time-code"'));
});

test("ssr: <textarea> rows honor minLines/maxLines, and <stepper> paints its caption", () => {
  const ir = compileComponent("Grow", "t", `<stack>
    <head><variable as="body">return 'a\\nb\\nc\\nd\\ne\\nf'</variable></head>
    <textarea bind="dsx.variable.body" minLines="2" maxLines="4"/>
    <textarea minLines="3"/>
    <stepper bind="dsx.variable.n" label="Guests"/>
    <stepper bind="dsx.variable.n"/>
  </stack>`);
  const mini: Registry = { components: { "t.Grow": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Grow");
  assert.ok(html.includes('rows="4"'), "content past maxLines caps at maxLines");
  assert.ok(html.includes(">a\nb\nc\nd\ne\nf</textarea>"), "a textarea's value IS its content — it paints on the server");
  assert.ok(html.includes('rows="3"'), "an empty field opens at minLines");
  assert.ok(html.includes('<span class="dsx-stepper-label" data-dsx-part="label">Guests</span>'));
  assert.equal(html.match(/dsx-stepper-label/g)?.length, 1, "an unlabelled stepper mounts NO caption");
});

test("ssr: the BLOCK <markdown> element paints server-side with the corpus emitter (W7)", () => {
  const ir = compileComponent("Doc", "t", `<stack>
    <head><variable as="body">return "# Title\\n\\nA paragraph with **bold**.\\n\\n- one\\n- two"</variable></head>
    <markdown bind="dsx.variable.body"/>
    <markdown value="Second block, plain."/>
  </stack>`);
  const mini: Registry = { components: { "t.Doc": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Doc");
  assert.ok(html.includes('class="dsx-markdown"'), "the host div carries the DOM twin's class");
  assert.ok(html.includes('<h1 class="dsx-md-heading">Title</h1>'), "headings paint");
  assert.ok(html.includes("<strong>bold</strong>"), "inline intents run inside blocks");
  assert.ok(html.includes('<ul class="dsx-md-list"><li>one</li><li>two</li></ul>'), "lists paint");
  assert.ok(html.includes('<p class="dsx-md-paragraph">Second block, plain.</p>'), "value= paints too");
});

test("ssr: <markdown> never lets authored HTML through — script arrives as text", () => {
  const ir = compileComponent("Hostile", "t", `<stack>
    <head><variable as="body">return "before\\n\\n<script>alert(1)</script>\\n\\nafter"</variable></head>
    <markdown bind="dsx.variable.body"/>
  </stack>`);
  const mini: Registry = { components: { "t.Hostile": ir }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(mini, "t.Hostile");
  assert.ok(!html.includes("<script>alert"), "raw HTML in markdown source must never reach the wire live");
  assert.ok(html.includes("&lt;script&gt;"), "it renders as escaped text instead");
});

test("ssr: exportStatic rebases ./-relative shell references by route depth", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const out = mkdtempSync(join(tmpdir(), "dsx-static-depth-"));
  try {
    const shell = {
      appName: "DSX demo",
      mainSrc: "./main.js",
      importMapJson: JSON.stringify({ imports: { "@despia/kernel": "./vendor/kernel/index.js" } }),
      manifestHref: "/manifest.webmanifest",
    };
    exportStatic(registry, out, shell);
    const root = readFileSync(join(out, "index.html"), "utf-8");
    assert.ok(root.includes('src="./main.js"'));
    assert.ok(root.includes('"./vendor/kernel/index.js"'));
    const one = readFileSync(join(out, "flex/index.html"), "utf-8");
    assert.ok(one.includes('src="../main.js"'));
    assert.ok(one.includes('"../vendor/kernel/index.js"'));
    const two = readFileSync(join(out, "docs/getting-started/index.html"), "utf-8");
    assert.ok(two.includes('src="../../main.js"'));
    assert.ok(two.includes('"../../vendor/kernel/index.js"'));
    assert.ok(two.includes('href="/manifest.webmanifest"')); // absolute references pass through
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("ssr: the live page handler rebases the shell by the request URL's directory depth", async (t) => {
  if (skipWithoutClosedSource(t)) return;
  const handler = createPageHandler(registry, { mainSrc: "./main.js" });
  const html = async (path: string): Promise<string> => {
    const res = await handler(new Request(`https://site.test${path}`));
    assert.ok(res !== null && res.status === 200, `expected a page at ${path}`);
    return await res.text();
  };
  assert.ok((await html("/")).includes('src="./main.js"'));                       // base /
  assert.ok((await html("/flex")).includes('src="./main.js"'));                   // no-slash leaf: base /
  assert.ok((await html("/docs/getting-started")).includes('src="../main.js"'));  // base /docs/
  assert.ok((await html("/docs/getting-started/")).includes('src="../../main.js"')); // slash form: base /docs/getting-started/
  assert.ok((await html("/orders/42")).includes('src="../main.js"'));             // dynamic route, base /orders/
});

test("ssr: density= stamps the validated subtree pin so first paint and hydration agree (W9)", () => {
  const component = compileComponent("Dense", "t", `<stack>
    <vstack class="pinned" density="compact"><button label="Send"/></vstack>
    <vstack class="restored" density=" comfortable "><text value="wide"/></vstack>
    <vstack class="invalid" density="Cozy"><text value="no pin"/></vstack>
  </stack>`);
  const registry: Registry = { components: { "t.Dense": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Dense");
  assert.match(html, /class="dsx-stack dsx-vstack pinned"[^>]*data-dsx-density="compact"/);
  assert.match(html, /class="dsx-stack dsx-vstack restored"[^>]*data-dsx-density="comfortable"/,
    "the fold trims before validating (input/density.json)");
  assert.doesNotMatch(html, /class="dsx-stack dsx-vstack invalid"[^>]*data-dsx-density/,
    "an invalid word never stamps - the subtree stays transparent to its ancestors");
});
