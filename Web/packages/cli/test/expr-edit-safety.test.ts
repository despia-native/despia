//
//  expr-edit-safety.test.ts - can the visual expression editor corrupt the author's file?
//
//  The expression canvas is the one surface in the Studio that WRITES an author's program
//  from a picture. Every other projection reads. So the question this file exists to answer
//  is not "does the drawing look right" but "is there any sequence of gestures on that
//  drawing that leaves the file saying something the author did not write". The laws below
//  are stated about BYTES and MEANING rather than about nodes or cards on purpose: the
//  projection is being rewritten as this is written, and a safety harness that pins a node
//  shape stops being a safety harness the first time somebody improves the picture.
//
//  Seven things are proved, in the order a corruption would happen:
//    1. a splice touches only the bytes it names, and what it leaves still reads back
//    2. an edit meant to preserve meaning preserves it, to the byte
//    3. both entity regimes carry the author's characters intact, in both directions
//    4. nothing a client can send produces a file the reader cannot read
//    5. `writable: false` is enforced by the server, not merely advertised to the client
//    6. a drawing made against an older file cannot be applied to a newer one
//    7. every degraded read is a described refusal rather than a graph of the wrong bytes
//
//  The generators are SEEDED (`DSX_SAFETY_SEED`) and every failure prints a line that pastes
//  straight back into this file. A fuzz failure nobody can reproduce is a rumour.
//
//  Two of the laws are guarded by a computed predicate rather than by a list of exceptions -
//  `faithful()` and `canonical()` below. Each one is the exact boundary of a defect recorded
//  in SAFETY-HANDOFF.md that lives in a file this harness does not own. They are computed,
//  never hand-listed, so the day the defect is fixed the guard goes dead on its own and the
//  law widens with no edit to it.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { refuseUnsafeSplice, startEditServer } from "../src/edit.ts";

// The edit server admits only its minted credential (the file-write API must never be an open
// door, even on loopback), so every law below speaks through a fetch that carries it. The shadow
// keeps 30 call sites honest without threading a header through each one.
let admission = "";
const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, {
  ...(init ?? {}),
  headers: { ...((init?.headers as Record<string, string>) ?? {}), "x-despia-edit": admission },
});
import {
  applyExprEdit, exprCatalog, projectExpr, reconstructExpr,
  type ExprEditOp, type ExprFlow, type ExprRow,
} from "../src/exprflow.ts";
import {
  decodeRange, exprInvariants, parseExpression, walkExpr,
  type BodyContext, type Span,
} from "../src/expr.ts";
import { encodeForBody, modeValue, type ValueMode } from "../src/nodeflow.ts";
import { FORMS } from "./expr-corpus.ts";

// - the seed, and the ledger the volume claim is made from - 
const SEED = Number(process.env["DSX_SAFETY_SEED"] ?? 0x5afe71) >>> 0;

/** Every generated edit passes through here, so the volume this suite claims is measured
 *  rather than asserted in a comment. */
const tally: { [law: string]: number } = {};
function counted(law: string, n = 1): void { tally[law] = (tally[law] ?? 0) + n; }

/** mulberry32 - small, seeded, and identical on every platform, which is the only property
 *  that matters for a reproducible fuzz. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length) % xs.length]!;
}

/** A failing case, spelled so it pastes straight back into this file. */
function repro(what: string, source: string, edit: ExprEditOp, context: BodyContext): string {
  return `seed=${SEED} context=${JSON.stringify(context)} source=${JSON.stringify(source)} `
    + `edit=${JSON.stringify(edit)} :: ${what}`;
}

// - the two regimes, as predicates rather than as prose - 
const CONTEXTS: BodyContext[] = ["text", "attr", "none"];

/** Can the encoder carry these characters into this regime and back out again? A code-tag
 *  body resolves its three entities only OUTSIDE quoted spans, so an `&` inside a string
 *  literal is escaped on the way in and never unescaped on the way out. SAFETY-HANDOFF.md
 *  finding H1: this predicate is the exact boundary of that defect. */
function faithful(text: string, context: BodyContext): boolean {
  if (context === "none") return true;
  const encoded = encodeForBody(text, context);
  return decodeRange(encoded, { start: 0, end: encoded.length }, context).plain === text;
}

/** Are these bytes already spelled the way the encoder spells them? A code-tag body accepts
 *  both `a && b` and `a &amp;&amp; b` for the same program, and any edit that passes through
 *  the decoder normalises to the second: the same meaning, a wider diff. */
function canonical(source: string, at: Span, context: BodyContext): boolean {
  if (context === "none") return true;
  const held = decodeRange(source, at, context).plain;
  return encodeForBody(held, context) === source.slice(at.start, at.end);
}

/** `encodeForBody` has no "none" arm, because a body always has a regime. */
function encodeIn(text: string, context: BodyContext): string {
  return context === "none" ? text : encodeForBody(text, context);
}

// - the shared per-edit verdict - 
type Verdict = { refused: string | null; next: string };

