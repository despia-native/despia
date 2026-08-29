/* ═════════════════════════════════════════════════════════════════════════════
   StackLogic — the Despia visual FORMULA editor. Zero dependencies. Injects its
   own scoped styles. Multiple instances safe. Headless core (compile / lift /
   evaluate run in Node with no DOM — that's how the conformance suite runs).

     const logic = new StackLogic(mountEl, {
       graph,                      // a FormulaGraph (or JSON text) …
       jse: "a > 3 ? 'big' : 'small'",   // … or JSE text, lifted into a graph
       scope: { a: 5 },            // sample data live preview evaluates against
     });
     logic.on("change", ({ graph, jse }) => save(graph, jse));

   The model in one line: the GRAPH is the editing representation, JSE TEXT is
   the artifact. `StackLogic.compile(graph)` emits deterministic JSE — the
   expression language all three Despia runtimes execute — and
   `StackLogic.lift(jse)` structures existing text back into nodes (falling
   back to a `code` node for anything beyond the vocabulary, so lift is TOTAL
   and any deck opens). Live preview per node runs through `StackLogic.jse`,
   the same corpus-gated interpreter the canvas editor ships: what the editor
   shows IS what the device computes.

   Formulas CALCTULATE (pure, left → right, one output). Actions DO (top →
   bottom step flows) — that is phase 2 of this SDK; `kind: "action"` is
   reserved in the format and rejected here.

   Events emitted: ready · change · select · deselect · preview · view
   ═════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StackLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ══ §1 · JSE runtime — the bounded expression language, interpreted like the
     native engine. Ported from @despia/canvas-editor (src/canvas-editor.js, MIT,
     same product family) so the two editors NEVER disagree; the vendored
     conformance corpus (test/run-jse-conformance.mjs) is the contract that
     keeps this port device-exact. No eval(). ══════════════════════════════════ */

  const truthy = (v) => v != null && v !== false && v !== 0 && v !== "";
  const num = (v) => { const n = Number(v); return Number.isNaN(n) ? 0 : n; };
  // JSE string coercion (the engine's all-doubles model): null/undefined → "",
  // booleans → "1"/"0" (a bool IS a double), everything else JS-stringified.
  const jseStr = (v) => (v == null ? "" : v === true ? "1" : v === false ? "0" : String(v));
  // JSE equality — the ONE coercion table `==` and `===` share (structural
  // dict/array compare, null == '' true, value-object coerced-string equality).
  function jseEquals(a, b) {
    if (a === b) return true;
    const an = a == null, bn = b == null;
    if (an && bn) return true;
    if (an || bn) return (an ? b : a) === "";
    const ao = typeof a === "object", bo = typeof b === "object";
    if (ao && bo) {
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => jseEquals(v, b[i]));
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every((k) => k in b && jseEquals(a[k], b[k]));
    }
    if (ao || bo) return String(ao ? a : b) === jseStr(ao ? b : a);
    if (typeof a === "string" && typeof b === "string") return false;
    const na = typeof a === "boolean" ? (a ? 1 : 0) : Number(a);
    const nb = typeof b === "boolean" ? (b ? 1 : 0) : Number(b);
    return na === nb;
  }

  function jseTokens(srcStr) {
    const toks = []; let i = 0; const s = String(srcStr);
    const isId = (c) => /[A-Za-z0-9_$]/.test(c);
    while (i < s.length) {
      const c = s[i];
      if (c === "\n") { if (toks.length && toks[toks.length - 1].t !== "nl") toks.push({ t: "nl" }); i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1, out = "";
        while (j < s.length && s[j] !== c) { out += s[j] === "\\" ? s[++j] : s[j]; j++; }
        toks.push({ t: "str", v: out }); i = j + 1; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
        toks.push({ t: "num", v: parseFloat(s.slice(i, j)) }); i = j; continue;
      }
      if (isId(c)) {
        let j = i; while (j < s.length && isId(s[j])) j++;
        toks.push({ t: "id", v: s.slice(i, j) }); i = j; continue;
      }
      const three = s.slice(i, i + 3), two = s.slice(i, i + 2);
      if (three === "===" || three === "!==") { toks.push({ t: "op", v: three.slice(0, 2) }); i += 3; continue; }
      if (["==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "=>"].includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
      toks.push({ t: "op", v: c }); i++;
    }
    return toks;
  }

  const ARRAY_FNS = new Set(["push", "pop", "shift", "unshift", "splice", "includes", "indexOf", "join", "slice", "concat"]);
  const HOF_FNS = new Set(["map", "filter", "find", "some", "every", "forEach", "reduce", "sortBy", "sumBy"]);
  const jseGroupBy = (xs, fn) => { const out = {}; for (const x of xs || []) { const k = fn(x); (out[k] ??= []).push(x); } return out; };
  const jseKeyBy = (xs, fn) => { const out = {}; for (const x of xs || []) out[fn(x)] = x; return out; };
  const jseSortBy = (xs, fn, dir) => {
    const keyed = (xs || []).map((el, i) => [fn ? fn(el, i) : el, el]);
    keyed.sort((a, b) => (a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0));
    const out = keyed.map((k) => k[1]);
    return dir === "desc" ? out.reverse() : out;
  };
  const jseRange = (a, b, step) => {
    const lo = b === undefined ? 0 : num(a), hi = b === undefined ? num(a) : num(b), st = step === undefined ? 1 : num(step);
    const out = [];
    if (st > 0) for (let i = lo; i < hi; i += st) out.push(i);
    else if (st < 0) for (let i = lo; i > hi; i += st) out.push(i);
    return out;   // st === 0 → [] (never an infinite loop)
  };
  const JSE_OBJECT = {
    keys: Object.keys, values: Object.values, entries: Object.entries,
    fromEntries: Object.fromEntries, assign: Object.assign, groupBy: jseGroupBy,
  };
  const JSE_ARRAY = {
    isArray: Array.isArray, of: Array.of,
    from: (src, fn) => (fn ? Array.from(src ?? [], fn) : Array.from(src ?? [])),
  };
  // Reject catastrophic-backtracking patterns — star height ≥ 2. The byte-for-byte
  // twin of the kernel's reDoSProne (jse/regex.ts · Jse.kt · Stack.swift).
  function reDoSProne(source) {
    const unboundedQuantAt = (i) => {
      const ch = source[i];
      if (ch === "*" || ch === "+") return source[i + 1] === "?" ? i + 2 : i + 1;
      if (ch === "{") {
        const close = source.indexOf("}", i);
        if (close < 0) return -1;
        if (/^\d+,$/.test(source.substring(i + 1, close))) return source[close + 1] === "?" ? close + 2 : close + 1;
      }
      return -1;
    };
    const bodyUnbounded = [];
    let inClass = false, i = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") { i += 2; continue; }
      if (inClass) { if (ch === "]") inClass = false; i += 1; continue; }
      if (ch === "[") { inClass = true; i += 1; continue; }
      if (ch === "(") { bodyUnbounded.push(false); i += 1; continue; }
      if (ch === ")") {
        const inner = bodyUnbounded.pop() ?? false;
        const q = unboundedQuantAt(i + 1);
        if (q >= 0) {
          if (inner) return true;
          if (bodyUnbounded.length > 0) bodyUnbounded[bodyUnbounded.length - 1] = true;
          i = q; continue;
        }
        i += 1; continue;
      }
      const q = unboundedQuantAt(i);
      if (q >= 0) {
        if (bodyUnbounded.length > 0) bodyUnbounded[bodyUnbounded.length - 1] = true;
        i = q; continue;
      }
      i += 1;
    }
    return false;
  }

  const GLOBALS = {
    Math, JSON, Object: JSE_OBJECT, Array: JSE_ARRAY,
    parseInt: (s) => parseInt(s, 10), parseFloat, Number, String, Boolean,
    isNaN, round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs,
    min: Math.min, max: Math.max, upper: (s) => String(s).toUpperCase(), lower: (s) => String(s).toLowerCase(),
    range: jseRange, groupBy: jseGroupBy, keyBy: jseKeyBy, sortBy: jseSortBy,
    sumBy: (xs, fn) => (xs || []).reduce((s, el, i) => s + num(fn ? fn(el, i) : el), 0),
    regex: (str, pattern) => {
      const pat = String(pattern ?? "");
      if (reDoSProne(pat)) { console.warn(`[jse] regex() rejected a potentially-catastrophic pattern: /${pat}/`); return false; }
      try { return new RegExp(pat).test(String(str ?? "")); } catch { return false; }
    },
  };
  const STRING_FNS = new Set(["includes", "startsWith", "endsWith", "toUpperCase", "toLowerCase", "trim", "slice", "split"]);
  const RET = Symbol("jse-return");

  // ctx: { rootValue(name), rootSlot(name), rootContainer(name), call(pathArr, args), callFn(fn, args, self) }
  function jseInterp(toks, ctx) {
    let p = 0;
    const locals = Object.create(null);
    const skipNl = () => { while (toks[p] && toks[p].t === "nl") p++; };
    const raw = () => toks[p];
    const peek = () => { skipNl(); return toks[p]; };
    const isOp = (v) => { skipNl(); return toks[p] && toks[p].t === "op" && toks[p].v === v; };
    const eat = (v) => (isOp(v) ? (p++, true) : false);
    const isKw = (v) => { const tk = peek(); return tk && tk.t === "id" && tk.v === v; };
    const lookup = (name) => (name in locals ? locals[name] : name in GLOBALS ? GLOBALS[name] : ctx.rootValue(name));

    function primary() {
      const tk = peek();
      if (!tk) return undefined;
      if (tk.t === "num" || tk.t === "str") { p++; return tk.v; }
      if (tk.t === "id") {
        let a2 = p + 1; while (toks[a2] && toks[a2].t === "nl") a2++;
        if (toks[a2] && toks[a2].t === "op" && toks[a2].v === "=>") {
          const params = [tk.v];
          p = a2 + 1;
          if (eat("{")) {
            const bodyStart = p; let d2 = 1;
            while (toks[p] && d2 > 0) {
              if (toks[p].t === "op" && toks[p].v === "{") d2++;
              if (toks[p].t === "op" && toks[p].v === "}") d2--;
              p++;
            }
            return { __fn: { toks: toks.slice(bodyStart, p - 1), params } };
          }
          const bodyStart = p; let d3 = 0;
          while (toks[p]) {
            const tt = toks[p];
            if (tt.t === "op" && (tt.v === "(" || tt.v === "[" || tt.v === "{")) d3++;
            else if (tt.t === "op" && (tt.v === ")" || tt.v === "]" || tt.v === "}")) { if (d3 === 0) break; d3--; }
            else if (tt.t === "op" && tt.v === "," && d3 === 0) break;
            else if (tt.t === "nl" && d3 === 0) break;
            p++;
          }
          return { __fn: { toks: toks.slice(bodyStart, p), params, expr: true } };
        }
        p++;
        if (tk.v === "true") return true;
        if (tk.v === "false") return false;
        if (tk.v === "null" || tk.v === "undefined" || tk.v === "nil") return null;
        if (tk.v === "await") return unary();
        return lookup(tk.v);
      }
      if (isOp("(")) {
        let q = p + 1, depth = 1;
        while (toks[q] && depth > 0) {
          if (toks[q].t === "op" && toks[q].v === "(") depth++;
          if (toks[q].t === "op" && toks[q].v === ")") depth--;
          q++;
        }
        let r2 = q; while (toks[r2] && toks[r2].t === "nl") r2++;
        if (toks[r2] && toks[r2].t === "op" && toks[r2].v === "=>") {
          const params = [];
          for (let j = p + 1; j < q - 1; j++) if (toks[j].t === "id") params.push(toks[j].v);
          p = r2 + 1;
          if (eat("{")) {
            const bodyStart = p;
            let d2 = 1;
            while (toks[p] && d2 > 0) {
              if (toks[p].t === "op" && toks[p].v === "{") d2++;
              if (toks[p].t === "op" && toks[p].v === "}") d2--;
              p++;
            }
            return { __fn: { toks: toks.slice(bodyStart, p - 1), params } };
          }
          const bodyStart = p;
          let d3 = 0;
          while (toks[p]) {
            const tt = toks[p];
            if (tt.t === "op" && (tt.v === "(" || tt.v === "[" || tt.v === "{")) d3++;
            else if (tt.t === "op" && (tt.v === ")" || tt.v === "]" || tt.v === "}")) { if (d3 === 0) break; d3--; }
            else if (tt.t === "op" && tt.v === "," && d3 === 0) break;
            else if (tt.t === "nl" && d3 === 0) break;
            p++;
          }
          return { __fn: { toks: toks.slice(bodyStart, p), params, expr: true } };
        }
        p++;
        const r = expr(); eat(")"); return r;
      }
      if (eat("[")) {
        const arr = [];
        while (peek() && !isOp("]")) { arr.push(expr()); if (!eat(",")) break; }
        eat("]"); return arr;
      }
      if (eat("{")) {
        const obj = {};
        while (peek() && !isOp("}")) {
          const k = peek(); p++;
          eat(":");
          obj[k.v] = expr();
          if (!eat(",")) break;
        }
        eat("}"); return obj;
      }
      p++; return undefined;
    }

    function callArgs() {
      const args = [];
      while (peek() && !isOp(")")) { args.push(expr()); if (!eat(",")) break; }
      eat(")");
      return args;
    }

    // At a NATIVE call boundary, interpreter arrows arrive as {__fn} records
    // natives can't invoke — wrap each as a real function through ctx.callFn.
    const nativeArgs = (args) =>
      ctx.callFn ? args.map((a) => (a && a.__fn ? (...xs) => ctx.callFn(a.__fn, xs, xs[0]) : a)) : args;

    function postfix() {
      let v = primary();
      for (;;) {
        if (eat(".")) {
          const id = peek(); p++;
          if (isOp("(")) {
            p++;
            const args = callArgs();
            if (v && v.__path) { v = ctx.call([...v.__path, id.v], args); continue; }
            if (Array.isArray(v) && ARRAY_FNS.has(id.v)) { v = v[id.v](...args); continue; }
            if (Array.isArray(v) && HOF_FNS.has(id.v)) {
              const fn = args[0];
              const run = ctx.callFn && fn && fn.__fn ? (el, i) => ctx.callFn(fn.__fn, [el, i], el) : () => undefined;
              switch (id.v) {
                case "map": v = v.map(run); break;
                case "filter": v = v.filter((el, i) => truthy(run(el, i))); break;
                case "find": v = v.find((el, i) => truthy(run(el, i))); break;
                case "some": v = v.some((el, i) => truthy(run(el, i))); break;
                case "every": v = v.every((el, i) => truthy(run(el, i))); break;
                case "forEach": v.forEach(run); v = undefined; break;
                case "reduce": {
                  const acc0 = args[1];
                  const rfn = ctx.callFn && fn && fn.__fn ? (acc, el, i) => ctx.callFn(fn.__fn, [acc, el, i], el) : (acc) => acc;
                  v = args.length > 1 ? v.reduce((acc, el, i) => rfn(acc, el, i), acc0) : v.reduce((acc, el, i) => rfn(acc, el, i));
                  break;
                }
                case "sortBy": { const keyed = v.map((el, i) => [run(el, i), el]); keyed.sort((a, b) => (a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0)); v = keyed.map((k) => k[1]); break; }
                case "sumBy": v = v.reduce((s, el, i) => s + num(run(el, i)), 0); break;
                default: v = undefined;
              }
              continue;
            }
            if (typeof v === "string" && STRING_FNS.has(id.v)) { v = v[id.v](...nativeArgs(args)); continue; }
            if (typeof v === "number" && id.v === "toFixed") { v = v.toFixed(...args); continue; }
            if (v && typeof v[id.v] === "function") { v = v[id.v](...nativeArgs(args)); continue; }
            v = undefined; continue;
          }
          if (v && v.__path) {
            const np = [...v.__path, id.v];
            if (id.v === "context" && np.length === 4 && np[0] === "dsx" && np[1] === "module" && ctx.moduleContext) { v = ctx.moduleContext(np[2]); continue; }
            v = { __path: np }; continue;
          }
          if (id.v === "length" && (Array.isArray(v) || typeof v === "string")) { v = v.length; continue; }
          v = v == null ? undefined : v[id.v];
          continue;
        }
        if (eat("[")) { const idx = expr(); eat("]"); v = v == null ? undefined : v[idx]; continue; }
        if (isOp("(")) {
          p++;
          const args = callArgs();
          if (v && v.__fn) { v = ctx.callFn ? ctx.callFn(v.__fn, args) : undefined; continue; }
          if (typeof v === "function") { v = v(...nativeArgs(args)); continue; }
          v = v && v.__path ? ctx.call(v.__path, args) : undefined;
          continue;
        }
        break;
      }
      return v;
    }

    function unary() {
      if (eat("!")) return !truthy(unary());
      if (eat("-")) return -num(unary());
      if (eat("+")) return num(unary());
      // typeof — engine semantics: null AND undefined both report "undefined",
      // arrays report "object".
      if (isKw("typeof")) { p++; const v = unary(); return v == null ? "undefined" : Array.isArray(v) ? "object" : typeof v; }
      return postfix();
    }
    function mul() {
      let l = unary();
      for (;;) {
        // JSE number model: division/modulo BY ZERO yields 0, never Infinity/NaN.
        if (eat("*")) l = num(l) * num(unary());
        else if (eat("/")) { const d = num(unary()); l = d === 0 ? 0 : num(l) / d; }
        else if (eat("%")) { const d = num(unary()); l = d === 0 ? 0 : num(l) % d; }
        else return l;
      }
    }
    function add() {
      let l = mul();
      for (;;) {
        if (eat("+")) { const r = mul(); l = typeof l === "string" || typeof r === "string" ? jseStr(l) + jseStr(r) : num(l) + num(r); }
        else if (eat("-")) l = num(l) - num(mul());
        else return l;
      }
    }
    function rel() {
      let l = add();
      for (;;) {
        if (eat("<")) l = l < add();
        else if (eat(">")) l = l > add();
        else if (eat("<=")) l = l <= add();
        else if (eat(">=")) l = l >= add();
        else return l;
      }
    }
    function eq() {
      // `===`/`!==` tokenize to `==`/`!=` — JSE has ONE coercion table for both.
      let l = rel();
      for (;;) {
        if (eat("==")) l = jseEquals(l, rel());
        else if (eat("!=")) l = !jseEquals(l, rel());
        else return l;
      }
    }
    function and() { let l = eq(); while (eat("&&")) { const r = eq(); l = truthy(l) ? r : l; } return l; }
    function or() { let l = and(); while (eat("||")) { const r = and(); l = truthy(l) ? l : r; } return l; }
    function expr() {
      const c = or();
      if (eat("?")) { const a = expr(); eat(":"); const b = expr(); return truthy(c) ? a : b; }
      return c;
    }

    /* statements: newline OR semicolon separation, const/let, if/else, return,
       try/catch, await, and member assignment into writable slots */
    function lvalue() {
      const save = p;
      const tk = peek();
      if (!tk || tk.t !== "id" || ["true", "false", "null", "undefined", "nil"].includes(tk.v)) return null;
      p++;
      let slot;
      if (tk.v === "dsx") {
        if (!eat(".")) { p = save; return null; }
        const seg = peek(); if (!seg || seg.t !== "id") { p = save; return null; }
        const container = ctx.rootContainer ? ctx.rootContainer(seg.v) : null;
        if (!container) { p = save; return null; }
        p++; if (!eat(".")) { p = save; return null; }
        const id0 = peek(); if (!id0 || id0.t !== "id") { p = save; return null; }
        p++; slot = { obj: container, key: id0.v };
      } else if (tk.v in locals) {
        slot = { obj: locals, key: tk.v };
      } else {
        slot = ctx.rootSlot(tk.v);
        if (!slot) { p = save; return null; }
      }
      for (;;) {
        if (eat(".")) {
          const id = peek();
          if (!id || id.t !== "id") { p = save; return null; }
          p++;
          let base = slot.obj[slot.key];
          if (base == null || typeof base !== "object") base = slot.obj[slot.key] = {};
          slot = { obj: base, key: id.v };
          continue;
        }
        if (eat("[")) {
          const idx = expr();
          if (!eat("]")) { p = save; return null; }
          const base = slot.obj[slot.key];
          if (base == null || typeof base !== "object") { p = save; return null; }
          slot = { obj: base, key: idx };
          continue;
        }
        break;
      }
      const op = peek();
      if (op && op.t === "op" && ["=", "+=", "-="].includes(op.v)) { p++; return { slot, op: op.v }; }
      p = save; return null;
    }

    function skipBlock() {
      let d = 1;
      while (toks[p] && d > 0) {
        const tk = toks[p];
        if (tk.t === "op" && (tk.v === "{" || tk.v === "(" || tk.v === "[")) d += tk.v === "{" ? 1 : 0;
        if (tk.t === "op" && tk.v === "}") d--;
        p++;
      }
    }
    function skipStmt() {
      let d = 0;
      while (toks[p]) {
        const tk = toks[p];
        if (tk.t === "op" && "([{".includes(tk.v)) d++;
        if (tk.t === "op" && ")]}".includes(tk.v)) {
          if (d === 0 && tk.v === "}") return;
          d--;
        }
        if (d === 0 && tk.t === "nl") { p++; return; }
        if (d === 0 && tk.t === "op" && tk.v === ";") { p++; return; }
        if (d === 0 && tk.t === "id" && tk.v === "else") return;
        p++;
      }
    }

    function branch(run) {
      if (eat("{")) {
        if (run) blockStatements();
        else skipBlock();
      } else if (run) stmt();
      else skipStmt();
    }

    function ifStmt(exec) {
      p++;
      eat("(");
      const c = truthy(expr());
      eat(")");
      branch(exec && c);
      if (isKw("else")) {
        p++;
        if (isKw("if")) ifStmt(exec && !c);
        else branch(exec && !c);
      }
    }

    function stmt() {
      const tk = peek();
      if (!tk) return undefined;
      if (tk.t === "id" && (tk.v === "const" || tk.v === "let")) {
        p++;
        const name = peek(); p++;
        eat("=");
        locals[name.v] = expr();
        return locals[name.v];
      }
      if (tk.t === "id" && tk.v === "if") { ifStmt(true); return undefined; }
      if (tk.t === "id" && tk.v === "return") {
        p++;
        const nxt = raw();
        const v = (!nxt || nxt.t === "nl" || (nxt.t === "op" && (nxt.v === ";" || nxt.v === "}"))) ? undefined : expr();
        throw { [RET]: true, value: v };
      }
      if (tk.t === "id" && tk.v === "try") {
        p++;
        eat("{");
        const blockStart = p;
        let err = null;
        try { blockStatements(); }
        catch (e) {
          if (e && e[RET]) throw e;
          err = e;
          p = blockStart; skipBlock();
        }
        if (isKw("catch")) {
          p++;
          let bind = null;
          if (eat("(")) { const id = peek(); p++; bind = id.v; eat(")"); }
          if (eat("{")) {
            if (err) { if (bind) locals[bind] = String(err?.message ?? err); blockStatements(); }
            else skipBlock();
          }
        }
        return undefined;
      }
      if (tk.t === "id" && tk.v === "await") { p++; return stmt(); }
      const lv = lvalue();
      if (lv) {
        const rhs = expr();
        const cur = lv.slot.obj[lv.slot.key];
        const next =
          lv.op === "=" ? rhs :
          lv.op === "+=" ? (typeof cur === "string" || typeof rhs === "string" ? String(cur ?? "") + String(rhs ?? "") : num(cur) + num(rhs)) :
          num(cur) - num(rhs);
        try { lv.slot.obj[lv.slot.key] = next; } catch (_) { /* computed: read-only */ }
        return next;
      }
      return expr();
    }

    function blockStatements() {
      for (;;) {
        skipNl();
        if (!toks[p]) return;
        if (toks[p].t === "op" && toks[p].v === "}") { p++; return; }
        if (toks[p].t === "op" && toks[p].v === ";") { p++; continue; }
        const before = p;
        stmt();
        if (p === before) p++;
      }
    }

    function statements() {
      let last;
      for (;;) {
        skipNl();
        if (!toks[p]) return last;
        if (toks[p].t === "op" && toks[p].v === ";") { p++; continue; }
        const before = p;
        last = stmt();
        if (p === before) p++;
      }
    }

    return { expr, statements };
  }

  const runArrow = (fn, ctx) => {
    try {
      const it = jseInterp(fn.toks, ctx);
      return fn.expr ? it.expr() : it.statements();
    } catch (e) { return e && e[RET] ? e.value : undefined; }
  };
  const jseEval = (srcStr, ctx) => { try { return jseInterp(jseTokens(srcStr), ctx).expr(); } catch (_) { return undefined; } };
  const jseRun = (srcStr, ctx) => {
    try { return jseInterp(jseTokens(srcStr), ctx).statements(); }
    catch (e) { return e && e[RET] ? e.value : undefined; }
  };

  /* the headless JSE seam — same contract as StackCanvas.jse (the conformance
     runner drives THIS): a pure ctx over a plain scope object. */
  function scopeCtx(scope) {
    const vars = scope && typeof scope === "object" ? scope : {};
    const ctx = {
      rootValue(name) { return name in vars ? vars[name] : undefined; },
      moduleContext(scheme) { return ((vars.moduleContext ??= {})[scheme] ??= {}); },
      rootContainer() { return null; },
      rootSlot(name) { return name in vars ? { obj: vars, key: name } : null; },
      callFn(fn, args, selfVal) {
        const outer = this;
        const params = {};
        (fn.params || []).forEach((pn, i) => { params[pn] = args[i]; });
        const inner = { ...outer };
        inner.rootValue = (nm) =>
          nm in params ? params[nm]
          : (selfVal !== undefined && nm === "$this") ? selfVal
          : outer.rootValue(nm);
        return runArrow(fn, inner);
      },
      call() { return undefined; },
    };
    return ctx;
  }

  /* ══ §2 · The catalog — the function vocabulary the palette, compiler, and
     lifter share. Labels/params are DISPLAY metadata kept here ONCE, never in
     the stored graph — so documents stay lean and diffable.
     Exactly one of call / method / expand per entry:
       call:   free function        fn(a, b)
       method: first param = target a.fn(b)
       expand: pure-JSE macro       template with {0}, {1} slots ══════════════ */
  const CATALOG = [
    { id: "upper", label: "Uppercase", group: "Text", call: "upper", params: [{ name: "String", type: "String" }], returns: "String" },
    { id: "lower", label: "Lowercase", group: "Text", call: "lower", params: [{ name: "String", type: "String" }], returns: "String" },
    { id: "capitalize", label: "Capitalize", group: "Text", expand: "upper({0}.slice(0, 1)) + {0}.slice(1)", params: [{ name: "String", type: "String" }], returns: "String" },
    { id: "trim", label: "Trim", group: "Text", method: "trim", params: [{ name: "String", type: "String" }], returns: "String" },
    { id: "split", label: "Split", group: "Text", method: "split", params: [{ name: "String", type: "String" }, { name: "Separator", type: "String" }], returns: "Array" },
    { id: "startsWith", label: "Starts with", group: "Text", method: "startsWith", params: [{ name: "String", type: "String" }, { name: "Prefix", type: "String" }], returns: "Boolean" },
    { id: "endsWith", label: "Ends with", group: "Text", method: "endsWith", params: [{ name: "String", type: "String" }, { name: "Suffix", type: "String" }], returns: "Boolean" },
    { id: "regex", label: "Matches regex", group: "Text", call: "regex", params: [{ name: "String", type: "String" }, { name: "Pattern", type: "String" }], returns: "Boolean" },

    { id: "includes", label: "Includes", group: "Lists", method: "includes", params: [{ name: "Array", type: "Array | String" }, { name: "Item", type: "Any" }], returns: "Boolean" },
    { id: "indexOf", label: "Index of", group: "Lists", method: "indexOf", params: [{ name: "Array", type: "Array | String" }, { name: "Item", type: "Any" }], returns: "Number" },
    { id: "join", label: "Join", group: "Lists", method: "join", params: [{ name: "Array", type: "Array" }, { name: "Separator", type: "String" }], returns: "String" },
    { id: "slice", label: "Slice", group: "Lists", method: "slice", params: [{ name: "Value", type: "Array | String" }, { name: "Start", type: "Number" }, { name: "End", type: "Number" }], returns: "Array | String" },
    { id: "concat", label: "Concat", group: "Lists", method: "concat", params: [{ name: "Array", type: "Array" }, { name: "Other", type: "Array" }], returns: "Array" },
    { id: "map", label: "Map", group: "Lists", method: "map", params: [{ name: "Array", type: "Array" }, { name: "Formula", type: "Function" }], returns: "Array" },
    { id: "filter", label: "Filter", group: "Lists", method: "filter", params: [{ name: "Array", type: "Array" }, { name: "Condition", type: "Function" }], returns: "Array" },
    { id: "find", label: "Find", group: "Lists", method: "find", params: [{ name: "Array", type: "Array" }, { name: "Condition", type: "Function" }], returns: "Any" },
    { id: "some", label: "Some", group: "Lists", method: "some", params: [{ name: "Array", type: "Array" }, { name: "Condition", type: "Function" }], returns: "Boolean" },
    { id: "every", label: "Every", group: "Lists", method: "every", params: [{ name: "Array", type: "Array" }, { name: "Condition", type: "Function" }], returns: "Boolean" },
    { id: "reduce", label: "Reduce", group: "Lists", method: "reduce", params: [{ name: "Array", type: "Array" }, { name: "Formula", type: "Function" }, { name: "Initial", type: "Any" }], returns: "Any" },
    { id: "sortBy", label: "Sort by", group: "Lists", call: "sortBy", params: [{ name: "Array", type: "Array" }, { name: "Key", type: "Function" }, { name: "Direction", type: "String" }], returns: "Array" },
    { id: "sumBy", label: "Sum by", group: "Lists", call: "sumBy", params: [{ name: "Array", type: "Array" }, { name: "Key", type: "Function" }], returns: "Number" },
    { id: "groupBy", label: "Group by", group: "Lists", call: "groupBy", params: [{ name: "Array", type: "Array" }, { name: "Key", type: "Function" }], returns: "Object" },
    { id: "keyBy", label: "Key by", group: "Lists", call: "keyBy", params: [{ name: "Array", type: "Array" }, { name: "Key", type: "Function" }], returns: "Object" },
    { id: "range", label: "Range", group: "Lists", call: "range", params: [{ name: "From", type: "Number" }, { name: "To", type: "Number" }, { name: "Step", type: "Number" }], returns: "Array" },

    { id: "round", label: "Round", group: "Numbers", call: "round", params: [{ name: "Number", type: "Number" }], returns: "Number" },
    { id: "floor", label: "Floor", group: "Numbers", call: "floor", params: [{ name: "Number", type: "Number" }], returns: "Number" },
    { id: "ceil", label: "Ceil", group: "Numbers", call: "ceil", params: [{ name: "Number", type: "Number" }], returns: "Number" },
    { id: "abs", label: "Absolute", group: "Numbers", call: "abs", params: [{ name: "Number", type: "Number" }], returns: "Number" },
    { id: "min", label: "Min", group: "Numbers", call: "min", params: [{ name: "First", type: "Number" }, { name: "Second", type: "Number" }], returns: "Number", variadic: true },
    { id: "max", label: "Max", group: "Numbers", call: "max", params: [{ name: "First", type: "Number" }, { name: "Second", type: "Number" }], returns: "Number", variadic: true },
    { id: "clamp", label: "Clamp", group: "Numbers", expand: "min(max({0}, {1}), {2})", params: [{ name: "Number", type: "Number" }, { name: "Min", type: "Number" }, { name: "Max", type: "Number" }], returns: "Number" },
    { id: "toFixed", label: "To fixed", group: "Numbers", method: "toFixed", params: [{ name: "Number", type: "Number" }, { name: "Digits", type: "Number" }], returns: "String" },
    { id: "parseFloat", label: "Parse number", group: "Numbers", call: "parseFloat", params: [{ name: "String", type: "String" }], returns: "Number" },

    { id: "default", label: "Default", group: "Logic", expand: "({0} == null ? {1} : {0})", params: [{ name: "Value", type: "Any" }, { name: "Fallback", type: "Any" }], returns: "Any" },
  ];
  const catalogIndex = () => {
    const byId = new Map(), byCall = new Map(), byMethod = new Map();
    for (const e of CATALOG) {
      byId.set(e.id, e);
      if (e.call) byCall.set(e.call, e);
      if (e.method && !byMethod.has(e.method)) byMethod.set(e.method, e);
    }
    return { byId, byCall, byMethod };
  };
  let CAT = catalogIndex();
  function registerCatalog(entry) {
    if (!entry || !entry.id) throw new Error("catalog entry needs an id");
    const i = CATALOG.findIndex((e) => e.id === entry.id);
    if (i >= 0) CATALOG[i] = entry; else CATALOG.push(entry);
    CAT = catalogIndex();
  }

  /* user-declared functions — the DSX `<script>`-function twin: a named body
     with declared inputs, usable as a lego node in any formula and compiled to
     a plain call. The graph document may carry them (`graph.functions`), the
     way a .dsx head carries `<script>` next to its formulas. */
  function userFnEntry(graph, name) {
    const f = (graph && graph.functions || []).find((x) => x.name === name);
    if (!f) return null;
    return {
      id: f.name, label: f.name, group: "Your formulas",
      call: f.name, user: true, body: f.body, description: f.description,
      params: (f.params || []).map((p) => (typeof p === "string" ? { name: p, type: "Any" } : p)),
      returns: "Any",
    };
  }
  const fnEntry = (graph, name) => userFnEntry(graph, name) || CAT.byId.get(name) || null;

  /* ══ §3 · Compile — graph → deterministic JSE text.
     Precedence ladder (mirrors the interpreter's grammar):
       1 ternary · 2 || · 3 && · 4 == != · 5 < > <= >= · 6 + - · 7 * / % ·
       8 unary · 9 postfix/call/member · 10 primary
     A subexpression is parenthesized iff its precedence < the position's
     minimum. Object literals additionally wrap at expression root and in
     target position (`({ a: 1 }).b`). Code ports always wrap unless they ARE
     the root. Left-assoc binaries compile the right operand one level up. ══ */
  const BIN_PREC = { "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 5, ">": 5, "<=": 5, ">=": 5, "+": 6, "-": 6, "*": 7, "/": 7, "%": 7 };
  const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z0-9_$]+)*$/;
  function fullyParenthesized(s) {
    if (s.length < 2 || s[0] !== "(" || s[s.length - 1] !== ")") return false;
    let depth = 0, quote = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') quote = c;
      else if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0 && i < s.length - 1) return false; }
    }
    return depth === 0;
  }

  function litText(v, pos) {
    if (v === null || v === undefined) return { text: "null", prec: 10 };
    if (v === true) return { text: "true", prec: 10 };
    if (v === false) return { text: "false", prec: 10 };
    if (typeof v === "number") {
      const t = Number.isFinite(v) ? String(v) : "0";
      return v < 0 ? { text: t, prec: 8 } : { text: t, prec: 10 };
    }
    if (typeof v === "string") return { text: "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'", prec: 10 };
    if (Array.isArray(v)) return { text: "[" + v.map((x) => litText(x, "arg").text).join(", ") + "]", prec: 10 };
    if (typeof v === "object") {
      const body = Object.keys(v).map((k) => objKey(k) + ": " + litText(v[k], "arg").text).join(", ");
      const inner = body ? "{ " + body + " }" : "{}";
      return { text: pos === "root" || pos === "target" ? "(" + inner + ")" : inner, prec: 10 };
    }
    throw new Error("uncompilable literal: " + typeof v);
  }
  const objKey = (k) => (IDENT_RE.test(k) ? k : "'" + String(k).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'");

  function compileGraph(graph) {
    if (!graph || typeof graph !== "object") throw new Error("compile: not a graph");
    if (graph.kind === "action") throw new Error("compile: kind 'action' is reserved for phase 2 — this editor compiles formulas");
    if (!graph.out) return "";
    return compilePort(graph.out, graph, 1, "root", new Set());
  }

  function compilePort(port, graph, minPrec, pos, active) {
    if (!port || typeof port !== "object") throw new Error("compile: bad port");
    if ("node" in port) {
      const node = (graph.nodes || {})[port.node];
      if (!node) throw new Error("compile: missing node '" + port.node + "'");
      if (active.has(port.node)) throw new Error("compile: cycle through '" + port.node + "'");
      active.add(port.node);
      try { return compileNode(node, graph, minPrec, pos, active); }
      finally { active.delete(port.node); }
    }
    if ("code" in port) {
      const src = String(port.code).trim();
      if (!src) return pos === "root" ? "" : "null";
      if (pos === "root" && minPrec <= 1) return src;
      // idempotent wrapping (P3 convergence): already-parenthesized code never re-wraps
      return fullyParenthesized(src) ? src : "(" + src + ")";
    }
    if ("value" in port) {
      const lit = litText(port.value, pos);
      return lit.prec < minPrec ? "(" + lit.text + ")" : lit.text;
    }
    throw new Error("compile: port needs node | value | code");
  }

  function compileNode(node, graph, minPrec, pos, active) {
    const wrap = (text, prec) => (prec < minPrec ? "(" + text + ")" : text);
    const arg = (p, mp = 1, ps = "arg") => compilePort(p ?? { value: null }, graph, mp, ps, active);
    switch (node.kind) {
      case "path": {
        if (!PATH_RE.test(node.path || "")) throw new Error("compile: bad path '" + node.path + "'");
        return node.path;
      }
      case "value": return compilePort({ value: node.value }, graph, minPrec, pos, active);
      case "code": return compilePort({ code: node.jse }, graph, minPrec, pos, active);
      case "op": {
        if (node.op === "!" || node.op === "neg") {
          const t = (node.op === "!" ? "!" : "-") + arg(node.args && node.args[0], 8);
          return wrap(t, 8);
        }
        const prec = BIN_PREC[node.op];
        if (!prec) throw new Error("compile: unknown op '" + node.op + "'");
        const l = arg(node.args && node.args[0], prec);
        const r = arg(node.args && node.args[1], prec + 1);
        return wrap(l + " " + node.op + " " + r, prec);
      }
      case "if": {
        const cases = node.cases || [];
        if (!cases.length) return arg(node.else, minPrec, pos);
        let text = "";
        for (const c of cases) text += arg(c.when, 2) + " ? " + arg(c.then, 2) + " : ";
        text += arg(node.else, 1);
        return wrap(text, 1);
      }
      case "fn": {
        const entry = fnEntry(graph, node.fn);
        if (!entry) throw new Error("compile: unknown fn '" + node.fn + "'");
        const args = node.args || [];
        if (entry.expand) {
          const t = entry.expand.replace(/\{(\d+)\}/g, (_, i) => arg(args[Number(i)], 9, "target"));
          return wrap(t, 1);
        }
        if (entry.method) {
          const target = arg(args[0], 9, "target");
          const rest = args.slice(1).map((a) => arg(a));
          return wrap(target + "." + entry.method + "(" + rest.join(", ") + ")", 9);
        }
        return wrap(entry.call + "(" + args.map((a) => arg(a)).join(", ") + ")", 9);
      }
      case "method": {
        if (!IDENT_RE.test(node.method || "")) throw new Error("compile: bad method name");
        const target = arg(node.target, 9, "target");
        return wrap(target + "." + node.method + "(" + (node.args || []).map((a) => arg(a)).join(", ") + ")", 9);
      }
      case "get": {
        if (!/^[A-Za-z0-9_$]+(\.[A-Za-z0-9_$]+)*$/.test(node.path || "")) throw new Error("compile: bad get path");
        return wrap(arg(node.target, 9, "target") + "." + node.path, 9);
      }
      case "object": {
        const body = (node.entries || []).map((e) => objKey(e.key) + ": " + arg(e.value)).join(", ");
        const inner = body ? "{ " + body + " }" : "{}";
        return pos === "root" || pos === "target" ? "(" + inner + ")" : inner;
      }
      case "array": return "[" + (node.items || []).map((i) => arg(i)).join(", ") + "]";
      case "arrow": {
        const params = node.params || [];
        const head = params.length === 1 ? params[0] : "(" + params.join(", ") + ")";
        const t = head + " => " + arg(node.body, 2);
        return wrap(t, 1);
      }
      default: throw new Error("compile: unknown node kind '" + node.kind + "'");
    }
  }

  /* ══ §4 · Lift — JSE text → graph. A position-tracking tokenizer + a small
     AST parser mirroring the interpreter's grammar; recognized shapes become
     nodes, anything else becomes a `code` node from its exact source slice —
     so lift NEVER fails: any deck's formula opens in the editor. ═════════════ */
  function liftTokens(s) {
    const toks = []; let i = 0;
    const isId = (c) => /[A-Za-z0-9_$]/.test(c);
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1, out = "";
        while (j < s.length && s[j] !== c) { out += s[j] === "\\" ? s[++j] : s[j]; j++; }
        toks.push({ t: "str", v: out, s: i, e: j + 1 }); i = j + 1; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
        toks.push({ t: "num", v: parseFloat(s.slice(i, j)), s: i, e: j }); i = j; continue;
      }
      if (isId(c)) {
        let j = i; while (j < s.length && isId(s[j])) j++;
        toks.push({ t: "id", v: s.slice(i, j), s: i, e: j }); i = j; continue;
      }
      const three = s.slice(i, i + 3), two = s.slice(i, i + 2);
      if (three === "===" || three === "!==") { toks.push({ t: "op", v: three.slice(0, 2), s: i, e: i + 3 }); i += 3; continue; }
      if (["==", "!=", "<=", ">=", "&&", "||", "=>"].includes(two)) { toks.push({ t: "op", v: two, s: i, e: i + 2 }); i += 2; continue; }
      toks.push({ t: "op", v: c, s: i, e: i + 1 }); i++;
    }
    return toks;
  }

  function liftParse(src) {
    const toks = liftTokens(src);
    let p = 0;
    const bail = (why) => { const e = new Error(why); e.__bail = true; throw e; };
    const peek = () => toks[p];
    const isOp = (v) => toks[p] && toks[p].t === "op" && toks[p].v === v;
    const eat = (v) => (isOp(v) ? (p++, true) : false);
    const spanOf = (n) => src.slice(n.s, n.e).trim();

    function primary() {
      const tk = peek();
      if (!tk) bail("eof");
      if (tk.t === "num" || tk.t === "str") { p++; return { t: "lit", v: tk.v, s: tk.s, e: tk.e }; }
      if (tk.t === "id") {
        if (toks[p + 1] && toks[p + 1].t === "op" && toks[p + 1].v === "=>") {
          const start = tk.s; p += 2;
          if (isOp("{")) bail("braced arrow");           // statement bodies stay code
          const body = ternary();
          return { t: "arrow", params: [tk.v], body, s: start, e: body.e };
        }
        p++;
        if (tk.v === "true") return { t: "lit", v: true, s: tk.s, e: tk.e };
        if (tk.v === "false") return { t: "lit", v: false, s: tk.s, e: tk.e };
        if (tk.v === "null" || tk.v === "undefined" || tk.v === "nil") return { t: "lit", v: null, s: tk.s, e: tk.e };
        if (tk.v === "typeof" || tk.v === "await") bail("keyword " + tk.v);
        return { t: "id", name: tk.v, s: tk.s, e: tk.e };
      }
      if (isOp("(")) {
        // arrow lookahead: (a, b) => expr
        let q = p + 1, depth = 1;
        while (toks[q] && depth > 0) {
          if (toks[q].t === "op" && toks[q].v === "(") depth++;
          if (toks[q].t === "op" && toks[q].v === ")") depth--;
          q++;
        }
        if (toks[q] && toks[q].t === "op" && toks[q].v === "=>") {
          const start = toks[p].s;
          const params = [];
          for (let j = p + 1; j < q - 1; j++) {
            if (toks[j].t === "id") params.push(toks[j].v);
            else if (!(toks[j].t === "op" && toks[j].v === ",")) bail("arrow params");
          }
          p = q + 1;
          if (isOp("{")) bail("braced arrow");
          const body = ternary();
          return { t: "arrow", params, body, s: start, e: body.e };
        }
        const start = toks[p].s; p++;
        const inner = ternary();
        if (!eat(")")) bail("unclosed paren");
        return { ...inner, s: start, e: toks[p - 1].e };
      }
      if (isOp("[")) {
        const start = toks[p].s; p++;
        const items = [];
        while (peek() && !isOp("]")) { items.push(ternary()); if (!eat(",")) break; }
        if (!eat("]")) bail("unclosed array");
        return { t: "arr", items, s: start, e: toks[p - 1].e };
      }
      if (isOp("{")) {
        const start = toks[p].s; p++;
        const entries = [];
        while (peek() && !isOp("}")) {
          const k = peek();
          if (!k || (k.t !== "id" && k.t !== "str")) bail("object key");
          p++;
          if (!eat(":")) bail("object colon");
          entries.push({ key: String(k.v), value: ternary() });
          if (!eat(",")) break;
        }
        if (!eat("}")) bail("unclosed object");
        return { t: "obj", entries, s: start, e: toks[p - 1].e };
      }
      bail("unexpected " + (tk.v ?? tk.t));
    }

    function postfix() {
      let v = primary();
      for (;;) {
        if (eat(".")) {
          const id = peek();
          if (!id || id.t !== "id") bail("member name");
          p++;
          if (isOp("(")) {
            p++;
            const args = [];
            while (peek() && !isOp(")")) { args.push(ternary()); if (!eat(",")) break; }
            if (!eat(")")) bail("unclosed call");
            v = { t: "call", base: v, name: id.v, method: true, args, s: v.s, e: toks[p - 1].e };
            continue;
          }
          v = { t: "member", base: v, name: id.v, s: v.s, e: id.e };
          continue;
        }
        if (isOp("[")) {
          p++;
          const idx = ternary();
          if (!eat("]")) bail("unclosed index");
          v = { t: "idx", base: v, idx, s: v.s, e: toks[p - 1].e };
          continue;
        }
        if (isOp("(")) {
          p++;
          const args = [];
          while (peek() && !isOp(")")) { args.push(ternary()); if (!eat(",")) break; }
          if (!eat(")")) bail("unclosed call");
          if (v.t !== "id") bail("computed call");
          v = { t: "call", base: v, name: v.name, method: false, args, s: v.s, e: toks[p - 1].e };
          continue;
        }
        break;
      }
      return v;
    }

    function unary() {
      const tk = peek();
      if (tk && tk.t === "op" && (tk.v === "!" || tk.v === "-" || tk.v === "+")) {
        p++;
        const x = unary();
        if (tk.v === "+" ) return { t: "un", op: "+", x, s: tk.s, e: x.e };
        return { t: "un", op: tk.v === "!" ? "!" : "neg", x, s: tk.s, e: x.e };
      }
      return postfix();
    }
    const binLevel = (ops, next) => () => {
      let l = next();
      for (;;) {
        const tk = peek();
        if (tk && tk.t === "op" && ops.includes(tk.v)) {
          p++;
          const r = next();
          l = { t: "bin", op: tk.v, l, r, s: l.s, e: r.e };
        } else return l;
      }
    };
    const mul = binLevel(["*", "/", "%"], unary);
    const add = binLevel(["+", "-"], mul);
    const rel = binLevel(["<", ">", "<=", ">="], add);
    const eqL = binLevel(["==", "!="], rel);
    const and = binLevel(["&&"], eqL);
    const or = binLevel(["||"], and);
    function ternary() {
      const c = or();
      if (eat("?")) {
        const a = ternary();
        if (!eat(":")) bail("ternary colon");
        const b = ternary();
        return { t: "tern", c, a, b, s: c.s, e: b.e };
      }
      return c;
    }

    const ast = ternary();
    if (p < toks.length) bail("trailing input");
    return { ast, spanOf };
  }

  function lift(src, functions) {
    const text = String(src ?? "").trim();
    const graph = { v: 1, kind: "expression", nodes: {}, out: { value: null } };
    if (functions && functions.length) graph.functions = JSON.parse(JSON.stringify(functions));
    if (!text) return graph;
    let parsed;
    try { parsed = liftParse(text); }
    catch (_) { graph.out = { code: text }; return graph; }
    let seq = 0;
    const put = (node) => { const id = "n" + (++seq); graph.nodes[id] = node; return id; };
    const codePort = (ast) => ({ code: parsed.spanOf(ast) });

    // an id-chain (`a.b.c`) folds to one path node; anything else keeps structure
    const chainOf = (ast) => {
      const parts = [];
      let cur = ast;
      while (cur.t === "member") { parts.unshift(cur.name); cur = cur.base; }
      if (cur.t !== "id") return null;
      parts.unshift(cur.name);
      return parts.join(".");
    };

    function toPort(ast) {
      try { return convert(ast); }
      catch (e) { if (e && e.__bail) return codePort(ast); throw e; }
    }

    function convert(ast) {
      switch (ast.t) {
        case "lit": return { value: ast.v };
        case "id": return { node: put({ kind: "path", path: ast.name }) };
        case "member": {
          const chain = chainOf(ast);
          if (chain) return { node: put({ kind: "path", path: chain }) };
          return { node: put({ kind: "get", target: toPort(ast.base), path: ast.name }) };
        }
        case "un": {
          if (ast.op === "+") { const e = new Error("unary plus"); e.__bail = true; throw e; }
          if (ast.op === "neg" && ast.x.t === "lit" && typeof ast.x.v === "number") return { value: -ast.x.v };
          return { node: put({ kind: "op", op: ast.op, args: [toPort(ast.x)] }) };
        }
        case "bin": return { node: put({ kind: "op", op: ast.op, args: [toPort(ast.l), toPort(ast.r)] }) };
        case "tern": {
          const cases = [{ when: toPort(ast.c), then: toPort(ast.a) }];
          let tail = ast.b;
          while (tail.t === "tern") { cases.push({ when: toPort(tail.c), then: toPort(tail.a) }); tail = tail.b; }
          return { node: put({ kind: "if", cases, else: toPort(tail) }) };
        }
        case "arr": return { node: put({ kind: "array", items: ast.items.map(toPort) }) };
        case "obj": return { node: put({ kind: "object", entries: ast.entries.map((e) => ({ key: e.key, value: toPort(e.value) })) }) };
        case "arrow": return { node: put({ kind: "arrow", params: ast.params, body: toPort(ast.body) }) };
        case "call": {
          if (!ast.method) {
            if (userFnEntry(graph, ast.name)) return { node: put({ kind: "fn", fn: ast.name, args: ast.args.map(toPort) }) };
            const entry = CAT.byCall.get(ast.name);
            if (entry) return { node: put({ kind: "fn", fn: entry.id, args: ast.args.map(toPort) }) };
            const e = new Error("unknown free fn"); e.__bail = true; throw e;
          }
          const entry = CAT.byMethod.get(ast.name);
          if (entry) return { node: put({ kind: "fn", fn: entry.id, args: [toPort(ast.base), ...ast.args.map(toPort)] }) };
          if (ARRAY_FNS.has(ast.name) || HOF_FNS.has(ast.name) || STRING_FNS.has(ast.name) || ast.name === "toFixed" || chainOf(ast.base))
            return { node: put({ kind: "method", target: toPort(ast.base), method: ast.name, args: ast.args.map(toPort) }) };
          const e = new Error("unknown method"); e.__bail = true; throw e;
        }
        default: { const e = new Error("unsupported " + ast.t); e.__bail = true; throw e; }
      }
    }

    graph.out = toPort(parsed.ast);
    return graph;
  }

  /* ══ §5 · Evaluate — per-node live values with device-exact semantics:
     compile the subtree, evaluate the TEXT through the corpus-gated
     interpreter. Fail-open (undefined) exactly like the engine. ═════════════ */
  function evalScope(graph, scope) {
    const merged = { ...(scope || {}) };
    for (const inp of graph.inputs || []) {
      if (!(inp.name in merged) && "sample" in inp) merged[inp.name] = inp.sample;
    }
    // user functions become real callables: the body runs as JSE STATEMENTS
    // (return/try/catch work) with params bound over the formula scope — the
    // editor-side twin of `<script>` user functions. A body beyond the JSE
    // subset fails open to undefined, mirroring the tiers law: render-path
    // formulas never escalate, so beyond-subset is a lint error on device.
    for (const f of graph.functions || []) {
      const params = (f.params || []).map((p) => (typeof p === "string" ? p : p.name));
      merged[f.name] = (...xs) => {
        const inner = { ...merged };
        params.forEach((pn, i) => { inner[pn] = xs[i]; });
        return jseRun(String(f.body || ""), scopeCtx(inner));
      };
    }
    return merged;
  }
  function evaluateGraph(graph, scope) {
    const merged = evalScope(graph, scope);
    const values = {};
    for (const id of Object.keys(graph.nodes || {})) {
      let text = null;
      try { text = compilePort({ node: id }, graph, 1, "root", new Set()); } catch (_) { /* cycle/missing → fail-open */ }
      values[id] = text == null ? undefined : jseEval(text, scopeCtx({ ...merged }));
    }
    let jse = "";
    try { jse = compileGraph(graph); } catch (_) { jse = ""; }
    const result = jse === "" ? undefined : jseEval(jse, scopeCtx({ ...merged }));
    return { values, jse, result };
  }

  /* ══ §6 · Auto-layout — deterministic, no stored coordinates: dataflow ranks
     right-to-left from the out port (Output card rightmost), parked chains
     below. Positions are ephemeral; dragging overrides until the next load. ══ */
  function nodeDeps(node) {
    const ports = [];
    const addP = (p) => { if (p && typeof p === "object" && "node" in p) ports.push(p.node); };
    switch (node.kind) {
      case "op": case "fn": (node.args || []).forEach(addP); break;
      case "if": (node.cases || []).forEach((c) => { addP(c.when); addP(c.then); }); addP(node.else); break;
      case "method": addP(node.target); (node.args || []).forEach(addP); break;
      case "get": addP(node.target); break;
      case "object": (node.entries || []).forEach((e) => addP(e.value)); break;
      case "array": (node.items || []).forEach(addP); break;
      case "arrow": addP(node.body); break;
      default: break;
    }
    return ports;
  }
  function layoutRanks(graph) {
    const nodes = graph.nodes || {};
    const rank = {};
    const order = {};   // discovery order from the output — stacks columns the way the formula reads
    let seq = 0;
    const visit = (id, r, seen) => {
      if (!nodes[id] || seen.has(id)) return;
      seen.add(id);
      if (!(id in order)) order[id] = seq++;
      rank[id] = Math.max(rank[id] ?? 0, r);
      for (const dep of nodeDeps(nodes[id])) visit(dep, r + 1, seen);
      seen.delete(id);
    };
    if (graph.out && graph.out.node) visit(graph.out.node, 1, new Set());
    // parked chains: roots nobody references, laid out from rank 1 as well
    const referenced = new Set();
    for (const id of Object.keys(nodes)) for (const d of nodeDeps(nodes[id])) referenced.add(d);
    for (const id of Object.keys(nodes)) if (!(id in rank) && !referenced.has(id)) visit(id, 1, new Set());
    for (const id of Object.keys(nodes)) if (!(id in rank)) { rank[id] = 1; if (!(id in order)) order[id] = seq++; }
    return { rank, order };
  }

  /* ══ §7 · The canvas UI ═══════════════════════════════════════════════════ */
  /* icons: Hugeicons (free set, @hugeicons/core-free-icons), 24px stroke 1.5,
     rendered via currentColor — the SAME family and convention as the canvas
     editor (StackCanvas.icons). Inlined path data on purpose: zero deps. */
  const ICONS = {
    fx: `<path d="M5 19C5.26413 19.9564 5.79671 21 7.18729 21C9.59365 21 10.1952 19 12 12C13.8048 5 14.4064 3 16.8127 3C18.2033 3 18.7359 4.04358 19 5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M9 10H17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    code: `<path d="M17 8L18.8398 9.85008C19.6133 10.6279 20 11.0168 20 11.5C20 11.9832 19.6133 12.3721 18.8398 13.1499L17 15" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M7 8L5.16019 9.85008C4.38673 10.6279 4 11.0168 4 11.5C4 11.9832 4.38673 12.3721 5.16019 13.1499L7 15" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M14.5 4L9.5 20" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    hash: `<path d="M10 3.5L7.5 20.5M16.5 3.5L14 20.5M4 8.5H20.5M3.5 15.5H20" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    arrow: `<path d="M18.5 12L4.99997 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M13 18C13 18 19 13.5811 19 12C19 10.4188 13 6 13 6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    flag: `<path d="M4 7L4 21" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M11.7576 3.90865C8.45236 2.22497 5.85125 3.21144 4.55426 4.2192C4.32048 4.40085 4.20358 4.49167 4.10179 4.69967C4 4.90767 4 5.10138 4 5.4888V14.7319C4.9697 13.6342 7.87879 11.9328 11.7576 13.9086C15.224 15.6744 18.1741 14.9424 19.5697 14.1795C19.7633 14.0737 19.8601 14.0207 19.9301 13.9028C20 13.7849 20 13.6569 20 13.4009V5.87389C20 5.04538 20 4.63113 19.8027 4.48106C19.6053 4.33099 19.1436 4.459 18.2202 4.71504C16.64 5.15319 14.3423 5.22532 11.7576 3.90865Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    copy: `<path d="M9 15C9 12.1716 9 10.7574 9.87868 9.87868C10.7574 9 12.1716 9 15 9L16 9C18.8284 9 20.2426 9 21.1213 9.87868C22 10.7574 22 12.1716 22 15V16C22 18.8284 22 20.2426 21.1213 21.1213C20.2426 22 18.8284 22 16 22H15C12.1716 22 10.7574 22 9.87868 21.1213C9 20.2426 9 18.8284 9 16L9 15Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M16.9999 9C16.9975 6.04291 16.9528 4.51121 16.092 3.46243C15.9258 3.25989 15.7401 3.07418 15.5376 2.90796C14.4312 2 12.7875 2 9.5 2C6.21252 2 4.56878 2 3.46243 2.90796C3.25989 3.07417 3.07418 3.25989 2.90796 3.46243C2 4.56878 2 6.21252 2 9.5C2 12.7875 2 14.4312 2.90796 15.5376C3.07417 15.7401 3.25989 15.9258 3.46243 16.092C4.51121 16.9528 6.04291 16.9975 9 16.9999" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    spark: `<path d="M15 2L15.5387 4.39157C15.9957 6.42015 17.5798 8.00431 19.6084 8.46127L22 9L19.6084 9.53873C17.5798 9.99569 15.9957 11.5798 15.5387 13.6084L15 16L14.4613 13.6084C14.0043 11.5798 12.4202 9.99569 10.3916 9.53873L8 9L10.3916 8.46127C12.4201 8.00431 14.0043 6.42015 14.4613 4.39158L15 2Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"/><path d="M7 12L7.38481 13.7083C7.71121 15.1572 8.84275 16.2888 10.2917 16.6152L12 17L10.2917 17.3848C8.84275 17.7112 7.71121 18.8427 7.38481 20.2917L7 22L6.61519 20.2917C6.28879 18.8427 5.15725 17.7112 3.70827 17.3848L2 17L3.70827 16.6152C5.15725 16.2888 6.28879 15.1573 6.61519 13.7083L7 12Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"/>`,
    chevron: `<path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    flash: `<path d="M5.22576 11.3294L12.224 2.34651C12.7713 1.64397 13.7972 2.08124 13.7972 3.01707V9.96994C13.7972 10.5305 14.1995 10.985 14.6958 10.985H18.0996C18.8729 10.985 19.2851 12.0149 18.7742 12.6706L11.776 21.6535C11.2287 22.356 10.2028 21.9188 10.2028 20.9829V14.0301C10.2028 13.4695 9.80048 13.015 9.3042 13.015H5.90035C5.12711 13.015 4.71494 11.9851 5.22576 11.3294Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    close: `<path d="M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/>`,
    variable: `<path d="M3 12C3 7.75736 3 5.63604 4.31802 4.31802C5.63604 3 7.75736 3 12 3C16.2426 3 18.364 3 19.682 4.31802C21 5.63604 21 7.75736 21 12C21 16.2426 21 18.364 19.682 19.682C18.364 21 16.2426 21 12 21C7.75736 21 5.63604 21 4.31802 19.682C3 18.364 3 16.2426 3 12Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M3.5 8H20.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M10.5 13L12 14.5M12 14.5L13.5 16M12 14.5L13.5 13M12 14.5L10.5 16M16 11.5C16.6325 12.3628 17 13.3932 17 14.5C17 15.6068 16.6325 16.6372 16 17.5M8 11.5C7.36755 12.3628 7 13.3932 7 14.5C7 15.6068 7.36755 16.6372 8 17.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    branch: `<path d="M7 19H13C15.8284 19 17.2426 19 18.1213 18.1213C19 17.2426 19 15.8284 19 13V10M19 10C19.7002 10 21.0085 11.9943 21.5 12.5M19 10C18.2998 10 16.9915 11.9943 16.5 12.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M5 7L5 17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="19" r="2" stroke="currentColor" stroke-width="1.5"/>`,
    minus: `<path d="M20 12L4 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    plus: `<path d="M12 4V20M20 12H4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    fit: `<path d="M15.5 21C16.8956 21 17.5933 21 18.1611 20.8278C19.4395 20.44 20.44 19.4395 20.8278 18.1611C21 17.5933 21 16.8956 21 15.5M21 8.5C21 7.10444 21 6.40666 20.8278 5.83886C20.44 4.56046 19.4395 3.56004 18.1611 3.17224C17.5933 3 16.8956 3 15.5 3M8.5 21C7.10444 21 6.40666 21 5.83886 20.8278C4.56046 20.44 3.56004 19.4395 3.17224 18.1611C3 17.5933 3 16.8956 3 15.5M3 8.5C3 7.10444 3 6.40666 3.17224 5.83886C3.56004 4.56046 4.56046 3.56004 5.83886 3.17224C6.40666 3 7.10444 3 8.5 3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
  };
  // The icon set is a SWAPPABLE LAYER. The open SDK ships the Hugeicons FREE
  // (stroke) set inlined above — redistributable, so the public MIT mirror
  // stays clean. A licensed build (e.g. Despia's commercial edition) injects
  // the Hugeicons Pro SOLID set at runtime via StackLogic.registerIcons({...})
  // or `new StackLogic(mount, { icons })` — the paid paths live in the closed
  // build, never in this open source, exactly like the premium module catalog.
  // Each entry is the inner SVG markup (paths); solid entries add fill.
  let ICON_MODE = "stroke";   // "solid" once a filled set is registered
  function registerIcons(map, mode) {
    if (map && typeof map === "object") {
      for (const k in map) if (typeof map[k] === "string") ICONS[k] = map[k];
    }
    if (mode === "solid" || mode === "stroke") ICON_MODE = mode;
  }
  const icon = (name, size = 12) => {
    const fill = ICON_MODE === "solid" ? "currentColor" : "none";
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" xmlns="http://www.w3.org/2000/svg">${ICONS[name] || ICONS.code}</svg>`;
  };

  /* ── the look (DESIGN.md is the law): one accent, neutrals everywhere else;
     depth with purpose — RAISED surfaces are interactive (the Despia bevel: a
     top inner highlight + tight contact shadow), RECESSED wells are readouts;
     argument rows form a native grouped list with hairline separators; a real
     type scale on a 4px grid; micro-states everywhere. Nothing decorated that
     encodes nothing. ── */
  const CSS = `
  .sl-viewport {
    position: relative; overflow: hidden; outline: none; user-select: none;
    background: var(--sl-canvas); color: var(--sl-t1);
    font-family: 'Inter', -apple-system, system-ui, sans-serif; font-size: 13px;
    -webkit-font-smoothing: antialiased;
    /* ── the theme contract: every surface reads ONLY these variables. Dark is
       the reference; .sl-light overrides the full set. ── */
    --sl-canvas: #161618;
    --sl-grid-minor: rgba(255,255,255,0.03); --sl-grid-major: rgba(255,255,255,0.075);
    --sl-card: #232328; --sl-card-sel: #26262C; --sl-panel: #1E1E22;
    --sl-border: #34343A; --sl-hair: rgba(255,255,255,0.05);
    --sl-group: #1c1c20; --sl-well: #141416; --sl-well-deep: #0e0e10;
    --sl-line: #363640; --sl-wire-drag: #5a5a64;
    /* family hues — MUTED on purpose: they mark type, they don't decorate.
       interaction purple is the one saturated accent. */
    --sl-accent: #6758F5; --sl-violet: #7A6FC9; --sl-indigo: #5B63C4; --sl-green: #4F9370;
    --sl-amber: #d9a250; --sl-amber-bg: rgba(217,162,80,0.14);
    --sl-amber-band: rgba(217,162,80,0.06);
    --sl-t1: #ececef; --sl-t2: #9a9aa3; --sl-t3: #6e6e78;
    --sl-band: #26262B;
    --sl-hov: rgba(255,255,255,0.02); --sl-hov1: rgba(255,255,255,0.04); --sl-hov2: rgba(255,255,255,0.055);
    --sl-label: #8b8b95; --sl-typec: #77777f; --sl-type-hov: #b5b5bf; --sl-type-hov2: #e4e4e9;
    --sl-port-bg: #17171a; --sl-port-bd: #45454d; --sl-port-hov: #201c3a;
    --sl-plug: #55555f; --sl-glow: rgba(103,88,245,0.28);
    --sl-live-c: #8f99a3; --sl-result-c: #eef2f7; --sl-code-c: #aeb4bf; --sl-jse-tag: #5a5a64;
    --sl-syn-str: #a9c4a0; --sl-syn-num: #d4b48c; --sl-syn-kw: #8fa8c8;
    --sl-syn-fn: #cdd2d9; --sl-syn-op: #98a0ab; --sl-syn-pun: #656b75;
    --sl-sel: #6758F5; --sl-wire-sel: #6a5fc8; --sl-acc-bg: rgba(103,88,245,0.12);
    --sl-pal-bg: #202024; --sl-pal-item: #dcdce2; --sl-pal-item-hov: #ffffff;
    --sl-empty: #55555e; --sl-active: rgba(0,0,0,0.25);
    /* depth is BORDER-first: a hairline contact shadow, a whisper of ambient —
       professional desktop software, not a floating card */
    --sl-shadow-card: 0 1px 2px rgba(0,0,0,0.28);
    --sl-shadow-card-sel: 0 1px 2px rgba(0,0,0,0.32), 0 3px 10px rgba(0,0,0,0.22);
    --sl-shadow-chip: 0 1px 2px rgba(0,0,0,0.26);
    --sl-shadow-pop: 0 12px 32px rgba(0,0,0,0.44);
    --sl-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace;
    --sl-bevel: inset 0 1px 0 rgba(255,255,255,0.06);
    --sl-sunk: inset 0 1px 2px rgba(0,0,0,0.45), inset 0 -1px 0 rgba(255,255,255,0.02);
    --sl-sunk-sm: inset 0 1px 1.5px rgba(0,0,0,0.35);
  }
  /* ── light: the same room with the lights on — paper canvas, white cards,
     ink text, the SAME purple; amber deepened for contrast; syntax tones
     re-picked for light wells. Nothing moves, only the material changes. ── */
  .sl-viewport.sl-light {
    --sl-canvas: #F4F5F8;
    --sl-grid-minor: rgba(25,35,70,0.03); --sl-grid-major: rgba(25,35,70,0.08);
    --sl-card: #ffffff; --sl-card-sel: #ffffff; --sl-panel: #F7F7F8;
    --sl-border: rgba(20,25,50,0.14); --sl-hair: rgba(20,25,50,0.07);
    --sl-group: #f2f3f7; --sl-well: #eef0f4; --sl-well-deep: #E9EBF1;
    --sl-line: #cdd1dc; --sl-wire-drag: #a7adc0;
    --sl-accent: #5548D8; --sl-violet: #6E63C4; --sl-indigo: #4338CA; --sl-green: #2F8A5D;
    --sl-amber: #b97f22; --sl-amber-bg: rgba(185,127,34,0.14);
    --sl-amber-band: rgba(185,127,34,0.07);
    --sl-t1: #23262f; --sl-t2: #5d6270; --sl-t3: #9096a3;
    --sl-band: #FAFAFB;
    --sl-hov: rgba(20,25,50,0.03); --sl-hov1: rgba(20,25,50,0.05); --sl-hov2: rgba(20,25,50,0.07);
    --sl-label: #6b7080; --sl-typec: #8b90a0; --sl-type-hov: #565c6c; --sl-type-hov2: #2b2f3a;
    --sl-port-bg: #ffffff; --sl-port-bd: #b6bcca; --sl-port-hov: #e6e2fb;
    --sl-plug: #9aa0b0; --sl-glow: rgba(85,72,216,0.24);
    --sl-live-c: #5f6672; --sl-result-c: #262a34; --sl-code-c: #4a5262; --sl-jse-tag: #9aa0ac;
    --sl-syn-str: #3f7d44; --sl-syn-num: #9a6516; --sl-syn-kw: #3f5f8f;
    --sl-syn-fn: #333947; --sl-syn-op: #5d6572; --sl-syn-pun: #9aa1ae;
    --sl-sel: #5548D8; --sl-wire-sel: #7266cc; --sl-acc-bg: rgba(85,72,216,0.09);
    --sl-pal-bg: #ffffff; --sl-pal-item: #3a3f4c; --sl-pal-item-hov: #16181f;
    --sl-empty: #a0a5b2; --sl-active: rgba(20,25,50,0.06);
    --sl-shadow-card: 0 1px 2px rgba(30,35,60,0.08);
    --sl-shadow-card-sel: 0 1px 2px rgba(30,35,60,0.10), 0 3px 10px rgba(30,35,60,0.08);
    --sl-shadow-chip: 0 1px 2px rgba(30,35,60,0.08);
    --sl-shadow-pop: 0 12px 32px rgba(30,35,60,0.18);
    --sl-bevel: inset 0 1px 0 rgba(255,255,255,0.85);
    --sl-sunk: inset 0 1px 2px rgba(25,30,55,0.12), inset 0 -1px 0 rgba(255,255,255,0.6);
    --sl-sunk-sm: inset 0 1px 1.5px rgba(25,30,55,0.10);
  }
  .sl-viewport, .sl-viewport * { box-sizing: border-box; }
  .sl-viewport.sl-panning { cursor: grabbing; }
  /* the drafting-table ground: a fine cross grid (24px) with a quieter major
     line every fourth — engineering paper, not a dashboard dot field. The grid
     whispers; the vignette above it fades it toward the edges so the canvas
     center is where the eye rests. */
  .sl-grid {
    position: absolute; inset: -448px; pointer-events: none;
    background-image:
      linear-gradient(var(--sl-grid-minor) 1px, transparent 1px),
      linear-gradient(90deg, var(--sl-grid-minor) 1px, transparent 1px),
      linear-gradient(var(--sl-grid-major) 1px, transparent 1px),
      linear-gradient(90deg, var(--sl-grid-major) 1px, transparent 1px);
    background-size: 24px 24px, 24px 24px, 96px 96px, 96px 96px;
    will-change: transform;
  }
  .sl-fade {
    position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse 130% 105% at 50% 42%, transparent 52%, var(--sl-canvas) 100%);
  }
  .sl-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
  .sl-wires { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  /* wires almost disappear at rest — low-contrast neutral, so the graph's
     STRUCTURE reads, never colorful spaghetti. The one exception is the
     selected node's own wires: they take the accent, quietly, so you can
     trace what a step connects to. No glow, no motion. */
  .sl-wires path { fill: none; stroke: var(--sl-line); stroke-width: 1.75; stroke-linecap: round; }
  .sl-wires path.sl-live-wire { stroke: var(--sl-wire-drag); }   /* in-progress drag only: brighter neutral, never a color */
  .sl-wires path.sl-wire-on { stroke: var(--sl-wire-sel); stroke-width: 2; }
  .sl-node, .sl-out-card {
    position: absolute; min-width: 208px; max-width: 320px;
    background: var(--sl-card);
    border: 1px solid var(--sl-border); border-radius: 8px;
    box-shadow: var(--sl-bevel), var(--sl-shadow-card);
    padding: 7px;
  }
  /* selection is a WHISPER: a 1px accent border, a hair brighter fill, a touch
     more elevation. No ring, no glow, no colored shadow — you should still read
     the graph before you read the selected node. */
  .sl-node.sl-selected, .sl-out-card.sl-selected {
    border-color: var(--sl-sel); background: var(--sl-card-sel);
    box-shadow: var(--sl-bevel), var(--sl-shadow-card-sel);
  }
  /* the HEADER BAND — the title row is its own flat strip bleeding to the
     card edges with a hairline beneath; collapsed cards become a clean pill
     of just the band. */
  .sl-head, .sl-out-head {
    display: flex; align-items: center; gap: 8px; cursor: grab;
    margin: -7px -7px 10px; padding: 6px 9px 6px 8px;
    background: var(--sl-band);
    border-bottom: 1px solid var(--sl-hair); border-radius: 7px 7px 0 0;
  }
  .sl-head:active, .sl-out-head:active { cursor: grabbing; }
  .sl-collapsed .sl-head { border-radius: 7px; border-bottom-color: transparent; margin-bottom: -7px; }
  /* ── the FAMILIES — color is worn ONCE, as a 2px crown: the top border and
     the glyph tint, nothing else. Flat card, colored crown, colored icon —
     you read a node's family at a squint without a single filled header:
       amber = data in · purple = decides · green = math · indigo = the
       destination · neutral = text/data work.
     Sources alone also keep their warm band — the one washed surface. ── */
  .sl-source { border-top: 2px solid var(--sl-amber); }
  .sl-fam-logic { border-top: 2px solid var(--sl-violet); }
  .sl-fam-logic .sl-lead .sl-kind { color: var(--sl-violet); }
  .sl-fam-math { border-top: 2px solid var(--sl-green); }
  .sl-fam-math .sl-lead .sl-kind { color: var(--sl-green); }
  /* sources: compact pills — an identifier, not a machine. Warm band, mono
     title (it IS an identifier). */
  .sl-n-path { min-width: 148px; max-width: 248px; }
  .sl-n-path .sl-head { background: var(--sl-amber-band); }
  .sl-n-path .sl-title { font-family: var(--sl-mono); font-size: 13.5px; font-weight: 600; letter-spacing: 0; }
  .sl-n-if { min-width: 224px; }
  /* custom code: a recessed, well-dark band + mono title — raw text embedded
     in the graph, dressed as exactly that. */
  .sl-n-code .sl-head { background: var(--sl-well); }
  .sl-n-code .sl-title { font-family: var(--sl-mono); font-size: 13px; font-weight: 600; letter-spacing: 0; }
  /* literals (Value / Object / Array): quiet utility — bandless header, the
     lightest silhouette on the canvas. */
  .sl-n-value, .sl-n-object, .sl-n-array { min-width: 186px; }
  .sl-n-value .sl-head, .sl-n-object .sl-head, .sl-n-array .sl-head { background: transparent; }
  /* the Output: a terminal, not another card — indigo crown, a heavier
     frame, more air, and the deepest well on the canvas for the result. */
  .sl-out-card { border-width: 1.5px; border-top: 2.5px solid var(--sl-indigo); }
  .sl-out-head { margin-bottom: 14px; }
  .sl-out-head .sl-title { font-weight: 700; }
  /* ONE left slot: the type glyph at rest, the collapse chevron on hover —
     same 18px footprint, so nothing shifts and there's no phantom gutter */
  .sl-lead { position: relative; width: 18px; height: 18px; flex: none; cursor: pointer; }
  .sl-lead .sl-kind, .sl-lead .sl-chevron {
    position: absolute; inset: 0; display: inline-flex; align-items: center; justify-content: center;
    color: var(--sl-t3); background: none; border: none; padding: 0; transition: opacity 150ms ease-out, color 150ms ease-out;
  }
  .sl-lead .sl-chevron { opacity: 0; }
  .sl-node:hover .sl-lead .sl-kind { opacity: 0; }
  .sl-node:hover .sl-lead .sl-chevron, .sl-collapsed .sl-lead .sl-chevron { opacity: 1; }
  .sl-collapsed .sl-lead .sl-kind { opacity: 0; }
  .sl-lead:hover .sl-chevron { color: var(--sl-t1); }
  .sl-chevron svg { transition: transform 150ms ease-out; }
  .sl-collapsed .sl-lead .sl-chevron svg { transform: rotate(-90deg); }
  .sl-kind { flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--sl-t3); }
  .sl-kind.sl-k-out { color: var(--sl-indigo); }
  /* letterform glyphs — a beginner reads a letter instantly: v for a variable,
     f-italic for a function, literal braces for shapes */
  .sl-glyph { font-family: var(--sl-mono); font-size: 10px; font-weight: 600; letter-spacing: -0.5px; }
  .sl-gl-serif { font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 14.5px; font-weight: 600; letter-spacing: 0; }
  /* SOURCE nodes (inputs, map items — where external data enters the formula)
     are the one category that earns a color: a warm amber glyph in a tinted
     chip. Every other node stays monochrome — one highlight, not a rainbow. */
  .sl-source .sl-lead .sl-kind { color: var(--sl-amber); background: var(--sl-amber-bg); border-radius: 5px; }
  .sl-title { flex: 1; font-weight: 650; font-size: 15px; letter-spacing: -0.15px; color: var(--sl-t1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* argument rows: ONE grouped list — shared surface, hairline separators.
     Each row is a SOCKET, not a form field: the pin straddles the card edge,
     the label names the slot in a quiet voice, and the plugged value answers
     in mono — the hierarchy is data over chrome. */
  .sl-rows {
    display: flex; flex-direction: column;
    background: var(--sl-group); border: 1px solid var(--sl-hair); border-radius: 6px;
  }
  .sl-collapsed .sl-rows, .sl-collapsed .sl-live { display: none; }
  .sl-row {
    position: relative; display: flex; align-items: center; gap: 8px;
    min-height: 29px; padding: 3px 7px 3px 12px;
    transition: background 150ms ease-out;
  }
  .sl-row + .sl-row, .sl-addcase { border-top: 1px solid var(--sl-hair); }
  .sl-row:first-child { border-radius: 5px 5px 0 0; }
  .sl-row:last-child { border-radius: 0 0 5px 5px; }
  .sl-row:only-child { border-radius: 5px; }
  .sl-row:hover { background: var(--sl-hov); }
  .sl-label { flex: none; font-size: 12px; font-weight: 500; color: var(--sl-label); max-width: 96px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* only actual data draws attention: values are the largest thing in a row,
     mono and medium; a wired value is only an echo of an upstream card, so it
     recedes to the label's weight */
  .sl-val { flex: 0 1 auto; margin-left: auto; min-width: 24px; text-align: right;
    font-family: var(--sl-mono); font-size: 13.5px; font-weight: 550; color: var(--sl-t1); font-variant-numeric: tabular-nums;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
  .sl-val.sl-wiredval { cursor: default; color: var(--sl-t2); font-weight: 450; }
  .sl-val input {
    width: 100%; background: transparent; border: none; outline: none; color: inherit;
    font: inherit; padding: 0; text-align: right;
  }
  /* the JSE / fx micro-tag on code-bearing rows */
  .sl-chip {
    flex: none; font-size: 8px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
    color: var(--sl-t3); padding: 2px 0 2px 2px;
  }
  /* type chips are GHOSTS at rest — text + caret only; they surface on row hover */
  .sl-type {
    flex: none; display: inline-flex; align-items: center; gap: 4px;
    background: transparent; color: var(--sl-typec); border: none; border-radius: 6px;
    font-size: 10.5px; font-weight: 500; padding: 3px 6px; height: 20px; cursor: pointer;
    transition: color 150ms ease-out, background 150ms ease-out;
  }
  .sl-type::after { content: ""; border: 3.5px solid transparent; border-top-color: currentColor; margin-top: 3.5px; opacity: 0.7; }
  .sl-row:hover .sl-type { color: var(--sl-type-hov); }
  .sl-type:hover { color: var(--sl-type-hov2); background: var(--sl-hov2); }
  /* ports — circles straddling the card edge like sockets. The state IS the
     drawing: hollow = open, filled = plugged; on approach the circle grows to
     14px and an accent halo blooms. */
  .sl-port {
    position: absolute; width: 10px; height: 10px; border-radius: 50%;
    background: var(--sl-port-bg); border: 1.5px solid var(--sl-port-bd); color: var(--sl-t1);
    display: flex; align-items: center; justify-content: center; cursor: crosshair;
    font-size: 10px; line-height: 1; z-index: 3;
    transition: transform 150ms ease-out, border-color 150ms ease-out, background 150ms ease-out, box-shadow 150ms ease-out;
  }
  .sl-port::before { content: "+"; margin-top: -1px; opacity: 0; transition: opacity 150ms ease-out; transform: scale(0.72); }
  .sl-row.sl-wired .sl-port-in, .sl-port.sl-plugged { background: var(--sl-plug); border-color: var(--sl-plug); }
  .sl-port:hover, .sl-port.sl-hot {
    border-color: var(--sl-accent); background: var(--sl-port-hov); transform: scale(1.3);
    box-shadow: 0 0 0 2px var(--sl-canvas), 0 0 7px 1px var(--sl-glow);
  }
  .sl-port:hover::before, .sl-port.sl-hot::before { opacity: 1; }
  .sl-row.sl-wired .sl-port-in:hover, .sl-port.sl-plugged:hover { background: var(--sl-port-hov); }
  .sl-port-out { right: -5px; top: 11px; }
  .sl-port-in { left: -13px; top: 50%; margin-top: -5px; }
  /* a fresh wire draws itself in — a quarter second of ink, then it's just
     another quiet line */
  .sl-wires path.sl-wire-new { stroke-dasharray: 1; stroke-dashoffset: 1; animation: sl-wire-draw 200ms ease-out forwards; }
  @keyframes sl-wire-draw { to { stroke-dashoffset: 0; } }
  /* readouts are RECESSED — you read what's sunk, you press what's raised.
     The well scales with its content up to THREE lines, then clamps behind a
     line-count chip; the full value lives in the inspector, never in the card. */
  .sl-live {
    margin-top: 9px; background: var(--sl-well); border-radius: 6px; padding: 3px 9px;
    box-shadow: var(--sl-sunk-sm);
    font-family: var(--sl-mono); font-size: 10px; letter-spacing: 0.2px; color: var(--sl-live-c); text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sl-live.sl-multi {
    text-align: left; white-space: pre-wrap; overflow-wrap: break-word;
    font-size: 10.5px; line-height: 1.5; padding: 5px 9px;
  }
  .sl-live-body { display: block; overflow: hidden; }
  .sl-more {
    display: inline-flex; align-items: center; margin-top: 3px;
    background: transparent; border: none; border-radius: 5px;
    color: var(--sl-accent); font: inherit; font-family: 'Inter', system-ui, sans-serif;
    font-size: 10px; font-weight: 500; padding: 2px 6px; cursor: pointer;
    transition: background 150ms ease-out;
  }
  .sl-more:hover { background: var(--sl-acc-bg); }
  .sl-out-card { min-width: 272px; }
  .sl-ghost {
    margin-left: auto; width: 24px; height: 24px; border-radius: 6px;
    background: transparent; border: none; color: var(--sl-t3);
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
    transition: color 150ms ease-out, background 150ms ease-out;
  }
  .sl-ghost:hover { color: var(--sl-t2); background: var(--sl-hov2); }
  .sl-ghost.sl-on { color: var(--sl-accent); background: var(--sl-acc-bg); }
  .sl-result {
    position: relative; background: var(--sl-well-deep); border-radius: 6px; padding: 11px 30px 11px 12px;
    box-shadow: var(--sl-sunk);
    font-family: var(--sl-mono); font-size: 13px; color: var(--sl-result-c); min-height: 40px;
    white-space: pre-wrap; overflow-wrap: break-word;
  }
  .sl-copy {
    position: absolute; right: 4px; top: 4px; background: transparent; border: none;
    color: var(--sl-t3); cursor: pointer; padding: 4px; border-radius: 5px; display: inline-flex;
    opacity: 0; transition: opacity 150ms ease-out, color 150ms ease-out;
  }
  .sl-result:hover .sl-copy, .sl-jse:hover .sl-copy { opacity: 1; }
  .sl-copy:hover { color: var(--sl-t1); background: var(--sl-hov2); }
  .sl-jse {
    margin-top: 7px; position: relative; background: var(--sl-well); border-radius: 6px;
    box-shadow: var(--sl-sunk); padding: 16px 15px 7px 11px;
    font-family: var(--sl-mono); font-size: 10.5px; line-height: 1.55; color: var(--sl-code-c);
    white-space: pre-wrap; overflow-wrap: break-word;
  }
  .sl-jse::before {
    content: "JSE"; position: absolute; left: 12px; top: 5px;
    font-family: 'Inter', system-ui, sans-serif; font-size: 8px; font-weight: 700;
    letter-spacing: 1.2px; color: var(--sl-jse-tag);
  }
  /* the syntax palette — content semantics, four muted tones, desaturated so
     they never compete with the UI accent; re-picked per theme */
  .sl-syn-str { color: var(--sl-syn-str); }
  .sl-syn-num { color: var(--sl-syn-num); }
  .sl-syn-kw  { color: var(--sl-syn-kw); }
  .sl-syn-fn  { color: var(--sl-syn-fn); }
  .sl-syn-op  { color: var(--sl-syn-op); }
  .sl-syn-pun { color: var(--sl-syn-pun); }
  .sl-addcase {
    display: flex; align-items: center; gap: 6px; background: transparent; border: none;
    color: var(--sl-t3); padding: 0 7px 0 12px; font: inherit; font-size: 11.5px; font-weight: 450;
    cursor: pointer; min-height: 28px; width: 100%; text-align: left;
    border-radius: 0 0 5px 5px;
    transition: color 150ms ease-out, background 150ms ease-out;
  }
  .sl-addcase:hover { color: var(--sl-t2); background: var(--sl-hov); }
  /* ── the INSPECTOR — the third dimension: cards stay small, this panel goes
     deep. Pinned to the selected step; value first, code on request; always
     recalculating live. ── */
  .sl-inspector {
    position: absolute; top: 10px; right: 10px; bottom: 10px; width: 304px; z-index: 14;
    display: flex; flex-direction: column;
    background: var(--sl-panel);
    border: 1px solid var(--sl-border); border-radius: 10px;
    box-shadow: var(--sl-bevel), var(--sl-shadow-pop);
  }
  .sl-ins-head {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 6px 7px 6px 11px; background: var(--sl-band);
    border-bottom: 1px solid var(--sl-hair); border-radius: 9px 9px 0 0;
  }
  .sl-ins-head .sl-title { flex: 0 1 auto; }
  .sl-ins-tag { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--sl-t3); }
  .sl-ins-close { margin-left: auto; }
  .sl-ins-body { flex: 1; overflow: auto; padding: 8px 10px 10px; }
  .sl-ins-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;
    color: var(--sl-t3); margin: 2px 0 6px;
  }
  .sl-ins-label .sl-ghost { width: 20px; height: 20px; }
  /* sections, not a scroll of boxes: code sits behind a hairline of its own */
  .sl-ins-codehead { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--sl-hair); }
  .sl-ins-codehead .sl-ghost:first-child { margin-left: 0; }
  .sl-ins-value, .sl-ins-code {
    margin: 0; background: var(--sl-well); border-radius: 6px; box-shadow: var(--sl-sunk);
    padding: 9px 10px; font-family: var(--sl-mono); font-size: 11px; line-height: 1.55;
    color: var(--sl-code-c); white-space: pre-wrap; overflow-wrap: break-word;
  }
  .sl-ins-value { color: var(--sl-result-c); font-size: 13px; line-height: 1.6; }
  /* the step's fact sheet: type recalculates live, source and doc anchor the
     value to WHAT produced it — a step is a thing, not a floating number */
  .sl-ins-meta { margin-top: 10px; background: var(--sl-group); border: 1px solid var(--sl-hair); border-radius: 6px; }
  .sl-ins-mrow { display: flex; align-items: baseline; gap: 10px; min-height: 27px; padding: 5px 10px 4px; }
  .sl-ins-mrow + .sl-ins-mrow { border-top: 1px solid var(--sl-hair); }
  .sl-ins-mlabel { flex: none; font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--sl-t3); }
  .sl-ins-mval { margin-left: auto; min-width: 0; font-size: 11.5px; font-weight: 550; color: var(--sl-t1);
    text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sl-ins-mval.sl-mono { font-family: var(--sl-mono); font-weight: 500; font-size: 11px; }
  .sl-ins-dochead { margin-top: 14px; }
  .sl-ins-doc { margin-top: 0; padding: 0 2px; font-size: 12px; line-height: 1.6; color: var(--sl-t2); }
  .sl-ins-doc code { font-family: var(--sl-mono); font-size: 10.5px; color: var(--sl-code-c); }
  .sl-inspecting .sl-controls { right: 324px; }
  .sl-palette {
    position: absolute; z-index: 20; width: 248px; max-height: 332px; overflow: auto;
    background: var(--sl-pal-bg);
    border: 1px solid var(--sl-border); border-radius: 10px;
    box-shadow: var(--sl-bevel), var(--sl-shadow-pop); padding: 8px;
  }
  .sl-palette input {
    width: 100%; background: var(--sl-well); border: 1px solid var(--sl-border); border-radius: 8px;
    box-shadow: var(--sl-sunk);
    color: var(--sl-t1); font: inherit; font-size: 12px; padding: 6px 10px; height: 30px; outline: none; margin-bottom: 4px;
  }
  .sl-palette input:focus { border-color: var(--sl-sel); }
  .sl-pal-group { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--sl-t3); padding: 8px 8px 3px; }
  .sl-pal-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: none;
    color: var(--sl-pal-item); font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 7px; cursor: pointer;
    transition: background 150ms ease-out; }
  .sl-pal-item:hover, .sl-pal-item.sl-hot { background: var(--sl-hov2); color: var(--sl-pal-item-hov); }
  .sl-pal-item .sl-pal-type { margin-left: auto; font-size: 9.5px; color: var(--sl-t3); }
  .sl-empty {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--sl-empty); font-size: 13px; pointer-events: none;
  }
  /* tool furniture — what makes a canvas a PRODUCT: the zoom cluster and the
     formula identity, quiet and raised, never in the content's way */
  /* the zoom cluster: separate square buttons, not a joined pill — each key
     its own raised surface, the way desktop canvas tools do it */
  .sl-controls {
    position: absolute; right: 12px; bottom: 12px; z-index: 10;
    display: flex; align-items: stretch; gap: 5px;
    transition: right 150ms ease-out;
  }
  .sl-ctl {
    width: 28px; height: 28px; border-radius: 6px;
    background: var(--sl-card); border: 1px solid var(--sl-border); color: var(--sl-t2);
    box-shadow: var(--sl-bevel), var(--sl-shadow-chip);
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background 150ms ease-out, color 150ms ease-out; padding: 0; font: inherit;
  }
  .sl-ctl:hover { background: var(--sl-band); color: var(--sl-t1); }
  .sl-ctl:active { background: var(--sl-active); }
  .sl-ctl-pct { width: auto; min-width: 48px; padding: 0 8px; font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .sl-namechip {
    position: absolute; left: 12px; bottom: 12px; z-index: 10;
    display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; height: 28px;
    background: var(--sl-card);
    border: 1px solid var(--sl-border); border-radius: 6px;
    box-shadow: var(--sl-bevel), var(--sl-shadow-chip);
    font-size: 12px; font-weight: 500; color: var(--sl-t2);
  }
  .sl-namechip .sl-kind { color: var(--sl-t3); }
  `;

  function injectStyles(doc, root) {
    const mark = "data-stacklogic-css";
    if (!doc.querySelector(`style[${mark}]`)) {
      const el = doc.createElement("style");
      el.setAttribute(mark, "1");
      el.textContent = CSS;
      doc.head.appendChild(el);
    }
    if (root && root !== doc && !root.querySelector(`style[${mark}]`)) {
      const el = doc.createElement("style");
      el.setAttribute(mark, "1");
      el.textContent = CSS;
      root.appendChild(el);
    }
  }

  /* one quiet glyph per node type — LETTERFORMS where a letter says it best
     (the beginner reads ƒ and v instantly; nobody reads an abstract icon):
     v = a variable/source · ƒ = a function · { } [ ] # = literal shapes.
     Icons remain only where a letter can't carry it (branch, code, flag). */
  const NODE_META = {
    path: { title: (n) => n.path, glyph: "v", serif: true },
    value: { title: () => "Value", glyph: "#" },
    fn: { title: (n) => (CAT.byId.get(n.fn) || { label: n.fn }).label, glyph: "ƒ", serif: true },
    method: { title: (n) => "." + n.method, glyph: "ƒ", serif: true },
    op: { title: (n) => OP_LABELS[n.op] || n.op, glyph: "ƒ", serif: true },
    if: { title: () => "If", icon: "branch" },
    get: { title: (n) => "." + n.path, icon: "code" },
    object: { title: () => "Object", glyph: "{ }" },
    array: { title: () => "Array", glyph: "[ ]" },
    arrow: { title: (n) => (n.params || []).join(", ") + " ⇒", glyph: "ƒ", serif: true },
    code: { title: () => "Custom code", icon: "code" },
  };
  const kindHTML = (meta) => meta.glyph
    ? `<span class="sl-glyph${meta.serif ? " sl-gl-serif" : ""}">${escHtml(meta.glyph)}</span>`
    : icon(meta.icon, 14);
  const OP_LABELS = {
    "+": "Add", "-": "Subtract", "*": "Multiply", "/": "Divide", "%": "Modulo",
    "==": "Equals", "!=": "Not equals", "<": "Less than", ">": "Greater than",
    "<=": "≤", ">=": "≥", "&&": "And", "||": "Or", "!": "Not", "neg": "Negate",
  };
  const OP_ARG_LABELS = { default: ["First", "Second"], "!": ["Value"], "neg": ["Value"] };

  /* the inspector's fact sheet: a live TYPE, a one-line SOURCE (what produces
     this step), and a sentence of documentation — signatures from the
     catalog, the author's own description for user formulas. */
  const typeName = (v) => {
    if (v === undefined) return "–";
    if (v === null) return "Null";
    if (Array.isArray(v)) return `Array · ${v.length} item${v.length === 1 ? "" : "s"}`;
    const t = typeof v;
    if (t === "object") { const n = Object.keys(v).length; return `Object · ${n} key${n === 1 ? "" : "s"}`; }
    return t[0].toUpperCase() + t.slice(1);
  };
  function stepMeta(graph, node) {
    if (!node) return {
      source: graph.kind === "formula" ? (graph.name || "formula") + "()" : "expression",
      doc: "The formula's return value. The compiled JSE below is the exact text that lands in the .dsx document.",
    };
    const sig = (e) => `${escHtml(e.label)} — <code>${escHtml((e.method ? "." + e.method : e.call || e.id) + "(" + (e.params || []).map((p) => p.name).join(", ") + ")")} → ${escHtml(e.returns || "Any")}</code>`;
    switch (node.kind) {
      case "path": {
        const input = (graph.inputs || []).find((i) => i.name === node.path);
        return {
          source: node.path,
          doc: input ? "A formula input — the preview evaluates it against the input's sample value; on device the caller binds it."
            : "Reads a value from the scope by path.",
        };
      }
      case "fn": {
        const e = fnEntry(graph, node.fn);
        if (e && e.user) return {
          source: node.fn + "()",
          doc: e.description ? escHtml(e.description)
            : `Your formula — <code>${escHtml(node.fn + "(" + e.params.map((p) => p.name).join(", ") + ")")}</code>, declared next to this one.`,
        };
        return e ? { source: (e.method ? "." + e.method : e.call || e.id) + "()", doc: sig(e) }
          : { source: node.fn + "()", doc: "Not in the catalog — compiles to a plain call." };
      }
      case "op": return {
        source: node.op === "!" ? "!a" : node.op === "neg" ? "-a" : `a ${node.op} b`,
        doc: `${OP_LABELS[node.op] || node.op} — a JSE operator with device-exact semantics.`,
      };
      case "if": return { source: "if / else", doc: "Cases test top to bottom; the first true condition answers. Compiles to a ternary chain." };
      case "method": return { source: "." + node.method + "()", doc: "Calls a method on the wired target with the arguments below." };
      case "get": return { source: "." + node.path, doc: "Reads a member from the target's result." };
      case "value": return { source: "literal", doc: "An inline value carried in the formula text itself." };
      case "object": return { source: "{ … }", doc: "An object literal; each entry's value is a wireable slot." };
      case "array": return { source: "[ … ]", doc: "An array literal; each item is a wireable slot." };
      case "arrow": return { source: "(" + (node.params || []).join(", ") + ") =>", doc: "A function value for higher-order steps (map, filter, reduce, …); its parameters are readable inside the body." };
      default: return { source: "JSE", doc: "A raw JSE expression — the escape hatch. Compiled verbatim into the formula." };
    }
  }

  /* rows a node presents: [{label, port(get/set), key}] */
  function nodeRows(node, graph) {
    const rows = [];
    const portRef = (obj, key, label) => rows.push({
      label,
      get: () => obj[key] ?? { value: null },
      set: (p) => { obj[key] = p; },
    });
    switch (node.kind) {
      case "fn": {
        const entry = fnEntry(graph, node.fn) || { params: [] };
        node.args = node.args || [];
        const n = Math.max(entry.params.length, node.args.length);
        for (let i = 0; i < n; i++) portRef(node.args, i, (entry.params[i] || { name: "Arg " + (i + 1) }).name);
        break;
      }
      case "op": {
        node.args = node.args || [];
        const labels = OP_ARG_LABELS[node.op] || OP_ARG_LABELS.default;
        for (let i = 0; i < labels.length; i++) portRef(node.args, i, labels[i]);
        break;
      }
      case "method": {
        portRef(node, "target", "Target");
        node.args = node.args || [];
        for (let i = 0; i < node.args.length; i++) portRef(node.args, i, "Arg " + (i + 1));
        break;
      }
      case "if": {
        node.cases = node.cases && node.cases.length ? node.cases : [{ when: { value: true }, then: { value: null } }];
        node.cases.forEach((c, i) => {
          portRef(c, "when", node.cases.length > 1 ? "Condition " + (i + 1) : "Condition");
          portRef(c, "then", node.cases.length > 1 ? "Then " + (i + 1) : "Then");
        });
        portRef(node, "else", "Else");
        break;
      }
      case "get": portRef(node, "target", "Target"); break;
      case "object": (node.entries = node.entries || []).forEach((e, i) => portRef(e, "value", e.key || "key" + i)); break;
      case "array": {
        node.items = node.items || [];
        node.items.forEach((_, i) => portRef(node.items, i, String(i)));
        break;
      }
      case "arrow": portRef(node, "body", "Body"); break;
      default: break;
    }
    return rows;
  }

  const shortVal = (v) => {
    if (v === undefined) return "–";
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  /* ── code readouts: syntax highlighting + formatting (DISPLAY ONLY — the
     canonical text is never touched; this is a view of it, like the graph).
     The palette is the DESIGN.md carve-out: four muted tones for content
     semantics — strings sage, numbers sand, keywords steel, punctuation dim —
     desaturated so they can never compete with the UI's one accent. ── */
  const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const JSE_KEYWORDS = new Set(["true", "false", "null", "undefined", "nil", "typeof", "await", "return", "if", "else", "try", "catch", "finally", "const", "let", "for", "while", "switch", "case", "break", "continue", "throw", "of", "new"]);
  function jseHighlightHTML(src) {
    const s = String(src ?? "");
    let out = "", i = 0;
    const push = (cls, text) => { out += cls ? `<span class="sl-syn-${cls}">${escHtml(text)}</span>` : escHtml(text); };
    while (i < s.length) {
      const c = s[i];
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
        push("str", s.slice(i, Math.min(j + 1, s.length)));
        i = j + 1; continue;
      }
      if (/[0-9]/.test(c) && !/[A-Za-z0-9_$]/.test(s[i - 1] || "")) {
        let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
        push("num", s.slice(i, j)); i = j; continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i; while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
        const word = s.slice(i, j);
        let k = j; while (k < s.length && /\s/.test(s[k])) k++;
        if (JSE_KEYWORDS.has(word)) push("kw", word);
        else if (s[k] === "(") push("fn", word);
        else push(null, word);
        i = j; continue;
      }
      if (/[()[\]{}.,;]/.test(c)) { push("pun", c); i++; continue; }
      if (/[?:+\-*/%<>=!&|]/.test(c)) {
        let j = i; while (j < s.length && /[?:+\-*/%<>=!&|]/.test(s[j])) j++;
        push("op", s.slice(i, j)); i = j; continue;
      }
      push(null, c); i++;
    }
    return out;
  }
  /* deterministic display formatting: short stays one line; long breaks at
     depth-0 ternary arms and logical joins with a 2-space hang. Ternary colons
     are unambiguous at depth 0 — the emitter parenthesizes root object
     literals, so a bare \` : \` outside brackets is always a ternary. */
  function jseFormat(src, width = 34) {
    const s = String(src ?? "");
    if (s.length <= width || s.includes("\n")) return s;
    let out = "", depth = 0, quote = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        out += c;
        if (c === "\\") { out += s[++i] ?? ""; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; out += c; continue; }
      if ("([{".includes(c)) depth++;
      if (")]}".includes(c)) depth--;
      if (depth === 0 && c === " ") {
        const two = s.slice(i + 1, i + 3), one = s[i + 1];
        if ((one === "?" || one === ":") && s[i + 2] === " ") { out += "\n  " + one + " "; i += 2; continue; }
        if ((two === "&&" || two === "||") && s[i + 3] === " ") { out += "\n  " + two + " "; i += 3; continue; }
      }
      out += c;
    }
    // arms that are still long break once more at a depth-0 additive join,
    // continuation hanging two steps in
    return out.split("\n").map((line) => {
      if (line.length <= width + 4) return line;
      let d = 0, q = null;
      for (let i = 4; i < line.length - 2; i++) {
        const c = line[i];
        if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        if ("([{".includes(c)) d++;
        else if (")]}".includes(c)) d--;
        else if (d === 0 && c === " " && (line[i + 1] === "+" || line[i + 1] === "-") && line[i + 2] === " ")
          return line.slice(0, i) + "\n    " + line.slice(i + 1);
      }
      return line;
    }).join("\n");
  }
  /* typed value rendering for the recessed readouts (results, live wells) */
  function valueHTML(v) {
    if (v === undefined) return `<span class="sl-syn-pun">–</span>`;
    if (v === null) return `<span class="sl-syn-kw">null</span>`;
    if (typeof v === "boolean") return `<span class="sl-syn-kw">${v}</span>`;
    if (typeof v === "number") return `<span class="sl-syn-num">${escHtml(String(v))}</span>`;
    if (typeof v === "string") return `<span class="sl-syn-str">"${escHtml(v)}"</span>`;
    try { return jseHighlightHTML(JSON.stringify(v)); } catch { return escHtml(String(v)); }
  }
  /* the full, copyable form of a value — pretty JSON for structures, the raw
     string for strings (what you'd paste into code or a request body) */
  function prettyValue(v) {
    if (v === undefined) return "undefined";
    if (typeof v === "string") return v;
    try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
  }
  /* the clamped per-step preview: scalars stay one centered line; structures
     pretty-print up to `max` lines, then clamp with a line count — the full
     value lives one click away in the inspector, never crammed into the card */
  function previewInfo(v, max = 3) {
    if (v === undefined || v === null || typeof v !== "object")
      return { html: valueHTML(v), lines: 1, clamped: false, total: 1 };
    let text;
    try { text = JSON.stringify(v, null, 2) ?? "null"; } catch { text = String(v); }
    const all = text.split("\n");
    if (all.length <= max) return { html: jseHighlightHTML(text), lines: all.length, clamped: false, total: all.length };
    return { html: jseHighlightHTML(all.slice(0, max).join("\n")), lines: max, clamped: true, total: all.length };
  }
  const litKind = (v) => (v === null || v === undefined ? "Null" : typeof v === "boolean" ? "Boolean" : typeof v === "number" ? "Number" : typeof v === "string" ? "String" : "JSON");

  /* ── the SDK class ── */
  class StackLogic {
    constructor(mount, opts = {}) {
      if (!mount || !mount.appendChild) throw new Error("StackLogic needs a mount element");
      this.mount = mount;
      this.opts = opts;
      this.scope = opts.scope && typeof opts.scope === "object" ? opts.scope : {};
      this.readOnly = !!opts.readOnly;
      this._showCode = !!opts.code;
      this._theme = opts.theme === "light" || opts.theme === "dark" ? opts.theme : "auto";
      if (opts.icons) registerIcons(opts.icons, opts.iconMode);
      this.graph = { v: 1, kind: "expression", nodes: {}, out: { value: null } };
      this._handlers = {};
      this._pos = {};        // ephemeral node positions (id → {x,y}; "@out" = output card)
      this._view = { x: 40, y: 40, z: 1 };
      this._sel = null;
      this._pending = null;  // wire drag state
      this._raf = 0;

      const doc = mount.ownerDocument;
      injectStyles(doc, mount.getRootNode && mount.getRootNode() !== doc ? mount.getRootNode() : null);
      this.viewport = doc.createElement("div");
      this.viewport.className = "sl-viewport";
      this.viewport.tabIndex = 0;
      this.viewport.style.width = "100%";
      this.viewport.style.height = "100%";
      this.grid = doc.createElement("div");
      this.grid.className = "sl-grid";
      this.fade = doc.createElement("div");   // static vignette: fades the grid toward the edges, sits under the world
      this.fade.className = "sl-fade";
      this.world = doc.createElement("div");
      this.world.className = "sl-world";
      this.wires = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.wires.setAttribute("class", "sl-wires");
      this.world.appendChild(this.wires);
      this.viewport.appendChild(this.grid);
      this.viewport.appendChild(this.fade);
      this.viewport.appendChild(this.world);
      mount.appendChild(this.viewport);
      // theme: dark is the reference; "auto" follows the system live
      const win = doc.defaultView;
      this._mql = win && win.matchMedia ? win.matchMedia("(prefers-color-scheme: light)") : null;
      this._onScheme = () => { if (this._theme === "auto") this._applyTheme(); };
      if (this._mql && this._mql.addEventListener) this._mql.addEventListener("change", this._onScheme);
      this._applyTheme();
      this._buildFurniture(doc);
      this._applyView();   // CSS transform must match _view before any wire math

      this._wireEvents();
      if (opts.graph != null) this.load(opts.graph);
      else if (opts.jse != null) this.load(String(opts.jse));
      else this._render(true);
    }

    /* ── events ── */
    on(name, fn) {
      (this._handlers[name] ??= []).push(fn);
      return () => this.off(name, fn);
    }
    off(name, fn) {
      const a = this._handlers[name];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    }
    _emit(name, payload) {
      for (const fn of this._handlers[name] || []) { try { fn(payload); } catch (_) { /* host error */ } }
      for (const fn of this._handlers["*"] || []) { try { fn({ type: name, ...payload }); } catch (_) { /* host error */ } }
    }

    /* ── public API ── */
    load(graphOrJse) {
      let graph;
      if (typeof graphOrJse === "string") {
        const t = graphOrJse.trim();
        if (t.startsWith("{") && t.includes("\"nodes\"")) { try { graph = JSON.parse(t); } catch { graph = null; } }
        if (!graph) graph = lift(t);
      } else if (graphOrJse && typeof graphOrJse === "object") {
        graph = JSON.parse(JSON.stringify(graphOrJse));
      }
      if (!graph || typeof graph !== "object" || graph.kind === "action")
        throw new Error("StackLogic.load: expected a formula graph or JSE text (kind 'action' is phase 2)");
      graph.v = 1;
      graph.kind = graph.kind === "formula" ? "formula" : "expression";
      graph.nodes = graph.nodes || {};
      graph.out = graph.out || { value: null };
      this.graph = graph;
      this._pos = {};
      this._sel = null;
      this.inspect(null);
      this._updateNameChip();
      this._render(true);
      if (this.opts.fit !== false) this.fit();
      this._emit("ready", { nodes: Object.keys(graph.nodes).length, jse: this.getJSE() });
    }
    setScope(scope) {
      this.scope = scope && typeof scope === "object" ? scope : {};
      this._refresh();
    }
    /* "auto" (default) follows the system scheme live; "light"/"dark" pin it */
    setTheme(theme) {
      this._theme = theme === "light" || theme === "dark" ? theme : "auto";
      this._applyTheme();
    }
    _applyTheme() {
      const light = this._theme === "auto" ? !!(this._mql && this._mql.matches) : this._theme === "light";
      this.viewport.classList.toggle("sl-light", light);
    }
    /* ── the INSPECTOR: a right-docked panel pinned to a step. The card shows
       three lines; the inspector shows EVERYTHING — the full value, properly
       formatted and highlighted, copyable, recalculating live on every edit,
       with the step's compiled code one quiet toggle away. Open it from a
       clamp chip, by double-clicking any readout, or via inspect(id). It
       follows selection while open, so walking the graph walks the data. ── */
    inspect(target) {
      if (!target) {
        this._inspect = null;
        if (this._insEl) { this._insEl.remove(); this._insEl = null; }
        this.viewport.classList.remove("sl-inspecting");
        return;
      }
      if (target !== "@out" && !this.graph.nodes[target]) return;
      this._inspect = target;
      this.viewport.classList.add("sl-inspecting");
      this._renderInspector(true);
    }
    _renderInspector(rebuild) {
      if (!this._inspect) return;
      const doc = this.viewport.ownerDocument;
      const report = this._report || this.evaluate();
      const isOut = this._inspect === "@out";
      const node = isOut ? null : this.graph.nodes[this._inspect];
      if (!isOut && !node) { this.inspect(null); return; }

      if (!this._insEl || rebuild) {
        if (this._insEl) this._insEl.remove();
        const panel = doc.createElement("div");
        panel.className = "sl-inspector";
        const meta = isOut ? null : (NODE_META[node.kind] || NODE_META.code);
        const glyph = isOut ? `<span class="sl-kind sl-k-out">${icon("flag", 12)}</span>`
          : `<span class="sl-kind">${kindHTML(meta)}</span>`;
        const meta2 = stepMeta(this.graph, node);
        panel.innerHTML =
          `<div class="sl-ins-head">${glyph}<span class="sl-title">${escHtml(isOut ? "Output" : (NODE_META[node.kind] || NODE_META.code).title(node))}</span>` +
          `<span class="sl-ins-tag">${escHtml(isOut ? "result" : node.kind)}</span>` +
          `<button class="sl-ghost sl-ins-close" title="Close">${icon("close", 12)}</button></div>` +
          `<div class="sl-ins-body">` +
          `<div class="sl-ins-label">Value<button class="sl-ghost sl-ins-copy" title="Copy value">${icon("copy", 12)}</button></div>` +
          `<pre class="sl-ins-value"></pre>` +
          `<div class="sl-ins-meta">` +
          `<div class="sl-ins-mrow"><span class="sl-ins-mlabel">Type</span><span class="sl-ins-mval sl-ins-type">–</span></div>` +
          `<div class="sl-ins-mrow"><span class="sl-ins-mlabel">Source</span><span class="sl-ins-mval sl-mono">${escHtml(meta2.source)}</span></div>` +
          `</div>` +
          `<div class="sl-ins-label sl-ins-dochead"><span>Documentation</span></div>` +
          `<div class="sl-ins-doc">${meta2.doc}</div>` +
          `<div class="sl-ins-label sl-ins-codehead"><button class="sl-ghost sl-ins-codetoggle" title="Show code">${icon("code", 12)}</button><span>${isOut ? "Formula code" : "Step code"}</span>` +
          `<button class="sl-ghost sl-ins-copycode" title="Copy code" style="margin-left:auto">${icon("copy", 12)}</button></div>` +
          `<pre class="sl-ins-code" style="display:none"></pre>` +
          `</div>`;
        panel.querySelector(".sl-ins-close").addEventListener("click", () => this.inspect(null));
        panel.querySelector(".sl-ins-copy").addEventListener("click", () => this._copyText(this._insValueRaw ?? ""));
        panel.querySelector(".sl-ins-copycode").addEventListener("click", () => this._copyText(this._insCodeRaw ?? ""));
        const codeEl = () => panel.querySelector(".sl-ins-code");
        panel.querySelector(".sl-ins-codetoggle").addEventListener("click", (e) => {
          const el = codeEl();
          const on = el.style.display === "none";
          el.style.display = on ? "" : "none";
          e.currentTarget.classList.toggle("sl-on", on);
        });
        panel.addEventListener("pointerdown", (e) => e.stopPropagation());
        panel.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
        this.viewport.appendChild(panel);
        this._insEl = panel;
      }

      const v = isOut ? report.result : report.values[this._inspect];
      this._insValueRaw = prettyValue(v);
      let code = "";
      if (isOut) code = report.jse;
      else { try { code = compilePort({ node: this._inspect }, this.graph, 1, "root", new Set()); } catch (_) { code = ""; } }
      this._insCodeRaw = code;
      const valEl = this._insEl.querySelector(".sl-ins-value");
      const keep = valEl.scrollTop;
      valEl.innerHTML = v === undefined ? `<span class="sl-syn-pun">– (not evaluable with the current scope)</span>`
        : typeof v === "string" ? `<span class="sl-syn-str">${escHtml(v) || "&nbsp;"}</span>`
        : jseHighlightHTML(this._insValueRaw);
      valEl.scrollTop = keep;
      const typeEl = this._insEl.querySelector(".sl-ins-type");
      if (typeEl) typeEl.textContent = typeName(v);   // recalculates live with the value
      this._insEl.querySelector(".sl-ins-code").innerHTML = code ? jseHighlightHTML(jseFormat(code, 30)) : `<span class="sl-syn-pun">–</span>`;
    }
    _copyText(t) {
      const nav = this.viewport.ownerDocument.defaultView?.navigator;
      if (nav && nav.clipboard) nav.clipboard.writeText(String(t)).catch(() => {});
    }

    /* show/hide the compiled-JSE readout on the Output card (default hidden —
       the visual editor stays visual; code appears on request) */
    setCode(on) {
      this._showCode = !!on;
      const jse = this.world.querySelector(".sl-jse");
      const btn = this.world.querySelector(".sl-out-card .sl-ghost");
      if (jse) jse.style.display = this._showCode ? "" : "none";
      if (btn) { btn.classList.toggle("sl-on", this._showCode); btn.title = this._showCode ? "Hide code" : "Show code"; }
      this._drawWires();
    }
    getGraph() { return JSON.parse(JSON.stringify(this.graph)); }
    getJSE() { try { return compileGraph(this.graph); } catch (_) { return ""; } }
    evaluate() { return evaluateGraph(this.graph, this.scope); }
    /* layout is EDITOR STATE, never part of the code: hosts that want a manual
       arrangement to survive reloads persist getLayout() next to their editor
       prefs (not in the .dsx) and restore it after load(). Unknown ids are
       ignored, so a layout from an older revision degrades gracefully. */
    getLayout() {
      return { positions: JSON.parse(JSON.stringify(this._pos)), view: { ...this._view } };
    }
    setLayout(layout) {
      if (!layout || typeof layout !== "object") return;
      const pos = layout.positions || {};
      for (const [id, p] of Object.entries(pos)) {
        if ((id === "@out" || this.graph.nodes[id]) && p && typeof p.x === "number" && typeof p.y === "number")
          this._pos[id] = { x: p.x, y: p.y };
      }
      this._laidOut = true;
      if (layout.view && typeof layout.view.z === "number") this._view = { x: layout.view.x || 0, y: layout.view.y || 0, z: layout.view.z };
      this._applyView();
      this._applyPositions();
      this._drawWires();
    }
    fit() {
      const nodes = this.world.querySelectorAll(".sl-node, .sl-out-card");
      if (!nodes.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const el of nodes) {
        const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + el.offsetWidth); maxY = Math.max(maxY, y + el.offsetHeight);
      }
      const vw = this.viewport.clientWidth || 800, vh = this.viewport.clientHeight || 500;
      const pad = 48;
      const z = Math.min(1.25, Math.max(0.25, Math.min((vw - pad * 2) / Math.max(1, maxX - minX), (vh - pad * 2) / Math.max(1, maxY - minY))));
      this._view = {
        z,
        x: (vw - (maxX - minX) * z) / 2 - minX * z,
        y: (vh - (maxY - minY) * z) / 2 - minY * z,
      };
      this._applyView();
      this._drawWires();
    }
    destroy() {
      if (this._mql && this._mql.removeEventListener) this._mql.removeEventListener("change", this._onScheme);
      this.viewport.remove();
      this._handlers = {};
    }

    static compile(graph) { return compileGraph(graph); }
    static lift(jse, functions) { return lift(jse, functions); }
    static evaluateGraph(graph, scope) { return evaluateGraph(graph, scope); }
    static registerCatalog(entry) { registerCatalog(entry); }

    /* ── internals ── */
    _commit(relayout) {
      this._render(relayout);
      this._emit("change", { graph: this.getGraph(), jse: this.getJSE() });
    }
    _refresh() {
      const report = this.evaluate();
      this._report = report;
      for (const [id, v] of Object.entries(report.values)) {
        const el = this.world.querySelector(`.sl-node[data-id="${id}"] .sl-live`);
        if (!el) continue;
        const p = previewInfo(v, 3);
        el.classList.toggle("sl-multi", p.lines > 1);
        el.innerHTML = `<span class="sl-live-body">${p.html}</span>` +
          (p.clamped ? `<button class="sl-more" title="Inspect the full value">⋯ ${p.total} lines</button>` : "");
      }
      const res = this.world.querySelector(".sl-result-text");
      if (res) {
        if (report.jse === "") res.innerHTML = `<span class="sl-syn-pun">–</span>`;
        else {
          const p = previewInfo(report.result, 4);
          res.innerHTML = p.html +
            (p.clamped ? `<button class="sl-more" title="Inspect the full result">⋯ ${p.total} lines</button>` : "");
        }
      }
      if (this._inspect) this._renderInspector(false);
      const jseEl = this.world.querySelector(".sl-jse-text");
      if (jseEl) jseEl.innerHTML = report.jse ? jseHighlightHTML(jseFormat(report.jse)) : escHtml("(empty formula)");
      // wired row previews stay neutral text — rows are chrome, wells are readouts
      for (const row of this.world.querySelectorAll(".sl-row[data-src]")) {
        const src = row.getAttribute("data-src");
        const vEl = row.querySelector(".sl-val");
        if (vEl && src && src in report.values) vEl.textContent = shortVal(report.values[src]);
      }
      this._emit("preview", { values: report.values, result: report.result, jse: report.jse });
    }

    _render(relayout) {
      const doc = this.viewport.ownerDocument;
      for (const el of [...this.world.children]) if (el !== this.wires) el.remove();
      const nodes = this.graph.nodes || {};
      const ids = Object.keys(nodes);

      // build node cards
      for (const id of ids) this.world.appendChild(this._nodeCard(doc, id, nodes[id]));
      this.world.appendChild(this._outCard(doc));

      let empty = this.viewport.querySelector(".sl-empty");
      if (!ids.length && !("code" in (this.graph.out || {})) && this.graph.out?.value == null) {
        if (!empty) {
          empty = doc.createElement("div");
          empty.className = "sl-empty";
          empty.textContent = this.readOnly ? "No formula" : "Double-click the canvas to add a node";
          this.viewport.appendChild(empty);
        }
      } else if (empty) empty.remove();

      if (relayout || !this._laidOut) { this._layout(); this._laidOut = true; }
      else this._applyPositions();
      this._drawWires();
      this._refresh();
    }

    _nodeCard(doc, id, node) {
      const meta = NODE_META[node.kind] || NODE_META.code;
      // a source node is a data leaf — an input, a map item, a variable read:
      // where external data ENTERS the formula. It earns the amber highlight.
      const isSource = node.kind === "path";
      const card = doc.createElement("div");
      // sl-n-<kind> is the silhouette hook; sl-fam-* is the COLOR family (the
      // 2px crown + glyph tint): logic decides, math computes, sources enter —
      // comparison/boolean operators are logic, arithmetic is math, and the
      // catalog's group places functions (see the family block in the styles)
      let fam = "";
      if (node.kind === "if") fam = "logic";
      else if (node.kind === "op") fam = ["+", "-", "*", "/", "%", "neg"].includes(node.op) ? "math" : "logic";
      else if (node.kind === "fn") {
        const g = (CAT.byId.get(node.fn) || {}).group;
        if (g === "Numbers") fam = "math";
        else if (g === "Logic") fam = "logic";
      }
      card.className = "sl-node sl-n-" + node.kind + (fam ? " sl-fam-" + fam : "") + (this._sel === id ? " sl-selected" : "") + (node.__collapsed ? " sl-collapsed" : "") + (isSource ? " sl-source" : "");
      card.dataset.id = id;

      const head = doc.createElement("div");
      head.className = "sl-head";
      // one left slot: type glyph at rest, collapse chevron on hover
      const lead = doc.createElement("div");
      lead.className = "sl-lead";
      lead.innerHTML = `<span class="sl-kind">${kindHTML(meta)}</span><span class="sl-chevron">${icon("chevron", 12)}</span>`;
      lead.addEventListener("click", (e) => { e.stopPropagation(); node.__collapsed = !node.__collapsed; this._render(false); });
      const title = doc.createElement("span");
      title.className = "sl-title";
      title.textContent = meta.title(node);
      head.appendChild(lead); head.appendChild(title);
      const out = doc.createElement("div");
      out.className = "sl-port sl-port-out";
      out.dataset.out = id;
      card.appendChild(head);
      card.appendChild(out);

      // path nodes: the NAME is the title (no chip redundancy); rename in place
      if (node.kind === "path" && !this.readOnly) {
        title.style.cursor = "text";
        title.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          this._editText(title, node.path, (t) => {
            if (PATH_RE.test(t)) { node.path = t; this._commit(false); }
            else this._render(false);
          });
        });
      }

      if (node.kind === "value") {
        const rows = doc.createElement("div");
        rows.className = "sl-rows";
        rows.appendChild(this._literalRow(doc, "Value", { get: () => ({ value: node.value }), set: (p) => { node.value = "value" in p ? p.value : null; } }, null, id));
        card.appendChild(rows);
      } else if (node.kind === "code") {
        const rows = doc.createElement("div");
        rows.className = "sl-rows";
        const row = doc.createElement("div");
        row.className = "sl-row";
        const val = doc.createElement("div");
        val.className = "sl-val";
        val.style.fontFamily = "var(--sl-mono)";
        val.style.fontSize = "11px";
        val.innerHTML = node.jse ? jseHighlightHTML(node.jse) : "…";
        if (!this.readOnly) val.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          this._editText(val, node.jse || "", (t) => { node.jse = t; this._commit(false); }, true);
        });
        const badge = doc.createElement("span");
        badge.className = "sl-chip";
        badge.textContent = "JSE";
        row.appendChild(val); row.appendChild(badge);
        rows.appendChild(row);
        card.appendChild(rows);
      } else {
        // rowless kinds (a path read has no arguments) skip the rows surface
        // entirely — a source is a compact pill of head + live value
        const rows = nodeRows(node, this.graph);
        if (rows.length) {
          const rowsEl = doc.createElement("div");
          rowsEl.className = "sl-rows";
          for (const r of rows) rowsEl.appendChild(this._argRow(doc, id, node, r));
          // if-node: add-case affordance rides the last row set
          if (node.kind === "if" && !this.readOnly) {
            const add = doc.createElement("button");
            add.className = "sl-addcase";
            add.textContent = "+ Add case";
            add.addEventListener("click", (e) => {
              e.stopPropagation();
              node.cases.push({ when: { value: true }, then: { value: null } });
              this._commit(false);
            });
            rowsEl.appendChild(add);
          }
          card.appendChild(rowsEl);
        }
      }

      // live value box (every node except output card)
      const live = doc.createElement("div");
      live.className = "sl-live";
      live.textContent = "–";
      card.appendChild(live);

      // selection + drag
      card.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".sl-port") || e.target.closest("button") || e.target.closest("input")) return;
        this._select(id);
        if (this.readOnly || !e.target.closest(".sl-head")) return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY };
        const pos = { ...(this._pos[id] || { x: 0, y: 0 }) };
        const move = (ev) => {
          this._pos[id] = { x: pos.x + (ev.clientX - start.x) / this._view.z, y: pos.y + (ev.clientY - start.y) / this._view.z };
          this._applyPositions();
          this._drawWires();
        };
        const up = () => { doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up); };
        doc.addEventListener("pointermove", move);
        doc.addEventListener("pointerup", up);
      });
      return card;
    }

    _argRow(doc, id, node, r) {
      const port = r.get();
      const row = doc.createElement("div");
      const wired = port && typeof port === "object" && "node" in port;
      row.className = "sl-row" + (wired ? " sl-wired" : "");
      if (wired) row.dataset.src = port.node;
      row.dataset.node = id;

      const inDot = doc.createElement("div");
      inDot.className = "sl-port sl-port-in";
      inDot.__slot = r;
      row.appendChild(inDot);

      const label = doc.createElement("span");
      label.className = "sl-label";
      label.textContent = r.label;
      row.appendChild(label);

      if (wired) {
        const val = doc.createElement("span");
        val.className = "sl-val sl-wiredval";
        val.textContent = "–";
        row.appendChild(val);
      } else if ("code" in (port || {})) {
        const val = doc.createElement("span");
        val.className = "sl-val";
        val.style.fontFamily = "var(--sl-mono)";
        val.style.fontSize = "11px";
        val.innerHTML = jseHighlightHTML(port.code);
        if (!this.readOnly) val.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          this._editText(val, port.code, (t) => { r.set({ code: t }); this._commit(false); }, true);
        });
        row.appendChild(val);
        const badge = doc.createElement("span");
        badge.className = "sl-chip";
        badge.textContent = "fx";
        row.appendChild(badge);
      } else {
        const v = (port || {}).value;
        const val = doc.createElement("span");
        val.className = "sl-val";
        val.textContent = v === null || v === undefined ? "–" : typeof v === "string" ? v : shortVal(v);
        if (!this.readOnly) val.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          const cur = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
          this._editText(val, cur, (t) => { r.set({ value: this._parseLiteral(t, litKind(v)) }); this._commit(false); });
        });
        row.appendChild(val);
        if (!this.readOnly) {
          const type = doc.createElement("button");
          type.className = "sl-type";
          type.textContent = litKind(v);
          type.addEventListener("click", (e) => {
            e.stopPropagation();
            const order = ["String", "Number", "Boolean", "Null", "JSON"];
            const next = order[(order.indexOf(litKind(v)) + 1) % order.length];
            r.set({ value: this._coerceLiteral(v, next) });
            this._commit(false);
          });
          row.appendChild(type);
        } else {
          const type = doc.createElement("span");
          type.className = "sl-type";
          type.textContent = litKind(v);
          row.appendChild(type);
        }
      }
      return row;
    }

    _literalRow(doc, labelText, slot, _node, _id) {
      return this._argRow(doc, _id, _node, { label: labelText, get: slot.get, set: slot.set });
    }

    _outCard(doc) {
      const card = doc.createElement("div");
      card.className = "sl-out-card";
      card.dataset.out = "@card";
      const head = doc.createElement("div");
      head.className = "sl-out-head";
      head.innerHTML = `<span class="sl-kind sl-k-out">${icon("flag", 12)}</span><span class="sl-title">Output</span>`;
      // the visual editor stays visual: JSE is there on request, one quiet
      // toggle — the full code-editor / split view is a separate component
      const codeBtn = doc.createElement("button");
      codeBtn.className = "sl-ghost" + (this._showCode ? " sl-on" : "");
      codeBtn.title = "Show code";
      codeBtn.innerHTML = icon("code", 13);
      codeBtn.addEventListener("click", (e) => { e.stopPropagation(); this.setCode(!this._showCode); });
      head.appendChild(codeBtn);
      card.appendChild(head);

      const res = doc.createElement("div");
      res.className = "sl-result";
      const resText = doc.createElement("span");
      resText.className = "sl-result-text";
      resText.textContent = "–";
      res.appendChild(resText);
      res.appendChild(this._copyBtn(doc, () => shortVal((this._report || {}).result)));
      card.appendChild(res);

      const jse = doc.createElement("div");
      jse.className = "sl-jse";
      if (!this._showCode) jse.style.display = "none";
      const jseText = doc.createElement("span");
      jseText.className = "sl-jse-text";
      jseText.textContent = "(empty formula)";
      jse.appendChild(jseText);
      jse.appendChild(this._copyBtn(doc, () => (this._report || {}).jse || ""));
      card.appendChild(jse);

      const inDot = doc.createElement("div");
      inDot.className = "sl-port sl-port-in" + (this.graph.out && this.graph.out.node ? " sl-plugged" : "");
      // a card-level socket (no row nesting): straddle the border, centered on
      // the header band beside the flag
      inDot.style.left = "-5px";
      inDot.style.top = "11px";
      inDot.style.marginTop = "0";
      inDot.__slot = { label: "Output", get: () => this.graph.out, set: (p) => { this.graph.out = p; } };
      card.appendChild(inDot);

      card.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".sl-port") || e.target.closest("button")) return;
        if (this.readOnly || !e.target.closest(".sl-out-head")) return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY };
        const pos = { ...(this._pos["@out"] || { x: 0, y: 0 }) };
        const move = (ev) => {
          this._pos["@out"] = { x: pos.x + (ev.clientX - start.x) / this._view.z, y: pos.y + (ev.clientY - start.y) / this._view.z };
          this._applyPositions();
          this._drawWires();
        };
        const up = () => { doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up); };
        doc.addEventListener("pointermove", move);
        doc.addEventListener("pointerup", up);
      });
      return card;
    }

    _copyBtn(doc, getText) {
      const b = doc.createElement("button");
      b.className = "sl-copy";
      b.innerHTML = icon("copy", 13);
      b.addEventListener("click", () => {
        const t = String(getText() ?? "");
        const nav = this.viewport.ownerDocument.defaultView?.navigator;
        if (nav && nav.clipboard) nav.clipboard.writeText(t).catch(() => {});
      });
      return b;
    }

    _editText(el, current, commit, mono) {
      const doc = el.ownerDocument;
      const input = doc.createElement("input");
      input.value = current;
      if (mono) input.style.fontFamily = "var(--sl-mono)";
      el.textContent = "";
      el.appendChild(input);
      input.focus();
      input.select();
      const done = (ok) => {
        input.remove();
        if (ok) commit(input.value);
        else this._render(false);
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      });
      input.addEventListener("blur", () => done(true));
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
    }

    _parseLiteral(text, kind) {
      const t = String(text);
      if (kind === "Number") { const n = parseFloat(t); return Number.isNaN(n) ? 0 : n; }
      if (kind === "Boolean") return t.trim() === "true";
      if (kind === "Null") return null;
      if (kind === "JSON") { try { return JSON.parse(t); } catch { return t; } }
      return t;
    }
    _coerceLiteral(v, kind) {
      if (kind === "String") return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
      if (kind === "Number") return num(v);
      if (kind === "Boolean") return truthy(v);
      if (kind === "Null") return null;
      if (kind === "JSON") { if (typeof v === "string") { try { return JSON.parse(v); } catch { return {}; } } return typeof v === "object" && v ? v : {}; }
      return v;
    }

    _select(id) {
      if (this._sel === id) return;
      this._sel = id;
      for (const el of this.world.querySelectorAll(".sl-node")) el.classList.toggle("sl-selected", el.dataset.id === id);
      this._drawWires();   // the selected step's wires brighten + carry the flow current
      // an open inspector follows selection: walking the graph walks the data
      if (this._inspect && id && this._inspect !== id) this.inspect(id);
      const node = id ? this.graph.nodes[id] : null;
      if (node) this._emit("select", { id, kind: node.kind });
      else this._emit("deselect", {});
    }

    _layout() {
      const { rank, order } = layoutRanks(this.graph);
      const COLW = 280, GAPY = 30;
      const byRank = {};
      for (const [id, r] of Object.entries(rank)) (byRank[r] ??= []).push(id);
      const maxRank = Math.max(1, ...Object.keys(byRank).map(Number));
      // measure pass: cards are in the DOM already (auto positions), read heights
      const heights = {};
      for (const el of this.world.querySelectorAll(".sl-node")) heights[el.dataset.id] = el.offsetHeight || 90;
      for (const r of Object.keys(byRank).map(Number).sort((a, b) => a - b)) {
        let y = 0;
        for (const id of byRank[r].sort((a, b) => (order[a] ?? 0) - (order[b] ?? 0))) {
          this._pos[id] = { x: (maxRank - r) * COLW, y };
          y += (heights[id] || 90) + GAPY;
        }
      }
      this._pos["@out"] = this._pos["@out"] || { x: (maxRank) * COLW + 48, y: 0 };
      this._applyPositions();
    }
    _applyPositions() {
      for (const el of this.world.querySelectorAll(".sl-node")) {
        const p = this._pos[el.dataset.id] || { x: 0, y: 0 };
        el.style.left = p.x + "px";
        el.style.top = p.y + "px";
      }
      const out = this.world.querySelector(".sl-out-card");
      if (out) {
        const p = this._pos["@out"] || { x: 0, y: 0 };
        out.style.left = p.x + "px";
        out.style.top = p.y + "px";
      }
    }

    _portXY(el) {
      // element center in WORLD coordinates (positions are untransformed CSS px)
      const r = el.getBoundingClientRect();
      const vr = this.viewport.getBoundingClientRect();
      return {
        x: (r.left + r.width / 2 - vr.left - this._view.x) / this._view.z,
        y: (r.top + r.height / 2 - vr.top - this._view.y) / this._view.z,
      };
    }
    _drawWires() {
      const svg = this.wires;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const pulse = this._pulse;   // a just-plugged connection draws itself in, once
      this._pulse = null;
      const mk = (a, b, opts = {}) => {
        const d = (() => {
          const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
          return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
        })();
        const path = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        // fresh-draw wins the class; a selected node's wires take the accent
        if (opts.live) path.setAttribute("class", "sl-live-wire");
        else if (opts.fresh) { path.setAttribute("pathLength", "1"); path.setAttribute("class", "sl-wire-new" + (opts.on ? " sl-wire-on" : "")); }
        else if (opts.on) path.setAttribute("class", "sl-wire-on");
        svg.appendChild(path);
      };
      const sel = this._sel;
      const outDots = {};
      for (const el of this.world.querySelectorAll(".sl-port-out")) outDots[el.dataset.out] = el;
      for (const row of this.world.querySelectorAll(".sl-row[data-src]")) {
        const srcId = row.getAttribute("data-src");
        const src = outDots[srcId];
        const dot = row.querySelector(".sl-port-in");
        if (src && dot) mk(this._portXY(src), this._portXY(dot), {
          fresh: pulse && pulse.src === srcId,
          on: !!sel && (srcId === sel || row.dataset.node === sel),
        });
      }
      const outCardDot = this.world.querySelector(".sl-out-card .sl-port-in");
      if (outCardDot && this.graph.out && this.graph.out.node && outDots[this.graph.out.node])
        mk(this._portXY(outDots[this.graph.out.node]), this._portXY(outCardDot), {
          fresh: pulse && pulse.src === this.graph.out.node,
          on: !!sel && this.graph.out.node === sel,
        });
      if (this._pending && this._pending.from && this._pending.to)
        mk(this._pending.from, this._pending.to, { live: true });
    }

    _applyView() {
      this.world.style.transform = `translate(${this._view.x}px, ${this._view.y}px) scale(${this._view.z})`;
      // the grid pans by its MAJOR period (4 minors = 96 world px, zoom-scaled)
      // so both line weights stay glued to the world as it moves
      const minor = 24 * this._view.z, major = 96 * this._view.z;
      this.grid.style.transform = `translate(${this._view.x % major}px, ${this._view.y % major}px)`;
      this.grid.style.backgroundSize = `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`;
      if (this._pctEl) this._pctEl.textContent = Math.round(this._view.z * 100) + "%";
    }

    _buildFurniture(doc) {
      const bar = doc.createElement("div");
      bar.className = "sl-controls";
      const btn = (html, title, fn, cls) => {
        const b = doc.createElement("button");
        b.className = "sl-ctl" + (cls ? " " + cls : "");
        b.title = title;
        b.innerHTML = html;
        b.addEventListener("click", fn);
        return b;
      };
      bar.appendChild(btn(icon("minus", 13), "Zoom out", () => this._zoomStep(1 / 1.2)));
      this._pctEl = btn("100%", "Reset to 100%", () => this._zoomTo(1), "sl-ctl-pct");
      bar.appendChild(this._pctEl);
      bar.appendChild(btn(icon("plus", 13), "Zoom in", () => this._zoomStep(1.2)));
      bar.appendChild(btn(icon("fit", 13), "Zoom to fit", () => this.fit()));
      this.viewport.appendChild(bar);

      this._nameEl = doc.createElement("div");
      this._nameEl.className = "sl-namechip";
      this._nameEl.style.display = "none";
      this.viewport.appendChild(this._nameEl);
    }
    _updateNameChip() {
      if (!this._nameEl) return;
      const name = this.graph.kind === "formula" ? (this.graph.name || "Formula") : null;
      if (!name) { this._nameEl.style.display = "none"; return; }
      this._nameEl.style.display = "";
      this._nameEl.innerHTML = `<span class="sl-kind">${icon("fx", 11)}</span><span>${escHtml(name)}</span>`;
    }
    _zoomStep(f) {
      this._zoomTo(Math.min(2, Math.max(0.25, this._view.z * f)));
    }
    _zoomTo(z) {
      const vw = this.viewport.clientWidth / 2, vh = this.viewport.clientHeight / 2;
      const z0 = this._view.z;
      this._view.x = vw - ((vw - this._view.x) / z0) * z;
      this._view.y = vh - ((vh - this._view.y) / z0) * z;
      this._view.z = z;
      this._applyView();
      this._emit("view", { zoom: this._view.z, x: this._view.x, y: this._view.y });
    }

    _wireEvents() {
      const doc = this.viewport.ownerDocument;
      // pan
      this.viewport.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".sl-node") || e.target.closest(".sl-out-card") || e.target.closest(".sl-palette") || e.target.closest(".sl-port")) return;
        this._select(null);
        this._closePalette();
        this.viewport.classList.add("sl-panning");
        const start = { x: e.clientX, y: e.clientY, vx: this._view.x, vy: this._view.y };
        const move = (ev) => {
          this._view.x = start.vx + (ev.clientX - start.x);
          this._view.y = start.vy + (ev.clientY - start.y);
          this._applyView();
        };
        const up = () => {
          this.viewport.classList.remove("sl-panning");
          doc.removeEventListener("pointermove", move);
          doc.removeEventListener("pointerup", up);
          this._emit("view", { zoom: this._view.z, x: this._view.x, y: this._view.y });
        };
        doc.addEventListener("pointermove", move);
        doc.addEventListener("pointerup", up);
      });
      // zoom
      this.viewport.addEventListener("wheel", (e) => {
        e.preventDefault();
        const vr = this.viewport.getBoundingClientRect();
        const mx = e.clientX - vr.left, my = e.clientY - vr.top;
        const z0 = this._view.z;
        const z = Math.min(2, Math.max(0.25, z0 * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
        this._view.x = mx - ((mx - this._view.x) / z0) * z;
        this._view.y = my - ((my - this._view.y) / z0) * z;
        this._view.z = z;
        this._applyView();
      }, { passive: false });
      // wire drag (from an out port, or re-route from an in port)
      this.viewport.addEventListener("pointerdown", (e) => {
        const dot = e.target.closest(".sl-port");
        if (!dot || this.readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        let fromId = dot.dataset.out || null;
        let slot = dot.__slot || null;
        if (slot && !fromId) {
          const cur = slot.get();
          if (cur && typeof cur === "object" && "node" in cur) {
            // pick the wire up: detach and re-drag from its source
            fromId = cur.node;
            slot.set({ value: null });
            this._commit(false);
            slot = null;
          }
        }
        const startXY = this._portXY(dot);
        this._pending = { fromId, slot, from: fromId ? startXY : null, to: fromId ? startXY : null, toSlotXY: fromId ? null : startXY };
        const move = (ev) => {
          const vr = this.viewport.getBoundingClientRect();
          const wx = (ev.clientX - vr.left - this._view.x) / this._view.z;
          const wy = (ev.clientY - vr.top - this._view.y) / this._view.z;
          if (this._pending.fromId) this._pending.to = { x: wx, y: wy };
          else this._pending.from = { x: wx, y: wy };
          if (!this._pending.from) this._pending.from = { x: wx, y: wy };
          if (!this._pending.to) this._pending.to = this._pending.toSlotXY || { x: wx, y: wy };
          for (const d of this.world.querySelectorAll(".sl-port")) d.classList.toggle("sl-hot", d === ev.target || d.contains(ev.target));
          this._drawWires();
        };
        const up = (ev) => {
          doc.removeEventListener("pointermove", move);
          doc.removeEventListener("pointerup", up);
          for (const d of this.world.querySelectorAll(".sl-port")) d.classList.remove("sl-hot");
          const target = doc.elementFromPoint(ev.clientX, ev.clientY);
          const overDot = target && target.closest ? target.closest(".sl-port") : null;
          const pending = this._pending;
          this._pending = null;
          if (pending.fromId) {
            const toSlot = overDot && overDot.__slot;
            if (toSlot) { this._pulse = { src: pending.fromId }; toSlot.set({ node: pending.fromId }); this._commit(false); return; }
            if (!overDot && !target?.closest(".sl-node") && target?.closest(".sl-viewport") === this.viewport) {
              this._openPalette(ev.clientX, ev.clientY, { wireFrom: pending.fromId });
              this._drawWires();
              return;
            }
          } else if (pending.slot) {
            const srcId = overDot && overDot.dataset.out;
            if (srcId) { this._pulse = { src: srcId }; pending.slot.set({ node: srcId }); this._commit(false); return; }
            if (!overDot && target?.closest(".sl-viewport") === this.viewport) {
              this._openPalette(ev.clientX, ev.clientY, { wireToSlot: pending.slot });
              this._drawWires();
              return;
            }
          }
          this._drawWires();
        };
        doc.addEventListener("pointermove", move);
        doc.addEventListener("pointerup", up);
      }, true);
      // inspector: clamp chips click-open; any readout double-click-opens
      this.viewport.addEventListener("click", (e) => {
        const more = e.target.closest(".sl-more");
        if (!more) return;
        e.stopPropagation();
        const card = e.target.closest(".sl-node");
        this.inspect(card ? card.dataset.id : "@out");
      });
      this.viewport.addEventListener("dblclick", (e) => {
        const well = e.target.closest(".sl-live, .sl-result");
        if (!well) return;
        e.stopPropagation();
        const card = e.target.closest(".sl-node");
        this.inspect(card ? card.dataset.id : "@out");
      });
      // palette on double-click
      this.viewport.addEventListener("dblclick", (e) => {
        if (this.readOnly) return;
        if (e.target.closest(".sl-node") || e.target.closest(".sl-out-card") || e.target.closest(".sl-palette") || e.target.closest(".sl-inspector")) return;
        this._openPalette(e.clientX, e.clientY, {});
      });
      // delete
      this.viewport.addEventListener("keydown", (e) => {
        if (this.readOnly) return;
        if ((e.key === "Delete" || e.key === "Backspace") && this._sel && !e.target.closest("input")) {
          this._deleteNode(this._sel);
        }
        if (e.key === "Escape") {
          if (this._palette) { this._closePalette(); return; }
          if (this._inspect) { this.inspect(null); return; }
          this._select(null);
        }
      });
    }

    _deleteNode(id) {
      const nodes = this.graph.nodes;
      if (!nodes[id]) return;
      delete nodes[id];
      const scrub = (p) => (p && typeof p === "object" && p.node === id ? { value: null } : p);
      for (const n of Object.values(nodes)) {
        if (n.args) n.args = n.args.map(scrub);
        if (n.items) n.items = n.items.map(scrub);
        if (n.cases) for (const c of n.cases) { c.when = scrub(c.when); c.then = scrub(c.then); }
        if (n.else) n.else = scrub(n.else);
        if (n.target) n.target = scrub(n.target);
        if (n.body) n.body = scrub(n.body);
        if (n.entries) for (const en of n.entries) en.value = scrub(en.value);
      }
      this.graph.out = scrub(this.graph.out);
      if (this._inspect === id) this.inspect(null);
      this._select(null);
      this._commit(false);
    }

    _paletteItems() {
      const items = [];
      for (const f of this.graph.functions || []) {
        const entry = userFnEntry(this.graph, f.name);
        items.push({
          label: f.name, group: "Your formulas", type: "fx",
          make: () => ({ kind: "fn", fn: f.name, args: entry.params.map(() => ({ value: null })) }),
        });
      }
      items.push(
        { label: "If / Switch", group: "Logic", make: () => ({ kind: "if", cases: [{ when: { value: true }, then: { value: null } }], else: { value: null } }), type: "A|B" },
        { label: "Value", group: "Data", make: () => ({ kind: "value", value: "" }), type: "literal" },
        { label: "Input / Path", group: "Data", make: () => ({ kind: "path", path: (this.graph.inputs || [])[0]?.name || "dsx.variable.value" }), type: "read" },
        { label: "Custom code", group: "Data", make: () => ({ kind: "code", jse: "1 + 1" }), type: "JSE" },
        { label: "Object", group: "Data", make: () => ({ kind: "object", entries: [{ key: "key", value: { value: "" } }] }), type: "{}" },
        { label: "Array", group: "Data", make: () => ({ kind: "array", items: [{ value: "" }] }), type: "[]" }
      );
      for (const [op, label] of Object.entries(OP_LABELS)) {
        if (op === "neg") continue;
        items.push({ label: `${label} (${op})`, group: "Operators", make: () => ({ kind: "op", op, args: op === "!" ? [{ value: null }] : [{ value: null }, { value: null }] }), type: "op" });
      }
      for (const e of CATALOG) {
        items.push({
          label: e.label, group: e.group, type: e.returns,
          make: () => ({ kind: "fn", fn: e.id, args: e.params.map((p) => (p.type === "Function" ? { code: "x => x" } : { value: null })) }),
        });
      }
      return items;
    }

    _openPalette(cx, cy, intent) {
      this._closePalette();
      const doc = this.viewport.ownerDocument;
      const vr = this.viewport.getBoundingClientRect();
      const pal = doc.createElement("div");
      pal.className = "sl-palette";
      pal.style.left = Math.min(cx - vr.left, vr.width - 250) + "px";
      pal.style.top = Math.min(cy - vr.top, vr.height - 330) + "px";
      const search = doc.createElement("input");
      search.placeholder = "Search nodes…";
      pal.appendChild(search);
      const list = doc.createElement("div");
      pal.appendChild(list);
      const worldXY = {
        x: (cx - vr.left - this._view.x) / this._view.z,
        y: (cy - vr.top - this._view.y) / this._view.z,
      };
      const items = this._paletteItems();
      const renderList = (q) => {
        list.textContent = "";
        const ql = q.trim().toLowerCase();
        let group = null;
        for (const it of items) {
          if (ql && !it.label.toLowerCase().includes(ql) && !it.group.toLowerCase().includes(ql)) continue;
          if (it.group !== group) {
            group = it.group;
            const g = doc.createElement("div");
            g.className = "sl-pal-group";
            g.textContent = group;
            list.appendChild(g);
          }
          const b = doc.createElement("button");
          b.className = "sl-pal-item";
          b.innerHTML = `<span>${it.label}</span><span class="sl-pal-type">${it.type}</span>`;
          b.addEventListener("click", () => {
            const node = it.make();
            const id = this._newId();
            this.graph.nodes[id] = node;
            this._pos[id] = { x: worldXY.x, y: worldXY.y };
            if (intent.wireFrom) {
              // wire the dragged output into the new node's first open slot
              const rows = nodeRows(node, this.graph);
              if (rows.length) { rows[0].set({ node: intent.wireFrom }); this._pulse = { src: intent.wireFrom }; }
            }
            if (intent.wireToSlot) { intent.wireToSlot.set({ node: id }); this._pulse = { src: id }; }
            this._closePalette();
            this._laidOut = true;      // keep manual positions
            this._commit(false);
            this._select(id);
          });
          list.appendChild(b);
        }
      };
      renderList("");
      search.addEventListener("input", () => renderList(search.value));
      search.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") this._closePalette(); });
      this.viewport.appendChild(pal);
      this._palette = pal;
      search.focus();
    }
    _closePalette() {
      if (this._palette) { this._palette.remove(); this._palette = null; }
    }
    _newId() {
      let i = 1;
      while (this.graph.nodes["n" + i]) i++;
      return "n" + i;
    }
  }

  /* the headless JSE surface — the conformance seam (device-exact; DOM-free) */
  StackLogic.jse = {
    scopeCtx,
    evaluate(src, scope) { return jseEval(src, scopeCtx(scope)); },
    run(src, scope) { return jseRun(src, scopeCtx(scope)); },
  };
  StackLogic.catalog = CATALOG;
  StackLogic.icon = icon;
  /* register a filled/alternative icon set — { name: "<svg inner markup>" }.
     Pass mode "solid" to render with fill=currentColor (Hugeicons Pro Solid).
     Keep licensed (Pro) paths in the closed build, never in this open repo. */
  StackLogic.registerIcons = registerIcons;
  StackLogic.icons = ICONS;

  return StackLogic;
});
