// gguf_backend.cpp - the llama.cpp backend: the first engine that runs a model.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Registers as "gguf" and answers catalog entries whose `format` is gguf. The
// core knows none of this: it hands over an entry and a request and receives
// blocks through the Emitter, exactly as it does for the mock. That symmetry is
// the point of the registry seam - adding a real engine is an ADDITION, not
// surgery on the core.
//
// Every llama.cpp symbol here was read from vendor/llama.cpp/include/llama.h at
// the pinned commit, never recalled. That pin is not a formality: this version
// carries `load_mode` where older ones carried a `use_mmap` bool, and
// `llama_model_load_from_file` where older ones had `llama_load_model_from_file`.
// Code written from memory compiles in the author's head and fails at link.
//
// Threading: serve() runs on the context's worker thread, one request at a
// time per context, so the llama_context needs no lock of its own. What it does
// need is to poll out.cancelled() inside the decode loop - a cancel that only
// lands between requests is not a cancel, and a 500-token generation would
// otherwise ignore it for the whole run.

#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"

#include "../../backend.hpp"
#include "../../json.hpp"
#include "gbnf.hpp"
#include "utf8.hpp"

namespace despia {
namespace ai {
namespace {

// llama_backend_init() is process-global and must run exactly once before any
// model loads. std::once_flag rather than a static initialiser so the ordering
// is a fact rather than a hope.
std::once_flag g_llamaInit;

void ensureLlamaInit() {
  std::call_once(g_llamaInit, []() { llama_backend_init(); });
}

// llama.cpp logs to stderr by default, which on a phone means the host app's
// console fills with tensor chatter it did not ask for. Silence it; failures
// still reach the caller through the typed error path, which is where a host
// can actually act on them.
void quietLogger(ggml_log_level level, const char* text, void* user) {
  (void)level;
  (void)text;
  (void)user;
}

struct GgufModel : LoadedModel {
  llama_model* model = nullptr;
  llama_context* ctx = nullptr;
  const llama_vocab* vocab = nullptr;
  int32_t nCtx = 0;
  std::string chatTemplate;  // the catalog override, empty to use the model's
  json::Value samplingDefaults;  // the entry's `sampling` block, if it has one

