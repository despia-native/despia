# Surface bridges: mounting a RENDER SURFACE on the bus (`dsx.messenger`)

Some screens don't render DSX markup or web HTML — they run **foreign content on an
embedded runtime**: a web page in a `WKWebView` (`<DSXWebView/>`), a game in the Godot
engine (`<Godot/>`), tomorrow maybe a Lua canvas or an embedded Flutter view. The
constitution calls these **surfaces**: *"modules provide, surfaces consume — the web
view and native UI are equal consumers that attach to the bus; neither is
privileged."* This skill is the complete recipe for giving such a surface's CONTENT
first-class bus access — calls with promise semantics, per-call streams, and
broadcast subscriptions — through **one** kernel seam that every surface rides
identically: **`dsx.messenger`** (`OpenSource/Engine/iOS/Messenger.swift`; design
history in [reference/messenger.md](../Documentation/reference/messenger.md)).

Two shipped reference implementations, deliberately twins:

| | web (`<DSXWebView/>`) | game (`<Godot/>`) |
|---|---|---|
| surface owner (mounts) | `Core/Dom` | `Core/Godot` |
| mount id | `"web"` | `"godot"` |
| transport | WK message handler / `evaluateJavaScript` | SwiftGodotKit host bridge |
| content-side SDK | `runtime.js` → `window.despia` | `despia.gd` → `Despia` |
| content trust gate | allowed hosts / configured sources | configured origin + SHA-256 pack hashes |

## The five pieces of a surface

Every bridge-needing surface is the same five pieces. When you add one, you write
2–5; the kernel (1) is done and the pattern for each is below.

1. **The kernel seam** — `dsx.messenger` (exists; never per-surface).
2. **The host component** — a `GlobalStackComponent` that renders the runtime's view
   (via the `DSXNativeView` kernel primitive) so the surface works inline, as a
   routed page, as the app's home frame, and mounted+pushed by its package.
   `GodotComponent.swift` is the template; see
   [mounting-components.md](mounting-components.md).
3. **The load gate** — where TRUST is decided (see "Trust", below). Content comes
   only from app-configured sources and is integrity-checked. Consume the KERNEL
   content primitive (`dsx.content.prepare` — offline-first, hash-verified,
   stale-while-revalidate; `OpenSource/Engine/iOS/Content.swift`); `GodotContent.swift`
   (the thin Godot consumer) is the template.
4. **The bridge module** — the surface OWNER: mounts the sink, encodes egress onto
   the transport, feeds content calls into `mount.receive`. `GodotBridge.swift` is
   the template.
5. **The content-side SDK** — the `window.despia` twin running INSIDE the runtime:
   pending map, ids, timeout, listener filter. `runtime.js` (JS) and `despia.gd`
   (GDScript) are the two worked examples.

## 1 ⇄ 4: the mount — the entire native contract

```swift
// in the surface owner's Module.setup() — the WHOLE integration:
mount = dsx.messenger.mount("<surface-id>") { [weak self] egress in
    self?.deliver(egress)          // OUTBOUND: encode onto your transport
}
// INBOUND: relay one content call onto the bus
mount?.receive(scheme: "haptic", action: "success", args: ["k": "v"], rid: "c_1")
```

- **`mount(id, sink)`** — id = your module's scheme by convention. Re-mounting the
  same id replaces the sink (a re-created surface rebinds). Keep the handle;
  `unmount()` to detach (usually never — module lifetime).
- **`mount.receive(scheme:action:args:rid:)`** — dispatches the call at the
  **untrusted tier** (`includeInternal: false` — the exact flag the web relay
  passes): `exposed: false` internal actions are invisible, declarative manifest
  gates apply. `rid == nil` = fire-and-forget (no reply routed). An unowned scheme
  synthesizes an `error` envelope (`code: "not_loaded"`) back to your sink, so the
  content's pending call always settles.
- **What arrives at your sink** (`DSXEgress { target, scheme, rid, payload }`):

| egress | `rid` | `payload.event` | meaning → SDK behavior |
|---|---|---|---|
| resolve | set | `"result"`, `final:true` | settle the pending call with `payload.data` |
| reject | set | `"error"`, `final:true`, + `code`/`recoverable`/`message?` | settle as error |
| stream | set | anything else | per-call event (`dsx.event`) → the call's stream handler |
| broadcast | nil | the event name; `scheme` = channel | filter by subscribed channels → listeners |

The `payload` is the canonical envelope (`{id, scheme, host, event, final, data, …}`)
— the same object `window.despia.__proxy` consumes, so a JS surface forwards it
verbatim and a non-JS surface reads the four fields above. **Deliveries arrive on
the main thread. No sink mounted = silent no-op** (a pure-native app with no web
view drops web-bound replies exactly this way).

## 5: the content-side SDK contract

The SDK is where promise semantics live. All three shipped SDKs are the same
machine; copying `despia.gd` is copying `runtime.js`:

1. **ids + pending map** — generate a per-call id, store an awaitable ticket,
   send `{call, id, target, args}`, settle it when the correlated reply arrives,
   **drop unknown/late ids silently**.
