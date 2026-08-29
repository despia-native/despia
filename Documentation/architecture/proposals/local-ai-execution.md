# Local-AI execution — the agent playbook

**Status: EXECUTION COMPANION** to `local-ai-engine.md` (the program, PROPOSED v2). That doc is
the law and the why; this one is the how: the workstreams, their gates, the merge order, and the
operational design of the standalone packages (Despia AI · Despia Local · Despia MCP). Read the
program doc first. House model: `full-stack-execution.md`. Status markers here are updated
in-place as workstreams land — LANDED with file pointers is how the next agent knows state.

## The mental model (internalize before touching anything)

1. **The kernel names no engine.** Everything ships as packages (`OpenSource/AI|Base|MCP`) +
   wrapper modules (`Core/LocalAI` scheme `intelligence` · `Core/Base` scheme `base` ·
   `Core/MCP` scheme `mcp`). LocalAI is the Dom of AI. No `dsx.ai` primitive, ever.
2. **The dynamic split law.** iOS forbids downloading executable code, so: **native capability is
   build-dynamic** — modules, nested provider children, per-app Custom zips, file-presence
   exclusion, cascade — and **everything declarative is runtime-dynamic** — the model catalog,
   `router.json`, the MCP server list, agent presets, all riding **one signed `dsx.content`
   generation** (atomic flip, one `content.updated` bell, sha256 per entry, seeded generation
   zero via a `content` mount). `config.json` holds only defaults, the catalog URL, and the
   signing anchor — it compiles to constants (`prepare_config.rb`) and cannot change without a
   rebuild. Never promise OTA native providers; never put mutable policy in config.
3. **The residency law.** The 21 kept actions STAY declared on the parent scheme `intelligence` —
   `contract_diff.rb` treats a chain move as a break. Provider children
   (`Core/LocalAI/Modules/{Voice,See,Converse,…}`) carry engine weight (`build` entries, vendored
   libs) and NEW actions on child chains (`intelligence.voice.*`). A parent action whose backing
   child is excluded answers typed absence. Children live under `Modules/` — the ONLY nested
   container (`NESTED_CONTAINER`, `prepare_modules.rb`); a `Providers/` folder with native code
   in it is invisible to both preparers (`Core/Server/Providers/*` survives only because it ships
   zero native weight).
4. **Corpus-first.** Fixtures merge in the same or an earlier commit than the implementation; a
   contract surface with no fixture is a review reject. The corpus layout is decided on day one —
   `Conformance/ai/{stream,tools,loop,absence,provider,remote,mcp,capabilities,modality}/` and
   `Conformance/local/{crud,vector,snapshot}/` — subfoldered so each package mirror can vendor
   exactly its slice. `capabilities/` gates evolution itself: adapt-to-reported-surface and
   catalog schema-tolerance cases (newer `schema_version` / unmet `requires` ⇒ skipped with
   typed absence). `modality/` gates the open I/O grammar (§4.14): typed input parts, typed
   output blocks, references-never-bytes for binary, unknown-block must-ignore with a typed
   notice.
5. **One VERSION per package, never the kernel's.** `Engine/VERSION` + `kernel_package_gate.rb`
   bind the kernel's three faces; the AI packages get their own `VERSION` files and their own
   gate (`ai_package_gate.rb`, Track P·a). A literal version anywhere is the drift.
6. **CI builds registry-neutral artifacts; the OPERATOR publishes.** The npm law
   (`OpenSource/Web/scripts/release-packages.ts`, `STRUCTURE.md` §"npm publishes from the closed
   CI") transplants to Maven verbatim: no credentials in CI, no publish command in any lane,
   signing and portal upload are operator-owned with 2FA.
7. **Mirror repos are generated, read-only trees.** `mirror_public.rb` replaces the mirror
   working tree on every sync; nothing is ever committed on a mirror. The monorepo is never
   tagged — `v<version>` tags are cut on mirrors by `tag_from`. Don't "fix" SPM by tagging the
   monorepo.
8. **Fit before load; routing is policy, never magic.** A model loads only if the fit verdict
   admits it (typed refusal below floor); the router resolves a task hint through
   `router.json` ∩ installed ∩ fit-passing with loaded-model stickiness, and every decision is a
   visible stream event. The `remote` leg is an explicit policy step to the app's own endpoint —
   there is no Despia endpoint.
9. **Say what is enforced.** Every public pillar traces to a gate (the no-telemetry static scan,
   the size budgets, digest verification, the license schema). A marketing sentence without a
   gate is a defect.
10. **The engine constitution — the core is itself a kernel.** The C++ core names no model
    family, no format, no tool dialect, no sampler: backends, dialects, templates, and samplers
    are REGISTERED components with capability manifests, and `despia_ai_capabilities()` is how
    every consumer learns what this build carries (the fit system and router adapt to it, never
    hardcode it). The ABI evolves additively only; every JSON envelope carries a
    `schema_version` with must-ignore semantics; anything unknown answers typed absence. The
    consequence that matters: **new model support is a catalog update first, an engine bump
    second, a rewrite never** — family-specific facts (`format`, chat `template` override,
    `tool_dialect`, `context_length`, `thinking`, sampling defaults, `status:
    active|deprecated|retired`) are catalog DATA, and retirement never disables an installed
    model. One scheduler (the resource governor) owns engine memory — priority classes in the
    ABI from E1, the full concurrent scheduler before V3.

## The executor protocol (read before your first commit — every workstream, every agent)

This program was designed once, deliberately, with the trade-offs recorded. The implementing
agent's job is to EXECUTE it, not to re-derive it. Twelve rules, non-negotiable:

1. **Truth hierarchy:** `constitution.md` > `local-ai-engine.md` (the program) > this doc > your
   judgment. On any conflict or genuine ambiguity: STOP, record the question as a D-row
   candidate in the PR description, and ask the owner. Never improvise architecture.
2. **Reuse-first, absolutely.** If your implementation seems to need a NEW script, CI lane
   step, bus primitive, notification channel, registry, or manifest key that this doc does not
   name — stop: either you've gone wrong or you've found a real gap. Ask; don't invent. (The
   named new things are: `ai_package_gate.rb`, `check_despia_<pkg>.rb`, the `conformance-ai`
   lane, `build_frameworks_test.rb`, the `path:` locator + xcframework tool, `prepare_ai.rb`
   IF W-TOOLS proves the need, the SBOM vendor collector, and the size/parity gates. That list
   is closed.)
3. **Fixtures first.** A contract surface without corpus fixtures in the same or an earlier
   commit is unmergeable. No exceptions for "obvious" behavior.
4. **A red gate means fix the code.** Never weaken, skip, fork, or "temporarily disable" a gate.
   A gate change is an owner decision, recorded in the PR that makes it.
5. **Scope discipline.** One workstream per PR. No drive-by refactors, renames, or style sweeps
   in neighboring code. The Wave 2 queue (CONTAINER → FACETS → STREAM → SWAP) is absolute.
6. **Never write an API from memory.** Before any FFI or vendored-library code, READ the actual
   header in `vendor/` and the existing seam files (`Cactus.swift`, `cactus_jni.cpp`). If a
   symbol is not in the header you just read, it does not exist.
7. **Copy the named template before writing.** Every workstream's read-first row (below) names
   its template files and its pinned shapes (Appendix). Start from those verbatim; diverge only
   where this doc says to, and say so in the PR.
8. **Pinned shapes are normative.** Appendix A is the starting point for every schema and
   symbol it covers. They evolve additively, through fixtures, with the change called out —
   never silently, never by preference.
9. **Gates before every commit:** the baseline four (+ Android twin), plus the conditional
   gates named per workstream, plus the brace/paren balance one-liner on changed Swift (UTF-8
   encoding explicitly). Swift is compile-pending locally; ride Codemagic, don't guess.
10. **Status markers update in-place, same commit** — LANDED with file pointers is how the next
    agent knows state. Never mark LANDED unless the workstream's "Landed" line is true
    verbatim; partial is written as PARTIAL with what remains.
11. **Report honestly.** Failing tests are reported with output; skipped steps are named as
    skipped. No model identifiers or assistant marketing names in any committed artifact.
12. **New public docs follow the house voice** (`Skills/documenting-a-module.md`) and every
    claim in them traces to a gate — an unenforced sentence is a defect, not copy.

**Read-first, per workstream** (in addition to the monorepo working rules, the program doc's sections named in
the workstream, and this protocol):

