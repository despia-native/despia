# Web-surface policy — the bare `<WebView/>`, the bridged `<DSXWebView/>`, and the origin gate

> Status: **COMPLETE & SHIPPABLE (2026-07-07) — compile-pending on CI is the only unverified
> step (no local Swift compiler).**
>
> **Shipped-defaults correction (2026-07-25).** This banner previously read "the shipped `full`
> config is behavior-identical to the pre-#982 single-bridge app, so v4 ships on the neutral
> defaults without §13". **That was wrong.** The code ships the RESTRICTIVE, least-privilege pair —
> `bridge_policy: "app"` + `bridge_subdomains: false` — in
> `ClosedSource/DSX/Modules/Core/Dom/config.json`, mirrored into the generated
> `ModuleConfig.generated.swift` / `ModuleConfig.generated.kt`; an unknown or missing value also
> resolves to `app` (fail-closed). The default build is therefore **not** behavior-identical to
> pre-#982: a page on an undeclared origin — including an undeclared `www.` or `sub.` host — renders
> but gets an inert bridge. Consequently **device-acceptance.md §13.2 / §13.3 / §13.4 / §13.4b are
> on the default ship path and must be run before shipping**; `full` and `none` are the opt-outs.
> See §13's corrected ship-gate note and `ClosedSource/Documentation/web-surface-acceptance-runbook.md`.
>
> Two adversarial code
> reviews ran over the series; every correctness finding from both is fixed in-tree, and the
> remaining efficiency/altitude notes are **accepted design decisions** (recorded inline below and
> in §5/§7), not open work. The pieces: `DomBridgeGate` + `DomBridgeKit` + `DomSurfaces`
> (Core/Dom), the `<WebView/>` component (Core/Dom/Components/Views/WebView), the
> surface-tagged relay (WebDelegate) + consumer guards, `bridge_policy`/`bridge_origins`/
> `bridge_subdomains` (Dom config, ships `app`/`false` = least privilege). The only true remaining
> item is optional: `bridge_*` exposure in the dashboard config UI (a frontend task, no runtime
> change).
> — Design history: v1 proposed one component
> (`<DSXWebView/>`) with named instances and a `bridge=` *flag*. v2 supersedes it with a **layered
> model**: a bare `<WebView/>` **primitive** that has no bridge *by construction*, and `<DSXWebView/>`
> as the **composition** that builds a web surface *plus* the despia bridge and the kernel
> lifecycle wiring. The origin **gate** survives from v1 with its scope narrowed to the one
> surface that actually has a bridge. Why the layering is stronger, and the two constraints it
> must respect, are §2. Judged against the constitution in §8. Companions:
> [`security.md`](../../Skills/security.md) (the trust model this makes real),
> [`dsx-native-bus.md`](dsx-native-bus.md), `ClosedSource/Documentation/webview-dissolution.md`.

---

## 0. The idea in one picture

```
   LAYER 0 — the primitive                 LAYER 1 — the composition
   ─────────────────────────               ─────────────────────────────────────
   <WebView name="checkout"                <DSXWebView/>   =   WebView construction
            src="https://pay.x.com/42"                   + BridgeKit (runtime.js,
            on:finish="…"                                   window.virtual, the
            on:message="…"/>                                message shell)
                                                          + kernel lifecycle wiring
   a web canvas. events in,                                (hydrations, ready,
   injections out. NO bridge —                              domStart…, web.startURL,
   not denied: ABSENT.                                      "web" shared handle)
                                                             │
                                                    ┌────────▼─────────┐
                                                    │   DomBridgeGate   │  pages still
                                                    │  (origin → speak?)│  navigate; the
                                                    └───────────────────┘  gate covers that
```

**Two different questions, two different mechanisms:**

|  | Question | Mechanism |
|---|---|---|
| **Surfaces** | which web views have a bridge at all? | **composition** — you either mounted `<DSXWebView/>` or you didn't. No flag, no policy, nothing to misconfigure. |
| **Pages** | which pages *on the bridged surface* may use it? | **the gate** — the bridged surface navigates (links, redirects, OAuth), so its bridge is origin-anchored at the message shell. |

Composition decides *presence*; the gate decides *audience*. Both are needed; neither substitutes
for the other.

---

## 1. The gap this closes (unchanged from v1 — be honest about today)

`security.md` states the law: *"the defense sits at the only honest place — load time: web views
open only against the app's configured hosts/sources. Gate the door."* The web **transport** has
no such door today:

