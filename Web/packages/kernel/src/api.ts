//
//  api.ts - the `<api>` block runtime, web half (/web/05). Declarative, auto-fetched,
//  reactive data. The cross-platform LAW lives in OpenSource/Conformance/api/
//  api-blocks.json — this file, ApiBlock.kt (Android) and ApiBlock.swift (iOS) all
//  run the same fixtures:
//
//    • reserved paths <as>.data/.loading/.refreshing/.error{status,message,body}/.fetchedAt
//    • refetch when the MATERIALIZED request changes (watchKey-compared — the read set
//      is tracked here via the signal graph; the native twins re-materialize per store
//      publish and compare, same observable law)
//    • auto defaults true for GET (a formula); debounce → abort-stale → refetch
//    • network errors retry; http errors do not; stale data survives a failed refetch
//    • cache: no-store (default) · max-age(d) · swr(fresh, stale) — per-surface,
//      bounded, and keyed by method+url+headers+body+expect+cookie identity;
//      successful non-GET mutations invalidate the surface LRU
//    • events: on:success / on:error / on:message / on:progress (streamed chunks
//      append to data; progress entries publish <as>.progress before the settle)
//    • THE DEPENDENCY GRAPH (/web/11): `needs=` + expression edges make a DAG per
//      component scope; a gated block publishes `<as>.status = "waiting"` +
//      `<as>.blockedBy` and never fires with a hole in its inputs
//    • declared transport controls (networking.md N2): stream · timeout · redirect ·
//      encode (json|text|form|multipart) · via="server" (the proxy route)
//
//  DOM-free by law: the same block runs in the browser, Node (SSR) and tests.
//

import {
  invalidateCookies,
  isStateIdentifier,
  readCookiePartition,
  STATE_PATH_LIMITS,
  type ReactiveStore,
} from "./store.ts";
import { JSE, type Item } from "./jse/jse.ts";
import { NSNull, isDict, number, string, truthy, safeInt, watchKey, type Dict } from "./jse/values.ts";
import { base64Encode, base64Decode } from "./jse/core.ts";
import { RunnerFetchSeam } from "./runner.ts";

export type ApiSpec = {
  as: string;
  url: string;
  method?: string;
  /** JSE — default: true for GET, false otherwise (doc 05) */
  auto?: string;
  /** JSE expression yielding a headers dict */
  headers?: string;
  /** JSE expression yielding the request body */
  body?: string;
  /** json (default) | text | blob */
  expect?: string;
  /** debounce ms before a dep-change refetch */
  debounce?: string;
  /** network-error retries */
  retry?: string;
  /** no-store (default) | max-age(d) | swr(fresh, stale) — durations: N / Ns / Nm / Nh */
  cache?: string;
  /** server-render aware (doc 05/02): default true on GET, false otherwise. A boolean
   *  literal (`ssr="true"` / `ssr="false"`), not a reactive expression. Web-only: it
   *  gates SSR prefetch during render (executeApiForSSR); the native runtimes ignore
   *  it (async is their default), so no cross-platform corpus fixture is required. */
  ssr?: string;
  /** streaming defer (doc 02 "Streaming"): a `defer`red block is NOT awaited during the
   *  initial server render — the shell flushes first and the block keeps its client-fetch
   *  path (loading branch on first paint, data on mount). True OUT-OF-ORDER STREAMING of
   *  the deferred patch (flush a chunk + a store-patch script as it resolves) is the open
   *  SSR seam; until it lands, `defer` = "client-fetched, never SSR-seeded". Web-SSR-only
   *  like `ssr`: the natives are async by default, so no cross-platform corpus is required. */
  defer?: string;
  /** doc 11: edges the expressions don't show (a session side-effect, an ordering-only
   *  constraint) — `needs="a, b"`. An unknown name is a DECLARED error, not a silent wait. */
  needs?: string;
  /** networking.md N2: DECLARED streaming — `stream="true"` opens a streaming read
   *  regardless of content-type, `stream="false"` suppresses the SSE sniff. */
  stream?: string;
  /** networking.md N2: per-request timeout in ms (bare number). 0/absent = host default. */
  timeout?: string;
  /** networking.md N2: redirect policy — follow (default) | error. */
  redirect?: string;
  /** networking.md N2: REQUEST encoding — json (default) | text | form | multipart. */
  encode?: string;
  /** doc 05 "the secrets story": `via="server"` proxies through the generated server
   *  route so the secret-bearing half never reaches the bundle. */
  via?: string;
};

export type ApiEvent = "success" | "error" | "message" | "progress";

/** doc 05 `via="server"` / doc 13 "the embed knows its home origin": the absolute base the
 *  proxy route resolves against. "" = same origin (the browser default); the native hosts
 *  and the embed loader set their configured web origin here. */
export const ApiServerOrigin: { base: string } = { base: "" };

/** an SSR-resolved envelope carried in the hydration payload (doc 02 `api` plane).
 *  The client boot seeds a block from this instead of issuing the initial fetch. */
export type ApiSeed = { data?: unknown; error?: Dict | null; fetchedAt?: number | null };

export type ApiBlockOpts = {
  /** api events out — mount wires these to the tag's on:success/on:error/on:message */
  onEvent?: (name: ApiEvent, payload: Dict) => void;
  /** injected clock (the conformance fixtures drive time; defaults to Date.now) */
  now?: () => number;
  /** SSR hydration seed (doc 02): when present, the block adopts this resolved data
   *  and SKIPS its initial auto-fetch — subsequent dep changes / refresh() / cache
   *  behave normally. Absent = the ordinary fetch-on-mount path (unchanged). */
  seed?: ApiSeed;
  /** doc 11: the component scope's `<api>` DAG. With a graph the block does NOT start on
   *  construction — every sibling mounts first, then `graph.start()` runs the runnable
   *  ones. Without one, the block is its own scope and starts immediately (unchanged). */
  graph?: ApiGraph;
};

export type ApiHandle = {
  refresh(): Promise<void>;
  send(args?: Dict): Promise<unknown>;
  cancel(): void;
  dispose(): void;
};

// ── the cache (surface-scoped, bounded, keyed by the materialized request) ────────────

type CacheEntry = { data: unknown; at: number };
const API_CACHE_LIMIT = 256;
let apiCaches = new WeakMap<ReactiveStore, Map<string, CacheEntry>>();

export function clearApiCache(): void {
  // WeakMap intentionally has no clear(): replace the registry. Existing blocks
  // look the cache up per operation, so the reset takes effect immediately.
  apiCaches = new WeakMap<ReactiveStore, Map<string, CacheEntry>>();
}

function surfaceCache(store: ReactiveStore): Map<string, CacheEntry> {
  let cache = apiCaches.get(store);
  if (cache === undefined) {
    cache = new Map<string, CacheEntry>();
    apiCaches.set(store, cache);
  }
  return cache;
}

function cacheGet(store: ReactiveStore, key: string): CacheEntry | undefined {
  const cache = surfaceCache(store);
  const entry = cache.get(key);
  if (entry !== undefined) {
    // Map insertion order is the LRU ledger; a hit becomes newest.
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

function cachePut(store: ReactiveStore, key: string, entry: CacheEntry): void {
  const cache = surfaceCache(store);
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > API_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function invalidateSurfaceCache(store: ReactiveStore): void {
  apiCaches.delete(store);
}

/** "60" / "60s" / "10m" / "2h" → ms */
function parseDuration(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(s);
  if (m === null) return 0;
  const n = Number(m[1]);
  switch (m[2] ?? "s") {
    case "ms": return n;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: return n * 1000;
  }
}

type CachePolicy = { kind: "no-store" } | { kind: "max-age"; age: number } | { kind: "swr"; fresh: number; stale: number };

function parseCache(attr: string | undefined): CachePolicy {
  if (attr === undefined || attr.trim() === "" || attr.trim() === "no-store") return { kind: "no-store" };
  const maxAge = /^max-age\(([^)]+)\)$/.exec(attr.trim());
  if (maxAge !== null) return { kind: "max-age", age: parseDuration(maxAge[1]!) };
  const swr = /^swr\(([^,)]+),([^)]+)\)$/.exec(attr.trim());
  if (swr !== null) return { kind: "swr", fresh: parseDuration(swr[1]!), stale: parseDuration(swr[2]!) };
  return { kind: "no-store" };
}