/** Apply one edit and check every law that must hold WHATEVER the edit was. The door is the
 *  pure splice plus the server's gate, so a splice the gate refuses never reaches a file and
 *  only an ACCEPTED one has to answer for the state it leaves. */
function applyAndCheck(source: string, edit: ExprEditOp, context: BodyContext, law: string): Verdict {
  counted(law);
  const next = applyExprEdit(source, edit, context);
  const at = edit.span;

  // 1. NOTHING OUTSIDE THE SPAN MOVED. The strongest law here, and the one that catches a
  //    re-encoding bug: a door that re-spells the whole body to write one operand has
  //    rewritten bytes nobody touched.
  assert.equal(next.slice(0, at.start), source.slice(0, at.start),
    repro("bytes before the span changed", source, edit, context));
  const tail = source.length - at.end;
  assert.equal(next.slice(next.length - tail), source.slice(at.end),
    repro("bytes after the span changed", source, edit, context));

  // The harness always names the enclosing formula, because it always knows it: the source
  // IS the expression here. A surface that draws a formula knows it for the same reason.
  const whole = { start: 0, end: source.length };
  const refused = refuseUnsafeSplice(source, next, at, context, new Set(), whole);
  if (refused !== null) return { refused, next };

  // 2. THE RESULT IS STILL A PROGRAM. `exact` is the projection's own write gate: false means
  //    the drawing is no longer the expression, and a door that can reach that state can
  //    disable its own editor by being used.
  const parsed = parseExpression(next, { start: 0, end: next.length }, context);
  assert.equal(parsed.exact, true, repro("the result no longer parses exactly", source, edit, context));

  // 3. THE TREE STILL TILES: children inside parents, siblings disjoint and in source order.
  //    A splice on one node must not be able to disturb another.
  assert.deepEqual(exprInvariants(parsed.root), [],
    repro("tree invariants broke", source, edit, context));

  // 4. THE DRAWING REPRODUCES THE FILE, and every span it hands out addresses the file.
  const flow = projectExpr(next, undefined, context);
  assert.equal(reconstructExpr(flow), next, repro("the projection no longer reconstructs", source, edit, context));
  assert.equal(flow.exact, true, repro("the projection is not exact", source, edit, context));
  assertSpanDiscipline(flow, source, edit, context);
  return { refused: null, next };
}

/** Span discipline, stated so ANY correct projection passes it: every span the drawing hands
 *  out lies inside the range it drew, no span is inverted, and a row's span lies inside its
 *  own node's. Nothing here knows what a node looks like. */
function assertSpanDiscipline(flow: ExprFlow, source: string, edit: ExprEditOp, context: BodyContext): void {
  for (const node of flow.nodes) {
    const inside = node.span.start >= flow.span.start && node.span.end <= flow.span.end
      && node.span.start <= node.span.end;
    assert.ok(inside, repro(`node span [${node.span.start},${node.span.end}) escapes the drawing`, source, edit, context));
    for (const row of node.rows) {
      const held = row.span.start >= node.span.start && row.span.end <= node.span.end
        && row.span.start <= row.span.end;
      assert.ok(held, repro(`row span [${row.span.start},${row.span.end}) escapes its node`, source, edit, context));
    }
  }
}

// - the generators - 
function nodeSpans(source: string, context: BodyContext): Span[] {
  const parsed = parseExpression(source, { start: 0, end: source.length }, context);
  if (!parsed.exact) return [];
  const out: Span[] = [];
  walkExpr(parsed.root, (n) => out.push({ start: n.span.start, end: n.span.end }));
  return out;
}

/** Every (parent, child) pair a real unwrap could name: both spans come from one parse, so
 *  the operation is the one the surface can actually produce. */
function liftPairs(source: string, context: BodyContext): { span: Span; inner: Span }[] {
  const parsed = parseExpression(source, { start: 0, end: source.length }, context);
  if (!parsed.exact) return [];
  const out: { span: Span; inner: Span }[] = [];
  walkExpr(parsed.root, (node) => {
    walkExpr(node, (kid) => {
      if (kid === node) return;
      if (kid.span.start === node.span.start && kid.span.end === node.span.end) return;
      out.push({
        span: { start: node.span.start, end: node.span.end },
        inner: { start: kid.span.start, end: kid.span.end },
      });
    });
  });
  return out;
}

function rowsOf(flow: ExprFlow): ExprRow[] {
  return flow.nodes.flatMap((n) => n.rows);
}

/** The rows a `literal` edit is FOR: unwired, non-empty, and ADVERTISING THE VALUE THE FILE
 *  HOLDS. That last clause is the whole contract of a `literal` edit - `value` goes out to a
 *  control and comes back in to be written - so a row where the two disagree is not a row a
 *  literal edit can address. See SAFETY-HANDOFF.md H4 for the rows that disagree today. */
function literalRows(flow: ExprFlow): ExprRow[] {
  return rowsOf(flow).filter((r) =>
    !r.wired && r.span.end > r.span.start && modeValue(r.text, r.mode) === r.value);
}

/** Values a person could plausibly type into a row of this mode. Every one is a complete
 *  expression on its own, because that is what the door is allowed to accept. */
