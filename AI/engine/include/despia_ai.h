/*
 * despia_ai.h - the Despia AI C ABI.
 *
 * Copyright Despia. Licensed under the Apache License, Version 2.0.
 * See the LICENSE file at the root of this package.
 *
 * This header IS the contract. Everything crossing it is UTF-8 JSON plus one
 * callback, which is what makes the engine swappable underneath a binding and
 * droppable into a host that never links C++ directly.
 *
 * Three rules govern how it changes (local-ai-engine.md 4.2, "the engine
 * constitution"):
 *
 *   1. SELF-DESCRIPTION. despia_ai_capabilities() reports what THIS build
 *      carries - engines, formats, modalities, tool dialects, features, limits.
 *      Consumers ADAPT to the reported surface; they never hardcode it.
 *   2. ADDITIVE EVOLUTION. Symbols are added, never changed or removed. Every
 *      JSON envelope carries a schema_version and unknown fields are
 *      MUST-IGNORE on both sides. Breaking means a new symbol beside the old
 *      one, retired loudly at a major.
 *   3. THE THREADING CONTRACT IS PART OF THE ABI. It is stated below and in
 *      docs/abi.md, and it evolves as additively as the symbols do.
 *
 * There are no telemetry symbols in this header, and there will never be any.
 * The only network path in the package is the model downloader, which lives
 * above this seam in the host.
 */

#ifndef DESPIA_AI_H
#define DESPIA_AI_H

#include <stdint.h>

/* Everything in the library is hidden by default; the symbols below are the
 * ONLY exported surface. That is deliberate: a shared library that exports its
 * whole implementation is a library whose internals become someone's
 * dependency, and then an internal rename is a breaking change. This macro is
 * what makes "the header IS the contract" literally true of the .so. */
#ifndef DESPIA_AI_API
#  if defined(_WIN32)
#    if defined(DESPIA_AI_BUILDING)
#      define DESPIA_AI_API __declspec(dllexport)
#    else
#      define DESPIA_AI_API __declspec(dllimport)
#    endif
#  else
#    define DESPIA_AI_API __attribute__((visibility("default")))
#  endif
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* --- versioning ------------------------------------------------------- */

/* The ABI version this build implements. Bumped only for additive growth;
 * a consumer compares it against a catalog entry's `requires.abi`. */
DESPIA_AI_API uint32_t despia_ai_abi_version(void);

/* What this build carries, as UTF-8 JSON. The caller owns the returned
 * pointer and frees it with despia_ai_free.
 *
 *   { "schema_version": 1, "abi": 1, "version": "0.1.0",
 *     "engines":   ["gguf", "mock"],
 *     "formats":   ["gguf"],
 *     "modalities":["text", "embedding"],
 *     "dialects":  ["hermes-json"],
 *     "features":  ["gbnf", "structured-output"],
 *     "limits":    { "max_context": 131072, "max_parallel": 1 } }
 *
 * A consumer reading this asks; it never assumes. An unknown key here is
 * must-ignore for an older consumer, exactly as an unknown request field is
 * must-ignore for a newer engine. */
DESPIA_AI_API const char* despia_ai_capabilities(void);

/* Frees any pointer this ABI returned as caller-owned. Safe on NULL. */
DESPIA_AI_API void despia_ai_free(void* p);

/* --- contexts --------------------------------------------------------- */

/* Every event the engine emits for a context is delivered through one of
 * these. `event_json` is owned by the ENGINE and is valid only for the
 * duration of the call - copy anything you keep. */
typedef void (*despia_ai_event_cb)(const char* event_json, void* user_data);

/* Opens an engine context. `config_json` is validated at the boundary against
 * a typed schema: unknown fields are ignored, wrongly-typed known fields are
 * a refusal. There is no verbatim vendor blob, which is what makes "local
 * only" enforceable rather than aspirational.
 *
 *   { "schema_version": 1,
 *     "backends": ["gguf", "mock"],           // optional restriction
 *     "state_dir": "/path/for/quarantine",    // where the crash marker lives
 *     "limits": { "max_runtime_bytes": 0 } }  // 0 = unbounded (the default)
 *
 * `limits.max_runtime_bytes` is the residency budget: a ceiling on the SUM of
 * the loaded models' `runtime_mb`, and when a load would exceed it the least
 * recently used model is unloaded first to make room. It counts what the
 * PROCESS is charged - KV cache, compute buffers, runtime structures - and
 * never the mmapped weights, which are clean file-backed pages the kernel
 * reclaims on its own. Derive it from the same per-process memory limit you
 * would compare a model's footprint against; a budget in one quantity checked
 * against a total in another evicts constantly or never.
 *
 * Omitting it, or passing 0, means unbounded: nothing is ever evicted for
 * memory. That is the right answer on a desktop and the wrong one on a phone,
 * where the host is the only party that can see the real limit.
 *
 * Returns an opaque context, or NULL. On NULL there is no context to ask, so
 * the failure is reported through despia_ai_last_error(NULL). */
