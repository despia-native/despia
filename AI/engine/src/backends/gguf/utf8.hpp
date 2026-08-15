// utf8.hpp - a token is not a character.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Extracted from the gguf backend so it can be tested directly. It has to be:
// an end-to-end test only reaches this code when the model happens to emit a
// character the tokenizer split, which it may not do on any given prompt. A
// test that passes whether or not the fix is present is not a test, and this
// one passed with the fix reverted before it was moved here.

#ifndef DESPIA_AI_GGUF_UTF8_HPP
#define DESPIA_AI_GGUF_UTF8_HPP

#include <cstddef>
#include <string>

namespace despia {
namespace ai {
namespace gguf {

// How many bytes of `s` form COMPLETE UTF-8 sequences.
//
// llama's token_to_piece returns the bytes of ONE token, and a token is not a
// character: a CJK ideograph or an emoji is routinely split across two or three
// tokens. Emitting a piece raw therefore ships an incomplete sequence, which is
// not "slightly wrong text" - it is invalid UTF-8 that a binding either drops
// or turns into a replacement character. The fix is to carry the tail until the
// bytes that finish it arrive, which is why this returns a LENGTH rather than
// validating in place.
inline size_t completeUtf8Prefix(const std::string& s) {
  size_t i = 0;
  while (i < s.size()) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    size_t need = 0;
    if (c < 0x80) need = 1;
    else if ((c & 0xE0) == 0xC0) need = 2;
    else if ((c & 0xF0) == 0xE0) need = 3;
    else if ((c & 0xF8) == 0xF0) need = 4;
    else return i;                    // a stray continuation byte: not our tail
    if (i + need > s.size()) return i; // the rest has not arrived yet
    for (size_t k = 1; k < need; k++) {
      if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80) return i;
    }
    i += need;
  }
  return i;
}

}  // namespace gguf
}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_GGUF_UTF8_HPP
