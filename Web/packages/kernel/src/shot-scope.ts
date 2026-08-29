//
//  shot-scope.ts - THE SHOT SCOPE RESOLVER (platform/10-screenshot-execution.md §5).
//
//  A screenshot of an empty screen is worthless and a screenshot of a raw binding is a store
//  rejection, so the hard part of an automated screenshot is not rasterising - it is arriving
//  at a RESOLVED SCOPE before anything draws. This file is that arrival, and nothing else: it
//  is pure, it touches no DOM, no clock and no network, and every runtime can share it.
//
//  WHAT IT DOES NOT DO, on purpose. It does not order the api graph (/web/11 already builds
//  that DAG on all three kernels), it does not evaluate formulas (seed the leaves and let the
//  graph run), and it does not decide emptiness (that needs a render - shot-guards.ts). A
//  resolver that re-implemented any of those would be a second opinion about how the runtime
//  behaves, held by one caller and tested by nobody.
//
//  THE LADDER (§7d of the 09 document), highest wins, per NAME KIND:
//
//    leaf state (attribute · variable · expects)   global plane (global.*)
//      1  shot override                              1  shot override
//      2  captured snapshot                          2  captured snapshot
//      3  sample=                                    3  project hydrate
//      4  default=          (attribute only)         4  FAIL
//      5  declared initial  (variable body runs)
//      6  FAIL
//
//  Globals have no `sample=` site - there is no declaration to hang one on - which is exactly
//  why the project `hydrate` plane exists and why it sits at their tier 3.
//
//  TIER 6/4 IS THE WHOLE POINT. A name that reaches it does not render as an empty string, a
//  placeholder, or the binding text: the shot FAILS and names the binding. An image is never
//  produced from an unresolved scope, which is the placeholder-content store rejection made
//  structural rather than hoped for.
//

import { isDict, type Dict } from "./jse/values.ts";

// ── the inputs ───────────────────────────────────────────────────────────────────────

/** The subset of `ComponentHead` the resolver reads. Structural, so a `ComponentHead`
 *  satisfies it without the kernel importing the compiler (which it must not). */
export type ShotHead = {
  attributes: ReadonlyArray<{ as: string; default?: string; sample?: string }>;
  variables: ReadonlyArray<{ as: string; body: string; computed: boolean; sample?: string }>;
  apis: ReadonlyArray<{ as: string; attrs: { [k: string]: string }; sample?: string }>;
  events?: ReadonlyArray<{ as: string; payload: string[]; sample?: string }>;
  /** `<expects variable="x"/>` - state the MOUNTING side seeds. A headless shot has no
   *  mounting side, so every row resolves through this ladder or lands unresolved (§5a). */
  expects?: ReadonlyArray<string>;
};

/** The project-wide plane: the app-wide store's sample values. The word matches the module
 *  manifests' own `hydrate` (writing-unit-tests.md), which is the same idea one scope down. */
export type ShotHydrate = { global?: Dict };

/** A frozen live snapshot from the state door (`devState()`), the capture-from-preview path. */
export type ShotSnapshot = {
  screen?: string | null;
  vars?: ReadonlyArray<{ name: string; value: unknown }>;
  /** the `global.*` plane - W2 made the door's read half symmetric with its write half */
  globals?: Dict;
};

/** Per-image overrides, the top tier. `vars`/`globals` are dotted-name keyed. */
export type ShotOverrides = { vars?: Dict; globals?: Dict };

/** Where an api's answer comes from. `record` is `live` that also writes a cassette, so it
 *  has live's reachability and replay's determinism on the NEXT run - which is why it is the
 *  mode a project settles on once it has a staging backend. */
export type ShotMode = "sample" | "replay" | "record" | "live";

export type ShotScopeInput = {
  head: ShotHead;
  hydrate?: ShotHydrate;
  snapshot?: ShotSnapshot | null;
  overrides?: ShotOverrides;
  /** `/notes/:id` params for the shot's route, resolved into the attribute scope (§5b). */
  routeParams?: { [name: string]: unknown };
  /** Which response plane is armed. `sample` requires every reachable api to carry a
   *  `sample=`; `replay` is answered by the cassette; `live` reaches the network. */
  mode?: ShotMode;
  /** Names the cassette can answer, so `replay` does not demand a `sample=` too. */
  cassetteKeys?: ReadonlyArray<string>;
};

// ── the outputs ──────────────────────────────────────────────────────────────────────

/** Why a name could not be resolved. `kind` is the declaration site; `name` is what the
 *  author has to fix; `fix` is the sentence the report prints. */
export type ShotUnresolved = {
  kind: "attribute" | "variable" | "expects" | "api" | "global" | "routeParam";
  name: string;
  reason: string;
  fix: string;
};

/** One armed seam route: any request matching `method` + `template` is answered with `data`. */
export type ShotSeamRoute = {
  as: string;
  method: string;
  /** the authored url with `{{ … }}` holes intact - matching is by template, not by value,
   *  because the hole's value is whatever the DAG interpolated at fire time */
  template: string;
  /** the regex source the driver matches with (holes widened to a single segment) */
  pattern: string;
  data: unknown;
};

