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

// A handful of tests compile the REAL closed Demo/Foundation sources. An open drop
// skips those LOUDLY (the component-fold-conformance rule); the rest run anywhere.
function skipWithoutClosedSource(t: { skip(msg: string): void }): boolean {
  if (existsSync(join(repoRoot(), "ClosedSource"))) return false;
  t.skip("open drop without ClosedSource - the Demo/Foundation sources ship closed");
  return true;
}

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

test("compile: Flex.dsx — head split, variables, body intact", (t) => {
  if (skipWithoutClosedSource(t)) return;
  const src = readFileSync(join(DEMO, "Components/Flex.dsx"), "utf-8");
  const ir = compileComponent("Flex", "demo", src);
  assert.equal(ir.head.variables.length, 2);
  assert.equal(ir.head.variables[0]!.as, "dir");
  assert.equal(ir.head.variables[0]!.computed, false);
  assert.ok(ir.root.children.every((c) => c.tag !== "head"));
  assert.equal(ir.reactive, true);
});

test("compile: NavBar.dsx — attributes with defaults, event, action, slot present", (t) => {
  if (skipWithoutClosedSource(t)) return;
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

test("NavBar custom back target expands only for coarse Web pointers", (t) => {
  if (skipWithoutClosedSource(t)) return;
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

test("scopeSheet: a component's OWN ROOT is reachable from its sidecar sheet", () => {
  // The owner stamp lives on the root element itself, so the descendant form alone
  // misses it - the self alternative is what lets `.studio { ... }` style the root.
  const scoped = scopeSheet(`.studio { background: red; }`, "Editor");
  assert.match(scoped, /\[data-dsx-owner="Editor"\] \.studio, \[data-dsx-owner="Editor"\]:is\(\.studio\)/);
});

test("compile: Launcher.dsx — computed variable + the attribute contract", (t) => {
  if (skipWithoutClosedSource(t)) return;
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

test("css: border shorthands map their token color term, per side (wave-7 F6)", () => {
  // the filed bug: these passed through unmapped, `separator` is no CSS color, and the
  // browser dropped the whole declaration — the art pass stacked 1px elements instead
  assert.equal(mapStyleValue("border-top", "1px solid separator"), "1px solid var(--dsx-separator)");
  assert.equal(mapStyleValue("border-bottom", "1px solid separator"), "1px solid var(--dsx-separator)");
  assert.equal(mapStyleValue("border", "2px dashed accent"), "2px dashed var(--dsx-accent)");
  assert.equal(mapStyleValue("border-left", "1px solid fill"), "1px solid var(--dsx-fill)");
  assert.equal(mapStyleValue("border-inline-start", "1px solid label"), "1px solid var(--dsx-label)");
  // longhand per-side colors ride the same vocabulary as border-color
  assert.equal(mapStyleValue("border-top-color", "separator"), "var(--dsx-separator)");
  assert.equal(mapStyleValue("border-block-end-color", "destructive"), "var(--dsx-destructive)");
  // function terms never split (their inner whitespace is not a term boundary) …
  assert.equal(
    mapStyleValue("border-top", "1px solid rgb(0 0 0 / 0.5)"),
    "1px solid rgb(0 0 0 / 0.5)",
  );
  // … and a shorthand with no token term passes through verbatim
  assert.equal(mapStyleValue("border-top", "1px  solid   #30D158"), "1px  solid   #30D158");
  // non-border properties never term-map (a bare word stays the author's problem)
  assert.equal(mapStyleValue("box-shadow", "0 0 1px separator"), "0 0 1px separator");
});

test("css: a compiled per-side border shorthand lands mapped in the inline layer (wave-7 F6)", () => {
  const ir = compileComponent("Ruled", "test",
    `<stack style="border-top: 1px solid separator; padding: 4px"><text value="One"/></stack>`,
  );
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const css = collector.emit();
  assert.match(css, /@layer dsx-inline/);
  assert.ok(css.includes("border-top: 1px solid var(--dsx-separator)"), "the token color term compiled to its custom property");
  assert.ok(!css.includes("solid separator"), "no unmapped token word survives into the sheet");
});

test("css: legacy attribute bridge", () => {
  assert.deepEqual(legacyAttrToDecls("radius", "16"), [["border-radius", "16px"]]);
  assert.deepEqual(legacyAttrToDecls("background", "fill"), [["background", "var(--dsx-fill)"]]);
  // grow is axis-aware: no declarations — it rides data-dsx-grow + parent-axis rules
  assert.deepEqual(legacyAttrToDecls("grow", "width"), []);
  // alignY anchors the vertical axis, axis-aware like the native flexFrame test:
  // a column's vertical is the MAIN axis (justify-content), a row's the CROSS
  // axis (align-items). Unknown words stay inert; align defers its own vertical
  // contribution whenever alignY is authored (vRaw = alignY ?? spillover).
  assert.deepEqual(legacyAttrToDecls("alignY", "center"), [["justify-content", "center"]]);
  assert.deepEqual(legacyAttrToDecls("alignY", "top"), [["justify-content", "start"]]);
  assert.deepEqual(legacyAttrToDecls("alignY", "bottom"), [["justify-content", "end"]]);
  assert.deepEqual(legacyAttrToDecls("alignY", "center", { flexDirection: "row" }), [["align-items", "center"]]);
  assert.deepEqual(legacyAttrToDecls("alignY", "sideways"), []);
  assert.deepEqual(
    legacyAttrToDecls("align", "center", { alignY: "top" }),
    [["align-items", "center"], ["justify-items", "center"]],
  );
  assert.deepEqual(
    legacyAttrToDecls("align", "center", { alignY: "top", flexDirection: "row" }),
    [["justify-items", "center"], ["justify-content", "center"]],
  );
  assert.deepEqual(legacyAttrToDecls("flexDirection", "row"), [["flex-direction", "row"]]);
  assert.deepEqual(legacyAttrToDecls("alignItems", "flex-end"), [["align-items", "flex-end"]]);
  assert.deepEqual(legacyAttrToDecls("display", "grid"), [["display", "grid"]]);
  assert.deepEqual(legacyAttrToDecls("display", "grid;position:fixed"), [], "layout enums fail closed");
  assert.equal(legacyAttrToDecls("bind", "x"), null);
});

// ABSENT IS NOT ZERO. `Number("")` is 0 and 0 is finite, so the fallback argument in the numeric
// reader was dead for every caller that wanted a non-zero default. Two live defects came out of
// it, and both were invisible to every gate in the repository: an element carrying `rotation`,
// `offsetX` or `offsetY` and no explicit scale folded to `scale(0)` and DISAPPEARED, and a bare
// `shadow=` sat at y 0 while iOS, Compose and Compose Desktop all default it to 2.
test("css: a family fold defaults to the shared value, not to zero", () => {
  const attrs = (o: Record<string, string>) => o;
  assert.deepEqual(legacyAttrToDecls("offsetX", "11", attrs({ offsetX: "11" })),
    [["transform", "translate(11px, 0px)"]], "an offset alone must not scale the element away");
  assert.deepEqual(legacyAttrToDecls("rotation", "15", attrs({ rotation: "15" })),
    [["transform", "rotate(15deg)"]]);
  assert.deepEqual(legacyAttrToDecls("scale", "1.5", attrs({ scale: "1.5" })),
    [["transform", "scale(1.5)"]]);
  assert.deepEqual(legacyAttrToDecls("shadow", "9", attrs({ shadow: "9" })),
    [["box-shadow", "0px 2px 9px rgba(0,0,0,0.25)"]], "shadowY defaults to 2 on every renderer");
  // A value that is present but not a number still takes the fallback, which is what kept
  // `borderWidth` correct while the other two were wrong.
  assert.deepEqual(legacyAttrToDecls("borderWidth", "hairline", attrs({ borderWidth: "hairline" })),
    [["border", "1px solid var(--dsx-separator)"]]);
});

// The glass pair is READ by the theme now, so it compiles to real custom properties rather than
// to a `-dsx-*` vendor spelling a browser drops. The press is a FACTOR, not the authored boolean,
// so the rule multiplies instead of branching - and it is opt-in on the exact word `true`, which
// is how all four renderers read it (Stack.swift #1002: defaulting it on leaked a stray platter).
test("css: the glass pair compiles to properties the renderer actually reads", () => {
  assert.deepEqual(legacyAttrToDecls("glassTint", "#f00"), [["--dsx-glass-tint", "#f00"]]);
  assert.deepEqual(legacyAttrToDecls("glassTint", "accent"), [["--dsx-glass-tint", "var(--dsx-accent)"]]);
  assert.deepEqual(legacyAttrToDecls("glassInteractive", "true"), [["--dsx-glass-interactive", "1"]]);
  assert.deepEqual(legacyAttrToDecls("glassInteractive", "false"), [["--dsx-glass-interactive", "0"]]);
  assert.deepEqual(legacyAttrToDecls("glassInteractive", "yes"), [["--dsx-glass-interactive", "0"]],
    "only `true` opts in, or this renderer and iOS disagree about the same markup");
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
  // descendant form + the :is() self form (the root-reachability fix) travel together
  assert.ok(scoped.includes(`[data-dsx-owner="Flex"] .card, [data-dsx-owner="Flex"]:is(.card) { padding: 1rem; }`));
  assert.ok(/@media \(min-width: 600px\) \{\s*\[data-dsx-owner="Flex"\] \.card/.test(scoped));
});

test("registry: Demo + Foundation build; resolution local → pool", (t) => {
  if (skipWithoutClosedSource(t)) return;
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
  // the pt-attribute plane is number-typed on every renderer now: a payload that is not a
  // plain number contributes NOTHING, which retires this injection class outright
  assert.deepEqual(legacyAttrToDecls("padding", "1;position:fixed"), [], "bridge attr: non-number maps to no declaration");
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

test("head: sample= is carried VERBATIM on the v1 kinds and hoisted off the api attrs (master plan P3)", () => {
  const ir = compileComponent("Samples", "t",
    `<stack>
       <head>
         <attribute as="title" sample='"Spring sale"'/>
         <event as="purchase" sample='{"sku":"pro","price":249}'/>
         <api as="orders" url="/api/orders" sample='[{"id":1}]'/>
         <variable as="count" sample="3">return 0</variable>
         <variable as="plain">return 1</variable>
       </head>
       <text value="{{ count }}"/>
     </stack>`);
  // verbatim carriage: JSON text, never parsed, never evaluated by the compiler
  assert.equal(ir.head.attributes[0]!.sample, '"Spring sale"');
  assert.equal(ir.head.events[0]!.sample, '{"sku":"pro","price":249}');
  assert.equal(ir.head.apis[0]!.sample, '[{"id":1}]');
  assert.equal(ir.head.variables[0]!.sample, "3");
  // a declaration without one carries no field at all — absence is absence
  assert.equal("sample" in ir.head.variables[1]!, false);
  // the api HOIST: the data layer's verbatim attrs must be unable to see the sample,
  // so "a failed api silently serves its sample" cannot be written downstream
  assert.equal("sample" in ir.head.apis[0]!.attrs, false);
  assert.equal(ir.head.apis[0]!.attrs["url"], "/api/orders");
});

test("head: sample= on formula/action is the RECORDED LEAK — it becomes an input binding today (deferred, P3)", () => {
  // The deferral fixture the master plan demands written WITH v1: on every head parser
  // an unknown formula/action attribute folds into the input bindings, so sample= there
  // is active runtime state. Lint refuses it (sample-deferred); this test PINS the leak
  // so the future fix — all four parsers learning the skip — has a red-to-green proof.
  const ir = compileComponent("Leak", "t",
    `<stack>
       <head>
         <formula as="total" rows="{{ orders }}" sample="12">return rows.length</formula>
       </head>
       <text value="x"/>
     </stack>`);
  assert.equal(ir.head.formulas[0]!.inputs["sample"], "12",
    "the leak is gone — sample no longer folds into formula inputs. Flip this test: assert absence, promote formula/action samples per plan P3, and retire the lint deferral");
});

test("head: the global attribute routes by PRESENCE — the bare spelling parses here too", () => {
  // canonical is global="true" (Apple's XMLParser rejects bare attributes); this parser
  // accepts the bare form, and presence — not value — is the router.
  const ir = compileComponent("FnsBare", "t",
    `<stack><head><functions global>function g() { return 1 }</functions></head><text value="x"/></stack>`);
  assert.equal(ir.head.globalScripts.length, 1);
  assert.equal(ir.head.scripts.length, 0);
});
