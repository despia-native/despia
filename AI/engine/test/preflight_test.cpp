// preflight_test.cpp - the bounded GGUF validator, held to one rule.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// THE RULE: running out of the buffer the caller supplied is never evidence
// about the file. The validator is handed a PREFIX of a multi-gigabyte model,
// so "I reached the end of what you gave me" and "this file is broken" are
// different answers and must never be collapsed. When they are collapsed, the
// caller's growth loop never grows and a good model is refused forever.
//
// That collapse has now happened twice, at two layers:
//
//   1. A large tokenizer vocabulary (a STRING array) ran past a fixed 256 KiB
//      read, and Gemma 3 was reported `format_malformed`. Fixed by giving
//      Result a `needs_more` flag and the loader a doubling read.
//   2. The scalar-array fast path decided the same question itself, with a
//      bare `return false` that never reached `exhaust()`. LFM2-350M
//      (`tokenizer.ggml.token_type`, array<int32> x 65536, straddling the
//      1 MiB read) and nomic-embed-text-v1.5 (`tokenizer.ggml.scores`,
//      array<float32> x 30522, straddling the 512 KiB read) were both reported
//      `format_malformed`. Both files are well formed and both now load.
//
// The fixtures below are CONSTRUCTED byte by byte - no model is downloaded, so
// this test needs no network and cannot rot when a repo moves. Each one is the
// smallest file that reproduces the shape.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../src/preflight.hpp"

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

// ── fixture construction ─────────────────────────────────────────────────────

void putU32(std::vector<uint8_t>& b, uint32_t v) {
  const size_t at = b.size();
  b.resize(at + 4);
  std::memcpy(b.data() + at, &v, 4);
}

void putU64(std::vector<uint8_t>& b, uint64_t v) {
  const size_t at = b.size();
  b.resize(at + 8);
  std::memcpy(b.data() + at, &v, 8);
}

void putStr(std::vector<uint8_t>& b, const std::string& s) {
  putU64(b, s.size());
  b.insert(b.end(), s.begin(), s.end());
}

// A GGUF v3 header: magic, version, tensor count, kv count.
std::vector<uint8_t> header(uint64_t tensorCount, uint64_t kvCount, uint32_t version = 3) {
  std::vector<uint8_t> b;
  b.insert(b.end(), {'G', 'G', 'U', 'F'});
  putU32(b, version);
  putU64(b, tensorCount);
  putU64(b, kvCount);
  return b;
}

// One metadata pair whose value is an array of `count` elements of a
// FIXED-WIDTH scalar type - the shape that was misreported. `elemType` is a
// GGUF value-type id: 5 = int32 (LFM2's token_type), 6 = float32 (nomic's
// scores).
void putScalarArray(std::vector<uint8_t>& b, const std::string& key, uint32_t elemType,
                    uint64_t count, uint64_t width) {
  putStr(b, key);
  putU32(b, 9);  // value type: array
  putU32(b, elemType);
  putU64(b, count);
  b.resize(b.size() + static_cast<size_t>(width * count), 0);
}

// The same pair, but an array of STRINGS - the shape that behaved correctly
// and so hid the defect for as long as it did.
void putStringArray(std::vector<uint8_t>& b, const std::string& key, uint64_t count,
                    const std::string& each) {
  putStr(b, key);
  putU32(b, 9);  // value type: array
  putU32(b, 8);  // element type: string
  putU64(b, count);
  for (uint64_t i = 0; i < count; ++i) putStr(b, each);
}

// ── the tests ────────────────────────────────────────────────────────────────

