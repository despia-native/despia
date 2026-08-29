//
//  lint.test.ts — `despia lint` rule by rule. Every rule is asserted from a SOURCE STRING
//  through the same entry the CLI uses, so a finding cannot pass here and miss on disk.
//  The rules are ports of ClosedSource/scripts/lint_dsx.rb; where a rule is deliberately
//  softened (the scheme universe), the test pins BOTH severities and the reason.
//

import test from "node:test";
import assert from "node:assert/strict";

import {
  lintSource, formatFinding, tally, jseBalanced, nestedTernary, editDistance,
  stripComments, liftCodeBodies, type Finding, type LintContext,
} from "../src/lint.ts";

/** A context that knows one package ("demo" owning <Card/>) and nothing else. */
function context(over: Partial<LintContext> = {}): LintContext {
  return {
    pool: new Map<string, Array<string | null>>([["Card", ["demo"]], ["Shared", [null]]]),
    schemes: new Set(["self", "route", "demo", "toast"]),
    schemeOf: () => "demo",
    styleEjects: new Set<string>(),
    census: null,
    schemesComplete: true,
    ...over,
  };
}

function lint(source: string, over: Partial<LintContext> = {}, file = "/pkg/Components/X.dsx"): Finding[] {
  return lintSource(file, source, context(over));
}

function messages(findings: readonly Finding[]): string[] {
  return findings.map((f) => f.message);
}

function has(findings: readonly Finding[], level: Finding["level"], needle: string): boolean {
  return findings.some((f) => f.level === level && f.message.includes(needle));
}

test("a clean component produces no findings at all", () => {
  const findings = lint(`<stack>
  <head>
    <attribute as="title" default="'Hi'"/>
    <event as="done"/>
    <variable as="count">return 0</variable>
    <action as="bump">dsx.variable.count = dsx.variable.count + 1; dsx.event('done', {})</action>
  </head>
  <text value="{{ dsx.attribute.title }}"/>
  <button label="Go" on:tap="dsx.action.bump()"/>
  <Card/>
</stack>`);
  assert.deepEqual(messages(findings), []);
});

test("well-formedness runs through the RUNTIME parser: a mismatched close is an error", () => {
  const findings = lint(`<stack><text value="a"></stack>`);
  assert.ok(has(findings, "error", "not well-formed DSX"));
  assert.ok(has(findings, "error", "renders it EMPTY"));
});

test("a second root element is an error", () => {
  const findings = lint(`<stack/>\n<stack/>`);
  assert.ok(has(findings, "error", "multiple root elements"));
});

test('"--" inside a comment is an error — the comment ends there and the rest is junk', () => {
  const findings = lint(`<stack>\n<!-- use the --check flag -->\n</stack>`);
  const hit = findings.find((f) => f.message.includes('comment contains "--"'));
  assert.ok(hit !== undefined);
  assert.equal(hit.level, "error");
  assert.equal(hit.line, 2);
});

test("a code-tag name written inside comment prose is a warning", () => {
  const findings = lint(`<stack>\n<!-- the <action> below -->\n</stack>`);
  assert.ok(has(findings, "warning", "code-tag <action> written inside a comment"));
});

test("declarations require as=; the legacy name= identifier is a distinct error", () => {
  const withoutAs = lint(`<stack><head><variable>return 1</variable></head></stack>`);
  assert.ok(has(withoutAs, "error", "<variable> missing as="));
  const withName = lint(`<stack><head><variable name="x">return 1</variable></head></stack>`);
  assert.ok(has(withName, "error", "the legacy name= identifier was removed"));
});

test("<native> and <prop> are removed spellings", () => {
  const findings = lint(`<stack><native/><prop as="x"/></stack>`);
  assert.ok(has(findings, "error", "<native> was removed"));
  assert.ok(has(findings, "error", "<prop> was removed"));
});

