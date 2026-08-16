//
//  codegen.ts - JSE → real JS. The production executor (/web/07): each extracted JSE
//  program compiles to a JS closure over an explicit scope object `$`. Operators compile
//  to SEMANTIC HELPER calls (the SWIFT semantics, not raw JS operators); identifier
//  reads go through `$.l(path)` (signal reads — dependency tracking is automatic).
//
//  The same helper library is the native escalation executor's runtime (/web/15, /web/16)
//  — one semantic table, every executor, corpus-gated. The grammar walked here is the
//  token stream of the reference tokenizer, so interpreter and compiled paths cannot
//  drift structurally: same tokens in, one dispatch shape.
//
//  Sandbox contract (/web/07): emitted code references ONLY `$` — no window, no
//  document, no globalThis. Unknown identifiers resolve through the scope object at
//  runtime, exactly like the interpreter.
//
//  Subset strictness (the W9 hardening, rendering-1.0-finalization.md): a body the
//  tier screen classifies "js" REJECTS at compile time — `JSESubsetError`, thrown
//  before the cache is touched — never a lossy emission. The eval conveniences stay
//  fail-open at RUNTIME (Article 7): catch, warn one line, run null.
//

import { cachedTokens, type Token } from "../jse/tokens.ts";
import { classifyBody } from "./tier.ts";
import { JSE, JSESeams, Parser, spreadValues, inOp, parseDeclarators, parseArrowParams, bindPattern, type DeclPattern, type StackStore, type Item } from "../jse/jse.ts";
import { JSECore } from "../jse/core.ts";
import {
  NSNull, isDict, isLambda, number, string, truthy, jseEquals, compare, arith,
  typeofString, index as indexOp, member as memberOp, isMissing, bitOp, bitNot, powOp,
  type Dict, type StackLambda, type LambdaParam,
} from "../jse/values.ts";

// ── the runtime scope object compiled code closes over ──────────────────────────────

export class CompiledScope {
  readonly store: StackStore;
  readonly item: Item;
  constructor(store: StackStore, item: Item) {
    this.store = store;
    this.item = item;
  }

