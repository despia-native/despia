//
//  build.test.ts — `despia build` over a real project on disk: the compile path, the vendored
//  runtime, the mechanically derived import map, SSR'd documents, and the route export.
//  Nothing is mocked; every assertion is on bytes the command actually wrote.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildProject, BuildError, bootloader, runtimeDistDir, scanDsxSpecifiers } from "../src/build.ts";
import { loadConfig, findProjectRoot, componentFiles, ConfigError } from "../src/config.ts";

const APP = `<stack>
  <head>
    <attribute as="title" default="'Hello'"/>
    <variable as="count">return 0</variable>
    <action as="bump">dsx.variable.count = dsx.variable.count + 1</action>
  </head>
  <text value="{{ dsx.attribute.title }}"/>
  <text value="count {{ dsx.variable.count }}"/>
  <button label="Tap" on:tap="dsx.action.bump()"/>
</stack>
`;

const ABOUT = `<stack><text value="about page"/></stack>\n`;

type Fixture = { root: string; cleanup: () => void };

function fixture(files: { [path: string]: string }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "dsx-cli-build-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

function minimalProject(extraConfig: { [key: string]: unknown } = {}): Fixture {
  return fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture App", entry: "App", ...extraConfig }),
    "Components/App.dsx": APP,
  });
}

test("a project compiles into an SSR'd document, a registry, a bootloader and vendored runtime", () => {
  const project = minimalProject();
  try {
    const config = loadConfig(project.root);
    const result = buildProject(config);
    assert.equal(result.components, 1);

    const html = readFileSync(join(result.outDir, "index.html"), "utf8");
    // the body is really rendered, not an empty shell waiting on JS
    assert.match(html, /Hello/);
    assert.match(html, /count 0/);
    assert.match(html, /<div id="app" role="main" data-dsx-root data-dsx-ssr data-dsx-hydrate>/);
    assert.match(html, /<title>Fixture App<\/title>/);
    assert.match(html, /<script type="module" src="\.\/main\.js"><\/script>/);

    const registry = JSON.parse(readFileSync(join(result.outDir, "registry.json"), "utf8")) as {
      components: { [k: string]: unknown };
      shell?: { appName?: string; mainSrc?: string; importMapJson?: string; manifestHref?: string };
    };
    assert.ok("fix.App" in registry.components);

    // wave-7 F1: the registry carries the BAKED document shell, so a server host built
    // from registry.json alone serves live-SSR'd dynamic routes that still load the boot
    assert.equal(registry.shell?.appName, "Fixture App");
    assert.equal(registry.shell?.mainSrc, "./main.js");
    assert.equal(registry.shell?.manifestHref, "/manifest.webmanifest");
    assert.ok(registry.shell?.importMapJson !== undefined
      && registry.shell.importMapJson.includes("@despia/dom/boot"));

    // the bootloader boots the configured entry and nothing else
    const main = readFileSync(join(result.outDir, "main.js"), "utf8");
    assert.match(main, /import \{ bootDsx \} from "@despia\/dom\/boot";/);
    assert.match(main, /entry: "fix\.App"/);

    assert.ok(existsSync(join(result.outDir, "vendor/kernel/index.js")));
    assert.ok(existsSync(join(result.outDir, "vendor/dom/boot.js")));

    // the PWA face: every build is installable — a manifest, an identity icon, the link
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    const manifest = JSON.parse(readFileSync(join(result.outDir, "manifest.webmanifest"), "utf8")) as {
      name: string; display: string; icons: { src: string; type: string }[];
    };
    assert.equal(manifest.name, "Fixture App");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.icons[0]?.type, "image/svg+xml");
    assert.match(readFileSync(join(result.outDir, "icon.svg"), "utf8"), />F<\/text>/);
  } finally {
    project.cleanup();
  }
});

