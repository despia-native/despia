import { test } from "node:test";
import assert from "node:assert/strict";

import { ELEMENTS } from "../src/elements.ts";
import {
  OVERLAY_CONTROL_ELEMENTS,
  OVERLAY_CONTROL_TAGS,
  OVERLAY_CONTROLS_CSS,
  OVERLAY_LIMITS,
  CONTEXT_MENU_PRESS,
  formatShortcutHint,
  normalizeOverlayItems,
  normalizeSheetBackground,
  normalizeSheetDetents,
  placeFloating,
  registerOverlayControls,
  shortcutAriaValue,
} from "../src/overlay-controls.ts";

test("overlay controls register only through their optional feature gate", () => {
  for (const tag of OVERLAY_CONTROL_TAGS) assert.equal(ELEMENTS[tag], undefined, `${tag} starts sliced out`);
  registerOverlayControls();
  for (const tag of OVERLAY_CONTROL_TAGS) assert.equal(ELEMENTS[tag], OVERLAY_CONTROL_ELEMENTS[tag], tag);
});

test("overlay item normalization bounds total work, recursion, text, actions and args", () => {
  const cyclic: Record<string, unknown> = { title: "parent" };
  cyclic.items = [cyclic];
  const hostile = Array.from({ length: OVERLAY_LIMITS.maxItems + 40 }, (_, index) => ({
    title: `${"x".repeat(OVERLAY_LIMITS.maxTextCharacters + 100)}-${index}`,
    icon: "star",
    action: index === 0 ? "studio.deleteClip" : "not valid()",
    args: Object.fromEntries(Array.from({ length: OVERLAY_LIMITS.maxArgumentEntries + 20 }, (_entry, i) => [`k${i}`, i])),
    items: index === 0 ? [cyclic] : [],
  }));
  const normalized = normalizeOverlayItems(hostile);
  const total = (items: readonly typeof normalized[number][]): number =>
    items.reduce((count, item) => count + 1 + total(item.items), 0);
  assert.equal(total(normalized), OVERLAY_LIMITS.maxItems);
  assert.equal(Array.from(normalized[0]!.title).length, OVERLAY_LIMITS.maxTextCharacters);
  assert.equal(normalized[0]!.action, "studio.deleteClip");
  assert.equal(normalized[1]!.action, "");
  assert.ok(Object.keys(normalized[0]!.args).length <= OVERLAY_LIMITS.maxArgumentEntries);
  assert.equal(normalized[0]!.items[0]!.items.length, 0, "cycles terminate instead of recursing");
});

test("dialog CSV resilience and sheet detents normalize deterministically", () => {
  assert.deepEqual(normalizeOverlayItems("Save,Cancel").map((item) => item.title), ["Save", "Cancel"]);
  assert.deepEqual(normalizeSheetDetents("content,half,half,full,bogus"), ["content", "half", "full"]);
  assert.deepEqual(normalizeSheetDetents("bogus"), ["half", "full"]);
  assert.deepEqual(normalizeSheetDetents(""), ["half", "full"]);
  assert.equal(normalizeSheetBackground("groupedBackground"), "var(--dsx-grouped-background)");
  assert.equal(normalizeSheetBackground("system"), null);
  assert.equal(normalizeSheetBackground("#80ff0000"), "rgb(255 0 0 / 0.5020)", "eight digit DSX colors are AARRGGBB");
  assert.equal(normalizeSheetBackground("red; position: fixed"), "var(--dsx-background)", "CSS declarations cannot escape the color slot");
});

test("floating placement flips at viewport edges and mirrors leading/trailing in RTL", () => {
  const viewport = { width: 320, height: 640 };
  const panel = { width: 120, height: 100 };
  const bottomAnchor = { left: 250, right: 290, top: 590, bottom: 630, width: 40, height: 40 };
  const flipped = placeFloating(bottomAnchor, panel, viewport, "top", false);
  assert.equal(flipped.placement, "top");
  assert.ok(flipped.x <= 192, "horizontal position is clamped inside the viewport margin");
  assert.ok(flipped.y >= 8);

  const middle = { left: 140, right: 180, top: 260, bottom: 300, width: 40, height: 40 };
  const narrowPanel = { width: 80, height: 100 };
  assert.equal(placeFloating(middle, narrowPanel, viewport, "leading", false).placement, "right");
  assert.equal(placeFloating(middle, narrowPanel, viewport, "leading", true).placement, "left");
});

