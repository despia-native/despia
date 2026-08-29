# Changelog

All notable changes to Despia AI. The version here is the package's own; it is
independent of the DSX kernel's version and of the wrapper module's manifest
version, which move for their own reasons.

## 0.0.1

The first cut of the package: the seam, the fixtures that keep it honest, and
the three real backends underneath them.

This section was CORRECTED after `v0.0.1` was tagged. It used to say the release
loaded no real model, which was never true of the bytes the tag carries - they
include the vendored engines and the gguf, whisper and g2p backends listed
below. The tag itself is untouched, because a published tag is never re-cut; what
changed is the description of what it always was.

- The C ABI (`engine/include/despia_ai.h`): versioned, self-describing through
  `despia_ai_capabilities()`, additive-only, with the threading and reentrancy
  contract stated as part of the ABI rather than as folklore.
- The C++17 core: a backend REGISTRY rather than an enum, typed validation at
  the boundary (no verbatim vendor blob), the streaming envelope with
  sequence-numbered deltas, the crash-quarantine marker, and a dependency-free
  JSON implementation.
- The pre-flight validator: a bounded, allocation-disciplined GGUF header parse
  that clears a file before any tensor loader maps it.
- MockEngine: one deterministic backend behind the same ABI, plus a subordinate
  TypeScript port gated by the same fixtures.
- The vendored engines: ggml, llama.cpp and whisper.cpp, committed rather than
  fetched, each MIT and each pinned to a commit in `vendor/VERSIONS`. One shared
  ggml, two recorded patches, and the prune lists in `docs/vendoring.md`.
- Three real backends on that seam: `gguf` (text completion with streaming,
  embeddings, GBNF grammars, structured output, tool calling, tokenize, mmap),
  `whisper` (transcribe, streaming `listen` with partials, VAD, language
  detection, timestamps) and `g2p` (text to phonemes from a `.dspg` pack, which
  links nothing at all). They are compiled by both native lanes and exercised by
  hand against a downloaded model through `engine/test/model_smoke.c`,
  `stream_smoke.c` and `governor_smoke.c`; the gates themselves run the mock,
  because this repository carries no weights.
- Absent on purpose, and named rather than implied: no vision (llama.cpp's
  `tools/mtmd` is not vendored), no speech synthesis, and no GPU on the SPM lane
  (`Package.swift` states both reasons in its header).
- The TypeScript reference host: catalog, fit, router, tool registry, the
  depth-capped agentic loop, approvals, transcript, and typed absence.
- Conformance: `OpenSource/Conformance/ai` runs green on the TS runner
  (`node conformance/run.ts ai`) and on the Kotlin/JVM host, which drives the
  real C++ core through the real C ABI over JNI.
- The OPEN CATALOG: `models.add` turns a registry reference (`hf:org/repo/file.gguf`,
  or `hf:org/repo` plus a `prefer`) into an ordinary catalog entry at RUNTIME,
  so an app is not limited to the rows it shipped with. The registry's answer is
  treated as untrusted input throughout - the app declares the URL templates, both
  legs are origin-checked before a byte is sent, a revision must be an immutable
  commit, a malformed digest is dropped rather than stored, the FILE's own GGUF
  header outranks the API on context length and family, and an absent licence is
  recorded rather than invented. Entry synthesis is ONE function
  (`bindings/*/catalog.*`), shared with `tools/hf-import.ts`.
- `download` now consults the fit verdict BEFORE the transfer and refuses a model
  this device cannot run, naming the verdict, the reason, and the best model of
  the same kind that does run - or stating that there is none.
- `models.best({task?, category?})`: what this device should download, with the
  verdict attached, so a surface can say "runs well, 1.2 GB" rather than a name.
