//
//  tier.test.ts - the W9 execution-tier classifier (/web/15 law 4): the JSE→JS compiler
//  is the subset oracle — a body it emits is jse-tier (every executor agrees on it, the
//  corpus law), a body it rejects carries standard JS semantics and escalates. Verdicts
//  are cached (zero per-evaluation cost) and the build report names every escalation.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyBody, tierReport } from "../src/compile/tier.ts";

test("tier: portable action bodies classify jse", () => {
  for (const body of [
    "count = count + 1",
    "if (a > 3) { b = a * 2 } else { b = 0 }",
    "for (const x of items) { total = total + x.price }",
    "dsx.variable.name = 'x'; dsx.action.save()",
  ]) {
    assert.equal(classifyBody(body).tier, "jse", body);
  }
});

test("tier: beyond-subset constructs classify js with a reason", () => {
  for (const body of [
    "class Foo { constructor() {} }",
    "function* gen() { yield 1 }",
    "label: while (true) { break label }",
    "with (obj) { x = 1 }",
    "debugger",
  ]) {
    const v = classifyBody(body);
    assert.equal(v.tier, "js", body);
    assert.ok((v.reason ?? "").length > 0, `reason for: ${body}`);
  }
});

test("tier: the contextual words and shapes that look scary stay jse", () => {
  for (const body of [
    "get('key')",                          // a call named get
    "settings = dsx.variable.set",         // set as a property-ish read
    "x = a ? b : c",                       // ternary colon
    "obj = { label: 'x', for: 1 }",        // object keys
    "x = [1, 2, 3].with(1, 9).join('')",   // member-position with — the array METHOD
  ]) {
    assert.equal(classifyBody(body).tier, "jse", body);
  }
});

test("tier: the verdict is cached — same body, same object", () => {
  const a = classifyBody("count = 1");
  const b = classifyBody("count = 1");
  assert.equal(a, b);
});

test("tier: the report counts and names escalations", () => {
  const jsBody = ["class Foo {}", "function* g() { yield 1 }"]
    .find((b) => classifyBody(b).tier === "js")!;
  const report = tierReport([
    { location: "A.dsx:3", source: "count = 1" },
    { location: "A.dsx:9", source: jsBody },
    { location: "B.dsx:2", source: "x = y + 1" },
  ]);
  assert.equal(report.total, 3);
  assert.equal(report.jse, 2);
  assert.deepEqual(report.js.map((e) => e.location), ["A.dsx:9"]);
  assert.ok(report.js[0]!.reason.length > 0);
});
