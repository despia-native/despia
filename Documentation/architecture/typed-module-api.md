# Typed module API: the `actions` block → generated dot accessors
The 1:1 dot-notation call surface. A package declares its command surface in `dsx.json` `actions` (the same block that carries its unit tests — see [writing-unit-tests.md](../../Skills/writing-unit-tests.md)); each action's `args` / `resolves` / `stream` generate dot accessors whose call expression is byte-identical on Swift, Kotlin, and Java. The unified JSON envelope is the wire contract underneath, so a module with no declaration is still callable by building the envelope by hand.
Two rules make the dot truly 1:1. Method names are generated symbols, because only Swift has `@dynamicMemberLookup` and the JVM cannot resolve `set_user_id` dynamically. And the argument rides the JSON builder, not named params, because named params are where 1:1 breaks (Swift `id:`, Kotlin `id =`, Java positional). With both, the dot expression is identical everywhere:
```swift
try await dsx.module.airbridge.set_user_id(JSON.obj().put("id", id))   // Swift
```
```kotlin
dsx.module.airbridge.set_user_id(JSON.obj().put("id", id))             // Kotlin
```
```java
dsx.module.airbridge.set_user_id(JSON.obj().put("id", id)).get();      // Java
```
The dot expression is byte-identical. The only per-language residue is the await wrapper (`try await`, `suspend`, `.get()`), which is a language fact about async, not a design choice. Fire-and-forget calls are fully identical, the generator emits a non-awaiting overload for them.
The trade for true 1:1: the arg is a JSON blob, so a wrong method name is a compile error but a wrong arg shape is caught at runtime by the kernel validating against the declared `args` schema. Compile-time per-arg types are only possible with named params, which is what breaks 1:1. A module that wants per-arg compile checks can opt into named params and give up 1:1 for itself. Each generated method lowers to the same envelope:
```swift
dsx.module(JSON.obj().put("scheme","airbridge").put("method", JSON.arr("set_user_id")).put("args", JSON.obj().put("id", id)))
```
## The `actions` block
The package's command surface. Each entry is one action — keyed by name, **dotted** for a sub-action (`"track.purchase"`). An action declares its `args`, what it `resolves` (or its `stream` `events`), the `broadcasts` it fires, and its unit `tests`. Joins `context` and `delegate` in `dsx.json`.
```jsonc
"scheme": "airbridge",
"actions": {
  "clear_user":      {},                                              // no args, void
  "set_user_id":     { "args": { "id": "string" } },
  "get_attribution": { "resolves": "object" },                        // resolves JSON
  "get_device_uuid": { "resolves": { "uuid": "string" } },            // typed shape
  "log_ad_revenue":  { "args": {
      "revenue":  "number",
      "currency": { "type": "string", "optional": true, "default": "USD" } } },
  "listen":          { "args": { "lang": "string" }, "stream": true, "events": ["partial"] },  // emits dsx.event
  "track.event":     { "args": { "name": "string" } },                // dotted -> dot chain
  "track.purchase":  { "args": { "sku": "string", "value": "number" }, "resolves": { "ok": "boolean" } }
}
```
| key | meaning | default |
| --- | --- | --- |
| `args` | `name -> type`, or `name -> { type, optional, default }` | none |
| `resolves` | scalar, `"object"`, or inline `{ field: type }` — omit for void or a stream | void |
| `stream` | emits `dsx.event` repeatedly, generates a subscription form | `false` |
| `events` / `broadcasts` | the stream-event / bus-broadcast NAMES the action can emit (string lists) | none |
| `gate` | a `veto` delegate this module declares, folded before dispatch | none |
| `tests` | declared unit-test cases — see [writing-unit-tests.md](../../Skills/writing-unit-tests.md) | none |
`args`, `resolves`, `stream`, `events`, `broadcasts`, `gate`, `tests` are reserved and cannot be action names. (A legacy `methods` block — with `returns` instead of `resolves` — is still accepted for back-compat, but `actions` is the one source.)

