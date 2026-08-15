// preflight.hpp - the bounded format validator that clears a file BEFORE the
// real engine ever maps it.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This exists because arbitrary-origin models are a FEATURE (local-ai-engine.md
// 4.4, D16): an app may allow any model URL its allowlist admits. The four
// locks that make that safe are the origin allowlist, digest discipline, fit
// plus quarantine - and this, the third lock: nothing reaches a memory-mapping
// tensor loader until a small, total, allocation-free parser has agreed the
// file is what it claims to be.
//
// The rules this parser lives by, because it is the code a hostile file meets
// first:
//   - It never allocates based on a number read from the file.
//   - It never seeks past the declared file size.
//   - Every count and length is bounded before it is used.
//   - It returns a reason, never a partial result, and never throws.
//
// It is the subject of the nightly libFuzzer target (docs/abi.md). A parser
// like this one is worth fuzzing precisely because it is the only code that
// runs before the attacker-controlled bytes reach a real loader.

#ifndef DESPIA_AI_PREFLIGHT_HPP
#define DESPIA_AI_PREFLIGHT_HPP

#include <cstdint>
#include <cstring>
#include <string>

namespace despia {
namespace ai {
namespace preflight {

struct Result {
  bool ok = false;
  // Set when the walk ran off the end of the SUPPLIED BUFFER. The file may be
  // perfectly valid; the caller simply did not read far enough. Callers grow
  // their read and retry rather than reporting a refusal.
  bool needs_more = false;
  uint64_t suggested_bytes = 0;
  std::string code;     // format_unrecognized | format_malformed | format_unsupported
  std::string message;
  uint64_t tensor_count = 0;
  uint64_t kv_count = 0;
  uint32_t version = 0;
};

// Reasonable ceilings. A real GGUF has thousands of tensors and hundreds of
// metadata pairs; these bounds are two orders above that and exist so a
// corrupt or hostile count cannot become a loop the process never leaves.
constexpr uint64_t kMaxTensors = 1u << 20;
constexpr uint64_t kMaxKV = 1u << 16;
constexpr uint64_t kMaxStringLen = 1u << 22;

class Reader {
 public:
  Reader(const uint8_t* data, size_t size) : d_(data), n_(size) {}

  bool u32(uint32_t& out) {
    if (n_ - p_ < 4) return exhaust();
    std::memcpy(&out, d_ + p_, 4);
    p_ += 4;
    return true;
  }
  bool u64(uint64_t& out) {
    if (n_ - p_ < 8) return exhaust();
    std::memcpy(&out, d_ + p_, 8);
    p_ += 8;
    return true;
  }
  // A length-prefixed string. The length is checked against BOTH the ceiling
  // and what is actually left in the buffer before a single byte is read.
  bool str(uint64_t maxLen) {
    uint64_t len = 0;
    if (!u64(len)) return false;
    if (len > maxLen) return false;          // implausible: a real defect
    if (len > n_ - p_) return exhaust();     // merely past the end of what we were given
    p_ += static_cast<size_t>(len);
    return true;
  }
  bool skip(uint64_t bytes) {
    if (bytes > n_ - p_) return exhaust();
    p_ += static_cast<size_t>(bytes);
    return true;
  }
  size_t offset() const { return p_; }
  size_t remaining() const { return n_ - p_; }

  // True when a read failed because the BUFFER ended, not because the file is
  // wrong. Conflating the two is how a perfectly good model gets rejected as
  // malformed: the caller hands over a prefix, a large tokenizer vocabulary
  // runs past it, and the file gets blamed for the caller's read size.
  bool exhausted() const { return exhausted_; }

 private:
  bool exhaust() {
    exhausted_ = true;
    return false;
  }

