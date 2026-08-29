//
//  cli.ts — argument handling for `npm create despia <dir>`. Returns an exit code and never
//  calls process.exit, so the whole surface is drivable from a test.
//

import { relative, resolve } from "node:path";

import { scaffold, ScaffoldError, TEMPLATES, type ScaffoldOptions, type TemplateName } from "./index.ts";

export const VERSION = "0.1.0";

export const USAGE = `create-despia — scaffold a DSX project

Usage
  npm create despia <directory> [options]
  create-despia <directory> [options]

Options
  --name <name>        package + app name (default: the directory's basename)
  --scheme <scheme>    DSX scheme namespacing every component (default: derived from name)
  --template <name>    ${TEMPLATES.join(" | ")}   (default: minimal)
  --link <workspace>   depend on a local OpenSource/Web checkout with file: specifiers
                       instead of published versions (what you want inside this repository)
  --force              scaffold into a non-empty directory
  --version            print the version
  --help               print this message

Then
  cd <directory> && npm install && npm run dev
`;

export type Io = { out: (line: string) => void; err: (line: string) => void };
const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

const VALUE_FLAGS: ReadonlySet<string> = new Set(["name", "scheme", "template", "link"]);

export function runCreate(argv: readonly string[], io: Io = consoleIo, cwd = process.cwd()): number {
  const flags: { [name: string]: string | boolean } = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.substring(2) : arg.substring(2, eq);
    if (eq >= 0) { flags[name] = arg.substring(eq + 1); continue; }
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) { flags[name] = next; i += 1; }
    else flags[name] = true;
  }

  if (flags["version"] === true) { io.out(VERSION); return 0; }
  if (flags["help"] === true) { io.out(USAGE); return 0; }
  const directory = positional[0];
  if (directory === undefined) {
    io.err("create-despia: name the directory to create");
    io.out(USAGE);
    return 1;
  }

  const options: ScaffoldOptions = {
    directory: resolve(cwd, directory),
    ...(typeof flags["name"] === "string" ? { name: flags["name"] } : {}),
    ...(typeof flags["scheme"] === "string" ? { scheme: flags["scheme"] } : {}),
    ...(typeof flags["template"] === "string" ? { template: flags["template"] as TemplateName } : {}),
    ...(typeof flags["link"] === "string" ? { linkWorkspace: resolve(cwd, flags["link"]) } : {}),
    ...(flags["force"] === true ? { force: true } : {}),
  };

  try {
    const result = scaffold(options);
    const where = relative(cwd, result.root) || ".";
    io.out(`create-despia: scaffolded ${result.name} (${result.template}, scheme "${result.scheme}") in ${where}`);
    for (const file of result.files) io.out(`  ${file}`);
    io.out("");
    io.out(`  cd ${where}`);
    io.out("  npm install");
    io.out("  npm run dev");
    return 0;
  } catch (e) {
    io.err(`create-despia: ${e instanceof ScaffoldError ? e.message : e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
