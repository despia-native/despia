# `telemetry/` — the sink adapter's pure core

The law for `Core/Telemetry` (parity/F10-telemetry.md). The module is a **sink adapter**, not a
second error system: the kernel error ledger (`dsx.errors`, ring 128 — `error-system.md`) stays the
source of truth and this drains it. What this corpus pins is the half that must not drift between
renderers, because it decides what leaves the device.

| Fixture | Pins |
|---|---|
| `scrub.json` | every redaction rule and its ORDER, the key-redaction set, and the non-matches that must survive untouched (semantic versions, ISO timestamps, IPv4, UUIDs, and the `<File>.dsx:<line>` frame) |
| `queue.json` | the fingerprint fold (a moving address or index folds to ONE event), deterministic sampling, the bounded dedupe ring with counted oldest-drop, batch capping and the backoff schedule |

Runners, one per renderer, all reading these same files:

| Renderer | Implementation | Runner |
|---|---|---|
| TS | `OpenSource/Web/packages/kernel/src/telemetry.ts` | `packages/kernel/test/telemetry-conformance.test.ts` |
| Kotlin | `Engine/Android/core/.../despia/engine/TelemetryPolicy.kt` | `core/src/test/.../TelemetryConformanceTest.kt` |
| Swift | `Engine/iOS/TelemetryPolicy.swift` | the record lane (`codemagic.yaml`), compile-pending here |

Two rules that are contract, not implementation detail:

1. **Redaction happens at ENQUEUE, never at send.** A crash during flush must not be able to leak
   an unredacted buffer, so the buffer never holds one.
2. **Sampling is a pure function of the fingerprint**, not a random draw, so the same event is
   sampled the same way on every device and a fixture can pin it.
