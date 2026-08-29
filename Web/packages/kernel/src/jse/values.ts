//
//  values.ts - the JSE value model. TS twin of Engine/JSE.swift / Jse.kt (same names,
//  same arguments, same behaviors) — see the NUMBER MODEL / NULL MODEL contract there.
//
//  Every runtime ships ONE coercion table; the conformance corpus
//  (OpenSource/Conformance/jse) is the referee. Values are `unknown`; every number the
//  evaluator produces is a JS number (double). Plain objects are dicts, arrays are lists.
//

/** Foundation's NSNull, as the JSE scope sentinel: a bound-but-null lambda param /
 *  const / destructured key is stored as NSNull — observable: it shadows outer names,
 *  it is truthy, it stringifies "<null>", it does not number-coerce. */
export const NSNull: { readonly __nsnull: true; toString(): string } = {
  __nsnull: true,
  toString() { return "<null>"; },
};

export function isNSNull(v: unknown): boolean {
  return v === NSNull;
}

export type Dict = { [key: string]: unknown };

export function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v) && v !== NSNull && !isLambda(v);
}

/** An arrow function captured as a VALUE — invoked only by the bounded higher-order
 *  fns or a user-function call. `captured` is the CREATION scope snapshot. */
export type LambdaParam = {
  name: string | null;
  keys: string[];
  /** default-expression tokens (wave 3) — evaluated at CALL time in the CALLEE scope
   *  when the incoming arg is missing/null (JSE's ONE missing value). Named params only. */
  def?: import("./tokens.ts").Token[];
  /** rest param (wave 3) — binds the REMAINING args as an array (empty when none). */
  rest?: boolean;
  /**
   * A DESTRUCTURED param, in full: `([k, v]) => …`, `({ a: { b } }) => …`, defaults and rest
   * included. `keys` only ever expressed a flat `{ a, b }`, so the single most common data
   * idiom in JS — `Object.entries(o).map(([k, v]) => …)` — bound the whole pair to one name
   * and produced a stringified row instead of failing. Present ⇒ it wins over `keys`.
   */
  pattern?: import("./jse.ts").DeclPattern;
};
export type StackLambda = {
  __lambda: true;
  params: LambdaParam[];
  body: import("./tokens.ts").Token[];
  block: boolean;
  captured: Dict;
  /** compiled path: a real JS closure over the same scope contract; when present it
   *  wins over the token body (callLambda dispatches here). */
  native?: (args: unknown[], base: Dict | null) => unknown;
};

export function isLambda(v: unknown): v is StackLambda {
  return typeof v === "object" && v !== null && (v as { __lambda?: unknown }).__lambda === true;
}

/** A parameterized reactive formula: `<formula name="x" foo="…">…</formula>`. */
export type StackFormula = { inputs: Dict & { [k: string]: string }; body: string };

/** Swift `.whitespaces` (space separators + tab — NO newlines): the trim used by
 *  JSE.eval, the `trim` builtins and `required`. Distinct from `.trim()` on blocks. */
export function isWhitespaceOnly(c: string): boolean {
  if (c === "\t") return true;
  // Unicode Zs (space separator) — the JS regex class matches Character.SPACE_SEPARATOR
  return /^\p{Zs}$/u.test(c);
}

export function trimWhitespaceOnly(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isWhitespaceOnly(s[start]!)) start += 1;
  while (end > start && isWhitespaceOnly(s[end - 1]!)) end -= 1;
  return s.substring(start, end);
}

/** Swift `String.count` counts extended grapheme clusters. Intl.Segmenter is the web's
 *  grapheme segmenter — same seam note as the JVM BreakIterator twin. */
const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

export function graphemes(s: string): string[] {
  if (s.length === 0) return [];
  if (segmenter) {
    const out: string[] = [];
    for (const seg of segmenter.segment(s)) out.push(seg.segment);
    return out;
  }
  return Array.from(s); // code-point fallback (no Segmenter host)
}

export function charCount(s: string): number {
  // fast path: no surrogates / combining marks → length is the grapheme count
  let simple = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x0300) { simple = false; break; }
  }
  if (simple) return s.length;
  return graphemes(s).length;
}

