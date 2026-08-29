//
//  dogfood.test.ts — `dsx` running on `dsx.cli.dsx`.
//
//  The CLI node is not a demo: this file asserts that the shipped `dsx` binary takes its
//  command table, its flags, its usage text and one whole command from a DSX document. If the
//  document and the host ever drift, these fail rather than the help quietly lying.
//

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CLI_DOCUMENT, USAGE, VERSION, runCli, type Io } from "../src/cli.ts";

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dsx-doctor-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const healthy = {
  "dsx.json": JSON.stringify({ name: "app", scheme: "app", version: "0.1.0" }),
  "dsx.config.json": JSON.stringify({ name: "app", entry: "App", outDir: "dist" }),
  "Components/App.dsx": "<stack><text value=\"hi\"/></stack>\n",
  "node_modules/@despia-native/kernel/package.json": "{}",
};

test("the command table comes from the document, not from this host", () => {
  assert.deepEqual(
    CLI_DOCUMENT.commands.map((c) => c.name).sort(),
    // add/list/remove/search landed with the registry (v4-launch/registry/00-plan.md W3);
    // review is the design lint (Skills/designing-an-app.md, its objective floor).
    // `mcp` serves this same table to a coding agent (mcp.ts): parity is derived, not kept -
    // which is why `shot` (platform/10-screenshot-execution.md W6) became an MCP tool the
    // moment it was declared here, with no second registration anywhere.
    // `film` landed with the marketing compiler (platform/12-marketing-video.md Phase 0/1)
    // and became an MCP tool the same way.
    // `deploy` landed with plan E1 - the second markup-authored command, so the shipped
    // product finally has a way to take the backend it emits live.
    // `provision` landed with the reserved-namespace plane (cost-guardrails.md): Despia owns
    // its own tables inside the customer's database, so nobody is asked to write that SQL. It
    // ejects to a host handler because opening a database connection is exactly the reach the
    // document's seam list refuses.
    // `app` and `submit` landed with Despia Apps (studio-apps.md §9): the app plane's read
    // face plus the headless run door, and the shelf submission recipe. Both became MCP tools
    // the moment they were declared here, which is the parity this test exists to hold.
    ["add", "app", "build", "deploy", "dev", "doctor", "edit", "export", "film", "licence", "lint", "list", "mcp", "ota", "provision", "remove", "report", "review", "search", "shot", "submit"],
  );
  // build/dev/edit/export/lint/review/ota eject to host handlers; doctor and deploy are
  // markup all the way down.
  assert.equal(CLI_DOCUMENT.commands.find((c) => c.name === "doctor")?.action, "doctor");
  assert.equal(CLI_DOCUMENT.commands.find((c) => c.name === "deploy")?.action, "deploy");
  assert.equal(CLI_DOCUMENT.commands.find((c) => c.name === "build")?.handler, "build");
  assert.equal(CLI_DOCUMENT.commands.find((c) => c.name === "ota")?.handler, "ota");
  assert.ok(CLI_DOCUMENT.actions.has("doctor"), "the doctor body lives in the document");
  assert.ok(CLI_DOCUMENT.actions.has("deploy"), "the deploy body lives in the document");
});

test("usage is generated, so every declared command and flag appears in --help", () => {
  for (const command of CLI_DOCUMENT.commands) {
    assert.ok(USAGE.includes(command.name), `--help never mentions '${command.name}'`);
    assert.ok(USAGE.includes(command.summary), `--help never mentions the summary of '${command.name}'`);
    for (const flag of command.flags) {
      assert.ok(USAGE.includes(`--${flag.name}`), `--help never mentions --${flag.name}`);
    }
  }
});

test("the document's version and the host's version cannot drift", () => {
  assert.equal(CLI_DOCUMENT.version, VERSION);
});

test("`despia doctor` passes a healthy project, in DSX with no host code", async () => {
  const io = capture();
  const root = project(healthy);
  assert.equal(await runCli(["doctor", "--project", root], io), 0, io.errors.join("\n"));
  const text = io.lines.join("\n");
  assert.match(text, /ok {4}dsx\.json is present/);
  assert.match(text, /ok {4}the entry component exists/);
  assert.match(text, /all checks passed — 1 component\(s\), scheme "app"/);
  assert.deepEqual(io.errors, []);
});

test("`despia doctor` fails a broken project, names each problem, and exits non-zero", async () => {
  const io = capture();
  const root = project({
    "dsx.json": JSON.stringify({ name: "app" }),
    "dsx.config.json": JSON.stringify({ name: "app", entry: "Missing", outDir: "dist" }),
    "Components/.keep": "",
  });
  assert.equal(await runCli(["doctor", "--project", root], io), 1);
  const problems = io.errors.join("\n");
  assert.match(problems, /FAIL {2}dsx\.json declares a scheme/);
  assert.match(problems, /FAIL {2}Components\/ holds at least one \.dsx/);
  assert.match(problems, /FAIL {2}the entry component exists/);
  assert.match(problems, /FAIL {2}@despia-native\/kernel is installed/);
  assert.match(problems, /4 check\(s\) failed/);
  // Diagnostics go to stderr; a piped stdout stays clean.
  assert.ok(!io.lines.join("\n").includes("FAIL"));
});

test("a declared command refuses an undeclared flag instead of ignoring it", async () => {
  const io = capture();
  assert.equal(await runCli(["doctor", "--dry-run"], io), 2);
  assert.match(io.errors.join("\n"), /unknown flag --dry-run/);
});

test("a declared body cannot read outside the project it was pointed at", async () => {
  // `--project` chooses the anchor and the document's <root> is relative to it, so the
  // filesystem seam has nothing to reach with. Proven here end to end rather than only in
  // the seam corpus: doctor reports a missing dsx.json instead of finding one higher up.
  const io = capture();
  const root = project({ "Components/.keep": "" });
  const code = await runCli(["doctor", "--project", join(root, "Components")], io);
  assert.equal(code, 1);
  assert.match(io.errors.join("\n"), /FAIL {2}dsx\.json is present/);
});
