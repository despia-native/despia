// swift-tools-version: 5.9
//
// Despia AI - the SPM face of the package.
//
// Package.swift sits at the package ROOT because SPM resolves a package from
// its repository root, and this folder is what the public mirror publishes.
// Nothing here may use `unsafeFlags`: SPM refuses versioned consumption of a
// package that does, which would silently kill every tagged install.
//
// SOURCE targets, not binaryTarget, in v1. Source costs consumers compile
// minutes but is zero-hosting, tag-safe and debuggable; a binaryTarget needs a
// per-release XCFramework whose checksum is written INTO this file, and the
// mirror tree is replaced on every sync, so that write-back is an undesigned
// chicken-and-egg. If compile time ever becomes an adoption blocker, the
// checksum-commit-back lane becomes its own workstream - it is not a tweak.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS BUILD CARRIES, STATED UP FRONT
//
// gguf (llama.cpp) and whisper (whisper.cpp), on the CPU, plus the mock backend
// the gates run against. Every one of the eleven rows in the shipped model
// catalog names `gguf` or `whisper`, so this is the difference between an SDK
// that can load a model and one that cannot.
//
// It does NOT carry Metal. GPU offload is absent from the SPM lane and the two
// reasons are mechanical rather than a matter of taste:
//
//   * `vendor/ggml/src/ggml-metal/ggml-metal-device.m` reads
//     `SWIFTPM_MODULE_BUNDLE` under `#ifdef SWIFT_PACKAGE`, and never includes
//     the `resource_bundle_accessor.h` that SwiftPM generates to declare it.
//     SwiftPM defines `SWIFT_PACKAGE` for every target it compiles, so that
//     branch is taken and the identifier is undeclared. Supplying the header
//     means `-include` (an unsafe flag) or editing vendored upstream source
//     (which breaks the byte-for-byte claim docs/vendoring.md makes and
//     verifies).
//   * `ggml-metal.metal` `#include`s `../ggml-common.h`, and neither SwiftPM's
//     Metal compilation nor `-[MTLDevice newLibraryWithSource:options:error:]`
//     offers a header search path to resolve it with.
//
// So: CPU inference on Apple, which is real and works, and a named gap rather
// than a silent one. Accelerate/BLAS is the cheap next win - it is
// `.define("GGML_USE_ACCELERATE")` plus `.linkedFramework("Accelerate")`, both
// safe settings - and it is absent for one honest reason: it could not be
// compiled against an Apple SDK before this shipped, and an untested define
// that breaks the build is worse than a missing optimisation.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SETTINGS BELOW ARE ONLY `.define` AND `.headerSearchPath`
//
// The vendored trees are built by CMake with a large option surface, and the
// question of whether any of it is `unsafeFlags`-shaped was settled by
// measurement rather than by argument: the whole per-tree setting surface CMake
// actually applies to these 196 translation units is `-I` and `-D`. The
// `-msse4.2 -mf16c -mfma -mbmi2 -mavx -mavx2` set is x86 tuning that ggml
// guards with `#if defined(__AVX2__)` and friends and compiles without;
// `-fopenmp` is an optional threading path; `-fvisibility=hidden` and the
// link-time export map serve the shared-library artifact, which SPM does not
// produce. All 196 compile, link and report their engines with none of them.
//
// Two ISA notes that belong here rather than in a commit message:
//
//   * On ARM this repo forces `GGML_NATIVE=OFF`, under which ggml's own CMake
//     adds no `-march` either. The SPM lane and the CMake lane sit on the SAME
//     ARM baseline - `arm64-apple-ios` defaults to a CPU without dotprod or
//     fp16 vector arithmetic, `arm64-apple-macos` defaults to one with both.
//     Raising the iOS floor is a real optimisation and it needs `-mcpu`, which
//     is an unsafe flag, so it is a binaryTarget-lane question, not one this
//     file can answer.
//   * On x86 the AVX2 kernels are compiled out. Apple x86_64 means Intel Macs
//     and the x86_64 simulator; the arm64 path is the one that ships.

import PackageDescription

// ─────────────────────────────────────────────────────────────────────────────
// The vendored trees' settings, declared once.
//
// SPM types C and C++ settings separately, so the same define has to be handed
// to `cSettings` and `cxxSettings` as two different types. Writing the lists
// twice is how they drift, so they are written once here as data and mapped.
// ─────────────────────────────────────────────────────────────────────────────

