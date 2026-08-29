#!/usr/bin/env node

// Build and independently verify the exact, non-published npm package set for a
// release tag. The output is deliberately registry-neutral: five tarballs, a
// deterministic source SBOM, SHA-256 sums, and a provenance manifest binding the
// artifacts to the immutable Git commit/tree/tag. No credentials are read and no
// publish command exists in this file.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The RUNTIME face: compiled, dist-shipping, what an application imports.
export const PACKAGE_DIRS = ["kernel", "compiler", "dom", "element", "server"] as const;
// The TOOLING face: what a developer runs before an application exists. It compiles to
// dist like the runtime face — Node's native type stripping is REFUSED inside
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a package that ships
// raw .ts is unrunnable for the consumer even on Node 22.18. `create-dsx` is
// deliberately unscoped because `npm create dsx` resolves exactly that name.
export const TOOLING_DIRS = ["cli", "create-dsx", "vite-plugin"] as const;
export const RELEASE_DIRS = [...PACKAGE_DIRS, ...TOOLING_DIRS] as const;

// One table, so a package's published shape is declared rather than inferred from its
// directory name in four places.
export const PACKAGE_SPECS: Record<string, { name: string; files: string[] }> = {
  kernel: { name: "@despia/kernel", files: ["LICENSE", "README.md", "dist"] },
  compiler: { name: "@despia/compiler", files: ["LICENSE", "README.md", "dist"] },
  dom: { name: "@despia/dom", files: ["LICENSE", "README.md", "dist", "sw"] },
  element: { name: "@despia/element", files: ["LICENSE", "README.md", "dist"] },
  server: { name: "@despia/server", files: ["LICENSE", "README.md", "dist"] },
  // The cli ships its own `<cli>` document inside dist/ (the build copies it next to the
  // compiled output), so the file set is unchanged — the command surface travels with the
  // code that reads it rather than as a second shipped directory.
  cli: { name: "@despia/cli", files: ["LICENSE", "README.md", "dist"] },
  "create-dsx": { name: "create-despia", files: ["LICENSE", "README.md", "dist"] },  // dir stays create-dsx; the published name is the brand
  "vite-plugin": { name: "@despia/vite-plugin", files: ["LICENSE", "README.md", "dist"] },
};

const TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const CONFLICT_COPY_PATH = /(?:^|\/)[^/]+ 2(?:\.[^/]*)?$/;
const GIT_ENVIRONMENT_TO_CLEAR = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_NAMESPACE", "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE", "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS",
] as const;

type JsonRecord = Record<string, unknown>;

export interface PackageIdentity {
  dir: string;
  name: string;
  version: string;
  manifest: JsonRecord;
}

export interface SourceIdentity {
  repository: string;
  commit: string;
  tree: string;
  tagRef: string;
  tagObject: string;
  tagObjectType: "commit" | "tag";
  tagCommit: string;
  tagTree: string;
}

interface ArtifactRecord {
  package: string;
  version: string;
  file: string;
  bytes: number;
  sha256: string;
  npmIntegrity: string;
}

interface Options {
  mode: "build" | "verify";
  root: string;
  tag: string;
  output: string;
  expectedCommit?: string;
}

