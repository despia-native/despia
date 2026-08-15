//
//  core.ts - JSECore + JSECrypto: the JS core globals (URL / Date / Intl / JSON / Math /
//  Map / Set / parseInt / …) and the Web Crypto companions. TS twin of the Globals layer
//  (Stack.swift on iOS, Globals.kt on Android) — same dispatch shape, same dict-shaped
//  values ({__date: ms}, {__url,…}, {__params}, {__regex}…), so string coercion and
//  structural equality carry across runtimes.
//
//  On the web many of these are backed by the REAL platform objects (URL, Intl, crypto)
//  — the values still travel as the portable dict shapes. crypto.subtle is async-only in
//  browsers: it returns a real Promise the ACTION runner awaits (statement-await, per
//  the runner contract); on the native twins it computes synchronously under the hood.
//

import {
  NSNull, isDict, isLambda, number, string, truthy, jseEquals, safeInt, type Dict,
  setStringCoerce,
} from "./values.ts";
import { DSXLogs, JSERedact } from "../logs.ts";

// ── small helpers ────────────────────────────────────────────────────────────────────

/** The HOUSE log formatter — one value → one console token, shared by the `console.*`
 *  builtin, the `dsx.log` statement, and the module-handle `dsx.log` (logs corpus): a
 *  dict/array serializes as canonical minified JSON with credential-looking keys masked
 *  (the Stack.swift / Globals.kt console contract, which the old web console.* path
 *  lacked); anything else takes the JSE string coercion. */
export function formatLogValue(x: unknown): string {
  if (isDict(x) || Array.isArray(x)) {
    return jsonStringify(JSERedact.mask(x), null) ?? string(x);
  }
  return string(x);
}

/** console.log-shaped variadic formatting: each argument through formatLogValue, joined
 *  by single spaces. */
export function formatLogArgs(a: unknown[]): string {
  return a.map((x) => formatLogValue(x)).join(" ");
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function pad3(n: number): string { return String(n).padStart(3, "0"); }

function dateShape(ms: number): Dict { return { __date: ms }; }

function isDateShape(d: Dict): boolean { return typeof d["__date"] === "number"; }

/** Kotlin/Swift: NaN date → getTime NaN, other getters clamp to epoch. */
function dateOf(d: Dict): Date {
  const ms = d["__date"] as number;
  return new Date(Number.isNaN(ms) ? 0 : ms);
}

/** Local-time Date setter arithmetic — replace the named components, return new ms. */
function dateSet(ms: number, m: string, a: unknown[]): number {
  const nn = (i: number): number | null => (i < a.length ? number(a[i]) : null);
  if (m === "setTime") return nn(0) ?? 0;
  const dt = new Date(ms);
  switch (m) {
    case "setFullYear": dt.setFullYear(nn(0) ?? dt.getFullYear(), nn(1) ?? dt.getMonth(), nn(2) ?? dt.getDate()); break;
    case "setMonth": dt.setMonth(nn(0) ?? dt.getMonth(), nn(1) ?? dt.getDate()); break;
    case "setDate": dt.setDate(nn(0) ?? dt.getDate()); break;
    case "setHours": dt.setHours(nn(0) ?? dt.getHours(), nn(1) ?? dt.getMinutes(), nn(2) ?? dt.getSeconds(), nn(3) ?? dt.getMilliseconds()); break;
    case "setMinutes": dt.setMinutes(nn(0) ?? dt.getMinutes(), nn(1) ?? dt.getSeconds(), nn(2) ?? dt.getMilliseconds()); break;
    case "setSeconds": dt.setSeconds(nn(0) ?? dt.getSeconds(), nn(1) ?? dt.getMilliseconds()); break;
    case "setMilliseconds": dt.setMilliseconds(nn(0) ?? dt.getMilliseconds()); break;
  }
  return dt.getTime();
}

function toISO(ms: number): string {
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  return (
    d.getUTCFullYear().toString().padStart(4, "0") + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) +
    "T" + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) +
    "." + pad3(d.getUTCMilliseconds()) + "Z"
  );
}

// ── URLSearchParams / URL dict shapes ────────────────────────────────────────────────

type ParamPair = [string, string];

function formEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

function paramsToString(pairs: ParamPair[]): string {
  return pairs.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&");
}

function parseQuery(q: string): ParamPair[] {
  const out: ParamPair[] = [];
  for (const part of q.replace(/^\?/, "").split("&")) {
    if (part.length === 0) continue;
    const eq = part.indexOf("=");
    const k = eq >= 0 ? part.substring(0, eq) : part;
    const v = eq >= 0 ? part.substring(eq + 1) : "";
    const dec = (x: string) => {
      try { return decodeURIComponent(x.replace(/\+/g, " ")); } catch { return x; }
    };
    out.push([dec(k), dec(v)]);
  }
  return out;
}

function paramsShape(pairs: ParamPair[]): Dict {
  return { __params: pairs.map(([k, v]) => [k, v]) };
}

function paramsPairs(d: Dict): ParamPair[] {
  const raw = d["__params"];
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => [string((p as unknown[])[0]), string((p as unknown[])[1])]);
}

