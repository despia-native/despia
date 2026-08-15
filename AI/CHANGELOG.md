# Changelog

All notable changes to Despia AI. The version here is the package's own; it is
independent of the DSX kernel's version and of the wrapper module's manifest
version, which move for their own reasons.

## 0.0.1

The first cut of the package: the seam, the mock, and the fixtures that keep
them honest. Nothing here loads a real model yet.

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
- The TypeScript reference host: catalog, fit, router, tool registry, the
  depth-capped agentic loop, approvals, transcript, and typed absence.
- Conformance: `OpenSource/Conformance/ai` runs green on the TS runner.
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
