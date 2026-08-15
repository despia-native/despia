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
import { CONFIG_FILENAME, componentFiles, findProjectRoot, loadConfig, packageRoots, ConfigError, type ProjectConfig } from "./config.ts";
import { startDemoServer, startDevServer } from "./dev.ts";
import {
  foldPackage, foldPackageTree, formatFinding, lintSource, readStyleEjects, schemeForDir, tally,
  type Finding, type LintContext,
} from "./lint.ts";

export const VERSION = "0.1.0";

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
    io.err(`dsx: unknown command '${command}'`);
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
      case "lint": return commandLint(flags, positional, repeated["package"] ?? [], io);
      default:
        // The document declared a handler this host does not implement. That is a defect in
        // the pair, and saying so beats pretending the command does not exist.
        io.err(`dsx: '${command}' declares handler "${declared.handler}", which this build does not provide`);
        return 70;
    }
  } catch (e) {
    if (e instanceof BuildError || e instanceof ConfigError) { io.err(`dsx ${command}: ${e.message}`); return 1; }
    io.err(`dsx ${command}: ${e instanceof Error ? e.message : String(e)}`);
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
    io.err(`dsx: ${e.message}`);
    io.out(USAGE);
    return 2;
  }
  const action = CLI_DOCUMENT.actions.get(actionName)!;
  const asked = invocation.inputs["project"];
  const cwd = typeof asked === "string" && asked.length > 0 ? resolve(process.cwd(), asked) : process.cwd();
  const result = await runDeclaredCommand(CLI_DOCUMENT, action, invocation.inputs, { cwd, io });
  if (result.reason !== undefined) io.err(`dsx ${invocation.command.name}: ${result.message ?? result.reason}`);
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
      " Scaffold one with `npm create dsx`.",
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
  io.out(`[dsx build] ${config.name} (${config.scheme}) — ${result.components} components`);
  io.out(`[dsx build] ${result.written.length} files → ${relative(config.root, result.outDir) || result.outDir}`);
  return 0;
}

async function commandDev(flags: { [name: string]: string | boolean }, io: Io): Promise<number> {
  const port = typeof flags["port"] === "string" ? parseInt(flags["port"], 10) : undefined;
  if (flags["demo"] === true) {
    const server = await startDemoServer(process.cwd(), port ?? 8787);
    io.out(`[dsx dev] repository demo at http://localhost:${server.port}/demo/site/`);
    return await never();
  }
  const config = requireProject(flags);
  const server = await startDevServer(config, {
    ...(port !== undefined ? { port } : {}),
    ...(typeof flags["host"] === "string" ? { host: flags["host"] } : {}),
    log: io.out,
  });
  io.out(`[dsx dev] ${config.name} at http://localhost:${server.port}/`);
  return await never();
}

/** `dsx dev` runs until the process is signalled; the promise never settles by design. */
function never(): Promise<number> {
  return new Promise<number>(() => { /* held open by the listening socket */ });
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
    context = lintContext(roots, files, config.root, extraTrees);
  } else if (explicitFiles.length > 0 || extraTrees.length > 0) {
    files = explicitFiles.length > 0
      ? explicitFiles
      : extraTrees.flatMap((tree) => componentFilesUnder(tree));
    context = lintContext([], files, cwd, extraTrees);
  } else {
    throw new ConfigError(
      `no ${CONFIG_FILENAME} found in ${cwd} or any parent, and no files were named — ` +
      "run `dsx lint <file.dsx> …`, point at packages with --package <dir>, or stand in a project.",
    );
  }

  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    if (!existsSync(file)) { io.err(`dsx lint: no such file: ${file}`); return 1; }
    findings.push(...lintSource(file, readFileSync(file, "utf8"), context));
  }
  for (const finding of findings) io.out(formatFinding(finding));
  const counts = tally(findings);
  io.out(`dsx lint: ${files.length} files · ${counts.errors} errors · ${counts.warnings} warnings · ${counts.notices} notices`);
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
): LintContext {
  const pool = new Map<string, Array<string | null>>();
  const schemes = new Set<string>(["self", "route"]);
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
  const repo = findRepoRoot(anchor);
  const styleEjects = repo === null
    ? new Set<string>()
    : readStyleEjects(join(repo, "OpenSource/Documentation/reference/stack-style-properties.json"));
  return {
    pool,
    schemes,
    schemeOf: (dir) => schemeForDir(dir, "/"),
    styleEjects,
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
