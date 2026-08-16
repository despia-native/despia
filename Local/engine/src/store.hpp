// store.hpp - a Base handle: the thing behind the ABI's opaque pointer.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// A handle owns one SQLite connection, the directory that connection lives in,
// and the last typed error raised on it. The threading contract in
// despia_local.h is implemented here and nowhere else: calls are synchronous,
// one handle is driven by one thread at a time, and savepoints are per-handle
// because they are per-connection in SQLite.
//
// What this file does NOT do is as important as what it does. There is no
// agent loop here, no approval flow, no embedding model, no sync. Those live
// in the HOST (the module layer) and in the AI package, because they are policy
// and this is mechanism. The store's whole job is: validate at the boundary,
// keep values out of SQL, make transactional scopes and durable backups real,
// and never lie about what it can do.

#ifndef DESPIA_LOCAL_STORE_HPP
#define DESPIA_LOCAL_STORE_HPP

#include <cstdint>
#include <string>

#include "json.hpp"

struct sqlite3;

namespace despia {
namespace base {

// The schema version of every envelope this build writes and reads. Unknown
// fields are must-ignore in both directions; a NEWER schema_version on input is
// accepted for the fields this build understands.
constexpr int kSchemaVersion = 1;
constexpr uint32_t kAbiVersion = 1;

// Whether this build carries sqlite-vec. A build without it is a legitimate
// build - a data plane is a product with no AI in it at all - and it answers
// TYPED ABSENCE on the vector actions rather than pretending. The capability
// document says so too, so a host never has to discover it by failing.
#ifndef DESPIA_LOCAL_HAS_VEC
#define DESPIA_LOCAL_HAS_VEC 1
#endif

// The embedding that produced a vector: model, width and revision. Not optional
// metadata. A new embedder silently invalidates every stored vector, and this
// triple is what turns that into a typed error with a reindex path instead of
// confidently wrong search results (local-ai-engine.md 9, "Embedding drift").
struct Embedding {
  std::string model;
  int64_t dimension = 0;
  std::string revision;
  bool hasRevision = false;

  static bool parse(const json::Value& v, Embedding* out, json::Value* error);
  json::Value toJson() const;
};

class Store {
 public:
  // Returns null and fills `error` when the config does not validate or the
  // file cannot be opened.
  static Store* open(const json::Value& config, json::Value* error);
  ~Store();

  // Close and reopen the same file without the graceful path - see
  // despia_local_reopen. Committed data returns; an open savepoint does not.
  int reopen(json::Value* error);

  // Runs one named action. Returns true and fills `result`, or returns false
  // and fills `error` with { code, message, data }.
  bool call(const std::string& action, const json::Value& args,
            json::Value* result, json::Value* error);

  const std::string& lastErrorJson() const { return lastError_; }
  void setLastError(const json::Value& err);
  void setLastError(const std::string& code, const std::string& message);
  void clearLastError() { lastError_.clear(); }

 private:
  Store() = default;
  int openConnection(json::Value* error);
  void closeConnection();

  sqlite3* db_ = nullptr;
  std::string directory_;
  std::string file_;
  bool readonly_ = false;
  std::string lastError_;
};

// What this build carries. Read at runtime rather than assembled from macros,
// so the SQLite it names is the SQLite it is actually running against.
json::Value capabilities();

// The action names this build answers, in the order the capability document
// reports them. One list, used by both - a surface that is documented in one
// place and dispatched in another drifts.
const char* const* actionNames(int* count);

}  // namespace base
}  // namespace despia

#endif  // DESPIA_LOCAL_STORE_HPP