const PLAUSIBLE: { [k in ValueMode]: string[] } = {
  text: ["Save", "", " ", "Total due", "0"],
  number: ["0", "42", "-1", "3.5"],
  boolean: ["true", "false"],
  reference: ["total", "user.name", "rows"],
  expression: ["total", "1 + 2", "'x'", "rows.length"],
  empty: [""],
};

/** What a paste, a wire and an unwire all are: whole source over a whole operand. */
const REPLACEMENTS = ["x", "0", "'s'", "true", "(a + b)", "rows.length", "user.name", "1 + 2"];

// - LAW 1: round-trip under random editing - 
test("law 1: every single edit over the corpus, in every regime, leaves a readable file", () => {
  const templates = exprCatalog().map((c) => c.template);
  let refusals = 0;
  for (const context of CONTEXTS) {
    for (const form of FORMS) {
      const spans = nodeSpans(form, context);
      if (spans.length === 0) continue;
      const flow = projectExpr(form, undefined, context);
      if (!flow.exact) continue;

      for (const row of literalRows(flow)) {
        for (const value of PLAUSIBLE[row.mode]) {
          if (applyAndCheck(form, { op: "literal", span: row.span, value, mode: row.mode }, context, "1:literal").refused !== null) refusals++;
        }
      }
      for (const span of spans) {
        for (const text of REPLACEMENTS) {
          if (applyAndCheck(form, { op: "replace", span, text }, context, "1:replace").refused !== null) refusals++;
        }
        for (const template of templates) {
          if (applyAndCheck(form, { op: "wrap", span, template }, context, "1:wrap").refused !== null) refusals++;
        }
      }
      for (const pair of liftPairs(form, context)) {
        if (applyAndCheck(form, { op: "unwrap", span: pair.span, inner: pair.inner }, context, "1:unwrap").refused !== null) refusals++;
      }
    }
  }
  assert.ok(tally["1:replace"]! > 10_000, "the corpus sweep did not run");
  assert.ok(refusals > 0, "the gate refused nothing at all, which means it is not wired in");
});

test("law 1: long chains of successive edits - spans move, and the file survives it", () => {
  const r = rng(SEED ^ 0x9e3779b9);
  const templates = exprCatalog().map((c) => c.template);
  for (const context of CONTEXTS) {
    for (const form of FORMS) {
      if (!parseExpression(form, { start: 0, end: form.length }, context).exact) continue;
      let source = form;
      for (let step = 0; step < 24; step++) {
        const spans = nodeSpans(source, context);
        if (spans.length === 0) break;
        const flow = projectExpr(source, undefined, context);
        if (!flow.exact) break;
        const rows = literalRows(flow);
        const roll = r();
        let edit: ExprEditOp;
        if (roll < 0.3 && rows.length > 0) {
          const row = pick(r, rows);
          edit = { op: "literal", span: row.span, value: pick(r, PLAUSIBLE[row.mode]), mode: row.mode };
        } else if (roll < 0.6) {
          edit = { op: "replace", span: pick(r, spans), text: pick(r, REPLACEMENTS) };
        } else if (roll < 0.85) {
          edit = { op: "wrap", span: pick(r, spans), template: pick(r, templates) };
        } else {
          const pairs = liftPairs(source, context);
          if (pairs.length === 0) continue;
          const chosen = pick(r, pairs);
          edit = { op: "unwrap", span: chosen.span, inner: chosen.inner };
        }
        const verdict = applyAndCheck(source, edit, context, "1:chain");
        if (verdict.refused === null) source = verdict.next;
      }
    }
  }
  assert.ok(tally["1:chain"]! > 10_000, `chains ran only ${tally["1:chain"]} edits`);
});

