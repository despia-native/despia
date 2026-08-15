// pack.hpp - the .dspg reader, and the place the never-silent law is proven.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The format is docs/g2p-pack.md and that file is the contract; this one is the
// implementation of it. Read the four laws there before changing anything here,
// because most of the code below exists to enforce one of them rather than to
// read a field.
//
// The design stance in one line: EVERY structural property this reader relies
// on later is checked once, here, at load. A pack that could walk an LTS tree
// forever, index past a blob, or leave a character with no way to be spoken is
// a load ERROR - typed, named, returned to the caller - and never a surprise on
// a device at three in the morning. Validation costs a few milliseconds once
// per pack. The alternative costs a bug report nobody can reproduce.
//
// There are no Unicode tables here. Case folding, diacritic folding, the
// alphabet, the letter names, the number words: all of it is data in the pack,
// because the engine names no language.

#ifndef DESPIA_AI_G2P_PACK_HPP
#define DESPIA_AI_G2P_PACK_HPP

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "../../json.hpp"
#include "text.hpp"

namespace despia {
namespace ai {
namespace g2p {

using PhoneId = uint8_t;

// The id a letter position takes when a question looks past the end of a word.
// It is one past the last real letter, which is why `letters` is capped at 255
// rather than 256: the padding id has to fit in the same byte.
inline uint8_t paddingLetter(size_t letterCount) {
  return static_cast<uint8_t>(letterCount);
}

// A lexicon hit. `posLen` is zero for a plain entry; otherwise the entry is
// conditioned on part of speech and `phones` already holds the DEFAULT sense,
// because this build ships no tagger and says so per token rather than
// choosing quietly.
struct LexEntry {
  std::vector<PhoneId> phones;
  bool posConditioned = false;
};

class Pack {
 public:
  // Reads and fully validates a pack. Returns null with `*error` set on any
  // failure. `error` is a short machine-ish reason followed by detail, because
  // it travels to a host that has to show a human something actionable.
  static std::unique_ptr<Pack> open(const std::string& path, std::string* error) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) {
      if (error) *error = "pack_unreadable: cannot open '" + path + "'";
      return nullptr;
    }
    std::vector<uint8_t> bytes;
    uint8_t chunk[65536];
    size_t got = 0;
    while ((got = std::fread(chunk, 1, sizeof(chunk), f)) > 0) {
      bytes.insert(bytes.end(), chunk, chunk + got);
      // A pack is a few megabytes. A file claiming to be one and running to a
      // gigabyte is a mistake or an attack, and either way reading it all into
      // memory first is the wrong response.
      if (bytes.size() > (64u << 20)) {
        std::fclose(f);
        if (error) *error = "pack_too_large: a G2P pack over 64 MiB is refused";
        return nullptr;
      }
    }
    std::fclose(f);
    return fromBytes(std::move(bytes), error);
  }

  static std::unique_ptr<Pack> fromBytes(std::vector<uint8_t> bytes, std::string* error) {
    std::unique_ptr<Pack> pack(new Pack());
    pack->buf_ = std::move(bytes);
    std::string why;
    if (!pack->parse(&why)) {
      if (error) *error = why;
      return nullptr;
    }
    return pack;
  }

  const json::Value& meta() const { return meta_; }
  size_t phoneCount() const { return phones_.size(); }
  const std::string& phone(PhoneId id) const { return phones_[id]; }

  // Renders a phone id sequence back into the pack's own alphabet, which is what
  // a caller feeds to the acoustic model's tokenizer.
  std::string phoneText(const std::vector<PhoneId>& ids) const {
    std::string out;
    for (PhoneId id : ids) {
      if (id < phones_.size()) out += phones_[id];
    }
    return out;
  }

  // --- the folding and accept surfaces -------------------------------------

