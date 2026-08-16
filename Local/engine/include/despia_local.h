/*
 * despia_local.h - the Despia Local C ABI.
 *
 * Copyright Despia. Licensed under the Apache License, Version 2.0.
 * See the LICENSE file at the root of this package.
 *
 * This header IS the contract. Everything crossing it is UTF-8 JSON, which is
 * what makes the store swappable underneath a binding and droppable into a host
 * that never links C++ directly.
 *
 * The same three rules govern it that govern the AI package's ABI
 * (local-ai-engine.md 4.2, "the engine constitution" - one constitution, two
 * engines):
 *
 *   1. SELF-DESCRIPTION. despia_local_capabilities() reports what THIS build
 *      carries - the action surface, the vector backend, the SQLite underneath,
 *      the limits. Consumers ADAPT to the reported surface; they never hardcode
 *      it. A build without sqlite-vec says so, and a caller that needs vectors
 *      answers typed absence instead of crashing on the first search.
 *   2. ADDITIVE EVOLUTION. Symbols are added, never changed or removed. Every
 *      JSON envelope carries a schema_version and unknown fields are
 *      MUST-IGNORE on both sides. Breaking means a new symbol beside the old
 *      one, retired loudly at a major.
 *   3. THE THREADING CONTRACT IS PART OF THE ABI. It is stated at the bottom of
 *      this file and in docs/abi.md, and it evolves as additively as the
 *      symbols do.
 *
 * Why ONE dispatch symbol and not one per action. The AI ABI has typed entry
 * points because its calls differ in KIND - a model load is not a request and a
 * cancel is not either. Base's calls do not: every one of them is a named
 * action taking a JSON argument object and returning a JSON result or a typed
 * error, which is exactly what a declared module action is on the bus. Giving
 * each of the seventeen its own symbol would freeze the action list into the
 * .so's export table, and then adding `index.rebuild` would be an ABI change
 * rather than an implementation detail. despia_local_call() is the funnel, and
 * despia_local_capabilities() is how a caller finds out what it accepts.
 *
 * There are no telemetry symbols in this header, and there will never be any.
 * There is no network path in this package at all - Base is a local file and a
 * set of verbs over it. Sync belongs to a vendor module (Core/PowerSync) and to
 * the server node, and this seam deliberately cannot reach either.
 */

#ifndef DESPIA_LOCAL_H
#define DESPIA_LOCAL_H

#include <stdint.h>

/* Everything in the library is hidden by default; the symbols below are the
 * ONLY exported surface. That is not merely tidy here, it is load-bearing: this
 * library statically links its own SQLite, and a Despia app can carry a sync
 * vendor that ships another one. Two libraries exporting sqlite3_* in one
 * process is a load-order coin flip - the vendor's calls bind to our SQLite or
 * ours to theirs, whichever the dynamic linker resolved first, and the failure
 * shows up as corruption rather than as a link error. Hidden visibility is what
 * makes the two copies invisible to each other, and
 * OpenSource/Local/tools/symbol_check.rb is what proves it on every build
 * instead of trusting that someone remembered. */
#ifndef DESPIA_LOCAL_API
#  if defined(_WIN32)
#    if defined(DESPIA_LOCAL_BUILDING)
#      define DESPIA_LOCAL_API __declspec(dllexport)
#    else
#      define DESPIA_LOCAL_API __declspec(dllimport)
#    endif
#  else
#    define DESPIA_LOCAL_API __attribute__((visibility("default")))
#  endif
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* --- versioning ------------------------------------------------------- */

/* The ABI version this build implements. Bumped only for additive growth. */
DESPIA_LOCAL_API uint32_t despia_local_abi_version(void);

/* What this build carries, as UTF-8 JSON. The caller owns the returned pointer
 * and frees it with despia_local_free.
 *
 *   { "schema_version": 1, "abi": 1, "version": "0.1.0",
 *     "sqlite":   { "version": "3.53.4", "source_id": "..." },
 *     "vectors":  { "backend": "sqlite-vec", "version": "v0.1.9",
 *                   "metrics": ["l2", "cosine"],
 *                   "element_types": ["float32", "int8", "bit"] },
 *     "features": ["savepoints", "snapshots", "restore", "export", "fts5"],
 *     "actions":  ["put", "get", ...],
 *     "limits":   { "max_dimension": 8192 } }
 *
 * A consumer reading this asks; it never assumes. An unknown key here is
 * must-ignore for an older consumer, exactly as an unknown argument field is
 * must-ignore for a newer store. `vectors` is absent, not empty, in a build
 * compiled without sqlite-vec - typed absence, not a lie about a capability. */
DESPIA_LOCAL_API const char* despia_local_capabilities(void);

/* Frees any pointer this ABI returned as caller-owned. Safe on NULL. */
DESPIA_LOCAL_API void despia_local_free(void* p);

/* --- handles ---------------------------------------------------------- */

/* Opens a store. `config_json` is validated at the boundary against a typed
 * schema: unknown fields are ignored, wrongly-typed known fields are a refusal.
 *
 *   { "schema_version": 1,
 *     "directory": "/path/to/the/app/container/base",  // required
 *     "readonly": false }
 *
 * `directory` holds base.db and a snapshots/ folder beside it. Everything the
 * ABI hands back that names a file names it RELATIVE to that directory
 * (file:///snapshots/x.db), never absolutely: an absolute path would leak the
 * app container's layout to whatever asked, including the page surface, for no
 * benefit to the caller.
 *
 * Returns an opaque handle, or NULL. On NULL there is no handle to ask, so the
 * failure is reported through despia_local_last_error(NULL). */
