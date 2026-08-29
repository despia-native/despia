//
//  regex.ts - JSERegex, the TS twin. On the web the host regex engine IS JavaScript's,
//  so /…/flags literals run native RegExp — the reference semantics with none of the
//  java.util.regex seams. Template expansion keeps NSRegularExpression's `$0…$n` rules
//  (longest valid digit run, `\$` literal dollar, unmatched group expands empty).
//

import { NSNull, string as jseString, isDict, type Dict } from "./values.ts";
import { graphemes } from "./values.ts";

type Compiled = { re: RegExp; global: boolean };

const cache = new Map<string, Compiled>();

/** If position `i` begins an UNBOUNDED quantifier (`*`, `+`, or `{n,}`), return the index
 *  just past it (incl. a trailing lazy `?`); else -1. `{n}` and `{n,m}` are BOUNDED (finite
 *  work) so they are not counted. */
function unboundedQuantAt(source: string, i: number): number {
  const ch = source[i];
  if (ch === "*" || ch === "+") return source[i + 1] === "?" ? i + 2 : i + 1;
  if (ch === "{") {
    const close = source.indexOf("}", i);
    if (close < 0) return -1;
    if (/^\d+,$/.test(source.substring(i + 1, close))) return source[close + 1] === "?" ? close + 2 : close + 1;
  }
  return -1;
}

/** Reject catastrophic-backtracking patterns — star height ≥ 2, i.e. a group whose body
 *  holds an unbounded quantifier and which is ITSELF unbounded-quantified: `(a+)+`, `(a*)*`,
 *  `(\d+)*`, `(.*)*`. A synchronous regex has no timeout on the web's single event loop, so
 *  an SSR request carrying such a pattern would freeze the whole process; we reject at
 *  compile (graceful no-match) rather than run it — bounded like every other loop in the
 *  kernel. Conservative by design (some safe nested quantifiers are refused); the author
 *  rewrites, nothing crashes. Twin of Jse.kt / Stack.swift `reDoSProne`. */
export function reDoSProne(source: string): boolean {
  const bodyUnbounded: boolean[] = []; // per open group: does its body hold an unbounded quantifier?
  let inClass = false;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === "\\") { i += 2; continue; }                 // escaped atom — skip the pair
    if (inClass) { if (ch === "]") inClass = false; i += 1; continue; }
    if (ch === "[") { inClass = true; i += 1; continue; }
    if (ch === "(") { bodyUnbounded.push(false); i += 1; continue; }
    if (ch === ")") {
      const inner = bodyUnbounded.pop() ?? false;
      const q = unboundedQuantAt(source, i + 1);
      if (q >= 0) {
        if (inner) return true;                            // (…unbounded…)<unbounded> → height 2
        if (bodyUnbounded.length > 0) bodyUnbounded[bodyUnbounded.length - 1] = true;
        i = q; continue;
      }
      i += 1; continue;
    }
    const q = unboundedQuantAt(source, i);                 // a bare unbounded quantifier on an atom
    if (q >= 0) {
      if (bodyUnbounded.length > 0) bodyUnbounded[bodyUnbounded.length - 1] = true;
      i = q; continue;
    }
    i += 1;
  }
  return false;
}

/** The arg can be a regex dict ({__regex, source, flags}) or a plain string (string-arg
 *  replace/split are LITERAL, per JS — handled by the callers). */
function compiled(v: unknown): Compiled | null {
  if (!isDict(v)) return null;
  const d = v as Dict;
  if (!d["__regex"]) return null;
  const pattern = jseString(d["source"]);
  const flags = jseString(d["flags"]);
  const key = flags + "" + pattern;
  const hit = cache.get(key);
  if (hit) return hit;
  if (reDoSProne(pattern)) {
    console.warn(`[JSE regex] rejected a potentially-catastrophic pattern (nested unbounded quantifier): /${pattern}/${flags}`);
    return null;
  }
  let opts = "";
  if (flags.includes("i")) opts += "i";
  if (flags.includes("m")) opts += "m";
  if (flags.includes("s")) opts += "s";
  if (flags.includes("u")) opts += "u";
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts + "g"); // always compiled global; match() honors the flag
  } catch {
    console.warn(`[JSE regex] invalid pattern: /${pattern}/${flags}`);
    return null;
  }
  const c = { re, global: flags.includes("g") };
  if (cache.size > 128) cache.clear();
  cache.set(key, c);
  return c;
}

function findAll(re: RegExp, s: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m);
    if (m[0].length === 0) re.lastIndex += 1; // zero-width match — never spin
  }
  return out;
}

type JSERegexApi = {
  test(s: string, regex: unknown): boolean;
  match(s: string, regex: unknown): unknown;
  matchAll(s: string, regex: unknown): unknown[];
  search(s: string, regex: unknown): number;
  replace(s: string, pattern: unknown, template: string, all: boolean): string;
  split(s: string, pattern: unknown, limit: number): unknown[];
};

