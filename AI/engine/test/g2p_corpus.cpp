// g2p_corpus.cpp - the runner that makes Conformance/ai/g2p a gate.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The corpus was written before this file existed, which is the house order, and
// for a while nothing executed it: the three platform runners walk
// Conformance/ai/** but a g2p case carries no `steps` and no key they recognise,
// so they read the files and passed them hollow. A corpus nobody runs is not a
// gate, it is a document with brackets, and the danger is specific - it reads
// green in CI while asserting nothing at all.
//
// So the runner lives here, next to the one implementation. There are no
// platform twins to disagree: Swift, Kotlin and the web all reach the same C++,
// so running the corpus once against that C++ IS running it everywhere. When a
// runner on another lane grows the ability to drive `phonemize` over the bus, it
// runs the same files.
//
// TWO RULES THIS FILE OBEYS, both from the corpus README:
//
//   1. A file's `requires` array names the expect keys a runner must implement.
//      A runner that does not implement every key in it must FAIL the file, not
//      skip it. Skipping is how a corpus rots into decoration: someone adds a
//      key, no runner implements it, and every lane keeps reporting success.
//   2. Concrete `phonemes` expectations are derived from the declared pack, not
//      invented. A `"record"` value means the expectation is the tree's output
//      and is not pinned to a string; `phonemesNonEmpty` is what is pinned.
//
// The pack encoder here is the THIRD independent implementation of the format
// (pack.hpp reads, g2p_test.cpp writes, this writes from a declaration). They
// agree or something is wrong with the spec rather than with one of them.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "../src/backends/g2p/pack.hpp"
#include "../src/backends/g2p/phonemize.hpp"

#ifndef DESPIA_AI_G2P_CORPUS_DIR
#define DESPIA_AI_G2P_CORPUS_DIR "."
#endif

namespace {

namespace json = despia::json;

using despia::ai::g2p::Fallback;
using despia::ai::g2p::Pack;
using despia::ai::g2p::Phonemization;
using despia::ai::g2p::Phonemizer;
using despia::ai::g2p::PhoneId;
using despia::ai::g2p::Token;
using despia::ai::g2p::Via;

int g_failures = 0;
int g_cases = 0;

void fail(const std::string& where, const std::string& what) {
  std::printf("  FAIL %s: %s\n", where.c_str(), what.c_str());
  g_failures++;
}

std::string readFile(const std::string& path, bool* ok) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) {
    *ok = false;
    return std::string();
  }
  std::string out;
  char chunk[65536];
  size_t got = 0;
  while ((got = std::fread(chunk, 1, sizeof(chunk), f)) > 0) out.append(chunk, got);
  std::fclose(f);
  *ok = true;
  return out;
}

// --- the pack encoder, driven by a declaration -----------------------------

void putU32(std::vector<uint8_t>& v, uint32_t x) {
  v.push_back(static_cast<uint8_t>(x & 0xFF));
  v.push_back(static_cast<uint8_t>((x >> 8) & 0xFF));
  v.push_back(static_cast<uint8_t>((x >> 16) & 0xFF));
  v.push_back(static_cast<uint8_t>((x >> 24) & 0xFF));
}
void putU16(std::vector<uint8_t>& v, uint16_t x) {
  v.push_back(static_cast<uint8_t>(x & 0xFF));
  v.push_back(static_cast<uint8_t>((x >> 8) & 0xFF));
}

std::vector<uint8_t> bytesOf(const std::string& s) {
  return std::vector<uint8_t>(s.begin(), s.end());
}

std::vector<uint32_t> cps(const std::string& s) {
  return despia::ai::g2p::codePoints(s);
}

struct Section {
  std::string tag;
  std::vector<uint8_t> body;
};

