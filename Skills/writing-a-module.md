# Writing a module - DespiaScript

**DespiaScript is not a new language.** It is the cross-platform module pattern
for writing Despia native extensions in Swift and Kotlin using the same runtime
API: a `Module` subclass with `setup()`, the `dsx` surface
(`action`/`resolve`/`error`/`event`/`args`/`hydrate`), and the `JSON([...])`
payload literal. The same shape compiles on both platforms - only language keywords
differ. Write it once conceptually, drop it into iOS *and* Android.

A recipe for adding a module. Read `manifest-dsl.md` and `runtime-api.md` first.

## 1. Decide the kind

- **Manifest-only** - a permission string or a host SDK pod, no behavior. Just a
  `dsx.json`.
- **Components-only** - ships DSX UI and **no Swift**: a folder with a `Components/`
  folder of `.dsx` (a `dsx.json` is optional — add one only to gate it or give it
  config). Scheme-less ⇒ the components are **global** (`<Card/>`); with a `scheme`
  ⇒ scoped. Components live **only** inside a module — there is no module-less
  components root. A component whose essence is platform MACHINERY (a player, a web
  surface) is a **native component** — one tag, Swift/Kotlin/TS twins, contract-first:
  [native-components.md](native-components.md).
- **Code-bearing** - has a URI scheme and handlers. `dsx.json` + a `Module`
  subclass (and, optionally, a `Components/` folder).

## 2. Create the folder

`DSX/Modules/Core/<Name>/` for default-shipped, `DSX/Modules/Custom/<Name>/` for
client-specific. The folder name is the module's discovery/exclusion name; its
API identity is the scheme **chain** (step 3).

Folders can be nested for organization. A folder with no `dsx.json`, no Swift, and
no `Components/` folder (e.g. `Core/Basics/`) is just a group, so a module can live
at any depth - `Core/Basics/StatusBar/`. Each module is still discovered by its own
folder; the grouping folders are ignored (they register nothing themselves).

> Naming: avoid shadowing an Apple framework with the Swift **class** name (e.g. a
> class literally named `HealthKit` collides with `import HealthKit`). The folder
> can be anything; pick a non-colliding class name.

## 3. Write `dsx.json`

Manifest-only (permission) — note the usage string is a **config token**, never an inline
literal (the manifest-value law, `manifest-dsl.md`): the default lives in the module's
`config.json` (editable, dashboard-visible), per-app values ride `core_packages.json`:
```json
{ "name": "Camera", "icon": "camera",
  "infoPlist": { "NSCameraUsageDescription": "{{ config.usage_description }}" } }
```

Code-bearing with a pod:
```json
{
  "name": "Scanner",
  "icon": "qr-code",
  "scheme": "scanner",
  "version": "1.0.0",
  "pods": ["SwiftQRScanner"],
  "infoPlist": { "NSCameraUsageDescription": "{{ config.usage_description }}" },
  "androidManifest": { "permissions": ["CAMERA"], "activities": ["ScannerActivity"] }
}
```