DESPIA_AI_API void* despia_ai_open(const char* config_json);

/* Closes a context. Cancels everything in flight and joins its worker before
 * returning, so no callback can arrive after this call returns. Safe on NULL. */
DESPIA_AI_API void despia_ai_close(void* ctx);

/* --- models ----------------------------------------------------------- */

/* Loads a model. `model_json` is CATALOG-ENTRY-SHAPED: the same document the
 * host already holds, passed through, so nothing has to be re-derived here.
 * The engine reads what it needs (id, engine, format, path, context_length,
 * template, tool_dialect, sampling) and ignores the rest.
 *
 * Before a real backend maps the file the engine runs the pre-flight
 * validator - a bounded format parse - and writes the crash-quarantine marker.
 * The marker is cleared on success, so a load that took the process down is
 * visible to the next launch instead of becoming a relaunch crash loop.
 *
 * Returns 0 on success, or a negative error code (see despia_ai_last_error). */
DESPIA_AI_API int despia_ai_load_model(void* ctx, const char* model_json);

/* Unloads a model and frees its resources. Returns 0, or negative on error. */
DESPIA_AI_API int despia_ai_unload_model(void* ctx, const char* model_id);

/* --- requests --------------------------------------------------------- */

/* Submits a request. Returns a non-negative request id, or a negative error
 * code. Events for the request are delivered to `cb` with `user_data`, and
 * the request id appears on every one of them.
 *
 *   { "schema_version": 1, "kind": "completion",
 *     "model": "qwen3-0.6b-q4",
 *     "priority": "interactive",              // interactive | background
 *     "messages": [ { "role": "user",
 *                     "parts": [ { "type": "text", "text": "..." },
 *                                { "type": "image", "url": "..." } ] } ],
 *     "tools": [ ... ],                        // OpenAI-shaped, verbatim
 *     "response_format": { "type": "json_schema", "schema": { ... } },
 *     "options": { "budget_mb": 0, "timeout_ms": 0 } }
 *
 * `kind` is an open vocabulary checked against the reported capabilities:
 * completion, embed, transcribe, synthesize, and whatever a registered
 * backend adds. Binary inputs are REFERENCES (url), never inline bytes.
 *
 * `priority` and the `options` budget fields are the resource governor's
 * reservation: they are accepted and carried from day one so the scheduler
 * can start honouring them without an ABI change. */
DESPIA_AI_API int despia_ai_request(void* ctx, const char* request_json,
                      despia_ai_event_cb cb, void* user_data);

/* Asks for a full-snapshot `sync` event on a live request, now.
 *
 * The streaming grammar sends DELTAS, which is what keeps a long generation
 * linear over the bridge - but it means a surface that attaches mid-stream has
 * missed everything before it. This is how it catches up: the engine emits a
 * `sync` carrying the accumulated typed blocks and the sequence number they
 * correspond to. Legal from inside the callback, like cancel.
 *
 * Returns 0 if the request existed, negative otherwise. */
DESPIA_AI_API int despia_ai_sync(void* ctx, int request_id);

/* Cancels a request. Idempotent, and legal from INSIDE the event callback -
 * cancelling on the first token is the first thing every consumer does.
 * Returns 0 if the request existed, negative otherwise. */
DESPIA_AI_API int despia_ai_cancel(void* ctx, int request_id);

/* --- errors ----------------------------------------------------------- */

/* The last error on this context as JSON { "code": ..., "message": ... }.
 * The string is CONTEXT-OWNED and valid until the next call on that context;
 * do not free it. Pass NULL to read the last global (open-time) error. */
DESPIA_AI_API const char* despia_ai_last_error(void* ctx);

/*
 * THE THREADING CONTRACT (part of the ABI - docs/abi.md carries it in prose):
 *
 *   - Events for a context are delivered on ONE engine-owned worker thread.
 *     A consumer never has to reason about two callbacks racing on one
 *     context, and ordering within a request is the order the engine produced.
 *   - From inside the callback, only despia_ai_cancel, despia_ai_sync and
 *     despia_ai_last_error are legal on that context. Everything else is
 *     undefined, because the callback runs on the thread that would service it.
 *   - despia_ai_sync is also legal from the CALLER's thread, and is the one
 *     entry point that behaves differently depending on where it is called
 *     from. Called on the worker it emits immediately; called from the caller
 *     it DEFERS, and the sync arrives on the worker after the next block. It
 *     returns as soon as the request is known either way, and it never emits on
 *     the calling thread - the one-worker-thread promise above has no
 *     exceptions, because a consumer that has to guard for a second one has
 *     lost the guarantee entirely.
 *   - One context is driven by ONE caller thread. Two threads sharing a
 *     context is undefined; open two contexts instead.
 *   - The callback must not block. It runs on the engine's worker, so blocking
 *     it stalls generation - hand work to your own queue and return.
 *   - despia_ai_close joins the worker, so no callback arrives after it
 *     returns. That is what makes deterministic teardown possible.
 */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* DESPIA_AI_H */
