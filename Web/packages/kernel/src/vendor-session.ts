//
//  vendor-session.ts — THE INLINE-VENDOR-SURFACE PURE CORE (V01,
//  architecture/proposals/inline-native-surfaces.md). Four folds, one law each:
//
//    1. resolveSessionRef  — the SECRET BOUNDARY. An attribute whose declared `role` is
//       "secret" carries a REFERENCE to a module-held session, never the session. Markup
//       travels over OTA into the content plane, so a literal here is a credential on a
//       CDN. The rule is an ALLOWLIST OF REFERENCE SHAPES, not a denylist of key prefixes:
//       a denylist is bypassable by any key format the vendor ships next quarter, an
//       allowlist fails closed. Credential detection exists only to make the REFUSAL
//       MESSAGE name the danger; it never decides whether a value is accepted.
//    2. VendorSessionMachine — ONE SESSION, TWO VIEWS. The overlay face (the vendor's
//       presented sheet) and the component face (the vendor's view inline) are two views
//       onto one state machine. Two state machines that disagree is a DOUBLE CHARGE, so
//       a second `start` while one is in flight is refused, and every outcome notifies
//       both faces including a face that already detached.
//    3. cardFieldFold — the field-validity fold. The vendor owns validation (Luhn, expiry,
//       brand); this folds its per-part verdicts into ONE form field so a vendor input
//       joins <form> validity through the SAME forms.ts aggregation every other field
//       uses. It never sees, carries or re-derives card data — that is the PCI boundary.
//    4. vendorRetainKey / vendorRetainReconcile — the keyed-identity law (SceneBind:
//       "keys keeping their instantiated subtree — identity survives reorder") applied to
//       an expensive, stateful vendor view: same key = same live view, across any
//       unrelated re-render or reorder.
//
//  The law is the corpus, OpenSource/Conformance/inline-surfaces/stripe.json; the Kotlin twin is
//  :core VendorSession.kt and the Swift twin is Engine/iOS/VendorSession.swift.
//
//  PURE by construction: no DOM, no RegExp, no imports, no vendor SDK. Everything a
//  renderer needs is a function of its arguments — which is what lets one corpus judge
//  three runtimes, and what lets the security rule be tested without a payment processor.
//

// ─────────────────────────────────────────────────────────────────────────────
// 1 · THE SECRET BOUNDARY — a role:"secret" attribute takes a reference, never a value
// ─────────────────────────────────────────────────────────────────────────────

/** Which reference plane the attribute names. `implicit` = the attribute was omitted, so
 *  the component binds its owning module's CURRENT session (the canonical spelling). */
export type SessionRefKind =
  | "implicit" | "module-context" | "store-var" | "global" | "config" | "attribute" | "scope";

/** Why a reference was refused. Every one is LOUD: a secret attribute that silently
 *  accepted a literal would ship the literal. */
export type SessionRefRefusal =
  | "missing_reference"     // present but empty — an author wrote session="" 
  | "literal_secret"        // a real-looking vendor credential, anywhere in the value
  | "literal_value"         // a literal that is not a recognized credential — still refused
  | "compound_template"     // more than one {{ }}, or text around it
  | "unknown_reference";    // a dotted path whose root is not a permitted plane

/** The credential family a refusal names, so the linter can say WHICH secret leaked. */
export type SecretFamily =
  | "secret_key" | "restricted_key" | "client_secret"
  | "webhook_secret" | "ephemeral_key" | "publishable_key" | "jwt";

export type SessionRef = Readonly<{ kind: SessionRefKind; path: string }>;

export type SessionRefResolution =
  | { readonly ok: true; readonly value: SessionRef }
  | { readonly ok: false; readonly error: SessionRefRefusal; readonly family?: SecretFamily };

/** The transitional alias: `.state.` and `.context.` are ONE plane, normalized to
 *  `context` so a corpus row cannot mean two things. */
const CONTEXT_PLANES = ["context", "state"];

function isWordChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isIdentStart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}
function isIdentChar(ch: string): boolean { return isIdentStart(ch) || (ch >= "0" && ch <= "9"); }

/** A token of `prefix` + at least `minTail` token characters, not glued to a word on the
 *  left. Hand-scanned rather than a RegExp so all three runtimes agree character for
 *  character (a `\b` is not the same thing in three regex engines). */
