// api.cpp - the C ABI surface declared by despia_ai.h.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This file is deliberately thin. Everything it does is marshalling: parse the
// caller's JSON, hand it to the context, turn the answer back into a string.
// Keeping it thin is what keeps the ABI honest - there is no behaviour here to
// drift from what docs/abi.md says, because there is no behaviour here.

#include "../include/despia_ai.h"

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>

#include "backend.hpp"
#include "context.hpp"
#include "json.hpp"

using despia::ai::Context;
using despia::ai::Registry;
namespace json = despia::json;

namespace {

// The last error for calls that have no context to carry one (open failures).
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

std::once_flag g_registerOnce;

void ensureBackends() {
  std::call_once(g_registerOnce, [] { despia::ai::registerBuiltinBackends(); });
}

// Parses caller JSON. An empty or null pointer means "no arguments", which is
// legal for open(); anything unparseable is a refusal with the parser's reason.
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
  *out = v;
  return true;
}

}  // namespace

extern "C" {

uint32_t despia_ai_abi_version(void) { return despia::ai::kAbiVersion; }

const char* despia_ai_capabilities(void) {
  ensureBackends();
  json::Value caps = Registry::shared().capabilities();
  caps.set("version", DESPIA_AI_VERSION);
  return dupString(caps.dump());
}

void despia_ai_free(void* p) { std::free(p); }

void* despia_ai_open(const char* config_json) {
  ensureBackends();
  json::Value config;
  std::string why;
  if (!parseInput(config_json, &config, &why)) {
    setGlobalError("invalid_config", "config is not valid JSON: " + why);
    return nullptr;
  }
  json::Value error;
  Context* ctx = Context::open(config, &error);
  if (!ctx) {
    setGlobalError(error["code"].asString("invalid_config"),
                   error["message"].asString("the context could not be opened"));
    return nullptr;
  }
  return ctx;
}

void despia_ai_close(void* ctx) { delete static_cast<Context*>(ctx); }

int despia_ai_load_model(void* ctx, const char* model_json) {
  if (!ctx) return -1;
  Context* c = static_cast<Context*>(ctx);
  json::Value entry;
  std::string why;
  if (!parseInput(model_json, &entry, &why)) {
    c->setLastError("invalid_request", "model JSON is not valid: " + why);
    return -1;
  }
  json::Value error;
  int rc = c->loadModel(entry, &error);
  if (rc != 0) c->setLastError(error);
  return rc;
}

int despia_ai_unload_model(void* ctx, const char* model_id) {
  if (!ctx || !model_id) return -1;
  Context* c = static_cast<Context*>(ctx);
  json::Value error;
  int rc = c->unloadModel(model_id, &error);
  if (rc != 0) c->setLastError(error);
  return rc;
}

int despia_ai_request(void* ctx, const char* request_json,
                      despia_ai_event_cb cb, void* user_data) {
  if (!ctx) return -1;
  Context* c = static_cast<Context*>(ctx);
  json::Value request;
  std::string why;
  if (!parseInput(request_json, &request, &why)) {
    c->setLastError("invalid_request", "request JSON is not valid: " + why);
    return -1;
  }
  json::Value error;
  int rc = c->submit(request, cb, user_data, &error);
  if (rc < 0) c->setLastError(error);
  return rc;
}

int despia_ai_sync(void* ctx, int request_id) {
  if (!ctx) return -1;
  return static_cast<Context*>(ctx)->syncNow(request_id);
}

int despia_ai_cancel(void* ctx, int request_id) {
  if (!ctx) return -1;
  return static_cast<Context*>(ctx)->cancel(request_id);
}

const char* despia_ai_last_error(void* ctx) {
  if (!ctx) {
    std::lock_guard<std::mutex> lock(g_globalErrorMu);
    return g_globalError.empty() ? nullptr : g_globalError.c_str();
  }
  const std::string& e = static_cast<Context*>(ctx)->lastErrorJson();
  return e.empty() ? nullptr : e.c_str();
}

}  // extern "C"
