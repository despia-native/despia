# DSX Kernel — Architecture & Build Plan

> **The whole idea in one line:**
> **One manifest. One graph. One resolver. One set of registries. Many renderers.
> Everything is a node — the kernel never grows; capability is always a node.**
>
> That property is what makes DSX self-hosting ("Despia built in Despia"),
> non-redundant, and as future-proof as a platform gets: an app is just a *graph
> of nodes + a route table*, and the runtime is just a *renderer* over generated
> registries. New capability = a node. New surface (widget/watch) = a target node.
> New platform (Android) = a second renderer over the same graph.

This document is the contract every module, component, route, target and
renderer is built against. Review it section by section.

---

## 1. Kernel vs. Node (the only boundary that matters)

**Kernel** (small, stable, the *only* "hardcoded" code):

1. **The node contract** — `dsx.json` (one schema for every node).
2. **The resolver** — `DSXGraph` (discover → type → edges → cycles → reachable → dedupe).
3. **The registries** — generated from the graph (tags, schemes, actions, config, routes, native deps, state providers).
4. **The runtime** — the renderer: engine (tag→view), dispatch (scheme/action + visibility), state (`global.*`), router (`App.dsx`→node). **It never knows node *kinds*** — it only consumes registries. That is what lets a second renderer (Android) drop in.

**Node** — *literally everything else*: every module, component, target, the app
shell, even `DSXWebView` (the WebView). If it is not in the four kernel pieces above,
it is a node.

**The law that keeps it future-proof:** never add to the kernel to add a feature.
Add a node (data + an optional generator). If a change requires editing the
runtime to know about a specific capability, the design is wrong.

---

## 2. Canonical vocabulary (kills today's redundancy)

The system today mixes `Plugin` / `Package` / `Stack` / `Despia` for the same
ideas. This is the **one** naming set going forward. Renames ride along with the
phase that already touches that file (never a churn-only pass).

| Concept | Canonical name | Replaces / removes |
|---|---|---|
| Node manifest file | **`dsx.json`** | `manifest.json` |
| Node types | **`package` · `component` · `target`** | "plugin"; `mandatory`→a flag; "shell"→not a node |
| Dependency edge (manifest key) | **`dependencies`** | internal synonyms `requires` / `rescued` |
| Resolver module | **`DSXGraph`** | `package_requires.rb` + 3 duplicate discovery/rescue copies |
| Native deps block | **`native: { pods, spm, infoPlist, entitlements, capabilities }`** | scattered top-level keys |
| Visibility surface | **`exposes: { public, internal, tag, config, provides }`** | *(new)* |
| Generated registries | **`DSXSchemes` · `DSXComponents` · `DSXConfig` · `DSXRoutes` · `DSXActions`** | `ModuleSchemes` / `StackComponents` / `ModuleConfig` / `GeneratedPaywalls` |
| Runtime registry (web) | **`DSXPackages.json`** → `window.despia.runtime.packages` (the wire contract; the modern read is `window.dsx.packages`) | `DespiaPackages.json` |
| App-global state | **`DSXState`** (singleton) · namespace **`global.*`** · accessor **`dsx.global`** | ad-hoc `window.*` vars; per-module hydration store (folded in over time) |
| Route state | **`global.route.path` · `global.route.params`** | `__route`; a separate navigate API/scheme |
| Web state bridge | **`state://get|set|watch`** + **`window.dsx.global.*`** | a bespoke `navigate://` scheme |
| Out-of-band events | **`dsx.broadcast`** → **`dsx.events.on("scheme")`** (`DSXEventBus`) · web mirror `window.dsx.on` | *(new — the native side of a broadcast)* |
| WebView node | **`DSXWebView`** | the root WebView ("the app") |
| Shell document | **`App.dsx`** (the root route table) | — |
| Gating list | **`excluded.json`** (unchanged) | — |
| Tiers / engine | `DSX/Modules/{Core,Custom,Mandatory}` (components live in the mandatory `Foundation` module), `OpenSource/Engine` | flat `Packages/` + root `OpenSource/` + the separate `DSX/Components` tree |

