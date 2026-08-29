# Despia as an AI-ready app framework

Despia ships **on-device AI as a first-class capability**, not a bolt-on. An AI feature is
just a **module**: it loads a model, runs inference natively, and *provides* the result on
the `dsx` bus; any surface — the web view (`<DSXWebView/>`) or native UI (`<DSXView/>`) — *consumes*
it. There is no "AI server" and no per-call API key baked into the app. The framework gives a
module everything it needs to be intelligent: **inference runtimes**, two **model-delivery
mechanisms**, and the bus to expose the capability.

This page is the map. The mechanism docs it points at are authoritative.

> **Read "Honest status" below before quoting this page.** The framework capabilities here are
> real, but only one AI module is in a shipping profile today (Studio's DSP/ONNX work). LocalAI —
> the general intelligence module — is in `qa-expanded` and is still out of `production-minimal`.
> "On-device" is also not the same as "nothing leaves the device": a third-party inference SDK can
> carry its own telemetry, and a module that forwards page-supplied options to it verbatim cannot
> promise otherwise. That risk is why LocalAI now runs on an engine this repository owns and can
> read. Say what is enforced, not what sounds good.

## What "AI-ready" means here

| Pillar | What the framework provides | Where |
|---|---|---|
| **Inference runtimes** | CoreML, ONNX Runtime, the Despia AI engine (llama.cpp / whisper.cpp under an owned C ABI), and native DSP (Accelerate/vDSP) — all on-device, all reachable from a module. | this doc |
| **Model delivery** | Two first-class ways to get weights onto the device: **build-time bundling** (pinned, verified) and **runtime download** (deferred, user-opt-in). | [`module-weights.md`](../../Skills/module-weights.md) |
| **Native compute** | C/C++/Rust inside a module via the `languages` primitive — for a custom kernel, a DSP core, or a vendored inference lib. | [`native-languages.md`](../../Skills/native-languages.md) |
| **Exposure** | The model's output is published with the normal bus shapes (`dsx.resolve`, `dsx.module.<scheme>`, `dsx.context`, `dsx.fire`) — equal to every other module. | [`cross-module-calls.md`](../../Skills/cross-module-calls.md) |
| **Privacy / cost** | Inference runs locally → works offline and has **zero per-call cost**. "No user data leaves the device" is a property of the *module you write*, not a framework guarantee: a vendor SDK may telemeter, and any options you forward from a page are yours to filter. LocalAI is the worked example of removing the question instead of gating it — the engine is in-repo source with no telemetry symbol in its ABI. | — |

## The inference runtimes a module can use

A module picks whatever runs its model — they are not mutually exclusive, and a single module
can use several:

- **CoreML** (`import CoreML`) — Apple's Neural Engine path. No pod; built into iOS. Best when a
  model converts cleanly to `.mlpackage`/`.mlmodelc`.
- **ONNX Runtime** (`onnxruntime-objc` pod) — the portable path for PyTorch/ONNX graphs that don't
  convert to CoreML. Runs on CPU and (with the CoreML execution provider) the Neural Engine.
- **The Despia AI engine** (`OpenSource/AI`, consumed as an SPM path dependency on Apple and
  built into one `libdespia_ai.so` on Android) — on-device LLMs, Whisper ASR, embeddings and a
  phoneme frontend. GGUF and whisper-ggml models. This is what the **LocalAI** module is built
  on. It is Apache-2.0 over MIT vendored engines (ggml, llama.cpp, whisper.cpp, pinned in
  `OpenSource/AI/vendor/VERSIONS`), so there is no redistribution restriction and no vendor
  telemetry to gate: the C ABI has eleven exported symbols and none of them opens a socket.
- **Native DSP** — Accelerate/vDSP for classical signal processing (FFT, filtering, pitch
  detection). Not every "AI" feature needs a neural net; **Studio's autotune and de-noise are
  exact DSP**, no model required.

Heavy graph ops that no converter accepts can be lifted out of the model and done natively — e.g.
Studio's HT-Demucs export folds the complex STFT into real Conv1d kernels so the graph becomes ONNX-
exportable (see `ClosedSource/DSX/Modules/Core/Studio/AI/README.md`). That pattern — *keep the
exotic op in native code, run the plain network in the runtime* — generalizes.

## Getting the model onto the device — two mechanisms

Choose by size, licensing, and whether every install should carry the weight.

### 1. Build-time bundling — the `weights` primitive
Declare the blob in the module manifest; the build downloads it, **verifies its SHA-256**, and
bundles it into the app. The repo never carries the binary.

```json
"weights": [
  { "path": "model.onnx",
    "url":  "https://huggingface.co/<you>/<repo>/resolve/main/model.onnx",
    "sha256": "…64-hex…" }
]
```

Use it when the model should **ship with the app** (works on first launch, fully offline) and is
hash-stable. Tamper-evident (a wrong hash aborts the build), optional-safe (an unhosted URL is a
soft-skip), idempotent. Full contract: [`module-weights.md`](../../Skills/module-weights.md).
*Live example:* `Studio/dsx.json` bundles HT-Demucs for neural vocal isolation.

### 2. Runtime download — the deferred path
The module fetches the model on first use into Application Support (survives app updates, user-
deletable). Use it when the model is **large, optional, or chosen at runtime** (a catalog of LLMs),
so the app stays small until a user opts into the feature.

**There is no framework machinery here.** Unlike `weights`, runtime download is *just code the
module writes*, and it inherits **none** of the `weights` guarantees: no pinned hash, no verify
step, no build-time abort. Whatever integrity you want, you implement.

*Worked example:* **LocalAI** downloads GGUF/Whisper models via `HuggingFaceDownloader.swift` /
`.kt`, and it is worth reading because it had to build every guarantee `weights` gives for free.
Four locks apply to every model, catalog row or bring-your-own: an https origin allowlist checked
before a byte moves, digest discipline (a declared `sha256` verified on every fetch, or pin-on-
first-download for a model that declares none), a GGUF pre-flight parse before the loader maps the
file, and a storage floor. Each shipped row is pinned to an **immutable commit**, never a branch
or a tag, and a failed check DELETES the file rather than leaving it for the loader. If you build
a runtime-download path, copy that shape: pin a digest per model and verify before use.

> Rule of thumb: **ship-with-app and always-on → `weights` (verified); large/optional/user-chosen →
> runtime download (verification is on you).**

## Honest status — what runs, and what does not

Two AI modules exist in-tree. They are **not** in the same state, and this page used to list them
as if they were.

### Shipping

- **Studio** (`scheme: studio`) — a native DAW whose **AI section** runs:
  - **Isolate vocals** — HT-Demucs (MIT) through **ONNX Runtime**, bundled via `weights`
    (build-time, SHA-256 pinned).
  - **Autotune** — real YIN pitch detection → scale snap → cents correction (native DSP).
  - **Enhance / Clean up** — live polish + downward-expander de-noise (native DSP).

  This is the precedent to copy: a permissive model, delivered by the verified mechanism, with the
  exotic ops lifted into native code.

### In QA, not yet in production

- **LocalAI** (`scheme: intelligence`) — LLM chat completion, Whisper ASR, embeddings and RAG on
  the **Despia AI** engine, models downloaded on demand. The code is complete and cross-platform
  (Swift + Kotlin twins). What changed, and what has not:
  - the licence blocker is **gone**. The engine is `OpenSource/AI` (Apache-2.0 over MIT vendored
    engines), reached by an SPM `path` product on Apple and an in-repo `path:` build locator on
    Android. The manifest declares no CocoaPod and no restricted dependency at all, so
    `check_dependency_licenses.rb --public-release` has nothing left to fail on;
  - it is **in `qa-expanded`** (an exclude-mode profile that no longer names it) and still **out of
    `production-minimal`** (an allowlist that does not list it). The reasons that keep it out are
    stated in `production-minimal.json` and neither is licensing: it is opt-in megabytes, and its
    Kotlin facet cannot resolve `com.despia.ai` in `RuntimeAndroid` today;
  - **no native artifact is committed**, on purpose. The Android `.so` is BUILT from the in-repo
    package by the manifest's `build` entry (a machine with no NDK soft-skips it and every
    inference call answers code 20), and the Apple lane compiles the package from source through
    SPM;
  - the **download-integrity gap is closed**: immutable commits, declared digests, four locks
    (§2 above);
  - runtime proof is still partial. Every catalog row was loaded through `despia_ai_load_model`
    before it was written down, but no CI lane runs inference on either native path — the
    real-weights drivers in `OpenSource/AI/engine/test/` are hand-run.

  The engine program itself is [`proposals/local-ai-engine.md`](proposals/local-ai-engine.md):
  own the engine, make the privacy and licensing claims enforced, and go agentic-first (tools, MCP
  both directions, voice, the Despia Local data plane).

