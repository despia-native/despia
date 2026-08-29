# Live logs — real device logs, streamed to the dashboard, on infrastructure the developer owns

> **Status: LANDED (2026-08-27) — P1, P2, and P3's device + relay halves, same day, owner-directed
> ("prod ready, no gaps").** The corpus, the three-language core, the `dev.stream` module (four
> facets), the `.dsxreport` seal + verifier, the `@despia-native/live` relay, the CLI legs, the dashboard
> panel and the Android channel fill are all in-tree and gated — the build log is §6, including
> the four places this document's first draft was wrong. The one named remainder is the PLATFORM
> half of P3 (the one-click BYO-Cloudflare provisioning + the Apple/Google attestation verify
> round-trip), which rides the platform program's P0 grant store — the relay already stores and
> surfaces the attestation envelope for it.
>
> Originally written against a recurring support failure (§1) and an owner question: how do we
> stream REAL runtime logs from dev-channel installs (TestFlight, Android internal testing, debug
> builds) into the Despia editor in realtime, without expensive WebSocket infrastructure, without
> Despia processing end-user data (GDPR), leveraging the Cloudflare integration as an externally
> billed, first-party-feeling capability?
>
> Companions: `error-system.md` (the diagnostics plane this rides — ledger, log ring, hooks),
> `../../guides/staging-and-testing.md` (the dev center + environment channels),
> `ClosedSource/Documentation/v4-launch/parity/F10-telemetry.md` (`Core/Telemetry`, the
> production sink this deliberately is NOT),
> `ClosedSource/Documentation/v4-launch/dev-preview-and-serverless-plan.md` §3.5 (the standing
> no-Despia-server law), `OpenSource/Web/packages/server/src/realtime.ts` (the durable cursor
> feed this reuses), `ClosedSource/Documentation/v4-launch/product-vision.md` §19–§20
> (orchestrate, do not own; the Connections layer).
>
> **The one-sentence pitch:** the diagnostics feed the dev center Console already renders
> on-device becomes visible in the Despia dashboard in about a second, relayed through a worker
> in the DEVELOPER'S own Cloudflare account — and every diagnostic report becomes a signed,
> verifiable artifact, so support can tell a runtime-produced log from an AI-fabricated one in
> one paste.

---

## 1 · Why (the problem, precisely)

### 1a · The support incident class

A user's app misbehaves. Support asks for logs. The user pastes a JSON blob that LOOKS like
diagnostics — session ids, timestamps, a `userAgent` containing `despia-iphone`, an `events`
array — and support has no way to tell whether it is a runtime export or something an AI
assistant invented. In the motivating incident (2026-08-27) the pasted object was the
customer's own app-level state dump (`workoutSessionV2.rehydrateV2Session`, a
`workout_lifecycle_v2` context — none of its field names exist anywhere in this tree), authored
by the AI that built their web app. Support answered "these are not real Xcode or Android
Studio logs, this is an AI-generated JSON object" — correctly, but only by eyeballing it, and
the user had no idea their logs were synthetic. Both sides lost a round trip and some trust.

Three structural facts produce this class of incident, and each is a gap we can close:

1. **A TestFlight install has no console a developer can see.** The on-device Console
   (`staging-and-testing.md` §2) is exactly right for the tester holding the phone; the
   developer debugging remotely gets whatever the tester copies out — mangled by mail clients,
   truncated by chat apps, or replaced wholesale by an AI's summary of the app's state.
2. **There is no canonical, verifiable report artifact.** `dsx-diagnostics.txt` (the drawer's
   Export) and Copy report are plain text. Nothing distinguishes them from any other text, so
   support cannot verify provenance, and users cannot be expected to know the difference.
3. **Users vibe-coding with AI get AI-shaped diagnostics by default.** The assistant that wrote
   their app also wrote their "logging". The fix is not telling users off — it is making the
   real thing one tap away and self-evidently real.

### 1b · What "real logs" means for a Despia app

For a Despia app the meaningful log stream is not the OS firehose — it is the unified
diagnostics plane the kernel already maintains on every renderer, corpus-gated
(`Conformance/logs/`, `Conformance/errors/`):

