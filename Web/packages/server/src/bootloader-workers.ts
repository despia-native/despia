//
//  bootloader-workers.ts — the Cloudflare Workers module shape (v0-live-plan W1): ONE
//  exported handler hosts the whole route table plus the site face. The emitted wrapper
//  (deploy/cloudflare/worker/index.ts) imports the generated artifacts and does
//  `export default createWorkersHandler(...)` — everything else is the shared host.
//  Hosts are bootloaders: everything here is translation; the behavior lives in host.ts
//  and the platform-free page handler.
//
//  WHAT IS DIFFERENT ON THIS PLATFORM, and how each difference is held at this boundary:
//
//    • ENV IS AN ARGUMENT, NOT A GLOBAL. Workers hands `env` to every fetch/scheduled
//      invocation; nothing exists at module scope. So boot is LAZY — first event boots,
//      keyed on the env object itself (a WeakMap: production reuses one env per isolate;
//      tests handing different envs get honestly separate boots). The config seam already
//      models env as a function, so the host never learns the difference.
//    • POSTGRES ARRIVES AS A BINDING. Hyperdrive exposes `env.HYPERDRIVE.connectionString`;
//      `workersEnv` maps it onto DSX_DATABASE_URL (an explicit variable still wins), and the
//      existing driver-free provider path does the rest. Any Postgres behind Hyperdrive
//      works, Supabase included — no vendor line anywhere below this file.
//    • THE SITE IS A BINDING TOO. Workers Static Assets serves the built output through
//      `env.ASSETS`; site-workers.ts chains it in front of the shared page handler.
//    • CRON IS A PLATFORM TRIGGER. The `scheduled` export drives the same internal
//      service-role dispatch the pg_cron rows perform on Supabase (queue drains, retention
//      sweeps, declared `schedule` rows) — the wire is identical: an internal request
//      carrying X-DSX-Internal-Key into the same host, same allowlist, same budgets.
//
//  A BOOT FAILURE MUST ARRIVE AS A MESSAGE, not as an isolate crash: the failure is caught,
//  cached, and answered as 503 {reason: "boot_failed"} — the same honesty the Supabase
//  entry provides, adapted to a platform where boot happens on the first event.
//

import { createHost, DEFAULT_MAX_BODY_BYTES, type HostConfig } from "./host.ts";
import { createIdentityResolver } from "./identity.ts";
import { readCapped, stripMountPrefix } from "./bootloader-deno.ts";
import {
  INTERNAL_KEY_ENV,
  NO_CONFIG,
  assertConfigured,
  configuredEnv,
  eventRetentionHours,
  hostOptions,
  type ServerConfig,
} from "./config.ts";
import { installEntities, type EntitySpec } from "./repo.ts";
import { installPackages, type PackageModule } from "./packages.ts";
import { sweepEvents, sweepRateCounters } from "./postgres.ts";
import { flushSpendIfDue, flushSpendNow } from "./spend.ts";
import { createMcpFace, type McpToolRow } from "./mcp-face.ts";
import { createWorkersSiteHandler, type WorkersAssetsBinding, type WorkersSiteOptions } from "./site-workers.ts";
import type { Registry } from "@despia/compiler/resolve";

//  The platform shapes, structurally — this workspace carries no @cloudflare/workers-types,
//  the same rule that keeps bootloader-deno from naming the Deno global.

/** The env object Workers passes to every invocation: vars, secrets and bindings by name. */
export type WorkersEnv = Record<string, unknown>;

export interface WorkersScheduledController {
  cron: string;
  scheduledTime: number;
}

export interface WorkersExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkersHandler {
  fetch(request: Request, env: WorkersEnv, ctx: WorkersExecutionContext): Promise<Response>;
  scheduled(controller: WorkersScheduledController, env: WorkersEnv, ctx: WorkersExecutionContext): void;
}

