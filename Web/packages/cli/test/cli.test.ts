//
//  cli.test.ts — the command surface (`runCli` returns an exit code, never exits) and the
//  `dsx dev` server: real sockets, real files, real rebuilds.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseArgs, runCli, USAGE, VERSION, type Io } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { devHeaders, injectReloadClient, errorPage, startDevServer, RELOAD_PATH } from "../src/dev.ts";

const APP = `<stack><head><variable as="n">return 7</variable></head><text value="n is {{ dsx.variable.n }}"/></stack>\n`;

type Fixture = { root: string; cleanup: () => void };

function project(files: { [path: string]: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "dsx-cli-"));
  const all: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

test("argument parsing: commands, value flags, boolean flags, = form, repeats, positionals", () => {
  assert.deepEqual(parseArgs(["build", "--project", "/tmp/a", "--demo"]), {
    command: "build",
    flags: { project: "/tmp/a", demo: true },
    positional: [],
    repeated: { project: ["/tmp/a"] },
  });
  assert.deepEqual(parseArgs(["lint", "--strict", "a.dsx", "b.dsx"]), {
    command: "lint", flags: { strict: true }, positional: ["a.dsx", "b.dsx"], repeated: {},
  });
  assert.deepEqual(parseArgs(["dev", "--port=1234"]).flags, { port: "1234" });
  assert.deepEqual(parseArgs(["lint", "--package", "a", "--package", "b"]).repeated["package"], ["a", "b"]);
  // a boolean flag directly before another flag does not swallow it
  assert.deepEqual(parseArgs(["build", "--demo", "--project", "x"]).flags, { demo: true, project: "x" });
});

test("--version prints the version; --help prints usage with exit 0; no command exits 1", async () => {
  const version = capture();
  assert.equal(await runCli(["--version"], version), 0);
  assert.deepEqual(version.lines, [VERSION]);

  const help = capture();
  assert.equal(await runCli(["--help"], help), 0);
  assert.equal(help.lines[0], USAGE);

  const bare = capture();
  assert.equal(await runCli([], bare), 1);
  assert.equal(bare.lines[0], USAGE);
});

test("an unknown command explains itself and exits 1", async () => {
  const io = capture();
  assert.equal(await runCli(["frobnicate"], io), 1);
  assert.ok(io.errors.some((l) => l.includes("unknown command 'frobnicate'")));
});

test("`dsx build --project <dir>` compiles and reports what it wrote", async () => {
  const fixture = project();
  try {
    const io = capture();
    assert.equal(await runCli(["build", "--project", fixture.root], io), 0);
    assert.ok(io.lines.some((l) => l.includes("Fixture (fix) — 1 components")));
    assert.match(readFileSync(join(fixture.root, "dist/index.html"), "utf8"), /n is 7/);
  } finally {
    fixture.cleanup();
  }
});

test("`--out` overrides the configured output directory", async () => {
  const fixture = project();
  try {
    assert.equal(await runCli(["build", "--project", fixture.root, "--out", "site"], capture()), 0);
    assert.match(readFileSync(join(fixture.root, "site/index.html"), "utf8"), /n is 7/);
  } finally {
    fixture.cleanup();
  }
});

test("a broken component fails the build with a located, non-zero result", async () => {
  const fixture = project({ "Components/App.dsx": `<stack><text value="a"></stack>` });
  try {
    const io = capture();
    assert.equal(await runCli(["build", "--project", fixture.root], io), 1);
    assert.ok(io.errors.some((l) => l.includes("dsx build:")));
  } finally {
    fixture.cleanup();
  }
});

test("`dsx lint --project` lints the project's own components", async () => {
  const fixture = project({ "Components/App.dsx": `<stack><list bind="rows"/></stack>` });
  try {
    const io = capture();
    assert.equal(await runCli(["lint", "--project", fixture.root], io), 0, "a warning alone is not a failure");
    assert.ok(io.lines.some((l) => l.includes("without key=")));
    assert.ok(io.lines.some((l) => /dsx lint: 1 files · 0 errors · 1 warnings · 0 notices/.test(l)));

    const strict = capture();
    assert.equal(await runCli(["lint", "--project", fixture.root, "--strict"], strict), 1, "--strict fails on warnings");
  } finally {
    fixture.cleanup();
  }
});

