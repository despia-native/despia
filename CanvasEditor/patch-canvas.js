#!/usr/bin/env node
'use strict';
/*
 * patch-canvas.js — make StackCanvas render DSX 1:1 with the native engine. PURE dsx.* (no legacy $).
 *
 *   node patch-canvas.js  <your-file.html>  [out.html]
 *
 * Transforms YOUR original file (no reproduction): each fix is an exact anchored
 * find→replace. Anything whose anchor doesn't match is reported and SKIPPED — so a
 * mismatch is loud, never silent corruption. After patching, the inlined SDK is
 * extracted and `node --check`ed; a parse failure aborts the write.
 *
 * Grounded in the native engine (file:line in comments):
 *   - JSE resolves ONLY dsx.* (JSE.swift:887 `guard hasPrefix("dsx.")`); $foo → nothing, like device.
 *   - vstack/list don't stretch (StackLive.swift:147, Stack.swift:135)
 *   - native default gaps 4/6/0/10/12 (StackLive:147/156, List:21, Grid:15, Form)
 *   - zstack overlay (StackLive:162); scaffold/pin (Scaffold.swift:13–32); grid N cols (Grid.swift)
 *   - bare button (Button.swift); toggle/progress = accent (Toggle:18, Progress:19); accent #ff2e54 (Stack:4210)
 *
 * Also migrates the EMBEDDED DSX sample $ → dsx. so the demo runs. Your own .dsx decks need the same
 * one-time migration (it's the migration the device already requires): $variable→dsx.variable, etc.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const inFile = process.argv[2];
if (!inFile) { console.error('usage: node patch-canvas.js <your-file.html> [out.html]'); process.exit(1); }
const outFile = process.argv[3] || inFile.replace(/\.html?$/i, '') + '.fixed.html';

let src = fs.readFileSync(inFile, 'utf8');
const skipped = [];
let applied = 0;

function rep(label, find, replace, opts = {}) {
  if (find instanceof RegExp) {
    if (!find.test(src)) { skipped.push(label); return; }
    src = src.replace(find, replace);
  } else {
    if (!src.includes(find)) { skipped.push(label); return; }
    src = opts.all ? src.split(find).join(replace) : src.replace(find, replace);
  }
  applied++;
  console.log('  ✓ ' + label);
}

/* ───────────────────────── CSS ───────────────────────── */

rep('css: vstack/list leading (not stretch) + scroll overflow',
  '.sc-node.vstack, .sc-node.list, .sc-node.scroll { display: flex; flex-direction: column; align-items: stretch; }',
  '.sc-node.vstack, .sc-node.list, .sc-node.scroll { display: flex; flex-direction: column; align-items: flex-start; }\n' +
  '  .sc-node.scroll { overflow-y: auto; min-height: 0; }');

rep('css: zstack overlay + scaffold/pin',
  '.sc-node.zstack { display: flex; flex-direction: column; position: relative; }',
  '.sc-node.zstack { display: grid; place-items: center; position: relative; }\n' +
  '  .sc-node.zstack > * { grid-area: 1 / 1; }\n' +
  '  .sc-node.scaffold { display: flex; flex-direction: column; height: 100%; min-height: 0; }\n' +
  '  .sc-node.scaffold > [data-pin] { flex: 0 0 auto; }\n' +
  '  .sc-node.scaffold > :not([data-pin]) { flex: 1 1 0%; min-height: 0; }');

rep('css: bare button',
  '  .sc-leaf-button {\n' +
  '    display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n' +
  '    padding: 10px 18px; border-radius: 22px; background: rgba(255,255,255,0.1);\n' +
  '    box-shadow: inset 0 1px 0 rgba(255,255,255,0.09), inset 0 -1px 0 rgba(0,0,0,0.18);\n' +
  '    color: #fff; font-weight: 600; font-size: 14px; letter-spacing: -0.1px;\n' +
  '  }',
  '  .sc-leaf-button {\n' +
  '    display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n' +
  '    color: #fff; font-weight: 600; font-size: 14px; letter-spacing: -0.1px;\n' +
  '  }');

rep('css: toggle ON = accent',
  'background: linear-gradient(180deg, #30c452, #34c759); position: relative;',
  'background: #ff2e54; position: relative;');

