// abi_test.cpp - the C ABI's own smoke test.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This is not the conformance corpus - that runs above the seam, over
// OpenSource/Conformance/local, and pins BEHAVIOUR across the runtimes. This is
// the layer below: proof that the ABI in despia_local.h does what the header
// says, including the parts a fixture cannot see from above. Namely: that the
// capability document is self-consistent and freshly allocated, that ownership
// is the asymmetry the header describes (call's pointer is the caller's,
// last_error's is the handle's), that a failed call returns NULL and says why
// in a typed code, that a value never becomes SQL, that a savepoint really
// unwinds, that a snapshot is a real file the library can restore, that reopen
// is the real crash path rather than a simulation of one, and that a build
// without sqlite-vec answers typed absence instead of pretending.
//
// It drives the real library over the real vendored SQLite in a temporary
// directory it creates and removes. Nothing here is stubbed and no result is
// asserted from memory - every expectation below is read back out of the JSON
// the library actually returned.

#include "../include/despia_local.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

#include "../src/json.hpp"

namespace fs = std::filesystem;
namespace json = despia::base::json;

namespace {

int g_failures = 0;

void check(bool cond, const char* what) {
  if (cond) {
    std::printf("  ok   %s\n", what);
  } else {
    std::printf("  FAIL %s\n", what);
    g_failures++;
  }
}

// One call, parsed. `ok` says whether the library returned a result at all;
// on false the value carries the typed error the handle reported, so a test
// can assert on `code` without a second round of pointer handling.
struct Answer {
  bool ok = false;
  json::Value value;
};

Answer call(void* handle, const std::string& action, const std::string& args) {
  Answer out;
  char* raw = despia_local_call(handle, action.c_str(), args.c_str());
  if (raw) {
    out.ok = true;
    out.value = json::parse(std::string(raw));
    // The header says this pointer is the caller's. Freeing it here is the
    // test obeying its own contract - and running the suite under a leak
    // checker is what turns that into a proof.
    despia_local_free(raw);
    return out;
  }
  const char* err = despia_local_last_error(handle);
  // NOT freed: last_error's string is handle-owned and freeing it would be a
  // double free. The asymmetry is the point.
  if (err) out.value = json::parse(std::string(err));
  return out;
}

std::string errorCode(const Answer& a) { return a.value["code"].asString(""); }

bool arrayHas(const json::Value& array, const std::string& want) {
  for (const json::Value& v : array.asArray()) {
    if (v.isString() && v.asString() == want) return true;
  }
  return false;
}

// --- the capability document ------------------------------------------

// Read once and reused, because "what does this build carry" is a question the
// rest of the suite has to ask before it can decide what to expect - which is
// the self-description rule the header states, exercised rather than quoted.
json::Value g_caps;

void testCapabilities() {
  std::printf("capabilities\n");

  check(despia_local_abi_version() == 1, "despia_local_abi_version reports 1");

  const char* first = despia_local_capabilities();
  const char* second = despia_local_capabilities();
  check(first != nullptr && second != nullptr, "capabilities returns a document");
  // Two calls, two allocations. A static buffer here would be a data race the
  // first time two threads asked, and the header promises caller ownership.
  check(first != second, "each capabilities call is separately owned");

  std::string parseError;
  g_caps = json::parse(std::string(first ? first : ""), &parseError);
  check(parseError.empty() && g_caps.isObject(), "capabilities is a JSON object");
  check(g_caps["schema_version"].asInt(0) == 1, "capabilities carries schema_version 1");
  check(g_caps["abi"].asInt(0) == 1, "capabilities agrees with despia_local_abi_version");
  check(!g_caps["version"].asString("").empty(), "capabilities carries the package version");

  const json::Value& sqlite = g_caps["sqlite"];
  check(!sqlite["version"].asString("").empty(), "capabilities names the SQLite it runs on");
  check(!sqlite["source_id"].asString("").empty(), "capabilities carries the SQLite source id");

  const json::Value& actions = g_caps["actions"];
  check(actions.isArray() && actions.size() >= 13, "capabilities lists the action surface");
  check(arrayHas(actions, "put") && arrayHas(actions, "get") && arrayHas(actions, "query"),
        "the row actions are reported");
  check(arrayHas(actions, "snapshot") && arrayHas(actions, "restore"),
        "the snapshot actions are reported");

  // TYPED ABSENCE, checked as an equivalence rather than as a value: a build
  // without sqlite-vec omits the `vectors` key AND omits the feature, and a
  // document that did one but not the other would send a host down a path the
  // library cannot serve.
  const bool hasVectors = g_caps.has("vectors");
  check(hasVectors == arrayHas(g_caps["features"], "vectors"),
        "the vectors capability and the vectors feature agree");
  if (hasVectors) {
    check(g_caps["vectors"]["backend"].asString("") == "sqlite-vec",
          "the vector backend names itself");
    check(g_caps["vectors"]["metrics"].size() > 0, "the vector backend reports its metrics");
  }
  check(g_caps["limits"]["max_dimension"].asInt(0) > 0, "capabilities carries its limits");

  despia_local_free(const_cast<char*>(first));
  despia_local_free(const_cast<char*>(second));
  despia_local_free(nullptr);  // documented as safe on NULL
}

// --- the failure paths that have no handle ------------------------------

void testOpenRefusals() {
  std::printf("\nopen refusals\n");

  check(despia_local_open("{ this is not json") == nullptr, "malformed config is refused");
  const char* global = despia_local_last_error(nullptr);
  check(global != nullptr, "an open failure is readable with no handle to ask");
  if (global) {
    check(json::parse(std::string(global))["code"].asString("") == "invalid_config",
          "malformed config is typed invalid_config");
  }

  check(despia_local_open("{\"schema_version\":1}") == nullptr,
        "a config with no directory is refused");
  global = despia_local_last_error(nullptr);
  if (global) {
    const json::Value e = json::parse(std::string(global));
    check(e["code"].asString("") == "invalid_config", "a missing directory is typed");
    check(!e["message"].asString("").empty(), "the refusal carries a human message");
  }
}

// --- rows ---------------------------------------------------------------

void testRows(void* handle) {
  std::printf("\nrows\n");

  Answer unknown = call(handle, "no.such.action", "{}");
  check(!unknown.ok && errorCode(unknown) == "unknown_action",
        "an unknown action is a typed error, not undefined behaviour");
  check(unknown.value["data"]["action"].asString("") == "no.such.action",
        "the unknown action names itself in data");

  Answer undeclared = call(handle, "put", "{\"store\":\"ghost\",\"key\":\"a\",\"value\":{}}");
  check(!undeclared.ok && errorCode(undeclared) == "unknown_store",
        "writing to an undeclared store is refused");

  check(call(handle, "declare", "{\"store\":\"notes\"}").value["ok"].asBool(false),
        "declare creates a store");

  Answer put = call(handle, "put",
                    "{\"store\":\"notes\",\"key\":\"a\",\"value\":{\"n\":1,\"t\":\"first\"}}");
  check(put.ok && put.value["ok"].asBool(false), "put writes a row");

  Answer got = call(handle, "get", "{\"store\":\"notes\",\"key\":\"a\"}");
  check(got.ok && got.value["value"]["n"].asInt(0) == 1, "get reads the row back");

  Answer miss = call(handle, "get", "{\"store\":\"notes\",\"key\":\"nope\"}");
  check(miss.ok && miss.value.has("value") && miss.value["value"].isNull(),
        "a miss is a null value, not an error");

  // A VALUE NEVER BECOMES SQL. The payload below is a working injection against
  // any implementation that concatenates; here it is a parameter, so it comes
  // back byte for byte and the table it names is still there afterwards.
  const std::string hostile =
      "{\"store\":\"notes\",\"key\":\"drop\","
      "\"value\":{\"t\":\"'); DROP TABLE _rows; --\"}}";
  check(call(handle, "put", hostile).ok, "a hostile value is accepted as data");
  Answer back = call(handle, "get", "{\"store\":\"notes\",\"key\":\"drop\"}");
  check(back.ok && back.value["value"]["t"].asString("") == "'); DROP TABLE _rows; --",
        "a value never becomes SQL - it round-trips verbatim");
  check(call(handle, "get", "{\"store\":\"notes\",\"key\":\"a\"}").ok,
        "the store survives the hostile write");

  // An identifier is validated rather than escaped: escaping is a
  // one-mistake-from-catastrophe strategy, and a store name has no business
  // carrying a quote in the first place.
  Answer badName = call(handle, "declare", "{\"store\":\"notes\\\"; DROP TABLE _rows; --\"}");
  check(!badName.ok && errorCode(badName) == "invalid_store",
        "an identifier that could reach SQL is refused at the boundary");

  call(handle, "put", "{\"store\":\"notes\",\"key\":\"b\",\"value\":{\"n\":2,\"t\":\"second\"}}");
  call(handle, "put", "{\"store\":\"notes\",\"key\":\"c\",\"value\":{\"n\":3,\"t\":\"third\"}}");

  Answer query = call(handle, "query",
                      "{\"store\":\"notes\",\"where\":{\"n\":{\"gte\":2}},"
                      "\"order\":[{\"field\":\"n\",\"dir\":\"desc\"}],\"limit\":2}");
  check(query.ok && query.value["rows"].size() == 2, "query honours where and limit");
  check(query.value["rows"].asArray()[0]["value"]["n"].asInt(0) == 3,
        "query honours the declared order");

  Answer badOp = call(handle, "query", "{\"store\":\"notes\",\"where\":{\"n\":{\"nearly\":2}}}");
  check(!badOp.ok && errorCode(badOp) == "unknown_operator",
        "an unknown query operator is a typed refusal");

  Answer removed = call(handle, "delete", "{\"store\":\"notes\",\"key\":\"drop\"}");
  check(removed.ok && removed.value["deleted"].asInt(-1) == 1, "delete reports what it removed");
  Answer again = call(handle, "delete", "{\"store\":\"notes\",\"key\":\"drop\"}");
  check(again.ok && again.value["deleted"].asInt(-1) == 0,
        "deleting nothing reports zero rather than pretending");

  Answer stats = call(handle, "stats", "{}");
  check(stats.ok && stats.value["stores"].size() >= 1, "stats lists the declared stores");
  check(stats.value["bytes"].asInt(0) > 0, "stats accounts for the bytes on disk");
}

// --- the error contract -------------------------------------------------

void testErrorOwnership(void* handle) {
  std::printf("\nthe error contract\n");

  check(despia_local_call(handle, "still.no.such.action", "{}") == nullptr,
        "a failed call returns NULL");
  check(despia_local_last_error(handle) != nullptr,
        "the failure is readable from the handle afterwards");

  char* good = despia_local_call(handle, "stats", "{}");
  check(good != nullptr, "a successful call returns a result");
  despia_local_free(good);
  check(despia_local_last_error(handle) == nullptr,
        "a successful call clears the last error, so NULL-means-look-here is a rule");

  check(despia_local_call(handle, "", "{}") == nullptr, "an empty action name is refused");
  check(despia_local_call(handle, "get", "{not json") == nullptr,
        "unparseable arguments are refused");
  const char* err = despia_local_last_error(handle);
  check(err && json::parse(std::string(err))["code"].asString("") == "invalid_request",
        "an unparseable argument object is typed invalid_request");
}

// --- savepoints ---------------------------------------------------------

void testSavepoints(void* handle) {
  std::printf("\nsavepoints\n");

  check(call(handle, "savepoint", "{\"name\":\"scope\"}").ok, "a savepoint opens");
  call(handle, "put", "{\"store\":\"notes\",\"key\":\"tmp\",\"value\":{\"n\":9}}");
  check(!call(handle, "get", "{\"store\":\"notes\",\"key\":\"tmp\"}").value["value"].isNull(),
        "a write inside the scope is visible inside it");
  check(call(handle, "rollback", "{\"name\":\"scope\"}").ok, "the scope rolls back");
  check(call(handle, "get", "{\"store\":\"notes\",\"key\":\"tmp\"}").value["value"].isNull(),
        "the rolled-back write is gone");

  check(call(handle, "savepoint", "{\"name\":\"kept\"}").ok, "a second savepoint opens");
  call(handle, "put", "{\"store\":\"notes\",\"key\":\"kept\",\"value\":{\"n\":10}}");
  check(call(handle, "release", "{\"name\":\"kept\"}").ok, "the scope releases");
  check(!call(handle, "get", "{\"store\":\"notes\",\"key\":\"kept\"}").value["value"].isNull(),
        "a released write survives");

  Answer bad = call(handle, "savepoint", "{\"name\":\"x; DROP TABLE _rows\"}");
  check(!bad.ok && errorCode(bad) == "invalid_savepoint",
        "a savepoint name that could reach SQL is refused");
}

// --- snapshots ----------------------------------------------------------

void testSnapshots(void* handle, const fs::path& dir) {
  std::printf("\nsnapshots\n");

  Answer snap = call(handle, "snapshot", "{\"label\":\"before\"}");
  check(snap.ok && snap.value["ok"].asBool(false), "a snapshot is taken");
  check(snap.value["url"].asString("") == "file:///snapshots/before.db",
        "the snapshot url is container-relative, never an absolute path");
  std::error_code ec;
  check(fs::exists(dir / "snapshots" / "before.db", ec),
        "the snapshot is a real file on disk");

  Answer list = call(handle, "snapshots", "{}");
  check(list.ok && list.value["snapshots"].size() == 1, "the snapshot is listed");
  check(list.value["snapshots"].asArray()[0]["bytes"].asInt(0) > 0,
        "the listing carries the size");

  Answer exported = call(handle, "export", "{\"label\":\"before\"}");
  check(exported.ok && exported.value["bytes"].asInt(0) > 0,
        "export answers a reference and a size, never the bytes themselves");

  Answer missing = call(handle, "export", "{\"label\":\"never-taken\"}");
  check(!missing.ok && errorCode(missing) == "unknown_snapshot",
        "exporting a snapshot that was never taken is a typed refusal");

  // The write that must not survive the restore.
  call(handle, "put", "{\"store\":\"notes\",\"key\":\"after\",\"value\":{\"n\":99}}");
  check(!call(handle, "get", "{\"store\":\"notes\",\"key\":\"after\"}").value["value"].isNull(),
        "the post-snapshot write lands");

  check(call(handle, "restore", "{\"label\":\"before\"}").ok, "the snapshot restores");
  check(call(handle, "get", "{\"store\":\"notes\",\"key\":\"after\"}").value["value"].isNull(),
        "the post-snapshot write is gone after the restore");
  check(!call(handle, "get", "{\"store\":\"notes\",\"key\":\"a\"}").value["value"].isNull(),
        "everything from before the snapshot came back");
}

// --- the crash path -----------------------------------------------------

void testReopen(void* handle) {
  std::printf("\nreopen (the real crash path)\n");

  call(handle, "put", "{\"store\":\"notes\",\"key\":\"committed\",\"value\":{\"n\":1}}");
  check(call(handle, "savepoint", "{\"name\":\"doomed\"}").ok, "a scope is left open");
  call(handle, "put", "{\"store\":\"notes\",\"key\":\"unfinished\",\"value\":{\"n\":2}}");

  check(despia_local_reopen(handle) == 0, "reopen closes and reopens the same file");

  check(!call(handle, "get", "{\"store\":\"notes\",\"key\":\"committed\"}").value["value"].isNull(),
        "a committed write survives an abrupt process loss");
  check(call(handle, "get", "{\"store\":\"notes\",\"key\":\"unfinished\"}").value["value"].isNull(),
        "an open savepoint does not survive it");

  check(despia_local_reopen(nullptr) != 0, "reopen on no handle is an error, not a crash");
}

// --- vectors ------------------------------------------------------------

void testVectors(void* handle) {
  const bool hasVectors = g_caps.has("vectors");
  std::printf("\nvectors (%s)\n", hasVectors ? "backend present" : "typed absence");

  const std::string embedding = "\"embedding\":{\"model\":\"e5-small\",\"dimension\":4}";

  if (!hasVectors) {
    Answer absent = call(handle, "index.info", "{\"index\":\"docs\"}");
    check(!absent.ok && errorCode(absent) == "vectors_unavailable",
          "a build without sqlite-vec answers typed absence, not a crash");
    return;
  }

  check(call(handle, "index.upsert",
             "{\"index\":\"docs\",\"key\":\"one\",\"vector\":[1,0,0,0]," + embedding +
                 ",\"value\":{\"t\":\"one\"}}")
            .ok,
        "the first upsert creates the index");
  check(call(handle, "index.upsert",
             "{\"index\":\"docs\",\"key\":\"two\",\"vector\":[0,1,0,0]," + embedding +
                 ",\"value\":{\"t\":\"two\"}}")
            .ok,
        "a second vector is written");
  check(call(handle, "index.upsert",
             "{\"index\":\"docs\",\"key\":\"three\",\"vector\":[0,0,1,0]," + embedding +
                 ",\"value\":{\"t\":\"three\"}}")
            .ok,
        "a third vector is written");

  Answer info = call(handle, "index.info", "{\"index\":\"docs\"}");
  check(info.ok && info.value["count"].asInt(0) == 3, "index.info counts what was written");
  check(info.value["embedding"]["model"].asString("") == "e5-small",
        "index.info reports the provenance the vectors were written under");

  Answer hits = call(handle, "index.search",
                     "{\"index\":\"docs\",\"vector\":[0.9,0.1,0,0]," + embedding + ",\"k\":2}");
  check(hits.ok && hits.value["hits"].size() == 2, "index.search honours k");
  check(hits.value["hits"].asArray()[0]["key"].asString("") == "one",
        "index.search returns the nearest first");
  check(hits.value["hits"].asArray()[0].has("distance"),
        "a hit carries its distance so a caller can apply its own threshold");
  check(hits.value["hits"].asArray()[0]["value"]["t"].asString("") == "one",
        "a hit carries the payload written beside the vector");

  // EMBEDDING DRIFT, caught on the way in and on the way out. A different model
  // at the same width is the dangerous case: without this the search would
  // return confident nonsense.
  const std::string other = "\"embedding\":{\"model\":\"bge-small\",\"dimension\":4}";
  Answer drifted = call(handle, "index.search",
                        "{\"index\":\"docs\",\"vector\":[1,0,0,0]," + other + ",\"k\":1}");
  check(!drifted.ok && errorCode(drifted) == "embedding_mismatch",
        "searching with a different embedder is refused");
  check(drifted.value["data"]["reindex"].asString("") == "docs",
        "the refusal names the index to reindex - a path, not just a complaint");
  check(drifted.value["data"]["reason"].asString("") == "model",
        "the refusal says which of the three reasons it was");

  Answer wide = call(handle, "index.upsert",
                     "{\"index\":\"docs\",\"key\":\"bad\",\"vector\":[1,0,0]," + embedding + "}");
  check(!wide.ok && errorCode(wide) == "embedding_mismatch",
        "a vector that does not match its declared dimension is refused");

  Answer reindexed =
      call(handle, "index.reindex",
           "{\"index\":\"docs\"," + other +
               ",\"vectors\":[{\"key\":\"one\",\"vector\":[1,0,0,0],\"value\":{\"t\":\"one\"}},"
               "{\"key\":\"two\",\"vector\":[0,1,0,0],\"value\":{\"t\":\"two\"}}]}");
  check(reindexed.ok && reindexed.value["count"].asInt(0) == 2,
        "index.reindex is the escape hatch the mismatch points at");
  Answer after = call(handle, "index.search",
                      "{\"index\":\"docs\",\"vector\":[1,0,0,0]," + other + ",\"k\":1}");
  check(after.ok && after.value["hits"].size() == 1,
        "the reindexed index answers under its new provenance");

  check(call(handle, "index.delete", "{\"index\":\"docs\",\"key\":\"one\"}").ok,
        "a vector is deletable");
  Answer cold = call(handle, "index.search",
                     "{\"index\":\"cold\",\"vector\":[1,0,0,0]," + embedding + ",\"k\":1}");
  check(cold.ok && cold.value["hits"].size() == 0,
        "searching an index nobody has written to is empty, not an error");

  Answer badIndex = call(handle, "index.info", "{\"index\":\"docs\\\"; DROP TABLE _rows; --\"}");
  check(!badIndex.ok && errorCode(badIndex) == "invalid_index",
        "an index name that could reach SQL is refused at the boundary");
}

}  // namespace

