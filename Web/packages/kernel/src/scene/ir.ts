//
//  scene/ir.ts - the DSX Scene IR (dsx-scene.md P1): a parsed <scene> subtree as typed
//  nodes, platform-neutral and store-agnostic. The markup arrives ALREADY parsed by the
//  host renderer's own XML parser (the compiler's XmlNode shape, structurally typed here
//  so this package needs no compiler import — never a second XML parser). Attribute
//  values keep their JSE holes verbatim; a resolver callback interpolates at use time
//  (the element wires the live store, the corpus wires a plain map). Defaults and the
//  Article-7 fallback law are pinned by OpenSource/Conformance/scene/parse.json.
//

import {
  mat4Identity, mat4LookAt, mat4Multiply, mat4Orthographic, mat4Perspective, mat4Trs,
  type Mat4, type Vec3,
} from "./math.ts";

/** the structural shape of a parsed markup node (matches @despia-native/compiler XmlNode) */
export type SceneMarkupNode = {
  readonly tag: string;
  readonly attrs: { readonly [name: string]: string };
  readonly children: readonly SceneMarkupNode[];
};

export type SceneNodeKind =
  "camera" | "light" | "group" | "box" | "sphere" | "plane" | "model" | "text3d" | "anchor"
  | "animate" | "sprite";

const SCENE_NODE_KINDS: ReadonlySet<string> = new Set([
  "camera", "light", "group", "box", "sphere", "plane", "model", "text3d", "anchor",
  "animate", "sprite",
]);

export type SceneMode = "3d" | "2d" | "ar";

export type SceneNode = {
  readonly kind: SceneNodeKind;
  readonly id: string | null;
  /** authored attribute strings, holes verbatim */
  readonly attrs: { readonly [name: string]: string };
  readonly children: readonly SceneNode[];
  /** the originating markup node (parseScene sets it) — the renderer's way back to its
   *  own binding/handler machinery; hand-built IR (tests, corpora) may omit it */
  readonly source?: SceneMarkupNode;
  /** G1 (prefab.json): set on a prefab-instance EXPANSION ROOT (an implicit group).
   *  `scope` holds the instance's parameter strings RAW — holes resolve at the INSTANCE
   *  SITE (the enclosing scope); body holes under this node resolve scope-first. */
  readonly prefab?: ScenePrefabRef;
  /** G6 (sprite.json): the enclosing scene's mode is "2d". Stamped by parseScene so the
   *  node-level folds can honour the 2D conventions (a 2-number `position` means z = 0)
   *  without every signature growing a mode parameter. */
  readonly mode2d?: boolean;
};

export type SceneIR = {
  readonly mode: SceneMode;
  /** the <scene> element's own authored attrs (background, …), holes verbatim */
  readonly attrs: { readonly [name: string]: string };
  readonly nodes: readonly SceneNode[];
};

export type SceneDiagnostic = {
  readonly code:
    | "unknown-tag" | "unknown-mode" | "malformed-vector" | "malformed-number" | "unknown-light-kind"
    | "malformed-animation" | "bind-overflow" | "light-cap" | "malformed-fog" | "unknown-collide"
    | "unknown-physics" | "physics-nested" | "unknown-clip"
    | "prefab-not-scene" | "prefab-depth" | "prefab-ignored"
    | "malformed-sprite";
  readonly message: string;
};
export type SceneDiag = (d: SceneDiagnostic) => void;

/** resolve one authored attribute string for one node (null node = the <scene> root).
 *  The element's resolver evaluates holes through the live store; the corpus resolver
 *  substitutes from a plain variable map. A resolver returns the RESOLVED string. */
export type SceneResolve = (node: SceneNode | null, name: string, raw: string) => string;

/** the store-agnostic hole interpolator: replaces every {{ expr }} with
 *  String(evalHole(trimmed expr)) — what a map-backed corpus resolver uses */
export function interpolateSceneHoles(raw: string, evalHole: (expr: string) => unknown): string {
  return raw.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => {
    const value = evalHole(expr.trim());
    return value === null || value === undefined ? "" : String(value);
  });
}

/** parse a <scene> markup subtree into the typed IR. Unknown tags are SKIPPED with a
 *  diagnostic — never a phantom node, never a crash (Article 7). A `prefabs` lookup
 *  (G1, dsx-game.md §2) lets locally-declared COMPONENT tags instantiate as prefabs —
 *  the kernel never learns a component name (rule 18: the lookup is the seam). */
export function parseScene(markup: SceneMarkupNode, diag?: SceneDiag, prefabs?: ScenePrefabLookup): SceneIR {
  const modeRaw = markup.attrs["mode"] ?? "3d";
  let mode: SceneMode = "3d";
  if (modeRaw === "3d" || modeRaw === "2d" || modeRaw === "ar") mode = modeRaw;
  else diag?.({ code: "unknown-mode", message: `<scene mode="${modeRaw}"> is not 3d, 2d or ar — using 3d` });
  return {
    mode, attrs: markup.attrs,
    nodes: parseNodes(markup.children, diag, prefabs, 0, mode === "2d"),
  };
}

