// text.hpp - the UTF-8 primitives the G2P frontend needs, and nothing else.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Separate from the gguf backend's utf8.hpp on purpose: that one answers "how
// much of this byte string is a whole prefix" for streaming, which is a
// different question from "give me the code points". Merging them would give
// one header two reasons to change.
//
// There are no Unicode tables here, and there will not be any. Case folding and
// diacritic folding are DATA - they arrive in the pack's `fold` map, because the
// engine names no language and a case map is a language's opinion. Turkish
// dotless i is the standing example of why: a table compiled into the engine
// would be wrong for a pack that knows better.

#ifndef DESPIA_AI_G2P_TEXT_HPP
#define DESPIA_AI_G2P_TEXT_HPP

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace despia {
namespace ai {
namespace g2p {

// The code point a malformed byte decodes to. It is U+FFFD, and it is a real
// value rather than a skip: a decoder that drops what it cannot read is the
// same silent-deletion bug this whole frontend exists to prevent, one layer
// down. A replacement character reaches the accept check, fails it honestly,
// and becomes a `refused` token the caller can see.
constexpr uint32_t kReplacement = 0xFFFD;

// Decodes one code point starting at `i`, advancing `i` past it. Always
// advances by at least one byte, so a caller's loop terminates on any input.
inline uint32_t decodeUtf8(const std::string& s, size_t& i) {
  const size_t n = s.size();
  if (i >= n) return 0;
  const unsigned char c0 = static_cast<unsigned char>(s[i]);
  auto cont = [&](size_t k) -> bool {
    return i + k < n && (static_cast<unsigned char>(s[i + k]) & 0xC0) == 0x80;
  };
  auto bits = [&](size_t k) -> uint32_t {
    return static_cast<unsigned char>(s[i + k]) & 0x3F;
  };
  if (c0 < 0x80) {
    ++i;
    return c0;
  }
  if ((c0 & 0xE0) == 0xC0 && cont(1)) {
    const uint32_t cp = ((c0 & 0x1Fu) << 6) | bits(1);
    i += 2;
    return cp < 0x80 ? kReplacement : cp;  // overlong
  }
  if ((c0 & 0xF0) == 0xE0 && cont(1) && cont(2)) {
    const uint32_t cp = ((c0 & 0x0Fu) << 12) | (bits(1) << 6) | bits(2);
    i += 3;
    if (cp < 0x800) return kReplacement;                 // overlong
    if (cp >= 0xD800 && cp <= 0xDFFF) return kReplacement;  // lone surrogate
    return cp;
  }
  if ((c0 & 0xF8) == 0xF0 && cont(1) && cont(2) && cont(3)) {
    const uint32_t cp =
        ((c0 & 0x07u) << 18) | (bits(1) << 12) | (bits(2) << 6) | bits(3);
    i += 4;
    return (cp < 0x10000 || cp > 0x10FFFF) ? kReplacement : cp;
  }
  ++i;
  return kReplacement;
}

inline void encodeUtf8(uint32_t cp, std::string& out) {
  if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = kReplacement;
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

inline std::vector<uint32_t> codePoints(const std::string& s) {
  std::vector<uint32_t> out;
  out.reserve(s.size());
  size_t i = 0;
  while (i < s.size()) out.push_back(decodeUtf8(s, i));
  return out;
}

inline std::string fromCodePoint(uint32_t cp) {
  std::string out;
  encodeUtf8(cp, out);
  return out;
}

}  // namespace g2p
}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_G2P_TEXT_HPP
