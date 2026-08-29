# Production readiness

**Status: PROPOSED.** The execution plan for taking Despia AI from "the parts work" to a release the
owner can stand behind, plus the one capability the current design does not have and needs: **any
model on Hugging Face, resolved at runtime, not eleven curated rows.**

Companion to [`local-ai-engine.md`](local-ai-engine.md) (the design) and
[`local-ai-execution.md`](local-ai-execution.md) (how it got built). This document is about what is
left, and it is deliberately written to be disagreed with: every claim in the inventory carries the
command that produced it, so a reader can check rather than trust.

## What "production ready" means here

Not "the tests pass". Three things, and the third is the one that gets skipped:

1. **It runs on the platforms it claims.** Every lane that ships has compiled the code it ships.
2. **Every claim of enforcement is enforced.** A gate that exists but no lane invokes is decoration;
   a doc that describes behaviour in the present tense that the code does not have is worse than
   silence, because it stops people looking.
3. **It has been pointed at reality and the output counted.** Four defects in this subsystem were
   invisible to sixty conformance cases, five mutations and a ten thousand string fuzzer, and fell
   out immediately when the thing was run on real data and the results tallied. Corpora prove the
   cases somebody thought of. Nothing else does.

## The open catalog: any Hugging Face model

### The problem with what exists

`ClosedSource/DSX/Modules/Core/LocalAI/models.json` holds eleven entries. Each was resolved by hand,
pinned to a commit, and given a build-time SHA-256. `OpenSource/AI/tools/hf-import.ts` synthesises
such an entry from a repo id, and it is good: it resolves branches to commits, records the digest,
and takes the licence from the repo rather than from whoever ran it.

It is also a **build-time authoring tool**. A developer who wants a model outside those eleven edits
a JSON file and rebuilds an app. That is the wrong shape for a framework whose whole promise is that
on-device inference is a normal thing to reach for.

### The measurement that decides the design

The Hugging Face model API answers with everything an entry needs. Run against
`ggml-org/gemma-3-1b-it-GGUF`:

```
commit sha:  f9c28bcd85737ffc5aef028638d3341d49869c27
license:     gemma
gemma-3-1b-it-Q4_K_M.gguf   size 806058240   sha256 8ccc5cd1f1b36025…
```

Every one of those values is **identical to the hand-curated entry** already in `models.json` — the
same commit in the pinned URL, the same byte count, the same digest. That settles the question the
design turns on: a runtime resolver is not a degraded path next to the curated catalog. **The curated
catalog is what the resolver produces.** Eleven rows are a starting point, not a fence.

### The law

    models.add({ source: "hf:org/repo/file.gguf" })
    models.add({ source: "hf:org/repo", prefer: "Q4_K_M" })

A synthesised entry uses the same schema as a shipped one and flows through every existing mechanism
unchanged: the four locks, the pre-flight validator, the fit function, the governor, the loader. No
new privileged path, because a second path is a second thing to get wrong.

**The API response is untrusted input.** It is a document fetched from a host, not a fact, and the
whole security posture follows from taking that seriously:

- **The digest it reports is a hint, never a substitute.** The device still pins what it actually
  downloaded and still deletes on mismatch. An entry synthesised from an API that lied is caught by
  the same lock that catches a corrupted download.
- **Nothing in the response may widen the allowlist.** If the resolved URL's origin is not already
  in `allowed_model_hosts`, the add fails with a typed error naming the host. A response that could
  add its own host to the list of hosts it is allowed to be is not an allowlist.
- **A branch never reaches a stored entry.** `main` names different bytes on different days.
  Resolution to an immutable commit is a precondition, not a nicety.
- **Metadata comes from the file wherever the file can answer.** Context length, architecture and
  parameter count are in the GGUF header, and the pre-flight walker already reads it. An API that is
  wrong about a context length produces a model that truncates silently, which is the same class of
  failure as a word disappearing from speech: no error, no crash, just a worse answer nobody can
  trace. Prefer the bytes; record which source each field came from.
- **A licence the repo did not state is not a licence to invent.** Unknown is a value, and a surface
  is entitled to refuse on it. Engine is not weights.

**A synthesised entry's fit verdict is `predicted`, and says so.** There is no measured performance
band for a model nobody has run, so the verdict comes from file size and GGUF metadata and is
upgraded to `measured` by the same first-run calibration a curated model gets. What must not happen
is a synthesised entry quietly claiming the confidence of a curated one.

