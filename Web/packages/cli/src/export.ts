//
//  export.ts — `despia export ios | android`: a REAL Xcode project and a REAL Android Studio
//  project from the developer's own project folder (owner directive 2026-08-16).
//
//  THE SHAPE OF THE DEAL, stated once. The open kit is the kernel, the module system and
//  this CLI — fully functional, nothing withheld: you write your own modules in your own
//  `Modules/` folder (dsx.json + swift/ + kotlin/ lanes, the same structure the framework's
//  own tree uses, because everything is a module), and `despia export` assembles them with the
//  open kernel into native projects you own. The commercial platform is the CONVENIENCE
//  layer on the same mechanism: its build supplies a module folder pre-loaded with the
//  maintained premium catalog and handles store submission — the same CLI, a richer folder.
//  An export is BUILD OUTPUT (reserved-directories.md): regenerate it, never hand-edit it.
//
//  WHAT AN EXPORT CONTAINS, and why each choice:
//    · THE KERNEL IS VENDORED, not fetched at build. iOS module code compiles in the SAME
//      target as the kernel (the monorepo's own assembly shape — module sources carry no
//      `import`, and the export keeps that convention byte-identical); Android composes the
//      kernel's own Gradle build via includeBuild + the dev.despia.engine:* substitutions,
//      exactly the pattern the framework's runtime uses. Both builds work offline forever.
//    · MODULE REGISTRATION IS GENERATED THE DOCUMENTED WAY. iOS: one DSXGeneratedTables
//      subclass (KernelTables.swift names this seam; the registry's class walk finds it).
//      Android: a GeneratedModules twin filling GeneratedModuleSchemes / GeneratedConfigRaw
//      and registering scanned factories, called from the generated Application.
//    · COMPONENTS SHIP AS FILES, not string literals: bundle resources under DSXComponents/
//      (iOS) and assets/components/ (Android), loaded into the component table at boot —
//      byte-exact templates, no escaping tier, and the OTA content plane can shadow them.
//    · THE FIRST FRAME IS THE KERNEL'S ENTRY FLOOR. DSXBoot.boot(present:) on iOS; on
//      Android the generated activity mounts the entry component through StackRootView —
//      the same minimal construction the renderer's own smoke gate uses. Navigation stacks,
//      splash orchestration and the rest of the production chrome are modules; write yours,
//      or use the maintained catalog.
//
//  Kernel resolution ladder: --kernel <dir> → DSX_KERNEL env → the monorepo walk-up →
//  an error naming the one clone command. A directory qualifies when it carries iOS/,
//  Android/, runtime.js and EngineConfig.json — OpenSource/Engine and the published
//  despia-kernel mirror are byte-compatible on exactly that surface.
//

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProjectConfig } from "./config.ts";
import { lockedModuleDirs } from "./registry-commands.ts";

export class ExportError extends Error {}

// ── the project model ───────────────────────────────────────────────────────────────────

export interface ExportModule {
  /** folder name under Modules/ */
  name: string;
  dir: string;
  /** the manifest's local scheme ("" = scheme-less, hook-only) */
  scheme: string;
  swiftLane: string | null;
  kotlinLane: string | null;
  swiftClass: string | null;
  /** fully qualified Kotlin class (package + name) */
  kotlinClass: string | null;
  /** Components/*.dsx owned by the module, registered under its scheme */
  components: { name: string; file: string }[];
  /** declared config.json values (scheme → key → value at registration) */
  config: Record<string, unknown>;
  /** the commercial shelf from the manifest. PREMIUM REQUIRES THE EXPLICIT MARKER: a module
   *  with no shelf is somebody's OWN module, and blocking those would break the DIY-is-free
   *  deal. See licence.ts splitByShelf for why this default is the opposite of tiers.json's. */
  shelf: "open" | "premium";
}

export interface ExportProject {
  name: string;
  scheme: string;
  entry: string;
  root: string;
  components: { name: string; file: string }[];
  modules: ExportModule[];
  /** the app's own App.json text, or null to generate the minimal root plan */
  appJson: string | null;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function listDsx(dir: string): { name: string; file: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".dsx"))
    .sort()
    .map((n) => ({ name: n.slice(0, -".dsx".length), file: join(dir, n) }));
}

/** The lane folders, canonical first (constitution rule 11: swift/ · kotlin/; ios/ · android/
 *  are the accepted legacy aliases — the same resolution DSXGraph.lane_dir applies). */
