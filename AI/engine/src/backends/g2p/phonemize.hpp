// phonemize.hpp - the ladder, and the reason none of its rungs can drop a word.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// docs/g2p-pack.md states the four laws. This file is L1, L2 and L4; pack.hpp is
// L3. The single most important property in it is the TILING invariant:
//
//   for every token t, in order:  out += t.gap + t.text
//   then                          out += trailing
//   and                           out == the input, byte for byte.
//
// Not "roughly the input". The same bytes. Every character of the caller's text
// belongs to exactly one token's `gap` or `text`, which makes it structurally
// impossible for this code to lose a word: losing one would fail an equality a
// test can check on any string, including strings nobody thought to write down.
// checkTiling() below is that check, the conformance corpus runs it on every
// case, and the fuzz test runs it on inputs the corpus does not contain.
//
// This matters because the failure this frontend replaces was not a crash. The
// upstream implementation assigns an unknown word a placeholder its vocabulary
// does not contain, and the tokenizer's normalizer then strips it. The word does
// not come out wrong. It does not come out at all, the sentence still scans, and
// the only person who finds out is the user.
//
// The engine knows no English here either. Suffixes, voicing, number words,
// letter names and sentence enders are all read from the pack.

#ifndef DESPIA_AI_G2P_PHONEMIZE_HPP
#define DESPIA_AI_G2P_PHONEMIZE_HPP

#include <cstdint>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>

#include "pack.hpp"
#include "text.hpp"

namespace despia {
namespace ai {
namespace g2p {

// json::Value indexes objects but not arrays, and the pack's number words are
// arrays read by position. Reading past the end yields Null, which is the same
// must-ignore stance the key lookup already takes.
inline const json::Value& atIndex(const json::Value& v, size_t i) {
  static const json::Value kNull;
  if (!v.isArray() || i >= v.asArray().size()) return kNull;
  return v.asArray()[i];
}

// Where a pronunciation came from. This is L2: a caller can tell a dictionary
// fact from a guess without asking, which is what makes it reasonable to guess
// at all.
enum class Via {
  Lexicon,   // the pack's dictionary knew the word
  Pos,       // a heteronym entry; see `posDefault`, because there is no tagger
  Stem,      // derived from a known stem by the pack's morphology rules
  Number,    // expanded to words by the pack's NORM data, then looked up
  Lts,       // guessed by the letter-to-sound trees
  Spelled,   // read out one character at a time
  Refused    // the pack declined to say it, and said so
};

inline const char* viaName(Via v) {
  switch (v) {
    case Via::Lexicon: return "lexicon";
    case Via::Pos: return "pos";
    case Via::Stem: return "stem";
    case Via::Number: return "number";
    case Via::Lts: return "lts";
    case Via::Spelled: return "spelled";
    case Via::Refused: return "refused";
  }
  return "refused";
}

// What to do with a word the dictionary does not have. There is no `drop`, and
// there is no plan to add one. `refuse` is the closest thing to it and it is
// still not silent: the token is present, marked, and counted.
enum class Fallback {
  Lts,     // guess with the trees. The default, and what an app wants.
  Spell,   // read it out. Louder about not knowing, never wrong about a name.
  Refuse,  // emit nothing for it, but say so per token and in the coverage.
  Defer    // guess AND mark the sentence, so the caller can hand it to another
           // synthesizer. Guessing anyway is deliberate: a caller that ignores
           // the mark gets a mispronunciation, which beats a hole in a sentence.
};

inline bool fallbackFromString(const std::string& s, Fallback* out) {
  if (s == "lts") { *out = Fallback::Lts; return true; }
  if (s == "spell") { *out = Fallback::Spell; return true; }
  if (s == "refuse") { *out = Fallback::Refuse; return true; }
  if (s == "defer") { *out = Fallback::Defer; return true; }
  return false;  // "drop" lands here, and that is the point
}

struct Token {
  std::string gap;   // the exact input text between the previous token and this
  std::string text;  // the exact input text of this token
  std::vector<PhoneId> gapPhones;
  std::vector<PhoneId> phones;
  Via via = Via::Refused;
  bool posDefault = false;   // a heteronym resolved to DEFAULT, no tagger present
  bool unaccepted = false;   // held a character the pack cannot accept at all
  size_t sentence = 0;
};

struct Phonemization {
  std::vector<Token> tokens;
  std::string trailing;                  // input after the last token
  std::vector<PhoneId> trailingPhones;   // and what it sounds like
  std::vector<std::string> sentences;    // sentence text, for `defer`
  std::vector<bool> deferred;            // parallel to `sentences`
  size_t counts[7] = {0, 0, 0, 0, 0, 0, 0};  // indexed by Via

