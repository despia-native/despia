//
//  telemetry.ts — the shared telemetry core: the SCRUBBER and the QUEUE POLICY. The law is the
//  corpus, OpenSource/Conformance/telemetry/{scrub,queue}.json (parity/F10-telemetry.md); the
//  Kotlin twin is :core TelemetryPolicy.kt and the Swift twin is Engine/iOS/TelemetryPolicy.swift.
//
//  Everything platform-shaped lives OUTSIDE this file — crash handlers, the ANR watchdog, the
//  on-disk queue, the transports. What is here is the half that decides WHAT LEAVES THE DEVICE,
//  which is exactly the half that must not drift between renderers: a redaction rule that fires
//  on iOS and not on Android is a privacy incident with a platform column.
//
//  This file records nothing and sends nothing. Core/Telemetry is a SINK ADAPTER over the kernel
//  error ledger (`dsx.errors`, error-system.md); it never becomes a second error system.
//

/** The placeholder each rule leaves behind. Pinned by the corpus — a sink's grouping keys are
 *  built from scrubbed text, so changing one of these re-groups every historical issue. */
export const TELEMETRY_PLACEHOLDERS = {
  email: "[email]",
  bearer: "Bearer [token]",
  jwt: "[jwt]",
  phone: "[phone]",
  card: "[card]",
  home: "[user]",
  key: "[redacted]",
} as const;

/** One ordered redaction rule. `check` (card rules only) rejects a match the regex shape alone
 *  cannot judge, so a Luhn-failing 16-digit order number stays readable. */
interface ScrubRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replace: string;
  readonly check?: (match: string) => boolean;
}

/** Digits only, for the Luhn gate. */
function digitsOf(text: string): string {
  let out = "";
  for (const ch of text) if (ch >= "0" && ch <= "9") out += ch;
  return out;
}

/** The Luhn check every card rule gates on. Without it a 16-digit order number reads as a card
 *  and the developer loses the one field that would have identified the order. */
