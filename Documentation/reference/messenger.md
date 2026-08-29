# The messenger + the clean web bridge

> **Goal:** one clean modern bridge, full support; legacy reduced to a thin second-class shim. The
> kernel hands **intent** to mounted **messengers** (surfaces); a surface renders it. No module —
> not even the kernel — holds a `WKWebView` for delivery; **DSXWebView** is the only web egress.

This is the endgame of the WebView dissolution applied to the *bridge itself*. Two ends of one bus:
the **messenger** (native side — how `dsx.*` leaves the kernel) and the **web bridge** (`window.despia`
vs `window.virtual`).

---

## Today (the mess)

```
window.virtual   ← the ACTUAL engine: pending registry, register, the inbound sink, on, arm, send, href
window.despia    ← a thin wrapper that calls window.virtual.register / .send / .on
kernel Bridge    ← builds the inbound-sink JS and calls webView.evaluateJavaScript (holds the WKWebView)
```

The protocol lives in the *low-level legacy* object; the *modern* object just delegates to it; and the
kernel reaches the web view directly. Three problems in one.

---

## The clean target

### Web side — one modern owner, one basic legacy shim — **DONE** (the engine has moved)

```
window.despia  (runtime.js) — THE bridge, full support:
    • pending registry + register + arm
    • __proxy(payload)         ← the single inbound delivery sink; NATIVE delivers here directly
    • on(scheme, fn)          ← despia.on subscribers (the real impl, was window.virtual.on)
    • despia.<scheme>.<action>({…})  proxy  + resolvePayload (File/Blob → URL) + storage

window.virtual  — BASIC legacy transport, second-class:
    • href setter / send / call  →  postMessage   // the outbound substrate window.despia posts through
    • capabilities               ← native facts runtime.js reads
    • NO engine — the sink / register / on / arm / pending are GONE (now window.despia's own)
```

Native no longer calls a sink on `window.virtual` — `Bridge.proxy` delivers to `window.despia.__proxy`
directly, so `window.virtual` carries no engine. The transport (`href`/`send`/`call`) + `capabilities`
stay until WVC retires (it still funnels through `window.virtual.send`/`.href`); slice 4 thins
`window.virtual` to `href` only.

**Basic legacy kept (the "bit"):**
1. the legacy `window.virtual.href` / `.send({…})` / `window.location.href` scheme-string assignments — old web→native calls (see [legacy.md](../legacy.md)).
2. `window.<name> = value` and `window.<name>(data)` — old native→web globals/callbacks (back `dsx.variable`/`dsx.function`), second-class.

**Dropped** (all were *internal* — only runtime.js + native ever called them): `window.virtual`'s old sink,
`register`, `pending`, `on`, `arm`. They consolidated into `window.despia`.

### Native side — the kernel hands off intent, surfaces mount

```swift
// dsx.messenger — sibling of dsx.shared / dsx.events. Any surface mounts to receive the egress stream.
@discardableResult
func mount(_ id: String = "web", _ sink: @escaping (Egress) -> Void) -> Unmount

struct Egress {                 // intent, never JS
    let target: String          // "web" (default), a popup id, "*" = firehose
    let scheme: String
    let rid: String?            // non-nil ⇒ correlated (resolve/error/event for one call)
    let kind: Kind              // .proxy(payload) | .variable(name,val) | .function(name,val) | .css(p,v)
}
```

`dsx.resolve/error/event/broadcast/variable/function/css` keep their exact signatures, but instead of
`Bridge.proxy(on: targetWebView, …)` they build an `Egress` and dispatch it to mounted messengers.
`Context` drops `targetWebView` (→ a `callSurfaceId` String) and `import WebKit`. `Bridge`'s JS-building
moves into DSXWebView.

### DSXWebView — the one web surface (the only WebKit owner besides nothing)

