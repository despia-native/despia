# Despia CICD — the build node (self-hosted lanes on our own Macs)

**Status: ACCEPTED v1 (2026-07-26) — PRODUCTION-READY, pending real-Mac validation.**
The component at `ClosedSource/CICD/` is complete and hardened: extracted lanes +
parity gate · crash-safe indexed queue · CM-faithful runner · HTTP API · signed
webhooks · vault with backup and key rotation · request quotas · metrics ·
log/artifact retention · installer, launchd, doctor · `cicd-gates` in CI · a nine-doc
suite. **184 tests green.** A full adversarial code review (three independent
reviewers) found ~36 defects — all resolved; two were rejected with evidence and the
reasoning recorded in code. **P9 — the real-Mac runbook
(`ClosedSource/CICD/docs/mac-validation-runbook.md`) — remains the gate before a node
is enrolled in production**, because launchd, Keychain, simulators and store
publishing cannot be proven on Linux. The self-hosted CI/CD program. The hosted
Codemagic pipeline (the four-lane design in `ClosedSource/Documentation/codemagic-monorepo.md`,
trigger contract in `ClosedSource/Documentation/codemagic-trigger-reference.md`) becomes the
**legacy twin**: it keeps working unchanged, while the same three app lanes run on our own
Mac mini fleet through a node agent at `ClosedSource/CICD/`. Companion docs:
`../../guides/codemagic-build.md` (the per-app assets contract — unchanged, it IS the build
definition), `ClosedSource/Documentation/despia-cicd-node-api.md` (the node HTTP/webhook
spec), `ClosedSource/CICD/docs/fleet-protocol.md` (the backend integrator contract).

## The law

1. **The config folder is the build definition.** A build request names a lane, a source
   tag, and the per-app assets zip (`App.json`, `excluded.json`, `core_packages.json`,
   `marketing.png`, `Packages/`, `Custom/`). No YAML, no per-app pipeline, no CI edit —
   exactly the contract the hosted pipeline already enforces ("adding a capability is a
   folder, never a CI edit", `ClosedSource/scripts/README.md`). Despia CICD adds **no new
   authoring surface**; it moves where the lanes execute.

2. **Lanes are extracted, never forked.** `ClosedSource/CICD/tools/extract_lanes.rb`
   generates each lane (`lanes/<workflow>/manifest.json` + verbatim `steps/NN-*.sh`) from
   `codemagic.yaml` — the same step bodies, byte-for-byte, wrapper lines included. Its
   `--check` mode is a CI gate: an edit to an app-lane step in the yaml that is not
   regenerated into the lane files (or vice versa) fails the build. One source of truth,
   two executors, drift impossible by construction. Node-specific behavior lives ONLY in
   `overrides.json` (capability gates, publish overlays) — never by editing an extracted step.

3. **Steps stay non-networked; the daemon talks.** `run_step.sh` deliberately makes no
   outbound telemetry request (its guard tests keep it that way). The node daemon tails the
   local `event_log.json` those steps already write and pushes HMAC-signed webhooks from
   *outside* the step chain. The retired `WEBHOOK_URL` contract stays retired.

4. **The fleet has no head.** A node is a complete, self-contained build machine: HTTP API
   on loopback (SSH is the remote transport; an optional TLS listener is opt-in), a
   persistent FIFO queue, and `GET /v1/status` + signed `node.status` heartbeats exposing
   queue depth, capacity, capabilities, toolchain pins, and disk. **Load balancing is the
   backend's job** — any HTTP backend picks the least-loaded node (`fleet-protocol.md` gives
   the algorithm). One build runs at a time per node (`$CM_ENV` is a per-user singleton —
   `$HOME/.codemagic`, pinned by `fetch_signing_material.sh`); capacity scales by adding Macs.

5. **Secrets inherit the existing laws — no new trust surface.**

   | Mechanism | Inherited law |
   |---|---|
   | Per-build broker fetch (`SIGNING_URL` + Bearer token) | `fetch_signing_material.sh` unchanged: committed host allowlist (fail-closed), purpose-scoped envelopes, tombstoning |
   | Node vault (Codemagic-Secret-group equivalent) | AES-256-GCM file vault, master key in the login Keychain; values enter builds as env only; never argv, never printed (`dsx_deploy.rb` law) |
   | Module secrets | `deliver_module_secrets.rb` unchanged: 0600 files, trust tiers, reserved names |
   | iOS certificates | per-build ephemeral keychain (`keychain initialize` … restore login) — the `run_catalyst_ui_tests_ci.sh` pattern |
   | Publish credentials | injected only into the publish step's process env, never `$CM_ENV`; Play uses the already-reserved `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` name |

6. **Publishing is a bound handoff, not a side effect.** The hosted lanes stop at verified
   artifacts and the trigger reference assigns store submission to a "trusted release
   controller" that binds digest + signer to an approved target. The node implements that
   binding: a build publishes only when the **request** says so (`publish: {target, track}`),
   and the publish step re-verifies the artifact's SHA-256 against the verify-step
   attestation before upload. The yaml's publish stubs remain stubs (guard-enforced);
   the real steps are node-origin overlays under `lanes/*/overlay/`.

