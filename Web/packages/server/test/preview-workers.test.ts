//
//  preview-workers.test.ts — the multi-tenant preview face (preview-workers.ts,
//  preview-hosting.md): the control plane (admission, publish, immutability at the door,
//  activate, permalink, rollback-as-repoint), the tenant plane (hostname pointer, static
//  objects, live SSR from the tenant's own registry, isolation between tenants), and the
//  [S-BOUNDARY] key containment. Stores are in-memory structural stubs of R2/KV — the
//  handler carries no platform types, so the whole face tests without an account.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../../compiler/src/component.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import {
  createPreviewHandler,
  resolveKeyWithin,
  PREVIEW_KEY_HEADER,
  type PreviewObjectStore,
  type PreviewPointerStore,
} from "../src/preview-workers.ts";

// ── the structural stubs ─────────────────────────────────────────────────────────────

function memoryBucket(): PreviewObjectStore & { keys(): string[] } {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    async get(key) {
      const hit = objects.get(key);
      if (hit === undefined) return null;
      return {
        body: new Response(hit.bytes.slice() as unknown as BodyInit).body as ReadableStream<Uint8Array>,
        httpMetadata: { contentType: hit.contentType },
      };
    },
    async put(key, value, opts) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    keys() {
      return [...objects.keys()];
    },
  };
}

