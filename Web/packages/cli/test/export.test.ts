//
//  export.test.ts — `despia export` produces REAL native projects, proven structurally where
//  this environment cannot compile them (Swift and the Android SDK are CI's job; the
//  platform lanes carry the compile smokes). What IS provable here, is proven here:
//    · the model reads the user's Modules/ folder (manifest, lanes incl. legacy aliases,
//      the Module-subclass scan with its ambiguity refusal),
//    · both exports are BYTE-DETERMINISTIC (an export is diffable build output),
//    · the Xcode project is self-consistent: every path the pbxproj references exists on
//      disk, every compiled source is in the Sources phase, the shared scheme points at
//      the target, and the generated tables carry the module scheme,
//    · the Android project composes the vendored kernel with the same substitutions the
//      framework's own runtime uses, pins the SAME plugin versions the kernel pins, and
//      the generated Application registers exactly the scanned module classes,
//    · components land byte-exact as bundle files / assets under their scopes,
//    · kernel resolution fails with the one clone command when nothing qualifies.
//

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { exportAndroid, exportIos, kernelGradleVersions, readExportProject, resolveKernel, ExportError } from "../src/export.ts";
import { runCli, type Io } from "../src/cli.ts";

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

const BADGE_SWIFT = `import UIKit

class Badge: Module {
    override var scheme: String { "badge" }
}
`;

