import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_ENGINES,
  browserEngine,
  browserType,
} from "../oracle/browser-engine.ts";

test("browser matrix is the exact locked Chromium, Firefox, WebKit contract", () => {
  assert.deepEqual(BROWSER_ENGINES, ["chromium", "firefox", "webkit"]);
  for (const engine of BROWSER_ENGINES) {
    assert.equal(browserEngine(engine.toUpperCase()), engine);
    assert.equal(browserType(engine).name(), engine);
  }
});

test("browser selection defaults to Chromium and rejects silent fallback", () => {
  assert.equal(browserEngine(undefined), "chromium");
  assert.throws(() => browserEngine("safari"), /unsupported DSX_BROWSER/);
  assert.throws(() => browserEngine("edge"), /unsupported DSX_BROWSER/);
});
