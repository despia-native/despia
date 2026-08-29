//
//  LogicEditor — web facet (/web/18): the StackLogic SDK as a module-provided
//  component. <LogicCanvas> mounts the formula canvas (the SAME zero-dependency
//  UMD the standalone page loads — no fork, no second engine); LogicEditor.dsx
//  wraps it as the portable component decks and the embed pipeline consume.
//  The bus actions expose the HEADLESS services (dsx.module.logic.*): compile,
//  lift, and evaluate work without a DOM, with device-exact JSE semantics (the
//  shared conformance corpus + the graph fixture laws). The philosophy on the
//  bus too: JSE TEXT is the artifact — compile hands back clean code, lift is
//  the total inverse for tooling that needs the node view.
//  No kernel imports on purpose — everything arrives through the mount ctx.
//
import StackLogic from "../src/logic-editor.js";

const FORWARDED = ["ready", "change", "select", "deselect", "preview", "view"];

const asBool = (v, fallback) => {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return fallback;
};
const asDict = (v) => {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
};
/** ctx.emit payloads ride dsx.this — always a dict, never a bare scalar */
const asPayload = (p) => (p && typeof p === "object" && !Array.isArray(p) ? p : { value: p ?? null });

export default {
  scheme: "logic",
  actions: {
    /** dsx.module.logic.compile({ graph }) → { jse } — graph JSON → clean JSE text */
    compile(ctx) {
      return { jse: StackLogic.compile(asDict(ctx.args("graph")) ?? { v: 1, kind: "expression", nodes: {}, out: { value: null } }) };
    },
    /** dsx.module.logic.lift({ jse, functions? }) → { graph } — total: code-node fallback */
    lift(ctx) {
      const fns = ctx.args("functions");
      return { graph: StackLogic.lift(String(ctx.args("jse") ?? ""), Array.isArray(fns) ? fns : undefined) };
    },
    /** dsx.module.logic.evaluate({ expr, scope? }) — device-exact JSE (corpus-pinned) */
    evaluate(ctx) {
      const scope = asDict(ctx.args("scope")) ?? {};
      return { value: StackLogic.jse.evaluate(String(ctx.args("expr") ?? ""), scope) };
    },
  },
  components: {
    LogicCanvas: {
      mount(host, ctx) {
        host.style.position = "relative";
        host.style.width = "100%";
        host.style.height = "100%";
        host.style.minHeight = "0";

        const richGraph = asDict(ctx.attrs["graph"]);
        const jseAttr = ctx.attrs["jse"];
        const logic = new StackLogic(host, {
          graph: richGraph || undefined,
          jse: !richGraph && typeof jseAttr === "string" && jseAttr ? jseAttr : undefined,
          scope: asDict(ctx.attrs["scope"]) ?? {},
          readOnly: asBool(ctx.attrs["readonly"], false),
          code: asBool(ctx.attrs["code"], false),
          theme: ctx.attrs["theme"] || "auto",
        });
        for (const name of FORWARDED) logic.on(name, (payload) => ctx.emit(name, asPayload(payload)));

        let srcSeq = 0;
        const applied = { graph: richGraph ?? ctx.attrs["graph"], jse: jseAttr, scope: undefined, src: undefined };

        const apply = () => {
          const graphRaw = ctx.attrs["graph"];
          if (graphRaw !== applied.graph) {
            applied.graph = graphRaw;
            const rich = asDict(graphRaw);
            if (rich) logic.load(rich);
          }
          const jse = ctx.attrs["jse"];
          if (jse !== applied.jse) {
            applied.jse = jse;
            if (typeof jse === "string" && jse && !asDict(ctx.attrs["graph"])) logic.load(jse);
          }
          const scopeRaw = ctx.attrs["scope"];   // raw identity — a binding recompute is the change signal
          if (scopeRaw !== applied.scope) {
            applied.scope = scopeRaw;
            const scope = asDict(scopeRaw);
            if (scope) logic.setScope(scope);
          }
          const code = asBool(ctx.attrs["code"], false);
          if (code !== applied.code) {
            applied.code = code;
            logic.setCode(code);
          }
          const theme = ctx.attrs["theme"] || "auto";
          if (theme !== applied.theme) {
            applied.theme = theme;
            logic.setTheme(theme);
          }
          const src = ctx.attrs["src"];
          if (typeof src === "string" && src.length > 0 && src !== applied.src) {
            applied.src = src;
            const seq = ++srcSeq;
            fetch(src, { signal: ctx.signal })
              .then((r) => r.text())
              .then((text) => { if (seq === srcSeq) logic.load(text.trim()); })
              .catch(() => { /* aborted unmount or unreachable src — the formula stays */ });
          }
        };

        apply();
        return {
          update() { apply(); },
          destroy() { logic.destroy(); },
        };
      },
    },
  },
};
