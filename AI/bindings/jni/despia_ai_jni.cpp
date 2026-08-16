// despia_ai_jni.cpp - the JVM's door to the C ABI.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This is what makes the Kotlin lane run the REAL MockEngine rather than a
// third port of it. There is exactly one MockEngine (mock/mock_backend.cpp);
// the TypeScript one is an explicitly subordinate port because the web lane has
// no native toolchain, and every other lane loads the C++ one through a seam
// like this. A second native mock would be a second thing to keep honest.
//
// The interesting part is the callback direction. Engine events arrive on the
// engine's OWN worker thread, which the JVM has never seen, so this attaches
// that thread and detaches it again when the request settles. That is not
// incidental plumbing - the ABI's threading contract says events come from one
// engine-owned thread, and the JVM lane is where that claim is tested, because
// this is where threads are real and a violation shows up as a hang rather than
// as a warning.
//
// TWO THINGS ARE OWNED HERE AND BOTH ARE LEAKS IF NOBODY OWNS THEM. This layer
// runs on a phone for the life of a process, so "it accumulates slowly" is the
// same thing as "it fails eventually".
//
//   1. THE SINK LEDGER. A request's listener needs a GLOBAL ref, because the
//      engine calls back long after the JNI frame that made it is gone. The
//      engine hands the sink back verbatim on every event, so the question is
//      only WHEN it may be released, and the answer is the envelope's own
//      `final` flag: the ABI emits exactly one terminal event per request and
//      never calls back afterwards. Three paths reach the same ledger, and all
//      three are needed, because two of them never see an event at all:
//        · the terminal event  - the ordinary settle (see deliver);
//        · a NEGATIVE return from despia_ai_request - refused before it was
//          queued, so no callback will ever come (see request);
//        · close - the sweep, which is what covers work that was still queued
//          when the context went away and therefore never settled. It runs
//          AFTER despia_ai_close, which joins the worker, so nothing can be
//          mid-delivery while it runs.
//      The ledger is keyed by an integer TOKEN rather than by the sink's
//      address, so a stale pointer from a would-be post-terminal event can
//      never be mistaken for a live sink that happens to have been allocated at
//      the same address.
//
//   2. THE THREAD ATTACHMENT. A native thread that exits while still attached
//      leaks its JavaThread (and ART complains about it by name), so the
//      attachment this layer makes is released at the same moment the sink is:
//      one attach and one detach per REQUEST, not per event, and only ever on a
//      thread this layer attached itself.
//
// AND THE STRINGS ARE CONVERTED, NOT PASSED. JNI's NewStringUTF and
// GetStringUTFChars speak MODIFIED UTF-8, in which a character outside the BMP
// is a pair of three-byte surrogate halves; the C ABI speaks standard UTF-8, in
// which it is one four-byte sequence. The two disagree about exactly the bytes a
// language model produces all day - an emoji, a rare CJK ideograph - and handing
// a four-byte sequence to NewStringUTF is undefined: it corrupts the string on
// one runtime and aborts under checked JNI on another. So both directions go
// through the conversions below, which also means malformed input from either
// side degrades to U+FFFD instead of taking the process with it.

#include <jni.h>

#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "../../engine/include/despia_ai.h"