// The lexicon is declared as a map, and the format needs it byte-sorted. Sorting
// here rather than asking the corpus author to is deliberate: a declaration is
// for reading, and a corpus that had to be hand-sorted would be a corpus with a
// silent failure mode of its own.
std::vector<uint8_t> encodeLexValue(const json::Value& entry) {
  std::vector<uint8_t> v;
  const int64_t form = entry["form"].asInt(0);
  if (form == 0) {
    const json::Array& phones = entry["phones"].asArray();
    v.push_back(0);
    v.push_back(static_cast<uint8_t>(phones.size()));
    for (const json::Value& p : phones) v.push_back(static_cast<uint8_t>(p.asInt(0)));
    return v;
  }
  const json::Array& senses = entry["senses"].asArray();
  v.push_back(1);
  v.push_back(static_cast<uint8_t>(senses.size()));
  for (const json::Value& sense : senses) {
    v.push_back(static_cast<uint8_t>(sense["pos"].asInt(0)));
    const json::Array& phones = sense["phones"].asArray();
    v.push_back(static_cast<uint8_t>(phones.size()));
    for (const json::Value& p : phones) v.push_back(static_cast<uint8_t>(p.asInt(0)));
  }
  return v;
}

std::vector<uint8_t> encodePack(const json::Value& decl) {
  std::vector<Section> sections;

  // META, verbatim except that the corpus's own `_note` keys ride along. They are
  // unknown fields and the reader must-ignores them, which is itself worth having
  // in the bytes rather than stripped out here.
  sections.push_back({"META", bytesOf(decl["meta"].dump())});

  // PHON. A number instead of a list means "generate this many", which one
  // validation case needs to build a pack with more phones than a byte can name.
  std::string phon;
  if (decl["phones"].isNumber()) {
    const int64_t n = decl["phones"].asInt(0);
    for (int64_t i = 0; i < n; ++i) {
      if (i) phon += "\n";
      phon += "p" + std::to_string(i);
    }
  } else {
    const json::Array& list = decl["phones"].asArray();
    for (size_t i = 0; i < list.size(); ++i) {
      if (i) phon += "\n";
      phon += list[i].asString();
    }
  }
  sections.push_back({"PHON", bytesOf(phon)});

  if (decl.has("lexicon")) {
    std::vector<std::string> keys;
    for (const auto& kv : decl["lexicon"].asObject()) keys.push_back(kv.first);
    std::sort(keys.begin(), keys.end());
    std::vector<uint8_t> lexk, lexv, lexi;
    putU32(lexi, static_cast<uint32_t>(keys.size()));
    for (const std::string& key : keys) {
      const uint32_t keyOff = static_cast<uint32_t>(lexk.size());
      lexk.insert(lexk.end(), key.begin(), key.end());
      const uint32_t valOff = static_cast<uint32_t>(lexv.size());
      const std::vector<uint8_t> value = encodeLexValue(decl["lexicon"][key]);
      lexv.insert(lexv.end(), value.begin(), value.end());
      putU32(lexi, keyOff);
      putU32(lexi, static_cast<uint32_t>(key.size()));
      putU32(lexi, valOff);
    }
    sections.push_back({"LEXK", lexk});
    sections.push_back({"LEXI", lexi});
    sections.push_back({"LEXV", lexv});
  }

  if (decl.has("lts")) {
    const json::Value& lts = decl["lts"];
    std::vector<uint8_t> body;
    putU32(body, static_cast<uint32_t>(lts["window"].asInt(0)));
    const size_t letterCount = static_cast<size_t>(lts["letter_count"].asInt(0));
    putU32(body, static_cast<uint32_t>(letterCount));
    // Roots are declared as a map with "*" as the default, so a fixture does not
    // have to spell twenty-seven identical numbers to say one thing.
    const json::Value& roots = lts["roots"];
    const uint32_t byDefault = static_cast<uint32_t>(roots["*"].asInt(0));
    const std::vector<uint32_t> letters = cps(decl["meta"]["letters"].asString());
    for (size_t i = 0; i < letterCount; ++i) {
      uint32_t root = byDefault;
      if (i < letters.size()) {
        const std::string key = despia::ai::g2p::fromCodePoint(letters[i]);
        if (roots.has(key)) root = static_cast<uint32_t>(roots[key].asInt(0));
      }
      putU32(body, root);
    }
    const json::Array& nodes = lts["nodes"].asArray();
    putU32(body, static_cast<uint32_t>(nodes.size()));
    for (const json::Value& n : nodes) {
      if (n["kind"].asString() == "leaf") {
        body.push_back(1);
        body.push_back(static_cast<uint8_t>(n["len"].asInt(0)));
        putU16(body, 0);
        putU32(body, static_cast<uint32_t>(n["out_off"].asInt(0)));
      } else {
        body.push_back(0);
        body.push_back(static_cast<uint8_t>(n["pos"].asInt(0)));
        body.push_back(static_cast<uint8_t>(n["chr"].asInt(0)));
        body.push_back(0);
        putU16(body, static_cast<uint16_t>(n["yes"].asInt(0)));
        putU16(body, static_cast<uint16_t>(n["no"].asInt(0)));
      }
    }
    const json::Array& out = lts["out"].asArray();
    putU32(body, static_cast<uint32_t>(out.size()));
    for (const json::Value& p : out) body.push_back(static_cast<uint8_t>(p.asInt(0)));
    sections.push_back({"LTS ", body});
  }

  if (decl.has("spel")) {
    std::map<uint32_t, std::vector<uint8_t>> rows;
    for (const auto& kv : decl["spel"].asObject()) {
      const std::vector<uint32_t> key = cps(kv.first);
      if (key.size() != 1) continue;
      std::vector<uint8_t> phones;
      for (const json::Value& p : kv.second.asArray()) {
        phones.push_back(static_cast<uint8_t>(p.asInt(0)));
      }
      rows[key[0]] = phones;
    }
    std::vector<uint8_t> body;
    putU32(body, static_cast<uint32_t>(rows.size()));
    for (const auto& kv : rows) {
      putU32(body, kv.first);
      body.push_back(static_cast<uint8_t>(kv.second.size()));
      body.insert(body.end(), kv.second.begin(), kv.second.end());
    }
    sections.push_back({"SPEL", body});
  }

  if (decl.has("norm")) sections.push_back({"NORM", bytesOf(decl["norm"].dump())});

  // An extra section a mutation asked for, which is how the must-ignore rule is
  // tested: an unknown tag has to load, and a duplicate tag has to not.
  if (decl.has("_extraSections")) {
    for (const json::Value& extra : decl["_extraSections"].asArray()) {
      std::vector<uint8_t> body(static_cast<size_t>(extra["bytes"].asInt(0)), 0);
      sections.push_back({extra["tag"].asString(), body});
    }
  }

  std::vector<uint8_t> file;
  const std::string magic = decl["magic"].asString("DSPG");
  for (size_t i = 0; i < 4; ++i) file.push_back(i < magic.size() ? magic[i] : ' ');
  putU32(file, static_cast<uint32_t>(decl["format_version"].asInt(1)));
  putU32(file, static_cast<uint32_t>(sections.size()));
  putU32(file, static_cast<uint32_t>(decl["reserved"].asInt(0)));
  const size_t tableAt = file.size();
  file.resize(tableAt + 16 * sections.size(), 0);
  for (size_t i = 0; i < sections.size(); ++i) {
    const uint32_t offset = static_cast<uint32_t>(file.size());
    file.insert(file.end(), sections[i].body.begin(), sections[i].body.end());
    uint8_t* row = file.data() + tableAt + 16 * i;
    for (size_t k = 0; k < 4; ++k) {
      row[k] = k < sections[i].tag.size() ? static_cast<uint8_t>(sections[i].tag[k]) : ' ';
    }
    const uint32_t length = static_cast<uint32_t>(sections[i].body.size());
    std::memcpy(row + 8, &offset, 4);
    std::memcpy(row + 12, &length, 4);
  }

  // Byte-level mutations, applied after encoding because they describe a broken
  // FILE rather than a broken declaration. A section whose length field claims
  // more than the file holds cannot be expressed any other way.
  if (decl.has("_sectionLengthDeltas")) {
    for (const json::Value& m : decl["_sectionLengthDeltas"].asArray()) {
      const std::string tag = m["tag"].asString();
      const int64_t delta = m["delta"].asInt(0);
      for (size_t i = 0; i < sections.size(); ++i) {
        uint8_t* row = file.data() + tableAt + 16 * i;
        if (std::string(reinterpret_cast<char*>(row), 4) != tag) continue;
        uint32_t length = 0;
        std::memcpy(&length, row + 12, 4);
        const int64_t updated = static_cast<int64_t>(length) + delta;
        const uint32_t next = updated < 0 ? 0u : static_cast<uint32_t>(updated);
        std::memcpy(row + 12, &next, 4);
      }
    }
  }
  return file;
}

