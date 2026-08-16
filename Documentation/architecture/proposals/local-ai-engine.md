# Despia AI — the owned, open, agentic local-AI stack (replacing Cactus)

**Status: PROPOSED v2** (2026-07-29) — v1 answered "how hard would our own Cactus be"; v2 records
the owner direction: the stack is named (**Despia AI** · **Despia Local** · **Despia MCP** — D1
resolved), the scope is **agentic-first and multi-modal** (tools, MCP client *and* local MCP
servers, voice in and out, vision, criteria-gated image generation), fallbacks are **primitives we
expose, never a layer we own**, and the AI module is an **extensible container** (nested provider
modules — "inner kernelization" without a second kernel). Builds on
`architecture/on-device-ai.md` (the position paper and its "Honest status" ledger),
`architecture/facet-contracts.md` (registered facet words, NESTED modules),
`Skills/module-frameworks.md` (the `build` primitive), `Skills/module-weights.md` (pinned model
delivery), `proposals/desktop-platforms.md` (the lane map), `proposals/error-system.md` (typed
absence), and `proposals/full-stack.md` (the server node — a boundary this program must respect).
The module whose engine this replaces is `ClosedSource/DSX/Modules/Core/LocalAI/` (scheme
`intelligence`, 21 declared actions). **Execution:** `local-ai-execution.md` — the agent playbook
(waves, workstreams, gates, and Track P: how the standalone packages are versioned, mirrored,
published, and documented). It opens with **the executor protocol** and closes with **the
pinned v1 shapes (Appendix A)** — implementing agents start there and copy, they do not
re-derive.

The short answer to v1's question stands: **the hard part is already built, and it is ours.**
LocalAI's ~8k lines of Swift+Kotlin module code are engine-agnostic and stay; the entire vendor
sits behind one C-ABI FFI file per lane (`swift/Cactus.swift`, `kotlin/jni/cactus_jni.cpp` — JSON
strings + a token callback). v2 grows the program from "replace the engine" to "own the ecosystem":
the engine track alone is still ~5–7 weeks to the first shippable swap; the full v2 ecosystem is
**~26–36 focused engineer-weeks, with a marketing-launch cut at ~18–26** (§6). Writing our own
kernels remains a funded-company-sized program deliberately parked behind entry criteria (§6, K).

---

## 1 · Why now (the forcing function, precisely)

**What Cactus is today.** Cactus (cactus-compute/cactus, YC S25) rewrote itself in 2025 from a
llama.cpp wrapper into a fully custom stack: Cactus Engine (C, OpenAI-compatible API), Cactus Graph
(C++), ARM NEON kernels, a **proprietary quantization format** (1–4 bit, own model bundles — not
GGUF), a PyTorch transpiler, and a model zoo. Bindings for Swift, Kotlin, Flutter, React Native,
Python, Rust.

**What its license became.** The upstream repo is now **source-available, not open source**: free
only for individuals, education, 501(c)(3)s, and organizations with **under $2M total funding AND
under $2M gross annual revenue**; above either line, a commercial license from Cactus Compute, Inc.
is required, with automatic termination and a 30-day cure when a user crosses the threshold. Our own
manifest already records the consequence: `Core/LocalAI/dsx.json` declares Cactus 1.13.1 under
`restrictedDependencies` (`LicenseRef-Cactus-Community-2025` — no commercial use, no downstream
redistribution sublicense). Note the shape of the trap for a framework: **we don't ship one app, we
ship the engine inside every customer's app** — the compliance surface multiplies with every
successful customer.

**What that already costs us in-tree.** The blockers are documented as blockers, not defects
(`on-device-ai.md` "Honest status"):

- LocalAI is absent from `production-minimal`, excluded from `qa-expanded` — **no release build
  contains it** (`ClosedSource/release/profiles/`).
- `check_dependency_licenses.rb --public-release` fails the public build if it is enabled; release
  guards verify Cactus **absence** from IPA/APK payloads (`scripts/verify_release_source_state_test.rb:237`,
  `scripts/ios_watch_release_guards_test.rb:945`).
- Desktop publishes exclude it entirely: *"The public release excludes LocalAI/Cactus; its
  restricted binary is not a distributable desktop dependency"* (`ClosedSource/Documentation/desktop-status.md`).
- The iOS `cactus.xcframework` has **no locator, no lock entry, no pod** — only the Android `.so`
  is CI-linked from the pinned npm tarball (`dsx.lock.json`: `npm:cactus-react-native@1.13.1`).
- The vendor SDK carries telemetry (gated off by our `telemetry` config default) and a reachable
  cloud-handoff path via verbatim `options` forwarding — which is why `on-device-ai.md` §"Earn the
  privacy claim" refuses to let the README say "nothing leaves the device".

**The product tension.** The shipped product docs promise *"no proprietary inference backend … no
license checks"* (setup.despia.com/local-intelligence). With Cactus underneath, that promise is
aspirational. With an owned engine it becomes enforced.

**And the liability is live TODAY, not at v5 launch.** The shipped v4 runtime is where Despia
Local AI actually runs in production customer apps — on the vendor engine. This program fixes the
v5 tree; the C ABI seam is kept drop-in-shaped precisely so the same engine artifact slots into
the v4 runtime with its module layer unchanged. The v4 swap is a tracked, launch-adjacent
deliverable owned outside this repo (D14) — until it ships, every v4 app with Local AI enabled
carries the restricted-license exposure, and that window is measured, not ignored.

**The market gap.** When Cactus relicensed, the niche it vacated — a genuinely open, mobile-first,
batteries-included local-AI runtime with clean Swift/Kotlin bindings — is currently unclaimed.
llama.cpp (MIT) is the engine everyone trusts, but it is a library, not a product: no model
delivery, no background downloads, no tool loop, no MCP, no data plane, no app-framework
integration. That product layer is exactly what we already built. **Open-sourcing our layer over
proven engines is the credible "open Cactus" — and the honest one, because we don't pretend the
kernels are the differentiator; the integration is.**

## 2 · How hard, honestly (the three scopes)

| Scope | What it means | Effort | Verdict |
|---|---|---|---|
| **A — owned runtime over proven engines** | Own C ABI + orchestration over vendored **llama.cpp** (MIT; LLM/VLM + embeddings, Metal/CPU), **whisper.cpp** (MIT; ASR/VAD), **sherpa-onnx** (Apache-2.0; TTS + speaker tasks, in an excludable voice child). Streaming, agentic loop, MCP, data plane, 4 platforms. All Apache-2.0. | **Engine track: first shippable swap 5–7 wks. Full v2 ecosystem ~26–36 eng-weeks; launch cut ~18–26** (§6) | **Do this. v2.** |
| **B — own kernels/quant/format** (a true Cactus clone) | Custom graph, NEON/Metal kernels, own quantization + conversion toolchain, per-architecture model enablement forever. This is Cactus's *entire company* (and llama.cpp's hundreds of contributors). | 2–4 systems engineers × 9–18 months, then a permanent enablement treadmill | **Defer behind entry criteria (§6, K). Likely never.** |
| **C — fork Cactus** | Current code: not open source. Pre-relicense code: the old llama.cpp-wrapper era — forking buys nothing over Scope A with fresh llama.cpp. | — | **Dead end. Recorded so nobody re-litigates it.** |

**Why Scope A is cheap *here* (and would not be cheap elsewhere):**

1. **The seam exists.** The whole vendor surface is one FFI file per lane; `CactusController`,
   `CactusInferenceManager`, `CactusSnapshotBuilder`, `HuggingFaceDownloader`,
   `DeviceModelRecommender`, `CactusMic` and the 21-action DSX contract sit *above* the seam and
   survive the swap nearly verbatim.
2. **The delivery machinery exists.** `build` (vendored binaries, per-module lock pins, generic CI
   lanes — `codemagic.yaml:950/3140`), `weights` (SHA-256-verified bundling), `languages` (in-repo
   C/C++ compiled by both lanes — Studio is the live precedent).
3. **The conformance machinery exists.** One fixture corpus, three runners, fixtures-first is the
   law (`OpenSource/Conformance/README.md`). Deterministic mock backends make every new surface
   gateable without loading a model (§7).
4. **Upstream now maintains what we hand-roll.** llama.cpp ships chat-template application and
   per-family tool-call parsing (the marker glue in `CactusSnapshotBuilder.swift:24–29` /
   `CactusInferenceManager.swift:450–537`), plus GBNF grammar-constrained sampling — tool-call JSON
   becomes well-formed *by construction*.
