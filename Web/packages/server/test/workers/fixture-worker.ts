//
//  fixture-worker.ts — the worker entry the server-workers lane bundles and boots under REAL
//  workerd (miniflare). Three faces, switched by test-only bindings so one bundle serves every
//  suite: the shared wire fixtures (the same table host.test.ts runs on node and the edge
//  section runs deno-shaped), a boot-refusing variant (DSX_TEST_DEMANDING=1) proving the 503
//  boot_failed message survives the real runtime, and a site-face variant (DSX_TEST_SITE=1)
//  chaining the platform's assets binding. POST /__api-corpus executes <api> corpus cases
//  INSIDE the isolate through the shared engine — the corpus itself stays on disk with the
//  node shell; only execution crosses into workerd.
//

import { createWorkersHandler, type WorkersEnv, type WorkersExecutionContext, type WorkersHandler } from "../../src/bootloader-workers.ts";
import type { ServerConfig } from "../../src/config.ts";
import { wireConfig } from "../wire-fixtures.ts";
import { corpusHandlers, type McpTransportCorpus } from "../mcp-transport-runner.ts";
import { runApiCorpusCase, type ApiCorpusCase } from "../../../kernel/test/api-corpus-engine.ts";

const demandingConfig: ServerConfig = {
  settings: {},
  env: {},
  required: [{ key: "database_url", env: "DSX_DATABASE_URL", friendlyName: "Database address", setting: "config.json → database_url" }],
};

/** Every page request misses, so the assets-then-API fall-through is what gets proven. */
const emptyRegistry = { components: {}, routes: [], schemes: [] } as never;

const wire = createWorkersHandler(wireConfig);
const refusing = createWorkersHandler(wireConfig, demandingConfig);
const site = createWorkersHandler(wireConfig, undefined, { siteRegistry: emptyRegistry });

//  The MCP variant binds its tool table from the DSX_TEST_MCP binding (the server-transport
//  corpus, passed in by the node shell) — tools bind at handler creation, so the variant is
//  built once per distinct corpus payload. This also re-exercises the per-env boot path.
const mcpVariants = new Map<string, WorkersHandler>();
function mcpVariant(payload: string): WorkersHandler {
  let handler = mcpVariants.get(payload);
  if (handler === undefined) {
    const corpus = JSON.parse(payload) as McpTransportCorpus;
    handler = createWorkersHandler(
      { routes: wireConfig.routes, handlers: { ...wireConfig.handlers, ...corpusHandlers(corpus) }, buildInfo: wireConfig.buildInfo ?? {} },
      undefined,
      { mcpTools: corpus.tools },
    );
    mcpVariants.set(payload, handler);
  }
  return handler;
}

export default {
  async fetch(request: Request, env: WorkersEnv, ctx: WorkersExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__api-corpus" && request.method === "POST") {
      const cases = (await request.json()) as ApiCorpusCase[];
      const results: { name: string; failures: string[] }[] = [];
      // Sequential on purpose: the engine swaps one shared fetch seam per case.
      for (const c of cases) results.push({ name: c.name, failures: await runApiCorpusCase(c) });
      return new Response(JSON.stringify(results), { headers: { "content-type": "application/json" } });
    }
    const face = typeof env["DSX_TEST_MCP"] === "string" ? mcpVariant(env["DSX_TEST_MCP"])
      : env["DSX_TEST_DEMANDING"] === "1" ? refusing
      : env["DSX_TEST_SITE"] === "1" ? site
      : wire;
    return face.fetch(request, env, ctx);
  },
};
