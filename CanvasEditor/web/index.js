//
//  CanvasEditor — web facet (/web/18): the StackCanvas SDK as a module-provided
//  component. <EditorCanvas> mounts the design surface (the SAME zero-dependency UMD
//  the standalone page inlines — no fork, no second renderer); StackEditor.dsx wraps
//  it as the portable component decks and the embed pipeline consume. The bus actions
//  expose the SDK's HEADLESS services (dsx.module.editor.*): parse and evaluate work
//  without a DOM, with device-exact JSE semantics (the shared conformance corpus).
//  No kernel imports on purpose — a facet chunk must never carry a second kernel
//  instance; everything arrives through the mount ctx and the action ctx.
//

import StackCanvas from "../src/canvas-editor.js";

/** every SDK event forwards; the StackEditor.dsx head declares the consumable set */
const FORWARDED = [
  "ready", "select", "deselect", "hover", "drill", "climb", "change", "history",
  "dragstart", "drophint", "drop", "cancel", "editstart", "edit", "editinput",
  "delete", "duplicate", "copy", "paste", "insert", "wrap", "unwrap", "unlink",
  "preview", "view", "data", "scope", "logic", "action", "appevent", "native",
];

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
  scheme: "editor",
  actions: {
    /** dsx.module.editor.parse({ dsx }) → { tree, logic } — headless, DOM-free */
    parse(ctx) {
      return StackCanvas.parseDSX(String(ctx.args("dsx") ?? ""));
    },
    /** dsx.module.editor.evaluate({ expr, scope? }) — device-exact JSE (corpus-pinned) */
    evaluate(ctx) {
      const scope = asDict(ctx.args("scope")) ?? {};
      return { value: StackCanvas.jse.evaluate(String(ctx.args("expr") ?? ""), scope) };
    },
  },
  components: {
    EditorCanvas: {
      mount(host, ctx) {
        // the SDK viewport owns real pixels: fill whatever box the deck gave the host
        host.style.position = "relative";
        host.style.width = "100%";
        host.style.height = "100%";
        host.style.minHeight = "0";

        const canvas = new StackCanvas(host, {
          controls: asBool(ctx.attrs["controls"], true),
          frame: typeof ctx.attrs["frame"] === "string" && ctx.attrs["frame"].length > 0 ? ctx.attrs["frame"] : undefined,
          data: asDict(ctx.attrs["data"]) ?? {},
        });
        for (const name of FORWARDED) canvas.on(name, (payload) => ctx.emit(name, asPayload(payload)));

        let srcSeq = 0;
        const applied = { deck: undefined, src: undefined, data: undefined, preview: undefined, zoom: undefined };

        const settleView = () => {
          const zoom = ctx.attrs["zoom"];
          requestAnimationFrame(() => {
            if (zoom === "100") canvas.view100();
            else if (zoom !== "none") canvas.fit();
          });
        };

        const apply = () => {
          const deck = ctx.attrs["deck"];
          if (deck !== applied.deck) {
            applied.deck = deck;
            if (typeof deck === "string" && deck.trim().startsWith("<")) {
              canvas.loadDSX(deck);
              settleView();
            } else {
              const rich = asDict(deck);
              if (rich !== null) {
                // load(), never setTree(): setTree is the silent undo primitive —
                // load resets history and emits "ready" (the embed's boot signal)
                if (rich.tag) canvas.load(rich);
                else if (rich.tree) {
                  canvas.load(rich.tree);
                  if (rich.logic && typeof canvas.setLogic === "function") canvas.setLogic(rich.logic);
                }
                settleView();
              }
            }
          }
          const src = ctx.attrs["src"];
          if (typeof src === "string" && src.length > 0 && src !== applied.src) {
            applied.src = src;
            const seq = ++srcSeq;
            fetch(src, { signal: ctx.signal })
              .then((r) => r.text())
              .then((text) => {
                if (seq !== srcSeq) return; // a later src won the race
                canvas.loadDSX(text);
                settleView();
              })
              .catch(() => { /* aborted unmount or unreachable src — the deck stays */ });
          }
          const dataRaw = ctx.attrs["data"]; // raw identity — a binding recompute is the change signal
          if (dataRaw !== applied.data) {
            applied.data = dataRaw;
            const data = asDict(dataRaw);
            if (data !== null) canvas.setData(data);
          }
          const preview = asBool(ctx.attrs["preview"], false);
          if (preview !== applied.preview) {
            applied.preview = preview;
            canvas.setPreview(preview);
          }
          const zoom = ctx.attrs["zoom"];
          if (zoom !== applied.zoom) {
            if (applied.zoom !== undefined) settleView(); // deck/src loads settle themselves
            applied.zoom = zoom;
          }
        };

        apply();
        return {
          update() { apply(); },
          destroy() { canvas.destroy(); },
        };
      },
    },
  },
};
