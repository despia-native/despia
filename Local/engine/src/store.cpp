// store.cpp - the data plane, over real SQLite.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Three design choices worth stating up front, because each one is a promise
// the corpus holds this file to:
//
//   1. A store must be DECLARED. Writing to an unknown store is a typed error,
//      never an implicit create - silent schema creation is how data planes rot.
//   2. Values are parameterised, ALWAYS. A value never becomes SQL. Identifiers
//      cannot be parameterised in SQLite, so every identifier that reaches a
//      statement here is either validated against a strict pattern or generated
//      by this file; a caller-supplied name never lands in SQL text unquoted.
//   3. Snapshot and export URLs are CONTAINER-RELATIVE (file:///snapshots/x.db).
//      An absolute path would leak the app container's layout to whatever asked,
//      including the page surface, for no benefit to the caller.
//
// The query vocabulary (`where` operators, `order`, the ordering of mixed
// types) is a DECLARED vocabulary rather than a host-language accident, because
// three runtimes implement it and "whatever JavaScript does" is not a
// specification. The total order is written down at compareValues below and in
// docs/data-plane.md; all three lanes implement that order and the corpus is
// what catches a lane that does not.

#include "store.hpp"

#include <algorithm>
#include <cstring>
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

#include <sqlite3.h>

#if DESPIA_LOCAL_HAS_VEC
#include <sqlite-vec.h>
#endif

namespace despia {
namespace base {
namespace {

namespace fs = std::filesystem;

json::Value fail(const std::string& code, const std::string& message,
                 json::Value data = json::Value()) {
  json::Value e = json::Value::obj();
  e.set("code", code);
  e.set("message", message);
  if (!data.isNull()) e.set("data", std::move(data));
  return e;
}

// A prepared statement that finalises itself. Every statement in this file goes
// through one, so an early return can never leak a statement handle - which is
// the bug that turns into "database is locked" three screens later.
class Stmt {
 public:
  Stmt(sqlite3* db, const std::string& sql) : db_(db) {
    rc_ = sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt_, nullptr);
  }
  ~Stmt() { sqlite3_finalize(stmt_); }
  Stmt(const Stmt&) = delete;
  Stmt& operator=(const Stmt&) = delete;

  bool ok() const { return rc_ == SQLITE_OK && stmt_ != nullptr; }
  sqlite3_stmt* raw() const { return stmt_; }

  void bindText(int i, const std::string& v) {
    sqlite3_bind_text(stmt_, i, v.data(), static_cast<int>(v.size()), SQLITE_TRANSIENT);
  }
  void bindInt(int i, int64_t v) { sqlite3_bind_int64(stmt_, i, v); }
  void bindNull(int i) { sqlite3_bind_null(stmt_, i); }
  void bindBlob(int i, const void* p, size_t n) {
    sqlite3_bind_blob(stmt_, i, p, static_cast<int>(n), SQLITE_TRANSIENT);
  }

  int step() { return sqlite3_step(stmt_); }
  bool row() { return sqlite3_step(stmt_) == SQLITE_ROW; }
  bool done() { return sqlite3_step(stmt_) == SQLITE_DONE; }

  std::string text(int col) const {
    const unsigned char* raw = sqlite3_column_text(stmt_, col);
    if (!raw) return std::string();
    return std::string(reinterpret_cast<const char*>(raw),
                       static_cast<size_t>(sqlite3_column_bytes(stmt_, col)));
  }
  bool isNull(int col) const { return sqlite3_column_type(stmt_, col) == SQLITE_NULL; }
  int64_t integer(int col) const { return sqlite3_column_int64(stmt_, col); }
  double real(int col) const { return sqlite3_column_double(stmt_, col); }

