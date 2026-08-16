# Watch runtime — autonomous packages + cross-node calls

> Status: **ADOPTED v2** (2026-07-17) — the node model, the offline contract
> (§The offline contract) and the execution plan (§Execution plan) are the agreed
> direction; each workstream still lands as its own reviewed, Codemagic-verified PR.
> Builds on the shipped Watch surface (`Core/Extensions/Watch`, `StackWatch`) and the
> `runtime` tiers. The mechanism is general — every separate target (watch, keyboard,
> widget) is a **node** — but the watch is the driving case, so it's written watch-first.
> Designed for **1:1 Wear OS parity** (see *Cross-platform*); the Android runtime mirrors
> it in its own repo, no iOS change needed.
>
> Node taxonomy (sharpened): a **live node** (watch app, keyboard, app clip) is a real
> process that can host a runtime and grows through the phases below; a **snapshot node**
> (widget, Live Activity) is OS-rendered archived state — **state replication in, forever;
> never calls, never a runtime**. An `<api>` block can never "run in" a widget: it runs at
> the root and its state replicates out. Every mechanism in this doc targets live nodes.
>
> **Snapshot nodes still get two DECLARED forms of dynamism** — neither runs code in the
> node, so the taxonomy holds:
>
> 1. **LIVE TOKENS (landed)** — content the OS ITSELF renders and advances. First token:
>    `<countdown until="epoch|ISO-8601">` — SwiftUI `Text(timerInterval:)` ticks it on the
>    Lock Screen / Dynamic Island with zero process executions; the Compose/Glance twin
>    renders remaining time per refresh (no ticking text in Glance — pinned deviation; the
>    RemoteViews Chronometer upgrade is tracked). Same markup, styled like text.
> 2. **COMPILED INTERACTIONS (designed; per-role rails LANDED)** — a snapshot button whose
>    `on:tap` is ONE statically-compiled literal `dsx.module.<s>.<a>({…})` call. No JSE in
>    the node: the build compiles the call into the platform's interaction primitive
>    (iOS 17 AppIntent · Glance action callback) which posts the invocation onto the APP's
>    bus (App-Group queue + wake; instant when the app is alive), gated by the SAME
>    per-role capability table as every node: the Widgets package declares
>    `node.role: "widget"`, ActivityKit `node.role: "activity"`, and a module opts its
>    actions in with `"reach": ["widget"]` / `["activity"]` — the generic generator serves
>    both with ZERO script changes (the tables ship in each extension bundle today). This
>    is how "a Live Activity button toggles the mic" stays a DECLARATION — the module owns
>    the capability, the table gates it, nothing is hardcoded per feature. Deep links
>    remain the zero-config default for plain navigation taps.
>
> **Web position (the unified-codebase law, stated):** the snapshot dialect targets
> OS-OWNED surfaces (home-screen widgets, Live Activities, watch complications) — a
> surface family the web renderer does not have, so there is no TS implementation and
> none is owed while that holds (the same standing as the pre-existing snapshot table).
> The cross-twin behavior is pinned by the Kotlin-side conformance suite
> (`StackLiveTest.kt`, hand-pinned to StackLive.swift); promoting it into a shared
> platform-neutral corpus under `OpenSource/Conformance/` is tracked with the
> watch-simulator corpus lane. If a web surface ever grows a snapshot analogue (e.g.
> installed-PWA widgets), the dialect lands there fixtures-first like any authoring
> surface.

## The requirement

The watch must be able to **call any package** and get a result or subscribe to events,
**without depending on the phone being awake**:

1. **Zero phone when possible.** A package that can run on the watch runs *in the watch
   process* — no phone, works on standby, in airplane mode next to no iPhone.
2. **Background phone when necessary.** A genuinely phone-only package is serviced by the
   phone **woken in the background** (WatchConnectivity launches the suspended iOS app), and
   the resolved value / event comes back to the watch.
3. **Reuse, offline-first.** Every result and event is cached on the watch and reused
   instantly; revalidated when possible. The phone can push hot data proactively.
4. **Checkable capability.** A call to a package that can't run on this surface fails with a
   **typed, recoverable error** — and the same fact is enforced **at build time** for
   watch-bundled screens. Package-level *and* per-action granularity.

"Call any package" is bounded by physics: a phone-only SDK can't execute on the watch, and a
phone that is fully **off** can't be woken. The design makes both cases **graceful and
explicit**, never a crash.

## Model: nodes + one bus that spans them

A **node** is a process/target with its own registry and (where compiled) its own JSE
runtime: the phone `Runtime`, `DespiaWatch`, a keyboard, a widget. `dsx.module` is **one
bus** that resolves **in-node first, across-node only when it must**.

```
 author writes ONE line, portable across nodes:
   const r = await dsx.module.<scheme>.<action>(args)

 resolve on the WATCH:
   1. in the watch registry?            ──▶ run IN-PROCESS            ✅ zero phone, standby-proof
   2. phone-relayable & reachable?      ──▶ live RPC (wakes phone in BG), awaited reply
   3. phone-relayable & unreachable?    ──▶ settle { ok:false, error:'unreachable' } NOW — author retries via dsx.link (§The offline contract; the declared opt-in queue is a deferred, additive layer)
   4. not supported on this surface     ──▶ throw .unsupportedOnSurface  (→ dsx.fail, clean)
```

