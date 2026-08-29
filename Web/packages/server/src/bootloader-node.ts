//
//  bootloader-node.ts - the custom/docker HTTP loop (full-stack.md T1): a node:http
//  server translating IncomingMessage → web Request, handing it to the shared host, and
//  writing the Response back. Hosts are bootloaders — everything here is translation;
//  the behavior lives in host.ts + the generated handlers (loaded lazily at serve time).
//  Identity (T2) resolves here at the boundary: one resolver per boot, one JWT
//  verification per request, handed to the host as ctx.identity; no auth env = null.
//

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHost, DEFAULT_MAX_BODY_BYTES } from "./host.ts";
import { stripMountPrefix } from "./bootloader-deno.ts";
import { createIdentityResolver } from "./identity.ts";
import { installConfiguredDataProvider, loadGenerated } from "./generated-loader.ts";
import { INTERNAL_KEY_ENV, assertConfigured, configuredEnv, eventRetentionHours, hostOptions } from "./config.ts";
import { createMcpFace } from "./mcp-face.ts";
import { createSiteHandler } from "./site-node.ts";
import { sweepEvents, sweepRateCounters } from "./postgres.ts";
import { flushSpendIfDue } from "./spend.ts";

const DEFAULT_PORT = 8787;

/** Load a built site's registry and bind the A1 handler. Throws (failing the boot) when the
 *  directory has no readable `registry.json` — a site that cannot resolve components would
 *  otherwise answer every page request with an opaque 500. */
async function createSiteFromDir(dir: string): Promise<(req: Request) => Promise<Response | null>> {
  const { readFile } = await import("node:fs/promises");
  const path = resolve(dir, "registry.json");
  let registry;
  try {
    registry = JSON.parse(await readFile(path, "utf8")) as Parameters<typeof createSiteHandler>[1];
  } catch (e: unknown) {
    throw new Error(
      `[dsx.server] site directory ${dir} has no readable registry.json (${path}) — ` +
      `it must be the output of \`dsx build\` / build-demo. Original: ${String(e)}`,
    );
  }
  return createSiteHandler(dir, registry, { stream: false });
}

function platformEnv(key: string): string | undefined {
  return process.env[key];
}

/**
 * The peer address of the connection a Request arrived on.
 *
 * A WeakMap rather than a field on the Request because Request is a web type this file does not
 * own, and weak keys mean an entry disappears with the request that owns it — a Map here would be
 * a leak that grows with every connection the process ever accepts.
 */
const peerAddresses = new WeakMap<Request, string>();

function toWebRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(key, one);
    else headers.set(key, value);
  }
  const method = (req.method ?? "GET").toUpperCase();
  // same mount policy as the edge bootloader — /dsx/health and /health both dispatch
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  const pathname = q === -1 ? raw : raw.slice(0, q);
  const search = q === -1 ? "" : raw.slice(q);
  const url = `http://${req.headers.host ?? "localhost"}${stripMountPrefix(pathname)}${search}`;
  const init: RequestInit = { method, headers };
  // re-wrap: BodyInit wants an ArrayBuffer-backed view, Buffer is typed over ArrayBufferLike
  if (body.length > 0 && method !== "GET" && method !== "HEAD") init.body = new Uint8Array(body);
  const request = new Request(url, init);
  const peer = req.socket.remoteAddress;
  if (peer !== undefined && peer !== "") peerAddresses.set(request, peer);
  return request;
}

async function writeWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
  res.end(Buffer.from(await webRes.arrayBuffer()));
}