function laneDir(moduleDir: string, canonical: string, legacy: string): string | null {
  for (const lane of [canonical, legacy]) {
    const dir = join(moduleDir, lane);
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  return null;
}

function laneFiles(dir: string | null, ext: string): string[] {
  if (dir === null) return [];
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const abs = join(at, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(ext)) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** Find the ONE Module subclass a lane declares. The manifest binds the scheme to the class
 *  by name (GeneratedModuleSchemes), so ambiguity is an error naming the fix, never a guess. */
function scanSwiftClass(module: string, lane: string | null): string | null {
  const matches: string[] = [];
  for (const file of laneFiles(lane, ".swift")) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Module\b/g)) {
      matches.push(m[1]!);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  const named = matches.find((c) => c.toLowerCase() === module.toLowerCase());
  if (named !== undefined) return named;
  throw new ExportError(
    `module ${module}: the swift lane declares ${matches.length} Module subclasses (${matches.join(" · ")}) — ` +
    `name one after the module folder, or keep one Module subclass per module.`,
  );
}

function scanKotlinClass(module: string, lane: string | null): string | null {
  const found: { pkg: string; name: string }[] = [];
  for (const file of laneFiles(lane, ".kt")) {
    const source = readFileSync(file, "utf8");
    const pkg = /^\s*package\s+([\w.]+)/m.exec(source)?.[1] ?? "";
    for (const m of source.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:\s*(?:[\w.]*\b)?Module\b/g)) {
      found.push({ pkg, name: m[1]! });
    }
  }
  if (found.length === 0) return null;
  const pick = found.length === 1
    ? found[0]!
    : found.find((c) => c.name.toLowerCase() === module.toLowerCase());
  if (pick === undefined) {
    throw new ExportError(
      `module ${module}: the kotlin lane declares ${found.length} Module subclasses (${found.map((f) => f.name).join(" · ")}) — ` +
      `name one after the module folder, or keep one Module subclass per module.`,
    );
  }
  return pick.pkg === "" ? pick.name : `${pick.pkg}.${pick.name}`;
}

/** Fold one module directory — from `Modules/` or a lockfile-cache checkout — into the export
 *  model. `label` names the source in errors, so "Modules/Foo" and "github:acme/foo" both read
 *  as what the user actually wrote. The same validation applies to both sources by construction. */
