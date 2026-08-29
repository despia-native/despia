//
//  compose-conformance.test.ts — the SHARED composer corpus through the TS kernel
//  (OpenSource/Conformance/compose/result.json). The Kotlin twin (:core
//  ComposeConformanceTest) and the Swift reference (ComposeConformance, record lane) run the
//  SAME file, so `unknown` cannot quietly become `sent` on the renderer that never learns what
//  the user did.
//
//  Missing corpus = loud failure, and so is an empty section.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  COMPOSE_RESULTS, COMPOSE_RESULT_FIDELITY, COMPOSE_PERMISSION_SURFACE,
  COMPOSE_FORBIDDEN_PERMISSIONS, composeOutcome, composeCapabilities,
  composeRecipientDecision, composeAttachmentDecision,
} from "../src/compose-core.ts";

type Json = { [key: string]: any };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/compose");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/compose not found");
    dir = parent;
  }
}

function corpus(): Json {
  const doc = JSON.parse(readFileSync(join(corpusDir(), "result.json"), "utf-8")) as Json;
  assert.equal(doc["version"], 1, "result.json: version");
  return doc;
}

function section(doc: Json, name: string): Json[] {
  const raw = doc[name];
  const rows = Array.isArray(raw) ? raw : (raw as Json | undefined)?.["cases"];
  assert.ok(Array.isArray(rows) && rows.length > 0, `result.json: ${name} must be a non-empty case array`);
  return rows as Json[];
}

test("compose: the result vocabulary agrees with the corpus", () => {
  assert.deepEqual([...COMPOSE_RESULTS], corpus()["vocabulary"]);
});

test("compose: the result-fidelity table agrees with the corpus", () => {
  const fidelity = corpus()["resultFidelity"] as Json;
  const declared = Object.entries(fidelity).filter(([key]) => !key.startsWith("_"));
  assert.ok(declared.length > 0, "result.json: resultFidelity names no renderers");
  for (const [renderer, actions] of declared) {
    for (const [action, results] of Object.entries(actions as Json)) {
      assert.deepEqual(
        [...(COMPOSE_RESULT_FIDELITY[renderer]?.[action] ?? [])], results,
        `resultFidelity: ${renderer}.${action}`,
      );
    }
  }
});

test("compose: the permission surface is empty on every action", () => {
  const surface = corpus()["permissionSurface"] as Json;
  const declared = Object.entries(surface)
    .filter(([key, value]) => !key.startsWith("_") && typeof value === "string");
  assert.ok(declared.length > 0, "result.json: permissionSurface names no actions");
  for (const [action, grant] of declared) {
    assert.equal(grant, "none", `permissionSurface: ${action} must need no grant`);
    assert.equal(COMPOSE_PERMISSION_SURFACE[action], "none", `permissionSurface: ${action}`);
  }
  assert.deepEqual([...COMPOSE_FORBIDDEN_PERMISSIONS], surface["forbiddenPermissions"]);
  for (const permission of COMPOSE_FORBIDDEN_PERMISSIONS) {
    assert.ok(
      !Object.values(COMPOSE_PERMISSION_SURFACE).includes(permission),
      `${permission} must never appear in the permission surface`,
    );
  }
});

test("compose: the result ladder agrees with the corpus", () => {
  const doc = corpus();
  const fidelity = doc["resultFidelity"] as Json;
  for (const testCase of section(doc, "cases")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;

    const outcome = composeOutcome({
      renderer: given["renderer"] as string,
      action: given["action"] as string,
      composerResult: given["composerResult"] as string | null,
      launched: given["launched"] as boolean | undefined,
      isHtml: given["isHtml"] as boolean | undefined,
    });

    if (expect["error"] !== undefined && expect["error"] !== null) {
      assert.equal(outcome.error, expect["error"], `${name}: error`);
      continue;
    }
    assert.equal(outcome.error, expect["error"] ?? null, `${name}: error`);
    assert.equal(outcome.result, expect["result"], `${name}: result`);
    if ("isHtml" in expect) assert.equal(outcome.isHtml, expect["isHtml"], `${name}: isHtml`);
    assert.ok(
      (fidelity[given["renderer"] as string][given["action"] as string] as string[]).includes(outcome.result as string),
      `${name}: ${outcome.result} is outside ${given["renderer"]}.${given["action"]}'s fidelity list`,
    );
  }
});

test("compose: the capability disclosure agrees with the corpus", () => {
  for (const testCase of section(corpus(), "capabilities")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;
    const capabilities = composeCapabilities({
      renderer: given["renderer"] as string,
      canText: given["canText"] as boolean | undefined,
      canMail: given["canMail"] as boolean | undefined,
      smsResolver: given["smsResolver"] as string | undefined,
      mailResolver: given["mailResolver"] as string | undefined,
    });
    assert.equal(capabilities.sms, expect["sms"], `${name}: sms`);
    assert.equal(capabilities.mail, expect["mail"], `${name}: mail`);
    if ("defaultMailClient" in expect) {
      assert.equal(capabilities.defaultMailClient, expect["defaultMailClient"], `${name}: defaultMailClient`);
    }
  }
});

test("compose: the recipient cap agrees with the corpus", () => {
  for (const testCase of section(corpus(), "recipients")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const count = given["count"] !== undefined
      ? (given["count"] as number)
      : Number(given["to"] ?? 0) + Number(given["cc"] ?? 0) + Number(given["bcc"] ?? 0);
    const decision = composeRecipientDecision(count, given["cap"] as number);
    assert.equal(decision.runs, expect["runs"], `${testCase["name"]}: runs`);
    assert.equal(decision.error, expect["error"] ?? null, `${testCase["name"]}: error`);
  }
});

test("compose: the attachment rule agrees with the corpus", () => {
  for (const testCase of section(corpus(), "attachments")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const decision = composeAttachmentDecision({
      renderer: given["renderer"] as string,
      path: given["path"] as string,
      insideRoots: given["insideRoots"] as boolean | undefined,
      exists: given["exists"] as boolean | undefined,
    });
    assert.equal(decision.runs, expect["runs"], `${testCase["name"]}: runs`);
    assert.equal(decision.error, expect["error"] ?? null, `${testCase["name"]}: error`);
  }
});
