//
//  dev.ts — `dsx dev`.
//
//  TWO modes, mirroring `dsx build`:
//
//   1. PROJECT (the default): build once, serve the output, watch the sources, rebuild on
//      change, and tell open browsers to reload over one Server-Sent Events channel. Whole
//      page, every time — v0.1 has no component-level hot swap (README: "What it does not do").
//   2. REPO DEMO (`--demo`): hands off to packages/compiler/bin/serve.ts `startServer`, the
//      repository's own dev/CI server, with its embed CORS and DSD fragment endpoint intact.
//      That server resolves its root by walking up to OpenSource/Conformance, so it can only
//      serve this repository — which is exactly what `--demo` asks for.
//

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildProject, findRepoRoot, type BuildResult } from "./build.ts";
import type { ProjectConfig } from "./config.ts";

export const MIME: { readonly [ext: string]: string } = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** The reload channel path. Chosen to be impossible to collide with a route. */
export const RELOAD_PATH = "/__dsx_dev_reload";

/** Every 200 is revalidated from disk: this is a dev server, and a browser reusing a
 *  registry/module from before a rebuild renders an older build convincingly. Same policy
 *  (and same reasoning) as `devResponseHeaders` in packages/compiler/bin/serve.ts. */
export function devHeaders(contentType: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { ...extra, "content-type": contentType, "cache-control": "no-store" };
}

/** The reload client, injected into every served HTML document. Zero dependencies, and it
 *  degrades to nothing if EventSource is unavailable. */
export const RELOAD_CLIENT = `<script>
(function () {
  if (typeof EventSource !== "function") return;
  var s = new EventSource(${JSON.stringify(RELOAD_PATH)});
  s.addEventListener("reload", function () { location.reload(); });
})();
</script>`;

export function injectReloadClient(html: string): string {
  const close = html.lastIndexOf("</body>");
  return close < 0 ? html + RELOAD_CLIENT : html.substring(0, close) + RELOAD_CLIENT + html.substring(close);
}

export type DevServer = {
  port: number;
  /** rebuild now (the watcher calls this; tests call it directly) */
  rebuild: () => BuildResult | Error;
  close: () => Promise<void>;
};

export type DevOptions = {
  port?: number;
  host?: string;
  /** false disables the fs watcher (tests drive `rebuild()` themselves) */
  watch?: boolean;
  log?: (line: string) => void;
};

/** Build, serve, watch. Resolves once the socket is listening and the first build is done. */
export async function startDevServer(config: ProjectConfig, opts: DevOptions = {}): Promise<DevServer> {
  const log = opts.log ?? console.log;
  const clients = new Set<ServerResponse>();
  let lastError: Error | null = null;

  const rebuild = (): BuildResult | Error => {
    try {
      const result = buildProject(config);
      lastError = null;
      return result;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      return lastError;
    }
  };

  const first = rebuild();
  if (first instanceof Error) log(`[dsx dev] build failed: ${first.message}`);
  else log(`[dsx dev] built ${first.components} components → ${first.outDir}`);

  const notify = (): void => {
    for (const client of clients) client.write("event: reload\ndata: 1\n\n");
  };

  const server = createServer((req, res) => {
    if ((req.url ?? "/").split("?")[0] === RELOAD_PATH) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 500\n\n");
      clients.add(res);
      req.on("close", () => { clients.delete(res); });
      return;
    }
    serveStatic(config.outDir, req, res, lastError);
  });

  const port = await listen(server, opts.port ?? 5273, opts.host);

  let watcher: FSWatcher | null = null;
  if (opts.watch !== false) {
    let timer: NodeJS.Timeout | null = null;
    const onChange = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        const result = rebuild();
        if (result instanceof Error) log(`[dsx dev] rebuild failed: ${result.message}`);
        else log(`[dsx dev] rebuilt ${result.components} components`);
        notify();
      }, 80);
      timer.unref?.();
    };
    watcher = watch(config.root, { recursive: true }, (_event, filename) => {
      if (filename === null) return onChange();
      const path = resolve(config.root, filename.toString());
      // never react to our own output, or the watcher rebuilds forever
      if (!relative(config.outDir, path).startsWith("..")) return;
      if (/\.(dsx|css|json|js|ts)$/.test(path)) onChange();
    });
  }

  return {
    port,
    rebuild,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      watcher?.close();
      for (const client of clients) client.end();
      clients.clear();
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      server.closeAllConnections();
    }),
  };
}