DESPIA_LOCAL_API void* despia_local_open(const char* config_json);

/* Closes a handle and its database connection. Any transaction still open is
 * rolled back by SQLite, which is the honest outcome: an unreleased savepoint
 * is an unfinished scope, and finishing it silently would be worse. Safe on
 * NULL. */
DESPIA_LOCAL_API void despia_local_close(void* handle);

/* Closes and reopens the underlying file WITHOUT the graceful path - what
 * happens when the process dies.
 *
 * This exists because durability is a fixture rather than a promise
 * (Conformance/local/crud "a committed write survives an abrupt process loss",
 * snapshot "an open savepoint does not survive a crash"). Committed data comes
 * back; an open savepoint's writes do not. It is a REAL operation - close, drop
 * the handle, open the same file again - not a simulation, which is why it can
 * be trusted to say something about the real crash.
 *
 * Returns 0, or negative on error. */
DESPIA_LOCAL_API int despia_local_reopen(void* handle);

/* --- actions ---------------------------------------------------------- */

/* Runs one named action. `args_json` is the action's argument object; the
 * result is a malloc'd UTF-8 JSON object the caller frees with
 * despia_local_free.
 *
 * Returns NULL on failure, and ONLY on failure - a successful action with
 * nothing to say returns {}. The typed error is then readable from
 * despia_local_last_error(handle) as { "code", "message", "data" }; `code` is
 * what a caller branches on and `message` is for humans.
 *
 * The v1 action surface, matching the module's declared actions one for one:
 *
 *   declare   { "store": "notes" }                       -> { "ok": true }
 *   put       { "store", "key", "value": {...} }         -> { "ok": true }
 *   get       { "store", "key" }                         -> { "value": ... | null }
 *   delete    { "store", "key" }                         -> { "deleted": 0|1 }
 *   query     { "store", "where": {...}, "order": [...],
 *               "limit": 0 }                             -> { "rows": [ {key,value} ] }
 *   stats     { }                                        -> { "stores": [...], "bytes": N }
 *   savepoint { "name" }                                 -> { "ok": true }
 *   release   { "name" }                                 -> { "ok": true }
 *   rollback  { "name" }                                 -> { "ok": true }
 *   snapshot  { "label" }                                -> { "ok", "label", "url" }
 *   snapshots { }                                        -> { "snapshots": [...] }
 *   restore   { "label" }                                -> { "ok": true }
 *   export    { "label" }                                -> { "url", "bytes" }
 *
 *   index.upsert  { "index", "key", "vector": [...],
 *                   "embedding": { "model", "dimension", "revision" },
 *                   "value": {...} }                     -> { "ok": true }
 *   index.info    { "index" }                            -> { "count", "embedding" }
 *   index.search  { "index", "vector": [...],
 *                   "embedding": {...}, "k": 10 }        -> { "hits": [ {key,value,distance} ] }
 *   index.delete  { "index", "key" }                     -> { "ok": true }
 *   index.reindex { "index", "embedding": {...},
 *                   "vectors": [ {key,vector,value} ] }  -> { "ok", "count" }
 *
 * The whole list is reported by despia_local_capabilities() under `actions`, and
 * an unknown action name is the typed error `unknown_action` rather than
 * undefined behaviour - a caller compiled against a newer manifest running on
 * an older library gets an answer it can act on.
 *
 * WHAT THIS SEAM WILL NOT DO: there is no action that takes SQL. Values are
 * always parameters and identifiers are always validated, so a value can never
 * become SQL - Conformance/local/crud "a value never becomes SQL" is the fixture
 * that says so. Handing an app raw SQL through the bus would make that
 * guarantee unenforceable in one line. */
DESPIA_LOCAL_API char* despia_local_call(void* handle, const char* action,
                                       const char* args_json);

/* --- errors ----------------------------------------------------------- */

/* The last error on this handle as JSON { "code", "message", "data" }.
 * The string is HANDLE-OWNED and valid until the next call on that handle; do
 * not free it. Pass NULL to read the last global (open-time) error. */
DESPIA_LOCAL_API const char* despia_local_last_error(void* handle);

/*
 * THE THREADING CONTRACT (part of the ABI - docs/abi.md carries it in prose):
 *
 *   - One handle is driven by ONE caller thread at a time. The library is built
 *     with SQLITE_THREADSAFE=1, so a handle shared across threads will not
 *     corrupt itself - but savepoints are per-CONNECTION state, so two threads
 *     interleaving transactional scopes on one handle would unwind each other's
 *     work. Open two handles instead; they are cheap, and WAL means a reader
 *     never blocks the writer.
 *   - despia_local_call is SYNCHRONOUS. There is no callback and no worker
 *     thread: a local database call returns in microseconds, and a queue in
 *     front of it would buy nothing but a way for the caller to lose ordering.
 *     A host that wants asynchrony owns its own queue, which is what the module
 *     layer does.
 *   - The pointer from despia_local_call is the CALLER's; the pointer from
 *     despia_local_last_error is the HANDLE's. Freeing the second is a
 *     double-free and keeping the first is a leak. That asymmetry is
 *     deliberate: the error must be readable after a call that returned nothing
 *     to own.
 *   - despia_local_close is final. Using a handle after closing it is undefined,
 *     as it is for every C ABI, and the bindings each own a handle so their
 *     callers cannot.
 */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* DESPIA_LOCAL_H */