export class WebReleaseError extends Error {
  constructor(message: string) {
    super(`[web-release] ${message}`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new WebReleaseError(`${label} must be a JSON object`);
  return value;
}

function readJson(path: string, label: string): JsonRecord {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new WebReleaseError(`${label} must be a regular file: ${path}`);
  }
  if (status.size > MAX_JSON_BYTES) throw new WebReleaseError(`${label} is unexpectedly large: ${path}`);
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown, label);
  } catch (error) {
    if (error instanceof WebReleaseError) throw error;
    throw new WebReleaseError(`${label} is invalid JSON: ${path}`);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha512Integrity(path: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function run(command: string, args: string[], cwd: string, environment?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: environment ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    const detail = String(failure.stderr ?? failure.stdout ?? "").trim();
    throw new WebReleaseError(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ` (exit ${String(failure.status)})`}`);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of GIT_ENVIRONMENT_TO_CLEAR) delete environment[name];
  return environment;
}

function git(root: string, ...args: string[]): string {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  return run(executable, ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], root, gitEnvironment());
}

export function parseReleaseTag(tag: string): string {
  const match = TAG_PATTERN.exec(tag);
  if (match === null) {
    throw new WebReleaseError(`release tag must be exactly vMAJOR.MINOR.PATCH: ${JSON.stringify(tag)}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function validateRepositoryUrl(value: string): string {
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebReleaseError("origin URL is not a safe HTTPS/SSH repository identity");
  }
  if (!new Set(["https:", "ssh:"]).has(parsed.protocol) || parsed.password || parsed.search || parsed.hash) {
    throw new WebReleaseError("origin URL is not a safe HTTPS/SSH repository identity");
  }
  if (parsed.protocol === "https:" && parsed.username) {
    throw new WebReleaseError("origin URL must not embed credentials");
  }
  if (parsed.protocol === "ssh:" && parsed.username && parsed.username !== "git") {
    throw new WebReleaseError("origin SSH URL has an unexpected user");
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new WebReleaseError("origin URL is incomplete");
  }
  return value;
}

export function validateSourceIdentity(values: SourceIdentity, tag: string, expectedCommit?: string): void {
  parseReleaseTag(tag);
  for (const [label, value] of Object.entries({
    commit: values.commit,
    tree: values.tree,
    tagObject: values.tagObject,
    tagCommit: values.tagCommit,
    tagTree: values.tagTree,
  })) {
    if (!OID_PATTERN.test(value)) throw new WebReleaseError(`${label} is not a full Git object id`);
  }
  if (values.tagRef !== `refs/tags/${tag}`) throw new WebReleaseError("tag ref does not match the requested release tag");
  if (values.tagObjectType !== "tag" && values.tagObjectType !== "commit") {
    throw new WebReleaseError("release ref is neither an annotated nor lightweight Git tag");
  }
  if (values.tagCommit !== values.commit) throw new WebReleaseError("release tag does not resolve to HEAD");
  if (values.tagTree !== values.tree) throw new WebReleaseError("release tag tree does not match HEAD tree");
  if (expectedCommit !== undefined) {
    if (!OID_PATTERN.test(expectedCommit)) throw new WebReleaseError("expected commit must be a full Git object id");
    if (expectedCommit.toLowerCase() !== values.commit.toLowerCase()) {
      throw new WebReleaseError("CI expected commit does not match HEAD");
    }
  }
  validateRepositoryUrl(values.repository);
}

function assertCleanCheckout(root: string): void {
  const dirty = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  if (dirty.length > 0) throw new WebReleaseError("release checkout has staged, unstaged, or untracked non-ignored files");
}

function sourceIdentity(root: string, tag: string, expectedCommit?: string): SourceIdentity {
  const top = realpathSync(git(root, "rev-parse", "--show-toplevel"));
  if (top !== realpathSync(root)) throw new WebReleaseError(`--root is not the Git top level: ${root}`);
  const tagRef = `refs/tags/${tag}`;
  const tagObjectType = git(root, "cat-file", "-t", tagRef);
  const identity: SourceIdentity = {
    repository: validateRepositoryUrl(git(root, "remote", "get-url", "origin")),
    commit: git(root, "rev-parse", "--verify", "HEAD"),
    tree: git(root, "rev-parse", "--verify", "HEAD^{tree}"),
    tagRef,
    tagObject: git(root, "rev-parse", "--verify", tagRef),
    tagObjectType: tagObjectType as "commit" | "tag",
    tagCommit: git(root, "rev-parse", "--verify", `${tagRef}^{commit}`),
    tagTree: git(root, "rev-parse", "--verify", `${tagRef}^{tree}`),
  };
  validateSourceIdentity(identity, tag, expectedCommit);
  assertCleanCheckout(root);
  return identity;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value, label);
  const output: Record<string, string> = {};
  for (const [name, version] of Object.entries(record)) {
    if (typeof version !== "string") throw new WebReleaseError(`${label}.${name} must be a string`);
    output[name] = version;
  }
  return output;
}

export function validatePackageSet(manifests: Map<string, JsonRecord>, lock: JsonRecord, version: string): PackageIdentity[] {
  const expectedDirs = new Set<string>(RELEASE_DIRS);
  if (manifests.size !== expectedDirs.size || [...manifests.keys()].some((dir) => !expectedDirs.has(dir))) {
    throw new WebReleaseError(`release package set must contain exactly ${RELEASE_DIRS.join(", ")}`);
  }
  const identities: PackageIdentity[] = [];
  const expectedNames = new Set(RELEASE_DIRS.map((dir) => PACKAGE_SPECS[dir]!.name));
  for (const dir of RELEASE_DIRS) {
    const manifest = manifests.get(dir);
    if (manifest === undefined) throw new WebReleaseError(`missing package manifest for ${dir}`);
    const spec = PACKAGE_SPECS[dir]!;
    const name = manifest["name"];
    if (name !== spec.name) throw new WebReleaseError(`${dir} package name must be ${spec.name}`);
    if (manifest["version"] !== version) throw new WebReleaseError(`${String(name)} version must equal release tag version ${version}`);
    if (manifest["private"] === true) throw new WebReleaseError(`${String(name)} must not be private`);
    if (manifest["license"] !== "Apache-2.0") throw new WebReleaseError(`${String(name)} must declare the Apache-2.0 license`);
    const publish = asRecord(manifest["publishConfig"], `${String(name)} publishConfig`);
    if (publish["access"] !== "public" || publish["provenance"] !== true) {
      throw new WebReleaseError(`${String(name)} must require public npm provenance publishing`);
    }
    const expectedFiles = spec.files;
    const files = Array.isArray(manifest["files"]) ? manifest["files"] : [];
    if (files.some((entry) => typeof entry !== "string") || JSON.stringify([...files].sort()) !== JSON.stringify(expectedFiles)) {
      throw new WebReleaseError(`${String(name)} files allowlist is not the release contract`);
    }
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      for (const [dependency, selector] of Object.entries(stringMap(manifest[section], `${String(name)} ${section}`))) {
        if (dependency.startsWith("@despia/")) {
          if (!expectedNames.has(dependency)) throw new WebReleaseError(`${String(name)} references unknown internal package ${dependency}`);
          if (selector !== version) throw new WebReleaseError(`${String(name)} ${dependency} must be pinned exactly to ${version}`);
        }
      }
    }
    identities.push({ dir, name: String(name), version, manifest });
  }

  if (lock["lockfileVersion"] !== 3) throw new WebReleaseError("package-lock.json must use lockfileVersion 3");
  const packages = asRecord(lock["packages"], "package-lock packages");
  const workspaceEntries = Object.keys(packages).filter((key) => key.startsWith("packages/"));
  const expectedWorkspaceEntries = RELEASE_DIRS.map((dir) => `packages/${dir}`).sort();
  if (JSON.stringify(workspaceEntries.sort()) !== JSON.stringify(expectedWorkspaceEntries)) {
    throw new WebReleaseError("package-lock workspace set does not exactly match the release package set");
  }
  for (const identity of identities) {
    const path = `packages/${identity.dir}`;
    const entry = asRecord(packages[path], `package-lock ${path}`);
    if (entry["name"] !== identity.name || entry["version"] !== version) {
      throw new WebReleaseError(`package-lock ${path} identity/version does not match ${identity.name}@${version}`);
    }
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, selector] of Object.entries(stringMap(entry[section], `package-lock ${path} ${section}`))) {
        if (dependency.startsWith("@despia/") && selector !== version) {
          throw new WebReleaseError(`package-lock ${path} ${dependency} must be pinned exactly to ${version}`);
        }
      }
    }
    const link = asRecord(packages[`node_modules/${identity.name}`], `package-lock link for ${identity.name}`);
    if (link["link"] !== true || link["resolved"] !== path) {
      throw new WebReleaseError(`package-lock link for ${identity.name} does not resolve to ${path}`);
    }
  }
  return identities.sort((left, right) => left.name.localeCompare(right.name));
}