**User-added entries persist and stay distinguishable.** A model a user added survives a restart, and
its origin is recorded, because "why is this model here" is a question someone will ask at two in
the morning.

## Fit is a gate on the download, not a label on the row

An open catalog makes this urgent. Eleven curated rows were all chosen to run on a phone. The moment
a developer can name any repository on Hugging Face, the catalog contains 70 B models, and the
question "will this actually work here" stops being rhetorical.

Fit already exists and is already good: verdicts of `runs_well`, `runs_slow`, `too_big`,
`unsupported` and `quarantined`, ordered first-match-wins, with `mapped_mb` deliberately never
counting toward the memory verdict because mapped pages are clean and evictable. Every request
consults it, and an unfittable model never reaches one.

**Downloads do not.** `#download` accounts storage before the bytes move, which is right, and then
stops. Nothing consults the memory verdict or the unsupported verdict. So a device with plenty of
free disk and not enough RAM will pull four gigabytes and discover at load time that it cannot run
them. That is the worst possible ordering of the same information: the user pays the bytes, the
wait and the battery first, and gets the error last.

**The law: a model that cannot run is refused before it is downloaded, and the refusal names what
would work.**

Three properties, and the second is the one that is usually skipped:

1. **Refuse early, and say which wall was hit.** `too_big/disk` and `too_big/memory` look similar in
   a log and send a person to completely different remedies: free up space, or use a different
   model. The verdict and the reason both travel.
2. **A refusal without an alternative is half an answer.** When a model is refused, the answer names
   the best one that *would* run: same category, `runs_well` before `runs_slow`, and among those the
   largest that fits, because the biggest model a device can run is the best quality it can have. If
   nothing of that kind fits, say so explicitly. "No model of this kind runs on this device" is a
   real answer; an absent field reads as "we did not look".
3. **"What should I download for this task?" is the first question, and routing answers the second.**
   The router picks among models already installed. A developer starting out has none, and needs the
   recommendation before the download rather than after it. The answer carries the verdict, never a
   bare id, so a surface can say "Qwen3 1.7B, runs well, 1.1 GB" instead of a name with no context.

None of this is a new subsystem. It is the fit function, consulted one step earlier and asked one
more question.

## The inventory

From the readiness audit, plus what was found fixing it. **BLOCKING** means a first release would be
wrong or broken. **SHOULD-FIX** ships, but the next person pays.

### Fixed while writing this

Four of these were CI checks failing silently in lanes everyone read as green.

| what | evidence |
|---|---|
| A tracked `.pyc` failed `verify_release_source_state.rb`, the first step of 8 lanes | Caused by my own `.gitignore` rule two commits earlier. Clean clone: 8 passed, 1 failed. Untracked. |
| `generate_package_catalog.rb --check` reported DRIFT | Already failing before this branch touched it. Regenerating cleared a config toggle for a key the module does not have. |
| 63 of 186 conformance cases counted without being checked | The TS and Kotlin runners read none of the 14 expect keys the G2P cases use, and ignored the `requires` guard built to prevent exactly that. BOTH now skip loudly with a count — TS `123/123 … 63 cases in 5 files SKIPPED`, Kotlin the same sentence (was `183/183 drivable cases passed`); the C++ runner that does serve them is in the CI chain. |
| The model catalog had no gate at all | Nothing in `ClosedSource/scripts` read `models.json`. Six rules now, each mutation-proved. |
| A shipped page advertised a removed vendor SDK | `Core/Dom/local-www/index.html`, a declared bundled asset, read "On-Device Inference via Cactus SDK - Qwen 3.1 7B". Neither the SDK nor that model exists. |

### The ios-app lane, audited end to end

`lint_docs.rb --strict` runs at `codemagic.yaml:1140`, before anything compiles, and it exits 1
at the merge base: five callable schemes under `Core/Server` had no README. So the Swift this
document keeps calling "compile-pending on Codemagic" was not reaching the compile step. That
made the rest of the chain worth measuring rather than assuming, and four more gates were red or
dormant, all of them before this branch.