int main() {
  std::printf("despia_local abi test\n\n");

  testCapabilities();
  testOpenRefusals();

  // A unique directory per run, without reaching for a POSIX pid: this test is
  // the one piece of the package that every lane compiles, including the ones
  // that are not Unix.
  std::error_code ec;
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  const fs::path dir = fs::temp_directory_path(ec) /
                       ("despia-local-abi-" + std::to_string(stamp));
  fs::remove_all(dir, ec);
  fs::create_directories(dir, ec);
  if (ec) {
    std::printf("  FAIL could not create a temporary directory: %s\n", ec.message().c_str());
    return 1;
  }

  const std::string config = "{\"schema_version\":1,\"directory\":\"" + dir.string() + "\"}";
  void* handle = despia_local_open(config.c_str());
  check(handle != nullptr, "the store opens");
  if (!handle) {
    const char* why = despia_local_last_error(nullptr);
    std::printf("  open failed: %s\n", why ? why : "(no error reported)");
    fs::remove_all(dir, ec);
    return 1;
  }

  testRows(handle);
  testErrorOwnership(handle);
  testSavepoints(handle);
  testSnapshots(handle, dir);
  testReopen(handle);
  testVectors(handle);

  despia_local_close(handle);
  despia_local_close(nullptr);  // documented as safe on NULL

  fs::remove_all(dir, ec);

  std::printf("\n%s\n", g_failures == 0 ? "all checks passed" : "FAILURES: see above");
  return g_failures == 0 ? 0 : 1;
}
