//
//  spotlight.ts — the SHARED PURE CORE behind Core/Spotlight (F17.7): what an OS-searchable
//  item IS, decided once and run identically by all three renderers.
//
//  THE ROUND TRIP IS THE PRODUCT. Indexing content into the system search field is only half
//  the feature; the half that matters is the TAP, which arrives as an opaque identifier the app
//  has to turn back into a route. Core Spotlight calls that identifier `uniqueIdentifier`,
//  AppSearch calls it a namespaced document id, and if each platform invented its own encoding
//  then a deep link that worked on iOS would 404 on Android. So the encoding lives here, the
//  round trip is corpus-pinned, and `Mandatory/PushRouting` receives the same route either way.
//
//  THE BATCH SIZE IS ALSO A SHARED DECISION, not a platform detail: both indexers degrade badly
//  on a single huge transaction (Core Spotlight silently drops the tail, AppSearch throws), and
//  an app that indexes 5,000 notes at first launch must chunk. Chunking identically on both
//  means one progress bar and one resumable cursor.
//
//  WHAT IS DELIBERATELY NOT HERE: the index itself, the thumbnails, and any decision about WHEN
//  to index. Those are the module's job and the app's job respectively.
//
//  Pinned by OpenSource/Conformance/spotlight/index.json.
//

/** Both indexers degrade on a single huge transaction. 100 is the chunk both handle reliably. */
export const SPOTLIGHT_BATCH_MAX = 100;

/** Longer than this and the identifier stops fitting comfortably in either platform's index. */
export const SPOTLIGHT_MAX_ID_CHARS = 256;
export const SPOTLIGHT_MAX_TITLE_CHARS = 256;
export const SPOTLIGHT_MAX_DESCRIPTION_CHARS = 2000;
/** Beyond this, keyword matching gets worse rather than better on both platforms. */
export const SPOTLIGHT_MAX_KEYWORDS = 32;

export type SpotlightRefusal =
  | "invalid_id"
  | "invalid_title"
  | "invalid_route"
  | "invalid_domain"
  | "too_many_items";

export type SpotlightResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SpotlightRefusal; detail?: string };

function fail<T>(error: SpotlightRefusal, detail?: string): SpotlightResult<T> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

export interface SearchItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
  /** an absolute or app-relative image reference the module resolves to a thumbnail, or "" */
  readonly image: string;
  /** the in-app route a tap opens, always leading-slash */
  readonly route: string;
  /** the grouping the OS shows and `clear({ domain })` removes as a unit */
  readonly domain: string;
  /** epoch milliseconds after which the OS may drop the item, or 0 for "no expiry" */
  readonly expires: number;
}

function hasControlCharacter(text: string): boolean {
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A domain groups items so `clear({ domain })` can remove a whole feature's index at once.
 *
 * It may not contain a colon, and that is load-bearing rather than fussy: the unique identifier
 * is `<domain>:<id>` split at the FIRST colon, which is what lets an id contain colons freely
 * (a URL, a compound key) while the round trip stays exact.
 */
export function normalizeSearchDomain(raw: unknown): SpotlightResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return { ok: true, value: "default" };
  if (text.includes(":")) {
    return fail("invalid_domain", "a domain cannot contain a colon; it is the separator");
  }
  if (text.length > 64) return fail("invalid_domain", "a domain is at most 64 characters");
  if (hasControlCharacter(text)) return fail("invalid_domain", "a domain holds no control characters");
  return { ok: true, value: text };
}

/** `<domain>:<id>`. The one encoding both platforms use, so a tap resolves the same route. */
export function searchUniqueId(domain: string, id: string): string {
  return `${domain}:${id}`;
}

/** The inverse. Split at the FIRST colon, so an id containing colons round-trips exactly. */
export function parseSearchUniqueId(raw: unknown): { domain: string; id: string } | null {
  const text = String(raw ?? "").trim();
  const colon = text.indexOf(":");
  if (colon <= 0 || colon === text.length - 1) return null;
  return { domain: text.slice(0, colon), id: text.slice(colon + 1) };
}

/** Keywords are trimmed, lowercased, deduped and capped. Case folding matters: both indexers
 *  match case-insensitively, so keeping "Recipe" and "recipe" as two entries spends the cap on
 *  nothing. */