test("<expects> without variable= is an error, and <api as> must be an identifier", () => {
  assert.ok(has(lint(`<stack><head><expects/></head></stack>`), "error", "<expects> missing variable="));
  assert.ok(has(
    lint(`<stack><head><api as="not an identifier"/></head></stack>`),
    "error", "must be an ASCII identifier",
  ));
});

test("head anatomy: placement, duplication and canonical order", () => {
  const late = lint(`<stack><text value="a"/><head><attribute as="t"/></head></stack>`);
  assert.ok(has(late, "warning", "<head> must be the FIRST child"));
  const dup = lint(`<stack><head><attribute as="t"/></head><head><attribute as="u"/></head></stack>`);
  assert.ok(has(dup, "warning", "duplicate <head>"));
  const order = lint(`<stack><head><action as="go">return 1</action><attribute as="t"/></head></stack>`);
  assert.ok(has(order, "warning", "head order: <attribute> after <action>"));
  const outside = lint(`<stack><variable as="x">return 1</variable></stack>`);
  assert.ok(has(outside, "warning", "<variable> outside <head>"));
});

test("<head> cannot be the document root", () => {
  assert.ok(has(lint(`<head><attribute as="t"/></head>`), "error", "<head> cannot be the document root"));
});

test("a bound collection without key= warns; a per-row <watch> inside a list does not", () => {
  assert.ok(has(lint(`<stack><list bind="rows"/></stack>`), "warning", "without key="));
  const keyed = lint(`<stack><list bind="rows" key="id"><watch value="dsx.item.x" on:change="dsx.log('x')"/></list></stack>`);
  assert.ok(!has(keyed, "warning", "without key="));
  assert.ok(!has(keyed, "warning", "<watch> outside <head>"));
});

test("screen readiness: settle is root-only, manual must report, unknown modes are errors", () => {
  const nested = lint(`<stack><text settle="manual" value="a"/></stack>`);
  assert.ok(has(nested, "warning", "settle is ROOT-ONLY"));
  const unreported = lint(`<stack settle="manual"><text value="a"/></stack>`);
  assert.ok(has(unreported, "error", 'settle="manual" without any dsx.screen.settled()'));
  const reported = lint(`<stack settle="manual"><head><action as="go">dsx.screen.settled()</action></head></stack>`);
  assert.ok(!has(reported, "error", "without any dsx.screen.settled()"));
  const bogus = lint(`<stack settle="soon"><text value="a"/></stack>`);
  assert.ok(has(bogus, "error", 'settle="soon" is not a readiness mode'));
});

test("component resolution: package-local, global pool, qualified, and unresolved", () => {
  assert.deepEqual(messages(lint(`<stack><Card/><shared.Shared/></stack>`)), []);
  assert.ok(has(lint(`<stack><Nope/></stack>`), "error", "unresolved component"));
  assert.ok(has(lint(`<stack><other.Card/></stack>`), "error", "no component 'Card' in scheme 'other'"));
  assert.ok(has(lint(`<stack><shared.Card/></stack>`), "error", "no global component 'Card'"));
  // an in-file <component as="X"> definition resolves itself
  assert.ok(!has(
    lint(`<stack><head><component as="Local"><text value="a"/></component></head><Local/></stack>`),
    "error", "unresolved component",
  ));
  // capitalized kernel GLOBAL ELEMENTS resolve with no package component (facts.json globalElementTags)
  assert.deepEqual(messages(lint(`<stack><Table bind="dsx.variable.rows" columns="A,B"/><RadioGroup bind="dsx.variable.pick" options="a,b"/></stack>`)), []);
});

test("an unknown lowercase tag warns", () => {
  assert.ok(has(lint(`<stack><blorp/></stack>`), "warning", "unknown element tag"));
});

test("inline handlers have a budget; over it, extract a named <action>", () => {
  const fine = lint(`<stack><button label="a" on:tap="dsx.action.go()"/></stack>`);
  assert.ok(!has(fine, "warning", "over budget"));
  const over = lint(`<stack><button label="a" on:tap="dsx.action.a(); dsx.action.b(); dsx.action.c()"/></stack>`);
  assert.ok(has(over, "warning", "inline handler over budget (3 stmts"));
});