/** The Hyperdrive binding name the deploy emitter writes (wrangler.jsonc `hyperdrive`). */
const HYPERDRIVE_BINDING = "HYPERDRIVE";
/** The assets binding name the deploy emitter writes (wrangler.jsonc `assets.binding`). */
const ASSETS_BINDING = "ASSETS";

//  The cron expressions the scheduled dispatcher recognises for the two platform jobs. The
//  deploy emitter (prepare_server.rb → deploy/cloudflare/wrangler.jsonc) writes these same
//  strings as triggers — they pair with queue.sql's pg_cron rows ('* * * * *' drains,
//  '*/10 * * * *' sweeps) so the two platforms keep one cadence story.
export const WORKERS_QUEUE_CRON = "* * * * *";
export const WORKERS_RETENTION_CRON = "*/10 * * * *";

/**
 * The env reader over a Workers env object: string vars and secrets read as-is, and the
 * Hyperdrive binding answers for DSX_DATABASE_URL when no explicit variable does. EXPLICIT
 * ALWAYS WINS — the same precedence the Supabase wrapper gives its platform defaults — so an
 * operator can point at a different database without touching the binding.
 */
export function workersEnv(env: WorkersEnv): (key: string) => string | undefined {
  return (key: string): string | undefined => {
    const own = env[key];
    if (typeof own === "string" && own !== "") return own;
    if (key === "DSX_DATABASE_URL") {
      const hyperdrive = env[HYPERDRIVE_BINDING];
      if (typeof hyperdrive === "object" && hyperdrive !== null) {
        const url = (hyperdrive as { connectionString?: unknown }).connectionString;
        if (typeof url === "string" && url !== "") return url;
      }
    }
    return undefined;
  };
}

/**
 * WHO AN ANONYMOUS CALLER IS, for the rate limiter, on this platform: `CF-Connecting-IP`,
 * which Cloudflare's own edge sets on every request after terminating the connection — the
 * same one-specific-reason trust the Supabase edge grants x-forwarded-for (bootloader-deno
 * explains what a caller-controlled header would cost).
 */
export function workersClientAddress(req: Request): string | null {
  const address = req.headers.get("cf-connecting-ip");
  return address === null || address === "" ? null : address;
}

/** What a platform wrapper hands in besides the host config (the artifacts a bundle imports statically). */
export interface WorkersHandlerOptions {
  /** the declared schema table — installed at boot like the Supabase entry does */
  entities?: EntitySpec[];
  /** declared packages (Core/Server/Modules/Import) — bound at boot so a moved export refuses the cold start */
  packageModules?: PackageModule[];
  /** the config key whose value picks the data backend (generated/providers.ts) */
  backendSetting?: string | null;
  /** enabled provider residences, keyed by backend scheme */
  dataProviders?: { backend: string; install(env: (key: string) => string | undefined): Promise<{ installed: boolean; backend: string }> }[];
  /** the built site's registry — presence turns on the site face in front of the API host */
  siteRegistry?: Registry;
  siteOptions?: WorkersSiteOptions;
  /** declared MCP tools (generated/mcp-tools.ts) — presence turns on the /mcp face (W3) */
  mcpTools?: McpToolRow[];
}

interface BootState {
  host: ReturnType<typeof createHost>;
  resolveIdentity: ReturnType<typeof createIdentityResolver>;
  env: (key: string) => string | undefined;
  site: ((req: Request) => Promise<Response | null>) | null;
  mcp: ReturnType<typeof createMcpFace> | null;
  maxBody: number;
}

type BootOutcome = { ok: true; state: BootState } | { ok: false; detail: string };