export type ShotScopeResult = {
  /** the entry surface's ATTRIBUTES - what a parent would pass. Kept separate from `vars`
   *  because a component reads its own attributes as `dsx.attribute.<name>` and its variables
   *  by bare name: seeding an attribute into the variable scope would make the shot render
   *  differently from the way the component is really used, which is the one thing a
   *  screenshot must never do. */
  attrs: Dict;
  /** the screen's own variable scope, ready for the store / `renderToString(vars)` */
  vars: Dict;
  /** the app-wide plane, ready for `devSetState("global.<k>", v)` */
  globals: Dict;
  /** SSR/isolated-render seeds keyed by `as` (the `renderToString` opts shape) */
  apiSeeds: { [as: string]: { data: unknown } };
  /** the live-boot response plane */
  seamPlan: ShotSeamRoute[];
  /** non-empty means NO IMAGE */
  unresolved: ShotUnresolved[];
};

// ── sample parsing (the three laws: JSON, no production semantics, lint-gated) ────────

/** A sample is JSON, never an expression - `JSON.parse` on every runner, in lint, and in
 *  every future native editor. A malformed one is a lint error at authoring time; here it
 *  is simply not a value, so the name falls through to the next tier honestly. */
export function parseSample(text: string | undefined): { ok: boolean; value: unknown } {
  if (text === undefined) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}

// ── url templates: matching by SHAPE, because the hole's value is the DAG's ───────────

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
/** One `{{ … }}` hole widened to a single url segment. A hole is one path segment or one
 *  query value - never a `/` or a `&` - so a template cannot swallow the rest of the url
 *  and quietly answer a request it was not written for. */
const HOLE_PATTERN = "[^/?&#]*";

/** `/api/orders?user={{ user.data.id }}` → an anchored regex source. */
export function templateToPattern(template: string): string {
  let out = "";
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf("{{", index);
    if (open < 0) {
      out += template.substring(index).replace(REGEX_SPECIAL, "\\$&");
      break;
    }
    const close = template.indexOf("}}", open);
    if (close < 0) {
      out += template.substring(index).replace(REGEX_SPECIAL, "\\$&");
      break;
    }
    out += template.substring(index, open).replace(REGEX_SPECIAL, "\\$&");
    out += HOLE_PATTERN;
    index = close + 2;
  }
  return `^${out}$`;
}

/** A concrete url that the template certainly matches - used to detect two templates that
 *  could both answer one request. */
function specimen(template: string): string {
  return template.replace(/\{\{[^}]*\}\}/g, "x");
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Two routes COLLIDE when one request could be answered by either with a different answer.
 *
 * Identical shapes carrying identical data are not a collision: it does not matter which one
 * answers, so refusing them would be a false positive on a screen that legitimately declares
 * the same read twice. What is refused is genuine ambiguity, and it is refused at PLAN time
 * rather than becoming a runtime coin flip nobody can reproduce.
 */
export function seamCollisions(routes: ReadonlyArray<ShotSeamRoute>): Array<{ a: string; b: string }> {
  const out: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const a = routes[i]!;
      const b = routes[j]!;
      if (a.method !== b.method) continue;
      if (sameJson(a.data, b.data)) continue;
      const overlaps = new RegExp(a.pattern).test(specimen(b.template))
        || new RegExp(b.pattern).test(specimen(a.template));
      if (overlaps) out.push({ a: a.as, b: b.as });
    }
  }
  return out;
}

// ── the ladder ───────────────────────────────────────────────────────────────────────

function snapshotVars(snapshot: ShotSnapshot | null | undefined): Dict {
  const out: Dict = {};
  for (const row of snapshot?.vars ?? []) {
    if (typeof row?.name === "string") out[row.name] = row.value;
  }
  return out;
}

/** An `<api>` is REACHABLE for the response plane unless it is a mutation: a non-GET never
 *  auto-fires, so a shot that never taps anything cannot provoke one, and demanding a sample
 *  for a POST would fail screens that are perfectly renderable. */
function apiAutoFires(attrs: { [k: string]: string }): boolean {
  const method = (attrs["method"] ?? "GET").trim().toUpperCase();
  if (method !== "GET") return false;
  const auto = (attrs["auto"] ?? "").trim();
  return auto !== "false";
}

/**
 * Resolve one screen's shot scope. Pure: same inputs, same result, on every runtime.
 */
