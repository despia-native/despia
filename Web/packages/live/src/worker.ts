//
//  worker.ts — the outer face of the relay (live-logs.md 3.2): route shape, the /pair
//  admission, the ungated /verify, and CORS. Everything per-session — tokens, the ring, the
//  feed — lives in the LiveSession Durable Object; this worker only decides WHICH routes
//  exist and forwards the request whole, so the DO's internal /init is unreachable from
//  outside by construction.
//
//  /pair fails CLOSED and with probing parity (the preview-workers.ts posture): no admin key
//  configured means the route does not exist, and a wrong key reads exactly like an unknown
//  path — probing cannot distinguish "blocked" from "absent".
//

import { liveReportExtract, liveReportVerdict } from "@despia-native/kernel";
import {
  LIVE_HTTP_VERIFY_MAX_BYTES,
  LIVE_KEY_HEADER,
  LIVE_SID_SHAPE,
  allowedOrigin,
  corsHeaders,
  errorResponse,
  jsonOk,
  readBoundedText,
  sessionMaxAgeMs,
  sessionTtlMs,
  tokenEquals,
  withCors,
  type LiveEnv,
} from "./wire.ts";

const SESSION_PATH = /^\/s\/([^/]+)\/(batch|attest|report|rows|feed)$/;

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

/** short on purpose — it rides QR codes and deep links; the secrets are the tokens */
function mintSid(): string {
  return `s_${randomHex(6)}`;
}

function mintToken(prefix: string): string {
  return `${prefix}_${randomHex(16)}`;
}

async function pair(request: Request, env: LiveEnv): Promise<Response> {
  const adminKey = env.LIVE_ADMIN_KEY;
  const presented = request.headers.get(LIVE_KEY_HEADER);
  if (adminKey === undefined || adminKey === "" || !tokenEquals(presented, adminKey)) {
    return errorResponse(404, "not_found", "no such route");
  }
  const ttlMs = Math.min(sessionTtlMs(env), sessionMaxAgeMs(env));
  // Two attempts: a 48-bit sid collision is vanishingly rare, and the DO refuses re-init
  // rather than letting a collision silently share tokens.
  for (let attempt = 0; attempt < 2; attempt++) {
    const sid = mintSid();
    const deviceToken = mintToken("dt");
    const viewerToken = mintToken("vt");
    const now = Date.now();
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sid));
    const born = await stub.fetch(
      new Request("https://live-session/init", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          sid,
          createdAt: now,
          deviceToken,
          viewerToken,
          until: now + ttlMs,
          maxUntil: now + sessionMaxAgeMs(env),
        }),
      }),
    );
    if (born.status === 409) continue;
    if (!born.ok) return errorResponse(500, "relay_failed", "could not create the session");
    return jsonOk({ ok: true, sid, deviceToken, viewerToken, ttlMs });
  }
  return errorResponse(500, "relay_failed", "could not allocate a session id");
}

/** The support verifier: paste anything, get the verdict — ungated and storing NOTHING, so
 *  support can forward its answer verbatim. Prose around the envelope is rescued by the
 *  kernel's extractor; the verdicts themselves stay the corpus-pinned core. */
async function verify(request: Request): Promise<Response> {
  const read = await readBoundedText(request, LIVE_HTTP_VERIFY_MAX_BYTES);
  if (!read.ok) return errorResponse(413, "too_large", "paste too large");
  const candidate = liveReportExtract(read.text) ?? read.text.trim();
  const { verdict, assertion } = liveReportVerdict(candidate);
  return jsonOk({ ok: true, verdict, assertion });
}

async function route(request: Request, env: LiveEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/pair") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "POST only", { allow: "POST" });
    }
    return pair(request, env);
  }
  if (path === "/verify") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "POST only", { allow: "POST" });
    }
    return verify(request);
  }
  const match = SESSION_PATH.exec(path);
  if (match !== null) {
    const sid = match[1]!;
    const wantsGet = match[2] === "rows" || match[2] === "feed";
    if (request.method !== (wantsGet ? "GET" : "POST")) {
      return errorResponse(405, "method_not_allowed", wantsGet ? "GET only" : "POST only", {
        allow: wantsGet ? "GET" : "POST",
      });
    }
    if (!LIVE_SID_SHAPE.test(sid)) return errorResponse(404, "not_found", "no such session");
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sid));
    return stub.fetch(request);
  }
  return errorResponse(404, "not_found", "no such route");
}

export default {
  async fetch(request: Request, env: LiveEnv): Promise<Response> {
    const origin = allowedOrigin(env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    try {
      return withCors(await route(request, env), origin);
    } catch {
      // No exception text on the wire — the detail belongs in the operator's own worker log.
      return withCors(errorResponse(500, "relay_failed", "the relay failed to answer"), origin);
    }
  },
};
