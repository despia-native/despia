import { test } from "node:test";
import assert from "node:assert/strict";

import { ELEMENTS } from "../src/elements.ts";
import {
  APPLICATION_CONTROL_ELEMENTS,
  APPLICATION_CONTROL_LIMITS,
  APPLICATION_CONTROL_TAGS,
  APPLICATION_CONTROLS_CSS,
  normalizeMenuBarEnabledIndex,
  normalizeMenuBarIndex,
  normalizeMenuBarItems,
  registerApplicationControls,
} from "../src/application-controls.ts";

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
  assert.ok(APPLICATION_CONTROLS_CSS.includes("24px"), "Drawer radius follows the fixture");
  assert.ok(APPLICATION_CONTROLS_CSS.includes("@media (min-width: 48rem)"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("(pointer: fine)"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("prefers-reduced-motion: reduce"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("forced-colors: active"));
  assert.ok(APPLICATION_CONTROLS_CSS.includes("env(safe-area-inset-bottom)"));
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
