//
//  compose-core.ts — the shared Core/Compose core: the composer result vocabulary and its
//  fidelity ladder, the (empty) permission surface, the capability disclosure, the recipient cap
//  and the attachment rule. The law is the corpus, OpenSource/Conformance/compose/result.json
//  (parity F13); the Kotlin twin is :core ComposeCore.kt and the Swift twin is
//  Engine/iOS/ComposeCore.swift.
//
//  `dsx.module.compose.{sms,mail}` PRESENT the system composer prefilled and NEVER SEND: the
//  user reads the message in their own messaging or mail app and taps send there. That is why no
//  permission is involved on any renderer, and why no SEND_SMS row exists anywhere.
//

/** Everything a composer may settle as. `saved` is a mail-draft outcome only. */
export const COMPOSE_RESULTS: readonly string[] = ["sent", "cancelled", "saved", "failed", "unknown"];

/**
 * renderer -> the results it can actually report.
 *
 * iOS MessageUI reports exactly what the user did; Android's ACTION_SENDTO has no result
 * callback at all and a browser's mailto: link has none either. `unknown` must never be upgraded
 * to `sent` because the intent launched: a caller that cannot trust `sent` has no reason to read
 * the field.
 */
export const COMPOSE_RESULT_FIDELITY: { readonly [renderer: string]: { readonly [action: string]: readonly string[] } } = {
  ios: { sms: ["sent", "cancelled", "failed"], mail: ["sent", "saved", "cancelled", "failed"] },
  android: { sms: ["unknown"], mail: ["unknown"] },
  web: { sms: ["unknown"], mail: ["unknown"] },
};

/** Every action on every renderer: none. This table is the contract. */
export const COMPOSE_PERMISSION_SURFACE: { readonly [action: string]: string } = {
  sms: "none",
  mail: "none",
  capabilities: "none",
};

/** An SMS permission appearing in the merged manifest is a build regression, not a feature. */
export const COMPOSE_FORBIDDEN_PERMISSIONS: readonly string[] = [
  "android.permission.SEND_SMS",
  "android.permission.READ_SMS",
  "android.permission.RECEIVE_SMS",
];

/** Renderers whose composer can render an HTML mail body. Everywhere else an `isHtml` request is
 *  served as plain text and SAYS SO, the `applied: false` convention rather than shipping markup
 *  as text. */
const HTML_CAPABLE: readonly string[] = ["ios"];

export interface ComposeOutcome {
  readonly result: string | null;
  /** false when HTML was asked for and the composer degraded it; null when nothing degraded. */
  readonly isHtml: boolean | null;
  readonly error: string | null;
}

export interface ComposeOutcomeInput {
  readonly renderer: string;
  readonly action: string;
  /** What the composer reported, or null/absent where the platform reports nothing. */
  readonly composerResult?: string | null;
  /** Whether the composer actually came up. A launch that throws is `no_composer`. */
  readonly launched?: boolean;
  readonly isHtml?: boolean;
}

/**
 * The result ladder. A composer that reports gets its word through verbatim; one that cannot
 * report says `unknown`, which is a different answer from `no_composer` — the first means the
 * composer opened and this app will never learn what happened, the second means it never opened.
 */
export function composeOutcome(input: ComposeOutcomeInput): ComposeOutcome {
  if (input.launched === false) return { result: null, isHtml: null, error: "no_composer" };
  const degraded = input.isHtml === true && !HTML_CAPABLE.includes(input.renderer) ? false : null;
  const reported = input.composerResult ?? null;
  const result = reported === null ? "unknown" : reported;
  return { result, isHtml: degraded, error: null };
}

export interface ComposeCapabilities {
  readonly sms: boolean;
  readonly mail: boolean;
  /** Present only where the platform discloses it: Android names the resolving package, iOS
   *  never does, and a browser cannot observe whether a handler exists at all. */
  readonly defaultMailClient: string | null;
}

export interface ComposeCapabilitiesInput {
  readonly renderer: string;
  readonly canText?: boolean;
  readonly canMail?: boolean;
  readonly smsResolver?: string | null;
  readonly mailResolver?: string | null;
}

/** The Android resolver disambiguation activity resolves as the package `android`, which is not
 *  a real client: offering the button on the strength of it is the bug this filters out. */
export function composeResolverPackage(name: string | null | undefined): string | null {
  const text = String(name ?? "").trim();
  return text === "" || text === "android" ? null : text;
}

/** Ask before offering the button. A page can only promise that a composer may be ATTEMPTED. */
export function composeCapabilities(input: ComposeCapabilitiesInput): ComposeCapabilities {
  if (input.renderer === "web") return { sms: true, mail: true, defaultMailClient: null };
  if (input.renderer === "android") {
    const mail = composeResolverPackage(input.mailResolver);
    return {
      sms: composeResolverPackage(input.smsResolver) !== null,
      mail: mail !== null,
      defaultMailClient: mail,
    };
  }
  return { sms: input.canText === true, mail: input.canMail === true, defaultMailClient: null };
}

export interface ComposeDecision {
  readonly runs: boolean;
  readonly error: string | null;
  readonly message: string | null;
}

const COMPOSE_ALLOWED: ComposeDecision = { runs: true, error: null, message: null };

/**
 * The recipient cap is config (`max_recipients`, default 100), because no platform constant
 * exists and clients truncate silently somewhere past a few dozen. A composer that opens with
 * half the list is worse than one that refuses. Mail counts to + cc + bcc together.
 */
export function composeRecipientDecision(count: number, cap: number): ComposeDecision {
  if (count > cap) {
    return { runs: false, error: "too_many_recipients", message: "Too many recipients for one message." };
  }
  return COMPOSE_ALLOWED;
}

export interface ComposeAttachmentInput {
  readonly renderer: string;
  readonly path: string;
  /** Android only: whether the path sits under the declared FileProvider roots. */
  readonly insideRoots?: boolean;
  readonly exists?: boolean;
}

/**
 * Local files only. A remote URL is not fetched on the caller's behalf and the web cannot attach
 * at all — a composer that opens quietly missing what the caller attached is worse than one that
 * refuses, so every failure is `attachment_failed`.
 */
export function composeAttachmentDecision(input: ComposeAttachmentInput): ComposeDecision {
  const refused: ComposeDecision = {
    runs: false, error: "attachment_failed",
    message: "An attachment could not be prepared for the composer.",
  };
  if (input.renderer === "web") return refused;
  const path = String(input.path ?? "").trim();
  if (path === "") return refused;
  if (!path.startsWith("/") && !path.startsWith("file://")) return refused;
  if (input.exists === false) return refused;
  if (input.insideRoots === false) return refused;
  return COMPOSE_ALLOWED;
}
