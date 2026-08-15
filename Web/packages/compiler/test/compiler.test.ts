//
//  compiler.test.ts - the compiler against REAL first-party sources (zero source
//  changes is the law): Demo + Foundation components must parse, split heads, fold
//  platforms, stamp per-node reactivity, and emit layered css.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { parseDsx, DsxParseError, DSX_PARSE_LIMITS } from "../src/xml.ts";
import { compileComponent, foldPlatformAttrs, type IRNode } from "../src/component.ts";
import { splitStyleAttr, mapStyleValue, legacyAttrToDecls } from "../src/cssmap.ts";
import { scopeSheet, CssCollector, extractComponentCss } from "../src/css.ts";
import { buildRegistry, isValidComponentName } from "../src/registry.ts";
import { resolveComponent } from "../src/resolve.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const DEMO = join(repoRoot(), "ClosedSource/DSX/Modules/Custom/Demo");
const FOUNDATION = join(repoRoot(), "ClosedSource/DSX/Modules/Mandatory/Foundation");

test("xml: smart entities — bare & is literal, < inside quoted attr is literal", () => {
  const node = parseDsx(`<stack visible-if="a && b" note="1 < 2"><text value="A &amp; B &lt;tag&gt;"/></stack>`);
  assert.equal(node.attrs["visible-if"], "a && b");
  assert.equal(node.attrs["note"], "1 < 2");
  assert.equal(node.children[0]!.attrs["value"], "A & B <tag>");
});

test("xml: code-tag bodies are raw (never markup)", () => {
  const node = parseDsx(`<stack><head><variable as="x">return 1 < 2 && 'a</b>'.length > 0</variable></head></stack>`);
  const v = node.children[0]!.children[0]!;
  assert.equal(v.text, `return 1 < 2 && 'a</b>'.length > 0`);
});

test("xml: raw code bodies preserve native-lifted JavaScript whitespace", () => {
  const body = `const before = 1;\u000Bconst after = 2;\u000Creturn before + after`;
  for (const tag of ["variable", "functions"]) {
    const node = parseDsx(`<stack><head><${tag} as="x">${body}</${tag}></head></stack>`);
    assert.equal(node.children[0]!.children[0]!.text, body, tag);
  }
});

test("xml: one root enforced", () => {
  assert.throws(() => parseDsx(`<stack/><stack/>`));
});

test("xml: parser budgets accept the nesting boundary and reject hostile depth stably", () => {
  const nested = (depth: number): string => "<a>".repeat(depth) + "ok" + "</a>".repeat(depth);
  assert.equal(parseDsx(nested(DSX_PARSE_LIMITS.maxDepth)).tag, "a");

  const hostile = nested(8_000);
  assert.throws(
    () => parseDsx(hostile),
    (error: unknown) => error instanceof DsxParseError &&
      /nesting depth exceeds 256-level limit/.test(error.message),
  );
});

test("xml: parser budgets reject oversized documents and node floods", () => {
  const oversized = `<a note="${"x".repeat(DSX_PARSE_LIMITS.maxDocumentBytes)}"/>`;
  assert.throws(
    () => parseDsx(oversized),
    (error: unknown) => error instanceof DsxParseError && /document exceeds .*byte limit/.test(error.message),
  );

  const nodeFlood = `<a>${"<b/>".repeat(DSX_PARSE_LIMITS.maxNodes)}</a>`;
  assert.throws(
    () => parseDsx(nodeFlood),
    (error: unknown) => error instanceof DsxParseError && /node count exceeds .*node limit/.test(error.message),
  );
});

test("xml: invalid XML numeric entities fail as stable parse errors", () => {
  for (const entity of [
    "&#999999999999999;", "&#xFFFFFFFF;", "&#xD800;",
    "&#0;", "&#11;", "&#31;", "&#xFFFE;", "&#xFFFF;",
  ]) {
    assert.throws(
      () => parseDsx(`<a note="${entity}">${entity}</a>`),
      (error: unknown) => error instanceof DsxParseError &&
        /numeric entity is not a valid XML character/.test(error.message),
    );
  }

  const maxScalar = String.fromCodePoint(0x10_FFFF);
  assert.equal(parseDsx("<a>&#9;&#10;&#13;&#32;&#xFFFD;</a>").text, "\t\n\r \uFFFD");
  assert.equal(parseDsx("<a>&#1114111;</a>").text, maxScalar);
  assert.equal(parseDsx("<a>&#x10FFFF;</a>").text, maxScalar);
});