export function resolveShotScope(input: ShotScopeInput): ShotScopeResult {
  const head = input.head;
  const mode: ShotMode = input.mode ?? "sample";
  const overrideVars = (input.overrides?.vars ?? {}) as Dict;
  const overrideGlobals = (input.overrides?.globals ?? {}) as Dict;
  const snapVars = snapshotVars(input.snapshot);
  const snapGlobals = (input.snapshot?.globals ?? {}) as Dict;
  const hydrateGlobals = (input.hydrate?.global ?? {}) as Dict;
  const routeParams = (input.routeParams ?? {}) as Dict;
  const cassette = new Set(input.cassetteKeys ?? []);

  const attrs: Dict = {};
  const vars: Dict = {};
  const globals: Dict = {};
  const apiSeeds: { [as: string]: { data: unknown } } = {};
  const seamPlan: ShotSeamRoute[] = [];
  const unresolved: ShotUnresolved[] = [];

  const has = (bag: Dict, name: string): boolean => Object.prototype.hasOwnProperty.call(bag, name);

  // ── attributes: override > snapshot > route param > sample > default ──
  //
  //  A route param is a REAL value the frame will genuinely be mounted with, so it outranks
  //  a planted sample: a shot of `/notes/7` whose sample says `3` would render the wrong
  //  note and look like a data bug to whoever reviewed it.
  for (const row of head.attributes) {
    const name = row.as;
    if (has(overrideVars, name)) { attrs[name] = overrideVars[name]; continue; }
    if (has(snapVars, name)) { attrs[name] = snapVars[name]; continue; }
    if (has(routeParams, name)) { attrs[name] = routeParams[name]; continue; }
    const sample = parseSample(row.sample);
    if (sample.ok) { attrs[name] = sample.value; continue; }
    if (row.default !== undefined && row.default.trim().length > 0) continue; // tier 4: the runtime evaluates it
    unresolved.push({
      kind: "attribute",
      name,
      reason: "no override, snapshot, route param, sample= or default=",
      fix: `declare sample= on <attribute as="${name}"/>, or give it a default=`,
    });
  }

  // ── expects: override > snapshot > sample-less, so hydrate is its floor ──
  //
  //  `<expects>` names state a PARENT or the native layer seeds. Headless there is neither,
  //  so an unmet row is unresolved like any other leaf rather than silently null.
  for (const name of head.expects ?? []) {
    if (has(overrideVars, name)) { vars[name] = overrideVars[name]; continue; }
    if (has(snapVars, name)) { vars[name] = snapVars[name]; continue; }
    if (has(hydrateGlobals, name)) { vars[name] = hydrateGlobals[name]; continue; }
    unresolved.push({
      kind: "expects",
      name,
      reason: "seeded state with no seeder - a headless shot has no mounting side",
      fix: `add "${name}" to the shot's vars, or declare it in the project hydrate plane`,
    });
  }

  // ── variables: override > snapshot > sample, then the body runs (never unresolved) ──
  for (const row of head.variables) {
    const name = row.as;
    if (has(overrideVars, name)) { vars[name] = overrideVars[name]; continue; }
    if (has(snapVars, name)) { vars[name] = snapVars[name]; continue; }
    const sample = parseSample(row.sample);
    if (sample.ok) { vars[name] = sample.value; continue; }
    // tier 5: a <variable> has a body, so it resolves itself. A computed one derives from
    // its inputs - seed the leaves, run the graph - and neither can be "missing".
  }

  // ── the global plane: override > snapshot > hydrate ──
  for (const bag of [hydrateGlobals, snapGlobals, overrideGlobals]) {
    for (const [k, v] of Object.entries(bag)) globals[k] = v;
  }

  // ── the response plane ──
  for (const row of head.apis) {
    const name = row.as;
    if (!apiAutoFires(row.attrs)) continue;
    const sample = parseSample(row.sample);
    if (sample.ok) {
      apiSeeds[name] = { data: sample.value };
      seamPlan.push({
        as: name,
        method: (row.attrs["method"] ?? "GET").trim().toUpperCase(),
        template: row.attrs["url"] ?? "",
        pattern: templateToPattern(row.attrs["url"] ?? ""),
        data: sample.value,
      });
      continue;
    }
    if (mode === "live" || mode === "record") continue;  // the network answers it
    if (mode === "replay" && cassette.has(name)) continue;  // the cassette answers it
    unresolved.push({
      kind: "api",
      name,
      reason: mode === "replay"
        ? "no sample= and no cassette entry"
        : "no sample= - the shot would render a spinner or an empty list",
      fix: `declare sample='…' on <api as="${name}"/>, or record a cassette`,
    });
  }

  for (const clash of seamCollisions(seamPlan)) {
    unresolved.push({
      kind: "api",
      name: `${clash.a} / ${clash.b}`,
      reason: "two url templates could answer one request with different data",
      fix: `make the urls of <api as="${clash.a}"/> and <api as="${clash.b}"/> distinguishable`,
    });
  }

  return { attrs, vars, globals, apiSeeds, seamPlan, unresolved };
}

/** The one-line verdict a report prints. Kept here so every face says it the same way. */
export function shotScopeVerdict(result: ShotScopeResult): string {
  if (result.unresolved.length === 0) {
    return `scope resolved: ${Object.keys(result.attrs).length} attr(s), `
      + `${Object.keys(result.vars).length} var(s), `
      + `${Object.keys(result.globals).length} global(s), ${result.seamPlan.length} api route(s)`;
  }
  return `${result.unresolved.length} unresolved binding(s): `
    + result.unresolved.map((u) => `${u.kind} ${u.name}`).join(", ");
}

export { isDict as isShotDict };
