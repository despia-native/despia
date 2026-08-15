// g2p_backend.cpp - text becomes phonemes, and a pack is an ordinary model.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Registers as "g2p" and answers catalog entries whose `format` is dspg. There
// is nothing special about it from the core's side: a pack loads through
// despia_ai_load_model like a 4-bit language model does, it serves requests
// through the same Emitter, and it appears in despia_ai_capabilities() as the
// `phonemize` modality. That is the whole reason the frontend is HERE and not
// in the Swift and Kotlin voice modules: one implementation, gated by a corpus
// that runs on Linux, rather than two twins that drift and a third that has
// never compiled.
//
// This backend links nothing. It has no vendored library, no ONNX Runtime, no
// espeak, no dependency at all beyond the C++ standard library, so it costs the
// core a few tens of kilobytes and is compiled in unconditionally. What is
// heavy is the PACK, and a pack is a downloaded file an app can decline.
//
// It also names no language. English lives in en-us-1.dspg. A pack for another
// language is a file someone builds with tools/g2p, not a release of this
// library.

#include <memory>
#include <string>
#include <vector>

#include "../../backend.hpp"
#include "../../json.hpp"
#include "pack.hpp"
#include "phonemize.hpp"

namespace despia {
namespace ai {
namespace {

struct G2pModel : LoadedModel {
  std::unique_ptr<g2p::Pack> pack;
  std::unique_ptr<g2p::Phonemizer> phonemizer;
};

json::Value tokenJson(const g2p::Pack& pack, const g2p::Token& t) {
  json::Value v = json::Value::obj();
  // `gap` and `text` are the exact input bytes, and together with the response's
  // `trailing` they reconstruct the request verbatim. A consumer that wants to
  // prove nothing was lost can do it from this envelope alone, which is what
  // Conformance/ai/g2p checks on every case.
  v.set("gap", t.gap);
  v.set("text", t.text);
  v.set("via", std::string(g2p::viaName(t.via)));
  v.set("phonemes", pack.phoneText(t.phones));
  v.set("gap_phonemes", pack.phoneText(t.gapPhones));
  v.set("sentence", static_cast<int>(t.sentence));
  if (t.posDefault) {
    // The heteronym was resolved to its DEFAULT sense because this build ships
    // no part-of-speech tagger. Said per token rather than in a footnote, so a
    // caller can see that "read" was a coin the pack did not flip.
    v.set("pos_default", true);
  }
  if (t.unaccepted) v.set("unaccepted", true);
  return v;
}

class G2pBackend : public Backend {
 public:
  std::string id() const override { return "g2p"; }

  json::Value capabilities() const override {
    json::Value caps = json::Value::obj();
    json::Value formats = json::Value::arr();
    formats.push(std::string("dspg"));
    caps.set("formats", formats);
    json::Value modalities = json::Value::arr();
    modalities.push(std::string("phonemize"));
    caps.set("modalities", modalities);
    json::Value features = json::Value::arr();
    // The fallback vocabulary, reported rather than assumed. A host reads this
    // instead of hardcoding the four words, and the absence of "drop" from the
    // list is not an oversight.
    features.push(std::string("g2p.fallback.lts"));
    features.push(std::string("g2p.fallback.spell"));
    features.push(std::string("g2p.fallback.refuse"));
    features.push(std::string("g2p.fallback.defer"));
    features.push(std::string("g2p.provenance"));
    caps.set("features", features);
    return caps;
  }

  std::unique_ptr<LoadedModel> load(const json::Value& entry, std::string* error) override {
    const std::string path = entry["path"].asString();
    if (path.empty()) {
      *error = "invalid_entry: a g2p entry needs a path to its .dspg pack";
      return nullptr;
    }
    auto model = std::make_unique<G2pModel>();
    model->pack = g2p::Pack::open(path, error);
    if (!model->pack) return nullptr;
    model->phonemizer.reset(new g2p::Phonemizer(*model->pack));
    model->id = entry["id"].asString();
    model->entry = entry;
    return model;
  }

