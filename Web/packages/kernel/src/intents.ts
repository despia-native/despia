//
//  intents.ts — the SHARED PURE CORE behind Core/Intents (F17.6): what an Android intent
//  request IS, decided once and validated identically by all three renderers.
//
//  WHY A CORE FOR AN ANDROID-ONLY CAPABILITY. Two reasons, and neither is symmetry for its own
//  sake. First, the OTHER TWO RENDERERS HAVE TO REFUSE PRECISELY: a caller writing one code
//  path needs `launch({ action: "nonsense" })` to fail the same way everywhere, so validation
//  cannot live in the Android facet. Second, and more important, the `<queries>` GENERATOR is
//  build-time logic: Android 11 package visibility means an intent for a component the manifest
//  never declared silently resolves to nothing, and computing that block from the module's own
//  declarations is the difference between the feature working and it appearing to work in
//  development and failing on every real device.
//
//  THE FLAG NUMBERS ARE PINNED HERE, not read from android.content.Intent, because the corpus
//  has to be able to assert them on a runtime that has no Android SDK. They are ABI-frozen
//  constants: changing one would break every APK ever shipped, so hardcoding is safe in the
//  way that hardcoding a Unicode code point is safe.
//
//  Pinned by OpenSource/Conformance/intents/launch.json.
//

/** Word → the ABI-frozen `Intent` flag bit. Ordered as a reader would group them: task
 *  placement, history, then URI grants. */
export const INTENT_FLAGS: Readonly<Record<string, number>> = {
  newTask: 0x10000000,
  singleTop: 0x20000000,
  clearTop: 0x04000000,
  clearTask: 0x00008000,
  newDocument: 0x00080000,
  noHistory: 0x40000000,
  excludeFromRecents: 0x00800000,
  grantReadUri: 0x00000001,
  grantWriteUri: 0x00000002,
};

/** The canonical order a resolved flag list comes back in, so two equal requests compare equal. */
export const INTENT_FLAG_ORDER: readonly string[] = [
  "newTask", "singleTop", "clearTop", "clearTask", "newDocument",
  "noHistory", "excludeFromRecents", "grantReadUri", "grantWriteUri",
];

export type IntentRefusal =
  | "invalid_action"
  | "invalid_data"
  | "invalid_type"
  | "invalid_extras"
  | "invalid_package"
  | "unknown_flag";

export type IntentResult<T> = { ok: true; value: T } | { ok: false; error: IntentRefusal; detail?: string };

function fail<T>(error: IntentRefusal, detail?: string): IntentResult<T> {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

function foldKey(raw: unknown): string {
  return String(raw ?? "").toLowerCase().replace(/[\s\-_]/g, "");
}

/**
 * An intent action is a dotted constant name: `android.intent.action.VIEW`,
 * `android.settings.WIFI_SETTINGS`, or a vendor's own `com.example.DO_THING`.
 *
 * A BARE WORD IS REFUSED even though `Intent("VIEW")` compiles: it resolves to nothing at
 * runtime and the developer sees an empty chooser with no error, which is the single most
 * common way an intent launcher wastes an afternoon.
 */
export function normalizeIntentAction(raw: unknown): IntentResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return fail("invalid_action", "an action is required");
  if (!text.includes(".")) {
    return fail("invalid_action", "an action is a dotted constant, e.g. android.intent.action.VIEW");
  }
  for (const c of text) {
    const ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
      || c === "." || c === "_";
    if (!ok) return fail("invalid_action", text);
  }
  if (text.startsWith(".") || text.endsWith(".")) return fail("invalid_action", text);
  return { ok: true, value: text };
}

/** A package name is a dotted, lowercase-ish Java identifier chain. Same reasoning: a wrong one
 *  produces an empty result rather than an error. */
export function normalizeIntentPackage(raw: unknown): IntentResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return { ok: true, value: "" };
  if (!text.includes(".")) return fail("invalid_package", "a package name is dotted");
  for (const c of text) {
    const ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
      || c === "." || c === "_";
    if (!ok) return fail("invalid_package", text);
  }
  if (text.startsWith(".") || text.endsWith(".")) return fail("invalid_package", text);
  return { ok: true, value: text };
}