function parseNodes(
  children: readonly SceneMarkupNode[], diag?: SceneDiag, prefabs?: ScenePrefabLookup,
  depth = 0, mode2d = false,
): SceneNode[] {
  const nodes: SceneNode[] = [];
  for (const child of children) {
    if (!SCENE_NODE_KINDS.has(child.tag)) {
      const def = prefabs?.(child.tag) ?? null;
      if (def !== null) {
        const expanded = expandScenePrefab(child, def, diag, prefabs, depth, mode2d);
        if (expanded !== null) nodes.push(expanded);
        continue;
      }
      diag?.({ code: "unknown-tag", message: `<${child.tag}> is not a scene node — skipped` });
      continue;
    }
    nodes.push({
      kind: child.tag as SceneNodeKind,
      id: child.attrs["id"] ?? null,
      attrs: child.attrs,
      children: parseNodes(child.children, diag, prefabs, depth, mode2d),
      source: child,
      ...(mode2d ? { mode2d: true } : {}),
    });
  }
  return nodes;
}

// ── prefabs (G1, dsx-game.md §2): components instantiate inside <scene> subtrees ─────
//
// A PREFAB IS A COMPONENT whose body is scene content — no second concept. The kernel
// owns only the STRUCTURAL law (corpus prefab.json); each renderer derives the
// definition from ITS OWN component registry and hands parseScene a lookup, so no
// component name ever appears in kernel code (constitution rule 18).

/** the runaway self-reference guard — prefab expansion nests at most this deep */
export const SCENE_PREFAB_DEPTH_LIMIT = 8;

/** instance words that are the node TRANSFORM, never scope parameters */
export const SCENE_PREFAB_TRANSFORM_WORDS: readonly string[] = ["position", "rotation", "scale"];

/** head/declaration tags that never join a prefab body (the dsx-anatomy head words) */
const SCENE_PREFAB_DECLARATION_TAGS: ReadonlySet<string> = new Set([
  "head", "attribute", "variable", "var", "let", "action", "formula", "script", "functions",
  "event", "expects", "watch", "api", "style", "component", "slot",
]);

/** instance attrs that never enter the scope (identity/presentation/reserved words) */
const SCENE_PREFAB_RESERVED_WORDS: ReadonlySet<string> = new Set(["id", "__css", "css-owner", "slot", "bind", "key"]);

export type ScenePrefabParam = { readonly name: string; readonly default?: string };

export type ScenePrefabDef = {
  /** declared `<attribute>` words (name + optional default raw string) */
  readonly params: readonly ScenePrefabParam[];
  /** the component body's top-level markup nodes */
  readonly roots: readonly SceneMarkupNode[];
  /** THE DEFINING-SCOPE LAW: nested tags inside this body resolve where the component
   *  was DECLARED (its own package/scope), exactly as component expansion outside
   *  scenes does — a renderer with scoped registries binds this to the owning scope's
   *  resolution. Absent = the instance site's lookup (flat registries). */
  readonly lookup?: ScenePrefabLookup;
};

/** tag → definition (null = not a component). Each renderer wires its own registry. */
export type ScenePrefabLookup = (tag: string) => ScenePrefabDef | null;

/** the stamp a prefab EXPANSION ROOT carries (SceneNode.prefab) */
export type ScenePrefabRef = {
  /** the instance tag (diagnostics/tooling — never dispatch) */
  readonly tag: string;
  /** parameter name → RAW instance string (holes resolve at the INSTANCE SITE) */
  readonly scope: { readonly [name: string]: string };
};

/** derive a prefab definition from a component TEMPLATE — the shape each lane's
 *  registry holds: a bare scene root, or a wrapper whose non-declaration children are
 *  the body roots (the Kotlin/Swift inline-component wrap, a .dsx file root). Declared
 *  `<attribute as default>` params are scanned from the head/declarations EITHER way —
 *  a bare scene root may carry its `<head>` as a child (registries that keep templates
 *  verbatim), so declarations are scanned AND stripped there too; a caller with a
 *  separately parsed head (the web ComponentIR) overrides `params`. */
export function scenePrefabDefFromTemplate(template: SceneMarkupNode): ScenePrefabDef {
  const params: ScenePrefabParam[] = [];
  const scanParams = (children: readonly SceneMarkupNode[]): void => {
    for (const child of children) {
      if (child.tag === "head") { scanParams(child.children); continue; }
      if (child.tag !== "attribute") continue;
      const as = child.attrs["as"];
      if (as === undefined || as.length === 0) continue;
      const def = child.attrs["default"];
      params.push(def === undefined ? { name: as } : { name: as, default: def });
    }
  };
  if (SCENE_NODE_KINDS.has(template.tag)) {
    scanParams(template.children);
    const body = template.children.filter((c) => !SCENE_PREFAB_DECLARATION_TAGS.has(c.tag));
    const root = body.length === template.children.length
      ? template : { tag: template.tag, attrs: template.attrs, children: body };
    return { params, roots: [root] };
  }
  scanParams(template.children);
  return { params, roots: template.children.filter((c) => !SCENE_PREFAB_DECLARATION_TAGS.has(c.tag)) };
}

/** THE SCOPE LAW: every non-reserved, non-transform, non-handler instance attribute
 *  enters the scope RAW; declared params missing from the instance fall to their
 *  declared default string. Transform words are the instance's node transform, never
 *  parameters. */
export function scenePrefabScope(
  instance: SceneMarkupNode, def: ScenePrefabDef,
): { [name: string]: string } {
  const scope: { [name: string]: string } = {};
  for (const [name, value] of Object.entries(instance.attrs)) {
    if (SCENE_PREFAB_RESERVED_WORDS.has(name) || name.startsWith("on:")) continue;
    if (SCENE_PREFAB_TRANSFORM_WORDS.includes(name)) continue;
    scope[name] = value;
  }
  for (const p of def.params) {
    if (scope[p.name] === undefined && p.default !== undefined) scope[p.name] = p.default;
  }
  return scope;
}

