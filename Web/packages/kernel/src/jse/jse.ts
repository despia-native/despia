//
//  jse.ts - the DSX expression evaluator (the JSE language core). TS twin of
//  Engine/JSE.swift / Jse.kt — same names, same arguments, same behaviors.
//
//  Pure computation, DOM-free → SURFACE-SAFE: the same evaluator runs in the browser,
//  in Node (SSR, tests), and in a worker. This is the INTERPRETER path (dev server,
//  OTA-served markup); production compiles JSE to real JS closures over the SAME
//  semantic helpers (compile/codegen.ts) — the conformance corpus gates both.
//
//  Number/null model, scope rules, budgets: see the header of Jse.kt (the pinned twin)
//  and OpenSource/Conformance/jse. Divergences here would be corpus-visible, not silent.
//

import {
  NSNull, isNSNull, isDict, isLambda, trimWhitespaceOnly, charCount, graphemes,
  number, string, truthy, jseEquals, compare, arith, typeofString, safeInt,
  roundedAwayFromZero, swiftMin, swiftMax, capitalizedSwift, asArray, asRows,
  index as indexOp, member as memberOp, watchKey, isMissing, bitOp, bitNot, powOp, isWhitespaceOnly,
  type Dict, type StackLambda, type LambdaParam, type StackFormula,
} from "./values.ts";
import { tokenize, cachedTokens, type Token } from "./tokens.ts";
import { highlightLines } from "./highlight.ts";
import { JSERegex, reDoSProne } from "./regex.ts";
import { DSXPathMatch } from "./pathmatch.ts";
import { JSECore, JSECrypto } from "./core.ts";
import { higherOrderFns, methodFns } from "./dispatch.ts";
import { resolveOverride, resolveOverridePlane, type OverrideDecl } from "../style-overrides.ts";

/** The evaluator-visible subset of the surface's reactive store. The reactive/UI
 *  members (signals, handlers, watches) live in store.ts; JSE reads exactly these. */
export class StackStore {
  vars: Map<string, unknown> = new Map();            // live surface state (NSNull marks present-null)
  computed: Map<string, string> = new Map();         // reactive formulas: <variable computed="true">
  computedDepth = 0;                                 // guards self-referential computed values
  initials: Map<string, unknown> = new Map();        // declared defaults: <variable as="x">expr</variable>
  formulas: Map<string, StackFormula> = new Map();   // parameterized reactive formulas: <formula>
  functions: Map<string, unknown> = new Map();       // user functions: function name(args){…}
  fnDepth = 0;                                       // guards user-function recursion (capped at 32)
  evalDepth = 0;                                     // guards expression-evaluator recursion (capped at 64)
  attrDefaults: Map<string, string> = new Map();     // declared prop defaults: <attribute as="x" default="…"/>
  overrideDecls: Map<string, OverrideDecl> = new Map(); // declared style knobs: <override as="x" type="…" default="…"/>
  /** signal read hook — store.ts wires this so `lookup` reads track dependencies. */
  onVarRead: ((name: string) => void) | null = null;
}

export type Item = Dict | null;

// ── host seams (wired by the host at boot; defaults inert) ──────────────────────────
export const JSESeams = {
  /** DSX.state.vars — the app-wide reactive store (`global.*` / `route.*` / `env`). */
  stateVars: (): Dict => ({}),
  /** the live cookie jar (`cookie.*`). */
  cookieJar: (): Dict => ({}),
  /** environment channel — detection fails CLOSED to "appstore". */
  appEnvironment: (): string => "appstore",
  /** ModuleRegistry availability — the `has(scheme)` capability check. */
  moduleAvailable: (_scheme: string): boolean => false,
  /** next-tick hop for reactive author logic (the render-safe invariant). */
  afterRenderDispatch: (work: () => void): void => { queueMicrotask(work); },
  /** `os` / `platform` resolve to "web" on this renderer BY DESIGN — the same markup
   *  reads "ios" / "android" / "macos" / "windows" / "linux" on the native kernels
   *  (/web/14; desktop-platforms.md). */
  platformOS: "web",
  /** third-party web-component embed vs in-app surface (/web/14). */
  platformEmbed: false,
  /** dependency tracking for `global.*` / `route.*` / `env` reads (store.ts wires it). */
  onGlobalRead: null as ((key: string) => void) | null,
};

/** The desktop OS set behind `dsx.platform.desktop` (desktop-platforms.md; the law is
 *  the platform corpus). Derived, never an os value of its own — `os` stays exact. */
export const DESKTOP_OSES: readonly string[] = ["macos", "windows", "linux"];
export function isDesktopOS(os: string): boolean { return DESKTOP_OSES.includes(os); }

function makeLambda(params: LambdaParam[], body: Token[], block: boolean, captured: Dict): StackLambda {
  return { __lambda: true, params, body, block, captured };
}

/** The GLOBAL FUNCTION LIBRARY — one app-wide `function name(){…}` table shared by every
 *  surface (js-core.md "Shared logic"). Registered once at boot via
 *  JSE.registerGlobalFunctions; resolved AFTER the surface's own `store.functions`
 *  (a surface-local name shadows the global) and BEFORE the builtins. */
const globalFunctions = new Map<string, unknown>();

/** THE one function-declaration scanner (registerFunctions / registerGlobalFunctions both
 *  ride it): finds every top-level `function name(params) { … }` in `body` and hands the
 *  built lambda to `register`. Top-level functions are NOT closures — captured stays
 *  empty; free names resolve against the live store at call time. */
function scanFunctions(body: string, register: (name: string, fn: StackLambda) => void): void {
  if (!body.includes("function")) return;
  const s = Array.from(body);
  let i = 0;
  const kw = "function";
  const isWord = (c: string) => /[\p{L}\p{Nd}_]/u.test(c);
  while (i < s.length) {
    const slice = s.slice(i, i + kw.length).join("");
    const isKw = slice === kw &&
      (i === 0 || !isWord(s[i - 1]!)) &&
      (i + kw.length >= s.length || !isWord(s[i + kw.length]!));
    if (!isKw) { i += 1; continue; }
    let j = i + kw.length;
    while (j < s.length && /\s/.test(s[j]!)) j += 1;
    let name = "";
    while (j < s.length && isWord(s[j]!)) { name += s[j]; j += 1; }
    while (j < s.length && /\s/.test(s[j]!)) j += 1;
    if (j >= s.length || s[j] !== "(") { i += 1; continue; }
    let depth = 0;
    let paramStr = "";
    while (j < s.length) {
      const ch = s[j]!;
      if (ch === "(") { depth += 1; if (depth === 1) { j += 1; continue; } }
      if (ch === ")") { depth -= 1; if (depth === 0) { j += 1; break; } }
      paramStr += ch;
      j += 1;
    }
    while (j < s.length && /\s/.test(s[j]!)) j += 1;
    if (j >= s.length || s[j] !== "{") { i = j; continue; }
    let bdepth = 0;
    let bodyStr = "";
    while (j < s.length) {
      const ch = s[j]!;
      if (ch === "{") { bdepth += 1; if (bdepth === 1) { j += 1; continue; } }
      if (ch === "}") { bdepth -= 1; if (bdepth === 0) { j += 1; break; } }
      bodyStr += ch;
      j += 1;
    }
    const params = paramStr.split(",")
      .map((p) => ({ name: trimWhitespaceOnly(p), keys: [] as string[] }))
      .filter((p) => (p.name ?? "").length > 0);
    // Top-level functions are NOT closures (free names resolve against the live store).
    if (name.length > 0) register(name, makeLambda(params, tokenize(bodyStr), true, {}));
    i = j;
  }
}

/** The iterable coercion shared by spread (`[...x]`) and `for…of`: arrays as-is,
 *  strings → graphemes, Set → its values, Map → its entry pairs, anything else empty. */
export function spreadValues(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return graphemes(v);
  if (isDict(v)) {
    const d = v as Dict;
    if (Array.isArray(d["__set"])) return d["__set"] as unknown[];
    if (Array.isArray(d["__map"])) return d["__map"] as unknown[];
  }
  return [];
}

/** The `for…in` key coercion (wave 3): a dict's OWN keys (insertion order, "__"-internal
 *  keys skipped — so Set/Map/Date value objects iterate empty), an array's indices
 *  0..n-1 (as numbers); anything else contributes nothing. */
export function forInKeys(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.map((_, i) => i);
  if (isDict(v)) return Object.keys(v as Dict).filter((k) => !k.startsWith("__"));
  return [];
}

/** JS `in` — dict key / array index membership (relational precedence, like the twins). */
export function inOp(l: unknown, r: unknown): boolean {
  if (Array.isArray(r)) {
    const n = number(l);
    if (n === null) return false;
    const i = safeInt(n);
    return i >= 0 && i < r.length;
  }
  if (isDict(r)) return Object.prototype.hasOwnProperty.call(r as Dict, string(l));
  return false;
}

// ── declaration grammar (wave 2): multi-declarators + flat destructuring patterns ────

export type DeclPattern =
  | { kind: "ident"; name: string }
  | { kind: "object"; entries: { key: string; value: DeclPattern; def?: Token[] }[]; rest?: string }
  | { kind: "array"; items: ({ value: DeclPattern; def?: Token[] } | null)[]; rest?: string };
export type Declarator = { pattern: DeclPattern; expr: Token[] };

/**
 * Parse `pattern [= expr] (, pattern [= expr])*` from the token slice AFTER the
 * `const`/`let`/`var` keyword (already captured to the statement end).
 *
 * Patterns NEST, and each position takes an optional `= default` and a trailing `...rest`.
 * They used to be flat by design, which made three everyday shapes unwritable:
 * `const { a: { b } } = row` (reading into a nested payload), `const { a = 5 } = opts`
 * (an option with a fallback) and `const { id, ...rest } = row` (the standard way to omit a
 * field). None had a workaround that was not several lines of manual copying, and all three
 * are data-shaping rather than exotic syntax.
 */
export function parseDeclarators(toks: Token[]): Declarator[] {
  const out: Declarator[] = [];
  let i = 0;
  const cur = (): Token | null => (i < toks.length ? toks[i]! : null);
  const isOp = (v: string): boolean => { const t = cur(); return t !== null && t.kind === "op" && t.v === v; };

  /** Capture tokens up to the next TOP-LEVEL member of `stops` (nesting-aware). */
  const captureUntil = (stops: string[]): Token[] => {
    const acc: Token[] = [];
    let d = 0;
    while (i < toks.length) {
      const tk = toks[i]!;
      if (tk.kind === "op") {
        if (tk.v === "(" || tk.v === "[" || tk.v === "{") d += 1;
        else if (tk.v === ")" || tk.v === "]" || tk.v === "}") {
          if (d === 0 && stops.includes(tk.v)) break;
          d -= 1;
        } else if (d === 0 && stops.includes(tk.v)) break;
      }
      acc.push(tk);
      i += 1;
    }
    return acc;
  };

  /** One pattern position, recursively. Returns null when nothing consumable is here. */
  const parsePattern = (): DeclPattern | null => {
    const t = cur();
    if (t !== null && t.kind === "ident") { i += 1; return { kind: "ident", name: t.v }; }
    if (isOp("{")) {
      i += 1;
      const entries: { key: string; value: DeclPattern; def?: Token[] }[] = [];
      let rest: string | undefined;
      while (cur() !== null && !isOp("}")) {
        if (isOp("...")) {
          i += 1;
          const rt = cur();
          if (rt !== null && rt.kind === "ident") { rest = rt.v; i += 1; }
          if (isOp(",")) i += 1;
          continue;
        }
        const kt = cur();
        if (kt === null || (kt.kind !== "ident" && kt.kind !== "str")) { i += 1; continue; }
        const key = kt.v;
        i += 1;
        let value: DeclPattern = { kind: "ident", name: key };
        if (isOp(":")) { i += 1; value = parsePattern() ?? { kind: "ident", name: key }; }
        let def: Token[] | undefined;
        if (isOp("=")) { i += 1; const d = captureUntil([",", "}"]); if (d.length > 0) def = d; }
        entries.push(def === undefined ? { key, value } : { key, value, def });
        if (isOp(",")) i += 1;
      }
      if (isOp("}")) i += 1;
      return rest === undefined ? { kind: "object", entries } : { kind: "object", entries, rest };
    }
    if (isOp("[")) {
      i += 1;
      const items: ({ value: DeclPattern; def?: Token[] } | null)[] = [];
      let rest: string | undefined;
      let expectItem = true;
      while (cur() !== null && !isOp("]")) {
        if (isOp(",")) { if (expectItem) items.push(null); expectItem = true; i += 1; continue; }
        if (isOp("...")) {
          i += 1;
          const rt = cur();
          if (rt !== null && rt.kind === "ident") { rest = rt.v; i += 1; }
          expectItem = false;
          continue;
        }
        const value = parsePattern();
        if (value === null) { i += 1; continue; }
        let def: Token[] | undefined;
        if (isOp("=")) { i += 1; const d = captureUntil([",", "]"]); if (d.length > 0) def = d; }
        items.push(def === undefined ? { value } : { value, def });
        expectItem = false;
      }
      if (isOp("]")) i += 1;
      return rest === undefined ? { kind: "array", items } : { kind: "array", items, rest };
    }
    return null;
  };

  while (i < toks.length) {
    const pattern = parsePattern();
    if (pattern === null) { i += 1; continue; }
    // optional initializer — capture to the next TOP-LEVEL comma
    let expr: Token[] = [];
    if (isOp("=")) { i += 1; expr = captureUntil([","]); }
    out.push({ pattern, expr });
    if (isOp(",")) i += 1;
  }
  return out;
}

