//
//  registry-site.test.ts — the registry site is a REAL dsx-build product: generated project,
//  compiled pages, SSR'd text that renders with scripts disabled, and the crawler surface
//  (canonical, JSON-LD, meta CSP, sitemap, llms.txt, atom, .md siblings) on every page.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildSite } from "../src/registry-site.ts";
import type { RegistryIndex } from "../src/registry.ts";

const BASE = "https://despia-native.github.io/registry";

const FIRST_PARTY: RegistryIndex = {
  version: 1, generated: "test",
  packages: [
    { id: "core/camera", name: "Camera", scheme: "camera", summary: "Take photos and scan the library.",
      owner: "despia-native", version: "1.0.0", platforms: ["ios", "android"], actions: ["capture"] },
    { id: "core/haptics", name: "Haptics", scheme: "haptics", summary: "",
      owner: "despia-native", version: "1.0.0", platforms: ["ios"], actions: [] },
  ],
};

const DETAILS = {
  packages: [{
    id: "core/camera", chain: "camera",
    actions: [{
      name: "capture", call: "dsx.module.camera.capture",
      doc: "Opens the system camera and resolves the captured image.",
      args: { quality: { type: "number", optional: true } },
      resolves: { uri: "string" },
      errors: [{ code: "denied", message: "Camera permission was refused.", recoverable: true }],
      examples: [{ name: "capture a photo", args: { quality: 0.8 }, resolve: { uri: "file://…" } }],
    }],
  }],
};

const COMMUNITY: RegistryIndex = {
  version: 1, generated: "test",
  packages: [
    { id: "github:acme/dsx-lidar", name: "Lidar", scheme: "lidar", summary: "Depth from the camera array.",
      owner: "acme", repo: "dsx-lidar", version: "1.2.0", platforms: ["ios"], actions: ["scan"],
      license: "MIT", updated: "2026-08-01T00:00:00Z" },
  ],
};

test("the site compiles from DSX sources and every page carries the crawler surface", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsx-site-"));
  try {
    const result = buildSite({ baseUrl: BASE, firstParty: FIRST_PARTY, details: DETAILS, community: COMMUNITY }, dir);
    // home + 3 packages + 1 detailed action + 1 name-only community action
    assert.equal(result.pages, 6);

    const home = readFileSync(join(result.outDir, "index.html"), "utf8");
    assert.ok(home.includes("Despia Packages"), "SSR: the text is IN the HTML, scripts disabled or not");
    assert.ok(home.includes("Content-Security-Policy"), "GitHub Pages serves no headers, so the CSP rides the document");

    const pkg = readFileSync(join(result.outDir, "packages", "core", "camera", "index.html"), "utf8");
    assert.ok(!pkg.includes("despia add core/camera") && pkg.includes("ships with the Despia framework"),
      "a first-party page says how it ships instead of faking an install line");
    assert.ok(pkg.includes(`<link rel="stylesheet" href="../../../site.css">`),
      "the ~200KB of system CSS is extracted to ONE cached site.css, not shipped per page " +
      "(the tiny @layer ordering statement rightly stays inline, ahead of the link)");
    assert.ok(pkg.length < 30_000, `a docs page should be pages, not payloads — got ${pkg.length} bytes`);
    assert.ok(existsSync(join(result.outDir, "site.css")));
    assert.ok(pkg.includes(`<link rel="canonical" href="${BASE}/packages/core/camera/">`));
    assert.ok(pkg.includes("SoftwareSourceCode"), "JSON-LD SoftwareSourceCode per package");

    const action = readFileSync(join(result.outDir, "packages", "core", "camera", "capture", "index.html"), "utf8");
    assert.ok(action.includes("Opens the system camera"), "the action DOC is on the action page");
    assert.ok(action.includes("Camera permission was refused."), "error messages are page content — each answers a search");
    assert.ok(action.includes("TechArticle"), "JSON-LD TechArticle per action");

    const community = readFileSync(join(result.outDir, "packages", "github", "acme", "dsx-lidar", "index.html"), "utf8");
    assert.ok(community.includes("despia add github:acme/dsx-lidar@1.2.0"),
      "the copy-ready install snippet is what every visitor came for");

    // The Markdown sibling, the sitemap, llms.txt and the feed.
    const md = readFileSync(join(result.outDir, "packages", "core", "camera", "capture", "index.md"), "utf8");
    assert.ok(md.startsWith("# dsx.module.camera.capture"));
    const sitemap = readFileSync(join(result.outDir, "sitemap.xml"), "utf8");
    assert.equal((sitemap.match(/<loc>/g) ?? []).length, 6);
    const llms = readFileSync(join(result.outDir, "llms.txt"), "utf8");
    assert.ok(llms.includes(`${BASE}/packages/core/camera/index.md`));
    const atom = readFileSync(join(result.outDir, "atom.xml"), "utf8");
    assert.ok(atom.includes("github:acme/dsx-lidar") === false && atom.includes("Lidar (acme/dsx-lidar)"),
      "the feed carries the community package by title");
    assert.ok(existsSync(join(result.outDir, "robots.txt")));
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("the REAL data compiles: every first-party package and every declared action", { timeout: 600_000 }, () => {
  const repo = resolve(import.meta.dirname, "../../../../..");
  const detailsPath = join(repo, "ClosedSource", "Registry", "first-party-details.json");
  const indexPath = resolve(import.meta.dirname, "../src/first-party-index.json");
  if (!existsSync(detailsPath)) {
    // The OSS mirror ships without ClosedSource; the fixture test above still guards the shape.
    return;
  }
  const firstParty = JSON.parse(readFileSync(indexPath, "utf8")) as RegistryIndex;
  const details = JSON.parse(readFileSync(detailsPath, "utf8")) as typeof DETAILS;
  const dir = mkdtempSync(join(tmpdir(), "dsx-site-full-"));
  try {
    const result = buildSite({ baseUrl: BASE, firstParty, details }, dir);
    assert.ok(result.pages > 600, `expected a page per package + per action, got ${result.pages}`);
    assert.ok(existsSync(join(result.outDir, "packages", "core", "camera", "index.html")));
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