/// Values that MUST match `vendor/VERSIONS`. Neither is optional: `ggml_version()`
/// and `whisper_version()` return them literally and the sources carry no
/// fallback. CMake reads them from `vendor/VERSIONS`; a manifest cannot read a
/// file (the SwiftPM manifest sandbox is not a place to find out), so they are
/// literals here and `ai_package_gate.rb` is where the two are held together.
let ggmlVersion = "0.18.0"
let ggmlCommit = "06ca9761"
let whisperVersion = "1.9.1"

/// The libc feature macros ggml's own CMake selects per platform. `_XOPEN_SOURCE`
/// everywhere it is not AIX/OpenBSD; `_DARWIN_C_SOURCE` for RLIMIT_MEMLOCK on
/// Apple; `_GNU_SOURCE` for the CPU-affinity extensions on Linux and Android.
let libcFeatureDefines: [(String, String?, BuildSettingCondition?)] = [
    ("_XOPEN_SOURCE", "600", nil),
    ("_DARWIN_C_SOURCE", nil, .when(platforms: [.macOS, .iOS, .tvOS, .watchOS, .visionOS, .macCatalyst])),
    ("_GNU_SOURCE", nil, .when(platforms: [.linux])),
]

let ggmlDefines: [(String, String?, BuildSettingCondition?)] = [
    ("GGML_VERSION", "\"\(ggmlVersion)\"", nil),
    ("GGML_COMMIT", "\"\(ggmlCommit)\"", nil),
    ("GGML_SCHED_MAX_COPIES", "4", nil),
    // The CPU backend is the one this lane registers. No GGML_USE_METAL, no
    // GGML_USE_BLAS - see the header note.
    ("GGML_USE_CPU", nil, nil),
    ("GGML_USE_CPU_REPACK", nil, nil),
    ("NDEBUG", nil, .when(configuration: .release)),
] + libcFeatureDefines

let engineDefines: [(String, String?, BuildSettingCondition?)] = [
    ("GGML_USE_CPU", nil, nil),
    ("NDEBUG", nil, .when(configuration: .release)),
]

/// ggml's private headers. Its `include/` arrives on its own as the target's
/// public headers, and every other quoted include in the tree resolves from the
/// directory of the file that wrote it - `src` and `src/ggml-cpu` are the two
/// that do not.
let ggmlIncludes = ["src", "src/ggml-cpu"]

func c(_ defines: [(String, String?, BuildSettingCondition?)], _ includes: [String]) -> [CSetting] {
    defines.map { .define($0.0, to: $0.1, $0.2) } + includes.map { .headerSearchPath($0) }
}

func cxx(_ defines: [(String, String?, BuildSettingCondition?)], _ includes: [String]) -> [CXXSetting] {
    defines.map { .define($0.0, to: $0.1, $0.2) } + includes.map { .headerSearchPath($0) }
}

