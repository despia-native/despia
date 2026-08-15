// abi_test.cpp - the C ABI's own smoke test.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This is not the conformance corpus - that runs above the seam, against the
// host (OpenSource/AI/conformance). This is the layer below: proof that the
// ABI in despia_ai.h does what the header says, including the parts a
// fixture cannot see from above. Namely: that the envelope is well formed,
// that a token event carries only its delta, that cancel is legal from inside
// the callback, that unknown fields survive, and that close joins the worker
// so no event arrives afterwards.

#include "../include/despia_ai.h"

#include <cassert>
#include <cstdio>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "../src/json.hpp"
#include "../src/preflight.hpp"

namespace json = despia::json;

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

// The consumer shape the ABI expects: events arrive on the engine's worker,
// so the caller synchronises and waits for the terminal event rather than
// assuming anything about timing. close() cancels what is still in flight, as
// the header says, which is exactly why a consumer waits for `final` first.
struct Sink {
  std::mutex mu;
  std::condition_variable cv;
  std::vector<json::Value> events;
  bool sawFinal = false;
  void* ctx = nullptr;
  bool cancelOnFirstToken = false;
  int cancelledId = -1;

  void waitForFinal() {
    std::unique_lock<std::mutex> lock(mu);
    cv.wait_for(lock, std::chrono::seconds(5), [this] { return sawFinal; });
  }
  std::vector<json::Value> snapshot() {
    std::lock_guard<std::mutex> lock(mu);
    return events;
  }
};

void onEvent(const char* event_json, void* user) {
  Sink* sink = static_cast<Sink*>(user);
  std::string err;
  json::Value v = json::parse(event_json, &err);
  if (!err.empty()) {
    std::printf("  FAIL event was not valid JSON: %s\n", err.c_str());
    g_failures++;
    return;
  }
  const bool isFinal = v["final"].asBool();
  const bool isToken = v["event"].asString() == "token";
  int rid = static_cast<int>(v["id"].asInt());
  {
    std::lock_guard<std::mutex> lock(sink->mu);
    sink->events.push_back(v);
    if (isFinal) sink->sawFinal = true;
  }
  if (sink->cancelOnFirstToken && isToken && sink->cancelledId < 0) {
    // The reentrancy whitelist, exercised: cancelling from inside the callback
    // is the first thing every consumer does, so it had better be legal - and
    // it must not deadlock against the lock the callback path holds.
    sink->cancelledId = rid;
    despia_ai_cancel(sink->ctx, rid);
  }
  if (isFinal) sink->cv.notify_all();
}

std::string mockEntry(const char* id, const char* script) {
  return std::string("{\"id\":\"") + id +
         "\",\"engine\":\"mock\",\"format\":\"mock\",\"mock\":" + script + "}";
}

void testVersionAndCapabilities() {
  std::printf("abi: version and capabilities\n");
  check(despia_ai_abi_version() == 1, "abi version is 1");

  const char* caps = despia_ai_capabilities();
  check(caps != nullptr, "capabilities returns a payload");
  std::string err;
  json::Value v = json::parse(caps ? caps : "", &err);
  check(err.empty(), "capabilities is valid JSON");
  check(v["abi"].asInt() == 1, "capabilities reports the abi");
  check(!v["version"].asString().empty(), "capabilities reports a package version");
  bool hasMock = false;
  for (const auto& e : v["engines"].asArray()) {
    if (e.asString() == "mock") hasMock = true;
  }
  check(hasMock, "the mock backend is registered and self-reported");
  despia_ai_free(const_cast<char*>(caps));
}

void testStreamingEnvelope() {
  std::printf("abi: the streaming envelope\n");
  void* ctx = despia_ai_open("{\"schema_version\":1}");
  check(ctx != nullptr, "a context opens");
  if (!ctx) return;

  const std::string entry = mockEntry(
      "m1", "{\"script\":[{\"token\":\"Hel\"},{\"token\":\"lo\"},{\"complete\":{}}]}");
  check(despia_ai_load_model(ctx, entry.c_str()) == 0, "the model loads");

  Sink sink;
  sink.ctx = ctx;
  int rid = despia_ai_request(
      ctx, "{\"schema_version\":1,\"kind\":\"completion\",\"model\":\"m1\"}", onEvent,
      &sink);
  check(rid > 0, "the request is accepted and gets an id");
  sink.waitForFinal();
  despia_ai_close(ctx);  // joins the worker: nothing can arrive after this

  std::vector<json::Value> events = sink.snapshot();
  check(events.size() == 3, "two token events and one terminal event");
  if (events.size() == 3) {
    check(events[0]["event"].asString() == "token", "first event is a token");
    check(events[0]["id"].asInt() == rid, "the envelope carries the request id");
    check(events[0]["data"]["seq"].asInt() == 0, "seq starts at zero");
    check(events[0]["data"]["delta"]["text"].asString() == "Hel",
          "the delta carries only this token");
    check(events[1]["data"]["seq"].asInt() == 1, "seq is monotonic");
    check(events[1]["data"]["delta"]["text"].asString() == "lo",
          "the second delta does not repeat the first");
    check(!events[1]["data"].has("snapshot"),
          "a token event carries no snapshot - the wire stays linear");
    check(events[2]["event"].asString() == "complete", "the last event completes");
    check(events[2]["final"].asBool(), "the terminal event is marked final");
    check(events[2]["data"]["snapshot"].asArray().size() == 1,
          "text blocks coalesce into one snapshot block");
    check(events[2]["data"]["snapshot"].asArray()[0]["text"].asString() == "Hello",
          "the snapshot is the accumulated text");
  }
}

