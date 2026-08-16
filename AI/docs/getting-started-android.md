# Getting started on Android

```kotlin
implementation("com.despia:ai:0.0.1")
```

The Kotlin binding loads `libdespia_ai.so` and speaks the same C ABI the Swift
binding does. Two Android-specific notes:

**Page size.** The native libraries are built 16 KiB-page-size clean (NDK r28+,
or the explicit `max-page-size=16384` link flag). Google Play requires it; a
library that is not aligned fails a consumer's submission, which is not a first
impression worth having.

**GPU is opt-in.** Vulkan acceleration on Android is driver roulette, so CPU
(NEON, i8mm where present) is the default and GPU is something you turn on per
device after measuring. It is never a silent default.

## Use

```kotlin
val ai = DespiaAI(config = Config(stateDir = context.filesDir))
ai.load(entry)

ai.completion(model = entry.id, messages = messages).collect { event ->
    when (event) {
        is Event.Token    -> ui.append(event.delta.text)
        is Event.Complete -> ui.finish(event.usage)
        else -> {}
    }
}
```

The callback arrives on the engine's worker thread. Do not block it: hand the
event to your own dispatcher and return. The JVM lane tests this rule because
Android is where a violation shows up as a frozen UI rather than as a warning.
