# Rendering 1.0 — the finalization program

> **STATUS: CODE SCOPE CLOSED (2026-08-12).** Every FIX row in §3 is ✅ except R3.4, which §4
> ratifies as post-1.0 by decision, and R2.1/R2.3/R4.*, which need CI credentials or physical
> hardware and are tracked in `/STATUS.md` §4 rather than here. **The remaining work in this
> program is evidence, not engineering** — do not re-open a §4 row as a gap; it is a ratified
> divergence with a reason. `/STATUS.md` is the live status; this document remains the reasoning
> behind each disposition.
>
> **Historical header (2026-08-06): ACTIVE PROGRAM.** This is the closeout plan for the DSX rendering
> engine across all three renderers (iOS · Android · Web). It exists because "done" was never
> defined — the engine has been converging for six months under a no-silent-gaps discipline
> that (correctly) never stops finding items to pin. This document freezes the scope: **every
> remaining item is listed below, classified FIX or RATIFY, and nothing else blocks 1.0.**
> An item not on this list is post-1.0 by definition. When this document's exit checklist is
> green, the rendering engine is declared 1.0-final and further work is maintenance.

## 1 · The definition of DONE

"100% perfect" is not a shippable criterion — the repo's own law (system-defaults.md,
facet-contracts.md) is *no silent gaps*, not *no divergences*. 1.0-final therefore means:

1. **Every conformance corpus green on all three runners** — `jse`, `api` (14), `actions`
   (70), `router` (incl. `root-plan`, `popto`), `chains`, `errors`, `logs`, `lifecycle`,
   `defaults/tokens`, `elements` (76 fixtures), `tier` (33 verdicts) — TS + Kotlin per-PR
   in CI, Swift via a **passed hosted `conformance-record` run** (not local-Mac evidence).
2. **Zero open FIX items** in §3 below (the divergence ledger in §4 is ratified, not empty).
3. **The element census fully dispositioned**: 59 enforced `:render` specs + 14 module-facet
   registrations + 13 structural tags; the `elements-gaps.json` allowlist contains ONLY
   ratified rows (`Godot` demand-driven, `Scene3D`/`Scene360` D-class) — the `partial`
   bucket stays empty.
4. **Qualification evidence exists** per §5: current-candidate Wear run, one physical-device
   Pass A on Android, one TestFlight/device pass on iOS, Play signing/processing evidence.
5. **The Swift compile-pending queue is empty** — every wave marked "compile-pending" in the
   status ledgers has ridden a green Codemagic build.

## 2 · Where we actually are (the six-months-of-progress snapshot)

Already green and gated — this is the bulk of the engine and it is NOT in question:

- **Android**: `:core` 1297 tests, `:render` 228×2, the M3 visual-identity wave COMPLETE
  (still-custom list empty), full RouterHost with push/pop transitions + predictive back,
  the `<list>` construct (group_by/swipe/reorder), the interaction-decoration wave, the
  four-layer CSS cascade, 100/123 modules with live `kotlin/` facets, emulator matrix
  passed on API 24 + API 36 phone + tablet (zero failures, conditional skips only).
- **Web**: Nordcraft parity scorecard engine-core "cleared and gated in CI"; adopt-hydration
  live at mismatch=0 across 23 demo routes; embeds v1 shipped.
- **iOS**: the reference renderer — all corpora authored against it; five focused native API
  integration suites green locally.
- **Cross-renderer**: the unified-codebase law enforcing (fixtures-first on all three), the
  durability program all five phases landed, the error system corpus-gated on three runners.

What remains is the tail below — four bounded workstreams, not another six months.

## 3 · The FIX list — every item that blocks 1.0

### R1 · Android renderer closeout (executable locally — Kotlin compiles here)

