// whisper_backend.cpp - the speech backend.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Registers as "whisper" and serves the audio modality: transcribe, streaming
// listen with partials, VAD, and language detection. Same Backend seam as the
// mock and the GGUF backend, so the core still knows nothing about speech.
//
// Every whisper.cpp symbol here was read from vendor/whisper.cpp/include/
// whisper.h at the pinned commit, never recalled.
//
// Partials are emitted from whisper's new_segment_callback, which fires on the
// worker thread mid-decode. That is what makes `listen` genuinely streaming
// rather than a transcribe that reports at the end - a caller watching someone
// speak wants the words as they land, and a five-second wait for a five-second
// clip is indistinguishable from a hang.

#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "whisper.h"

#include "../../backend.hpp"
#include "../../json.hpp"
#include "audio.hpp"

namespace despia {
namespace ai {
namespace {

void quietLogger(ggml_log_level level, const char* text, void* user) {
  (void)level;
  (void)text;
  (void)user;
}

struct WhisperModel : LoadedModel {
  whisper_context* ctx = nullptr;
  ~WhisperModel() override {
    if (ctx) whisper_free(ctx);
  }
};

// Carried through whisper's callbacks, which take a void* and nothing else.
struct StreamState {
  const Emitter* out = nullptr;
  int emitted = 0;      // segments already delivered, so each is sent once
  bool streaming = false;
  std::string text;     // the full transcript, accumulated
};

// Fires as whisper finalises segments. n_new counts the segments added since
// the last call, so the ones to emit are the tail of the list.
void onNewSegment(whisper_context* ctx, whisper_state* state, int n_new,
                  void* user) {
  (void)state;
  StreamState* s = static_cast<StreamState*>(user);
  if (!s) return;
  const int total = whisper_full_n_segments(ctx);
  for (int i = total - n_new; i < total; i++) {
    if (i < s->emitted) continue;
    const char* text = whisper_full_get_segment_text(ctx, i);
    if (!text) continue;
    s->text += text;
    if (s->streaming && s->out && s->out->block) {
      // A partial is a text DELTA on the same envelope everything else uses.
      // The core sequences it; this backend does not format an envelope.
      json::Value block = json::Value::obj();
      block.set("type", "text");
      block.set("text", std::string(text));
      block.set("partial", true);
      block.set("start_ms", static_cast<int>(whisper_full_get_segment_t0(ctx, i) * 10));
      block.set("end_ms", static_cast<int>(whisper_full_get_segment_t1(ctx, i) * 10));
      s->out->block(block);
    }
    s->emitted = i + 1;
  }
}

// whisper polls this between decode steps; returning true aborts. This is what
// makes a cancel land inside a long transcription rather than after it.
bool onAbort(void* user) {
  StreamState* s = static_cast<StreamState*>(user);
  if (!s || !s->out || !s->out->cancelled) return false;
  return s->out->cancelled();
}

// Pulls audio out of a request. Bytes never ride the bus inline (the corpus
// asserts it), so the normal shape is a path; a raw sample array stays
// supported for a caller that already has PCM in hand.
bool loadAudio(const json::Value& request, std::vector<float>* out,
               std::string* error) {
  const json::Value& audio = request["audio"];

  if (audio["samples"].isArray()) {
    const json::Array& raw = audio["samples"].asArray();
    const int rate = static_cast<int>(audio["rate"].asInt(audio::kTargetRate));
    const int channels = static_cast<int>(audio["channels"].asInt(1));
    audio::Pcm pcm;
    pcm.rate = rate;
    pcm.channels = channels;
    pcm.samples.reserve(raw.size());
    for (const auto& v : raw) pcm.samples.push_back(static_cast<float>(v.asNumber(0)));
    *out = audio::toModelInput(pcm);
    return true;
  }

  const std::string path = audio["path"].isString()
                               ? audio["path"].asString()
                               : request["path"].asString("");
  if (path.empty()) {
    *error = "the request carries no audio";
    return false;
  }

  std::vector<uint8_t> bytes;
  if (!audio::readFile(path, &bytes, error)) return false;

  audio::Pcm pcm;
  if (!audio::decodeWav(bytes, &pcm, error)) return false;
  *out = audio::toModelInput(pcm);
  return true;
}

class WhisperBackend : public Backend {
 public:
  std::string id() const override { return "whisper"; }

  json::Value capabilities() const override {
    json::Value caps = json::Value::obj();
    caps.set("formats", json::Value(json::Array{json::Value("ggml")}));
    caps.set("modalities", json::Value(json::Array{json::Value("audio")}));
    json::Array features{json::Value("transcribe"), json::Value("listen"),
                         json::Value("vad"), json::Value("detect-language"),
                         json::Value("timestamps"), json::Value("resample")};
    caps.set("features", json::Value(features));
    json::Value limits = json::Value::obj();
    limits.set("max_parallel", 1);
    limits.set("sample_rate", audio::kTargetRate);
    caps.set("limits", limits);
    return caps;
  }

  std::unique_ptr<LoadedModel> load(const json::Value& entry,
                                    std::string* error) override {
    whisper_log_set(quietLogger, nullptr);

    const std::string path = entry["path"].asString();
    if (path.empty()) {
      *error = "no_path";
      return nullptr;
    }

    whisper_context_params cp = whisper_context_default_params();
    if (entry["gpu"].isBool()) cp.use_gpu = entry["gpu"].asBool(true);

    whisper_context* ctx = whisper_init_from_file_with_params(path.c_str(), cp);
    if (!ctx) {
      *error = "load_failed";
      return nullptr;
    }
    auto m = std::make_unique<WhisperModel>();
    m->ctx = ctx;
    return m;
  }