/**
 * THE ONE ARROW-PARAM SCANNER, shared by the interpreter and the compiler.
 *
 * It exists because the two tiers each had their own copy of this loop, and a copy is a place
 * to fall behind: when destructured params landed, the interpreter learned them and the
 * compiler did not, so the same body meant two different things depending on which tier ran
 * it. The corpus caught it — every case runs on both tiers — but a gate that catches drift is
 * a worse instrument than a structure that cannot drift.
 *
 * Returns the params plus each one's default TOKENS. The interpreter keeps the tokens and
 * evaluates them at call time; the compiler compiles them. Neither re-reads the shapes.
 */
export function parseArrowParams(
  toks: Token[],
  start: number,
): { params: LambdaParam[]; defaults: (Token[] | null)[]; next: number } {
  const params: LambdaParam[] = [];
  const defaults: (Token[] | null)[] = [];
  let i = start;
  const cur = (): Token | null => (i < toks.length ? toks[i]! : null);
  const isOp = (v: string): boolean => { const t = cur(); return t !== null && t.kind === "op" && t.v === v; };

  const balanced = (): Token[] => {
    const out: Token[] = [];
    let d = 0;
    for (;;) {
      const tk = cur();
      if (tk === null) break;
      if (tk.kind === "op") {
        if (tk.v === "{" || tk.v === "[" || tk.v === "(") d += 1;
        else if (tk.v === "}" || tk.v === "]" || tk.v === ")") d -= 1;
      }
      out.push(tk);
      i += 1;
      if (d === 0) break;
    }
    return out;
  };
  /** a default's tokens — to the next top-level `,` or the params' closing `)` */
  const defaultTokens = (): Token[] => {
    const out: Token[] = [];
    let d = 0;
    for (;;) {
      const tk = cur();
      if (tk === null) break;
      if (tk.kind === "op") {
        if (tk.v === "(" || tk.v === "[" || tk.v === "{") d += 1;
        else if (tk.v === ")" || tk.v === "]" || tk.v === "}") { if (d === 0) break; d -= 1; }
        else if (tk.v === "," && d === 0) break;
      }
      out.push(tk);
      i += 1;
    }
    return out;
  };

  while (!isOp(")") && cur() !== null) {
    if (isOp("{") || isOp("[")) {
      // ONE pattern reader for params and declarations alike — a destructured param must not
      // mean something different from the same shape in a `const`.
      const decls = parseDeclarators(balanced());
      const pattern = decls.length > 0 ? decls[0]!.pattern : null;
      params.push(pattern === null ? { name: null, keys: [] } : { name: null, keys: [], pattern });
      defaults.push(null);
    } else if (isOp("...")) {
      i += 1;
      const nt = cur();
      if (nt !== null && nt.kind === "ident") { i += 1; params.push({ name: nt.v, keys: [], rest: true }); defaults.push(null); }
      else i += 1;
    } else {
      const nt = cur();
      if (nt !== null && nt.kind === "ident") {
        i += 1;
        const param: LambdaParam = { name: nt.v, keys: [] };
        if (isOp("=")) { i += 1; defaults.push(defaultTokens()); } else defaults.push(null);
        params.push(param);
      } else i += 1;
    }
    if (isOp(",")) i += 1;
  }
  if (isOp(")")) i += 1;
  return { params, defaults, next: i };
}

/**
 * Bind one declarator's VALUE through its pattern.
 *
 * `evalDefault` evaluates a `= default` when the position is MISSING — which in JSE means
 * null, since null is its one absent value. Callers that cannot evaluate (the compile path)
 * omit it and simply bind the missing value, exactly as before defaults existed.
 */
export function bindPattern(
  p: DeclPattern,
  value: unknown,
  bind: (name: string, v: unknown) => void,
  evalDefault?: (toks: Token[]) => unknown,
): void {
  const withDefault = (v: unknown, def: Token[] | undefined): unknown => {
    if (def === undefined || evalDefault === undefined) return v;
    return v === null || v === undefined || v === NSNull ? evalDefault(def) : v;
  };
  if (p.kind === "ident") { bind(p.name, value); return; }
  if (p.kind === "object") {
    const taken = new Set<string>();
    for (const e of p.entries) {
      taken.add(e.key);
      bindPattern(e.value, withDefault(memberOp(value, e.key), e.def), bind, evalDefault);
    }
    if (p.rest !== undefined) {
      const out: Dict = {};
      if (isDict(value)) {
        for (const [k, v] of Object.entries(value as Dict)) if (!taken.has(k)) out[k] = v;
      }
      bind(p.rest, out);
    }
    return;
  }
  p.items.forEach((item, index) => {
    if (item === null) return;
    bindPattern(item.value, withDefault(indexOp(value, index), item.def), bind, evalDefault);
  });
  if (p.rest !== undefined) {
    const src = Array.isArray(value) ? (value as unknown[]) : [];
    bind(p.rest, src.slice(p.items.length));
  }
}

/** What an author meant by one `name="…"` attribute. The corpus is
 *  `OpenSource/Conformance/composition/attribute-binding.json`; the Kotlin and Swift twins
 *  are both `JSE.attributeBinding`. */
export type AttributeBinding =
  | { kind: "static" }
  | { kind: "value"; expr: string }
  | { kind: "text" };

/** The attribute-binding FOLD - pure syntax, no store, no evaluation.
 *
 *  A sole `{{ … }}` carries the expression's VALUE; anything mixed carries the
 *  string. Without the distinction every consumer prop arrives interpolated, which is
 *  invisible for a label and fatal for structure: a component that renders its own
 *  children cannot hand them down, so a tree, an outliner or a comment thread is
 *  unbuildable. The facet path had already made this call privately, so the two kinds of
 *  component disagreed about what a prop is; this is that decision, shared.
 *
 *  A hole ends at the FIRST `}}`, matching `interpolate`'s own scan exactly. The two must
 *  never disagree about where an expression stops - that disagreement is a silent type
 *  change, and one shared wrong answer is repairable where a split one is not. */
export function attributeBinding(template: string): AttributeBinding {
  if (!template.includes("{{")) return { kind: "static" };
  const t = template.trim();
  if (!t.startsWith("{{")) return { kind: "text" };
  const close = t.indexOf("}}", 2);
  if (close < 0 || close !== t.length - 2) return { kind: "text" };
  return { kind: "value", expr: t.substring(2, close) };
}