| # | Item | Where | Gate | Status |
|---|---|---|---|---|
| R1.1 | `<pressable>` doubleTap / longPress / longPressEnd — the hand-rolled recognizer | `StackPressable.kt` | `PressableGestureMachineTest` (12) + spec keys enforced in `ElementParityTest` | ✅ **LANDED 2026-08-06** |
| R1.2 | ~~Element-level swipe decorations~~ — **RATIFIED demand-driven (2026-08-06)**: grep-verified the arm exists only in Stack.swift (no web impl, no StackReference row, zero corpus uses; iOS `.swipeActions` only functions inside a system List row). §4, the Godot/AR precedent. | — | android-status.md carries the ratification | ✅ RATIFIED |
| R1.3 | `container` (`dsx.element.*` via `LocalDsxContainer` → `item.__element`) + `passthrough="true"` (the withholding gate, `LocalDsxPassthrough`) | StackNodeView | :render suite green; divergence pinned (system-control internals stay hit-testable) | ✅ **LANDED 2026-08-06** |
| R1.4 | The diagnostics wave — `StackDiagnostics` ledger (:core, source-true line:column + excerpt + hints), `StackDiagnosticCard` + issues panel (:render), both card arms, DevSettings drawer surfacing (banner count + issues verb + report section) | `:core` + `:render` + DevSettings | `StackDiagnosticsTest` (10) + both arms live | ✅ **LANDED 2026-08-06** |
| R1.5 | ✅ **LANDED 2026-08-06** — Dom owns the capture (`BlobCapture.kt`): the page reads its own `blob:` over the attributed wire (`dom://__blobCapture`, intercepted transport-internally before registry dispatch — never a page-callable action), bytes land in the app cache, the SAME `lifecycle.downloadResponse` re-fires with `file://`; Downloads grew the containment-gated `publishLocal` arm (MediaStore on 29+/app dir below, `started`+`completed`) and the blob-decline retired. Bridge-less providers time out fail-open. Dom compiles in the local app assembly; the Downloads facet edit rides CI (excluded profile locally, the DevSettings posture). | `Mandatory/Dom` + `Core/Downloads` kotlin | app compile green + module-rules gate green | ✅ |
| R1.6 | QRScanner torch toggle (CameraX `enableTorch`, `hasFlashUnit` guard, the iOS bolt-button arrangement) | `QRScannerActivity.kt` | app assembly green; headers closed | ✅ **LANDED 2026-08-06** |

### R2 · iOS closeout (compile-pending burn-down — needs Codemagic, not this container)

| # | Item | Gate |
|---|---|---|
| R2.1 | **First hosted `conformance-record` Mac-lane run** (android-status §4.5 — local Mac evidence does not prove CI credentials/hosted behavior). This single run converts every "Swift twin compile-pending / parity-reviewed" row in both status ledgers into verified state, or surfaces the drift list to fix. | green `conformance-record` workflow + regenerated-corpus artifact clean |
| R2.2 | ✅ **LANDED 2026-08-06** — `flexFrame`'s vertical ladder now tests `center` (Swift edit, compile-pending as always); the Android pin retired in the same wave (`frameAnchorLoneAlignYCenterAnchorsCenter` is the fix's gate). The web has no anchor twin — its alignment is real CSS. | Kotlin test-verified; Swift rides the next build |
| R2.3 | Ride every queued wave through one green Codemagic iOS build (actions corpus twin, `<api>` twin, RootPlanConformance, ChainsConformance record lane) | green `ios` lane on the finalization commit |

### R3 · Web closeout

| # | Item | Where | Gate | Size |
|---|---|---|---|---|
| R3.1 | ✅ **LANDED 2026-08-06** — `createPageHandler` (`packages/server/src/live.ts`): per-request `renderPageAsync` over the route table, dynamic patterns, the client's exact vars seed, real 302s/404s, per-request api seeding, HEAD, dev/prod 500 split; edge-compatible. Out-of-order STREAMING landed 2026-08-06 (`stream.ts` + `stream: true` — the W6 gate is closed). | `@despia/server` | `live-adapter.test.ts` (10) + full suite 1698 green | ✅ |
| R3.2 | ✅ **VERIFIED ALREADY LANDED (2026-08-06)** — the parity row was stale: Android's production transport parses real `text/event-stream` (`NetworkBackend.kt` :platform + the desktop twin), iOS's `ApiBlock.swift` URLSession delegate drains SSE envelopes before EOF, and the `streamed-chunks-append-and-fire-message` corpus case runs on all three runners. `web/21-nordcraft-parity.md` corrected to ✅ all three. | — | corpus case on three runners | ✅ |
| R3.3 | ✅ **LANDED 2026-08-07 — all three steps.** Facts extracted to the shared `Conformance/lint/facts.json` (lint_dsx.rb reads the same bytes, repo run byte-identical); the TS linter (`packages/compiler/src/lint.ts` — the shared ruleset with stable rule ids + the web-only doc 05/04 rules); the two-runner anti-drift corpus LIVE (`lint_conformance.rb` in all three codemagic gate chains, `lint.test.ts` per-PR; first run 0 drifts). The W9 tier rules ride it. | `OpenSource/Web` + `Conformance/lint/` | both runners in CI, 0 drift | ✅ |
| R3.4 | **W9 native JS escalation** (beyond-JSE-subset `<script>` bodies on native) — **DECISION: post-1.0.** Web runs real JS today; native's JSE subset + the documented portable idioms are the 1.0 contract. Moving it out is a scope call this program makes explicitly. | — | ratified in §4 | — |

