//
//  strings-live.test.ts — the WEB-ONLY half of the localization tier: reactivity.
//  The dom layer's bindDisplay wraps a display string in a store effect that calls
//  DSXStrings.localize, and the DEFAULT statePath reads the app-wide store through
//  the tracked door - so a locale switch (one state write, localization.md) re-fires
//  every live display binding, static markup included. This test drives exactly that
//  shipped path: default seams, a real ReactiveStore attached to DSXState.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, DSXState, flushEffects } from "../src/store.ts";
import { DSXStrings } from "../src/strings.ts";

test("a locale write re-fires a display effect through the default seams", () => {
  const store = new ReactiveStore();
  DSXState.attach(store);
  const previous = { loader: DSXStrings.loader, deviceLang: DSXStrings.deviceLang };
  DSXStrings.reset();
  DSXStrings.loader = (lang) => (lang === "de" ? '{"Save":"Sichern"}' : null);
  DSXStrings.deviceLang = "en-us";
  const seen: string[] = [];
  const dispose = store.effect(() => DSXStrings.localize("Save"), (v) => seen.push(v));
  try {
    assert.deepEqual(seen, ["Save"], "the source language renders first, byte-for-byte");

    // the in-app language switcher IS one state write - the effect re-fires by itself
    DSXState.set("locale", "de");
    flushEffects();
    assert.deepEqual(seen, ["Save", "Sichern"], "the locale write re-resolved the static string");

    // a runtime-table write becomes visible with the version bump, live
    DSXState.batch(() => {
      DSXState.set("strings.de", { Save: "Speichern" });
      DSXState.set("strings.version", "2");
    });
    flushEffects();
    assert.equal(seen[seen.length - 1], "Speichern", "the runtime tier landed over the bundle, live");

    // and back to the source language - identity again
    DSXState.set("locale", "en");
    flushEffects();
    assert.equal(seen[seen.length - 1], "Save");
  } finally {
    dispose();
    DSXState.detach(store);
    DSXState.set("locale", "");
    DSXState.set("strings", {});
    DSXStrings.loader = previous.loader;
    DSXStrings.deviceLang = previous.deviceLang;
    DSXStrings.reset();
  }
});