7. **Capabilities degrade loudly, never silently.** A step whose requirement a node cannot
   meet (x86_64 emulator UI-test gates on Apple Silicon) is skipped **and reported** — a
   runner-origin step event marks it `skipped` in the status stream and webhooks. No silent
   green.

## What a node is

Stdlib-only Ruby (macOS system Ruby 2.6-compatible; zero gems, zero installs beyond the
toolchain the builds themselves need), installed by one command, supervised by a launchd
LaunchAgent (`KeepAlive` — queue survives reboots). Per build: a detached `git worktree`
of the admitted tag, a fresh 0600 `$HOME/.codemagic`, the extracted lane executed step by
step with the same env contract Codemagic provides (`CM_BUILD_DIR`, `CM_BUILD_ID`,
`CM_COMMIT`/`CM_TAG`, `BUILD_NUMBER`, trigger vars, vault-injected group equivalents),
artifacts collected by the lane's globs (SHA-256'd, GC'd, optionally pushed to
backend-presigned URLs), cleanup always (login keychain restored, env file truncated,
worktree removed).

The HTTP surface mirrors the Codemagic REST shape the control plane already speaks —
`POST /v1/builds` → `{buildId}`, `GET /v1/builds/{id}` with the same status vocabulary
(`queued → preparing → building → finishing → finished | failed | canceled | timeout`),
`POST /v1/builds/{id}/cancel` — so a backend ports by changing the base URL, adding the
source `tag`, and swapping polling for signed webhooks (`build.queued|started|step|
succeeded|failed|canceled|timeout`, `node.status`). Step events carry the `run_step.sh`
record verbatim (same 11 keys, same category vocabulary) — the dashboard's existing
status model keeps working.

8. **Fail closed for authority, fail soft for derived state.** `config.json` and the
   vault abort on corruption — a node that cannot read its own configuration or a
   present-but-damaged secret store must never "helpfully" continue with defaults or
   an empty set, because that ships a half-configured or unsigned app. The queue
   index and the metrics counters do the opposite: they are rebuildable from the
   spool, so they repair themselves and log loudly. Knowing which kind a piece of
   state is IS the design decision.

9. **Observability is a first-class surface, not an add-on.** A node reports what it
   is doing (`/v1/status`), what it has done (`/v1/metrics`, durable across
   restarts), and what it cannot do (capability gauges), with fixed cardinality so
   monitoring can never become the load. Retention and rotation are enforced by a
   maintenance tick, not by documentation.

10. **A claim about the running node is proven by running the node.** In-process
    tests cannot see process groups, signal escalation, crash recovery, a
    require graph, or state shared between the daemon and the CLI — and every
    one of those has hidden a severe defect here. So the component ships a
    second gate, `ClosedSource/CICD/tools/verify_local.rb`: it spawns the real
    `bin/despia-cicd server`, drives it over a real socket against a real
    `git worktree` and the real `run_step.sh`, and verifies every webhook with
    the shipped verifier. It is Ruby-2.6-safe so the same command runs on the
    mini, where it also covers the Keychain. Its closing report always names
    what it could NOT prove; that list is the runbook's remit.

## Out of scope (v1)

- A central coordinator/dispatcher — the backend balances; `fleet-protocol.md` is the contract.
- The PR lanes (`android-kernel`, `web-kernel`, desktop) — they stay where git events live.
- Linux build nodes and an arm64 emulator overlay for the Android UI-test gates (v1.1).
- More than one concurrent build per node (the `$CM_ENV` singleton; revisit as v2 with
  per-build users).
- SMTP notifications — webhooks replace email; `EMAIL` is accepted and ignored by the node.

## Open issues (tracked here)

- App Store Connect API key **role** required for `app-store-connect publish` (App Manager)
  — documented in doctor output; validate on the first real TestFlight sandbox publish.
- `security find-generic-password` prompt behavior in a fresh launchd GUI session —
  validated by the Mac runbook (`ClosedSource/CICD/docs/mac-validation-runbook.md`).
- Wear AAB publishing (multi-artifact Play submissions) — v1 publishes the phone AAB;
  Wear rides the same bundle when Play accepts it, else v1.1.
- Broker purposes `ios-publish` / `android-publish` (`publish_material.rb`) ship dark until
  the signing-hosts allowlist is pinned by a protected release commit — same activation law
  as the signing broker.
- **A daemon shutdown mid-build orphans the step's process group.** `SIGTERM` sets
  the stop flag but does not tear down a running step, and launchd escalates to
  `SIGKILL` after its grace period, so a `launchctl kickstart -k`, an upgrade, or a
  system shutdown during a build leaves `xcodebuild` and friends running. The build
  itself is handled correctly — the next boot fails it loudly ("node restarted
  mid-build") — but the processes leak until reboot. Found by `verify_local.rb`
  (its aborted runs left orphans behind). The fix is to run the runner's existing
  `terminate` on shutdown; deferred here only because it changes the shutdown path
  and deserves its own review, and because nothing is silently wrong meanwhile.
  Until then `docs/mac-validation-runbook.md` §4 checks `pgrep xcodebuild` after a
  cancel, and an operator restarting a busy node should cancel first.
