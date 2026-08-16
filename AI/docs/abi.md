# The Despia AI C ABI

`engine/include/despia_ai.h` is the contract. Everything crossing it is UTF-8
JSON plus one callback, which is what lets a binding, a host app, or an entirely
different runtime consume the engine without linking C++ directly.

This page states the parts a header cannot: how the ABI is allowed to change,
and what the threading rules mean for code you write against it.

## The symbols

| Symbol | What it does |
|---|---|
| `despia_ai_abi_version()` | The ABI version this build implements. Compare it against a catalog entry's `requires.abi`. |
| `despia_ai_capabilities()` | What this build carries, as JSON. Caller-owned; free with `despia_ai_free`. |
| `despia_ai_free(p)` | Frees anything the ABI returned as caller-owned. Safe on null. |
| `despia_ai_open(config_json)` | Opens a context. Null on failure; ask `despia_ai_last_error(NULL)` why. |
| `despia_ai_close(ctx)` | Cancels what is in flight, joins the worker, frees the context. |
| `despia_ai_load_model(ctx, model_json)` | Loads a model from its catalog entry, verbatim. |
| `despia_ai_unload_model(ctx, model_id)` | Unloads it and frees its resources. |
| `despia_ai_request(ctx, request_json, cb, user)` | Submits a request; returns its id or a negative code. |
| `despia_ai_sync(ctx, request_id)` | Asks for a full-snapshot `sync` event on a live request, now. |
| `despia_ai_cancel(ctx, request_id)` | Cancels a request. Idempotent, and legal from inside the callback. |
| `despia_ai_last_error(ctx)` | The last error as JSON. Context-owned; do not free. |

## How it may change

Three rules, and they are the reason a five-year-old app keeps working:

1. **Additive only.** Symbols are added, never changed or removed. A breaking
   change means a NEW symbol beside the old one, with the old one retired
   loudly at a major version, never quietly redefined.
2. **Must-ignore envelopes.** Every JSON document carries a `schema_version`,
   and unknown fields are ignored in both directions. A newer host talking to an
   older engine works for the fields they share; a newer engine reporting
   capabilities an older consumer never heard of changes nothing about how that
   consumer behaves.
3. **Self-description before assumption.** `despia_ai_capabilities()` is how you
   learn what this build carries. Nothing in a consumer should hardcode an
   engine id, a format, or a feature. A catalog entry naming a backend the build
   does not carry answers typed absence; it does not crash.

## The threading contract

This is part of the ABI, not advice. A published C ABI without a stated
threading model is a published footgun.

- **One worker per context** delivers every event, in production order. Two
  callbacks never race on one context, and ordering within a request is the
  order the engine produced.
- **From inside the callback, only `despia_ai_sync`, `despia_ai_cancel` and
  `despia_ai_last_error` are legal** on that context. Everything else is
  undefined, because the callback runs on the thread that would service it.
  Cancelling on the first token is the first thing most consumers do, which is
  exactly why it is on the whitelist.
- **One context, one driver thread.** Two threads sharing a context is
  undefined. Open two contexts instead; they are cheap.
- **The callback must not block.** It runs on the engine's worker, so blocking
  it stalls generation. Hand the event to your own queue and return.
- **`despia_ai_close` joins the worker**, so no callback arrives after it
  returns. That is what makes deterministic teardown possible, and it is why
  close cancels rather than drains: a consumer that wants the rest of the
  answer waits for the terminal event first.

The JVM lane tests these rules, because that is where threads are real and
where a violation shows up as a hang rather than as a shrug.

## What lives above the seam

The engine streams typed blocks and knows nothing else. The catalog, fit, the
router, the tool registry, the agentic loop, approvals and the transcript are
all the HOST's - they are policy, and policy that lives in the engine is policy
you cannot change without shipping a new binary. `bindings/ts/src/host.ts` is
the reference implementation of that split, and
`OpenSource/Conformance/ai/README.md` states the four host contracts the Swift,
Kotlin and TypeScript hosts must agree on.

## Errors

`despia_ai_last_error` returns `{ "code": ..., "message": ... }`. Codes you will
meet: `invalid_config`, `invalid_request`, `unknown_model`, `unsupported` (this
build carries no such backend), `model_unreadable`, `format_unrecognized` /
`format_malformed` / `format_unsupported` (the pre-flight validator refused the
file), `load_failed`, and `closing`.

`unsupported` is worth calling out: it is a typed absence, not a failure. A
catalog is a fleet-wide document and a build carries what it carries.

## The pre-flight validator

Before any backend maps a file, a bounded parser reads its header and agrees it
is what it claims to be. It never allocates on a number read from the file,
never seeks past the declared size, bounds every count and length before using
it, and returns a reason rather than a partial result.

It exists because arbitrary-origin models are a feature: an app may allow any
model URL its allowlist admits. The validator is the third of the four locks
that make that safe, alongside the origin allowlist, digest discipline, and fit
plus quarantine. It is the subject of the nightly fuzz target, because it is the
only code that runs before attacker-controlled bytes reach a real loader.

## The residency budget

`despia_ai_open`'s config carries `limits.max_runtime_bytes`: a ceiling on the
SUM of the loaded models' `runtime_mb`. When loading one would exceed it, the
least recently USED resident model is unloaded first, and the model being loaded
is never a candidate. If evicting everything still would not make room, nothing
is evicted - losing every other model to fail anyway is not a trade.

**It counts what the process is charged**, and that is the whole contract. A
model's `runtime_mb` is its KV cache, compute buffers and runtime structures;
the weights arrive by mmap and are deliberately not in it, because those pages
are clean and file-backed and the kernel reclaims them without asking. So derive
the budget from the same per-process limit you would compare a model's footprint
against - `os_proc_available_memory()` on iOS, the cgroup headroom on Android -
never from total RAM and never from the file size on disk. A budget in one
quantity checked against a total in another evicts on every load or on none, and
both of those look exactly like the feature working.

Omitting the key, or passing 0, means **unbounded**: nothing is ever evicted for
memory. That is the right answer on a desktop, where the per-process ceiling is
not a real constraint and unloading a multi-gigabyte model to reload it minutes
later is pure loss. It is the wrong answer on a phone, and the engine cannot
tell the difference - only the host can see the real limit, which is why this is
a config field rather than something the engine measures.

A `max_runtime_bytes` that is not a finite, non-negative number refuses the open
with `invalid_config` rather than being ignored. A budget that was meant to be
set and got quietly dropped is indistinguishable from no budget at all, which is
the failure this field exists to make visible.

## The crash-quarantine marker

The engine writes a marker before every load and every generation and clears it
on success. If the marker is still on disk at the next open, that model took the
process down. The engine only keeps the marker honest; the host decides what to
do, and what it does is refuse the model with a typed error the user can clear.
Without this, one bad model-and-device pair becomes a relaunch crash loop in a
customer's app.
