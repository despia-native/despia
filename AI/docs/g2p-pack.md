# The G2P pack

Text has to become phonemes before a neural voice can say it. That step is a **grapheme-to-phoneme
frontend**, and in Despia AI it is an ordinary backend reading an ordinary model file. The engine
carries the interpreter. The **pack** carries the language.

That split is the whole design. `despia_ai_capabilities()` reports `phonemize` as a modality the
same way it reports `completion`, a pack loads through `despia_ai_load_model` like any other model,
and nothing in `engine/` names English, an alphabet, or a dictionary. A pack for another language
is a file, not a release.

## The law this exists to enforce

A frontend's failure mode is not a crash. It is a word that disappears.

The upstream reference implementation for this alphabet has no letter-to-sound rules; its fallback
is a copyleft phonemizer this package cannot link. With that fallback off, an unknown word is
assigned a placeholder that the model's vocabulary does not contain, the tokenizer's normalizer
strips it, and **the word is deleted from the speech** rather than mispronounced. Nobody reviewing
the code sees it. Only the user hears it, as a sentence that is missing its subject.

So the pack format is built around four rules, and the reader enforces all four at load:

**L1 - nothing is ever dropped.** Every word of the input appears in the output, with a
pronunciation or with a typed refusal. There is no code path that removes a word and returns
success. The conformance corpus checks this mechanically: the emitted token texts, concatenated,
must reproduce the input's word sequence for every case in the corpus and for every string the
fuzzer invents.

