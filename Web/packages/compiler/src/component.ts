//
//  component.ts - .dsx → component IR: split the head (the contract + the logic) from
//  the body (pure markup), fold platform attribute suffixes for the web target
//  (/web/14: exact platform > :native > bare; :native = ios+android, never web), and
//  mark reactive subtrees (the automatic-islands bit, /web/02).
//

import { parseDsx, DsxParseError, type XmlNode } from "./xml.ts";
import { projectTools } from "@despia/kernel/mcp";

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
  /** `sample=` on attribute/variable/event/api is the UNIT-TEST SAMPLE VALUE (master plan
   *  P3, decisions 10/11): JSON text carried VERBATIM for the editor plane - isolated
   *  renders, thumbnails, event inspection. It has NO production semantics: the runtime
   *  never evaluates it, and a failed `<api>` never silently reads its sample. Seeding is
   *  editor-injected through the state door or at SSR time, never a kernel branch. On an
   *  `<api>` the attr is HOISTED out of the verbatim attrs so the data layer cannot see it. */
  attributes: Array<{ as: string; default?: string; sample?: string }>;
  /** the STYLE contract beside the attribute DATA contract — `<override as= type= default=
   *  options= min= max=/>` (style-overrides law; corpus OpenSource/Conformance/overrides).
   *  Everything rides verbatim: `default` is a LITERAL style value (never a JSE
   *  expression), typing/coercion is the runtime core's business. */
  overrides: Array<{ as: string; type?: string; default?: string; options?: string; min?: string; max?: string }>;
  /** declarative data blocks (/web/05) — attrs carried verbatim to the runtime */
  apis: Array<{ as: string; attrs: { [k: string]: string }; sample?: string }>;
  expects: string[];
  events: Array<{ as: string; payload: string[]; sample?: string }>;
  /** G4 unified input (dsx-game.md §2) — head `<input as=… keys= gamepad= touch= axis=/>`
   *  device bindings, attrs carried verbatim to the runtime resolver. The BODY `<input>`
   *  form element is untouched: head POSITION is the whole disambiguation. */
  inputs: Array<{ [k: string]: string }>;
  /** `<tool action=… description=… mutates=…/>` — the AGENT interface (proposals/webmcp.md
   *  §3). A row names one action this document declares and carries no schema of its own:
   *  the descriptor an agent reads is DERIVED from that action's inputs (the `facets.mcp`
   *  rule, applied to a document). Validated at the END of the head pass, because a row is
   *  interface and reads BEFORE the action it names.
   *
   *  Spelled STRUCTURALLY rather than imported from `@despia/kernel/mcp`: a type import
   *  here would pull the MCP subpath into the declaration closure of every entrypoint that
   *  names ComponentHead, widening the frozen public API surface for a four-field record.
   *  The projection fold is still the kernel's - only the shape is restated. */
  tools: Array<{ as?: string; action: string; description: string; mutates?: string }>;
  variables: Array<{ as: string; body: string; computed: boolean; sample?: string }>;
  formulas: Array<{ as: string; inputs: { [k: string]: string }; body: string }>;
  actions: Array<{ as: string; inputs: { [k: string]: string }; body: string }>;
  watches: Array<{ value: string; handler: string; throttle?: number; immediate?: boolean }>;
  scripts: string[];
  /** `<functions global="true">` bodies — the GLOBAL FUNCTION LIBRARY blocks (js-core.md
   *  "Shared logic", corpus Conformance/functions): registered app-wide via
   *  JSE.registerGlobalFunctions at mount, in document order, instead of the per-surface
   *  table `scripts` feeds. The `global` attribute's PRESENCE routes here. */
  globalScripts: string[];
  /** `<style as="card" padding="12" radius="14"/>` — a REUSABLE LOOK under a name, applied
   *  by `class="card"` (dsx-anatomy.md "style: repeated looks get a class"). The attrs are
   *  the ordinary DSX style vocabulary, carried verbatim; css.ts folds them through the
   *  SAME cssmap an element attribute uses and emits them as an owner-scoped class rule in
   *  the `dsx-sheets` layer - so a named style sits exactly where a sidecar sheet's class
   *  sits, and the element's OWN attributes (dsx-attrs, a later layer) still win. */
  styles: Array<{ as: string; attrs: { [k: string]: string } }>;
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

/** Fold platform-suffixed attributes for a compile TARGET, default `web`: the target's own
 *  suffix wins over bare; every other exact and both group suffixes are dead on that target
 *  and drop from the bundle entirely (compile-time folding — /web/14).
 *
 *  THE TARGET IS A PARAMETER because the web renderer has a second job besides running web
 *  apps: it DEPICTS the native build for store screenshots (platform/10-screenshot-execution.md
 *  W3). A shot compiled for `web` would fold away every `:ios` branch the depicted build
 *  actually takes, so the image would be of an app that does not exist. Defaulted, so every
 *  existing caller is byte-identical. */
export function foldPlatformAttrs(
  attrs: { [k: string]: string },
  target: string = "web",
): { [k: string]: string } {
  return resolvePlatformAttrs(attrs, target);
}

/** Deep-copies while folding: compileComponent OWNS the returned tree exclusively,
 *  so its later mutations (head removal, css handle stamping) can never alias the
 *  parse tree — safe under caching or parallel compilation. */
function foldTree(node: XmlNode, target: string): IRNode {
  return {
    tag: node.tag,
    attrs: foldPlatformAttrs(node.attrs, target),
    children: node.children.map((child) => foldTree(child, target)),
    text: node.text,
  };
}

function emptyHead(): ComponentHead {
  return { attributes: [], overrides: [], apis: [], expects: [], events: [], inputs: [], tools: [], variables: [], formulas: [], actions: [], watches: [], scripts: [], globalScripts: [], styles: [] };
}

