# Despia AI - the native build.
#
# Copyright Despia. Licensed under the Apache License, Version 2.0.
#
# One library, one name (libdespia_ai), dependencies linked statically inside.
# Consumed by the Android lane through the Kotlin binding's externalNativeBuild
# and by the desktop lanes directly; the Swift lane builds the same sources
# through Package.swift instead.
#
# THE VENDORED ENGINES. `vendor/` carries pruned, pinned copies of ggml,
# llama.cpp and whisper.cpp (pins and prune lists in vendor/VERSIONS, the
# how-and-why in docs/vendoring.md). Three properties this file is responsible
# for, each of which is verified rather than asserted:
#
#   1. ONE SHARED ggml. `vendor/ggml/` is added FIRST and defines the `ggml`
#      target; llama.cpp and whisper.cpp both guard their own copy behind
#      `if (NOT TARGET ggml)`, so they bind to ours. Their bundled ggml trees
#      were deleted at import, so there is no second copy to drift from - if
#      this ordering is ever broken, the vendored CMake fails loudly on a
#      missing ggml/ directory instead of quietly building two.
#
#   2. THE .so EXPORTS THE ELEVEN despia_ai_* SYMBOLS AND NOTHING ELSE. Hidden
#      visibility is the first layer (the vendored code obeys it because it is
#      built static, so GGML_API/LLAMA_API/WHISPER_API expand to nothing); an
#      export map is the second. Both matter: a host app that links its OWN ggml
#      - a plausible thing for an app with another AI SDK in it - gets a
#      duplicate-symbol collision or, worse, silently binds one library's calls
#      to the other's implementation. `check_ai_size.rb` re-checks this on the
#      built artifact.
#
#   3. 16 KiB PAGE ALIGNMENT on Android. Android 15+ devices ship 16 KiB pages
#      and Google Play requires 16 KiB-aligned native code; a 4 KiB-aligned .so
#      simply will not load. Guarded by a linker-feature probe so a toolchain
#      without the flag degrades to a warning rather than a broken configure.
#
# Backends are selectable so the mock-only build stays cheap: -DDESPIA_AI_LLAMA=OFF
# -DDESPIA_AI_WHISPER=OFF builds the core + MockEngine alone, which is what a
# gate that only needs the deterministic backend should ask for.
#
# THE JVM DOOR (-DDESPIA_AI_JNI=ON). Desktop - Windows and Linux - consumes this
# package as a plain Maven JAR with per-OS classifier natives, because an AAR
# cannot serve Compose Desktop or a server-side JVM. That face needs the JNI
# entry points, and it gets them the SAME way the Android module already does:
# compiled INTO this target, not into a second .so beside it (the precedent is
# ClosedSource/DSX/Modules/Core/LocalAI/kotlin/jni/CMakeLists.txt, which had to
# re-write the export map from outside the package to achieve it). One library
# means one file to extract, one thing to load, no rpath, no load ORDER, and one
# place where the eleven ABI symbols and the JVM's door both live.
#
# It costs exactly one thing, and property 2 above is why it has to be stated:
# with -DDESPIA_AI_JNI=ON the export map necessarily also names
# `Java_com_despia_ai_*` and `JNI_OnLoad`, or the JVM could not bind a single
# method. It names NOTHING else - the vendored engines stay confined either way,
# which is the property that actually matters and the one check_ai_size.rb
# re-checks. Default OFF, so the artifact that gate measures is unchanged.

cmake_minimum_required(VERSION 3.22)
project(despia_ai CXX C)

include(CheckLinkerFlag)

