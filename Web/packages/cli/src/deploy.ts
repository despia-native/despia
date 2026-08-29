//
//  deploy.ts — the consumer half of the deploy emitter (plan E1).
//
//  `despia build` compiles a project's `<server>` documents into `server/generated/`. Until
//  this file existed it stopped there: the customer got a route table and no supported way to
//  run it, because the worker entry and the wrangler manifest were emitted only by a build
//  script that ships with the commercial layer. Both now come from ONE emitter in the open
//  drop (`@despia-native/server/deploy`), which the closed pipeline also calls — so what a customer
//  deploys and what the pipeline deploys are the same bytes for the same plan, by construction.
//
//  WHAT IS WRITTEN, AND WHERE. `deploy/` at the project root, which is already a reserved
//  GENERATED name (guides/reserved-directories.md): regenerated on every build, hand edits
//  overwritten by design. Nothing else in the project is touched.
//
//  THE SITE HALF. The manifest carries an `assets` binding pointing at the build output and
//  the worker imports the built registry, so ONE worker answers the app and its route table:
//  Workers Static Assets serves a request that matches an uploaded file, everything else falls
//  through to the worker, where the page handler renders declared routes and the host answers
//  the API. That ordering is the platform default when `main` and `assets` are both set, which
//  is why no routing overrides are emitted.
//

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { cloudflareDeploy, DeployPlanError, type CloudflareDeployPlan } from "@despia-native/server/deploy";

import type { ProjectConfig } from "./config.ts";
import type { ServerEmitResult } from "./server-document.ts";

export class DeployError extends Error {}

/**
 * The Workers runtime version this toolchain pins.
 *
 * A date read from the clock would make two builds of the same source differ, which the whole
 * emitter discipline exists to prevent, so it is a constant that moves when we move it — the
 * same pin the workspace target carries.
 */
export const COMPATIBILITY_DATE = "2025-08-01";

/**
 * The platform attachment half of the spend plane (cost-guardrails.md G6): a CPU ceiling per
 * invocation, far above anything a real handler needs (the request sandbox's wall clock is 10s
 * of AWAITED time; 5s of pure CPU is an interpreter runaway) and far below the platform's 30s
 * default, which is 6x the money on a hot loop.
 *
 * The same number prepare_server.rb writes. A customer's deployment and ours get the same
 * ceiling: this used to be set only on the monorepo path, so the guardrail a customer read
 * about in the docs was the one their own deploy did not carry.
 */
export const SPEND_CPU_MS = 5000;

/**
 * The Hyperdrive configuration id, from the environment the connected Cloudflare account sets.
 *
 * NOBODY IS ASKED TO UNDERSTAND HYPERDRIVE. When an id is present the emitted manifest carries
 * the binding and the Workers bootloader maps its connection string onto the database address —
 * pooling in front of the customer's Postgres, configured once by the connect flow. When it is
 * absent the worker reaches the database directly through the address secret, which is why this
 * is an absence rather than a failure: it is a performance attachment, never a requirement.
 */
export function hyperdriveId(env: (name: string) => string | undefined): string | null {
  const id = (env("DSX_CLOUDFLARE_HYPERDRIVE_ID") ?? "").trim();
  return id === "" ? null : id;
}

/** A deployable Worker name: alphanumerics and dashes, never underscores (Cloudflare's rule). */
export function workerName(config: ProjectConfig): string {
  const source = config.name.trim() === "" ? config.scheme : config.name;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  // A name made entirely of punctuation leaves nothing; naming it after the scheme beats
  // deploying a worker called "".
  return slug === "" ? "dsx-app" : slug;
}

/** A POSIX specifier from `from` to `to`, always explicitly relative. */
function specifier(from: string, to: string): string {
  const rel = relative(from, to).split("\\").join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * The plan the shared emitter renders. Exported so a test can assert the mapping without
 * writing anything, and so `despia deploy` can describe the deployment it is about to do.
 */
export function cloudflarePlan(config: ProjectConfig, server: ServerEmitResult): CloudflareDeployPlan {
  const workerDir = join(config.root, "deploy", "cloudflare", "worker");
  const configDir = join(config.root, "deploy", "cloudflare");
  const registry = join(config.outDir, "registry.json");
  return {
    shape: "project",
    generator: "`despia build`",
    secretsNote: "`despia deploy cloudflare` prints the `wrangler secret put` command for each one.",
    barrel: specifier(workerDir, join(config.root, "server", "generated", "index.ts")),
    // The site is bound only when the build actually produced one. An `assets.directory` that
    // does not exist fails `wrangler deploy` at the end of a deploy rather than here, and a
    // worker importing a registry that is not on disk does not bundle at all.
    siteRegistry: existsSync(registry) ? specifier(workerDir, registry) : null,
    mcpTools: server.tools > 0,
    wrangler: {
      name: workerName(config),
      main: "worker/index.ts",
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
      observability: true,
      cpu_ms: SPEND_CPU_MS,
      crons: server.crons,
      hyperdrive_id: hyperdriveId((name) => process.env[name]),
      assets: existsSync(config.outDir)
        ? { directory: specifier(configDir, config.outDir), binding: "ASSETS" }
        : null,
    },
  };
}

/**
 * Write `deploy/` for this project. Returns the project-relative paths, sorted.
 *
 * Write-on-change and prune-what-we-wrote, the same discipline every emitter in the tree
 * keeps: two builds of one source leave an identical tree, and a document that stops
 * declaring a backend does not leave a worker behind for someone to deploy.
 */
export function emitDeployArtifacts(config: ProjectConfig, server: ServerEmitResult | null): string[] {
  const cloudflareDir = join(config.root, "deploy", "cloudflare");
  if (server === null) {
    // Only ever remove what this emitter recognisably wrote.
    const manifest = join(cloudflareDir, "wrangler.jsonc");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes("GENERATED by `despia build`")) {
      rmSync(cloudflareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    return [];
  }
  let files: Record<string, string>;
  try {
    files = cloudflareDeploy(cloudflarePlan(config, server));
  } catch (e) {
    if (e instanceof DeployPlanError) throw new DeployError(`deploy/ cannot be emitted: ${e.message}`);
    throw e;
  }
  const written: string[] = [];
  for (const [rel, body] of Object.entries(files)) {
    const full = join(config.root, "deploy", rel);
    mkdirSync(dirname(full), { recursive: true });
    if (!existsSync(full) || readFileSync(full, "utf8") !== body) writeFileSync(full, body);
    written.push(`deploy/${rel}`);
  }
  return written.sort();
}
