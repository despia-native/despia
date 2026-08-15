/* ═════════════════════════════════════════════════════════════════════════════
   StackCanvas — a headless, embeddable canvas engine for DSX trees.
   Zero dependencies. Injects its own scoped styles. Multiple instances safe.

     const canvas = new StackCanvas(mountEl, { tree, controls: true,
       components: [{ name, template }],      // XML components render a live preview;
                                              // native (Swift/Kotlin) ones get an embed block
       data: { title: "...", episodes: [] } });
     // sample data: {{ paths }} and bind="path" resolve against it in the canvas.
     // Bound fields render as purple formula tokens; a bound <list> repeats its row
     // template per sample row (row 0 live, the rest dimmed previews). Elements
     // carrying on:* actions show a flash mark on the hover label and tag chip.

     // Repeaters: ANY container with bind="rows" repeats its first child as the
     // row template (list = vertical, hstack = chips, …). Add where="expr" to
     // filter rows per item; both evaluate in edit, preview, and the simulator.

     // The SDK is headless: it emits, the host decides. The patch surface:
     //   canvas.updateNode(id, { padding: 24, bind: null })  // null deletes a key
     //   canvas.registerComponent(name, template)            // re-renders instances
     //   canvas.setData(data)                                 // re-binds sample data
     //   canvas.setTree(tree)                                 // undo/redo restore:
     //                                                        // keeps view+selection, no change echo
     //   canvas.getNode(id) / canvas.getTree()                // inspector reads
     //   canvas.startEdit(id)                                 // inline text editing
     //   canvas.getBindables(id)                              // scope-aware paths
     //                                                        // for link autocomplete
     //   canvas.add(node, targetId?)                          // into the slot if open,
     //                                                        // after the target if not
     //   canvas.insertNode(parentId, index, node)             // exact slot
     //   canvas.move(ids, parentId, index)                    // structural reorder
     //                                                        // (layers panels)
     //   canvas.hover(id|null)                                // mirror panel hover
     //                                                        // onto the canvas
     //   canvas.describe(id)                                  // style-control manifest
     //                                                        // (render knobs from it)
     //   canvas.setTag(id, 'hstack')                          // direction retag
     //   canvas.wrap(wrapper, ids?) / canvas.unwrap(id?)      // group / ungroup
     //                                                        // (also ⌘G / ⇧⌘G)
     // `select` payloads carry accepts: whether the selection has an open slot,
     // so the palette knows to add INTO vs AFTER. Repeater rules hold: a filled
     // repeater's slot is closed; an empty one accepts its new template.
     // JSE namespaces, exactly like the native engine (dsx.* only):
     //   dsx.variable.filter  ·  dsx.item.title  ·  dsx.this  ·  dsx.global.user
     //   dsx.attribute.<prop> inside component templates
     // Bare identifiers (and legacy bare $names) resolve to nothing.
     // Inline LINKING: type '=dsx.item.title' or '=dsx.variable.title' to bind; {{ }} text
     // interpolates; editinput streams keystrokes + a rect for popovers.
     // All of these are preview-safe: called mid-simulation they repaint the
     // running app instead of tearing it down.
     // Editing a bound field emits `editblocked`; the host may confirm and call
     // canvas.startEdit(id, { force: true }) — committing then writes the literal
     // and removes the binding (edit event carries `unlinked: true`).
     canvas.on('select', fn);            // or '*' for every event
     canvas.select(id) · canvas.getTree() · canvas.load(tree)
     canvas.fit() · canvas.view100() · canvas.destroy()

   Events emitted:
     ready · select · deselect · hover · drill · climb · dragstart · drophint ·
     drop · cancel · editstart · edit · delete · duplicate · change · view

   Interaction model (Figma-grade):
   · selection happens on POINTERDOWN — zero latency — and targets the DEEPEST
     element under the cursor (true z-order hit); hover previews it exactly
   · shift-click multi-selects; dragging any selected element moves the whole
     selection as a group; double-click edits text; Esc / tag-chip / ← climbs
   · ancestry works the Webflow way: every select event carries the full
     `path` (root → element) so the host renders a breadcrumb trail; the tag
     chip, Esc, and ← also climb one level for keyboard users
   · Tab/Shift+Tab walk siblings · Enter edits text or enters a container ·
     ⌘D duplicates · ⌘C/⌘X/⌘V copy, cut, paste · Delete removes · ⌘G wraps, ⇧⌘G unwraps
     (all selection-aware)
   · pointer drag reorders with geometric hit-testing: deepest container wins,
     edge bands insert as a sibling, midpoints pick the exact slot — at any zoom
   · FLIP animation makes siblings slide apart and settle (no teleporting)
   · pan/zoom are GPU-composited and rAF-batched; tree lookups are O(1) via an
     id index — the canvas stays glued to the pointer at any tree size
   · PREVIEW mode (eye button / canvas.setPreview(true)) is a live SIMULATOR:
     sample data forks into running state, every bound list row renders live,
     {{ }} and bind evaluate through a real JSE interpreter (arithmetic,
     comparisons, ternaries, methods), on:tap handlers execute (assignments
     mutate state and the screen re-renders), toggles flip their bindings,
     if/show conditions apply, dsx.event(...) emits `appevent`, dsx.module.*(...)
     emits `native`, and canvas.getState() reads the run state. Editing is off;
     exiting restores the design canvas untouched
   · selection chrome is drawn in screen space, so it stays 1px at every zoom
   ═════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    // The generated kernel bridge is shipped alongside this source file. Loading
    // it here keeps Node consumers and the shared conformance gate on the exact
    // same evaluator as the browser runtime.
    require("./canonical-jse.js");
    const exported = factory(globalThis.DSXCanvasJSE);
    // Keep the historical callable CommonJS default while making the declared
    // default/named SDK exports observable to Node and bundler consumers.
    exported.default = exported;
    exported.StackCanvas = exported;
    Object.defineProperty(exported, "DespiaStackEditor", {
      enumerable: true,
      get: () => globalThis.DespiaStackEditor ?? null,
    });
    module.exports = exported;
  } else root.StackCanvas = factory(root.DSXCanvasJSE);
})(typeof self !== "undefined" ? self : this, function (canonicalJSE) {
  "use strict";

  const uid = () => Math.random().toString(36).slice(2, 9);
  const CONTAINERS = new Set(["stack", "vstack", "hstack", "zstack", "list", "scroll", "grid", "scaffold", "pressable"]);
  const GAP = { stack: 0, vstack: 4, hstack: 6, list: 0, grid: 10, form: 12, scroll: 0, zstack: 0, scaffold: 0 };
  const COLORS = { white: "#fff", black: "#000", accent: "#ff2d55", secondary: "rgba(235,235,245,0.6)", clear: "transparent" };
  // Production StackStyle.color() parity. Adaptive/semantic colors resolve to their
  // DARK appearance (the canvas is a dark phone), matching what iOS draws in the
  // preview. Accepts named, #RRGGBB, #AARRGGBB (ARGB), rgb()/rgba().
  const SEMANTIC_COLORS = {
    label: "#fff", text: "#fff",
    secondary: "rgba(235,235,245,0.6)", secondarylabel: "rgba(235,235,245,0.6)",
    tertiary: "rgba(235,235,245,0.3)", tertiarylabel: "rgba(235,235,245,0.3)",
    background: "#000", systembackground: "#000",
    secondarybackground: "#1c1c1e", tertiarybackground: "#2c2c2e",
    groupedbackground: "#000",
    fill: "rgba(120,120,128,0.36)", fillfaint: "rgba(116,116,128,0.18)",
    separator: "rgba(84,84,88,0.6)",
  };
  function cssColor(s) {
    if (s == null) return null;
    s = String(s);
    if (s === "white") return "#fff";
    if (s === "black") return "#000";
    if (s === "accent") return "#ff2e54";
    if (s === "clear") return "transparent";
    const sem = SEMANTIC_COLORS[s.toLowerCase()];
    if (sem) return sem;
    if (s.startsWith("rgba(") || s.startsWith("rgb(")) return s;   // pass through
    let hex = s.startsWith("#") ? s.slice(1) : s;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return "#" + hex;
    if (/^[0-9a-fA-F]{8}$/.test(hex)) {                            // AARRGGBB → rgba
      const a = parseInt(hex.slice(0, 2), 16) / 255, r = parseInt(hex.slice(2, 4), 16),
            g = parseInt(hex.slice(4, 6), 16), b = parseInt(hex.slice(6, 8), 16);
      return `rgba(${r},${g},${b},${+a.toFixed(3)})`;
    }
    return s;   // unknown: leave as-is (lets through CSS keywords during editing)
  }
  const WEIGHTS = { regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800 };
  const FRIENDLY = {
    vstack: "Column", hstack: "Row", zstack: "Overlay", list: "List", scroll: "Scroll",
    pressable: "Tap area", text: "Text", button: "Button", glassButton: "Glass button",
    image: "Image", toggle: "Toggle", textfield: "Input", slider: "Slider",
    segmented: "Segmented", progress: "Progress", spinner: "Spinner",
    divider: "Divider", spacer: "Spacer",
  };
  const friendly = (tag) => FRIENDLY[tag] || tag;
  const caretToEnd = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = document.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  };
  const isComponent = (tag) => /^[A-Z]/.test(tag || "");   // Capitalized tag = a DSX component instance
  // row-ness at BUILD time: hstack, or a generic container whose (resolved) inline
  // CSS picks the row axis — the modern `style="flex-direction: row"` form.
  const rowy = (tag, styleText) => tag === "hstack" || /flex-direction\s*:\s*row/.test(String(styleText || ""));

  /* ── sample-data binding (display only — paths and literals, not full JSE) ──
     The editor renders {{ path.to.value }} and bind="path" against the sample
     `data` you pass in, with the row scope of a bound <list> as `item`. Anything
     it can't resolve shows the raw expression, marked purple like resolved ones. */
  const hasMustache = (s) => typeof s === "string" && s.includes("{{");
  const asRows = (v) => (Array.isArray(v) ? v : []);

  // The native dsx.* root. dsx.variable/item/global/route/cookie/screen/app/attribute resolve by
  // member-walk; dsx.module/action/event are __path stubs routed through ctx.call. (JSE.swift:884-984)
  function dsxData(scope, st) {
    st = st || {};
    st.global ??= {}; st.route ??= {}; st.cookie ??= {};
    st.global.screen ??= {}; st.global.app ??= {};
    st.route.params ??= {}; st.route.query ??= {};
    return {
      variable: st, formula: st,
      global: st.global, screen: st.global.screen, app: st.global.app,
      route: st.route, params: st.route.params, query: st.route.query, path: st.route.path,
      cookie: st.cookie,
      item: scope.item, this: scope.self ?? scope.item, attribute: scope.attrs,
      module: { __path: ["dsx", "module"] }, action: { __path: ["dsx", "action"] }, event: { __path: ["dsx", "event"] },
    };
  }

  /* ── JSE runtime: the bounded expression language, interpreted like the native
     engine. No eval(): a tiny tokenizer + recursive-descent interpreter covering
     literals, paths, arithmetic, comparison, &&/||/!, ternary, member/index
     access, whitelisted methods, object/array literals, and statement lists with
     assignment (=, +=, -=). dsx.event(...) and dsx.module.*(...) surface as events. ── */
  const truthy = (v) => v != null && v !== false && v !== 0 && v !== "";
  const num = (v) => { const n = Number(v); return Number.isNaN(n) ? 0 : n; };
  // JSE string coercion (the engine's all-doubles model): null/undefined → "",
  // booleans → "1"/"0" (a bool IS a double), everything else JS-stringified
  // (integral doubles already print as ints in JS). Conformance: corpus
  // `bool-stringifies-one-zero`.
  const jseStr = (v) => (v == null ? "" : v === true ? "1" : v === false ? "0" : String(v));
  // JSE equality — the ONE coercion table `==` and `===` share (the corpus
  // note: "one coercion table for == and ===", "plain dicts/arrays compare
  // structurally (deep, key-order-insensitive)", null == '' is true, and
  // string-coercible value objects keep coerced-string equality).
  function jseEquals(a, b) {
    if (a === b) return true;
    const an = a == null, bn = b == null;
    if (an && bn) return true;                       // null/undefined unify
    if (an || bn) return (an ? b : a) === "";        // null equals ONLY the empty string
    const ao = typeof a === "object", bo = typeof b === "object";
    if (ao && bo) {
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => jseEquals(v, b[i]));
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every((k) => k in b && jseEquals(a[k], b[k]));
    }
    if (ao || bo) return String(ao ? a : b) === jseStr(ao ? b : a);   // value object vs primitive
    if (typeof a === "string" && typeof b === "string") return false; // identical strings hit === above
    const na = typeof a === "boolean" ? (a ? 1 : 0) : Number(a);
    const nb = typeof b === "boolean" ? (b ? 1 : 0) : Number(b);
    return na === nb;   // NaN equals nothing — a non-numeric string never equals a number
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
  // The engine's free-function HOFs (also reachable as array methods above).
  // Callbacks arrive as REAL functions — nativeArgs wraps interpreter arrows
  // at every native call boundary.
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
  // JSE globals: Math, JSON, BOUNDED Object/Array statics (the expression
  // language exposes data helpers, never defineProperty/setPrototypeOf — the
  // sandbox stays a data language), and the free functions the spec lists.
  // Object.groupBy is polyfilled (ES2024 — not everywhere yet), so the canvas
  // behaves identically on every browser/node the dashboard supports.
  const JSE_OBJECT = {
    keys: Object.keys, values: Object.values, entries: Object.entries,
    fromEntries: Object.fromEntries, assign: Object.assign, groupBy: jseGroupBy,
  };
  const JSE_ARRAY = {
    isArray: Array.isArray, of: Array.of,
    from: (src, fn) => (fn ? Array.from(src ?? [], fn) : Array.from(src ?? [])),
  };
  // Reject catastrophic-backtracking patterns — star height ≥ 2: a group whose body
  // holds an unbounded quantifier, itself unbounded-quantified ((a+)+, (.*)*). The
  // byte-for-byte twin of the kernel's reDoSProne (jse/regex.ts · Jse.kt · Stack.swift):
  // rejected patterns return false from regex(), never a frozen canvas.
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
  const OBJECT_GLOBALS = new Set(["Math", "JSON", "Object", "Array"]);
  const STRING_FNS = new Set(["includes", "startsWith", "endsWith", "toUpperCase", "toLowerCase", "trim", "slice", "split"]);
  // a row-scope reference (modern dsx.item/dsx.this, or a legacy $item/$this
  // still sitting in an unmigrated deck) — the ONE detector materializeItem and
  // usesItemData share, so unlink and repeater-scope detection agree.
  const ROW_REF = /(\bdsx\.(item|this)\b|\$item\b|\$this\b)/;
  const RET = Symbol("jse-return");

  // ctx: { rootValue(name), rootSlot(name), rootContainer(name), call(pathArr, args) }
  function jseInterp(toks, ctx) {
    let p = 0;
    const locals = Object.create(null);   // const/let declarations + catch bindings
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
        // bare single-param arrow: x => …  (check before consuming as a value)
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
        if (tk.v === "await") return unary();   // await is transparent in the canvas runtime
        return lookup(tk.v);
      }
      if (isOp("(")) {
        // arrow lookahead: ( params ) => { … } is a function VALUE — the
        // callback shape $action and ctx.event use. Body must be braced.
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
          // unbraced expression body: capture until the arg/group boundary
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

    // At a NATIVE call boundary (a GLOBALS free function, Object.groupBy,
    // Array.from, a string method…), interpreter arrows arrive as {__fn}
    // records natives can't invoke — wrap each as a real function that runs
    // through ctx.callFn, with $this = the first argument (the element), the
    // same contract the array HOF path uses. This is what makes the free-fn
    // HOFs (groupBy/keyBy/sortBy) and ES-shaped statics behave exactly like
    // the engine's.
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
            // a method on a plain object (Math.min, JSON.stringify, Object.groupBy, Array.from, …)
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
      // typeof — engine semantics: null AND undefined both report "undefined"
      // (JSE does not split them — the one deliberate JS divergence), arrays
      // report "object" (they are plain values, not exotic).
      if (isKw("typeof")) { p++; const v = unary(); return v == null ? "undefined" : Array.isArray(v) ? "object" : typeof v; }
      return postfix();
    }
    function mul() {
      let l = unary();
      for (;;) {
        // JSE number model: division/modulo BY ZERO yields 0, never Infinity/NaN
        // (corpus `div-zero-is-zero`, `mod-zero-is-zero`, `div-zero-zero-is-falsy`).
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

    /* ── statements: engine JSE supports newline OR semicolon separation,
       const/let, if/else, return, try/catch, await, and member assignment
       into the writable namespaces (dsx.variable.x, dsx.global.x, dsx.item.x …) ── */

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

    // token skippers for branches that don't execute
    function skipBlock() {                       // past a balanced { … }, "{" already consumed
      let d = 1;
      while (toks[p] && d > 0) {
        const tk = toks[p];
        if (tk.t === "op" && (tk.v === "{" || tk.v === "(" || tk.v === "[")) d += tk.v === "{" ? 1 : 0;
        if (tk.t === "op" && tk.v === "}") d--;
        p++;
      }
    }
    function skipStmt() {                        // one unbraced statement: to nl/; at depth 0
      let d = 0;
      while (toks[p]) {
        const tk = toks[p];
        if (tk.t === "op" && "([{".includes(tk.v)) d++;
        if (tk.t === "op" && ")]}".includes(tk.v)) {
          if (d === 0 && tk.v === "}") return;   // end of enclosing block
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
      p++;                                       // past "if"
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
          p = blockStart; skipBlock();           // recover to the end of the try block
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

    function blockStatements() {                 // inside { … }: run until the closing brace
      for (;;) {
        skipNl();
        if (!toks[p]) return;
        if (toks[p].t === "op" && toks[p].v === "}") { p++; return; }
        if (toks[p].t === "op" && toks[p].v === ";") { p++; continue; }
        const before = p;
        stmt();
        if (p === before) p++;                   // never stall on bad input
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

  const runToks = (toks, ctx) => {
    try { return jseInterp(toks, ctx).statements(); }
    catch (e) { return e && e[RET] ? e.value : undefined; }
  };
  // evaluate an arrow's body: a single expression (x => x*2) or a statement
  // block (x => { return … }). Params are already bound via ctx.rootValue.
  const runArrow = (fn, ctx) => {
    try {
      const it = jseInterp(fn.toks, ctx);
      return fn.expr ? it.expr() : it.statements();
    } catch (e) { return e && e[RET] ? e.value : undefined; }
  };
  const jseEval = (srcStr, ctx) => {
    try {
      // Preview bindings and conditions use the canonical kernel evaluator. The
      // legacy interpreter remains only for mutable handler statements below.
      if (ctx?.jseScope && canonicalJSE?.evaluate) return canonicalJSE.evaluate(srcStr, ctx.jseScope);
      return jseInterp(jseTokens(srcStr), ctx).expr();
    } catch (_) { return undefined; }
  };
  const jseRun = (srcStr, ctx) => {
    try { return jseInterp(jseTokens(srcStr), ctx).statements(); }
    catch (e) { return e && e[RET] ? e.value : undefined; }
  };

  /* icons: Hugeicons (free set), 24px stroke, rendered via currentColor */
  const ICONS = {
    search: `<path d="M17.2 17.2L21 21M19.5 11.25C19.5 6.69365 15.8063 3 11.25 3C6.69365 3 3 6.69365 3 11.25C3 15.8063 6.69365 19.5 11.25 19.5C15.8063 19.5 19.5 15.8063 19.5 11.25Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    hash: `<path d="M10 3.5L7.5 20.5M16.5 3.5L14 20.5M4 8.5H20.5M3.5 15.5H20" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    check: `<path d="M5 13.5L9.5 18L19 6.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>`,
    close: `<path d="M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/>`,
    vstack: `<path d="M5 17L2 17M19 17L22 17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M8.00232 7C8.00232 6.15611 7.91895 5.18211 8.75232 4.70096C9.10039 4.5 9.5677 4.5 10.5023 4.5L13.5023 4.5C14.4369 4.5 14.9042 4.5 15.2523 4.70096C16.0857 5.18211 16.0023 6.15611 16.0023 7C16.0023 7.84389 16.0857 8.81789 15.2523 9.29904C14.9042 9.5 14.4369 9.5 13.5023 9.5H10.5023C9.5677 9.5 9.10039 9.5 8.75232 9.29904C7.91895 8.81789 8.00232 7.84389 8.00232 7Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M5.00232 17C5.00232 16.1561 4.91895 15.1821 5.75232 14.701C6.10039 14.5 6.5677 14.5 7.50232 14.5L16.5023 14.5C17.4369 14.5 17.9042 14.5 18.2523 14.701C19.0857 15.1821 19.0023 16.1561 19.0023 17C19.0023 17.8439 19.0857 18.8179 18.2523 19.299C17.9042 19.5 17.4369 19.5 16.5023 19.5H7.50232C6.5677 19.5 6.10039 19.5 5.75232 19.299C4.91895 18.8179 5.00232 17.8439 5.00232 17Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M8 7L2 7M16 7L22 7" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    hstack: `<path d="M7 5L7 2M7 19L7 22" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M17 8.00232C17.8439 8.00232 18.8179 7.91895 19.299 8.75232C19.5 9.10039 19.5 9.5677 19.5 10.5023V13.5023C19.5 14.4369 19.5 14.9042 19.299 15.2523C18.8179 16.0857 17.8439 16.0023 17 16.0023C16.1561 16.0023 15.1821 16.0857 14.701 15.2523C14.5 14.9042 14.5 14.4369 14.5 13.5023L14.5 10.5023C14.5 9.5677 14.5 9.10039 14.701 8.75232C15.1821 7.91895 16.1561 8.00232 17 8.00232Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M7 5.00232C7.84389 5.00232 8.81789 4.91895 9.29904 5.75232C9.5 6.10039 9.5 6.5677 9.5 7.50232L9.5 16.5023C9.5 17.4369 9.5 17.9042 9.29904 18.2523C8.81789 19.0857 7.84389 19.0023 7 19.0023C6.15611 19.0023 5.18211 19.0857 4.70096 18.2523C4.5 17.9042 4.5 17.4369 4.5 16.5023L4.5 7.50232C4.5 6.5677 4.5 6.10039 4.70096 5.75232C5.18211 4.91895 6.15611 5.00232 7 5.00232Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M17 8V2M17 16V22" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    zstack: `<path d="M8.64298 3.14559L6.93816 3.93362C4.31272 5.14719 3 5.75397 3 6.75C3 7.74603 4.31272 8.35281 6.93817 9.56638L8.64298 10.3544C10.2952 11.1181 11.1214 11.5 12 11.5C12.8786 11.5 13.7048 11.1181 15.357 10.3544L17.0618 9.56638C19.6873 8.35281 21 7.74603 21 6.75C21 5.75397 19.6873 5.14719 17.0618 3.93362L15.357 3.14559C13.7048 2.38186 12.8786 2 12 2C11.1214 2 10.2952 2.38186 8.64298 3.14559Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M20.788 11.0972C20.9293 11.2959 21 11.5031 21 11.7309C21 12.7127 19.6873 13.3109 17.0618 14.5072L15.357 15.284C13.7048 16.0368 12.8786 16.4133 12 16.4133C11.1214 16.4133 10.2952 16.0368 8.64298 15.284L6.93817 14.5072C4.31272 13.3109 3 12.7127 3 11.7309C3 11.5031 3.07067 11.2959 3.212 11.0972" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M20.3767 16.2661C20.7922 16.5971 21 16.927 21 17.3176C21 18.2995 19.6873 18.8976 17.0618 20.0939L15.357 20.8707C13.7048 21.6236 12.8786 22 12 22C11.1214 22 10.2952 21.6236 8.64298 20.8707L6.93817 20.0939C4.31272 18.8976 3 18.2995 3 17.3176C3 16.927 3.20778 16.5971 3.62334 16.2661" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    list: `<path d="M8 5.5L20 5.5" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/><path d="M8 12.5L20 12.5" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/><path d="M8 19.5L20 19.5" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/><path d="M4.375 5.5H4.25M4.5 5.5C4.5 5.63807 4.38807 5.75 4.25 5.75C4.11193 5.75 4 5.63807 4 5.5C4 5.36193 4.11193 5.25 4.25 5.25C4.38807 5.25 4.5 5.36193 4.5 5.5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M4.375 12.5H4.25M4.5 12.5C4.5 12.6381 4.38807 12.75 4.25 12.75C4.11193 12.75 4 12.6381 4 12.5C4 12.3619 4.11193 12.25 4.25 12.25C4.38807 12.25 4.5 12.3619 4.5 12.5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M4.375 19.5H4.25M4.5 19.5C4.5 19.6381 4.38807 19.75 4.25 19.75C4.11193 19.75 4 19.6381 4 19.5C4 19.3619 4.11193 19.25 4.25 19.25C4.38807 19.25 4.5 19.3619 4.5 19.5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    scroll: `<path d="M14 12C14 13.1046 13.1046 14 12 14C10.8954 14 10 13.1046 10 12C10 10.8954 10.8954 10 12 10C13.1046 10 14 10.8954 14 12Z" stroke="currentColor" stroke-width="1.5"/><path d="M11.9328 2.00023C13.3137 1.95947 16.5608 7.34458 15.9163 7.8518C15.1855 8.42696 13.0137 7.05181 12.3221 6.74208C11.9062 6.55582 11.7259 6.56093 11.3104 6.77271C9.42898 7.73186 8.49159 8.20766 8.08638 7.91196C7.44046 7.44063 10.5851 2.04001 11.9328 2.00023Z" stroke="currentColor" stroke-width="1.5"/><path d="M12.0672 21.9998C10.6863 22.0403 7.43916 16.6805 8.08367 16.1756C8.81453 15.6032 10.9863 16.9719 11.6779 17.2801C12.0938 17.4655 12.2741 17.4604 12.6896 17.2497C13.2694 16.9554 15.1991 15.6005 15.9136 16.1157C16.5595 16.5849 13.4149 21.9602 12.0672 21.9998Z" stroke="currentColor" stroke-width="1.5"/>`,
    text: `<path d="M15 21.001H9" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M12 3.00001V21.0008M12 3.00001C13.3874 3.00001 15.1695 3.03055 16.5884 3.17649C17.1885 3.2382 17.4886 3.26906 17.7541 3.37791C18.3066 3.60429 18.7518 4.10063 18.9194 4.67681C19 4.95382 19 5.26992 19 5.90215M12 3.00001C10.6126 3.00001 8.83047 3.03055 7.41161 3.17649C6.8115 3.2382 6.51144 3.26906 6.24586 3.37791C5.69344 3.60429 5.24816 4.10063 5.08057 4.67681C5 4.95382 5 5.26992 5 5.90215" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/>`,
    button: `<path d="M14.5352 11.0865L18.5575 12.6605C20.8775 13.5683 22.0375 14.0222 21.9991 14.7422C21.9606 15.4622 20.75 15.7924 18.3288 16.4527C17.6079 16.6493 17.2475 16.7476 16.9976 16.9976C16.7476 17.2475 16.6493 17.6079 16.4527 18.3288C15.7924 20.75 15.4622 21.9606 14.7422 21.9991C14.0222 22.0375 13.5683 20.8775 12.6605 18.5575L11.0865 14.5352C10.136 12.1062 9.6608 10.8918 10.2763 10.2763C10.8918 9.6608 12.1062 10.136 14.5352 11.0865Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"/><path d="M10.8576 7.08329C11.0714 7.43808 11.5323 7.55239 11.8871 7.33861C12.2419 7.12483 12.3562 6.66392 12.1424 6.30913L10.8576 7.08329ZM6.30914 12.1424C6.66392 12.3562 7.12483 12.2419 7.33861 11.8871C7.55239 11.5323 7.43808 11.0714 7.08329 10.8576L6.30914 12.1424ZM5.75 8.5C5.75 6.98122 6.98123 5.75 8.5 5.75V4.25C6.15281 4.25 4.25 6.15279 4.25 8.5H5.75ZM8.5 5.75C9.49944 5.75 10.3752 6.28272 10.8576 7.08329L12.1424 6.30913C11.3999 5.07687 10.0469 4.25 8.5 4.25V5.75ZM7.08329 10.8576C6.28272 10.3752 5.75 9.49945 5.75 8.5H4.25C4.25 10.0469 5.07688 11.3999 6.30914 12.1424L7.08329 10.8576Z" fill="currentColor"/><path d="M14.2515 8.13498C14.2778 8.54836 14.6342 8.86216 15.0476 8.83587C15.461 8.80958 15.7748 8.45316 15.7485 8.03979L14.2515 8.13498ZM8.04118 15.7485C8.45457 15.7747 8.81093 15.4608 8.83714 15.0475C8.86335 14.6341 8.54948 14.2777 8.1361 14.2515L8.04118 15.7485ZM2.75 8.50661C2.75 5.32733 5.32736 2.75 8.50664 2.75V1.25C4.49895 1.25 1.25 4.49889 1.25 8.50661H2.75ZM8.50664 2.75C11.561 2.75 14.0604 5.12926 14.2515 8.13498L15.7485 8.03979C15.5074 4.24925 12.3576 1.25 8.50664 1.25V2.75ZM8.1361 14.2515C5.12986 14.0609 2.75 11.5614 2.75 8.50661H1.25C1.25 12.358 4.25002 15.5081 8.04118 15.7485L8.1361 14.2515Z" fill="currentColor"/>`,
    image: `<path d="M3 16L7.46967 11.5303C7.80923 11.1908 8.26978 11 8.75 11C9.23022 11 9.69077 11.1908 10.0303 11.5303L14 15.5M15.5 17L14 15.5M21 16L18.5303 13.5303C18.1908 13.1908 17.7302 13 17.25 13C16.7698 13 16.3092 13.1908 15.9697 13.5303L14 15.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M15.5 8C15.7761 8 16 7.77614 16 7.5C16 7.22386 15.7761 7 15.5 7M15.5 8C15.2239 8 15 7.77614 15 7.5C15 7.22386 15.2239 7 15.5 7M15.5 8V7" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M3.69797 19.7472C2.5 18.3446 2.5 16.2297 2.5 12C2.5 7.77027 2.5 5.6554 3.69797 4.25276C3.86808 4.05358 4.05358 3.86808 4.25276 3.69797C5.6554 2.5 7.77027 2.5 12 2.5C16.2297 2.5 18.3446 2.5 19.7472 3.69797C19.9464 3.86808 20.1319 4.05358 20.302 4.25276C21.5 5.6554 21.5 7.77027 21.5 12C21.5 16.2297 21.5 18.3446 20.302 19.7472C20.1319 19.9464 19.9464 20.1319 19.7472 20.302C18.3446 21.5 16.2297 21.5 12 21.5C7.77027 21.5 5.6554 21.5 4.25276 20.302C4.05358 20.1319 3.86808 19.9464 3.69797 19.7472Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    toggle: `<path d="M19 12C19 13.6569 17.6569 15 16 15C14.3431 15 13 13.6569 13 12C13 10.3431 14.3431 9 16 9C17.6569 9 19 10.3431 19 12Z" stroke="currentColor" stroke-width="1.5"/><path d="M16 6H8C4.68629 6 2 8.68629 2 12C2 15.3137 4.68629 18 8 18H16C19.3137 18 22 15.3137 22 12C22 8.68629 19.3137 6 16 6Z" stroke="currentColor" stroke-width="1.5"/>`,
    textfield: `<path d="M18 8H6C5.53501 8 5.30252 8 5.11177 8.05111C4.59413 8.18981 4.18981 8.59413 4.05111 9.11177C4 9.30252 4 9.53501 4 10C4 10.465 4 10.6975 4.05111 10.8882C4.18981 11.4059 4.59413 11.8102 5.11177 11.9489C5.30252 12 5.53501 12 6 12H18C18.465 12 18.6975 12 18.8882 11.9489C19.4059 11.8102 19.8102 11.4059 19.9489 10.8882C20 10.6975 20 10.465 20 10C20 9.53501 20 9.30252 19.9489 9.11177C19.8102 8.59413 19.4059 8.18981 18.8882 8.05111C18.6975 8 18.465 8 18 8Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M4 4H14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M4 16H10" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M4 20H20" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    divider: `<path d="M20 12L4 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    spacer: `<path d="M16.4999 3.26621C17.3443 3.25421 20.1408 2.67328 20.7337 3.26621C21.3266 3.85913 20.7457 6.65559 20.7337 7.5M20.5059 3.49097L13.5021 10.4961" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M3.26636 16.5001C3.25436 17.3445 2.67343 20.141 3.26636 20.7339C3.85928 21.3268 6.65574 20.7459 7.50015 20.7339M10.502 13.4976L3.49824 20.5027" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    component: `<path d="M12.828 6.00096C12.9388 5.68791 12.999 5.35099 12.999 5C12.999 3.34315 11.6559 2 9.99904 2C8.34219 2 6.99904 3.34315 6.99904 5C6.99904 5.35099 7.05932 5.68791 7.17008 6.00096C4.88532 6.0093 3.66601 6.09039 2.87772 6.87868C2.08951 7.66689 2.00836 8.88603 2 11.1704C2.31251 11.06 2.64876 11 2.99904 11C4.6559 11 5.99904 12.3431 5.99904 14C5.99904 15.6569 4.6559 17 2.99904 17C2.64876 17 2.31251 16.94 2 16.8296C2.00836 19.114 2.08951 20.3331 2.87772 21.1213C3.66593 21.9095 4.88508 21.9907 7.16941 21.999C7.05908 21.6865 6.99904 21.3503 6.99904 21C6.99904 19.3431 8.34219 18 9.99904 18C11.6559 18 12.999 19.3431 12.999 21C12.999 21.3503 12.939 21.6865 12.8287 21.999C15.113 21.9907 16.3322 21.9095 17.1204 21.1213C17.9086 20.333 17.9897 19.1137 17.9981 16.829C18.3111 16.9397 18.648 17 18.999 17C20.6559 17 21.999 15.6569 21.999 14C21.999 12.3431 20.6559 11 18.999 11C18.648 11 18.3111 11.0603 17.9981 11.171C17.9897 8.88627 17.9086 7.66697 17.1204 6.87868C16.3321 6.09039 15.1128 6.0093 12.828 6.00096Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"/>`,
    fx: `<path d="M5 19C5.26413 19.9564 5.79671 21 7.18729 21C9.59365 21 10.1952 19 12 12C13.8048 5 14.4064 3 16.8127 3C18.2033 3 18.7359 4.04358 19 5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M9 10H17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    flash: `<path d="M5.22576 11.3294L12.224 2.34651C12.7713 1.64397 13.7972 2.08124 13.7972 3.01707V9.96994C13.7972 10.5305 14.1995 10.985 14.6958 10.985H18.0996C18.8729 10.985 19.2851 12.0149 18.7742 12.6706L11.776 21.6535C11.2287 22.356 10.2028 21.9188 10.2028 20.9829V14.0301C10.2028 13.4695 9.80048 13.015 9.3042 13.015H5.90035C5.12711 13.015 4.71494 11.9851 5.22576 11.3294Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    eye: `<path d="M21.544 11.045C21.848 11.4713 22 11.6845 22 12C22 12.3155 21.848 12.5287 21.544 12.955C20.1779 14.8706 16.6892 19 12 19C7.31078 19 3.8221 14.8706 2.45604 12.955C2.15201 12.5287 2 12.3155 2 12C2 11.6845 2.15201 11.4713 2.45604 11.045C3.8221 9.12944 7.31078 5 12 5C16.6892 5 20.1779 9.12944 21.544 11.045Z" stroke="currentColor" stroke-width="1.5"/><path d="M15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15C13.6569 15 15 13.6569 15 12Z" stroke="currentColor" stroke-width="1.5"/>`,
    cube: `<path d="M2.79289 21.2071C3.08579 21.5 3.55719 21.5 4.5 21.5H14.5C15.4428 21.5 15.9142 21.5 16.2071 21.2071M2.79289 21.2071C2.5 20.9142 2.5 20.4428 2.5 19.5V9.5C2.5 8.55719 2.5 8.08579 2.79289 7.79289M2.79289 21.2071L8.79289 15.2071M16.2071 21.2071C16.5 20.9142 16.5 20.4428 16.5 19.5V9.5C16.5 8.55719 16.5 8.08579 16.2071 7.79289M16.2071 21.2071L21.2071 16.2071C21.5 15.9142 21.5 15.4428 21.5 14.5V4.5C21.5 3.55719 21.5 3.08579 21.2071 2.79289M16.2071 7.79289C15.9142 7.5 15.4428 7.5 14.5 7.5H4.5C3.55719 7.5 3.08579 7.5 2.79289 7.79289M16.2071 7.79289L21.2071 2.79289M2.79289 7.79289L7.79289 2.79289C8.08579 2.5 8.55719 2.5 9.5 2.5H19.5C20.4428 2.5 20.9142 2.5 21.2071 2.79289M8.79289 15.2071C9.08579 15.5 9.55719 15.5 10.5 15.5H14M8.79289 15.2071C8.5 14.9142 8.5 14.4428 8.5 13.5V10.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    code: `<path d="M17 8L18.8398 9.85008C19.6133 10.6279 20 11.0168 20 11.5C20 11.9832 19.6133 12.3721 18.8398 13.1499L17 15" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M7 8L5.16019 9.85008C4.38673 10.6279 4 11.0168 4 11.5C4 11.9832 4.38673 12.3721 5.16019 13.1499L7 15" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M14.5 4L9.5 20" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
    alert: `<path d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M12 9V13" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M12.125 16.75H12M12.25 16.75C12.25 16.8881 12.1381 17 12 17C11.8619 17 11.75 16.8881 11.75 16.75C11.75 16.6119 11.8619 16.5 12 16.5C12.1381 16.5 12.25 16.6119 12.25 16.75Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
  };
  const icon = (name, size = 12) => {
    const body = ICONS[name] || ICONS.code;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  };

  /* ── tree helpers (pure data) ───────────────────────────────────────────── */
  function findNode(t, id) {
    if (!t) return null;
    if (t.id === id) return t;
    for (const c of t.children || []) { const f = findNode(c, id); if (f) return f; }
    return null;
  }
  function findParent(t, id, parent = null) {
    if (!t) return null;
    if (t.id === id) return parent;
    for (const c of t.children || []) { const f = findParent(c, id, t); if (f) return f; }
    return null;
  }
  function pathTo(t, id, acc = []) {
    if (!t) return null;
    if (t.id === id) return [...acc, t];
    for (const c of t.children || []) { const r = pathTo(c, id, [...acc, t]); if (r) return r; }
    return null;
  }
  function ensureIds(n) { if (!n.id) n.id = uid(); (n.children || []).forEach(ensureIds); return n; }
  function reId(n) { return { ...n, id: uid(), children: (n.children || []).map(reId) }; }
  function countNodes(n) { return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0); }

  /* ── scoped styles, injected once ───────────────────────────────────────── */
  const CSS = `
  .sc-viewport {
    position: relative; overflow: hidden; outline: none;
    background-color: #1a1a1a;
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    --sc-accent: #146ef5; --sc-comp: #63d489; --sc-data: #8a63d2; --sc-grp: #8a63d2;
    --sc-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace;
  }
  .sc-viewport, .sc-viewport * { box-sizing: border-box; }
  .sc-viewport.sc-space { cursor: grab; }
  .sc-viewport.sc-panning { cursor: grabbing; }
  /* the grid is its own composited layer: pan moves it with a transform (no repaint) */
  .sc-grid {
    position: absolute; inset: -32px; pointer-events: none;
    background-image: radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px);
    will-change: transform;
  }
  .sc-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
  .sc-viewport.sc-space .sc-world, .sc-viewport.sc-panning .sc-world { pointer-events: none; }

  /* phone frame */
  .sc-board {
    width: 390px; position: relative; display: flex; flex-direction: column;
    background: none; border-radius: 0; padding: 0; box-shadow: none;
  }
  .sc-board > .sc-node.sc-root { flex: 0 0 auto; }
  .sc-phone {
    width: 390px; height: 844px; border-radius: 55px; position: relative;
    background: linear-gradient(160deg, #4a4a4e 0%, #232325 30%, #1a1a1c 70%, #38383c 100%);
    padding: 13px;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.07), 0 2px 6px rgba(0,0,0,0.4), 0 28px 80px rgba(0,0,0,0.6);
    display: flex; flex-direction: column;
  }
  .sc-phone::before { content: ''; position: absolute; inset: 3px; border-radius: 52px; border: 1px solid rgba(0,0,0,0.85); pointer-events: none; }
  .sc-island {
    position: absolute; top: 24px; left: 50%; transform: translateX(-50%);
    width: 122px; height: 35px; border-radius: 18px; background: #000; z-index: 3;
    pointer-events: none; box-shadow: inset 0 0 2px rgba(255,255,255,0.08);
  }
  .sc-island::after {
    content: ''; position: absolute; right: 17px; top: 50%; transform: translateY(-50%);
    width: 9px; height: 9px; border-radius: 5px;
    background: radial-gradient(circle at 35% 35%, #1e2a4a, #05070d 65%);
  }
  .sc-screen {
    flex: 1; border-radius: 43px; overflow: hidden; position: relative;
    background: linear-gradient(175deg, #101016 0%, #0a0a0e 40%, #08080b 100%);
    display: flex; flex-direction: column; user-select: none;
  }
  .sc-statusbar { height: 52px; flex: 0 0 52px; display: flex; align-items: center; padding: 14px 30px 0; pointer-events: none; z-index: 2; }
  .sc-sb-time { font-size: 15px; font-weight: 650; color: #fff; letter-spacing: 0.2px; }
  .sc-sb-icons { margin-left: auto; display: flex; align-items: center; gap: 6px; color: #fff; }
  .sc-sb-icons svg { display: block; }
  .sc-content {
    flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 6px 16px 26px;
    overflow-y: auto; overscroll-behavior: none; scrollbar-width: none;
  }
  .sc-content::-webkit-scrollbar { display: none; }
  /* an overflowing layout must keep its full height inside the scroller */
  .sc-content > .sc-root { flex: 0 0 auto; min-height: 100%; }
  .sc-home {
    position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
    width: 134px; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.4);
    pointer-events: none; z-index: 2;
  }

  /* nodes (DSX flex semantics) */
  .sc-node { cursor: default; position: relative; }
  .sc-node.stack, .sc-node.vstack, .sc-node.list, .sc-node.scroll { display: flex; flex-direction: column; align-items: flex-start; }
  .sc-node.scroll { overflow-y: auto; min-height: 0; }
  .sc-node.hstack { display: flex; flex-direction: row; align-items: center; }
  /* grow: cross-axis fill = align-self stretch, main-axis fill = flex-grow */
  .sc-node.vstack > .sc-grow-w, .sc-node.list > .sc-grow-w, .sc-node.scroll > .sc-grow-w,
  .sc-node.zstack > .sc-grow-w { align-self: stretch; width: auto; }
  .sc-node.hstack > .sc-grow-w { flex: 1 1 0%; min-width: 0; }
  .sc-node.vstack > .sc-grow-h, .sc-node.list > .sc-grow-h, .sc-node.scroll > .sc-grow-h { flex: 1 1 0%; min-height: 0; }
  .sc-node.hstack > .sc-grow-h { align-self: stretch; height: auto; }
  .sc-grow-both { flex: 1 1 0%; align-self: stretch; min-width: 0; min-height: 0; }
  .sc-root > .sc-grow-w { align-self: stretch; }
  .sc-node.zstack { display: grid; place-items: center; position: relative; }
  .sc-node.zstack > * { grid-area: 1 / 1; }
  .sc-node.scaffold { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .sc-node.scaffold > [data-pin] { flex: 0 0 auto; }
  .sc-node.scaffold > :not([data-pin]) { flex: 1 1 0%; min-height: 0; }
  .sc-node.sc-root { flex: 1; }
  .sc-node.sc-dragging { opacity: 0.3; filter: saturate(0.4); }
  .sc-node.sc-droptarget { outline: 1px solid rgba(20,110,245,0.5); outline-offset: -1px; background: rgba(20,110,245,0.08); }
  .sc-node.sc-droptarget > .sc-empty { visibility: hidden; }   /* keep its space: stable geometry under the pointer */
  .sc-empty {
    flex: 1; min-height: 46px; display: grid; place-items: center;
    border: 1px dashed rgba(255,255,255,0.16); border-radius: 10px;
    font-size: 11px; font-weight: 500; color: rgba(255,255,255,0.32); padding: 6px; pointer-events: none;
  }

  /* leaves */
  .sc-leaf-text { font-size: 16px; line-height: 1.32; color: #fff; letter-spacing: -0.1px; }
  .sc-leaf-button {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    color: #fff; font-weight: 600; font-size: 14px; letter-spacing: -0.1px;
  }
  .sc-leaf-image {
    border-radius: 11px; display: grid; place-items: center; overflow: hidden;
    color: rgba(255,255,255,0.85); font-size: 18px;
  }
  /* glyph form: a square tile. bitmap form: the image fills the frame. */
  .sc-leaf-image.sc-icon {
    width: 52px; height: 52px;
    background: radial-gradient(circle at 30% 25%, rgba(255,255,255,0.12), transparent 55%), rgba(255,255,255,0.07);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
  }
  .sc-leaf-image.sc-img { background: rgba(255,255,255,0.05); }
  .sc-leaf-image.sc-img img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: inherit; }
  .sc-leaf-image.sc-img.sc-auto-h img { height: auto; }
  .sc-leaf-image.sc-grow-w, .sc-leaf-image.sc-grow-both { width: auto; }
  .sc-leaf-glassbtn {
    width: 44px; height: 44px; border-radius: 22px; display: grid; place-items: center;
    background: rgba(255,255,255,0.14); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12); color: #fff; flex: 0 0 auto;
  }
  .sc-leaf-progress {
    height: 6px; border-radius: 3px; background: rgba(255,46,84,0.2); overflow: hidden; align-self: stretch;
  }
  .sc-progress-fill { height: 100%; border-radius: 3px; background: #ff2d55; }
  .sc-leaf-spinner {
    width: 22px; height: 22px; border-radius: 11px; flex: 0 0 auto;
    border: 2.5px solid rgba(255,255,255,0.2); border-top-color: #fff;
    animation: sc-spin 0.9s linear infinite;
  }
  @keyframes sc-spin { to { transform: rotate(360deg); } }
  .sc-leaf-slider { position: relative; height: 24px; align-self: stretch; display: flex; align-items: center; }
  .sc-slider-track { flex: 1; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.22); overflow: hidden; }
  .sc-slider-fill { height: 100%; background: #ff2d55; }
  .sc-slider-thumb {
    position: absolute; top: 1px; width: 22px; height: 22px; border-radius: 11px;
    background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.35);
  }
  .sc-leaf-segmented {
    display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(255,255,255,0.08); align-self: flex-start;
  }
  .sc-seg { padding: 5px 12px; border-radius: 7px; font-size: 12px; color: #fff; }
  .sc-seg.sc-on { background: rgba(255,255,255,0.18); font-weight: 600; }
  .sc-leaf-toggle {
    width: 51px; height: 31px; border-radius: 16px; flex: 0 0 auto;
    background: #ff2e54; position: relative;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.18);
  }
  .sc-leaf-toggle::after {
    content: ''; position: absolute; top: 2px; right: 2px; width: 27px; height: 27px;
    border-radius: 14px; background: linear-gradient(180deg, #fff, #f2f2f4);
    box-shadow: 0 2px 5px rgba(0,0,0,0.35), 0 0 1px rgba(0,0,0,0.2);
  }
  .sc-leaf-textfield {
    padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.07);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
    color: rgba(255,255,255,0.38); font-size: 14px; width: 100%;
  }
  /* an XML component instance — its template renders inside as a live preview;
     inner elements carry no ids, so the whole instance selects/drags as ONE unit */
  .sc-comp-instance { display: flex; flex-direction: column; align-self: stretch; position: relative; }
  /* preview and embed content is inert: the instance itself is the only pointer
     target inside, so hover and selection always resolve to the component */
  .sc-comp-instance > .sc-node, .sc-leaf-embed > * { pointer-events: none; }
  /* a NATIVE component (custom Swift/Kotlin, no XML template) — the embed block */
  .sc-leaf-embed {
    display: flex; align-items: center; gap: 11px; align-self: stretch; width: 100%;
    padding: 14px; border-radius: 10px;
    background: rgba(99,212,137,0.08); border: 1px solid rgba(99,212,137,0.45);
  }
  .sc-embed-icon {
    flex: 0 0 auto; width: 26px; height: 26px; display: grid; place-items: center;
    border-radius: 6px; background: rgba(99,212,137,0.16); color: #8fdcab;
  }
  .sc-embed-icon svg { display: block; }
  .sc-embed-text { font-size: 11.5px; line-height: 1.45; font-style: italic; color: #9ee2b8; }
  .sc-embed-text b { font-style: normal; font-weight: 650; color: #c8f0d7; }
  .sc-leaf-divider { height: 1px; background: rgba(255,255,255,0.13); width: 100%; }
  .sc-leaf-spacer {
    flex: 1; min-height: 8px; min-width: 8px; border-radius: 3px; opacity: 0.5;
    background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.08) 0 1px, transparent 1px 7px);
    border: 1px dashed rgba(255,255,255,0.09);
  }
  /* a data-bound element: purple chrome on hover/selection, nothing at rest */
  .sc-box.sc-hover.sc-data { border-color: rgba(138,99,210,0.65); }
  .sc-box.sc-sel.sc-data, .sc-box.sc-multi.sc-data { border-color: var(--sc-data); }
  .sc-box.sc-data .sc-nlabel { background: rgba(138,99,210,0.92); }
  .sc-box.sc-data .sc-tagchip { background: var(--sc-data); }
  .sc-box.sc-data .sc-tagchip:hover { background: #9d7ae8; }
  /* repeated rows of a bound list: inert previews of the template, dimmed */
  .sc-row-ghost { opacity: 0.45; pointer-events: none; }
  .sc-row-ghost, .sc-row-ghost * { user-select: none; }

  .sc-editing .sc-leaf-text, .sc-editing .sc-leaf-button { user-select: text; cursor: text; }
  /* the field flips into FORMULA dress the moment the text reads as one */
  .sc-editing-fx {
    box-shadow: 0 0 0 1px rgba(138,99,210,0.7), 0 0 0 4px rgba(138,99,210,0.16);
    border-radius: 3px;
  }
  .sc-viewport .sc-editing-fx[contenteditable]:focus { outline-color: var(--sc-data); }
  /* live result chip: shows what the formula resolves to, per keystroke */
  /* binding panel, Framer-grade: filled controls, real radii, two accents —
     blue is selection, violet is data */
  @keyframes sc-fxin { from { opacity: 0; transform: translateY(6px) scale(0.98); } }
  .sc-fxpanel.sc-fxout {
    opacity: 0; transform: translateY(3px);
    transition: opacity 105ms ease, transform 105ms ease; pointer-events: none;
  }
  .sc-fxrow.sc-picked { background: rgba(20,110,245,0.22) !important; }
  .sc-fxrow.sc-picked .sc-fxname { color: #fff; }
  .sc-fxpanel {
    position: absolute; display: none; flex-direction: column; width: 324px;
    background: rgba(30,30,30,0.92); border: 0; border-radius: 12px;
    backdrop-filter: blur(24px) saturate(1.4); -webkit-backdrop-filter: blur(24px) saturate(1.4);
    box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 2px 8px rgba(0,0,0,0.3),
                0 16px 50px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05);
    pointer-events: auto; z-index: 3; overflow: hidden;
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    animation: sc-fxin 170ms cubic-bezier(0.16, 1, 0.3, 1); transform-origin: top left;
    will-change: transform, opacity;
    -webkit-font-smoothing: antialiased;
  }
  .sc-bindhead { display: flex; align-items: center; gap: 9px; padding: 14px 16px 10px; }
  .sc-bindhead b { color: #fff; font-size: 12px; font-weight: 600; }
  .sc-bindattr {
    background: #2b2b2b; border: 0; border-radius: 7px; outline: none;
    color: #ccc; font: 500 11px 'Inter', system-ui, sans-serif; padding: 5px 22px 5px 9px; cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6" viewBox="0 0 8 6"><path d="M1 1.5L4 4.5L7 1.5" stroke="%23909090" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    background-repeat: no-repeat; background-position: right 8px center;
    transition: background-color 90ms ease, color 90ms ease;
  }
  .sc-bindattr:hover { background: #333; color: #fff; }
  .sc-bindspacer { flex: 1; }
  .sc-bindx {
    background: none; border: 0; color: #777; cursor: pointer; margin-right: -6px;
    width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
  }
  .sc-bindx svg { display: block; }
  .sc-bindx { transition: background-color 90ms ease, color 90ms ease; }
  .sc-bindx:hover { color: #fff; background: #2b2b2b; }
  .sc-bindsearch { display: flex; align-items: center; gap: 8px; padding: 0 14px 9px; }
  .sc-bindsearch-ic { color: #5e5e5e; display: grid; place-items: center; flex: 0 0 auto; }
  .sc-bindsearch-ic svg { display: block; }
  .sc-bindsearch[hidden] { display: none; }
  .sc-fxinput {
    flex: 1; min-width: 0; box-sizing: border-box; background: none; border: 0;
    padding: 7px 0; outline: none;
    color: #fff; font: 450 12.5px 'Inter', system-ui, sans-serif;
  }
  .sc-fxinput::placeholder { color: #777; }
  .sc-bindexpr { display: flex; align-items: center; gap: 9px; padding: 0 12px 10px; }
  .sc-bindexpr[hidden] { display: none; }
  .sc-fxbar-fx { flex: 0 0 auto; color: #a484e9; display: grid; place-items: center; }
  .sc-fxbar-fx svg { display: block; }
  .sc-exprinput {
    flex: 1; min-width: 0; background: #161616; border: 0; border-radius: 8px;
    padding: 9px 11px; outline: none;
    color: #ebe3fb; font: 450 11.5px/1.5 var(--sc-mono); caret-color: #a484e9;
  }
  .sc-exprinput:focus { box-shadow: inset 0 0 0 1px #8a63d2; }
  .sc-exprinput::placeholder { color: #595959; }
  .sc-fxlist { max-height: 244px; overflow-y: auto; padding: 3px 8px 8px; display: flex; flex-direction: column; gap: 2px; }
  .sc-fxlist:empty { display: none; }
  .sc-fxlist::-webkit-scrollbar { width: 8px; }
  .sc-fxlist::-webkit-scrollbar-thumb { background: #353535; border-radius: 4px; border: 2px solid #1f1f1f; }
  .sc-fxlist::-webkit-scrollbar-thumb:hover { background: #454545; }
  .sc-fxhead { padding: 12px 10px 5px; font-size: 10px; font-weight: 600; color: #777; }
  .sc-fxhead:first-child { padding-top: 3px; }
  .sc-fxstate { display: flex; flex-direction: column; gap: 3px; padding: 10px 9px 14px; }
  .sc-fxstate b { color: #b4b4b4; font-size: 11.5px; font-weight: 550; }
  .sc-fxstate span { color: #6b6b6b; font: 450 11px/1.5 'Inter', system-ui, sans-serif; }
  .sc-fxrow {
    display: flex; align-items: center; gap: 10px; padding: 0 8px; width: 100%; height: 33px;
    border: 0; border-radius: 7px; background: none; cursor: pointer; text-align: left; box-sizing: border-box;
    transition: background-color 90ms ease;
  }
  .sc-fxrow:focus-visible { outline: none; box-shadow: inset 0 0 0 1px rgba(20,110,245,0.7); }
  .sc-fxcheck { flex: 0 0 14px; margin-left: 2px; color: #a484e9; display: grid; place-items: center; }
  .sc-fxcheck svg { display: block; }
  .sc-fxtype {
    flex: 0 0 20px; height: 20px; display: grid; place-items: center;
    background: rgba(255,255,255,0.05); border-radius: 6px; color: #8c8c8c;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
  }
  .sc-fxtype svg { display: block; }
  .sc-fxrow.sc-on .sc-fxtype { background: rgba(255,255,255,0.1); color: #d8d8d8; }
  .sc-fxname { color: #ececec; font: 500 12px 'Inter', system-ui, sans-serif; letter-spacing: -0.1px; white-space: nowrap; }
  .sc-fxrow.sc-on .sc-fxname { color: #fff; }
  .sc-fxrow.sc-on .sc-fxsample { color: #a8a8a8; }
  /* path splits: dim scope, bright field — reads like a Framer token */
  .sc-fxrow .sc-fxpath { font: 500 11.5px var(--sc-mono); white-space: nowrap; color: #e6e6e6; }
  .sc-fxrow .sc-fxpath .sc-fxroot { color: #6e6e6e; }
  .sc-fxrow .sc-fxsample {
    margin-left: auto; color: #757575; font: 450 11px 'Inter', system-ui, sans-serif; font-variant-numeric: tabular-nums;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42%;
  }
  .sc-fxrow:hover { background: rgba(255,255,255,0.05); }
  .sc-fxrow.sc-on { background: rgba(255,255,255,0.09); }
  .sc-fxrow.sc-on .sc-fxpath, .sc-fxrow.sc-on .sc-fxpath .sc-fxroot { color: #fff; }
  .sc-fxrow.sc-on .sc-fxsample { color: #9a9a9a; }
  
  .sc-fxresult {
    display: flex; align-items: center; gap: 8px; margin: 0 14px; padding: 10px 2px;
    border-top: 1px solid rgba(255,255,255,0.07);
    color: #a6a6a6; font: 450 10.5px var(--sc-mono);
    white-space: nowrap; overflow: hidden;
  }
  .sc-fxr-text { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .sc-fxr-path { margin-left: auto; padding-left: 12px; color: #5c5c5c; flex: 0 0 auto; }
  .sc-fxresult .sc-fxr-icon { color: #8a63d2; display: grid; place-items: center; flex: 0 0 auto; }
  .sc-fxresult .sc-fxr-icon svg { display: block; }
  .sc-fxpanel.sc-bad .sc-fxresult { color: #e8a04c; }
  .sc-fxpanel.sc-bad .sc-fxr-icon { color: #e8a04c; }
  .sc-bindfoot { display: flex; align-items: center; gap: 4px; padding: 8px 10px 10px; }
  .sc-bindgap { flex: 1; }
  .sc-bindfoot button {
    background: none; border: 0; cursor: pointer; padding: 6px 9px; border-radius: 8px;
    font: 500 11px 'Inter', system-ui, sans-serif;
    transition: background-color 90ms ease, color 90ms ease;
  }
  .sc-bindcustom { color: #999; }
  .sc-bindcustom:hover { color: #fff; background: #2b2b2b; }
  .sc-bindunlink { color: #b699f8; }
  .sc-bindunlink:hover { color: #fff; background: rgba(138,99,210,0.22); }
  .sc-bindunlink[hidden] { display: none; }
  /* bound content reads as data-driven at a glance */
  .sc-bound {
    background-color: rgba(138,99,210,0.13);
    box-shadow: 0 0 0 1px rgba(138,99,210,0.22);
    border-radius: 2px;
  }
  .sc-viewport.sc-preview .sc-bound { background-color: transparent; box-shadow: none; }
  .sc-viewport [contenteditable]:focus { outline: 1px solid var(--sc-accent); outline-offset: 2px; border-radius: 2px; }

  /* drop line: SCREEN-SPACE overlay chrome — zero layout impact, the design
     never shifts while you aim, and the line stays a crisp 2px at any zoom */
  .sc-dropline {
    position: absolute; display: none; background: var(--sc-accent);
    border-radius: 1px; pointer-events: none;
    box-shadow: 0 0 8px rgba(20,110,245,0.65); z-index: 1;
  }
  .sc-dropline::before, .sc-dropline::after { content: ''; position: absolute; background: var(--sc-accent); border-radius: 1px; }
  .sc-dropline.sc-col::before { left: -1px; top: -2px; width: 2px; height: 6px; }
  .sc-dropline.sc-col::after  { right: -1px; top: -2px; width: 2px; height: 6px; }
  .sc-dropline.sc-row::before { top: -1px; left: -2px; width: 6px; height: 2px; }
  .sc-dropline.sc-row::after  { bottom: -1px; left: -2px; width: 6px; height: 2px; }

  /* selection chrome (screen space) */
  .sc-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; transition: opacity 130ms ease; }
  .sc-viewport.sc-panning .sc-overlay { display: none; }
  .sc-viewport.sc-dragging .sc-box, .sc-viewport.sc-dragging .sc-fxpanel { display: none !important; }
  .sc-viewport.sc-scrolling .sc-overlay { opacity: 0; transition: none; }
  .sc-viewport.sc-preview .sc-overlay { display: none; }
  .sc-viewport.sc-preview .sc-tap { cursor: pointer; }
  .sc-viewport.sc-preview .sc-tap:active { opacity: 0.65; }
  .sc-viewport.sc-preview .sc-input-live { cursor: text; user-select: text; }
  .sc-input-live:not(.sc-ph) { color: #fff; }
  .sc-leaf-toggle.sc-off { background: rgba(120,120,128,0.32); }
  .sc-leaf-toggle.sc-off::after { right: auto; left: 2px; }
  .sc-box { position: absolute; border-radius: 2px; display: none; }
  /* faint dark ring keeps the 1px chrome readable on light content */
  .sc-box.sc-hover { border: 1px solid rgba(20,110,245,0.7); }
  .sc-box.sc-sel { border: 1px solid var(--sc-accent); box-shadow: 0 0 0 1px rgba(0,0,0,0.22); }
  .sc-box.sc-multi { border: 1px solid var(--sc-accent); box-shadow: 0 0 0 1px rgba(0,0,0,0.22); }
  /* lists are GROUPS: their chrome is green */
  .sc-box.sc-hover.sc-grp { border-color: rgba(138,99,210,0.6); }
  .sc-box.sc-sel.sc-grp, .sc-box.sc-multi.sc-grp { border-color: var(--sc-grp); }
  .sc-box.sc-grp .sc-nlabel { background: rgba(138,99,210,0.92); }
  .sc-box.sc-grp .sc-tagchip { background: var(--sc-grp); }
  .sc-box.sc-grp .sc-tagchip:hover { background: #9d7ae8; }
  .sc-ghost.sc-grp { border-color: var(--sc-grp, #8a63d2); box-shadow: 0 10px 28px rgba(0,0,0,0.5), 0 0 0 3px rgba(138,99,210,0.14); }
  .sc-ghost.sc-grp .sc-gicon { color: #a484e9; }
  /* component instances select in pink */
  .sc-box.sc-hover.sc-comp { border-color: rgba(99,212,137,0.6); }
  .sc-box.sc-sel.sc-comp, .sc-box.sc-multi.sc-comp { border-color: var(--sc-comp); }
  .sc-box.sc-comp .sc-nlabel { background: rgba(99,212,137,0.92); }
  .sc-box.sc-comp .sc-tagchip { background: var(--sc-comp); }
  .sc-box.sc-comp .sc-tagchip:hover { background: #79dd9a; }
  @keyframes sc-selpop { from { opacity: 0.4; } }
  .sc-box.sc-sel.sc-pop { animation: sc-selpop 140ms ease-out; }
  .sc-nlabel {
    position: absolute; top: -23px; left: -1px; font-size: 10px; font-weight: 600;
    color: #fff; background: var(--sc-accent); padding: 3px 7px;
    border-radius: 5px; white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  .sc-box.sc-flip .sc-nlabel { top: auto; bottom: -24px; }
  .sc-tagchip {
    position: absolute; top: -23px; left: -1px; display: flex; align-items: center; gap: 5px;
    font-size: 10px; font-weight: 600; color: #fff;
    background: var(--sc-accent); padding: 3px 7px; border-radius: 5px;
    white-space: nowrap; pointer-events: auto; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  .sc-tagchip:hover { background: #3b86f7; }
  .sc-box.sc-flip .sc-tagchip { top: auto; bottom: -24px; }
  /* size readout: layout pt, bottom-center, Figma style */
  .sc-sizetag {
    position: absolute; left: 50%; bottom: -23px; transform: translateX(-50%);
    font-family: var(--sc-mono); font-size: 9px; font-weight: 600;
    color: #fff; background: var(--sc-accent); padding: 3px 7px; border-radius: 5px;
    white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  .sc-box.sc-grp .sc-sizetag { background: var(--sc-grp); }
  .sc-box.sc-comp .sc-sizetag { background: var(--sc-comp); }
  .sc-box.sc-flip .sc-sizetag { bottom: auto; top: -23px; }
  .sc-viewport.sc-dragging .sc-sizetag, .sc-viewport.sc-dragging .sc-measure { display: none !important; }
  /* alt-hover measurement: distance lines in pt */
  .sc-measure { position: absolute; inset: 0; pointer-events: none; }
  .sc-mline { position: absolute; background: #ff4d6a; }
  .sc-mline::before, .sc-mline::after { content: ''; position: absolute; background: #ff4d6a; }
  .sc-mh::before { left: 0; top: -3px; width: 1px; height: 7px; }
  .sc-mh::after { right: 0; top: -3px; width: 1px; height: 7px; }
  .sc-mv::before { top: 0; left: -3px; height: 1px; width: 7px; }
  .sc-mv::after { bottom: 0; left: -3px; height: 1px; width: 7px; }
  .sc-mlabel {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    font-family: var(--sc-mono); font-size: 9px; font-weight: 600; color: #fff;
    background: #ff4d6a; padding: 2.5px 6px; border-radius: 5px; white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  }
  .sc-mv .sc-mlabel { left: 0; transform: translate(6px, -50%); }
  .sc-chip-icon { display: grid; place-items: center; opacity: 0.9; }
  .sc-chip-icon svg { display: block; }
  .sc-chip-badges { display: flex; align-items: center; gap: 3px; margin-left: 2px; padding-left: 4px; border-left: 1px solid rgba(255,255,255,0.3); }
  .sc-chip-badges svg { display: block; }
  .sc-hoverflash { display: inline-grid; place-items: center; margin-left: 3px; vertical-align: -1px; }
  .sc-hoverflash svg { display: block; }

  /* ghost chip (mounted on body) */
  @keyframes sc-ghostin { from { opacity: 0; transform: scale(0.9) rotate(-1deg); } }
  .sc-ghost {
    position: fixed; z-index: 9999; pointer-events: none; display: none;
    align-items: center; gap: 7px; background: rgba(34,34,34,0.95);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border: 1px solid var(--sc-accent, #146ef5); border-radius: 9px; padding: 6px 11px;
    font-size: 11.5px; font-weight: 600; color: #f0f0f0;
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    box-shadow: 0 14px 36px rgba(0,0,0,0.55), 0 0 0 3px rgba(20,110,245,0.12);
    animation: sc-ghostin 120ms ease-out;
  }
  .sc-gicon { color: #146ef5; display: grid; place-items: center; }
  .sc-gicon svg { display: block; }
  .sc-ghost.sc-comp { border-color: var(--sc-comp, #63d489); box-shadow: 0 10px 28px rgba(0,0,0,0.5), 0 0 0 3px rgba(99,212,137,0.14); }
  .sc-ghost.sc-comp .sc-gicon { color: #63d489; }

  /* zoom controls (opt-in) */
  .sc-zoomctl {
    position: absolute; right: 14px; bottom: 14px; display: flex; align-items: center;
    gap: 1px; background: rgba(28,28,28,0.85);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border: 1px solid #2a2a2a; border-radius: 6px; padding: 2.5px;
    box-shadow: 0 6px 22px rgba(0,0,0,0.4);
  }
  .sc-zoomctl button {
    background: none; border: 0; color: #9c9c9c; cursor: pointer;
    font-family: inherit; font-size: 13px; width: 26px; height: 23px;
    border-radius: 4px; display: grid; place-items: center;
  }
  .sc-zoomctl button:hover { background: #2c2c2c; color: #e2e2e2; }
  .sc-zoomctl .sc-eye svg { display: block; }
  .sc-zoomctl .sc-eye.sc-on { background: rgba(20,110,245,0.2); color: #7aa5ff; }
  .sc-zoomctl .sc-zoomlabel { font-family: var(--sc-mono); font-size: 10.5px; min-width: 48px; font-weight: 500; }

  @media (prefers-reduced-motion: reduce) {
    .sc-viewport *, .sc-ghost { animation: none !important; transition: none !important; }
  }`;

  let stylesInjected = false;
  function injectStyles(mount) {
    if (!stylesInjected && !document.querySelector("style[data-stack-canvas]")) {
      const s = document.createElement("style");
      s.dataset.stackCanvas = "";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    stylesInjected = true;
    // A shadow-DOM host (the editor mounted inside a web-component embed): document-level
    // styles cannot cross the boundary, so the same sheet ALSO lands in the mount's own
    // root. The document copy stays regardless — the drag ghost is body-appended and only
    // that copy reaches it.
    const root = mount && typeof mount.getRootNode === "function" ? mount.getRootNode() : null;
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot && !root.querySelector("style[data-stack-canvas]")) {
      const s = document.createElement("style");
      s.dataset.stackCanvas = "";
      s.textContent = CSS;
      root.appendChild(s);
    }
  }

  const STATUSBAR_SVG = `
    <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor"><rect x="0" y="7" width="3" height="4" rx="0.8"/><rect x="4.5" y="5" width="3" height="6" rx="0.8"/><rect x="9" y="2.5" width="3" height="8.5" rx="0.8"/><rect x="13.5" y="0" width="3" height="11" rx="0.8"/></svg>
    <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor"><path d="M8 9.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zM4.9 7.4a4.6 4.6 0 0 1 6.2 0l-1.3 1.4a2.7 2.7 0 0 0-3.6 0L4.9 7.4zM2 4.6a8.6 8.6 0 0 1 12 0l-1.3 1.3a6.7 6.7 0 0 0-9.4 0L2 4.6z" transform="translate(0,-1.4)"/></svg>
    <svg width="25" height="12" viewBox="0 0 25 12" fill="none"><rect x="0.5" y="0.5" width="21" height="11" rx="3" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="15" height="8" rx="1.6" fill="currentColor"/><path d="M23 4v4a2.2 2.2 0 0 0 0-4z" fill="currentColor" opacity="0.4"/></svg>`;

  class StackCanvas {
    constructor(mount, opts = {}) {
      injectStyles(mount);
      // A web-component embed builds its subtree in a fragment and attaches the shadow
      // root only after construction — re-check once attached (idempotent per root).
      queueMicrotask(() => injectStyles(this.vp));
      this.vp = mount;
      this.vp.classList.add("sc-viewport");
      this.vp.tabIndex = 0;

      this.grid = document.createElement("div");
      this.grid.className = "sc-grid";
      this.vp.appendChild(this.grid);

      this.world = document.createElement("div");
      this.world.className = "sc-world";
      this.overlay = document.createElement("div");
      this.overlay.className = "sc-overlay";
      this.overlay.innerHTML = `
        <div class="sc-box sc-hover"><div class="sc-nlabel"></div></div>
        <div class="sc-box sc-sel">
          <div class="sc-tagchip"><span class="sc-chip-icon"></span><span class="sc-tagname"></span></div>
          <div class="sc-sizetag"></div>
        </div>
        <div class="sc-measure"></div>`;
      this.vp.append(this.world, this.overlay);

      // binding panel, Webflow CMS style: pick a field, no formula syntax
      this.fxPanel = document.createElement("div");
      this.fxPanel.className = "sc-fxpanel";
      this.fxPanel.innerHTML = `
        <div class="sc-bindhead"><b>Bind</b><select class="sc-bindattr" title="Which attribute to bind"></select><span class="sc-bindspacer"></span><button class="sc-bindx" title="Close">${icon("close", 10)}</button></div>
        <div class="sc-bindsearch"><span class="sc-bindsearch-ic">${icon("search", 12)}</span><input class="sc-fxinput" spellcheck="false" placeholder="Search fields" /></div>
        <div class="sc-fxlist"></div>
        <div class="sc-bindexpr" hidden><span class="sc-fxbar-fx">${icon("fx", 12)}</span><input class="sc-exprinput" spellcheck="false" placeholder="dsx.variable.queue.length > 0 ? 'In queue' : 'Add'" /></div>
        <div class="sc-fxresult"><span class="sc-fxr-icon"></span><span class="sc-fxr-text"></span><span class="sc-fxr-path"></span></div>
        <div class="sc-bindfoot">
          <button class="sc-bindcustom">Custom expression</button>
          <span class="sc-bindgap"></span>
          <button class="sc-bindunlink" hidden>Disconnect</button>
        </div>`;
      this.overlay.appendChild(this.fxPanel);
      this.fxList = this.fxPanel.querySelector(".sc-fxlist");
      this.fxInput = this.fxPanel.querySelector(".sc-fxinput");        // field search
      this.exprInput = this.fxPanel.querySelector(".sc-exprinput");   // raw JSE, no prefix
      this.exprWrap = this.fxPanel.querySelector(".sc-bindexpr");
      this.fxChip = this.fxPanel.querySelector(".sc-fxresult");
      this.bindUnlink = this.fxPanel.querySelector(".sc-bindunlink");
      this.bindCustom = this.fxPanel.querySelector(".sc-bindcustom");
      this.bindAttrSel = this.fxPanel.querySelector(".sc-bindattr");
      this.bindAttrSel.addEventListener("change", () => this.setBindKey(this.bindAttrSel.value));
      this._fxMode = false;
      this._bindMode = "fields";   // "fields" | "expr"
      this._fxRows = [];
      this._fxIdx = 0;
      // the panel is an island: clicks never reach canvas selection/pan/drag,
      // and only its inputs may take focus
      this.fxPanel.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.fxPanel.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        if (e.target !== this.fxInput && e.target !== this.exprInput && e.target !== this.bindAttrSel) e.preventDefault();
      });
      this.fxPanel.addEventListener("dblclick", (e) => e.stopPropagation());
      this.fxPanel.addEventListener("wheel", (e) => e.stopPropagation());
      this.fxPanel.addEventListener("click", (e) => {
        e.stopPropagation();
        const b = e.target.closest("[data-fx]");
        if (b) {
          if (this._fxCommitting) return;
          this._fxCommitting = true;
          b.classList.add("sc-picked");
          setTimeout(() => this.bindTo(this.editing, this._fxRows[+b.dataset.fx]?.path), 130);
          return;
        }
        if (e.target === this.bindUnlink) { this.disconnect(this.editing); return; }
        if (e.target.closest(".sc-bindx")) { this.closeBinding(false); return; }
        if (e.target === this.bindCustom) { this.setBindMode(this._bindMode === "expr" ? "fields" : "expr"); return; }
      });


      this.hoverBox = this.overlay.querySelector(".sc-box.sc-hover");
      this.hoverLabel = this.hoverBox.querySelector(".sc-nlabel");
      this.selBox = this.overlay.querySelector(".sc-box.sc-sel");
      this.tagChip = this.selBox.querySelector(".sc-tagchip");
      this.chipIcon = this.tagChip.querySelector(".sc-chip-icon");
      this.sizeTag = this.selBox.querySelector(".sc-sizetag");
      this.measure = this.overlay.querySelector(".sc-measure");
      this.altDown = false;

      this.ghost = document.createElement("div");
      this.ghost.className = "sc-ghost";
      document.body.appendChild(this.ghost);

      if (opts.controls !== false) {
        this.ctl = document.createElement("div");
        this.ctl.className = "sc-zoomctl";
        this.ctl.innerHTML = `
          <button class="sc-eye" title="Preview: scroll and use the app, editing off"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${ICONS.eye}</svg></button>
          <button class="sc-zout" title="Zoom out (⌘−)">−</button>
          <button class="sc-zoomlabel" title="Click to fit (⌘0) · ⌘1 for 100%">100%</button>
          <button class="sc-zin" title="Zoom in (⌘+)">＋</button>`;
        this.vp.appendChild(this.ctl);
        this.zoomLabelEl = this.ctl.querySelector(".sc-zoomlabel");
        this.btnPreview = this.ctl.querySelector(".sc-eye");
        this.btnPreview.addEventListener("click", () => this.setPreview(!this.preview));
        this.ctl.querySelector(".sc-zin").addEventListener("click", () => this.zoomAtCenter(1.25));
        this.ctl.querySelector(".sc-zout").addEventListener("click", () => this.zoomAtCenter(1 / 1.25));
        this.zoomLabelEl.addEventListener("click", () => this.fit());
      }

      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this._hist = { undo: [], redo: [], t: 0, restoring: false };
      this.preview = false;
      this.sel = null;                 // primary selection id
      this.selIds = new Set();         // full (multi) selection
      this.hov = null;
      this.drag = null;
      this.hint = null;
      this.spaceDown = false;
      this.panning = false;
      this.editing = null;
      this.els = new Map();
      this.listeners = new Map();
      this.idx = { node: new Map(), parent: new Map(), order: new Map() };
      this.multiBoxes = [];            // pooled chrome boxes for non-primary selection

      this.line = document.createElement("div");
      this.line.className = "sc-dropline";
      this.overlay.appendChild(this.line);
      this.dropTargetEl = null;

      // component registry: name → template node. An instance of a registered
      // component renders its template as a preview; an unregistered (native)
      // component renders as an embed block — Webflow's embed pattern.
      this.components = {};
      const defs = opts.components || [];
      if (Array.isArray(defs)) defs.forEach((d) => { if (d?.name && d?.template) this.components[d.name] = d.template; });
      else Object.assign(this.components, defs);

      // sample data the editor binds against: {{ paths }} and bind="path" resolve
      // here, exactly like the runtime store, so the canvas shows real content
      this.data = opts.data || {};
      // design-time root scope: what dsx.attribute / dsx.this / dsx.item resolve to at
      // the top of the tree — the host's mock props when editing a component
      this.scope = StackCanvas.normScope(opts.scope);
      this.logic = { variables: [], actions: [], functions: [] };
      this._dstate = null;

      this.frameless = opts.frame === false;
      this.buildFrame();
      this.bind();
      if (opts.tree) this.load(opts.tree);
    }

    /* ── events ───────────────────────────────────────────────────────────── */
    on(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(fn);
      return this;
    }
    off(name, fn) {
      const l = this.listeners.get(name);
      if (l) this.listeners.set(name, l.filter((f) => f !== fn));
      return this;
    }
    emit(name, data) {
      if (name === "change" && !this._hist.restoring) this._record();
      const safe = (fn, ...args) => {
        try { fn(...args); }
        catch (err) { console.error("[StackCanvas] listener for '" + name + "' threw:", err); }
      };
      (this.listeners.get(name) || []).forEach((fn) => safe(fn, data));
      (this.listeners.get("*") || []).forEach((fn) => safe(fn, name, data));
    }

    /* ── O(1) tree index — rebuilt after structural mutations ─────────────── */
    reindex() {
      this.idx = { node: new Map(), parent: new Map(), order: new Map() };
      let k = 0;
      const walk = (n, p) => {
        this.idx.node.set(n.id, n);
        this.idx.parent.set(n.id, p);
        this.idx.order.set(n.id, k++);
        (n.children || []).forEach((c) => walk(c, n));
      };
      if (this.tree) walk(this.tree, null);
    }
    nodeOf(id) { return this.idx.node.get(id) || null; }
    parentOf(id) { const p = this.idx.parent.get(id); return p || null; }
    chainOf(id) {
      const out = [];
      let n = this.nodeOf(id);
      while (n) { out.unshift(n); n = this.parentOf(n.id); }
      return out;
    }
    isAncestor(aId, bId) {
      let p = this.parentOf(bId);
      while (p) { if (p.id === aId) return true; p = this.parentOf(p.id); }
      return false;
    }
    isRepeater(n) { return !!n && (n.tag === "list" || n.tag === "grid") && n.attrs?.bind != null; }   // engine: only lists repeat
    isTemplateRoot(id) {
      const p = this.parentOf(id);
      return this.isRepeater(p) && (p.children || [])[0]?.id === id;
    }
    // detach a subtree from row scope: item bindings become the literal values
    // they were showing (row 0), so the unlinked element looks unchanged
    materializeItem(node, scope) {
      const itemRef = (s) => ROW_REF.test(s);
      const walk = (n) => {
        const a = n.attrs || {};
        if (typeof a.bind === "string" && itemRef(a.bind)) {
          const v = this.evalIn(a.bind, scope);
          const key = n.tag === "button" ? "label" : n.tag === "textfield" ? "placeholder" : "value";
          if (v != null) a[key] = String(v);
          delete a.bind;
        }
        for (const [k, v] of Object.entries(a)) {
          if (typeof v === "string" && hasMustache(v) && itemRef(v)) {
            a[k] = v.replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => { const r = this.evalIn(e, scope); return r == null ? m : String(r); });
          }
        }
        (n.children || []).forEach(walk);
      };
      walk(node);
    }

    // does this subtree reference row data ($item / $this) in any
    // binding, mustache, or action? Only then is it tied to the list's scope.
    usesItemData(node) {
      const exprHit = (s) => ROW_REF.test(s);
      const check = (n) => {
        for (const [k, v] of Object.entries(n?.attrs || {})) {
          if (typeof v !== "string") continue;
          if ((k === "bind" || k === "where" || k.startsWith("on:")) && exprHit(v)) return true;
          if (hasMustache(v)) {
            const inner = [...v.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).join(" ");
            if (exprHit(inner)) return true;
          }
        }
        return (n?.children || []).some(check);
      };
      return check(node);
    }
    // nearest bound-list row template containing id (null when outside any)
    templateRootOf(id) {
      let cur = this.parentOf(id)?.id ? id : null;
      while (cur) {
        if (this.isTemplateRoot(cur)) return cur;
        cur = this.parentOf(cur)?.id || null;
      }
      return null;
    }

    /* ── public API ───────────────────────────────────────────────────────── */
    load(tree) {
      this.tree = ensureIds(JSON.parse(JSON.stringify(tree)));
      this.sel = null;
      this.selIds = new Set();
      this.hov = null;
      this.reindex();
      this._hist = { undo: [{ tree: this.getTree(), sel: [], primary: null }], redo: [], t: 0, restoring: false };
      if (this.preview) this.sim = this.materializeState(JSON.parse(JSON.stringify(this.data || {})));   // fresh run
      this.repaint();
      requestAnimationFrame(() => { this.fit(); this.emit("ready", { nodes: countNodes(this.tree) }); });
    }

    // Replace the tree IN PLACE — the undo/redo primitive. Keeps the view where
    // it is, keeps selection where ids survive, and emits no change event: the
    // host owns its history and shouldn't hear its own restore echoed back.
    setTree(tree) {
      this.tree = ensureIds(JSON.parse(JSON.stringify(tree)));
      this.reindex();
      const keep = [...this.selIds].filter((id) => this.nodeOf(id));
      this.selIds = new Set(keep);
      this.sel = keep.includes(this.sel) ? this.sel : keep[keep.length - 1] || null;
      this.repaint();
      this.updateChrome();
      if (!this._hist.restoring) this._record();
    }

    /* ── history ──────────────────────────────────────────────────────────── */
    _record() {
      const h = this._hist;
      const snap = { tree: this.getTree(), sel: [...this.selIds], primary: this.sel };
      const now = Date.now();
      // rapid edits to the same node (slider scrubs, repeated nudges) collapse
      // into one step; the baseline at index 0 is never replaced
      if (h.undo.length > 1 && now - h.t < 350 && h.undo[h.undo.length - 1].primary === snap.primary) {
        h.undo[h.undo.length - 1] = snap;
      } else {
        h.undo.push(snap);
        if (h.undo.length > 100) h.undo.shift();
      }
      h.t = now;
      h.redo.length = 0;
    }
    get canUndo() { return this._hist.undo.length > 1; }
    get canRedo() { return this._hist.redo.length > 0; }
    undo() {
      const h = this._hist;
      if (h.undo.length < 2) return false;
      h.redo.push(h.undo.pop());
      this._restore(h.undo[h.undo.length - 1]);
      return true;
    }
    redo() {
      const h = this._hist;
      if (!h.redo.length) return false;
      const snap = h.redo.pop();
      h.undo.push(snap);
      this._restore(snap);
      return true;
    }
    _restore(snap) {
      const h = this._hist;
      h.restoring = true;
      try {
        const play = this.flipStart();
        this.setTree(snap.tree);   // keeps the view, prunes dead selection
        const keep = snap.sel.filter((id) => this.nodeOf(id));
        this.setSelection(keep, keep.includes(snap.primary) ? snap.primary : keep[keep.length - 1] || null, "history");
        play();
        this.emit("change", { tree: this.getTree() });
        this.emit("history", { undo: h.undo.length - 1, redo: h.redo.length });
      } finally { h.restoring = false; }
    }
    getNode(id) {
      const n = this.nodeOf(id);
      return n ? JSON.parse(JSON.stringify(n)) : null;
    }
    getTree() { return JSON.parse(JSON.stringify(this.tree)); }
    registerComponent(name, template) {
      this.components[name] = template;
      if (this.tree) { this.repaint(); this.updateChrome(); }
    }
    // PREVIEW = a live DSX simulator. Entering it forks the sample data into a
    // running state (dsx.variable / dsx.global), renders every bound row from it, and
    // wires on:tap handlers through the JSE runtime: assignments mutate state,
    // array methods work, dsx.event(...) emits `appevent`, dsx.module.*(...) emits
    // `native`, and the screen re-renders after each handler. Exiting discards
    // the run state and restores the design canvas untouched.
    setPreview(on = true) {
      on = !!on;
      if (on === this.preview) return;
      this.preview = on;
      if (on) {
        this.cancelDrag();
        if (this.editing) this.els.get(this.editing)?.blur();   // commits
        this.hov = null;
        this.sim = this.materializeState(JSON.parse(JSON.stringify(this.data || {})));
        this.renderSim();
      } else {
        this.sim = null;
        this.render();                                          // design canvas back, untouched
      }
      this.vp.classList.toggle("sc-preview", on);
      this.btnPreview?.classList.toggle("sc-on", on);
      this.updateChrome();
      this.emit("preview", { on });
    }
    getState() { return this.sim ? JSON.parse(JSON.stringify(this.sim)) : null; }

    /* ── document logic: <variable>, <action>, and preserved <functions>
       blocks, like the engine. Function blocks remain round-trippable editor
       data; this legacy preview does not invent a separate global-function
       execution model for them.
       Mutable variables run their body ONCE as the default value; computed
       variables re-evaluate on every read and are never writable. Actions
       are named JSE bodies, called as $action.name(input, { event: () => … }). */
    defineVariable(name, { computed = false, body = "" } = {}) {
      if (!name) return;
      const next = { name, computed: !!computed, body: String(body) };
      const i = this.logic.variables.findIndex((v) => v.name === name);
      if (i >= 0) this.logic.variables[i] = next;   // upsert in place: no reorder on save
      else this.logic.variables.push(next);
      this._dstate = null;
      this.repaint();
      this.emit("logic", this.getLogic());
    }
    removeVariable(name) {
      this.logic.variables = this.logic.variables.filter((v) => v.name !== name);
      this._dstate = null;
      this.repaint();
      this.emit("logic", this.getLogic());
    }
    defineAction(name, body) {
      if (!name) return;
      const next = { name, body: String(body ?? "") };
      const i = this.logic.actions.findIndex((x) => x.name === name);
      if (i >= 0) this.logic.actions[i] = next;
      else this.logic.actions.push(next);
      this.emit("logic", this.getLogic());
    }
    removeAction(name) {
      this.logic.actions = this.logic.actions.filter((x) => x.name !== name);
      this.emit("logic", this.getLogic());
    }
    setLogic({ variables = [], actions = [], functions = [] } = {}) {
      this.logic = {
        variables: variables.map((v) => ({ name: v.name, computed: !!v.computed, body: String(v.body ?? "") })),
        actions: actions.map((x) => ({ name: x.name, body: String(x.body ?? "") })),
        functions: functions.map((body) => String(body ?? "")),
      };
      this._dstate = null;
      this.repaint();
      this.emit("logic", this.getLogic());
    }
    getLogic() { return JSON.parse(JSON.stringify(this.logic)); }
    // dry-run an action against a fork of the design state: returns the
    // events it emitted and the state it would leave behind. Powers the
    // host's test runner; touches nothing real.
    testAction(name, input = {}) {
      const def = this.logic.actions.find((x) => x.name === name);
      if (!def) return { ok: false, error: "unknown action", events: [], state: null };
      const prevSim = this.sim;
      this.sim = this.materializeState(JSON.parse(JSON.stringify(this.data || {})));
      const events = [];
      try {
        const inner = this.simCtx({});
        const ctx = {
          ...inner,
          rootValue: (nm) => {
            if (nm === "ctx") return { __path: ["ctx"] };
            if (nm in input) return input[nm];
            return inner.rootValue(nm);
          },
          call: (p, a) => {
            if (p[0] === "ctx" && p[1] === "event") { events.push({ name: a[0], payload: a[1] ?? null }); return undefined; }
            if (p[0] === "fetch") { events.push({ name: "(fetch)", payload: a[0] ?? null }); return { ok: false, status: 0, data: null, error: "fetch runs natively, not in canvas preview" }; }
            return inner.call(p, a);
          },
        };
        jseRun(def.body, ctx);
        const state = JSON.parse(JSON.stringify(this.sim));
        return { ok: true, events, state };
      } finally {
        this.sim = prevSim;
      }
    }
    // evaluate a variable/action body against the design state — the live
    // result preview hosts show while the user types
    previewLogic(body) {
      try {
        const v = jseRun(String(body ?? ""), this.stateCtx(this.designState()));
        return { value: v, resolves: v !== undefined };
      } catch (_) { return { value: undefined, resolves: false }; }
    }

    // a minimal pure-read ctx over a state object, for variable bodies
    stateCtx(state) {
      const self = this;
      const ctx = {
        jseScope: { vars: state, platform: "ios" },
        rootValue(name) {
          if (name === "dsx") return dsxData({}, state);
          if (name === "os" || name === "platform") return "ios";
          return undefined;
        },
        moduleContext(scheme) { return ((state.moduleContext ??= {})[scheme] ??= {}); },
        rootContainer() { return null; },
        rootSlot() { return null; },
        callFn(fn, args) {
          // chain off `this` (the ctx this call ARRIVED on), not the closed-over
          // base — a nested arrow must see its enclosing arrow's params
          // (corpus `arrow-captures-enclosing-param`).
          const outer = this;
          const params = {};
          (fn.params || []).forEach((pn, i) => { params[pn] = args[i]; });
          return runArrow(fn, { ...outer, rootValue: (nm) => (nm in params ? params[nm] : outer.rootValue(nm)) });
        },
        call() { return undefined; },
      };
      return ctx;
    }
    // overlay the logic layer on a plain state object: defaults run once,
    // computed become live getters re-evaluated on every read
    materializeState(state) {
      const ctx = this.stateCtx(state);
      for (const v of this.logic.variables) {
        if (v.computed) continue;
        if (state[v.name] === undefined) state[v.name] = jseRun(v.body, ctx);
      }
      for (const v of this.logic.variables) {
        if (!v.computed) continue;
        const body = v.body;
        Object.defineProperty(state, v.name, {
          enumerable: true,
          configurable: true,
          get: () => jseRun(body, ctx),
        });
      }
      return state;
    }
    // design-time state: sample data + the logic layer, cached until invalidated
    designState() {
      if (!this._dstate) this._dstate = this.materializeState({ ...(this.data || {}) });
      return this._dstate;
    }

    // JSE evaluation context over the running state + the row scope at hand
    simCtx(scope) {
      const vars = this.sim;
      const self = this;
      return {
        jseScope: { vars, item: scope.item, attrs: scope.attrs, platform: "ios" },
        // DSX namespaces, exactly like the native engine: state lives ONLY
        // under dsx.variable.<name>; rows are dsx.item.*, globals dsx.global.*,
        // the element's own value is dsx.this, instance props dsx.attribute.*.
        // Bare identifiers (and legacy bare $names) resolve to nothing.
        rootValue(name) {
          if (name === "dsx") return dsxData(scope, vars);
          if (name === "os" || name === "platform") return "ios";
          if (name === "fetch") return { __path: ["fetch"] };
          if (scope.item  && typeof scope.item  === "object" && name in scope.item)  return scope.item[name];
          if (scope.attrs && typeof scope.attrs === "object" && name in scope.attrs) return scope.attrs[name];
          if (vars && name in vars) return vars[name];
          return undefined;
        },
        moduleContext(scheme) { return ((vars.moduleContext ??= {})[scheme] ??= {}); },
        // writable namespaces for member assignment (dsx.variable.x = …)
        rootContainer(name) {
          if (name === "variable" || name === "formula") return vars;
          if (name === "global") return (vars.global ??= {});
          if (name === "route") return (vars.route ??= {});
          if (name === "cookie") return (vars.cookie ??= {});
          if (name === "item") return scope.item;
          return null;
        },
        rootSlot(name) {
          // only $this is assignable at the root, like the engine
          if (name === "$this") return { obj: scope, key: "self" };
          return null;
        },
        callFn(fn, args, selfVal) {
          // `outer` = the ctx this call ARRIVED on (it carries any enclosing
          // arrow's params — corpus `arrow-captures-enclosing-param`); `inner`
          // = a fresh ctx over the self-updated scope, consulted ONLY for the
          // dsx namespace (where $this/dsx.this live). Everything else chains
          // outward so nested arrows keep their captures.
          const outer = this;
          const params = {};
          (fn.params || []).forEach((pn, i) => { params[pn] = args[i]; });
          const inner = self.simCtx(selfVal === undefined ? scope : { ...scope, self: selfVal });
          return runArrow(fn, {
            ...inner,
            rootValue: (nm) => (nm in params ? params[nm] : nm === "dsx" ? inner.rootValue(nm) : outer.rootValue(nm)),
          });
        },
        call(path, args) {
          if (path[0] === "dsx" && path[1] === "event") path = ["$event"];
          else if (path[0] === "dsx" && path[1] === "action") path = ["$action", path[2]];
          else if (path[0] === "dsx" && path[1] === "module") {
            const fxHit = self.matchFixture && self.matchFixture(path[2], path.slice(3), args[0]);
            if (fxHit) {
              const invoke = (this && this.callFn) ? (fn, a) => this.callFn(fn, a) : null;
              self.playScenario(fxHit, args[1], invoke);
              self.emit("native", { path: path.join("."), args, fixture: fxHit.name, mocked: true });
              return (fxHit.resolve !== undefined ? fxHit.resolve : fxHit.expect);
            }
            self.emit("native", { path: path.join("."), args }); return undefined;
          }
          if (path[0] === "$event") {
            // component → consumer: the instance's on:<name> handler runs
            // with $this = the payload, in the consumer's scope
            const name = args[0], payload = args[1];
            const host = scope.host;
            const handler = host?.node?.attrs?.["on:" + name];
            self.emit("appevent", { name, payload, handled: !!handler });
            if (handler) self.runHandler(handler, host.scope, host.node, payload ?? {});
            return undefined;
          }
          if (path[0] === "fetch") {
            // native HTTP is unavailable in the canvas; settle with the
            // engine's envelope so `if (r.ok)` logic still runs
            self.emit("native", { path: "fetch", args });
            return { ok: false, status: 0, data: null, error: "fetch runs natively, not in canvas preview" };
          }
          if (path[0] === "$action") {
            // $action.name(input, { event: () => … }): the body runs with the
            // input merged into its scope; ctx.event('x', payload) inside the
            // body fires the caller's callback with $this = the payload
            const name = path[1];
            const def = self.logic.actions.find((x) => x.name === name);
            const input = args[0] && typeof args[0] === "object" && !args[0].__fn ? args[0] : {};
            const callbacks = args[1] && typeof args[1] === "object" ? args[1] : {};
            self.emit("native", { path: "$action." + (name || "?"), args: [input] });
            if (!def) return undefined;
            const inner = self.simCtx(scope);
            const actionCtx = {
              ...inner,
              rootValue: (nm) => {
                if (nm === "ctx") return { __path: ["ctx"] };
                if (nm in input) return input[nm];
                return inner.rootValue(nm);
              },
              call: (p2, a2) => {
                if (p2[0] === "ctx" && p2[1] === "event") {
                  const cb = callbacks[a2[0]];
                  self.emit("appevent", { name: a2[0], payload: a2[1], action: name });
                  if (cb && cb.__fn) inner.callFn(cb.__fn, [], a2[1] ?? {});
                  return undefined;
                }
                return inner.call(p2, a2);
              },
            };
            return runToks(jseTokens(def.body), actionCtx);
          }
          self.emit("native", { path: path.join("."), args });
          return undefined;
        },
      };
    }

    // ── declared-test simulation: load a package dsx.json (methods + actions/tests) as fixtures ──
    loadTests(manifest) {
      manifest = manifest || {};
      const fx = []; const scheme = manifest.scheme || "";
      const pushTest = (t, segs, decl) => {
        if (!t || typeof t !== "object") return;
        const p0 = [];
        if (typeof t.name !== "string" || !t.name) p0.push("missing name");
        if (t.resolve !== undefined && t.expect !== undefined) p0.push("both resolve and expect");
        if ((t.resolve !== undefined || t.expect !== undefined) && t.expectError !== undefined) p0.push("both resolve/expect and expectError");
        if (("expectError" in t) && (typeof t.expectError !== "string" || !t.expectError)) p0.push("expectError must be a non-empty string");
        fx.push({
          scheme, segs: segs.slice(), name: t.name || segs.join("."), problems0: p0,
          args: t.args || {}, expect: t.expect, expectError: t.expectError,
          resolve: (t.resolve !== undefined ? t.resolve : t.expect),
          given: (t.given || t.hydrate || null),
          broadcasts: (t.broadcasts || t.emits || []), events: (t.events || []), emits: t.emits || [],
          decl: { args: (decl && decl.args) || {}, returns: decl && decl.returns, stream: !!(decl && decl.stream) } });
      };
      Object.keys(manifest.actions || {}).forEach((path) => {
        if (path === "_note") return; const a = manifest.actions[path]; if (!a || typeof a !== "object") return;
        const decl = { args: a.args || {}, returns: a.resolves, stream: !!a.stream };
        (a.tests || []).forEach((t) => pushTest(t, String(path).split("."), decl));
      });
      this.tests = { scheme, fixtures: fx, hydrate: manifest.hydrate || null };
      this.emit("tests", { scheme, count: fx.length });
      return fx.length;
    }
    matchFixture(scheme, segs, callArg) {
      const t = this.tests; if (!t) return null;
      const a = (callArg && typeof callArg === "object") ? callArg : {};
      return t.fixtures.find((f) => !f.expectError && f.scheme === scheme &&
        f.segs.length === segs.length && f.segs.every((s, i) => s === segs[i]) &&
        Object.keys(f.args).every((k) => JSON.stringify(f.args[k]) === JSON.stringify(a[k]))) || null;
    }
    // play a fixture as a SIMULATION: broadcasts (dsx.broadcast) fire now; events (the dsx.event
    // stream) fire on a clock at each at ms - each as a streamed appevent, and into the deck callback
    // when one was passed: dsx.module.x.action(args, { <event>: fn }) or a single fn.
    // seed a scenario initial state into the live sim stores: hydrate.global -> dsx.global,
    // hydrate.variable -> the surface vars, hydrate.context -> dsx.module.<scheme>.context. Merge,
    // not replace, so unrelated live state survives. Public so a host can stage a scenario too.
    applyHydrate(hydrate, scheme) {
      if (!hydrate || !this.sim) return;
      if (hydrate.global)   Object.assign(this.sim.global ??= {}, hydrate.global);
      if (hydrate.variable) Object.assign(this.sim, hydrate.variable);
      if (hydrate.context)  Object.assign((this.sim.moduleContext ??= {})[scheme] ??= {}, hydrate.context);
    }
    playScenario(fx, cbArg, invoke) {
      this.applyHydrate(this.tests && this.tests.hydrate, fx.scheme);
      this.applyHydrate(fx.given, fx.scheme);
      (fx.broadcasts || []).forEach((e) => this.emit("appevent", { name: fx.scheme, payload: e, fixture: fx.name }));
      const cbObj = (cbArg && typeof cbArg === "object") ? cbArg : null;
      (fx.events || []).forEach((ev) => setTimeout(() => {
        this.emit("appevent", { name: fx.scheme, payload: ev, fixture: fx.name, streamed: true });
        if (invoke && cbObj) { const cb = cbObj.__fn ? cbObj : cbObj[ev.event]; if (cb && cb.__fn) invoke(cb.__fn, [ev.data || {}]); }
      }, Math.max(0, +ev.at || 0)));
    }
    runTests() {
      const t = this.tests; const results = [];
      const typeOf = (v) => Array.isArray(v) ? "array" : (v === null ? "null" : typeof v);
      const okType = (val, ty) => {
        if (!ty) return true;
        const base = (typeof ty === "object") ? (ty.type || "object") : ty;
        if (base === "int" || base === "number") return typeOf(val) === "number";
        if (base === "boolean") return typeOf(val) === "boolean";
        if (base === "string") return typeOf(val) === "string";
        if (base === "array") return typeOf(val) === "array";
        if (base === "object" || base === "json") return typeOf(val) === "object";
        return true;
      };
      (t ? t.fixtures : []).forEach((f) => {
        const problems = (f.problems0 || []).slice();
        const dargs = f.decl.args || {};
        if (!f.expectError) {
          Object.keys(f.args || {}).forEach((k) => { if (!(k in dargs)) problems.push("unknown arg " + k); });
          Object.keys(dargs).forEach((k) => {
            if (k === "_note") return;
            const spec = dargs[k]; const optional = (typeof spec === "object") && spec.optional;
            if (!(k in f.args)) { if (!optional) problems.push("missing arg " + k); return; }
            if (!okType(f.args[k], spec)) problems.push("arg " + k + " wrong type");
          });
        }
        const exp = (f.resolve !== undefined ? f.resolve : f.expect);
        const ret = f.decl.returns;
        const retShape = (ret && typeof ret === "object" && !("type" in ret)) ? ret : null;
        if (exp !== undefined && retShape) {
          if (!exp || typeof exp !== "object") problems.push("resolve must be an object (method returns a shape)");
          else {
            Object.keys(retShape).forEach((k) => { if (k === "_note") return; if (!(k in exp)) problems.push("resolve missing return " + k); else if (!okType(exp[k], retShape[k])) problems.push("return " + k + " wrong type"); });
            Object.keys(exp).forEach((k) => { if (k !== "_note" && !(k in retShape)) problems.push("resolve has undeclared return " + k); });
          }
        } else if (exp !== undefined && ret) {
          const base = (typeof ret === "object") ? (ret.type || "object") : ret;
          if (base !== "void" && !okType(exp, base)) problems.push("resolve is wrong type (expected " + base + ")");
        }
        if (f.given) ["global", "context", "variable"].forEach((s) => { if ((s in f.given) && (typeof f.given[s] !== "object" || !f.given[s])) problems.push("given." + s + " must be an object"); });
        (f.broadcasts || []).forEach((e, i) => { if (!e || typeof e !== "object" || typeof e.event !== "string") problems.push("broadcasts[" + i + "] needs a string event"); });
        if ((f.events || []).length && !f.decl.stream) problems.push("events declared but method is not stream:true");
        let lastAt = -1;
        (f.events || []).forEach((ev, i) => {
          if (!ev || typeof ev.event !== "string") problems.push("event[" + i + "] needs a string event");
          if (ev && ("at" in ev)) { const at = +ev.at || 0; if (at < lastAt) problems.push("event[" + i + "] at must be non-decreasing"); lastAt = at; }
        });
        const pass = problems.length === 0;
        const res = { name: f.name, action: f.segs.join("."), kind: f.expectError ? "error" : "value",
          given: f.given, args: f.args, resolve: f.resolve, expect: f.expect, expectError: f.expectError,
          broadcasts: f.broadcasts, events: f.events, emits: f.emits, pass, problems };
        results.push(res); this.emit("testresult", res);
      });
      const passed = results.filter((r) => r.pass).length;
      this.emit("testsummary", { passed, failed: results.length - passed, total: results.length });
      return { passed, failed: results.length - passed, total: results.length, results };
    }

    runHandler(exprSrc, scope, node, selfVal) {
      jseRun(exprSrc, this.simCtx(selfVal === undefined ? scope : { ...scope, self: selfVal }));
      this.emit("action", { id: node?.id, expr: exprSrc, state: this.getState() });
      this.renderSim();
    }

    renderSim() {
      const st = this.screen.scrollTop;
      this.screen.textContent = "";
      this.screen.appendChild(this.buildSim(this.tree, { ...this.scope }, 0));
      this.screen.scrollTop = st;
    }

    // the running app: no editor ids, real handlers, every list row live
    buildSim(n, scope, depth) {
      const ctx = this.simCtx(scope);
      const raw = n.attrs || {};
      const cond = raw["visible-if"] ?? raw.if;
      if (cond != null && !truthy(jseEval(cond, ctx))) return document.createComment("if");

      const a = {};
      for (const [k, v] of Object.entries(raw)) {
        a[k] = typeof v === "string" && hasMustache(v)
          ? v.replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => { const r = jseEval(e, ctx); return r == null ? "" : String(r); })
          : v;
      }

      const el = document.createElement("div");
      el.className = "sc-node " + n.tag + (depth === 0 ? " sc-root" : "");
      this.applyFrame(el, a); if (a.pin) el.dataset.pin = a.pin;
      if (raw.show != null && !truthy(jseEval(raw.show, ctx))) el.style.visibility = "hidden";
      if (raw["on:tap"]) {
        el.classList.add("sc-tap");
        // engine: in a list row, $this = the tapped row's item (with .index)
        el.addEventListener("click", (ev) => { ev.stopPropagation(); this.runHandler(raw["on:tap"], scope, n, scope.item); });
      }

      if (isComponent(n.tag)) {
        if (depth < 16) {
          const tpl = this.components[n.tag];
          // host = whoever placed the instance: dsx.event('x') inside the
          // template runs the instance's on:x handler in THIS scope
          if (tpl) el.appendChild(this.buildSim(tpl, { ...scope, attrs: a, host: { node: n, scope } }, depth + 1));
          else this.buildEmbed(el, n);
        }
        return el;
      }

      if (CONTAINERS.has(n.tag)) {
        if (!el.style.gap) el.style.gap = (a.spacing ?? GAP[n.tag] ?? 0) + "px";
        if (n.tag === "grid") { el.style.display = "grid"; el.style.gridTemplateColumns = "repeat(" + Math.max(1, +(a.columns ?? 3) || 3) + ", 1fr)"; }
        if (a.align) {
          const map = rowy(n.tag, a.style)
            ? { top: "flex-start", center: "center", bottom: "flex-end" }
            : { leading: "flex-start", center: "center", trailing: "flex-end" };
          el.style.alignItems = map[a.align] || "";
        }
        const template = (n.children || [])[0];
        if ((n.tag === "list" || n.tag === "grid") && raw.bind != null && template) {
          let rows = asRows(jseEval(raw.bind, ctx));
          if (raw.where != null) rows = rows.filter((r) => truthy(jseEval(raw.where, this.simCtx({ ...scope, item: r }))));
          rows.forEach((r, i) => {
            if (r != null && typeof r === "object" && r.index === undefined) r.index = i;   // $this.index
            el.appendChild(this.buildSim(template, { ...scope, item: r }, depth + 1));
          });
          return el;
        }
        (n.children || []).forEach((c) => el.appendChild(this.buildSim(c, scope, depth + 1)));
        return el;
      }

      // textfields are live inputs: typing writes through the binding (state
      // updates per keystroke; the screen re-renders when the field blurs)
      if (n.tag === "textfield") {
        el.classList.add("sc-leaf-textfield");
        const cur = raw.bind != null ? jseEval(raw.bind, ctx) : null;
        const ph = a.placeholder || "Text field";
        const has = cur != null && String(cur) !== "";
        el.textContent = has ? String(cur) : ph;
        el.classList.toggle("sc-ph", !has);
        if (raw.bind != null) {
          el.classList.add("sc-input-live");
          try { el.contentEditable = "plaintext-only"; } catch (_) { el.contentEditable = "true"; }
          el.addEventListener("focus", () => {
            if (el.classList.contains("sc-ph")) { el.textContent = ""; el.classList.remove("sc-ph"); }
          });
          el.addEventListener("input", () => {
            const text = el.textContent;
            jseRun(raw.bind + " = " + JSON.stringify(text), this.simCtx({ ...scope, self: text }));
            if (raw["on:change"]) jseRun(raw["on:change"], this.simCtx({ ...scope, self: text }));
          });
          el.addEventListener("blur", () => {
            this.emit("action", { id: n.id, expr: raw.bind + " = (input)", state: this.getState() });
            this.renderSim();
          });
          el.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") {
              ev.preventDefault();
              if (raw["on:submit"]) jseRun(raw["on:submit"], this.simCtx({ ...scope, self: el.textContent }));
              el.blur();
            }
          });
        }
        return el;
      }

      if (n.tag === "segmented") {
        el.classList.add("sc-leaf-segmented");
        const opts = String(a.options ?? "A,B").split(",").map((s) => s.trim()).filter(Boolean);
        const cur = raw.bind != null ? jseEval(raw.bind, ctx) : opts[0];
        for (const o of opts) {
          const seg = document.createElement("span");
          seg.className = "sc-seg" + (String(cur) === o ? " sc-on" : "");
          seg.textContent = o;
          if (raw.bind != null) {
            seg.classList.add("sc-tap");
            seg.addEventListener("click", (ev) => {
              ev.stopPropagation();
              jseRun(raw.bind + " = " + JSON.stringify(o), this.simCtx(scope));
              if (raw["on:change"]) jseRun(raw["on:change"], this.simCtx({ ...scope, self: o }));
              this.emit("action", { id: n.id, expr: `${raw.bind} = '${o}'`, state: this.getState() });
              this.renderSim();
            });
          }
          el.appendChild(seg);
        }
        return el;
      }

      // other leaves: bound values come from the LIVE state
      if (raw.bind != null) {
        const v = jseEval(raw.bind, ctx);
        const key = n.tag === "button" ? "label" : "value";
        if (n.tag !== "toggle") a[key] = v == null ? "" : String(v);
      }
      if (n.tag === "toggle") {
        const on = raw.bind != null ? truthy(jseEval(raw.bind, ctx)) : true;
        el.classList.add("sc-leaf-toggle");
        if (!on) el.classList.add("sc-off");
        if (raw.bind != null) {
          el.classList.add("sc-tap");
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            jseRun(`${raw.bind} = !(${raw.bind})`, this.simCtx(scope));
            if (raw["on:change"]) jseRun(raw["on:change"], this.simCtx({ ...scope, self: !on }));
            this.emit("action", { id: n.id, expr: `${raw.bind} = ${!on}`, state: this.getState() });
            this.renderSim();
          });
        }
        return el;
      }
      this.buildLeaf(el, n, a, {}, scope);
      return el;
    }
    repaint() {
      if (this.preview && this.sim) this.renderSim();
      else this.render();
    }
    setData(data) {
      this.data = data || {};
      this._dstate = null;
      if (this.tree) { this.repaint(); this.updateChrome(); }
      this.emit("data", { data: this.data });
    }
    // accepts friendly keys too: { attribute, this } → { attrs, self }
    static normScope(s) {
      if (!s) return {};
      const out = {};
      if (s.attrs !== undefined || s.attribute !== undefined) out.attrs = s.attrs ?? s.attribute;
      if (s.item !== undefined) out.item = s.item;
      if (s.self !== undefined || s["this"] !== undefined) out.self = s.self ?? s["this"];
      return out;
    }
    setScope(scope) {
      this.scope = StackCanvas.normScope(scope);
      if (this.tree) { this.repaint(); this.updateChrome(); }
      this.emit("scope", { scope: this.scope });
    }
    getScope() { return { ...this.scope }; }

    // The style manifest for a node: a JSON description of every control the
    // host's inspector should render — types, ranges, options, swatches, and
    // current values. The SDK knows DSX; the host only knows how to draw
    // knobs. Render generically from this and the panel works for any tag.
    static ATTR_LABELS = {
      value: "Text", label: "Label", placeholder: "Placeholder", icon: "Icon",
      iconSize: "Icon size", src: "Source", url: "URL", options: "Options",
      key: "Row key", min: "Min", max: "Max", step: "Step", surface: "Surface",
      "visible-if": "Visible if", transition: "Transition", bind: "Bind", where: "Filter",
    };
    friendlyAttr(k) {
      const known = StackCanvas.ATTR_LABELS[k];
      if (known) return known;
      return k
        .replace(/^arg:/, "Arg · ")
        .replace(/-/g, " ")
        .replace(/([a-z])([A-Z])/g, (m, l, u) => l + " " + u.toLowerCase())
        .replace(/^./, (c) => c.toUpperCase());
    }
    describe(id) {
      const node = this.nodeOf(id);
      if (!node) return null;
      const a = node.attrs || {};
      const tag = node.tag;
      const comp = isComponent(tag);
      const container = CONTAINERS.has(tag) && !comp;
      const textish = ["text", "button", "textfield"].includes(tag);
      const num = (key, label, o = {}) =>
        ({ type: "number", key, label, min: 0, max: 64, step: 1, unit: "pt", value: a[key] ?? null, ...o });
      const seg = (key, label, options, value) => ({ type: "segment", key, label, options, value });
      const groups = [];

      if (container) {
        const fields = [];
        if (tag === "vstack" || tag === "hstack" || tag === "zstack") {
          fields.push(seg("__tag", "Direction", [
            { v: "vstack", label: "↓", title: "Column" },
            { v: "hstack", label: "→", title: "Row" },
            { v: "zstack", label: "▣", title: "Overlay" },
          ], tag));
        }
        fields.push(
          seg("align", "Align", [
            { v: null, label: "⊢", title: "Leading" },
            { v: "center", label: "⊣⊢", title: "Center" },
            { v: "trailing", label: "⊣", title: "Trailing" },
          ], a.align ?? null),
          num("spacing", "Gap"),
        );
        groups.push({ id: "layout", label: "Layout", fields });
      }
      if (comp) {
        // component attributes are PROPS: free-form values the template reads
        // through dsx.attribute.<name>. The manifest lists them as editable rows
        // and flags the group freeform so hosts render an add-property row.
        const fields = Object.entries(a)
          .filter(([k]) => !k.startsWith("on:"))
          .map(([k, v]) => ({ type: "prop", key: k, label: this.friendlyAttr(k), value: v }));
        groups.push({ id: "props", label: "Properties", freeform: true, fields });
        return {
          id, tag, name: tag, kind: "comp", contentKey: null, groups,
        };
      }
      if (tag !== "divider" && tag !== "spacer") {
        groups.push({ id: "spacing", label: "Spacing", fields: [
          num("padding", "All"), num("paddingH", "Horizontal"), num("paddingV", "Vertical"),
        ]});
      }
      const r = this.rectOf(id);
      const measured = r ? { w: Math.round(r.w / this.zoom), h: Math.round(r.h / this.zoom) } : null;
      groups.push({ id: "size", label: "Size", fields: [
        { type: "size", key: "width", label: "Width", value: a.width ?? null, min: 1, max: 390, unit: "pt", measured: Math.min(390, measured?.w || 100) },
        { type: "size", key: "height", label: "Height", value: a.height ?? null, min: 1, max: 800, unit: "pt", measured: Math.min(800, measured?.h || 44) },
        seg("grow", "Grow", [
          { v: null, label: "–", title: "None" },
          { v: "width", label: "W", title: "Fill the parent's width" },
          { v: "height", label: "H", title: "Fill the parent's height" },
          { v: "true", label: "Both", title: "Fill both axes" },
        ], a.grow === true ? "true" : a.grow ?? null),
      ]});
      if (!comp) {
        groups.push({ id: "style", label: "Style", fields: [
          { type: "color", key: "background", label: "Fill", value: a.background ?? null, options: [
            { v: null, label: "None", swatch: "transparent" },
            { v: "accent", label: "Accent", swatch: "#146ef5" },
            { v: "rgba(255,255,255,0.06)", label: "Subtle", swatch: "#2a2a2e" },
            { v: "rgba(255,255,255,0.12)", label: "Soft", swatch: "#3a3a40" },
            { v: "rgba(0,0,0,0.35)", label: "Dim", swatch: "#0d0d10" },
          ]},
          { type: "select", key: "surface", label: "Surface", value: a.surface ?? null, options: [
            { v: null, label: "None" }, { v: "glass", label: "Glass" }, { v: "thin", label: "Thin" },
            { v: "regular", label: "Regular" }, { v: "thick", label: "Thick" }, { v: "sheet", label: "Sheet" },
          ]},
          num("radius", "Radius", { max: 40 }),
          { type: "slider", key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.05, value: a.opacity ?? 1 },
        ]});
      }
      if (textish) {
        groups.push({ id: "type", label: "Typography", fields: [
          num("fontSize", "Size", { min: 8, max: 64 }),
          seg("fontWeight", "Weight", [
            { v: null, label: "Aa", title: "Regular" },
            { v: "medium", label: "Aa", title: "Medium" },
            { v: "semibold", label: "Aa", title: "Semibold" },
            { v: "bold", label: "Aa", title: "Bold" },
          ], a.fontWeight ?? null),
          { type: "color", key: "color", label: "Color", value: a.color ?? null, options: [
            { v: null, label: "Primary", swatch: "#f2f2f2" },
            { v: "secondary", label: "Secondary", swatch: "#9a9a9a" },
            { v: "accent", label: "Accent", swatch: "#146ef5" },
          ]},
        ]});
      }
      if (tag === "slider") {
        groups.push({ id: "range", label: "Range", fields: [
          num("min", "Min", { min: 0, max: 1000, value: a.min ?? 0 }),
          num("max", "Max", { min: 0, max: 1000, value: a.max ?? 1 }),
        ]});
      }
      if (tag === "progress") {
        groups.push({ id: "progress", label: "Progress", fields: [
          { type: "slider", key: "value", label: "Value", min: 0, max: 1, step: 0.05, value: +(a.value ?? 0.6) || 0 },
        ]});
      }
      if (tag === "image") {
        groups.push({ id: "image", label: "Image", fields: [
          { type: "prop", key: "src", label: "Source", value: a.src ?? "" },
          num("iconSize", "Icon size", { min: 12, max: 96 }),
        ]});
      }
      const contentKey = textish ? (tag === "button" ? "label" : tag === "textfield" ? "placeholder" : "value") : null;
      // anything no knob covers surfaces as a named, editable attribute —
      // engine attrs like options/min/max/key/visible-if, or anything custom
      const covered = new Set([contentKey, "bind", "where", "grow"]);
      for (const g of groups) for (const f of g.fields) covered.add(f.key);
      const extras = Object.entries(a)
        .filter(([k]) => !k.startsWith("on:") && !covered.has(k))
        .map(([k, v]) => ({ type: "prop", key: k, label: this.friendlyAttr(k), value: v }));
      groups.push({ id: "attrs", label: "Attributes", freeform: true, fields: extras });
      return {
        id, tag, name: comp ? tag : friendly(tag),
        kind: comp ? "comp" : this.isRepeater(node) || tag === "list" ? "grp" : (a.bind != null || a.where != null) ? "data" : "el",
        repeats: tag === "list",
        bindable: tag === "list" || !CONTAINERS.has(tag),
        contentKey,
        groups,
      };
    }

    // retag within the stack family — the inspector's Direction control
    setTag(id, tag) {
      const node = this.nodeOf(id);
      if (!node || !["vstack", "hstack", "zstack"].includes(tag) || !["vstack", "hstack", "zstack"].includes(node.tag)) return false;
      if (node.tag === tag) return true;
      const play = this.flipStart();
      node.tag = tag;
      this.repaint();
      play();
      this.updateChrome();
      if (this.selIds.has(id)) this.setSelection([...this.selIds], this.sel, "api");   // refresh host panels
      this.emit("change", { tree: this.getTree() });
      return true;
    }

    // Patch a node's attrs from the host (inspector panels, AI edits, file sync).
    // Pass null as a value to delete that key. One FLIP, one change event.
    updateNode(id, patch) {
      const n = this.nodeOf(id);
      if (!n || !patch) return;
      n.attrs = { ...(n.attrs || {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete n.attrs[k];
        else n.attrs[k] = v;
      }
      const play = this.flipStart();                // FLIP survives the re-render: keyed by id
      this.repaint();
      play();
      this.updateChrome();
      this.emit("change", { tree: this.getTree() });
    }
    // dynamic/event introspection (the chip badges and select payload use these)
    nodeBindings(n) {
      const out = [];
      for (const [k, v] of Object.entries(n?.attrs || {})) {
        if (k === "bind" || k === "where" || hasMustache(v)) out.push(k);
      }
      return out;
    }
    nodeEvents(n) {
      return Object.keys(n?.attrs || {}).filter((k) => k.startsWith("on:")).map((k) => k.slice(3));
    }
    select(id, via = "api") { this.setSelection(id ? [id] : [], id || null, via); }
    hover(id) {
      if (this.preview || this.drag?.active) return;
      this.hov = id && this.nodeOf(id) ? id : null;
      this.updateChrome();
    }
    // scrollIntoView is poison here: it scrolls EVERY scrollable ancestor,
    // including the transform-panned viewport, desyncing pointer math from
    // pixels. Only the phone content is a legitimate scroller.
    revealInScreen(id) {
      const el = this.els.get(id);
      if (!el || !this.screen) return;
      const sr = this.screen.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const pad = Math.min(24 * this.zoom, sr.height / 4);
      let delta = 0;
      if (r.top < sr.top + pad) delta = (r.top - (sr.top + pad)) / this.zoom;
      else if (r.bottom > sr.bottom - pad) delta = (Math.min(r.bottom, r.top + sr.height) - (sr.bottom - pad)) / this.zoom;
      if (delta) { this.screen.scrollTop += delta; this.updateChrome(); }
    }
    setSelection(ids, primary, via = "api") {
      const clean = ids.filter((id) => this.nodeOf(id));
      const next = new Set(clean);
      const nextPrimary = primary && next.has(primary) ? primary : clean[clean.length - 1] || null;
      const same = nextPrimary === this.sel && next.size === this.selIds.size &&
        [...next].every((id) => this.selIds.has(id));
      if (same) return;
      this.selIds = next;
      this.sel = nextPrimary;
      if (nextPrimary && (via === "keyboard" || via === "enter" || via === "climb" || via === "drill")) {
        this.revealInScreen(nextPrimary);
      }
      this.selBox.classList.remove("sc-pop");
      void this.selBox.offsetWidth;
      this.selBox.classList.add("sc-pop");
      this.updateChrome();
      if (this.sel) {
        const n = this.nodeOf(this.sel);
        const r = this.rectOf(this.sel);
        this.emit("select", {
          id: this.sel, ids: [...this.selIds], tag: n?.tag, via,
          path: this.chainOf(this.sel).map((p) => ({ id: p.id, tag: p.tag })),
          attrs: { ...(n?.attrs || {}) },
          accepts: this.accepts(n),
          bindings: this.nodeBindings(n),
          events: this.nodeEvents(n),
          size: r ? { w: Math.round(r.w / this.zoom), h: Math.round(r.h / this.zoom) } : null,
        });
      } else this.emit("deselect", {});
    }

    // Clicks select the DEEPEST element under the cursor — exactly what the
    // z-order says you're pointing at. Ancestors are one Esc / ← / tag-chip away.
    // The hover preview and pointerdown share this resolver, so the highlight is
    // always exactly the click result.
    resolveTarget(deepest) {
      return this.nodeOf(deepest) ? deepest : null;
    }
    destroy() {
      this.cancelDrag();
      if (this._vraf) cancelAnimationFrame(this._vraf);
      clearTimeout(this._viewT);
      clearTimeout(this._scrollT);
      window.removeEventListener("resize", this._onResize);
      this.ghost.remove();
      this.vp.classList.remove("sc-viewport", "sc-space", "sc-panning", "sc-dragging");
      this.vp.textContent = "";
      this.els.clear();
      this.listeners.clear();
    }

    /* ── frame + render ───────────────────────────────────────────────────── */
    buildFrame() {
      // frame: false → a plain board that hugs content, no phone mockup,
      // no statusbar, no internal scroll
      if (this.frameless) {
        this.phone = document.createElement("div");
        this.phone.className = "sc-board";
        this.screen = this.phone;
        this.world.appendChild(this.phone);
        return;
      }
      this.phone = document.createElement("div");
      this.phone.className = "sc-phone";
      this.phone.innerHTML = `
        <div class="sc-island"></div>
        <div class="sc-screen">
          <div class="sc-statusbar">
            <span class="sc-sb-time">9:41</span>
            <span class="sc-sb-icons">${STATUSBAR_SVG}</span>
          </div>
          <div class="sc-content"></div>
          <div class="sc-home"></div>
        </div>`;
      this.screen = this.phone.querySelector(".sc-content");
      this.world.appendChild(this.phone);
    }

    render() {
      this.els.clear();
      this.screen.textContent = "";
      this.screen.appendChild(this.buildEl(this.tree, 0, { ...this.scope }));
    }

    // design-time evaluation: the SAME JSE interpreter the simulator runs, but
    // read-only over the sample data — no assignments, no dsx.event/dsx.module calls
    designCtx(scope) {
      const data = this.designState();
      const ctx = {
        jseScope: { vars: data, item: scope.item, attrs: scope.attrs, platform: "ios" },
        rootValue(name) {
          if (name === "dsx") return dsxData(scope, data);
          if (name === "os" || name === "platform") return "ios";
          if (scope.item  && typeof scope.item  === "object" && name in scope.item)  return scope.item[name];
          if (scope.attrs && typeof scope.attrs === "object" && name in scope.attrs) return scope.attrs[name];
          if (data && name in data) return data[name];
          return undefined;
        },
        moduleContext(scheme) { return ((data.moduleContext ??= {})[scheme] ??= {}); },
        rootContainer() { return null; },   // design data is read-only
        rootSlot() { return null; },
        callFn(fn, args, selfVal) {
          // same chain discipline as simCtx: params → dsx via the self-updated
          // inner ctx → everything else via the ARRIVING ctx, so nested arrows
          // keep their enclosing params at design time too.
          const outer = this;
          const params = {};
          (fn.params || []).forEach((pn, i) => { params[pn] = args[i]; });
          const inner = self.designCtx(selfVal === undefined ? scope : { ...scope, self: selfVal });
          return runArrow(fn, {
            ...inner,
            rootValue: (nm) => (nm in params ? params[nm] : nm === "dsx" ? inner.rootValue(nm) : outer.rootValue(nm)),
          });
        },
        call() { return undefined; },
      };
      const self = this;
      return ctx;
    }
    evalIn(expr, scope) { return jseEval(expr, this.designCtx(scope)); }

    // resolve {{ }} in attr values against the current scope for display
    resolveAttrs(a, scope) {
      const out = {};
      for (const [k, v] of Object.entries(a)) {
        out[k] = typeof v === "string" && hasMustache(v)
          ? v.replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => { const r = this.evalIn(e, scope); return r == null ? m : String(r); })
          : v;
      }
      return out;
    }

    buildEl(n, depth, scope = {}) {
      const el = document.createElement("div");
      el.dataset.id = n.id;
      el.className = "sc-node " + n.tag + (depth === 0 ? " sc-root" : "");
      this.els.set(n.id, el);
      const raw = n.attrs || {};
      const a = this.resolveAttrs(raw, scope);
      this.applyFrame(el, a); if (a.pin) el.dataset.pin = a.pin;

      if (isComponent(n.tag)) {
        const tpl = this.components[n.tag];
        if (tpl) {
          el.classList.add("sc-comp-instance");
          el.appendChild(this.buildPreview(tpl, 0, { ...scope, attrs: a }));   // props → dsx.attribute.*
        } else {
          this.buildEmbed(el, n);
        }
        return el;
      }

      if (CONTAINERS.has(n.tag)) {
        if (!el.style.gap) el.style.gap = (a.spacing ?? GAP[n.tag] ?? 0) + "px";
        if (n.tag === "grid") { el.style.display = "grid"; el.style.gridTemplateColumns = "repeat(" + Math.max(1, +(a.columns ?? 3) || 3) + ", 1fr)"; }
        if (a.align) {
          const map = rowy(n.tag, a.style)
            ? { top: "flex-start", center: "center", bottom: "flex-end" }
            : { leading: "flex-start", center: "center", trailing: "flex-end" };
          el.style.alignItems = map[a.align] || "";
        }
        // a data-bound list: the first child is the row TEMPLATE. It renders once
        // bound to row 0 (live, editable), then every further sample row renders
        // as a dimmed inert preview — the Webflow collection-list pattern.
        let rows = this.isRepeater(n) ? asRows(this.evalIn(raw.bind, scope)) : null;
        if (rows && raw.where != null) rows = rows.filter((r) => truthy(this.evalIn(raw.where, { ...scope, item: r })));
        const template = (n.children || [])[0];
        if (rows && template) {
          el.appendChild(this.buildEl(template, depth + 1, { ...scope, item: rows[0] || {} }));
          rows.slice(1, 12).forEach((r) => {
            const ghost = this.buildPreview(template, 0, { ...scope, item: r });
            ghost.classList.add("sc-row-ghost");
            el.appendChild(ghost);
          });
          return el;
        }
        if (this.isRepeater(n) && !(n.children || []).length) {
          el.appendChild(this.emptyHint("list"));   // no repeating item yet: invite one in
          return el;
        }
        (n.children || []).forEach((c) => el.appendChild(this.buildEl(c, depth + 1, scope)));
        if (!(n.children || []).length) el.appendChild(this.emptyHint());
        return el;
      }
      this.buildLeaf(el, n, a, raw, scope);
      return el;
    }

    // Render a component template READ-ONLY: same flex semantics and leaf looks,
    // but no data-ids — hit-testing resolves to the instance, never inside it.
    buildPreview(n, depth, scope = {}) {
      const el = document.createElement("div");
      el.className = "sc-node " + n.tag;
      const raw = n.attrs || {};
      const a = this.resolveAttrs(raw, scope);
      this.applyFrame(el, a); if (a.pin) el.dataset.pin = a.pin;
      if (isComponent(n.tag)) {
        if (depth < 16) {
          const tpl = this.components[n.tag];
          if (tpl) { el.classList.add("sc-comp-instance"); el.appendChild(this.buildPreview(tpl, depth + 1, { ...scope, attrs: a })); }
          else this.buildEmbed(el, n);
        }
        return el;
      }
      if (CONTAINERS.has(n.tag)) {
        if (!el.style.gap) el.style.gap = (a.spacing ?? GAP[n.tag] ?? 0) + "px";
        if (n.tag === "grid") { el.style.display = "grid"; el.style.gridTemplateColumns = "repeat(" + Math.max(1, +(a.columns ?? 3) || 3) + ", 1fr)"; }
        if (a.align) {
          const map = rowy(n.tag, a.style)
            ? { top: "flex-start", center: "center", bottom: "flex-end" }
            : { leading: "flex-start", center: "center", trailing: "flex-end" };
          el.style.alignItems = map[a.align] || "";
        }
        let rows = this.isRepeater(n) ? asRows(this.evalIn(raw.bind, scope)) : null;
        if (rows && raw.where != null) rows = rows.filter((r) => truthy(this.evalIn(raw.where, { ...scope, item: r })));
        const template = (n.children || [])[0];
        if (rows && template) {
          rows.slice(0, 12).forEach((r) => el.appendChild(this.buildPreview(template, depth + 1, { ...scope, item: r })));
          return el;
        }
        (n.children || []).forEach((c) => el.appendChild(this.buildPreview(c, depth + 1, scope)));
        return el;
      }
      this.buildLeaf(el, n, a, raw, scope);
      return el;
    }

    // Native component (no XML template): the embed-block placeholder.
    buildEmbed(el, n) {
      el.classList.add("sc-leaf-embed");
      el.innerHTML = `
        <span class="sc-embed-icon">${icon("alert", 15)}</span>
        <span class="sc-embed-text"><b>${n.tag}</b> is a component that requires native code or packages that only work on real devices.</span>`;
    }

    emptyHint(kind) {
      const h = document.createElement("div");
      h.className = "sc-empty";
      h.textContent = kind === "list"
        ? "Drag an element here. It becomes the repeating item."
        : "Drop here";
      return h;
    }

    // The drag/hit-test axis of a container: hstack always; a generic stack (or
    // pressable) reads its LIVE computed flex-direction — bound values included.
    isRowContainer(n) {
      if (!n) return false;
      if (n.tag === "hstack") return true;
      const el = this.els.get(n.id);
      if (!el || !el.isConnected) return rowy(n.tag, (n.attrs || {}).style);
      return getComputedStyle(el).flexDirection.startsWith("row");
    }

    applyFrame(el, a, tag) {
      const px = (v) => v + "px";
      // style="prop: value; …" — the MODERN inline-CSS form (the same style attribute
      // the runtimes compile): declarations apply verbatim, CSS decides. Runs FIRST so
      // the typed legacy attrs keep their precedence, except gap/axis which the
      // container branch only defaults when the sheet left them unset. Color-valued
      // properties resolve semantic words (secondary, tertiary, …) like every other
      // color on the canvas. Token-form style="title muted" has no ":" and skips.
      if (a.style && String(a.style).includes(":")) {
        for (const decl of String(a.style).split(";")) {
          const i = decl.indexOf(":");
          if (i < 0) continue;
          const prop = decl.slice(0, i).trim();
          let val = decl.slice(i + 1).trim();
          if (!prop || !val) continue;
          if (/(^|-)color$/.test(prop) || prop === "background") { const c = cssColor(val); if (c != null) val = c; }
          el.style.setProperty(prop, val);
        }
      }
      // padding: all-sides, per-axis, per-edge (production parity)
      if (a.padding != null) el.style.padding = px(a.padding);
      if (a.paddingH != null || a.paddingX != null) el.style.paddingLeft = el.style.paddingRight = px(a.paddingH ?? a.paddingX);
      if (a.paddingV != null || a.paddingY != null) el.style.paddingTop = el.style.paddingBottom = px(a.paddingV ?? a.paddingY);
      if (a.paddingTop != null) el.style.paddingTop = px(a.paddingTop);
      if (a.paddingBottom != null) el.style.paddingBottom = px(a.paddingBottom);
      if (a.paddingLeading != null || a.paddingLeft != null) el.style.paddingLeft = px(a.paddingLeading ?? a.paddingLeft);
      if (a.paddingTrailing != null || a.paddingRight != null) el.style.paddingRight = px(a.paddingTrailing ?? a.paddingRight);

      if (a.direction === "horizontal") { el.style.flexDirection = "row"; el.style.alignItems = "center"; }

      // frame: width/height (number | fit), min/max
      const isFit = (v) => v === "fit" || v === "fit-content";
      if (a.width != null && !isFit(a.width)) el.style.width = px(a.width);
      if (a.height != null && !isFit(a.height)) el.style.height = px(a.height);
      if (isFit(a.width)) el.style.width = "fit-content";
      if (isFit(a.height)) el.style.height = "fit-content";
      if (a.minWidth != null) el.style.minWidth = px(a.minWidth);
      if (a.maxWidth != null) el.style.maxWidth = px(a.maxWidth);
      if (a.minHeight != null) el.style.minHeight = px(a.minHeight);
      if (a.maxHeight != null) el.style.maxHeight = px(a.maxHeight);

      if (a.fontDesign) {
        const fd = { rounded: "ui-rounded, system-ui", serif: "ui-serif, Georgia, serif", monospaced: "ui-monospace, monospace", mono: "ui-monospace, monospace" };
        if (fd[a.fontDesign]) el.style.fontFamily = fd[a.fontDesign];
      }

      // grow: fill the parent along an axis (parent-aware classes)
      const g = a.grow === true ? "true" : a.grow;
      if (g === "true" || g === "both") el.classList.add("sc-grow-both");
      else if (g === "width") el.classList.add("sc-grow-w");
      else if (g === "height") el.classList.add("sc-grow-h");

      // fills: background then surface then gradient (production layering)
      if (a.background) el.style.background = cssColor(a.background);
      if (a.surface) {
        const tiers = { glass: [0.10, 20], ultraThin: [0.10, 20], thin: [0.06, 12], regular: [0.10, 16], thick: [0.16, 24], sheet: [0.12, 28] };
        const t = tiers[a.surface] || tiers.regular;
        el.style.background = "rgba(255,255,255," + t[0] + ")";
        el.style.backdropFilter = el.style.webkitBackdropFilter = "blur(" + t[1] + "px) saturate(1.4)";
      }
      if (a.gradient) {
        const cols = String(a.gradient).split("|").map(cssColor);
        if (cols.length >= 2) {
          const dir = { horizontal: "to right", diagonal: "to bottom right" }[a.gradientDir] || "to bottom";
          const grad = "linear-gradient(" + dir + ", " + cols.join(", ") + ")";
          el.style.background = (a.background || a.surface) ? grad + ", " + el.style.background : grad;
        }
      }

      // radius (rounds fills, clips children) then aspect then opacity
      if (a.radius != null) { el.style.borderRadius = px(a.radius); if (!el.style.overflow) el.style.overflow = "hidden"; }
      if (a.aspectRatio != null) {
        const r = String(a.aspectRatio).includes(":") ? String(a.aspectRatio).split(":").map(Number) : [+a.aspectRatio, 1];
        if (r[1]) el.style.aspectRatio = r[0] + " / " + r[1];
      }
      if (a.opacity != null) el.style.opacity = a.opacity;

      // transforms compose into one string: offset then rotation then scale
      const tf = [];
      const ox = a.offsetX != null ? +a.offsetX : 0;
      const oy = a.offsetY != null ? +a.offsetY : (a.offset != null ? +a.offset : 0);
      if (ox || oy) tf.push("translate(" + ox + "px, " + oy + "px)");
      if (a.rotation != null) tf.push("rotate(" + a.rotation + "deg)");
      if (a.scale != null) tf.push("scale(" + a.scale + ")");
      if (tf.length) el.style.transform = tf.join(" ");
      if (a.blur != null) el.style.filter = "blur(" + a.blur + "px)";

      // border, shadow, zIndex
      if (a.borderColor) el.style.border = (a.borderWidth ?? 1) + "px solid " + cssColor(a.borderColor);
      if (a.shadow != null) {
        const sc = a.shadowColor ? cssColor(a.shadowColor) : "rgba(0,0,0,0.25)";
        el.style.boxShadow = (a.shadowX ?? 0) + "px " + (a.shadowY ?? 2) + "px " + a.shadow + "px " + sc;
      }
      if (a.zIndex != null) el.style.zIndex = a.zIndex;
    }

    // text-only styling (italic/underline/tracking/lineLimit/align/case) - production parity
    applyTextStyle(el, a) {
      if (a.italic === true || a.italic === "true") el.style.fontStyle = "italic";
      const deco = [];
      if (a.underline === true || a.underline === "true") deco.push("underline");
      if (a.strikethrough === true || a.strikethrough === "true") deco.push("line-through");
      if (deco.length) el.style.textDecoration = deco.join(" ");
      if (a.tracking != null) el.style.letterSpacing = a.tracking + "px";
      if (a.lineSpacing != null) el.style.lineHeight = "calc(1em + " + a.lineSpacing + "px)";
      if (a.lineLimit != null) {
        el.style.display = "-webkit-box";
        el.style.webkitLineClamp = String(a.lineLimit);
        el.style.webkitBoxOrient = "vertical";
        el.style.overflow = "hidden";
      }
      if (a.textAlign) el.style.textAlign = { center: "center", trailing: "right", right: "right", leading: "left" }[a.textAlign] || "left";
      if (a.textCase) el.style.textTransform = a.textCase === "upper" ? "uppercase" : a.textCase === "lower" ? "lowercase" : "none";
    }

    // a bound display value: bind="path" wins, else {{ }} (already interpolated).
    // returns [text, isDynamic]
    boundText(rawVal, resolvedVal, bindExpr, scope) {
      if (bindExpr != null) {
        const v = this.evalIn(bindExpr, scope);
        return [v == null ? String(bindExpr) : String(v), true];
      }
      return [resolvedVal, hasMustache(rawVal)];
    }
    buildLeaf(el, n, a, raw = a, scope = {}) {
      if (raw.bind != null || hasMustache(raw.value ?? raw.label ?? raw.placeholder)) el.classList.add("sc-bound");
      const color = a.color ? cssColor(a.color) : "#fff";
      switch (n.tag) {
        case "text": {
          el.classList.add("sc-leaf-text");
          const [txt] = this.boundText(raw.value, a.value, raw.bind, scope);
          el.textContent = txt ?? "Text";
          if (a.fontSize) el.style.fontSize = a.fontSize + "px";
          el.style.fontWeight = WEIGHTS[a.fontWeight] || 400;
          el.style.color = color;
          this.applyTextStyle(el, a);
          break;
        }
        case "button": {
          el.classList.add("sc-leaf-button");
          const [txt] = this.boundText(raw.label, a.label, raw.bind, scope);
          el.textContent = txt ?? "Button";
          if (a.background) el.style.background = cssColor(a.background);
          if (a.fontSize) el.style.fontSize = a.fontSize + "px";
          if (a.paddingV != null) { el.style.paddingTop = el.style.paddingBottom = a.paddingV + "px"; }
          el.style.color = color;
          break;
        }
        case "image": {
          el.classList.add("sc-leaf-image");
          const imgSrc = a.src || a.url;
          if (imgSrc) {
            // a real bitmap fills its frame; the frame's size comes from
            // width/height/grow like any element (natural aspect when free)
            el.classList.add("sc-img");
            if (a.height == null) el.classList.add("sc-auto-h");
            const im = document.createElement("img");
            im.src = imgSrc;
            im.alt = "";
            im.draggable = false;
            el.appendChild(im);
          } else {
            el.classList.add("sc-icon");
            el.innerHTML = icon("image", 18);
            const s = +(a.iconSize || 0);
            if (s && a.width == null && a.grow == null) { el.style.width = el.style.height = (s + 16) + "px"; }
          }
          break;
        }
        case "toggle": {
          el.classList.add("sc-leaf-toggle");
          if (raw.bind != null && !truthy(this.evalIn(raw.bind, scope))) el.classList.add("sc-off");
          break;
        }
        case "textfield": {
          el.classList.add("sc-leaf-textfield");
          const [txt] = this.boundText(raw.placeholder, a.placeholder, raw.bind, scope);
          el.textContent = txt || "Text field";
          break;
        }
        case "glassButton": {
          el.classList.add("sc-leaf-glassbtn");
          el.innerHTML = icon(a.icon ? "flash" : "button", 16);
          break;
        }
        case "progress": {
          el.classList.add("sc-leaf-progress");
          const v = raw.bind != null ? num(this.evalIn(raw.bind, scope)) : num(a.value ?? 0.6);
          const fill = document.createElement("div");
          fill.className = "sc-progress-fill";
          fill.style.width = (Math.max(0, Math.min(1, v)) * 100) + "%";
          if (a.color) fill.style.background = cssColor(a.color);
          el.appendChild(fill);
          break;
        }
        case "spinner": el.classList.add("sc-leaf-spinner"); break;
        case "slider": {
          el.classList.add("sc-leaf-slider");
          const min = num(a.min ?? 0), max = num(a.max ?? 1);
          const v = raw.bind != null ? num(this.evalIn(raw.bind, scope)) : (min + max) / 2;
          const f = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0.5;
          el.innerHTML = `<div class="sc-slider-track"><div class="sc-slider-fill" style="width:${f * 100}%"></div></div><div class="sc-slider-thumb" style="left:calc(${f * 100}% - 11px)"></div>`;
          break;
        }
        case "segmented": {
          el.classList.add("sc-leaf-segmented");
          const opts = String(a.options ?? "A,B").split(",").map((s) => s.trim()).filter(Boolean);
          const cur = raw.bind != null ? this.evalIn(raw.bind, scope) : opts[0];
          for (const o of opts) {
            const seg = document.createElement("span");
            seg.className = "sc-seg" + (String(cur) === o ? " sc-on" : "");
            seg.textContent = o;
            el.appendChild(seg);
          }
          break;
        }
        case "divider": el.classList.add("sc-leaf-divider"); break;
        case "spacer": el.classList.add("sc-leaf-spacer"); break;
        default: { el.classList.add("sc-leaf-text"); el.textContent = "<" + n.tag + "/>"; }
      }
    }

    /* ── view transform — rAF-batched, GPU-composited ─────────────────────── */
    applyView() {
      if (this._vraf) return;                                  // coalesce to one update per frame
      this._vraf = requestAnimationFrame(() => { this._vraf = 0; this.applyViewNow(); });
    }
    applyViewNow() {
      this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
      const s = 24 * this.zoom;
      if (s !== this._gridS) {                                 // repaint the grid only on zoom change
        this._gridS = s;
        this.grid.style.backgroundSize = `${s}px ${s}px`;
        this.grid.style.inset = `-${Math.ceil(s)}px`;
      }
      const mx = ((this.pan.x % s) + s) % s, my = ((this.pan.y % s) + s) % s;
      this.grid.style.transform = `translate(${mx}px, ${my}px)`;   // pan = composite, no repaint
      if (this.zoomLabelEl) this.zoomLabelEl.textContent = Math.round(this.zoom * 100) + "%";
      this.updateChrome();
      clearTimeout(this._viewT);
      this._viewT = setTimeout(() => this.emit("view", { zoom: +this.zoom.toFixed(2), x: Math.round(this.pan.x), y: Math.round(this.pan.y) }), 150);
    }
    fit() {
      const vr = this.vp.getBoundingClientRect();
      const pw = this.phone.offsetWidth, ph = this.phone.offsetHeight;
      this.zoom = Math.max(0.15, Math.min((vr.width - 120) / pw, (vr.height - 96) / ph, 1));
      this.pan = { x: (vr.width - pw * this.zoom) / 2, y: (vr.height - ph * this.zoom) / 2 };
      this.applyViewNow();
    }
    view100() {
      const vr = this.vp.getBoundingClientRect();
      this.zoom = 1;
      this.pan = { x: (vr.width - this.phone.offsetWidth) / 2, y: Math.max(24, (vr.height - this.phone.offsetHeight) / 2) };
      this.applyViewNow();
    }
    zoomAt(factor, cx, cy) {
      const nz = Math.min(4, Math.max(0.15, this.zoom * factor));
      if (nz === this.zoom) return;
      this.pan = { x: cx - (cx - this.pan.x) * (nz / this.zoom), y: cy - (cy - this.pan.y) * (nz / this.zoom) };
      this.zoom = nz;
      this.applyView();
    }
    zoomAtCenter(factor) {
      const vr = this.vp.getBoundingClientRect();
      this.zoomAt(factor, vr.width / 2, vr.height / 2);
    }

    /* ── selection chrome (screen space) ──────────────────────────────────── */
    rectOf(id) {
      const el = id && this.els.get(id);
      if (!el || !el.isConnected) return null;
      const vr = this.vp.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - vr.left, y: r.top - vr.top, w: r.width, h: r.height };
    }
    place(box, r) {
      box.style.display = "block";
      const x = Math.round(r.x), y = Math.round(r.y);
      box.style.left = x + "px"; box.style.top = y + "px";
      box.style.width = Math.round(r.x + r.w) - x + "px";
      box.style.height = Math.round(r.y + r.h) - y + "px";
    }
    updateChrome() {
      const badge = (body, size) =>
        `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

      const hr = this.hov && !this.selIds.has(this.hov) && !this.drag?.active && !this.editing ? this.rectOf(this.hov) : null;
      if (hr) {
        this.place(this.hoverBox, hr);
        this.hoverBox.classList.toggle("sc-flip", hr.y < 22);
        const hn = this.nodeOf(this.hov);
        const hComp = isComponent(hn?.tag);
        const hItem = this.isTemplateRoot(this.hov);
        const hGrp = hn?.tag === "list" || this.isRepeater(hn) || hItem;
        this.hoverBox.classList.toggle("sc-comp", hComp);
        this.hoverBox.classList.toggle("sc-grp", hGrp);
        this.hoverBox.classList.toggle("sc-data", !hComp && !hGrp && this.nodeBindings(hn).length > 0);
        this.hoverLabel.textContent = hItem ? "List item" : friendly(hn?.tag || "");
        if (this.nodeEvents(hn).length) {
          this.hoverLabel.innerHTML += `<span class="sc-hoverflash">${badge(ICONS.flash, 8)}</span>`;
        }
      } else this.hoverBox.style.display = "none";

      // primary selection: full chrome (chip, handles, size)
      const sr = this.sel ? this.rectOf(this.sel) : null;
      if (sr) {
        this.place(this.selBox, sr);
        this.selBox.classList.toggle("sc-flip", sr.y < 24);
        // Figma-style readout: layout pt, not screen px
        this.sizeTag.textContent =
          Math.round(sr.w / this.zoom) + " × " + Math.round(sr.h / this.zoom);
        this.sizeTag.style.display = this.editing || this.selIds.size > 1 ? "none" : "";
        const n = this.nodeOf(this.sel);
        const sComp = isComponent(n?.tag);
        const sItem = this.isTemplateRoot(this.sel);
        const sGrp = n?.tag === "list" || this.isRepeater(n) || sItem;
        this.selBox.classList.toggle("sc-comp", sComp);
        this.selBox.classList.toggle("sc-grp", sGrp);
        this.selBox.classList.toggle("sc-data", !sComp && !sGrp && this.nodeBindings(n).length > 0);
        this.chipIcon.innerHTML = badge(isComponent(n?.tag) ? ICONS.cube : ICONS.code, 10);
        this.tagChip.querySelector(".sc-tagname").textContent =
          this.selIds.size > 1 ? `${this.selIds.size} selected` : sItem ? "List item" : friendly(n?.tag || "");
        // badges: a formula mark for bound data, a flash mark for wired actions
        const marks = [];
        if (this.nodeBindings(n).length) marks.push(badge(ICONS.fx, 9));
        if (this.nodeEvents(n).length) marks.push(badge(ICONS.flash, 9));
        let badges = this.tagChip.querySelector(".sc-chip-badges");
        if (marks.length) {
          if (!badges) {
            badges = document.createElement("span");
            badges.className = "sc-chip-badges";
            this.tagChip.appendChild(badges);
          }
          badges.innerHTML = marks.join("");
        } else badges?.remove();
      } else this.selBox.style.display = "none";

      if (this.editing && this.fxPanel.style.display !== "none") this.updateFxChip();

      this.drawMeasure(sr, hr);

      // additional selection: plain pooled boxes
      const extra = [...this.selIds].filter((id) => id !== this.sel);
      while (this.multiBoxes.length < extra.length) {
        const b = document.createElement("div");
        b.className = "sc-box sc-multi";
        this.overlay.appendChild(b);
        this.multiBoxes.push(b);
      }
      this.multiBoxes.forEach((b, i) => {
        const r = i < extra.length ? this.rectOf(extra[i]) : null;
        if (r) {
          this.place(b, r);
          const xn = this.nodeOf(extra[i]);
          const xComp = isComponent(xn?.tag);
          const xGrp = xn?.tag === "list" || this.isRepeater(xn) || this.isTemplateRoot(extra[i]);
          b.classList.toggle("sc-comp", xComp);
          b.classList.toggle("sc-grp", xGrp);
          b.classList.toggle("sc-data", !xComp && !xGrp && this.nodeBindings(xn).length > 0);
        } else b.style.display = "none";
      });
    }

    // hold Alt with a selection and hover anything: gap distances in pt.
    // Disjoint boxes get a line per separated axis; containment gets all
    // four inset distances.
    drawMeasure(a, b) {
      const host = this.measure;
      if (!host) return;
      if (!this.altDown || !a || !b || this.drag?.active || this.editing) { host.textContent = ""; return; }
      const pt = (px) => Math.round(px / this.zoom);
      const mid = (lo1, hi1, lo2, hi2) => {
        const lo = Math.max(lo1, lo2), hi = Math.min(hi1, hi2);
        return lo < hi ? (lo + hi) / 2 : (lo1 + hi1) / 2;
      };
      const lines = [];
      const hline = (x1, x2, y) => { if (x2 - x1 >= 1) lines.push({ x: x1, y, w: x2 - x1, h: 0, v: pt(x2 - x1) }); };
      const vline = (y1, y2, x) => { if (y2 - y1 >= 1) lines.push({ x, y: y1, w: 0, h: y2 - y1, v: pt(y2 - y1) }); };

      const aR = a.x + a.w, aB = a.y + a.h, bR = b.x + b.w, bB = b.y + b.h;
      const inside = (o, i) => i.x >= o.x && i.y >= o.y && (i.x + i.w) <= (o.x + o.w) && (i.y + i.h) <= (o.y + o.h);

      if (inside(b, a) || inside(a, b)) {
        const o = inside(b, a) ? b : a, i = inside(b, a) ? a : b;   // outer, inner
        const cy = i.y + i.h / 2, cx = i.x + i.w / 2;
        hline(o.x, i.x, cy); hline(i.x + i.w, o.x + o.w, cy);
        vline(o.y, i.y, cx); vline(i.y + i.h, o.y + o.h, cx);
      } else {
        if (b.x >= aR) hline(aR, b.x, mid(a.y, aB, b.y, bB));
        else if (a.x >= bR) hline(bR, a.x, mid(a.y, aB, b.y, bB));
        if (b.y >= aB) vline(aB, b.y, mid(a.x, aR, b.x, bR));
        else if (a.y >= bB) vline(bB, a.y, mid(a.x, aR, b.x, bR));
      }

      host.innerHTML = lines.filter((l) => l.v > 0).map((l) => {
        const horiz = l.h === 0;
        return `<div class="sc-mline ${horiz ? "sc-mh" : "sc-mv"}" style="left:${l.x}px;top:${l.y}px;width:${horiz ? l.w : 1}px;height:${horiz ? 1 : l.h}px">` +
          `<span class="sc-mlabel">${l.v}</span></div>`;
      }).join("");
    }

    /* ── FLIP ─────────────────────────────────────────────────────────────── */
    flipStart(skip = null) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
      const skipSet = skip instanceof Set ? skip : skip ? new Set([skip]) : null;
      const pre = new Map();
      this.els.forEach((el, id) => { if (el.isConnected && !skipSet?.has(id)) pre.set(id, el.getBoundingClientRect()); });
      return () => {
        this.els.forEach((el, id) => {
          const p = pre.get(id);
          if (!p || !el.isConnected) return;
          const r = el.getBoundingClientRect();
          const dx = (p.left - r.left) / this.zoom, dy = (p.top - r.top) / this.zoom;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
          try {
            el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
              { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
          } catch (_) {}
        });
      };
    }

    /* ── interaction wiring ───────────────────────────────────────────────── */
    bind() {
      this.vp.addEventListener("wheel", (e) => {
        const vr = this.vp.getBoundingClientRect();
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          this.zoomAt(Math.exp(-e.deltaY * 0.0024), e.clientX - vr.left, e.clientY - vr.top);
          return;
        }
        // two clean modes, no physics tricks: in EDIT mode the wheel always pans
        // the canvas; in PREVIEW mode it is locked to the phone content over the
        // screen (scrolls like the real app) and pans the canvas everywhere else
        if (this.preview && this.screen.contains(e.target)) return;   // native scroll only
        e.preventDefault();
        this.pan = { x: this.pan.x - e.deltaX, y: this.pan.y - e.deltaY };
        this.applyView();
      }, { passive: false });

      // keys scope to the canvas — the viewport is focusable, clicks focus it
      this.vp.addEventListener("pointerdown", (e) => {
        if (this.fxPanel?.contains(e.target)) return;   // the formula editor keeps its focus
        this.vp.focus({ preventScroll: true });
      });
      // overflow:hidden containers still scroll programmatically (focus,
      // scrollIntoView, find-in-page); any stray scroll shifts pixels away
      // from the transform math and the canvas feels broken. Pin it.
      this.vp.addEventListener("scroll", () => { this.vp.scrollLeft = 0; this.vp.scrollTop = 0; });
      this.vp.addEventListener("keydown", (e) => {
        if (this.editing) return;
        if (e.key === "Alt" && !this.altDown) { this.altDown = true; this.updateChrome(); }
        const mod = e.metaKey || e.ctrlKey;
        if (this.preview && e.code !== "Space" && !(mod && ["0", "1", "=", "+", "-"].includes(e.key))) return;
        if (e.code === "Space") {
          if (!this.spaceDown) { this.spaceDown = true; this.vp.classList.add("sc-space"); }
          e.preventDefault();
          return;
        }
        if (e.key === "Escape") {
          if (this.drag?.active) { this.cancelDrag(); return; }
          if (this.sel) { this.climb(); return; }
          return;
        }
        const sibStep = (dir) => {
          const parent = this.parentOf(this.sel);
          if (!parent) return;
          const sibs = parent.children || [];
          const i = sibs.findIndex((c) => c.id === this.sel);
          const j = (i + dir + sibs.length) % sibs.length;     // wraps — fast cycling
          this.select(sibs[j].id, "keyboard");
        };
        if (e.key === "Tab") { if (this.sel) { e.preventDefault(); sibStep(e.shiftKey ? -1 : 1); } return; }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          if (!this.sel) return;
          e.preventDefault();
          const parent = this.parentOf(this.sel);
          if (!parent) return;
          const sibs = parent.children || [];
          const i = sibs.findIndex((c) => c.id === this.sel);
          const j = e.key === "ArrowUp" ? i - 1 : i + 1;
          if (j >= 0 && j < sibs.length) this.select(sibs[j].id, "keyboard");
          return;
        }
        if (e.key === "ArrowLeft") { if (this.sel) { e.preventDefault(); this.climb(); } return; }
        if (e.key === "ArrowRight") {
          if (!this.sel) return;
          const n = this.nodeOf(this.sel);
          if (n?.children?.length) { e.preventDefault(); this.select(n.children[0].id, "keyboard"); }
          return;
        }
        if (e.key === "Enter") {
          if (!this.sel) return;
          e.preventDefault();
          const n = this.nodeOf(this.sel);
          if (n && (n.tag === "text" || n.tag === "button")) this.startEdit(n.id);
          else if (n?.children?.length) { this.select(n.children[0].id, "enter"); this.emit("drill", { from: n.id, to: n.children[0].id }); }
          return;
        }
        if ((e.key === "Backspace" || e.key === "Delete") && this.selIds.size) { e.preventDefault(); this.deleteSelected(); return; }
        if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
        if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); this.redo(); return; }
        if (mod && e.key.toLowerCase() === "d" && this.selIds.size) { e.preventDefault(); this.duplicateSelected(); return; }
        if (mod && e.key.toLowerCase() === "c" && this.selIds.size) { e.preventDefault(); this.copySelected(); return; }
        if (mod && e.key.toLowerCase() === "x" && this.selIds.size) { e.preventDefault(); this.cutSelected(); return; }
        if (mod && e.key.toLowerCase() === "v" && this.clipboard?.length) { e.preventDefault(); this.paste(); return; }
        if (mod && e.key.toLowerCase() === "g" && this.selIds.size) {
          e.preventDefault();
          if (e.shiftKey) this.unwrap();
          else this.wrap(StackCanvas.node("vstack", { spacing: 8 }));
          return;
        }
        if (mod && e.key === "0") { e.preventDefault(); this.fit(); return; }
        if (mod && e.key === "1") { e.preventDefault(); this.view100(); return; }
        if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); this.zoomAtCenter(1.25); return; }
        if (mod && e.key === "-") { e.preventDefault(); this.zoomAtCenter(1 / 1.25); return; }
      });
      this.vp.addEventListener("keyup", (e) => {
        if (e.code === "Space") { this.spaceDown = false; if (!this.panning) this.vp.classList.remove("sc-space"); }
        if (e.key === "Alt") { this.altDown = false; this.updateChrome(); }
      });
      this.vp.addEventListener("blur", () => {
        this.spaceDown = false;
        this.altDown = false;
        if (!this.panning) this.vp.classList.remove("sc-space");
        this.updateChrome();
      });

      // pan: space-drag or middle-drag
      this.vp.addEventListener("pointerdown", (e) => {
        if (!(this.spaceDown || e.button === 1)) return;
        e.preventDefault();
        this.panning = true;
        this.vp.classList.add("sc-panning");
        this.vp.setPointerCapture(e.pointerId);
        let lx = e.clientX, ly = e.clientY;
        const move = (ev) => {
          const dx = ev.clientX - lx, dy = ev.clientY - ly;
          lx = ev.clientX; ly = ev.clientY;
          this.pan = { x: this.pan.x + dx, y: this.pan.y + dy };
          this.applyView();
        };
        const up = (ev) => {
          this.vp.removeEventListener("pointermove", move);
          this.vp.removeEventListener("pointerup", up);
          try { this.vp.releasePointerCapture(ev.pointerId); } catch (_) {}
          this.panning = false;
          this.vp.classList.remove("sc-panning");
          if (!this.spaceDown) this.vp.classList.remove("sc-space");
          this.updateChrome();
        };
        this.vp.addEventListener("pointermove", move);
        this.vp.addEventListener("pointerup", up);
      });

      // hover: previews the exact node a click would select (deep with ⌘/alt held).
      // pointermove with target/modifier short-circuit — near-zero cost per event.
      const refreshHover = (e) => {
        if (this.preview || this.drag?.active || this.panning) { return; }
        if (e.target === this._hovEl) return;
        this._hovEl = e.target;
        const t = e.target.closest?.("[data-id]");
        const id = t ? this.resolveTarget(t.dataset.id) : null;
        if (id === this.hov) return;
        this.hov = id;
        this.updateChrome();
        this.emit("hover", id ? { id, tag: this.nodeOf(id)?.tag } : null);
      };
      this.world.addEventListener("pointermove", refreshHover);
      this.world.addEventListener("pointerover", refreshHover);
      this.world.addEventListener("pointerleave", () => {
        this._hovEl = null;
        if (this.hov) { this.hov = null; this.updateChrome(); this.emit("hover", null); }
      });

      // POINTERDOWN: instant selection (the power-user feel) + drag arming.
      // Shift toggles membership; grabbing any selected element drags the group.
      this.world.addEventListener("pointerdown", (e) => {
        if (this.preview || e.button !== 0 || this.spaceDown || this.editing) return;
        const t = e.target.closest("[data-id]");
        if (!t) return;
        const target = this.resolveTarget(t.dataset.id);
        if (!target) return;

        let grab = target;
        if (e.shiftKey) {
          const ids = new Set(this.selIds);
          if (ids.has(target)) ids.delete(target); else ids.add(target);
          ids.delete(this.tree.id);                            // root never joins a multi-selection
          this.setSelection([...ids], ids.has(target) ? target : this.sel, "shift-click");
          if (!this.selIds.has(target)) return;                // toggled off — nothing to drag
        } else if (!this.selIds.has(target)) {
          // a press inside the selected element (or a selected ancestor)
          // grabs the SELECTION — that's how a parent picked in the tree or
          // breadcrumb gets dragged. A plain click still selects the deepest
          // element; that decision is deferred to pointerup.
          const selAnc = [...this.selIds].find((id) => id === target || this.isAncestor(id, target));
          if (selAnc) grab = selAnc;
          else this.setSelection([target], target, "pointer");
        }

        if (grab === this.tree.id) return;                     // root is not draggable
        const ids = this.selIds.has(grab) ? [...this.selIds] : [grab];
        this.startDrag(e, ids, grab, grab !== target ? target : null);
      });

      // empty canvas (outside the phone): deselect on pointerdown — instant too
      this.vp.addEventListener("pointerdown", (e) => {
        if (this.preview || e.button !== 0 || this.spaceDown || this.editing || e.shiftKey) return;
        if (e.target.closest("[data-id]") || e.target.closest(".sc-zoomctl") || e.target.closest(".sc-tagchip")) return;
        this.select(null, "pointer");
      });

      // double-click: drill one level, or edit text at the deepest level
      this.vp.addEventListener("dblclick", (e) => {
        if (this.preview || this.editing) return;
        const t = e.target.closest("[data-id]");
        if (!t) return;
        const deepest = t.dataset.id;
        const chain = this.chainOf(deepest).map((n) => n.id);
        const selIdx = this.sel ? chain.indexOf(this.sel) : -1;
        if (selIdx >= 0 && selIdx < chain.length - 1) {
          const from = this.sel;
          this.select(chain[selIdx + 1], "drill");
          this.emit("drill", { from, to: chain[selIdx + 1] });
          return;
        }
        const n = this.nodeOf(this.sel || deepest);
        if (n && (n.tag === "text" || n.tag === "button")) this.startEdit(n.id);
        else if (n && !(n.children || []).length && this.bindableAttrs(n.id).length) this.openBinding(n.id);
      });

      // momentum scrolling runs on the compositor, ahead of anything JS can see,
      // so the chrome hides instantly while content scrolls and fades back in,
      // repositioned, the moment it settles. No trailing, no rubber-band jumps.
      this.screen.addEventListener("scroll", () => {
        this.vp.classList.add("sc-scrolling");
        clearTimeout(this._scrollT);
        this._scrollT = setTimeout(() => {
          this.vp.classList.remove("sc-scrolling");
          this.updateChrome();
        }, 140);
      }, { passive: true });

      this.tagChip.addEventListener("click", (e) => { e.stopPropagation(); this.climb(); });
      this._onResize = () => this.updateChrome();
      window.addEventListener("resize", this._onResize);
    }

    /* ── drag & drop — group-aware geometric hit-testing + FLIP make-room ─── */
    startDrag(e, rawIds, primary, clickSelect = null) {
      // exclude root, drop ids nested inside other dragged ids, document order
      let ids = rawIds.filter((id) => id !== this.tree.id && this.els.get(id));
      ids = ids.filter((id) => !ids.some((o) => o !== id && this.isAncestor(o, id)));
      // template members that reference item.* are LOCKED inside their template
      // (moving them out would orphan their row scope). Members with no item
      // bindings are free agents. The row template ITSELF is the exception:
      // dragging it out of its list UNLINKS it — bindings materialize into the
      // row-0 values it was showing. A mixed grab follows the primary's context.
      const lockedIn = (id) =>
        !this.isTemplateRoot(id) && this.templateRootOf(id) != null && this.usesItemData(this.nodeOf(id))
          ? this.templateRootOf(id) : null;
      const primaryId = ids.includes(primary) ? primary : ids[0];
      const boundTo = primaryId ? lockedIn(primaryId) : null;
      ids = ids.filter((id) => (boundTo ? this.templateRootOf(id) === boundTo : !lockedIn(id)));
      ids.sort((a, b) => this.idx.order.get(a) - this.idx.order.get(b));
      if (!ids.length) return;
      const set = new Set(ids);
      const startX = e.clientX, startY = e.clientY;
      const label = ids.length > 1
        ? `${ids.length} elements`
        : this.isTemplateRoot(ids[0]) ? "List item" : friendly(this.nodeOf(ids[0])?.tag || "");
      this.drag = { ids, set, boundTo, primary: set.has(primary) ? primary : ids[0], label, active: false, x: startX, y: startY, raf: 0, clickSelect };

      const frame = () => {
        const d = this.drag;
        if (!d) return;
        d.raf = 0;
        this.ghost.style.left = (d.x + 14) + "px";
        this.ghost.style.top = (d.y + 12) + "px";
        this.placeLine(this.computeHint(d.x, d.y));
        // inside the phone, dragging near the screen's edge scrolls the CONTENT
        const sr = this.screen.getBoundingClientRect();
        if (d.x > sr.left && d.x < sr.right && this.screen.scrollHeight > this.screen.clientHeight) {
          const sm = 30;
          if (d.y < sr.top + sm && d.y > sr.top - 12) this.screen.scrollTop -= (sr.top + sm - d.y) * 0.3;
          else if (d.y > sr.bottom - sm && d.y < sr.bottom + 12) this.screen.scrollTop += (d.y - (sr.bottom - sm)) * 0.3;
        }
        const vr = this.vp.getBoundingClientRect();
        if (d.x > vr.left && d.x < vr.right && d.y > vr.top && d.y < vr.bottom) {
          const m = 36;
          let dx = 0, dy = 0;
          if (d.x < vr.left + m) dx = (vr.left + m - d.x) * 0.25;
          else if (d.x > vr.right - m) dx = -(d.x - (vr.right - m)) * 0.25;
          if (d.y < vr.top + m) dy = (vr.top + m - d.y) * 0.25;
          else if (d.y > vr.bottom - m) dy = -(d.y - (vr.bottom - m)) * 0.25;
          if (dx || dy) { this.pan = { x: this.pan.x + dx, y: this.pan.y + dy }; this.applyViewNow(); }
        }
      };
      const move = (ev) => {
        const d = this.drag;
        if (!d) return;
        d.x = ev.clientX; d.y = ev.clientY;
        if (!d.active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          d.active = true;
          // settle any running FLIP: hit-testing against mid-animation rects
          // (e.g. right after an insert) targets moving geometry and misses
          try { this.world.getAnimations({ subtree: true }).forEach((an) => an.finish()); } catch (_) {}
          this.ghost.style.display = "flex";
          const tag = this.nodeOf(d.primary)?.tag;
          this.ghost.classList.toggle("sc-comp", isComponent(tag));
          this.ghost.classList.toggle("sc-grp", tag === "list" || this.isRepeater(this.nodeOf(d.primary)) || this.isTemplateRoot(d.primary));
          const gi = isComponent(tag) ? ICONS.cube : ICONS.code;
          this.ghost.innerHTML = `<span class="sc-gicon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${gi}</svg></span>${d.label}`;
          d.ids.forEach((id) => this.els.get(id)?.classList.add("sc-dragging"));
          this.vp.classList.add("sc-dragging");
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          this.emit("dragstart", { ids: d.ids, id: d.primary, tag });
        }
        if (!d.raf) d.raf = requestAnimationFrame(frame);   // one hit-test per frame
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const d = this.drag;
        if (!d) return;
        if (d.raf) {
          cancelAnimationFrame(d.raf);
          d.raf = 0;
          // A fast release can arrive before the last animation-frame hit test.
          // Resolve the pointer's final position synchronously so the drop never
          // uses a stale hint (or silently becomes a no-op).
          if (d.active) this.placeLine(this.computeHint(d.x, d.y));
        }
        const wasActive = d.active;
        const hint = this.hint;
        this.drag = null;
        this.cleanupDrag(d);
        if (wasActive) this.performDrop(d.ids, hint, d.primary);
        else if (d.clickSelect) this.setSelection([d.clickSelect], d.clickSelect, "pointer");
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      this._dragMove = move;
      this._dragUp = up;
    }

    cleanupDrag(d) {
      this.line.style.display = "none";
      this.hint = null;
      if (this.dropTargetEl) { this.dropTargetEl.classList.remove("sc-droptarget"); this.dropTargetEl = null; }
      this.ghost.style.display = "none";
      d.ids.forEach((id) => this.els.get(id)?.classList.remove("sc-dragging"));
      this.vp.classList.remove("sc-dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      this.updateChrome();
    }
    cancelDrag() {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.raf) cancelAnimationFrame(d.raf);
      if (this._dragMove) window.removeEventListener("pointermove", this._dragMove);
      if (this._dragUp) window.removeEventListener("pointerup", this._dragUp);
      this.cleanupDrag(d);
      this.emit("cancel", { ids: d.ids, id: d.primary });
    }

    // Deepest container under the pointer wins; edge bands along the PARENT's axis
    // bubble out to a sibling insert; otherwise midpoints pick the slot. All indices
    // live in moving-excluded space — exactly what performDrop splices into.
    computeHint(cx, cy) {
      const moving = this.drag?.set;
      if (!moving) return null;
      let best = null;
      const walk = (n, depth) => {
        if (moving.has(n.id)) return;                        // never target a dragged subtree
        const boundList = this.isRepeater(n) && (n.children || []).length > 0;
        if (CONTAINERS.has(n.tag) && !boundList) {           // a filled repeater owns its template; an empty one accepts one
          const el = this.els.get(n.id);
          if (el) {
            const r = el.getBoundingClientRect();
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
              if (!best || depth >= best.depth) best = { n, depth, r };
            }
          }
        }
        (n.children || []).forEach((c) => walk(c, depth + 1));
      };
      walk(this.tree, 0);
      if (!best) return null;
      const within = (hint) => {
        const b = this.drag?.boundTo;
        if (!b) return hint;
        return hint && (hint.parentId === b || this.isAncestor(b, hint.parentId)) ? hint : null;
      };

      // edge zones: near a nested container's leading/trailing edge → sibling insert
      let probe = best, guard = 0;
      while (probe.n.id !== this.tree.id && guard++ < 8) {
        const parent = this.parentOf(probe.n.id);
        if (!parent || !CONTAINERS.has(parent.tag)) break;
        const horizontal = this.isRowContainer(parent);
        const { r } = probe;
        const band = Math.min(10, (horizontal ? r.width : r.height) * 0.28);
        const before = horizontal ? cx < r.left + band : cy < r.top + band;
        const after = horizontal ? cx > r.right - band : cy > r.bottom - band;
        if (!before && !after) break;
        const idx = this.visibleIndex(parent, probe.n.id);
        return within({ parentId: parent.id, index: before ? idx : idx + 1 });
      }

      // inside: midpoints of rendered children along the container's axis.
      // The line is overlay chrome with no footprint, so the layout these
      // midpoints come from never moves — indices are perfectly stable.
      const horizontal = this.isRowContainer(best.n);
      let idx = 0;
      for (const k of best.n.children || []) {
        if (moving.has(k.id)) continue;
        const kel = this.els.get(k.id);
        if (!kel) continue;
        const kr = kel.getBoundingClientRect();
        if ((horizontal ? cx : cy) > (horizontal ? kr.left + kr.width / 2 : kr.top + kr.height / 2)) idx++;
      }
      return within({ parentId: best.n.id, index: idx });
    }

    visibleIndex(parent, childId) {
      const moving = this.drag?.set;
      let i = 0;
      for (const k of parent.children || []) {
        if (k.id === childId) return i;
        if (!moving?.has(k.id)) i++;
      }
      return i;
    }

    placeLine(hint) {
      if (!hint) {
        if (this.hint) {
          this.line.style.display = "none";
          if (this.dropTargetEl) { this.dropTargetEl.classList.remove("sc-droptarget"); this.dropTargetEl = null; }
          this.hint = null;
        }
        return;
      }
      if (this.hint && this.hint.parentId === hint.parentId && this.hint.index === hint.index) return;
      const parentEl = this.els.get(hint.parentId);
      const parent = this.nodeOf(hint.parentId);
      if (!parentEl || !parent) return;

      if (this.dropTargetEl && this.dropTargetEl !== parentEl) this.dropTargetEl.classList.remove("sc-droptarget");
      parentEl.classList.add("sc-droptarget");
      this.dropTargetEl = parentEl;

      // geometry: the line sits IN THE GAP between the two children it would
      // land between, spanning their cross-axis extent — drawn in screen space
      const vr = this.vp.getBoundingClientRect();
      const horizontal = this.isRowContainer(parent);
      const moving = this.drag?.set;
      const rects = (parent.children || [])
        .filter((c) => !moving?.has(c.id))
        .map((c) => this.els.get(c.id))
        .filter((el) => el && el.isConnected)
        .map((el) => el.getBoundingClientRect());
      const pr = parentEl.getBoundingClientRect();

      let c0, c1;
      if (rects.length) {
        c0 = Math.min(...rects.map((r) => (horizontal ? r.top : r.left)));
        c1 = Math.max(...rects.map((r) => (horizontal ? r.bottom : r.right)));
      } else {
        c0 = (horizontal ? pr.top : pr.left) + 8;
        c1 = (horizontal ? pr.bottom : pr.right) - 8;
      }
      const i = Math.min(hint.index, rects.length);
      let pos;
      if (!rects.length) pos = (horizontal ? pr.left : pr.top) + 10;
      else if (i === 0) pos = (horizontal ? rects[0].left : rects[0].top) - 3;
      else if (i >= rects.length) pos = (horizontal ? rects[rects.length - 1].right : rects[rects.length - 1].bottom) + 3;
      else {
        const a = rects[i - 1], b = rects[i];
        pos = horizontal ? (a.right + b.left) / 2 : (a.bottom + b.top) / 2;
      }
      pos = Math.max(horizontal ? pr.left : pr.top, Math.min(pos, horizontal ? pr.right : pr.bottom));

      this.line.style.left = (horizontal ? pos - 1 : c0) - vr.left + "px";
      this.line.style.top = (horizontal ? c0 : pos - 1) - vr.top + "px";
      this.line.style.width = (horizontal ? 2 : c1 - c0) + "px";
      this.line.style.height = (horizontal ? c1 - c0 : 2) + "px";
      this.line.style.display = "block";

      this.hint = hint;
      this.emit("drophint", { parentId: hint.parentId, index: hint.index, tag: parent.tag });
    }

    performDrop(ids, hint, primary) {
      if (!hint || !ids?.length) return;
      const set = new Set(ids);
      if (set.has(hint.parentId)) return;
      for (const id of ids) {                                  // never into a dragged subtree
        if (this.isAncestor(id, hint.parentId)) return;
      }
      const newParent = this.nodeOf(hint.parentId);
      if (!newParent) return;
      if (this.isRepeater(newParent) && (newParent.children || []).length) return;   // a filled repeater owns its template
      const nodes = ids.map((id) => this.nodeOf(id));
      const oldParents = ids.map((id) => this.parentOf(id));
      if (nodes.some((n) => !n) || oldParents.some((p) => !p)) return;

      // ghost rows mirror the template at render time, so any move that touches a
      // bound list goes through a full re-render (FLIP carries it, keyed by id)
      const boundInvolved =
        this.isRepeater(newParent) ||
        this.templateRootOf(hint.parentId) != null ||
        ids.some((id) => this.templateRootOf(id) != null);

      // a row template leaving its list unlinks: bindings freeze into the
      // row-0 values it was displaying (the element looks identical after)
      const unlinked = [];
      for (const id of ids) {
        if (!this.isTemplateRoot(id)) continue;
        const list = this.parentOf(id);
        const rows = asRows(this.evalIn(list.attrs.bind, {}));
        this.materializeItem(this.nodeOf(id), { item: rows[0] || {} });
        unlinked.push({ id, listId: list.id });
      }

      // data: splice all out, insert as one contiguous group at the hint index
      // (the index already lives in moving-excluded space, so it aligns post-removal)
      oldParents.forEach((p, i) => { p.children = p.children.filter((c) => c.id !== ids[i]); });
      if (!newParent.children) newParent.children = [];
      const idx = Math.min(hint.index, newParent.children.length);
      newParent.children.splice(idx, 0, ...nodes);

      const play = this.flipStart();
      if (boundInvolved) {
        this.render();
      } else {
        // DOM: move the actual elements — no re-render, one FLIP slides everything
        const parentEl = this.els.get(hint.parentId);
        let vis = 0, ref = null;
        for (const child of parentEl.children) {
          if (!child.dataset || !child.dataset.id || set.has(child.dataset.id)) continue;
          if (vis === idx) { ref = child; break; }
          vis++;
        }
        parentEl.querySelector(":scope > .sc-empty")?.remove();
        ids.forEach((id) => parentEl.insertBefore(this.els.get(id), ref));
        for (const p of new Set(oldParents)) {
          if (p.children.length) continue;
          const pEl = this.els.get(p.id);
          if (pEl && !pEl.querySelector(":scope > .sc-empty")) pEl.appendChild(this.emptyHint());
        }
      }
      play();

      this.reindex();
      this.setSelection(ids, set.has(primary) ? primary : ids[0], "drop");
      unlinked.forEach((u) => this.emit("unlink", u));
      this.emit("drop", { ids, id: primary, parentId: hint.parentId, index: idx, unlinked: unlinked.map((u) => u.id) });
      this.emit("change", { tree: this.getTree() });
      this.updateChrome();
      setTimeout(() => this.updateChrome(), 180);
    }

    /* ── inline text editing ──────────────────────────────────────────────── */
    // Inline editing with SPREADSHEET-STYLE linking: an edit that starts with
    // '=' commits as a JSE binding (=item.title, =queue.length), text containing
    // {{ }} commits as an interpolated value, anything else is a literal.
    // Bound fields are locked by default: the SDK emits `editblocked` and the
    // host decides — confirm, then startEdit(id, { force: true }), which opens
    // the field PREFILLED with its formula (=expr or the raw {{ }} template) so
    // the binding edits inline. Stripping the '=' commits a literal and unlinks.
    // While editing, `editinput { id, value, expr, rect }` streams per keystroke
    // so the host can anchor a path-suggestion popover (see getBindables).
    startEdit(id, opts = {}) {
      if (this.preview) return;
      const n = this.nodeOf(id);
      const el = this.els.get(id);
      if (!n || !el) return;
      const key = n.tag === "button" ? "label" : n.tag === "textfield" ? "placeholder" : "value";
      const bound = n.attrs?.bind != null || hasMustache(n.attrs?.[key]);
      if (bound && !opts.force) {
        this.emit("editblocked", { id, reason: "bound", bind: n.attrs?.bind ?? null, value: n.attrs?.[key] ?? null });
        return;
      }
      // bound values open the binding panel — never raw syntax on canvas
      if (bound) { this.openBinding(id); return; }

      const original = el.textContent;
      this.editing = id;
      el.classList.add("sc-editing");
      el.contentEditable = "true";
      el.focus();
      document.getSelection()?.selectAllChildren(el);   // plain text: select-all for quick replace
      this.emit("editstart", { id, tag: n.tag, expr: false });

      const teardown = () => {
        el.contentEditable = "false";
        el.classList.remove("sc-editing");
        el.removeEventListener("blur", onBlur);
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("input", onInput);
        this.editing = null;
      };
      const finish = (commit) => {
        teardown();
        if (commit) {
          const text = el.textContent.trim();
          const value = text || original;
          n.attrs = { ...(n.attrs || {}), [key]: value };
          if (n.attrs.bind != null) delete n.attrs.bind;
          this.emit("edit", { id, value, unlinked: false });
          this.repaint();
          this.emit("change", { tree: this.getTree() });
        } else el.textContent = original;
        this.updateChrome();
      };
      const onInput = () => {
        const value = el.textContent;
        // a "{{" template mid-edit hands off to the expression editor
        if (hasMustache(value)) {
          teardown();
          el.textContent = original;
          this.openBinding(id, { expr: value.trim() });
          return;
        }
        this.emit("editinput", { id, value, expr: false, resolves: true, result: value, rect: this.rectOf(id) });
      };
      const onBlur = () => finish(true);
      const onKey = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); el.blur(); }
        if (e.key === "Escape") { e.preventDefault(); el.removeEventListener("blur", onBlur); finish(false); }
      };
      el.addEventListener("input", onInput);
      el.addEventListener("blur", onBlur);
      el.addEventListener("keydown", onKey);
    }

    // Webflow-style binding, for ANY attribute: text content, image src,
    // urls, values — pick a field or write a custom expression.
    contentKeyOf(n) {
      return n?.tag === "button" ? "label" : n?.tag === "textfield" ? "placeholder" : "value";
    }
    // which attributes make sense to bind on this node
    bindableAttrs(id) {
      const n = this.nodeOf(id);
      if (!n) return [];
      const a = n.attrs || {};
      const out = [];
      const push = (key, label) => { if (!out.some((x) => x.key === key)) out.push({ key, label }); };
      const TAGS = {
        text: [["value", "Text"]],
        button: [["label", "Label"]],
        textfield: [["placeholder", "Placeholder"], ["value", "Value"]],
        image: [["src", "Source"], ["url", "URL"]],
        webview: [["url", "URL"]],
        video: [["src", "Source"]],
        toggle: [["value", "Value"]],
        progress: [["value", "Value"]],
        slider: [["value", "Value"]],
        segmented: [["value", "Value"], ["options", "Options"]],
      };
      for (const [k, l] of TAGS[n.tag] || [[this.contentKeyOf(n), "Value"]]) push(k, l);
      // anything already carrying data stays offered, whatever it is
      for (const [k, v] of Object.entries(a)) {
        if (k.startsWith("on:") || k === "bind") continue;
        if (typeof v === "string" && hasMustache(v)) push(k, this.friendlyAttr ? this.friendlyAttr(k) : k);
      }
      return out;
    }
    // the raw stored expression for a key, "" when static
    currentRawFor(n, key) {
      if (!n) return "";
      if (key === this.contentKeyOf(n) && n.attrs?.bind != null) return n.attrs.bind;
      const v = n.attrs?.[key];
      if (typeof v === "string" && hasMustache(v)) {
        const m = v.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
        return m ? m[1] : v;   // pure binding unwraps; mixed templates stay verbatim
      }
      return "";
    }
    isBoundKey(n, key) {
      if (!n) return false;
      if (key === this.contentKeyOf(n) && n.attrs?.bind != null) return true;
      return typeof n.attrs?.[key] === "string" && hasMustache(n.attrs[key]);
    }
    openBinding(id, opts = {}) {
      const n = this.nodeOf(id);
      const el = this.els.get(id);
      if (!n || !el || this.preview) return;
      const attrs = this.bindableAttrs(id);
      if (!attrs.length) return;
      this.editing = id;
      this._fxMode = true;
      this._fxIdx = 0;
      el.classList.add("sc-editing", "sc-editing-fx");
      this.bindAttrSel.innerHTML = attrs.map((x) => `<option value="${x.key}">${x.label}</option>`).join("");
      const wanted = opts.attr && attrs.some((x) => x.key === opts.attr) ? opts.attr : attrs[0].key;
      this.bindAttrSel.value = wanted;
      this._bindKey = wanted;
      this.fxInput.value = "";
      this.exprInput.value = opts.expr ?? this.currentRawFor(n, wanted);
      this.bindUnlink.hidden = !this.isBoundKey(n, wanted);
      this.setBindMode(opts.expr != null || opts.mode === "expr" ? "expr" : "fields", true);
      this.fxPanel.classList.add("sc-fxbar-on");
      this.emit("editstart", { id, tag: n.tag, attr: wanted, expr: true });

      this._bindKeyHandler = (e) => this.bindKeydown(e);
      this._bindInputHandler = () => { this._fxIdx = 0; this.updateFxChip(); if (this._bindMode === "expr") this.livePreview(id, this._bindKey, this.wrapExpr(this.exprInput.value)); };
      this.fxInput.addEventListener("keydown", this._bindKeyHandler);
      this.exprInput.addEventListener("keydown", this._bindKeyHandler);
      this.fxInput.addEventListener("input", this._bindInputHandler);
      this.exprInput.addEventListener("input", this._bindInputHandler);
    }
    // switching the target attribute re-seeds the panel in place
    setBindKey(key) {
      const n = this.nodeOf(this.editing);
      if (!n) return;
      this._bindKey = key;
      this._fxIdx = 0;
      this.fxInput.value = "";
      this.exprInput.value = this.currentRawFor(n, key);
      this.bindUnlink.hidden = !this.isBoundKey(n, key);
      this.updateFxChip();
    }
    // kept for API compatibility: routes into the binding panel
    startFormulaEdit(id, key, initial) {
      const t = String(initial ?? "").trim();
      this.openBinding(id, { attr: key, expr: t.startsWith("=") ? t.slice(1).trim() : t });
    }
    wrapExpr(expr) {
      const t = String(expr ?? "").trim();
      return hasMustache(t) ? t : "=" + t;   // engine-internal only, never shown
    }
    setBindMode(mode, init = false) {
      this._bindMode = mode;
      const expr = mode === "expr";
      this.exprWrap.hidden = !expr;
      this.fxPanel.querySelector(".sc-bindsearch").hidden = expr;
      this.bindCustom.textContent = expr ? "‹ Fields" : "Custom expression";
      this.fxPanel.querySelector(".sc-bindhead b").textContent = expr ? "Expression" : "Bind";
      this._fxIdx = 0;
      this.updateFxChip();
      const input = expr ? this.exprInput : this.fxInput;
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
      if (expr && !init) this.livePreview(this.editing, this._bindKey, this.wrapExpr(this.exprInput.value));
    }
    bindKeydown(e) {
      e.stopPropagation();
      const open = this._fxRows.length > 0;
      if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        this._fxIdx = (this._fxIdx + d + this._fxRows.length) % this._fxRows.length;
        this.updateFxChip();
        return;
      }
      if (this._bindMode === "fields") {
        if (e.key === "Enter" && open) { e.preventDefault(); this.bindTo(this.editing, this._fxRows[this._fxIdx]?.path); return; }
        if (e.key === "Escape") { e.preventDefault(); this.closeBinding(false); return; }
        return;
      }
      if (open && e.key === "Tab") { e.preventDefault(); this.fxInsert(this._fxIdx); return; }
      if (e.key === "Enter") { e.preventDefault(); this.commitExpr(); return; }
      if (e.key === "Escape") { e.preventDefault(); this.setBindMode("fields"); return; }
    }
    bindTo(id, path) {
      const n = id && this.nodeOf(id);
      if (!n || !path) return;
      const key = this._bindKey || this.contentKeyOf(n);
      n.attrs = { ...(n.attrs || {}) };
      if (key === this.contentKeyOf(n)) {
        n.attrs.bind = path;
        if (hasMustache(n.attrs[key])) delete n.attrs[key];
      } else {
        n.attrs[key] = `{{ ${path} }}`;   // any other attribute binds via template
      }
      this.closeBinding(true);
      this.emit("edit", { id, attr: key, bind: path, linked: true, resolves: this.previewEdit(id, "=" + path).resolves });
      this.repaint();
      this.emit("change", { tree: this.getTree() });
      this.updateChrome();
    }
    commitExpr() {
      const id = this.editing;
      const n = id && this.nodeOf(id);
      if (!n) return;
      const key = this._bindKey || this.contentKeyOf(n);
      const t = this.exprInput.value.trim();
      if (!t) { this.closeBinding(false); return; }
      n.attrs = { ...(n.attrs || {}) };
      const isContent = key === this.contentKeyOf(n);
      if (hasMustache(t)) {
        n.attrs[key] = t;
        if (isContent) delete n.attrs.bind;
      } else if (isContent) {
        n.attrs.bind = t;
        if (hasMustache(n.attrs[key])) delete n.attrs[key];
      } else {
        n.attrs[key] = `{{ ${t} }}`;
      }
      this.emit("edit", { id, attr: key, bind: t, linked: true, resolves: this.previewEdit(id, this.wrapExpr(t)).resolves });
      this.closeBinding(true);
      this.repaint();
      this.emit("change", { tree: this.getTree() });
      this.updateChrome();
    }
    // unlink: the attribute keeps showing what it shows, as a static value
    disconnect(id) {
      const n = id && this.nodeOf(id);
      if (!n) return;
      const key = this._bindKey || this.contentKeyOf(n);
      const isContent = key === this.contentKeyOf(n);
      const raw = isContent && n.attrs?.bind != null ? "=" + n.attrs.bind : String(n.attrs?.[key] ?? "");
      const resolved = this.previewEdit(id, raw).result;
      n.attrs = { ...(n.attrs || {}), [key]: resolved == null ? "" : String(resolved) };
      if (isContent) delete n.attrs.bind;
      this.closeBinding(true);
      this.emit("edit", { id, attr: key, value: n.attrs[key], unlinked: true });
      this.repaint();
      this.emit("change", { tree: this.getTree() });
      this.updateChrome();
    }
    closeBinding(committed) {
      const id = this.editing;
      const el = id && this.els.get(id);
      this.fxInput.removeEventListener("keydown", this._bindKeyHandler);
      this.exprInput.removeEventListener("keydown", this._bindKeyHandler);
      this.fxInput.removeEventListener("input", this._bindInputHandler);
      this.exprInput.removeEventListener("input", this._bindInputHandler);
      this.editing = null;
      this._fxMode = false;
      this._fxRows = [];
      el?.classList.remove("sc-editing", "sc-editing-fx");
      this._fxCommitting = false;
      // leave like you arrived: a quick fade, not a vanish
      const panel = this.fxPanel;
      panel.classList.add("sc-fxout");
      clearTimeout(this._fxHideT);
      this._fxHideT = setTimeout(() => {
        panel.style.display = "none";
        panel.classList.remove("sc-fxout", "sc-fxbar-on");
      }, 110);
      if (!committed) { this.repaint(); this.updateChrome(); }
    }

    // paint the would-be result into the element while the formula bar is live
    livePreview(id, key, text) {
      const el = this.els.get(id);
      const n = this.nodeOf(id);
      if (!el || !n || key !== this.contentKeyOf(n) || !["text", "button", "textfield"].includes(n.tag)) return;
      const p = this.previewEdit(id, text);
      const shown = p.resolves ? (p.result === null ? "" : String(p.result)) : "—";
      el.textContent = shown === "" ? "…" : shown;
    }

    // The exact row scope rendering gives a node — nested repeaters included.
    scopeOf(id, depth = 0) {
      if (depth > 16) return { ...this.scope };
      const tpl = this.templateRootOf(id) || (this.isTemplateRoot(id) ? id : null);
      if (!tpl) return { ...this.scope };
      const rep = this.parentOf(tpl);
      const outer = this.scopeOf(rep.id, depth + 1);
      const rows = asRows(this.evalIn(rep.attrs.bind, outer));
      return { ...outer, item: rows[0] || {} };
    }

    // Everything this node could link to, scope-aware and grouped: item.*
    // fields first when it lives in a repeater template, then state (objects
    // opened one level), then globals. Samples let the popover preview values.
    getBindables(id) {
      const out = [];
      const sample = (v) =>
        Array.isArray(v) ? `[${v.length} rows]` :
        v != null && typeof v === "object" ? "{…}" :
        typeof v === "string" && v.length > 32 ? v.slice(0, 32) + "…" : v;
      // Paths are emitted in the DEVICE's namespace (dsx.*) — what the host
      // writes into a deck must be exactly what the runtime resolves. (The
      // legacy $-forms stopped resolving when the engine went dsx-only; an
      // autocomplete that suggests them would mint broken bindings.)
      const scope = id ? this.scopeOf(id) : { ...this.scope };
      if (scope.item && typeof scope.item === "object") {
        for (const k of Object.keys(scope.item)) out.push({ path: "dsx.item." + k, sample: sample(scope.item[k]), kind: "item" });
      }
      if (scope.attrs && typeof scope.attrs === "object") {
        for (const k of Object.keys(scope.attrs)) out.push({ path: "dsx.attribute." + k, sample: sample(scope.attrs[k]), kind: "attribute" });
      }
      if (scope.self != null) {
        if (typeof scope.self === "object" && !Array.isArray(scope.self)) {
          for (const k of Object.keys(scope.self)) out.push({ path: "dsx.this." + k, sample: sample(scope.self[k]), kind: "self" });
        } else out.push({ path: "dsx.this", sample: sample(scope.self), kind: "self" });
      }
      for (const [k, v] of Object.entries(this.designState())) {
        if (k === "global") continue;
        out.push({ path: "dsx.variable." + k, sample: sample(v), kind: "state" });
        if (v != null && !Array.isArray(v) && typeof v === "object") {
          for (const sub of Object.keys(v)) out.push({ path: "dsx.variable." + k + "." + sub, sample: sample(v[sub]), kind: "state" });
        }
      }
      for (const [k, v] of Object.entries(this.data?.global || {})) {
        out.push({ path: "dsx.global." + k, sample: sample(v), kind: "global" });
      }
      return out;
    }

    // evaluate an in-progress edit the way the canvas would render it
    previewEdit(id, text) {
      const t = text.trimStart();
      const scope = this.scopeOf(id);
      if (t.startsWith("=")) {
        const v = t.length > 1 ? this.evalIn(t.slice(1), scope) : undefined;
        return { expr: true, resolves: v !== undefined, result: v === undefined ? undefined : v };
      }
      if (hasMustache(text)) {
        let ok = true;
        const result = text.replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => {
          const r = this.evalIn(e, scope);
          if (r == null) { ok = false; return "⟨?⟩"; }
          return String(r);
        });
        return { expr: true, resolves: ok, result };
      }
      return { expr: false, resolves: true, result: text };
    }

    // caret position as a character offset into the edited element
    caretOffset(el) {
      try {
        const sel = (el.ownerDocument.defaultView || window).getSelection();
        if (!sel?.rangeCount || !el.contains(sel.focusNode)) return null;
        const r = sel.getRangeAt(0).cloneRange();
        r.setStart(el, 0);
        return r.toString().length;
      } catch (_) { return null; }
    }
    // complete the $token under the caret in the expression input
    fxInsert(i) {
      const id = this.editing;
      const row = this._fxRows[i];
      if (!id || !row || this._bindMode !== "expr") return;
      const input = this.exprInput;
      const text = input.value;
      const caret = (() => { try { return input.selectionStart ?? text.length; } catch (_) { return text.length; } })();
      const m = text.slice(0, caret).match(/[$][\w.$\[\]]*$/);
      const start = m ? caret - m[0].length : caret;
      input.value = text.slice(0, start) + row.path + text.slice(caret);
      const pos = start + row.path.length;
      try { input.setSelectionRange(pos, pos); } catch (_) {}
      input.focus();
      this._fxIdx = 0;
      this.updateFxChip();
      this.livePreview(id, this._bindKey || "value", this.wrapExpr(input.value));
    }
    updateFxChip() {
      const id = this.editing;
      const el = id && this.els.get(id);
      if (!el || !this._fxMode) { this.fxPanel.style.display = "none"; this._fxRows = []; return; }
      const n = this.nodeOf(id);
      const key = this._bindKey || "value";
      const all = this.getBindables(id);
      let rows;
      if (this._bindMode === "fields") {
        const q = this.fxInput.value.trim().toLowerCase();
        rows = q ? all.filter((b) => b.path.toLowerCase().includes(q)) : all;
      } else {
        // expression autocomplete: the $token before the caret
        const text = this.exprInput.value;
        const caret = (() => { try { return this.exprInput.selectionStart ?? text.length; } catch (_) { return text.length; } })();
        const m = text.slice(0, caret).match(/[$][\w.$\[\]]*$/);
        const token = m ? m[0] : "";
        const q = token.toLowerCase();
        rows = token
          ? all.filter((b) => b.path.toLowerCase().startsWith(q))
              .concat(all.filter((b) => !b.path.toLowerCase().startsWith(q) && b.path.toLowerCase().includes(q)))
          : [];
        if (rows.length === 1 && rows[0].path === token) rows = [];
      }
      rows = rows.slice(0, this._bindMode === "fields" ? 50 : 8);
      this._fxRows = rows;
      this._fxIdx = Math.max(0, Math.min(this._fxIdx, rows.length - 1));

      const current = this.currentRawFor(n, key) || null;
      const KIND = { item: "Current item", attribute: "Properties", self: "Element", state: "Variables", global: "Globals" };
      // people pick fields, not paths: "queueLength" reads as "Queue Length"
      const human = (path) => {
        const leaf = String(path).split(".").pop().replace(/\[\d+\]/g, "") || path;
        return leaf.replace(/[_-]+/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
      };
      const typeOf = (v) => {
        const t = String(v ?? "");
        if (v === true || v === false || t === "true" || t === "false") return ["toggle", "Yes/No"];
        if (t !== "" && !isNaN(+t)) return ["hash", "Number"];
        if (t.startsWith("[")) return ["list", "List"];
        if (t.startsWith("{")) return ["cube", "Object"];
        return ["text", "Text"];
      };
      const friendlySample = (v) => {
        const t = String(v ?? "");
        if (t.startsWith("[")) { const m = t.match(/"[^"]*"|[^,\[\]\s]+/g); return t === "[]" ? "Empty list" : "List"; }
        if (t.startsWith("{")) return "Object";
        if (t === "true") return "Yes";
        if (t === "false") return "No";
        return t;
      };
      let html = "", lastKind = null;
      rows.forEach((b, i) => {
        if (b.kind !== lastKind) { html += `<div class="sc-fxhead">${KIND[b.kind] || b.kind}</div>`; lastKind = b.kind; }
        const isCur = this._bindMode === "fields" && b.path === current;
        const cls = `sc-fxrow${i === this._fxIdx ? " sc-on" : ""}${isCur ? " sc-cur" : ""}`;
        if (this._bindMode === "fields") {
          const [glyph, tname] = typeOf(b.sample);
          const sample = friendlySample(b.sample);
          html += `<button class="${cls}" data-fx="${i}">` +
            `<span class="sc-fxtype">${icon(glyph, 11)}</span>` +
            `<span class="sc-fxname">${human(b.path).replace(/</g, "&lt;")}</span>` +
            `<span class="sc-fxsample">${sample.replace(/</g, "&lt;")}</span>` +
            `<span class="sc-fxcheck">${isCur ? icon("check", 10) : ""}</span></button>`;
        } else {
          const sample = b.sample === undefined ? "" : String(b.sample);
          html += `<button class="${cls}" data-fx="${i}" title="${b.path}">` +
            `<span class="sc-fxpath">${(() => { const d = b.path.lastIndexOf("."); return d > 0 ? `<span class="sc-fxroot">${b.path.slice(0, d + 1)}</span>${b.path.slice(d + 1)}` : b.path; })()}</span>` +
            `<span class="sc-fxsample">${sample.replace(/</g, "&lt;")}</span></button>`;
        }
      });
      if (this._bindMode === "fields" && !rows.length) {
        const q = this.fxInput.value.trim();
        html = !all.length
          ? `<div class="sc-fxstate"><b>No data to bind</b><span>Add data or props to this canvas and its fields will show up here.</span></div>`
          : q
            ? `<div class="sc-fxstate"><b>No matches for “${q.replace(/</g, "&lt;")}”</b><span>Try a different field name.</span></div>`
            : html;
      }
      this.fxList.innerHTML = html;
      // the result strip only earns its place when there is something to preview
      this.fxChip.style.display = this._bindMode === "expr" || rows.length ? "flex" : "none";
      const on = this.fxList.querySelector(".sc-fxrow.sc-on");
      if (on?.scrollIntoView) on.scrollIntoView({ block: "nearest" });

      // result footer: fields mode previews the highlighted field, expression
      // mode evaluates the draft live
      let shown, bad = false;
      if (this._bindMode === "fields") {
        const active = rows[this._fxIdx];
        if (active) {
          const v = this.evalIn(active.path, this.scopeOf(id));
          shown = v === undefined ? "—" : v === null ? "null" : String(v) || '""';
        } else shown = "no matching fields";
      } else {
        const p = this.previewEdit(id, this.wrapExpr(this.exprInput.value));
        bad = !p.resolves;
        shown = p.resolves ? (p.result === null ? "null" : String(p.result)) || '""' : "no match in data";
      }
      this.fxPanel.classList.toggle("sc-bad", bad);
      this.fxChip.querySelector(".sc-fxr-icon").innerHTML =
        `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${ICONS.fx}</svg>`;
      this.fxChip.querySelector(".sc-fxr-text").textContent = shown.length > 48 ? shown.slice(0, 48) + "…" : shown;
      this.fxChip.querySelector(".sc-fxr-path").textContent =
        this._bindMode === "fields" && rows[this._fxIdx] ? rows[this._fxIdx].path : "";

      const r = this.rectOf(id);
      if (r) {
        clearTimeout(this._fxHideT);
        this.fxPanel.classList.remove("sc-fxout");
        const vw = this.vp.clientWidth || 0;
        this.fxPanel.style.left = Math.max(8, Math.min(r.x, vw ? vw - 340 : r.x)) + "px";
        this.fxPanel.style.top = (r.y + r.h + 7) + "px";
        this.fxPanel.style.display = "flex";
      }
    }

    /* ── structure ops — batched: one FLIP, one change event ──────────────── */
    normalizedSelection() {
      let ids = [...this.selIds].filter((id) => id !== this.tree.id && this.nodeOf(id));
      ids = ids.filter((id) => !ids.some((o) => o !== id && this.isAncestor(o, id)));
      return ids.sort((a, b) => this.idx.order.get(a) - this.idx.order.get(b));
    }

    deleteNode(id) { this.deleteMany([id]); }
    deleteSelected() { this.deleteMany(this.normalizedSelection()); }
    deleteMany(ids) {
      ids = ids.filter((id) => id !== this.tree.id && this.nodeOf(id) && this.els.get(id));
      if (!ids.length) return;
      const firstParent = this.parentOf(ids[0]);
      // deleting the repeating item takes its ghost repeats with it
      const boundInvolved = ids.some((id) =>
        this.templateRootOf(id) != null || this.isRepeater(this.parentOf(id)));
      const play = this.flipStart(new Set(ids));
      const emptied = new Set();
      for (const id of ids) {
        const parent = this.parentOf(id);
        const node = this.nodeOf(id);
        parent.children = parent.children.filter((c) => c.id !== id);
        const el = this.els.get(id);
        const drop = (n) => { this.els.delete(n.id); (n.children || []).forEach(drop); };
        drop(node);
        el?.remove();
        emptied.add(parent);
        this.emit("delete", { id, tag: node.tag });
      }
      if (boundInvolved) {
        this.render();
      } else {
        for (const p of emptied) {
          if (p.children.length) continue;
          const pEl = this.els.get(p.id);
          if (pEl && !pEl.querySelector(":scope > .sc-empty")) pEl.appendChild(this.emptyHint());
        }
      }
      play();
      this.reindex();
      this.select(firstParent?.id || null, "delete");
      this.emit("change", { tree: this.getTree() });
    }

    copySelected() {
      const ids = this.normalizedSelection().filter((id) => id !== this.tree.id && this.nodeOf(id));
      if (!ids.length) return 0;
      this.clipboard = ids.map((id) => JSON.parse(JSON.stringify(this.nodeOf(id))));
      // best effort to the system clipboard too, so it survives reloads
      try { navigator.clipboard?.writeText("dsx:" + JSON.stringify(this.clipboard)).catch(() => {}); } catch (_) {}
      this.emit("copy", { count: ids.length });
      return ids.length;
    }
    cutSelected() {
      const n = this.copySelected();
      if (n) this.deleteSelected();
      return n;
    }
    paste() {
      if (!this.clipboard?.length) return [];
      // a selected container takes the paste inside; anything else pastes after it
      let parent, index;
      const sel = this.sel && this.nodeOf(this.sel) ? this.sel : null;
      if (sel && this.accepts(sel) && !this.isTemplateRoot(sel)) {
        parent = this.nodeOf(sel);
        index = (parent.children ??= []).length;
      } else if (sel && this.parentOf(sel)) {
        parent = this.parentOf(sel);
        index = parent.children.findIndex((c) => c.id === sel) + 1;
      } else {
        parent = this.tree;
        index = (parent.children ??= []).length;
      }
      const newIds = [];
      for (const srcNode of this.clipboard) {
        const clone = reId(JSON.parse(JSON.stringify(srcNode)));
        parent.children.splice(index++, 0, clone);
        newIds.push(clone.id);
        this.emit("paste", { id: clone.id, parentId: parent.id });
      }
      this.render();
      this.reindex();
      this.setSelection(newIds, newIds[0], "paste");
      this.emit("change", { tree: this.getTree() });
      return newIds;
    }

    duplicate(id) { this.duplicateMany([id]); }
    duplicateSelected() { this.duplicateMany(this.normalizedSelection()); }
    duplicateMany(ids) {
      ids = ids.filter((id) => id !== this.tree.id && this.nodeOf(id) && this.els.get(id));
      if (!ids.length) return;
      // never duplicate a row template (a bound list owns exactly one)
      ids = ids.filter((id) => !this.isTemplateRoot(id));
      if (!ids.length) return;
      const boundInvolved = ids.some((id) => this.templateRootOf(id) != null);
      const play = this.flipStart();
      const cloneIds = [];
      for (const id of ids) {
        const parent = this.parentOf(id);
        const node = this.nodeOf(id);
        const srcEl = this.els.get(id);
        const clone = reId(JSON.parse(JSON.stringify(node)));
        const i = parent.children.findIndex((c) => c.id === id);
        parent.children.splice(i + 1, 0, clone);
        if (!boundInvolved) {
          const depth = this.chainOf(id).length - 1;
          srcEl.after(this.buildEl(clone, depth));
        }
        cloneIds.push(clone.id);
        this.emit("duplicate", { sourceId: id, id: clone.id });
      }
      if (boundInvolved) this.render();
      play();
      this.reindex();
      this.setSelection(cloneIds, cloneIds[cloneIds.length - 1], "duplicate");
      this.emit("change", { tree: this.getTree() });
    }

    /* ── element creation (headless: the host's palette calls these) ──────── */
    // does this node have an OPEN slot for new children? Containers do, except
    // component instances and filled repeaters (they own exactly one template)
    accepts(x) {
      const n = typeof x === "string" ? this.nodeOf(x) : x;
      if (!n || isComponent(n.tag) || !CONTAINERS.has(n.tag)) return false;
      if (this.isRepeater(n) && (n.children || []).length > 0) return false;
      return true;
    }

    // incoming nodes get ids; colliding ids (re-added copies) get fresh ones
    adoptIds(node) {
      ensureIds(node);
      const clash = (x) => this.idx.node.has(x.id) || (x.children || []).some(clash);
      return clash(node) ? reId(node) : node;
    }

    // low level: insert at an exact slot. Returns the new id (null = rejected)
    insertNode(parentId, index, node) {
      const parent = this.nodeOf(parentId);
      if (!parent || !this.accepts(parent) || !node?.tag) return null;
      const fresh = this.adoptIds(JSON.parse(JSON.stringify(node)));
      parent.children = parent.children || [];
      const idx = Math.max(0, Math.min(index ?? parent.children.length, parent.children.length));
      const play = this.flipStart();
      parent.children.splice(idx, 0, fresh);
      this.reindex();
      this.repaint();
      play();
      this.setSelection([fresh.id], fresh.id, "insert");
      this.emit("insert", { id: fresh.id, tag: fresh.tag, parentId, index: idx });
      this.emit("change", { tree: this.getTree() });
      return fresh.id;
    }

    // smart: INTO the target when its slot is open, AFTER it otherwise.
    // Adding "after" a row template lands after the repeater itself — siblings
    // never appear beside a template inside its list. No target: append to root.
    add(node, targetId = this.sel) {
      if (!this.tree) return null;
      const target = targetId ? this.nodeOf(targetId) : null;
      if (!target) return this.insertNode(this.tree.id, (this.tree.children || []).length, node);
      if (this.accepts(target)) return this.insertNode(target.id, (target.children || []).length, node);
      let anchor = target;
      let parent = this.parentOf(anchor.id);
      while (parent && this.isRepeater(parent)) { anchor = parent; parent = this.parentOf(anchor.id); }
      if (!parent) return null;
      const i = parent.children.findIndex((c) => c.id === anchor.id);
      return this.insertNode(parent.id, i + 1, node);
    }

    // headless structural move: what a layers/navigator panel calls on drop.
    // Same rules as canvas drags: item-locked elements stay inside their
    // template, templates unlink when leaving, filled repeaters reject inserts.
    // Returns false when the move is rejected.
    move(rawIds, parentId, index) {
      if (!this.tree || !this.nodeOf(parentId)) return false;
      let ids = (Array.isArray(rawIds) ? rawIds : [rawIds]).filter((id) => id !== this.tree.id && this.nodeOf(id));
      ids = ids.filter((id) => !ids.some((o) => o !== id && this.isAncestor(o, id)));
      if (!ids.length) return false;
      const lockedIn = (id) =>
        !this.isTemplateRoot(id) && this.templateRootOf(id) != null && this.usesItemData(this.nodeOf(id))
          ? this.templateRootOf(id) : null;
      for (const id of ids) {
        const b = lockedIn(id);
        if (b && !(parentId === b || this.isAncestor(b, parentId))) return false;   // would orphan item.* scope
      }
      const parent = this.nodeOf(parentId);
      if (!CONTAINERS.has(parent.tag) || isComponent(parent.tag)) return false;
      if (this.isRepeater(parent) && (parent.children || []).some((c) => !ids.includes(c.id))) return false;
      for (const id of ids) if (id === parentId || this.isAncestor(id, parentId)) return false;
      ids.sort((a, b2) => this.idx.order.get(a) - this.idx.order.get(b2));
      // performDrop indices live in moving-excluded space
      const before = (parent.children || []).slice(0, Math.max(0, index ?? (parent.children || []).length));
      const adj = before.filter((c) => !ids.includes(c.id)).length;
      this.performDrop(ids, { parentId, index: adj }, ids[0]);
      return true;
    }

    // wrap the selection in a new container (Figma group). Same-parent ids wrap
    // as one group in document order; mixed parents wrap the primary only.
    // Wrapping a row template makes the wrapper the new template — legal and useful.
    wrap(wrapperNode, ids = this.normalizedSelection()) {
      ids = (ids || []).filter((id) => id !== this.tree?.id && this.nodeOf(id));
      if (!ids.length || !wrapperNode?.tag || !CONTAINERS.has(wrapperNode.tag) || isComponent(wrapperNode.tag)) return null;
      const parent0 = this.parentOf(ids[0]);
      const group = ids.every((id) => this.parentOf(id) === parent0) ? [...ids] : [ids[0]];
      group.sort((a, b) => this.idx.order.get(a) - this.idx.order.get(b));
      const parent = this.parentOf(group[0]);
      if (!parent) return null;
      const wrapper = this.adoptIds(JSON.parse(JSON.stringify(wrapperNode)));
      wrapper.children = wrapper.children || [];
      const first = parent.children.findIndex((c) => c.id === group[0]);
      const play = this.flipStart();
      const moving = parent.children.filter((c) => group.includes(c.id));
      parent.children = parent.children.filter((c) => !group.includes(c.id));
      wrapper.children.push(...moving);
      parent.children.splice(Math.min(first, parent.children.length), 0, wrapper);
      this.reindex();
      this.repaint();
      play();
      this.setSelection([wrapper.id], wrapper.id, "wrap");
      this.emit("wrap", { id: wrapper.id, tag: wrapper.tag, ids: group });
      this.emit("change", { tree: this.getTree() });
      return wrapper.id;
    }

    // lift a container's children into its place (ungroup). Unwrapping a
    // repeater materializes its children's row bindings first, like unlink.
    unwrap(id = this.sel) {
      const n = this.nodeOf(id);
      const parent = this.parentOf(id);
      if (!n || !parent || !CONTAINERS.has(n.tag) || isComponent(n.tag)) return false;
      const kids = n.children || [];
      if (!kids.length) return false;
      if (this.isRepeater(parent) && kids.length !== 1) return false;   // a repeater keeps exactly one template
      const play = this.flipStart();
      if (this.isRepeater(n)) {
        const rows = asRows(this.evalIn(n.attrs.bind, this.scopeOf(n.id)));
        kids.forEach((k) => this.materializeItem(k, { item: rows[0] || {} }));
      }
      const i = parent.children.findIndex((c) => c.id === id);
      parent.children.splice(i, 1, ...kids);
      this.reindex();
      this.repaint();
      play();
      this.setSelection(kids.map((k) => k.id), kids[0].id, "unwrap");
      this.emit("unwrap", { id, parentId: parent.id, ids: kids.map((k) => k.id) });
      this.emit("change", { tree: this.getTree() });
      return true;
    }

    climb() {
      if (!this.sel) return;
      const parent = this.parentOf(this.sel);
      const from = this.sel;
      if (parent) {
        this.select(parent.id, "climb");
        this.emit("climb", { from, to: parent.id });
      } else this.select(null, "climb");
    }

  }

  /* tree-building helper: StackCanvas.node('vstack', { padding: 20 }, [ … ]) */
  StackCanvas.node = (tag, attrs = {}, children = []) => ({ id: uid(), tag, attrs, children });

  /* ── DSX parser ───────────────────────────────────────────────────────────
     Parses real Stack/DSX markup into the canvas node tree. Returns
     { tree, logic } — logic holds <variable>/<action> for setLogic. Tags the
     renderer can't draw natively map to the nearest container so the layout
     still composes (scaffold/scroll→vstack, sheet/tabs flattened, <row>
     unwrapped). Unknown attributes pass through. */
  const NAMED_STYLES = {
    sheet: { padding: 20, background: "#121212", radius: 24, surface: "sheet" },
    card: { padding: 16, background: "rgba(255,255,255,0.06)", radius: 16 },
    heading: { fontSize: 24, fontWeight: "bold" },
    subheading: { fontSize: 15 },
    rowTitle: { fontSize: 17, fontWeight: "semibold" },
    price: { fontSize: 17, fontWeight: "bold" },
  };
  const TAG_MAP = {
    refreshable: "vstack", form: "vstack",
    sheet: "vstack", pager: "vstack", tabs: "vstack", tabview: "vstack",
    label: "text", input: "textfield", switch: "toggle", glassButton: "button",
    transport: "button", capsuleProgress: "progress", activity: "spinner", date: "datepicker",
  };
  const LOGIC_TAGS = new Set(["variable", "var", "let", "action", "formula", "watch", "script", "functions", "attribute", "component", "style", "event", "expects"]);
  const NUMERIC = new Set(["padding", "paddingH", "paddingX", "paddingV", "paddingY", "paddingTop", "paddingBottom", "paddingLeading", "paddingLeft", "paddingTrailing", "paddingRight", "spacing", "fontSize", "iconSize", "radius", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "opacity", "rotation", "scale", "blur", "borderWidth", "shadow", "zIndex", "columns", "min", "max", "step"]);

  // Direct editor imports are an untrusted content boundary just like the Web
  // compiler. Keep the same inclusive limits so a deck accepted in one DSX web
  // surface cannot exhaust the other one through deep recursion or AST floods.
  const DSX_PARSE_LIMITS = Object.freeze({
    maxDocumentBytes: 4 * 1024 * 1024,
    maxNodes: 50_000,
    maxDepth: 256,
  });
  const CODE_TAGS = new Set(["script", "action", "formula", "variable", "var", "let", "functions"]);

  class DsxParseError extends Error {
    constructor(message, line) {
      super(`${message} (line ${line})`);
      this.name = "DsxParseError";
      this.line = line;
    }
  }

  function isXmlCharacter(codePoint) {
    return codePoint === 0x09 || codePoint === 0x0A || codePoint === 0x0D ||
      (codePoint >= 0x20 && codePoint <= 0xD7FF) ||
      (codePoint >= 0xE000 && codePoint <= 0xFFFD) ||
      (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
  }

  function assertXmlCharacters(source, errorLine) {
    let relativeLine = 0;
    for (let i = 0; i < source.length;) {
      const codePoint = source.codePointAt(i);
      if (!isXmlCharacter(codePoint)) {
        throw new DsxParseError("literal is not a valid XML character", errorLine() + relativeLine);
      }
      if (codePoint === 0x0A) relativeLine += 1;
      i += codePoint > 0xFFFF ? 2 : 1;
    }
  }

  function decodeEntities(s, errorLine) {
    let out = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch !== "&") {
        const codePoint = s.codePointAt(i);
        if (!isXmlCharacter(codePoint)) {
          throw new DsxParseError("literal is not a valid XML character", errorLine());
        }
        out += String.fromCodePoint(codePoint);
        i += codePoint > 0xFFFF ? 2 : 1;
        continue;
      }
      const rest = s.substring(i);
      const named = /^&(amp|lt|gt|quot|apos);/.exec(rest);
      if (named) {
        out += { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named[1]];
        i += named[0].length;
        continue;
      }
      const dec = /^&#(\d+);/.exec(rest);
      const hex = /^&#x([0-9a-fA-F]+);/.exec(rest);
      if (dec || hex) {
        const entity = dec || hex;
        const codePoint = parseInt(entity[1], dec ? 10 : 16);
        if (!Number.isInteger(codePoint) || !isXmlCharacter(codePoint)) {
          throw new DsxParseError("numeric entity is not a valid XML character", errorLine());
        }
        out += String.fromCodePoint(codePoint);
        i += entity[0].length;
        continue;
      }
      out += "&"; // bare ampersands are literal in DSX's smart-entity grammar
      i += 1;
    }
    return out;
  }
  function dsxAttrs(raw) {
    const a = {};
    if (raw.style) for (const nm of String(raw.style).split(/\s+/)) Object.assign(a, NAMED_STYLES[nm] || {});
    for (let [k, v] of Object.entries(raw)) {
      if (k === "style") continue;
      if (NUMERIC.has(k) && typeof v === "string" && !hasMustache(v) && v !== "" && !isNaN(+v)) a[k] = +v;
      else if (v === "true") a[k] = true;
      else if (v === "false") a[k] = false;
      else a[k] = v;
    }
    if (a.grow === true) a.grow = "true";
    return a;
  }
  function dsxNode(tag, rawAttrs, kids) {
    const mapped = TAG_MAP[tag] || tag;
    const a = dsxAttrs(rawAttrs);
    let children = kids;
    if (mapped === "list" && children.length === 1 && children[0].tag === "row") {
      children = children[0].children;
      if (children.length > 1) children = [StackCanvas.node("vstack", {}, children)];
    } else if (mapped === "list" && children.length > 1) {
      children = [StackCanvas.node("vstack", {}, children)];   // a list needs ONE template
    }
    if (tag === "grid" && rawAttrs.columns) a.direction = "horizontal";
    if (tag === "scroll" || tag === "scaffold") a.grow = a.grow || "true";
    return { id: uid(), tag: mapped === "row" ? "vstack" : mapped, attrs: a, children };
  }
  function parseXMLString(input) {
    const source = String(input);
    // The cheap UTF-16 lower bound avoids allocating a second attacker-sized
    // buffer for an already-oversized ASCII document. The encoded-byte check
    // remains authoritative for multi-byte Unicode.
    if (source.length > DSX_PARSE_LIMITS.maxDocumentBytes ||
        new TextEncoder().encode(source).byteLength > DSX_PARSE_LIMITS.maxDocumentBytes) {
      throw new DsxParseError(`document exceeds ${DSX_PARSE_LIMITS.maxDocumentBytes}-byte limit`, 1);
    }

    const cursor = {
      i: 0,
      source,
      eof() { return this.i >= this.source.length; },
      peek() { return this.source[this.i] || ""; },
      startsWith(prefix) { return this.source.startsWith(prefix, this.i); },
      skipWs() { while (!this.eof() && /[ \t\r\n]/.test(this.source[this.i])) this.i += 1; },
      line() {
        let line = 1;
        for (let i = 0; i < this.i && i < this.source.length; i += 1) {
          if (this.source[i] === "\n") line += 1;
        }
        return line;
      },
    };
    const budget = { nodes: 0 };
    const nameChar = (ch) => /[A-Za-z0-9_.:\-]/.test(ch);
    const readName = () => {
      let out = "";
      while (!cursor.eof() && nameChar(cursor.peek())) {
        out += cursor.peek();
        cursor.i += 1;
      }
      return out;
    };

    const parseElement = (depth) => {
      if (depth > DSX_PARSE_LIMITS.maxDepth) {
        throw new DsxParseError(`nesting depth exceeds ${DSX_PARSE_LIMITS.maxDepth}-level limit`, cursor.line());
      }
      budget.nodes += 1;
      if (budget.nodes > DSX_PARSE_LIMITS.maxNodes) {
        throw new DsxParseError(`node count exceeds ${DSX_PARSE_LIMITS.maxNodes}-node limit`, cursor.line());
      }
      if (cursor.peek() !== "<") throw new DsxParseError("expected '<'", cursor.line());
      cursor.i += 1;
      const tag = readName();
      if (!tag) throw new DsxParseError("empty tag name", cursor.line());
      const node = { tag, attrs: {}, kids: [], text: "" };

      for (;;) {
        cursor.skipWs();
        if (cursor.eof()) throw new DsxParseError(`unterminated <${tag}>`, cursor.line());
        if (cursor.startsWith("/>")) { cursor.i += 2; return node; }
        if (cursor.peek() === ">") { cursor.i += 1; break; }
        const name = readName();
        if (!name) throw new DsxParseError(`bad attribute in <${tag}>`, cursor.line());
        cursor.skipWs();
        if (cursor.peek() !== "=") { node.attrs[name] = ""; continue; }
        cursor.i += 1;
        cursor.skipWs();
        const quote = cursor.peek();
        if (quote !== '"' && quote !== "'") {
          throw new DsxParseError(`unquoted value for ${name} in <${tag}>`, cursor.line());
        }
        cursor.i += 1;
        let value = "";
        while (!cursor.eof() && cursor.peek() !== quote) { value += cursor.peek(); cursor.i += 1; }
        if (cursor.eof()) throw new DsxParseError(`unterminated value for ${name} in <${tag}>`, cursor.line());
        cursor.i += 1;
        node.attrs[name] = decodeEntities(value, () => cursor.line());
      }

      // Code bodies are lifted as raw text by the native parsers too. They may
      // contain `<`, `&&`, VT/FF JavaScript whitespace, or markup-looking strings.
      if (CODE_TAGS.has(tag)) {
        const close = `</${tag}>`;
        const end = cursor.source.indexOf(close, cursor.i);
        if (end < 0) throw new DsxParseError(`unterminated <${tag}> code body`, cursor.line());
        node.text = cursor.source.substring(cursor.i, end);
        cursor.i = end + close.length;
        return node;
      }

      for (;;) {
        if (cursor.eof()) throw new DsxParseError(`unterminated <${tag}>`, cursor.line());
        if (cursor.startsWith("<!--")) {
          const end = cursor.source.indexOf("-->", cursor.i + 4);
          if (end < 0) throw new DsxParseError("unterminated comment", cursor.line());
          assertXmlCharacters(cursor.source.substring(cursor.i + 4, end), () => cursor.line());
          cursor.i = end + 3;
          continue;
        }
        if (cursor.startsWith("<![CDATA[")) {
          const end = cursor.source.indexOf("]]>", cursor.i + 9);
          if (end < 0) throw new DsxParseError("unterminated CDATA", cursor.line());
          const text = cursor.source.substring(cursor.i + 9, end);
          assertXmlCharacters(text, () => cursor.line());
          node.text += text;
          cursor.i = end + 3;
          continue;
        }
        if (cursor.startsWith("</")) {
          const closeAt = cursor.i;
          cursor.i += 2;
          const closeName = readName();
          cursor.skipWs();
          if (cursor.peek() !== ">") throw new DsxParseError(`malformed close tag </${closeName}`, cursor.line());
          cursor.i += 1;
          if (closeName !== tag) {
            cursor.i = closeAt;
            throw new DsxParseError(`mismatched close: expected </${tag}>, found </${closeName}>`, cursor.line());
          }
          return node;
        }
        if (cursor.peek() === "<" && nameChar(cursor.source[cursor.i + 1] || "")) {
          node.kids.push(parseElement(depth + 1));
          continue;
        }
        if (cursor.peek() === "<") {
          throw new DsxParseError("unexpected '<' in text — write '&lt;'", cursor.line());
        }
        let text = "";
        while (!cursor.eof() && cursor.peek() !== "<") { text += cursor.peek(); cursor.i += 1; }
        node.text += decodeEntities(text, () => cursor.line());
      }
    };

    let root = null;
    for (;;) {
      cursor.skipWs();
      if (cursor.eof()) break;
      if (cursor.startsWith("<!--")) {
        const end = cursor.source.indexOf("-->", cursor.i + 4);
        if (end < 0) throw new DsxParseError("unterminated comment", cursor.line());
        assertXmlCharacters(cursor.source.substring(cursor.i + 4, end), () => cursor.line());
        cursor.i = end + 3;
        continue;
      }
      if (cursor.startsWith("<?")) {
        const end = cursor.source.indexOf("?>", cursor.i + 2);
        if (end < 0) throw new DsxParseError("unterminated prolog", cursor.line());
        assertXmlCharacters(cursor.source.substring(cursor.i + 2, end), () => cursor.line());
        cursor.i = end + 2;
        continue;
      }
      if (cursor.peek() === "<") {
        const element = parseElement(1);
        if (root !== null) throw new DsxParseError("more than one root element", cursor.line());
        root = element;
        continue;
      }
      throw new DsxParseError(`unexpected top-level content '${cursor.peek()}'`, cursor.line());
    }
    if (root === null) throw new DsxParseError("no root element", 1);
    return root;
  }
  StackCanvas.parseDSX = function (xml) {
    const rootRaw = parseXMLString(xml);

    const logic = { variables: [], actions: [], functions: [] };
    const collectLogic = (raw) => {
      const t = raw.tag;
      if (t === "variable" || t === "var" || t === "let") {
        logic.variables.push({ name: raw.attrs.as || raw.attrs.name, computed: raw.attrs.computed === "true", body: raw.text || "" });
        return true;
      }
      if (t === "action") { logic.actions.push({ name: raw.attrs.as || raw.attrs.name, body: raw.text || "" }); return true; }
      if (t === "functions") { logic.functions.push(raw.text || ""); return true; }
      return LOGIC_TAGS.has(t);
    };
    const build = (raw) => {
      if (raw.tag === "head") { for (const ch of raw.kids || []) build(ch); return null; }   // the document head: collect its declarations, render nothing (mirrors the engine)
      if (collectLogic(raw)) return null;
      const kids = [];
      for (const ch of raw.kids || []) { const b = build(ch); if (b) kids.push(b); }
      const attrs = { ...raw.attrs };
      const textValue = String(raw.text || "").trim();
      if ((raw.tag === "text" || raw.tag === "label") && textValue && attrs.value == null && attrs.bind == null) attrs.value = textValue;
      return dsxNode(raw.tag, attrs, kids);
    };
    const tree = build(rootRaw);
    return { tree, logic };
  };
  StackCanvas.DsxParseError = DsxParseError;
  StackCanvas.DSX_PARSE_LIMITS = DSX_PARSE_LIMITS;
  StackCanvas.prototype.loadDSX = function (xml) {
    const { tree, logic } = StackCanvas.parseDSX(xml);
    this.load(tree);
    if (logic.variables.length || logic.actions.length || logic.functions.length) this.setLogic(logic);
    return { tree, logic };
  };

  /* the canvas icon set (Hugeicons), for host panels that want visual parity */
  StackCanvas.icon = icon;
  StackCanvas.icons = ICONS;

  /* ── headless JSE surface — the conformance seam ──────────────────────────
     StackCanvas.jse runs expressions through the SAME tokenizer + interpreter
     the canvas simulator uses, over a plain scope object whose keys resolve as
     root identifiers — the exact shape of the shared {scope, expression,
     expected} corpus in OpenSource/Conformance/jse/ (Swift is the reference
     implementation; this hook is how the JS runtime PROVES it agrees —
     test/run-jse-conformance.mjs runs the corpus in Node on every check).
     DOM-free by construction: nothing here touches document/window. Also the
     host seam for "evaluate this formula like the device would" (autocomplete
     previews, formula linting, dashboard-side validation). */
  StackCanvas.jse = {
    /* a pure ctx over a plain object; scope keys are root names */
    scopeCtx(scope) {
      const vars = scope && typeof scope === "object" ? scope : {};
      const ctx = {
        jseScope: { vars, platform: "ios" },
        rootValue(name) { return name in vars ? vars[name] : undefined; },
        moduleContext(scheme) { return ((vars.moduleContext ??= {})[scheme] ??= {}); },
        rootContainer() { return null; },
        rootSlot(name) { return name in vars ? { obj: vars, key: name } : null; },
        callFn(fn, args, selfVal) {
          // chain off the ARRIVING ctx so nested arrows keep enclosing params
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
    },
    /* one EXPRESSION → its value (undefined on any parse/eval error — fail-open) */
    evaluate(src, scope) { return jseEval(src, this.scopeCtx(scope)); },
    /* a STATEMENT LIST (variable bodies, on:tap handlers) → its return value */
    run(src, scope) { return jseRun(src, this.scopeCtx(scope)); },
  };

  return StackCanvas;
});