Every module declares an `icon` — its identity glyph, an
[iconoir.com](https://iconoir.com) name (the only icon set we use). See
`manifest-dsl.md → Identity & gating`.

> **`scheme` is the LOCAL identity segment** (`[a-z][a-z0-9_]*` — underscore,
> never hyphen), not the full name: a module nested under a parent's `Modules/`
> gets its dotted **chain** DERIVED from the tree (`Watch/Modules/Health` +
> `"scheme": "health"` ⇒ chain `watch.health` — the API face AND the wire
> token). Nothing hand-writes a chain — not the manifest, not module code:
> where the identity string is needed (bus event names, state keys), use
> `Self.resolvedScheme` (locality — the module can move and its chain
> re-derives; `WatchHealthBridge.swift` is the exemplar). Law:
> `Documentation/architecture/facet-contracts.md`, *Derived identity*.

> **Reserved names are banned — four vocabularies.** The module proxy's members
> are CLOSED and FROZEN: `on · available · excluded · state · context ·
> object · delegate · dsx · then`. A scheme segment OR an action/group
> first-segment named one of them is a build **error** (`DSXGraph.chain_errors`,
> abort tier) — real members shadow dynamic lookup, and the ban is what keeps
> the dotted chain provably unambiguous. Three adjacent vocabularies are gated
> too: segments and ALIASES may not be the kernel/markup-claimed words
> `dsx · route · self`; `post`/`invoke` may appear at NO position of an
> action path (they are the Kotlin call verbs on every action link); and a
> declared `context`/`state` var may not be named a typed leaf accessor
> (`bool · int · double · string · list · strings · exists · raw · set · on`).
> The shipped collisions were renamed, each keeping its legacy wire spelling as
> a code-only NAMED action (deliberately absent from the manifest — not a
> catch-all pre-filter): `watch.state`→`update`,
> `biometric.available`→`supported`, `bluetooth.state`→`status`,
> `clerk.state`→`status`, `keyboard.state`→`update`,
> `scanningmode.on`/`off`→`enable`/`disable`.

> **Nesting**: a module may contain modules under a `Modules/` folder —
> full citizens with their own manifests (each declaring only its LOCAL
> `scheme` segment; the child's dotted chain derives — `watch.health`),
> individually excludable, dying with their parent by cascade. Reach for it
> only when a piece has its OWN
> permission/dependency/compliance boundary (the ECG rule); shared plumbing
> that children need becomes a child siblings `dependencies`-require. Law +
> examples: `Documentation/architecture/facet-contracts.md`.

> Making native config **per-app dynamic** — usage strings, SDK keys,
> entitlements like universal links, all as `{{ config.* }}` placeholders over
> `config.json` — is its own topic: **[dynamic-modules.md](dynamic-modules.md)**.

## 4. (Code-bearing) Write the `Module` subclass

Put `.swift` files in the module's **`swift/`** facet folder — the symmetric
platform home, `kotlin/`'s twin (**no platform is the default**) — so
disabling the module removes them. Swift at the module ROOT is the **dead
legacy spelling**: the whole tree migrated to `swift/`, and
`check_module_rules` ERRORS on native code outside its platform facet
folder, in every tier — per-app trees are created FROM this repo
post-migration, so they are born canonical. Subclass `Module` and register handlers in
`setup()`. The scheme comes from
`dsx.json` (`"scheme": "scanner"`) - `prepare_modules` binds it to the class,
so you don't repeat it in Swift (override `class var scheme` only to set it in
code; for a nested module the bound identity is the full derived chain — read
it as `Self.resolvedScheme` wherever the identity string is needed, never
spell your own chain). This shape is the cross-platform baseline - the same
`class ... : Module { override ... setup() { dsx.action(...) { dsx in ... } } }`
on Kotlin.

```swift
import WebKit

final class Scanner: Module {
    override func setup() {
        // scanner / scan -> one result (formula)
        dsx.action("scan") { [self] dsx in
            present { code, error in                       // async tail - dsx is captured
                if let error { dsx.error("scan_failed", error.localizedDescription); return }
                dsx.resolve(JSON(["code": code]))
            }
        }
    }
}
```

Emit rules:
- **Formula** (one answer): success → `dsx.ok(data)` (≡ `resolve`); failure →
  `dsx.fail(code, message:, recoverable:, data:)` — the **uniform result contract**: web
  catches a predictable `{ code, message, recoverable, data }` on every scheme, so always
  prefer `fail` over bare `error(code,)` for anything the caller branches on. `code` is a
  stable machine id; `message` is human-readable (safe to show); `recoverable` says whether a
  retry/alternate path is worth offering. (`error`/`resolve` remain as the bare forms.) See
  [dsx-api.md](../Documentation/reference/dsx-api.md); exemplar: `Core/FileViewer`.
- **Action** (events): `dsx.event("name", data)` repeatedly to stream; the JS
  caller's `.stop()` shows up as `dsx.stopped() == true` on a re-dispatch.
- Past an async boundary, just **capture `dsx`** - it stays valid (no `scope()`).
- To keep an already-shipped `window.*` contract working, add an explicit
  `dsx.variable("name", …)` (assignment) or `dsx.function("name", …)` (callback)
  alongside `resolve`/`event`. New web code subscribes via `dsx.on(scheme, …)`.

**Need app-lifecycle / delegate events?** If the module must react to
`didFinishLaunching`, push tokens, `openURL`, universal links,
foreground/background, register the matching named `dsx.hook` in `setup()` —
lifecycle (`dsx.hook("launch")` / `"becomeActive"` / …), deep links (`dsx.hook("openURL")`,
`dsx.hook("remoteNotificationToken")`,
`dsx.hook("continueActivity")` for universal links); or, to take over a
main-frame navigation to attach fresh auth, register `dsx.hook("navReissue")`
(returning a `HookProducer`). The registry fans every delegate event out to
modules, so no `AppDelegate` or `WebViewController` edits are needed. See *App-lifecycle / delegate hooks* in `runtime-api.md` for
the full list, each hook's args, and when it fires.

> **Web page-load timing isn't a hook.** Re-installing `window.*` globals after each navigation, or
> waiting for a parsed document, is `dsx.ready` / `dsx.hydrate` registered in `setup()` (the web
> lifecycle), distinct from these app/delegate `dsx.hook(...)` events.

**Need to call another module?** Use `dsx.module.<scheme>.<action>(args)` —
`await` it for the result, call it bare for fire-and-forget. It routes through
the same registry the JS bridge uses, so the target's existing action handlers
are reused as-is. `try?` makes the call a silent no-op when the target module
was excluded from the build, keeping the dependency optional by construction.

```swift
try? dsx.module.appsflyer.set_user_id(["customer_user_id": userId])
let result = try? await dsx.module.appsflyer.get_uid()
```

Full surface, patterns, error model, anti-patterns:
[cross-module-calls.md](cross-module-calls.md).

For **app-wide state** shared with other modules, native routes and the web
(auth, entitlements, theme, route…), use `dsx.global` — see
[global-state.md](global-state.md).

## 4b. Namespacing actions — groups & multiple schemes

By default `dsx.action("scan")` is reachable as `despia.<scheme>.scan(…)`. Two ways to give the
web a deeper, cleaner dot API (the proxy is fully dynamic — no JS registration):

**Nested group** — `dsx.group("name") { … }` registers the actions inside it under a dotted host,
so the web calls `despia.<scheme>.<group>.<action>(…)`. Nestable.

```swift
dsx.group("index") {
    dsx.action("add")   { dsx in … }   // -> despia.<scheme>.index.add(…)
    dsx.action("query") { dsx in … }   // -> despia.<scheme>.index.query(…)
}
```

**Second scheme** — a module can front MORE THAN ONE spelling, but `aliases` are the
**legacy plane's routing data** (head-position only, legacy grammar allowed — never the
modern dot face), so this shape is for keeping SHIPPED spellings routing, never for new
code. An alias declared in `dsx.json` `aliases` and scoped with `dsx.scheme("name") { … }`
answers as a top-level `despia.<otherScheme>.<action>(…)`, ISOLATED from the primary
scheme's actions (`despia.rag.add` ≠ `despia.intelligence.add`). LocalAI is the shipped
example — it owns `intelligence` (the engine) and the pre-chains alias `rag` (retrieval),
sharing the Cactus embedding engine across both:

