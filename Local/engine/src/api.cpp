// api.cpp - the C ABI surface declared by despia_local.h.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Deliberately thin, for the same reason the AI package's api.cpp is: everything
// here is marshalling - parse the caller's JSON, hand it to the Store, turn the
// answer back into a string. There is no behaviour in this file to drift from
// what despia_local.h documents, because there is no behaviour in this file.
//
// The one thing it DOES own is the ownership asymmetry the header states: the
// pointer from despia_local_call is the caller's (malloc'd, freed with
// despia_local_free), the pointer from despia_local_last_error is the handle's.
// That asymmetry is what lets an error be readable after a call that returned
// nothing to own.

#include "../include/despia_local.h"

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>

#include "json.hpp"
#include "store.hpp"

namespace json = despia::base::json;
using despia::base::Store;

namespace {

// The last error for calls that have no handle to carry one. despia_local_open
// is the only one, but it is the one a host hits first, and "returned NULL and
// said nothing" is the worst possible first experience of an ABI.
std::mutex g_globalErrorMu;
std::string g_globalError;

void setGlobalError(const std::string& code, const std::string& message) {
  json::Value e = json::Value::obj();
  e.set("code", code);
  e.set("message", message);
  std::lock_guard<std::mutex> lock(g_globalErrorMu);
  g_globalError = e.dump();
}

char* dupString(const std::string& s) {
  char* out = static_cast<char*>(std::malloc(s.size() + 1));
  if (!out) return nullptr;
  std::memcpy(out, s.c_str(), s.size() + 1);
  return out;
}

// Parses caller JSON. An empty or null pointer means "no arguments", which is
// legal for an action that takes none (`stats`, `snapshots`); anything
// unparseable is a refusal carrying the parser's own reason, because "invalid
// JSON" without a position is a bug report nobody can act on.
bool parseInput(const char* text, json::Value* out, std::string* why) {
  if (!text || !*text) {
    *out = json::Value::obj();
    return true;
  }
  std::string err;
  json::Value v = json::parse(text, &err);
  if (!err.empty()) {
    *why = err;
    return false;
  }
  if (!v.isObject()) {
    *why = "expected a JSON object";
    return false;
  }
  *out = v;
  return true;
}

}  // namespace

extern "C" {

uint32_t despia_local_abi_version(void) { return despia::base::kAbiVersion; }

const char* despia_local_capabilities(void) {
  json::Value caps = despia::base::capabilities();
  caps.set("version", DESPIA_LOCAL_VERSION);
  // Caller-owned, freed with despia_local_free - the header says so, and a
  // static buffer here would be a data race the first time two threads asked.
  return dupString(caps.dump());
}

void despia_local_free(void* p) { std::free(p); }

void* despia_local_open(const char* config_json) {
  json::Value config;
  std::string why;
  if (!parseInput(config_json, &config, &why)) {
    setGlobalError("invalid_config", "config is not valid JSON: " + why);
    return nullptr;
  }
  json::Value error;
  Store* store = Store::open(config, &error);
  if (!store) {
    setGlobalError(error["code"].asString("invalid_config"),
                   error["message"].asString("the store could not be opened"));
    return nullptr;
  }
  return store;
}

void despia_local_close(void* handle) { delete static_cast<Store*>(handle); }

int despia_local_reopen(void* handle) {
  if (!handle) return -1;
  Store* store = static_cast<Store*>(handle);
  json::Value error;
  int rc = store->reopen(&error);
  if (rc != 0) store->setLastError(error);
  return rc;
}

char* despia_local_call(void* handle, const char* action, const char* args_json) {
  if (!handle) return nullptr;
  Store* store = static_cast<Store*>(handle);
  if (!action || !*action) {
    store->setLastError("invalid_request", "no action was named");
    return nullptr;
  }
  json::Value args;
  std::string why;
  if (!parseInput(args_json, &args, &why)) {
    store->setLastError("invalid_request", "arguments are not valid JSON: " + why);
    return nullptr;
  }
  json::Value result;
  json::Value error;
  if (!store->call(action, args, &result, &error)) {
    store->setLastError(error);
    return nullptr;
  }
  // Cleared only on success. A caller that reads last_error after a successful
  // call gets nothing rather than the previous failure, which is what makes
  // "NULL means look at last_error" a rule instead of a hint.
  store->clearLastError();
  return dupString(result.dump());
}

const char* despia_local_last_error(void* handle) {
  if (!handle) {
    std::lock_guard<std::mutex> lock(g_globalErrorMu);
    return g_globalError.empty() ? nullptr : g_globalError.c_str();
  }
  const std::string& e = static_cast<Store*>(handle)->lastErrorJson();
  return e.empty() ? nullptr : e.c_str();
}

}  // extern "C"
