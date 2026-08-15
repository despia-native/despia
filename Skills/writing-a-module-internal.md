# Writing a module

A module adds one native capability and claims a URI scheme the web calls. This is the
fast path; the full recipe (every manifest key, edge cases) is in
[Skills/writing-a-module.md](writing-a-module.md) and
[manifest-dsl.md](manifest-dsl.md).

## 1. Pick a folder + tier

```
DSX/Modules/Core/Basics/Torch/      ← Core = excludable; Basics = small device features
  ios/Torch.swift
  dsx.json
  README.md
```

Tiers: `Mandatory/` (always ships), `Core/` (excludable), `Custom/` (per-app).

## 2. `dsx.json`

```json
{
  "name": "Torch",
  "scheme": "torch",
  "aliases": ["torchon", "torchoff"],
  "version": "1.0.0",
  "_note": "One-line summary for humans + tooling."
}
```

- `name` should match the class name. SDK wrappers use a `…Bridge` suffix (e.g.
  `OneSignalBridge`) to stay clear of the SDK's namespace.
- `aliases` are extra schemes routed to the same module (legacy / data-in-host schemes).
- Pods/SPM, entitlements, Info.plist strings, extension targets, and a typed `config`
  all go here too — see [manifest-dsl.md](manifest-dsl.md).

## 3. The `Module` subclass

```swift
import AVFoundation

final class Torch: Module {
    // No `scheme` override — codegen binds it from dsx.json.

    override func setup() {
        // Named actions: dsx.module.torch.enable() / dsx.module.torch.disable()
        // (`on` can't be an action name — it's a reserved module-proxy member.)
        dsx.action("enable")  { dsx in Torch.set(true);  dsx.resolve() }
        dsx.action("disable") { dsx in Torch.set(false); dsx.resolve() }

        // Pre-filter (runs first on every call). Handle, or dsx.skip() to defer
        // to the named actions above. Good for whole-scheme/legacy-alias routing.
        dsx.action { dsx in
            switch dsx.command()?.scheme?.lowercased() {
            case "torchon":  Torch.set(true);  dsx.resolve()
            case "torchoff": Torch.set(false); dsx.resolve()
            default:         dsx.skip()
            }
        }
    }

    private static func set(_ on: Bool) { /* … AVCaptureDevice … */ }
}
```

Settle every call: `dsx.resolve(payload?)` for success, `dsx.error(code, data?)` for
failure, `dsx.event(name, data)` for stream events. The full `dsx` surface is in
[dsx-api.md](../Documentation/reference/dsx-api.md).

## 4. Talk back to the web

- one answer → `dsx.resolve(JSON(["ok": true]))`
- a JS global → `dsx.variable("torchState", on)` → `window.torchState`
- out-of-band event → `dsx.broadcast("changed", payload)` → the page's `dsx.on("torch", …)`
- inject on page load → `dsx.ready { dsx in … }` (didFinish) or `dsx.hydrate { … }` (didCommit)

## 5. Regenerate + build

```bash
ruby ClosedSource/scripts/prepare_config.rb     # binds the scheme into Registry/*.generated.swift
```

The membership exceptions are GENERATED — `prepare_modules.rb` (already run above)
excepts every non-source file (`dsx.json`, `*.md`, `config.json`, …) from the
`DSX/Modules` synchronized group itself (its CONFIG_GLOBS); never hand-edit the
pbxproj. The `.swift` compiles automatically. Then build in Xcode.

## 6. README

Lean, caller-facing, dot-API first. House style:
[documenting-a-module.md](documenting-a-module.md).

## Checklists

- **Cross-module dependency?** `dsx.has("x")`, `try? dsx.module.x.y(args)`
  (fire-and-forget), `try await dsx.module.x.y(args)` (result) — never `import`
  another module.
  [cross-module-calls.md](cross-module-calls.md)
- **Host lifecycle/push/nav?** `dsx.hook("launch") { … }` etc. — see
  [architecture.md](../Documentation/architecture/architecture.md#host-events-lifecycle-push-navigation).
- **Persisted / cross-process data?** `dsx.container` —
  [containers.md](containers.md).
- **Android parity:** mirror the scheme + verbs in Kotlin —
  [android/](android/).
