//
//  packages.ts — the IMPORT primitive's runtime half (Core/Server/Modules/Import).
//
//  The kernel imports nothing and knows no package manager. This file is where a declared
//  package becomes callable anyway: the emitter writes a barrel that imports the pinned
//  coordinates and hands the namespaces here, and a declared action body reaches them through
//  the ordinary module funnel. No `import` statement is ever reachable from a body, which is
//  the property the whole sandbox argument rests on.
//
//  ARBITRARY EXPORTS, DECLARED PACKAGES. A row names a package and a bus scheme; it does NOT
//  have to enumerate the functions. `dsx.module.<scheme>.<a>.<b>(…)` resolves `<a>.<b>` against
//  the imported namespace at call time, so an SDK shaped like `stripe.charges.create` works
//  without a manifest entry per method. What stays declared is the PACKAGE — a body cannot name
//  a coordinate the build did not install, because a runtime import of an arbitrary name is
//  invisible to esbuild, to the licence gate and to the assembly receipt, and a dependency the
//  build cannot see is one nobody can audit or exclude.
//
//  TRUST TIERS, STATED PLAINLY. A body is interpreted and can name only what actions.ts binds.
//  A package is ordinary JavaScript with the full reach of the process. Declaring one is
//  therefore an operator act with a build record, not an author convenience — and the two tiers
//  never blur, because a body still cannot reach a package the operator did not declare, and
//  never receives a live object from one (see `sanitize`).
//

/** One declared package, as the emitted barrel describes it. */
export interface PackageModule {
  /** the bus scheme a body calls (`dsx.module.<scheme>.<path>`) */
  scheme: string;
  /** the imported namespace — every export is reachable by path */
  module: unknown;
  /** optional aliases: action name → dotted export path (`make` → `default`) */
  exports?: Record<string, string>;
  /** optional per-action sugar: dotted path → positional parameter names */
  params?: Record<string, readonly string[]>;
}

export class PackageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const installed = new Map<string, PackageModule>();

/**
 * The property names that turn a value walk into an execution primitive. `constructor` reaches
 * `Function`, and `Function("return process")()` is the whole escape — every JS sandbox that
 * has ever fallen has fallen through one of these three. Refused at every step of every path,
 * the same three the kernel's own JSE walker refuses.
 */
const FORBIDDEN = new Set(["constructor", "__proto__", "prototype"]);

/** Depth and size ceilings for a value crossing back into a body — see `sanitize`. */
const MAX_RESULT_DEPTH = 12;
const MAX_RESULT_NODES = 50_000;

/**
 * Bind the emitted barrel. Called by every bootloader BEFORE the port opens, so a package whose
 * DECLARED alias no longer resolves refuses the cold start rather than 500-ing on the one
 * request that needed it. An un-aliased path cannot be checked here — it is resolved at call
 * time by definition — and answers a typed `unknown_action` when it is wrong.
 */
export function installPackages(modules: readonly PackageModule[]): void {
  installed.clear();
  for (const mod of modules) {
    for (const [action, path] of Object.entries(mod.exports ?? {})) {
      const found = resolveExport(mod.module, path.split("."));
      if (typeof found.fn !== "function") {
        throw new PackageError(
          "missing_export",
          `package module "${mod.scheme}" aliases ${mod.scheme}.${action} to "${path}", which is not a ` +
          "function in the installed version — the declared export name no longer exists",
        );
      }
    }
    installed.set(mod.scheme.toLowerCase(), mod);
  }
}

/** Is this chain head a declared package? (actions.ts asks before its final refusal.) */
export function isPackageScheme(scheme: string): boolean {
  return installed.has(scheme.toLowerCase());
}

/**
 * Walk an export path, refusing the three names that make a walk an escape and refusing any
 * step that is not an OWN property. Inherited properties are exactly where `toString`,
 * `valueOf` and every other ambient of the prototype chain live; an SDK's real surface is its
 * own, so requiring own-ness costs nothing legitimate and removes a whole category of reach.
 *
 * `self` is the resolved value's PARENT, because `stripe.charges.create(…)` is a method call and
 * loses its receiver if it is invoked bare — the single most common way a wrapper breaks an SDK.
 */