export const JSE = {
  attributeBinding,

  /** Resolve one consumer attribute to the value it should carry: typed when the template
   *  is a sole hole, its own text when it has none, the interpolated sentence otherwise. */
  bindAttribute(template: string, store: StackStore, item: Item): unknown {
    const b = attributeBinding(template);
    if (b.kind === "static") return template;
    if (b.kind === "value") return JSE.eval(b.expr, store, item);
    return JSE.interpolate(template, store, item);
  },

  interpolate(s: string, store: StackStore, item: Item): string {
    if (!s.includes("{{")) return s;
    let out = "";
    let idx = 0;
    for (;;) {
      const open = s.indexOf("{{", idx);
      if (open < 0) break;
      out += s.substring(idx, open);
      const close = s.indexOf("}}", open + 2);
      if (close < 0) { out += s.substring(open); return out; }
      const expr = s.substring(open + 2, close);
      out += string(JSE.eval(expr, store, item));
      idx = close + 2;
    }
    out += s.substring(idx);
    return out;
  },

  eval(raw: string, store: StackStore, item: Item): unknown {
    const e = trimWhitespaceOnly(raw);
    if (e.length === 0) return null;
    // Recursion budget — a knotted expression is contained instead of fatal (see twin).
    if (store.evalDepth >= 64) {
      console.warn(`[JSE] eval recursion budget (64) exceeded — expression cycle; returning nil: ${e.slice(0, 80)}`);
      return null;
    }
    store.evalDepth += 1;
    try {
      const p = new Parser(cachedTokens(e), store, item);
      return p.expression();
    } catch (err) {
      // belt-and-braces: an evaluator failure is contained, never fatal (the parser
      // depth cap should make this unreachable; adversarial input must still not throw)
      console.warn(`[JSE] eval failed — returning nil: ${String(err)} in ${e.slice(0, 80)}`);
      return null;
    } finally {
      store.evalDepth -= 1;
    }
  },

  /** Evaluate a `<variable>`/function body as a VALUE — a **bounded-JS** block.
   *  PURE: `const`/`let`/`x = e` write a throwaway local scope, never the store.
   *  The full statement grammar incl. BUDGETED loops (10000 iterations per evaluation,
   *  corpus core-004) — so it always terminates. */
  evalBlock(body: string, store: StackStore, item: Item): unknown {
    const trimmed = body.trim();
    if (trimmed.length === 0) return null;
    // Fast path: a plain single expression (no block / statements / declarations).
    if (!trimmed.includes(";") && !trimmed.includes("\n") && !trimmed.includes("{") &&
        !trimmed.startsWith("return") && !trimmed.startsWith("const ") && !trimmed.startsWith("let ") &&
        !trimmed.startsWith("if ") && !trimmed.startsWith("if(") && !trimmed.startsWith("function")) {
      return JSE.eval(trimmed, store, item);
    }
    const e = new JSEval(cachedTokens(body), store, item ?? {});
    e.runBlock();
    return e.result;
  },

  /** Register every top-level `function name(params) { … }` in `body` as a callable
   *  user function — positional args, depth-capped at 32. String-scanned. */
  registerFunctions(body: string, store: StackStore): void {
    scanFunctions(body, (name, fn) => store.functions.set(name, fn));
  },

  /** Register `body`'s top-level functions into the APP-WIDE table — the global function
   *  library (js-core.md "Shared logic"): validation/pricing/formatting written ONCE,
   *  callable from every surface. Same scanner, same shapes as registerFunctions; global
   *  registration does NOT capture scope (free names resolve against the CALLING
   *  surface's live store, exactly like top-level surface functions). Lookup order at a
   *  named call: scope lambda → the surface's `store.functions` (a local name SHADOWS
   *  the global) → this table → builtins; same fnDepth 32 guard. Boot/modules call this
   *  once at startup; re-registration replaces (last write wins). */
  registerGlobalFunctions(body: string): void {
    scanFunctions(body, (name, fn) => globalFunctions.set(name, fn));
  },

  /** Drop every globally registered function (tests; a full app reload). */
  clearGlobalFunctions(): void {
    globalFunctions.clear();
  },

  /** The app-wide table's read side — the executors' shared lookup seam (Parser +
   *  compiled `$.call` resolve through this after the surface table misses). */
  globalFunction(name: string): unknown {
    return globalFunctions.get(name);
  },

  /** Invoke a lambda / user function: bind args to params (destructuring `{a,b}`,
   *  call-time defaults, a trailing rest array), then evaluate the body.
   *  Scope = caller `base` ⊕ captured creation scope ⊕ params — base fills UNDER the
   *  captured snapshot (capture semantics hold), which is what lets a stored lambda call
   *  ITSELF (`const f = n => … f(n - 1)`: f is not in its own creation snapshot, so the
   *  caller's live scope supplies it). */
  callLambda(f: StackLambda, args: unknown[], store: StackStore, base: Dict | null = null): unknown {
    if (f.native) return f.native(args, base); // compiled closure — same scope contract
    const scope: Dict = base ? { ...base } : {};
    Object.assign(scope, f.captured);
    f.params.forEach((p, k) => {
      if (p.rest === true && p.name !== null) {
        // rest binds the REMAINING args as an array (empty when none)
        scope[p.name] = k < args.length ? args.slice(k).map((x) => x ?? NSNull) : [];
        return;
      }
      const a = k < args.length ? args[k] : null;
      if (p.name !== null) {
        if (isMissing(a) && p.def !== undefined && p.def.length > 0) {
          // default — evaluated at CALL time in the CALLEE scope (earlier params visible)
          scope[p.name] = new Parser(p.def, store, scope).expression() ?? NSNull;
        } else {
          scope[p.name] = a ?? NSNull;
        }
      } else if (p.pattern !== undefined) {
        bindPattern(p.pattern, a, (n, v) => { scope[n] = v ?? NSNull; },
                    (toks) => new Parser(toks, store, scope).expression());
      } else {
        const d = isDict(a) ? (a as Dict) : {};
        for (const key of p.keys) scope[key] = d[key] ?? NSNull;
      }
    });
    if (f.block) {
      const e = new JSEval(f.body, store, scope);
      e.runBlock();
      return e.result;
    }
    const p = new Parser(f.body, store, scope);
    return p.expression();
  },

  /** Pure built-in functions for `{{ … }}` — no side effects, no I/O. */
  apply(name: string, a: unknown[], store: StackStore): unknown {
    const s = (i: number): string => (i < a.length ? string(a[i]) : "");
    const n = (i: number): number => (i < a.length ? (number(a[i]) ?? 0) : 0);
    // Web Crypto + companions — 1:1 JS surface (real WebCrypto under the hood).
    if (name.startsWith("crypto.") || name === "Uint8Array" || name.startsWith("Uint8Array.") ||
        name === "TextEncoder" || name === "TextDecoder" || name === "Array.from" ||
        name === "btoa" || name === "atob") {
      if (name === "Array.from") return arrayFrom(a, store); // reached via variable callee
      return JSECrypto.call(name, a);
    }
    // The JS core globals (URL / Date / Intl / JSON / Math / …) — see core.ts.
    if (JSECore.handles(name)) return JSECore.call(name, a);
    switch (name) {
      // SOURCE, DRAWN. The `<code>` surface needs token spans in markup, and a page cannot
      // reach the scanner any other way - so the kernel exposes it instead of every caller
      // shipping a fourth tokenizer. Pure: text in, rows of {text, kind} out.
      //
      // An OPTIONAL PLANE, like the regex engine beside it: almost no document draws source,
      // and a self-contained embed has a byte budget that a scanner nobody called would eat.
      // The define folds the branch, and the import goes with it.
      case "highlight":
        return (globalThis as typeof globalThis & { __DSX_OPTIONAL_HIGHLIGHT__?: boolean })
          .__DSX_OPTIONAL_HIGHLIGHT__ !== false ? highlightLines(s(0)) : [];
      case "upper": return s(0).toUpperCase();
      case "lower": return s(0).toLowerCase();
      case "cap": case "capitalize": return capitalizedSwift(s(0));
      case "trim": return trimWhitespaceOnly(s(0));
      case "len": case "count": {
        const f = a[0];
        if (Array.isArray(f)) return f.length;
        return charCount(s(0));
      }
      case "abs": return Math.abs(n(0));
      case "round": return roundedAwayFromZero(n(0)); // Swift .rounded() — half away from zero
      case "floor": return Math.floor(n(0));
      case "ceil": return Math.ceil(n(0));
      case "min": return swiftMin(n(0), n(1));
      case "max": return swiftMax(n(0), n(1));
      case "int": return safeInt(n(0));
      case "pad": {
        const width = Math.min(Math.max(safeInt(n(1)), 0), 64);
        const value = safeInt(n(0));
        if (width === 0) return String(value);
        const neg = value < 0;
        const digits = String(Math.abs(value));
        const padded = digits.padStart(neg ? width - 1 : width, "0");
        return neg ? "-" + padded : padded;
      }
      case "mmss": case "clock": {
        const total = safeInt(n(0));
        const neg = total < 0;
        const t = Math.abs(total);
        const two = (x: number) => String(x).padStart(2, "0");
        const body = t >= 3600
          ? `${Math.floor(t / 3600)}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}`
          : `${Math.floor(t / 60)}:${two(t % 60)}`;
        return neg ? `-${body}` : body;
      }
      case "if": return truthy(a[0]) ? (a.length > 1 ? a[1] : null) : (a.length > 2 ? a[2] : null);
      case "typeof": return typeofString(a[0]);
      case "Array.isArray": return Array.isArray(a[0]);
      case "range": {
        let lo = 0, hi = n(0), step = 1;
        if (a.length >= 2) { lo = n(0); hi = n(1); }
        if (a.length >= 3) step = n(2);
        if (step === 0 || !Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step)) return [];
        const ladder: unknown[] = [];
        let v = lo;
        while ((step > 0 ? v < hi : v > hi) && ladder.length < 10_000) { ladder.push(v); v += step; }
        return ladder;
      }
      case "String.fromCharCode": {
        let out = "";
        for (const c of a) {
          const code = safeInt(number(c) ?? 0);
          if (code >= 0 && code <= 0x10ffff) out += String.fromCharCode(code);
        }
        return out;
      }
      case "Array.of": return a.map((x) => x ?? NSNull);
      case "Number.isInteger": return typeof a[0] === "number" && Number.isFinite(a[0]) && Math.trunc(a[0]) === a[0];
      case "Number.isFinite": return typeof a[0] === "number" && Number.isFinite(a[0]);
      case "Number.isSafeInteger": return typeof a[0] === "number" && Number.isSafeInteger(a[0]);
      case "Number.isNaN": return typeof a[0] === "number" && Number.isNaN(a[0]);
      case "Number.parseInt": return JSECore.call("parseInt", a);
      case "Number.parseFloat": return JSECore.call("parseFloat", a);
      case "matches": return DSXPathMatch.matches(s(0), s(1));
      case "has": return JSESeams.moduleAvailable(s(0));
      // ── collection utilities (bounded, total) ──
      case "first": return asArray(a[0])[0] ?? null;
      case "last": { const arr = asArray(a[0]); return arr.length > 0 ? arr[arr.length - 1] : null; }
      case "reverse": return [...asArray(a[0])].reverse();
      case "sum": return asArray(a[0]).reduce<number>((acc, e) => acc + (number(e) ?? 0), 0);
      case "join": return asArray(a[0]).map((x) => string(x)).join(a.length > 1 ? s(1) : ", ");
      case "contains": return asArray(a[0]).some((x) => string(x) === s(1));
      case "keys": return isDict(a[0]) ? Object.keys(a[0] as Dict) : null;
      case "values": return isDict(a[0]) ? Object.values(a[0] as Dict) : null;
      // ── form validators (pure predicates) ──
      case "required": {
        const v = a[0];
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === "string") return trimWhitespaceOnly(v).length > 0;
        return truthy(v);
      }
      case "minLength": return (Array.isArray(a[0]) ? (a[0] as unknown[]).length : charCount(s(0))) >= safeInt(n(1));
      case "maxLength": return (Array.isArray(a[0]) ? (a[0] as unknown[]).length : charCount(s(0))) <= safeInt(n(1));
      case "regex": {
        // rides __DSX_OPTIONAL_REGEX__ (regex.ts): the detection keeps the engine for
        // any slice spelling the word, so a folded build can never reach this rule.
        if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_REGEX__?: boolean })
          .__DSX_OPTIONAL_REGEX__ === false) return false;
        const pat = s(1);
        if (reDoSProne(pat)) { console.warn(`[JSE] regex() rejected a potentially-catastrophic pattern: /${pat}/`); return false; }
        try { return new RegExp(pat).test(s(0)); } catch { return false; }
      }
      case "email": return /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i.test(s(0));
      case "phone": return /^[+]?[0-9 ()\-]{7,}$/.test(s(0));
      case "url": {
        try {
          const u = new URL(s(0));
          return u.protocol.length > 0 && u.hostname.length > 0;
        } catch { return false; }
      }
      default: return null;
    }
  },

  /** JS array/string methods called method-style. */
  applyMethod(m: string, base: unknown, a: unknown[]): unknown {
    // JS core objects first — core.ts claims the call only for ITS dict shapes.
    const handled = JSECore.method(m, base, a);
    if (handled !== null) return handled.value;
    switch (m) {
      case "includes": {
        if (asArray(base).some((x) => jseEquals(x, a[0]))) return true;
        const needle = string(a[0]);
        return needle.length > 0 && string(base).includes(needle);
      }
      case "indexOf": {
        if (typeof base === "string") {
          const needle = string(a[0]);
          if (needle.length === 0) return 0;
          const h = graphemes(base);
          const nd = graphemes(needle);
          for (let i = 0; i <= h.length - nd.length; i++) {
            let ok = true;
            for (let j = 0; j < nd.length; j++) if (h[i + j] !== nd[j]) { ok = false; break; }
            if (ok) return i;
          }
          return -1;
        }
        const i = asArray(base).findIndex((x) => jseEquals(x, a[0]));
        return i < 0 ? -1 : i;
      }
      case "localeCompare": {
        // The comparator half of string sorting. Returns -1/0/1 like the reference; the
        // ordering itself is the platform's collation, which is what makes it portable.
        const l = string(base);
        const r = string(a[0]);
        return l === r ? 0 : (l.localeCompare(r) < 0 ? -1 : 1);
      }
      case "startsWith": return string(base).startsWith(string(a[0]));
      case "endsWith": return string(base).endsWith(string(a[0]));
      case "join": {
        const sep = a.length > 0 && a[0] !== null && a[0] !== undefined ? string(a[0]) : ",";
        return asArray(base).map((x) => string(x)).join(sep);
      }
      case "reverse": return [...asArray(base)].reverse();
      case "slice": {
        const bound = (v: number | null, len: number, def: number): number => {
          if (v === null || !Number.isFinite(v)) return def;
          const i = Math.trunc(Math.min(Math.max(v, -9.0e15), 9.0e15));
          return i < 0 ? Math.max(len + i, 0) : Math.min(i, len);
        };
        if (typeof base === "string") {
          const chars = graphemes(base);
          const lo = bound(number(a[0]), chars.length, 0);
          const hi = bound(a.length > 1 ? number(a[1]) : null, chars.length, chars.length);
          return lo < hi ? chars.slice(lo, hi).join("") : "";
        }
        const arr = asArray(base);
        const lo = bound(number(a[0]), arr.length, 0);
        const hi = bound(a.length > 1 ? number(a[1]) : null, arr.length, arr.length);
        return lo < hi ? arr.slice(lo, hi) : [];
      }
      case "toUpperCase": return string(base).toUpperCase();
      case "toLowerCase": return string(base).toLowerCase();
      case "trim": return trimWhitespaceOnly(string(base));
      case "flat": {
        const raw = number(a[0]) ?? 1;
        const depth = Number.isFinite(raw) ? safeInt(raw) : 512; // flat(Infinity) = full flatten

        const flatten = (v: unknown[], d: number): unknown[] =>
          v.flatMap((e) => (Array.isArray(e) && d > 0 ? flatten(e, d - 1) : [e]));
        return flatten(asArray(base), depth);
      }
      case "concat": {
        const out = [...asArray(base)];
        for (const v of a) {
          if (Array.isArray(v)) out.push(...v);
          else if (v !== null && v !== undefined) out.push(v);
        }
        return out;
      }
      case "at": {
        const i = safeInt(number(a[0]) ?? 0);
        if (typeof base === "string") {
          const chars = graphemes(base);
          const idx = i < 0 ? chars.length + i : i;
          return idx >= 0 && idx < chars.length ? chars[idx] : null;
        }
        const arr = asArray(base);
        const idx = i < 0 ? arr.length + i : i;
        return idx >= 0 && idx < arr.length ? arr[idx] : null;
      }
      case "match": return JSERegex.match(string(base), a[0]);
      case "search": return JSERegex.search(string(base), a[0]);
      case "replace": return JSERegex.replace(string(base), a[0], string(a[1]), false);
      case "replaceAll": return JSERegex.replace(string(base), a[0], string(a[1]), true);
      case "split": {
        const limit = a.length > 1 ? safeInt(number(a[1]) ?? 0) : 0;
        return JSERegex.split(string(base), a[0], limit);
      }
      case "toString": {
        const radix = number(a[0]);
        if (radix !== null) {
          const r = Math.trunc(radix);
          if (r >= 2 && r <= 36 && r !== 10) {
            const v = number(base);
            if (v !== null) return safeInt(v).toString(r);
          }
        }
        return string(base);
      }
      case "padStart": case "padEnd": {
        const len = Math.min(safeInt(number(a[0]) ?? 0), 10_000); // bounded like repeat (Infinity saturates)
        const pad = a.length > 1 ? string(a[1]) : " ";
        const str = string(base);
        const strG = graphemes(str);
        if (pad.length === 0 || strG.length >= len) return str;
        const fill: string[] = [];
        while (fill.length + strG.length < len) fill.push(...graphemes(pad));
        const f = fill.slice(0, len - strG.length).join("");
        return m === "padStart" ? f + str : str + f;
      }
      case "toHex": {
        const d = JSECrypto.data(base);
        return d ? Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("") : null;
      }
      case "toBase64": {
        const d = JSECrypto.data(base);
        return d ? JSECrypto.base64(d) : null;
      }
      case "encode": {
        if (isDict(base) && (base as Dict)["__textEncoder"] !== undefined && (base as Dict)["__textEncoder"] !== null) {
          return JSECrypto.bytes(new TextEncoder().encode(string(a[0])));
        }
        return null;
      }
      case "decode": {
        if (isDict(base) && (base as Dict)["__textDecoder"] !== undefined && (base as Dict)["__textDecoder"] !== null) {
          const d = JSECrypto.data(a[0]);
          return d ? new TextDecoder().decode(d) : null;
        }
        return null;
      }
      case "repeat": {
        const n = Math.min(Math.max(safeInt(number(a[0]) ?? 0), 0), 10_000);
        let out = "";
        const s = string(base);
        for (let i = 0; i < n; i++) out += s;
        return out;
      }
      case "substring": {
        const chars = graphemes(string(base));
        const clamp = (v: number | null): number => {
          if (v === null || Number.isNaN(v)) return 0;
          return Math.min(Math.max(safeInt(v), 0), chars.length);
        };
        let lo = clamp(number(a[0]));
        let hi = a.length > 1 ? clamp(number(a[1])) : chars.length;
        if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
        return chars.slice(lo, hi).join("");
      }
      case "lastIndexOf": {
        if (typeof base === "string") {
          const h = graphemes(base);
          const nd = graphemes(string(a[0]));
          if (nd.length === 0) return h.length;
          for (let i = h.length - nd.length; i >= 0; i--) {
            let ok = true;
            for (let j = 0; j < nd.length; j++) if (h[i + j] !== nd[j]) { ok = false; break; }
            if (ok) return i;
          }
          return -1;
        }
        const arr = asArray(base);
        for (let i = arr.length - 1; i >= 0; i--) if (jseEquals(arr[i], a[0])) return i;
        return -1;
      }
      case "trimStart": {
        const s = string(base);
        let start = 0;
        while (start < s.length && isWhitespaceOnly(s[start]!)) start += 1;
        return s.substring(start);
      }
      case "trimEnd": {
        const s = string(base);
        let end = s.length;
        while (end > 0 && isWhitespaceOnly(s[end - 1]!)) end -= 1;
        return s.substring(0, end);
      }
      case "charAt": {
        const chars = graphemes(string(base));
        const i = safeInt(number(a[0]) ?? 0);
        return i >= 0 && i < chars.length ? chars[i]! : "";
      }
      case "charCodeAt": case "codePointAt": {
        // the CODE POINT of the i-th grapheme's first scalar — JSE has no UTF-16 halves
        const chars = graphemes(string(base));
        const i = safeInt(number(a[0]) ?? 0);
        if (i < 0 || i >= chars.length) return null;
        return chars[i]!.codePointAt(0) ?? null;
      }
      case "normalize": {
        const form = a.length > 0 ? string(a[0]) : "NFC";
        if (form !== "NFC" && form !== "NFD" && form !== "NFKC" && form !== "NFKD") return string(base);
        return string(base).normalize(form);
      }
      case "matchAll": return JSERegex.matchAll(string(base), a[0]);
      case "fill": {
        const arr = [...asArray(base)];
        const bound = (v: number | null, def: number): number => {
          if (v === null || !Number.isFinite(v)) return def;
          const i = safeInt(v);
          return i < 0 ? Math.max(arr.length + i, 0) : Math.min(i, arr.length);
        };
        const v = a.length > 0 ? a[0] ?? NSNull : NSNull;
        const lo = bound(a.length > 1 ? number(a[1]) : null, 0);
        const hi = bound(a.length > 2 ? number(a[2]) : null, arr.length);
        for (let i = lo; i < hi; i++) arr[i] = v;
        return arr;
      }
      case "toReversed": return [...asArray(base)].reverse();
      // JS pop()/shift() mutate; JSE values are value-typed on the native runtimes, so
      // the JSE spelling is the PURE read (the toReversed/toSpliced family's law): last/
      // first element out, receiver untouched. Corpus: stdlib-002.
      case "pop": return asArray(base).at(-1) ?? null;
      case "shift": return asArray(base).at(0) ?? null;
      case "with": {
        const arr = [...asArray(base)];
        let i = safeInt(number(a[0]) ?? 0);
        if (i < 0) i += arr.length;
        if (i >= 0 && i < arr.length) arr[i] = a[1] ?? NSNull;
        return arr;
      }
      case "toSpliced": {
        const arr = [...asArray(base)];
        const start = Math.min(Math.max(safeInt(number(a[0]) ?? 0), 0), arr.length);
        const del = a.length > 1 ? Math.max(safeInt(number(a[1]) ?? 0), 0) : arr.length - start;
        arr.splice(start, del, ...a.slice(2).map((x) => x ?? NSNull));
        return arr;
      }
      case "entries": return asArray(base).map((e, i) => [i, e ?? NSNull]);
      case "keys": return asArray(base).map((_, i) => i);
      case "values": return [...asArray(base)];
      case "toLocaleString": {
        // NUMBER grouping (corpus stdlib-002): deterministic en-US-style thousands
        // separators over the JSE string of the value — hand-rolled, so no platform
        // locale reaches it and three renderers print one string. Date dicts keep the
        // real locale formatting (JSECore); any other receiver keeps the null law.
        const v = number(base);
        if (v === null || isDict(base)) break;
        const txt = string(v);
        const dot = txt.indexOf(".");
        const whole = dot < 0 ? txt : txt.substring(0, dot);
        return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dot < 0 ? "" : txt.substring(dot));
      }
      case "toFixed": {
        const v = number(base);
        if (v === null || !Number.isFinite(v)) return string(base);
        if (Math.abs(v) >= 9007199254740992) return string(v); // past 2^53 fraction digits are noise — the plain coercion
        const d = Math.min(Math.max(safeInt(number(a[0]) ?? 0), 0), 100);
        const shift = Math.pow(10, d);
        const r = roundedAwayFromZero(Math.abs(v) * shift);
        const whole = Math.floor(r / shift);
        let out = String(whole);
        if (d > 0) {
          const frac = String(r - whole * shift).padStart(d, "0");
          out += "." + frac;
        }
        return (v < 0 && r > 0 ? "-" : "") + out;
      }
      default: return null;
    }
  },

  /** Bounded higher-order collection functions — total, one pass, arrow-fn callbacks. */
  higherOrder(id: string, coll: unknown, fn: StackLambda | null, store: StackStore,
              initial: unknown = null, hasInitial = false): unknown {
    const arr = asArray(coll);
    const call = (args: unknown[]): unknown => (fn ? JSE.callLambda(fn, args, store) : null);
    switch (id) {
      case "map": return arr.map((e, i) => call([e, i]) ?? NSNull);
      case "filter": return arr.filter((e, i) => truthy(call([e, i])));
      case "reject": return arr.filter((e, i) => !truthy(call([e, i])));
      case "find": return arr.find((e, i) => truthy(call([e, i]))) ?? null;
      case "some": return arr.some((e, i) => truthy(call([e, i])));
      case "every": return arr.every((e, i) => truthy(call([e, i])));
      case "forEach": { arr.forEach((e, i) => call([e, i])); return null; }
      case "sumBy": return arr.reduce<number>((acc, e, i) => acc + (number(call([e, i])) ?? 0), 0);
      case "sortBy": {
        const desc = hasInitial && string(initial) === "desc";
        return arr
          .map((e, i) => ({ e, i }))
          .sort((l, r) => {
            const x = call([l.e, l.i]);
            const y = call([r.e, r.i]);
            const nx = number(x);
            const ny = number(y);
            let cmp: number;
            if (nx !== null && ny !== null) cmp = nx < ny ? -1 : ny < nx ? 1 : 0;
            else {
              const sx = string(x);
              const sy = string(y);
              cmp = sx < sy ? -1 : sy < sx ? 1 : 0;
            }
            return desc ? -cmp : cmp;
          })
          .map((p) => p.e);
      }
      case "groupBy": {
        const groups: Dict = {};
        arr.forEach((e, i) => {
          const k = string(call([e, i]));
          const bucket = (groups[k] as unknown[] | undefined) ?? (groups[k] = []) as unknown[];
          (bucket as unknown[]).push(e);
        });
        return groups;
      }
      case "keyBy": {
        const keyed: Dict = {};
        arr.forEach((e, i) => { keyed[string(call([e, i]))] = e; });
        return keyed;
      }
      case "reduce": {
        let acc: unknown = hasInitial ? initial : arr[0] ?? null;
        let k = hasInitial ? 0 : 1;
        while (k < arr.length) { acc = call([acc, arr[k], k]); k += 1; }
        return acc;
      }
      case "sort": return JSE.sortedArray(arr, fn, store);
      case "flatMap":
        return arr.flatMap((e, i) => {
          const v = call([e, i]) ?? NSNull;
          return Array.isArray(v) ? v : [v];
        });
      case "findIndex": {
        const i = arr.findIndex((e, o) => truthy(call([e, o])));
        return i < 0 ? -1 : i;
      }
      case "findLast": {
        for (let i = arr.length - 1; i >= 0; i--) if (truthy(call([arr[i], i]))) return arr[i] ?? null;
        return null;
      }
      case "findLastIndex": {
        for (let i = arr.length - 1; i >= 0; i--) if (truthy(call([arr[i], i]))) return i;
        return -1;
      }
      case "reduceRight": {
        let acc: unknown = hasInitial ? initial : arr.length > 0 ? arr[arr.length - 1] ?? null : null;
        let k = hasInitial ? arr.length - 1 : arr.length - 2;
        while (k >= 0) { acc = call([acc, arr[k], k]); k -= 1; }
        return acc;
      }
      case "toSorted": return JSE.sortedArray(arr, fn, store); // JS ES2023 — sort was already a copy here
      default: return null;
    }
  },

  /** JS Array.prototype.sort semantics — returns a sorted COPY (value semantics). */
  sortedArray(arr: unknown[], comparator: unknown, store: StackStore): unknown[] {
    if (isLambda(comparator)) {
      return [...arr].sort((a, b) => {
        const v = number(JSE.callLambda(comparator, [a, b], store)) ?? 0;
        return v < 0 ? -1 : v > 0 ? 1 : 0;
      });
    }
    return [...arr].sort((a, b) => {
      const sa = string(a);
      const sb = string(b);
      return sa < sb ? -1 : sb < sa ? 1 : 0;
    });
  },

  /** Normalize an explicit `dsx.`-namespace prefix to its canonical scope path. */
  normalizeScope(path: string): string {
    if (!path.startsWith("dsx.")) return path;
    const body = path.substring(4);
    const dot = body.indexOf(".");
    const head = dot >= 0 ? body.substring(0, dot) : body;
    const rest = dot >= 0 ? body.substring(dot + 1) : "";
    const join = (base: string): string => (rest.length === 0 ? base : `${base}.${rest}`);
    // the style-override plane's scope word, ahead of the switch so the whole line folds
    // with its lookup branch below (define read in-condition, the markdown-fold pattern);
    // a folded build's sources author no dsx.override read, so the default arm serves
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_OVERRIDES__?: boolean })
      .__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false && head === "override") return join("override");
    switch (head) {
      case "variable": case "formula": return rest.length === 0 ? body : rest;
      case "global": return join("global");
      // app-wide constants (App.json `consts`; networking.md N0) live on the app store
      // under `const` — `dsx.const.api_url` folds to `global.const.api_url`, so the reserved
      // `global` branch below serves it (tracked read + reactive) with no extra dispatch.
      case "const": return join("global.const");
      case "screen": return join("global.screen");
      // G4 unified input (dsx-game.md §2): `dsx.input.jump` / `dsx.input.move.x` is an
      // ordinary tracked read of the app store — the input runtime publishes each declared
      // binding under `global.input.<name>`, so a markup read is reactive for free and no
      // new dispatch path exists. (`<input>` in the BODY is still the form element.)
      case "input": return join("global.input");
      case "source": return join("global.source");
      case "app": return join("global.app");
      case "route": return join("route");
      case "cookie": return join("cookie");
      case "attribute": return join("attribute");
      case "item": case "this": return join("item");
      case "element": return join("item.__element");
      case "params": return join("route.params");
      case "query": return join("route.query");
      case "path": return "route.path";
      default: return body; // dsx.event / dsx.action / unknown — handled elsewhere
    }
  },

  lookup(rawPath: string, store: StackStore, item: Item): unknown {
    // EXPLICIT namespace: `dsx.variable.x` means the surface store, full stop.
    const explicitStore = rawPath.startsWith("dsx.variable.") || rawPath.startsWith("dsx.formula.");
    const path = JSE.normalizeScope(rawPath);
    const parts = path.split(".").filter((p) => p.length > 0);
    const first = parts[0];
    if (first === undefined) return null;
    // Reserved: `os` / `platform` → the running renderer ("web" here — /web/14).
    if (parts.length === 1 && (first === "os" || first === "platform")) return JSESeams.platformOS;
    // The dsx.platform kernel constant (/web/14 + desktop-platforms.md):
    // platform.os / platform.native / platform.desktop / platform.embed.
    if (first === "platform" && parts.length === 2) {
      if (parts[1] === "os") return JSESeams.platformOS;
      if (parts[1] === "native") return JSESeams.platformOS !== "web";
      if (parts[1] === "desktop") return isDesktopOS(JSESeams.platformOS);
      if (parts[1] === "embed") return JSESeams.platformEmbed;
    }
    // Reserved: `env` → the runtime environment channel; explicit dsx.variable.env keeps
    // the author's variable.
    if (parts.length === 1 && !explicitStore && first === "env") {
      JSESeams.onGlobalRead?.("app");
      return walk(["app", "env"], JSESeams.stateVars()) ?? JSESeams.appEnvironment();
    }
    // App-wide reactive store: `global.*` is reserved. `dsx.const.*` (App.json `consts`;
    // networking.md N0) folds here via normalizeScope → `global.const.*`: seeded at boot,
    // optionally sharpened by a remote fetch, tracked under the "const" global key so a const
    // change re-materializes any request that read it (reactive, exactly like `env`).
    if (first === "global") {
      JSESeams.onGlobalRead?.(parts[1] ?? "");
      return walk(parts.slice(1), JSESeams.stateVars());
    }
    // `route.*` is a view into the navigation state.
    if (first === "route") {
      JSESeams.onGlobalRead?.("route");
      return walk(parts, JSESeams.stateVars());
    }
    // `nav.*` — the router's published back-affordance plane (canPop · depth · stack),
    // the same reserved view the native runtimes give it (Kotlin Router publishes
    // `nav` beside `route`; StackReference: "Read nav.canPop / nav.depth for back
    // affordances"). Read-only by design: the router writes it, an author reads it.
    if (first === "nav") {
      JSESeams.onGlobalRead?.("nav");
      return walk(parts, JSESeams.stateVars());
    }
    // `cookie.*` — the live cookie jar.
    if (first === "cookie") {
      JSESeams.onGlobalRead?.("cookie");
      const jar = JSESeams.cookieJar();
      return parts.length === 1 ? jar : walk(parts.slice(1), jar);
    }
    // The style-override plane: `dsx.override.<name>` — the component's declared style
    // knobs, resolved through the shared core (item __overrides -> store var -> default,
    // typed fail-open coercion; corpus OpenSource/Conformance/overrides). Reads track the
    // "dsx.override" pseudo-key, so the consumer's reactive re-seed re-runs every effect
    // that read any knob — the dsx.attribute discipline, applied to the style contract.
    // The define is read INSIDE the condition (the markdown-fold pattern): an embed build
    // pins __DSX_OPTIONAL_STYLE_OVERRIDES__ false and esbuild deletes the block, which
    // tree-shakes style-overrides.ts out of a slice that authors no knob; the read then
    // falls through to the generic lookup and answers null — fail-open, like the full path.
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_STYLE_OVERRIDES__?: boolean })
      .__DSX_OPTIONAL_STYLE_OVERRIDES__ !== false && first === "override") {
      store.onVarRead?.("dsx.override");
      const itemRaw = item ? item["__overrides"] : undefined;
      const itemOv = isDict(itemRaw) ? itemRaw : null;
      const storeRaw = store.vars.get("dsx.override");
      const storeOv = isDict(storeRaw) ? storeRaw : null;
      if (parts.length === 1) return resolveOverridePlane(store.overrideDecls.values(), itemOv, storeOv);
      const name = parts[1]!;
      const decl = store.overrideDecls.get(name);
      if (decl === undefined) return null;
      const fromItem = itemOv?.[name];
      const raw = fromItem !== undefined && fromItem !== null ? fromItem : storeOv?.[name];
      const v = resolveOverride(decl, raw);
      return parts.length === 2 ? v : walk(parts.slice(2), v);
    }
    // Explicit local scope: `item.*` / `attribute.*`.
    if (first === "item" || first === "attribute") {
      store.onVarRead?.("dsx.attribute"); // component attrs are live — track the pseudo-key
      const v = walk(parts.slice(1), item);
      if (v === null && first === "attribute" && parts.length >= 2) {
        const av = store.vars.get("dsx.attribute");
        if (isDict(av)) {
          const runtime = walk(parts.slice(1), av);
          if (runtime !== null) return runtime;
        }
      }
      if (v === null && first === "attribute" && parts.length === 2) {
        const def = store.attrDefaults.get(parts[1]!);
        //  `default=""` MEANS THE EMPTY STRING. It is an expression everywhere else, and an
        //  empty expression evaluated to null - so every `<attribute as="x" default=""/>` in
        //  the tree (27 of them, the Studio's own surfaces included) read as absent, and the
        //  usual guard `dsx.attribute.x != ''` was true for an attribute nobody set. The
        //  author wrote the empty string; this is that sentence, not a special case.
        if (def !== undefined) return def.trim() === "" ? "" : JSE.eval(def, store, item);
      }
      return v;
    }
    // Bare name: locals (attributes / row) shadow the shared store, then fall back.
    if (!explicitStore) {
      const local = item ? item[first] : undefined;
      if (local !== undefined && local !== null) {
        store.onVarRead?.("dsx.attribute"); // props are live — track the pseudo-key
        return walk(parts.slice(1), local);
      }
    }
    store.onVarRead?.(first); // signal read — dependency tracking (no-op headless)
    // Computed value — reactive, lazily evaluated in the CURRENT scope, depth-guarded.
    if (store.vars.get(first) === undefined || store.vars.get(first) === null) {
      const formula = store.computed.get(first);
      if (formula !== undefined && store.computedDepth < 32) {
        store.computedDepth += 1;
        const v = JSE.evalBlock(formula, store, item);
        store.computedDepth -= 1;
        return parts.length === 1 ? v : walk(parts.slice(1), v);
      }
    }
    // A parameterized `<formula>` — inputs evaluated in THIS scope, body over those locals.
    if (store.vars.get(first) === undefined || store.vars.get(first) === null) {
      const f = store.formulas.get(first);
      if (f !== undefined && store.computedDepth < 32) {
        store.computedDepth += 1;
        const scope: Dict = {};
        for (const [k, e] of Object.entries(f.inputs)) scope[k] = JSE.evalBlock(e, store, item) ?? NSNull;
        const v = JSE.evalBlock(f.body, store, scope);
        store.computedDepth -= 1;
        return parts.length === 1 ? v : walk(parts.slice(1), v);
      }
    }
    // A `<variable>`-declared default (evaluated once; superseded by live writes).
    if (store.vars.get(first) === undefined || store.vars.get(first) === null) {
      const initial = store.initials.get(first);
      if (initial !== undefined && initial !== null) {
        return parts.length === 1 ? initial : walk(parts.slice(1), initial);
      }
    }
    return walk(parts.slice(1), store.vars.get(first) ?? null);
  },

  // re-exported value ops (ONE table — the compiled helpers import these too)
  number, string, truthy, equals: jseEquals, compare, arith, typeofString, watchKey,
  asArray, asRows, index: indexOp, member: memberOp,
  higherOrderFns, methodFns,

  afterRender(work: () => void): void { JSESeams.afterRenderDispatch(work); },
};

