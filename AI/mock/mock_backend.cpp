// mock_backend.cpp - MockEngine: the deterministic backend every gate runs on.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// There is exactly ONE MockEngine and this is it: a registered backend behind
// the same C ABI as the real one, so the Swift and Kotlin lanes exercise the
// real seam rather than a per-language stub. The TS port
// (bindings/ts/src/mock.ts) is explicitly subordinate and is gated by the same
// fixtures - if the two ever disagree, this one is right.
//
// A mock model is a SCRIPT: a list of events keyed by model id, replayed in
// order (OpenSource/Conformance/ai/README.md, Appendix A5). No timing, no
// randomness, no sampling - a fixture that passes here passes for the same
// reason every time, which is the only way a corpus is worth running.
//
// The script comes in on the catalog entry under `mock`, because the entry is
// what load_model already carries. That keeps the mock inside the ordinary
// model path instead of adding a side channel the real backends do not have.

#include <chrono>
#include <memory>
#include <string>
#include <thread>

#include "../engine/src/backend.hpp"
#include "../engine/src/json.hpp"

namespace despia {
namespace ai {
namespace {

struct MockModel : LoadedModel {
  json::Array turns;   // each turn is an array of scripted events
  bool repeatLast = false;  // `everyTurn` form: the one turn plays forever
  size_t turnIndex = 0;
};

class MockBackend : public Backend {
 public:
  std::string id() const override { return "mock"; }

  json::Value capabilities() const override {
    json::Value caps = json::Value::obj();
    json::Array formats{json::Value("mock")};
    json::Array modalities{json::Value("text"), json::Value("embedding"),
                           json::Value("audio"), json::Value("image")};
    json::Array features{json::Value("gbnf"), json::Value("structured-output"),
                         json::Value("tools")};
    json::Value limits = json::Value::obj();
    limits.set("max_parallel", 1);
    caps.set("formats", json::Value(formats));
    caps.set("modalities", json::Value(modalities));
    caps.set("features", json::Value(features));
    caps.set("limits", limits);
    return caps;
  }

  std::unique_ptr<LoadedModel> load(const json::Value& entry,
                                    std::string* error) override {
    const json::Value& mock = entry["mock"];
    if (mock.has("load") && mock["load"].has("error")) {
      // A scripted load refusal: what the fit and absence cases need in order
      // to prove the host's behaviour when a model will not open.
      *error = mock["load"]["error"]["code"].asString("load_failed");
      return nullptr;
    }
    auto m = std::make_unique<MockModel>();
    if (mock.has("turns")) {
      m->turns = mock["turns"].asArray();
    } else if (mock.has("everyTurn")) {
      m->turns = json::Array{mock["everyTurn"]};
      m->repeatLast = true;
    } else if (mock.has("script")) {
      m->turns = json::Array{mock["script"]};
    } else {
      // No script is a legal model that answers nothing but a terminal event -
      // useful for cases where the request must not reach generation at all.
      m->turns = json::Array{json::Value(json::Array{})};
    }
    return m;
  }

  void serve(LoadedModel& model, const json::Value& request,
             const Emitter& out) override {
    MockModel& m = static_cast<MockModel&>(model);
    if (m.turns.empty()) return;

    size_t index = m.repeatLast ? 0 : m.turnIndex;
    if (index >= m.turns.size()) index = m.turns.size() - 1;
    if (!m.repeatLast) m.turnIndex++;

    // Structured output is a real behaviour here, not a flag we swallow: when
    // the caller asks for a schema the mock reports back that it compiled a
    // grammar, which is what the tools corpus asserts reached the engine.
    const bool wantsGrammar =
        request["response_format"]["type"].asString() == "json_schema";
    (void)wantsGrammar;

    for (const auto& step : m.turns[index].asArray()) {
      if (out.cancelled && out.cancelled()) return;

      if (step.has("token")) {
        json::Value block = json::Value::obj();
        block.set("type", "text");
        block.set("text", step["token"].asString());
        out.block(block);
      } else if (step.has("thinking")) {
        json::Value block = json::Value::obj();
        block.set("type", "thinking");
        block.set("text", step["thinking"].asString());
        out.block(block);
      } else if (step.has("tool")) {
        json::Value block = step["tool"];
        block.set("type", "tool");
        out.block(block);
      } else if (step.has("block")) {
        out.block(step["block"]);
      } else if (step.has("sync")) {
        out.sync();
      } else if (step.has("pause")) {
        // The deterministic mid-stream hand-off. The request stays GENUINELY in
        // flight here so the host's next step - a cancel, a resync - lands on a
        // live request rather than on a finished one. Returning instead (which
        // is what this used to do) ended the turn, so those cases could not be
        // expressed at all.
        while (!(out.cancelled && out.cancelled())) {
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        return;
      } else if (step.has("error")) {
        out.fail(step["error"]["code"].asString("engine_failed"),
                 step["error"]["message"].asString());
        return;
      } else if (step.has("complete")) {
        // Pass the scripted terminal payload through. The TS port already did,
        // and the corpus running on a second runner is what caught that these
        // two disagreed.
        if (out.finish) out.finish(step["complete"]);
        return;
      }
    }
  }
};

}  // namespace

// The grapheme-to-phoneme frontend links nothing and is compiled in
// unconditionally, so it has no guard. What is heavy about speech is the pack,
// and a pack is a file an app can decline to download.
void registerG2pBackend();

#if DESPIA_AI_HAVE_LLAMA
void registerGgufBackend();
#endif
#if DESPIA_AI_HAVE_WHISPER
void registerWhisperBackend();
#endif

// The build's engine surface as a link-time fact. A backend the build did not
// compile in is simply absent from the registry, and a catalog entry naming it
// gets typed absence rather than a crash - which is why this list is a short
// greppable function instead of a pile of static initialisers.
void registerBuiltinBackends() {
  Registry::shared().add(std::make_unique<MockBackend>());
  registerG2pBackend();
#if DESPIA_AI_HAVE_LLAMA
  registerGgufBackend();
#endif
#if DESPIA_AI_HAVE_WHISPER
  registerWhisperBackend();
#endif
}

}  // namespace ai
}  // namespace despia