function resolveExport(root: unknown, path: readonly string[]): { fn: unknown; self: unknown } {
  let cur: unknown = root;
  let parent: unknown = undefined;
  for (const step of path) {
    if (FORBIDDEN.has(step)) throw new PackageError("forbidden", `"${step}" is not a reachable export name`);
    if (cur === null || (typeof cur !== "object" && typeof cur !== "function")) return { fn: undefined, self: undefined };
    if (!Object.prototype.hasOwnProperty.call(cur, step)) return { fn: undefined, self: undefined };
    parent = cur;
    cur = (cur as Record<string, unknown>)[step];
  }
  return { fn: cur, self: parent };
}

/**
 * A package returns DATA to a body, never a live object.
 *
 * The kernel's JSE walker refuses `constructor`/`__proto__`/`prototype`, so a returned host
 * object cannot be walked into an escape — but it can still be READ, and a package that handed
 * back something holding `process` would leak the environment one property access at a time.
 * Getters would also run inside the body's read path, which is a side effect nobody declared.
 * A JSON-shaped copy removes the whole class: functions, symbols, class identity and getters do
 * not survive it, and what reaches the body is the same value it would have received over HTTP.
 *
 * Cycles answer `null` at the cycle rather than throwing — an SDK response holding a back
 * reference is not an error, and a body that reads that far can handle a null.
 */
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>(), budget = { nodes: 0 }): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") return Number.isFinite(value as number) ? value : null;
  if (t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return null;
  if (depth >= MAX_RESULT_DEPTH) return null;
  if (++budget.nodes > MAX_RESULT_NODES) {
    throw new PackageError("result_too_large", "the package returned more data than a response may carry");
  }
  const obj = value as object;
  if (seen.has(obj)) return null;
  seen.add(obj);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1, seen, budget));
  const out: Record<string, unknown> = {};
  // OWN enumerable keys only, for the same reason resolveExport requires own-ness: the
  // prototype chain is where the ambient lives, and none of it is the package's answer.
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN.has(k)) continue;
    out[k] = sanitize(v, depth + 1, seen, budget);
  }
  return out;
}

/**
 * Invoke a declared package export.
 *
 * Three calling conventions, because npm has no single one:
 *   • `{ args: [a, b] }`   → positional, spread verbatim. The general escape hatch: it works for
 *                            every function in every package with nothing declared.
 *   • a declared `params`  → named keys mapped to positions, so the call site can read in names.
 *   • anything else        → the whole dict as one argument (the modern-SDK shape).
 */
export async function callPackage(scheme: string, path: readonly string[], args: Record<string, unknown>): Promise<unknown> {
  const mod = installed.get(scheme.toLowerCase());
  if (mod === undefined) throw new PackageError("unsupported", `no package module "${scheme}" is installed`);

  const key = path.join(".");
  const aliased = mod.exports?.[key];
  const resolved = resolveExport(mod.module, (aliased ?? key).split("."));
  if (typeof resolved.fn !== "function") {
    throw new PackageError("unknown_action", `package module "${scheme}" exports no function at "${key}"`);
  }

  const positional = args["args"];
  const declared = mod.params?.[key];
  const call = Array.isArray(positional)
    ? positional
    : declared !== undefined
      ? declared.map((name) => args[name])
      : [args];

  let result: unknown;
  try {
    result = await (resolved.fn as (...rest: unknown[]) => unknown).apply(resolved.self, call);
  } catch (e) {
    // Host-tier text: a stack frame, a connection string, occasionally a key. It belongs in the
    // failure sink, never in a body's `catch` where an author might return it to a caller.
    throw new PackageError("package_failed", `${scheme}.${key} failed: ${e instanceof Error ? e.name : "error"}`);
  }
  try {
    return sanitize(result);
  } catch (e) {
    // Reading the result can itself fail — a getter that throws, or a value past the size
    // ceiling. Both are the package's doing, so both answer as the package failing rather than
    // escaping raw into host.ts's generic 500.
    if (e instanceof PackageError) throw e;
    throw new PackageError("package_failed", `${scheme}.${key} returned a value that could not be read`);
  }
}
