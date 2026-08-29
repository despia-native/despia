//
//  The editor-session event plane: the hub's closed-list law + the handler-name
//  convention, both pinned by the shared corpus.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerResponse } from "node:http";

import { createAppEventHub } from "../src/studio-apps/events.ts";
import { EDITOR_EVENTS } from "../src/studio-apps/manifest.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance/studio-apps/events.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/studio-apps/events.json not found");
    dir = parent;
  }
}

const root = repoRoot();
const doc = JSON.parse(readFileSync(join(root, "OpenSource/Conformance/studio-apps/events.json"), "utf-8")) as {
  handlerNames: Record<string, string>;
  payloads: Record<string, string[]>;
  cases: Array<{ name: string; emit: string; payload: Record<string, unknown>; expect: { delivered: boolean } }>;
};


// The module's bare `@despia/kernel` import resolves through the page's import map in a
// build; node has no map here, so the shim rewrites it to the workspace's own kernel —
// the SAME class identity the runner's instanceof check sees in a real page.
import { mkdtempSync, writeFileSync as writeTmp } from "node:fs";
import { tmpdir } from "node:os";
async function importScopeModule(root: string): Promise<Record<string, any>> {
  const source = readFileSync(join(root, "ClosedSource/DSX/Modules/Core/Apps/web/scope.js"), "utf8");
  const kernel = pathToFileURL(join(root, "OpenSource/Web/node_modules/@despia/kernel/dist/index.js")).href;
  const rewritten = source.replace('from "@despia/kernel"', `from ${JSON.stringify(kernel)}`);
  const dir = mkdtempSync(join(tmpdir(), "dsx-scope-"));
  const file = join(dir, "scope.mjs");
  writeTmp(file, rewritten);
  return await import(pathToFileURL(file).href) as Record<string, any>;
}

const facet = await importScopeModule(root) as { handlerName: (kind: string) => string };

test("studio-apps/events: the handler-name convention matches the corpus for every kind", () => {
  for (const [kind, expected] of Object.entries(doc.handlerNames)) {
    assert.equal(facet.handlerName(kind), expected, kind);
  }
  // every editor event has a pinned name — the convention cannot silently miss one
  for (const kind of EDITOR_EVENTS) {
    assert.ok(doc.handlerNames[kind] !== undefined, `${kind} missing from the corpus handlerNames`);
  }
});

function fakeClient(): { res: ServerResponse; frames: string[] } {
  const frames: string[] = [];
  const res = {
    write: (chunk: string) => { frames.push(chunk); return true; },
    on: () => res,
  } as unknown as ServerResponse;
  return { res, frames };
}

for (const c of doc.cases) {
  test(`studio-apps/events: ${c.name}`, () => {
    const hub = createAppEventHub();
    const client = fakeClient();
    hub.subscribe(client.res);
    hub.emit(c.emit, c.payload);
    const delivered = client.frames.some((f) => f.startsWith(`event: ${c.emit}\n`));
    assert.equal(delivered, c.expect.delivered);
    if (c.expect.delivered) {
      assert.equal(hub.counts()[c.emit], 1);
      const frame = client.frames.find((f) => f.startsWith(`event: ${c.emit}\n`))!;
      const data = JSON.parse(frame.split("\ndata: ")[1]!.split("\n")[0]!) as Record<string, unknown>;
      for (const field of doc.payloads[c.emit] ?? []) {
        assert.ok(field in data, `payload field ${field}`);
      }
    }
  });
}