5. **The adjacent capabilities already exist as modules.** Platform OCR is shipped
   (`Core/Vision`, scheme `vision`, VisionKit/ML Kit); local SQLite machinery exists inside the
   vendor-named sync module (`Core/PowerSync`); the on-device localhost server pattern is a shipped
   product feature (Local CDN / Local Server). v2 composes these; it does not reinvent them.

**Decision recorded:** Scope A now. Scope B only if the entry criteria in §6 K are ever met. Scope C
never.

**Placement, recorded (packages + modules — never a kernel primitive).** The question was asked
and the constitution already answers it. The kernel is mechanism — tiny, universal,
dependency-free, in every build, conformance-locked. An inference engine is the opposite on every
axis: megabytes of vendored C++, optional per app, license/model metadata, a monthly upstream
cadence. So:

- **The engines are packages** — `OpenSource/AI/`, `OpenSource/Local/`, `OpenSource/MCP/`,
  *siblings* of `Engine/` and `Web/`, never inside `Engine/`: their release cadence (llama.cpp
  bumps) must not ride kernel versioning, and the eventual repo split (D5) must not touch kernel
  history.
- **The capabilities are modules** — `Core/LocalAI` (scheme `intelligence`), `Core/Base`,
  `Core/MCP`: file-presence exclusion is the on/off switch (an app that doesn't want +8 MB of
  inference drops the module and gets typed absence); the kernel cannot be excluded, capabilities
  can. `on-device-ai.md` states the law: an AI feature is a module.
- **The kernel names no engine — the WebKit rule, applied again.** Exactly as the kernel imports
  zero WebKit and every surface reaches the web view only through Dom, the kernel names no model
  and no inference symbol, and everything reaches intelligence only through
  `dsx.module.intelligence.*`. **LocalAI is the Dom of AI**: the single owner of a heavy platform
  engine, consumed over the bus. There is no `dsx.ai` bus primitive — the reserved proxy surface
  stays the frozen nine, and the bus knows chains, not capabilities. (`dsx.log`/`dsx.error` earned
  kernel residence by being tiny, universal, dependency-free *mechanism*; inference is none of
  those.)

What IS platform law here — the kernel-shaped slices, all grammar, none engine: the `facets.tools`
derivation rule (manifest grammar validated at prepare, like `facets.api`); the streaming envelope
(`stream: true`/`events`/`final` — already kernel grammar; §4.5 merely conforms to it); typed
absence (already law); the model *catalog* riding `dsx.content` (consuming an existing kernel
primitive — the blobs themselves stay on the OS background-transfer downloader, §4.4). If an
authoring-surface word is ever wanted (a JSE builtin, a head block), that is a separate
corpus-first proposal under the unified-codebase law — not needed for v1, because the generated
typed accessors already put `dsx.module.intelligence.*` on every surface.

## 3 · What exists (the load-bearing walls — we extend, never duplicate)

| Wall | Where | What we take from it |
|---|---|---|
| The module + its contract | `Core/LocalAI/` — 21 actions (`completion`, `cancel`, `models`, `download`, `remove`, `transcribe`, `detectLanguage`, `vad`, `diarize`, `speakerEmbed`, `embed`, `tokenize`, `score`, `prefill`, `listen`, `stopListening`, `index.*`) | The public contract. Kept names never break (`contract_diff.rb`). |
| The engine seam | `swift/Cactus.swift` · `kotlin/jni/cactus_jni.cpp` | The ABI shape: JSON strings + token callback. We version it and own it (§4.2). |
| Binary provisioning | `Skills/module-frameworks.md` — `build` tools, locators, lock pins, `.framework-cache` | Android lane works today; iOS gains a generic xcframework tool (§4.1). |
| Model delivery | `Skills/module-weights.md` + the documented runtime-download gap | The pinned-digest discipline the catalog must adopt (§4.4). |
| Streaming grammar | `stream: true` + `events` + rid-correlated `dsx.event` (worked example: `Core/WebPlatform/SpeechRecognition/dsx.json:18–33`; envelope `runtime-api.md:475`) | The declared shape `completion` should have used all along (§4.5). |
| Tool schemas for free | `typed-module-api.md` — declared `args` **is** the runtime-validated JSON schema; `action-contracts.md:22–28` | Auto-derived LLM tool definitions from module manifests (§4.6). |
| Facet words + NESTED modules | `architecture/facet-contracts.md` — registered facet rows (`facets.legacy`, `facets.api`), `Modules/` containers, full-citizen children, cascade exclusion (the watch precedent) | The `facets.tools` grammar (§4.6) and the provider-module extensibility story (§4.10). |
| Error system | `proposals/error-system.md` — typed absence, `dsx.error` hat, ledger | Engine-less builds answer typed absence, done properly. |
| Platform OCR | `Core/Vision` (scheme `vision`) — VisionKit / ML Kit text recognition, shipped | A capability to **compose** (a tool row, a pipeline stage) — never re-implement (§4.9). |
| Local SQLite + sync | `Core/PowerSync` (scheme `powersync`) — vendor-named sync over local SQLite | The boundary Despia Local must respect: vendor power stays vendor-named (§4.7). |
| The localhost pattern | Shipped Local CDN / Local Server (on-device HTTP at `localhost`) | Precedent for the local MCP server transport (§4.8). |
| Desktop lanes | `proposals/desktop-platforms.md` — macOS = Swift lane; Windows/Linux = Kotlin/JVM Compose, x64 first | Where each desktop binary rides (§4.11). |
| The server node | `Core/Server/` + `OpenSource/Web/packages/server` (`full-stack.md` T1 LANDED) | A later home for server-side MCP. Distinct runtime — never conflated with the Windows desktop story or with Despia Local. |

## 4 · The design

### 4.0 The ecosystem — three packages, one system, and what each name promises

