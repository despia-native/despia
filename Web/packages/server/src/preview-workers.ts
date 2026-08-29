//
//  preview-workers.ts — the MULTI-TENANT preview face (v4-launch preview-hosting.md):
//  every `*.<apex>` preview app behind ONE worker, one object store, one pointer store.
//  10 apps and 500k apps are the same topology, because a tenant is DATA — the built
//  `registry.json` plus its static tree — never code.
//
//  THE CHAIN per request, mirroring site-node.ts / site-workers.ts exactly:
//    hostname → pointer → static object → page handler (live SSR from the registry).
//  A static hit is the cheapest and the most specific; the page handler answers dynamic
//  patterns, redirects and the declared notFound from the SAME `createPageHandler` every
//  other host uses — preview is not a reduced renderer, it is the renderer.
//
//  IMMUTABILITY IS ENFORCED AT THE DOOR, not promised by convention: a deployment
//  publishes under `apps/{app}/{deployment}/…` and the control plane refuses to write
//  into a prefix whose completion marker exists (409). Activation is a POINTER WRITE,
//  never an object write, and the pointer keeps `previous`, so rollback is a repoint —
//  the bytes never move and a deployment bug cannot destroy a live preview.
//
//  THE TRUST BOUNDARY. Uploaded apps run through the interpreter tier only: JSE bodies
//  inside the registry are parsed data, and the SSR path performs no dynamic codegen
//  (the compiled-JSE and JS-escalation tiers are not on this path, and the platform
//  refuses runtime code generation anyway). The control plane is admitted solely by the
//  preview admin key, compared constant-time, and an unauthenticated caller gets the
//  same 404 an unknown path gets — probing cannot distinguish "blocked" from "absent"
//  (the host.ts gateway precedent).
//
//  [S-BOUNDARY] Object keys are derived from wire paths. `resolveKeyWithin` below is the
//  key-space twin of site-node.ts `resolveWithin`: decode ONCE, reject NUL and any
//  `..`/absolute/drive segment before touching the store, then re-assert containment on
//  the joined key. Deliberately the same policy, not a second, different one.
//

import type { Registry } from "@despia/compiler/resolve";
import { createPageHandler, type PageHandlerOptions } from "./live.ts";
import { contentTypeFor } from "./content-type.ts";
import { secretEquals } from "./secrets.ts";

/** The object store, structurally (R2 in production) — this workspace carries no platform types. */
export interface PreviewObjectStore {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  head(key: string): Promise<unknown | null>;
}

/** The pointer store, structurally (KV in production). Pointers are the ONLY mutable plane. */
export interface PreviewPointerStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
}

/** What a hostname resolves to. `previous` makes rollback a repoint. */
export interface PreviewPointer {
  app: string;
  deployment: string;
  previous?: { app: string; deployment: string };
}

export interface PreviewOptions {
  bucket: PreviewObjectStore;
  pointers: PreviewPointerStore;
  /** the apex the tenant hostnames hang off (e.g. "despia.app"); a hostname that does not
   *  end in `.<apex>` is looked up whole, which is where custom domains attach later */
  apex: string;
  /** the control-plane admission secret; absent ⇒ the control plane answers 404 (fail closed) */
  adminKey?: string;
  /** decoded-bundle ceiling per publish (default 64 MiB — previews, not media libraries) */
  maxDeployBytes?: number;
  /** files per bundle ceiling (default 2000) */
  maxDeployFiles?: number;
  /** parsed-registry LRU size per isolate (default 64 tenants ≈ single-digit MB) */
  maxTenants?: number;
  /** page-handler options threaded through to SSR (dev diagnostics, streaming, …) */
  page?: PageHandlerOptions;
}

const DEFAULT_MAX_DEPLOY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DEPLOY_FILES = 2000;
const DEFAULT_MAX_TENANTS = 64;

/** control-plane admission header (the host.ts internal-key precedent, its own name so
 *  the two secrets can rotate independently) */
export const PREVIEW_KEY_HEADER = "x-dsx-preview-key";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const DEPLOYMENT = /^[a-z0-9](?:[a-z0-9._-]{2,63})$/;