/** THE EXPANSION-ROOT LAW: an instance ALWAYS expands to one implicit `group` carrying
 *  the instance's transform words + id (instance transforms COMPOSE with body-authored
 *  transforms — never clobber), children = the body roots. A body that is not scene
 *  content (any root neither a scene tag nor a prefab) skips the WHOLE instance with
 *  one `prefab-not-scene` diagnostic; expansion past SCENE_PREFAB_DEPTH_LIMIT skips
 *  with one `prefab-depth` diagnostic (Article 7 — never a crash, never a phantom). */
function expandScenePrefab(
  instance: SceneMarkupNode, def: ScenePrefabDef,
  diag: SceneDiag | undefined, prefabs: ScenePrefabLookup | undefined, depth: number,
  mode2d = false,
): SceneNode | null {
  if (depth >= SCENE_PREFAB_DEPTH_LIMIT) {
    diag?.({ code: "prefab-depth", message: `<${instance.tag}> nests prefabs deeper than ${SCENE_PREFAB_DEPTH_LIMIT} — skipped` });
    return null;
  }
  // the body resolves in its DEFINING scope when the renderer provides one (the
  // defining-scope law) — a packaged prefab's nested tags mean what they meant
  // where the component was declared, exactly as expansion outside scenes
  const bodyLookup = def.lookup ?? prefabs;
  if (def.roots.length === 0
    || def.roots.some((r) => !SCENE_NODE_KINDS.has(r.tag) && (bodyLookup?.(r.tag) ?? null) === null)) {
    diag?.({ code: "prefab-not-scene", message: `<${instance.tag}> is a component but its body is not scene content — skipped` });
    return null;
  }
  // bind/key/on:* on an instance tag do nothing — say so (Article 7, never silent):
  // spawning is <group bind> around the instance; handlers live inside the body
  const ignored = Object.keys(instance.attrs)
    .filter((n) => n === "bind" || n === "key" || n.startsWith("on:"));
  if (ignored.length > 0) {
    diag?.({ code: "prefab-ignored", message: `<${instance.tag}> ${ignored.join(", ")} ignored — wrap the instance in <group bind key> to spawn; attach handlers inside the component body` });
  }
  const attrs: { [name: string]: string } = {};
  for (const name of SCENE_PREFAB_TRANSFORM_WORDS) {
    const value = instance.attrs[name];
    if (value !== undefined) attrs[name] = value;
  }
  const id = instance.attrs["id"];
  if (id !== undefined) attrs["id"] = id;
  return {
    kind: "group",
    id: id ?? null,
    attrs,
    children: parseNodes(def.roots, diag, bodyLookup, depth + 1, mode2d),
    source: instance,
    prefab: { tag: instance.tag, scope: scenePrefabScope(instance, def) },
    ...(mode2d ? { mode2d: true } : {}),
  };
}

/** the corpus/tooling resolver over an expanded tree: body holes under a prefab root
 *  resolve SCOPE-FIRST (an expr that is exactly a scope key reads the per-instance
 *  value, resolved at the instance site), everything else falls through to `evalHole`
 *  (the outer plane). Renderers implement the same law on their live item planes. */
export function scenePrefabResolver(
  nodes: readonly SceneNode[], evalHole: (expr: string) => unknown,
): SceneResolve {
  const scopes = new Map<SceneNode, { readonly [k: string]: string }>();
  const walk = (list: readonly SceneNode[], enclosing: { readonly [k: string]: string } | null): void => {
    for (const node of list) {
      // the root's OWN attrs (the instance transforms) resolve at the INSTANCE SITE
      if (enclosing !== null) scopes.set(node, enclosing);
      let inner = enclosing;
      if (node.prefab !== undefined) {
        const site = (expr: string): unknown =>
          enclosing !== null && enclosing[expr] !== undefined ? enclosing[expr] : evalHole(expr);
        const resolved: { [k: string]: string } = {};
        for (const [k, raw] of Object.entries(node.prefab.scope)) {
          resolved[k] = interpolateSceneHoles(raw, site);
        }
        inner = resolved;
      }
      walk(node.children, inner);
    }
  };
  walk(nodes, null);
  return (node, _name, raw) => interpolateSceneHoles(raw, (expr) => {
    const scope = node !== null ? scopes.get(node) : undefined;
    return scope !== undefined && scope[expr] !== undefined ? scope[expr] : evalHole(expr);
  });
}

// ── typed attribute resolution (the corpus defaults) ─────────────────────────────────

function finiteNumbers(resolved: string): number[] | null {
  const parts = resolved.trim().split(/\s+/).filter((p) => p.length > 0);
  const numbers: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    numbers.push(value);
  }
  return numbers;
}

// THE TOTAL-RESOLVE LAW (P5): an UNAUTHORED attribute still consults the resolver,
// with its formatted DEFAULT as the raw value. A pure hole-interpolating resolver
// (the corpus map resolver) returns that default string unchanged — identical numbers
// to the pre-P5 early-return — while a renderer's OVERRIDE PLANE (animations, orbit)
// can now reach properties the author never wrote (`<animate target="rotation">` on a
// node with no rotation= attribute).

/** shared by resolvedProps and the physics extraction (physics.ts) — exported for the
 *  sibling kernel modules, not part of any renderer's surface */
