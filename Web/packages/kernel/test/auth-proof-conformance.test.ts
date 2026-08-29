//
//  auth-proof-conformance.test.ts — the SHARED authentication-proof corpus through the TS
//  kernel (OpenSource/Conformance/auth/{trigger,pkce}.json). The Kotlin twin (:core
//  AuthProofConformanceTest) and the Swift reference (Engine/iOS/AuthProof.swift via
//  AuthProofConformance.swift, record lane) run the SAME files, so a login trigger cannot pin
//  an origin on one renderer and accept a lookalike host on another, and a callback cannot be
//  refused on one and resolved on another.
//
//  Missing corpus = loud failure. A silently-skipped conformance suite is how drift starts, and
//  the drift here is an account takeover.
//
//  The S256 rows are checked TWICE: this runner hashes the corpus verifier with node's own
//  SHA-256 and asserts it reproduces the recorded digest before encoding it, so the corpus
//  cannot quietly carry a wrong hash and have all three runners agree with it.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import {
  matchesConfiguredTrigger, isAllowedAuthorizationUrl,
  base64UrlNoPad, isCodeVerifier, codeVerifierFromEntropy, opaqueProof, codeChallengeS256,
  constantTimeEquals, planAuthorizeProofs, applyAuthorizeProofs, verifyCallbackProofs,
  idTokenPayload, tokenEndpointAllowed,
  PKCE_VERIFIER_MIN_LENGTH, PKCE_VERIFIER_MAX_LENGTH, PKCE_VERIFIER_ENTROPY_BYTES,
  AUTH_PROOF_ENTROPY_BYTES,
  type CallbackVerdict,
} from "../src/auth-proof.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/auth");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/auth not found");
    dir = parent;
  }
}

function corpus(name: string): { [k: string]: any } {
  const doc = JSON.parse(readFileSync(join(corpusDir(), name), "utf-8")) as { [k: string]: any };
  assert.equal(doc["version"], 1, `${name}: version`);
  return doc;
}

function cases(doc: { [k: string]: any }, section: string): Array<{ [k: string]: any }> {
  const rows = doc[section]?.["cases"] as Array<{ [k: string]: any }> | undefined;
  assert.ok(rows !== undefined && rows.length > 0, `${section} corpus must not be empty`);
  return rows;
}

// ── 1 · the trigger fold ─────────────────────────────────────────────────────────────

test("auth: a configured login trigger pins its origin", () => {
  const doc = corpus("trigger.json");
  for (const row of cases(doc, "matchesConfiguredTrigger")) {
    assert.equal(
      matchesConfiguredTrigger(row["candidate"] as string, row["prefix"] as string),
      row["expect"] as boolean,
      row["name"] as string,
    );
  }
});

test("auth: only https authorization starts reach a browser", () => {
  const doc = corpus("trigger.json");
  for (const row of cases(doc, "isAllowedAuthorizationUrl")) {
    assert.equal(isAllowedAuthorizationUrl(row["url"] as string), row["expect"] as boolean,
                 row["name"] as string);
  }
});

test("auth: the subdomain hazard is refused for every configured provider spelling", () => {
  // The whole point of the fold, asserted independently of the corpus rows so a corpus edit
  // cannot delete the hazard it exists for.
  for (const origin of ["https://accounts.google.com", "https://login.microsoftonline.com"]) {
    for (const prefix of [origin, origin + "/oauth2/authorize"]) {
      assert.equal(matchesConfiguredTrigger(origin + ".attacker.invalid/login", prefix), false,
                   `${prefix}: lookalike host`);
      assert.equal(matchesConfiguredTrigger(origin + "@evil.tld/login", prefix), false,
                   `${prefix}: userinfo`);
    }
    assert.equal(matchesConfiguredTrigger(origin + ":8443/login", origin), false, `${origin}: port`);
  }
});

// ── 2 · the verifier ABNF, the alphabet, the entropy floors ──────────────────────────