| Hole | Where | Consequence |
|---|---|---|
| `window.virtual` is injected `forMainFrameOnly: false` | `DomWebHost.viewDidLoad` | **every iframe** (an ad, an embed) gets the bridge transport |
| `WebMessageShell` forwards **any** frame's message — no `frameInfo.securityOrigin` check | `DomWebBridge.swift` | a third-party iframe can drive `dsx.handle` today (CLOSED: cross-origin frames are denied under every policy; same-origin frames are admitted deliberately — see §5 Ingress) |
| A main-frame navigation to a **foreign URL** (external link kept in-app, `dom.load({url})`) | relay allows by default | the foreign page gets full `window.dsx` — every module verb the build ships |
| Kernel egress (`resolve`/`broadcast` → `despia.__proxy`) delivers into **whatever page is current** | Dom's messenger mount | replies/broadcasts can leak into a page the app never vouched for |

---

## 2. Why layering beats a flag — and the two constraints it must respect

**The upgrade.** v1's `bridge="none"` was capability-by-*policy*: the bridge exists everywhere
and a gate says no. The layered model is capability-by-*construction*: the primitive has no
message handler, no injected transport, no runtime.js — there is nothing to deny, nothing to
bypass, no default to get wrong. This is Article 3's own philosophy — *"file-presence is the
gate, never `#if`"* — applied to the bridge itself: **component-presence is the gate, never a
flag.** It is the strongest form of the guarantee this design can make.

**Constraint 1 — composition happens at CONSTRUCTION, not at runtime.** A
`WKWebViewConfiguration` is immutable once its web view exists: user scripts, message handlers,
scheme handlers, app-bound domains all must be installed *before* creation. So `<DSXWebView/>` cannot
"attach a bridge to" a live `<WebView/>` — it **parameterizes the primitive's construction**
(bare surface + the BridgeKit configurator, sealed together). The good news: `DomWebHost` already
performs exactly this sequence as discrete steps (`viewDidLoad`: config → configurator fan-out →
virtual + shell + runtime.js → `DomWebSetup.install`); the refactor is an **extraction** of what
exists, not an invention — DomWebHost's boot sequence stays byte-identical as the composed result.

**Constraint 2 — layering does not retire the gate.** The bridged surface is the one that
*navigates*: external links kept in-app, server redirects, OAuth bounces, `dom.load`. Its bridge
therefore still needs the origin anchor (§5). What the layering buys the gate is **scope**: v1
policed every surface; v2 polices exactly one.

**The discipline that keeps it strong:** the primitive stays bridge-less *forever*. There is
never a "just add despia to my WebView" attribute — that would be the flag again, around the
gate. If a future surface genuinely needs a scoped bridge (the mini-app case, §7), it arrives as
its **own wrapper composition** whose messenger mount goes *through* the gate, never as an
attribute of the primitive.

---

## 3. Layer 0 — `<WebView/>`, the bare primitive (Dom-owned)

A self-contained web canvas: **events in, injections out, no bridge.** The shape every mobile
developer already knows — React Native's `<WebView onMessage injectJavaScript>`, the iframe
`postMessage` model — native edition.

```xml
<WebView name="checkout"
         src="https://pay.example.com/checkout/42"
         ephemeral="false"
         on:start="…" on:finish="…" on:fail="…"
         on:message="dsx.variable.payload = dsx.event.data"/>
```

| Attribute | Meaning |
|---|---|
| `name` | the shared handle it publishes (`dsx.shared`) — Dom verbs reach it via `target:` (`despia.dom.reload({target:"checkout"})` — the contract Dom already documents) |
| `src` | full URL (or `origin`+`path`, the existing pair) |
| `ephemeral` | `true` → non-persistent `WKWebsiteDataStore` (auth flows that must not touch the app session). Default `false` (normal per-domain cookie scoping) |

**Lifetime:** node-owned — created on mount, torn down on unmount (each WKWebView is a whole web
process; discipline here is memory, not just hygiene). `<DSXWebView/>`'s app surface remains the one
app-long exception.

**The generic channel (what "self-contained" means):**
- **Page → markup:** a tiny neutral shim (`window.app.send(payload)` — *not* the despia
  namespace) posts to a channel handler that raises `on:message` with `dsx.event.data`. Strings/
  JSON in, nothing else: the page holds **zero** native capability. What happens next is decided
  by the markup handler — and markup is bundled, source-anchored, trusted (security.md tier 1).
- **Markup → page:** the existing Dom verbs, targeted — `dsx.module.dom.eval({target:"checkout",
  js:…})`, `.call`, `.set`. App-authored injection into a surface the app mounted: allowed by the
  trust model, no gate needed.

