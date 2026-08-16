//
//  css.ts - CSS emission (/web/06 + /web/17). One `@layer` statement rules the
//  cascade, weakest → strongest:
//
//      @layer dsx-tokens, dsx-elements, dsx-theme, dsx-sheets, dsx-inline, dsx-attrs;
//
//  Unlayered author CSS beats every layer by spec — no !important anywhere. Sidecar
//  sheets are owner-scoped by SELECTOR PREFIXING (real descendant selectors — no CSS
//  nesting, the browser floor is Safari 16.4) into dsx-sheets; the static portion of
//  each node's style="" becomes a `[data-dsx=cN]` rule in dsx-inline; the legacy
//  attribute bridge lands in dsx-attrs (strongest).
//

import { splitStyleAttr, legacyAttrToDecls, BRIDGE_ATTRS, LAYER_STATEMENT, type Decl } from "./cssmap.ts";
import type { XmlNode } from "./xml.ts";
import type { ComponentIR } from "./component.ts";

export { LAYER_STATEMENT } from "./cssmap.ts";

/** Prefix every top-level selector in `sheet` with the owner stamp. Handles nested
 *  at-rules (@media/@supports/@container recurse; @keyframes/@font-face verbatim). */
export function scopeSheet(sheet: string, owner: string): string {
  const prefix = `[data-dsx-owner="${owner}"]`;
  return scopeBlock(stripComments(sheet), prefix).trim();
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function scopeBlock(css: string, prefix: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    // skip whitespace
    while (i < css.length && /\s/.test(css[i]!)) { out += css[i]; i += 1; }
    if (i >= css.length) break;
    // read selector / at-rule up to `{` or `;`
    let header = "";
    while (i < css.length && css[i] !== "{" && css[i] !== ";") { header += css[i]; i += 1; }
    if (i >= css.length) break;
    if (css[i] === ";") { out += header + ";"; i += 1; continue; } // @import / @charset
    // read the balanced block
    i += 1;
    let depth = 1;
    let body = "";
    while (i < css.length && depth > 0) {
      const ch = css[i]!;
      if (ch === "{") depth += 1;
      if (ch === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
      body += ch;
      i += 1;
    }
    const trimmed = header.trim();
    if (trimmed.startsWith("@")) {
      const kind = trimmed.split(/[\s(]/, 1)[0]!;
      if (["@media", "@supports", "@container", "@layer", "@scope"].includes(kind)) {
        out += `${trimmed} {\n${scopeBlock(body, prefix)}\n}`;
      } else {
        out += `${trimmed} {${body}}`; // @keyframes / @font-face / @property — verbatim
      }
      continue;
    }
    const scoped = trimmed
      .split(",")
      .map((sel) => {
        const s = sel.trim();
        if (s.length === 0) return s;
        if (s.startsWith(":root") || s.startsWith("html") || s.startsWith("body")) return s;
        return `${prefix} ${s}`;
      })
      .join(", ");
    out += `${scoped} {${body}}`;
  }
  return out;
}

// ── per-node static extraction ───────────────────────────────────────────────────────

export type NodeCss = {
  /** class handle for the node ("" when the node contributes no static css) */
  inlineClass: string;
  attrsClass: string;
};

export class CssCollector {
  private inlineRules = new Map<string, string>(); // decl text → class
  private attrsRules = new Map<string, string>();
  private n = 0;

  /** static style="" declarations → a deduped dsx-inline class */
  inline(decls: Decl[]): string {
    if (decls.length === 0) return "";
    const text = decls.map(([p, v]) => `${p}: ${v}`).join("; ");
    const hit = this.inlineRules.get(text);
    if (hit) return hit;
    const cls = `c${this.n++}`;
    this.inlineRules.set(text, cls);
    return cls;
  }

  /** legacy attribute declarations → a deduped dsx-attrs class */
  attrs(decls: Decl[]): string {
    if (decls.length === 0) return "";
    const text = decls.map(([p, v]) => `${p}: ${v}`).join("; ");
    const hit = this.attrsRules.get(text);
    if (hit) return hit;
    const cls = `a${this.n++}`;
    this.attrsRules.set(text, cls);
    return cls;
  }

  /** Emit only the generated class rules referenced by a closed component slice.
   *  The full registry still calls emit() with no filter. Keeping the filter on the
   *  collector avoids reparsing CSS text when an exposed component is bundled. */
  emit(handles?: ReadonlySet<string>): string {
    const inline = [...this.inlineRules.entries()]
      .filter(([, cls]) => handles === undefined || handles.has(cls))
      .map(([text, cls]) => `[data-dsx~="${cls}"] { ${text}; }`)
      .join("\n");
    const attrs = [...this.attrsRules.entries()]
      .filter(([, cls]) => handles === undefined || handles.has(cls))
      .map(([text, cls]) => `[data-dsx~="${cls}"] { ${text}; }`)
      .join("\n");
    const parts: string[] = [];
    if (inline.length > 0) parts.push(`@layer dsx-inline {\n${inline}\n}`);
    if (attrs.length > 0) parts.push(`@layer dsx-attrs {\n${attrs}\n}`);
    return parts.join("\n");
  }
}

/** Walk a component tree collecting static css; stamps each node's attrs with
 *  `data-dsx` class handles (consumed by @despia/dom at mount). Reactive declarations
 *  stay in the attrs for the runtime to bind. */
export function extractComponentCss(ir: ComponentIR, collector: CssCollector): void {
  const walk = (node: XmlNode): void => {
    const style = node.attrs["style"];
    const handles: string[] = [];
    if (style !== undefined && style.length > 0) {
      const { staticDecls, reactiveDecls } = splitStyleAttr(style);
      const cls = collector.inline(staticDecls);
      if (cls.length > 0) handles.push(cls);
      for (const [prop, value] of staticDecls) {
        if (prop === "flex-direction" && value.startsWith("row")) node.attrs["__row"] = "1";
      }
      if (reactiveDecls.length > 0) {
        node.attrs["__style_reactive"] = reactiveDecls.map(([p, v]) => `${p}:${v}`).join(";");
      }
      delete node.attrs["style"];
    }
    const attrDecls: Decl[] = [];
    for (const [name, value] of Object.entries(node.attrs)) {
      if (!BRIDGE_ATTRS.has(name)) continue;
      if (value.includes("{{")) continue; // reactive legacy attr — runtime path
      const decls = legacyAttrToDecls(name, value);
      if (decls) attrDecls.push(...decls);
    }
    if (attrDecls.length > 0) {
      const cls = collector.attrs(attrDecls);
      if (cls.length > 0) handles.push(cls);
    }
    if (handles.length > 0) node.attrs["__css"] = handles.join(" ");
    node.children.forEach(walk);
  };
  walk(ir.root);
}
