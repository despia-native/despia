//
//  jse-audit.test.ts - the JSE coverage gate: site extraction from .dsx markup, the
//  banned-construct / promise-chain / unsupported-method / unknown-op / parse-residue /
//  unsafe-number-literal detectors, the no-false-positive floor on supported modern
//  syntax (templates, ??, ?., spread, destructuring — all first-class in JSE), and the
//  CLI contract (--strict exit code, --json shape, the 64-bit ID advisory footer).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  auditSource, collectSites, moustacheSegments, maskFetchEffectUrls, findDsxFiles,
  type Finding,
} from "../bin/jse-audit.ts";

const BIN = fileURLToPath(new URL("../bin/jse-audit.ts", import.meta.url));

function findings(source: string): Finding[] {
  return auditSource("Test.dsx", source).findings;
}
function rules(source: string): string[] {
  return findings(source).map((f) => f.rule).sort();
}

// ── the no-false-positive floor: supported modern syntax stays silent ───────────────

const CLEAN_DSX = `<component name="Clean">
  <head>
    <variable as="count">0</variable>
    <variable as="label">\`hi \${dsx.variable.count ?? 0}\`</variable>
    <formula as="pretty">return (dsx.variable.count ?? 0) + 1</formula>
    <function>
      function score(items) {
        const [first, ...rest] = items
        const { id, name: title } = first ?? {}
        let total = 0
        for (const it of rest) { total += it?.points ?? 0 }
        return total
      }
    </function>
    <action as="save">
      // comments strip, /* block */ too — and regex literals survive
      const slug = dsx.variable.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const style = { class: 'chip', extends: 'base' }   // dict KEYS, not keywords
      const copy = { ...style, slug }
      const seen = new Map()
      seen.set(slug, true)
      seen.delete(slug)
      try {
        const res = await fetch(dsx.variable.api + '/save', { method: 'POST', body: JSON.stringify(copy) })
        if (!res.ok) { throw new Error('bad status') }
        const pair = await Promise.all([ fetch(dsx.variable.api), dsx.module.self.ping({}) ])
        dsx.variable.rows = pair[0].data
      } catch (e) {
        dsx.variable.error = '' + e
      } finally {
        dsx.variable.busy = false
      }
      if ('id' in copy) { dsx.variable.hasId = true }
      let n = 0
      do { n += 1 } while (n < 3)
      dsx.variable.mode ??= 'auto'
    </action>
    <watch value="dsx.variable.count" on:change="dsx.action.save()"/>
  </head>
  <stack visible-if="dsx.variable.count > 0" on:tap="dsx.action.save()">
    <text value="{{ \`n=\${dsx.variable.count ?? 0}\` }}"/>
    <text value="{{ [...dsx.variable.rows ?? []].map(x => x?.name).join(', ') }}"/>
    <slider bind="dsx.variable.gain" on:change.throttle="80" on:change="dsx.action.save()"/>
    <button visible-if="has:scanner" label="Scan" on:tap="dsx.module.self.scan({})"/>
  </stack>
</component>`;

test("jse-audit: clean file with modern syntax has zero findings", () => {
  const res = auditSource("Clean.dsx", CLEAN_DSX);
  assert.deepEqual(res.findings, []);
  assert.ok(res.sites >= 10, `expected a real site count, got ${res.sites}`);
});

test("jse-audit: supported syntax stays silent site-by-site", () => {
  // expression sites ({{ }} in a value attribute)
  for (const expr of [
    "`hi ${a ?? 0} — ${b?.c}`",
    "items.filter(x => x.on).map(x => x.name).join(', ')",
    "[...xs, 3].length",
    "{ ...cfg, extra: 1 }.extra",
    "a ?? b ?? 'fallback'",
    "x?.y?.[0] ?? null",
    "cond ? 'yes' : 'no'",
    "'key' in dict",
    "n ** 2 + (m << 1)",
  ]) {
    assert.deepEqual(rules(`<c><text value="{{ ${expr} }}"/></c>`), [], `false positive on: ${expr}`);
  }
  // statement sites (on:* body)
  for (const stmt of [
    "const { a, b: renamed } = obj; dsx.variable.a = a",
    "const [x, , z] = arr; dsx.variable.z = z",
    "for (const [k, v] of new Map(pairs)) { dsx.variable.last = k + v }",
    "try { dsx.action.go() } catch (e) { dsx.variable.err = '' + e } finally { dsx.variable.done = true }",
    "const t = { retry: format(x), outer: forty }",
    "function mk(a) { return a + 1 }",
  ]) {
    assert.deepEqual(rules(`<c><s on:tap="${stmt.replace(/"/g, "&quot;")}"/></c>`), [], `false positive on: ${stmt}`);
  }
});

