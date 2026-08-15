#!/usr/bin/env python3
"""Write a ``.dspg`` G2P pack from the verified sources and the trained trees.

The format is the one in ``OpenSource/AI/docs/g2p-pack.md``: a header, a section
table, and the sections META, PHON, LEXK, LEXI, LEXV, ``LTS ``, SPEL and NORM,
little-endian throughout.

The pack is validated before it is written, and validated again by reading the
bytes back with a reader that shares no state with the writer.  That second pass
is the point.  A writer that checks its own in-memory structures proves that the
structures are consistent; it does not prove that the bytes say what the
structures said.  The rules being proved are the four in the document: nothing is
dropped, every pronunciation says where it came from, the speller is total over
the accepted character set, and what cannot be pronounced is reported.  The third
is the one a build can break, so L3 is checked here and again by the reader.

Two derivations in this file are worth reading before the code, because both
could have been typed from memory and both would have been wrong:

- the speller comes from the lexicon.  The name of the letter ``w`` is whatever
  the lexicon says the key ``W`` is pronounced, which is ``dˈʌbᵊlju``.  No IPA in
  this file was written by hand;
- the morphology allomorphs come from counting real stem and inflected pairs in
  the lexicon.  Which phones take ``ᵻz`` rather than ``z`` is measured, printed,
  and only shipped where the measurement is one-sided.

Nothing here ships.  The pack is a build artifact with a recorded digest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
import tempfile
import unicodedata
import zlib
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import g2p_common as C  # noqa: E402


MAGIC = b"DSPG"
FORMAT_VERSION = 1
SECTION_TAGS = [b"META", b"PHON", b"LEXK", b"LEXI", b"LEXV", b"LTS ", b"SPEL", b"NORM"]

PACK_ID = "en-us-1"
PACK_NAME = "English (United States)"
PACK_LANGUAGES = ["en", "en-US"]

# Characters the pack accepts and deliberately says nothing for: brackets and
# quotes carry no sound of their own, and reading them aloud inside a spelled word
# is worse than passing over them.  Their SPEL rows are empty, and an empty row is
# only legal because META.silent declares it.  That declaration is the whole point:
# a reader that only checks whether a row EXISTS cannot tell a chosen silence from
# a forgotten one, and the forgotten one is the failure L3 was written to prevent.
SILENT = "'\"()[]{}`"

# Characters that are read as a word.  The words are looked up in the lexicon like
# any other word, so the phones come from the same place every other phone does.
SYMBOL_WORDS: Dict[str, List[str]] = {
    "$": ["dollar"],
    "£": ["pound"],
    "€": ["euro"],
    "%": ["percent"],
    "&": ["and"],
    "@": ["at"],
    "#": ["number"],
    "/": ["slash"],
    "+": ["plus"],
    "=": ["equals"],
    "*": ["star"],
    "_": ["underscore"],
    "\\": ["backslash"],
    "|": ["bar"],
    "~": ["tilde"],
    "^": ["caret"],
    "<": ["less", "than"],
    ">": ["greater", "than"],
}

DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]

# The number, ordinal and currency words, as graphemes.  They go back through the
# lexicon ladder like any other word, so this table decides what is said and the
# lexicon decides how it is pronounced.  The layout is documented under `### NORM`
# in g2p-pack.md and the reader implements the rules; nothing here is phones.
NORM = {
    "units": DIGIT_WORDS,
    "teens": ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
              "sixteen", "seventeen", "eighteen", "nineteen"],
    "tens": ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"],
    "scales": ["", "thousand", "million", "billion", "trillion", "quadrillion"],
    "hundred": "hundred",
    "negative": "minus",
    "point": "point",
    "joiner": "",
    "ordinals": {
        "1": "first", "2": "second", "3": "third", "5": "fifth", "8": "eighth",
        "9": "ninth", "12": "twelfth", "20": "twentieth", "30": "thirtieth",
        "40": "fortieth", "50": "fiftieth", "60": "sixtieth", "70": "seventieth",
        "80": "eightieth", "90": "ninetieth", "suffix": "th",
    },
    "currency": {
        "$": {"unit": ["dollar", "dollars"], "sub": ["cent", "cents"]},
        "£": {"unit": ["pound", "pounds"], "sub": ["penny", "pence"]},
        "€": {"unit": ["euro", "euros"], "sub": ["cent", "cents"]},
    },
}

# The suffixes the pack teaches the engine to strip, and the candidate stems to try
# after stripping.  The allomorph tables are measured, not written here.
MORPHOLOGY_RULES = [
    {"suffix": "s", "restore": [""], "undouble": False},
    {"suffix": "es", "restore": ["", "e"], "undouble": False},
    {"suffix": "ies", "restore": ["y"], "undouble": False},
    {"suffix": "ed", "restore": ["", "e"], "undouble": True},
    {"suffix": "ing", "restore": ["", "e"], "undouble": True},
]

# An allomorph is only given an "after" set where the evidence is one-sided.  A
# phone needs this many observations and this share of them agreeing before the
# pack claims a rule about it.  A wrong voicing rule is applied to every word.
MORPH_MIN_OBSERVATIONS = 20
MORPH_MIN_PURITY = 0.90


class BuildError(RuntimeError):
    """A pack that would be wrong.  Every one of these refuses to write a file."""


# ---------------------------------------------------------------------------
# character sets
# ---------------------------------------------------------------------------


def accepted_characters() -> str:
    """The set L3 is proven against, sorted by code point.

    It is every printable ASCII character except the upper case letters, which
    ``fold`` removes before anything looks at this set, plus the separators and
    the two non-ASCII currency signs the NORM table names.  Sorted rather than
    written in a readable order because the order is data a reader may binary
    search, and a hand order is a diff waiting to happen.
    """
    chars = set(C.LETTERS) | set("0123456789")
    chars |= set(C.SEPARATORS) | set(C.PUNCTUATION) | set(SILENT) | set(SYMBOL_WORDS)
    return "".join(sorted(chars))


def build_fold(accept: str) -> Dict[str, str]:
    """Everything that has to become an accepted character before lookup.

    Derived by Unicode decomposition rather than typed out: a letter whose NFD
    form is an accepted letter plus combining marks folds to that letter.  The
    hand written part is the list of characters Unicode does not decompose, which
    is short and each entry is a well known equivalence.
    """
    fold: Dict[str, str] = {}
    accepted = set(accept)

    for code in range(ord("A"), ord("Z") + 1):
        fold[chr(code)] = chr(code + 32)

    for code in list(range(0x00C0, 0x0250)) + list(range(0x1E00, 0x1F00)):
        char = chr(code)
        if char in accepted or char in fold:
            continue
        if not unicodedata.category(char).startswith("L"):
            continue
        stripped = "".join(
            c for c in unicodedata.normalize("NFD", char.lower())
            if not unicodedata.combining(c)
        ).lower()
        if stripped and stripped != char and all(c in accepted for c in stripped):
            fold[char] = stripped

    # The letters Unicode does not decompose, plus the typography ordinary text is
    # full of.  Anything invisible or indistinguishable on screen is written as an
    # escape, because a fold table nobody can read is a fold table nobody checks.
    extra = {
        "\u00c6": "ae", "\u00e6": "ae", "\u0152": "oe", "\u0153": "oe",
        "\u00df": "ss", "\u1e9e": "ss", "\u00d8": "o", "\u00f8": "o",
        "\u0110": "d", "\u0111": "d", "\u00d0": "th", "\u00f0": "th",
        "\u00de": "th", "\u00fe": "th", "\u0141": "l", "\u0142": "l",
        "\u0126": "h", "\u0127": "h", "\u014a": "ng", "\u014b": "ng",
        "\u0131": "i", "\u017f": "s",
        "\u2019": "'", "\u2018": "'", "\u201a": "'", "\u201b": "'",
        "\u2032": "'", "\u00b4": "'", "\u02bc": "'",
        "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"',
        "\u00ab": '"', "\u00bb": '"', "\u2033": '"',
        "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2012": "-",
        "\u2212": "-", "\u00ad": "-", "\u2011": "-",
        "\u2026": "...", "\u00a0": " ", "\u2007": " ", "\u2009": " ",
        "\u200a": " ", "\u202f": " ", "\u205f": " ", "\u3000": " ",
        "\u000b": " ", "\u000c": " ",
        "\u2044": "/", "\u00d7": "x", "\u00b7": ".",
    }
    for source, target in extra.items():
        if source in accepted:
            continue
        if not all(c in accepted for c in target):
            raise BuildError("fold target %r for %r is not accepted" % (target, source))
        fold[source] = target

    for source, target in fold.items():
        if len(source) != 1:
            raise BuildError("fold key %r is not a single code point" % source)
        if not target:
            raise BuildError("fold %r to nothing would delete input" % source)
        if not all(c in accepted for c in target):
            raise BuildError("fold %r to %r leaves the accepted set" % (source, target))
    return fold


# ---------------------------------------------------------------------------
# speller
# ---------------------------------------------------------------------------


def build_speller(
    lexicon: Dict[str, object],
    view: Dict[str, str],
    phone_id: Dict[str, int],
    accept: str,
    verbose: bool,
) -> Tuple[Dict[int, List[int]], str]:
    """How every accepted character is read aloud, in phone ids.

    Returns the table and the code points it deliberately left empty, which is
    what META.silent has to say.  The declaration is derived from the decision
    rather than written next to it, so the two cannot drift apart.

    Five classes, and the class is the whole design:

    - a letter is read as its NAME, and the lexicon already holds the names under
      the upper case single character keys.  ``lexicon["W"]`` is ``dˈʌbᵊlju``, so
      the speller says "double you" for ``w`` without this file knowing that;
    - a digit is read as its number word, looked up the same way;
    - a symbol is read as its word, looked up the same way again;
    - punctuation is spoken as itself, so its entry is the phone whose text is
      that same character;
    - a separator is a word gap, so it is the space phone.

    Brackets and quotes are the fifth class and the one that needs declaring: an
    entry of zero phones.  That is not the same thing as having no entry, and it
    is also not the same thing as a character somebody forgot to give a sound.
    META.silent is what tells those two apart, so this function refuses to leave a
    row empty for anything it was not asked to silence.
    """
    speller: Dict[int, List[int]] = {}
    derivations: List[Tuple[str, str, str]] = []
    space_id = phone_id[" "]

    def phones_for_words(words: Sequence[str]) -> Tuple[List[int], str]:
        ids: List[int] = []
        text: List[str] = []
        for index, word in enumerate(words):
            pronunciation = view.get(word)
            if pronunciation is None:
                raise BuildError("no lexicon entry for the spelling word %r" % word)
            if index:
                ids.append(space_id)
                text.append(" ")
            ids.extend(phone_id[c] for c in pronunciation)
            text.append(pronunciation)
        return ids, "".join(text)

    for char in accept:
        if char in C.SEPARATORS:
            speller[ord(char)] = [space_id]
            derivations.append((char, "separator", " "))
        elif char in C.PUNCTUATION:
            speller[ord(char)] = [phone_id[char]]
            derivations.append((char, "punctuation", char))
        elif char.isdigit():
            ids, text = phones_for_words([DIGIT_WORDS[int(char)]])
            speller[ord(char)] = ids
            derivations.append((char, "digit %r" % DIGIT_WORDS[int(char)], text))
        elif "a" <= char <= "z":
            key = char.upper()
            pronunciation = lexicon.get(key)
            if pronunciation is None:
                raise BuildError("the lexicon has no letter name for %r" % key)
            text = C.default_pronunciation(pronunciation)
            speller[ord(char)] = [phone_id[c] for c in text]
            derivations.append((char, "letter name from lexicon[%r]" % key, text))
        elif char in SYMBOL_WORDS:
            ids, text = phones_for_words(SYMBOL_WORDS[char])
            speller[ord(char)] = ids
            derivations.append((char, "word %s" % " ".join(SYMBOL_WORDS[char]), text))
        elif char in SILENT:
            speller[ord(char)] = []
            derivations.append((char, "silent, declared in META.silent", ""))
        else:
            raise BuildError("accepted character %r has no spelling class" % char)

    # The only empty rows allowed are the ones this builder chose, and every one
    # it chose has to be empty.  Both directions are checked because either
    # mismatch is the same defect wearing a different hat: META.silent no longer
    # describing what SPEL does.
    silent = "".join(sorted(char for char in accept if not speller[ord(char)]))
    for char in accept:
        empty = not speller[ord(char)]
        declared = char in SILENT
        if empty and not declared:
            raise BuildError(
                "%r would get an empty SPEL row without being declared silent" % char
            )
        if declared and not empty:
            raise BuildError("%r is declared silent but was given phones" % char)
    if silent != "".join(sorted(SILENT)):
        raise BuildError("the silent set does not match what the speller produced")

    if verbose:
        print("speller, one line per accepted character:")
        for char, how, text in derivations:
            print("  U+%04X %-8s %-34s %s" % (ord(char), repr(char), how, text))
        print("META.silent, derived from the rows left empty: %r (%d code points)"
              % (silent, len(silent)))
    return speller, silent


# ---------------------------------------------------------------------------
# morphology
# ---------------------------------------------------------------------------


def stem_candidates(word: str, rule: Dict) -> List[str]:
    """The stems the engine will try, in the order it will try them."""
    suffix = rule["suffix"]
    base = word[: len(word) - len(suffix)]
    candidates = [base + restore for restore in rule["restore"]]
    if rule["undouble"] and len(base) >= 2 and base[-1] == base[-2] and base[-1] not in "aeiou":
        candidates.extend(base[:-1] + restore for restore in rule["restore"])
    return candidates


def derive_morphology(
    view: Dict[str, str], phones: Sequence[str], verbose: bool
) -> List[Dict]:
    """Measure which phones take which allomorph, over the real lexicon.

    For every inflected word the lexicon knows whose stem it also knows, the
    phones the suffix added are whatever the inflected pronunciation has that the
    stem's does not.  Tabulating those against the stem's last phone is the rule,
    and it is a measurement rather than a recollection of a phonetics table.

    An "after" set is only emitted for a phone where the evidence is one-sided.
    Everything else falls to the default variant, which is a stated simplification
    and not a wrong rule applied to ninety thousand words.
    """
    rules: List[Dict] = []
    phone_set = set(phones)
    for rule in MORPHOLOGY_RULES:
        suffix = rule["suffix"]
        tally: Dict[str, Dict[str, int]] = {}
        pairs = 0
        for word, pronunciation in view.items():
            if len(word) <= len(suffix) or not word.endswith(suffix):
                continue
            stem_phones = None
            for candidate in stem_candidates(word, rule):
                found = view.get(candidate)
                if found is not None:
                    stem_phones = found
                    break
            if stem_phones is None or not stem_phones:
                continue
            if not pronunciation.startswith(stem_phones):
                continue
            added = pronunciation[len(stem_phones):]
            if not added or any(c not in phone_set for c in added):
                continue
            last = stem_phones[-1]
            tally.setdefault(added, {})
            tally[added][last] = tally[added].get(last, 0) + 1
            pairs += 1

        totals = {form: sum(counts.values()) for form, counts in tally.items()}
        if not totals:
            raise BuildError("no evidence at all for the suffix %r" % suffix)
        default = max(sorted(totals), key=lambda form: (totals[form], form))
        per_phone: Dict[str, int] = {}
        for form, counts in tally.items():
            for phone, count in counts.items():
                per_phone[phone] = per_phone.get(phone, 0) + count

        variants = []
        for form in sorted(totals, key=lambda f: (-totals[f], f)):
            if form == default:
                continue
            after = []
            for phone in sorted(tally[form]):
                count = tally[form][phone]
                if count < MORPH_MIN_OBSERVATIONS:
                    continue
                if count / per_phone[phone] < MORPH_MIN_PURITY:
                    continue
                after.append(phone)
            if after:
                variants.append({"after": after, "phones": form})
        variants.append({"phones": default})

        if verbose:
            print("morphology -%s: %s stem/inflected pairs found" % (suffix, C.format_count(pairs)))
            for form in sorted(totals, key=lambda f: (-totals[f], f))[:6]:
                share = 100.0 * totals[form] / pairs
                top = sorted(tally[form].items(), key=lambda kv: (-kv[1], kv[0]))[:8]
                print("    %-4r %7s (%5.1f%%)  after %s"
                      % (form, C.format_count(totals[form]), share,
                         " ".join("%s:%d" % (p, c) for p, c in top)))
            for variant in variants:
                print("    ship %-4r after %s"
                      % (variant["phones"], " ".join(variant.get("after", [])) or "(default)"))
        rules.append({
            "suffix": suffix,
            "restore": rule["restore"],
            "undouble": rule["undouble"],
            "variants": variants,
        })
    return rules


def resolvable(view: Dict[str, str], morphology: Sequence[Dict], word: str) -> bool:
    """Can the pack say this word at all, by lexicon or by morphology?

    Used to check the NORM table.  A number expansion that produces a word the
    pack cannot pronounce would be a number read as letters, which is the kind of
    defect that is only ever noticed by a user.
    """
    if not word:
        return True
    if word in view:
        return True
    for rule in morphology:
        suffix = rule["suffix"]
        if len(word) > len(suffix) and word.endswith(suffix):
            for candidate in stem_candidates(word, rule):
                if candidate in view:
                    return True
    return False


# ---------------------------------------------------------------------------
# sections
# ---------------------------------------------------------------------------


def build_lexicon_sections(
    lexicon: Dict[str, object], phone_id: Dict[str, int], tags: Sequence[str]
) -> Tuple[bytes, bytes, bytes, Dict[str, int]]:
    """LEXK, LEXI and LEXV.

    Keys are sorted by their UTF-8 bytes and concatenated with no separators, so a
    reader binary searches the index and compares byte ranges without decoding.
    Identical values share one blob, which is free: two homophones point at the
    same offset.
    """
    tag_id = {tag: index for index, tag in enumerate(tags)}
    entries = sorted((key.encode("utf-8"), key) for key in lexicon)

    keys = bytearray()
    values = bytearray()
    index = bytearray()
    seen: Dict[bytes, int] = {}
    stats = {"form0": 0, "form1": 0, "shared_values": 0}

    index += struct.pack("<I", len(entries))
    for encoded, key in entries:
        key_off = len(keys)
        keys += encoded
        value = lexicon[key]
        if isinstance(value, str):
            ids = [phone_id[c] for c in value]
            if len(ids) > 255:
                raise BuildError("pronunciation for %r is longer than a u8 length" % key)
            blob = bytes([0, len(ids)]) + bytes(ids)
            stats["form0"] += 1
        else:
            ordered = [C.DEFAULT_POS] + sorted(k for k in value if k != C.DEFAULT_POS)
            if len(ordered) > 255:
                raise BuildError("too many senses for %r" % key)
            blob = bytes([1, len(ordered)])
            for pos in ordered:
                ids = [phone_id[c] for c in value[pos]]
                if len(ids) > 255:
                    raise BuildError("pronunciation for %r/%s is too long" % (key, pos))
                blob += bytes([tag_id[pos], len(ids)]) + bytes(ids)
            stats["form1"] += 1
        offset = seen.get(blob)
        if offset is None:
            offset = len(values)
            seen[blob] = offset
            values += blob
        else:
            stats["shared_values"] += 1
        index += struct.pack("<III", key_off, len(encoded), offset)

    return bytes(keys), bytes(index), bytes(values), stats


def build_lts_section(payload: Dict, letters: str) -> bytes:
    window = payload["window"]
    roots = payload["roots"]
    nodes = payload["nodes"]
    out = payload["out"]
    if len(roots) != len(letters):
        raise BuildError("the trees cover %d letters, META declares %d" % (len(roots), len(letters)))
    if len(nodes) > 0xFFFF + 1:
        raise BuildError("%d nodes cannot be addressed by a u16 child index" % len(nodes))

    blob = bytearray()
    blob += struct.pack("<II", window, len(letters))
    for root in roots:
        if not 0 <= root < len(nodes):
            raise BuildError("tree root %d is out of range" % root)
        blob += struct.pack("<I", root)
    blob += struct.pack("<I", len(nodes))
    for index, node in enumerate(nodes):
        if node[0] == 0:
            _, pos, char, yes, no = node
            if not 0 <= pos <= 2 * window:
                raise BuildError("node %d asks about position %d" % (index, pos))
            if not 0 <= char <= len(letters):
                raise BuildError("node %d asks about letter id %d" % (index, char))
            if yes <= index or no <= index:
                raise BuildError("node %d has a child that is not ahead of it" % index)
            if yes >= len(nodes) or no >= len(nodes):
                raise BuildError("node %d has a child out of range" % index)
            blob += struct.pack("<BBBBHH", 0, pos, char, 0, yes, no)
        else:
            _, length, offset = node
            if length > 255:
                raise BuildError("leaf %d emits %d phones" % (index, length))
            if offset + length > len(out):
                raise BuildError("leaf %d points past the out blob" % index)
            blob += struct.pack("<BBHI", 1, length, 0, offset)
    blob += struct.pack("<I", len(out))
    blob += bytes(out)
    return bytes(blob)


def build_spel_section(speller: Dict[int, List[int]]) -> bytes:
    blob = bytearray()
    blob += struct.pack("<I", len(speller))
    for code in sorted(speller):
        ids = speller[code]
        if len(ids) > 255:
            raise BuildError("spelling for U+%04X is longer than a u8 length" % code)
        blob += struct.pack("<IB", code, len(ids))
        blob += bytes(ids)
    return bytes(blob)


def assemble(sections: Dict[bytes, bytes]) -> bytes:
    """Header, section table, then the sections, each aligned to four bytes.

    Alignment costs at most three bytes per section and means a reader can point a
    typed pointer at LEXI, ``LTS `` and SPEL rather than reading them a byte at a
    time.  The table carries an explicit offset and length for each section, so
    the padding between them is not addressed by anything.
    """
    order = [tag for tag in SECTION_TAGS if tag in sections]
    header = bytearray()
    header += MAGIC
    header += struct.pack("<III", FORMAT_VERSION, len(order), 0)

    body_start = len(header) + 16 * len(order)
    offsets: Dict[bytes, Tuple[int, int]] = {}
    cursor = body_start
    body = bytearray()
    for tag in order:
        pad = (-cursor) % 4
        body += b"\x00" * pad
        cursor += pad
        payload = sections[tag]
        offsets[tag] = (cursor, len(payload))
        body += payload
        cursor += len(payload)

    for tag in order:
        offset, length = offsets[tag]
        header += tag + struct.pack("<III", 0, offset, length)
    return bytes(header) + bytes(body)


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------


def validate_pack(data: bytes) -> Dict[str, object]:
    """Read the file back with no help from the writer, and prove the four rules.

    Everything below is derived from ``data``.  If this function passed because it
    consulted a dict the writer still had in memory, it would prove nothing.
    """
    if len(data) < 16 or data[:4] != MAGIC:
        raise BuildError("not a DSPG file")
    version, count, reserved = struct.unpack_from("<III", data, 4)
    if version != FORMAT_VERSION:
        raise BuildError("format version %d" % version)
    if reserved != 0:
        raise BuildError("reserved header word is not zero")
    table_end = 16 + 16 * count
    if table_end > len(data):
        raise BuildError("section table leaves the file")

    sections: Dict[bytes, bytes] = {}
    for row in range(count):
        tag = data[16 + 16 * row:20 + 16 * row]
        row_reserved, offset, length = struct.unpack_from("<III", data, 20 + 16 * row)
        if row_reserved != 0:
            raise BuildError("section %r has a non-zero reserved word" % tag)
        if offset < table_end:
            raise BuildError("section %r overlaps the header" % tag)
        if offset + length > len(data):
            raise BuildError("section %r leaves the file" % tag)
        if tag in sections:
            raise BuildError("duplicate section tag %r" % tag)
        sections[tag] = data[offset:offset + length]

    for required in (b"META", b"PHON", b"SPEL"):
        if required not in sections:
            raise BuildError("required section %r is missing" % required)

    meta = json.loads(sections[b"META"].decode("utf-8"))
    phones = sections[b"PHON"].decode("utf-8").split("\n")
    if meta["phone_count"] != len(phones):
        raise BuildError("META says %d phones, PHON has %d" % (meta["phone_count"], len(phones)))
    if meta["phone_count"] > 255:
        raise BuildError("phone_count %d does not fit a u8 id" % meta["phone_count"])
    if any(phone == "" for phone in phones):
        raise BuildError("PHON has an empty line")
    phone_index = {phone: index for index, phone in enumerate(phones)}

    accept = set(meta["accept"])
    for name in ("letters", "separators", "punctuation", "sentence_end"):
        missing = sorted(set(meta[name]) - accept)
        if missing:
            raise BuildError("%s has characters outside accept: %r" % (name, missing))
    for source, target in meta["fold"].items():
        if len(source) != 1:
            raise BuildError("fold key %r is not one code point" % source)
        if not target or any(c not in accept for c in target):
            raise BuildError("fold %r to %r leaves accept" % (source, target))

    # L3: the speller is total over the accepted set, and every phone it names
    # exists.  This is the load-time check that makes the silent path impossible.
    spel = sections[b"SPEL"]
    spell_count = struct.unpack_from("<I", spel, 0)[0]
    cursor = 4
    spelled = {}
    previous = -1
    for _ in range(spell_count):
        code, length = struct.unpack_from("<IB", spel, cursor)
        cursor += 5
        if code <= previous:
            raise BuildError("SPEL is not sorted by code point")
        previous = code
        ids = list(spel[cursor:cursor + length])
        cursor += length
        for phone in ids:
            if phone >= len(phones):
                raise BuildError("SPEL entry U+%04X names phone %d" % (code, phone))
        spelled[code] = ids
    if cursor != len(spel):
        raise BuildError("SPEL has %d trailing bytes" % (len(spel) - cursor))
    # Declaring a character silent says how to handle it, not whether to allow it.
    silent = set(meta.get("silent", ""))
    outside = sorted(silent - accept)
    if outside:
        raise BuildError("silent names characters outside accept: %r" % outside)
    for char in sorted(accept):
        if ord(char) not in spelled:
            raise BuildError("L3: accepted character %r has no SPEL entry" % char)
        if not spelled[ord(char)] and char not in silent:
            raise BuildError(
                "L3: accepted character %r has an EMPTY SPEL row that META.silent "
                "does not declare, which is silence the pack never declared" % char
            )
    for char in sorted(silent):
        if spelled[ord(char)]:
            raise BuildError("%r is declared silent but its SPEL row has phones" % char)
    for char in meta["punctuation"]:
        expected = phone_index.get(char)
        if expected is None or spelled[ord(char)] != [expected]:
            raise BuildError("punctuation %r is not spelled as itself" % char)

    lexicon_entries = 0
    if b"LEXI" in sections:
        keys = sections[b"LEXK"]
        index = sections[b"LEXI"]
        values = sections[b"LEXV"]
        lexicon_entries = struct.unpack_from("<I", index, 0)[0]
        if len(index) != 4 + 12 * lexicon_entries:
            raise BuildError("LEXI length does not match its count")
        pos_tags = meta["pos_tags"]
        previous_key = b""
        for row in range(lexicon_entries):
            key_off, key_len, val_off = struct.unpack_from("<III", index, 4 + 12 * row)
            if key_off + key_len > len(keys):
                raise BuildError("entry %d key leaves LEXK" % row)
            key = keys[key_off:key_off + key_len]
            if key <= previous_key and row:
                raise BuildError("LEXK is not sorted at entry %d" % row)
            previous_key = key
            if val_off >= len(values):
                raise BuildError("entry %d value leaves LEXV" % row)
            form = values[val_off]
            if form == 0:
                length = values[val_off + 1]
                end = val_off + 2 + length
                if end > len(values):
                    raise BuildError("entry %d value leaves LEXV" % row)
                for phone in values[val_off + 2:end]:
                    if phone >= len(phones):
                        raise BuildError("entry %d names phone %d" % (row, phone))
            elif form == 1:
                senses = values[val_off + 1]
                cursor = val_off + 2
                first = True
                for _ in range(senses):
                    pos, length = values[cursor], values[cursor + 1]
                    if pos >= len(pos_tags):
                        raise BuildError("entry %d names pos %d" % (row, pos))
                    if first and pos != 0:
                        raise BuildError("entry %d does not start with DEFAULT" % row)
                    first = False
                    cursor += 2
                    for phone in values[cursor:cursor + length]:
                        if phone >= len(phones):
                            raise BuildError("entry %d names phone %d" % (row, phone))
                    cursor += length
                    if cursor > len(values):
                        raise BuildError("entry %d value leaves LEXV" % row)
            else:
                raise BuildError("entry %d has form %d" % (row, form))

    node_count = 0
    if b"LTS " in sections:
        lts = sections[b"LTS "]
        window, letter_count = struct.unpack_from("<II", lts, 0)
        if letter_count != len(meta["letters"]):
            raise BuildError("LTS letter_count %d, META letters %d"
                             % (letter_count, len(meta["letters"])))
        cursor = 8
        roots = list(struct.unpack_from("<%dI" % letter_count, lts, cursor))
        cursor += 4 * letter_count
        node_count = struct.unpack_from("<I", lts, cursor)[0]
        cursor += 4
        nodes_at = cursor
        cursor += 8 * node_count
        out_len = struct.unpack_from("<I", lts, cursor)[0]
        cursor += 4
        out = lts[cursor:cursor + out_len]
        if cursor + out_len != len(lts):
            raise BuildError("LTS section length does not match its contents")
        for phone in out:
            if phone >= len(phones):
                raise BuildError("LTS out blob names phone %d" % phone)
        for root in roots:
            if root >= node_count:
                raise BuildError("tree root %d is out of range" % root)
        for node in range(node_count):
            kind = lts[nodes_at + 8 * node]
            if kind == 0:
                _, pos, char, pad, yes, no = struct.unpack_from("<BBBBHH", lts, nodes_at + 8 * node)
                if pad != 0:
                    raise BuildError("branch %d has a non-zero reserved byte" % node)
                if pos > 2 * window:
                    raise BuildError("branch %d asks about position %d" % (node, pos))
                if char > letter_count:
                    raise BuildError("branch %d asks about letter %d" % (node, char))
                if yes >= node_count or no >= node_count:
                    raise BuildError("branch %d has a child out of range" % node)
                if yes <= node or no <= node:
                    raise BuildError("branch %d has a child that is not ahead of it" % node)
            elif kind == 1:
                _, length, pad, offset = struct.unpack_from("<BBHI", lts, nodes_at + 8 * node)
                if pad != 0:
                    raise BuildError("leaf %d has a non-zero reserved half word" % node)
                if offset + length > out_len:
                    raise BuildError("leaf %d points past the out blob" % node)
            else:
                raise BuildError("node %d has kind %d" % (node, kind))

    if b"NORM" in sections:
        norm = json.loads(sections[b"NORM"].decode("utf-8"))
        for field in ("units", "teens", "tens", "scales"):
            if not isinstance(norm[field], list):
                raise BuildError("NORM.%s is not a list" % field)
        for field in ("hundred", "negative", "point", "joiner"):
            if not isinstance(norm[field], str):
                raise BuildError("NORM.%s is not a string" % field)
        if len(norm["units"]) != 10 or len(norm["teens"]) != 10 or len(norm["tens"]) != 10:
            raise BuildError("NORM digit tables are not ten long")
        if norm["tens"][0] or norm["tens"][1] or norm["scales"][0]:
            raise BuildError("NORM has a word in a slot that is never read")

    return {
        "sections": {tag.decode("ascii"): len(payload) for tag, payload in sections.items()},
        "phones": len(phones),
        "entries": lexicon_entries,
        "nodes": node_count,
        "spelled": len(spelled),
    }


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work-dir", default="/tmp/g2p/sources")
    parser.add_argument("--lts", default="/tmp/g2p/lts-en-us-1.json")
    parser.add_argument("--out", default="/tmp/g2p/en-us-1.dspg")
    parser.add_argument("--quiet", action="store_true", help="skip the derivation listings")
    args = parser.parse_args(argv)
    verbose = not args.quiet

    work = Path(args.work_dir)
    manifest = C.load_sources_manifest(work)
    lexicon, stats = C.load_lexicon(work)
    phones = C.phone_alphabet(lexicon)
    phone_id = {phone: index for index, phone in enumerate(phones)}
    tags = C.pos_tags(lexicon)
    view = dict(C.training_words(lexicon))
    print("lexicon %s entries, %d phones, %d part of speech tags"
          % (C.format_count(len(lexicon)), len(phones), len(tags)))

    payload = json.loads(Path(args.lts).read_text(encoding="utf-8"))
    if payload["phones"] != phones:
        raise BuildError(
            "the trees were trained against a different phone alphabet; retrain them"
        )
    if payload["letters"] != C.LETTERS:
        raise BuildError("the trees were trained against a different letter alphabet")

    accept = accepted_characters()
    fold = build_fold(accept)
    speller, silent = build_speller(lexicon, view, phone_id, accept, verbose)
    morphology = derive_morphology(view, phones, verbose)

    unsayable = sorted({
        word for word in norm_words(NORM) if not resolvable(view, morphology, word)
    })
    if unsayable:
        raise BuildError("NORM names words the pack cannot say: %r" % unsayable)
    print("NORM: %d distinct words, all reachable through the lexicon or morphology"
          % len(set(norm_words(NORM))))

    sources = []
    for source in manifest["sources"]:
        if not source.get("consumed_by_pack", True):
            continue
        sources.append({
            "name": source["name"],
            "spdx": source["spdx"],
            "url": source["url"],
            "sha256": source["sha256"],
        })
    if not sources:
        raise BuildError("no source recorded its licence; the package gate would reject this")

    meta = {
        "schema_version": 1,
        "id": PACK_ID,
        "name": PACK_NAME,
        "languages": PACK_LANGUAGES,
        "letters": C.LETTERS,
        "accept": accept,
        "separators": C.SEPARATORS,
        "punctuation": C.PUNCTUATION,
        "sentence_end": C.SENTENCE_END,
        "silent": silent,
        "fold": fold,
        "phone_count": len(phones),
        "stress": list(C.STRESS),
        "pos_tags": tags,
        "morphology": morphology,
        # What the trees are worth, measured by train_lts.py on words the
        # alignment never saw, so phonemize can report a confidence instead of
        # implying one.  Phone accuracy is edit distance based, because a wrong
        # guess can be the wrong length and scoring position by position would
        # count one inserted phone as a whole word of errors.
        "accuracy": {
            "held_out_words": payload["accuracy"]["held_out_words"],
            "held_out_phones": payload["accuracy"]["held_out_phones"],
            "phone_accuracy": payload["accuracy"]["phone_accuracy"],
            "word_accuracy": payload["accuracy"]["word_accuracy"],
            "phone_accuracy_no_stress": payload["accuracy"]["phone_accuracy_no_stress"],
            "word_accuracy_no_stress": payload["accuracy"]["word_accuracy_no_stress"],
            "measured_by": "train_lts.py held-out split, %d%% seeded on the word"
                           % payload["training"]["hold_out_percent"],
        },
        "lts": {
            "window": payload["window"],
            "nodes": len(payload["nodes"]),
            "leaves": sum(1 for node in payload["nodes"] if node[0] == 1),
            "training_words": payload["training"]["training_words"],
        },
        "sources": sources,
        "notice": (
            "Pronunciation data from misaki 0.9.4 (Apache-2.0). "
            "Letter-to-sound trees trained on that data by "
            "OpenSource/AI/tools/g2p/train_lts.py. "
            "No part-of-speech tagger ships, so every heteronym resolves to DEFAULT."
        ),
    }

    keys, index, values, lexicon_stats = build_lexicon_sections(lexicon, phone_id, tags)
    sections = {
        b"META": C.dump_json_bytes(meta),
        b"PHON": "\n".join(phones).encode("utf-8"),
        b"LEXK": keys,
        b"LEXI": index,
        b"LEXV": values,
        b"LTS ": build_lts_section(payload, C.LETTERS),
        b"SPEL": build_spel_section(speller),
        b"NORM": C.dump_json_bytes(NORM),
    }
    data = assemble(sections)

    summary = validate_pack(data)
    write_atomic(Path(args.out), data)

    print()
    print("pack %s" % args.out)
    print("  bytes            %s" % C.format_count(len(data)))
    print("  sha256           %s" % hashlib.sha256(data).hexdigest())
    print("  deflate-9        %s" % C.format_count(len(zlib.compress(data, 9))))
    print("  entries          %s (form 0 %s, form 1 %s, shared value blobs %s)"
          % (C.format_count(summary["entries"]), C.format_count(lexicon_stats["form0"]),
             C.format_count(lexicon_stats["form1"]), C.format_count(lexicon_stats["shared_values"])))
    print("  phones           %d" % summary["phones"])
    print("  spelled          %d of %d accepted characters"
          % (summary["spelled"], len(accept)))
    print("  lts nodes        %s" % C.format_count(summary["nodes"]))
    print("  sections")
    total = 0
    for tag in SECTION_TAGS:
        name = tag.decode("ascii")
        size = summary["sections"][name]
        total += size
        print("    %-6s %12s  %5.1f%%" % (name, C.format_count(size), 100.0 * size / len(data)))
    print("    %-6s %12s" % ("sum", C.format_count(total)))
    return 0


def norm_words(norm: Dict) -> List[str]:
    """Every grapheme string NORM can put into a sentence."""
    words: List[str] = []
    for field in ("units", "teens", "tens", "scales"):
        words.extend(word for word in norm[field] if word)
    for field in ("hundred", "negative", "point", "joiner"):
        if norm[field]:
            words.append(norm[field])
    for key, value in norm["ordinals"].items():
        if key != "suffix" and value:
            words.append(value)
    for entry in norm["currency"].values():
        words.extend(entry["unit"])
        words.extend(entry["sub"])
    return words


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BuildError as error:
        print("build_pack: %s" % error, file=sys.stderr)
        sys.exit(1)
