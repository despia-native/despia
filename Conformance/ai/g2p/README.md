# g2p: the grapheme-to-phoneme corpus

Platform-neutral fixtures for the G2P frontend and the `.dspg` pack format
(`OpenSource/AI/docs/g2p-pack.md`). The engine carries the interpreter, the pack carries the
language, and this corpus pins the four laws the reader enforces at load plus the determinism
every other expectation rests on. Like the rest of `ai/`, these files are hand-authored from
the design and every lane runs them in VERIFY mode. Nothing here is recorded from an
implementation, which is deliberate: they describe what the frontend SHOULD do rather than what
one build happens to do.

| file | law | cases |
|---|---|---|
| `coverage.json` | L1, nothing is ever dropped | 13 |
| `provenance.json` | L2, every pronunciation says where it came from | 10 |
| `validation.json` | L3, the floor is total and the reader proves it | 24 |
| `fallback.json` | L4, refusal not removal, and the policy vocabulary | 11 |
| `determinism.json` | same input, same pack, byte-identical answer | 5 |
| `fixture-pack.json` | the declared pack every case names. No cases. | 0 |

## Why L1 exists at all

A frontend's failure mode is not a crash. It is a word that disappears.

The upstream reference implementation for this alphabet has no letter-to-sound rules, and its
fallback is a copyleft phonemizer this package cannot link. With that fallback off, an unknown
word is assigned a placeholder the model's vocabulary does not contain, the tokenizer's
normalizer strips it, and the word is deleted from the speech rather than mispronounced.
Nobody reviewing the code sees it. Only the user hears it, as a sentence missing its subject.

Measured over 550,184 tokens, that path fires on 1.0 to 2.1 % of general prose and 9.5 % of
technical text, and the residual a second permissive dictionary cannot fix is almost entirely
proper nouns and identifiers. Names are exactly what an app speaks: the user's own name, a
contact, a city, a product. A frontend that drops 1 % of tokens drops them precisely where it
hurts most.

So L1 is not a quality target, it is arithmetic, and this corpus states it twice on every case
that phonemizes. `nothingDropped.words` is the exact ordered list of the input's words and must
equal the emitted tokens' `text` fields in order. `tilesInput` is the stronger form: each token
carries the input bytes before it as `gap` and its own bytes as `text`, the answer carries
whatever followed the last token as `trailing`, and concatenating all of that must reproduce
the entire input byte for byte. A word cannot go missing from a string that reassembles.

Both hold under every policy, including the ones whose answer is a refusal, because a refusal
is still a token and a token is still coverage. There is no policy, no pack and no input under
which a word leaves the stream.

## Which runners load this corpus today

One serves it, and the ones that cannot now say so out loud instead of counting it green.

| runtime | runner | status |
|---|---|---|
| C++ frontend, directly | `engine/test/g2p_corpus.cpp` via `ClosedSource/scripts/check_g2p_corpus.rb` (per-PR) | **SERVES all 63 cases** — the only runner that reads these expect keys |
| TS binding + TS mock | `OpenSource/AI/conformance/run.ts` | SKIPS these files by `requires`, prints each skip and the case count in its summary line |
| Kotlin binding + C++ mock | `bindings/kotlin-jvm` `CorpusTest` (per-PR, android-kernel lane) | same guard, same output |
| Swift binding + C++ mock | `conformance-ai` mac lane | same guard — `corpusFiles` skips `g2p/` (fixed 2026-08-13; before that it walked these files, recognised no key, and counted all 63 as passes). Compile-pending: the change rides Codemagic |

The reason the three BINDING runners do not serve them is structural, not an oversight. A g2p
case carries no `steps` and none of the generic host's expectation keys, so a runner without the
guard constructs a host, runs zero steps, finds zero keys it recognises, and reports a pass.
`node conformance/run.ts ai` went from 99 cases to 159 the day this folder landed, and all 60 of
the new ones were hollow. That was chosen over the alternative, which was to write these cases in
the bus-call shape and turn a per-PR lane red on every unrelated PR for as long as the frontend
takes to land. It is still the weaker of two bad states, so the corpus carries its own alarm:

**Every case file declares a `requires` array naming the expectation keys a runner must
implement. A runner that does not implement every key in a file's `requires` must not count that
file as passing.** TS and Kotlin now read it: a file they cannot serve is skipped whole, named on
stdout, and counted apart from the passes, so both report `123/123 cases passed, 63 cases in 5
files SKIPPED` instead of `186/186`. Swift is the remaining hole and the table above says so.
The keys themselves are served by `g2p_corpus.cpp`, which is what turned this folder from a
specification with a machine-readable checklist into a gate.

## The case shape

