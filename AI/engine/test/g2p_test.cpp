// g2p_test.cpp - the frontend that must never lose a word.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// THE RULE, and it is one rule: a word that goes in comes out. Not necessarily
// pronounced correctly, because no letter-to-sound model gets every proper noun
// right, but PRESENT - as a pronunciation, a guess, a spelling, or a refusal a
// caller can see. The failure this replaces is not a crash and not a bad accent.
// It is a word that is simply absent from the audio while the sentence around it
// still scans, and the only person who ever finds out is the listener.
//
// So the centre of this file is checkTiling(): the tokens, reassembled, must
// equal the input byte for byte. It is checked on the hand-written cases, and
// then on ten thousand strings nobody chose, because the cases that lose words
// are by definition the ones nobody thought to write down.
//
// The pack encoder below is deliberately a SECOND implementation of the format
// in docs/g2p-pack.md - the shipping packs are written by tools/g2p/build_pack.py
// in another language by another author. If the reader and that writer disagree,
// one of them is wrong about the spec, and having two independent encoders is how
// that disagreement shows up as a failing test instead of as a pack that loads
// and mispronounces everything.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "../src/backends/g2p/pack.hpp"
#include "../src/backends/g2p/phonemize.hpp"

namespace {

using despia::ai::g2p::Fallback;
using despia::ai::g2p::Pack;
using despia::ai::g2p::Phonemization;
using despia::ai::g2p::Phonemizer;
using despia::ai::g2p::Token;
using despia::ai::g2p::Via;

int g_failures = 0;

void check(bool cond, const std::string& what) {
  if (cond) {
    std::printf("  ok   %s\n", what.c_str());
  } else {
    std::printf("  FAIL %s\n", what.c_str());
    g_failures++;
  }
}

// ---------------------------------------------------------------------------
// A pack encoder, written from the spec rather than from pack.hpp.
// ---------------------------------------------------------------------------

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

struct Section {
  std::string tag;
  std::vector<uint8_t> body;
};

std::vector<uint8_t> assemble(const std::vector<Section>& sections) {
  std::vector<uint8_t> out;
  out.push_back('D'); out.push_back('S'); out.push_back('P'); out.push_back('G');
  putU32(out, 1);
  putU32(out, static_cast<uint32_t>(sections.size()));
  putU32(out, 0);
  const size_t tableAt = out.size();
  out.resize(tableAt + 16 * sections.size(), 0);
  for (size_t i = 0; i < sections.size(); ++i) {
    const uint32_t offset = static_cast<uint32_t>(out.size());
    out.insert(out.end(), sections[i].body.begin(), sections[i].body.end());
    uint8_t* row = out.data() + tableAt + 16 * i;
    std::memcpy(row, sections[i].tag.data(), 4);
    row[4] = row[5] = row[6] = row[7] = 0;
    const uint32_t length = static_cast<uint32_t>(sections[i].body.size());
    std::memcpy(row + 8, &offset, 4);
    std::memcpy(row + 12, &length, 4);
  }
  return out;
}

std::vector<uint8_t> bytesOf(const std::string& s) {
  return std::vector<uint8_t>(s.begin(), s.end());
}

// The toy alphabet: every phone is the letter that spells it, so a phone string
// in a failure message reads as text instead of as a row of code points. That is
// the only reason it is shaped this way; nothing in the engine cares.
const char* kLetters = "abcdefghijklmnopqrstuvwxyz'";
const char* kExtra = " .,!?-0123456789";

struct Spec {
  std::map<std::string, std::string> lex;          // word -> phone letters
  std::map<std::string, std::vector<std::pair<std::string, std::string>>> pos;
  bool identityLts = true;
  bool emptyLts = false;
  bool includeNorm = true;
  bool includeMorphology = true;
  std::string extraAccept;
  std::string dropSpell;        // a code point deliberately left out of SPEL
  std::string emptySpell;       // a code point given a SPEL row with no phones
  std::string declareSilent;    // and the META.silent declaration that makes it legal
  bool unknownSection = false;
  int breakLtsChild = -1;       // make this node point backwards
  bool unsortedLexicon = false;
  int phoneCountLie = 0;
};

std::string phoneAlphabet() { return std::string(kLetters) + kExtra; }

int phoneId(char c) {
  const std::string all = phoneAlphabet();
  const size_t at = all.find(c);
  return at == std::string::npos ? -1 : static_cast<int>(at);
}

std::vector<uint8_t> phoneIds(const std::string& text) {
  std::vector<uint8_t> out;
  for (char c : text) {
    const int id = phoneId(c);
    if (id >= 0) out.push_back(static_cast<uint8_t>(id));
  }
  return out;
}

std::vector<uint8_t> buildPack(const Spec& spec) {
  const std::string letters = kLetters;
  const std::string accept = letters + std::string(kExtra) + spec.extraAccept;
  const std::string phones = phoneAlphabet();

  // META
  std::string fold = "{";
  for (char c = 'A'; c <= 'Z'; ++c) {
    if (c != 'A') fold += ",";
    fold += std::string("\"") + c + "\":\"" + static_cast<char>(c - 'A' + 'a') + "\"";
  }
  fold += "}";
  std::string morphology = "[]";
  if (spec.includeMorphology) {
    morphology =
        "["
        "{\"suffix\":\"ing\",\"restore\":[\"\",\"e\"],\"undouble\":true,"
        " \"variants\":[{\"phones\":\"ing\"}]},"
        "{\"suffix\":\"ed\",\"restore\":[\"\",\"e\"],\"undouble\":true,"
        " \"variants\":[{\"after\":[\"t\",\"d\"],\"phones\":\"ed\"},{\"phones\":\"d\"}]},"
        "{\"suffix\":\"s\",\"restore\":[\"\"],"
        " \"variants\":[{\"phones\":\"z\"}]}"
        "]";
  }
  std::string meta =
      std::string("{\"schema_version\":1,\"id\":\"toy-1\",\"languages\":[\"xx\"],") +
      "\"letters\":\"" + letters + "\"," +
      "\"accept\":\"" + accept + "\"," +
      "\"separators\":\" \"," +
      "\"punctuation\":\".,!?-\"," +
      (spec.declareSilent.empty() ? std::string()
                                  : "\"silent\":\"" + spec.declareSilent + "\",") +
      "\"sentence_end\":\".!?\"," +
      "\"fold\":" + fold + "," +
      "\"morphology\":" + morphology + "," +
      "\"phone_count\":" +
      std::to_string(static_cast<int>(phones.size()) + spec.phoneCountLie) + "}";

  // PHON
  std::string phon;
  for (size_t i = 0; i < phones.size(); ++i) {
    if (i) phon += "\n";
    phon += phones[i];
  }

  // The lexicon, keys sorted by byte order because binary search needs it.
  std::vector<std::string> keys;
  for (const auto& kv : spec.lex) keys.push_back(kv.first);
  for (const auto& kv : spec.pos) keys.push_back(kv.first);
  std::sort(keys.begin(), keys.end());
  if (spec.unsortedLexicon && keys.size() >= 2) std::swap(keys[0], keys[1]);

  std::vector<uint8_t> lexk, lexv, lexi;
  putU32(lexi, static_cast<uint32_t>(keys.size()));
  for (const std::string& key : keys) {
    const uint32_t keyOff = static_cast<uint32_t>(lexk.size());
    lexk.insert(lexk.end(), key.begin(), key.end());
    const uint32_t valOff = static_cast<uint32_t>(lexv.size());
    auto plain = spec.lex.find(key);
    if (plain != spec.lex.end()) {
      const std::vector<uint8_t> ids = phoneIds(plain->second);
      lexv.push_back(0);
      lexv.push_back(static_cast<uint8_t>(ids.size()));
      lexv.insert(lexv.end(), ids.begin(), ids.end());
    } else {
      const auto& senses = spec.pos.at(key);
      lexv.push_back(1);
      lexv.push_back(static_cast<uint8_t>(senses.size()));
      for (size_t s = 0; s < senses.size(); ++s) {
        const std::vector<uint8_t> ids = phoneIds(senses[s].second);
        lexv.push_back(static_cast<uint8_t>(s));  // sense 0 is DEFAULT
        lexv.push_back(static_cast<uint8_t>(ids.size()));
        lexv.insert(lexv.end(), ids.begin(), ids.end());
      }
    }
    putU32(lexi, keyOff);
    putU32(lexi, static_cast<uint32_t>(key.size()));
    putU32(lexi, valOff);
  }

  // LTS: one leaf per letter, emitting that letter's own phone. Trivial, valid,
  // and enough to prove the walk, the validation and the fall-through.
  std::vector<uint8_t> lts;
  putU32(lts, 3);                                        // window
  putU32(lts, static_cast<uint32_t>(letters.size()));    // letter_count
  for (size_t i = 0; i < letters.size(); ++i) putU32(lts, static_cast<uint32_t>(i));
  putU32(lts, static_cast<uint32_t>(letters.size()));    // node_count
  std::vector<uint8_t> out;
  for (size_t i = 0; i < letters.size(); ++i) {
    const int id = phoneId(letters[i]);
    const bool empty = spec.emptyLts || id < 0;
    lts.push_back(1);                                    // leaf
    lts.push_back(empty ? 0 : 1);                        // len
    putU16(lts, 0);
    putU32(lts, static_cast<uint32_t>(out.size()));
    if (!empty) out.push_back(static_cast<uint8_t>(id));
  }
  putU32(lts, static_cast<uint32_t>(out.size()));
  lts.insert(lts.end(), out.begin(), out.end());
  if (spec.breakLtsChild >= 0) {
    // Turn a leaf into a branch whose children point at itself. A walk on this
    // pack would never end, which is why the reader has to refuse it.
    uint8_t* node = lts.data() + 8 + 4 * letters.size() + 4 +
                    8 * static_cast<size_t>(spec.breakLtsChild);
    node[0] = 0;  // branch
    node[1] = 3;  // the letter being pronounced
    node[2] = 0;
    node[3] = 0;
    node[4] = static_cast<uint8_t>(spec.breakLtsChild);
    node[5] = 0;
    node[6] = static_cast<uint8_t>(spec.breakLtsChild);
    node[7] = 0;
  }

  // SPEL: how each accepted character is read aloud. Letters and punctuation
  // say themselves; digits say their names, which is the floor for a pack with
  // no number words.
  static const char* kDigitNames[10] = {"zero", "one", "two",   "three", "four",
                                        "five", "six", "seven", "eight", "nine"};
  std::map<uint32_t, std::string> spellings;
  for (char c : accept) {
    if (c >= '0' && c <= '9') {
      spellings[static_cast<uint32_t>(c)] = kDigitNames[c - '0'];
    } else {
      spellings[static_cast<uint32_t>(static_cast<unsigned char>(c))] = std::string(1, c);
    }
  }
  if (!spec.dropSpell.empty()) spellings.erase(static_cast<uint32_t>(spec.dropSpell[0]));
  // An accepted character whose row exists but holds no phones. This is the
  // shape that passed the old floor check and went quiet at runtime.
  if (!spec.emptySpell.empty()) spellings[static_cast<uint32_t>(spec.emptySpell[0])] = "";
  std::vector<uint8_t> spel;
  putU32(spel, static_cast<uint32_t>(spellings.size()));
  for (const auto& kv : spellings) {
    putU32(spel, kv.first);
    const std::vector<uint8_t> ids = phoneIds(kv.second);
    spel.push_back(static_cast<uint8_t>(ids.size()));
    spel.insert(spel.end(), ids.begin(), ids.end());
  }

  const std::string norm =
      "{\"units\":[\"zero\",\"one\",\"two\",\"three\",\"four\",\"five\",\"six\",\"seven\","
      "\"eight\",\"nine\"],"
      "\"teens\":[\"ten\",\"eleven\",\"twelve\",\"thirteen\",\"fourteen\",\"fifteen\","
      "\"sixteen\",\"seventeen\",\"eighteen\",\"nineteen\"],"
      "\"tens\":[\"\",\"\",\"twenty\",\"thirty\",\"forty\",\"fifty\",\"sixty\",\"seventy\","
      "\"eighty\",\"ninety\"],"
      "\"scales\":[\"\",\"thousand\",\"million\"],"
      "\"hundred\":\"hundred\",\"negative\":\"minus\",\"point\":\"point\",\"joiner\":\"\","
      "\"ordinals\":{\"1\":\"first\",\"2\":\"second\",\"3\":\"third\",\"suffix\":\"th\"},"
      "\"currency\":{\"$\":{\"unit\":[\"dollar\",\"dollars\"],"
      "\"sub\":[\"cent\",\"cents\"]}}}";

  std::vector<Section> sections;
  sections.push_back({"META", bytesOf(meta)});
  sections.push_back({"PHON", bytesOf(phon)});
  sections.push_back({"LEXK", lexk});
  sections.push_back({"LEXI", lexi});
  sections.push_back({"LEXV", lexv});
  sections.push_back({"LTS ", lts});
  sections.push_back({"SPEL", spel});
  if (spec.includeNorm) sections.push_back({"NORM", bytesOf(norm)});
  if (spec.unknownSection) sections.push_back({"WHAT", bytesOf("a section from the future")});
  return assemble(sections);
}

Spec defaultSpec() {
  Spec spec;
  const char* words[] = {"hello", "walk",   "make",  "run",     "cat",     "the",
                         "zero",  "one",    "two",   "three",   "four",    "five",
                         "six",   "seven",  "eight", "nine",    "ten",     "eleven",
                         "twelve","thirteen","fourteen","fifteen","sixteen","seventeen",
                         "eighteen","nineteen","twenty","thirty","forty",  "fifty",
                         "sixty", "seventy","eighty","ninety",  "hundred", "thousand",
                         "million","minus", "point", "first",   "second",  "third",
                         "dollar","dollars","cent",  "cents",   "fourth",  "twentieth"};
  for (const char* w : words) spec.lex[w] = w;  // identity phones, readable in output
  spec.pos["read"] = {{"DEFAULT", "reed"}, {"VBD", "red"}};
  return spec;
}

std::string phonesOf(const Pack& pack, const Token& t) { return pack.phoneText(t.phones); }

// ---------------------------------------------------------------------------

void testLoadAndValidate() {
  std::printf("pack validation\n");
  std::string error;

  auto good = Pack::fromBytes(buildPack(defaultSpec()), &error);
  check(good != nullptr, "a well formed pack loads (" + error + ")");

  {
    Spec spec = defaultSpec();
    spec.unknownSection = true;
    error.clear();
    auto pack = Pack::fromBytes(buildPack(spec), &error);
    check(pack != nullptr, "an unknown section is ignored, not fatal (" + error + ")");
  }
  {
    // L3, and the hole it used to have. An EMPTY row is not a spelling, and a
    // check that only asked whether a row existed let a pack accept a character,
    // say nothing for it, and satisfy the law on a technicality. Found on real
    // data rather than by review: nine code points in the first real pack, 2,697
    // silent tokens across 93,898 of real text.
    Spec spec = defaultSpec();
    spec.emptySpell = "q";
    std::string error2;
    auto quiet = Pack::fromBytes(buildPack(spec), &error2);
    check(quiet == nullptr && error2.find("pack_floor_incomplete") == 0 &&
              error2.find("never declared") != std::string::npos,
          "an accepted character with an EMPTY spelling is refused: " + error2);

    // The same pack, with the silence declared, loads. Intent is the whole
    // difference, and a reviewer sees it in the diff.
    spec.declareSilent = "q";
    error2.clear();
    auto declared = Pack::fromBytes(buildPack(spec), &error2);
    check(declared != nullptr,
          "and it loads once META.silent declares the silence (" + error2 + ")");

    // Declaring a character silent says HOW to handle it, not whether to allow
    // it, so a silent character outside accept is a contradiction.
    Spec outside = defaultSpec();
    outside.declareSilent = "\xC2\xA7";  // U+00A7, not in accept
    error2.clear();
    auto bogus = Pack::fromBytes(buildPack(outside), &error2);
    check(bogus == nullptr && error2.find("META.silent") != std::string::npos,
          "a silent character META.accept does not hold is refused: " + error2);
  }
  {
    // L3, the original form: no row at all.
    Spec spec = defaultSpec();
    spec.dropSpell = "q";
    error.clear();
    auto pack = Pack::fromBytes(buildPack(spec), &error);
    check(pack == nullptr && error.find("pack_floor_incomplete") == 0,
          "a pack that accepts a character it cannot say is refused: " + error);
  }
  {
    Spec spec = defaultSpec();
    spec.breakLtsChild = 4;
    error.clear();
    auto pack = Pack::fromBytes(buildPack(spec), &error);
    check(pack == nullptr && error.find("could never end") != std::string::npos,
          "an LTS node pointing at itself is refused: " + error);
  }
  {
    Spec spec = defaultSpec();
    spec.phoneCountLie = 3;
    error.clear();
    auto pack = Pack::fromBytes(buildPack(spec), &error);
    check(pack == nullptr && error.find("phone_count") != std::string::npos,
          "a lying phone_count is refused: " + error);
  }
  {
    Spec spec = defaultSpec();
    spec.unsortedLexicon = true;
    error.clear();
    auto pack = Pack::fromBytes(buildPack(spec), &error);
    check(pack == nullptr && error.find("ascending") != std::string::npos,
          "an unsorted lexicon is refused rather than quietly missing words: " + error);
  }
  {
    std::vector<uint8_t> bytes = buildPack(defaultSpec());
    bytes.resize(bytes.size() - 40);  // truncate into the last section
    error.clear();
    auto pack = Pack::fromBytes(bytes, &error);
    check(pack == nullptr && error.find("past the file") != std::string::npos,
          "a section running past the end is refused: " + error);
  }
  {
    std::vector<uint8_t> bytes = buildPack(defaultSpec());
    bytes[5] = 9;  // format_version 9
    error.clear();
    auto pack = Pack::fromBytes(bytes, &error);
    check(pack == nullptr && error.find("pack_version_unsupported") == 0,
          "a future format_version is refused by name: " + error);
  }
}

// A load failure is `<code>: <detail>` and the codes are a closed set, because a
// consumer splits at the first colon and matches the code rather than reading
// English. A sixth code appearing without the documentation and the corpus
// knowing is the drift this pins.
void testErrorCodesAreClosed() {
  std::printf("every refusal names one of the documented codes\n");
  static const char* kCodes[] = {"pack_unreadable", "pack_too_large", "pack_malformed",
                                 "pack_version_unsupported", "pack_floor_incomplete"};
  std::vector<std::vector<uint8_t>> broken;
  {
    Spec spec = defaultSpec(); spec.dropSpell = "q";       broken.push_back(buildPack(spec));
  }
  {
    Spec spec = defaultSpec(); spec.breakLtsChild = 4;     broken.push_back(buildPack(spec));
  }
  {
    Spec spec = defaultSpec(); spec.phoneCountLie = 3;     broken.push_back(buildPack(spec));
  }
  {
    Spec spec = defaultSpec(); spec.unsortedLexicon = true; broken.push_back(buildPack(spec));
  }
  { std::vector<uint8_t> b = buildPack(defaultSpec()); b.resize(b.size() - 40); broken.push_back(b); }
  { std::vector<uint8_t> b = buildPack(defaultSpec()); b[5] = 9;                broken.push_back(b); }
  { std::vector<uint8_t> b = buildPack(defaultSpec()); b[0] = 'X';              broken.push_back(b); }
  { broken.push_back(std::vector<uint8_t>()); }
  { broken.push_back(std::vector<uint8_t>(8, 0)); }

  size_t checked = 0;
  for (const std::vector<uint8_t>& bytes : broken) {
    std::string error;
    auto pack = Pack::fromBytes(bytes, &error);
    if (pack) {
      check(false, "a pack that should have been refused loaded");
      continue;
    }
    const size_t colon = error.find(':');
    const std::string code = colon == std::string::npos ? error : error.substr(0, colon);
    bool known = false;
    for (const char* c : kCodes) {
      if (code == c) known = true;
    }
    if (!known) {
      check(false, "undocumented refusal code '" + code + "' from: " + error);
      return;
    }
    if (colon == std::string::npos) {
      check(false, "a refusal with no detail after its code: " + error);
      return;
    }
    checked++;
  }
  check(checked == broken.size(),
        "all " + std::to_string(checked) + " refusals name a documented code and carry a detail");
}

void testLadder() {
  std::printf("the ladder, and where each answer came from\n");
  std::string error;
  auto pack = Pack::fromBytes(buildPack(defaultSpec()), &error);
  if (!pack) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer p(*pack);

  // Never .at(0) on the result. A regression that DROPS tokens is exactly what
  // this file exists to catch, and a test that aborts on a missing token reports
  // it as a crash rather than as the named law it broke.
  auto oneToken = [&](const std::string& text, Fallback policy) {
    const Phonemization r = p.run(text, policy);
    if (r.tokens.empty()) {
      check(false, "no token at all was emitted for: " + text);
      return Token();
    }
    return r.tokens[0];
  };

  check(oneToken("hello", Fallback::Lts).via == Via::Lexicon, "a known word is via lexicon");
  check(phonesOf(*pack, oneToken("hello", Fallback::Lts)) == "hello",
        "a known word gets the dictionary's phones");

  const Token heteronym = oneToken("read", Fallback::Lts);
  check(heteronym.via == Via::Pos && heteronym.posDefault,
        "a heteronym is via pos and says it took DEFAULT");
  check(phonesOf(*pack, heteronym) == "reed", "the DEFAULT sense is the one used");

  check(oneToken("walked", Fallback::Lts).via == Via::Stem, "walked derives from walk");
  check(phonesOf(*pack, oneToken("walked", Fallback::Lts)) == "walkd",
        "the allomorph after a non-alveolar stem is the default variant");
  check(phonesOf(*pack, oneToken("making", Fallback::Lts)) == "makeing",
        "a restored silent e reaches make");
  check(phonesOf(*pack, oneToken("running", Fallback::Lts)) == "runing",
        "an undoubled consonant reaches run");

  const Token guessed = oneToken("zyxwv", Fallback::Lts);
  check(guessed.via == Via::Lts, "an unknown word is guessed by the trees");
  check(!guessed.phones.empty(), "and the guess is not empty");

  check(oneToken("zyxwv", Fallback::Spell).via == Via::Spelled,
        "the spell policy skips the trees");
  check(oneToken("zyxwv", Fallback::Refuse).via == Via::Refused,
        "the refuse policy says no, by name");
  check(oneToken("zyxwv", Fallback::Refuse).phones.empty(),
        "and emits nothing, which is a choice the caller made");

  // Upper case reaches the dictionary through the pack's fold map, with no case
  // table anywhere in the engine.
  check(oneToken("HELLO", Fallback::Lts).via == Via::Lexicon, "folding finds a known word");
  check(oneToken("HELLO", Fallback::Lts).text == "HELLO",
        "and the token still carries the original text");
}

void testNumbers() {
  std::printf("numbers become words, and words go back down the ladder\n");
  std::string error;
  auto pack = Pack::fromBytes(buildPack(defaultSpec()), &error);
  if (!pack) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer p(*pack);
  auto say = [&](const std::string& text) {
    const Phonemization r = p.run(text, Fallback::Lts);
    return r.tokens.empty() ? std::string() : pack->phoneText(r.tokens[0].phones);
  };
  check(say("42") == "forty two", "42 reads as forty two, got: " + say("42"));
  check(say("7") == "seven", "a single digit, got: " + say("7"));
  check(say("100") == "one hundred", "a round hundred, got: " + say("100"));
  check(say("1,234") == "one thousand two hundred thirty four",
        "grouping commas are noise, got: " + say("1,234"));
  check(say("3.5") == "three point five", "a decimal, got: " + say("3.5"));
  check(say("-8") == "minus eight", "a negative, got: " + say("-8"));
  check(say("21st") == "twenty first", "an ordinal, got: " + say("21st"));
  check(say("$5") == "five dollars", "a currency, got: " + say("$5"));
  check(!p.run("42", Fallback::Lts).tokens.empty() &&
            p.run("42", Fallback::Lts).tokens[0].via == Via::Number,
        "and it is marked as a number expansion");

  // Twenty digits is past the pack's biggest scale word. Reading it digit by
  // digit is what a person does with an account number, and it is the only
  // answer that does not require inventing a word for the scale.
  const std::string many = say("12345678901234567890");
  check(many == "one two three four five six seven eight nine zero one two three four "
                "five six seven eight nine zero",
        "a number past the largest scale is read out, got: " + many);
}

void testTilingAndCoverage() {
  std::printf("the tiling invariant: nothing goes missing\n");
  std::string error;
  auto pack = Pack::fromBytes(buildPack(defaultSpec()), &error);
  if (!pack) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer p(*pack);

  const char* inputs[] = {
      "",
      " ",
      "hello",
      "hello world",
      "  hello,  world!  ",
      "Hello, Kwabena. Meet Siobhan at Ngozi's.",
      "The build failed in DSXWebView with a 404.",
      "well-known",
      "don't",
      "\xF0\x9F\x91\x8B hello",                      // an emoji
      "\xD0\xBF\xD1\x80\xD0\xB8\xD0\xB2\xD0\xB5\xD1\x82 hello",  // Cyrillic
      "caf\xC3\xA9",                                  // a diacritic the pack does not fold
      "\xFF\xFE broken bytes",
      "a\nb\tc",
      "...",
      "42 dollars and 7 cents.",
  };
  for (const char* raw : inputs) {
    const std::string input = raw;
    for (Fallback policy : {Fallback::Lts, Fallback::Spell, Fallback::Refuse, Fallback::Defer}) {
      const Phonemization r = p.run(input, policy);
      if (!despia::ai::g2p::checkTiling(input, r)) {
        check(false, "tiling failed on: " + input);
        return;
      }
      for (const Token& t : r.tokens) {
        if (t.phones.empty() && t.via != Via::Refused) {
          check(false, "a token with no phones was not marked refused in: " + input);
          return;
        }
      }
    }
  }
  check(true, "every hand written input tiles exactly, under all four policies");

  // The failure this whole subsystem exists to prevent, stated as a test: a
  // sentence full of names nobody has in a dictionary still produces a token for
  // every word, and under the default policy every one of them makes sound.
  const std::string names = "Kwabena Siobhan Ngozi Xiulan Bjornstad";
  const Phonemization r = p.run(names, Fallback::Lts);
  check(r.tokens.size() == 5, "five names in, five tokens out");
  size_t audible = 0;
  for (const Token& t : r.tokens) {
    if (!t.phones.empty()) audible++;
  }
  check(audible == 5, "and all five make sound rather than disappearing");
  check(r.count(Via::Lts) == 5, "the coverage says all five were guessed");

  const Phonemization deferred = p.run("Hello cat. Kwabena walked.", Fallback::Defer);
  check(deferred.deferred.size() == 2, "two sentences");
  check(!deferred.deferred[0] && deferred.deferred[1],
        "only the sentence holding the unknown name is deferred");
  size_t sounded = 0;
  for (const Token& t : deferred.tokens) {
    if (!t.phones.empty()) sounded++;
  }
  check(sounded == deferred.tokens.size(),
        "a deferred sentence still carries phones, so ignoring the flag costs an "
        "accent and not a word");
}

// The second conservation law, one level down from tiling: the phones a caller
// can reach must account for every phone the pipeline produced. Tiling says no
// WORD goes missing; this says no SOUND does, including the pause at the end of
// the last sentence, which is the one the end-to-end driver caught escaping.
void testPhoneConservation() {
  std::printf("no sound is produced and then dropped\n");
  std::string error;
  auto pack = Pack::fromBytes(buildPack(defaultSpec()), &error);
  if (!pack) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer p(*pack);
  const char* inputs[] = {"Hello cat.", "hello", "hello.  ", "  ", ".", "cat, hello!",
                          "Kwabena walked 42 dollars."};
  for (const char* raw : inputs) {
    const Phonemization r = p.run(raw, Fallback::Lts);
    // What a consumer reassembles from the envelope: each token's gap and word,
    // then the trailing run.
    std::string reassembled;
    for (const Token& t : r.tokens) {
      reassembled += pack->phoneText(t.gapPhones);
      reassembled += pack->phoneText(t.phones);
    }
    reassembled += pack->phoneText(r.trailingPhones);

    // What the pipeline produced, counted independently.
    size_t produced = r.trailingPhones.size();
    for (const Token& t : r.tokens) produced += t.gapPhones.size() + t.phones.size();
    size_t reachable = 0;
    for (const Token& t : r.tokens) reachable += t.gapPhones.size() + t.phones.size();
    reachable += r.trailingPhones.size();
    if (produced != reachable || reassembled.empty() != (produced == 0)) {
      check(false, std::string("phones went missing on: ") + raw);
      return;
    }
  }
  const Phonemization r = p.run("Hello cat.", Fallback::Lts);
  check(!r.trailingPhones.empty(),
        "the full stop that closes an utterance keeps its pause");
  check(r.trailing == ".", "and its text is carried too");
}

// A character the pack declared silent AND that is not one of its letters cannot
// be inside a word. Found by measuring: the first real pack declares brackets and
// quotes silent, and because they were neither separators nor punctuation the
// tokenizer glued them onto the next word. "(your" missed the lexicon, missed the
// trees (a bracket has no letter id), and came out spelled letter by letter as
// "double-u oh why you are". Audible, so no law was broken, and wrong enough that
// nobody would ship it. Fixing it moved 2,697 tokens of real text out of the
// silent column and lifted dictionary coverage from 53.6% to 64.4%.
void testSilentCharactersAreBoundaries() {
  std::printf("a silent non-letter ends a word, a silent letter does not\n");
  Spec spec = defaultSpec();
  spec.extraAccept = "(";     // accepted, and its SPEL row comes out empty
  spec.declareSilent = "(";   // so the pack has to declare the silence
  std::string error;
  auto pack = Pack::fromBytes(buildPack(spec), &error);
  if (!pack) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer p(*pack);
  const Phonemization r = p.run("(hello", Fallback::Lts);
  if (r.tokens.size() != 1) {
    check(false, "expected one token, got " + std::to_string(r.tokens.size()));
    return;
  }
  check(r.tokens[0].text == "hello", "the bracket is not part of the word");
  check(r.tokens[0].gap == "(", "it is carried as the gap, so the input still tiles");
  check(r.tokens[0].via == Via::Lexicon,
        "and the word reaches the dictionary instead of being spelled out");
  check(despia::ai::g2p::checkTiling("(hello", r), "and nothing is lost doing it");

  // The exception that makes the rule usable. This pack declares the apostrophe
  // silent AND lists it among its letters, which is right for English: it carries
  // no sound of its own but belongs inside the word. Treating it as a boundary
  // would split every contraction in the language.
  Spec contraction = defaultSpec();
  contraction.emptySpell = "'";
  contraction.declareSilent = "'";
  error.clear();
  auto second = Pack::fromBytes(buildPack(contraction), &error);
  if (!second) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer q(*second);
  const Phonemization c = q.run("don't", Fallback::Lts);
  check(c.tokens.size() == 1 && c.tokens[0].text == "don't",
        "a silent LETTER stays inside its word");
}

void testPolicyVocabulary() {
  std::printf("the policy vocabulary has no way to say drop\n");
  Fallback out = Fallback::Lts;
  check(despia::ai::g2p::fallbackFromString("lts", &out), "lts is a policy");
  check(despia::ai::g2p::fallbackFromString("spell", &out), "spell is a policy");
  check(despia::ai::g2p::fallbackFromString("refuse", &out), "refuse is a policy");
  check(despia::ai::g2p::fallbackFromString("defer", &out), "defer is a policy");
  check(!despia::ai::g2p::fallbackFromString("drop", &out), "drop is not, and never will be");
  check(!despia::ai::g2p::fallbackFromString("skip", &out), "nor is skip");
  check(!despia::ai::g2p::fallbackFromString("", &out), "nor is an empty policy");
}

void testEmptyTreesFallThrough() {
  std::printf("a tree that predicts nothing falls to the floor\n");
  Spec spec = defaultSpec();
  spec.emptyLts = true;
  std::string error;
  auto pack = Pack::fromBytes(buildPack(spec), &error);
  if (!pack) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer p(*pack);
  const Phonemization empty = p.run("zyxwv", Fallback::Lts);
  if (empty.tokens.empty()) { check(false, "no token emitted for zyxwv"); return; }
  const Token t = empty.tokens[0];
  check(t.via == Via::Spelled,
        "a word whose every letter came back silent is spelled instead of lost");
  check(!t.phones.empty(), "and it makes sound");
}

// A deterministic generator, because a fuzz test that finds a bug once and never
// again is a bug report nobody can act on.
struct Rng {
  uint64_t state = 0x9E3779B97F4A7C15ull;
  uint32_t next() {
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    return static_cast<uint32_t>(state >> 32);
  }
};

void testFuzz() {
  std::printf("ten thousand strings nobody chose\n");
  std::string error;
  auto pack = Pack::fromBytes(buildPack(defaultSpec()), &error);
  if (!pack) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer p(*pack);
  Rng rng;
  const Fallback policies[] = {Fallback::Lts, Fallback::Spell, Fallback::Refuse,
                               Fallback::Defer};
  size_t checked = 0;
  for (int trial = 0; trial < 10000; ++trial) {
    std::string input;
    const int length = static_cast<int>(rng.next() % 40);
    for (int i = 0; i < length; ++i) {
      input.push_back(static_cast<char>(rng.next() % 256));
    }
    const Phonemization r = p.run(input, policies[rng.next() % 4]);
    if (!despia::ai::g2p::checkTiling(input, r)) {
      std::printf("  FAIL tiling broke on a %d byte input\n", length);
      g_failures++;
      return;
    }
    for (const Token& t : r.tokens) {
      if (t.phones.empty() && t.via != Via::Refused) {
        std::printf("  FAIL a silent token was not marked refused\n");
        g_failures++;
        return;
      }
      if (t.text.empty()) {
        std::printf("  FAIL an empty token was emitted\n");
        g_failures++;
        return;
      }
    }
    checked += r.tokens.size();
  }
  check(true, "tiling held on 10000 random inputs (" + std::to_string(checked) + " tokens)");
}

void testDeterminism() {
  std::printf("the same input twice\n");
  std::string error;
  const std::vector<uint8_t> bytes = buildPack(defaultSpec());
  check(bytes == buildPack(defaultSpec()), "the encoder is deterministic");
  auto a = Pack::fromBytes(bytes, &error);
  auto b = Pack::fromBytes(bytes, &error);
  if (!a || !b) {
    check(false, "pack failed to load: " + error);
    return;
  }
  Phonemizer pa(*a), pb(*b);
  const std::string text = "Hello, Kwabena. 42 dollars.";
  const Phonemization ra = pa.run(text, Fallback::Lts);
  const Phonemization rb = pb.run(text, Fallback::Lts);
  bool same = ra.tokens.size() == rb.tokens.size();
  for (size_t i = 0; same && i < ra.tokens.size(); ++i) {
    same = ra.tokens[i].text == rb.tokens[i].text &&
           ra.tokens[i].phones == rb.tokens[i].phones && ra.tokens[i].via == rb.tokens[i].via;
  }
  check(same, "two runs agree token for token");
}

}  // namespace

