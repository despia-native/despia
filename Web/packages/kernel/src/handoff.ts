//
//  handoff.ts — the SHARED PURE CORE behind Core/Handoff (F17.8): what a continuity activity
//  IS, decided once and measured identically by all three renderers.
//
//  WHY A CORE. Handoff's real constraint is a SIZE LIMIT nobody documents precisely: Apple
//  transports the activity's userInfo over Bluetooth LE advertisement plus a short exchange,
//  and an oversized payload does not error — it silently stops appearing on the other device.
//  A limit that is only enforced on one platform, or measured differently on two, is not a
//  limit. So the payload grammar, the CANONICAL serialisation and the byte count live here.
//
//  THE CANONICAL FORM IS EXACT ON PURPOSE. Three languages must agree on the byte count to the
//  byte, so: keys are ASCII and sorted (three languages sort ASCII identically; Swift's default
//  String ordering is Unicode-canonical and would NOT match JS or Kotlin on anything else),
//  numbers are integers only (a binary float has no single decimal spelling), and the escape
//  rules are written out rather than delegated to each platform's JSON encoder.
//
//  Pinned by OpenSource/Conformance/handoff/activity.json.
//

/**
 * The practical ceiling on an NSUserActivity's userInfo before the OS quietly stops advertising
 * it. Apple documents no number; this is the size below which continuity is reliable, and it is
 * enforced on every platform so a payload that works on one works on all.
 */
export const HANDOFF_MAX_PAYLOAD_BYTES = 3072;

export const HANDOFF_MAX_TITLE_CHARS = 256;

export type HandoffRefusal =
  | "invalid_activity"
  | "invalid_url"
  | "invalid_payload"
  | "payload_too_large";

export type HandoffResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HandoffRefusal; detail?: string };

function fail<T>(error: HandoffRefusal, detail?: string): HandoffResult<T> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

export interface HandoffActivity {
  /** the reverse-DNS activity type, which must also be in the app's NSUserActivityTypes */
  readonly activity: string;
  /** what the receiving device shows in its handoff affordance */
  readonly title: string;
  /** the http(s) URL a device WITHOUT the app falls back to, or "" */
  readonly url: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** the canonical serialisation's UTF-8 length, which is what the ceiling measures */
  readonly payloadBytes: number;
}

/**
 * An activity type is reverse-DNS with at least two labels: `com.example.viewing`.
 *
 * Apple additionally requires it to appear in the app's `NSUserActivityTypes` Info.plist array,
 * and an activity type that is not listed is advertised to nobody, silently. The module's
 * manifest carries a config token for that list; this function only guards the grammar.
 */
export function normalizeActivityType(raw: unknown): HandoffResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return fail("invalid_activity", "an activity type is required");
  if (text.length > 128) return fail("invalid_activity", "an activity type is at most 128 characters");
  const labels = text.split(".");
  if (labels.length < 2) {
    return fail("invalid_activity", "an activity type is reverse-DNS, e.g. com.example.viewing");
  }
  for (const label of labels) {
    if (label.length === 0) return fail("invalid_activity", "an empty label");
    for (const c of label) {
      const ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "-";
      if (!ok) return fail("invalid_activity", text);
    }
  }
  return { ok: true, value: text };
}

/** The fallback a device without the app opens. http(s) only: a custom scheme on a Mac that
 *  never installed the app opens nothing, which is the same as having no fallback. */
export function normalizeHandoffUrl(raw: unknown): HandoffResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return { ok: true, value: "" };
  const lower = text.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
    return fail("invalid_url", "a handoff fallback is an http or https URL");
  }
  if (/[\s]/.test(text)) return fail("invalid_url", text);
  return { ok: true, value: text };
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t",
  "\b": "\\b", "\f": "\\f",
};

function canonicalString(value: string): string {
  let out = '"';
  for (const c of value) {
    const escape = ESCAPES[c];
    if (escape !== undefined) { out += escape; continue; }
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += c;
  }
  return `${out}"`;
}

function isAsciiKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const c of key) {
    const ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
      || c === "_" || c === "." || c === "-";
    if (!ok) return false;
  }
  return true;
}

/**
 * Serialise a payload the same way in every language, so the byte count is the same number.
 *
 * Refuses what cannot be spelled identically three times: a non-integer number (binary floats
 * have no single decimal spelling), a non-ASCII key (Swift's default String ordering is
 * Unicode-canonical and would sort differently from JS and Kotlin), and anything nested more
 * deeply than one array of scalars — a handoff payload is a pointer to state, not the state.
 */