  /** ident read (with the bare-ident constant fallback: Math.PI / Infinity / NaN …) */
  l(path: string): unknown {
    return JSE.lookup(path, this.store, this.item) ?? JSECore.constant(path);
  }
  /** dotted method-split base read (NO constant fallback — the reference shape) */
  lb(path: string): unknown {
    return JSE.lookup(path, this.store, this.item);
  }
  eq(a: unknown, b: unknown): boolean { return jseEquals(a, b); }
  tr(v: unknown): boolean { return truthy(v); }
  cmp(a: unknown, b: unknown, o: string): boolean { return compare(a, b, o); }
  ar(a: unknown, b: unknown, o: string): unknown { return arith(a, b, o); }
  neg(v: unknown): number { return -(number(v) ?? 0); }
  ty(v: unknown): string { return typeofString(v); }
  ix(base: unknown, idx: unknown): unknown { return indexOp(base, idx); }
  mb(base: unknown, m: string): unknown { return memberOp(base, m); }
  /** destructuring default — applied only when the position is MISSING (JSE's one absent value) */
  dflt(v: unknown, fallback: () => unknown): unknown { return isMissing(v) ? fallback() : v; }
  /** `const { a, ...rest }` — every own key the pattern did not name */
  orest(base: unknown, taken: readonly string[]): unknown {
    const out: Record<string, unknown> = {};
    if (isDict(base)) for (const [k, v] of Object.entries(base as Record<string, unknown>)) if (!taken.includes(k)) out[k] = v;
    return out;
  }
  /** `const [a, ...rest]` — the tail past the named positions */
  arest(base: unknown, from: number): unknown { return Array.isArray(base) ? base.slice(from) : []; }
  /** dotted postfix member RUN (`arr[0].x.y` — "x.y" is one ident token): walk each segment */
  mbp(base: unknown, path: string): unknown {
    let cur = base;
    for (const seg of path.split(".")) cur = memberOp(cur, seg);
    return cur;
  }
  /** expression-position `await` — a live Promise coerces to null (the runner owns real
   *  suspension; interior await must never concat "[object Promise]") */
  aw(v: unknown): unknown { return v instanceof Promise ? null : v; }
  mc(m: string, base: unknown, args: unknown[]): unknown { return JSE.applyMethod(m, base, args); }
  ho(id: string, coll: unknown, fn: unknown, init: unknown, hasInit: boolean): unknown {
    return JSE.higherOrder(id, coll, isLambda(fn) ? fn : null, this.store, init, hasInit);
  }
  /** eager `a || b` / `a && b` / `a ?? b` / ternary — the reference evaluates both sides */
  or2(a: unknown, b: unknown): unknown { return truthy(a) ? a : b; }
  and2(a: unknown, b: unknown): unknown { return truthy(a) ? b : a; }
  nsh(a: unknown, b: unknown): unknown { return isMissing(a) ? b : a; }
  tern(c: unknown, a: unknown, b: unknown): unknown { return truthy(c) ? a : b; }
  bit(a: unknown, b: unknown, o: string): number { return bitOp(a, b, o); }
  bnot(v: unknown): number { return bitNot(v); }
  pw(a: unknown, b: unknown): number { return powOp(a, b); }
  pl(v: unknown): number { return number(v) ?? 0; }
  /** the JSE string coercion (template-literal parts concatenate through this) */
  str(v: unknown): string { return string(v); }
  /** spread/for…of iterable coercion (array / string / Set / Map) */
  spr(v: unknown): unknown[] { return spreadValues(v); }
  /** object-literal spread source — a dict merges, anything else contributes nothing */
  spro(v: unknown): Dict { return isDict(v) ? (v as Dict) : {}; }
  /** JS `in` — dict key / array index membership */
  ino(l: unknown, r: unknown): boolean { return inOp(l, r); }
  /** call dispatch: a scope value that IS a lambda first (JS shadowing), then the user
   *  function table, then the GLOBAL function library (a surface-local name shadows the
   *  global; all depth-capped), then the pure builtins. A scope lambda gets the caller's
   *  live scope as `base` (under its snapshot) so self-recursion resolves — the
   *  interpreter's named-call route exactly. */
  call(name: string, args: unknown[]): unknown {
    const scopeFn = JSE.lookup(name, this.store, this.item);
    const fromScope = isLambda(scopeFn);
    const any = fromScope ? scopeFn : (this.store.functions.get(name) ?? JSE.globalFunction(name));
    if (isLambda(any)) {
      if (this.store.fnDepth >= 32) return null;
      this.store.fnDepth += 1;
      const v = JSE.callLambda(any, args, this.store, fromScope ? this.item : null);
      this.store.fnDepth -= 1;
      return v;
    }
    return JSE.apply(name, args, this.store);
  }
  /** object-literal shorthand `{ id }` — the reference does a scope lookup */
  sh(key: string): unknown { return JSE.lookup(key, this.store, this.item) ?? NSNull; }
  nul(): unknown { return NSNull; }
  /** call-on-value (IIFE / indexed callee): a lambda base invokes under the shared
   *  32-frame guard; anything else rides through UNCHANGED — the interpreter leaves the
   *  `( )` unconsumed on a non-lambda base, so the base IS the value there. */
  /** optional call `o.f?.(…)` — a nullish or non-lambda callee answers null with the args
   *  UNEVALUATED (they arrive as a thunk); a lambda callee runs exactly as inv(). */
  oinv(base: unknown, args: () => unknown[]): unknown {
    if (!isLambda(base)) return null;
    return this.inv(base, args());
  }
  inv(base: unknown, args: unknown[]): unknown {
    if (!isLambda(base)) return base;
    if (this.store.fnDepth >= 32) return null;
    this.store.fnDepth += 1;
    const v = JSE.callLambda(base, args, this.store);
    this.store.fnDepth -= 1;
    return v;
  }
  /** create a lambda VALUE backed by a real JS closure (captures this scope's item).
   *  `defs` carries COMPILED param defaults by index — evaluated at CALL time in the
   *  callee scope when the arg is missing/null, exactly the interpreter contract. */
  lam(params: LambdaParam[], body: ($s: CompiledScope) => unknown,
      defs: ((($s: CompiledScope) => unknown) | null)[] | null = null): StackLambda {
    const captured: Dict = { ...(this.item ?? {}) };
    const store = this.store;
    const lambda: StackLambda = {
      __lambda: true,
      params,
      body: [],
      block: false,
      captured,
      native: (args: unknown[], base: Dict | null): unknown => {
        // base fills UNDER the captured snapshot (the callLambda contract) — capture
        // semantics hold, and a stored lambda's own name resolves for self-recursion
        const scope: Dict = base ? { ...base } : {};
        Object.assign(scope, captured);
        params.forEach((p, k) => {
          if (p.rest === true && p.name !== null) {
            // rest binds the REMAINING args as an array (empty when none)
            scope[p.name] = k < args.length ? args.slice(k).map((x) => x ?? NSNull) : [];
            return;
          }
          const a = k < args.length ? args[k] : null;
          if (p.name !== null) {
            const dv = defs !== null && k < defs.length ? defs[k] : null;
            if (isMissing(a) && dv !== null && dv !== undefined) {
              scope[p.name] = dv(new CompiledScope(store, scope)) ?? NSNull;
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
        return body(new CompiledScope(store, scope));
      },
    };
    return lambda;
  }
  /** a child scope for compiled blocks (locals dict layered over this item). */
  block(): BlockScope { return new BlockScope(this.store, { ...(this.item ?? {}) }); }
  arrayFrom(args: unknown[]): unknown {
    return JSE.apply("Array.from", args, this.store);
  }
}

/** compiled-block scope: locals live in the item dict (the interpreter's JSEval shape). */
export class BlockScope extends CompiledScope {
  readonly locals: Dict;
  constructor(store: StackStore, locals: Dict) {
    super(store, locals);
    this.locals = locals;
  }
  set(name: string, v: unknown): void { this.locals[name] = v ?? NSNull; }
}

// ── the compiling parser (mirror of the interpreter's Parser, emitting JS source) ────

const higherOrderFns = JSE.higherOrderFns;
const methodFns = JSE.methodFns;

function q(s: string): string { return JSON.stringify(s); }

class Codegen {
  pos = 0;
  depth = 0; // expression-nesting budget — mirrors the interpreter Parser
  readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | null { return this.pos < this.tokens.length ? this.tokens[this.pos]! : null; }
  advance(): void { this.pos += 1; }
  op(s: string): boolean { const t = this.peek(); return t !== null && t.kind === "op" && t.v === s; }
  anyOp(list: string[]): string | null {
    const t = this.peek();
    return t !== null && t.kind === "op" && list.includes(t.v) ? t.v : null;
  }

  expression(): string {
    // a leading `;` is statement residue (a stripped comment's newline) — skip it
    while (this.op(";")) this.advance();
    // recursion budget — same 200 cap as the interpreter; past it emit null (total)
    if (this.depth >= 200) return "null";
    this.depth += 1;
    const v = this.ternary();
    this.depth -= 1;
    return v;
  }

  ternary(): string {
    const cond = this.nullish();
    if (!this.op("?")) return cond;
    this.advance();
    const a = this.expression();
    if (this.op(":")) this.advance();
    const b = this.expression();
    return `$.tern(${cond}, ${a}, ${b})`;
  }
  nullish(): string {
    let l = this.logicalOr();
    while (this.op("??")) { this.advance(); const r = this.logicalOr(); l = `$.nsh(${l}, ${r})`; }
    return l;
  }
  logicalOr(): string {
    let l = this.logicalAnd();
    while (this.op("||")) { this.advance(); const r = this.logicalAnd(); l = `$.or2(${l}, ${r})`; }
    return l;
  }
  logicalAnd(): string {
    let l = this.bitOr();
    while (this.op("&&")) { this.advance(); const r = this.bitOr(); l = `$.and2(${l}, ${r})`; }
    return l;
  }
  bitOr(): string {
    let l = this.bitXor();
    while (this.op("|")) { this.advance(); l = `$.bit(${l}, ${this.bitXor()}, "|")`; }
    return l;
  }
  bitXor(): string {
    let l = this.bitAnd();
    while (this.op("^")) { this.advance(); l = `$.bit(${l}, ${this.bitAnd()}, "^")`; }
    return l;
  }
  bitAnd(): string {
    let l = this.equality();
    while (this.op("&")) { this.advance(); l = `$.bit(${l}, ${this.equality()}, "&")`; }
    return l;
  }
  equality(): string {
    let l = this.comparison();
    for (;;) {
      const o = this.anyOp(["===", "!==", "==", "!="]);
      if (o === null) break;
      this.advance();
      const r = this.comparison();
      l = o.startsWith("!") ? `!$.eq(${l}, ${r})` : `$.eq(${l}, ${r})`;
    }
    return l;
  }
  comparison(): string {
    let l = this.shift();
    for (;;) {
      const o = this.anyOp(["<", "<=", ">", ">="]);
      if (o !== null) {
        this.advance();
        l = `$.cmp(${l}, ${this.shift()}, ${q(o)})`;
        continue;
      }
      const t = this.peek();
      if (t !== null && t.kind === "ident" && t.v === "in") { // JS `in` — relational level
        this.advance();
        l = `$.ino(${l}, ${this.shift()})`;
        continue;
      }
      break;
    }
    return l;
  }
  shift(): string {
    let l = this.additive();
    for (;;) {
      const o = this.anyOp(["<<", ">>", ">>>"]);
      if (o === null) break;
      this.advance();
      l = `$.bit(${l}, ${this.additive()}, ${q(o)})`;
    }
    return l;
  }
  additive(): string {
    let l = this.multiplicative();
    for (;;) {
      const o = this.anyOp(["+", "-"]);
      if (o === null) break;
      this.advance();
      l = `$.ar(${l}, ${this.multiplicative()}, ${q(o)})`;
    }
    return l;
  }
  multiplicative(): string {
    let l = this.power();
    for (;;) {
      const o = this.anyOp(["*", "/", "%"]);
      if (o === null) break;
      this.advance();
      l = `$.ar(${l}, ${this.power()}, ${q(o)})`;
    }
    return l;
  }
  power(): string {
    const l = this.unary();
    if (!this.op("**")) return l;
    this.advance();
    return `$.pw(${l}, ${this.power()})`; // right-associative
  }
  unary(): string {
    if (this.op("!")) { this.advance(); return `!$.tr(${this.unary()})`; }
    if (this.op("-")) { this.advance(); return `$.neg(${this.unary()})`; }
    if (this.op("+")) { this.advance(); return `$.pl(${this.unary()})`; }
    if (this.op("~")) { this.advance(); return `$.bnot(${this.unary()})`; }
    const t = this.peek();
    if (t !== null && t.kind === "ident" && t.v === "typeof") { this.advance(); return `$.ty(${this.unary()})`; }
    return this.primary();
  }
  primary(): string {
    let base = this.primaryBase();
    for (;;) {
      if (this.op("[")) {
        this.advance();
        const idx = this.expression();
        if (this.op("]")) this.advance();
        base = `$.ix(${base}, ${idx})`;
      } else if (this.op(".") || this.op("?.")) {
        const optional = this.op("?.");
        this.advance();
        if (optional && this.op("(")) {
          // optional call — args compile into a THUNK so a nullish callee never
          // evaluates them (the JS rule the interpreter's skipBalanced enforces)
          this.advance();
          const args = this.argList();
          base = `$.oinv(${base}, () => [${args.join(", ")}])`;
          continue;
        }
        if (optional && this.op("[")) {
          this.advance();
          const idx = this.expression();
          if (this.op("]")) this.advance();
          base = `$.ix(${base}, ${idx})`;
          continue;
        }
        const mt = this.peek();
        if (mt === null || mt.kind !== "ident") break;
        let m = mt.v;
        this.advance();
        if (this.op("(")) {
          // dotted run before the call — walk the leading segments, dispatch on the last
          if (m.includes(".")) {
            const dot = m.lastIndexOf(".");
            base = `$.mbp(${base}, ${q(m.substring(0, dot))})`;
            m = m.substring(dot + 1);
          }
          this.advance();
          if (higherOrderFns.has(m)) {
            let fn = "null", initVal = "null", hasInit = false;
            if (!this.op(")")) {
              fn = this.expression();
              if (this.op(",")) { this.advance(); initVal = this.expression(); hasInit = true; }
            }
            if (this.op(")")) this.advance();
            base = `$.ho(${q(m)}, ${base}, ${fn}, ${initVal}, ${hasInit})`;
          } else {
            const args = this.argList();
            base = `$.mc(${q(m)}, ${base}, [${args.join(", ")}])`;
          }
        } else if (m.includes(".")) {
          base = `$.mbp(${base}, ${q(m)})`; // dotted postfix run — walk each segment
        } else {
          base = `$.mb(${base}, ${q(m)})`;
        }
      } else if (this.op("(")) {
        // call-on-value: `((x) => x + 1)(4)` / `fs[1](5)` — $.inv does the isLambda
        // check at runtime (a non-lambda base rides through unchanged, mirroring the
        // interpreter's no-consume) + the guarded callLambda.
        this.advance();
        const args = this.argList();
        base = `$.inv(${base}, [${args.join(", ")}])`;
      } else break;
    }
    return base;
  }
  private argList(): string[] {
    const args: string[] = [];
    if (!this.op(")")) {
      this.pushArgCode(args);
      while (this.op(",")) { this.advance(); this.pushArgCode(args); }
    }
    if (this.op(")")) this.advance();
    return args;
  }
  /** one call argument — `...expr` splices the coerced iterable (call-position spread) */
  private pushArgCode(args: string[]): void {
    if (this.op("...")) { this.advance(); args.push(`...$.spr(${this.expression()})`); }
    else args.push(this.expression());
  }
  primaryBase(): string {
    const t = this.peek();
    if (t === null) return "null";
    if (t.kind === "num") {
      this.advance();
      if (Number.isFinite(t.v)) return String(t.v);
      // non-finite literals survive as themselves (`1e999` is Infinity on BOTH executors)
      return Number.isNaN(t.v) ? "(0/0)" : t.v > 0 ? "(1/0)" : "(-1/0)";
    }
    if (t.kind === "str") { this.advance(); return q(t.v); }
    if (t.kind === "regex") {
      this.advance();
      return `({ __regex: true, source: ${q(t.pattern)}, flags: ${q(t.flags)} })`;
    }
    if (t.kind === "template") {
      // parts string-coerce and CONCATENATE (never the numeric-first `+`)
      this.advance();
      const pieces = t.parts.map((part) =>
        "s" in part ? q(part.s) : `$.str(${compileExprTokens(part.toks)})`);
      return pieces.length === 0 ? `""` : `(${pieces.join(" + ")})`;
    }
    if (t.kind === "ident") {
      const id = t.v;
      this.advance();
      if (id === "new") return this.primaryBase();
      if (id === "await") return `$.aw(${this.primaryBase()})`; // Promise → null (interpreter parity)
      if (this.op("=>")) { this.advance(); return this.arrowBody([{ name: id, keys: [] }]); }
      if (this.op("(")) {
        if (id === "Object.groupBy" || id === "Array.from") {
          this.advance();
          const args = this.argList();
          if (id === "Object.groupBy") {
            return `$.ho("groupBy", ${args[0] ?? "null"}, ${args[1] ?? "null"}, null, false)`;
          }
          return `$.arrayFrom([${args.join(", ")}])`;
        }
        const dot = id.lastIndexOf(".");
        if (dot >= 0 && !JSECore.handles(id)) { // a JSECore STATIC is never a <base>.method()
          const method = id.substring(dot + 1);
          if (higherOrderFns.has(method) || methodFns.has(method)) {
            const baseCode = `$.lb(${q(id.substring(0, dot))})`;
            this.advance();
            if (higherOrderFns.has(method)) {
              let fn = "null", initVal = "null", hasInit = false;
              if (!this.op(")")) {
                fn = this.expression();
                if (this.op(",")) { this.advance(); initVal = this.expression(); hasInit = true; }
              }
              if (this.op(")")) this.advance();
              return `$.ho(${q(method)}, ${baseCode}, ${fn}, ${initVal}, ${hasInit})`;
            }
            const args = this.argList();
            return `$.mc(${q(method)}, ${baseCode}, [${args.join(", ")}])`;
          }
        }
        if (higherOrderFns.has(id)) {
          this.advance();
          const coll = this.expression();
          let fn = "null", initVal = "null", hasInit = false;
          if (this.op(",")) { this.advance(); fn = this.expression(); }
          if (this.op(",")) { this.advance(); initVal = this.expression(); hasInit = true; }
          if (this.op(")")) this.advance();
          return `$.ho(${q(id)}, ${coll}, ${fn}, ${initVal}, ${hasInit})`;
        }
        // user function OR builtin — runtime dispatch mirrors the interpreter's order
        this.advance();
        const args = this.argList();
        return `$.call(${q(id)}, [${args.join(", ")}])`;
      }
      switch (id) {
        case "true": return "true";
        case "false": return "false";
        case "null": case "nil": case "undefined": return "null";
        default: return `$.l(${q(id)})`;
      }
    }
    // op
    if (t.v === "[") {
      this.advance();
      const parts: string[] = [];
      while (this.peek() !== null && !this.op("]")) {
        if (this.op("...")) {
          this.advance();
          parts.push(`...$.spr(${this.expression()})`); // spread splices the coerced iterable
        } else {
          parts.push(`(${this.expression()} ?? $.nul())`);
        }
        if (this.op(",")) this.advance();
      }
      if (this.op("]")) this.advance();
      return `[${parts.join(", ")}]`;
    }
    if (t.v === "{") {
      this.advance();
      const parts: string[] = [];
      while (this.peek() !== null && !this.op("}")) {
        if (this.op("...")) {
          this.advance();
          parts.push(`...$.spro(${this.expression()})`); // dict spread merges, last-wins
          if (this.op(",")) this.advance();
          continue;
        }
        if (this.op("[")) { // computed key `{ [expr]: v }` — the interpreter's twin
          this.advance();
          const keyExpr = this.expression();
          if (this.op("]")) this.advance();
          if (this.op(":")) { this.advance(); parts.push(`[$.str(${keyExpr})]: (${this.expression()} ?? $.nul())`); }
          else parts.push(`[$.str(${keyExpr})]: $.nul()`);
          if (this.op(",")) this.advance();
          continue;
        }
        const kt = this.peek();
        let key: string;
        if (kt !== null && (kt.kind === "ident" || kt.kind === "str" || kt.kind === "num")) { key = String(kt.v); this.advance(); }
        else { this.advance(); continue; }
        if (this.op(":")) { this.advance(); parts.push(`${q(key)}: (${this.expression()} ?? $.nul())`); }
        else parts.push(`${q(key)}: $.sh(${q(key)})`); // { id } shorthand
        if (this.op(",")) this.advance();
      }
      if (this.op("}")) this.advance();
      return `({ ${parts.join(", ")} })`;
    }
    if (t.v === "(") {
      const lam = this.tryArrow();
      if (lam !== null) return lam;
      this.advance();
      const v = this.expression();
      if (this.op(")")) this.advance();
      return `(${v})`;
    }
    this.advance();
    return "null";
  }

  tryArrow(): string | null {
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
    // THE ONE scanner (jse.ts parseArrowParams) — the interpreter reads the same shapes from
    // the same code, so this tier cannot fall behind it the way it did when destructured
    // params landed.
    const scan = parseArrowParams(this.tokens, this.pos);
    this.pos = scan.next;
    const params = scan.params;
    const defCodes: (string | null)[] = scan.defaults.map(
      (def) => (def === null ? null : `($) => ${compileExprTokens(def)}`),
    );
    if (this.op("=>")) this.advance();
    return this.arrowBody(params, defCodes);
  }

  /** Capture a balanced `{…}` / `[…]` group INCLUDING its brackets — the twin of the
   *  interpreter's, so destructured params read through the one pattern parser. */
  private balancedGroup(): Token[] {
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
  private defaultTokens(): Token[] {
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

  arrowBody(params: LambdaParam[], defCodes: (string | null)[] = []): string {
    const paramsJson = JSON.stringify(params);
    // the defaults ride as a THIRD $.lam arg — an index-aligned array of compiled
    // closures (tokens would not survive the JSON param serialization)
    const defsArg = defCodes.some((c) => c !== null)
      ? `, [${defCodes.map((c) => c ?? "null").join(", ")}]`
      : "";
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
      const blockCode = compileBlockTokens(body);
      return `$.lam(${paramsJson}, ($) => ${blockCode}${defsArg})`;
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
    const g = new Codegen(body);
    return `$.lam(${paramsJson}, ($) => ${g.expression()}${defsArg})`;
  }
}

// ── block compilation (the bounded-JS statement grammar → real JS) ───────────────────

/** Compile a `{ }` statement body to an IIFE-shaped JS expression evaluated against a
 *  child BlockScope. Locals live in the scope dict (dynamic lookup parity). */
function compileBlockTokens(tokens: Token[]): string {
  const b = new BlockCompiler(tokens);
  const stmts = b.compileAll();
  return `(($b) => { const $ = $b; ${stmts} return $b.__r; })($.block())`;
}

class BlockCompiler {
  i = 0;
  readonly t: Token[];
  constructor(t: Token[]) {
    this.t = t;
  }

  cur(): Token | null { return this.i < this.t.length ? this.t[this.i]! : null; }
  isOp(s: string): boolean { const tk = this.cur(); return tk !== null && tk.kind === "op" && tk.v === s; }
  isKw(s: string): boolean { const tk = this.cur(); return tk !== null && tk.kind === "ident" && tk.v === s; }

  compileAll(): string {
    const out: string[] = [];
    for (;;) {
      const tk = this.cur();
      if (tk === null) break;
      if (tk.kind === "op" && tk.v === "}") break;
      if (tk.kind === "op" && tk.v === ";") { this.i += 1; continue; }
      const before = this.i;
      out.push(this.statement());
      if (this.i === before) this.i += 1;
    }
    return out.join(" ");
  }
  private statement(): string {
    if (this.isKw("function")) { this.skipFunction(); return ""; }
    if (this.isKw("if")) return this.ifStmt();
    if (this.isKw("const") || this.isKw("let") || this.isKw("var")) return this.declStmt();
    if (this.isKw("return")) return this.returnStmt();
    const toks = this.capture(new Set([";"]));
    if (this.isOp(";")) this.i += 1;
    return this.exprStatement(toks);
  }
  private ifStmt(): string {
    this.i += 1;
    const c = this.captureParen();
    const cond = compileExprTokens(c);
    const thenCode = this.branch();
    let elseCode = "";
    if (this.isKw("else")) {
      this.i += 1;
      if (this.isKw("if")) elseCode = this.ifStmt();
      else elseCode = this.branch();
    }
    return `if ($.tr(${cond})) { ${thenCode} }${elseCode.length > 0 ? ` else { ${elseCode} }` : ""}`;
  }
  private branch(): string {
    if (this.isOp("{")) {
      this.i += 1;
      const inner: string[] = [];
      for (;;) {
        const tk = this.cur();
        if (tk === null) break;
        if (tk.kind === "op" && tk.v === "}") { this.i += 1; break; }
        if (tk.kind === "op" && tk.v === ";") { this.i += 1; continue; }
        const before = this.i;
        inner.push(this.statement());
        if (this.i === before) this.i += 1;
      }
      return inner.join(" ");
    }
    return this.statement();
  }
  private declCounter = 0;
  private declStmt(): string {
    this.i += 1;
    const toks = this.capture(new Set([";"]));
    if (this.isOp(";")) this.i += 1;
    // multi-declarators + flat destructuring — same shapes as the interpreter's JSEval
    const out: string[] = [];
    for (const d of parseDeclarators(toks)) {
      const code = d.expr.length === 0 ? "null" : compileExprTokens(d.expr);
      if (d.pattern.kind === "ident") {
        out.push(`$.set(${q(d.pattern.name)}, ${code});`);
        continue;
      }
      const v = `$d${this.declCounter}`;
      this.declCounter += 1;
      const binds: string[] = [];
      this.emitPatternBinds(d.pattern, v, binds);
      out.push(`{ const ${v} = (${code}); ${binds.join(" ")} }`);
    }
    return out.join(" ");
  }
  /** Emit the binds for one pattern against an already-evaluated source expression.
   *  Mirrors the interpreter's `bindPattern` exactly — nesting, defaults and rest — because
   *  a body must not mean two different things depending on which tier ran it. */
  private emitPatternBinds(pattern: DeclPattern, src: string, binds: string[]): void {
    if (pattern.kind === "ident") { binds.push(`$.set(${q(pattern.name)}, ${src});`); return; }
    if (pattern.kind === "object") {
      const taken: string[] = [];
      for (const e of pattern.entries) {
        taken.push(e.key);
        const got = `$.mb(${src}, ${q(e.key)})`;
        const value = e.def === undefined ? got : `$.dflt(${got}, () => (${compileExprTokens(e.def)}))`;
        this.emitPatternBinds(e.value, value, binds);
      }
      if (pattern.rest !== undefined) binds.push(`$.set(${q(pattern.rest)}, $.orest(${src}, ${JSON.stringify(taken)}));`);
      return;
    }
    pattern.items.forEach((item, k) => {
      if (item === null) return;
      const got = `$.ix(${src}, ${k})`;
      const value = item.def === undefined ? got : `$.dflt(${got}, () => (${compileExprTokens(item.def)}))`;
      this.emitPatternBinds(item.value, value, binds);
    });
    if (pattern.rest !== undefined) binds.push(`$.set(${q(pattern.rest)}, $.arest(${src}, ${pattern.items.length}));`);
  }

  private returnStmt(): string {
    this.i += 1;
    const toks = this.capture(new Set([";"]));
    if (this.isOp(";")) this.i += 1;
    return `return ${toks.length === 0 ? "null" : compileExprTokens(toks)};`;
  }
  private skipFunction(): void {
    for (;;) {
      const tk = this.cur();
      if (tk === null) return;
      if (tk.kind === "op" && tk.v === "{") break;
      this.i += 1;
    }
    let d = 0;
    for (;;) {
      const tk = this.cur();
      if (tk === null) return;
      if (tk.kind === "op" && tk.v === "{") d += 1;
      else if (tk.kind === "op" && tk.v === "}") { d -= 1; this.i += 1; if (d === 0) return; continue; }
      this.i += 1;
    }
  }
  private exprStatement(toks: Token[]): string {
    // destructuring assignment `[a, b] = [b, a]` — the interpreter twin, emitted through
    // emitPatternBinds with the ASSIGNMENT writer ($.set is the one write both share).
    if (toks.length >= 4 && toks[0]!.kind === "op" && toks[0]!.v === "[") {
      const decls = parseDeclarators(toks);
      const d0 = decls.length === 1 ? decls[0]! : null;
      if (d0 !== null && d0.pattern.kind === "array" && d0.expr.length > 0 &&
          (d0.pattern.items.some((it) => it !== null) || d0.pattern.rest !== undefined)) {
        const v = `$d${this.declCounter}`;
        this.declCounter += 1;
        const binds: string[] = [];
        this.emitPatternBinds(d0.pattern, v, binds);
        return `{ const ${v} = (${compileExprTokens(d0.expr)}); ${binds.join(" ")} }`;
      }
    }
    if (toks.length >= 2) {
      const t0 = toks[0]!;
      const t1 = toks[1]!;
      if (t0.kind === "ident" && t1.kind === "op" && t1.v === "=") {
        return `$.set(${q(t0.v)}, ${compileExprTokens(toks.slice(2))});`;
      }
    }
    return `$b.__r = ${compileExprTokens(toks)};`;
  }
  private capture(stops: Set<string>): Token[] {
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
  private captureParen(): Token[] {
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
}

function compileExprTokens(toks: Token[]): string {
  const g = new Codegen(toks);
  return g.expression();
}

// ── the public compile surface ───────────────────────────────────────────────────────

export type CompiledProgram = {
  /** the emitted JS source — `($) => …` over the CompiledScope contract */
  code: string;
  /** the instantiated closure (dev / test convenience; build writes `code` to disk) */
  fn: (scope: CompiledScope) => unknown;
};

const exprCache = new Map<string, CompiledProgram>();

/** A beyond-subset body reached the compiler. The classifier (tier.ts) is the subset
 *  verdict; compiling past it would lossy-emit wrong behavior (the pinned W9 finding),
 *  so `compileExpression`/`compileBlock` throw this instead — carrying the classifier's
 *  reason. Runtime consumers stay fail-open (Article 7): `evalCompiled`/
 *  `evalBlockCompiled` catch it, warn, run null. */
export class JSESubsetError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`beyond the JSE subset: ${reason}`);
    this.name = "JSESubsetError";
    this.reason = reason;
  }
}

/** The strict gate: classify (cached in tier.ts), throw on a "js" verdict — BEFORE the
 *  compile cache sees anything (a thrown outcome must never be cached). */
function rejectBeyondSubset(body: string): void {
  const verdict = classifyBody(body);
  if (verdict.tier === "js") throw new JSESubsetError(verdict.reason ?? "beyond the JSE subset");
}

/** Compile one JSE expression (`{{ … }}`, visible-if, computed one-liner). */
export function compileExpression(expr: string): CompiledProgram {
  const key = "e" + expr;
  const hit = exprCache.get(key);
  if (hit) return hit;
  rejectBeyondSubset(expr);
  const toks = cachedTokens(expr.trim());
  const code = toks.length === 0 ? "null" : compileExprTokens(toks);
  const program = finalize(code);
  if (exprCache.size > 1024) exprCache.clear();
  exprCache.set(key, program);
  return program;
}

/** Compile a `<variable>`/function body (the bounded-JS block grammar). */
export function compileBlock(body: string): CompiledProgram {
  const key = "b" + body;
  const hit = exprCache.get(key);
  if (hit) return hit;
  rejectBeyondSubset(body);
  const trimmed = body.trim();
  // fast path mirrors JSE.evalBlock: a plain single expression compiles as one
  if (!trimmed.includes(";") && !trimmed.includes("\n") && !trimmed.includes("{") &&
      !trimmed.startsWith("return") && !trimmed.startsWith("const ") && !trimmed.startsWith("let ") &&
      !trimmed.startsWith("if ") && !trimmed.startsWith("if(") && !trimmed.startsWith("function")) {
    return compileExpression(trimmed);
  }
  const code = compileBlockTokens(cachedTokens(body));
  const program = finalize(code);
  if (exprCache.size > 1024) exprCache.clear();
  exprCache.set(key, program);
  return program;
}

function finalize(code: string): CompiledProgram {
  const src = `return (${code});`;
  let fn: (scope: CompiledScope) => unknown;
  try {
    const built = new Function("$", src) as (scope: CompiledScope) => unknown;
    fn = (scope) => {
      try { return built(scope); } catch (e) {
        console.warn(`[JSE compiled] runtime error: ${String(e)} in ${code.slice(0, 120)}`);
        return null;
      }
    };
  } catch (e) {
    console.warn(`[JSE compiled] compile error: ${String(e)} in ${code.slice(0, 120)}`);
    fn = () => null;
  }
  return { code, fn };
}

/** The runtime half of the strict gate: a rejection is LOUD but never a crash
 *  (Article 7) — one warn line, then null. Anything else propagates. */
function warnRejected(e: unknown): unknown {
  if (e instanceof JSESubsetError) {
    console.warn(`[JSE compiled] beyond-subset body rejected: ${e.reason} — runs null; full surfaces escalate via the JS tier`);
    return null;
  }
  throw e;
}

/** Convenience: evaluate an expression through the COMPILED path. */
export function evalCompiled(expr: string, store: StackStore, item: Item): unknown {
  let program: CompiledProgram;
  try { program = compileExpression(expr); } catch (e) { return warnRejected(e); }
  return program.fn(new CompiledScope(store, item));
}

/** Convenience: evaluate a block body through the COMPILED path. */
export function evalBlockCompiled(body: string, store: StackStore, item: Item): unknown {
  let program: CompiledProgram;
  try { program = compileBlock(body); } catch (e) { return warnRejected(e); }
  return program.fn(new CompiledScope(store, item));
}

export { JSESeams };
