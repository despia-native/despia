// governor.hpp - who runs next, what stays resident, and how hard to push.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The ABI has carried `priority` and the `options` budget fields since day one
// as a reservation (despia_ai.h, despia_ai_request). This is the thing that
// honours them.
//
// Three jobs, and they are separate on purpose:
//
//   1. ORDERING. An interactive request - somebody is watching a cursor blink -
//      must not queue behind a background batch job. Priority is a position in
//      the queue, never a preemption: a running generation is never killed to
//      make room, because half an answer is worse than a slow one.
//
//   2. RESIDENCY. Models are big and memory is not. When loading one would
//      exceed the budget, the LEAST RECENTLY USED resident model is evicted
//      first, and the model being loaded is never a candidate. Eviction is
//      advisory here: this decides WHAT to drop, the context does the dropping,
//      because unloading touches backend state this header knows nothing about.
//
//   3. PRESSURE. Thermal and low-power state come from the host, because only
//      the platform knows them - there is no portable way to read a thermal
//      state, and guessing would be worse than asking. Under pressure the
//      governor reduces thread counts rather than refusing work: a slower
//      answer is a product decision the user can live with, a refused one is a
//      bug report.
//
// Accounting is in BYTES and counts only what is actually charged to the
// process. A model loaded with mmap is mapped, not resident, and the fit
// function already refuses to count mapped_mb against the per-process limit;
// counting it here would contradict that and evict models that cost nothing.
//
// ARMING. The budget is 0 - unbounded - until somebody sets it, and a governor
// with an unbounded budget evicts nothing. That is the correct default for a
// desktop and the wrong one for a phone, so `armGovernor` at the bottom of this
// file reads the open-config's `limits.max_runtime_bytes` and is called from
// `Context::open`. It is here, beside the mechanism it arms, rather than inside
// context.cpp, because this mechanism shipped once with `setBudget` called from
// nothing but its own test: every real configuration ran at budget 0 and the
// eviction below could not fire in any of them. A decision that lives in a .cpp
// nobody can link in isolation is a decision nobody tests.

#ifndef DESPIA_AI_GOVERNOR_HPP
#define DESPIA_AI_GOVERNOR_HPP

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "json.hpp"

namespace despia {
namespace ai {

enum class Priority {
  Interactive,  // someone is waiting on this
  Background,   // it can wait
};

inline Priority priorityFromString(const std::string& s) {
  // Unknown spellings are INTERACTIVE, not background. Getting this backwards
  // would make a typo silently deprioritise a user-facing request, and the
  // failure would look like "the app is sometimes slow" rather than like a bug.
  return s == "background" ? Priority::Background : Priority::Interactive;
}

// What the host tells us about the device. Nothing here is measured locally.
enum class Pressure {
  Nominal,   // full speed
  Elevated,  // warm, or on battery saver: ease off
  Critical,  // thermally throttled by the OS already: minimum footprint
};

inline Pressure pressureFromString(const std::string& s) {
  if (s == "critical") return Pressure::Critical;
  if (s == "elevated") return Pressure::Elevated;
  return Pressure::Nominal;
}

class Governor {
 public:
  // budgetBytes of 0 means unbounded, which is the right default for desktop
  // and the wrong one for a phone - the host sets it from the real per-process
  // limit it alone can see.
  void setBudget(uint64_t budgetBytes) {
    std::lock_guard<std::mutex> lock(mu_);
    budget_ = budgetBytes;
  }

  void setPressure(Pressure p) {
    std::lock_guard<std::mutex> lock(mu_);
    pressure_ = p;
  }

  Pressure pressure() const {
    std::lock_guard<std::mutex> lock(mu_);
    return pressure_;
  }

  // Records a resident model and its charged footprint. `bytes` is what the
  // process pays: for an mmap'd model that is the KV cache and the runtime
  // structures, not the weights on disk.
  void noteLoaded(const std::string& id, uint64_t bytes) {
    std::lock_guard<std::mutex> lock(mu_);
    Entry& e = models_[id];
    e.bytes = bytes;
    e.lastUsed = ++clock_;
  }

  void noteUsed(const std::string& id) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = models_.find(id);
    if (it != models_.end()) it->second.lastUsed = ++clock_;
  }

  void noteUnloaded(const std::string& id) {
    std::lock_guard<std::mutex> lock(mu_);
    models_.erase(id);
  }

  uint64_t residentBytes() const {
    std::lock_guard<std::mutex> lock(mu_);
    uint64_t total = 0;
    for (const auto& kv : models_) total += kv.second.bytes;
    return total;
  }

  size_t residentCount() const {
    std::lock_guard<std::mutex> lock(mu_);
    return models_.size();
  }

