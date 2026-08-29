//
//  declared.ts — DECLARED BODIES ARE COMMANDS (cli-authoring.md).
//
//  A `<cli>` document's `<action>` body is the SAME grammar an `on:tap` handler is written in,
//  corpus-gated on three runtimes (Conformance/actions, Conformance/jse). This file is the whole
//  bridge between that grammar and a command-line program: build a run environment per
//  invocation, bind the effect seams to THIS process, run, and turn what the body returned or
//  threw into an exit code.
//
//  It follows packages/server/src/actions.ts deliberately and almost line for line, because the
//  point being made is that a node is a set of seams and nothing else. The kernel names no
//  platform; a surface is what you bind to it. Two nodes with completely different jobs share one
//  runner, one grammar, one corpus and one lint — and the only file that differs is this one.
//
//  WHAT DIFFERS FROM THE SERVER, AND WHY.
//
//  1. THE SEAMS. A server may not touch the filesystem, the environment or other programs; a CLI
//     exists to do exactly that. So instead of denying them, each is DECLARED: <root> scopes the
//     filesystem, <env> names what may be read, <exec> names what may be run. The trade is the
//     same one the server makes — declare it and you may reach it, and what you did not declare
//     is refused WITH A REASON rather than answered emptily, because an empty answer is
//     indistinguishable from a real one.
//
//  2. THE BUDGETS. A request that runs for ten seconds is broken; a build that runs for ten
//     seconds is a build. The deadline is therefore minutes rather than seconds and the loop cap
//     is far higher. The budgets do not disappear, though, and the reason is worth stating: the
//     runner CONTAINS a runaway loop and lets the body carry on, which is right for a tap handler
//     (a contained handler beats a frozen screen) and wrong for a program whose stdout someone
//     will pipe into another program. A half-computed answer with exit 0 is the worst outcome
//     available, so a blown budget is a failure here, exactly as it is on a request.
//
//  Corpus: OpenSource/Conformance/cli/seams.json.
//

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ActionRunner, isNSNull, makeRunEnv, ModuleCallError, ReactiveStore, type Dict } from "@despia-native/kernel";

import type { ActionDecl, CliDocument } from "./document.ts";

/** Where a command's output goes. Injected so every command is drivable from a test. */
export interface CommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface RunOptions {
  /** working directory the declared <root> paths resolve against */
  cwd: string;
  io: CommandIo;
  /** process environment; injected so a test never has to mutate the real one */
  env?: Record<string, string | undefined>;
  /** ask for LESS than the ceilings below, never more — a budget a caller can raise is not a
   *  budget. Exists so the corpus can prove the blown-budget law in milliseconds instead of
   *  spending a minute of every CI run counting to five million. */
  budget?: { loopCap?: number; deadlineMs?: number; calls?: number };
}

/**
 * THE PLATFORM CEILINGS. A document may ask for less, never more. Generous next to the
 * server's, because the work is different in kind, and still finite for the reason above.
 */
export const COMMAND_LOOP_CAP = 5_000_000;
export const COMMAND_DEADLINE_MS = 300_000;
export const COMMAND_CALL_CAP = 100_000;

/**
 * The reason vocabulary a body may throw, mapped to the exit code the shell sees. A name in
 * this table is a REJECTION the user should read; anything else is a FAULT — a defect in the
 * command rather than a message to its user — and exits 70 (EX_SOFTWARE), which stays
 * distinct from every reason here.
 */
const REASON_EXIT: Record<string, number> = {
  failed: 1,
  invalid: 2,
  bad_request: 2,
  not_found: 3,
  forbidden: 4,
  unavailable: 5,
  conflict: 6,
  budget_exceeded: 7,
};

export const FAULT_EXIT = 70;

/** A path inside a declared root, or a refusal. Resolve-then-compare is the only check that
 *  holds: a string prefix test admits `../projectile` for root `../project`. */
function withinRoot(rootPath: string, requested: string): string {
  const base = resolve(rootPath);
  const full = resolve(base, requested);
  const rel = relative(base, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ModuleCallError("forbidden", `path ${JSON.stringify(requested)} resolves outside its declared root`);
  }
  return full;
}

