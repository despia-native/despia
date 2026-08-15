# chains/ — the module-identity resolution corpus

The derived-identity law executed as fixtures (`facet-contracts.md`): dotted chains
(`watch.health`) derived from `Modules/` nesting, resolved at each runtime's ONE
dispatch funnel by the incremental longest-known-prefix FOLD over the identity set
(registered chains ∪ aliases at head ∪ build-excluded chains). `chains.json` carries
the law in its `_note`, a synthetic identity table, the resolution cases, and the
JS proxy-safety contract (the phantom-call denylist).

Runners — three implementations exist, and all THREE now execute this corpus:

- **TS** — vitest in `OpenSource/Web/packages/kernel` (runs in `npm test` /
  `npm run conformance`): the bus fold + the page/module proxy denylist.
- **Kotlin** — JUnit in `OpenSource/Engine/Android/core` (runs in `gradle test`):
  the Context/dispatch fold.
- **Swift** — the REFERENCE, on the Codemagic record lane.
  `OpenSource/Engine/iOS/ChainResolver.swift` is the Swift IMPLEMENTATION of the fold,
  and `ChainsConformance.verify(corpusFile:)` (in
  `OpenSource/Engine/iOS/ConformanceHosts.swift`) drives every case through it.
  `ClosedSource/scripts/conformance/RecordMain.swift` loads `chains/chains.json`
  beside `jse/`, `actions/`, `api/`, `errors/`, `logs/`, … and any mismatch fails the
  recorder outright (no `.jse-record-ok` marker written) — the same record-lane gate the
  other expectation corpora ride. The JS-plane `proxySafety` block is SKIPPED on Swift by
  contract: reserved members are REAL members and real members shadow dynamic lookup
  (SE-0195), so the native proxies are immune by construction (the corpus `_note` says
  exactly this, and the Kotlin twin skips it for the same reason).

Every cross-runtime divergence bug becomes a fixture here in the same commit as
its fix.