  // Applies the pack's fold map, one code point at a time. Anything the map
  // does not mention passes through unchanged, so a pack only has to declare
  // what it wants to change.
  std::string foldText(const std::string& in) const {
    std::string out;
    out.reserve(in.size());
    size_t i = 0;
    while (i < in.size()) {
      const uint32_t cp = decodeUtf8(in, i);
      auto it = fold_.find(cp);
      if (it == fold_.end()) {
        encodeUtf8(cp, out);
      } else {
        out += it->second;
      }
    }
    return out;
  }

  bool accepts(uint32_t cp) const { return accept_.count(cp) != 0; }
  bool isSeparator(uint32_t cp) const { return separator_.count(cp) != 0; }

  // A code point the pack declared silent AND that is not one of its letters
  // cannot be part of a word: it has no sound and no place in the alphabet the
  // trees were trained on. That makes it a word boundary, and deriving it here
  // rather than asking the pack to restate it is the point - a pack that says
  // `(` is silent has already said everything needed.
  //
  // The letter exception is load bearing. This pack declares `'` silent AND
  // lists it in `letters`, which is correct for English: the apostrophe of
  // "don't" carries no sound of its own but belongs inside the word. Treating
  // it as a boundary would split every contraction in the language.
  bool isSilentSeparator(uint32_t cp) const {
    return silent_.count(cp) != 0 && letterIds_.find(cp) == letterIds_.end();
  }

  // The letter id used by the LTS trees, or false when this code point is not
  // one of the pack's letters.
  bool letterId(uint32_t cp, uint8_t* id) const {
    auto it = letterIds_.find(cp);
    if (it == letterIds_.end()) return false;
    *id = it->second;
    return true;
  }
  size_t letterCount() const { return letters_.size(); }

  // How this code point is read aloud. Total over `accept` by construction:
  // validate() refuses a pack where it is not, so a caller inside the accepted
  // set never has to handle a miss.
  bool spell(uint32_t cp, std::vector<PhoneId>* out) const {
    auto it = spell_.find(cp);
    if (it == spell_.end()) return false;
    *out = it->second;
    return true;
  }

  // --- the lexicon ----------------------------------------------------------

  bool hasLexicon() const { return lexCount_ > 0; }

  // Binary search over the key blob. Keys are byte-ordered and validate() has
  // already proven they are strictly ascending, so a miss here is a real miss
  // rather than a search that walked off a badly sorted table.
  bool lookup(const std::string& key, LexEntry* out) const {
    if (lexCount_ == 0) return false;
    size_t lo = 0, hi = lexCount_;
    while (lo < hi) {
      const size_t mid = lo + (hi - lo) / 2;
      const int c = compareKey(mid, key);
      if (c == 0) return readValue(mid, out);
      if (c < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return false;
  }

  // --- the letter-to-sound trees -------------------------------------------

  bool hasLts() const { return ltsNodeCount_ > 0; }

  // Pronounces the letter at `at` in `word`, where `word` is already letter
  // ids. Returns the phones the tree predicts, which may legitimately be none:
  // the `e` of `make` is silent, and a leaf that emits nothing is the correct
  // answer rather than a lost output. The law about nothing disappearing is
  // about WORDS, and it is enforced a layer up.
  void ltsLetter(const std::vector<uint8_t>& word, size_t at,
                 std::vector<PhoneId>* out) const {
    out->clear();
    if (ltsNodeCount_ == 0 || at >= word.size()) return;
    const uint8_t letter = word[at];
    if (letter >= ltsRoots_.size()) return;
    uint32_t node = ltsRoots_[letter];
    const uint8_t pad = paddingLetter(letters_.size());
    // The walk terminates because validate() proved every child index is
    // strictly greater than its parent's. That is a structural guarantee, not
    // an iteration cap dressed up as one.
    while (node < ltsNodeCount_) {
      const uint8_t* n = ltsNodes_ + static_cast<size_t>(node) * 8;
      if (n[0] == 1) {
        const uint8_t len = n[1];
        const uint32_t off = readU32(ltsNodes_ + static_cast<size_t>(node) * 8 + 4);
        for (uint8_t k = 0; k < len; ++k) out->push_back(ltsOut_[off + k]);
        return;
      }
      const uint8_t pos = n[1];
      const uint8_t chr = n[2];
      const long index = static_cast<long>(at) + static_cast<long>(pos) -
                         static_cast<long>(ltsWindow_);
      const uint8_t here = (index < 0 || index >= static_cast<long>(word.size()))
                               ? pad
                               : word[static_cast<size_t>(index)];
      node = (here == chr) ? readU16(n + 4) : readU16(n + 6);
    }
  }

  // --- number words ---------------------------------------------------------

  // The NORM section, verbatim, for the normalizer to read. Absent is a valid
  // state: a pack without it has no number expansion, which is a stated absence
  // rather than a wrong reading of "1979".
  const json::Value& norm() const { return norm_; }

 private:
  Pack() = default;

  // --- byte helpers ---------------------------------------------------------

  static uint32_t readU32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
  }
  static uint16_t readU16(const uint8_t* p) {
    return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) |
                                 (static_cast<uint16_t>(p[1]) << 8));
  }