test("the import map covers every bare @despia/* specifier the vendored graph imports", () => {
  const project = minimalProject();
  try {
    const result = buildProject(loadConfig(project.root));
    const needed = new Set<string>(["@despia/dom/boot"]);
    for (const pkg of ["kernel", "compiler", "dom"]) {
      for (const specifier of scanDsxSpecifiers(join(result.outDir, "vendor", pkg))) needed.add(specifier);
    }
    for (const specifier of needed) {
      assert.ok(specifier in result.importMap.imports, `${specifier} is missing from the import map`);
      assert.ok(
        existsSync(join(result.outDir, result.importMap.imports[specifier]!)),
        `${specifier} maps to a file that was not vendored`,
      );
    }
    // and the document carries exactly that map
    const html = readFileSync(join(result.outDir, "index.html"), "utf8");
    const inline = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(inline !== null);
    assert.deepEqual(JSON.parse(inline[1]!), result.importMap);
  } finally {
    project.cleanup();
  }
});

test("no browser payload ships declarations or source maps", () => {
  const project = minimalProject();
  try {
    const result = buildProject(loadConfig(project.root));
    const leaked = result.written.filter((f) => f.endsWith(".d.ts") || f.endsWith(".map"));
    assert.deepEqual(leaked, []);
  } finally {
    project.cleanup();
  }
});

test("a route table exports one document per static route", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({
      name: "Routed", entry: "App",
      routes: [
        { path: "/", component: "fix.App", meta: { title: "Home" } },
        { path: "/about", component: "fix.About", meta: { title: "About" } },
      ],
    }),
    "Components/App.dsx": APP,
    "Components/About.dsx": ABOUT,
  });
  try {
    const result = buildProject(loadConfig(project.root));
    assert.ok(result.written.includes("index.html"));
    assert.ok(result.written.includes("about/index.html"));
    const about = readFileSync(join(result.outDir, "about/index.html"), "utf8");
    assert.match(about, /about page/);
    assert.match(about, /<title>About<\/title>/);
  } finally {
    project.cleanup();
  }
});

test("a sidecar .css sheet is owner-scoped into the document cascade", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Styled", entry: "App" }),
    "Components/App.dsx": APP,
    "Components/App.css": ".headline { color: rebeccapurple; }\n",
  });
  try {
    const result = buildProject(loadConfig(project.root));
    const html = readFileSync(join(result.outDir, "index.html"), "utf8");
    assert.match(html, /\[data-dsx-owner="App"\] \.headline, \[data-dsx-owner="App"\]:is\(\.headline\) \{ color: rebeccapurple; \}/);
  } finally {
    project.cleanup();
  }
});

test("public/ is copied verbatim into the output", () => {
  const project = minimalProject();
  try {
    writeFileSync(join(project.root, "dsx.config.json"), JSON.stringify({ name: "Assets", entry: "App" }));
    mkdirSync(join(project.root, "public"), { recursive: true });
    writeFileSync(join(project.root, "public/robots.txt"), "User-agent: *\n");
    const result = buildProject(loadConfig(project.root));
    assert.equal(readFileSync(join(result.outDir, "robots.txt"), "utf8"), "User-agent: *\n");
  } finally {
    project.cleanup();
  }
});

test("a missing entry component fails loudly and names what WAS compiled", () => {
  const project = minimalProject({ entry: "Missing" });
  try {
    assert.throws(
      () => buildProject(loadConfig(project.root)),
      (e: unknown) => e instanceof BuildError && e.message.includes("fix.App"),
    );
  } finally {
    project.cleanup();
  }
});

test("a project with no components fails instead of emitting an empty site", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Empty", entry: "App" }),
  });
  try {
    assert.throws(() => buildProject(loadConfig(project.root)), (e: unknown) => e instanceof BuildError);
  } finally {
    project.cleanup();
  }
});