```swift
dsx.messenger.mount("web") { [weak self] e in
    guard let self else { return }
    guard self.pageReady else { self.buffer.append(e); return }      // buffer until load (WebSocketBridge pattern)
    switch e.kind {
    case .proxy(let p):            self.webView.evaluateJavaScript("window.despia.__proxy(\(json(p)))")   // resolve/event/broadcast
    case .variable(let n, let v): self.webView.evaluateJavaScript("window[\(q(n))]=\(json(v))")          // basic legacy
    case .function(let n, let v): self.webView.evaluateJavaScript("var f=window[\(q(n))];if(typeof f==='function')f(\(json(v)))")
    case .css(let p, let v):      self.webView.evaluateJavaScript("document.documentElement.style.setProperty(\(q(p)),\(q(v)))")
    }
}
```

A native `DSXView` mounts the same stream later and renders `.proxy` to native state — zero module change.

---

## Routing

| `Egress` | Delivered to |
|---|---|
| `rid != nil` (resolve/error/event) | the one mounted sink whose id == `target` |
| `broadcast` | all sinks matching `target`/`*` **and** in-process `dsx.events.on(scheme)` |
| variable/function/css (fire-and-forget) | the `target` sink |

A `target` with no mounted sink ⇒ web delivery is a no-op (pure-native app; native subscribers still get broadcasts).

---

## Risks

1. **Can't-fail guarantee.** `window.virtual` was injected first so the bridge exists even if runtime.js
   throws. Mitigation: `window.virtual` stays the minimal can't-fail *legacy transport* (`href` → postMessage);
   modern delivery legitimately needs runtime.js (which `despia.<x>()` already requires).
2. **Direct `window.virtual` sink / `register` callers** break — but those are internal; the public legacy
   surface is `href`/`location.href` (kept). Confirmed by grep: only runtime.js + the native side call them.
3. **Delivery timing.** Native must not deliver before `window.despia.__proxy` exists. Both inject at
   document-start; `resolve` follows a call (runtime.js up), and early `broadcast`s ride the surface buffer.

---

## Slices (additive; old path intact until the last)

- ✅ **Web-side ownership inversion — DONE.** `window.despia.__proxy` (runtime.js) is the single inbound sink; the pending registry / `register` / `arm` / `on` moved off `window.virtual` into `window.despia`; native `Bridge.proxy` delivers to `window.despia.__proxy` directly; `window.virtual` thinned to the legacy transport (`href`/`send`/`call`) + `capabilities`. (`node --check` green; rides the build for device smoke.)

- ✅ **Module-side egress consolidation — DONE (NOT via the messenger — point-to-point through the Dom *module*).** No module holds or pulls a `WKWebView` for delivery anymore. Raw `evaluateJavaScript` in PushRouting / ContentServer / SpeechRecognition / AdMob / LegacyIAP / Vision / AppleAuth → `dsx.module.dom.eval`/`.call`/`.set`/`.load`. The legacy `window.<name> =` / `window.<name>(…)` projection (`dsx.variable` / `dsx.function`, 74 call sites across ~30 modules) → `dsx.module.dom.set`/`.call`; **`Context.variable` / `Context.function` + `Bridge.legacy` deleted.** So **DSXWebView is already the sole web egress for MODULE-originated delivery** — this front-runs slice 3's variable/function half (the Dom module owns it, the kernel never did the projection), leaving the messenger to cover only the kernel's *own* correlated path below. (Compile-pending; rides the build.)

- ✅ **`dsx.css` rerouted through Dom — DONE.** `dsx.module.dom.css(["property": prop, "value": value])` (modern primitive — API kept) now delivers via `dsx.module.dom.css` → `Dom.cssJS`; **`Bridge.css` deleted.** All three fire-and-forget projections (variable / function / css) are off the kernel. **`Context.targetWebView` now has exactly ONE remaining user: `Bridge.proxy` (resolve / event / broadcast)** — the crisp, single-mechanism boundary the messenger has to cross.