function hasKeyToken(text: string, prefix: string, minTail: number): boolean {
  for (let i = 0; i + prefix.length <= text.length; i += 1) {
    if (!text.startsWith(prefix, i)) continue;
    if (i > 0 && isWordChar(text[i - 1]!)) continue;
    let tail = 0;
    let j = i + prefix.length;
    while (j < text.length && isWordChar(text[j]!)) { tail += 1; j += 1; }
    if (tail >= minTail) return true;
  }
  return false;
}

/** `pi_..._secret_...` / `seti_..._secret_...` / `cs_..._secret_...` — the client secret,
 *  which is the one people paste into markup because it is "not the secret key". */
function hasClientSecret(text: string): boolean {
  const marker = "_secret_";
  for (let i = 0; i + marker.length <= text.length; i += 1) {
    if (!text.startsWith(marker, i)) continue;
    if (i + marker.length >= text.length || !isWordChar(text[i + marker.length]!)) continue;
    let start = i;
    while (start > 0 && isWordChar(text[start - 1]!)) start -= 1;
    const head = text.slice(start, i);
    if (head.startsWith("pi_") || head.startsWith("seti_") || head.startsWith("cs_") || head.startsWith("src_")) {
      return true;
    }
  }
  return false;
}

/** The credential family in `text`, MOST DANGEROUS FIRST — the order the message uses. */
/** `eyJ...` with exactly two dots and three non-trivial segments: a JWT, which is what a
 *  Stream user token and a Clerk session token both are. Already REFUSED without this (it
 *  parses as a dotted path with an unpermitted root), so this only sharpens the message from
 *  "unknown_reference" to naming the credential the author pasted. Hand-scanned like the rest,
 *  so three runtimes agree character for character. */
function hasJwt(text: string): boolean {
  if (!text.startsWith("eyJ")) return false;
  let dots = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === ".") { if (run < 8) return false; dots += 1; run = 0; continue; }
    if (!isWordChar(ch) && ch !== "-") return false;
    run += 1;
  }
  return dots === 2 && run >= 8;
}

export function secretFamilyIn(text: string): SecretFamily | null {
  if (hasKeyToken(text, "sk_", 8)) return "secret_key";
  if (hasKeyToken(text, "rk_", 8)) return "restricted_key";
  if (hasClientSecret(text)) return "client_secret";
  if (hasKeyToken(text, "whsec_", 8)) return "webhook_secret";
  if (hasKeyToken(text, "ek_", 8)) return "ephemeral_key";
  if (hasKeyToken(text, "pk_", 8)) return "publishable_key";
  if (hasJwt(text)) return "jwt";
  return null;
}

function splitPath(expression: string): string[] | null {
  if (expression.length === 0) return null;
  const parts = expression.split(".");
  for (const part of parts) {
    if (part.length === 0 || !isIdentStart(part[0]!)) return null;
    for (const ch of part) if (!isIdentChar(ch)) return null;
  }
  return parts;
}

/** The ALLOWLIST. A permitted reference is one of these shapes and nothing else. */
function referenceKind(segments: readonly string[]): SessionRef | null {
  if (segments[0] === "dsx" && segments[1] === "module" && segments.length >= 5) {
    for (let i = 3; i <= segments.length - 2; i += 1) {
      if (!CONTEXT_PLANES.includes(segments[i]!)) continue;
      const chain = segments.slice(2, i).join(".");
      const member = segments.slice(i + 1).join(".");
      return { kind: "module-context", path: `dsx.module.${chain}.context.${member}` };
    }
    return null;
  }
  const path = segments.join(".");
  if (segments[0] === "dsx" && segments.length >= 3) {
    if (segments[1] === "variable") return { kind: "store-var", path };
    if (segments[1] === "global") return { kind: "global", path };
    if (segments[1] === "config") return { kind: "config", path };
    if (segments[1] === "attribute") return { kind: "attribute", path };
    if (segments[1] === "this") return { kind: "scope", path };
  }
  if (segments[0] === "item" && segments.length >= 2) return { kind: "scope", path };
  return null;
}

/**
 * Resolve what a `role: "secret"` attribute carries.
 *
 * `null`/`undefined` (the attribute omitted) is the CANONICAL spelling: the component
 * binds its owning module's current session, so the markup names no session at all.
 * A present value must be exactly one reference — bare (`dsx.module.stripe.context.session`)
 * or a single whole-value interpolation (`{{ dsx.variable.checkout }}`). Everything else
 * is refused, and a refusal that contains a real-looking credential says which one.
 */
