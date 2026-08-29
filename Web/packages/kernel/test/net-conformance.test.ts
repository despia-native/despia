//
//  net-conformance.test.ts — the SHARED connectivity corpus through the TS kernel
//  (OpenSource/Conformance/net/{status,transitions}.json). The Kotlin twin (:core
//  NetConformanceTest) and the Swift reference (NetConformance, record lane) run the SAME
//  files, so a captive portal, a personal hotspot and a flapping interface cannot mean one
//  thing on one renderer and something else on another.
//
//  Missing corpus = loud failure, and so is an empty section: a silently-skipped conformance
//  suite is how drift starts, and a runner that reads three of five case arrays is the same
//  defect in a new place.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  classifyPath, isOnline, radioGeneration, probeReachable, NetDebounce, type NetSnapshot,
} from "../src/net-core.ts";

type Json = { [key: string]: any };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/net");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/net not found");
    dir = parent;
  }
}

function corpus(file: string): Json {
  const doc = JSON.parse(readFileSync(join(corpusDir(), file), "utf-8")) as Json;
  assert.equal(doc["version"], 1, `${file}: version`);
  return doc;
}

function section(doc: Json, name: string, file: string): Json[] {
  const raw = doc[name];
  const rows = Array.isArray(raw) ? raw : (raw as Json | undefined)?.["cases"];
  assert.ok(Array.isArray(rows) && rows.length > 0, `${file}: ${name} must be a non-empty case array`);
  return rows as Json[];
}

test("net: the classification fold agrees with the corpus", () => {
  const doc = corpus("status.json");
  for (const testCase of section(doc, "classify", "status.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const actual = classifyPath({
      satisfied: given["satisfied"] === true,
      interfaces: given["interfaces"] as string[],
      transports: given["transports"] as string[],
      metered: given["metered"] === true,
      dataSaver: given["dataSaver"] === true,
    });
    assert.equal(actual.reachable, expect["reachable"], `${testCase["name"]}: reachable`);
    assert.equal(actual.type, expect["type"], `${testCase["name"]}: type`);
    assert.equal(actual.expensive, expect["expensive"], `${testCase["name"]}: expensive`);
    assert.equal(actual.constrained, expect["constrained"], `${testCase["name"]}: constrained`);
  }
});

test("net: the online split agrees with the corpus", () => {
  const doc = corpus("status.json");
  for (const testCase of section(doc, "online", "status.json")) {
    const given = testCase["given"] as Json;
    const snapshot: NetSnapshot = {
      reachable: given["reachable"] === true,
      type: given["reachable"] === true ? "wifi" : "none",
      expensive: false,
      constrained: false,
      validated: true,
    };
    assert.equal(
      isOnline(snapshot, given["probeFailed"] === true),
      (testCase["expect"] as Json)["online"],
      `${testCase["name"]}: online`,
    );
  }
});

test("net: the radio-family map agrees with the corpus", () => {
  const doc = corpus("status.json");
  for (const testCase of section(doc, "generation", "status.json")) {
    const given = testCase["given"] as Json;
    assert.equal(
      radioGeneration(given["type"] as string, given["radio"] as string | null),
      (testCase["expect"] as Json)["generation"],
      `${testCase["name"]}: generation`,
    );
  }
});

test("net: the probe verdict agrees with the corpus", () => {
  const doc = corpus("status.json");
  for (const testCase of section(doc, "probe", "status.json")) {
    const given = testCase["given"] as Json;
    assert.equal(
      probeReachable(given["status"] as number, given["requestHost"] as string, given["location"] as string | null),
      (testCase["expect"] as Json)["reachable"],
      `${testCase["name"]}: reachable`,
    );
  }
});

test("net: the debounce timelines agree with the corpus", () => {
  const doc = corpus("transitions.json");
  const debounceMs = doc["debounceMs"] as number;
  assert.equal(typeof debounceMs, "number", "transitions.json: debounceMs");

  for (const timeline of section(doc, "timelines", "transitions.json")) {
    const name = timeline["name"] as string;
    const steps = timeline["steps"] as Json[];
    assert.ok(Array.isArray(steps) && steps.length > 0, `${name}: no steps`);
    const machine = new NetDebounce(debounceMs);
    const emitted: Json[] = [];

    for (const step of steps) {
      const at = step["at"] as number;
      machine.advance(at);
      if (step["path"] !== undefined && step["path"] !== null) {
        const path = step["path"] as Json;
        machine.path(at, {
          reachable: path["reachable"] === true,
          type: path["type"] as string,
          expensive: path["expensive"] === true,
          constrained: path["constrained"] === true,
          validated: true,
        });
      } else if (step["probeFailed"] !== undefined) {
        machine.probe(at, step["probeFailed"] === true);
      }
      for (const change of machine.drain()) {
        emitted.push({
          at: change.at,
          event: "change",
          data: {
            online: change.online,
            reachable: change.snapshot.reachable,
            type: change.snapshot.type,
            expensive: change.snapshot.expensive,
            constrained: change.snapshot.constrained,
            previous: change.previous,
          },
        });
      }
    }

    const expect = timeline["expect"] as Json;
    assert.deepEqual(emitted, expect["events"], `${name}: events`);
    const context = expect["context"] as Json;
    assert.equal(machine.online, context["online"], `${name}: context.online`);
    assert.equal(machine.settled.type, context["type"], `${name}: context.type`);
    assert.equal(machine.settled.expensive, context["expensive"], `${name}: context.expensive`);
    assert.equal(machine.settled.constrained, context["constrained"], `${name}: context.constrained`);
  }
});