This is the **protocol construction kit**: a partner embed, a payment page, a docs viewer, a
mini-app shell — each is markup + `on:message` + `eval`, a custom protocol built per use case,
with the despia bridge never in the picture. (For arbitrary *user browsing*, the answer stays the
Browser package / SFSafariViewController — full Safari, zero anything.)

**WebKit placement:** the component + its bare host live with Dom (Article 9's exempt set gains
`<WebView/>`, one line). The relay (`DSXWebDelegate`) stays the single delegate for all surfaces;
every relayed payload gains `surface` so hooks, broadcasts, and node events filter cleanly.

---

## 4. Layer 1 — `<DSXWebView/>`, the bridged composition (contract unchanged)

`<DSXWebView/>` keeps its exact contract — THE app surface, singleton, persistent, handle `"web"` —
and gains a precise definition:

```
<DSXWebView/>  =  WebView construction
            + BridgeKit            (window.virtual all-frames transport, the ONE message
                                    shell, runtime.js/window.dsx, identity globals)
            + kernel wiring        (hydrations + ready fan-out, domStart/Commit/Finish/Fail,
                                    web.startURL claim, custom.js/css, messenger mount "web",
                                    module scripts + scheme responders via DomWebSetup)
```

Nothing behavioral changes for the fleet: the composed result is today's DomWebHost. What changes
is that the bridge becomes a *named, extractable thing* (BridgeKit) that exists in exactly one
composition — which is what makes §3's primitive honest and §7's future wrappers possible.

---

## 5. The origin gate (v1's Piece A, scope narrowed to the one bridged surface)

Unchanged in mechanism, smaller in scope. The bridged surface's pages change under it, so the
bridge follows **where the current page was loaded from** — trust stays source-anchored:

- **App origins (derived, never a second config):** App.json host + hosts + Dom `webview_url`
  base + the exact current ContentServer loopback + signed-bundle `file:`/module schemes + dev-origin override (non-prod) +
  Dom config `bridge_origins` (optional additive per-app allowlist). The static pieces are cached
  once in `DomBridgeGate.Config`; only `AppManifest.appHost` is read live (it follows the dev-origin
  switch + dynamic host source).
  > **Perf note (accepted):** the static app-origin list is cached; `AppManifest.appHost` is read
  > live. Under the shipped `full` policy the gate short-circuits BEFORE `isAppOrigin`, so `appHost`
  > is **never** read — zero cost for the default fleet config. Only an app that opts into `app`
  > pays a per-message locale read (and, with RemoteHosts, a dict rebuild). Memoizing `appHost`
  > would be a security-path cache that must invalidate on BOTH `dev.originChanged` AND a
  > mid-session RemoteHosts refresh (RemoteHosts.swift applies a landed fetch to later navigations),
  > so it is a separate scoped change gated on real profiling — not a correctness gap here.
- **Policy** (Dom config `bridge_policy`, applies to `<DSXWebView/>` only): `app` (bridge for app
  origins — the secure shipped default) · `full` (everywhere — explicit legacy compatibility) ·
  `none` (every page-to-native bridge, including legacy module-scheme dispatch, off). A key
  consequence: **hydration follows the bridge** — a page that gets no bridge gets no
  native identity injection (OneSignal/Pushwoosh/AppsFlyer ids + ATT ride the same egress), so
  under `app` a foreign/subdomain page and under `none` every page commits without them.
  Native OS handoff is a separate navigation decision and requires an exact trusted main-frame
  source plus a genuine user gesture.
- **Subdomain trust** (Dom config `bridge_subdomains`, under `app`): `false` (default). With `true`, a
  subdomain of an app host (`blog.example.com` under `example.com`) inherits the bridge, matching
  the app's same-site rule (SPA-safe: `example.com` + `account.example.com` auth both bridge).
  `false` — **exact origin only**: only the configured host(s) bridge; every subdomain is
  render-only unless in `bridge_origins`. **`www.example.com` is never silently aliased** — under
  `false` it is bridge-less exactly like any other subdomain, and under `true` it bridges exactly
  like any other subdomain. (The gate uses its OWN normalizer — `DomBridgeGate.normalizedHost` +
  `DSXWebViewOriginPolicy.matchesBareHTTPSHost` on iOS, `DomBridgeGate.normalizeHost` +
  `matchesAppSite` on Android — which lowercases and drops a trailing dot but never strips a
  leading `www.`. It does **not** call the kernel's `AppManifest.isExactHost`, whose own doc comment
  still claims otherwise and which *does* alias `www`. Pinned by
  `DomBridgeSecurityTest.bareHostsAreHttps443OnlyWithNoImplicitWwwAlias`.)
  This is a **bridge-trust** choice and it leaves
  `isHost` (navigation, external-link routing, auth-return, cookie same-site) untouched — a
  subdomain, `www.` included, still loads in-app, it just gets no `window.dsx`. Set `false` when subdomains host
  untrusted content (CMS, UGC, marketing, help center): *render is cheap, bridge is privilege.*