The phone's resolve is just step 1 (it has every phone package). The watch's power is that
**most useful work lands in step 1**, because computation and many capabilities are
watch-native.

### What lands in step 1 (zero phone)

| In-process on the watch | Why |
|---|---|
| All **JS-core compute** — `fetch`, JSON, Date, Intl, Promise, WebSocket, RegExp, `crypto.subtle` | Foundation / URLSession / CryptoKit are on watchOS; calling *your backend* needs no phone |
| **Watch-native modules** — HealthKit, CoreLocation, storage/Keychain, haptics, local notifications | declared `platforms: ["watch"]`, compiled into the watch target |

Steps 2–4 are only for the **minority** of packages that are genuinely phone-exclusive.

## Capability declaration (the check)

A package declares its reach in `dsx.json`. Package-level default, with per-action overrides
(the "this action only" granularity):

```jsonc
{
  "scheme": "orders",
  "platforms": ["phone", "watch"],     // package default reach (omitted ⇒ ["phone"])
  "reach": ["watch"],                        // phone-only actions MAY be invoked from another node
  "actions": {
    "charge":  { "platforms": ["phone"], "reach": ["watch"] },   // phone-only, but relayable from watch
    "scan_nfc":{ "platforms": ["phone"], "reach": false }   // phone hardware; NOT relayable
  }
}
```

- `platforms` drives **where the build places the package** (`["watch"]` ⇒ sources + watchOS
  pods compiled into `DespiaWatch`; validated extension-safe by the Rule-8 family).
- `platforms` values are **node ROLES** (`phone` = the handset, `watch` = the wearable
  companion), never OS names — each platform binds a role to its concrete target (`watch` →
  Apple Watch on iOS, **Wear OS on Android**). One manifest, both platforms (see *Cross-platform*).
