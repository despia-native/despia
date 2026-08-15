// context.hpp - an engine context: the thing behind the ABI's opaque pointer.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// A context owns one worker thread, the models loaded into it, and the
// in-flight requests. The threading contract in despia_ai.h is implemented
// here and nowhere else:
//
//   - one worker per context delivers every event, in production order;
//   - cancel is legal from inside the callback, so it takes no lock the
//     callback path holds;
//   - close joins the worker, so no callback outlives it.
//
// What this file does NOT do is as important as what it does. There is no tool
// loop here, no routing, no fit, no approval flow, no catalog: those live in
// the HOST (the module layer), because they are policy and this is mechanism.
// The engine's whole job is: validate at the boundary, pick a backend, stream
// typed blocks back, and never lie about what it can do.

#ifndef DESPIA_AI_CONTEXT_HPP
#define DESPIA_AI_CONTEXT_HPP

#include <atomic>
#include <condition_variable>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "backend.hpp"
#include "governor.hpp"
#include "json.hpp"

namespace despia {
namespace ai {

// The schema version of every envelope this build writes and reads. Unknown
// fields are must-ignore in both directions; a NEWER schema_version on input
// is accepted for the fields this build understands.
constexpr int kSchemaVersion = 1;
constexpr uint32_t kAbiVersion = 1;

struct PendingRequest {
  int id = 0;
  json::Value request;
  std::atomic<bool> cancelled{false};
  // The sink is per-request, as the ABI declares: one caller can drive several
  // requests on one context and route each one's events where it likes.
  void (*cb)(const char*, void*) = nullptr;
  void* user = nullptr;
  // Accumulated typed blocks - what `sync` and `complete` carry. The engine
  // holds the snapshot so a token event never has to.
  json::Array snapshot;
  int seq = 0;
  // A resync asked for from the CALLER's thread. The caller cannot emit it
  // itself without breaking the ABI's promise that every event for a context
  // arrives on one engine-owned thread, so it leaves this and the worker emits.
  std::atomic<bool> syncRequested{false};
};

class Context {
 public:
  // Returns null and fills `error` when the config does not validate.
  static Context* open(const json::Value& config, json::Value* error);
  ~Context();

  int loadModel(const json::Value& entry, json::Value* error);
  int unloadModel(const std::string& id, json::Value* error);

  int submit(const json::Value& request, void (*cb)(const char*, void*),
             void* user, json::Value* error);
  int cancel(int requestId);
  int syncNow(int requestId);

  const std::string& lastErrorJson() const { return lastError_; }
  void setLastError(const json::Value& err);
  void setLastError(const std::string& code, const std::string& message);

  // The quarantine marker: written before a load or a generate, cleared on
  // success. If it is still on disk at the next open, the model named in it
  // took the process down and the HOST refuses it until the user clears it.
  // The engine only keeps the marker honest; the verdict is the host's.
  std::string readQuarantineMarker() const;

 private:
  Context() = default;
  void workerLoop();
  void serveOne(const std::shared_ptr<PendingRequest>& req);
  void emit(PendingRequest& req, const std::string& event,
            const json::Value& data, bool final);
  void writeQuarantineMarker(const std::string& modelId, const char* phase);
  void clearQuarantineMarker();

  std::string stateDir_;
  std::string lastError_;

  mutable std::mutex mu_;
  std::condition_variable cv_;
  bool stopping_ = false;
  std::thread worker_;
  // Identity, not ownership: syncNow needs to know whether it is ALREADY on the
  // worker (the legal-from-inside-the-callback case, where emitting inline is
  // both correct and the only way it can work) or on the caller's thread.
  std::thread::id workerId_;

  std::deque<std::shared_ptr<PendingRequest>> queue_;
  std::map<int, std::shared_ptr<PendingRequest>> inflight_;
  int nextRequestId_ = 1;

  std::map<std::string, std::unique_ptr<LoadedModel>> models_;
  std::map<std::string, Backend*> modelBackend_;

  // Ordering, residency and pressure. Holds its own lock, so it is deliberately
  // NOT guarded by mu_ - taking both would invite a lock-order inversion the
  // first time an eviction needed to unload.
  Governor governor_;
};

}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_CONTEXT_HPP
