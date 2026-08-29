//
//  deploy-emit.ts — the Cloudflare deploy emitter, in the OPEN drop (E1).
//
//  WHY THIS FILE EXISTS. The `deploy/` artifacts a backend needs — the worker entry and the
//  wrangler manifest — used to be heredocs inside a build script a customer does not have. A
//  `<server>` document compiled by the shipped CLI therefore produced generated tables and no
//  supported way to run them: the product emitted a backend nobody could deploy. The emitter
//  is now ONE function in the open drop, and the closed pipeline is a CALLER of it rather than
//  a second implementation of it. Byte-identical output is not a hope, it is the shape.
//
//  TWO SHAPES, ONE RENDERER. The two trees genuinely differ — a workspace holds the aggregate
//  generated tables as separate modules beside the host source, a customer's project holds one
//  compiled barrel and resolves the runtime from its installed package — so the worker entry
//  is rendered per `shape`. Everything else (the manifest, the key order, the JSON spelling)
//  is shared, because it is data.
//
//  NOTHING IS IMPORTED HERE, deliberately: the emitter is pure string building over a plain
//  object, so the closed pipeline can run this file directly with `node` and no build step,
//  and the CLI can call the same function in-process. The only imports are node builtins,
//  reached by the command-line face below.
//
//  Cloudflare's schema for the site half (verified 2026-08-25 against
//  developers.cloudflare.com/workers/static-assets/binding/ and .../routing/single-page-application/):
//  `assets.directory` + `assets.binding` give the worker an `env.ASSETS` fetcher; with `main`
//  also set, an incoming request is answered from the uploaded directory when a file matches
//  and falls through to the worker otherwise. That default is exactly what a site-plus-API
//  worker wants, so `not_found_handling` and `run_worker_first` are deliberately NOT emitted —
//  a project that wants SPA rewriting or worker-first routing states it, and it stops being a
//  default nobody chose.
//

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The static-assets half of the manifest (Workers Static Assets). */
export interface CloudflareAssetsPlan {
  /** the built site, relative to the wrangler manifest */
  directory: string;
  /** the binding name the worker reads — `ASSETS` is what the runtime looks for */
  binding: string;
}

/** The manifest, as data. Key order below is the emitted key order. */
export interface CloudflareWranglerPlan {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  observability: boolean;
  /** the G6 spend-plane CPU ceiling per invocation (cost-guardrails.md) */
  cpu_ms?: number;
  /** scheduled triggers — queue drains, retention sweeps, declared route schedules */
  crons: string[];
  assets?: CloudflareAssetsPlan | null;
  hyperdrive_id?: string | null;
}

export interface CloudflareDeployPlan {
  /** `workspace` = the aggregate generated tables; `project` = a compiled `server/generated` barrel */
  shape: "workspace" | "project";
  /** who to blame in the generated header — the emitter never names its callers itself */
  generator: string;
  /** one sentence on where secrets go, so the manifest never has to imply it */
  secretsNote: string;
  wrangler: CloudflareWranglerPlan;
  /** project shape: the compiled `server/generated` barrel, as a specifier from the worker entry */
  barrel?: string;
  /** project shape: the built registry the worker serves the site from, relative to the entry */
  siteRegistry?: string | null;
  /** project shape: the barrel exports `mcpTools` only when the document declared `<tool>` rows */
  mcpTools?: boolean;
}

export class DeployPlanError extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function assertPlan(plan: CloudflareDeployPlan): void {
  if (plan.shape !== "workspace" && plan.shape !== "project") {
    throw new DeployPlanError(`unknown deploy shape ${JSON.stringify(plan.shape)}`);
  }
  const w = plan.wrangler;
  // A worker name Cloudflare refuses is a failure at the END of a deploy, after the bundle and
  // the secrets. Refusing it here costs nothing and names the rule.
  if (!NAME.test(w.name)) {
    throw new DeployPlanError(
      `worker name ${JSON.stringify(w.name)} is not deployable — alphanumerics and dashes only, no underscores.`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.compatibility_date)) {
    throw new DeployPlanError(`compatibility_date ${JSON.stringify(w.compatibility_date)} must be yyyy-mm-dd.`);
  }
  if (plan.shape === "project" && (plan.barrel === undefined || plan.barrel === "")) {
    throw new DeployPlanError("a project deploy plan must name its compiled server barrel (`barrel`).");
  }
}

