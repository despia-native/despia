# Desktop and server JVMs - `com.despia:ai-jvm`

```kotlin
implementation("com.despia:ai-jvm:0.0.1")
runtimeOnly("com.despia:ai-jvm:0.0.1:linux-x64")
runtimeOnly("com.despia:ai-jvm:0.0.1:windows-x64")
```

An AAR cannot serve Compose Desktop, and it cannot serve a server-side JVM
either, so `ai-jvm` is a second **designed** artifact rather than a repackaging
of the Android one. It is a plain JAR of classes, and the native arrives
separately: one jar per platform, carrying that platform's library under a Maven
**classifier**. You declare the classifiers you ship for. Everything else about
the package - the C ABI, the catalog, fit, routing, the tool loop - is the same
code the phone lanes run.

## One library, one name

The JVM entry points are compiled **into** `libdespia_ai` rather than into a
second shared object beside it (`-DDESPIA_AI_JNI=ON`). One file to extract, one
thing to load, no `rpath`, no load order to get wrong, and one place where the
eleven ABI symbols and the JVM's door both live. It is the same arrangement the
Android module already uses.

The export map is the reason this needs saying out loud. The default build's
dynamic table is exactly the eleven `despia_ai_*` symbols and nothing else, and
`check_ai_size.rb` re-checks that on the built artifact. With the JVM door
compiled in, the table is those eleven **plus** `Java_com_despia_ai_*` and
`JNI_OnLoad` - it has to be, or the JVM could not bind a single method - and
still nothing else. The vendored engines stay confined either way, which is the
property that actually matters: an app that carries a second AI SDK with its own
ggml gets neither a duplicate-symbol collision nor, far worse, one library's
calls silently bound to the other's implementation.

## What the loader does

`System.loadLibrary` cannot help here: there is no APK to unpack, and the
library is sitting inside a jar on the classpath. So it is extracted first.

**The cache key leads with the package version.** `<cache>/<version>/<classifier>/`.
A key on the file name alone would serve 0.1.0's library to 0.2.0's classes for
as long as the machine lived, and the crash would name neither version. A
version bump cannot read the previous install's bytes because it never looks in
that directory. Beside the library the build writes a SHA-256, and the loader
compares what it unpacked against it - which settles the one case the version
cannot, a rebuilt snapshot at an unchanged version.

The cache root is the platform's own: `$XDG_CACHE_HOME/despia/ai` (or
`~/.cache/despia/ai`) on Linux, `%LOCALAPPDATA%\despia\ai` on Windows,
`~/Library/Caches/despia/ai` on macOS. Extraction writes a uniquely named
temporary file in the destination directory and moves it into place atomically,
so two processes starting at once cannot hand each other a half-written file.

Two system properties override it, and nothing else does:

| property | effect |
| --- | --- |
| `despia.ai.native` | load from this directory instead; nothing is extracted or cached |
| `despia.ai.cache` | put the extract cache here |

## A missing native is a value, not a crash

An app that ships the `linux-x64` classifier and runs on Windows is an ordinary,
shippable state. The JVM's answer to it is an `UnsatisfiedLinkError` naming a
path; this package's answer is a **typed absence** - the same shape the corpus
pins for an engine that is not in the build (`Conformance/ai/absence`).

```kotlin
when (val availability = Engine.availability()) {
    is NativeResolution.Present -> enableLocalInference()
    is NativeResolution.Absent  -> showRemoteOnly(availability.reason)
}
```

```json
{
  "code": "not_available",
  "reason": "engine_absent",
  "data": {
    "platform": "windows-x64",
    "artifact": "com.despia:ai-jvm:0.0.1:windows-x64",
    "searched": ["classpath:com/despia/ai/natives/windows-x64/despia_ai.dll"]
  }
}
```

`code` is always `not_available`. `reason` is the diagnosis, and each one has a
different fix:

| reason | what happened |
| --- | --- |
| `engine_absent` | the platform is named, but no native for it is on the classpath - add the classifier jar |
| `unsupported_platform` | this package names no classifier for the running os/arch at all |
| `native_missing` | `despia.ai.native` pointed somewhere explicit and the library is not there |
| `version_unknown` | the packaged version stamp is missing, so no cache key can be built - refused rather than risk stale bytes |
| `digest_mismatch` | the extracted bytes are not the bytes the build recorded |
| `extract_failed` | the cache directory could not be written |
| `native_load_failed` | found and extracted, and the dynamic linker refused it - carries the linker's own message |

`Engine()` and `Engine.capabilities()` raise the same absence as a
`DespiaAiError` whose `code`, `message` and `data` carry it verbatim, for the
call paths that cannot continue without the library. `Engine.availability()` is
the one that answers without throwing.

## Classifiers

The loader resolves `linux-x64`, `linux-arm64`, `windows-x64`, `macos-arm64` and
`macos-x64`. That is what the code can find; which of them a given release
actually publishes is a packaging question, and the answer is on the release
page. A classifier with no jar behind it is not a silent hole - it is
`engine_absent`, naming the coordinate that would fill it.

**A JNI native is built on the OS it runs on.** `gradle nativeJar` builds the
full core for the machine it is invoked on and stages it under that machine's
classifier; the `windows-x64` jar comes from a Windows runner, not from a
cross-compile on Linux. If you do cross-compile, `-DDESPIA_AI_JNI_INCLUDE_DIRS`
names the **target** JDK's headers, because `jni_md.h` is per-OS and the host
JDK's copy is the wrong one.

## Building it yourself

```bash
cd bindings/kotlin-jvm
gradle test        # mock backends only - seconds, and what the corpus needs
gradle nativeJar   # the full core, staged into build/libs as the classifier jar
```

`build/libs` then holds the pair - `despia-ai-jvm-<version>.jar` and
`despia-ai-jvm-<version>-<classifier>.jar`. The publication renames both to the
`com.despia:ai-jvm` coordinate; CI stages them and the operator signs and
uploads.

Both natives are built by the package's own `CMakeLists.txt` with
`-DDESPIA_AI_JNI=ON`, so the library the tests load is linked exactly like the
library that ships - same export map, same library name - and a linkage bug
cannot wait until release day to appear. `cmake` is found on `PATH`, via
`$CMAKE`, or under `$ANDROID_HOME/cmake/<version>/bin`.

The two differ in one thing only: `gradle test` passes
`-DDESPIA_AI_LLAMA=OFF -DDESPIA_AI_WHISPER=OFF`, because the deterministic
MockEngine is all the conformance corpus needs and building llama.cpp and
whisper.cpp for it would turn a loop into an errand.

## Threading

Unchanged from every other lane, and this is the lane where it is tested,
because here threads are real and a violation shows up as a hang rather than as
a warning: engine events arrive on the **engine's own worker thread**, which the
JVM has never seen until the JNI layer attaches it. Do not block that thread -
hand the event to your own dispatcher and return. `close()` joins the worker, so
no callback arrives after it returns.