### R4 · Qualification evidence (needs devices/credentials — schedule-bound, not code-bound)

| # | Item | Runbook |
|---|---|---|
| R4.1 | Wear requalification on the current candidate (older Wear results are history, not evidence) | android-status §4.1 |
| R4.2 | Physical-device Pass A on Android (~15 min, six steps) | android-status §5 |
| R4.3 | Play signing/processing evidence (real keystore through the android-app lane, internal-track processing) | codemagic-monorepo.md §8b |
| R4.4 | iOS device/TestFlight pass of the same six-step shape (boot → native fixture → web frame → dev panel → push → paywall) | mirror of §5 |

## 4 · The RATIFY list — divergences that are 1.0-FINAL by decision

These stop counting as "open." Each is already pinned in a header/ledger with its reason;
this section is the sign-off that no further work is owed. (Grouped; the per-file headers
remain the authoritative detail.)

- **Platform-identity divergences (the system-defaults law working as designed):**
  `wheelpicker` custom drum · `calendar` custom month grid · `stars` custom row (M3 ships no
  twin for any of the three) · `stepper`/`otp` composed from M3 primitives · `rangeslider`
  as Android's platform baseline vs iOS's drawn twin · M3 outline-box text fields vs iOS
  borderless · no `<list>` sidebar-column arm · no M3 grouped-form container · no list
  edit-mode/drag handles · the M3 ripple staying additive · submenu push-in-place.
- **Platform-capability divergences:** `fontDesign="rounded"` → honest platform sans
  (bundling a face is an app decision, never a kernel primitive) · `textCase` root-locale ·
  gesture arming system-owned on Android · cancelled drag delivers phase `"end"` ·
  `on:adjust` as a TalkBack action pair · Widgets SVG placeholder · significant-location-
  changes (no framework twin) · pre-34 screenshot broadcast · WebView `ephemeral`
  (no per-WebView profile until androidx multi-profile) · old-provider Web bridge
  fail-closed without `WEB_MESSAGE_LISTENER` · media `preview` scrub thumbnails.
- **Demand-driven absences (Article 7 graceful `unsupported_platform`):** `Godot` element ·
  Core/AR · Core/Godot · Scene3D/Scene360 D-class · the nine documented D-class modules ·
  element-level `on:swipeLeading`/`on:swipeTrailing` (ratified 2026-08-06 — iOS-only vestige,
  zero corpus uses; the `<list>` construct rails are the shipped swipe surface).
- **Pinned cross-renderer semantics:** the `for (let i=0; …)` store-shadow loop behavior
  stays bug-for-bug pinned with the documented portable idioms (`for (const x of arr)`,
  store-var counters) — changing execution semantics under existing apps is a MAJOR bump,
  not a 1.0 fix. (Unlike R2.2, which is a layout bug with no author relying on it.)
- **Scope-out:** W9 native JS escalation (R3.4) · LocalAI/Cactus public unavailability
  (licensed-product boundary, its own README) · dashboard Android zip emission + run_step
  `system` verification (build-pipeline items, tracked in codemagic-monorepo.md — not
  rendering-engine scope).

## 5 · Sequencing — six weeks, two lanes

The container lane (code, runs here — Kotlin + TS compile locally) and the operator lane
(CI triggers, devices, credentials — needs a human/Mac/hardware) run in PARALLEL. The
operator lane is the schedule risk, so its first two items start in week 1, not at the end.

