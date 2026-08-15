//
//  site-node.test.ts — A1's gate. The chain (static → page → null) and, more importantly, the
//  [S-BOUNDARY] traversal refusals: this is the first code in the server package that takes a
//  path from the wire to the filesystem, so the escape cases are pinned here rather than trusted.
//
//  The traversal block is written to fail CLOSED and to be indistinguishable from "absent": a
//  blocked path and a missing file both answer null, so probing cannot map the filesystem.
//
//  ⚠️ READ BEFORE "SIMPLIFYING" resolveWithin. Its two defences — the `..` segment reject and the
//  final containment check — are REDUNDANT ON PURPOSE, and that redundancy has a measured cost:
//  mutation-tested 2026-08-10, deleting EITHER one alone leaves this whole file green, because
//  the other catches every case here. Only removing BOTH turns it red. So CI cannot tell you that
//  a layer is load-bearing, and a future reader who deletes one as "dead code" gets no warning —
//  which is precisely why the containment check must stay even though the segment reject appears
//  to make it unreachable. It is the backstop for the cases the parser above has not thought of
//  (symlinks out of the root, a future edit to the segment logic, a platform separator quirk):
//  the one check that holds when the reasoning above is wrong.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentTypeFor, cacheControlFor, resolveWithin, createSiteHandler } from "../src/site-node.ts";

// ── a built-site fixture ─────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "dsx-site-"));
writeFileSync(join(root, "index.html"), "<!doctype html><p>home</p>");
writeFileSync(join(root, "main.a1b2c3d4.js"), "export const x = 1;");
writeFileSync(join(root, "styles.css"), "p{color:red}");
mkdirSync(join(root, "nested"), { recursive: true });
writeFileSync(join(root, "nested", "index.html"), "<!doctype html><p>nested</p>");
// the secret a traversal would be reaching for, one level ABOVE the site root
writeFileSync(join(root, "..", "dsx-site-secret.txt"), "TOP SECRET");

/** The page handler needs a registry; an empty route table makes every page request a miss, so
 *  these cases isolate the STATIC half. Route-table behaviour is live-adapter.test.ts's job. */
const emptyRegistry = { components: {}, routes: [], schemes: [] } as never;
const handler = createSiteHandler(root, emptyRegistry);
const get = (p: string, method = "GET"): Request => new Request(`http://x${p}`, { method });

// ── [S-BOUNDARY] traversal ───────────────────────────────────────────────────

test("resolveWithin refuses every escape shape, and refuses as ABSENT (null), never as an error", () => {
  const escapes = [
    "/../dsx-site-secret.txt",
    "/nested/../../dsx-site-secret.txt",
    "/%2e%2e/dsx-site-secret.txt",          // encoded ..
    "/..%2fdsx-site-secret.txt",            // encoded slash
    "/nested/%2e%2e/%2e%2e/dsx-site-secret.txt",
    "/a/../../b",
    "/\0/etc/passwd",                        // NUL
    "/C:/Windows/win.ini",                   // drive letter
    "/..\\dsx-site-secret.txt",             // backslash traversal
  ];
  for (const p of escapes) {
    assert.equal(resolveWithin(root, p), null, `must refuse: ${p}`);
  }
});

test("DOUBLE-decoding is not performed — %252e%252e stays a literal name, it does not become ..", () => {
  // If this ever decodes twice, the value below turns into `../dsx-site-secret.txt` AFTER the
  // segment check has already run — the exact bypass the single-decode rule exists to stop.
  const resolved = resolveWithin(root, "/%252e%252e/x.txt");
  assert.notEqual(resolved, null, "a literal %2e%2e name is a legal (if odd) filename");
  assert.ok(resolved!.startsWith(root), "and it must still resolve INSIDE the root");
});

test("resolveWithin admits ordinary paths and normalises . segments", () => {
  assert.equal(resolveWithin(root, "/index.html"), join(root, "index.html"));
  assert.equal(resolveWithin(root, "/./nested/./index.html"), join(root, "nested", "index.html"));
  assert.equal(resolveWithin(root, "/"), root);
});

test("a traversal request over the real handler answers null (chain falls through), never the file", async () => {
  const res = await handler(get("/../dsx-site-secret.txt"));
  assert.equal(res, null, "the secret above the root must never be served");
});

// ── the static half ──────────────────────────────────────────────────────────

test("serves a file with its content type and length", async () => {
  const res = await handler(get("/styles.css"));
  assert.ok(res);
  assert.equal(res!.status, 200);
  assert.equal(res!.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(await res!.text(), "p{color:red}");
});

test("a content-hashed asset is immutable; an unhashed one is never cached", async () => {
  const hashed = await handler(get("/main.a1b2c3d4.js"));
  assert.equal(hashed!.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const plain = await handler(get("/styles.css"));
  assert.equal(plain!.headers.get("cache-control"), "no-store");
  // the classifier itself, so the rule is pinned independently of the fixture names
  assert.equal(cacheControlFor("/x/app.deadbeef12.css"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("/x/app.css"), "no-store");
});

test("HEAD returns the headers and no body", async () => {
  const res = await handler(get("/styles.css", "HEAD"));
  assert.equal(res!.status, 200);
  assert.equal(res!.headers.get("content-length"), "12");
  assert.equal(await res!.text(), "");
});

test("a directory serves its index.html", async () => {
  for (const p of ["/", "/nested", "/nested/"]) {
    const res = await handler(get(p));
    assert.ok(res, `${p} should serve an index`);
    assert.equal(res!.status, 200);
    assert.equal(res!.headers.get("content-type"), "text/html; charset=utf-8");
  }
});

test("directoryIndex:false stops serving index.html for a directory", async () => {
  const strict = createSiteHandler(root, emptyRegistry, { directoryIndex: false });
  assert.equal(await strict(get("/nested")), null);
  assert.ok(await strict(get("/nested/index.html")), "the explicit file still serves");
});

// ── the chain contract ───────────────────────────────────────────────────────

test("a non-GET/HEAD method is NOT the site's — it falls through to the API host", async () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(await handler(get("/index.html", m)), null, `${m} must fall through`);
  }
});

test("an unknown path with no matching route falls through, so API routes still reach the host", async () => {
  assert.equal(await handler(get("/health")), null);
  assert.equal(await handler(get("/notes")), null);
});

test("content types cover what a DSX build emits, and an unknown extension is never guessed", () => {
  assert.equal(contentTypeFor("a.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("a.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("a.woff2"), "font/woff2");
  assert.equal(contentTypeFor("a.wasm"), "application/wasm");
  assert.equal(contentTypeFor("a.WEBP"), "image/webp", "extension match is case-insensitive");
  assert.equal(contentTypeFor("a.zzz"), "application/octet-stream");
  assert.equal(contentTypeFor("noextension"), "application/octet-stream");
});