test("config: entry qualifies against the scheme, outDir resolves, defaults are applied once", () => {
  const project = minimalProject({ outDir: "build/site" });
  try {
    const config = loadConfig(project.root);
    assert.equal(config.entry, "fix.App");
    assert.equal(config.scheme, "fix");
    assert.equal(config.lang, "en");
    assert.equal(config.outDir, join(project.root, "build/site"));
    assert.deepEqual(componentFiles(project.root), [join(project.root, "Components/App.dsx")]);
    assert.equal(findProjectRoot(join(project.root, "Components")), project.root);
  } finally {
    project.cleanup();
  }
});

test("config: an already-qualified entry is left alone", () => {
  const project = minimalProject({ entry: "other.Screen" });
  try {
    assert.equal(loadConfig(project.root).entry, "other.Screen");
  } finally {
    project.cleanup();
  }
});

test("config errors name the file and the missing key", () => {
  const noEntry = fixture({
    "dsx.json": JSON.stringify({ name: "x", scheme: "x" }),
    "dsx.config.json": JSON.stringify({ name: "x" }),
  });
  try {
    assert.throws(() => loadConfig(noEntry.root), (e: unknown) => e instanceof ConfigError && e.message.includes('no "entry"'));
  } finally {
    noEntry.cleanup();
  }
  const noScheme = fixture({ "dsx.config.json": JSON.stringify({ entry: "App" }) });
  try {
    assert.throws(() => loadConfig(noScheme.root), (e: unknown) => e instanceof ConfigError && e.message.includes("no scheme"));
  } finally {
    noScheme.cleanup();
  }
  const broken = fixture({ "dsx.config.json": "{ not json" });
  try {
    assert.throws(() => loadConfig(broken.root), (e: unknown) => e instanceof ConfigError && e.message.includes("not valid JSON"));
  } finally {
    broken.cleanup();
  }
});

test("the runtime packages this build vendors are resolvable from @despia/cli", () => {
  for (const pkg of ["@despia/kernel", "@despia/compiler", "@despia/dom", "@despia/server"]) {
    assert.ok(runtimeDistDir(pkg) !== null, `${pkg} did not resolve`);
  }
  assert.equal(runtimeDistDir("@despia/definitely-not-a-package"), null);
});

test("the generated bootloader owns zero behavior", () => {
  const project = minimalProject();
  try {
    const source = bootloader(loadConfig(project.root));
    // mounts and hands off — no element handling, no module logic, no DOM queries
    assert.match(source, /bootDsx\(\{/);
    assert.ok(!source.includes("querySelector"));
    assert.ok(!source.includes("addEventListener"));
  } finally {
    project.cleanup();
  }
});

// ── the bundled floor (bundled-floor.md, web renderer) ──────────────────────────────

test("every build ships the offline floor: dsx-sw.js, the manifest, and the bootloader registration", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({
      name: "Floored", entry: "App",
      routes: [
        { path: "/", component: "fix.App", meta: { title: "Home" } },
        { path: "/about", component: "fix.About", meta: { title: "About" } },
        { path: "/notes/:id", component: "fix.About", meta: { title: "Note" } },
      ],
    }),
    "Components/App.dsx": APP,
    "Components/About.dsx": ABOUT,
  });
  try {
    const result = buildProject(loadConfig(project.root));

    // the worker script sits beside the entry, byte-identical to the one @despia/dom ships
    assert.ok(result.written.includes("dsx-sw.js"));
    assert.match(readFileSync(join(result.outDir, "dsx-sw.js"), "utf8"), /dsx-sw\.js|service worker|precache/i);

    // the manifest covers the COMPLETE tree (itself excluded), in the one seed dialect
    const manifest = JSON.parse(readFileSync(join(result.outDir, "despia/local.json"), "utf8")) as {
      entry?: string; assets: { path: string; sha256: string }[]; routes?: { pattern: string; page: string }[];
    };
    assert.equal(manifest.entry, "index.html");
    const paths = manifest.assets.map((a) => a.path);
    assert.ok(!paths.includes("despia/local.json"));
    for (const must of ["index.html", "main.js", "registry.json", "dsx-sw.js", "about/index.html"]) {
      assert.ok(paths.includes(must), `${must} missing from the offline manifest`);
    }
    for (const asset of manifest.assets) assert.match(asset.sha256, /^[0-9a-f]{64}$/);

    // the dynamic route exported ONE skeleton page, declared for the worker
    assert.ok(paths.includes("notes/__param__/index.html"));
    assert.deepEqual(manifest.routes, [{ pattern: "/notes/:id", page: "notes/__param__/index.html" }]);

    // the bootloader registers the floor, anchored to itself (deep-link first visits)
    const main = readFileSync(join(result.outDir, "main.js"), "utf8");
    assert.match(main, /import \{ registerOfflineFloor \} from "@despia\/dom\/offline";/);
    assert.match(main, /registerOfflineFloor\(\{ swUrl: new URL\("\.\/dsx-sw\.js", import\.meta\.url\)\.href \}\)/);
    assert.equal(result.importMap.imports["@despia/dom/offline"], "./vendor/dom/offline.js");
    assert.ok(existsSync(join(result.outDir, "vendor/dom/offline.js")));
  } finally {
    project.cleanup();
  }
});