| Week | Container lane (code) | Operator lane (evidence) |
|---|---|---|
| 1 | R1.1 pressable recognizer + R1.6 torch (small wins first — visible progress) | **Trigger R2.1 hosted conformance-record NOW** + one full Codemagic matrix on this branch (burns the compile-pending queue or surfaces the fix list) |
| 2 | R1.2 element swipe + R1.3 container/passthrough | R4.1 Wear requalification |
| 3–4 | R1.4 diagnostics port (the big Android chunk) · R3.1 live adapter in parallel | R4.2 physical-device Pass A |
| 5 | R3.2 native SSE transport · R3.3 TS lint twin · R1.5 Dom blob → Downloads | R2.2/R2.3 iOS fixes ride a build; R4.3 Play evidence |
| 6 | Buffer: drift from the record-lane run, header cleanups, ledger updates | R4.4 iOS device pass → **exit checklist review → tag 1.0** |

Rules of the program:

1. **The scope is frozen.** New findings during weeks 1–6 are classified FIX-in-program only
   if they are regressions against an existing gate; everything else is filed post-1.0.
2. **Fixtures first, always** — every R1/R2/R3 fix lands corpus/fixture row → TS → Kotlin →
   Swift, per the unified-codebase law. No exceptions in the final mile.
3. **Headers move with fixes** (the android-status rule: if the device disagrees with a
   header, the header is wrong and updates in the same commit).
4. **Weekly gate**: at each week boundary, this table gets a ✅/❌ per cell in-place. A ❌
   two weeks running is escalated as a scope decision (cut or slip), never silently carried.

## 5a · Deep plans — the two remaining code items (2026-08-06)

### SSR out-of-order streaming — ✅ LANDED 2026-08-06 exactly as planned below (`stream.test.ts`, 5 cases; nested-component defer blocks keep the client-fetch path, the pinned v1 limit)

The last open piece of the SSR story: a `defer="true"` api block today keeps its
client-fetch path (loading branch on first paint, data on mount) — correct, but the
data could arrive in the SAME response. Three phases, each independently shippable:

- **A · server** — `renderPageStream(...)`: run `executeSsrApis` for the non-deferred
  blocks exactly as today, flush the full document (deferred subtrees render their
  loading branches; the head carries a tiny inline queue hook, `window.__DSX_STREAM__`),
  hold the response open, run the DEFERRED ssr-eligible blocks concurrently, and flush
  one `<script>__DSX_STREAM__.push({as, seed})</script>` chunk per resolution. Close on
  all-settled or `ssrTimeoutMs` — an unflushed block simply keeps its client-fetch path
  (streaming stays a pure, fail-open optimization, the executeSsrApis law).
- **B · client** — the boot consumes the queue: a seed arriving BEFORE the block's own
  first fetch resolves seeds it (skip the fetch — the `window.__DSX__` seeding path,
  extended to late arrivals); a seed arriving after is ignored (client data wins, no
  flash). One dom test pins each arm.
- **C · adapter** — `createPageHandler({ stream: true })` returns the streamed Response;
  the static export is untouched by construction (it has no response to hold open).
- **Gates**: a server test with a scripted seam (deferred block resolves after the first
  flush → assert chunk order + document validity), the dom late-seed test, the demo walk
  unchanged. NEVER a half-written stream without the error-marker chunk (doc 02).

### The W7 TS lint twin (doc 09's own three-step program, one step per slice)

1. **Rule FACTS → shared JSON** (`OpenSource/Conformance/lint-facts/` or beside the
   catalogs): BUILTIN_TAGS, the CSS property catalog, the anatomy rank tables. The Ruby
   linters switch to READING these files with byte-identical behavior (their own gates
   prove it); TS loads the same files. Facts cannot drift after this step.
2. **Rule LOGIC in TS** for the web-only checks (the `<api>` rules from 05, route-table
   checks from 04, web-entry export checks from 03) — in-process and incremental for the
   dev loop. The Ruby linters remain the repo gate for everything they check today: no
   removal, no weakening, ever.