// - LAW 2: meaning preservation where the edit is meant to preserve meaning - 
test("law 2: a wrap and its own unwrap return the author's exact bytes", () => {
  let checked = 0, absorbed = 0;
  for (const context of CONTEXTS) {
    for (const form of FORMS) {
      for (const span of nodeSpans(form, context)) {
        const held = decodeRange(form, span, context).plain;
        for (const item of exprCatalog()) {
          counted("2:wrap-unwrap");
          const wrapped = applyExprEdit(form, { op: "wrap", span, template: item.template }, context);
          if (refuseUnsafeSplice(form, wrapped, span, context, new Set()) !== null) continue;
          const outer = { start: span.start, end: span.end + (wrapped.length - form.length) };
          // The old text lands inside the wrap ENCODED, and the template's own prefix does
          // too, so the inner span is measured in the bytes that were actually written.
          const lead = item.template.slice(0, item.template.indexOf("$"));
          const innerStart = span.start + encodeIn(lead, context).length;
          const inner = { start: innerStart, end: innerStart + encodeIn(held, context).length };
          const back = applyExprEdit(wrapped, { op: "unwrap", span: outer, inner }, context);

          // The MEANING always comes back, whatever the spelling.
          if (faithful(held, context)) {
            const restored = { start: span.start, end: span.end + (back.length - form.length) };
            assert.equal(decodeRange(back, restored, context).plain, held,
              `seed=${SEED} ${context} ${JSON.stringify(form)} wrap ${JSON.stringify(item.template)}`
              + ` -> ${JSON.stringify(wrapped)} -> ${JSON.stringify(back)}`);
          }
          // And the BYTES come back whenever the file already held them in the spelling the
          // encoder produces. Where it did not, the door normalises the span it touched.
          if (faithful(held, context) && canonical(form, span, context)) {
            assert.equal(back, form,
              `seed=${SEED} ${context} ${JSON.stringify(form)} wrap ${JSON.stringify(item.template)} did not come back`);
            checked++;
          }
          // Whether the wrap produced a NODE is a different question: SAFETY-HANDOFF.md H3.
          const reparsed = parseExpression(wrapped, { start: 0, end: wrapped.length }, context);
          let found = false;
          if (reparsed.exact) {
            walkExpr(reparsed.root, (n) => {
              if (n.span.start === outer.start && n.span.end === outer.end) found = true;
            });
          }
          if (!found) absorbed++;
        }
      }
    }
  }
  assert.ok(checked > 10_000, `only ${checked} wrap/unwrap pairs were byte-checked`);
  assert.ok(absorbed > 0, "precedence absorption vanished - re-read SAFETY-HANDOFF.md H3 before deleting this");
});

test("law 2: a row that hands back its own value does not touch the file", () => {
  for (const context of CONTEXTS) {
    for (const form of FORMS) {
      const flow = projectExpr(form, undefined, context);
      if (!flow.exact) continue;
      for (const row of literalRows(flow)) {
        counted("2:no-op");
        assert.equal(
          applyExprEdit(form, { op: "literal", span: row.span, value: row.value, mode: row.mode }, context),
          form,
          `seed=${SEED} ${context} a no-op literal write moved bytes in ${JSON.stringify(form)}`
          + ` at [${row.span.start},${row.span.end})`,
        );
      }
    }
  }
  // The corpus is 194 short forms, so this population is small by nature - every unwired
  // row of every form, in three regimes.
  assert.ok(tally["2:no-op"]! > 800, `only ${tally["2:no-op"]} no-op writes were checked`);
});

test("law 2: a replace with the text already there does not touch the file", () => {
  for (const context of CONTEXTS) {
    for (const form of FORMS) {
      for (const span of nodeSpans(form, context)) {
        counted("2:replace-identity");
        const held = decodeRange(form, span, context).plain;
        const next = applyExprEdit(form, { op: "replace", span, text: held }, context);
        if (canonical(form, span, context)) {
          assert.equal(next, form, `seed=${SEED} ${context} identity replace moved bytes in ${JSON.stringify(form)}`);
        } else if (faithful(held, context)) {
          // The span is renormalised rather than left alone, so the MEANING is what holds.
          const wrote = { start: span.start, end: span.start + encodeIn(held, context).length };
          assert.equal(decodeRange(next, wrote, context).plain, held,
            `seed=${SEED} ${context} identity replace changed the meaning of ${JSON.stringify(form)}`);
        }
      }
    }
  }
  assert.ok(tally["2:replace-identity"]! > 1000);
});

// - LAW 3: both entity regimes, exhaustively - 
/** The inner text of a string literal, as the AUTHOR writes it. Each one is a character the
 *  two regimes disagree about, or a shape that looks like one. */
const LITERALS = [
  "plain",
  "a & b",
  "a < b",
  "a > b",
  'say \\"hi\\"',
  "it\\'s",
  "&#65;",
  "back\\\\slash",
  "line\\nbreak",
  "emoji \u{1f600} here",
  "&amp;",
  "&lt;",
  "<stack/>",
  "100% & <b>&lt;/b>",
  "",
  " ",
];

/** The bytes a file holds for this literal in this regime. A code-tag body's evaluator never
 *  looks inside a literal, so the characters go in verbatim; an attribute body is decoded by
 *  the XML reader before the evaluator sees anything, so every reserved character is spelled
 *  as an entity there, inside the literal too. */
function spell(inner: string, context: BodyContext): string {
  if (context !== "attr") return `'${inner}'`;
  const escaped = inner
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
  return `'${escaped}'`;
}

test("law 3: the reader shows the author's characters, in both regimes", () => {
  for (const context of CONTEXTS) {
    for (const inner of LITERALS) {
      counted("3:read");
      const source = `f(${spell(inner, context)})`;
      const flow = projectExpr(source, undefined, context);
      assert.equal(flow.exact, true, `seed=${SEED} ${context} ${JSON.stringify(source)} did not project exactly`);
      // The row is found by its SPAN, never by its mode: a literal carrying a backslash is
      // classified as a computation rather than as text, which is a judgement about controls
      // and no business of a law about characters.
      const at = { start: 2, end: source.length - 1 };
      const row = rowsOf(flow).find((x) => x.span.start === at.start && x.span.end === at.end);
      assert.ok(row !== undefined, `seed=${SEED} ${context} no row addresses the literal in ${JSON.stringify(source)}`);
      assert.equal(decodeRange(source, at, context).plain, `'${inner}'`,
        `seed=${SEED} ${context} the reader does not see the author's characters in ${JSON.stringify(source)}`);
      if (row.mode === "text") {
        assert.equal(row.value, inner,
          `seed=${SEED} ${context} the drawing shows the transport, not the language, for ${JSON.stringify(source)}`);
      }
    }
  }
});