function makeURL(href: string, base?: string): Dict | null {
  // whitespace / control characters → null (the hand-rolled RFC 3986 twin rejects them)
  if (/[\s\x00-\x1f]/.test(href)) return null;
  let u: URL;
  try {
    u = base !== undefined ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
  return {
    __url: true,
    href: u.href,
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port,
    host: u.host,
    origin: u.origin,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
    searchParams: paramsShape(parseQuery(u.search)),
  };
}

/** Apply a mutating `searchParams` verb THROUGH its owning URL, so `href`/`search` stay true.
 *
 *  This is the twin of the natives' parent-walk (`JseRunner.kt`'s `receiver.endsWith(".searchParams")`
 *  branch and `JSELibrary.swift`'s): mutating the params dict alone leaves the URL describing a
 *  query it no longer has, and `href` is what callers hand to fetch/navigate. Returns a NEW url
 *  dict for the caller to write back, or null when the receiver is not a URL-owned params dict —
 *  in which case the caller falls through to plain value semantics.
 */
export function mutateURLSearchParams(url: unknown, verb: string, args: unknown[]): Dict | null {
  if (!isDict(url) || (url as Dict)["__url"] === undefined) return null;
  const next: Dict = { ...(url as Dict) };
  const sp = next["searchParams"];
  const pairs: ParamPair[] = isDict(sp) ? paramsPairs(sp as Dict) : [];
  let out: ParamPair[];
  switch (verb) {
    case "set": {
      const k = string(args[0]);
      const v = string(args[1]);
      out = [...pairs.filter((p) => p[0] !== k), [k, v]];
      break;
    }
    case "append":
      out = [...pairs, [string(args[0]), string(args[1])]];
      break;
    case "delete": {
      const k = string(args[0]);
      out = pairs.filter((p) => p[0] !== k);
      break;
    }
    default:
      return null;
  }
  next["searchParams"] = paramsShape(out);
  resyncURL(next);
  return next;
}

/** After a searchParams mutation: resync href/search on the owning URL dict. */
export function resyncURL(u: Dict): void {
  const sp = u["searchParams"];
  if (!isDict(sp)) return;
  const q = paramsToString(paramsPairs(sp as Dict));
  const href = string(u["href"]);
  const parsed = (() => { try { return new URL(href); } catch { return null; } })();
  if (!parsed) return;
  parsed.search = q.length > 0 ? "?" + q : "";
  u["search"] = parsed.search;
  u["href"] = parsed.href;
}

// ── JSON with the JSE rules ──────────────────────────────────────────────────────────

// Authored JSON runs on the UI thread on every renderer. Keep it deliberately below
// the network response ceiling: this is large enough for application state, while a
// hostile component cannot recursively stringify an unbounded graph or parse a huge
// payload and monopolize the page. These limits mirror the <api> request graph guard.
const MAX_JSE_JSON_BYTES = 4 * 1024 * 1024;
const MAX_JSE_JSON_NODES = 250_000;
const MAX_JSE_JSON_DEPTH = 128;

function boundedUtf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** Exact byte cost of the JSE JSON string spelling (including quotes and the
 * Foundation-compatible escaped slash). Stops as soon as the caller's budget is
 * exceeded so a large hostile string is never copied merely to measure it. */
function escapedJsonBytes(value: string, limit: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x2f) bytes += 2;
    else if (code <= 0x1f) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** Iterative graph and exact-output-size preflight. Besides bounding work, the
 * ancestor ledger rejects cycles before the recursive encoder can overflow. */
function jsonStringifyAllowed(value: unknown, indent: number): boolean {
  type Frame = { value?: unknown; depth: number; exit?: object };
  const stack: Frame[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= MAX_JSE_JSON_BYTES;
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit !== undefined) {
      ancestors.delete(frame.exit);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_JSE_JSON_NODES || frame.depth > MAX_JSE_JSON_DEPTH) return false;
    const next = frame.value;
    if (next === null || next === undefined || next === NSNull || isLambda(next)) {
      if (!add(4)) return false;
    } else if (typeof next === "boolean") {
      if (!add(next ? 4 : 5)) return false;
    } else if (typeof next === "number") {
      if (!add(Number.isFinite(next) ? String(next).length : 4)) return false;
    } else if (typeof next === "string") {
      const cost = escapedJsonBytes(next, MAX_JSE_JSON_BYTES - bytes);
      if (!add(cost)) return false;
    } else if (Array.isArray(next)) {
      if (ancestors.has(next)) return false;
      ancestors.add(next);
      const count = next.length;
      if (indent === 0) {
        if (!add(2 + Math.max(0, count - 1))) return false;
      } else if (!add(count === 0
        ? 2
        : 4 + count * indent * (frame.depth + 1) + (count - 1) * 2 + indent * frame.depth)) return false;
      stack.push({ depth: frame.depth, exit: next });
      for (let index = count - 1; index >= 0; index -= 1) {
        stack.push({ value: next[index], depth: frame.depth + 1 });
      }
    } else if (isDict(next)) {
      if (ancestors.has(next)) return false;
      ancestors.add(next);
      const entries = Object.entries(next as Dict);
      const count = entries.length;
      if (indent === 0) {
        if (!add(2 + Math.max(0, count - 1))) return false;
      } else if (!add(count === 0
        ? 2
        : 4 + count * indent * (frame.depth + 1) + (count - 1) * 2 + indent * frame.depth)) return false;
      stack.push({ depth: frame.depth, exit: next });
      for (let index = count - 1; index >= 0; index -= 1) {
        const [key, entryValue] = entries[index]!;
        const keyCost = escapedJsonBytes(key, MAX_JSE_JSON_BYTES - bytes);
        if (!add(keyCost + (indent > 0 ? 2 : 1))) return false;
        stack.push({ value: entryValue, depth: frame.depth + 1 });
      }
    } else {
      const cost = escapedJsonBytes(String(next), MAX_JSE_JSON_BYTES - bytes);
      if (!add(cost)) return false;
    }
  }
  return true;
}