// ── web.entry + web.dependencies (A3) ───────────────────────────────────────────────

test("a package's web.entry becomes its own lazy chunk, with npm dependencies bundled IN", () => {
  // A dependency installed the way npm installs one, inside the project's own node_modules.
  // Bundling it IN is the whole point: a browser has no node_modules, so an external bare
  // specifier would be a blank screen at runtime — the failure the @despia/* import map
  // already exists to prevent.
  const project = fixture({
    "dsx.json": JSON.stringify({
      name: "fixture",
      scheme: "fix",
      web: { entry: "web/editor.ts", dependencies: { "tiny-dep": "1.0.0" } },
    }),
    "dsx.config.json": JSON.stringify({ name: "Fixture App", entry: "App" }),
    "Components/App.dsx": APP,
    "node_modules/tiny-dep/package.json": JSON.stringify({ name: "tiny-dep", version: "1.0.0", main: "index.js", type: "module" }),
    "node_modules/tiny-dep/index.js": `export const DEP_MARKER = "from-the-npm-dependency";\n`,
    "web/editor.ts": `import { DEP_MARKER } from "tiny-dep";\nexport const marker = "package-entry-bundled";\nexport function open() { return marker + DEP_MARKER; }\n`,
  });
  try {
    const result = buildProject(loadConfig(project.root));
    const chunk = join(result.outDir, "vendor", "packages", "fix.js");
    assert.ok(existsSync(chunk), `expected a per-package chunk, wrote: ${result.written.join(", ")}`);
    const bundled = readFileSync(chunk, "utf8");
    assert.match(bundled, /package-entry-bundled/);
    // the dependency's bytes are INSIDE the chunk, not left as a bare specifier
    assert.match(bundled, /from-the-npm-dependency/);
    assert.ok(!/from\s+"tiny-dep"/.test(bundled), "the npm dependency must not survive as a bare import");

    // The chunk is addressable, and is NOT loaded by the bootloader — that is what makes a
    // heavy dependency affordable to declare.
    assert.equal(result.importMap.imports["dsx:package/fix"], "./vendor/packages/fix.js");
    assert.ok(!readFileSync(join(result.outDir, "main.js"), "utf8").includes("dsx:package/fix"));
  } finally {
    project.cleanup();
  }
});

test("a declared dependency that is not installed fails the build, naming it", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({
      name: "fixture",
      scheme: "fix",
      web: { entry: "web/x.ts", dependencies: { "totally-not-installed-xyz": "1.0.0" } },
    }),
    "dsx.config.json": JSON.stringify({ name: "Fixture App", entry: "App" }),
    "Components/App.dsx": APP,
    "web/x.ts": `export const x = 1;\n`,
  });
  try {
    assert.throws(() => buildProject(loadConfig(project.root)), /totally-not-installed-xyz.*not installed/s);
  } finally {
    project.cleanup();
  }
});