  ~GgufModel() override {
    if (ctx) llama_free(ctx);
    if (model) llama_model_free(model);
  }
};

// Renders one token id to text. llama_token_to_piece reports the needed size as
// a negative return when the buffer is too small, so the two-call shape is the
// API's own contract rather than defensive padding.
std::string pieceOf(const llama_vocab* vocab, llama_token token) {
  char buf[256];
  int32_t n = llama_token_to_piece(vocab, token, buf, sizeof(buf), 0, false);
  if (n >= 0) return std::string(buf, static_cast<size_t>(n));
  std::vector<char> big(static_cast<size_t>(-n));
  n = llama_token_to_piece(vocab, token, big.data(),
                           static_cast<int32_t>(big.size()), 0, false);
  if (n < 0) return std::string();
  return std::string(big.data(), static_cast<size_t>(n));
}

std::vector<llama_token> tokenize(const llama_vocab* vocab,
                                  const std::string& text, bool addSpecial) {
  // Same two-call shape: ask with a guess, resize on the negative answer.
  std::vector<llama_token> out(text.size() + 16);
  int32_t n = llama_tokenize(vocab, text.c_str(),
                             static_cast<int32_t>(text.size()), out.data(),
                             static_cast<int32_t>(out.size()), addSpecial, true);
  if (n < 0) {
    out.resize(static_cast<size_t>(-n));
    n = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()),
                       out.data(), static_cast<int32_t>(out.size()), addSpecial,
                       true);
    if (n < 0) return {};
  }
  out.resize(static_cast<size_t>(n));
  return out;
}

// Builds the prompt from a request. `messages` goes through the chat template
// (the catalog's override when it declares one, otherwise the model's own from
// GGUF metadata); a bare `prompt` string is passed through untouched.
//
// A model with no template and no override is a real case, not an error: base
// models genuinely have none. Falling back to a hand-rolled "User:/Assistant:"
// shape would be a guess wearing a template's clothes, so the messages are
// joined plainly and the caller keeps whatever framing it supplied.
std::string buildPrompt(const GgufModel& m, const json::Value& request) {
  if (request["prompt"].isString()) return request["prompt"].asString();

  const json::Array& messages = request["messages"].asArray();
  if (messages.empty()) return std::string();

  std::vector<std::string> roles, contents;
  roles.reserve(messages.size());
  contents.reserve(messages.size());
  for (const auto& msg : messages) {
    roles.push_back(msg["role"].asString("user"));
    // A content array (the typed-block spelling) contributes its text parts;
    // anything binary is delivered by reference elsewhere and never inlined.
    if (msg["content"].isArray()) {
      std::string joined;
      for (const auto& part : msg["content"].asArray()) {
        if (part["type"].asString() == "text") joined += part["text"].asString();
      }
      contents.push_back(joined);
    } else {
      contents.push_back(msg["content"].asString(""));
    }
  }

  const char* tmpl = m.chatTemplate.empty()
                         ? llama_model_chat_template(m.model, nullptr)
                         : m.chatTemplate.c_str();

  if (tmpl != nullptr) {
    std::vector<llama_chat_message> chat;
    chat.reserve(messages.size());
    for (size_t i = 0; i < roles.size(); i++) {
      chat.push_back({roles[i].c_str(), contents[i].c_str()});
    }
    size_t guess = 0;
    for (const auto& c : contents) guess += c.size();
    std::vector<char> buf(guess * 2 + 1024);
    int32_t n = llama_chat_apply_template(tmpl, chat.data(), chat.size(), true,
                                          buf.data(),
                                          static_cast<int32_t>(buf.size()));
    if (n > static_cast<int32_t>(buf.size())) {
      buf.resize(static_cast<size_t>(n) + 1);
      n = llama_chat_apply_template(tmpl, chat.data(), chat.size(), true,
                                    buf.data(),
                                    static_cast<int32_t>(buf.size()));
    }
    if (n > 0) return std::string(buf.data(), static_cast<size_t>(n));
    // A template llama.cpp cannot apply falls through to the plain join rather
    // than failing the request: a usable answer beats a typed refusal here.
  }

  std::string joined;
  for (size_t i = 0; i < roles.size(); i++) {
    if (i) joined += "\n";
    joined += contents[i];
  }
  return joined;
}

// Builds the sampler chain from catalog defaults merged with request options.
// Order matters and is llama.cpp's documented one: the truncating samplers
// narrow the candidate set, temperature reshapes it, and the distribution
// sampler draws last. A grammar goes FIRST so everything after it only ever
// sees tokens the schema can accept.
llama_sampler* buildSampler(const GgufModel& m, const json::Value& request,
                            const std::string& grammar) {
  llama_sampler_chain_params sp = llama_sampler_chain_default_params();
  llama_sampler* chain = llama_sampler_chain_init(sp);

  if (!grammar.empty()) {
    llama_sampler* g = llama_sampler_init_grammar(m.vocab, grammar.c_str(), "root");
    if (g) llama_sampler_chain_add(chain, g);
  }

  // Catalog defaults underneath, request options on top: the entry declares
  // what the model wants and a caller may override per request.
  const json::Value& defaults = m.samplingDefaults;
  const json::Value& opts = request["options"];
  auto number = [&](const char* key, double fallback) {
    if (opts[key].isNumber()) return opts[key].asNumber(fallback);
    if (defaults[key].isNumber()) return defaults[key].asNumber(fallback);
    return fallback;
  };

  const double temp = number("temperature", 0.8);
  const double topK = number("top_k", 40);
  const double topP = number("top_p", 0.95);
  const double minP = number("min_p", 0.05);

  if (temp <= 0.0) {
    // Temperature zero means "the most likely token", and greedy says exactly
    // that. Running the truncating samplers first would be theatre.
    llama_sampler_chain_add(chain, llama_sampler_init_greedy());
    return chain;
  }

  const double repeatPenalty = number("repeat_penalty", 1.0);
  const double freqPenalty = number("frequency_penalty", 0.0);
  const double presPenalty = number("presence_penalty", 0.0);
  if (repeatPenalty != 1.0 || freqPenalty != 0.0 || presPenalty != 0.0) {
    llama_sampler_chain_add(
        chain, llama_sampler_init_penalties(
                   static_cast<int32_t>(number("repeat_last_n", 64)),
                   static_cast<float>(repeatPenalty),
                   static_cast<float>(freqPenalty),
                   static_cast<float>(presPenalty)));
  }

  if (topK > 0) {
    llama_sampler_chain_add(chain,
                            llama_sampler_init_top_k(static_cast<int32_t>(topK)));
  }
  if (topP < 1.0) {
    llama_sampler_chain_add(
        chain, llama_sampler_init_top_p(static_cast<float>(topP), 1));
  }
  if (minP > 0.0) {
    llama_sampler_chain_add(
        chain, llama_sampler_init_min_p(static_cast<float>(minP), 1));
  }
  llama_sampler_chain_add(chain,
                          llama_sampler_init_temp(static_cast<float>(temp)));

  // A declared seed makes a run reproducible, which is what a test wants; the
  // default draws fresh, which is what a user wants.
  const uint32_t seed = opts["seed"].isNumber()
                            ? static_cast<uint32_t>(opts["seed"].asInt(0))
                            : LLAMA_DEFAULT_SEED;
  (void)defaults;
  llama_sampler_chain_add(chain, llama_sampler_init_dist(seed));
  return chain;
}

class GgufBackend : public Backend {
 public:
  std::string id() const override { return "gguf"; }

