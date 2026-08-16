//
//  desktop-input.test.ts — the shared shortcut= / focusOrder= grammar
//  (desktop-platforms.md). matchShortcut / resolveFocusOrder are the pure twins of
//  Swift/Kotlin StackDesktopInput; here they run the renderer-neutral corpus that all
//  three runtimes execute, so the web can never drift from the native accelerators.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { matchShortcut, resolveFocusOrder, type ShortcutKeyEvent } from "../src/mount.ts";

type ShortcutCase = { name: string; shortcut: string; event: ShortcutKeyEvent; fires: boolean };
const shortcutCorpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/shortcut.json", import.meta.url), "utf8",
)) as { version: number; cases: ShortcutCase[] };

type FocusOrderCase = { name: string; focusOrder: string | null; disabled: boolean; index: number | null };
const focusOrderCorpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/focusOrder.json", import.meta.url), "utf8",
)) as { version: number; cases: FocusOrderCase[] };

test("shortcut accelerator matching agrees with the shared corpus", () => {
  assert.equal(shortcutCorpus.version, 1);
  for (const testCase of shortcutCorpus.cases) {
    assert.equal(matchShortcut(testCase.shortcut, testCase.event), testCase.fires, testCase.name);
  }
});

test("focusOrder traversal resolution agrees with the shared corpus", () => {
  assert.equal(focusOrderCorpus.version, 1);
  for (const testCase of focusOrderCorpus.cases) {
    assert.equal(resolveFocusOrder(testCase.focusOrder, testCase.disabled), testCase.index, testCase.name);
  }
});