/** The attributes a head declaration does NOT bind as an input. Exported because the edit
 *  server projects the same actions for the Studio: a second copy of this set is a second
 *  opinion about what an author declared, and the agent-tools surface would show one shape
 *  while the runtime registered another. */
export const HEAD_INPUT_SKIP: ReadonlySet<string> = new Set(["as", "computed", "value"]);
const STATE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function parseHead(head: XmlNode): ComponentHead {
  const out = emptyHead();
  for (const child of head.children) {
    switch (child.tag) {
      case "attribute": {
        const as = child.attrs["as"];
        if (as !== undefined && as.length > 0) {
          const entry: { as: string; default?: string; sample?: string } = { as };
          if (child.attrs["default"] !== undefined) entry.default = child.attrs["default"];
          if (child.attrs["sample"] !== undefined) entry.sample = child.attrs["sample"];
          out.attributes.push(entry);
        }
        break;
      }
      case "override": {
        const as = child.attrs["as"];
        if (as !== undefined && as.length > 0) {
          const entry: { as: string; type?: string; default?: string; options?: string; min?: string; max?: string } = { as };
          for (const key of ["type", "default", "options", "min", "max"] as const) {
            if (child.attrs[key] !== undefined) entry[key] = child.attrs[key];
          }
          out.overrides.push(entry);
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
          const entry: { as: string; payload: string[]; sample?: string } = {
            as, payload: (child.attrs["payload"] ?? "").split(/\s+/).filter((x) => x.length > 0),
          };
          if (child.attrs["sample"] !== undefined) entry.sample = child.attrs["sample"];
          out.events.push(entry);
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
          const entry: { as: string; body: string; computed: boolean; sample?: string } = {
            as, body: child.text, computed: child.attrs["computed"] === "true",
          };
          if (child.attrs["sample"] !== undefined) entry.sample = child.attrs["sample"];
          out.variables.push(entry);
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
          const entry: { value: string; handler: string; throttle?: number; immediate?: boolean } = {
            value,
            handler: child.attrs["on:change"] ?? "",
          };
          // `immediate` is part of the element's contract, so it has to survive compilation:
          // a watch that seeds a local from a prop is useless if it only fires on the SECOND
          // value. The native renderers read the node directly and always honoured it.
          if (child.attrs["immediate"] === "true") entry.immediate = true;
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
          // sample= is hoisted OUT of the verbatim attrs: the data layer must be unable
          // to read it, so "a failed api silently serves its sample" cannot be written.
          const attrs: { [k: string]: string } = {};
          for (const [k, v] of Object.entries(child.attrs)) if (k !== "sample") attrs[k] = v;
          const entry: { as: string; attrs: { [k: string]: string }; sample?: string } = { as, attrs };
          if (child.attrs["sample"] !== undefined) entry.sample = child.attrs["sample"];
          out.apis.push(entry);
        }
        break;
      }
      case "tool": {
        // The AGENT interface row (proposals/webmcp.md §3). `action` is required and
        // `description` is required by the spec; `as` defaults to the action name. The
        // row carries NO schema, by design — see projectTools.
        const action = child.attrs["action"];
        if (action === undefined || action.length === 0) {
          throw new DsxParseError('<tool> missing action= — an agent tool names the declared action it exposes');
        }
        const row: ComponentHead["tools"][number] = { action, description: child.attrs["description"] ?? "" };
        if (child.attrs["as"] !== undefined) row.as = child.attrs["as"];
        if (child.attrs["mutates"] !== undefined) row.mutates = child.attrs["mutates"];
        out.tools.push(row);
        break;
      }
      case "script": case "functions":
        // the `global` attribute (presence; canonical spelling global="true") routes the
        // block to the APP-WIDE function library instead of the surface table — the
        // `<functions global="true">` head block (js-core.md "Shared logic").
        if (child.attrs["global"] !== undefined) out.globalScripts.push(child.text);
        else out.scripts.push(child.text);
        break;
      case "style": {
        // A named look. Silently dropping this was the defect that made idiomatic DSX
        // render unstyled: the class landed on the element and no rule ever backed it.
        const as = child.attrs["as"];
        if (as === undefined || as.length === 0) break;
        const attrs: { [k: string]: string } = {};
        for (const [k, v] of Object.entries(child.attrs)) if (k !== "as") attrs[k] = v;
        out.styles.push({ as, attrs });
        break;
      }
      default:
        break; // <component>/<slot> head tags: resolved by the registry, not the head IR
    }
  }
  // The stale-target gate, at the END of the pass: a `<tool>` row is INTERFACE and reads
  // before the `<action>` it names, so the whole head must be known before the target can
  // be checked. Failing here is the point — a typo becomes a build message carrying the
  // name, rather than a tool that registers and answers "unknown" to every agent.
  if (out.tools.length > 0) {
    const declared = new Map<string, readonly string[]>();
    for (const a of out.actions) declared.set(a.as, Object.keys(a.inputs));
    const { errors } = projectTools(out.tools, declared);
    if (errors.length > 0) throw new DsxParseError(errors[0]!.message);
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
export function compileComponent(
  name: string,
  scheme: string,
  source: string,
  opts: { target?: string } = {},
): ComponentIR {
  const parsed = parseDsx(source);
  const root = foldTree(parsed, opts.target ?? "web");
  let head = emptyHead();
  const headIdx = root.children.findIndex((c) => c.tag === "head");
  if (headIdx >= 0) {
    head = parseHead(root.children[headIdx]!);
    root.children.splice(headIdx, 1);
  }
  return { name, scheme, head, root, reactive: subtreeReactive(root) || headIdx >= 0 };
}