3. **The two-runner anti-drift corpus**: `OpenSource/Conformance/lint/*.dsx` +
   `expected.json`, run by BOTH sides in CI — a rule change cannot land green on one
   runner and silently drift on the other (the JSE-corpus discipline).

Neither item weakens any existing gate while open; both are scheduled waves, not
silent gaps.

### The W9 native JS escalation — status + the pinned finding (2026-08-07)

**LANDED — the classifier + visibility half (/web/15 law 4):** `classifyBody`/`tierReport`
(`kernel/src/compile/tier.ts`) — one cached, token-level classifier over the reference
tokenizer; the lint tier rules ride the W7 twin (`js-tier` notice by default, the
`tier="jse"` assertion → `tier-assert` error, the app-level `strictTiers` mode →
`strict-escalation` errors). Conservative in the safe direction: a missed construct
classifies `jse` and runs exactly as today.

**PINNED FINDING (discovered building the oracle) — LANDED 2026-08-07, the
strict-rejection hardening:** the JSE→JS compiler WAS permissive — a beyond-subset body
lossy-compiled into a valid-but-WRONG emission (`class Foo {}` emitted a variable read
of `"class"`; `finalize` additionally swallowed emission errors into a null-returning
closure). Now `compileExpression`/`compileBlock` (`kernel/compile/codegen.ts`) classify
first — `classifyBody` (tier.ts) is the subset verdict — and THROW a typed
`JSESubsetError` carrying the classifier's reason on a "js" verdict, before the compile
cache is touched (a wrong emission never exists; a thrown outcome is never cached).
Fail-open stays fail-open at RUNTIME (Article 7): `evalCompiled`/`evalBlockCompiled`
catch the rejection, warn one clear line, and run null — never a crash; full surfaces
never reach that path, because the runner classifies BEFORE compiling and routes an
escalated body to the JS tier. The conformance corpus runs the COMPILED executor
unchanged and stays green — in-grammar behavior is proven untouched. (The hardening
also made the screen's one method-name collision load-bearing: member-position `with` —
the array METHOD, corpus stdlib-001 — now classifies `jse`; only the bare statement
keyword escalates.)

**LANDED 2026-08-07 — the engine substrate, all three renderers:**
- **Web (live, tested):** `runJsTier` (`kernel/compile/jstier.ts`) — an escalated body
  runs as ORDINARY JS inside the `with`-proxy fence (window/document/globalThis
  unreachable, curated stdlib), store writes recorded as ops with read-after-write
  overlay and applied batched at settle, the identical `dsx.*` surface (module calls on
  the ONE funnel, depth-guarded action re-entry), the /web/12 watchdog. Wired through
  `RunnerJsTierSeam` + `installJsTier()` (the installScreenPhase byte-scarcity pattern):
  full surfaces escalate, embeds stay lean (byte pins re-locked with the law intact).
  The pinned lossy-compile misbehavior is DEAD on full surfaces. 7 jstier tests + the
  full suite green.
- **iOS (live executor written, compile-pending):** `Tier.swift` — the classifier twin +
  the JavaScriptCore executor (system framework; imports zero WebKit). The SAME
  fence/facade bootstrap as web, executed inside JSC; host callbacks bridge
  read/write/action/module/event; writes flush batched at settle; the promise-race
  watchdog. Bound by default (`JsTier.engine`). Runner hook mirrors JseRunner.kt.
- **Android (seam + visible failure):** `Tier.kt` — the classifier twin (verdicts
  corpus-matched to tier.ts) + the `JsTierEngine` seam in the runner funnel. No engine
  bound → `js_tier_unavailable` through the ambient fan-out — visible, fail-open,
  never the silent wrong path. :core 1380 green.

**LANDED 2026-08-07 — the two W9 hardenings:**
- **The JSC synchronous-loop kill switch (iOS, compile-pending):** the promise-race
  watchdog alone could not stop a body that never yields. `JsTierJSCEngine.run` now
  arms JSC's OWN execution watchdog — `JSContextGroupSetExecutionTimeLimit` on
  `JSContextGetGroup(context)`, nil callback = terminate unconditionally, limit derived
  from the same `timeoutMs` constant (one budget, two enforcement points) — so a
  synchronous `while(true){}` throws a termination exception the body cannot catch.
  The exceptionHandler maps the recognizable "execution terminated" message to
  `js_tier_timeout`; every other exception stays `js_tier_exception`. The symbol is
  exported by JavaScriptCore but declared only in JSContextRefPrivate.h (not in the
  SDK module map), so `Tier.swift` re-declares it via `@_silgen_name`.
