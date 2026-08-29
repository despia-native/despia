//
//  wire.ts — the pure half of the relay: token compare, bounded body reads, batch validation,
//  cursor parsing, the JSON error shape and the CORS fold. Everything here is platform-free and
//  proven from node (test/live.test.ts); worker.ts and session.ts only assemble it.
//
//  The trust posture, in one line: a device batch is DATA, not truth — every row is rebuilt
//  from scratch (kind, at and each field re-checked and re-bounded) before it touches the ring,
//  and every inbound body is size-capped while it streams, never after it is buffered.
//

import { LIVE_BATCH_MAX_ROWS, LIVE_MESSAGE_CAP, LIVE_WIRE_VERSION, type LiveRow } from "@despia/kernel";

/** the /pair admission header — the preview worker's key-header precedent, its own name so the
 *  two secrets can rotate independently */
export const LIVE_KEY_HEADER = "x-dsx-live-key";

export const LIVE_SID_SHAPE = /^s_[0-9a-f]{12}$/;

// Inbound byte ceilings. A conforming device never approaches them (200 rows × a 2000-char
// message cap ≈ 450 KB worst case); the report cap covers a full three-ring export.
export const LIVE_HTTP_BATCH_MAX_BYTES = 1_048_576;
export const LIVE_HTTP_REPORT_MAX_BYTES = 2_097_152;
export const LIVE_HTTP_ATTEST_MAX_BYTES = 16_384;
export const LIVE_HTTP_VERIFY_MAX_BYTES = 262_144;

/** a stored report keeps its text only under this bound — the verdict is computed on the full
 *  upload either way, and Durable Object storage values are capped by the platform */
export const LIVE_REPORT_STORE_TEXT_MAX = 32_768;
export const LIVE_REPORTS_KEPT = 10;

/** a /rows read counts as a viewer for this long — the dashboard's R1 posture POLLS, and a
 *  device whose acks said viewers:0 while someone was polling would pause the wire on exactly
 *  the person watching it */
export const LIVE_ROWS_VIEWER_WINDOW_MS = 10_000;
/** the wire snapshot is ONE storage value and the platform caps those — bound it by BYTES,
 *  trimming the oldest tail rows; restore already replays a short tail behind a filler */
export const LIVE_WIRE_SNAPSHOT_MAX_BYTES = 700_000;

export const LIVE_DEFAULT_SESSION_TTL_MS = 900_000;
export const LIVE_DEFAULT_SESSION_MAX_AGE_MS = 14_400_000;
/** under a minute on purpose — the realtime.ts law: closed BY us with a cursor in hand beats
 *  being closed by a proxy that will not say why */
export const LIVE_DEFAULT_FEED_MAX_MS = 55_000;
export const LIVE_FEED_HEARTBEAT_MS = 15_000;

const MAX_EPOCH_MS = 8_640_000_000_000_000;
const META_FIELD_CAP = 128;

/**
 * Compare two secrets WITHOUT leaking their contents through timing — the secrets.ts law,
 * restated here because this package is dependency-free below @despia/kernel: `===` returns at
 * the first differing byte, which turns a probe-tolerant endpoint into a byte-at-a-time oracle.
 * The length check leaks only the length, which is not the secret.
 */
export function tokenEquals(presented: string | null | undefined, expected: string): boolean {
  if (typeof presented !== "string" || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** the `Authorization: Bearer <token>` fold; null for anything else */
export function bearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : match[1]!;
}

/**
 * Read a request body as text, refusing past `maxBytes` WHILE streaming — a Content-Length
 * header is a claim, not a bound, and a chunked body carries none at all.
 */
export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const body = request.body;
  if (body === null) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

function plainObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuild one wire row from untrusted input. Known keys only, every type re-checked, every
 * string re-bounded (the message to the corpus cap, metadata fields shorter) — the relay never
 * stores a byte the device merely claimed was a row. Null means the row is not a row.
 */
/** Cap at `max` UTF-16 units, retreating one unit when the cut would strand a high surrogate -
 *  the same law the kernel's foldMessage pins: a lone surrogate has no UTF-8 encoding and must
 *  never reach the ring, the archive, or a wire frame. */
function capUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastUnit = text.charCodeAt(max - 1);
  return text.slice(0, lastUnit >= 0xd800 && lastUnit <= 0xdbff ? max - 1 : max);
}

export function sanitizeRow(value: unknown): LiveRow | null {
  if (!plainObject(value)) return null;
  const kind = value["kind"];
  if (kind !== "log" && kind !== "error" && kind !== "kernel") return null;
  const at = value["at"];
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 || at > MAX_EPOCH_MS) return null;
  const row: { -readonly [K in keyof LiveRow]?: LiveRow[K] } = { kind, at };
  for (const key of ["scheme", "level", "code", "origin"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return null;
    row[key] = capUnits(raw, META_FIELD_CAP);
  }
  const message = value["message"];
  if (message !== undefined) {
    if (typeof message !== "string") return null;
    row.message = capUnits(message, LIVE_MESSAGE_CAP);
  }
  const recoverable = value["recoverable"];
  if (recoverable !== undefined) {
    if (typeof recoverable !== "boolean") return null;
    row.recoverable = recoverable;
  }
  return row as LiveRow;
}

