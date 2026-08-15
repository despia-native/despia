// context.cpp - the engine context implementation.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.

#include "context.hpp"

#include <cstdio>
#include <fstream>
#include <set>
#include <sstream>

#include "preflight.hpp"

namespace despia {
namespace ai {
namespace {

json::Value errorValue(const std::string& code, const std::string& message) {
  json::Value e = json::Value::obj();
  e.set("code", code);
  e.set("message", message);
  return e;
}

// Typed validation at the boundary. The rule (local-ai-engine.md 4.2): unknown
// fields are ignored, a KNOWN field of the wrong type is a refusal. Forwarding
// a caller's blob verbatim into an engine is exactly what made the vendor's
// "local only" claim unenforceable, so we do not have a blob.
struct FieldSpec {
  const char* name;
  json::Value::Type type;
  bool required;
};

bool validateFields(const json::Value& v, const FieldSpec* specs, size_t count,
                    json::Value* error) {
  for (size_t i = 0; i < count; ++i) {
    const FieldSpec& s = specs[i];
    if (!v.has(s.name)) {
      if (s.required) {
        *error = errorValue("invalid_request",
                            std::string("missing required field '") + s.name + "'");
        return false;
      }
      continue;
    }
    const json::Value& f = v[s.name];
    if (f.type() != s.type) {
      *error = errorValue("invalid_request",
                          std::string("field '") + s.name + "' has the wrong type");
      return false;
    }
  }
  return true;
}

const char* kQuarantineFile = "despia-ai-quarantine.json";

std::string joinPath(const std::string& dir, const char* name) {
  if (dir.empty()) return std::string();
  if (dir.back() == '/') return dir + name;
  return dir + "/" + name;
}

}  // namespace

Context* Context::open(const json::Value& config, json::Value* error) {
  if (!config.isNull() && !config.isObject()) {
    *error = errorValue("invalid_config", "config must be a JSON object");
    return nullptr;
  }
  static const FieldSpec kSpecs[] = {
      {"schema_version", json::Value::Type::Number, false},
      {"state_dir", json::Value::Type::String, false},
      {"backends", json::Value::Type::Array, false},
      {"limits", json::Value::Type::Object, false},
  };
  if (!validateFields(config, kSpecs, sizeof(kSpecs) / sizeof(kSpecs[0]), error)) {
    return nullptr;
  }

  Context* ctx = new Context();
  ctx->stateDir_ = config["state_dir"].asString();

  // ARMING THE GOVERNOR. Without this line the residency budget is 0 in every
  // shipping configuration, which means unbounded, which means the LRU eviction
  // in governor.hpp never runs - a mechanism nobody armed. The host is the only
  // party that can see the real per-process limit, so it passes one and this is
  // where it lands. Done BEFORE the worker starts, so a refusal is a plain
  // delete rather than a thread to unwind.
  {
    std::string why;
    if (!armGovernor(ctx->governor_, config["limits"], &why)) {
      delete ctx;
      *error = errorValue("invalid_config", why);
      return nullptr;
    }
  }

  ctx->worker_ = std::thread([ctx] { ctx->workerLoop(); });
  // Captured once, before any request can exist, so syncNow can tell "already
  // on the worker" from "the caller's thread" without a lock.
  ctx->workerId_ = ctx->worker_.get_id();
  return ctx;
}

Context::~Context() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    stopping_ = true;
    for (auto& kv : inflight_) kv.second->cancelled.store(true);
    queue_.clear();
  }
  cv_.notify_all();
  // Joining here is what makes the ABI's "no callback arrives after close"
  // promise true, and it is why teardown is deterministic for a consumer.
  if (worker_.joinable()) worker_.join();
}

void Context::setLastError(const json::Value& err) { lastError_ = err.dump(); }

void Context::setLastError(const std::string& code, const std::string& message) {
  setLastError(errorValue(code, message));
}

// --- models -----------------------------------------------------------