function loadPackageSet(root: string, version: string): { identities: PackageIdentity[]; lockPath: string } {
  const web = join(root, "OpenSource", "Web");
  const manifests = new Map<string, JsonRecord>();
  for (const dir of RELEASE_DIRS) {
    manifests.set(dir, readJson(join(web, "packages", dir, "package.json"), `${dir} package.json`));
  }
  const lockPath = join(web, "package-lock.json");
  const lock = readJson(lockPath, "package-lock.json");
  return { identities: validatePackageSet(manifests, lock, version), lockPath };
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(exportTargets);
}

function expectedTarball(identity: PackageIdentity): string {
  // npm pack derives the filename from the NAME, not the directory: @despia/dom ->
  // despia-dom-<v>.tgz, and the unscoped create-despia -> create-despia-<v>.tgz.
  const slug = identity.name.replace(/^@/, "").replace(/\//g, "-");
  return `${slug}-${identity.version}.tgz`;
}

function inspectTarball(path: string, identity: PackageIdentity, root: string): void {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new WebReleaseError(`tarball must be a regular file: ${basename(path)}`);
  if (status.size <= 0 || status.size > MAX_TARBALL_BYTES) throw new WebReleaseError(`tarball size is outside the release limit: ${basename(path)}`);
  const entries = run("tar", ["-tzf", path], root).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || new Set(entries).size !== entries.length) throw new WebReleaseError(`${basename(path)} has an empty/duplicate archive inventory`);
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..") || !entry.startsWith("package/")) {
      throw new WebReleaseError(`${basename(path)} has an unsafe archive path: ${entry}`);
    }
    if (CONFLICT_COPY_PATH.test(entry)) throw new WebReleaseError(`${basename(path)} contains a Finder conflict-copy path: ${entry}`);
  }
  const verbose = run("tar", ["-tvzf", path], root).split(/\r?\n/).filter(Boolean);
  if (verbose.some((line) => line[0] !== "-" && line[0] !== "d")) {
    throw new WebReleaseError(`${basename(path)} contains a link or unsupported archive entry type`);
  }
  const files = entries.filter((entry) => !entry.endsWith("/"));
  // The payload is whatever the package DECLARED, so a dist-shipping runtime package and a
  // source-shipping tooling package are each held to their own shape rather than to one
  // hardcoded "dist". An empty payload still fails: a metadata-only tarball is not a release.
  const payloadRoots = PACKAGE_SPECS[identity.dir]!.files
    .filter((entry) => entry !== "LICENSE" && entry !== "README.md")
    .map((entry) => `package/${entry}/`);
  if (!files.some((entry) => payloadRoots.some((root) => entry.startsWith(root)))) {
    throw new WebReleaseError(`${basename(path)} has no payload under ${payloadRoots.join(", ")}`);
  }
  for (const entry of files) {
    const allowed = entry === "package/package.json" || entry === "package/README.md" || entry === "package/LICENSE" ||
      payloadRoots.some((root) => entry.startsWith(root));
    if (!allowed) throw new WebReleaseError(`${basename(path)} leaked file outside its declared set: ${entry}`);
  }
  const packed = asRecord(JSON.parse(run("tar", ["-xOzf", path, "package/package.json"], root)) as unknown, "packed package.json");
  if (packed["name"] !== identity.name || packed["version"] !== identity.version || packed["private"] === true) {
    throw new WebReleaseError(`${basename(path)} embeds the wrong package identity/version`);
  }
  const available = new Set(files.map((entry) => `./${entry.replace(/^package\//, "")}`));
  for (const target of exportTargets(packed["exports"])) {
    if (!available.has(target)) throw new WebReleaseError(`${basename(path)} export target ${target} is absent`);
  }
}