| gate | what was wrong |
|---|---|
| `lint_docs.rb --strict` | 5 missing module READMEs (written, honest about what is deferred), plus a Cross-module section this branch owed LocalAI. Writing it found four undocumented actions and two wrong claims in my own draft that the code refuted. |
| `root_plan_schema_test.rb` | **Ran 3 of its 16 checks.** `errs_for('surfaces' => …)` is keyword arguments under Ruby 3, so the first V-rule case raised and killed the script; the 13 after it never ran. Every root-plan V-rule was unguarded on any Ruby 3 machine. |
| `prepare_modules_check_test.rb` | Asserted `entry.fallback`, the grammar root-plan.md rule 9 retired and prepare aborts on. Its nanopb case opened a `pod install` artifact the lane order guarantees is absent. |
| `android_dependency_lock_integration_test.rb` | Its synthetic tree omitted `Engine/VERSION`, which the kernel's Gradle build reads at configuration time. It failed configuring, so the lock it exists to test was never exercised: 1 assertion, now 11. |
| `generate_editor_catalog.rb --check` | Drift from StackReference.md. Regenerated. |

Also regenerated the server's build identity: `DespiaAssembly.json` moved to `1e36ecc7` in
`d6475fef` and `packages/server/generated/build-info` kept reporting `e3043db9`, so a deployed
server would answer `/health` with a build it was not assembled from and the client link would
carry the same wrong digest.

Two failures here are the container, not the code, and are recorded so nobody re-chases them:
`generate_icons_android_test` needs `sips` or ImageMagick to read a PNG, and several guard tests
raise `invalid byte sequence in US-ASCII` in a shell with no locale. Both pass under a UTF-8
locale, which macOS runners have. The exception is `prepare_modules_check_test`, fixed in place,
because Minitest builds assertion messages eagerly and the diagnostic destroyed itself on every
run.

**33 gates, 0 failures** locally after this pass.

### Blocking

| what | state |
|---|---|
| **No release identity.** Zero git tags, empty `trusted_public_key_spki_sha256`, `--scope production-admission` fails closed. | **OWNER.** Tagging and publishing need credentials and a decision; this repository deliberately makes publishing operator-executed. |
| **The Maven path was red three ways.** | **FIXED.** `stage_bundle.rb --preflight`: 3 artifacts, 0 failures. Both previously unbuildable Gradle projects build — one cause, not two: neither had a `settings.gradle.kts`, so there was no `pluginManagement` and `com.android.library` had no version or repository. A third break was found while verifying: neither Android publication declared `from(components["release"])`, so the POMs said `packaging=pom` with no AAR and a real `--stage` would have died at collection. |
| **The G2P pack had no producer.** | **FIXED.** `build_g2p_pack.rb`. Three independent builds in three directories: 6,314,213 bytes, `b83e9f4e…`, byte-identical. Hosting remains an owner decision; the `.invalid` convention exists for exactly that gap. |
| **`models.add` was not reachable on a device.** | **FIXED on Apple**, and `contract_diff` classifies all three actions as additive. **Android is a typed absence** (`catalog_unavailable`) because the module cannot import the binding; the fix is three concrete steps recorded in `kotlin/OpenCatalog.kt`'s header. `models.best`, `models.added` and the download gate are live on both lanes. |
| **An added model cannot be LOADED for inference.** | **FIXED on Apple** (compile-pending — Swift builds on the mac lanes). The enum stops at the module's edge: `LocalAIModelRef` is what a shipped row and an added row both become, and every inference entry point takes one. The engine seam takes a CATALOG ENTRY (`localAIOpen`) instead of a path, so the model is loaded under its catalog id — which is also what `unload` names, what the crash breadcrumb writes and what the calibration store is keyed by; the entry carries `runtime_mb`, so the governor can account and evict it. Removal drops the cached handle under the single-flight latch first and refuses during a running request; a row whose file vanished answers code 7. **Android takes the same path for both halves and compiles**: `OpenCatalog.addedEntry(id)` is the public single-entry reader `resolve` needed, so from `LocalAIModelRef` down there is one path and no second door. |
| **The derived footprint can be wrong permissively.** | **FIXED on both lanes** (Swift compile-pending). `DeviceProbe.calibrate` now RECORDS what it measures: the footprint DELTA across a real generation — `before` is read on a handle that is open but not yet loaded, so the number includes the compute buffers a load-time reading misses — beside `decode_tps` in the same per-model, per-device store. The store's file grew a fourth column and reads three-column rows as tps-only, so an existing install keeps its decode rate and gains a footprint on its next load. `ModelFit` is the consumer at the module's real call sites: `Device.totalMemoryMb` (absent where a platform will not report it, and the stricter per-process limit stands in), one `calibrationFootprintMb` decision with one guard, and `footprint_mb` / `footprint_measured` / `footprint_rejected` on every verdict. |
| **The governor was never armed.** `governor.hpp` implemented LRU eviction, residency accounting and `setBudget`, and the only caller in the repository was its own test. `budget_` defaulted to 0 and eviction returns empty at 0, so it never fired in any shipping configuration. | **FIXED.** `Context::open` arms it from `limits.max_runtime_bytes`; the module derives that from measured per-process headroom at 70%. Observed on real weights: a process at 720 MB SHRINKS to 429 MB while loading a second model (1,860 → 764 MB on the 1.8 GB pair), and `unload_model` on the evicted id answers `unknown_model`. Explicit `0` stays unbounded, the documented desktop answer; a malformed budget refuses the open. Two mutations red. |
| **Nothing had run on hardware.** Every verification was a Linux container, which cannot answer for the memory probe, the calibration, background transfer, thermal state or low-power mode. | **UNBLOCKED, not closed.** `Dom/local-www/index.html` is a six-section device page: the device as measured, the catalog with live verdicts, a deliberate refusal showing which wall it hit and its fallback, `models.add` against a real Hugging Face reference, download to streaming tokens, and the calibration read BEFORE and AFTER a first run so the estimate being replaced by a measurement is a number that visibly changes. Building it found that `DeviceProbe` had assembled the numbers since it was written with no action bound to them — the same shape as the governor — so `intelligence.device` now exposes them. **It ships on both phones**: iOS gets it from the synchronized group, and the `files` row it always had now carries `"android": true`, which makes `prepare_modules_android` copy it to the APK asset root — the same `dom.load({ path: "index.html" })` on either kind, one declaration rather than a second mechanism. Verified by digesting the asset out of the built APK against the source. The page still has to be run on a phone; that is the owner's step and nothing here substitutes for it. |

