//
//  contacts-core.ts — the shared Core/Contacts core: the permission surface, the paging
//  arithmetic, the read/write access decisions, the label vocabulary and the picker fold. The
//  law is the corpus, OpenSource/Conformance/contacts/{crud,pick}.json (parity F12); the Kotlin
//  twin is :core ContactsCore.kt and the Swift twin is Engine/iOS/ContactsCore.swift.
//
//  Everything platform-shaped lives OUTSIDE this file: CNContactStore, ContactsContract and
//  navigator.contacts are per-renderer plumbing. What is pinned here is the part that must be
//  IDENTICAL on all three — how far a page reaches, what a grant permits, what a label is
//  called, and what the picker hands back.
//

/** The shared label vocabulary. A platform constant folds into one of these five, never leaks. */
export const CONTACT_LABELS: readonly string[] = ["home", "work", "mobile", "main", "other"];

/** A contact with no name at all still needs something to render. */
export const CONTACT_UNNAMED = "Unnamed Contact";

/** One page may never fetch the world, and may never be unbounded. */
export const CONTACT_MAX_PAGE = 500;

/**
 * Which grant each action requires before it will run.
 *
 * `none` is the CONTRACT, not an implementation detail: an action listed as `none` that starts
 * prompting is a regression, and an action listed as read/write that stops refusing is a
 * privacy bug. `pick` is `none` on every renderer because the user hand-picks and the OS
 * returns only what was picked.
 */
export const CONTACTS_PERMISSION_SURFACE: { readonly [action: string]: string } = {
  pick: "none",
  permission: "none",
  list: "read",
  get: "read",
  groups: "read",
  add: "write",
  update: "write",
  remove: "write",
  read: "read",
};

/** The refusal messages. A caller that cannot find the fix retries the same call forever, so
 *  each one names the specific escalation that would work. */
export const CONTACTS_READ_REFUSAL =
  'Contacts access has not been granted. Call dsx.module.contacts.permission with level "read" '
  + "first, or use dsx.module.contacts.pick, which needs no permission.";
export const CONTACTS_WRITE_REFUSAL =
  'Writing contacts has not been granted. Call dsx.module.contacts.permission with level "write" first.';
export const CONTACTS_RESTRICTED_MESSAGE = "Contacts access is restricted on this device.";
export const CONTACTS_INVALID_MESSAGE =
  "A contact needs at least one of displayName, givenName, familyName, phones or emails.";

/** A limit past the cap clamps rather than fetching the world; zero or negative clamps to 1,
 *  never to unbounded. */
export function clampContactLimit(requested: number | null | undefined, fallback: number): number {
  const raw = requested === null || requested === undefined || Number.isNaN(Number(requested))
    ? fallback
    : Math.trunc(Number(requested));
  return Math.min(Math.max(raw, 1), CONTACT_MAX_PAGE);
}