  size_t count(Via v) const { return counts[static_cast<int>(v)]; }
};

// The invariant, as a function, because an invariant nobody can execute is a
// comment. Returns true when the tokens tile the input exactly.
inline bool checkTiling(const std::string& input, const Phonemization& p) {
  std::string rebuilt;
  rebuilt.reserve(input.size());
  for (const Token& t : p.tokens) {
    rebuilt += t.gap;
    rebuilt += t.text;
  }
  rebuilt += p.trailing;
  return rebuilt == input;
}

class Phonemizer {
 public:
  explicit Phonemizer(const Pack& pack) : pack_(pack) {
    // The space between spelled letters and between expanded number words. It
    // is a pack character like any other; if the pack does not accept a space
    // the joiner is simply empty, which is correct for an alphabet that does
    // not separate words.
    std::vector<PhoneId> sp;
    if (pack_.spell(' ', &sp)) joiner_ = sp;
    for (uint32_t cp : codePoints(pack_.meta()["punctuation"].asString(""))) {
      punctuation_.insert(cp);
    }
    for (uint32_t cp : codePoints(pack_.meta()["sentence_end"].asString(".!?"))) {
      sentenceEnd_.insert(cp);
    }
    // The marks that hold a numeral together rather than ending a word. Declared
    // by the pack because the decimal point is a comma in most of the world, and
    // an engine that assumed either one would be wrong half the time.
    for (uint32_t cp : codePoints(pack_.meta()["numeric_infix"].asString(".,"))) {
      numericInfix_.insert(cp);
    }
    for (uint32_t cp : codePoints(pack_.meta()["numeric_prefix"].asString("-"))) {
      numericPrefix_.insert(cp);
    }
    // Every currency sign the pack's number words know is also a numeric prefix,
    // derived rather than restated: a pack that adds a currency should not have
    // to remember to add it in a second place.
    if (pack_.norm()["currency"].isObject()) {
      for (const auto& kv : pack_.norm()["currency"].asObject()) {
        for (uint32_t cp : codePoints(kv.first)) numericPrefix_.insert(cp);
      }
    }
  }

