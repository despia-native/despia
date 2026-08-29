//
//  component-head-api.test.ts - does an `<api>` declared in a COMPONENT's head fire when
//  that component mounts?
//
//  WHY THIS EXISTS. The Swift side carries a check for exactly this claim
//  (ClosedSource/scripts/conformance/RecordMain.swift, ComponentApiMountCheck) whose comment
//  records what it guards: "an <api> inside a component rendered as EmptyView() and issued NO
//  REQUEST - and because nothing was malformed, nothing logged and the reserved envelope paths
//  were never seeded, the only symptom was `loading` reading back EMPTY instead of `false`.
//  Every static gate in this repository passed. An app entry screen IS a component, so this
//  was every screen that fetched its own data."
//
//  That check has never been able to run: it lives in a binary the record lane `simctl spawn`s,
//  where SwiftUI runs no layout pass. So the claim was untested on iOS. It was ALSO untested
//  here - the web api suites are kernel-level (ApiBlock directly) and the component suites
//  never declare an <api>. Article 10 says one feature ships on every renderer; this is the
//  web column of that row, so the question can be answered on one renderer before the others.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects, RunnerFetchSeam } from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
import type { Registry } from "@despia-native/compiler/resolve";
import { compileComponent } from "@despia-native/compiler/component";
import { mountNode, type MountCtx } from "../src/mount.ts";
import { registerRichElements } from "../src/elements.ts";
import { FakeElement } from "./fake-dom.ts";

registerRichElements();

/** Every url the runtime actually asked for. The claim is that the request LEAVES. */
function seam(): string[] {
  const urls: string[] = [];
  RunnerFetchSeam.impl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, data: { rows: [] } };
  };
  return urls;
}

function harness(components: { [name: string]: string }): {
  root: FakeElement; store: ReactiveStore; mount: (node: XmlNode) => void;
} {
  const store = new ReactiveStore();
  const env = makeRunEnv(store);
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: ["t"] };
  for (const [name, source] of Object.entries(components)) {
    registry.components[`t.${name}`] = compileComponent(name, "t", source);
  }
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const root = new FakeElement("div");
  return { root, store, mount: (n) => mountNode(n, ctx, root as unknown as ParentNode) };
}

test("an <api> in a component's head fires when the component mounts", async () => {
  const urls = seam();
  try {
    const h = harness({
      NotesPane: `<stack>
        <head><api as="paneNotes" url="https://api.test/pane"/></head>
        <text value="{{ paneNotes.loading }}"/>
      </stack>`,
    });
    h.mount({ tag: "NotesPane", attrs: {}, children: [], text: "" });
    flushEffects();
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(urls.includes("https://api.test/pane"),
      `the component's own <api> never fired; urls = ${JSON.stringify(urls)}`);
    assert.equal(urls.filter((u) => u === "https://api.test/pane").length, 1,
      "the component <api> was mounted more than once");
  } finally { RunnerFetchSeam.impl = null; }
});

test("the reserved envelope paths are seeded, so `loading` reads false rather than absent", () => {
  const urls = seam();
  try {
    const h = harness({
      NotesPane: `<stack>
        <head><api as="paneNotes" url="https://api.test/pane"/></head>
        <text value="{{ paneNotes.loading }}"/>
      </stack>`,
    });
    h.mount({ tag: "NotesPane", attrs: {}, children: [], text: "" });
    flushEffects();
    // An UNMOUNTED block leaves the envelope absent; a mounted one seeds it. That
    // distinction is the whole symptom the Swift check describes.
    assert.notEqual(h.store.eval("paneNotes.loading"), undefined,
      "paneNotes.loading was never seeded - the block did not mount");
    void urls;
  } finally { RunnerFetchSeam.impl = null; }
});