export function readVec(
  node: SceneNode | null, name: string, fallback: readonly number[],
  resolve: SceneResolve, diag: SceneDiag | undefined, attrs: { readonly [k: string]: string },
): number[] {
  const raw = attrs[name] ?? fallback.join(" ");
  const resolved = resolve(node, name, raw);
  const numbers = finiteNumbers(resolved);
  if (numbers === null || numbers.length !== fallback.length) {
    diag?.({
      code: "malformed-vector",
      message: `${name}="${resolved}" is not ${fallback.length} numbers — using "${fallback.join(" ")}"`,
    });
    return [...fallback];
  }
  return numbers;
}

export function readScalar(
  node: SceneNode | null, name: string, fallback: number,
  resolve: SceneResolve, diag: SceneDiag | undefined, attrs: { readonly [k: string]: string },
): number {
  const raw = attrs[name] ?? String(fallback);
  const resolved = resolve(node, name, raw);
  const value = Number(resolved.trim());
  if (resolved.trim().length === 0 || !Number.isFinite(value)) {
    diag?.({ code: "malformed-number", message: `${name}="${resolved}" is not a number — using ${fallback}` });
    return fallback;
  }
  return value;
}

export function readString(
  node: SceneNode | null, name: string, fallback: string,
  resolve: SceneResolve, attrs: { readonly [k: string]: string },
): string {
  return resolve(node, name, attrs[name] ?? fallback);
}

/** THE 2D PAIR LAW (G6, sprite.json): inside `mode="2d"` a `position` of TWO numbers
 *  means z = 0; a triple still means what it always did, and every OTHER vector word
 *  (rotation, scale, velocity) stays a triple — a named absence. Outside 2D a pair is
 *  malformed exactly as before (readVec's shared law). */
export function readPosition(
  node: SceneNode | null, fallback: readonly number[],
  resolve: SceneResolve, diag: SceneDiag | undefined, attrs: { readonly [k: string]: string },
): Vec3 {
  if (node?.mode2d === true) {
    const raw = attrs["position"] ?? fallback.join(" ");
    const pair = finiteNumbers(resolve(node, "position", raw));
    if (pair !== null && pair.length === 2) return [pair[0]!, pair[1]!, 0];
  }
  return readVec(node, "position", fallback, resolve, diag, attrs) as Vec3;
}

// ── the sprite grammar (G6, corpus sprite.json) ──────────────────────────────────────
//
// These three live HERE, beside the other attribute grammars, so `resolvedProps` needs
// no import from scene/sprite.ts — the quad/UV/fps folds import THEM (one direction,
// the text3d precedent).

/** which point of the quad `position` names → the anchor point's offset from the quad
 *  CENTER as a fraction of (width, height): ax ∈ {−½ left, 0 center, +½ right},
 *  ay ∈ {+½ top, 0 center, −½ bottom} */
export const SPRITE_ANCHORS: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["center", [0, 0]], ["top", [0, 0.5]], ["bottom", [0, -0.5]],
  ["left", [-0.5, 0]], ["right", [0.5, 0]],
  ["top-left", [-0.5, 0.5]], ["top-right", [0.5, 0.5]],
  ["bottom-left", [-0.5, -0.5]], ["bottom-right", [0.5, -0.5]],
] as Array<[string, readonly [number, number]]>);

export const SPRITE_DEFAULT_ANCHOR = "center";

/** THE SHEET GRAMMAR: ONE number N = a SINGLE ROW (cols = N, rows = 1); TWO numbers =
 *  "cols rows" EXPLICITLY. The kernel never guesses a grid — `cols = ceil(√N)` is WRONG
 *  and is not the law. Anything else (a fraction, < 1, three numbers, a word) is null
 *  and the caller falls back to 1×1 with one diagnostic (Article 7). */
export function parseSpriteFrames(raw: string): [number, number] | null {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length !== 1 && parts.length !== 2) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) return null;
    numbers.push(value);
  }
  return parts.length === 1 ? [numbers[0]!, 1] : [numbers[0]!, numbers[1]!];
}

/** the `flip` word: "" or any arrangement of the letters x and y ("yx" IS "xy" — the
 *  word is a SET), normalized to "" · "x" · "y" · "xy". null = not a flip word. */
export function normalizeSpriteFlip(raw: string): string | null {
  if (raw.length === 0) return "";
  if (raw.length > 2) return null;
  let x = false, y = false;
  for (const letter of raw) {
    if (letter === "x" && !x) x = true;
    else if (letter === "y" && !y) y = true;
    else return null;
  }
  return x ? (y ? "xy" : "x") : "y";
}

export const LIGHT_KINDS: ReadonlySet<string> = new Set(["ambient", "directional", "point"]);

export const COLLIDE_KINDS: ReadonlySet<string> = new Set(["sphere", "box"]);