namespace {

JavaVM* g_vm = nullptr;

// One of these per request: it carries the sink the events belong to, plus the
// context that owns it so close() can sweep what never settled.
struct Sink {
  jobject listener;   // global ref to a com.despia.ai.EventListener
  jmethodID onEvent;
  void* ctx;
};

std::mutex g_sinkMu;
std::unordered_map<uintptr_t, Sink> g_sinks;   // live sinks, by token
uintptr_t g_nextSinkToken = 1;

// Counted independently of the ledger rather than derived from it: the point of
// the accounting is to prove the ref and the entry are released TOGETHER, and a
// number computed from the map could not catch them drifting apart.
jint g_listenerRefs = 0;

std::mutex g_attachMu;

// Set only on a thread THIS layer attached. A thread the JVM already owns - a
// Java caller reaching the ABI through one of the entry points below - is never
// detached here, because it is not ours to detach.
thread_local bool t_attachedHere = false;

// Returns a JNIEnv for the CURRENT thread, attaching it if the JVM has not seen
// it before - which is the normal case here, since the caller is the engine's
// worker.
JNIEnv* envForCurrentThread() {
  JNIEnv* env = nullptr;
  if (!g_vm) return nullptr;
  jint status = g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (status == JNI_OK) return env;
  if (status == JNI_EDETACHED) {
    std::lock_guard<std::mutex> lock(g_attachMu);
    if (g_vm->AttachCurrentThreadAsDaemon(reinterpret_cast<void**>(&env), nullptr) == JNI_OK) {
      t_attachedHere = true;
      return env;
    }
  }
  return nullptr;
}

void detachIfAttachedHere() {
  if (!t_attachedHere || !g_vm) return;
  t_attachedHere = false;
  g_vm->DetachCurrentThread();
}

/**
 * The ENVELOPE's own `final` flag.
 *
 * Depth-aware on purpose. The terminal marker is a member of the envelope, and
 * `data` carries whatever the model produced - a snapshot block, a tool
 * argument, a structured-output field. A substring search would let generated
 * content retire a live request, which is a use-after-free wearing a JSON
 * costume. So: scan the top-level object only, and accept the key exclusively
 * when it is followed by a boolean.
 */
bool envelopeIsFinal(const char* json) {
  if (!json) return false;
  const char* p = json;
  while (*p && *p != '{') ++p;
  if (!*p) return false;
  ++p;                       // now inside the envelope

  int depth = 0;             // nesting BELOW the envelope's own members
  while (*p) {
    const char c = *p;
    if (c == '"') {
      const char* start = ++p;
      while (*p && *p != '"') {
        if (*p == '\\' && p[1]) ++p;
        ++p;
      }
      if (!*p) return false;
      const size_t len = static_cast<size_t>(p - start);
      ++p;                   // past the closing quote
      if (depth == 0 && len == 5 && std::strncmp(start, "final", 5) == 0) {
        const char* q = p;
        while (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r') ++q;
        if (*q == ':') {
          ++q;
          while (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r') ++q;
          if (std::strncmp(q, "true", 4) == 0) return true;
          if (std::strncmp(q, "false", 5) == 0) return false;
        }
        // A string that merely READS "final" is not the flag. Keep scanning.
      }
      continue;
    }
    if (c == '{' || c == '[') {
      ++depth;
    } else if (c == '}' || c == ']') {
      if (depth == 0) return false;   // the envelope ended without the flag
      --depth;
    }
    ++p;
  }
  return false;
}

// Releases one sink and its listener ref together. Idempotent: a token that has
// already been retired is simply not there.
void retire(JNIEnv* env, uintptr_t token) {
  jobject listener = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_sinkMu);
    auto it = g_sinks.find(token);
    if (it == g_sinks.end()) return;
    listener = it->second.listener;
    g_sinks.erase(it);
    if (listener) --g_listenerRefs;
  }
  if (listener && env) env->DeleteGlobalRef(listener);
}

// Everything still outstanding for one context. Called only AFTER
// despia_ai_close has joined the worker, so no delivery can be in flight.
void sweepContext(JNIEnv* env, void* ctx) {
  std::vector<jobject> orphans;
  {
    std::lock_guard<std::mutex> lock(g_sinkMu);
    for (auto it = g_sinks.begin(); it != g_sinks.end();) {
      if (it->second.ctx == ctx) {
        if (it->second.listener) {
          orphans.push_back(it->second.listener);
          --g_listenerRefs;
        }
        it = g_sinks.erase(it);
      } else {
        ++it;
      }
    }
  }
  if (env) {
    for (jobject ref : orphans) env->DeleteGlobalRef(ref);
  }
}

// --- standard UTF-8, in both directions -------------------------------------

void appendUtf16(std::vector<jchar>& out, uint32_t cp) {
  if (cp > 0x10FFFF) cp = 0xFFFD;
  if (cp < 0x10000) {
    out.push_back(static_cast<jchar>(cp));
    return;
  }
  cp -= 0x10000;
  out.push_back(static_cast<jchar>(0xD800 + (cp >> 10)));
  out.push_back(static_cast<jchar>(0xDC00 + (cp & 0x3FF)));
}

/**
 * A Java string from standard UTF-8.
 *
 * Decoded here and handed over as UTF-16 (NewString), because NewStringUTF
 * would be the wrong call for the four-byte sequences the engine really emits.
 * A surrogate code point arriving in three-byte form is passed through rather
 * than replaced: that is what a payload which has already been through a
 * modified-UTF-8 hop looks like, and turning it into two replacement characters
 * would corrupt text that is in fact recoverable. Anything genuinely malformed -
 * a truncated sequence, which is what a token piece split mid-character is -
 * becomes U+FFFD and the scan resynchronises on the next byte.
 */
jstring toJavaString(JNIEnv* env, const char* utf8) {
  if (!utf8) return nullptr;
  const unsigned char* p = reinterpret_cast<const unsigned char*>(utf8);
  std::vector<jchar> units;
  units.reserve(std::strlen(utf8));

  while (*p) {
    const unsigned char b = *p;
    uint32_t cp = 0;
    int extra = 0;
    if (b < 0x80) {
      cp = b;
    } else if ((b & 0xE0) == 0xC0) {
      cp = b & 0x1Fu; extra = 1;
    } else if ((b & 0xF0) == 0xE0) {
      cp = b & 0x0Fu; extra = 2;
    } else if ((b & 0xF8) == 0xF0) {
      cp = b & 0x07u; extra = 3;
    } else {
      units.push_back(0xFFFD);
      ++p;
      continue;
    }
    ++p;
    bool ok = true;
    for (int i = 0; i < extra; ++i) {
      if ((*p & 0xC0) != 0x80) { ok = false; break; }
      cp = (cp << 6) | (*p & 0x3Fu);
      ++p;
    }
    if (!ok) { units.push_back(0xFFFD); continue; }
    // Overlong encodings say one thing and mean another, which is a security
    // property as much as a correctness one, so they are refused too.
    if ((extra == 1 && cp < 0x80) || (extra == 2 && cp < 0x800) ||
        (extra == 3 && cp < 0x10000) || cp > 0x10FFFF) {
      units.push_back(0xFFFD);
      continue;
    }
    appendUtf16(units, cp);
  }
  return env->NewString(units.data(), static_cast<jsize>(units.size()));
}

/**
 * Standard UTF-8 from a Java string.
 *
 * Read as UTF-16 rather than through GetStringUTFChars, so an astral character
 * crosses as one four-byte sequence instead of as the surrogate pair spelling
 * the C side would have to un-pair. A lone surrogate - which a Java string is
 * allowed to contain - has no UTF-8 form at all and becomes U+FFFD.
 */
std::string jstr(JNIEnv* env, jstring value) {
  if (!value) return std::string();
  const jsize length = env->GetStringLength(value);
  const jchar* units = env->GetStringChars(value, nullptr);
  if (!units) return std::string();

  std::string out;
  out.reserve(static_cast<size_t>(length) + static_cast<size_t>(length) / 2);
  for (jsize i = 0; i < length; ++i) {
    uint32_t cp = units[i];
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < length &&
        units[i + 1] >= 0xDC00 && units[i + 1] <= 0xDFFF) {
      cp = 0x10000 + ((cp - 0xD800) << 10) + (units[i + 1] - 0xDC00);
      ++i;
    } else if (cp >= 0xD800 && cp <= 0xDFFF) {
      cp = 0xFFFD;
    }
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }
  env->ReleaseStringChars(value, units);
  return out;
}

