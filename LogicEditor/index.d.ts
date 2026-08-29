/* ═════════════════════════════════════════════════════════════════════════════
   @despia/logic-editor — type definitions for the host contract.

   StackLogic is the visual FORMULA editor: a node-based dataflow graph
   (left → right, one output) that COMPILES to JSE text — the expression
   language all three Despia runtimes execute. The graph JSON is the editing
   representation; JSE text remains the canonical artifact that lands in a
   .dsx document. Nothing about the runtime changes: the editor emits what
   already runs.

   The action plane (top → bottom step flows — the workflow analogue) is
   phase 2: `kind: "action"` is RESERVED in the format and rejected by this
   version. Formulas calculate; actions do. Every action argument slot will
   be a formula port, so this editor embeds inside the action editor.
   ═══════════════════════════════════════════════════════════════════════════ */

/** A port: where an argument slot gets its value.
 *  - { node }  wires the slot to another node's output
 *  - { value } is an inline JSON literal (string | number | boolean | null | array | object)
 *  - { code }  is an inline JSE expression — the custom-code escape hatch */
export type Port =
  | { node: string }
  | { value: unknown }
  | { code: string };

export type OpName =
  | "+" | "-" | "*" | "/" | "%"
  | "==" | "!=" | "<" | ">" | "<=" | ">="
  | "&&" | "||"
  | "!" | "neg";

export type FormulaNode =
  /** read a formula input or a dsx.* path (`value`, `dsx.variable.count`, `user.name`) */
  | { kind: "path"; path: string }
  /** a literal value node (same payload rules as a { value } port) */
  | { kind: "value"; value: unknown }
  /** a catalog function — free (`upper(s)`), method-style (`xs.includes(x)`),
   *  or an expansion macro (`capitalize` → pure-JSE template). Args are positional;
   *  labels/types come from the catalog, never the stored graph. */
  | { kind: "fn"; fn: string; args: Port[] }
  /** an operator (unary ops take one arg: "!", "neg") */
  | { kind: "op"; op: OpName; args: Port[] }
  /** If/Switch — compiles to a right-associative ternary chain */
  | { kind: "if"; cases: Array<{ when: Port; then: Port }>; else: Port }
  /** a method call on a value: `target.method(args)` (join, slice, map, …) */
  | { kind: "method"; target: Port; method: string; args: Port[] }
  /** member read on an expression result: `target.a.b` (plain paths use "path") */
  | { kind: "get"; target: Port; path: string }
  /** object / array literals with wired entries */
  | { kind: "object"; entries: Array<{ key: string; value: Port }> }
  | { kind: "array"; items: Port[] }
  /** a function value for higher-order args: `x => …`, `(a, b) => …`.
   *  Params are readable as path nodes inside the body subtree. */
  | { kind: "arrow"; params: string[]; body: Port }
  /** the escape hatch as a first-class node: a raw JSE expression */
  | { kind: "code"; jse: string };

export interface FormulaInput {
  name: string;
  /** editor-only sample value the live preview evaluates against */
  sample?: unknown;
  /** caller-scope binding expression (what `<formula as=… name="expr">` declares) */
  source?: string;
}

/** A user-declared function — the `<script>`-function twin: freeform code with
 *  declared inputs, surfaced in the palette as a lego node, compiled to a plain
 *  call. Live preview runs the body through the corpus-pinned interpreter; a
 *  body beyond the JSE subset fails open (the tiers law: render-path formulas
 *  never escalate, so beyond-subset is a lint error on device). */
export interface UserFunction {
  name: string;
  params: Array<string | { name: string; type?: string }>;
  body: string;
  description?: string;
}

export interface FormulaGraph {
  v: 1;
  /** "formula" = named `<formula>` block with inputs · "expression" = an anonymous
   *  attribute binding (`{{ … }}`, visible-if, …) · "action" = RESERVED (phase 2) */
  kind: "formula" | "expression" | "action";
  name?: string;
  inputs?: FormulaInput[];
  /** user-declared functions carried WITH the document, the way a .dsx head
   *  carries `<script>` next to its formulas */
  functions?: UserFunction[];
  nodes: Record<string, FormulaNode>;
  /** the output port — what the formula returns. Nodes not reachable from
   *  `out` are legal (parked chains) and simply don't compile. */
  out: Port;
  /** RESERVED (next milestone — see README "Groups & notes"): named groups
   *  compile to `const <name> = <expr>` bindings in a statement-form body
   *  (grouping WITHOUT extracting project-level formulas), and node `note`s
   *  compile to real `//` comments once the JSE comment grammar lands
   *  corpus-first across the three engines. Both stay text-canonical. */
  groups?: unknown[];
}

/** One catalog entry — the vocabulary the palette, compiler, and lifter share.
 *  `label`/`params` are DISPLAY metadata (kept here ONCE, never in the stored
 *  graph — so documents stay lean). Exactly one of `call`/`method`/`expand`. */
export interface CatalogEntry {
  id: string;
  label: string;
  group: string;
  params: Array<{ name: string; type: string }>;
  returns: string;
  /** free-function form: `fn(a, b)` */
  call?: string;
  /** method form: first param is the target — `a.fn(b)` */
  method?: string;
  /** expansion macro: pure-JSE template with {0}, {1} argument slots */
  expand?: string;
  variadic?: boolean;
}