test("JSE balance is checked in on:* attributes and in action/formula/variable bodies", () => {
  assert.ok(has(lint(`<stack><button label="a" on:tap="dsx.action.go("/></stack>`), "error", "unbalanced (){}[]"));
  assert.ok(has(
    lint(`<stack><head><action as="go">const a = [1, 2;</action></head></stack>`),
    "error", "<action> body: unbalanced",
  ));
});

test("unknown dsx.* namespaces warn", () => {
  assert.ok(has(
    lint(`<stack><head><action as="go">dsx.nothere.x = 1</action></head></stack>`),
    "warning", "unknown namespace 'dsx.nothere'",
  ));
});

test("visible-if with {{ }} braces is an error (dict literal — always truthy)", () => {
  assert.ok(has(
    lint(`<stack><text visible-if="{{ dsx.source.online === false }}" value="x"/></stack>`),
    "error", "visible-if: drop the '{{ }}' braces",
  ));
  const bare = lint(`<stack><text visible-if="dsx.source.online === false" value="x"/></stack>`);
  assert.ok(!bare.some((f) => f.message.includes("drop the '{{ }}' braces")));
});

test("store-alias roots the JSE resolver ships are accepted in action bodies", () => {
  const findings = lint(
    `<stack><head><action as="go">if (dsx.source.online === false) { return }\n` +
    `const u = dsx.const.api_url; const j = dsx.input.jump</action></head></stack>`,
  );
  assert.ok(!findings.some((f) => f.message.includes("unknown namespace")));
});

test("dsx.module.<scheme> is an ERROR when the universe is proven, a WARNING when it is not", () => {
  const source = `<stack><head><action as="go">dsx.module.nosuch.call()</action></head></stack>`;
  const proven = lint(source);
  assert.ok(has(proven, "error", "no package claims scheme 'nosuch'"));
  const partial = lint(source, { schemesComplete: false });
  assert.ok(!has(partial, "error", "nosuch"));
  const soft = partial.find((f) => f.message.includes("nosuch"));
  assert.equal(soft?.level, "warning");
  assert.ok(soft.message.includes("lint_dsx.rb proves this against the whole module tree"));
});

test("a declared scheme passes", () => {
  assert.ok(!has(
    lint(`<stack><head><action as="go">dsx.module.toast.show({})</action></head></stack>`),
    "error", "no package claims",
  ));
});

test("nested ternaries in {{ }} and visible-if warn", () => {
  assert.ok(has(lint(`<stack><text value="{{ a ? b : c ? d : e }}"/></stack>`), "warning", "nested ternary"));
  assert.ok(has(lint(`<stack><text visible-if="a ? b : c ? d : e" value="x"/></stack>`), "warning", "nested ternary"));
});

test("a near-miss platform suffix names the word the author meant", () => {
  const findings = lint(`<stack><text label:andriod="x" value="y"/></stack>`);
  assert.ok(has(findings, "warning", "did you mean ':android'?"));
  // real platform words and unrelated namespaces never match
  assert.deepEqual(messages(lint(`<stack><text label:android="x" value="y" on:tap="dsx.log('a')" arg:rate="1"/></stack>`)), []);
});

test("the interface contract: undeclared events and variables warn once each", () => {
  const findings = lint(`<stack>
  <head><variable as="known">return 1</variable></head>
  <button label="a" on:tap="dsx.event('boom', {})"/>
  <text value="{{ dsx.variable.unknown }}{{ dsx.variable.unknown }}"/>
</stack>`);
  assert.equal(messages(findings).filter((m) => m.includes("dsx.event('boom')")).length, 1);
  assert.equal(messages(findings).filter((m) => m.includes("dsx.variable.unknown is not declared")).length, 1);
  assert.ok(!has(findings, "warning", "dsx.variable.known is not declared"));
});