/** The manifest. Pure data → one JSON spelling, so two callers cannot drift on whitespace. */
function wranglerJsonc(plan: CloudflareDeployPlan): string {
  const w = plan.wrangler;
  const doc: Record<string, unknown> = {
    name: w.name,
    main: w.main,
    compatibility_date: w.compatibility_date,
    compatibility_flags: w.compatibility_flags,
    observability: { enabled: w.observability },
    ...(typeof w.cpu_ms === "number" && w.cpu_ms > 0 ? { limits: { cpu_ms: w.cpu_ms } } : {}),
  };
  if (w.assets !== undefined && w.assets !== null) {
    doc["assets"] = { directory: w.assets.directory, binding: w.assets.binding };
  }
  if (w.crons.length > 0) doc["triggers"] = { crons: w.crons };
  if (w.hyperdrive_id !== undefined && w.hyperdrive_id !== null && w.hyperdrive_id !== "") {
    doc["hyperdrive"] = [{ binding: "HYPERDRIVE", id: w.hyperdrive_id }];
  }
  const site = w.assets === undefined || w.assets === null
    ? ""
    : "// The `assets` binding is the SITE half: the uploaded directory answers a request when a\n" +
      "// file matches, and everything else falls through to the worker — so one deploy serves the\n" +
      "// built app and its route table together.\n";
  return (
    `// GENERATED by ${plan.generator} — never hand-edit.\n` +
    "// The Workers deploy manifest: `wrangler deploy --config <this file>` publishes the\n" +
    "// backend; `--dry-run` validates it without an account (the CI gate). Secrets are\n" +
    `// NEVER here — ${plan.secretsNote}\n` +
    site +
    `${JSON.stringify(doc, null, 2)}\n`
  );
}

/** The workspace entry: the aggregate generated tables, beside the host source. */
function workspaceWorker(plan: CloudflareDeployPlan): string {
  return `//
//  GENERATED by ${plan.generator} — never hand-edit.
//
//  The Cloudflare Workers fat entry: ONE worker hosts the whole route table.
//  Boot is LAZY and per-env (Workers env is an argument, not a global): entities,
//  declared packages and the data backend install on the first event, and a boot
//  failure answers 503 {reason:"boot_failed"} instead of crashing the isolate —
//  all inside createWorkersHandler (src/bootloader-workers.ts). Postgres arrives
//  through the HYPERDRIVE binding or the DSX_DATABASE_URL secret; a built DSX
//  site rides an app-owned worker (siteRegistry + the ASSETS binding) — this
//  emitted worker is the BACKEND, the same scope as the Supabase fat function.

import { createWorkersHandler } from "../../../src/bootloader-workers.ts";
import { routes } from "../../../generated/routes.ts";
import { buildInfo } from "../../../generated/build-info.ts";
import { handlers } from "../../../generated/handlers.ts";
import { serverConfig } from "../../../generated/config.ts";
import { backendSetting, dataProviders } from "../../../generated/providers.ts";
import { packageModules } from "../../../generated/packages.ts";
import { entities } from "../../../generated/entities.ts";
import { mcpTools } from "../../../generated/mcp-tools.ts";

export default createWorkersHandler(
  {
    routes: routes as unknown as import("../../../src/host.ts").ServerRoute[],
    handlers: handlers as never,
    buildInfo,
  },
  serverConfig as unknown as import("../../../src/config.ts").ServerConfig,
  {
    entities: entities as unknown as import("../../../src/repo.ts").EntitySpec[],
    packageModules,
    backendSetting,
    dataProviders,
    mcpTools: mcpTools as unknown as import("../../../src/mcp-face.ts").McpToolRow[],
  },
);
`;
}

