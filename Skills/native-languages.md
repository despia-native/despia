# Native languages — the polyglot-module primitive (`languages`)

> Audience: module authors shipping native code in a language **other than the platform
> language** (Swift on iOS, Kotlin on Android) — almost always **C++** for a shared DSP /
> crypto / math engine. How a module declares its source languages and how the build
> compiles them, the same way on both platforms.

A module is normally authored in the platform language. Some modules carry a chunk of logic
that is **the same on every platform and the hardest part to get right** — an audio engine, a
codec, a signal-processing core. Writing that twice (Swift *and* Kotlin) doubles the risk
surface on exactly the code that's hardest to debug. So you write it **once in C++** and let
each platform put a thin native skin on top. The `languages` manifest key is how a module
declares "I'm authored partly in C++ (and/or …)" so the build compiles it — declared,
validated, exclusion-safe, and **cross-platform by the same manifest**.

It is a **module-system** primitive (manifest + build), a sibling of `pods` (dependencies),
`components` (UI), and `swiftFlags` (compile flags) — **not** a kernel/runtime feature. The
kernel still names no language; foreign code lives *below* the bus. See *What it is not*.

---

## At a glance

```jsonc
// dsx.json — declare the non-Swift languages this module is authored in
"languages": { "cxx": "c++17", "rust": "2021" }   // map: language → its build config
```

```
Core/<Module>/
  <scheme>_abi.h         ← the extern "C" seam — the cross-platform contract
  engine/ …              ← shared foreign source (the SAME files Android vendors)
  <Module>-Bridging.h    ← C declarations Swift should see (auto-stitched by the build)
  swift/<Module>.swift   ← the DSX Module — calls the ABI (kotlin/<Module>.kt twin)
```

That's the whole shape. Drop your `.cpp`/`.h` in the folder, add the `languages` line, and the
build does the rest.

---

## The schema

`languages` is an **object** keyed by language, each value its build-config string:

| Language | key | value (config) | example |
|---|---|---|---|
| C / C++ / Obj-C++ | `cxx` | the C++ standard | `"c++17"` |
| Rust | `rust` | the edition | `"2021"` |

- An **object** (not an array) because each language carries different config — C++ a
  *standard*, Rust an *edition*. A bare list couldn't hold it.
- **Unknown languages warn, don't abort** (fail-open): a module may declare a language the
  current build script can't compile yet without breaking the gate. Known today: `cxx`,
  `rust`. (`cxx` is wired end-to-end; `rust` is reserved — declared and aggregated, its
  toolchain integration lands when a module needs it.)
- The value is documentation-plus-config: the build reads it; nothing else does.

---

## The C-ABI seam — the one rule that makes it 1:1

Swift and Kotlin can **both** call plain C: Swift through a bridging header, Kotlin through
JNI. So the cross-platform boundary is a **`extern "C"` header** — your engine exposes a flat C
API, and *both* platform layers call the same function names. Nothing platform-specific crosses
this line.

```cpp
// studio_abi.h — THE SEAM. Compiled into the iOS app AND the Android .so. No platform types.
#pragma once
#ifdef __cplusplus
extern "C" {
#endif
typedef void* StudioHandle;
StudioHandle studio_create(double sampleRate, int maxFrames);
void  studio_process(StudioHandle, const float* in, float* out, int frames);  // real-time
void  studio_set_monitor(StudioHandle, int on);                               // control
float studio_level(StudioHandle);
#ifdef __cplusplus
}
#endif
```

The C++ behind it is one shared file:

```cpp
// Engine.cpp — never differs between platforms.
#include "studio_abi.h"
#include <atomic>
struct Engine { std::atomic<bool> monitor{false}; std::atomic<float> level{0.f};
  void process(const float* in, float* out, int n) noexcept {
    float peak = 0.f; bool pass = monitor.load();
    for (int i = 0; i < n; ++i) { float s = in[i]; peak = s>peak?s:peak; out[i] = pass?s:0.f; }
    level.store(peak);
  }
};
StudioHandle studio_create(double,int)            { return new Engine(); }
void  studio_process(StudioHandle h,const float* i,float* o,int n){ ((Engine*)h)->process(i,o,n); }
void  studio_set_monitor(StudioHandle h,int on)   { ((Engine*)h)->monitor.store(on); }
float studio_level(StudioHandle h)                { return ((Engine*)h)->level.load(); }
```

The module's bridging header just exposes the C ABI to Swift:

```objc
// Studio-Bridging.h — Swift sees these C declarations.
#import "engine/studio_abi.h"
```

