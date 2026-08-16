# Mounting components — `dsx.component.mount`

> Audience: module authors. How native code puts DSX on screen. The one-line summary:
> **UI lives in `.dsx` files; Swift mounts a file and wires facts/events — it never carries
> inline XML.**

```swift
let ui = dsx.component.mount(.Player)        // ⌨️ autocompletes; misspelling = COMPILE error
ui.variable("paused", false)                 // ⇄ dsx.variable.paused
ui.attribute("accent", "#FF2D55")            // ⇄ dsx.attribute.accent
ui.action("track", ["event": "open"])        // ⇄ dsx.action.track()  (dsx.this = payload)
ui.on("close") { self.close() }              // ⇄ dsx.event('close')
ui.onAny { name, payload in … }              // every event, one tap (analytics/relay)
ui.push(from: dsx, path: "/player") { … }    // a PAGE — a native nav frame (the default; see below)
```

---

## A mounted component is NATIVE — it is NOT the web view

This is the rule that, if you forget it, sends you debugging the wrong layer. **A mounted
component renders 100% natively.** `mount` returns a `StackSurface` whose controller is a
`UIHostingController` wrapping `StackRootView` — SwiftUI/UIKit, no `WKWebView` anywhere in it.
The component looks and behaves like any other native screen because it **is** one.

Who *triggered* the mount is irrelevant to how it renders. The web view
(`dsx.module.<scheme>.open()`), a native `<DSXView>`, and a Swift cross-module call are
**equal consumers of the bus** (constitution, Article on surfaces) — any of them can call the
action; the action mounts the same native surface either way. When web calls `open()`, the call
crosses the bridge into the module's `dsx.action`, which mounts a native page. The web view does
**not** host, render, or own that page — it just sent a message and (optionally) sits as a lower
layer underneath. So the recorder, the vertical player, every mounted screen is native rendering
that happens to be *reachable* from the web, never *bound* to it.

Corollary: never reason about a mounted screen as "web content" — there is no DOM, no HTML, no
CSS in it. Style with DSX semantic tokens, debug it as native SwiftUI.

## The model: present a FILE

A component **is** a `.dsx` file in a module's `Components/` folder. The build scans those
folders into the registry (`Registry/StackComponents.generated.swift`), and `mount` presents
one by reference. Every `<Tag>` *inside* the file resolves from folders the same way —
module-local first, then global. Native code never strings XML together; the UI is always
in files, diffable and OTA-ready.

`dsx.stack.render(xml)` still exists — as the **escape hatch** for markup that genuinely
isn't a file (a one-off debug surface, generated markup). If you're reaching for it in
normal feature work, the markup probably wants to be a component file instead.

## The three reference forms

| Form | Example | When |
|---|---|---|
| **Generated ref** (the default) | `.Player` · `.verticalplayer.Episodes` · `.store.PaywallHero` | Always, unless you can't. **Autocompleted** in Xcode and **compile-checked** — the refs are generated from the `.dsx` files themselves, so a typo or a deleted file is a build error, and the list can never drift from the folders. |
| **Dynamic ref (string)** | `mount("dsx.module.self.Player")` · `mount("dsx.module.store.Card")` | When the name arrives as data or must not appear in source (refactor-agnostic). The string mirrors JSE `dsx.module.self.…` verbatim. Resolved at runtime — no compile check. (`dsx.module` itself is the CALL root: `dsx.module.scheme.method(args)`.) |
| **String** | `mount("dsx.module.self.Player")` | References that arrive **as data** (config, server-driven UI). |

### Where the generated refs come from

`ClosedSource/scripts/prepare_config.rb` — the same scan that builds the component registry — also emits
typed references:

