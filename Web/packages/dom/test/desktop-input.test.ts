//
//  desktop-input.test.ts — the shared shortcut= / focusOrder= grammar
//  (desktop-platforms.md). matchShortcut / resolveFocusOrder are the pure twins of
//  Swift/Kotlin StackDesktopInput; here they run the renderer-neutral corpus that all
//  three runtimes execute, so the web can never drift from the native accelerators.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  matchShortcut, resolveFocusOrder, multilineReturn, RETURN_KEYS,
  type ShortcutKeyEvent, type MultilineReturn,
} from "../src/mount.ts";

type ShortcutCase = { name: string; shortcut: string; event: ShortcutKeyEvent; fires: boolean };
const shortcutCorpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/shortcut.json", import.meta.url), "utf8",
)) as { version: number; cases: ShortcutCase[] };

type FocusOrderCase = { name: string; focusOrder: string | null; disabled: boolean; index: number | null };
const focusOrderCorpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/focusOrder.json", import.meta.url), "utf8",
)) as { version: number; cases: FocusOrderCase[] };

type MultilineCase = {
  name: string;
  event: { key: string; shift: boolean; meta: boolean; ctrl: boolean; alt: boolean };
  submitOnEnter: boolean; hasSubmit: boolean; expect: MultilineReturn;
};
const multilineCorpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/multiline-submit.json", import.meta.url), "utf8",
)) as { version: number; returnKeys: string[]; cases: MultilineCase[] };

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

test("what Return does in a multiline field agrees with the shared corpus", () => {
  assert.equal(multilineCorpus.version, 1);
  assert.deepEqual([...RETURN_KEYS].sort(), [...multilineCorpus.returnKeys].sort(),
    "the Return spellings are a shared fact, not a per-toolkit guess");
  for (const c of multilineCorpus.cases) {
    assert.equal(multilineReturn(c.event, c.submitOnEnter, c.hasSubmit), c.expect, c.name);
  }
});

// The rule a corpus row cannot state, because it is about the SHAPE of the answer: `ignore` and
// `newline` are different, and a caller that treats them as one eats keystrokes it was never
// asked about. With nothing bound, no combination can ever reach `submit`.
test("nothing can be submitted into a handler that does not exist", () => {
  for (const key of RETURN_KEYS) {
    for (const shift of [false, true]) {
      for (const meta of [false, true]) {
        for (const ctrl of [false, true]) {
          for (const alt of [false, true]) {
            for (const submitOnEnter of [false, true]) {
              const got = multilineReturn({ key, shift, meta, ctrl, alt }, submitOnEnter, false);
              assert.notEqual(got, "submit",
                `${key} shift=${shift} meta=${meta} ctrl=${ctrl} alt=${alt} reached submit ` +
                "with no handler bound");
            }
          }
        }
      }
    }
  }
});