export function canonicalHandoffJson(value: unknown, depth = 0): HandoffResult<string> {
  if (value === null || value === undefined) return { ok: true, value: "null" };
  if (typeof value === "boolean") return { ok: true, value: value ? "true" : "false" };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return fail("invalid_payload", "a handoff payload carries whole numbers; quote anything else");
    }
    // `-0` has two spellings in JS and one everywhere else; normalise before it can differ.
    return { ok: true, value: String(value === 0 ? 0 : value) };
  }
  if (typeof value === "string") return { ok: true, value: canonicalString(value) };
  if (Array.isArray(value)) {
    // An array is a VALUE of the payload object, so exactly depth 1. A bare array payload
    // (depth 0) is not a payload, and an array inside an array is the second level.
    if (depth !== 1) return fail("invalid_payload", "a handoff payload nests one level, not two");
    const parts: string[] = [];
    for (const entry of value) {
      const one = canonicalHandoffJson(entry, depth + 1);
      if (one.ok !== true) return fail(one.error, one.detail);
      parts.push(one.value);
    }
    return { ok: true, value: `[${parts.join(",")}]` };
  }
  if (typeof value === "object") {
    // The payload itself is the ONLY object: a handoff payload is a pointer to state, not the
    // state, and a nested graph is what pushes an activity past the size the OS will advertise.
    if (depth !== 0) return fail("invalid_payload", "a handoff payload nests one level, not two");
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key] of entries) {
      if (!isAsciiKey(key)) {
        return fail("invalid_payload", `${key}: a payload key is ASCII letters, digits, . _ or -`);
      }
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const parts: string[] = [];
    for (const [key, entry] of entries) {
      const one = canonicalHandoffJson(entry, depth + 1);
      if (one.ok !== true) return fail(one.error, one.detail);
      parts.push(`${canonicalString(key)}:${one.value}`);
    }
    return { ok: true, value: `{${parts.join(",")}}` };
  }
  return fail("invalid_payload", "a handoff payload holds strings, whole numbers and booleans");
}

/** UTF-8 byte length, counted by hand so no platform's encoder can disagree. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** What the ceiling measures: the canonical serialisation's UTF-8 length. */
export function handoffPayloadBytes(payload: unknown): HandoffResult<number> {
  const canonical = canonicalHandoffJson(payload ?? {});
  if (canonical.ok !== true) return fail(canonical.error, canonical.detail);
  return { ok: true, value: utf8ByteLength(canonical.value) };
}

export interface RawHandoff {
  activity?: unknown;
  title?: unknown;
  url?: unknown;
  payload?: unknown;
}

/**
 * Validate an activity before it is advertised.
 *
 * THE SIZE CHECK IS THE POINT. An oversized userInfo does not error on Apple's side: the
 * activity simply stops appearing on the other device, and the developer has nothing to debug.
 * Refusing here, with both numbers in the message, is the only place that failure is visible.
 */
export function normalizeHandoff(raw: RawHandoff): HandoffResult<HandoffActivity> {
  const activity = normalizeActivityType(raw.activity);
  if (activity.ok !== true) return fail(activity.error, activity.detail);
  const url = normalizeHandoffUrl(raw.url);
  if (url.ok !== true) return fail(url.error, url.detail);

  const rawPayload = raw.payload;
  if (rawPayload !== undefined && rawPayload !== null
      && (typeof rawPayload !== "object" || Array.isArray(rawPayload))) {
    return fail("invalid_payload", "a payload is an object");
  }
  const payload = (rawPayload as Record<string, unknown> | undefined) ?? {};

  const bytes = handoffPayloadBytes(payload);
  if (bytes.ok !== true) return fail(bytes.error, bytes.detail);
  if (bytes.value > HANDOFF_MAX_PAYLOAD_BYTES) {
    return fail("payload_too_large",
      `${bytes.value} bytes; the ceiling is ${HANDOFF_MAX_PAYLOAD_BYTES}. Hand over an identifier and fetch the rest.`);
  }

  const title = String(raw.title ?? "").trim().slice(0, HANDOFF_MAX_TITLE_CHARS);

  return {
    ok: true,
    value: { activity: activity.value, title, url: url.value, payload, payloadBytes: bytes.value },
  };
}

/** What arrives on the receiving device, normalised into the same shape the sender advertised
 *  so an app writes one handler rather than one per platform. */
export function parseHandoffContinuation(raw: RawHandoff): HandoffResult<HandoffActivity> {
  const activity = normalizeActivityType(raw.activity);
  if (activity.ok !== true) return fail(activity.error, activity.detail);
  const url = normalizeHandoffUrl(raw.url);
  // A malformed incoming URL is DROPPED rather than refused: the continuation still carries a
  // usable activity and payload, and losing the whole handoff over a bad fallback would be a
  // worse outcome than losing the fallback.
  const resolvedUrl = url.ok === true ? url.value : "";
  const payload = (raw.payload !== null && typeof raw.payload === "object" && !Array.isArray(raw.payload))
    ? (raw.payload as Record<string, unknown>)
    : {};
  const bytes = handoffPayloadBytes(payload);
  return {
    ok: true,
    value: {
      activity: activity.value,
      title: String(raw.title ?? "").trim().slice(0, HANDOFF_MAX_TITLE_CHARS),
      url: resolvedUrl,
      payload,
      payloadBytes: bytes.ok === true ? bytes.value : 0,
    },
  };
}

/** Human copy for each refusal, so three renderers apologise with one sentence. */
export const HANDOFF_MESSAGES: Readonly<Record<HandoffRefusal, string>> = {
  invalid_activity: "That is not a reverse-DNS activity type.",
  invalid_url: "A handoff fallback is an http or https URL.",
  invalid_payload: "A handoff payload holds strings, whole numbers and booleans.",
  payload_too_large: "That payload is too large to advertise; hand over an identifier instead.",
};
