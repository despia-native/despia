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

import { attributeBinding } from "@despia-native/kernel";
import { splitStyleAttr, legacyAttrToDecls, BRIDGE_ATTRS, BRIDGE_CONTEXT_ATTRS, LAYER_STATEMENT, type Decl } from "./cssmap.ts";
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
        // Two alternatives on purpose: the owner stamp lives ON the component's root
        // element (mount.ts stamps data-dsx-owner on the mounted root), so the descendant
        // form alone can never reach the root from its own sheet - a rule on the root's
        // class silently no-ops. The `:is()` self form matches the stamped root itself;
        // :is() parses forgivingly, so a pseudo-element argument (which cannot appear in
        // :is) drops that alternative without invalidating the list.
        return `${prefix} ${s}, ${prefix}:is(${s})`;
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
  private sheetRules: string[] = [];              // owner-scoped named-style rules
  private n = 0;

  /** An owner-scoped rule block (a component's named styles) destined for the
   *  `dsx-sheets` layer — the same layer a sidecar `Foo.css` lands in, so an element's
   *  own attributes and inline style still win by the established layer order. */
  sheet(css: string): void {
    if (css.trim().length > 0) this.sheetRules.push(css.trim());
  }

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
    if (this.sheetRules.length > 0) parts.push(`@layer dsx-sheets {\n${this.sheetRules.join("\n")}\n}`);
    if (inline.length > 0) parts.push(`@layer dsx-inline {\n${inline}\n}`);
    if (attrs.length > 0) parts.push(`@layer dsx-attrs {\n${attrs}\n}`);
    return parts.join("\n");
  }
}

/** Walk a component tree collecting static css; stamps each node's attrs with
 *  `data-dsx` class handles (consumed by @despia-native/dom at mount). Reactive declarations
 *  stay in the attrs for the runtime to bind. */
/** `<style as="card" …/>` head declarations → owner-scoped class rules.
 *
 *  A named style is exactly "a class rule in this component's own sheet", so it folds
 *  through the SAME cssmap an element attribute uses and rides the SAME owner scoping a
 *  sidecar `Foo.css` gets. That places it in the `dsx-sheets` layer, which the layer order
 *  already ranks below `dsx-inline`/`dsx-attrs` - so the element's own attributes win over
 *  the named style without a single new precedence rule. Reactive values ({{ }}) are not
 *  folded: a named style is a static look, and a binding there would bake template text
 *  into a class the runtime never revisits. */
function namedStyleDecls(ir: ComponentIR): Map<string, Decl[]> {
  const table = new Map<string, Decl[]>();
  for (const { as, attrs } of ir.head.styles) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(as)) continue; // not a usable class ident
    const decls: Decl[] = [];
    for (const [name, value] of Object.entries(attrs)) {
      if (!BRIDGE_ATTRS.has(name) || value.includes("{{")) continue;
      const mapped = legacyAttrToDecls(name, value, attrs);
      if (mapped) decls.push(...mapped);
    }
    if (decls.length > 0) table.set(as, decls);
  }
  return table;
}

function namedStyleRules(ir: ComponentIR, table: Map<string, Decl[]>): string {
  const blocks = [...table.entries()]
    .map(([as, decls]) => `.${as} { ${decls.map(([prop, v]) => `${prop}: ${v}`).join("; ")}; }`);
  return blocks.length === 0 ? "" : scopeSheet(blocks.join("\n"), ir.name);
}

export function extractComponentCss(ir: ComponentIR, collector: CssCollector): void {
  const named = namedStyleDecls(ir);
  collector.sheet(namedStyleRules(ir, named));
  const walk = (node: XmlNode): void => {
    const style = node.attrs["style"];
    const handles: string[] = [];
    if (style !== undefined && style.length > 0 && attributeBinding(style).kind === "value") {
      // A sole `{{ … }}` style attribute is a whole DECLARATION-LIST hole (the css-typed
      // override consumption door — `style="{{ dsx.override.extra }}"`). The native
      // renderers interpolate the whole style string before parsing, so splitting this
      // per-declaration here would butcher the expression (a ternary's `:` reads as a
      // property separator). It rides intact for the runtime to evaluate and parse.
      node.attrs["__style_list"] = style;
      delete node.attrs["style"];
    } else if (style !== undefined && style.length > 0) {
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
    // MULTI-CLASS ORDER. Both native renderers merge named styles in CLASS-ATTRIBUTE order
    // (`for (name in cls.split(" ")) base.putAll(...)`), so `class="b a"` lets `a` win. A
    // plain CSS cascade cannot express that - it resolves by SOURCE order - so a static
    // class list is folded here instead, in the author's order, ahead of the element's own
    // declarations (which therefore still win, exactly as `base.putAll(a)` does on native).
    // A class FORMULA cannot be folded at compile time and keeps the sheet rules, whose
    // source order is the head's declaration order.
    const classAttr = node.attrs["class"];
    if (named.size > 0 && classAttr !== undefined && !classAttr.includes("{{")) {
      for (const token of classAttr.split(/\s+/)) {
        const decls = named.get(token);
        if (decls !== undefined) attrDecls.push(...decls);
      }
    }
    // A fold whose CONTEXT is reactive is itself reactive: folding it here would bake the
    // literal template text into a class the runtime then never revisits.
    const reactiveContext = [...BRIDGE_CONTEXT_ATTRS]
      .some((name) => (node.attrs[name] ?? "").includes("{{"));
    for (const [name, value] of Object.entries(node.attrs)) {
      if (!BRIDGE_ATTRS.has(name)) continue;
      if (value.includes("{{") || reactiveContext) continue; // reactive legacy attr — runtime path
      const decls = legacyAttrToDecls(name, value, node.attrs);
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
