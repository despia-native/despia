# Models, the catalog, and licences

The engine's licence is not the model's. Apache-2.0 covers this package; every
model carries its own terms, and the catalog records them per entry so an app
can show a user what they are agreeing to before a gigabyte moves.

## A catalog entry

```jsonc
{ "schema_version": 1, "id": "qwen3-0.6b-q4", "name": "Qwen3 0.6B (Q4)",
  "family": "qwen3", "engine": "gguf", "format": "gguf",
  "status": "active",                              // active | deprecated | retired
  "requires": { "abi": 1, "engine_caps": ["gbnf"] },
  "files": [ { "name": "model.gguf", "bytes": 397000000, "sha256": "<64hex>",
               "urls": [ "https://<mirror>/...", "https://huggingface.co/<org>/<repo>/resolve/<REV>/..." ] } ],
  "license": { "id": "Apache-2.0", "url": "..." },
  "languages": ["en", "ar"],
  "inputs": ["text"], "outputs": ["text-stream", "json", "embedding"],
  "context_length": 32768, "thinking": true,
  "tool_dialect": "hermes-json", "template": null,
  "sampling": { "temperature": 0.7, "top_p": 0.8, "stop": [] },
  "requirements": { "footprint_mb": 900, "mapped_mb": 400, "disk_mb": 400 },
  "perf_priors": { "phone-high": { "prefill_tps": 300, "decode_tps": 25 } } }
```

Everything family-specific is DATA. A new model family is a catalog entry, not
an engine release: the chat template, the tool dialect, the context length, the
sampling defaults and the modality lists all live here. That is the difference
between supporting next month's model next month and supporting it next year.

## Two sizes, and why they are not the same number

`footprint_mb` is resident weights plus KV cache at the entry's context length -
what counts against the per-process limit the OS kills you against. `mapped_mb`
is the memory-mapped size, which is clean file-backed pages the kernel can
evict. Fit compares `footprint_mb` against the limit and never `mapped_mb`:
counting mapped size would refuse models that run perfectly well. The mapped
figure rides the verdict so a UI can warn about thrash on a busy device.

## Digests are a security boundary

Every file carries a SHA-256 and an immutable revision. The downloader verifies
before the engine loads and deletes on mismatch. If an entry arrives without a
declared digest, the first download PINS one and every later fetch is verified
against it - a changed byte at the origin is a typed refusal, not a shrug.

## Arbitrary models, under four locks

An app may allow any model URL, not only curated ones. Four locks make that a
feature rather than an attack surface, and all four apply to every model
regardless of source:

1. **An origin allowlist** (`allowed_model_hosts`, https only) in the AI
   module's settings. Your app names which hosts it trusts.
2. **Digest discipline**, as above.
3. **The pre-flight validator**: a bounded format parse clears the file before
   any tensor loader maps it.
4. **Fit and quarantine**: a model that cannot run is refused before it loads,
   and one that crashed the app is refused until the user clears it.

### What a developer has to add to download a model

Lock 1 is an allowlist, so it is worth saying plainly where the list starts and
what you do to extend it, rather than leaving it to be discovered.

The shipped catalog's rows all live on `huggingface.co`, and the AI module ships
`allowed_model_hosts` seeded with exactly those origins:

```json
{ "allowed_model_hosts": ["huggingface.co", "*.huggingface.co", "*.hf.co"] }
```

so the shipped models download with no configuration. The third entry is the Xet
CDN a `resolve/` URL redirects to - a different apex from `huggingface.co`,
observed rather than assumed.

**To serve a model of your own, add your host to that list**:

```json
{ "allowed_model_hosts": ["huggingface.co", "*.huggingface.co", "*.hf.co",
                          "models.yourcompany.com"] }
```

`https` only. `*.yourcompany.com` matches a SUBDOMAIN and not the apex, and
never a host that merely ends with the same letters. A host you have not named
fails with `origin_not_allowed` **before any request leaves the device** - not
mid-download, and not with a network error that looks like an outage.

**Emptying the list allows nothing.** That is the opt-out and it still works: an
app that wants its AI module to download nothing at all sets `[]` and gets
exactly that.

The seeded default is not a hole in the allowlist. It is still an allowlist,
still https-only, still the same wildcard grammar, and every byte is still
digest-verified with delete-on-mismatch. The only thing seeding changes is which
hosts start in the list, and they are the ones the catalog shipping beside it
already points at.

## A row is a claim, and the loader is what settles it

The compliance fields make a catalog honest about terms. They do not make it
honest about whether the file *loads* - and a catalog naming files the engine
cannot open is worse than an empty one, because it fails at the end of a
gigabyte download instead of at review.

So: **an entry nobody has loaded is a guess.** `despia_ai_load_model` takes a
catalog entry VERBATIM - the same document, no re-derivation - which makes every
row testable by construction. Load it, run one request, and record the result
before the row is written down. The shipped catalog
(`ClosedSource/DSX/Modules/Core/LocalAI/models.json`) was built that way, and it
carries a `_rejected` block naming two well-known GGUF files that download
cleanly, match their published digest, and are then **refused by the pre-flight
validator** - recorded so the next person to reach for them knows it was tried.

The same discipline applies to `requirements.footprint_mb`. It is what fit
charges against the per-process limit, so an estimate there is not a rounding
error - it is the difference between refusing a model that runs and admitting
one that gets the app killed. Measure it: resident, non-file-backed memory after
a real load and generate at the row's `context_length`. Measuring also catches
things a formula cannot, such as the fact that the gguf backend mmaps its
weights while whisper.cpp reads its ggml model into anonymous memory - so an ASR
row pays the whole weight in `footprint_mb` and declares `mapped_mb: 0`.

## Lifecycle

`active` is normal. `deprecated` still downloads and carries its status so a
dashboard can nudge. `retired` stops NEW downloads and does nothing else: an
installed model keeps working forever. There is no remote kill switch, which is
what "you own your own AI" has to mean to be worth saying.
