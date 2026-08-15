`<api>` block conformance (/web/05) — fixtures land BEFORE the capability ships on the next platform (W5).

- `api-blocks.json` — the 39-case state-transition corpus (seamed fetch, injected clock,
  step-driven; the LAW is spelled out in its `_note`). Runners:
  · TS: `OpenSource/Web/packages/kernel/test/api-conformance.test.ts` (per-PR, web-kernel lane)
  · Kotlin: `Engine/Android :core ApiConformanceTest` (per-PR, android-kernel lane)
  · Swift: `OpenSource/Engine/iOS/ApiBlock.swift` — EXECUTED by `ApiConformance`
    (OpenSource/Engine/iOS/ConformanceHosts.swift) from the `conformance-record` lane
    (`RecordMain.swift`), a twin of the Kotlin `ApiConformanceTest`.

  The original 14-case corpus passed on all three runners in the 2026-07-20/21 local audit.
  The three networking.md cases added 2026-07-28 — `const-materializes-into-request`,
  `const-change-refetches` (N0 `dsx.const`: an `<api>` reads app-wide constants from any
  url/headers/body expression, present consts materialize, an absent const is typed-null, and a
  const change reactively refetches), and `api-in-component-scope-materializes` (N1: an `<api>`
  mounted inside a component instance materializes from the component's scope via the block's
  `item` — the harnesses now accept `consts`/`item`/`{setConst}`) — pass on TS + Kotlin; Swift is
  compile-pending (rides the record lane).
  Twenty cases added 2026-07-29 — pass on TS + Kotlin, Swift compile-pending (record lane):
  · **/web/11, the `<api>` dependency graph** (12 rows): `graph-waits-for-upstream-then-fires`,
  `graph-status-and-blockedby-expose-the-gate`, `graph-needs-declares-an-invisible-dependency`,
  `graph-independent-blocks-are-not-serialized`, `graph-upstream-error-blocks-dependent-until-refresh`,
  `graph-upstream-error-leaves-dependent-waiting`,
  `graph-identical-upstream-refetch-does-not-refire-dependents`,
  `graph-changed-upstream-refires-dependents`, `graph-cycle-is-a-declared-error`,
  `graph-unknown-needs-is-a-declared-error`, `gate-missing-value-holds-the-fetch`,
  `gate-missing-value-names-the-hole`, `gate-or-default-opts-out-of-value-presence`,
  `send-with-a-hole-returns-incomplete-input`.
  · **networking.md N2 declared transport controls** (5 rows):
  `transport-controls-materialize-into-the-request` (stream/timeout/redirect),
  `encode-form-materializes-a-urlencoded-body`, `encode-multipart-materializes-sorted-parts`,
  `progress-publishes-and-fires-before-success`, `terminal-response-errors-do-not-retry`.
  · **doc 05 `via="server"`** (1 row): `via-server-rewrites-the-request-to-the-proxy-route`.

  Two cases added 2026-07-29 (later the same day) — pass on TS + Kotlin, Swift compile-pending:
  · **/web/11's AMBIENT CARVE-OUT** (2 rows): `gate-ambient-planes-are-never-holes` and
  `gate-ambient-hole-never-lands-in-blockedby`. Value-presence gating (rule 2) applies to the
  REACTIVE scope only — an absent ambient plane (`dsx.global` here, standing for
  const/env/screen/source/app/route/cookie/query/params/path and `platform`/`os`) is
  TYPED-ABSENT by law (durability P4): it interpolates EMPTY and the request still fires, and it
  never appears in `blockedBy`. The carve-out was law and implemented in all three kernels but
  pinned by only ONE plane (`const-materializes-into-request`), which is exactly the class of gap
  the corpus exists to close — a behavior every renderer implements that no row measured. The
  second row is the mixed case: one ambient hole + one reactive hole gates on the reactive half
  alone, so the developer is pointed at the value they actually control.

  Three grammar additions the harnesses now accept, all optional and back-compatible:
  `specs` (an ORDERED list of specs sharing one scope — the graph cases; a case declares
  either `spec` or `specs`), `responsesByUrl` (a per-URL response queue, so a case is not
  hostage to whether a runtime's transport is synchronous), `target` on a `call`/`send`
  step (which block), and `expectRequests` (per-call dotted-path subset assertions over the
  MATERIALIZED request). A `send` step stores its returned envelope at `sendResult`.

  Transport- and host-specific behavior that the seamed corpus cannot prove—mounted head
  lifecycle, real cancellation, stale-response suppression, request/response limits,
  redirects, incremental SSE, and `json|text|blob` decoding—is covered by each runtime's
  focused integration tests. The Swift host reports five native API integration suites green.
  The Swift CI lane remains manual-trigger and Mac-hosted; the runner has been compiled and
  executed successfully in the local audit.
- `wire-contract.json` — the module envelope contract (bridge v3), unchanged.

A change to `<api>` semantics is illegal without a green corpus on every runtime that ships it —
same discipline as `OpenSource/Conformance/jse`.