- **Ingress:** `WebMessageShell` pairs the sending frame's attributed security origin with the
  current main-frame URL → forward or drop
  (+ `dsx.delegate.send("web.bridgeDenied", {surface, origin}, combine: .void)`). Under `app`,
  this closes the
  iframe hole — a FOREIGN iframe's messages die at the shell even while the main frame is an
  app page.
  A **same-origin** sub-frame is admitted (revised 2026-08; it was `isMainFrame`-only before).
  Such a frame is the same trust domain as the page that embedded it: it can already script
  its parent and post through `parent.webkit.messageHandlers`, so denying it bought a
  workaround, not a boundary — while breaking the real case, an auth widget hosted in the
  app's own iframe (Sign in with Apple). The frame rule holds under **every** policy, `full`
  included: cross-origin sub-frames never speak.
  Sub-frames are judged by a STRICTER matcher than the main frame (`subFrameIsSameOrigin`).
  The main-frame path forgives an empty/`"null"` origin on a `file:` document, because that is
  how Chromium reports a bundled asset page's own source; `"null"` is also how an OPAQUE origin
  spells itself, so extending that forgiveness downward would hand the bridge to a sandboxed
  iframe the page deliberately isolated. On iOS the two rules are mutually exclusive under
  `file:`, so no sub-frame of a bundled page ever bridges. Pinned by
  `DomBridgeSecurityTest.crossOriginIframeIsDeniedUnderEveryPolicyButSameOriginIsAdmitted` and
  `.opaqueSubFrameOfABundledAssetPageIsNeverAdmitted`.
- **Egress:** the **automatic** delivery paths are gated — the messenger mount + the `proxy`
  action + the per-commit **hydration** run (which delivers identity globals via `dom.set`) — each
  checks the surface's current main-frame origin before delivering, so a denied page never
  receives resolves, broadcasts, hydrated identity, or module-authored page writes. The
  `eval`/`call`/`set`/`css`/`inject` escape hatches use the same current-page gate.
  > **Design note (accepted):** the automatic paths gate at each site (mount, proxy, hydrations),
  > which is correct and complete today. A single Dom-owned `deliver(js:to:)` chokepoint that every
  > automatic egress funnels through would make it impossible to forget the check when a NEW
  > automatic path is added — worth adopting the next time an automatic egress path is introduced,
  > not a refactor to force now (each current site is gated).
- **Rollout posture:** ships as `app`; `full` is an explicit, reviewed compatibility exception.

What the gate is NOT (unchanged): not a per-call capability allowlist (security.md calls that
theater — in = full bridge, out = none), and not navigation policy (`web.decidePolicy` stays the
module claim it is).

## 6. Events on the nodes (both layers, standard `on:` grammar)

| Event | `<WebView/>` | `<DSXWebView/>` | Handler scope (`dsx.event.*`) |
|---|---|---|---|
| `on:start` / `on:commit` / `on:finish` | ✓ | ✓ | `url`, `surface` |
| `on:fail` | ✓ | ✓ | `url`, `surface`, `error`, `code` |
| `on:message` | ✓ (the generic channel) | — (the bridge is the channel) | `data`, `surface` |
| `on:denied` | — (nothing to deny) | ✓ (gate drops) | `origin`, `url`, `surface` |

Mechanics: the relay already fires `domStart/Commit/Finish/Fail`; surface-tagged, the nodes
subscribe to their own name and `env.run` the matching `on:` action — the grammar every element
uses (`attrs["on:…"]`).

## 7. Deliberately NOT in v1 — and the future the layering unlocks

