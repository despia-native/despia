//
//  document.ts — the `<cli>` document reader (cli-authoring.md).
//
//  A command-line program is a .dsx document: the head declares what the program may reach
//  (env names, executables, filesystem roots) plus the `<action>` bodies, and the body
//  declares the command surface — because the structure of a CLI is its command surface,
//  exactly as the structure of a server is its route surface.
//
//  WHY A HAND-WRITTEN SCANNER, and not an XML parser. An `<action>` body is JSE, and JSE
//  contains `<`, `&&` and `"`. A parser must reject those or silently mangle them, so action
//  content is read as RAW TEXT to its closing tag — the same rule lint_dsx.rb and
//  server_document.rb already apply. Mangling here is the dangerous kind: the body still
//  parses, it just means something else.
//
//  THE VOCABULARY IS CLOSED. An unknown tag or attribute aborts naming the line. A document
//  that half-works because a typo'd attribute was ignored is the silent class this repo's
//  gates exist to make impossible, and on a CLI the attribute in question is usually
//  `action` or `handler` — which decides whether the author's code runs at all.
//
//  Corpus: OpenSource/Conformance/cli/document.json.
//

/** Tag → the attributes it accepts. Anything else is an abort naming the line. */
const HEAD_TAGS: Record<string, readonly string[]> = {
  env: ["as"],
  exec: ["as"],
  root: ["as", "path"],
  action: ["as", "inputs"],
};

const BODY_TAGS: Record<string, readonly string[]> = {
  command: ["as", "action", "handler", "summary"],
  flag: ["as", "type", "repeatable", "summary"],
  positional: ["as", "variadic", "summary"],
};

const ROOT_ATTRS = ["as", "version", "summary"] as const;
const FLAG_TYPES = ["string", "boolean"] as const;

/** Answered by the host from the document itself, so a command claiming one would be
 *  shadowed and never run. Refusing is better than a command that silently never fires. */
const RESERVED_COMMANDS = new Set(["help", "version"]);

export type FlagType = (typeof FLAG_TYPES)[number];

export interface FlagDecl {
  name: string;
  type: FlagType;
  repeatable: boolean;
  summary: string;
}

export interface PositionalDecl {
  name: string;
  variadic: boolean;
  summary: string;
}

export interface CommandDecl {
  name: string;
  /** exactly one of these two is set — the reader refuses both and neither */
  action?: string;
  handler?: string;
  summary: string;
  flags: FlagDecl[];
  positionals: PositionalDecl[];
  line: number;
}

export interface ActionDecl {
  name: string;
  /** the JSE body, verbatim */
  body: string;
  /** declared `inputs` names, in order */
  inputs: string[];
  line: number;
}

export interface RootDecl {
  name: string;
  path: string;
}

export interface CliDocument {
  name: string;
  version: string;
  summary: string;
  env: string[];
  exec: string[];
  roots: RootDecl[];
  actions: Map<string, ActionDecl>;
  commands: CommandDecl[];
}

export class CliDocumentError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = "CliDocumentError";
    this.line = line;
  }
}

interface RawTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
  line: number;
  /** raw text content, for RAW_TAGS only */
  text?: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos|#\d+);/g, (whole, code: string) => {
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code] ?? whole;
  });
}

function parseAttributes(raw: string, line: number, rel: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"|([A-Za-z_][\w:-]*)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  let consumed = "";
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1] ?? match[3]!;
    const value = match[2] ?? match[4]!;
    if (Object.hasOwn(attrs, key)) throw new CliDocumentError(`${rel}: repeated attribute ${key}= on line ${line}`, line);
    attrs[key] = decodeEntities(value);
    consumed += match[0];
  }
  // A bare word where an attribute belongs is a typo with a value silently absent
  // (`<flag as="x" repeatable/>`), so it is refused rather than read as true.
  const leftover = raw.slice(raw.indexOf(" ") + 1).replace(pattern, "").replace(/[\s/]/g, "");
  if (raw.includes(" ") && leftover.length > 0 && consumed.length > 0) {
    throw new CliDocumentError(`${rel}: attribute without a quoted value near "${leftover}" on line ${line}`, line);
  }
  return attrs;
}

