//
//  notify-conformance.test.ts - the SHARED notify corpus through the TS kernel
//  (OpenSource/Conformance/notify/{permission,schedule,channels,presentation,routing}.json).
//  The Kotlin twin (:core NotifyConformanceTest) and the Swift reference (Engine/iOS
//  NotifyCore) run the SAME files, so a reminder cannot fire at 09:00 on one platform and
//  08:00 on another, provisional authorization cannot mean two things, and an undeclared
//  Android channel cannot be a silent drop on one renderer and a typed error on the next.
//
//  Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
//
//  Imported from ../src/notify.ts directly rather than through the package barrel: the barrel
//  is a shared file this workstream does not own (parity/AGENT-CONTRACT.md), and the export
//  line rides in the handoff.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  NOTIFY_STATUSES, NOTIFY_OPTIONS, NOTIFY_DEFAULT_OPTIONS, NOTIFY_PLATFORM_OPTIONS,
  NOTIFY_ANDROID_RUNTIME_PERMISSION_SDK, NOTIFY_CRON_SEARCH_DAYS, NOTIFY_REPEAT_UNITS,
  NOTIFY_IMPORTANCE, NOTIFY_DEFAULT_IMPORTANCE, NOTIFY_PRESENTATION_WORDS,
  NOTIFY_PRESENTATION_ALIASES, NOTIFY_DEFAULT_ACTION_IDS, NOTIFY_DISMISS_ACTION_IDS,
  NOTIFY_PATH_BYTES, NOTIFY_URL_BYTES, NOTIFY_EVENT_BYTES,
  notifyPermissionPlan, notifyApplyPermission, notifyObservePermission,
  notifyFireTimes, notifyChannelFold, notifyChannelRequired, notifyPresentation,
  notifyOpenPayload, notifyRoutingRecord, notifyParseInstant,
  type NotifyPermissionState, type NotifyZoneRules, type NotifyTrigger,
} from "../src/notify.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/notify");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/notify not found");
    dir = parent;
  }
}

function corpus(name: string): { [k: string]: any } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), `${name}.json`), "utf-8")) as { [k: string]: any };
  assert.equal(doc["version"], 1, `${name}.json: version`);
  return doc;
}

// ── permission ────────────────────────────────────────────────────────────────────────

test("notify: the permission vocabulary agrees with the corpus", () => {
  const doc = corpus("permission");
  assert.deepEqual([...NOTIFY_STATUSES], doc["statuses"]);
  assert.deepEqual([...NOTIFY_OPTIONS], doc["options"]);
  assert.deepEqual([...NOTIFY_DEFAULT_OPTIONS], doc["defaultOptions"]);
  assert.equal(NOTIFY_ANDROID_RUNTIME_PERMISSION_SDK, doc["androidRuntimePermissionSdk"]);
  for (const [platform, words] of Object.entries(doc["support"] as Record<string, string[]>)) {
    assert.deepEqual([...(NOTIFY_PLATFORM_OPTIONS[platform] ?? [])], words, `support.${platform}`);
  }
});

test("notify: the permission ladder agrees with the corpus", () => {
  const cases = corpus("permission")["plan"] as any[];
  assert.ok(cases.length > 0, "plan corpus must not be empty");
  for (const testCase of cases) {
    const plan = notifyPermissionPlan(
      testCase.request, testCase.state as NotifyPermissionState,
      testCase.platform, testCase.sdk ?? 0,
    );
    const want = testCase.expect;
    assert.equal(plan.action, want.action, `${testCase.name}: action`);
    assert.equal(plan.prompted, want.prompted ?? plan.prompted, `${testCase.name}: prompted`);
    if (want.quiet !== undefined) assert.equal(plan.quiet, want.quiet, `${testCase.name}: quiet`);
    if (want.escalation !== undefined) assert.equal(plan.escalation, want.escalation, `${testCase.name}: escalation`);
    if (want.status !== undefined) assert.equal(plan.status, want.status, `${testCase.name}: status`);
    if (want.error !== undefined) assert.equal(plan.error, want.error, `${testCase.name}: error`);
    if (want.options !== undefined) assert.deepEqual([...plan.options], want.options, `${testCase.name}: options`);
    if (want.dropped !== undefined) assert.deepEqual([...plan.dropped], want.dropped, `${testCase.name}: dropped`);
  }
});

