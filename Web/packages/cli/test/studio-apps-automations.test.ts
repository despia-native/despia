//
//  The automation fold (studio-apps.md §7.2): a granted app's automation rows land in the
//  installing user's own server artifact — narrowed, consent-gated, draft-floored — and a
//  row that cannot land is a NAMED refusal that never sinks the build.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { collectAppAutomations, foldAutomations, appChain } from "../src/studio-apps/automations.ts";
import { readAppManifest } from "../src/studio-apps/manifest.ts";
import type { AppState, DiscoveredApp } from "../src/studio-apps/host.ts";
import { emitServerArtifacts } from "../src/server-document.ts";

const SERVER_DOC = `<server>
  <head>
    <egress host="api.acme.dev"/>
    <action as="draftNotes" inputs="release: string">
      return { drafted: release }
    </action>
  </head>
</server>
`;

function fixture(files: { [path: string]: string }): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-auto-"));
  const all: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App", packages: ["packages/acme"] }),
    "Components/App.dsx": `<stack><text value="hi"/></stack>\n`,
    //  THE RECORDED CONSENT. A build never seeds it — seeding is the Studio's act, and a
    //  build that seeded would put an app's automation into a deployment because a framework
    //  tree happened to sit above the project. A real project that has opened the Apps panel
    //  has this file; a fixture that wants the fold has to have it too.
    ".despia/apps/grants.json": JSON.stringify({
      acme: { enabled: true, version: "1.0.0", grants: ["automation:deploy", "net:api.acme.dev"], grantedAt: "2026-08-28T00:00:00Z" },
    }),
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

function acmeManifest(row: Record<string, unknown>): string {
  return JSON.stringify({
    name: "Acme", scheme: "acme", version: "1.0.0", studioApi: 1,
    facets: { apps: { notes: row } },
  });
}

const AUTOMATION_ROW = {
  slot: "automation",
  on: "platform.release.published",
  run: "Server/Automations.dsx#draftNotes",
  mode: "draft",
  grants: ["automation:deploy", "net:api.acme.dev"],
};

/** An INSTALLED-kind app over a fixture dir — the tier whose consent is a real gate
 *  (dev/builtin grants track the manifest by design, so they cannot model refusals). */
function installedApp(dir: string, manifestJson: string): DiscoveredApp {
  const { info, issues } = readAppManifest(JSON.parse(manifestJson));
  assert.equal(issues.length, 0, issues.map((i) => i.code).join(","));
  assert.ok(info !== null);
  return { kind: "installed", dir: join(dir, "packages/acme"), info, lockId: "github:acme/app" };
}

test("automations: a granted dev app's automation folds — namespaced chain, draft mode", () => {
  const fx = fixture({
    "packages/acme/dsx.json": acmeManifest(AUTOMATION_ROW),
    "packages/acme/Server/Automations.dsx": SERVER_DOC,
  });
  try {
    const fold = collectAppAutomations(fx.root);
    // the repo's own preinstalled apps (Marketing Studio) fold beside the fixture's — the
    // assertions scope to the fixture app so a first-party addition never breaks them
    assert.deepEqual(fold.refusals.filter((r) => r.app === "acme"), []);
    const acme = fold.automations.filter((a) => a.app === "acme");
    assert.equal(acme.length, 1);
    const a = acme[0]!;
    assert.equal(a.chain, appChain("acme"));
    assert.equal(a.on, "platform.release.published");
    assert.equal(a.action, "draftNotes");
    assert.equal(a.mode, "draft");
    assert.ok(fold.docs.some((d) => d.chain === "app_acme"));
  } finally {
    fx.cleanup();
  }
});

test("automations: the emitted barrel carries the binding and the handler — with or without a project server", () => {
  const fx = fixture({
    "packages/acme/dsx.json": acmeManifest(AUTOMATION_ROW),
    "packages/acme/Server/Automations.dsx": SERVER_DOC,
  });
  try {
    const fold = collectAppAutomations(fx.root);
    const result = emitServerArtifacts(fx.root, { apps: { docs: fold.docs, automations: fold.automations } });
    assert.ok(result !== null, "an installed automation creates the server artifact even with no project server/");
    assert.ok(result.automations >= 1);
    const barrel = readFileSync(join(fx.root, "server", "generated", "index.ts"), "utf8");
    assert.ok(barrel.includes("export const automations"), "no automations export");
    assert.ok(barrel.includes('"chain": "app_acme"'));
    assert.ok(barrel.includes('"app_acme": {'), "the app chain has no handler entry");
    assert.ok(barrel.includes("draftNotes: declaredHandler({"), "the automation action compiled no handler");
    assert.ok(barrel.includes('"api.acme.dev"'), "the granted egress did not reach the handler row");
  } finally {
    fx.cleanup();
  }
});