```jsonc
{
  "name": "…",
  "_note": "…",                                  // why this case exists
  "pack": "fixture-en-1",                        // a pack id from fixture-pack.json …
  "pack": { "base": "fixture-en-1", "mutate": [ … ] },   // … or one plus a mutation recipe
  "phonemize": { "text": "…", "fallback": "lts" },
  "repeat": 3,                                   // determinism only
  "reload": true,                                // determinism only: unload and load between repeats
  "interleave": { "text": "…", "fallback": "…" },// determinism only: a request run and discarded between repeats
  "expect": { … }
}
```

`pack` is required. `phonemize` is optional: a case that omits it only loads the pack, which is
what most validation cases do.

A runner builds the pack's bytes, writes them somewhere, and loads them as an ordinary catalog
entry, `{ "id": "fixture-en-1", "engine": "g2p", "format": "dspg", "path": "<built file>" }`.
The `phonemize` block is the request's `options`, so the case above reaches the ABI as
`{ "schema_version": 1, "kind": "phonemize", "model": "fixture-en-1", "options": { "text": …, "fallback": … } }`,
and reaches whatever module action later exposes the frontend as that action's arguments. A
case does not have to be rewritten when the surface above it lands.

Every object comparison is a SUBSET match, exactly as in the rest of `ai/`: listed keys compare
deep-equal, unlisted keys are ignored. Lists compare positionally and the actual list may be
longer, except where a key says otherwise below.

### `expect`

| key | meaning |
|---|---|
| `nothingDropped` | **L1, and required in every case that phonemizes.** `{ words, joined }`. `words` is the exact ordered list of the input's words. The runner asserts a three-way equality: the emitted tokens' `text` fields in order equal `words`, and `words` equal the word sequence the runner derives from the case's own input `text`. `joined` is `words` joined by a single space, written out so a human can read the claim and so a fixture whose `words` drifts from its `text` is visible in review. Exact length: a shorter or longer token list fails. |
| `tilesInput` | **L1's stronger form.** Concatenating every token's `gap` then `text`, in order, then appending `trailing`, equals the request's `text` byte for byte. |
| `tokens` | ordered per-token subset assertions. Token fields on the wire: `gap`, `text`, `via`, `phonemes`, `gap_phonemes`, `sentence`, plus `pos_default` and `unaccepted` when they are true. Fixture-only companions: `phonemesNonEmpty`. |
| `tokenCount` | exact number of tokens. Every token is a word; punctuation and whitespace ride in `gap` and `trailing`. |
| `trailing` | the input bytes after the last token, exactly. |
| `everyTokenHasVia` | every token carries a `via`, including tokens the fixture did not name. A per-token assertion cannot say this. |
| `viaVocabulary` | every emitted `via` is a member of the listed set. The set is closed and an unlisted value fails. |
| `coverage` | the answer's own per-provenance counts plus `total` and `guessed`, where `guessed` counts `lts`, `spelled` and `refused` and nothing else. L1 and L2 as one number a surface can act on. |
| `blocks` | the answer's sentence blocks in order: `{ sentence, text, deferred? }`. |
| `deferred` | the sentences the answer marked for another synthesizer, in order: `{ sentence, text }`. Exact list: an unlisted deferral fails. |
| `loaded` | whether the pack loaded. |
| `loadError` | the typed refusal a malformed pack produces: `{ code, packCode, messageContains }`. `code` is the ABI's (`load_failed`); `packCode` is the pack reader's own reason, which rides as the message prefix before the first colon; `messageContains` is a short identifying fragment of the rest. |
| `requestError` | a refusal of the REQUEST rather than the pack: `{ code, messageContains }`. This is where `fallback: "drop"` lands. |
| `byteIdentical` | across `repeat` runs, the whole answer serialized canonically is byte-equal: every block in order with its text, phonemes and deferral flag, every token in order with every field, and the trailing text. Comparing only phonemes would pass a build whose `via` flickered. |

## Phonemes, and why some of them are not written down

**No expectation in this corpus contains an invented pronunciation.** A wrong expectation
pinned into a gate is worse than no gate, because it is believed.

The fixture pack's phone alphabet is `p0` through `p9` plus `pA` and `pB`, not IPA, so nothing
here can be mistaken for a pronunciation reference. The wire renders a pronunciation by
concatenating phone names with no separator, so the two-character width keeps every expected
string unambiguous.

