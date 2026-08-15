//
//  present.test.ts — the presentation machine's pure half (present.ts PresentLedger),
//  pinned by the SHARED corpus OpenSource/Conformance/router/present.json: `as`/`touch`
//  normalization + the dismissal topology. The Kotlin RouterTest drives the same file
//  through a real Router; Router.swift is the compile-pending reference. The DOM half
//  (the overlay plane, tier z-indices, the pointer-events touch modes) rides theme.ts +
//  router.ts and is exercised by build:demo.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PresentLedger } from "../src/present.ts";

type Dict = { [k: string]: unknown };
type Step = {
  present?: { component?: string; as?: string; touch?: string; attrs?: Dict };
  update?: { target?: string; attrs?: Dict };
  dismiss?: { target?: string };
};
type Case = { name: string; steps: Step[]; modal: Array<{ as: string; component: string; touch?: string; attrs?: Dict }> };
const corpus = JSON.parse(
  readFileSync(new URL("../../../../Conformance/router/present.json", import.meta.url), "utf8"),
) as { cases: Case[] };

test("the shared present corpus runs and is non-trivial", () => {
  assert.ok(corpus.cases.length >= 8, `expected a populated corpus, got ${corpus.cases.length}`);
});

for (const c of corpus.cases) {
  test(`present corpus: ${c.name}`, () => {
    const ledger = new PresentLedger();
    for (const step of c.steps) {
      if (step.present !== undefined) {
        ledger.add(step.present.component ?? "", step.present.as, step.present.touch, step.present.attrs);
      }
      if (step.update !== undefined) {
        ledger.updateAttrs(step.update.target ?? null, step.update.attrs ?? {});
      }
      if (step.dismiss !== undefined) {
        ledger.remove(step.dismiss.target ?? null);
      }
    }
    assert.deepEqual(
      ledger.list().map((e) => ({
        as: e.as,
        component: e.component,
        ...(e.touch !== undefined ? { touch: e.touch } : {}),
        ...(e.attrs !== undefined ? { attrs: e.attrs } : {}),
      })),
      c.modal,
    );
  });
}

test("scheme-qualified names still match a bare dismissal target (the web qualifier shim)", () => {
  const ledger = new PresentLedger();
  ledger.add("menubar.Sidebar", "cover", undefined);
  assert.equal(ledger.remove("Sidebar").length, 1);
  assert.equal(ledger.list().length, 0);
});