  struct Section {
    uint32_t offset = 0;
    uint32_t length = 0;
    bool present = false;
  };

  Section section(const char* tag) const {
    auto it = sections_.find(std::string(tag, 4));
    return it == sections_.end() ? Section{} : it->second;
  }

  bool fail(std::string* error, const std::string& why) const {
    if (error) *error = why;
    return false;
  }

  // --- parse and validate ---------------------------------------------------

  bool parse(std::string* error) {
    if (buf_.size() < 16) return fail(error, "pack_malformed: shorter than a header");
    if (std::memcmp(buf_.data(), "DSPG", 4) != 0) {
      return fail(error, "pack_malformed: bad magic, this is not a .dspg");
    }
    const uint32_t version = readU32(buf_.data() + 4);
    if (version != 1) {
      return fail(error, "pack_version_unsupported: format_version " +
                             std::to_string(version) + ", this build reads 1");
    }
    const uint32_t count = readU32(buf_.data() + 8);
    if (readU32(buf_.data() + 12) != 0) {
      return fail(error, "pack_malformed: reserved header word is not zero");
    }
    if (count == 0 || count > 64) {
      return fail(error, "pack_malformed: section_count " + std::to_string(count) +
                             " is outside 1..64");
    }
    const uint64_t tableEnd = 16ull + 16ull * count;
    if (tableEnd > buf_.size()) {
      return fail(error, "pack_malformed: the section table runs past the file");
    }
    for (uint32_t i = 0; i < count; ++i) {
      const uint8_t* row = buf_.data() + 16 + 16 * static_cast<size_t>(i);
      const std::string tag(reinterpret_cast<const char*>(row), 4);
      Section s;
      s.offset = readU32(row + 8);
      s.length = readU32(row + 12);
      s.present = true;
      const uint64_t end = static_cast<uint64_t>(s.offset) + s.length;
      if (end > buf_.size()) {
        return fail(error, "pack_malformed: section '" + tag + "' runs past the file");
      }
      if (s.length > 0 && s.offset < tableEnd) {
        return fail(error, "pack_malformed: section '" + tag + "' overlaps the header");
      }
      if (!sections_.emplace(tag, s).second) {
        return fail(error, "pack_malformed: section '" + tag + "' appears twice");
      }
      // An unknown tag is deliberately NOT an error. A v1 reader loading a pack
      // that grew a section it never heard of is the same must-ignore rule the
      // JSON envelopes carry, and it is what lets a pack ship ahead of a runtime.
    }
    return parseMeta(error) && parsePhones(error) && parseLexicon(error) &&
           parseLts(error) && parseSpeller(error) && parseNorm(error) &&
           validateFloor(error);
  }