function bootFailure(detail: string): Response {
  return new Response(JSON.stringify({ reason: "boot_failed", message: detail }, null, 1), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Build the Workers handler. No config = an empty table (every request → unknown_route),
 * the same default createEdgeHandler gives.
 */
export function createWorkersHandler(
  config: HostConfig = { routes: [], handlers: {} },
  serverConfig: ServerConfig = NO_CONFIG,
  options: WorkersHandlerOptions = {},
): WorkersHandler {
  //  One boot per env OBJECT. A WeakMap rather than a module let-binding for the same reason
  //  bootloader-node keys peer addresses this way: the env belongs to the platform, an entry
  //  disappears with the env that owns it, and two different envs (miniflare tests, preview
  //  sessions) can never read each other's transports half-installed.
  const boots = new WeakMap<WorkersEnv, Promise<BootOutcome>>();

  function bootFor(env: WorkersEnv): Promise<BootOutcome> {
    const cached = boots.get(env);
    if (cached !== undefined) return cached;
    const booting = (async (): Promise<BootOutcome> => {
      //  EVERY boot step is inside the guard (the Supabase entry states why): a rejection here
      //  must become a message on every response, never an isolate with no handler.
      try {
        assertConfigured(serverConfig, workersEnv(env));
        const envFn = configuredEnv(serverConfig, workersEnv(env)); // platform env wins, declared value is the default
        if (options.entities !== undefined) installEntities(options.entities);
        if (options.packageModules !== undefined) installPackages(options.packageModules);
        //  The data backend boots with the isolate, not with a request (plan B5) — the
        //  platform-free selection generated-loader performs, done here against THIS env.
        const backendSetting = options.backendSetting ?? null;
        if (backendSetting !== null) {
          const chosen = serverConfig.settings[backendSetting];
          const provider = (options.dataProviders ?? []).find((p) => p.backend === chosen);
          if (provider !== undefined) await provider.install(envFn);
        }
        const host = createHost({
          ...config,
          ...hostOptions(serverConfig),
          internalKey: envFn(INTERNAL_KEY_ENV),
          clientAddress: workersClientAddress,
        });
        const resolveIdentity = createIdentityResolver(envFn); // built once — the JWKS cache warms across requests
        const assets = env[ASSETS_BINDING];
        const site = options.siteRegistry === undefined
          ? null
          : createWorkersSiteHandler(
              typeof assets === "object" && assets !== null && typeof (assets as WorkersAssetsBinding).fetch === "function"
                ? (assets as WorkersAssetsBinding)
                : null,
              options.siteRegistry,
              options.siteOptions ?? {},
            );
        const mcp = options.mcpTools !== undefined && options.mcpTools.length > 0
          ? createMcpFace({ tools: options.mcpTools, handlers: config.handlers, buildInfo: config.buildInfo ?? {} })
          : null;
        const maxBody = hostOptions(serverConfig).maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        return { ok: true, state: { host, resolveIdentity, env: envFn, site, mcp, maxBody } };
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error(`[dsx.server] BOOT FAILED\n${detail}`);
        return { ok: false, detail };
      }
    })();
    boots.set(env, booting);
    return booting;
  }

  async function handleFetch(req: Request, env: WorkersEnv, ctx: WorkersExecutionContext): Promise<Response> {
    const boot = await bootFor(env);
    if (!boot.ok) return bootFailure(boot.detail);
    const state = boot.state;
    // Post-response work (the spend plane's write-behind flush) must ride waitUntil on this
    // platform — the isolate is free to die the moment the response is returned, and a floating
    // promise dies with it. The host's `background` seam exists for exactly this hand-off.
    const background = (p: Promise<unknown>): void => ctx.waitUntil(p);
    const identity = await state.resolveIdentity(req); // from the ORIGINAL request — the mount strip never touches headers
    const url = new URL(req.url);
    const stripped = stripMountPrefix(url.pathname);
    let request = req;
    if (stripped !== url.pathname) {
      //  Same rebuild-with-cap discipline as the edge bootloader, for the same reason: the
      //  rebuilt request buffers the body, so the cap must be enforced before the buffer.
      const target = new URL(stripped + url.search, url.origin);
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > state.maxBody) {
        return new Response(JSON.stringify({ reason: "bad_request", message: `request body exceeds ${state.maxBody} bytes` }), {
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readCapped(req, state.maxBody);
      if (body === null) {
        return new Response(JSON.stringify({ reason: "bad_request", message: `request body exceeds ${state.maxBody} bytes` }), {
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
    //  The chain: the MCP face owns exactly /mcp; the site answers static assets and pages;
    //  each returns null for everything it does not own, and the API host — which can never
    //  signal "not mine" — stays last. The finally covers the FACE-served answers: the MCP
    //  face charges the spend plane and host.handle's own flush hook never runs for it, and
    //  on this platform a floating promise dies with the isolate — waitUntil or it is lost.
    try {
      if (state.mcp !== null) {
        const served = await state.mcp(request, { identity, env: state.env });
        if (served !== null) return served;
      }
      if (state.site !== null) {
        const served = await state.site(request);
        if (served !== null) return served;
      }
      return await state.host.handle(request, { identity, env: state.env, background });
    } finally {
      const flush = flushSpendIfDue(state.env);
      if (flush !== null) background(flush);
    }
  }

  /**
   * The platform-cron tick, dispatching exactly what queue.sql's pg_cron rows dispatch:
   *   · WORKERS_QUEUE_CRON      → every `worker` (queue-drain) row
   *   · WORKERS_RETENTION_CRON  → the budget-counter and event-feed sweeps
   *   · a row's own `schedule`  → that row
   * Each dispatch is an internal request into the same host, carrying X-DSX-Internal-Key —
   * the same credential, allowlist and budgets a pg_cron drain presents. A failed row is
   * collected and thrown at the end so the invocation shows red in the platform dashboard;
   * one bad row must not stop the others from draining.
   */
  async function runScheduled(cron: string, env: WorkersEnv): Promise<void> {
    const boot = await bootFor(env);
    if (!boot.ok) throw new Error(`[dsx.server] scheduled tick refused — boot failed: ${boot.detail}`);
    const state = boot.state;
    const failures: string[] = [];

    const due = config.routes.filter(
      (route) => (route.worker !== undefined && cron === WORKERS_QUEUE_CRON) || route.schedule === cron,
    );
    if (due.length > 0) {
      const key = state.env(INTERNAL_KEY_ENV);
      if (key === undefined || key === "") {
        //  The queue.sql header names this exact failure on Supabase: without the internal
        //  key the drain is a 404 and the queue never empties, silently. Refuse loudly instead.
        throw new Error(
          `[dsx.server] scheduled tick has ${due.length} due route(s) but ${INTERNAL_KEY_ENV} is unset — ` +
          `internal dispatch is impossible. Set the secret (dsx_deploy delivers it) and redeploy.`,
        );
      }
      for (const route of due) {
        const request = new Request(`https://dsx.internal${route.path}`, {
          method: route.method.toUpperCase(),
          headers: { "x-dsx-internal-key": key },
        });
        const res = await state.host.handle(request, { identity: null, env: state.env });
        if (!res.ok) {
          failures.push(`${route.method.toUpperCase()} ${route.path} → ${res.status} ${await res.text()}`);
        }
      }
    }
    if (cron === WORKERS_RETENTION_CRON) {
      //  Retention on the platform's tick — this target has no pg_cron and no resident
      //  process for bootloader-node's interval. Both sweeps are no-ops without an installed
      //  Postgres transport, so a tree on another backend pays nothing here.
      try {
        await sweepRateCounters();
        await sweepEvents(eventRetentionHours(serverConfig));
      } catch (e) {
        failures.push(`retention sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The scheduled tick is the one entry with no response to ride behind, so the spend flush is
    // awaited here — counters from drained work land before the invocation ends, and a trip's
    // event/doorbell never waits for the next external request.
    await flushSpendNow(state.env);
    if (failures.length > 0) {
      throw new Error(`[dsx.server] scheduled tick (${cron}) had ${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
    }
  }

  return {
    fetch: (request, env, ctx) => handleFetch(request, env, ctx),
    scheduled: (controller, env, ctx) => {
      ctx.waitUntil(runScheduled(controller.cron, env));
    },
  };
}