// A file that IS valid, cut short at a byte inside its scalar array. This is
// the exact position LFM2-350M and nomic-embed-v1.5 were refused at.
void testScalarArrayStraddlingTheBuffer() {
  std::printf("preflight: a scalar array that straddles the supplied prefix\n");
  using namespace despia::ai::preflight;

  for (const auto& elem : {std::pair<uint32_t, uint64_t>{5, 4},    // int32
                           std::pair<uint32_t, uint64_t>{6, 4},    // float32
                           std::pair<uint32_t, uint64_t>{11, 8}}) {  // int64
    std::vector<uint8_t> file = header(0, 1);
    putScalarArray(file, "tokenizer.ggml.token_type", elem.first, 4096, elem.second);

    const Result whole = validateGGUF(file.data(), file.size());
    check(whole.ok, "the whole file passes");

    // Now hand over a prefix that ends INSIDE the array's payload.
    const size_t cut = file.size() - 64;
    const Result prefix = validateGGUF(file.data(), cut);
    check(!prefix.ok, "a prefix that ends inside the array does not pass");
    check(prefix.needs_more,
          "and it asks for more bytes rather than reporting format_malformed");
    check(prefix.code == "format_truncated", "the code names truncation, not a defect");
    check(prefix.suggested_bytes > cut, "it suggests a larger read");
  }
}

// The asymmetry that WAS the bug: two files identical in every way that
// matters, differing only in whether the array that straddles the buffer holds
// strings or scalars, must get the same answer.
void testStringAndScalarArraysAgree() {
  std::printf("preflight: string and scalar arrays answer a short buffer alike\n");
  using namespace despia::ai::preflight;

  std::vector<uint8_t> scalars = header(0, 1);
  putScalarArray(scalars, "tokenizer.ggml.scores", 6, 2048, 4);

  std::vector<uint8_t> strings = header(0, 1);
  putStringArray(strings, "tokenizer.ggml.tokens", 512, "tok");

  const Result a = validateGGUF(scalars.data(), scalars.size() - 32);
  const Result b = validateGGUF(strings.data(), strings.size() - 32);
  check(a.needs_more && b.needs_more,
        "both shapes report a short buffer as a short buffer");
  check(a.code == b.code, "and they report it with the same code");
}

// The bound that must NOT be relaxed by the fix: an element count above the
// ceiling is a defect no further read can repair, and the caller must stop
// rather than double its read forever.
void testImplausibleArrayCountIsStillADefect() {
  std::printf("preflight: an implausible array count is still a defect\n");
  using namespace despia::ai::preflight;

  std::vector<uint8_t> file = header(0, 1);
  putStr(file, "tokenizer.ggml.token_type");
  putU32(file, 9);           // array
  putU32(file, 5);           // int32
  putU64(file, kMaxTensors + 1);  // one past the ceiling

  const Result r = validateGGUF(file.data(), file.size());
  check(!r.ok, "it is refused");
  check(!r.needs_more, "and NOT as a short read - no further bytes would help");
  check(r.code == "format_malformed", "it is reported as malformed");
}

// The product `width * count` must not be able to wrap before it is used. The
// ceiling above is what guarantees it: at most 2^20 elements of at most 8
// bytes is 2^23, so no count that reaches the multiply can overflow.
void testWidestScalarAtTheCeilingDoesNotWrap() {
  std::printf("preflight: the widest scalar at the ceiling cannot wrap the multiply\n");
  using namespace despia::ai::preflight;

  std::vector<uint8_t> file = header(0, 1);
  putStr(file, "big");
  putU32(file, 9);            // array
  putU32(file, 12);           // float64 - the widest scalar, 8 bytes
  putU64(file, kMaxTensors);  // exactly at the ceiling: 8 MiB of payload

  // The payload is not present, so this is a short buffer - and it must be
  // reported as one, not as a wrapped length that quietly skips zero bytes.
  const Result r = validateGGUF(file.data(), file.size());
  check(!r.ok && r.needs_more, "an absent 8 MiB payload is a short read");
  check(r.suggested_bytes > file.size(), "and the caller is told to read further");
}