const JSE_REGEX_FULL: JSERegexApi = {
  test(s: string, regex: unknown): boolean {
    const c = compiled(regex);
    if (!c) return false;
    c.re.lastIndex = 0;
    return c.re.test(s);
  },

  match(s: string, regex: unknown): unknown {
    const c = compiled(regex);
    if (!c) return null;
    const all = findAll(c.re, s);
    if (c.global) {
      if (all.length === 0) return null;
      return all.map((m) => m[0]);
    }
    const m = all[0];
    if (!m) return null;
    const out: unknown[] = [];
    for (let i = 0; i < m.length; i++) out.push(m[i] ?? NSNull); // unmatched group → NSNull
    return out;
  },

  /** Every match as a match ARRAY ([full, g1, …] — unmatched group → NSNull), always
   *  global semantics (the JS matchAll contract; the `g` flag is implied). */
  matchAll(s: string, regex: unknown): unknown[] {
    const c = compiled(regex);
    if (!c) return [];
    return findAll(c.re, s).map((m) => {
      const out: unknown[] = [];
      for (let i = 0; i < m.length; i++) out.push(m[i] ?? NSNull);
      return out;
    });
  },

  search(s: string, regex: unknown): number {
    const c = compiled(regex);
    if (!c) return -1;
    c.re.lastIndex = 0;
    const m = c.re.exec(s);
    return m ? m.index : -1; // UTF-16 index, like JS/NSString
  },

  replace(s: string, pattern: unknown, template: string, all: boolean): string {
    const c = compiled(pattern);
    if (c) {
      let out = "";
      let last = 0;
      for (const m of findAll(c.re, s)) {
        out += s.substring(last, m.index) + expand(template, m);
        last = m.index + m[0].length;
        if (!(all || c.global)) break; // first match only (JS `replace` with no /g)
      }
      out += s.substring(last);
      return out;
    }
    // String pattern — LITERAL (JS semantics: replace = first, replaceAll = every)
    const find = jseString(pattern);
    if (find.length === 0) return s;
    if (all) return s.split(find).join(template);
    const r = s.indexOf(find);
    if (r < 0) return s;
    return s.substring(0, r) + template + s.substring(r + find.length);
  },

  split(s: string, pattern: unknown, limit: number): unknown[] {
    let parts: string[];
    const c = compiled(pattern);
    if (c) {
      const out: string[] = [];
      let start = 0;
      for (const m of findAll(c.re, s)) {
        out.push(s.substring(start, m.index));
        start = m.index + m[0].length;
      }
      out.push(s.substring(start));
      parts = out;
    } else {
      const sep = jseString(pattern);
      parts = sep.length === 0 ? graphemes(s) : s.split(sep);
    }
    if (limit > 0 && parts.length > limit) parts = parts.slice(0, limit);
    return parts;
  },
};

/** The engine-less twin (the `__DSX_OPTIONAL_JS_GLOBALS__` precedent in core.ts): a build
 *  whose closed slice can never MINT a regex value (no `/…/` literal, no `RegExp`/`regex`
 *  name, no foreign payload — embed-entry.ts `registryUsesRegex`) folds the compiler,
 *  the reDoS guard and the template expander away. The literal string-pattern halves of
 *  `replace`/`split` keep their exact reference semantics: those take plain strings, which
 *  every slice can mint. A regex-typed argument cannot exist in such a build, so the
 *  regex-only entries answer exactly like FULL answers a non-regex argument. */
const JSE_REGEX_ABSENT: JSERegexApi = {
  test: () => false,
  match: () => null,
  matchAll: () => [],
  search: () => -1,
  replace(s: string, pattern: unknown, template: string, all: boolean): string {
    const find = jseString(pattern);
    if (find.length === 0) return s;
    if (all) return s.split(find).join(template);
    const r = s.indexOf(find);
    if (r < 0) return s;
    return s.substring(0, r) + template + s.substring(r + find.length);
  },
  split(s: string, pattern: unknown, limit: number): unknown[] {
    const sep = jseString(pattern);
    let parts: string[] = sep.length === 0 ? graphemes(s) : s.split(sep);
    if (limit > 0 && parts.length > limit) parts = parts.slice(0, limit);
    return parts;
  },
};

export const JSERegex: JSERegexApi =
  (globalThis as typeof globalThis & { __DSX_OPTIONAL_REGEX__?: boolean })
    .__DSX_OPTIONAL_REGEX__ !== false ? JSE_REGEX_FULL : JSE_REGEX_ABSENT;

/** NSRegularExpression's template semantics: `$0…$n` group refs (longest valid digit
 *  run), `\$` a literal dollar, `\\` a literal backslash; unmatched/out-of-range
 *  expands empty. */
function expand(template: string, m: RegExpExecArray): string {
  const groupCount = m.length - 1;
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === "\\" && i + 1 < template.length) { out += template[i + 1]; i += 2; continue; }
    if (ch === "$" && i + 1 < template.length && template[i + 1]! >= "0" && template[i + 1]! <= "9") {
      let j = i + 1;
      let g = template.charCodeAt(j) - 48; // first digit always consumed
      j += 1;
      while (j < template.length && template[j]! >= "0" && template[j]! <= "9") {
        const cand = g * 10 + (template.charCodeAt(j) - 48);
        if (cand > groupCount) break;
        g = cand;
        j += 1;
      }
      if (g <= groupCount) out += m[g] ?? "";
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