// ── the dependency graph (/web/11) ───────────────────────────────────────────────────

/** One gate row: `<as>.blockedBy` is `[{ name, reason }]` while `waiting`. */
export type ApiBlocked = { name: string; reason: string };

/** Every `{{ … }}` hole of an interpolation template, in source order. The gate is
 *  per-HOLE, not per-path: `{{ filter || 'all' }}` is whole, so it never gates. */
function interpolationHoles(template: string): string[] {
  if (!template.includes("{{")) return [];
  const holes: string[] = [];
  let idx = 0;
  for (;;) {
    const open = template.indexOf("{{", idx);
    if (open < 0) break;
    const close = template.indexOf("}}", open + 2);
    if (close < 0) break;
    holes.push(template.substring(open + 2, close));
    idx = close + 2;
  }
  return holes;
}

const EXPR_KEYWORDS = new Set([
  "true", "false", "null", "undefined", "new", "typeof", "in", "of", "return",
  "if", "else", "function", "await", "void", "delete", "instanceof", "this",
]);
/** Ambient planes are TYPED-ABSENT by law (durability P4): an absent const/env/route
 *  value interpolates empty and is NOT a hole waiting to be filled. Gating is for
 *  reactive scope — surface vars, component attributes, and other `<api>` blocks. */
const AMBIENT_ROOTS = new Set([
  "global", "route", "cookie", "platform", "os", "env", "screen", "source", "app",
  "query", "params", "path", "const",
]);
const DSX_SCOPE_HEADS = new Set(["variable", "formula", "item", "attribute", "element", "event", "action"]);

/** The dotted PATHS an expression reads. Conservative by construction: the result is
 *  only ever intersected with the sibling `as` names, or asked whether every path is
 *  ambient. String literals are skipped; `{ key: v }` keys are not paths. */
function expressionPaths(expr: string): string[] {
  const out: string[] = [];
  const n = expr.length;
  const isStart = (c: string): boolean =>
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
  const isPart = (c: string): boolean => isStart(c) || (c >= "0" && c <= "9");
  let i = 0;
  while (i < n) {
    const c = expr[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < n && expr[i] !== c) { if (expr[i] === "\\") i += 1; i += 1; }
      i += 1;
      continue;
    }
    if (!isStart(c)) { i += 1; continue; }
    let j = i;
    while (j < n && isPart(expr[j]!)) j += 1;
    let before = i - 1;
    while (before >= 0 && (expr[before] === " " || expr[before] === "\t" || expr[before] === "\n")) before -= 1;
    let after = j;
    while (after < n && (expr[after] === " " || expr[after] === "\t")) after += 1;
    const isMember = before >= 0 && expr[before] === ".";
    const isObjectKey = expr[after] === ":" && expr[after + 1] !== ":";
    if (isMember || isObjectKey || EXPR_KEYWORDS.has(expr.substring(i, j))) { i = j; continue; }
    let path = expr.substring(i, j);
    let cursor = j;
    for (;;) {
      let dot = cursor;
      while (dot < n && (expr[dot] === " " || expr[dot] === "\t")) dot += 1;
      if (expr[dot] !== "." || !isStart(expr[dot + 1] ?? "")) break;
      let end = dot + 1;
      while (end < n && isPart(expr[end]!)) end += 1;
      path += "." + expr.substring(dot + 1, end);
      cursor = end;
    }
    out.push(path);
    i = cursor;
  }
  return out;
}

/** The scope name a dotted path reads — the graph-edge candidate and the `blockedBy`
 *  name. `dsx.variable.orders.data` → `orders`; `user.data.id` → `user`. */
function pathScopeName(path: string): string {
  const parts = path.split(".");
  if (parts[0] !== "dsx") return parts[0] ?? path;
  if ((parts[1] === "variable" || parts[1] === "formula") && parts[2] !== undefined) return parts[2];
  return "";
}

function pathIsAmbient(path: string): boolean {
  const parts = path.split(".");
  const head = parts[0] ?? "";
  if (head === "dsx") {
    const second = parts[1] ?? "";
    return !DSX_SCOPE_HEADS.has(second);
  }
  return AMBIENT_ROOTS.has(head);
}

/** A hole that reads ONLY ambient planes is never a gate. */
function holeIsAmbient(hole: string): boolean {
  const paths = expressionPaths(hole);
  if (paths.length === 0) return true; // a literal hole cannot be waiting on anything
  return paths.every(pathIsAmbient);
}

/** The name reported for a `missing-value` hole: its first non-ambient scope name. */
function holeName(hole: string): string {
  for (const path of expressionPaths(hole)) {
    if (pathIsAmbient(path)) continue;
    const name = pathScopeName(path);
    if (name.length > 0) return name;
  }
  return hole.trim();
}

/** The upstream `<api>` names one spec reads, in first-appearance order:
 *  `needs=` first (declared), then the expression edges the compiler can see. */
function specUpstreams(spec: ApiSpec, siblings: Set<string>): string[] {
  const out: string[] = [];
  const push = (name: string): void => {
    if (name !== spec.as && siblings.has(name) && !out.includes(name)) out.push(name);
  };
  for (const raw of (spec.needs ?? "").split(",")) {
    const name = raw.trim();
    if (name.length > 0 && name !== spec.as && !out.includes(name)) out.push(name);
  }
  for (const hole of interpolationHoles(spec.url)) {
    for (const path of expressionPaths(hole)) push(pathScopeName(path));
  }
  for (const expr of [spec.headers, spec.body]) {
    if (expr === undefined) continue;
    for (const path of expressionPaths(expr)) push(pathScopeName(path));
  }
  return out;
}

/** `needs=` names that are not `<api>` blocks in this scope — doc 11's lint ERROR, and
 *  a DECLARED runtime error here, because a silent forever-wait is the worse failure. */
