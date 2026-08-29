//
//  deploy.test.ts — `deploy/` is emitted by the SHIPPED toolchain (plan E1).
//
//  The defect these pin: a `<server>` document built through the published CLI produced
//  generated tables and nothing that could run them, because the worker entry and the wrangler
//  manifest were emitted only by a script that ships with the commercial layer. The emitter now
//  lives in the open drop and both callers render the same plan, so what is tested here is what
//  a customer gets.
//

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cloudflareDeploy, DeployPlanError } from "@despia/server/deploy";

import { buildProject } from "../src/build.ts";
import { loadConfig } from "../src/config.ts";
import { workerName } from "../src/deploy.ts";
import { runCli } from "../src/cli.ts";

const APP = `<stack><text value="hello"/></stack>\n`;

const SERVER = `<server>
  <head>
    <entity as="note" ownership="owner">
      <field as="title" type="text"/>
    </entity>
    <action as="health">
      return { up: true }
    </action>
  </head>

  <route method="GET" path="/health" action="health"/>
  <route method="GET" path="/notes" entity="note" op="list" auth="required"/>
</server>
`;

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-deploy-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "Notes App", scheme: "notes" }),
    "dsx.config.json": JSON.stringify({ name: "Notes App", entry: "App" }),
    "Components/App.dsx": APP,
    "server/api.dsx": SERVER,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("deploy: a project build emits deploy/ with a worker entry and a wrangler manifest", () => {
  const fx = project();
  try {
    const config = loadConfig(fx.root);
    const result = buildProject(config);
    assert.deepEqual(result.deploy, ["deploy/cloudflare/worker/index.ts", "deploy/cloudflare/wrangler.jsonc"]);

    const manifest = readFileSync(join(fx.root, "deploy", "cloudflare", "wrangler.jsonc"), "utf8");
    const doc = JSON.parse(manifest.split("\n").filter((l) => !l.startsWith("//")).join("\n")) as {
      name: string; main: string; assets?: { directory: string; binding: string }; triggers?: unknown;
      limits?: { cpu_ms: number }; hyperdrive?: { binding: string; id: string }[];
    };
    assert.equal(doc.name, "notes-app");
    assert.equal(doc.main, "worker/index.ts");
    //  THE SITE HALF: the manifest binds the build output, so ONE deploy serves the app and
    //  its route table. Without it `deploy cloudflare` published a backend and nothing else.
    assert.equal(doc.assets?.binding, "ASSETS");
    assert.equal(doc.assets?.directory, "../../dist");
    assert.ok(existsSync(join(fx.root, doc.assets!.directory.replace("../../", ""))), "the bound directory must exist");
    // No worker rows and no schedules in this document, so nothing is scheduled.
    assert.equal(doc.triggers, undefined);

    const worker = readFileSync(join(fx.root, "deploy", "cloudflare", "worker", "index.ts"), "utf8");
    assert.match(worker, /from "@despia\/server\/bootloader-workers"/);
    assert.match(worker, /from "\.\.\/\.\.\/\.\.\/server\/generated\/index\.ts"/);
    assert.match(worker, /siteRegistry/, "the worker must serve the built site");
    assert.ok(existsSync(join(fx.root, "dist", "registry.json")));
    //  THE SPEND PLANE RIDES THE ENTRY (cost-guardrails.md): the project shape has no
    //  serverConfig, so the barrel's merged ceilings are the ONLY way the guarded defaults
    //  reach the host — a deployment shipped without them would be unguarded on exactly
    //  the path a customer takes.
    assert.match(worker, /\bspendBudgets\b.*from "\.\.\/\.\.\/\.\.\/server\/generated\/index\.ts"/s, "the worker must import the merged spend plane");
    assert.match(worker, /spend: spendBudgets/, "the worker must hand the ceilings to the host");
    //  THE PLATFORM ATTACHMENT (cost-guardrails.md G6). This ceiling was set only on the
    //  monorepo path, so the guardrail a customer read about was the one their own deploy did
    //  not carry — the same divergence class as the system tables.
    assert.deepEqual(doc.limits, { cpu_ms: 5000 });
    //  No Hyperdrive configured is an ABSENCE, not a failure: the worker reaches the database
    //  directly through the address secret. It is a performance attachment, never a requirement.
    assert.equal(doc.hyperdrive, undefined);

    // Idempotent: a second build over unchanged sources leaves the same bytes.
    const before = readFileSync(join(fx.root, "deploy", "cloudflare", "worker", "index.ts"));
    buildProject(loadConfig(fx.root));
    assert.deepEqual(readFileSync(join(fx.root, "deploy", "cloudflare", "worker", "index.ts")), before);
  } finally {
    fx.cleanup();
  }
});

test("deploy: a project with no backend emits no deploy/, and a removed one is cleaned up", () => {
  const fx = project();
  try {
    buildProject(loadConfig(fx.root));
    assert.ok(existsSync(join(fx.root, "deploy", "cloudflare", "wrangler.jsonc")));
    rmSync(join(fx.root, "server"), { recursive: true, force: true });
    const result = buildProject(loadConfig(fx.root));
    assert.deepEqual(result.deploy, []);
    assert.ok(!existsSync(join(fx.root, "deploy", "cloudflare")), "a stale worker was left for someone to deploy");
  } finally {
    fx.cleanup();
  }
});