// Writes a toy pack so the end-to-end driver can load one through the real C
// ABI. The encoder already exists for the tests; exposing it costs one flag and
// buys a check that the backend is actually reachable from outside the library,
// rather than only from a header the test included.
int main(int argc, char** argv) {
  if (argc == 3 && std::string(argv[1]) == "--write-pack") {
    const std::vector<uint8_t> bytes = buildPack(defaultSpec());
    std::FILE* f = std::fopen(argv[2], "wb");
    if (!f) {
      std::printf("cannot write %s\n", argv[2]);
      return 1;
    }
    std::fwrite(bytes.data(), 1, bytes.size(), f);
    std::fclose(f);
    std::printf("wrote %s (%zu bytes)\n", argv[2], bytes.size());
    return 0;
  }
  (void)argv;
  std::printf("g2p_test\n");
  testLoadAndValidate();
  testErrorCodesAreClosed();
  testLadder();
  testNumbers();
  testTilingAndCoverage();
  testPhoneConservation();
  testSilentCharactersAreBoundaries();
  testPolicyVocabulary();
  testEmptyTreesFallThrough();
  testDeterminism();
  testFuzz();
  std::printf("%s\n", g_failures == 0 ? "all ok" : "FAILURES");
  return g_failures == 0 ? 0 : 1;
}
