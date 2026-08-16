# The catalog channel

Models ship OTA exactly the way screens do. The AI manifest lives at a path of
the app's own hosted content root - `/dsx/ai/` - inside the same signed,
atomically-flipped content generation that serves everything else. The app ships
today, a new model lands tomorrow, and support arrives through the pipeline the
app already trusts, while everything keeps running fully local once downloaded.

## What the folder holds

```
/dsx/ai/
  models.json          the catalog: entries, and the fit metadata each carries
  router.json          task -> model preference, and the remote policy
  device-classes.json  the class table fit reads its priors against
  mcp.json             declared MCP servers
  presets.json         agent presets
```

One folder, one generation, one `content.updated` bell. That is deliberate: an
app whose catalog and router disagree because they arrived separately is an app
that routes to a model it does not have.

## models.json

```jsonc
{ "schema_version": 1,
  "fit_policy": { "slow_decode_tps": 8 },
  "entries": [
    { "schema_version": 1, "id": "qwen3-0.6b-q4", "name": "Qwen3 0.6B (Q4)",
      "family": "qwen3", "engine": "gguf", "format": "gguf", "status": "active",
      "requires": { "abi": 1, "engine_caps": ["gbnf"] },
      "files": [ { "name": "model.gguf", "bytes": 397000000, "sha256": "<64hex>",
                   "urls": [ "https://<your-mirror>/qwen3-0.6b-q4.gguf",
                             "https://huggingface.co/<org>/<repo>/resolve/<COMMIT>/model.gguf" ] } ],
      "license": { "id": "Apache-2.0", "url": "https://huggingface.co/<org>/<repo>" },
      "languages": ["en", "ar"],
      "inputs": ["text"], "outputs": ["text-stream", "json"],
      "context_length": 32768, "thinking": true,
      "tool_dialect": "hermes-json", "template": null,
      "sampling": { "temperature": 0.7, "top_p": 0.8 },
      "requirements": { "footprint_mb": 900, "mapped_mb": 400, "disk_mb": 400 },
      "perf_priors": { "phone-high": { "prefill_tps": 300, "decode_tps": 25 },
                       "phone-mid":  { "prefill_tps": 140, "decode_tps": 12 } } }
  ] }
```

`urls` is a MIRROR list, tried in order. One host being down is not an outage,
and a mirror is not a trust shortcut: whichever URL answers, the same digest and
the same pre-flight parse apply.

## Tolerance, so a fleet can straddle releases

A catalog is one document read by every version of your app that is still
installed. So: unknown fields are ignored with a notice, an entry requiring a
newer ABI or an engine capability this build lacks is SKIPPED rather than
fatal, and a malformed row is dropped without taking the rest of the catalog
with it. One future row must never blind an app to its working models.

## Importing from Hugging Face

```
node tools/hf-import.ts Qwen/Qwen3-0.6B-GGUF Qwen3-0.6B-Q4_K_M.gguf >> entry.json
```

The importer resolves the branch to a commit, records the digest and size, and
reads the licence from the repo - because an import flow that leaves those to
the person importing is an import flow whose catalog eventually lies. It refuses
rather than guessing: no resolvable commit, no declared licence, or a format
this build does not carry are all errors, not warnings.

## Adding a model at runtime

The importer above is an AUTHORING tool: it runs on a developer's machine and
its output goes into a catalog somebody reviews. The runtime half of the same
promise is `models.add`, which resolves the same reference on the device and
produces the same entry without a rebuild:

```js
await dsx.module.intelligence.models.add({ source: "hf:org/repo/file.gguf" })
await dsx.module.intelligence.models.add({ source: "hf:org/repo", prefer: "Q4_K_M" })
```

What comes back is an ordinary catalog entry, so everything downstream -
download, the four locks, pre-flight, fit, the governor, load - applies to it
unchanged. The entry synthesis is literally the same function the importer
calls; two implementations of it would be exactly the drift a shared catalog
schema exists to prevent.

Where it asks is the APP's decision, not the response's. `models.sources` in
the catalog document carries URL TEMPLATES:

```jsonc
"sources": {
  "hf": {
    "api":  "https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true",
    "file": "https://huggingface.co/{repo}/resolve/{commit}/{path}",
    "page": "https://huggingface.co/{repo}"
  }
}
```

An app that declares no registry adds nothing, which is the same fail-closed
default `allowed_model_hosts` has. And the registry's ANSWER is untrusted input
end to end: both the metadata call and the file are origin-checked before a byte
is sent, so a resolved URL on a host the app never allowed is refused BY NAME
and nothing in a response can widen the allowlist; the revision must be a
40-hex commit; a digest that is not 64 lowercase hex is DROPPED rather than
stored, because a digest that can never match is worse than none and the
pin-on-first-download path is the one that would have been safe.

The FILE outranks the registry wherever the bytes can answer. `context_length`,
the architecture and the parameter count are read off the GGUF header, and the
entry records which tier each field came from in `origin.provenance` - an API
that is wrong about a context length produces a model that truncates silently.
An added entry's `requirements` are DERIVED rather than measured (`disk_mb` and
`mapped_mb` are the file size; `footprint_mb` is the header's KV cache plus an
allowance for compute buffers, at the shipped catalog's own 1.5x margin), so
every fit verdict computed from them carries `predicted: true` and a surface
should say so.

Added entries live in their own overlay, not in `models.json`: an OTA catalog
replaces the catalog wholesale and must not delete a model somebody chose. They
carry `origin.added` forever and `added: true` on every row, and an id a shipped
row already owns is refused rather than shadowed.

## The seed generation

An app that has never reached its content root still has to work, so the catalog
ships in the build as generation zero: the AI module carries a `models.json` of
exactly this shape at
`ClosedSource/DSX/Modules/Core/LocalAI/models.json`, and an OTA catalog replaces
it wholesale. That is the bundled floor applied to models rather than screens -
seeds are generation zero, and the ladder above them is the same one.

Two twins are generated from it, `swift/CactusModel.swift` and
`kotlin/CactusModel.kt`, because the module needs the rows at compile time
before any generation has been fetched. Regenerate both when the seed changes;
hand-editing one half is how a catalog starts disagreeing with itself.

## Arbitrary origins

Beyond the curated set, an app may allow any model URL. Four locks apply to
every model regardless of source - the origin allowlist, digest discipline, the
pre-flight validator, and fit plus quarantine. `docs/models-and-licenses.md`
carries them, including **what a developer adds to `allowed_model_hosts` to
serve their own models**, and `OpenSource/Conformance/ai/capabilities/delivery.json`
pins them.

## A row is a claim; the loader settles it

`despia_ai_load_model` takes a catalog entry VERBATIM, so a row is testable by
construction and there is no excuse for an untested one. Load it, run one
request, record the result - then write the row. The seed catalog was built that
way and records what it REFUSED as well as what it kept, because "we tried this
file and the pre-flight parser rejected it" is information the next person needs
and cannot recover from an absence.

Three fields are load-bearing in ways their names do not advertise:
`context_length` is the SERVING context the engine sizes its KV cache to and not
the model's maximum; `embedding: true` is what puts a model into embedding mode
at load, without which an embedding request answers `no_embeddings`; and
`requirements.footprint_mb` is what fit charges against the per-process limit and
therefore has to be measured, not estimated.

## Promotion

The catalog and router retune the whole fleet, which is the point and the
danger. Until the evaluation gate exists, a catalog change gets the same review
weight as code - because it is code, in the way that matters.
