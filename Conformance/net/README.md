# Conformance: `net`

The connectivity plane (`ClosedSource/DSX/Modules/Core/Net`, plan
`ClosedSource/Documentation/v4-launch/parity/F05-net.md`).

| Fixture | Pins |
|---|---|
| `status.json` | the classification fold (raw path snapshot to the five reported facts), the `online` vs `reachable` split, the radio-family mapping, and the probe verdict including the captive-portal redirect test |
| `transitions.json` | the debounce state machine as timelines: first update immediate and silent, one event per settled transition, and a flap inside the window producing nothing |

Everything here is **pure**: a snapshot or a timeline in, a verdict out. The platform reads that
feed it (`NWPathMonitor`, `ConnectivityManager`, `navigator.connection`) are per-renderer plumbing
and are deliberately not pinned, exactly as `input/orientation.json` pins the vocabulary fold and
not `requestGeometryUpdate`.

**Three runners, one shared core.** The fold lives in `NetCore` / `NetDebounce`
(`OpenSource/Web/packages/kernel/src/net-core.ts`,
`OpenSource/Engine/Android/core/.../NetCore.kt`, `OpenSource/Engine/iOS/NetCore.swift`) and
`Core/Net` calls it rather than keeping a parallel copy, so these cases judge the shipping code:

| Renderer | Runner |
|---|---|
| TS | `packages/kernel/test/net-conformance.test.ts` (`node --test`) |
| Kotlin | `:core NetConformanceTest` (`gradle test`) |
| Swift | `NetConformance.verify` in the `conformance-record` lane |

The debounce timelines drive the machine on a VIRTUAL clock; the module drives the same machine
from a real timer, so the corpus and the device disagree only if the module is wrong.

Not covered here, on purpose: `gating.json` from the plan (an `<api requires="online">` block
waiting instead of failing) belongs with the kernel integration it describes, which is also in the
handoff. A fixture for behaviour no renderer implements yet would read as a passing contract.