export function telemetryLuhn(digits: string): boolean {
  if (digits.length === 0) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function cardShaped(match: string): boolean {
  const digits = digitsOf(match);
  return digits.length >= 14 && digits.length <= 19 && telemetryLuhn(digits);
}

/**
 * The ordered rule table. ORDER IS CONTRACT (corpus `order`):
 *   bearer before jwt  — an Authorization header collapses to ONE placeholder rather than
 *                        `Bearer [jwt]`, which reads like the header survived;
 *   card before phone  — a card number is never reported as a phone number;
 *   home before phone  — a path is redacted as a path.
 *
 * The `bearer` prefix is spelled as explicit character classes rather than a case-insensitive
 * flag: the three regex engines disagree about inline modifiers and agree about character
 * classes, and one scrubber that behaves differently per platform is worse than none.
 */
const SCRUB_RULES: readonly ScrubRule[] = [
  { id: "bearer", pattern: /[Bb][Ee][Aa][Rr][Ee][Rr] [A-Za-z0-9._~+/=-]{8,}/g, replace: TELEMETRY_PLACEHOLDERS.bearer },
  { id: "jwt", pattern: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(\.[A-Za-z0-9_-]+)?/g, replace: TELEMETRY_PLACEHOLDERS.jwt },
  { id: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: TELEMETRY_PLACEHOLDERS.email },
  { id: "homeUnix", pattern: /\/Users\/[^/\s"']+/g, replace: `/Users/${TELEMETRY_PLACEHOLDERS.home}` },
  { id: "homeLinux", pattern: /\/home\/[^/\s"']+/g, replace: `/home/${TELEMETRY_PLACEHOLDERS.home}` },
  { id: "homeWindows", pattern: /Users\\[^\\/\s"']+/g, replace: `Users\\${TELEMETRY_PLACEHOLDERS.home}` },
  { id: "cardAmex", pattern: /[0-9]{4}[ -][0-9]{6}[ -][0-9]{5}/g, replace: TELEMETRY_PLACEHOLDERS.card, check: cardShaped },
  { id: "cardGrouped", pattern: /[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{1,7}/g, replace: TELEMETRY_PLACEHOLDERS.card, check: cardShaped },
  // Greedy on purpose: a maximal digit run longer than 19 fails `cardShaped` and stays readable,
  // which is how a 23-digit reference number survives without a lookbehind (three engines, one
  // behavior).
  { id: "cardPlain", pattern: /[0-9]{14,}/g, replace: TELEMETRY_PLACEHOLDERS.card, check: cardShaped },
  { id: "phoneInternational", pattern: /\+[0-9][0-9 ().-]{6,18}[0-9]/g, replace: TELEMETRY_PLACEHOLDERS.phone },
  { id: "phoneGrouped", pattern: /\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}/g, replace: TELEMETRY_PLACEHOLDERS.phone },
];

/** The rule ids in application order — the corpus asserts this list, so a rule cannot be
 *  reordered on one renderer only. */
export const TELEMETRY_SCRUB_ORDER: readonly string[] = SCRUB_RULES.map((rule) => rule.id);

/**
 * Keys whose VALUE is dropped whole, whatever it looks like.
 *
 * Matching is on the normalized key (lowercased, non-alphanumerics removed) and is EXACT, never a
 * substring: `token` redacts, `tokenCount` does not, because a scrubber that eats metric names
 * gets switched off. `email` and `phone` are deliberately absent — their values are still scrubbed
 * by the text pass, and `identify` passes its explicit fields around the scrubber entirely, which
 * is what "opt-in per field" means.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "password", "passwd", "secret", "token", "accesstoken", "refreshtoken", "idtoken", "apikey",
  "authorization", "cookie", "setcookie", "sessionid", "ssn", "creditcard", "cardnumber",
  "cvv", "cvc", "pin", "privatekey", "clientsecret",
]);

function normalizeKey(key: string): string {
  let out = "";
  for (const ch of key.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
  }
  return out;
}

/** Is this a key whose value never leaves the device? */
export function telemetryIsSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

/** Redact one string. Applied at ENQUEUE, never at send — a crash during flush must not be able
 *  to leak an unredacted buffer, so the buffer never holds one. */
export function telemetryScrubText(input: string): string {
  let text = input;
  for (const rule of SCRUB_RULES) {
    text = text.replace(rule.pattern, (match) => (rule.check && !rule.check(match) ? match : rule.replace));
  }
  return text;
}

/** Redact one key/value pair: a sensitive key drops the value whole, everything else is scrubbed
 *  as text. */
export function telemetryScrubValue(key: string, value: string): string {
  return telemetryIsSensitiveKey(key) ? TELEMETRY_PLACEHOLDERS.key : telemetryScrubText(value);
}

/** The ARG SHAPE of a failed `dsx.module` call: keys and value TYPES, never values. What is
 *  diagnostic about a failed call is which fields were present, and that is exactly the part that
 *  carries no secrets. */
export function telemetryArgShape(args: Readonly<Record<string, unknown>> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args) return out;
  for (const key of Object.keys(args).sort()) {
    const value = args[key];
    out[key] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  }
  return out;
}

// ─────────────────────────── the queue policy ───────────────────────────

const HEX_RUN = /0[xX][0-9a-fA-F]+/g;
const DIGIT_RUN = /[0-9]+/g;
const WHITESPACE_RUN = /\s+/g;

/** Collapse the varying parts of a message so a crash loop folds to one fingerprint: addresses
 *  become `<addr>`, digit runs become `#`, whitespace collapses, and the tail is capped. */
export function telemetryCollapseMessage(message: string | null | undefined): string {
  if (!message) return "";
  const folded = message.replace(HEX_RUN, "<addr>").replace(DIGIT_RUN, "#").replace(WHITESPACE_RUN, " ").trim();
  return folded.length > 200 ? folded.slice(0, 200) : folded;
}

/** The dedupe/grouping key: source, code and the collapsed message. Two crashes at different
 *  addresses are ONE issue, which is the difference between a count and ten thousand events. */
export function telemetryFingerprint(source: string, code: string, message?: string | null): string {
  return `${source}|${code}|${telemetryCollapseMessage(message)}`;
}

/** FNV-1a 32-bit over UTF-8 — the one hash all three renderers compute identically. */
export function telemetryHash32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic sampling: a pure function of the fingerprint, not a random draw, so one device's
 *  sample decision is every device's and a corpus can pin it. */
export function telemetrySampled(fingerprintKey: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  return telemetryHash32(fingerprintKey) % 10000 < Math.round(rate * 10000);
}

/** Exponential backoff, capped at five minutes. No jitter: a corpus cannot pin a random number,
 *  and the platform half is free to add jitter where it schedules the retry. */
export function telemetryBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  const delay = 1000 * Math.pow(2, attempt - 1);
  return delay > 300000 ? 300000 : delay;
}

/** What `offer` decided. `evicted` means the event was accepted AND the oldest one fell out. */
export type TelemetryOfferOutcome = "accepted" | "deduped" | "evicted";

export interface TelemetryOfferResult {
  readonly outcome: TelemetryOfferOutcome;
  readonly size: number;
  readonly dropped: number;
  readonly count: number;
}

interface QueueItem {
  fingerprint: string;
  at: number;
  count: number;
}

/**
 * The bounded, de-duplicating event ring — pure, so the corpus judges it on every renderer.
 *
 * The platform half persists it to disk and drives the flush timer; nothing here does IO. A repeat
 * of a live fingerprint inside the window increments a COUNT and slides the window, so a crash
 * loop reports "this happened 4,182 times" instead of filling the queue with itself. Overflow
 * drops the OLDEST and counts the drop, because the newest crash is the one being debugged and a
 * silent drop is a lie to the sink.
 */
export class TelemetryQueue {
  readonly capacity: number;
  readonly windowMs: number;
  readonly maxBatch: number;
  #items: QueueItem[] = [];
  #dropped = 0;

  constructor(capacity: number, windowMs: number, maxBatch: number) {
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.maxBatch = maxBatch;
  }

  get size(): number { return this.#items.length; }
  /** Events lost to the bound, ever. Reported to the sink so it sees its own blind spot. */
  get dropped(): number { return this.#dropped; }

  offer(fingerprintKey: string, at: number): TelemetryOfferResult {
    for (const item of this.#items) {
      if (item.fingerprint === fingerprintKey && at - item.at < this.windowMs) {
        item.count += 1;
        item.at = at;
        return { outcome: "deduped", size: this.#items.length, dropped: this.#dropped, count: item.count };
      }
    }
    this.#items.push({ fingerprint: fingerprintKey, at, count: 1 });
    let outcome: TelemetryOfferOutcome = "accepted";
    if (this.#items.length > this.capacity) {
      this.#items.shift();
      this.#dropped += 1;
      outcome = "evicted";
    }
    return { outcome, size: this.#items.length, dropped: this.#dropped, count: 1 };
  }

  /** The next batch's fingerprints, oldest first, capped at `maxBatch`. */
  batch(): string[] {
    return this.#items.slice(0, this.maxBatch).map((item) => item.fingerprint);
  }

  /** How many times a live fingerprint has been seen, or 0 when it is not queued. */
  countOf(fingerprintKey: string): number {
    for (const item of this.#items) if (item.fingerprint === fingerprintKey) return item.count;
    return 0;
  }

  /** Drop the first `n` events — called after the sink accepted them. Never underflows. */
  ack(n: number): { size: number } {
    this.#items = this.#items.slice(n);
    return { size: this.#items.length };
  }

  /** Revoked consent drops everything pending, and the drop is NOT counted: those events were
   *  never the sink's to know about. */
  clear(): void {
    this.#items = [];
  }
}
