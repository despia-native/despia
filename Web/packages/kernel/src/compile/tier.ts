//
//  tier.ts - the W9 execution-tier CLASSIFIER (/web/15 law 4: "tiers are visible").
//  Every action-tier body is classified ONCE, at parse/build time, into `jse` (the
//  portable subset — natively interpreted on iOS/Android, compiled closures on web) or
//  `js` (the escalation tier — a real, sandboxed JS engine per /web/12). One classifier
//  — the build report, the lint badge (compiler lint.ts `tier-*` rules), and the editor
//  all read this verdict; nothing re-classifies per evaluation (the cache below).
//
//  THE ORACLE, honestly: a TOKEN-LEVEL SYNTAX SCREEN over the reference tokenizer.
//  This screen IS the compiler's subset gate now — the W9 strict-rejection hardening
//  landed (rendering-1.0-finalization.md): codegen classifies through `classifyBody`
//  and throws `JSESubsetError` on a "js" verdict instead of lossy-compiling (the old
//  permissive emission — `class Foo {}` as a variable read of "class" — is gone; the
//  eval conveniences stay fail-open, warn + null). The screen names the JS constructs
//  the JSE GRAMMAR does not define. It is CONSERVATIVE in the safe direction: a
//  construct it misses classifies "jse" and runs exactly as it runs today (no
//  regression, no new blocking); a flagged construct is VISIBLE (a notice by default
//  — law 4's whole point), assertable (`tier="jse"`), and strict-modeable.
//
//  What this module deliberately does NOT do: execute anything. The native engine
//  substrate (JavaScriptCore on iOS, JavaScriptSandbox/QuickJS on Android — /web/15
//  "Where each tier runs") consumes these verdicts and the SAME codegen helper library;
//  its wiring is the remaining W9 native slice, tracked in the finalization program.
//

import { cachedTokens } from "../jse/tokens.ts";

export type TierVerdict = {
  tier: "jse" | "js";
  /** the screen's finding, when the body escalates — the "why" the report prints */
  reason: string | null;
};

/** JS keywords with NO JSE-grammar meaning — their presence as a real token (never
 *  inside a string; the tokenizer already stripped those) is the escalation signal. */
const BEYOND_SUBSET_KEYWORDS = new Set([
  "class", "extends", "super", "yield", "with", "debugger",
  "get", "set", // contextual — screened only in the `get name(` accessor shape below
]);

const cache = new Map<string, TierVerdict>();

/** Classify one action-tier body (an `<action>` body, an `on:*` handler, a hook body).
 *  Deterministic and cached — zero per-evaluation cost (/web/15 law 4). */
export function classifyBody(body: string): TierVerdict {
  const hit = cache.get(body);
  if (hit !== undefined) return hit;
  let verdict: TierVerdict = { tier: "jse", reason: null };
  try {
    const toks = cachedTokens(body);
    const ident = (i: number): string | null => {
      const t = toks[i];
      return t !== undefined && t.kind === "ident" ? t.v : null;
    };
    const op = (i: number): string | null => {
      const t = toks[i];
      return t !== undefined && t.kind === "op" ? t.v : null;
    };
    for (let i = 0; i < toks.length; i++) {
      const word = ident(i);
      if (word !== null && BEYOND_SUBSET_KEYWORDS.has(word)) {
        // `get`/`set` are ordinary identifiers unless followed by `name (` — the
        // accessor shape; plain `get(...)`/property reads stay jse.
        if (word === "get" || word === "set") {
          if (ident(i + 1) === null || op(i + 2) !== "(") continue;
        }
        // member-position `with` is the ARRAY METHOD (`[1,2].with(1,9)` — in the JSE
        // method table, corpus stdlib-001), never the statement; only the bare
        // keyword shape escalates.
        if (word === "with" && (op(i - 1) === "." || op(i - 1) === "?.")) continue;
        verdict = { tier: "js", reason: `'${word}' is outside the JSE grammar` };
        break;
      }
      // generators: `function *` / `function*` — the star lands as its own op token
      if (word === "function" && op(i + 1) === "*") {
        verdict = { tier: "js", reason: "generator functions are outside the JSE grammar" };
        break;
      }
      // labeled statements: `name : (for|while|do)` — JSE loops are unlabeled
      if (op(i) === ":" && ident(i - 1) !== null) {
        const next = ident(i + 1);
        if (next === "for" || next === "while" || next === "do") {
          verdict = { tier: "js", reason: "labeled loops are outside the JSE grammar" };
          break;
        }
      }
    }
  } catch (e) {
    // a body the reference tokenizer cannot even tokenize is beyond the subset
    verdict = { tier: "js", reason: e instanceof Error ? e.message : String(e) };
  }
  cache.set(body, verdict);
  return verdict;
}

export type TierReportEntry = { location: string; reason: string };

export type TierReport = {
  total: number;
  jse: number;
  js: TierReportEntry[];
};

/** The build's tier report ("3 of 41 bodies run on the JS tier", with locations). */
export function tierReport(bodies: Iterable<{ location: string; source: string }>): TierReport {
  const js: TierReportEntry[] = [];
  let total = 0;
  for (const body of bodies) {
    total += 1;
    const verdict = classifyBody(body.source);
    if (verdict.tier === "js") js.push({ location: body.location, reason: verdict.reason ?? "beyond the JSE subset" });
  }
  return { total, jse: total - js.length, js };
}
