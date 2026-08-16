// swift-tools-version: 5.9
//
// Despia Local - the SPM face.
//
// Package.swift sits at the package ROOT because SPM resolves from the
// repository root, and this folder is what the public mirror publishes. No
// `unsafeFlags` anywhere: SPM refuses versioned consumption of a package that
// uses them, which would silently kill every tagged install.
//
// One product, deliberately. Base is small and there is nothing here an app
// would want to exclude - the excludability story that gives Despia AI two
// products has no analogue in a database.
//
// THE APPLE LANE COMPILES THE SAME ENGINE EVERY OTHER LANE RUNS. It did not
// always: `DespiaLocal` used to be pure Swift over the platform's own libsqlite3,
// which made it a SECOND implementation of the store semantics - the 26 fixtures
// in OpenSource/Conformance/local ran on TypeScript and Kotlin but never on it,
// and sqlite-vec was absent from it entirely, because the system SQLite carries
// no vector extension and no amount of Swift can add one. `DespiaLocalCore` below
// is the closure: engine/src plus the vendored amalgamation and sqlite-vec,
// compiled as ONE clang target, with `DespiaLocal` a marshaller over the eight
// exported symbols exactly as the Kotlin binding is over the same eight.
//
// SOURCE targets, not binaryTarget. Source costs consumers compile minutes but
// is zero-hosting, tag-safe and debuggable; a binaryTarget needs a per-release
// XCFramework whose checksum is written INTO this file, and the mirror tree is
// replaced on every sync, so that write-back is an undesigned chicken-and-egg.
//
// SYMBOL CONFINEMENT, and the honest limit of it here - stated as measured, not
// as hoped. CMakeLists.txt gives the shared library four layers: hidden-
// visibility presets, SQLite's own SQLITE_API decoration, SQLITE_VEC_STATIC, and
// a link-time export map. SPM can carry the two that are DEFINES and neither of
// the two that are FLAGS, because `-fvisibility=hidden` and
// `-Wl,-exported_symbols_list` are both `unsafeFlags` and this package may never
// use those. What that buys and what it does not, on the exact define set below:
//
//   * sqlite3_*  - FULLY confined. Every one of the amalgamation's 266 public
//     entry points compiles with hidden visibility, because SQLITE_API decorates
//     the declaration and the definition alike. Zero remain at default
//     visibility. This is the load-bearing one: a Despia app can carry a sync
//     vendor that ships its own SQLite, and two default-visibility copies in one
//     image is the load-order coin flip that surfaces as corruption.
//   * vec_*      - NOT confined. SQLITE_VEC_STATIC only collapses the export
//     decoration on `sqlite3_vec_init`; upstream's internal helpers
//     (`array_init`, `type_name`, `vtab_set_error`, ...) are plain non-static C
//     functions, and nothing short of `-fvisibility=hidden` hides them. On the
//     CMake lanes the version script does it at link time. Here they stay
//     visible, so a second sqlite-vec in the same image is a DUPLICATE SYMBOL at
//     link time - loud, and at the point where someone can act on it - rather
//     than a silent bind to the wrong copy. Closing it properly needs either a
//     binaryTarget lane (which can link with the export map) or upstream
//     statics; it is not something a define can do.

import PackageDescription

// The vendored trees, reachable by their own `#include <sqlite3.h>` and
// `#include <sqlite-vec.h>`. SPM puts only the target's public headers on the
// search path, so these are named.
let vendorIncludes = [
    "vendor/sqlite",
    "vendor/sqlite-vec",
]