  Phonemization run(const std::string& input, Fallback policy) const {
    Phonemization out;
    size_t i = 0;
    size_t sentence = 0;
    std::string gap;
    std::string sentenceText;
    std::vector<PhoneId> gapPhones;
    bool sentenceHasWords = false;

    while (i < input.size()) {
      const size_t start = i;
      const uint32_t cp = decodeUtf8(input, i);
      if (isBoundary(cp) && !opensNumber(input, cp, i)) {
        // Every boundary byte lands in `gap`, which is half of what makes the
        // tiling invariant hold: nothing is classified and then forgotten.
        gap.append(input, start, i - start);
        sentenceText.append(input, start, i - start);
        appendSpelled(cp, &gapPhones);
        if (sentenceEnd_.count(cp) && sentenceHasWords) {
          out.sentences.push_back(sentenceText);
          out.deferred.push_back(false);
          sentenceText.clear();
          sentenceHasWords = false;
          ++sentence;
        }
        continue;
      }
      // A word runs to the next boundary. `end` advances only through code
      // points that were examined and kept, so the substring below is exactly
      // the bytes the loop consumed.
      size_t end = i;
      while (end < input.size()) {
        size_t probe = end;
        const uint32_t next = decodeUtf8(input, probe);
        if (isBoundary(next) && !gluesNumber(input, start, end, next, probe)) break;
        end = probe;
      }
      Token token;
      token.gap.swap(gap);
      token.gapPhones.swap(gapPhones);
      token.text = input.substr(start, end - start);
      token.sentence = sentence;
      i = end;

      pronounce(token.text, policy, &token);
      sentenceText += token.text;
      sentenceHasWords = true;
      out.counts[static_cast<int>(token.via)]++;
      out.tokens.push_back(std::move(token));
    }
    // Whatever is left over is trailing, not lost. An input that is nothing but
    // spaces produces no tokens and all of itself as trailing, and the tiling
    // check still passes, which is the behaviour worth having.
    out.trailing = gap;
    // The closing punctuation of the last sentence lands here, and it is audible:
    // a full stop is a pause the acoustic model knows. Carrying only the text and
    // dropping the phones would lose a beat rather than a word, which is a
    // smaller version of the same mistake.
    out.trailingPhones = gapPhones;
    if (sentenceHasWords || !sentenceText.empty()) {
      out.sentences.push_back(sentenceText);
      out.deferred.push_back(false);
    }

    // Deferral is decided per token and applied per SENTENCE, once every
    // sentence exists. Handing a synthesizer half a clause sounds worse than
    // either voice alone, so the unit of handoff is the sentence the token was
    // in.
    if (policy == Fallback::Defer) {
      for (const Token& t : out.tokens) {
        if (!needsDeferral(t)) continue;
        while (out.deferred.size() <= t.sentence) {
          out.sentences.push_back(std::string());
          out.deferred.push_back(false);
        }
        out.deferred[t.sentence] = true;
      }
    }
    return out;
  }

 private:
  // A digit, judged AFTER folding, which is how a pack whose script has its own
  // digits gets them handled without the engine carrying a second numeral
  // system: it maps them to ASCII in `fold`, exactly as it maps case.
  bool isDigit(uint32_t cp) const {
    const std::string folded = pack_.foldText(fromCodePoint(cp));
    return folded.size() == 1 && folded[0] >= '0' && folded[0] <= '9';
  }

  bool digitAt(const std::string& s, size_t at) const {
    if (at >= s.size()) return false;
    size_t probe = at;
    return isDigit(decodeUtf8(s, probe));
  }

  bool lastIsDigit(const std::string& s, size_t from, size_t to) const {
    if (to <= from) return false;
    // Step back to the start of the last code point. Continuation bytes are
    // 10xxxxxx, so the first byte that is not one begins the character.
    size_t at = to - 1;
    while (at > from && (static_cast<unsigned char>(s[at]) & 0xC0) == 0x80) --at;
    return digitAt(s, at);
  }

  // "1,234" and "3.5" are one number, not three tokens. A punctuation mark glues
  // into a word only when a digit sits on BOTH sides of it, which is why
  // "well-known" still splits: the rule is about numerals, not about hyphens.
  bool gluesNumber(const std::string& input, size_t start, size_t end, uint32_t cp,
                   size_t after) const {
    if (!numericInfix_.count(cp)) return false;
    return lastIsDigit(input, start, end) && digitAt(input, after);
  }

  // A sign or a currency mark immediately in front of digits belongs to the
  // number. Anywhere else it is ordinary punctuation and stays in the gap.
  bool opensNumber(const std::string& input, uint32_t cp, size_t after) const {
    if (!numericPrefix_.count(cp)) return false;
    return digitAt(input, after);
  }

  bool isBoundary(uint32_t cp) const {
    // Classify on the FOLDED form, because that is what the rest of the ladder
    // sees. A pack that folds a typographic apostrophe into a letter apostrophe
    // must not have "don’t" split in two before the fold ever runs.
    const std::string folded = pack_.foldText(fromCodePoint(cp));
    if (folded.empty()) return true;
    size_t k = 0;
    while (k < folded.size()) {
      const uint32_t f = decodeUtf8(folded, k);
      if (!pack_.isSeparator(f) && !punctuation_.count(f) &&
          !pack_.isSilentSeparator(f)) {
        return false;
      }
    }
    return true;
  }