int Context::loadModel(const json::Value& entry, json::Value* error) {
  static const FieldSpec kSpecs[] = {
      {"id", json::Value::Type::String, true},
      {"engine", json::Value::Type::String, true},
      {"format", json::Value::Type::String, false},
      {"path", json::Value::Type::String, false},
      {"context_length", json::Value::Type::Number, false},
  };
  if (!validateFields(entry, kSpecs, sizeof(kSpecs) / sizeof(kSpecs[0]), error)) {
    return -1;
  }

  const std::string id = entry["id"].asString();
  const std::string engineId = entry["engine"].asString();

  Backend* backend = Registry::shared().find(engineId);
  if (!backend) {
    // The registry-not-enum law seen from the caller's side: this build does
    // not carry that backend, which is a typed absence and not a failure.
    *error = errorValue("unsupported", "this build carries no '" + engineId + "' backend");
    error->set("engine", engineId);
    return -2;
  }

  // The pre-flight validator runs before the backend maps anything - the third
  // of D16's four locks. A file that fails here never reaches a tensor loader.
  const std::string path = entry["path"].asString();
  if (!path.empty() && entry["format"].asString() == "gguf") {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
      *error = errorValue("model_unreadable", "cannot open " + path);
      return -3;
    }
    // Read a prefix, and GROW it when the metadata table turns out to be
    // bigger than the guess. A real tokenizer vocabulary is hundreds of
    // thousands of strings - Gemma 3's runs well past 256 KiB - so a fixed
    // prefix rejects perfectly good models and blames the file for it.
    // The cap is what keeps the "never read a multi-gigabyte model to validate
    // it" promise: metadata that will not fit in 32 MiB is itself the defect.
    constexpr size_t kFirstRead = 1u << 18;   // 256 KiB clears most models
    constexpr size_t kMaxRead = 32u << 20;    // and 32 MiB clears every real one
    preflight::Result pf;
    for (size_t want = kFirstRead;; want *= 2) {
      std::vector<uint8_t> head(want);
      f.clear();
      f.seekg(0);
      f.read(reinterpret_cast<char*>(head.data()), static_cast<std::streamsize>(head.size()));
      const size_t got = static_cast<size_t>(f.gcount());
      head.resize(got);
      pf = preflight::validateGGUF(head.data(), head.size());
      if (!pf.needs_more) break;
      // The whole file was already in hand, so more bytes do not exist: the
      // metadata really is truncated and that IS a malformed file.
      if (got < want) {
        pf.code = "format_malformed";
        pf.message = "the metadata table runs past the end of the file";
        break;
      }
      if (want >= kMaxRead) {
        pf.code = "format_unsupported";
        pf.message = "the metadata table exceeds " + std::to_string(kMaxRead) + " bytes";
        break;
      }
    }
    if (!pf.ok) {
      *error = errorValue(pf.code, pf.message);
      error->set("model", id);
      return -4;
    }
  }

  // The crash marker goes down BEFORE the load. If the process dies inside the
  // backend, the next launch finds it and the host quarantines the model
  // instead of relaunching into the same crash forever.
  writeQuarantineMarker(id, "load");

  std::string backendError;
  std::unique_ptr<LoadedModel> model = backend->load(entry, &backendError);
  if (!model) {
    clearQuarantineMarker();
    *error = errorValue("load_failed", backendError.empty() ? "the backend refused the model"
                                                            : backendError);
    return -5;
  }
  model->id = id;
  model->entry = entry;

  // What this model costs the PROCESS. An mmap'd model is mapped, not resident,
  // and the fit function already refuses to count mapped_mb against the
  // per-process limit - charging it here would contradict that and evict models
  // that cost nothing. So the charge is the runtime cost the entry declares,
  // and zero when it declares none rather than a guess dressed up as a measure.
  const uint64_t charge =
      static_cast<uint64_t>(entry["runtime_mb"].asInt(0)) * 1024ull * 1024ull;

  // Least-recently-used models make room for this one. The governor decides
  // WHAT to drop; the dropping happens here, because unloading touches backend
  // state the governor knows nothing about.
  for (const std::string& victim : governor_.evictionOrder(charge, id)) {
    json::Value ignored;
    unloadModel(victim, &ignored);
  }

  {
    std::lock_guard<std::mutex> lock(mu_);
    models_[id] = std::move(model);
    modelBackend_[id] = backend;
  }
  governor_.noteLoaded(id, charge);
  clearQuarantineMarker();
  return 0;
}

