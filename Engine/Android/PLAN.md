# Engine/Android — kernel port plan (K1/K2, live status)

The execution plan for the Kotlin kernel twin. Scope here is the **open engine only**
(`OpenSource/Engine/Android/`); modules/packages are step 2 and live in
`ClosedSource/DSX/Modules/<Name>/kotlin/` per `/STRUCTURE.md`. Wave sizing and the
full inventory: `/ClosedSource/Documentation/archive/ANDROID-V4-UNIFIED-REPO-ASSESSMENT.md` §5 (K1–K4).

## Ground rules (every port)

1. **1:1 law** — same type names, member names, arguments, order, observable behavior
   as `OpenSource/Engine/*.swift` (`OpenSource/Skills/android/api-mapping.md`). The
   Swift kernel is the reference implementation; where Swift is ambiguous, pin the
   decision in the port's header and its tests.
2. **`:core` is pure JVM.** Zero `android.*` imports — enforced by the `checkPureJvm`
   task (fails the build). kotlin-stdlib + JDK only; kotlinx-coroutines allowed when
   DSXState lands (it is a JVM lib). No other third-party deps in `:core`.
3. **Platform touches become seams**: main-thread hop → injectable
   `Executor`/dispatcher defaulting to inline; `#if DEBUG` → settable flag
   (`KernelLog.enabled`); bundle/file loading → injectable loader; network → `fetch`
   interface installed by `:platform`; timers → `ScheduledExecutorService` seam.
   Every seam documented in the file header; Android wiring lands in `:platform`.
4. **Definition of done**: compiles locally, JUnit green, edge cases from the Swift
   source pinned as tests, seams documented, NOTES on ambiguous behaviors recorded in
   the commit. Local loop: `cd OpenSource/Engine/Android && gradle test`.