  void appendSpelled(uint32_t cp, std::vector<PhoneId>* out) const {
    std::vector<PhoneId> phones;
    if (pack_.spell(cp, &phones)) {
      out->insert(out->end(), phones.begin(), phones.end());
    }
  }

  // A sentence is deferred when any word in it was guessed rather than known.
  // A stem derivation counts as known: it is a rule applied to a dictionary
  // fact, not a letter-to-sound guess about a name.
  static bool needsDeferral(const Token& t) {
    return t.via == Via::Lts || t.via == Via::Spelled || t.via == Via::Refused;
  }

  // --- the ladder -----------------------------------------------------------

  void pronounce(const std::string& original, Fallback policy, Token* token) const {
    const std::string word = pack_.foldText(original);

    // Anything the pack cannot accept is recorded on the token no matter which
    // rung answers. This is L4: the caller learns that something was outside the
    // pack's world, and still gets whatever could be said of the rest.
    size_t k = 0;
    while (k < word.size()) {
      if (!pack_.accepts(decodeUtf8(word, k))) {
        token->unaccepted = true;
        break;
      }
    }

    if (expandNumber(word, policy, token)) return;

    LexEntry entry;
    if (pack_.lookup(word, &entry)) {
      token->phones = entry.phones;
      token->via = entry.posConditioned ? Via::Pos : Via::Lexicon;
      token->posDefault = entry.posConditioned;
      if (token->unaccepted) token->via = Via::Refused;
      return;
    }
    if (deriveStem(word, token)) {
      if (token->unaccepted) token->via = Via::Refused;
      return;
    }

    if (policy == Fallback::Refuse) {
      token->phones.clear();
      token->via = Via::Refused;
      return;
    }
    if ((policy == Fallback::Lts || policy == Fallback::Defer) && applyLts(word, token)) {
      if (token->unaccepted) token->via = Via::Refused;
      return;
    }
    spellOut(word, token);
    if (token->unaccepted) token->via = Via::Refused;
  }

  // The rung that guesses. It applies only when every character is a letter the
  // trees were trained on; a word with a digit or a symbol in it goes to the
  // speller instead, because a tree asked about a letter it has never seen would
  // answer with whatever its root happened to hold.
  bool applyLts(const std::string& word, Token* token) const {
    if (!pack_.hasLts() || word.empty()) return false;
    std::vector<uint8_t> ids;
    size_t k = 0;
    while (k < word.size()) {
      uint8_t id = 0;
      if (!pack_.letterId(decodeUtf8(word, k), &id)) return false;
      ids.push_back(id);
    }
    std::vector<PhoneId> phones, letterPhones;
    for (size_t at = 0; at < ids.size(); ++at) {
      pack_.ltsLetter(ids, at, &letterPhones);
      phones.insert(phones.end(), letterPhones.begin(), letterPhones.end());
    }
    // A word whose every letter is silent is not a pronunciation, it is the
    // deletion this file exists to prevent wearing a tree's clothes. Fall
    // through to the speller, which cannot return nothing.
    if (phones.empty()) return false;
    token->phones = phones;
    token->via = Via::Lts;
    return true;
  }

  // The floor. pack.hpp has already proven SPEL covers everything in `accept`,
  // so this cannot come back empty for accepted text, and a character outside
  // `accept` contributes nothing but has already set `unaccepted` on the token.
  void spellOut(const std::string& word, Token* token) const {
    std::vector<PhoneId> phones, one;
    size_t k = 0;
    bool first = true;
    while (k < word.size()) {
      const uint32_t cp = decodeUtf8(word, k);
      if (!pack_.spell(cp, &one) || one.empty()) continue;
      if (!first) phones.insert(phones.end(), joiner_.begin(), joiner_.end());
      phones.insert(phones.end(), one.begin(), one.end());
      first = false;
    }
    token->phones = phones;
    token->via = phones.empty() ? Via::Refused : Via::Spelled;
  }

  // --- morphology -----------------------------------------------------------