  // Reports what this build actually compiled in, never what the code could do
  // in principle. The router filters on this, so an over-claim routes a request
  // INTO a failure instead of away from one.
  json::Value capabilities() const override {
    json::Value caps = json::Value::obj();
    caps.set("formats", json::Value(json::Array{json::Value("gguf")}));
    caps.set("modalities", json::Value(json::Array{json::Value("text"),
                                                   json::Value("embedding")}));
    caps.set("dialects", json::Value(json::Array{json::Value("openai-chat")}));

    json::Array features{json::Value("gbnf"), json::Value("structured-output"),
                         json::Value("tools"), json::Value("embeddings"),
                         json::Value("tokenize"), json::Value("mmap")};
    caps.set("features", json::Value(features));

    json::Value limits = json::Value::obj();
    limits.set("max_parallel", 1);
    caps.set("limits", limits);
    return caps;
  }

  std::unique_ptr<LoadedModel> load(const json::Value& entry,
                                    std::string* error) override {
    ensureLlamaInit();
    llama_log_set(quietLogger, nullptr);

    const std::string path = entry["path"].asString();
    if (path.empty()) {
      *error = "no_path";
      return nullptr;
    }

    llama_model_params mp = llama_model_default_params();
    // mmap keeps the weights out of the process's dirty footprint, which is the
    // difference between a 2 GB model being viable on a phone and not. The fit
    // function relies on this: it never counts mapped_mb against the per-process
    // memory limit, and that is only true if the load actually maps.
    mp.load_mode = LLAMA_LOAD_MODE_MMAP;
    if (entry["gpu_layers"].isNumber()) {
      mp.n_gpu_layers = static_cast<int32_t>(entry["gpu_layers"].asInt(0));
    }

    llama_model* model = llama_model_load_from_file(path.c_str(), mp);
    if (!model) {
      *error = "load_failed";
      return nullptr;
    }

    llama_context_params cp = llama_context_default_params();
    // KV sizing comes from the catalog when it declares a context length, and
    // from the model's training length otherwise. Zero would mean "whatever the
    // model says", which on a large-context model allocates a KV cache far
    // bigger than a phone can hold.
    const int64_t declared = entry["context_length"].asInt(0);
    const int32_t trained = llama_model_n_ctx_train(model);
    int32_t nCtx = declared > 0 ? static_cast<int32_t>(declared) : trained;
    if (trained > 0 && nCtx > trained) nCtx = trained;
    if (nCtx <= 0) nCtx = 2048;
    cp.n_ctx = static_cast<uint32_t>(nCtx);
    cp.n_batch = static_cast<uint32_t>(nCtx < 512 ? nCtx : 512);
    if (entry["embedding"].asBool(false)) cp.embeddings = true;

    llama_context* ctx = llama_init_from_model(model, cp);
    if (!ctx) {
      llama_model_free(model);
      *error = "context_failed";
      return nullptr;
    }

    auto m = std::make_unique<GgufModel>();
    m->model = model;
    m->ctx = ctx;
    m->vocab = llama_model_get_vocab(model);
    m->nCtx = nCtx;
    m->chatTemplate = entry["template"].asString("");
    m->samplingDefaults = entry["sampling"];
    return m;
  }