rep('css: progress track = accent@0.2',
  'height: 6px; border-radius: 3px; background: rgba(255,255,255,0.14); overflow: hidden; align-self: stretch;',
  'height: 6px; border-radius: 3px; background: rgba(255,46,84,0.2); overflow: hidden; align-self: stretch;');

/* ───────────────────────── colors / parser ───────────────────────── */

rep('js: accent #ff2e54', 'if (s === "accent") return "#ff2d55";', 'if (s === "accent") return "#ff2e54";');

rep('js: TAG_MAP drop scaffold/scroll/grid',
  '    scaffold: "vstack", scroll: "vstack", refreshable: "vstack", form: "vstack",\n' +
  '    sheet: "vstack", pager: "vstack", tabs: "vstack", tabview: "vstack", grid: "list",',
  '    refreshable: "vstack", form: "vstack",\n' +
  '    sheet: "vstack", pager: "vstack", tabs: "vstack", tabview: "vstack",');

rep('js: CONTAINERS += grid, scaffold (+ GAP defaults)',
  'const CONTAINERS = new Set(["vstack", "hstack", "zstack", "list", "scroll", "pressable"]);',
  'const CONTAINERS = new Set(["vstack", "hstack", "zstack", "list", "scroll", "grid", "scaffold", "pressable"]);\n' +
  '  const GAP = { vstack: 4, hstack: 6, list: 0, grid: 10, form: 12, scroll: 0, zstack: 0, scaffold: 0 };');

rep('js: native gaps + grid columns (x3)',
  'el.style.gap = (a.spacing ?? (n.tag === "list" ? 8 : 0)) + "px";',
  'el.style.gap = (a.spacing ?? GAP[n.tag] ?? 0) + "px";\n' +
  '        if (n.tag === "grid") { el.style.display = "grid"; el.style.gridTemplateColumns = "repeat(" + Math.max(1, +(a.columns ?? 3) || 3) + ", 1fr)"; }',
  { all: true });

rep('js: isRepeater includes grid',
  'isRepeater(n) { return !!n && n.tag === "list" && n.attrs?.bind != null; }',
  'isRepeater(n) { return !!n && (n.tag === "list" || n.tag === "grid") && n.attrs?.bind != null; }');

rep('js: simulator repeats grid too',
  'if (n.tag === "list" && raw.bind != null && template) {',
  'if ((n.tag === "list" || n.tag === "grid") && raw.bind != null && template) {');

rep('js: mark pin= children for scaffold (x3)',
  'this.applyFrame(el, a);',
  'this.applyFrame(el, a); if (a.pin) el.dataset.pin = a.pin;',
  { all: true });

/* ───────────────────────── JSE namespace layer — PURE dsx.* ───────────────────────── */

// the native dsx.* root (JSE.swift:884–984): reads walk member-by-member; module/action/event are
// __path stubs routed through ctx.call.
rep('js: add dsxData() helper',
  '  const asRows = (v) => (Array.isArray(v) ? v : []);',
  '  const asRows = (v) => (Array.isArray(v) ? v : []);\n' +
  '\n' +
  '  // The native dsx.* root. dsx.variable/item/global/route/cookie/screen/app/attribute resolve by\n' +
  '  // member-walk; dsx.module/action/event are __path stubs routed through ctx.call. (JSE.swift:884-984)\n' +
  '  function dsxData(scope, st) {\n' +
  '    st = st || {};\n' +
  '    st.global ??= {}; st.route ??= {}; st.cookie ??= {};\n' +
  '    st.global.screen ??= {}; st.global.app ??= {};\n' +
  '    st.route.params ??= {}; st.route.query ??= {};\n' +
  '    return {\n' +
  '      variable: st, formula: st,\n' +
  '      global: st.global, screen: st.global.screen, app: st.global.app,\n' +
  '      route: st.route, params: st.route.params, query: st.route.query, path: st.route.path,\n' +
  '      cookie: st.cookie,\n' +
  '      item: scope.item, this: scope.self ?? scope.item, attribute: scope.attrs,\n' +
  '      module: { __path: ["dsx", "module"] }, action: { __path: ["dsx", "action"] }, event: { __path: ["dsx", "event"] },\n' +
  '    };\n' +
  '  }');

