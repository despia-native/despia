//
//  link-refresh.ts — keeping a SHIPPED app in sync with a backend that redeploys without it.
//
//  THE PROBLEM THIS EXISTS FOR. The emitted link table is baked into the build. On the web that is
//  fine: client and server ship together. A NATIVE binary is different — it sits in an app store
//  for weeks while the backend redeploys, so three things drift:
//
//      1. the base URL      — the backend moves host/region
//      2. the route paths   — /notes becomes /v2/notes
//      3. the route set     — an action is added or withdrawn
//
//  A build-time table is still the right FLOOR: it works offline, on first launch, with no round
//  trip. What it needs is a refresh, and DSX already has the machinery for exactly this — the
//  content plane's generation-zero + stale-while-revalidate ladder, and the signed-manifest load
//  gate. This is that ladder applied to the link table:
//
//      generation zero (in the binary)   → always available, never fetched
//              ↓  refreshed, SIGNED, anti-rollback
//      the current table (from the deploy)
//
//  WHY SIGNED, WHEN IT IS ALREADY HTTPS. remote-bundle-signing.md answers this and the answer
//  applies here verbatim: HTTPS authenticates the CHANNEL — that you reached that host over that
//  certificate. It does not authenticate the AUTHOR of the bytes. The link table decides which
//  calls leave the device and where they go, so a poisoned CDN, a mis-issued certificate or a
//  compromised cache could otherwise repoint every `dsx.module.*` call — WITH the user's bearer
//  token attached. The author's key is the anchor, not the transport.
//
//  THE CONTRACT IS THE ONE THAT ALREADY SHIPS (remote-bundle-signing.md, "the byte/format
//  contract"), so one signer serves both and `ClosedSource/scripts/sign_manifest.rb` signs this
//  file's input unchanged:
//    • Ed25519, raw 64-byte signature, over the EXACT fetched bytes — no re-serialisation, no
//      normalisation, not one added or removed newline between signing and verifying.
//    • detached, read header-first: `X-DSX-Signature`, else the `<url>.sig` sidecar; base64,
//      standard or URL-safe, padded or not.
//    • ANTI-ROLLBACK (C1): a monotonic `version` INSIDE the signed bytes. A regressing version
//      still verifies cryptographically and is still refused, because replaying a genuinely-signed
//      OLD table is how an attacker restores a route you deliberately withdrew.
//
//  FAILURE IS ALWAYS "KEEP WHAT WE HAD". Every rejection leaves the current table in place and
//  returns a reason; nothing is ever half-applied, and there is no path from a bad refresh to an
//  unsigned table. The floor in the binary is the worst case, and the floor is a working app.
//

import { LinkSeam, type LinkRoute } from "./bus.ts";

/** What a refresh did, in the same closed-vocabulary spirit as the rest of the bus. */
export type RefreshOutcome =
  | { ok: true; version: number; routes: number }
  | { ok: false; reason: "unreachable" | "malformed" | "unsigned" | "bad_signature" | "rollback_detected" | "not_configured"; message: string };

export interface LinkRefreshOptions {
  /** where the signed table lives — usually `<baseUrl>/dsx/link.json` */
  url: string;
  /** the author's Ed25519 public key, raw 32 bytes, base64 — the baked trust anchor */
  publicKey: string;
  /** the highest version accepted so far; a refresh may not regress below it */
  minVersion?: number;
  fetchImpl?: typeof fetch;
}

/** Accept base64 in any of the four shapes the signer or a header may produce. */
function fromBase64(value: string): Uint8Array | null {
  const cleaned = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + "=".repeat(4 - (cleaned.length % 4));
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Verify a raw-64 Ed25519 signature over `bytes` with a raw-32 public key.
 *
 * WebCrypto only — the same constraint identity.ts works under, so this runs unchanged in a
 * browser, in Node and on an edge runtime. A platform without Ed25519 support answers `false`
 * rather than throwing: an unverifiable table must be REFUSED, never accepted by default.
 */
async function verifyEd25519(publicKeyRaw: Uint8Array, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  if (publicKeyRaw.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKeyRaw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, bytes as BufferSource);
  } catch {
    return false;
  }
}