test("notify: PROVISIONAL never prompts, which is the whole reason it exists", () => {
  const plan = notifyPermissionPlan({ provisional: true }, { status: "undetermined", promptShown: false }, "ios");
  assert.equal(plan.action, "authorize");
  assert.equal(plan.prompted, false);
  assert.equal(plan.quiet, true);
});

test("notify: applying a prompt result agrees with the corpus", () => {
  const cases = corpus("permission")["apply"] as any[];
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    const next = notifyApplyPermission(
      testCase.state as NotifyPermissionState,
      { action: testCase.action, escalation: testCase.escalation === true },
      testCase.granted === true,
    );
    assert.equal(next.status, testCase.expect.status, `${testCase.name}: status`);
    assert.equal(next.promptShown, testCase.expect.promptShown, `${testCase.name}: promptShown`);
  }
});

test("notify: a DECLINED escalation keeps the quiet grant", () => {
  const next = notifyApplyPermission(
    { status: "provisional", promptShown: false }, { action: "prompt", escalation: true }, false,
  );
  assert.equal(next.status, "provisional");
});

test("notify: the Settings-changed-while-backgrounded transition agrees with the corpus", () => {
  const cases = corpus("permission")["observe"] as any[];
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    const observed = notifyObservePermission(testCase.state as NotifyPermissionState, testCase.os);
    assert.equal(observed.state.status, testCase.expect.status, `${testCase.name}: status`);
    assert.equal(observed.state.promptShown, testCase.expect.promptShown, `${testCase.name}: promptShown`);
    assert.equal(observed.changed, testCase.expect.changed, `${testCase.name}: changed`);
    assert.equal(observed.broadcast, testCase.expect.broadcast, `${testCase.name}: broadcast`);
  }
});

test("notify: the whole ladder runs as a sequence, not just as isolated transitions", () => {
  const runs = corpus("permission")["sequence"] as any[];
  assert.ok(runs.length > 0);
  for (const run of runs) {
    let state: NotifyPermissionState = { status: "undetermined", promptShown: false };
    let plan = notifyPermissionPlan({}, state, run.platform);
    for (const step of run.steps as any[]) {
      const label = `${run.name} / ${step.do}`;
      if (step.do === "plan") {
        plan = notifyPermissionPlan(step.request, state, run.platform, run.sdk ?? 0);
        assert.equal(plan.action, step.expect.action, `${label}: action`);
        if (step.expect.quiet !== undefined) assert.equal(plan.quiet, step.expect.quiet, `${label}: quiet`);
        if (step.expect.escalation !== undefined) assert.equal(plan.escalation, step.expect.escalation, `${label}: escalation`);
        if (step.expect.status !== undefined) assert.equal(plan.status, step.expect.status, `${label}: status`);
        if (step.expect.error !== undefined) assert.equal(plan.error, step.expect.error, `${label}: error`);
      } else if (step.do === "apply") {
        state = notifyApplyPermission(state, plan, step.granted === true);
        assert.equal(state.status, step.expect.status, `${label}: status`);
      } else {
        const observed = notifyObservePermission(state, step.os);
        state = observed.state;
        assert.equal(state.status, step.expect.status, `${label}: status`);
        if (step.expect.broadcast !== undefined) assert.equal(observed.broadcast, step.expect.broadcast, `${label}: broadcast`);
      }
    }
  }
});

// ── the trigger resolver ──────────────────────────────────────────────────────────────

function zones(): Record<string, NotifyZoneRules> {
  return corpus("schedule")["zones"] as Record<string, NotifyZoneRules>;
}

test("notify: the schedule vocabulary agrees with the corpus", () => {
  const doc = corpus("schedule");
  assert.equal(NOTIFY_CRON_SEARCH_DAYS, doc["searchDays"]);
  assert.deepEqual([...NOTIFY_REPEAT_UNITS], doc["units"]);
});