**Reserved expression namespaces** (the resolver's `lookup`): `os` · `item` ·
`attribute` · **`global`** · **`route`** (a view into `global.route`). Bare names =
surface-local state. Nothing else is reserved.

---

## 3. The node contract — `dsx.json`

One schema for a `package`, `component`, or `target`. Every key is optional; a
node declares only the surface it actually has. `type` is inferred from the tier
(`Components/*` → component) unless overridden.

```jsonc
{
  "name": "Store",                 // identity (folder name by default)
  "type": "package",               // package | component | target  (inferred if omitted)
  "scheme": "store",               // package: its public route prefix  →  store://action
  "tag": "PaywallCard",            // component: its XML tag            →  <PaywallCard/>
  "aliases": ["shop"],

  "dependencies": ["store-core", "PaywallCard"],   // edges — type-agnostic (pkg↔component↔target)

  "native": {                      // merged + deduped ONCE across the whole graph
    "pods": [{ "name": "StripePaymentSheet", "version": "~> 23.0" }],
    "spm":  [],
    "infoPlist":   { "NSCameraUsageDescription": "…" },
    "entitlements":{ "com.apple.developer.healthkit": true },
    "capabilities":["HEALTHKIT"]
  },

  "exposes": {                     // the visibility surface
    "public":   ["paywall", "restore"],          // web-callable ACTIONS (async/effectful)
    "internal": ["mintReceipt"],                 // native-only actions; bridge REJECTS from web
    "formulas": ["discount", "formatPrice"],     // pure, SYNC functions usable in {{ }} expressions
    "tag":      "PaywallCard",                    // component surface to the graph
    "config":   true,                             // ships a typed config (dsx.json sibling: config.json)
    "provides": { "session": "auth://session" }   // global-state keys this node owns
  },

  "target":   { "kind": "widget", "sources": "Widget" },  // target nodes only
  "mandatory": false,              // true → always a graph root (ships regardless of gating)
  "platforms": ["ios", "android"]  // renderers this node supports
}
```

**Units — formula vs. action (the two kinds of callable).** The line is *purity*,
not return count:
- **Formula** — pure, synchronous, returns **one value**. In `exposes.formulas`,
  registered into the expression engine, usable in any node's `{{ }}` / `visible-if`
  (`{{ discount(price, 0.2) }}`). **No I/O, no awaiting** — that is what makes it safe
  to run on every render. Built-ins (`upper`, `round`, …) are kernel-global; custom
  formula libraries are nodes you `depends_on` (same Core-global-vs-depend rule as
  components). A shared function needs **no new folder** — it is a node that exposes it.
- **Action** — effectful / async. In `exposes.public|internal`, invoked by
  `window.dsx.module.scheme.action()` (web) or `dsx.module.scheme.action()` (native). Its result shape is
  orthogonal: **resolve-once · stream (many `dsx.event`s) · fire-and-forget** — all
  already in the despia transport. "Returns multiple events" is a *streaming action*,
  not a new concept. An async one-shot fetch is still an action, not a formula.

**Migration (COMPLETE):** `dsx.json` is the only name — the `manifest.json`
alias was retired after the mechanical rename (check_module_rules errors). The
`native:` nesting is the one schema change with churn (~40 files) — **decision
D2** below.

---

## 4. The kernel contracts

### 4.1 Resolver — `DSXGraph` (Ruby, build-time)
Single source of truth, consumed by every generator. Replaces the three copies
of discovery + rescue (`prepare_modules.rb`, `prepare_config.rb` `RESCUED_RELS`,
`generate_package_registry.rb`).

```
nodes      = discover()                 # 4 tiers → typed nodes {rel, type, ids, deps, manifest}
graph      = edges(nodes)               # dependencies, type-agnostic
cycles!(graph)                          # DFS + recursion stack → abort with the cycle path
roots      = App.dsx tags + mandatory + enabled(¬excluded)
shipped    = closure(graph, roots)      # reachable set
native     = dedupe(shipped.native)     # pods/spm/plist/entitlements, once
```

### 4.2 Registries (generated from `shipped`)
`DSXSchemes` (class→scheme) · `DSXComponents` (tag→template/native) ·
`DSXConfig` (typed config) · `DSXRoutes` (App.dsx) · `DSXActions`
(public vs internal) · `DSXPackages.json` (web feature-detection).

### 4.3 Runtime (the renderer)
`engine` (tag→`AnyView`) · **JSE** (the expression & logic engine that evaluates every
`{{ }}` / `visible-if` / `on:*` body — see [`jse.md`](jse.md)) · `dispatch`
(`scheme://action`, checks `DSXActions` visibility) · `DSXState` (`global.*`, reactive) ·
`router` (`App.dsx` → `global.route.path` → node). Knows registries, not node kinds.

### 4.4 Renderer contract (future: Android)
A renderer consumes the *same* registries + `dsx.json` (already platform-neutral;
see `OpenSource/Skills/android/`). Not a build item now — but the kernel is
shaped so it never becomes one.

---

## 5. Everything-is-a-node

| Thing | Node that exposes… |
|---|---|
| Module | `scheme` + `public`/`internal` actions (+ config, components, targets) |
| Component | `tag` (XML template or native `GlobalStackComponent`) (+ config, deps) |
| App shell | `App.dsx` — the root route table (references node tags); **not itself a node** |
| `DSXWebView` (WebView) | a `tag` whose body hosts the composed app `WKWebView` directly, via the Dom module (`WebViewController` no longer exists) |
| Target (widget/watch/keyboard/extension) | `target.kind` + sources + deps |
| Global-state source | `provides` keys (reactive `global.*`) |

There is no privileged "app." **An app = a graph + an `App.dsx`.** DSX's own
surfaces (catalog, inspector, dev tools) are nodes too. That is the self-hosting.

### 5.1 Folders stay — the graph is *computed from* them (it never flattens)

A node **is** a folder with a `dsx.json`. The folder tree is the source of truth
for humans (browse, group, encapsulate); the graph is a *computed view* for the
build (resolve, dedupe, ship). Neither flattens the other — `dependencies` are
declarations that cross folders, never a physical move.

```
DSX/
  Engine/OpenSource/             # kernel runtime — NOT a node
  Packages/
    Core/
      Auth/                      # grouping folder — NOT a node (organization only)
        AppleAuth/   dsx.json    # node
        OAuth/       dsx.json    # node
      Payments/Stripe/ dsx.json  # node (nested to any depth)
      Store/         dsx.json    # node — owns everything inside it:
        Components/  …           #   its module-local components
        Paywalls/    …           #   its paywall definitions
        config.json  …           #   its typed config
    Custom/
      VerticalPlayerStack/ dsx.json
  Components/
    Core/
      Card.dsx                   # flat global component (always-on)
      PaywallCard/ dsx.json      # folder component — node (native deps, config)
    Custom/                      # per-app globals (copied in by CI)
  App.dsx                        # the shell / route table — references node tags
```

What keeps it from becoming a mess (all already enforced today):
- **Tiers** (`Core`/`Custom`) split framework vs per-app.
- **Grouping folders** (`Auth/`, `Payments/`, `Basics/`, `WebPlatform/`) nest to
  any depth; a folder with no `dsx.json`/Swift is *organization only*.
- **Encapsulation:** a node owns everything inside its folder (manifest, config,
  sources, local components/paywalls). Nothing scatters.
- **The graph moves nothing:** an edge `Core/PaywallKit → Core/Store` (a module's
  manifest `dependencies`) is metadata; both folders stay exactly where they are.

---

## 6. State layers (do **not** make everything global)

| Layer | Lives in | Reach |
|---|---|---|
| **Global** (auth, entitlements, credits, theme, route, flags) | `DSXState` singleton (`global.*`) | every node + web + targets |
| **Surface** (drawer open, tab, form values) | the surface's `StackStore` (`dsx.variable.*`) | one screen |
| **Component** (drag offset, gesture) | SwiftUI `@State` | one view |
| **Web** (React/Vue/Svelte UI) | the web framework | one `DSXWebView` |

**The route is just global state.** Navigation is a state write
(`global.set("route.path", "/native")`) from native or
`window.dsx.global.set("route.path","/native")` from web — **no separate
navigation subsystem.** The router reacts to `global.route.path`.

### 6.1 The four sharing primitives (distinct, non-overlapping)

State *layers* are about scope; this is about *what kind of thing* you share. Four
mechanisms, one job each — never reach for the wrong one:

| Primitive | Holds | Lifetime / scope |
|---|---|---|
| `dsx.global` (DSXState) | reactive **serializable data** (syncs to web) | app, in-process |
| **`dsx.shared`** | **live in-process object handles** (a webview, a player, a DB client) — not serializable | app, in-process |
| `dsx.container` | **persistent** key-value + files | survives relaunch, cross-process (extensions) |
| `dsx.module` | cross-module **actions** (RPC) | per call |

**`dsx.shared` is the Context-Provider primitive:** one node `provide`s a handle
under a string key, any node `use`s it (and may `on`-observe re-publishes). The live
web surface is published under `"web"` on **every boot path** — DSXWebView provides it on
the DSX-first path, and `ModuleRegistry.runHydrations/runReady` publish it for any
host, so the legacy `WebViewController` root is covered too. But WebKit is confined to
the **Dom module** (`DSX/Modules/Core/Dom`) and its DSXWebView component: the `"web"`
handle is Dom's to hold, and every **other** module reaches the web surface through
`dsx.module.dom.{inject,eval,load,reload,call,set,css,…}` — never by importing WebKit
or pulling a `WKWebView` of its own. The engine **never special-cases a
handle**; the registry is general and identical for every module. Untyped by contract
(`use → Any?`, cast) so it mirrors 1:1 on Kotlin/Java (no reified generics); handles
are held weakly, so an unmounted provider auto-prunes.

### 6.2 Outputs: how a module's results reach its consumers

The four primitives above share *state*; this is the other half — how a module's
**outputs** get delivered. A module emits by **kind**, and the kind decides routing.
The module never names its consumer:

| Output | Kind | Routes to | Native surface | Web surface |
|---|---|---|---|---|
| `dsx.resolve` / `dsx.error` | terminal answer (1:1) | **whoever called** | the `dsx.module` continuation (`onTerminal`) | the awaiting `despia(...)` promise |
| `dsx.event(name,…)` | stream for this call (1:1) | **whoever called** | the caller's stream handler¹ | the call's `handler` |
| `dsx.broadcast(name,…)` | out-of-band (1:many) | **every subscriber, by scheme** | `dsx.events.on("<scheme>")` | `window.dsx.on("<scheme>")` |

**The point (and the gap we closed):** `resolve`/`error` route back to the caller
*automatically* — the engine remembers who called (a native `dsx.module` continuation or
a web bridge id), so the WebView no longer needs to be the root for a result to find
its way home. `broadcast` has *no* caller, so it fans out by **scheme**: web via
`window.dsx.on`, **native in-process via `dsx.events.on`** (the `DSXEventBus`), and a
separate-process target via `dsx.container.observe`. A native screen subscribes by
scheme **without knowing which events exist** — exactly as the web does — so native
routes/components are first-class event consumers, not second-class. `dsx.events` sits
next to `dsx.global` / `dsx.shared` and is identical on a module context and a
component context (a native screen subscribes the same way a module does); it is
distinct from a component's *local* `dsx.on`/`dsx.event` (this component ↔ its
consumer). `dsx.events.on` returns a handle; `cancel()` it in the surface's lifecycle.
Same shape on Kotlin/Java (`on(scheme){ }` / `cancel()`, untyped payload).