**L2 - every pronunciation says where it came from.** Each token carries `via`, and the vocabulary
is exactly these seven: `lexicon`, `pos` (a heteronym resolved by part of speech), `stem` (a
morphological derivation), `number` (expanded to words by the pack's `NORM` data, then looked up),
`lts` (guessed by the letter-to-sound rules), `spelled` (read out one character at a time), and
`refused`. A caller that wants to show a confidence, log a miss, or route a sentence elsewhere has
the fact rather than a guess. `Conformance/ai/g2p/provenance.json` pins the vocabulary itself, not
just the values in its cases, so a build that grows an eighth without the corpus knowing fails.

**L3 - the floor is total, and the reader proves it.** A pack declares the character set it
accepts and a speller that names every character in it, with **phones**. An empty row is not a
spelling: the reader fails the load unless the code point is listed in `META.silent`, which is how a
pack says a silence is deliberate. A pack that could go quiet without having said so cannot be
loaded, so the silent path does not exist at runtime - it is a load error at build time.

That second sentence is the law's second draft. The first only asked whether a row **existed**, and
the first real pack shipped nine code points - `"` `'` `(` `)` `[` `]` `` ` `` `{` `}` - accepted
with empty rows. It satisfied the letter of the law and produced 2,697 silent tokens across 93,898
tokens of real text. Every one of those silences was a reasonable decision by the pack's author and
none of them was written down anywhere a reviewer or a validator could see. The distinction between
a decision and an oversight is the entire value of the check, so the format now makes the pack state
which it is.

**L4 - what the pack cannot pronounce is reported, never removed.** A character outside the
accepted set survives folding as an explicit `refused` token carrying the offending text. The
`fallback` policy then decides what the caller does about it - and the vocabulary of that policy is
`lts`, `spell`, `refuse`, and `defer`. There is deliberately no `drop`. **An omitted `fallback` is
`lts`**, stated here because a default that lives only in one implementation's constructor is a
default the other implementations get to disagree about.

`defer` is the option this framework has and an upstream G2P project does not: a complete platform
synthesizer sits next to the neural one, with full language coverage and no download. A sentence the
pack cannot prove can be handed to it whole. The handoff is at sentence granularity because
switching voices mid-clause sounds worse than either voice alone.

## What a caller gets back

`phonemize` is a request kind on the ordinary `despia_ai_request` path, so the answer arrives as
blocks and a `complete`, exactly like a completion does.

```json
{ "kind": "phonemize", "model": "en-us", "options": { "text": "…", "fallback": "lts" } }
```

One block per sentence, emitted as each is ready, so a caller can start synthesizing the first
sentence while the rest is still being read. A block carries the sentence's `text`, its `phonemes`,
its `tokens`, and `deferred` when the `defer` policy decided this sentence should go to another
synthesizer. Text after the last word - the full stop that closed the utterance - arrives as one
final block with no tokens, because a full stop is a pause the acoustic model knows and dropping it
would lose a beat.

Two conservation laws hold over that envelope, and both are checked in `g2p_test.cpp`:

- **The tokens tile the input.** `gap + text` for every token, in order, then the response's
  `trailing`, equals the request's `text` byte for byte. This is L1 made mechanical.
- **The blocks tile the phonemes.** Concatenating every block's `phonemes`, in order, gives the
  whole utterance. Nothing is produced and then dropped between the pipeline and the wire.

`complete` carries a `coverage` object counting each `via` plus `guessed`, which is how many words
the pack could not prove. One number tells a surface whether to warn, log, or route elsewhere.

## The file

`.dspg`, little-endian, designed to be read in place rather than parsed into a heap of objects.

```
offset  size          field
0       4             magic "DSPG"
4       4             format_version  u32, 1 today
8       4             section_count   u32
12      4             reserved        u32, must be 0
16      16 × count    section table
```

Each section-table row is `{ char tag[4]; u32 reserved; u32 offset; u32 length }`. The reader
rejects a row whose extent leaves the file or overlaps the header, and rejects a duplicate tag.
Unknown tags are **ignored**, which is the same must-ignore rule the JSON envelopes carry: a v1
reader loads a pack that grew a section it has never heard of.

| tag | contents |
|---|---|
| `META` | UTF-8 JSON, the pack's self-description. Required. |
| `PHON` | the phone alphabet, one phone per line, `\n`-separated. Phone id is the line index. Required. |
| `LEXK` | the lexicon's key blob: sorted keys, concatenated, no separators. |
| `LEXI` | the index: `u32 count`, then `count × { u32 key_off; u32 key_len; u32 val_off }`. |
| `LEXV` | the value blob. |
| `LTS ` | the letter-to-sound trees. Note the trailing space; tags are always four bytes. |
| `SPEL` | the speller: how each accepted character is read aloud. Required. |
| `NORM` | number, ordinal and currency words. Optional; without it those expansions are absent, not wrong. |

### `META`

```json
{ "schema_version": 1,
  "id": "en-us-1", "name": "English (United States)",
  "languages": ["en", "en-US"],
  "letters": "abcdefghijklmnopqrstuvwxyz'",
  "accept": "abcdefghijklmnopqrstuvwxyz'0123456789 .,;:!?-",
  "separators": " \t\n\r",
  "punctuation": ".,;:!?-",
  "sentence_end": ".!?",
  "silent": "\"'()[]`{}",
  "fold": { "é": "e", "’": "'" },
  "phone_count": 46,
  "pos_tags": ["DEFAULT", "NOUN", "VERB", "ADJ", "VBD"],
  "morphology": [ … ],
  "sources": [ { "name": "…", "spdx": "Apache-2.0", "url": "…", "sha256": "…" } ],
  "notice": "…" }
```

`letters` is the LTS input alphabet - a letter id is an index into it, so the trees and the string
agree by construction. `accept` is the set L3 is proven against and L4 is judged against; it is a
superset of `letters`, of `separators` and of `punctuation`, and the reader checks that. `fold` runs
before anything else and is how `café` becomes a word the lexicon can be asked about; its keys are
single code points, because a multi-code-point key would need longest-match scanning and that is a
different format rather than different data. `sources` is not decoration: `build_pack.py` refuses to
write a pack whose sources lack an SPDX identifier and a digest, so an unattributed pack cannot be
produced. The repository gate checks the builder's declared sources against `NOTICE`, because the
pack is a build artifact and is not in the tree to be read.

`separators` splits words from the text between them, `punctuation` is spoken as itself (this
alphabet has code points for it, and a comma is a pause the acoustic model already knows), and
`sentence_end` is what closes a sentence - which matters only because the `defer` policy hands work
to another synthesizer a whole sentence at a time.

### `morphology`

The rung of the ladder that derives `walked` from `walk`. It is pack data for the same reason
everything else is: the engine must not know that English forms a past tense with `-ed`, still less
which allomorph follows a voiceless stop.

```json
"morphology": [
  { "suffix": "ed", "restore": ["", "e"], "undouble": true,
    "variants": [ { "after": ["t", "d"], "phones": "ᵻd" },
                  { "after": ["p", "k", "f", "θ", "s", "ʃ", "ʧ"], "phones": "t" },
                  { "phones": "d" } ] }
]
```

The engine strips `suffix`, then tries the bare stem and each `restore` candidate appended to it, and
`undouble` additionally tries dropping a final doubled consonant so `running` can reach `run`. The
first candidate the lexicon knows wins. `after` matches the **last phone of the stem's
pronunciation** against phones from the pack's own `PHON` alphabet; the variant with no `after` is
the default and must come last. A pack that ships no `morphology` simply does not have this rung, and
its derived forms fall through to the letter-to-sound trees instead - an absence, not an error.

`phone_count` must equal the `PHON` line count and must be ≤ 255, because a phone id is one byte in
`LEXV`, `SPEL` and the LTS output blob. A pack that needs more is a `format_version` 2, not a
silently truncated v1 - the reader refuses rather than reading a wrong byte.

### `LEXV`

Each value starts with a `u8` form.

- **form 0** - one pronunciation: `u8 len`, then `len` phone ids.
- **form 1** - a heteronym, conditioned on part of speech: `u8 n`, then `n × { u8 pos; u8 len; len phone ids }`. `pos` 0 is `DEFAULT` and must be present. The remaining ids are indices into the `pos_tags` array in `META`.

Form 1 exists because 790 of the shipped lexicon's entries are POS-conditioned, and `read`,
`record`, `lead`, `live`, `bass`, `wind` and `tear` are wrong in one sense or the other every time a
frontend ignores it. Despia AI ships **no part-of-speech tagger**, so today every form-1 entry
resolves to `DEFAULT` and the token is marked `via: "pos"` with `"default": true`. That is a stated
limit, visible per token, rather than a silent coin flip. A tagger is a pack-side addition when one
exists; the format is already waiting for it.

### `LTS `

```
u32 window          the context radius, so a question sees 2 × window + 1 letters
u32 letter_count    equal to META.letters length
u32 roots[letter_count]
u32 node_count
LtsNode nodes[node_count]
u32 out_len
u8  out[out_len]    phone ids, referenced by leaves
```

**A pack holds at most 65,536 LTS nodes**, and that ceiling is structural rather than a tuning
knob: `yes` and `no` are `u16`, and the reader requires every child index to be strictly greater
than its parent's, so both live in one number space. Measured on the first real English pack, the
budget is not binding and is arguably doing work - pruning 139,345 grown nodes down to 65,535 scored
*better* on held-out words than shipping all of them, so the cap is acting as regularisation. At
32,767 it costs 1.7 points of word accuracy and at 16,383 it costs 4.5.

`LtsNode` is 8 bytes and is one of two shapes, discriminated by its first byte:

```
branch  u8 kind = 0; u8 pos; u8 chr; u8 reserved; u16 yes; u16 no
leaf    u8 kind = 1; u8 len; u16 reserved;        u32 out_off
```

A branch asks "is the letter at context position `pos` the one with id `chr`?" and takes `yes` or
`no`. `pos` runs `0 … 2 × window`, with `window` itself being the letter being pronounced. Out of
range positions - the ends of a word - answer with the padding id, which is `letter_count`, one past
the last real letter. A leaf names a slice of `out`, which may be **zero phones long**: silent
letters are real, and a leaf that emits nothing for the `e` of `make` is correct rather than a
dropped output. L1 is a rule about words, not about letters.

The reader validates every node before the first lookup: `pos` in range, `chr` in range, child
indices in range and **strictly greater than the node's own index**. That last one is what makes a
malformed pack a load error instead of an infinite walk on some device at 3am.

### `SPEL`

`u32 count`, then `count × { u32 codepoint; u8 len; len phone ids }`, sorted by code point. This is
how `x` in a word nothing knows becomes "eks" rather than nothing at all. L3 is checked here: every
code point in `META.accept` must appear **with at least one phone**, unless it is listed in
`META.silent`. A row with `len` 0 for an undeclared code point fails the load, because that is
exactly what going quiet looks like from the inside.

`META.silent` is for characters that genuinely have no sound - brackets, quotes, a zero-width
joiner. Every code point in it must also be in `accept`: declaring a character silent says how to
handle it, not whether to allow it. A token made entirely of silent characters produces no phones
and is reported `refused`, which is honest - `(` on its own has nothing to say.

The entries are built by looking the character's spoken name up in the lexicon the same pack carries,
never by writing IPA into a table. English letter names are already in that lexicon under the
upper-case single-character keys, so `w` is `lexicon["W"]` - `dˈʌbᵊlju` - and the builder does not
have to know that `w` is called "double you". There are five classes and the class decides the
entry: a **letter** is its name, a **digit** is its number word, a character in `punctuation` is
**spoken as itself** so its entry is the phone id of that same character, a character in
`separators` is a word gap so its entry is the space phone, and a character in `silent` gets an
entry of zero phones - legal only because `META.silent` declares it. L3 is about the entry saying
something, or the pack saying why it does not.

**A silent character that is not one of the pack's `letters` is also a word boundary**, derived by
the reader rather than restated by the pack: a character with no sound and no place in the alphabet
the trees were trained on cannot be inside a word. The letter exception is load bearing. English
declares the apostrophe silent *and* lists it in `letters`, which is right - it carries no sound of
its own but belongs inside "don't", and treating it as a boundary would split every contraction in
the language.

### `NORM`

UTF-8 JSON, and every value in it is a **grapheme string, never phones**. Expansion produces words,
those words go back through the lexicon ladder, and number words therefore get their pronunciation
from exactly where every other word gets it. A pack that wrote IPA here would have a second, silently
diverging copy of the lexicon inside itself.

```json
{ "units":    ["zero","one","two","three","four","five","six","seven","eight","nine"],
  "teens":    ["ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"],
  "tens":     ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"],
  "scales":   ["","thousand","million","billion","trillion","quadrillion"],
  "hundred":  "hundred",
  "negative": "minus",
  "point":    "point",
  "joiner":   "",
  "ordinals": { "1":"first", "2":"second", "3":"third", "5":"fifth", "8":"eighth", "9":"ninth",
                "12":"twelfth", "20":"twentieth", "30":"thirtieth", "40":"fortieth",
                "50":"fiftieth", "60":"sixtieth", "70":"seventieth", "80":"eightieth",
                "90":"ninetieth", "suffix":"th" },
  "currency": { "$": { "unit":["dollar","dollars"], "sub":["cent","cents"] },
                "£": { "unit":["pound","pounds"],   "sub":["penny","pence"] },
                "€": { "unit":["euro","euros"],     "sub":["cent","cents"] } } }
```

`tens` is indexed by the tens **digit**, so slots 0 and 1 are deliberately empty and are never read.
`scales` is indexed by the group of three counted from the right, so slot 0 is empty for the same
reason. `joiner` is the British "one hundred **and** five"; en-US ships it as `""` and the field is
always present rather than sometimes absent, because an absent field is a second code path.

`ordinals` lists only the **irregular** forms. Anything not listed takes the regular form: the
cardinal word with `suffix` appended, and a tens word ending in `y` first loses the `y` and gains
`ie`. That rule lives in the reader; the data says nothing about it beyond the table above.

Currency `unit` and `sub` are `[singular, plural]`. The symbols are keys, so a pack for another
currency is a different table and not a different reader.

The builder proves every word in this section is sayable before it writes the file: each one must be
in `LEXK`, or reachable from it through a `META.morphology` rule. `euros` is the case that makes the
check worth having - it is not in the lexicon, and it is only correct because the `-s` rung derives
it from `euro`.

## When a pack is refused

A load failure is a string of the form `<code>: <detail>`, and a consumer splits it at the FIRST
colon, which is unambiguous even when a detail contains one. The codes are a closed set:

| code | meaning |
|---|---|
| `pack_unreadable` | the file could not be opened |
| `pack_too_large` | over 64 MiB, which is a mistake or an attack rather than a pack |
| `pack_malformed` | a structural defect: a bad section extent, a duplicate tag, an unsorted lexicon, a tree that could walk forever, a phone id past `PHON` |
| `pack_version_unsupported` | a `format_version` or a `META.schema_version` this build does not read |
| `pack_floor_incomplete` | L3: `accept` holds a character `SPEL` cannot read aloud |

`pack_floor_incomplete` is deliberately its own code rather than a flavour of `pack_malformed`. The
pack is structurally fine; what is wrong is that it could go quiet, and that deserves to be
distinguishable by a consumer without reading English.

## Building one

`tools/g2p/build_pack.py` produces a pack from permissive source dictionaries, and
`tools/g2p/train_lts.py` learns the trees from those same dictionaries. Both are offline tools;
neither ships. The pack that ships is a build artifact with a recorded digest, exactly like a model.

The letter-to-sound rules are **trained on the lexicon the pack itself carries**, which is why the
tree outputs are already in the pack's own alphabet and there is no phone-set mapping anywhere. A
mapping table between two phone sets is where a hand-ported frontend goes subtly wrong, and this
design does not have one to get wrong.

Accuracy is measured on a held-out split by `train_lts.py` and recorded in the pack's `META`, so
`phonemize` can report what its guesses are worth instead of implying they are certain.

For the first English pack that is **0.897 phone accuracy and 0.503 whole-word accuracy** over
8,773 held-out words, or 0.946 and 0.641 when stress is ignored - stress alone is 28% of the
word-level errors. Two caveats belong next to those numbers rather than in a footnote. The headline
is flattered by the more regular of the two lexicon tiers: on the gold tier alone whole-word
accuracy is **0.392**. And the held-out split is a random slice of the lexicon, which is a *different
and easier* distribution than the one the trees actually meet, because at runtime they only fire for
words the lexicon does not have - and that residual is almost entirely proper nouns. The figure is
the best available estimate of tree quality. It is not a measurement of the population the trees
will see.

<!-- pack-digest --> `en-us-1.dspg` - 6314213 bytes, sha256 `b83e9f4ec1bce45921fc58fe07ce248683378eda4b131be3670fb79548d95bbe`
