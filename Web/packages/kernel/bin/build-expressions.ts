//
//  build-expressions.ts - the BUILD-TIME JSE evaluator behind `{{ <expression> }}`
//  placeholders in module manifests (dsx.json). The contract is
//  OpenSource/Documentation/architecture/build-expressions-spec.md; the Ruby side
//  (ClosedSource/scripts/build_expressions.rb) classifies path-vs-expression, batches
//  every expression in a prepare run, and drives THIS CLI exactly once over stdin.
//
//  Protocol v1 (spec §9.1): stdin  { version: 1, requests: [{ id, source, context }] }
//                           stdout { version: 1, results:  [{ id, ok, value | code, message }] }
//  Exit 0 when the protocol succeeded even if individual requests failed — request
//  failures are DATA (Ruby maps them to BX aborts so every error surfaces in one
//  build). Non-zero exit = the evaluator itself broke (Ruby reports BX06).
//
//  Dependency-free BY DESIGN: imports only kernel src (relative) + node builtins, so
//  `node bin/build-expressions.ts` works on a fresh clone with NO npm install — the
//  native-lane escape hatch (spec §9.3). Do not import jse-audit.ts here: it pulls in
//  @despia/compiler, which needs the workspace install. The one table both tools need
//  (KNOWN_OPS) is mirrored below and pinned identical by a kernel test.
//
//  Unlike the runtime, evaluation here is FAIL-LOUD: the runtime's JSE.eval contains
//  failures (fail-open null, by law); a build must instead abort with a named error,
//  because a silently-null entitlement is a multi-day association mystery. Hence the
//  Parser is driven directly (residue check, thrown errors surface) instead of
//  through JSE.eval.
//

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSE, JSESeams, Parser, StackStore } from "../src/jse/jse.ts";
import { tokenize, type Token } from "../src/jse/tokens.ts";
import { NSNull, isNSNull, isDict, isLambda, type Dict } from "../src/jse/jse.ts";

// ── protocol shapes ──────────────────────────────────────────────────────────────────

export type BuildContext = {
  config: Dict;
  app: Dict;
  env: Dict;
  platform: string;    // "ios" | "android" | "web" — the pipeline currently generating
  modules: string[];   // ENABLED module chains, sorted
};

export type Request = { id: string; source: string; context: BuildContext };
export type Result =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; code: string; message: string };

// ── the known-operator set (MIRROR of jse-audit.ts KNOWN_OPS — see header) ──────────

export const KNOWN_OPS: ReadonlySet<string> = new Set([
  "(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "?.", "?", "!", "=",
  "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "~",
  "==", "!=", "===", "!==", "<=", ">=", "&&", "||", "=>", "??", "**",
  "<<", ">>", ">>>", "++", "--", "+=", "-=", "*=", "/=", "%=", "**=", "...", "\n",
]);

// ── the known global roots (everything lookup() legitimately falls through to) ──────
// A bare-name read fires store.onVarRead with its ROOT segment; a root that is
// neither a context root (in store.vars) nor on this list resolved to null silently —
// exactly the fail-open hole this gate closes (BX02). Deliberately fail-CLOSED: an
// exotic builtin missing here errors loudly at authoring time instead of shipping a
// null into a manifest; extend the list (and the corpus) when that happens.
export const KNOWN_GLOBAL_ROOTS: ReadonlySet<string> = new Set([
  // constant/namespace roots (JSECore.constant + the dotted-call tables)
  "Math", "JSON", "Object", "Array", "Number", "String", "Boolean", "Date", "Intl",
  "crypto", "console", "performance", "URL", "URLSearchParams", "File",
  "Infinity", "NaN", "undefined",
  // bare global functions (JSE.apply)
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "btoa", "atob", "structuredClone",
  "abs", "cap", "capitalize", "ceil", "clock", "contains", "count", "email", "first",
  "floor", "has", "highlight", "if", "int", "join", "keys", "last", "len", "lower", "matches",
  "max", "maxLength", "min", "minLength", "mmss", "pad", "phone", "range", "regex",
  "required", "reverse", "round", "sum", "trim", "typeof", "upper", "url", "values",
]);

// ── determinism (spec §7): intercept the bound globals, not source text ─────────────

class NonDeterministic extends Error {
  readonly builtin: string;
  constructor(builtin: string) {
    super(`${builtin} is not available at build time (builds must be reproducible)`);
    this.builtin = builtin;
  }
}
class RuntimePlane extends Error {}

/** Installed ONCE per process, before any evaluation. Aliasing cannot evade this —
 *  the kernel's own core.ts calls land on the patched globals. `new Date()` with no
 *  argument funnels through Date.now() in core.ts, so one patch covers both. */
