//
//  session.ts — the LiveSession Durable Object: one actor per stream session (live-logs.md
//  3.2, D5). It holds the kernel LiveRing in memory (the durable-cursor law: monotonic seq,
//  bounded replay, gap told to a lagging reader, batch index as the idempotency key) and
//  WRITES THROUGH to its own storage on every accepted batch, so an eviction can neither lose
//  the cursor space nor double rows on restart. Restore is lazy, on first touch.
//
//  The DO owns the per-session trust boundary: the worker routes bytes here, and THIS class
//  checks the device and viewer tokens (it is the only place they exist). Wrong-shaped input
//  never reaches the ring — wire.ts rebuilds every row.
//
//  Restart discipline, precisely: the snapshot is `{lastBatch, lastSeq, tail}` and restore
//  replays it through the ring's PUBLIC contract — a filler batch advances the seq counter to
//  where the tail begins, then the tail lands under the last accepted batch index, so restored
//  seqs equal pre-restart seqs and a retried batch index is still refused. Filler rows can
//  never surface: the ring holds `min(lastSeq, cap)` entries, so a tail shorter than the cap
//  means nothing was ever evicted and no filler is needed at all.
//

import { LIVE_RING_CAP, LiveRing, liveReportVerdict, type LiveRow } from "@despia-native/kernel";
import {
  LIVE_FEED_HEARTBEAT_MS,
  LIVE_HTTP_ATTEST_MAX_BYTES,
  LIVE_HTTP_BATCH_MAX_BYTES,
  LIVE_HTTP_REPORT_MAX_BYTES,
  LIVE_REPORTS_KEPT,
  LIVE_REPORT_STORE_TEXT_MAX,
  rowsViewerWindowMs,
  LIVE_WIRE_SNAPSHOT_MAX_BYTES,
  bearerToken,
  clampInt,
  errorResponse,
  feedMaxMs,
  jsonOk,
  parseBatchBody,
  parseCursor,
  readBoundedText,
  sessionMaxAgeMs,
  sessionTtlMs,
  tokenEquals,
  type LiveDurableState,
  type LiveEnv,
} from "./wire.ts";

interface SessionMeta {
  sid: string;
  createdAt: number;
  deviceToken: string;
  viewerToken: string;
  /** the sliding device deadline — refreshed by every authenticated batch */
  until: number;
  /** the hard cap: no refresh moves the session past this */
  maxUntil: number;
}

interface StoredReport {
  at: number;
  verdict: "not_report" | "modified" | "genuine";
  assertion: boolean;
  bytes: number;
  /** present only when the sealed text fits the storage bound; the verdict always covers the
   *  full upload */
  text?: string;
}

interface WireSnapshot {
  lastBatch: number;
  lastSeq: number;
  tail: { seq: number; row: LiveRow }[];
}

interface FeedViewer {
  push(frame: string): void;
  end(): void;
}

const SESSION_PATH = /^\/s\/([^/]+)\/(batch|attest|report|rows|feed)$/;

function rowFrame(seq: number, row: LiveRow): string {
  // `id:` is what EventSource echoes back as Last-Event-ID; data is a single line because
  // JSON.stringify cannot emit a raw newline.
  return `id: ${seq}\ndata: ${JSON.stringify({ seq, row })}\n\n`;
}

export class LiveSession {
  private readonly state: LiveDurableState;
  private readonly env: LiveEnv;
  private ring = new LiveRing<LiveRow>(LIVE_RING_CAP);
  /** mirror of the last accepted batch index — the ring tracks it privately, the snapshot
   *  needs it explicitly */
  private lastBatch = 0;
  private meta: SessionMeta | null = null;
  private attestation: string | null = null;
  private reports: StoredReport[] = [];
  private archived = false;
  private readonly viewers = new Set<FeedViewer>();
  /** the last authenticated /rows read — a polling dashboard is a viewer too (R1 polls; only
   *  the SSE upgrade holds a stream), and the ack must say so or the device pauses on the
   *  exact person watching. In-memory only: an evicted DO re-learns it on the next poll. */
  private lastRowsPollAt = 0;
  private restore: Promise<void> | null = null;