function validateSbom(sbom: JsonRecord, identities: PackageIdentity[]): void {
  if (sbom["bomFormat"] !== "CycloneDX" || sbom["specVersion"] !== "1.5" || sbom["version"] !== 1) {
    throw new WebReleaseError("source SBOM is not CycloneDX 1.5 version 1");
  }
  if (!Array.isArray(sbom["components"]) || sbom["components"].length === 0) {
    throw new WebReleaseError("source SBOM has no components");
  }
  for (const identity of identities) {
    const matches = sbom["components"].filter((entry) => isRecord(entry) && entry["name"] === identity.name);
    if (matches.length !== 1 || matches[0]?.["version"] !== identity.version ||
        typeof matches[0]?.["purl"] !== "string" || !String(matches[0]?.["purl"]).startsWith("pkg:npm/")) {
      throw new WebReleaseError(`source SBOM does not contain exactly one ${identity.name}@${identity.version} component`);
    }
  }
}

function packageWithNpm(root: string, stage: string, identity: PackageIdentity): ArtifactRecord {
  const web = join(root, "OpenSource", "Web");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const raw = run(npm, ["pack", join(web, "packages", identity.dir), "--json", "--ignore-scripts", "--pack-destination", stage], web);
  let result: unknown;
  try {
    result = JSON.parse(raw) as unknown;
  } catch {
    throw new WebReleaseError(`npm pack did not return JSON for ${identity.name}`);
  }
  if (!Array.isArray(result) || result.length !== 1 || !isRecord(result[0])) {
    throw new WebReleaseError(`npm pack returned an unexpected result for ${identity.name}`);
  }
  const filename = result[0]["filename"];
  const integrity = result[0]["integrity"];
  if (filename !== expectedTarball(identity) || basename(String(filename)) !== filename || !SAFE_FILE.test(String(filename))) {
    throw new WebReleaseError(`npm pack returned an unsafe/unexpected filename for ${identity.name}`);
  }
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new WebReleaseError(`npm pack did not report SHA-512 integrity for ${identity.name}`);
  }
  const path = join(stage, filename);
  inspectTarball(path, identity, root);
  if (sha512Integrity(path) !== integrity) throw new WebReleaseError(`npm SHA-512 integrity mismatch for ${identity.name}`);
  return {
    package: identity.name,
    version: identity.version,
    file: filename,
    bytes: statSync(path).size,
    sha256: sha256File(path),
    npmIntegrity: integrity,
  };
}

