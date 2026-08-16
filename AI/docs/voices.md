# Voices

Outbound speech in Despia AI has **two tiers**, and the choice between them is data, not code.
This page is the record of what each tier costs, what it is licensed under, and - for the tier
that is not carried yet - the exact pinned declarations that turn it on. Every number below was
**measured on the real artifact**, not estimated; the commands are given so any of them can be
reproduced.

The design decision behind the split is D2/D7 in
[`local-ai-engine.md`](../../Documentation/architecture/proposals/local-ai-engine.md) §10. The
module that implements it is `ClosedSource/DSX/Modules/Core/LocalAI/Modules/Voice`
(`despia.intelligence.voice`).

## The registry - why there are tiers at all

A voice provider registers with the module the same way an inference backend registers with the
engine (`engine/src/backend.hpp`): an id, an availability manifest, and a `synthesize` entry
point. Nothing in the module names a voice family, a model format or a synthesis technique. An
app selects a provider by id - `options.provider` on a call, else the module's `voice_provider`
config, else the first available provider in registration order.

A named provider that this build does not carry is an **error**, never a silent downgrade. An app
that asked for a specific tier and got a different voice would have a bug that only shows up in
the user's ears.

| tier | id | carried today | binary cost | licence exposure |
|---|---|---|---|---|
| the device's own synthesizer | `platform` | **yes - the default** | **0 bytes** | none (system framework) |
| a neural voice pack through ONNX Runtime | `neural` | no - registered and inert | ~10 MiB runtime + the pack | permissive throughout (below) |

## Tier 1 - the platform synthesizer (the default)

`AVSpeechSynthesizer` on Apple, `android.speech.tts.TextToSpeech` on Android. Zero binary bytes,
zero licence exposure, every language the OS ships, and it works on a device that has downloaded
nothing. It is the same law `system-defaults.md` applies to UI - the unstyled baseline **is** the
platform.