function specUnknownNeeds(spec: ApiSpec, siblings: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of (spec.needs ?? "").split(",")) {
    const name = raw.trim();
    if (name.length > 0 && !siblings.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The `<api>` dependency graph of ONE component scope (doc 11). Blocks attach to it,
 *  every block mounts before any fires, and a settled block re-evaluates its dependents:
 *  deep chains waterfall along their own edges, everything else stays concurrent. */
export class ApiGraph {
  private readonly names: string[] = [];
  private readonly upstream = new Map<string, string[]>();
  private readonly blocks = new Map<string, ApiBlock>();
  /** the cycle path, when the declared graph is not a DAG (doc 11: a declared error) */
  readonly cycle: string[] | null;
  private readonly unknown = new Map<string, string[]>();
  private started = false;

  constructor(specs: ApiSpec[]) {
    const siblings = new Set(specs.map((s) => s.as));
    for (const spec of specs) {
      this.names.push(spec.as);
      this.upstream.set(spec.as, specUpstreams(spec, siblings));
      const unknown = specUnknownNeeds(spec, siblings);
      if (unknown.length > 0) this.unknown.set(spec.as, unknown);
    }
    this.cycle = this.findCycle();
  }

  /** DFS with an explicit colour map — returns the first cycle path found, in
   *  declaration order so every runtime reports the same one. */
  private findCycle(): string[] | null {
    const state = new Map<string, number>(); // 0 unvisited · 1 on-stack · 2 done
    const stack: string[] = [];
    const walk = (name: string): string[] | null => {
      if (state.get(name) === 1) return [...stack.slice(stack.indexOf(name)), name];
      if (state.get(name) === 2) return null;
      state.set(name, 1);
      stack.push(name);
      for (const up of this.upstream.get(name) ?? []) {
        if (!this.upstream.has(up)) continue;
        const found = walk(up);
        if (found !== null) return found;
      }
      stack.pop();
      state.set(name, 2);
      return null;
    };
    for (const name of this.names) {
      const found = walk(name);
      if (found !== null) return found;
    }
    return null;
  }

  upstreamsOf(name: string): string[] {
    return this.upstream.get(name) ?? [];
  }

  unknownNeedsOf(name: string): string[] {
    return this.unknown.get(name) ?? [];
  }

  attach(block: ApiBlock, name: string): void {
    this.blocks.set(name, block);
  }

  detach(name: string): void {
    this.blocks.delete(name);
  }

  /** Mount is over — every block is registered, so the runnable ones may start. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const name of this.names) this.blocks.get(name)?.graphStart();
  }

  /** An upstream settled: its dependents re-evaluate and fire the moment THEIR inputs
   *  are whole. Unrelated siblings are untouched (equality-checked identities). */
  notifySettled(settled: string): void {
    if (!this.started) return;
    for (const name of this.names) {
      if (name === settled) continue;
      this.blocks.get(name)?.graphReevaluate();
    }
  }
}

// ── the fetch face (seam-first; real fetch streams SSE) ──────────────────────────────

type FetchOut = Dict & { stream?: unknown[]; streamDelivered?: boolean };

const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_API_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_API_REQUEST_NODES = 250_000;
const MAX_API_REQUEST_DEPTH = 128;
const MAX_API_URL_BYTES = 16 * 1024;
const MAX_API_HEADER_BYTES = 64 * 1024;
const MAX_API_HEADER_COUNT = 100;

class ApiResponseError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

async function readBoundedBytes(res: Response): Promise<Uint8Array> {
  const advertised = Number(res.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_API_RESPONSE_BYTES) {
    throw new ApiResponseError("response_too_large");
  }
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_API_RESPONSE_BYTES) {
      try { await reader.cancel("response_too_large"); } catch { /* already closed */ }
      throw new ApiResponseError("response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeSseData(data: string): unknown {
  try { return JSON.parse(data); } catch { return data; }
}

function escapedJsonStringBytes(value: string, remaining: number): number {
  let bytes = 2; // quotes
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code <= 0x1f) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6; // JSON.stringify escapes an unpaired surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > remaining) return bytes;
  }
  return bytes;
}

/** Reject hostile/deep request graphs before JSON.stringify can monopolize the UI
 *  thread or allocate an unbounded intermediate string. */
function preflightJsonBody(value: unknown): void {
  type Frame = { value?: unknown; depth: number; exit?: object };
  const stack: Frame[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const add = (count: number): void => {
    bytes += count;
    if (bytes > MAX_API_REQUEST_BYTES) {
      throw new ApiResponseError("request_too_large");
    }
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit !== undefined) {
      ancestors.delete(frame.exit);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_API_REQUEST_NODES || frame.depth > MAX_API_REQUEST_DEPTH) {
      throw new ApiResponseError("request_too_complex");
    }
    const next = frame.value;
    if (next === null || next === undefined || next === NSNull) {
      add(4);
    } else if (typeof next === "string") {
      add(escapedJsonStringBytes(next, MAX_API_REQUEST_BYTES - bytes));
    } else if (typeof next === "number") {
      add(Number.isFinite(next) ? String(next).length : 4);
    } else if (typeof next === "boolean") {
      add(next ? 4 : 5);
    } else if (Array.isArray(next)) {
      if (ancestors.has(next)) throw new ApiResponseError("invalid_request");
      ancestors.add(next);
      add(2 + Math.max(0, next.length - 1));
      stack.push({ depth: frame.depth, exit: next });
      for (let index = next.length - 1; index >= 0; index -= 1) {
        stack.push({ value: next[index], depth: frame.depth + 1 });
      }
    } else if (isDict(next)) {
      if (ancestors.has(next)) throw new ApiResponseError("invalid_request");
      ancestors.add(next);
      const entries = Object.entries(next);
      add(2 + Math.max(0, entries.length - 1));
      stack.push({ depth: frame.depth, exit: next });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, entryValue] = entries[index]!;
        add(escapedJsonStringBytes(key, MAX_API_REQUEST_BYTES - bytes) + 1);
        stack.push({ value: entryValue, depth: frame.depth + 1 });
      }
    } else {
      throw new ApiResponseError("invalid_request");
    }
  }
}

function compactBodyHash(value: string): string {
  // Four independent 32-bit lanes keep cache keys compact (request bodies are
  // capped at 4 MiB) while making accidental collisions vanishingly small.
  const lanes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      lanes[lane] = Math.imul((lanes[lane]! ^ code) >>> 0, 0x01000193 + lane * 2) >>> 0;
    }
  }
  return `${value.length}:` + lanes.map((lane) => lane.toString(16).padStart(8, "0")).join("");
}

type PreparedRequestBody = { wire?: string; key: string };

function prepareRequestBody(rawBody: unknown): PreparedRequestBody {
  if (rawBody === undefined || rawBody === null || rawBody === NSNull) return { key: "∅" };
  if (typeof rawBody === "string") {
    if (rawBody.length > MAX_API_REQUEST_BYTES) {
      throw new ApiResponseError("request_too_large");
    }
    if (new TextEncoder().encode(rawBody).byteLength > MAX_API_REQUEST_BYTES) {
      throw new ApiResponseError("request_too_large");
    }
    return { wire: rawBody, key: `text:${compactBodyHash(rawBody)}` };
  }
  preflightJsonBody(rawBody);
  const encoded = JSON.stringify(rawBody, (_k, v: unknown) => (v === NSNull ? null : v));
  if (encoded === undefined) throw new ApiResponseError("invalid_request");
  if (new TextEncoder().encode(encoded).byteLength > MAX_API_REQUEST_BYTES) {
    throw new ApiResponseError("request_too_large");
  }
  return { wire: encoded, key: `json:${compactBodyHash(encoded)}` };
}

/** networking.md N2 — the declared REQUEST encodings the kernel materializes itself, so
 *  all three runtimes put the same bytes (or the same `parts`) on the wire. */
