//
//  strings-door.test.ts — the P12 authoring round trip: extraction mirrors the runtime's
//  display points, a table edit is a one-line diff by construction, and the registry
//  folds the project's tables so the shipped app actually carries them.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildRegistry } from "@despia/compiler";
import { loadConfig } from "../src/config.ts";
import { startEditServer as bootEditServer } from "../src/edit.ts";

//  THE ADMISSION CREDENTIAL (edit.ts). Every request under /edit carries this run's secret, so
//  these tests drive the door a browser drives: `startEditServer` is wrapped to remember what
//  the run minted, and `fetch` is shadowed to present it. A test that means to prove the
//  REFUSAL calls `bareFetch` on purpose — there is exactly one place that should, and it says
//  so where it does it.
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


const APP = `<stack>
  <text value="Welcome home"/>
  <text>Body copy</text>
  <text value="{{ dsx.variable.user }}"/>
  <button label="Save"/>
  <textfield placeholder="Email address"/>
  <button label="Save"/>
</stack>
`;

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-strings-door-"));
  for (const [path, contents] of Object.entries({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
  })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("the registry folds project Strings.<tag>.json tables for the boot loader", () => {
  const fx = project();
  writeFileSync(join(fx.root, "Strings.de.json"), '{"Save":"Sichern"}\n');
  writeFileSync(join(fx.root, "Strings.broken.json"), "{not json");
  try {
    const registry = buildRegistry([{ dir: fx.root, scheme: "fix", app: true }]);
    assert.deepEqual(registry.strings, { de: { Save: "Sichern" } },
      "the valid table rides; the unparsable one is no table (fail-open)");
    const bare = buildRegistry([{ dir: fx.root, scheme: "fix" }]);
    assert.equal(bare.strings, undefined, "only the application root contributes tables");
  } finally {
    fx.cleanup();
  }
});

test("the strings door: extraction, add-language, and the one-line-diff write", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // extraction mirrors the runtime's display points: static value/inner text/label/
    // placeholder count; the interpolated value does not; "Save" is used twice
    const fresh = (await (await fetch(`${base}/edit/api/strings`)).json()) as
      { languages: string[]; keys: Array<{ key: string; uses: number; values: { [l: string]: string } }> };
    assert.deepEqual(fresh.languages, []);
    assert.deepEqual(
      fresh.keys.map((k) => [k.key, k.uses]),
      [["Body copy", 1], ["Email address", 1], ["Save", 2], ["Welcome home", 1]],
    );

    // a language is one call; en is refused (it is the source, never a table)
    assert.equal((await fetch(`${base}/edit/api/strings`, { method: "PUT", body: JSON.stringify({ addLanguage: "en" }) })).status, 400);
    const added = await (await fetch(`${base}/edit/api/strings`, {
      method: "PUT", body: JSON.stringify({ addLanguage: "de" }),
    })).json() as { languages: string[] };
    assert.deepEqual(added.languages, ["de"]);

    // two writes land sorted; the third changes ONE key and the diff is ONE line
    for (const [key, value] of [["Save", "Sichern"], ["Welcome home", "Willkommen"]] as const) {
      await fetch(`${base}/edit/api/strings`, { method: "PUT", body: JSON.stringify({ lang: "de", key, value }) });
    }
    const before = readFileSync(join(fx.root, "Strings.de.json"), "utf8");
    assert.equal(before, '{\n  "Save": "Sichern",\n  "Welcome home": "Willkommen"\n}\n');
    await fetch(`${base}/edit/api/strings`, { method: "PUT", body: JSON.stringify({ lang: "de", key: "Save", value: "Speichern" }) });
    const after = readFileSync(join(fx.root, "Strings.de.json"), "utf8");
    const changed = after.split("\n").filter((line, i) => line !== before.split("\n")[i]);
    assert.deepEqual(changed, ['  "Save": "Speichern",'], "a table edit is a single-key, single-line change");

    // the union keeps a translated key whose source moved on, flagged uses=0
    await fetch(`${base}/edit/api/strings`, { method: "PUT", body: JSON.stringify({ lang: "de", key: "Old copy", value: "Alt" }) });
    const merged = (await (await fetch(`${base}/edit/api/strings`)).json()) as typeof fresh;
    const orphan = merged.keys.find((k) => k.key === "Old copy");
    assert.deepEqual(orphan, { key: "Old copy", uses: 0, values: { de: "Alt" } });

    // clearing a value drops the key; the language column survives its last cell
    await fetch(`${base}/edit/api/strings`, { method: "PUT", body: JSON.stringify({ lang: "de", key: "Old copy", value: "" }) });
    const cleared = (await (await fetch(`${base}/edit/api/strings`)).json()) as typeof fresh;
    assert.equal(cleared.keys.find((k) => k.key === "Old copy"), undefined);
    assert.deepEqual(cleared.languages, ["de"]);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("the nid door carries the node's static display string (the mapping view's hinge)", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // nid walk skips the head; App has none, so nid 1 = the first child (the text)
    const doc = encodeURIComponent("Components/App.dsx");
    const first = (await (await fetch(`${base}/edit/api/nid/${doc}?nid=1`)).json()) as { tag: string; display: string };
    assert.equal(first.tag, "text");
    assert.equal(first.display, "Welcome home");
    // the interpolated text carries NO display - dynamic content never maps to a row
    const dynamic = (await (await fetch(`${base}/edit/api/nid/${doc}?nid=3`)).json()) as { display: string };
    assert.equal(dynamic.display, "");
  } finally {
    await server.close();
    fx.cleanup();
  }
});