let package = Package(
    name: "DespiaAI",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        // The core: completions, embeddings, the streaming envelope, the loop.
        .library(name: "DespiaAI", targets: ["DespiaAI"]),
        // The speech stack, separate because it carries tens of megabytes of
        // runtime. Multi-product is how an SPM consumer gets the excludability
        // a DSX app gets from dropping a child module.
        .library(name: "DespiaAIVoice", targets: ["DespiaAIVoice"]),
    ],
    targets: [
        // ── ggml ─────────────────────────────────────────────────────────────
        //
        // ONE shared ggml, the same property CMakeLists.txt is built around:
        // llama.cpp and whisper.cpp both depend on this target and their own
        // bundled copies were deleted at import, so there is no second tree to
        // drift from.
        //
        // The excludes are the SPM spelling of what CMake decides with `if`.
        // `src/ggml-cpu/arch/{arm,x86}` are excluded for a sharper reason than
        // the rest: ggml selects CPU kernels by ARCHITECTURE, the two arch
        // files define the SAME 27 symbols, and SwiftPM's only source predicate
        // is `.when(platforms:)` - PLATFORM, not architecture, and macOS alone
        // spans arm64 and x86_64. Listing both is a duplicate-symbol link
        // failure and listing one breaks the other architecture, so the
        // dispatch moves to the preprocessor:
        // `src/ggml-cpu/arch/spm-arch-{quants,repack}` include the right
        // vendored file and are the only members of `arch/` compiled here.
        .target(
            name: "DespiaGGML",
            path: "vendor/ggml",
            exclude: [
                "CMakeLists.txt",
                "LICENSE",
                "cmake",
                "src/CMakeLists.txt",
                // Apple GPU and Apple BLAS. Both are real backends this lane
                // does not build; the header note says why.
                "src/ggml-metal",
                "src/ggml-blas",
                "src/ggml-cpu/CMakeLists.txt",
                "src/ggml-cpu/cmake",
                // GGML_LLAMAFILE is off in the CMake lane too - matched here so
                // the two lanes compile the same set.
                "src/ggml-cpu/llamafile",
                // Selected by the preprocessor shims, never by the glob.
                "src/ggml-cpu/arch/arm",
                "src/ggml-cpu/arch/x86",
            ],
            sources: ["src"],
            publicHeadersPath: "include",
            cSettings: c(ggmlDefines, ggmlIncludes),
            cxxSettings: cxx(ggmlDefines, ggmlIncludes)
        ),

        // ── llama.cpp: the text engine ───────────────────────────────────────
        .target(
            name: "DespiaLlama",
            dependencies: ["DespiaGGML"],
            path: "vendor/llama.cpp",
            exclude: [
                "CMakeLists.txt",
                "LICENSE",
                "cmake",
                "src/CMakeLists.txt",
            ],
            sources: ["src"],
            publicHeadersPath: "include",
            cSettings: c(engineDefines, ["src"]),
            cxxSettings: cxx(engineDefines, ["src"])
        ),

        // ── whisper.cpp: the speech engine ───────────────────────────────────
        //
        // `src/parakeet.cpp` is a second ASR model that is on disk and unbuilt
        // ON PURPOSE - the CMake lane leaves it out of `all` for the same
        // reason. Excluding it here rather than leaving it to a glob is what
        // keeps the two lanes compiling the same set.
        .target(
            name: "DespiaWhisper",
            dependencies: ["DespiaGGML"],
            path: "vendor/whisper.cpp",
            exclude: [
                "CMakeLists.txt",
                "LICENSE",
                "cmake",
                "src/CMakeLists.txt",
                "src/parakeet.cpp",
            ],
            sources: ["src"],
            publicHeadersPath: "include",
            cSettings: c(engineDefines + [("WHISPER_VERSION", "\"\(whisperVersion)\"", nil)], ["src"]),
            cxxSettings: cxx(engineDefines + [("WHISPER_VERSION", "\"\(whisperVersion)\"", nil)], ["src"])
        ),

        // ── the Despia C++17 core and the C ABI ──────────────────────────────
        //
        // `engine/src/backends` is compiled, and DESPIA_AI_HAVE_LLAMA /
        // DESPIA_AI_HAVE_WHISPER are defined, because those two macros are what
        // `registerBuiltinBackends()` in mock/mock_backend.cpp switches on.
        // Without them the registry holds MockBackend alone and every row in
        // the shipped catalog - all eleven of them name gguf or whisper - is
        // unloadable. The backends' headers arrive through the two target
        // dependencies, which is why no path into vendor/ is written here.
        //
        // MockEngine is compiled in as well: it is what every per-PR gate runs
        // against, on every lane.
        .target(
            name: "DespiaAICore",
            dependencies: ["DespiaGGML", "DespiaLlama", "DespiaWhisper"],
            path: ".",
            // This target's path is the package ROOT, because its two source
            // roots (`engine/src` and `mock`) are siblings with no closer
            // common parent. `sources` already confines it, and `vendor` is
            // named again here so that a target owning the root cannot be read
            // - by a tool or by a person - as claiming the vendored trees the
            // three targets above own.
            exclude: ["vendor"],
            sources: ["engine/src", "mock"],
            publicHeadersPath: "engine/include",
            cxxSettings: [
                .headerSearchPath("engine/include"),
                .define("DESPIA_AI_VERSION", to: "\"0.1.0\""),
                .define("DESPIA_AI_HAVE_LLAMA", to: "1"),
                .define("DESPIA_AI_HAVE_WHISPER", to: "1"),
            ]
        ),
        .target(
            name: "DespiaAI",
            dependencies: ["DespiaAICore"],
            path: "bindings/swift/Sources/DespiaAI"
        ),
        .target(
            name: "DespiaAIVoice",
            dependencies: ["DespiaAI"],
            path: "bindings/swift/Sources/DespiaAIVoice"
        ),
        // The corpus runner and the native-seam tests. A TEST target rather than
        // an executable so `swift test` on the mac lane is the whole gate, and it
        // reads OpenSource/Conformance/ai from the tree rather than vendoring a
        // copy: one corpus, three runners, and no chance of a stale duplicate
        // passing while the shared fixtures moved on.
        .testTarget(
            name: "DespiaAIConformanceTests",
            dependencies: ["DespiaAI"],
            path: "bindings/swift/Tests/DespiaAIConformanceTests"
        ),
    ],
    cLanguageStandard: .gnu11,
    cxxLanguageStandard: .gnucxx17
)