test("automations: consent gates — no automation:deploy grant, no fold; the refusal names the panel", () => {
  const fx = fixture({
    "packages/acme/dsx.json": acmeManifest(AUTOMATION_ROW),
    "packages/acme/Server/Automations.dsx": SERVER_DOC,
  });
  try {
    const app = installedApp(fx.root, acmeManifest(AUTOMATION_ROW));
    // enabled, but the person granted NOTHING — the seam holds regardless of any dialog
    const state: AppState = { acme: { enabled: true, version: "1.0.0", grants: [], grantedAt: "2026-01-01T00:00:00Z" } };
    const fold = foldAutomations([app], state, { acme: "1.0.0" });
    assert.equal(fold.automations.length, 0);
    assert.equal(fold.refusals.length, 1);
    assert.match(fold.refusals[0]!.reason, /automation:deploy/);

    // disabled holds too, before any grant question
    const off = foldAutomations([app], { acme: { enabled: false, version: "1.0.0", grants: [], grantedAt: "" } });
    assert.match(off.refusals[0]!.reason, /disabled/);
  } finally {
    fx.cleanup();
  }
});

test("automations: the narrowing — routes, entities or budget rows in an app document refuse", () => {
  const wide = `<server>
  <head>
    <entity as="orders" ownership="owner">
      <field as="total" type="real"/>
    </entity>
    <action as="draftNotes" inputs="release: string">return null</action>
  </head>
</server>
`;
  const manifest = acmeManifest({ ...AUTOMATION_ROW, grants: ["automation:deploy"] });
  const fx = fixture({
    "packages/acme/dsx.json": manifest,
    "packages/acme/Server/Automations.dsx": wide,
  });
  try {
    const fold = foldAutomations([installedApp(fx.root, manifest)],
      { acme: { enabled: true, version: "1.0.0", grants: ["automation:deploy"], grantedAt: "x" } },
      { acme: "1.0.0" });
    assert.equal(fold.automations.length, 0);
    assert.match(fold.refusals[0]!.reason, /entities/);
  } finally {
    fx.cleanup();
  }
});

test("automations: egress beyond the granted net: hosts refuses with the host named", () => {
  const manifest = acmeManifest({ ...AUTOMATION_ROW, grants: ["automation:deploy"] });
  const fx = fixture({
    "packages/acme/dsx.json": manifest,
    "packages/acme/Server/Automations.dsx": SERVER_DOC,
  });
  try {
    const fold = foldAutomations([installedApp(fx.root, manifest)],
      { acme: { enabled: true, version: "1.0.0", grants: ["automation:deploy"], grantedAt: "x" } },
      { acme: "1.0.0" });
    assert.equal(fold.automations.length, 0);
    assert.match(fold.refusals[0]!.reason, /api\.acme\.dev/);
  } finally {
    fx.cleanup();
  }
});

test("automations: a widened manifest holds until re-consent — auto asked, only deploy granted", () => {
  const manifest = acmeManifest({
    ...AUTOMATION_ROW,
    mode: "auto",
    grants: ["automation:deploy", "automation:auto", "net:api.acme.dev"],
  });
  const fx = fixture({
    "packages/acme/dsx.json": manifest,
    "packages/acme/Server/Automations.dsx": SERVER_DOC,
  });
  try {
    // consent recorded BEFORE the manifest asked for auto — the widened set holds everything
    const fold = foldAutomations([installedApp(fx.root, manifest)],
      { acme: { enabled: true, version: "1.0.0", grants: ["automation:deploy", "net:api.acme.dev"], grantedAt: "x" } },
      { acme: "1.0.0" });
    assert.equal(fold.automations.length, 0);
    assert.match(fold.refusals[0]!.reason, /re-consent/);
  } finally {
    fx.cleanup();
  }
});

test("automations: mode=auto with full consent runs auto; dev apps track the manifest and fold clean", () => {
  const manifest = acmeManifest({
    ...AUTOMATION_ROW,
    mode: "auto",
    grants: ["automation:deploy", "automation:auto", "net:api.acme.dev"],
  });
  const fx = fixture({
    "packages/acme/dsx.json": manifest,
    "packages/acme/Server/Automations.dsx": SERVER_DOC,
  });
  try {
    const fold = foldAutomations([installedApp(fx.root, manifest)],
      { acme: { enabled: true, version: "1.0.0", grants: ["automation:deploy", "automation:auto", "net:api.acme.dev"], grantedAt: "x" } },
      { acme: "1.0.0" });
    assert.equal(fold.refusals.length, 0);
    assert.equal(fold.automations[0]!.mode, "auto");
  } finally {
    fx.cleanup();
  }
});

test("automations: a project server chain colliding with the app_ namespace refuses at emit", () => {
  const fx = fixture({
    "packages/acme/dsx.json": acmeManifest(AUTOMATION_ROW),
    "packages/acme/Server/Automations.dsx": SERVER_DOC,
    "server/app_acme.dsx": `<server>
  <head>
    <action as="x" inputs="">return 1</action>
  </head>
  <route path="/x" method="GET" action="x"/>
</server>
`,
  });
  try {
    const fold = collectAppAutomations(fx.root);
    assert.throws(
      () => emitServerArtifacts(fx.root, { apps: { docs: fold.docs, automations: fold.automations } }),
      /app_ prefix is reserved/,
    );
  } finally {
    fx.cleanup();
  }
});