test("notify: every fire time agrees with the corpus, DST boundaries and leap day included", () => {
  const doc = corpus("schedule");
  const table = zones();
  const cases = doc["resolve"] as any[];
  assert.ok(cases.length > 0, "resolve corpus must not be empty");
  for (const testCase of cases) {
    const zone = table[testCase.zone] ?? null;
    const plan = notifyFireTimes(testCase.trigger as NotifyTrigger, testCase.from, zone, testCase.count);
    assert.equal(plan.ok, true, `${testCase.name}: expected a resolution`);
    if (plan.ok !== true) continue;
    assert.equal(plan.kind, testCase.expect.kind, `${testCase.name}: kind`);
    assert.deepEqual([...plan.fires], testCase.expect.fires, `${testCase.name}: fires`);
    if (testCase.expect.exhausted !== undefined) {
      assert.equal(plan.exhausted, testCase.expect.exhausted, `${testCase.name}: exhausted`);
    }
  }
});

test("notify: every rejected trigger agrees with the corpus", () => {
  const cases = corpus("schedule")["reject"] as any[];
  assert.ok(cases.length > 0);
  const utc = zones()["UTC"]!;
  for (const testCase of cases) {
    const plan = notifyFireTimes(testCase.trigger as NotifyTrigger, 1767225600000, utc, 3);
    assert.equal(plan.ok, false, `${testCase.name}: expected a refusal`);
    if (plan.ok === false) assert.equal(plan.error, testCase.expect.error, `${testCase.name}: error`);
  }
});

test("notify: the spring-forward gap moves a fire, it never drops one", () => {
  const table = zones();
  const plan = notifyFireTimes({ cron: "30 2 * * *" }, 1772798400000, table["America/New_York"]!, 4);
  assert.equal(plan.ok, true);
  if (plan.ok !== true) return;
  assert.equal(plan.fires.length, 4, "four days, four fires - none skipped");
});

test("notify: an ISO instant without a zone is refused rather than guessed at", () => {
  assert.equal(notifyParseInstant("2026-06-01T12:00:00"), null);
  assert.equal(notifyParseInstant("2026-06-01T12:00:00Z"), 1780315200000);
  assert.equal(notifyParseInstant("2026-06-01T14:00:00+02:00"), 1780315200000);
});

// ── channels ──────────────────────────────────────────────────────────────────────────

test("notify: the importance table agrees with the corpus", () => {
  const doc = corpus("channels");
  assert.deepEqual(NOTIFY_IMPORTANCE.map((e) => ({ ...e })), doc["importance"]);
  assert.equal(NOTIFY_DEFAULT_IMPORTANCE, doc["defaultImportance"]);
});

test("notify: the channel fold agrees with the corpus", () => {
  const cases = corpus("channels")["fold"] as any[];
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    const fold = notifyChannelFold(testCase.existing, testCase.requested);
    if (testCase.expect.error !== undefined) {
      assert.equal(fold.ok, false, `${testCase.name}: expected a refusal`);
      if (fold.ok === false) assert.equal(fold.error, testCase.expect.error, `${testCase.name}: error`);
      continue;
    }
    assert.equal(fold.ok, true, `${testCase.name}: expected a fold`);
    if (fold.ok !== true) continue;
    assert.equal(fold.importance, testCase.expect.importance, `${testCase.name}: importance`);
    assert.equal(fold.created, testCase.expect.created, `${testCase.name}: created`);
    assert.equal(fold.changed, testCase.expect.changed, `${testCase.name}: changed`);
    assert.equal(fold.lockedByUser, testCase.expect.lockedByUser, `${testCase.name}: lockedByUser`);
    if (testCase.expect.blocked !== undefined) {
      assert.equal(fold.blocked, testCase.expect.blocked, `${testCase.name}: blocked`);
    }
  }
});

test("notify: the channel_required gate agrees with the corpus", () => {
  const cases = corpus("channels")["required"] as any[];
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    const verdict = notifyChannelRequired(testCase.platform, testCase.sdk ?? 0, testCase.channel, testCase.known);
    assert.equal(verdict.ok, testCase.expect.ok, `${testCase.name}: ok`);
    if (verdict.ok === true) {
      assert.equal(verdict.channel, testCase.expect.channel, `${testCase.name}: channel`);
    } else {
      assert.equal(verdict.error, testCase.expect.error, `${testCase.name}: error`);
      assert.equal(verdict.channel, testCase.expect.channel, `${testCase.name}: the refusal NAMES the id`);
    }
  }
});