### The footprint estimate, and why it is not fixed yet

This one deserves its own paragraph because a wrong diagnosis was nearly shipped as a fix.

The obvious explanation for the −39% was that gemma-3-4b is multimodal and its vision tower is
invisible to the header fields the estimator reads. That was checked by ranged-reading the real
header off the real file: it declares 40 keys in exactly three namespaces, `general`, `gemma3` and
`tokenizer`. **No vision keys, no clip keys.** Gemma 3 ships its vision tower as a separate mmproj
file; this one is text only. The explanation is wrong and a fix built on it would have been theatre.

What the numbers actually say is that the resident non-file-backed cost exceeds the whole mapped
file (3,104 against 2,375), which a `0.3 × disk` compute allowance cannot express. Fitting a new
coefficient to one data point is curve fitting. Clamping to the pessimistic bound is safe and
useless: it would put gemma-3-1b at 1,154 MB against a measured 352.

**The fix is the measurement, not a better formula**: record the real footprint on first successful
load, exactly as `decode_tps` is already calibrated, so the second launch uses a fact. That is what
`DeviceProbe.calibrate` now does on both lanes. Two details decide whether the number means
anything, and neither is obvious:

* **It is a DELTA, not the process footprint.** What it is compared against is the per-process
  HEADROOM (`os_proc_available_memory` on iOS, the cgroup limit minus current use on Android), so
  charging the whole app — web view included — against that would be the wrong quantity twice over.
  `before` is read on a handle that is open but not yet loaded (both engines load lazily, inside the
  first request), so `after − before` is exactly what this model cost.
* **It is taken AFTER a real generation.** A reading at load time misses the compute buffers
  entirely and looks authoritative while doing so.

A verdict computed from a measurement no longer says `predicted`, because `footprint_mb` was the
only estimated number left in the requirements — and a measurement that is not a finite positive
number under the device's physical memory is discarded with `footprint_rejected`, because a wrong
measurement is worse than an estimate: it carries the authority of having been observed.

### Should-fix