  constructor(state: LiveDurableState, env: LiveEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureRestored();
    const url = new URL(request.url);
    if (url.pathname === "/init") return this.init(request);
    const match = SESSION_PATH.exec(url.pathname);
    if (match === null) return errorResponse(404, "not_found", "no such route");
    if (this.meta === null || this.meta.sid !== match[1]) {
      return errorResponse(404, "not_found", "no such session");
    }
    switch (match[2]) {
      case "batch":
        return this.batch(request);
      case "attest":
        return this.attest(request);
      case "report":
        return this.report(request);
      case "rows":
        return this.rows(request, url);
      case "feed":
        return this.feed(request, url);
      default:
        return errorResponse(404, "not_found", "no such route");
    }
  }

  // ── restore + write-through ──────────────────────────────────────────────────────────

  private ensureRestored(): Promise<void> {
    if (this.restore === null) this.restore = this.restoreNow();
    return this.restore;
  }

  private async restoreNow(): Promise<void> {
    const storage = this.state.storage;
    const meta = (await storage.get("meta")) as SessionMeta | undefined;
    if (meta === undefined) return;
    this.meta = meta;
    this.attestation = ((await storage.get("attest")) as string | undefined) ?? null;
    this.reports = ((await storage.get("reports")) as StoredReport[] | undefined) ?? [];
    this.archived = ((await storage.get("archived")) as boolean | undefined) ?? false;
    const wire = (await storage.get("wire")) as WireSnapshot | undefined;
    if (wire === undefined || wire.lastBatch < 1 || wire.lastSeq < 1) return;
    const tailRows = wire.tail.map((entry) => entry.row);
    const filler = wire.lastSeq - tailRows.length;
    // Advance the seq counter through evicted (or byte-trimmed) history in the SAME batch as
    // the tail: a persisted snapshot whose only batch was trimmed still restores its seqs at
    // lastSeq - tail.length + 1, so a viewer's cursor stays a truth. One call, because the
    // ring refuses a second batch at the same number. O(lastSeq) once per eviction-restore,
    // bounded by the session age cap; blanks past the ring cap fall out on append.
    const blank: LiveRow = { kind: "kernel", message: "", at: 0 };
    const restored = filler > 0
      ? [...new Array<LiveRow>(filler).fill(blank), ...tailRows]
      : tailRows;
    this.ring.appendBatch(wire.lastBatch, restored);
    this.lastBatch = wire.lastBatch;
  }

  private async persistWire(): Promise<void> {
    const tail = this.ring.read(0, LIVE_RING_CAP).rows;
    // One storage value, platform-capped: trim the OLDEST tail rows until the serialization
    // fits. A shorter persisted tail restores behind a filler exactly like an evicted one.
    // Measured PER ROW, once: re-stringifying the whole shrinking snapshot on every trim pass
    // was O(ring bytes) DO CPU repeated up to eight times per accepted batch on a chatty
    // device. The envelope constant plus per-entry sizes (with the separator) bound the real
    // serialization from above, so a snapshot admitted here always fits.
    const envelope = JSON.stringify({ lastBatch: this.lastBatch, lastSeq: this.ring.last, tail: [] }).length;
    const rowBytes = tail.map((entry) => JSON.stringify(entry).length + 1);
    let total = envelope + rowBytes.reduce((sum, bytes) => sum + bytes, 0);
    let from = 0;
    while (total > LIVE_WIRE_SNAPSHOT_MAX_BYTES && from < tail.length) {
      total -= rowBytes[from]!;
      from += 1;
    }
    const snapshot: WireSnapshot = {
      lastBatch: this.lastBatch,
      lastSeq: this.ring.last,
      tail: from > 0 ? tail.slice(from) : tail,
    };
    await this.state.storage.put("wire", snapshot);
  }

  private viewerCount(now: number): number {
    return this.viewers.size + (now - this.lastRowsPollAt <= rowsViewerWindowMs(this.env) ? 1 : 0);
  }

  // ── the worker-internal birth certificate ────────────────────────────────────────────

  private async init(request: Request): Promise<Response> {
    // Reachable only from the worker's /pair: the session route allowlist never forwards
    // an outside "/init" here.
    if (this.meta !== null) return errorResponse(409, "conflict", "session exists");
    const read = await readBoundedText(request, 4096);
    if (!read.ok) return errorResponse(413, "too_large", "init body too large");
    const meta = JSON.parse(read.text) as SessionMeta;
    this.meta = meta;
    await this.state.storage.put("meta", meta);
    return jsonOk({ ok: true });
  }