option(DESPIA_AI_LLAMA       "despia-ai: build the llama.cpp text backend"   ON)
option(DESPIA_AI_WHISPER     "despia-ai: build the whisper.cpp speech backend" ON)
option(DESPIA_AI_BUILD_TESTS "despia-ai: build the ABI test"                 ON)
option(DESPIA_AI_JNI         "despia-ai: compile the JVM (JNI) door into the library" OFF)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Set BEFORE any target is created: these variables seed the matching target
# properties at add_library() time, which is how the vendored subprojects
# inherit them without a single patch to their CMake.
set(CMAKE_C_VISIBILITY_PRESET   hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/VERSION" DESPIA_AI_VERSION_STRING LIMIT_COUNT 1)

# ──────────────────────────────────────────────────────────────────────────────
# The vendored engines
# ──────────────────────────────────────────────────────────────────────────────

if(DESPIA_AI_LLAMA OR DESPIA_AI_WHISPER)
    # Static, always. A shared ggml/llama/whisper would defeat both the single
    # -library promise and the export map, and BUILD_SHARED_LIBS is a cache
    # variable a consumer may well have ON for their own reasons. It has to be
    # forced into the CACHE: the vendored trees declare it with option(), which
    # under CMP0077-OLD clears a plain variable of the same name.
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

    # ggml's build stamp, from the pin record rather than from `git rev-parse` in
    # the embedding repository - see the vendor patch in vendor/ggml/CMakeLists.txt.
    # vendor/VERSIONS is the single source of truth for what is vendored, so the
    # library's own self-report reads from it too.
    set(DESPIA_AI_GGML_COMMIT "unknown")
    file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/VERSIONS" _despia_ai_ggml_pin
         REGEX "^ggml[ \t]+[0-9a-f]+")
    if(_despia_ai_ggml_pin)
        list(GET _despia_ai_ggml_pin 0 _despia_ai_ggml_pin)
        string(REGEX MATCH "[0-9a-f]+" DESPIA_AI_GGML_COMMIT "${_despia_ai_ggml_pin}")
        string(SUBSTRING "${DESPIA_AI_GGML_COMMIT}" 0 8 DESPIA_AI_GGML_COMMIT)
    endif()
    set(GGML_BUILD_COMMIT "${DESPIA_AI_GGML_COMMIT}")

    # Portability over host tuning: -march=native would bake the build machine's
    # ISA into a library that ships to phones, and would make the size gate
    # depend on which runner ran it.
    set(GGML_NATIVE      OFF CACHE BOOL "" FORCE)
    set(GGML_BACKEND_DL  OFF CACHE BOOL "" FORCE)
    set(GGML_CPU_ALL_VARIANTS OFF CACHE BOOL "" FORCE)

    # Upstream's warning walls are for upstream's CI. Ours are on our own code.
    set(GGML_ALL_WARNINGS    OFF CACHE BOOL "" FORCE)
    set(LLAMA_ALL_WARNINGS   OFF CACHE BOOL "" FORCE)
    set(WHISPER_ALL_WARNINGS OFF CACHE BOOL "" FORCE)

    # ONE shared ggml - this line is the de-duplication. Everything below binds
    # to the `ggml` target it defines.
    add_subdirectory(vendor/ggml EXCLUDE_FROM_ALL)
endif()

if(DESPIA_AI_LLAMA)
    if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/llama.cpp/CMakeLists.txt")
        message(FATAL_ERROR "DESPIA_AI_LLAMA is ON but vendor/llama.cpp is not present")
    endif()
    add_subdirectory(vendor/llama.cpp EXCLUDE_FROM_ALL)
endif()

if(DESPIA_AI_WHISPER)
    if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/whisper.cpp/CMakeLists.txt")
        message(FATAL_ERROR "DESPIA_AI_WHISPER is ON but vendor/whisper.cpp is not present")
    endif()
    add_subdirectory(vendor/whisper.cpp EXCLUDE_FROM_ALL)
    # whisper.cpp's src/ also declares `parakeet`, a second ASR model we do not
    # link. EXCLUDE_FROM_ALL above already keeps it out of `all`; naming it here
    # is the record that it is unbuilt ON PURPOSE and not by accident, so nobody
    # "fixes" the vendored CMake to build it.
endif()

# ──────────────────────────────────────────────────────────────────────────────
# The library
# ──────────────────────────────────────────────────────────────────────────────

add_library(despia_ai SHARED
    engine/src/context.cpp
    engine/src/api.cpp
    engine/src/backends/g2p/g2p_backend.cpp
    mock/mock_backend.cpp
)

target_include_directories(despia_ai PUBLIC engine/include)
target_compile_definitions(despia_ai PRIVATE DESPIA_AI_VERSION="${DESPIA_AI_VERSION_STRING}")
target_compile_definitions(despia_ai PRIVATE DESPIA_AI_BUILDING=1)
if(MSVC)
    # cl.exe silently ignores -Wextra and warns about the flag itself, so the
    # windows-x64 lane would build under a warning level nobody chose. /W3 is
    # the nearest thing MSVC has to the wall this project builds under.
    target_compile_options(despia_ai PRIVATE /W3)
else()
    target_compile_options(despia_ai PRIVATE -Wall -Wextra)
endif()

if(DESPIA_AI_LLAMA)
    target_sources(despia_ai PRIVATE engine/src/backends/gguf/gguf_backend.cpp)
    target_link_libraries(despia_ai PRIVATE llama)
    target_compile_definitions(despia_ai PRIVATE DESPIA_AI_HAVE_LLAMA=1)
endif()