| Package | Home | Published as | DSX wrapper | What it is |
|---|---|---|---|---|
| **Despia AI** | `OpenSource/AI/` | SPM `DespiaAI` · Maven `com.despia:ai` | `Core/LocalAI` (scheme `intelligence`, kept) | The inference runtime: completions, embeddings, speech, vision, the agentic loop. |
| **Despia Local** | `OpenSource/Local/` | SPM `DespiaLocal` · Maven `com.despia:local` | `Core/Base` (scheme `base`) | The on-device data plane: SQLite + vectors + snapshots/backups + typed access. |
| **Despia MCP** | `OpenSource/MCP/` | SPM `DespiaMCP` · Maven `com.despia:mcp` | `Core/MCP` (scheme `mcp`) | MCP client (remote servers) + local MCP server (the app's own tools, offline, loopback). |

Standalone packages first, DSX wrappers second — that ordering **is** the marketing strategy: any
iOS/Android developer can adopt `DespiaAI` without Despia, and the packages carry Despia's name
into dev circles; the DSX modules make the same capabilities one manifest line inside Despia apps.

**Positioning pillars — each one traced to an enforced property** (the house rule: say what is
enforced, not what sounds good):

| Pillar | The enforcement |
|---|---|
| "No backdoors" | No telemetry symbols in any package; the only network path in the core is the digest-verified model downloader; local MCP server binds loopback with a per-session token; pinned vendored deps + public SBOM. |
| "You own your OWN AI" | Models live on the device under the user's control; no account, no API key, no license check, no heartbeat; everything works offline forever once downloaded. |
| "Unlimited, unrestricted commercial use" | Apache-2.0 on all three packages; MIT/Apache vendored engines; per-model license metadata in the catalog (engine ≠ weights — Gemma's terms are not Qwen's). |
| "Open source, built into Despia" | Standalone SPM/Maven artifacts + the public conformance corpus; the DSX modules are thin declared wrappers. |
| "Made in UAE 🇦🇪" | Stated provenance for the launch — Despia's engineering signature on the stack. |
| "Agentic-first" | Tools derive from manifests, the loop is native and depth-capped, agentic writes are transactional (§4.6, §4.8), MCP both directions. |

### 4.1 Despia AI, the core — an open inference runtime, not a kernels project

```
OpenSource/AI/
  engine/            # C++17 core: despia_ai.h (the C ABI), orchestration, sessions/KV,
                     # tool-call normalization, the backend seam
  vendor/            # pinned llama.cpp + whisper.cpp snapshots (MIT; VERSIONS + NOTICE)
  bindings/
    swift/           # SPM package (iOS + macOS slices)
    kotlin/          # AAR + JVM-desktop natives (arm64-v8a; win-x64/linux-x64 in E5)
    ts/              # types + MockEngine only in v1 (no browser inference — §8)
  mock/              # MockEngine: scripted, deterministic — what CI gates run against
  conformance/       # runner glue for OpenSource/Conformance/ai (§7)
```

- **License: Apache-2.0** (patent grant; MIT/Apache vendored code carried in NOTICE).
- **Backend seam — a registry, never an enum.** The launch ids are `gguf` (llama.cpp/whisper.cpp
  — the workhorse), `mock` (deterministic), `remote` (the **fallback primitive**, §4.10 — points
  at the app's own endpoint, never at anything Despia hosts), and a reserved `system` id for
  platform models (FoundationModels / AICore / Phi Silica — post-v1, D6) — but the seam itself is
  a REGISTRY: a backend registers with the core (compiled in — a provider child ships its
  vendored lib via `build` artifacts and registers through the C seam at module setup; the
  dynamic-split law holds, nothing downloads code) carrying a capability manifest (formats,
  modalities, dialects, limits). A catalog entry naming an engine this build doesn't carry
  answers typed absence, not a crash. New engine families (MLX, ONNX GenAI, ExecuTorch, a future
  vendor NPU runtime) are additions to the registry, never surgery on the core.
- **Consumption by the module** stays manifest-declared: the Android `build` entry's `cmake-android`
  project points at the in-tree core (thin JNI shim stays in-module); iOS gains one **generic**
  `build` addition — an xcframework tool + a `path:` locator for in-repo sources. Generic scripts
  change, nothing module-specific in lanes (the `build_frameworks.rb` law).
- **Repo split** (own GitHub repos, modules consume via `github:` locators) comes after the API
  stabilizes (D5). In-tree first, like Engine and Web.

### 4.2 The ABI — the seam we already have, made ours and versioned

Keep the shape that made the swap cheap: a small C surface, JSON in / JSON out, a token callback,
an opaque context handle. Changes from the Cactus ABI: an explicit `despia_ai_abi_version()`;
OpenAI-shaped `messages`/`tools` JSON (what the module already passes —
`CactusInferenceManager.swift:123`); a **typed options schema validated at the boundary** (no
verbatim vendor blob — this is what makes "local only" enforceable); no telemetry symbols; no
built-in cloud path (`remote` is explicit, app-configured, and off by default). `CactusTelemetry`
and the `telemetry` config key die with the vendor — there is nothing to gate.

**The engine constitution — the core is itself a kernel.** The same law that governs the module
system governs the engine: the core names no model family, no file format, no tool-call dialect,
no sampler — those are registered components with capability manifests, and the core is the bus
between them. Three enforced rules make it future-proof:

1. **Self-description.** `despia_ai_capabilities()` returns what THIS build carries — engines,
   formats, modalities, tool dialects, sampler features, limits — as versioned JSON. The module
   layer, the fit system, and the router ADAPT to the reported surface instead of hardcoding it
   (the engine-side twin of `despia.excluded`). A consumer never assumes; it asks.
2. **Additive evolution.** C symbols are added, never changed or removed; every JSON envelope
   carries a `schema_version` and unknown fields are MUST-IGNORE on both sides — the durability
   envelope law applied to the ABI. Breaking means a new symbol beside the old one, retired
   loudly at a major.
3. **The resource governor.** One scheduler inside the core owns engine memory: per-request
   priority classes (interactive > background), declared budgets, LRU model unload under
   pressure, thermal/low-power throttling. Requests carry priority in options from day one (the
   ABI reserves it in E1); the full concurrent scheduler lands before the conversation pipeline —
   V3 runs STT + LLM + TTS simultaneously, which the single-flight law alone cannot serve.
   App lifecycle is part of the same contract: **inference is foreground-only by default** (no
   background generation unless the app explicitly opts a job in), a background transition
   pauses or cancels per declared policy with a typed event either way, and model downloads —
   which DO continue in the background — remain the OS transfer APIs' job, not the engine's.
4. **The threading contract is part of the ABI.** A published C ABI without one is a published
   footgun, so `abi.md` states it and it evolves as additively as the symbols: which thread
   delivers the token callback; the reentrancy whitelist (at minimum, `cancel` is legal from
   inside the callback — the first thing every consumer does); one context, one driver thread;
   what a callback may and may not block on. Tested where threads are real (the JVM lane).

### 4.3 The module keeps its contract (the swap, and the debts it clears)

`Core/LocalAI` keeps scheme `intelligence`, all 21 kept action names (the contract gate holds), and
the controller/manager/snapshot/mic/recommender layers. The swap replaces `Cactus.swift` /
`Cactus.kt` / `cactus_jni.cpp` with the core's FFI files, deletes the `restrictedDependencies`
block, and retires the `FETCH-LIBCACTUS.md` hand-provisioning. The rewrite also clears LocalAI's
three standing conformance debts: `completion`/`listen` declare `stream: true` + `events` (§4.5);
the `rag.*` actions get declared in the manifest (today registered only in code,
`LocalAI.swift:124`); `platforms: ["phone","desktop"]` stops being aspirational (desktop facets in
E5). Engine-absent builds answer **typed absence** — the module never fakes a result.

### 4.4 Model delivery earns the `weights` guarantees

Runtime download stays (a catalog of LLMs must not bloat the app), but the documented cautionary
tale ends: the model catalog carries a **pinned per-file SHA-256 and an immutable revision** per
model; the downloader verifies before the engine ever loads a file and deletes on mismatch — the
exact prescription in `module-weights.md:79–96`. Background behavior (NSURLSession / WorkManager,
resume across app death) is already built and stays. GGUF is the format — the entire HF ecosystem,
no transpiler to maintain (deliberately giving up Cactus's proprietary-format edge; that is Scope B
territory). The catalog (small JSON) rides the content plane (`dsx.content`); the blobs stay on the
OS background-transfer downloader. Catalog entries carry **model license metadata** — the docs stop
implying "any model, no terms".

**Day-zero model support is a catalog update, not an engine bump.** The model world ships a new
family monthly; our answer is that everything family-specific is DATA in the catalog entry:
`format` (GGUF today; a format id checked against engine capabilities, not a law), a chat
`template` override (so a new template lands OTA without waiting on an upstream engine release),
`tool_dialect` (an id into engine-supported dialects), `context_length`, a `thinking` flag (typed
reasoning blocks in the stream snapshot), `languages: []` (models and voices are
language-annotated — routing and fit answer honestly for non-English locales), declared
**`inputs: []` and `outputs: []`** from the open modality vocabulary (§4.14 — a model that takes
audio and emits an audio file is fully describable the day it appears), sampling defaults, and
stop tokens. The catalog itself
is versioned for fleets that straddle releases: a `schema_version` with must-ignore semantics,
and per-entry `requires` (minimum engine capability / ABI) so an older runtime SKIPS an entry it
cannot serve — typed absence, never a parse failure. And a lifecycle: entries are
`active | deprecated | retired`, where retirement stops NEW downloads only — **an installed model
keeps working forever; there is no remote kill switch** ("you own your OWN AI" is enforced here
too). Two boundaries ride the same design: the digest gate is a **security** boundary, not just
integrity, and storage is accounted (per-model on-disk size on every row, a storage summary, and
a typed low-disk refusal before a download that cannot fit).

**The channel is the app's own content root — models ship OTA exactly like screens.** The AI
manifest lives at a path of the app's hosted content root (`/dsx/ai/` in the shared, signed
content generation — the same mechanism that serves DSX screens from `/`): the app ships today,
a new model lands tomorrow, and support arrives OTA through the pipeline the app already trusts,
while everything keeps running fully local once downloaded. Despia maintains a **curated
upstream catalog** (entries with vetted digests, licenses, requirements, and templates) that the
dashboard and build tooling pull from — the app's own manifest is the authority, the curated
catalog is a source it merges from, and an app that hosts nothing can opt into a Despia-operated
default mount (that opt-in is a disclosed, unauthenticated content fetch — never an identity
ping). Every blob row carries a `urls: []` mirror list (curated entries mirror to Despia-owned
object storage with Hugging Face as secondary — availability and region resilience), and the
docs say plainly which host a download talks to.

**Arbitrary models are allowed — under a named regime, from day one (D16).** Hugging Face import
is first-class and compliant: an **importer** (CLI + dashboard flow) takes an HF repo + file,
resolves the immutable revision, computes the digest, pulls the license metadata, and emits a
catalog entry — easy setup, and the compliance fields are filled because the tool fills them.
Beyond the curated set, an app may allow ANY model URL, gated by four locks that apply to every
model regardless of source: (1) an **origin allowlist** in the AI module's settings
(`allowed_model_hosts`, https-only with the DevSettings wildcard-host grammar — the app names
which hosts it trusts); (2) **digest discipline** — a declared digest verifies as always, and an
undeclared one is **pinned on first download** and verified forever after (a changed byte at the
origin is a typed refusal, not a shrug); (3) the **pre-flight validator** — a bounded,
fuzz-hardened format parser (GGUF header/tensor-table sanity, size and requirements checks)
clears every file BEFORE the real engine ever maps it; (4) **fit + quarantine** apply unchanged.
The engine never loads a byte that didn't pass all four.

### 4.5 Streaming done by the grammar (rid-correlated, declared)

`completion` becomes a declared stream action: `stream: true`, `events: ["token","tool","complete"]`,
consumed page-side via the watch form (`runtime-api.md:451–460`) and native-side via `dsx.event` —
rid-correlated, so **two concurrent jobs are distinguishable by the envelope**, not by a hand-rolled
payload `id`. The wire economics are decided BEFORE the envelope becomes public grammar: `token` events carry
**sequence-numbered deltas**, coalesced to a stated cadence, with a periodic (and on-demand)
full-snapshot resync event for late joiners — the current cumulative-snapshot-per-token shape is
O(n²) bytes over the bridge and does not get frozen in; a fixture asserts bounded per-event
payload growth. `complete` is terminal (`final: true`) with the final snapshot + usage. The legacy `broadcast`
mirror stays one release with byte-identical payloads (the error-system P3 dual-emit pattern), then
retires. Cancellation stays (`cancel`, `dsx.stopped()`); single-flight relaxes to per-model where
the engine allows, `inference_busy` kept for contention. Sessions are **ephemeral in v1** —
KV/session reuse lives within a process lifetime (`prefill` + engine cache); durable named
sessions across launches are a reserved additive surface, not a v1 promise.

### 4.6 Tools — the module mesh is the toolbox, and writes are transactional

Three tool sources feed one registry:

1. **Module actions.** A module opts actions in via a registered facet — `facets.tools` rows
   (action name + a model-facing description + flags), mirroring the `facets.legacy`/`facets.api`
   precedent. The tool's JSON schema is **derived, never hand-written**: the declared `args` block
   is already the runtime-validated schema with one type vocabulary (`typed-module-api.md`).
   Exposure is explicit; invocation goes through normal bus dispatch — `gate` vetoes, `reach`,
   exclusion/typed absence, and the error ledger apply for free. The app's manifest is the
   allowlist. (`Core/Vision`'s OCR as a tool row is the first worked example: *"read the text in
   this image"* becomes one manifest line.)
2. **Page tools.** The web app registers JS functions as tools (schema + callback), promise-
   resolved back into the loop. This is also the sanctioned route to **web-side data** (IndexedDB,
   app state): page tools read it where it lives — native code never spelunks WebKit storage
   (the Dom confinement law).
3. **MCP tools** (§4.8), namespaced by server.

**The loop** runs native, inside the intelligence module: the model emits tool calls
(grammar-constrained via GBNF — well-formed JSON by construction; upstream chat-template parsing
replaces our per-family marker glue), the module dispatches, results round-trip as `role:"tool"`
messages, depth-capped (mirror the action grammar's 32), every hop visible as `tool` stream events
so surfaces render agent progress live.

**Transactional agentic writes.** A tool row that mutates state declares `mutates: true`, and
runs under an **approval policy** — `auto`, `prompt`, or a module `gate` veto. The concurrency
semantics are law, because a human deciding must never wedge the system: for `prompt`-policy
tools the approval happens **BEFORE execution** (the user approves the call with its arguments;
a preview diff, when shown, is produced from a shadow copy — never by holding the live write
transaction open); every approval has a **named timeout with a declared default disposition**
(rollback + a resumable `tool` event); and while an approval is pending the loop parks its
engine request and holds **no** Base write lock — a concurrent app write and a concurrent
completion both succeed, and the fixtures prove it. Execution then runs inside a savepoint with
a pre-write snapshot per §4.7, committing or rolling back atomically. The marketing sentence is
enforced by construction: *an agent can edit your local data, and there is always a backup from
before it touched anything.*

**Future-proofing the loop.** Four rules keep the agentic surface ahead of the churn:
**structured output is first-class** — `response_format: json_schema` compiles to a GBNF grammar,
so constrained JSON generation ships in v1, not as a later bolt-on; **parallel tool calls** are
the wire shape (the snapshot already carries an array of tool blocks — the loop dispatches
concurrently where the tools' `mutates` flags allow); **schemas pass through at full fidelity** —
module tools derive from the manifest's `args` vocabulary, but MCP and page tools carry their
arbitrary JSON Schema VERBATIM to the model (never down-converted); and **tool sources are
pluggable** — module actions, page tools, and MCP are the launch three, but a source is just a
registry contract, and a provider child can add one (a skills folder, a remote catalog) without
touching the loop. Two trust laws ride along: **tool descriptions are untrusted input**
(provenance-tagged per source; a description never overrides policy), and a `mutates` tool is
approval-gated regardless of which source offered it. The loop also keeps a local, ring-buffered
**agent transcript** (prompts, decisions, tool calls, approvals — exportable from the DevSettings
drawer, never transmitted) so agentic behavior is debuggable and auditable on the pillar's terms.
Every tool dispatch carries a **deadline** (per-tool timeout with a typed `tool_timeout` error
fed back to the model; a hung MCP server or page callback cannot stall the loop), the loop
itself runs under a watchdog, and **a tool may not call the model that is running it** — a tool
invocation resolving to the `intelligence` scheme (or the loop's own model) is refused with a
typed error rather than self-deadlocking under single-flight (governor-scheduled nesting is a
later relaxation, not a v1 behavior). And because Despia's customers face store review, the loop exposes
an **app-supplied output filter seam** — a gate-style hook that sees generated text/tool intents
before delivery and can redact or refuse; Despia ships the seam and the store-compliance
guidance, never the filter (a Despia-run filter would be a backdoor by another name).

### 4.7 Despia Local — the on-device data plane

A standalone package + module the ecosystem stands on (and a product in its own right — plenty of
apps want a real local database with zero AI involved):

- **Engine:** SQLite (public domain) + **sqlite-vec** (Apache-2.0/MIT) for vectors — one file, one
  battle-tested store for relational + vector + KV/document shapes. Typed access from native,
  from the page surface, and from DSX markup via the module's declared actions.
- **Snapshots & backups as a first-class verb:** savepoints for cheap transactional scopes,
  `VACUUM INTO`/backup-API snapshots for durable pre-agent backups, list/restore/export actions.
  This is the substrate §4.6's transactional writes stand on.
- **The AI joints:** LocalAI's `index.*`/`rag.*` actions re-point to Base (embeddings from Despia
  AI, storage and ANN search in Base) — the in-house vector index stops being bespoke code inside
  the AI module.
- **The boundaries, stated hard:** Despia Local is the **device** data plane. The server node
  (`full-stack.md`) is the **server** data plane — they do not unify, per the narrow-interface
  law. `Core/PowerSync` remains the vendor-named sync path (vendor power is vendor-named); a
  Base↔server sync seam is a future proposal, explicitly **not** v1 (D10). Encryption story is D9.

### 4.8 Despia MCP — client for the world, server for the device

Zero MCP exists in-tree today — fully greenfield. Both directions ship, as one package + one
excludable module (`Core/MCP`), consumed over the bus (`dsx.module.mcp.*` — rule 1, no shortcuts):

- **Client** (remote servers): official modelcontextprotocol Swift + Kotlin SDKs (MIT),
  **Streamable HTTP only** (no stdio on device), servers declared in config + a runtime `connect`
  action, bearer/OAuth per server (D4). Discovered tools join the §4.6 registry namespaced
  (`mcp.<server>.<tool>`), subject to the same allowlist + veto surface.
- **Local server** (the app's own tools, offline): an on-device MCP server on the shipped
  localhost pattern (the Local CDN / Local Server precedent) — **loopback-only, per-session token,
  works with no network**. Transport reality, named: the official SDKs supply the client; the
  **Streamable-HTTP server framing is implemented on the existing in-house loopback daemon**
  (the content-server substrate, dynamic ports already the default) against the SDK's server
  API — no Ktor, no Vapor, and the content-server security-guard test suite extends to it. What
  it serves is *declared, not coded*: `facets.mcp` rows map manifest actions and **Despia Local
  queries** into MCP tools (same derivation as §4.6 — one grammar, two protocols). Consumers, in
  priority order: (1) the in-app agent loop (in-process fast path — HTTP only when a real
  boundary exists), (2) the app's own web surface, (3) on desktop, external agent hosts (Claude
  Desktop and friends) — and because host configs are static while our port and token are
  dynamic, external access works through a **per-app discovery file** (0600 in the app
  container: current port + a pairing token distinct from in-app session tokens, written only
  while consent is granted) plus a tiny stdio-to-loopback launcher a host can reference
  statically. One threat-model sentence the docs carry: on-device loopback is reachable by
  co-resident apps — **the token is the boundary, not the interface**, and it never appears in a
  URL. Mutating tools inherit §4.6's approval flow unchanged.
- **Later, separately:** a server-side MCP client/host on the server node (TS SDK, a natural
  `Core/Server/Modules/*` sibling). Different runtime; never conflated with the device server.

### 4.9 The modalities — voice both ways, vision, and honest image generation

Not just text completions. Each modality is a **provider child module** under the intelligence
container (§4.10), so apps take only the size they use:

- **Speech-to-text + VAD** (`intelligence.voice`, inbound): whisper.cpp — `transcribe`,
  streaming `listen`, `vad`, `detectLanguage`. Already in the 21-action contract.
- **Text-to-speech, realtime** (`intelligence.voice`, outbound): **sherpa-onnx** (Apache-2.0)
  running **Kokoro** (Apache-2.0) and **Piper** (MIT) ONNX voices, which also covers
  `diarize`/`speakerEmbed`. **One landmine, named:** the sherpa-onnx TTS path for exactly these
  voice families phonemizes through **espeak-ng, which is GPL-3.0** — copyleft can never ship
  inside an Apache-2.0 package whose pillar is unrestricted commercial use, and the existing
  license gates are blind to it (they classify restricted/proprietary, not copyleft). The voice
  child's ENTRY GATE is therefore a **copyleft-free static-link graph**: a permissive phonemizer
  path (bundled-lexicon/G2P frontends) or a replacement phonemizer, proven by a transitive audit
  of the TTS build graph before D2/D7 close (§10). Synthesis is **played natively by the voice
  child** — control/progress events ride the bus, and a page that wants bytes gets a per-utterance
  loopback URL; PCM never rides JSON (the module's own no-base64 media law). Voices are
  per-language data in the catalog (`languages: []`), and a request no installed voice serves
  answers a fit-shaped typed absence so UIs can offer the right download. Cost: onnxruntime —
  which is exactly why voice is an **excludable child**, not core weight.
- **Vision-in** (`intelligence.see`): VLM via llama.cpp multimodal (Qwen-VL-class GGUFs) for image
  understanding/description; **OCR stays `Core/Vision`** (platform engines, already shipped) and
  is composed as a tool row / pipeline stage — never re-implemented.
- **Conversation** (`intelligence.converse`): the realtime local voice loop — VAD → streaming STT
  → LLM (streamed) → streaming TTS, with barge-in (VAD interrupts TTS), tool calls allowed
  mid-conversation. A pipeline over the other providers, not new inference: the latency budget
  (target: first audio back under ~1.5s on flagships) is the engineering content.
- **Image generation** (`intelligence.imagine`): honest status — feasible on flagships only
  (step-distilled diffusion via Core ML on Apple silicon, GPU delegates on Android; ~1–2 GB peak,
  seconds per image). **Criteria-gated** (D8): ships as a provider child when a permissively-
  licensed distilled model meets a floor we name (device class, latency, memory), opt-in per app.
  Until then: typed absence, and the `remote` fallback (§4.10) covers it via the app's own backend.

### 4.10 Fallback primitives — we expose the seam, we never own the layer

Cactus's answer to "the device can't run it" is confidence-based handoff to *their* cloud. Our
answer is a **primitive**: the `remote` engine id — dynamic, app-configured endpoints (config +
runtime-settable), OpenAI-compatible shape, **pointing at the app's own backend**, which proxies to
any vendor with keys that never ship in the app. Routing is explicit policy (`local` |
`prefer-local` | `remote-only` per request or per modality), never silent. Despia hosts nothing,
meters nothing, sees nothing — enforced by there being no Despia endpoint to see it. This is the
"no backdoors" pillar with a seam instead of a hole. Endpoint wire formats drift too, so each
remote profile declares a `dialect` (OpenAI-chat today; a data field checked against engine
capabilities) — a provider changing its API shape is a config edit, not an engine release.

### 4.11 Inner extensibility — a container, not a second kernel

The direction asks for a module system *inside* Despia AI — new modalities, engines, and outputs
added dynamically, per app, "a kernel in a kernel." The architecture already has the machinery,
and the answer keeps ONE kernel:

- **Nested modules are landed law** (`facet-contracts.md`: `Modules/` containers, full-citizen
  children, cascade exclusion, chain-derived identity — the watch precedent). `Core/LocalAI`
  becomes a **container**: `intelligence.voice`, `intelligence.see`, `intelligence.converse`,
  `intelligence.imagine` are child modules with their own manifests, sizes, and exclusion —
  dropping one is file-presence, like everything else.
- **Providers are a facet contract, not kernel code:** a registered facet word (working name
  `facets.provider`) by which a child — or any module, including a per-app Custom module —
  declares what it adds to the intelligence surface: a modality id, the actions that serve it, the
  engine/backend it requires. `prepare_modules` derives the provider registry the way it already
  derives typed accessors; runtime liveness rides the context plane. A customer can ship a
  modality nobody has built — their own model, their own output type — as an ordinary module that
  plugs into the same loop, tools, streaming envelope, and approval flow.
- **What stays singular:** one bus, one dispatch funnel, one action grammar, one conformance
  corpus. "Inner kernelization" is a *container + a facet grammar*, which is exactly how the watch
  and the server stayed inside the constitution. If a real gap appears (say, dynamic provider
  semantics the facet grammar can't express), it lands as **kernel grammar with a corpus** under
  the unified-codebase law — never as a second dispatch path.

### 4.12 Every target (the reach-vs-run law — DSX is cross-platform, so is this)

The surface is reachable from EVERY DSX target; inference RUNS where a target declares it and
fit admits it. Those are different facts and the grammar keeps them apart: **run-where** is the
package/child manifest's target scope (`platforms`, per-child — declared, build-gated,
introspectable) plus the runtime fit verdict; **reach-from** is universal — any surface on any
target may call `dsx.module.intelligence.*` and gets either service or typed absence with the
reason, never silence. Per target:

- **iOS / Android** — the launch lanes (E2): full engine, Metal / CPU-NEON.
- **macOS** — the Swift lane (same SPM package, macOS slice; llama.cpp Metal is best-in-class on
  Apple silicon).
- **Windows / Linux** — the Kotlin/JVM lane: the same C core built win-x64/linux-x64, loaded
  over JNI from the Compose Desktop app; divergence lives in `kotlin/desktop/`; x64 first, ARM64
  with the existing desktop qualification blockers.
- **watchOS / Wear** — **reach, not run, in v1**: the watch asks the surface and gets typed
  absence (or, later, a proxied answer — the paired-device relay is a reserved, criteria-gated
  seam: same actions, the phone runs the model, the watch streams the events; nothing about the
  contract changes when it lands, which is the point of deciding the law now).
- The server node stays a different runtime (TS on Deno/Node) and is *not* the Windows story.

Fit, capability discovery, and routing are per-target from day one — the same catalog entry can
be `runs_well` on an M-series Mac, `runs_slow` on a mid-range phone, and `unsupported` on the
watch, and every surface can ask before it calls. The desktop local MCP server (§4.8) is the
launch demo that writes its own headlines: a Despia app whose data any agent host can use — with
the owner's consent and Base-backed rollback.

### 4.13 Fit and the router — the device knows what it can run

Two capabilities the catalog and the engine grow together (execution: W-CATALOG, W-ROUTER):

**Fit.** Every catalog entry carries `requirements` (min RAM, disk, chip floor) and perf bands
per device class, seeded from our own benchmark lane — not vendor claims. On device, a probe
(RAM headroom, storage, chip generation, thermal/low-power state) plus a short **first-run
calibration** micro-benchmark per downloaded model (measured prefill/decode tokens-per-second,
cached per model+device, never transmitted — the pillars hold) turn every
`models.available()`/`installed()` row into an honest verdict:
`runs_well | runs_slow | too_big | unsupported | quarantined`, with predicted-or-measured tps
attached — `quarantined` is crash containment: a crash marker is written before every model
load/generate and cleared on success, so a model that took the app down is refused on the next
launch (typed error, clearable by the user) instead of becoming a crash loop;
`models.fit` answers for one model; the device class publishes on the context plane. Below the
floor, a load refuses with a typed error — `DeviceModelRecommender` graduates from advisory to
enforced, exactly as §9 promised.

**The router.** `completion` accepts a `task` hint (chat · summarize · extract · agentic-tools ·
vision) as the alternative to a hard model id. Resolution is deterministic: `router.json`
preference order ∩ installed ∩ fit-passing, with loaded-model **stickiness** (a model swap costs
seconds and hundreds of MB of churn — the resident model wins when it satisfies the task) and
the `remote` leg (§4.10) as an explicit policy step, never a silent handoff. Every decision
surfaces as a `routing` stream event (chosen model + reason) so a UI can show which model
answered. `router.json` rides the SAME content generation as the model catalog, the MCP server
list, and the agent presets — one atomic, signed, OTA-updatable bundle (owner named by D12) —
so routing for the whole fleet retunes without an app update. A tiny on-device classifier
upgrading the hint (Needle-style) stays criteria-gated: the seam allows it, v1 does not need it.
This is the honest counter to Cactus's confidence-based cloud handoff — we route across YOUR
models on MEASURED fit, and the only remote is the app's own backend.

Both vocabularies are DATA, not code: the device-class table ships in the same content
generation (new chips are a catalog update), and task ids are an OPEN vocabulary defined by
`router.json` itself — an unknown hint resolves through the table's declared default chain, so
next year's task class is a data edit. The shipped perf bands are priors; on-device calibration
is the truth that corrects them.

**The memory model is defined against how the OS actually kills apps, not against "free RAM".**
Catalog `requirements` express **footprint at load** (resident weights + KV cache at
`context_length`) separately from **mapped size** — llama.cpp's mmap'd weights are clean
file-backed pages that don't count toward the process limit but thrash under pressure, while KV
and Metal buffers are dirty footprint that does. On iOS the probe reads
`os_proc_available_memory()` (the jetsam limit is per-process, roughly half of device RAM) and
the presence of the `com.apple.developer.kernel.increased-memory-limit` entitlement — which the
module declares through the existing manifest `entitlements` machinery, because it materially
changes which models fit; the typed refusal is computed against the limit the app will actually
have. Calibration measures decode under a footprint-pressure pass, not only cold after download
— a verdict that survives first contact with a WKWebView-hosting app spending its own hundreds
of MB. Fixture: same model, same device class, entitlement present vs absent → different
verdicts.

### 4.14 The modality grammar — open I/O typing, so tomorrow's model shape already parses

The request and the stream speak in **typed parts and typed blocks with an OPEN vocabulary** —
the reason a model kind nobody has shipped yet (music generation, video understanding, whatever
next spring brings) is a data change, not a refactor:

- **Inputs are typed parts**: `text` inline; `image` / `audio` / `file` as references (a URL, a
  content handle, a Base file — the media staging the module already does), never inline bytes.
- **Outputs are typed blocks** in the stream envelope: `text` (delta-streamed), `thinking`,
  `tool`, `json` (structured output), and reference blocks — `audio` (stream or file), `image`,
  `file`, `embedding` — where **binary never rides JSON**: a reference block carries a
  per-utterance/per-artifact loopback or content URL and the native side owns the bytes (the
  §4.9 voice law, generalized to every modality).
- **The vocabulary is versioned and corpus-gated**, and blocks obey the envelope law: an old
  runtime receiving an unknown block type ignores it and says so (typed notice), never crashes.
  A catalog entry declares its `inputs`/`outputs` from this vocabulary (§4.4), fit checks them
  against engine capabilities (§4.2), and the router can select on them.

The composition rule that keeps this "never refactor": a NEW modality is (a) a catalog entry, if
an engine family already compiled in can serve it — pure OTA; or (b) a provider child shipping
the backend, if it can't — build-dynamic. Both plug into the same parts/blocks grammar, the same
fit, the same router, the same approval flow. The grammar is the contract; models come and go.

## 5 · Capability matrix (every kept name + every new modality, mapped)

| Capability | Backing | Phase |
|---|---|---|
| `completion`, `cancel`, `tokenize`, `score`, `prefill`, `embed` | llama.cpp (GBNF, sessions/KV) | **E2** |
| `models`, `download`, `remove` | pinned-digest catalog on `dsx.content` | **E2** |
| `transcribe`, `detectLanguage`, `listen`, `stopListening`, `vad` | whisper.cpp | **E3** |
| `index.*`, `rag.*` (newly declared) | Despia AI embeddings + **Despia Local** (sqlite-vec) | **E3/B2** |
| Tool calling + the agentic loop + transactional writes | §4.6 (GBNF, `facets.tools`, Base snapshots) | **E4/M2** |
| MCP client | official Swift/Kotlin SDKs | **M1** |
| Local MCP server (`facets.mcp`) | Despia MCP on the localhost pattern | **M2** |
| Text-to-speech (realtime, streaming) + `diarize`, `speakerEmbed` | sherpa-onnx (Kokoro/Piper voices) in `intelligence.voice` | **V1** |
| Vision-in (VLM) | llama.cpp multimodal; OCR composed from `Core/Vision` | **V2** |
| Realtime conversation (duplex voice, barge-in, tools) | pipeline over voice+text providers | **V3** |
| Image generation | criteria-gated provider child (D8) | **G** |
| `remote` fallback seam | app-owned endpoints, explicit policy | **E4** |
| Model fit (`models.fit`, probe + calibration, typed refusal) | catalog `requirements` + perf bands + on-device measurement (§4.13) | **E2 (W-CATALOG)** |
| The model router (task hints, stickiness, explicit remote step) | `router.json` on the shared content generation (§4.13) | **E4 (W-ROUTER)** |
| Structured output (`response_format: json_schema` → GBNF) | engine constitution + the loop (§4.2, §4.6) | **E4** |
| Capability discovery (`despia_ai_capabilities()`) + governor foundations | the engine constitution (§4.2) | **E1** |
| The full concurrent scheduler (governor) | prerequisite of the conversation pipeline | **pre-V3 (W-GOVERNOR)** |
| Catalog/router eval promotion gate | deterministic task suite on the mac builder | **criteria-gated (W-EVAL)** |
| Open modality I/O (typed parts/blocks, references-not-bytes) | the modality grammar (§4.14), corpus-gated | **E2 envelope · grows per track** |
| Arbitrary-origin models (allowlist + pin-on-first-download + validator) | the four locks (§4.4, D16) | **E2 (W-CATALOG)** |
| HF importer (revision + digest + license, one command) | catalog authoring tooling (§4.4) | **E2 (W-CATALOG)** |
| Own kernels | — | **K (criteria-gated, likely never)** |

Kept names evolve non-breaking under `contract_diff.rb`; anything not yet backed answers typed
absence rather than lying.

## 6 · The program (tracks; each phase lands green under the standard gates or it doesn't land)

**Track E — the engine.**
- **E1 — the core exists** (~2–3 wks): `OpenSource/AI/` skeleton, ABI + version, vendored pinned
  llama.cpp/whisper.cpp, MockEngine, Apache-2.0 + NOTICE, generic `build` additions (xcframework
  tool, `path:` locator), CI artifact lanes + **size-budget gate** (≤ 8 MB compressed core per
  platform; voice budgeted separately as an excludable child).
- **E2 — the swap** (~3–4 wks): both lanes swap FFI files; `restrictedDependencies` deleted; SBOM
  regenerated; pinned-digest catalog **with the fit system** (probe + calibration, typed refusal
  below floor — §4.13); streaming grammar fix with the one-release broadcast mirror;
  LocalAI enters `qa-expanded`; `check_dependency_licenses.rb --public-release` passes **with
  LocalAI enabled**; nightly real-inference smoke (tiny GGUF, greedy) on the mac builder.
- **E3 — speech-in + RAG-on-Base** (~2–3 wks): whisper.cpp transcribe/listen/VAD; `index.*`/`rag.*`
  declared and re-pointed to Base.
- **E4 — tools + the loop + the fallback seam + the router** (~2–3 wks): `facets.tools` grammar,
  page tools, the depth-capped loop, GBNF, `tool` stream events, `remote` engine id + routing
  policy, and the task router (`router.json` ∩ installed ∩ fit, stickiness, decision events —
  §4.13).
- **E5 — desktop** (~2–3 wks): macOS slice; win-x64/linux-x64 JNI natives; `platforms` becomes true.

**Track B — Despia Local.**
- **B1 — the package + module** (~3–4 wks): SQLite + typed actions + savepoints/snapshots/restore/
  export; page + native + markup access.
- **B2 — vectors** (folded into E3's timeline): sqlite-vec, the ANN surface the AI joints use.

**Track M — Despia MCP.**
- **M1 — client** (~2 wks): SDKs, Streamable HTTP, connect action, registry integration.
- **M2 — local server + transactional approvals** (~2–3 wks): loopback server + token, `facets.mcp`
  derivation, the snapshot→approve→commit/rollback flow wired through Base, desktop consent UX.

**Track V — voice + vision.**
- **V1 — TTS + speaker tasks** (~2–3 wks): sherpa-onnx in the `intelligence.voice` child; Kokoro/
  default voices are the PLATFORM synthesizer, with Kokoro-over-ONNX as the opt-in
  neural tier (D2/D7, resolved); streaming synthesis events.
- **V2 — vision-in** (~1–2 wks): llama.cpp multimodal; `Core/Vision` OCR tool row.
- **V3 — conversation** (~2 wks): the duplex pipeline with barge-in and mid-call tools; the
  latency budget is the deliverable.

**Criteria-gated:**
- **G — image generation**: enters only when D8's floor is met (permissive distilled model, device
  class, latency/memory), as a provider child, opt-in.
- **K — own kernels**: enters only if **all** hold: (a) a measured, user-visible perf/size gap vs
  llama.cpp on target devices that upstream won't close, (b) OSS adoption worth differentiating,
  (c) a dedicated systems hire owns it. Until then, kernel work upstreams to llama.cpp.

**The cut line — "Despia AI 1.0", the marketing launch:** E1–E4 + B1/B2 + M1 + V1 + V2
(**~18–26 eng-weeks**): completions, streaming, embeddings, STT/TTS/VAD, VLM, RAG on Base, the
agentic loop with mesh tools and transactional writes, MCP client, fallback seam — on iOS +
Android. E5, M2, V3 follow fast (**~26–36 total**); G and K on criteria only.

**Day one (agent-parallel):** W-CORPUS (fixtures for the JS surface FIRST — the unified-codebase
law) · W-CORE (E1 skeleton + MockEngine) · W-BUILD (the generic `build_frameworks.rb` additions) ·
W-CATALOG (pinned-digest catalog — landable against Cactus before the swap; it fixes the
documented integrity gap regardless) · W-BASE (B1 grammar + package skeleton). Merge order:
CORPUS → CORE/BUILD/BASE → CATALOG → the E2 swap.

## 7 · Conformance (what "done" means)

New corpora, all mock-backed so gates never download a model, wired the standard way (no central
registry; fixtures land before implementations) — with the authority model stated, because it is
the INVERSE of jse's: jse fixtures are recorded FROM Swift; `ai`/`base` fixtures are
hand-authored, and every lane runs them in **verify mode**. There is exactly **ONE MockEngine**
— the C++ mock behind the ABI, loaded by the Swift and Kotlin lanes alike — and the TS mock is
an explicitly subordinate port gated by the same fixtures. The Swift side gets a named
`conformance-ai` mac lane (building `bindings/swift` + the C++ mock, running the vendored
corpus), green at least once before the swap lands:

- `Conformance/ai/` — completion streaming envelopes (rid correlation, `final`), tool round-trips
  (derived schema → dispatch → `role:"tool"` → resume), depth-cap, cancellation, typed absence,
  provider registration, `remote` routing policy.
- `Conformance/local/` — the data plane's action surface: CRUD, vector search, savepoint/snapshot/
  restore semantics (the transactional-write guarantee is a *fixture*, not a promise).
- MCP cases ride `Conformance/ai/` with a scripted in-process MCP server (client) and a loopback
  fixture (server), including the approval flow.

Real-model inference is explicitly **not** in the per-PR gates — it lives in the nightly smoke (E2).

Evolution itself is fixture-gated: a `capabilities` case class (MockEngine reports a surface; the
module layer, fit, and router adapt to it), catalog schema-tolerance cases (an entry with a newer
`schema_version` or unmet `requires` is SKIPPED with typed absence — proven, not assumed), and
Base vector cases asserting the per-entry embedding metadata (model id, dimension, revision) with
typed mismatch on drift.

## 8 · Non-goals (v2 — as important as the goals)

- **A Despia-hosted inference layer. Never.** The `remote` seam terminates at the app's own
  backend; there is no Despia endpoint, no metering, no proxy. (This is the anti-Cactus stance.)
- **Own kernels, own quant format, own transpiler** (K's criteria or nothing).
- **Browser inference** (wasm/WebGPU) in v1 — TS binding ships types + MockEngine; revisit after
  the native lanes are proven.
- **Watch-lane inference** (running models ON the watch — the watch REACHES the surface per
  §4.12, and the paired-device relay is a reserved criteria-gated seam), training/fine-tuning, a
  bespoke tool-router model, MCP sampling/elicitation in v1.
- **Re-implementing platform capabilities** — OCR stays `Core/Vision`; sync vendors stay
  vendor-named (`Core/PowerSync`); the server node stays the server.
- (Moved *out* of non-goals since v1, deliberately: image generation — now criteria-gated G —
  and "the app as an MCP server" — now the scoped M2 local server.)

## 9 · What could ruin it

- **Scope creep against the cut line.** v2 is an ecosystem; the launch is the cut line in §6.
  Anything that threatens E2's swap date gets phased, not crammed.
- **Binary size creep.** The size gate exists from E1, per platform, forever; voice/vision are
  excludable children precisely so the core stays ≤ 8 MB.
- **Android GPU roulette.** Vulkan is driver-dependent; CPU (NEON/i8mm) is the default, GPU is
  opt-in per device — never a silent default.
- **The upstream treadmill.** Pinned vendored snapshots + a monthly bump PR through the full gate
  set; unpinned is chaos, frozen is rot.
- **Model & voice licensing.** Engine ≠ weights; the catalog carries per-model/per-voice license
  metadata and the docs stop implying "any model, no terms".
- **Low-RAM devices.** `DeviceModelRecommender` gating becomes enforced (refuse-with-typed-error
  below floor), not advisory.
- **The local server as an attack surface.** Loopback-only, per-session token, external (desktop)
  consumers behind explicit per-connection consent, mutating tools behind snapshots + approval —
  and all of it fixtures, not prose.
- **Boundary erosion.** Base vs server node vs PowerSync stays as §4.7 states it; the first
  "just this once" unification request gets a proposal, not a patch.
- **Mirror discipline.** The public repos are generated, read-only trees (D5): a commit made on
  a mirror is lost on the next sync, the monorepo is never tagged, and SPM consumers install
  from mirror tags only. The first person to "fix" SPM by tagging the monorepo breaks the
  version law.
- **The v4 window.** Until the v4 runtime swap ships (D14), production apps carry the restricted
  license — the program's most time-sensitive external dependency, and the reason the ABI stays
  drop-in-shaped.
- **Crash loops.** In-process C++ inference can take the app down; without the quarantine marker
  (§4.13) a bad model+device pair becomes a relaunch crash loop in a CUSTOMER's app. The marker
  is v1 scope, not polish.
- **Copyleft blindness.** The license gates classify restricted/proprietary — GPL sails through
  them green. The schema gains a copyleft dimension, the open packages gate on it (they can
  never carry GPL under Apache-2.0), and espeak-ng is the case that proved the hole (D2).
- **Arbitrary-model supply chain.** Opening downloads to any origin is the feature AND the
  attack surface; the four locks (§4.4) are the answer, and the pre-flight validator's fuzz
  target is not optional once D16 is open at launch.
- **Two-build parity.** The SPM source-target build and the DSX xcframework build must not
  drift into "the OSS package is the slow path" — a nightly decode-tps parity band asserts it.
- **Protocol churn.** MCP revises fast (transports and auth have already churned once). Policy:
  ride the official SDKs, pin them like every dependency, state the supported protocol-revision
  window per release, and degrade capability-gated features gracefully — never fork the spec.
- **Embedding drift.** A new embedder silently invalidates every stored vector. Base index
  entries carry (model id, dimension, revision); a mismatch is a typed error with an explicit
  reindex path — never a silent wrong-answer search.
- **OTA regressions.** The catalog and router.json retune the whole fleet — which is the point,
  and the danger. Promotion runs the eval gate (W-EVAL) once it exists; until then, catalog
  changes get the same review weight as code.
- **Overclaiming.** Every pillar in §4.0 traces to an enforced property; a marketing sentence
  without a gate behind it is a defect (`on-device-ai.md`'s standing rule).

## 10 · Decisions

1. **D1 — names. RESOLVED (owner, 2026-07-29; renamed by the owner 2026-08-16):**
   **Despia AI** · **Despia Local** · **Despia MCP**; published as SPM + Maven packages with DSX
   wrapper modules; the module scheme stays `intelligence`. The data plane shipped one wave as
   "Despiabase" (a Supabase play); the owner retired that name before anything was published so
   every repo follows the `despia-<product>` pattern. The Swift product is `DespiaLocal` and the
   Maven artifact is `com.despia:local`: code identifiers in their own languages' casing.
2. **D2 and D7 — speech extras and default voices. RESOLVED TOGETHER (2026-08-03), by
   dropping sherpa-onnx rather than by settling for worse voices.** The audit was done by
   reading sherpa-onnx's actual build graph: `SHERPA_ONNX_ENABLE_TTS=ON` unconditionally
   includes `espeak-ng-for-piper` and links `piper_phonemize` with no opt-out, and the apparent
   escape hatch is not one — `kokoro-multi-lang-lexicon.cc` includes `espeak-ng/speak_lib.h` and
   falls back to espeak for out-of-vocabulary words. So sherpa-onnx cannot carry TTS into an
   Apache-2.0 statically linked package.

   **The GPL was never in Kokoro. It was in sherpa-onnx's graph.** Every piece of a Kokoro stack
   is permissive once that dependency is routed around: the Kokoro-82M weights are Apache-2.0,
   the community ONNX build (q4/q8/fp16) is Apache-2.0, ONNX Runtime is MIT, and misaki — the
   G2P — is Apache-2.0 with espeak as an OPTIONAL fallback that its own documentation shows
   disabled (`fallback=None`). **That last clause is true and was materially misleading, so
   it is corrected here rather than left to mislead again.** Turning the fallback off does
   not leave a working phonemizer: misaki carries a bundled lexicon (90k+93k entries,
   1.34 MiB compressed, already in Kokoro's own alphabet) but **no letter-to-sound rules at
   all** — espeak IS the fallback, and misaki's own tracker carries an open TODO to build a
   replacement. With it disabled an out-of-vocabulary word yields a character the model's
   vocabulary does not contain, which the normalizer then strips, so **the word is silently
   DELETED from the speech rather than mispronounced**. Measured over 550,184 tokens: 1.0 to
   2.1% miss on prose, 9.5% on technical text, roughly halved by CMUdict — but the residual
   is almost entirely PROPER NOUNS. Names, contacts, cities, products. Common vocabulary is
   about 99% solved and the part that is not is precisely what an app reads aloud, which is
   why tier 2 remains a typed absence: an assistant that drops the name out of "call Sarah"
   is broken in a way its user cannot diagnose. The phonemizer is the licensed part, not the acoustic model, and
   it is separable.

   The resolution therefore has two tiers, which is also what makes it flexible:

   - **Default: the platform's own synthesizer** (`AVSpeechSynthesizer`, Android
     `TextToSpeech`). Zero bytes of binary, zero licence risk, every language the OS ships, and
     it works on a device that has downloaded nothing. This is the same law the framework
     already applies to UI in `system-defaults.md` — the unstyled baseline IS the platform — and
     `Core/WebPlatform/SpeechSynthesis` is the existing precedent.
   - **Opt-in: Kokoro through ONNX Runtime**, with a lexicon G2P and no espeak anywhere. An app
     that wants a specific neural voice adds weight deliberately, and pays the size for it.

   **espeak-ng and sherpa-onnx TTS are both REJECTED, and recorded here so neither is
   reintroduced by someone who only reads the voice list.** `check_dependency_licenses.rb`
   enforces it: LGPL counts as copyleft in this repo because static linking defeats the
   dynamic-linking escape, so the gate catches a reintroduction rather than trusting a habit.
3. **D3 — tool-exposure grammar:** `facets.tools` rows (recommended — facet-contracts precedent)
   vs a per-action manifest key. Decide in E4 design; `facets.mcp` and `facets.provider` follow
   the same pattern.
4. **D4 — MCP auth UX:** bearer first; OAuth when a real server demands it. Local-server default
   exposure: loopback + token, in-app consumers only; desktop external access opt-in per
   connection.
5. **D5 — RESOLVED (research, 2026-07-29): public mirrors AT launch; the monorepo stays the
   source of truth.** There is no repo "split": SPM needs a public repo root, and the machinery
   already exists — `mirror_public.rb` + one `mirror.json` per package generates read-only
   mirror repos with `v<VERSION>` tags cut by `tag_from`; development never leaves the monorepo,
   and the monorepo is never tagged. Modules flip `path:` → `github:` locators after the first
   mirror push (W-FLIP, `local-ai-execution.md`).
6. **D6 — system-model backends** (FoundationModels / AICore / Phi Silica) behind the `system`
   engine id: post-v1; the ABI reserves the seam.
7. **D7 — default voices:** the default voice SET, per locale (not one voice — an
   Arabic-locale app getting English-only TTS with no typed signal would be a launch-day
   embarrassment for a UAE-flagged product), with per-voice license metadata. Answered jointly
   with D2's phonemizer audit, before V1 lands.
8. **D8 — image-generation entry criteria:** name the floor (permissively-licensed step-distilled
   model, device class, latency ≤ a few seconds, peak memory budget) that opens track G.
9. **D9 — Despia Local encryption story:** platform file protection vs SQLCipher-class encryption
   at rest. Decide in B1 design; affects the "own your data" copy.
10. **D10 — Base↔server sync seam:** explicitly not v1; PowerSync remains the vendor path. A
    future proposal owns it or it doesn't happen.
11. **D11 — mirror repo naming. RESOLVED (owner, re-ruled 2026-08-16):** `despia-native/despia-ai`
    · `despia-native/despia-local` · `despia-native/despia-mcp`. The data-plane repo was briefly
    `despiabase` (the D1 wordplay); the final ruling renames it `despia-local` so the whole org
    reads `despia-<product>`, and the GitHub rename preserves redirects from the old name.
12. **D12 — the shared content generation's owner + channel (channel RESOLVED by direction,
    2026-07-29):** the model catalog, `router.json`, the MCP server list, and agent presets ride
    one `dsx.content` folder served from **the app's own content root (`/dsx/ai/`) — models ship
    OTA exactly like screens**; Despia's curated catalog is an upstream the dashboard/build
    merges from, and a Despia-operated default mount is an app-level opt-in (disclosed,
    unauthenticated, disableable). Still open in D12: the owning module (an MCP-only app must
    still receive its server list) and the `bundle_signing` key-rollout story.
13. **D13 — the dual-emit retirement version:** the legacy broadcast mirror retires at a NAMED
    package VERSION, not "one release later" prose.
14. **D14 — the v4 runtime adoption timeline:** the engine artifact is drop-in for the shipped
    v4 runtime (same C ABI seam); the swap is owned outside this repo and needs a dated owner
    commitment — the license exposure clock runs until it ships.
15. **D15 — external contributions:** the mirrors are generated, so external PRs cannot merge
    there; policy = DCO sign-off + maintainer port-with-attribution into the monorepo
    (recommendation), plus SECURITY.md private disclosure and named issue-triage ownership.
    Decide before the first mirror push.
16. **D17 — the `provider` word needs an owner the grammar can express. RAISED BY
    EXECUTION (W-FACETS). RESOLVED (2026-08-01) by option (a), landed.** The plan (execution
    doc W-FACETS, Appendix A3) registers BOTH `tools` and `provider` on `Core/LocalAI` as "two
    separate blocks". The landed grammar could not express that: `dsx_graph.rb` read ONE
    `facet` binding per module (String or a single object with one `word`), and
    `facet_declaration_errors` enforces "a namespace has ONE owner" — proven by making a second
    module claim `tools`, which aborts prepare. The options were: **(a)** teach `facet` to
    accept an ARRAY of registrations — the fan-in already keys by word, so this is additive and
    small, and it matches what the appendix meant; **(b)** give `provider` its own
    always-present owner module; **(c)** own `provider` from a child. **(a) is the answer.**
    An array element is a word String or an object-form registration and is validated exactly
    as it would be alone: the array is repetition, not a second grammar. `facet_words` returns
    every word, `facet_word` keeps naming the first (folder and target binding are
    single-valued by nature), and the one-owner law now also holds WITHIN a module — the same
    word bound twice in one array aborts, so the law cannot be dodged by self-collision. Both
    words are registered on `Core/LocalAI`; `DespiaAssembly.json` carries
    `"provider": ["Core/LocalAI"]`. (c) was wrong and stays recorded so nobody picks it later:
    excluding that child would delete the provider NAMESPACE, taking every per-app provider row
    with it — the registry owner must outlive every provider it registers.
17. **D16 — arbitrary models. RESOLVED by direction (2026-07-29): OPEN at launch, under the
    four locks.** Any-origin model downloads are a feature, gated by the named regime (§4.4):
    the `allowed_model_hosts` origin allowlist in the AI module's settings, digest discipline
    (declared, or pinned-on-first-download and verified forever after), the fuzz-hardened
    pre-flight validator, and fit + quarantine. Local file import (no network origin at all)
    remains the deferred tail with its own threat model.
