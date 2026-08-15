# The Despia AI corpus

Platform-neutral fixtures for the Despia AI stack
(`OpenSource/Documentation/architecture/proposals/local-ai-engine.md`, PROPOSED v2 — the
program; `local-ai-execution.md` — the workstreams). Every runtime runs the SAME cases
through its own binding over the SAME MockEngine behaviour: deterministic, no timers, no
network, no model file ever downloaded.

The authority model is the **inverse of `jse/`**. These fixtures are hand-authored from the
program doc, and every lane runs them in **verify mode** — nothing here is recorded from an
implementation. There is exactly ONE MockEngine, the C++ mock behind the C ABI
(`OpenSource/AI/mock/`), loaded by the Swift and Kotlin bindings; the TS mock
(`OpenSource/AI/bindings/ts/`) is an explicitly subordinate port gated by these same files.

| Runtime | Runner | Lane |
|---|---|---|
| TS binding + TS mock | `OpenSource/AI/conformance/run.ts` (`npm test` in `OpenSource/AI`) | per-PR |
| Kotlin binding + C++ mock over JNI | `OpenSource/AI/bindings/kotlin-jvm` JUnit (`gradle test`) | per-PR — **live, whole corpus**: 96/96 drivable cases. The 3 that need a step to land mid-stream are skipped BY NAME with the reason (the native worker is asynchronous, the runner synchronous) and covered by dedicated native tests instead |
| Swift binding + C++ mock | `conformance-ai` mac lane | per-PR once the lane exists; green at least once before W-SWAP |

## Layout — decided on day one, and why

`stream · tools · loop · absence · provider · remote · mcp · capabilities · modality` are the
nine folders named by the program's execution companion (mental-model law 4). The split is
not cosmetic: each package mirror vendors exactly its slice
(`despia-mcp` grafts only `ai/mcp`), so a folder rename is a mirror break.

`open-catalog` is the tenth, and it is a folder rather than a file inside `capabilities/`
because it is a different QUESTION. `capabilities/` asks what this build on this device can
serve out of a catalog somebody curated; `open-catalog/` asks what happens when the catalog
stops being closed — a model resolved from a registry reference at runtime, where the answer
is a network document from a host and every field in it is a claim. The delivery locks are
the same and are not restated here; what is pinned here is everything upstream of them:
where the app is willing to ask, what a response may and may not decide, which of the
registry and the file wins on a field both describe, and what an added entry is allowed to
become. The download-refusal and recommendation cases live here too, because "this model
will not work on this device" is the same fit function seen from the supply side and it is
what an open catalog makes urgent: a curated catalog was vetted for the fleet, an open one
is whatever a developer typed.

Two case classes land inside that layout rather than beside it, and the placement is
recorded here so nobody "fixes" it into new folders:

- **Fit** (`capabilities/fit.json`) — a fit verdict is the device-and-build side of the same
  adaptation question `capabilities/` already owns: what can THIS build on THIS device serve.
- **Routing** (`remote/routing.json`) — `router.json` carries the `remote` policy block
  inline (Appendix A4), so the local preference order and the remote leg are one policy and
  one file's worth of fixtures.
- **Delivery** (`capabilities/delivery.json`) — the four locks answer the same question
  `capabilities/` owns from the supply side: what this build, on this device, is willing to
  accept as a model at all.

## The reference host

Cases drive the **module surface** — `scheme: "intelligence"`, the action names of the DSX
contract — because that is the surface every consumer sees. No runner needs a DSX module to
run them: each binding ships **runner glue** (`OpenSource/AI/conformance/`) implementing the
*reference host*, a thin, spec-defined mapping from an action call to an engine request plus
the normalization of engine events into bus events. The host is deliberately small; when
`Core/LocalAI` swaps onto this engine (W-SWAP) it implements the same mapping, and these
fixtures are what say it matched.

The host owns exactly four things, all of them stated below so the three implementations
cannot drift: the action-to-request mapping, the stream event normalization, the fit
function, and the routing function.

## Case shape

```jsonc
{
  "name": "…",
  "engine":  { "present": true, "abi": 1, "capabilities": { … } },  // what this build reports
  "device":  { … },                                  // the probe's answer (fit + target cases)
  "catalog": { "fit_policy": { … }, "entries": [ … ], "installed": ["m1"], "loaded": "m1" },
  "router":  { … },                                  // router.json (A4)
  "tools":   [ … ],                                  // registered tool sources
  "providers": [ … ],                                // facets.provider rows (provider cases)
  "excludedOverlay": { "<chain>": { "reason": …, "from": … } },   // the build's exclusions
  "mcpServers": [ … ],  "servedRows": [ … ],         // MCP client / local-server cases
  "mock":    { "models": { "m1": { "script": [ … ] } } },
  "remoteMock": { … },                               // the app's own endpoint, scripted
  "steps":   [ … ],
  "expect":  { … }
}
```