/** every typed property a renderer needs, resolved per the parse-corpus defaults */
export type SceneNodeProps = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color: string;
  /** camera */
  lookAt: Vec3; fov: number; near: number; far: number; size2d: number;
  /** light */
  lightKind: "ambient" | "directional" | "point"; intensity: number;
  /** point-light falloff distance (the P5 attenuation law; default 10) */
  range: number;
  /** camera controls word ("" = none; "orbit" is the P5 word) */
  controls: string;
  /** collision opt-in ("" = not a collider; "sphere" | "box" — the P5 collide law) */
  collide: string;
  /** geometry */
  boxSize: Vec3; radius: number; planeSize: [number, number];
  /** P4 kinds */
  src: string; value: string; anchorKind: string;
  /** text3d glyph height in scene units (the quad law, text3d.json) */
  text3dSize: number;
  /** texture URL for box/sphere/plane ("" = untextured; the UV law lives in the corpus README) */
  texture: string;
  /** G3 (skin.json): the model's clip NAME ("" = bind pose) */
  animation: string;
  /** G3: clip time wrap — true = modulo duration (the default), false = clamp at end */
  clipLoop: boolean;
  /** G3: crossfade duration for an `animation` switch (default 0 = hard cut) */
  blendMs: number;
  /** G6 (sprite.json): the sprite quad's authored `size` (w h; default 1 1) */
  spriteSize: [number, number];
  /** G6: whether `size` was AUTHORED — unauthored derives width from the texture aspect */
  spriteSizeAuthored: boolean;
  /** G6: the sheet grid [cols, rows] (default 1 1 = the whole texture) */
  spriteFrames: [number, number];
  /** G6: the 0-based frame index, floored and CLAMPED into [0, cols·rows − 1] */
  spriteFrame: number;
  /** G6: frames per second for auto-advance (0 = none; a positive fps OWNS the index) */
  spriteFps: number;
  /** G6: whether an fps-driven strip wraps (true) or holds its last frame (false) */
  spriteLoop: boolean;
  /** G6: which point of the quad `position` names (the anchor words) */
  spriteAnchor: string;
  /** G6: the normalized UV mirror word — "" · "x" · "y" · "xy" */
  spriteFlip: string;
};

/** `duration`/`blend` grammar: bare-ms, `ms`, or `s` (the P5 spelling — anim.ts
 *  re-exports this for tween parsing; it lives here so the model props can share it) */
export function parseSceneDuration(raw: string): number | null {
  const m = /^([0-9]*\.?[0-9]+)(ms|s)?$/.exec(raw.trim());
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  return m[2] === "s" ? value * 1000 : value;
}

