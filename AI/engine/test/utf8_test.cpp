// utf8_test.cpp - the split-character carry, tested where it can actually fail.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This test exists because the end-to-end one did not work. Driving a real
// model with a multilingual prompt and asserting every event was valid UTF-8
// passed BOTH with the carry and with it reverted, because that particular
// generation never happened to split a character across tokens. A test that is
// green whether or not the code is present measures nothing, and the only way
// to find that out is to break the code on purpose and watch.
//
// So the split is constructed here rather than hoped for. Each case feeds the
// exact byte boundaries llama's token_to_piece produces when a character spans
// two tokens.

#include <cstdio>
#include <string>

#include "../src/backends/gguf/utf8.hpp"

using despia::ai::gguf::completeUtf8Prefix;

namespace {

int g_failures = 0;

void check(bool cond, const char* what) {
  if (cond) {
    std::printf("  ok   %s\n", what);
  } else {
    std::printf("  FAIL %s\n", what);
    g_failures++;
  }
}

}  // namespace

int main() {
  std::printf("utf8_test\n");

  // ── whole input, nothing carried ───────────────────────────────────────────
  check(completeUtf8Prefix("") == 0, "empty carries nothing");
  check(completeUtf8Prefix("hello") == 5, "plain ASCII is entirely complete");
  check(completeUtf8Prefix("caf\xC3\xA9") == 5, "a complete 2-byte character passes whole");
  check(completeUtf8Prefix("\xE4\xBD\xA0\xE5\xA5\xBD") == 6, "two complete CJK characters");
  check(completeUtf8Prefix("\xF0\x9F\x8E\x89") == 4, "a complete 4-byte emoji");

  // ── the case this code exists for: a character cut mid-sequence ────────────
  // A CJK ideograph is three bytes. A token boundary can fall after one or two
  // of them, and emitting that prefix ships bytes no decoder can read.
  check(completeUtf8Prefix("\xE4") == 0, "a lone CJK lead byte carries entirely");
  check(completeUtf8Prefix("\xE4\xBD") == 0, "two of three bytes still carry");
  check(completeUtf8Prefix("\xE4\xBD\xA0") == 3, "the third byte completes it");

  // An emoji is four, so it can be cut three different ways.
  check(completeUtf8Prefix("\xF0") == 0, "a lone emoji lead byte carries");
  check(completeUtf8Prefix("\xF0\x9F") == 0, "two of four carry");
  check(completeUtf8Prefix("\xF0\x9F\x8E") == 0, "three of four carry");
  check(completeUtf8Prefix("\xF0\x9F\x8E\x89") == 4, "four completes");

  // ── the mixed case, which is what actually streams ─────────────────────────
  // Complete text followed by the start of a character. The complete part must
  // go out NOW - holding it would stall the stream on every multi-byte word -
  // and only the fragment waits.
  check(completeUtf8Prefix("Hi \xE4\xBD") == 3,
        "complete text is emitted immediately and only the fragment waits");
  check(completeUtf8Prefix("\xE4\xBD\xA0 there\xF0\x9F") == 9,
        "a completed character plus text, with the next fragment held back");

  // ── malformed input is not a fragment and must not be carried forever ─────
  // A stray continuation byte can never be completed by more bytes arriving,
  // so treating it as a fragment would stall the stream permanently.
  check(completeUtf8Prefix("\xA0") == 0, "a stray continuation byte does not advance");
  check(completeUtf8Prefix("ok\xA0") == 2, "text before it still goes out");
  check(completeUtf8Prefix("\xFF\xFE") == 0, "bytes that are not UTF-8 at all do not advance");

  // A lead byte promising a continuation that turns out to be garbage is
  // malformed rather than incomplete, and must not be held either.
  check(completeUtf8Prefix("\xE4\x41\x42") == 0,
        "a lead byte followed by non-continuation bytes is malformed, not partial");

  if (g_failures == 0) {
    std::printf("\nall checks passed\n");
    return 0;
  }
  std::printf("\n%d failure(s)\n", g_failures);
  return 1;
}