// --- mutations on the declaration ------------------------------------------

// A dot path names a key (`spel.-`, `lexicon.walk`) or an array index
// (`lts.nodes.3.yes`, `lexicon.read.senses.0`). Both are needed: the LTS cases
// break one node out of a table, which is the only way to express "a child that
// points backwards" without hand-assembling the section.
bool isIndex(const std::string& s) {
  if (s.empty()) return false;
  for (char c : s) {
    if (c < '0' || c > '9') return false;
  }
  return true;
}

bool setPath(json::Value& root, const std::string& path, const json::Value& to,
             bool remove, std::string* why) {
  const size_t dot = path.find('.');
  const std::string head = dot == std::string::npos ? path : path.substr(0, dot);
  const bool last = dot == std::string::npos;

  if (root.isArray() && isIndex(head)) {
    const size_t at = static_cast<size_t>(std::stoul(head));
    if (at >= root.asArray().size()) {
      *why = "index " + head + " is past the end of the array";
      return false;
    }
    if (last) {
      if (remove) {
        root.array().erase(root.array().begin() + static_cast<long>(at));
        return true;
      }
      root.array()[at] = to;
      return true;
    }
    return setPath(root.array()[at], path.substr(dot + 1), to, remove, why);
  }

  if (last) {
    if (remove) {
      if (!root.isObject() || !root.has(head)) {
        *why = "remove '" + head + "' but it is not there";
        return false;
      }
      root.object().erase(head);
      return true;
    }
    root.set(head, to);
    return true;
  }
  if (!root.isObject() || !root.has(head)) {
    *why = "no '" + head + "' to descend into";
    return false;
  }
  return setPath(root.object()[head], path.substr(dot + 1), to, remove, why);
}