function encodeFormBody(body: unknown): string {
  if (!isDict(body)) return string(body);
  const dict = body as Dict;
  return Object.keys(dict).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(string(dict[k]))}`)
    .join("&");
}

/** multipart/form-data parts, SORTED BY FIELD NAME so the corpus is order-deterministic
 *  on runtimes whose native dictionaries are unordered. A `{ __blob, type, name }` value
 *  (the JSE Blob/File shape) becomes a file part; everything else a value part. */
function multipartParts(body: unknown): Dict[] {
  if (!isDict(body)) return [];
  const dict = body as Dict;
  const out: Dict[] = [];
  for (const key of Object.keys(dict).sort()) {
    const value = dict[key];
    if (isDict(value) && typeof (value as Dict)["__blob"] === "string") {
      const blob = value as Dict;
      const part: Dict = { name: key, blob: blob["__blob"] };
      if (typeof blob["name"] === "string") part["filename"] = blob["name"];
      if (typeof blob["type"] === "string") part["contentType"] = blob["type"];
      out.push(part);
    } else {
      out.push({ name: key, value: string(value) });
    }
  }
  return out;
}

function validateRequestMetadata(req: Dict): void {
  if (new TextEncoder().encode(string(req["url"])).byteLength > MAX_API_URL_BYTES) {
    throw new ApiResponseError("request_too_large");
  }
  const entries = isDict(req["headers"]) ? Object.entries(req["headers"] as Dict) : [];
  if (entries.length > MAX_API_HEADER_COUNT) {
    throw new ApiResponseError("request_too_large");
  }
  let bytes = 0;
  for (const [name, value] of entries) {
    bytes += new TextEncoder().encode(name).byteLength + new TextEncoder().encode(string(value)).byteLength + 4;
    if (bytes > MAX_API_HEADER_BYTES) {
      throw new ApiResponseError("request_too_large");
    }
  }
}

function normalizeRequestHeaders(value: unknown): Dict | null {
  if (!isDict(value)) return null;
  const headers: Dict = {};
  for (const [rawName, rawValue] of Object.entries(value as Dict)) {
    if (rawName.startsWith("__")) continue; // portable `new Headers()` marker
    const name = rawName.trim().toLowerCase();
    if (name.length > 0) headers[name] = string(rawValue);
  }
  return headers;
}

function isHttpsDowngrade(requestUrl: string, responseUrl: string): boolean {
  if (responseUrl.length === 0) return false; // injected/test Responses have no URL
  try {
    const base = typeof location !== "undefined" ? location.href : undefined;
    const initial = new URL(requestUrl, base);
    const final = new URL(responseUrl);
    return initial.protocol === "https:" && final.protocol === "http:";
  } catch {
    return false;
  }
}

/** Node 22 and every current browser expose `AbortSignal.any`; the fallback keeps the
 *  author's own cancellation authoritative when a runtime predates it. */
function combineSignals(a: AbortSignal | null, b: AbortSignal | null): AbortSignal | null {
  if (a === null) return b;
  if (b === null) return a;
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof any === "function" ? any([a, b]) : a;
}

/** networking.md N2 "multipart/file": the materialized `parts` (already sorted by field
 *  name) become a real multipart body. `FormData`/`Blob` are fetch globals, not DOM —
 *  the block stays DOM-free and runs identically in the browser, Node and tests. */
function multipartFormData(parts: Dict[]): FormData {
  const form = new FormData();
  for (const part of parts) {
    const name = string(part["name"]);
    if (name.length === 0) continue;
    const blob = part["blob"];
    if (typeof blob === "string") {
      const bytes = base64Decode(blob) ?? new Uint8Array();
      const type = string(part["contentType"] ?? "application/octet-stream");
      const filename = string(part["filename"] ?? name);
      form.append(name, new Blob([bytes as BlobPart], { type }), filename);
    } else {
      form.append(name, string(part["value"]));
    }
  }
  return form;
}

async function doFetch(
  url: string,
  init: Dict,
  signal: AbortSignal | null,
  onStreamMessage?: (chunk: unknown) => void,
): Promise<FetchOut> {
  if (RunnerFetchSeam.impl) return RunnerFetchSeam.impl(url, { ...init, signal });
  const method = string(init["method"] ?? "GET") || "GET";
  const headers: { [k: string]: string } = {};
  if (isDict(init["headers"])) {
    for (const [k, v] of Object.entries(init["headers"] as Dict)) headers[k] = string(v);
  }
  let body: string | FormData | undefined;
  const rawBody = init["body"];
  try {
    validateRequestMetadata(init);
    // networking.md N2: a DECLARED encoding (text/form/multipart) already materialized
    // its wire form (or its `parts`); only the default json path prepares here.
    if (Array.isArray(init["parts"])) {
      body = multipartFormData(init["parts"] as Dict[]);
    } else if (typeof init["wire"] === "string") {
      body = init["wire"] as string;
    } else {
      const prepared = typeof init["__dsxBodyKey"] === "string"
        ? { wire: typeof init["__dsxBodyWire"] === "string" ? init["__dsxBodyWire"] as string : undefined }
        : prepareRequestBody(rawBody);
      body = prepared.wire;
      if (body !== undefined && typeof rawBody !== "string"
        && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  } catch (error) {
    const failure = error as { code?: string };
    return {
      ok: false,
      status: -2,
      data: null,
      error: failure.code ?? "invalid_request",
    };
  }
  // networking.md N2 "Control": a declared per-request timeout is an abort with its own
  // reason, so it is distinguishable from an author cancel; a declared redirect policy
  // rides straight through to the transport.
  const timeoutMs = safeInt(number(init["timeout"]) ?? 0);
  const timeoutController = timeoutMs > 0 && typeof AbortController !== "undefined" ? new AbortController() : null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (timeoutController !== null) {
    timeoutTimer = setTimeout(() => { timedOut = true; timeoutController.abort(); }, timeoutMs);
  }
  const effectiveSignal = combineSignals(signal, timeoutController?.signal ?? null);
  const redirect = string(init["redirect"] ?? "");
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      ...(redirect === "error" || redirect === "follow" ? { redirect: redirect as RequestRedirect } : {}),
      ...(effectiveSignal ? { signal: effectiveSignal } : {}),
    });
  } catch (e) {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    if (timedOut) return { ok: false, status: -2, data: null, error: "timeout" };
    if ((e as { name?: string }).name === "AbortError") return { ok: false, status: -1, aborted: true, data: null };
    if ((e as { name?: string }).name === "TypeError" && redirect === "error") {
      return { ok: false, status: -2, data: null, error: "redirect" };
    }
    return { ok: false, status: 0, data: null, error: "network" };
  }
  if (timeoutTimer !== null) clearTimeout(timeoutTimer);
  const contentType = res.headers.get("content-type") ?? "";
  const outHeaders: Dict = {};
  res.headers.forEach((v, k) => { outHeaders[k] = v; });
  if (isHttpsDowngrade(url, res.url)) {
    try { await res.body?.cancel("insecure_redirect"); } catch { /* already closed */ }
    return {
      ok: false,
      status: -2,
      data: null,
      headers: outHeaders,
      error: "insecure_redirect",
    };
  }
  try {
    // Server-Sent Events are delivered while the connection is still open. A
    // line parser (rather than split("\n\n")) preserves CRLF and chunk-boundary
    // correctness and joins multi-line data fields per the SSE wire format.
    // networking.md N2: streaming is DECLARED, not sniffed. `stream="false"` reads an
    // event-stream as an ordinary body; `stream="true"` streams a non-SSE body as
    // newline-delimited chunks. Absent, the historical content-type sniff still applies.
    const declaredStream = init["stream"];
    const sse = contentType.includes("text/event-stream");
    const streaming = declaredStream === false ? false : (sse || declaredStream === true);
    if (streaming && res.body !== null) {
      const advertised = Number(res.headers.get("content-length"));
      if (Number.isFinite(advertised) && advertised > MAX_API_RESPONSE_BYTES) {
        throw new ApiResponseError("response_too_large");
      }
      const chunks: unknown[] = [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const dataLines: string[] = [];
      let line = "";
      let skipLineFeed = false;
      let totalBytes = 0;
      let firstLine = true;

      const dispatch = (): void => {
        if (dataLines.length === 0) return;
        const chunk = decodeSseData(dataLines.join("\n"));
        dataLines.length = 0;
        chunks.push(chunk);
        if (res.ok) onStreamMessage?.(chunk);
      };
      const acceptLine = (rawLine: string): void => {
        let nextLine = rawLine;
        if (firstLine) {
          firstLine = false;
          if (nextLine.startsWith("\uFEFF")) nextLine = nextLine.substring(1);
        }
        if (!sse) {
          // a declared non-SSE stream is newline-delimited: one whole line, one chunk
          if (nextLine.length === 0) return;
          dataLines.push(nextLine);
          dispatch();
          return;
        }
        if (nextLine === "") {
          dispatch();
          return;
        }
        if (nextLine.startsWith(":")) return;
        const colon = nextLine.indexOf(":");
        const field = colon < 0 ? nextLine : nextLine.substring(0, colon);
        if (field !== "data") return;
        let value = colon < 0 ? "" : nextLine.substring(colon + 1);
        if (value.startsWith(" ")) value = value.substring(1);
        dataLines.push(value);
      };
      const consume = (text: string): void => {
        for (const character of text) {
          if (skipLineFeed) {
            skipLineFeed = false;
            if (character === "\n") continue;
          }
          if (character === "\r") {
            acceptLine(line);
            line = "";
            skipLineFeed = true;
          } else if (character === "\n") {
            acceptLine(line);
            line = "";
          } else {
            line += character;
          }
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_API_RESPONSE_BYTES) {
          try { await reader.cancel("response_too_large"); } catch { /* already closed */ }
          throw new ApiResponseError("response_too_large");
        }
        consume(decoder.decode(value, { stream: true }));
      }
      consume(decoder.decode());
      if (line.length > 0) acceptLine(line);
      dispatch();
      return {
        ok: res.ok,
        status: res.status,
        data: chunks,
        headers: outHeaders,
        stream: chunks,
        streamDelivered: res.ok,
      };
    }
    const bytes = await readBoundedBytes(res);
    const expected = string(init["expect"]) || "json";
    const text = expected === "blob" ? "" : new TextDecoder().decode(bytes);
    let data: unknown;
    if (expected === "blob") {
      data = {
        __blob: base64Encode(bytes),
        type: contentType.split(";", 1)[0]!.trim(),
        size: bytes.byteLength,
      };
    } else if (expected === "text") data = text;
    else if (contentType.includes("json")) data = text.length > 0 ? JSON.parse(text) : null;
    else data = text;
    return { ok: res.ok, status: res.status, data, headers: outHeaders };
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") return { ok: false, status: -1, aborted: true, data: null };
    const failure = e as { code?: string };
    return {
      ok: false,
      // Parsing/size failures are terminal response failures, not transport
      // failures: status -2 prevents the network-retry loop from amplifying them.
      status: -2,
      data: null,
      error: failure.code ?? "invalid_response",
    };
  }
}

// ── materialization + SSR prefetch (shared with @despia/server render) ──────────────────

/** Evaluate url/headers/body/auto in `store`'s scope — the ONE place the request is
 *  materialized (the block's dependency effect and the SSR prefetch below both use it,
 *  so the request an SSR run executes is byte-for-byte the one the client would). */
export function materializeApiRequest(spec: ApiSpec, store: ReactiveStore, item: Item): Dict {
  const method = (spec.method ?? "GET").trim().toUpperCase();
  const expectWord = (spec.expect ?? "json").trim().toLowerCase();
  const expect = expectWord === "text" || expectWord === "blob" ? expectWord : "json";
  const autoExpr = spec.auto;
  const auto = autoExpr !== undefined
    ? truthy(JSE.eval(autoExpr, store.jse, item))
    : method === "GET"; // auto defaults true for GET (doc 05)
  // doc 11 value-presence gating is derived from the SAME pass that interpolates, so a
  // gated block costs no extra evaluation: each `{{ … }}` hole that lands in the url is
  // checked as it is written. Ambient planes are typed-absent, never holes.
  const missing: string[] = [];
  const url = interpolateGated(spec.url, store, item, missing);
  const rawHeaders = spec.headers !== undefined ? JSE.eval(spec.headers, store.jse, item) : null;
  if (isDict(rawHeaders)) {
    const dict = rawHeaders as Dict;
    for (const key of Object.keys(dict).sort()) {
      const value = dict[key];
      if ((value === null || value === undefined || value === NSNull) && !missing.includes(key)) {
        missing.push(key);
      }
    }
  }
  const headers = normalizeRequestHeaders(rawHeaders);
  const body = spec.body !== undefined ? JSE.eval(spec.body, store.jse, item) : null;
  if (spec.body !== undefined && (body === null || body === undefined || body === NSNull)) {
    for (const path of expressionPaths(spec.body)) {
      if (pathIsAmbient(path)) continue;
      const name = pathScopeName(path);
      if (name.length > 0 && !missing.includes(name)) missing.push(name);
      break;
    }
  }
  const req: Dict = {
    url,
    method,
    headers,
    body,
    expect,
    // GET/HEAD responses are identity-sensitive even when auth rides an implicit cookie.
    cookiePartition: method === "GET" || method === "HEAD" ? readCookiePartition() : null,
    auto,
    _missing: missing,
  };
  applyTransportControls(spec, req);
  return req;
}

/** `JSE.interpolate`, with the doc-11 hole ledger: a `{{ … }}` that evaluates to
 *  null/undefined and reads at least one non-ambient path records its scope name. */
function interpolateGated(template: string, store: ReactiveStore, item: Item, missing: string[]): string {
  if (!template.includes("{{")) return template;
  let out = "";
  let idx = 0;
  for (;;) {
    const open = template.indexOf("{{", idx);
    if (open < 0) break;
    out += template.substring(idx, open);
    const close = template.indexOf("}}", open + 2);
    if (close < 0) { out += template.substring(open); return out; }
    const hole = template.substring(open + 2, close);
    const value = JSE.eval(hole, store.jse, item);
    if ((value === null || value === undefined || value === NSNull) && !holeIsAmbient(hole)) {
      const name = holeName(hole);
      if (!missing.includes(name)) missing.push(name);
    }
    out += string(value);
    idx = close + 2;
  }
  out += template.substring(idx);
  return out;
}

/** networking.md N2 + doc 05's secrets story: fold the DECLARED transport controls into
 *  the materialized request. Nothing here is sniffed — every one is authored. */
function applyTransportControls(spec: ApiSpec, req: Dict): void {
  const flag = (raw: string | undefined): boolean | null => {
    if (raw === undefined) return null;
    const v = raw.trim().toLowerCase();
    if (v === "" || v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return null;
  };
  const stream = flag(spec.stream);
  if (stream !== null) req["stream"] = stream;
  const timeout = safeInt(number((spec.timeout ?? "").trim()) ?? 0);
  if (timeout > 0) req["timeout"] = timeout;
  const redirect = (spec.redirect ?? "").trim().toLowerCase();
  if (redirect === "error" || redirect === "follow") req["redirect"] = redirect;
  const encodeWord = (spec.encode ?? "json").trim().toLowerCase();
  if (encodeWord === "text" || encodeWord === "form" || encodeWord === "multipart") {
    req["encode"] = encodeWord;
    const headers: Dict = isDict(req["headers"]) ? (req["headers"] as Dict) : {};
    if (encodeWord === "multipart") {
      req["parts"] = multipartParts(req["body"]);
    } else {
      req["wire"] = encodeWord === "form" ? encodeFormBody(req["body"]) : string(req["body"]);
      if (headers["content-type"] === undefined) {
        headers["content-type"] = encodeWord === "form"
          ? "application/x-www-form-urlencoded;charset=UTF-8"
          : "text/plain;charset=UTF-8";
      }
    }
    req["headers"] = headers;
  }
  if ((spec.via ?? "").trim().toLowerCase() === "server") {
    // The CLIENT half calls the generated internal route; the SERVER half performs the
    // real request with server-held headers. The target rides as one encoded parameter
    // so the proxy needs no per-block code — and no secret is ever in the bundle.
    const target = string(req["url"]);
    req["via"] = "server";
    req["target"] = target;
    req["url"] = `${ApiServerOrigin.base}/dsx/api/${spec.as}?u=${encodeURIComponent(target)}`;
  }
}

/** doc 05/02: `ssr` defaults true for GET, false otherwise; an explicit boolean-literal
 *  attribute overrides. A non-GET is NEVER eligible (a mutation must never run during
 *  render), regardless of the flag. A `defer`red block is also ineligible — the shell
 *  flushes without it and it fetches on the client (the streaming flush is the open seam). */
export function apiSsrEnabled(spec: ApiSpec): boolean {
  const method = (spec.method ?? "GET").trim().toUpperCase();
  if (method !== "GET") return false;
  if (apiDeferred(spec)) return false;
  const raw = spec.ssr;
  if (raw === undefined) return true; // default true on GET
  const v = raw.trim().toLowerCase();
  return v === "" || v === "true" || v === "1";
}

/** doc 02 "Streaming": a boolean-literal `defer` marks a block for out-of-order streaming.
 *  The initial render never awaits a deferred block — the shell flushes with its loading
 *  branch; a STREAMING adapter (server stream.ts renderPageStream) then runs it and
 *  flushes its seed as a late chunk, and a non-streaming render leaves it on the
 *  client-fetch path (fail-open either way). */
export function apiDeferred(spec: ApiSpec): boolean {
  const raw = spec.defer;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "true" || v === "1";
}

/** doc 02 out-of-order streaming: is this block one the STREAM runs after the initial
 *  flush? Exactly the ssr-eligibility ladder with the defer arm inverted — a deferred
 *  GET whose `ssr` flag is not explicitly false. Web-SSR infrastructure, like `ssr=`
 *  itself: no native twin owed (the unified-codebase law's infrastructure exemption). */
export function apiStreamEligible(spec: ApiSpec): boolean {
  const method = (spec.method ?? "GET").trim().toUpperCase();
  if (method !== "GET" || !apiDeferred(spec)) return false;
  const raw = spec.ssr;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "true" || v === "1";
}

export type SsrApiOutcome =
  /** ineligible (ssr=false, non-GET, or auto=false) — never seeded; client fetches on mount */
  | { status: "skip" }
  /** attempted but not usable (network/timeout/http/decode) — fall back to the client
   *  fetch path (fail-open: SSR is a pure optimization, never a broken page) */
  | { status: "client"; code: string }
  /** resolved ok — seed this envelope into the hydration payload */
  | { status: "seed"; envelope: ApiSeed };

const DEFAULT_SSR_TIMEOUT_MS = 5000;

/** Execute one `<api>` block during server render (doc 05 "SSR semantics"). Bounded by
 *  a hard timeout and returns a normalized outcome. ONLY a clean, ok GET response is
 *  seeded; every failure (network error, timeout, abort, http error, decode error)
 *  falls back to the client-fetch path so the page is never broken by a bad upstream. */
export async function executeApiForSSR(
  spec: ApiSpec,
  store: ReactiveStore,
  item: Item,
  opts: { now?: () => number; timeoutMs?: number; allowDeferred?: boolean } = {},
): Promise<SsrApiOutcome> {
  // `allowDeferred` is the STREAM pass (renderPageStream): the same execution, gated by
  // apiStreamEligible instead — a deferred block runs AFTER the initial flush there.
  if (!apiSsrEnabled(spec) &&
      !(opts.allowDeferred === true && apiStreamEligible(spec))) return { status: "skip" };
  const req = materializeApiRequest(spec, store, item);
  if (string(req["method"]).toUpperCase() !== "GET") return { status: "skip" };
  if (!truthy(req["auto"])) return { status: "skip" }; // auto="false" is imperative-only
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SSR_TIMEOUT_MS;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const TIMEOUT = Symbol("ssr-timeout");
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  let res: FetchOut | typeof TIMEOUT;
  try {
    // Prepare the request under the same guards as a live fire (body/header/url bounds).
    try { validateRequestMetadata(req); prepareRequestBody(req["body"]); } catch (error) {
      const failure = error as { code?: string };
      return { status: "client", code: failure.code ?? "invalid_request" };
    }
    res = await Promise.race([doFetch(string(req["url"]), req, controller?.signal ?? null), timeout]);
  } catch {
    return { status: "client", code: "ssr_fetch_threw" };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  if (res === TIMEOUT) {
    controller?.abort(); // bound even a seam/host that ignores the signal
    return { status: "client", code: "ssr_timeout" };
  }
  if (truthy(res["aborted"])) return { status: "client", code: "ssr_aborted" };
  if (!truthy(res["ok"])) {
    return { status: "client", code: string(res["error"] ?? `http_${string(res["status"])}`) };
  }
  // A streamed SSR response collapses to its accumulated chunk array (doc 02 defers
  // true streaming — that seam stays client-side for now).
  const data = Array.isArray(res.stream) ? res.stream : (res["data"] ?? null);
  return { status: "seed", envelope: { data, error: null, fetchedAt: now() } };
}

// ── the block ────────────────────────────────────────────────────────────────────────

export class ApiBlock implements ApiHandle {
  private readonly spec: ApiSpec;
  private readonly store: ReactiveStore;
  private readonly item: Item;
  private readonly onEvent: (name: ApiEvent, payload: Dict) => void;
  private readonly now: () => number;
  private readonly policy: CachePolicy;
  private readonly seed: ApiSeed | undefined;
  private readonly graph: ApiGraph | null;
  private disposeEffect: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private first = true;
  private trackedRequest: Dict | null = null;
  private trackedIdentity: string | null = null;
  private trackedVersion = 0;
  private trackedBlocked: ApiBlocked[] = [];
  private handledVersion = -1;
  private declaredError: string | null = null;

  constructor(spec: ApiSpec, store: ReactiveStore, item: Item, opts: ApiBlockOpts = {}) {
    if (!isStateIdentifier(spec.as)) {
      throw new TypeError("<api as> must be an ASCII identifier of at most 128 characters");
    }
    if (!store.vars.has(spec.as) && store.vars.size >= STATE_PATH_LIMITS.maxContainerEntries) {
      throw new RangeError("<api as> exceeds the store container-entry budget");
    }
    this.spec = spec;
    this.store = store;
    this.item = item;
    this.onEvent = opts.onEvent ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    this.policy = parseCache(spec.cache);
    this.seed = opts.seed;
    this.graph = opts.graph ?? null;
    // seed the reserved paths — data null until first resolve (doc 05), OR the
    // SSR-resolved envelope when a hydration seed is supplied (doc 02). `status` +
    // `blockedBy` are doc 11's additions to the same reserved envelope.
    if (store.vars.get(spec.as) === undefined) {
      const seed = this.seed;
      store.set(spec.as, seed !== undefined
        ? { data: seed.data ?? null, loading: false, refreshing: false, error: seed.error ?? null, fetchedAt: seed.fetchedAt ?? null, status: seed.error != null ? "error" : "ready", blockedBy: [], progress: null }
        : { data: null, loading: false, refreshing: false, error: null, fetchedAt: null, status: "ready", blockedBy: [], progress: null });
    }
    // doc 11: a cycle / an unknown `needs=` is a DECLARED error — the block publishes it
    // and issues no request, because a silent forever-wait is the worse failure mode.
    if (this.graph !== null) {
      const cycle = this.graph.cycle;
      if (cycle !== null && cycle.includes(spec.as)) this.declaredError = "cycle";
      else if (this.graph.unknownNeedsOf(spec.as).length > 0) this.declaredError = "unknown-needs";
      this.graph.attach(this, spec.as);
    }
    if (this.graph === null) this.startEffect();
  }

  /** doc 11: the graph starts its blocks only once EVERY sibling has mounted, so the
   *  runnable set is computed against the whole scope, not against mount order. */
  graphStart(): void {
    if (this.disposeEffect === null) this.startEffect();
  }

  /** doc 02 out-of-order streaming: adopt a SERVER-resolved envelope that arrived over
   *  the response stream AFTER this block mounted (web-SSR infrastructure, like `ssr=`).
   *  Applied only while the block has not itself SETTLED (no fetchedAt, no error) — the
   *  client's own resolved envelope always wins, never a backwards flash. An in-flight
   *  initial fetch is superseded exactly like a stale response (generation bump + abort).
   *  Fires `success` like any resolved-ok request (corpus law 7). Returns whether the
   *  seed took. */
  seedLate(seed: ApiSeed): boolean {
    const as = this.spec.as;
    const current = this.store.vars.get(as);
    if (isDict(current)) {
      const cur = current as Dict;
      if (cur["fetchedAt"] != null || cur["error"] != null) return false;
    }
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.store.set(as, {
      data: seed.data ?? null, loading: false, refreshing: false,
      error: seed.error ?? null, fetchedAt: seed.fetchedAt ?? this.now(),
      status: seed.error != null ? "error" : "ready", blockedBy: [], progress: null,
    });
    this.emitEvent("success", { data: seed.data ?? null, status: 200, streamed: true });
    this.graph?.notifySettled(as);
    return true;
  }

  /** An upstream settled. Re-materialize + re-gate; the identity guard means an
   *  unrelated settle, or a refetch that produced identical data, is a no-op. */
  graphReevaluate(): void {
    if (this.disposeEffect === null) return;
    this.trackMaterializedRequest();
    this.runTrackedChange();
  }

  private startEffect(): void {
    if (this.declaredError !== null) {
      this.publishDeclaredError(this.declaredError);
      return;
    }
    // the dependency effect: evaluating the request INSIDE the tracker makes its read
    // set the trigger; watchKey dedup means we refire only when the MATERIALIZED
    // request (or its doc-11 gate) changes — the cross-platform law the native twins
    // match by comparison
    this.disposeEffect = this.store.effect(
      () => this.trackMaterializedRequest(),
      () => this.runTrackedChange(),
    );
  }

  /** The effect body, guarded so the graph's synchronous nudge and the signal graph's
   *  scheduled re-run can never fire the same tracked version twice. */
  private runTrackedChange(): void {
    if (this.trackedVersion === this.handledVersion) return;
    this.handledVersion = this.trackedVersion;
    const req = this.trackedRequest ?? this.materialize();
    const auto = truthy(req["auto"]);
    if (!auto) { this.first = false; this.publishGate([]); return; }
    if (this.trackedBlocked.length > 0) {
      // doc 11: a gated block never fires. It LOOKS loading to the UI, because from the
      // user's seat it is — the data is on its way, down someone else's edge.
      this.publishGate(this.trackedBlocked);
      return;
    }
    this.publishGate([]);
    if (this.first && this.seed !== undefined) {
      // SSR-seeded (doc 02): adopt the server-resolved data instead of issuing the
      // initial fetch. A later dep change / refresh() fetches normally.
      this.first = false;
      this.primeSeedCache(req);
      return;
    }
    const wait = this.first ? 0 : safeInt(number(this.spec.debounce) ?? 0);
    this.first = false;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (wait > 0) {
      this.debounceTimer = setTimeout(() => { void this.fire(req, { allowCache: true }); }, wait);
    } else {
      void this.fire(req, { allowCache: true });
    }
  }

  /** evaluate url/headers/body/auto in the current scope (tracked) */
  private materialize(): Dict {
    return materializeApiRequest(this.spec, this.store, this.item);
  }

  /** SSR-seeded blocks skip the first fetch; on a cacheable policy, prime the cache
   *  with the seed so a same-request revisit inside the fresh window is a hit, not a
   *  network call (doc 02: "the client marks them fresh per cache"). */
  private primeSeedCache(req: Dict): void {
    if (this.seed === undefined || this.policy.kind === "no-store") return;
    try {
      this.prepareRequest(req);
      cachePut(this.store, this.cacheKey(req), { data: this.seed.data ?? null, at: this.seed.fetchedAt ?? this.now() });
    } catch { /* a bad request just means no cache prime — the seed still stands */ }
  }

  private prepareRequest(req: Dict): void {
    validateRequestMetadata(req);
    const prepared = prepareRequestBody(req["body"]);
    req["__dsxBodyWire"] = prepared.wire;
    req["__dsxBodyKey"] = prepared.key;
  }

  /** The ReactiveStore's generic effect key must never recursively walk an
   *  unbounded authored body. Validate/encode first, then compare the bounded
   *  wire string exactly and expose only a tiny monotonic version to the store. */
  private trackMaterializedRequest(): number {
    const req = this.materialize();
    let identity: string;
    try {
      this.prepareRequest(req);
      identity = `${string(req["method"])}${string(req["url"])}${watchKey(req["headers"] ?? null)}${string(req["__dsxBodyWire"] ?? "")}${string(req["expect"])}${watchKey(req["cookiePartition"] ?? null)}${truthy(req["auto"]) ? "1" : "0"}`;
    } catch (error) {
      const failure = error as { code?: string };
      req["__dsxRequestError"] = failure.code ?? "invalid_request";
      const rawBody = req["body"];
      const bodyShape = typeof rawBody === "string" ? `string:${rawBody.length}` : typeof rawBody;
      identity = `error${string(req["method"])}${string(req["url"]).slice(0, MAX_API_URL_BYTES)}${string(req["__dsxRequestError"])}${bodyShape}${truthy(req["auto"]) ? "1" : "0"}`;
    }
    // doc 11: the GATE is part of the tracked identity, and it is computed here — INSIDE
    // the tracker — so reading an upstream's `error`/`fetchedAt` subscribes this block to
    // it. A `needs=` edge is otherwise invisible to the signal graph.
    const blocked = this.gate(req);
    this.trackedBlocked = blocked;
    this.trackedRequest = req;
    identity += `|${blocked.map((b) => `${b.name}:${b.reason}`).join(",")}`;
    if (identity !== this.trackedIdentity) {
      this.trackedIdentity = identity;
      this.trackedVersion += 1;
    }
    return this.trackedVersion;
  }

  /** doc 11's four gate rules, in a deterministic order: `needs=` and expression edges
   *  first (an upstream that has not resolved, or one carrying an error), then the
   *  value-presence holes the materialization already recorded. */
  private gate(req: Dict): ApiBlocked[] {
    if (!truthy(req["auto"])) return [];
    const out: ApiBlocked[] = [];
    const seen = new Set<string>();
    const add = (name: string, reason: string): void => {
      if (name.length === 0 || seen.has(name)) return;
      seen.add(name);
      out.push({ name, reason });
    };
    for (const name of this.graph?.upstreamsOf(this.spec.as) ?? []) {
      const error = JSE.eval(`${name}.error`, this.store.jse, null);
      if (error !== null && error !== undefined && error !== NSNull) { add(name, "upstream-error"); continue; }
      const fetchedAt = JSE.eval(`${name}.fetchedAt`, this.store.jse, null);
      if (fetchedAt === null || fetchedAt === undefined || fetchedAt === NSNull) add(name, "unresolved");
    }
    const missing = req["_missing"];
    if (Array.isArray(missing)) for (const name of missing) add(string(name), "missing-value");
    return out;
  }

  /** `<as>.status` / `<as>.blockedBy` (doc 11). `loading` stays TRUE while waiting. */
  private publishGate(blocked: ApiBlocked[]): void {
    const as = this.spec.as;
    const waiting = blocked.length > 0;
    const rows = blocked.map((b) => ({ name: b.name, reason: b.reason }));
    this.store.batch(() => {
      this.store.setPath(`${as}.blockedBy`, rows);
      if (waiting) {
        this.store.setPath(`${as}.status`, "waiting");
        this.store.setPath(`${as}.loading`, true);
        this.store.setPath(`${as}.refreshing`, false);
      } else if (string(this.store.getPath(`${as}.status`)) === "waiting") {
        this.store.setPath(`${as}.status`, "ready");
        this.store.setPath(`${as}.loading`, false);
      }
    });
  }

  /** doc 11: a cycle, or a `needs=` naming a block that is not in this scope. */
  private publishDeclaredError(message: string): void {
    const as = this.spec.as;
    const error = { status: -3, message, body: null };
    this.store.batch(() => {
      this.store.setPath(`${as}.loading`, false);
      this.store.setPath(`${as}.refreshing`, false);
      this.store.setPath(`${as}.status`, "error");
      this.store.setPath(`${as}.blockedBy`, []);
      this.store.setPath(`${as}.error`, error);
    });
    this.emitEvent("error", { error });
  }

  /** networking.md N2 "Progress": each entry publishes `<as>.progress` and fires
   *  `on:progress` BEFORE the terminal settle. Real transports deliver them one at a
   *  time; the seamed corpus carries them on the response envelope. */
  private publishProgress(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      if (!isDict(raw)) continue;
      const entry = raw as Dict;
      const loaded = number(entry["loaded"]) ?? 0;
      const total = number(entry["total"]) ?? 0;
      const progress = {
        direction: string(entry["direction"] ?? "down"),
        loaded,
        total,
        fraction: total > 0 ? loaded / total : 0,
      };
      this.store.setPath(`${this.spec.as}.progress`, progress);
      this.emitEvent("progress", { progress });
    }
  }

  private cacheKey(req: Dict): string {
    // \u0001-delimited (the ApiBlock.kt / ApiBlock.swift twins), so
    // `PU`+`T/x` and `PUT`+`/x` cannot collide. Headers are part of the
    // materialized request: an Authorization/user switch must never receive a
    // prior identity's cached response. The cache itself is scoped to this
    // ReactiveStore and bounded, so route/session teardown releases it.
    return `${string(req["method"])}${string(req["url"])}${watchKey(req["headers"] ?? null)}${string(req["__dsxBodyKey"] ?? "∅")}${string(req["expect"] ?? "json")}${watchKey(req["cookiePartition"] ?? null)}`;
  }

  private emitEvent(name: ApiEvent, payload: Dict): void {
    try {
      this.onEvent(name, payload);
    } catch (error) {
      // Author event logic is downstream of the transport. It must not abort an
      // otherwise valid response or starve later stream messages.
      console.warn("[dsx api]", name, error);
    }
  }

  private serveCached(entry: CacheEntry): void {
    const as = this.spec.as;
    this.store.batch(() => {
      this.store.setPath(`${as}.loading`, false);
      this.store.setPath(`${as}.refreshing`, false);
      this.store.setPath(`${as}.data`, entry.data);
      this.store.setPath(`${as}.error`, null);
      this.store.setPath(`${as}.fetchedAt`, entry.at);
      this.store.setPath(`${as}.status`, "ready");
    });
    this.emitEvent("success", { data: entry.data, status: 200, cached: true });
    this.graph?.notifySettled(as);
  }

  private async fire(req: Dict, opts: { allowCache?: boolean; refreshing?: boolean; forceNetwork?: boolean }): Promise<unknown> {
    const as = this.spec.as;
    try {
      // send(bodyOverride) changes the body after materialization; always prepare
      // at the fire boundary so the override receives the same guards.
      this.prepareRequest(req);
      delete req["__dsxRequestError"];
    } catch (error) {
      const failure = error as { code?: string };
      return this.failRequest(failure.code ?? "invalid_request");
    }
    // Capture identity before starting I/O. A Set-Cookie/login transition while
    // the request is in flight must not seed the response under the new session.
    const key = this.cacheKey(req);
    // the cache gate (auto fires only — send/refresh force the network)
    if (opts.allowCache === true && opts.forceNetwork !== true && this.policy.kind !== "no-store") {
      const entry = cacheGet(this.store, key);
      if (entry !== undefined) {
        const age = this.now() - entry.at;
        if (this.policy.kind === "max-age" && age < this.policy.age) {
          // A cache hit is still a winning request generation. Without this,
          // an older network response can arrive later and overwrite it.
          this.controller?.abort();
          this.controller = null;
          this.generation += 1;
          this.serveCached(entry);
          return { ok: true, status: 200, data: entry.data, cached: true };
        }
        if (this.policy.kind === "swr") {
          if (age < this.policy.fresh) {
            this.controller?.abort();
            this.controller = null;
            this.generation += 1;
            this.serveCached(entry);
            return { ok: true, status: 200, data: entry.data, cached: true };
          }
          if (age < this.policy.fresh + this.policy.stale) {
            this.serveCached(entry); // serve stale NOW …
            return this.network(req, { refreshing: true }, key); // … revalidate in the background
          }
        }
      }
    }
    return this.network(req, { refreshing: opts.refreshing === true }, key);
  }

  private failRequest(code: string): Dict {
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
    const error = { status: -2, message: code, body: null };
    this.store.batch(() => {
      this.store.setPath(`${this.spec.as}.loading`, false);
      this.store.setPath(`${this.spec.as}.refreshing`, false);
      this.store.setPath(`${this.spec.as}.error`, error);
      this.store.setPath(`${this.spec.as}.fetchedAt`, this.now());
      this.store.setPath(`${this.spec.as}.status`, "error");
    });
    this.emitEvent("error", { error });
    this.graph?.notifySettled(this.spec.as);
    return { ok: false, status: -2, data: null, error: code };
  }

  private async network(req: Dict, opts: { refreshing: boolean }, cacheKey: string): Promise<unknown> {
    this.controller?.abort(); // abort-stale — the newest request wins
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    this.controller = controller;
    this.generation += 1;
    const gen = this.generation;
    const as = this.spec.as;
    this.store.batch(() => {
      this.store.setPath(`${as}.${opts.refreshing ? "refreshing" : "loading"}`, true);
      this.store.setPath(`${as}.status`, opts.refreshing ? "refreshing" : "loading");
    });
    // strict base-10 integer, exactly like the natives (Kotlin toIntOrNull / Swift Int()):
    // `retry="2.5"` or `"2e1"` is NOT a count (→ 0 retries), never 3 or 21 attempts.
    const retryAttr = (this.spec.retry ?? "").trim();
    const retries = /^-?\d+$/.test(retryAttr) ? Math.max(0, parseInt(retryAttr, 10)) : 0;
    let res: FetchOut = { ok: false, status: 0, data: null };
    const streamedChunks: unknown[] = [];
    const deliverStreamMessage = (chunk: unknown): void => {
      if (gen !== this.generation) return;
      streamedChunks.push(chunk);
      this.store.batch(() => {
        this.store.setPath(`${as}.data`, [...streamedChunks]);
        // A persistent stream may never reach EOF. The first delivered event is
        // enough to leave the initial loading/refreshing posture.
        this.store.setPath(`${as}.loading`, false);
        this.store.setPath(`${as}.refreshing`, false);
        this.store.setPath(`${as}.error`, null);
        this.store.setPath(`${as}.fetchedAt`, this.now());
      });
      this.emitEvent("message", { data: chunk });
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      res = await doFetch(string(req["url"]), req, controller?.signal ?? null, deliverStreamMessage);
      if (truthy(res["aborted"])) return null; // superseded — the newer request owns the store
      if (truthy(res["ok"]) || (number(res["status"]) ?? 0) !== 0) break; // only network errors retry
    }
    if (gen !== this.generation) return null; // superseded while awaiting
    // networking.md N2: progress entries publish + fire BEFORE the terminal settle
    this.publishProgress(res["progress"]);
    // streamed responses: chunks append to data, message per chunk (seam or SSE)
    if (truthy(res["ok"]) && Array.isArray(res.stream)) {
      const chunks = truthy(res.streamDelivered) ? streamedChunks : [];
      if (!truthy(res.streamDelivered)) {
        for (const chunk of res.stream) {
          chunks.push(chunk);
          this.store.setPath(`${as}.data`, [...chunks]);
          this.emitEvent("message", { data: chunk });
        }
      }
      this.store.batch(() => {
        this.store.setPath(`${as}.loading`, false);
        this.store.setPath(`${as}.refreshing`, false);
        this.store.setPath(`${as}.error`, null);
        this.store.setPath(`${as}.fetchedAt`, this.now());
        this.store.setPath(`${as}.status`, "ready");
      });
      const method = string(req["method"]).toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        invalidateSurfaceCache(this.store);
        invalidateCookies();
      } else if (this.policy.kind !== "no-store") {
        cachePut(this.store, cacheKey, { data: chunks, at: this.now() });
      }
      this.emitEvent("success", { data: chunks, status: number(res["status"]) ?? 200 });
      this.graph?.notifySettled(as);
      return res;
    }
    this.store.batch(() => {
      this.store.setPath(`${as}.loading`, false);
      this.store.setPath(`${as}.refreshing`, false);
      this.store.setPath(`${as}.fetchedAt`, this.now());
      this.store.setPath(`${as}.status`, truthy(res["ok"]) ? "ready" : "error");
      if (truthy(res["ok"])) {
        this.store.setPath(`${as}.data`, res["data"] ?? null);
        this.store.setPath(`${as}.error`, null);
      } else {
        this.store.setPath(`${as}.error`, {
          status: number(res["status"]) ?? 0,
          message: string(res["error"] ?? `http ${string(res["status"])}`),
          body: res["data"] ?? null,
        });
      }
    });
    if (truthy(res["ok"])) {
      const method = string(req["method"]).toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        // Login/logout and every other successful mutation can change implicit
        // cookie identity; stale reads from the prior session are unsafe.
        invalidateSurfaceCache(this.store);
        invalidateCookies();
      } else if (this.policy.kind !== "no-store") {
        cachePut(this.store, cacheKey, { data: res["data"] ?? null, at: this.now() });
      }
      this.emitEvent("success", { data: res["data"] ?? null, status: number(res["status"]) ?? 200 });
    } else {
      this.emitEvent("error", {
        error: { status: number(res["status"]) ?? 0, message: string(res["error"] ?? `http ${string(res["status"])}`), body: res["data"] ?? null },
      });
    }
    // doc 11: this block settled — its dependents fire the moment THEIR inputs are whole.
    this.graph?.notifySettled(as);
    return res;
  }

  /** re-run now — revalidates (bypasses freshness, rewrites cache); data stays until it resolves */
  async refresh(): Promise<void> {
    await this.fire(this.materialize(), { refreshing: true, forceNetwork: true });
  }

  /** fire with a body override; mutations always hit the network (awaitable envelope).
   *  doc 11: a manual send IGNORES gating but not HOLES — sending with a hole in the
   *  inputs returns an `incomplete-input` envelope instead of a malformed request. */
  async send(args?: Dict): Promise<unknown> {
    const req = this.materialize();
    if (args !== undefined && args !== null) req["body"] = args;
    const missing = req["_missing"];
    if (Array.isArray(missing) && missing.length > 0) {
      return { ok: false, status: -3, data: null, error: { kind: "incomplete-input", missing: [...missing] } };
    }
    return this.fire(req, { forceNetwork: true });
  }

  cancel(): void {
    this.controller?.abort();
    if (this.debounceTimer !== null) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.generation += 1; // orphan anything in flight
    this.store.batch(() => {
      this.store.setPath(`${this.spec.as}.loading`, false);
      this.store.setPath(`${this.spec.as}.refreshing`, false);
      if (string(this.store.getPath(`${this.spec.as}.status`)) !== "error") {
        this.store.setPath(`${this.spec.as}.status`, "ready");
      }
    });
  }

  dispose(): void {
    this.cancel();
    this.disposeEffect?.();
    this.disposeEffect = null;
    this.graph?.detach(this.spec.as);
  }
}