 private:
  sqlite3* db_ = nullptr;
  sqlite3_stmt* stmt_ = nullptr;
  int rc_ = SQLITE_ERROR;
};

std::string sqliteMessage(sqlite3* db) {
  const char* m = sqlite3_errmsg(db);
  return m ? std::string(m) : std::string("unknown SQLite error");
}

// SQLite reports "attempt to write a readonly database" as a message, not as a
// distinct primary code, so the readonly refusal is recognised by its extended
// result code and answered with a code a caller can branch on.
json::Value sqlFailure(sqlite3* db, const std::string& what) {
  int code = sqlite3_extended_errcode(db);
  if ((code & 0xFF) == SQLITE_READONLY) {
    return fail("readonly", "this store was opened read-only");
  }
  return fail("sql_failed", what + ": " + sqliteMessage(db));
}

bool execSql(sqlite3* db, const std::string& sql, json::Value* error) {
  char* message = nullptr;
  if (sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &message) == SQLITE_OK) {
    sqlite3_free(message);
    return true;
  }
  std::string why = message ? message : sqliteMessage(db);
  sqlite3_free(message);
  int code = sqlite3_extended_errcode(db);
  *error = ((code & 0xFF) == SQLITE_READONLY)
               ? fail("readonly", "this store was opened read-only")
               : fail("sql_failed", why);
  return false;
}

// --- names -------------------------------------------------------------
//
// Identifiers cannot be parameters in SQLite, so the ones a caller supplies are
// validated instead of interpolated hopefully. Three patterns, three reasons.

bool validName(const std::string& s) {
  if (s.empty() || s.size() > 128) return false;
  for (char c : s) {
    bool okChar = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-';
    if (!okChar) return false;
  }
  return true;
}

// A savepoint name reaches SQL text (SAVEPOINT x / RELEASE x / ROLLBACK TO x),
// so it is the strictest of the three: a bare SQL identifier and nothing else.
bool validSavepoint(const std::string& s) {
  if (s.empty() || s.size() > 64) return false;
  char first = s[0];
  if (!((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first == '_')) {
    return false;
  }
  for (char c : s) {
    bool okChar = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '_';
    if (!okChar) return false;
  }
  return true;
}

// A label becomes a FILENAME, so it excludes everything a path separator or a
// traversal could be built from. "../../../etc/passwd" fails this, which is the
// point: export hands its result to the page surface.
bool validLabel(const std::string& s) {
  if (s.empty() || s.size() > 128) return false;
  for (char c : s) {
    bool okChar = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-';
    if (!okChar) return false;
  }
  return s != "." && s != "..";
}

// --- the declared value order -----------------------------------------
//
// Across types, values order by KIND first: null < bool < number < string <
// array < object. Within a kind they order naturally, and compound values order
// by their canonical JSON dump - which is stable because object keys are sorted.
// The rule is arbitrary in the way every total order is arbitrary; what matters
// is that it is WRITTEN DOWN, so three implementations can agree instead of
// three host languages disagreeing quietly.

int rankOf(const json::Value& v) {
  switch (v.type()) {
    case json::Value::Type::Null: return 0;
    case json::Value::Type::Bool: return 1;
    case json::Value::Type::Number: return 2;
    case json::Value::Type::String: return 3;
    case json::Value::Type::Array: return 4;
    case json::Value::Type::Object: return 5;
  }
  return 0;
}

int compareValues(const json::Value& a, const json::Value& b) {
  int ra = rankOf(a), rb = rankOf(b);
  if (ra != rb) return ra < rb ? -1 : 1;
  switch (a.type()) {
    case json::Value::Type::Null: return 0;
    case json::Value::Type::Bool: {
      bool x = a.asBool(), y = b.asBool();
      return x == y ? 0 : (x ? 1 : -1);
    }
    case json::Value::Type::Number: {
      double x = a.asNumber(), y = b.asNumber();
      return x == y ? 0 : (x < y ? -1 : 1);
    }
    case json::Value::Type::String: {
      int c = a.asString().compare(b.asString());
      return c == 0 ? 0 : (c < 0 ? -1 : 1);
    }
    default: {
      int c = a.dump().compare(b.dump());
      return c == 0 ? 0 : (c < 0 ? -1 : 1);
    }
  }
}

// `contains` is a text predicate, so its operands are rendered as text: a
// string is itself, a number and a boolean are their JSON forms, absent is the
// empty string. A compound value renders as its JSON, which makes
// `contains` over an array a substring test on its serialisation - honest, and
// documented rather than accidental.
std::string asText(const json::Value& v) {
  if (v.isNull()) return std::string();
  if (v.isString()) return v.asString();
  return v.dump();
}

bool matchesCondition(const json::Value& actual, const std::string& op,
                      const json::Value& operand, json::Value* error) {
  if (op == "eq") return compareValues(actual, operand) == 0;
  if (op == "ne") return compareValues(actual, operand) != 0;
  if (op == "gt") return compareValues(actual, operand) > 0;
  if (op == "gte") return compareValues(actual, operand) >= 0;
  if (op == "lt") return compareValues(actual, operand) < 0;
  if (op == "lte") return compareValues(actual, operand) <= 0;
  if (op == "contains") return asText(actual).find(asText(operand)) != std::string::npos;
  json::Value data = json::Value::obj();
  data.set("op", op);
  *error = fail("unknown_operator", "no such query operator: " + op, data);
  return false;
}

// --- vectors -----------------------------------------------------------
//
// Everything from here to the matching #endif exists only for the index.*
// actions, so it is compiled only when the backend that serves them is. A
// build without sqlite-vec answers typed absence on those actions and carries
// none of this code - which is the difference between a real build option and
// a decorative one.

#if DESPIA_LOCAL_HAS_VEC
bool readVector(const json::Value& v, std::vector<float>* out, json::Value* error) {
  if (!v.isArray()) {
    *error = fail("invalid_vector", "a vector is an array of numbers");
    return false;
  }
  out->clear();
  out->reserve(v.asArray().size());
  for (const json::Value& element : v.asArray()) {
    if (!element.isNumber()) {
      *error = fail("invalid_vector", "a vector is an array of numbers");
      return false;
    }
    out->push_back(static_cast<float>(element.asNumber()));
  }
  return true;
}
#endif  // DESPIA_LOCAL_HAS_VEC

}  // namespace

// --- Embedding ---------------------------------------------------------

bool Embedding::parse(const json::Value& v, Embedding* out, json::Value* error) {
  if (!v.isObject() || !v["model"].isString() || !v["dimension"].isNumber()) {
    *error = fail("invalid_embedding",
                  "an embedding carries a model, a dimension and an optional revision");
    return false;
  }
  out->model = v["model"].asString();
  out->dimension = v["dimension"].asInt();
  if (out->dimension <= 0 || out->dimension > 8192) {
    json::Value data = json::Value::obj();
    data.set("dimension", static_cast<double>(out->dimension));
    *error = fail("invalid_embedding", "a dimension is between 1 and 8192", data);
    return false;
  }
  out->hasRevision = v["revision"].isString();
  out->revision = out->hasRevision ? v["revision"].asString() : std::string();
  return true;
}

json::Value Embedding::toJson() const {
  json::Value v = json::Value::obj();
  v.set("model", model);
  v.set("dimension", static_cast<double>(dimension));
  if (hasRevision) v.set("revision", revision);
  return v;
}

namespace {

#if DESPIA_LOCAL_HAS_VEC
// Three distinct reasons, because the fix differs for each. A model mismatch at
// the same width is the dangerous one: without the model id the search would
// return confident nonsense at full confidence.
bool sameEmbedding(const std::string& index, const Embedding& stored,
                   const Embedding& query, json::Value* error) {
  json::Value data = json::Value::obj();
  data.set("reindex", index);
  if (stored.dimension != query.dimension) {
    data.set("reason", "dimension");
    data.set("stored", static_cast<double>(stored.dimension));
    data.set("query", static_cast<double>(query.dimension));
    *error = fail("embedding_mismatch", "the query embedding has a different dimension", data);
    return false;
  }
  if (stored.model != query.model) {
    data.set("reason", "model");
    data.set("stored", stored.model);
    data.set("query", query.model);
    *error = fail("embedding_mismatch", "the query embedding comes from a different model", data);
    return false;
  }
  if (stored.hasRevision != query.hasRevision || stored.revision != query.revision) {
    data.set("reason", "revision");
    if (stored.hasRevision) data.set("stored", stored.revision);
    if (query.hasRevision) data.set("query", query.revision);
    *error = fail("embedding_mismatch", "the query embedding is a different revision", data);
    return false;
  }
  return true;
}
#endif  // DESPIA_LOCAL_HAS_VEC

}  // namespace

// --- capabilities ------------------------------------------------------

static const char* const kActions[] = {
    "declare",   "put",         "get",        "delete",       "query",
    "stats",     "savepoint",   "release",    "rollback",     "snapshot",
    "snapshots", "restore",     "export",     "index.upsert", "index.info",
    "index.search", "index.delete", "index.reindex",
};

const char* const* actionNames(int* count) {
  if (count) *count = static_cast<int>(sizeof(kActions) / sizeof(kActions[0]));
  return kActions;
}

json::Value capabilities() {
  json::Value caps = json::Value::obj();
  caps.set("schema_version", kSchemaVersion);
  caps.set("abi", static_cast<double>(kAbiVersion));

  json::Value sqlite = json::Value::obj();
  sqlite.set("version", sqlite3_libversion());
  sqlite.set("source_id", sqlite3_sourceid());
  caps.set("sqlite", sqlite);

#if DESPIA_LOCAL_HAS_VEC
  // Present because this build carries it. A build without sqlite-vec OMITS the
  // key rather than reporting an empty one: absent is a fact a host can act on,
  // empty is a shape that invites a host to try anyway.
  json::Value vectors = json::Value::obj();
  vectors.set("backend", "sqlite-vec");
  vectors.set("version", SQLITE_VEC_VERSION);
  json::Value metrics = json::Value::arr();
  metrics.push(json::Value("l2"));
  metrics.push(json::Value("cosine"));
  metrics.push(json::Value("l1"));
  vectors.set("metrics", metrics);
  json::Value elements = json::Value::arr();
  elements.push(json::Value("float32"));
  vectors.set("element_types", elements);
  caps.set("vectors", vectors);
#endif

  json::Value features = json::Value::arr();
  features.push(json::Value("savepoints"));
  features.push(json::Value("snapshots"));
  features.push(json::Value("restore"));
  features.push(json::Value("export"));
  features.push(json::Value("wal"));
#ifdef SQLITE_ENABLE_FTS5
  features.push(json::Value("fts5"));
#endif
#if DESPIA_LOCAL_HAS_VEC
  features.push(json::Value("vectors"));
#endif
  caps.set("features", features);

  int count = 0;
  const char* const* names = actionNames(&count);
  json::Value actions = json::Value::arr();
  for (int i = 0; i < count; ++i) actions.push(json::Value(names[i]));
  caps.set("actions", actions);

  json::Value limits = json::Value::obj();
  limits.set("max_dimension", 8192);
  limits.set("max_name_length", 128);
  caps.set("limits", limits);
  return caps;
}

// --- lifecycle ---------------------------------------------------------

void Store::setLastError(const json::Value& err) { lastError_ = err.dump(); }

void Store::setLastError(const std::string& code, const std::string& message) {
  setLastError(fail(code, message));
}

Store* Store::open(const json::Value& config, json::Value* error) {
  if (!config["directory"].isString() || config["directory"].asString().empty()) {
    *error = fail("invalid_config", "open requires a directory");
    return nullptr;
  }
  Store* store = new Store();
  store->directory_ = config["directory"].asString();
  store->readonly_ = config["readonly"].asBool(false);
  store->file_ = (fs::path(store->directory_) / "base.db").string();

  std::error_code ec;
  fs::create_directories(fs::path(store->directory_) / "snapshots", ec);
  if (ec && !store->readonly_) {
    *error = fail("open_failed", "could not create the store directory: " + ec.message());
    delete store;
    return nullptr;
  }
  if (store->openConnection(error) != 0) {
    delete store;
    return nullptr;
  }
  return store;
}

int Store::openConnection(json::Value* error) {
  int flags = readonly_ ? SQLITE_OPEN_READONLY
                        : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
  if (sqlite3_open_v2(file_.c_str(), &db_, flags, nullptr) != SQLITE_OK) {
    *error = fail("open_failed", db_ ? sqliteMessage(db_) : "could not open the database");
    sqlite3_close(db_);
    db_ = nullptr;
    return -1;
  }
  // A blocked write waits rather than failing instantly: two handles on one file
  // is the normal shape (the module's queue and a background job), and WAL means
  // the wait is short.
  sqlite3_busy_timeout(db_, 5000);

#if DESPIA_LOCAL_HAS_VEC
  // Registered per connection by an EXPLICIT call. Never through
  // sqlite3_auto_extension: that is a process-global hook that would reach into
  // every SQLite connection in the process, including a sync vendor's, which is
  // exactly the coexistence failure hidden visibility exists to prevent.
  char* vecError = nullptr;
  if (sqlite3_vec_init(db_, &vecError, nullptr) != SQLITE_OK) {
    std::string why = vecError ? vecError : "sqlite-vec could not be registered";
    sqlite3_free(vecError);
    *error = fail("open_failed", why);
    sqlite3_close(db_);
    db_ = nullptr;
    return -1;
  }
  sqlite3_free(vecError);
#endif

  if (readonly_) return 0;

  json::Value ignored;
  // WAL keeps a reader from blocking the writer, which is what lets a concurrent
  // app write proceed while an agent's approval is pending.
  if (!execSql(db_, "PRAGMA journal_mode = WAL", &ignored)) {
    *error = ignored;
    closeConnection();
    return -1;
  }
  static const char* kSchema =
      "CREATE TABLE IF NOT EXISTS _stores (name TEXT PRIMARY KEY);"
      "CREATE TABLE IF NOT EXISTS _rows ("
      "  store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,"
      "  PRIMARY KEY (store, key));"
      "CREATE TABLE IF NOT EXISTS _index_meta ("
      "  idx TEXT PRIMARY KEY, tbl TEXT, model TEXT NOT NULL,"
      "  dimension INTEGER NOT NULL, revision TEXT);"
      "CREATE TABLE IF NOT EXISTS _vector_values ("
      "  idx TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,"
      "  PRIMARY KEY (idx, key));";
  if (!execSql(db_, kSchema, &ignored)) {
    *error = ignored;
    closeConnection();
    return -1;
  }
  return 0;
}

void Store::closeConnection() {
  // close_v2 rather than close: it releases the connection even when a statement
  // somewhere was not finalised, instead of leaving the handle - and every
  // statement here is RAII, so this is belt beside braces rather than a licence
  // to leak.
  sqlite3_close_v2(db_);
  db_ = nullptr;
}

Store::~Store() { closeConnection(); }

int Store::reopen(json::Value* error) {
  closeConnection();
  return openConnection(error);
}

// --- dispatch ----------------------------------------------------------

namespace {

bool requireStore(sqlite3* db, const std::string& name, json::Value* error) {
  Stmt stmt(db, "SELECT 1 FROM _stores WHERE name = ?");
  if (!stmt.ok()) { *error = sqlFailure(db, "could not check the store"); return false; }
  stmt.bindText(1, name);
  if (stmt.row()) return true;
  json::Value data = json::Value::obj();
  data.set("store", name);
  *error = fail("unknown_store", "no store named " + name, data);
  return false;
}

int64_t countRows(sqlite3* db, const std::string& store) {
  Stmt stmt(db, "SELECT COUNT(*) FROM _rows WHERE store = ?");
  if (!stmt.ok()) return 0;
  stmt.bindText(1, store);
  return stmt.row() ? stmt.integer(0) : 0;
}

#if DESPIA_LOCAL_HAS_VEC
struct IndexMeta {
  bool exists = false;
  std::string table;
  Embedding embedding;
};

bool readIndexMeta(sqlite3* db, const std::string& index, IndexMeta* out, json::Value* error) {
  Stmt stmt(db, "SELECT tbl, model, dimension, revision FROM _index_meta WHERE idx = ?");
  if (!stmt.ok()) { *error = sqlFailure(db, "could not read the index"); return false; }
  stmt.bindText(1, index);
  if (!stmt.row()) { out->exists = false; return true; }
  out->exists = true;
  out->table = stmt.text(0);
  out->embedding.model = stmt.text(1);
  out->embedding.dimension = stmt.integer(2);
  out->embedding.hasRevision = !stmt.isNull(3);
  out->embedding.revision = out->embedding.hasRevision ? stmt.text(3) : std::string();
  return true;
}

// The PHYSICAL table name is generated here, never taken from the caller. An
// index is named by the app ("docs", "notes.v2", whatever a RAG pipeline wants)
// and that name is DATA in _index_meta; what reaches SQL text is vec_<n>. That
// is what lets index names be liberal without letting a name reach a CREATE
// statement.
std::string physicalName(int64_t n) { return "vec_" + std::to_string(n); }

bool createIndex(sqlite3* db, const std::string& index, const Embedding& embedding,
                 IndexMeta* out, json::Value* error) {
  int64_t serial = 0;
  {
    Stmt stmt(db, "SELECT IFNULL(MAX(rowid), 0) + 1 FROM _index_meta");
    if (!stmt.ok() || !stmt.row()) {
      *error = sqlFailure(db, "could not allocate the index");
      return false;
    }
    serial = stmt.integer(0);
  }
  std::string table = physicalName(serial);

  {
    Stmt stmt(db,
              "INSERT INTO _index_meta (idx, tbl, model, dimension, revision) "
              "VALUES (?, ?, ?, ?, ?)");
    if (!stmt.ok()) { *error = sqlFailure(db, "could not record the index"); return false; }
    stmt.bindText(1, index);
    stmt.bindText(2, table);
    stmt.bindText(3, embedding.model);
    stmt.bindInt(4, embedding.dimension);
    if (embedding.hasRevision) stmt.bindText(5, embedding.revision); else stmt.bindNull(5);
    if (!stmt.done()) { *error = sqlFailure(db, "could not record the index"); return false; }
  }

  std::string ddl = "CREATE VIRTUAL TABLE IF NOT EXISTS \"" + table +
                    "\" USING vec0(entry_key TEXT PRIMARY KEY, embedding float[" +
                    std::to_string(embedding.dimension) + "])";
  if (!execSql(db, ddl, error)) return false;

  out->exists = true;
  out->table = table;
  out->embedding = embedding;
  return true;
}

bool dropIndex(sqlite3* db, const IndexMeta& meta, const std::string& index,
               json::Value* error) {
  if (!meta.table.empty()) {
    // vec0's xDestroy removes its shadow tables, so dropping the virtual table
    // is enough - there is nothing left behind to sweep up by hand.
    if (!execSql(db, "DROP TABLE IF EXISTS \"" + meta.table + "\"", error)) return false;
  }
  {
    Stmt stmt(db, "DELETE FROM _vector_values WHERE idx = ?");
    if (!stmt.ok()) { *error = sqlFailure(db, "could not clear the index"); return false; }
    stmt.bindText(1, index);
    if (!stmt.done()) { *error = sqlFailure(db, "could not clear the index"); return false; }
  }
  {
    Stmt stmt(db, "DELETE FROM _index_meta WHERE idx = ?");
    if (!stmt.ok()) { *error = sqlFailure(db, "could not clear the index"); return false; }
    stmt.bindText(1, index);
    if (!stmt.done()) { *error = sqlFailure(db, "could not clear the index"); return false; }
  }
  return true;
}

bool writeVector(sqlite3* db, const IndexMeta& meta, const std::string& index,
                 const std::string& key, const std::vector<float>& vector,
                 const json::Value& value, json::Value* error) {
  {
    Stmt stmt(db, "DELETE FROM \"" + meta.table + "\" WHERE entry_key = ?");
    if (!stmt.ok()) { *error = sqlFailure(db, "could not replace the vector"); return false; }
    stmt.bindText(1, key);
    if (!stmt.done()) { *error = sqlFailure(db, "could not replace the vector"); return false; }
  }
  {
    Stmt stmt(db, "INSERT INTO \"" + meta.table + "\"(entry_key, embedding) VALUES (?, ?)");
    if (!stmt.ok()) { *error = sqlFailure(db, "could not write the vector"); return false; }
    stmt.bindText(1, key);
    stmt.bindBlob(2, vector.data(), vector.size() * sizeof(float));
    if (!stmt.done()) { *error = sqlFailure(db, "could not write the vector"); return false; }
  }
  {
    Stmt stmt(db,
              "INSERT INTO _vector_values (idx, key, value) VALUES (?, ?, ?) "
              "ON CONFLICT(idx, key) DO UPDATE SET value = excluded.value");
    if (!stmt.ok()) { *error = sqlFailure(db, "could not write the payload"); return false; }
    stmt.bindText(1, index);
    stmt.bindText(2, key);
    stmt.bindText(3, value.isNull() ? std::string("{}") : value.dump());
    if (!stmt.done()) { *error = sqlFailure(db, "could not write the payload"); return false; }
  }
  return true;
}
#endif  // DESPIA_LOCAL_HAS_VEC

#if !DESPIA_LOCAL_HAS_VEC
// The typed absence a build without sqlite-vec answers on every index.* action.
// Guarded to match its only caller: with the backend ON this function has no
// use, and an unused one is a -Wunused-function warning in the build that
// matters most - which is how a real warning ends up unread.
json::Value absentVectors() {
  return fail("vectors_unavailable",
              "this build of Despia Local was compiled without sqlite-vec");
}
#endif

}  // namespace

bool Store::call(const std::string& action, const json::Value& args,
                 json::Value* result, json::Value* error) {
  *result = json::Value::obj();
  if (!db_) {
    *error = fail("closed", "this handle has no open database");
    return false;
  }

  // --- rows ------------------------------------------------------------

  if (action == "declare") {
    const std::string name = args["store"].asString();
    if (!validName(name)) {
      *error = fail("invalid_store", "a store name is letters, digits, dot, dash or underscore");
      return false;
    }
    Stmt stmt(db_, "INSERT OR IGNORE INTO _stores (name) VALUES (?)");
    if (!stmt.ok()) { *error = sqlFailure(db_, "could not declare the store"); return false; }
    stmt.bindText(1, name);
    if (!stmt.done()) { *error = sqlFailure(db_, "could not declare the store"); return false; }
    result->set("ok", true);
    return true;
  }

  if (action == "put") {
    const std::string store = args["store"].asString();
    if (!requireStore(db_, store, error)) return false;
    Stmt stmt(db_,
              "INSERT INTO _rows (store, key, value) VALUES (?, ?, ?) "
              "ON CONFLICT(store, key) DO UPDATE SET value = excluded.value");
    if (!stmt.ok()) { *error = sqlFailure(db_, "could not write the row"); return false; }
    stmt.bindText(1, store);
    stmt.bindText(2, args["key"].asString());
    stmt.bindText(3, args["value"].isNull() ? std::string("{}") : args["value"].dump());
    if (!stmt.done()) { *error = sqlFailure(db_, "could not write the row"); return false; }
    result->set("ok", true);
    return true;
  }

  if (action == "get") {
    const std::string store = args["store"].asString();
    if (!requireStore(db_, store, error)) return false;
    Stmt stmt(db_, "SELECT value FROM _rows WHERE store = ? AND key = ?");
    if (!stmt.ok()) { *error = sqlFailure(db_, "could not read the row"); return false; }
    stmt.bindText(1, store);
    stmt.bindText(2, args["key"].asString());
    // A miss is null, not an error: asking for something that is not there is an
    // ordinary thing for a caller to do.
    if (!stmt.row()) { result->set("value", json::Value()); return true; }
    result->set("value", json::parse(stmt.text(0)));
    return true;
  }

  if (action == "delete") {
    const std::string store = args["store"].asString();
    if (!requireStore(db_, store, error)) return false;
    Stmt stmt(db_, "DELETE FROM _rows WHERE store = ? AND key = ?");
    if (!stmt.ok()) { *error = sqlFailure(db_, "could not delete the row"); return false; }
    stmt.bindText(1, store);
    stmt.bindText(2, args["key"].asString());
    if (!stmt.done()) { *error = sqlFailure(db_, "could not delete the row"); return false; }
    // A delete of nothing reports zero rather than pretending.
    result->set("deleted", static_cast<double>(sqlite3_changes(db_)));
    return true;
  }

  if (action == "query") {
    const std::string store = args["store"].asString();
    if (!requireStore(db_, store, error)) return false;

    struct Row { std::string key; json::Value value; };
    std::vector<Row> rows;
    {
      Stmt stmt(db_, "SELECT key, value FROM _rows WHERE store = ? ORDER BY key");
      if (!stmt.ok()) { *error = sqlFailure(db_, "could not query the store"); return false; }
      stmt.bindText(1, store);
      while (stmt.step() == SQLITE_ROW) {
        rows.push_back(Row{stmt.text(0), json::parse(stmt.text(1))});
      }
    }

    for (const auto& field : args["where"].asObject()) {
      for (const auto& condition : field.second.asObject()) {
        json::Value opError;
        bool broke = false;
        std::vector<Row> kept;
        for (const Row& row : rows) {
          if (broke) break;
          if (matchesCondition(row.value[field.first], condition.first, condition.second,
                               &opError)) {
            kept.push_back(row);
          } else if (!opError.isNull()) {
            broke = true;
          }
        }
        if (!opError.isNull()) { *error = opError; return false; }
        rows.swap(kept);
      }
    }

    // Applied in reverse with a STABLE sort, so the first clause is the primary
    // key and equal rows keep the key order they arrived in.
    const json::Array& order = args["order"].asArray();
    for (auto clause = order.rbegin(); clause != order.rend(); ++clause) {
      const std::string field = (*clause)["field"].asString();
      const int sign = (*clause)["dir"].asString("asc") == "desc" ? -1 : 1;
      std::stable_sort(rows.begin(), rows.end(), [&](const Row& a, const Row& b) {
        return compareValues(a.value[field], b.value[field]) * sign < 0;
      });
    }

    const int64_t limit = args["limit"].asInt(0);
    json::Value out = json::Value::arr();
    for (const Row& row : rows) {
      if (limit > 0 && static_cast<int64_t>(out.size()) >= limit) break;
      json::Value entry = json::Value::obj();
      entry.set("key", row.key);
      entry.set("value", row.value);
      out.push(entry);
    }
    result->set("rows", out);
    return true;
  }

  if (action == "stats") {
    json::Value stores = json::Value::arr();
    {
      Stmt stmt(db_, "SELECT name FROM _stores ORDER BY name");
      if (!stmt.ok()) { *error = sqlFailure(db_, "could not read the stores"); return false; }
      while (stmt.step() == SQLITE_ROW) {
        const std::string name = stmt.text(0);
        json::Value entry = json::Value::obj();
        entry.set("name", name);
        entry.set("rows", static_cast<double>(countRows(db_, name)));
        stores.push(entry);
      }
    }
    result->set("stores", stores);

    json::Value indexes = json::Value::arr();
    {
      Stmt stmt(db_, "SELECT idx, model, dimension, revision FROM _index_meta ORDER BY idx");
      if (stmt.ok()) {
        while (stmt.step() == SQLITE_ROW) {
          Embedding embedding;
          embedding.model = stmt.text(1);
          embedding.dimension = stmt.integer(2);
          embedding.hasRevision = !stmt.isNull(3);
          embedding.revision = embedding.hasRevision ? stmt.text(3) : std::string();
          json::Value entry = json::Value::obj();
          entry.set("name", stmt.text(0));
          entry.set("embedding", embedding.toJson());
          indexes.push(entry);
        }
      }
    }
    result->set("indexes", indexes);

    // Storage accounting is part of the data plane, not an afterthought bolted
    // on for the model catalog: the same summary answers "what is this app
    // using" for rows and for weights.
    int64_t pages = 0, pageSize = 0;
    { Stmt s(db_, "PRAGMA page_count"); if (s.ok() && s.row()) pages = s.integer(0); }
    { Stmt s(db_, "PRAGMA page_size"); if (s.ok() && s.row()) pageSize = s.integer(0); }
    result->set("bytes", static_cast<double>(pages * pageSize));
    return true;
  }

  // --- savepoints ------------------------------------------------------

  if (action == "savepoint" || action == "release" || action == "rollback") {
    const std::string name = args["name"].asString();
    if (!validSavepoint(name)) {
      *error = fail("invalid_savepoint", "not a valid savepoint name: " + name);
      return false;
    }
    if (action == "savepoint") {
      if (!execSql(db_, "SAVEPOINT " + name, error)) return false;
    } else if (action == "release") {
      if (!execSql(db_, "RELEASE " + name, error)) return false;
    } else {
      // ROLLBACK TO leaves the savepoint in place; releasing it too is what makes
      // the scope actually end, which is what a caller means by "roll back".
      if (!execSql(db_, "ROLLBACK TO " + name, error)) return false;
      if (!execSql(db_, "RELEASE " + name, error)) return false;
    }
    result->set("ok", true);
    return true;
  }

  // --- snapshots -------------------------------------------------------

  if (action == "snapshot" || action == "restore" || action == "export") {
    const std::string label = args["label"].asString();
    if (!validLabel(label)) {
      *error = fail("invalid_label",
                    "a snapshot label is letters, digits, dot, dash or underscore");
      return false;
    }
    const fs::path path = fs::path(directory_) / "snapshots" / (label + ".db");
    const std::string url = "file:///snapshots/" + label + ".db";
    std::error_code ec;

    if (action == "snapshot") {
      fs::remove(path, ec);
      // VACUUM INTO writes a fresh, compact copy: a durable point-in-time backup
      // that writes after it cannot reach. That is what makes "there is always a
      // backup from before the agent touched anything" a fact and not a hope.
      std::string target = path.string();
      std::string escaped;
      for (char c : target) { escaped.push_back(c); if (c == '\'') escaped.push_back('\''); }
      if (!execSql(db_, "VACUUM INTO '" + escaped + "'", error)) return false;
      result->set("ok", true);
      result->set("label", label);
      result->set("url", url);
      return true;
    }

    if (!fs::exists(path)) {
      json::Value data = json::Value::obj();
      data.set("label", label);
      *error = fail("unknown_snapshot", "no snapshot labelled " + label, data);
      return false;
    }

    if (action == "export") {
      // A REFERENCE, never bytes - the same law the AI package's audio blocks
      // obey. A multi-megabyte database inlined into a bus payload would cross
      // the bridge as base64 and cost three times its own size in memory.
      result->set("url", url);
      result->set("bytes", static_cast<double>(fs::file_size(path, ec)));
      return true;
    }

    closeConnection();
    fs::remove(fs::path(file_ + "-wal"), ec);
    fs::remove(fs::path(file_ + "-shm"), ec);
    fs::remove(fs::path(file_), ec);
    fs::copy_file(path, fs::path(file_), fs::copy_options::overwrite_existing, ec);
    if (ec) {
      json::Value reopenError;
      openConnection(&reopenError);
      *error = fail("restore_failed", "could not restore the snapshot: " + ec.message());
      return false;
    }
    if (openConnection(error) != 0) return false;
    result->set("ok", true);
    return true;
  }

  if (action == "snapshots") {
    json::Value list = json::Value::arr();
    const fs::path dir = fs::path(directory_) / "snapshots";
    std::error_code ec;
    std::vector<fs::path> entries;
    if (fs::exists(dir, ec)) {
      for (const fs::directory_entry& entry : fs::directory_iterator(dir, ec)) {
        if (entry.is_regular_file(ec) && entry.path().extension() == ".db") {
          entries.push_back(entry.path());
        }
      }
    }
    // Sorted, because a listing whose order depends on the filesystem is a
    // listing two runners disagree about.
    std::sort(entries.begin(), entries.end());
    for (const fs::path& entry : entries) {
      json::Value item = json::Value::obj();
      item.set("label", entry.stem().string());
      item.set("bytes", static_cast<double>(fs::file_size(entry, ec)));
      item.set("url", "file:///snapshots/" + entry.filename().string());
      list.push(item);
    }
    result->set("snapshots", list);
    return true;
  }

  // --- vectors ---------------------------------------------------------

  if (action.rfind("index.", 0) == 0) {
#if !DESPIA_LOCAL_HAS_VEC
    *error = absentVectors();
    return false;
#else
    const std::string index = args["index"].asString();
    if (!validName(index)) {
      *error = fail("invalid_index", "an index name is letters, digits, dot, dash or underscore");
      return false;
    }
    IndexMeta meta;
    if (!readIndexMeta(db_, index, &meta, error)) return false;

    if (action == "index.info") {
      int64_t count = 0;
      if (meta.exists) {
        Stmt stmt(db_, "SELECT COUNT(*) FROM \"" + meta.table + "\"");
        if (stmt.ok() && stmt.row()) count = stmt.integer(0);
      }
      result->set("count", static_cast<double>(count));
      if (meta.exists) result->set("embedding", meta.embedding.toJson());
      return true;
    }

    if (action == "index.delete") {
      const std::string key = args["key"].asString();
      if (meta.exists) {
        Stmt stmt(db_, "DELETE FROM \"" + meta.table + "\" WHERE entry_key = ?");
        if (!stmt.ok()) { *error = sqlFailure(db_, "could not delete the vector"); return false; }
        stmt.bindText(1, key);
        if (!stmt.done()) { *error = sqlFailure(db_, "could not delete the vector"); return false; }
      }
      Stmt payload(db_, "DELETE FROM _vector_values WHERE idx = ? AND key = ?");
      if (payload.ok()) {
        payload.bindText(1, index);
        payload.bindText(2, key);
        payload.done();
      }
      result->set("ok", true);
      return true;
    }

    if (action == "index.upsert") {
      Embedding embedding;
      if (!Embedding::parse(args["embedding"], &embedding, error)) return false;
      std::vector<float> vector;
      if (!readVector(args["vector"], &vector, error)) return false;

      if (!meta.exists) {
        if (!createIndex(db_, index, embedding, &meta, error)) return false;
      } else if (!sameEmbedding(index, meta.embedding, embedding, error)) {
        // Caught on the way IN. An index is homogeneous by construction, so the
        // corrupting write fails instead of poisoning every later search.
        return false;
      }
      if (static_cast<int64_t>(vector.size()) != embedding.dimension) {
        json::Value data = json::Value::obj();
        data.set("reason", "dimension");
        data.set("stored", static_cast<double>(embedding.dimension));
        data.set("query", static_cast<double>(vector.size()));
        data.set("reindex", index);
        *error = fail("embedding_mismatch",
                      "the vector does not match its declared dimension", data);
        return false;
      }
      if (!writeVector(db_, meta, index, args["key"].asString(), vector, args["value"], error)) {
        return false;
      }
      result->set("ok", true);
      return true;
    }

    if (action == "index.search") {
      // An index nobody has written to has nothing to say, and saying it with an
      // empty result is kinder than an error a caller would have to special-case
      // on every cold start.
      if (!meta.exists) { result->set("hits", json::Value::arr()); return true; }
      Embedding embedding;
      if (!Embedding::parse(args["embedding"], &embedding, error)) return false;
      if (!sameEmbedding(index, meta.embedding, embedding, error)) return false;
      std::vector<float> vector;
      if (!readVector(args["vector"], &vector, error)) return false;
      if (static_cast<int64_t>(vector.size()) != meta.embedding.dimension) {
        json::Value data = json::Value::obj();
        data.set("reason", "dimension");
        data.set("stored", static_cast<double>(meta.embedding.dimension));
        data.set("query", static_cast<double>(vector.size()));
        data.set("reindex", index);
        *error = fail("embedding_mismatch",
                      "the query vector does not match the index dimension", data);
        return false;
      }

      int64_t k = args["k"].asInt(0);
      if (k <= 0) {
        Stmt stmt(db_, "SELECT COUNT(*) FROM \"" + meta.table + "\"");
        k = (stmt.ok() && stmt.row()) ? stmt.integer(0) : 0;
      }
      if (k <= 0) { result->set("hits", json::Value::arr()); return true; }

      struct Hit { std::string key; double distance; };
      std::vector<Hit> hits;
      {
        // `k = ?` rather than LIMIT: both are supported by vec0, but the LIMIT
        // form needs SQLite >= 3.38 to deliver the constraint to xBestIndex, and
        // the Apple lane runs on whatever SQLite the OS shipped.
        Stmt stmt(db_, "SELECT entry_key, distance FROM \"" + meta.table +
                           "\" WHERE embedding MATCH ? AND k = ?");
        if (!stmt.ok()) { *error = sqlFailure(db_, "could not search the index"); return false; }
        stmt.bindBlob(1, vector.data(), vector.size() * sizeof(float));
        stmt.bindInt(2, k);
        while (stmt.step() == SQLITE_ROW) {
          hits.push_back(Hit{stmt.text(0), stmt.real(1)});
        }
      }
      // Nearest first, ties broken by key. vec0 already returns KNN order; the
      // explicit tie-break is what makes two lanes agree on a fixture where two
      // vectors are equidistant.
      std::stable_sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) {
        if (a.distance != b.distance) return a.distance < b.distance;
        return a.key < b.key;
      });

      json::Value out = json::Value::arr();
      for (const Hit& hit : hits) {
        json::Value entry = json::Value::obj();
        entry.set("key", hit.key);
        json::Value value = json::Value::obj();
        Stmt stmt(db_, "SELECT value FROM _vector_values WHERE idx = ? AND key = ?");
        if (stmt.ok()) {
          stmt.bindText(1, index);
          stmt.bindText(2, hit.key);
          if (stmt.row()) value = json::parse(stmt.text(0));
        }
        entry.set("value", value);
        // The distance rides along so a caller can apply its own threshold
        // instead of trusting a black box.
        entry.set("distance", hit.distance);
        out.push(entry);
      }
      result->set("hits", out);
      return true;
    }