const BADGE_KOTLIN = `package com.example.badge

import despia.engine.Module

class Badge : Module() {
    override val scheme: String get() = "badge"
}
`;

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-export-"));
  const files: { [path: string]: string } = {
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix", version: "0.1.0" }),
    "dsx.config.json": JSON.stringify({ name: "Field Test", entry: "App" }),
    "Components/App.dsx": `<stack><text value="hello"/></stack>\n`,
    "Components/Card.dsx": `<stack><slot/></stack>\n`,
    "Modules/Badge/dsx.json": JSON.stringify({ name: "Badge", scheme: "badge", version: "1.0.0" }),
    "Modules/Badge/config.json": JSON.stringify({ max_count: { value: 99 }, label: { value: "unread" } }),
    "Modules/Badge/swift/Badge.swift": BADGE_SWIFT,
    "Modules/Badge/kotlin/Badge.kt": BADGE_KOTLIN,
    "Modules/Badge/Components/BadgePill.dsx": `<stack><text value="{{ dsx.attribute.count }}"/></stack>\n`,
    // a hook-only module with the LEGACY lane alias — scheme-less, ios/ instead of swift/
    "Modules/Hooks/dsx.json": JSON.stringify({ name: "Hooks", version: "1.0.0" }),
    "Modules/Hooks/ios/Hooks.swift": `class Hooks: Module {}\n`,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

/** Snapshot a tree as path → bytes, for the determinism comparison. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const abs = join(at, name);
      const key = rel === "" ? name : `${rel}/${name}`;
      if (statSync(abs).isDirectory()) walk(abs, key);
      else out.set(key, readFileSync(abs, "latin1"));
    }
  };
  walk(dir, "");
  return out;
}

test("export: the project model reads modules, lanes (incl. legacy aliases), classes, components", () => {
  const fx = fixture();
  try {
    const project = readExportProject(loadConfig(fx.root));
    assert.equal(project.scheme, "fix");
    assert.deepEqual(project.components.map((c) => c.name), ["App", "Card"]);
    const badge = project.modules.find((m) => m.name === "Badge")!;
    assert.equal(badge.scheme, "badge");
    assert.equal(badge.swiftClass, "Badge");
    assert.equal(badge.kotlinClass, "com.example.badge.Badge");
    assert.deepEqual(badge.components.map((c) => c.name), ["BadgePill"]);
    assert.deepEqual(badge.config, { max_count: 99, label: "unread" });
    const hooks = project.modules.find((m) => m.name === "Hooks")!;
    assert.equal(hooks.scheme, "");
    assert.ok(hooks.swiftLane!.endsWith("ios"), "the legacy ios/ lane alias resolves");
  } finally {
    fx.cleanup();
  }
});

test("export: two Module subclasses in one lane refuse with the fix named", () => {
  const fx = fixture();
  try {
    // A second subclass next to one carrying the module's own name: the convention decides.
    writeFileSync(join(fx.root, "Modules", "Badge", "swift", "Extra.swift"), "class Extra: Module {}\n");
    assert.equal(readExportProject(loadConfig(fx.root)).modules.find((m) => m.name === "Badge")!.swiftClass, "Badge");
    // Neither carries it: refuse, naming the candidates and the fix.
    writeFileSync(join(fx.root, "Modules", "Badge", "swift", "Badge.swift"), "class Renamed: Module {}\n");
    assert.throws(() => readExportProject(loadConfig(fx.root)), /2 Module subclasses.*name one after the module folder/);
  } finally {
    fx.cleanup();
  }
});

test("export ios: a self-consistent Xcode project — every reference exists, every source compiles", () => {
  const fx = fixture();
  try {
    const project = readExportProject(loadConfig(fx.root));
    const out = exportIos(project);
    const pbx = readFileSync(join(out, "FieldTest.xcodeproj", "project.pbxproj"), "utf8");

    // every path the project file references exists on disk
    for (const m of pbx.matchAll(/path = "([^"]+)";/g)) {
      const p = m[1]!;
      if (p.endsWith(".app")) continue; // the build product
      assert.ok(existsSync(join(out, p)), `pbxproj references missing ${p}`);
    }
    // the kernel came along, the conformance host did not
    assert.ok(existsSync(join(out, "Kernel", "Module.swift")));
    assert.ok(existsSync(join(out, "Kernel", "DSXBoot.swift")));
    assert.equal(existsSync(join(out, "Kernel", "ConformanceHosts.swift")), false);
    // the module lane and BOTH generated host halves are in the Sources phase
    for (const name of ["Badge.swift", "AppDelegate.swift", "GeneratedTables.swift", "DSXObjCException.m"]) {
      assert.ok(pbx.includes(`${name} in Sources`), `${name} missing from the Sources phase`);
    }
    // the shared scheme exists and points at the target
    const scheme = readFileSync(join(out, "FieldTest.xcodeproj", "xcshareddata", "xcschemes", "FieldTest.xcscheme"), "utf8");
    assert.ok(scheme.includes('BuildableName="FieldTest.app"'));
    // the generated tables bind the scanned class to the manifest scheme
    const tables = readFileSync(join(out, "App", "GeneratedTables.swift"), "utf8");
    assert.ok(tables.includes('"Badge": "badge"'));
    assert.ok(tables.includes('KernelTables.configByScheme["badge"]'));
    // components ship byte-exact under their scopes; project components under the project scheme
    assert.equal(readFileSync(join(out, "Resources", "DSXComponents", "fix", "App.dsx"), "utf8"), `<stack><text value="hello"/></stack>\n`);
    assert.ok(existsSync(join(out, "Resources", "DSXComponents", "badge", "BadgePill.dsx")));
    // identity + engine resources
    assert.ok(existsSync(join(out, "Resources", "App.json")));
    assert.ok(existsSync(join(out, "Resources", "EngineConfig.json")));
    assert.ok(existsSync(join(out, "Resources", "runtime.js")));
    const appJson = JSON.parse(readFileSync(join(out, "Resources", "App.json"), "utf8")) as { entry: { surfaces: string[] } };
    assert.deepEqual(appJson.entry.surfaces, ["fix.App"]);
  } finally {
    fx.cleanup();
  }
});

test("export android: the composite build pins the kernel's own plugin versions and registers the module", () => {
  const fx = fixture();
  try {
    const project = readExportProject(loadConfig(fx.root));
    const out = exportAndroid(project);
    const kernel = resolveKernel();
    const versions = kernelGradleVersions(kernel);

    const settings = readFileSync(join(out, "settings.gradle.kts"), "utf8");
    assert.ok(settings.includes('includeBuild("kernel/Android")'));
    for (const mod of ["core", "platform", "render"]) {
      assert.ok(settings.includes(`dev.despia.engine:${mod}`), `substitution for :${mod}`);
    }
    assert.ok(existsSync(join(out, "kernel", "Android", "settings.gradle.kts")), "the kernel build is vendored in checkout shape");
    assert.ok(existsSync(join(out, "kernel", "VERSION")), "the kernel's one-version file resolves from :core");
    assert.equal(existsSync(join(out, "kernel", "Android", "desktop")), false, "the desktop lane stays behind (monorepo machinery)");
    assert.ok(existsSync(join(out, "gradlew")), "the wrapper rides along");

    const rootBuild = readFileSync(join(out, "build.gradle.kts"), "utf8");
    assert.ok(rootBuild.includes(`version "${versions.kotlin}"`), "Kotlin pinned to the kernel's version");
    assert.ok(rootBuild.includes(`version "${versions.agp}"`) || rootBuild.includes(`"com.android.application") version "${versions.agp}"`), "AGP pinned to the kernel's version");

    const appBuild = readFileSync(join(out, "app", "build.gradle.kts"), "utf8");
    assert.ok(appBuild.includes(`androidx.compose:compose-bom:${versions.composeBom}`), "Compose BOM pinned to the kernel's (:render)");
    assert.ok(appBuild.includes(`androidx.activity:activity-compose:${versions.activityCompose}`), "activity-compose pinned to the kernel's");
    assert.ok(!appBuild.includes("kotlinOptions"), "Kotlin 2.x: compilerOptions DSL, never kotlinOptions");

    const app = readFileSync(join(out, "app", "src", "main", "kotlin", "host", "DespiaApp.kt"), "utf8");
    assert.ok(app.includes('"badge" to { com.example.badge.Badge() }'), "the scanned factory registers by scheme");
    assert.ok(app.includes('"Badge" to "badge"'), "simple class name binds the scheme (javaClass.simpleName)");
    assert.ok(app.includes("ComposeStackComponents.defineNode"), "components register through the renderer's own API");

    assert.ok(existsSync(join(out, "app", "src", "main", "kotlin", "modules", "badge", "Badge.kt")), "the kotlin lane joins the app source set");
    assert.equal(
      readFileSync(join(out, "app", "src", "main", "assets", "components", "fix", "App.dsx"), "utf8"),
      `<stack><text value="hello"/></stack>\n`,
    );
    assert.ok(existsSync(join(out, "app", "src", "main", "assets", "App.json")));
    assert.ok(existsSync(join(out, "app", "src", "main", "assets", "EngineConfig.json")));
    const manifest = readFileSync(join(out, "app", "src", "main", "AndroidManifest.xml"), "utf8");
    assert.ok(manifest.includes('android:name=".DespiaApp"'));
    assert.ok(manifest.includes('android:name=".MainActivity"'));
    const activity = readFileSync(join(out, "app", "src", "main", "kotlin", "host", "MainActivity.kt"), "utf8");
    assert.ok(activity.includes('const val ENTRY = "fix.App"'));
    assert.ok(activity.includes("StackRootView(root, store, env)"));
  } finally {
    fx.cleanup();
  }
});

test("export: byte-deterministic — export twice, identical trees (diffable build output)", () => {
  const fx = fixture();
  try {
    const project = readExportProject(loadConfig(fx.root));
    const iosFirst = snapshot(exportIos(project));
    const iosSecond = snapshot(exportIos(project));
    assert.deepEqual([...iosSecond.keys()], [...iosFirst.keys()]);
    for (const [path, bytes] of iosFirst) assert.equal(iosSecond.get(path), bytes, `ios ${path} differs across exports`);
    const droidFirst = snapshot(exportAndroid(project));
    const droidSecond = snapshot(exportAndroid(project));
    assert.deepEqual([...droidSecond.keys()], [...droidFirst.keys()]);
    for (const [path, bytes] of droidFirst) assert.equal(droidSecond.get(path), bytes, `android ${path} differs across exports`);
  } finally {
    fx.cleanup();
  }
});

test("export: no kernel anywhere names the one clone command", () => {
  const fx = fixture();
  try {
    assert.throws(
      () => resolveKernel(join(fx.root, "nowhere")),
      (e: unknown) => e instanceof ExportError && e.message.includes("git clone https://github.com/despia-native/despia-kernel"),
    );
  } finally {
    fx.cleanup();
  }
});

test("export: the CLI surface — export all runs both, unknown platform refused", async () => {
  const fx = fixture();
  try {
    const io = capture();
    const code = await runCli(["export", "all", "--project", fx.root, "--bundle-id", "com.fixture.app"], io);
    assert.equal(code, 0, io.errors.join("\n"));
    assert.ok(io.lines.some((l) => l.includes("[despia export] ios")));
    assert.ok(io.lines.some((l) => l.includes("[despia export] android")));
    assert.ok(readFileSync(join(fx.root, "export", "android", "app", "build.gradle.kts"), "utf8").includes('applicationId = "com.fixture.app"'));
    const bad = capture();
    assert.equal(await runCli(["export", "windows", "--project", fx.root], bad), 1);
    assert.ok(bad.errors.some((l) => l.includes("ios | android | all")));
  } finally {
    fx.cleanup();
  }
});