  const uint8_t* d_;
  size_t n_;
  size_t p_ = 0;
  bool exhausted_ = false;
};

// Widths of the GGUF scalar value types, indexed by type id. Zero means
// "not a fixed-width scalar" and is handled explicitly.
inline uint64_t scalarWidth(uint32_t vtype);
// type 8 = string, type 9 = array. Arrays nest exactly one level in GGUF, but
// the depth guard is explicit rather than assumed.
inline bool skipValue(Reader& in, uint32_t vtype, int depth);

// "Give me more bytes", not "your file is broken". Doubling is the caller's
// contract: metadata size is not knowable from the header, so the only honest
// answer is to ask for more and let the caller cap how far it will go.
inline Result truncated(Result& r, size_t size) {
  r.ok = false;
  r.needs_more = true;
  r.suggested_bytes = static_cast<uint64_t>(size) * 2;
  r.code = "format_truncated";
  r.message = "the metadata table runs past the " + std::to_string(size) +
              " bytes supplied; this is not a defect in the file";
  return r;
}

// Validates a GGUF header and metadata table. `data`/`size` may be a PREFIX of
// the file - the header is at the front, so a few hundred kilobytes is enough
// to clear a multi-gigabyte model without reading it.
inline Result validateGGUF(const uint8_t* data, size_t size) {
  Result r;
  if (!data || size < 24) {
    r.code = "format_unrecognized";
    r.message = "file is too short to carry a GGUF header";
    return r;
  }
  if (std::memcmp(data, "GGUF", 4) != 0) {
    r.code = "format_unrecognized";
    r.message = "missing GGUF magic";
    return r;
  }

  Reader in(data, size);
  in.skip(4);  // magic, already checked

  uint32_t version = 0;
  uint64_t tensorCount = 0, kvCount = 0;
  if (!in.u32(version) || !in.u64(tensorCount) || !in.u64(kvCount)) {
    r.code = "format_malformed";
    r.message = "truncated GGUF header";
    return r;
  }
  r.version = version;
  if (version < 2 || version > 3) {
    r.code = "format_unsupported";
    r.message = "GGUF version " + std::to_string(version) + " is outside the supported range";
    return r;
  }
  if (tensorCount > kMaxTensors || kvCount > kMaxKV) {
    r.code = "format_malformed";
    r.message = "declared table sizes are implausible";
    return r;
  }

  // Walk the metadata table. Every value type is length-bounded before it is
  // consumed; an unknown type id ends the walk rather than guessing a width.
  for (uint64_t k = 0; k < kvCount; ++k) {
    if (!in.str(kMaxStringLen)) {
      if (in.exhausted()) return truncated(r, size);
      r.code = "format_malformed";
      r.message = "metadata key " + std::to_string(k) + " declares an implausible length";
      return r;
    }
    uint32_t vtype = 0;
    if (!in.u32(vtype)) {
      if (in.exhausted()) return truncated(r, size);
      r.code = "format_malformed";
      r.message = "truncated metadata value type";
      return r;
    }
    if (!skipValue(in, vtype, 0)) {
      if (in.exhausted()) return truncated(r, size);
      r.code = "format_malformed";
      r.message = "metadata value " + std::to_string(k) + " is malformed";
      return r;
    }
  }

  r.ok = true;
  r.tensor_count = tensorCount;
  r.kv_count = kvCount;
  return r;
}

inline uint64_t scalarWidth(uint32_t vtype) {
  switch (vtype) {
    case 0: case 1: case 7: return 1;   // uint8, int8, bool
    case 2: case 3: return 2;           // uint16, int16
    case 4: case 5: case 6: return 4;   // uint32, int32, float32
    case 10: case 11: case 12: return 8;  // uint64, int64, float64
    default: return 0;
  }
}

inline bool skipValue(Reader& in, uint32_t vtype, int depth) {
  if (depth > 2) return false;
  if (uint64_t w = scalarWidth(vtype)) return in.skip(w);
  if (vtype == 8) return in.str(kMaxStringLen);
  if (vtype == 9) {
    uint32_t elemType = 0;
    uint64_t count = 0;
    if (!in.u32(elemType) || !in.u64(count)) return false;
    if (count > kMaxTensors) return false;
    if (uint64_t w = scalarWidth(elemType)) {
      // The product cannot wrap: `count` was just bounded by kMaxTensors (2^20)
      // and `w` is at most 8, so `w * count` is at most 2^23.
      //
      // Hand the span to skip() rather than deciding here. A span that runs
      // past the SUPPLIED BUFFER is exhaustion - "give me more bytes" - and
      // only skip() records that. Answering a bare `false` made the caller read
      // `!exhausted()` and blame the file, which is exactly how two well-formed
      // models were refused: their first scalar array (LFM2-350M's
      // `tokenizer.ggml.token_type`, nomic-embed-v1.5's `tokenizer.ggml.scores`)
      // straddled the end of the prefix the loader had read, so the read never
      // grew. A STRING array in the same position asked for more and the file
      // loaded. Same class of defect as the Gemma 3 refusal, one layer down:
      // running out of buffer is never evidence about the file.
      return in.skip(w * count);
    }
    for (uint64_t i = 0; i < count; ++i) {
      if (!skipValue(in, elemType, depth + 1)) return false;
    }
    return true;
  }
  return false;  // unknown type id: stop, do not guess a width
}

}  // namespace preflight
}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_PREFLIGHT_HPP
