//
//  component.ts - .dsx → component IR: split the head (the contract + the logic) from
//  the body (pure markup), fold platform attribute suffixes for the web target
//  (/web/14: exact platform > :native > bare; :native = ios+android, never web), and
//  mark reactive subtrees (the automatic-islands bit, /web/02).
//

import { parseDsx, DsxParseError, type XmlNode } from "./xml.ts";

/** an IR node: the parsed markup node + the compiler's per-node reactivity stamp.
 *  `reactive` is the reactive-DESCENDANT bit — false means this whole subtree is
 *  inert static HTML: no bindings, no handlers, nothing to hydrate. The islands
 *  pass (/web/02, W6) draws hydration boundaries directly from these stamps.
 *  `nid` is the node's IDENTITY within its component (stampNodeIds below) — the
 *  adopt-hydration alignment key shared by @despia/server (emits `data-dsx-n`) and
 *  @despia/dom (verifies it while claiming server DOM). */
export type IRNode = XmlNode & { reactive?: boolean; nid?: number };

/** Stamp every node of a component IR with its per-component identity: the preorder
 *  index over the tree STRUCTURE (children arrays as compiled, head already
 *  stripped). Deliberately derived from the tree, not from any render walk, so a
 *  `visible-if` that evaluates differently on server and client changes which nids
 *  RENDER — never which nid a node HAS — and the adopt walk detects the divergence
 *  instead of silently mis-pairing elements. Idempotent; deterministic across
 *  JSON serialization (registry.json) because the algorithm sees the same tree. */
export function stampNodeIds(root: IRNode): void {
  if (root.nid !== undefined) return;
  let next = 0;
  const walk = (node: IRNode): void => {
    node.nid = next;
    next += 1;
    for (const child of node.children as IRNode[]) walk(child);
  };
  walk(root);
}

export type ComponentHead = {
  attributes: Array<{ as: string; default?: string }>;
  /** declarative data blocks (/web/05) — attrs carried verbatim to the runtime */
  apis: Array<{ as: string; attrs: { [k: string]: string } }>;
  expects: string[];
  events: Array<{ as: string; payload: string[] }>;
  /** G4 unified input (dsx-game.md §2) — head `<input as=… keys= gamepad= touch= axis=/>`
   *  device bindings, attrs carried verbatim to the runtime resolver. The BODY `<input>`
   *  form element is untouched: head POSITION is the whole disambiguation. */
  inputs: Array<{ [k: string]: string }>;
  variables: Array<{ as: string; body: string; computed: boolean }>;
  formulas: Array<{ as: string; inputs: { [k: string]: string }; body: string }>;
  actions: Array<{ as: string; inputs: { [k: string]: string }; body: string }>;
  watches: Array<{ value: string; handler: string; throttle?: number }>;
  scripts: string[];
  /** `<functions global="true">` bodies — the GLOBAL FUNCTION LIBRARY blocks (js-core.md
   *  "Shared logic", corpus Conformance/functions): registered app-wide via
   *  JSE.registerGlobalFunctions at mount, in document order, instead of the per-surface
   *  table `scripts` feeds. The `global` attribute's PRESENCE routes here. */
  globalScripts: string[];
};

export type ComponentIR = {
  /** file basename — the component name */
  name: string;
  /** owning package scheme (scopes the component + the css owner stamp) */
  scheme: string;
  head: ComponentHead;
  /** the body tree — every node carries its own reactive-descendant stamp */
  root: IRNode;
  /** any `{{ }}` / on:* / visible-if / bind in the subtree → hydration attaches here */
  reactive: boolean;
};

/** The platform-suffix vocabulary — the law is the corpus, OpenSource/Conformance/
 *  platform/platform.json (desktop-platforms.md; /web/14). Exact targets + the two
 *  group words; precedence exact > :desktop > :native > bare, most-specific wins,
 *  resolved once at compile, never per frame. */
export const PLATFORM_TARGETS = ["ios", "android", "web", "watch", "wear", "macos", "windows", "linux"] as const;
export const PLATFORM_GROUPS: { readonly [group: string]: readonly string[] } = {
  native: ["ios", "android", "watch", "wear", "macos", "windows", "linux"], // every non-web target
  desktop: ["macos", "windows", "linux"],
};
const PLATFORM_SUFFIXES: ReadonlySet<string> = new Set([
  ...PLATFORM_TARGETS, ...Object.keys(PLATFORM_GROUPS),
]);