  // Which models to evict, least-recently-used first, to fit `incomingBytes`.
  // `keepId` is never evicted: it is the model being loaded, and dropping it to
  // make room for itself is the kind of bug that only shows up under pressure.
  //
  // Returns empty when nothing needs evicting - including when the budget is
  // unbounded, and including when evicting EVERYTHING still would not be
  // enough. That second case is deliberate: if the incoming model does not fit
  // in an empty context, throwing away every other model first accomplishes
  // nothing except losing them. The fit function refuses that load; the
  // governor does not paper over it.
  std::vector<std::string> evictionOrder(uint64_t incomingBytes,
                                         const std::string& keepId) const {
    std::lock_guard<std::mutex> lock(mu_);
    if (budget_ == 0) return {};

    // When `keepId` is ALREADY resident this is a reload, not an addition: its
    // current charge is about to be replaced by `incomingBytes`, so counting
    // both would evict other models to make room for memory that is being
    // handed back moments later.
    uint64_t resident = 0;
    for (const auto& kv : models_) {
      if (kv.first == keepId) continue;
      resident += kv.second.bytes;
    }
    if (resident + incomingBytes <= budget_) return {};

    uint64_t evictable = 0;
    std::vector<std::pair<uint64_t, std::string>> candidates;  // (lastUsed, id)
    for (const auto& kv : models_) {
      if (kv.first == keepId) continue;
      candidates.push_back({kv.second.lastUsed, kv.first});
      evictable += kv.second.bytes;
    }
    if (resident - evictable + incomingBytes > budget_) return {};

    std::sort(candidates.begin(), candidates.end());

    std::vector<std::string> out;
    uint64_t freed = 0;
    for (const auto& c : candidates) {
      if (resident - freed + incomingBytes <= budget_) break;
      auto it = models_.find(c.second);
      freed += it->second.bytes;
      out.push_back(c.second);
    }
    return out;
  }

  // Thread count for a request, from its priority and the device's state.
  // `hardwareThreads` is what the host reports; 0 falls back to a safe 4.
  //
    // Background work never gets the whole machine even when the device is cold,
  // because the point of marking something background is that it must not make
  // the foreground stutter.
  int threadsFor(Priority p, int hardwareThreads) const {
    std::lock_guard<std::mutex> lock(mu_);
    int cores = hardwareThreads > 0 ? hardwareThreads : 4;

    switch (pressure_) {
      case Pressure::Critical:
        // The OS is already throttling. Asking for more threads here buys
        // nothing and heats the device further.
        return 1;
      case Pressure::Elevated:
        cores = cores / 2;
        break;
      case Pressure::Nominal:
        break;
    }
    if (p == Priority::Background) cores = cores / 2;
    return cores < 1 ? 1 : cores;
  }

  // Whether a NEW request should wait. Nothing in flight is ever cancelled for
  // pressure; this only gates admission, and only at critical.
  bool shouldDefer(Priority p) const {
    std::lock_guard<std::mutex> lock(mu_);
    return pressure_ == Pressure::Critical && p == Priority::Background;
  }

 private:
  struct Entry {
    uint64_t bytes = 0;
    uint64_t lastUsed = 0;
  };

  mutable std::mutex mu_;
  std::map<std::string, Entry> models_;
  uint64_t budget_ = 0;
  uint64_t clock_ = 0;  // a monotonic tick, not a wall clock: ordering is all
                        // LRU needs, and a wall clock would make the eviction
                        // decision depend on how fast the machine is.
  Pressure pressure_ = Pressure::Nominal;
};

// Arms a governor from the open-config's `limits` object. Returns false only on
// a REFUSAL - a known field of the wrong shape - and then `why` says which,
// matching the boundary rule the rest of the config validation follows: unknown
// fields are ignored, a known field of the wrong type is a refusal.
//
// WHAT THE NUMBER COUNTS, which is the whole reason it is safe to compare:
// `max_runtime_bytes` is a ceiling on the SUM of the loaded models' `runtime_mb`
// (Context::loadModel, `noteLoaded`), and `runtime_mb` is the charge the entry
// declares - the KV cache, the compute buffers and the runtime structures. It is
// NOT the model's size on disk and it is NOT its mapped size: weights arrive by
// mmap as clean, file-backed pages the kernel can drop without asking, the fit
// function already refuses to count `mapped_mb` against the per-process limit,
// and a budget denominated in one quantity checked against a total in the other
// would either evict on every load or never evict at all. Both of those look
// exactly like the feature working.
//
// So the host's side of the bargain is: derive this from the same per-process
// number you would compare a footprint against, because that is the number
// `runtime_mb` is already measured in.
//
// 0 is legal and means unbounded - nothing is ever evicted for memory. It is the
// documented answer for a desktop, where the per-process ceiling is not a real
// constraint and unloading a multi-gigabyte file to reload it minutes later is
// pure loss.
inline bool armGovernor(Governor& governor, const json::Value& limits, std::string* why) {
  if (!limits.isObject()) {
    // Absent, or not an object at all. The caller has already type-checked
    // `limits` itself, so there is nothing here to refuse - only nothing to do.
    return true;
  }
  if (!limits.has("max_runtime_bytes")) return true;

  const json::Value& value = limits["max_runtime_bytes"];
  if (value.type() != json::Value::Type::Number) {
    *why = "limits.max_runtime_bytes must be a number of bytes";
    return false;
  }
  const double bytes = value.asNumber();
  // NaN and infinity arrive from a literal like 1e999 and are not budgets. A
  // negative one is not either, and silently clamping it to 0 would turn a typo
  // into an unbounded context - which is the failure this whole file exists to
  // stop being invisible.
  if (!std::isfinite(bytes) || bytes < 0) {
    *why = "limits.max_runtime_bytes must be a finite, non-negative number of bytes";
    return false;
  }
  // A value past the width of the accounting is functionally unbounded, and
  // refusing it would be pedantry: it is clamped, not rejected.
  const double kMax = static_cast<double>(std::numeric_limits<uint64_t>::max());
  governor.setBudget(bytes >= kMax ? std::numeric_limits<uint64_t>::max()
                                   : static_cast<uint64_t>(bytes));
  return true;
}

}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_GOVERNOR_HPP
