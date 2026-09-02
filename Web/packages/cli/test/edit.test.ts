//
//  edit.test.ts — the `despia edit` loop (v0-live-plan W8), run against a real fixture project:
//  the editor page and the package's own scripts serve, the document API lists and reads,
//  a SAVE writes the actual file and the dev server's watcher turns it into a rebuild plus
//  a reload event on the existing SSE channel — the whole local loop, no hosted anything.
//  The write boundary is exercised the way site-node's is: traversal names, foreign
//  extensions and empty bodies are refused with nothing written.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { RELOAD_PATH, STATE_PATH } from "../src/dev.ts";
import { resolveEditor, startEditServer as bootEditServer } from "../src/edit.ts";

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


const APP = `<stack><head><variable as="n">return 7</variable></head><text value="n is {{ dsx.variable.n }}"/></stack>\n`;

/** A project with EXTRA documents beside the base fixture, for surfaces that need one. */
function tempProject(extra: { [path: string]: string }): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-edit-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
    ...extra,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-edit-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": APP,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("edit: the whole local loop — serve, list, read, save, rebuild, reload", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // /edit now serves the DSX EDITOR (M1): the chrome is the editor's own .dsx documents,
    // compiled by our own compiler. `/edit` redirects to `/edit/` because the emitted document
    // addresses its runtime relatively — without the slash those resolve against the root,
    // i.e. the developer's own project. The engine-driven proof that the served page actually
    // WORKS is packages/dom/oracle/editor-browser.ts; this asserts the mount.
    const redirect = await fetch(`${base}/edit`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/edit/");
    const page = await fetch(`${base}/edit/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("<title>Despia Studio</title>"), "the DSX editor did not serve");
    assert.ok(html.includes('src="./main.js"'), "the editor page carries no relative bootloader");
    assert.ok(!html.includes('href="/manifest.webmanifest"'), "an absolute manifest href escapes the mount");
    // Its compiled payload serves from the same mount, never from the project's root.
    assert.equal((await fetch(`${base}/edit/registry.json`)).status, 200);

    for (const script of ["/edit/sdk.js", "/edit/element.js"]) {
      const res = await fetch(`${base}${script}`);
      assert.equal(res.status, 200, script);
      assert.ok((await res.text()).length > 1000, `${script} is not the editor package`);
    }

    const list = (await (await fetch(`${base}/edit/api/documents`)).json()) as { documents: string[] };
    assert.deepEqual(list.documents, ["Components/App.dsx"]);

    const doc = await fetch(`${base}/edit/api/documents/${encodeURIComponent("Components/App.dsx")}`);
    assert.equal(await doc.text(), APP);

    // Subscribe to the reload channel BEFORE saving; the watcher must turn the write into
    // an event without the editor owning any second pipeline.
    const reload = await fetch(`${base}${RELOAD_PATH}`);
    const reader = reload.body!.getReader();
    const sawReload = (async () => {
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        text += decoder.decode(value, { stream: true });
        // a component-body edit rides the SWAP lane (master plan P2) — same channel,
        // in-place remount instead of a page load; a structural edit still says reload
        if (text.includes("event: swap") || text.includes("event: reload")) return true;
      }
    })();

    const edited = APP.replace("n is", "count is");
    const saved = await fetch(`${base}/edit/api/documents/${encodeURIComponent("Components/App.dsx")}`, { method: "PUT", body: edited });
    assert.equal(saved.status, 200);
    assert.equal(readFileSync(join(fx.root, "Components", "App.dsx"), "utf8"), edited, "the save reaches the file");

    const reloaded = await Promise.race([
      sawReload,
      // Generous on purpose: this waits on a filesystem watcher and a rebuild, and the suite
      // runs beside a CPU-bound fuzz. A short budget here fails the watcher for being busy.
      new Promise<false>((done) => setTimeout(() => done(false), 30_000)),
    ]);
    assert.equal(reloaded, true, "the watcher never announced the rebuild");
    await reader.cancel();

    // the app itself still serves beside the editor — the mount owns only /edit/*
    const app = await fetch(`${base}/`);
    assert.equal(app.status, 200);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: /edit/api/nid maps a runtime pick back to the source address (master plan P5)", async () => {
  const fx = project();
  // three body elements AFTER a head: nid preorder skips the head subtree entirely,
  // so nid 0 = the root, nid 1 = the FIRST BODY child at source index 1 (head sits at 0)
  writeFileSync(join(fx.root, "Components", "App.dsx"),
    `<stack><head><variable as="n">return 7</variable></head><text value="a"/><stack><text value="b"/></stack><button label="c"/></stack>\n`);
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  const doc = encodeURIComponent("Components/App.dsx");
  try {
    const at = async (nid: number): Promise<{ path: string; parent: string | null; index: number | null; tag: string }> =>
      (await (await fetch(`${base}/edit/api/nid/${doc}?nid=${nid}`)).json()) as never;
    assert.deepEqual(await at(0), { document: "Components/App.dsx", nid: 0, path: "", parent: null, index: null, tag: "stack", display: "" });
    assert.equal((await at(1)).path, "1", "the head child is skipped, not renumbered");
    assert.equal((await at(1)).tag, "text");
    assert.equal((await at(2)).path, "2");
    assert.equal((await at(3)).path, "2.0", "preorder descends before it advances");
    assert.equal((await at(4)).tag, "button");
    assert.equal((await at(4)).parent, "");
    assert.equal((await at(4)).index, 3);
    assert.equal((await fetch(`${base}/edit/api/nid/${doc}?nid=99`)).status, 404);
    assert.equal((await fetch(`${base}/edit/api/nid/${doc}?nid=-1`)).status, 400);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the write boundary refuses traversal, foreign extensions, and empty bodies", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  const putDoc = (name: string, body: string): Promise<Response> =>
    fetch(`${base}/edit/api/documents/${encodeURIComponent(name)}`, { method: "PUT", body });
  try {
    for (const name of ["../evil.dsx", "Components/../../evil.dsx", "dsx.config.json", "Components/App.txt"]) {
      const res = await putDoc(name, "<stack/>");
      assert.equal(res.status, 404, name);
    }
    assert.equal((await putDoc("Components/App.dsx", "")).status, 400, "an empty write is a refusal, not a wipe");
    assert.equal(readFileSync(join(fx.root, "Components", "App.dsx"), "utf8"), APP, "nothing was written");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: two runs over one checkout do not share a chrome build directory", () => {
  // The chrome used to compile into a directory keyed by the MODULE path, so the Studio
  // self-hosted beside the app you are building meant two builds into one directory at once.
  // The loser died mid-copy and served the plain source pane, which reads as the DSX editor
  // being broken for a reason that has nothing to do with the editor. The chrome is rebuilt
  // on every start regardless, so the shared path bought no reuse and only cost that race.
  const a = project();
  const b = project();
  try {
    const first = resolveEditor(a.root);
    const second = resolveEditor(b.root);
    assert.ok(first?.dsxDir !== undefined && second?.dsxDir !== undefined, "the DSX chrome did not compile");
    assert.notEqual(first.dsxDir, second.dsxDir, "two runs write the chrome into one directory");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("edit: the editor packages resolve from the repository when the project carries none", () => {
  const fx = project();
  try {
    const editor = resolveEditor(fx.root);
    assert.ok(editor !== null, "the repo walk-up must find OpenSource/CanvasEditor");
    assert.ok(readFileSync(editor.sdk, "utf8").includes("StackCanvas"));
    // W8.3: the logic editor rides the same surface once imported to OpenSource/LogicEditor.
    assert.ok(editor.logicSdk !== undefined, "the repo walk-up must find OpenSource/LogicEditor");
    assert.ok(readFileSync(editor.logicSdk, "utf8").includes("StackLogic"));
  } finally {
    fx.cleanup();
  }
});

test("edit: the logic surface serves beside the DSX chrome — resolved, not yet consumed", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // NAMED GAP, asserted rather than assumed: the logic editor's SDK resolves and serves,
    // and the DSX chrome does NOT load it yet — the visual logic surface is still to build.
    // The old page referenced these scripts; the DSX one does not, and pretending otherwise
    // by keeping the old assertion would have hidden which of the two is true.
    for (const script of ["/edit/logic-sdk.js", "/edit/logic-element.js"]) {
      const res = await fetch(`${base}${script}`);
      assert.equal(res.status, 200, script);
    }
    assert.ok(!(await (await fetch(`${base}/edit/`)).text()).includes("logic-sdk.js"),
      "the DSX chrome now loads the logic SDK — update this gap note, it has closed");
    assert.ok((await (await fetch(`${base}/edit/logic-element.js`)).text()).includes("despia-logic-editor"));
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// ── the STRUCTURAL loop: the three endpoints the DSX editor actually calls ─────────────
//
//  The editor's tree panel, inspector and every visual gesture ride these. They were the
//  gap that made the editor a mockup: the .dsx documents called /edit/api/tree, /node and
//  /edit, and the server answered 404 to all three, so the panels rendered their empty
//  states forever and nothing said why.

const TREE_DOC = `<stack class="shell" style="gap: 1rem; padding: 8px">
  <head>
    <variable as="n">return 7</variable>
  </head>
  <hstack class="bar">
    <text value="Title"/>
    <button label="Go"/>
  </hstack>
</stack>
`;

function treeProject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-edit-tree-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": TREE_DOC,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

const DOC = encodeURIComponent("Components/App.dsx");

type Row = { id: string; parent: string | null; tag: string; label: string; depth: number; hasChildren: boolean };

test("edit: the tree endpoint addresses every element, labelled by what the author wrote", async () => {
  const fx = treeProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const res = await fetch(`${base}/edit/api/tree/${DOC}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { document: string; rows: Row[] };
    assert.equal(body.document, "Components/App.dsx");
    // THE TREE IS THE BODY: the <head> is state and logic, which has its own surface
    // (the data-store view over /edit/api/logic), so its subtree never appears as
    // layers. Paths are still the file's REAL paths — the body starts at index 1
    // because the head is child 0, filtered rather than renumbered.
    assert.deepEqual(
      body.rows.map((r) => `${r.depth}:${r.id}:${r.tag}:${r.label}`),
      [
        "0::stack:",
        "1:1:hstack:",
        "2:1.0:text:Title",
        "2:1.1:button:Go",
      ],
    );
    // The label is an attribute the author typed, never a generated name (M3).
    assert.ok(body.rows.every((r) => !/-\d+$/.test(r.label)));
    // The root has no parent; every other row's parent is a row that exists.
    const ids = new Set(body.rows.map((r) => r.id));
    assert.equal(body.rows[0]!.parent, null);
    for (const row of body.rows.slice(1)) assert.ok(ids.has(row.parent!), `orphan row ${row.id}`);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the head endpoint lists EVERY declaration — seeds included, unlike the logic index", async () => {
  const fx = project();
  writeFileSync(join(fx.root, "Components/App.dsx"), `<stack>
  <head>
    <variable as="n">return 7</variable>
    <variable as="doubled" computed="true">return n * 2</variable>
    <formula as="sum" inputs="a, b">return a + b</formula>
    <action as="bump">n = n + 1</action>
    <api as="rows" url="/rows"/>
  </head>
  <text value="{{ n }}"/>
</stack>\n`);
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const res = await fetch(`${base}/edit/api/head/Components/App.dsx`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { declarations: { kind: string; name: string; preview: string }[] };
    assert.deepEqual(
      body.declarations.map((d) => `${d.kind}:${d.name}`),
      ["variable:n", "computed:doubled", "formula:sum", "action:bump", "api:rows"],
    );
    // the preview is the declaration itself, one line — a seed shows its seed
    assert.equal(body.declarations[0]!.preview, "return 7");
    assert.equal(body.declarations[4]!.preview, "/rows");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the live-state channel — the app posts, the studio reads and writes back over SSE", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // Empty until an app page has pushed — the panel reads "not running", never an error.
    const empty = (await (await fetch(`${base}${STATE_PATH}`)).json()) as { screen: string | null };
    assert.equal(empty.screen, null);
    // The app page pushes a snapshot (the reload client does this off the kernel's
    // __DSX_STATE__ door); the studio reads it back verbatim.
    const snap = { screen: "App", vars: [{ name: "n", value: 7 }] };
    const posted = await fetch(`${base}${STATE_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snap),
    });
    assert.equal(posted.status, 204);
    assert.deepEqual(await (await fetch(`${base}${STATE_PATH}`)).json(), snap);
    // A studio write rides the EXISTING SSE stream into the app as a `state` event —
    // no second socket, the reload channel is the server→app lane.
    const stream = await fetch(`${base}${RELOAD_PATH}`);
    const reader = stream.body!.getReader();
    await reader.read(); // the retry preamble
    const put = await fetch(`${base}${STATE_PATH}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "n", value: 8 }),
    });
    assert.equal(put.status, 204);
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.ok(chunk.includes("event: state"), chunk);
    assert.ok(chunk.includes('"n"'), chunk);
    await reader.cancel();
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the node endpoint answers the inspector, with style split for controls", async () => {
  const fx = treeProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const root = (await (await fetch(`${base}/edit/api/node/${DOC}?path=`)).json()) as {
      tag: string; childCount: number; attributes: { name: string; value: string }[];
      styles: { property: string; value: string }[];
    };
    assert.equal(root.tag, "stack");
    assert.equal(root.childCount, 2);
    assert.deepEqual(root.attributes.map((a) => a.name).sort(), ["class", "style"]);
    // `style` stays whole in attributes AND is split for the property panel; each has its
    // own edit, so neither is derived from the other at write time.
    assert.deepEqual(root.styles, [{ property: "gap", value: "1rem" }, { property: "padding", value: "8px" }]);

    const leaf = (await (await fetch(`${base}/edit/api/node/${DOC}?path=1.0`)).json()) as { tag: string; childCount: number };
    assert.equal(leaf.tag, "text");
    assert.equal(leaf.childCount, 0);

    // A path that does not resolve is a 404, and a path that is not an address is a 400 —
    // never a coerced path, which would edit the WRONG element and still report success.
    assert.equal((await fetch(`${base}/edit/api/node/${DOC}?path=9.9`)).status, 404);
    assert.equal((await fetch(`${base}/edit/api/node/${DOC}?path=head`)).status, 400);
    assert.equal((await fetch(`${base}/edit/api/node/${DOC}?path=0..1`)).status, 400);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: a visual gesture writes the file as a one-line splice, not a reformat", async () => {
  const fx = treeProject();
  const file = join(fx.root, "Components/App.dsx");
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const send = (body: unknown): Promise<Response> =>
      fetch(`${base}/edit/api/edit/${DOC}`, { method: "POST", body: JSON.stringify(body) });

    // The inspector's own shape: one edit object, path as the tree's row id.
    const res = await send({ kind: "setAttribute", path: "1.0", name: "value", value: "Renamed" });
    assert.equal(res.status, 200);
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes('<text value="Renamed"/>'), after);
    // EVERY other byte is untouched: the diff a reviewer sees is the gesture.
    assert.equal(after, TREE_DOC.replace('value="Title"', 'value="Renamed"'));

    // One property inside a compound style, leaving the author's other declarations alone.
    assert.equal((await send({ kind: "setStyleProperty", path: "", property: "gap", value: "2rem" })).status, 200);
    assert.ok(readFileSync(file, "utf8").includes('style="gap: 2rem; padding: 8px"'));

    // A BATCH resolves every splice against the same original source, which is why it is one
    // request: two sequential requests would shift each other's paths.
    const batch = await send([
      { kind: "setAttribute", path: "1.0", name: "value", value: "A" },
      { kind: "setAttribute", path: "1.1", name: "label", value: "B" },
    ]);
    assert.equal(batch.status, 200);
    assert.equal(((await batch.json()) as { edits: number }).edits, 2);
    const both = readFileSync(file, "utf8");
    assert.ok(both.includes('value="A"') && both.includes('label="B"'));
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the structural endpoints refuse rather than damage", async () => {
  const fx = treeProject();
  const file = join(fx.root, "Components/App.dsx");
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const before = readFileSync(file, "utf8");
    const send = (body: unknown): Promise<Response> =>
      fetch(`${base}/edit/api/edit/${DOC}`, { method: "POST", body: JSON.stringify(body) });

    // The engine's own refusals surface as 409 with the reason, not a 500 and not a partial write.
    const gone = await send({ kind: "setAttribute", path: "7.7", name: "x", value: "1" });
    assert.equal(gone.status, 409);
    assert.equal(((await gone.json()) as { reason: string }).reason, "refused_edit");

    assert.equal((await send({ kind: "setAttribute", path: "not-a-path", name: "x", value: "1" })).status, 400);
    assert.equal((await send({ nokind: true })).status, 400);
    assert.equal((await fetch(`${base}/edit/api/edit/${DOC}`, { method: "POST", body: "{" })).status, 400);
    assert.equal((await fetch(`${base}/edit/api/edit/${DOC}`)).status, 405);

    // The same write boundary the document API keeps: outside a component root, or not .dsx.
    for (const name of ["../../etc/passwd", "Components/App.txt", "Components/Nope.dsx"]) {
      const res = await fetch(`${base}/edit/api/tree/${encodeURIComponent(name)}`);
      assert.equal(res.status, 404, name);
    }
    assert.equal(readFileSync(file, "utf8"), before, "a refused edit wrote to the file");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the DSX mount cannot shadow a live route, escape its directory, or hide a 404", async () => {
  const fx = treeProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // The mount serves a compiled directory that sits beside the developer's own source, so
    // it is contained exactly like the document API: resolve, then require the result inside.
    for (const escape of ["/edit/../package.json", "/edit/..%2f..%2fdsx.json", "/edit/%2e%2e/dsx.json"]) {
      const res = await fetch(`${base}${escape}`);
      assert.ok(res.status === 404 || !(await res.text()).includes("\"scheme\""), escape);
    }
    // A missing FILE is a 404. Answering it with the document is how a mistyped import turns
    // into an unreadable parse error somewhere else entirely.
    assert.equal((await fetch(`${base}/edit/nope.js`)).status, 404);
    // A missing extensionless path is the editor's own client route, so it gets the document.
    const route = await fetch(`${base}/edit/some/deep/route`);
    assert.equal(route.status, 200);
    assert.ok((await route.text()).includes("<title>Despia Studio</title>"));
    // The live routes still win over anything the compiled output could be named.
    assert.ok((await (await fetch(`${base}/edit/sdk.js`)).text()).length > 1000);
    assert.equal((await fetch(`${base}/edit/api/documents`)).status, 200);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// ── the MAP endpoint: the canvas is derived from the project, per request ──────────────