Remaining (the native/kernel half — `Bridge.proxy` is the LAST `targetWebView` user):
1. `dsx.messenger.mount` + dispatch; route **`broadcast`** through it; DSXWebView mounts + forwards to `window.despia.__proxy`. resolve/event stay on the old `Bridge.proxy` path. Proves the mechanism. **(device-gated — this is the correlated promise path; a bug breaks every call's reply, uncaught by lint/balance.)**
2. Move resolve/error/event onto messenger intent (carry `rid`).
3. Relocate `Bridge.proxy`'s payload-building into DSXWebView; `Context` drops `targetWebView` + `import WebKit`. Thin `window.virtual` to `href` only. *(variable / function / css already off the kernel — see above.)*
4. `DSXView` mounts a sink → `dsx.*` projects to native surfaces.

### ✅ Mechanism B — BUILT (the multi-surface messenger is live; first mounted surface: Godot)

`Messenger.swift` ships `dsx.messenger.mount(id, sink)` + `DSXEgress { target, scheme,
rid, payload }` + `mount.receive(scheme:action:args:rid:)` — the FULL two-way seam, not
just egress:

- **Inbound**: `mount.receive` dispatches the surface's content calls at the untrusted
  tier (`includeInternal: false` — the web relay's flag), stamping `Params.surfaceID`.
  An unowned scheme synthesizes an `error` envelope (`not_loaded`) back to the sink.
- **Outbound routing (per the table above)**: `Context.resolve` / `sendError` /
  `event` deliver a call's envelopes to the ORIGIN surface's sink when `surfaceID` is
  set (per-call streams now reach non-web surfaces — the old web-only gap is closed);
  `broadcast` additionally fans out to EVERY mounted sink (surfaces filter
  client-side, like `despia.on`). Calls with no `surfaceID` (the web, native
  `dsx.module`) are byte-identical to before.
- **First consumer**: the embedded Godot runtime, which mounted `"godot"` and encoded
  egress onto that engine's host-bridge wire. That module was removed on 2026-08-29,
  superseded by the in-house `Scene3D` engine; the messenger contract it exercised is
  unchanged, and a surface owner still mounts by name exactly as shown above.

### ✅ Mechanism B COMPLETE — DSXWebView mounts `"web"`; the kernel's delivery names NO module

The final slice shipped: DSXWebView mounts `"web"` in its `setup()` (envelope →
`Dom.proxyJS` → `window.despia.__proxy`, the exact delivery the `proxy` action does —
which stays as a public dom verb). Context's four sites now deliver ONLY through the
hub: correlated envelopes to `surfaceID ?? "web"`, broadcasts to every sink +
`dsx.events`. `module.dom.proxy` no longer appears in the kernel's delivery path —
the reply switch is fully surface-anonymous (no sink mounted = silent no-op, the
pure-native case). Authoring guide for new surfaces:
`OpenSource/Skills/surface-bridges.md`.

⚠️ **DEVICE-GATED as specified below**: this commit IS the correlated-promise-path
change (checks #1–5) — smoke them on device before merge.

---

## Execution plan — the kernel's last egress (`Bridge.proxy` → Dom)

Grounded in the real code (`Context.swift:538–585`). Four sites build a `window.despia.__proxy(…)`
payload and deliver via `Bridge.proxy(on: targetWebView, …)`:
- **`resolve`** (`event:"result"`, final) / **`error`** (`event:"error"`, final, `code`) — but **only in
  the `else` branch**; the `callParams.onTerminal` branch (a NATIVE `dsx.module` caller) is
  native-to-native and MUST stay.
- **`event`** (non-final, streams this call's `rid`).
- **`broadcast`** (no `rid`) — also publishes to the native event bus via the `dsx.events` façade
  (`events.publish(…)`) for native subscribers, which MUST stay.

So the change replaces ONLY the `Bridge.proxy(on: targetWebView, …)` web delivery; `onTerminal`
(native callers) and `DSXEventBus` (native subscribers) are untouched. After it, `Context.targetWebView`
+ `import WebKit` are deleted from the kernel — `targetWebView`'s last user is gone.

### Two mechanisms
- **A — point-to-point through Dom (single-surface; identical pattern to css/variable/function).**
  Add `dsx.action("proxy")` + `Dom.proxyJS` (relocate `Bridge.proxy`'s payload-building); Context's
  four sites build the payload and call `try? package.dom.proxy(["payload": dict])`. Smallest change.
  Always targets the one "web" surface.
- **B — the messenger (multi-surface).** `Egress(target, rid, payload)` + `dsx.messenger.mount(id){…}`;
  DSXWebView mounts `"web"`. Needed only when `DSXView`/popups must receive the stream. The real endgame.

  **Recommendation:** ship **A** first (clears `targetWebView` now; single-surface is today's reality),
  promote to **B** when native `DSXView` routes land.

### Why this is DEVICE-GATED (do not blind-code — no compiler/runtime here)
`resolve` is every `await despia.x.y()` reply. Rerouting it through a nested `dsx.module.dom` dispatch
risks **`Bridge.currentParams` reentrancy** (the main-thread "current dispatch" global is cleared in a
`defer`; a nested dispatch can clear the outer call's prematurely) and **rid/ordering** bugs — none of
which `balance` / `lint` / `check_module_rules` can see. Required device checks:
1. `await despia.<pkg>.<action>()` resolves with the right value.
2. A streaming action's `despia.on` events arrive in order; terminal `final` closes the stream.
3. `dsx.error` rejects with `{ code, data }`.
4. A native `dsx.module.x.y()` caller still settles via `onTerminal` (no web hop).
5. `broadcast` reaches BOTH `despia.on` and a native `dsx.events.on`.

### Steps (each its own commit on the branch, device-gated before merge)
1. ✅ **DONE.** `Dom.proxy` action + `Dom.proxyJS` added (mirrors `Bridge.proxy`'s `__proxy` sink); `Bridge.proxy` kept live.
2. ✅ **DONE.** `broadcast`'s web half → `package.dom.proxy` (byte-identical envelope; `DSXEventBus` kept).
3. ✅ **DONE.** `event`, then `resolve`/`error` (web branch only — `claimTerminal` + the native `onTerminal` branch untouched). **Context now makes ZERO `Bridge.proxy` calls — its web delivery is 100% via `dsx.module.dom.proxy`.**
   - Reentrancy fear retired: `Bridge.currentParams` has no readers; `dsx.args` reads per-Context `callParams`.
   - ⚠️ Still **device-smoke** the promise round-trip (checks #1–5) before #710 merges.
4. ✅ **DONE — the capstone. `targetWebView` removed; the kernel no longer threads a web view through dispatch.**

   **4a — kernel dispatch-rework — DONE.** No delivery read the per-call webview (steps 1–3), and
   `callWebView` was *private* (never exposed to modules — a module that needs the live view reaches it
   the proper way, via the shared `"web"` handle: `dsx.shared.use("web")` / `dsx.module.dom.object("view")`,
   published by `DomWebHost`). So the `on: WKWebView?` param was dropped from the dispatch path:
   `handle(url:params:on:)` → `handle(url:params:)` (`Context` + `Package.handle` + the `Registration.dispatch`
   chain + the `Context` per-call init), and `Context.callWebView` + `Context.targetWebView` + the now-dead
   `Registration.webView` field were deleted. Callers updated to drop the arg (`Bridge` VirtualBridge,
   `Stack` ×3, `WebDelegate`, `MultiApiCall`, `Context`'s nested dispatches). `import WebKit` stays in
   `Context`: `runHydrations/runReady(on: WKWebView)` still publish the `"web"` shared handle (boot publish,
   not delivery — constitutionally fine).

   **4b — Bridge web-delivery cleanup — DONE.** `Bridge.proxy` + its only helper `Bridge.jsonLiteral` + the
   dead `Bridge.currentParams` + the proxy-only `Bridge.Kind` were deleted — all callerless (the correlated
   envelope builds in `Context` and delivers via `dsx.module.dom.proxy` → `Dom.proxyJS`). Bridge's
   web-delivery role is fully gone; the kernel/`targetWebView`/WebKit-for-delivery story is closed. (`Bridge.Outcome`
   stays — it's the native module-to-module call result, never web delivery.)

   **Shipped** in PR #796, engine-cleanup only (no extraction), device-gated with the rest
   (checks #1–5 above — the correlated promise path, invisible to lint/balance).