```json
{ "scheme": "intelligence", "aliases": ["rag"] }
```
```swift
override class var scheme: String { "intelligence" }   // primary
override func setup() {
    dsx.action("completion") { dsx in … }              // despia.intelligence.completion
    dsx.scheme("rag") {
        dsx.action("add")   { dsx in … }               // despia.rag.add
        dsx.action("query") { dsx in … }               // despia.rag.query
    }
}
```

Rule of thumb: **group** for related sub-actions of one capability (`despia.x.index.add`); a
**nested child module** (`Modules/` — its chain derives, `watch.health`-style) for a genuinely
separate capability with its OWN permission/dependency/compliance boundary (the "childhood is
earned" rule, facet-contracts.md); an **alias** only to keep an already-shipped spelling routing.
Don't reshape an already-shipped flat API just to nest it — that breaks the web
contract. (Most `aliases` entries are flat legacy scheme/token compat — `getclipboard`,
`lighthaptic` — NOT grouping; see manifest-dsl.md.)

## 5. Regenerate & install

```bash
ruby ClosedSource/scripts/prepare_modules.rb       # regenerate Podfile / project / Info.plist / entitlements
pod install                           # if you added/removed pods
```
Review the `Podfile` + `Runtime.xcodeproj` diff. Commit the manifest, the Swift
files, **and** the regenerated `Podfile`/project/Info.plist/entitlements.

## 6. Use it from web

```js
const { code } = await dsx.module.scanner.scan({});   // formula
// or, if it streams:  dsx.on("scanner", p => ...)
// legacy pages keep their spelling: await window.despia.scanner.scan({})
```

## 7. Turn it on/off

Every module is on by default. Drop one by adding its name (or a `Core/Group/*`
path glob) to `DSX/Modules/Config/excluded.json`. For a module that should ship off
by default, list it in `excluded.json` and remove it there per app to enable.

## Checklist

- [ ] Folder under `DSX/Modules/{Core,Custom}/<Name>/`
- [ ] `dsx.json` with `name` (+ local-segment `scheme`/`version` if code-bearing) — optional
      for a components-only module; no reserved-member segment/action names
- [ ] `Components/*.dsx` for any UI the module ships (scheme-less ⇒ global)
- [ ] Swift `Module` subclass in the folder (code-bearing)
- [ ] No `webView.evaluateJavaScript` - use `dsx.resolve`/`dsx.error`/`dsx.event`
- [ ] `ruby ClosedSource/scripts/prepare_modules.rb` run; `Podfile`/project diff reviewed
- [ ] Pods installed; builds in Xcode
- [ ] Verified from web (golden path + a window global if you kept one)
- [ ] Caller-facing `README.md` in the module folder per [documenting-a-module.md](documenting-a-module.md)
