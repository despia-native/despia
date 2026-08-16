//
//  stack-editor-element.js — <despia-stack-editor>: the StackCanvas SDK as a REAL
//  custom element, so any host page (plain HTML, React, a DSX app via the Dom
//  surface) mounts the drag-and-drop stack editor with markup alone:
//
//    <script src="canvas-editor.js"></script>
//    <script src="stack-editor-element.js"></script>
//    <despia-stack-editor src="deck.dsx"></despia-stack-editor>
//
//  or an inline deck:
//
//    <despia-stack-editor>
//      <script type="text/dsx"><stack>…</stack></script>
//    </despia-stack-editor>
//
//  The wrapper stays HEADLESS like the SDK: every StackCanvas event re-dispatches
//  as a composed CustomEvent of the same name (select, drop, change, preview, …),
//  the full imperative API rides the `canvas` property, and the tree survives a
//  DOM move (disconnect stashes it, reconnect restores). Light DOM by design: the
//  SDK owns a singleton document-level stylesheet, a body-level drag ghost, and
//  window listeners — shadow encapsulation would sever all three (README: the
//  canvas is a design SURFACE, not a widget). Requires canvas-editor.js loaded
//  first (script tag or require); in Node/headless this file is a silent no-op.
//
(function (root) {
  "use strict";
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return; // headless: no-op
  if (customElements.get("despia-stack-editor")) return;

  var BOOL = function (v, dflt) {
    if (v === null || v === undefined) return dflt;
    return v !== "false" && v !== "0" && v !== "off";
  };

  class DespiaStackEditor extends HTMLElement {
    static get observedAttributes() { return ["preview", "src", "zoom"]; }

    constructor() {
      super();
      this._canvas = null;
      this._mount = null;
      this._stash = null;      // tree stashed across DOM moves
      this._loadSeq = 0;       // stale-src guard
    }

    connectedCallback() {
      if (this._canvas) return;
      var StackCanvas = root.StackCanvas;
      if (!StackCanvas) {
        console.error("[despia-stack-editor] StackCanvas is not loaded — include canvas-editor.js first");
        return;
      }
      if (!this.style.display) this.style.display = "block";
      if (!this.style.minHeight) this.style.minHeight = "320px";
      this._mount = document.createElement("div");
      this._mount.style.width = "100%";
      this._mount.style.height = "100%";
      this._mount.style.minHeight = "inherit";
      this.appendChild(this._mount);

      var opts = {
        controls: BOOL(this.getAttribute("controls"), true),
        frame: BOOL(this.getAttribute("frame"), true),
      };
      var dataAttr = this.getAttribute("data");
      if (dataAttr) { try { opts.data = JSON.parse(dataAttr); } catch (e) { console.warn("[despia-stack-editor] data attribute is not valid JSON — ignored"); } }
      if (this._stash) opts.tree = this._stash;

      this._canvas = new StackCanvas(this._mount, opts);
      var self = this;
      this._canvas.on("*", function (name, payload) {
        self.dispatchEvent(new CustomEvent(name, { detail: payload, composed: true }));
      });

      // content: the src attribute wins; else an inline <script type="text/dsx"> deck
      var src = this.getAttribute("src");
      if (src && !this._stash) {
        this._load(src);
      } else if (!this._stash) {
        var inline = this.querySelector('script[type="text/dsx"]');
        if (inline && inline.textContent && inline.textContent.trim()) {
          this._canvas.loadDSX(inline.textContent);
        }
      }
      this._stash = null;
      if (this.hasAttribute("preview")) this._canvas.setPreview(BOOL(this.getAttribute("preview"), true));
    }

    disconnectedCallback() {
      if (!this._canvas) return;
      try { this._stash = this._canvas.getTree(); } catch (e) { this._stash = null; }
      this._canvas.destroy();
      this._canvas = null;
      if (this._mount && this._mount.parentNode === this) this.removeChild(this._mount);
      this._mount = null;
    }

    attributeChangedCallback(name, _old, value) {
      if (!this._canvas) return;
      if (name === "preview") this._canvas.setPreview(BOOL(value, value !== null));
      if (name === "src" && value) this._load(value);
      if (name === "zoom" && value === "fit") this._canvas.fit();
    }

    _load(src) {
      var self = this;
      var seq = ++this._loadSeq;
      fetch(src).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      }).then(function (xml) {
        if (self._canvas && seq === self._loadSeq) self._canvas.loadDSX(xml);
      }).catch(function (e) {
        console.error("[despia-stack-editor] failed to load " + src + ": " + (e && e.message ? e.message : e));
        self.dispatchEvent(new CustomEvent("loaderror", { detail: { src: src, message: String(e && e.message || e) }, composed: true }));
      });
    }

    /** the full imperative SDK — everything the events don't cover */
    get canvas() { return this._canvas; }
    get tree() { return this._canvas ? this._canvas.getTree() : this._stash; }
    set tree(t) { if (this._canvas) this._canvas.setTree(t); else this._stash = t; }
    loadDSX(xml) { if (this._canvas) this._canvas.loadDSX(xml); }
    setData(d) { if (this._canvas) this._canvas.setData(d); }
    setPreview(on) { if (this._canvas) this._canvas.setPreview(!!on); }
    select(id, opts) { if (this._canvas) this._canvas.select(id, opts); }
    fit() { if (this._canvas) this._canvas.fit(); }
    undo() { if (this._canvas) this._canvas.undo(); }
    redo() { if (this._canvas) this._canvas.redo(); }
  }

  customElements.define("despia-stack-editor", DespiaStackEditor);
  root.DespiaStackEditor = DespiaStackEditor;
})(typeof self !== "undefined" ? self : globalThis);