void testCancelFromInsideTheCallback() {
  std::printf("abi: cancel from inside the callback\n");
  void* ctx = despia_ai_open("{}");
  if (!ctx) { check(false, "a context opens"); return; }

  const std::string entry = mockEntry(
      "m1",
      "{\"script\":[{\"token\":\"one\"},{\"token\":\"two\"},{\"token\":\"three\"},"
      "{\"complete\":{}}]}");
  despia_ai_load_model(ctx, entry.c_str());

  Sink sink;
  sink.ctx = ctx;
  sink.cancelOnFirstToken = true;
  despia_ai_request(ctx, "{\"kind\":\"completion\",\"model\":\"m1\"}", onEvent, &sink);
  sink.waitForFinal();
  despia_ai_close(ctx);

  int tokens = 0;
  bool sawFinal = false;
  for (const auto& e : sink.snapshot()) {
    if (e["event"].asString() == "token") tokens++;
    if (e["final"].asBool()) sawFinal = true;
  }
  check(tokens == 1, "cancelling on the first token stops the stream there");
  check(sawFinal, "a cancelled request still settles");
}

void testBoundaryValidation() {
  std::printf("abi: typed validation at the boundary\n");
  void* ctx = despia_ai_open("{}");
  if (!ctx) { check(false, "a context opens"); return; }

  check(despia_ai_load_model(ctx, "{\"id\":\"x\"}") != 0,
        "a model entry without an engine is refused");
  check(despia_ai_last_error(ctx) != nullptr, "the refusal has a typed error");

  check(despia_ai_load_model(ctx, "{\"id\":\"x\",\"engine\":\"nope\"}") != 0,
        "an entry naming a backend this build lacks is refused");
  {
    json::Value e = json::parse(despia_ai_last_error(ctx));
    check(e["code"].asString() == "unsupported",
          "the reason is unsupported, not a crash");
  }

  const std::string entry = mockEntry("m1", "{\"script\":[{\"complete\":{}}]}");
  despia_ai_load_model(ctx, entry.c_str());

  Sink sink;
  check(despia_ai_request(ctx, "{\"kind\":\"completion\"}", onEvent, &sink) < 0,
        "a request without a model is refused");
  check(despia_ai_request(ctx, "{\"kind\":\"completion\",\"model\":\"m1\",\"priority\":42}",
                          onEvent, &sink) < 0,
        "a known field of the wrong type is refused");
  check(despia_ai_request(ctx, "{\"kind\":\"completion\",\"model\":\"ghost\"}", onEvent,
                          &sink) < 0,
        "a request naming an unloaded model is refused");
  check(despia_ai_request(ctx, "{not json", onEvent, &sink) < 0,
        "malformed JSON is refused, not guessed at");

  // Must-ignore: an envelope from a newer host carries fields this build has
  // never heard of, and the request still runs.
  int rid = despia_ai_request(
      ctx,
      "{\"schema_version\":9,\"kind\":\"completion\",\"model\":\"m1\","
      "\"speculative_draft\":\"m0\",\"future\":{\"nested\":true}}",
      onEvent, &sink);
  check(rid > 0, "unknown fields are ignored, not rejected");
  despia_ai_close(ctx);
}