function listen(server: ReturnType<typeof createServer>, port: number, host?: string): Promise<number> {
  return new Promise((resolvePort) => {
    const done = (): void => {
      const address = server.address();
      resolvePort(typeof address === "object" && address !== null ? address.port : port);
    };
    if (host === undefined) server.listen(port, done);
    else server.listen(port, host, done);
  });
}

/** Serve one file out of the build output. Extensionless misses fall back to the SPA shell
 *  so client-routed deep links cold-load, exactly like the repo demo server. */
function serveStatic(outDir: string, req: IncomingMessage, res: ServerResponse, buildError: Error | null): void {
  if (buildError !== null) {
    res.writeHead(500, devHeaders(MIME[".html"]!));
    res.end(injectReloadClient(errorPage(buildError)));
    return;
  }
  let path = "/";
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith("/")) path += "index.html";
    const full = join(outDir, path);
    if (!full.startsWith(outDir)) { res.writeHead(403).end(); return; }
    if (existsSync(full) && statSync(full).isFile()) {
      const body = readFileSync(full);
      const type = MIME[extname(full)] ?? "application/octet-stream";
      if (type.startsWith("text/html")) {
        res.writeHead(200, devHeaders(type));
        res.end(injectReloadClient(body.toString("utf8")));
      } else {
        res.writeHead(200, devHeaders(type));
        res.end(body);
      }
      return;
    }
    if (extname(path) === "") {
      const nested = join(outDir, path, "index.html");
      if (existsSync(nested)) {
        res.writeHead(200, devHeaders(MIME[".html"]!));
        res.end(injectReloadClient(readFileSync(nested, "utf8")));
        return;
      }
      const shell = join(outDir, "index.html");
      if (existsSync(shell)) {
        res.writeHead(200, devHeaders(MIME[".html"]!));
        res.end(injectReloadClient(readFileSync(shell, "utf8")));
        return;
      }
    }
  } catch { /* fall through to 404 */ }
  res.writeHead(404, devHeaders("text/plain; charset=utf-8"));
  res.end("not found");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A build failure is shown, never hidden behind a stale page. */
export function errorPage(error: Error): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>dsx dev — build failed</title>
<style>body{font:14px/1.5 ui-monospace,monospace;margin:0;padding:2rem;background:#1b1b1f;color:#f7f7f8}
h1{font-size:1rem;color:#ff6b6b;margin:0 0 1rem}pre{white-space:pre-wrap;margin:0}</style></head>
<body><h1>dsx dev — build failed</h1><pre>${escapeHtml(error.message)}</pre></body></html>
`;
}

// ── repo demo mode ─────────────────────────────────────────────────────────────────────

/** `dsx dev --demo`: hand off to packages/compiler/bin/serve.ts. The specifier is computed at
 *  runtime on purpose — that file lives in the repository, never in an installed @despia/cli. */
export async function startDemoServer(from: string, port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const repo = findRepoRoot(from);
  if (repo === null) {
    throw new Error("--demo serves the repository demo, but no despia-framework checkout was found above " + from);
  }
  const entry = join(repo, "OpenSource/Web/packages/compiler/bin/serve.ts");
  if (!existsSync(entry)) throw new Error(`the repository dev server is missing: ${entry}`);
  const mod = await import(pathToFileURL(entry).href) as {
    startServer: (port: number) => Promise<{ port: number; close: () => Promise<void> }>;
  };
  return await mod.startServer(port);
}