### Declared tests
Each action's `tests` array carries its unit-test cases — a `given` precondition (merged over a top-level package `hydrate`), `args`, a `resolve` (validated against the action's `resolves`) or `expectError`, asserted `broadcasts`, and — for a `stream: true` action — a time-based `events` stream. `scripts/verify_module_tests.rb` validates every case at build; **StackCanvas** (`OpenSource/CanvasEditor`) loads the same actions and *plays* each scenario (given → call → resolve → broadcasts → the events stream on a virtual clock). So one `actions` block has **three consumers**: the typed accessors (here), the build gate, and the previewer. Full field reference, the `hydrate`/`given` merge, and recipes: [writing-unit-tests.md](../../Skills/writing-unit-tests.md).
## Types
One vocabulary: `string` · `number` · `boolean` · `object` · `array` · `file`.
| `dsx.json` | Swift | Kotlin | Java |
| --- | --- | --- | --- |
| `string` `number` `boolean` | `String` `Double` `Bool` | `String` `Double` `Boolean` | `String` `double` `boolean` |
| `object` | `JSON` | `JSON` | `JSON` |
| `array` | `[JSON]` | `List<JSON>` | `List<JSON>` |
| `file` | `URL` | `Uri` | `Uri` |
| inline `{ f: type }` | `struct` | `data class` | record |
`optional: true` makes it nullable or defaulted. In the JSON-arg register the JSON carries optionals, so there are no overloads. In the opt-in named-param variant, `default` becomes Swift and Kotlin default params and Java overloads.
## What gets generated
One thin accessor per scheme. Each method takes the JSON arg and lowers to `dsx.module` with `method` as an array. No per-method logic, no per-arg signatures, no Java overloads for optionals (the JSON carries them), so it cannot drift from the handler and stays byte-identical to call. Folders generate a nested accessor, context and delegate hang off the same `dsx.module.<scheme>`.
```swift
public struct AirbridgeModule {
    let dsx: Context
    public func set_user_id(_ args: JSON) async throws -> JSON {
        try await dsx.module(JSON.obj().put("scheme","airbridge")
            .put("method", JSON.arr("set_user_id")).put("args", args))
    }
    public var track:    AirbridgeTrack    { .init(dsx) }   // .event(_:), .purchase(_:)
    public var context:  AirbridgeContext  { .init(dsx) }
    public var delegate: AirbridgeDelegate { .init(dsx) }
}
public struct AirbridgeTrack {
    let dsx: Context
    public func event(_ args: JSON) async throws -> JSON {
        try await dsx.module(JSON.obj().put("scheme","airbridge")
            .put("method", JSON.arr("track","event")).put("args", args))   // array path, never "track.event"
    }
}
```
Kotlin is the same shape with `suspend fun`, Java returns `CompletableFuture<JSON>`, both taking the same single `JSON` arg so the call expression matches Swift exactly. A non-awaiting fire-and-forget overload is generated alongside. All three share one parsed IR, so they cannot diverge.
The declared `args` schema is not a compile-time signature here, it is what the kernel validates the incoming JSON against at runtime, plus what documents the shape and drives the optional named-param variant.
## Calling, two registers
Byte-identical, the JSON-builder arg. The call expression matches on all three including Java, only the await wrapper differs. For static payloads, `json("""{ ... }""")` is the same bytes everywhere and copy-pastes to a `.json` file or curl. For dynamic payloads use the builder, which inserts values as data: never string-interpolate into the JSON text, interpolation is per-language and an injection risk.
```swift
try await dsx.module.airbridge.set_user_id(JSON.obj().put("id", "u_123"))
let res = try await dsx.module.airbridge.get_device_uuid(JSON.obj())     // returns JSON, read res.uuid
try await dsx.module.airbridge.track.purchase(JSON.obj().put("sku","gold").put("value", 9.99))
let a = dsx.module.airbridge.context.attribution                        // typed read, exclusion-safe default
dsx.module.terra.delegate.shouldUpload { input in JSON.bool(((input as? [String: Any])?["bytes"] as? Int ?? 0) < 10_000) }  // input is the raw payload (cast it)
let sub = dsx.module.speech.listen(JSON.obj().put("lang","en")) { evt in render(evt) }  // stream, per dsx.event
```
Named fields, the ergonomic register. Swift gets these free via `@dynamicCallable` on the leaf, the labels arrive as the args map at runtime, no declaration needed. Kotlin and Java need declared parameters, which is what the `actions` codegen generates, so this register is the parity the codegen buys.
```swift
dsx.module.airbridge.track.purchase(sku: "gold", value: 9.99)    // Swift, free via @dynamicCallable
```
```kotlin
dsx.module.airbridge.track.purchase(sku = "gold", value = 9.99)  // Kotlin, generated params
```
```java
dsx.module.airbridge.track.purchase("gold", 9.99);               // Java, positional
```
Field names and order match Swift to Kotlin, Java is positional, per-arg types are checked. The map literal (`purchase(["sku":"gold"])` / `purchase(mapOf("sku" to "gold"))`) is the always-works floor for undeclared actions. The dot expression is identical on Kotlin and Java in both registers, only the wrapper differs: Swift `try await`, Kotlin `suspend`, Java `.get()`. Fire-and-forget calls drop the wrapper.
The Swift leaf carries both, so named fields work undeclared and the JSON-arg works always:
```swift
@dynamicCallable @dynamicMemberLookup
public struct ModuleAction {
    public subscript(dynamicMember s: String) -> ModuleAction { /* .track.purchase chain */ }
    public func dynamicallyCall(withKeywordArguments a: KeyValuePairs<String, Any>) async throws -> JSON {
        try await dsx.module(JSON.obj().put("scheme", scheme)
            .put("method", JSON.arr(path)).put("args", JSON(a)))   // labels become the args map
    }
}
```
## Registering, author side
Always the string-keyed `dsx.action`, nested for folders. Declaration is the contract, registration fulfills it.
```swift
dsx.action("set_user_id") { dsx in AirbridgeLib.setUserID(dsx.args("id") as? String ?? ""); dsx.resolve() }
dsx.action("track") { dsx.action("purchase") { dsx in dsx.resolve() } }   // fulfills track.purchase
```
`prepare_modules` lints both ways: every declared method needs a matching nested `dsx.action`, and a public method must be declared. The typed API can never claim a method the handler does not serve. The generator can optionally emit typed registration stubs that lower to `dsx.action`, off by default.
## Errors and exclusion
Reject with a code, surfaces as a typed throw. The verb is `dsx.reject`.
```swift
dsx.reject(code: "card_declined", message: "issuer declined", recoverable: true, data: nil)
do { try await dsx.module.stripe.charge(amount: 10) }
catch ModuleCallError.actionFailed(let code, _) where code == "card_declined" { }
catch ModuleCallError.notLoaded { }   // stripe excluded from this build
```
An excluded module emits no accessor, so its symbols are absent and a build that excludes it cannot reference `dsx.module.<scheme>`. When a module is present but a dependency is excluded at runtime, the call resolves to `notLoaded`, so optional dependencies stay fail-open with `try?` or catch. Feature-gating is by presence.
## Build and versioning
`prepare_modules` reads each module's `actions`, `context`, `delegate`, skipping excluded modules, and emits `ModuleAccessors.generated.{swift,kt,java}` next to the existing schemes. Adding a method or optional arg is additive. Rename or remove is breaking: bump the module version and keep the old `dsx.action` as a deprecated alias for one release if web clients still call it.