export function normalizeSearchKeywords(raw: unknown): readonly string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
  const out: string[] = [];
  for (const entry of list) {
    const word = String(entry ?? "").trim().toLowerCase();
    if (word.length === 0) continue;
    if (out.includes(word)) continue;
    out.push(word);
    if (out.length >= SPOTLIGHT_MAX_KEYWORDS) break;
  }
  return out;
}

export interface RawSearchItem {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  keywords?: unknown;
  image?: unknown;
  route?: unknown;
  domain?: unknown;
  expires?: unknown;
}

/**
 * Validate and normalize one indexable item.
 *
 * THE ROUTE IS REQUIRED AND MUST BE ABSOLUTE. An indexed item with no route is worse than no
 * item at all: it appears in the OS search field, the user taps it, and the app opens on its
 * home screen with no explanation. Refusing at index time is the only place that failure can
 * still be fixed.
 */
export function normalizeSearchItem(raw: RawSearchItem): SpotlightResult<SearchItem> {
  const id = String(raw.id ?? "").trim();
  if (id.length === 0) return fail("invalid_id", "an item needs an id");
  if (id.length > SPOTLIGHT_MAX_ID_CHARS) {
    return fail("invalid_id", `an id is at most ${SPOTLIGHT_MAX_ID_CHARS} characters`);
  }
  if (hasControlCharacter(id)) return fail("invalid_id", "an id holds no control characters");

  const title = String(raw.title ?? "").trim();
  if (title.length === 0) return fail("invalid_title", "an item needs a title to show");
  if (title.length > SPOTLIGHT_MAX_TITLE_CHARS) {
    return fail("invalid_title", `a title is at most ${SPOTLIGHT_MAX_TITLE_CHARS} characters`);
  }

  const domain = normalizeSearchDomain(raw.domain);
  if (domain.ok !== true) return fail(domain.error, domain.detail);

  const route = String(raw.route ?? "").trim();
  if (route.length === 0) {
    return fail("invalid_route", "an indexed item needs the route its tap opens");
  }
  if (!route.startsWith("/")) {
    return fail("invalid_route", "a route is absolute, starting with /");
  }
  if (hasControlCharacter(route)) return fail("invalid_route", "a route holds no control characters");

  const description = String(raw.description ?? "").trim().slice(0, SPOTLIGHT_MAX_DESCRIPTION_CHARS);
  const image = String(raw.image ?? "").trim();

  let expires = 0;
  if (raw.expires !== undefined && raw.expires !== null) {
    const n = typeof raw.expires === "number" ? raw.expires : Number(raw.expires);
    // A non-numeric or negative expiry means "no expiry" rather than an error: an item that
    // refuses to index because a timestamp was malformed is a worse outcome than one that
    // simply never expires.
    expires = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  return {
    ok: true,
    value: {
      id, title, description,
      keywords: normalizeSearchKeywords(raw.keywords),
      image, route, domain: domain.value, expires,
    },
  };
}

/** Validate a whole batch, refusing on the FIRST bad item with its index in the detail: a
 *  partial index is the hardest state to reason about, so the batch is all-or-nothing. */
export function normalizeSearchItems(raw: unknown): SpotlightResult<readonly SearchItem[]> {
  const list = Array.isArray(raw) ? raw : [];
  const out: SearchItem[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const one = normalizeSearchItem(list[i] as RawSearchItem);
    if (one.ok !== true) return fail(one.error, `item ${i}: ${one.detail ?? one.error}`);
    out.push(one.value);
  }
  return { ok: true, value: out };
}

/** Split a batch into transactions both indexers handle reliably. */
export function chunkSearchItems<T>(items: readonly T[], max: number = SPOTLIGHT_BATCH_MAX): T[][] {
  const size = max > 0 ? Math.floor(max) : SPOTLIGHT_BATCH_MAX;
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Human copy for each refusal, so three renderers apologise with one sentence. */
export const SPOTLIGHT_MESSAGES: Readonly<Record<SpotlightRefusal, string>> = {
  invalid_id: "That is not a usable item id.",
  invalid_title: "Every indexed item needs a title the OS can show.",
  invalid_route: "Every indexed item needs the absolute route its tap opens.",
  invalid_domain: "That is not a usable index domain.",
  too_many_items: "That is more items than one call can index.",
};
