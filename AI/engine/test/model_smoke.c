// gemma_smoke.c - does the engine actually run a model?
//
// Deliberately goes through the C ABI ONLY: open, load_model, request, cancel,
// close. It links libdespia_ai and never calls llama.cpp, so a pass here is
// evidence about OUR engine rather than about the vendored library.

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

extern unsigned int despia_ai_abi_version(void);
extern const char*  despia_ai_capabilities(void);
extern void         despia_ai_free(void* p);
typedef void (*cb_t)(const char* event_json, void* user);
extern void* despia_ai_open(const char* config_json);
extern void  despia_ai_close(void* ctx);
extern int   despia_ai_load_model(void* ctx, const char* model_json);
extern int   despia_ai_request(void* ctx, const char* request_json, cb_t cb, void* user);
extern const char* despia_ai_last_error(void* ctx);

static int   g_tokens = 0;
static int   g_done   = 0;
static char  g_text[8192];

// Pulls "text":"..." out of a token event without a JSON parser: enough to
// prove characters came back, and it keeps this driver dependency-free.
static void collect(const char* json) {
  const char* t = strstr(json, "\"text\":\"");
  if (!t) return;
  t += 8;
  size_t len = strlen(g_text);
  while (*t && *t != '"' && len < sizeof(g_text) - 2) {
    if (*t == '\\' && t[1]) { t++; if (*t=='n') { g_text[len++]='\n'; t++; continue; } }
    g_text[len++] = *t++;
  }
  g_text[len] = 0;
}

static void on_event(const char* json, void* user) {
  (void)user;
  if (strstr(json, "\"event\":\"token\"")) { g_tokens++; collect(json); }
  if (strstr(json, "\"event\":\"complete\"")) {
    g_done = 1;
    const char* u = strstr(json, "\"usage\"");
    if (u) printf("\n[complete] %.120s\n", u);
  }
  if (strstr(json, "\"event\":\"error\"")) { g_done = 1; printf("\n[error] %s\n", json); }
}

int main(int argc, char** argv) {
  const char* path = argc > 1 ? argv[1] : "/tmp/models/gemma-3-1b-it-Q4_K_M.gguf";

  printf("abi_version = %u\n", despia_ai_abi_version());
  const char* caps = despia_ai_capabilities();
  printf("capabilities = %.200s\n\n", caps);
  despia_ai_free((void*)caps);

  void* ctx = despia_ai_open("{\"schema_version\":1,\"state_dir\":\"/tmp/despia-state\"}");
  if (!ctx) { printf("open failed: %s\n", despia_ai_last_error(NULL)); return 1; }

  char model[1024];
  snprintf(model, sizeof(model),
           "{\"schema_version\":1,\"id\":\"gemma-3-1b\",\"engine\":\"gguf\","
           "\"format\":\"gguf\",\"path\":\"%s\",\"context_length\":2048}", path);

  printf("loading %s ...\n", path);
  int rc = despia_ai_load_model(ctx, model);
  if (rc != 0) {
    printf("load_model failed rc=%d: %s\n", rc, despia_ai_last_error(ctx));
    despia_ai_close(ctx);
    return 1;
  }
  printf("loaded.\n\n");

  const char* req =
      "{\"schema_version\":1,\"kind\":\"completion\",\"model\":\"gemma-3-1b\","
      "\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: Despia AI works.\"}],"
      "\"options\":{\"max_tokens\":48,\"temperature\":0,\"seed\":1}}";

  int rid = despia_ai_request(ctx, req, on_event, NULL);
  if (rid < 0) {
    printf("request failed rid=%d: %s\n", rid, despia_ai_last_error(ctx));
    despia_ai_close(ctx);
    return 1;
  }
  printf("request id = %d, generating ...\n", rid);

  for (int i = 0; i < 1200 && !g_done; i++) usleep(100000);  // up to 120s

  printf("\n--- generated text ---\n%s\n----------------------\n", g_text);
  printf("token events: %d\n", g_tokens);

  despia_ai_close(ctx);

  if (!g_done)   { printf("VERDICT: timed out\n"); return 1; }
  if (!g_tokens) { printf("VERDICT: no tokens generated\n"); return 1; }
  printf("VERDICT: the engine generated %d token events from real weights\n", g_tokens);
  return 0;
}
