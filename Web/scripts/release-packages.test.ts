import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PACKAGE_SPECS,
  RELEASE_DIRS,
  TOOLING_DIRS,
  WebReleaseError,
  parseReleaseTag,
  validatePackageSet,
  validateSourceIdentity,
} from "./release-packages.ts";

type JsonRecord = Record<string, unknown>;

const script = resolve(dirname(fileURLToPath(import.meta.url)), "release-packages.ts");
const version = "1.2.3";
const tooling = new Set<string>(TOOLING_DIRS);

// npm pack derives the tarball name from the package name, so the unscoped create-dsx
// does not get a despia- prefix. Mirrored here so the fixture names files the way npm will.
function tarballName(dir: string): string {
  return `${PACKAGE_SPECS[dir]!.name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

function manifest(dir: string): JsonRecord {
  const spec = PACKAGE_SPECS[dir]!;
  const source = tooling.has(dir);
  const dependencies: Record<string, string> = {};
  if (dir !== "kernel") dependencies["@despia/kernel"] = version;
  const entry = source ? "./dist/src/index.js" : "./dist/index.js";
  return {
    name: spec.name,
    version,
    license: "Apache-2.0",
    type: "module",
    main: entry,
    exports: { ".": entry },
    files: [...spec.files].sort((left, right) => left.localeCompare(right)),
    publishConfig: { access: "public", provenance: true },
    dependencies,
  };
}

function packageFixture(): { manifests: Map<string, JsonRecord>; lock: JsonRecord } {
  const manifests = new Map<string, JsonRecord>();
  const packages: JsonRecord = { "": { name: "fixture", workspaces: ["packages/*"] } };
  for (const dir of RELEASE_DIRS) {
    const value = manifest(dir);
    manifests.set(dir, value);
    packages[`packages/${dir}`] = {
      name: value["name"],
      version,
      dependencies: value["dependencies"],
    };
    packages[`node_modules/${String(value["name"])}`] = { resolved: `packages/${dir}`, link: true };
  }
  return { manifests, lock: { lockfileVersion: 3, packages } };
}

function write(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function invoke(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function makeIntegrationFixture(): { root: string; output: string; commit: string } {
  const container = mkdtempSync(join(tmpdir(), "dsx-web-release-test-"));
  const root = join(container, "repo");
  const web = join(root, "OpenSource", "Web");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "web-release-test@despia.invalid");
  git(root, "config", "user.name", "DSX Web Release Test");
  git(root, "remote", "add", "origin", "https://github.com/despia-native/despia-framework.git");
  write(join(root, ".gitignore"), "dist/\nrelease-artifacts/\n");
  write(join(web, "package.json"), `${JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"], scripts: { build: "node -e \"\"" } }, null, 2)}\n`);
  const fixture = packageFixture();
  write(join(web, "package-lock.json"), `${JSON.stringify({ name: "fixture", ...fixture.lock }, null, 2)}\n`);
  for (const dir of RELEASE_DIRS) {
    write(join(web, "packages", dir, "package.json"), `${JSON.stringify(fixture.manifests.get(dir), null, 2)}\n`);
    write(join(web, "packages", dir, "README.md"), `# ${PACKAGE_SPECS[dir]!.name}\n`);
    write(join(web, "packages", dir, "LICENSE"), "Apache-2.0\n");
    if (tooling.has(dir)) {
      write(join(web, "packages", dir, "dist", "src", "index.js"), `export const packageName = ${JSON.stringify(dir)};\n`);
      if (dir !== "vite-plugin") write(join(web, "packages", dir, "dist", "bin", "run.js"), "// fixture\n");
    } else {
      write(join(web, "packages", dir, "dist", "index.js"), `export const packageName = ${JSON.stringify(dir)};\n`);
      if (dir === "dom") write(join(web, "packages", dir, "sw", "dsx-sw.js"), "// fixture\n");
    }
  }
  const components = RELEASE_DIRS.map((dir) => {
    const name = PACKAGE_SPECS[dir]!.name;
    return { type: "library", name, version, purl: `pkg:npm/${encodeURIComponent(name)}@${version}` };
  });
  write(
    join(root, "ClosedSource", "scripts", "generate_release_sbom.rb"),
    `require "json"\nout = ARGV.fetch(ARGV.index("--output") + 1)\ndoc = ${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, components })}\nFile.write(out, JSON.pretty_generate(doc) + "\\n")\n`,
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture release");
  git(root, "tag", "v1.2.3");
  return { root, output: join(container, "artifacts"), commit: git(root, "rev-parse", "HEAD") };
}

test("release tags are canonical stable semver only", () => {
  assert.equal(parseReleaseTag("v0.1.0"), "0.1.0");
  assert.equal(parseReleaseTag("v12.345.6789"), "12.345.6789");
  for (const value of ["1.2.3", "v01.2.3", "v1.02.3", "v1.2.03", "v1.2", "v1.2.3-rc.1", "v1.2.3+build", "v1.2.3\n", "v../../1.2.3"]) {
    assert.throws(() => parseReleaseTag(value), WebReleaseError, value);
  }
});