function walk(parts: string[], value: unknown): unknown {
  let cur: unknown = value;
  for (const p of parts) {
    if (p === "length" && !isDict(cur)) {
      if (typeof cur === "string") { cur = charCount(cur); continue; }
      if (Array.isArray(cur)) { cur = cur.length; continue; }
    }
    if (p === "__proto__" || p === "constructor" || p === "prototype") { cur = null; continue; }
    const i = /^\d+$/.test(p) ? parseInt(p, 10) : null;
    if (i !== null && Array.isArray(cur)) {
      cur = i >= 0 && i < cur.length ? cur[i] : null;
    } else {
      cur = isDict(cur) ? ((cur as Dict)[p] ?? null) : null;
    }
  }
  return cur === undefined ? null : cur;
}

/** JS `Array.from` — an array (copied), or the `{ length: n }` array-like, with an
 *  optional mapFn; other input falls through to the crypto companion. */
function arrayFrom(a: unknown[], store: StackStore): unknown {
  const src = a[0];
  let items: unknown[];
  if (Array.isArray(src)) items = src;
  else if (isDict(src) && Object.keys(src as Dict).length === 1) {
    const len = number((src as Dict)["length"]);
    if (len === null || !Number.isFinite(len)) return JSECrypto.call("Array.from", a);
    const nn = Math.max(0, Math.min(Math.trunc(len), 10_000));
    items = new Array(nn).fill(NSNull);
  } else return JSECrypto.call("Array.from", a);
  const fn = a[1];
  if (!isLambda(fn)) return items;
  return items.map((e, i) => JSE.callLambda(fn, [e, i], store) ?? NSNull);
}