export function resolveSessionRef(raw: string | null | undefined): SessionRefResolution {
  if (raw === null || raw === undefined) return { ok: true, value: { kind: "implicit", path: "" } };
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: "missing_reference" };

  let expression = text;
  const open = text.indexOf("{{");
  if (open >= 0) {
    const close = text.indexOf("}}");
    if (open !== 0 || close !== text.length - 2 || close < open
        || text.indexOf("{{", open + 2) >= 0 || text.indexOf("}}", open + 2) !== close) {
      const family = secretFamilyIn(text);
      return family === null ? { ok: false, error: "compound_template" } : { ok: false, error: "literal_secret", family };
    }
    expression = text.slice(2, close).trim();
    if (expression.length === 0) return { ok: false, error: "missing_reference" };
  }

  const segments = splitPath(expression);
  if (segments !== null) {
    const ref = referenceKind(segments);
    if (ref !== null) return { ok: true, value: ref };
  }

  const family = secretFamilyIn(expression);
  if (family !== null) return { ok: false, error: "literal_secret", family };
  if (segments !== null) return { ok: false, error: "unknown_reference" };
  return { ok: false, error: "literal_value" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · ONE SESSION, TWO VIEWS
// ─────────────────────────────────────────────────────────────────────────────

/** The two faces a capability with a UI exposes. Canonical order — every `notify` list
 *  is emitted in it, so an audience cannot mean one thing on one renderer. */
export const VENDOR_VIEWS: readonly string[] = ["overlay", "inline"];

export type VendorView = "overlay" | "inline";

export type VendorSessionState =
  | "idle"         // no session — the module has not been handed one yet
  | "ready"        // a session exists and can take an attempt
  | "confirming"   // an attempt is in flight, from exactly ONE view
  | "succeeded"    // terminal
  | "failed"       // NOT terminal: a failed attempt leaves the intent reusable (see the build log)
  | "canceled";    // terminal — the session was abandoned

export type VendorStepRefusal =
  | "already_open"    // open on a session that already exists
  | "not_ready"       // an attempt before the module handed over a session
  | "busy"            // THE DOUBLE-CHARGE GUARD: a second attempt while one is in flight
  | "settled"         // the session reached a terminal state; mint a new one
  | "not_confirming"  // an outcome for an attempt that is not running
  | "detached_view";  // an attempt from a view that is not attached

export type VendorOutcome = "succeeded" | "failed" | "canceled";

export type VendorStep =
  | { readonly op: "open" }
  | { readonly op: "attach"; readonly view: VendorView }
  | { readonly op: "detach"; readonly view: VendorView }
  | { readonly op: "start"; readonly view: VendorView }
  | { readonly op: "complete" }
  | { readonly op: "fail"; readonly code?: string }
  | { readonly op: "cancel"; readonly view?: VendorView };

export type VendorStepResult =
  | {
      readonly ok: true;
      readonly state: VendorSessionState;
      /** Every face that must be told, in canonical order — INCLUDING a detached
       *  originator, whose promise is still owed a settle. */
      readonly notify: readonly VendorView[];
      readonly attempts: number;
      readonly outcome?: VendorOutcome;
      readonly by?: VendorView;
      readonly code?: string;
    }
  | { readonly ok: false; readonly error: VendorStepRefusal; readonly state: VendorSessionState };

/**
 * The module's session, seen by both faces.
 *
 * The action face presents the vendor modal OVER this session; the component face renders
 * the vendor view INTO the layout for the same session. Starting with one and finishing
 * with the other is coherent because there is only this object.
 */
export class VendorSessionMachine {
  #state: VendorSessionState = "idle";
  #attached: VendorView[] = [];
  #by: VendorView | null = null;
  #attempts = 0;

  get state(): VendorSessionState { return this.#state; }
  get attempts(): number { return this.#attempts; }
  /** The face whose attempt is in flight, or null. */
  get confirmingView(): VendorView | null { return this.#by; }
  get attached(): readonly VendorView[] {
    return VENDOR_VIEWS.filter((v) => this.#attached.includes(v as VendorView)) as VendorView[];
  }

  /** Attached faces plus the in-flight originator, canonically ordered. A face that
   *  unmounted mid-confirm is STILL owed its outcome — dropping it is how an app charges
   *  a card and never tells the user. */
  #audience(): VendorView[] {
    const live = new Set<VendorView>(this.#attached);
    if (this.#by !== null) live.add(this.#by);
    return VENDOR_VIEWS.filter((v) => live.has(v as VendorView)) as VendorView[];
  }

  #settled(): boolean { return this.#state === "succeeded" || this.#state === "canceled"; }

  #ok(notify: readonly VendorView[], extra: Partial<VendorStepResult> = {}): VendorStepResult {
    return { ok: true, state: this.#state, notify, attempts: this.#attempts, ...extra } as VendorStepResult;
  }
  #no(error: VendorStepRefusal): VendorStepResult {
    return { ok: false, error, state: this.#state };
  }

  step(step: VendorStep): VendorStepResult {
    switch (step.op) {
      case "open":
        if (this.#state !== "idle") return this.#no(this.#settled() ? "settled" : "already_open");
        this.#state = "ready";
        return this.#ok(this.#audience());

      case "attach":
        if (!this.#attached.includes(step.view)) this.#attached.push(step.view);
        return this.#ok([]);

      // Detaching NEVER cancels. A vendor view that unmounts on an unrelated re-render
      // must not abandon an authorization in flight.
      case "detach":
        this.#attached = this.#attached.filter((v) => v !== step.view);
        return this.#ok([]);

      case "start": {
        if (this.#state === "idle") return this.#no("not_ready");
        if (this.#settled()) return this.#no("settled");
        if (this.#state === "confirming") return this.#no("busy");
        if (!this.#attached.includes(step.view)) return this.#no("detached_view");
        this.#state = "confirming";
        this.#by = step.view;
        this.#attempts += 1;
        return this.#ok(this.#audience(), { by: step.view });
      }

      case "complete": {
        if (this.#state !== "confirming") return this.#no(this.#settled() ? "settled" : "not_confirming");
        const by = this.#by!;
        const audience = this.#audience();
        this.#state = "succeeded";
        this.#by = null;
        return this.#ok(audience, { outcome: "succeeded", by });
      }

      case "fail": {
        if (this.#state !== "confirming") return this.#no(this.#settled() ? "settled" : "not_confirming");
        const by = this.#by!;
        const audience = this.#audience();
        this.#state = "failed";
        this.#by = null;
        return this.#ok(audience, { outcome: "failed", by, code: step.code ?? "card_declined" });
      }

      // Dismissing the sheet cancels the ATTEMPT, not the session: the intent stays
      // reusable, which is what the vendor SDK actually does. Cancelling with no attempt
      // in flight abandons the session, and that IS terminal.
      case "cancel": {
        if (this.#settled()) return this.#no("settled");
        if (this.#state === "idle") return this.#no("not_ready");
        if (this.#state === "confirming") {
          const by = this.#by!;
          const audience = this.#audience();
          this.#state = "ready";
          this.#by = null;
          return this.#ok(audience, { outcome: "canceled", by });
        }
        const audience = this.#audience();
        this.#state = "canceled";
        return this.#ok(audience, { outcome: "canceled", ...(step.view === undefined ? {} : { by: step.view }) });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · THE FIELD-VALIDITY FOLD — a vendor input joins <form> validity
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical part order: the order the vendor's own field traverses, and the order the
 *  fold reports the FIRST offender in. */
export const CARD_PARTS: readonly string[] = ["number", "expiry", "cvc", "postalCode"];

/** One part as the VENDOR reports it. `error` is the vendor's own message and is carried
 *  through verbatim — re-wording it is the text twin of relabelling its a11y tree. */
export type CardPartState = Readonly<{
  part: string;
  empty?: boolean;
  complete?: boolean;
  error?: string;
}>;

/** The incomplete messages, one per part. Data, so three runtimes cannot word them
 *  differently; pinned in the corpus. */
export const CARD_INCOMPLETE_MESSAGES: Readonly<Record<string, string>> = {
  number: "Your card number is incomplete.",
  expiry: "Your card's expiration date is incomplete.",
  cvc: "Your card's security code is incomplete.",
  postalCode: "Your postal code is incomplete.",
};

export const CARD_REQUIRED_MESSAGE = "Required";

export type CardFieldFold = Readonly<{
  /** every declared part reports complete */
  complete: boolean;
  /** no part carries an error and every declared part is complete */
  valid: boolean;
  /** nothing has been typed into any part yet */
  pristine: boolean;
  /** the message the form shows, or "" */
  error: string;
  /** the part that owns `error`, or "" */
  offender: string;
  /** what a <form> aggregates — never card data: "complete" or "". THE PCI BOUNDARY. */
  value: string;
}>;

/**
 * Fold the vendor's per-part verdicts into ONE form field.
 *
 * Precedence: a vendor ERROR beats an incomplete part (the vendor knows "4242…4241 is not
 * a card"; the fold only knows "not finished"), and within each tier the first part in
 * canonical order owns the message. A pristine, non-required field is valid and silent —
 * a card form that shouts before it is touched is the bug users report as "broken".
 */
export function cardFieldFold(
  parts: readonly CardPartState[],
  required: boolean = true,
): CardFieldFold {
  const declared = CARD_PARTS.filter((p) => parts.some((s) => s.part === p));
  const at = (part: string): CardPartState | undefined => parts.find((s) => s.part === part);

  const pristine = declared.length > 0 && declared.every((p) => (at(p)!.empty ?? true) === true);
  const complete = declared.length > 0 && declared.every((p) => at(p)!.complete === true);

  for (const part of declared) {
    const message = at(part)!.error ?? "";
    if (message !== "") {
      return { complete, valid: false, pristine, error: message, offender: part, value: "" };
    }
  }
  if (complete) return { complete: true, valid: true, pristine: false, error: "", offender: "", value: "complete" };
  if (pristine) {
    return required
      ? { complete: false, valid: false, pristine: true, error: CARD_REQUIRED_MESSAGE, offender: declared[0] ?? "", value: "" }
      : { complete: false, valid: true, pristine: true, error: "", offender: "", value: "" };
  }
  for (const part of declared) {
    if (at(part)!.complete !== true) {
      return {
        complete: false, valid: false, pristine: false,
        error: CARD_INCOMPLETE_MESSAGES[part] ?? CARD_REQUIRED_MESSAGE, offender: part, value: "",
      };
    }
  }
  return { complete, valid: false, pristine, error: CARD_REQUIRED_MESSAGE, offender: declared[0] ?? "", value: "" };
}

/** The `forms.ts` FormFieldState this fold produces, so a vendor input rides the SAME
 *  `formsAggregate` / `formsSubmit` path as `<field>` — one validity system, not two. */
export function cardFormField(name: string, fold: CardFieldFold): {
  name: string; value: string; initial: string; validate: string; message: string;
} {
  return {
    name,
    value: fold.value,
    initial: "",
    validate: fold.error === "" ? "" : "required",
    message: fold.error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · KEYED IDENTITY — an expensive vendor view survives an unrelated re-render
// ─────────────────────────────────────────────────────────────────────────────

export type VendorRetainInput = Readonly<{
  /** the resolved tag, e.g. "stripe.CardInput" */
  tag: string;
  /** the author's `key=`, when they gave one */
  key?: string | null;
  /** the resolved session reference path ("" for the implicit session) */
  session?: string | null;
  /** the position of this instance among its siblings — the fallback identity */
  index?: number;
}>;

/**
 * The identity a vendor view is retained under.
 *
 * An explicit `key=` wins outright, so an author can keep one live field across a list
 * reorder. Without one the identity is tag + session + position: two `<stripe.CardInput/>`
 * on the same session are distinguishable, and the same one at the same position across an
 * unrelated re-render is the SAME view. The key is never the session VALUE — that would
 * put a secret in a diff log.
 */
export function vendorRetainKey(input: VendorRetainInput): string {
  const explicit = (input.key ?? "").trim();
  if (explicit !== "") return `${input.tag}#${explicit}`;
  const session = (input.session ?? "").trim();
  return `${input.tag}@${session}[${input.index ?? 0}]`;
}

/** The reconcile verdict — deliberately the SceneBind shape, because it is the same law. */
export type VendorRetainDiff = Readonly<{
  mounted: readonly string[];
  retained: readonly string[];
  released: readonly string[];
}>;

/** A key present on both sides keeps its live vendor view across ANY reorder; a new key
 *  mounts; a vanished key releases. Pure — the caller owns the actual views. */
export function vendorRetainReconcile(
  previous: readonly string[],
  next: readonly string[],
): VendorRetainDiff {
  const before = new Set(previous);
  const now = new Set(next);
  const mounted: string[] = [];
  const retained: string[] = [];
  const released: string[] = [];
  const seen = new Set<string>();
  for (const key of next) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (before.has(key)) retained.push(key); else mounted.push(key);
  }
  for (const key of previous) if (!now.has(key) && !released.includes(key)) released.push(key);
  return { mounted, retained, released };
}