  bool parseMeta(std::string* error) {
    const Section s = section("META");
    if (!s.present) return fail(error, "pack_malformed: no META section");
    std::string err;
    meta_ = json::parse(
        std::string(reinterpret_cast<const char*>(buf_.data() + s.offset), s.length), &err);
    if (!meta_.isObject()) {
      return fail(error, "pack_malformed: META is not a JSON object (" + err + ")");
    }
    if (meta_["schema_version"].asInt(0) != 1) {
      return fail(error, "pack_version_unsupported: META schema_version must be 1");
    }
    if (meta_["id"].asString().empty()) {
      return fail(error, "pack_malformed: META has no id");
    }

    // letters: the LTS input alphabet, indexed by position.
    letters_ = codePoints(meta_["letters"].asString());
    if (letters_.empty()) return fail(error, "pack_malformed: META.letters is empty");
    if (letters_.size() > 255) {
      return fail(error, "pack_malformed: META.letters holds " +
                             std::to_string(letters_.size()) +
                             " letters; 255 is the limit because the padding id "
                             "shares the byte");
    }
    for (size_t i = 0; i < letters_.size(); ++i) {
      if (!letterIds_.emplace(letters_[i], static_cast<uint8_t>(i)).second) {
        return fail(error, "pack_malformed: META.letters repeats a code point");
      }
    }

    for (uint32_t cp : codePoints(meta_["accept"].asString())) accept_.insert(cp);
    if (accept_.empty()) return fail(error, "pack_malformed: META.accept is empty");
    for (uint32_t cp : letters_) {
      if (!accept_.count(cp)) {
        return fail(error,
                    "pack_malformed: META.letters holds a code point META.accept does not; "
                    "a letter the pack cannot accept could never reach the trees");
      }
    }
    for (uint32_t cp : codePoints(meta_["separators"].asString(" \t\n\r"))) {
      separator_.insert(cp);
    }
    // Characters the pack accepts and DELIBERATELY voices nothing for: brackets,
    // quotes, a zero-width joiner. Declaring them is the only way L3 can tell an
    // intentional silence from a forgotten one, and that distinction is the whole
    // guarantee - see validateFloor.
    for (uint32_t cp : codePoints(meta_["silent"].asString())) silent_.insert(cp);
    for (uint32_t cp : silent_) {
      if (!accept_.count(cp)) {
        return fail(error,
                    "pack_malformed: META.silent holds U+" + hex(cp) +
                        " which META.accept does not. Declaring a character silent says how to "
                        "handle it, not whether to allow it");
      }
    }

    // fold runs before everything, so its keys have to be single code points.
    // A multi-code-point key would need longest-match scanning, which is a
    // different algorithm and would change the format, not just the data.
    if (meta_.has("fold")) {
      if (!meta_["fold"].isObject()) {
        return fail(error, "pack_malformed: META.fold is not an object");
      }
      for (const auto& kv : meta_["fold"].asObject()) {
        const std::vector<uint32_t> key = codePoints(kv.first);
        if (key.size() != 1) {
          return fail(error, "pack_malformed: META.fold key '" + kv.first +
                                 "' is not exactly one code point");
        }
        if (!kv.second.isString()) {
          return fail(error, "pack_malformed: META.fold value for '" + kv.first +
                                 "' is not a string");
        }
        fold_[key[0]] = kv.second.asString();
      }
    }
    return true;
  }

