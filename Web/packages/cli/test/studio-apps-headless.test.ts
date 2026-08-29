//
//  The headless app plane (studio-apps.md §9): an interface is ONE consumer. These tests
//  drive the SAME app through `despia app run`'s runner and the MCP face — the doors are
//  the edit mount in-process, so what passes here is what a mounted surface gets.
//

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { listAppTools, runAppTool } from "../src/studio-apps/headless.ts";
import { DEFAULT_POLICY, readChangeRecords, resetChangePlanes, writePolicy } from "../src/studio-apps/vcs.ts";
import { appToolName, appToolsFromProject, handleRpc } from "../src/mcp.ts";

const APP_DOC = `<stack><head><variable as="n">return 7</variable></head><text value="n is {{ dsx.variable.n }}"/></stack>\n`;

function fixture(toolDoc: string, grants: string[] = ["project:read", "project:write"]): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-headless-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App", packages: ["packages/notes"] }),
    "Components/App.dsx": APP_DOC,
    "packages/notes/dsx.json": JSON.stringify({
      name: "Notes", scheme: "notes", version: "1.0.0", studioApi: 1,
      facets: { apps: { audit: {
        slot: "tool", action: "audit", title: "Audit",
        description: "Count the project's screens and remember the tally",
        run: "Server/Tools.dsx#audit",
      } } },
    }),
    "packages/notes/Server/Tools.dsx": toolDoc,
  };
  // grants ride UI rows in real manifests; a tool-only dev app carries them via a rail row
  if (grants.length > 0) {
    const manifest = JSON.parse(files["packages/notes/dsx.json"]!) as { facets: { apps: Record<string, unknown> } };
    manifest.facets.apps["panel"] = {
      slot: "studio.rail", component: "Components/Panel.dsx", title: "Notes", icon: "note.text", grants,
    };
    files["packages/notes/dsx.json"] = JSON.stringify(manifest);
    files["packages/notes/Components/Panel.dsx"] = `<stack><text value="notes"/></stack>\n`;
  }
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

const AUDIT_DOC = `<server>
  <head>
    <action as="audit" inputs="note">
      const listing = await dsx.module.studio.project.list()
      const source = await dsx.module.studio.project.read({ name: "Components/App.dsx" })
      await dsx.module.app.storage.set({ key: "lastNote", value: note })
      const kept = await dsx.module.app.storage.get({ key: "lastNote" })
      return { docs: listing.data.documents.length, sawSource: source.data.includes("n is"), kept: kept.data }
    </action>
  </head>
</server>
`;

test("headless: a tool runs the app's action through the REAL doors — list, read, storage round-trip", async () => {
  const fx = fixture(AUDIT_DOC);
  try {
    const tools = listAppTools(fx.root).filter((t) => t.app === "notes");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "audit");
    assert.deepEqual(tools[0]!.inputs, ["note"]);
    assert.equal(tools[0]!.hold, null);

    const result = await runAppTool(fx.root, "notes", "audit", { note: "from the CLI" });
    assert.ok(result.ok, JSON.stringify(result));
    const value = result.value as { docs: number; sawSource: boolean; kept: string };
    assert.ok(value.docs >= 1, "the documents door listed nothing");
    assert.equal(value.sawSource, true, "the read door did not hand back the source");
    assert.equal(value.kept, "from the CLI", "storage did not round-trip");
    // storage persisted through the mount's own namespaced file
    const stored = JSON.parse(readFileSync(join(fx.root, ".despia", "apps", "notes", "storage.json"), "utf8")) as { lastNote?: string };
    assert.equal(stored.lastNote, "from the CLI");
  } finally {
    fx.cleanup();
  }
});

const EDIT_DOC = `<server>
  <head>
    <action as="stamp" inputs="tip">
      const edited = await dsx.module.studio.project.edit({
        name: "Components/App.dsx",
        edits: [{ kind: "setAttribute", path: "", name: "tooltip", value: tip }]
      })
      return { saved: edited.data.saved }
    </action>
  </head>
</server>
`;