if(DESPIA_AI_WHISPER)
    target_sources(despia_ai PRIVATE engine/src/backends/whisper/whisper_backend.cpp)
    target_link_libraries(despia_ai PRIVATE whisper)
    target_compile_definitions(despia_ai PRIVATE DESPIA_AI_HAVE_WHISPER=1)
endif()

# ──────────────────────────────────────────────────────────────────────────────
# The JVM door
#
# jni.h comes from four places and they are tried in the order of how much the
# builder had to say about it: an explicit override (which is how a cross build
# for a foreign OS names the right jni_md.h), the NDK sysroot (Android carries
# it), a found JDK, then JAVA_HOME by hand. If none of them answers, this stops
# rather than emitting a library whose JVM methods silently fail to bind.
# ──────────────────────────────────────────────────────────────────────────────

if(DESPIA_AI_JNI)
    set(DESPIA_AI_JNI_INCLUDE_DIRS "" CACHE STRING
        "jni.h + jni_md.h include directories (a cross build names the TARGET JDK's here)")

    if(DESPIA_AI_JNI_INCLUDE_DIRS)
        set(_despia_ai_jni_includes "${DESPIA_AI_JNI_INCLUDE_DIRS}")
    elseif(ANDROID)
        set(_despia_ai_jni_includes "")          # the NDK sysroot already carries jni.h
    else()
        find_package(JNI QUIET COMPONENTS Development)
        if(JNI_FOUND AND JNI_INCLUDE_DIRS)
            set(_despia_ai_jni_includes "${JNI_INCLUDE_DIRS}")
        elseif(DEFINED ENV{JAVA_HOME} AND EXISTS "$ENV{JAVA_HOME}/include/jni.h")
            # jni_md.h lives in a per-OS subdirectory whose name is the JDK's
            # word for the platform, not CMake's. All three are listed because
            # only one of them exists in any given JDK.
            set(_despia_ai_jni_includes
                "$ENV{JAVA_HOME}/include"
                "$ENV{JAVA_HOME}/include/linux"
                "$ENV{JAVA_HOME}/include/darwin"
                "$ENV{JAVA_HOME}/include/win32")
        else()
            message(FATAL_ERROR
                "DESPIA_AI_JNI is ON but jni.h was not found. Set JAVA_HOME, or pass "
                "-DDESPIA_AI_JNI_INCLUDE_DIRS=<dir>[;<dir>] naming the TARGET JDK's headers.")
        endif()
    endif()

    list(FILTER _despia_ai_jni_includes EXCLUDE REGEX "^$")
    foreach(_dir IN LISTS _despia_ai_jni_includes)
        if(EXISTS "${_dir}")
            target_include_directories(despia_ai PRIVATE "${_dir}")
        endif()
    endforeach()

    target_sources(despia_ai PRIVATE bindings/jni/despia_ai_jni.cpp)
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

# The JVM door is opened by NAME, so when it is compiled in the map has to let
# it through - an export map that hid `Java_com_despia_ai_*` would leave every
# `external fun` unbindable and the failure would arrive at the first call, not
# at link time. Two lines, both globs, and nothing else joins them.
set(DESPIA_AI_EXTRA_GLOBALS "")
set(DESPIA_AI_EXTRA_SYMBOLS "")
if(DESPIA_AI_JNI)
    set(DESPIA_AI_EXTRA_GLOBALS "    Java_com_despia_ai_*;\n    JNI_OnLoad;\n")
    set(DESPIA_AI_EXTRA_SYMBOLS "_Java_com_despia_ai_*\n_JNI_OnLoad\n")
endif()

