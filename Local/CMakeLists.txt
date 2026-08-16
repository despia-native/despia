# Despia Local - the native build.
#
# Copyright Despia. Licensed under the Apache License, Version 2.0.
#
# One library, one name (libdespia_local), SQLite and sqlite-vec linked
# statically inside it. Consumed by the Android lane through the Kotlin
# binding's externalNativeBuild and by the desktop lanes directly.
#
# THE APPLE LANE DOES NOT USE THIS FILE, BUT IT DOES USE THIS ENGINE. The
# distinction matters enough to state plainly, and the second half of it is new:
# Package.swift now declares a clang target compiling engine/src plus the
# vendored SQLite and sqlite-vec, and the Swift binding is a binding over THOSE
# eight exported symbols rather than a second implementation of the store. It
# was one until recently - pure Swift over the platform libsqlite3 - and the
# consequences were real: the 26 fixtures covered the Kotlin lane and not the
# Apple one, and sqlite-vec did not exist there at all, so vector provenance
# could only be enforced on Android.
#
# What the Apple lane does NOT inherit is this file's symbol confinement, and
# that is a genuine limit rather than an oversight. SPM refuses `unsafeFlags` in
# a versioned package, and `-fvisibility=hidden` and `-Wl,-exported_symbols_list`
# are both unsafe flags, so the Apple build keeps only the confinement that
# DEFINES can express. sqlite3_* is fully hidden, because SQLITE_API decorates
# every entry point and that is the load-bearing one - a Despia app may carry a
# sync vendor shipping its own SQLite, and two default-visibility copies in one
# process is the bug that motivates all of this. vec_* is NOT confined on Apple.
# Package.swift states that limit exactly; it does not inherit the stronger claim
# this file can make.
#
# THE VENDORED DATABASE. `vendor/` carries pruned, pinned copies of the SQLite
# amalgamation and sqlite-vec (pins, prune lists and the reasoning in
# vendor/VERSIONS). Three properties this file is responsible for, each verified
# rather than asserted:
#
#   1. THE .so EXPORTS THE EIGHT despia_local_* SYMBOLS AND NOTHING ELSE - in
#      particular NO sqlite3_* and no vec_*. This is the load-bearing one. A
#      Despia app can carry a sync vendor that ships its own SQLite (PowerSync
#      does), and two libraries exporting sqlite3_* in one process is a
#      load-order coin flip: the vendor's calls bind to our SQLite or ours to
#      theirs, whichever the dynamic linker resolved first, and the failure
#      surfaces as corruption rather than as a link error. Four layers, in
#      order: hidden visibility on every translation unit; SQLite's own
#      SQLITE_API build define; SQLITE_VEC_STATIC; and an export map applied at
#      LINK time, over everything, which is the layer that still holds when a
#      vendored file is compiled with a macro that forces default visibility on.
#      `ruby tools/symbol_check.rb` re-checks the built artifact.
#
#   2. THE VENDORED SOURCE IS NEVER EDITED. Every hardening choice below is a
#      BUILD DEFINE, all of them SQLite's own supported ones. A patched
#      amalgamation is a fork with a CVE watch of its own.
#
#   3. 16 KiB PAGE ALIGNMENT on Android. Android 15+ devices ship 16 KiB pages
#      and Google Play requires 16 KiB-aligned native code; a 4 KiB-aligned .so
#      simply will not load. Guarded by a linker-feature probe so a toolchain
#      without the flag degrades to a warning rather than a broken configure.
#
# The vector backend is selectable: -DDESPIA_LOCAL_VEC=OFF builds the data plane
# alone. That is a legitimate build, not a crippled one - a store with no AI in
# it needs no vector index - and the library says so through
# despia_local_capabilities(), which OMITS the `vectors` key rather than
# reporting an empty one. Typed absence, in the build system as in the ABI.

cmake_minimum_required(VERSION 3.22)
project(despia_local CXX C)

include(CheckLinkerFlag)