¹ **Designed-for, not built:** a *native* `dsx.module` caller today receives only the
terminal `resolve`/`error` (its continuation), not the intermediate `dsx.event`
stream — those still emit to the web by `requestID`. No current cross-module call
streams (they `resolve` once), and the web stream path is unaffected. When a native
streaming consumer is actually needed, add it as `dsx.module`'s streaming form (an
`AsyncStream` / callback) so `dsx.event` routes to the native caller, mirroring how
`resolve`/`error` already check `onTerminal`. Until then, broadcast (`dsx.events.on`)
covers the "native screen receives events" case.

---

## 7. Explicitly OUT of scope (so it stays lean, not over-engineered)

Designed-for, **not built now**:
- `<state source="auth://session"/>` declarative binding — sugar over get/set/watch. *Later.*
- Remote / OTA DSX views — the engine resolves tags uniformly, so they slot in. *Later.*
- Closed-world full module tree-shaking — modules stay opt-out (`excluded.json`) because the web calls schemes dynamically; only **components** tree-shake by reachability. *Closed-world is an opt-in flag, later.*
- Android renderer — north star, not a task. The kernel just must not block it.
- Cross-process targets (widget/watch) reactivity — design the `shared` key flag now (→ App Group + Darwin notify), build it only when the first `target` node lands.

