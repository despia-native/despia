//
//  actions.ts — DECLARED BODIES ARE HANDLERS (backend-authoring.md).
//
//  A `<server>` document's `<action>` body is the SAME grammar an `on:tap` handler is
//  written in, corpus-gated on three runtimes (Conformance/actions, Conformance/jse). This
//  file is the whole bridge between that grammar and an HTTP handler: build a run
//  environment per request, bind the effect seams to THIS caller, run, and answer with what
//  the body returned or threw.
//
//  It follows the declared-CRUD precedent exactly (repo.ts `crudHandler`): the emitter
//  writes one line per action and `host.ts` never learns that a handler came from markup
//  rather than TypeScript. That is why the host needed no change at all.
//
//  WHY THE BODY IS THE SAFE PLACE TO PUT AUTHOR CODE. JSE is an interpreter over a closed
//  statement grammar. There is no `import`, no `require`, no `process`, no `globalThis`, no
//  member access into host objects, and no way to name a capability this file did not bind.
//  A TypeScript handler is the opposite: it is the module system, so it reaches everything
//  the process can. Both are supported (a vendor SDK needs the second), but only the first
//  can be accepted from a tenant, which is the whole reason this path exists.
//

import { ActionRunner, isNSNull, makeRunEnv, ModuleCallError, ReactiveStore, type Dict } from "@despia/kernel";

import type { HostContext, HostHandler } from "./host.ts";
import { repoFor } from "./repo.ts";
import { enqueueMessage } from "./queue.ts";
import { callPackage, isPackageScheme, PackageError } from "./packages.ts";

/** One declared action, as the emitter writes it. */
export interface DeclaredAction {
  /** the owning module's derived chain — the error source, and the log/ledger attribution */
  chain: string;
  /** the action name (the `<action as="…">` word) */
  name: string;
  /** the JSE body, verbatim from the document */
  body: string;
  /** declared `inputs` expressions, evaluated in the caller's scope (the actions corpus rule) */
  inputs?: Record<string, string>;
  /** other actions in the SAME document — a body may call them (`dsx.action.x()`) */
  siblings?: Record<string, { body: string; inputs?: Record<string, string> }>;
  /** the secret names this document declared; nothing else is readable through the seam */
  secrets?: readonly string[];
  /** per-document budget overrides, already clamped by the emitter */
  budget?: { loopCap?: number; deadlineMs?: number; calls?: number };
  /** hosts that a body's `fetch` may reach. Empty/absent ⇒ no egress at all. */
  egress?: readonly string[];
}

/**
 * THE PLATFORM CEILINGS. A document may ask for less, never more: a budget an author can
 * raise is not a budget. These are deliberately far below what a hand-written TypeScript
 * handler can consume, because that is the trade the declared path makes — less rope, and
 * in exchange the code is accepted from someone the operator does not know.
 */
export const ACTION_LOOP_CAP = 50_000;
export const ACTION_DEADLINE_MS = 10_000;
export const ACTION_CALL_CAP = 64;

/** The reason vocabulary a body may throw, mapped to the status the caller sees. Anything
 *  outside it is a fault, not a rejection, and answers 500 with nothing in the body. */
const REASON_STATUS: Record<string, number> = {
  invalid: 400,
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream: 502,
  unavailable: 503,
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(headers ?? {}) },
  });
}

/**
 * A thrown value → the wire. The shape a body throws is the error-system's own
 * (`{ reason, message }`), so an author writes the same rejection they would write in a
 * screen. A message is echoed ONLY for a recognised reason: those are the author's words
 * about the CALLER's input, while an unrecognised throw carries whatever the runtime put in
 * it — exactly the class of text host.ts refuses to leak.
 */
function thrownToResponse(thrown: unknown, correlationId: string): Response | null {
  if (thrown === null || typeof thrown !== "object") return null;
  const reason = (thrown as Record<string, unknown>)["reason"];
  if (typeof reason !== "string") return null;
  const status = REASON_STATUS[reason];
  if (status === undefined) return null;
  const message = (thrown as Record<string, unknown>)["message"];
  return jsonResponse(
    status,
    { reason, message: typeof message === "string" ? message : reason },
    { "x-dsx-correlation-id": correlationId },
  );
}

/**
 * The kernel's null SENTINEL is not JSON's null. JSE distinguishes "absent" from "null" with a
 * marker object (`NSNull`, `{ __nsnull: true }`), which is right inside the runtime and wrong on
 * the wire: a body returning `{ total: nothingYet }` serialised as
 * `{"total":{"__nsnull":true}}`, so every client had to know a kernel implementation detail to
 * read a null. Normalised once, on the way out, where the value stops being a JSE value and
 * becomes a response.
 *
 * Depth-bounded for the same reason `sanitize` is: this walks a value an author produced, and a
 * self-referential one must not become a stack overflow in the response path.
 */
