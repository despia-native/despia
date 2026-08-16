//
//  store.ts - the reactive store layer: fine-grained signals over the DSX store
//  (/web/01 — Option C: own kernel, per-binding invalidation, no VDOM).
//
//  Two store layers, identical shape (the kernel contract):
//    • DSXState — the ONE app-wide reactive store, read as `global.*` / `route.*`.
//    • per-surface ReactiveStore — bare-name surface state (wraps the JSE StackStore).
//
//  Granularity: writes publish per top-level key immediately (deep-equal elided — the
//  reference behavior); a BINDING subscribes to exactly the keys its expression READ
//  (read-tracking through JSE.lookup), and re-runs only when one of them changes —
//  dedup by watchKey so equal recomputes don't touch the DOM.
//

import { StackStore, JSE, JSESeams, type Item } from "./jse/jse.ts";
import { NSNull, isDict, watchKey, jseEquals, type Dict } from "./jse/values.ts";

// ── read tracking ────────────────────────────────────────────────────────────────────

type ReadFrame = { surface: Set<string>; global: Set<string> } | null;
let currentFrame: ReadFrame = null;

export function trackReads<T>(run: () => T): { value: T; surface: Set<string>; global: Set<string> } {
  const frame = { surface: new Set<string>(), global: new Set<string>() };
  const prev = currentFrame;
  currentFrame = frame;
  try {
    const value = run();
    return { value, surface: frame.surface, global: frame.global };
  } finally {
    currentFrame = prev;
  }
}

export function noteSurfaceRead(key: string): void { currentFrame?.surface.add(key); }
export function noteGlobalRead(key: string): void { currentFrame?.global.add(key); }

let cookieRevision = 0;

/** Identity partition for implicit browser/native cookies. API materialization reads
 *  this under dependency tracking so an explicit cookie change refetches live GETs. */
export function readCookiePartition(): Dict {
  noteGlobalRead("cookie");
  return { revision: cookieRevision, jar: JSESeams.cookieJar() };
}

// ── path get/set (the State.kt getPath/setPath contract: COW, arrays grow) ──────────

/** One bounded dot-path contract shared with the native engines. Authored/remote
 * paths fail closed before copy-on-write allocates any containers. */
export const STATE_PATH_LIMITS = Object.freeze({
  maxPathBytes: 4_096,
  maxSegments: 64,
  maxSegmentBytes: 256,
  maxArrayIndex: 9_999,
  maxArrayGrowth: 1_024,
  maxContainerEntries: 10_000,
  maxIdentifierBytes: 128,
});

const UNSAFE_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UTF8_ENCODER = new TextEncoder();

function isWithinUtf8Limit(value: string, limit: number): boolean {
  // A UTF-16 code unit consumes at least one UTF-8 byte. Bound length first so
  // checking attacker-sized input never allocates another attacker-sized buffer.
  return value.length <= limit && UTF8_ENCODER.encode(value).byteLength <= limit;
}

export function statePathParts(path: string, allowEmpty = false): string[] | null {
  if (path.length === 0) return allowEmpty ? [] : null;
  if (!isWithinUtf8Limit(path, STATE_PATH_LIMITS.maxPathBytes)) return null;
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0) || parts.length > STATE_PATH_LIMITS.maxSegments) return null;
  for (const part of parts) {
    if (!isWithinUtf8Limit(part, STATE_PATH_LIMITS.maxSegmentBytes) || UNSAFE_PATH_KEYS.has(part)) return null;
    const digits = /^\d+$/.test(part);
    if (/^[+-]\d+$/.test(part)) return null;
    if (digits) {
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index > STATE_PATH_LIMITS.maxArrayIndex) return null;
    }
  }
  return parts;
}