void testPreflight() {
  std::printf("preflight: the bounded validator\n");
  using namespace despia::ai::preflight;

  const uint8_t empty[4] = {0, 0, 0, 0};
  check(!validateGGUF(empty, sizeof(empty)).ok, "a short buffer is refused");
  check(validateGGUF(nullptr, 0).code == "format_unrecognized", "null is refused");

  uint8_t notGguf[64] = {'N', 'O', 'P', 'E'};
  check(validateGGUF(notGguf, sizeof(notGguf)).code == "format_unrecognized",
        "a file without the magic is refused");

  // A well-formed v3 header with no metadata pairs.
  std::vector<uint8_t> ok(24, 0);
  std::memcpy(ok.data(), "GGUF", 4);
  uint32_t version = 3;
  std::memcpy(ok.data() + 4, &version, 4);
  uint64_t tensors = 12, kv = 0;
  std::memcpy(ok.data() + 8, &tensors, 8);
  std::memcpy(ok.data() + 16, &kv, 8);
  Result good = validateGGUF(ok.data(), ok.size());
  check(good.ok, "a well-formed header passes");
  check(good.tensor_count == 12, "the tensor count is read");

  // The hostile shape this validator exists for: a declared metadata count
  // that would walk far past the buffer.
  std::vector<uint8_t> lying(24, 0);
  std::memcpy(lying.data(), "GGUF", 4);
  std::memcpy(lying.data() + 4, &version, 4);
  uint64_t manyKv = 4096;
  std::memcpy(lying.data() + 8, &tensors, 8);
  std::memcpy(lying.data() + 16, &manyKv, 8);
  Result bad = validateGGUF(lying.data(), lying.size());
  check(!bad.ok, "a metadata count that runs past the buffer does not pass");
  // From HERE that is ambiguous: the caller may simply have handed over a
  // prefix. The honest answer is "give me more", and the caller resolves it by
  // reading further or by discovering the file has no further to read.
  // Answering "malformed" from inside this function is what rejected a
  // perfectly good Gemma 3 file, whose tokenizer vocabulary runs well past the
  // 256 KiB the loader used to read.
  check(bad.needs_more, "it asks for more bytes rather than blaming the file");
  check(bad.suggested_bytes > lying.size(), "and it suggests a larger read");

  // A length past the CEILING is a defect rather than a short read: no further
  // bytes will make a 2 GiB metadata key reasonable, so the caller must not
  // loop doubling forever.
  std::vector<uint8_t> longKey(40, 0);
  std::memcpy(longKey.data(), "GGUF", 4);
  std::memcpy(longKey.data() + 4, &version, 4);
  uint64_t oneKv = 1, noTensors = 0, absurdLen = (1ull << 31);
  std::memcpy(longKey.data() + 8, &noTensors, 8);
  std::memcpy(longKey.data() + 16, &oneKv, 8);
  std::memcpy(longKey.data() + 24, &absurdLen, 8);
  Result keyTooLong = validateGGUF(longKey.data(), longKey.size());
  check(!keyTooLong.ok && !keyTooLong.needs_more,
        "an implausible key length is a defect, not a short read");

  // An implausible count is refused before the walk even starts.
  std::vector<uint8_t> absurd(24, 0);
  std::memcpy(absurd.data(), "GGUF", 4);
  std::memcpy(absurd.data() + 4, &version, 4);
  uint64_t huge = 0xFFFFFFFFFFFFFFFFull;
  std::memcpy(absurd.data() + 8, &huge, 8);
  std::memcpy(absurd.data() + 16, &huge, 8);
  check(!validateGGUF(absurd.data(), absurd.size()).ok,
        "an implausible table size is refused up front");

  uint32_t v99 = 99;
  std::vector<uint8_t> futureVersion = ok;
  std::memcpy(futureVersion.data() + 4, &v99, 4);
  check(validateGGUF(futureVersion.data(), futureVersion.size()).code ==
            "format_unsupported",
        "an out-of-range GGUF version is unsupported, not malformed");
}

void testJson() {
  std::printf("json: the engine's parser\n");
  std::string err;
  json::Value v = json::parse("{\"a\":[1,2,{\"b\":\"c\"}],\"n\":null,\"t\":true}", &err);
  check(err.empty(), "a nested document parses");
  check(v["a"].asArray().size() == 3, "arrays keep their length");
  check(v["a"].asArray()[2]["b"].asString() == "c", "nested lookup works");
  check(v["missing"].isNull(), "a missing key reads as null, it does not throw");

  json::parse("{\"a\":", &err);
  check(!err.empty(), "a truncated document is an error, not a partial value");

  // Round-tripping preserves fields this build knows nothing about, which is
  // the must-ignore law's mechanical half.
  const std::string original = "{\"known\":1,\"unknown\":{\"deep\":[true,null]}}";
  json::Value round = json::parse(original, &err);
  check(round.dump() == original, "unknown fields survive a round trip byte for byte");

  std::string deep;
  for (int i = 0; i < 200; ++i) deep += "[";
  json::parse(deep, &err);
  check(!err.empty(), "a deeply nested document is refused rather than smashing the stack");

  check(json::parse("\"\\u0645\\u0631\\u062d\\u0628\\u0627\"", &err).asString() ==
            "مرحبا",
        "unicode escapes decode to UTF-8");
}

}  // namespace

int main() {
  std::printf("despia_ai abi test\n\n");
  testVersionAndCapabilities();
  testJson();
  testPreflight();
  testStreamingEnvelope();
  testCancelFromInsideTheCallback();
  testBoundaryValidation();
  std::printf("\n%s\n", g_failures == 0 ? "all checks passed"
                                        : "FAILURES: see above");
  return g_failures == 0 ? 0 : 1;
}
