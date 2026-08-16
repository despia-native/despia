//
//  dispatch.ts — argv becomes an invocation (cli-authoring.md).
//
//  THE DECLARED SHAPE DECIDES THE PARSE, and that is the whole reason the command surface is
//  declared rather than inferred. A parser that does not know a flag's type cannot decide
//  whether `--strict app.dsx` means strict="app.dsx" or strict=true with a positional; every
//  hand-rolled CLI picks one and is wrong half the time. Here the document said which.
//
//  An unknown flag is REFUSED, never ignored. Ignoring one is how a user comes to believe an
//  option took effect — a CLI that silently drops --dry-run is worse than one that has no
//  --dry-run at all.
//
//  Corpus: OpenSource/Conformance/cli/dispatch.json.
//

import type { CliDocument, CommandDecl } from "./document.ts";

/** The refusal vocabulary. Each maps to a usage error, never to a fault. */
export type DispatchReason =
  | "unknown_command"
  | "unknown_flag"
  | "missing_value"
  | "missing_argument"
  | "unexpected_argument";

export class DispatchError extends Error {
  readonly reason: DispatchReason;
  constructor(reason: DispatchReason, message: string) {
    super(message);
    this.name = "DispatchError";
    this.reason = reason;
  }
}

export interface Invocation {
  command: CommandDecl;
  /** the declared names, and nothing else — a body cannot reach an argument nobody declared */
  inputs: Record<string, unknown>;
}

function parseBoolean(raw: string, flag: string): boolean {
  if (raw === "true" || raw === "") return true;
  if (raw === "false") return false;
  throw new DispatchError("missing_value", `--${flag} takes "true" or "false", got ${JSON.stringify(raw)}`);
}

/**
 * Bind argv to one command's declared inputs. `argv` excludes the program name and INCLUDES
 * the command word, which is how a host receives it from process.argv.slice(2).
 */
export function dispatch(document: CliDocument, argv: readonly string[]): Invocation {
  const name = argv[0];
  const command = document.commands.find((c) => c.name === name);
  if (command === undefined) {
    throw new DispatchError("unknown_command", `unknown command ${JSON.stringify(name ?? "")}`);
  }

  const inputs: Record<string, unknown> = {};
  for (const flag of command.flags) inputs[flag.name] = flag.repeatable ? [] : flag.type === "boolean" ? false : null;
  const positionalValues: string[] = [];

  let flagsEnded = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!flagsEnded && arg === "--") {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flagName = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const declared = command.flags.find((f) => f.name === flagName);
      if (declared === undefined) {
        throw new DispatchError("unknown_flag", `unknown flag --${flagName}`);
      }
      let raw: string;
      if (eq >= 0) raw = arg.slice(eq + 1);
      else if (declared.type === "boolean") raw = "";
      else {
        // A boolean never consumes the next token; a string one must, and if there is
        // nothing to consume that is a refusal rather than an empty value.
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new DispatchError("missing_value", `--${flagName} requires a value`);
        }
        raw = next;
        i += 1;
      }
      const value: unknown = declared.type === "boolean" ? parseBoolean(raw, flagName) : raw;
      if (declared.repeatable) (inputs[flagName] as unknown[]).push(value);
      else inputs[flagName] = value;
      continue;
    }
    positionalValues.push(arg);
  }

  let cursor = 0;
  for (const positional of command.positionals) {
    if (positional.variadic) {
      inputs[positional.name] = positionalValues.slice(cursor);
      cursor = positionalValues.length;
      continue;
    }
    const value = positionalValues[cursor];
    if (value === undefined) {
      throw new DispatchError("missing_argument", `<${positional.name}> is required`);
    }
    inputs[positional.name] = value;
    cursor += 1;
  }
  if (cursor < positionalValues.length) {
    throw new DispatchError("unexpected_argument", `unexpected argument ${JSON.stringify(positionalValues[cursor])}`);
  }

  return { command, inputs };
}
