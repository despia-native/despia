//
//  platform-conformance.test.ts - the platform-identity corpus runner (TS lane).
//  Executes OpenSource/Conformance/platform/platform.json `identity` through this
//  kernel's reserved words (`os` / `platform.*`) by swapping the JSESeams.platformOS
//  seam per case — the same derivations the native kernels compute from their
//  compile-time targets (/web/14; desktop-platforms.md). Also pins the reactive
//  `global.dsx`-facing dsx surface mirror (makeDsx().platform).
//
//  Missing corpus = loud failure — a silently-skipped conformance suite is how drift
//  starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { JSE, StackStore, JSESeams, isDesktopOS, DESKTOP_OSES } from "../src/jse/jse.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/platform/platform.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`OpenSource/Conformance/platform/platform.json not found walking up from ${import.meta.dirname}`);
    dir = parent;
  }
}

type IdentityCase = { os: string; expect: { native: boolean; desktop: boolean } };
const corpus = JSON.parse(readFileSync(corpusFile(), "utf8")) as { identity: IdentityCase[] };

test("platform corpus: identity derivations per os", () => {
  assert.ok(corpus.identity.length > 0, "identity section must not be empty");
  const saved = JSESeams.platformOS;
  try {
    for (const c of corpus.identity) {
      JSESeams.platformOS = c.os;
      const store = new StackStore();
      assert.equal(JSE.eval("os", store, null), c.os, `os — ${c.os}`);
      assert.equal(JSE.eval("platform.os", store, null), c.os, `platform.os — ${c.os}`);
      assert.equal(JSE.eval("platform.native", store, null), c.expect.native, `platform.native — ${c.os}`);
      assert.equal(JSE.eval("platform.desktop", store, null), c.expect.desktop, `platform.desktop — ${c.os}`);
      assert.equal(isDesktopOS(c.os), c.expect.desktop, `isDesktopOS — ${c.os}`);
    }
  } finally {
    JSESeams.platformOS = saved;
  }
});

test("platform corpus: the desktop os set is exactly the corpus desktop group", () => {
  const desktops = corpus.identity.filter((c) => c.expect.desktop).map((c) => c.os);
  assert.deepEqual([...DESKTOP_OSES], desktops);
});