  // ── auth ─────────────────────────────────────────────────────────────────────────────

  /** null = admitted; otherwise the refusal. Garbage is 401; the OTHER role's valid token is
   *  403 — a viewer must never be able to write and a device must never be able to read. */
  private admit(presented: string | null, expected: string, other: string): Response | null {
    if (presented === null || presented === "") {
      return errorResponse(401, "unauthorized", "missing token");
    }
    if (tokenEquals(presented, expected)) return null;
    if (tokenEquals(presented, other)) {
      return errorResponse(403, "forbidden", "wrong token for this route");
    }
    return errorResponse(401, "unauthorized", "invalid token");
  }

  private admitDevice(request: Request): Response | null {
    const meta = this.meta!;
    return this.admit(bearerToken(request.headers.get("authorization")), meta.deviceToken, meta.viewerToken);
  }

  /** EventSource cannot set headers, so viewers may present `?token=`; Bearer works too. */
  private admitViewer(request: Request, url: URL): Response | null {
    const meta = this.meta!;
    const presented = url.searchParams.get("token") ?? bearerToken(request.headers.get("authorization"));
    return this.admit(presented, meta.viewerToken, meta.deviceToken);
  }

  private async expiredResponse(): Promise<Response> {
    await this.archiveIfDue();
    return errorResponse(410, "expired", "this session has ended");
  }

  // ── device routes ────────────────────────────────────────────────────────────────────

  private async batch(request: Request): Promise<Response> {
    const refused = this.admitDevice(request);
    if (refused !== null) return refused;
    const meta = this.meta!;
    const now = Date.now();
    if (now > meta.until) return this.expiredResponse();
    const read = await readBoundedText(request, LIVE_HTTP_BATCH_MAX_BYTES);
    if (!read.ok) return errorResponse(413, "too_large", "batch body too large");
    const parsed = parseBatchBody(read.text);
    if (!parsed.ok) return errorResponse(400, "bad_request", parsed.message);
    if (parsed.batch.sid !== meta.sid) return errorResponse(400, "bad_request", "sid mismatch");

    const result = this.ring.appendBatch(parsed.batch.n, parsed.batch.rows);
    if (result.accepted) {
      this.lastBatch = parsed.batch.n;
      const first = result.last - parsed.batch.rows.length + 1;
      for (let i = 0; i < parsed.batch.rows.length; i++) {
        const frame = rowFrame(first + i, parsed.batch.rows[i]!);
        for (const viewer of [...this.viewers]) viewer.push(frame);
      }
      await this.persistWire();
    }
    // The sliding refresh happens on every authenticated batch, accepted or replayed — a
    // retry must not shorten a session — and never moves past the hard cap.
    meta.until = Math.min(now + sessionTtlMs(this.env), meta.maxUntil);
    await this.state.storage.put("meta", meta);
    return jsonOk({
      ok: true,
      accepted: result.accepted,
      viewers: this.viewerCount(now),
      ttlMs: meta.until - now,
      last: result.last,
    });
  }

  private async attest(request: Request): Promise<Response> {
    const refused = this.admitDevice(request);
    if (refused !== null) return refused;
    const now = Date.now();
    if (now > this.meta!.until) return this.expiredResponse();
    const read = await readBoundedText(request, LIVE_HTTP_ATTEST_MAX_BYTES);
    if (!read.ok) return errorResponse(413, "too_large", "attestation too large");
    let doc: unknown;
    try {
      doc = JSON.parse(read.text);
    } catch {
      return errorResponse(400, "bad_request", "attestation is not JSON");
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      return errorResponse(400, "bad_request", "attestation is not an object");
    }
    // Stored verbatim and surfaced — VERIFYING it against Apple/Google is the platform's
    // job (live-logs.md P3), never the relay's: a verdict computed here would be theatre.
    this.attestation = read.text;
    await this.state.storage.put("attest", read.text);
    return jsonOk({ ok: true });
  }