// ── the parser (direct-execution recursive descent — the reference shape) ────────────
// Exported for the ACTION RUNNER, which drives it over statement token slices (the
// JseRunner shape); markup code never constructs it directly.

export class Parser {
  pos = 0;
  depth = 0; // expression-nesting budget — see expression()
  readonly tokens: Token[];
  readonly store: StackStore;
  readonly item: Item;
  constructor(tokens: Token[], store: StackStore, item: Item) {
    this.tokens = tokens;
    this.store = store;
    this.item = item;
  }

  peek(): Token | null { return this.pos < this.tokens.length ? this.tokens[this.pos]! : null; }
  advance(): void { this.pos += 1; }
  op(s: string): boolean { const t = this.peek(); return t !== null && t.kind === "op" && t.v === s; }
  anyOp(list: string[]): string | null {
    const t = this.peek();
    return t !== null && t.kind === "op" && list.includes(t.v) ? t.v : null;
  }

  expression(): unknown {
    // a leading `;` is statement residue (a stripped comment's newline) — skip it
    while (this.op(";")) this.advance();
    // recursion budget: 500 nested parens must yield null, never a blown stack (the
    // twins share the 200 cap; past it the parse abandons — total, not fatal)
    if (this.depth >= 200) return null;
    this.depth += 1;
    const v = this.ternary();
    this.depth -= 1;
    return v;
  }

  ternary(): unknown {
    const cond = this.nullish();
    if (!this.op("?")) return cond;
    this.advance();
    const a = this.expression();
    if (this.op(":")) this.advance();
    const b = this.expression();
    return truthy(cond) ? a : b;
  }
  nullish(): unknown {
    let l = this.logicalOr();
    while (this.op("??")) { this.advance(); const r = this.logicalOr(); l = isMissing(l) ? r : l; }
    return l;
  }
  logicalOr(): unknown {
    let l = this.logicalAnd();
    while (this.op("||")) { this.advance(); const r = this.logicalAnd(); l = truthy(l) ? l : r; }
    return l;
  }
  logicalAnd(): unknown {
    let l = this.bitOr();
    while (this.op("&&")) { this.advance(); const r = this.bitOr(); l = truthy(l) ? r : l; }
    return l;
  }
  bitOr(): unknown {
    let l = this.bitXor();
    while (this.op("|")) { this.advance(); l = bitOp(l, this.bitXor(), "|"); }
    return l;
  }
  bitXor(): unknown {
    let l = this.bitAnd();
    while (this.op("^")) { this.advance(); l = bitOp(l, this.bitAnd(), "^"); }
    return l;
  }
  bitAnd(): unknown {
    let l = this.equality();
    while (this.op("&")) { this.advance(); l = bitOp(l, this.equality(), "&"); }
    return l;
  }
  equality(): unknown {
    let l: unknown = this.comparison();
    for (;;) {
      const o = this.anyOp(["===", "!==", "==", "!="]);
      if (o === null) break;
      this.advance();
      const r = this.comparison();
      const eq = jseEquals(l, r);
      l = o.startsWith("!") ? !eq : eq;
    }
    return l;
  }
  comparison(): unknown {
    let l: unknown = this.shift();
    for (;;) {
      const o = this.anyOp(["<", "<=", ">", ">="]);
      if (o !== null) {
        this.advance();
        l = compare(l, this.shift(), o);
        continue;
      }
      const t = this.peek();
      if (t !== null && t.kind === "ident" && t.v === "in") { // JS `in` — relational level
        this.advance();
        l = inOp(l, this.shift());
        continue;
      }
      break;
    }
    return l;
  }
  shift(): unknown {
    let l: unknown = this.additive();
    for (;;) {
      const o = this.anyOp(["<<", ">>", ">>>"]);
      if (o === null) break;
      this.advance();
      l = bitOp(l, this.additive(), o);
    }
    return l;
  }
  additive(): unknown {
    let l = this.multiplicative();
    for (;;) {
      const o = this.anyOp(["+", "-"]);
      if (o === null) break;
      this.advance();
      l = arith(l, this.multiplicative(), o);
    }
    return l;
  }
  multiplicative(): unknown {
    let l = this.power();
    for (;;) {
      const o = this.anyOp(["*", "/", "%"]);
      if (o === null) break;
      this.advance();
      l = arith(l, this.power(), o);
    }
    return l;
  }
  power(): unknown {
    const l = this.unary();
    if (!this.op("**")) return l;
    this.advance();
    return powOp(l, this.power()); // right-associative: 2 ** 3 ** 2 = 512
  }
  unary(): unknown {
    if (this.op("!")) { this.advance(); return !truthy(this.unary()); }
    if (this.op("-")) { this.advance(); return -(number(this.unary()) ?? 0); }
    if (this.op("+")) { this.advance(); return number(this.unary()) ?? 0; }
    if (this.op("~")) { this.advance(); return bitNot(this.unary()); }
    const t = this.peek();
    if (t !== null && t.kind === "ident" && t.v === "typeof") { this.advance(); return typeofString(this.unary()); }
    return this.primary();
  }
  primary(): unknown {
    let base = this.primaryBase();
    // Postfix chaining — `arr[i]`, `obj['k']`, `x.length`, method calls; `?.` is pure
    // sugar over the already-total member/index ops (`?.[i]` included).
    for (;;) {
      if (this.op("[")) {
        this.advance();
        const idx = this.expression();
        if (this.op("]")) this.advance();
        base = indexOp(base, idx);
      } else if (this.op(".") || this.op("?.")) {
        const optional = this.op("?.");
        this.advance();
        if (optional && this.op("(")) {
          // OPTIONAL CALL `o.f?.(…)` (syntax-005): a nullish callee short-circuits to null
          // with the ARGS UNEVALUATED — the JS rule — and a non-lambda callee answers the
          // same null where JS would throw, because JSE is total. A lambda callee falls
          // through to the call-on-value arm below, which consumes the `(` for a lambda
          // base exactly as if the `?.` had not been written.
          if (isLambda(base)) continue;
          this.skipBalanced("(", ")");
          base = null;
          continue;
        }
        if (optional && this.op("[")) {
          this.advance();
          const idx = this.expression();
          if (this.op("]")) this.advance();
          base = indexOp(base, idx);
          continue;
        }
        const mt = this.peek();
        if (mt === null || mt.kind !== "ident") break;
        let m = mt.v;
        this.advance();
        if (this.op("(")) {
          // a dotted run before the call (`arr[0].items.join(…)` — "items.join" is ONE
          // ident token): walk the leading segments as members, dispatch on the last
          if (m.includes(".")) {
            const dot = m.lastIndexOf(".");
            for (const seg of m.substring(0, dot).split(".")) base = memberOp(base, seg);
            m = m.substring(dot + 1);
          }
          this.advance();
          if (higherOrderFns.has(m)) {
            let fn: unknown = null, initVal: unknown = null, hasInit = false;
            if (!this.op(")")) {
              fn = this.expression();
              if (this.op(",")) { this.advance(); initVal = this.expression(); hasInit = true; }
            }
            if (this.op(")")) this.advance();
            base = JSE.higherOrder(m, base, isLambda(fn) ? fn : null, this.store, initVal, hasInit);
          } else {
            const args: unknown[] = [];
            if (!this.op(")")) {
              this.pushArg(args);
              while (this.op(",")) { this.advance(); this.pushArg(args); }
            }
            if (this.op(")")) this.advance();
            base = JSE.applyMethod(m, base, args);
          }
        } else if (m.includes(".")) {
          // `arr[0].x.y` — the postfix member is a dotted RUN; walk each segment
          for (const seg of m.split(".")) base = memberOp(base, seg);
        } else {
          base = memberOp(base, m);
        }
      } else if (this.op("(") && isLambda(base)) {
        // call-on-value: `((x) => x + 1)(4)` / `fs[1](5)` / curried `f(1)(2)` — the `(`
        // consumes ONLY for a lambda base (a non-lambda keeps the existing no-consume
        // behavior exactly); same 32-frame guard as the named-call route.
        this.advance();
        const args: unknown[] = [];
        if (!this.op(")")) {
          this.pushArg(args);
          while (this.op(",")) { this.advance(); this.pushArg(args); }
        }
        if (this.op(")")) this.advance();
        if (this.store.fnDepth >= 32) { base = null; continue; }
        this.store.fnDepth += 1;
        base = JSE.callLambda(base, args, this.store);
        this.store.fnDepth -= 1;
      } else break;
    }
    return base;
  }