  void serve(LoadedModel& model, const json::Value& request,
             const Emitter& out) override {
    WhisperModel& m = static_cast<WhisperModel&>(model);

    std::vector<float> samples;
    std::string error;
    if (!loadAudio(request, &samples, &error)) {
      out.fail("audio_unreadable", error);
      return;
    }
    if (samples.empty()) {
      out.fail("empty_audio", "the audio decoded to no samples");
      return;
    }

    const std::string kind = request["kind"].asString("transcribe");

    // VAD needs no model pass at all: it is an energy question about the
    // samples, so answering it with a full decode would be wasteful and slow.
    if (kind == "vad") {
      serveVad(samples, request, out);
      return;
    }

    whisper_full_params wp =
        whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wp.print_progress = false;
    wp.print_realtime = false;
    wp.print_timestamps = false;
    wp.print_special = false;
    wp.translate = request["translate"].asBool(false);

    const std::string language = request["language"].asString("");
    if (language.empty() || language == "auto") {
      wp.language = nullptr;
      wp.detect_language = true;
    } else {
      wp.language = language.c_str();
    }

    if (kind == "detectLanguage") {
      // Ask for the shortest useful pass rather than a full transcription: the
      // caller wants a language id, not the words.
      wp.detect_language = true;
      wp.duration_ms = 30000;
    }

    StreamState state;
    state.out = &out;
    state.streaming = (kind == "listen");
    wp.new_segment_callback = onNewSegment;
    wp.new_segment_callback_user_data = &state;
    wp.abort_callback = onAbort;
    wp.abort_callback_user_data = &state;

    const int rc = whisper_full(m.ctx, wp, samples.data(),
                                static_cast<int>(samples.size()));
    if (rc != 0) {
      // An abort and a genuine failure both come back non-zero, so the
      // cancelled case is distinguished before it is reported as an error.
      if (out.cancelled && out.cancelled()) return;
      out.fail("transcribe_failed",
               "whisper returned " + std::to_string(rc));
      return;
    }
    if (out.cancelled && out.cancelled()) return;

    const int langId = whisper_full_lang_id(m.ctx);
    const char* langStr = langId >= 0 ? whisper_lang_str(langId) : nullptr;

    if (kind == "detectLanguage") {
      json::Value block = json::Value::obj();
      block.set("type", "text");
      block.set("language", std::string(langStr ? langStr : "unknown"));
      out.block(block);
    } else if (!state.streaming) {
      // Non-streaming delivers the transcript once, whole.
      json::Value block = json::Value::obj();
      block.set("type", "text");
      block.set("text", state.text);
      out.block(block);
    }

    if (out.finish) {
      json::Value extras = json::Value::obj();
      extras.set("finish_reason", "stop");
      if (langStr) extras.set("language", std::string(langStr));
      json::Value usage = json::Value::obj();
      usage.set("audio_ms",
                static_cast<int>(samples.size() * 1000 / audio::kTargetRate));
      extras.set("usage", usage);
      out.finish(extras);
    }
  }

 private:
  // Energy-gated voice activity over fixed windows. Deliberately simple and
  // deliberately honest about it: this answers "is anyone talking" for barge-in
  // and endpointing, not "is this speech or a passing lorry". A model-based VAD
  // is a separate capability and would be declared as one rather than smuggled
  // in behind the same name.
  void serveVad(const std::vector<float>& samples, const json::Value& request,
                const Emitter& out) {
    const double threshold = request["threshold"].isNumber()
                                 ? request["threshold"].asNumber(0.01)
                                 : 0.01;
    const int windowMs = static_cast<int>(request["window_ms"].asInt(30));
    const size_t window =
        static_cast<size_t>(audio::kTargetRate) * static_cast<size_t>(windowMs) / 1000;
    if (window == 0) {
      out.fail("bad_window", "window_ms must be at least 1");
      return;
    }

    json::Array spans;
    bool inSpeech = false;
    size_t spanStart = 0;
    for (size_t i = 0; i + window <= samples.size(); i += window) {
      const bool voiced =
          audio::rms(samples.data() + i, window) > static_cast<float>(threshold);
      if (voiced && !inSpeech) {
        inSpeech = true;
        spanStart = i;
      } else if (!voiced && inSpeech) {
        inSpeech = false;
        json::Value span = json::Value::obj();
        span.set("start_ms", static_cast<int>(spanStart * 1000 / audio::kTargetRate));
        span.set("end_ms", static_cast<int>(i * 1000 / audio::kTargetRate));
        spans.push_back(span);
      }
    }
    if (inSpeech) {
      json::Value span = json::Value::obj();
      span.set("start_ms", static_cast<int>(spanStart * 1000 / audio::kTargetRate));
      span.set("end_ms", static_cast<int>(samples.size() * 1000 / audio::kTargetRate));
      spans.push_back(span);
    }

    json::Value block = json::Value::obj();
    block.set("type", "vad");
    block.set("speech", !spans.empty());
    block.set("spans", json::Value(spans));
    out.block(block);

    if (out.finish) {
      json::Value extras = json::Value::obj();
      extras.set("finish_reason", "stop");
      out.finish(extras);
    }
  }
};

}  // namespace

void registerWhisperBackend() {
  Registry::shared().add(std::unique_ptr<Backend>(new WhisperBackend()));
}

}  // namespace ai
}  // namespace despia
