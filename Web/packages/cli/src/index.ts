//
//  @despia/cli — the DSX web toolchain: `dsx build`, `dsx dev`, `dsx lint`, `dsx doctor`.
//  Every command is also a plain function, so the toolchain is scriptable without a shell.
//
//  IT IS ALSO THE CLI NODE ITSELF. The four exports below `cli.ts` are what makes a
//  command-line program authorable in DSX by anyone, not just by us: read a `<cli>` document,
//  bind argv to a command through its declared shape, and run a declared body against the CLI
//  seams. `dsx` is simply the first program built this way (cli-authoring.md), and the reason
//  it is exported rather than kept private is that a node nobody else can use is a demo.
//
//    import { readCliDocument, dispatch, runDeclaredCommand, usage } from "@despia/cli";
//
//    const doc = readCliDocument(readFileSync("my.cli.dsx", "utf8"), "my.cli.dsx");
//    if (argv[0] === undefined || argv.includes("--help")) { console.log(usage(doc)); }
//    const { command, inputs } = dispatch(doc, argv);
//    const { code } = await runDeclaredCommand(doc, doc.actions.get(command.action!)!, inputs,
//      { cwd: process.cwd(), io: { out: console.log, err: console.error } });
//    process.exitCode = code;
//

export { runCli, parseArgs, requireProject, lintContext, USAGE, VERSION, CLI_DOCUMENT } from "./cli.ts";
export {
  readCliDocument, usage, CliDocumentError,
  type CliDocument, type CommandDecl, type ActionDecl, type FlagDecl, type PositionalDecl,
  type RootDecl, type FlagType,
} from "./document.ts";
export { dispatch, DispatchError, type Invocation, type DispatchReason } from "./dispatch.ts";
export {
  runDeclaredCommand, rootPaths, FAULT_EXIT,
  COMMAND_LOOP_CAP, COMMAND_DEADLINE_MS, COMMAND_CALL_CAP,
  type CommandIo, type CommandResult, type RunOptions,
} from "./declared.ts";
export {
  buildProject, buildDemo, bootloader, findRepoRoot, runtimeDistDir, scanDsxSpecifiers,
  BuildError, type BuildResult,
} from "./build.ts";
export {
  loadConfig, findProjectRoot, componentFiles, packageRoots, ConfigError, CONFIG_FILENAME,
  type ProjectConfig,
} from "./config.ts";
export {
  startDevServer, startDemoServer, devHeaders, injectReloadClient, errorPage,
  RELOAD_PATH, RELOAD_CLIENT, MIME, type DevServer, type DevOptions,
} from "./dev.ts";
export {
  lintSource, formatFinding, tally, foldPackage, schemeForDir, readStyleEjects,
  stripComments, liftCodeBodies, jseBalanced, nestedTernary, editDistance, decodeEntities,
  BUILTIN_TAGS, type Finding, type Level, type LintContext,
} from "./lint.ts";