export function installDeterminismGuards(): void {
  Date.now = () => { throw new NonDeterministic("Date.now"); };
  Math.random = () => { throw new NonDeterministic("Math.random"); };
  const deny = (obj: object | undefined, prop: string, name: string): void => {
    if (obj === undefined) return;
    try {
      Object.defineProperty(obj, prop, {
        value: () => { throw new NonDeterministic(name); }, configurable: true,
      });
    } catch { /* immutable host object — the builtin then behaves as absent */ }
  };
  deny(globalThis.crypto, "randomUUID", "crypto.randomUUID");
  deny(globalThis.performance, "now", "performance.now");
}

/** The runtime planes (`global.*` / `route.*` / `cookie.*` / bare `env`) and runtime
 *  capability detection (`has(scheme)`) do not exist at build time — fail loud, never
 *  silently empty. platformOS is set per request from context.platform so `platform`,
 *  `os` and `platform.native` read the TARGET being generated, not this Node host. */
function bindSeams(platform: string): void {
  JSESeams.platformOS = platform;
  JSESeams.platformEmbed = false;
  JSESeams.stateVars = () => ({});
  JSESeams.onGlobalRead = () => {
    throw new RuntimePlane(
      "global.* / route.* / cookie.* / bare `env` are runtime planes, not build-time values; " +
      "available roots: config, app, env.<NAME>, platform, modules");
  };
  JSESeams.moduleAvailable = () => {
    throw new RuntimePlane(
      "has() is runtime capability detection; at build time use modules.includes('<chain>')");
  };
}

// ── value mapping ────────────────────────────────────────────────────────────────────

/** JSON → JSE values: explicit nulls become the present-null sentinel (the same
 *  mapping the conformance runner uses). */
export function toJseValue(v: unknown): unknown {
  if (v === null) return NSNull;
  if (Array.isArray(v)) return v.map(toJseValue);
  if (typeof v === "object") {
    const out: Dict = {};
    for (const [k, val] of Object.entries(v as Dict)) out[k] = toJseValue(val);
    return out;
  }
  return v;
}

/** JSE result → JSON, rejecting everything a manifest cannot represent (spec §5):
 *  non-finite numbers, functions, and the kernel's value-object dict shapes
 *  (Date / RegExp / URLSearchParams / URL), which would otherwise serialize their
 *  `__`-prefixed internals into a plist. JSON.stringify would silently turn NaN into
 *  null — exactly the silence this walk exists to prevent. */