It is a complete implementation, not a placeholder: `voices` returns the real voices installed on
the device (with the OS's own quality and gender metadata), `speak` plays natively with progress
and barge-in, and `synthesize` streams chunk references as they are produced.

**Streaming differs by lane, and that is deliberate.** Apple's synthesizer hands over PCM buffers
as it produces them, so the iOS provider chunks at the buffer boundary and closes each chunk as a
self-contained WAV. Android's engine has no buffer sink that is safe to rely on across OEM
engines, so the Android provider chunks at **sentence-sized segments**, each synthesized as its
own utterance. Both satisfy the same contract - audio starts before the whole utterance is
synthesized - and the segment boundaries are prosodically better at the cost of granularity.

Audio never rides JSON in either lane. A chunk is written to a per-utterance cache directory,
published into the app's own loopback store when it carries one, and the bus carries the
reference. This is the `noInlineBytes` law of
[`Conformance/ai/modality/modality.json`](../../Conformance/ai/modality/modality.json).

## Tier 2 - a neural voice pack through ONNX Runtime

### The copyleft audit, and what it actually decided

The obvious route to neural TTS is sherpa-onnx, and it does not work for a package whose promise
is unrestricted commercial use under Apache-2.0. Read from `k2-fsa/sherpa-onnx@master`:

- `CMakeLists.txt` - `if(SHERPA_ONNX_ENABLE_TTS)` unconditionally does
  `include(espeak-ng-for-piper)` and `include(piper-phonemize)`, and `sherpa-onnx/csrc/CMakeLists.txt`
  links `piper_phonemize` into `sherpa-onnx-core`. There is **no build option** that keeps TTS and
  drops espeak-ng (**GPL-3.0**).
- The "use a lexicon instead" route is not an escape: `csrc/kokoro-multi-lang-lexicon.cc` includes
  `espeak-ng/speak_lib.h` and falls back to espeak for out-of-vocabulary words.

**The conclusion was to drop that dependency, not to settle for worse voices.** The copyleft was
never in the acoustic model - it was in one project's build graph, and the phonemizer is
separable from the synthesizer. Every other piece of a neural speech stack is permissive:

| piece | licence | note |
|---|---|---|
| acoustic weights (82M-parameter TTS model) | Apache-2.0 | |
| the community ONNX export (`onnx-community/Kokoro-82M-v1.0-ONNX`) | Apache-2.0 | verified from the Hub model card: `license: apache-2.0` |
| ONNX Runtime | MIT | verified from the published podspec: `{"type": "MIT"}` |
| the grapheme-to-phoneme frontend (misaki) | Apache-2.0 | code **and** its English lexicons; the copyleft phonemizer is a separable, optional fallback - but see "what turning it off actually costs" below |
| the CMU Pronouncing Dictionary | BSD-2-clause | an optional second lexicon tier, read below |
| Flite (incl. its letter-to-sound engine) | BSD-like (CMU) | its `COPYING` states GPL appears only in the build process and "does not taint any of the run-time code" |

**espeak-ng and sherpa-onnx TTS are both REJECTED**, recorded here so neither is reintroduced by
someone who only reads the voice list. `check_dependency_licenses.rb --public-release` enforces
it: LGPL counts as copyleft in this repo because static linking defeats the dynamic-linking
escape, so the gate catches a reintroduction rather than trusting a habit.

### What is missing, precisely

The licence problem is solved. What is not carried is engineering, and it is three things:

1. **the inference runtime** - an ONNX Runtime dependency (`pods` on Apple, `gradle.dependencies`
   on Android);
2. **the G2P pack** - the data the frontend reads. The frontend itself is now carried by the
   engine; what is missing is a download, not engineering. The audit below is why that took the
   longest, and [`g2p-pack.md`](g2p-pack.md) is what was built;
3. **the voice packs** - hash-pinned `weights` rows.

Those three are the `needs` list the `neural` provider reports at runtime, so a surface can tell
a user what is missing rather than failing blankly.

### The model contract - what the acoustic model actually consumes

Read out of the real 86 MB `model_q8f16.onnx` by parsing its protobuf graph, not assumed:

```
INPUTS   input_ids : int64[1, sequence_length]
         style     : float[1, 256]
         speed     : float[1]
OUTPUT   waveform  : float[1, num_samples]
```

`tokenizer.json` in the same repo defines `input_ids`. Three properties of it decide the whole
design, and each is easy to get wrong from memory:

- It is **character-level, not phoneme-level**. Each id is one character of an IPA-ish alphabet.
  There is no phoneme-string vocabulary and therefore no phoneme-set mapping table to mismatch.
- The id space is **sparse**: 178 entries with holes (`;`=1 … `-`=9, then `A`=24, `I`=25, `O`=31 …).
  Ids must come from the published table, never from an enumeration order.
- `$` is id 0 and is **both** BOS and EOS - the post-processor wraps every sequence `$ … $`.
  The alphabet is IPA plus single-character shorthands (`A I O Q S T W Y ᵊ ᵻ ʣ ʥ ʦ ʨ ᵝ ꭧ`) and
  tone arrows (`↓ → ↗ ↘`).

**A voice pack is not a vector - it is a table.** Each `voices/<name>.bin` is 522,240 B, which is
exactly `510 × 256` float32. The `style` input is selected by **token count**, one row per length,
and that is also where the 510-token cap comes from (512 minus the two `$`). An implementation
that loads the file as a single 256-float vector will run, and will sound wrong.

### The G2P audit - what turning the copyleft fallback off actually costs

This is the part that decides whether tier 2 can ship, so it was measured rather than reasoned
about. Everything below comes from the real published wheel `misaki-0.9.4-py3-none-any.whl`
(sha256 `90e2eeb169786c014c429e5058d2ea6bcd02d651f2a24450ba6c9ffc0f8da15a`).

**The good news is better than expected.** The lexicons are bundled in the wheel itself, they are
large, and their values are **already written in the model's own token alphabet** - `hello` is
stored as `həlˈO`, not as ARPABET or as some other IPA convention needing transcoding:

| file | bytes | entries | minified + deflate-9 |
|---|---|---|---|
| `us_gold.json` | 3,000,469 | 90,201 | 719,062 |
| `us_silver.json` | 3,099,517 | 93,361 | 682,418 |
| `gb_gold.json` | 2,838,552 | 87,352 | 696,094 |
| `gb_silver.json` | 3,663,898 | 109,766 | 799,468 |

So a US English lexicon costs **1,401,480 B compressed (1.34 MiB)** - negligible beside the
10 MiB runtime and the 57 MB model. Licence: the distribution carries exactly one licence file,
Apache-2.0, with **no NOTICE and no separate data licence**, and its English acknowledgements
credit no external dictionary. The lexicon is as permissive as the code that reads it. This
matters because dictionaries are often licensed apart from their wrappers - here they are not.

The lookup chain is a real linguistic frontend, not a table: context-sensitive special cases
(`a`, `the`, `to`, `in`, `am`, `an`, `I`, `by`, `used`, symbols, dotted initialisms) → gold →
silver → morphological stemming for `-s`/`-ed`/`-ing` with correct voicing assimilation and US
flapping → number and currency expansion. Heteronyms are POS-conditioned entries:
`read` is `{"ADJ":"ɹˈɛd","DEFAULT":"ɹˈid","VBD":"ɹˈɛd", …}`.

**The bad news, and it is the whole problem.** There is **no letter-to-sound rule system in
misaki**. The copyleft phonemizer *is* the fallback. Three independent confirmations: the `[en]`
extra's own dependency list pulls the espeak loader and a phonemizer fork; the fallback class is
commented "used as a last resort for English"; and misaki's own TODO still carries the open item
"train seq2seq fallback models on dictionaries". With the fallback off, an unknown word is
assigned the placeholder `❓` - and `❓` is not in the model's vocabulary, so the tokenizer's
normalizer strips it. **The word is not mispronounced. It is silently deleted from the speech.**

That failure mode is worse than mispronunciation, and it is why "the fallback is optional and
documented disabled" is true but dangerously incomplete as a summary.

**How often it fires**, measured over 550,184 word tokens - three public-domain books plus this
repository's own documentation - against a faithful port of the lookup chain above:

| corpus | tokens | lexicon only | + CMU Pronouncing Dictionary |
|---|---|---|---|
| general prose (three books) | 458,956 | 0.98 % - 2.13 % | 0.40 % - 1.12 % |
| technical/product documentation | 91,228 | 9.54 % | 8.06 % |
| **all** | **550,184** | **3.01 %** | **1.96 %** |

Adding the CMU dictionary (BSD-2-clause, 126,052 distinct entries, 77,064 of them absent from
misaki) roughly halves the miss rate on prose. But the composition of what remains is the point,
and it does not improve: after both dictionaries, the residual is **almost entirely proper nouns
and identifiers**. In the literary corpora the survivors are invented names; in the technical
corpus they are product and API names. Common vocabulary is essentially solved at ~99 %; **names
are not, and names are exactly what an app speaks** - the user's own name, a contact, a city, a
product. A frontend that drops 1 % of tokens drops them precisely where it hurts most.

Two further gaps, for completeness. **Heteronyms need a part-of-speech tagger** - misaki uses a
full NLP pipeline for this, and 790 of the 90,201 `us_gold` entries are POS-conditioned. Without
a tagger they all take `DEFAULT`, so `read`, `record`, `lead`, `live`, `bass`, `wind` and `tear`
are wrong whenever the non-default sense is meant. And **number and currency expansion** is a
substantial surface of its own (ordinals, years, decimals, currency).

### The three options, and which one was built

**Option A - port the lexicon and rules, no fallback.** ~99 % token coverage on prose, ~92 % on
technical text, and every uncovered word silently deleted. **Rejected.** This is the "90 % right is
100 % wrong" shape the program already named.

**Option B - Option A plus a letter-to-sound fallback.** Permissive ones exist: Flite's engine and
its CMU lexicon are BSD-like C whose `COPYING` states plainly that GPL code appears only in the
build process and never in the runtime. Its honest cost is that its output is in a different phone
set and needs a mapping, it is US English only, and letter-to-sound accuracy on unseen **proper
nouns** is the weakest class for any such model.

**Option C - route what the lexicon cannot prove to tier 1.** This framework has something no
upstream G2P project has: a complete, shipping platform synthesizer sitting next to the neural one,
with full language coverage and no download. The unknown-word case can be a typed, declared handoff
rather than a guess or a deletion.

**What was built is B and C together, in the engine rather than in this module**, and the mapping
problem in B was designed out rather than solved: the letter-to-sound rules are trained on the very
lexicon the pack carries, so their output is already in the pack's own alphabet and there is no
phone-set table anywhere to get subtly wrong.

The frontend is `OpenSource/AI/engine/src/backends/g2p` - an ordinary backend, format `dspg`,
request kind `phonemize`, described in [`g2p-pack.md`](g2p-pack.md). It links nothing, exports no
new ABI symbol, and names no language. English is a pack file, and a pack for another language is a
file someone builds with `tools/g2p`, not a release of this library.

Four rules make the silent deletion structurally impossible instead of merely unlikely, and the
reader enforces all four rather than documenting them:

1. **Nothing is dropped.** Every token carries the exact input bytes before it and of it, so the
   tokens reassembled equal the request byte for byte. Losing a word fails an equality, which is
   checkable on strings nobody wrote down - and is, on ten thousand random ones per test run, plus
   once more on the real result inside the backend before anything is emitted.
2. **Every pronunciation says where it came from**: `lexicon`, `pos`, `stem`, `number`, `lts`,
   `spelled`, `refused`. Telling a dictionary fact from a guess is what makes guessing acceptable.
3. **The floor is total and the reader proves it.** A pack declares what it accepts and how each of
   those characters is read aloud. A pack missing one does not load, so the silent path is a build
   error rather than a device behaviour.
4. **What cannot be pronounced is reported, never removed.** The fallback vocabulary is `lts`,
   `spell`, `refuse` and `defer`. There is no `drop`, and a request naming one is refused by name.

`defer` is Option C, made concrete: it marks the whole sentence, at sentence granularity because
switching voices mid-clause sounds worse than either voice alone, and it **still emits phonemes**,
so a caller that ignores the mark gets an accent rather than a hole.

Two limits are stated rather than hidden. There is no part-of-speech tagger, so the 790
POS-conditioned entries take `DEFAULT` and every affected token carries `pos_default` so a caller
can see the coin that was not flipped. And letter-to-sound accuracy on unseen proper nouns remains
the weakest class, which is exactly what `defer` exists to route away.

### Measured sizes

Every figure below was produced by downloading the artifact and measuring it. `deflate-9` is raw
DEFLATE at level 9, the same codec `check_ai_size.rb` uses, because that is what an `.ipa` and an
`.aab`'s native-library delivery actually compress with.

**The runtime** - ONNX Runtime 1.27.0 (Apple) / 1.28.0 (Android), device ABI only:

| artifact | raw | deflate-9 |
|---|---|---|
| `onnxruntime.xcframework/ios-arm64/onnxruntime.framework/onnxruntime` | 43,990,640 B | **10,504,420 B** (10.02 MiB) |
| `jni/arm64-v8a/libonnxruntime.so` | 28,637,280 B | **10,551,409 B** (10.06 MiB) |
| `jni/arm64-v8a/libonnxruntime4j_jni.so` | 111,648 B | 31,544 B |

```bash
curl -sSL -o ort-ios.zip https://download.onnxruntime.ai/pod-archive-onnxruntime-c-1.27.0.zip
curl -sSL -o ort.aar \
  https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/1.28.0/onnxruntime-android-1.28.0.aar
# then deflate the ios-arm64 slice / the arm64-v8a .so at level 9
```

Archive digests, for pinning: `ort-ios.zip` =
`8c74edd600eafc3055de9e8f7a9602afee44ed516913cb5e132bca02cc34622c`, `ort.aar` =
`f351a0638696f54b35184290dbc001d66daae17281ad0b548d2c70347d53b8a9`.

**The model**, from `onnx-community/Kokoro-82M-v1.0-ONNX` at commit
`1939ad2a8e416c0acfeecc08a694d14ef25f2231`. Sizes and SHA-256 are the Hub's own LFS object ids;
the `q8f16` row was additionally downloaded and hashed by hand, and the digest matched - which is
what establishes that the other rows' ids are usable as `weights` pins.

| file | raw | SHA-256 |
|---|---|---|
| `onnx/model_q8f16.onnx` | 86,033,585 B | `04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0` |
| `onnx/model_q4f16.onnx` | 154,586,422 B | `d1a508a6a29671ead84fac99c7401fbd3c21a583fc6ed1406d1ec974d53bf45f` |
| `onnx/model_fp16.onnx` | 163,234,740 B | `ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a` |
| `onnx/model.onnx` (fp32) | 325,532,232 B | `8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb` |
| `voices/<name>.bin` (one per voice) | 522,240 B each | per-file, listed by the Hub tree API |

`model_q8f16.onnx` compresses to **57,004,662 B** at deflate-9 (ratio 0.663) - a quantized model
is close to incompressible, so the download size is very nearly the shipped size.

**What that adds up to.** The smallest useful tier-2 bundle is the runtime plus `q8f16` plus one
voice: **≈ 67 MB compressed on Android, ≈ 67 MB compressed on Apple**. That is eight times the
core engine's entire 8 MiB budget, which is precisely why tier 2 must be a unit an app can
exclude and why tier 1 is the default.

### The declarations, ready to paste

These are the real rows, with the verified pins. They are **not** declared on the `Voice` module
today, deliberately: `weights` fetches for every enabled module, so declaring them there would
make every tier-1 app download 86 MB for a code path it never calls. They belong on whatever unit
an app can exclude independently - a child module under `Voice/Modules/`, or the app's own module.

```json
"pods": [
  { "name": "onnxruntime-objc", "version": "1.27.0" }
],
"gradle": {
  "dependencies": ["com.microsoft.onnxruntime:onnxruntime-android:1.28.0"]
},
"weights": [
  { "path": "kokoro-q8f16.onnx",
    "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model_q8f16.onnx",
    "sha256": "04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0",
    "bytes": 86033585 }
]
```

The URL is pinned to the **commit**, not to `main`: the `sha256` already makes a swap fatal, and a
commit-pinned URL makes it impossible rather than merely detectable.

### The size budget

`check_ai_size.rb` carries a `voice` budget row that is deliberately `:unset`. It skips while no
artifact exists - which is the correct state today, because **tier 1 produces no native artifact
at all**: it is a system framework on both platforms, so there is nothing to weigh.

The number to set, when tier 2 lands, is **measured above and not invented**: the runtime is
10,504,420 B (Apple) / 10,551,409 B (Android) compressed, per device ABI. A budget of **12 MiB**
for the tier-2 runtime artifact leaves ~14% headroom over the larger of the two measurements,
which is the same shape of headroom the core's 8 MiB budget carries over its 2.17 MB reading.
Model weights are **not** in that budget - they are `weights`-delivered app resources, not linked
code, and they are per-voice by nature.

## Voice packs on disk

A downloaded voice is a directory under the app's voices root, each with a `voice.json`:

```json
{ "id": "some-voice-en", "name": "Some voice (English)", "provider": "neural",
  "engine": "neural", "languages": ["en", "en-US"], "sampleRate": 24000 }
```

Voices live in Application Support (Apple) / `filesDir` (Android), never in a cache: a voice a
user chose to download must survive a low-storage purge. Synthesized **audio** is the opposite -
it is reproducible from its text, so it is staged in the cache and dropped when the utterance
settles.

## The per-locale rule (D7)

The default voice set is **per locale, not one voice**. When a call names a language and nothing
serves it, the answer is a typed `no_voice` carrying the languages the installed voices *do*
serve - never the first installed voice as a substitute. An Arabic-locale app silently handed an
English voice is worse than an absence, because an absence can be fixed by a download and the
wrong voice just sounds broken.

Fit is matched on the primary subtag, so `en-GB` is served by an `en` voice; a region-exact match
sorts first, and at equal region fit an enhanced or premium system voice sorts ahead of a default
one. Only a call with **no** language at all falls back - to the device's own preferred locale,
and then to whatever the selected provider offers first.