function checkAttributes(tag: string, attrs: Record<string, string>, allowed: readonly string[], line: number, rel: string): void {
  for (const key of Object.keys(attrs)) {
    if (!allowed.includes(key)) {
      throw new CliDocumentError(
        `${rel}: unknown attribute ${key}= on <${tag}> at line ${line} (accepts: ${allowed.join(", ")})`,
        line,
      );
    }
  }
}

function required(tag: string, attrs: Record<string, string>, key: string, line: number, rel: string): string {
  const value = attrs[key];
  if (value === undefined || value.length === 0) {
    throw new CliDocumentError(`${rel}: <${tag}> requires ${key}= at line ${line}`, line);
  }
  return value;
}

function boolAttr(tag: string, attrs: Record<string, string>, key: string, line: number, rel: string): boolean {
  const value = attrs[key];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliDocumentError(`${rel}: <${tag}> ${key}= must be "true" or "false" at line ${line}`, line);
}

/** One pass, no backtracking. Raw tags swallow to their close so JSE operators survive. */
function scan(source: string, rel: string): RawTag[] {
  const tags: RawTag[] = [];
  const lineOf = (offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line += 1;
    return line;
  };
  let pos = 0;
  while (true) {
    const openAt = source.indexOf("<", pos);
    if (openAt < 0) break;
    if (source.startsWith("<!--", openAt)) {
      const end = source.indexOf("-->", openAt);
      if (end < 0) throw new CliDocumentError(`${rel}: unterminated comment at line ${lineOf(openAt)}`, lineOf(openAt));
      pos = end + 3;
      continue;
    }
    const closeAt = source.indexOf(">", openAt);
    if (closeAt < 0) throw new CliDocumentError(`${rel}: unterminated tag at line ${lineOf(openAt)}`, lineOf(openAt));
    const raw = source.slice(openAt + 1, closeAt);
    const line = lineOf(openAt);
    pos = closeAt + 1;

    if (raw.startsWith("/")) {
      tags.push({ name: raw.slice(1).trim(), attrs: {}, selfClosing: false, closing: true, line });
      continue;
    }
    const selfClosing = raw.trimEnd().endsWith("/");
    const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw;
    const name = body.trim().split(/[\s/]/, 1)[0] ?? "";
    const attrs = parseAttributes(body, line, rel);

    // An action body is code, so it is read as raw text to its close.
    if (name === "action" && !selfClosing) {
      const close = source.indexOf("</action>", pos);
      if (close < 0) throw new CliDocumentError(`${rel}: unterminated <action> at line ${line}`, line);
      const text = source.slice(pos, close);
      pos = close + "</action>".length;
      tags.push({ name, attrs, selfClosing: true, closing: false, line, text: decodeEntities(text) });
      continue;
    }
    tags.push({ name, attrs, selfClosing, closing: false, line });
  }
  return tags;
}

/**
 * Read a `<cli>` document. Throws CliDocumentError naming the line on anything the closed
 * vocabulary does not know, or on any shape that would look complete while doing nothing.
 */