test("auth: the code_verifier ABNF is RFC 7636 §4.1 verbatim", () => {
  const doc = corpus("pkce.json");
  const section = doc["verifier"];
  assert.equal(section["minLength"], PKCE_VERIFIER_MIN_LENGTH);
  assert.equal(section["maxLength"], PKCE_VERIFIER_MAX_LENGTH);
  for (const ch of section["unreserved"] as string) {
    assert.equal(isCodeVerifier(ch.repeat(PKCE_VERIFIER_MIN_LENGTH)), true, `unreserved ${ch}`);
  }
  for (const row of cases(doc, "verifier")) {
    assert.equal(isCodeVerifier(row["value"] as string), row["expect"] as boolean, row["name"] as string);
  }
});

test("auth: base64url drops its padding", () => {
  const doc = corpus("pkce.json");
  for (const row of cases(doc, "base64url")) {
    assert.equal(base64UrlNoPad(row["bytes"] as number[]), row["expect"] as string, row["name"] as string);
  }
});

test("auth: the entropy floors are refusals, not silent short values", () => {
  const doc = corpus("pkce.json");
  const section = doc["mint"];
  assert.equal(section["verifierEntropyBytes"], PKCE_VERIFIER_ENTROPY_BYTES);
  assert.equal(section["proofEntropyBytes"], AUTH_PROOF_ENTROPY_BYTES);
  for (const row of cases(doc, "mint")) {
    const bytes = row["bytes"] as number[];
    const got = row["fold"] === "codeVerifierFromEntropy"
      ? codeVerifierFromEntropy(bytes) : opaqueProof(bytes);
    assert.equal(got, row["expect"] as string | null, row["name"] as string);
  }
  // A minted verifier must satisfy the ABNF it will be measured against at the token endpoint.
  const minted = codeVerifierFromEntropy(new Array(PKCE_VERIFIER_ENTROPY_BYTES).fill(0xff));
  assert.ok(minted !== null && isCodeVerifier(minted));
});

// ── 3 · the S256 challenge, checked against a real hash ──────────────────────────────

test("auth: code_challenge is base64url(SHA-256(ASCII(verifier))) with no padding", () => {
  const doc = corpus("pkce.json");
  assert.equal(doc["challenge"]["method"], "S256");
  for (const row of cases(doc, "challenge")) {
    const verifier = row["verifier"] as string;
    const digest = createHash("sha256").update(verifier, "ascii").digest();
    assert.equal(digest.toString("hex"), row["sha256Hex"] as string,
                 `${row["name"]}: the corpus digest is not SHA-256 of the verifier`);
    assert.equal(codeChallengeS256([...digest]), row["expect"] as string, row["name"] as string);
    assert.ok(!(row["expect"] as string).includes("="), "a challenge never carries padding");
  }
  for (const row of doc["challenge"]["lengthRefusals"] as Array<{ [k: string]: any }>) {
    assert.equal(codeChallengeS256(new Array(row["length"] as number).fill(0)), null,
                 row["name"] as string);
  }
});

// ── 4 · the proof plan and the URL it builds ─────────────────────────────────────────

test("auth: the proof plan adopts what the caller wrote and mints what is missing", () => {
  const doc = corpus("pkce.json");
  const declared = new Set(doc["plan"]["refusals"] as string[]);
  for (const row of cases(doc, "plan")) {
    const plan = planAuthorizeProofs(row["url"] as string, row["wantsPkce"] as boolean);
    const expect = row["expect"] as { [k: string]: any };
    const name = row["name"] as string;
    if (expect["refusal"] !== undefined) {
      assert.ok(declared.has(expect["refusal"] as string), `undeclared refusal ${expect["refusal"]}`);
      assert.equal(plan.refusal, expect["refusal"] as string, `${name}: refusal`);
      assert.equal(plan.mintPkce, false, `${name}: a refused plan mints nothing`);
      assert.equal(plan.mintState, false, `${name}: a refused plan mints nothing`);
      continue;
    }
    assert.equal(plan.refusal, null, `${name}: refusal`);
    assert.equal(plan.mintState, expect["mintState"] as boolean, `${name}: mintState`);
    assert.equal(plan.adoptedState, (expect["adoptedState"] ?? null) as string | null, `${name}: adoptedState`);
    assert.equal(plan.mintNonce, expect["mintNonce"] as boolean, `${name}: mintNonce`);
    assert.equal(plan.mintPkce, expect["mintPkce"] as boolean, `${name}: mintPkce`);
    if (expect["adoptedNonce"] !== undefined) {
      assert.equal(plan.adoptedNonce, expect["adoptedNonce"] as string | null, `${name}: adoptedNonce`);
    }
  }
});

