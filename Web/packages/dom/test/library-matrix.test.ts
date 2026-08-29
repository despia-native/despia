// The Trinity matrix's WEB column, machine-checked against this renderer's own registry
// (the element-support-ledger.test.ts pattern). The matrix (Conformance/library/matrix.json,
// component-library.md W8) is the program scoreboard; its generated web fields must never
// drift from the ledgers and factories they claim to describe. The Ruby gate
// (ClosedSource/scripts/check_library_matrix.rb) owns full schema + regression enforcement;
// this twin proves the WEB generated plane against the running DOM registry itself.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ELEMENTS,
  GLOBAL_ELEMENTS,
  registerGlobalElements,
  registerRichElements,
} from "../src/elements.ts";
import { UNIVERSAL_GLOBAL_ELEMENTS } from "../src/globals.ts";
import { FORM_ELEMENTS } from "../src/forms.ts";
import { registerNativeControls } from "../src/native-controls.ts";
import { registerStructuralControls } from "../src/structural-controls.ts";
import { registerOverlayControls } from "../src/overlay-controls.ts";
import { registerDataControls } from "../src/data-controls.ts";
import { registerApplicationControls } from "../src/application-controls.ts";
import { registerMediaSurfaces } from "../src/media-surfaces.ts";
import { registerCanvasSurface } from "../src/canvas.ts";

type GeneratedField = { value: unknown; source: string };
type AssertedCell = { value: null | boolean | "review" | "n/a"; verified: string | null; evidence: string | null };
type RendererBlock = { grammar: GeneratedField } & Partial<Record<string, AssertedCell>>;
type MatrixComponent = {
  kind: "native" | "module" | "structural";
  scope: "library" | "module-owned" | "structural";
  decision?: { value: string; decided: string; evidence: string };
  generated: Record<string, GeneratedField>;
  renderers: Record<"web" | "ios" | "android", RendererBlock>;
  docs?: AssertedCell;
};
type Matrix = { schema: string; components: Record<string, MatrixComponent> };
type Ledger = { elements: Record<string, { status: "supported" | "partial" | "unsupported" }> };
type Census = { elements: Record<string, { kind: string }> };

const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(readFileSync(join(here, "../../../../Conformance/library/matrix.json"), "utf8")) as Matrix;
const ledger = JSON.parse(readFileSync(join(here, "../../../support/element-support.json"), "utf8")) as Ledger;
const census = JSON.parse(readFileSync(join(here, "../../../../Documentation/reference/stack-elements.json"), "utf8")) as Census;

const ASSERTED_DIMS = ["states", "sizes", "adaptivity", "motion", "a11y", "proof"] as const;

test("the matrix carries exactly the census, one row per component with all three renderers", () => {
  assert.equal(matrix.schema, "dsx-library-matrix-v1");
  assert.deepEqual(
    new Set(Object.keys(matrix.components)),
    new Set(Object.keys(census.elements)),
    "matrix rows and the census must be the SAME component set - regenerate the matrix",
  );
  for (const [tag, row] of Object.entries(matrix.components)) {
    assert.deepEqual(Object.keys(row.renderers), ["web", "ios", "android"], `${tag}: the trinity's three renderers`);
    assert.equal(row.kind, census.elements[tag]!.kind, `${tag}: kind follows the census`);
  }
});

test("every web grammar field is the element-support ledger status VERBATIM", () => {
  for (const [tag, row] of Object.entries(matrix.components)) {
    const grammar = row.renderers.web.grammar;
    assert.ok(typeof grammar.source === "string" && grammar.source.length > 0, `${tag}: grammar cites its source`);
    if (row.kind === "structural") {
      assert.equal(grammar.value, "kernel", `${tag}: a structural declaration tag is kernel-owned on web`);
      assert.equal(ledger.elements[tag], undefined, `${tag}: structural tags have no web ledger row by construction`);
      continue;
    }
    const status = ledger.elements[tag]?.status;
    assert.ok(status !== undefined, `${tag}: renderable component has a web ledger row`);
    assert.equal(grammar.value, status, `${tag}: the matrix never re-judges the web ledger - it reads it`);
    assert.match(grammar.source, /element-support\.json/, `${tag}: web grammar names the ledger as its source`);
  }
});

test("web grammar agrees with the full-application DOM registry (factory presence)", () => {
  // Mirror bootDsx registration without booting a document - the same block the
  // element-support ledger's own gate uses; the ledger describes the complete
  // application renderer and the matrix inherits that meaning.
  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();
  Object.assign(ELEMENTS, FORM_ELEMENTS);
  registerNativeControls();
  registerStructuralControls();
  registerOverlayControls();
  registerDataControls();
  registerApplicationControls();
  registerMediaSurfaces();
  registerCanvasSurface();

  const registered = new Set([...Object.keys(ELEMENTS), ...Object.keys(GLOBAL_ELEMENTS)]);
  for (const [tag, row] of Object.entries(matrix.components)) {
    if (row.kind === "structural") continue; // declaration tags are compiler constructs, not factories
    assert.equal(
      registered.has(tag),
      row.renderers.web.grammar.value !== "unsupported",
      `${tag}: matrix web grammar ${String(row.renderers.web.grammar.value)} must agree with built-in factory presence`,
    );
  }
});

test("scope and decisions keep the scoreboard truthful at the web plane", () => {
  for (const [tag, row] of Object.entries(matrix.components)) {
    if (row.kind === "structural") {
      assert.equal(row.scope, "structural", `${tag}: structural scope`);
      assert.ok(row.decision !== undefined, `${tag}: a decided row carries its decision`);
      continue;
    }
    if (row.renderers.web.grammar.value === "unsupported") {
      // The 11 native-first module tags (component-library.md "Out of scope, named"):
      // out of the trinity's scope BY DATED DECISION, never by omission.
      assert.equal(row.scope, "module-owned", `${tag}: web-unsupported means module-owned by decision`);
      assert.ok(row.decision !== undefined && /\d{4}-\d{2}-\d{2}/.test(row.decision.decided),
        `${tag}: the decision is dated`);
      assert.equal(row.docs, undefined, `${tag}: out-of-scope rows carry no asserted docs cell`);
    } else {
      assert.equal(row.scope, "library", `${tag}: a web-rendered component is in the library's scope`);
      for (const dim of ASSERTED_DIMS) {
        const cell = row.renderers.web[dim];
        assert.ok(cell !== undefined, `${tag}: web ${dim} cell exists`);
        if (cell!.value === null) {
          assert.equal(cell!.verified, null, `${tag}: an unaudited ${dim} cell carries no stamp`);
        } else {
          assert.ok(typeof cell!.verified === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cell!.verified),
            `${tag}: a judged ${dim} cell carries a dated stamp - no stamp = red, never silently green`);
          assert.ok(typeof cell!.evidence === "string" && cell!.evidence.trim().length >= 10,
            `${tag}: a judged ${dim} cell names its evidence`);
        }
      }
      assert.ok(row.docs !== undefined, `${tag}: library rows carry the docs cell`);
    }
  }
});