int Context::unloadModel(const std::string& id, json::Value* error) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!models_.count(id)) {
    *error = errorValue("unknown_model", "no model '" + id + "' is loaded");
    return -1;
  }
  models_.erase(id);
  modelBackend_.erase(id);
  governor_.noteUnloaded(id);
  return 0;
}

// --- requests ---------------------------------------------------------

int Context::submit(const json::Value& request, void (*cb)(const char*, void*),
                    void* user, json::Value* error) {
  static const FieldSpec kSpecs[] = {
      {"schema_version", json::Value::Type::Number, false},
      {"kind", json::Value::Type::String, true},
      {"model", json::Value::Type::String, true},
      {"priority", json::Value::Type::String, false},
      {"messages", json::Value::Type::Array, false},
      {"tools", json::Value::Type::Array, false},
      {"response_format", json::Value::Type::Object, false},
      {"options", json::Value::Type::Object, false},
  };
  if (!validateFields(request, kSpecs, sizeof(kSpecs) / sizeof(kSpecs[0]), error)) {
    return -1;
  }
  if (!cb) {
    *error = errorValue("invalid_request", "a request needs an event callback");
    return -1;
  }
  const std::string priority = request["priority"].asString("interactive");
  if (priority != "interactive" && priority != "background") {
    *error = errorValue("invalid_request", "priority must be interactive or background");
    return -1;
  }

  const std::string modelId = request["model"].asString();
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (!models_.count(modelId)) {
      *error = errorValue("unknown_model", "model '" + modelId + "' is not loaded");
      return -2;
    }
  }

  auto req = std::make_shared<PendingRequest>();
  req->request = request;
  req->cb = cb;
  req->user = user;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (stopping_) {
      *error = errorValue("closing", "this context is closing");
      return -3;
    }
    req->id = nextRequestId_++;
    inflight_[req->id] = req;

    // Priority is a POSITION IN THE QUEUE, never a preemption. An interactive
    // request goes ahead of any waiting background work, but nothing already
    // running is ever killed to make room: half an answer is worse than a slow
    // one. Background requests keep FIFO order among themselves, so a queue of
    // them cannot starve its own head.
    const Priority priority = priorityFromString(request["priority"].asString(""));
    if (priority == Priority::Interactive) {
      auto at = queue_.begin();
      while (at != queue_.end() &&
             priorityFromString((*at)->request["priority"].asString("")) ==
                 Priority::Interactive) {
        ++at;
      }
      queue_.insert(at, req);
    } else {
      queue_.push_back(req);
    }
  }
  cv_.notify_one();
  return req->id;
}

int Context::cancel(int requestId) {
  // Deliberately takes only the short lock and never calls out: this is legal
  // from INSIDE the event callback, which runs on the worker thread.
  std::lock_guard<std::mutex> lock(mu_);
  auto it = inflight_.find(requestId);
  if (it == inflight_.end()) return -1;
  it->second->cancelled.store(true);
  return 0;
}

