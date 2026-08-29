//
//  crypto-conformance.test.ts - the SHARED crypto corpus through the TS kernel
//  (OpenSource/Conformance/crypto/{vectors,uniformity,keyref}.json). The Kotlin twin is
//  :core CryptoConformanceTest and the Swift reference is Engine/iOS/CryptoCore.swift, and
//  all three run the same three files: a v7 id minted on one renderer must sort against one
//  minted on another, and `randomInt` must be uniform everywhere or nowhere.
//
//  The digest and MAC vectors are run against the PLATFORM implementation (node's WebCrypto,
//  which is what the web facet calls), not against anything in this repo. That is the point:
//  the corpus proves the vectors and the algorithm-name fold, and the platform proves the
//  cryptography. Nothing here rolls a primitive.
//
//  Missing corpus = loud failure. A silently-skipped conformance suite is how drift starts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash, createHmac, randomBytes, webcrypto } from "node:crypto";

import {
  CRYPTO_DIGESTS, CRYPTO_MAC_DIGESTS, CRYPTO_MAX_RANDOM_BYTES,
  foldDigest, digestWebName, uuidV4, uuidV7, uniformBound, uniformInt,
} from "../src/crypto-core.ts";

type Dict = { [k: string]: unknown };

function repoRoot(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(dir, "OpenSource/Conformance/crypto"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("OpenSource/Conformance/crypto not found");
    dir = parent;
  }
}

function corpus(name: string): Dict {
  const doc = JSON.parse(readFileSync(join(repoRoot(), "OpenSource/Conformance/crypto", name), "utf-8")) as Dict;
  assert.equal(doc["version"], 1, `${name}: version`);
  return doc;
}

function rows<T>(doc: Dict, key: string): T[] {
  const list = doc[key];
  assert.ok(Array.isArray(list) && list.length > 0, `${key} must be a non-empty array`);
  return list as T[];
}

// ── vectors.json ─────────────────────────────────────────────────────────────────────────

test("crypto vectors: the algorithm-name fold", () => {
  const doc = corpus("vectors.json");
  for (const row of rows<Dict>(doc, "spellings")) {
    const allowLegacy = row["allowLegacy"] === undefined ? true : row["allowLegacy"] === true;
    assert.equal(foldDigest(row["input"] as string, allowLegacy), row["expect"], row["name"] as string);
  }
  // Every folded id has a WebCrypto spelling except md5, which no browser implements and
  // which the web facet therefore answers unsupported_platform for.
  for (const id of Object.keys(CRYPTO_DIGESTS)) {
    assert.equal(typeof digestWebName(id), "string", `${id} has a WebCrypto name`);
  }
  assert.equal(digestWebName("nope"), null);
});

test("crypto vectors: digests match the published vectors on the platform implementation", async () => {
  const doc = corpus("vectors.json");
  for (const row of rows<Dict>(doc, "digest")) {
    const id = foldDigest(row["algorithm"] as string);
    assert.ok(id, `${row["name"]}: unknown algorithm`);
    const data = Buffer.from(String(row["data"]), "utf-8");
    let digest: Buffer;
    if (id === "md5") {
      digest = createHash("md5").update(data).digest();
    } else {
      const web = digestWebName(id)!;
      digest = Buffer.from(await webcrypto.subtle.digest(web, data));
    }
    const output = (row["output"] as string) ?? "hex";
    const actual = output === "base64" ? digest.toString("base64") : digest.toString("hex");
    assert.equal(actual, row["expect"], row["name"] as string);
  }
});

test("crypto vectors: HMAC matches RFC 4231 and RFC 2202", () => {
  const doc = corpus("vectors.json");
  for (const row of rows<Dict>(doc, "hmac")) {
    const id = foldDigest(row["algorithm"] as string);
    assert.ok(id && CRYPTO_MAC_DIGESTS.includes(id), `${row["name"]}: not a MAC algorithm`);
    const keyEncoding = (row["keyEncoding"] as string) ?? "utf8";
    const key = Buffer.from(String(row["key"]), keyEncoding === "base64" ? "base64" : "utf-8");
    const mac = createHmac(id!, key).update(String(row["data"]), "utf-8").digest("hex");
    assert.equal(mac, row["expect"], row["name"] as string);
  }
});

test("crypto vectors: the MAC vocabulary excludes md5", () => {
  const doc = corpus("vectors.json");
  const vocab = doc["macVocabulary"] as Dict;
  assert.deepEqual([...CRYPTO_MAC_DIGESTS], vocab["allowed"]);
  for (const refused of vocab["refused"] as string[]) {
    assert.ok(!CRYPTO_MAC_DIGESTS.includes(refused), `${refused} must not be a MAC algorithm`);
  }
});

// ── uniformity.json ──────────────────────────────────────────────────────────────────────

test("crypto uniformity: the rejection bound", () => {
  const doc = corpus("uniformity.json");
  for (const row of rows<Dict>(doc, "bounds")) {
    assert.equal(uniformBound(row["range"] as number), row["expect"], row["name"] as string);
  }
});