option(DESPIA_LOCAL_VEC         "despia-local: build the sqlite-vec vector backend" ON)
option(DESPIA_LOCAL_BUILD_TESTS "despia-local: build the ABI test"                  ON)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Set BEFORE any target is created: these variables seed the matching target
# properties at add_library() time, so the vendored amalgamation inherits them
# without a single patch to its source.
set(CMAKE_C_VISIBILITY_PRESET   hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/VERSION" DESPIA_LOCAL_VERSION_STRING LIMIT_COUNT 1)

# ──────────────────────────────────────────────────────────────────────────────
# The vendored database
#
# Sources are COMMITTED, not fetched: a build that reaches the network is a
# build that stops the day a host moves. A missing tree is therefore a hard
# error and never a silent fallback to a system SQLite - the hardening defines
# below are half the contract, and a library quietly built against whatever
# libsqlite3 the runner happened to have would honour none of them.
# ──────────────────────────────────────────────────────────────────────────────

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/sqlite/sqlite3.c")
    message(FATAL_ERROR
        "despia-local: vendor/sqlite/sqlite3.c is missing. The amalgamation is vendored, "
        "not fetched - see vendor/VERSIONS.")
endif()
if(DESPIA_LOCAL_VEC AND NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/sqlite-vec/sqlite-vec.c")
    message(FATAL_ERROR
        "despia-local: DESPIA_LOCAL_VEC is ON but vendor/sqlite-vec/sqlite-vec.c is missing.")
endif()

add_library(despia_local_sqlite STATIC vendor/sqlite/sqlite3.c)

# PUBLIC, not PRIVATE. Several of these change what sqlite3.h DECLARES
# (SQLITE_API's decoration, SQLITE_OMIT_LOAD_EXTENSION, SQLITE_OMIT_DEPRECATED),
# and a library whose implementation and whose callers disagree about the header
# is a class of bug that only shows up at link time on one platform. One define
# set, every translation unit.
target_include_directories(despia_local_sqlite PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/vendor/sqlite")

target_compile_definitions(despia_local_sqlite PUBLIC
    # SQLITE_CORE is already `#define SQLITE_CORE 1` at the top of the
    # amalgamation - identical, so redefining it is a no-op there. It is stated
    # here for the OTHER translation units: it is what makes sqlite-vec.c and
    # engine/src/store.cpp call SQLite DIRECTLY instead of through
    # sqlite3ext.h's sqlite3_api-> indirection, which is the only correct shape
    # when the extension is linked in rather than loaded.
    SQLITE_CORE=1

    SQLITE_DQS=0                     # a double-quoted string is a string, never
                                     # a fallback identifier: the misspelled-
                                     # column class of bug becomes an error
    SQLITE_THREADSAFE=1              # serialized; one Base handle is reachable
                                     # from the module's queue and the JNI lane
    SQLITE_DEFAULT_MEMSTATUS=0       # drops the allocator's global counters
    SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 # WAL + NORMAL, the phone default
    SQLITE_LIKE_DOESNT_MATCH_BLOBS
    SQLITE_MAX_EXPR_DEPTH=0
    SQLITE_OMIT_DEPRECATED
    SQLITE_OMIT_LOAD_EXTENSION       # nothing loads a .so into this database.
                                     # sqlite-vec is linked in and registered by
                                     # an explicit call, so the extension loader
                                     # is pure attack surface
    SQLITE_OMIT_SHARED_CACHE
    SQLITE_USE_ALLOCA
    SQLITE_ENABLE_FTS5               # full-text search: the other half of RAG,
                                     # and the reason a hybrid query needs no
                                     # second engine
)
# SQLITE_ENABLE_JSON1 is not passed: JSON has been built in since 3.38.

if(NOT MSVC)
    # SQLite's own supported way to decorate its public API - the explicit
    # second layer under CMAKE_C_VISIBILITY_PRESET, so the export surface stays
    # hidden even in a lane that forgets the preset.
    target_compile_definitions(despia_local_sqlite PUBLIC
        "SQLITE_API=__attribute__((visibility(\"hidden\")))")
endif()

if(DESPIA_LOCAL_VEC)
    target_sources(despia_local_sqlite PRIVATE vendor/sqlite-vec/sqlite-vec.c)
    target_include_directories(despia_local_sqlite PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/vendor/sqlite-vec")
    target_compile_definitions(despia_local_sqlite PUBLIC
        SQLITE_VEC_STATIC     # collapses sqlite-vec's export decoration to
                              # nothing - linked in, never dlopen'd
        SQLITE_VEC_OMIT_FS    # drops vec_npy_file() and the numpy-from-disk
                              # readers. A data plane that can be asked to read
                              # an arbitrary path off the filesystem through a
                              # SQL function is surface we are not obliged to
                              # carry, and no Base action exposes it
    )
endif()

# Upstream's warnings are upstream's business; ours are on our own code, and a
# wall of amalgamation noise is how a real warning goes unread.
target_compile_options(despia_local_sqlite PRIVATE -w)

# ──────────────────────────────────────────────────────────────────────────────
# The library
# ──────────────────────────────────────────────────────────────────────────────

add_library(despia_local SHARED
    engine/src/api.cpp
    engine/src/store.cpp
)

target_include_directories(despia_local PUBLIC engine/include)
target_link_libraries(despia_local PRIVATE despia_local_sqlite)
target_compile_definitions(despia_local PRIVATE
    DESPIA_LOCAL_VERSION="${DESPIA_LOCAL_VERSION_STRING}"
    DESPIA_LOCAL_BUILDING=1
)
target_compile_options(despia_local PRIVATE -Wall -Wextra)

if(DESPIA_LOCAL_VEC)
    target_compile_definitions(despia_local PRIVATE DESPIA_LOCAL_HAS_VEC=1)
else()
    target_compile_definitions(despia_local PRIVATE DESPIA_LOCAL_HAS_VEC=0)
endif()

# std::filesystem is a separate archive before GCC 9 / libstdc++ 9. Named rather
# than assumed: the Android NDK's libc++ needs no such thing, and an
# unconditional -lstdc++fs would break that lane instead.
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU" AND CMAKE_CXX_COMPILER_VERSION VERSION_LESS 9.0)
    target_link_libraries(despia_local PRIVATE stdc++fs)
endif()

# Android's libc has no dlopen-free thread/math split to link, but the desktop
# lanes' SQLite wants pthreads and libm, and CMake's own Threads package is the
# portable way to ask.
find_package(Threads REQUIRED)
target_link_libraries(despia_local PRIVATE Threads::Threads)
if(NOT ANDROID AND NOT APPLE AND NOT MSVC)
    target_link_libraries(despia_local PRIVATE m ${CMAKE_DL_LIBS})
endif()

# ──────────────────────────────────────────────────────────────────────────────
# Symbol confinement
#
# Hidden visibility already covers the vendored code. The export map is the
# second layer, and it is the one that holds when a vendored file is compiled
# with an upstream macro that forces default visibility on: it is applied at
# LINK time, over everything, and it also strips the C++ runtime's vague-linkage
# leftovers (std:: typeinfo and vtables) that visibility cannot reach. The
# result is an .so whose dynamic symbol table is exactly the C ABI header.
# ──────────────────────────────────────────────────────────────────────────────

# file(WRITE), not file(GENERATE): check_linker_flag runs during configure and
# needs the script to exist by then.
set(DESPIA_LOCAL_VERSION_SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/despia_local.map")
file(WRITE "${DESPIA_LOCAL_VERSION_SCRIPT}" "{\n  global:\n    despia_local_*;\n  local:\n    *;\n};\n")

set(DESPIA_LOCAL_SYMBOL_LIST "${CMAKE_CURRENT_BINARY_DIR}/despia_local.symbols")
file(WRITE "${DESPIA_LOCAL_SYMBOL_LIST}"
     "_despia_local_abi_version\n_despia_local_call\n_despia_local_capabilities\n"
     "_despia_local_close\n_despia_local_free\n_despia_local_last_error\n"
     "_despia_local_open\n_despia_local_reopen\n")

if(APPLE)
    check_linker_flag(CXX "-Wl,-exported_symbols_list,${DESPIA_LOCAL_SYMBOL_LIST}" DESPIA_LOCAL_HAS_EXPORTED_LIST)
    if(DESPIA_LOCAL_HAS_EXPORTED_LIST)
        target_link_options(despia_local PRIVATE "-Wl,-exported_symbols_list,${DESPIA_LOCAL_SYMBOL_LIST}")
        set_property(TARGET despia_local APPEND PROPERTY LINK_DEPENDS "${DESPIA_LOCAL_SYMBOL_LIST}")
    else()
        message(WARNING "despia-local: -exported_symbols_list unsupported; relying on hidden visibility alone")
    endif()
elseif(NOT MSVC)
    check_linker_flag(CXX "-Wl,--version-script=${DESPIA_LOCAL_VERSION_SCRIPT}" DESPIA_LOCAL_HAS_VERSION_SCRIPT)
    if(DESPIA_LOCAL_HAS_VERSION_SCRIPT)
        target_link_options(despia_local PRIVATE "-Wl,--version-script=${DESPIA_LOCAL_VERSION_SCRIPT}")
        set_property(TARGET despia_local APPEND PROPERTY LINK_DEPENDS "${DESPIA_LOCAL_VERSION_SCRIPT}")
    else()
        message(WARNING "despia-local: --version-script unsupported; relying on hidden visibility alone")
    endif()

    # Belt to the version script's braces: keeps the static SQLite archive's
    # symbols out of the dynamic table even if the map is ever loosened.
    check_linker_flag(CXX "-Wl,--exclude-libs,ALL" DESPIA_LOCAL_HAS_EXCLUDE_LIBS)
    if(DESPIA_LOCAL_HAS_EXCLUDE_LIBS)
        target_link_options(despia_local PRIVATE "-Wl,--exclude-libs,ALL")
    endif()
endif()

# ──────────────────────────────────────────────────────────────────────────────
# 16 KiB page size (Android 15+ / Google Play)
# ──────────────────────────────────────────────────────────────────────────────

if(ANDROID)
    check_linker_flag(CXX "-Wl,-z,max-page-size=16384" DESPIA_LOCAL_HAS_MAX_PAGE_SIZE)
    if(DESPIA_LOCAL_HAS_MAX_PAGE_SIZE)
        target_link_options(despia_local PRIVATE "-Wl,-z,max-page-size=16384")
    else()
        # NDK r28+ aligns to 16 KiB by default, so a toolchain that rejects the
        # flag is not automatically broken - but it is not automatically fine
        # either, and the staged .so is ELF-verified before it ships.
        message(WARNING "despia-local: -z max-page-size=16384 unsupported by this linker; "
                        "the 16 KiB floor now depends entirely on the NDK default")
    endif()
endif()

# ──────────────────────────────────────────────────────────────────────────────
# The ABI's own test. Not shipped; run by the lanes that can compile C++.
#
# It drives the real library over the real vendored SQLite, on a temporary
# directory it creates and removes. There is no fake store behind it and no
# fixture data baked into it: the corpus in OpenSource/Conformance/local is what
# pins BEHAVIOUR across the three runtimes, and this is what pins the SEAM -
# ownership, typed absence, the error contract, and the fact that the .so a lane
# just built can actually be opened and driven.
# ──────────────────────────────────────────────────────────────────────────────

if(DESPIA_LOCAL_BUILD_TESTS)
    add_executable(despia_local_abi_test engine/test/abi_test.cpp)
    set_target_properties(despia_local_abi_test PROPERTIES OUTPUT_NAME abi_test)
    target_link_libraries(despia_local_abi_test PRIVATE despia_local)
    target_include_directories(despia_local_abi_test PRIVATE engine/include)
    target_compile_options(despia_local_abi_test PRIVATE -Wall -Wextra)
endif()