// ── banned constructs ────────────────────────────────────────────────────────────────

test("jse-audit: class declaration is flagged", () => {
  const found = findings(`<c><head><action as="a">class Point { }</action></head><s/></c>`);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, "banned-construct");
  assert.match(found[0]!.message, /`class` is not supported/);
  assert.match(found[0]!.message, /dicts/);
});

test("jse-audit: banned keyword family — each flagged with an alternative", () => {
  const cases: Array<[string, RegExp]> = [
    ["export const x = 1", /`export`/],
    ["import x", /`import`/],
    ["void dsx.action.go()", /`void`/],
    ["delete obj.key", /`delete`/],
    ["const ok = x instanceof Array", /`instanceof`/],
    ["async function go() { }", /`async`/],
    ["async () => { }", /`async`/],
    ["function* gen() { }", /function\*/],
    ["const y = yield x", /yield/],
    ["const p = new Promise(r => r(1))", /new Promise/],
    ["outer: for (const x of xs) { break outer }", /labeled statement/],
  ];
  for (const [stmt, re] of cases) {
    const found = findings(`<c><s on:tap="${stmt.replace(/"/g, "&quot;")}"/></c>`);
    assert.ok(found.some((f) => f.rule === "banned-construct" && re.test(f.message)),
      `expected banned-construct ${re} for: ${stmt} — got ${JSON.stringify(found.map((f) => f.message))}`);
  }
});

test("jse-audit: dict keys and member reads named like keywords are NOT flagged", () => {
  assert.deepEqual(rules(`<c><s on:tap="x = { class: 1, extends: 2, import: 3, void: 4 }"/></c>`), []);
  assert.deepEqual(rules(`<c><s on:tap="dsx.variable.k = row.class"/></c>`), []);
  assert.deepEqual(rules(`<c><s on:tap="seen.delete(id)"/></c>`), []); // Map/Set delete is a real method
});

// ── promise chaining + documented non-goal methods ──────────────────────────────────

test("jse-audit: .then chain is flagged in both lexical shapes", () => {
  // dotted-ident form (`p.then(` is ONE token) and postfix form (`fetch(x).then(`)
  const dotted = findings(`<c><head><action as="a">p.then(r => r.json())</action></head><s/></c>`);
  assert.ok(dotted.some((f) => f.rule === "promise-chain" && /\.then/.test(f.message)));
  const postfix = findings(`<c><head><action as="a">fetch(u).then(r => r.json()).catch(e => log(e))</action></head><s/></c>`);
  const ruleset = postfix.map((f) => f.rule);
  assert.ok(ruleset.includes("promise-chain"));
  assert.ok(postfix.some((f) => /\.catch/.test(f.message)));
});

test("jse-audit: localeCompare and toPrecision are flagged with alternatives", () => {
  const lc = findings(`<c><text value="{{ a.localeCompare(b) }}"/></c>`);
  assert.ok(lc.some((f) => f.rule === "unsupported-method" && /comparator/.test(f.message)));
  const tp = findings(`<c><text value="{{ n.toPrecision(3) }}"/></c>`);
  assert.ok(tp.some((f) => f.rule === "unsupported-method" && /Intl.NumberFormat|toFixed/.test(f.message)));
});

// ── parse residue + unknown operators ───────────────────────────────────────────────

test("jse-audit: unparseable {{ }} tail is flagged as dead residue", () => {
  const found = findings(`<c><text value="{{ items.join(', ') ]} tail }}"/></c>`);
  assert.equal(found.filter((f) => f.rule === "parse-residue").length, 1);
  assert.match(found[0]!.message, /tail/);
  assert.match(found[0]!.message, /dead/);
});

test("jse-audit: residue applies to expression sites only, never statement bodies", () => {
  // two statements are fine in a handler; the same text in {{ }} leaves a dead tail
  assert.deepEqual(rules(`<c><s on:tap="x = 1; y = 2"/></c>`), []);
  assert.deepEqual(rules(`<c><text value="{{ x = 1; y = 2 }}"/></c>`), ["parse-residue"]);
});

