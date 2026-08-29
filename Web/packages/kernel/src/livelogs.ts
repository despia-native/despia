//
//  livelogs.ts — the LIVE LOGS wire core: the pure half of dev.stream (proposals/live-logs.md).
//  The law is the corpus, OpenSource/Conformance/livelogs/{wire,report}.json; the Kotlin twin is
//  :core LiveLogs.kt and the Swift twin is Engine/iOS/LiveLogs.swift.
//
//  Everything platform-shaped lives OUTSIDE this file — the flush timer, dsx.fetch, the drawer
//  consent UI, the relay's storage. What is here is the half both ends of the wire must agree on:
//  how a ring entry becomes a wire row (scrubbed AT the fold — the telemetry law: a buffer never
//  holds an unredacted byte), the batch body, the ack fold that paces a device (viewers watching →
//  send; nobody watching → pause the wire, keep recording; pairing expired → stop), the bounded
//  device queue (drop-oldest, counted), the relay's cursor ring (monotonic seq, bounded replay,
//  the gap told to a lagging reader — the realtime.ts contract over live rows), and the
//  `.dsxreport` seal (canonical bytes + sha256) with its verifier verdicts.
//
//  CANONICAL BYTES, exactly: JSON with keys sorted by code point, no whitespace, minimal escaping
//  (`"` `\` \b \f \n \r \t, other controls as \u00xx), unicode raw, integers only — a non-integer
//  number has no canonical form and is refused, so a hash can never depend on float formatting.
//
//  This file records nothing and sends nothing.
//

import { telemetryScrubText } from "./telemetry.ts";

export const LIVE_WIRE_VERSION = 1;
export const LIVE_MESSAGE_CAP = 2000;
export const LIVE_BATCH_MAX_ROWS = 200;
export const LIVE_QUEUE_CAP = 1000;
export const LIVE_IDLE_ACK_PAUSE = 30;
export const LIVE_RING_CAP = 2000;

/** One wire row — the fold of a log-ring entry, an error-ledger entry or a kernel-tail line. */
export interface LiveRow {
  readonly kind: "log" | "error" | "kernel";
  readonly scheme?: string;
  readonly level?: string;
  readonly message?: string;
  readonly code?: string;
  readonly origin?: string;
  readonly recoverable?: boolean;
  readonly at: number;
}

/** Scrub first, then cap: redaction must see the whole text, and a clipped token must never be a
 *  leaked one. The cap counts UTF-16 CODE UNITS on every renderer (the corpus pins the boundary),
 *  and a cut that would strand a high surrogate retreats one unit — a lone surrogate has no
 *  UTF-8 encoding, so it must never reach the wire or the canonical bytes. */
function foldMessage(text: string): string {
  const scrubbed = telemetryScrubText(text);
  if (scrubbed.length <= LIVE_MESSAGE_CAP) return scrubbed;
  const lastUnit = scrubbed.charCodeAt(LIVE_MESSAGE_CAP - 1);
  const cut = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? LIVE_MESSAGE_CAP - 1 : LIVE_MESSAGE_CAP;
  return scrubbed.slice(0, cut);
}

export function liveRowFromLog(
  entry: { scheme: string; level: string; message: string },
  at: number,
): LiveRow {
  return { kind: "log", scheme: entry.scheme, level: entry.level, message: foldMessage(String(entry.message)), at };
}

export function liveRowFromError(
  entry: { scheme: string; code: string; message?: string | null; recoverable: boolean; origin: string },
  at: number,
): LiveRow {
  const row: { -readonly [K in keyof LiveRow]?: LiveRow[K] } = {
    kind: "error", scheme: entry.scheme, code: entry.code,
    recoverable: entry.recoverable === true, origin: entry.origin, at,
  };
  if (entry.message !== null && entry.message !== undefined) row.message = foldMessage(String(entry.message));
  return row as LiveRow;
}

export function liveRowFromKernel(line: string, at: number): LiveRow {
  return { kind: "kernel", message: foldMessage(String(line)), at };
}

/** The batch body a device POSTs: `n` is the device's monotonic batch index, the relay's
 *  idempotency key — a retried batch can never double rows. */
export function liveBatchBody(sid: string, n: number, rows: readonly LiveRow[]): {
  v: number; sid: string; n: number; rows: readonly LiveRow[];
} {
  return { v: LIVE_WIRE_VERSION, sid, n, rows };
}

// ---------------------------------------------------------------------------- the ack fold

/** What a device knows about its session, folded from relay acks. The fold never STOPS a
 *  session — pausing is reversible (a heartbeat still carries acks, so a returning viewer
 *  resumes the wire); only the deadline passing stops it, and only `liveAckExpire` says so. */
export interface LiveAckState {
  readonly idle: number;
  readonly paused: boolean;
  readonly stopped: boolean;
  readonly reason: string;
  readonly deadline: number;
}