If a phase below grows past its bullet list, it is over-engineered — cut it.

---

## 8. Build phases (dependency-ordered; each ships value + is verifiable)

> Branch off the restructure branch (PR #569) or `v4` once #569 merges. Not main.
> "Verifiable here" = Ruby/codegen/logic on Linux. Swift/SwiftUI/WKWebView runtime
> needs a Codemagic/device build.

### Phase 1 — `DSXGraph` resolver + cycle detection  *(refactor + the safety we lack)*
- Extract one `ClosedSource/scripts/dsx_graph.rb`; `prepare_modules` / `prepare_config` /
  `generate_package_registry` consume it. Kill the 3 duplicate walks and the
  `requires`/`rescued` synonyms (→ `dependencies`).
- Add DFS cycle detection → `abort` with the path (`store → PaywallCard → store`).
- **Verify:** existing codegen byte-identical; a cyclic fixture fails clearly. Low risk.

### Phase 2 — `dsx.json` node contract + visibility  *(the contract)*
- Read `dsx.json`; add `type`, `exposes`, `native:` nesting (**D2**), `mandatory`, `platforms`.
- Split `DSXActions` into public/internal; `VirtualBridge` rejects a web call to an internal action.
- **Verify:** schema validation + a web-call-to-internal rejection test. Low–med risk.

### Phase 3 — Global state  *(`DSXState` + `global.*`)*
- `DSXState.shared` (a `StackStore`); `global.` + `route.` namespaces in `JSE.lookup`; the `global.x = …` write in `JSERunner.run`; `dsx.global` on both dsx types; `StackNodeView` observes `DSXState`.
- `state://get|set|watch` module + `window.dsx.global.*` sugar (rides existing transport); echo-suppression; coalesced emits.
- **Verify:** native `set` → web `watch` receives it and vice-versa; `visible-if="global.session.premium"` toggles. Med risk (loops).

### Phase 4 — `DSXWebView` (WebView as a node)  *(the high-risk audit)*
- `DSXWebView: GlobalStackComponent` → `UIViewControllerRepresentable` wrapping the **existing** `WebViewController` (reuse it; the bridge is webview-agnostic).
- `path` prop; subscribes to its `global.*` keys.
- **Audit:** `WebViewController`'s root assumptions — status bar, safe-area, `present(from: self)`, lifecycle. This is the bulk of the work.
- **Verify:** a surface hosting `<DSXWebView/>` loads the page + bridge works as a child. **High risk** — report audit findings before Phase 6.

### Phase 5 — OTA routing  *(built — supersedes the bundled `App.dsx` idea)*
- **No bundled `App.dsx`.** Opt-in is App.json `entry.ota`; the route table is fetched from
  `server.host` (offline-first), so a route change is a deploy, not a rebuild + review.
  No `entry.ota` ⇒ pure web app (today), no probe.
- `Routing` (Mandatory module, **scheme-less** — the `route` scheme + nav verbs are the
  kernel `Router`'s): on launch loads the cached table, then fetches `entry.ota` → a
  `{ assets:[…] }` manifest → the asset ending in `routes.json` (the table), writes
  `global.routes`, and asks the Router to re-resolve. The Router maintains `global.route`
  from `global.route.path` (a pure state write — observed via Combine). Full spec:
  `OpenSource/Documentation/architecture/app-manifest.md` § App.json `entry`.
- Matcher = `DSXPathMatch` (exact / `{param}` / `:param` / `*` / `/*`), surfaced as the
  `matches()` expression helper; `route.*` resolves as a view into `global.route`.
- Dynamic tag `<node tag="{{ item.view }}"/>` (restricted to shipped tags = the capability
  boundary); the kernel surface `RouterHost` (`OpenSource/Engine/`) is the shell that renders
  the resolved route into a `DSXView`/`DSXWebView` frame.
- **Capability gate:** a route's `requires` must all be in the registry (ModuleRegistry /
  StackComponents); unsatisfiable → falls through to `/*` → `DSXWebView` + a `dsx`
  `route_unavailable` broadcast. Never crashes, never a blank screen.
- **Verify:** host a manifest+routes; `window.dsx.global.set('route.path', '/player/42')` → `DSXView` renders
  the native screen; a missing-capability route → web fallback + broadcast. Med risk.

### Phase 6 — Root inversion  *(built — the flip, flag-gated)*
- `DSXBoot` mounts the kernel surface `RouterHost` (via `UIHostingController`) as the app's one
  universal root.
- `DSXView` (Mandatory component) is the remote NATIVE renderer (twin of `DSXWebView`): fetches
  a screen FOLDER's DSX from `server.host`, registers the screen's remote DSX
  components (binary → remote-cached → miss), renders natively in the host surface.
- Navigation = state: `global.route.path` (web: `window.dsx.global.set('route.path', …)`; `window.despia.navigate` is the legacy alias).
- **Verify:** boots into DSX root; default = today's behavior. **Needs CI/device.** High risk.

### Phase 7 — Later (north-star, not now)
Component reachability tree-shaking · `target` nodes (widget/watch) + the `shared`
state flag · fold module hydrations into the one `global→web` channel · Android
renderer · `<state source=>` binding. (Remote views shipped in Phase 5–6.)

---

## 9. Decisions to ratify

- **D1 — Manifest name:** `dsx.json` (rename, on-brand, one name) **vs** keep `manifest.json` (zero churn). *Recommend `dsx.json`.*
- **D2 — Native block:** nest under `native: {}` (clean, ~40-file migration) **vs** keep flat keys (no churn). *Recommend nest.*
- **D3 — Registry renames:** `Plugin*/Stack*/Package*` → `DSX*` (consistent, churn in Swift refs) **vs** keep current names. *Recommend `DSX*`.*
- **D4 — Inclusion model:** components tree-shake + modules opt-out (**A**, recommended) **vs** full closed-world tree-shake (**B**, opt-in flag).
- **D5 — Start point:** Phase 1 only first (safe, high-leverage) **vs** Phases 1–3 as one foundational block.

Ratify D1–D5 and I'll execute phase by phase, reporting at each phase's verify gate.

---

## 10. Completeness & the start gate

**Is the kernel computationally complete?** Yes — split the question:
- **The system is Turing-complete** via the escape hatch — **actions** run arbitrary
  native code, **`DSXWebView`** runs arbitrary web code. Anything computable is expressible.
- **The declarative layer (formulas / XML / state) is *intentionally* total — NOT
  Turing-complete.** Formulas are pure and terminating; rendering always halts; there
  are no unbounded loops in expressions. That is a feature (no infinite render loops,
  deterministic UI), with actions as the Turing-complete escape — the same shape as
  HTML+JS, JSX+effects, SQL+UDF. A Turing-complete UI language would be a bug.

**The start gate is *closure*, not "100%".** No platform is ever 100% complete; the
achievable bar is:

> The kernel is complete when **every remaining feature can be added as a node or a
> generated registry, WITHOUT editing the kernel.**

By that test it passes — the core operations are closed:

| Need | Covered by |
|---|---|
| data / values | state (global/surface/component/web), JSON, lists |
| pure computation | formulas (total) |
| effects / async | actions (resolve · stream · fire) |
| composition | the graph (`dependencies`) + component nesting |
| control | `visible-if`, conditionals, iteration over data |
| communication | **call** (RPC) · **event** (up) · **state** (shared) · **broadcast** (pub/sub) — the canonical four |
| navigation | router (route = global state) |
| visibility | public/internal + upward events |

**Open semantic contracts** — genuinely not pinned yet, but each lives *outside* the
kernel, so none breaks closure and none gates Phase 1:

1. **Effect/lifecycle primitive** — run-on-mount / on-change / cleanup for components. *Pin before Phase 3.*
2. **Reactive update semantics** — propagation order / glitch-freedom for `global.*`. *Pin before Phase 3.*
3. **Built-in formula stdlib** — math/string/list/date/logic; extensible as nodes. *Pin the built-in set before Phase 5.*
4. **Target-node contract** — widget/watch/keyboard surface. *Pin before Phase 7.*

Each is a node, a registry, or a runtime *contract* — none requires changing the node
model or the resolver. **That is the proof the kernel is closed.**

**What must be 100% before starting:** only the **contract** — the `dsx.json` schema +
the four kernel boundaries — which closes the moment **D1–D5** are ratified. "Start only
when 100% complete" wrongly conflates *the contract is locked* (required) with *every
feature is designed* (never happens, not required). **Phase 1 (the resolver) touches none
of the four open items and can start the instant the contract is ratified.**
