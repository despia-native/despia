//
//  geo-conformance.test.ts - the SHARED geo corpus through the TS kernel
//  (OpenSource/Conformance/geo/{permission,geofence,watch}.json). The Kotlin twin (:core
//  GeoConformanceTest) and the Swift twin (Engine/iOS GeoPolicy) run the SAME files, so the
//  permission ladder, the region cap and the battery filter cannot mean one thing on one
//  renderer and something else on another: a cold `always` is refused everywhere, the
//  twenty-first region is a typed error everywhere, and a distanceFilter actually suppresses
//  callbacks everywhere.
//
//  Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
//
//  Imported from ../src/geo.ts directly rather than through the package barrel: the barrel is
//  a shared file this workstream does not own (parity/AGENT-CONTRACT.md), and the export line
//  rides in the handoff.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  GEO_STATUSES, GEO_LEVELS, GEO_REGION_CAPS, GEO_ACCURACIES, GEO_DEFAULT_ACCURACY,
  geoPermissionPlan, geoApplyPermission, geoEscalationRoute, geoPreciseOutcome,
  geoRadius, GeoRegionSet, geoDeliveryPlan, geoAccuracy, geoDistanceMeters,
  geoShouldDeliver, geoCacheServes,
  type GeoPermissionState, type GeoFix,
} from "../src/geo.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/geo");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/geo not found");
    dir = parent;
  }
}

function corpus(name: string): { [k: string]: unknown } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), `${name}.json`), "utf-8")) as { [k: string]: unknown };
  assert.equal(doc["version"], 1, `${name}.json: version`);
  return doc;
}

test("geo: the permission vocabulary agrees with the corpus", () => {
  const doc = corpus("permission");
  assert.deepEqual([...GEO_STATUSES], doc["statuses"]);
  assert.deepEqual([...GEO_LEVELS], doc["levels"]);
});

test("geo: the permission ladder agrees with the corpus", () => {
  type Case = { name: string; level: string; state: GeoPermissionState; expect: { [k: string]: unknown } };
  const cases = corpus("permission")["plan"] as Case[];
  assert.ok(cases.length > 0, "plan corpus must not be empty");
  for (const testCase of cases) {
    const plan = geoPermissionPlan(testCase.level, testCase.state);
    assert.equal(plan.action, testCase.expect["action"], `${testCase.name}: action`);
    if (plan.action === "prompt") {
      assert.equal(plan.prompt, testCase.expect["prompt"], `${testCase.name}: prompt`);
    } else if (plan.action === "settle") {
      assert.equal(plan.status, testCase.expect["status"], `${testCase.name}: status`);
      assert.equal(plan.prompted, testCase.expect["prompted"], `${testCase.name}: prompted`);
    } else {
      assert.equal(plan.error, testCase.expect["error"], `${testCase.name}: refusal code`);
    }
  }
});

test("geo: a cold always request is refused, which is the whole ladder", () => {
  const cold = geoPermissionPlan("always", { status: "notDetermined", escalationOffered: false });
  assert.equal(cold.action, "refuse");
  assert.equal(cold.action === "refuse" && cold.error, "escalation_required");
});

test("geo: applying a prompt result agrees with the corpus", () => {
  type Case = {
    name: string; state: GeoPermissionState; prompted: string; granted: boolean;
    expect: { status: string; escalationOffered: boolean };
  };
  const cases = corpus("permission")["apply"] as Case[];
  assert.ok(cases.length > 0, "apply corpus must not be empty");
  for (const testCase of cases) {
    const next = geoApplyPermission(testCase.state, testCase.prompted, testCase.granted);
    assert.equal(next.status, testCase.expect.status, `${testCase.name}: status`);
    assert.equal(next.escalationOffered, testCase.expect.escalationOffered, `${testCase.name}: escalationOffered`);
  }
});

test("geo: the escalation route agrees with the corpus, Android split included", () => {
  type Case = { name: string; platform: string; sdk: number; expect: string };
  const cases = corpus("permission")["route"] as Case[];
  assert.ok(cases.length > 0, "route corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(geoEscalationRoute(testCase.platform, testCase.sdk), testCase.expect, testCase.name);
  }
});

test("geo: the precise-location decision agrees with the corpus", () => {
  type Case = { name: string; requested: boolean; granted: boolean; expect: { ok: boolean; precise?: boolean; error?: string } };
  const cases = corpus("permission")["precise"] as Case[];
  assert.ok(cases.length > 0, "precise corpus must not be empty");
  for (const testCase of cases) {
    const outcome = geoPreciseOutcome(testCase.requested, testCase.granted);
    assert.equal(outcome.ok, testCase.expect.ok, `${testCase.name}: ok`);
    if (outcome.ok) assert.equal(outcome.precise, testCase.expect.precise, `${testCase.name}: precise`);
    else assert.equal(outcome.error, testCase.expect.error, `${testCase.name}: error`);
  }
});

test("geo: the region caps agree with the corpus", () => {
  assert.deepEqual({ ...GEO_REGION_CAPS }, corpus("geofence")["caps"]);
});

