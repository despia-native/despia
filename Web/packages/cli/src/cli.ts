//
//  cli.ts — the host for `dsx.cli.dsx`. `runCli` returns an exit code and never calls
//  process.exit, so every command is drivable from a test.
//
//  THE COMMAND TABLE IS NOT IN THIS FILE. It is `src/dsx.cli.dsx`, a `<cli>` document read at
//  startup: the commands, their flags, the usage text and — for `doctor` — the implementation
//  all come from there. A command therefore cannot exist in the help and not in the parser, or
//  accept a flag the help never mentions; both are structural bugs in a hand-written table,
//  because the table is written twice. Here it is written once.
//
//  Despia's own toolchain running on Despia's own authoring surface is the point: the CLI node
//  is not a demo, it is what ships `dsx`.
//

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDeclaredCommand } from "./declared.ts";
import { readCliDocument, usage, type CliDocument } from "./document.ts";
import { DispatchError, dispatch } from "./dispatch.ts";

import { buildDemo, buildProject, findRepoRoot, BuildError } from "./build.ts";
import { buildClaims, signClaims } from "./entitlement.ts";
import { CONFIG_FILENAME, componentFiles, findProjectRoot, loadConfig, packageRoots, ConfigError, type ProjectConfig } from "./config.ts";
import { PREVIEW_PATH, startDemoServer, startDevServer } from "./dev.ts";
import { ADMISSION_QUERY_NAME, EditError, startEditServer } from "./edit.ts";
import { commandShot } from "./shot-command.ts";
import { commandFilm } from "./film-command.ts";
import { ExportError, exportAndroid, exportIos, readExportProject } from "./export.ts";
import {
  connectWithPg, databaseUrl, projectQueues, provision, ProvisionError, renderReport, writeReceipt,
  type ClientFactory,
} from "./provision.ts";
import { OtaError, otaBuild, otaCopyTo, otaPublishPlan, otaRollback } from "./ota.ts";
import { commandAdd, commandList, commandRemove, commandSearch } from "./registry-commands.ts";
import { commandApp, commandSubmit } from "./studio-apps/app-command.ts";
import { commandReport } from "./report.ts";
import { ENTITLEMENT_FILENAME, exportGate, type Entitlement } from "./licence.ts";
import { serveMcp, toolsFromDocument } from "./mcp.ts";
import { RegistryError } from "./registry.ts";
import { ResolveError } from "./registry-resolve.ts";
import { commandReview } from "./review.ts";
import {
  foldPackage, foldPackageTree, formatFinding, lintSource, readAttributeCensus, readStyleEjects, schemeForDir, tally,
  type Finding, type LintContext,
} from "./lint.ts";

/** The ONE version. package.json is the truth (RELEASING.md: every package starts at
 *  0.0.1 and moves by the release law); this constant and the `<cli version=…>` document
 *  attribute must match it - the tether test in cli.test.ts fails the build when any of
 *  the three drift, so `dsx --version` can never report a version npm does not know. */
export const VERSION = "0.0.1";

/**
 * The command surface, read from the document rather than restated here. Resolved next to
 * this module so it works identically from `src/` in the workspace and from `dist/src/` in a
 * published install — the build copies the .dsx alongside the compiled output for exactly
 * that reason.
 */
export const CLI_DOCUMENT: CliDocument = readCliDocument(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dsx.cli.dsx"), "utf8"),
  "dsx.cli.dsx",
);

export const VERSION_FROM_DOCUMENT = CLI_DOCUMENT.version;

/** DERIVED, not authored. Every command and flag below came from the document above. */
export const USAGE = usage(CLI_DOCUMENT);

export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
};

const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

export type Flags = { [name: string]: string | boolean };
type Args = { command: string | undefined; flags: Flags; positional: string[]; repeated: { [name: string]: string[] } };

export function parseArgs(argv: readonly string[]): Args {
  const flags: Flags = {};
  const repeated: { [name: string]: string[] } = {};
  const positional: string[] = [];
  let command: string | undefined;
  const take = (name: string, value: string): void => {
    flags[name] = value;
    (repeated[name] ??= []).push(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.substring(2) : arg.substring(2, eq);
      if (eq >= 0) { take(name, arg.substring(eq + 1)); continue; }
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) { take(name, next); i += 1; }
      else flags[name] = true;
      continue;
    }
    if (command === undefined) command = arg;
    else positional.push(arg);
  }
  return { command, flags, positional, repeated };
}