export function liveAckStart(): LiveAckState {
  return { idle: 0, paused: false, stopped: false, reason: "", deadline: 0 };
}

export function liveAckFold(
  state: LiveAckState,
  ack: { ok: boolean; viewers: number; ttlMs: number },
  at: number,
): LiveAckState {
  if (ack.ok !== true || state.stopped) return state;
  const deadline = at + ack.ttlMs;
  if (ack.viewers > 0) return { idle: 0, paused: false, stopped: false, reason: "", deadline };
  const idle = state.idle + 1;
  return { idle, paused: idle >= LIVE_IDLE_ACK_PAUSE, stopped: false, reason: "", deadline };
}

export function liveAckExpire(state: LiveAckState, at: number): LiveAckState {
  if (state.stopped || state.deadline <= 0 || at <= state.deadline) return state;
  return { ...state, stopped: true, reason: "expired" };
}

// ---------------------------------------------------------------------------- the device queue

/** The bounded outbound queue: drop-oldest with a counted drop (the relay is told what it did
 *  not receive), a batch PEEKS and only the ack removes — a refused POST loses nothing.
 *
 *  A PEEKED BATCH IS PINNED. The exact-retry law says attempt 2 carries the SAME rows as
 *  attempt 1 (the relay's replay refusal and the driver's ack both assume it), so while a
 *  batch is in flight the cap evicts the oldest UNPINNED row — never the batch's head — and
 *  when every present row is in flight the NEWCOMER is the counted drop. Without this,
 *  pushing at cap during an outage shifted rows out of the in-flight batch and the ack then
 *  removed rows that were never sent. Corpus: livelogs/wire.json `queue`. */
export class LiveQueue<T> {
  private items: T[] = [];
  private droppedCount = 0;
  private pinned = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  get size(): number { return this.items.length; }
  get dropped(): number { return this.droppedCount; }

  push(item: T): { size: number; dropped: number } {
    if (this.items.length >= this.cap) {
      this.droppedCount += 1;
      if (this.pinned >= this.items.length) {
        return { size: this.items.length, dropped: this.droppedCount };
      }
      this.items.splice(this.pinned, 1);
    }
    this.items.push(item);
    return { size: this.items.length, dropped: this.droppedCount };
  }

  batch(max: number): T[] {
    const peeked = this.items.slice(0, Math.max(0, max));
    this.pinned = peeked.length;
    return peeked;
  }

  ack(count: number): { size: number } {
    const removed = Math.max(0, count);
    this.items.splice(0, removed);
    this.pinned = Math.max(0, this.pinned - removed);
    return { size: this.items.length };
  }

  clear(): void {
    this.items = [];
    this.droppedCount = 0;
    this.pinned = 0;
  }
}

// ---------------------------------------------------------------------------- the relay ring

/** The relay's replay ring — the durable-cursor-feed law (realtime.ts) over live rows: seq is
 *  assigned monotonically from 1, a read resumes after a cursor, the bound evicts oldest, and a
 *  reader whose cursor predates the ring is TOLD about the gap rather than silently spliced. */
export class LiveRing<T> {
  private entries: Array<{ seq: number; row: T }> = [];
  private lastSeq = 0;
  private lastBatch = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  get last(): number { return this.lastSeq; }

  appendBatch(n: number, rows: readonly T[]): { accepted: boolean; last: number } {
    if (n <= this.lastBatch) return { accepted: false, last: this.lastSeq };
    this.lastBatch = n;
    for (const row of rows) {
      this.lastSeq += 1;
      this.entries.push({ seq: this.lastSeq, row });
      if (this.entries.length > this.cap) this.entries.shift();
    }
    return { accepted: true, last: this.lastSeq };
  }

  read(after: number, limit: number): { rows: Array<{ seq: number; row: T }>; gap: boolean } {
    const oldest = this.entries.length > 0 ? this.entries[0]!.seq : 0;
    const gap = this.entries.length > 0 && after < oldest - 1;
    const rows: Array<{ seq: number; row: T }> = [];
    for (const entry of this.entries) {
      if (entry.seq <= after) continue;
      rows.push(entry);
      if (rows.length >= Math.max(0, limit)) break;
    }
    return { rows, gap };
  }
}

// ---------------------------------------------------------------------------- canonical bytes

function liveEscape(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/** The one canonical serialization. Refuses what has no canonical form (a non-integer number,
 *  a non-JSON value) rather than guessing one — a hash must never depend on float formatting. */
export function liveCanonical(value: unknown): string {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "boolean") return value === true ? "true" : "false";
  if (kind === "number") {
    // SAFE integers only: past 2^53-1 the three runtimes disagree (double text turns
    // exponential, Long refuses, Int64 wraps), and one seal with three spellings is exactly
    // the verdict drift the verifier exists to prevent.
    if (!Number.isSafeInteger(value as number)) {
      throw new Error("livelogs canonical: safe integers only");
    }
    return String(value);
  }
  if (kind === "string") return liveEscape(value as string);
  if (Array.isArray(value)) return "[" + value.map((item) => liveCanonical(item)).join(",") + "]";
  if (kind === "object") {
    const record = value as { [key: string]: unknown };
    const keys = Object.keys(record).sort();
    return "{" + keys.map((key) => liveEscape(key) + ":" + liveCanonical(record[key])).join(",") + "}";
  }
  throw new Error("livelogs canonical: unsupported value");
}