/** `<api as>` owns one top-level store identifier, never an arbitrary dot path. */
export function isStateIdentifier(value: string): boolean {
  return value.length > 0
    && isWithinUtf8Limit(value, STATE_PATH_LIMITS.maxIdentifierBytes)
    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export type StatePathWrite = { accepted: boolean; value: unknown };

/** Rebuild a validated path without mutating the input. A rejected result means
 * the write exceeded a container/growth budget and state must remain unchanged. */
export function rebuildStatePath(container: unknown, parts: string[], value: unknown): StatePathWrite {
  if (parts.length === 0) return { accepted: true, value };
  const p = parts[0]!;
  const i = /^\d+$/.test(p) ? Number(p) : null;
  if (i !== null) {
    const arr = Array.isArray(container) ? [...container] : [];
    const growth = i >= arr.length ? i - arr.length + 1 : 0;
    if (growth > STATE_PATH_LIMITS.maxArrayGrowth) return { accepted: false, value: container };
    while (arr.length <= i) arr.push({});
    const child = rebuildStatePath(arr[i], parts.slice(1), value);
    if (!child.accepted) return child;
    arr[i] = child.value;
    return { accepted: true, value: arr };
  }
  const dict: Dict = isDict(container) ? { ...(container as Dict) } : {};
  if (!Object.prototype.hasOwnProperty.call(dict, p)
      && Object.keys(dict).length >= STATE_PATH_LIMITS.maxContainerEntries) {
    return { accepted: false, value: container };
  }
  const child = rebuildStatePath(dict[p], parts.slice(1), value);
  if (!child.accepted) return child;
  dict[p] = child.value;
  return { accepted: true, value: dict };
}

export function getPath(vars: Map<string, unknown>, path: string): unknown {
  const parts = statePathParts(path);
  if (parts === null) return null;
  let cur: unknown = vars.get(parts[0]!);
  for (const p of parts.slice(1)) {
    const i = /^\d+$/.test(p) ? Number(p) : null;
    if (i !== null && Array.isArray(cur)) cur = i >= 0 && i < cur.length ? cur[i] : null;
    else cur = isDict(cur) ? ((cur as Dict)[p] ?? null) : null;
  }
  return cur ?? null;
}

// ── the effect scheduler ─────────────────────────────────────────────────────────────
// Store WRITES publish immediately (the reference contract: per-key, deep-equal
// elided) — but BINDING re-runs coalesce per microtask (/web/07: "batched per action
// tick, matching the native runner's end-of-action coalescing"; the render-safe
// invariant). N writes in one action = one re-run per affected binding. The drain is
// budgeted like every other loop in the kernel: a write-cycle between effects is
// contained, never a hang.

export type Subscriber = { keys: Set<string>; globalKeys: Set<string>; run: () => void; disposed?: boolean };

const pendingEffects = new Set<Subscriber>();
let flushQueued = false;

function scheduleEffect(sub: Subscriber): void {
  pendingEffects.add(sub);
  if (!flushQueued) {
    flushQueued = true;
    queueMicrotask(flushEffects);
  }
}

/** Drain all pending binding re-runs NOW (tests, SSR, imperative flush points).
 *  Effects that write the store re-schedule; the drain budget contains cycles. */
export function flushEffects(): void {
  flushQueued = false;
  let rounds = 0;
  while (pendingEffects.size > 0) {
    if (rounds >= 64) {
      console.warn(`[dsx store] effect flush budget (64 rounds) exceeded — a binding writes what it reads; remaining ${pendingEffects.size} deferred`);
      pendingEffects.clear();
      return;
    }
    rounds += 1;
    const batch = [...pendingEffects];
    pendingEffects.clear();
    for (const sub of batch) {
      if (sub.disposed === true) continue;
      // One throwing binding must not starve the rest of the batch or escape the
      // microtask — same isolation the bus gives its handlers (/web/20 render-safety).
      try { sub.run(); } catch (e) { console.warn("[dsx store] binding threw during flush", e); }
    }
  }
}

export class ReactiveStore {
  readonly jse = new StackStore();
  private subscribers = new Set<Subscriber>();
  private sinks = new Set<(vars: Map<string, unknown>) => void>();
  /** batch depth — writes inside an action coalesce notifications per key set */
  private pending: Set<string> | null = null;

  constructor() {
    this.jse.onVarRead = (name) => noteSurfaceRead(name);
    DSXState.attach(this); // global-store writes poke this surface's global-read bindings
  }

  /** unmount: detach from the global store (bindings die with their subscribers) */
  dispose(): void {
    DSXState.detach(this);
  }

  get vars(): Map<string, unknown> { return this.jse.vars; }

  /** whole-snapshot sink (the `$vars.sink` twin: fires once on subscribe, then per write) */
  sink(fn: (vars: Map<string, unknown>) => void): () => void {
    this.sinks.add(fn);
    fn(this.jse.vars);
    return () => this.sinks.delete(fn);
  }

  /** one write — deep-equal writes are elided (the reference behavior). */
  set(key: string, value: unknown): void {
    const prev = this.jse.vars.get(key);
    if (prev !== undefined && jseEquals(prev, value) && watchKey(prev) === watchKey(value)) return;
    this.jse.vars.set(key, value);
    this.changed(key);
  }

  /** dotted-path write — single segment routes to set(); deeper paths rebuild COW. */
  setPath(path: string, value: unknown): void {
    const parts = statePathParts(path);
    if (parts === null) return;
    const top = parts[0]!;
    if (!this.jse.vars.has(top) && this.jse.vars.size >= STATE_PATH_LIMITS.maxContainerEntries) return;
    if (parts.length === 1) { this.set(top, value); return; }
    const rebuilt = rebuildStatePath(this.jse.vars.get(top), parts.slice(1), value);
    if (rebuilt.accepted) this.set(top, rebuilt.value);
  }

  getPath(path: string): unknown { return getPath(this.jse.vars, path); }

  /** run writes batched: notifications coalesce and fire once at the end. */
  batch(run: () => void): void {
    if (this.pending !== null) { run(); return; } // already inside a batch
    this.pending = new Set();
    try {
      run();
    } finally {
      const keys = this.pending;
      this.pending = null;
      if (keys.size > 0) this.notify(keys);
    }
  }

  private changed(key: string): void {
    if (this.pending !== null) { this.pending.add(key); return; }
    this.notify(new Set([key]));
  }

  private notify(keys: Set<string>): void {
    for (const s of this.sinks) s(this.jse.vars); // snapshot sinks stay synchronous (store contract)
    for (const sub of [...this.subscribers]) {
      let hit = false;
      for (const k of keys) if (sub.keys.has(k)) { hit = true; break; }
      if (hit) scheduleEffect(sub); // bindings coalesce per microtask (the scheduler)
    }
  }

  /** DSXState pokes surface subscribers whose GLOBAL read-set intersects. */
  notifyGlobal(keys: Set<string>): void {
    for (const sub of [...this.subscribers]) {
      let hit = false;
      for (const k of keys) if (sub.globalKeys.has(k)) { hit = true; break; }
      if (hit) scheduleEffect(sub);
    }
  }

  /** A binding: evaluate `read` with dependency tracking; re-run `onChange` when any
   *  read key changes AND the computed value meaningfully changed (watchKey dedup).
   *  Returns a disposer. Fires `onChange` once immediately with the initial value. */
  effect<T>(read: () => T, onChange: (value: T) => void): () => void {
    const sub: Subscriber = { keys: new Set(), globalKeys: new Set(), run: () => {} };
    let lastKey = "";
    const evaluate = (fire: boolean): void => {
      const { value, surface, global } = trackReads(read);
      sub.keys = surface;
      sub.globalKeys = global;
      const k = watchKey(value);
      if (fire || k !== lastKey) {
        lastKey = k;
        onChange(value);
      }
    };
    sub.run = () => evaluate(false);
    this.subscribers.add(sub);
    evaluate(true); // the first run is synchronous — mount sees real content
    return () => {
      sub.disposed = true;
      this.subscribers.delete(sub);
    };
  }

  /** `<watch value= on:change=>` — like effect, but NEVER fires on subscribe. */
  watch(read: () => unknown, onChange: (value: unknown) => void): () => void {
    let first = true;
    return this.effect(read, (v) => {
      if (first) { first = false; return; }
      onChange(v);
    });
  }

  eval(expr: string, item: Item = null): unknown { return JSE.eval(expr, this.jse, item); }
  evalBlock(body: string, item: Item = null): unknown { return JSE.evalBlock(body, this.jse, item); }
  interpolate(s: string, item: Item = null): string { return JSE.interpolate(s, this.jse, item); }
}

// ── the app-wide store (DSX.state twin) ──────────────────────────────────────────────

class DSXStateStore {
  vars: Dict = {};
  private sinks = new Set<(vars: Dict) => void>();
  private surfaces = new Set<ReactiveStore>();
  private pending: Set<string> | null = null;

  attach(surface: ReactiveStore): void {
    this.surfaces.add(surface);
  }

  detach(surface: ReactiveStore): void {
    this.surfaces.delete(surface);
  }

  sink(fn: (vars: Dict) => void): () => void {
    this.sinks.add(fn);
    fn(this.vars);
    return () => this.sinks.delete(fn);
  }

  get(path: string): unknown {
    const parts = statePathParts(path, true);
    if (parts === null) return null;
    let cur: unknown = this.vars;
    for (const p of parts) {
      const i = /^\d+$/.test(p) ? Number(p) : null;
      if (i !== null && Array.isArray(cur)) cur = i >= 0 && i < cur.length ? cur[i] : null;
      else cur = isDict(cur) ? ((cur as Dict)[p] ?? null) : null;
    }
    return cur ?? null;
  }

  set(path: string, value: unknown): void {
    const parts = statePathParts(path);
    if (parts === null) return;
    const top = parts[0]!;
    if (!Object.prototype.hasOwnProperty.call(this.vars, top)
        && Object.keys(this.vars).length >= STATE_PATH_LIMITS.maxContainerEntries) return;
    const prev = this.vars[top];
    const rebuilt = parts.length === 1
      ? { accepted: true, value }
      : rebuildStatePath(prev, parts.slice(1), value);
    if (!rebuilt.accepted) return;
    const next = rebuilt.value;
    if (prev !== undefined && jseEquals(prev, next) && watchKey(prev) === watchKey(next)) return;
    this.vars = { ...this.vars, [top]: next };
    this.changed(top);
  }

  batch(run: () => void): void {
    if (this.pending !== null) { run(); return; }
    this.pending = new Set();
    try {
      run();
    } finally {
      const keys = this.pending;
      this.pending = null;
      if (keys.size > 0) this.notify(keys);
    }
  }

  private changed(key: string): void {
    if (this.pending !== null) { this.pending.add(key); return; }
    this.notify(new Set([key]));
  }

  private notify(keys: Set<string>): void {
    for (const s of this.sinks) s(this.vars);
    for (const surface of this.surfaces) surface.notifyGlobal(keys);
  }

  /** Notify tracked external state (cookies, reachability, host-owned signals)
   *  without exposing a synthetic value through `global.*`. */
  invalidate(key: string): void {
    this.notify(new Set([key]));
  }
}

/** the ONE app-wide store */
export const DSXState = new DSXStateStore();

/** Call after a cookie write or a mutation that may rotate an HttpOnly session.
 *  GET `<api>` blocks include the revision in their materialized identity, so
 *  this forces a safe refetch even when JavaScript cannot read the cookie value. */
export function invalidateCookies(): void {
  cookieRevision += 1;
  DSXState.invalidate("cookie");
}

// wire the JSE seams: `global.*` reads come from DSXState, with read tracking.
JSESeams.stateVars = () => DSXState.vars;
JSESeams.onGlobalRead = (key) => noteGlobalRead(key);

export { NSNull, JSESeams };
