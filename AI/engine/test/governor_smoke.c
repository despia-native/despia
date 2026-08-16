// governor_smoke.c - does the memory governor actually EVICT, with real weights?
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// governor_test.cpp pins the governor's arithmetic, and arithmetic was never
// the problem: the LRU eviction in governor.hpp worked from the day it landed
// and ran in no shipping configuration, because nothing outside that test ever
// called setBudget. Every context anyone opened had a budget of 0 - unbounded -
// and eviction could not fire in any of them. A mechanism nobody armed.
//
// So this driver goes the whole way round through the C ABI with two real
// models on disk, and asks the engine a question the unit test cannot:
//
//   ARMED    open with limits.max_runtime_bytes sized to fit ONE of them,
//            load both -> the first must be gone.
//   UNARMED  open with no limits at all - the state that shipped - load both
//            -> both must still be there.
//
// "Still there" is asked the only way a C consumer can ask it: unloading a
// model the context is no longer holding answers `unknown_model`. That is the
// same observable a host has.
//
// It also prints this process's resident set after each load, which is where
// the eviction stops being a return value and becomes bytes: under the armed
// budget the process SHRINKS while loading a second model.
//
// NOT part of any gate - it needs weights this repository does not carry, and a
// test that silently passes when its input is missing is worse than no test.
// Built so it cannot rot, run by hand:
//
//   ./build/governor_smoke /path/to/big.gguf /path/to/small.gguf
//
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void* despia_ai_open(const char* config_json);
extern void despia_ai_close(void* ctx);
extern int despia_ai_load_model(void* ctx, const char* model_json);
extern int despia_ai_unload_model(void* ctx, const char* model_id);
extern const char* despia_ai_last_error(void* ctx);

static int failures = 0;

static void check(int cond, const char* what) {
  printf("  %s %s\n", cond ? "ok  " : "FAIL", what);
  if (!cond) failures++;
}

// This process's resident set, in MB. Printed as CONTEXT and never compared
// against the budget: RSS counts the mmapped weight pages currently faulted in,
// and the budget is denominated in the charge an entry declares (`runtime_mb`),
// which deliberately excludes them. Two different quantities, and confusing
// them is the bug this whole file is about. Linux-only; 0 elsewhere.
static double rss_mb(void) {
  FILE* f = fopen("/proc/self/status", "r");
  if (!f) return 0;
  char line[256];
  double mb = 0;
  while (fgets(line, sizeof line, f)) {
    long kb;
    if (sscanf(line, "VmRSS: %ld kB", &kb) == 1) {
      mb = kb / 1024.0;
      break;
    }
  }
  fclose(f);
  return mb;
}

static int load(void* ctx, const char* id, const char* path, int runtime_mb) {
  char entry[1024];
  snprintf(entry, sizeof entry,
           "{\"id\":\"%s\",\"engine\":\"gguf\",\"format\":\"gguf\",\"path\":\"%s\","
           "\"context_length\":512,\"runtime_mb\":%d}",
           id, path, runtime_mb);
  int rc = despia_ai_load_model(ctx, entry);
  printf("  load %-6s runtime_mb=%-5d rc=%d  rss=%.0f MB %s\n", id, runtime_mb, rc,
         rss_mb(), rc ? despia_ai_last_error(ctx) : "");
  return rc;
}

// 0 = the context still holds it, 1 = it is gone.
static int gone(void* ctx, const char* id) {
  if (despia_ai_unload_model(ctx, id) == 0) return 0;
  const char* err = despia_ai_last_error(ctx);
  return err && strstr(err, "unknown_model") != NULL;
}

int main(int argc, char** argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc < 3) {
    fprintf(stderr, "usage: governor_smoke <model-a.gguf> <model-b.gguf>\n");
    return 2;
  }
  const char* a = argv[1];
  const char* b = argv[2];

  // The two models declare 300 MB of runtime charge each and the budget is
  // 400 MB: either fits alone, the two together do not. Declared rather than
  // measured because that is what a host does - `runtime_mb` is the entry field
  // LocalAIModelRef writes from the fit function's footprint, and the engine
  // accounts exactly what the entry claims.
  const long long budget = 400ll * 1024 * 1024;
  char cfg[256];

  printf("governor_smoke\n  a = %s\n  b = %s\n\n", a, b);

  printf("ARMED: limits.max_runtime_bytes = %lld (%lld MB), two 300 MB models\n", budget,
         budget / (1024 * 1024));
  {
    snprintf(cfg, sizeof cfg, "{\"schema_version\":1,\"limits\":{\"max_runtime_bytes\":%lld}}",
             budget);
    void* ctx = despia_ai_open(cfg);
    if (!ctx) {
      printf("  open failed: %s\n", despia_ai_last_error(NULL));
      return 1;
    }
    if (load(ctx, "a", a, 300) || load(ctx, "b", b, 300)) return 1;
    check(gone(ctx, "a"), "the first model was EVICTED to make room for the second");
    check(!gone(ctx, "b"), "and the second - the one being loaded - was never a candidate");
    despia_ai_close(ctx);
  }

  printf("\nUNARMED: no limits at all - the configuration that shipped\n");
  {
    void* ctx = despia_ai_open("{\"schema_version\":1}");
    if (!ctx) {
      printf("  open failed: %s\n", despia_ai_last_error(NULL));
      return 1;
    }
    if (load(ctx, "a", a, 300) || load(ctx, "b", b, 300)) return 1;
    check(!gone(ctx, "a"), "both stay resident: an unbounded context evicts nothing");
    check(!gone(ctx, "b"), "including the one just loaded");
    despia_ai_close(ctx);
  }

  printf("\nBUDGET 0 is a value, not an absence: it means unbounded\n");
  {
    void* ctx = despia_ai_open("{\"schema_version\":1,\"limits\":{\"max_runtime_bytes\":0}}");
    if (!ctx) {
      printf("  open failed: %s\n", despia_ai_last_error(NULL));
      return 1;
    }
    if (load(ctx, "a", a, 300) || load(ctx, "b", b, 300)) return 1;
    check(!gone(ctx, "a"), "0 keeps both - the documented desktop answer");
    despia_ai_close(ctx);
  }

  printf("\nA BUDGET OF THE WRONG SHAPE IS A REFUSAL, never a silently-dropped one\n");
  {
    void* ctx = despia_ai_open("{\"limits\":{\"max_runtime_bytes\":\"400MB\"}}");
    check(ctx == NULL, "a string budget refuses the open rather than running unbounded");
    printf("       %s\n", despia_ai_last_error(NULL));
    if (ctx) despia_ai_close(ctx);
  }

  printf("\n%s (%d failure(s))\n", failures ? "FAILED" : "all checks passed", failures);
  return failures ? 1 : 0;
}