test("headless: a granted edit lands through the surgery door with app provenance", async () => {
  const fx = fixture(EDIT_DOC.replace("#audit", "#stamp"));
  try {
    // point the tool row at the stamp action
    const manifestPath = join(fx.root, "packages/notes/dsx.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { facets: { apps: { audit: { action: string; run: string } } } };
    manifest.facets.apps.audit.action = "stamp";
    manifest.facets.apps.audit.run = "Server/Tools.dsx#stamp";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await runAppTool(fx.root, "notes", "stamp", { tip: "stamped headless" });
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(readFileSync(join(fx.root, "Components", "App.dsx"), "utf8").includes('tooltip="stamped headless"'));
    // the provenance ledger: the SAME line a mounted surface's edit writes
    const log = readFileSync(join(fx.root, ".despia", "apps", "activity.log"), "utf8").trim().split("\n");
    const entry = JSON.parse(log[log.length - 1]!) as { app: string; document: string };
    assert.equal(entry.app, "notes");
    assert.equal(entry.document, "Components/App.dsx");
  } finally {
    fx.cleanup();
  }
});

const CREATE_DOC = `<server>
  <head>
    <action as="add" inputs="name">
      const made = await dsx.module.studio.project.create({
        name: "Components/" + name + ".dsx",
        source: "<stack><text value=\\"made by an app\\"/></stack>"
      })
      return { ok: made.ok, saved: made.ok == true ? made.data.saved : made.error }
    </action>
  </head>
</server>
`;

test("headless: an app that ADDS a document proposes it — a branch and a pull request, not a commit on your branch", async () => {
  const fx = fixture(CREATE_DOC);
  try {
    const manifestPath = join(fx.root, "packages/notes/dsx.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { facets: { apps: { audit: { action: string; run: string } } } };
    manifest.facets.apps.audit.action = "add";
    manifest.facets.apps.audit.run = "Server/Tools.dsx#add";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    //  a real repository, on a branch nobody protects: the STRUCTURAL rule that bites here is
    //  the created document, which is the whole point of the proposal lane
    execFileSync("git", ["init", "-q", "-b", "work", "."], { cwd: fx.root });
    execFileSync("git", ["config", "user.email", "t@despia.test"], { cwd: fx.root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: fx.root });
    execFileSync("git", ["add", "."], { cwd: fx.root });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: fx.root });
    writePolicy(fx.root, { ...DEFAULT_POLICY, push: "off" });

    const result = await runAppTool(fx.root, "notes", "add", { name: "Pricing" });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal((result.value as { ok: boolean }).ok, true);

    //  `despia app run` FLUSHES before it returns, so the change is landed by the time the
    //  process would have exited — a burst left open is a commit that never happened.
    const changes = readChangeRecords(fx.root);
    assert.equal(changes.length, 1, JSON.stringify(changes));
    assert.equal(changes[0]!.kind, "structural");
    assert.deepEqual(changes[0]!.documents, ["Components/Pricing.dsx"]);
    assert.match(changes[0]!.branch, /^despia\/app\/notes\//);
    assert.notEqual(changes[0]!.commit, "");
    // the proposal is off the working branch, and the working tree is back to what it was
    assert.equal(existsSync(join(fx.root, "Components", "Pricing.dsx")), false);
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: fx.root, encoding: "utf8" }).trim(), "work");
    const branchLog = execFileSync("git", ["log", "--format=%s%n%b", changes[0]!.branch], { cwd: fx.root, encoding: "utf8" });
    assert.match(branchLog, /notes: add Components\/Pricing\.dsx/);
    assert.match(branchLog, /Despia-App: notes@1\.0\.0/);
  } finally {
    fx.cleanup();
  }
});

test("headless: an ungrated chain settles as a refused call — the seam, not the dialog", async () => {
  // the app holds project:read only; its tool tries to EDIT
  const fx = fixture(`<server>
  <head>
    <action as="audit" inputs="">
      const r = await dsx.module.studio.project.edit({ name: "Components/App.dsx", edits: [] })
      return { edited: r.ok == true, said: r.ok == true ? "" : r.error }
    </action>
  </head>
</server>
`, ["project:read"]);
  try {
    const result = await runAppTool(fx.root, "notes", "audit", {});
    // ERRORS ARE VALUES (error-system.md): the funnel refuses, the call settles
    // { ok: false, error }, and the body keeps running — the seam's proof is the
    // untouched file and the named grant, not a crash
    assert.ok(result.ok, JSON.stringify(result));
    const value = result.ok ? result.value as { edited: boolean; said: string } : { edited: true, said: "" };
    assert.equal(value.edited, false);
    assert.equal(value.said, "forbidden");
    assert.equal(readFileSync(join(fx.root, "Components", "App.dsx"), "utf8"), APP_DOC);
  } finally {
    fx.cleanup();
  }
});

test("headless: holds — a disabled app's tool is listed with the hold and refuses to run", async () => {
  const fx = fixture(AUDIT_DOC);
  try {
    mkdirSync(join(fx.root, ".despia", "apps"), { recursive: true });
    writeFileSync(join(fx.root, ".despia", "apps", "grants.json"), JSON.stringify({
      notes: { enabled: false, version: "1.0.0", grants: ["project:read", "project:write"], grantedAt: "x" },
    }));
    const tool = listAppTools(fx.root).find((t) => t.app === "notes");
    assert.match(tool?.hold ?? "", /disabled/);
    const result = await runAppTool(fx.root, "notes", "audit", {});
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /disabled/);
  } finally {
    fx.cleanup();
  }
});

test("headless: the MCP face — app tools list beside the toolchain's and the call runs the same body", async () => {
  const fx = fixture(AUDIT_DOC);
  try {
    const projected = appToolsFromProject(fx.root);
    const name = appToolName("notes", "audit");
    assert.ok(projected.some((t) => t.name === name), projected.map((t) => t.name).join(","));
    const listed = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined, fx.root) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.ok(listed.result.tools.some((t) => t.name === "despia_build"), "the toolchain tools vanished");
    assert.ok(listed.result.tools.some((t) => t.name === name), "the app tool did not project");
    const called = await handleRpc({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name, arguments: { note: "over mcp" } },
    }, undefined, fx.root) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(called.result.isError, false, called.result.content[0]?.text);
    assert.ok(called.result.content[0]!.text.includes('"kept": "over mcp"'));
  } finally {
    fx.cleanup();
  }
});

test("headless: unknown app and unknown tool answer typed refusals with the discovery verb named", async () => {
  const fx = fixture(AUDIT_DOC);
  try {
    const ghost = await runAppTool(fx.root, "ghost", "x", {});
    assert.equal(ghost.ok, false);
    if (!ghost.ok) assert.equal(ghost.reason, "not_found");
    const missing = await runAppTool(fx.root, "notes", "nope", {});
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.message, /despia app tools/);
  } finally {
    fx.cleanup();
  }
});