bool applyMutations(json::Value& decl, const json::Value& list, std::string* why) {
  for (const json::Value& m : list.asArray()) {
    if (m.has("set")) {
      if (!setPath(decl, m["set"].asString(), m["to"], false, why)) return false;
    } else if (m.has("remove")) {
      if (!setPath(decl, m["remove"].asString(), json::Value(), true, why)) return false;
    } else if (m.has("addSection")) {
      json::Value extra = json::Value::obj();
      extra.set("tag", m["addSection"].asString());
      extra.set("bytes", static_cast<int>(m["bytes"].asInt(0)));
      if (!decl.has("_extraSections")) decl.set("_extraSections", json::Value::arr());
      decl.object()["_extraSections"].push(extra);
    } else if (m.has("sectionLength")) {
      json::Value adjust = json::Value::obj();
      adjust.set("tag", m["sectionLength"].asString());
      adjust.set("delta", static_cast<int>(m["delta"].asInt(0)));
      if (!decl.has("_sectionLengthDeltas")) {
        decl.set("_sectionLengthDeltas", json::Value::arr());
      }
      decl.object()["_sectionLengthDeltas"].push(adjust);
    } else {
      *why = "unknown mutation verb in " + m.dump();
      return false;
    }
  }
  return true;
}

// --- expectations -----------------------------------------------------------

// Every expect key this runner understands. The `requires` rule is checked
// against exactly this set, so adding a key to the corpus without adding it here
// turns the file red rather than quiet.
const std::set<std::string>& implementedKeys() {
  static const std::set<std::string> keys = {
      "loaded",        "loadError",  "nothingDropped", "tilesInput", "tokenCount",
      "tokens",        "trailing",   "coverage",       "deferred",   "blocks",
      "byteIdentical", "requestError", "everyTokenHasVia", "viaVocabulary"};
  return keys;
}

std::string phoneText(const Pack& pack, const std::vector<PhoneId>& ids) {
  return pack.phoneText(ids);
}

// The words of the input, in order, as the corpus counts them: whatever the
// tokens say their text is. That is the point of `nothingDropped` - if the
// implementation lost one, the list is short and the case fails.
std::vector<std::string> wordsOf(const Phonemization& p) {
  std::vector<std::string> out;
  for (const Token& t : p.tokens) out.push_back(t.text);
  return out;
}