// ---------------------------------------------------------------------------- sha256 (sync)

// A self-contained synchronous SHA-256 over UTF-8 bytes. Deliberate: the web platform's only
// digest (crypto.subtle) is async-only and node-only alternatives cannot run in a browser, while
// a seal and its verifier must work identically in both. Pinned by report.json against the
// standard vectors, byte-for-byte with the CryptoKit and MessageDigest twins.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function liveSha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLength = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Int32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

// ---------------------------------------------------------------------------- the report seal

/** Seal a report body: the hash covers the canonical bytes WITHOUT the receipt, the sealed text
 *  is the canonical bytes WITH it. A body arriving with a receipt is re-sealed, never trusted. */
export function liveReportSeal(body: { [key: string]: unknown }): { hash: string; text: string } {
  const bare: { [key: string]: unknown } = {};
  for (const key of Object.keys(body)) {
    if (key !== "receipt") bare[key] = body[key];
  }
  const hash = liveSha256Hex(liveCanonical(bare));
  const sealed = { ...bare, receipt: { alg: "sha256", hash } };
  return { hash, text: liveCanonical(sealed) };
}

const LIVE_HASH_SHAPE = /^[0-9a-f]{64}$/;

function plainObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Find a `.dsxreport` envelope inside a paste — support receives reports wrapped in prose
 *  (the Copy-report text, a chat message), and the verifier core takes exact text. Leftmost
 *  balanced object whose `kind` is `dsxreport` wins; string-aware scanning so braces inside
 *  messages cannot derail it. Deliberately NOT corpus law: this is presentation-side rescue,
 *  and the verdicts stay pinned on exact text. */
export function liveReportExtract(text: string): string | null {
  if (text.length > 2_000_000) return null;
  const whole = text.trim();
  const parses = (candidate: string): boolean => {
    try {
      const doc = JSON.parse(candidate) as unknown;
      return plainObject(doc) && doc["kind"] === "dsxreport";
    } catch {
      return false;
    }
  };
  if (whole.startsWith("{") && parses(whole)) return whole;
  const marker = text.indexOf('"dsxreport"');
  if (marker === -1) return null;
  // ONE forward pass with a stack of open-brace positions — the deliberately ungated /verify
  // route takes adversarial pastes, and a scan that restarts per '{' is quadratic on them.
  // Innermost-first by construction (a pop closes the deepest open span), candidates limited
  // to spans covering the marker, parse attempts capped: linear work, bounded parses.
  const opens: number[] = [];
  let inString = false;
  let escaped = false;
  let attempts = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") opens.push(i);
    else if (ch === "}") {
      const start = opens.pop();
      if (start === undefined) continue;
      if (start > marker || i < marker) continue;
      if (attempts >= 16) return null;
      attempts += 1;
      const candidate = text.slice(start, i + 1);
      if (parses(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The verifier — the support macro as a function. `not_report` is the verdict the motivating
 * incident dies at (an AI-fabricated state dump is not the envelope); `modified` means the
 * envelope shape is right and the bytes are not; `genuine` means the hash verifies. `assertion`
 * reports whether an integrity attestation rides a GENUINE seal — verifying that attestation
 * against Apple/Google is the relay/platform's job, never this core's.
 */
export function liveReportVerdict(text: string): { verdict: "not_report" | "modified" | "genuine"; assertion: boolean } {
  const refused = { verdict: "not_report" as const, assertion: false };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return refused;
  }
  if (!plainObject(doc)) return refused;
  if (doc["kind"] !== "dsxreport" || doc["v"] !== 1) return refused;
  const receipt = doc["receipt"];
  if (!plainObject(receipt)) return refused;
  if (receipt["alg"] !== "sha256") return refused;
  const hash = receipt["hash"];
  if (typeof hash !== "string" || !LIVE_HASH_SHAPE.test(hash)) return refused;

  const body: { [key: string]: unknown } = {};
  for (const key of Object.keys(doc)) {
    if (key !== "receipt") body[key] = doc[key];
  }
  let canonical: string;
  try {
    canonical = liveCanonical(body);
  } catch {
    return { verdict: "modified", assertion: false };
  }
  if (liveSha256Hex(canonical) !== hash) return { verdict: "modified", assertion: false };
  return { verdict: "genuine", assertion: plainObject(receipt["integrity"]) };
}