test("jse-audit: unknown operator tokens are flagged", () => {
  const found = findings(`<c><text value="{{ a @ b }}"/></c>`);
  assert.ok(found.some((f) => f.rule === "unknown-op" && f.message.includes("`@`")));
  const hash = findings(`<c><s on:tap="x = #tag"/></c>`);
  assert.ok(hash.some((f) => f.rule === "unknown-op" && f.message.includes("`#`")));
});

test("jse-audit: fetch-effect bare URLs are masked, not flagged", () => {
  assert.equal(maskFetchEffectUrls("fetch: r = GET https://user@example.com/a#frag"),
    "fetch: r = GET _url_");
  assert.deepEqual(rules(`<c><s on:tap="fetch: r = GET https://user@example.com/a#frag"/></c>`), []);
});

// ── unsafe number literals (the 64-bit ID hazard) ───────────────────────────────────

test("jse-audit: numeric literals above 2^53 are flagged in any site", () => {
  // expression site ({{ }}) — a compared backend ID
  const expr = findings(`<c><text value="{{ order.id == 12345678901234567890 }}"/></c>`);
  assert.ok(expr.some((f) => f.rule === "unsafe-number-literal" && /ride as STRINGS/.test(f.message)),
    `expected unsafe-number-literal — got ${JSON.stringify(expr.map((f) => f.rule))}`);
  // statement site (on:* body) — an assigned one; the message shows the mangled stored value
  const stmt = findings(`<c><s on:tap="dsx.variable.id = 12345678901234567890"/></c>`);
  const f0 = stmt.find((f) => f.rule === "unsafe-number-literal");
  assert.ok(f0 !== undefined);
  assert.match(f0!.message, /12345678901234567890/);
  assert.match(f0!.message, /stored as 12345678901234567168/);
  // template holes are token streams too
  const hole = findings(`<c><s on:tap="dsx.variable.msg = \`id \${98765432109876543210}\`"/></c>`);
  assert.ok(hole.some((f) => f.rule === "unsafe-number-literal"));
  // exponent forms over the line flag as well
  assert.deepEqual(rules(`<c><text value="{{ n * 1e21 }}"/></c>`), ["unsafe-number-literal"]);
});

test("jse-audit: the textbook boundary literal 2^53+1 is caught by its digits", () => {
  // 9007199254740993 ROUNDS DOWN to exactly 2^53 as a double — the value alone hides it
  const found = findings(`<c><s on:tap="x = 9007199254740993"/></c>`);
  const f = found.find((x) => x.rule === "unsafe-number-literal");
  assert.ok(f !== undefined, `expected the boundary literal to flag — got ${JSON.stringify(found)}`);
  assert.match(f!.message, /9007199254740993/);
  assert.match(f!.message, /stored as 9007199254740992/);
});

test("jse-audit: safe numbers never flag — MAX_SAFE_INTEGER, exact 2^53, strings, comments", () => {
  assert.deepEqual(rules(`<c><s on:tap="x = 9007199254740991"/></c>`), []); // 2^53 - 1
  assert.deepEqual(rules(`<c><s on:tap="x = 9007199254740992"/></c>`), []); // 2^53 itself is exact
  assert.deepEqual(rules(`<c><s on:tap="x = '12345678901234567890'"/></c>`), []); // a string ID is the FIX
  assert.deepEqual(rules(`<c><s on:tap="x = 123_456.78"/></c>`), []); // ordinary money-ish numbers
  // a 1e21 (or a big ID) in a COMMENT is not a code site
  const commented = `<c><head><action as="a">// scales to 1e21 rows someday\nx = 1</action></head><s/></c>`;
  assert.deepEqual(rules(commented), []);
});

// ── extraction mechanics ────────────────────────────────────────────────────────────

test("jse-audit: moustache splitting mirrors JSE.interpolate", () => {
  assert.deepEqual(moustacheSegments("a {{x}} b {{y}}"), ["x", "y"]);
  assert.deepEqual(moustacheSegments("none"), []);
  assert.deepEqual(moustacheSegments("open {{x"), []); // unterminated → kernel emits raw
});

test("jse-audit: sites carry kind, context, and best-effort lines", () => {
  const src = `<component name="X">\n  <head>\n    <action as="go">x = 1</action>\n  </head>\n  <stack on:tap="y = 2">\n    <text value="{{ z }}"/>\n  </stack>\n</component>`;
  const { sites, parseError } = collectSites("X.dsx", src);
  assert.equal(parseError, null);
  const byContext = new Map(sites.map((s) => [s.context, s]));
  assert.equal(byContext.get(`<action as="go">`)?.kind, "statements");
  assert.equal(byContext.get(`<action as="go">`)?.line, 3);
  assert.equal(byContext.get("on:tap on <stack>")?.kind, "statements");
  assert.equal(byContext.get("on:tap on <stack>")?.line, 5);
  assert.equal(byContext.get("{{ }} in value= on <text>")?.kind, "expr");
  assert.equal(byContext.get("{{ }} in value= on <text>")?.line, 6);
});

