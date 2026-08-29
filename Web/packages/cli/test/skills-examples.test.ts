//
//  skills-examples.test.ts — the worked example app behind OpenSource/Skills/writing-an-app.md
//  and designing-an-app.md, kept honest. Prose examples rot silently; a real project cannot:
//  this suite lints it strict, builds it, and checks every icon name it draws is actually in
//  the icon corpus (an unmapped name renders a placeholder disc behind a console.warn nobody
//  reads — the exact failure the Studio's icon gates exist to prevent).
//
//  The project is copied to a temp directory first, which both keeps the tree clean and
//  proves the example is self-contained — the same reason cold-start builds from tarballs.
//

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProject, loadConfig, runCli } from "../src/index.ts";

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../Skills/examples");
const SF_MAP = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../Conformance/icons/sf-map.json");

function copy(): { root: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "skills-examples-"));
  const root = join(dir, "examples");
  cpSync(EXAMPLES, root, { recursive: true });
  rmSync(join(root, "dist"), { recursive: true, force: true });
  return { root, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("the Skills example app lints strict with zero findings", async () => {
  const fx = copy();
  try {
    const lines: string[] = [];
    const code = await runCli(["lint", "--project", fx.root, "--strict"], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    assert.equal(code, 0, `the example app did not lint clean:\n${lines.join("\n")}`);
  } finally {
    fx.cleanup();
  }
});

test("the Skills example app builds, all screens included", () => {
  const fx = copy();
  try {
    const result = buildProject(loadConfig(fx.root));
    assert.equal(result.components, 7, "a screen or component was dropped from the build");
    for (const page of ["index.html", "detail/index.html", "settings/index.html", "onboarding/index.html", "paywall/index.html"]) {
      assert.ok(readFileSync(join(result.outDir, page), "utf8").length > 0, `${page} missing`);
    }
  } finally {
    fx.cleanup();
  }
});

test("every icon the example draws is in the icon corpus", () => {
  const mapped = new Set<string>();
  const map = JSON.parse(readFileSync(SF_MAP, "utf8")) as { [family: string]: unknown };
  for (const value of Object.values(map)) {
    if (value !== null && typeof value === "object") for (const name of Object.keys(value)) mapped.add(name);
  }
  assert.ok(mapped.size > 0, "the sf-map corpus read empty");

  const components = join(EXAMPLES, "Components");
  const unmapped: string[] = [];
  for (const file of readdirSync(components)) {
    const source = readFileSync(join(components, file), "utf8");
    for (const attr of source.matchAll(/icon="([^"]*)"/g)) {
      const value = attr[1]!;
      // a static name is checked directly; an interpolated one contributes its quoted candidates
      const names = value.includes("{{") ? [...value.matchAll(/'([a-z0-9.]+)'/g)].map((m) => m[1]!) : [value];
      for (const name of names) if (!mapped.has(name)) unmapped.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(unmapped, [], "icon names with no corpus mapping (they render as placeholders)");
});