// simCtx.rootValue — dsx.* only (+ fetch builtin + bare-name row-shadow, JSE.swift:953). No $.
rep('js: simCtx rootValue → pure dsx.*',
  '        rootValue(name) {\n' +
  '          if (name === "$event" || name === "$package" || name === "$action" || name === "fetch") return { __path: [name] };\n' +
  '          if (name === "$variable" || name === "$formula") return vars;\n' +
  '          if (name === "$global") return (vars.global ??= {});\n' +
  '          if (name === "$route") return (vars.route ??= {});\n' +
  '          if (name === "$cookie") return (vars.cookie ??= {});\n' +
  '          if (name === "$item") return scope.item;\n' +
  '          if (name === "$this") return scope.self;\n' +
  '          if (name === "$attribute") return scope.attrs;\n' +
  '          return undefined;\n' +
  '        },',
  '        rootValue(name) {\n' +
  '          if (name === "dsx") return dsxData(scope, vars);\n' +
  '          if (name === "os" || name === "platform") return "ios";\n' +
  '          if (name === "fetch") return { __path: ["fetch"] };\n' +
  '          if (scope.item  && typeof scope.item  === "object" && name in scope.item)  return scope.item[name];\n' +
  '          if (scope.attrs && typeof scope.attrs === "object" && name in scope.attrs) return scope.attrs[name];\n' +
  '          if (vars && name in vars) return vars[name];\n' +
  '          return undefined;\n' +
  '        },\n' +
  '        moduleContext(scheme) { return ((vars.moduleContext ??= {})[scheme] ??= {}); },');

// simCtx.rootContainer — dsx-scope only (member assignment dsx.variable.x = …)
rep('js: simCtx rootContainer → dsx-scope',
  '        rootContainer(name) {\n' +
  '          if (name === "$variable" || name === "$formula") return vars;\n' +
  '          if (name === "$global") return (vars.global ??= {});\n' +
  '          if (name === "$route") return (vars.route ??= {});\n' +
  '          if (name === "$cookie") return (vars.cookie ??= {});\n' +
  '          if (name === "$item") return scope.item;\n' +
  '          return null;\n' +
  '        },',
  '        rootContainer(name) {\n' +
  '          if (name === "variable" || name === "formula") return vars;\n' +
  '          if (name === "global") return (vars.global ??= {});\n' +
  '          if (name === "route") return (vars.route ??= {});\n' +
  '          if (name === "cookie") return (vars.cookie ??= {});\n' +
  '          if (name === "item") return scope.item;\n' +
  '          return null;\n' +
  '        },');

// simCtx.call — route dsx.module/action/event (the $event/$action handlers below become internal-only)
rep('js: simCtx call → dsx.module/action/event',
  '        call(path, args) {\n' +
  '          if (path[0] === "$event") {',
  '        call(path, args) {\n' +
  '          if (path[0] === "dsx" && path[1] === "event") path = ["$event"];\n' +
  '          else if (path[0] === "dsx" && path[1] === "action") path = ["$action", path[2]];\n' +
  '          else if (path[0] === "dsx" && path[1] === "module") { self.emit("native", { path: path.join("."), args }); return undefined; }\n' +
  '          if (path[0] === "$event") {');

// designCtx.rootValue (read-only, uses `data`) — dsx.* only
rep('js: designCtx rootValue → pure dsx.*',
  '        rootValue(name) {\n' +
  '          if (name === "$variable" || name === "$formula") return data;\n' +
  '          if (name === "$global") return data.global;\n' +
  '          if (name === "$route") return data.route;\n' +
  '          if (name === "$cookie") return data.cookie;\n' +
  '          if (name === "$item") return scope.item;\n' +
  '          if (name === "$this") return scope.self;\n' +
  '          if (name === "$attribute") return scope.attrs;\n' +
  '          return undefined;\n' +
  '        },',
  '        rootValue(name) {\n' +
  '          if (name === "dsx") return dsxData(scope, data);\n' +
  '          if (name === "os" || name === "platform") return "ios";\n' +
  '          if (scope.item  && typeof scope.item  === "object" && name in scope.item)  return scope.item[name];\n' +
  '          if (scope.attrs && typeof scope.attrs === "object" && name in scope.attrs) return scope.attrs[name];\n' +
  '          if (data && name in data) return data[name];\n' +
  '          return undefined;\n' +
  '        },\n' +
  '        moduleContext(scheme) { return ((data.moduleContext ??= {})[scheme] ??= {}); },');