/** Swift `Double(String)` grammar (the `number()` string coercion): full-string parse,
 *  no whitespace tolerance, no "1f"/"1d" suffixes, "inf"/"infinity"/"nan"
 *  case-insensitive, bare hex ("0x1F") accepted. Partial numbers ("12px") are null. */
export function swiftDouble(s: string): number | null {
  if (s.length === 0) return null;
  if (/\s/.test(s[0]!) || /\s/.test(s[s.length - 1]!)) return null;
  const neg = s.startsWith("-");
  const body = s.startsWith("+") || neg ? s.substring(1) : s;
  if (body.length === 0) return null;
  const lower = body.toLowerCase();
  if (lower === "inf" || lower === "infinity") return neg ? -Infinity : Infinity;
  if (lower === "nan") return NaN;
  if (lower.startsWith("0x")) {
    // hex — integer mantissa or hex-float with binary exponent (Swift grammar)
    if (/^0x[0-9a-f]+$/.test(lower)) {
      const v = parseInt(lower, 16);
      return neg ? -v : v;
    }
    if (/^0x[0-9a-f]*(\.[0-9a-f]*)?p[+-]?[0-9]+$/.test(lower)) {
      const m = /^0x([0-9a-f]*)(?:\.([0-9a-f]*))?p([+-]?[0-9]+)$/.exec(lower)!;
      const intPart = m[1] ?? "";
      const fracPart = m[2] ?? "";
      if (intPart.length === 0 && fracPart.length === 0) return null;
      let mant = 0;
      for (const c of intPart) mant = mant * 16 + parseInt(c, 16);
      let scale = 1 / 16;
      for (const c of fracPart) { mant += parseInt(c, 16) * scale; scale /= 16; }
      const v = mant * Math.pow(2, parseInt(m[3]!, 10));
      return neg ? -v : v;
    }
    return null;
  }
  const last = body[body.length - 1]!.toLowerCase();
  if (last === "f" || last === "d") return null; // Java/CSS suffix tolerance Swift rejects
  // Swift Double(String) decimal grammar: digits [. digits] [e[+-]digits] — reject the
  // JS-only laxness (binary/octal literals, "1_000", empty → 0).
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(body)) return null;
  const v = Number(body);
  if (Number.isNaN(v)) return null;
  return neg ? -v : v;
}

export function number(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return swiftDouble(v);
  if (isDict(v)) {
    const d = (v as Dict)["__date"];
    return typeof d === "number" ? d : null; // JS Date coerces to its ms
  }
  return null;
}

// wired by core.ts (JSECore.stringCoerce) — breaks the import cycle values ⇄ globals
let stringCoerceHook: ((d: Dict) => string | null) | null = null;
export function setStringCoerce(fn: (d: Dict) => string | null): void {
  stringCoerceHook = fn;
}

export function string(v: unknown): string {
  if (isDict(v) && stringCoerceHook) {
    const c = stringCoerceHook(v as Dict); // Date→ISO, URL→href, params→query
    if (c !== null) return c;
  }
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "1" : "0"; // the shipped native behavior — both platforms pin it
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan"; // Swift "\(Double.nan)"
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    if (Number.isFinite(v) && Math.floor(v) === v) {
      // integral → no ".0"; JS String() already prints integers plainly below 1e21;
      // saturate the exotic range instead of exponent notation (descriptive, not contractual)
      if (Math.abs(v) < 1e21) return String(v);
      return String(BigInt(Math.min(Math.max(v, -9.0e18), 9.0e18)));
    }
    return String(v); // shortest round-trip decimal
  }
  if (v === null || v === undefined) return "";
  return String(v); // NSNull "<null>", lambdas, descriptive fallback
}

export function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 0; // "0" and "false" are TRUE
  if (typeof v === "number") return v !== 0; // NaN != 0 → NaN is truthy
  if (v === null || v === undefined) return false;
  return true; // arrays, dicts, lambdas, NSNull
}

/** Coerce any stored collection to a list for the collection functions / array verbs. */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Coerce to ROW form — non-dict / NSNull elements drop, real rows survive. */
export function asRows(v: unknown): Dict[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is Dict => isDict(e));
}