- `reach` says whether a phone-only action is meaningful to run *for* the watch in the phone's
  background (a server call: yes; reading the phone's NFC: no).
- The build bakes this into a **capability table** the resolver and the linter both read — one
  source of truth, no drift (same discipline as `runtime`).

### Two layers of checking

- **Build / lint (author-time).** A `.dsx` screen bundled into the watch is linted so every
  `dsx.module.<scheme>.<action>` it calls is **watch-capable OR (phone + relay)**. A
  phone-only-non-relay call in a watch screen is a **build error** —
  *"`stripe.scan_nfc` is phone-only and not relayable; this watch screen can't call it."*
  This is the static answer to "does this package/action work on the watch?"
- **Runtime.** The 4-way resolve above; `ModuleCallError.unsupportedOnSurface` /
  `.unreachable` surface as the uniform `dsx.fail` contract
  (`catch (e) { e.code === 'unsupported_on_surface' }`). And **`has()` is surface-aware**:
  `has('stripe')` on the watch is true iff it's callable from here (in-process or relayable),
  so the author can branch and degrade.

## Cross-node transport (background-capable, by design)

All of this rides **WatchConnectivity**, chosen per call by reachability — and crucially, WC
is built to **wake the suspended iOS app in the background** to service the watch:

| Need | API | Background behavior |
|---|---|---|
| Live awaitable RPC | `sendMessage(_:replyHandler:)` | system **launches/wakes the suspended iOS app in the background** to run the action and reply |
| Reachable-unknown / durable | `transferUserInfo(_:)` | FIFO queue, **guaranteed background delivery**; result returns the same way |
| Latest-state | `updateApplicationContext(_:)` | coalesced, background |
| Complication-critical | `transferCurrentComplicationUserInfo(_:)` | high-priority, budgeted wake |

Every request carries a **correlation id**, so replies and forwarded events route back to the
exact awaiter / handler. The watch's `dsx.module` proxy turns a `sendMessage` reply into the
awaited `JSON`; an unreachable peer settles the call immediately per §The offline contract —
the durable channels below still carry state replication and coalesced events.

### "Handle in the background of the phone"

When WC delivery wakes the iOS app, its `WatchBridge` runs the requested
`dsx.module.<scheme>.<action>()` **in the phone's existing registry** — the modules are
already there. For anything non-trivial it wraps the work in a background-task assertion
(`beginBackgroundTask`) or hands network work to a **background `URLSession`** (survives
re-suspension), then replies and writes the result to the shared store. A **silent push** can
wake the phone too: the server pings the phone, the phone computes, forwards the slice to the
watch — the watch updates with the phone never leaving the user's pocket.

### The plumbing is internal actions

The relay's own machinery — the watch→phone RPC handler, the `dsx.link` reporters, the
gateway-fetch executor — is registered as **internal actions** (`dsx.action(exposed: false)`), so
the bus and the package's own surfaces reach it but **web JS / deep links never can**. The
author-facing API (`despia.watch.render`, `dsx.module.stripe.charge`) stays public; the cross-node
transport that backs it is package-private. (See cross-module-calls.md → *Package-private actions*.)

## Events / subscriptions across nodes

```js
// on the watch
const sub = dsx.on('orders.changed', (o) => { render(o); });   // cross-node subscribe
```

The watch registers interest; the phone holds the
`dsx.delegate.listen("orders.changed")` listener and, on each event (including from a background
push wake), forwards the payload to the watch via
`transferUserInfo` (or a complication transfer if it should update the face). The watch
**caches** the latest and reacts. Streams are **coalesced** (latest-wins / batched), not a
firehose — high-frequency producers summarize before crossing the link.

## Reuse / caching (offline-first)

- Every RPC result and forwarded event is written to the **watch store** (and the watch's own
  container for complications). The watch shows last-known **instantly**, revalidates when it
  can — the same stale-while-revalidate the OTA router already uses.
- **Proactive push:** on app-background or a relevant `dsx.fire`, the phone precomputes and
  pushes "hot" data so the watch has it *before it asks* — the strongest form of "reuse data
  to watch even on standby."

## The link — `dsx.link` connectivity + phone-as-gateway

The relay needs to know *"can I reach the phone, and is it online?"* — and authors need the
same fact to show the right UI and to let a watch borrow the phone's connection. Expose it as
one **reactive** namespace, and make the watch transparently use the phone's network when its
own is down.

### `dsx.link.*` — reactive peer state

The watch's live view of its phone (symmetric on the phone):

| path | meaning |
|---|---|
| `dsx.link.reachable` | the peer is reachable **now** for a live call |
| `dsx.link.paired` | a peer exists / the companion app is installed (structural) |
| `dsx.link.online` | the reachable peer has **internet** (so relayed fetches work) |
| `dsx.link.state` | `connected` (reachable + online) · `local` (reachable, peer offline) · `offline` (no peer) |

Reactive: a change re-renders DSX and fires `link.changed`. The author reads it like any state:

```xml
<button label="Pay" visible-if="dsx.link.reachable" on:tap="pay()"/>
<text visible-if="dsx.link.state != 'connected'" color="secondary">Open iPhone to sync</text>
```
```js
dsx.on('link.changed', (s) => { if (s.online) dsx.action.sync() })
```

It's the **same signal** steps 2–3 of the resolve already use to choose relay vs. queue — now
also *readable*, so the author pre-empts a failure instead of catching it.

### Phone-as-gateway — `fetch` that just works

A non-cellular watch out of Wi-Fi range still reaches the internet **through the paired
phone**. So the watch's `fetch` (and network modules) resolve:

1. watch has its own internet → **direct**.
2. watch offline · phone reachable + online → **relay the request through the phone** (the phone
   runs `URLSession`, returns the body).
3. neither → queue (if the call allows) or settle `{ ok:false, error:'offline' }`.

One line, transparent — `dsx.link.state == 'connected'` *is* "the watch can reach the net,
directly or via the phone":

```js
const r = await fetch(dsx.app.api + '/orders')   // watch-direct OR via the phone gateway
```

### 1:1 backing

| | iOS | Wear OS |
|---|---|---|
| `dsx.link.reachable` / `paired` | `WCSession.isReachable` / `isPaired` + `sessionReachabilityDidChange` | `CapabilityClient` / `NodeClient` + listener |
| `dsx.link.online` | peer's `NWPathMonitor` state, reported over the link | peer's connectivity over `DataClient` |
| gateway `fetch` relay | WCSession RPC → phone `URLSession` | `MessageClient`/`ChannelClient` → phone OkHttp |

Same `dsx.link`, same `fetch`; only the backing differs. (Lands with Phases 3–4; add `dsx.link`
to the linter's JSE roots when implemented.)

## Author surface — one portable line

```js
await dsx.module.health.today()        // watch-native → in-process, no phone
await dsx.module.orders.recent()       // fetch-backed → in-process; or relays if phone-only
await dsx.module.stripe.charge(args)   // phone-only+relay → phone woken in BG, awaited result
if (has('printer')) { … } else { … }   // surface-aware availability → graceful degrade
```

Identical to the phone call site (DespiaScript's "write once, compile per node"). The author
never writes transport, correlation, caching, or wake logic — the proxy does.

## Why this is the right shape

- It **extends `dsx.module` (one bus) across nodes** — in-node where possible, relay where
  necessary; no node privileged (constitution: surfaces are equal consumers).
- It is the **DespiaScript portability thesis** ("same module shape, compiled per platform")
  applied to nodes, with the capability table making "where can this run" explicit and
  enforced.
- It **rewards native DSX (DSXView):** such an app's logic is portable, so it gets an
  autonomous watch app; a web-view app's logic is trapped on the phone — and the capability
  check surfaces that honestly instead of failing mysteriously on standby.

## Cross-platform — Wear OS is 1:1

DespiaScript is one API on two languages (`dsx.module`, `dsx.on`, `dsx.container` read the same
in Swift and Kotlin — only the dot vs `["x"]` step differs), so this runtime is **1:1 on Wear
OS**: the author's call sites and the `dsx.json` manifest are **identical**; only the *backing*
transport and capability APIs differ — exactly as `dsx.container` maps App Groups ↔ DataStore
(`Skills/android/containers.md`). Every mechanism has a clean Wear equivalent, most simpler:

| iOS mechanism | Wear OS equivalent |
|---|---|
| node roles `platforms:["phone","watch"]` | **identical manifest**; `watch` → the Wear module/target |
| in-process JS-core (`fetch`, crypto, JSON, Promise…) | the same JSE core on Kotlin (`Skills/android/js-core-parity.md`) — OkHttp / `java.time` / coroutines / Tink |
| watch-native modules (HealthKit, CoreLocation, Keychain, haptics) | **Health Services**, **FusedLocationProvider**, DataStore / Keystore, `Vibrator` |
| live RPC `sendMessage(replyHandler:)` | `MessageClient.sendMessage` + id-correlated reply (Horologist RPC helper) |
| queued / latest-state (`transferUserInfo` / `updateApplicationContext`) | **`DataClient`** DataItems — persisted + auto-synced (offline-first by default) |
| **background wake** of the suspended app | **`WearableListenerService`** — system-launched to deliver Data Layer events |
| complication transfer | `ComplicationDataSourceUpdateRequester` |
| `isReachable` / "can the other node do X?" | **`CapabilityClient`** — nodes *announce* their capabilities (a cleaner, first-class map) |
| phone BG work (`beginBackgroundTask`, bg `URLSession`) | `WorkManager` / foreground service / **FCM data-message** wake |
| `StackWatch` render | **Compose for Wear OS** — same AST, element table mirrored as `@Composable`s (`StackWatch.md`) |
| `ModuleCallError.unsupportedOnSurface` | the Kotlin sealed-class variant (`cross-module-calls.md`) |

Two honest differences, both hidden by the `dsx.module` proxy so the **contract stays 1:1**:

- **No built-in reply handler.** Wear's `MessageClient` is one-way, so request/response is
  correlation-by-id (Horologist ships the wrapper). Same semantics, a little more adapter code.
- **Capability discovery is *better* on Wear.** `CapabilityClient` lets each node *announce*
  which packages it has, so "is this callable across the link?" is first-class rather than
  inferred from reachability — the capability model lands more naturally than on iOS.

Net: the **author writes one line and one manifest**; iOS does the heavier lifting (WC,
entitlements), Wear is a thin Data Layer + Compose adapter. Implementation lives in the
**Android runtime repo** against `Skills/android/{js-core-parity,containers,manifest-and-build,
api-mapping}.md`; each phase below has a mirrored Wear phase there. No iOS change is needed for
parity — the design is already shaped so the Kotlin port is mechanical.

## Honest boundaries

- **Live** awaitable RPC needs the phone *reachable* (BG wake works while it's on and in
  range; fully off / out of BT+Wi-Fi range ⇒ the call **settles `unreachable` immediately**,
  never hangs — §The offline contract). Truly synchronous "call a powered-off phone" is
  impossible — honest settlement + the cache + state replication make it graceful.
- Background time is **bounded** on both sides; long jobs use background `URLSession` /
  `WKApplicationRefresh`, not the live window.
- `platforms:["watch"]` requires the package's **pods/SPM to ship a watchOS slice**; ones that
  don't stay `phone` (and relay or degrade).
- Event delivery over WC is **best-effort + coalesced**, sized for glanceable updates, not
  real-time streams.

## The offline contract (ADOPTED)

*"Fail or queue?"* is not one answer — **each bus shape carries its own offline semantic**,
derived from what the shape already means. Nothing here is new policy; it is the
constitution's shape taxonomy applied to time:

| Bus shape | Offline semantic | Why it's forced |
|---|---|---|
| **State** (context/declared vars; `watch.render`/`state` are this) | **always queued, last-write-wins** (the carrier does it natively — `updateApplicationContext` / DataItems) | state is idempotent by definition |
| **Events** (`fire`⇄`hook`, taps) | **best-effort, coalesced to latest** (the shipped single-slot `pendingTap`, generalized) | an event is an announcement, not a command — replaying a stale tap is wrong; delivering the latest is right |
| **Calls** (`dsx.module.x.y()`) | **settle immediately, always** — see below | a call has a live awaiter |

For calls, the law is **author-handled retry over kernel queueing**:

1. **Default: fail fast** — `{ ok:false, error:'unreachable' }`, settled NOW. Mobile
   totality (errors are values); the author pre-empts it in markup via the reactive
   `dsx.link.state` instead of catching it after.
2. **Reads: serve the cache** — `{ ok:true, data, stale:true }`; stale-while-revalidate is
   the kernel's existing philosophy (content plane, OTA router). Reads never queue.
3. **Opt-in queue is DEFERRED and declared-only** — a later, additive layer
   (`"offline": "queue"` per action in the manifest, for genuinely idempotent commands);
   even then the await settles immediately with `{ ok:true, queued:true }` and the
   terminal result arrives as an event. The kernel **never silently holds an `await`
   open across a link outage**: the awaiting screen is gone hours later, and a
   silently-queued mutation ("Pay") double-fires when the user retries on the phone.
   Whether an action is safe to defer is a fact about that action's semantics that only
   its author knows — declared, never inferred (Article 4 applied to time).

`unsupported_on_surface`, `unreachable`, and (later) `queued` are **three distinguishable
outcomes** — they demand three different recoveries: redesign the screen · retry/degrade ·
show "will sync".

## Execution plan — full DSX on the watch (ADOPTED 2026-07-17)

**Where the tree actually is** (verified, ahead of the original Phase-0 text).
> **Read this list as the 2026-07-17 STARTING position, not current status.** The two ⚠️ rows
> below have since been resolved by W1/W2/W3 — the watch runs real JSE expressions AND the
> statement runner today (`WatchRuntime.swift`; Wear: `WearRuntime.kt`). Current status is the
> per-workstream verdicts further down and the CI-status table in `reference/StackWatch.md`.

- ✅ `JSE.swift` (1,221 lines — the full expression evaluator) is **already extracted**
  UIKit/WebKit-free into the `logic` tier, explicitly "so the watch / keyboard can run
  `<action>` / expression logic in-process". The prize is won.
- ✅ `ApiBlock.swift` (358 lines) imports **Foundation only** — extension-safe today.
- ✅ The transport is shipped (WCSession RPC verbs `call`/`fetch`/`link`, the reply
  correlation, phone background wake) and the watch surface renders bundled + OTA DSX.
- ⚠️ `JSERunner` (Stack.swift) is the ONE remaining core seam: the statement/effects
  runner holds `store: StackStore` + `weak var webView: UIView?` + surface effects
  (animate/present/measuring/component expansion).
- ⚠️ `StackWatch` interpolates with plain `StackScope` (var/path lookups) — **no JSE
  expressions in watch markup yet**.

**W1 — expressions on the watch** *(small, independent, ships first).* **LANDED
(compile-pending on Codemagic).** The audit it forced: JSE.swift was NOT yet standalone —
every entry took the concrete `StackStore`, and the reserved namespaces read app
singletons (`DSX.state`, `DSXCookies`, `AppEnvironment`). Landed as: the **`JSEState`
protocol** (the nine audited members; `StackStore` conforms in one line — phone path
byte-for-byte), the dictionary-backed **`JSEVars`** for satellites, `StackFormula` moved
into the tier, the **app-state seams** (`JSE.appVars`/`envChannel`/`cookieJar` closures —
installed at DSXBoot; nil on satellites, reserved reads fail open to empty),
`KernelLog.swift` added to the `logic` tier, `StackScope.expr` (an optional evaluator
closure — nil keeps widgets/activities on the simple form byte-for-byte), and
`StackWatch` installing the real evaluator per render. The watch target's `runtime` is
now `["watch", "logic"]`. Grammar conformance is **inherited by construction**: the watch
compiles the SAME `JSE.swift` the corpus pins. Remaining gate: the Codemagic device
build + the existing watch screens rendering unchanged.

**W2 — the runner seam. LANDED as the SATELLITE RUNNER (compile-pending).** The audit
priced a blind JSERunner extraction honestly: ~1,900 lines fused to the SwiftUI surface —
the one cut the plan forbids. What landed instead is the grammar's FOURTH executor
(`JSEActions.swift`, `logic` tier): the PORTABLE statement set the cross-platform law
already defines (store-writes-always `x = e`, const/let locals, if/for-of/budgeted loops,
try/catch, dsx.event, named actions depth-32, `await dsx.module…` / `await fetch` on an
async effects seam, keyed timers) over the SAME JSE evaluator and JSEState — the satellite
sibling of Kotlin's JseRunner.kt (which runs the actions corpus in CI and is the fidelity
anchor until the watch simulator lane lands). The app's JSERunner is untouched; unifying
it onto the seam remains the app-side follow-up. Original shape for reference: Split `JSERunner` at a host protocol in the
`logic` tier: the UIKit-free core (statement grammar, control flow, state writes, named
actions, `dsx.event`, budgets/ledgers) runs everywhere; a `RunnerHost` seam carries the
surface effects (animate, present, fetch-envelope, component expansion) — the phone backs
it with today's SwiftUI/Stack surface **byte-for-byte**, the watch backs it with
`WatchStore` + `WatchRouter` (animate = no-op or `withAnimation`, present = watch route).
Audit whether `StackStore` itself moves (Combine + SwiftUI exist on watchOS) — ONE store
beats a duality, but only if the audit is clean; otherwise the seam absorbs the
difference. This is the highest-risk step: focused, Codemagic-verified extractions
(the `DSXPathMatch`/`JSE` pattern), never one blind cut.

**W3 — the head lives on the watch. LANDED; real-simulator VERIFIED ONCE, not CI-gated.**
(Wording corrected 2026-07-25: "gated" overstated it. The `WatchUITests` suite described below is
real and did run on a real Apple Watch simulator, but only under a Watch-enabled profile —
the isolated `qa-expanded` qualification in `ClosedSource/Documentation/release-profiles.md`.
The default CI profile is `production-minimal`, which excludes `Core/Extensions/Watch`, so the
`codemagic.yaml` watch build + WatchUITests steps are skipped on every framework build. This lane
is evidence-at-a-point-in-time, not a per-PR gate — see the CI-status table in
`reference/StackWatch.md`.)
`WatchRuntime` mounts `<variable>` (initials + computed) / `<formula>` / `<action>` into
ONE state universe shared by expressions and actions (WatchJSEState), per-screen keyed
timers die on navigation, `await fetch` runs watch-direct with the WCSession gateway as
the no-route fallback, and `route.*` writes drive the watch's own router. `<api>` blocks
mount in a second pass after declarations, use the shared guarded URLSession transport,
a surface-scoped cookie-partitioned LRU, weak action handles, rich-state render
invalidation, and dispose before the next layout mounts. Plain and awaited
refresh/send plus cancel run in-process; late responses and events are generation-guarded,
and `on:<event>.debounce` / `.throttle` gates are canceled with the mounted screen.
The snapshot dialect remains the light path for snapshot nodes (widgets / Live Activities) — the
watch is a live node and is NOT one of them. The WatchUITests
simulator lane covers initial GET/loading, reactive debounce, success handlers, plain
and awaited refresh/send, mutation invalidation + cache revisit, cancel, and an
uncooperative response delivered after navigation — when it is run, which requires a
Watch-enabled profile (see the correction above).

**W4 — the capability table. LANDED (manifest + table + lint, BOTH HALVES primitives);
watch-native module compilation pending.** The `reach` role-list key is validated in the
manifest gate (opt-in; explicit list only; per-action override), and the CONSUMER half is a
primitive too: the Watch package's **`node` block** (`role` + `screens` + `capabilities`
paths, typo-gated `NODE_KEYS`) drives the generic `generate_node_capabilities` — nothing
watch-shaped in the scripts; a keyboard/clip node arrives by declaration alone. The
generator bakes ONE table into every declared path (the watch runtime resolves against it;
the phone's WatchBridge gates inbound relays with the same bytes ∪ the legacy config list),
and the STATIC LINT is live: a bundled watch screen calling a non-relayable action fails
the build with the fix named. Toast is the first opt-in (`"reach": ["watch"]` — the wrist
can toast the phone; a background-relayed toast DEFERS to the phone's next foreground,
coalesced to latest). The phone mirrors link + inbound events into reactive
`global.watch.*` (markup's sanctioned decoupled read — state, not a bus hook).
`platforms:["watch"]`-driven module compilation starts when the first watch-native module
lands. Original scope: Parse `platforms` / `reach`
(role-LIST, not bool — relaying to a keyboard is not the same trust as relaying to a
watch; keyboard default: nothing) in the manifest — typo-gated like
`EXTENSION_TARGET_KEYS` — and compile `platforms:["watch"]` packages into `DespiaWatch`
with a Rule-8-family extension-safety guard. Bake the capability table; first proofs:
ValueStore + Haptics (small, watch-native APIs). `has()` goes surface-aware.

**W5 — one bus across nodes. CORE LANDED (compile-pending); events + proactive push
remain.** `dsx.module.<s>.<a>()` in watch markup resolves per the adopted contract:
capability table → reachable relay (awaited over WCSession) → `unreachable` settled NOW →
`unsupported_on_surface` when the table says no. `dsx.link` is readable in watch markup
(nested `link.state/reachable/online` beside the legacy flat spellings). Cross-node
`dsx.on` subscriptions + proactive push + the `link.changed` event close the loop next.
Original scope: The watch `dsx.module` proxy runs the 4-way resolve
(in-registry → relay via the shipped `__rpc call` carrier with correlation ids →
`unreachable` per the offline contract → `unsupported_on_surface`), `dsx.link.*` becomes
the reactive namespace on both nodes (+ `link.changed`; add to the linter's JSE roots),
`relay_allow` config promotes to the manifest `reach` key, and the static lint lands: a
watch-bundled screen calling a non-watch-capable, non-relayable action is a **build
error**. `WatchLink.call`/`gatewayFetch` sink to package-private internals behind the
proxy; the gateway becomes the `fetch` builtin's no-route fallback. Cross-node
`dsx.on` subscriptions + proactive push close the loop, and the Live surfaces demo grows
"run it ON the watch" cells.

**W5·diagnostics — `dsx.log` LANDED in full; `dsx.error` PARTIAL, ledger deferred to the
node bus.** Both verbs used to fall through the satellite runner's dispatcher and vanish
silently, so the "diagnostics are unified primitives" law (monorepo working rules) held on three
executors and not on the wrist. Now:

* **`dsx.log(…)` — full parity, no divergence.** `Logs.swift` and `JSELibrary.swift` ride
  the same `logic` runtime tier the satellite runner does, so a node has the REAL ring and
  the REAL house formatter: canonical JSON + credential masking → `reportLog` → the log
  ring (cap 500) + one `[dsx.log]` kernelLog line, byte-identical to `JSERunner` /
  `JseRunner.kt` / the TS runner. Corpus-gated: the markup cases of
  `OpenSource/Conformance/logs/logs.json` now run through `JSEActionRunner` itself in the
  Swift recorder lane (`LogsConformance.verifySatellite`) — the fourth executor's FIRST
  conformance coverage of any kind.
* **`dsx.error(…)` — the kernelLog line only, and the gap is stated, not hidden.** The
  ambient fan-out (`Errors.swift`) cannot join the `logic` tier: it reaches `DSX.state`,
  the `ModuleRegistry`, `DSXMessenger`/`DSXEvents` and `JSON`, none of which exist in a
  satellite process. So on a node there is **no `dsx.errors` ledger, no `module.error`
  hook, no page `dsx.on("dsx")` mirror, and no reactive `global.dsx.lastError` /
  `errorCount`** — the `global.*` plane itself is unreadable on a node (`JSE.appVars` is
  bound only in the app target's `DSXBoot.swift`). What ships is the same
  `[dsx.error] <scheme> → <code>` line the kernel emits, widened to carry the fields the
  absent ledger would have held. Closing this is **exactly** the remaining W5 work above:
  once a node has the bus, the error plane rides it like any other. Explicitly rejected
  meanwhile: a second, node-local ledger type — that is the bespoke channel the law bans,
  and it would answer a `dsx.errors` read a node still cannot serve.
* An **uncaught throw** on a node is now an error emission with origin `"uncaught"` and the
  corpus-pinned field derivation (errors corpus §7), not the ad-hoc log line it was.

Still uncovered on this executor, and worth naming: the **actions** corpus. `dsx.log`
aside, `JSEActionRunner`'s statement grammar is anchored only by the Kotlin twin — the
watch-simulator corpus lane (W2's closing gate) remains the tracked fix.

**Risk register:** the W2 runner seam (mitigation: per-type audited moves, Codemagic per
step, phone path byte-stable); watch binary size (JSE+ApiBlock ≈ 1.6k lines of
Foundation code — negligible; watch-native packages gated per-package); watchOS
background budget (live RPC only while reachable — the contract already says so);
`StackStore` portability (decided by audit in W2, not assumed).

## Phasing (each independently shippable)

| Phase | What | Unlocks | Notes |
|---|---|---|---|
| **0 — keystone** (LANDED for the evaluator) | Extract the JSE/logic core from UIKit into an extension-safe kernel tier | also gives the keyboard in-process logic + a shared `RouteResolver` | `DSXPathMatch` + `JSE.swift` shipped; the runner seam is W2 of the execution plan |
| **1** | JSE on the watch (`await fetch` + `<action>` logic in-process) | **most** native-DSX apps become standby-autonomous (their "tasks" are fetch) | small after #0 |
| **2** | Watch `ModuleRegistry` + `platforms` packages compiled in (Health/Location/Storage/Crypto) | in-process **device** capabilities, phone asleep | needs watchOS dep slices |
| **3** | Cross-node `dsx.module`: 4-way resolve, live RPC + queue, BG phone wake, result cache | "call any phone package," awaited, standby-safe | builds on the shipped WatchBridge relay |
| **4** | Cross-node events/subscriptions + proactive push + the static capability lint | events handled in phone BG, reused on watch; author-time safety | closes the loop |

### Phase 0 — extraction map (in progress)

`Stack.swift` is one huge file (~5,100 lines after the extractions below) with Foundation +
SwiftUI + UIKit + crypto, the JSE logic interleaved with the SwiftUI/UIKit renderer. Extracting
logic out of it is the **blessed pattern** (`StackNode`/`StackScope`/`StackLive` were extracted
the same way). The only real risk is missing a UIKit coupling — audit each type before moving,
and **wire the new file into Runtime** (explicit PBXFileReference via `add_core_sources.rb`)
the same turn.

**Done:** `DSXPathMatch` → `OpenSource/Engine/iOS/DSXPathMatch.swift` (UIKit-free; was already
referenced cross-file by `Router.swift`, so a zero-risk relocate). New **`logic` kernel tier**
(`runtime:["logic"]`) holds it, the **Rule-8 guard** keeps it UIKit/WebKit-free, and the
watch/keyboard `RouteResolver` now has an extension-safe matcher to build on.

**Also done (the prize):** `JSE` → `OpenSource/Engine/iOS/JSE.swift` (1,221 lines) — the full
expression evaluator, extracted UIKit/WebKit-free into the `logic` tier ("Foundation +
Security/CryptoKit/Network only; no surface deps"), the SAME evaluator Stack.swift/JSERunner,
DSXState and DSXScreen consume. And `ApiBlock.swift` is Foundation-only — extension-safe
as-is. What the original list called "extractable next" has landed; the remaining core is
the **runner seam** (W2 in the execution plan above).

**Also done (the library):** the JSE **runtime library** →
`OpenSource/Engine/iOS/JSELibrary.swift` (~2,000 lines, moved VERBATIM): `JSECrypto` (+ the
ECDSA signer/verifier protocol extensions), `JSECore` (+ `JSEAbortFlags`/`JSEConsole`/
`JSEReachability`), `JSERegex`, `JSERedact`/`JSETrace`, and the house console formatter
(`JSELogFormat` — `JSERunner.formatLogValue/formatLogArgs` forward to it, so the logs corpus
pins ONE implementation on every target). Forced by the first per-app watch build: `JSE.swift`
compiles into DespiaWatch via the `logic` tier but referenced these types living in
`Stack.swift` — 21 compile errors. `JSESocket` stayed exactly per the entangled list below
(it holds `StackStore`/`UIView`/`Context`). Same-turn wiring: the `logic` tier, the Rule-8
extension-safety list, and `add_core_sources.rb` all carry the new file; `dsx.has(...)` in
`JSE.swift` platform-splits on watchOS to the relay table (`DSXNodeCalls.relayTable` — W4's
capability truth) since `ModuleRegistry` arrives only with ladder tier 2.

**Entangled — refactor before they can move:**

- `JSESocket` — holds `private weak var webView: UIView?` (+ `StackStore`, `Context`). Replace
  the `UIView`/store with an injected event sink so the socket is transport-only.
- `JSERunner` — the effects runner touches the store/surface/UI (animate, present). The watch
  needs a **surface-abstracted** runner (or a watch-subset) — effects go through a protocol the
  phone backs with SwiftUI and the watch backs with its own surface.
- `StackStore` (`ObservableObject`/Combine — extension-safe but renderer-coupled), `StackStyle`
  (SwiftUI modifiers) — `StackStyle` stays; `StackStore` moves only if the watch runner needs it.

Each is a **focused, Codemagic-verified step** — not one blind cut of the core engine (a broken
`Stack.swift` breaks the whole app, and Swift doesn't compile in the authoring env).

## Open questions — RESOLVED (v2)

1. Capability granularity: **package-level default + per-action override, shipped
   together** — the static lint needs per-action resolution anyway, and the parse cost is
   trivial.
2. `reach` default: **opt-in, and a role LIST rather than a bool** — `"reach": ["watch"]`.
   Relaying to a watch and relaying to a keyboard are different trust decisions (the
   keyboard sees keystrokes); the keyboard's inbound allowlist defaults to nothing.
3. `has()`/errors: **yes** — `unsupported_on_surface`, `unreachable`, and (when the
   deferred opt-in queue lands) `queued` are three distinguishable outcomes with three
   different recoveries (§The offline contract).

## W7 — the watch's OWN glanceables: Smart Stack activities + watch widgets (ADOPTED design; activities half LANDED)

Two watch surfaces, two different reuse stories — and the taxonomy already covers both,
because each is a **snapshot node** (state replication in, forever; never a runtime):

### 1. Live Activities in the watch Smart Stack — LANDED

watchOS 11 mirrors the iPhone's Live Activities into the Smart Stack automatically
(compact leading/trailing, no code). The tailored presentation is the **supplemental
`.small` activity family** — and in DSX that is exactly ONE MORE SLOT of the existing
`<activity>` document, not a new surface:

```xml
<activity>
  <lockscreen> … </lockscreen>
  <small> …the watch card… </small>   <!-- watchOS Smart Stack (supplemental .small) -->
  <island> … </island>
</activity>
```

Landed pieces: `StackActivity.small` (one more slot read, same parser), the
`.supplementalActivityFamilies([.small])` opt-in on the activity configuration
(`#available(iOS 18)`-gated; below 18 the configuration ships unchanged), the
`\.activityFamily == .small` router in the lock-screen view (missing slot → the
lockscreen card, system-scaled — the same per-slot fail-open as every island region),
and a `<small>` card in the default download document. Everything else — live tokens
(`<countdown>`), compiled-interaction buttons, the snapshot state channel — is the SAME
document riding the SAME machinery; the watch presentation costs an author one element.

### 2. Watch widgets / complications (accessory families) — designed; foundations landed

A watch widget (Smart Stack rectangular, corner/circular/inline complications) is a
WidgetKit extension **inside the watch app** — a snapshot node HOSTED BY a live node.
The reuse map, piece by piece:

- **Target**: one more `extensionTargets` entry on the Watch package with the landed
  `host` spec key — `{ "name": "DespiaWatchWidgets", "host": "DespiaWatch", … }`.
  `host` (generic, typo-gated) synthesizes the target embedded in ANOTHER declared
  target instead of Runtime: bundle id derives from the HOST's (`<watch-bid>.widgets` —
  Apple's nesting for free), and a watchos app_extension embeds via its host's PlugIns
  phase (only the watch APPLICATION rides "Embed Watch Content" — derived from the
  product type, never a name).
- **Rendering**: the same snapshot tier (StackLive + StackScope + StackNode) compiled
  into the widget target, plus a thin accessory entry (the StackWidgetKit pattern for
  `.accessoryRectangular/.accessoryCircular/.accessoryCorner/.accessoryInline`). Live
  tokens work as-is (`Text(timerInterval:)` renders in accessory families).
- **Data channel**: the watch APP writes the snapshot (layout + vars) to the watch
  pair's OWN App Group and pokes `reloadAllTimelines` — the phone never talks to the
  watch widget directly; state flows phone → watch node (existing WatchLink
  replication) → widget snapshot. The group falls out of the EXISTING derivation with
  zero new convention: `Container.groupID` on the watch app and
  `DSXNodeCalls.defaultAppGroup` in its .appex both resolve
  `group.<phone-bundle>.watchkitapp.container` — the reserved formula applied to the
  HOSTING app of that node pair.
- **Interactions**: the compiled-interaction law verbatim — one literal
  `dsx.module.<s>.<a>({json})` per button, an AppIntent in the widget (watchOS 10+)
  queues into the watch pair's group via the SAME `DSXNodeCalls.perform`, and the WATCH
  APP drains it into its runtime — which executes locally or relays to the phone
  through the existing capability path. Admission bytes: the SAME role-`watch` table —
  `node.capabilities` simply lists a second copy path for the widget bundle (the
  generator already writes identical bytes to every declared path), so the app and its
  widget can never disagree.
- **Families in DSX**: per-family slots on the widget document (the `<activity>`
  precedent): `<widget><rectangular>…</rectangular><circular>…</circular>…</widget>`,
  bare layout = rectangular, missing family → fail-open to the nearest declared slot.
- **Provisioning**: the new pipeline machinery covers it generically — the target rides
  `signing_targets`/`reconcile_extension_profiles` (host-chained bundle ids; no usable
  profile → the Watch package skips fail-open), `provision_extension_app_ids` enables
  its required capabilities on its App ID (APP_GROUPS from `container`, plus manifest
  `capabilities` like the Health child's HEALTHKIT), and the one portal-only step
  (associating the watch pair's group) is printed verbatim by every log path. SEQUENCING: this slice lands after one green soak of the
  per-target signing stabilization it deliberately rides — the entitlement/profile
  class it exercises is the one that just failed production builds.
- **Wear OS twin**: tiles/complications via Glance for Wear reuse `:glance`'s
  StackGlance painter unchanged (the snapshot dialect is already there); tracked in
  `android-status.md` with the rest of the Wear column.
