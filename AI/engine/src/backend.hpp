// backend.hpp - the backend seam: a REGISTRY, never an enum.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The core names no model family, no file format, no tool dialect and no
// sampler. A backend registers itself with a capability manifest and the core
// is the bus between them (local-ai-engine.md 4.2). New engine families - MLX,
// ONNX GenAI, ExecuTorch, a vendor NPU runtime - are ADDITIONS to this
// registry, never surgery on the core, and a catalog entry naming a backend
// this build does not carry answers typed absence instead of crashing.
//
// Registration is compile-time by construction: a provider child ships its
// vendored library and registers through this seam at setup. Nothing
// downloads code, on any platform. That is the dynamic-split law in one file.

#ifndef DESPIA_AI_BACKEND_HPP
#define DESPIA_AI_BACKEND_HPP

#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "json.hpp"

namespace despia {
namespace ai {

// What a backend emits while serving a request. The core turns these into ABI
// events; a backend never formats an envelope itself.
struct Emitter {
  // A typed output block delta (text, thinking, tool, json, audio, image,
  // file, embedding, or something a future backend invents - the vocabulary is
  // open and the core does not police it).
  std::function<void(const json::Value& block)> block;
  // A full-snapshot resync point the backend chose to offer.
  std::function<void()> sync;
  // Terminal failure. The core settles the request typed.
  std::function<void(const std::string& code, const std::string& message)> fail;
  // Terminal SUCCESS detail - usage counts, a finish reason, anything a backend
  // knows only when it stops. The core merges it into the `complete` event.
  // Optional: a backend that has nothing to add simply returns.
  std::function<void(const json::Value& extras)> finish;
  // True once the host has cancelled: a long generate loop polls this.
  std::function<bool()> cancelled;
};

struct LoadedModel {
  std::string id;
  json::Value entry;  // the catalog entry, verbatim
  virtual ~LoadedModel() = default;
};

class Backend {
 public:
  virtual ~Backend() = default;

  // The id a catalog entry names in its `engine` field.
  virtual std::string id() const = 0;

  // What this backend can do, merged into despia_ai_capabilities(). Keys:
  // formats[], modalities[], dialects[], features[], limits{}.
  virtual json::Value capabilities() const = 0;

  // Loads a model from its catalog entry. Returns null and sets `error` on
  // failure. The core has already run the pre-flight validator and written the
  // quarantine marker by the time this is called.
  virtual std::unique_ptr<LoadedModel> load(const json::Value& entry,
                                            std::string* error) = 0;

  // Serves one request against a loaded model. Runs on the context's worker
  // thread; the backend emits through `out` and returns when done. A backend
  // that ignores `out.cancelled()` is a backend whose requests cannot be
  // stopped, so polling it is part of this contract.
  virtual void serve(LoadedModel& model, const json::Value& request,
                     const Emitter& out) = 0;
};

// The process-wide registry. Backends register once, at static-init or at
// module setup, and the set is immutable thereafter - there is no unregister,
// because a capability that can disappear underneath a running request is a
// crash waiting for a schedule.
class Registry {
 public:
  static Registry& shared() {
    static Registry r;
    return r;
  }

  void add(std::unique_ptr<Backend> backend) {
    std::lock_guard<std::mutex> lock(mu_);
    if (!backend) return;
    const std::string key = backend->id();
    if (backends_.count(key)) return;  // first registration wins, deterministically
    backends_[key] = std::move(backend);
  }

  Backend* find(const std::string& id) const {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = backends_.find(id);
    return it == backends_.end() ? nullptr : it->second.get();
  }

  std::vector<std::string> ids() const {
    std::lock_guard<std::mutex> lock(mu_);
    std::vector<std::string> out;
    out.reserve(backends_.size());
    for (const auto& kv : backends_) out.push_back(kv.first);
    return out;
  }

  // The union of every registered backend's manifest - the payload behind
  // despia_ai_capabilities(). Consumers ADAPT to what they read here.
  json::Value capabilities() const;

 private:
  Registry() = default;
  mutable std::mutex mu_;
  std::map<std::string, std::unique_ptr<Backend>> backends_;
};

// Registers the backends this build carries. Defined once per link target so a
// build's surface is a link-time fact, greppable and reviewable, rather than a
// pile of static initialisers whose order nobody can reason about.
void registerBuiltinBackends();

}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_BACKEND_HPP