2. **THE SDK OWNS THE TIMEOUT — for resolve-once calls ONLY** — the kernel
   deliberately has no call deadline (a handler that never settles never
   delivers). The web arms 30s in `despia.arm` for promise calls but NOT for
   stream calls (a handler present = long-lived); mirror both rules. Treat a late
   reply as a dropped id. Streams also need a CANCEL: re-post the same rid with
   `{"__stop": true}` (the bus-wide stream-termination signal) — `despia.gd`'s
   `watch_native`/`stop_watch` is the worked example. (Engine-clock caveat: a
   paused runtime pauses its timers — fine, since a paused surface isn't awaiting.)
3. **error shape** — settle errors distinguishably (`{code, recoverable, message?,
   data}`); GDScript has no rejection, so `despia.gd` settles a
   `{"__despia_error": true, ...}` dictionary tested via `Despia.is_error()`.
4. **broadcast filtering is CLIENT-SIDE** — every broadcast fans out to every
   mounted sink; the SDK keeps a `channel → listeners` map (the web's `listeners`,
   `despia.gd`'s `_listeners`) and drops the rest. (A bridge module MAY pre-filter
   before crossing an expensive transport — Godot forwards only subscribed
   channels — but that's a transport optimization, not the trust model.)
5. **naming** — mirror the page surface (`window.dsx`'s `dsx.module` root; `window.despia` is its legacy bare-scheme alias): bare scheme = default action
  (`"haptic"`), `scheme.action` (`"haptic.light"`), dotted groups ride through
  (`"intelligence.rag.add"` → host `"rag.add"`). If the content language has a
  dynamic-member hook, ALSO ship native-parity dot navigation over the string
  form (GDScript: `dsx.gd`'s `_get` proxy chain — `await
  dsx.module.haptic.success.run()`; the `.run` invoker exists because GDScript
  forbids `()` on dynamic Callables — verify your language's rule from source).

## The transport (2 ⇄ 5): keep it dumb

The transport just moves bytes; everything smart is in the SDK/bridge. Two rules
learned the hard way:

- **Structured data crosses as JSON STRINGS**, not the runtime's native containers —
  nothing then depends on cross-runtime type-coercion rules. Consequence: numbers
  arrive as floats content-side (same as the web; document it, don't fight it).
- **Verify the transport's actual contract from source** before writing the SDK —
  e.g. SwiftGodotKit's inbound callable is `emitMessageToHost` (camelCase) while its
  outbound signal is `message_from_host` (snake_case), and its bridge node attaches
  lazily *after* the autoload's `_ready` (hence despia.gd's poll + outbox).

## Trust — decided at the LOAD GATE, never per call

[security.md](security.md)'s doctrine, applied to surfaces:

- **Source-anchored**: trust attaches to where content was LOADED from. The load
  gate (piece 3) only accepts app-configured origins and verifies integrity
  (hashes / signing). That's the boundary.
- **Past the gate, content gets the WEB's standing** — `mount.receive`'s untrusted
  tier. Not the native tier: internal actions stay hidden from ALL foreign content.
- **No per-call allowlists** — explicitly considered and rejected ("gate the door,
  not every step inside the house"). Don't add one to your surface.

## Lifecycle laws (see [lifecycle.md](lifecycle.md))

- **Channel filters are SESSION-scoped, not screen-scoped**: scope them to the
  lifetime of the state they mirror. If the runtime survives screen close (libgodot
  never tears down in-process — the game's listener map lives on), the native
  filter must survive too, or a reopened session's `on()` channels are silently
  dead. Clear filters only when the content session itself dies. The mount lives
  module-long.
- **Late correlated replies after teardown are safe no-ops** (the SDK dropped the
  id; the transport guards on a live runtime).
- **Suppress the self-echo**: a content-sourced event the bridge re-broadcasts fans
  back out to the bridge's own sink — drop that one delivery, or content subscribed
  to its own channel feeds back into itself.
- Pause the runtime when covered/backgrounded; the SDK's timers pause with it.

## Checklist: adding surface number three

1. Module folder (`Core/<Name>`), scheme = surface id; runtime via `spm`/`pods`/
   `build`; ALL runtime API behind `#if canImport` in ONE loader file (stub =
   visible "unavailable" card, never a broken build).
2. Host component (copy `GodotComponent`): the four placements + a visible failure
   state + `fill` prop for inline slots.
3. Load gate (copy `GodotContent`): resolve the folder via `dsx.content.prepare`
   (the kernel owns offline-first + hashes); keep only your meta/boot policy.
4. Bridge module (copy `GodotBridge`): mount + `deliver(egress)` encoder +
   `receive` relay + channel filter + single teardown.
5. Content SDK (port `despia.gd`): pending map, timeout, error shape, listener map.
6. Docs + a `<name>_test` package; run the four repo gates.
7. **DEVICE-SMOKE the correlated path** — a bridge bug breaks every reply and no
   local gate can see it: (a) await resolves with the right value; (b) stream
   events arrive in order and `final` closes; (c) errors carry `{code, data}`;
   (d) native `dsx.module` callers still settle via `onTerminal`; (e) a broadcast
   reaches the web, `dsx.events.on`, AND your surface.

## What the kernel guarantees (so you don't re-implement it)

- Dispatch + trust tiering + gates (`mount.receive`).
- Reply routing to the ORIGIN surface (calls carry `surfaceID`; `"web"` is the
  default for surface-less callers).
- Broadcast fan-out to every sink + `dsx.events` + the web, from ONE
  `dsx.broadcast`.
- Synthetic `not_loaded` / `invalid_uri` settles for unroutable calls.
- Main-thread delivery; no kernel deadline (yours); `Once`-latched terminals (a
  misbehaving handler can't double-settle).