# file(WRITE), not file(GENERATE): check_linker_flag runs during configure and
# needs the script to exist by then.
set(DESPIA_AI_VERSION_SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/despia_ai.map")
file(WRITE "${DESPIA_AI_VERSION_SCRIPT}"
     "{\n  global:\n    despia_ai_*;\n${DESPIA_AI_EXTRA_GLOBALS}  local:\n    *;\n};\n")

set(DESPIA_AI_SYMBOL_LIST "${CMAKE_CURRENT_BINARY_DIR}/despia_ai.symbols")
file(WRITE "${DESPIA_AI_SYMBOL_LIST}"
     "_despia_ai_abi_version\n_despia_ai_cancel\n_despia_ai_capabilities\n_despia_ai_close\n"
     "_despia_ai_free\n_despia_ai_last_error\n_despia_ai_load_model\n_despia_ai_open\n"
     "_despia_ai_request\n_despia_ai_sync\n_despia_ai_unload_model\n"
     "${DESPIA_AI_EXTRA_SYMBOLS}")

if(APPLE)
    check_linker_flag(CXX "-Wl,-exported_symbols_list,${DESPIA_AI_SYMBOL_LIST}" DESPIA_AI_HAS_EXPORTED_LIST)
    if(DESPIA_AI_HAS_EXPORTED_LIST)
        target_link_options(despia_ai PRIVATE "-Wl,-exported_symbols_list,${DESPIA_AI_SYMBOL_LIST}")
        set_property(TARGET despia_ai APPEND PROPERTY LINK_DEPENDS "${DESPIA_AI_SYMBOL_LIST}")
    else()
        message(WARNING "despia-ai: -exported_symbols_list unsupported; relying on hidden visibility alone")
    endif()
elseif(NOT MSVC)
    check_linker_flag(CXX "-Wl,--version-script=${DESPIA_AI_VERSION_SCRIPT}" DESPIA_AI_HAS_VERSION_SCRIPT)
    if(DESPIA_AI_HAS_VERSION_SCRIPT)
        target_link_options(despia_ai PRIVATE "-Wl,--version-script=${DESPIA_AI_VERSION_SCRIPT}")
        set_property(TARGET despia_ai APPEND PROPERTY LINK_DEPENDS "${DESPIA_AI_VERSION_SCRIPT}")
    else()
        message(WARNING "despia-ai: --version-script unsupported; relying on hidden visibility alone")
    endif()

    # Belt to the version script's braces: keeps a static archive's symbols out
    # of the dynamic table even if the map is ever loosened.
    check_linker_flag(CXX "-Wl,--exclude-libs,ALL" DESPIA_AI_HAS_EXCLUDE_LIBS)
    if(DESPIA_AI_HAS_EXCLUDE_LIBS)
        target_link_options(despia_ai PRIVATE "-Wl,--exclude-libs,ALL")
    endif()
endif()

# ──────────────────────────────────────────────────────────────────────────────
# 16 KiB page size (Android 15+ / Google Play)
# ──────────────────────────────────────────────────────────────────────────────

if(ANDROID)
    check_linker_flag(CXX "-Wl,-z,max-page-size=16384" DESPIA_AI_HAS_MAX_PAGE_SIZE)
    if(DESPIA_AI_HAS_MAX_PAGE_SIZE)
        target_link_options(despia_ai PRIVATE "-Wl,-z,max-page-size=16384")
    else()
        # NDK r28+ aligns to 16 KiB by default, so a toolchain that rejects the
        # flag is not automatically broken - but it is not automatically fine
        # either, and the staged .so is ELF-verified before it ships.
        message(WARNING "despia-ai: -z max-page-size=16384 unsupported by this linker; "
                        "the 16 KiB floor now depends entirely on the NDK default")
    endif()
endif()

# ──────────────────────────────────────────────────────────────────────────────
# The ABI's own test. Not shipped; run by the lanes that can compile C++.
# ──────────────────────────────────────────────────────────────────────────────

if(DESPIA_AI_BUILD_TESTS)
    add_executable(despia_ai_abi_test engine/test/abi_test.cpp)
    set_target_properties(despia_ai_abi_test PROPERTIES OUTPUT_NAME abi_test)
    target_link_libraries(despia_ai_abi_test PRIVATE despia_ai)
    target_include_directories(despia_ai_abi_test PRIVATE engine/include)

    # The grammar compiler is header-only and pure logic, so its test needs no
    # model, no device and not even the shared object.
    # The GGUF pre-flight walker. Constructed fixtures only, no network and no
    # model file: its key case walks EVERY prefix of a valid metadata table and
    # asserts none of them is called a defect, which is the bug that rejected
    # three real models by blaming the file for the reader's buffer size.
    add_executable(despia_ai_preflight_test engine/test/preflight_test.cpp)
    set_target_properties(despia_ai_preflight_test PROPERTIES OUTPUT_NAME preflight_test)
    target_compile_options(despia_ai_preflight_test PRIVATE -Wall -Wextra)

    # The grapheme-to-phoneme frontend. Header-only like the two above, and it
    # carries its own pack encoder, so it needs no pack file and no network. Its
    # centre is the tiling invariant: the tokens, reassembled, must equal the
    # input byte for byte, checked on written cases and on ten thousand random
    # ones. That is the law that makes it impossible for the frontend to lose a
    # word, which is the failure it was built to replace.
    add_executable(despia_ai_g2p_test engine/test/g2p_test.cpp)
    set_target_properties(despia_ai_g2p_test PROPERTIES OUTPUT_NAME g2p_test)
    target_compile_options(despia_ai_g2p_test PRIVATE -Wall -Wextra)

    # The runner for Conformance/ai/g2p. It lives here rather than on a platform
    # lane because there are no platform twins to disagree: Swift, Kotlin and the
    # web all reach this same C++, so running the corpus once against it IS
    # running it everywhere. It fails rather than skips when a corpus file
    # requires an expect key it does not implement, which is the rule that keeps
    # the corpus from rotting into a document nobody executes.
    #
    # The corpus lives outside this package, so its path is compiled in and can
    # also be passed as argv[1]. A runner that cannot find its corpus FAILS; a
    # harness that reports success when its inputs are missing is the failure
    # mode conformance exists to prevent.
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../Conformance/ai/g2p/fixture-pack.json")
        add_executable(despia_ai_g2p_corpus engine/test/g2p_corpus.cpp)
        set_target_properties(despia_ai_g2p_corpus PROPERTIES OUTPUT_NAME g2p_corpus)
        target_compile_options(despia_ai_g2p_corpus PRIVATE -Wall -Wextra)
        target_compile_definitions(despia_ai_g2p_corpus PRIVATE
            DESPIA_AI_G2P_CORPUS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../Conformance/ai/g2p")
    else()
        # The mirror repo vendors the corpus slices it needs; a build without them
        # says so instead of quietly dropping a gate.
        message(STATUS "despia-ai: Conformance/ai/g2p is absent, the G2P corpus runner is not built")
    endif()

    if(DESPIA_AI_LLAMA)
        add_executable(despia_ai_utf8_test engine/test/utf8_test.cpp)
        set_target_properties(despia_ai_utf8_test PROPERTIES OUTPUT_NAME utf8_test)
        target_compile_options(despia_ai_utf8_test PRIVATE -Wall -Wextra)

        add_executable(despia_ai_gbnf_test engine/test/gbnf_test.cpp)
        set_target_properties(despia_ai_gbnf_test PROPERTIES OUTPUT_NAME gbnf_test)
        target_compile_options(despia_ai_gbnf_test PRIVATE -Wall -Wextra)
    endif()

    # The real-weights smoke drivers. NOT part of any gate: they need a model
    # file this repository does not carry, and a test that silently passes when
    # its input is missing is worse than no test. They are built so they cannot
    # rot, and run by hand against a downloaded model:
    #
    #   ./build/model_smoke  /path/to/model.gguf     # does it generate at all
    #   ./build/stream_smoke /path/to/model.gguf     # is it REALLY streaming
    #   ./build/governor_smoke /path/a.gguf /path/b.gguf  # does eviction FIRE
    #
    # stream_smoke is the one that matters for a streaming SDK: it timestamps
    # every event, so batched-at-the-end delivery is visible as every token
    # arriving in the same millisecond rather than spread across the decode.
    #
    # governor_smoke is the one that matters for the memory governor, and for
    # the same reason: the unit test proves the arithmetic, and the arithmetic
    # was never the problem - the mechanism shipped unarmed, with a budget of 0
    # in every context anyone opened. This one loads two real models under a
    # budget that fits one and asks the engine whether the first is still there.
    add_executable(despia_ai_model_smoke engine/test/model_smoke.c)
    set_target_properties(despia_ai_model_smoke PROPERTIES OUTPUT_NAME model_smoke)
    target_link_libraries(despia_ai_model_smoke PRIVATE despia_ai)

    add_executable(despia_ai_stream_smoke engine/test/stream_smoke.c)
    set_target_properties(despia_ai_stream_smoke PROPERTIES OUTPUT_NAME stream_smoke)
    target_link_libraries(despia_ai_stream_smoke PRIVATE despia_ai)

    add_executable(despia_ai_governor_smoke engine/test/governor_smoke.c)
    set_target_properties(despia_ai_governor_smoke PROPERTIES OUTPUT_NAME governor_smoke)
    target_link_libraries(despia_ai_governor_smoke PRIVATE despia_ai)

    # The governor's decisions are arithmetic over recorded state: no model, no
    # device, no thermometer. Which is why they are pinned here - under real
    # pressure these paths run once, at the worst moment, unattended.
    add_executable(despia_ai_governor_test engine/test/governor_test.cpp)
    set_target_properties(despia_ai_governor_test PROPERTIES OUTPUT_NAME governor_test)
    target_compile_options(despia_ai_governor_test PRIVATE -Wall -Wextra)

    # The speech front-end is header-only too: WAV parsing, down-mix and
    # resampling need no model, and they are where the hostile-input bugs are.
    if(DESPIA_AI_WHISPER)
        add_executable(despia_ai_audio_test engine/test/audio_test.cpp)
        set_target_properties(despia_ai_audio_test PROPERTIES OUTPUT_NAME audio_test)
        target_compile_options(despia_ai_audio_test PRIVATE -Wall -Wextra)
    endif()
endif()
