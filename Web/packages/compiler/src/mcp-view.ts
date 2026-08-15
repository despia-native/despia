//
//  mcp-view.ts - compile ONE .dsx component into a self-contained MCP Apps view
//  (proposals/mcp-apps.md §3/§4): a single `text/html;profile=mcp-app` document with the
//  kernel, the DOM renderer, the component registry slice and the host bridge all inlined.
//
//  Self-containment is not a preference here, it is the spec: the host serves the view under
//  a CSP whose default is `default-src 'none'; script-src 'self' 'unsafe-inline';
//  connect-src 'none'`, so a CDN script, a remote font or a stylesheet link would simply be
//  blocked. This is the same trick build-editor-dist.ts already plays for the file:// demo,
//  which is why the format cost us nothing.
//
//  The data path is SSR-shaped, deliberately: the tool ran on the server, its resolved value
//  arrives as `ui/notifications/tool-result`, and the view hydrates against it. The work
//  happens outside the box; the box renders it.
//

import { buildSync } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRegistry } from "./registry.ts";

export type McpViewInput = {
  /** Absolute path of the module folder that owns the component (its dsx.json lives here). */
  moduleDir: string;
  /** The component's qualified name in the built registry, e.g. "catalogue.SearchResults". */
  component: string;
  /** Absolute path of the web workspace root — esbuild resolves @despia/* by walking up from it. */
  webRoot: string;
  /** Document title. Hosts mostly ignore it; a human opening the file in a browser does not. */
  title?: string;
  /** Byte ceiling for the gzipped document. Omit for no ceiling. */
  budgetKB?: number;
};

export type McpViewOutput = {
  html: string;
  bytes: number;
  gzipBytes: number;
};

/** `</script` inside inlined JS would end the block early. The only escaping this needs. */
const inlineJs = (source: string): string => source.replace(/<\/script/gi, "<\\/script");

/**
 * The `ui` residence seam list (proposals/mcp-apps.md §6), enforced at BUILD time.
 *
 * The kernel that gets bundled into a view still CONTAINS its network surface — it is one
 * kernel, shared with every other renderer, and carving per-surface holes in it would be the
 * `#if` disease. So the gate goes here, on the authored document: a view that names a network
 * construct is rejected before it ships, instead of compiling clean and dying inside a host
 * whose CSP is `connect-src 'none'`. Egress from a view is the host-proxied `tools/call` and
 * nothing else.
 */