  bool parsePhones(std::string* error) {
    const Section s = section("PHON");
    if (!s.present) return fail(error, "pack_malformed: no PHON section");
    const char* p = reinterpret_cast<const char*>(buf_.data() + s.offset);
    std::string current;
    for (uint32_t i = 0; i < s.length; ++i) {
      if (p[i] == '\n') {
        phones_.push_back(current);
        current.clear();
      } else {
        current.push_back(p[i]);
      }
    }
    if (!current.empty()) phones_.push_back(current);
    if (phones_.empty()) return fail(error, "pack_malformed: PHON is empty");
    if (phones_.size() > 255) {
      return fail(error, "pack_malformed: PHON holds " + std::to_string(phones_.size()) +
                             " phones; a phone id is one byte so 255 is the limit. A pack "
                             "that needs more is a format_version 2, not a truncated v1");
    }
    const int64_t declared = meta_["phone_count"].asInt(-1);
    if (declared != static_cast<int64_t>(phones_.size())) {
      return fail(error, "pack_malformed: META.phone_count is " + std::to_string(declared) +
                             " but PHON holds " + std::to_string(phones_.size()));
    }
    for (const std::string& ph : phones_) {
      if (ph.empty()) return fail(error, "pack_malformed: PHON holds an empty phone");
    }
    return true;
  }

  int compareKey(size_t i, const std::string& key) const {
    const uint8_t* row = lexIndex_ + i * 12;
    const uint32_t off = readU32(row);
    const uint32_t len = readU32(row + 4);
    const size_t n = len < key.size() ? len : key.size();
    const int c = n == 0 ? 0 : std::memcmp(lexKeys_ + off, key.data(), n);
    if (c != 0) return c;
    if (len == key.size()) return 0;
    return len < key.size() ? -1 : 1;
  }

  bool readValue(size_t i, LexEntry* out) const {
    const uint32_t vo = readU32(lexIndex_ + i * 12 + 8);
    const uint8_t* v = lexValues_ + vo;
    out->phones.clear();
    if (v[0] == 0) {
      out->posConditioned = false;
      const uint8_t len = v[1];
      for (uint8_t k = 0; k < len; ++k) out->phones.push_back(v[2 + k]);
      return true;
    }
    // Form 1: senses conditioned on part of speech. This build has no tagger, so
    // it takes DEFAULT, which validate() has already proven is sense 0.
    out->posConditioned = true;
    const uint8_t len = v[3];
    for (uint8_t k = 0; k < len; ++k) out->phones.push_back(v[4 + k]);
    return true;
  }

  bool parseLexicon(std::string* error) {
    const Section k = section("LEXK"), idx = section("LEXI"), v = section("LEXV");
    const int present = (k.present ? 1 : 0) + (idx.present ? 1 : 0) + (v.present ? 1 : 0);
    if (present == 0) return true;  // a pack may ship rules only
    if (present != 3) {
      return fail(error,
                  "pack_malformed: a lexicon needs all three of LEXK, LEXI and LEXV");
    }
    if (idx.length < 4) return fail(error, "pack_malformed: LEXI is too short");
    const uint8_t* base = buf_.data() + idx.offset;
    lexCount_ = readU32(base);
    if (static_cast<uint64_t>(lexCount_) * 12 + 4 > idx.length) {
      return fail(error, "pack_malformed: LEXI declares more rows than it holds");
    }
    lexIndex_ = base + 4;
    lexKeys_ = buf_.data() + k.offset;
    lexValues_ = buf_.data() + v.offset;

    // One pass proving every row before the first lookup: extents in range, keys
    // strictly ascending by byte order, and every value well formed. Binary
    // search on an unsorted table does not crash, it just quietly misses, which
    // would look exactly like a small vocabulary.
    for (size_t i = 0; i < lexCount_; ++i) {
      const uint8_t* row = lexIndex_ + i * 12;
      const uint64_t ko = readU32(row), kl = readU32(row + 4), vo = readU32(row + 8);
      if (ko + kl > k.length) {
        return fail(error, "pack_malformed: LEXI row " + std::to_string(i) +
                               " names a key outside LEXK");
      }
      if (kl == 0) {
        return fail(error, "pack_malformed: LEXI row " + std::to_string(i) + " has an empty key");
      }
      if (i > 0) {
        const uint8_t* prev = lexIndex_ + (i - 1) * 12;
        const uint64_t po = readU32(prev), pl = readU32(prev + 4);
        const size_t n = pl < kl ? pl : kl;
        int c = n == 0 ? 0 : std::memcmp(lexKeys_ + po, lexKeys_ + ko, n);
        if (c == 0) c = pl < kl ? -1 : (pl > kl ? 1 : 0);
        if (c >= 0) {
          return fail(error, "pack_malformed: LEXI keys are not strictly ascending at row " +
                                 std::to_string(i));
        }
      }
      if (vo + 2 > v.length) {
        return fail(error, "pack_malformed: LEXI row " + std::to_string(i) +
                               " names a value outside LEXV");
      }
      if (!validateValue(lexValues_ + vo, v.length - vo, error, i)) return false;
    }
    return true;
  }

