//
//  style-overrides-conformance.test.ts - the style-override corpus runner (TS lane).
//  Executes OpenSource/Conformance/overrides/style-overrides.json: the usage-site
//  split, the typed fail-open resolve, and the dsx.override read chain against a real
//  store. The Kotlin twin is :core StyleOverridesConformanceTest; the Swift twin is
//  StyleOverridesConformance (Apple-free, run per-PR by swift_conformance_run_test.rb
//  and by RecordMain.swift on the record lane).
//
//  Missing corpus = loud failure - a silently-skipped conformance suite is how drift
//  starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { JSE } from "../src/jse/jse.ts";
import { splitOverrideAttrs, resolveOverride, type OverrideDecl } from "../src/style-overrides.ts";
import { ReactiveStore } from "../src/store.ts";
import type { Dict } from "../src/jse/values.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/overrides/style-overrides.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`overrides/style-overrides.json not found walking up from ${import.meta.dirname}`);
    }
    dir = parent;
  }
}

type SplitCase = {
  name: string;
  attrs: { [k: string]: string };
  expect: { overrides: { [k: string]: string }; props: { [k: string]: string } };
};
type ResolveCase = { name: string; decl: OverrideDecl & { as?: string }; raw?: unknown; expect: unknown };
type ReadCase = {
  name: string;
  declarations: OverrideDecl[];
  overrides?: { [k: string]: unknown };
  storeOverrides?: { [k: string]: unknown };
  attributes?: { [k: string]: unknown };
  expect: Array<{ expr: string; value: unknown }>;
};

const corpus = JSON.parse(readFileSync(corpusFile(), "utf8")) as {
  identifier: string;
  reserved: string[];
  split: SplitCase[];
  resolve: ResolveCase[];
  read: ReadCase[];
};

test("style-overrides corpus is present and populated", () => {
  assert.ok(corpus.split.length > 0, "split table is empty");
  assert.ok(corpus.resolve.length > 0, "resolve table is empty");
  assert.ok(corpus.read.length > 0, "read table is empty");
  // The reserved list is the platform-suffix vocabulary: the fold consumes those
  // words before any split runs, so an override may never be named one of them.
  assert.deepEqual(
    [...corpus.reserved].sort(),
    ["android", "desktop", "ios", "linux", "macos", "native", "watch", "wear", "web", "windows"],
  );
});

for (const c of corpus.split) {
  test(`split: ${c.name}`, () => {
    const got = splitOverrideAttrs(c.attrs);
    assert.deepEqual(got.overrides, c.expect.overrides);
    assert.deepEqual(got.props, c.expect.props);
  });
}

for (const c of corpus.resolve) {
  test(`resolve: ${c.name}`, () => {
    const decl: OverrideDecl = { ...c.decl, as: c.decl.as ?? "x" };
    const raw = Object.prototype.hasOwnProperty.call(c, "raw") ? c.raw : undefined;
    const got = resolveOverride(decl, raw);
    assert.deepEqual(got, c.expect, `decl ${JSON.stringify(c.decl)} raw ${JSON.stringify(raw ?? null)}`);
  });
}

for (const c of corpus.read) {
  test(`read: ${c.name}`, () => {
    const store = new ReactiveStore();
    for (const decl of c.declarations) store.jse.overrideDecls.set(decl.as, decl);
    const item: Dict = { ...(c.attributes ?? {}) };
    if (c.overrides !== undefined) item["__overrides"] = { ...c.overrides };
    if (c.storeOverrides !== undefined) store.jse.vars.set("dsx.override", { ...c.storeOverrides });
    for (const e of c.expect) {
      const got = JSE.eval(e.expr, store.jse, item);
      assert.deepEqual(got ?? null, e.value, `expr ${e.expr}`);
    }
  });
}