// A nested array is bounded by depth, and the guard is structural: no read
// size changes the answer.
void testArrayNestingIsDepthBounded() {
  std::printf("preflight: array nesting is depth bounded\n");
  using namespace despia::ai::preflight;

  std::vector<uint8_t> file = header(0, 1);
  putStr(file, "nested");
  putU32(file, 9);  // array
  putU32(file, 9);  // of arrays
  putU64(file, 1);
  putU32(file, 9);  // of arrays
  putU64(file, 1);
  putU32(file, 9);  // of arrays - one level too deep
  putU64(file, 1);
  putU32(file, 5);
  putU64(file, 1);
  putU32(file, 0);

  const Result r = validateGGUF(file.data(), file.size());
  check(!r.ok && !r.needs_more, "over-deep nesting is a defect, not a short read");
}

// One level of nesting is legal and must still pass.
void testSingleLevelNestingPasses() {
  std::printf("preflight: one level of array nesting passes\n");
  using namespace despia::ai::preflight;

  std::vector<uint8_t> file = header(0, 1);
  putStr(file, "nested");
  putU32(file, 9);  // array
  putU32(file, 9);  // of arrays
  putU64(file, 2);
  for (int i = 0; i < 2; ++i) {
    putU32(file, 5);  // int32
    putU64(file, 3);
    file.resize(file.size() + 12, 0);
  }

  const Result r = validateGGUF(file.data(), file.size());
  check(r.ok, "an array of arrays of int32 walks cleanly");
}

// An unknown value-type id ends the walk. It is a defect rather than a short
// read, because guessing a width is the one thing this parser must never do.
void testUnknownValueTypeIsADefect() {
  std::printf("preflight: an unknown value type ends the walk\n");
  using namespace despia::ai::preflight;

  std::vector<uint8_t> file = header(0, 1);
  putStr(file, "from.the.future");
  putU32(file, 4242);
  file.resize(file.size() + 64, 0);

  const Result r = validateGGUF(file.data(), file.size());
  check(!r.ok && !r.needs_more, "it is a defect, not a short read");
  check(r.code == "format_malformed", "and it is reported as malformed");
}

// A realistic table - several scalars, a string, a big token array and a big
// scalar array, in the order real models write them - passes whole and asks
// for more at every prefix, never once blaming the file.
void testRealisticTableNeverBlamesTheFile() {
  std::printf("preflight: no prefix of a valid table is ever called malformed\n");
  using namespace despia::ai::preflight;

  std::vector<uint8_t> file = header(148, 6);
  putStr(file, "general.architecture");
  putU32(file, 8);
  putStr(file, "lfm2");
  putStr(file, "block_count");
  putU32(file, 4);
  putU32(file, 16);
  putStringArray(file, "tokenizer.ggml.tokens", 900, "token");
  putScalarArray(file, "tokenizer.ggml.token_type", 5, 900, 4);
  putScalarArray(file, "tokenizer.ggml.scores", 6, 900, 4);
  putStr(file, "general.quantization_version");
  putU32(file, 4);
  putU32(file, 2);

  check(validateGGUF(file.data(), file.size()).ok, "the whole table passes");

  // Every prefix long enough to carry a header must answer "give me more" -
  // never "malformed". This is the property the two refusals violated, and it
  // is checked at every single byte rather than at a chosen few.
  size_t blamed = 0;
  for (size_t cut = 24; cut < file.size(); ++cut) {
    const Result r = validateGGUF(file.data(), cut);
    if (r.ok) continue;  // a prefix may legitimately end on a pair boundary
    if (!r.needs_more) blamed++;
  }
  check(blamed == 0, "every prefix of a valid file asks for more bytes");
  if (blamed != 0) std::printf("       %zu prefixes were reported as defects\n", blamed);
}

}  // namespace

int main() {
  std::printf("despia_ai preflight test\n\n");
  testScalarArrayStraddlingTheBuffer();
  testStringAndScalarArraysAgree();
  testImplausibleArrayCountIsStillADefect();
  testWidestScalarAtTheCeilingDoesNotWrap();
  testArrayNestingIsDepthBounded();
  testSingleLevelNestingPasses();
  testUnknownValueTypeIsADefect();
  testRealisticTableNeverBlamesTheFile();
  std::printf("\n%s\n", g_failures == 0 ? "all checks passed" : "FAILURES: see above");
  return g_failures == 0 ? 0 : 1;
}
