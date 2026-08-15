//
//  bootloader-deno.ts - the Supabase-edge-shaped entry (full-stack.md T1): ONE fat
//  function hosts the whole route table under /functions/v1/dsx/*. The emitted wrapper
//  (supabase/functions/dsx/index.ts) imports the generated config and runs
//  `Deno.serve(createEdgeHandler(config))` — everything else is the shared host.
//  This file never names the Deno global (the workspace tsc carries no Deno types);
//  platform env is reached through globalThis, so it also runs under plain Node.
//  Identity (T2) resolves here at the boundary — one resolver per handler, one JWT
//  verification per request, handed to the host as ctx.identity; no auth env = null.
//

import { createHost, DEFAULT_MAX_BODY_BYTES, type HostConfig } from "./host.ts";
import { createIdentityResolver } from "./identity.ts";
import { INTERNAL_KEY_ENV, assertConfigured, configuredEnv, hostOptions, NO_CONFIG, type ServerConfig } from "./config.ts";

// The mounts the platform serves the function under, stripped before dispatch so routes
// stay platform-free (/health, never /functions/v1/dsx/health). Longest first. Shared by
// BOTH bootloaders (bootloader-node imports it), so the same spelling works everywhere:
// curl localhost:8787/dsx/health ≡ localhost:8787/health ≡ the deployed edge path.
const MOUNT_PREFIXES = ["/functions/v1/dsx", "/dsx"];

/**
 * WHO AN ANONYMOUS CALLER IS, for the rate limiter, on a platform edge.
 *
 * `x-forwarded-for` is caller-controlled in general, and reading it unconditionally would be
 * worse than not limiting: a limiter keyed on a spoofable header is bypassed by varying it, and
 * can be aimed at another caller's budget by sending theirs. It is trustworthy here for one
 * specific reason — the platform's own edge terminates the connection and REWRITES the header
 * before the isolate sees it, so the value is the platform's, not the sender's.
 *
 * The LEFTMOST entry is the client; anything after it is a proxy chain the platform appended.
 * `null` when absent, which buckets the caller with every other anonymous one (host.ts explains
 * what that costs).
 */
export function edgeClientAddress(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded === null || forwarded === "") return null;
  const first = forwarded.split(",")[0]!.trim();
  return first === "" ? null : first;
}

export function stripMountPrefix(pathname: string): string {
  for (const prefix of MOUNT_PREFIXES) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length);
  }
  return pathname;
}

/**
 * Read a request body, refusing past `cap` — returns null when the cap is exceeded.
 *
 * Counts ACTUAL bytes rather than trusting Content-Length, which a client controls and may
 * understate. Cancels the stream on refusal so the sender stops rather than continuing to push
 * into a reader nobody is draining.
 */
async function readCapped(req: Request, cap: number): Promise<ArrayBuffer | null> {
  if (req.body === null) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out.buffer;
}

function platformEnv(key: string): string | undefined {
  const g = globalThis as {
    Deno?: { env?: { get?(key: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key];
}

/**
 * Boot the data backend for an edge function (plan B5) — the platform-free twin of
 * generated-loader's `installConfiguredDataProvider` (that one is Node-only: it loads artifacts
 * from disk; an edge bundle imports them statically, so the emitted wrapper hands them in).
 * Called at module top level, BEFORE Deno.serve — a cold start either has its transport or
 * fails visibly in the platform log, never per-request.
 */
export async function installDataBackend(
  serverConfig: ServerConfig,
  backendSetting: string | null,
  dataProviders: { backend: string; install(env: (key: string) => string | undefined): Promise<{ installed: boolean; backend: string }> }[],
): Promise<{ installed: boolean; backend: string } | null> {
  if (backendSetting === null) return null;
  const chosen = serverConfig.settings[backendSetting];
  const provider = dataProviders.find((p) => p.backend === chosen);
  if (provider === undefined) return null;
  return provider.install(configuredEnv(serverConfig, platformEnv));
}

/**
 * Build the edge request handler. No config = an empty table (every request → unknown_route).
 *
 * `serverConfig` is the emitted settings table (generated/config.ts). It is checked HERE, at
 * module load, so a function missing a required setting fails visibly in the platform log
 * instead of deploying successfully and then refusing every caller with a bare 401 (plan B4).
 */
export function createEdgeHandler(
  config: HostConfig = { routes: [], handlers: {} },
  serverConfig: ServerConfig = NO_CONFIG,
): (req: Request) => Promise<Response> {
  assertConfigured(serverConfig, platformEnv);
  const env = configuredEnv(serverConfig, platformEnv); // platform env wins, declared value is the default
  // The DECLARED options win. Spreading `config` last let a caller-supplied `serviceRoles` or
  // `maxBodyBytes` silently override the declaration — the exact silent-override that
  // config.ts throws to prevent, and the opposite of what bootloader-node does. Not reachable
  // through the emitted wrapper (it passes only routes/handlers/buildInfo), but a security
  // boundary should not depend on a caller's restraint.
  // internalKey comes from the ENV reader, not the declaration: it is a secret, so
  // prepare_server.rb emits only the fact that it exists and the variable that carries it.
  const host = createHost({
    ...config,
    ...hostOptions(serverConfig),
    internalKey: env(INTERNAL_KEY_ENV),
    clientAddress: edgeClientAddress,
  });
  const resolveIdentity = createIdentityResolver(env); // built once — the JWKS cache warms across requests
  return async (req: Request): Promise<Response> => {
    const identity = await resolveIdentity(req); // from the ORIGINAL request — the mount strip never touches headers
    const url = new URL(req.url);
    const stripped = stripMountPrefix(url.pathname);
    let request = req;
    if (stripped !== url.pathname) {
      // rebuild the request at the stripped path (query preserved); the body is buffered —
      // an ArrayBuffer body needs no duplex option on any platform
      const target = new URL(stripped + url.search, url.origin);
      // CAP BEFORE BUFFERING. This branch is taken on EVERY Supabase request (the mount prefix
      // /functions/v1/dsx is always present), and `await req.arrayBuffer()` buffers whatever the
      // client sends — so the host's declared max_body_bytes never saw it. A single
      // unauthenticated request could drive the isolate's memory to gigabytes before the router
      // rejected the route. Content-Length is a claim, so it is used to refuse early and the
      // actual bytes are still counted.
      const cap = hostOptions(serverConfig).maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > cap) {
        return new Response(JSON.stringify({ reason: "bad_request", message: `request body exceeds ${cap} bytes` }), {
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readCapped(req, cap);
      if (body === null) {
        return new Response(JSON.stringify({ reason: "bad_request", message: `request body exceeds ${cap} bytes` }), {
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      request = new Request(target, {
        method: req.method,
        headers: req.headers,
        body: body !== undefined && body.byteLength > 0 ? body : undefined,
      });
    }
    return host.handle(request, { identity, env });
  };
}