Every top-level block except `name`, `steps` and `expect` is optional; a case that omits one
gets the neutral default (an engine that is present and carries `gguf` + `mock`, a device
with generous headroom, an empty catalog, no tools, no exclusions).

### `mock` — the MockEngine script (Appendix A5)

A mock model is a scripted event sequence, deterministic by construction:

```jsonc
"m1": { "script": [ { "token": "Hel" }, { "token": "lo" }, { "complete": { } } ] }
```

Script items: `token` (a text delta) · `thinking` (a reasoning delta) · `tool`
(`{id,name,arguments}`) · `block` (any typed output block from the §4.14 vocabulary — this is
how audio/image/file/json/unknown blocks are scripted) · `sync` (force a resync snapshot) ·
`pause` (suspend the stream here so the next case step lands mid-flight — this is how
`cancel` and `resync` are driven deterministically, with no timers) · `error`
(`{code,message?}` — an engine-side failure) · `complete` (terminal, optional `usage`).

Two additive forms beside `script`, called out because Appendix A5 pins only `script`:
`turns` (`{ "turns": [ [ … ], [ … ] ] }`) has successive engine requests for that model
consume successive turns — how a tool round-trip scripts the model's answer *after* the tool
result comes back; `everyTurn` repeats one turn forever, which is what a runaway-loop case
needs. A model may also script `"load": { "error": { "code": "…" } }` to refuse a load, and
the mock reports a scripted `capabilities()` payload when the case sets `engine.capabilities`.

### `steps`

| Step | Meaning |
|---|---|
| `call` | `{ scheme, action, args?, mode: "await" \| "post", as? }` — a bus call. `as` labels the request so expectations can name its stream. `post` is fire-and-forget (events only); `await` also records a result. |
| `cancel` | `{ target: "<label>" }` — `intelligence.cancel` against a labelled request. |
| `toolResult` | `{ id, result?, error? }` — an out-of-process tool (page or MCP) answering. |
| `approve` | `{ id, decision: "approve" \| "deny" }` — the operator's answer for a `prompt`-policy tool. |
| `resync` | `{ target: "<label>" }` — an on-demand full-snapshot request. |
| `tick` | `{ ms }` — advances the host's VIRTUAL clock. Deadlines and approval timeouts are fixture-driven; no runner ever sleeps. |
| `serverRequest` | `{ tool, arguments, token, as }` — a request to the LOCAL MCP server (mcp cases). `$session.token` and `$discovery.token` resolve to the live tokens. |

### `expect` (every object comparison is a SUBSET match)

| Key | Meaning |
|---|---|
| `events` | normalized stream events `{ req, event, data }` as an ordered SUBSEQUENCE — every listed event must appear in the listed relative order; unlisted events in between are allowed. `req` is the step's `as` label. |
| `eventCounts` | exact counts per event name — the companion that makes `events` tight when a case needs "and nothing else". |
| `distinctRids` | labels whose requests must carry different rids (the correlation law). |
| `results` | per-label awaited call result. |
| `errors` | typed errors in order: `{ req?, code, … }` — the shape the error ledger receives. |
| `absent` | typed-absence assertions `{ action, code, reason? }` — the "never fake a result" law. |
| `notices` / `catalogNotices` | non-fatal typed notices (an ignored unknown block, a skipped catalog row) — the must-ignore law's audible half. |
| `dispatched` | tool dispatches the host performed, in order: `{ name, arguments, source? }`. |
| `dispatchGroups` | which dispatches ran concurrently, as ordered groups — the parallel-tools law. |
| `dispatchCount` / `engineRequestCount` / `remoteRequestCount` / `downloadCount` / `mcpConnectCount` | exact counts, used where the assertion is "this many, no more" (and where zero is the whole point). |
| `resolveAttempts` / `resolveAttemptCount` | every URL contacted while RESOLVING a `models.add` source, in order, each tagged `registry` or `file`. Zero is the whole assertion for a host the app never allowed: a refusal that has already made the request has told that host the app exists. |
| `dispatchedAfterApproval` | ordering assertion: no dispatch happened before the approval decision. |
| `engineRequests` | what actually reached the ABI, in order (subset) — how routing, remote policy, schema derivation and structured output are proven without reading the engine. |
| `remoteRequests` | what reached the app's own endpoint (subset), including `hasCredential`. |
| `verdicts` | fit verdicts per model id: `{ "m1": { "verdict": "runs_well", … } }`. |
| `rows` | `models()` / `models.available()` / `models.installed()` rows (subset, in order). |
| `providers` | the derived provider registry (subset, in order). |
| `buildAbort` | a PREPARE-time abort this manifest shape must produce — asserted by the build-side runner, not at runtime. |
| `transcript` / `transcriptTransmitted` | the local agent transcript's entries, and the assertion that nothing left the device. |
| `maxEventBytes` | upper bound on any single INCREMENTAL event's serialized `data` — the bounded-growth law. `sync` and `complete` are snapshots by design and are exempt. |
| `noInlineBytes` | no base64 or byte array appears anywhere in an envelope: binary rides as a reference or not at all. |
| `noErrors` | the case produced no typed error (used where tolerance, not failure, is the point). |
| `store` | Base assertions for cases that cross into the data plane. |
| `snapshotBeforeWrite` / `snapshotBeforeFirstWrite` / `boundLoopbackOnly` / `tokenInUrl` / `discoveryFile` / `serverResponses` / `hitsCarryDistance` / `snapshotsCarrySize` | the named safety assertions of their corpora, each documented in that file's `_note`. |