/** A customer's entry: the compiled `server/generated` barrel plus the installed runtime. */
function projectWorker(plan: CloudflareDeployPlan): string {
  const site = plan.siteRegistry !== undefined && plan.siteRegistry !== null && plan.siteRegistry !== "";
  // spendBudgets ALWAYS: the barrel and this entry are emitted by the same CLI version, the
  // barrel always exports the merged plane (guarded defaults with zero declarations), and a
  // project deployment that shipped without its ceilings would break the cost-guardrails
  // promise on exactly the path a customer takes (the workspace shape gets the same table
  // via serverConfig.settings.spend_budgets, which the project shape does not carry).
  const names = ["entities", "handlers", "routes", "spendBudgets"];
  if (plan.mcpTools === true) names.push("mcpTools");
  const imports = [
    `import { createWorkersHandler } from "@despia/server/bootloader-workers";`,
    `import { ${names.join(", ")} } from ${JSON.stringify(plan.barrel)};`,
  ];
  if (site) imports.push(`import siteRegistry from ${JSON.stringify(plan.siteRegistry)};`);
  const options = ["    entities,"];
  if (plan.mcpTools === true) options.push("    mcpTools,");
  if (site) {
    options.push("    //  The built site, served in FRONT of the route table: a request with a matching");
    options.push("    //  uploaded file never reaches here at all, a page route is rendered from this");
    options.push("    //  registry, and anything else falls through to the routes above.");
    options.push("    siteRegistry: siteRegistry as never,");
  }
  return `//
//  GENERATED by ${plan.generator} — never hand-edit (reserved-directories.md).
//
//  The Cloudflare Workers entry for this project's backend. ONE worker hosts the whole
//  route table compiled from \`server/*.dsx\`. Boot is LAZY and per-env (the Workers env
//  is an argument, not a global): the schema table installs on the first event, and a
//  boot failure answers 503 {reason:"boot_failed"} instead of crashing the isolate —
//  all inside createWorkersHandler.
//
//  Deploy it with \`despia deploy cloudflare\`, which prints the plan before it runs it.

${imports.join("\n")}

export default createWorkersHandler(
  {
    routes,
    handlers: handlers as never,
    //  The spend plane (cost-guardrails.md): the merged ceilings the build emitted. With no
    //  serverConfig on this shape, this is the ONLY way the guarded defaults reach the host.
    spend: spendBudgets,
  },
  undefined,
  {
${options.join("\n")}
  },
);
`;
}

/**
 * The `deploy/cloudflare/` artifacts for one plan: relative path → exact bytes.
 *
 * Returning bytes rather than writing them is what lets the closed pipeline keep its own
 * write-on-change discipline (and its idempotence gate) while owning none of the content.
 */
export function cloudflareDeploy(plan: CloudflareDeployPlan): Record<string, string> {
  assertPlan(plan);
  return {
    "cloudflare/worker/index.ts": plan.shape === "workspace" ? workspaceWorker(plan) : projectWorker(plan),
    "cloudflare/wrangler.jsonc": wranglerJsonc(plan),
  };
}

/**
 * The command-line face, so a non-JavaScript caller can reach the same function:
 *
 *   node deploy-emit.ts --plan plan.json            → {path: contents} on stdout
 *   node deploy-emit.ts --plan plan.json --out dir  → written under dir, one path per line
 *
 * This is how `prepare_server.rb` emits `deploy/cloudflare/` without owning a byte of it.
 */
function main(argv: string[]): number {
  let planPath = "";
  let out = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--plan") { planPath = argv[i + 1] ?? ""; i += 1; continue; }
    if (argv[i] === "--out") { out = argv[i + 1] ?? ""; i += 1; continue; }
    process.stderr.write(`deploy-emit: unknown argument ${JSON.stringify(argv[i])}\n`);
    return 2;
  }
  if (planPath === "") {
    process.stderr.write("deploy-emit: --plan <file.json> is required\n");
    return 2;
  }
  let files: Record<string, string>;
  try {
    files = cloudflareDeploy(JSON.parse(readFileSync(planPath, "utf8")) as CloudflareDeployPlan);
  } catch (e) {
    process.stderr.write(`deploy-emit: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (out === "") {
    process.stdout.write(JSON.stringify(files));
    return 0;
  }
  for (const [rel, body] of Object.entries(files)) {
    const full = join(out, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
    process.stdout.write(`${rel}\n`);
  }
  return 0;
}

// Run only when this module IS the program — importing it must never emit anything.
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = main(process.argv.slice(2));
}