// stateCtx.rootValue (variable bodies, uses `state`, no row scope) — dsx.* only
rep('js: stateCtx rootValue → pure dsx.*',
  '        rootValue(name) {\n' +
  '          if (name === "$variable" || name === "$formula") return state;\n' +
  '          if (name === "$global") return state.global;\n' +
  '          if (name === "$route") return state.route;\n' +
  '          if (name === "$cookie") return state.cookie;\n' +
  '          return undefined;\n' +
  '        },',
  '        rootValue(name) {\n' +
  '          if (name === "dsx") return dsxData({}, state);\n' +
  '          if (name === "os" || name === "platform") return "ios";\n' +
  '          return undefined;\n' +
  '        },\n' +
  '        moduleContext(scheme) { return ((state.moduleContext ??= {})[scheme] ??= {}); },');

// lvalue — only dsx.<scope>.x = … is assignable (the $ ASSIGNABLE branch is removed)
rep('js: lvalue → dsx-only assignment',
  '      let slot;\n' +
  '      if (tk.v in locals) slot = { obj: locals, key: tk.v };\n' +
  '      else if (ASSIGNABLE.has(tk.v)) {\n' +
  '        // namespace roots are never assignable; the first member is required\n' +
  '        const container = ctx.rootContainer ? ctx.rootContainer(tk.v) : null;\n' +
  '        if (!container || !eat(".")) { p = save; return null; }\n' +
  '        const id = peek();\n' +
  '        if (!id || id.t !== "id") { p = save; return null; }\n' +
  '        p++;\n' +
  '        slot = { obj: container, key: id.v };\n' +
  '      } else {\n' +
  '        slot = ctx.rootSlot(tk.v);\n' +
  '        if (!slot) { p = save; return null; }\n' +
  '      }',
  '      let slot;\n' +
  '      if (tk.v === "dsx") {\n' +
  '        if (!eat(".")) { p = save; return null; }\n' +
  '        const seg = peek(); if (!seg || seg.t !== "id") { p = save; return null; }\n' +
  '        const container = ctx.rootContainer ? ctx.rootContainer(seg.v) : null;\n' +
  '        if (!container) { p = save; return null; }\n' +
  '        p++; if (!eat(".")) { p = save; return null; }\n' +
  '        const id0 = peek(); if (!id0 || id0.t !== "id") { p = save; return null; }\n' +
  '        p++; slot = { obj: container, key: id0.v };\n' +
  '      } else if (tk.v in locals) {\n' +
  '        slot = { obj: locals, key: tk.v };\n' +
  '      } else {\n' +
  '        slot = ctx.rootSlot(tk.v);\n' +
  '        if (!slot) { p = save; return null; }\n' +
  '      }');

// dsx.module.<scheme>.context.<var> — a CONSUMER read of a package's published context (Option B:
// the data face is "context", was "state"). Divert `.context` (a read, never a call) into a
// seedable per-render store (ctx.moduleContext); an unseeded scheme yields {} → `.<var>` is
// undefined (exclusion-safe, like a compiled-out package). Calls dsx.module.<scheme>.<action>(…)
// are untouched. Seed in the preview via state.moduleContext[scheme] = {…} (or a loaded test's given.context).
rep('js: simulate dsx.module.<scheme>.context.<var> consumer reads',
  '          if (v && v.__path) { v = { __path: [...v.__path, id.v] }; continue; }',
  '          if (v && v.__path) {\n' +
  '            const np = [...v.__path, id.v];\n' +
  '            if (id.v === "context" && np.length === 4 && np[0] === "dsx" && np[1] === "module" && ctx.moduleContext) { v = ctx.moduleContext(np[2]); continue; }\n' +
  '            v = { __path: np }; continue;\n' +
  '          }');

/* ─────────── declared-test simulation: load a package's dsx.json tests as fixtures ─────────── */

