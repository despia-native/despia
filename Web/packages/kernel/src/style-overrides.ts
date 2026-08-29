//
//  style-overrides.ts - the style-override plane's pure core (the component STYLE
//  contract, beside the attribute DATA contract). Three laws live here, shared by
//  every renderer and pinned by OpenSource/Conformance/overrides/style-overrides.json:
//  the usage-site SPLIT (`override:<identifier>` leaves the props plane), the typed
//  fail-open RESOLVE (raw value -> coerced value -> declaration default -> null), and
//  the READ chain (item __overrides -> store dsx.override var -> default) that
//  jse.ts's lookup rides for `dsx.override.<name>`.
//
//  Twins: Engine/Android core StyleOverrides.kt, Engine/iOS StyleOverrides.swift.
//  Divergences here are corpus-visible, never silent.
//

import { type Dict } from "./jse/values.ts";

/** A declared override — `<override as= type= default= options= min= max=/>` carried
 *  verbatim from markup (everything is a string at the declaration site; min/max also
 *  accept numbers when built programmatically). */
export type OverrideDecl = {
  as: string;
  type?: string;
  default?: string;
  options?: string;
  min?: number | string;
  max?: number | string;
};

export const OVERRIDE_PREFIX = "override:";

/** An override name must be a legal member read (`dsx.override.<name>`) — identifier
 *  only, no dots, no colons. The platform-suffix words can never appear here: the
 *  platform fold consumes them before any split runs (corpus `reserved`). */
const OVERRIDE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `override:radius` -> `radius`; anything that is not an override -> null. The ONE
 *  membership test every renderer's usage-site split calls. */
export function overrideAttrName(attr: string): string | null {
  if (!attr.startsWith(OVERRIDE_PREFIX)) return null;
  const name = attr.substring(OVERRIDE_PREFIX.length);
  return OVERRIDE_NAME.test(name) ? name : null;
}

/** The split law as one fold (the corpus `split` section runs this): overrides out of
 *  the attribute map, `on:` handlers dropped (they are the event plane), everything
 *  else left as props — including a malformed `override:` spelling, which stays a
 *  visible (and lint-flagged) ordinary attribute rather than vanishing. */
export function splitOverrideAttrs(attrs: { [k: string]: string }): {
  overrides: { [k: string]: string };
  props: { [k: string]: string };
} {
  const overrides: { [k: string]: string } = {};
  const props: { [k: string]: string } = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith("on:")) continue;
    const override = overrideAttrName(name);
    if (override !== null) overrides[override] = value;
    else props[name] = value;
  }
  return { overrides, props };
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const HEX_COLOR = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const FUNCTIONAL_COLOR = /^(rgb|rgba|hsl|hsla)\(/;
const COLOR_TOKEN = /^[A-Za-z]+$/;

function strictNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && NUMERIC.test(value)) return parseFloat(value);
  return null;
}

function clamp(value: number, decl: OverrideDecl): number {
  const min = strictNumber(decl.min ?? null);
  const max = strictNumber(decl.max ?? null);
  let out = value;
  if (min !== null && out < min) out = min;
  if (max !== null && out > max) out = max;
  return out;
}

/** One scalar in, trimmed string out — or null for anything that is not a scalar.
 *  Booleans keep their word form so `text` coercion mirrors JSE string coercion. */
function scalarText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  return null;
}

function balancedFunctional(value: string): boolean {
  if (!value.endsWith(")")) return false;
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0;
}

/** Coerce one raw value by the declaration's type. null = unset-or-invalid (the
 *  caller falls back to the default). The style-plane trim rule applies first: outer
 *  whitespace never carries meaning, and an empty value means unset. */
function coerce(decl: OverrideDecl, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  switch (decl.type ?? "text") {
    case "number": {
      if (typeof raw === "boolean") return null;
      const n = strictNumber(typeof raw === "string" ? raw.trim() : raw);
      return n === null ? null : clamp(n, decl);
    }
    case "length": {
      if (typeof raw === "boolean") return null;
      const text = scalarText(raw);
      if (text === null || text.length === 0) return null;
      const n = strictNumber(text);
      if (n !== null) return clamp(n, decl);
      if (text.includes(";") || text.includes("{") || text.includes("}")) return null;
      return text;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      return null;
    }
    case "enum": {
      const text = scalarText(raw);
      if (text === null || text.length === 0) return null;
      const options = (decl.options ?? "").split(/\s+/).filter((o) => o.length > 0);
      return options.includes(text) ? text : null;
    }
    case "multiEnum": {
      const text = scalarText(raw);
      if (text === null || text.length === 0) return null;
      const options = (decl.options ?? "").split(/\s+/).filter((o) => o.length > 0);
      const tokens = text.split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length === 0) return null;
      for (const token of tokens) if (!options.includes(token)) return null;
      return tokens.join(" ");
    }
    case "color": {
      const text = scalarText(raw);
      if (text === null || text.length === 0) return null;
      if (text.startsWith("#")) return HEX_COLOR.test(text) ? text : null;
      if (FUNCTIONAL_COLOR.test(text)) return balancedFunctional(text) ? text : null;
      return COLOR_TOKEN.test(text) ? text : null;
    }
    case "gradient":
    case "ratio": {
      const text = scalarText(raw);
      if (text === null || text.length === 0) return null;
      if (text.includes(";") || text.includes("{") || text.includes("}")) return null;
      return text;
    }
    case "css": {
      const text = scalarText(raw);
      if (text === null || text.length === 0) return null;
      if (text.includes("{") || text.includes("}")) return null;
      return text;
    }
    default: {
      // text, and any unknown declared type (lint owns rejecting the declaration)
      const text = scalarText(raw);
      return text === null || text.length === 0 ? null : text;
    }
  }
}

/** The resolve law: coerced raw -> coerced default -> null. Never throws — an invalid
 *  live value degrades to the declared look instead of poisoning the pixels. */
export function resolveOverride(decl: OverrideDecl, raw: unknown): unknown {
  const value = coerce(decl, raw);
  if (value !== null) return value;
  if (decl.default !== undefined) return coerce(decl, decl.default);
  return null;
}

/** The whole-plane read (`dsx.override`): the DECLARED contract resolved — undeclared
 *  raw keys never appear, every declared knob answers. Raw chain per name: the item
 *  scope's dict (the tag door) beats the store var (the mount/update door). */
export function resolveOverridePlane(
  decls: Iterable<OverrideDecl>,
  itemOverrides: Dict | null,
  storeOverrides: Dict | null,
): Dict {
  const out: Dict = {};
  for (const decl of decls) {
    const fromItem = itemOverrides?.[decl.as];
    const raw = fromItem !== undefined && fromItem !== null ? fromItem : storeOverrides?.[decl.as];
    out[decl.as] = resolveOverride(decl, raw);
  }
  return out;
}