Between them the framework has exercised audio (separation/DSP, shipping) and text/speech (LLM/ASR,
in QA) — do not read the second as production-delivered.

## Adding a new AI feature (the recipe)

1. **Pick a runtime** for your model (CoreML / ONNX Runtime / Despia AI / DSP).
2. **Deliver the model** — `weights` (bundled) or a runtime download.
3. **Author the module** ([`writing-a-module.md`](../../Skills/writing-a-module.md)) — load the
   model, run inference off the main thread, and **resolve** the result. If the model is absent,
   report unavailable — never fake a result.
4. **Expose it on the bus** — a named action (`dsx.module.<scheme>.<action>`), live status via
   `dsx.context`, events via `dsx.fire`. Surfaces consume it like any capability.
5. **Need native code?** Declare `languages` and drop in C/C++/Rust ([`native-languages.md`](../../Skills/native-languages.md)).
6. **Earn the privacy claim.** If you intend to say "nothing leaves the device", make it true:
   prefer an engine whose sources you can read over a binary you cannot, gate any vendor telemetry
   OFF by default behind a config key, don't forward page-supplied option dicts to an engine
   unfiltered, and verify anything you download. Otherwise say what is actually enforced — an
   overclaiming README is a defect. LocalAI's README is the model: it names what is guaranteed and
   what is not, in that order.

The model is the only new thing; the *plumbing* — delivery, gating, exposure, cross-platform payloads —
is the framework's, identical to a non-AI module. That is what makes Despia AI-ready.

## See also
- [`proposals/local-ai-engine.md`](proposals/local-ai-engine.md) — the **Despia AI** program
  (the owned, agentic Despia stack: streaming, tools, MCP client + local MCP servers, voice,
  vision, Despia Local).
- [`module-weights.md`](../../Skills/module-weights.md) — bundling large models, securely.
- [`native-languages.md`](../../Skills/native-languages.md) — C/C++/Rust in a module.
- [`dsx-native-bus.md`](dsx-native-bus.md) — modules provide, surfaces consume.
- `ClosedSource/DSX/Modules/Core/Studio/AI/README.md` — a worked model conversion (PyTorch → ONNX).
- `ClosedSource/DSX/Modules/Core/LocalAI/README.md` — the on-device LLM/ASR/RAG module
  (in `qa-expanded`, not in `production-minimal`; its privacy section states precisely what is and
  is not guaranteed).