const MARKER = ".complete";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** the probing-parity refusal: unauthenticated, unknown, and forbidden all read alike */
function notFound(): Response {
  return new Response("Not found.\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * [S-BOUNDARY] Resolve a URL pathname to an object key inside `prefix`, or null if it
 * escapes. Null, not a throw: a traversal attempt gets the same answer a missing object
 * gets.
 */
export function resolveKeyWithin(prefix: string, pathname: string): string | null {
  let decoded: string;
  try {
    // ONCE — a second decode is how %252e%252e becomes .. after these checks.
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const parts = decoded.replace(/\\/g, "/").split("/");
  const kept: string[] = [];
  for (const part of parts) {
    if (part === "..") return null;
    if (/^[A-Za-z]:$/.test(part)) return null;
    if (part === "" || part === ".") continue;
    kept.push(part);
  }
  const key = kept.length === 0 ? prefix : `${prefix}/${kept.join("/")}`;
  // THE CONTAINMENT CHECK — the backstop that must hold even if the parsing above is
  // wrong, same rationale as site-node.ts (do not delete as redundant).
  if (key !== prefix && !key.startsWith(`${prefix}/`)) return null;
  return key;
}

function deploymentPrefix(app: string, deployment: string): string {
  return `apps/${app}/${deployment}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** one uploaded file in a publish bundle */
interface BundleFile {
  path: string;
  b64: string;
  /** optional integrity pin; when present the store refuses a mismatch */
  sha256?: string;
}

/**
 * The preview face: one fetch-shaped handler for every tenant hostname plus the
 * control plane under `/-/`. Always answers (a worker owns its hostname), so unlike the
 * chainable site handlers this returns a Response, never null.
 */
export function createPreviewHandler(opts: PreviewOptions): (req: Request) => Promise<Response> {
  const { bucket, pointers, apex } = opts;
  const maxBytes = opts.maxDeployBytes ?? DEFAULT_MAX_DEPLOY_BYTES;
  const maxFiles = opts.maxDeployFiles ?? DEFAULT_MAX_DEPLOY_FILES;
  const maxTenants = opts.maxTenants ?? DEFAULT_MAX_TENANTS;
  const apexSuffix = `.${apex.toLowerCase()}`;

  // The per-isolate tenant cache: deployment prefix → the page handler built from its
  // registry (null = static-only deployment, cached too so a miss costs one GET, once).
  // Map preserves insertion order, which is all the LRU a preview tier needs.
  const tenants = new Map<string, Promise<((req: Request) => Promise<Response | null>) | null>>();

  function tenantHandler(prefix: string): Promise<((req: Request) => Promise<Response | null>) | null> {
    const cached = tenants.get(prefix);
    if (cached !== undefined) {
      // refresh recency: re-insert at the tail
      tenants.delete(prefix);
      tenants.set(prefix, cached);
      return cached;
    }
    const built = (async () => {
      const object = await bucket.get(`${prefix}/registry.json`);
      if (object === null) return null;
      const registry = JSON.parse(await new Response(object.body).text()) as Registry;
      return createPageHandler(registry, opts.page ?? {});
    })().catch((e: unknown) => {
      // a bad registry must not poison the cache forever — drop the entry, keep the reason
      tenants.delete(prefix);
      throw e;
    });
    tenants.set(prefix, built);
    if (tenants.size > maxTenants) {
      const oldest = tenants.keys().next().value as string | undefined;
      if (oldest !== undefined) tenants.delete(oldest);
    }
    return built;
  }

  async function readPointer(hostKey: string): Promise<PreviewPointer | null> {
    const raw = await pointers.get(`host:${hostKey}`);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as PreviewPointer;
      if (typeof parsed.app !== "string" || typeof parsed.deployment !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function markerExists(app: string, deployment: string): Promise<boolean> {
    return (await bucket.head(`${deploymentPrefix(app, deployment)}/${MARKER}`)) !== null;
  }

  // ── the control plane ────────────────────────────────────────────────────────────────

  async function publish(app: string, deployment: string, req: Request): Promise<Response> {
    if (!NAME.test(app)) return json(400, { reason: "invalid", detail: "app" });
    if (!DEPLOYMENT.test(deployment)) return json(400, { reason: "invalid", detail: "deployment" });
    if (await markerExists(app, deployment)) {
      // IMMUTABLE AT THE DOOR: a live deployment is never overwritten, ever.
      return json(409, { reason: "conflict", detail: "deployment exists" });
    }
    let bundle: { files?: BundleFile[] };
    try {
      bundle = (await req.json()) as { files?: BundleFile[] };
    } catch {
      return json(400, { reason: "invalid", detail: "body is not JSON" });
    }
    const files = bundle.files;
    if (!Array.isArray(files) || files.length === 0) return json(400, { reason: "invalid", detail: "files" });
    if (files.length > maxFiles) return json(413, { reason: "invalid", detail: "too many files" });

    const prefix = deploymentPrefix(app, deployment);
    let total = 0;
    const writes: { key: string; bytes: Uint8Array; type: string }[] = [];
    for (const file of files) {
      if (typeof file?.path !== "string" || typeof file?.b64 !== "string") {
        return json(400, { reason: "invalid", detail: "file row" });
      }
      const key = resolveKeyWithin(prefix, file.path);
      if (key === null || key === prefix || key.endsWith(`/${MARKER}`)) {
        return json(400, { reason: "invalid", detail: `path: ${file.path}` });
      }
      const bytes = decodeBase64(file.b64);
      if (bytes === null) return json(400, { reason: "invalid", detail: `base64: ${file.path}` });
      total += bytes.byteLength;
      if (total > maxBytes) return json(413, { reason: "invalid", detail: "bundle too large" });
      if (file.sha256 !== undefined && (await sha256Hex(bytes)) !== file.sha256.toLowerCase()) {
        return json(400, { reason: "invalid", detail: `integrity: ${file.path}` });
      }
      writes.push({ key, bytes, type: contentTypeFor(file.path) });
    }
    for (const w of writes) {
      await bucket.put(w.key, w.bytes.buffer.slice(w.bytes.byteOffset, w.bytes.byteOffset + w.bytes.byteLength) as ArrayBuffer, {
        httpMetadata: { contentType: w.type },
      });
    }
    // The marker is written LAST: a deployment either fully exists or does not exist —
    // activation refuses anything unmarked, so a torn upload can never go live.
    await bucket.put(`${prefix}/${MARKER}`, JSON.stringify({ files: writes.length, bytes: total }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return json(201, { app, deployment, files: writes.length, bytes: total });
  }

  async function activate(req: Request): Promise<Response> {
    let body: { host?: string; app?: string; deployment?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { reason: "invalid", detail: "body is not JSON" });
    }
    const host = (body.host ?? "").toLowerCase();
    const app = body.app ?? "";
    const deployment = body.deployment ?? "";
    if (!NAME.test(host)) return json(400, { reason: "invalid", detail: "host" });
    if (!NAME.test(app) || !DEPLOYMENT.test(deployment)) return json(400, { reason: "invalid", detail: "target" });
    if (!(await markerExists(app, deployment))) return json(404, { reason: "not_found", detail: "deployment" });
    const current = await readPointer(host);
    // Idempotent on replay: re-activating the current deployment must not write, or a
    // retried request would set `previous` to the deployment itself and destroy the
    // real rollback target.
    const pointer: PreviewPointer =
      current !== null && current.app === app && current.deployment === deployment
        ? current
        : {
            app,
            deployment,
            ...(current !== null ? { previous: { app: current.app, deployment: current.deployment } } : {}),
          };
    if (pointer !== current) await pointers.put(`host:${host}`, JSON.stringify(pointer));
    // The permalink twin: every activation is also reachable forever at
    // `{host}--{deployment-prefix}`, which is what makes old previews shareable.
    const permalink = `${host}--${deployment.slice(0, 8)}`;
    await pointers.put(`host:${permalink}`, JSON.stringify({ app, deployment }));
    return json(200, { host, pointer, permalink: `${permalink}${apexSuffix}` });
  }

  async function rollback(req: Request): Promise<Response> {
    let body: { host?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { reason: "invalid", detail: "body is not JSON" });
    }
    const host = (body.host ?? "").toLowerCase();
    if (!NAME.test(host)) return json(400, { reason: "invalid", detail: "host" });
    const current = await readPointer(host);
    if (current === null) return json(404, { reason: "not_found", detail: "host" });
    if (current.previous === undefined) return json(409, { reason: "conflict", detail: "no previous deployment" });
    // A repoint, never a re-upload: current and previous swap, so rollback is itself
    // rollback-able.
    const pointer: PreviewPointer = {
      app: current.previous.app,
      deployment: current.previous.deployment,
      previous: { app: current.app, deployment: current.deployment },
    };
    await pointers.put(`host:${host}`, JSON.stringify(pointer));
    return json(200, { host, pointer });
  }

  async function controlPlane(req: Request, pathname: string): Promise<Response> {
    // Fail closed: no admin key configured means the control plane does not exist.
    const presented = req.headers.get(PREVIEW_KEY_HEADER);
    if (opts.adminKey === undefined || opts.adminKey === "" || !secretEquals(presented, opts.adminKey)) {
      return notFound();
    }
    if (pathname === "/-/health") return json(200, { ok: true, service: "dsx-preview" });
    const publishMatch = /^\/-\/apps\/([^/]+)\/deployments\/([^/]+)$/.exec(pathname);
    if (publishMatch !== null && req.method === "PUT") {
      return publish(publishMatch[1], publishMatch[2], req);
    }
    if (pathname === "/-/activate" && req.method === "POST") return activate(req);
    if (pathname === "/-/rollback" && req.method === "POST") return rollback(req);
    const pointerMatch = /^\/-\/pointer\/([^/]+)$/.exec(pathname);
    if (pointerMatch !== null && req.method === "GET") {
      const pointer = await readPointer(pointerMatch[1].toLowerCase());
      return pointer === null ? json(404, { reason: "not_found" }) : json(200, pointer);
    }
    return notFound();
  }

  // ── the tenant plane ─────────────────────────────────────────────────────────────────

  async function serveObject(key: string, head: boolean): Promise<Response | null> {
    const object = await bucket.get(key);
    if (object === null) return null;
    const headers = new Headers({
      "content-type": object.httpMetadata?.contentType ?? contentTypeFor(key),
      // The URL does not carry the deployment id, so the browser may only cache briefly;
      // the deployment's own immutability lives at the store, not in this header.
      "cache-control": "public, max-age=60",
    });
    if (head) {
      if (object.body !== null) await object.body.cancel();
      return new Response(null, { status: 200, headers });
    }
    return new Response(object.body, { status: 200, headers });
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/-" || url.pathname.startsWith("/-/")) {
      return controlPlane(req, url.pathname);
    }

    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const head = method === "HEAD";

    const hostname = url.hostname.toLowerCase();
    const hostKey = hostname.endsWith(apexSuffix) ? hostname.slice(0, -apexSuffix.length) : hostname;
    const pointer = await readPointer(hostKey);
    if (pointer === null) return notFound();
    const prefix = deploymentPrefix(pointer.app, pointer.deployment);

    // static object first — a real file always wins (the site-node.ts chain)
    const key = resolveKeyWithin(prefix, url.pathname);
    if (key !== null) {
      if (!url.pathname.endsWith("/")) {
        const direct = await serveObject(key, head);
        if (direct !== null) return direct;
      }
      const index = await serveObject(key === prefix ? `${prefix}/index.html` : `${key}/index.html`, head);
      if (index !== null) return index;
    }

    // then the route table: dynamic patterns, redirects and notFound, live-SSR'd from
    // the SAME registry the client boots — preview renders what production renders
    let page: ((req: Request) => Promise<Response | null>) | null;
    try {
      page = await tenantHandler(prefix);
    } catch {
      return new Response("This preview failed to load.\n", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (page !== null) {
      const rendered = await page(req);
      if (rendered !== null) return rendered;
    }
    return notFound();
  };
}