  bool validateValue(const uint8_t* v, uint64_t avail, std::string* error, size_t row) const {
    const std::string where = " (LEXV value for row " + std::to_string(row) + ")";
    auto phonesOk = [&](const uint8_t* p, uint8_t len) {
      for (uint8_t j = 0; j < len; ++j) {
        if (p[j] >= phones_.size()) return false;
      }
      return true;
    };
    if (v[0] == 0) {
      const uint8_t len = v[1];
      if (2ull + len > avail) return fail(error, "pack_malformed: value runs past LEXV" + where);
      if (!phonesOk(v + 2, len)) {
        return fail(error, "pack_malformed: value names a phone id past PHON" + where);
      }
      return true;
    }
    if (v[0] != 1) {
      return fail(error, "pack_malformed: unknown value form " + std::to_string(v[0]) + where);
    }
    const uint8_t senses = v[1];
    if (senses == 0) {
      return fail(error, "pack_malformed: a heteronym entry with no senses" + where);
    }
    uint64_t at = 2;
    for (uint8_t s = 0; s < senses; ++s) {
      if (at + 2 > avail) return fail(error, "pack_malformed: senses run past LEXV" + where);
      const uint8_t pos = v[at];
      const uint8_t len = v[at + 1];
      if (s == 0 && pos != 0) {
        return fail(error,
                    "pack_malformed: the first sense must be DEFAULT (pos 0), because a build "
                    "with no tagger has to have one to fall back to" + where);
      }
      if (at + 2 + len > avail) {
        return fail(error, "pack_malformed: a sense runs past LEXV" + where);
      }
      if (!phonesOk(v + at + 2, len)) {
        return fail(error, "pack_malformed: a sense names a phone id past PHON" + where);
      }
      at += 2 + len;
    }
    return true;
  }