test("a file with no <head> opts out of the interface contract", () => {
  assert.deepEqual(messages(lint(`<stack><text value="{{ dsx.variable.free }}"/></stack>`)), []);
});

test("a watch that writes its own watched key is a reactive cycle", () => {
  assert.ok(has(
    lint(`<stack><head><variable as="n">return 1</variable><watch value="dsx.variable.n" on:change="dsx.variable.n = 2"/></head></stack>`),
    "warning", "writes its own watched key",
  ));
});

test("crypto algorithm names and un-keyed sockets warn", () => {
  assert.ok(has(
    lint(`<stack><head><action as="go">await crypto.subtle.digest('SHA-999', d)</action></head></stack>`),
    "warning", "crypto algorithm 'SHA-999' not in the supported set",
  ));
  assert.ok(!has(
    lint(`<stack><head><action as="go">await crypto.subtle.digest('SHA-256', d)</action></head></stack>`),
    "warning", "crypto algorithm",
  ));
  assert.ok(has(
    lint(`<stack><head><action as="go">const s = new WebSocket('wss://x')</action></head></stack>`),
    "warning", "without { key: '…' }",
  ));
});

test("the system-path ejection NOTICE fires only with the catalog, and appearance=custom silences it", () => {
  const ejects = { styleEjects: new Set(["color", "background"]) };
  const button = lint(`<stack><button variant="filled" color="red" label="a"/></stack>`, ejects);
  const notice = button.find((f) => f.level === "notice");
  assert.ok(notice !== undefined);
  assert.ok(notice.message.includes("systemPath:ejects"));
  // a wordless styled button is the pre-law custom norm — no notice
  assert.ok(!lint(`<stack><button color="red" label="a"/></stack>`, ejects).some((f) => f.level === "notice"));
  // stated intent silences it
  assert.ok(!lint(`<stack><button variant="filled" color="red" appearance="custom" label="a"/></stack>`, ejects)
    .some((f) => f.level === "notice"));
  // a horizontal list is structurally off the system path anyway
  assert.ok(!lint(`<stack><list axis="horizontal" color="red"/></stack>`, ejects).some((f) => f.level === "notice"));
  // no catalog → the notice stands down entirely, never a crash
  assert.ok(!lint(`<stack><button variant="filled" color="red" label="a"/></stack>`).some((f) => f.level === "notice"));
});

test("a platform folder inside Components/ breaks the one-markup-corpus law", () => {
  const findings = lintSource("/pkg/Components/ios/Thing.dsx", `<stack/>`, context());
  assert.ok(has(findings, "error", "platform folder 'ios/' inside Components/"));
});

test("code bodies are lifted before the structural scans — raw JS is never markup", () => {
  const findings = lint(`<stack>
  <head><action as="go">if (a &lt; b) { return "</stack>" }</action></head>
  <text value="ok"/>
</stack>`);
  assert.ok(!has(findings, "error", "unbalanced"));
  assert.ok(!has(findings, "error", "never closed"));
});

test("findings format and tally exactly like lint_dsx.rb prints them", () => {
  const findings = lint(`<stack><Nope/><blorp/></stack>`);
  assert.equal(formatFinding(findings[0]!), `/pkg/Components/X.dsx:1: error: ${findings[0]!.message}`);
  assert.deepEqual(tally(findings), { errors: 1, warnings: 1, notices: 0 });
});