export function fromJseValue(v: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (v === null || v === undefined || isNSNull(v)) return { ok: true, value: null };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { ok: false, message: `${String(v)} is not representable` };
    return { ok: true, value: v };
  }
  if (typeof v === "string" || typeof v === "boolean") return { ok: true, value: v };
  if (isLambda(v)) return { ok: false, message: "a function is not representable" };
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const e of v) {
      const r = fromJseValue(e);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (isDict(v)) {
    const d = v as Dict;
    for (const shape of ["__date", "__regex", "__params", "__url"]) {
      if (d[shape] !== undefined) {
        const kind = shape === "__date" ? "Date" : shape === "__regex" ? "RegExp" : "URL/URLSearchParams";
        return { ok: false, message: `a ${kind} object is not representable — return a plain value (.toISOString() / .toString())` };
      }
    }
    const out: Dict = {};
    for (const [k, val] of Object.entries(d)) {
      const r = fromJseValue(val);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, message: `a ${typeof v} value is not representable` };
}

// ── evaluation ───────────────────────────────────────────────────────────────────────

function renderToken(t: Token): string {
  switch (t.kind) {
    case "num": return String(t.v);
    case "str": return `'${t.v}'`;
    case "ident": return t.v;
    case "op": return t.v.replace(/\n/g, "\\n");
    case "regex": return `/${t.pattern}/${t.flags}`;
    case "template": return "`…`";
  }
}

const CONTEXT_ROOTS = "config, app, env, platform, modules";

export function evaluateRequest(req: Request): Result {
  const source = req.source.trim();
  const fail = (code: string, message: string): Result => ({ id: req.id, ok: false, code, message });
  if (source.length === 0) return fail("BX01", "empty expression");

  let toks: Token[];
  try {
    toks = tokenize(source);
  } catch (e) {
    return fail("BX01", `expression does not tokenize: ${String((e as Error).message ?? e)}`);
  }
  if (toks.length === 0) return fail("BX01", "empty expression");
  // The runtime lexes unknown operators into tokens the parser then drops — fail-open.
  // Build-time is the audit: an op outside the grammar is a syntax error here (BX01).
  for (const t of toks) {
    if (t.kind === "op" && !KNOWN_OPS.has(t.v)) {
      return fail("BX01", `unsupported syntax \`${t.v.replace(/\n/g, "\\n")}\` — JSE does not lex this token`);
    }
  }
  // A truncated source (`config.host +`) parses fail-open at runtime (the dangling
  // operand reads as null); build-time is stricter — only closers may end a source.
  const last = toks[toks.length - 1]!;
  if (last.kind === "op" && last.v !== ")" && last.v !== "]" && last.v !== "}") {
    return fail("BX01", `expression ends on the operator \`${last.v.replace(/\n/g, "\\n")}\` — it looks truncated`);
  }

  const store = new StackStore();
  store.vars.set("config", toJseValue(req.context.config ?? {}));
  store.vars.set("app", toJseValue(req.context.app ?? {}));
  store.vars.set("env", toJseValue(req.context.env ?? {}));
  store.vars.set("modules", toJseValue(req.context.modules ?? []));
  // `platform` short-circuits in lookup() to JSESeams.platformOS (bound below); the
  // vars entry keeps the root's membership visible to the unknown-read gate.
  store.vars.set("platform", req.context.platform);
  bindSeams(req.context.platform);

  // Unknown-reference gate (BX02): lookup() reports every bare-name ROOT it resolves.
  // A local-scope read (a lambda parameter: `h => h`) reports the LITERAL pseudo-key
  // "dsx.attribute" instead of the name — that is dependency-tracking noise here, not
  // a reference. Everything else that is neither a context root nor a known global
  // resolved to null silently, which is exactly the fail-open hole BX02 closes.
  const unknown = new Set<string>();
  store.onVarRead = (name: string): void => {
    if (name === "dsx.attribute") return; // local/lambda scope — tracked, never unknown
    const root = name.split(".", 1)[0]!;
    if (!store.vars.has(root) && !KNOWN_GLOBAL_ROOTS.has(root)) unknown.add(root);
  };

  let raw: unknown;
  const parser = new Parser(toks, store, null);
  try {
    raw = parser.expression();
  } catch (e) {
    if (e instanceof NonDeterministic) {
      return fail("BX05", `${e.builtin} is not available at build time (builds must be reproducible)`);
    }
    if (e instanceof RuntimePlane) return fail("BX02", e.message);
    const msg = String((e as Error).message ?? e);
    if (/budget/i.test(msg)) return fail("BX04", "expression exceeded the loop budget (100000)");
    return fail("BX03", `expression threw: ${msg}`);
  }

  if (unknown.size > 0) {
    const name = [...unknown].sort()[0]!;
    return fail("BX02", `unknown reference '${name}'; available roots: ${CONTEXT_ROOTS}`);
  }
  if (parser.pos < toks.length) {
    const tail = toks.slice(parser.pos, parser.pos + 8).map(renderToken).join(" ");
    return fail("BX01", `expression did not fully parse at token ${parser.pos + 1} — trailing \`${tail}\``);
  }

  const mapped = fromJseValue(raw);
  if (!mapped.ok) return fail("BX10", mapped.message);
  return { id: req.id, ok: true, value: mapped.value };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────

export function run(input: string): { exit: number; output: string; error?: string } {
  let doc: { version?: unknown; requests?: unknown };
  try {
    doc = JSON.parse(input) as typeof doc;
  } catch (e) {
    return { exit: 2, output: "", error: `stdin is not JSON: ${String((e as Error).message ?? e)}` };
  }
  if (doc.version !== 1) {
    return { exit: 2, output: "", error: `unsupported protocol version ${JSON.stringify(doc.version)} (this evaluator speaks version 1)` };
  }
  if (!Array.isArray(doc.requests)) return { exit: 2, output: "", error: "requests[] missing" };
  installDeterminismGuards();
  const results: Result[] = [];
  for (const r of doc.requests as Request[]) {
    if (typeof r?.id !== "string" || typeof r?.source !== "string" || r?.context === null || typeof r?.context !== "object") {
      return { exit: 2, output: "", error: "each request needs { id, source, context }" };
    }
    results.push(evaluateRequest(r));
  }
  return { exit: 0, output: JSON.stringify({ version: 1, results }) };
}

export function main(): number {
  const input = readFileSync(0, "utf8");
  const r = run(input);
  if (r.error !== undefined) console.error(`build-expressions: ${r.error}`);
  if (r.output.length > 0) process.stdout.write(r.output + "\n");
  return r.exit;
}

// keep the JSE import used (evalBlock and friends stay reachable for future forms)
void JSE;

let invokedDirectly = false;
try {
  const entry = process.argv[1];
  invokedDirectly = entry !== undefined &&
    realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) process.exitCode = main();