test("overlay defaults are weak, adaptive and accessibility-mode aware", () => {
  assert.ok(OVERLAY_CONTROLS_CSS.startsWith("@layer dsx-elements {"));
  assert.ok(!OVERLAY_CONTROLS_CSS.includes("!important"));
  for (const selector of [
    ".dsx-sheet-panel", ".dsx-alert-panel", ".dsx-confirm-panel", ".dsx-popover-panel", ".dsx-menu-panel",
  ]) assert.ok(OVERLAY_CONTROLS_CSS.includes(selector), selector);
  assert.ok(OVERLAY_CONTROLS_CSS.includes("@media (min-width: 48rem)"));
  assert.ok(OVERLAY_CONTROLS_CSS.includes("(pointer: fine)"));
  assert.ok(OVERLAY_CONTROLS_CSS.includes("prefers-reduced-motion: reduce"));
  assert.ok(OVERLAY_CONTROLS_CSS.includes("forced-colors: active"));
  assert.ok(OVERLAY_CONTROLS_CSS.includes('[dir="rtl"]'));
  assert.ok(OVERLAY_CONTROLS_CSS.includes("--dsx-overlay-z-index, 10000"), "overlays clear the 9000 route-chrome plane by default");
  assert.ok(OVERLAY_CONTROLS_CSS.includes(".dsx-overlay-portal-scope { display: contents; }"));
});

test("menu item shortcut hints ride the shortcut= token grammar per platform family", () => {
  assert.equal(formatShortcutHint("cmd+s", true), "⌘S");
  assert.equal(formatShortcutHint("cmd+s", false), "Ctrl+S");
  assert.equal(formatShortcutHint("  CMD +  Shift + p ", true), "⇧⌘P", "normalization and canonical modifier order");
  assert.equal(formatShortcutHint("shift+ctrl+k", false), "Ctrl+Shift+K", "canonical order regardless of authoring order");
  assert.equal(formatShortcutHint("cmd+ctrl+d", false), "Ctrl+D", "cmd and ctrl collapse to one Ctrl off-Apple");
  assert.equal(formatShortcutHint("cmd+ctrl+d", true), "⌃⌘D");
  assert.equal(formatShortcutHint("alt+enter", false), "Alt+Enter");
  assert.equal(formatShortcutHint("escape", true), "⎋");
  assert.equal(formatShortcutHint("cmd+arrowup", false), "Ctrl+↑");
  assert.equal(formatShortcutHint("cmd+", true), "", "a modifier with no key renders nothing");
  assert.equal(formatShortcutHint("", true), "");
  assert.equal(shortcutAriaValue("cmd+s", true), "Meta+S", "aria-keyshortcuts names the real primary modifier");
  assert.equal(shortcutAriaValue("cmd+s", false), "Control+S");
  assert.equal(shortcutAriaValue("ctrl+shift+arrowdown", false), "Control+Shift+ArrowDown");
  assert.equal(shortcutAriaValue("bogus+x", false), "X", "unknown tokens never mint fake modifiers");
});

test("overlay items carry a bounded shortcut for the menu hint plane", () => {
  const items = normalizeOverlayItems([
    { title: "Save", shortcut: " cmd+s " },
    { title: "Plain" },
    { title: "Hostile", shortcut: "x".repeat(OVERLAY_LIMITS.maxTextCharacters + 90) },
  ]);
  assert.equal(items[0]!.shortcut, "cmd+s");
  assert.equal(items[1]!.shortcut, "");
  assert.ok(Array.from(items[2]!.shortcut).length <= OVERLAY_LIMITS.maxTextCharacters);
  assert.ok(OVERLAY_CONTROLS_CSS.includes(".dsx-menu-item-shortcut"), "the right-aligned hint style exists");
});

test("submenu flyouts ride the elevation and motion standard and collapse for reduced motion", () => {
  const submenu = OVERLAY_CONTROLS_CSS.match(/\.dsx-submenu \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(submenu.includes("var(--dsx-shadow-3)"), "submenu sits at shadow-3");
  assert.ok(submenu.includes("dsx-float-zoom") && submenu.includes("dsx-overlay-fade"),
    "submenu shares the floating motion standard");
  assert.ok(OVERLAY_CONTROLS_CSS.includes('.dsx-submenu[data-dsx-placement="right"] { transform-origin: 0 12px; }'),
    "the zoom grows out of the parent row edge");
  const reduced = OVERLAY_CONTROLS_CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(reduced.includes(".dsx-submenu"), "reduced motion stills the submenu flyout");
});

test("<contextmenu> long-press timing is the DECLARED platform norm, not a magic number", () => {
  // UILongPressGestureRecognizer's default minimumPressDuration is 0.5 s, and
  // ContextMenu.swift rides SwiftUI's `.contextMenu` on exactly that recognizer. The
  // browser twin matches it deliberately; a drift here is a parity change, not a tweak.
  assert.equal(CONTEXT_MENU_PRESS.durationMs, 500);
  assert.equal(CONTEXT_MENU_PRESS.slopPx, 10);
  assert.equal(OVERLAY_CONTROL_ELEMENTS["contextmenu"] !== OVERLAY_CONTROL_ELEMENTS["menu"], true,
    "contextmenu is the long-press variant of the same overlay factory, never an alias");
});
