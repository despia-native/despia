//
//  keyboard-subpath.test.ts: keyboard.ts is a kernel SUBPATH, not a barrel export.
//  A leftover `from "@despia/kernel"` of parseKeyboardMode / resolveKeyboardViewport
//  boots the Demo as a blank page (the requested export is missing).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function repoRoot(): string {
  let directory = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(directory, "OpenSource/Conformance"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repo root not found");
    directory = parent;
  }
}

const KEYBOARD_SYMBOLS = [
  "parseKeyboardMode",
  "resolveKeyboardViewport",
  "modeForOverlaysContent",
  "supportsViewportModes",
];

const BARREL = /from\s+["']@despia\/kernel["']/;

function walk(dir: string, acc: string[]): void {
  let names: Dirent[];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
      walk(path, acc);
      continue;
    }
    if (entry.name.endsWith(".js") || entry.name.endsWith(".ts")) acc.push(path);
  }
}

test("no production importer reads keyboard symbols off the kernel barrel", () => {
  const root = repoRoot();
  const files: string[] = [];
  walk(join(root, "ClosedSource/DSX/Modules"), files);
  walk(join(root, "OpenSource/Web/packages/dom/src"), files);
  walk(join(root, "OpenSource/Web/packages/compiler/src"), files);
  walk(join(root, "OpenSource/Web/packages/server/src"), files);
  walk(join(root, "OpenSource/Web/packages/element/src"), files);
  walk(join(root, "OpenSource/Web/packages/cli/src"), files);

  const hits: string[] = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    if (!BARREL.test(text)) continue;
    for (const symbol of KEYBOARD_SYMBOLS) {
      if (text.includes(symbol)) {
        hits.push(`${relative(root, path)} still imports ${symbol} from @despia/kernel`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("the kernel barrel does not re-export keyboard.ts", () => {
  const barrel = readFileSync(join(repoRoot(), "OpenSource/Web/packages/kernel/src/index.ts"), "utf8");
  assert.doesNotMatch(barrel, /from\s+["']\.\/keyboard\.ts["']/);
  assert.match(barrel, /@despia\/kernel\/keyboard/);
});