```swift
// Studio.swift — the DSX module calls the ABI directly (no Obj-C++ needed for a pure C ABI).
final class Studio: Module {
    private var eng: StudioHandle?
    override func setup() {
        dsx.action("monitor") { [self] dsx in
            if eng == nil { eng = studio_create(48000, 256) }
            studio_set_monitor(eng!, (dsx.args("on") as? Bool) == true ? 1 : 0)
            dsx.resolve(JSON(["monitoring": true]))
        }
    }
}
```

The Kotlin twin is mechanically identical — same `dsx.action("monitor")`, the body forwarding
through a one-line JNI shim to the **same** `studio_set_monitor`. That symmetry is the point.

---

## How the build honors it

### iOS (`prepare_modules.rb` → `codemagic.yaml`)

1. **Compile.** `DSX/Modules/` is an Xcode file-system-synchronized group, so any `.cpp`/`.mm`/
   `.hpp` in the module folder is fed to the target automatically — no project edits. (The app
   target already enables C++; the project floor is `gnu++20`.)
2. **Aggregate.** `prepare_modules` walks every **enabled** module's `languages` block and
   writes `DSX/Modules/.plugin_languages.json` (gitignored, regenerated each run) — the
   effective C++ standard (highest requested), the module list, and each module's
   `<Name>-Bridging.h`. It then **weaves** a single C-ABI umbrella,
   `DSX/Modules/.plugin_bridging.h`, that `#import`s the base engine bridging header plus every
   enabled module's header (paths relative to the umbrella). The umbrella exists only while at
   least one C++ module is enabled.
3. **Apply.** The *Native Source Languages* build step reads the aggregate and (a) raises
   `CLANG_CXX_LANGUAGE_STANDARD` **only above** the project floor (never downgrades), and (b)
   points `SWIFT_OBJC_BRIDGING_HEADER` at the umbrella. Both are no-ops when no C++ module is
   enabled — same pattern as `.plugin_deployment_target.json` / `.plugin_swift_flags.json`.

### Android (`CMake`)

The Android build reads the **same** `languages` block: it adds the module's `engine/` folder
to `CMakeLists.txt` and sets `CMAKE_CXX_STANDARD` from `cxx`. One declaration, two build
systems — see `OpenSource/Skills/android/manifest-and-build.md`.

---

## Exclusion-safety (the file-presence gate, unchanged)

Foreign source lives **in the module folder**, so the exclusion gate treats it exactly like
Swift: list the module in `DSX/Modules/Config/excluded.json` and its C++ goes with it — dropped
from the synchronized group on iOS, from the CMake globs on Android. The aggregate is built from
**enabled** modules only, so an excluded C++ module contributes no standard, no umbrella entry,
nothing. No `#if`, no special case — C++ is gated like everything else.

---

## What it is *not*

- **Not a kernel or runtime feature.** There is no `dsx.language.*`, no runtime FFI facet. The
  kernel names no language (Article 1). `languages` is build-time + a folder convention.
- **Not a cross-module call channel.** Foreign code is a module's **private** engine. One module
  still reaches another only through `dsx.module.<scheme>.<action>()` / `dsx.fire` / `dsx.claim`
  (Article 3) — never by linking another module's C++ directly. The C ABI is *intra-module*.
- **Not a dependency import.** `languages` is *your own source* in another language; pulling in a
  third-party native library is still `pods` / `spm` (iOS) — a different key with a different
  meaning.

---

## Gotchas

- **One C++ standard per build.** Multiple C++ modules → the build uses the **highest** `cxx`
  requested. Write to the floor you declare; don't assume a newer standard another module pulled
  in.
- **Bridging header by convention.** The auto-stitch looks for `<Name>-Bridging.h` (the `name`
  from `dsx.json`) at the module root. A C++ module whose Swift needs to see the ABI ships that
  header; one whose C++ is reached only from Obj-C++ (`.mm`) internally may not need it.
- **Keep the seam a C ABI.** `extern "C"`, flat functions, POD/handle types. C++ types in the
  header defeat the cross-platform contract (Kotlin/JNI can't see them) and break the bridging
  header.
- **The real-time rule still holds.** A function on the audio thread (`studio_process`) must not
  allocate, lock, or do I/O — that's a DSP discipline, orthogonal to this primitive, but it's
  where a naive C++ module breaks.

See also: [manifest-dsl.md](manifest-dsl.md) (`languages` in the property DSL),
[module-system.md](module-system.md) (the synchronized-group layout),
[cross-module-calls.md](cross-module-calls.md) (how modules talk — *not* via linked C++),
[android/manifest-and-build.md](android/manifest-and-build.md) (the CMake side).