const MAX_WIRE_DEPTH = 32;

function toWire(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (isNSNull(value)) return null;
  if (depth >= MAX_WIRE_DEPTH) return null;
  const obj = value as object;
  if (seen.has(obj)) return null;
  seen.add(obj);
  if (Array.isArray(value)) return value.map((v) => toWire(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toWire(v, depth + 1, seen);
  return out;
}

/** A row id as the repository wants it. Only a string or a number is an id — an object or an
 *  array coerces to nonsense (`"[object Object]"`) that would reach the transport as a real
 *  lookup key, so those answer the empty string and the repository's own miss. */
function idOf(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** `https://api.stripe.com/v1/charges` ⇒ `api.stripe.com`. Anything unparseable is refused. */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The egress gate. HTTPS only, and only to a host the document declared — a suffix match so
 * `stripe.com` admits `api.stripe.com` without admitting `stripe.com.attacker.test`. An
 * empty declaration means a body cannot make an outbound request at all, which is the right
 * default: most endpoints have no business calling anywhere, and the ones that do say so.
 */
function egressGate(allowed: readonly string[]): (url: string) => boolean {
  const hosts = allowed.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
  if (hosts.length === 0) return () => false;
  return (url: string): boolean => {
    const host = hostOf(url);
    if (host === null) return false;
    return hosts.some((allow) => host === allow || host.endsWith(`.${allow}`));
  };
}

/**
 * The per-request module table — the ONLY capabilities a body can name.
 *
 * Every entry is bound to THIS request's identity, which is why it cannot live in the
 * process-global registry a surface uses: two concurrent requests would overwrite each
 * other's repository scope, and the failure mode of that bug is one tenant reading
 * another's rows. `RunEnv.callModule` (the kernel's one server seam) is what makes a
 * request-scoped table possible.
 */
function moduleTable(spec: DeclaredAction, ctx: HostContext): (chain: string, args: Dict) => Promise<unknown> {
  const secrets = new Set(spec.secrets ?? []);
  return async (chain: string, args: Dict): Promise<unknown> => {
    const parts = chain.split(".");
    const verb = parts[parts.length - 1] ?? "";
    const head = parts[0] ?? "";

    if (head === "data" && parts.length === 3) {
      const entity = parts[1]!;
      const repo = repoFor(ctx);
      const values = (args["values"] ?? args) as Record<string, unknown>;
      // A row id arrives as whatever the caller sent — a uuid string from a previous read, or a
      // number from a path segment JSON-parsed on the way in. Coercing beats silently reading
      // the empty string, which would answer `null` and read as "no such row".
      const id = idOf(args["id"]);
      switch (verb) {
        case "create": return repo.create(entity, values);
        case "get": return repo.get(entity, id);
        case "update": return repo.update(entity, id, values);
        case "delete": return repo.remove(entity, id);
        case "list": {
          const filters = (args["filters"] ?? {}) as Record<string, string>;
          const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
          return repo.list(entity, { filters, limit });
        }
        default:
          throw new ModuleCallError("unknown_action", `data.${entity} has no action "${verb}"`);
      }
    }

    if (head === "queue" && parts.length === 3 && verb === "push") {
      const queue = parts[1]!;
      const raw = args["key"];
      // The key is REQUIRED because the queue's idempotency guarantee is a UNIQUE column,
      // not a convention: an enqueue with no key has nothing for a duplicate delivery to
      // collide with, so the row that exists to refuse the replay would never be written.
      const key = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
      if (key === "") {
        throw new ModuleCallError("bad_request", `queue.${queue}.push needs a non-empty \`key\` (the idempotency key)`);
      }
      const payload = (args["payload"] ?? {}) as Record<string, unknown>;
      return enqueueMessage(queue, key, payload);
    }

    if (head === "secret" && parts.length === 2 && verb === "read") {
      const name = String(args["name"] ?? "");
      // An undeclared name is refused rather than answered empty: "" would read as a
      // configured-but-blank secret and send an unauthenticated request to a vendor.
      if (!secrets.has(name)) {
        throw new ModuleCallError("forbidden", `secret "${name}" is not declared by this document`);
      }
      const value = ctx.env(name);
      if (value === undefined || value === "") {
        throw new ModuleCallError("unavailable", `secret "${name}" is declared but not configured`);
      }
      return value;
    }

    // A DECLARED PACKAGE (Core/Server/Modules/Import). Checked last so no package can ever
    // shadow a kernel seam: `data`, `queue` and `secret` mean what this file says they mean
    // whatever an operator names a row.
    //
    // The WHOLE remainder is the export path, not just a verb — `dsx.module.stripe.charges.create`
    // resolves `charges.create` against the imported namespace, which is the shape most SDKs
    // actually have. Nothing about that is enumerated in a manifest; what is declared is the
    // package.
    if (parts.length >= 2 && isPackageScheme(head)) {
      try {
        return await callPackage(head, parts.slice(1), args as Record<string, unknown>);
      } catch (e) {
        if (e instanceof PackageError) throw new ModuleCallError(e.code, e.message);
        throw e;
      }
    }

    throw new ModuleCallError("unsupported", `a server action may not call "${chain}"`);
  };
}

/**
 * `declaredHandler(spec)` IS the whole handler for an action authored in markup — the
 * emitter writes one line per action and no author TypeScript exists, so no data-access
 * bug can be written into it (the B3 argument, applied to logic rather than CRUD).
 */
export function declaredHandler(spec: DeclaredAction): HostHandler {
  const loopCap = Math.min(spec.budget?.loopCap ?? ACTION_LOOP_CAP, ACTION_LOOP_CAP);
  const deadlineMs = Math.min(spec.budget?.deadlineMs ?? ACTION_DEADLINE_MS, ACTION_DEADLINE_MS);
  const callCap = Math.min(spec.budget?.calls ?? ACTION_CALL_CAP, ACTION_CALL_CAP);
  const gate = egressGate(spec.egress ?? []);

  return async (args: Record<string, unknown>, ctx: HostContext): Promise<unknown> => {
    const store = new ReactiveStore();
    const env = makeRunEnv(store, {
      ownerScheme: spec.chain,
      callModule: moduleTable(spec, ctx),
      egress: gate,
      loopCap,
      deadlineAt: Date.now() + deadlineMs,
      callBudget: { count: 0, cap: callCap },
      // A server has no consumer to deliver `dsx.event` to and no router to push a screen
      // onto. Both stay silent rather than throwing: a body written for both sides (the
      // portable case this whole design is for) must not fail here because it emits.
      emitEvent: () => {},
      component: () => {},
    });
    for (const [name, decl] of Object.entries(spec.siblings ?? {})) {
      env.actions.set(name, { body: decl.body, inputs: (decl.inputs ?? {}) as Dict });
    }
    env.actions.set(spec.name, { body: spec.body, inputs: (spec.inputs ?? {}) as Dict });

    // A fresh runner per request, so the entry lock and ledger reset `run()` performs have
    // nothing to do here — there is no concurrent entry on THIS runner and its budgets start at
    // zero. Calling the action directly keeps the whole server-shaped path out of the kernel,
    // which matters: runner.ts ships in every bundle, self-contained embeds included.
    const runner = new ActionRunner(env);
    const deadlineAt = env.deadlineAt!;
    const value = await runner.callAction(spec.name, {}, null, args as Dict);

    // A BLOWN BUDGET IS A FAILURE, NOT A SHORTER ANSWER. The runner CONTAINS a runaway loop —
    // it stops iterating and the body runs on — which is the right thing for a surface, where
    // a contained tap handler beats a frozen screen. On a request it is the worst possible
    // outcome: the handler returns whatever it had accumulated when the loop was cut, and the
    // caller receives 200 with a half-computed total and no way to know. Measured before this
    // check existed: `while (true) { n = n + 1 }` answered `200 {"n":20000}`.
    //
    // The signals are already on the env — the loop ledger overshoots its cap by exactly one,
    // the call budget the same, and the clock speaks for itself — so this costs the kernel
    // nothing and the request one comparison.
    const overLoop = env.loopWork.count > loopCap;
    const overCalls = (env.callBudget?.count ?? 0) > callCap;
    const overClock = Date.now() > deadlineAt;
    if (overLoop || overCalls || overClock) {
      const which = overLoop ? "loop" : overCalls ? "module-call" : "time";
      return jsonResponse(
        503,
        { reason: "budget_exceeded", message: `the request exceeded its ${which} budget` },
        { "x-dsx-correlation-id": ctx.correlationId },
      );
    }

    const thrown = runner.takeThrow();
    if (thrown === null) return toWire(value);

    const mapped = thrownToResponse(thrown.value, ctx.correlationId);
    if (mapped !== null) return mapped;
    // An unrecognised throw is a FAULT, and a fault is host.ts's to report and redact —
    // rethrowing keeps one failure path instead of two opinions about what a 500 looks like.
    throw thrown.value;
  };
}