  /** One call argument — `...expr` splices the coerced iterable (call-position spread,
   *  wave 3); shared by every arg-collection loop below. */
  pushArg(args: unknown[]): void {
    if (this.op("...")) {
      this.advance();
      args.push(...spreadValues(this.expression()));
    } else {
      args.push(this.expression());
    }
  }
  primaryBase(): unknown {
    const t = this.peek();
    if (t === null) return null;
    if (t.kind === "num") { this.advance(); return t.v; }
    if (t.kind === "str") { this.advance(); return t.v; }
    if (t.kind === "regex") {
      this.advance();
      // the dict shape rides __DSX_OPTIONAL_REGEX__ (regex.ts): a folded lexer never
      // mints a regex token, so the null arm is unreachable there by construction
      return (globalThis as typeof globalThis & { __DSX_OPTIONAL_REGEX__?: boolean })
        .__DSX_OPTIONAL_REGEX__ !== false
        ? { __regex: true, source: t.pattern, flags: t.flags }
        : null;
    }
    if (t.kind === "template") {
      // parts string-coerce and CONCATENATE (never the numeric-first `+`): `${1}${2}` = "12"
      this.advance();
      let out = "";
      for (const part of t.parts) {
        if ("s" in part) out += part.s;
        else out += string(new Parser(part.toks, this.store, this.item).expression());
      }
      return out;
    }
    if (t.kind === "ident") {
      const id = t.v;
      this.advance();
      // JS keyword transparency: `new X(…)` calls X; `await expr` in expression position
      // is the value itself — except a live Promise, which coerces to null here (the
      // runner owns real suspension; an INTERIOR await must never concat "[object Promise]").
      if (id === "new") return this.primaryBase();
      if (id === "await") {
        const v = this.primaryBase();
        return v instanceof Promise ? null : v;
      }
      if (this.op("=>")) { this.advance(); return this.arrowBody([{ name: id, keys: [] }]); }
      if (this.op("(")) {
        // JS statics that take a LAMBDA arg — matched by FULL name before the dotted split.
        if (id === "Object.groupBy" || id === "Array.from") {
          this.advance();
          const args: unknown[] = [];
          if (!this.op(")")) {
            this.pushArg(args);
            while (this.op(",")) { this.advance(); this.pushArg(args); }
          }
          if (this.op(")")) this.advance();
          if (id === "Object.groupBy") {
            const fn = args[1];
            return JSE.higherOrder("groupBy", args[0] ?? null, isLambda(fn) ? fn : null, this.store);
          }
          return arrayFrom(args, this.store);
        }
        // method on a dotted path — split the trailing `.method` off and dispatch on it.
        // (never for a JSECore-handled STATIC — `Object.keys` is not `<base>.keys()`.)
        const dot = id.lastIndexOf(".");
        if (dot >= 0 && !JSECore.handles(id)) {
          const method = id.substring(dot + 1);
          if (higherOrderFns.has(method) || methodFns.has(method)) {
            const baseVal = JSE.lookup(id.substring(0, dot), this.store, this.item);
            this.advance();
            if (higherOrderFns.has(method)) {
              let fn: unknown = null, initVal: unknown = null, hasInit = false;
              if (!this.op(")")) {
                fn = this.expression();
                if (this.op(",")) { this.advance(); initVal = this.expression(); hasInit = true; }
              }
              if (this.op(")")) this.advance();
              return JSE.higherOrder(method, baseVal, isLambda(fn) ? fn : null, this.store, initVal, hasInit);
            }
            const args: unknown[] = [];
            if (!this.op(")")) {
              this.pushArg(args);
              while (this.op(",")) { this.advance(); this.pushArg(args); }
            }
            if (this.op(")")) this.advance();
            return JSE.applyMethod(method, baseVal, args);
          }
        }
        // higher-order with an arrow/expr arg: map(coll, fn) / reduce(coll, fn, init)
        if (higherOrderFns.has(id)) {
          this.advance();
          const coll = this.expression();
          let fn: unknown = null, initVal: unknown = null, hasInit = false;
          if (this.op(",")) { this.advance(); fn = this.expression(); }
          if (this.op(",")) { this.advance(); initVal = this.expression(); hasInit = true; }
          if (this.op(")")) this.advance();
          return JSE.higherOrder(id, coll, isLambda(fn) ? fn : null, this.store, initVal, hasInit);
        }
        // a SCOPE VALUE that is a lambda is callable: `const f = x => …; f(2)` — checked
        // before the function table (JS shadowing) and the builtins; same 32-frame guard.
        // A scope lambda gets the CALLER's live scope as `base` (under its snapshot), so
        // free names — including the lambda's OWN name, absent from its creation snapshot
        // — resolve and self-recursion works; user functions stay store-resolved (no base).
        // Lookup order: scope lambda → the surface table → the GLOBAL function library
        // (a surface-local name shadows the global) → builtins.
        const scopeFn = JSE.lookup(id, this.store, this.item);
        const fromScope = isLambda(scopeFn);
        const any = fromScope ? scopeFn : (this.store.functions.get(id) ?? globalFunctions.get(id));
        if (isLambda(any)) {
          this.advance();
          const args: unknown[] = [];
          if (!this.op(")")) {
            this.pushArg(args);
            while (this.op(",")) { this.advance(); this.pushArg(args); }
          }
          if (this.op(")")) this.advance();
          if (this.store.fnDepth >= 32) return null;
          this.store.fnDepth += 1;
          const v = JSE.callLambda(any, args, this.store, fromScope ? this.item : null);
          this.store.fnDepth -= 1;
          return v;
        }
        // built-in: upper(s), round(n), count(x), …
        this.advance();
        const args: unknown[] = [];
        if (!this.op(")")) {
          this.pushArg(args);
          while (this.op(",")) { this.advance(); this.pushArg(args); }
        }
        if (this.op(")")) this.advance();
        return JSE.apply(id, args, this.store);
      }
      switch (id) {
        case "true": return true;
        case "false": return false;
        case "null": case "nil": case "undefined": return null;
        default: return JSE.lookup(id, this.store, this.item) ?? JSECore.constant(id);
      }
    }
    // t.kind === "op"
    if (t.v === "[") { // array literal (spread elements splice in — array/string/Set/Map)
      this.advance();
      const arr: unknown[] = [];
      while (this.peek() !== null && !this.op("]")) {
        if (this.op("...")) {
          this.advance();
          arr.push(...spreadValues(this.expression()));
        } else {
          arr.push(this.expression() ?? NSNull);
        }
        if (this.op(",")) this.advance();
      }
      if (this.op("]")) this.advance();
      return arr;
    }
    if (t.v === "{") { // object literal (`...dict` merges keys, last-wins)
      this.advance();
      const obj: Dict = {};
      while (this.peek() !== null && !this.op("}")) {
        if (this.op("...")) {
          this.advance();
          const src = this.expression();
          if (isDict(src)) Object.assign(obj, src as Dict);
          if (this.op(",")) this.advance();
          continue;
        }
        const kt = this.peek();
        let key: string;
        let computed = false;
        if (this.op("[")) {
          // COMPUTED KEY `{ [expr]: v }`. Without this the `[` fell to the discard arm and
          // the pair silently became something else entirely — `{ [k]: 1 }` evaluated to
          // `{ k: <value of k> }`, which is not an error anywhere, just wrong. Building a
          // dictionary under a computed name is ordinary data work (grouping, indexing,
          // renaming), so it belongs in the grammar rather than in a workaround.
          this.advance();
          key = string(this.expression());
          if (this.op("]")) this.advance();
          computed = true;
        } else if (kt !== null && kt.kind === "ident") { key = kt.v; this.advance(); }
        else if (kt !== null && kt.kind === "str") { key = kt.v; this.advance(); }
        else if (kt !== null && kt.kind === "num") { key = string(kt.v); this.advance(); }
        else { this.advance(); continue; }
        if (this.op(":")) { this.advance(); obj[key] = this.expression() ?? NSNull; }
        else if (computed) obj[key] = NSNull; // `{ [k] }` is not shorthand — there is no name to read
        else obj[key] = JSE.lookup(key, this.store, this.item) ?? NSNull; // { id } shorthand
        if (this.op(",")) this.advance();
      }
      if (this.op("}")) this.advance();
      return obj;
    }
    if (t.v === "(") {
      const lam = this.tryArrow();
      if (lam !== null) return lam;
      this.advance();
      const v = this.expression();
      if (this.op(")")) this.advance();
      return v;
    }
    this.advance();
    return null;
  }

  /** `(params) => body` — detected by an `=>` after the matching `)`. Named params take
   *  an optional `= default` (call-time, callee scope) and a `...rest` binds the
   *  remaining args as an array; destructured `{a,b}` params take neither (wave 3). */
  tryArrow(): unknown {
    let d = 0;
    let j = this.pos;
    while (j < this.tokens.length) {
      const tk = this.tokens[j]!;
      if (tk.kind === "op" && tk.v === "(") d += 1;
      else if (tk.kind === "op" && tk.v === ")") { d -= 1; if (d === 0) break; }
      j += 1;
    }
    const after = j + 1 < this.tokens.length ? this.tokens[j + 1]! : null;
    if (!(after !== null && after.kind === "op" && after.v === "=>")) return null;
    this.advance(); // '('
    const scan = parseArrowParams(this.tokens, this.pos);
    this.pos = scan.next;
    const params = scan.params;
    scan.defaults.forEach((def, k) => { if (def !== null && params[k] !== undefined) params[k]!.def = def; });
    if (this.op("=>")) this.advance();
    return this.arrowBody(params);
  }

  /** Skip past one balanced group WITHOUT evaluating anything inside — the optional-call
   *  short-circuit, where JS specifies the arguments are never evaluated. */
  skipBalanced(open: string, close: string): void {
    if (!this.op(open)) return;
    let d = 0;
    for (;;) {
      const tk = this.peek();
      if (tk === null) return;
      if (tk.kind === "op") {
        if (tk.v === open) d += 1;
        else if (tk.v === close) { d -= 1; if (d === 0) { this.advance(); return; } }
      }
      this.advance();
    }
  }