int Context::syncNow(int requestId) {
  std::shared_ptr<PendingRequest> req;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = inflight_.find(requestId);
    if (it == inflight_.end()) return -1;
    req = it->second;
  }

  // WHICH THREAD ARE WE ON. The ABI promises every event for a context arrives
  // on one engine-owned worker thread, and a consumer builds on that: it never
  // has to guard its own state against two callbacks at once. Emitting from
  // here unconditionally broke that promise for any caller that asked for a
  // resync from its own thread - which is the ordinary case, since the point of
  // a resync is a surface attaching LATE.
  //
  // It also raced: snapshot and seq are the worker's to append to, and reading
  // them from another thread while it does is a data race on a std::vector.
  if (std::this_thread::get_id() == workerId_) {
    // Already the worker: this is the legal-from-inside-the-callback path, and
    // emitting inline is both correct and the only thing that can work, since
    // the worker is us and will not service a flag until we return.
    json::Value data = json::Value::obj();
    data.set("seq", req->seq > 0 ? req->seq - 1 : 0);
    data.set("snapshot", json::Value(req->snapshot));
    emit(*req, "sync", data, false);
    return 0;
  }

  // The caller's thread: leave the request and let the worker emit it at its
  // next block. Deferred rather than dropped, and the caller gets its 0 back
  // immediately instead of blocking on a generation step.
  req->syncRequested.store(true);
  return 0;
}

void Context::workerLoop() {
  for (;;) {
    std::shared_ptr<PendingRequest> req;
    {
      std::unique_lock<std::mutex> lock(mu_);
      cv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_ && queue_.empty()) return;
      if (queue_.empty()) continue;
      req = queue_.front();
      queue_.pop_front();
    }
    serveOne(req);
    {
      std::lock_guard<std::mutex> lock(mu_);
      inflight_.erase(req->id);
    }
  }
}

void Context::emit(PendingRequest& req, const std::string& event,
                   const json::Value& data, bool final) {
  json::Value envelope = json::Value::obj();
  envelope.set("schema_version", kSchemaVersion);
  envelope.set("id", req.id);
  envelope.set("event", event);
  envelope.set("final", final);
  envelope.set("data", data);
  const std::string text = envelope.dump();
  if (req.cb) req.cb(text.c_str(), req.user);
}

void Context::serveOne(const std::shared_ptr<PendingRequest>& reqPtr) {
  PendingRequest& req = *reqPtr;
  const std::string modelId = req.request["model"].asString();

  LoadedModel* model = nullptr;
  Backend* backend = nullptr;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto m = models_.find(modelId);
    auto b = modelBackend_.find(modelId);
    if (m != models_.end() && b != modelBackend_.end()) {
      model = m->second.get();
      backend = b->second;
    }
  }
  if (!model || !backend) {
    json::Value data = errorValue("unknown_model", "model '" + modelId + "' is not loaded");
    emit(req, "error", data, true);
    return;
  }

  if (req.cancelled.load()) {
    json::Value data = json::Value::obj();
    data.set("cancelled", true);
    data.set("snapshot", json::Value(req.snapshot));
    emit(req, "complete", data, true);
    return;
  }

  bool failed = false;
  json::Value terminalExtras = json::Value::obj();
  // The marker rides generation too, not only load: a decode that takes the
  // process down is exactly as bad as a load that does.
  writeQuarantineMarker(modelId, "generate");

  Emitter out;
  out.block = [this, &req](const json::Value& block) {
    if (req.cancelled.load()) return;
    // The delta goes out alone and the snapshot stays here. This is the wire
    // economics decision made mechanical: a token event never carries the text
    // that came before it, so a long generation is linear over the bridge
    // rather than quadratic.
    // Accumulate FIRST. A consumer may ask for a resync from inside this very
    // callback, and a snapshot that is missing the token it was just handed is
    // worse than no snapshot: a late joiner would silently lose it.
    // Text and thinking coalesce into the block they extend; everything else
    // is its own block, because an image is not a continuation of an image.
    const std::string type = block["type"].asString();
    if ((type == "text" || type == "thinking") && !req.snapshot.empty() &&
        req.snapshot.back()["type"].asString() == type) {
      json::Value merged = req.snapshot.back();
      merged.set("text", merged["text"].asString() + block["text"].asString());
      req.snapshot.back() = merged;
    } else {
      req.snapshot.push_back(block);
    }
    req.seq++;
    json::Value data = json::Value::obj();
    data.set("seq", req.seq - 1);
    data.set("delta", block);
    emit(req, "token", data, false);

    // A resync asked for from the caller's thread lands HERE, on the worker,
    // after the token it was concurrent with - so the snapshot it carries is a
    // real point in the stream rather than a torn read of one.
    if (req.syncRequested.exchange(false)) {
      json::Value sync = json::Value::obj();
      sync.set("seq", req.seq - 1);
      sync.set("snapshot", json::Value(req.snapshot));
      emit(req, "sync", sync, false);
    }
  };
  out.sync = [this, &req]() {
    if (req.cancelled.load()) return;
    json::Value data = json::Value::obj();
    data.set("seq", req.seq > 0 ? req.seq - 1 : 0);
    data.set("snapshot", json::Value(req.snapshot));
    emit(req, "sync", data, false);
  };
  out.fail = [this, &req, &failed](const std::string& code, const std::string& message) {
    failed = true;
    json::Value data = errorValue(code, message);
    data.set("snapshot", json::Value(req.snapshot));
    emit(req, "error", data, true);
  };
  out.finish = [&terminalExtras](const json::Value& extras) {
    if (extras.isObject()) terminalExtras = extras;
  };
  out.cancelled = [&req]() { return req.cancelled.load(); };

  backend->serve(*model, req.request, out);
  clearQuarantineMarker();

  if (failed) return;

  json::Value data = json::Value::obj();
  for (const auto& kv : terminalExtras.asObject()) data.set(kv.first, kv.second);
  data.set("snapshot", json::Value(req.snapshot));
  if (req.cancelled.load()) data.set("cancelled", true);
  emit(req, "complete", data, true);
}