function relativeInside(root: string, target: string): string | undefined {
  const value = relative(root, target);
  if (value === "" || value === ".") return "";
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined;
  return value;
}

function assertSafeOutput(root: string, output: string): void {
  if (existsSync(output)) throw new WebReleaseError(`output already exists; refusing to mix release artifacts: ${output}`);
  const inside = relativeInside(root, output);
  if (inside !== undefined) {
    try {
      git(root, "check-ignore", "--no-index", "--quiet", "--", inside);
    } catch {
      throw new WebReleaseError("an output inside the repository must be covered by .gitignore");
    }
  }
}

function writeSha256Sums(stage: string, names: string[]): void {
  const sorted = [...names].sort();
  const lines = sorted.map((name) => `${sha256File(join(stage, name))}  ${name}`);
  writeFileSync(join(stage, "SHA256SUMS"), `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
}

function npmVersion(root: string): string {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npm, ["--version"], root);
}

export function buildRelease(options: Options): void {
  const version = parseReleaseTag(options.tag);
  const root = resolve(options.root);
  const output = resolve(options.output);
  const identity = sourceIdentity(root, options.tag, options.expectedCommit);
  const { identities, lockPath } = loadPackageSet(root, version);
  assertSafeOutput(root, output);

  const web = join(root, "OpenSource", "Web");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["run", "build"], web);
  assertCleanCheckout(root);

  mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
  const stage = mkdtempSync(join(dirname(output), `.${basename(output)}.tmp-`));
  let installed = false;
  try {
    const artifacts = identities.map((entry) => packageWithNpm(root, stage, entry));
    const sbomFile = "dsx-web-source-sbom.cdx.json";
    const sbomGenerator = join(root, "ClosedSource", "scripts", "generate_release_sbom.rb");
    const generatorStatus = lstatSync(sbomGenerator);
    if (!generatorStatus.isFile() || generatorStatus.isSymbolicLink()) throw new WebReleaseError("SBOM generator must be a regular source file");
    run("ruby", [sbomGenerator, "--output", join(stage, sbomFile)], root);
    validateSbom(readJson(join(stage, sbomFile), "source SBOM"), identities);
    assertCleanCheckout(root);

    const provenanceFile = "provenance.json";
    const provenance = {
      schemaVersion: 1,
      kind: "dsx.web-package-release",
      release: { tag: options.tag, version },
      source: identity,
      materials: {
        packageLock: { path: "OpenSource/Web/package-lock.json", sha256: sha256File(lockPath) },
        sbomGenerator: { path: "ClosedSource/scripts/generate_release_sbom.rb", sha256: sha256File(sbomGenerator) },
      },
      builder: { node: process.version, npm: npmVersion(root), publishing: false },
      artifacts,
      sbom: { file: sbomFile, sha256: sha256File(join(stage, sbomFile)), format: "CycloneDX", specVersion: "1.5" },
    };
    writeFileSync(join(stage, provenanceFile), `${JSON.stringify(provenance, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    writeSha256Sums(stage, [...artifacts.map((artifact) => artifact.file), sbomFile, provenanceFile]);
    verifyReleaseDirectory({ ...options, output: stage });
    renameSync(stage, output);
    installed = true;
    console.log(`[web-release] PASS: preserved ${artifacts.length} npm tarballs for ${options.tag} at ${output}`);
  } finally {
    if (!installed && existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

function parseSha256Sums(path: string): Map<string, string> {
  const text = readFileSync(path, "utf8");
  if (!text.endsWith("\n")) throw new WebReleaseError("SHA256SUMS must end with a newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0) throw new WebReleaseError("SHA256SUMS must be non-empty");
  const sums = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (match === null || !SAFE_FILE.test(match[2])) throw new WebReleaseError(`invalid SHA256SUMS line: ${JSON.stringify(line)}`);
    if (sums.has(match[2])) throw new WebReleaseError(`duplicate SHA256SUMS entry: ${match[2]}`);
    sums.set(match[2], match[1]);
  }
  if (JSON.stringify([...sums.keys()]) !== JSON.stringify([...sums.keys()].sort())) {
    throw new WebReleaseError("SHA256SUMS entries must be byte-sorted by filename");
  }
  return sums;
}

function expectString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new WebReleaseError(`${label}.${key} must be a string`);
  return value;
}

export function verifyReleaseDirectory(options: Options): void {
  const version = parseReleaseTag(options.tag);
  const root = resolve(options.root);
  const output = resolve(options.output);
  const status = lstatSync(output);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new WebReleaseError("release output must be a regular directory");
  const source = sourceIdentity(root, options.tag, options.expectedCommit);
  const { identities, lockPath } = loadPackageSet(root, version);
  const provenance = readJson(join(output, "provenance.json"), "provenance manifest");
  if (provenance["schemaVersion"] !== 1 || provenance["kind"] !== "dsx.web-package-release") {
    throw new WebReleaseError("provenance manifest schema/kind is invalid");
  }
  const release = asRecord(provenance["release"], "provenance release");
  if (release["tag"] !== options.tag || release["version"] !== version) throw new WebReleaseError("provenance release tag/version mismatch");
  const recordedSource = asRecord(provenance["source"], "provenance source");
  for (const [key, value] of Object.entries(source)) {
    if (recordedSource[key] !== value) throw new WebReleaseError(`provenance source.${key} does not match the current tag checkout`);
  }
  const materials = asRecord(provenance["materials"], "provenance materials");
  const packageLock = asRecord(materials["packageLock"], "provenance packageLock material");
  const generator = asRecord(materials["sbomGenerator"], "provenance SBOM generator material");
  if (packageLock["path"] !== "OpenSource/Web/package-lock.json" || packageLock["sha256"] !== sha256File(lockPath)) {
    throw new WebReleaseError("provenance package-lock material does not match the checkout");
  }
  const generatorPath = join(root, "ClosedSource", "scripts", "generate_release_sbom.rb");
  if (generator["path"] !== "ClosedSource/scripts/generate_release_sbom.rb" || generator["sha256"] !== sha256File(generatorPath)) {
    throw new WebReleaseError("provenance SBOM generator material does not match the checkout");
  }
  if (!Array.isArray(provenance["artifacts"]) || provenance["artifacts"].length !== identities.length) {
    throw new WebReleaseError("provenance must describe exactly five package artifacts");
  }
  const artifactNames = new Set<string>();
  const packageNames = new Set<string>();
  for (const raw of provenance["artifacts"]) {
    const artifact = asRecord(raw, "provenance artifact");
    const packageName = expectString(artifact, "package", "provenance artifact");
    const file = expectString(artifact, "file", "provenance artifact");
    const sha = expectString(artifact, "sha256", "provenance artifact");
    const integrity = expectString(artifact, "npmIntegrity", "provenance artifact");
    const identity = identities.find((entry) => entry.name === packageName);
    if (identity === undefined || packageNames.has(packageName)) throw new WebReleaseError(`unexpected/duplicate provenance package ${packageName}`);
    if (artifact["version"] !== version || file !== expectedTarball(identity) || !SAFE_FILE.test(file)) {
      throw new WebReleaseError(`provenance artifact identity is invalid for ${packageName}`);
    }
    const path = join(output, file);
    if (!SHA256_PATTERN.test(sha) || sha256File(path) !== sha || statSync(path).size !== artifact["bytes"] ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) || sha512Integrity(path) !== integrity) {
      throw new WebReleaseError(`provenance hash/size/integrity is invalid for ${packageName}`);
    }
    inspectTarball(path, identity, root);
    packageNames.add(packageName);
    artifactNames.add(file);
  }
  const sbom = asRecord(provenance["sbom"], "provenance SBOM");
  const sbomFile = expectString(sbom, "file", "provenance SBOM");
  if (sbomFile !== "dsx-web-source-sbom.cdx.json" || sbom["sha256"] !== sha256File(join(output, sbomFile)) ||
      sbom["format"] !== "CycloneDX" || sbom["specVersion"] !== "1.5") {
    throw new WebReleaseError("provenance SBOM identity/hash is invalid");
  }
  validateSbom(readJson(join(output, sbomFile), "source SBOM"), identities);

  const sums = parseSha256Sums(join(output, "SHA256SUMS"));
  const hashedNames = [...artifactNames, sbomFile, "provenance.json"].sort();
  if (JSON.stringify([...sums.keys()].sort()) !== JSON.stringify(hashedNames)) throw new WebReleaseError("SHA256SUMS inventory is incomplete or contains extras");
  for (const [name, sha] of sums) {
    if (sha256File(join(output, name)) !== sha) throw new WebReleaseError(`SHA-256 mismatch for ${name}`);
  }
  const expectedFiles = [...hashedNames, "SHA256SUMS"].sort();
  const actualFiles = readdirSync(output).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new WebReleaseError("release directory contains an unexpected or missing file");
  for (const name of actualFiles) {
    const entry = lstatSync(join(output, name));
    if (!entry.isFile() || entry.isSymbolicLink()) throw new WebReleaseError(`release entry must be a regular file: ${name}`);
  }
  console.log(`[web-release] VERIFIED: ${options.tag}, commit ${source.commit}, tree ${source.tree}`);
}

function usage(): never {
  throw new WebReleaseError("usage: release-packages.ts <build|verify> --tag vMAJOR.MINOR.PATCH [--root PATH] [--output PATH] [--expected-commit OID]");
}

function parseOptions(argv: string[]): Options {
  const mode = argv.shift();
  if (mode !== "build" && mode !== "verify") usage();
  const values = new Map<string, string>();
  while (argv.length > 0) {
    const key = argv.shift();
    if (!key?.startsWith("--") || !new Set(["--tag", "--root", "--output", "--expected-commit"]).has(key)) usage();
    const value = argv.shift();
    if (value === undefined || value.startsWith("--") || values.has(key)) usage();
    values.set(key, value);
  }
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const root = resolve(values.get("--root") ?? defaultRoot);
  const tag = values.get("--tag");
  if (tag === undefined) usage();
  const output = resolve(values.get("--output") ?? join(root, "OpenSource", "Web", "release-artifacts", tag));
  return { mode, root, tag, output, expectedCommit: values.get("--expected-commit") };
}

function main(): void {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.mode === "build") buildRelease(options);
    else verifyReleaseDirectory(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
