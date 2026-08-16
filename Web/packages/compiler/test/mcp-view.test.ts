//
//  The MCP Apps view compiler (proposals/mcp-apps.md §3): does a .dsx component become a
//  document a spec-compliant host can actually render?
//
//  The assertions are deliberately about the CSP, not about markup: a view that renders
//  perfectly in a browser and reaches for one external byte is dead inside a host whose
//  default policy is `default-src 'none'; connect-src 'none'`. So this test builds the real
//  bundle from a real registry and then interrogates the document for anything that would
//  need the network.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { buildMcpView, viewSeamViolations } from "../src/mcp-view.ts";

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    try {
      readFileSync(join(dir, "OpenSource/Conformance/README.md"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("repo root not found");
      dir = parent;
    }
  }
}

const ROOT = repoRoot();
const WEB = join(ROOT, "OpenSource/Web");
const FIXTURE = join(WEB, "packages/compiler/test/fixtures/mcp-view");

const build = () =>
  buildMcpView({ moduleDir: FIXTURE, component: "mcpfx.Results", webRoot: WEB, title: "Results" });

test("mcp-view: compiles a component into one self-contained document", () => {
  const out = build();
  assert.match(out.html, /^<!doctype html>/);
  assert.match(out.html, /<title>Results<\/title>/);
  assert.ok(out.bytes > 10_000, "a document carrying the kernel is not tiny");
  assert.ok(out.gzipBytes < out.bytes, "gzip size is measured, not guessed");
});

test("mcp-view: nothing in the document needs the network", () => {
  const { html } = build();
  // No external subresources: every src/href must be inline or absent entirely.
  const externals = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1] ?? "");
  const remote = externals.filter((u) => /^(?:https?:)?\/\//.test(u));
  assert.deepEqual(remote, [], `document references remote subresources: ${remote.join(", ")}`);

  // No import of a bare or remote module specifier survived bundling.
  assert.doesNotMatch(html, /\bimport\s+[^;]*\bfrom\s*["'](?!\.)[^"']+["']/, "an unbundled import survived");
  assert.doesNotMatch(html, /@import\s+url\(/i, "a CSS @import would be blocked by the host CSP");
});

// The bundled kernel still CONTAINS a network surface — it is one kernel, shared with every
// other renderer, and carving per-surface holes in it would be the `#if` disease the
// constitution bans. So reachability is gated on the AUTHORED document instead, at build.
test("mcp-view: the ui residence seam list is enforced on the authored document", () => {
  assert.deepEqual(viewSeamViolations(`<stack><text value="{{ x }}"/></stack>`), []);
  assert.deepEqual(viewSeamViolations(`<action as="go">const r = await fetch(url)</action>`), ["fetch()"]);
  assert.deepEqual(viewSeamViolations(`<head><api as="rows" url="/x"/></head>`), [
    "<api> (a declarative request is still a request)",
  ]);
  // A comment explaining the ban must not trip the ban.
  assert.deepEqual(viewSeamViolations(`<!-- never call fetch( here --><stack/>`), []);
});

test("mcp-view: a view that reaches past the seam list fails the build", () => {
  assert.throws(
    () => buildMcpView({ moduleDir: FIXTURE, component: "mcpfx.Leaky", webRoot: WEB }),
    /reaches past the ui residence seam list: fetch\(\)/,
  );
});

test("mcp-view: the host bridge and the proxy module are both present", () => {
  const { html } = build();
  assert.match(html, /ui\/initialize/, "the handshake request must be in the bundle");
  assert.match(html, /ui\/notifications\/initialized/);
  assert.match(html, /tools\/call/, "the one egress must be in the bundle");
});

test("mcp-view: an unknown component fails the build loudly", () => {
  assert.throws(
    () => buildMcpView({ moduleDir: FIXTURE, component: "mcpfx.Nope", webRoot: WEB }),
    /unknown component mcpfx\.Nope/,
  );
});

test("mcp-view: a blown budget fails the build rather than shipping oversized", () => {
  assert.throws(
    () => buildMcpView({ moduleDir: FIXTURE, component: "mcpfx.Results", webRoot: WEB, budgetKB: 1 }),
    /over the 1KB budget/,
  );
});