| Workstream | Read before writing |
|---|---|
| W-CORPUS | `Conformance/README.md` · `Conformance/errors/README.md` + `errors.json` (the case grammar) · `error-system.md` §3.7 (runner wiring) · Appendix A6 |
| W-CORE | Appendix A1/A5/A7 · `OpenSource/Engine/Package.swift` (header comments) · `Skills/module-frameworks.md` · `Skills/native-languages.md` |
| W-BUILD | `build_frameworks.rb` (whole file) · `generate_release_sbom.rb` (`collect_module_build_locks`) · `Skills/module-frameworks.md` |
| W-BASE | `Skills/writing-a-module.md` · `typed-module-api.md` · `Core/PowerSync/` (the boundary you must not cross) · `lint_docs.rb` rules |
| W-PKG | `kernel_package_gate.rb` (copy the architecture, not the checks) · `verify_release_source_state.rb` (`DEFAULT_REQUIRED_TRACKED`) |
| W-CATALOG | `Skills/module-weights.md` · `content-plane.md` + `Skills/module-content.md` · `HuggingFaceDownloader.swift`/`.kt` · `DeviceModelRecommender.*` · Appendix A2/A4 |
| W-CONTAINER · W-FACETS | `facet-contracts.md` · `Core/Legacy/dsx.json` + `Core/Server/Modules/Http/dsx.json` (live registrations) · `dsx_graph.rb:624-933` · Appendix A3 |
| W-STREAM | `Core/WebPlatform/SpeechRecognition/dsx.json` · `runtime-api.md` (stream/envelope sections) · Appendix A7 |
| W-SWAP | `Cactus.swift` · `Cactus.kt` · `cactus_jni.cpp` · `CactusInferenceManager.*` (both lanes) · `FETCH-LIBCACTUS.md` · `dependency_license_schema.rb` |
| W-TOOLS | `typed-module-api.md` · `Skills/action-contracts.md` · `Skills/cross-module-calls.md` · Appendix A3/A7 |
| W-ROUTER | Appendix A4 · the fit surface landed by W-CATALOG |
| W-MCPCLIENT · W-MCPSERVE | the official MCP SDK sources (read, don't recall) · `Mandatory/ContentServer/` + its security-guards test · `staging-and-testing.md` (origin validator) |
| W-VOICE | the D2 license audit RESULT first — no code before it · sherpa-onnx build docs (read, don't recall) |
| W-DESK | `desktop-platforms.md` · `settings-desktop.gradle.kts` · `compose-desktop-qualification.json` |

## What is already landed (do not rebuild)

| Wall | Where | What you get |
|---|---|---|
| Facet grammar + emitters | `dsx_graph.rb:624-933` (validation, rows) · `prepare_modules.rb` `emit_facet_declarations` · Android twin | Register a word with an object-form `facet:` block on the owner manifest; `emit:` generates `<Name>.generated.swift/.kt` into the owner's lanes with ZERO new script code. Unknown row-words abort; `ownAction` stale targets abort; enabled-claimant key collisions abort (the per-app conflict guard). Templates: `Core/Legacy/dsx.json` (richest), `Core/Server/Modules/Http` (`api`). |
| The word registry review surface | `Config/DespiaAssembly.json` | Today: activity · api · app · legacy · schema · server · watch · widget. `tools`/`provider` (Core/LocalAI) and `mcp` (Core/MCP) join it. |
| Nested modules | `prepare_modules.rb` `each_package_dir` · `dsx_graph.rb` `derive_chains!`/`resolve_disabled` | Container children under `Modules/`, chain-derived identity, cascade exclusion, MAX_CHAIN_DEPTH=4. |
| Mirror machinery | `ClosedSource/scripts/mirror_public.rb` + the `mirror-public` lane (manual/API-only) | A folder self-declares with `mirror.json` {repo, include, vendor, check, tag_from}; zero script/CI edits per new mirror. Live: CanvasEditor, vscode-dsx. |
| Binary provisioning | `build_frameworks.rb` (tools godot · cmake-android · fetch; locators npm:/github:/jsdelivr:/https:; per-module `dsx.lock.json`) | W-BUILD adds `path:` + an xcframework tool; everything else exists. |
| Content plane | `content-plane.md` · `Skills/module-content.md` | Content-addressed, atomic generations, SWR, `bundle_signing`, seeded via `content` mounts, `pinned: true`, 300 MB budget / 4096 entries. The catalog rides it today with zero new primitives. |
| Weights discipline | `Skills/module-weights.md` (incl. the runtime-download prescription) | Per-model pinned digest, verify before load, delete on mismatch — the catalog adopts it. |
| Stream grammar | `stream: true` + `events` + rid-correlated `dsx.event`; worked example `Core/WebPlatform/SpeechRecognition/dsx.json` | W-STREAM conforms `completion`/`listen` to it. |
| The engine seam | `Core/LocalAI/swift/Cactus.swift` · `kotlin/jni/cactus_jni.cpp` (JSON in/out + token callback) | W-SWAP replaces these files; controller/manager/snapshot/mic/recommender survive. |
| Device recommendation seed | `Core/LocalAI/*/DeviceModelRecommender.*` (advisory today) | W-CATALOG turns it into the enforced fit system. |
| Version-gate pattern | `kernel_package_gate.rb` (do NOT extend it — its §1 binds to Engine/VERSION) | `ai_package_gate.rb` copies the architecture: static, milliseconds, table-driven. |
| The unblock | this branch — the dead `ios_dir` guard deleted from `prepare_modules.rb` `emit_facet_declarations`, regression pinned in `prepare_modules_check_test.rb` | **W-UNBLOCK: LANDED.** Facet-word registration on a swift-lane owner no longer NameErrors. |

Baseline gates apply to every workstream and are not restated below: `prepare_modules.rb` ×2
idempotent · `prepare_modules_android.rb` ×2 · `lint_dsx.rb --strict` · `lint_dsx_css.rb
--strict` · `check_module_rules.rb`. Gates lines list only the conditional/new ones.

## The waves

Agent-parallelism is ACROSS packages and modules. Inside `Core/LocalAI` it is a QUEUE
(manifest-first, code-last, short-lived branches) — five workstreams touch that module and the
swap branch must not eat week-long rebases.

### Wave 0 — W-UNBLOCK · **LANDED**

The dead `ios_dir` guard (pre-lane-rename leftover) deleted; regression pinned. Nothing else in
the program was startable before this — every facet registration below runs through the fixed
path.

### Wave 1 — agent-parallel (six workstreams; CORPUS merges first)

**W-CORPUS** — the fixtures. · **PARTIAL** — the corpus is authored and parses (14 files, 113
cases: `OpenSource/Conformance/ai/{stream,tools,loop,absence,provider,remote,mcp,capabilities,
modality}/` + `base/{crud,vector,snapshot}/`, both READMEs carrying the case grammar and the
four normative host contracts). Fit lives in `capabilities/fit.json` and routing in
`remote/routing.json` — the nine folders are the stated layout, and the placement is recorded
in `ai/README.md` so nobody "fixes" it into new folders. REMAINS: the TS MockEngine runner
turning them green (W-CORE), then the Kotlin and Swift lanes.
- Scope: `OpenSource/Conformance/ai/**` + `base/**` with the day-one subfolder layout (law 4);
  per-corpus READMEs on the `Conformance/jse/README.md` model. Cases: streaming envelopes (rid
  correlation, `final`), tool round-trip (derived schema → dispatch → `role:"tool"` → resume),
  depth-cap, cancellation, typed absence, provider registration, **fit verdicts** (device
  profile × model requirements → verdict, on MockEngine), **routing decisions** (task hint ×
  installed × fit → chosen model + decision event), remote-policy routing, **capability
  adaptation** (MockEngine reports a surface; consumers adapt) and catalog schema-tolerance
  (skip-with-typed-absence); base CRUD / vector (incl. per-entry embedding metadata + typed
  mismatch on drift) / savepoint-snapshot-restore.
- Authority (the inverse of jse): these fixtures are hand-authored and ALL lanes run them in
  **verify mode**; there is exactly **ONE MockEngine** — the C++ mock behind the ABI, loaded by
  the Swift and Kotlin lanes — and the TS mock is a subordinate port gated by the same fixtures.
  The Swift runner is a NEW named `conformance-ai` mac lane (builds `bindings/swift` + the C++
  mock, runs the vendored corpus); it must be green at least once before W-SWAP lands — the
  jse `conformance-record` lane is record-mode and jse-bound, and is NOT this.
- Gates: fixture-schema lint until W-CORE's runners exist; then vitest per-PR, `:core` JUnit
  per-PR, the `conformance-ai` mac lane (no central registry).
- Landed: fixtures parse; the TS MockEngine runner is green.

**W-CORE** (program E1) — the Despia AI package exists. · **PARTIAL** — `OpenSource/AI/`
exists and builds: the C ABI (`engine/include/despia_ai.h`, 10 exported symbols and nothing
else — the .so's visibility is hidden by default, so the header IS the contract literally),
the C++17 core (backend REGISTRY, typed boundary validation, the streaming envelope with
delta-only token events, the crash-quarantine marker, a dependency-free JSON implementation),
the bounded pre-flight GGUF validator, MockEngine behind the ABI, the TS binding + subordinate
mock + the reference host (catalog · fit · router · tool loop · approvals · transcript · typed
absence), `conformance/run.ts`, `Package.swift` at the root with two products and zero
unsafeFlags, `CMakeLists.txt`, the Swift and Kotlin binding faces, VERSION/LICENSE/NOTICE/
CHANGELOG/README/llms.txt/PrivacyInfo.xcprivacy and the seven `docs/` pages.
  Verified locally: `engine/test/abi_test.cpp` — 40 checks green (clang++ and cmake);
  `node conformance/run.ts ai` — **87/87 corpus cases green**, which lands W-CORPUS's TS half.
  REMAINS, and none of it is a detail: (a) the llama.cpp/whisper.cpp/ggml import against ONE
  shared ggml — `vendor/VERSIONS` carries the pins and the rules, no tree is vendored yet, so
  this release runs on MockEngine only; (b) the SWIFT host — the Kotlin one is COMPLETE (96/96 drivable, `Host.kt` + `Delivery.kt` +
  `CorpusTest.kt`). The Kotlin lane (`bindings/kotlin-jvm`, `com.despia:ai-jvm`): it loads the real C++ MockEngine
  over JNI and runs `stream` · `capabilities/fit` · `remote/routing` green, so the corpus is on
  two runners of three for those and one for the rest. It found a REAL divergence on its first
  run — the C++ mock dropped scripted `usage` on the terminal event while the TS port carried
  it, which is exactly what a second runner is for; the emitter now has a terminal-payload hook
  and the C++ mock uses it. The Kotlin tool loop, approvals, delivery and MCP host remain; (c) the SPM week-1 tag-consumption proof and the Metal smoke, which need a
  mac; (d) the size gate and the libFuzzer target.
- Scope: `OpenSource/AI/` — `engine/` (`despia_ai.h` with `despia_ai_abi_version()` AND
  `despia_ai_capabilities()` — self-description from day one; the internal backend registry with
  per-backend capability manifests; envelope `schema_version` + must-ignore on both sides;
  request options reserve `priority` and budget fields for the governor; typed options
  validation at the boundary, no telemetry symbols; the crash-quarantine marker — written before
  every load/generate, cleared on success, read by fit on next launch; a libFuzzer target on the
  JSON boundary, run nightly, not per-PR); `vendor/` with pinned llama.cpp +
  whisper.cpp built against **ONE shared ggml** (three pins in `vendor/VERSIONS`; two vendored
  ggml copies is a duplicate-symbol/size trap); `mock/` (MockEngine — scripted, deterministic,
  what every per-PR gate runs); `bindings/{swift,kotlin,ts}/`; `conformance/` runner glue whose
  corpus path resolves `../../Conformance/ai` in-tree and `../conformance/ai` in the mirror;
  `Package.swift` at the **folder root** (mirror-root law, Track P·d); `VERSION`, LICENSE
  (Apache-2.0), NOTICE, README, CHANGELOG, `docs/`.
- Also in scope, week-1: `abi.md` gains the **threading and reentrancy contract** (callback
  thread identity; `cancel` legal from inside the callback; one context, one driver; blocking
  rules — tested in the JVM lane where threads are real); the **pre-flight validator** (bounded
  GGUF/format parser clearing every file before the real engine maps it — REQUIRED, since D16
  opens arbitrary origins at launch, and it is the fuzz target's subject); and the **SPM week-1
  proof**: a scratch iOS app consumes the package BY VERSION TAG from a mirror-shaped local
  checkout and runs a MockEngine call + a Metal-path smoke — proving compile without
  `unsafeFlags` now, not at the first mirror push (patching the vendored trees for
  ARC/safe-settings compatibility is sanctioned, noted in `vendor/VERSIONS`; if the proof fails,
  P·d's binaryTarget revisit triggers immediately, per its own condition). Package.swift
  declares the platform floor + tools version, and P·a checks them.
- Gates: `ai_package_gate.rb` (W-PKG) · the size gate (≤ 8 MB compressed core per platform — a
  new static check, enforced from day one) · vitest conformance vs MockEngine · kotlin JVM tests
  · Swift compile rides Codemagic (compile-pending locally, as always) · nightly, once E2 lands:
  a decode-tps **parity band** between the SPM-built and xcframework-built engines, so the OSS
  package never silently becomes the slow path.
- Landed: the package builds standalone on linux (TS + JVM), the ABI header is versioned, the
  mock passes the corpus, the SPM tag-consumption proof has run.

**W-BUILD** — the two generic `build_frameworks.rb` additions. · **PARTIAL** — both landed:
the **`path:` locator** (`path:<repo-relative-dir>@<version>`; the declared version must equal
the package's own VERSION or the run aborts; the pin records a CONTENT DIGEST over the tree —
every file's SHA-256 folded in sorted path order — because the release SBOM requires 64 hex
per locator and a git tree hash is SHA-1, so the plan's "git tree hash" phrasing is corrected
here) and the **`xcframework` tool** (per-slice compile → `xcodebuild -create-xcframework`,
cache keyed on digest+slices+settings, iOS device and sim only, soft-skip with a reason on a
lane without Xcode). `build_frameworks_test.rb` is NEW (none existed): 14 checks covering
pin determinism, the digest moving when the source moves, the stale-pin refusal, the
version-drift abort, malformed/missing/escaping locators, and the tool's declaration-time
refusals. Wired into the codemagic check chain + `DEFAULT_REQUIRED_TRACKED`;
`Skills/module-frameworks.md` documents both.
  Load-bearing finding: **the SBOM needs no change**. `collect_module_build_locks` requires a
  locator ending in an immutable `@version` plus a 64-hex sha256, and the recorded shape
  satisfies both — a test case asserts it, so this is decided here rather than the first time
  a release lane fails. REMAINS: the compile half is mac-only and unproven (it rides the iOS
  lane), and the Android 16 KiB page-size floor for new libraries is declared in the AI
  package's CMakeLists but not yet enforced by a check over `vendor/` prebuilts.
- Scope: `path:` locator (in-repo source, pinned as `path:OpenSource/AI@<VERSION>` with sha256 =
  the git tree hash of the path — `generate_release_sbom.rb`'s `collect_module_build_locks`
  rejects locators without an immutable version + digest, so the representation is decided HERE,
  not when the release lane first fails) · an `xcframework` tool (v1 fence: compile per slice,
  `xcodebuild -create-xcframework`, tree-hash cache key, iOS device+sim only — macOS slice is
  E5; no dSYM/codesign/Metal-bundling ambitions) · a NEW `build_frameworks_test.rb` (none exists
  today) · `Skills/module-frameworks.md` update · the SBOM collector handling · the Android
  **16 KiB page-size floor** for every new library (NDK r28+, or the explicit
  `max-page-size=16384` link flag, in the `cmake-android` usage; any prebuilt entering
  `vendor/` is ELF-verified 16K-clean at pin time).
- Gates: the new unit tests · `generate_release_sbom_test.rb` · prepare ×2 (no-op on the tree).
- Landed: a module manifest can declare `{"from": "path:OpenSource/AI@<VERSION>"}` and get a
  cached xcframework/.so, lock-pinned, SBOM-visible.

**W-BASE** (program B1) — the data plane. · **PARTIAL** — the PACKAGE is landed and green:
`OpenSource/Local/` with the same anatomy as AI (VERSION · LICENSE · NOTICE · README ·
CHANGELOG · llms.txt · PrivacyInfo.xcprivacy · four `docs/` pages · `Package.swift` at the
root · `vendor/VERSIONS`), the TS binding over **real SQLite** (`node:sqlite`, 3.51 — so
savepoints, `ROLLBACK TO`, `VACUUM INTO` and the crash cases are genuine, not simulated), the
Swift binding face (compile-pending), the Kotlin manifest, and `conformance/run.ts`.
  **`node conformance/run.ts` — 26/26 base cases green**, including the crash case that proves
  a committed write survives and an open savepoint does not, and the agent case that proves
  the snapshot exists BEFORE the first mutating dispatch. `ai_package_gate.rb` now runs 18
  checks across AI+Base, 0 failures.
  REMAINS: the `ClosedSource/DSX/Modules/Core/Base` WRAPPER module (scheme `base`) with its
  Swift and Kotlin facets and its README — deliberately its own commit, because the wrapper is
  where the module conventions and the `lint_docs` rules bite and neither lane compiles here.
  Also remaining: sqlite-vec (the TS binding scans JSON vectors, which is honest at fixture
  scale and is W-VEC's job to replace) and the Android no-exported-sqlite3-symbols proof.
- Scope: `OpenSource/Local/` (SQLite + savepoint/snapshot/restore/export core, bindings, VERSION,
  LICENSE/NOTICE/README/CHANGELOG/docs — same package anatomy as AI) + the wrapper
  `ClosedSource/DSX/Modules/Core/Base/` (scheme `base`; CRUD/savepoint/snapshot/restore/export
  actions; page + native + markup access). The wrapper README lands in the SAME commit as the
  manifest — `lint_docs.rb --strict` rule A fails the release chain otherwise.
- Gates: `dsx_graph_test.rb` (new module in the graph) · `contract_diff.rb` (all additive) ·
  base corpus (crud/snapshot) on TS + JVM · `lint_docs`.
- Landed: a DSX app can open a store, write, savepoint, snapshot, restore — fixtures prove the
  semantics; the transactional-write guarantee of the agent loop is a fixture, not a promise.

**W-PKG** (Track P·a) — the packages are born version-disciplined. · **LANDED** —
`ClosedSource/scripts/ai_package_gate.rb` (table-driven over AI/Base/MCP; a package that does
not exist yet is skipped with a note, so the gate is never red for unstarted work) +
`ai_package_gate_test.rb` (19 cases, each breaking ONE property in a scratch tree and
asserting the gate names it). Wired into the codemagic check chain beside
`kernel_package_gate.rb`, and both scripts added to `DEFAULT_REQUIRED_TRACKED` in the same
commit. Green: 9 checks on `OpenSource/AI`, 19/19 on the test.
  The test earned its keep immediately — it found three real weaknesses in the gate: the
  product check matched a same-named TARGET so a deleted product passed, a commented-out pin
  in `vendor/VERSIONS` counted as a pin, and the telemetry regex's trailing word boundary
  missed `analytics_report` (which is exactly how telemetry is spelled in real code).
- Scope: `ai_package_gate.rb` + test (Track P·a below has the check table); codemagic check-chain
  wiring; `verify_release_source_state.rb` `DEFAULT_REQUIRED_TRACKED` additions (same commit as
  each script).
- Gates: the gate's own test · the tagged-chain admission (tracked-file list).
- Landed: the gate is red/green on real trees; every later workstream inherits it.

**W-CATALOG** — pinned-digest delivery + the fit system. · **PARTIAL** — the POLICY half is
landed and fixture-proven on the TS host; the native half is what remains.
  Landed: the **four locks** (`bindings/ts/src/delivery.ts`) — the `allowed_model_hosts`
  https-only allowlist with the DevSettings wildcard grammar and a FAIL-CLOSED empty list;
  digest discipline (declared verifies, undeclared pins on first download and verifies
  forever after, mismatch DELETES rather than leaving the file to be retried into the
  loader); the pre-flight gate before any load; and fit + quarantine, which W-CORE already
  carried. `Conformance/ai/capabilities/delivery.json` — 12 cases, and each lock was
  **mutation-tested**: disabling the allowlist fails 3 cases, disabling the digest check
  fails 2, and loosening the wildcard to a bare suffix match fails the case written for
  exactly that bug. The **fit system** (verdicts, footprint-vs-mapped, the entitlement,
  calibration in both directions, quarantine, storage refusal) is green in
  `capabilities/fit.json`. The **HF importer** (`OpenSource/AI/tools/hf-import.ts` + 9 tests)
  resolves a branch to a COMMIT, records the digest and size, and reads the licence from the
  repo — refusing rather than guessing on all three. `docs/catalog-channel.md` documents the
  `/dsx/ai/` folder. `ai_package_gate` now scans `tools/` and names the importer as the one
  file allowed to reach the network.
  AI corpus: **99/99**. REMAINS: the `Core/LocalAI` Swift and Kotlin downloader changes
  (verify-before-load / delete-on-mismatch at the real call sites), the on-device probe
  (`os_proc_available_memory()` + the entitlement, storage, chip, thermal) and the calibration
  micro-benchmark — all native, none compilable here — plus the content-seed collision test.
- Scope: the catalog content folder (model entries with per-file sha256 + immutable revision +
  license id + **`requirements`** {min RAM, disk, chip floor} + seeded perf bands per device
  class — bands are PRIORS, calibration is the truth — plus the family-as-data fields of
  mental-model law 10: `format`, chat `template` override, `tool_dialect`, `context_length`,
  `thinking`, sampling defaults, `status` lifecycle; the catalog carries `schema_version` and
  per-entry `requires`, and the device-class table ships in the same generation as data);
  entries also carry `languages: []` and `inputs`/`outputs` from the modality vocabulary
  (§4.14), and `requirements` split **footprint-at-load** (resident weights + KV at
  `context_length`) from **mapped size**; the channel is the app's content root (`/dsx/ai/` —
  models OTA like screens; Despia's curated catalog is a merge-from upstream; blobs carry
  `urls: []` mirror lists); the **four-locks arbitrary-origin regime** (D16: `allowed_model_hosts`
  https-only allowlist with the DevSettings wildcard grammar · declared-or-pinned-on-first-
  download digests · the W-CORE pre-flight validator · fit + quarantine) and the **HF importer**
  (CLI + dashboard flow: repo+file → immutable revision → digest → license metadata → catalog
  entry); `Core/LocalAI` downloader files verify-before-load / delete-on-mismatch
  (`module-weights.md:79-96` prescription); the on-device probe (on iOS:
  `os_proc_available_memory()` + the `increased-memory-limit` entitlement's presence — the
  module declares the entitlement via the manifest `entitlements` machinery, and the typed
  refusal is computed against the limit the app will actually have; plus storage, chip
  generation, thermal/low-power state); **calibration** — a short first-run micro-benchmark per
  downloaded model, measured under a footprint-pressure pass, not only cold after download
  (cached per model+device, never transmitted);
  fit verdicts (`runs_well | runs_slow | too_big | unsupported | quarantined` + predicted/
  measured tps) on `models.available()`/`installed()` rows + a `models.fit` action; typed
  refusal below floor (the recommender becomes enforced); per-model on-disk size + a storage
  summary + typed low-disk refusal before an unfittable download; device class on the context
  plane; config keys declared editor-friendly (`friendly_name`/`type`/`options` per the
  config.json schema) so the dashboard surface needs no special-casing.
- Gates: contract_diff (kept names unchanged; `models.fit` additive) · catalog + fit fixtures ·
  the content-seed collision test.
- Landed: no unverified byte ever reaches an engine; every model row answers "will this run
  well HERE" honestly.

Merge order in Wave 1: **CORPUS → {CORE, BUILD, BASE, PKG} → CATALOG.**

### Wave 2 — the Core/LocalAI queue: W-CONTAINER → W-FACETS → W-STREAM → W-SWAP

**W-CONTAINER** — the module becomes a container. · **LANDED** —
`Core/LocalAI/Modules/See/` is the first child; `Core/LocalAI` is a container. The chain
**derives** (`intelligence.see` in `ModuleSchemes.generated.swift`/`.kt`, nothing hand-written)
and **cascade exclusion is free** — the assembly receipt records
`{rel: Core/LocalAI/Modules/See, state: excluded, causes: [{kind: entry, entry: Core/LocalAI}],
chain: intelligence.see}` with no exclusion rule authored anywhere.
  The child declares **no actions on purpose**: an action declared before its implementation is
  a contract with nothing behind it, and this workstream's job is the container shape, not a
  surface. `contract_diff` reads it as `✓ module see added` — additive, nothing moved, which is
  the gate that matters here. The residency law is written into both READMEs, naming the
  tempting break by name: `transcribe`/`listen`/`vad`/`diarize`/`speakerEmbed` belong to voice
  conceptually and moving them to a child chain would be a BREAK, so they stay on
  `intelligence` forever.
- Scope: `Core/LocalAI/Modules/` + the first child skeleton; the residency law (mental model 3)
  stated in the module README and enforced in review.
- Gates: `dsx_graph_test.rb` (chain derivation, depth) · contract_diff CLEAN (nothing moved).

**W-FACETS** — the words register. · **LANDED** —
**`tools` is registered** on `Core/LocalAI` verbatim from Appendix A3 (`key: "word"`; fields
`action` ownAction · `description` string · `mutates` string; `emit: "ToolsMap"`), and it now
appears in the word registry review surface: `DespiaAssembly.json` carries
`"tools": ["Core/LocalAI"]` beside the existing eight. The schema-is-DERIVED law is written
into the registration's `_note`, which is why the row has no `schema` field and never will.
  **`provider` is registered too, now that the grammar can say it.** It could not before: the
  grammar read ONE `facet` binding per module (`dsx_graph.rb` `facet_word` /
  `facet_declaration_registrations`) and `facet_declaration_errors` enforces "a namespace has
  ONE owner" — verified by making a second module claim `tools`, which aborts prepare with
  exactly that message. Appendix A3's "same owner, second registration" was not expressible,
  which is what **D17** raised. **D17 is RESOLVED by option (a): `facet` accepts an ARRAY.**
  An array element is a word String or an object-form registration, validated exactly as it
  would be alone — the array is repetition, not a second grammar. `facet_words` returns every
  word in manifest order and `facet_word` keeps naming the first, because folder and target
  binding stay single-valued. The one-owner law holds unchanged and now also holds WITHIN a
  module: binding the same word twice in one array is an abort, so the law cannot be dodged by
  self-collision. The wrong answer is still recorded: owning `provider` from a child would let
  excluding that child delete the whole namespace, taking every per-app provider row with it.
- Landed grammar: `dsx_graph.rb` gains `facet_bindings` / `facet_words` / `binding_word`;
  `prepare_modules.rb` types `facet` as `[String, Hash, Array]` and its `facet_registry` binds
  every word; `prepare_server.rb` asks `facet_words(...).include?('server')`. Six new cases in
  `dsx_graph_test.rb` cover the array registering per element, rows aggregating under a
  SECOND word, the one-owner law within a module and across two, and the junk/empty-array
  refusals. `DespiaAssembly.json` now carries `"provider": ["Core/LocalAI"]`.
- Gates: `dsx_graph_test.rb` 92/92 · `prepare_modules.rb` ×2 idempotent · the Android preparer
  ×2 idempotent · `lint_dsx --strict` 0/0 · `lint_dsx_css --strict` 0/0 ·
  `check_module_rules` 289 files 0 errors · `contract_diff` clean (a facet registration is not
  an action contract).
- Scope: object-form `facet:` blocks on `Core/LocalAI/dsx.json` for **`tools`** (fields:
  `action` ownAction · `description` string · `mutates` string — the JSON schema is DERIVED from
  the action's declared `args`, never restated in the row) and **`provider`** (fields:
  `modality` string · `serves` ownAction · `engine` string · `capabilities` object; `emit:
  "ProviderMap"`). NO `prepare_ai.rb` yet — the generic grammar (ownAction gate, collision
  abort) carries v1; the script is born in W-TOOLS only if cross-row semantics (mutates
  vocabulary, modality-id uniqueness) outgrow it, on the `prepare_server.rb` model. `facets.mcp`
  registration waits for its owner module (W-MCPCLIENT/W-MCPSERVE).
- Gates: `dsx_graph_test.rb` · golden diffs on the generated `ProviderMap`/`ToolsMap` emits ·
  contract_diff clean · `DespiaAssembly.json` diff reviewed (the word registry is the review
  surface).

**W-STREAM** — the envelope conforms, BEFORE the engine changes. · **PARTIAL** — the
MANIFEST half is landed: `completion` and `listen` on `Core/LocalAI` are now DECLARED stream
actions (`stream: true`, `events: ["token","sync","tool","routing","complete"]` and
`["token","sync","complete"]`), each with a streaming test carrying sequenced deltas and a
terminal event. `completion` also gains the router's `task` hint and `response_format` as
optional args, and `model` becomes optional — you now pass one or the other.
  **The gate the workstream demanded first is GREEN with no classifier work:** `contract_diff`
  reads the whole change as additive — `arg model required → optional`, two optional args
  added, and adding `stream`/`events` is not a change it flags at all (both are already in
  `SPEC_KEYS`). `--self-test` passes. So the "extend the classifier if not" branch never fired.
  The wire economics are written into the declaration's `_note` so they survive the swap: a
  `token` carries a sequence-numbered DELTA and never the text so far, `sync` is the
  late-joiner snapshot, `routing` names the model that answered, `complete` is terminal, and
  binary rides as a reference.
  REMAINS: the emission code in both lanes (Swift and Kotlin, compile-pending) and the
  one-release `broadcast` dual-emit whose retirement version is D13; and the stream fixtures
  run on ONE runner of three (TS, 99/99) until the Kotlin and Swift hosts exist.
- Scope: `completion`/`listen` declare `stream: true` + `events`; rid-correlated `dsx.event`
  emission; **the wire economics decided here** — `token` events carry sequence-numbered DELTAS
  coalesced to a stated cadence with a periodic/on-demand full-snapshot resync (the cumulative-
  snapshot-per-token shape is O(n²) over the bridge and does not become public grammar; a
  fixture asserts bounded per-event growth), and blocks use the open modality vocabulary
  (§4.14, references-never-bytes); the legacy `broadcast` mirror dual-emits with byte-identical
  payloads for exactly one release, **retired at the VERSION named in the program doc's D13**. Deliberately before
  the swap: the envelope lives above the seam, so proving it against Cactus isolates envelope
  bugs from engine bugs and the corpus fixtures run against both engines.
- Gates: FIRST verify `contract_diff.rb` classifies `stream`/`events` addition as additive
  (extend the classifier + `--self-test` if not) · stream fixtures on all three runners.

**W-SWAP** (program E2) — the critical path; the program's first shippable state.
- Scope: both lanes swap FFI files (`Cactus.swift`/`Cactus.kt`/`cactus_jni.cpp` → the Despia AI
  bindings); `restrictedDependencies` block deleted; `dsx.lock.json` drops
  `npm:cactus-react-native@1.13.1`, gains the `path:` pin; `kotlin/jniLibs/FETCH-LIBCACTUS.md`
  retired; JNI library named `libdespia_ai.so` (unique across modules; deps statically linked
  inside; no exported sqlite3 symbols — Base's SQLite coexists with PowerSync's copy, and that
  coexistence is documented, not discovered); `qa-expanded.json` gains LocalAI; the license
  schema drops the Cactus entry and gains llama.cpp/whisper.cpp/ggml (MIT); SBOM regenerated
  (needs the Track P·g vendor collector FIRST); a nightly real-inference smoke lane (tiny GGUF,
  greedy, loose asserts, mac builder — never per-PR; the model URL is digest-pinned and its
  hosting is an owned item, not an afterthought).
- The lifecycle law lands here too: inference is foreground-only by default; a background
  transition pauses or cancels per declared policy with a typed event; model downloads stay on
  the OS background-transfer APIs (already true) — the controller owns this, above the seam.
- Gates: contract_diff (21 kept names) · `check_dependency_licenses.rb --public-release` passes
  **with LocalAI enabled** · the size gate · full conformance on all three runners · the nightly
  smoke exists and has passed at least once.
- Landed: no Cactus byte anywhere in the tree or any artifact; Local AI runs on the owned engine
  on both phone lanes.

### Wave 3 — parallel after the swap

**W-SPEECH** (E3) — whisper.cpp behind `transcribe`/`listen`/`vad`/`detectLanguage`; nightly
smoke extended. **W-VEC** (B2) — sqlite-vec into Base; `index.*` re-pointed; `rag.*` FINALLY
declared in the manifest (clears the standing debt; contract_diff additive); every index entry
records its embedding (model id, dimension, revision) — mismatch is a typed error with an
explicit reindex path, fixture-proven. **W-REMOTE** —
the `remote` engine id + routing policy config (`local | prefer-local | remote-only`), endpoint =
the app's own backend, keys never in the app; routing fixtures. **W-ROUTER** — the intelligent
model router: `completion` accepts a `task` hint (chat · summarize · extract · agentic-tools ·
vision); resolution = `router.json` preference order ∩ installed ∩ fit-passing, with
loaded-model **stickiness** (a model swap costs seconds and hundreds of MB — prefer the resident
model when it satisfies the task) and the explicit remote step per policy; every decision is a
stream event (`routing` → chosen model + reason) so surfaces can show which model answered;
`router.json` lives in the SAME content generation as the catalog; task ids are an OPEN
vocabulary defined by the table itself (unknown hint → the declared default chain — next year's
task class is a data edit); v1 is deterministic — the tiny-classifier upgrade stays
criteria-gated in the program doc. Gates: routing fixtures on MockEngine ×3 runners ·
contract_diff (task arg additive). **W-TOOLS** (E4) — `facets.tools`
consumption (derived schemas for MODULE tools; MCP and page tools pass their JSON Schema through
VERBATIM), page tools (touches `OpenSource/Web` surfaces — web conformance gate applies), the
GBNF-constrained loop with **structured output** (`response_format: json_schema` → grammar) and
parallel tool dispatch where `mutates` allows, depth cap 32, `tool` stream events, transactional
writes over Base savepoints with the approval policies — **approval semantics per §4.6:
approve-before-execute for `prompt` tools (preview diffs from a shadow copy, never a held write
txn), a named approval timeout with default disposition, no engine or Base lock held while
pending, with fixtures asserting a concurrent Base write AND a concurrent completion both
succeed during a pending approval** — the untrusted-descriptions law (provenance-tagged;
`mutates` gated regardless of source), **per-tool deadlines + the loop watchdog** (a hung MCP
server or page callback yields a typed `tool_timeout` back to the model, never a stalled loop),
the **no-self-call law** (a tool resolving to the `intelligence` scheme is refused typed — a
`Conformance/ai/loop/` case), the **app-supplied output-filter seam** (gate-style hook over
generated text/tool intents; Despia ships the seam and the store-compliance doc, never the
filter), and the local ring-buffered **agent transcript** (DevSettings-exportable, never
transmitted); `prepare_ai.rb` born here if the grammar needs it. Serialized after FACETS +
SWAP + BASE. **W-MCPCLIENT** (M1) — `OpenSource/MCP/`
package + `Core/MCP` wrapper; official Swift/Kotlin SDK deps enter gradle/SPM locks + the
license schema; Streamable HTTP client; tools join the registry namespaced; transport can build
parallel to W-TOOLS, registry integration merges after it.

### Wave 4 — launch closers

**W-VOICE** (V1) — the `Core/LocalAI/Modules/Voice` child: sherpa-onnx + Kokoro/Piper voices;
**ENTRY GATE: a copyleft-free static-link graph** — the sherpa-onnx TTS path for these voice
families phonemizes through espeak-ng (GPL-3.0), which can never ship inside the Apache-2.0
package; the transitive audit of the TTS build graph (onnxruntime MIT · protobuf BSD ·
kaldi-native-fbank Apache · piper-phonemize MIT · espeak-ng GPL) plus a permissive phonemizer
path or replacement is the first task, and D2/D7 close together on its result. Synthesis plays
NATIVELY in the child (control/progress events on the bus; per-utterance loopback URL for pages
— PCM never rides JSON); streaming synthesis events (depends W-STREAM); `diarize`/`speakerEmbed`
land here; voices are per-language catalog data with a fit-shaped typed absence for unserved
locales; the child carries **its own named size budget** (onnxruntime is tens of MB; the 8 MB
core gate deliberately does not cover it, and the child is excludable); D7 — the default voice
SET per locale — blocks final merge; schedule the owner call early, not launch week. **W-SEE** (V2) — the `Modules/See` child: llama.cpp multimodal
(VLM GGUFs); the `Core/Vision` OCR `facets.tools` row — the first FOREIGN-module tool row, the
dogfood of the whole mesh-toolbox claim. **Track P closers** — W-MIRROR (the three
`mirror.json`s + per-package `check_despia_<pkg>.rb` + the `tag_from` bare-file extension),
W-MAVEN (the staging lane + operator runbook), W-DOCS (the per-package docs sets), W-HYGIENE
(P·g).

**The launch checklist** (the program's cut line, as checkboxes):
1. E1–E4, B1/B2, M1, V1, V2 rows all LANDED above.
2. `ai_package_gate` green on all three packages; size budgets green.
3. `check_dependency_licenses.rb --public-release` green with LocalAI enabled; SBOM covers
   `vendor/` trees.
4. First real `mirror_public.rb` push (after `--dry-run` review) → `despia-native/despia-ai`,
   `despia-local`, `despia-mcp` live with `v<VERSION>` tags; SPM install verified FROM the mirror.
5. Operator Maven publish per runbook (namespace + GPG done back in the E2 window).
6. **W-FLIP**: `Core/LocalAI`/`Core/Base`/`Core/MCP` lock entries flip `path:` → `github:`
   locators against the mirror tags; one full gate cycle proves the flip.
7. The program doc's status markers updated; `on-device-ai.md`'s "Honest status" rewritten to
   the new truth (the prototype paragraph dies).
8. The **v4 drop-in artifact** is cut from the same tag (the engine bundle the shipped v4
   runtime consumes at its Cactus seam) and the v4 swap has a dated owner commitment (D14) —
   launch marketing must not outrun the runtime where the liability actually lives.

### Wave 5 — post-launch

**W-MCPSERVE** (M2) — the loopback local MCP server: the transport is REAL WORK, named — the
official SDKs supply clients, so the **Streamable-HTTP server framing is implemented on the
existing in-house loopback daemon** (the content-server substrate; dynamic ports already
default) against the SDK's server API, no Ktor/Vapor; per-session token; the **external-host
handshake** — a 0600 per-app discovery file (current port + a pairing token distinct from
session tokens, written only while consent stands) + a stdio-to-loopback launcher so static
agent-host configs work against our dynamic port; `facets.mcp` rows (actions + Base queries as
served tools); approve-before-execute wired through Base; the threat sentence in
`local-server-security.md` (loopback is reachable by co-resident apps — the token is the
boundary, never in a URL); gates extend the content-server security-guard suite to the new
transport. **W-DESK** (E5) — macOS slice on the Swift lane; win-x64/linux-x64 JNI natives on the
Kotlin desktop lane — including the **JVM Maven shape**: an AAR cannot serve Compose Desktop, so
`com.despia:ai-jvm` (plain JAR + per-OS classifier natives + an extract-and-`System.load`
loader with a version-keyed cache and typed-absence fallback) is a second, designed artifact
(P·c), not an afterthought; `platforms: ["phone","desktop"]` becomes true. **W-GOVERNOR** — the full
concurrent scheduler the E1 foundations reserved: priority classes enforced, declared budgets,
LRU model unload under memory pressure, thermal/low-power throttling; single-flight relaxes into
scheduled concurrency. **A hard dependency of W-CONVERSE** — the pipeline runs STT + LLM + TTS
simultaneously, and "conversation will be easy later" is exactly the assumption this workstream
exists to kill. Gates: governor fixtures on MockEngine (priority, eviction, budget refusal) ×3
runners. **W-CONVERSE** (V3, after W-GOVERNOR) — the duplex voice pipeline (VAD → streaming STT
→ LLM → streaming TTS, barge-in, mid-call tools); the latency budget IS the gate. **W-EVAL** —
the catalog/router promotion gate: a small deterministic task suite per task class, run on the
mac builder against candidate catalog/router generations; minimal v1 (a handful of exact-match
checks per class) — promotion of a content generation requires a green run once this lands.
**G** (image gen) and **K** (own kernels) stay criteria-gated in the program doc and have no
wave until their criteria are met.

## Track P — the standalone packages (publish, version, document)

### P·a Versioning — `ai_package_gate.rb`

A NEW static gate, table-driven over {AI, Base, MCP}. Do NOT extend `kernel_package_gate.rb` —
its §1 binds to `Engine/VERSION` (the exact coupling the placement law forbids) and its other
sections are kernel-only. Copy its architecture: static, milliseconds, no toolchain. Per
package:

1. `OpenSource/<P>/VERSION` — bare semver.
2. `bindings/kotlin/**/build.gradle.kts` — `group == "com.despia"`, artifactId `ai|base|mcp`,
   and the `version =` line DERIVES from the package VERSION file (the kernel gate's
   "a literal here is the drift" check, re-pointed).
3. `Package.swift` at the package ROOT; static parse: expected products (`DespiaAI` +
   `DespiaAIVoice` for AI); **zero `unsafeFlags`** (SPM refuses versioned consumption of a
   package that uses them — a silent tag-killer).
4. `bindings/ts/package.json` — version == VERSION and **`private: true`** until the npm
   decision flips (P·e).
5. LICENSE is the Apache-2.0 text; NOTICE exists; every `vendor/<name>/` has a NOTICE line and
   a `vendor/VERSIONS` pin (name, upstream commit, license id).
6. `CHANGELOG.md` has a `## <VERSION>` heading; README carries install coordinates + an example
   fence (the cheap 5-part proxy).
7. `mirror.json` coherence — `tag_from` resolves to the VERSION source; `include` covers
   VERSION/LICENSE/NOTICE/Package.swift/docs.
8. **The no-telemetry static scan** over `engine/` + `bindings/`: deny URL literals outside the
   downloader's allowlisted file, deny telemetry/analytics symbols — the "no backdoors" pillar
   as a gate, not prose.
9. **llms.txt freshness** — each package's `llms.txt` lists exactly `docs/*.md` (the index stays
   true or the gate is red; an unfresh llms.txt would be an overclaim).
10. **Privacy manifests** — each package ships `PrivacyInfo.xcprivacy` (no tracking, declared
    required-reason APIs only); Apple requires it of third-party SDKs, and its absence blocks
    consumer App Store submissions.

Wire into the codemagic check chain when `OpenSource/{AI,Base,MCP}` is touched; add the script +
its test to `DEFAULT_REQUIRED_TRACKED` in the same commit. Version relationship, stated once:
package `VERSION` is semver and independent; the WRAPPER module's `dsx.json` version moves only
for contract reasons (`contract_diff` MAJOR retirement) — the two never derive from each other.

### P·b Mirrors — one `mirror.json` per package

Model: `OpenSource/Engine/mirror.json` (its `_note` is the schema doc). Per package:

- `repo`: `despia-native/despia-ai` · `despia-local` · `despia-mcp` (final naming = program D11).
- `include`: README, LICENSE, NOTICE, CHANGELOG, CONTRIBUTING, VERSION, Package.swift, llms.txt,
  `engine/`, `vendor/`, `mock/`, `bindings/`, `conformance/`, `docs/`.
- `vendor`: AI grafts `{"conformance/ai": "OpenSource/Conformance/ai"}`; Base grafts
  `conformance/local`; MCP grafts only `conformance/ai/mcp` — the reason the corpus is
  subfoldered on day one.
- `check`: a linux-runnable `check_despia_<pkg>.rb` — `ai_package_gate` + TS conformance vs the
  corpus + kotlin JVM tests. **Swift compilation is NOT in the mirror check** (the mirror lane
  is not pinned to a mac); Swift proof rides the mac lanes.
- `tag_from`: `VERSION` — requires the ~3-line `mirror_public.rb` extension (today it
  `JSON.parse(...)["version"]`; teach it a bare-semver file). One source, no indirection.

The mirror's own `npm test`/gradle test passes standalone because the runner glue resolves the
vendored corpus path — exactly the CanvasEditor jse pattern.

### P·c Maven Central — the lane and the runbook

- **The artifact matrix, decided now**: `com.despia:ai` (AAR, Android) AND `com.despia:ai-jvm`
  (JAR + per-OS classifier natives + loader — the Compose Desktop face; Base/MCP analogous).
  The P·a gate table covers BOTH artifacts' version derivation, and the staging lane bundles
  both.
- **CI stages, never publishes**: gradle publish to a LOCAL staging repo → bundle: AAR (+ per-ABI
  JNI `.so`s) + the JVM jar set · sources jar · a **deliberately minimal javadoc jar** (Central
  requires the jar to exist, not to be rich; no Dokka enters the repo — recorded so nobody
  "fixes" it) · POM (Apache-2.0, scm → the mirror repo) · SHA256SUMS + a provenance JSON binding
  commit/tree/tag (the `release-packages.ts` record shape). The staging lane also runs the
  existing 16 KiB page-size ELF check (`verify_android_16k.sh`'s `llvm-readelf` LOAD-segment
  pass) over **every `.so` inside the staged bundles, third-party prebuilts included** — a
  consumer's Play submission failing on our alignment would be an adoption-killing first
  impression. No signing config, no credentials, no publish command in CI.
- **Operator runbook** (ClosedSource release docs, not the public package): fetch the CI bundle →
  verify sums + provenance against the tag → GPG detach-sign locally → assemble the Central
  Portal bundle → upload with the operator token → release in the portal with 2FA. Credentials
  and the GPG key exist only on the operator machine (the `MIRROR_PUSH_TOKEN` custody model).
- **Lead-time items scheduled in the E2 window, NOT launch week**: `com.despia` namespace
  verification (DNS TXT on despia.com — also covers the kernel's `com.despia.dsx`, coordinate),
  GPG key generation + keyserver publish.

### P·d SPM — the package shape

`Package.swift` at `OpenSource/AI/` root; targets point into the real folders (`path:`): C
targets at `vendor/llama.cpp`, `vendor/whisper.cpp` (both against the one shared ggml),
`engine/`; the Swift target at `bindings/swift/Sources/DespiaAI`; Metal shaders as resources.
Products: **`DespiaAI`** (core) and **`DespiaAIVoice`** (the sherpa-onnx-dependent voice stack) —
multi-product is how SPM consumers get the excludability DSX apps get from child modules.
**Source targets in v1, not `binaryTarget`**: source costs consumers compile minutes but is
zero-hosting, tag-safe, and debuggable; a binaryTarget needs a per-release XCFramework zip whose
checksum is WRITTEN INTO Package.swift — and the mirror tree is REPLACED every sync, so that
checksum write-back is an undesigned chicken-and-egg. If consumer compile time becomes an
adoption blocker, the checksum-commit-back lane becomes its own designed workstream — it is not
a tweak. The DSX app build meanwhile consumes via W-BUILD's xcframework tool + `path:` locator:
two consumption paths, deliberately different, one tree.

### P·e npm — deferred, deliberately

The TS binding is types + MockEngine (no browser inference in v1). Do not publish a shell under
the Despia name. Two cheap actions now: the operator reserves the npm scope; `bindings/ts/
package.json` stays present, `private: true`, version-gate-bound — the day a real consumer
appears (server-side MCP host, a wasm revisit), the face is already disciplined.

### P·f The docs set — per package, hand-written, gate-checked

- **README.md** — the 5-part house shape (`OpenSource/Web/packages/*/README.md`): title +
  one-liner → install (SPM URL + tag, gradle coordinate) → ~10-line example → an
  honest-properties paragraph where EVERY claim is gate-traced → pointer to `docs/`. No badges.
  Voice per `Skills/documenting-a-module.md` (plain sentences, contractions, no marketing
  vocabulary).
- **docs/** — AI: `getting-started-ios.md`, `getting-started-android.md`, `abi.md`,
  `models-and-licenses.md` (catalog format, digests, fit metadata, per-model terms),
  `tools-and-loop.md`, `routing.md`, `voice.md`; Base: `data-plane.md`, `snapshots.md`; MCP:
  `client.md`, `local-server-security.md` (loopback + token + consent, fixture-referenced);
  all: `conformance.md` (run the vendored corpus).
- **llms.txt** — the index of `docs/*.md`, freshness-gated (P·a check 9); the Despia signature
  move, kept honest by the gate.
- **CHANGELOG.md** — one `## <VERSION>` heading per release, gate-checked.
- **CONTRIBUTING.md** — short and honest about the mirror: the repo is generated, so external
  PRs cannot merge here; contributions are accepted via DCO sign-off and a maintainer ports the
  patch into the monorepo with `Co-authored-by` attribution (D15); fixtures-first applies to
  contributions too.
- **SECURITY.md** — private disclosure (security@despia.com), supported-versions table, the
  advisory-response expectation; per mirror.
- **docs/store-compliance.md** (AI packages) — the founder-facing guidance Despia's audience
  needs: age-rating questions for generative features, the output-filter seam and when review
  expects one, privacy-declaration answers (on-device = no data collection to declare for
  inference itself), and the consent pattern for AI features (the shipped v4 doc's precedent).
- **A provider-authoring Skill** — `OpenSource/Skills/writing-an-ai-provider.md`: the worked
  recipe for a per-app Custom provider module (manifest rows, the child-module shape, the
  backend-registration seam, what the collision aborts mean) — the "add an output nobody has
  built" promise needs its recipe or it isn't real. Same workstream fixes the stale Custom-zip
  layout example in `guides/codemagic-build.md` (predates rule 11).
- **LICENSE / NOTICE** — Apache-2.0 full text at each package root (the repo's first);
  NOTICE with vendored attributions; vendored trees keep their upstream LICENSE files in place.
- Enforcement: all package-side checks live in `ai_package_gate.rb` (one gate, not a second docs
  linter). The Core/* WRAPPER modules are covered by `lint_docs.rb` for free.

### P·g Repo hygiene at launch

1. The Apache-2.0 texts + NOTICEs (above).
2. `production-minimal.json`: the AI modules stay ABSENT — deliberately unclassified opt-in
   weight, recorded in the profile `_note` (a hand-edit outside the allowlist gets reverted by
   regen; a documented absence is the only durable "no"). `qa-expanded` gains LocalAI in W-SWAP.
   · **LANDED** — the `_note` now says so by name (Core/LocalAI and its `Modules/` children,
   Core/Base, Core/MCP), and says WHY an absence needs writing down at all: the profile is an
   allowlist, so an unclassified package is already excluded, but an unexplained absence reads
   as an oversight and the next reader "fixes" it.
   **Unrelated pre-existing failure, found while verifying and NOT touched:**
   `validate_release_readiness.rb` reports `excluded.json: not the byte-exact resolved
   production-minimal profile` (85 passed, 1 failed). It reproduces at `ef59315b`, before any
   of this program's commits, so it is neither caused by nor in scope for these workstreams —
   recorded here rather than silently repaired inside an unrelated diff.
3. `DEFAULT_REQUIRED_TRACKED` += every new script in the tagged chain, same commit as the script.
4. **SBOM**: a NEW collector reading `vendor/VERSIONS` (no existing collector sees
   `OpenSource/*/vendor/` snapshots) → CycloneDX components + a `generate_release_sbom_test.rb`
   case; plus the `path:` locator lock representation (W-BUILD). Lands BEFORE W-SWAP's "SBOM
   regenerated" claim. · **LANDED** — `collect_vendored_packages` walks `OpenSource/{AI,Base,
   MCP}/vendor/`, reads the pin record, and emits one `pkg:generic/<name>@<pin>` component per
   vendored tree. It FAILS CLOSED three ways, each with a test: a tree on disk with no pin
   raises (shipping bytes nobody declared is the failure this exists to prevent), a mutable pin
   raises (`latest` is not a snapshot, and an SBOM recording one is worse than none because it
   looks authoritative), and a malformed line raises. A COMMENTED pin is deliberately not a
   component — the packages record intended pins as comments while the import is pending, and a
   package with pins but no trees contributes nothing, quietly. Verified on the real tree (173
   components, unchanged) and by dropping an unpinned tree in, which raises. The `path:` locator
   representation needed no collector change (W-BUILD).
5. License schema: Cactus entry deleted (W-SWAP); llama.cpp/whisper.cpp/ggml (MIT), sqlite-vec,
   sherpa-onnx (Apache-2.0), MCP SDKs (MIT) added as they arrive — AND the schema gains a
   **`copyleft` classification dimension**. · **LANDED** —
   `DSXDependencyLicenseSchema::COPYLEFT_CLASSIFICATIONS` + `copyleft_classification?` /
   `declarable_classification?`. Two consequences, both load-bearing:
   (a) **copyleft is now DECLARABLE.** Before this, putting a GPL dependency in
   `restrictedDependencies` RAISED ("must use Restricted, Proprietary, Commercial, or
   NOASSERTION"), so the only way to keep a build green was not to declare it — the gate
   taught people to hide exactly what it exists to catch. A copyleft entry is now accepted and
   gated like any other restricted one.
   (b) **the open packages refuse it outright** (`ai_package_gate.rb` check 5b, now 20 checks):
   a `vendor/VERSIONS` pin under a copyleft licence fails, because these packages are
   statically linked into customers' apps and promise unrestricted commercial use.
   Membership is about STATIC linking: LGPL is in (the dynamic-linking escape does not survive
   a static mobile binary), MPL-2.0 and CDDL are out (file-level, they do not reach the
   combined work), and `CC-BY-SA` is matched on its own tokens. Verified against 12 real
   licence ids and by three gate cases including the espeak-ng shape itself.
   **This is W-VOICE's entry gate, now enforcing before D2/D7 resolve** — when the audit
   lands, the thing that fails a bad answer already exists.
6. The monorepo stays tag-free — v-tags live on mirrors only (mental model 7).

## Production readiness — the road to 100%

Everything above describes the program. This section is the completion plan for it: what
remains, in what order, and where each piece can actually be compiled. It is scoped to **code
and compilation**. Device matrices, nightly smoke lanes, the `conformance-ai` mac lane, store
submission and release orchestration are deliberately OUT — not forgotten, excluded.

### What "no mock data" means, precisely

The distinction matters because one thing that looks like mock data is load-bearing and stays.

**MockEngine stays, and it is not the problem.** It is the deterministic backend every
per-PR gate runs against, mandated by the program (§7: "all mock-backed so gates never
download a model"). Deleting it would mean every gate needing a multi-gigabyte model, which
is how a corpus stops being run. It is a registered backend beside `gguf`, selected only by a
catalog entry that names `"engine": "mock"` — no product path can reach it.

**What must become real, and currently is not:**

| Surface | Today | Production |
|---|---|---|
| Inference | MockEngine only — no vendored engine exists | llama.cpp behind the `gguf` backend |
| Speech | nothing | whisper.cpp behind `transcribe`/`listen`/`vad` |
| The host (catalog · fit · router · loop · approvals · delivery) | complete in TS; partial in Kotlin; absent in Swift | all three complete |
| Model download | delivery POLICY in TS; the four locks are fixtures | real background transfer on both phone lanes, verify-before-load |
| Device probe · calibration | fixture inputs | real `os_proc_available_memory()`, entitlement, thermal, storage, and a real micro-benchmark |
| Despia Local native | Swift partial, Kotlin absent, no vectors | full surface both lanes, sqlite-vec |
| MCP | nothing | client + loopback server |
| `Core/LocalAI` engine seam | Cactus | Despia AI |

### The compile matrix — where each thing can be built

Stated up front because it determines who can do what, and half of this program cannot be
compiled in the environment these workstreams have been executed in so far.

| Lane | Toolchain | Buildable in the Linux dev container | Notes |
|---|---|---|---|
| C/C++ core, MockEngine, GGUF, whisper | clang++/cmake | **yes** | the engine is fully verifiable without a phone |
| TS binding + host | node 22 | **yes** | |
| Kotlin/JVM binding + host | JDK 21 + gradle | **yes** | JNI to the real core included |
| Ruby gates | ruby 3.3 | **yes** | |
| Android AAR + NDK `.so` | Android SDK + NDK r28+ | no | needs an SDK image |
| Swift package, iOS/macOS slices | Xcode | no | **compile-pending, rides a mac** |

The consequence to plan around: **the engine, both non-Swift hosts, and every gate can be
written AND compiled without Apple hardware.** Swift is the only lane whose compilation is
unverifiable here, and it is ~35% of the remaining line count.

### The remaining workstreams

Ordered by dependency. "Size" is rough implementation lines, excluding fixtures.

**Phase 0 — unblock (not code).** D17 (`provider` word placement, blocks W-FACETS), D2/D7
(the copyleft audit and default voices, block W-VOICE). Everything else can proceed around
them.

**Phase 1 — the real engine.** The critical path; nothing downstream is real without it.

| # | Workstream | Deliverable | Size | Compile here |
|---|---|---|---|---|
| 1 | **W-VENDOR** *(new)* | llama.cpp + whisper.cpp + ggml imported under `vendor/`, built against **ONE shared ggml** (whisper bundles its own; de-duplicating it is real porting work), pinned in `vendor/VERSIONS`, symbol-hidden, 16 KiB-clean, `NOTICE` updated. Includes the decision this forces: committed sources vs fetched-at-sync, since SPM source targets need them present in the mirror. | vendored + ~200 of build glue | yes |
| 2 | **W-GGUF** *(new)* | `engine/src/backends/gguf/` implementing `Backend`: model load/unload with mmap and KV sizing from `context_length`; chat-template application (catalog `template` override or the model's own); sampling from catalog defaults plus request options; token streaming into `Emitter::block`; cancellation by polling `out.cancelled()` in the decode loop; **JSON Schema → GBNF** for structured output; tool-call extraction per `tool_dialect`; embeddings; `tokenize`/`score`/`prefill`; a capability manifest reporting what was actually compiled in. Symbols come from the vendored headers — read them, never recall them. | ~1,500–2,500 | **yes** |
| 3 | **W-WHISPER** *(new)* | The speech backend: `transcribe`, streaming `listen` with partials, `vad`, `detectLanguage`; audio resampling to 16 kHz mono; streaming partials as text deltas on the same envelope. | ~600–900 | **yes** |
| 4 | **W-GOVERNOR** | Per-context memory accounting, priority classes enforced, LRU model unload under pressure, thermal/low-power throttling. The ABI already reserves `priority` and the budget fields. | ~400–600 | **yes** |

**Phase 2 — the hosts, three times.** The four host contracts plus the tool loop, approvals,
transcript, delivery locks, MCP registry and typed absence. TS is the reference and is done.

| # | Workstream | Deliverable | Size | Compile here |
|---|---|---|---|---|
| 5 | **W-HOST-KT** · **LANDED** — 96/96 drivable cases green on the Kotlin host over the real C++ MockEngine; the 3 remaining need a step to land mid-stream, which the asynchronous native worker cannot serve from a synchronous driver, and they are covered instead by dedicated native tests. Mutation-tested: dropping the no-self-call law fails 1 case, dropping the approval gate fails 6. | Complete the Kotlin host to 99/99: tool loop with depth cap and parallel dispatch, approvals with virtual-clock timeouts, delivery's four locks, catalog tolerance, modality blocks, typed absence, MCP registry. | ~900 | **yes** |
| 6 | **W-HOST-SW** | The same in Swift, plus the C-ABI binding completion. | ~900 | no — pending |

**Phase 3 — the module layer.** `Core/LocalAI` stops being a prototype.

| # | Workstream | Deliverable | Size | Compile here |
|---|---|---|---|---|
| 7 | **W-SWAP** | Replace the FFI seam (`Cactus.swift` 738 · `cactus_jni.cpp` 683 · `Cactus.kt` 181 ≈ 1,600 lines) with the Despia AI bindings. The other ~6,400 lines of controller/manager/snapshot/mic/RAG survive. Delete `restrictedDependencies`; drop the npm Cactus pin for the `path:` pin; retire `FETCH-LIBCACTUS.md`; name the JNI library `libdespia_ai.so` with no exported sqlite3 symbols; licence schema drops Cactus and gains llama/whisper/ggml; `qa-expanded` gains LocalAI; `--public-release` passes with it ENABLED. | ~1,600 rewritten | partly (Kotlin/JNI yes, Swift no) |
| 8 | **W-DOWNLOAD** *(new)* | The real downloader on both lanes: background transfer that survives app death, resume, the four locks enforced at the real call sites, verify-before-load, delete-on-mismatch, pin-on-first-download persisted. | ~500 both lanes | partly |
| 9 | **W-PROBE** *(new)* | The real device probe and calibration: `os_proc_available_memory()`, the increased-memory-limit entitlement declared through the manifest, storage, chip class, thermal/low-power; the first-run micro-benchmark measured under footprint pressure and cached per model+device, never transmitted. | ~400 both lanes | partly |

**Phase 4 — the data plane.**

| # | Workstream | Deliverable | Size | Compile here |
|---|---|---|---|---|
| 10 | **W-BASE-NATIVE** | Complete the Swift binding (query, vectors, snapshot listing, export, stats) and write the Kotlin one; vendor sqlite-vec; the Android library exporting no sqlite3 symbols so a sync vendor's own SQLite coexists. | ~1,200 | partly |
| 11 | **W-BASE-MODULE** | `Core/Base` wrapper (scheme `base`) with both facets and its README in the same commit. | ~600 | partly |
| 12 | **W-VEC** | `index.*` re-pointed to Base, `rag.*` finally declared, per-entry embedding provenance enforced at the real call sites. | ~300 | partly |

**Phase 5 — MCP.**

| # | Workstream | Deliverable | Size | Compile here |
|---|---|---|---|---|
| 13 | **W-MCPCLIENT** | `OpenSource/MCP/` package (full anatomy, so the package gate covers all three), official Swift/Kotlin SDKs pinned, Streamable HTTP client, namespaced registry integration, `Core/MCP` wrapper. | ~1,200 | partly |
| 14 | **W-MCPSERVE** | The loopback server: Streamable-HTTP framing on the existing in-house daemon (no Ktor, no Vapor), per-session token, the 0600 discovery file and stdio launcher, `facets.mcp` rows, approve-before-execute through Base. | ~1,000 | partly |

**Phase 6 — modalities.**

| # | Workstream | Deliverable | Size | Compile here |
|---|---|---|---|---|
| 15 | **W-SEE** | `Modules/See` gains its engine weight: llama.cpp multimodal, `describe`, and the `Core/Vision` OCR tool row — the first foreign-module tool. | ~600 | partly |
| 16 | **W-VOICE** | **Blocked on D2.** sherpa-onnx with a copyleft-free static-link graph, Kokoro/Piper voices, native playback with loopback URLs, streaming synthesis, `diarize`/`speakerEmbed`, its own size budget. | ~1,200 | partly |
| 17 | **W-CONVERSE** | The duplex pipeline over the others: VAD → streaming STT → LLM → streaming TTS, barge-in, mid-call tools. Depends on W-GOVERNOR. | ~800 | partly |

**Phase 7 — desktop and packaging.**

| # | Workstream | Deliverable | Size | Compile here |
|---|---|---|---|---|
| 18 | **W-DESK** | macOS slice on the Swift lane; win-x64/linux-x64 JNI natives; the `com.despia:*-jvm` loader with a version-keyed extract cache and typed-absence fallback; `platforms` becomes true. | ~600 | linux yes |
| 19 | **W-SIZE** | The ≤8 MB compressed core budget as a static gate, and the SPM-vs-xcframework decode parity band. | ~200 | yes |
| 20 | **Track P closers** | The three `mirror.json` files, `check_despia_<pkg>.rb`, the `tag_from` bare-file extension, the Maven staging assembly, the per-package docs sets, `writing-an-ai-provider.md`. | ~800 | yes |

### The critical path

**W-VENDOR → W-GGUF → W-SWAP.** Nothing else makes the product real. Phases 4–7 are
parallelisable once Phase 1 lands; Phase 2's Kotlin half is parallel to all of it and needs
no decisions.

Rough total: **~13,000–16,000 lines** of implementation across five languages, of which
roughly 60% is compilable and verifiable without Apple hardware. That is consistent with the
program doc's own ~26–36 engineer-week estimate for the full v2 ecosystem, and it is worth
saying plainly rather than implying a session or two will finish it.

### The order to actually work in

1. **W-HOST-KT** — no blockers, no decisions, fully verifiable here, and it takes the corpus
   to two complete runners of three.
2. **W-VENDOR + W-GGUF** — the critical path, and fully compilable here.
3. **W-WHISPER**, **W-GOVERNOR**, **W-SIZE** — same, still no Apple dependency.
4. **W-BASE-NATIVE** (Kotlin half), **W-MCPCLIENT** package skeleton — parallel.
5. Everything Swift, once a mac exists: **W-HOST-SW**, then **W-SWAP**'s iOS half.
6. **W-VOICE** when D2 answers; **W-CONVERSE** after W-GOVERNOR.

## What will bite (the risks ledger)

1. **The Core/LocalAI collision zone** — five workstreams, one module. The Wave 2 queue is the
   answer; violating it costs the swap branch its week.
2. **Residency vs contract_diff** — a "moved" action is a broken action. The residency law is
   stated in W-CONTAINER and enforced in review.
3. **`path:` locator vs the SBOM/lock validators** — decided in W-BUILD (tree-hash pin), not at
   release time.
4. **ggml duplication** — one vendored ggml, three pins, or duplicate symbols and doubled size.
5. **sherpa-onnx size** — the voice child's own budget is an entry gate; the core's 8 MB gate
   deliberately excludes it; the child is excludable.
6. **Android native coexistence** — unique `.so` names (`libdespia_ai.so`, `libdespia_local.so`),
   static internal deps, no exported sqlite3 symbols; PowerSync's SQLite coexists by
   documentation, not luck; warn per-app Custom modules about vendoring onnxruntime beside the
   voice child.
7. **The content-folder owner** — catalog + router.json + MCP list + presets share one
   generation; the program's D12 decides the owner so an MCP-only app (intelligence excluded)
   still gets its server list. Seeded content must also verify on apps that never configured
   `bundle_signing` — the key-rollout story is part of D12's resolution.
8. **contract_diff classification** — verify `stream`/`events` and newly-declared `rag.*` read
   as additive BEFORE W-STREAM/W-VEC; extend the classifier + `--self-test` first if not.
9. **Mirror checks vs toolchains** — mirror `check` stays static+TS+JVM; Swift proof rides mac
   lanes.
10. **`tag_from` cannot read a bare VERSION today** — the 3-line extension is scheduled
    (W-MIRROR); without it the first push tags nothing.
11. **binaryTarget vs mirror-replace** — source targets v1; the revisit condition is written
    down (P·d).
12. **Maven lead times** — namespace DNS + GPG custody are operator-external and slow; they live
    in the E2 window.
13. **The nightly smoke model** — digest-pinned, CI-reachable, cacheable, and OWNED (a named
    hosting decision in W-SWAP), or the lane rots.
14. **The dual-emit clock** — the broadcast mirror retires at D13's named VERSION or it lives
    forever.
15. **xcframework tool scope creep** — the v1 fence in W-BUILD is the law; `build_frameworks.rb`
    stays generic, nothing module-specific in scripts or lanes.
16. **Protocol churn** — MCP has already churned transports/auth once; pin the official SDKs,
    state the supported protocol-revision window per release, degrade capability-gated features
    gracefully, never fork the spec.
17. **Embedding drift** — the per-entry (model, dimension, revision) metadata in W-VEC is not
    optional polish; without it the first embedder upgrade silently corrupts every RAG answer.
18. **Governor debt** — shipping V1/V2 on single-flight is fine; starting W-CONVERSE without
    W-GOVERNOR is not. The dependency is stated so the latency budget isn't "fixed" by skipping
    the scheduler.
19. **OTA without eval** — the shared content generation retunes the fleet; until W-EVAL exists,
    a catalog/router change is reviewed like code, not like copy.
20. **The v4 window** — the license exposure lives in the SHIPPED v4 runtime until its swap
    lands (D14); this program's launch does not close it, the drop-in artifact + a dated v4
    commitment do.
21. **Crash loops without the quarantine marker** — a bad model+device pair in a customer app
    relaunches into the same crash forever; the marker (W-CORE) and the `quarantined` verdict
    (W-CATALOG) are v1 scope, not hardening.
22. **Copyleft blindness** — the license gates pass GPL green today; the `copyleft` schema
    dimension (P·g item 5) and W-VOICE's entry audit exist because espeak-ng nearly shipped
    inside the Apache-2.0 pillar.
23. **The SPM week-1 proof** — vendored llama.cpp compiling as a versioned, zero-`unsafeFlags`
    SPM package is ASSUMED until the scratch-app tag-consumption proof runs (W-CORE); if it
    fails, the binaryTarget revisit triggers then — in week 1, not at the first mirror push.
    The nightly SPM-vs-xcframework parity band keeps the two builds honest thereafter.
24. **Arbitrary-origin supply chain** — D16 open at launch makes the four locks (allowlist ·
    digest discipline · pre-flight validator · fit+quarantine) load-bearing; the validator's
    fuzz target stops being a nicety the day the first non-curated URL is allowed.

## Environment memory (the ship-fast section — read or lose an hour)

- `gem install xcodeproj` before any `prepare_modules.rb` run on a fresh container (the script
  hard-requires it via `optional_xcode_surfaces.rb`).
- Swift does not compile locally — changes are compile-pending and ride Codemagic; the local
  proof is the gate set + the brace/paren balance one-liner (UTF-8 encoding explicitly, the
  container default is US-ASCII — `File.read(path, encoding: "UTF-8")` in any new Ruby check).
- `contract_diff.rb` base resolution: CLI arg → `$CM_PULL_REQUEST_DEST` → `origin/main`; run
  `--self-test` first when touching the classifier.
- `mirror_public.rb --dry-run <folder>` before any real push; the real push needs
  `MIRROR_PUSH_TOKEN` and is manual/API-only by design.
- `.framework-cache/` lives OUTSIDE `DSX/Modules/` on purpose (a synchronized-group cache would
  ship into the bundle); the `path:` locator's cache key must include the tree hash + abi/api +
  NDK version like the existing tools.
- The four baseline gates + `dsx_graph_test.rb` whenever `prepare_modules.rb`, `dsx_graph.rb`,
  or an exclusion consumer changes; `parser_test.rb` only for `dsxcss/parser.rb`;
  `check_style_catalog.rb` only for Stack style surfaces.

## Appendix A — pinned shapes (normative starting points; evolve additively, through fixtures)

These freeze the design decisions so the executor copies instead of re-deriving. Field names and
symbols below are v1; anything they don't cover is decided by the program doc's laws, and
anything NEITHER covers is a question for the owner, not a guess.

### A1 · `despia_ai.h` — the v1 symbol set

```c
uint32_t     despia_ai_abi_version(void);                 /* 1 */
const char*  despia_ai_capabilities(void);                /* malloc'd UTF-8 JSON; free via despia_ai_free */
void         despia_ai_free(void* p);
typedef void (*despia_ai_event_cb)(const char* event_json, void* user_data);
void*        despia_ai_open(const char* config_json);     /* opaque context */
void         despia_ai_close(void* ctx);
int          despia_ai_load_model(void* ctx, const char* model_json);   /* catalog-entry-shaped */
int          despia_ai_unload_model(void* ctx, const char* model_id);
int          despia_ai_request(void* ctx, const char* request_json,
                               despia_ai_event_cb cb, void* user_data); /* >=0 request id, <0 -code */
int          despia_ai_cancel(void* ctx, int request_id);
const char*  despia_ai_last_error(void* ctx);             /* JSON {code,message}; context-owned */
```

Threading (part of the ABI, per the program §4.2): the callback is delivered on ONE
engine-owned worker thread per context; from inside the callback only `despia_ai_cancel` and
`despia_ai_last_error` are legal; one context is driven by one caller thread; the callback must
not block on engine calls. Request JSON (must-ignore unknowns, both directions):

```jsonc
{ "schema_version": 1, "kind": "completion",          // completion|embed|transcribe|synthesize|…
  "model": "qwen3-0.6b-q4", "priority": "interactive", // interactive|background (governor)
  "messages": [ { "role": "user", "parts": [ { "type": "text", "text": "…" },
                                             { "type": "image", "url": "…" } ] } ],
  "tools": [ /* OpenAI-shaped function schemas, verbatim */ ],
  "response_format": { "type": "json_schema", "schema": { /* … */ } },   // optional → GBNF
  "options": { "budget_mb": 0, "timeout_ms": 0 /* 0 = defaults */ } }
```

### A2 · A catalog entry (every v1 field)

```jsonc
{ "schema_version": 1, "id": "qwen3-0.6b-q4", "name": "Qwen3 0.6B (Q4)",
  "family": "qwen3", "engine": "gguf", "format": "gguf",
  "status": "active",                                   // active|deprecated|retired
  "requires": { "abi": 1, "engine_caps": ["gbnf"] },    // unmet ⇒ SKIP with typed absence
  "files": [ { "name": "model.gguf", "bytes": 397000000, "sha256": "<64hex>",
               "urls": [ "https://<despia-mirror>/…", "https://huggingface.co/<org>/<repo>/resolve/<REV>/…" ] } ],
  "license": { "id": "Apache-2.0", "url": "…" },
  "languages": ["en", "ar"],
  "inputs": ["text"], "outputs": ["text-stream", "json", "embedding"],   // §4.14 vocabulary
  "context_length": 32768, "thinking": true,
  "tool_dialect": "hermes-json", "template": null,      // template: OTA Jinja override or null
  "sampling": { "temperature": 0.7, "top_p": 0.8, "stop": [] },
  "requirements": { "footprint_mb": 900, "mapped_mb": 400, "disk_mb": 400,
                    "chip_floor": "…" },                // footprint ≠ mapped (program §4.13)
  "perf_priors": { "<device_class>": { "prefill_tps": 300, "decode_tps": 25 } } }
```

### A3 · The facet registrations (verbatim, on `Core/LocalAI/dsx.json`)

```jsonc
"facet": [
  { "word": "tools",
    "declarations": { "key": "word",
      "fields": { "action":      { "type": "ownAction", "required": true },
                  "description": { "type": "string",    "required": true },
                  "mutates":     { "type": "string" } },
      "emit": "ToolsMap" } },
  { "word": "provider",
    "declarations": { "key": "word",
      "fields": { "modality":     { "type": "string",    "required": true },
                  "serves":       { "type": "ownAction", "required": true },
                  "engine":       { "type": "string" },
                  "capabilities": { "type": "object" } },
      "emit": "ProviderMap" } }
]
```

**CORRECTION, found in W-FACETS and since resolved:** this appendix said "same owner, second
registration — the two words are separate blocks", and the landed grammar could not express
that. `dsx_graph.rb` read ONE `facet` binding per module and `facet_declaration_errors`
enforces "a namespace has ONE owner". That became **D17**, and D17 resolved by teaching `facet`
the ARRAY form shown above — repetition of the same grammar, one owner per word, and an abort
if a module binds the same word twice. Both words now register on `Core/LocalAI`. The trap the
correction warned about still stands: do not move a word onto a child, because excluding that
child would delete the namespace and every per-app row under it.

`mcp` follows on `Core/MCP` with fields `action` (ownAction) · `description` (string) ·
`mutates` (string).

### A4 · `router.json`

```jsonc
{ "schema_version": 1,
  "tasks": { "chat":          { "prefer": ["qwen3-1.7b-q4", "qwen3-0.6b-q4"], "min_verdict": "runs_slow" },
             "agentic-tools": { "prefer": ["qwen3-1.7b-q4"], "require_caps": ["gbnf"], "min_verdict": "runs_well" } },
  "default": "chat",                                    // unknown hint ⇒ this chain
  "remote": { "policy": "local", "dialect": "openai-chat" },   // local|prefer-local|remote-only
  "stickiness": { "prefer_loaded": true } }
```

### A5 · MockEngine scripts

A mock model is a scripted event sequence keyed by model id, deterministic by construction —
`{ "models": { "m1": { "script": [ { "token": "Hel" }, { "token": "lo" },
{ "tool": { "name": "x", "arguments": {} } }, { "complete": { "usage": { "out": 2 } } } ] } } }`.
The mock honors `priority`, refuses per scripted verdicts (fit cases), and reports a scripted
`capabilities()` payload (capability-adaptation cases). ONE implementation, C++ behind the ABI;
the TS port replicates it fixture-for-fixture.

### A6 · A corpus case (the `errors/` grammar + a `mock` block)

```jsonc
{ "name": "stream: two concurrent jobs are rid-separated",
  "mock": { "models": { "m1": { "script": [ { "token": "A" }, { "complete": {} } ] } } },
  "steps": [ { "call": { "scheme": "intelligence", "action": "completion",
                         "args": { "model": "m1", "messages": [] }, "mode": "post" } },
             { "call": { "scheme": "intelligence", "action": "completion",
                         "args": { "model": "m1", "messages": [] }, "mode": "post" } } ],
  "expect": { /* SUBSET match: two rid streams, no cross-talk, both final */ } }
```

### A7 · Stream events on the bus (rid-correlated; envelope `{id,…,event,final,data}`)

- `token` — `{ "seq": 3, "delta": { "type": "text", "text": "lo" } }` (coalesced deltas; block
  types from the §4.14 vocabulary; binary types carry `url`, never bytes)
- `sync` — `{ "seq": 3, "snapshot": [ /* full typed blocks */ ] }` (periodic + on-demand resync)
- `tool` — `{ "id": "call_0", "name": "…", "arguments": { }, "status": "loading|ready|approved|denied|timeout" }`
- `routing` — `{ "task": "chat", "model": "qwen3-0.6b-q4", "reason": "sticky-loaded" }`
- `complete` — terminal, `final: true`, `{ "snapshot": [...], "usage": { } }`