test("xml: invalid literal XML characters fail in every structural context", () => {
  for (const literal of ["\0", "\u000B", "\u001F", "\uFFFE", "\uFFFF", "\uD800", "\uDC00"]) {
    for (const source of [
      `<a note="${literal}"/>`,
      `<a>${literal}</a>`,
      `<a><![CDATA[${literal}]]></a>`,
      `<a><!--${literal}--></a>`,
    ]) {
      assert.throws(
        () => parseDsx(source),
        (error: unknown) => error instanceof DsxParseError &&
          /literal is not a valid XML character/.test(error.message),
      );
    }
  }
});

test("xml: attribute and text floods remain linear-time", () => {
  const source = `<root>${'<b note="value">text</b>'.repeat(20_000)}</root>`;
  const started = performance.now();
  const root = parseDsx(source);
  const elapsed = performance.now() - started;
  assert.equal(root.children.length, 20_000);
  assert.ok(elapsed < 5_000, `bounded document parsed too slowly: ${elapsed.toFixed(1)}ms`);
});

test("platform folding: :web wins, :ios/:android/:native drop", () => {
  const folded = foldPlatformAttrs({
    "label": "Subscribe",
    "label:ios": "Subscribe via App Store",
    "label:web": "Subscribe — checkout by Stripe",
    "hint:android": "gone",
    "on:tap": "dsx.action.go()",
    "on:tap.throttle": "80",
  });
  assert.equal(folded["label"], "Subscribe — checkout by Stripe");
  assert.equal(folded["label:ios"], undefined);
  assert.equal(folded["hint:android"], undefined);
  assert.equal(folded["on:tap"], "dsx.action.go()"); // event names keep their colon
  assert.equal(folded["on:tap.throttle"], "80");
});

test("compile: Flex.dsx — head split, variables, body intact", () => {
  const src = readFileSync(join(DEMO, "Components/Flex.dsx"), "utf-8");
  const ir = compileComponent("Flex", "demo", src);
  assert.equal(ir.head.variables.length, 2);
  assert.equal(ir.head.variables[0]!.as, "dir");
  assert.equal(ir.head.variables[0]!.computed, false);
  assert.ok(ir.root.children.every((c) => c.tag !== "head"));
  assert.equal(ir.reactive, true);
});

test("compile: NavBar.dsx — attributes with defaults, event, action, slot present", () => {
  const src = readFileSync(join(FOUNDATION, "Components/Core/NavBar.dsx"), "utf-8");
  const ir = compileComponent("NavBar", "shared", src);
  const byName = new Map(ir.head.attributes.map((a) => [a.as, a.default]));
  assert.ok(byName.has("title"));
  assert.equal(byName.get("backLabel"), "'Back'");
  assert.deepEqual(ir.head.events.map((e) => e.as), ["back"]);
  assert.equal(ir.head.actions.length, 1);
  assert.equal(ir.head.actions[0]!.as, "claimChrome");
  const hasSlot = JSON.stringify(ir.root).includes('"slot"');
  assert.ok(hasSlot, "trailing slot survives in the body IR");
});