/** A stable, deep key for `<watch>` equality - changes iff the value meaningfully
 *  changes (dict keys sorted so ordering never churns).
 *
 *  CYCLE-SAFE, and it has to be. This is the JS plane's structural identity function:
 *  every store write runs it, and `jseEquals` delegates to it for dicts and arrays. A
 *  self-referencing value therefore did not merely render wrong, it overflowed the stack
 *  on the write that introduced it and took the surface with it - the exact failure the
 *  component depth floor exists to prevent, one layer lower and louder. Native data
 *  cannot express the shape (Swift dictionaries and arrays are value types), so this is a
 *  JS-plane guard rather than a cross-renderer law.
 *
 *  A node already on the current PATH keys as a cycle marker and stops. `seen` is unwound
 *  after each branch, so a value shared by two siblings still expands in both - the key
 *  for any acyclic input is byte-identical to what it always was. */
export function watchKey(v: unknown, seen?: Set<object>): string {
  if (v === null || v === undefined || v === NSNull) return "\u2205";
  if (typeof v === "string") return "s" + v;
  if (typeof v === "boolean") return v ? "b1" : "b0";
  if (typeof v === "number") return "n" + string(v);
  const nested = Array.isArray(v) || isDict(v);
  if (!nested) return "x" + String(v);
  const path = seen ?? new Set<object>();
  if (path.has(v as object)) return "\u21ba";
  path.add(v as object);
  try {
    if (Array.isArray(v)) return "[" + v.map((e) => watchKey(e, path)).join("") + "]";
    const d = v as Dict;
    return "{" + Object.keys(d).sort().map((k) => `${k}=` + watchKey(d[k], path)).join("") + "}";
  } finally {
    path.delete(v as object);
  }
}

export function jseEquals(a: unknown, b: unknown): boolean {
  // The scope sentinel reads as null here: a bound-but-null lambda param / const /
  // destructured key is stored as NSNull, and `x == null` is the guard every author
  // writes. Without this the sentinel fell through to string coercion ("<null>" != "")
  // and the guard was silently false. Null equals only null — includes/indexOf/switch/
  // Map/Set all ride this function, so they inherit the law.
  if (a === NSNull || a === undefined) a = null;
  if (b === NSNull || b === undefined) b = null;
  if (a === null || b === null) return a === b;
  const x = number(a);
  const y = number(b);
  if (x !== null && y !== null) return x === y; // NaN != NaN, -0 == 0 (Swift semantics)
  // Structural equality for plain dicts/arrays — deep, key-order-insensitive.
  // String-coercible value objects (Date→ISO, URL→href, …) keep coerced-string equality.
  const structural = (v: unknown): boolean => {
    if (isDict(v)) return stringCoerceHook === null || stringCoerceHook(v as Dict) === null;
    return Array.isArray(v);
  };
  if (structural(a) || structural(b)) return watchKey(a) === watchKey(b);
  return string(a) === string(b);
}

export function compare(a: unknown, b: unknown, o: string): boolean {
  // Both operands strings → JS lexicographic ordering; anything else numeric (?? 0).
  if (typeof a === "string" && typeof b === "string") {
    switch (o) {
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      default: return a >= b;
    }
  }
  const x = number(a) ?? 0;
  const y = number(b) ?? 0;
  switch (o) {
    case "<": return x < y;
    case "<=": return x <= y;
    case ">": return x > y;
    default: return x >= y;
  }
}

export function arith(a: unknown, b: unknown, o: string): unknown {
  if (o === "+") {
    const x = number(a);
    const y = number(b);
    if (x !== null && y !== null) return x + y;
    return string(a) + string(b); // string concat
  }
  const x = number(a) ?? 0;
  const y = number(b) ?? 0;
  switch (o) {
    case "-": return x - y;
    case "*": return x * y;
    case "/": return y === 0 ? 0 : x / y; // DIVISION BY ZERO YIELDS 0 — the JSE law
    case "%": return y === 0 ? 0 : x % y; // JS % (sign of dividend); %0 → 0 like /0
    default: return 0;
  }
}

/** The ONE missing value (`??` / `?.` nullish test): null, undefined, and the
 *  present-null scope sentinel all count — JSE does not split them. */
export function isMissing(v: unknown): boolean {
  return v === null || v === undefined || v === NSNull;
}

