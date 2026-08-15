# Despia AI

On-device inference for iOS, Android, macOS, Windows and Linux: completions,
streaming, embeddings, speech, vision, and an agentic loop with tool calling.
Apache-2.0.

## Install

Swift Package Manager:

```swift
.package(url: "https://github.com/despia-native/despia-ai", from: "0.0.1")
```

Gradle:

```kotlin
implementation("com.despia:ai:0.0.1")        // Android
implementation("com.despia:ai-jvm:0.0.1")    // JVM desktop
```

## Use

```swift
import DespiaAI

let ai = try DespiaAI(config: .init(stateDir: appSupportURL))
try ai.load(model: catalogEntry)             // a catalog entry, verbatim

for try await event in ai.completion(model: "qwen3-0.6b-q4", messages: messages) {
    switch event {
    case .token(let delta):   print(delta.text, terminator: "")
    case .tool(let call):     try await ai.answer(call, with: runTool(call))
    case .complete(let done): print("\n\(done.usage)")
    }
}
```

## What is actually true of this package

Every claim here is behind a gate, because a claim without one is a defect
rather than copy (`ai_package_gate.rb` runs all of these in CI).

- **Nothing is sent anywhere.** There is no telemetry, no analytics, no account,
  no licence check and no heartbeat. The gate scans `engine/` and `bindings/`
  for URL literals and telemetry symbols and fails on any it finds. The only
  network path in the package is the model downloader, and it talks to the hosts
  your app's own allowlist names.
- **Models are yours.** They live on the device under the user's control, they
  keep working offline forever once downloaded, and nothing can disable one
  remotely: retiring a catalog entry stops new downloads and never touches an
  installed model.
- **Commercial use is unrestricted.** Apache-2.0, and every vendored dependency
  is permissive and pinned in `vendor/VERSIONS`. Model WEIGHTS are separate:
  each carries its own terms, recorded per catalog entry, because the engine's
  licence is not the model's.
- **The ABI is stable and self-describing.** `despia_ai_capabilities()` reports
  what a build carries; consumers adapt to it instead of assuming. Symbols are
  added, never changed or removed, and unknown JSON fields are ignored in both
  directions - so a newer catalog on an older runtime degrades instead of
  breaking.
- **A model that will not run says so first.** Fit is computed against the
  per-process memory limit the OS actually kills apps against, calibrated by a
  measurement on the device, and a load below the floor is refused with a typed
  error rather than attempted and crashed.

What it does NOT do yet, stated plainly: no engine source is vendored, so this
release runs against MockEngine only. The pins are recorded in `vendor/VERSIONS`
and the import is its own reviewable step.

## Docs

`docs/` - the ABI and its threading contract, getting started on each platform,
the catalog format and model licences, tools and the agentic loop, routing, and
how to run the conformance corpus. `llms.txt` indexes them.

## Issues and contributions

This repository is a generated standalone mirror; the tree is replaced on every sync. The
full framework, the documentation, and the single issue tracker live at
[despia-native/despia](https://github.com/despia-native/despia): report bugs and open pull
requests there, and read
[CONTRIBUTING.md](https://github.com/despia-native/despia/blob/main/CONTRIBUTING.md) for
how patches land with your authorship preserved. Maintained by the Despia team; part of
[Despia](https://despia.com), open source under Apache 2.0.

---

Despia LLC-FZ
Meydan Grandstand, 6th Floor, Meydan Road, Nad Al Sheba, Dubai, United Arab Emirates
support@despia.com
