//
//  @despia-native/cli — the DSX web toolchain: `despia build`, `despia dev`, `despia lint`, `despia doctor`.
//  Every command is also a plain function, so the toolchain is scriptable without a shell.
//
//  IT IS ALSO THE CLI NODE ITSELF. The four exports below `cli.ts` are what makes a
//  command-line program authorable in DSX by anyone, not just by us: read a `<cli>` document,
//  bind argv to a command through its declared shape, and run a declared body against the CLI
//  seams. `despia` is simply the first program built this way (cli-authoring.md), and the reason
//  it is exported rather than kept private is that a node nobody else can use is a demo.
//
//    import { readCliDocument, dispatch, runDeclaredCommand, usage } from "@despia-native/cli";
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
// The registry (v4-launch/registry/00-plan.md): coordinates + lockfile, resolution + the
// canonical tree hash, the index fold, and the command surface. Exported because the registry
// repo's own scripts (append-ledger, build-index) must compute hashes with the SAME code that
// installs — a ledger hashed by a second implementation is a divergence waiting to disagree.
export {
  parsePackageRef, refId, gitRemote, searchIndex, emptyLockfile, lockAdd, lockRemove,
  serializeLockfile, RegistryError,
  type PackageRef, type IndexEntry, type RegistryIndex, type LockEntry, type Lockfile,
} from "./registry.ts";
export {
  resolveGitPackage, materialize, treeHash, listRemoteTags, newestSemverTag, defaultCacheDir,
  cachePath, isOffline, ResolveError, type ResolvedPackage, type ResolveOptions,
} from "./registry-resolve.ts";
export {
  manifestActions, foldPackage as foldIndexPackage, buildIndex, parsePackageList, IndexError,
  type PackageManifest, type RepoFacts, type IndexRejection, type IndexResult,
} from "./registry-index.ts";
export {
  commandSearch, commandAdd, commandRemove, commandList, firstPartyIndex, readLockfile,
  writeLockfile, lockedModuleDirs, LOCK_FILENAME, type AddOptions,
} from "./registry-commands.ts";
export {
  fetchCandidate, fetchAllCandidates, MANIFEST_BYTE_CAP,
  type FetchLike, type FetchRowOptions, type FetchedRow, type FetchOutcome,
} from "./registry-fetch.ts";
export {
  exportGate, splitByShelf, coversApp, LicenceError,
  ENTITLEMENT_FILENAME, PRICING_URL, VARIANT_SUFFIXES,
  type Entitlement, type ShelfSplit, type GateInput, type GateResult,
} from "./licence.ts";
export {
  toolsFromDocument, callTool, handleRpc, serveMcp, argvFor, toolName, commandName,
  LONG_RUNNING, PROTOCOL_VERSION,
  type McpTool, type McpToolSchema, type ToolResult,
} from "./mcp.ts";
// Minting `despia-entitlement.json`. Exported because the entitlement rule has FOUR
// implementations (ruby signer, swift + kotlin verifiers, this) and one corpus binding them
// (entitlement_native_parity_test.rb) — a caller that reimplements canonicalBytes is a fifth.
export {
  canonicalBytes, buildClaims, signClaims, verifyEntitlement, EntitlementError, PLATFORMS,
  type EntitlementClaims, type BuildInput,
} from "./entitlement.ts";
// The basic-block projection the visual logic editor rests on (platform/00-vision.md §3).
// Exported because the editor, the MCP surface and any future review UI must all project the
// SAME graph from the same source; a second projection is a second source of truth.
export {
  projectCfg, reconstruct, compaction, liveness,
  type Span, type Region, type Cfg, type CfgNode, type CfgEdge, type BlockFlow,
} from "./cfg.ts";
export {
  generateSiteProject, buildSite, SiteError,
  type SiteInput, type SitePage, type ActionDetail, type GeneratedSite, type SiteResult,
} from "./registry-site.ts";
