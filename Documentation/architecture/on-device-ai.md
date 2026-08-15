# Despia as an AI-ready app framework

Despia ships **on-device AI as a first-class capability**, not a bolt-on. An AI feature is
just a **module**: it loads a model, runs inference natively, and *provides* the result on
the `dsx` bus; any surface — the web view (`<DSXWebView/>`) or native UI (`<DSXView/>`) — *consumes*
it. There is no "AI server" and no per-call API key baked into the app. The framework gives a
module everything it needs to be intelligent: **inference runtimes**, two **model-delivery
mechanisms**, and the bus to expose the capability.

This page is the map. The mechanism docs it points at are authoritative.

> **Read "Honest status" below before quoting this page.** The framework capabilities here are
> real, but exactly one AI module ships today (Studio's DSP/ONNX work). LocalAI — the general
> intelligence module — is a **prototype excluded from every release profile**. "On-device"
> is also not the same as "nothing leaves the device": a third-party inference SDK can carry
> its own telemetry, and a module that forwards page-supplied options to it verbatim cannot
> promise otherwise. Say what is enforced, not what sounds good.

## What "AI-ready" means here

| Pillar | What the framework provides | Where |
|---|---|---|
| **Inference runtimes** | CoreML, ONNX Runtime, llama.cpp (Cactus), and native DSP (Accelerate/vDSP) — all on-device, all reachable from a module. | this doc |
| **Model delivery** | Two first-class ways to get weights onto the device: **build-time bundling** (pinned, verified) and **runtime download** (deferred, user-opt-in). | [`module-weights.md`](../../Skills/module-weights.md) |
| **Native compute** | C/C++/Rust inside a module via the `languages` primitive — for a custom kernel, a DSP core, or a vendored inference lib. | [`native-languages.md`](../../Skills/native-languages.md) |
| **Exposure** | The model's output is published with the normal bus shapes (`dsx.resolve`, `dsx.module.<scheme>`, `dsx.context`, `dsx.fire`) — equal to every other module. | [`cross-module-calls.md`](../../Skills/cross-module-calls.md) |
| **Privacy / cost** | Inference runs locally → works offline and has **zero per-call cost**. "No user data leaves the device" is a property of the *module you write*, not a framework guarantee: a vendor SDK may telemeter (gate it off — LocalAI's `telemetry` config is the worked example) and any options you forward from a page are yours to filter. | — |

## The inference runtimes a module can use

A module picks whatever runs its model — they are not mutually exclusive, and a single module
can use several:

- **CoreML** (`import CoreML`) — Apple's Neural Engine path. No pod; built into iOS. Best when a
  model converts cleanly to `.mlpackage`/`.mlmodelc`.
- **ONNX Runtime** (`onnxruntime-objc` pod) — the portable path for PyTorch/ONNX graphs that don't
  convert to CoreML. Runs on CPU and (with the CoreML execution provider) the Neural Engine.
- **llama.cpp via Cactus** (`Cactus` xcframework) — on-device LLMs, Whisper ASR, embeddings/RAG.
  GGUF models. This is what the **LocalAI** module is built on — and LocalAI is a prototype that
  ships in no profile, so treat this row as "the integration exists in-tree", not "this runs".
  Cactus is also license-restricted (no DSX redistribution sublicense) and carries its own
  telemetry, which LocalAI now keeps **off by default** behind a config opt-in.
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

*Only example:* **LocalAI** (a prototype, see "Honest status") downloads GGUF/Whisper models via
`HuggingFaceDownloader.swift` / `.kt`. It is also the cautionary tale: the blob is handed to the
engine **unverified**, from a **mutable** revision (`main`, or a re-pointable `v<sdk>` tag) rather
than a commit SHA. Both downloaders now log a warning on every fetch, and the gap is documented at
the call site — but it is **not fixed**. If you build a runtime-download path, pin a digest per
model and verify before use.

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

### Prototype — excluded from every profile, on both platforms

- **LocalAI** (`scheme: intelligence`) — LLM chat completion, Whisper ASR, embeddings and RAG via
  the Cactus (llama.cpp) engine, models downloaded on demand. The code is complete and
  cross-platform (Swift + Kotlin twins), and it **runs nowhere**:
  - it is absent from the `production-minimal` allowlist and explicitly excluded from
    `qa-expanded` (`ClosedSource/release/profiles/`), so **no release build contains it**;
  - its Cactus dependency is license-restricted — no commercial use, no DSX redistribution
    sublicense — and `check_dependency_licenses.rb --public-release` fails the public build if it
    is enabled;
  - no native artifact is committed for either platform, so nothing links even if enabled;
  - its runtime model download is **unverified from a mutable revision** (§2 above);
  - neither native path has runtime proof (no artifact/inference tests in any lane).

  Enabling it is a private-integration project — own rights, own artifacts, own linkage, own
  runtime tests, plus closing the download-integrity gap. An allowlist entry is not readiness.

  The program to end this state — **Despia AI**: replace Cactus with an owned, open engine
  (llama.cpp/whisper.cpp under a Despia ABI), make the privacy and licensing claims enforced, and
  go agentic-first (tools, MCP both directions, voice, vision, the Despiabase data plane) —
  is [`proposals/local-ai-engine.md`](proposals/local-ai-engine.md).

Between them the framework has exercised audio (separation/DSP, shipping) and text/speech (LLM/ASR,
prototype) — do not read the second as delivered.

## Adding a new AI feature (the recipe)

1. **Pick a runtime** for your model (CoreML / ONNX Runtime / Cactus / DSP).
2. **Deliver the model** — `weights` (bundled) or a runtime download.
3. **Author the module** ([`writing-a-module.md`](../../Skills/writing-a-module.md)) — load the
   model, run inference off the main thread, and **resolve** the result. If the model is absent,
   report unavailable — never fake a result.
4. **Expose it on the bus** — a named action (`dsx.module.<scheme>.<action>`), live status via
   `dsx.context`, events via `dsx.fire`. Surfaces consume it like any capability.
5. **Need native code?** Declare `languages` and drop in C/C++/Rust ([`native-languages.md`](../../Skills/native-languages.md)).
6. **Earn the privacy claim.** If you intend to say "nothing leaves the device", make it true:
   gate any vendor telemetry OFF by default behind a config key (LocalAI's `telemetry` is the
   pattern), don't forward page-supplied option dicts to an engine unfiltered, and verify anything
   you download. Otherwise say what is actually enforced — an overclaiming README is a defect.

The model is the only new thing; the *plumbing* — delivery, gating, exposure, cross-platform payloads —
is the framework's, identical to a non-AI module. That is what makes Despia AI-ready.

## See also
- [`proposals/local-ai-engine.md`](proposals/local-ai-engine.md) — the **Despia AI** program
  (replace Cactus with an open, agentic Despia stack: streaming, tools, MCP client + local MCP
  servers, voice, vision, Despiabase).
- [`module-weights.md`](../../Skills/module-weights.md) — bundling large models, securely.
- [`native-languages.md`](../../Skills/native-languages.md) — C/C++/Rust in a module.
- [`dsx-native-bus.md`](dsx-native-bus.md) — modules provide, surfaces consume.
- `ClosedSource/DSX/Modules/Core/Studio/AI/README.md` — a worked model conversion (PyTorch → ONNX).
- `ClosedSource/DSX/Modules/Core/LocalAI/README.md` — the on-device LLM/ASR/RAG module
  (**prototype**; its privacy section states precisely what is and is not guaranteed).