test("crypto uniformity: draws at or above the bound are discarded, never folded", () => {
  const doc = corpus("uniformity.json");
  for (const row of rows<Dict>(doc, "picks")) {
    const expect = row["expect"] as Dict;
    const got = uniformInt(row["min"] as number, row["max"] as number, row["draws"] as number[]);
    if (expect["error"] !== undefined) {
      assert.equal(got.ok, false, `${row["name"]}: expected a refusal`);
      assert.equal((got as { error: string }).error, expect["error"], row["name"] as string);
      continue;
    }
    assert.equal(got.ok, true, `${row["name"]}: expected a value`);
    const ok = got as { value: number; consumed: number };
    assert.equal(ok.value, expect["value"], `${row["name"]}: value`);
    assert.equal(ok.consumed, expect["consumed"], `${row["name"]}: draws consumed`);
  }
});

test("crypto uniformity: the sampled distribution stays inside the bound", () => {
  const doc = corpus("uniformity.json");
  const spec = doc["distribution"] as Dict;
  const min = spec["min"] as number;
  const max = spec["max"] as number;
  const samples = spec["samples"] as number;
  const tolerance = spec["tolerance"] as number;
  const range = max - min + 1;
  const buckets = new Array<number>(range).fill(0);

  // One 4-byte draw per attempt, redrawn on rejection - exactly what the facets do.
  for (let i = 0; i < samples; i += 1) {
    for (;;) {
      const draw = randomBytes(4).readUInt32BE(0);
      const picked = uniformInt(min, max, [draw]);
      if (picked.ok) { buckets[picked.value - min] += 1; break; }
    }
  }

  const expected = samples / range;
  for (let i = 0; i < range; i += 1) {
    const drift = Math.abs(buckets[i] - expected) / expected;
    assert.ok(drift <= tolerance, `bucket ${min + i} drifted ${drift.toFixed(3)} (count ${buckets[i]}, expected ${expected})`);
  }
});

test("crypto uniformity: the UUID v4 layout", () => {
  const doc = corpus("uniformity.json");
  for (const row of rows<Dict>(doc, "uuidV4")) {
    assert.equal(uuidV4(row["random"] as number[]), row["expect"], row["name"] as string);
  }
});

test("crypto uniformity: the UUID v7 layout", () => {
  const doc = corpus("uniformity.json");
  for (const row of rows<Dict>(doc, "uuidV7")) {
    assert.equal(uuidV7(row["millis"] as number, row["random"] as number[]), row["expect"], row["name"] as string);
  }
});

test("crypto uniformity: v7 ids sort in mint order", () => {
  const doc = corpus("uniformity.json");
  const spec = doc["monotonic"] as Dict;
  const random = spec["random"] as number[];
  const minted = (spec["millis"] as number[]).map((ms) => uuidV7(ms, random));
  assert.deepEqual(minted, spec["expect"]);
  const sorted = [...minted].sort();
  assert.deepEqual(sorted, minted, "v7 ids must sort chronologically as plain strings");
});

test("crypto uniformity: randomBytes is bounded", () => {
  const doc = corpus("uniformity.json");
  assert.equal(CRYPTO_MAX_RANDOM_BYTES, (doc["limits"] as Dict)["maxRandomBytes"]);
});

// ── keyref.json ──────────────────────────────────────────────────────────────────────────

function manifest(): Dict {
  const doc = corpus("keyref.json");
  const path = join(repoRoot(), String(doc["manifest"]));
  assert.ok(existsSync(path), `keyref.json names a manifest that does not exist: ${path}`);
  return JSON.parse(readFileSync(path, "utf-8")) as Dict;
}

function actions(): { [name: string]: Dict } {
  const block = manifest()["actions"] as Dict;
  const out: { [name: string]: Dict } = {};
  for (const [name, spec] of Object.entries(block)) {
    if (name === "_note" || typeof spec !== "object" || spec === null) continue;
    out[name] = spec as Dict;
  }
  return out;
}

test("crypto keyref: no resolve hands back private key material", () => {
  const doc = corpus("keyref.json");
  const forbidden = doc["forbiddenResolveFields"] as Dict;
  const names = (forbidden["names"] as string[]).map((n) => n.toLowerCase());
  const exempt = forbidden["exempt"] as Dict[];

  for (const [action, spec] of Object.entries(actions())) {
    const resolves = spec["resolves"];
    if (typeof resolves !== "object" || resolves === null) continue;
    for (const [field, decl] of Object.entries(resolves as Dict)) {
      if (!names.includes(field.toLowerCase())) continue;
      const allowance = exempt.find((e) => e["action"] === action && e["field"] === field);
      assert.ok(allowance, `${action} resolves '${field}', which would carry private key material`);
      if (allowance["mustBeOptional"] === true) {
        assert.equal((decl as Dict)?.["optional"], true,
          `${action}.${field} must be declared optional so the stored path never carries it`);
      }
    }
  }
});