void checkTokens(const std::string& where, const Pack& pack, const Phonemization& result,
                 const json::Value& expected) {
  const json::Array& want = expected.asArray();
  if (want.size() != result.tokens.size()) {
    fail(where, "expected " + std::to_string(want.size()) + " tokens, got " +
                    std::to_string(result.tokens.size()));
    return;
  }
  for (size_t i = 0; i < want.size(); ++i) {
    const json::Value& w = want[i];
    const Token& got = result.tokens[i];
    const std::string at = where + " token " + std::to_string(i);
    if (w.has("text") && w["text"].asString() != got.text) {
      fail(at, "text '" + got.text + "' != '" + w["text"].asString() + "'");
    }
    if (w.has("gap") && w["gap"].asString() != got.gap) {
      fail(at, "gap '" + got.gap + "' != '" + w["gap"].asString() + "'");
    }
    if (w.has("via") && w["via"].asString() != despia::ai::g2p::viaName(got.via)) {
      fail(at, std::string("via '") + despia::ai::g2p::viaName(got.via) + "' != '" +
                   w["via"].asString() + "'");
    }
    if (w.has("sentence") && w["sentence"].asInt(-1) != static_cast<int64_t>(got.sentence)) {
      fail(at, "sentence " + std::to_string(got.sentence) + " != " +
                   std::to_string(w["sentence"].asInt(-1)));
    }
    if (w.has("pos_default") && w["pos_default"].asBool(false) != got.posDefault) {
      fail(at, "pos_default disagrees");
    }
    if (w.has("unaccepted") && w["unaccepted"].asBool(false) != got.unaccepted) {
      fail(at, "unaccepted disagrees");
    }
    if (w.has("phonemesNonEmpty") && w["phonemesNonEmpty"].asBool(false) && got.phones.empty()) {
      fail(at, "expected phonemes, got none");
    }
    if (w.has("phonemesEmpty") && w["phonemesEmpty"].asBool(false) && !got.phones.empty()) {
      fail(at, "expected no phonemes, got '" + phoneText(pack, got.phones) + "'");
    }
    // "record" means the value is whatever the trees produce and is deliberately
    // not pinned to a string. Pinning a tree's output would pin the trainer.
    if (w.has("phonemes") && w["phonemes"].asString() != "record") {
      const std::string got_s = phoneText(pack, got.phones);
      if (got_s != w["phonemes"].asString()) {
        fail(at, "phonemes '" + got_s + "' != '" + w["phonemes"].asString() + "'");
      }
    }
    if (w.has("gap_phonemes")) {
      const std::string got_s = phoneText(pack, got.gapPhones);
      if (got_s != w["gap_phonemes"].asString()) {
        fail(at, "gap_phonemes '" + got_s + "' != '" + w["gap_phonemes"].asString() + "'");
      }
    }
  }
}

void checkCoverage(const std::string& where, const Phonemization& result,
                   const json::Value& want) {
  static const std::pair<const char*, Via> kAll[] = {
      {"lexicon", Via::Lexicon}, {"pos", Via::Pos},         {"stem", Via::Stem},
      {"number", Via::Number},   {"lts", Via::Lts},         {"spelled", Via::Spelled},
      {"refused", Via::Refused}};
  size_t total = 0, guessed = 0;
  for (const auto& kv : kAll) {
    const size_t n = result.count(kv.second);
    total += n;
    if (kv.second == Via::Lts || kv.second == Via::Spelled || kv.second == Via::Refused) {
      guessed += n;
    }
    if (want.has(kv.first) && want[kv.first].asInt(-1) != static_cast<int64_t>(n)) {
      fail(where, std::string("coverage.") + kv.first + " is " + std::to_string(n) +
                      ", expected " + std::to_string(want[kv.first].asInt(-1)));
    }
  }
  if (want.has("total") && want["total"].asInt(-1) != static_cast<int64_t>(total)) {
    fail(where, "coverage.total is " + std::to_string(total));
  }
  if (want.has("guessed") && want["guessed"].asInt(-1) != static_cast<int64_t>(guessed)) {
    fail(where, "coverage.guessed is " + std::to_string(guessed));
  }
}

struct Corpus {
  std::map<std::string, json::Value> packs;
};

// Resolves a case's `pack` field, which is either a declared pack's name or a
// base plus a list of mutations.
bool packBytesFor(const Corpus& corpus, const json::Value& spec, std::vector<uint8_t>* out,
                  std::string* why) {
  std::string base;
  json::Value decl;
  if (spec.isString()) {
    base = spec.asString();
  } else {
    base = spec["base"].asString();
  }
  auto it = corpus.packs.find(base);
  if (it == corpus.packs.end()) {
    *why = "no declared pack named '" + base + "'";
    return false;
  }
  decl = it->second;
  if (!spec.isString() && spec.has("mutate")) {
    if (!applyMutations(decl, spec["mutate"], why)) return false;
  }
  *out = encodePack(decl);
  return true;
}

