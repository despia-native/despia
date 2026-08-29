/**
 * @despia-native/canvas-editor: a headless, zero-dependency canvas SDK for DSX trees (the StackCanvas class).
 *
 * Hand-written declarations for the UMD in `src/canvas-editor.js` (the SDK is
 * deliberately plain JS with no build step; these types are the contract the
 * host programs against). Semantics notes live in the source header and the
 * README. The SDK is headless: it emits, the host decides.
 */

/** A node in a DSX tree. `tag` is the element name; children are ordered. */
export interface StackNode {
  id?: string;
  tag: string;
  attrs?: Record<string, unknown>;
  children?: StackNode[];
}

/** A `<variable>` or `<action>` from a deck's logic layer. */
export interface LogicVariable { name: string; body: string; computed?: boolean; }
export interface LogicAction { name: string; body: string; }
/** Raw `<functions>` blocks are preserved for round-tripping; this editor API
 * does not assign them a separate global execution model. */
export interface DeckLogic { variables: LogicVariable[]; actions: LogicAction[]; functions?: string[]; }

export interface StackCanvasOptions {
  /** initial tree (or use loadDSX / load later) */
  tree?: StackNode;
  /** draw the pan/zoom controls (default true) */
  controls?: boolean;
  /** draw the phone frame (default true) */
  frame?: boolean;
  /** XML components render live previews; native ones render embed blocks */
  components?: Array<{ name: string; template: StackNode }> | Record<string, StackNode>;
  /** sample data; {{ paths }} and bind="path" resolve against it */
  data?: Record<string, unknown>;
  /** design-time root scope: dsx.attribute / dsx.this / dsx.item mocks */
  scope?: { attribute?: Record<string, unknown>; item?: unknown; this?: unknown };
}

export interface Bindable {
  /** a DEVICE-resolvable path (dsx.item.* / dsx.attribute.* / dsx.this / dsx.variable.* / dsx.global.*) */
  path: string;
  sample: unknown;
  kind: "item" | "attribute" | "self" | "state" | "global";
}

export interface TestRunSummary {
  passed: number;
  failed: number;
  total: number;
  results: Array<{ action: string; name: string; ok: boolean; error?: string }>;
}

declare class StackCanvas {
  constructor(mount: HTMLElement, opts?: StackCanvasOptions);

  /* events: 'select', 'deselect', 'hover', 'drill', 'edit', 'change', 'view',
     'editblocked', 'appevent', 'native', 'testresult', … or '*' for all */
  on(name: string, fn: (...args: unknown[]) => void): this;
  off(name: string, fn: (...args: unknown[]) => void): this;

  /* content */
  load(tree: StackNode): void;
  loadDSX(xml: string): { tree: StackNode; logic: DeckLogic };
  setTree(tree: StackNode): void;
  getTree(): StackNode;
  getNode(id: string): StackNode | null;
  setData(data: Record<string, unknown>): void;
  registerComponent(name: string, template: StackNode): void;
  setLogic(logic: DeckLogic): void;

  /* structure */
  add(node: StackNode, targetId?: string): void;
  insertNode(parentId: string, index: number, node: StackNode): void;
  move(ids: string | string[], parentId: string, index: number): void;
  updateNode(id: string, patch: Record<string, unknown | null>): void;
  wrap(wrapper: StackNode, ids?: string[]): void;
  unwrap(id?: string): void;
  setTag(id: string, tag: string): void;

  /* selection + editing */
  select(id: string | null): void;
  hover(id: string | null): void;
  startEdit(id: string, opts?: { force?: boolean }): void;
  getBindables(id?: string): Bindable[];
  describe(id: string): Record<string, unknown>;

  /* view */
  fit(): void;
  view100(): void;
  setPreview(on: boolean): void;
  getState(): Record<string, unknown>;
  destroy(): void;

  /* declared-test fixtures (a module's dsx.json `actions` block) */
  loadTests(manifest: Record<string, unknown>): void;
  runTests(): TestRunSummary;

  /* statics */
  static parseDSX(xml: string): { tree: StackNode; logic: DeckLogic };
  static readonly DSX_PARSE_LIMITS: {
    readonly maxDocumentBytes: number;
    readonly maxNodes: number;
    readonly maxDepth: number;
  };
  static readonly DsxParseError: new (message: string, line: number) => Error & { readonly line: number };
  static icon(name: string, size?: number): string;
  static icons: Record<string, string>;

  /** Headless JSE: the same interpreter the simulator runs, DOM-free.
      `evaluate` runs one expression over a plain scope object (corpus shape);
      `run` executes a statement list (variable bodies, handlers). */
  static jse: {
    scopeCtx(scope?: Record<string, unknown>): object;
    evaluate(expression: string, scope?: Record<string, unknown>): unknown;
    run(statements: string, scope?: Record<string, unknown>): unknown;
  };
}

export default StackCanvas;
export { StackCanvas };

/** `<despia-stack-editor>` — the StackCanvas SDK as a real custom element
 *  (src/stack-editor-element.js; load it after canvas-editor.js). Every SDK event
 *  re-dispatches as a composed CustomEvent of the same name; the full imperative
 *  API rides `canvas`. Light DOM by design (the SDK owns a document-level
 *  stylesheet, a body-level drag ghost, and window listeners). */
export interface DespiaStackEditorElement extends HTMLElement {
  /** the live SDK instance (null before connect / after disconnect) */
  readonly canvas: StackCanvas | null;
  /** the current tree (getTree/setTree passthrough; survives DOM moves) */
  tree: StackNode | null;
  loadDSX(xml: string): void;
  setData(data: Record<string, unknown>): void;
  setPreview(on: boolean): void;
  select(id: string | null, opts?: { additive?: boolean; force?: boolean }): void;
  fit(): void;
  undo(): void;
  redo(): void;
}

/** The constructor is available after `src/stack-editor-element.js` registers
 * the custom element; headless/Node consumers receive `null`. */
export declare const DespiaStackEditor: (new () => DespiaStackEditorElement) | null;

declare global {
  interface HTMLElementTagNameMap {
    "despia-stack-editor": DespiaStackEditorElement;
  }
}
