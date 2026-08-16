// stream_test.c - is it REALLY streaming, or batched and delivered at the end?
//
// Five token events prove tokens exist. They do not prove the caller sees them
// as they are produced, which is the whole point of streaming: a UI that gets
// everything at t=end is indistinguishable from one that never streamed.
//
// So this timestamps every event and prints the gap. Real streaming shows a
// first token well before the last, with gaps roughly the decode interval.
// Batched delivery shows every event arriving in the same millisecond.

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

extern void* despia_ai_open(const char*);
extern void  despia_ai_close(void*);
extern int   despia_ai_load_model(void*, const char*);
typedef void (*cb_t)(const char*, void*);
extern int   despia_ai_request(void*, const char*, cb_t, void*);
extern int   despia_ai_cancel(void*, int);
extern int   despia_ai_sync(void*, int);
extern const char* despia_ai_last_error(void*);

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static double t0, t_first = -1, t_last = 0;
static int tokens = 0, syncs = 0, done = 0;
static char text[16384];

static void collect(const char* json) {
  const char* t = strstr(json, "\"text\":\"");
  if (!t) return;
  t += 8;
  size_t len = strlen(text);
  while (*t && *t != '"' && len < sizeof(text) - 2) {
    if (*t == '\\' && t[1]) { t++; if (*t=='n') { text[len++]='\n'; t++; continue; } }
    text[len++] = *t++;
  }
  text[len] = 0;
}

static void on_event(const char* json, void* user) {
  (void)user;
  double t = now_ms() - t0;
  if (strstr(json, "\"event\":\"token\"")) {
    if (t_first < 0) { t_first = t; printf("  first token at %7.1f ms\n", t); }
    if (tokens < 6 || tokens % 25 == 0) printf("  token %-4d at %7.1f ms  (+%.1f)\n", tokens, t, t - t_last);
    t_last = t;
    tokens++;
    collect(json);
  } else if (strstr(json, "\"event\":\"sync\"")) {
    syncs++;
    printf("  SYNC  at %7.1f ms -> snapshot of %zu chars\n", t, strlen(text));
  } else if (strstr(json, "\"event\":\"complete\"")) {
    printf("  complete at %7.1f ms\n", t);
    done = 1;
  } else if (strstr(json, "\"event\":\"error\"")) {
    printf("  error at %7.1f ms: %.200s\n", t, json);
    done = 1;
  }
}

int main(int argc, char** argv) {
  const char* path = argc > 1 ? argv[1] : "/tmp/models/gemma-3-1b-it-Q4_K_M.gguf";
  void* ctx = despia_ai_open("{\"schema_version\":1,\"state_dir\":\"/tmp/despia-state\"}");
  if (!ctx) { printf("open failed\n"); return 1; }

  char model[1024];
  snprintf(model, sizeof(model),
           "{\"schema_version\":1,\"id\":\"g3\",\"engine\":\"gguf\",\"format\":\"gguf\","
           "\"path\":\"%s\",\"context_length\":2048}", path);
  if (despia_ai_load_model(ctx, model) != 0) {
    printf("load failed: %s\n", despia_ai_last_error(ctx));
    return 1;
  }

  // ── 1. a long generation, timestamped ────────────────────────────────────
  printf("\n=== streaming a long answer ===\n");
  t0 = now_ms();
  const char* req =
      "{\"schema_version\":1,\"kind\":\"completion\",\"model\":\"g3\","
      "\"messages\":[{\"role\":\"user\",\"content\":\"Count from 1 to 40, "
      "one number per line, nothing else.\"}],"
      "\"options\":{\"max_tokens\":220,\"temperature\":0,\"seed\":1}}";
  int rid = despia_ai_request(ctx, req, on_event, NULL);
  if (rid < 0) { printf("request failed\n"); return 1; }

  // Ask for a mid-stream resync once tokens start flowing, to prove a surface
  // attaching late can catch up without restarting the generation.
  int asked = 0;
  for (int i = 0; i < 1800 && !done; i++) {
    if (!asked && tokens > 10) { asked = 1; despia_ai_sync(ctx, rid); }
    usleep(10000);
  }
  double span = t_last - t_first;
  printf("\ntokens=%d  first=%.1fms  last=%.1fms  span=%.1fms  syncs=%d\n",
         tokens, t_first, t_last, span, syncs);
  printf("text starts: %.60s\n", text);

  int streaming = (tokens > 5 && span > 50.0);
  printf("VERDICT streaming: %s (%.1f ms between first and last token)\n",
         streaming ? "REAL - tokens arrived spread over time" : "SUSPECT - all at once", span);

  // ── 2. cancel mid-stream ─────────────────────────────────────────────────
  printf("\n=== cancel mid-stream ===\n");
  tokens = 0; done = 0; t_first = -1; text[0] = 0; t0 = now_ms();
  int rid2 = despia_ai_request(ctx, req, on_event, NULL);
  int cancelled_at = 0;
  for (int i = 0; i < 1800 && !done; i++) {
    if (!cancelled_at && tokens > 8) { cancelled_at = tokens; despia_ai_cancel(ctx, rid2); }
    usleep(10000);
  }
  printf("cancelled after %d tokens, settled with %d total\n", cancelled_at, tokens);
  int cancel_ok = cancelled_at > 0 && tokens < 200 && done;
  printf("VERDICT cancel: %s\n", cancel_ok ? "REAL - the decode loop stopped early" : "SUSPECT");

  despia_ai_close(ctx);
  return (streaming && cancel_ok) ? 0 : 1;
}
