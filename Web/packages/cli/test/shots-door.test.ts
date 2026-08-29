//
//  shots-door.test.ts — /edit/api/shots: the Distribution surface's door.
//
//  THE FILE IS THE STATE. The board reads and writes `dsx.shots.json`, the same file
//  `despia shot` captures from, so there is no editor-side copy of a screenshot set that can
//  drift from the one that ships. These tests hold that: what the door serves is what is on
//  disk, what it writes survives a round trip, and the keys the board does not know about
//  are still there afterwards.
//
//  THE SCOPE IS RESOLVED, NOT DESCRIBED. The Data panel's rows come from `resolveShotScope`
//  — the capture's own resolver — so a row's TIER is the tier the image will really use and
//  an unresolved row is the capture's refusal shown before anyone waits for a render.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { startEditServer as bootEditServer } from "../src/edit.ts";

//  THE ADMISSION CREDENTIAL (edit.ts): every request under /edit carries this run's secret,
//  exactly as the browser door does - startEditServer is wrapped to remember what the run
//  minted, and fetch is shadowed to present it.
const bareFetch = globalThis.fetch;
let admission = "";
async function startEditServer(...args: Parameters<typeof bootEditServer>): ReturnType<typeof bootEditServer> {
  const server = await bootEditServer(...args);
  admission = server.admission;
  return server;
}
function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (admission !== "" && !headers.has("x-despia-edit")) headers.set("x-despia-edit", admission);
  return bareFetch(input as string, { ...init, headers });
}

const ORDERS = `<stack>
  <head>
    <attribute as="title" sample="&quot;Today&quot;"/>
    <attribute as="badge" default="'0'"/>
    <attribute as="owner"/>
    <expects variable="session"/>
    <variable as="filter">return 'all'</variable>
    <variable as="shown" computed="true">return filter</variable>
    <api as="orders" url="/api/orders" sample="[]"/>
    <api as="feed" url="/api/feed"/>
  </head>
  <text value="{{ dsx.attribute.title }}"/>
</stack>
`;

