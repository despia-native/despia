# Getting started on iOS

Add the package, load a model, run a completion. Three things worth knowing
before you start: models are downloaded rather than bundled, fit is checked
before a load rather than after a crash, and nothing leaves the device.

Every signature below is the one in `bindings/swift/Sources/DespiaAI/`. Where a
doc and a source file disagree, the source file is right - so this page is kept
honest by being written from it.

## Add the package

```swift
.package(url: "https://github.com/despia-native/despia-ai", from: "0.0.1")
```

Products: `DespiaAI` is the core. `DespiaAIVoice` is the speech stack, kept
separate because it carries tens of megabytes of runtime you should not pay for
unless you use it. It answers typed absence until the W-VOICE licence gate
clears, which is the honest answer rather than a placeholder pretending
otherwise.

Both products build the engines from source. First build is minutes, not
seconds - llama.cpp, whisper.cpp and ggml are around 200 translation units and
SPM compiles them per configuration. There is no XCFramework to download and no
checksum to trust, which is the trade this package made deliberately.

## What the SPM build runs on: the CPU

Inference on Apple runs on the CPU. **Metal - GPU offload - is not in the SPM
lane**, and that is a mechanical limitation rather than a decision about what is
fast enough. ggml's Metal backend reads `SWIFTPM_MODULE_BUNDLE` without
including the header SwiftPM generates to declare it, and its shader
`#include`s a header that neither SwiftPM's Metal compilation nor
`newLibraryWithSource:` can be given a search path for. Supplying either needs
an unsafe compiler flag - which would make this package impossible to depend on
by version - or an edit to vendored upstream source, which would break the
byte-for-byte claim in `docs/vendoring.md`. Neither is a trade worth making
quietly, so it is written down here instead.

What that means in practice: a small quantised model (the 0.6B-1.7B rows in the
catalog) generates at usable speed on a recent device; long prompts pay the most,
because prompt processing is what a GPU helps with most. Ask the device rather
than assuming - `Fit.evaluate` below returns a `decodeTps` for the build you
actually shipped.

The Android and desktop lanes build the same sources through CMake and are not
affected by any of this.

## Ask the build what it carries

Nothing hardcodes an engine id or a feature name. The build reports itself and
consumers adapt, because a consumer that assumes breaks on the first build that
ships without something.

```swift
let caps = DespiaAI.capabilities()
caps.engines      // ["gguf", "mock", "whisper"]
caps.features     // ["detect-language", "embeddings", "gbnf", "listen", "mmap",
                  //  "resample", "structured-output", "timestamps", "tokenize",
                  //  "tools", "transcribe", "vad"]
caps.raw          // everything, including keys this version has never heard of
```

Those are real values read off a build of this package, not an illustration. If
your build reports `["mock"]` alone, it did not compile the engines - that is a
broken build, not a configuration, and every row in the shipped catalog names
`gguf` or `whisper`, so nothing in it will load.

## Declare the memory entitlement if you need big models

`com.apple.developer.kernel.increased-memory-limit` materially changes which
models fit, because iOS kills apps against a per-process limit that is roughly
half of device RAM. Despia AI reads whether you have it and computes fit against
the limit your app will ACTUALLY have. Without it, a 2.4 GB-footprint model is
correctly refused on a device where it would otherwise look fine on paper.

## Ask before you load

`Fit.evaluate` is an ordered, first-match-wins function over the catalog entry,
the device probe, the reported capabilities and your fit policy. It is stated in
prose in `OpenSource/Conformance/ai/README.md` and implemented three times, so
the corpus is what keeps iOS, Android and web agreeing about it.

```swift
let verdict = Fit.evaluate(entry: entry, device: device, caps: caps.raw, policy: policy)
switch verdict.verdict {
case "runs_well":    break   // go
case "runs_slow":    break   // offer it, show verdict.decodeTps
case "too_big":      break   // hide it; verdict.reason is "disk" or "memory"
case "unsupported":  break   // this build cannot serve it; verdict.reason says why
case "quarantined":  break   // it crashed last time; let the user clear it
default:             break
}
```

`verdict.decodeTps` is a shipped prior until the model has run once on this
device, then it is a measurement. `verdict.measured` tells you which, so your UI
can say "on your iPhone" honestly rather than quoting someone else's hardware.
`verdict.mappedMb` rides along as detail and never counts against the memory
limit - mmap'd weights are clean file-backed pages the kernel can evict.

## Open a context and load

```swift
let ai = try DespiaAI(config: Configuration(stateDir: quarantineDirectory))
try ai.load(entry: entry)          // the catalog entry, verbatim
```

Pass a `stateDir`. It is where the crash-quarantine marker lives, and without one
a model that takes the process down cannot be detected on the next launch - it
just becomes a relaunch crash loop.

## Run a completion

```swift
for try await event in ai.completion(model: entry["id"].string(), messages: messages) {
    switch event {
    case .token(_, let delta):        ui.append(delta.text)
    case .sync(_, let snapshot):      ui.replace(with: snapshot)
    case .tool(let id, let name, let arguments, let status):
                                      ui.showTool(id, name, arguments, status)
    case .routing(_, let model, let reason):
                                      ui.showRoute(model, reason)
    case .complete(let snapshot, _, let cancelled):
                                      ui.finish(snapshot, cancelled: cancelled)
    case .failed(let error):          ui.show(error.code)
    }
}
```

Token events carry DELTAS, never the text so far. Append them; do not replace.
That is what keeps a long generation linear over the bridge - and it is why a
surface that attaches mid-stream calls `ai.sync(request:)` to get one full
snapshot instead of guessing what it missed.

Cancelling the consuming task cancels the request, which is legal at any point
including from inside delivery. A cancelled request still settles: no orphaned
stream, no silent truncation.

## Binary never rides JSON

An audio, image or file block carries a `url` and the native side owns the bytes.
`Block.url` is how you read it. Inputs are references too - you pass a URL for an
image part, never base64.

## Threading

Events for a context arrive on ONE engine-owned worker thread, and your handler
must not block it: hand work to your own queue and return. One context is driven
by one caller thread; open a second context rather than sharing one. `close()`
joins the worker, so no callback can arrive after it returns - which is what
makes deterministic teardown possible.

## Where the model comes from

Your app's content root serves the catalog, exactly the way it serves screens,
so a model that ships next month reaches an app that shipped today without an
App Store release. Every file is digest-pinned and verified before it is loaded,
and a mismatch deletes the file rather than trusting it.

## Proving it

`swift test` runs two suites. `CorpusTests` drives the whole shared corpus
(`OpenSource/Conformance/ai/`) through the reference host over the real C++
MockEngine, with the same expectation semantics as the Kotlin and TypeScript
runners. `NativeSeamTests` asserts the claims underneath it - that the engine
reports itself, that `cancel` and `sync` are legal from inside the event
callback, that a paused request stays in flight, and that `close` joins the
worker. If your own host disagrees with the corpus, the corpus is right.