  bool parseLts(std::string* error) {
    const Section s = section("LTS ");
    if (!s.present) return true;  // a lexicon-only pack is legal, and says so
    if (s.length < 12) return fail(error, "pack_malformed: LTS is too short");
    const uint8_t* p = buf_.data() + s.offset;
    ltsWindow_ = readU32(p);
    const uint32_t letterCount = readU32(p + 4);
    if (ltsWindow_ == 0 || ltsWindow_ > 16) {
      return fail(error, "pack_malformed: LTS window " + std::to_string(ltsWindow_) +
                             " is outside 1..16");
    }
    if (letterCount != letters_.size()) {
      return fail(error, "pack_malformed: LTS names " + std::to_string(letterCount) +
                             " letters but META.letters holds " +
                             std::to_string(letters_.size()));
    }
    uint64_t at = 8;
    if (at + 4ull * letterCount + 4 > s.length) {
      return fail(error, "pack_malformed: LTS roots run past the section");
    }
    for (uint32_t i = 0; i < letterCount; ++i) {
      ltsRoots_.push_back(readU32(p + at));
      at += 4;
    }
    ltsNodeCount_ = readU32(p + at);
    at += 4;
    if (at + 8ull * ltsNodeCount_ + 4 > s.length) {
      return fail(error, "pack_malformed: LTS nodes run past the section");
    }
    ltsNodes_ = p + at;
    at += 8ull * ltsNodeCount_;
    const uint32_t outLen = readU32(p + at);
    at += 4;
    if (at + outLen > s.length) {
      return fail(error, "pack_malformed: the LTS output blob runs past the section");
    }
    ltsOut_ = p + at;
    ltsOutLen_ = outLen;

    for (uint32_t r : ltsRoots_) {
      if (r >= ltsNodeCount_) {
        return fail(error, "pack_malformed: an LTS root points past the node array");
      }
    }
    // The walk in ltsLetter has no iteration cap, and it does not need one:
    // every child index is proven greater than its parent's here, so the walk is
    // strictly descending in the array and terminates. A cap would turn a
    // malformed pack into a wrong pronunciation. This turns it into a load error.
    const uint8_t maxLetter = paddingLetter(letters_.size());
    for (uint32_t i = 0; i < ltsNodeCount_; ++i) {
      const uint8_t* n = ltsNodes_ + static_cast<size_t>(i) * 8;
      if (n[0] == 1) {
        const uint8_t len = n[1];
        const uint64_t off = readU32(n + 4);
        if (off + len > ltsOutLen_) {
          return fail(error, "pack_malformed: LTS leaf " + std::to_string(i) +
                                 " names output past the blob");
        }
        for (uint8_t j = 0; j < len; ++j) {
          if (ltsOut_[off + j] >= phones_.size()) {
            return fail(error, "pack_malformed: LTS leaf " + std::to_string(i) +
                                   " names a phone id past PHON");
          }
        }
        continue;
      }
      if (n[0] != 0) {
        return fail(error, "pack_malformed: LTS node " + std::to_string(i) +
                               " has kind " + std::to_string(n[0]));
      }
      if (n[1] > 2 * ltsWindow_) {
        return fail(error, "pack_malformed: LTS node " + std::to_string(i) +
                               " asks about a position outside its window");
      }
      if (n[2] > maxLetter) {
        return fail(error, "pack_malformed: LTS node " + std::to_string(i) +
                               " compares against a letter id that does not exist");
      }
      const uint16_t yes = readU16(n + 4), no = readU16(n + 6);
      if (yes >= ltsNodeCount_ || no >= ltsNodeCount_) {
        return fail(error, "pack_malformed: LTS node " + std::to_string(i) +
                               " points past the node array");
      }
      if (yes <= i || no <= i) {
        return fail(error, "pack_malformed: LTS node " + std::to_string(i) +
                               " has a child that does not come after it, so the walk "
                               "could never end");
      }
    }
    return true;
  }

  bool parseSpeller(std::string* error) {
    const Section s = section("SPEL");
    if (!s.present) return fail(error, "pack_malformed: no SPEL section");
    if (s.length < 4) return fail(error, "pack_malformed: SPEL is too short");
    const uint8_t* p = buf_.data() + s.offset;
    const uint32_t count = readU32(p);
    uint64_t at = 4;
    uint32_t previous = 0;
    for (uint32_t i = 0; i < count; ++i) {
      if (at + 5 > s.length) return fail(error, "pack_malformed: SPEL runs past the section");
      const uint32_t cp = readU32(p + at);
      const uint8_t len = p[at + 4];
      if (i > 0 && cp <= previous) {
        return fail(error, "pack_malformed: SPEL is not sorted by code point at row " +
                               std::to_string(i));
      }
      previous = cp;
      if (at + 5 + len > s.length) {
        return fail(error, "pack_malformed: a SPEL entry runs past the section");
      }
      std::vector<PhoneId> phones;
      for (uint8_t j = 0; j < len; ++j) {
        const uint8_t id = p[at + 5 + j];
        if (id >= phones_.size()) {
          return fail(error, "pack_malformed: a SPEL entry names a phone id past PHON");
        }
        phones.push_back(id);
      }
      spell_[cp] = std::move(phones);
      at += 5 + len;
    }
    return true;
  }