- **No `bridge=` attribute on `<WebView/>`, ever** (§2's discipline). The primitive is pure.
- **`on:navigate` as a cancelable decision** — DSX handlers are actions, not sync predicates;
  navigation policy stays `web.decidePolicy`. If markup ever needs it: a declarative attribute.
- **Mini-apps with a *scoped* bridge** (a third-party mini-app that may call *some* modules):
  that is a new **trust tier**, not a flag — a future `<MiniApp/>` wrapper composing the
  primitive + its own scoped messenger mount, routed **through** the gate with its own origin +
  capability contract. The layered model gives it a home without touching BridgeKit or the
  primitive; nothing in v1/v2 needs rework to add it later. The WEB tier of this idea now has
  its own proposal — the `studio` residence (`proposals/studio-apps.md` §5: a scoped module
  funnel handed to a mounted third-party DSX subtree); when `<MiniApp/>` lands, it is the
  native twin of that seam list, not a second design.

**Accepted-design notes (not open work — the code is correct as-is; these are decisions):**
- **Node-event sinks stay a Dom-owned registry** (`DomSurfaces.setNodeSink`/`clearNodeSink` +
  owner token), driven by each surface component's Coordinator. A first-class *engine* primitive
  ("a component declares it consumes surface X's events, the engine owns the registry + teardown")
  is the deeper form and the right move WHEN a third web-surface composition (`<MiniApp/>`) lands —
  the two current consumers (`<DSXWebView/>`, `<WebView/>`) are correct and adopting an engine primitive
  now would be speculative generality.
- **The three gate methods stay explicit** (`allowsIngress`/`allowsEgress`/`allowsSchemeDispatch`).
  Their policy switches genuinely differ (for example `full` preserves legacy dispatch while
  `none` denies all page dispatch) — three short, self-evident switches read better than one `verdict(default:)`
  primitive that would encode the differences as parameters.

## 8. Constitution check, article by article

| Article | Verdict |
|---|---|
| **1 — kernel names nobody** | Kernel untouched. Primitive, BridgeKit, gate, events: all Dom/DSXWebView-owned. `VirtualBridge` (Engine) still knows no WebKit — the Dom-owned shell filters before `receive`. |
| **2 — everything is a module** | Both components are the Dom capability's surfaces. No new module, no shim. |
| **3 — presence is the gate, never a flag** | **The design now IS this article**: the bridge exists where the composition is mounted, not where a flag says yes. The only flag left (`bridge_policy`) governs the one navigating surface, where presence alone cannot answer. |
| **4 — every value is module config** | `bridge_policy`, `bridge_origins` in Dom's `config.json`. |
| **5 — App.json on faith** | appOrigins derive from App.json + existing config — no second identity source. |
| **7 — fail-open is law** | A denied page degrades (inert bridge), never blanks; explicit `full` remains available for reviewed legacy compatibility. |
| **8 — the contract is names** | `web.bridgeDenied`, `surface`, `on:message` are platform-free. Android: the primitive ↔ Android `WebView` + `WebMessageListener`; BridgeKit ↔ `addJavascriptInterface` on the one composed surface; the gate ↔ `allowedOriginRules` (native origin scoping — the gate is a *parameter* there). |
| **9 — WebKit only in Dom** | Every new WebKit line sits in `Core/Dom` + its two components. Exempt set gains `<WebView/>`; `check_module_rules` keeps enforcing. |

## 9. Rollout

- **Phase 1 — the gate** ✅ (ingress + egress + `web.bridgeDenied` + config): ships ENFORCING —
  the `app` policy is the default, so the gate is live on every default build (it is NOT
  behavior-neutral); DevSettings logs denials, which is what a staging soak reads.
- **Phase 2 — the extraction** ✅ (BridgeKit out of DomWebHost; DSXWebView = bare construction +
  BridgeKit; boot sequence byte-identical, verified against device-acceptance §1).
- **Phase 3 — the primitive** ✅ (`<WebView/>`: `name`/`src`/`ephemeral`, node-owned lifetime,
  generic channel, surface-tagged relay + node events on both components).
- **Phase 4 — dashboard exposure** (the ONE remaining item, optional & frontend-only):
  `bridge_policy`/`bridge_origins`/`bridge_subdomains` in the config UI — rides the Step-1
  config-schema dashboard work (NEXT.md), no runtime change.

Phases 1–3 are complete in-tree and hardened by two adversarial code reviews (all correctness
findings fixed). The runtime ships on the `app`/`false` defaults, which means **the gate is
enforcing on every default build** — a defaults ship therefore owes both a Codemagic compile (no
local Swift compiler) AND the `app`-policy rows of device-acceptance §13 (13.2 / 13.3 / 13.4 /
13.4b). §13's OPT-IN rows are the reverse move: 13.1 for an app that loosens to `full`, and the
`none` lockdown. See §13's corrected ship-gate note.

Device-acceptance additions when implemented: foreign-page bridge inertness on `<DSXWebView/>` (main
frame + iframe, under `app`) · `bridge_origins` allow · `<WebView/>` has no `window.dsx` and
no `window.virtual` at all · `on:message` round-trip · teardown leaks (no zombie web processes) ·
`ephemeral` session isolation.