Where a case's phonemes follow from bytes the pack itself declares, the fixture states them and
the assertion is exact. That covers every `lexicon` hit, the DEFAULT sense of the heteronym,
every `spelled` answer (the SPEL rows for the folded characters, joined by the pack's row for
SPACE), and every `stem` derivation (the base entry's phones plus the allomorph the rule picks
for that stem's last phone).

Where the answer is a walk through the fixture's own LTS trees, the fixture writes
`"phonemes": "record"` and asserts structure instead:

- `"phonemes": "record"` means the value is unpinned and will be filled by a record lane later,
  the same way `jse/` takes its `expected` from the Swift kernel rather than from a keyboard. A
  runner must assert only that the field is present.
- `"phonemesNonEmpty": true` beside it asserts the string is not empty, which is the part that
  matters for L1: a guess that produces nothing is a deletion wearing a `via`.

Predicting a decision-tree traversal by hand in a fixture is exactly how a wrong expectation
gets pinned into a gate. When a record lane exists it replaces `"record"` with the real string
and the case gets stricter without changing shape.

## The fixture pack, and the mutation recipe

`fixture-pack.json` declares one pack, `fixture-en-1`, as a DESCRIPTION of bytes rather than
bytes. A runner builds a real `.dspg` from the declaration using the layout in g2p-pack.md,
applies the case's mutations, and hands the result to the reader. So the corpus ships no
binary, every case stays diffable, and a malformed pack reads as one line of English instead of
a hex blob.

The mutation vocabulary is four verbs and each case uses exactly one, so a failure names the
check that fired rather than a soup of them. The single two-mutation case says so in its note.

| verb | shape | when it applies |
|---|---|---|
| `set` | `{ "set": "<path>", "to": <value> }` | edits the DECLARATION before the bytes are built |
| `remove` | `{ "remove": "<path>" }` | edits the DECLARATION before the bytes are built |
| `sectionLength` | `{ "sectionLength": "<TAG>", "delta": <int> }` | edits the BUILT bytes: adds a signed delta to one section-table row's `length` and leaves the section data alone |
| `addSection` | `{ "addSection": "<TAG>", "bytes": <int> }` | edits the BUILT bytes: appends a row plus that many zero bytes of body, and bumps `section_count` |

A path is a dotted string into the pack declaration, for example `meta.phone_count`,
`lts.nodes.3.yes`, `spel.-`, `lexicon.read.senses.0`. A segment that itself contains a dot is
written as an array of segments instead. No case in the corpus needs that today.

## Adding a case

1. Put it in the file that owns its law. A case that does not obviously belong to one of the
   five is usually two cases.
2. Give it a `name` that states the claim as a sentence, and a `_note` that says what breaks
   without it. A note that restates the name is not a note.
3. If it phonemizes, it carries `nothingDropped` and `tilesInput`. This is not a style
   preference: L1 says the check runs for every case in the corpus, so a case that skips it is a
   hole in L1.
4. Use the fixture pack. If it needs a word the pack does not carry, add the word to
   `fixture-pack.json` rather than declaring a second pack, and check that the addition does not
   change an existing case. Adding a plural as its own entry, for instance, moves a token from
   `stem` to `lexicon`.
5. Do not invent phonemes. Derive them from the pack, or write `"record"`.
6. If it needs an expectation key that does not exist yet, add the key to the file's `requires`
   array in the same commit, and to the table above.

## What this corpus found that the contract does not say

Three places where the spec and the wire disagree, recorded here rather than resolved by a
fixture, because a corpus is the wrong place to decide a contract.

- **`via` has seven values, not six.** g2p-pack.md's L2 paragraph names `lexicon`, `pos`,
  `stem`, `lts`, `spelled` and `refused`. The engine also emits `number`, for a numeral expanded
  through the pack's NORM data and then looked up. `provenance.json` pins the seven and says so;
  L2 needs the row.
- **An omitted `fallback` is `lts`.** L4 lists the four policy words without saying which one a
  request that names none gets. The engine defaults to `lts`. `fallback.json` pins it, because a
  default that lives only in one implementation's initializer is a default the other two get to
  disagree about, and L4 needs the sentence.
- **A load refusal carries no typed reason.** A malformed pack arrives as `load_failed` with the
  reader's reason in the message text, so `validation.json` matches a substring. That is the
  weakest assertion in this corpus and it is weak for a contract reason rather than a fixture
  one. A typed `reason` field on the error would let these 19 expectations name a value instead
  of a fragment, and it is the one contract change this corpus recommends.

## What is deliberately not here

- **Real-pack accuracy.** How often the trained trees guess a proper noun correctly is measured
  on a held-out split by the offline trainer and recorded in the shipped pack's own META. It is
  not a fixture question, the same way real-model inference lives in the nightly smoke lane
  rather than in `ai/`.
- **The licence gate.** A pack built from data whose licence is not recorded fails
  `ai_package_gate.rb`, which is a build-side check reading `META.sources`. It is not a reader
  behaviour and it is not asserted here.
- **A notice for an ignored section.** The must-ignore case asserts that an unknown tag loads
  and that the pack still works. It does not assert a typed notice recording the skip, because
  the reader emits none. The modality corpus pairs must-ignore with an audible half
  (`unknown_block_ignored`) and this reader should grow the same thing, at which point the
  assertion belongs in `validation.json`.

## Authoring rules

Cases are byte-stable: no clocks, no randomness, no ordering that depends on scheduling. One
space of indent per level, matching the sibling corpora. Raw UTF-8, and the non-ASCII inputs are
load-bearing (an emoji, Cyrillic, a diaeresis, an acute, a curly apostrophe, a double dagger),
so an editor that normalizes them is breaking cases rather than tidying them.