// ── presentation ──────────────────────────────────────────────────────────────────────

test("notify: the presentation vocabulary agrees with the corpus", () => {
  const doc = corpus("presentation");
  assert.deepEqual([...NOTIFY_PRESENTATION_WORDS], doc["words"]);
  assert.deepEqual({ ...NOTIFY_PRESENTATION_ALIASES }, doc["aliases"]);
  assert.deepEqual(doc["default"], []);
});

test("notify: the foreground fold agrees with the corpus", () => {
  const cases = corpus("presentation")["fold"] as any[];
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    const fold = notifyPresentation(testCase.configured, testCase.claimed === true, testCase.platform, testCase.importance);
    if (testCase.expect.error !== undefined) {
      assert.equal(fold.ok, false, `${testCase.name}: expected a refusal`);
      if (fold.ok === false) assert.equal(fold.error, testCase.expect.error, `${testCase.name}: error`);
      continue;
    }
    assert.equal(fold.ok, true, `${testCase.name}: expected a fold`);
    if (fold.ok !== true) continue;
    assert.deepEqual([...fold.present], testCase.expect.present, `${testCase.name}: present`);
    assert.equal(fold.suppressed, testCase.expect.suppressed, `${testCase.name}: suppressed`);
    assert.equal(fold.headsUp, testCase.expect.headsUp, `${testCase.name}: headsUp`);
    assert.deepEqual([...fold.dropped], testCase.expect.dropped ?? [], `${testCase.name}: dropped`);
    assert.deepEqual([...fold.degraded], testCase.expect.degraded ?? [], `${testCase.name}: degraded`);
  }
});

test("notify: a claimed notify.received suppresses the presentation on every platform", () => {
  for (const platform of ["ios", "android", "web"]) {
    const fold = notifyPresentation(["alert", "sound"], true, platform, "high");
    assert.equal(fold.ok, true);
    if (fold.ok !== true) continue;
    assert.equal(fold.suppressed, true, platform);
    assert.deepEqual([...fold.present], [], platform);
  }
});

// ── routing ───────────────────────────────────────────────────────────────────────────

test("notify: the routing vocabulary agrees with the corpus", () => {
  const doc = corpus("routing");
  assert.deepEqual([...NOTIFY_DEFAULT_ACTION_IDS], doc["defaultActionIds"]);
  assert.deepEqual([...NOTIFY_DISMISS_ACTION_IDS], doc["dismissActionIds"]);
  assert.equal(NOTIFY_PATH_BYTES, doc["bounds"]["path"]);
  assert.equal(NOTIFY_URL_BYTES, doc["bounds"]["url"]);
  assert.equal(NOTIFY_EVENT_BYTES, doc["bounds"]["event"]);
});

test("notify: every tap shape normalises to the same payload", () => {
  const cases = corpus("routing")["open"] as any[];
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    const payload = notifyOpenPayload(testCase.raw, testCase.coldStart === true);
    assert.equal(payload.kind, testCase.expect.kind, `${testCase.name}: kind`);
    assert.equal(payload.id, testCase.expect.id, `${testCase.name}: id`);
    if (testCase.expect.kind === "dismissed") continue;
    assert.deepEqual(payload.data, testCase.expect.data, `${testCase.name}: data`);
    assert.equal(payload.coldStart, testCase.expect.coldStart, `${testCase.name}: coldStart`);
    assert.equal(payload.actionId, testCase.expect.actionId, `${testCase.name}: actionId`);
    assert.equal(payload.userText, testCase.expect.userText, `${testCase.name}: userText`);
  }
});

test("notify: the PushRouting record agrees with the corpus, bounds and all", () => {
  const doc = corpus("routing");
  const repeat = doc["repeatToken"] as { token: string; char: string; count: number };
  const cases = doc["record"] as any[];
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(testCase.payload.data as Record<string, unknown>)) {
      data[key] = typeof value === "string"
        ? value.replace(repeat.token, repeat.char.repeat(repeat.count))
        : value;
    }
    const record = notifyRoutingRecord({ data });
    assert.equal(record.path, testCase.expect.path, `${testCase.name}: path`);
    assert.equal(record.url, testCase.expect.url, `${testCase.name}: url`);
  }
});