  void serve(LoadedModel& model, const json::Value& request,
             const Emitter& out) override {
    GgufModel& m = static_cast<GgufModel&>(model);

    // Each request starts from an empty KV cache. Carrying state between
    // requests would make two independent calls silently influence each other,
    // and the conversation the caller wants is already in `messages`.
    llama_memory_clear(llama_get_memory(m.ctx), true);

    if (request["kind"].asString() == "embedding") {
      serveEmbedding(m, request, out);
      return;
    }

    // Structured output: compile the schema before generating, and REFUSE if it
    // will not compile. Generating unconstrained after failing to build the
    // grammar would answer the caller with prose where they asked for a shape.
    std::string grammar;
    if (request["response_format"]["type"].asString() == "json_schema") {
      std::string gerr;
      grammar = gbnf::fromJsonSchema(request["response_format"]["schema"], &gerr);
      if (grammar.empty()) {
        out.fail("schema_unsupported", gerr.empty() ? "schema did not compile" : gerr);
        return;
      }
    }

    const std::string prompt = buildPrompt(m, request);
    std::vector<llama_token> tokens = tokenize(m.vocab, prompt, true);
    if (tokens.empty()) {
      out.fail("empty_prompt", "the request produced no tokens");
      return;
    }
    if (static_cast<int32_t>(tokens.size()) >= m.nCtx) {
      out.fail("context_overflow",
               "the prompt is " + std::to_string(tokens.size()) +
                   " tokens and the context holds " + std::to_string(m.nCtx));
      return;
    }

    llama_sampler* sampler = buildSampler(m, request, grammar);
    if (!sampler) {
      out.fail("sampler_failed", "the sampler chain could not be built");
      return;
    }

    const int64_t maxTokens = request["options"]["max_tokens"].asInt(0);
    const int32_t budget =
        maxTokens > 0 ? static_cast<int32_t>(maxTokens) : m.nCtx - static_cast<int32_t>(tokens.size());

    int32_t generated = 0;
    std::string finishReason = "stop";
    // Bytes of a multi-byte character whose remaining tokens have not arrived.
    std::string carry;

    // Prompt ingestion. A failure here is the model refusing the input, which
    // is a typed refusal rather than a crash.
    llama_batch batch = llama_batch_get_one(tokens.data(),
                                            static_cast<int32_t>(tokens.size()));
    if (llama_decode(m.ctx, batch) != 0) {
      llama_sampler_free(sampler);
      out.fail("decode_failed", "the prompt could not be ingested");
      return;
    }

    while (generated < budget) {
      // The cancellation poll, inside the loop, before the expensive part.
      if (out.cancelled && out.cancelled()) {
        finishReason = "cancelled";
        break;
      }

      const llama_token id = llama_sampler_sample(sampler, m.ctx, -1);
      if (llama_vocab_is_eog(m.vocab, id)) break;

      llama_sampler_accept(sampler, id);

      carry += pieceOf(m.vocab, id);
      const size_t whole = gguf::completeUtf8Prefix(carry);
      if (whole > 0) {
        json::Value block = json::Value::obj();
        block.set("type", "text");
        block.set("text", carry.substr(0, whole));
        out.block(block);
        carry.erase(0, whole);
      }
      generated++;

      llama_token next = id;
      llama_batch step = llama_batch_get_one(&next, 1);
      if (llama_decode(m.ctx, step) != 0) {
        finishReason = "decode_error";
        break;
      }
    }

    if (!carry.empty()) {
      // Whatever is left cannot be completed - the stream ended mid-character.
      // Emitting it beats silently swallowing bytes the model produced: a
      // visible replacement character is a bug report, a missing one is not.
      json::Value block = json::Value::obj();
      block.set("type", "text");
      block.set("text", carry);
      out.block(block);
    }
    if (generated >= budget && finishReason == "stop") finishReason = "length";
    llama_sampler_free(sampler);

    // Usage and a finish reason are things this backend learns only when it
    // stops, which is exactly what Emitter::finish exists to carry.
    if (out.finish) {
      json::Value extras = json::Value::obj();
      json::Value usage = json::Value::obj();
      usage.set("in", static_cast<int>(tokens.size()));
      usage.set("out", static_cast<int>(generated));
      extras.set("usage", usage);
      extras.set("finish_reason", finishReason);
      out.finish(extras);
    }
  }

 private:
  void serveEmbedding(GgufModel& m, const json::Value& request,
                      const Emitter& out) {
    const std::string text = request["input"].isString()
                                 ? request["input"].asString()
                                 : request["prompt"].asString("");
    std::vector<llama_token> tokens = tokenize(m.vocab, text, true);
    if (tokens.empty()) {
      out.fail("empty_input", "the request produced no tokens");
      return;
    }

    llama_batch batch = llama_batch_get_one(tokens.data(),
                                            static_cast<int32_t>(tokens.size()));
    if (llama_decode(m.ctx, batch) != 0) {
      out.fail("decode_failed", "the input could not be embedded");
      return;
    }

    const float* vec = llama_get_embeddings_seq(m.ctx, 0);
    if (!vec) {
      // Reached when the model was not loaded with `embedding: true`. Saying so
      // beats returning a zero vector that looks like an answer.
      out.fail("no_embeddings",
               "this model was not loaded in embedding mode");
      return;
    }

    const int32_t dim = llama_model_n_embd(m.model);
    json::Array values;
    values.reserve(static_cast<size_t>(dim));
    for (int32_t i = 0; i < dim; i++) values.push_back(json::Value(static_cast<double>(vec[i])));

    json::Value block = json::Value::obj();
    block.set("type", "embedding");
    block.set("dimension", static_cast<int>(dim));
    block.set("values", json::Value(values));
    out.block(block);

    if (out.finish) {
      json::Value extras = json::Value::obj();
      json::Value usage = json::Value::obj();
      usage.set("in", static_cast<int>(tokens.size()));
      extras.set("usage", usage);
      extras.set("finish_reason", "stop");
      out.finish(extras);
    }
  }
};

}  // namespace

void registerGgufBackend() {
  Registry::shared().add(std::unique_ptr<Backend>(new GgufBackend()));
}

}  // namespace ai
}  // namespace despia