function memoryPointers(): PreviewPointerStore {
  const rows = new Map<string, string>();
  return {
    async get(key) {
      return rows.get(key) ?? null;
    },
    async put(key, value) {
      rows.set(key, value);
    },
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────

const KEY = "test-admin-key";
const APEX = "despia.app";

function registryOf(sources: { [q: string]: string }, routes: Registry["routes"]): Registry {
  const components: Registry["components"] = {};
  for (const [qualified, markup] of Object.entries(sources)) {
    const scheme = qualified.substring(0, qualified.indexOf("."));
    const name = qualified.substring(qualified.indexOf(".") + 1);
    components[qualified] = compileComponent(name, scheme, markup);
  }
  return { components, globalPool: {}, css: "", schemes: [], routes };
}

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function bundleFiles(files: { [path: string]: string }): { path: string; b64: string }[] {
  return Object.entries(files).map(([path, text]) => ({ path, b64: b64(text) }));
}

function admin(path: string, init: RequestInit = {}): Request {
  return new Request(`https://ctl.${APEX}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), [PREVIEW_KEY_HEADER]: KEY },
  });
}

interface World {
  handle: (req: Request) => Promise<Response>;
  bucket: ReturnType<typeof memoryBucket>;
}

function world(): World {
  const bucket = memoryBucket();
  const pointers = memoryPointers();
  const handle = createPreviewHandler({ bucket, pointers, apex: APEX, adminKey: KEY });
  return { handle, bucket };
}

async function publishAndActivate(
  w: World,
  app: string,
  deployment: string,
  host: string,
  files: { [path: string]: string },
): Promise<void> {
  const put = await w.handle(admin(`/-/apps/${app}/deployments/${deployment}`, {
    method: "PUT",
    body: JSON.stringify({ files: bundleFiles(files) }),
  }));
  assert.equal(put.status, 201, await put.text());
  const act = await w.handle(admin("/-/activate", {
    method: "POST",
    body: JSON.stringify({ host, app, deployment }),
  }));
  assert.equal(act.status, 200, await act.text());
}

const HOME = `<stack><text value="hello from {{ vars.who ?? 'the preview' }}"/></stack>`;

// ── the control plane ────────────────────────────────────────────────────────────────

test("preview: the control plane without the key reads exactly like an unknown path", async () => {
  const w = world();
  const res = await w.handle(new Request(`https://ctl.${APEX}/-/health`));
  assert.equal(res.status, 404);
  // and WITH the key it answers
  const ok = await w.handle(admin("/-/health"));
  assert.equal(ok.status, 200);
});

test("preview: no admin key configured means the control plane does not exist (fail closed)", async () => {
  const bucket = memoryBucket();
  const handle = createPreviewHandler({ bucket, pointers: memoryPointers(), apex: APEX });
  const res = await handle(admin("/-/health"));
  assert.equal(res.status, 404);
});

test("preview: a deployment is immutable at the door — the second publish is a 409", async () => {
  const w = world();
  await publishAndActivate(w, "myapp", "dep1", "myapp", { "index.html": "<h1>one</h1>" });
  const again = await w.handle(admin("/-/apps/myapp/deployments/dep1", {
    method: "PUT",
    body: JSON.stringify({ files: bundleFiles({ "index.html": "<h1>overwrite</h1>" }) }),
  }));
  assert.equal(again.status, 409);
  // the live bytes never changed
  const page = await w.handle(new Request(`https://myapp.${APEX}/`));
  assert.ok((await page.text()).includes("one"));
});

test("preview: a traversal path in a bundle is refused before any write", async () => {
  const w = world();
  const res = await w.handle(admin("/-/apps/evil/deployments/dep1", {
    method: "PUT",
    body: JSON.stringify({ files: [{ path: "../../other/registry.json", b64: b64("{}") }] }),
  }));
  assert.equal(res.status, 400);
  assert.equal(w.bucket.keys().length, 0);
});

test("preview: an integrity pin that does not match the bytes is refused", async () => {
  const w = world();
  const res = await w.handle(admin("/-/apps/myapp/deployments/dep1", {
    method: "PUT",
    body: JSON.stringify({ files: [{ path: "a.txt", b64: b64("hello"), sha256: "00".repeat(32) }] }),
  }));
  assert.equal(res.status, 400);
});

test("preview: activating an unpublished deployment is a 404 — a torn upload can never go live", async () => {
  const w = world();
  const res = await w.handle(admin("/-/activate", {
    method: "POST",
    body: JSON.stringify({ host: "myapp", app: "myapp", deployment: "ghost" }),
  }));
  assert.equal(res.status, 404);
});

// ── the tenant plane ─────────────────────────────────────────────────────────────────

test("preview: hostname resolves the pointer and serves the static tree with real types", async () => {
  const w = world();
  await publishAndActivate(w, "myapp", "dep1", "myapp", {
    "index.html": "<h1>hello preview</h1>",
    "styles/app.css": "body { color: red }",
  });
  const page = await w.handle(new Request(`https://myapp.${APEX}/`));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.ok((await page.text()).includes("hello preview"));
  const css = await w.handle(new Request(`https://myapp.${APEX}/styles/app.css`));
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
});

test("preview: two tenants on one worker never see each other's bytes", async () => {
  const w = world();
  await publishAndActivate(w, "alpha", "dep1", "alpha", { "index.html": "alpha content" });
  await publishAndActivate(w, "beta", "dep1", "beta", { "index.html": "beta content" });
  assert.ok((await (await w.handle(new Request(`https://alpha.${APEX}/`))).text()).includes("alpha content"));
  assert.ok((await (await w.handle(new Request(`https://beta.${APEX}/`))).text()).includes("beta content"));
  // an unknown hostname is nobody
  assert.equal((await w.handle(new Request(`https://gamma.${APEX}/`))).status, 404);
});

test("preview: a dynamic route live-SSRs from the tenant's own registry", async () => {
  const w = world();
  const registry = registryOf({ "t.Home": HOME }, [{ path: "/hi/:who", component: "t.Home" }]);
  await publishAndActivate(w, "ssrapp", "dep1", "ssrapp", {
    "registry.json": JSON.stringify(registry),
  });
  const res = await w.handle(new Request(`https://ssrapp.${APEX}/hi/world`));
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("hello from world"));
});

test("preview: a new deployment is a pointer swap, and rollback is the repoint back", async () => {
  const w = world();
  await publishAndActivate(w, "myapp", "dep1", "myapp", { "index.html": "version one" });
  await publishAndActivate(w, "myapp", "dep2", "myapp", { "index.html": "version two" });
  assert.ok((await (await w.handle(new Request(`https://myapp.${APEX}/`))).text()).includes("version two"));

  const back = await w.handle(admin("/-/rollback", { method: "POST", body: JSON.stringify({ host: "myapp" }) }));
  assert.equal(back.status, 200);
  assert.ok((await (await w.handle(new Request(`https://myapp.${APEX}/`))).text()).includes("version one"));

  // rollback is itself rollback-able: current and previous swapped
  const forward = await w.handle(admin("/-/rollback", { method: "POST", body: JSON.stringify({ host: "myapp" }) }));
  assert.equal(forward.status, 200);
  assert.ok((await (await w.handle(new Request(`https://myapp.${APEX}/`))).text()).includes("version two"));
});

test("preview: replaying activate for the current deployment preserves the rollback target", async () => {
  const w = world();
  await publishAndActivate(w, "myapp", "dep1", "myapp", { "index.html": "version one" });
  await publishAndActivate(w, "myapp", "dep2", "myapp", { "index.html": "version two" });

  // a client retry after a lost 200: same activate again, must be a no-op write
  const replay = await w.handle(admin("/-/activate", {
    method: "POST",
    body: JSON.stringify({ host: "myapp", app: "myapp", deployment: "dep2" }),
  }));
  assert.equal(replay.status, 200);

  // rollback still lands on the TRUE prior deployment, not on dep2 itself
  const back = await w.handle(admin("/-/rollback", { method: "POST", body: JSON.stringify({ host: "myapp" }) }));
  assert.equal(back.status, 200);
  assert.ok((await (await w.handle(new Request(`https://myapp.${APEX}/`))).text()).includes("version one"));
});

test("preview: every activation also answers forever at its permalink host", async () => {
  const w = world();
  await publishAndActivate(w, "myapp", "dep1abcdef", "myapp", { "index.html": "version one" });
  await publishAndActivate(w, "myapp", "dep2abcdef", "myapp", { "index.html": "version two" });
  const old = await w.handle(new Request(`https://myapp--dep1abcd.${APEX}/`));
  assert.equal(old.status, 200);
  assert.ok((await old.text()).includes("version one"));
});

test("preview: the tenant plane owns GET/HEAD only", async () => {
  const w = world();
  await publishAndActivate(w, "myapp", "dep1", "myapp", { "index.html": "x" });
  const res = await w.handle(new Request(`https://myapp.${APEX}/`, { method: "POST" }));
  assert.equal(res.status, 405);
});

// ── the key boundary ─────────────────────────────────────────────────────────────────

test("preview: resolveKeyWithin refuses traversal, NUL, drive letters — and contains the rest", () => {
  assert.equal(resolveKeyWithin("apps/a/d", "/../secrets"), null);
  assert.equal(resolveKeyWithin("apps/a/d", "/a/%2e%2e/b"), null);
  // decoded ONCE: %252e%252e becomes the literal segment "%2e%2e", never ".."
  assert.equal(resolveKeyWithin("apps/a/d", "/a/%252e%252e/b"), "apps/a/d/a/%2e%2e/b");
  assert.equal(resolveKeyWithin("apps/a/d", "/C:/x"), null);
  assert.equal(resolveKeyWithin("apps/a/d", "/a\u0000b"), null);
  assert.equal(resolveKeyWithin("apps/a/d", "/ok/path.js"), "apps/a/d/ok/path.js");
  assert.equal(resolveKeyWithin("apps/a/d", "/"), "apps/a/d");
});