export interface ParsedBatch {
  sid: string;
  n: number;
  rows: LiveRow[];
}

/**
 * Parse and re-validate a device batch body `{v, sid, n, rows}`. An empty `rows` is lawful — a
 * paused device heartbeats with empty batches so the ack fold keeps flowing (the wire corpus).
 */
export function parseBatchBody(text: string): { ok: true; batch: ParsedBatch } | { ok: false; message: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, message: "body is not JSON" };
  }
  if (!plainObject(doc)) return { ok: false, message: "body is not an object" };
  if (doc["v"] !== LIVE_WIRE_VERSION) return { ok: false, message: "unsupported wire version" };
  const sid = doc["sid"];
  if (typeof sid !== "string" || !LIVE_SID_SHAPE.test(sid)) return { ok: false, message: "sid" };
  const n = doc["n"];
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return { ok: false, message: "n" };
  const rawRows = doc["rows"];
  if (!Array.isArray(rawRows)) return { ok: false, message: "rows" };
  if (rawRows.length > LIVE_BATCH_MAX_ROWS) return { ok: false, message: "too many rows" };
  const rows: LiveRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = sanitizeRow(rawRows[i]);
    if (row === null) return { ok: false, message: `row ${i} invalid` };
    rows.push(row);
  }
  return { ok: true, batch: { sid, n, rows } };
}

/** A cursor is a decimal sequence number; anything else reads as "from the beginning" rather
 *  than as an error — a resumed stream must never fail because a proxy mangled a header. */
export function parseCursor(raw: string | null | undefined): number {
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  return /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : 0;
}

/** an env knob is a string; a missing or mangled one falls back rather than failing the worker */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return value > 0 ? value : fallback;
}

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = /^\d{1,9}$/.test((raw ?? "").trim()) ? Number((raw ?? "").trim()) : fallback;
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------- responses + CORS

export function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** every refusal wears the same shape: `{ok:false, error:{code, message}}` — and never an
 *  exception text, which belongs in the log the operator already has */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: { [name: string]: string },
): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(headers ?? {}),
    },
  });
}

/** The dashboard is a cross-origin browser client by design, so CORS is part of the contract:
 *  permissive by default, narrowed by the LIVE_ALLOWED_ORIGIN var. */
export function corsHeaders(origin: string): { [name: string]: string } {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": `authorization, content-type, last-event-id, ${LIVE_KEY_HEADER}`,
    "access-control-max-age": "86400",
  };
}

/** rebuild with the body stream intact — an SSE response must keep streaming through the fold */
export function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

// ---------------------------------------------------------------------------- platform shapes

// Structural on purpose — this workspace carries no Cloudflare platform types (the
// preview-workers.ts precedent); workerd satisfies these at runtime.

export interface LiveSessionStub {
  fetch(request: Request): Promise<Response>;
}

export interface LiveSessionNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): LiveSessionStub;
}

export interface LiveDurableStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface LiveDurableState {
  storage: LiveDurableStorage;
}

/** the optional R2 archive, structurally */
export interface LiveArchiveBucket {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface LiveEnv {
  SESSIONS: LiveSessionNamespace;
  /** absent ⇒ no archive: the relay retains nothing beyond the replay ring */
  ARCHIVE?: LiveArchiveBucket;
  /** absent ⇒ /pair does not exist (fail closed) */
  LIVE_ADMIN_KEY?: string;
  LIVE_ALLOWED_ORIGIN?: string;
  LIVE_SESSION_TTL_MS?: string;
  LIVE_SESSION_MAX_AGE_MS?: string;
  LIVE_FEED_MAX_MS?: string;
  LIVE_ROWS_VIEWER_WINDOW_MS?: string;
}

export function allowedOrigin(env: LiveEnv): string {
  const raw = env.LIVE_ALLOWED_ORIGIN;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "*";
}

export function sessionTtlMs(env: LiveEnv): number {
  return parsePositiveInt(env.LIVE_SESSION_TTL_MS, LIVE_DEFAULT_SESSION_TTL_MS);
}

export function sessionMaxAgeMs(env: LiveEnv): number {
  return parsePositiveInt(env.LIVE_SESSION_MAX_AGE_MS, LIVE_DEFAULT_SESSION_MAX_AGE_MS);
}

export function feedMaxMs(env: LiveEnv): number {
  return parsePositiveInt(env.LIVE_FEED_MAX_MS, LIVE_DEFAULT_FEED_MAX_MS);
}

export function rowsViewerWindowMs(env: LiveEnv): number {
  return parsePositiveInt(env.LIVE_ROWS_VIEWER_WINDOW_MS, LIVE_ROWS_VIEWER_WINDOW_MS);
}