// --- the crash-quarantine marker --------------------------------------

void Context::writeQuarantineMarker(const std::string& modelId, const char* phase) {
  const std::string path = joinPath(stateDir_, kQuarantineFile);
  if (path.empty()) return;
  json::Value marker = json::Value::obj();
  marker.set("model", modelId);
  marker.set("phase", phase);
  std::ofstream f(path, std::ios::trunc);
  if (!f) return;
  f << marker.dump();
}

void Context::clearQuarantineMarker() {
  const std::string path = joinPath(stateDir_, kQuarantineFile);
  if (path.empty()) return;
  std::remove(path.c_str());
}

std::string Context::readQuarantineMarker() const {
  const std::string path = joinPath(stateDir_, kQuarantineFile);
  if (path.empty()) return std::string();
  std::ifstream f(path);
  if (!f) return std::string();
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

// --- the registry's merged manifest -----------------------------------

json::Value Registry::capabilities() const {
  json::Value caps = json::Value::obj();
  caps.set("schema_version", kSchemaVersion);
  caps.set("abi", static_cast<int>(kAbiVersion));

  json::Array engines;
  std::set<std::string> formats, modalities, dialects, features;
  json::Value limits = json::Value::obj();

  {
    std::lock_guard<std::mutex> lock(mu_);
    for (const auto& kv : backends_) {
      engines.push_back(json::Value(kv.first));
      const json::Value m = kv.second->capabilities();
      for (const auto& v : m["formats"].asArray()) formats.insert(v.asString());
      for (const auto& v : m["modalities"].asArray()) modalities.insert(v.asString());
      for (const auto& v : m["dialects"].asArray()) dialects.insert(v.asString());
      for (const auto& v : m["features"].asArray()) features.insert(v.asString());
      for (const auto& lk : m["limits"].asObject()) {
        // The tightest limit any backend declares is the build's limit: a
        // consumer that respects it is safe on every backend this build has.
        if (!limits.has(lk.first) ||
            lk.second.asNumber() < limits[lk.first].asNumber()) {
          limits.set(lk.first, lk.second);
        }
      }
    }
  }

  auto toArray = [](const std::set<std::string>& s) {
    json::Array a;
    for (const auto& v : s) a.push_back(json::Value(v));
    return json::Value(a);
  };
  caps.set("engines", json::Value(engines));
  caps.set("formats", toArray(formats));
  caps.set("modalities", toArray(modalities));
  caps.set("dialects", toArray(dialects));
  caps.set("features", toArray(features));
  caps.set("limits", limits);
  return caps;
}

}  // namespace ai
}  // namespace despia