void deliver(const char* event_json, void* user_data) {
  const uintptr_t token = reinterpret_cast<uintptr_t>(user_data);
  if (!token || !event_json) return;

  jobject listener = nullptr;
  jmethodID onEvent = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_sinkMu);
    auto it = g_sinks.find(token);
    if (it == g_sinks.end()) return;   // already retired - nothing to deliver to
    listener = it->second.listener;
    onEvent = it->second.onEvent;
  }
  // Read before the call, because the call is where a listener could re-enter
  // this layer, and because the engine owns the string only for its duration.
  const bool settled = envelopeIsFinal(event_json);

  JNIEnv* env = envForCurrentThread();
  if (!env) return;   // no env, so not even the ref can be freed here: close sweeps.

  jstring payload = toJavaString(env, event_json);
  if (payload) {
    env->CallVoidMethod(listener, onEvent, payload);
    if (env->ExceptionCheck()) {
      // A listener that throws must not corrupt the engine's worker. Report it
      // and carry on: the ABI says the callback may not block, and unwinding
      // through C++ would be worse than either.
      env->ExceptionDescribe();
      env->ExceptionClear();
    }
    env->DeleteLocalRef(payload);
  } else if (env->ExceptionCheck()) {
    env->ExceptionClear();   // an OOM allocating the payload is still not a leak
  }

  // The terminal event is the last one this request will ever produce, so this
  // is where its half of the ledger closes - and where the attachment this
  // layer made goes back, since the worker may outlive the request but nothing
  // requires it to stay attached between requests.
  if (settled) {
    retire(env, token);
    detachIfAttachedHere();
  }
}

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  g_vm = vm;
  return JNI_VERSION_1_6;
}

JNIEXPORT jint JNICALL
Java_com_despia_ai_NativeEngine_abiVersion(JNIEnv*, jclass) {
  return static_cast<jint>(despia_ai_abi_version());
}

