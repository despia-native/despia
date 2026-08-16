#!/usr/bin/env python3
"""The lexicon view shared by ``train_lts.py`` and ``build_pack.py``.

Both tools have to agree on exactly three things: which entries the lexicon has,
what the phone alphabet is, and which words are held out.  If they disagreed, the
trees would be trained against a phone numbering the pack does not use, and the
failure would be inaudible in review and audible only to a user.  So the answer
lives in one file and both tools import it rather than each deriving its own.

Nothing here ships.  This is build-time tooling for the pack described in
``OpenSource/AI/docs/g2p-pack.md``.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# The LTS input alphabet.  A letter id is an index into this string, so the trees
# and META.letters agree by construction.
LETTERS = "abcdefghijklmnopqrstuvwxyz'"

# Stress is written before the vowel it belongs to in this alphabet.  That was
# checked against the data rather than assumed: across gold and silver every one
# of the 258,388 stress marks is followed by a vowel, none ends a string, and no
# two are adjacent.  So "mark plus following character" is a total tokenisation.
STRESS = ("ˈ", "ˌ")

# The part of speech that a pack with no tagger always resolves to.  It is id 0.
DEFAULT_POS = "DEFAULT"

# What splits words from the text between them, and what is spoken as itself.
# These live here rather than in build_pack.py because they decide the phone
# alphabet, and the phone alphabet has to be one number line for both tools.
SEPARATORS = " \t\n\r"
PUNCTUATION = ".,;:!?-"
SENTENCE_END = ".!?"

# A separator is read as a word gap, so the only separator that needs a phone of
# its own is the space; tab, newline and carriage return all spell to that phone.
PASSTHROUGH = PUNCTUATION + " "

# The share of words withheld from training and used only to report accuracy.
HOLD_OUT_PERCENT = 5

# Any string mixed into the split hash.  Changing it reshuffles the split, so it
# is a constant and not an option: a tunable split is a way to pick a flattering
# number.
SPLIT_SEED = "despia-g2p-en-us-1"


class LexiconError(RuntimeError):
    """A source file that cannot be used as it stands."""


def load_sources_manifest(work: Path) -> Dict:
    path = work / "sources.json"
    if not path.is_file():
        raise LexiconError("no sources.json in %s; run fetch_sources.py first" % work)
    return json.loads(path.read_text(encoding="utf-8"))


def load_lexicon(work: Path) -> Tuple[Dict[str, object], Dict[str, int]]:
    """Merge the gold and silver lexicons into one table.

    Gold wins.  Silver only supplies keys gold does not have, which is the same
    order misaki's own lookup chain consults them in, so a word that both know
    keeps the pronunciation the better source gave it.
    """
    gold = json.loads((work / "us_gold.json").read_text(encoding="utf-8"))
    silver = json.loads((work / "us_silver.json").read_text(encoding="utf-8"))
    merged: Dict[str, object] = {}
    stats = {"gold": 0, "silver": 0, "silver_shadowed": 0, "dropped_empty": 0}
    for key, value in gold.items():
        cleaned = clean_value(value)
        if cleaned is None:
            stats["dropped_empty"] += 1
            continue
        merged[key] = cleaned
        stats["gold"] += 1
    for key, value in silver.items():
        if key in merged:
            stats["silver_shadowed"] += 1
            continue
        cleaned = clean_value(value)
        if cleaned is None:
            stats["dropped_empty"] += 1
            continue
        merged[key] = cleaned
        stats["silver"] += 1
    return merged, stats


def clean_value(value: object) -> Optional[object]:
    """Normalise one lexicon value, or return None if it carries no pronunciation.

    misaki writes a heteronym as a map from part of speech to pronunciation, and
    uses null for a sense it declines to give.  Nulls are removed here rather than
    at pack time so that both tools see the same entry.
    """
    if isinstance(value, str):
        return value if value else None
    if isinstance(value, dict):
        kept = {k: v for k, v in value.items() if isinstance(v, str) and v}
        if DEFAULT_POS not in kept:
            return None
        if len(kept) == 1:
            return kept[DEFAULT_POS]
        return kept
    return None


def pronunciations(value: object) -> List[str]:
    if isinstance(value, str):
        return [value]
    return [value[k] for k in sorted(value)]


def default_pronunciation(value: object) -> str:
    if isinstance(value, str):
        return value
    return value[DEFAULT_POS]


def phone_characters(lexicon: Dict[str, object]) -> List[str]:
    """Every distinct character used by any pronunciation, sorted by code point.

    Sorted rather than ranked by frequency because the order is the phone
    numbering and a numbering that moves when the corpus grows is a numbering that
    silently invalidates every pack built before it.
    """
    seen = set()
    for value in lexicon.values():
        for text in pronunciations(value):
            seen.update(text)
    return sorted(seen)


def phone_alphabet(lexicon: Dict[str, object]) -> List[str]:
    """The pack's PHON section: what the lexicon uses, plus what passes through.

    Punctuation is spoken as itself in this alphabet, which means a comma has to
    have a phone id for the speller to point at.  The trees only ever emit phones
    the lexicon taught them, so the extra entries cost eight bytes each and buy a
    speller that is total over the accepted character set.
    """
    return sorted(set(phone_characters(lexicon)) | set(PASSTHROUGH))


def pos_tags(lexicon: Dict[str, object]) -> List[str]:
    """DEFAULT is id 0 by definition; the rest follow in sorted order."""
    tags = set()
    for value in lexicon.values():
        if isinstance(value, dict):
            tags.update(value)
    tags.discard(DEFAULT_POS)
    return [DEFAULT_POS] + sorted(tags)


def split_units(phones: str) -> List[str]:
    """Split a pronunciation into alignment units, a stress mark bound to its vowel.

    The trees predict stress because a stressed vowel is a distinct unit here, not
    because anything downstream re-applies it.  Stripping stress and guessing it
    back is how a letter-to-sound model learns to say every word flat.
    """
    units: List[str] = []
    index = 0
    length = len(phones)
    while index < length:
        char = phones[index]
        if char in STRESS:
            if index + 1 >= length:
                raise LexiconError("stress mark ends %r" % phones)
            units.append(phones[index:index + 2])
            index += 2
        else:
            units.append(char)
            index += 1
    return units


def is_held_out(word: str, percent: int = HOLD_OUT_PERCENT) -> bool:
    """Deterministic split, keyed on the word itself.

    A hash of the word rather than a shuffle of the list, because the list order
    depends on dict iteration and on which sources were present, and a split that
    moves with those is not reproducible.
    """
    digest = hashlib.sha256((SPLIT_SEED + "\x00" + word).encode("utf-8")).digest()
    return (int.from_bytes(digest[:4], "big") % 100) < percent


def training_words(lexicon: Dict[str, object]) -> List[Tuple[str, str]]:
    """The (word, pronunciation) pairs the letter-to-sound trees learn from.

    Filters, and why each one is here:

    - the key must be spellable in LETTERS once lower-cased, because a tree is
      indexed by letter id and there is no id for a digit or a space;
    - an all-upper-case key of two or more characters is an initialism, and its
      pronunciation is a sequence of letter names.  Training on those teaches the
      tree that ``a`` says "ay", which is true for ``AA`` and wrong for every
      ordinary word;
    - a key that differs from another only by case collapses to one word, and the
      first in sorted order wins so the choice does not depend on dict order.
    """
    allowed = set(LETTERS)
    chosen: Dict[str, str] = {}
    for key in sorted(lexicon):
        if len(key) >= 2 and key.isupper():
            continue
        word = key.lower()
        if not word or not all(c in allowed for c in word):
            continue
        if word in chosen:
            continue
        chosen[word] = default_pronunciation(lexicon[key])
    return sorted(chosen.items())


def letter_ids(word: str) -> List[int]:
    return [LETTERS.index(c) for c in word]


def format_count(number: int) -> str:
    return "{:,}".format(number)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def dump_json_bytes(payload: object, indent: Optional[int] = None) -> bytes:
    """One JSON writer for every file these tools emit, so bytes are reproducible."""
    separators = (",", ":") if indent is None else None
    text = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        indent=indent,
        separators=separators,
    )
    return text.encode("utf-8")