/** DERIVED from the document: exactly the flags declared `type="string"`, which are exactly
 *  the ones that consume the next token. Restating this by hand is how `--strict app.dsx`
 *  comes to swallow its own positional. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(
  CLI_DOCUMENT.commands.flatMap((c) => c.flags.filter((f) => f.type === "string").map((f) => f.name)),
);

/** Run one CLI invocation. Returns the process exit code. */
export async function runCli(argv: readonly string[], io: Io = consoleIo): Promise<number> {
  const { command, flags, positional, repeated } = parseArgs(argv);
  if (flags["version"] === true) { io.out(VERSION); return 0; }
  if (command === undefined || command === "help" || flags["help"] === true) {
    io.out(USAGE);
    return command === undefined && flags["help"] !== true ? 1 : 0;
  }
  const declared = CLI_DOCUMENT.commands.find((c) => c.name === command);
  if (declared === undefined) {
    io.err(`despia: unknown command '${command}'`);
    io.out(USAGE);
    return 1;
  }
  try {
    // A command implemented in markup runs on the runner, with only the seams the document
    // declared. Nothing about it is special-cased here — the document said `action=`, so the
    // body is the implementation.
    if (declared.action !== undefined) return await runDeclared(declared.action, argv, io);

    switch (declared.handler) {
      case "build": return await commandBuild(flags, io);
      case "dev": return await commandDev(flags, io);
      case "edit": return await commandEdit(flags, io);
      case "shot": return await commandShot(flags, positional, io);
      case "film": return await commandFilm(flags, positional, io);
      case "export": return commandExport(flags, positional, io);
      case "lint": return commandLint(flags, positional, repeated["package"] ?? [], io);
      case "review": return commandReview(flags, positional, io);
      case "provision": return await commandProvision(flags, io);
      case "ota": return await commandOta(flags, positional, io);
      case "licence": return await commandLicence(flags, positional, io);
      case "mcp": return await commandMcp(flags, io);
      case "report": return commandReport(flags, positional, io);
      case "search": return await commandSearch(flags, positional, io);
      case "add": return await commandAdd(flags, positional, io);
      case "remove": return commandRemove(flags, positional, io);
      case "list": return commandList(flags, positional, io);
      case "app": return await commandApp(flags, positional, io);
      case "submit": return commandSubmit(flags, positional, io);
      default:
        // The document declared a handler this host does not implement. That is a defect in
        // the pair, and saying so beats pretending the command does not exist.
        io.err(`despia: '${command}' declares handler "${declared.handler}", which this build does not provide`);
        return 70;
    }
  } catch (e) {
    if (e instanceof BuildError || e instanceof ConfigError || e instanceof OtaError || e instanceof EditError || e instanceof ExportError || e instanceof ProvisionError || e instanceof RegistryError || e instanceof ResolveError) { io.err(`despia ${command}: ${e.message}`); return 1; }
    io.err(`despia ${command}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/**
 * Run a markup-authored command. argv is re-parsed through the DECLARED shape rather than the
 * loose parser above, so a boolean flag never eats its neighbour and an unknown flag is
 * refused instead of ignored.
 *
 * The declared `<root>`s anchor at the project directory, so `--project` chooses where the
 * body may look and the body itself cannot reach outside it. That is the whole filesystem
 * story: the host picks the anchor, the document picks the roots, and traversal out of one is
 * refused by the seam.
 */
async function runDeclared(actionName: string, argv: readonly string[], io: Io): Promise<number> {
  let invocation;
  try {
    invocation = dispatch(CLI_DOCUMENT, argv);
  } catch (e) {
    if (!(e instanceof DispatchError)) throw e;
    io.err(`despia: ${e.message}`);
    io.out(USAGE);
    return 2;
  }
  const action = CLI_DOCUMENT.actions.get(actionName)!;
  const asked = invocation.inputs["project"];
  const cwd = typeof asked === "string" && asked.length > 0 ? resolve(process.cwd(), asked) : process.cwd();
  const result = await runDeclaredCommand(CLI_DOCUMENT, action, invocation.inputs, { cwd, io });
  if (result.reason !== undefined) io.err(`despia ${invocation.command.name}: ${result.message ?? result.reason}`);
  return result.code;
}

/** Resolve the project the command acts on, or explain precisely why there is none. */
export function requireProject(flags: { [name: string]: string | boolean }, cwd = process.cwd()): ProjectConfig {
  const explicit = typeof flags["project"] === "string" ? resolve(cwd, flags["project"]) : null;
  const root = explicit ?? findProjectRoot(cwd);
  if (root === null) {
    const inRepo = findRepoRoot(cwd) !== null;
    throw new ConfigError(
      `no ${CONFIG_FILENAME} found in ${cwd} or any parent` +
      (inRepo ? " — inside this repository, use --demo to act on the bundled demo, or --project <dir>." : "") +
      " Scaffold one with `npm create despia`.",
    );
  }
  const config = loadConfig(root);
  if (typeof flags["out"] === "string") return { ...config, outDir: resolve(root, flags["out"]) };
  return config;
}

async function commandBuild(flags: { [name: string]: string | boolean }, io: Io): Promise<number> {
  if (flags["demo"] === true) {
    buildDemo(process.cwd(), io.out);
    return 0;
  }
  const config = requireProject(flags);
  const result = buildProject(config);
  io.out(`[despia build] ${config.name} (${config.scheme}) — ${result.components} components`);
  if (result.server !== null) {
    io.out(`[despia build] <server> documents: ${result.server.documents.join(", ")} — ${result.server.routes} route(s), ${result.server.entities} entity(ies), ${result.server.spend.ceilings} spend ceiling(s) → server/generated/`);
    // The loud opt-out (cost-guardrails.md): an unbounded seam is a word the build repeats,
    // never an absence — quiet here would let a five-figure invoice arrive unannounced.
    for (const seam of result.server.spend.unbounded) {
      io.out(`[despia build] budget ${seam} is UNBOUNDED — no ceiling stands between a runaway loop and the platform bill on that seam.`);
    }
  }
  io.out(`[despia build] ${result.written.length} files → ${relative(config.root, result.outDir) || result.outDir}`);
  return 0;
}

/**
 * `despia provision` — Despia's own tables inside the customer's database.
 *
 * The connection factory is a parameter so the whole command is drivable against a real engine
 * in a test; production resolves `pg` from the project. Reporting is the default and the report
 * is written whether or not anything changed, because "nothing needed doing" is a receipt too.
 */
export async function commandProvision(
  flags: { [name: string]: string | boolean },
  io: Io,
  connect: ClientFactory = connectWithPg,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  const config = requireProject(flags);
  const apply = flags["apply"] === true;
  const queues = projectQueues(config);
  const { client, close } = await connect(databaseUrl((name) => process.env[name]));
  let report;
  try {
    report = await provision(client, queues, { apply });
  } finally {
    await close();
  }
  for (const line of renderReport(report)) io.out(line);
  const receipt = writeReceipt(config, report, now());
  io.out(`[despia provision] recorded in ${receipt}`);
  // A deployment that cannot meter or publish events is not a working deployment, so a database
  // that is not ready is a non-zero exit — the deploy above reads this, and so does CI.
  return report.ready ? 0 : 1;
}

async function commandDev(flags: { [name: string]: string | boolean }, io: Io): Promise<number> {
  const port = typeof flags["port"] === "string" ? parseInt(flags["port"], 10) : undefined;
  if (flags["demo"] === true) {
    const server = await startDemoServer(process.cwd(), port ?? 8787);
    io.out(`[despia dev] repository demo at http://localhost:${server.port}/demo/site/`);
    return await never();
  }
  const config = requireProject(flags);
  const server = await startDevServer(config, {
    ...(port !== undefined ? { port } : {}),
    ...(typeof flags["host"] === "string" ? { host: flags["host"] } : {}),
    log: io.out,
  });
  io.out(`[despia dev] ${config.name} at http://localhost:${server.port}/`);
  io.out(`[despia dev] framed preview at http://localhost:${server.port}${PREVIEW_PATH}  (device sizes + scheme toggle)`);
  return await never();
}

/** `despia dev` runs until the process is signalled; the promise never settles by design. */
function never(): Promise<number> {
  return new Promise<number>(() => { /* held open by the listening socket */ });
}

async function commandEdit(flags: Flags, io: Io): Promise<number> {
  const config = requireProject(flags);
  const port = typeof flags["port"] === "string" ? parseInt(flags["port"], 10) : undefined;
  //  The admission credential (plan E1, defect D3). Chosen explicitly by flag or environment,
  //  otherwise minted for this run — and a non-loopback bind without an explicit one is
  //  refused inside startEditServer rather than served. It is a door key for a local tool, not
  //  an identity: see the note over the mount's gate.
  const chosen = typeof flags["token"] === "string" && flags["token"] !== ""
    ? flags["token"]
    : process.env["DESPIA_EDIT_TOKEN"] ?? "";
  const server = await startEditServer(config, {
    ...(port !== undefined ? { port } : {}),
    // loopback by default: the editor writes files; exposing that beyond the machine is an
    // explicit --host decision, never a default.
    host: typeof flags["host"] === "string" ? flags["host"] : "127.0.0.1",
    ...(chosen === "" ? {} : { token: chosen }),
    log: io.out,
  });
  const url = `http://localhost:${server.port}/edit/?${ADMISSION_QUERY_NAME}=${encodeURIComponent(server.admission)}`;
  io.out(`[despia edit] ${config.name} — editor at ${url}  (app at http://localhost:${server.port}/)`);
  io.out("[despia edit] that URL carries this run's admission credential. It is printed once, it is not an");
  io.out("[despia edit] account, and it dies with this process. Agents: send it as the x-despia-edit header.");
  return await never();
}

/** `despia export ios|android|all` — real native projects from the project's own modules. */
function commandExport(flags: Flags, positional: string[], io: Io): number {
  const platform = positional[0];
  if (platform !== "ios" && platform !== "android" && platform !== "all") {
    throw new ExportError(`unknown platform ${JSON.stringify(platform ?? "")} — despia export ios | android | all`);
  }
  const config = requireProject(flags);
  const project = readExportProject(config);
  requireExportLicence(config, project, platform, typeof flags["bundle-id"] === "string" ? flags["bundle-id"] : undefined, io);
  const opts = {
    ...(typeof flags["kernel"] === "string" ? { kernel: flags["kernel"] } : {}),
    ...(typeof flags["bundle-id"] === "string" ? { bundleId: flags["bundle-id"] } : {}),
  };
  const withCounts = `${project.modules.length} module(s), ${project.components.length + project.modules.reduce((n, m) => n + m.components.length, 0)} component(s)`;
  if (platform === "ios" || platform === "all") {
    const out = exportIos(project, { ...opts, ...(platform === "ios" && typeof flags["out"] === "string" ? { out: flags["out"] } : {}) });
    io.out(`[despia export] ios — ${withCounts} → ${relative(process.cwd(), out) || out}`);
  }
  if (platform === "android" || platform === "all") {
    const out = exportAndroid(project, { ...opts, ...(platform === "android" && typeof flags["out"] === "string" ? { out: flags["out"] } : {}) });
    io.out(`[despia export] android — ${withCounts} → ${relative(process.cwd(), out) || out}`);
  }
  io.out("[despia export] build output — regenerate after changes, never hand-edit (reserved-directories.md)");
  return 0;
}

/**
 * The export licence gate (00-plan.md D5). An open-only project exports freely; a project
 * bundling premium modules needs an entitlement for this app id, because the export would
 * otherwise carry premium source onto a machine that has not paid for it.
 *
 * The check here is existence and identity only. The CRYPTOGRAPHIC check is the runtime's job,
 * in the licence module, because that is the copy an attacker cannot edit without infringing —
 * a CLI runs on the user's machine, so treating it as the enforcement point would be theatre.
 */
function requireExportLicence(
  config: ProjectConfig, project: ReturnType<typeof readExportProject>,
  platform: string, bundleId: string | undefined, io: Io,
): void {
  const premium = project.modules.filter((m) => m.shelf === "premium").map((m) => m.scheme || m.name);
  if (premium.length === 0) return;

  const path = join(config.root, ENTITLEMENT_FILENAME);
  let entitlement: Entitlement | null = null;
  if (existsSync(path)) {
    try {
      entitlement = JSON.parse(readFileSync(path, "utf8")) as Entitlement;
    } catch (e) {
      throw new ExportError(`${ENTITLEMENT_FILENAME} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // `all` gates on iOS: the exports are separate licences, and refusing the pair on the first
  // failure is clearer than exporting one platform and stopping halfway through the second.
  const target = platform === "all" ? "ios" : platform;
  const result = exportGate({
    platform: target,
    // The identifier the exported app actually builds under, matching export.ts's default.
    appId: bundleId ?? `com.example.${config.scheme}`,
    majorVersion: MAJOR_VERSION,
    premium,
    entitlement,
  });
  if (!result.allowed) throw new ExportError(result.message);
  if (result.note !== undefined) io.out(`[despia export] ${result.note}`);
}

/** The runtime major this CLI exports for. A licence is perpetual WITHIN a major (00-plan.md
 *  D3), so this number is what an entitlement must match. */
export const MAJOR_VERSION = 4;

/**
 * `despia mcp` — the toolchain as an MCP server. The tool list is DERIVED from this same
 * document, so an agent sees exactly the commands a terminal does (mcp.ts explains why that
 * matters more than it sounds).
 */
async function commandMcp(flags: Flags, io: Io): Promise<number> {
  if (flags["list"] === true) {
    for (const tool of toolsFromDocument()) {
      const args = Object.keys(tool.inputSchema.properties);
      io.out(`${tool.name}${args.length > 0 ? `  (${args.join(", ")})` : ""}`);
      io.out(`    ${tool.description}`);
    }
    return 0;
  }
  // stdout is the JSON-RPC channel from here on, so nothing may print to it.
  return await serveMcp();
}

/** The OTA verbs (v0-live-plan W5): the publishing half of the content plane, over ota.ts. */
/**
 * `despia licence sign` — mint the entitlements a purchase already recorded.
 *
 * THE KEY LIVES HERE, NOT ON THE SERVER. An entitlement verifies offline, forever, in every
 * shipped app, so a leaked signing key mints licences for every app and every version with no
 * revocation anyone can reach — strictly worse than a leaked database. The platform therefore
 * records the CLAIMS at purchase and publishes them on an internal, service-role route; this
 * signs them wherever the operator keeps the key and hands the signature back.
 *
 * It verifies its OWN output before posting. A signer that emits a file no device accepts is the
 * exact failure this chain exists to prevent, and it is silent: the customer downloads a licence,
 * ships it, and sees the watermark anyway.
 */
async function commandLicence(flags: Flags, positional: string[], io: Io): Promise<number> {
  const verb = positional[0] ?? "";
  if (verb !== "sign") {
    io.err(`despia licence: unknown verb ${verb === "" ? "(none)" : `"${verb}"`} — the only verb is \`sign\``);
    return 2;
  }
  const text = (name: string, fallback: string): string => {
    const value = flags[name];
    return typeof value === "string" && value !== "" ? value : fallback;
  };
  const api = text("api", process.env["DESPIA_API"] ?? "").replace(/\/+$/, "");
  if (api === "") {
    io.err("despia licence sign: --api is required (or set DESPIA_API) — the platform to sign for");
    return 2;
  }
  const token = text("token", process.env["DESPIA_SERVICE_TOKEN"] ?? "");
  if (token === "") {
    io.err("despia licence sign: --token is required (or set DESPIA_SERVICE_TOKEN) — the internal routes are service-role only");
    return 2;
  }

  const dryRun = flags["dry-run"] !== undefined;
  let privateKeyPem = "";
  if (!dryRun) {
    const keyPath = text("key", process.env["DESPIA_SIGNING_KEY"] ?? "");
    if (keyPath === "") {
      io.err("despia licence sign: --key is required (or set DESPIA_SIGNING_KEY) — the Ed25519 private key PEM");
      return 2;
    }
    try {
      privateKeyPem = readFileSync(keyPath, "utf8");
    } catch {
      io.err(`despia licence sign: cannot read the signing key at ${keyPath}`);
      return 1;
    }
  }

  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let pending: { id: string; claims: Record<string, unknown> }[];
  try {
    const response = await fetch(`${api}/internal/licences/pending`, { headers: auth });
    if (!response.ok) {
      io.err(`despia licence sign: the platform answered ${response.status} listing pending licences`);
      return 1;
    }
    pending = ((await response.json()) as { pending?: { id: string; claims: Record<string, unknown> }[] }).pending ?? [];
  } catch (e) {
    io.err(`despia licence sign: could not reach ${api} — ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (pending.length === 0) {
    io.out("despia licence sign — nothing is waiting to be signed");
    return 0;
  }
  io.out(`despia licence sign — ${pending.length} licence(s) waiting`);

  let signed = 0;
  let refused = 0;
  for (const row of pending) {
    const claims = row.claims ?? {};
    let entitlement;
    try {
      entitlement = buildClaims({
        app: String(claims["appId"] ?? ""),
        platform: String(claims["platform"] ?? ""),
        major: Number(claims["majorVersion"] ?? 0),
        variants: Array.isArray(claims["variants"]) ? (claims["variants"] as string[]).map(String) : [],
        licenseId: String(claims["licenceId"] ?? claims["licenseId"] ?? ""),
        issued: String(claims["issued"] ?? new Date().toISOString().slice(0, 10)),
      });
    } catch (e) {
      refused++;
      io.err(`  refused ${row.id} — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (dryRun) {
      io.out(`  would sign ${row.id} — ${entitlement.appId} ${entitlement.platform} v${entitlement.majorVersion}`);
      continue;
    }

    let file;
    try {
      file = signClaims(entitlement, privateKeyPem);
    } catch (e) {
      io.err(`despia licence sign: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    try {
      const response = await fetch(`${api}/internal/licences/${encodeURIComponent(row.id)}/entitlement`, {
        method: "POST", headers: auth, body: JSON.stringify({ entitlement: file }),
      });
      if (!response.ok) {
        refused++;
        io.err(`  rejected ${row.id} — the platform answered ${response.status}`);
        continue;
      }
    } catch (e) {
      refused++;
      io.err(`  rejected ${row.id} — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    signed++;
    io.out(`  signed  ${row.id} — ${entitlement.appId} ${entitlement.platform} v${entitlement.majorVersion}`);
  }

  if (refused > 0) {
    io.err(`despia licence sign: ${refused} licence(s) could not be signed`);
    return 1;
  }
  io.out(dryRun ? "nothing was signed (--dry-run)" : `${signed} licence(s) signed`);
  return 0;
}

async function commandOta(flags: Flags, positional: string[], io: Io): Promise<number> {
  const verb = positional[0];
  const out = typeof flags["out"] === "string" ? flags["out"] : "dist-ota";
  switch (verb) {
    case "build": {
      // Default input: the project's Components/ — the screens are the content. Any folder
      // works; the content plane does not care what the bytes mean.
      let input = typeof flags["in"] === "string" ? flags["in"] : null;
      if (input === null) {
        const projectRoot = typeof flags["project"] === "string" ? resolve(flags["project"]) : findProjectRoot(process.cwd());
        input = projectRoot !== null ? join(projectRoot, "Components") : null;
      }
      if (input === null) throw new OtaError("no content directory — pass --in <dir>, or stand in a project (Components/ is the default)");
      // `--rollout 0.1` or `--rollout 0.1:canary-salt`. The salt is optional and defaults to
      // the generation id, so each release re-buckets its devices instead of always canarying
      // the same unlucky installs.
      const rolloutFlag = typeof flags["rollout"] === "string" ? flags["rollout"] : null;
      let rolloutFraction: number | undefined;
      let rolloutSalt: string | undefined;
      if (rolloutFlag !== null) {
        const [rawFraction, ...saltParts] = rolloutFlag.split(":");
        rolloutFraction = Number(rawFraction);
        if (!Number.isFinite(rolloutFraction)) {
          throw new OtaError(`--rollout ${JSON.stringify(rolloutFlag)} is not a number. Write --rollout 0.1, or 0.1:my-salt.`);
        }
        if (saltParts.length > 0 && saltParts.join(":") !== "") rolloutSalt = saltParts.join(":");
      }
      const result = otaBuild(input, out, {
        runtimeVersion: typeof flags["runtime-version"] === "string" ? flags["runtime-version"] : undefined,
        rolloutFraction,
        rolloutSalt,
      });
      io.out(`[despia ota] generation ${result.generation.slice(0, 12)} — ${result.files} file(s), ${result.bytes} bytes → ${relative(process.cwd(), result.outDir) || result.outDir}`);
      if (result.gate.runtimeVersion !== undefined) {
        io.out(`[despia ota] gated: runtime ${result.gate.runtimeVersion} and above — every older install keeps what it has`);
      }
      if (result.gate.rollout !== undefined) {
        const percent = Math.round(result.gate.rollout.fraction * 1000) / 10;
        io.out(`[despia ota] staged: ${percent}% of installs (salt ${result.gate.rollout.salt.slice(0, 12)}) — re-run with a wider --rollout to widen it`);
      }
      if (result.gate.runtimeVersion === undefined && result.gate.rollout === undefined) {
        io.out("[despia ota] ungated: every install on every runtime. Use --rollout 0.1 to stage it.");
      }
      io.out(result.changed ? "[despia ota] this is a NEW generation — publish to take it live" : "[despia ota] unchanged — same bytes, same generation");
      return 0;
    }
    case "publish": {
      const target = typeof flags["target"] === "string" ? flags["target"] : "";
      if (target === "") throw new OtaError("publish needs --target: dir:<path> · s3://bucket/prefix · netlify · cloudflare");
      const plan = otaPublishPlan(out, target);
      for (const step of plan.steps) {
        io.out(`[despia ota] ${step.title}`);
        if (step.cmd !== null) io.out(`  $ ${step.cmd.join(" ")}`);
      }
      if (flags["apply"] !== true) {
        io.out("[despia ota] plan only. Re-run with --apply to execute.");
        return 0;
      }
      if (plan.copyTo !== undefined) {
        const copied = otaCopyTo(out, plan.copyTo);
        io.out(`[despia ota] published ${copied} top-level entr${copied === 1 ? "y" : "ies"} to ${plan.copyTo}`);
        return 0;
      }
      const { spawnSync } = await import("node:child_process");
      for (const step of plan.steps) {
        if (step.cmd === null) continue;
        const ran = spawnSync(step.cmd[0]!, step.cmd.slice(1), { stdio: "inherit" });
        if (ran.status !== 0) throw new OtaError(`${step.title} failed (exit ${ran.status ?? "signal"})`);
      }
      return 0;
    }
    case "rollback": {
      const result = otaRollback(out);
      io.out(`[despia ota] repointed ${result.from.slice(0, 12)} → ${result.to.slice(0, 12)} — publish to take it live`);
      return 0;
    }
    default:
      throw new OtaError(`unknown verb ${JSON.stringify(verb ?? "")} — despia ota build | publish | rollback`);
  }
}

function commandLint(flags: Flags, positional: string[], packageArgs: string[], io: Io): number {
  const strict = flags["strict"] === true;
  const cwd = process.cwd();
  const explicitFiles = positional.map((f) => resolve(cwd, f));
  const extraTrees = packageArgs.map((p) => resolve(cwd, p));

  let files: string[];
  let context: LintContext;
  const projectRoot = typeof flags["project"] === "string" ? resolve(cwd, flags["project"]) : findProjectRoot(cwd);
  if (projectRoot !== null) {
    const config = loadConfig(projectRoot);
    const roots = packageRoots(config);
    files = explicitFiles.length > 0 ? explicitFiles : roots.flatMap((root) => componentFiles(root));
    context = lintContext(roots, files, config.root, extraTrees, config.modules);
  } else if (explicitFiles.length > 0 || extraTrees.length > 0) {
    files = explicitFiles.length > 0
      ? explicitFiles
      : extraTrees.flatMap((tree) => componentFilesUnder(tree));
    context = lintContext([], files, cwd, extraTrees);
  } else {
    throw new ConfigError(
      `no ${CONFIG_FILENAME} found in ${cwd} or any parent, and no files were named — ` +
      "run `despia lint <file.dsx> …`, point at packages with --package <dir>, or stand in a project.",
    );
  }

  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    if (!existsSync(file)) { io.err(`despia lint: no such file: ${file}`); return 1; }
    findings.push(...lintSource(file, readFileSync(file, "utf8"), context));
  }
  for (const finding of findings) io.out(formatFinding(finding));
  const counts = tally(findings);
  io.out(`despia lint: ${files.length} files · ${counts.errors} errors · ${counts.warnings} warnings · ${counts.notices} notices`);
  return counts.errors > 0 || (strict && counts.warnings > 0) ? 1 : 0;
}

/** Every `Components/**\/*.dsx` under a TREE of packages (used by `--package <dir>`). */
function componentFilesUnder(tree: string): string[] {
  const pool = new Map<string, Array<string | null>>();
  const schemes = new Set<string>();
  const files: string[] = [];
  foldPackageTree(tree, pool, schemes, (packageRoot) => {
    const found = componentFiles(packageRoot);
    files.push(...found);
    return found;
  });
  return files;
}

/** Build the pool + scheme universe from the package roots the caller can actually see.
 *  `trees` are `--package` arguments: whole folders scanned for every dsx.json below them,
 *  which is how a caller hands the CLI the same universe lint_dsx.rb scans by default. */
export function lintContext(
  roots: readonly string[], files: readonly string[], anchor: string, trees: readonly string[] = [],
  declaredModules: readonly string[] = [],
): LintContext {
  const pool = new Map<string, Array<string | null>>();
  // "self" + "route" ship with every renderer; `declaredModules` is the app's dsx.config.json
  // `modules` list — PLATFORM schemes the native side provides (declare-then-reach: exactly
  // these names are admitted, so a typo'd scheme still warns).
  const schemes = new Set<string>(["self", "route", ...declaredModules]);
  const seen = new Set<string>();
  let treePackages = 0;
  for (const tree of trees) {
    seen.add(tree);
    treePackages += foldPackageTree(tree, pool, schemes, componentFiles);
  }
  for (const root of roots) {
    seen.add(root);
    foldPackage(root, pool, schemes, componentFiles(root));
  }
  // A file named explicitly may live outside every configured root — fold ITS package too,
  // the same way lint_dsx.rb's pool_package_of does.
  for (const file of files) {
    const packageRoot = nearestPackage(file);
    if (packageRoot === null || seen.has(packageRoot)) continue;
    seen.add(packageRoot);
    foldPackage(packageRoot, pool, schemes, componentFiles(packageRoot));
  }
  // The reference catalogs: a despia-framework checkout wins (dev-loop freshness); outside
  // one, the copies the package ships (dist/src/reference, prepack's copy:document) serve —
  // WITHOUT them `dsx lint` silently stood down on the whole attribute census exactly where
  // most users run it, which is where an AI author needs the census most.
  // Anchor first (an in-repo project), then the toolchain's own location (the monorepo's
  // dev bin pointed at an outside project); a shipped install resolves neither.
  const repo = findRepoRoot(anchor) ?? findRepoRoot(fileURLToPath(import.meta.url));
  const shipped = join(dirname(fileURLToPath(import.meta.url)), "reference");
  const reference = (name: string): string => repo === null
    ? join(shipped, name)
    : join(repo, "OpenSource/Documentation/reference", name);
  const styleEjects = readStyleEjects(reference("stack-style-properties.json"));
  const census = readAttributeCensus(
    reference("stack-elements.json"),
    reference("stack-style-properties.json"),
    repo === null ? join(shipped, "lint-facts.json") : join(repo, "OpenSource/Conformance/lint/facts.json"),
  );
  return {
    pool,
    schemes,
    schemeOf: (dir) => schemeForDir(dir, "/"),
    styleEjects,
    census,
    // The scheme universe is only PROVEN when the caller handed over whole package trees
    // (`--package <dir>`): then an unknown `dsx.module.<scheme>` is a real error, exactly as
    // lint_dsx.rb reports it. Otherwise it softens to a warning that says why.
    schemesComplete: treePackages > 0,
  };
}

function nearestPackage(file: string): string | null {
  let cursor = resolve(file, "..");
  for (;;) {
    if (existsSync(join(cursor, "dsx.json"))) return cursor;
    const parent = resolve(cursor, "..");
    if (parent === cursor) return null;
    cursor = parent;
  }
}