test("auth: minted proofs are appended, never rewritten", () => {
  const doc = corpus("pkce.json");
  for (const row of cases(doc, "apply")) {
    const minted = row["minted"] as { [k: string]: string };
    assert.equal(applyAuthorizeProofs(row["url"] as string, minted), row["expect"] as string,
                 row["name"] as string);
  }
});

test("auth: an applied plan carries S256 and leaves an adopted state alone", () => {
  // The two halves of DONE-WHEN 6, asserted end to end rather than through a corpus row.
  const url = "https://idp.example/authorize?response_type=code&scope=openid&client_id=abc";
  const plan = planAuthorizeProofs(url, true);
  assert.equal(plan.refusal, null);
  const final = applyAuthorizeProofs(url, {
    state: plan.mintState ? "STATE" : null,
    nonce: plan.mintNonce ? "NONCE" : null,
    challenge: plan.mintPkce ? "CHAL" : null,
  });
  assert.ok(final.includes("code_challenge=CHAL"));
  assert.ok(final.includes("code_challenge_method=S256"));
  assert.ok(final.includes("state=STATE"));
  assert.ok(final.includes("nonce=NONCE"));

  const adopted = planAuthorizeProofs(url + "&state=mine", false);
  assert.equal(adopted.adoptedState, "mine");
  assert.equal(applyAuthorizeProofs(url + "&state=mine", {}), url + "&state=mine");
});

// ── 5 · the callback verdict ─────────────────────────────────────────────────────────

test("auth: a callback is delivered only on a verdict that permits it", () => {
  const doc = corpus("pkce.json");
  const declared = new Set(doc["verify"]["verdicts"] as string[]);
  for (const row of cases(doc, "verify")) {
    const verdict = verifyCallbackProofs(
      row["expected"] as string | null,
      (row["consumed"] ?? []) as string[],
      row["received"] as string | null,
      (row["expectedNonce"] ?? null) as string | null,
      row["idTokenNonce"] === undefined ? null : (row["idTokenNonce"] as string | null),
    );
    assert.ok(declared.has(row["expect"] as string), `undeclared verdict ${row["expect"]}`);
    assert.equal(verdict, row["expect"] as CallbackVerdict, row["name"] as string);
  }
});

test("auth: constant-time equality answers the corpus", () => {
  const doc = corpus("pkce.json");
  for (const row of cases(doc, "constantTime")) {
    assert.equal(constantTimeEquals(row["a"] as string, row["b"] as string),
                 row["expect"] as boolean, row["name"] as string);
  }
});

test("auth: the id_token payload read stops at the decoded string", () => {
  const doc = corpus("pkce.json");
  for (const row of cases(doc, "idToken")) {
    assert.equal(idTokenPayload(row["jwt"] as string), row["expect"] as string | null,
                 row["name"] as string);
  }
});

test("auth: a verifier is released only to a declared https token endpoint", () => {
  const doc = corpus("pkce.json");
  for (const row of cases(doc, "tokenEndpoint")) {
    assert.equal(tokenEndpointAllowed(row["url"] as string, row["declared"] as string[]),
                 row["expect"] as boolean, row["name"] as string);
  }
});