test("`dsx lint <file>` outside a project folds the file's OWN package and softens the scheme rule", async () => {
  const fixture = project({
    "Components/App.dsx": `<stack><head><action as="go">dsx.module.nosuch.call()</action></head></stack>`,
  });
  try {
    const io = capture();
    assert.equal(await runCli(["lint", join(fixture.root, "Components/App.dsx")], io), 0);
    const line = io.lines.find((l) => l.includes("nosuch"));
    assert.ok(line !== undefined);
    assert.ok(line.includes("warning:"), "unproven universe → warning, not error");
    assert.ok(line.includes("lint_dsx.rb"), "and it names the tool that CAN prove it");
  } finally {
    fixture.cleanup();
  }
});

test("`--package <dir>` proves the scheme universe and restores the ERROR severity", async () => {
  const fixture = project({
    "Components/App.dsx": `<stack><head><action as="go">dsx.module.nosuch.call()</action></head></stack>`,
  });
  try {
    const io = capture();
    assert.equal(await runCli(["lint", "--package", fixture.root, join(fixture.root, "Components/App.dsx")], io), 1);
    assert.ok(io.lines.some((l) => l.includes("error:") && l.includes("no package claims scheme 'nosuch'")));
  } finally {
    fixture.cleanup();
  }
});

test("a command outside a project says so and points at the scaffolder", async () => {
  const empty = mkdtempSync(join(tmpdir(), "dsx-cli-empty-"));
  const cwd = process.cwd();
  try {
    process.chdir(empty);
    const io = capture();
    assert.equal(await runCli(["build"], io), 1);
    assert.ok(io.errors.some((l) => l.includes("npm create dsx")));
  } finally {
    process.chdir(cwd);
    rmSync(empty, { recursive: true, force: true });
  }
});

test("dev headers are no-store on every 200, and the reload client lands before </body>", () => {
  assert.deepEqual(devHeaders("text/html; charset=utf-8"), {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  const injected = injectReloadClient("<html><body><p>hi</p></body></html>");
  assert.ok(injected.includes(RELOAD_PATH));
  assert.ok(injected.indexOf(RELOAD_PATH) < injected.indexOf("</body>"));
  // a fragment without </body> still gets the client rather than silently losing it
  assert.ok(injectReloadClient("<p>hi</p>").includes(RELOAD_PATH));
});

test("the build-failure page shows the message instead of a stale document", () => {
  const page = errorPage(new Error("component <Nope> is unresolved"));
  assert.match(page, /dsx dev — build failed/);
  assert.match(page, /component &lt;Nope&gt; is unresolved/);
});

test("`dsx dev` serves the build, rebuilds on demand, and reloads open clients", async () => {
  const fixture = project();
  const config = loadConfig(fixture.root);
  const server = await startDevServer(config, { port: 0, watch: false, log: () => {} });
  try {
    const page = await fetch(`http://localhost:${server.port}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /n is 7/);
    assert.ok(html.includes(RELOAD_PATH), "the reload client is injected into served documents");

    // static assets are served with their own type, and unknown deep links fall back to the shell
    assert.match((await fetch(`http://localhost:${server.port}/main.js`)).headers.get("content-type") ?? "", /javascript/);
    const deep = await fetch(`http://localhost:${server.port}/some/client/route`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /n is 7/);
    assert.equal((await fetch(`http://localhost:${server.port}/missing.json`)).status, 404);

    // an open reload channel receives the event a rebuild pushes
    const stream = await fetch(`http://localhost:${server.port}${RELOAD_PATH}`);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = stream.body!.getReader();
    await reader.read(); // the initial retry frame

    writeFileSync(join(fixture.root, "Components/App.dsx"), APP.replace("return 7", "return 42"));
    const rebuilt = server.rebuild();
    assert.ok(!(rebuilt instanceof Error));
    assert.match(await (await fetch(`http://localhost:${server.port}/`)).text(), /n is 42/);
    await reader.cancel();
  } finally {
    await server.close();
    fixture.cleanup();
  }
});

test("`dsx dev` shows a build failure and recovers when the source is fixed", async () => {
  const fixture = project({ "Components/App.dsx": `<stack><text value="a"></stack>` });
  const config = loadConfig(fixture.root);
  const server = await startDevServer(config, { port: 0, watch: false, log: () => {} });
  try {
    const failed = await fetch(`http://localhost:${server.port}/`);
    assert.equal(failed.status, 500);
    assert.match(await failed.text(), /build failed/);

    writeFileSync(join(fixture.root, "Components/App.dsx"), APP);
    assert.ok(!(server.rebuild() instanceof Error));
    const fixed = await fetch(`http://localhost:${server.port}/`);
    assert.equal(fixed.status, 200);
    assert.match(await fixed.text(), /n is 7/);
  } finally {
    await server.close();
    fixture.cleanup();
  }
});
