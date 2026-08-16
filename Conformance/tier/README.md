# tier/ — the W9 execution-tier verdict corpus

The tier-equivalence law executed as fixtures (/web/15 law 4, "tiers are visible";
`rendering-1.0-finalization.md` §"The W9 native JS escalation"): every action-tier body
classifies ONCE into `jse` (the portable subset — natively interpreted on iOS/Android,
compiled closures on web) or `js` (the escalation tier — a real sandboxed engine per
/web/12), and the three classifiers must never drift. Since the strict-rejection
hardening the TS verdict is also the compiler's subset gate (`JSESubsetError` on a "js"
verdict), so a cross-runtime disagreement is not cosmetic: a body would compile on one
renderer and escalate — or be rejected — on another. `verdicts.json` carries the law in
its `_note` plus the cases.

Runners — three implementations exist, and all THREE execute this corpus:

- **TS** (the REFERENCE — per-PR, `web-kernel` lane):
  `OpenSource/Web/packages/kernel/test/tier-conformance.test.ts` drives every case
  through `classifyBody` (`packages/kernel/src/compile/tier.ts`), the token screen over
  the reference tokenizer.
- **Kotlin** (per-PR, `android-kernel` lane):
  `Engine/Android/core/src/test/kotlin/despia/engine/TierConformanceTest.kt` drives
  `TierClassifier.classify` (`core .../despia/engine/Tier.kt`), the word-lexer twin.
- **Swift** (reference lane, Mac): `TierConformance.verify(corpusFile:)` in
  `OpenSource/Engine/iOS/ConformanceHosts.swift` drives `TierClassifier.classify`
  (`Engine/iOS/Tier.swift`) via `ClosedSource/scripts/conformance/RecordMain.swift` —
  `tier/verdicts.json` loads beside `jse/`, `chains/`, `errors/`, …, and any mismatch
  fails the recorder outright (no `.jse-record-ok` marker), the same record-lane gate
  the other expectation corpora ride.

## Case shape

```jsonc
{
  "name": "…",
  "body": "<the action-tier source>",
  "tier": "jse" | "js",
  "reasonContains": "<substring>" | null,   // stated for every js case; null for jse
  "note": "…"                               // optional — documents a surprising verdict
}
```

- `tier` is the verdict all three classifiers must return.
- `reasonContains` matches as a SUBSTRING of the runner's reason — never the full
  wording, because the wording legitimately differs per runner (TS says
  `'get' is outside the JSE grammar`, Kotlin/Swift say `'get' accessors are outside
  the JSE grammar`; the substring `'get'` is the stable part). A `jse` verdict must
  carry NO reason (null on all three) — the runners assert that too.

## Adding a case

1. Run the body through the TS reference first (`classifyBody` in
   `packages/kernel/src/compile/tier.ts`) — the corpus never ships an expectation the
   reference denies. If the reference verdict surprises you, the case documents the
   surprise in a `note` (see `unterminated-string`) or the classifier gets fixed on
   ALL THREE twins in the same commit — never one.
2. Add the case to `verdicts.json` with a `reasonContains` substring for a `js`
   verdict (pick the stable fragment: the quoted keyword, `generator functions`,
   `labeled loops`, `outside the JSE grammar`).
3. Green on all three: `cd OpenSource/Web && npm test` (TS), `cd
   OpenSource/Engine/Android && gradle :core:test` (Kotlin), and the Swift leg rides
   the `conformance-record` lane.

Every cross-runtime divergence bug becomes a case here in the same commit as its fix
(the first one is already in the corpus: member-position `.with(` — the Array method —
classified `js` on the Kotlin/Swift twins until this lane landed).
