// SPM arch dispatch — repacked (block-interleaved) kernels.
//
// NOT upstream. The companion to spm-arch-quants.c in this directory; that
// file carries the full reasoning. Same rule, same shape: CMake picks
// `arch/<arch>/repack.cpp` by architecture, SwiftPM cannot, so the choice is
// made by the preprocessor inside one target and Package.swift excludes
// `arch/arm` and `arch/x86` from the glob.

#if defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
#  include "arm/repack.cpp"
#elif defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
#  include "x86/repack.cpp"
#else
#  error "despia-ai: no ggml CPU repack kernels for this architecture. Add an arch/ row above, or build with GGML_CPU_GENERIC and accept the generic kernels deliberately."
#endif