test("jse-audit: watch value and visible-if audit as expressions; modifiers and has: skip", () => {
  const src = `<c><head><watch value="dsx.variable.a ]junk" on:change="go()"/></head>` +
    `<s visible-if="x ]dead" on:change.throttle="80"/><b visible-if="has:scanner"/></c>`;
  const found = findings(src);
  assert.equal(found.filter((f) => f.rule === "parse-residue").length, 2); // watch value + visible-if
  const { sites } = collectSites("c.dsx", src);
  assert.ok(!sites.some((s) => s.context.includes("throttle")));
  assert.ok(!sites.some((s) => s.code.startsWith("has:")));
});

test("jse-audit: finding lines point at the offending line inside multi-line bodies", () => {
  const src = `<component name="L">\n  <head>\n    <action as="a">\n      x = 1\n      class Nope { }\n    </action>\n  </head>\n  <s/>\n</component>`;
  const found = findings(src);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.line, 5);
  assert.equal(found[0]!.snippet, "class Nope { }");
  assert.equal(found[0]!.caret, 0);
});

test("jse-audit: a file that does not parse reports one dsx-parse finding", () => {
  const found = findings(`<c><stack></c>`);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, "dsx-parse");
});

// ── CLI contract ────────────────────────────────────────────────────────────────────

test("jse-audit CLI: --strict exits 1 on findings, plain run exits 0, --json is machine-readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "jse-audit-"));
  try {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "Clean.dsx"), CLEAN_DSX);
    writeFileSync(join(dir, "nested", "Bad.dsx"),
      `<c><head><action as="a">p.then(r => r)</action></head><s on:tap="class X {}"/></c>`);

    assert.deepEqual(findDsxFiles([dir]).map((f) => f.split("/").pop()).sort(), ["Bad.dsx", "Clean.dsx"]);

    const plain = spawnSync(process.execPath, [BIN, dir], { encoding: "utf8" });
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /2 error\(s\) across 1 file\(s\)/);

    const strict = spawnSync(process.execPath, [BIN, "--strict", dir], { encoding: "utf8" });
    assert.equal(strict.status, 1);

    const json = spawnSync(process.execPath, [BIN, "--strict", "--json", dir], { encoding: "utf8" });
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.stdout) as Finding[];
    assert.equal(parsed.length, 2);
    for (const f of parsed) {
      assert.equal(typeof f.file, "string");
      assert.equal(typeof f.line, "number");
      assert.equal(f.severity, "error");
      assert.ok(["banned-construct", "promise-chain"].includes(f.rule));
    }

    const clean = spawnSync(process.execPath, [BIN, "--strict", join(dir, "Clean.dsx")], { encoding: "utf8" });
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /clean — 0 findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jse-audit CLI: an unsafe-number-literal finding adds the 64-bit ID advisory footer", () => {
  const dir = mkdtempSync(join(tmpdir(), "jse-audit-ids-"));
  try {
    writeFileSync(join(dir, "Ids.dsx"),
      `<c><s on:tap="dsx.variable.id = 12345678901234567890"/></c>`);

    const human = spawnSync(process.execPath, [BIN, dir], { encoding: "utf8" });
    assert.equal(human.status, 0); // advisory, not --strict
    assert.match(human.stdout, /\[unsafe-number-literal\]/);
    assert.match(human.stdout, /advisory — 64-bit ID handling/);
    assert.match(human.stdout, /STRINGS end to end/);

    // --json stays machine-readable: pure findings array, no advisory prose
    const json = spawnSync(process.execPath, [BIN, "--json", dir], { encoding: "utf8" });
    const parsed = JSON.parse(json.stdout) as Finding[];
    assert.ok(parsed.some((f) => f.rule === "unsafe-number-literal"));

    // a clean tree prints no advisory
    writeFileSync(join(dir, "Ids.dsx"), `<c><s on:tap="dsx.variable.id = '12345678901234567890'"/></c>`);
    const clean = spawnSync(process.execPath, [BIN, dir], { encoding: "utf8" });
    assert.doesNotMatch(clean.stdout, /64-bit ID handling/);
    assert.match(clean.stdout, /clean — 0 findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