## The four host contracts (normative — the three implementations must agree)

**1 · Action → request.** `completion` → `{kind:"completion"}`, `embed` → `{kind:"embed"}`,
`transcribe`/`listen` → `{kind:"transcribe"}`, `synthesize` → `{kind:"synthesize"}`. `model`
passes through; `task` (absent `model`) goes through the routing function first. `tools`,
`response_format` and `options` pass through verbatim. Every request carries
`schema_version: 1`, and unknown fields are must-ignore in both directions.

**2 · Event normalization.** Engine events become bus events with the kernel envelope
(`{id, event, final, data}`, rid-correlated): `token` carries `{seq, delta}` — the DELTA
only, never the cumulative text; `sync` carries `{seq, snapshot}`; `tool` carries
`{id, name, arguments, status}`; `routing` carries `{task, model, reason}`; `complete` is
terminal (`final: true`) with `{snapshot, usage}`. `seq` is per-request and monotonic from 0.

**3 · Fit.** Ordered, first match wins, computed against the case's `device`, the entry's
`requirements`, the reported `engine.capabilities`, and `catalog.fit_policy`:

1. entry `requires.abi` > engine abi, or `requires.engine_caps` ⊄ capabilities, or the
   entry's `engine`/`format` is not in capabilities → `unsupported`.
2. the model is marked in `device.quarantined` (the crash marker survived a launch) →
   `quarantined`.
3. `requirements.disk_mb` > `device.free_disk_mb` → `too_big`, reason `disk`.
4. the footprint > the memory limit → `too_big`, reason `memory`. The limit is
   `device.increased_memory_limit_mb` when `device.increased_memory_limit` is true, else
   `device.available_memory_mb`. **`mapped_mb` never counts against this limit** — mmap'd
   weights are clean file-backed pages; it rides the verdict as detail so a UI can explain
   thrash.
5. tps (measured `device.calibrated[<model>].decode_tps` when present, else the entry's
   `perf_priors[device.class].decode_tps`) < `fit_policy.slow_decode_tps` → `runs_slow`.
6. otherwise `runs_well`.

**The footprint step 4 uses is MEASURED when this device has measured it.**
`requirements.footprint_mb` is the only estimated number an entry carries (`disk_mb` is the
file size, `mapped_mb` is what the loader maps), it is derived from a formula that runs
+45%/+25%/+92% high and 39% **low** against the shipped catalog's measured rows, and low is
the direction an OOM kill lives in. So the resident cost of the first successful load is
recorded in `device.calibrated[<model>].footprint_mb` — the SAME per-model, per-device store
`decode_tps` already uses, not a second one — and replaces the estimate on every later launch.
A stored measurement is believed only when it is a finite number greater than zero and at most
the **measurement ceiling**: `device.total_memory_mb` when the probe reports physical memory,
otherwise the per-process limit (a process resident above its own limit does not survive to
report anything). Anything else is DISCARDED, the estimate stands, and the verdict says so.

Every verdict carries `{verdict, reason?, decode_tps, measured: bool, mapped_mb, footprint_mb}`,
plus `footprint_measured: true` when the footprint came from a load on this device and
`footprint_rejected: true` when a stored measurement was discarded.