- **global components** (a scheme-less module's `Components/`, e.g. `Foundation`) → flat statics:
  `.Card`, `.VipCard`
- **module components** → a per-scheme namespace: `.verticalplayer.Player`,
  `.store.PaywallHero` (generated `DSXComponents_<scheme>` structs)

One generator, one source of truth: add `Components/Foo.dsx` → `.scheme.Foo` exists on the
next build; delete the file → every call site goes red. (Names that aren't Swift identifiers
are skipped; a scheme that clashes with a flat global keeps the global.)

## Mount modes — how you put the surface on screen

| Mode | Call | What you get |
|---|---|---|
| **Page — route push** (the default for a full screen) | `mount(.Player)` → `ui.push(from: dsx, path: "/player") { teardown }` | A native nav **frame** on the kernel NavigationStack (RouterHost). You get the push transition + interactive **edge-swipe-back for free**, the web view stays live underneath, and `onPop` runs your teardown exactly once (back-swipe OR `dsx.module.route.pop()`). This is what `verticalplayer` and `studioeditor` use — the path proven to open reliably. Close with `dsx.module.route.pop()`. |
| **Page — modal present** (fallback / deliberate modal) | `mount(.Player)` → `ui.present(from: presenter, animated: false, enter: "slide-right")` | A modally-presented `.overFullScreen` controller, *outside* the nav stack. Use only when you explicitly want a modal. The component root drives the animation: `enter="slide-right"` + `exit="slide-right"` for the slide, `dismissEdge="left"` + `on:edgeDismiss="dsx.event('close')"` for the back-swipe. **Read the presenter pitfall below before using this.** |
| **Overlay** | `mount(.MiniBar, as: .overlay(.bottom))` | Mounted **over the web view** with passthrough hit-testing — only real controls capture touches; the page stays live behind it (glass nav/tab bars). `ui.remove()` tears it down. |
| **Sheets** | — | Declarative: a `<sheet present="dsx.variable.x">` *inside* the component (the player's Episodes/Speed/Paywall), or `ui.sheet("<Episodes/>", from:, detents:)` natively. |

### Prefer the route push. The modal present has a silent failure mode.

`UIViewController.present(_:animated:)` **silently does nothing** — no error, no crash, and your
`dsx.resolve` still fires — when the presenter isn't in a state to present (not in the window
hierarchy, already presenting something, or mid-transition). The classic symptom: **web logs
"opened" but no screen appears.** If you ever see that, you are almost certainly on the modal
path with a bad presenter — switch to `ui.push`.

Two rules keep you out of it:

1. **Default to `ui.push`.** A route frame is presented by the kernel, not by a controller you
   had to find, so there is no presenter to get wrong. It's the canonical full-page path.
2. **If you must present modally, never derive the presenter from `connectedScenes` /
   `isKeyWindow` / a `topViewController()` walk** — in a web-shell app that can hand back a
   controller that refuses to present. Present from the **web view's owner** instead: walk the
   responder chain up from Dom's exported view to its hosting controller. The web view is always
   on screen when the user acts, so its owner can always present.

   ```swift
   private func owner(_ v: UIView?) -> UIViewController? {
       var r: UIResponder? = v
       while let next = r?.next { if let vc = next as? UIViewController { return vc }; r = next }
       return nil
   }
   // let presenter = owner(dsx.module.dom.object("view") as? UIView)
   ```

## The modern verbs — `dsx.component.push` / `present` / `update` / `dismiss` (state-backed)

There is now ONE presentation vocabulary that reads the same in Swift, in `.dsx` markup, and on web —
and, unlike `mount(…).present(from:)`, it is **state-backed**, so it can never `resolve` "opened"
while nothing is on screen. Two distinct opening verbs for two distinct mental models, plus a live
input channel:

| Verb | What it does | Where the state lives |
|---|---|---|
| **`push`** | opens the component as a native nav **frame** (interactive swipe-back, OS back history) | appends to `global.nav.stack` (RouterHost renders it) |
| **`present`** | opens the component as a **modal**: `sheet` (default, a drawer) / `cover` (full-screen) / `overlay` (a **layer** over the current screen — `touch: "passthrough"` (default) keeps everything beside the overlay's drawn content live (the glass menu-bar-over-web shape); `touch: "block"` is the FULL overlay: every touch stops at the layer (the lock-screen shape). Sheets/covers always present above overlays — plane beats presentation order) | flips an entry in the observable `global.nav.modal` (RouterHost renders it); normalization + topology corpus-pinned in `OpenSource/Conformance/router/present.json` |
| **`update`** | writes new **attribute** values into an already-open component (deepest-last match by tag/mode, top when untargeted; unmatched target = documented no-op) — bindings recalc, `<attribute on:change>` fires | merges into the entry's `attrs` in `global.nav.stack`/`nav.modal` AND re-seeds the live surface's `dsx.attribute` dict |
| **`dismiss`** | closes the top modal, or a targeted one (by component tag or `as:` mode; a sheet/cover takes the chain modals presented above it and spares overlays; an overlay takes only itself) | removes the entry from `global.nav.modal` |

```swift
// Swift (native) — the simple case needs no wiring; returns the surface for optional `.on`/`.action`.
dsx.component.push(.Canvas, attrs: ["trackId": id])                       // → a nav frame
dsx.component.present(.Paywall, mode: "sheet", attrs: ["plan": "pro"])    // → a state-backed sheet
dsx.component.update("Paywall", attrs: ["plan": "team"])                  // → live attribute write
dsx.component.dismiss()                                                   // pop the top modal
```
```xml
<!-- markup / web — 1:1 with Android/Kotlin; the portable string+map wire form -->
<row on:tap="dsx.component.push('Canvas', { attrs: { trackId: item.id } })"/>
<button on:tap="dsx.component.present('Paywall', { as: 'sheet', attrs: { plan: 'pro' } })">Upgrade</button>
<button on:tap="dsx.component.update('Paywall', { attrs: { plan: 'team' } })">Switch to team</button>
<icon on:tap="dsx.component.dismiss()"/>
```

The name resolves in the **caller's scope** (package-local component first); a qualified
`'other.Screen'` targets another package. `present` is the state-backed replacement for the
fire-and-forget `mount(…).present(from:)` above — prefer it. Advanced surfaces that must wire `.on` /
`.action` / seed via `ui.variable` before first paint keep the `mount(…).push(from:)` recipe below (the
returned surface is the same object, so you can wire it too).

### THE ATTRIBUTE CONTRACT — `attrs` is how a component takes input

**This is the load-bearing rule of the whole verb family.** A component's public inputs are its
**attributes** — the `<attribute as="…"/>` declarations in its head — and `attrs` on
`push`/`present` passes **exactly the attributes you would write if you hard-coded the tag**. The
two invocations below are the *same contract*, one static and one dynamic:

```xml
<!-- static: composed into a parent's body -->
<Paywall plan="pro" trialDays="14"/>
```
```xml
<!-- dynamic: mounted as its own screen — the SAME inputs, verbatim -->
<button on:tap="dsx.component.present('Paywall', { as: 'sheet', attrs: { plan: 'pro', trialDays: 14 } })"/>
```

Inside the component nothing changes between the two: it declares `<attribute as="plan"/>` and reads
`dsx.attribute.plan`. That symmetry is what makes a component a real black box — the mounting side
never reaches into its internals, it only sets the runtime properties the component itself chose to
expose. Everything downstream follows from it:

- **Attributes are fully reactive.** A read anywhere — `{{ dsx.attribute.plan }}`, a
  `visible-if`, a computed variable's body — re-derives when the attribute changes. Keep derived
  state as `computed="true"` variables over `dsx.attribute.*` (evaluated on read) and the whole
  screen re-badges on an update with zero plumbing.
- **`update` is the live write.** `dsx.component.update(target, { attrs })` merges new values into
  the open surface's attributes: bindings recalc, and the component's **`<attribute as="x"
  on:change="…">`** handler fires — the component reacts to input changes with its *own* logic
  (recompute internal variables, kick a fetch, animate), exactly like a web component's
  `attributeChangedCallback`. The mounting side never touches internal variables.
- **The entry remembers.** `attrs` ride the nav entry in `global.nav.stack` / `nav.modal`
  verbatim (and `update` merges into them), so what re-renders after a state restore is what the
  screen was last told — not the mount-time snapshot.
- **`default=` still applies.** A key you don't pass falls back to the declaration's `default=`
  expression; a key you do pass wins. Absent ≠ empty — design attribute contracts to fail
  open (the Launcher's `avail_* !== false` reads are the house pattern).
- **Internal state is NOT yours to seed.** If you're tempted to pass a value that the component
  doesn't declare as an attribute, the component's contract is missing an attribute — add the
  declaration, don't smuggle state. (`vars:` still exists as the **legacy** seed channel: it
  writes the surface's store under `vars.*`, bypassing the declared interface. Existing callers
  keep working, but new code passes `attrs`, and migrating a `vars` consumer means declaring its
  inputs as `<attribute>`s — the Launcher migration in `Custom/Demo` is the reference diff.)

Per-platform notes (same contract, one wire shape `{ attrs: {…} }`): on iOS attrs seed via the
surface's `attribute()` API (runtime value beats `default=`, `on:change` observers fire on update);
on Android they seed the store's `dsx.attribute` dict pre-mount and re-seed live on update
(`<attribute on:change>` rides the existing :render deferral — see `android-status.md`); on web
`instantiate({ attrs })` seeds the same dict and `update` re-seeds the live instance's store. The
verb behavior — normalization, targeting, merge semantics, no-op rule — is corpus-pinned for all
three in `OpenSource/Conformance/router/present.json`.

### What survives a cold start

| Opened via | Restorable across process death? |
|---|---|
| an **app route** (`App.json` / OTA `routes.json`, path-addressed) | **yes** — the serializable route + params re-resolve on launch |
| a package **screen** (`dsx.component.push/present`, or `mount(…).push`) | **no — ephemeral by contract**; re-enter it by calling the package's action again |

Package screens are deliberately not URL-addressable (a package's *internal* screens never leak into a
global namespace — information hiding). App-level restoration is the route table's job. See
`OpenSource/Documentation/architecture/screen-presentation.md`.

## The canonical full-screen recipe — copy this

A full-screen package screen (recorder, player, editor) is opened the SAME way every time. This is
the proven shape — `verticalplayer` and `studioeditor` both use it. Copy it; don't improvise.

**Swift — the `open` action** (mirrors `VerticalPlayerStack.swift` / `StudioEditor.swift`):

```swift
dsx.action("open") { [self] dsx in
    // 1. MOUNT + PUSH happen BEFORE any engine/dependency call — first paint must not
    //    depend on a module that might be missing or slow (Rule 4).
    let ui = self.dsx.component.mount(.studioeditor.StudioEditor)

    // 2. FORCE the color scheme BEFORE first surface access (Rule 3). Read the LIVE trait so
    //    the page stays light/dark adaptive; default .dark if the system is unspecified.
    let appearance = UITraitCollection.current.userInterfaceStyle
    ui.forcedStyle = (appearance == .unspecified) ? .dark : appearance

    // 3. SEED facts BEFORE push so the first frame isn't empty (Rule 5).
    ui.variable("tracks", tracks).variable("selected", firstId)

    // 4. Wire events. close + back-swipe both funnel through onPop.
    ui.on("close") { [weak self] in try? self?.dsx.module.route.pop() }
    ui.onAny { [weak self] name, p in self?.dsx.broadcast("studioeditor", JSON(p)) }
    self.surface = ui; self.tornDown = false

    // 5. PUSH a route frame (Rule 1) — the kernel presents it; no presenter to get wrong.
    ui.push(from: dsx, path: "/studioeditor") { [weak self] in self?.teardown() }
    dsx.resolve(JSON(["opened": true]))

    // 6. Engine subscriptions go AFTER push, never before — they must not gate first paint.
    subs.append(self.dsx.module.studio.context.on("level") { [weak ui] v in ui?.variable("level", v.double) })
}
```

**DSX — the component root** (mirrors `Player.dsx` / `StudioEditor.dsx`):

```xml
<!-- Root is a <zstack> that FILLS (Rule 2). Content goes in an inner <vstack grow>. -->
<zstack grow="true" background="background" exit="slide-right" anim="spring"
        dismissEdge="left" on:edgeDismiss="dsx.event('close')">
  <vstack grow="true" spacing="0">
    … your screen …
  </vstack>
</zstack>
```

## Five rules for a screen that always renders

1. **Push, don't present.** Use `ui.push(from: dsx, path:) { teardown }`. The kernel presents the
   frame, so there's no presenter to get wrong. **Not** `ui.present(from: someVC)` with a
   hand-found controller — that silently no-ops (see the pitfall above).
2. **The root must FILL.** Make the root a `<zstack grow="true" background="…">` with content in an
   inner `<vstack grow="true">`. **Not** a bare `<vstack grow>` as the page root: it can collapse to
   zero height, and you'll see the frame's (black) background through it — a black screen.
3. **Force the color scheme.** Set `ui.forcedStyle` **before** the first `frameView`/`controller`
   access. On iOS 26 a UIKit `overrideUserInterfaceStyle` does **not** reach SwiftUI semantic colors
   (`Color(UIColor.label)`/`systemBackground`), so `forcedStyle` is the only reliable control (the
   `StackSurface.forcedStyle` contract, `Stack.swift`). Read `UITraitCollection.current` to stay
   adaptive. **Not** "leave it unspecified and hope" — that's how you get black-on-black or a screen
   that ignores the appearance.
4. **First paint must not depend on the engine.** Do `mount` + `push` **before** any
   `dsx.module.<dependency>.*` call or subscription. A missing/broken dependency must never be able
   to blank the UI. **Not** "start the engine, then show the screen."
5. **Seed before you push.** Call `ui.variable(...)` / `ui.list(...).set(...)` **before** `ui.push`.
   **Not** after — the first frame would flash empty.

## Troubleshooting — I opened it but I see nothing

Read the SYMPTOM precisely; each one points at a different layer. Don't guess.

| What you see | What it means | Fix |
|---|---|---|
| **Web view still there, no new screen** | The surface never got on screen | You used modal `present` with a bad presenter (it silently no-op'd, but `dsx.resolve` still fired). Switch to `ui.push` (Rule 1). |
| **Fully BLACK screen** (not even the render-proof header) | A surface IS up, but the **whole tree never became a tree** | **#1 cause: the markup FAILED TO PARSE at runtime** → the kernel falls back to an empty `vstack` and nothing draws. Check the device console for `"[Stack] XML parse failed at line…"`. Far less often: the root collapsed (Rule 2) or the scheme wasn't forced (Rule 3). It is **not** a single bad component (that blanks only its own node) and **not** a crash (a crash kills the app). |
| **Fully WHITE screen, black text** | Colors resolved to LIGHT when you expected dark | Force the scheme (Rule 3). (Black screen = dark resolved but tree empty; white screen = light resolved.) |
| **"opened" logged in web, nothing at all** | The `present` no-op | See the presenter pitfall above — use `ui.push`. |
| **Black screen but `lint_dsx` is GREEN** | A runtime parse failure that lint can't see | Lint did regex tag-balance, not a full parse, and historically **stripped comments** before checking. A literal code-tag name in a comment (`<!-- … <action> … -->`) was lifted by `StackNode.liftCode` and voided the whole file's XML — invisible to lint, fatal at runtime. The kernel now skips comments and lint flags this, but the lesson stands: **lint green ≠ runtime-parseable.** Never put a bracketed tag name (`<action>`, `<variable>`, …) or a bare `&`/`<`/`>` in comment or attribute text. |

**The render-proof trick.** When you can't tell whether the markup renders at all, put ONE element
at the very top that depends on **nothing** — a literal color, no semantic token, no dependency, no
custom component:

```xml
<hstack background="accent" paddingV="12" paddingH="16"><text color="white">Studio</text></hstack>
```

If a build shows that strip → the markup renders and the surface reached the screen (look at a
deeper component). If it's **still black** → the header itself never rendered, so one of: (a) the
**whole file failed to parse** (the header is inside the un-parsed markup — check the console for
`"[Stack] XML parse failed"`, and audit comments/attributes for bracketed tag names or bare
`&`/`<`/`>`); (b) the host/push layer never showed the surface; or (c) — very common —
**the build doesn't contain your change** (see `deploying.md`: test the branch your CI actually
builds). One screenshot plus the console line isolates the layer.

## Wiring the surface — the native trio + events

The surface API mirrors the JSE `$` namespaces 1:1:

| Native | JSE (markup) | Direction |
|---|---|---|
| `ui.variable("paused", false)` | `dsx.variable.paused` | native → state (chainable) |
| `ui.attribute("accent", c)` | `dsx.attribute.accent` | native → root-level attribute (runtime value beats `<attribute default>`) |
| `ui.action("track", payload)` | `dsx.action.track()` — body sees `dsx.this` = payload | native → markup logic |
| `ui.on("close") { }` | `dsx.event('close')` | markup → native |
| `ui.onAny { name, p in }` | *every* `dsx.event` | markup → native (wildcard — analytics/relay) |

## A complete worked example

```swift
final class MiniPlayer: Module {
    override class var scheme: String { "miniplayer" }
    private var surface: StackSurface?
    private var tornDown = false

    override func setup() {
        dsx.action("open") { [weak self] dsx in
            guard let self else { return }

            let ui = dsx.component.mount(.miniplayer.Player)     // Components/Player.dsx (renders NATIVELY)
            ui.variable("title", dsx.args("title") as? String ?? "")
              .variable("paused", false)
            ui.list("queue").set(self.queueRows())
            ui.on("close")  { [weak self] in try? self?.dsx.module.route.pop() }   // → onPop → teardown
            ui.onAny { name, p in dsx.event(name, JSON(p)); dsx.broadcast(name, JSON(p)) }
            self.surface = ui; self.tornDown = false
            ui.push(from: dsx, path: "/miniplayer") { [weak self] in   // the proven full-page path
                guard let self, !self.tornDown else { return }
                self.tornDown = true; self.surface = nil               // teardown — runs once
            }
            dsx.resolve(JSON(["open": true]))
        }
    }
}
```

No `topViewController()`, no presenter to find — the kernel presents the frame. The close button
and the back-swipe both funnel through `onPop`, so teardown runs exactly once either way.

The matching `Components/Player.dsx` owns *everything visual and logical* — derived state
(`<variable computed>`), side effects (`<watch>`), its own actions (`<action as>` with loops /
`await fetch` / `try`), gestures (`on:drag*`), timers (`setInterval`). Swift stays the trust
core: config, money, system capabilities.

## Gotchas

- **Typed refs hard-code the scheme** (`.verticalplayer.Player`) — a scheme rename breaks
  call sites *at compile time* (loud, fixable). The dynamic string form never
  names the scheme — use it when that matters more than autocomplete.
- The component must be **registered** (a `.dsx` in a scanned `Components/` folder, or
  `dsx.stack.component(…)` at runtime). Generated refs only exist for build-time files.
- `mount` returns the surface immediately; **put it on screen yourself** (`ui.push` for a
  full page / `ui.present` for a deliberate modal / `as: .overlay`). Seed facts *before*
  pushing to avoid a first-frame flash.
- Events fired before `mount` returns obviously can't be heard — wire `ui.on`/`ui.onAny`
  right after mounting, before pushing.
- **"Web logged opened but nothing appeared" is never a render bug** — the component renders
  natively the moment it's on screen. It means it never *got* on screen: a modal `present`
  with a bad presenter that silently no-op'd. Use `ui.push`. (See the presenter pitfall above.)
- A route push needs the kernel Router (it's in `OpenSource/Engine`, always compiled) and an
  app that renders through `RouterHost` (the default shell). A pure-web app that excluded the
  router has no nav stack to push onto — there, the modal `present` (from the web view's owner)
  is the path.