export function resolvedProps(node: SceneNode, resolve: SceneResolve, diag?: SceneDiag): SceneNodeProps {
  const a = node.attrs;
  const cameraDefault: Vec3 = [0, 0, 5];
  const kindRaw = readString(node, "kind", "", resolve, a);
  let lightKind: "ambient" | "directional" | "point" = "ambient";
  if (node.kind === "light" && kindRaw.length > 0) {
    if (LIGHT_KINDS.has(kindRaw)) lightKind = kindRaw as "ambient" | "directional" | "point";
    else diag?.({ code: "unknown-light-kind", message: `<light kind="${kindRaw}"> is not ambient, directional or point — using ambient` });
  }
  const geometryNode = node.kind === "box" || node.kind === "sphere" || node.kind === "plane";
  let collide = "";
  if (geometryNode) {
    const collideRaw = readString(node, "collide", "", resolve, a);
    if (collideRaw.length > 0) {
      if (COLLIDE_KINDS.has(collideRaw)) collide = collideRaw;
      else diag?.({ code: "unknown-collide", message: `collide="${collideRaw}" is not sphere or box — not a collider` });
    }
  }
  // `size` and every camera scalar read PER KIND — the word is shared (camera scalar,
  // box triple, plane pair), so an unconditional read would mis-diagnose valid markup.
  const camera = node.kind === "camera";
  // G3 model clip words (skin.json props cases): animation name, loop, blend
  const model = node.kind === "model";
  let clipLoop = true;
  if (model) {
    const loopRaw = readString(node, "loop", "true", resolve, a);
    if (loopRaw === "false") clipLoop = false;
    else if (loopRaw !== "true") {
      diag?.({ code: "malformed-animation", message: `loop="${loopRaw}" is not true or false — using true` });
    }
  }
  let blendMs = 0;
  if (model && a["blend"] !== undefined) {
    const blendRaw = readString(node, "blend", "0", resolve, a);
    const parsed = parseSceneDuration(blendRaw);
    if (parsed === null) {
      diag?.({ code: "malformed-animation", message: `blend="${blendRaw}" is not ms|s — using 0` });
    } else {
      blendMs = parsed;
    }
  }
  // G6 (sprite.json): the `<sprite>` words. Every read is gated on the kind — `size`,
  // `loop` and `frame` are shared words (plane pair, model clip loop), so an
  // unconditional read would mis-diagnose valid markup.
  const sprite = node.kind === "sprite";
  const spriteSize: [number, number] = sprite
    ? readVec(node, "size", [1, 1], resolve, diag, a) as [number, number] : [1, 1];
  let spriteFrames: [number, number] = [1, 1];
  if (sprite) {
    const framesRaw = readString(node, "frames", "1 1", resolve, a);
    const parsed = parseSpriteFrames(framesRaw);
    if (parsed === null) {
      diag?.({ code: "malformed-sprite", message: `frames="${framesRaw}" is not a frame count or "cols rows" of whole numbers ≥ 1 — using the whole texture` });
    } else {
      spriteFrames = parsed;
    }
  }
  let spriteFrame = 0;
  if (sprite) {
    const total = spriteFrames[0] * spriteFrames[1];
    const floored = Math.floor(readScalar(node, "frame", 0, resolve, diag, a));
    spriteFrame = Math.min(Math.max(floored, 0), total - 1);
    if (floored !== spriteFrame) {
      diag?.({ code: "malformed-sprite", message: `frame="${floored}" is outside 0..${total - 1} — clamped to ${spriteFrame}` });
    }
  }
  let spriteLoop = true;
  let spriteAnchor = "center";
  let spriteFlip = "";
  if (sprite) {
    const loopRaw = readString(node, "loop", "true", resolve, a);
    if (loopRaw === "false") spriteLoop = false;
    else if (loopRaw !== "true") {
      diag?.({ code: "malformed-sprite", message: `loop="${loopRaw}" is not true or false — using true` });
    }
    const anchorRaw = readString(node, "anchor", SPRITE_DEFAULT_ANCHOR, resolve, a);
    if (SPRITE_ANCHORS.has(anchorRaw)) spriteAnchor = anchorRaw;
    else diag?.({ code: "malformed-sprite", message: `anchor="${anchorRaw}" is not a sprite anchor word — using ${SPRITE_DEFAULT_ANCHOR}` });
    const flipRaw = readString(node, "flip", "", resolve, a).trim();
    const flip = normalizeSpriteFlip(flipRaw);
    if (flip === null) {
      diag?.({ code: "malformed-sprite", message: `flip="${flipRaw}" is not "", "x", "y" or "xy" — not mirrored` });
    } else {
      spriteFlip = flip;
    }
  }
  return {
    position: readPosition(node, camera ? cameraDefault : [0, 0, 0], resolve, diag, a),
    rotation: readVec(node, "rotation", [0, 0, 0], resolve, diag, a) as Vec3,
    scale: readVec(node, "scale", [1, 1, 1], resolve, diag, a) as Vec3,
    color: readString(node, "color", "#ffffff", resolve, a),
    lookAt: camera ? readVec(node, "look-at", [0, 0, 0], resolve, diag, a) as Vec3 : [0, 0, 0],
    fov: camera ? readScalar(node, "fov", 60, resolve, diag, a) : 60,
    near: camera ? readScalar(node, "near", 0.1, resolve, diag, a) : 0.1,
    far: camera ? readScalar(node, "far", 1000, resolve, diag, a) : 1000,
    size2d: camera ? readScalar(node, "size", 5, resolve, diag, a) : 5,
    lightKind,
    intensity: node.kind === "light" ? readScalar(node, "intensity", 1, resolve, diag, a) : 1,
    range: node.kind === "light" && lightKind === "point"
      ? readScalar(node, "range", POINT_LIGHT_DEFAULT_RANGE, resolve, diag, a) : POINT_LIGHT_DEFAULT_RANGE,
    controls: camera ? readString(node, "controls", "", resolve, a) : "",
    collide,
    boxSize: node.kind === "box" ? readVec(node, "size", [1, 1, 1], resolve, diag, a) as Vec3 : [1, 1, 1],
    radius: node.kind === "sphere" ? readScalar(node, "radius", 1, resolve, diag, a) : 1,
    planeSize: node.kind === "plane"
      ? readVec(node, "size", [1, 1], resolve, diag, a) as [number, number] : [1, 1],
    src: readString(node, "src", "", resolve, a),
    value: readString(node, "value", "", resolve, a),
    anchorKind: node.kind === "anchor" ? readString(node, "kind", "", resolve, a) : "",
    text3dSize: node.kind === "text3d"
      ? readScalar(node, "size", TEXT3D_DEFAULT_SIZE, resolve, diag, a) : TEXT3D_DEFAULT_SIZE,
    texture: node.kind === "box" || node.kind === "sphere" || node.kind === "plane"
      ? readString(node, "texture", "", resolve, a) : "",
    animation: model ? readString(node, "animation", "", resolve, a) : "",
    clipLoop,
    blendMs,
    spriteSize,
    spriteSizeAuthored: sprite && a["size"] !== undefined,
    spriteFrames,
    spriteFrame,
    spriteFps: sprite ? readScalar(node, "fps", 0, resolve, diag, a) : 0,
    spriteLoop,
    spriteAnchor,
    spriteFlip,
  };
}

// ── the text3d quad law (dsx-scene.md P4, corpus text3d.json) ────────────────────────

/** the glyph height default (scene units) */
export const TEXT3D_DEFAULT_SIZE = 0.5;
/** the LAW's fixed per-character advance: width = size × 0.6 × codePointCount */
export const TEXT3D_ADVANCE = 0.6;

export type Text3dQuad = { center: Vec3; halfWidth: number; halfHeight: number };

/** the billboard quad's layout: center = position, height = size, width = size · 0.6 ·
 *  codePointCount; an empty value lays out NO quad (null — the node draws nothing).
 *  Characters are Unicode CODE POINTS (the surrogate-pair corpus case). The BILLBOARD
 *  law (the quad always faces the camera) is draw-time behavior, not layout. */
export function text3dQuad(props: SceneNodeProps): Text3dQuad | null {
  const characters = Array.from(props.value).length;
  if (characters === 0) return null;
  return {
    center: [...props.position] as Vec3,
    halfWidth: props.text3dSize * TEXT3D_ADVANCE * characters / 2,
    halfHeight: props.text3dSize / 2,
  };
}

// ── world transforms (the transform-corpus law) ──────────────────────────────────────

/** every node's world matrix: world = parentWorld · (T · Rz · Ry · Rx · S), root down.
 *  Cameras and lights get world matrices too (their position rides the same plane).
 *  `<animate>` nodes are CONTROLLERS, not transforms — skipped entirely. */