test("source identity rejects moved tags, tree drift, abbreviated CI ids, and credential URLs", () => {
  const oid = "a".repeat(40);
  const tree = "b".repeat(40);
  const base = {
    repository: "https://github.com/despia-native/despia-framework.git",
    commit: oid,
    tree,
    tagRef: "refs/tags/v1.2.3",
    tagObject: oid,
    tagObjectType: "commit" as const,
    tagCommit: oid,
    tagTree: tree,
  };
  assert.doesNotThrow(() => validateSourceIdentity(base, "v1.2.3", oid));
  assert.throws(() => validateSourceIdentity({ ...base, tagCommit: "c".repeat(40) }, "v1.2.3"), /does not resolve to HEAD/);
  assert.throws(() => validateSourceIdentity({ ...base, tagTree: "c".repeat(40) }, "v1.2.3"), /tag tree does not match/);
  assert.throws(() => validateSourceIdentity(base, "v1.2.3", "abc123"), /full Git object id/);
  assert.throws(() => validateSourceIdentity({ ...base, repository: "https://token@example.test/repo.git" }, "v1.2.3"), /must not embed credentials/);
  assert.throws(() => validateSourceIdentity({ ...base, repository: "file:///tmp/repo" }, "v1.2.3"), /safe HTTPS\/SSH/);
});

test("package set fails closed on version, visibility, internal selector, and lock drift", () => {
  assert.equal(validatePackageSet(packageFixture().manifests, packageFixture().lock, version).length, RELEASE_DIRS.length);

  // The tooling face must compile like the runtime face. Shipping raw src/ is not a style
  // choice: Node refuses type stripping inside node_modules, so such a package cannot run
  // on the machine that installs it.
  let shape = packageFixture();
  shape.manifests.get("create-dsx")!["files"] = ["LICENSE", "README.md", "src"];
  assert.throws(() => validatePackageSet(shape.manifests, shape.lock, version), /files allowlist/);

  shape = packageFixture();
  shape.manifests.get("create-dsx")!["name"] = "@despia/create-dsx";
  assert.throws(() => validatePackageSet(shape.manifests, shape.lock, version), /package name must be create-dsx/);

  let fixture = packageFixture();
  fixture.manifests.get("kernel")!["version"] = "1.2.4";
  assert.throws(() => validatePackageSet(fixture.manifests, fixture.lock, version), /version must equal release tag/);

  fixture = packageFixture();
  fixture.manifests.get("kernel")!["private"] = true;
  assert.throws(() => validatePackageSet(fixture.manifests, fixture.lock, version), /must not be private/);

  fixture = packageFixture();
  (fixture.manifests.get("dom")!["dependencies"] as JsonRecord)["@despia/kernel"] = "^1.2.3";
  assert.throws(() => validatePackageSet(fixture.manifests, fixture.lock, version), /pinned exactly/);

  fixture = packageFixture();
  (fixture.lock["packages"] as JsonRecord)["packages/extra"] = { name: "@despia/extra", version };
  assert.throws(() => validatePackageSet(fixture.manifests, fixture.lock, version), /workspace set/);

  fixture = packageFixture();
  ((fixture.lock["packages"] as JsonRecord)["packages/dom"] as JsonRecord)["version"] = "9.9.9";
  assert.throws(() => validatePackageSet(fixture.manifests, fixture.lock, version), /identity\/version/);
});

test("build preserves and verify rechecks exact tarballs, SBOM, hashes, and provenance", { timeout: 60_000 }, () => {
  const fixture = makeIntegrationFixture();
  const common = ["--root", fixture.root, "--tag", "v1.2.3", "--output", fixture.output, "--expected-commit", fixture.commit];
  const built = invoke(["build", ...common]);
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const verified = invoke(["verify", ...common]);
  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);

  const provenance = JSON.parse(readFileSync(join(fixture.output, "provenance.json"), "utf8")) as JsonRecord;
  assert.equal((provenance["source"] as JsonRecord)["commit"], fixture.commit);
  assert.equal((provenance["source"] as JsonRecord)["tree"], git(fixture.root, "rev-parse", "HEAD^{tree}"));
  assert.equal((provenance["builder"] as JsonRecord)["publishing"], false);
  assert.equal((provenance["artifacts"] as unknown[]).length, RELEASE_DIRS.length);
  const artifactNames = new Set((provenance["artifacts"] as JsonRecord[]).map((entry) => String(entry["file"] ?? entry["name"] ?? "")));
  assert.ok(artifactNames.has(tarballName("create-dsx")), `unscoped tarball name missing: ${[...artifactNames].join(", ")}`);

  const tarball = join(fixture.output, tarballName("kernel"));
  const original = readFileSync(tarball);
  writeFileSync(tarball, Buffer.concat([original, Buffer.from("tamper")]));
  const tampered = invoke(["verify", ...common]);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /hash\/size\/integrity|SHA-256 mismatch/);

  writeFileSync(tarball, original);
  write(join(fixture.output, "unexpected.txt"), "not admitted\n");
  const extra = invoke(["verify", ...common]);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /unexpected or missing file/);
});

test("CLI refuses dirty source and a tag that does not resolve to HEAD", () => {
  let fixture = makeIntegrationFixture();
  write(join(fixture.root, "dirty.txt"), "dirty\n");
  let result = invoke(["build", "--root", fixture.root, "--tag", "v1.2.3", "--output", fixture.output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release checkout has/);

  fixture = makeIntegrationFixture();
  write(join(fixture.root, "later.txt"), "later\n");
  git(fixture.root, "add", "later.txt");
  git(fixture.root, "commit", "-qm", "later commit");
  result = invoke(["build", "--root", fixture.root, "--tag", "v1.2.3", "--output", fixture.output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not resolve to HEAD/);
});