/** JS ToInt32 — trunc, wrap mod 2^32 into the signed range. NaN/±inf → 0. */
export function toInt32(v: unknown): number {
  let n = number(v) ?? 0;
  if (!Number.isFinite(n)) return 0;
  n = Math.trunc(n) % 4294967296;
  if (n >= 2147483648) n -= 4294967296;
  else if (n < -2147483648) n += 4294967296;
  return n;
}

/** JS ToUint32 — trunc, wrap mod 2^32 into [0, 2^32). NaN/±inf → 0. */
export function toUint32(v: unknown): number {
  let n = number(v) ?? 0;
  if (!Number.isFinite(n)) return 0;
  n = Math.trunc(n) % 4294967296;
  if (n < 0) n += 4294967296;
  return n;
}

/** Bitwise / shift operators — JS semantics: Int32 operands (Uint32 for `>>>`),
 *  shift counts masked to 5 bits, results back as numbers. */
export function bitOp(a: unknown, b: unknown, o: string): number {
  const s = toUint32(b) & 31;
  switch (o) {
    case "&": return toInt32(a) & toInt32(b);
    case "|": return toInt32(a) | toInt32(b);
    case "^": return toInt32(a) ^ toInt32(b);
    case "<<": return (toInt32(a) << s) | 0;
    case ">>": return toInt32(a) >> s;
    case ">>>": return toUint32(a) >>> s;
    default: return 0;
  }
}

/** JS `~` — bitwise NOT over ToInt32 (−int32 − 1, the twins' spelling). */
export function bitNot(v: unknown): number {
  return -toInt32(v) - 1;
}

/** JS `**` — operands number-coerced with `?? 0`, exactly like `*` (the arith table). */
export function powOp(a: unknown, b: unknown): number {
  return Math.pow(number(a) ?? 0, number(b) ?? 0);
}

/** JS `typeof` — with one deliberate divergence: null and undefined both report
 *  "undefined" (JSE does not split them). Arrays and dicts are "object". */
export function typeofString(v: unknown): string {
  if (v === null || v === undefined || v === NSNull) return "undefined";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (isLambda(v)) return "function";
  return "object";
}

/** Double → integer without trapping on NaN / ±inf / out-of-range (author-controllable).
 *  NaN → 0; ±Infinity SATURATES to ±9.0e18 (so `substring(0, Infinity)` / `toSpliced`
 *  clamp toward "the end", never toward index 0). */
export function safeInt(d: number): number {
  if (Number.isNaN(d)) return 0;
  return Math.trunc(Math.min(Math.max(d, -9.0e18), 9.0e18));
}

/** Swift `Double.rounded()` — .toNearestOrAwayFromZero, without the floor(x+0.5) bug. */
export function roundedAwayFromZero(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return x;
  const a = Math.abs(x);
  const f = Math.floor(a);
  const r = a - f >= 0.5 ? f + 1 : f;
  return x < 0 ? -r : r;
}

/** Swift `Swift.min` / `Swift.max` exactly (positional NaN, unlike Math.min). */
export function swiftMin(a: number, b: number): number { return b < a ? b : a; }
export function swiftMax(a: number, b: number): number { return b >= a ? b : a; }

/** Foundation `.capitalized`: each letter-run starts uppercase, the rest lowercased. */
export function capitalizedSwift(s: string): string {
  let out = "";
  let prevLetter = false;
  for (const ch of s) {
    const isLetter = /\p{L}/u.test(ch);
    out += isLetter && !prevLetter ? ch.toUpperCase() : isLetter ? ch.toLowerCase() : ch;
    prevLetter = isLetter;
  }
  return out;
}

/** JS `base[idx]` — numeric index into an array (bounds-checked), string key into a dict. */
export function index(base: unknown, idx: unknown): unknown {
  const n = number(idx);
  if (n !== null) {
    const i = safeInt(n);
    const arr = asArray(base);
    return i >= 0 && i < arr.length ? arr[i] : null;
  }
  return isDict(base) ? ((base as Dict)[string(idx)] ?? null) : null;
}

/** JS `base.member` (postfix) — `.length` on an array/string, else an object key. */
export function member(base: unknown, m: string): unknown {
  if (m === "length") {
    if (typeof base === "string") return charCount(base);
    if (Array.isArray(base)) return base.length;
  }
  return isDict(base) ? ((base as Dict)[m] ?? null) : null;
}
