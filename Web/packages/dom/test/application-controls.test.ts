import { test } from "node:test";
import assert from "node:assert/strict";

import { ELEMENTS } from "../src/elements.ts";
import {
  APPLICATION_CONTROL_ELEMENTS,
  APPLICATION_CONTROL_LIMITS,
  APPLICATION_CONTROL_TAGS,
  APPLICATION_CONTROLS_CSS,
  APPLICATION_WIDE_MEDIA,
  DRAWER_STANDING,
  normalizeMenuBarEnabledIndex,
  normalizeMenuBarIndex,
  normalizeMenuBarItems,
  registerApplicationControls,
} from "../src/application-controls.ts";
import { TABS_WIDE_MEDIA } from "../src/structural-controls.ts";
import { OVERLAY_LIMITS } from "../src/overlay-controls.ts";

type Rgb = readonly [number, number, number];

function mix(foreground: Rgb, background: Rgb, amount: number): Rgb {
  return foreground.map((channel, index) =>
    (channel * amount) + (background[index]! * (1 - amount))
  ) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]!) + (0.7152 * channels[1]!) + (0.0722 * channels[2]!);
}

function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("application controls are optional and register both canonical tags", () => {
  for (const tag of APPLICATION_CONTROL_TAGS) assert.equal(ELEMENTS[tag], undefined, `${tag} starts sliced out`);
  registerApplicationControls();
  for (const tag of APPLICATION_CONTROL_TAGS) assert.equal(ELEMENTS[tag], APPLICATION_CONTROL_ELEMENTS[tag], tag);
});

test("MenuBar remote items are bounded, keyed and safe to emit", () => {
  const cyclic: Record<string, unknown> = { id: "same", name: "One", icon: "star" };
  cyclic.self = cyclic;
  const source = [cyclic, { id: "same", name: "Two", sf_symbol: "gear", disabled: true }];
  source.push(...Array.from({ length: APPLICATION_CONTROL_LIMITS.menuItems + 4 }, (_, index) => ({
    id: `id-${index}`,
    name: "x".repeat(APPLICATION_CONTROL_LIMITS.textCharacters + 30),
  })));
  const items = normalizeMenuBarItems(source);
  assert.equal(items.length, APPLICATION_CONTROL_LIMITS.menuItems);
  assert.equal(items[0]!.key, "same:0");
  assert.equal(items[1]!.key, "same:1", "duplicate ids never alias keyed DOM");
  assert.equal(items[1]!.icon, "gear");
  assert.equal(items[1]!.disabled, true);
  assert.equal(items[0]!.payload["self"], null, "cyclic payload fields terminate");
  assert.equal(items[0]!.payload["index"], 0);
  assert.ok(Array.from(items[2]!.name).length <= APPLICATION_CONTROL_LIMITS.textCharacters);
});

test("MenuBar hostile payloads share one render budget and never invoke accessors", () => {
  let getterCalls = 0;
  let coercionCalls = 0;
  const coercionBomb = { [Symbol.toPrimitive]() { coercionCalls += 1; throw new Error("coercion"); } };
  const revoked = Proxy.revocable({}, {});
  const source = Array.from({ length: APPLICATION_CONTROL_LIMITS.menuItems }, (_, index) => {
    const row: Record<string, unknown> = {
      id: index === 0 ? coercionBomb : `row-${index}`,
      name: index === 0 ? coercionBomb : `Row ${index}`,
      revoked: index === 0 ? revoked.proxy : null,
    };
    Object.defineProperty(row, "danger", {
      enumerable: true,
      get() { getterCalls += 1; return "not safe"; },
    });
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < APPLICATION_CONTROL_LIMITS.payloadDepth + 3; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor["next"] = next;
      cursor = next;
    }
    cursor["cycle"] = deep;
    row["deep"] = deep;
    for (let field = 0; field < APPLICATION_CONTROL_LIMITS.payloadFields * 3; field += 1) {
      row[`field-${field}`] = field;
    }
    return row;
  });
  revoked.revoke();
  const items = normalizeMenuBarItems(source);
  const countNodes = (value: unknown, seen = new WeakSet<object>()): number => {
    if (value === null || typeof value !== "object") return 1;
    if (seen.has(value)) return 0;
    seen.add(value);
    return 1 + Object.values(value).reduce((sum, entry) => sum + countNodes(entry, seen), 0);
  };
  const payloadNodes = items.reduce((sum, item) => sum + countNodes(item.payload), 0);
  assert.equal(getterCalls, 0);
  assert.equal(coercionCalls, 0);
  assert.equal(items[0]!.id, "0", "non-primitive ids fail closed without coercion");
  assert.equal(items[0]!.payload["revoked"], null, "revoked nested proxies fail closed per row");
  for (const item of items) {
    assert.ok(
      Object.keys(item.payload).length <= APPLICATION_CONTROL_LIMITS.payloadFields + 4,
      "each payload container keeps its local field ceiling plus canonical metadata",
    );
  }
  assert.ok(
    payloadNodes <= APPLICATION_CONTROL_LIMITS.payloadWork + (APPLICATION_CONTROL_LIMITS.menuItems * 5),
    `payload work stays globally bounded (${payloadNodes})`,
  );
});