// The vendored amalgamation's build defines, as (name, value) so ONE list can
// serve both the C and the C++ face. PUBLIC in the CMake build for a reason that
// applies here too: several of these change what sqlite3.h DECLARES (SQLITE_API's
// decoration, SQLITE_OMIT_LOAD_EXTENSION, SQLITE_OMIT_DEPRECATED), and a library
// whose implementation and whose callers disagree about the header is a class of
// bug that only shows up at link time on one platform.
let sqliteDefines: [(String, String?)] = [
    // Already `#define SQLITE_CORE 1` at the top of the amalgamation - identical,
    // so it is a no-op there. It is stated for the OTHER translation units: it is
    // what makes sqlite-vec.c and engine/src/store.cpp call SQLite DIRECTLY
    // instead of through sqlite3ext.h's sqlite3_api-> indirection, which is the
    // only correct shape when the extension is linked in rather than loaded.
    ("SQLITE_CORE", "1"),

    // A double-quoted string is a string, never a fallback identifier: the
    // misspelled-column class of bug becomes an error.
    ("SQLITE_DQS", "0"),
    // Serialized; one Base handle is reachable from the module's queue.
    ("SQLITE_THREADSAFE", "1"),
    ("SQLITE_DEFAULT_MEMSTATUS", "0"),
    ("SQLITE_DEFAULT_WAL_SYNCHRONOUS", "1"),
    ("SQLITE_LIKE_DOESNT_MATCH_BLOBS", nil),
    ("SQLITE_MAX_EXPR_DEPTH", "0"),
    ("SQLITE_OMIT_DEPRECATED", nil),
    // Nothing loads a .so into this database. sqlite-vec is linked in and
    // registered by an explicit call, so the extension loader is pure attack
    // surface.
    ("SQLITE_OMIT_LOAD_EXTENSION", nil),
    ("SQLITE_OMIT_SHARED_CACHE", nil),
    ("SQLITE_USE_ALLOCA", nil),
    // Full-text search: the other half of RAG, and the reason a hybrid query
    // needs no second engine.
    ("SQLITE_ENABLE_FTS5", nil),

    // SQLite's own supported way to decorate its public API. This is the layer
    // that keeps sqlite3_* out of the built image's exported symbols, and it
    // contains no space on purpose - a define with a space in it does not survive
    // every build system that has to carry these through.
    ("SQLITE_API", "__attribute__((visibility(\"hidden\")))"),

    // Collapses sqlite-vec's export decoration to nothing - linked in, never
    // dlopen'd - and drops vec_npy_file() and the numpy-from-disk readers. A data
    // plane that can be asked to read an arbitrary path off the filesystem
    // through a SQL function is surface we are not obliged to carry, and no Base
    // action exposes it.
    ("SQLITE_VEC_STATIC", nil),
    ("SQLITE_VEC_OMIT_FS", nil),
]

// The engine's own defines. C++ only: no .c file in the target reads them.
let engineDefines: [(String, String?)] = [
    // api.cpp reports this through despia_local_capabilities(); it is the
    // package's own VERSION file, which ClosedSource/scripts/ai_package_gate.rb
    // checks the rest of the package against.
    ("DESPIA_LOCAL_VERSION", "\"0.1.0\""),
    ("DESPIA_LOCAL_BUILDING", "1"),
    // The vector backend IS built on this lane. That is the whole point of
    // compiling the engine here rather than reimplementing it above the platform
    // SQLite: capabilities reports `vectors`, and the index.* actions answer.
    ("DESPIA_LOCAL_HAS_VEC", "1"),
]

func coreCSettings() -> [CSetting] {
    var out: [CSetting] = []
    for path in vendorIncludes { out.append(.headerSearchPath(path)) }
    for (name, value) in sqliteDefines { out.append(.define(name, to: value)) }
    return out
}

func coreCxxSettings() -> [CXXSetting] {
    var out: [CXXSetting] = []
    for path in vendorIncludes { out.append(.headerSearchPath(path)) }
    for (name, value) in sqliteDefines { out.append(.define(name, to: value)) }
    for (name, value) in engineDefines { out.append(.define(name, to: value)) }
    return out
}

let package = Package(
    name: "DespiaLocal",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "DespiaLocal", targets: ["DespiaLocal"]),
    ],
    targets: [
        // The C++17 store, the C ABI, and the vendored database underneath both.
        // ONE clang target rather than two, because two targets rooted at the
        // package directory would overlap and SPM refuses that; a clang target
        // may mix .c and .cpp, and `sources` names the vendored files one by one
        // so nothing but the amalgamation and sqlite-vec is ever swept in.
        .target(
            name: "DespiaLocalCore",
            path: ".",
            sources: [
                "engine/src",
                "vendor/sqlite/sqlite3.c",
                "vendor/sqlite-vec/sqlite-vec.c",
            ],
            publicHeadersPath: "engine/include",
            cSettings: coreCSettings(),
            cxxSettings: coreCxxSettings()
        ),
        .target(
            name: "DespiaLocal",
            dependencies: ["DespiaLocalCore"],
            path: "bindings/swift/Sources/DespiaLocal"
        ),
        // The corpus runner. A TEST target rather than an executable so
        // `swift test` on the mac lane is the whole gate, and it reads
        // OpenSource/Conformance/local from the tree rather than vendoring a copy:
        // one corpus, three runners, and no chance of a stale duplicate passing
        // while the shared fixtures moved on.
        .testTarget(
            name: "DespiaLocalConformanceTests",
            dependencies: ["DespiaLocal"],
            path: "bindings/swift/Tests/DespiaLocalConformanceTests"
        ),
    ],
    // gnu11, not c11, and it is not a preference. sqlite-vec.c carries upstream's
    // `typedef u_int8_t uint8_t;` block, and `u_int8_t` is a BSD type that a
    // strict-ISO mode hides behind __STRICT_ANSI__ - the file does not compile
    // under -std=c11 and does under -std=gnu11. CMAKE_C_STANDARD 11 with
    // extensions on is the same thing on the other lanes, so this pins the Apple
    // lane to what they already do instead of inheriting whatever the installed
    // clang happens to default to this year.
    cLanguageStandard: .gnu11,
    cxxLanguageStandard: .cxx17
)