//
//  This is the half of the canvas that has to be TRUE (02-canvas.md §0). The picture is
//  downstream of it, so what is asserted here is not "a JSON came back" but the three
//  properties the canvas trades on: every document appears, an edge exists only where the
//  source actually navigates, and two reads of an unchanged project agree byte for byte.

function graphProject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-edit-graph-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({
      name: "Fixture",
      entry: "Home",
      routes: [
        { path: "/", component: "fix.Home" },
        { path: "/apps", component: "fix.Apps" },
      ],
    }),
    "Components/Home.dsx": `<stack><row href="/apps"/></stack>\n`,
    "Components/Apps.dsx": `<stack/>\n`,
    "Components/Orphan.dsx": `<stack/>\n`,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

type GraphBody = {
  width: number;
  height: number;
  nodes: { id: string; name: string; kind: string; path?: string; reachable: boolean; x: number; y: number; width: number; height: number; band: string }[];
  edges: { from: string; to: string | null; kind: string; gesture: string; geometry?: number[]; mid?: { x: number; y: number } }[];
  dangling: string[];
};

test("edit: the graph endpoint derives the map from the project's own source", async () => {
  const fx = graphProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const res = await fetch(`${base}/edit/api/graph`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as GraphBody;

    // Every document is on the map. A surface that is missing from the picture is the exact
    // failure the canvas exists to prevent, so nothing is filtered out - not even dead code.
    assert.deepEqual(body.nodes.map((n) => n.id).sort(), ["Apps", "Home", "Orphan"]);

    // A QUALIFIED route component still finds its file. The registry writes `fix.Home`
    // because two packages may both ship a Home; the graph addresses the file, which is bare.
    const home = body.nodes.find((n) => n.id === "Home")!;
    assert.equal(home.kind, "route");
    assert.equal(home.path, "/");
    assert.equal(home.name, "Home");

    // Reachability is the answer nobody can get from a folder listing.
    assert.equal(body.nodes.find((n) => n.id === "Orphan")!.reachable, false);
    assert.equal(home.reachable, true);

    // One edge, because the source contains exactly one navigation.
    assert.equal(body.edges.length, 1);
    const [edge] = body.edges as [GraphBody["edges"][number]];
    assert.equal(edge.from, "Home");
    assert.equal(edge.to, "Apps");
    assert.equal(edge.gesture, "TAP");
    // The geometry travels WITH the edge: two clients must not each invent their own curve,
    // and it travels as NUMBERS, so nothing downstream has to parse a path string to draw.
    assert.equal(edge.geometry?.length, 8, `edge carried no geometry: ${JSON.stringify(edge)}`);
    assert.ok(typeof edge.mid?.x === "number" && typeof edge.mid?.y === "number", "no pill anchor");

    // Placed, sized and bounded, so a fit-to-content actually fits.
    for (const node of body.nodes) {
      assert.ok(node.width > 0 && node.height > 0, node.id);
      assert.ok(node.x + node.width <= body.width, `${node.id} runs past the right edge`);
      assert.ok(node.y + node.height <= body.height, `${node.id} runs past the bottom edge`);
    }

    // DERIVED, not stored: read it twice, get the same map. A canvas whose nodes drift
    // between two reads of an unchanged project is not worth looking at.
    assert.equal(JSON.stringify(await (await fetch(`${base}/edit/api/graph`)).json()), JSON.stringify(body));
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// ── the LOGIC endpoint: the business logic, drawn true to the code ────────────────────
//
//  The owner's requirement, in their words: the picture must "illustrate visually the business
//  logic true to the code and not just do its own thing". So what is asserted here is not that
//  a drawing came back, but the three properties that make one trustworthy: it covers EVERY
//  code body (not just the tidy named ones), a loop is CONTAINMENT rather than a back edge, and
//  the source round-trips byte-for-byte out of the projection the drawing was made from.

const LOGIC_DOC = `<stack>
  <head>
    <variable as="rows">return []</variable>
    <variable as="total" computed="true">return rows.length</variable>
    <action as="settle" inputs="id">
      let sum = 0
      for (const row of rows) {
        if (row.paid) {
          sum = sum + row.amount
        } else {
          skipped = skipped + 1
        }
      }
      return sum
    </action>
  </head>
  <button label="Go" on:tap="settle({ id: 1 })"/>
</stack>
`;

function logicProject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-edit-logic-"));
  for (const [path, contents] of Object.entries({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": LOGIC_DOC,
  })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

type LogicIndex = { document: string; bodies: { id: string; kind: string; name: string; steps: number }[] };
type FlowDraw = {
  body: string; exact: boolean; writable: boolean; surface: string; rev: string;
  nodes: { id: string; kind: string; title: string; subtitle: string; span?: { start: number; end: number }; x: number; y: number; w: number; h: number }[];
  edges: { from: string; to: string; label?: string; insertAt?: number; plusX?: number; plusY?: number }[];
  insertable: { kind: string; title: string; template: string }[];
  statements: number;
};

test("edit: the logic endpoint indexes EVERY code body, not just the tidy ones", async () => {
  const fx = logicProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const index = (await (await fetch(`${base}/edit/api/logic/${DOC}`)).json()) as LogicIndex;
    const ids = index.bodies.map((b) => b.id).sort();
    // The named action, the COMPUTED variable, and the inline handler. A canvas that showed
    // only the action would be showing a fraction of the behaviour and looking complete.
    assert.deepEqual(ids, ["action:settle", "on:tap@1", "variable:total"]);
    // A plain <variable> is a seed, not logic, and drawing one would be noise.
    assert.ok(!ids.includes("variable:rows"));
    // The handler's address is the tree's address, so selecting it in one selects it in both.
    assert.equal((await (await fetch(`${base}/edit/api/node/${DOC}?path=1`)).json() as { tag: string }).tag, "button");

    assert.equal((await fetch(`${base}/edit/api/logic/${DOC}?body=nope`)).status, 404);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the flow draws human nodes, a literal loop, and round-trips exactly", async () => {
  const fx = logicProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://${"127.0.0.1"}:${server.port}`;
  try {
    const draw = (await (await fetch(`${base}/edit/api/logic/${DOC}?body=action:settle`)).json()) as FlowDraw;

    // THE PROPERTY THE DRAWING IS ALLOWED TO EXIST ON. If the projection cannot reproduce the
    // author's bytes, the picture is a second source of truth and must not be editable.
    assert.equal(draw.exact, true, "the projection did not round-trip");
    assert.equal(draw.writable, true);
    assert.equal(draw.surface, "frontend");

    // Human language, never keyword-ese: the loop and the branch carry their names.
    const titles = draw.nodes.map((n) => n.title);
    assert.ok(titles.includes("For Each Loop"), titles.join("|"));
    assert.ok(titles.includes("If"));
    assert.ok(titles.includes("Set Variable"));
    const loop = draw.nodes.find((n) => n.title === "For Each Loop")!;
    assert.equal(loop.subtitle, "row in rows");

    // THE CONTAINER IS THE LOOP: a frame node encloses the body and a port sits on its
    // border. The branch is the two lanes that rejoin: a Then-labelled edge exists.
    assert.ok(draw.nodes.some((n) => n.kind === "frame"), "no loop container");
    assert.ok(draw.nodes.some((n) => n.kind === "port"), "no loop port");
    assert.ok(draw.edges.some((e) => e.label === "Then"));
    void loop;

    // EVERY connector knows where it splices, and carries its + hotspot.
    const plus = draw.edges.filter((e) => e.insertAt !== undefined);
    assert.ok(plus.length >= 4, `few insertion points: ${plus.length}`);
    for (const e of plus) assert.ok(e.plusX !== undefined && e.plusY !== undefined);

    // THE WRITE ROUND TRIP over HTTP: insert a Log node on the first connector, watch the
    // file change by exactly that statement, and the re-projection stay exact.
    const first = draw.nodes.find((n) => n.title === "Set Variable")!;
    const connector = plus.find((e) => e.insertAt === first.span!.end)!;
    const saved = await fetch(`${base}/edit/api/flowedit/${DOC}`, {
      method: "POST",
      body: JSON.stringify({ body: "action:settle", rev: draw.rev, op: { op: "insert", at: connector.insertAt, text: "dsx.log('inserted')" } }),
    });
    assert.equal(saved.status, 200);
    const again = (await (await fetch(`${base}/edit/api/logic/${DOC}?body=action:settle`)).json()) as FlowDraw;
    assert.equal(again.exact, true);
    assert.ok(again.nodes.some((n) => n.kind === "log" && n.subtitle === "inserted"));

    // A STALE REVISION IS REFUSED - the drawing can never clobber a newer file.
    const stale = await fetch(`${base}/edit/api/flowedit/${DOC}`, {
      method: "POST",
      body: JSON.stringify({ body: "action:settle", rev: draw.rev, op: { op: "remove", span: first.span } }),
    });
    assert.equal(stale.status, 409);

    // The picker's vocabulary is surface-true and every entry carries a template.
    assert.ok(draw.insertable.some((n) => n.title === "Go To Page"));
    assert.ok(draw.insertable.every((n) => n.template.length > 0));
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// ── the SERVER plane: routes, data and work, projected from the document ──────────────
//
//  A backend here is a document, so the three views are projections exactly as the screen map
//  is. What matters in these assertions is the two things that would make the surface a liar:
//  a worker must not be filed as a public route (its shape is a drain endpoint, and confusing
//  the two on a security-shaped screen is the worst kind of wrong), and no edge may be drawn
//  between entities, because the schema vocabulary has no relation to derive one from.

const SERVER_DOC = `<server>
  <head>
    <entity as="note" ownership="owner">
      <field as="title" type="text"/>
      <field as="body" type="text"/>
      <field as="author_id" type="uuid"/>
      <index on="title"/>
    </entity>
    <entity as="tag" ownership="public-read">
      <field as="label" type="text"/>
    </entity>
    <secret as="MAIL_KEY" env="MAIL_KEY"/>
    <egress host="api.example.com"/>
    <budget of="egress:api.example.com" per="hour" max="2000"/>
    <action as="digest" inputs="since">
      let count = 0
      for (const note of notes) {
        count = count + 1
      }
      return count
    </action>
  </head>
  <route as="digest" method="GET" path="/digest" action="digest" auth="required" rate="60/m"/>
  <route as="notes" method="GET" path="/notes" entity="note" op="list"/>
  <worker as="drain" queue="mail" action="digest" schedule="0 3 * * *"/>
  <tool action="digest" description="Summarise the caller's notes." auth="required" mutates="notes"/>
</server>
`;

function serverProject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-edit-server-"));
  for (const [path, contents] of Object.entries({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": `<stack><text value="x"/></stack>\n`,
    "server/notes.dsx": SERVER_DOC,
  })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

type ServerView = {
  document: string;
  routes: { key: string; method: string; path: string; auth?: string; rate?: string; action?: string; entity?: string; op?: string }[];
  workers: { key: string; worker?: string; schedule?: string; action?: string }[];
  entities: { name: string; ownership: string; indexes: string[]; fields: { name: string; type: string }[] }[];
  actions: { name: string; inputs: string[]; steps: number }[];
  tools: { name: string; action: string; description: string; auth: string; mutates: string; inputs: string[] }[];
  secrets: string[];
  egress: string[];
  budgets: { of: string; per: string; max: number | "unbounded"; depth?: number; declared: boolean; line?: number; chain?: string }[];
};

test("edit: the logic plane knows which bodies an agent can call, on both faces", async () => {
  // A tool is not a separate KIND of code - it is a declared action with a second caller -
  // so the logic plane carries it as a fact ON the body rather than as a parallel list that
  // could disagree. The entry node of the drawing is titled for the AGENT, because that is
  // what starts the flow: a canvas that said "Action · addTodo" would be drawing the tap
  // that no longer happens.
  const fx = tempProject({
    "Components/Todos.dsx": `<stack>
  <head>
    <tool action="addTodo" description="Add a todo." mutates="todos"/>
    <variable as="todos">return []</variable>
    <action as="addTodo" text="''">dsx.variable.todos.push({ text: text })</action>
    <action as="untouched">return 1</action>
  </head>
  <text value="x"/>
</stack>
`,
    "server/notes.dsx": `<server>
  <head>
    <entity as="note" ownership="owner"><field as="body" type="text"/></entity>
    <action as="recent" inputs="limit">
      return data.note.list({ limit: limit })
    </action>
  </head>
  <route as="notes" method="GET" path="/notes" action="recent"/>
  <tool action="recent" description="List recent notes." auth="required"/>
</server>
`,
  });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  type Body = { id: string; kind: string; name: string; agent?: { name: string; face: string; inputs: string[]; mutates: string } };
  try {
    const index = (await (await fetch(`${base}/edit/api/logic/Components/Todos.dsx`)).json()) as { bodies: Body[] };
    const add = index.bodies.find((b) => b.id === "action:addTodo")!;
    assert.equal(add.agent?.name, "addTodo");
    assert.equal(add.agent?.face, "page");
    assert.deepEqual(add.agent?.inputs, ["text"]);
    // An action no tool row names carries NO agent fact. The badge must mean something.
    assert.equal(index.bodies.find((b) => b.id === "action:untouched")!.agent, undefined);

    // The drawing carries it too, and titles its entry for the caller.
    const drawing = (await (await fetch(`${base}/edit/api/logic/Components/Todos.dsx?body=action:addTodo`)).json()) as
      { agent?: { name: string }; nodes: Array<{ title?: string }> };
    assert.equal(drawing.agent?.name, "addTodo");
    assert.ok(drawing.nodes.some((n) => n.title === "Agent \u00b7 addTodo"),
      `the entry node must name the agent: ${JSON.stringify(drawing.nodes.map((n) => n.title))}`);

    // THE SAME QUESTION on a backend document, answered by the other face.
    const backend = (await (await fetch(`${base}/edit/api/logic/server%2Fnotes.dsx`)).json()) as { bodies: Body[] };
    const recent = backend.bodies.find((b) => b.id === "action:recent")!;
    assert.equal(recent.agent?.name, "recent");
    assert.equal(recent.agent?.face, "server");
    assert.deepEqual(recent.agent?.inputs, ["limit"]);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the server endpoint carries the document's MCP face beside its HTTP one", async () => {
  // A `<tool>` row PARSED and then vanished: serverViews built routes, workers, entities and
  // actions and never read `doc.mcp`, so the one surface that shows what a server document
  // exposes could not show its agent face at all. The editor is where an author decides what
  // an agent may call, so an invisible face is a missing product, not a missing field.
  const fx = serverProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const view = (await (await fetch(`${base}/edit/api/server/notes.dsx`)).json()) as ServerView;
    assert.deepEqual(view.tools.map((t) => t.name), ["digest"]);
    const tool = view.tools[0]!;
    assert.equal(tool.action, "digest");
    assert.equal(tool.description, "Summarise the caller's notes.");
    assert.equal(tool.auth, "required");
    assert.equal(tool.mutates, "notes");
    // DERIVED, never restated: the shape a model receives is the named action's declared
    // inputs. An editor that asked an author to type a schema here would be inviting the
    // exact drift the row exists to prevent.
    assert.deepEqual(tool.inputs, ["since"]);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

type HeadView = {
  document: string;
  declarations: { kind: string; name: string; inputs?: string[] }[];
  tools: { name: string; action: string; description: string; mutates: string; inputs: string[]; readOnly: boolean; path: string }[];
  toolErrors: { code: string; name: string; message: string }[];
  headPath: string;
  headChildren: number;
};

test("edit: the head endpoint carries a document's agent tools, projected the way the runtime projects them", async () => {
  const fx = tempProject({
    "Components/Todos.dsx": `<stack>
  <head>
    <tool action="addTodo" description="Add a todo." mutates="todos"/>
    <tool as="count-open" action="countOpen" description="Count open todos."/>
    <variable as="todos">return []</variable>
    <action as="addTodo" text="''">dsx.variable.todos.push({ text: text })</action>
    <action as="countOpen">return todos.length</action>
  </head>
  <text value="x"/>
</stack>
`,
  });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const view = (await (await fetch(`${base}/edit/api/head/Components/Todos.dsx`)).json()) as HeadView;
    assert.deepEqual(view.tools.map((t) => t.name), ["addTodo", "count-open"]);

    const add = view.tools[0]!;
    assert.equal(add.action, "addTodo");
    // The schema an agent reads, DERIVED from the action's declared inputs - the same fold
    // the browser adapter runs, so the editor cannot show one contract while the page
    // registers another.
    assert.deepEqual(add.inputs, ["text"]);
    // `mutates` present means NO read-only hint; its absence is what grants one.
    assert.equal(add.readOnly, false);
    assert.equal(view.tools[1]!.readOnly, true);
    assert.equal(view.tools[1]!.action, "countOpen");
    assert.deepEqual(view.tools[1]!.inputs, []);
    assert.deepEqual(view.toolErrors, []);

    // An ACTION declaration carries its own declared inputs, so a surface can show the shape
    // a tool WOULD have before any tool row names it. Without this the add form could only
    // ever say "no arguments", which is exactly wrong at the moment someone is choosing.
    const decls = view.declarations as Array<{ kind: string; name: string; inputs?: string[] }>;
    assert.deepEqual(decls.find((d) => d.name === "addTodo")?.inputs, ["text"]);
    assert.deepEqual(decls.find((d) => d.name === "countOpen")?.inputs, []);
    // Only actions carry it: a variable has no argument list to show.
    assert.equal(decls.find((d) => d.kind === "variable")?.inputs, undefined);

    // Every row is ADDRESSABLE, or the Studio can only read it back at a person.
    assert.match(view.tools[0]!.path, /^\d+\.\d+$/);
    assert.match(view.headPath, /^\d+$/);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: a broken tool row reaches the editor as an error, never as a shorter list", async () => {
  // The failure an author must SEE. A row naming an action the document does not declare
  // fails the build; if the editor simply omitted it, the surface would say "you have one
  // tool" about a document that does not compile.
  const fx = tempProject({
    "Components/Broken.dsx": `<stack>
  <head>
    <tool action="nope" description="Names nothing."/>
    <action as="real">return 1</action>
  </head>
  <text value="x"/>
</stack>
`,
  });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const view = (await (await fetch(`${base}/edit/api/head/Components/Broken.dsx`)).json()) as HeadView;
    assert.deepEqual(view.tools, []);
    assert.equal(view.toolErrors.length, 1);
    assert.equal(view.toolErrors[0]!.code, "unknown_action");
    assert.match(view.toolErrors[0]!.message, /does not declare/);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: one POST creates a whole capability — the action stub and the tool row together", async () => {
  // The ONE-GESTURE law (platform/09-agent-tools.md WE5): "New tool" writes BOTH declarations
  // in a single surgery batch, so there is no moment where the document declares a tool that
  // names nothing or an action nobody exposed. Two POSTs would put the document through
  // exactly the broken intermediate state the build refuses.
  const DOC = "Components/Todos.dsx";
  const fx = tempProject({
    [DOC]: `<stack>
  <head>
    <tool action="addTodo" description="Add a todo." mutates="todos"/>
    <variable as="todos">return []</variable>
    <action as="addTodo" text="''">dsx.variable.todos.push({ text: text })</action>
  </head>
  <text value="x"/>
</stack>
`,
  });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const before = (await (await fetch(`${base}/edit/api/head/${DOC}`)).json()) as HeadView;
    // The append slot comes from the endpoint, counted on the same parse the door runs.
    assert.equal(before.headChildren, 3);

    const res = await fetch(`${base}/edit/api/edit/${DOC}`, {
      method: "POST",
      body: JSON.stringify({
        edits: [
          { kind: "insertNode", path: before.headPath, index: 0,
            markup: `<tool as="clear-done" action="clearDone" description="Remove every finished todo." mutates="todos"/>` },
          { kind: "insertNode", path: before.headPath, index: before.headChildren,
            markup: `<action as="clearDone">return</action>` },
        ],
      }),
    });
    assert.equal(res.status, 200);

    // The second GET shows the capability WIRED: a real tool over a real action, no errors.
    const after = (await (await fetch(`${base}/edit/api/head/${DOC}`)).json()) as HeadView;
    assert.deepEqual(after.toolErrors, []);
    const created = after.tools.find((t) => t.name === "clear-done")!;
    assert.equal(created.action, "clearDone");
    assert.equal(created.mutates, "todos");
    assert.deepEqual(created.inputs, []);
    assert.equal(after.declarations.some((d) => d.kind === "action" && d.name === "clearDone"), true);
    assert.equal(after.headChildren, 5);

    // The logic plane already knows the new body and its caller — the stage the Studio
    // lands on after the gesture is this drawing.
    const index = (await (await fetch(`${base}/edit/api/logic/${DOC}`)).json()) as
      { bodies: Array<{ id: string; agent?: { name: string } }> };
    assert.equal(index.bodies.find((b) => b.id === "action:clearDone")?.agent?.name, "clear-done");

    // And the bytes are the author's own document, spliced: the row at the top of the head,
    // the stub before its close — not a reformat.
    const source = readFileSync(join(fx.root, DOC), "utf8");
    assert.ok(source.indexOf(`<tool as="clear-done"`) < source.indexOf(`<tool action="addTodo"`));
    const stub = source.indexOf(`<action as="clearDone">return</action>`);
    assert.ok(stub > source.indexOf(`<action as="addTodo"`) && stub < source.indexOf("</head>"));
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the surgery door admits server documents deliberately, and its containment holds", async () => {
  // WE7 (platform/09-agent-tools.md §5): the structural write boundary admits `server/` ON
  // PURPOSE — so this test is the decision's shape. The containment half pins what widening
  // must never open: no path under the name can escape the two sanctioned trees, and nothing
  // but a .dsx answers. The write half proves a served capability's row edits in place, and
  // that the server view reflects it with the row's surgery address attached.
  const fx = tempProject({
    "server/notes.dsx": `<server>
  <head>
    <entity as="note" ownership="owner"><field as="body" type="text"/></entity>
    <action as="recent" inputs="limit">
      return data.note.list({ limit: limit })
    </action>
  </head>
  <route as="notes" method="GET" path="/notes" action="recent"/>
  <tool action="recent" description="List recent notes." auth="required"/>
</server>
`,
  });
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  const edit = (doc: string, body: unknown): Promise<Response> =>
    fetch(`${base}/edit/api/edit/${encodeURIComponent(doc)}`, { method: "POST", body: JSON.stringify(body) });
  try {
    // CONTAINMENT: the name grammar cannot reach outside server/ or Components/, and only .dsx
    const noop = { kind: "setAttribute", path: "0", name: "x", value: "y" };
    assert.equal((await edit("server/../../passwd.dsx", noop)).status, 404);
    assert.equal((await edit("server/../dsx.json", noop)).status, 404);
    assert.equal((await edit("../server/notes.dsx", noop)).status, 404);
    assert.equal((await edit("server/notes.txt", noop)).status, 404);

    // THE ADMITTED WRITE: the row's address comes from the server view, not from guessing
    type ServerView = { tools: Array<{ name: string; description: string; path: string }> };
    const before = (await (await fetch(`${base}/edit/api/server/notes.dsx`)).json()) as ServerView;
    assert.equal(before.tools[0]!.name, "recent");
    assert.match(before.tools[0]!.path, /^\d+$/);

    const res = await edit("server/notes.dsx", {
      kind: "setAttribute", path: before.tools[0]!.path, name: "description",
      value: "List the caller's ten most recent notes.",
    });
    assert.equal(res.status, 200);

    const after = (await (await fetch(`${base}/edit/api/server/notes.dsx`)).json()) as ServerView;
    assert.equal(after.tools[0]!.description, "List the caller's ten most recent notes.");

    // the splice touched exactly the attribute — the route row above it is byte-identical
    const source = readFileSync(join(fx.root, "server/notes.dsx"), "utf8");
    assert.ok(source.includes(`<route as="notes" method="GET" path="/notes" action="recent"/>`));
    assert.ok(source.includes(`description="List the caller's ten most recent notes." auth="required"`));
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the try door validates, and answers a dead preview with the sentence, not a wait", async () => {
  // The browser oracle (studio-tryit-browser.ts) proves the LIVE half of WE6 — the run
  // reaching a real page, the DOM moving, the value coming back. What belongs here is the
  // door's own contract: malformed asks are named, and with no app page connected the
  // answer is the honest 409 — never a fabricated result, never a hang.
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    assert.equal((await fetch(`${base}/edit/api/try`)).status, 405);
    assert.equal((await fetch(`${base}/edit/api/try`, { method: "POST", body: "{" })).status, 400);
    const unnamed = await fetch(`${base}/edit/api/try`, { method: "POST", body: JSON.stringify({ args: {} }) });
    assert.equal(unnamed.status, 400);

    const t0 = Date.now();
    const dead = await fetch(`${base}/edit/api/try`, { method: "POST", body: JSON.stringify({ action: "refresh", args: {} }) });
    assert.equal(dead.status, 409);
    const body = (await dead.json()) as { reason: string; message: string };
    assert.equal(body.reason, "no_live_preview");
    assert.match(body.message, /no running preview/);
    // the timeout is the answer's cost, bounded — not an open-ended wait
    assert.ok(Date.now() - t0 < 10_000);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the server endpoint projects routes, data and work from the document", async () => {
  const fx = serverProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const list = (await (await fetch(`${base}/edit/api/server`)).json()) as { documents: string[] };
    assert.deepEqual(list.documents, ["notes.dsx"]);

    const view = (await (await fetch(`${base}/edit/api/server/notes.dsx`)).json()) as ServerView;

    // A WORKER IS NOT A ROUTE. It is an api row with `worker` set, and filing a drain endpoint
    // among the public routes on a screen that shows auth would be the worst kind of wrong.
    assert.deepEqual(view.routes.map((r) => r.key).sort(), ["digest", "notes"]);
    assert.deepEqual(view.workers.map((w) => w.key), ["drain"]);
    assert.equal(view.workers[0]!.worker, "mail");
    assert.equal(view.workers[0]!.schedule, "0 3 * * *");

    // The two ways a route is answered: by an action, or by an entity operation.
    const digest = view.routes.find((r) => r.key === "digest")!;
    assert.equal(digest.action, "digest");
    assert.equal(digest.auth, "required");
    assert.equal(digest.rate, "60/m");
    const notes = view.routes.find((r) => r.key === "notes")!;
    assert.equal(notes.entity, "note");
    assert.equal(notes.op, "list");

    // Ownership is drawn, not buried: `owner` versus `public-read` is the most consequential
    // thing on the data view.
    assert.deepEqual(view.entities.map((e) => [e.name, e.ownership]), [["note", "owner"], ["tag", "public-read"]]);
    assert.deepEqual(view.entities[0]!.fields.map((f) => f.name), ["author_id", "body", "title"]);
    assert.deepEqual(view.entities[0]!.indexes, ["title"]);

    // NO INVENTED RELATIONS. `author_id` looks like a foreign key and is not one: the schema
    // vocabulary is scalar-only, so drawing an edge would claim a constraint the database does
    // not have. The absence is the correct answer, and it is asserted so it stays deliberate.
    assert.ok(!Object.hasOwn(view, "relations"), "the server view must not invent entity edges");

    // An action carries the same compaction measurement the logic canvas draws it with.
    assert.deepEqual(view.actions.map((a) => a.name), ["digest"]);
    assert.deepEqual(view.actions[0]!.inputs, ["since"]);
    assert.ok(view.actions[0]!.steps > 0);

    assert.deepEqual(view.secrets, ["MAIL_KEY"]);
    assert.deepEqual(view.egress, ["api.example.com"]);

    // THE SPEND PLANE RIDES THE VIEW (cost-guardrails.md): the guarded defaults merged with
    // the document's <budget> rows, each row carrying its provenance — a default IS a budget,
    // just one nobody had to write — and a declared row carrying the line that pins it.
    assert.deepEqual(view.budgets.map((b) => b.of), [
      "data:reads", "data:writes", "egress:api.example.com", "queue:mail", "requests",
    ]);
    const declared = view.budgets.find((b) => b.of === "egress:api.example.com")!;
    assert.equal(declared.declared, true);
    assert.equal(declared.per, "hour");
    assert.equal(declared.max, 2000);
    assert.equal(declared.chain, "notes");
    assert.ok(typeof declared.line === "number" && declared.line > 1);
    const queue = view.budgets.find((b) => b.of === "queue:mail")!;
    assert.deepEqual(queue, { of: "queue:mail", per: "day", max: 50_000, depth: 10_000, declared: false });
    assert.equal(view.budgets.find((b) => b.of === "requests")!.max, 250_000);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: the server endpoint is read-only, contained, and passes the reader's own refusal", async () => {
  const fx = serverProject();
  writeFileSync(join(fx.root, "server", "broken.dsx"), `<server><head><entity as="x" ownership="nope"><field as="a" type="text"/></entity></head></server>\n`);
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // Its own boundary: `server/` only, .dsx only. Widening resolveDocument to reach these
    // would have widened the WRITE boundary of the three editing endpoints at the same time.
    for (const escape of ["../dsx.json", "../Components/App.dsx", "notes.txt", "nope.dsx"]) {
      assert.equal((await fetch(`${base}/edit/api/server/${encodeURIComponent(escape)}`)).status, 404, escape);
    }
    // A document that does not parse answers 422 carrying the READER's message, which names
    // the line and the accepted values. A generic failure would throw that away.
    const bad = await fetch(`${base}/edit/api/server/broken.dsx`);
    assert.equal(bad.status, 422);
    const body = (await bad.json()) as { reason: string; message: string };
    assert.equal(body.reason, "unreadable_document");
    assert.ok(body.message.includes("ownership"), `message was ${JSON.stringify(body.message)}`);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// ── THE DOORS (plan E1: D3 the credential, D4 the preconditions) ─────────────────────────
//
//  These four tests are the whole reason the editor's HTTP surface changed. Each one was a
//  measured defect before it was a test: an unauthenticated remote file write, a bind that
//  served it, a last-writer-wins race on every visual drag, and a save door through which a
//  document that does not parse reached disk.

test("edit: /edit/api/* refuses a request with no credential, and writes nothing", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  const doc = join(fx.root, "Components", "App.dsx");
  try {
    //  bareFetch DELIBERATELY: this is the one place that must present nothing.
    const refused = await bareFetch(`${base}/edit/api/documents/${encodeURIComponent("Components/App.dsx")}`, {
      method: "PUT",
      body: "<stack><text value=\"pwned\"/></stack>\n",
    });
    assert.equal(refused.status, 401);
    assert.equal(((await refused.json()) as { reason: string }).reason, "unauthorized");
    assert.equal(readFileSync(doc, "utf8"), APP, "a refused write reached the file");

    // A WRONG credential is refused the same way a missing one is.
    const wrong = await bareFetch(`${base}/edit/api/documents`, { headers: { "x-despia-edit": "not-the-secret" } });
    assert.equal(wrong.status, 401);

    // The MCP door is a write surface too, and it is behind the same gate.
    const mcp = await bareFetch(`${base}/edit/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 401);

    // …and the credential the run minted opens all of it.
    assert.equal((await fetch(`${base}/edit/api/documents`)).status, 200);

    //  THE COOKIE PATH is how a browser keeps it: the printed URL carries `?token=`, the mount
    //  answers with a Set-Cookie scoped to /edit, and the page's own fetches ride that.
    const opened = await bareFetch(`${base}/edit/api/documents?token=${encodeURIComponent(server.admission)}`);
    assert.equal(opened.status, 200);
    const cookie = opened.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^despia_edit=/);
    assert.match(cookie, /Path=\/edit/);
    assert.match(cookie, /HttpOnly/);
    const withCookie = await bareFetch(`${base}/edit/api/documents`, {
      headers: { cookie: cookie.split(";")[0]! },
    });
    assert.equal(withCookie.status, 200);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: a non-loopback bind with no explicit credential is refused at startup", async () => {
  const fx = project();
  try {
    await assert.rejects(
      () => startEditServer(loadConfig(fx.root), { port: 0, host: "0.0.0.0", log: () => {} }),
      (e: Error) => {
        assert.match(e.message, /refusing to serve the editor on 0\.0\.0\.0/);
        assert.match(e.message, /DESPIA_EDIT_TOKEN/, "the refusal must name what to pass");
        return true;
      },
    );
    // With one CHOSEN, the same bind serves — and only that credential opens it.
    const server = await startEditServer(loadConfig(fx.root), {
      port: 0, host: "0.0.0.0", token: "operator-chose-this-one", log: () => {},
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      assert.equal((await bareFetch(`${base}/edit/api/documents`)).status, 401);
      assert.equal(
        (await bareFetch(`${base}/edit/api/documents`, { headers: { "x-despia-edit": "operator-chose-this-one" } })).status,
        200,
      );
    } finally {
      await server.close();
    }
  } finally {
    fx.cleanup();
  }
});

test("edit: two racing writes — the second is 409 stale_revision and the file keeps the first", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  const url = `${base}/edit/api/documents/${encodeURIComponent("Components/App.dsx")}`;
  const abs = join(fx.root, "Components", "App.dsx");
  try {
    // Both editors read the same revision — this is the race, stated exactly.
    const read = await fetch(url);
    const rev = (read.headers.get("etag") ?? "").replace(/"/g, "");
    assert.notEqual(rev, "", "the read must carry the revision a write can be conditioned on");

    const first = APP.replace("n is", "FIRST is");
    const won = await fetch(url, { method: "PUT", headers: { "if-match": `"${rev}"` }, body: first });
    assert.equal(won.status, 200);
    assert.equal(readFileSync(abs, "utf8"), first);

    const second = APP.replace("n is", "SECOND is");
    const lost = await fetch(url, { method: "PUT", headers: { "if-match": `"${rev}"` }, body: second });
    assert.equal(lost.status, 409);
    const body = (await lost.json()) as { reason: string; rev: string };
    assert.equal(body.reason, "stale_revision");
    assert.equal(readFileSync(abs, "utf8"), first, "the loser overwrote the winner");
    // The refusal hands back the revision that would have worked, so a retry is one round trip.
    assert.equal(
      (await fetch(url, { method: "PUT", headers: { "if-match": `"${body.rev}"` }, body: second })).status,
      200,
    );
    assert.equal(readFileSync(abs, "utf8"), second);

    //  THE STRUCTURAL DOOR takes the same precondition — every visual drag comes through it.
    const stale = await fetch(`${base}/edit/api/edit/${encodeURIComponent("Components/App.dsx")}`, {
      method: "POST",
      body: JSON.stringify({ rev, edits: [{ kind: "setAttribute", path: "0", name: "value", value: "x" }] }),
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { reason: string }).reason, "stale_revision");
    assert.equal(readFileSync(abs, "utf8"), second, "a stale structural edit reached the file");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit: DSX that does not parse is refused, and the file is byte-identical afterwards", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  const url = `${base}/edit/api/documents/${encodeURIComponent("Components/App.dsx")}`;
  const abs = join(fx.root, "Components", "App.dsx");
  const before = readFileSync(abs);
  try {
    const refused = await fetch(url, { method: "PUT", body: "<stack><text>unclosed" });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { reason: string }).reason, "refused_edit");
    assert.deepEqual(readFileSync(abs), before, "an unparseable document reached disk");

    // The same door still saves a document that DOES parse.
    const ok = await fetch(url, { method: "PUT", body: APP.replace("n is", "still is") });
    assert.equal(ok.status, 200);
    assert.equal(readFileSync(abs, "utf8"), APP.replace("n is", "still is"));
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// ── DESPIA APPS (studio-apps.md §8): the app plane's doors, driven end to end against a
//    real dev app — a configured package with facets.apps. Discovery, the mount table, the
//    marketplace search, the compiled surface payload, consent/enable, storage, uninstall,
//    and the surgery door's app provenance all run against the same server the panel uses.
function appProject(): { root: string; cleanup: () => void } {
  return tempProject({
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App", packages: ["packages/annotate"] }),
    "packages/annotate/dsx.json": JSON.stringify({
      name: "Annotate",
      scheme: "annotate",
      version: "1.2.0",
      summary: "Sticky notes for your screens",
      studioApi: 1,
      facets: {
        apps: {
          "notes": {
            slot: "studio.rail",
            component: "Components/NotesPanel.dsx",
            title: "Notes",
            icon: "text.badge.star",
            grants: ["project:read", "selection:read"],
            events: ["document.saved"],
          },
        },
      },
    }),
    "packages/annotate/Components/NotesPanel.dsx":
      `<stack><head><attribute as="selection" default=""/></head><text value="notes"/></stack>\n`,
  });
}

test("edit apps: discovery, the mount table, the marketplace, and the enable/disable door", async () => {
  const fx = appProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // the plane: the dev app is discovered, auto-enabled (dev trust), and folded into the rail
    const plane = await fetch(`${base}/edit/api/apps`);
    assert.equal(plane.status, 200);
    const planeBody = (await plane.json()) as {
      studioApi: number;
      apps: Array<{ scheme: string; kind: string; enabled: boolean; asked: string[]; contributions: Array<{ id: string; slot: string }> }>;
      table: { rail: Array<{ app: string; contribution: { id: string } }> };
      refusals: Array<{ app: string; reason: string }>;
    };
    assert.equal(planeBody.studioApi, 1);
    const annotate = planeBody.apps.find((a) => a.scheme === "annotate");
    assert.ok(annotate !== undefined, "the dev app was not discovered");
    assert.equal(annotate.kind, "dev");
    assert.equal(annotate.enabled, true, "a dev app seeds enabled");
    assert.deepEqual(annotate.asked, ["project:read", "selection:read"]);
    assert.ok(planeBody.table.rail.some((r) => r.app === "annotate" && r.contribution.id === "notes"),
      "the enabled dev app is missing from the rail lane");

    // the marketplace: the same row through the search fold — a hit by name, a miss by noise
    const hit = await fetch(`${base}/edit/api/apps/market?q=sticky`);
    assert.ok(((await hit.json()) as { rows: Array<{ scheme: string }> }).rows.some((r) => r.scheme === "annotate"));
    const miss = await fetch(`${base}/edit/api/apps/market?q=zzznothing`);
    assert.equal(((await miss.json()) as { rows: unknown[] }).rows.length, 0);

    // the surface: the compiled sub-registry payload for the mounted contribution
    const surface = await fetch(`${base}/edit/api/apps/surface?app=annotate&contribution=notes`);
    assert.equal(surface.status, 200);
    const payload = (await surface.json()) as {
      scheme: string; entry: string; grants: string[]; kind: string;
      registry: { components: { [k: string]: unknown } };
      budgets: { loopCap: number };
    };
    assert.equal(payload.scheme, "annotate");
    assert.equal(payload.entry, "annotate.NotesPanel");
    assert.ok(payload.registry.components["annotate.NotesPanel"] !== undefined, "the surface payload compiled no component");
    assert.ok(payload.budgets.loopCap > 0);

    // an unknown contribution is a typed 404, not a blank mount
    const unknown = await fetch(`${base}/edit/api/apps/surface?app=annotate&contribution=ghost`);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { reason: string }).reason, "unknown_app");

    // disable → the rail lane empties and the surface refuses with the reason
    const off = await fetch(`${base}/edit/api/apps/state`, {
      method: "POST", body: JSON.stringify({ app: "annotate", enabled: false }),
    });
    assert.equal(off.status, 200);
    const planeOff = (await (await fetch(`${base}/edit/api/apps`)).json()) as {
      table: { rail: Array<{ app: string }> };
    };
    assert.ok(!planeOff.table.rail.some((r) => r.app === "annotate"), "a disabled app stayed mounted");
    const refused = await fetch(`${base}/edit/api/apps/surface?app=annotate&contribution=notes`);
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { reason: string }).reason, "refused_mount");

    // re-enable with consent: the grants recorded are what the manifest asks TODAY
    const on = await fetch(`${base}/edit/api/apps/state`, {
      method: "POST", body: JSON.stringify({ app: "annotate", grants: true, enabled: true }),
    });
    assert.deepEqual(((await on.json()) as { grants: string[] }).grants, ["project:read", "selection:read"]);

    // storage: a namespaced JSON object, round-tripped; a non-object body is refused
    const put = await fetch(`${base}/edit/api/apps/storage/annotate`, {
      method: "PUT", body: JSON.stringify({ draft: { n: 1 } }),
    });
    assert.equal(put.status, 200);
    const got = (await (await fetch(`${base}/edit/api/apps/storage/annotate`)).json()) as { value: { draft: { n: number } } };
    assert.equal(got.value.draft.n, 1);
    const bad = await fetch(`${base}/edit/api/apps/storage/annotate`, { method: "PUT", body: "[1,2]" });
    assert.equal(bad.status, 400);

    // uninstall keeps data unless asked, and says the state row is gone
    const un = await fetch(`${base}/edit/api/apps/uninstall`, {
      method: "POST", body: JSON.stringify({ app: "annotate" }),
    });
    assert.equal(((await un.json()) as { dataKept: boolean }).dataKept, true);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit apps: the surgery door stamps app provenance and the event hub carries the save", async () => {
  const fx = appProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // subscribe the SSE lane first, so the save's document.saved frame is observable
    const eventsRes = await fetch(`${base}/edit/api/apps/events`);
    assert.equal(eventsRes.status, 200);
    const reader = eventsRes.body!.getReader();
    const decoder = new TextDecoder();
    let frames = "";

    const edit = await fetch(`${base}/edit/api/edit/${encodeURIComponent("Components/App.dsx")}`, {
      method: "POST",
      headers: { "x-despia-app": "annotate" },
      body: JSON.stringify({ kind: "setAttribute", path: "", name: "tooltip", value: "from the app" }),
    });
    assert.equal(edit.status, 200);

    // the provenance ledger: one JSON line naming the app, beside the state it edits
    const log = readFileSync(join(fx.root, ".despia", "apps", "activity.log"), "utf8").trim().split("\n");
    const entry = JSON.parse(log[log.length - 1]!) as { app: string; document: string };
    assert.equal(entry.app, "annotate");
    assert.equal(entry.document, "Components/App.dsx");

    // and the hub delivered document.saved with the app's byline
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !frames.includes("event: document.saved")) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((r) => setTimeout(() => r({ value: undefined, done: false }), 250)),
      ]);
      if (done) break;
      if (value !== undefined) frames += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    assert.ok(frames.includes("event: document.saved"), "the save never reached the app event lane");
    const dataLine = frames.split("\n").find((l) => l.startsWith("data: ") && l.includes("app:annotate"));
    assert.ok(dataLine !== undefined, `document.saved carried no app byline (got: ${frames.slice(0, 400)})`);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("edit apps: the census move — the Studio's rail destinations arrive through the ONE fold", async () => {
  const fx = appProject();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const plane = (await (await fetch(`${base}/edit/api/apps`)).json()) as {
      apps: Array<{ scheme: string; kind: string }>;
      table: { rail: Array<{ app: string; contribution: { id: string; order: number } }> };
    };
    // THE PIN (studio-apps.md §12): the Editor's own destinations are facets.apps rows in
    // its manifest, folded by resolveStudioApps beside everyone else's. This list moves
    // only with the manifest — a rail identity added or renamed anywhere else is the drift
    // this test exists to catch. NINE, not ten: Distribution moved to the Marketing Studio
    // app (the first conversion), whose row is pinned right below under its OWN identity.
    const NINE = ["map", "screen", "state", "logic", "theme", "strings", "chat", "tools", "server"];
    const editorRows = plane.table.rail.filter((r) => r.app === "editor").map((r) => r.contribution.id);
    assert.deepEqual(editorRows, NINE, "the Studio's rail census moved");
    const editor = plane.apps.find((a) => a.scheme === "editor");
    assert.equal(editor?.kind, "builtin");
    // the conversion: Distribution rides the marketing app's identity, directly after the
    // editor block (order 110), disableable on its own
    const marketingAt = plane.table.rail.findIndex((r) => r.app === "marketing" && r.contribution.id === "shots");
    assert.equal(marketingAt, NINE.length, "the Marketing Studio row is not where its order puts it");
    assert.equal(plane.apps.find((a) => a.scheme === "marketing")?.kind, "builtin");
    // the dev app rides the SAME lane, after every census-ordered row (order 500)
    const annotateAt = plane.table.rail.findIndex((r) => r.app === "annotate");
    assert.ok(annotateAt > marketingAt, "a default-order app row landed inside the census block");
  } finally {
    await server.close();
    fx.cleanup();
  }
});
