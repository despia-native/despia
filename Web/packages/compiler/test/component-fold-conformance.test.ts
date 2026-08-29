//
//  component-fold-conformance.test.ts — the COMPONENT FOLD corpus runner (TS lane).
//  Executes every OpenSource/Conformance/components/*.json against the shipped Foundation
//  `.dsx` files themselves; the Kotlin (:core ComponentFoldConformanceTest) and Swift
//  (ComponentFoldConformance, record lane) twins read the SAME json and the SAME .dsx.
//
//  WHY THE COMPONENT AND NOT A COPY OF IT. A markup component has no pure core to call: its
//  law lives in the `<variable computed="true">` and `<formula>` bodies of its own head. So
//  this harness mounts THE HEAD — parse the document, register its attribute defaults,
//  computed variables and formulas into a StackStore exactly as the renderer's head walk
//  does, then evaluate the corpus's expressions against it. There is one owner of every
//  fold: the .dsx file. A corpus that restated the logic would prove nothing.
//
//  Missing corpus = loud failure. A silently-skipped conformance suite is how drift starts.
//  The one legitimate skip is a genuine open drop with no ClosedSource/ tree at all.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { compileComponent } from "../src/component.ts";
import { JSE, StackStore } from "../../kernel/src/jse/jse.ts";

function repoRoot(): string {
  let directory = resolve(import.meta.dirname ?? ".");
  for (;;) {
    if (existsSync(join(directory, "OpenSource/Conformance"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repo root not found");
    directory = parent;
  }
}

type Expectation = { expr: string; value: unknown };
/** A ROOT-element attribute, interpolated the way the renderer binds it — this is how the
 *  accessibility contract is pinned at the element a user actually meets, rather than at a
 *  variable the markup might have forgotten to spend. */
type RootExpectation = { attr: string; value: string };
type Case = {
  name: string;
  attributes?: { [k: string]: unknown };
  vars?: { [k: string]: unknown };
  item?: { [k: string]: unknown };
  expect?: Expectation[];
  root?: RootExpectation[];
};
/** A rule the component's CSS companion must carry, as fragments that appear IN ORDER.
 *  Used for the guarantees that live on the style plane rather than in a fold — the one
 *  today is `<Confetti>`'s reduced-motion rule, which every renderer evaluates. */
type CssExpectation = { name: string; file: string; ordered: string[] };
type Corpus = {
  version: number; component: string; source: string;
  cases: Case[]; css?: CssExpectation[];
};

const root = repoRoot();
const corpusDir = join(root, "OpenSource/Conformance/components");

/** The head walk, 1:1 with the renderers' own (dom/src/mount.ts, StackNodeView.kt
 *  `"variable" | "formula" | "attribute"`, Stack.swift StackHead): attribute defaults, then
 *  the head's functions, then computed formulas and parameterized `<formula>`s. Everything
 *  a component's fold can read, and nothing a body would add. */
function mountHead(source: string, name: string, attributes: { [k: string]: unknown },
                   vars: { [k: string]: unknown }): { store: StackStore; root: { [k: string]: string } } {
  const ir = compileComponent(name, "conformance", source);
  const store = new StackStore();
  store.vars.set("dsx.attribute", { ...attributes });
  for (const a of ir.head.attributes) {
    if (a.default !== undefined) store.attrDefaults.set(a.as, a.default);
  }
  for (const s of ir.head.scripts) JSE.registerFunctions(s, store);
  for (const v of ir.head.variables) {
    if (v.computed) store.computed.set(v.as, v.body);
    else store.initials.set(v.as, JSE.evalBlock(v.body, store, attributes));
  }
  for (const f of ir.head.formulas) store.formulas.set(f.as, { inputs: f.inputs, body: f.body });
  // `vars` seats the non-computed `<variable>` state a case needs (a walk already advanced,
  // a measured box) — the same write a running surface would have made.
  for (const [k, v] of Object.entries(vars)) store.vars.set(k, v);
  return { store, root: ir.root.attrs };
}

/** Canonical JSON for cross-runtime comparison: NSNull is null, an integral number prints
 *  as an integer (Kotlin hands back Doubles for every number), dict keys are sorted. */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) && Number.isInteger(v) ? v : v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const d = v as { [k: string]: unknown };
      if (d["__nsnull"] === true) return null;
      if (Array.isArray(d["__set"])) return { __set: (d["__set"] as unknown[]).map(walk) };
      const out: { [k: string]: unknown } = {};
      for (const k of Object.keys(d).sort()) out[k] = walk(d[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

function corpora(): string[] {
  assert.ok(existsSync(corpusDir), `missing corpus directory ${corpusDir}`);
  const files = readdirSync(corpusDir).filter((n) => n.endsWith(".json")).sort();
  assert.ok(files.length > 0, "OpenSource/Conformance/components holds no fixtures");
  return files;
}

const closedSource = join(root, "ClosedSource");

for (const file of corpora()) {
  const corpus = JSON.parse(readFileSync(join(corpusDir, file), "utf8")) as Corpus;
  test(`component fold: ${file}`, (t) => {
    assert.equal(corpus.version, 1, `${file}: unsupported version`);
    assert.ok(corpus.cases.length > 0, `${file}: no cases`);
    const documentPath = join(root, corpus.source);
    if (!existsSync(closedSource)) {
      t.skip(`${corpus.source} absent — open drop without ClosedSource`);
      return;
    }
    assert.ok(existsSync(documentPath), `${file}: ${corpus.source} does not exist`);
    const source = readFileSync(documentPath, "utf8");
    for (const c of corpus.cases) {
      const { store, root } = mountHead(source, corpus.component, c.attributes ?? {}, c.vars ?? {});
      const expectations = c.expect ?? [];
      const rootExpectations = c.root ?? [];
      assert.ok(expectations.length + rootExpectations.length > 0,
                `${file}/${c.name}: no expectations`);
      for (const e of expectations) {
        const got = JSE.eval(e.expr, store, c.item ?? null);
        assert.equal(canonical(got), canonical(e.value),
                     `${file} · ${c.name} · ${e.expr}`);
      }
      for (const e of rootExpectations) {
        const raw = root[e.attr];
        assert.notEqual(raw, undefined, `${file} · ${c.name}: root has no ${e.attr}=`);
        assert.equal(JSE.interpolate(raw ?? "", store, c.item ?? null), e.value,
                     `${file} · ${c.name} · root ${e.attr}`);
      }
    }
    for (const rule of corpus.css ?? []) {
      const sheet = join(root, rule.file);
      assert.ok(existsSync(sheet), `${file}: ${rule.file} does not exist`);
      const text = readFileSync(sheet, "utf8");
      let at = 0;
      for (const fragment of rule.ordered) {
        const found = text.indexOf(fragment, at);
        assert.notEqual(found, -1, `${file} · css ${rule.name}: missing "${fragment}"`);
        at = found + fragment.length;
      }
    }
  });
}
