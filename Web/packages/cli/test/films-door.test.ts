//
//  films-door.test.ts - /edit/api/films: the Distribution board's film half.
//
//  The listing is the DISK, with the validator's verdict attached: a lawful composition
//  lists lawful, an unlawful one lists its refusal in the guard's own words, and the render
//  endpoint refuses paths that are not marketing compositions inside the project. Rendering
//  itself is film.test.ts's business - this door test proves the Studio sees the truth.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const LAWFUL = `<film id="launch" duration="2s" fps="30" size="540x960">
  <scene for="2s"><text role="hook">Hello</text></scene>
</film>
`;
// scene sums to 1s against a 2s declaration - the duration guard refuses
const UNLAWFUL = `<film id="short" duration="2s" fps="30" size="540x960">
  <scene for="1s"><text role="hook">Hello</text></scene>
</film>
`;

function project(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-films-door-"));
  for (const [path, contents] of Object.entries({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": "<stack><text value=\"hi\"/></stack>",
    "marketing/launch/composition.dsx": LAWFUL,
    "marketing/short/composition.dsx": UNLAWFUL,
  })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test("the films door lists compositions with the validator's verdict", async () => {
  const fx = project();
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const body = await (await fetch(`${base}/edit/api/films`)).json() as {
      films: Array<{ id: string; path: string; scenes: number; durationMs: number;
                     problems: Array<{ code: string }> }>;
      ffmpeg: boolean;
    };
    assert.equal(body.films.length, 2);
    const lawful = body.films.find((f) => f.id === "launch")!;
    assert.equal(lawful.problems.length, 0);
    assert.equal(lawful.scenes, 1);
    assert.equal(lawful.durationMs, 2000);
    const unlawful = body.films.find((f) => f.id === "short")!;
    assert.ok(unlawful.problems.some((p) => p.code === "duration"),
      "the refused film lists its refusal, in the guard's words");
    assert.equal(typeof body.ffmpeg, "boolean", "the master-tier capability rides the listing");

    // the render endpoint refuses paths outside the convention
    const bad = await fetch(`${base}/edit/api/films/render`, {
      method: "POST", body: JSON.stringify({ path: "../../etc/passwd" }),
    });
    assert.equal(bad.status, 400);
    // and refuses to render the unlawful film, naming the problems
    const refused = await fetch(`${base}/edit/api/films/render`, {
      method: "POST", body: JSON.stringify({ path: "marketing/short/composition.dsx" }),
    });
    assert.equal(refused.status, 422);
    const payload = await refused.json() as { problems: Array<{ code: string }> };
    assert.ok(payload.problems.some((p) => p.code === "duration"));
  } finally {
    await server.close();
    fx.cleanup();
  }
});
