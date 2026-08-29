//
//  strings.ts — the KERNEL localization seam, web twin of DSXStrings.swift /
//  Strings.kt (string-table LOOKUP, nothing more; architecture/localization.md,
//  corpus OpenSource/Conformance/strings/cases.json).
//
//  "Write the app in English" is the authoring model: the ENGLISH SOURCE STRING is the
//  key (gettext-style), per-locale tables map it, and the kernel only RESOLVES - where
//  tables come from is never its business (Article 1). The ladder and tiers are the
//  contract the two native twins already keep:
//
//    • `global.locale` (one state write - the in-app switcher) → device language → "en".
//    • BUNDLE tier via the `loader` seam: `Strings.<tag>.json` text for a candidate tag
//      (full lowercase BCP-47 first, then the bare language; the FIRST candidate that
//      yields a non-empty merged table wins outright).
//    • RUNTIME tier: `global.strings.<tag>` merges OVER the bundle table; a writer MUST
//      bump `global.strings.version` afterwards - the merged table reloads only on a
//      (lang, version) change, deliberately.
//
//  FAIL-OPEN BY CONSTRUCTION (Article 7): no table, no match, English, empty string,
//  invalid table JSON - the input returns unchanged, byte-for-byte.
//
//  THE WEB-ONLY ADDITION is reactivity, and it costs nothing here: the default
//  `statePath` reads the ONE app-wide store through the tracked door (`noteGlobalRead`),
//  so a display binding that calls `localize` inside its effect automatically depends on
//  `global.locale` / `global.strings` - a locale switch is one state write and every
//  live display string re-resolves, static markup included (the dom layer's
//  `bindDisplay` exists exactly for that).
//

import { DSXState, noteGlobalRead } from "./store.ts";

const state = {
  table: new Map<string, string>(),
  loadedLang: "__none",
  loadedVersion: "",
};

export const DSXStrings = {
  /** Seam: the BUNDLE tier — `Strings.<tag>.json`'s text for a candidate tag, or null. */
  loader: null as ((lang: string) => string | null) | null,

  /** Seam: the app-wide store, read tracked so display effects re-fire on locale and
   *  table writes. Overridable (tests, hosts) — the corpus runner drives it directly. */
  statePath: ((path: string): unknown => {
    noteGlobalRead(path.split(".")[0]!);
    return DSXState.get(path);
  }) as (path: string) => unknown,

  /** Seam: the device's preferred language, lowercase BCP-47, seeded once. */
  deviceLang: (typeof navigator !== "undefined" && typeof navigator.language === "string" && navigator.language.length > 0
    ? navigator.language
    : "en").toLowerCase(),

  /** Translate a rendered string through the active locale table. Identity when there is
   *  no table, no match, or the source language is active — never null, never throws. */
  localize(s: string): string {
    if (s.length === 0) return s;
    const lang = resolvedLang();
    const versionValue = DSXStrings.statePath("strings.version");
    const version = versionValue === null || versionValue === undefined ? "" : String(versionValue);
    if (lang !== state.loadedLang || version !== state.loadedVersion) load(lang, version);
    if (state.table.size === 0) return s;
    return state.table.get(s) ?? s;
  },

  /** Drop the cached table (tests; a host swapping seams mid-session). */
  reset(): void {
    state.table = new Map();
    state.loadedLang = "__none";
    state.loadedVersion = "";
  },
};

/** `global.locale` (an in-app switcher's write) → the device's preferred language. */
function resolvedLang(): string {
  const override = DSXStrings.statePath("locale");
  if (typeof override === "string" && override.length > 0) return override.toLowerCase();
  return DSXStrings.deviceLang;
}

/** (Re)load the table for `lang`: the bundle tier under the runtime tier, full tag then
 *  bare language. English (the source language) and misses resolve to the empty table. */
function load(lang: string, version: string): void {
  state.loadedLang = lang;
  state.loadedVersion = version;
  state.table = new Map();
  const bare = lang.split(/[-_]/)[0]!;
  for (const candidate of [lang, bare]) {
    if (candidate.length === 0 || candidate === "en") continue;
    const merged = new Map<string, string>();
    const text = DSXStrings.loader?.(candidate) ?? null;
    if (text !== null) {
      try {
        const obj: unknown = JSON.parse(text);
        if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
          for (const [k, v] of Object.entries(obj)) if (typeof v === "string") merged.set(k, v);
        }
      } catch { /* invalid table JSON fails open — identity, exactly like the twins */ }
    }
    // the twins' `as? [String: Any]` is all-or-nothing on the keys; JSON-shaped state
    // always has string keys, so here the guard is simply "a plain object"
    const runtime = DSXStrings.statePath(`strings.${candidate}`);
    if (runtime !== null && typeof runtime === "object" && !Array.isArray(runtime)) {
      for (const [k, v] of Object.entries(runtime)) {
        if (typeof v === "string") merged.set(k, v);   // runtime tier wins
      }
    }
    if (merged.size > 0) { state.table = merged; return; }
  }
}