/** The URI an intent carries. Only the SCHEME is validated: `package:`, `content:`, `tel:` and
 *  a vendor's own are all legitimate, and a stricter rule would refuse working intents. */
export function normalizeIntentData(raw: unknown): IntentResult<string> {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return { ok: true, value: "" };
  const colon = text.indexOf(":");
  if (colon <= 0) return fail("invalid_data", "intent data is a URI");
  const scheme = text.slice(0, colon);
  const first = scheme[0]!;
  if (!((first >= "a" && first <= "z") || (first >= "A" && first <= "Z"))) {
    return fail("invalid_data", text);
  }
  for (const c of scheme) {
    const ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
      || c === "+" || c === "." || c === "-";
    if (!ok) return fail("invalid_data", text);
  }
  if (/[\s]/.test(text)) return fail("invalid_data", text);
  return { ok: true, value: text };
}

/** A MIME type, lowercased. `*` is legal on either half. */
export function normalizeIntentType(raw: unknown): IntentResult<string> {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text.length === 0) return { ok: true, value: "" };
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return fail("invalid_type", "a MIME type is type/subtype");
  if (text.indexOf("/", slash + 1) >= 0) return fail("invalid_type", text);
  for (const c of text) {
    const ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9")
      || c === "/" || c === "*" || c === "." || c === "-" || c === "+";
    if (!ok) return fail("invalid_type", text);
  }
  return { ok: true, value: text };
}

/**
 * Extras are SCALARS or homogeneous scalar arrays, and nothing else.
 *
 * Android's `Bundle` can carry a Parcelable graph; the DSX bus cannot, and a nested object here
 * would have to be serialised by a rule each renderer invented. Refusing is the honest answer:
 * the developer encodes their own structure as a string and knows exactly what crossed.
 */
export function normalizeIntentExtras(raw: unknown): IntentResult<Record<string, unknown>> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fail("invalid_extras", "extras is an object of scalars");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim().length === 0) return fail("invalid_extras", "an extra needs a name");
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const t = typeof entry;
        if (t !== "string" && t !== "number" && t !== "boolean") {
          return fail("invalid_extras", `${key}: an array extra holds scalars`);
        }
      }
      out[key] = value;
      continue;
    }
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      return fail("invalid_extras", `${key}: encode a structured extra as a string yourself`);
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

export interface IntentFlags {
  readonly mask: number;
  readonly words: readonly string[];
}

/** Fold a caller's flag words into the bitmask and the canonical word list. An unknown flag is
 *  refused rather than dropped: a dropped `newTask` produces a launch that fails only when the
 *  app is started from a service, which is the worst kind of intermittent. */
export function foldIntentFlags(raw: unknown): IntentResult<IntentFlags> {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
  const seen = new Set<string>();
  for (const entry of list) {
    const key = foldKey(entry);
    let match = "";
    for (const word of INTENT_FLAG_ORDER) {
      if (foldKey(word) === key) { match = word; break; }
    }
    if (match.length === 0) return fail("unknown_flag", String(entry ?? ""));
    seen.add(match);
  }
  const words = INTENT_FLAG_ORDER.filter((w) => seen.has(w));
  let mask = 0;
  for (const word of words) mask |= INTENT_FLAGS[word]!;
  return { ok: true, value: { mask, words } };
}

export interface IntentSpec {
  readonly action: string;
  readonly package: string;
  readonly data: string;
  readonly type: string;
  readonly categories: readonly string[];
  readonly extras: Readonly<Record<string, unknown>>;
  readonly flags: IntentFlags;
}

export interface RawIntent {
  action?: unknown;
  package?: unknown;
  data?: unknown;
  type?: unknown;
  categories?: unknown;
  extras?: unknown;
  flags?: unknown;
}