void runCase(const Corpus& corpus, const std::string& file, const json::Value& c) {
  const std::string where = file + ": " + c["name"].asString();
  g_cases++;

  std::vector<uint8_t> bytes;
  std::string why;
  if (!packBytesFor(corpus, c["pack"], &bytes, &why)) {
    fail(where, "could not build the pack: " + why);
    return;
  }

  std::string error;
  std::unique_ptr<Pack> pack = Pack::fromBytes(bytes, &error);
  const json::Value& expect = c["expect"];

  if (expect.has("loaded")) {
    const bool wanted = expect["loaded"].asBool(true);
    if (wanted != (pack != nullptr)) {
      fail(where, wanted ? "expected the pack to load, it did not: " + error
                         : "expected the pack to be refused, it loaded");
      return;
    }
  }
  if (!pack) {
    if (expect.has("loadError")) {
      const json::Value& want = expect["loadError"];
      // The reader's error is `<code>: <detail>`, and the code is a closed set.
      // Splitting on the FIRST colon is unambiguous even when a detail contains
      // one, which is why the format is fixed rather than merely conventional.
      const size_t colon = error.find(':');
      const std::string code = colon == std::string::npos ? error : error.substr(0, colon);
      if (want.has("packCode") && want["packCode"].asString() != code) {
        fail(where, "load error code '" + code + "' != '" + want["packCode"].asString() +
                        "' (full: " + error + ")");
      }
      if (want.has("messageContains") &&
          error.find(want["messageContains"].asString()) == std::string::npos) {
        fail(where, "load error does not mention '" + want["messageContains"].asString() +
                        "' (full: " + error + ")");
      }
    }
    return;
  }

  if (!c.has("phonemize")) return;  // a pure validation case is done

  const json::Value& req = c["phonemize"];
  const std::string text = req["text"].asString();
  Fallback policy = Fallback::Lts;
  const bool named = req.has("fallback");
  if (named && !despia::ai::g2p::fallbackFromString(req["fallback"].asString(), &policy)) {
    if (expect.has("requestError")) {
      const json::Value& want = expect["requestError"];
      if (want.has("code") && want["code"].asString() != "invalid_request") {
        fail(where, "a rejected fallback is invalid_request");
      }
      return;
    }
    fail(where, "fallback '" + req["fallback"].asString() + "' was rejected unexpectedly");
    return;
  }
  if (expect.has("requestError")) {
    fail(where, "expected the request to be refused, it was accepted");
    return;
  }

  Phonemizer phonemizer(*pack);
  const Phonemization result = phonemizer.run(text, policy);

  if (expect.has("tilesInput") && expect["tilesInput"].asBool(false)) {
    if (!despia::ai::g2p::checkTiling(text, result)) {
      fail(where, "the tokens do not reproduce the input");
    }
  }
  if (expect.has("nothingDropped")) {
    const json::Value& want = expect["nothingDropped"];
    const std::vector<std::string> got = wordsOf(result);
    if (want.has("words")) {
      const json::Array& wanted = want["words"].asArray();
      bool same = wanted.size() == got.size();
      for (size_t i = 0; same && i < wanted.size(); ++i) same = wanted[i].asString() == got[i];
      if (!same) {
        std::string joined;
        for (const std::string& w : got) joined += (joined.empty() ? "" : "|") + w;
        fail(where, "words differ, got: " + joined);
      }
    }
    if (want.has("joined")) {
      std::string joined;
      for (size_t i = 0; i < got.size(); ++i) joined += (i ? " " : "") + got[i];
      if (joined != want["joined"].asString()) {
        fail(where, "joined words '" + joined + "' != '" + want["joined"].asString() + "'");
      }
    }
  }
  if (expect.has("tokenCount") &&
      expect["tokenCount"].asInt(-1) != static_cast<int64_t>(result.tokens.size())) {
    fail(where, "token count is " + std::to_string(result.tokens.size()) + ", expected " +
                    std::to_string(expect["tokenCount"].asInt(-1)));
  }
  if (expect.has("tokens")) checkTokens(where, *pack, result, expect["tokens"]);
  if (expect.has("trailing") && expect["trailing"].asString() != result.trailing) {
    fail(where, "trailing '" + result.trailing + "' != '" + expect["trailing"].asString() + "'");
  }
  if (expect.has("coverage")) checkCoverage(where, result, expect["coverage"]);
  if (expect.has("everyTokenHasVia") && expect["everyTokenHasVia"].asBool(false)) {
    for (const Token& t : result.tokens) {
      const std::string via = despia::ai::g2p::viaName(t.via);
      if (via.empty()) fail(where, "a token carries no via");
    }
  }
  if (expect.has("viaVocabulary")) {
    // Every value the corpus believes exists must be a value this build can
    // produce a name for. A seventh value appearing in one implementation and
    // not the others is exactly the drift this pins.
    std::set<std::string> known;
    for (int v = 0; v <= static_cast<int>(Via::Refused); ++v) {
      known.insert(despia::ai::g2p::viaName(static_cast<Via>(v)));
    }
    for (const json::Value& v : expect["viaVocabulary"].asArray()) {
      if (!known.count(v.asString())) {
        fail(where, "the corpus names a via '" + v.asString() + "' this build cannot produce");
      }
    }
    if (expect["viaVocabulary"].asArray().size() != known.size()) {
      fail(where, "the via vocabulary has " + std::to_string(known.size()) +
                      " values, the corpus names " +
                      std::to_string(expect["viaVocabulary"].asArray().size()));
    }
  }
  if (expect.has("deferred")) {
    // A deferral carries the sentence INDEX and its TEXT VERBATIM. The text is
    // the load-bearing half: it is what a caller hands to the platform
    // synthesizer, and a deferral that carried only an index would make the
    // caller re-derive the sentence split and hope it matched this one.
    const json::Array& want = expect["deferred"].asArray();
    std::vector<size_t> got;
    for (size_t s = 0; s < result.deferred.size(); ++s) {
      if (result.deferred[s]) got.push_back(s);
    }
    if (want.size() != got.size()) {
      std::string list;
      for (size_t s : got) list += (list.empty() ? "" : ",") + std::to_string(s);
      fail(where, "expected " + std::to_string(want.size()) +
                      " deferred sentence(s), got [" + list + "]");
    } else {
      for (size_t i = 0; i < want.size(); ++i) {
        const int64_t index = want[i]["sentence"].asInt(-1);
        if (index != static_cast<int64_t>(got[i])) {
          fail(where, "deferred sentence " + std::to_string(got[i]) + " != " +
                          std::to_string(index));
          continue;
        }
        if (!want[i].has("text")) continue;
        const std::string text_s =
            got[i] < result.sentences.size() ? result.sentences[got[i]] : std::string();
        if (text_s != want[i]["text"].asString()) {
          fail(where, "deferred sentence text '" + text_s + "' != '" +
                          want[i]["text"].asString() + "'");
        }
      }
    }
  }
  if (expect.has("blocks")) {
    // The blocks tile the phonemes: concatenating them reproduces the whole
    // utterance. Built here the way the backend builds them, from the same
    // result, so the law is checked rather than the backend's copy of it.
    const json::Array& want = expect["blocks"].asArray();
    std::vector<std::string> got(result.sentences.size());
    size_t at = 0;
    for (size_t s = 0; s < result.sentences.size(); ++s) {
      std::string phonemes;
      while (at < result.tokens.size() && result.tokens[at].sentence == s) {
        phonemes += phoneText(*pack, result.tokens[at].gapPhones);
        phonemes += phoneText(*pack, result.tokens[at].phones);
        ++at;
      }
      got[s] = phonemes;
    }
    std::string tail;
    for (; at < result.tokens.size(); ++at) {
      tail += phoneText(*pack, result.tokens[at].gapPhones);
      tail += phoneText(*pack, result.tokens[at].phones);
    }
    if (!tail.empty()) got.push_back(tail);
    if (!result.trailingPhones.empty()) got.push_back(phoneText(*pack, result.trailingPhones));
    if (want.size() != got.size()) {
      fail(where, "expected " + std::to_string(want.size()) + " blocks, got " +
                      std::to_string(got.size()));
    } else {
      for (size_t i = 0; i < want.size(); ++i) {
        if (want[i].has("phonemes") && want[i]["phonemes"].asString() != "record" &&
            want[i]["phonemes"].asString() != got[i]) {
          fail(where, "block " + std::to_string(i) + " phonemes '" + got[i] + "' != '" +
                          want[i]["phonemes"].asString() + "'");
        }
      }
    }
  }
  if (expect.has("byteIdentical") && expect["byteIdentical"].asBool(false)) {
    const int repeats = c.has("repeat") ? static_cast<int>(c["repeat"].asInt(2)) : 2;
    for (int r = 1; r < repeats; ++r) {
      const Phonemization again = phonemizer.run(text, policy);
      bool same = again.tokens.size() == result.tokens.size() &&
                  again.trailing == result.trailing;
      for (size_t i = 0; same && i < again.tokens.size(); ++i) {
        same = again.tokens[i].text == result.tokens[i].text &&
               again.tokens[i].phones == result.tokens[i].phones &&
               again.tokens[i].via == result.tokens[i].via;
      }
      if (!same) {
        fail(where, "run " + std::to_string(r + 1) + " differs from the first");
        return;
      }
    }
    if (c.has("reload") && c["reload"].asBool(false)) {
      std::string reloadError;
      std::unique_ptr<Pack> second = Pack::fromBytes(bytes, &reloadError);
      if (!second) {
        fail(where, "the pack did not reload: " + reloadError);
        return;
      }
      Phonemizer other(*second);
      const Phonemization again = other.run(text, policy);
      bool same = again.tokens.size() == result.tokens.size();
      for (size_t i = 0; same && i < again.tokens.size(); ++i) {
        same = again.tokens[i].phones == result.tokens[i].phones;
      }
      if (!same) fail(where, "a freshly loaded pack disagrees with the first");
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  const std::string dir = argc > 1 ? argv[1] : DESPIA_AI_G2P_CORPUS_DIR;
  std::printf("g2p_corpus  %s\n", dir.c_str());

  bool ok = false;
  const std::string fixtureText = readFile(dir + "/fixture-pack.json", &ok);
  if (!ok) {
    // A runner that cannot find its corpus must not report success. This is the
    // same rule as the requires check, one level up: silence is the failure mode
    // a conformance harness has to be built against.
    std::printf("  FAIL cannot read %s/fixture-pack.json\n", dir.c_str());
    return 1;
  }
  std::string err;
  const json::Value fixture = json::parse(fixtureText, &err);
  if (!fixture.isObject()) {
    std::printf("  FAIL fixture-pack.json is not an object: %s\n", err.c_str());
    return 1;
  }
  Corpus corpus;
  for (const auto& kv : fixture["packs"].asObject()) corpus.packs[kv.first] = kv.second;
  std::printf("  %zu declared pack(s)\n", corpus.packs.size());

  static const char* kFiles[] = {"coverage.json", "provenance.json", "validation.json",
                                 "fallback.json", "determinism.json"};
  for (const char* name : kFiles) {
    const std::string text = readFile(dir + "/" + name, &ok);
    if (!ok) {
      std::printf("  FAIL cannot read %s\n", name);
      g_failures++;
      continue;
    }
    const json::Value file = json::parse(text, &err);
    if (!file.isObject()) {
      std::printf("  FAIL %s is not an object: %s\n", name, err.c_str());
      g_failures++;
      continue;
    }
    // RULE 1. A key in `requires` that this runner does not implement fails the
    // FILE. Skipping instead is how a corpus becomes decoration: someone adds a
    // key, no runner implements it, and every lane keeps reporting green.
    std::vector<std::string> missing;
    for (const json::Value& r : file["requires"].asArray()) {
      if (!implementedKeys().count(r.asString())) missing.push_back(r.asString());
    }
    if (!missing.empty()) {
      std::string list;
      for (const std::string& m : missing) list += (list.empty() ? "" : ", ") + m;
      std::printf("  FAIL %s requires [%s], which this runner does not implement\n", name,
                  list.c_str());
      g_failures++;
      continue;
    }
    const size_t before = static_cast<size_t>(g_cases);
    for (const json::Value& c : file["cases"].asArray()) runCase(corpus, name, c);
    std::printf("  %-18s %zu cases\n", name, static_cast<size_t>(g_cases) - before);
  }

  std::printf("g2p_corpus: %d cases · %d failures\n", g_cases, g_failures);
  return g_failures == 0 ? 0 : 1;
}