  bool deriveStem(const std::string& word, Token* token) const {
    const json::Value& rules = pack_.meta()["morphology"];
    if (!rules.isArray()) return false;
    for (const json::Value& rule : rules.asArray()) {
      const std::string suffix = rule["suffix"].asString();
      if (suffix.empty() || word.size() <= suffix.size()) continue;
      if (word.compare(word.size() - suffix.size(), suffix.size(), suffix) != 0) continue;
      const std::string base = word.substr(0, word.size() - suffix.size());

      std::vector<std::string> candidates;
      candidates.push_back(base);
      if (rule["restore"].isArray()) {
        for (const json::Value& r : rule["restore"].asArray()) {
          const std::string extra = r.asString();
          if (!extra.empty()) candidates.push_back(base + extra);
        }
      }
      if (rule["undouble"].asBool(false) && base.size() >= 2 &&
          base[base.size() - 1] == base[base.size() - 2]) {
        candidates.push_back(base.substr(0, base.size() - 1));
      }

      for (const std::string& candidate : candidates) {
        LexEntry entry;
        if (candidate.empty() || !pack_.lookup(candidate, &entry)) continue;
        if (entry.phones.empty()) continue;
        std::vector<PhoneId> ending;
        if (!chooseVariant(rule, entry.phones.back(), &ending)) continue;
        token->phones = entry.phones;
        token->phones.insert(token->phones.end(), ending.begin(), ending.end());
        token->via = Via::Stem;
        return true;
      }
    }
    return false;
  }

  // Picks the allomorph whose `after` set holds the stem's last phone, else the
  // variant that declares no `after`. A rule whose last variant has an `after`
  // can simply fail to match, and then the derivation is skipped rather than
  // guessed at, which is the honest reading of an incomplete rule.
  bool chooseVariant(const json::Value& rule, PhoneId lastPhone,
                     std::vector<PhoneId>* out) const {
    if (!rule["variants"].isArray()) return false;
    const std::string& last = pack_.phone(lastPhone);
    for (const json::Value& variant : rule["variants"].asArray()) {
      bool matches = false;
      if (!variant.has("after")) {
        matches = true;
      } else if (variant["after"].isArray()) {
        for (const json::Value& a : variant["after"].asArray()) {
          if (a.asString() == last) { matches = true; break; }
        }
      }
      if (!matches) continue;
      return phonesFromText(variant["phones"].asString(), out);
    }
    return false;
  }

  // Turns a phone string from the pack's own alphabet back into ids. Longest
  // match first, because a pack whose alphabet holds both a phone and a
  // two-character phone starting with it must not be split at the wrong place.
  bool phonesFromText(const std::string& text, std::vector<PhoneId>* out) const {
    out->clear();
    size_t at = 0;
    while (at < text.size()) {
      size_t best = 0;
      PhoneId bestId = 0;
      for (size_t id = 0; id < pack_.phoneCount(); ++id) {
        const std::string& ph = pack_.phone(static_cast<PhoneId>(id));
        if (ph.size() > best && at + ph.size() <= text.size() &&
            text.compare(at, ph.size(), ph) == 0) {
          best = ph.size();
          bestId = static_cast<PhoneId>(id);
        }
      }
      if (best == 0) return false;
      out->push_back(bestId);
      at += best;
    }
    return !out->empty();
  }

  // --- numbers --------------------------------------------------------------

  // Expands a numeric token into WORDS and sends each of them back down the
  // ladder, so "seventeen" gets its pronunciation from the same dictionary every
  // other word does. A second phone table for number words is a second thing to
  // get wrong.
  bool expandNumber(const std::string& word, Fallback policy, Token* token) const {
    const json::Value& norm = pack_.norm();
    if (!norm.isObject() || word.empty()) return false;

    std::string digits;
    for (char c : word) {
      if (c >= '0' && c <= '9') digits.push_back(c);
    }
    if (digits.empty()) return false;

    std::vector<std::string> words;
    if (!numberWords(word, norm, &words) || words.empty()) return false;

    std::vector<PhoneId> phones;
    bool first = true;
    for (const std::string& w : words) {
      Token sub;
      sub.text = w;
      pronounce(w, policy == Fallback::Refuse ? Fallback::Spell : policy, &sub);
      if (sub.phones.empty()) continue;
      if (!first) phones.insert(phones.end(), joiner_.begin(), joiner_.end());
      phones.insert(phones.end(), sub.phones.begin(), sub.phones.end());
      first = false;
    }
    if (phones.empty()) return false;
    token->phones = phones;
    token->via = Via::Number;
    return true;
  }