    if (action == "index.reindex") {
      // The escape hatch an embedding_mismatch points at. The index adopts the
      // new provenance wholesale, which is the only honest way to change it:
      // vectors from the old embedder are not convertible, they are stale.
      Embedding embedding;
      if (!Embedding::parse(args["embedding"], &embedding, error)) return false;
      if (meta.exists && !dropIndex(db_, meta, index, error)) return false;
      IndexMeta fresh;
      if (!createIndex(db_, index, embedding, &fresh, error)) return false;

      int64_t written = 0;
      for (const json::Value& row : args["vectors"].asArray()) {
        std::vector<float> vector;
        if (!readVector(row["vector"], &vector, error)) return false;
        if (static_cast<int64_t>(vector.size()) != embedding.dimension) {
          json::Value data = json::Value::obj();
          data.set("reason", "dimension");
          data.set("stored", static_cast<double>(embedding.dimension));
          data.set("query", static_cast<double>(vector.size()));
          data.set("reindex", index);
          *error = fail("embedding_mismatch",
                        "a supplied vector does not match the new dimension", data);
          return false;
        }
        if (!writeVector(db_, fresh, index, row["key"].asString(), vector, row["value"], error)) {
          return false;
        }
        ++written;
      }
      result->set("ok", true);
      result->set("count", static_cast<double>(written));
      return true;
    }
#endif  // DESPIA_LOCAL_HAS_VEC
  }

  json::Value data = json::Value::obj();
  data.set("action", action);
  *error = fail("unknown_action", "no base action named " + action, data);
  return false;
}

}  // namespace base
}  // namespace despia