- **The OTA escalation policy flag (all three renderers, flag-only v1):**
  `JsTierPolicy.otaEscalation` — default `false`, the law-3 safe default (OTA markup is
  JSE-tier only; bundled first-party markup escalates freely) — exists on iOS
  (`Tier.swift`), Android (`Tier.kt`), and web (`kernel/compile/jstier.ts`). HONEST
  SCOPE: on no platform is per-body markup provenance knowable at the escalation site
  today (the source plane publishes per-PLANE app state — `source.routes`/`source.web`/
  `source.content` — not per-body origin; Android's source-plane publishing twins are
  themselves deferred), so NO escalation site consults the flag yet — the consult lands
  with the source-plane integration; no fake provenance channel was built.

**LANDED 2026-08-07 — the corpus tier-equivalence lane:** the three classifiers are
corpus-gated. `OpenSource/Conformance/tier/verdicts.json` (33 verdict cases: portable
bodies, every beyond-subset keyword, generators, labeled loops, accessor shapes vs the
get/set lookalikes, member-position `.with(...)`, keywords inside strings/comments/
templates, and the tokenizer-recovery pins) runs on all three — TS
`tier-conformance.test.ts` (per-PR, `web-kernel` lane), Kotlin `TierConformanceTest.kt`
(gradle-gated, `android-kernel` lane), Swift `ConformanceHosts.TierConformance` via
`RecordMain.swift` (record lane). Building the lane caught and fixed the first drift:
the Kotlin and Swift screens lacked the member-position `with` exemption (the Array
METHOD, corpus stdlib-001 — load-bearing since the strict compiler rejects on a "js"
verdict) and would have escalated `[1,2].with(1,9)`; both twins got the TS rule
identically in the lane's landing commit. One reference behavior was pinned rather
than "fixed": the reference tokenizer RECOVERS from an unterminated literal (consumes
to EOF — the lenient JSE tokenizer), and the native lexers recover the same way, so
`msg = 'oops` classifies `jse` on all three (bug-for-bug portable); the fail-closed
catch arm in tier.ts stays defense-in-depth (corpus `unterminated-string` note).

**REMAINING (named, not silent):** the Android ENGINE BINARY
(`JavaScriptSandbox`/QuickJS — a locked, verified dependency; operator-adjacent via the
qa-profile lock regeneration path) and the source-plane provenance consult
at the escalation sites (the `JsTierPolicy.otaEscalation` flag landed flag-only — see
above). (The strict-rejection hardening of the JSE→JS compiler landed 2026-08-07 — see
the pinned finding above.)

## 6 · Exit checklist (the 1.0 declaration)

- [ ] R1.1–R1.6 landed, gates green (`gradle test` + `:app:assembleDebug` + ElementParityTest)
      — **R1.1/R1.2/R1.3/R1.4/R1.6 done (2026-08-06, all gates green); R1.5 remains (design pinned)**
- [ ] R2.1 hosted conformance-record green; R2.2 fixed on all three; R2.3 build green
      — **R2.2 code landed (Kotlin verified; Swift compile-pending); R2.1/R2.3 need the operator lane**
- [ ] R3.1–R3.3 landed (`npm run conformance && npm test && typecheck && layout-oracle` + demo walk)
      — **R3.1 done (2026-08-06); R3.2 remains; R3.3 re-sized to its own wave**
- [ ] §4 ratifications reflected in `elements-gaps.json` + the two status ledgers (no
      "open"-worded rows remain for ratified items)
- [ ] R4.1–R4.4 evidence recorded in android-status §4 / an ios twin section
- [ ] All four pre-commit gates + both android lanes + web-kernel lane green on the final commit
- [ ] Tag `rendering-1.0` · both status ledgers gain a "1.0 FINAL" banner dated and signed

After the tag: divergence-ledger changes require the same ratification discipline as a
constitution amendment — 1.0 means the ledger is a contract, not a backlog.
