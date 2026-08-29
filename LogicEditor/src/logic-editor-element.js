/* <despia-logic-editor> — the StackLogic SDK as a real custom element.
   Load AFTER src/logic-editor.js (this file wires window.StackLogic).

     <script src="src/logic-editor.js"></script>
     <script src="src/logic-editor-element.js"></script>
     <despia-logic-editor jse="a > 3 ? 'big' : 'small'" scope='{"a": 5}'
                          style="display:block;height:600px"></despia-logic-editor>

   Every attribute is observed (writing re-applies reactively); rich values
   (a graph object, a scope object) ride the same-named JS PROPERTY with no
   JSON round-trip. Every SDK event re-dispatches as a composed CustomEvent of
   the same name with the payload in `detail`; the full imperative handle rides
   the `logic` property (`el.logic.getJSE()`). Light DOM by design, matching
   <despia-stack-editor>: the SDK owns document-level styles and window
   listeners during drags. */
(function () {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  const StackLogic = window.StackLogic;
  if (!StackLogic) { console.error("[despia-logic-editor] load src/logic-editor.js first"); return; }

  const EVENTS = ["ready", "change", "select", "deselect", "preview", "view"];
  const parseRich = (v) => {
    if (v == null || v === "") return null;
    if (typeof v === "object") return v;
    const t = String(v).trim();
    if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch { return null; } }
    return null;
  };
  const asBool = (v) => v === true || v === "" || v === "true";

  class DespiaLogicEditor extends HTMLElement {
    static get observedAttributes() { return ["graph", "jse", "scope", "src", "readonly", "code", "theme"]; }
    constructor() {
      super();
      this._props = {};        // property writes (rich values win over attributes)
      this._srcSeq = 0;
      this.logic = null;
    }
    connectedCallback() {
      if (!this._mount) {
        this._mount = this.ownerDocument.createElement("div");
        this._mount.style.width = "100%";
        this._mount.style.height = "100%";
        this.appendChild(this._mount);
      }
      this._build();
    }
    disconnectedCallback() {
      if (this.logic) { this.logic.destroy(); this.logic = null; }
      this._applied = undefined;
    }
    attributeChangedCallback() { if (this.isConnected) this._apply(); }

    _read(name) {
      if (name in this._props) return this._props[name];
      return this.getAttribute(name);
    }
    _build() {
      if (this.logic) { this.logic.destroy(); this.logic = null; }
      const graph = parseRich(this._read("graph"));
      const jse = graph ? null : this._read("jse");
      this.logic = new StackLogic(this._mount, {
        graph: graph || undefined,
        jse: jse != null && jse !== "" ? String(jse) : undefined,
        scope: parseRich(this._read("scope")) || {},
        readOnly: asBool(this._read("readonly")),
        code: asBool(this._read("code")),
        theme: this._read("theme") || "auto",
      });
      for (const name of EVENTS) {
        this.logic.on(name, (detail) =>
          this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })));
      }
      this._applied = {
        graph: this._read("graph"), jse: this._read("jse"),
        scope: this._read("scope"), readonly: asBool(this._read("readonly")),
        code: asBool(this._read("code")), theme: this._read("theme") || "auto",
      };
      this._loadSrc();
    }
    _apply() {
      if (!this.logic) { this._build(); return; }
      const a = this._applied || {};
      const graph = this._read("graph"), jse = this._read("jse"), scope = this._read("scope");
      const ro = asBool(this._read("readonly"));
      const code = asBool(this._read("code"));
      const theme = this._read("theme") || "auto";
      if (ro !== a.readonly) { this._build(); return; }   // readOnly is structural
      if (graph !== a.graph && graph != null && graph !== "") {
        const rich = parseRich(graph);
        if (rich) this.logic.load(rich);
      } else if (jse !== a.jse && jse != null && jse !== "") {
        this.logic.load(String(jse));
      }
      if (scope !== a.scope) this.logic.setScope(parseRich(scope) || {});
      if (code !== a.code) this.logic.setCode(code);
      if (theme !== a.theme) this.logic.setTheme(theme);
      this._applied = { graph, jse, scope, readonly: ro, code, theme };
      this._loadSrc();
    }
    _loadSrc() {
      const src = this._read("src");
      if (typeof src !== "string" || !src || src === this._srcApplied) return;
      this._srcApplied = src;
      const seq = ++this._srcSeq;
      fetch(src)
        .then((r) => r.text())
        .then((text) => { if (seq === this._srcSeq && this.logic) this.logic.load(text.trim()); })
        .catch(() => { /* unreachable src — the current formula stays */ });
    }
  }

  for (const name of ["graph", "jse", "scope", "src", "readonly", "code", "theme"]) {
    Object.defineProperty(DespiaLogicEditor.prototype, name, {
      get() { return name in this._props ? this._props[name] : this.getAttribute(name); },
      set(v) {
        this._props[name] = v;
        if (this.isConnected) this._apply();
      },
    });
  }

  if (!customElements.get("despia-logic-editor")) customElements.define("despia-logic-editor", DespiaLogicEditor);
})();