// MOCK MODE — a previewed deck's call dsx.module.<scheme>.<action>(args) resolves from a matching
// loaded fixture (fires its emits, returns its expect) instead of the dead "native" stub, so the
// screen runs end-to-end against declared behavior. No fixture ⇒ unchanged (emit native, undefined).
rep('js: mock dsx.module.<scheme>.<action>() from loaded test fixtures',
  '          else if (path[0] === "dsx" && path[1] === "module") { self.emit("native", { path: path.join("."), args }); return undefined; }',
  '          else if (path[0] === "dsx" && path[1] === "module") {\n' +
  '            const fxHit = self.matchFixture && self.matchFixture(path[2], path.slice(3), args[0]);\n' +
  '            if (fxHit) {\n' +
  '              const invoke = (this && this.callFn) ? (fn, a) => this.callFn(fn, a) : null;\n' +
  '              self.playScenario(fxHit, args[1], invoke);\n' +
  '              self.emit("native", { path: path.join("."), args, fixture: fxHit.name, mocked: true });\n' +
  '              return (fxHit.resolve !== undefined ? fxHit.resolve : fxHit.expect);\n' +
  '            }\n' +
  '            self.emit("native", { path: path.join("."), args }); return undefined;\n' +
  '          }');

// ENGINE METHODS — loadTests(manifest) reads each self-contained action (its own args/resolves/
// stream + tests) into fixtures; matchFixture powers mock mode; runTests() contract-checks each test
// (args vs the action's args, resolve vs its resolves) and emits a testresult per case. Before runHandler.
rep('js: StackCanvas.loadTests / matchFixture / runTests (declared-test simulation)',
  '    runHandler(exprSrc, scope, node, selfVal) {',
  '    // ── declared-test simulation: load a package dsx.json (methods + actions/tests) as fixtures ──\n' +
  '    loadTests(manifest) {\n' +
  '      manifest = manifest || {};\n' +
  '      const fx = []; const scheme = manifest.scheme || "";\n' +
  '      const pushTest = (t, segs, decl) => {\n' +
  '        if (!t || typeof t !== "object") return;\n' +
  '        const p0 = [];\n' +
  '        if (typeof t.name !== "string" || !t.name) p0.push("missing name");\n' +
  '        if (t.resolve !== undefined && t.expect !== undefined) p0.push("both resolve and expect");\n' +
  '        if ((t.resolve !== undefined || t.expect !== undefined) && t.expectError !== undefined) p0.push("both resolve/expect and expectError");\n' +
  '        if (("expectError" in t) && (typeof t.expectError !== "string" || !t.expectError)) p0.push("expectError must be a non-empty string");\n' +
  '        fx.push({\n' +
  '          scheme, segs: segs.slice(), name: t.name || segs.join("."), problems0: p0,\n' +
  '          args: t.args || {}, expect: t.expect, expectError: t.expectError,\n' +
  '          resolve: (t.resolve !== undefined ? t.resolve : t.expect),\n' +
  '          given: (t.given || t.hydrate || null),\n' +
  '          broadcasts: (t.broadcasts || t.emits || []), events: (t.events || []), emits: t.emits || [],\n' +
  '          decl: { args: (decl && decl.args) || {}, returns: decl && decl.returns, stream: !!(decl && decl.stream) } });\n' +
  '      };\n' +
  '      Object.keys(manifest.actions || {}).forEach((path) => {\n' +
  '        if (path === "_note") return; const a = manifest.actions[path]; if (!a || typeof a !== "object") return;\n' +
  '        const decl = { args: a.args || {}, returns: a.resolves, stream: !!a.stream };\n' +
  '        (a.tests || []).forEach((t) => pushTest(t, String(path).split("."), decl));\n' +
  '      });\n' +
  '      this.tests = { scheme, fixtures: fx, hydrate: manifest.hydrate || null };\n' +
  '      this.emit("tests", { scheme, count: fx.length });\n' +
  '      return fx.length;\n' +
  '    }\n' +
  '    matchFixture(scheme, segs, callArg) {\n' +
  '      const t = this.tests; if (!t) return null;\n' +
  '      const a = (callArg && typeof callArg === "object") ? callArg : {};\n' +
  '      return t.fixtures.find((f) => !f.expectError && f.scheme === scheme &&\n' +
  '        f.segs.length === segs.length && f.segs.every((s, i) => s === segs[i]) &&\n' +
  '        Object.keys(f.args).every((k) => JSON.stringify(f.args[k]) === JSON.stringify(a[k]))) || null;\n' +
  '    }\n' +
  '    // play a fixture as a SIMULATION: broadcasts (dsx.broadcast) fire now; events (the dsx.event\n' +
  '    // stream) fire on a clock at each at ms - each as a streamed appevent, and into the deck callback\n' +
  '    // when one was passed: dsx.module.x.action(args, { <event>: fn }) or a single fn.\n' +
  '    // seed a scenario initial state into the live sim stores: hydrate.global -> dsx.global,\n' +
  '    // hydrate.variable -> the surface vars, hydrate.context -> dsx.module.<scheme>.context. Merge,\n' +
  '    // not replace, so unrelated live state survives. Public so a host can stage a scenario too.\n' +
  '    applyHydrate(hydrate, scheme) {\n' +
  '      if (!hydrate || !this.sim) return;\n' +
  '      if (hydrate.global)   Object.assign(this.sim.global ??= {}, hydrate.global);\n' +
  '      if (hydrate.variable) Object.assign(this.sim, hydrate.variable);\n' +
  '      if (hydrate.context)  Object.assign((this.sim.moduleContext ??= {})[scheme] ??= {}, hydrate.context);\n' +
  '    }\n' +
  '    playScenario(fx, cbArg, invoke) {\n' +
  '      this.applyHydrate(this.tests && this.tests.hydrate, fx.scheme);\n' +
  '      this.applyHydrate(fx.given, fx.scheme);\n' +
  '      (fx.broadcasts || []).forEach((e) => this.emit("appevent", { name: fx.scheme, payload: e, fixture: fx.name }));\n' +
  '      const cbObj = (cbArg && typeof cbArg === "object") ? cbArg : null;\n' +
  '      (fx.events || []).forEach((ev) => setTimeout(() => {\n' +
  '        this.emit("appevent", { name: fx.scheme, payload: ev, fixture: fx.name, streamed: true });\n' +
  '        if (invoke && cbObj) { const cb = cbObj.__fn ? cbObj : cbObj[ev.event]; if (cb && cb.__fn) invoke(cb.__fn, [ev.data || {}]); }\n' +
  '      }, Math.max(0, +ev.at || 0)));\n' +
  '    }\n' +
  '    runTests() {\n' +
  '      const t = this.tests; const results = [];\n' +
  '      const typeOf = (v) => Array.isArray(v) ? "array" : (v === null ? "null" : typeof v);\n' +
  '      const okType = (val, ty) => {\n' +
  '        if (!ty) return true;\n' +
  '        const base = (typeof ty === "object") ? (ty.type || "object") : ty;\n' +
  '        if (base === "int" || base === "number") return typeOf(val) === "number";\n' +
  '        if (base === "boolean") return typeOf(val) === "boolean";\n' +
  '        if (base === "string") return typeOf(val) === "string";\n' +
  '        if (base === "array") return typeOf(val) === "array";\n' +
  '        if (base === "object" || base === "json") return typeOf(val) === "object";\n' +
  '        return true;\n' +
  '      };\n' +
  '      (t ? t.fixtures : []).forEach((f) => {\n' +
  '        const problems = (f.problems0 || []).slice();\n' +
  '        const dargs = f.decl.args || {};\n' +
  '        if (!f.expectError) {\n' +
  '          Object.keys(f.args || {}).forEach((k) => { if (!(k in dargs)) problems.push("unknown arg " + k); });\n' +
  '          Object.keys(dargs).forEach((k) => {\n' +
  '            if (k === "_note") return;\n' +
  '            const spec = dargs[k]; const optional = (typeof spec === "object") && spec.optional;\n' +
  '            if (!(k in f.args)) { if (!optional) problems.push("missing arg " + k); return; }\n' +
  '            if (!okType(f.args[k], spec)) problems.push("arg " + k + " wrong type");\n' +
  '          });\n' +
  '        }\n' +
  '        const exp = (f.resolve !== undefined ? f.resolve : f.expect);\n' +
  '        const ret = f.decl.returns;\n' +
  '        const retShape = (ret && typeof ret === "object" && !("type" in ret)) ? ret : null;\n' +
  '        if (exp !== undefined && retShape) {\n' +
  '          if (!exp || typeof exp !== "object") problems.push("resolve must be an object (method returns a shape)");\n' +
  '          else {\n' +
  '            Object.keys(retShape).forEach((k) => { if (k === "_note") return; if (!(k in exp)) problems.push("resolve missing return " + k); else if (!okType(exp[k], retShape[k])) problems.push("return " + k + " wrong type"); });\n' +
  '            Object.keys(exp).forEach((k) => { if (k !== "_note" && !(k in retShape)) problems.push("resolve has undeclared return " + k); });\n' +
  '          }\n' +
  '        } else if (exp !== undefined && ret) {\n' +
  '          const base = (typeof ret === "object") ? (ret.type || "object") : ret;\n' +
  '          if (base !== "void" && !okType(exp, base)) problems.push("resolve is wrong type (expected " + base + ")");\n' +
  '        }\n' +
  '        if (f.given) ["global", "context", "variable"].forEach((s) => { if ((s in f.given) && (typeof f.given[s] !== "object" || !f.given[s])) problems.push("given." + s + " must be an object"); });\n' +
  '        (f.broadcasts || []).forEach((e, i) => { if (!e || typeof e !== "object" || typeof e.event !== "string") problems.push("broadcasts[" + i + "] needs a string event"); });\n' +
  '        if ((f.events || []).length && !f.decl.stream) problems.push("events declared but method is not stream:true");\n' +
  '        let lastAt = -1;\n' +
  '        (f.events || []).forEach((ev, i) => {\n' +
  '          if (!ev || typeof ev.event !== "string") problems.push("event[" + i + "] needs a string event");\n' +
  '          if (ev && ("at" in ev)) { const at = +ev.at || 0; if (at < lastAt) problems.push("event[" + i + "] at must be non-decreasing"); lastAt = at; }\n' +
  '        });\n' +
  '        const pass = problems.length === 0;\n' +
  '        const res = { name: f.name, action: f.segs.join("."), kind: f.expectError ? "error" : "value",\n' +
  '          given: f.given, args: f.args, resolve: f.resolve, expect: f.expect, expectError: f.expectError,\n' +
  '          broadcasts: f.broadcasts, events: f.events, emits: f.emits, pass, problems };\n' +
  '        results.push(res); this.emit("testresult", res);\n' +
  '      });\n' +
  '      const passed = results.filter((r) => r.pass).length;\n' +
  '      this.emit("testsummary", { passed, failed: results.length - passed, total: results.length });\n' +
  '      return { passed, failed: results.length - passed, total: results.length, results };\n' +
  '    }\n' +
  '\n' +
  '    runHandler(exprSrc, scope, node, selfVal) {');