test("law 3: an edit ELSEWHERE never disturbs a literal that looks like an entity", () => {
  for (const context of CONTEXTS) {
    for (const inner of LITERALS) {
      const literal = spell(inner, context);
      const source = `f(${literal}, 1)`;
      const flow = projectExpr(source, undefined, context);
      if (!flow.exact) continue;
      const other = rowsOf(flow).find((x) => x.mode === "number");
      assert.ok(other !== undefined, `seed=${SEED} ${context} no second row in ${JSON.stringify(source)}`);
      for (const value of ["2", "0", "-7"]) {
        counted("3:elsewhere");
        const next = applyExprEdit(source, { op: "literal", span: other.span, value, mode: "number" }, context);
        assert.ok(next.includes(literal),
          `seed=${SEED} ${context} an unrelated edit rewrote ${JSON.stringify(literal)}: ${JSON.stringify(next)}`);
        assert.equal(next.slice(0, other.span.start), source.slice(0, other.span.start),
          `seed=${SEED} ${context} bytes before the edited row moved`);
      }
    }
  }
});

test("law 3: writing a literal lands the author's characters and nothing else", () => {
  for (const context of CONTEXTS) {
    for (const from of LITERALS) {
      const source = `f(${spell(from, context)})`;
      const flow = projectExpr(source, undefined, context);
      if (!flow.exact) continue;
      const row = rowsOf(flow).find((x) => x.mode === "text");
      if (row === undefined) continue;
      for (const to of LITERALS) {
        counted("3:write");
        const next = applyExprEdit(source, { op: "literal", span: row.span, value: to, mode: "text" }, context);
        const written: ExprRow | undefined = rowsOf(projectExpr(next, undefined, context))
          .find((x) => x.span.start === row.span.start);
        assert.ok(written !== undefined, `seed=${SEED} ${context} the written row vanished: ${JSON.stringify(next)}`);
        // `value` leaves the row as the literal's INNER SOURCE and comes back in as a plain
        // character string, so the escaper doubles anything that was already an escape.
        // SAFETY-HANDOFF.md finding H2 - the predicate, not a list, marks the boundary.
        if (!/[\\']/.test(to) && faithful(`'${to}'`, context)) {
          assert.equal(written.value, to,
            `seed=${SEED} ${context} wrote ${JSON.stringify(to)} into ${JSON.stringify(source)}`
            + ` and read back ${JSON.stringify(written.value)}`);
        }
        assert.equal(next.slice(0, row.span.start), source.slice(0, row.span.start),
          `seed=${SEED} ${context} bytes before the row moved`);
      }
    }
  }
  assert.ok(tally["3:write"]! > 400);
});

test("law 3: the attribute regime carries a numeric entity and a real newline", () => {
  // `&#10;` is a newline the XML reader has already resolved by the time the evaluator sees
  // the body, so the expression the author wrote spans three lines.
  const source = "f(&#10;  'x',&#10;  2&#10;)";
  const flow = projectExpr(source, undefined, "attr");
  assert.equal(flow.exact, true);
  assert.ok(flow.source.includes("\n"), "the numeric entity never became a newline");
  const row = rowsOf(flow).find((x) => x.mode === "number");
  assert.ok(row !== undefined);
  const next = applyExprEdit(source, { op: "literal", span: row.span, value: "9", mode: "number" }, "attr");
  assert.equal(next, "f(&#10;  'x',&#10;  9&#10;)", "editing one operand re-spelled the newlines around it");
  counted("3:numeric-entity");
});

test("law 3: the code-tag regime leaves an author's literal `&lt;` alone", () => {
  // The evaluator does not decode inside a quoted span, so these four characters ARE the
  // string. An unrelated edit must not touch them.
  const source = "concat('&lt;', tag)";
  const flow = projectExpr(source, undefined, "text");
  assert.equal(flow.exact, true);
  const reference = rowsOf(flow).find((x) => x.mode === "reference" && x.value === "tag");
  assert.ok(reference !== undefined);
  assert.equal(applyExprEdit(source, { op: "replace", span: reference.span, text: "label" }, "text"),
    "concat('&lt;', label)");
  counted("3:adversarial");

  // And the defect that makes the guard worth having: an edit ON that span re-escapes it,
  // and it compounds on every further edit. SAFETY-HANDOFF.md finding H1. When these two
  // assertions start failing, the encoder has been made quote-aware and every `faithful()`
  // guard in this file can go.
  const literal = rowsOf(flow).find((x) => x.mode === "text")!;
  assert.equal(faithful(decodeRange(source, literal.span, "text").plain, "text"), false,
    "the encoder became faithful - delete the guards");
  const once = applyExprEdit(source, { op: "wrap", span: literal.span, template: "$.trim()" }, "text");
  assert.equal(once, "concat('&amp;lt;'.trim(), tag)",
    "the known re-escaping defect changed shape - re-measure before trusting the guards");
});

// - LAW 4: nothing a client can send produces an unreadable document - 
const HOSTILE = [
  "", ")", "(", "'", '"', "`", "//", "// note", "/*", "\n", "((", "a b", "?", ":", "}", "]",
  ",", "...", "&", "<", "</stack>", "'unclosed", "`unclosed", "/re", "0x", "1..2", ".",
  "return", "let x = 1", " ", "'\\'",
];

test("law 4: hostile text is refused, or leaves a document that still reads", () => {
  let refused = 0, allowed = 0;
  for (const context of CONTEXTS) {
    for (const form of FORMS) {
      for (const span of nodeSpans(form, context)) {
        for (const text of HOSTILE) {
          counted("4:hostile");
          const edit: ExprEditOp = { op: "replace", span, text };
          const next = applyExprEdit(form, edit, context);
          if (refuseUnsafeSplice(form, next, span, context, new Set()) !== null) { refused++; continue; }
          allowed++;
          const parsed = parseExpression(next, { start: 0, end: next.length }, context);
          assert.equal(parsed.exact, true, repro("hostile text was ACCEPTED and broke the file", form, edit, context));
          assert.deepEqual(exprInvariants(parsed.root), [],
            repro("hostile text was ACCEPTED and broke the tree", form, edit, context));
        }
      }
    }
  }
  assert.ok(refused > 10_000, `the gate refused only ${refused} hostile splices`);
  assert.ok(allowed > 0, "the gate refused everything, which is a different bug");
});

test("law 4: the pure splice does NOT refuse - the gate is the door, not the splice", () => {
  // Stated as a law so nobody mistakes `applyExprEdit` for a safe boundary. It is a splice
  // primitive and it writes what it is told; everything that decides whether a splice may
  // happen lives in `refuseUnsafeSplice`, which is what the server calls before it writes.
  const broken = applyExprEdit("a + b", { op: "replace", span: { start: 0, end: 1 }, text: ")" }, "text");
  assert.equal(broken, ") + b");
  assert.equal(parseExpression(broken, { start: 0, end: broken.length }, "text").exact, false);
  assert.ok(refuseUnsafeSplice("a + b", broken, { start: 0, end: 1 }, "text", new Set()) !== null);
  counted("4:splice-is-not-a-door");
});

test("law 4: a splice may not change how the bytes AROUND it read", () => {
  // The corruption that survives "no byte outside the span changed": a `0` written over the
  // receiver of `rows[0].items` fuses with the `.` beside it into one number, and the two
  // tokens after the span are gone without a byte of theirs being touched.
  const source = "rows[0].items";
  const at = { start: 0, end: 7 };
  const next = applyExprEdit(source, { op: "replace", span: at, text: "0" }, "text");
  assert.equal(next, "0.items");
  assert.equal(next.slice(next.length - (source.length - at.end)), source.slice(at.end));
  assert.ok(refuseUnsafeSplice(source, next, at, "text", new Set()) !== null,
    "the seam law does not catch token fusion");
  counted("4:seam");
});

// - the fixtures the server laws run against - 
const DOC = encodeURIComponent("Components/App.dsx");
const HANDLER = encodeURIComponent("on:tap@1");

// The handler is ONE expression on purpose: that is the shape the formula canvas addresses,
// and it is an ATTRIBUTE body, so it exercises the regime the code-tag rule would get wrong.
const SAFE_DOC = `<stack>
  <head>
    <variable as="rows">return []</variable>
    <action as="settle" inputs="id">
      let sum = 0
      sum = Math.round(rows.length * 2)
      return sum
    </action>
  </head>
  <button label="Go" on:tap="settle(rows.length * 2, 'a &amp; b')"/>
</stack>
`;

/** A body's own bytes, sliced out of the fixture the way `logicBodies` slices them. */
function bodyOf(kind: "action" | "handler"): string {
  if (kind === "action") return SAFE_DOC.match(/<action[^>]*>([\s\S]*?)<\/action>/)![1]!;
  return SAFE_DOC.match(/on:tap="([^"]*)"/)![1]!;
}