function jsonStringify(v: unknown, space: unknown): string | null {
  const indent = typeof space === "number" ? Math.max(0, Math.min(10, Math.trunc(space))) : 0;
  if (!jsonStringifyAllowed(v, indent)) return null;
  const enc = (x: unknown, depth: number): string | null => {
    if (x === null || x === undefined || x === NSNull) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") {
      if (!Number.isFinite(x)) return "null"; // NaN/Inf → null
      if (Math.floor(x) === x && Math.abs(x) < 1e15) return String(x); // integral → int
      return String(x);
    }
    if (typeof x === "string") {
      // JSON escape, PLUS the Foundation-style escaped forward slash
      return JSON.stringify(x).replace(/\//g, "\\/");
    }
    if (Array.isArray(x)) {
      const parts = x.map((e) => enc(e, depth + 1) ?? "null");
      if (indent === 0) return "[" + parts.join(",") + "]";
      const pad = " ".repeat(indent * (depth + 1));
      const end = " ".repeat(indent * depth);
      return parts.length === 0 ? "[]" : "[\n" + parts.map((p) => pad + p).join(",\n") + "\n" + end + "]";
    }
    if (isDict(x)) {
      const d = x as Dict;
      const keys = Object.keys(d);
      const parts = keys.map((k) => {
        const kk = JSON.stringify(k).replace(/\//g, "\\/");
        return `${kk}:${indent > 0 ? " " : ""}${enc(d[k], depth + 1) ?? "null"}`;
      });
      if (indent === 0) return "{" + parts.join(",") + "}";
      const pad = " ".repeat(indent * (depth + 1));
      const end = " ".repeat(indent * depth);
      return parts.length === 0 ? "{}" : "{\n" + parts.map((p) => pad + p).join(",\n") + "\n" + end + "}";
    }
    if (isLambda(x)) return null;
    return JSON.stringify(String(x));
  };
  return enc(v, 0);
}

function jsonParse(s: string): unknown {
  if (s.length > MAX_JSE_JSON_BYTES || boundedUtf8Bytes(s, MAX_JSE_JSON_BYTES) > MAX_JSE_JSON_BYTES) return null;
  try {
    const raw: unknown = JSON.parse(s);
    let nodes = 0;
    const map = (x: unknown, depth: number): unknown => {
      nodes += 1;
      if (nodes > MAX_JSE_JSON_NODES || depth > MAX_JSE_JSON_DEPTH) throw new Error("json_too_complex");
      if (x === null) return NSNull; // present-but-null sentinel
      if (Array.isArray(x)) return x.map((entry) => map(entry, depth + 1));
      if (typeof x === "object") {
        const out: Dict = {};
        for (const [k, v] of Object.entries(x as Dict)) {
          // Assignment to `out.__proto__` invokes Object.prototype's legacy setter.
          // Define every JSON key as data so authored/untrusted JSON cannot forge an
          // inherited JSE property while preserving normal JSON.parse key semantics.
          Object.defineProperty(out, k, {
            value: map(v, depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return out;
      }
      return x;
    };
    return map(raw, 0);
  } catch {
    return null;
  }
}

// ── base64 (host-agnostic — btoa/atob without window) ───────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[b0 >> 2]! + B64[((b0 & 3) << 4) | (b1 >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63]! : "=";
  }
  return out;
}

export function base64Decode(s: string): Uint8Array | null {
  const clean = s.replace(/[\r\n\s]/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
  const body = clean.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of body) {
    buffer = (buffer << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ── the JS-GLOBALS FOLD (/web/13 embed size law) ─────────────────────────────────────
//
//  JSECore + JSECrypto are the JS-globals layer: they are reachable ONLY by NAME —
//  every entry point (`Math.…`, `Date`, `URL`, `Map`, `btoa`, `crypto.…`, `"…".toHex()`)
//  must appear literally in an expression, and every dict SHAPE they consume
//  ({__date}, {__url}, {__params}, {__map}, {__set}, {__textEncoder}) is minted here
//  and nowhere else. So a build whose CLOSED slice names none of them cannot reach
//  this layer at all — a self-contained widget embed with only `{{ dsx.attribute.x }}`
//  and a `dsx.event(…)` handler is the canonical case. `registryUsesJsGlobals`
//  (compiler/bin/embed-entry.ts) is the detector; the build inlines the answer as
//  `__DSX_OPTIONAL_JS_GLOBALS__` and esbuild folds the ternaries below, dropping the
//  whole layer (Date/URL/Intl/JSON/Math/Map/Set/crypto/base64 …) from the bundle.
//
//  Two shapes are NOT minted here and stay live in the folded stub, because a page can
//  still produce them with the layer absent: {__regex} (a regex LITERAL, jse.ts) and
//  {__error} (the error system). Their handling is byte-for-byte the same either way.
//
//  Anything that is not a sliced embed leaves the define unset, so `undefined !== false`
//  keeps the full layer — full apps, SSR, the conformance runners and every test see
//  exactly today's behavior.

type JSECoreApi = {
  handles(name: string): boolean;
  call(name: string, a: unknown[]): unknown;
  constant(id: string): unknown;
  method(m: string, base: unknown, a: unknown[]): { value: unknown } | null;
  stringCoerce(d: Dict): string | null;
};

type JSECryptoApi = {
  data(v: unknown): Uint8Array | null;
  bytes(d: Uint8Array): unknown[];
  base64(d: Uint8Array): string;
  call(name: string, a: unknown[]): unknown;
};

// ── JSECrypto — byte plumbing + companions (WebCrypto under the hood) ────────────────

const JSE_CRYPTO_FULL: JSECryptoApi = {
  /** BufferSource coercion: a JSE number array (bytes), a String (UTF-8). */
  data(v: unknown): Uint8Array | null {
    if (Array.isArray(v)) {
      const d = new Uint8Array(v.length);
      for (let i = 0; i < v.length; i++) {
        const n = number(v[i]);
        if (n === null) return null;
        d[i] = safeInt(n) & 0xff; // low byte
      }
      return d;
    }
    if (typeof v === "string") return new TextEncoder().encode(v);
    return null;
  },

  /** Uint8Array → the JSE byte array ([number] 0–255) every result travels as. */
  bytes(d: Uint8Array): unknown[] {
    return Array.from(d, (b) => b);
  },

  base64(d: Uint8Array): string {
    return base64Encode(d);
  },

  call(name: string, a: unknown[]): unknown {
    switch (name) {
      case "Uint8Array": {
        const arg = a[0];
        const n = number(arg);
        if (n !== null && !Array.isArray(arg)) return new Array(Math.max(0, Math.min(safeInt(n), 10_000_000))).fill(0);
        const d = JSECrypto.data(arg);
        return d ? JSECrypto.bytes(d) : [];
      }
      case "TextEncoder": return { __textEncoder: true };
      case "TextDecoder": return { __textDecoder: true };
      case "Array.from": {
        const d = JSECrypto.data(a[0]);
        return d ? JSECrypto.bytes(d) : [];
      }
      case "btoa": {
        const s = string(a[0]);
        const bytes = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
        return base64Encode(bytes);
      }
      case "atob": {
        const d = base64Decode(string(a[0]));
        if (!d) return null;
        let out = "";
        for (const b of d) out += String.fromCharCode(b);
        return out;
      }
      case "crypto.randomUUID":
        return globalThis.crypto?.randomUUID?.() ?? null;
      case "crypto.getRandomValues": {
        const len = Array.isArray(a[0]) ? (a[0] as unknown[]).length : safeInt(number(a[0]) ?? 0);
        const buf = new Uint8Array(Math.max(0, Math.min(len, 65536)));
        globalThis.crypto?.getRandomValues?.(buf);
        return JSECrypto.bytes(buf);
      }
      default:
        if (name.startsWith("crypto.subtle.")) {
          // async on the web — a real Promise the action runner awaits (statement-await)
          return subtleCall(name.substring("crypto.subtle.".length), a);
        }
        console.warn(`[JSE crypto] unsupported: ${name}`);
        return null;
    }
  },
};

/** the folded twin: no name in the slice can reach a crypto companion */
const JSE_CRYPTO_ABSENT: JSECryptoApi = {
  data: () => null,
  bytes: () => [],
  base64: () => "",
  call: () => null,
};

export const JSECrypto: JSECryptoApi =
  (globalThis as typeof globalThis & { __DSX_OPTIONAL_JS_GLOBALS__?: boolean })
    .__DSX_OPTIONAL_JS_GLOBALS__ !== false ? JSE_CRYPTO_FULL : JSE_CRYPTO_ABSENT;

function subtleCall(method: string, a: unknown[]): Promise<unknown> | null {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  if (method === "digest") {
    const alg = string(a[0]);
    const d = JSECrypto.data(a[1]);
    if (!d) return null;
    return subtle.digest(alg, d as BufferSource).then((buf) => JSECrypto.bytes(new Uint8Array(buf)));
  }
  console.warn(`[JSE crypto] subtle.${method} pending on this runtime`);
  return null;
}

// ── JSECore — routing (the exact reference switch) ───────────────────────────────────

const JSE_CORE_FULL: JSECoreApi = {
  handles(name: string): boolean {
    if (name.startsWith("Math.") || name.startsWith("Intl.") || name.startsWith("JSON.") ||
        name.startsWith("Date.") || name.startsWith("Promise.") ||
        name.startsWith("Object.") || name.startsWith("console.") ||
        name.startsWith("performance.")) return true;
    switch (name) {
      case "URL": case "URLSearchParams": case "Headers": case "Request": case "Blob":
      case "File": case "FormData": case "Date": case "AbortController":
      case "structuredClone": case "encodeURIComponent": case "decodeURIComponent":
      case "encodeURI": case "decodeURI": case "parseInt": case "parseFloat":
      case "isNaN": case "Number": case "String": case "Boolean": case "Map":
      case "Set": case "Error": case "RegExp": case "WebSocket":
        return true;
      default:
        return false;
    }
  },

  call(name: string, a: unknown[]): unknown {
    if (name.startsWith("Math.")) return coreMath(name.substring(5), a);
    if (name.startsWith("JSON.")) {
      if (name === "JSON.stringify") return jsonStringify(a[0], number(a[2]) ?? (typeof a[1] === "number" ? a[1] : null));
      if (name === "JSON.parse") return jsonParse(string(a[0]));
      return null;
    }
    if (name.startsWith("Object.")) {
      const fn = name.substring(7);
      const d = isDict(a[0]) ? (a[0] as Dict) : null;
      switch (fn) {
        case "keys": return d ? Object.keys(d) : [];
        case "values": return d ? Object.values(d) : [];
        case "entries": return d ? Object.entries(d).map(([k, v]) => [k, v]) : [];
        case "assign": {
          const out: Dict = {};
          for (const arg of a) if (isDict(arg)) Object.assign(out, arg as Dict);
          return out;
        }
        case "hasOwn": {
          const o = a[0];
          return isDict(o) ? Object.prototype.hasOwnProperty.call(o as Dict, string(a[1])) : false;
        }
        case "fromEntries": {
          const out: Dict = {};
          for (const e of a[0] && Array.isArray(a[0]) ? (a[0] as unknown[]) : []) {
            if (Array.isArray(e) && e.length >= 1) out[string(e[0])] = e.length > 1 ? e[1] : NSNull;
          }
          return out;
        }
        default: return null;
      }
    }
    if (name.startsWith("console.")) {
      const level = name.substring(8);
      const msg = formatLogArgs(a);
      // the unified log ring (dsx.logs / the dev drawer) sees console.* too — the
      // builtin has no scheme of its own, so entries attribute as "console"
      DSXLogs.append({ scheme: "console", level, message: msg, at: Date.now() });
      if (level === "error") console.error("[dsx]", msg);
      else if (level === "warn") console.warn("[dsx]", msg);
      else console.log("[dsx]", msg);
      return null;
    }
    if (name.startsWith("performance.")) {
      if (name === "performance.now") return globalThis.performance?.now?.() ?? Date.now();
      return null;
    }
    if (name.startsWith("Date.")) {
      if (name === "Date.now") return Date.now();
      if (name === "Date.UTC") {
        const nn = (i: number): number => (i < a.length ? (number(a[i]) ?? 0) : 0);
        const ms = Date.UTC(nn(0), a.length > 1 ? nn(1) : 0, a.length > 2 ? nn(2) : 1,
                            nn(3), nn(4), nn(5), nn(6));
        return Number.isNaN(ms) ? null : ms;
      }
      if (name === "Date.parse") {
        const t = Date.parse(string(a[0]));
        return t; // ms or NaN
      }
      return null;
    }
    if (name.startsWith("Intl.")) return intlCall(name.substring(5), a);
    if (name.startsWith("Promise.")) return promiseCall(name.substring(8), a);
    switch (name) {
      case "URL": {
        const base = a.length > 1 ? string(a[1]) : undefined;
        return makeURL(string(a[0]), base);
      }
      case "URLSearchParams": {
        const init = a[0];
        if (typeof init === "string") return paramsShape(parseQuery(init));
        if (isDict(init)) {
          if (isDict((init as Dict)["__params"] as unknown) || Array.isArray((init as Dict)["__params"])) {
            return paramsShape(paramsPairs(init as Dict));
          }
          return paramsShape(Object.entries(init as Dict).map(([k, v]) => [k, string(v)]));
        }
        if (Array.isArray(init)) {
          return paramsShape(init.map((e) => [string((e as unknown[])[0]), string((e as unknown[])[1])]));
        }
        return paramsShape([]);
      }
      case "Headers": {
        const init = isDict(a[0]) ? (a[0] as Dict) : {};
        const entries: Dict = {};
        for (const [k, v] of Object.entries(init)) entries[k.toLowerCase()] = string(v);
        return { __headers: true, ...entries };
      }
      case "Request": return { __request: true, url: string(a[0]), ...(isDict(a[1]) ? (a[1] as Dict) : {}) };
      case "Blob": case "File": {
        const parts = Array.isArray(a[0]) ? (a[0] as unknown[]) : [];
        let bytes = new Uint8Array(0);
        for (const p of parts) {
          const d = JSECrypto.data(p) ?? (typeof p === "string" ? new TextEncoder().encode(p) : null);
          if (d) {
            const merged = new Uint8Array(bytes.length + d.length);
            merged.set(bytes);
            merged.set(d, bytes.length);
            bytes = merged;
          }
        }
        const opts = isDict(name === "File" ? a[2] : a[1]) ? ((name === "File" ? a[2] : a[1]) as Dict) : {};
        const shape: Dict = { __blob: base64Encode(bytes), type: string(opts["type"] ?? ""), size: bytes.length };
        if (name === "File") { shape["name"] = string(a[1]); shape["lastModified"] = Date.now(); }
        return shape;
      }
      case "FormData": return { __formData: true, entries: [] };
      case "Date": {
        if (a.length === 0) return dateShape(Date.now());
        if (a.length >= 2) {
          // component form — LOCAL time: year, month0[, day[, h[, m[, s[, ms]]]]].
          // Any non-finite component → an invalid date (NaN ms), matching the twins.
          const nn = (i: number, def: number): number => (i < a.length ? (number(a[i]) ?? NaN) : def);
          const y = nn(0, 1970);
          const parts = [y, nn(1, 0), nn(2, 1), nn(3, 0), nn(4, 0), nn(5, 0), nn(6, 0)];
          if (parts.some((p) => !Number.isFinite(p))) return dateShape(NaN);
          const dt = new Date(parts[0]!, parts[1]!, parts[2]!, parts[3]!, parts[4]!, parts[5]!, parts[6]!);
          if (y >= 0 && y <= 99) dt.setFullYear(y); // the literal year — no JS two-digit-year quirk (twin parity)
          return dateShape(dt.getTime());
        }
        const v = a[0];
        if (isDict(v) && isDateShape(v as Dict)) return dateShape((v as Dict)["__date"] as number);
        const n = typeof v === "number" ? v : null;
        if (n !== null) return dateShape(n);
        const parsed = Date.parse(string(v));
        return dateShape(parsed);
      }
      case "AbortController": return { __abortController: true, signal: { __abortSignal: true, aborted: false } };
      case "structuredClone": return structuredCloneValue(a[0]);
      case "encodeURIComponent": return encodeURIComponent(string(a[0]));
      case "decodeURIComponent": { try { return decodeURIComponent(string(a[0])); } catch { return null; } }
      case "encodeURI": return encodeURI(string(a[0]));
      case "decodeURI": { try { return decodeURI(string(a[0])); } catch { return null; } }
      case "parseInt": {
        const s = string(a[0]).trim();
        let radix = safeInt(number(a[1]) ?? 0);
        let body = s;
        let sign = 1;
        if (body.startsWith("-")) { sign = -1; body = body.substring(1); }
        else if (body.startsWith("+")) body = body.substring(1);
        if ((radix === 0 || radix === 16) && /^0x/i.test(body)) { radix = 16; body = body.substring(2); }
        if (radix === 0) radix = 10;
        if (radix < 2 || radix > 36) return NaN;
        let out = 0;
        let any = false;
        for (const c of body) {
          const d = parseInt(c, 36);
          if (Number.isNaN(d) || d >= radix) break;
          out = out * radix + d;
          any = true;
        }
        return any ? sign * out : NaN;
      }
      case "parseFloat": {
        const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(string(a[0]).trim());
        return m ? Number(m[0]) : NaN;
      }
      case "isNaN": { const n = number(a[0]); return n === null || Number.isNaN(n); }
      case "Number": return number(a[0]) ?? NaN;
      case "String": return string(a[0]);
      case "Boolean": return truthy(a[0]);
      case "Map": {
        const entries: unknown[] = [];
        if (Array.isArray(a[0])) for (const e of a[0] as unknown[]) if (Array.isArray(e)) entries.push([e[0], e.length > 1 ? e[1] : NSNull]);
        return { __map: entries, size: entries.length };
      }
      case "Set": {
        const values: unknown[] = [];
        if (Array.isArray(a[0])) for (const v of a[0] as unknown[]) if (!values.some((x) => jseEquals(x, v))) values.push(v);
        return { __set: values, size: values.length };
      }
      case "Error": return { __error: true, name: "Error", message: string(a[0]) };   // native twins carry the marker (Globals.kt / Stack.swift)
      case "RegExp": return { __regex: true, source: string(a[0]), flags: string(a[1]) };
      case "WebSocket": return null; // statement-only (the action runner owns sockets)
      default: return null;
    }
  },

  /** Constants the evaluator can't reach as calls (bare member reads on a namespace). */
  constant(id: string): unknown {
    switch (id) {
      case "Math.PI": return Math.PI;
      case "Math.E": return Math.E;
      case "Number.MAX_SAFE_INTEGER": return 9007199254740991;
      case "Number.MIN_SAFE_INTEGER": return -9007199254740991;
      case "Number.EPSILON": return Number.EPSILON;
      case "Infinity": return Infinity;
      case "NaN": return NaN;
      default: return null;
    }
  },

  /** applyMethod's first stop — claims the call only for ITS dict shapes.
   *  Returns null = "not mine"; { value } = handled (value may be null). */
  method(m: string, base: unknown, a: unknown[]): { value: unknown } | null {
    if (!isDict(base)) return null;
    const d = base as Dict;
    if (d["__regex"] !== undefined && d["__regex"] !== null && m === "test") {
      // string-side match/replace/split live on the string cases
      return { value: regexTest(string(a[0]), d) };
    }
    if (isDateShape(d)) {
      const ms = d["__date"] as number;
      const dt = dateOf(d);
      switch (m) {
        case "getTime": case "valueOf": return { value: ms };
        case "toISOString": case "toJSON": return { value: toISO(ms) };
        case "getFullYear": return { value: dt.getFullYear() };
        case "getMonth": return { value: dt.getMonth() }; // 0-based
        case "getDate": return { value: dt.getDate() };
        case "getDay": return { value: dt.getDay() }; // 0 = Sunday
        case "getHours": return { value: dt.getHours() };
        case "getMinutes": return { value: dt.getMinutes() };
        case "getSeconds": return { value: dt.getSeconds() };
        case "getMilliseconds": return { value: dt.getMilliseconds() };
        case "getUTCFullYear": return { value: dt.getUTCFullYear() };
        case "getUTCMonth": return { value: dt.getUTCMonth() };
        case "getUTCDate": return { value: dt.getUTCDate() };
        case "getUTCDay": return { value: dt.getUTCDay() };
        case "getUTCHours": return { value: dt.getUTCHours() };
        case "getUTCMinutes": return { value: dt.getUTCMinutes() };
        case "getUTCSeconds": return { value: dt.getUTCSeconds() };
        case "getUTCMilliseconds": return { value: dt.getUTCMilliseconds() };
        case "getTimezoneOffset": return { value: dt.getTimezoneOffset() };
        case "setTime": case "setFullYear": case "setMonth": case "setDate": case "setHours":
        case "setMinutes": case "setSeconds": case "setMilliseconds": {
          const next = dateSet(ms, m, a);
          d["__date"] = next; // value-object mutation (statement position persists it)
          return { value: next };
        }
        case "toLocaleDateString": return { value: dt.toLocaleDateString(localeArg(a[0]), intlOpts(a[1])) };
        case "toLocaleTimeString": return { value: dt.toLocaleTimeString(localeArg(a[0]), intlOpts(a[1])) };
        case "toLocaleString": return { value: dt.toLocaleString(localeArg(a[0]), intlOpts(a[1])) };
        case "toString": return { value: dt.toString() };
        default: return null;
      }
    }
    if (d["__params"] !== undefined) {
      const pairs = paramsPairs(d);
      switch (m) {
        case "get": { const k = string(a[0]); const hit = pairs.find((p) => p[0] === k); return { value: hit ? hit[1] : null }; }
        case "getAll": { const k = string(a[0]); return { value: pairs.filter((p) => p[0] === k).map((p) => p[1]) }; }
        case "has": { const k = string(a[0]); return { value: pairs.some((p) => p[0] === k) }; }
        case "set": { // value-semantics callers use the statement path; expression form mutates the dict copy
          const k = string(a[0]); const v = string(a[1]);
          const rest = pairs.filter((p) => p[0] !== k);
          d["__params"] = [...rest, [k, v]];
          return { value: null };
        }
        case "append": { d["__params"] = [...pairs, [string(a[0]), string(a[1])]]; return { value: null }; }
        case "delete": { const k = string(a[0]); d["__params"] = pairs.filter((p) => p[0] !== k); return { value: null }; }
        case "toString": return { value: paramsToString(pairs) };
        default: return null;
      }
    }
    if (d["__map"] !== undefined) {
      const entries = Array.isArray(d["__map"]) ? (d["__map"] as unknown[]) : [];
      switch (m) {
        case "get": { const hit = entries.find((e) => jseEquals((e as unknown[])[0], a[0])); return { value: hit ? (hit as unknown[])[1] : null }; }
        case "has": return { value: entries.some((e) => jseEquals((e as unknown[])[0], a[0])) };
        case "set": {
          const rest = entries.filter((e) => !jseEquals((e as unknown[])[0], a[0]));
          d["__map"] = [...rest, [a[0], a[1]]];
          d["size"] = (d["__map"] as unknown[]).length;
          return { value: d };
        }
        case "delete": {
          const rest = entries.filter((e) => !jseEquals((e as unknown[])[0], a[0]));
          const removed = rest.length !== entries.length;
          d["__map"] = rest;
          d["size"] = rest.length;
          return { value: removed };
        }
        default: return null;
      }
    }
    if (d["__set"] !== undefined) {
      const values = Array.isArray(d["__set"]) ? (d["__set"] as unknown[]) : [];
      switch (m) {
        case "has": return { value: values.some((x) => jseEquals(x, a[0])) };
        case "add": {
          if (!values.some((x) => jseEquals(x, a[0]))) {
            d["__set"] = [...values, a[0]];
            d["size"] = (d["__set"] as unknown[]).length;
          }
          return { value: d };
        }
        case "delete": {
          const rest = values.filter((x) => !jseEquals(x, a[0]));
          const removed = rest.length !== values.length;
          d["__set"] = rest;
          d["size"] = rest.length;
          return { value: removed };
        }
        default: return null;
      }
    }
    if (d["__headers"] !== undefined) {
      switch (m) {
        case "get": return { value: d[string(a[0]).toLowerCase()] ?? null };
        case "has": return { value: d[string(a[0]).toLowerCase()] !== undefined };
        case "set": { d[string(a[0]).toLowerCase()] = string(a[1]); return { value: null }; }
        case "append": { d[string(a[0]).toLowerCase()] = string(a[1]); return { value: null }; }
        case "delete": { delete d[string(a[0]).toLowerCase()]; return { value: null }; }
        default: return null;
      }
    }
    if (d["__formData"] !== undefined) {
      const entries = Array.isArray(d["entries"]) ? (d["entries"] as unknown[]) : [];
      switch (m) {
        case "append": case "set": {
          const k = string(a[0]);
          const rest = m === "set" ? entries.filter((e) => string((e as unknown[])[0]) !== k) : entries;
          d["entries"] = [...rest, [k, a[1]]];
          return { value: null };
        }
        case "get": { const hit = entries.find((e) => string((e as unknown[])[0]) === string(a[0])); return { value: hit ? (hit as unknown[])[1] : null }; }
        case "has": return { value: entries.some((e) => string((e as unknown[])[0]) === string(a[0])) };
        case "delete": { d["entries"] = entries.filter((e) => string((e as unknown[])[0]) !== string(a[0])); return { value: null }; }
        default: return null;
      }
    }
    if (d["__abortController"] !== undefined && m === "abort") {
      const sig = d["signal"];
      if (isDict(sig)) (sig as Dict)["aborted"] = true;
      return { value: null };
    }
    if (d["__intlNumber"] !== undefined && m === "format") {
      const opts = d["__intlNumber"] as Dict;
      try {
        return { value: new Intl.NumberFormat(string(d["locale"]) || undefined, opts as Intl.NumberFormatOptions).format(number(a[0]) ?? 0) };
      } catch { return { value: string(a[0]) }; }
    }
    if (d["__intlDate"] !== undefined && m === "format") {
      const opts = d["__intlDate"] as Dict;
      const arg = a[0];
      const ms = isDict(arg) && isDateShape(arg as Dict) ? ((arg as Dict)["__date"] as number) : number(arg) ?? Date.now();
      try {
        return { value: new Intl.DateTimeFormat(string(d["locale"]) || undefined, opts as Intl.DateTimeFormatOptions).format(new Date(ms)) };
      } catch { return { value: toISO(ms) }; }
    }
    if (d["__intlRelative"] !== undefined && m === "format") {
      const opts = d["__intlRelative"] as Dict;
      try {
        return { value: new Intl.RelativeTimeFormat(string(d["locale"]) || undefined, opts as Intl.RelativeTimeFormatOptions).format(number(a[0]) ?? 0, string(a[1]) as Intl.RelativeTimeFormatUnit) };
      } catch { return { value: string(a[0]) + " " + string(a[1]) }; }
    }
    return null;
  },

  /** `'' + date` / `{{ url }}` string coercion for the core shapes. null = no coercion. */
  stringCoerce(d: Dict): string | null {
    if (isDateShape(d)) return toISO(d["__date"] as number);
    if (d["__url"] !== undefined) return string(d["href"]);
    if (d["__params"] !== undefined) return paramsToString(paramsPairs(d));
    if (d["__error"] !== undefined) return string(d["name"] ?? "Error") + ": " + string(d["message"]);   // native-twin coercion
    return null;
  },
};

/** The folded twin. It still serves the two shapes this layer does NOT mint — a regex
 *  literal's `.test()` and the error system's `{__error}` coercion — so the behavior an
 *  embed can actually reach is identical with the layer gone. Everything else answers
 *  "not mine", exactly as it does today for a name JSECore never handled. */
const JSE_CORE_ABSENT: JSECoreApi = {
  handles: () => false,
  call: () => null,
  constant: () => null,
  method(m: string, base: unknown, a: unknown[]): { value: unknown } | null {
    if (!isDict(base)) return null;
    const d = base as Dict;
    if (d["__regex"] !== undefined && d["__regex"] !== null && m === "test") {
      return { value: regexTest(string(a[0]), d) };
    }
    return null;
  },
  stringCoerce(d: Dict): string | null {
    if (d["__error"] !== undefined) return string(d["name"] ?? "Error") + ": " + string(d["message"]);
    return null;
  },
};

export const JSECore: JSECoreApi =
  (globalThis as typeof globalThis & { __DSX_OPTIONAL_JS_GLOBALS__?: boolean })
    .__DSX_OPTIONAL_JS_GLOBALS__ !== false ? JSE_CORE_FULL : JSE_CORE_ABSENT;

function regexTest(s: string, d: Dict): boolean {
  try {
    let flags = "";
    const f = string(d["flags"]);
    if (f.includes("i")) flags += "i";
    if (f.includes("m")) flags += "m";
    if (f.includes("s")) flags += "s";
    return new RegExp(string(d["source"]), flags).test(s);
  } catch {
    return false;
  }
}

function coreMath(fn: string, a: unknown[]): unknown {
  const nums = a.map((x) => number(x) ?? NaN);
  const n = (i: number): number => (i < nums.length ? nums[i]! : NaN);
  switch (fn) {
    case "floor": return Math.floor(n(0));
    case "ceil": return Math.ceil(n(0));
    case "round": return Math.floor(n(0) + 0.5); // JS half-up (incl. negatives)
    case "trunc": { const x = n(0); return Number.isNaN(x) ? x : Math.trunc(x); }
    case "abs": return Math.abs(n(0));
    case "sign": { const x = n(0); return x === 0 ? 0 : x > 0 ? 1 : -1; }
    case "min": return nums.length === 0 ? Infinity : nums.reduce((m, x) => (x < m ? x : m));
    case "max": return nums.length === 0 ? -Infinity : nums.reduce((m, x) => (m < x ? x : m));
    case "pow": return Math.pow(n(0), n(1));
    case "sqrt": return n(0) < 0 ? NaN : Math.sqrt(n(0));
    case "cbrt": return Math.cbrt(n(0));
    case "hypot": return Math.hypot(n(0), n(1));
    case "random": return Math.random();
    case "log": return Math.log(n(0));
    case "log2": return Math.log2(n(0));
    case "log10": return Math.log10(n(0));
    case "exp": return Math.exp(n(0));
    case "sin": return Math.sin(n(0));
    case "cos": return Math.cos(n(0));
    case "tan": return Math.tan(n(0));
    case "atan2": return Math.atan2(n(0), n(1));
    case "atan": return Math.atan(n(0));
    case "asin": return Math.asin(n(0));
    case "acos": return Math.acos(n(0));
    case "sinh": return Math.sinh(n(0));
    case "cosh": return Math.cosh(n(0));
    case "tanh": return Math.tanh(n(0));
    case "asinh": return Math.asinh(n(0));
    case "acosh": return Math.acosh(n(0));
    case "atanh": return Math.atanh(n(0));
    case "log1p": return Math.log1p(n(0));
    case "expm1": return Math.expm1(n(0));
    case "fround": return Math.fround(n(0));
    case "clz32": return Math.clz32(n(0));
    case "imul": return Math.imul(n(0), n(1));
    default: return null;
  }
}

function localeArg(v: unknown): string | undefined {
  const s = string(v);
  return s.length > 0 ? s : undefined;
}

function intlOpts(v: unknown): Dict | undefined {
  return isDict(v) ? (v as Dict) : undefined;
}

function intlCall(name: string, a: unknown[]): unknown {
  const locale = string(a[0]);
  const opts = isDict(a[1]) ? (a[1] as Dict) : {};
  switch (name) {
    case "NumberFormat": return { __intlNumber: opts, locale };
    case "DateTimeFormat": return { __intlDate: opts, locale };
    case "RelativeTimeFormat": return { __intlRelative: opts, locale };
    default: return null;
  }
}

function promiseCall(name: string, a: unknown[]): unknown {
  const items = Array.isArray(a[0]) ? (a[0] as unknown[]) : [];
  const asPromise = (v: unknown): Promise<unknown> => (v instanceof Promise ? v : Promise.resolve(v));
  switch (name) {
    case "all": return Promise.all(items.map(asPromise));
    case "allSettled":
      return Promise.allSettled(items.map(asPromise)).then((rs) =>
        rs.map((r) => (r.status === "fulfilled" ? { status: "fulfilled", value: r.value } : { status: "rejected", reason: string(r.reason) })));
    case "race": return Promise.race(items.map(asPromise));
    case "any": return Promise.any(items.map(asPromise)).catch(() => null);
    case "resolve": return Promise.resolve(a[0]);
    default: return null;
  }
}

function structuredCloneValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(structuredCloneValue);
  if (isDict(v)) {
    const out: Dict = {};
    for (const [k, val] of Object.entries(v as Dict)) out[k] = structuredCloneValue(val);
    return out;
  }
  return v;
}

// wire the string-coercion hook (values.ts ⇄ core.ts cycle-breaker)
setStringCoerce((d) => JSECore.stringCoerce(d));
