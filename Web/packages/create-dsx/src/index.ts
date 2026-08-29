//
//  create-despia — scaffold a minimal, working DSX project.
//
//  The generated project is a real DSX package (dsx.json + Components/**.dsx) plus the app
//  configuration `@despia-native/cli` reads, and it compiles with `despia build` as generated — that is
//  the contract this package is judged by, and the end-to-end test in test/scaffold.test.ts
//  runs exactly that loop.
//

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { renderTemplate, TEMPLATES, type TemplateName, type TemplateOptions } from "./templates.ts";

export { TEMPLATES, renderTemplate, type TemplateName, type TemplateOptions } from "./templates.ts";

/** The @despia-native/* version a fresh project pins. Bumped with the workspace train. */
export const DEFAULT_VERSION = "0.1.0";

export class ScaffoldError extends Error {}

export type ScaffoldOptions = {
  /** target directory (created if absent; must be empty or absent) */
  directory: string;
  /** package + app name; defaults to the directory's basename */
  name?: string;
  /** DSX scheme; defaults to a sanitized `name` */
  scheme?: string;
  template?: TemplateName;
  version?: string;
  /** rewrite the @despia-native/* dependencies to `file:` paths pointing at a local workspace —
   *  what you want inside this repository, where nothing is published yet */
  linkWorkspace?: string;
  /** allow scaffolding into a directory that already has files */
  force?: boolean;
};

export type ScaffoldResult = {
  root: string;
  name: string;
  scheme: string;
  template: TemplateName;
  /** written paths, project-relative, sorted */
  files: string[];
};

/** npm package names and DSX schemes have different alphabets; keep both derivations here so
 *  the CLI and the tests cannot drift on what a directory name becomes. */
export function toPackageName(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-_.]+|[-_.]+$/g, "");
  return cleaned.length > 0 ? cleaned : "dsx-app";
}

/** A scheme is the lowercase ASCII identifier that namespaces every component. */
export function toScheme(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return cleaned.length > 0 ? cleaned : "app";
}

export function scaffold(opts: ScaffoldOptions): ScaffoldResult {
  const root = resolve(opts.directory);
  if (existsSync(root) && readdirSync(root).length > 0 && opts.force !== true) {
    throw new ScaffoldError(`${root} is not empty — pass --force to scaffold into it anyway`);
  }
  const template = opts.template ?? "minimal";
  if (!TEMPLATES.includes(template)) {
    throw new ScaffoldError(`unknown template '${template}' — available: ${TEMPLATES.join(", ")}`);
  }
  const name = toPackageName(opts.name ?? root.split(/[\\/]/).filter(Boolean).at(-1) ?? "dsx-app");
  const scheme = toScheme(opts.scheme ?? name);

  const templateOptions: TemplateOptions = {
    name, scheme, template,
    version: opts.version ?? DEFAULT_VERSION,
    ...(opts.linkWorkspace !== undefined ? { link: workspaceLinks(opts.linkWorkspace) } : {}),
  };
  const files = renderTemplate(templateOptions);

  mkdirSync(root, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, name, scheme, template, files: Object.keys(files).sort() };
}

/** `file:` specifiers for every @despia-native/* package in a workspace's `packages/` folder. */
export function workspaceLinks(workspace: string): { [pkg: string]: string } {
  const packagesDir = resolve(workspace, "packages");
  const links: { [pkg: string]: string } = {};
  if (!existsSync(packagesDir)) return links;
  for (const dir of readdirSync(packagesDir)) {
    const manifest = join(packagesDir, dir, "package.json");
    if (!existsSync(manifest)) continue;
    // the folder is packages/create-dsx but the published name is create-despia
    links[dir === "create-dsx" ? "create-despia" : `@despia-native/${dir}`] = `file:${join(packagesDir, dir)}`;
  }
  return links;
}
