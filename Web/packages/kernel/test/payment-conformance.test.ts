//
//  payment-conformance.test.ts — the SHARED WALLET-PAYMENT corpus
//  (OpenSource/Conformance/pay/request.json) through the TS core, the REFERENCE leg of
//  Core/Pay (F17.2). The Kotlin twin (:core PaymentConformanceTest) and the Swift twin
//  (Engine/iOS/Payment.swift) read the SAME file, so a cart cannot add up to three different
//  totals on three renderers.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  PAYMENT_MAX_MINOR, PAYMENT_NETWORKS, PAYMENT_CAPABILITIES, PAYMENT_FIELDS, PAYMENT_STATUSES,
  currencyExponent, parseAmountMinor, formatAmountMinor,
  foldNetworks, foldCapabilities, foldFields, foldStatus, normalizePaymentRequest,
  type RawPaymentRequest,
} from "../src/payment.ts";

function corpusDir(): string {
  let dir = resolve(import.meta.dirname ?? ".");
  for (;;) {
    const candidate = join(dir, "OpenSource/Conformance/pay");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pay corpus not found");
    dir = parent;
  }
}

type ListCase = { name: string; raw: unknown; ok: boolean; expect?: string[]; error?: string };
type Doc = {
  limits: { maxMinor: number };
  vocabulary: { networks: string[]; capabilities: string[]; fields: string[]; statuses: string[] };
  exponent: { name: string; code: string; expect: number }[];
  amount: { name: string; raw: unknown; exponent: number; ok: boolean; minor?: number; error?: string }[];
  format: { name: string; minor: number; exponent: number; expect: string }[];
  networks: ListCase[];
  capabilities: ListCase[];
  fields: ListCase[];
  status: { name: string; raw: unknown; ok: boolean; expect?: string; error?: string }[];
  request: { name: string; raw: RawPaymentRequest; ok: boolean; plan?: unknown; error?: string }[];
};

const doc = JSON.parse(readFileSync(join(corpusDir(), "request.json"), "utf-8")) as Doc;

assert.ok(doc.amount.length >= 20, "pay/amount corpus is suspiciously small");
assert.ok(doc.request.length >= 14, "pay/request corpus is suspiciously small");

test("pay — the pinned vocabulary and ceiling", () => {
  assert.equal(PAYMENT_MAX_MINOR, doc.limits.maxMinor);
  assert.deepEqual([...PAYMENT_NETWORKS], doc.vocabulary.networks);
  assert.deepEqual([...PAYMENT_CAPABILITIES], doc.vocabulary.capabilities);
  assert.deepEqual([...PAYMENT_FIELDS], doc.vocabulary.fields);
  assert.deepEqual([...PAYMENT_STATUSES], doc.vocabulary.statuses);
});

for (const c of doc.exponent) {
  test(`pay/exponent — ${c.name}`, () => {
    assert.equal(currencyExponent(c.code), c.expect);
  });
}

for (const c of doc.amount) {
  test(`pay/amount — ${c.name}`, () => {
    const got = parseAmountMinor(c.raw, c.exponent);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.minor, "minor");
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.format) {
  test(`pay/format — ${c.name}`, () => {
    assert.equal(formatAmountMinor(c.minor, c.exponent), c.expect);
  });
}

function listCases(label: string, cases: ListCase[], fold: (raw: unknown) => ReturnType<typeof foldNetworks>): void {
  for (const c of cases) {
    test(`pay/${label} — ${c.name}`, () => {
      const got = fold(c.raw);
      assert.equal(got.ok, c.ok, "ok");
      if (got.ok) assert.deepEqual([...got.value], c.expect);
      else assert.equal(got.error, c.error, "error");
    });
  }
}

listCases("networks", doc.networks, foldNetworks);
listCases("capabilities", doc.capabilities, foldCapabilities);
listCases("fields", doc.fields, foldFields);

for (const c of doc.status) {
  test(`pay/status — ${c.name}`, () => {
    const got = foldStatus(c.raw);
    assert.equal(got.ok, c.ok, "ok");
    if (got.ok) assert.equal(got.value, c.expect);
    else assert.equal(got.error, c.error, "error");
  });
}

for (const c of doc.request) {
  test(`pay/request — ${c.name}`, () => {
    const got = normalizePaymentRequest(c.raw);
    assert.equal(got.ok, c.ok, `ok (${got.ok ? "" : (got as { detail?: string }).detail ?? ""})`);
    if (got.ok) {
      assert.deepEqual(JSON.parse(JSON.stringify(got.value)), c.plan);
    } else {
      assert.equal(got.error, c.error, "error");
    }
  });
}