function project(shots?: unknown): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-shots-door-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "Orders" }),
    "Components/Orders.dsx": ORDERS,
  };
  if (shots !== undefined) files["dsx.shots.json"] = `${JSON.stringify(shots, null, 2)}\n`;
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("a project with no shots file serves an empty set rather than an error", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/edit/api/shots`);
    assert.equal(res.status, 200, "an unstarted listing is a legitimate state, not a 404");
    const body = await res.json() as { shots: unknown[]; device: string; schema: unknown; scopes: object };
    assert.deepEqual(body.shots, []);
    assert.equal(body.device, "iphone-6.9", "the set's device falls back to the default size");
    assert.notEqual(body.schema, null, "the inspector schema rides with the set");
    assert.deepEqual(body.scopes, {});
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("the scope rows carry the tier each value will really be rendered from", async () => {
  const fx = project({
    hydrate: { global: { session: { name: "Ada" }, theme: "dark" } },
    shots: [{ document: "Orders", as: "01-orders", vars: { badge: "7" } }],
  });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/edit/api/shots`);
    const body = await res.json() as {
      scopes: { [as: string]: { ok: boolean; missing: boolean; document: string;
                                rows: Array<{ kind: string; name: string; value: string; tier: string; over: boolean; fix: string }> } };
    };
    const scope = body.scopes["01-orders"]!;
    assert.equal(scope.document, "Orders");
    assert.equal(scope.missing, false);
    const row = (kind: string, name: string) => scope.rows.find((r) => r.kind === kind && r.name === name)!;

    assert.equal(row("attribute", "title").tier, "sample", "a declared sample= is the sample tier");
    assert.equal(row("attribute", "title").value, "Today");
    assert.equal(row("attribute", "badge").tier, "override", "the slide's own vars outrank everything");
    assert.equal(row("attribute", "badge").value, "7");
    assert.equal(row("attribute", "badge").over, true, "an overridden row says so, because clearing it is a real action");
    assert.equal(row("attribute", "owner").tier, "unresolved",
      "no override, sample or default: the capture would refuse, and the panel says so first");
    assert.notEqual(row("attribute", "owner").fix, "", "an unresolved row carries the resolver's own fix line");

    assert.equal(row("expects", "session").tier, "hydrate", "the project plane is the floor for seeded state");
    assert.equal(row("variable", "filter").tier, "body", "a variable with a body resolves itself");
    assert.equal(scope.rows.find((r) => r.name === "shown"), undefined,
      "a computed variable has no leaf to seed - seeding its inputs is the only honest edit");
    assert.equal(row("api", "orders").tier, "sample");
    assert.equal(row("api", "feed").tier, "unresolved", "an api with no sample would render a spinner");
    assert.equal(row("global", "theme").tier, "hydrate");
    assert.equal(row("global", "theme").value, "dark");
    assert.equal(scope.ok, false, "one unresolved row is the whole slide's verdict");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("a write round trips and keeps the keys the board does not know about", async () => {
  const fx = project({
    outDir: "store",
    environment: { channel: "staging", baseUrl: "https://staging.example" },
    shots: [{ document: "Orders", as: "01-orders" }],
  });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const put = await fetch(`${base}/edit/api/shots`, {
      method: "PUT",
      body: JSON.stringify({
        shots: [{ document: "Orders", as: "01-orders", vars: { title: "Inbox" } },
                { document: "Orders", as: "02-orders" }],
        hydrate: { global: { theme: "light" } },
      }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true, shots: 2 });

    const onDisk = JSON.parse(readFileSync(join(fx.root, "dsx.shots.json"), "utf8")) as {
      outDir: string; environment: { channel: string }; shots: unknown[]; hydrate: unknown;
    };
    assert.equal(onDisk.outDir, "store", "a writer that emitted only what it understands deletes the rest");
    assert.equal(onDisk.environment.channel, "staging",
      "the egress channel declaration is not the board's to drop");
    assert.equal(onDisk.shots.length, 2);
    assert.deepEqual(onDisk.hydrate, { global: { theme: "light" } });

    const back = await (await fetch(`${base}/edit/api/shots`)).json() as {
      shots: Array<{ as: string }>; hydrate: { global: { theme: string } };
    };
    assert.deepEqual(back.shots.map((s) => s.as), ["01-orders", "02-orders"]);
    assert.equal(back.hydrate.global.theme, "light");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("a write that is not a whole set is refused rather than half applied", async () => {
  const fx = project({ shots: [{ document: "Orders", as: "01-orders" }] });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const bad = await fetch(`${base}/edit/api/shots`, { method: "PUT", body: "{not json" });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { reason: string }).reason, "bad_json");

    const partial = await fetch(`${base}/edit/api/shots`, { method: "PUT", body: JSON.stringify({ hydrate: {} }) });
    assert.equal(partial.status, 400);
    assert.equal(((await partial.json()) as { reason: string }).reason, "bad_write");

    const still = JSON.parse(readFileSync(join(fx.root, "dsx.shots.json"), "utf8")) as { shots: unknown[] };
    assert.equal(still.shots.length, 1, "a refused write leaves the file exactly as it was");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("a slide naming a document that is not in the project says so instead of vanishing", async () => {
  const fx = project({ shots: [{ document: "Ghost", as: "01-ghost" }] });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.port}/edit/api/shots`)).json() as {
      scopes: { [as: string]: { missing: boolean; ok: boolean; rows: unknown[] } };
    };
    assert.equal(body.scopes["01-ghost"]!.missing, true);
    assert.equal(body.scopes["01-ghost"]!.ok, false);
    assert.deepEqual(body.scopes["01-ghost"]!.rows, []);
  } finally {
    await server.close();
    fx.cleanup();
  }
});