function foldModuleDir(name: string, dir: string, label: string): ExportModule {
  const manifestPath = join(dir, "dsx.json");
  if (!existsSync(manifestPath)) {
    throw new ExportError(`${label} has no dsx.json — every module declares its identity (writing-a-module.md).`);
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ExportError(`${label}/dsx.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const scheme = typeof manifest["scheme"] === "string" ? manifest["scheme"] : "";
  if (scheme !== "" && !IDENT.test(scheme)) {
    throw new ExportError(`${label}: scheme ${JSON.stringify(scheme)} is not a plain identifier.`);
  }
  const swiftLane = laneDir(dir, "swift", "ios");
  const kotlinLane = laneDir(dir, "kotlin", "android");
  const configPath = join(dir, "config.json");
  let moduleConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(parsed)) {
      if (key.startsWith("_")) continue;
      moduleConfig[key] = typeof entry === "object" && entry !== null && "value" in (entry as object)
        ? (entry as { value: unknown }).value
        : entry;
    }
  }
  return {
    name,
    dir,
    scheme,
    shelf: manifest["shelf"] === "premium" ? "premium" : "open",
    swiftLane,
    kotlinLane,
    swiftClass: scanSwiftClass(name, swiftLane),
    kotlinClass: scanKotlinClass(name, kotlinLane),
    components: listDsx(join(dir, "Components")),
    config: moduleConfig,
  };
}

/** Read the project's modules from BOTH sources: its `Modules/` folder, and the lockfile's
 *  pinned packages materialized out of the cache (each re-verified against its pin). */
export function readExportProject(config: ProjectConfig): ExportProject {
  const modulesDir = join(config.root, "Modules");
  const modules: ExportModule[] = [];
  if (existsSync(modulesDir)) {
    for (const name of readdirSync(modulesDir).sort()) {
      const dir = join(modulesDir, name);
      if (!statSync(dir).isDirectory()) continue;
      modules.push(foldModuleDir(name, dir, `Modules/${name}`));
    }
  }
  for (const locked of lockedModuleDirs(config.root)) {
    // `github:acme/dsx-lidar` → module name `dsx-lidar`; a local Modules/ folder of the same
    // name would shadow it silently, so that is a refusal naming both.
    const name = locked.id.substring(locked.id.lastIndexOf("/") + 1);
    if (modules.some((m) => m.name === name)) {
      throw new ExportError(
        `${locked.id} and Modules/${name} would both export as module ${JSON.stringify(name)} — ` +
        "rename the local module or remove the pin.",
      );
    }
    modules.push(foldModuleDir(name, locked.dir, locked.id));
  }
  const appJsonPath = join(config.root, "App.json");
  return {
    name: config.name,
    scheme: config.scheme,
    entry: config.entry,
    root: config.root,
    components: listDsx(join(config.root, "Components")),
    modules,
    appJson: existsSync(appJsonPath) ? readFileSync(appJsonPath, "utf8") : null,
  };
}

// ── kernel resolution ───────────────────────────────────────────────────────────────────

function kernelShaped(dir: string): boolean {
  return existsSync(join(dir, "iOS")) && existsSync(join(dir, "Android"))
    && existsSync(join(dir, "runtime.js")) && existsSync(join(dir, "EngineConfig.json"));
}

export function resolveKernel(explicit?: string): string {
  // A named kernel is a contract: if --kernel (or DSX_KERNEL) points somewhere that is not a
  // kernel checkout, failing over to a different kernel would build against sources the user
  // never chose. Refuse instead; only the unnamed case searches.
  const env = process.env["DSX_KERNEL"];
  const named = explicit !== undefined && explicit !== ""
    ? { source: "--kernel", dir: resolve(explicit) }
    : env !== undefined && env !== ""
      ? { source: "DSX_KERNEL", dir: resolve(env) }
      : null;
  if (named !== null) {
    if (kernelShaped(named.dir)) return named.dir;
    throw new ExportError(
      `${named.source} points at ${named.dir}, which is not a kernel checkout — expected iOS/, Android/, ` +
      "runtime.js and EngineConfig.json (git clone https://github.com/despia-native/despia-kernel).",
    );
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "OpenSource", "Engine");
    if (kernelShaped(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ExportError(
    "no kernel sources found — pass --kernel <dir> or set DSX_KERNEL to a checkout of the kernel " +
    "(git clone https://github.com/despia-native/despia-kernel), the folder carrying iOS/, Android/, " +
    "runtime.js and EngineConfig.json.",
  );
}

// ── deterministic emission helpers ──────────────────────────────────────────────────────

/** A stable pbxproj object id: 24 uppercase hex from the reference's own name. Same input,
 *  same project file — the export's byte-determinism is what makes it diffable build output. */
function pbxId(kind: string, name: string): string {
  return createHash("md5").update(`dsx-export:${kind}:${name}`).digest("hex").slice(0, 24).toUpperCase();
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function copyFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function copyTree(from: string, to: string, skip: (rel: string) => boolean = () => false): void {
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const abs = join(at, name);
      const rel = relative(from, abs).split(sep).join("/");
      if (skip(rel)) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else copyFile(abs, join(to, ...rel.split("/")));
    }
  };
  walk(from);
}

function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return cleaned === "" ? "app" : cleaned;
}

/** The minimal root plan when the project ships no App.json: the entry component IS the app. */
function generatedAppJson(project: ExportProject): string {
  return JSON.stringify({
    entry: { root: "/", surfaces: [project.entry] },
  }, null, 2) + "\n";
}

/** Component bundle layout, one law for both platforms: <scope>/<Name>.dsx, "_" = global. */
function componentRows(project: ExportProject): { scope: string | null; name: string; file: string }[] {
  const rows: { scope: string | null; name: string; file: string }[] = [];
  for (const c of project.components) rows.push({ scope: project.scheme, name: c.name, file: c.file });
  for (const m of project.modules) {
    for (const c of m.components) rows.push({ scope: m.scheme === "" ? null : m.scheme, name: c.name, file: c.file });
  }
  return rows;
}

// ── the iOS export ──────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  kernel?: string;
  out?: string;
  bundleId?: string;
}

export function exportIos(project: ExportProject, opts: ExportOptions = {}): string {
  const kernel = resolveKernel(opts.kernel);
  const out = resolve(opts.out ?? join(project.root, "export", "ios"));
  rmSync(out, { recursive: true, force: true });
  const bundleId = opts.bundleId ?? `com.example.${slug(project.name)}`;

  // 1 ── the kernel, vendored into the app target (the monorepo's own assembly shape).
  copyTree(join(kernel, "iOS"), join(out, "Kernel"), (rel) =>
    rel === "ConformanceHosts.swift" || rel.endsWith(".md"));

  // 2 ── the developer's modules: swift lanes compiled into the same target.
  for (const m of project.modules) {
    if (m.swiftLane === null) continue;
    copyTree(m.swiftLane, join(out, "Modules", m.name));
  }

  // 3 ── resources: identity, engine config, the bridge runtime, and every component as a
  //      byte-exact file under DSXComponents/<scope>/.
  write(join(out, "Resources", "App.json"), project.appJson ?? generatedAppJson(project));
  copyFile(join(kernel, "EngineConfig.json"), join(out, "Resources", "EngineConfig.json"));
  copyFile(join(kernel, "runtime.js"), join(out, "Resources", "runtime.js"));
  for (const row of componentRows(project)) {
    copyFile(row.file, join(out, "Resources", "DSXComponents", row.scope ?? "_", `${row.name}.dsx`));
  }

  // 4 ── the generated host: boot + the documented tables subclass + the ObjC bridging header.
  write(join(out, "App", "AppDelegate.swift"), iosAppDelegate(project));
  write(join(out, "App", "GeneratedTables.swift"), iosGeneratedTables(project));
  write(join(out, "App", "Bridging.h"), `//\n//  Bridging.h — GENERATED by despia export. The kernel's ObjC exception trampoline\n//  (DSXCatchReturning) joins the Swift target here, the same role the framework's own\n//  runtime bridging header plays.\n//\n#import "DSXObjCException.h"\n`);
  write(join(out, "App", "Info.plist"), iosInfoPlist(project));

  // 5 ── the Xcode project itself, plus a shared scheme so xcodebuild works headless.
  write(join(out, `${xcodeTargetName(project)}.xcodeproj`, "project.pbxproj"), iosPbxproj(project, out, bundleId));
  write(
    join(out, `${xcodeTargetName(project)}.xcodeproj`, "xcshareddata", "xcschemes", `${xcodeTargetName(project)}.xcscheme`),
    iosScheme(xcodeTargetName(project)),
  );
  write(join(out, "README.md"), exportReadme(project, "ios"));
  return out;
}

function xcodeTargetName(project: ExportProject): string {
  const cleaned = project.name.replace(/[^A-Za-z0-9]+/g, "");
  return cleaned === "" ? "App" : cleaned;
}

function iosAppDelegate(project: ExportProject): string {
  return `//
//  AppDelegate.swift — GENERATED by despia export. The host is a bootloader: one window,
//  one DSXBoot call, nothing else (hosts never carry behavior — that is what modules
//  are for). Regenerate with \`despia export ios\`; do not hand-edit build output.
//

import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        self.window = window
        DSXBoot.boot(present: { root in
            window.rootViewController = root
            window.makeKeyAndVisible()
        })
        return true
    }
}
`;
}

function swiftString(value: string): string {
  return JSON.stringify(value);
}

function iosGeneratedTables(project: ExportProject): string {
  const schemeRows = project.modules
    .filter((m) => m.swiftClass !== null && m.scheme !== "")
    .map((m) => `            ${swiftString(m.swiftClass!)}: ${swiftString(m.scheme)},`);
  const schemeLines = schemeRows.length === 0
    ? "        KernelTables.moduleSchemeByClassName = [:]"
    : `        KernelTables.moduleSchemeByClassName = [\n${schemeRows.join("\n")}\n        ]`;
  const configLines = project.modules
    .filter((m) => m.scheme !== "" && Object.keys(m.config).length > 0)
    .map((m) => `        KernelTables.configByScheme[${swiftString(m.scheme)}] = ${swiftLiteral(m.config)} as [String: Any]`);
  return `//
//  GeneratedTables.swift — GENERATED by despia export (the DSXGeneratedTables seam,
//  KernelTables.swift). The registry's class walk finds this subclass at boot and installs
//  the tables BEFORE any module registers — no call site, no ordering to get wrong.
//  Components load from the bundled DSXComponents/ files, byte-exact.
//

import Foundation

final class ExportGeneratedTables: DSXGeneratedTables {
    override class func install() {
${schemeLines}
${configLines.length > 0 ? configLines.join("\n") + "\n" : ""}        KernelTables.stackComponents = loadBundledComponents()
    }

    /// DSXComponents/<scope>/<Name>.dsx → (name, scheme, xml); "_" is the global scope.
    private static func loadBundledComponents() -> [(name: String, scheme: String?, xml: String)] {
        guard let base = Bundle.main.resourceURL?.appendingPathComponent("DSXComponents", isDirectory: true),
              let scopes = try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)
        else { return [] }
        var rows: [(name: String, scheme: String?, xml: String)] = []
        for scopeDir in scopes.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let scope = scopeDir.lastPathComponent
            guard let files = try? FileManager.default.contentsOfDirectory(at: scopeDir, includingPropertiesForKeys: nil) else { continue }
            for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where file.pathExtension == "dsx" {
                guard let xml = try? String(contentsOf: file, encoding: .utf8) else { continue }
                rows.append((name: file.deletingPathExtension().lastPathComponent,
                             scheme: scope == "_" ? nil : scope,
                             xml: xml))
            }
        }
        return rows
    }
}
`;
}

function swiftLiteral(value: unknown): string {
  if (value === null) return "NSNull()";
  if (typeof value === "string") return swiftString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(swiftLiteral).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${swiftString(k)}: ${swiftLiteral(v)}`);
  return entries.length === 0 ? "[:]" : `[${entries.join(", ")}]`;
}

function iosInfoPlist(project: ExportProject): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>${project.name}</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0.0</string>
\t<key>CFBundleVersion</key>
\t<string>1</string>
\t<key>UILaunchScreen</key>
\t<dict/>
\t<key>UISupportedInterfaceOrientations</key>
\t<array>
\t\t<string>UIInterfaceOrientationPortrait</string>
\t\t<string>UIInterfaceOrientationLandscapeLeft</string>
\t\t<string>UIInterfaceOrientationLandscapeRight</string>
\t</array>
</dict>
</plist>
`;
}

/** One app target; groups mirror the folders; every Swift/ObjC file in Sources, the resource
 *  tree in Resources. Ids derive from paths, so the file is byte-stable across exports. */
function iosPbxproj(project: ExportProject, out: string, bundleId: string): string {
  const target = xcodeTargetName(project);

  const sources: string[] = [];
  const walkFor = (base: string, exts: string[]): string[] => {
    const found: string[] = [];
    const walk = (at: string): void => {
      if (!existsSync(at)) return;
      for (const name of readdirSync(at).sort()) {
        const abs = join(at, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (exts.some((e) => name.endsWith(e))) found.push(relative(out, abs).split(sep).join("/"));
      }
    };
    walk(base);
    return found;
  };
  sources.push(...walkFor(join(out, "App"), [".swift"]));
  sources.push(...walkFor(join(out, "Kernel"), [".swift", ".m"]));
  sources.push(...walkFor(join(out, "Modules"), [".swift"]));

  // The resource FOLDER ships as one folder reference — Xcode copies it whole, and the
  // loader reads it by directory, so adding a component never edits the project file.
  const resourceRefs = ["Resources/App.json", "Resources/EngineConfig.json", "Resources/runtime.js", "Resources/DSXComponents"];

  const fileRefLines: string[] = [];
  const buildFileLines: string[] = [];
  const sourceBuildIds: string[] = [];
  const resourceBuildIds: string[] = [];

  for (const rel of sources) {
    const refId = pbxId("ref", rel);
    const buildId = pbxId("build", rel);
    const name = rel.split("/").at(-1)!;
    const type = rel.endsWith(".m") ? "sourcecode.c.objc" : "sourcecode.swift";
    fileRefLines.push(`\t\t${refId} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = ${type}; name = "${name}"; path = "${rel}"; sourceTree = "<group>"; };`);
    buildFileLines.push(`\t\t${buildId} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${refId} /* ${name} */; };`);
    sourceBuildIds.push(`\t\t\t\t${buildId} /* ${name} in Sources */,`);
  }
  for (const rel of resourceRefs) {
    const refId = pbxId("ref", rel);
    const buildId = pbxId("build", rel);
    const name = rel.split("/").at(-1)!;
    const type = rel.endsWith("DSXComponents") ? "folder" : "text";
    fileRefLines.push(`\t\t${refId} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = ${type}; name = "${name}"; path = "${rel}"; sourceTree = "<group>"; };`);
    buildFileLines.push(`\t\t${buildId} /* ${name} in Resources */ = {isa = PBXBuildFile; fileRef = ${refId} /* ${name} */; };`);
    resourceBuildIds.push(`\t\t\t\t${buildId} /* ${name} in Resources */,`);
  }
  const plistRef = pbxId("ref", "App/Info.plist");
  fileRefLines.push(`\t\t${plistRef} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; name = "Info.plist"; path = "App/Info.plist"; sourceTree = "<group>"; };`);
  const bridgingRef = pbxId("ref", "App/Bridging.h");
  fileRefLines.push(`\t\t${bridgingRef} /* Bridging.h */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.h; name = "Bridging.h"; path = "App/Bridging.h"; sourceTree = "<group>"; };`);
  const productRef = pbxId("ref", `product:${target}.app`);
  fileRefLines.push(`\t\t${productRef} /* ${target}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = "${target}.app"; sourceTree = BUILT_PRODUCTS_DIR; };`);

  const groupChildren = [...sources, ...resourceRefs].sort()
    .map((rel) => `\t\t\t\t${pbxId("ref", rel)} /* ${rel.split("/").at(-1)} */,`);
  groupChildren.push(`\t\t\t\t${plistRef} /* Info.plist */,`);
  groupChildren.push(`\t\t\t\t${bridgingRef} /* Bridging.h */,`);

  const ids = {
    project: pbxId("obj", "project"),
    mainGroup: pbxId("obj", "mainGroup"),
    productsGroup: pbxId("obj", "productsGroup"),
    target: pbxId("obj", "target"),
    sourcesPhase: pbxId("obj", "sourcesPhase"),
    resourcesPhase: pbxId("obj", "resourcesPhase"),
    frameworksPhase: pbxId("obj", "frameworksPhase"),
    projectConfigList: pbxId("obj", "projectConfigList"),
    targetConfigList: pbxId("obj", "targetConfigList"),
    projectDebug: pbxId("obj", "projectDebug"),
    projectRelease: pbxId("obj", "projectRelease"),
    targetDebug: pbxId("obj", "targetDebug"),
    targetRelease: pbxId("obj", "targetRelease"),
  };

  const targetSettings = (config: string): string => `\t\t${config === "Debug" ? ids.targetDebug : ids.targetRelease} /* ${config} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = NO;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = "App/Info.plist";
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.6;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks";
\t\t\t\tMARKETING_VERSION = 1.0.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "${bundleId}";
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_OBJC_BRIDGING_HEADER = "App/Bridging.h";
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = ${config};
\t\t};`;

  const projectSettings = (config: string): string => `\t\t${config === "Debug" ? ids.projectDebug : ids.projectRelease} /* ${config} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;
\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;
\t\t\t\tGCC_C_LANGUAGE_STANDARD = gnu17;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.6;
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "${config === "Debug" ? "-Onone" : "-O"}";
\t\t\t};
\t\t\tname = ${config};
\t\t};`;

  return `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 56;
\tobjects = {

/* Begin PBXBuildFile section */
${buildFileLines.sort().join("\n")}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
${fileRefLines.sort().join("\n")}
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${ids.frameworksPhase} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${ids.mainGroup} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${groupChildren.join("\n")}
\t\t\t\t${ids.productsGroup} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${ids.productsGroup} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${productRef} /* ${target}.app */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${ids.target} /* ${target} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${ids.targetConfigList} /* Build configuration list for PBXNativeTarget "${target}" */;
\t\t\tbuildPhases = (
\t\t\t\t${ids.sourcesPhase} /* Sources */,
\t\t\t\t${ids.frameworksPhase} /* Frameworks */,
\t\t\t\t${ids.resourcesPhase} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = "${target}";
\t\t\tproductName = "${target}";
\t\t\tproductReference = ${productRef} /* ${target}.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${ids.project} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastUpgradeCheck = 1500;
\t\t\t};
\t\t\tbuildConfigurationList = ${ids.projectConfigList} /* Build configuration list for PBXProject "${target}" */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${ids.mainGroup};
\t\t\tproductRefGroup = ${ids.productsGroup} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${ids.target} /* ${target} */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${ids.resourcesPhase} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${resourceBuildIds.sort().join("\n")}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${ids.sourcesPhase} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${sourceBuildIds.sort().join("\n")}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
${projectSettings("Debug")}
${projectSettings("Release")}
${targetSettings("Debug")}
${targetSettings("Release")}
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${ids.projectConfigList} /* Build configuration list for PBXProject "${target}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${ids.projectDebug} /* Debug */,
\t\t\t\t${ids.projectRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${ids.targetConfigList} /* Build configuration list for PBXNativeTarget "${target}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${ids.targetDebug} /* Debug */,
\t\t\t\t${ids.targetRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */
\t};
\trootObject = ${ids.project} /* Project object */;
}
`;
}

function iosScheme(target: string): string {
  const targetId = pbxId("obj", "target");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1500" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${targetId}" BuildableName="${target}.app" BlueprintName="${target}" ReferencedContainer="container:${target}.xcodeproj"/>
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0">
      <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${targetId}" BuildableName="${target}.app" BlueprintName="${target}" ReferencedContainer="container:${target}.xcodeproj"/>
    </BuildableProductRunnable>
  </LaunchAction>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`;
}

// ── the Android export ──────────────────────────────────────────────────────────────────

/** The kernel pins its plugin versions in ONE place (Android/build.gradle.kts); a composite
 *  build must pin the SAME versions (one classloader per plugin version). Read them from the
 *  checkout rather than hardcoding a copy that drifts. */
export interface KernelVersions { kotlin: string; agp: string; composeBom: string; activityCompose: string }

export function kernelGradleVersions(kernel: string): KernelVersions {
  const source = readFileSync(join(kernel, "Android", "build.gradle.kts"), "utf8");
  const kotlin = /kotlin\("android"\)\s+version\s+"([^"]+)"/.exec(source)?.[1];
  const agp = /id\("com\.android\.library"\)\s+version\s+"([^"]+)"/.exec(source)?.[1];
  // The Compose pins live where the kernel consumes them (:render) — "one Compose version
  // across the composite" is the closed app's law, so the export reads the same source.
  const render = readFileSync(join(kernel, "Android", "render", "build.gradle.kts"), "utf8");
  const composeBom = /androidx\.compose:compose-bom:([^"]+)"/.exec(render)?.[1];
  const activityCompose = /androidx\.activity:activity-compose:([^"]+)"/.exec(render)?.[1];
  if (kotlin === undefined || agp === undefined || composeBom === undefined || activityCompose === undefined) {
    throw new ExportError(
      `could not read the Kotlin/AGP/Compose pins from ${join(kernel, "Android")} build scripts — ` +
      "the kernel checkout's layout changed; update despia export or pass a matching checkout.",
    );
  }
  return { kotlin, agp, composeBom, activityCompose };
}

export function exportAndroid(project: ExportProject, opts: ExportOptions = {}): string {
  const kernel = resolveKernel(opts.kernel);
  const out = resolve(opts.out ?? join(project.root, "export", "android"));
  rmSync(out, { recursive: true, force: true });
  const appId = opts.bundleId ?? `com.example.${slug(project.name)}`;
  const versions = kernelGradleVersions(kernel);

  // 1 ── the kernel, vendored in ITS OWN checkout shape (kernel/Android + kernel/VERSION,
  //      so :core's `../VERSION` one-version contract resolves inside the vendored tree)
  //      and composed the framework's own way: includeBuild + dev.despia.engine:*
  //      substitution. `desktop/` stays behind — file presence is the gate, and its build
  //      script is monorepo machinery (the ClosedSource package fan-in) a phone export
  //      neither needs nor can configure; the dangling include(":desktop") is an empty
  //      project to Gradle.
  copyTree(join(kernel, "Android"), join(out, "kernel", "Android"), (rel) =>
    rel.startsWith("build/") || rel.includes("/build/") || rel.startsWith(".gradle") || rel.includes("/.gradle/")
    || rel.startsWith("desktop/"));
  copyFile(join(kernel, "VERSION"), join(out, "kernel", "VERSION"));
  copyFile(join(kernel, "runtime.js"), join(out, "app", "src", "main", "assets", "runtime.js"));
  copyFile(join(kernel, "EngineConfig.json"), join(out, "app", "src", "main", "assets", "EngineConfig.json"));

  // 2 ── the wrapper, so `./gradlew` works from a fresh clone of the export.
  for (const rel of ["gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"]) {
    const from = join(kernel, "Android", ...rel.split("/"));
    if (existsSync(from)) copyFile(from, join(out, ...rel.split("/")));
  }

  // 3 ── identity + components as assets (byte-exact; "_" is the global scope).
  write(join(out, "app", "src", "main", "assets", "App.json"), project.appJson ?? generatedAppJson(project));
  for (const row of componentRows(project)) {
    copyFile(row.file, join(out, "app", "src", "main", "assets", "components", row.scope ?? "_", `${row.name}.dsx`));
  }

  // 4 ── the developer's modules: kotlin lanes copied into the app source set.
  for (const m of project.modules) {
    if (m.kotlinLane === null) continue;
    copyTree(m.kotlinLane, join(out, "app", "src", "main", "kotlin", "modules", m.name.toLowerCase()));
  }

  // 5 ── the generated host + build files.
  write(join(out, "settings.gradle.kts"), androidSettings(project));
  write(join(out, "build.gradle.kts"), androidRootBuild(versions));
  write(join(out, "gradle.properties"), "android.useAndroidX=true\norg.gradle.jvmargs=-Xmx3g\n");
  write(join(out, "app", "build.gradle.kts"), androidAppBuild(project, appId, versions));
  write(join(out, "app", "src", "main", "AndroidManifest.xml"), androidManifest(project));
  write(join(out, "app", "src", "main", "kotlin", "host", "DespiaApp.kt"), androidApp(project));
  write(join(out, "app", "src", "main", "kotlin", "host", "MainActivity.kt"), androidActivity(project));
  write(join(out, "README.md"), exportReadme(project, "android"));
  return out;
}

function androidSettings(project: ExportProject): string {
  return `// GENERATED by despia export — the app assembly. The kernel stays its OWN Gradle build
// (vendored under kernel/) and this build composes it, the same includeBuild +
// dev.despia.engine:* substitution the framework's runtime uses. Regenerate with
// \`despia export android\`; do not hand-edit build output.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${slug(project.name)}"

includeBuild("kernel/Android") {
    dependencySubstitution {
        substitute(module("dev.despia.engine:core")).using(project(":core"))
        substitute(module("dev.despia.engine:platform")).using(project(":platform"))
        substitute(module("dev.despia.engine:render")).using(project(":render"))
        substitute(module("dev.despia.engine:glance")).using(project(":glance"))
    }
}

include(":app")
`;
}

function androidRootBuild(versions: { kotlin: string; agp: string }): string {
  return `// GENERATED by despia export. Plugin versions are read FROM the vendored kernel so both
// builds in the composite pin the same AGP/Kotlin (one classloader per plugin version).
plugins {
    kotlin("android") version "${versions.kotlin}" apply false
    id("com.android.application") version "${versions.agp}" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "${versions.kotlin}" apply false
}
`;
}

function androidAppBuild(project: ExportProject, appId: string, versions: KernelVersions): string {
  return `// GENERATED by despia export — the app module: the vendored kernel by neutral coordinates,
// your modules' kotlin lanes in the main source set, your components as assets.
plugins {
    id("com.android.application")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// compileSdk 36 / minSdk 24 — one compileSdk across the composite (the kernel modules
// pin the same pair; drifting the app off it is the classic composite-build footgun).
android {
    namespace = "${appId}"
    compileSdk = 36

    defaultConfig {
        applicationId = "${appId}"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("dev.despia.engine:core")
    implementation("dev.despia.engine:platform")
    implementation("dev.despia.engine:render")

    // Compose BOM pinned to the kernel's (:render) — one Compose version across the composite.
    implementation(platform("androidx.compose:compose-bom:${versions.composeBom}"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:${versions.activityCompose}")
}
`;
}

function androidManifest(project: ExportProject): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET"/>
    <application
        android:name=".DespiaApp"
        android:label="${project.name}"
        android:supportsRtl="true">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
    </application>
</manifest>
`;
}

function kotlinString(value: string): string {
  return JSON.stringify(value);
}

function kotlinMap(rows: string[], indent: string): string {
  return rows.length === 0 ? "emptyMap()" : `mapOf(\n${rows.join("\n")}\n${indent})`;
}

function kotlinLiteral(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return kotlinString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `listOf(${value.map(kotlinLiteral).join(", ")})`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${kotlinString(k)} to ${kotlinLiteral(v)}`);
  return `mapOf(${entries.join(", ")})`;
}

function androidApp(project: ExportProject): string {
  const withClass = project.modules.filter((m) => m.kotlinClass !== null && m.scheme !== "");
  const factories = withClass.map((m) => `        ${kotlinString(m.scheme)} to { ${m.kotlinClass}() },`);
  const schemes = withClass.map((m) => `        ${kotlinString(m.kotlinClass!.split(".").at(-1)!)} to ${kotlinString(m.scheme)},`);
  const configs = project.modules
    .filter((m) => m.scheme !== "" && Object.keys(m.config).length > 0)
    .map((m) => `        ${kotlinString(m.scheme)} to ${kotlinLiteral(m.config)},`);
  return `//
//  DespiaApp.kt — GENERATED by despia export. The Application half of the bootloader: install
//  the kernel's asset-backed loaders, fill the generated-registry seams the documented way
//  (the GeneratedModules pattern), register your modules, mount nothing — the activity does
//  that. Regenerate with \`despia export android\`; do not hand-edit build output.
//

package host

import android.app.Application
import despia.engine.AppManifest
import despia.engine.GeneratedConfigRaw
import despia.engine.GeneratedModuleSchemes
import despia.engine.Module
import despia.engine.ModuleRegistry
import despia.engine.StackXML
import despia.engine.render.ComposeStackComponents

class DespiaApp : Application() {

    private val factories: Map<String, () -> Module> = ${kotlinMap(factories, "    ")}

    override fun onCreate() {
        super.onCreate()
        AppManifest.manifestLoader = { assetText("App.json") }
        AppManifest.engineConfigLoader = { assetText("EngineConfig.json") }

        GeneratedModuleSchemes.byClassName = ${kotlinMap(schemes, "        ")}
        GeneratedConfigRaw.byScheme = ${kotlinMap(configs, "        ")}

        registerBundledComponents()
        ModuleRegistry.shared.register(factories)
    }

    // assets/components/<scope>/<Name>.dsx → the component table; "_" is the global scope.
    // Parsed here, once at boot, through the kernel's own parser — the same acceptance
    // every other component source gets.
    private fun registerBundledComponents() {
        val scopes = assets.list("components") ?: return
        for (scope in scopes.sorted()) {
            val files = assets.list("components/" + scope) ?: continue
            for (file in files.sorted()) {
                if (!file.endsWith(".dsx")) continue
                val xml = assetText("components/" + scope + "/" + file) ?: continue
                val template = StackXML.parse(xml) ?: continue
                ComposeStackComponents.defineNode(
                    file.removeSuffix(".dsx"),
                    template,
                    if (scope == "_") null else scope,
                )
            }
        }
    }

    private fun assetText(name: String): String? = try {
        assets.open(name).use { it.readBytes().toString(Charsets.UTF_8) }
    } catch (_: Exception) {
        null
    }
}
`;
}

function androidActivity(project: ExportProject): string {
  return `//
//  MainActivity.kt — GENERATED by despia export. One activity, one mount: the app's entry
//  component through the renderer's own root view — the same minimal construction the
//  renderer's compile gate uses. Navigation, splash orchestration and the rest of the
//  production chrome are modules; write yours, or use the maintained catalog.
//

package host

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.remember
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.JSERunner
import despia.engine.render.DespiaSystemTheme
import despia.engine.render.StackRootView

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            DespiaSystemTheme {
                val root = remember { StackNode(ENTRY, emptyMap(), emptyList()) }
                val store = remember { StackStore() }
                val env = remember { JSERunner(store) }
                StackRootView(root, store, env)
            }
        }
    }

    private companion object {
        const val ENTRY = ${JSON.stringify(project.entry)}
    }
}
`;
}

function exportReadme(project: ExportProject, platform: "ios" | "android"): string {
  const open = platform === "ios"
    ? `open ${xcodeTargetName(project)}.xcodeproj in Xcode (or \`xcodebuild -project ${xcodeTargetName(project)}.xcodeproj -scheme ${xcodeTargetName(project)} -destination 'generic/platform=iOS' build\`)`
    : "open this folder in Android Studio (or `./gradlew :app:assembleDebug`)";
  return `# ${project.name} — native ${platform === "ios" ? "iOS" : "Android"} export

GENERATED by \`despia export ${platform}\`. This folder is BUILD OUTPUT
(reserved-directories.md): regenerate it after changes, never hand-edit it. Your sources of
truth stay in the project — \`Components/\`, \`Modules/\`, \`dsx.json\`, \`App.json\`.

- The open kernel is vendored ${platform === "ios" ? "into the app target (Kernel/)" : "as its own Gradle build (kernel/), composed by includeBuild"} — the build works offline, forever.
- Your modules' ${platform === "ios" ? "swift" : "kotlin"} lanes compile in; registration is generated the documented way.
- Your components ship byte-exact as ${platform === "ios" ? "bundle files (Resources/DSXComponents/)" : "assets (app/src/main/assets/components/)"}.
- First frame: the app's entry component through the kernel renderer. Navigation stacks,
  splash orchestration and the production module catalog are the commercial layer — or
  write your own modules; nothing in this export is withheld or stubbed.

Build: ${open}.
`;
}