test("crypto keyref: the store:true tests carry no private material and the store:false one does", () => {
  const keypair = actions()["keypair"];
  assert.ok(keypair, "keypair must exist");
  const tests = keypair["tests"] as Dict[];
  let sawStored = false;
  let sawEphemeral = false;
  for (const t of tests) {
    const args = (t["args"] as Dict) ?? {};
    const resolved = (t["resolve"] as Dict) ?? (t["expect"] as Dict);
    if (resolved === undefined) continue;
    if (args["store"] === false) {
      sawEphemeral = true;
      assert.ok("privateKey" in resolved, `${t["name"]}: a store:false pair must actually return the material it promised`);
    } else {
      sawStored = true;
      assert.ok(!("privateKey" in resolved), `${t["name"]}: a stored pair must never resolve private material`);
      assert.ok("keyRef" in resolved, `${t["name"]}: a stored pair must resolve a reference`);
    }
  }
  assert.ok(sawStored && sawEphemeral, "keypair needs both a stored and an ephemeral case");
});

test("crypto keyref: a keyRef is an opaque handle", () => {
  const shape = corpus("keyref.json")["refShape"] as Dict;
  const re = new RegExp(shape["pattern"] as string);
  for (const good of shape["examples"] as string[]) assert.ok(re.test(good), `${good} should be a valid ref`);
  for (const bad of shape["refused"] as string[]) assert.ok(!re.test(bad), `${bad} should not be a valid ref`);
  for (const good of shape["examples"] as string[]) {
    assert.ok(good.startsWith(shape["prefix"] as string), `${good} must carry the ref prefix`);
  }
});

test("crypto keyref: a secure-hardware fallback is disclosed, never silent", () => {
  const spec = corpus("keyref.json")["storedKeyActions"] as Dict;
  const table = spec["hardwareValues"] as { [k: string]: boolean };
  const all = actions();
  for (const name of spec["actions"] as string[]) {
    const action = all[name];
    assert.ok(action, `${name} must exist`);
    const resolves = action["resolves"] as Dict;
    for (const field of spec["requiredResolveFields"] as string[]) {
      assert.ok(field in resolves, `${name} must disclose '${field}' in its resolve`);
    }
    const errs = (action["errors"] as Dict) ?? {};
    assert.ok("secure_hardware_unavailable" in errs, `${name} must declare secure_hardware_unavailable`);

    // Every declared test agrees with the storage/hardware table, so no case can claim a
    // secure element while naming a software store.
    for (const t of (action["tests"] as Dict[]) ?? []) {
      const resolved = (t["resolve"] as Dict) ?? (t["expect"] as Dict);
      if (resolved === undefined) continue;
      const storage = resolved["storage"] as string;
      assert.ok((spec["storageValues"] as string[]).includes(storage), `${name}/${t["name"]}: unknown storage '${storage}'`);
      assert.equal(resolved["hardware"], table[storage], `${name}/${t["name"]}: hardware must follow storage '${storage}'`);
    }
  }
});

test("crypto keyref: consuming actions take a reference and declare key_not_found", () => {
  const spec = corpus("keyref.json")["consumingActions"] as Dict;
  const all = actions();
  for (const name of spec["referenceOnly"] as string[]) {
    const action = all[name];
    assert.ok(action, `${name} must exist`);
    if (name === "secretKey") continue;   // mints rather than consumes; listed so it can never grow a raw-key arg
    const args = action["args"] as Dict;
    assert.ok("keyRef" in args, `${name} must accept keyRef`);
    assert.ok(!("key" in args) && !("privateKey" in args), `${name} must not accept raw key material`);
  }
  for (const name of spec["referenceOrValue"] as string[]) {
    const args = all[name]["args"] as Dict;
    assert.ok("keyRef" in args, `${name} must accept keyRef`);
  }
  for (const name of spec["mustDeclareKeyNotFound"] as string[]) {
    assert.ok("key_not_found" in ((all[name]["errors"] as Dict) ?? {}), `${name} must declare key_not_found`);
  }
});

test("crypto keyref: decryption failure is one opaque code", () => {
  const spec = corpus("keyref.json")["opaqueFailure"] as Dict;
  const errs = actions()[spec["action"] as string]["errors"] as Dict;
  assert.ok((spec["code"] as string) in errs, "decrypt must declare decrypt_failed");
  for (const banned of spec["mustNotDeclare"] as string[]) {
    assert.ok(!(banned in errs), `decrypt must not distinguish '${banned}'`);
  }
});

test("crypto keyref: there is no cipher-mode menu and no key export", () => {
  const doc = corpus("keyref.json");
  const menu = doc["modeMenu"] as Dict;
  const encrypt = actions()[menu["action"] as string];
  for (const banned of menu["forbiddenArgs"] as string[]) {
    assert.ok(!(banned in (encrypt["args"] as Dict)), `encrypt must not take '${banned}'`);
  }
  const resolved = (encrypt["tests"] as Dict[])[0]["resolve"] as Dict;
  assert.equal(resolved["algorithm"], menu["algorithm"]);

  const names = Object.keys(actions()).map((n) => n.toLowerCase());
  for (const banned of (doc["noExport"] as Dict)["forbiddenActionNames"] as string[]) {
    assert.ok(!names.includes(banned.toLowerCase()), `there must be no '${banned}' action`);
  }
});