  bool parseNorm(std::string* error) {
    const Section s = section("NORM");
    if (!s.present) return true;
    std::string err;
    norm_ = json::parse(
        std::string(reinterpret_cast<const char*>(buf_.data() + s.offset), s.length), &err);
    if (!norm_.isObject()) {
      return fail(error, "pack_malformed: NORM is not a JSON object (" + err + ")");
    }
    return true;
  }

  // L3. This is the check the whole format exists to make possible: a pack that
  // accepts a character it cannot say is a pack that will one day drop a word,
  // and it does not load. Failing here costs a build. Failing at runtime costs a
  // user a sentence they never knew was incomplete.
  //
  // AN EMPTY SPEL ROW USED TO PASS THIS, and that was the hole. The check asked
  // whether a row EXISTED, so a pack could accept `(` and map it to no phones at
  // all, satisfy the letter of the law, and go quiet at runtime - which is the
  // precise failure this law was written against, wearing a costume the validator
  // was happy with. Measured on 93,898 tokens of real text against the first real
  // pack: 2,697 tokens produced no sound while holding a character the pack said
  // it accepted. Nine code points were responsible (" ' ( ) [ ] ` { }), every one
  // of them a bracket or a quote whose silence was a deliberate choice nobody had
  // any way to declare.
  //
  // So intent has to be written down. A pack that wants a character to voice
  // nothing lists it in META.silent, where a reviewer sees it in the diff.
  // Everything else in `accept` needs phones. The difference between the two is
  // exactly the difference between a decision and an oversight, and a validator
  // that cannot tell them apart is not checking anything.
  bool validateFloor(std::string* error) {
    for (uint32_t cp : accept_) {
      auto it = spell_.find(cp);
      if (it == spell_.end()) {
        return fail(error,
                    "pack_floor_incomplete: META.accept holds U+" + hex(cp) +
                        " but SPEL has no way to read it aloud. A pack that can accept a "
                        "character it cannot speak can silently drop a word, so it is "
                        "refused rather than loaded");
      }
      if (it->second.empty() && !silent_.count(cp)) {
        return fail(error,
                    "pack_floor_incomplete: META.accept holds U+" + hex(cp) +
                        " and its SPEL row is EMPTY, which is silence the pack never declared. "
                        "If that silence is deliberate, list the code point in META.silent so a "
                        "reviewer sees the decision; if it is not, give it phones");
      }
    }
    return true;
  }

  static std::string hex(uint32_t cp) {
    static const char* digits = "0123456789ABCDEF";
    std::string out;
    for (int shift = 16; shift >= 0; shift -= 4) {
      const uint32_t nibble = (cp >> shift) & 0xF;
      if (!out.empty() || nibble != 0 || shift == 0) out.push_back(digits[nibble]);
    }
    return out;
  }

  std::vector<uint8_t> buf_;
  std::map<std::string, Section> sections_;
  json::Value meta_;
  json::Value norm_;

  std::vector<std::string> phones_;
  std::vector<uint32_t> letters_;
  std::map<uint32_t, uint8_t> letterIds_;
  std::set<uint32_t> accept_;
  std::set<uint32_t> separator_;
  std::set<uint32_t> silent_;
  std::map<uint32_t, std::string> fold_;
  std::map<uint32_t, std::vector<PhoneId>> spell_;

  size_t lexCount_ = 0;
  const uint8_t* lexIndex_ = nullptr;
  const uint8_t* lexKeys_ = nullptr;
  const uint8_t* lexValues_ = nullptr;

  uint32_t ltsWindow_ = 0;
  std::vector<uint32_t> ltsRoots_;
  uint32_t ltsNodeCount_ = 0;
  const uint8_t* ltsNodes_ = nullptr;
  const uint8_t* ltsOut_ = nullptr;
  uint32_t ltsOutLen_ = 0;
};

}  // namespace g2p
}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_G2P_PACK_HPP