test("NavBar custom back target expands only for coarse Web pointers", () => {
  const source = readFileSync(join(FOUNDATION, "Components/Core/NavBar.dsx"), "utf-8");
  const ir = compileComponent("NavBar", "shared", source);
  const button = source.match(/<button\b[^>]*class="dsx-navbar-back"[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(button, /width:\s*34px/, "native and precision-pointer geometry stays compact");
  assert.match(button, /height:\s*34px/, "native and precision-pointer geometry stays compact");
  assert.doesNotMatch(button, /min-(?:width|height)/, "the portable native component contract is unchanged");
  assert.ok(JSON.stringify(ir.root).includes("dsx-navbar-back"), "the Web IR retains the target hook");

  const sidecar = readFileSync(join(FOUNDATION, "Components/Core/NavBar.css"), "utf-8");
  const coarse = sidecar.match(/@media \(pointer: coarse\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";
  const rule = coarse.match(/\.dsx-navbar-back\s*\{([^}]*)\}/s)?.[1] ?? "";
  const minWidth = Number(rule.match(/min-width:\s*(\d+)px/)?.[1] ?? 0);
  const minHeight = Number(rule.match(/min-height:\s*(\d+)px/)?.[1] ?? 0);
  assert.ok(minWidth >= 44, `coarse-pointer width is at least 44px (${minWidth}px)`);
  assert.ok(minHeight >= 44, `coarse-pointer height is at least 44px (${minHeight}px)`);
  assert.doesNotMatch(
    sidecar.replace(/@media \(pointer: coarse\)\s*\{[\s\S]*\}\s*$/, ""),
    /\.dsx-navbar-back/,
    "precision-pointer Web keeps the compact 34px geometry",
  );

  const scoped = scopeSheet(sidecar, "NavBar");
  assert.match(
    scoped,
    /@media \(pointer: coarse\)\s*\{\s*\[data-dsx-owner="NavBar"\] \.dsx-navbar-back/,
    "the compiler keeps the target rule owner-scoped inside its media query",
  );
});

test("compile: Launcher.dsx — computed variable + the attribute contract", () => {
  const src = readFileSync(join(DEMO, "Components/Launcher.dsx"), "utf-8");
  const ir = compileComponent("Launcher", "demo", src);
  // The launcher declares its inputs as ATTRIBUTES (the component input contract) —
  // the old `<expects variable="vars"/>` seed is gone.
  assert.deepEqual(ir.head.expects, []);
  assert.deepEqual(
    ir.head.attributes.map((a) => a.as),
    ["avail_haptic", "avail_biometric", "avail_push", "avail_store", "avail_media", "avail_sensors", "avail_chrome", "avail_data", "avail_scene3d"],
  );
  // Canonical head order (dsx-anatomy.md): plain state precedes computed, so the
  // computed `pages` seed trails the plain inputs (lint_dsx head-order rule).
  assert.deepEqual(
    ir.head.variables.map((variable) => variable.as),
    ["previewMode", "previewScale", "autosave", "density", "surface", "activity", "pages"],
  );
  assert.equal(ir.head.variables.at(-1)!.computed, true);
});

test("compile: <api as> is one bounded state identifier, never a dot path", () => {
  const valid = compileComponent("Api", "test",
    `<stack><head><api as="orders_2" url="/api/orders"/></head></stack>`);
  assert.deepEqual(valid.head.apis.map((api) => api.as), ["orders_2"]);
  assert.throws(
    () => compileComponent("Api", "test",
      `<stack><head><api as="orders.-1" url="/api/orders"/></head></stack>`),
    /ASCII identifier/,
  );
  assert.throws(
    () => compileComponent("Api", "test", `<stack><head><api url="/api/orders"/></head></stack>`),
    /ASCII identifier/,
  );
});

test("per-node reactive stamps: static subtrees are inert", () => {
  const ir = compileComponent("T", "t", `<stack>
    <stack><text value="static"/><divider/></stack>
    <stack><text value="{{ live }}"/></stack>
  </stack>`);
  const stat = ir.root.children[0] as IRNode;
  const live = ir.root.children[1] as IRNode;
  assert.equal(stat.reactive, false);
  assert.equal((stat.children[0] as IRNode).reactive, false);
  assert.equal(live.reactive, true);
  assert.equal((ir.root as IRNode).reactive, true);
});

test("css: style split — static extracted, {{ }} declarations stay reactive", () => {
  const { staticDecls, reactiveDecls } = splitStyleAttr(
    "flex-direction: {{ dsx.variable.dir }}; gap: 0.375rem; color: tertiary",
  );
  assert.deepEqual(staticDecls, [["gap", "0.375rem"], ["color", "var(--dsx-tertiary-label)"]]);
  assert.deepEqual(reactiveDecls, [["flex-direction", "{{ dsx.variable.dir }}"]]);
});

test("css: composed invocation keeps presentation handles beside component props", () => {
  const ir = compileComponent("Screen", "test",
    `<stack><Card class="consumer-card" title="Hello" style="padding: 9px; color: {{ dsx.variable.tint }}"/></stack>`,
  );
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const invocation = ir.root.children[0] as IRNode;
  assert.equal(invocation.attrs["class"], "consumer-card");
  assert.equal(invocation.attrs["title"], "Hello");
  assert.match(invocation.attrs["__css"] ?? "", /^c\d+$/);
  assert.equal(invocation.attrs["__style_reactive"], "color:{{ dsx.variable.tint }}");
  assert.doesNotMatch(JSON.stringify(invocation.attrs), /"style":/);
});

test("css: semantic tokens map per property family", () => {
  assert.equal(mapStyleValue("color", "secondary"), "var(--dsx-secondary-label)");
  assert.equal(mapStyleValue("background", "secondary"), "var(--dsx-secondary-background)");
  assert.equal(mapStyleValue("color", "#30D158"), "#30D158");
});

test("css: legacy attribute bridge", () => {
  assert.deepEqual(legacyAttrToDecls("radius", "16"), [["border-radius", "16px"]]);
  assert.deepEqual(legacyAttrToDecls("background", "fill"), [["background", "var(--dsx-fill)"]]);
  // grow is axis-aware: no declarations — it rides data-dsx-grow + parent-axis rules
  assert.deepEqual(legacyAttrToDecls("grow", "width"), []);
  assert.deepEqual(legacyAttrToDecls("flexDirection", "row"), [["flex-direction", "row"]]);
  assert.deepEqual(legacyAttrToDecls("alignItems", "flex-end"), [["align-items", "flex-end"]]);
  assert.deepEqual(legacyAttrToDecls("display", "grid"), [["display", "grid"]]);
  assert.deepEqual(legacyAttrToDecls("display", "grid;position:fixed"), [], "layout enums fail closed");
  assert.equal(legacyAttrToDecls("bind", "x"), null);
});

test("css: canonical stack layout attributes land in the strongest attribute layer", () => {
  const ir = compileComponent("Layout", "test",
    `<stack flexDirection="row" alignItems="center" display="grid"><text value="One"/></stack>`,
  );
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const css = collector.emit();
  assert.match(css, /@layer dsx-attrs/);
  assert.match(css, /flex-direction: row/);
  assert.match(css, /align-items: center/);
  assert.match(css, /display: grid/);
  assert.ok(ir.root.attrs["__css"], "the stack carries its generated attribute handle");
});

test("css: sidecar sheets get owner-scoped, at-rules recurse", () => {
  const scoped = scopeSheet(`.card { padding: 1rem; }\n@media (min-width: 600px) { .card { padding: 2rem; } }`, "Flex");
  assert.ok(scoped.includes(`[data-dsx-owner="Flex"] .card { padding: 1rem; }`));
  assert.ok(/@media \(min-width: 600px\) \{\s*\[data-dsx-owner="Flex"\] \.card/.test(scoped));
});

test("registry: Demo + Foundation build; resolution local → pool", () => {
  const registry = buildRegistry([
    { dir: DEMO },
    { dir: FOUNDATION, scheme: "shared" },
  ]);
  assert.ok(registry.components["demo.Flex"]);
  assert.ok(registry.components["demo.Launcher"]);
  assert.ok(registry.components["shared.NavBar"]);
  const nav = resolveComponent(registry, "demo", "NavBar");
  assert.ok(nav !== null && nav.name === "NavBar");
  const local = resolveComponent(registry, "demo", "Flex");
  assert.ok(local !== null && local.scheme === "demo");
  assert.ok(registry.css.startsWith("@layer dsx-tokens, dsx-elements"));
  assert.ok(registry.css.includes(`[data-dsx-owner="Flex"] .card`));
  assert.match(
    registry.css,
    /@media \(pointer: coarse\)\s*\{\s*\[data-dsx-owner="NavBar"\] \.dsx-navbar-back/,
    "the shipped Foundation registry includes the scoped coarse-pointer target rule",
  );
  // the style split stamped handles onto nodes
  assert.ok(JSON.stringify(registry.components["demo.Flex"]).includes("__css"));
  assert.ok(Object.keys(registry.components).every((qualified) => !qualified.includes(" 2")));
});

test("registry: component filenames use the native portable identifier law", () => {
  assert.equal(isValidComponentName("Paywall"), true);
  assert.equal(isValidComponentName("Paywall2"), true);
  assert.equal(isValidComponentName("Paywall_2"), true);
  assert.equal(isValidComponentName("Paywall 2"), false);
  assert.equal(isValidComponentName("paywall"), false);
  assert.equal(isValidComponentName("Pay-wall"), false);
});

test("xml: a bare '<' in body text fails fast (never hangs the parser)", () => {
  // regression: a bare `<` opens no tag, so the text run made zero progress and the
  // parse loop spun forever — a build/SSR DoS. It must throw a located error instead.
  assert.throws(() => parseDsx("<text>score < 10</text>"), /unexpected '<'|&lt;/);
  assert.throws(() => parseDsx("<text>a <= b</text>"), /unexpected '<'|&lt;/);
  // the escaped form still parses cleanly
  const ok = parseDsx("<text>score &lt; 10</text>");
  assert.equal(ok.text.trim(), "score < 10");
});

test("cssmap: reactive style values can't inject extra declarations (SSR/XSS)", () => {
  // the overlay-injection payload from the review needs no HTML metacharacters, so
  // HTML-escaping can't stop it — the value-level neutralization must.
  const evil = "red;position:fixed;top:0;left:0;width:100vw;height:100vh";
  assert.ok(!/[;{}<>]/.test(mapStyleValue("color", evil)), "declaration separators stripped");
  assert.ok(!/[;{}<>]/.test(mapStyleValue("background", "x}html{display:none")), "braces stripped");
  assert.ok(!/[;{}<>]/.test(mapStyleValue("color", "a<script>")), "angle brackets stripped");
  assert.ok(!/[;{}<>]/.test(legacyAttrToDecls("padding", "1;position:fixed")![0]![1]), "bridge attr neutralized");
  // legit values pass through untouched
  assert.equal(mapStyleValue("color", "rgb(1, 2, 3)"), "rgb(1, 2, 3)");
  assert.equal(mapStyleValue("width", "calc(100% - 10px)"), "calc(100% - 10px)");
  assert.equal(mapStyleValue("color", "label"), "var(--dsx-label)");
});

test("head: <functions global> routes to globalScripts — the global-function-library block (Conformance/functions)", () => {
  const ir = compileComponent("Fns", "t",
    `<stack>
       <head>
         <functions global="true">function gtax(n) { return n * 0.2 }</functions>
         <functions>function local(n) { return n + 1 }</functions>
         <script>function older(n) { return n }</script>
       </head>
       <text value="x"/>
     </stack>`);
  assert.deepEqual(ir.head.globalScripts, ["function gtax(n) { return n * 0.2 }"]);
  assert.deepEqual(ir.head.scripts, ["function local(n) { return n + 1 }", "function older(n) { return n }"]);
});

test("head: the global attribute routes by PRESENCE — the bare spelling parses here too", () => {
  // canonical is global="true" (Apple's XMLParser rejects bare attributes); this parser
  // accepts the bare form, and presence — not value — is the router.
  const ir = compileComponent("FnsBare", "t",
    `<stack><head><functions global>function g() { return 1 }</functions></head><text value="x"/></stack>`);
  assert.equal(ir.head.globalScripts.length, 1);
  assert.equal(ir.head.scripts.length, 0);
});