test("deploy: the emitter refuses a plan Cloudflare would reject", () => {
  const base = {
    shape: "project" as const,
    generator: "`despia build`",
    secretsNote: "`despia deploy cloudflare` prints the `wrangler secret put` command for each one.",
    barrel: "../../../server/generated/index.ts",
    wrangler: {
      name: "my_worker",
      main: "worker/index.ts",
      compatibility_date: "2025-08-01",
      compatibility_flags: ["nodejs_compat"],
      observability: true,
      crons: [],
    },
  };
  //  An underscore is a name Cloudflare refuses, and it used to be discovered at the END of a
  //  deploy — after the bundle and after the secrets.
  assert.throws(() => cloudflareDeploy(base), DeployPlanError);
  assert.throws(
    () => cloudflareDeploy({ ...base, wrangler: { ...base.wrangler, name: "ok" }, barrel: "" }),
    DeployPlanError,
  );
  assert.doesNotThrow(() => cloudflareDeploy({ ...base, wrangler: { ...base.wrangler, name: "ok-worker" } }));
});

test("deploy: a worker name is always deployable, whatever the project is called", () => {
  const cases: [string, string][] = [
    ["Notes App", "notes-app"],
    ["my_app", "my-app"],
    ["  Trailing --- ", "trailing"],
    ["!!!", "dsx-app"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(workerName({ name, scheme: "s" } as never), expected, name);
  }
});

test("deploy: the CLI verb plans without changing anything, and refuses an unbuilt project", async () => {
  const fx = project();
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  try {
    //  Nothing built yet: the command must say what to run, not deploy an absent manifest.
    const missing = await runCli(["deploy", "cloudflare", "--project", fx.root], io);
    assert.equal(missing, 3, "an absent manifest is `not_found` → exit 3");
    assert.match(lines.join("\n"), /despia build/);

    buildProject(loadConfig(fx.root));
    lines.length = 0;
    const planned = await runCli(["deploy", "cloudflare", "--plan", "--project", fx.root], io);
    assert.equal(planned, 0);
    const printed = lines.join("\n");
    assert.match(printed, /PLAN ONLY/);
    assert.match(printed, /npx wrangler deploy --config deploy\/cloudflare\/wrangler\.jsonc/);
    assert.match(printed, /wrangler secret put/);
    assert.match(printed, /Nothing was changed\./);

    // Planning IS the default — `--plan` is documentation, not a mode switch.
    lines.length = 0;
    assert.equal(await runCli(["deploy", "cloudflare", "--project", fx.root], io), 0);
    assert.match(lines.join("\n"), /target cloudflare/);
    assert.match(lines.join("\n"), /PLAN ONLY/);

    // A target is REQUIRED: guessing which account to publish to is the one thing a deploy
    // command must never do. The refusal is the usage text, not a default.
    lines.length = 0;
    assert.equal(await runCli(["deploy", "--project", fx.root], io), 2);
    assert.match(lines.join("\n"), /<target> is required/);

    lines.length = 0;
    assert.equal(await runCli(["deploy", "nowhere", "--project", fx.root], io), 2, "an unknown target is a usage error");

    // --plan and --apply together resolve silently either way into something nobody meant.
    lines.length = 0;
    assert.equal(await runCli(["deploy", "cloudflare", "--plan", "--apply", "--project", fx.root], io), 2);
    assert.match(lines.join("\n"), /contradict each other/);
  } finally {
    fx.cleanup();
  }
});

//  ── THE BYTE-IDENTITY GATE (plan E1 §3) ────────────────────────────────────────────────
//
//  The whole point of moving the emitter is that the closed pipeline and a customer's CLI
//  cannot drift. `prepare_server.rb --print-deploy-plan` prints exactly what it hands the
//  emitter and writes nothing; rendering that plan here must reproduce, byte for byte, the
//  tree it actually wrote. If this ever fails, the move has been undone.
test("deploy: the closed pipeline's emitted tree is byte-identical to the open emitter's", () => {
  const repo = join(import.meta.dirname, "..", "..", "..", "..", "..");
  const script = join(repo, "ClosedSource", "scripts", "prepare_server.rb");
  const emitted = join(repo, "OpenSource", "Web", "packages", "server", "deploy", "cloudflare");
  if (!existsSync(script) || !existsSync(emitted)) return; // published checkout: nothing closed to compare against
  const plan = execFileSync("ruby", [script, "--print-deploy-plan"], { cwd: repo, encoding: "utf8" });
  const files = cloudflareDeploy(JSON.parse(plan));
  for (const [rel, body] of Object.entries(files)) {
    const onDisk = readFileSync(join(repo, "OpenSource", "Web", "packages", "server", "deploy", rel), "utf8");
    assert.equal(body, onDisk, `${rel} differs between the two emitters`);
  }
});

test("deploy: a connected Hyperdrive is wired automatically — nobody is asked to understand it", () => {
  //  The customer connects Cloudflare once; the connect flow leaves the configuration id in the
  //  environment, and the manifest carries the binding the Workers bootloader already maps onto
  //  the database address. Before this, the standalone path had no Hyperdrive support at all
  //  while the monorepo pipeline did — so a customer's own deploy silently lost the pooling.
  const fx = project();
  const prior = process.env["DSX_CLOUDFLARE_HYPERDRIVE_ID"];
  process.env["DSX_CLOUDFLARE_HYPERDRIVE_ID"] = "hd_abc123";
  try {
    buildProject(loadConfig(fx.root));
    const manifest = readFileSync(join(fx.root, "deploy", "cloudflare", "wrangler.jsonc"), "utf8");
    const doc = JSON.parse(manifest.split("\n").filter((l) => !l.startsWith("//")).join("\n")) as {
      hyperdrive?: { binding: string; id: string }[];
    };
    assert.deepEqual(doc.hyperdrive, [{ binding: "HYPERDRIVE", id: "hd_abc123" }]);
  } finally {
    if (prior === undefined) delete process.env["DSX_CLOUDFLARE_HYPERDRIVE_ID"];
    else process.env["DSX_CLOUDFLARE_HYPERDRIVE_ID"] = prior;
    fx.cleanup();
  }
});