export function worldMatrices(
  nodes: readonly SceneNode[], resolve: SceneResolve, diag?: SceneDiag,
): Map<SceneNode, Mat4> {
  const out = new Map<SceneNode, Mat4>();
  const walk = (list: readonly SceneNode[], parent: Mat4): void => {
    for (const node of list) {
      if (node.kind === "animate") continue;
      const props = resolvedProps(node, resolve, diag);
      const world = mat4Multiply(parent, mat4Trs(props.position, props.rotation, props.scale));
      out.set(node, world);
      walk(node.children, world);
    }
  };
  walk(nodes, mat4Identity());
  return out;
}

export function findSceneNode(nodes: readonly SceneNode[], id: string): SceneNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner = findSceneNode(node.children, id);
    if (inner !== null) return inner;
  }
  return null;
}

// ── the camera fold (the projection-corpus law) ──────────────────────────────────────

export type SceneCamera = { view: Mat4; proj: Mat4; eye: Vec3 };

/** the first authored <camera> wins; an unauthored camera uses every default. mode="2d"
 *  projects orthographically (`size` = vertical half-extent); 3d and ar perspective. */
export function sceneCamera(ir: SceneIR, resolve: SceneResolve, aspect: number, diag?: SceneDiag): SceneCamera {
  const node = ir.nodes.find((n) => n.kind === "camera") ?? null;
  const props = node !== null
    ? resolvedProps(node, resolve, diag)
    : { position: [0, 0, 5] as Vec3, lookAt: [0, 0, 0] as Vec3, fov: 60, near: 0.1, far: 1000, size2d: 5 };
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const view = mat4LookAt(props.position, props.lookAt);
  const proj = ir.mode === "2d"
    ? mat4Orthographic(props.size2d, safeAspect, props.near, props.far)
    : mat4Perspective(props.fov, safeAspect, props.near, props.far);
  return { view, proj, eye: props.position };
}

// ── lights (P1: ambient + one directional; P5 adds point lights + fog) ───────────────

export const POINT_LIGHT_DEFAULT_RANGE = 10;

/** the point-light cap: the first 4 in document order; a 5th+ drops with one diagnostic */
export const SCENE_MAX_POINT_LIGHTS = 4;

export type ScenePointLight = {
  /** scene-root lights read their authored position as world (the root-light law) */
  position: Vec3;
  color: string;
  intensity: number;
  range: number;
};

export type SceneLighting = {
  ambientIntensity: number;
  ambientColor: string;
  /** unit direction the directional light shines FROM (its position toward the origin),
   *  null when the scene authors none */
  direction: Vec3 | null;
  directionalIntensity: number;
  directionalColor: string;
  /** P5: up to SCENE_MAX_POINT_LIGHTS point lights, document order */
  points: ScenePointLight[];
};

export function sceneLighting(ir: SceneIR, resolve: SceneResolve, diag?: SceneDiag): SceneLighting {
  const out: SceneLighting = {
    ambientIntensity: 0, ambientColor: "#ffffff",
    direction: null, directionalIntensity: 0, directionalColor: "#ffffff",
    points: [],
  };
  let sawAmbient = false;
  let droppedPoints = 0;
  for (const node of ir.nodes) {
    if (node.kind !== "light") continue;
    const props = resolvedProps(node, resolve, diag);
    if (props.lightKind === "point") {
      if (out.points.length >= SCENE_MAX_POINT_LIGHTS) { droppedPoints += 1; continue; }
      out.points.push({
        position: [...props.position] as Vec3,
        color: props.color, intensity: props.intensity, range: props.range,
      });
    } else if (props.lightKind === "directional") {
      if (out.direction !== null) continue; // P1: the first directional wins
      const length = Math.hypot(...props.position);
      out.direction = length === 0 ? [0, 1, 0] : [
        props.position[0] / length, props.position[1] / length, props.position[2] / length,
      ];
      out.directionalIntensity = props.intensity;
      out.directionalColor = props.color;
    } else if (!sawAmbient) {
      sawAmbient = true;
      out.ambientIntensity = props.intensity;
      out.ambientColor = props.color;
    }
  }
  if (droppedPoints > 0) {
    diag?.({ code: "light-cap", message: `${out.points.length + droppedPoints} point lights authored — the cap is ${SCENE_MAX_POINT_LIGHTS}, ${droppedPoints} dropped` });
  }
  // an unlit scene still shows its shapes: full ambient is the honest default
  if (!sawAmbient && out.direction === null && out.points.length === 0) out.ambientIntensity = 1;
  return out;
}

// ── the P5 lighting math (corpus lighting.json) ──────────────────────────────────────

/** THE POINT FALLOFF LAW (inverse-square with a smooth range window, pinned):
 *  attenuation(d, range) = window² / (1 + d²) with window = max(0, 1 − (d/range)⁴).
 *  1 at d = 0, exactly 0 at and past `range`. A non-positive range attenuates to 0. */
export function scenePointAttenuation(distance: number, range: number): number {
  if (range <= 0) return 0;
  const ratio = distance / range;
  const window = Math.max(0, 1 - ratio * ratio * ratio * ratio);
  return window * window / (1 + distance * distance);
}

/** one resolved point light on the numeric plane (color premultiplied by nothing —
 *  intensity stays explicit so the corpus pins each factor) */
export type ScenePointLightResolved = { position: Vec3; color: Vec3; intensity: number; range: number };