test("MenuBar indices normalize finite integer selection deterministically", () => {
  assert.equal(normalizeMenuBarIndex(2.9, 5), 2);
  assert.equal(normalizeMenuBarIndex(-4, 5), 0);
  assert.equal(normalizeMenuBarIndex(99, 5), 4);
  assert.equal(normalizeMenuBarIndex(Number.NaN, 5, 3), 3);
  assert.equal(normalizeMenuBarIndex(2, 0), 0);
});

test("MenuBar enabled selection scans deterministically and represents all-disabled", () => {
  const items = [{ disabled: true }, { disabled: false }, { disabled: true }];
  assert.equal(normalizeMenuBarEnabledIndex(items, 0), 1);
  assert.equal(normalizeMenuBarEnabledIndex(items, 2, 0, -1), 1);
  assert.equal(normalizeMenuBarEnabledIndex([{ disabled: true }, { disabled: true }], 0), null);
  assert.equal(normalizeMenuBarEnabledIndex([], 0), null);
});

test("application chrome defaults preserve fixture geometry and adaptive accessibility modes", () => {
  assert.ok(APPLICATION_CONTROLS_CSS.startsWith("@layer dsx-elements {"));
  assert.ok(!APPLICATION_CONTROLS_CSS.includes("!important"));
  assert.ok(!/#(?:fff(?:fff)?|18181a)\b/i.test(APPLICATION_CONTROLS_CSS), "defaults use semantic/weak tokens");
  assert.ok(APPLICATION_CONTROLS_CSS.includes("--dsx-menu-bar-light-surface"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("width: 36px"), "Drawer handle width follows the fixture");
  assert.ok(APPLICATION_CONTROLS_CSS.includes("height: 5px"), "Drawer handle height follows the fixture");
  assert.ok(APPLICATION_CONTROLS_CSS.includes("height: 44px"), "Drawer drag target remains touch accessible");
  // The drawer's radius was 24px against the sheet's 20px while both are the same
  // thing - a surface that meets a screen edge. The shape corpus ratified one rung for
  // that band, so the drawer follows it and the fixture's 24 is retired.
  assert.ok(APPLICATION_CONTROLS_CSS.includes("var(--dsx-drawer-radius, var(--dsx-radius-sheet))"),
    "Drawer radius is the sheet rung, with the drawer's own override still ahead of it");
  assert.ok(!/border-radius:[^;]*\b\d+px/.test(APPLICATION_CONTROLS_CSS.replace(/border-radius: var\(--dsx-radius-full\)/g, "")),
    "no drawer corner re-decides a radius in pixels");
  assert.ok(APPLICATION_CONTROLS_CSS.includes("@media (min-width: 48rem)"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("(pointer: fine)"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("prefers-reduced-motion: reduce"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("forced-colors: active"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("env(safe-area-inset-bottom)"));
});

test("the application desktop step composes the tabs breakpoint, never a fork of it", () => {
  assert.ok(APPLICATION_WIDE_MEDIA.startsWith(TABS_WIDE_MEDIA),
    "the standing drawer / menubar step reuses TABS_WIDE_MEDIA verbatim");
  assert.ok(APPLICATION_WIDE_MEDIA.includes("(hover: hover)") && APPLICATION_WIDE_MEDIA.includes("(pointer: fine)"),
    "the wide presentations are desktop-input idioms, so coarse tablets keep the compact chrome");
  assert.equal((APPLICATION_WIDE_MEDIA.match(/min-width/g) ?? []).length, 1, "one breakpoint, one source");
});

test("standing drawer geometry contract is ordered and mirrored into the weak CSS", () => {
  assert.ok(DRAWER_STANDING.minWidth < DRAWER_STANDING.defaultWidth, "min < default");
  assert.ok(DRAWER_STANDING.defaultWidth < DRAWER_STANDING.maxWidth, "default < max");
  assert.ok(DRAWER_STANDING.railWidth > 44, "the rail still holds a 44px-class control");
  assert.ok(DRAWER_STANDING.keyboardStep > 0);
  assert.ok(
    APPLICATION_CONTROLS_CSS.includes(`var(--dsx-drawer-standing-width, ${DRAWER_STANDING.defaultWidth}px)`),
    "CSS default width literal follows DRAWER_STANDING.defaultWidth",
  );
  assert.ok(
    APPLICATION_CONTROLS_CSS.includes(`[data-dsx-collapsed="true"] { width: ${DRAWER_STANDING.railWidth}px; }`),
    "CSS rail width literal follows DRAWER_STANDING.railWidth",
  );
});

test("standing and bar presentations are attribute-keyed twins of the compact chrome", () => {
  assert.ok(APPLICATION_CONTROLS_CSS.includes('.dsx-drawer-host[data-dsx-presentation="standing"]'));
  assert.ok(APPLICATION_CONTROLS_CSS.includes('.dsx-drawer-layer[data-dsx-presentation="standing"]'));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("position: static"), "standing layer leaves the fixed overlay plane");
  assert.ok(APPLICATION_CONTROLS_CSS.includes("border-inline-end: var(--dsx-hairline) solid var(--dsx-separator)"),
    "standing panel mirrors the tabs sidebar rail's flat separator treatment");
  assert.ok(APPLICATION_CONTROLS_CSS.includes("var(--dsx-secondary-background)"),
    "standing panel is the flat premium sidebar surface, not glass");
  assert.ok(APPLICATION_CONTROLS_CSS.includes('.dsx-menu-bar[data-dsx-presentation="bar"]'));
  const bar = APPLICATION_CONTROLS_CSS.match(/\.dsx-menu-bar\[data-dsx-presentation="bar"\] \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(bar.includes("color-scheme: normal") && bar.includes("color: var(--dsx-label)")
    && bar.includes("var(--dsx-background)"),
    "the bar strip is app chrome on ambient tokens; the authored dark= tone stays a dock-only knob");
  assert.ok(APPLICATION_CONTROLS_CSS.indexOf('[data-dsx-presentation="bar"] {')
    > APPLICATION_CONTROLS_CSS.indexOf('[data-dsx-tone="dark"]'),
    "the bar override outranks the equal-specificity tone rules by order");
  assert.ok(APPLICATION_CONTROLS_CSS.includes(".dsx-drawer-resizer"), "the drag hairline exists");
  assert.ok(APPLICATION_CONTROLS_CSS.includes(".dsx-drawer-collapse"), "the rail control exists");
  assert.ok(
    APPLICATION_CONTROLS_CSS.includes(".dsx-drawer-content[hidden]"),
    "hidden overrides beat the content's display: grid",
  );
});

test("MenuBar roots carry their nested flyout items through the shared overlay grammar", () => {
  const items = normalizeMenuBarItems([
    {
      id: "file",
      name: "File",
      items: [
        { title: "New", shortcut: "cmd+n", action: "workspace.new" },
        { separator: true },
        { title: "Share", items: [{ title: "Copy link" }] },
      ],
    },
    { id: "home", name: "Home", icon: "star" },
    { id: "bare", name: "Bare", icon: "" },
  ]);
  assert.equal(items[0]!.items.length, 3);
  assert.equal(items[0]!.items[0]!.shortcut, "cmd+n");
  assert.equal(items[0]!.items[0]!.action, "workspace.new");
  assert.equal(items[0]!.items[2]!.items[0]!.title, "Copy link");
  assert.equal(items[0]!.iconDeclared, false, "a defaulted icon is not a declared icon");
  assert.equal(items[0]!.icon, "circle", "the compact dock keeps its glyph fallback");
  assert.equal(items[1]!.iconDeclared, true);
  assert.equal(items[2]!.iconDeclared, false, "an empty authored icon is not declared");
  const hostile = normalizeMenuBarItems([{
    id: "deep",
    name: "Deep",
    items: Array.from({ length: OVERLAY_LIMITS.maxItems + 50 }, (_, index) => ({ title: `x${index}` })),
  }]);
  assert.equal(hostile[0]!.items.length, OVERLAY_LIMITS.maxItems, "each root's flyout keeps the overlay item ledger");
});

test("MenuBar unselected small labels retain normal-text contrast in both schemes", () => {
  const opacity = Number(
    APPLICATION_CONTROLS_CSS.match(/\.dsx-menu-bar-item\s*\{[\s\S]*?currentColor\s+(\d+)%/i)?.[1] ?? "0",
  ) / 100;
  assert.ok(opacity > 0 && opacity <= 1, "unselected label mix is present");

  const schemes: ReadonlyArray<Readonly<{ label: Rgb; background: Rgb }>> = [
    { label: [23, 23, 27], background: [255, 255, 255] },
    { label: [244, 244, 245], background: [16, 16, 18] },
  ];
  for (const { label, background } of schemes) {
    const menuSurface = mix(label, background, 0.94);
    const unselectedLabel = mix(background, menuSurface, opacity);
    assert.ok(
      contrast(unselectedLabel, menuSurface) >= 4.5,
      `unselected MenuBar label clears 4.5:1 at ${Math.round(opacity * 100)}%`,
    );
  }
});
