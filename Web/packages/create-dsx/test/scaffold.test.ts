//
//  scaffold.test.ts — what `npm create despia` writes, and the contract that matters most:
//  the generated project COMPILES with `despia build` and LINTS clean with `despia lint --strict`,
//  as generated, with nothing edited. That end-to-end loop is the last test in this file.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// @despia-native/cli is a TOOLING package, deliberately outside the five-package npm workspace set
// (the release contract), so a test reaches it by path rather than by bare specifier.
import { buildProject, loadConfig, runCli } from "../../cli/src/index.ts";

import { scaffold, toPackageName, toScheme, workspaceLinks, ScaffoldError, TEMPLATES } from "../src/index.ts";
import { renderTemplate } from "../src/templates.ts";
import { runCreate, USAGE, VERSION, type Io } from "../src/cli.ts";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function work(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "create-dsx-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

test("the minimal template writes a complete, self-describing package", () => {
  const w = work();
  try {
    const result = scaffold({ directory: join(w.dir, "my-app") });
    assert.deepEqual(result.files, [
      ".gitignore", "AGENTS.md", "CLAUDE.md", "Components/App.dsx", "README.md", "dsx.config.json", "dsx.json", "package.json",
    ]);
    assert.equal(result.name, "my-app");
    assert.equal(result.scheme, "myapp");

    const manifest = JSON.parse(readFileSync(join(result.root, "dsx.json"), "utf8")) as { scheme: string };
    assert.equal(manifest.scheme, "myapp");

    const config = JSON.parse(readFileSync(join(result.root, "dsx.config.json"), "utf8")) as { entry: string; outDir: string };
    assert.equal(config.entry, "App");
    assert.equal(config.outDir, "dist");

    const pkg = JSON.parse(readFileSync(join(result.root, "package.json"), "utf8")) as {
      dependencies: { [k: string]: string }; devDependencies: { [k: string]: string }; scripts: { [k: string]: string };
    };
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@despia-native/compiler", "@despia-native/dom", "@despia-native/kernel", "@despia-native/server"]);
    assert.deepEqual(Object.keys(pkg.devDependencies), ["@despia-native/cli"]);
    assert.deepEqual(pkg.scripts, { build: "despia build", dev: "despia dev", lint: "despia lint --strict", review: "despia review --strict" });
  } finally {
    w.cleanup();
  }
});

test("the routed template adds a second component and the route table that reaches it", () => {
  const w = work();
  try {
    const result = scaffold({ directory: join(w.dir, "routed"), template: "routed" });
    assert.ok(result.files.includes("Components/About.dsx"));
    const config = JSON.parse(readFileSync(join(result.root, "dsx.config.json"), "utf8")) as {
      routes: Array<{ path: string; component: string }>;
    };
    assert.deepEqual(config.routes.map((r) => r.path), ["/", "/about"]);
    assert.deepEqual(config.routes.map((r) => r.component), ["routed.App", "routed.About"]);
  } finally {
    w.cleanup();
  }
});

test("the agent brief ships in every project: the loop, the grammar, the design bar", () => {
  const w = work();
  try {
    const result = scaffold({ directory: join(w.dir, "briefed") });
    const brief = readFileSync(join(result.root, "AGENTS.md"), "utf8");
    // the three things an agent must know: DSX is not what it pattern-matches to,
    // the verify loop is mandatory, and the design bar exists
    assert.match(brief, /NOT React, React Native, HTML, Vue or Flutter/);
    assert.match(brief, /npm run lint/);
    assert.match(brief, /npm run dev/);
    assert.match(brief, /semantic tokens first/);
    assert.match(brief, /at least 44 points/);
    assert.match(brief, /empty, loading and error states/);
    // no em/en dashes: the brief is published prose (RELEASING.md house rule)
    assert.doesNotMatch(brief, /[–—]/, "the agent brief carries an em/en dash");
    // CLAUDE.md is a one-line import so Claude Code and AGENTS.md hosts read one brief
    assert.equal(readFileSync(join(result.root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  } finally {
    w.cleanup();
  }
});

test("names and schemes are derived, not assumed", () => {
  assert.equal(toPackageName("My App!"), "my-app");
  assert.equal(toPackageName("  --weird--  "), "weird");
  assert.equal(toPackageName("***"), "dsx-app");
  assert.equal(toScheme("my-app"), "myapp");
  assert.equal(toScheme("Store 2"), "store2");
  assert.equal(toScheme("---"), "app");
});

test("an explicit name and scheme override the derivation", () => {
  const w = work();
  try {
    const result = scaffold({ directory: join(w.dir, "dir"), name: "Shop Front", scheme: "shop" });
    assert.equal(result.name, "shop-front");
    assert.equal(result.scheme, "shop");
    assert.match(readFileSync(join(result.root, "Components/App.dsx"), "utf8"), /<stack/);
  } finally {
    w.cleanup();
  }
});

test("a non-empty directory is refused unless --force is given", () => {
  const w = work();
  try {
    const target = join(w.dir, "taken");
    scaffold({ directory: target });
    assert.throws(() => scaffold({ directory: target }), (e: unknown) => e instanceof ScaffoldError && e.message.includes("--force"));
    assert.doesNotThrow(() => scaffold({ directory: target, force: true }));
  } finally {
    w.cleanup();
  }
});

test("an unknown template is refused and lists the real ones", () => {
  const w = work();
  try {
    assert.throws(
      () => scaffold({ directory: join(w.dir, "x"), template: "svelte" as never }),
      (e: unknown) => e instanceof ScaffoldError && e.message.includes(TEMPLATES.join(", ")),
    );
  } finally {
    w.cleanup();
  }
});

test("--link rewrites the @despia-native/* dependencies to the local workspace", () => {
  const links = workspaceLinks(workspace);
  assert.ok(links["@despia-native/compiler"]?.startsWith("file:"));
  assert.ok(links["@despia-native/cli"]?.startsWith("file:"));
  const files = renderTemplate({ name: "x", scheme: "x", template: "minimal", version: "0.1.0", link: links });
  const pkg = JSON.parse(files["package.json"]!) as { dependencies: { [k: string]: string } };
  assert.ok(pkg.dependencies["@despia-native/dom"]!.startsWith("file:"));
});

test("templates are pure data — the same options always render the same bytes", () => {
  const options = { name: "x", scheme: "x", template: "minimal" as const, version: "0.1.0" };
  assert.deepEqual(renderTemplate(options), renderTemplate(options));
});

test("the CLI reports what it made, and refuses without a directory", () => {
  const w = work();
  try {
    const io = capture();
    assert.equal(runCreate([join(w.dir, "app")], io), 0);
    assert.ok(io.lines[0]?.includes('scaffolded app (minimal, scheme "app")'));
    assert.ok(io.lines.includes("  npm run dev"));

    const bare = capture();
    assert.equal(runCreate([], bare), 1);
    assert.ok(bare.errors[0]?.includes("name the directory"));
    assert.equal(bare.lines[0], USAGE);

    const version = capture();
    assert.equal(runCreate(["--version"], version), 0);
    assert.deepEqual(version.lines, [VERSION]);
  } finally {
    w.cleanup();
  }
});

test("the CLI surfaces a scaffold failure as exit 1 with the reason", () => {
  const w = work();
  try {
    writeFileSync(join(w.dir, "occupied.txt"), "x");
    const io = capture();
    assert.equal(runCreate([w.dir], io), 1);
    assert.ok(io.errors[0]?.includes("is not empty"));
  } finally {
    w.cleanup();
  }
});

// ── the contract ───────────────────────────────────────────────────────────────────────

test("END TO END: every template scaffolds a project that `despia build` compiles and `despia lint --strict` passes", async () => {
  for (const template of TEMPLATES) {
    const w = work();
    try {
      const scaffolded = scaffold({ directory: join(w.dir, `app-${template}`), template });
      // lint the generated sources exactly as `npm run lint` would
      const io = capture();
      assert.equal(
        await runCli(["lint", "--project", scaffolded.root, "--strict"], io),
        0,
        `${template}: generated sources did not lint clean:\n${io.lines.join("\n")}`,
      );

      // build them exactly as `npm run build` would
      const result = buildProject(loadConfig(scaffolded.root));
      assert.ok(result.components >= 1, `${template}: nothing compiled`);
      assert.ok(existsSync(join(result.outDir, "index.html")));
      assert.ok(existsSync(join(result.outDir, "main.js")));
      assert.ok(existsSync(join(result.outDir, "registry.json")));

      const html = readFileSync(join(result.outDir, "index.html"), "utf8");
      // the entry screen's authored content is really in the served bytes
      assert.match(html, /Hello, DSX/, `${template}: the attribute default did not render`);
      assert.match(html, /Tapped 0 times/, `${template}: the variable did not render`);
      assert.match(html, /<script type="importmap">/, `${template}: no import map`);
      if (template === "routed") {
        assert.ok(existsSync(join(result.outDir, "about/index.html")), "the routed template did not export /about");
      }
    } finally {
      w.cleanup();
    }
  }
});

test("a scaffolded project's own dsx.json is what makes it a DSX package", () => {
  const w = work();
  try {
    const result = scaffold({ directory: join(w.dir, "pkg") });
    assert.ok(existsSync(join(result.root, "dsx.json")));
    assert.equal(loadConfig(result.root).scheme, "pkg");
    assert.equal(loadConfig(result.root).entry, "pkg.App");
    assert.equal(dirname(join(result.root, "Components/App.dsx")), join(result.root, "Components"));
  } finally {
    w.cleanup();
  }
});
