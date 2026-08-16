# DespiaScript on Android

The point isn't a platform-parity checklist - it's a **mental model**.
`dsx.container` (like `dsx.module`) is a **dynamic proxy**: you
write `dsx.container.<scheme>.<key>` and it resolves at runtime, so nothing is
ever declared, generated, or hardcoded and the possibilities are open-ended - and
that syntax *means the same thing on iOS and Android*. You think in
`dsx.container`, never in "App Group vs DataStore" or "Darwin vs Flow"; the proxy
keeps the one model true on both platforms.

So this folder isn't "how the platforms differ" - it's the syntax you already
know, spelled in Kotlin, with the (caller-invisible) backing noted underneath.
Only language keywords and a couple of spelling rules change; the model doesn't.

Read [despiascript.md](../despiascript.md) first (the concept), then:

1. **[api-mapping.md](api-mapping.md)** - `Module` / `setup()`, the full `dsx`
   surface, JSON, and the app-lifecycle hooks, Swift ↔ Kotlin side by side.
2. **[manifest-and-build.md](manifest-and-build.md)** - `dsx.json` keys →
   Gradle / `AndroidManifest.xml` / permissions / components.
3. **[containers.md](containers.md)** - the shared `dsx.container` (an App Group
   on iOS) → DataStore on Android.

## The one rule

Write the module once, conceptually. The Kotlin file is the Swift file with
Kotlin keywords. If a name or a shape differs it is listed here; everything else
is identical on purpose, so don't invent platform-specific surface.

## What is byte-identical

- **Method names:** `action`, `args`, `file`, `list`, `command`, `resolve`,
  `error`, `event`, `broadcast`, `variable`, `function`, `css`, `hydrate`,
  `ready`, `configure`, `skip`, `stopped`, `has`, `module`, `container`,
  `context`, `cdn`, `flags`, `webview` (plus the legacy `dispatch` / `call` aliases).
- The `Module` + `setup()` structure and the lifecycle hook names
  (`dsx.hook("launch")`, `dsx.hook("becomeActive")`, …).
- The JSON fluent builder: `JSON.obj().put(k, v)`, `JSON.arr().add(v)`.
- The **web contract is 100% identical** - `dsx.module.scheme.action(…)`,
  `dsx.on(scheme, …)` (and the legacy `window.despia` spellings), the
  `{ id, scheme, host, event, final, data }`
  wire payload, the error envelope `{ code, data }`. Web code never knows which
  platform it runs on; a module's JS examples are the same on both.

## What differs (by language rule, not by design)

| Aspect | Swift | Kotlin |
|---|---|---|
| Class / inherit | `final class X: Module` | `class X : Module()` |
| Method | `func name()` | `fun name()` |
| Override | `override func` | `override fun` |
| Trailing closure | `{ dsx in … }` | `{ dsx -> … }` |
| Capture | `[weak self]` | (no capture list) |
| JSON literal | `JSON(["k": v])` | `JSON(mapOf("k" to v))` |
| Cast an arg | `dsx.args("x") as? String` | `dsx.args("x") as? String` |
| Dynamic chain step | `dsx.module.scheme.action(args)` (dot) | `dsx.module["scheme"]["action"](args)` (`operator get`) |
| Awaitable call | `try await dsx.module…` (`async throws`) | `dsx.module…` inside a `suspend fun` |
| Errors | `ModuleCallError` enum | `ModuleCallError` sealed class (same three cases) |

That's the entire list. Each topic doc shows it line by line.

## Note on Java

A Java module is the same model with Java syntax: lambdas go *inside* the parens
(`dsx.action("scan", c -> { … })`), the JSON literal is `JSON(Map.of("k", v))`,
the awaitable call is a callback (`callAsync`), and `ModuleCallError` is an
exception hierarchy. The mapping docs call out the Java form where it isn't an
obvious translation of the Kotlin.