  bool numberWords(const std::string& word, const json::Value& norm,
                   std::vector<std::string>* out) const {
    std::string body = word;
    std::string currency;
    // A leading currency sign, if the pack knows one. Folded text, so the sign
    // is whatever survived folding.
    if (norm["currency"].isObject()) {
      for (const auto& kv : norm["currency"].asObject()) {
        if (!kv.first.empty() && body.compare(0, kv.first.size(), kv.first) == 0) {
          currency = kv.first;
          body = body.substr(kv.first.size());
          break;
        }
      }
    }
    bool negative = false;
    if (!body.empty() && body[0] == '-') {
      negative = true;
      body = body.substr(1);
    }
    // Grouping separators are noise once the digits are in hand.
    std::string cleaned;
    for (char c : body) {
      if (c != ',') cleaned.push_back(c);
    }

    std::string integral = cleaned, fraction;
    const size_t dot = cleaned.find('.');
    if (dot != std::string::npos) {
      integral = cleaned.substr(0, dot);
      fraction = cleaned.substr(dot + 1);
    }
    std::string ordinalSuffix;
    for (size_t k = 0; k < integral.size(); ++k) {
      if (integral[k] < '0' || integral[k] > '9') {
        ordinalSuffix = integral.substr(k);
        integral = integral.substr(0, k);
        break;
      }
    }
    if (integral.empty()) return false;
    for (char c : fraction) {
      if (c < '0' || c > '9') return false;  // not a number after all
    }
    const bool ordinal = !ordinalSuffix.empty() && fraction.empty() &&
                         isOrdinalSuffix(ordinalSuffix, norm);
    if (!ordinalSuffix.empty() && !ordinal) return false;

    if (negative) out->push_back(norm["negative"].asString("minus"));
    if (!cardinal(integral, norm, ordinal, out)) return false;
    if (!fraction.empty()) {
      out->push_back(norm["point"].asString("point"));
      const json::Value& units = norm["units"];
      for (char c : fraction) {
        out->push_back(atIndex(units, static_cast<size_t>(c - '0')).asString());
      }
    }
    if (!currency.empty()) {
      const json::Value& spec = norm["currency"][currency]["unit"];
      const bool one = integral == "1" && fraction.empty();
      if (spec.isArray() && spec.size() >= 2) {
        out->push_back(atIndex(spec, one ? 0 : 1).asString());
      }
    }
    return true;
  }

  static bool isOrdinalSuffix(const std::string& s, const json::Value& norm) {
    // The pack names the regular suffix; the irregular English trio is spelled
    // by the ordinal words themselves, so accept any two-letter suffix that the
    // pack's own ordinal table produces.
    if (s == norm["ordinals"]["suffix"].asString("th")) return true;
    return s == "st" || s == "nd" || s == "rd";
  }

  bool cardinal(const std::string& digits, const json::Value& norm, bool ordinal,
                std::vector<std::string>* out) const {
    std::string trimmed = digits;
    size_t lead = 0;
    while (lead + 1 < trimmed.size() && trimmed[lead] == '0') ++lead;
    trimmed = trimmed.substr(lead);
    const json::Value& scales = norm["scales"];
    // Longer than the pack's biggest scale word: read it digit by digit rather
    // than inventing a scale name. A phone number and a credit card number are
    // read that way anyway.
    const size_t maxDigits = scales.isArray() ? scales.size() * 3 : 0;
    if (trimmed.size() > maxDigits) {
      const json::Value& units = norm["units"];
      for (char c : trimmed) out->push_back(atIndex(units, static_cast<size_t>(c - '0')).asString());
      return true;
    }
    const size_t groups = (trimmed.size() + 2) / 3;
    bool wrote = false;
    for (size_t g = 0; g < groups; ++g) {
      const size_t from = trimmed.size() >= (groups - g) * 3
                              ? trimmed.size() - (groups - g) * 3
                              : 0;
      const size_t len = trimmed.size() - from - ((groups - g - 1) * 3);
      const std::string chunk = trimmed.substr(from, len);
      const int value = std::atoi(chunk.c_str());
      if (value == 0) continue;
      const bool lastGroup = (g + 1 == groups);
      threeDigits(value, norm, ordinal && lastGroup, out);
      const std::string scale = atIndex(scales, groups - g - 1).asString();
      if (!scale.empty()) out->push_back(scale);
      wrote = true;
    }
    if (!wrote) {
      out->push_back(ordinal ? ordinalWord(0, norm) : atIndex(norm["units"], 0).asString());
    }
    return true;
  }