test("a web.entry pointing at a missing file fails the build rather than shipping nothing", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix", web: { entry: "web/gone.ts" } }),
    "dsx.config.json": JSON.stringify({ name: "Fixture App", entry: "App" }),
    "Components/App.dsx": APP,
  });
  try {
    assert.throws(() => buildProject(loadConfig(project.root)), /web\.entry "web\/gone\.ts" does not exist/);
  } finally {
    project.cleanup();
  }
});

// The vendoring queue is driven by scanDsxSpecifiers, so a false edge there is not a cosmetic
// bug: it makes `despia build` demand a package the project never imports and refuse an app that
// is entirely correct. The compiler's MCP view builder EMITS import statements as string data,
// and an unanchored scan read that as the compiler importing @despia/element — caught by the
// cold-start gate, which builds a scaffolded project from tarballs alone.
test("scanDsxSpecifiers reads import statements, not import statements inside emitted strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-scan-"));
  try {
    writeFileSync(join(dir, "real.js"), [
      `import { a } from "@despia/kernel";`,
      `import "@despia/dom/boot";`,
      `export { b } from "@despia/compiler/resolve";`,
      `const lazy = await import("@despia/server/actions");`,
    ].join("\n"));
    writeFileSync(join(dir, "codegen.js"), [
      `function emitEntry() {`,
      `  writeFileSync(entryPath, [`,
      `    \`import { defineDsxElement } from "@despia/element";\`,`,
      `    \`import { mountMcpApp } from "@despia/dom/mcp-app";\`,`,
      `  ].join("\\n"));`,
      `}`,
    ].join("\n"));

    assert.deepEqual([...scanDsxSpecifiers(dir)].sort(), [
      "@despia/compiler/resolve",
      "@despia/dom/boot",
      "@despia/kernel",
      "@despia/server/actions",
    ], "the emitted @despia/element and @despia/dom/mcp-app are data, not edges");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── web.boot (studio-apps.md §8) ────────────────────────────────────────────────────

test("a package's web.boot registers its entry at boot — and the lazy default stands beside it", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({
      name: "fixture",
      scheme: "fix",
      web: { entry: "web/host.js", boot: true },
    }),
    "dsx.config.json": JSON.stringify({ name: "Fixture App", entry: "App" }),
    "Components/App.dsx": APP,
    // a boot module is a bus module: it imports the kernel, so the chunk-specifier scan
    // must vendor + map @despia/kernel or the page is a clean-session blank screen.
    "web/host.js": `import { ModuleCallError } from "@despia/kernel";\nexport default { scheme: "fix", actions: {}, components: { Probe: { mount() { void ModuleCallError; } } } };\n`,
  });
  try {
    const result = buildProject(loadConfig(project.root));
    const main = readFileSync(join(result.outDir, "main.js"), "utf8");
    // the bootloader imports the chunk and hands it to bootDsx — one translation line
    assert.match(main, /import bootModule0 from "dsx:package\/fix";/);
    assert.match(main, /modules: \[bootModule0\]/);
    // the chunk's surviving @despia/* external is mapped, fail-closed
    assert.equal(result.importMap.imports["dsx:package/fix"], "./vendor/packages/fix.js");
    assert.ok(result.importMap.imports["@despia/kernel"] !== undefined
      || Object.keys(result.importMap.imports).some((s) => s.startsWith("@despia/kernel")),
      `the chunk's kernel import must be represented (got: ${Object.keys(result.importMap.imports).join(", ")})`);
  } finally {
    project.cleanup();
  }
});

test("web.boot without an entry fails the build — there is nothing to register", () => {
  const project = fixture({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix", web: { boot: true } }),
    "dsx.config.json": JSON.stringify({ name: "Fixture App", entry: "App" }),
    "Components/App.dsx": APP,
  });
  try {
    assert.throws(() => buildProject(loadConfig(project.root)), /"boot" requires an "entry"/);
  } finally {
    project.cleanup();
  }
});
