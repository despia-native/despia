import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resolveAdaptiveShell } from "../src/adaptive-shell.ts";

function corpusFile(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/layout/adaptive-shell.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/layout/adaptive-shell.json not found");
    dir = parent;
  }
}

type Case = {
  name: string;
  attrs: Record<string, string>;
  width: number | "nonfinite";
  nativeAvailable: boolean;
  panes: { sidebar: boolean; content: boolean; inspector: boolean };
  expect: Record<string, unknown>;
};

const corpus = JSON.parse(readFileSync(corpusFile(), "utf8")) as { cases: Case[] };

test("adaptive shell corpus resolves every renderer-neutral plan", () => {
  assert.equal(corpus.cases.length, 17, "the complete ratified corpus must run");
  for (const c of corpus.cases) {
    assert.ok(Object.keys(c.expect).length > 0, `${c.name}: expected assertions are present`);
    const width = c.width === "nonfinite" ? Number.NaN : c.width;
    const actual = resolveAdaptiveShell(c.attrs, width, c.nativeAvailable, c.panes);
    for (const [key, value] of Object.entries(c.expect)) {
      assert.deepEqual(actual[key as keyof typeof actual], value, `${c.name}: ${key}`);
    }
  }
});