| Ring | Cap | What it carries |
|---|---|---|
| `dsx.logs` (`DSXLogBuffer`) | 500 | `dsx.log(…)` from markup, native modules and the page; `console.*` via the builtin (scheme `console`); JSERedact-masked |
| `dsx.errors` (`DSXError` ledger) | 128 | ambient `dsx.error`, failed `dsx.module` calls (`origin:"call"`), uncaught markup throws (`origin:"uncaught"`), uncaught page JS via runtime.js |
| KernelLog tail (`KernelLogBuffer`) | 600 | boot lines, `[dsx.log]` mirrors, parse summaries — armed on test channels |
| StackDiagnostics | — | parse-failure ledger with line:column + excerpt (iOS today) |

This is what `Xcode` / `logcat` shows for a Despia app (the `[dsx.log]` mirror line), minus OS
noise, plus structure. The Console drawer already merges these into one newest-first feed via
the module-computed `dsx.module.self.tail` rows. **The capture plane needs nothing new.** What
is missing is (a) a live remote leg for the feed and (b) provenance for the exported bundle.

### 1c · Why `Core/Telemetry` is not the answer (and must not become it)

F10 landed the PRODUCTION sink: consented, batched, sampled, fingerprint-deduped, draining the
error ledger to the developer's Sentry/PostHog/HTTP endpoint. Its posture is exactly wrong for
interactive debugging — sampling and dedupe are features for a fleet and defects for a tail,
and its consent gate is app-user-facing. Stretching it would damage both. Live logs is the DEV
half: unsampled, session-scoped, channel-gated to test installs, person-initiated. The two
share the pure cores (scrub, queue discipline) and nothing else. This split is the same one the
platform plan already draws (`master-plan.md` P7: crash analytics via a beacon route "deployed
on THEIR hosting"; `execution-plan.md` A6b: the dashboard log tail).

---

## 2 · What exists (the load-bearing walls — extend, never duplicate)

| Seam | Where | Status |
|---|---|---|
| The three rings + read APIs (`dsx.logs`, `dsx.errors`, kernel tail) | `Engine/iOS/Logs.swift` · `Engine/Android/…/Logs.kt` · `Web packages/kernel/src/logs.ts` + error-system P1/P1.5, corpus `Conformance/{logs,errors}/` | keep — the ONLY sources; never a bespoke channel (CLAUDE.md diagnostics law) |
| The merged feed | `Core/DevSettings/Components/Console.dsx` polling `dsx.module.self.tail` (change-stamped rows, newest first) | keep — the stream reads the same computation |
| Channel detection, fail-closed | `dsx.env.channel` (`simulator`/`debug`/`testflight`/`adhoc`/`appstore`), staging-and-testing.md §1/§6 | keep — the entire gating story |
| The dev center (shake → drawer, native confirm idiom, orange badge, `dev://` deep links, QR) | `Core/DevSettings/` | keep — the consent + pairing surface |
| Scrub + queue pure cores | kernel `TelemetryScrub`/`TelemetryQueue` ×3, corpus `Conformance/telemetry/{scrub,queue}.json` | keep — redaction at ENQUEUE is law here too |
| Export bundle | `StackDiagnostics.report()` (`Engine/iOS/Diagnostics.swift`) → Copy report / `dsx-diagnostics.txt` | becomes the ENVELOPE of §3.6 |
| Module HTTP | `dsx.fetch` behind `DSXFetchPolicy` (`Engine/iOS/FetchPolicy.swift`, `NetworkBackend.kt`) — HTTPS-only, cleartext only on test channels, size/timeout clamps | keep — the stream's ONLY transport primitive |
| Attestation | `Core/Integrity` — `attest`/`assert` → App Attest / Play Integrity token, server-verified; "a verdict computed on the device being judged is theatre" | keep — signs the report, verifies the session |
| Device↔editor duplex precedent | the CLI dev channel (`packages/cli/src/dev.ts` — SSE `__dsx_dev_reload`/`__dsx_dev_state`; `edit.ts` rides it) + P02-run §3d's planned local log stream (`run/logs.ts`) | keep — the LAN-local legs; this proposal is the remote leg |
| The durable cursor feed | `packages/server/src/realtime.ts` — append with monotonic `seq`, SSE out, `Last-Event-ID` resume, per-row auth, `maxDurationMs` self-close; SSE-not-WebSocket argued in its header | keep — the relay implements this exact contract |
| Workers face + deploy | `bootloader-workers.ts` (real workerd tests) · `dsx_deploy.rb` `cloudflare` target (wrangler emit, secret-on-stdin) · the preview worker precedent (`deploy/preview/`, R2+KV, operator-deployed) | keep — the relay is one more emitted worker |
| BYO Cloudflare | `master-plan.md` P0 (encrypted grant store, consent ledger) + P7 ("BYO Cloudflare: self-managed OAuth clients … deploy = the same artifact through deploy-cloudflare"); billing copy "runs on your connected hosting account; usage bills there" | keep — the provisioning + billing story, verbatim |
| Dashboard | `ClosedSource/Dashboard/` is a DSX web project; `ActivityPane.dsx` carries a placeholder build-`Logs` button; `execution-plan.md` A6 polls, A6b names the realtime "log tail" upgrade | the viewer slots here |
| The standing law | dev-preview-and-serverless-plan.md §3.5: "a capability may need *a* server; it may never need *ours*" | binding on every choice below |

---

## 3 · The design

Five pieces. One is markup, one is a module, one is a worker package, one is a dashboard
panel, one is an envelope. Nothing runs on Despia infrastructure.

```
device (test channel)                      developer's Cloudflare account            Despia dashboard
┌──────────────────────────┐               ┌───────────────────────────┐             ┌──────────────────┐
│ dsx.logs / dsx.errors /  │  NDJSON batch │  @despia-native/live worker      │   SSE       │  Live logs panel │
│ kernel tail (unchanged)  │  POST ~1–2 s  │  DO per session:          │  cursor +   │  (the Console    │
│  → dev.stream module     │──────────────▶│  seq · ring · fan-out     │──resume────▶│   feed, shared   │
│  (scrub at enqueue,      │               │  optional R2 archive, TTL │  Last-Event │   DSX component) │
│   test channels ONLY)    │◀──────────────│  ack: {viewers, until}    │             │                  │
└──────────────────────────┘   backpressure└───────────────────────────┘             └──────────────────┘
        ▲ start: dev center row │ dashboard QR / dev://stream?…          ▲ short-lived viewer token
```

### 3.1 The module: `Core/DevSettings/Modules/LiveStream` (chain `dev.stream`)

A nested child of DevSettings, because DevSettings' production story IS the feature's safety
story: on `appstore` the package registers no actions, no hooks, no seam — fail-closed
detection, double-gated, excludable (`staging-and-testing.md` §6). Live streaming is therefore
STRUCTURALLY impossible in production, not policy-impossible. Swift + Kotlin + web facets
(Article 10: the web facet makes a `dsx preview` / Despia Web session streamable into the same
panel; desktop rides the DevSettings availability with its named entry-point degradations).

What it does, and all of it is assembly of existing parts:

- **Reads** the same merged tail the Console computes (log ring + error ledger + kernel tail,
  change-stamped). No fourth ring, no new capture path.
- **Scrubs at enqueue** with the kernel `TelemetryScrub` core — the corpus rule "a crash during
  flush must not be able to leak an unredacted buffer" applies unchanged to a stream buffer.
- **Batches** NDJSON to the configured relay every 1–2 s while a session is live, through
  `dsx.fetch` (the `DSXFetchPolicy`-gated kernel primitive — the module holds no URLSession):
  bounded queue, counted drops, `TelemetryQueue` backoff discipline. **The device never holds
  a socket** — batching over plain HTTPS is cheaper, survives proxies and app backgrounding,
  and 1–2 s is realtime for a human reading a tail.
- **Sessions, not daemons.** A stream exists only between an explicit start and an explicit
  stop/timeout. Start paths, every one through the existing dev-center idioms: a **Stream**
  row in the drawer (native confirm, then the persistent badge state — the `dev://set` consent
  pattern verbatim); a `dev://stream?sid=…&relay=…` deep link / QR that the dashboard renders
  (pairing a specific device to a specific viewing session in one scan); `despia.dev.stream()`
  from the page, gated like every `despia.dev.*` call. Stop: the row, the badge, background
  beyond a grace window, relay `until` expiry, or viewer-gone.
- **Backpressure by contract:** every batch POST is acked with `{viewers, until}`. Zero
  viewers for N acks → the device stops sending and tells the tester so. The relay never pulls;
  the device never pushes blind.
- **The session envelope** opens with the App & device snapshot (`despia.dev.info()` shape:
  channel, version/build, device, locale, origin) plus the session id — the same facts every
  bug report already leads with.
- **Auth:** the start payload carries a relay-issued session token (from the QR / deep link,
  or fetched by the drawer from the relay's `/pair` route using the app's configured public
  app id). Where `Core/Integrity` ships in the build, the start call attaches
  `integrity.assert({challenge})` over the relay's challenge, so the relay can require "a
  genuine build of THIS app" before accepting bytes. Absent Integrity, the relay still binds
  the session to the pairing secret (possession of the QR).

Config (`config.json`): `relay` (origin, host-first like every module knob), `enabled`,
`require_confirm` (default true), `grace_seconds`. Presets flow through the normal per-app
config pipeline; DevSettings' `allowed_hosts` discipline applies to the relay origin on
TestFlight/ad-hoc installs.

### 3.2 The relay: `@despia-native/live` — a worker the developer owns

A free, MIT, dependency-free worker package (the `@despia-native/push` precedent: we publish it, the
developer's Cloudflare account runs it, "we are not in the path"). One Worker + one Durable
Object class + an optional R2 binding:

- **Ingest:** `POST /s/:sid/batch` — append rows to the session DO with a monotonic `seq`
  (the durable-cursor-feed contract from `realtime.ts`, reimplemented over DO storage instead
  of Postgres — same laws: monotonic seq, replay from cursor, per-row auth). The DO keeps a
  bounded in-memory ring (replay window, e.g. 2,000 rows) and acks `{viewers, until}`.
- **View:** `GET /s/:sid/feed` — SSE with `Last-Event-ID` resume, `maxDurationMs` self-close
  and client re-attach, exactly the shipped realtime contract. SSE, not WebSocket, for the
  shipped reasons (one-directional traffic, EventSource reconnect discipline, no socket auth
  handshake); the DO's WebSocket-hibernation lane remains available later without changing the
  device or panel contracts if bidirectional control ever earns its way in.
- **Pair:** `POST /pair` mints `{sid, token, qr}`; `GET /verify` answers the report-verifier
  (§3.6). An Integrity-carrying app's attestation is verified here — against Apple/Google —
  before a session accepts bytes.
- **Archive (opt-in):** on session end, the DO can fold the session into one R2 object with a
  bucket TTL lifecycle. Off by default: the default relay retains nothing beyond the replay
  ring.

This is the first Durable Object in the tree, and it is the honest fit: a session is an actor
(ordering, fan-out, lifecycle) and DO storage now exists on the free plan. A D1-backed
implementation of the same cursor-feed contract is the fallback lane if the first-DO step is
rejected — the contract, not the backing store, is what gets corpus-pinned.

**Deployment, two doors, same artifact** (§39 escape-hatch law):

1. **Dashboard one-click** through the BYO Cloudflare grant (master-plan P0 custody: encrypted
   grant, consent ledger, one-click revoke): the platform deploys `@despia-native/live` into the
   CUSTOMER'S account with the granted token, binds the DO namespace + optional R2 bucket, and
   stores only the relay origin. The billing sentence is the platform's existing one, verbatim:
   *"runs on your connected hosting account; usage bills there."*
2. **CLI:** the same artifact through the landed `dsx deploy cloudflare` shape (wrangler emit,
   secret-on-stdin) for developers who connect nothing — or any host that can serve the same
   worker contract. §3.5 of the serverless plan is satisfied the only way it accepts: the
   capability needs *a* server, never *ours*.

### 3.3 The viewer: the dashboard's Live logs panel

`ClosedSource/Dashboard/` is a DSX web project and `Console.dsx` is DSX — so the panel is the
SAME component, not a re-implementation: the Console's feed grammar (newest-first rows, the
segmented All · Logs · Problems · Kernel filter, plain-English CRASH / CALL FAILED / ERROR
tags, tap-to-copy) lifted into a shared component consumed by the drawer on-device and by the
dashboard on web. One feed, one look, per the component doctrine (a viewer draws rows; it
needs no platform capability).

The panel connects **directly from the browser to the developer's relay** over SSE with a
short-lived viewer token the platform mints through the same grant. Despia's servers are not
in the byte path — the dashboard is a client of the customer's worker, exactly the P7 pattern
("the dashboard READS … back through the same grant"). Beside the live tail: the paired-device
QR (start a session on the phone by scanning), the session list from the replay ring, and the
archived sessions when R2 is enabled.

This lands in the App view beside the build-log work `execution-plan.md` already sequences
(A6 polls builds; A6b upgrades to a realtime tail) — device logs and build logs become two
tabs of one observability surface, which is the Observe leg of the product cycle
(`product-vision.md` §1) growing its first real signal.

### 3.4 Environment + consent policy (channel discipline, unchanged philosophy)

| Channel | dev.stream registered | Can stream | Consent surface |
|---|---|---|---|
| `simulator` / `debug` | yes | yes | confirm once per pairing (skippable via config for own-machine loops) |
| `testflight` / `adhoc` | yes | yes | **native confirm + persistent badge, always** — a tester is a person, not a fixture |
| `appstore` | **no — nothing registers** | structurally impossible | — |

Testers are people, so even on test channels the posture is explicit: a session never starts
silently (confirm), never runs invisibly (the badge idiom, plus the drawer row showing the
live session and its viewer count from the acks), and never outlives the pairing (`until`).
Production users are simply out of scope by construction — which is the entire GDPR §3.5
answer, not a mitigation of it.

**A named prerequisite: the Android channel gap.** iOS detection covers all five channels
(sandbox receipt → `testflight`, embedded profile → `adhoc`). Android's detector seam
(`AppManifest.kt` — filled at boot by the host) currently resolves only
`FLAG_DEBUGGABLE → debug`, else `appstore`; Play-testing-track detection is recorded
UNRESOLVED in that file's header, and Play offers no trustworthy runtime API for "this install
came from the internal-testing track". So on day one Android streaming works on debug APKs
(Yacine's "apk in debug mode") and is structurally OFF on Play beta installs — fail-closed
doing its job. The degradation is NAMED (Article 10): a beta host build fills the detector
seam with `adhoc` via a build-variant config (the seam exists precisely for the host to fill),
which is the same trust level Play itself offers; runtime track detection stays an open row,
not an assumption.

### 3.5 GDPR posture (why this is the compliant shape, not just the cheap one)

- **Roles:** the app developer is the controller of their testers' diagnostic data; Cloudflare
  is THEIR processor under THEIR account and DPA; Despia processes control-plane metadata only
  (the grant, the relay origin, session existence) and never the log bytes. There is no
  Despia-run ingestion to paper with DPAs, no cross-customer datastore, no data-residency
  question that is ours to answer — residency and jurisdiction ride the customer's own
  Cloudflare account settings.
- **Minimization:** scrub at enqueue (corpus-pinned rules — emails, bearer-shaped tokens, card
  numbers with the Luhn gate, phone shapes); the session envelope carries device FACTS, not
  identifiers beyond what the developer's own app already logs; the default relay retains only
  the replay ring; archives are opt-in with TTL.
- **Transparency + revocation:** the confirm, the badge, the drawer row, stop-anytime, and the
  monotonic totals surviving a Clear — all existing idioms.
- **Contrast:** every incumbent (Sentry, Crashlytics, LogRocket) processes the data on the
  vendor's infrastructure, which is precisely the relationship the standing law refuses. We
  ship the better product BECAUSE of the constraint: the developer keeps custody, and Despia
  keeps zero liability surface.

### 3.6 Verified reports (the half that ends the support incident)

The export bundle stops being loose text and becomes a versioned envelope — `.dsxreport`, a
single JSON object: `{v, app: {bundle, build, channel}, device, capturedAt, sessionId,
rings: {logs, errors, kernel, issues}, totals, receipt}` where `receipt` is
`{sha256: <hash of the canonical bytes>, integrity?: <App Attest / Play Integrity assertion
over that hash, when Core/Integrity ships in the build>}`. Copy report and Export produce it;
the drawer keeps the human-readable rendering alongside.

The dashboard (and the support tooling behind it) gains **Verify report**: paste or drop a
blob →

1. not the envelope at all → "this is not a Despia diagnostic report" — Mark's JSON dies here,
   in one paste, with a message support can forward verbatim;
2. envelope, hash mismatch or edited bytes → "modified after export";
3. envelope + valid hash → structurally genuine: build row cross-checked against the
   platform's `build` entity, channel and version displayed;
4. \+ Integrity assertion verified with Apple/Google → cryptographically genuine: this exact
   app, unmodified, on real hardware. Unforgeable by any AI, because the private key never
   leaves the Secure Enclave / TEE and the trust anchor is Apple's/Google's, not ours.

Why attestation and not a baked-in signing key: an Ed25519 key shipped in the binary is
extractable, and a signature from an extractable key is Integrity's own definition of theatre
("a verdict computed on the device being judged"). The repo's Ed25519 canonical-bytes pattern
(Entitlement, RemoteBundleGate) stays the template for the ENVELOPE's byte discipline — a
canonical serialization, a reference implementation, a native-parity fixture — while the
trust anchor is attestation or nothing.

And the tester-side path that removes copy-paste entirely: **Send to developer** in the
drawer ships the same envelope to the paired relay as a one-shot upload (no live session
needed), where it appears in the dashboard's session list. The support macro becomes: *shake →
Copy report → paste* (or *Send to developer*), and anything that did not come from that flow
says so on sight.

### 3.7 Cost (the WebSocket question, answered with the shipped numbers)

The expensive shape is the one this design never builds: a persistent socket per device
terminating on infrastructure we operate. Instead —

- **Devices:** stateless batch POSTs, only during an explicitly started session, only on dev
  channels. A 30-minute session at a 2 s cadence ≈ 900 requests.
- **Viewers:** one SSE stream per open panel, resumable by cursor; the DO is active only
  while a session is hot.
- **Cloudflare's free plan** (the customer's): 100k DO requests/day and 313k GB-s/day of
  duration — roughly a hundred half-hour sessions and several hundred pinned viewer-hours a
  day before a cent is billed. Teams that outgrow it are on the customer's $5/mo Workers Paid
  plan, billed by Cloudflare to them ("usage bills there"). Despia's marginal infrastructure
  cost is zero, per the §3.5 ledger discipline.

### 3.8 Conformance + twins (what "done" means)

The unified-codebase law applies — fixtures first, three runners:

- **`Conformance/livelogs/`**: `session.json` (start/stop lifecycle, the confirm gate, the
  channel table — `appstore` registers nothing), `batch.json` (the NDJSON row shape, the seq
  contract, bounded queue with counted drops, backoff, the `{viewers, until}` ack fold,
  stop-on-zero-viewers), `report.json` (the envelope's canonical bytes, the hash, the
  Integrity attachment point, the verifier's four verdicts). Scrub is NOT re-pinned — the
  stream states that it applies `Conformance/telemetry/scrub.json` at enqueue, and its runner
  asserts the application, not the rules.
- **The relay reads the same fixtures** for the wire rows (`batch.json`, `report.json`) under
  the workers test face (`npm run test:workers`), so the module and the worker cannot drift.
- **The shared Console component** rides the existing UI-qualification ledger like every
  library component.

### 3.9 Non-goals (as important as the goals)

- **No production streaming, ever.** Production observability is `Core/Telemetry`'s lane
  (consented, sampled, batched). If a future need appears it is a Telemetry sink discussion,
  not a widening of this.
- **No OS-log slurping.** OSLogStore / full logcat capture is noise with a privacy blast
  radius; the rings + Telemetry's crash records are the signal. Revisit only with a named
  defect the rings cannot answer.
- **No Despia-hosted relay — not now, not as a "convenience default"** (F10's refusal,
  verbatim, for the same reasons, GDPR included).
- **No session replay, no screenshots on crash** (F10's refusal stands here too).
- **No second error system, no fourth ring.** The module consumes `dsx.logs` / `dsx.errors` /
  the kernel tail read-only; if the feed needs a change, that is a proposal against
  `error-system.md`.
- **No device-side WebSockets.** Batching meets the latency budget at a fraction of the
  machinery; the DO hibernation lane stays available if bidirectional control ever earns a
  case.

---

## 4 · Phasing

- **P1 — the envelope + the module (device half).** `.dsxreport` under Copy report / Export /
  Send-to-developer (the serializer is `StackDiagnostics.report()` growing a canonical JSON
  body beside its human rendering); `dev.stream` with batching against ANY configured relay
  origin — which includes `dsx dev` growing a `/logs` ingest + terminal tail beside its
  existing SSE reload channel (and P02-run's planned `run/logs.ts` cable-local stream stays
  the sibling leg), so LOCAL live logs work on day one with zero Cloudflare and the module is
  exercised end-to-end before any provisioning exists. Corpus `livelogs/` on three runners.
  **This slice alone retires most of the support incident:** the macro ("shake → Copy report →
  paste") plus verdicts 1–3 of the verifier need nothing but the envelope.
- **P2 — the relay + the panel.** `@despia-native/live` (worker + DO + fixtures under the workers
  face), the `dsx deploy` door, the BYO-Cloudflare one-click door behind the P0 grant store,
  the dashboard panel as the shared Console component, the pairing QR. Sequenced with A6b so
  build logs and device logs land as one surface.
- **P3 — cryptographic provenance.** `Core/Integrity` attestation on session start and in the
  report receipt; the platform's verify path (Apple/Google round trip); verdict 4; the
  support-tooling verify affordance and macros.

Each phase is independently shippable and independently valuable; nothing in P1 waits on a
Cloudflare grant existing.

## 5 · Decisions taken (and the roads not taken)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Parent of the module | `Core/DevSettings/Modules/LiveStream` (`dev.stream`), not a Telemetry sink | the production-inertness story is DevSettings' registration law — streaming inherits "structurally impossible on appstore" instead of re-proving it; Telemetry stays the production lane (§1c) |
| D2 | Device transport | batched HTTPS POST, never a socket | latency budget met at 1–2 s; no reconnect machinery; no per-device duration billing; proxies and backgrounding behave |
| D3 | Viewer transport | SSE cursor feed (the `realtime.ts` contract) | the house doctrine and its shipped reasons; resume-by-cursor is the reliability story |
| D4 | Where the relay runs | the developer's Cloudflare account (grant or CLI), any workers-contract host as the hatch | §3.5 standing law; product-vision §19; GDPR roles fall out for free |
| D5 | Relay state | one DO class per session; D1-backed cursor feed as the fallback lane | a session is an actor; first DO in the tree named openly; the CONTRACT is what is pinned |
| D6 | Provenance | envelope + hash in P1, Integrity attestation in P3 | verdicts 1–3 kill the incident class cheaply; unforgeability is additive, not blocking |
| D7 | Production capture | out of scope, forever, here | §3.9; Telemetry owns it |

---

## 6 · Build log (agent, 2026-08-27 — the same day, on owner direction)

What landed, with the commands that judge it, and the four places the first draft of this
document was wrong.

### 6.1 · What landed

| Piece | Where | Judged by |
|---|---|---|
| The corpus | `OpenSource/Conformance/livelogs/{wire,report}.json` + README — expectations computed by an INDEPENDENT python oracle (json.dumps sort_keys/compact + hashlib), not by any implementation; the motivating incident's AI-fabricated paste is a pinned `not_report` verdict case | three runners below; `generate_conformance_index.rb` → 73 corpora, 0 run by nobody |
| The pure core, three languages | `packages/kernel/src/livelogs.ts` · `:core LiveLogs.kt` · `Engine/iOS/LiveLogs.swift` — row folds (scrub AT the fold), batch body, ack fold, LiveQueue, LiveRing, canonical bytes, self-contained sync sha256, seal, verdicts, prose extraction (TS) | TS 11/11 (`livelogs-conformance.test.ts`, in the conformance keystone) · Kotlin in `:core` (full suite 2973/0) · Swift 57/57 COMPILED AND RUN on a swift.org 6.2.3 Linux toolchain via `swift_conformance_run_test.rb` |
| `dev.stream` | `Core/DevSettings/Modules/LiveStream/` — manifest (4 actions, errors zoo, static tests), `swift/DevStream.swift`, `kotlin/DevStream.kt`, `kotlin/desktop/DevStreamDesktop.kt` (a REAL Compose-Desktop implementation, so the parity `missing` pins never move), `web/index.js` (a `dsx preview` session streams too); drawer wiring: Panel row, `Components/Stream.dsx`, the `dev://stream` deep link + QR scan through the parent (child owns the ONE consent confirm), the badge's second reason (LIVE) | `lint_dsx --strict` 0/0 · `check_module_rules` 0/0 · `verify_module_tests` · the registries below |
| `@despia-native/live` | `OpenSource/Web/packages/live/` — worker + `LiveSession` Durable Object (the first DO in the tree): idempotent batch ingest, SSE cursor feed with `Last-Event-ID` + self-close, viewer-count acks with sliding ttl + hard max age, report uploads judged by the kernel verifier, attestation storage, opt-in R2 archive fold; `/pair` admin-gated with probing parity; write-through restart discipline | 17/17 unit + 15/15 end-to-end under REAL workerd (miniflare), incl. a two-instance restart-persistence proof · `wrangler deploy --dry-run` green |
| CLI legs | `despia report verify` (exit codes ARE the verdicts: 0 genuine · 2 modified · 3 not-report · 1 usage) + the dev server's `/__dsx_dev_logs` door (terminal tail + the relay's poll shape — local live logs with no Cloudflare anywhere) | `packages/cli/test/livelogs-cli.test.ts` 6/6 · `lint_dsx_cli_test.rb` |
| Dashboard | `ClosedSource/StudioApps/LiveLogs/Components/LiveLogs.dsx` under Observe in the ActivityPane — the Console feed grammar over the relay's rows door (R1 poll posture, A6; SSE is the A6b upgrade on the same rows), plus the Verify-report paste box against `/verify` | `despia build` 26 components · `despia lint --strict` 0/0 |
| The Android channel fill | `despia.channel` manifest meta-data (per-build-variant), accepted ONLY for `testflight`/`adhoc`, in `DespiaApp.kt` + `WearApp.kt`; the `AppManifest.kt` open item records the fill; guide §1 documents it | code + the android-app lane |

### 6.2 · Where the first draft was wrong, and what was done instead

1. **"NDJSON batches" became one JSON body.** A batch is ≤ 200 rows; NDJSON's streaming-parse
   virtue buys nothing at that size and costs a second wire grammar. `{v, sid, n, rows}` — and
   `n`, the device's monotonic batch index, became the relay's IDEMPOTENCY key, which the draft
   never named and which is what makes retry safe.
2. **Zero viewers PAUSES; only the deadline STOPS.** The draft's "stop after N zero-viewer acks"
   was self-defeating: a stopped device sends nothing, so it could never learn a viewer came
   back. The fold pauses the wire at 30 idle acks while the rings keep recording; a heartbeat
   batch (every 15th tick) keeps acks flowing, so a returning viewer resumes the wire and the
   ttl stays fresh. Corpus-pinned (`wire.json` `ack`).
3. **`session.json` was cut from the corpus** — the F10 lesson, §10.2 item 4, applied in advance:
   session lifecycle is module behavior with no pure fold to pin, so it lives in the manifest's
   declared tests and the module code, and the corpus pins only what both ends of the wire must
   agree on. Two fixtures, not three.
4. **The ack's `until` became `ttlMs`.** An absolute deadline compares relay clock to device
   clock; a relative ttl doesn't. Clock skew was the draft's unexamined assumption.
5. **The folder is `LiveStream`, the chain is still `dev.stream`.** `Core/Stream` (the GetStream
   module) already owns the generated `StreamConfig` struct name, and prepare_config refuses two
   package folders sharing a base name. The chain derives from the manifest's local segment, not
   the folder, so the rename cost nothing an author sees.

### 6.3 · The named remainder (platform, not framework)

One-click relay provisioning through the BYO-Cloudflare grant and the Apple/Google attestation
verify round-trip are the PLATFORM's half (master-plan P0 custody + P7's "reads back through the
same grant"): the relay already stores and surfaces the attestation envelope, the dashboard panel
already takes a pasted pairing, and `dsx deploy`-shaped wrangler deployment works today — so the
platform work changes custody UX, not this contract.