**4 · Routing.** Task hint → model: the task's `prefer` order (unknown task → the chain named
by `router.default`) ∩ installed, keeping only entries that satisfy the task's `require_caps`
and whose verdict is at least `min_verdict` (`runs_well` > `runs_slow`; anything else never
routes). A required capability must hold on **both sides**: the build reports it in
`capabilities.features` AND the entry declares it in `requires.engine_caps`. A model that
never claimed constrained decoding is not a candidate for a task that needs it, however good
it is at chatting. With `stickiness.prefer_loaded` the currently loaded model wins when it is a
candidate (reason `sticky-loaded`), else the first candidate wins (reason
`preference-order`). With no candidate the `remote.policy` decides: `local` → typed absence
`no_model_available`; `prefer-local` → the remote leg (reason `no-local-candidate`);
`remote-only` skips local resolution entirely (reason `policy-remote-only`). Every resolution
emits one `routing` event before the first `token`.

**5 · The open catalog.** `models.add({source, prefer?, revision?, id?})` runs a fixed
sequence, and the ORDER is the contract because most of it is about what has not happened
yet: parse the reference (segments are plain names; no `..`, no query, no scheme) → look the
registry word up in `catalog.sources`, which the APP declares as URL templates (undeclared →
`source_unsupported`, fail closed) → expand the api template and ORIGIN-CHECK it (refused →
nothing contacted) → resolve → pick the file (named, or by `prefer`: shortest matching name
then lexicographic, shards refused) → synthesise → ORIGIN-CHECK the resolved file URL
(refused → the file is never read; a response can never widen `allowed_model_hosts`) → read
the GGUF header off that URL → synthesise again with it → refuse an id that a SHIPPED entry
already owns → install into the added overlay and compute fit. The revision must match
`^[0-9a-f]{40}$`; a digest must match `^[0-9a-f]{64}$` or it is DROPPED (pin-on-first-download
takes over); an absent licence becomes `license.id: "unknown"` plus a notice, never an
invention. The entry is `origin.added: true` forever, its rows carry `added: true`, and every
verdict computed from its derived requirements carries `predicted: true` — until this device
MEASURES the footprint, at which point the same verdict carries `predicted: false`. The key is
stated in both directions on an added entry and absent on a shipped one, because every fixture
here is a subset match and a missing key asserts nothing.
`models.added` lists the overlay; `catalog.added` restores it at construction, where a
shipped id always wins and the collision is a `catalog_notice`.

**`category` is DERIVED from the header, never assumed.** Two signals, in order:
`<arch>.pooling_type` above zero → `embedding` (a model that pools its hidden states into one
vector is an embedding model, and it is the only thing separating the two kinds of `qwen3`);
otherwise an architecture table that is exactly what the shipped catalog's eleven rows
evidence — `gemma3` → `text`, `qwen3` → `text`, `whisper` → `asr` — and **anything else is
`category: "unknown"`**, which is a recorded value rather than a guess. `inputs`/`outputs`
follow the category from the same rows (`embedding` → `outputs: ["embedding"]`, `asr` →
`inputs: ["audio"]`). `origin.provenance.category` says which signal answered: `pooling`,
`architecture` or `unknown`.

**6 · Refusing before the bytes move, and what to offer instead.** `download` answers, in
order: unknown → retired → `insufficient_storage` (LIVE free space) → the fit verdict
(`too_big`/`unsupported`/`quarantined` → `model_too_big`/`unsupported`/`model_quarantined`,
carrying `{verdict, reason, fallback}`) → the four locks. The fallback is one ranking, shared
with `models.best`: same `category`, `runs_well` before `runs_slow` (nothing else is a degree
of "works"), then the LARGEST that fits, ties keeping catalog order; when nothing qualifies
it is `{none: true, reason: "no_model_of_this_kind_runs_here"}` — stated, never omitted.
**It never substitutes across an `unknown` category, in either direction**: a model whose kind
this build could not derive gets `{none: true, reason: "category_unknown"}` instead of a
suggestion, and a model of unknown kind is never offered as a replacement for anything else.
The offer means "another model of the same kind", so it is sound only when the kind is known
on both sides — answering a refused speech model with a chat model is worse than answering
with nothing.
`models.best({task?, category?})` is `route` over the whole downloadable catalog with
stickiness off when the router declares the task, and that same ranking otherwise; it returns
`{model, verdict, reason, installed, download_mb}`.

## Working rules

- Fixtures land in the same commit as, or an earlier commit than, the implementation.
  A contract surface with no case here is a review reject.
- Every cross-runtime divergence becomes a case in the same commit as its fix.
- Real-model inference is never in this corpus — it lives in the nightly smoke lane (W-SWAP).
- Cases are byte-stable: no clocks, no randomness, no ordering that depends on scheduling.