export function normalizeIntent(raw: RawIntent): IntentResult<IntentSpec> {
  const action = normalizeIntentAction(raw.action);
  if (action.ok !== true) return fail(action.error, action.detail);
  const pkg = normalizeIntentPackage(raw.package);
  if (pkg.ok !== true) return fail(pkg.error, pkg.detail);
  const data = normalizeIntentData(raw.data);
  if (data.ok !== true) return fail(data.error, data.detail);
  const type = normalizeIntentType(raw.type);
  if (type.ok !== true) return fail(type.error, type.detail);
  const extras = normalizeIntentExtras(raw.extras);
  if (extras.ok !== true) return fail(extras.error, extras.detail);
  const flags = foldIntentFlags(raw.flags);
  if (flags.ok !== true) return fail(flags.error, flags.detail);

  const rawCategories = Array.isArray(raw.categories) ? raw.categories
    : typeof raw.categories === "string" && raw.categories.length > 0 ? raw.categories.split(",") : [];
  const categories: string[] = [];
  for (const entry of rawCategories) {
    const one = normalizeIntentAction(entry);   // same grammar: a dotted constant name
    if (one.ok !== true) return fail("invalid_action", String(entry ?? ""));
    if (!categories.includes(one.value)) categories.push(one.value);
  }

  return {
    ok: true,
    value: {
      action: action.value, package: pkg.value, data: data.value, type: type.value,
      categories, extras: extras.value, flags: flags.value,
    },
  };
}

/** One row of the `<queries>` block a module's manifest facet must declare. */
export interface IntentQuery {
  readonly kind: "intent" | "package";
  /** `intent` rows: the action; `package` rows: "" */
  readonly action: string;
  /** the URI scheme half of a data filter, or "" */
  readonly scheme: string;
  /** the MIME type half of a data filter, or "" */
  readonly mimeType: string;
  /** `package` rows: the package name; `intent` rows: "" */
  readonly name: string;
}

/**
 * Derive the `<queries>` rows a set of declared intents needs.
 *
 * ANDROID 11 PACKAGE VISIBILITY is the reason this exists. An app can no longer see which other
 * apps are installed unless its manifest says which it is looking for, and an intent for an
 * undeclared component does not error: `resolveActivity` returns null and `startActivity`
 * throws ActivityNotFound. The failure looks exactly like "no app can handle this", so a
 * developer spends an afternoon before discovering it is a manifest problem.
 *
 * Generating the rows from the module's OWN declarations means the manifest and the code cannot
 * disagree. A row naming a package is emitted for a targeted launch; otherwise the action, plus
 * whichever of scheme and MIME type the intent actually constrains.
 */
export function intentQueries(specs: readonly IntentSpec[]): readonly IntentQuery[] {
  const rows: IntentQuery[] = [];
  const seen = new Set<string>();
  const add = (row: IntentQuery) => {
    const key = `${row.kind}|${row.action}|${row.scheme}|${row.mimeType}|${row.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  for (const spec of specs) {
    if (spec.package.length > 0) {
      add({ kind: "package", action: "", scheme: "", mimeType: "", name: spec.package });
      continue;
    }
    let scheme = "";
    if (spec.data.length > 0) {
      const colon = spec.data.indexOf(":");
      if (colon > 0) scheme = spec.data.slice(0, colon).toLowerCase();
    }
    add({ kind: "intent", action: spec.action, scheme, mimeType: spec.type, name: "" });
  }

  // Sorted so the emitted manifest fragment is byte-stable across runs: a generator whose
  // output depends on declaration order makes every unrelated diff noisy.
  return rows.slice().sort((a, b) => {
    const ka = `${a.kind}|${a.name}|${a.action}|${a.scheme}|${a.mimeType}`;
    const kb = `${b.kind}|${b.name}|${b.action}|${b.scheme}|${b.mimeType}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Human copy for each refusal, so three renderers apologise with one sentence. */
export const INTENT_MESSAGES: Readonly<Record<IntentRefusal, string>> = {
  invalid_action: "That is not an intent action. Use a dotted constant like android.intent.action.VIEW.",
  invalid_data: "That is not a URI an intent can carry.",
  invalid_type: "That is not a MIME type.",
  invalid_extras: "Intent extras are scalars or arrays of scalars.",
  invalid_package: "That is not an Android package name.",
  unknown_flag: "That is not an intent flag this module knows.",
};