5. **Tests seed the conformance corpus.** Data-shaped cases (esp. JSE
   `{scope, expression, expected}` triples) graduate into
   `OpenSource/Conformance/{jse,...}` JSON fixtures; later a Codemagic record-mode run
   of the Swift kernel regenerates the corpus and both runners must stay green
   (`/web/10` W0 — the corpus is platform-count-agnostic; web joins as runtime #3).

## Module map

| Gradle module | Contents | Builds where |
|---|---|---|
| `:core` (exists) | K1: everything below | locally, every PR — the framework's only fast loop |
| `:platform` (K2) | Context/bus/envelopes, Module+ModuleRegistry (generated registry), dsx.fetch (OkHttp), AppManifest/env, DSXBoot/BootGate, DSXScreen | CI (needs Android SDK) |
| `:render` (K4) | Compose StackNodeView + style engine (18-step modifier order), RouterHost | CI |
| `:glance` (W3, exists) | StackLive snapshot dialect → Glance: the PAINT half only (StackGlance over the `:core` element table + StackScope; deps = `:core` + glance-appwidget 1.1.1, no `:platform`). Consumed per-module by neutral coordinate `dev.despia.engine:glance` (Widgets dsx.json gradle key → RuntimeAndroid substitution) | CI |

## K1 waves — `:core` (file-by-file, live status)

Status: ☐ todo · ◐ in flight · ☑ ported+green

| Wave | Swift source (LOC) | Kotlin target | Status |
|---|---|---|---|
| 1 | JSON.swift (136) | Json.kt — `JSON`, fluent builder byte-identical | ☑ |
| 1 | DSXPathMatch.swift (58) | PathMatch.kt | ☑ |
| 1 | DSXEvents.swift (99) | Events.kt (executor seam) | ☑ |
| 1 | DSXShared.swift (142) | Shared.kt (+`DSXValues`, WeakReference) | ☑ |
| 1 | String.swift (23) | StringExt.kt | ☑ |
| 1 | KernelLog.swift (11) | KernelLog.kt (+ring buffer, enabled seam) | ☑ |
| 1 | StackNode.swift (~234) | StackNode.kt — AST + XML parse + liftCode + `StackXML.normalizeEntities` (#1002) | ☑ |
| 2 | JSE.swift (1048) | Jse.kt — tokenizer/parser/evaluator, 68 builtins, bounds; number model documented | ☑ |
| 2 | Messenger.swift (172) | Messenger.kt (executor seam) | ☑ |
| 2 | DSXStrings.swift (80) | Strings.kt (loader seam for `Strings.<lang>.json`) | ☑ |
| 2 | StackActivity.swift (59) | StackActivity.kt (slot slicing, pure) | ☑ |
| 2 | DSXState.swift (441) | State.kt — dot-path store logic + StateFlow (adds kotlinx-coroutines) | ☑ |
| 2 | — | Conformance runner: JUnit test that executes `OpenSource/Conformance/jse/*.json` (seeded at 38, now the 74-case jse corpus + 11 api + 11 actions) | ☑ |
| 3 | Stack.swift §JSERunner (~1775, lines ~1581–3356) | JseRunner.kt — full statement interpreter + await continuations + timers (virtual-scheduler tested) | ☑ |
| 3 | Stack.swift §JS-globals/crypto (~2k) | Globals.kt — WebCrypto/URL/Date/Intl/JSON wired into the JSE dispatch stubs | ☑ |
| 4 | ContentStore.swift (1342) | ContentStore.kt — CAS, atomic generations, LRU/pinned tiers, single-flight | ☑ |
| 4 | Content.swift (394) | Content.kt — sync `folder()` / async `prepare()` facade | ☑ |
| 4 | RemoteBundleGate.swift (439) | RemoteBundleGate.kt — Ed25519/P-256, cross-verified vs sign_manifest.rb output | ☑ |
| W3 | StackScope.swift (159) | StackScope.kt — `{{ dsx.variable.x }}` substitution + StackReader typed reads + StackColor (pinned: CGFloat→Double, Color→ARGB Long, weight/alignment enums) | ☑ |
| W3 | StackLive.swift (271) | StackLive.kt — the injectable snapshot element table (12 tags) + layout box; `body` returns a `StackLiveRender` DESCRIPTION (pure JVM can't build views — the pinned split); `:glance` paints it | ☑ |

Pulled INTO `:core` since (pure logic + seams, all green): Router.kt (nav state machine,
RouterHost contract pinned in tests), AppManifest.kt (+AppEnvironment fail-closed, detector
seam — Play-track mapping is the open :platform item), BootGate.kt, Bridge/Module/Context
(the bus). Still NOT in `:core`: RouterHost (Compose — `:render`), VirtualBridge
(WebView — Dom module, Article 9), DSXScreen (WindowMetrics),
Stack renderer + StackSurface (Compose — `:render`), StackWidgetKit/StackWatch/
StackKeys (snapshot backends — later; StackLive/StackScope HOISTED: kernel half `:core`,
Glance paint half `:glance` — the Widgets module consumes it, its module-local twin is
gone), UIApplication/ObjCException/Network (iOS-only or superseded).

Pulled forward into `:core` (K2 bus, pure JVM + seams — envelope suite runs locally):
Bridge.kt (ModuleCallError + Params smart-typing), Module.kt (Module + ModuleRegistry,
generated-registry seam), Context.kt (the dsx handle: dispatch, envelopes, module chain,
delegate fold, container/cookies/fetch seams) — 45 envelope tests green. ☑

## K2 gate (exit = the envelope suite)

`:platform` starts when `:core` waves 1–3 are green. Its exit gate is the **wire**:
the `{id, scheme, host, event, final, data, code}` envelope suite + a working
`window.virtual` with `capabilities:{version,structured,events,subscribe}` and full
`__proxy` delivery — without which every modern `window.despia` call rejects
(runtime.js:255-268). Modules (step 2) begin only after that gate.

## CI

When wave 2 lands, add an `android-kernel` lane to `codemagic.yaml`: Linux instance,
`cd OpenSource/Engine/Android && gradle test` — minutes-cheap, runs on every PR, and is
the first CI gate in the repo that actually compiles kernel code (Swift only compiles
in the ios-app lane).