/* ───────────── migrate the EMBEDDED DSX sample $ → dsx. (device resolves only dsx.*) ───────────── */
{
  const before = src;
  src = src.replace(/(<script\s+id="dsx-src"[^>]*>)([\s\S]*?)(<\/script>)/i, (m, o, b, c) =>
    o + b.replace(/\$(variable|formula|global|item|this|attribute|route|cookie|event|action)\b/g, 'dsx.$1')
         .replace(/\$package\b/g, 'dsx.module') + c);
  if (src !== before) { applied++; console.log('  ✓ migrate embedded DSX sample $ → dsx.'); }
  else skipped.push('migrate embedded DSX sample (no legacy $ found — already dsx.*?)');
}

/* ───────────────────────── write + validate ───────────────────────── */

console.log('\n' + applied + ' applied, ' + skipped.length + ' skipped' +
  (skipped.length ? ':\n  ✗ ' + skipped.join('\n  ✗ ') : ''));

const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n;\n');
const tmp = path.join(os.tmpdir(), 'sc-check-' + process.pid + '.js');
fs.writeFileSync(tmp, scripts);
let ok = true;
try { cp.execSync('node --check ' + JSON.stringify(tmp), { stdio: 'pipe' }); }
catch (e) { ok = false; console.error('\n✗ node --check FAILED on the patched JS:\n' + (e.stderr || e.stdout || e).toString()); }
finally { try { fs.unlinkSync(tmp); } catch (_) {} }

if (!ok) { console.error('Aborting: not writing ' + outFile + ' (patched JS does not parse).'); process.exit(2); }
if (skipped.length) console.warn('\nNote: ' + skipped.length + ' patch(es) skipped (anchor not found) — your file may differ there; review the list above.');

fs.writeFileSync(outFile, src);
console.log('\n✓ syntax OK — wrote ' + outFile);