export async function serve(
  opts: {
    port?: number;
    /** relocated artifacts (docker mounts, tests) */
    generatedDir?: string;
    /** Embedded/test hosts may install a real local data engine while keeping the production
     *  HTTP bootloader, generated tables, identity boundary and handlers unchanged. */
    installDataProvider?: (env: (key: string) => string | undefined) => Promise<{ installed: boolean; backend: string } | null>;
    /** A1 — a built DSX site directory to serve in FRONT of the API host (static assets + SSR
     *  pages). OPT-IN and absent by default, so every existing API-only deployment keeps its
     *  exact behaviour; env `DSX_SITE_DIR` sets it for the emitted Docker/serve entry. */
    site?: string;
  } = {},
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const generated = await loadGenerated(opts.generatedDir);
  // BEFORE the port opens (plan B4): a server missing a required setting must not come up
  // looking healthy and then refuse every caller with a bare 401. This throws, naming the
  // setting, why it is required, and the variable that carries it.
  assertConfigured(generated.config, platformEnv);
  const env = configuredEnv(generated.config, platformEnv); // platform env wins, declared value is the default
  // The DATA BACKEND boots before the port opens (plan B5): a tree whose configuration chose a
  // backend gets its transport installed NOW — after assertConfigured, so a missing
  // DSX_DATABASE_URL was already refused above with the field named. `GET /notes` serves rows
  // from the first request; it never 500s while the server claims health.
  const data = opts.installDataProvider !== undefined
    ? await opts.installDataProvider(env)
    : await installConfiguredDataProvider(generated, env);
  const host = createHost({
    routes: generated.routes,
    handlers: generated.handlers,
    buildInfo: generated.buildInfo,
    ...hostOptions(generated.config),
    // A secret, so it arrives through the env reader rather than the declaration — the emitter
    // records only that it is required and which variable carries it.
    internalKey: env(INTERNAL_KEY_ENV),
    // The SOCKET address, stamped per connection below. Node has no forwarded header worth
    // trusting by default — anything in front of this process is a deployment fact the process
    // cannot see — so the peer address is the only value here that a caller cannot choose.
    clientAddress: (request) => peerAddresses.get(request) ?? null,
  });
  const resolveIdentity = createIdentityResolver(env); // built once per boot — T2 identity at the boundary
  // A1: the SITE face, in front of the API host. Its registry is read ONCE here — a malformed
  // one must fail the boot, not the Nth request, which is the same rule assertSafeRouteTable
  // already applies to the route table it validates at handler-creation time.
  const siteDir = opts.site ?? platformEnv("DSX_SITE_DIR");
  const site = siteDir === undefined || siteDir === "" ? null : await createSiteFromDir(siteDir);
  // The MCP face (W3): declared tools served at /mcp, same identity boundary, same handlers.
  const mcp = generated.mcpTools.length > 0
    ? createMcpFace({ tools: generated.mcpTools, handlers: generated.handlers, buildInfo: generated.buildInfo })
    : null;
  // THE CAP MUST LIVE HERE, not only in the host.
  //
  // `host.ts` enforces `maxBodyBytes` against the stream — but this bootloader used to buffer
  // the ENTIRE body before calling it, so the host's cap never saw a byte of it. Measured: an
  // unauthenticated `POST /health` (a GET-only route!) declaring 512 MiB drove a server process
  // from 98 MiB to 2198 MiB RSS and was then answered 405. Node Buffers are external memory, so
  // --max-old-space-size does not bound it: the container OOMs instead of throwing.
  //
  // Refusing at the transport also refuses EARLIER than the host could — before routing, before
  // identity — which is the right place for a limit whose whole purpose is to stop work.
  const maxBody = hostOptions(generated.config).maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > maxBody) {
          // Answer FIRST, then hang up. Destroying the request before the response is flushed
          // tears down the socket underneath it, and the client sees a dropped connection (or a
          // bare 100 Continue) instead of the refusal — memory is protected either way, but a
          // caller that cannot read WHY is exactly the silent failure this codebase bans.
          res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({ reason: "bad_request", message: `request body exceeds ${maxBody} bytes` }),
            () => req.destroy(), // now stop the sender; the response is on the wire
          );
          return;
        }
        chunks.push(buf);
      }
      const webReq = toWebRequest(req, Buffer.concat(chunks));
      // A1 chain: the site answers static assets and pages; it returns null for everything it
      // does not own (non-GET/HEAD, no file, no matching route), and the API host — which always
      // returns a Response and so can never signal "not mine" — stays last.
      if (site !== null) {
        const served = await site(webReq);
        if (served !== null) {
          await writeWebResponse(served, res);
          return;
        }
      }
      const identity = await resolveIdentity(webReq);
      if (mcp !== null) {
        const served = await mcp(webReq, { identity, env });
        if (served !== null) {
          // A face-served answer bypasses host.handle's flush hook, and the MCP face charges
          // the spend plane — flush here so a tool-driven trip's event and counters land
          // without waiting for the next API request. The retention interval remains the
          // quiet-tail backstop.
          void flushSpendIfDue(env)?.catch(reportSweepFailure);
          await writeWebResponse(served, res);
          return;
        }
      }
      const webRes = await host.handle(webReq, { identity, env });
      await writeWebResponse(webRes, res);
    })().catch((e: unknown) => {
      // Transport-level failure only — the host answers its own. Same wire shape as host.ts:
      // the status is the envelope, the body is {reason, message}.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // NOT e.message to the CLIENT. This is the same rule host.ts enforces for handler
      // exceptions — the text carries stack frames, SQL and sometimes secrets. It was leaking
      // here because the transport path was written as "transport-level only" and never held
      // to it. But sanitizing the client's copy is only half of host.ts's pattern: it also
      // reports the real error to the operator and hands back a correlation id to join the
      // two. Without that half this path is silent on BOTH sides — a JWKS fetch that starts
      // throwing turns every request into an opaque 500 with nothing in the log and no id to
      // grep, which is precisely "a caller that cannot read WHY" (the rule stated above at the
      // 413, in this same file).
      const correlationId = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
        ?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      // eslint-disable-next-line no-console -- the transport failure sink, mirroring host.ts's default
      console.error(`[dsx.server] transport failed (${correlationId}):`, e);
      res.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "x-dsx-correlation-id": correlationId,
      });
      res.end(JSON.stringify({ reason: "handler_failed", message: "internal error" }));
    });
  });
  const envPort = process.env.PORT;
  const requested = opts.port ?? (envPort !== undefined && envPort !== "" ? Number(envPort) : DEFAULT_PORT);
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(requested, () => {
      server.removeListener("error", failed);
      listening();
    });
  });
  //  RETENTION, on the target that has no pg_cron.
  //
  //  The Supabase deploy schedules these as two `cron.schedule` rows (queue.sql). A self-hosted
  //  or containerised deployment has no such scheduler, and the two tables that grow on the hot
  //  path — the budget counter, one row per caller-window, and the event feed, one per published
  //  change — would grow without bound. Each one's own index is then what makes the insert it has
  //  to keep fast into the slow thing, so the limiter becomes the outage and the subscription feed
  //  degrades exactly as adoption grows. The timer is `unref`'d: retention must never be the
  //  reason a process refuses to exit.
  const retention = setInterval(() => {
    void sweepRateCounters().catch(reportSweepFailure);
    void sweepEvents(eventRetentionHours(generated.config)).catch(reportSweepFailure);
    // The spend plane's idle flush: a server whose traffic just stopped still lands its last
    // local counters (and any waiting transition) without waiting for the next request. On the
    // request path the flush already rides handle(); this is only the quiet-tail case.
    void flushSpendIfDue(env)?.catch(reportSweepFailure);
  }, RETENTION_INTERVAL_MS);
  retention.unref();

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : requested; // port 0 = OS-assigned
  console.log(`[dsx.server] listening on http://localhost:${port} — ${generated.routes.length} route(s)${data === null ? "" : ` · data: ${data.installed ? data.backend : `${data.backend} NOT installed`}`}`);
  return {
    server,
    port,
    close: () => new Promise<void>((done, failed) => {
      clearInterval(retention);
      server.close((e) => (e !== undefined ? failed(e) : done()));
    }),
  };
}

/** Often enough that a busy deployment never accumulates a day of expired windows, rarely enough
 *  that it is invisible against request traffic. */
const RETENTION_INTERVAL_MS = 10 * 60 * 1000;

function reportSweepFailure(e: unknown): void {
  // Retention failing is not a reason to take the process down, and it is not a reason to stay
  // quiet either: it is the only warning before the table it prunes becomes the bottleneck.
  // eslint-disable-next-line no-console -- the same sink the transport failures use
  console.error(`[dsx.server] retention sweep failed: ${e instanceof Error ? e.message : String(e)}`);
}

// direct execution (`node src/bootloader-node.ts` — the Dockerfile entry) boots immediately
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
