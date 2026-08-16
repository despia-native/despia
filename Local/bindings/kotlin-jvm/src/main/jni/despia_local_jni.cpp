// despia_local_jni.cpp - the JVM's door to the Despia Local C ABI.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// This is what makes the Kotlin lane a SECOND runner over the same store rather
// than a third port of it. The TypeScript binding drives node:sqlite directly
// because the web lane has no native toolchain; every other lane goes through
// despia_local.h, and this file is that seam for the JVM.
//
// It links the SHARED library, not the engine sources, which is the whole point:
// this translation unit can only reach the eight symbols the export map lets out
// (OpenSource/Local/tools/symbol_check.rb proves there are exactly eight). If the
// binding ever needed a ninth it would fail to LINK here rather than quietly
// growing the surface, so the confinement that lets a sync vendor's own SQLite
// share the process is tested by construction on every build of this lane.
//
// The threading story is short because the ABI's is: despia_local_call is
// synchronous, there is no callback direction and no engine-owned worker, so
// unlike the AI shim this one never attaches a thread to the JVM. What it does
// carry is the ABI's OWNERSHIP asymmetry, which is easy to get wrong in exactly
// one direction each way: the pointer from despia_local_call belongs to the
// caller and is freed here, and the pointer from despia_local_last_error belongs
// to the handle and must NOT be.

#include <jni.h>

#include <string>

#include "despia_local.h"

namespace {

std::string jstr(JNIEnv* env, jstring value) {
  if (!value) return std::string();
  const char* raw = env->GetStringUTFChars(value, nullptr);
  std::string out(raw ? raw : "");
  if (raw) env->ReleaseStringUTFChars(value, raw);
  return out;
}

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*, void*) { return JNI_VERSION_1_6; }

JNIEXPORT jint JNICALL
Java_com_despia_local_NativeStore_abiVersion(JNIEnv*, jclass) {
  return static_cast<jint>(despia_local_abi_version());
}

JNIEXPORT jstring JNICALL
Java_com_despia_local_NativeStore_capabilities(JNIEnv* env, jclass) {
  const char* raw = despia_local_capabilities();
  if (!raw) return nullptr;
  jstring out = env->NewStringUTF(raw);
  despia_local_free(const_cast<char*>(raw));   // caller-owned, per the header
  return out;
}

JNIEXPORT jlong JNICALL
Java_com_despia_local_NativeStore_open(JNIEnv* env, jclass, jstring configJson) {
  const std::string config = jstr(env, configJson);
  return reinterpret_cast<jlong>(despia_local_open(config.c_str()));
}

JNIEXPORT void JNICALL
Java_com_despia_local_NativeStore_close(JNIEnv*, jclass, jlong handle) {
  if (handle) despia_local_close(reinterpret_cast<void*>(handle));
}

JNIEXPORT jint JNICALL
Java_com_despia_local_NativeStore_reopen(JNIEnv*, jclass, jlong handle) {
  if (!handle) return -1;
  return despia_local_reopen(reinterpret_cast<void*>(handle));
}

// Returns the result JSON, or null. Null is failure and ONLY failure - a
// successful action with nothing to say answers {} - so the Kotlin side reads
// lastError exactly when this is null, never speculatively.
JNIEXPORT jstring JNICALL
Java_com_despia_local_NativeStore_call(JNIEnv* env, jclass, jlong handle,
                                      jstring action, jstring argsJson) {
  if (!handle) return nullptr;
  const std::string name = jstr(env, action);
  const std::string args = jstr(env, argsJson);
  char* raw = despia_local_call(reinterpret_cast<void*>(handle), name.c_str(), args.c_str());
  if (!raw) return nullptr;
  jstring out = env->NewStringUTF(raw);
  despia_local_free(raw);                      // caller-owned, per the header
  return out;
}

// HANDLE-owned: copied into a jstring and deliberately not freed. A `handle` of
// 0 reads the global open-time error, which is the only error there is when
// despia_local_open answered NULL and left nothing to ask.
JNIEXPORT jstring JNICALL
Java_com_despia_local_NativeStore_lastError(JNIEnv* env, jclass, jlong handle) {
  const char* raw = despia_local_last_error(handle ? reinterpret_cast<void*>(handle) : nullptr);
  return raw ? env->NewStringUTF(raw) : nullptr;
}

}  // extern "C"