const BANNED_SEAMS: Array<{ pattern: RegExp; seam: string }> = [
  { pattern: /\bfetch\s*\(/, seam: "fetch()" },
  { pattern: /\bnew\s+WebSocket\b/, seam: "WebSocket" },
  { pattern: /\bnew\s+EventSource\b/, seam: "EventSource" },
  { pattern: /\bXMLHttpRequest\b/, seam: "XMLHttpRequest" },
  { pattern: /\bnavigator\s*\.\s*sendBeacon\b/, seam: "navigator.sendBeacon" },
  { pattern: /<\s*api\b/i, seam: "<api> (a declarative request is still a request)" },
];

/**
 * Reject a document that reaches past the seam list. Returns the offending seams so the
 * caller can name every one at once rather than making the author fix them one build at a
 * time.
 *
 * Scope, stated because it is a real limit: this reads the NAMED component's own source. A
 * child component pulled in from elsewhere in the module is not walked yet — the registry
 * slice would give us that set, and wiring it is the named remainder for the lint twin
 * (`lint_dsx --strict`), which is where this rule ultimately belongs.
 */
export function viewSeamViolations(source: string): string[] {
  // Comments are not code; a doc block explaining why fetch is banned must not trip the ban.
  const code = source.replace(/<!--[\s\S]*?-->/g, "");
  return BANNED_SEAMS.filter(({ pattern }) => pattern.test(code)).map(({ seam }) => seam);
}

/**
 * Build the view document. Throws on an unknown component or a blown budget — a view that
 * silently ships broken or oversized is worse than a red build.
 */
export function buildMcpView(input: McpViewInput): McpViewOutput {
  const registry = buildRegistry([{ dir: input.moduleDir }]);
  if (registry.components[input.component] === undefined) {
    const known = Object.keys(registry.components).sort().join(", ");
    throw new Error(`[mcp-view] unknown component ${input.component} (registry has: ${known})`);
  }

  const bare = input.component.slice(input.component.lastIndexOf(".") + 1);
  const sourcePath = join(input.moduleDir, "Components", `${bare}.dsx`);
  let source: string | null = null;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch {
    source = null; // an inline or generated component; the lint twin still covers it
  }
  if (source !== null) {
    const violations = viewSeamViolations(source);
    if (violations.length > 0) {
      throw new Error(
        `[mcp-view] ${input.component} reaches past the ui residence seam list: ${violations.join(", ")}. ` +
          `A view's only egress is the host-proxied tools/call — dsx.module.mcp.call({name, arguments}).`,
      );
    }
  }

  const tag = "dsx-mcp-view";
  const stage = mkdtempSync(join(tmpdir(), "dsx-mcp-view-"));
  // The entry must live INSIDE the workspace: esbuild resolves bare @despia/* specifiers by
  // walking up from the importing file, and a temp dir has no node_modules above it.
  const entryPath = join(input.webRoot, `.mcp-view.${process.pid}.entry.ts`);
  const outfile = join(stage, "view.js");

  writeFileSync(
    entryPath,
    [
      `import { defineDsxElement } from "@despia/element";`,
      `import { mountMcpApp } from "@despia/dom/mcp-app";`,
      ``,
      `const registry = JSON.parse(${JSON.stringify(JSON.stringify(registry))});`,
      `const el = document.createElement(${JSON.stringify(tag)});`,
      ``,
      `// The bus inside a view IS the host proxy: there is no other egress under the CSP,`,
      `// so dsx.module.mcp.call({name, arguments}) is the one door and it is auditable.`,
      `let bridge = null;`,
      `const hostModule = {`,
      `  scheme: "mcp",`,
      `  actions: {`,
      `    call: async (args) => {`,
      `      if (bridge === null) return { ok: false, code: -32000, message: "view not mounted" };`,
      `      const name = typeof args?.name === "string" ? args.name : "";`,
      `      if (name === "") return { ok: false, code: -32602, message: "call needs a tool name" };`,
      `      const rest = args?.arguments;`,
      `      const payload = rest && typeof rest === "object" && !Array.isArray(rest) ? rest : {};`,
      `      return await bridge.callTool(name, payload);`,
      `    },`,
      `  },`,
      `};`,
      ``,
      `defineDsxElement({`,
      `  tag: ${JSON.stringify(tag)},`,
      `  component: ${JSON.stringify(input.component)},`,
      `  registry,`,
      `  modules: [hostModule],`,
      `});`,
      ``,
      `const mounted = mountMcpApp({`,
      `  sizeTarget: document.body,`,
      `  onInput: (i) => { el.input = i.arguments; },`,
      `  onData: (result) => {`,
      `    // structuredContent is the resolved action value — the same payload the text`,
      `    // fallback was derived from, so the view and the text can never disagree.`,
      `    const structured = result && typeof result === "object" ? result.structuredContent : null;`,
      `    el.data = structured ?? null;`,
      `    el.result = result ?? null;`,
      `  },`,
      `});`,
      `bridge = mounted.bridge;`,
      `document.body.appendChild(el);`,
      ``,
    ].join("\n"),
  );

  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      minify: true,
      format: "esm",
      target: "es2022",
      outfile,
      absWorkingDir: input.webRoot,
      logLevel: "silent",
    });
  } finally {
    rmSync(entryPath, { force: true });
  }

  const bundle = readFileSync(outfile, "utf8");
  rmSync(stage, { recursive: true, force: true });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title ?? input.component)}</title>
<style>
  /* No reset beyond this: the host owns the surrounding chrome, and its theme variables
     arrive at runtime. A view that paints its own background fights the host. */
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: var(--font-sans, system-ui, sans-serif); color: var(--color-text-primary, inherit); }
</style>
</head>
<body>
<script type="module">
${inlineJs(bundle)}
</script>
</body>
</html>
`;

  const bytes = Buffer.byteLength(html, "utf8");
  const gzipBytes = gzipSync(Buffer.from(html, "utf8")).length;
  if (input.budgetKB !== undefined && gzipBytes > input.budgetKB * 1024) {
    throw new Error(
      `[mcp-view] ${input.component} is ${(gzipBytes / 1024).toFixed(1)}KB gz — over the ${input.budgetKB}KB budget`,
    );
  }
  return { html, bytes, gzipBytes };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
