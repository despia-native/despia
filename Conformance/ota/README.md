# ota/ — the OTA runtime-safety corpus

The two decisions a device makes about an OTA generation **before** it applies one
(`parity/P05-ota.md` §4b and §4c), executed as fixtures:

- **Staged rollout, evaluated on device.** The manifest carries
  `{"rollout": {"fraction": 0.1, "salt": "gen-8a3f"}}`. The client hashes its own
  installation id with the salt and applies the generation only if the bucket falls
  under the fraction. No coordination, no server, no assignment call, deterministic
  per device. Raising the fraction is a manifest edit, and because the hash is stable
  the population only ever grows: a device that took generation N at 10 percent still
  has it at 50 percent.
- **`runtimeVersion` gating.** The manifest declares the native runtime contract the
  generation needs; a client whose binary is older refuses it and keeps the last good
  generation. This is what stops an OTA referencing a module the installed binary does
  not contain, which is the most common way an OTA system bricks an app. There is no
  silent bypass: every refusal has a machine id and is reported.

Both halves are pure arithmetic and comparison, so one file judges three renderers.

## `rollout.json`

| Block | What it pins |
|---|---|
| `hash` | the FNV-1a 32-bit constants, the input template, and exact hash + bucket values for nine id/salt pairs, including empty and non-ASCII input |
| `rollout` | the include/exclude rule, with the fraction 0 and fraction 1 edges called out explicitly |
| `monotonic` | the same devices across a rising fraction ladder, so a renderer that dropped a device on a raise fails |
| `compare` | `runtimeVersion` precedence: numeric cores, zero-filled components, build metadata, pre-release ordering, and the unparseable cases that must refuse rather than guess |
| `generation` | the whole gate end to end, including the precedence between the two halves and every verdict in the declared vocabulary |

The bucket is `hash / 2^32`, a value from 0 up to but not including 1 that is exactly
representable as a double, so no renderer rounds differently. FNV rather than SHA-256
because the gate is **synchronous** at load time while the web platform's only hash
(`crypto.subtle`) is async-only, and because a 20-line integer loop is reimplementable
byte-identically in three languages where a crypto binding is not. It is a bucketing
function, not a security primitive: authenticity is the signed manifest's job
(`architecture/remote-bundle-signing.md`), and nothing here weakens it.

## Runners

- **TS** — `OpenSource/Web/packages/kernel/test/ota-conformance.test.ts` against
  `packages/kernel/src/ota.ts`.
- **Kotlin** — `:core OtaConformanceTest` against `despia.engine.OtaGeneration`
  (runs in `gradle test`).
- **Swift** — the reference, `OpenSource/Engine/iOS/OtaGeneration.swift`, on the
  Codemagic record lane.

Every runner also asserts two properties the corpus deliberately does **not** enumerate,
because they are properties rather than cases: comparison is antisymmetric, and the
`applies` sequence across a rising fraction is non-decreasing.