| what | evidence |
|---|---|
| Swift's corpus runner still lacks the `requires` guard TS and Kotlin now have, so the `conformance-ai` mac lane still counts the 63 G2P cases without checking them | same defect, last lane |
| Only the G2P corpus declares `requires`, so the new guard protects nothing else | verified: removing a key from the implemented set changes no other file |
| `OpenSource/AI`'s Android AAR carries the JNI library and **no Kotlin** — Base's Android face shares `../kotlin-jvm/src/main/kotlin`, this one cannot, because `Native.kt` resolves the native out of a per-OS Maven classifier jar (desktop-only, no `System.loadLibrary` branch) and imports `java.nio.file.Files` at API 26 against minSdk 24 | verified; recorded in `bindings/kotlin/build.gradle.kts` |
| 59,482 lines of excluded-module Swift and 5,122 lines of package Swift compile nowhere. `desktop-macos-pr` compiles only the 28-module production-minimal graph | audit; corrects an earlier claim that Swift was never compiled |
| `OWNER-TODO.md:17` points at `ios-app-check` as the Swift compile proof; that lane never invokes a compiler | audit |
| `ios_watch_release_guards_test.rb` was 20/66 red; it is now 1/66. Fixed: the reads are UTF-8 (13 checks died on `invalid byte sequence in US-ASCII` in a container with no `LANG`, including one inside `Xcodeproj::Plist`); the `restrictedDependencies` clause is re-pointed at codemagic's five negative Cactus-payload guards; the hand-written source list is derived from the folder; the LocalAI README sentence it pinned was deliberately retracted; `Watch.entitlements` had a generated Health state committed into it by `14c79789` and is back to `<dict/>`; the pbxproj sync exceptions were regenerated | verified |
| The one guard still red: **`CSS viewport units and transitions use the live iPad app window`**. Not stale and not broken — `6b7881cb` ("C1 vw/vh fallback") deliberately added `?? UIScreen.main.bounds.width` to `CSSValue.points` for the pre-window frame and renamed the access to `viewport?.width`, after the guard landed in `1b88774a` banning that identifier outright. Two reviewed commits disagree; someone has to pick, and relaxing the ban to make the suite green would be picking silently | verified |
| ~~`category` is hardcoded `"text"`~~ | **FIXED.** Derived from `<arch>.pooling_type` first, then an architecture table that is exactly what the eleven rows evidence. 7 of 7 correct including the qwen3 text/embedding split; unknown stays unknown and the fallback declines across it. |
| Two GGUF header parsers exist: a TS extractor and the C++ validator. The end state is one, exposed through the ABI | agent report |

### Solid, so the plan does not relitigate it

17 gates green locally. `:core` at 1297 tests, 0 failures. The production-minimal exclusions are
deliberate with a long documented note. `select_release_profile --check` caught a live hand-edit. No
committed secrets. Exactly one TODO in all shipping Swift, Kotlin and TypeScript.

## The release checklist

The order matters, because several of these can only be true once an earlier one is.

1. **Compile everything that ships, on the machine that ships it.** The package's Swift is
   Foundation-only and type-checks here — `check_swift_typecheck.rb` is the gate, and the sentence
   "Swift does not compile in this environment" was true of the MODULE's Swift and got repeated
   about the package's for months. The module's Swift imports UIKit and its proof rides Codemagic.
   Until a Mac lane has compiled it, "it builds" is a claim about everything except that.
2. **Run the device page on a real phone, both kinds.** Everything about memory headroom,
   calibration, background transfer, thermal state and low-power mode is argued from code paths
   until this happens. iOS: the page is in the bundle, `dsx.module.dom.load({ path: "index.html" })`
   opens it. Android: `select_release_profile.rb --profile qa-expanded` (LocalAI is excluded from
   the default profile), `prepare_modules_android.rb`, `gradle :app:assembleDebug`, `adb install`.
   The page reads its six sections off `window.dsx`, so a section that stays empty is a real
   absence, not a rendering problem.
3. **Wire every gate into a lane.** A check script that exists and is not invoked is not a gate.
4. **Decide the module profile deliberately.** Whether `Core/LocalAI` and `Core/Base` are in the
   default profile is a real product decision about app size, and it should be made in a diff with a
   `_note` saying why, not inherited from whichever state the tree happened to be in.
5. **Give the G2P pack a delivery path.** It is a 6.3 MB build artifact that no catalog entry and no
   `weights` row points at, which means today an app cannot obtain it at all.
6. **Tag a release.** The repository has zero tags. The mirror machinery reads `VERSION` files and
   pushes `v<version>` tags to the public repos; nothing has exercised that.
7. **Publish, then verify from the outside.** Install the published package into a fresh project and
   run a model. A package that works in its own repo and not from a registry is a package that does
   not work.

## What this document does not do

It does not relitigate the architecture. The engine constitution, the four locks, the fit function,
the streaming envelope and the never-silent law are decided and enforced, and this is a plan for
finishing, not for reconsidering.