function fixture(source: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsx-expr-safety-"));
  for (const [path, contents] of Object.entries({
    "dsx.json": JSON.stringify({ name: "fixture", scheme: "fix" }),
    "dsx.config.json": JSON.stringify({ name: "Fixture", entry: "App" }),
    "Components/App.dsx": source,
  })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

type ExprRead = {
  document: string; body: string; writable: boolean; rev: string; exact: boolean;
  span: Span; context: string; source: string;
  nodes: { id: string; span: Span; rows: { span: Span; value: string; mode: ValueMode }[] }[];
  reason?: string; message?: string;
};

async function readExpr(base: string, query: string): Promise<{ status: number; json: ExprRead }> {
  const res = await fetch(`${base}/edit/api/expr/${DOC}${query}`);
  return { status: res.status, json: (await res.json()) as ExprRead };
}

// - LAW 5: read-only actually means read-only - 
test("law 5: a body the server calls unwritable refuses every mutation", async () => {
  const fx = fixture(SAFE_DOC);
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  admission = server.admission;
  const base = `http://127.0.0.1:${server.port}`;
  const file = join(fx.root, "Components", "App.dsx");
  try {
    const whole = await readExpr(base, `?body=${HANDLER}`);
    assert.equal(whole.json.writable, true, "the fixture's handler should be writable");

    // Address the handler up to a dangling `*`: the reader cannot make one expression of
    // that, so the drawing is not authoritative and the server must say so rather than let a
    // save discover it.
    const cut = bodyOf("handler").indexOf("*") + 1;
    const half = await readExpr(base, `?body=${HANDLER}&at=0&to=${cut}`);
    assert.equal(half.json.exact, false, "a half expression projected as exact");
    assert.equal(half.json.writable, false, "a drawing that is not the expression was advertised as writable");

    // The client ignores the flag and posts anyway. The span is neither a statement nor a
    // comment, so the operand rule applies and the server refuses on its own account.
    const before = readFileSync(file, "utf8");
    const post = await fetch(`${base}/edit/api/flowedit/${DOC}`, {
      method: "POST",
      body: JSON.stringify({ body: "on:tap@1", rev: half.json.rev, op: { op: "replace", span: { start: 0, end: cut }, text: "x" } }),
    });
    assert.equal(post.status, 409, "a write through a non-authoritative drawing was accepted");
    assert.equal(((await post.json()) as { reason: string }).reason, "refused_edit");
    assert.equal(readFileSync(file, "utf8"), before, "a refused write still reached the file");
    counted("5:refusal", 2);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("law 5: the expression endpoint has no write verb at all", async () => {
  const fx = fixture(SAFE_DOC);
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  admission = server.admission;
  const base = `http://127.0.0.1:${server.port}`;
  const file = join(fx.root, "Components", "App.dsx");
  const before = readFileSync(file, "utf8");
  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/edit/api/expr/${DOC}?body=action:settle`, {
        method, ...(method === "DELETE" ? {} : { body: "{}" }),
      });
      counted("5:verb");
      assert.notEqual(res.status, 500, `${method} on the expression endpoint raised a 500`);
      assert.equal(readFileSync(file, "utf8"), before, `${method} on the expression endpoint wrote to the file`);
    }
    assert.equal((await fetch(`${base}/edit/api/flowedit/${DOC}`)).status, 405);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// - LAW 6: a stale revision cannot be applied to shifted bytes - 
test("law 6: an expression edit computed against an older file is refused, not shifted", async () => {
  const fx = fixture(SAFE_DOC);
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  admission = server.admission;
  const base = `http://127.0.0.1:${server.port}`;
  const file = join(fx.root, "Components", "App.dsx");
  try {
    const drew = await readExpr(base, `?body=${HANDLER}`);
    assert.equal(drew.json.writable, true);
    assert.equal(drew.json.exact, true);

    const row = drew.json.nodes.flatMap((n) => n.rows).find((x) => x.mode === "text");
    assert.ok(row !== undefined, "the fixture formula has no literal operand");

    // The first writer lands a LONGER literal in the same slot, so every span past it in the
    // drawing the second writer is holding now addresses different bytes.
    const first = await fetch(`${base}/edit/api/flowedit/${DOC}`, {
      method: "POST",
      body: JSON.stringify({ body: "on:tap@1", rev: drew.json.rev, op: { op: "replace", span: row.span, text: "'a much longer first value'" } }),
    });
    assert.equal(first.status, 200, await first.text());
    const moved = readFileSync(file, "utf8");
    const stale = await fetch(`${base}/edit/api/flowedit/${DOC}`, {
      method: "POST",
      body: JSON.stringify({ body: "on:tap@1", rev: drew.json.rev, op: { op: "replace", span: row.span, text: "'zz'" } }),
    });
    assert.equal(stale.status, 409, "a stale expression edit was applied to shifted bytes");
    assert.equal(((await stale.json()) as { reason: string }).reason, "stale_revision");
    assert.equal(readFileSync(file, "utf8"), moved, "a refused stale edit still moved a byte");

    // Re-reading gives a fresh revision, and the same gesture against IT is accepted.
    const again = await readExpr(base, `?body=${HANDLER}`);
    assert.notEqual(again.json.rev, drew.json.rev);
    const fresh = again.json.nodes.flatMap((n) => n.rows).find((x) => x.mode === "text")!;
    const ok = await fetch(`${base}/edit/api/flowedit/${DOC}`, {
      method: "POST",
      body: JSON.stringify({ body: "on:tap@1", rev: again.json.rev, op: { op: "replace", span: fresh.span, text: "'zz'" } }),
    });
    assert.equal(ok.status, 200, await ok.text());
    const landed = readFileSync(file, "utf8");
    assert.ok(landed.includes("'zz'"), "the accepted edit did not land");
    assert.ok(!landed.includes("'a &amp; b'"), "the replaced literal is still in the file");
    counted("6:stale", 3);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// - LAW 7: parse failure and degraded states - 
test("law 7: every degraded read is a described refusal, never a 500 and never a wrong graph", async () => {
  const fx = fixture(SAFE_DOC);
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  admission = server.admission;
  const base = `http://127.0.0.1:${server.port}`;
  const body = encodeURIComponent("action:settle");
  const file = join(fx.root, "Components", "App.dsx");
  const len = (SAFE_DOC.match(/<action[^>]*>([\s\S]*?)<\/action>/)![1] ?? "").length;
  try {
    const cases: [string, number, string][] = [
      [`?body=${body}`, 200, "the whole body"],
      ["?body=nope", 404, "an unknown body"],
      ["", 404, "no body named"],
      [`?body=${body}&at=0&to=0`, 400, "an empty range"],
      [`?body=${body}&at=9&to=4`, 400, "an inverted range"],
      [`?body=${body}&at=-50&to=999999`, 200, "both ends out of range, clamped"],
      [`?body=${body}&at=abc&to=xyz`, 200, "unreadable offsets, both fall back"],
      [`?body=${body}&at=1.9&to=6.7`, 200, "fractional offsets, truncated"],
      [`?body=${body}&at=${len}&to=${len + 500}`, 400, "a range wholly past the end"],
    ];
    for (const [query, status, why] of cases) {
      const answer = await readExpr(base, query);
      counted("7:degraded");
      assert.equal(answer.status, status, `${why}: expected ${status}, got ${answer.status}`);
      if (status === 200) {
        // A clamped range is INSIDE the body, always: a hand-typed offset can never address
        // another file, and a graph of the wrong bytes is worse than no graph at all.
        const span = answer.json.span;
        assert.ok(span.start >= 0 && span.end <= len && span.start < span.end,
          `${why}: the answered span [${span.start},${span.end}) escapes a ${len}-byte body`);
        for (const node of answer.json.nodes) {
          assert.ok(node.span.start >= span.start && node.span.end <= span.end,
            `${why}: a node escaped the answered range`);
        }
      } else {
        assert.ok(typeof answer.json.reason === "string" && answer.json.reason.length > 0, `${why}: a refusal with no reason`);
        assert.ok(typeof answer.json.message === "string" && answer.json.message.length > 0, `${why}: a refusal with no message`);
      }
    }

    // A span landing across two statements: a graph comes back, it says it is not exact, and
    // it says it is not writable. Never a partial graph presented as the program.
    const cut = bodyOf("action").indexOf("let sum");
    const partial = await readExpr(base, `?body=${body}&at=${cut}&to=${cut + 7}`);
    assert.equal(partial.json.exact, false);
    assert.equal(partial.json.writable, false);

    assert.equal((await fetch(`${base}/edit/api/expr/${encodeURIComponent("Components/Nope.dsx")}?body=${body}`)).status, 404);
    assert.equal((await fetch(`${base}/edit/api/expr/${encodeURIComponent("../../etc/passwd")}?body=${body}`)).status, 404);

    // MID-SAVE: the file on disk is half a document. The reader cannot parse it, so there are
    // no bodies, so the named body is unknown - a clean 404, not a 500 and not half a graph.
    writeFileSync(file, SAFE_DOC.slice(0, 120));
    const midSave = await readExpr(base, `?body=${body}`);
    assert.equal(midSave.status, 404, "a half-written document did not refuse cleanly");
    assert.equal(midSave.json.reason, "unknown_body");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("law 7: a handler body is read under ITS OWN entity regime", async () => {
  const fx = fixture(SAFE_DOC);
  const server = await startEditServer(loadConfig(fx.root), { port: 0, host: "127.0.0.1", watch: false, log: () => {} });
  admission = server.admission;
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // `on:tap="settle({ id: 1, tag: 'a &amp; b' })"` is an ATTRIBUTE body: the XML reader has
    // resolved `&amp;` before the evaluator sees it, so the author's string is `a & b`. Drawn
    // under the code-tag rule the projection is not even exact, and every value that drawing
    // hands out is the transport rather than the language.
    const read = await readExpr(base, `?body=${HANDLER}`);
    assert.equal(read.json.context, "attr", "the endpoint did not pass the body's regime to the projection");
    assert.equal(read.json.exact, true, "the handler did not project exactly, which is the wrong-regime symptom");
    assert.ok(read.json.source.includes("'a & b'"),
      `the drawing shows the transport rather than the language: ${read.json.source}`);
    assert.ok(!read.json.source.includes("&amp;"), "an entity survived into the drawing");
    counted("7:regime");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

// - the volume claim, measured - 
test("the harness generated the volume it claims", () => {
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  const rows = Object.entries(tally).sort().map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`\n  seed=0x${SEED.toString(16)}  generated=${total}\n  ${rows}\n`);
  assert.ok(total >= 100_000, `only ${total} edits were generated: ${rows}`);
});
