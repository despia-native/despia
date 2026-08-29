//
//  contacts-conformance.test.ts — the SHARED contacts corpus through the TS kernel
//  (OpenSource/Conformance/contacts/{crud,pick}.json). The Kotlin twin (:core
//  ContactsConformanceTest) and the Swift reference (ContactsConformance, record lane) run the
//  SAME files, so an ungranted bulk read, iOS 17 limited access and the paging arithmetic
//  cannot mean one thing on one renderer and something else on another.
//
//  Missing corpus = loud failure, and so is an empty section.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  CONTACTS_PERMISSION_SURFACE, contactPage, contactReadDecision, contactReadCount,
  contactWriteDecision, normalizeContactLabel, contactBirthday, contactDisplayName,
  contactPickOutcome,
} from "../src/contacts-core.ts";

type Json = { [key: string]: any };

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/contacts");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/contacts not found");
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

test("contacts: the paging arithmetic agrees with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "paging", "crud.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const page = contactPage(given["total"] as number, given["limit"] as number, given["offset"] as number);
    assert.equal(page.returned, expect["returned"], `${testCase["name"]}: returned`);
    assert.equal(page.hasNextPage, expect["hasNextPage"], `${testCase["name"]}: hasNextPage`);
    assert.equal(page.endCursor, expect["endCursor"], `${testCase["name"]}: endCursor`);
  }
});

test("contacts: the read access decisions agree with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "access", "crud.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;
    const decision = contactReadDecision(given["access"] as string);

    assert.equal(decision.runs, expect["runs"], `${name}: runs`);
    if (expect["prompted"] !== undefined) {
      assert.equal(decision.prompted, expect["prompted"], `${name}: prompted`);
    }
    if (expect["error"] !== undefined) {
      assert.equal(decision.error, expect["error"], `${name}: error`);
    } else {
      assert.equal(decision.error, null, `${name}: no error expected`);
    }
    if (expect["access"] !== undefined) {
      assert.equal(decision.access, expect["access"], `${name}: access`);
    }
    if (expect["returned"] !== undefined) {
      assert.equal(
        contactReadCount(given["access"] as string, given["shared"] as number, given["total"] as number),
        expect["returned"], `${name}: returned`,
      );
    }
    if (expect["messageNames"] !== undefined) {
      assert.ok(
        String(decision.message ?? "").toLowerCase().includes(String(expect["messageNames"]).toLowerCase()),
        `${name}: the refusal must name ${expect["messageNames"]}, got ${decision.message}`,
      );
    }
    if (expect["recoverable"] !== undefined) {
      assert.equal(decision.recoverable, expect["recoverable"], `${name}: recoverable`);
    }
  }
});

test("contacts: the write decisions agree with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "write", "crud.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;
    const decision = contactWriteDecision(given["access"] as string, given["contact"] as Json | undefined);

    assert.equal(decision.runs, expect["runs"], `${name}: runs`);
    assert.equal(decision.error, expect["error"] ?? null, `${name}: error`);
    if (expect["messageNames"] !== undefined) {
      assert.ok(
        String(decision.message ?? "").toLowerCase().includes(String(expect["messageNames"]).toLowerCase()),
        `${name}: the refusal must name ${expect["messageNames"]}, got ${decision.message}`,
      );
    }
  }
});

test("contacts: the vCard shape folds agree with the corpus", () => {
  for (const testCase of section(corpus("crud.json"), "shape", "crud.json")) {
    const given = testCase["given"] as Json;
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;
    let asserted = false;

    if (expect["label"] !== undefined) {
      assert.equal(normalizeContactLabel(given["platformLabel"] as string), expect["label"], `${name}: label`);
      asserted = true;
    }
    if (expect["birthday"] !== undefined) {
      assert.equal(
        contactBirthday(given["year"] as number, given["month"] as number, given["day"] as number),
        expect["birthday"], `${name}: birthday`,
      );
      asserted = true;
    }
    if (expect["displayName"] !== undefined) {
      assert.equal(
        contactDisplayName(given["givenName"] as string, given["familyName"] as string),
        expect["displayName"], `${name}: displayName`,
      );
      asserted = true;
    }
    assert.ok(asserted, `${name}: the runner asserted nothing — an unknown shape expectation`);
  }
});

test("contacts: the permission surface agrees with the corpus", () => {
  const surface = corpus("pick.json")["permissionSurface"] as Json;
  const declared = Object.entries(surface).filter(([key]) => !key.startsWith("_"));
  assert.ok(declared.length > 0, "pick.json: permissionSurface names no actions");
  for (const [action, grant] of declared) {
    assert.equal(CONTACTS_PERMISSION_SURFACE[action], grant, `permissionSurface: ${action}`);
  }
  for (const action of Object.keys(CONTACTS_PERMISSION_SURFACE)) {
    assert.ok(action in surface, `permissionSurface: the corpus does not pin ${action}`);
  }
});

test("contacts: the picker fold agrees with the corpus", () => {
  for (const testCase of section(corpus("pick.json"), "cases", "pick.json")) {
    const args = (testCase["args"] ?? {}) as Json;
    const given = (testCase["given"] ?? {}) as Json;
    const expect = testCase["expect"] as Json;
    const name = testCase["name"] as string;

    const outcome = contactPickOutcome({
      multiple: args["multiple"] === true,
      fields: args["fields"] as string[] | undefined,
      picked: given["picked"] as Json[] | null,
      multiSelect: given["multiSelect"] as boolean | undefined,
      pickerAvailable: given["pickerAvailable"] as boolean | undefined,
    });

    if (expect["error"] !== undefined && expect["error"] !== null) {
      assert.equal(outcome.error, expect["error"], `${name}: error`);
      continue;
    }
    assert.equal(outcome.error, null, `${name}: error`);
    assert.equal(outcome.contacts.length, expect["contacts"], `${name}: contacts`);
    if (expect["cancelled"] !== undefined) {
      assert.equal(outcome.cancelled, expect["cancelled"], `${name}: cancelled`);
    }
    if (expect["prompted"] !== undefined) {
      assert.equal(outcome.prompted, expect["prompted"], `${name}: prompted`);
    }
    if ("multiple" in expect) {
      assert.equal(outcome.multiple, expect["multiple"], `${name}: multiple`);
    }
    if (expect["keys"] !== undefined) {
      assert.deepEqual(Object.keys(outcome.contacts[0]!), expect["keys"], `${name}: keys`);
    }
  }
});