/** The generic fold — the same pure resolution every runtime implements against the
 *  platform corpus (Kotlin :core PlatformAttrs.resolve, Swift resolvePlatform). Only a
 *  recognized suffix after the LAST colon is a platform tag, so `on:tap`/`arg:rate`/
 *  `data:custom` pass through untouched — and `on:tap:ios` is a platform tag on the
 *  base `on:tap`. Suffixed keys never survive resolution. */
export function resolvePlatformAttrs(attrs: { [k: string]: string }, target: string): { [k: string]: string } {
  const out: { [k: string]: string } = {};
  const bySuffix: { [suffix: string]: { [base: string]: string } } = {};
  for (const [name, value] of Object.entries(attrs)) {
    const colon = name.lastIndexOf(":");
    if (colon > 0) {
      const suffix = name.substring(colon + 1);
      if (PLATFORM_SUFFIXES.has(suffix)) {
        (bySuffix[suffix] ??= {})[name.substring(0, colon)] = value;
        continue;
      }
    }
    out[name] = value;
  }
  // Weakest → strongest, so a later assign is a precedence win: :native, :desktop, exact.
  for (const group of ["native", "desktop"]) {
    if (PLATFORM_GROUPS[group]!.includes(target) && bySuffix[group]) Object.assign(out, bySuffix[group]);
  }
  if (bySuffix[target]) Object.assign(out, bySuffix[target]);
  return out;
}

/** Fold platform-suffixed attributes for TARGET=web: `:web` wins over bare; every
 *  other exact and both group suffixes are dead on this target and drop from the
 *  bundle entirely (compile-time folding — /web/14). */
export function foldPlatformAttrs(attrs: { [k: string]: string }): { [k: string]: string } {
  return resolvePlatformAttrs(attrs, "web");
}

/** Deep-copies while folding: compileComponent OWNS the returned tree exclusively,
 *  so its later mutations (head removal, css handle stamping) can never alias the
 *  parse tree — safe under caching or parallel compilation. */
function foldTree(node: XmlNode): IRNode {
  return {
    tag: node.tag,
    attrs: foldPlatformAttrs(node.attrs),
    children: node.children.map(foldTree),
    text: node.text,
  };
}

function emptyHead(): ComponentHead {
  return { attributes: [], apis: [], expects: [], events: [], inputs: [], variables: [], formulas: [], actions: [], watches: [], scripts: [], globalScripts: [] };
}