  void serve(LoadedModel& loaded, const json::Value& request, const Emitter& out) override {
    G2pModel& model = static_cast<G2pModel&>(loaded);
    if (request["kind"].asString() != "phonemize") {
      out.fail("unsupported_kind",
               "a g2p pack serves 'phonemize'; it does not generate text");
      return;
    }
    const json::Value& options = request["options"];
    const std::string text = options["text"].asString();

    g2p::Fallback policy = g2p::Fallback::Lts;
    if (options.has("fallback")) {
      const std::string named = options["fallback"].asString();
      if (!g2p::fallbackFromString(named, &policy)) {
        // "drop" arrives here, and it is refused by name. Somebody will ask for
        // it, because dropping the word is what every other frontend does and it
        // looks tidy in a demo. The answer is in the message.
        out.fail("invalid_request",
                 "fallback '" + named +
                     "' is not one of lts, spell, refuse, defer. There is no option that "
                     "removes a word from the text: a word nobody can pronounce is still a "
                     "word the listener is waiting for");
        return;
      }
    }

    const g2p::Phonemization result = model.phonemizer->run(text, policy);

    // The tiling invariant, checked on the real result before it leaves. It is
    // O(n) on text that is already in memory, and it converts the one failure
    // this whole subsystem exists to prevent from a silent wrong answer into a
    // typed error nobody can ship past.
    if (!g2p::checkTiling(text, result)) {
      out.fail("internal_error",
               "the phonemizer did not reproduce its input; refusing to return a result "
               "that may be missing a word");
      return;
    }

    // One block per sentence, emitted as it is ready, so a caller can start
    // synthesizing the first sentence while the rest is still being read.
    size_t at = 0;
    for (size_t s = 0; s < result.sentences.size(); ++s) {
      if (out.cancelled()) return;
      json::Value block = json::Value::obj();
      block.set("type", std::string("phonemes"));
      block.set("sentence", static_cast<int>(s));
      block.set("text", result.sentences[s]);
      std::string phonemes;
      json::Value tokens = json::Value::arr();
      while (at < result.tokens.size() && result.tokens[at].sentence == s) {
        const g2p::Token& t = result.tokens[at];
        phonemes += model.pack->phoneText(t.gapPhones);
        phonemes += model.pack->phoneText(t.phones);
        tokens.push(tokenJson(*model.pack, t));
        ++at;
      }
      block.set("phonemes", phonemes);
      block.set("tokens", tokens);
      if (s < result.deferred.size() && result.deferred[s]) {
        // The caller is being told to hand this whole sentence to another
        // synthesizer. The phonemes are still here: a caller that ignores the
        // flag gets a guess, which is a worse pronunciation and not a hole.
        block.set("deferred", true);
      }
      out.block(block);
    }
    // Tokens after the last sentence boundary, if the text did not end in one.
    if (at < result.tokens.size()) {
      json::Value block = json::Value::obj();
      block.set("type", std::string("phonemes"));
      block.set("sentence", static_cast<int>(result.sentences.size()));
      std::string phonemes, text2;
      json::Value tokens = json::Value::arr();
      for (; at < result.tokens.size(); ++at) {
        const g2p::Token& t = result.tokens[at];
        text2 += t.gap;
        text2 += t.text;
        phonemes += model.pack->phoneText(t.gapPhones);
        phonemes += model.pack->phoneText(t.phones);
        tokens.push(tokenJson(*model.pack, t));
      }
      block.set("text", text2);
      block.set("phonemes", phonemes);
      block.set("tokens", tokens);
      out.block(block);
    }

    // Text after the last word: the full stop that closed the utterance, and the
    // pause it stands for. Its own block, so that concatenating every block's
    // phonemes reproduces the whole utterance with nothing missing from either
    // end.
    if (!result.trailing.empty()) {
      json::Value block = json::Value::obj();
      block.set("type", std::string("phonemes"));
      block.set("sentence", static_cast<int>(result.sentences.size()));
      block.set("text", result.trailing);
      block.set("phonemes", model.pack->phoneText(result.trailingPhones));
      block.set("tokens", json::Value::arr());
      out.block(block);
    }

    json::Value extras = json::Value::obj();
    json::Value coverage = json::Value::obj();
    size_t total = 0, guessed = 0;
    for (int v = 0; v <= static_cast<int>(g2p::Via::Refused); ++v) {
      const g2p::Via via = static_cast<g2p::Via>(v);
      const size_t n = result.count(via);
      coverage.set(g2p::viaName(via), static_cast<int>(n));
      total += n;
      if (via == g2p::Via::Lts || via == g2p::Via::Spelled || via == g2p::Via::Refused) {
        guessed += n;
      }
    }
    coverage.set("total", static_cast<int>(total));
    // How much of this utterance the pack could not prove. A surface that wants
    // to warn, log, or route somewhere else reads one number.
    coverage.set("guessed", static_cast<int>(guessed));
    extras.set("coverage", coverage);
    extras.set("trailing", result.trailing);
    json::Value deferred = json::Value::arr();
    for (size_t s = 0; s < result.deferred.size(); ++s) {
      if (result.deferred[s]) deferred.push(static_cast<int>(s));
    }
    extras.set("deferred_sentences", deferred);
    extras.set("pack", model.pack->meta()["id"].asString());
    if (model.pack->meta().has("accuracy")) {
      // What the guesses are worth, measured on a held-out split when the pack
      // was built. Reporting it is what makes a guess honest rather than a
      // pronunciation with no provenance.
      extras.set("lts_accuracy", model.pack->meta()["accuracy"]);
    }
    out.finish(extras);
  }
};

}  // namespace

void registerG2pBackend() { Registry::shared().add(std::make_unique<G2pBackend>()); }

}  // namespace ai
}  // namespace despia