interface SignedLinkDoc {
  format?: unknown;
  version?: unknown;
  digest?: unknown;
  routes?: unknown;
}

/**
 * Fetch, verify and install a newer link table. Returns what happened; never throws.
 *
 * On ANY rejection the currently-installed table is untouched — the caller keeps serving from
 * whatever it already had, which at worst is the generation zero compiled into the binary.
 */
export async function refreshLink(options: LinkRefreshOptions): Promise<RefreshOutcome> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, reason: "not_configured", message: "no fetch implementation on this platform" };
  const anchor = fromBase64(options.publicKey);
  if (anchor === null || anchor.length !== 32) {
    return { ok: false, reason: "not_configured", message: "the trust anchor must be a raw 32-byte Ed25519 public key, base64" };
  }

  let response: Response;
  let raw: ArrayBuffer;
  try {
    response = await doFetch(options.url, { headers: { accept: "application/json" } });
    raw = await response.arrayBuffer();
  } catch (e) {
    return { ok: false, reason: "unreachable", message: e instanceof Error ? e.message : String(e) };
  }
  if (!response.ok) return { ok: false, reason: "unreachable", message: `the table endpoint answered ${response.status}` };

  // THE EXACT BYTES, kept as bytes. Parsing to an object and re-serialising would change them
  // (key order, spacing, the trailing newline) and the signature is over what the server sent.
  const bytes = new Uint8Array(raw);

  const header = response.headers.get("x-dsx-signature");
  let signatureText = header;
  if (signatureText === null || signatureText.trim() === "") {
    try {
      const sidecar = await doFetch(`${options.url}.sig`, { headers: { accept: "text/plain" } });
      if (sidecar.ok) signatureText = await sidecar.text();
    } catch {
      /* the sidecar is the fallback; its absence is reported as `unsigned` below */
    }
  }
  if (signatureText === null || signatureText.trim() === "") {
    return { ok: false, reason: "unsigned", message: "no X-DSX-Signature header and no .sig sidecar — an unsigned table is never installed" };
  }
  const signature = fromBase64(signatureText);
  if (signature === null) return { ok: false, reason: "bad_signature", message: "the detached signature is not valid base64" };

  if (!(await verifyEd25519(anchor, signature, bytes))) {
    return { ok: false, reason: "bad_signature", message: "the table is not signed by the configured key" };
  }

  // Only AFTER the bytes are proven authentic is anything parsed out of them.
  let doc: SignedLinkDoc;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes)) as SignedLinkDoc;
  } catch {
    return { ok: false, reason: "malformed", message: "the signed table is not valid JSON" };
  }
  if (doc.format !== "despia:client-link@1") {
    return { ok: false, reason: "malformed", message: `unexpected format ${String(doc.format)}` };
  }
  if (typeof doc.version !== "number" || !Number.isInteger(doc.version) || doc.version < 0) {
    return { ok: false, reason: "malformed", message: "the table carries no integer `version` — anti-rollback cannot be enforced without one" };
  }
  if (!Array.isArray(doc.routes)) return { ok: false, reason: "malformed", message: "the table carries no `routes` array" };

  const floor = options.minVersion ?? 0;
  if (doc.version < floor) {
    // Cryptographically fine, and still refused: this is a genuine older table being replayed.
    return { ok: false, reason: "rollback_detected", message: `version ${doc.version} regresses below the accepted ${floor}` };
  }

  for (const route of doc.routes as LinkRoute[]) {
    if (typeof route?.chain !== "string" || typeof route?.action !== "string" || typeof route?.method !== "string" || typeof route?.path !== "string") {
      return { ok: false, reason: "malformed", message: "a route row is missing chain/action/method/path" };
    }
    if (!route.path.startsWith("/")) {
      // A table that could point a call at another origin is the whole reason this file verifies
      // anything; the transport refuses it too, and refusing here keeps it out of the table.
      return { ok: false, reason: "malformed", message: `route ${route.chain}.${route.action} has a non-rooted path` };
    }
  }

  // Installed only once every check has passed, so a refresh is atomic from the caller's view.
  LinkSeam.routes = doc.routes as LinkRoute[];
  return { ok: true, version: doc.version, routes: doc.routes.length };
}