test("the ported helpers behave like their Ruby originals", () => {
  assert.equal(jseBalanced("f({a: [1, 2]})"), true);
  assert.equal(jseBalanced("f({a: [1, 2)}"), false);
  assert.equal(jseBalanced("'unterminated"), false);
  assert.equal(jseBalanced("')}]'"), true, "brackets inside a string never count");
  assert.equal(nestedTernary("a ? b : c ? d : e"), true);
  assert.equal(nestedTernary("a ? b : c"), false);
  assert.equal(nestedTernary("'? ? ?'"), false, "string literals are stripped first");
  assert.equal(editDistance("andriod", "android"), 2);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(stripComments("a<!--\n-->b"), "a    \n   b", "comments blank out, line numbers survive");
  assert.equal(
    liftCodeBodies("<action as=\"g\">a < b</action>"),
    "<action as=\"g\">     </action>",
    "code bodies blank out, line numbers survive",
  );
});

test("string DATA inside a code body is never read as code (the docs-payload law)", () => {
  // A page carrying markdown as a JSE string literal: escaped quotes, braces, phantom
  // namespaces, a quoted dsx.event call, a commented <action> example — all DATA.
  const payload = JSON.stringify(
    "# Title\n\nUse `dsx.variable.count` and dsx.nonsense.stuff here { unbalanced [\n" +
    "call dsx.event('phantom') and <!-- <action as=\"x\"> --> \"quoted\"",
  );
  const findings = lint(`<stack><head><variable as="body">return ${payload}</variable></head><markdown bind="dsx.variable.body"/></stack>`);
  assert.deepEqual(findings, [], `data was read as code: ${findings.map((f) => f.message).join(" | ")}`);
  // …while the SAME constructs OUTSIDE a string still report.
  assert.ok(has(
    lint(`<stack><head><variable as="n">return dsx.nonsense.stuff</variable></head></stack>`),
    "warning", "unknown namespace 'dsx.nonsense'",
  ));
  assert.ok(has(
    lint(`<stack><head><variable as="n">return dsx.variable.ghost</variable></head></stack>`),
    "warning", "dsx.variable.ghost is not declared",
  ));
  // and a REAL escaped-quote string stays balanced.
  assert.deepEqual(
    lint(`<stack><head><variable as="s">return "a \\" quote { and half a brace"</variable></head></stack>`),
    [],
  );
});

// ── the three SILENT drops ────────────────────────────────────────────────────────────
//
//  Each of these parses, renders, and reports nothing while doing nothing. All three were
//  found the only way they can be found without a rule: by building a real screen on them
//  and watching it come out subtly empty.

test("a loop in a <variable> body is LEGAL — expression blocks run the budgeted loop grammar (core-004)", () => {
  const findings = lint(
    `<stack><head><variable as="n" computed="true">let c = 0\n` +
    `for (const x of rows) { c = c + 1 }\nreturn c</variable></head></stack>`,
  );
  assert.ok(!has(findings, "error", "never runs"), JSON.stringify(findings));
  // An <action> body keeps its loop grammar too, unchanged.
  assert.ok(!has(
    lint(`<stack><head><action as="go">for (const x of rows) { total = total + 1 }</action></head></stack>`),
    "error", "never runs",
  ));
});

test("a {{ }} wrapper on a bare-expression attribute is an error", () => {
  for (const attr of ["commands", "bind", "a11yChildren"]) {
    const findings = lint(`<stack><canvas ${attr}="{{ rows }}" a11yLabel="x"/></stack>`);
    assert.ok(has(findings, "error", "drop the '{{ }}' braces"), `${attr}: ${JSON.stringify(findings)}`);
  }
  // The bare spelling is the right one and stays quiet.
  assert.ok(!has(lint(`<stack><canvas commands="rows" a11yLabel="x"/></stack>`), "error", "braces"));
});

test("an authored data- attribute is an error — no renderer forwards it", () => {
  const findings = lint(`<stack><text value="x" data-selected="{{ on }}"/></stack>`);
  assert.ok(has(findings, "error", "dropped by every renderer"), JSON.stringify(findings));
  // The class formula is the spelling that works, and must not be flagged.
  assert.ok(!has(
    lint(`<stack><text value="x" class="row {{ on ? 'row-on' : 'row-off' }}"/></stack>`),
    "error", "dropped by every renderer",
  ));
});