  /** Capture a balanced `{…}` / `[…]` group INCLUDING its brackets, advancing past it.
   *  Used for destructured arrow params so they read through the one pattern parser. */
  balancedGroup(): Token[] {
    const out: Token[] = [];
    let d = 0;
    for (;;) {
      const tk = this.peek();
      if (tk === null) break;
      if (tk.kind === "op") {
        if (tk.v === "{" || tk.v === "[" || tk.v === "(") d += 1;
        else if (tk.v === "}" || tk.v === "]" || tk.v === ")") d -= 1;
      }
      out.push(tk);
      this.advance();
      if (d === 0) break;
    }
    return out;
  }

  /** Capture one arrow-param default's tokens — to the next top-level `,` or the
   *  params' closing `)` (nested brackets stay whole). */
  defaultTokens(): Token[] {
    const body: Token[] = [];
    let d = 0;
    for (;;) {
      const tk = this.peek();
      if (tk === null) break;
      if (tk.kind === "op") {
        const o = tk.v;
        if (o === "(" || o === "[" || o === "{") d += 1;
        else if (o === ")" || o === "]" || o === "}") { if (d === 0) break; d -= 1; }
        else if (d === 0 && o === ",") break;
      }
      body.push(tk);
      this.advance();
    }
    return body;
  }

  /** After `=>`: capture the body — a `{ }` block or one expression — as a lambda value. */
  arrowBody(params: LambdaParam[]): unknown {
    if (this.op("{")) {
      this.advance();
      const body: Token[] = [];
      let d = 1;
      for (;;) {
        const tk = this.peek();
        if (tk === null) break;
        if (tk.kind === "op" && tk.v === "{") d += 1;
        else if (tk.kind === "op" && tk.v === "}") { d -= 1; if (d === 0) { this.advance(); break; } }
        body.push(tk);
        this.advance();
      }
      return makeLambda(params, body, true, { ...(this.item ?? {}) }); // value-semantic snapshot (Swift)
    }
    const body: Token[] = [];
    let d = 0;
    for (;;) {
      const tk = this.peek();
      if (tk === null) break;
      if (tk.kind === "op") {
        const o = tk.v;
        if (o === "(" || o === "[" || o === "{") d += 1;
        else if (o === ")" || o === "]" || o === "}") { if (d === 0) break; d -= 1; }
        else if (d === 0 && o === ",") break;
      }
      body.push(tk);
      this.advance();
    }
    return makeLambda(params, body, false, { ...(this.item ?? {}) }); // value-semantic snapshot (Swift)
  }
}

/** Split a token run on top-level commas (argument lists in block statements). */
function splitTopLevel(toks: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let d = 0;
  for (const tk of toks) {
    if (tk.kind === "op") {
      if (tk.v === "(" || tk.v === "[" || tk.v === "{") d += 1;
      else if (tk.v === ")" || tk.v === "]" || tk.v === "}") d -= 1;
      else if (d === 0 && tk.v === ",") { out.push(cur); cur = []; continue; }
    }
    cur.push(tk);
  }
  out.push(cur);
  return out;
}

/** Rebuild `container` with `parts` set to `value` — BY COPY at every level (value
 *  semantics: a block-scope path write never aliases another binding). A numeric part
 *  indexes an array (in bounds, or appends at exactly length); anything else keys a
 *  dict; a missing nest is created as a dict — total, never a throw. Corpus core-003. */
function setInLocal(container: unknown, parts: unknown[], value: unknown): unknown {
  if (parts.length === 0) return value;
  const head = parts[0];
  const rest = parts.slice(1);
  if (Array.isArray(container)) {
    const idx = number(head);
    if (idx !== null) {
      const i = Math.trunc(idx);
      const copy = [...container];
      if (i >= 0 && i < copy.length) copy[i] = setInLocal(copy[i], rest, value);
      else if (i === copy.length) copy.push(setInLocal(null, rest, value));
      return copy;
    }
  }
  const d: Dict = isDict(container) ? { ...(container as Dict) } : {};
  const key = string(head);
  d[key] = setInLocal(d[key] ?? null, rest, value);
  return d;
}

/** Walk `parts` into `container` — the read twin of setInLocal; missing → null. */
function getInLocal(container: unknown, parts: unknown[]): unknown {
  let cur: unknown = container;
  for (const p of parts) {
    if (Array.isArray(cur)) {
      const idx = number(p);
      cur = idx !== null && idx >= 0 && idx < cur.length ? cur[Math.trunc(idx)] : null;
    } else if (isDict(cur)) {
      cur = (cur as Dict)[string(p)] ?? null;
    } else {
      return null;
    }
  }
  return cur ?? null;
}

// ── BLOCK ITERATION — the optional fold (__DSX_OPTIONAL_BLOCK_ITERATION__) ──────────
//
//  Loops (corpus core-004) and block-scope mutation (corpus core-003) in expression
//  blocks. A static embed slice that the build PROVED authors no iteration folds this
//  whole module out (the __DSX_OPTIONAL_* pattern): the two impl functions below become
//  unreferenced and the minifier drops them, buying the G10 widget budget back. Folded,
//  a loop statement parses and skips and a path assignment falls to the bare-expression
//  arm — the pre-core-003/004 silence, only ever reachable where nothing authored it.

/** One loop iteration on the SHARED ledger — 10000 per block evaluation, the action
 *  runner's bounded-execution law. Past it every loop stops; the block stays total. */
function loopStep(e: JSEval): boolean {
  const b = (e.budget ??= { used: 0 });
  b.used += 1;
  return b.used <= 10000;
}

/** Run captured statements against the block's scope (shared, not copied) and its
 *  shared budget; a `return` in the body settles the block, break/continue surface
 *  as flow for the owning loop to consume. */
function runCaptured(e: JSEval, body: Token[]): void {
  const sub = new JSEval(body, e.store, e.scope, true);
  sub.budget = (e.budget ??= { used: 0 });
  sub.runBlock();
  if (sub.done) { e.result = sub.result; e.done = true; }
  e.flow = sub.flow;
}

/** Capture a loop body: a `{ … }` group (braces consumed) or one bare statement. */
function captureBranchTokens(e: JSEval): Token[] {
  if (e.isOp("{")) {
    e.i += 1;
    const out: Token[] = [];
    let d = 1;
    for (;;) {
      const tk = e.cur();
      if (tk === null) break;
      if (tk.kind === "op" && tk.v === "{") d += 1;
      else if (tk.kind === "op" && tk.v === "}") { d -= 1; if (d === 0) { e.i += 1; break; } }
      out.push(tk);
      e.i += 1;
    }
    return out;
  }
  const out = e.capture(new Set([";"]));
  if (e.isOp(";")) e.i += 1;
  return out;
}

function splitOnSemis(toks: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let d = 0;
  for (const tk of toks) {
    if (tk.kind === "op") {
      if (tk.v === "(" || tk.v === "[" || tk.v === "{") d += 1;
      else if (tk.v === ")" || tk.v === "]" || tk.v === "}") d -= 1;
      else if (d === 0 && tk.v === ";") { out.push(cur); cur = []; continue; }
    }
    cur.push(tk);
  }
  out.push(cur);
  return out;
}

/** The container a path write rebuilds from: the block's own binding, else the normal
 *  lookup (a caller-scope name copies in on first write — the evalBlock purity
 *  contract: reads shadow, writes stay local). */
function baseFor(e: JSEval, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(e.scope, name)
    ? e.scope[name]
    : e.evalExpr([{ kind: "ident", v: name } as Token]);
}

/** Evaluate path segments to keys: a static ident stays a string, a computed `[e]`
 *  evaluates in this scope. */
function evalSegs(e: JSEval, segs: Array<string | Token[]>): unknown[] {
  return segs.map((s) => (typeof s === "string" ? s : e.evalExpr(s)));
}

/** Read the value at `name.parts…` through the block's own view (scope first, then the
 *  normal lookup), missing → null — total, never a throw. */
function readAt(e: JSEval, name: string, parts: unknown[]): unknown {
  return getInLocal(baseFor(e, name), parts);
}

/** Parse and perform `NAME(seg…) op= rhs` / `NAME(seg…).push(args)`; true when handled.
 *  A dotted ident is ONE token here (`m.k`, `m.xs.push` — the tokenizer's dotted-ident
 *  rule), so static segments split out of the leading token and out of every
 *  post-bracket `.ident` run. */
function mutation(e: JSEval, toks: Token[]): boolean {
  const t0 = toks[0];
  if (toks.length < 2 || t0 === undefined || t0.kind !== "ident") return false;
  const head = t0.v.split(".");
  const name = head[0]!;
  // dsx.* / global.* / route.* / cookie.* are NAMESPACES, not block locals — a block
  // body never writes them (the evalBlock purity contract); leave those statements to
  // the bare-expression arm exactly as before.
  if (name.length === 0 || name === "dsx" || name === "global" || name === "route" || name === "cookie") return false;
  const segs: Array<string | Token[]> = head.slice(1);
  let j = 1;
  for (;;) {
    const a = toks[j];
    const b = toks[j + 1];
    if (a !== undefined && a.kind === "op" && a.v === "." && b !== undefined && b.kind === "ident") {
      for (const part of b.v.split(".")) segs.push(part);
      j += 2;
      continue;
    }
    if (a !== undefined && a.kind === "op" && a.v === "[") {
      const inner: Token[] = [];
      let d = 1;
      let k = j + 1;
      while (k < toks.length) {
        const tk = toks[k]!;
        if (tk.kind === "op" && (tk.v === "[" || tk.v === "(" || tk.v === "{")) d += 1;
        if (tk.kind === "op" && (tk.v === "]" || tk.v === ")" || tk.v === "}")) { d -= 1; if (d === 0) break; }
        inner.push(tk);
        k += 1;
      }
      if (k >= toks.length) return false;
      segs.push(inner);
      j = k + 1;
      continue;
    }
    break;
  }
  // `x++` / `m.n--` — read-modify-write through the same path law.
  const bump = toks[j];
  if (bump !== undefined && bump.kind === "op" && (bump.v === "++" || bump.v === "--") && j === toks.length - 1) {
    const parts = evalSegs(e, segs);
    const value = arith(readAt(e, name, parts), 1, bump.v === "++" ? "+" : "-");
    if (parts.length === 0) e.scope[name] = value ?? NSNull;
    else e.scope[name] = setInLocal(baseFor(e, name), parts, value ?? NSNull);
    return true;
  }
  // `path.push(a, b)` — statement-position growth of the local array (push has no pure
  // reading; pop/shift stay pure reads, stdlib-002). The whole statement must be
  // exactly the call — anything after the closing paren is a bare expression instead.
  const last = segs.length > 0 ? segs[segs.length - 1] : undefined;
  const after = toks[j];
  if (last === "push" && after !== undefined && after.kind === "op" && after.v === "(") {
    let d = 1;
    let k = j + 1;
    const inner: Token[] = [];
    while (k < toks.length) {
      const tk = toks[k]!;
      if (tk.kind === "op" && (tk.v === "(" || tk.v === "[" || tk.v === "{")) d += 1;
      if (tk.kind === "op" && (tk.v === ")" || tk.v === "]" || tk.v === "}")) { d -= 1; if (d === 0) break; }
      inner.push(tk);
      k += 1;
    }
    if (d !== 0 || k !== toks.length - 1) return false;
    segs.pop();
    const parts = evalSegs(e, segs);
    const arr = [...asArray(readAt(e, name, parts))];
    for (const argToks of splitTopLevel(inner)) if (argToks.length > 0) arr.push(e.evalExpr(argToks) ?? NSNull);
    e.scope[name] = setInLocal(baseFor(e, name), parts, arr);
    return true;
  }
  const op = toks[j];
  if (op === undefined || op.kind !== "op") return false;
  if (op.v !== "=" && op.v !== "+=" && op.v !== "-=" && op.v !== "*=" && op.v !== "/=" && op.v !== "%=") return false;
  const rhsToks = toks.slice(j + 1);
  if (rhsToks.length === 0) return false;
  const rhs = e.evalExpr(rhsToks);
  const parts = evalSegs(e, segs);
  const value = op.v === "="
    ? rhs
    : arith(readAt(e, name, parts), rhs, op.v.substring(0, 1));
  if (parts.length === 0) {
    e.scope[name] = value ?? NSNull;
    return true;
  }
  e.scope[name] = setInLocal(baseFor(e, name), parts, value ?? NSNull);
  return true;
}

/** `for (init; cond; step)` · `for ([const] pattern of expr)` · `for ([const] k in expr)`
 *  — the loop grammar in expression blocks (corpus core-004), budgeted, with the
 *  classic form gated on top-level `;` (a classic cond may contain the `in` OPERATOR). */
