// governor_test.cpp - the resource governor's decisions, all of them cheap.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The governor decides what gets evicted and how hard to push, and every one of
// those decisions is arithmetic over recorded state. None of it needs a model,
// a device or a thermometer, which is exactly why it should be pinned here:
// under real pressure these paths run once, at the worst possible moment, on a
// device nobody is attached to.

#include <cstdio>
#include <string>
#include <vector>

#include "../src/governor.hpp"
#include "../src/json.hpp"

using despia::ai::Governor;
using despia::ai::Pressure;
using despia::ai::Priority;
namespace json = despia::json;

namespace {

int g_failures = 0;

void check(bool cond, const char* what) {
  if (cond) {
    std::printf("  ok   %s\n", what);
  } else {
    std::printf("  FAIL %s\n", what);
    g_failures++;
  }
}

const uint64_t MB = 1024ull * 1024ull;

// An open-config exactly as `despia_ai_open` receives it, parsed the same way.
json::Value config(const std::string& text) {
  std::string err;
  json::Value parsed = json::parse(text, &err);
  if (!err.empty()) {
    std::printf("  FAIL the fixture itself is not JSON: %s\n", err.c_str());
    g_failures++;
  }
  return parsed;
}

}  // namespace

int main() {
  std::printf("governor_test\n");

  // ── priority parsing ───────────────────────────────────────────────────────
  {
    check(despia::ai::priorityFromString("background") == Priority::Background,
          "background parses");
    check(despia::ai::priorityFromString("interactive") == Priority::Interactive,
          "interactive parses");
    // A typo must not silently deprioritise a user-facing request. That failure
    // would present as "the app is sometimes slow", not as a bug.
    check(despia::ai::priorityFromString("intractive") == Priority::Interactive,
          "an unknown spelling is interactive, never background");
    check(despia::ai::priorityFromString("") == Priority::Interactive,
          "so is an absent one");
  }

  // ── accounting ─────────────────────────────────────────────────────────────
  {
    Governor g;
    g.noteLoaded("a", 100 * MB);
    g.noteLoaded("b", 50 * MB);
    check(g.residentBytes() == 150 * MB, "resident bytes are the sum");
    check(g.residentCount() == 2, "and the count is the count");
    g.noteUnloaded("a");
    check(g.residentBytes() == 50 * MB, "unloading removes its charge");
    g.noteLoaded("b", 70 * MB);
    check(g.residentBytes() == 70 * MB,
          "re-loading the same id replaces its charge rather than adding to it");
  }

  // ── eviction: LRU, and never the model being loaded ────────────────────────
  {
    Governor g;
    g.setBudget(200 * MB);
    g.noteLoaded("old", 80 * MB);
    g.noteLoaded("new", 80 * MB);
    g.noteUsed("old");  // "old" is now the most recent, despite the name

    const std::vector<std::string> order = g.evictionOrder(80 * MB, "");
    check(order.size() == 1 && order[0] == "new",
          "the least recently USED goes first, not the least recently loaded");
  }
  {
    // A RELOAD: "self" is already resident at 60 MB and is being reloaded
    // bigger. Its old charge is replaced, not added to, and it must never
    // appear in its own eviction list.
    Governor g;
    g.setBudget(100 * MB);
    g.noteLoaded("self", 60 * MB);
    g.noteLoaded("other", 30 * MB);
    const std::vector<std::string> order = g.evictionOrder(80 * MB, "self");
    check(order.size() == 1 && order[0] == "other",
          "the model being loaded is never evicted to make room for itself");
  }
  {
    // The same reload, but now it fits once the old charge is discounted.
    // Double-counting would evict "other" for memory handed back moments later.
    Governor g;
    g.setBudget(100 * MB);
    g.noteLoaded("self", 60 * MB);
    g.noteLoaded("other", 30 * MB);
    check(g.evictionOrder(60 * MB, "self").empty(),
          "a reload replaces its own charge rather than adding to it");
  }
  {
    Governor g;
    g.setBudget(500 * MB);
    g.noteLoaded("a", 100 * MB);
    check(g.evictionOrder(100 * MB, "").empty(),
          "nothing is evicted when it already fits");
  }
  {
    Governor g;  // budget 0
    g.noteLoaded("a", 10000 * MB);
    check(g.evictionOrder(10000 * MB, "").empty(),
          "an unbounded budget never evicts");
  }
  {
    // The incoming model does not fit even in an empty context. Evicting
    // everything would lose every resident model and STILL not fit, so the
    // governor declines to do it and leaves the refusal to the fit function.
    Governor g;
    g.setBudget(100 * MB);
    g.noteLoaded("a", 40 * MB);
    g.noteLoaded("b", 40 * MB);
    check(g.evictionOrder(500 * MB, "").empty(),
          "a model that cannot fit at all evicts nothing rather than everything");
  }
  {
    // Evict only as far as needed: two of three, not all three.
    Governor g;
    g.setBudget(300 * MB);
    g.noteLoaded("first", 100 * MB);
    g.noteLoaded("second", 100 * MB);
    g.noteLoaded("third", 100 * MB);
    const std::vector<std::string> order = g.evictionOrder(200 * MB, "");
    check(order.size() == 2 && order[0] == "first" && order[1] == "second",
          "eviction stops as soon as the incoming model fits");
  }

  // ── ARMING: the config a host actually passes ──────────────────────────────
  //
  // Everything above tests the MECHANISM, and the mechanism was never the
  // problem: it worked, and it ran in no shipping configuration because nothing
  // called setBudget. So these cases start where `despia_ai_open` starts - at
  // an open-config document - and assert that a budget written there reaches
  // the eviction decision, and that one NOT written there leaves it unbounded.
  {
    // ARMED. A budget that fits one 400 MB model and not two.
    const json::Value cfg = config(
        "{\"schema_version\":1,\"state_dir\":\"/tmp/x\","
        "\"limits\":{\"max_runtime_bytes\":524288000}}");
    Governor g;
    std::string why;
    check(despia::ai::armGovernor(g, cfg["limits"], &why),
          "a well-formed limits object arms without complaint");

    g.noteLoaded("first", 400 * MB);
    const std::vector<std::string> order = g.evictionOrder(400 * MB, "second");
    check(order.size() == 1 && order[0] == "first",
          "a context opened WITH limits evicts: the second 400 MB model drops the first");
  }
  {
    // UNARMED, and this is the case that shipped. The same two loads, the same
    // governor, a config with no `limits` at all - nothing is evicted, forever.
    const json::Value cfg = config("{\"schema_version\":1,\"state_dir\":\"/tmp/x\"}");
    Governor g;
    std::string why;
    check(despia::ai::armGovernor(g, cfg["limits"], &why),
          "an absent limits object is not an error");

    g.noteLoaded("first", 400 * MB);
    check(g.evictionOrder(400 * MB, "second").empty(),
          "a context opened WITHOUT limits stays unbounded and evicts nothing");
  }
  {
    // `limits` present but silent about residency. Unbounded, same as absent -
    // an engine that grew a second limit key must not arm this one by accident.
    const json::Value cfg = config("{\"limits\":{\"max_parallel\":1}}");
    Governor g;
    std::string why;
    check(despia::ai::armGovernor(g, cfg["limits"], &why) &&
              g.evictionOrder(10000 * MB, "").empty(),
          "a limits object that names no budget leaves it unbounded");
  }
  {
    // 0 is a DOCUMENTED value, not an absence: it is what a desktop host writes
    // to say "never evict", and it must not be mistaken for a refusal.
    const json::Value cfg = config("{\"limits\":{\"max_runtime_bytes\":0}}");
    Governor g;
    std::string why;
    check(despia::ai::armGovernor(g, cfg["limits"], &why), "an explicit 0 is legal");
    g.noteLoaded("a", 10000 * MB);
    check(g.evictionOrder(10000 * MB, "").empty(), "and it means unbounded");
  }
  {
    // The boundary rule the rest of the config follows: a KNOWN field of the
    // wrong type is a refusal, never a silently-ignored one. A budget that was
    // meant to be set and was quietly dropped is this whole defect again.
    Governor g;
    std::string why;
    const json::Value text = config("{\"limits\":{\"max_runtime_bytes\":\"512MB\"}}");
    check(!despia::ai::armGovernor(g, text["limits"], &why) && !why.empty(),
          "a budget that is not a number is refused, and says so");

    why.clear();
    const json::Value negative = config("{\"limits\":{\"max_runtime_bytes\":-1}}");
    check(!despia::ai::armGovernor(g, negative["limits"], &why) && !why.empty(),
          "so is a negative one, rather than clamping a typo into an unbounded context");

    why.clear();
    const json::Value huge = config("{\"limits\":{\"max_runtime_bytes\":1e999}}");
    check(!despia::ai::armGovernor(g, huge["limits"], &why),
          "and an infinity, which is what 1e999 parses to");
  }
  {
    // A number past the width of the accounting is functionally unbounded and is
    // clamped rather than refused - refusing it would be pedantry, and a host
    // that computed 64 GB on a workstation deserves an answer.
    const json::Value cfg = config("{\"limits\":{\"max_runtime_bytes\":1e30}}");
    Governor g;
    std::string why;
    check(despia::ai::armGovernor(g, cfg["limits"], &why), "an implausibly large budget is clamped");
    g.noteLoaded("a", 100 * MB);
    check(g.evictionOrder(100 * MB, "").empty(), "and nothing is evicted under it");
  }

  // ── pressure ───────────────────────────────────────────────────────────────
  {
    Governor g;
    check(g.threadsFor(Priority::Interactive, 8) == 8,
          "a cold device gives an interactive request every core");
    check(g.threadsFor(Priority::Background, 8) == 4,
          "background gets half even when cold, so it cannot cause a stutter");

    g.setPressure(Pressure::Elevated);
    check(g.threadsFor(Priority::Interactive, 8) == 4, "elevated halves it");
    check(g.threadsFor(Priority::Background, 8) == 2, "and halves background again");

    g.setPressure(Pressure::Critical);
    check(g.threadsFor(Priority::Interactive, 8) == 1,
          "critical drops to one thread: the OS is already throttling");
    check(g.threadsFor(Priority::Background, 8) == 1, "for both classes");
  }
  {
    Governor g;
    check(g.threadsFor(Priority::Interactive, 0) == 4,
          "an unknown core count falls back to a safe default");
    check(g.threadsFor(Priority::Background, 1) == 1,
          "and the result is never zero threads");
  }
  {
    Governor g;
    check(!g.shouldDefer(Priority::Background), "nothing is deferred when nominal");
    g.setPressure(Pressure::Critical);
    check(g.shouldDefer(Priority::Background),
          "background admission is deferred at critical");
    check(!g.shouldDefer(Priority::Interactive),
          "but an interactive request is never deferred, however hot the device");
  }
  {
    check(despia::ai::pressureFromString("critical") == Pressure::Critical,
          "critical parses");
    check(despia::ai::pressureFromString("elevated") == Pressure::Elevated,
          "elevated parses");
    check(despia::ai::pressureFromString("banana") == Pressure::Nominal,
          "an unknown pressure is nominal, so a bad string cannot throttle a device");
  }

  if (g_failures == 0) {
    std::printf("\nall checks passed\n");
    return 0;
  }
  std::printf("\n%d failure(s)\n", g_failures);
  return 1;
}