function str(args: Dict, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/**
 * The seam table. Everything a declared body can name lives here, and a name absent from it
 * is a name the body cannot reach — not by policy but by construction, because JSE is an
 * interpreter over a closed statement grammar with no import, no require, no process and no
 * member access into host objects.
 */
function moduleTable(document: CliDocument, options: RunOptions) {
  const declaredEnv = new Set(document.env);
  const declaredExec = new Set(document.exec);
  const roots = new Map(document.roots.map((r) => [r.name, resolve(options.cwd, r.path)]));
  const environment = options.env ?? process.env;

  const rootFor = (args: Dict): string => {
    const name = str(args, "root");
    const path = roots.get(name);
    if (path === undefined) {
      throw new ModuleCallError("forbidden", `root ${JSON.stringify(name)} is not declared by this document`);
    }
    return path;
  };

  // The kernel funnels every `dsx.module.…` call here as (chain, args); the verb is the
  // chain's last segment, exactly as packages/server/src/actions.ts reads it.
  return async (chain: string, args: Dict): Promise<unknown> => {
    const parts = chain.split(".");
    const verb = parts[parts.length - 1] ?? "";
    const head = parts[0] ?? "";

    if (head === "out" && parts.length === 2) {
      const text = str(args, "text");
      // stdout and stderr stay separate. A CLI whose diagnostics land on stdout cannot be
      // piped, and that is a contract rather than a detail.
      if (verb === "print") { options.io.out(text); return null; }
      if (verb === "warn" || verb === "error") { options.io.err(text); return null; }
      throw new ModuleCallError("unknown_action", `out has no action "${verb}"`);
    }

    if (head === "env" && parts.length === 2 && verb === "read") {
      const name = str(args, "name");
      if (!declaredEnv.has(name)) {
        throw new ModuleCallError("forbidden", `environment variable ${JSON.stringify(name)} is not declared by this document`);
      }
      // Declared-and-absent is a DIFFERENT FACT from undeclared, and a body must be able to
      // branch on it, so this answers null rather than refusing. Collapsing the two would
      // make an optional variable unusable.
      const value = environment[name];
      return value === undefined || value === "" ? null : value;
    }

    if (head === "fs" && parts.length === 2) {
      const base = rootFor(args);
      const target = withinRoot(base, str(args, "path"));
      switch (verb) {
        case "exists":
          return existsSync(target);
        case "read": {
          if (!existsSync(target)) {
            throw new ModuleCallError("not_found", `${JSON.stringify(str(args, "path"))} does not exist`);
          }
          return readFileSync(target, "utf8");
        }
        case "write": {
          mkdirSync(resolve(target, ".."), { recursive: true });
          writeFileSync(target, str(args, "text"));
          return null;
        }
        case "list": {
          if (!existsSync(target)) {
            throw new ModuleCallError("not_found", `${JSON.stringify(str(args, "path"))} does not exist`);
          }
          return readdirSync(target).sort();
        }
        default:
          throw new ModuleCallError("unknown_action", `fs has no action "${verb}"`);
      }
    }

    if (head === "exec" && parts.length === 2 && verb === "run") {
      const name = str(args, "name");
      if (!declaredExec.has(name)) {
        throw new ModuleCallError("forbidden", `executable ${JSON.stringify(name)} is not declared by this document`);
      }
      const raw = args["args"];
      const argv = Array.isArray(raw) ? raw.map((v) => String(v)) : [];
      try {
        const stdout = execFileSync(name, argv, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, stdout };
      } catch (thrown) {
        const status = (thrown as { status?: number }).status;
        return { code: typeof status === "number" ? status : 1, stdout: String((thrown as { stdout?: string }).stdout ?? "") };
      }
    }

    throw new ModuleCallError("unsupported", `a command body may not call "${chain}"`);
  };
}

/** The kernel's null SENTINEL is not JS null — normalise on the way out, as the server does. */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && isNSNull(value)) return null;
  return value;
}

/** What a body said about how it ended. Returning nothing is success, because the common
 *  case should not need ceremony. */
function exitCodeOf(value: unknown): number {
  const settled = plain(value);
  if (settled === null) return 0;
  if (typeof settled === "number") return Number.isFinite(settled) ? Math.trunc(settled) : FAULT_EXIT;
  if (typeof settled === "object") {
    const code = (settled as Record<string, unknown>)["code"];
    if (typeof code === "number" && Number.isFinite(code)) return Math.trunc(code);
  }
  return 0;
}