export interface NodeValueReport {
  /** per-node evaluated values for the current scope (undefined = fail-open) */
  values: Record<string, unknown>;
  /** the compiled JSE for the out port ("" when the graph is empty) */
  jse: string;
  /** the out port's evaluated value */
  result: unknown;
}

export interface StackLogicOptions {
  /** load a graph (object or JSON text) — or JSE text to lift */
  graph?: FormulaGraph | string;
  jse?: string;
  /** the sample scope live preview evaluates against (inputs' `sample` overlay it) */
  scope?: Record<string, unknown>;
  readOnly?: boolean;
  /** show the compiled-JSE readout on the Output card (default false — the
   *  visual editor stays visual; the card's ghost toggle reveals it on demand) */
  code?: boolean;
  /** inject an alternative icon set — { name: "<svg inner markup>" }. The open
   *  SDK defaults to the Hugeicons free (stroke) set; a licensed build passes
   *  the Hugeicons Pro solid set here. Keep Pro paths in the closed build. */
  icons?: Record<string, string>;
  /** "solid" renders glyphs with fill=currentColor (for a filled icon set);
   *  "stroke" (default) renders outline. */
  iconMode?: "solid" | "stroke";
  /** "auto" (default) follows the system scheme live; "light"/"dark" pin it */
  theme?: "auto" | "light" | "dark";
  /** zoom-to-fit after load (default true) */
  fit?: boolean;
}

export type StackLogicEvent =
  | "ready" | "change" | "select" | "deselect" | "preview" | "view";

export default class StackLogic {
  constructor(mount: HTMLElement, opts?: StackLogicOptions);

  /** load a graph object/JSON text, or JSE text (lifted through StackLogic.lift) */
  load(graphOrJse: FormulaGraph | string): void;
  setScope(scope: Record<string, unknown>): void;
  getGraph(): FormulaGraph;
  /** compiled JSE for the current graph's out port */
  getJSE(): string;
  /** re-evaluate every node against the current scope */
  evaluate(): NodeValueReport;
  /** show/hide the compiled-JSE readout (the Output card's ghost toggle) */
  setCode(on: boolean): void;
  /** "auto" follows the system scheme live; "light"/"dark" pin it */
  setTheme(theme: "auto" | "light" | "dark"): void;
  /** open the right-docked inspector on a step (a node id) or the final
   *  result ("@out"); null closes it. While open it follows selection and
   *  recalculates live — the full value, formatted and copyable, plus the
   *  step's compiled code on request. */
  inspect(target: string | "@out" | null): void;
  fit(): void;
  destroy(): void;

  /** Layout is EDITOR STATE, never part of the code. Persist getLayout() next
   *  to editor prefs (not in the .dsx) and restore after load(); unknown node
   *  ids are ignored so stale layouts degrade gracefully. */
  getLayout(): { positions: Record<string, { x: number; y: number }>; view: { x: number; y: number; z: number } };
  setLayout(layout: { positions?: Record<string, { x: number; y: number }>; view?: { x: number; y: number; z: number } }): void;

  on(event: StackLogicEvent | "*", fn: (payload: unknown) => void): () => void;
  off(event: StackLogicEvent | "*", fn: (payload: unknown) => void): void;

  /** compile a graph to JSE text (throws on unknown node kinds / missing refs) */
  static compile(graph: FormulaGraph): string;
  /** lift JSE text into a graph — structures what it recognizes (literals, paths,
   *  operators, ternaries, catalog calls, methods, arrows, object/array literals)
   *  and falls back to a `code` node for anything else, so lift is TOTAL:
   *  any deck's formula opens in the editor. Pass `functions` so calls to
   *  user-declared functions lift into fn nodes. */
  static lift(jse: string, functions?: UserFunction[]): FormulaGraph;
  /** headless per-node evaluation (what the conformance runner drives) */
  static evaluateGraph(graph: FormulaGraph, scope?: Record<string, unknown>): NodeValueReport;
  /** the shared function vocabulary (palette entries; extend via register) */
  static catalog: CatalogEntry[];
  static registerCatalog(entry: CatalogEntry): void;

  /** inject a filled/alternative icon set globally — { name: "<svg inner markup>" }.
   *  Pass mode "solid" to render with fill=currentColor (Hugeicons Pro Solid).
   *  Called once at boot by a licensed build; Pro paths stay in the closed build. */
  static registerIcons(map: Record<string, string>, mode?: "solid" | "stroke"): void;
  static readonly icons: Record<string, string>;

  /** the headless, device-exact JSE seam (same contract as StackCanvas.jse):
   *  the conformance corpus runs through THIS. */
  static jse: {
    evaluate(src: string, scope?: Record<string, unknown>): unknown;
    run(src: string, scope?: Record<string, unknown>): unknown;
    scopeCtx(scope?: Record<string, unknown>): unknown;
  };
}

/* ── <despia-logic-editor> — the custom-element wrapper (src/logic-editor-element.js) ──
   Attributes (all observed; rich values ride same-named JS properties):
     graph (JSON text) · jse (expression text) · scope (JSON) · src (URL of a
     .json graph) · readonly. Every SDK event re-dispatches as a composed
     CustomEvent of the same name with the payload in `detail`; the imperative
     handle rides the `logic` property. */
export interface DespiaLogicEditorElement extends HTMLElement {
  graph: FormulaGraph | string | null;
  jse: string | null;
  scope: Record<string, unknown> | string | null;
  src: string | null;
  readonly: boolean;
  code: boolean;
  theme: "auto" | "light" | "dark" | null;
  readonly logic: StackLogic | null;
}