/** What one `list` page reports. */
export interface ContactPage {
  readonly returned: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

/**
 * The paging arithmetic — the same on all three renderers even though the underlying cursor is
 * not (an enumeration offset on iOS, a SQL LIMIT/OFFSET on Android).
 *
 * `endCursor` is present only when there IS a next page, so a caller that loops until the cursor
 * is absent terminates instead of asking for an empty page forever.
 */
export function contactPage(total: number, limit: number | null | undefined, offset: number): ContactPage {
  const size = clampContactLimit(limit, CONTACT_MAX_PAGE);
  const start = Math.max(0, Math.trunc(offset));
  const returned = Math.max(0, Math.min(size, Math.trunc(total) - start));
  return contactCollectedPage(start, returned, start + returned < Math.trunc(total));
}

/** The same page, reported by a store that ENUMERATED rather than counted: neither CNContactStore
 *  nor a content-provider query knows the total, but both learn whether one more row exists.
 *  `contactPage` is defined in terms of this, so the corpus judges the code the modules call. */
export function contactCollectedPage(offset: number, returned: number, sawMore: boolean): ContactPage {
  const start = Math.max(0, Math.trunc(offset));
  const count = Math.max(0, Math.trunc(returned));
  return { returned: count, hasNextPage: sawMore, endCursor: sawMore ? String(start + count) : null };
}

/** A refusal or a go-ahead, in the shape every action reports. */
export interface ContactsDecision {
  readonly runs: boolean;
  /** The access word to report alongside a successful read: "granted" or "limited". */
  readonly access: string | null;
  readonly error: string | null;
  readonly message: string | null;
  readonly recoverable: boolean;
  /** Always false: no action in this module prompts on the caller's behalf. */
  readonly prompted: boolean;
}

function allow(access: string): ContactsDecision {
  return { runs: true, access, error: null, message: null, recoverable: true, prompted: false };
}

function refuse(error: string, message: string, recoverable: boolean): ContactsDecision {
  return { runs: false, access: null, error, message, recoverable, prompted: false };
}

/**
 * Can a read run, and what does it report?
 *
 * `limited` (iOS 17+ limited contact access) is a REAL GRANT over a shared subset, not a soft
 * denial: the read runs and reports access:"limited" rather than pretending it enumerated the
 * book. `restricted` is a device-policy denial and is NOT recoverable by asking again.
 */
export function contactReadDecision(access: string | null | undefined): ContactsDecision {
  switch (String(access ?? "").trim()) {
    case "granted": return allow("granted");
    case "limited": return allow("limited");
    case "restricted": return refuse("restricted", CONTACTS_RESTRICTED_MESSAGE, false);
    default: return refuse("permission_denied", CONTACTS_READ_REFUSAL, true);
  }
}

/** How many rows a read may see: the whole book on a full grant, the shared subset on a limited
 *  one, and nothing at all when the read did not run. */
export function contactReadCount(access: string | null | undefined, shared: number, total: number): number {
  const decision = contactReadDecision(access);
  if (!decision.runs) return 0;
  return decision.access === "limited" ? Math.max(0, shared) : Math.max(0, total);
}

/** At least one of these makes a contact worth saving; an empty object is refused before any
 *  store call. */
export function isMeaningfulContact(contact: { [key: string]: unknown } | null | undefined): boolean {
  if (contact === null || contact === undefined) return false;
  for (const key of ["displayName", "givenName", "familyName"]) {
    const value = contact[key];
    if (typeof value === "string" && value.trim() !== "") return true;
  }
  for (const key of ["phones", "emails"]) {
    const value = contact[key];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

/**
 * Can a write run?
 *
 * A limited read grant carries NO write right, and the refusal names the WRITE level
 * specifically — a caller told to ask for "read" again would loop. Validity is checked after
 * permission, so an unauthorised caller never learns whether its payload was well-formed.
 */
export function contactWriteDecision(
  access: string | null | undefined,
  contact?: { [key: string]: unknown } | null,
): ContactsDecision {
  const word = String(access ?? "").trim();
  if (word === "restricted") return refuse("restricted", CONTACTS_RESTRICTED_MESSAGE, false);
  if (word !== "granted") return refuse("permission_denied", CONTACTS_WRITE_REFUSAL, true);
  if (contact !== undefined && !isMeaningfulContact(contact)) {
    return refuse("invalid_contact", CONTACTS_INVALID_MESSAGE, true);
  }
  return allow("granted");
}

/** A platform label to the shared vocabulary. Apple wraps its constants as `_$!<Word>!$_`;
 *  Android hands over its own word already. Anything unrecognised is `other`, never a guess. */
export function normalizeContactLabel(raw: string | null | undefined): string {
  let text = String(raw ?? "").trim();
  const wrapped = /^_\$!<(.+)>!\$_$/.exec(text);
  if (wrapped !== null) text = wrapped[1]!;
  switch (text.toLowerCase()) {
    case "home": return "home";
    case "work": return "work";
    case "mobile": case "iphone": case "cell": return "mobile";
    case "main": return "main";
    default: return "other";
  }
}

/** A birthday is an ISO date, never a locale string. */
export function contactBirthday(
  year: number | null | undefined,
  month: number | null | undefined,
  day: number | null | undefined,
): string | null {
  if (year === null || year === undefined || month === null || month === undefined
      || day === null || day === undefined) return null;
  const pad = (value: number, width: number) => String(Math.trunc(value)).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** A nameless contact still has a display name. `formatted` is the platform's own full-name
 *  rendering where it has one; the given/family join is the fallback. */
export function contactDisplayName(
  givenName: string | null | undefined,
  familyName: string | null | undefined,
  formatted?: string | null,
): string {
  const platform = String(formatted ?? "").trim();
  if (platform !== "") return platform;
  const joined = `${String(givenName ?? "").trim()} ${String(familyName ?? "").trim()}`.trim();
  return joined === "" ? CONTACT_UNNAMED : joined;
}

/** `fields` subsets the hydrated shape and drops nothing else in: `id` always survives, and the
 *  requested fields keep the order the caller asked for. */
export function subsetContact(
  contact: { [key: string]: unknown },
  fields: readonly string[] | null | undefined,
): { [key: string]: unknown } {
  if (fields === null || fields === undefined || fields.length === 0) return { ...contact };
  const out: { [key: string]: unknown } = {};
  if ("id" in contact) out["id"] = contact["id"];
  for (const field of fields) {
    if (field !== "id" && field in contact) out[field] = contact[field];
  }
  return out;
}

/** What `pick` settles with. */
export interface ContactPickOutcome {
  readonly contacts: { [key: string]: unknown }[];
  readonly cancelled: boolean;
  /** Always false: the system picker needs no grant and must never raise one. */
  readonly prompted: boolean;
  /** false when the caller asked for multi-select and the platform has none; null otherwise. */
  readonly multiple: boolean | null;
  readonly error: string | null;
}

export interface ContactPickInput {
  readonly multiple?: boolean;
  readonly fields?: readonly string[] | null;
  readonly picked?: readonly { [key: string]: unknown }[] | null;
  readonly multiSelect?: boolean;
  readonly pickerAvailable?: boolean;
}

/**
 * The picker fold.
 *
 * A dismissal RESOLVES cancelled — the user declining is an outcome the caller branches on, not
 * an error it should log. A platform with no multi-select SAYS SO (`multiple: false`) rather
 * than quietly returning a one-element array, and a browser with no Contact Picker API refuses
 * in type rather than resolving an empty list.
 */
export function contactPickOutcome(input: ContactPickInput): ContactPickOutcome {
  if (input.pickerAvailable === false) {
    return { contacts: [], cancelled: false, prompted: false, multiple: null, error: "unsupported_platform" };
  }
  const degraded = input.multiple === true && input.multiSelect === false ? false : null;
  if (input.picked === null || input.picked === undefined) {
    return { contacts: [], cancelled: true, prompted: false, multiple: degraded, error: null };
  }
  return {
    contacts: input.picked.map((entry) => subsetContact(entry, input.fields)),
    cancelled: false,
    prompted: false,
    multiple: degraded,
    error: null,
  };
}