export interface CommandResult {
  code: number;
  /** set when the body threw a recognised reason — the host prints it, the caller can assert */
  reason?: string;
  message?: string;
  /** what the body returned, normalised — the corpus asserts seam envelopes through this */
  value?: unknown;
}

/**
 * Run one declared command. This IS the whole implementation of a markup-authored command:
 * no author TypeScript exists, so no filesystem or process bug can be written into one.
 */
export async function runDeclaredCommand(
  document: CliDocument,
  action: ActionDecl,
  inputs: Record<string, unknown>,
  options: RunOptions,
): Promise<CommandResult> {
  const store = new ReactiveStore();
  const loopCap = Math.min(options.budget?.loopCap ?? COMMAND_LOOP_CAP, COMMAND_LOOP_CAP);
  const callCap = Math.min(options.budget?.calls ?? COMMAND_CALL_CAP, COMMAND_CALL_CAP);
  const deadlineAt = Date.now() + Math.min(options.budget?.deadlineMs ?? COMMAND_DEADLINE_MS, COMMAND_DEADLINE_MS);
  const env = makeRunEnv(store, {
    ownerScheme: document.name,
    callModule: moduleTable(document, options),
    loopCap,
    deadlineAt,
    callBudget: { count: 0, cap: callCap },
    // A CLI has no consumer for dsx.event and no router to push a screen onto. Both stay
    // silent rather than throwing, so a body shared with a surface does not fail here.
    emitEvent: () => {},
    component: () => {},
  });
  // Every action in the document is a sibling: a command body may call another action the
  // same way a screen does, which is what makes a CLI decomposable instead of one long body.
  //
  // The declared `inputs` are kept. They used to be stripped here, because the runner applied
  // ONE input rule — evaluate each expression in the caller's scope — and a top-level command
  // has no caller, so mapping the declared names onto themselves overwrote every dispatched
  // value with the absent marker. Stripping dodged that, at the cost of the contract: a command
  // body got whatever the payload happened to carry, and a declared default could not exist.
  //
  // The runner now models the two kinds of call (`CallActionOptions.entry`), so the declaration
  // survives to the body and a command invocation says what it is.
  for (const [name, decl] of document.actions) {
    // A `<cli>` input is a NAME (`inputs="project, out"`), so it maps to itself: at an entry
    // that names the payload key, and a name the payload omits reads as absent rather than as
    // an unbound variable.
    env.actions.set(name, {
      body: decl.body,
      inputs: Object.fromEntries(decl.inputs.map((n) => [n, n])) as Dict,
    });
  }

  const runner = new ActionRunner(env);
  // An ENTRY call: argv became the payload, and there is no caller scope.
  const value = await runner.callAction(action.name, {}, null, inputs as Dict, { entry: true });

  // A BLOWN BUDGET IS A FAILURE, NOT A SHORTER ANSWER. The runner contains a runaway loop and
  // the body runs on, so without this check a command answers exit 0 with half its output.
  const overLoop = env.loopWork.count > loopCap;
  const overCalls = (env.callBudget?.count ?? 0) > callCap;
  const overClock = Date.now() > deadlineAt;
  if (overLoop || overCalls || overClock) {
    const which = overLoop ? "loop" : overCalls ? "module-call" : "time";
    return { code: REASON_EXIT["budget_exceeded"]!, reason: "budget_exceeded", message: `the command exceeded its ${which} budget` };
  }

  const thrown = runner.takeThrow();
  if (thrown === null) return { code: exitCodeOf(value), value: plain(value) };

  const raw = thrown.value;
  const reason = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["reason"] : undefined;
  if (typeof reason === "string" && Object.hasOwn(REASON_EXIT, reason)) {
    const message = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["message"] : undefined;
    return { code: REASON_EXIT[reason]!, reason, message: typeof message === "string" ? message : reason };
  }
  // An unrecognised throw is a defect in the command, not a message to its user.
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : JSON.stringify(plain(raw));
  return { code: FAULT_EXIT, reason: "fault", message: text ?? "the command failed" };
}

/** The declared root paths, resolved — used by the host to report a misconfigured document
 *  before a body runs rather than as a surprise mid-command. */
export function rootPaths(document: CliDocument, cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const root of document.roots) out[root.name] = resolve(cwd, root.path) + sep;
  return out;
}