/** THE LIT-COLOR LAW (the flat-Lambert model all renderers share, extended by P5):
 *  lit = base · (ambient + dirColor·max(0, n·dirL) + Σᵢ colorᵢ·intensityᵢ·att(dᵢ)·max(0, n·Lᵢ))
 *  with Lᵢ = normalize(positionᵢ − point), dᵢ = |positionᵢ − point|; each channel
 *  clamps to [0, 1] at the end (the shader's min(c, 1)). n is normalized here. */
export function sceneLitColor(
  base: Vec3, normal: Vec3, point: Vec3,
  ambient: Vec3,
  directional: { dir: Vec3; color: Vec3 } | null,
  points: readonly ScenePointLightResolved[],
): Vec3 {
  const nLen = Math.hypot(...normal);
  const n: Vec3 = nLen === 0 ? [0, 0, 0] : [normal[0] / nLen, normal[1] / nLen, normal[2] / nLen];
  const light: Vec3 = [ambient[0], ambient[1], ambient[2]];
  if (directional !== null) {
    const lambert = Math.max(0, n[0] * directional.dir[0] + n[1] * directional.dir[1] + n[2] * directional.dir[2]);
    for (let c = 0; c < 3; c += 1) light[c] += directional.color[c]! * lambert;
  }
  for (const p of points) {
    const toLight: Vec3 = [p.position[0] - point[0], p.position[1] - point[1], p.position[2] - point[2]];
    const distance = Math.hypot(...toLight);
    if (distance === 0) continue; // L is undefined at the light's own position — contributes 0
    const l: Vec3 = [toLight[0] / distance, toLight[1] / distance, toLight[2] / distance];
    const lambert = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
    const factor = p.intensity * scenePointAttenuation(distance, p.range) * lambert;
    for (let c = 0; c < 3; c += 1) light[c] += p.color[c]! * factor;
  }
  return [
    Math.min(1, base[0] * light[0]),
    Math.min(1, base[1] * light[1]),
    Math.min(1, base[2] * light[2]),
  ];
}

export type SceneFog = { color: string; near: number; far: number };

/** `fog="#color near far"` on `<scene>` — linear fog. Malformed (bad color, non-finite
 *  numbers, far ≤ near) rejects the WHOLE attribute with one diagnostic — never a
 *  half-applied fog. null = no fog authored. */
export function sceneFog(ir: SceneIR, resolve: SceneResolve, diag?: SceneDiag): SceneFog | null {
  const raw = ir.attrs["fog"];
  if (raw === undefined) return null;
  const resolved = resolve(null, "fog", raw);
  const parts = resolved.trim().split(/\s+/).filter((p) => p.length > 0);
  const color = parts.length === 3 ? parseSceneColor(parts[0]!) : null;
  const near = parts.length === 3 ? Number(parts[1]) : NaN;
  const far = parts.length === 3 ? Number(parts[2]) : NaN;
  if (color === null || !Number.isFinite(near) || !Number.isFinite(far) || far <= near) {
    diag?.({ code: "malformed-fog", message: `fog="${resolved}" is not "#color near far" with far > near — no fog` });
    return null;
  }
  return { color: parts[0]!, near, far };
}

/** THE LINEAR FOG LAW: f = clamp((far − d)/(far − near), 0, 1) for d = the distance
 *  from the EYE to the fragment; final = f·lit + (1 − f)·fogColor (f = 1 unfogged at
 *  and before near, 0 fully fogged at and past far). */
export function sceneFogFactor(distance: number, near: number, far: number): number {
  return Math.min(Math.max((far - distance) / (far - near), 0), 1);
}

/** #rgb/#rrggbb → [r, g, b] in 0..1, or null (the caller diags + falls back) */
export function parseSceneColor(color: string): Vec3 | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex === null) return null;
  const body = hex[1]!;
  const wide = body.length === 6 ? body : body.split("").map((c) => c + c).join("");
  return [
    parseInt(wide.slice(0, 2), 16) / 255,
    parseInt(wide.slice(2, 4), 16) / 255,
    parseInt(wide.slice(4, 6), 16) / 255,
  ];
}

/** the picking bounding radius in LOCAL units for a geometry node (null = unpickable).
 *  The world-space radius scales by the world matrix's largest basis length. */
export function nodeBoundingRadius(node: SceneNode, props: SceneNodeProps): number | null {
  if (node.kind === "box") return Math.hypot(...props.boxSize) / 2;
  if (node.kind === "sphere") return props.radius;
  if (node.kind === "plane") return Math.hypot(props.planeSize[0], props.planeSize[1]) / 2;
  // G6: a sprite picks by its quad's bounding circle (the texture-aspect refinement is
  // a render-time detail — the resolved `size` is what picking and physics both read)
  if (node.kind === "sprite") return Math.hypot(props.spriteSize[0], props.spriteSize[1]) / 2;
  return null;
}

/** world-space bounding sphere: center = world · origin, radius scaled by the largest
 *  world basis column (uniform-enough for v0 picking) */
export function worldBoundingSphere(world: Mat4, localRadius: number): { center: Vec3; radius: number } {
  const center: Vec3 = [world[12]!, world[13]!, world[14]!];
  const scale = Math.max(
    Math.hypot(world[0]!, world[1]!, world[2]!),
    Math.hypot(world[4]!, world[5]!, world[6]!),
    Math.hypot(world[8]!, world[9]!, world[10]!),
  );
  return { center, radius: localRadius * scale };
}