JNIEXPORT jstring JNICALL
Java_com_despia_ai_NativeEngine_capabilities(JNIEnv* env, jclass) {
  const char* raw = despia_ai_capabilities();
  if (!raw) return nullptr;
  jstring out = toJavaString(env, raw);
  despia_ai_free(const_cast<char*>(raw));   // caller-owned, per the header
  return out;
}

JNIEXPORT jlong JNICALL
Java_com_despia_ai_NativeEngine_open(JNIEnv* env, jclass, jstring configJson) {
  const std::string config = jstr(env, configJson);
  void* ctx = despia_ai_open(config.c_str());
  return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT void JNICALL
Java_com_despia_ai_NativeEngine_close(JNIEnv* env, jclass, jlong handle) {
  if (!handle) return;
  void* ctx = reinterpret_cast<void*>(handle);
  // Joins the worker first, per the ABI: after this returns no callback can
  // arrive for this context, which is what makes the sweep below safe rather
  // than a race against a delivery in progress.
  despia_ai_close(ctx);
  sweepContext(env, ctx);
}

JNIEXPORT jint JNICALL
Java_com_despia_ai_NativeEngine_loadModel(JNIEnv* env, jclass, jlong handle, jstring modelJson) {
  if (!handle) return -1;
  const std::string model = jstr(env, modelJson);
  return despia_ai_load_model(reinterpret_cast<void*>(handle), model.c_str());
}

JNIEXPORT jint JNICALL
Java_com_despia_ai_NativeEngine_request(JNIEnv* env, jclass, jlong handle,
                                        jstring requestJson, jobject listener) {
  if (!handle || !listener) return -1;
  void* ctx = reinterpret_cast<void*>(handle);
  const std::string request = jstr(env, requestJson);

  jclass cls = env->GetObjectClass(listener);
  jmethodID onEvent = cls ? env->GetMethodID(cls, "onEvent", "(Ljava/lang/String;)V") : nullptr;
  if (cls) env->DeleteLocalRef(cls);
  if (!onEvent) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    return -1;
  }

  // The sink outlives this call: the engine keeps calling back until the
  // request settles, on a thread that is not this one. It is entered in the
  // ledger BEFORE the request is submitted, because the worker can run the
  // whole request - terminal event included - before this frame returns.
  jobject ref = env->NewGlobalRef(listener);
  if (!ref) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    return -1;
  }
  uintptr_t token = 0;
  {
    std::lock_guard<std::mutex> lock(g_sinkMu);
    token = g_nextSinkToken++;
    g_sinks.emplace(token, Sink{ref, onEvent, ctx});
    ++g_listenerRefs;
  }

  const int rc = despia_ai_request(ctx, request.c_str(), deliver,
                                   reinterpret_cast<void*>(token));
  // A refused request is refused BEFORE it is queued, so its sink will never
  // see an event and this is its only chance to go back.
  if (rc < 0) retire(env, token);
  return rc;
}

JNIEXPORT jint JNICALL
Java_com_despia_ai_NativeEngine_sync(JNIEnv*, jclass, jlong handle, jint requestId) {
  if (!handle) return -1;
  return despia_ai_sync(reinterpret_cast<void*>(handle), requestId);
}

JNIEXPORT jint JNICALL
Java_com_despia_ai_NativeEngine_cancel(JNIEnv*, jclass, jlong handle, jint requestId) {
  if (!handle) return -1;
  return despia_ai_cancel(reinterpret_cast<void*>(handle), requestId);
}

JNIEXPORT jstring JNICALL
Java_com_despia_ai_NativeEngine_lastError(JNIEnv* env, jclass, jlong handle) {
  // The message can quote model output, so it takes the same conversion.
  const char* raw = despia_ai_last_error(handle ? reinterpret_cast<void*>(handle) : nullptr);
  return raw ? toJavaString(env, raw) : nullptr;
}

// --- the ledger, readable ---------------------------------------------------
//
// Not debug scaffolding: the ownership rule above is a CLAIM, and a claim about
// a leak is worth nothing unless a test can read the number back. Both counters
// are exact and both must return to zero, and they are maintained separately so
// that a sink released without its ref (or the reverse) shows up as a
// disagreement rather than as a matched pair of wrong answers.

JNIEXPORT jint JNICALL
Java_com_despia_ai_NativeEngine_liveSinks(JNIEnv*, jclass) {
  std::lock_guard<std::mutex> lock(g_sinkMu);
  return static_cast<jint>(g_sinks.size());
}

JNIEXPORT jint JNICALL
Java_com_despia_ai_NativeEngine_liveListenerRefs(JNIEnv*, jclass) {
  std::lock_guard<std::mutex> lock(g_sinkMu);
  return g_listenerRefs;
}

}  // extern "C"