export function readCliDocument(source: string, rel = "<cli>"): CliDocument {
  const tags = scan(source, rel);
  const root = tags.find((t) => !t.closing);
  if (root === undefined || root.name !== "cli") {
    throw new CliDocumentError(`${rel}: a CLI document must open with <cli>`, root?.line ?? 1);
  }
  checkAttributes("cli", root.attrs, ROOT_ATTRS, root.line, rel);

  const document: CliDocument = {
    name: required("cli", root.attrs, "as", root.line, rel),
    version: required("cli", root.attrs, "version", root.line, rel),
    summary: root.attrs["summary"] ?? "",
    env: [],
    exec: [],
    roots: [],
    actions: new Map(),
    commands: [],
  };

  let section: "none" | "head" | "body" = "none";
  let current: CommandDecl | null = null;

  for (const tag of tags) {
    if (tag.name === "cli") continue;
    if (tag.name === "head") {
      section = tag.closing ? "body" : "head";
      continue;
    }
    if (tag.closing) {
      if (tag.name === "command") current = null;
      continue;
    }

    const inHead = Object.hasOwn(HEAD_TAGS, tag.name);
    const inBody = Object.hasOwn(BODY_TAGS, tag.name);
    if (!inHead && !inBody) {
      throw new CliDocumentError(`${rel}: unknown tag <${tag.name}> at line ${tag.line}`, tag.line);
    }
    if (inHead && section !== "head") {
      throw new CliDocumentError(`${rel}: <${tag.name}> belongs in <head> at line ${tag.line}`, tag.line);
    }
    if (inBody && section === "head") {
      throw new CliDocumentError(`${rel}: <${tag.name}> belongs in the body at line ${tag.line}`, tag.line);
    }
    checkAttributes(tag.name, tag.attrs, inHead ? HEAD_TAGS[tag.name]! : BODY_TAGS[tag.name]!, tag.line, rel);

    switch (tag.name) {
      case "env": {
        const name = required("env", tag.attrs, "as", tag.line, rel);
        if (document.env.includes(name)) throw new CliDocumentError(`${rel}: duplicate <env as="${name}"> at line ${tag.line}`, tag.line);
        document.env.push(name);
        break;
      }
      case "exec": {
        const name = required("exec", tag.attrs, "as", tag.line, rel);
        if (document.exec.includes(name)) throw new CliDocumentError(`${rel}: duplicate <exec as="${name}"> at line ${tag.line}`, tag.line);
        document.exec.push(name);
        break;
      }
      case "root": {
        const name = required("root", tag.attrs, "as", tag.line, rel);
        if (document.roots.some((r) => r.name === name)) {
          throw new CliDocumentError(`${rel}: duplicate <root as="${name}"> at line ${tag.line}`, tag.line);
        }
        document.roots.push({ name, path: required("root", tag.attrs, "path", tag.line, rel) });
        break;
      }
      case "action": {
        const name = required("action", tag.attrs, "as", tag.line, rel);
        if (document.actions.has(name)) throw new CliDocumentError(`${rel}: duplicate <action as="${name}"> at line ${tag.line}`, tag.line);
        const inputs = (tag.attrs["inputs"] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        document.actions.set(name, { name, body: tag.text ?? "", inputs, line: tag.line });
        break;
      }
      case "command": {
        const name = required("command", tag.attrs, "as", tag.line, rel);
        if (RESERVED_COMMANDS.has(name)) {
          throw new CliDocumentError(`${rel}: reserved command name "${name}" at line ${tag.line} — the host answers it from the document`, tag.line);
        }
        if (document.commands.some((c) => c.name === name)) {
          throw new CliDocumentError(`${rel}: duplicate command "${name}" at line ${tag.line}`, tag.line);
        }
        const action = tag.attrs["action"];
        const handler = tag.attrs["handler"];
        if ((action === undefined) === (handler === undefined)) {
          throw new CliDocumentError(
            `${rel}: <command as="${name}"> must declare exactly one of action= or handler= at line ${tag.line}`,
            tag.line,
          );
        }
        const decl: CommandDecl = {
          name,
          ...(action === undefined ? {} : { action }),
          ...(handler === undefined ? {} : { handler }),
          summary: tag.attrs["summary"] ?? "",
          flags: [],
          positionals: [],
          line: tag.line,
        };
        document.commands.push(decl);
        current = tag.selfClosing ? null : decl;
        break;
      }
      case "flag": {
        if (current === null) throw new CliDocumentError(`${rel}: <flag> outside a <command> at line ${tag.line}`, tag.line);
        const name = required("flag", tag.attrs, "as", tag.line, rel);
        if (current.flags.some((f) => f.name === name)) {
          throw new CliDocumentError(`${rel}: duplicate flag "${name}" on <command as="${current.name}"> at line ${tag.line}`, tag.line);
        }
        const type = tag.attrs["type"] ?? "string";
        if (!(FLAG_TYPES as readonly string[]).includes(type)) {
          throw new CliDocumentError(`${rel}: flag type must be one of ${FLAG_TYPES.join(", ")} at line ${tag.line}`, tag.line);
        }
        current.flags.push({
          name,
          type: type as FlagType,
          repeatable: boolAttr("flag", tag.attrs, "repeatable", tag.line, rel),
          summary: tag.attrs["summary"] ?? "",
        });
        break;
      }
      case "positional": {
        if (current === null) throw new CliDocumentError(`${rel}: <positional> outside a <command> at line ${tag.line}`, tag.line);
        const name = required("positional", tag.attrs, "as", tag.line, rel);
        if (current.positionals.some((p) => p.name === name)) {
          throw new CliDocumentError(`${rel}: duplicate positional "${name}" at line ${tag.line}`, tag.line);
        }
        // A variadic that is not last silently swallows what follows it.
        if (current.positionals.some((p) => p.variadic)) {
          throw new CliDocumentError(`${rel}: a variadic positional must be last on <command as="${current.name}"> at line ${tag.line}`, tag.line);
        }
        current.positionals.push({
          name,
          variadic: boolAttr("positional", tag.attrs, "variadic", tag.line, rel),
          summary: tag.attrs["summary"] ?? "",
        });
        break;
      }
    }
  }

  if (document.commands.length === 0) {
    throw new CliDocumentError(`${rel}: <cli as="${document.name}"> declares no <command>`, root.line);
  }
  for (const command of document.commands) {
    if (command.action === undefined) continue;
    const action = document.actions.get(command.action);
    if (action === undefined) {
      throw new CliDocumentError(
        `${rel}: <command as="${command.name}"> names action "${command.action}" but there is no <action as="${command.action}"> at line ${command.line}`,
        command.line,
      );
    }
    // `inputs=` is a CHECKED CONTRACT, not a comment. A body reads its arguments by bare
    // name, so a typo there does not fail — the name is simply absent and every branch that
    // reads it takes the empty path. Pinning the list against what the command actually
    // declares turns that silence into a build error.
    const available = new Set([...command.flags.map((f) => f.name), ...command.positionals.map((p) => p.name)]);
    for (const input of action.inputs) {
      if (!available.has(input)) {
        throw new CliDocumentError(
          `${rel}: <action as="${action.name}"> declares input "${input}" but <command as="${command.name}"> has no flag or positional of that name at line ${action.line}`,
          action.line,
        );
      }
    }
  }
  return document;
}

/** `--help` output, DERIVED from the document — the command table has one source of truth. */
export function usage(document: CliDocument): string {
  const lines: string[] = [];
  const head = document.summary.length > 0 ? `${document.name} — ${document.summary}` : document.name;
  lines.push(head, "", "Usage");
  for (const command of document.commands) {
    const parts = [`  ${document.name} ${command.name}`];
    for (const flag of command.flags) {
      const value = flag.type === "boolean" ? "" : ` <${flag.name}>`;
      parts.push(`[--${flag.name}${value}${flag.repeatable ? " …" : ""}]`);
    }
    for (const positional of command.positionals) {
      parts.push(positional.variadic ? `[<${positional.name}> …]` : `<${positional.name}>`);
    }
    lines.push(parts.join(" "));
  }
  lines.push("", "Commands");
  const width = Math.max(...document.commands.map((c) => c.name.length), 7);
  for (const command of document.commands) {
    lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);
  }
  // Declared flags and the two the host answers itself, in ONE block: a reader does not care
  // which side of that line an option falls on, only what they may type.
  const flags = new Map<string, { name: string; summary: string }>();
  for (const command of document.commands) for (const flag of command.flags) if (!flags.has(flag.name)) flags.set(flag.name, flag);
  flags.set("help", { name: "help", summary: "print this message" });
  flags.set("version", { name: "version", summary: "print the version" });
  lines.push("", "Options");
  const optionWidth = Math.max(...[...flags.keys()].map((n) => n.length), 7);
  for (const flag of flags.values()) {
    lines.push(`  --${flag.name.padEnd(optionWidth)}  ${flag.summary}`);
  }
  return `${lines.join("\n")}\n`;
}