  private async report(request: Request): Promise<Response> {
    const refused = this.admitDevice(request);
    if (refused !== null) return refused;
    const now = Date.now();
    if (now > this.meta!.until) return this.expiredResponse();
    const read = await readBoundedText(request, LIVE_HTTP_REPORT_MAX_BYTES);
    if (!read.ok) return errorResponse(413, "too_large", "report too large");
    const { verdict, assertion } = liveReportVerdict(read.text);
    const entry: StoredReport = { at: now, verdict, assertion, bytes: read.text.length };
    if (read.text.length <= LIVE_REPORT_STORE_TEXT_MAX) entry.text = read.text;
    this.reports = [entry, ...this.reports].slice(0, LIVE_REPORTS_KEPT);
    await this.state.storage.put("reports", this.reports);
    return jsonOk({ ok: true, verdict, assertion });
  }

  // ── viewer routes ────────────────────────────────────────────────────────────────────

  private async rows(request: Request, url: URL): Promise<Response> {
    const refused = this.admitViewer(request, url);
    if (refused !== null) return refused;
    // Viewers outlive the device deadline on purpose — the session list reads a finished
    // session's tail — but nothing outlives the hard cap.
    if (Date.now() > this.meta!.maxUntil) return this.expiredResponse();
    this.lastRowsPollAt = Date.now();
    const after = parseCursor(url.searchParams.get("after"));
    const limit = clampInt(url.searchParams.get("limit"), 200, 1, LIVE_RING_CAP);
    const read = this.ring.read(after, limit);
    return jsonOk({ ok: true, rows: read.rows, gap: read.gap, last: this.ring.last });
  }

  private async feed(request: Request, url: URL): Promise<Response> {
    const refused = this.admitViewer(request, url);
    if (refused !== null) return refused;
    if (Date.now() > this.meta!.maxUntil) return this.expiredResponse();
    // Last-Event-ID wins over ?after= — on reconnect the browser resends it automatically,
    // and the resumed cursor must beat the stale page parameter.
    const lastEventId = request.headers.get("last-event-id");
    const after = lastEventId !== null ? parseCursor(lastEventId) : parseCursor(url.searchParams.get("after"));
    const maxMs = feedMaxMs(this.env);
    const heartbeatMs = Math.min(LIVE_FEED_HEARTBEAT_MS, Math.max(250, Math.floor(maxMs / 2)));

    const encoder = new TextEncoder();
    const viewers = this.viewers;
    const ring = this.ring;
    let closed = false;
    let viewer: FeedViewer | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      closed = true;
      if (viewer !== null) viewers.delete(viewer);
      if (closeTimer !== null) clearTimeout(closeTimer);
      if (heartbeat !== null) clearInterval(heartbeat);
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const put = (frame: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            cleanup();
          }
        };
        // `retry:` first, so it applies even to a stream that dies immediately.
        put("retry: 1000\n\n");
        // Replay, then attach — synchronous inside one DO event, so no row can land between.
        const replay = ring.read(after, LIVE_RING_CAP);
        if (replay.gap) put('event: gap\ndata: {"gap":true}\n\n');
        for (const entry of replay.rows) put(rowFrame(entry.seq, entry.row));
        viewer = {
          push: put,
          end: (): void => {
            if (!closed) {
              cleanup();
              try {
                controller.close();
              } catch {
                // the platform already tore the stream down
              }
            }
          },
        };
        viewers.add(viewer);
        // Self-close so the client reconnects WITH a cursor instead of discovering a proxy
        // timeout by silence (the realtime.ts law).
        closeTimer = setTimeout(() => viewer!.end(), maxMs);
        heartbeat = setInterval(() => put(": keep-alive\n\n"), heartbeatMs);
      },
      cancel: (): void => {
        // The client hung up: stop counting it, or the ack backpressure would keep a device
        // streaming for nobody.
        cleanup();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  }

  // ── the opt-in archive ───────────────────────────────────────────────────────────────

  /** On first touch past the deadline, fold the session into ONE R2 object — only when the
   *  developer bound ARCHIVE; the default relay retains nothing beyond the replay ring. */
  private async archiveIfDue(): Promise<void> {
    if (this.archived || this.env.ARCHIVE === undefined || this.meta === null) return;
    this.archived = true;
    const body = {
      v: 1,
      sid: this.meta.sid,
      createdAt: this.meta.createdAt,
      endedAt: Date.now(),
      rows: this.ring.read(0, LIVE_RING_CAP).rows,
      reports: this.reports,
      ...(this.attestation !== null ? { attestation: this.attestation } : {}),
    };
    await this.env.ARCHIVE.put(`sessions/${this.meta.sid}.json`, JSON.stringify(body), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    await this.state.storage.put("archived", true);
  }
}
