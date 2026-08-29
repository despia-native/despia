# `livelogs/` — the live-logs wire core

The law for `dev.stream` and everything that speaks its wire (`architecture/proposals/live-logs.md`).
The module is a DEV-CHANNEL tail over the rings the kernel already keeps (`dsx.logs`, `dsx.errors`,
the kernel tail — error-system.md); this corpus pins the pure half that must not drift between
renderers, because it decides what leaves a device and how both ends of the relay agree.

| Fixture | Pins |
|---|---|
| `wire.json` | the ring-entry → wire-row folds (the telemetry scrubber is APPLIED at the fold — the rules themselves stay pinned by `telemetry/scrub.json`; cases here prove the application), the batch body with its monotonic batch index (the relay's idempotency key), the viewers/ttl ack fold (viewers watching → send; nobody watching → PAUSE the wire while the ring keeps recording — a heartbeat still carries acks, so a returning viewer resumes it; deadline passed → stop), the bounded device queue (drop-oldest, counted, batch PEEKS and only the ack removes), and the relay replay ring (seq monotonic from 1, cursor reads, bounded eviction, the gap TOLD to a lagging reader — the `realtime.ts` durable-cursor contract over live rows) |
| `report.json` | the `.dsxreport` envelope: canonical bytes (keys sorted by code point, no whitespace, minimal escaping, unicode raw, INTEGERS ONLY — a float has no canonical form), the self-contained synchronous sha256 (standard vectors), the seal (hash over the canonical bytes WITHOUT the receipt; sealed text WITH it), and the verifier verdicts — `not_report` (the AI-fabricated paste of the motivating incident dies here), `modified`, `genuine`, plus whether an integrity attestation rides the seal (verifying THAT against Apple/Google is the relay/platform's job, never this core's) |

Runners, one per renderer, all reading these same files:

| Renderer | Implementation | Runner |
|---|---|---|
| TS | `OpenSource/Web/packages/kernel/src/livelogs.ts` | `packages/kernel/test/livelogs-conformance.test.ts` |
| Kotlin | `Engine/Android/core/.../despia/engine/LiveLogs.kt` | `core/src/test/.../LiveLogsConformanceTest.kt` |
| Swift | `Engine/iOS/LiveLogs.swift` | `ClosedSource/scripts/swift_conformance_run_test.rb` (Foundation-only, compiled and run on the box) |

Three rules that are contract, not implementation detail:

1. **Scrub at the FOLD, cap after.** A queued wire row never holds an unredacted byte (the
   telemetry law), and redaction sees the whole message before the cap clips it, so a clipped
   token can never be a leaked one.
2. **The ack fold PAUSES, only the deadline STOPS.** Zero viewers for `idleAckPause` consecutive
   acks pauses the wire (the device keeps recording and heartbeats); the session ends only when
   the relay-granted ttl deadline passes. A transport failure changes nothing here — retry
   belongs to the queue's backoff, never to the session state.
3. **The batch index is the idempotency key.** The relay refuses a replayed `n`, so a retried
   POST can never duplicate rows, and seq stays a truth a cursor can rely on.
