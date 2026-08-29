//
//  platform-support.test.ts - THE PLATFORM CATALOG on the web renderer.
//
//  X1 H3, stated as a test: the bus has carried `unsupportedPlatforms` and the ladder rung
//  that reads it since the facet wave, and nothing outside a conformance fixture ever put a
//  row in it. So every native-only action answered `not_loaded` — which the bus itself
//  documents as "a caller bug, not absence", and which is a lie when the caller asked for
//  something a manifest already declared impossible in a browser.
//
//  What is pinned here:
//    · the build seam folds the FULL catalog against this runtime's OS, so an on-platform
//      row leaves no trace and the `.has()` reads stay honest;
//    · a MODULE-level narrowing answers `unsupported_platform` with { scheme, platform,
//      supportedPlatforms } — never `not_loaded`;
//    · an ACTION-level narrowing answers it too, and OUTRANKS `unknown_action`, which is the
//      only case the scheme-keyed table structurally cannot see;
//    · an action with NO narrowing is untouched — it resolves exactly as before.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ModuleRegistry, ModuleCallError, defineModule, actionPlatformKey,
} from "../src/bus.ts";

/** The generated catalog's exact shape (ModulePlatformSupport.generated.json), trimmed. */
const CATALOG = {
  byScheme: {
    healthkit: ["ios"],                       // no browser twin at all
    clipboard: ["ios", "android", "web"],     // implemented here — must leave no row
    health: ["ios", "android", "web"],        // here, but one action is not (below)
  },
  byAction: {
    "health.workouts": ["ios", "android"],    // the narrowing: no browser workout store
    "health.read": ["ios", "android", "web"], // declared, and this OS is in it
  },
};

ModuleRegistry.register(defineModule({
  scheme: "health",
  actions: { read: () => ({ steps: 7 }) },    // `workouts` deliberately has no web handler
}));

function reset(): void {
  ModuleRegistry.setPlatformSupport(CATALOG, "web");
}

async function failureOf(callee: string): Promise<ModuleCallError> {
  try {
    await ModuleRegistry.call(callee, {});
  } catch (e) {
    assert.ok(e instanceof ModuleCallError, `${callee} threw ${String(e)}`);
    return e;
  }
  throw new Error(`${callee} resolved — expected a typed failure`);
}

test("catalog: the seam folds against THIS os and keeps only what is off-platform here", () => {
  reset();
  assert.equal(ModuleRegistry.unsupportedPlatforms.has("healthkit"), true);
  assert.equal(ModuleRegistry.unsupportedPlatforms.has("clipboard"), false, "an implemented module must leave no row");
  assert.equal(ModuleRegistry.unsupportedPlatforms.has("health"), false);
  assert.equal(ModuleRegistry.unsupportedActionPlatforms.has("health.workouts"), true);
  assert.equal(ModuleRegistry.unsupportedActionPlatforms.has("health.read"), false);

  // the same catalog read as a NATIVE runtime: the rows invert, nothing is special-cased
  ModuleRegistry.setPlatformSupport(CATALOG, "ios");
  assert.equal(ModuleRegistry.unsupportedPlatforms.size, 0);
  assert.equal(ModuleRegistry.unsupportedActionPlatforms.size, 0);
  reset();
});

test("catalog: a MODULE-level narrowing answers unsupported_platform, never not_loaded", async () => {
  reset();
  const e = await failureOf("healthkit.read");
  assert.equal(e.code, "unsupported_platform");
  assert.deepEqual(e.data, { scheme: "healthkit", platform: "web", supportedPlatforms: ["ios"] });
});

test("catalog: an ACTION-level narrowing outranks unknown_action on a module that IS here", async () => {
  reset();
  // The module is registered and answers `read`. Without the action table this is
  // `unknown_action` — the bus blaming the caller for a gap the manifest already declared.
  const e = await failureOf("health.workouts");
  assert.equal(e.code, "unsupported_platform");
  assert.deepEqual(e.data, { scheme: "health", platform: "web", supportedPlatforms: ["ios", "android"] });
});

test("catalog: an action with no narrowing is untouched, and an unknown one still blames the caller", async () => {
  reset();
  assert.deepEqual(await ModuleRegistry.call("health.read", {}), { steps: 7 });
  const e = await failureOf("health.typo");
  assert.equal(e.code, "unknown_action", "a real caller bug must still read as one");
});

test("catalog: an empty catalog is exactly today's behaviour", async () => {
  ModuleRegistry.setPlatformSupport({}, "web");
  const e = await failureOf("healthkit.read");
  assert.equal(e.code, "not_loaded");
  reset();
});

test("catalog: the action key folds the manifest's dots and the wire's slashes together", () => {
  assert.equal(actionPlatformKey("Watch.Health", "HeartRate"), "watch.health.heartrate");
  assert.equal(actionPlatformKey("files", "pick/image"), "files.pick.image");
});