function forStmt(e: JSEval, execute: boolean): void {
  e.i += 1; // 'for'
  const head = e.captureParen();
  const body = captureBranchTokens(e);
  if (!execute) return;
  const parts = splitOnSemis(head);
  if (parts.length === 3) {
    runCaptured(e, parts[0]!);
    if (e.done) return;
    e.flow = undefined;
    for (;;) {
      if (parts[1]!.length > 0 && !truthy(e.evalExpr(parts[1]!))) break;
      if (!loopStep(e)) break;
      runCaptured(e, body);
      if (e.done) return;
      if (e.flow === "break") { e.flow = undefined; break; }
      e.flow = undefined;
      runCaptured(e, parts[2]!);
      if (e.done) return;
      e.flow = undefined;
    }
    return;
  }
  let p = 0;
  const first = head[p];
  if (first !== undefined && first.kind === "ident" && (first.v === "const" || first.v === "let" || first.v === "var")) p += 1;
  let kwAt = -1;
  let kind: "of" | "in" | null = null;
  let d = 0;
  for (let k = p; k < head.length; k += 1) {
    const tk = head[k]!;
    if (tk.kind === "op") {
      if (tk.v === "(" || tk.v === "[" || tk.v === "{") d += 1;
      else if (tk.v === ")" || tk.v === "]" || tk.v === "}") d -= 1;
    }
    if (d === 0 && tk.kind === "ident" && (tk.v === "of" || tk.v === "in")) { kwAt = k; kind = tk.v; break; }
  }
  if (kwAt < 0 || kind === null) return;
  const patToks = head.slice(p, kwAt);
  const exprToks = head.slice(kwAt + 1);
  const decls = parseDeclarators([...patToks, { kind: "op", v: "=" }, { kind: "num", v: 0 }]);
  if (decls.length !== 1) return;
  const pattern = decls[0]!.pattern;
  const seq = kind === "of" ? spreadValues(e.evalExpr(exprToks)) : forInKeys(e.evalExpr(exprToks));
  for (const el of seq) {
    if (!loopStep(e)) break;
    bindPattern(pattern, el, (n, v) => { e.scope[n] = v ?? NSNull; }, (dts) => e.evalExpr(dts));
    runCaptured(e, body);
    if (e.done) return;
    if (e.flow === "break") { e.flow = undefined; break; }
    e.flow = undefined;
  }
}

function whileStmt(e: JSEval, execute: boolean): void {
  e.i += 1; // 'while'
  const cond = e.captureParen();
  const body = captureBranchTokens(e);
  if (!execute) return;
  while (truthy(e.evalExpr(cond))) {
    if (!loopStep(e)) break;
    runCaptured(e, body);
    if (e.done) return;
    if (e.flow === "break") { e.flow = undefined; break; }
    e.flow = undefined;
  }
}

function doStmt(e: JSEval, execute: boolean): void {
  e.i += 1; // 'do'
  const body = captureBranchTokens(e);
  let cond: Token[] = [];
  if (e.isKw("while")) {
    e.i += 1;
    cond = e.captureParen();
    if (e.isOp(";")) e.i += 1;
  }
  if (!execute) return;
  do {
    if (!loopStep(e)) break;
    runCaptured(e, body);
    if (e.done) return;
    if (e.flow === "break") { e.flow = undefined; break; }
    e.flow = undefined;
  } while (truthy(e.evalExpr(cond)));
}

// Every gate below reads the flag INLINE (never through a const): esbuild's define
// substitutes the member access, `false !== false` folds, the gated branch drops, and
// with every reference gone the impl functions above DCE out of a folded slice.
const BLOCK_ITERATION_IMPL = {
  loop(e: JSEval, kind: "for" | "while" | "do", execute: boolean): void {
    if (kind === "for") forStmt(e, execute);
    else if (kind === "while") whileStmt(e, execute);
    else doStmt(e, execute);
  },
  mutation,
};

/** The bounded-JS statement interpreter for a `{ }` body — branches + BUDGETED loops
 *  (10000 iterations per evaluation, corpus core-004), always total. */
class JSEval {
  i = 0;
  scope: Dict;
  result: unknown = null;
  done = false;
  flow?: "break" | "continue";                // loop control in flight (consumed by its loop; absent = none)
  budget?: { used: number };                  // iteration ledger, created lazily by the impl (10k, the runner's law)

  readonly t: Token[];
  readonly store: StackStore;
  constructor(t: Token[], store: StackStore, scope: Dict, share = false) {
    this.t = t;
    this.store = store;
    this.scope = share ? scope : { ...scope }; // value-copy, like the twins
  }

  cur(): Token | null { return this.i < this.t.length ? this.t[this.i]! : null; }
  isOp(s: string): boolean { const tk = this.cur(); return tk !== null && tk.kind === "op" && tk.v === s; }
  isKw(s: string): boolean { const tk = this.cur(); return tk !== null && tk.kind === "ident" && tk.v === s; }

  runBlock(): void {
    while (!this.done && (!((globalThis as typeof globalThis & { __DSX_OPTIONAL_BLOCK_ITERATION__?: boolean }).__DSX_OPTIONAL_BLOCK_ITERATION__ !== false) || this.flow === undefined)) {
      const tk = this.cur();
      if (tk === null) return;
      if (tk.kind === "op" && tk.v === "}") return;
      if (tk.kind === "op" && tk.v === ";") { this.i += 1; continue; }
      const before = this.i;
      this.statement(true);
      if (this.i === before) this.i += 1; // never spin on a malformed statement
    }
  }
  private skipBranch(): void {
    if (this.isOp("{")) {
      let d = 0;
      for (;;) {
        const tk = this.cur();
        if (tk === null) return;
        if (tk.kind === "op" && tk.v === "{") d += 1;
        else if (tk.kind === "op" && tk.v === "}") { d -= 1; this.i += 1; if (d === 0) return; continue; }
        this.i += 1;
      }
    } else {
      for (;;) {
        const tk = this.cur();
        if (tk === null) return;
        if (tk.kind === "op" && tk.v === ";") { this.i += 1; return; }
        if (tk.kind === "op" && tk.v === "}") return;
        this.i += 1;
      }
    }
  }
  private branch(execute: boolean): void {
    if (!execute) { this.skipBranch(); return; }
    if (this.isOp("{")) {
      this.i += 1;
      this.runBlock();
      if (this.isOp("}")) this.i += 1;
    } else this.statement(true);
  }
  private statement(execute: boolean): void {
    if (this.isKw("function")) { this.skipFunction(); return; }
    if (this.isKw("if")) { this.ifStmt(execute); return; }
    // BLOCK ITERATION is an optional fold (__DSX_OPTIONAL_BLOCK_ITERATION__): a static
    // embed slice the build PROVED authors no iteration sheds the machinery; folded,
    // a loop keyword falls through to the generic statement arm — byte-for-byte the
    // pre-core-004 behavior, only ever reachable where nothing authored a loop.
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_BLOCK_ITERATION__?: boolean }).__DSX_OPTIONAL_BLOCK_ITERATION__ !== false
        && (this.isKw("for") || this.isKw("while") || this.isKw("do"))) {
      const kind = this.isKw("for") ? "for" : this.isKw("while") ? "while" : "do";
      BLOCK_ITERATION_IMPL.loop(this, kind, execute);
      return;
    }
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_BLOCK_ITERATION__?: boolean }).__DSX_OPTIONAL_BLOCK_ITERATION__ !== false
        && (this.isKw("break") || this.isKw("continue"))) {
      const f = this.isKw("break") ? "break" : "continue";
      this.i += 1;
      if (this.isOp(";")) this.i += 1;
      if (execute) this.flow = f;
      return;
    }
    if (this.isKw("const") || this.isKw("let") || this.isKw("var")) { this.declStmt(execute); return; }
    if (this.isKw("return")) { this.returnStmt(execute); return; }
    const toks = this.capture(new Set([";"]));
    if (this.isOp(";")) this.i += 1;
    if (execute && !this.done) this.exprStatement(toks);
  }
  private ifStmt(execute: boolean): void {
    this.i += 1; // 'if'
    let cond = false;
    const c = this.captureParen();
    if (execute) cond = truthy(this.evalExpr(c));
    this.branch(execute && cond);
    if (this.isKw("else")) {
      this.i += 1;
      if (this.isKw("if")) this.ifStmt(execute && !cond);
      else this.branch(execute && !cond);
    }
  }
  private declStmt(execute: boolean): void {
    this.i += 1; // 'const' / 'let' / 'var'
    const toks = this.capture(new Set([";"]));
    if (this.isOp(";")) this.i += 1;
    if (!execute) return;
    // multi-declarators + flat destructuring: `let a = 1, b = 2` · `const {x, y: r} = o` · `const [p, q] = arr`
    for (const d of parseDeclarators(toks)) {
      const v = d.expr.length === 0 ? null : this.evalExpr(d.expr);
      bindPattern(d.pattern, v, (n, val) => { this.scope[n] = val ?? NSNull; },
                  (toks) => this.evalExpr(toks));
    }
  }
  private returnStmt(execute: boolean): void {
    this.i += 1; // 'return'
    const toks = this.capture(new Set([";"]));
    if (this.isOp(";")) this.i += 1;
    if (execute) {
      this.result = toks.length === 0 ? null : this.evalExpr(toks);
      this.done = true;
    }
  }




  private skipFunction(): void {
    for (;;) {
      const tk = this.cur();
      if (tk === null) break;
      if (tk.kind === "op" && tk.v === "{") break;
      this.i += 1;
    }
    this.skipBranch();
  }
  private exprStatement(toks: Token[]): void {
    // destructuring assignment `[a, b] = [b, a]` — the declaration-less pattern write
    // (syntax-005): the same parseDeclarators shape a `const` reads, bound with the
    // assignment writer. RHS evaluates ONCE before any binding, so a swap is a swap.
    if (toks.length >= 4 && toks[0]!.kind === "op" && toks[0]!.v === "[") {
      const decls = parseDeclarators(toks);
      const d0 = decls.length === 1 ? decls[0]! : null;
      if (d0 !== null && d0.pattern.kind === "array" && d0.expr.length > 0 &&
          (d0.pattern.items.some((it) => it !== null) || d0.pattern.rest !== undefined)) {
        const v = this.evalExpr(d0.expr);
        bindPattern(d0.pattern, v, (n, val) => { this.scope[n] = val ?? NSNull; },
                    (dts) => this.evalExpr(dts));
        return;
      }
    }
    // local assignment `x = e` (single ident LHS) — the always-on core write. With the
    // fold LIVE a dotted lead ident belongs to the mutation impl below; FOLDED, the
    // historic literal-key write stands (only reachable where nothing authored iteration).
    if (toks.length >= 2) {
      const t0 = toks[0]!;
      const t1 = toks[1]!;
      if (t0.kind === "ident" && (!((globalThis as typeof globalThis & { __DSX_OPTIONAL_BLOCK_ITERATION__?: boolean }).__DSX_OPTIONAL_BLOCK_ITERATION__ !== false) || !t0.v.includes(".")) && t1.kind === "op" && t1.v === "=") {
        this.scope[t0.v] = this.evalExpr(toks.slice(2)) ?? NSNull;
        return;
      }
    }
    // BLOCK-SCOPE MUTATION (corpus core-003): dotted / computed-key / indexed assignment
    // into a scope name (`m.k = 5` · `m[r.id] = 1` · `xs[1] = 9`), compound assignment,
    // ++/--, and statement-position `.push(…)` all REBUILD the local (value semantics —
    // never an alias, never the store). This is what makes the accumulator idioms real.
    if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_BLOCK_ITERATION__?: boolean }).__DSX_OPTIONAL_BLOCK_ITERATION__ !== false) {
      const lead = toks[0];
      if (lead !== undefined && lead.kind === "op" && (lead.v === "++" || lead.v === "--")) {
        if (BLOCK_ITERATION_IMPL.mutation(this, [...toks.slice(1), lead])) return;   // prefix form → the postfix shape
      }
      if (BLOCK_ITERATION_IMPL.mutation(this, toks)) return;
    }
    this.result = this.evalExpr(toks);
  }




  capture(stops: Set<string>): Token[] {
    const out: Token[] = [];
    let d = 0;
    for (;;) {
      const tk = this.cur();
      if (tk === null) break;
      if (tk.kind === "op") {
        const o = tk.v;
        if (o === "(" || o === "[" || o === "{") { d += 1; out.push(tk); this.i += 1; continue; }
        if (o === ")" || o === "]" || o === "}") { if (d === 0) break; d -= 1; out.push(tk); this.i += 1; continue; }
        if (d === 0 && stops.has(o)) break;
      }
      out.push(tk);
      this.i += 1;
    }
    return out;
  }
  captureParen(): Token[] {
    const out: Token[] = [];
    if (!this.isOp("(")) return out;
    this.i += 1;
    let d = 1;
    for (;;) {
      const tk = this.cur();
      if (tk === null) break;
      if (tk.kind === "op" && tk.v === "(") d += 1;
      else if (tk.kind === "op" && tk.v === ")") { d -= 1; if (d === 0) { this.i += 1; break; } }
      out.push(tk);
      this.i += 1;
    }
    return out;
  }
  evalExpr(toks: Token[]): unknown {
    const p = new Parser(toks, this.store, this.scope);
    return p.expression();
  }
}

export { NSNull, isNSNull, isDict, isLambda, watchKey, setInLocal, getInLocal };
export type { Dict, StackLambda };
