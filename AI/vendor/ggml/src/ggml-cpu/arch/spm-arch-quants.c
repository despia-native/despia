// SPM arch dispatch — quantisation kernels.
//
// NOT upstream. This file is added by Despia and is the only kind of edit
// vendor/ may carry beyond the two documented patches: it adds a file, it
// changes none.
//
// WHY IT HAS TO EXIST. ggml selects its CPU kernels by ARCHITECTURE, and it
// does it in CMake: `arch/arm/quants.c` on ARM, `arch/x86/quants.c` on x86.
// The two files define the SAME 27 symbols — they are two implementations of
// one interface, not two halves of one. CMake compiles exactly one.
//
// SwiftPM has no equivalent. A target's `sources` list is static, and the only
// condition it understands is `.when(platforms:)` — PLATFORM, not
// architecture. macOS alone spans arm64 and x86_64, so no platform predicate
// can express "the ARM kernels here, the x86 kernels there". Listing both is a
// duplicate-symbol link failure; listing one breaks the other architecture.
//
// So the dispatch moves to the preprocessor, which is the one selector that
// runs per-architecture inside a single SwiftPM target. Package.swift compiles
// this file and excludes `arch/arm` and `arch/x86` from the glob.
//
// The vendored files stay byte-identical. A `#include "..."` inside them still
// resolves against THEIR OWN directory (the C preprocessor searches from the
// directory of the file containing the directive, not the file that pulled it
// in), so `../../quants.h` still means `ggml-cpu/quants.h`. Verified: the
// object this produces defines exactly the same symbol set as compiling the
// arch file directly.
//
// No `#else` fallback on purpose. ggml has a generic path (GGML_CPU_GENERIC),
// but reaching it silently would mean an Apple build quietly losing every NEON
// kernel and running several times slower with nothing to show for it. An
// architecture nobody checked stops the build instead.

#if defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
#  include "arm/quants.c"
#elif defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
#  include "x86/quants.c"
#else
#  error "despia-ai: no ggml CPU quant kernels for this architecture. Add an arch/ row above, or build with GGML_CPU_GENERIC and accept the generic kernels deliberately."
#endif