test("geo: region accounting agrees with the corpus, region_limit included", () => {
  type Op = { add?: string; remove?: string; list?: boolean };
  type Case = { name: string; cap: number; ops: Op[]; expect: { [k: string]: unknown }[] };
  const cases = corpus("geofence")["regions"] as Case[];
  assert.ok(cases.length > 0, "regions corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(testCase.ops.length, testCase.expect.length, `${testCase.name}: one expectation per op`);
    const regions = new GeoRegionSet(testCase.cap);
    testCase.ops.forEach((op, index) => {
      const expected = testCase.expect[index]!;
      const where = `${testCase.name}: op ${index}`;
      if (op.list === true) {
        assert.deepEqual(regions.list(), expected["ids"], `${where}: ids`);
        assert.equal(regions.count, expected["count"], `${where}: count`);
        return;
      }
      const result = op.add !== undefined ? regions.add(op.add) : regions.remove(op.remove);
      assert.equal(result.ok, expected["ok"], `${where}: ok`);
      if (result.ok !== true) {
        assert.equal(result.error, expected["error"], `${where}: error`);
        if (expected["limit"] !== undefined) assert.equal(result.limit, expected["limit"], `${where}: limit`);
        if (expected["count"] !== undefined) assert.equal(result.count, expected["count"], `${where}: count`);
        return;
      }
      assert.equal(result.id, expected["id"], `${where}: id`);
      assert.equal(result.count, expected["count"], `${where}: count`);
      if (expected["removed"] !== undefined) assert.equal(result.removed, expected["removed"], `${where}: removed`);
    });
  }
});

test("geo: the radius clamp agrees with the corpus", () => {
  type Case = { name: string; radius: number; expect: { radius: number; clamped: boolean } };
  const cases = corpus("geofence")["radius"] as Case[];
  assert.ok(cases.length > 0, "radius corpus must not be empty");
  for (const testCase of cases) {
    const clamped = geoRadius(testCase.radius);
    assert.equal(clamped.radius, testCase.expect.radius, `${testCase.name}: radius`);
    assert.equal(clamped.clamped, testCase.expect.clamped, `${testCase.name}: clamped`);
  }
});

test("geo: a crossing reaches a background task with no screen mounted", () => {
  type Case = {
    name: string; task: string | null; screenMounted: boolean;
    expect: { broadcast: boolean; background: boolean; foreground: boolean };
  };
  const cases = corpus("geofence")["delivery"] as Case[];
  assert.ok(cases.length > 0, "delivery corpus must not be empty");
  for (const testCase of cases) {
    const plan = geoDeliveryPlan(testCase.task, testCase.screenMounted);
    assert.equal(plan.broadcast, testCase.expect.broadcast, `${testCase.name}: broadcast`);
    assert.equal(plan.background, testCase.expect.background, `${testCase.name}: background`);
    assert.equal(plan.foreground, testCase.expect.foreground, `${testCase.name}: foreground`);
  }
});

test("geo: the accuracy vocabulary agrees with the corpus", () => {
  const doc = corpus("watch");
  assert.deepEqual(GEO_ACCURACIES.map((entry) => ({ ...entry })), doc["accuracy"]);
  assert.equal(GEO_DEFAULT_ACCURACY, doc["defaultAccuracy"]);

  type Case = { name: string; word: string | null; expect: { word?: string; error?: string } };
  for (const testCase of doc["accuracyFold"] as Case[]) {
    const resolved = geoAccuracy(testCase.word);
    if (testCase.expect.error !== undefined) {
      assert.equal(resolved.ok, false, `${testCase.name}: expected a refusal`);
      assert.equal(resolved.ok === false && resolved.error, testCase.expect.error, `${testCase.name}: error`);
      continue;
    }
    assert.equal(resolved.ok, true, `${testCase.name}: expected a resolved accuracy`);
    assert.equal(resolved.ok === true && resolved.value.word, testCase.expect.word, `${testCase.name}: word`);
  }
});

test("geo: great-circle distance agrees with the corpus", () => {
  type Case = {
    name: string; from: { lat: number; lon: number }; to: { lat: number; lon: number };
    expectMeters: number; toleranceMeters: number;
  };
  const cases = corpus("watch")["distance"] as Case[];
  assert.ok(cases.length > 0, "distance corpus must not be empty");
  for (const testCase of cases) {
    const meters = geoDistanceMeters(testCase.from.lat, testCase.from.lon, testCase.to.lat, testCase.to.lon);
    assert.ok(
      Math.abs(meters - testCase.expectMeters) <= testCase.toleranceMeters,
      `${testCase.name}: ${meters} is not within ${testCase.toleranceMeters} of ${testCase.expectMeters}`,
    );
  }
});

test("geo: distanceFilter measurably reduces callbacks", () => {
  type Case = {
    name: string; last: GeoFix | null; next: GeoFix; distanceFilter: number; interval: number;
    expect: { deliver: boolean; reason?: string };
  };
  const cases = corpus("watch")["filter"] as Case[];
  assert.ok(cases.length > 0, "filter corpus must not be empty");
  let suppressed = 0;
  for (const testCase of cases) {
    const verdict = geoShouldDeliver(testCase.last, testCase.next, testCase.distanceFilter, testCase.interval);
    assert.equal(verdict.deliver, testCase.expect.deliver, `${testCase.name}: deliver`);
    if (testCase.expect.reason !== undefined) {
      assert.equal(verdict.reason, testCase.expect.reason, `${testCase.name}: reason`);
    }
    if (!verdict.deliver) suppressed += 1;
  }
  assert.ok(suppressed > 0, "the corpus must prove that a filter actually suppresses something");
});

test("geo: a stale cached fix is refused rather than served as current", () => {
  type Case = { name: string; ageMs: number; maxAgeMs: number; expect: { serve: boolean; error?: string } };
  const cases = corpus("watch")["maxAge"] as Case[];
  assert.ok(cases.length > 0, "maxAge corpus must not be empty");
  for (const testCase of cases) {
    assert.equal(geoCacheServes(testCase.ageMs, testCase.maxAgeMs), testCase.expect.serve, testCase.name);
  }
});
