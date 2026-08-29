//
//  preview-local.ts — the preview worker on YOUR machine: the SAME createPreviewHandler
//  the deployed worker boots, behind node:http, with the platform bindings swapped for
//  a disk-backed object store and a JSON pointer file. Browsers resolve `*.localhost`
//  to the loopback, so tenant hostnames work locally with zero DNS:
//
//      npm run preview:local                       # apex "localhost", port 8788
//      npm run preview:publish -- --dir <outDir> --app hello
//      open http://hello.localhost:8788/
//
//  State lives under --store (default .dsx-preview/, gitignored): objects as files
//  under objects/, pointers in pointers.json — restart-safe, so published previews
//  survive the server. The admin key defaults to "local-dev-key" here and ONLY here;
//  the deployed worker fails closed without a real secret.
//
//  This file is a bootloader (node-shaped translation only); the behavior under test
//  is preview-workers.ts, byte-for-byte the code wrangler deploys.
//

import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  createPreviewHandler,
  type PreviewObjectStore,
  type PreviewPointerStore,
} from "../src/preview-workers.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const port = Number(arg("port", "8788"));
const apex = arg("apex", "localhost");
const storeDir = resolve(arg("store", ".dsx-preview"));
const adminKey = process.env["DSX_PREVIEW_ADMIN_KEY"] ?? "local-dev-key";

// ── the disk-backed bindings (object keys are already [S-BOUNDARY]-contained by the
//    handler; the encode below is belt for the local filesystem's own separators) ──────

function fileFor(key: string): string {
  return join(storeDir, "objects", key.split("/").map(encodeURIComponent).join("/"));
}

const bucket: PreviewObjectStore = {
  async get(key) {
    const path = fileFor(key);
    if (!existsSync(path)) return null;
    const bytes = readFileSync(path);
    const meta = fileFor(`${key}.__meta`);
    const contentType = existsSync(meta) ? readFileSync(meta, "utf8") : undefined;
    return {
      body: new Response(new Uint8Array(bytes)).body as ReadableStream<Uint8Array>,
      httpMetadata: { contentType },
    };
  },
  async put(key, value, opts) {
    const path = fileFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : Buffer.from(value));
    if (opts?.httpMetadata?.contentType !== undefined) {
      writeFileSync(fileFor(`${key}.__meta`), opts.httpMetadata.contentType);
    }
  },
  async head(key) {
    return existsSync(fileFor(key)) ? {} : null;
  },
};

const pointerFile = join(storeDir, "pointers.json");

function readPointers(): Record<string, string> {
  if (!existsSync(pointerFile)) return {};
  return JSON.parse(readFileSync(pointerFile, "utf8")) as Record<string, string>;
}

const pointers: PreviewPointerStore = {
  async get(key) {
    return readPointers()[key] ?? null;
  },
  async put(key, value) {
    const rows = readPointers();
    rows[key] = value;
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(pointerFile, JSON.stringify(rows, null, 1));
  },
};

// ── the node translation around the platform-free handler ───────────────────────────

const handle = createPreviewHandler({ bucket, pointers, apex, adminKey });

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const hostHeader = req.headers.host ?? `${apex}:${port}`;
  const request = new Request(`http://${hostHeader}${req.url ?? "/"}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v] as [string, string]] : (v ?? []).map((one) => [k, one] as [string, string]),
    ),
    ...(chunks.length > 0 ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}),
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => {
  console.log(`[preview-local] one worker, every tenant — http://<app>.${apex}:${port}/`);
  console.log(`[preview-local] control plane at http://${apex === "localhost" ? "127.0.0.1" : apex}:${port}/-/health`);
  console.log(`[preview-local] store: ${storeDir} · apex: ${apex} · admin key: ${adminKey === "local-dev-key" ? "local-dev-key (default)" : "from env"}`);
});
