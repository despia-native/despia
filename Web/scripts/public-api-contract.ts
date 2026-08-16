#!/usr/bin/env node

// A deterministic lock over every declaration file reachable from each published
// TypeScript entrypoint. A changed public signature, re-export, or public supporting type
// changes the fingerprint and requires an intentional contract update.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Json = Record<string, unknown>;
type ExportTarget = string | { types?: string; import?: string; default?: string };

export interface PublicApiEntrypoint {
  types: string;
  fingerprint: string;
  files: number;
}

export interface PublicApiPackage {
  name: string;
  version: string;
  entrypoints: Record<string, PublicApiEntrypoint>;
  untypedExports: string[];
}

export interface PublicApiContract {
  schema: 1;
  packages: PublicApiPackage[];
}

const PACKAGE_DIRS = ["kernel", "compiler", "dom", "element", "server"] as const;
const RELATIVE_SPECIFIER = /(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g;

function json(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function declarationTarget(from: string, specifier: string): string | null {
  let candidate = resolve(dirname(from), specifier);
  if (candidate.endsWith(".d.ts")) return existsSync(candidate) ? candidate : null;
  if (candidate.endsWith(".ts") || candidate.endsWith(".js")) {
    candidate = `${candidate.slice(0, -3)}.d.ts`;
    return existsSync(candidate) ? candidate : null;
  }
  for (const path of [`${candidate}.d.ts`, resolve(candidate, "index.d.ts")]) {
    if (existsSync(path)) return path;
  }
  return null;
}

function declarationClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
      const target = declarationTarget(path, match[1]!);
      if (target !== null) visit(target);
    }
  };
  visit(entry);
  return [...seen].sort();
}

function fingerprint(packageRoot: string, types: string): Pick<PublicApiEntrypoint, "fingerprint" | "files"> {
  const entry = resolve(packageRoot, types);
  if (!existsSync(entry)) throw new Error(`[public-api] build output is missing: ${entry}`);
  const files = declarationClosure(entry);
  const canonical = files.map((path) => {
    const source = readFileSync(path, "utf8")
      .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
      .replace(/\r\n?/g, "\n")
      .trimEnd();
    return `${relative(packageRoot, path).replaceAll("\\", "/")}\n${source}`;
  }).join("\n\n--- declaration boundary ---\n\n");
  return { fingerprint: createHash("sha256").update(canonical).digest("hex"), files: files.length };
}

export function buildPublicApiContract(webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")): PublicApiContract {
  const packages: PublicApiPackage[] = [];
  for (const dir of PACKAGE_DIRS) {
    const packageRoot = resolve(webRoot, "packages", dir);
    const manifest = json(resolve(packageRoot, "package.json"));
    const exportsMap = manifest["exports"] as Record<string, ExportTarget>;
    const entrypoints: Record<string, PublicApiEntrypoint> = {};
    const untypedExports: string[] = [];
    for (const exportName of Object.keys(exportsMap).sort()) {
      const target = exportsMap[exportName]!;
      const types = typeof target === "object" ? target.types : undefined;
      if (types === undefined) {
        untypedExports.push(exportName);
        continue;
      }
      entrypoints[exportName] = { types, ...fingerprint(packageRoot, types) };
    }
    packages.push({
      name: String(manifest["name"]),
      version: String(manifest["version"]),
      entrypoints,
      untypedExports,
    });
  }
  return { schema: 1, packages };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(buildPublicApiContract(), null, 2)}\n`);
}