const HEAD_INPUT_SKIP = new Set(["as", "computed", "value"]);
const STATE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function parseHead(head: XmlNode): ComponentHead {
  const out = emptyHead();
  for (const child of head.children) {
    switch (child.tag) {
      case "attribute": {
        const as = child.attrs["as"];
        if (as !== undefined && as.length > 0) {
          const entry: { as: string; default?: string } = { as };
          if (child.attrs["default"] !== undefined) entry.default = child.attrs["default"];
          out.attributes.push(entry);
        }
        break;
      }
      case "expects": {
        const v = child.attrs["variable"];
        if (v !== undefined && v.length > 0) out.expects.push(v);
        break;
      }
      case "event": {
        const as = child.attrs["as"];
        if (as !== undefined && as.length > 0) {
          out.events.push({ as, payload: (child.attrs["payload"] ?? "").split(/\s+/).filter((x) => x.length > 0) });
        }
        break;
      }
      case "input": {
        // G4 unified input: a HEAD `<input>` is a device-binding declaration (the body tag
        // of the same name stays the form element — position is the disambiguation). The
        // attrs ride verbatim; resolveInputDeclarations owns the vocabulary and every
        // Article-7 diagnostic, on all three renderers.
        const as = child.attrs["as"];
        if (as !== undefined && as.length > 0) {
          const decl: { [k: string]: string } = {};
          for (const [k, v] of Object.entries(child.attrs)) decl[k] = v;
          out.inputs.push(decl);
        }
        break;
      }
      case "variable": case "var": case "let": {
        const as = child.attrs["as"];
        if (as !== undefined && as.length > 0) {
          out.variables.push({ as, body: child.text, computed: child.attrs["computed"] === "true" });
        }
        break;
      }
      case "formula": {
        const as = child.attrs["as"];
        if (as !== undefined && as.length > 0) {
          const inputs: { [k: string]: string } = {};
          for (const [k, v] of Object.entries(child.attrs)) if (!HEAD_INPUT_SKIP.has(k)) inputs[k] = v;
          out.formulas.push({ as, inputs, body: child.text });
        }
        break;
      }
      case "action": {
        const as = child.attrs["as"];
        if (as !== undefined && as.length > 0) {
          const inputs: { [k: string]: string } = {};
          for (const [k, v] of Object.entries(child.attrs)) if (!HEAD_INPUT_SKIP.has(k)) inputs[k] = v;
          out.actions.push({ as, inputs, body: child.text });
        }
        break;
      }
      case "watch": {
        const value = child.attrs["value"];
        if (value !== undefined) {
          const entry: { value: string; handler: string; throttle?: number } = {
            value,
            handler: child.attrs["on:change"] ?? "",
          };
          const throttle = child.attrs["on:change.throttle"];
          if (throttle !== undefined) entry.throttle = parseInt(throttle, 10) || 0;
          out.watches.push(entry);
        }
        break;
      }
      case "api": {
        const as = child.attrs["as"];
        if (as === undefined || !STATE_IDENTIFIER.test(as)) {
          // Structured error path (WD-fuzz): this head validation used to throw a bare
          // Error — the ONE non-DsxParseError leak the seeded parser fuzz gate surfaced
          // across the whole source→IR path. It now raises DsxParseError so a caller that
          // catches the declared parser error type sees every malformed .dsx uniformly.
          throw new DsxParseError("<api as> must be an ASCII identifier of at most 128 characters");
        }
        if (child.attrs["url"] !== undefined) {
          const attrs: { [k: string]: string } = {};
          for (const [k, v] of Object.entries(child.attrs)) attrs[k] = v;
          out.apis.push({ as, attrs });
        }
        break;
      }
      case "script": case "functions":
        // the `global` attribute (presence; canonical spelling global="true") routes the
        // block to the APP-WIDE function library instead of the surface table — the
        // `<functions global="true">` head block (js-core.md "Shared logic").
        if (child.attrs["global"] !== undefined) out.globalScripts.push(child.text);
        else out.scripts.push(child.text);
        break;
      default:
        break; // <style>/<component> head tags: valid-but-rare; sheets ride the sidecar path
    }
  }
  return out;
}

const REACTIVE_ATTRS = new Set(["visible-if", "bind"]);

function nodeSelfReactive(node: XmlNode): boolean {
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name.startsWith("on:")) return true;
    if (REACTIVE_ATTRS.has(name)) return true;
    if (value.includes("{{")) return true;
  }
  if (node.text.includes("{{")) return true;
  // a component reference may carry reactivity inside its own definition — treat
  // Capitalized/dotted tags as reactive so hydration reaches them (safe over-mark;
  // a registry-wide pass can later downgrade references to compiled-static components)
  if (/^[A-Z]/.test(node.tag) || node.tag.includes(".")) return true;
  if (node.tag === "head") return true;
  return false;
}

/** Stamp every IR node with its reactive-descendant bit (bottom-up) and return the
 *  root's. A `false` subtree is an inert island: static HTML, zero JS attaches. */
export function subtreeReactive(node: IRNode): boolean {
  let reactive = nodeSelfReactive(node);
  for (const child of node.children as IRNode[]) {
    // stamp EVERY child — no short-circuit, the per-node bits are the deliverable
    if (subtreeReactive(child)) reactive = true;
  }
  node.reactive = reactive;
  return reactive;
}

/** Compile one .dsx source into its component IR (web target). */
export function compileComponent(name: string, scheme: string, source: string): ComponentIR {
  const parsed = parseDsx(source);
  const root = foldTree(parsed);
  let head = emptyHead();
  const headIdx = root.children.findIndex((c) => c.tag === "head");
  if (headIdx >= 0) {
    head = parseHead(root.children[headIdx]!);
    root.children.splice(headIdx, 1);
  }
  return { name, scheme, head, root, reactive: subtreeReactive(root) || headIdx >= 0 };
}