  void threeDigits(int value, const json::Value& norm, bool ordinal,
                   std::vector<std::string>* out) const {
    const int hundreds = value / 100;
    const int rest = value % 100;
    if (hundreds > 0) {
      out->push_back(atIndex(norm["units"], static_cast<size_t>(hundreds)).asString());
      if (rest == 0 && ordinal) {
        out->push_back(regularOrdinal(norm["hundred"].asString("hundred"), norm));
        return;
      }
      out->push_back(norm["hundred"].asString("hundred"));
      const std::string joinWord = norm["joiner"].asString("");
      if (rest > 0 && !joinWord.empty()) out->push_back(joinWord);
    }
    if (rest == 0) return;
    if (rest < 10) {
      out->push_back(ordinal ? ordinalWord(rest, norm)
                             : atIndex(norm["units"], static_cast<size_t>(rest)).asString());
      return;
    }
    if (rest < 20) {
      if (ordinal) {
        out->push_back(ordinalWord(rest, norm));
      } else {
        out->push_back(atIndex(norm["teens"], static_cast<size_t>(rest - 10)).asString());
      }
      return;
    }
    const int tens = rest / 10, units = rest % 10;
    if (units == 0) {
      out->push_back(ordinal ? ordinalWord(tens * 10, norm)
                             : atIndex(norm["tens"], static_cast<size_t>(tens)).asString());
      return;
    }
    out->push_back(atIndex(norm["tens"], static_cast<size_t>(tens)).asString());
    out->push_back(ordinal ? ordinalWord(units, norm)
                           : atIndex(norm["units"], static_cast<size_t>(units)).asString());
  }

  std::string ordinalWord(int value, const json::Value& norm) const {
    const json::Value& table = norm["ordinals"];
    const std::string key = std::to_string(value);
    if (table.has(key)) return table[key].asString();
    std::string cardinalWord;
    if (value < 10) {
      cardinalWord = atIndex(norm["units"], static_cast<size_t>(value)).asString();
    } else if (value < 20) {
      cardinalWord = atIndex(norm["teens"], static_cast<size_t>(value - 10)).asString();
    } else {
      cardinalWord = atIndex(norm["tens"], static_cast<size_t>(value / 10)).asString();
    }
    return regularOrdinal(cardinalWord, norm);
  }

  // The regular form: append the pack's suffix, and turn a final "y" into "ie"
  // first. The "y" rule is stated in the format doc rather than in the data
  // because it is orthography, not vocabulary, and every pack that has a
  // regular ordinal suffix at all needs the same handling of it.
  std::string regularOrdinal(const std::string& word, const json::Value& norm) const {
    const std::string suffix = norm["ordinals"]["suffix"].asString("th");
    if (!word.empty() && word[word.size() - 1] == 'y') {
      return word.substr(0, word.size() - 1) + "ie" + suffix;
    }
    return word + suffix;
  }

  const Pack& pack_;
  std::vector<PhoneId> joiner_;
  std::set<uint32_t> punctuation_;
  std::set<uint32_t> sentenceEnd_;
  std::set<uint32_t> numericInfix_;
  std::set<uint32_t> numericPrefix_;
};

}  // namespace g2p
}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_G2P_PHONEMIZE_HPP
