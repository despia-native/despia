//
//  motion-core.ts - the keyframe sampler: `@keyframes` plus an `animation` shorthand, folded to
//  the property values one frame should show. The pure half of runtime-pressure R28.
//
//  WHY THIS EXISTS. `@keyframes` and `animation` parse, lint, and sit in the DSX-CSS property
//  catalogue as Tier B properties. They reach the generated native sheets VERBATIM - the IR in
//  DSXCSSStyles.generated.{swift,kt} already carries every stop. And then both native CSS
//  resolvers fall through on any at-rule that is not `@media`, so the declarations are inert.
//  The catalogue promised the author motion on every target and two targets silently disagreed,
//  which is worse than not having it: DSX has had no way to express a LOOP or a STAGGER off the
//  web, and loops and stagger are most of ambient motion.
//
//  WHAT IT DELIBERATELY DOES NOT DO. This is not a CSS animation engine. It sums to: read a
//  timeline, read a spec, return the values at time t. It animates only the COMPOSITOR
//  properties the native bridges can already apply without a layout pass - `opacity` and the
//  transform family - and every other property in a keyframe is DROPPED rather than
//  half-applied, because an animated `width` that only moves on the web is the exact defect
//  this file exists to end. The dropped set is reported, never silent (`sampleMotion` returns
//  `dropped`), so a renderer can log it once and an author can see it.
//
//  The web renderer never calls this: a browser owns its own animations, and it is the
//  reference the corpus is written against. The two native renderers drive it from the frame
//  loop they already run, which is why sampling is a PURE function of elapsed time rather than
//  a state machine - a paused tab, a backgrounded app and a deterministic test all reduce to
//  passing a different number.
//

/** The parsed `animation` shorthand. CSS's own defaults, so an omitted word behaves as CSS. */
export interface KeyframeSpec {
  name: string;
  /** milliseconds */
  duration: number;
  /** milliseconds; negative is legal and starts the animation part-way in */
  delay: number;
  easing: string;
  /** the iteration count, or MOTION_INFINITE for `infinite` */
  iterations: number;
  direction: "normal" | "reverse" | "alternate" | "alternate-reverse";
  fill: "none" | "forwards" | "backwards" | "both";
  /** `animation-play-state: paused` — the driver holds elapsed still, sampling stays pure */
  paused: boolean;
  /** `animation: none` and any unparseable name land here */
  none: boolean;
}

/** One normalized stop: an offset in 0..1 and the declarations at it. */
export interface KeyframeStop {
  offset: number;
  declarations: Record<string, string>;
}

export interface KeyframeSample {
  /** property -> value, ready for the platform bridge */
  values: Record<string, string>;
  /** properties present in the timeline that this engine will not animate */
  dropped: string[];
  /** false once a finite animation has run out AND does not fill forwards */
  active: boolean;
}

/** The only properties a keyframe may animate. Anything else is dropped and reported. */
export const MOTION_PROPERTIES: readonly string[] = ["opacity", "transform"];

/**
 * The attribute keys `animationSpec` reads - the bridged spelling of all nine `animation-*`
 * properties in the DSX-CSS catalogue. A renderer keys its driving loop on exactly these, so an
 * author editing any one of them restarts the animation, which is what CSS does.
 */
export const MOTION_ANIMATION_KEYS: readonly string[] = [
  "animation", "animationName", "animationDuration", "animationDelay",
  "animationEasing", "animationIterations", "animationDirection",
  "animationFill", "animationPlayState",
];

/**
 * `animation-iteration-count: infinite`, as a number three languages can put in JSON. Not
 * `Infinity`: JSON has no spelling for it (JSON.stringify writes `null`), Kotlin and Swift each
 * have their own, and the corpus that judges all three is a JSON file. CSS has no negative
 * iteration count, so -1 cannot collide with a real one.
 */
export const MOTION_INFINITE = -1;

const NAMED_EASINGS: Record<string, readonly [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

const DIRECTIONS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const FILLS = new Set(["none", "forwards", "backwards", "both"]);

/**
 * Parse an `animation` shorthand. CSS orders the shorthand loosely: the FIRST time is the
 * duration and the second is the delay, and every other word is identified by what it is. A
 * word this cannot classify becomes the name, which is CSS's rule too and is what makes
 * `animation: 2s spin` and `animation: spin 2s` the same declaration.
 */
export function parseAnimation(shorthand: string): KeyframeSpec {
  // The OFF spec is returned whole rather than merged onto whatever was parsed before the
  // refusal: `none: true` means every other field is a default, so a consumer cannot pick a
  // duration off a spec that is not going to run.
  const off: KeyframeSpec = {
    name: "", duration: 0, delay: 0, easing: "ease", iterations: 1,
    direction: "normal", fill: "none", paused: false, none: true,
  };
  const spec: KeyframeSpec = { ...off, none: false };
  const text = shorthand.trim();
  if (text === "" || text === "none") return off;

  let seenTime = 0;
  for (const word of splitTopLevel(text)) {
    const lower = word.toLowerCase();
    const time = parseTime(lower);
    if (time !== null) {
      if (seenTime === 0) spec.duration = time;
      else if (seenTime === 1) spec.delay = time;
      seenTime += 1;
      continue;
    }
    if (lower === "infinite") { spec.iterations = MOTION_INFINITE; continue; }
    if (NAMED_EASINGS[lower] !== undefined || lower.startsWith("cubic-bezier(")
        || lower.startsWith("steps(")) { spec.easing = lower; continue; }
    if (DIRECTIONS.has(lower)) { spec.direction = lower as KeyframeSpec["direction"]; continue; }
    if (FILLS.has(lower) && lower !== "none") { spec.fill = lower as KeyframeSpec["fill"]; continue; }
    const count = Number(lower);
    if (Number.isFinite(count) && count >= 0 && !lower.endsWith("s")) { spec.iterations = count; continue; }
    if (lower === "running") { spec.paused = false; continue; }
    if (lower === "paused") { spec.paused = true; continue; }
    if (spec.name === "") spec.name = word;
  }
  if (spec.name === "") return off;
  return spec;
}

/**
 * The spec an element's resolved attributes describe: the `animation` shorthand, then every
 * longhand that overrides it. All nine `animation-*` properties sit in the DSX-CSS catalogue as
 * Tier B, so all nine have to mean something here or the catalogue is lying again — which is the
 * defect R28 exists to end, one layer down.
 *
 * A longhand ALONE is a complete declaration (`animation-name: spin; animation-duration: 2s`),
 * so a name arriving that way turns the OFF spec on. That is CSS: the shorthand is a shorthand.
 */
export function animationSpec(attrs: Record<string, string>): KeyframeSpec {
  const spec = { ...parseAnimation(attrs["animation"] ?? "") };
  const name = attrs["animationName"]?.trim();
  if (name !== undefined && name !== "" && name !== "none") {
    spec.name = name;
    spec.none = false;
  }
  const duration = parseTime((attrs["animationDuration"] ?? "").trim().toLowerCase());
  if (duration !== null) spec.duration = duration;
  const delay = parseTime((attrs["animationDelay"] ?? "").trim().toLowerCase());
  if (delay !== null) spec.delay = delay;
  const easing = attrs["animationEasing"]?.trim().toLowerCase();
  if (easing !== undefined && easing !== "") spec.easing = easing;
  const iterations = attrs["animationIterations"]?.trim().toLowerCase();
  if (iterations === "infinite") spec.iterations = MOTION_INFINITE;
  else if (iterations !== undefined && iterations !== "") {
    const count = Number(iterations);
    if (Number.isFinite(count) && count >= 0) spec.iterations = count;
  }
  const direction = attrs["animationDirection"]?.trim().toLowerCase();
  if (direction !== undefined && DIRECTIONS.has(direction)) {
    spec.direction = direction as KeyframeSpec["direction"];
  }
  const fill = attrs["animationFill"]?.trim().toLowerCase();
  if (fill !== undefined && FILLS.has(fill)) spec.fill = fill as KeyframeSpec["fill"];
  const play = attrs["animationPlayState"]?.trim().toLowerCase();
  if (play === "paused") spec.paused = true;
  else if (play === "running") spec.paused = false;
  if (spec.name === "") spec.none = true;
  return spec;
}

/**
 * Normalize a `@keyframes` body into ordered stops. Selectors are CSS's: `from` is 0, `to` is
 * 1, `40%` is 0.4, and one rule may carry several (`0%, 80%, 100%`). Later stops at the same
 * offset win, which is the cascade inside a keyframes block.
 */
export function keyframeTimeline(
  rules: ReadonlyArray<{ selector: string; declarations: Record<string, string> }>,
): KeyframeStop[] {
  const byOffset = new Map<number, Record<string, string>>();
  for (const rule of rules) {
    for (const part of rule.selector.split(",")) {
      const offset = parseOffset(part.trim());
      if (offset === null) continue;
      byOffset.set(offset, { ...(byOffset.get(offset) ?? {}), ...rule.declarations });
    }
  }
  return [...byOffset.entries()]
    .map(([offset, declarations]) => ({ offset, declarations }))
    .sort((a, b) => a.offset - b.offset);
}

/**
 * The values at `elapsed` milliseconds since the animation was installed.
 *
 * An animation with no duration shows its LAST stop and stops being active, which is what a
 * browser does and what keeps `animation: spin 0s` from dividing by zero. Before the delay the
 * element shows the first stop only under `backwards`/`both`, and after the last iteration the
 * last stop only under `forwards`/`both` - CSS's fill rules, because half of them would make an
 * element jump at the end.
 */
export function sampleMotion(
  timeline: readonly KeyframeStop[], spec: KeyframeSpec, elapsed: number,
): KeyframeSample {
  const dropped = droppedProperties(timeline);
  if (spec.none || timeline.length === 0) return { values: {}, dropped, active: false };

  const infinite = spec.iterations === MOTION_INFINITE;
  const total = infinite ? Infinity : spec.duration * spec.iterations;
  const since = elapsed - spec.delay;

  if (since < 0) {
    const fills = spec.fill === "backwards" || spec.fill === "both";
    return { values: fills ? valuesAt(timeline, startFraction(spec)) : {}, dropped, active: true };
  }
  if (spec.duration <= 0 || (!infinite && since >= total)) {
    const fills = spec.fill === "forwards" || spec.fill === "both";
    return { values: fills ? valuesAt(timeline, endFraction(spec)) : {}, dropped, active: false };
  }

  const iteration = Math.floor(since / spec.duration);
  const within = (since % spec.duration) / spec.duration;
  const eased = ease(spec.easing, directed(within, iteration, spec.direction));
  return { values: valuesAt(timeline, eased), dropped, active: true };
}

/** What a sampled frame becomes on a native renderer, plus what could not be carried there. */
export interface KeyframeAttributes {
  /** DSX style attributes, ready to merge over the element's resolved attribute map */
  attributes: Record<string, string>;
  /** transform functions this decomposition refuses, sorted and unique */
  unsupported: string[];
}

/**
 * Turn a sampled frame into the style attributes the native ladders ALREADY apply.
 *
 * A native renderer has no `transform` attribute and is not getting one for this: it has
 * `opacity`, `rotation`, uniform `scale` and `offsetX`/`offsetY`, and those four are what both
 * Compose's `graphicsLayer` ladder and SwiftUI's modifier ladder are built out of. So the driver
 * DECOMPOSES rather than inventing a parallel transform pipeline that would then disagree with
 * the static `rotation=`/`scale=` attributes an author can already write on the same element.
 *
 * The decomposition is exact or it is refused. CSS composes transform functions as a matrix
 * chain, leftmost outermost, and the native ladder is fixed at rotation -> scale -> offset
 * (inner to outer). A uniform scale and a rotation about the same centre commute, so their order
 * is free; a translate does not, so it must come first to mean the same thing. One occurrence per
 * family, `px` translations, angle units CSS knows. Anything else yields NO attributes and is
 * reported, for the same reason `dropped` exists: a transform that renders differently off the
 * web is the defect, and a silent approximation is how it hides.
 */
export function motionAttributes(values: Record<string, string>): KeyframeAttributes {
  const attributes: Record<string, string> = {};
  const unsupported: string[] = [];
  const opacity = values["opacity"];
  if (opacity !== undefined) attributes["opacity"] = opacity;

  const transform = values["transform"];
  if (transform === undefined) return { attributes, unsupported };
  const functions = parseTransform(transform);
  if (functions === null) return { attributes, unsupported: [transform.trim()] };

  let x = 0;
  let y = 0;
  let scale: number | null = null;
  let rotation: number | null = null;
  let translated = false;
  let shaped = false;
  let refused = false;
  const refuse = (name: string): void => {
    refused = true;
    if (!unsupported.includes(name)) unsupported.push(name);
  };

  for (const fn of functions) {
    const name = fn.name.toLowerCase();
    if (name === "translate" || name === "translatex" || name === "translatey") {
      // A translate that follows a scale or a rotation is a different matrix than the ladder
      // would build, so it is refused rather than reordered.
      if (translated || shaped) { refuse(fn.name); continue; }
      const lengths = fn.args.map(px);
      if (lengths.some((n) => n === null)) { refuse(fn.name); continue; }
      if (name === "translatex") x = lengths[0] ?? 0;
      else if (name === "translatey") y = lengths[0] ?? 0;
      else { x = lengths[0] ?? 0; y = lengths[1] ?? 0; }
      translated = true;
      continue;
    }
    if (name === "scale") {
      const [a, b] = fn.args;
      if (scale !== null || a === undefined || a.unit !== ""
          || (b !== undefined && (b.unit !== "" || b.n !== a.n))) { refuse(fn.name); continue; }
      scale = a.n;
      shaped = true;
      continue;
    }
    if (name === "rotate" || name === "rotatez") {
      const degrees = fn.args.length === 1 ? deg(fn.args[0]!) : null;
      if (rotation !== null || degrees === null) { refuse(fn.name); continue; }
      rotation = degrees;
      shaped = true;
      continue;
    }
    refuse(fn.name);
  }
  if (refused) return { attributes, unsupported: unsupported.sort() };

  if (translated) {
    attributes["offsetX"] = format(x);
    attributes["offsetY"] = format(y);
  }
  if (scale !== null) attributes["scale"] = format(scale);
  if (rotation !== null) attributes["rotation"] = format(rotation);
  return { attributes, unsupported };
}

/** Every property a timeline mentions that this engine will not animate, sorted and unique. */
export function droppedProperties(timeline: readonly KeyframeStop[]): string[] {
  const out = new Set<string>();
  for (const stop of timeline) {
    for (const property of Object.keys(stop.declarations)) {
      if (!MOTION_PROPERTIES.includes(property)) out.add(property);
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------- internals

function directed(within: number, iteration: number, direction: KeyframeSpec["direction"]): number {
  if (direction === "reverse") return 1 - within;
  if (direction === "alternate") return iteration % 2 === 0 ? within : 1 - within;
  if (direction === "alternate-reverse") return iteration % 2 === 0 ? 1 - within : within;
  return within;
}

/** Where a filled-backwards animation sits before it starts, and after it ends. */
function startFraction(spec: KeyframeSpec): number {
  return spec.direction === "reverse" || spec.direction === "alternate-reverse" ? 1 : 0;
}

function endFraction(spec: KeyframeSpec): number {
  const last = spec.iterations === MOTION_INFINITE
    ? 0 : Math.max(0, Math.ceil(spec.iterations) - 1);
  return directed(1, last, spec.direction);
}

/** Interpolate every animatable property across the two stops bracketing `fraction`. */
function valuesAt(timeline: readonly KeyframeStop[], fraction: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const property of MOTION_PROPERTIES) {
    const stops = timeline.filter((s) => s.declarations[property] !== undefined);
    if (stops.length === 0) continue;
    const value = interpolate(stops, property, fraction);
    if (value !== null) out[property] = value;
  }
  return out;
}

function interpolate(
  stops: readonly KeyframeStop[], property: string, fraction: number,
): string | null {
  let before = stops[0]!;
  let after = stops[stops.length - 1]!;
  for (const stop of stops) {
    if (stop.offset <= fraction) before = stop;
    if (stop.offset >= fraction) { after = stop; break; }
  }
  const a = before.declarations[property]!;
  const b = after.declarations[property]!;
  if (before === after || after.offset === before.offset) return a;
  const t = (fraction - before.offset) / (after.offset - before.offset);
  return property === "opacity" ? mixNumber(a, b, t) : mixTransform(a, b, t);
}

function mixNumber(a: string, b: string, t: number): string {
  const from = Number(a.trim());
  const to = Number(b.trim());
  if (!Number.isFinite(from) || !Number.isFinite(to)) return a;
  return format(from + (to - from) * t);
}

/**
 * Transforms interpolate FUNCTION BY FUNCTION and only when both sides list the same functions
 * in the same order, which is CSS's own rule. A mismatched pair does not blend to nonsense: it
 * snaps at the midpoint, which is what a browser's discrete fallback looks like and is the one
 * behaviour that cannot produce a shape the author never wrote.
 */
function mixTransform(a: string, b: string, t: number): string {
  const from = parseTransform(a);
  const to = parseTransform(b);
  if (from === null || to === null || from.length !== to.length) return t < 0.5 ? a : b;
  const out: string[] = [];
  for (let i = 0; i < from.length; i += 1) {
    const f = from[i]!;
    const g = to[i]!;
    if (f.name !== g.name || f.args.length !== g.args.length) return t < 0.5 ? a : b;
    const args = f.args.map((value, j) => {
      const other = g.args[j]!;
      if (value.unit !== other.unit) return `${format(value.n)}${value.unit}`;
      return `${format(value.n + (other.n - value.n) * t)}${value.unit}`;
    });
    out.push(`${f.name}(${args.join(", ")})`);
  }
  return out.join(" ");
}

interface TransformArg { n: number; unit: string }
interface TransformFn { name: string; args: TransformArg[] }

function parseTransform(source: string): TransformFn[] | null {
  const out: TransformFn[] = [];
  const pattern = /([a-zA-Z0-9]+)\(([^)]*)\)/g;
  let match = pattern.exec(source);
  if (match === null) return source.trim() === "none" ? [] : null;
  while (match !== null) {
    const args: TransformArg[] = [];
    for (const raw of match[2]!.split(",")) {
      const text = raw.trim();
      if (text === "") continue;
      const unit = /[a-z%]+$/i.exec(text)?.[0] ?? "";
      const n = Number(unit === "" ? text : text.slice(0, text.length - unit.length));
      if (!Number.isFinite(n)) return null;
      args.push({ n, unit });
    }
    out.push({ name: match[1]!, args });
    match = pattern.exec(source);
  }
  return out;
}

/** The cubic-bezier solve, Newton then bisection - the shape every engine uses. */
function ease(easing: string, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // `linear` is IDENTITY, short-circuited rather than solved. The bisection below converges to
  // about 1e-6, which is invisible on screen and very visible in a corpus three languages
  // compare strings against: it turned an exact 60px into 59.9999px.
  if (easing === "linear") return t;
  const steps = /^steps\(\s*(\d+)/.exec(easing);
  if (steps !== null) {
    const n = Math.max(1, Number(steps[1]));
    return easing.includes("start") ? Math.ceil(t * n) / n : Math.floor(t * n) / n;
  }
  const named = NAMED_EASINGS[easing];
  const custom = /^cubic-bezier\(([^)]*)\)$/.exec(easing);
  const p = named ?? (custom !== null
    ? custom[1]!.split(",").map((x) => Number(x.trim())) as [number, number, number, number]
    : NAMED_EASINGS["ease"]!);
  if (p.some((n) => !Number.isFinite(n))) return t;
  const [x1, y1, x2, y2] = p;
  const bez = (a: number, b: number, u: number): number => {
    const v = 1 - u;
    return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
  };
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 24; i += 1) {
    const x = bez(x1, x2, u);
    if (Math.abs(x - t) < 1e-6) break;
    if (x < t) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  return bez(y1, y2, u);
}

/** A translation length in points. `0` is unitless in CSS; a percentage needs a box, so it is not. */
function px(arg: TransformArg): number | null {
  if (arg.unit === "px") return arg.n;
  if (arg.unit === "" && arg.n === 0) return 0;
  return null;
}

/** An angle in degrees, in the units CSS writes them. */
function deg(arg: TransformArg): number | null {
  if (arg.unit === "deg") return arg.n;
  if (arg.unit === "rad") return (arg.n * 180) / Math.PI;
  if (arg.unit === "turn") return arg.n * 360;
  if (arg.unit === "grad") return (arg.n * 360) / 400;
  if (arg.unit === "" && arg.n === 0) return 0;
  return null;
}

function parseTime(word: string): number | null {
  if (word.endsWith("ms")) {
    const n = Number(word.slice(0, -2));
    return Number.isFinite(n) ? n : null;
  }
  if (word.endsWith("s")) {
    const n = Number(word.slice(0, -1));
    return Number.isFinite(n) ? n * 1000 : null;
  }
  return null;
}

function parseOffset(selector: string): number | null {
  const lower = selector.toLowerCase();
  if (lower === "from") return 0;
  if (lower === "to") return 1;
  if (!lower.endsWith("%")) return null;
  const n = Number(lower.slice(0, -1));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n / 100));
}

/** Split on whitespace, but never inside `cubic-bezier(…)` or `steps(…)`. */
function splitTopLevel(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of source) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && (ch === " " || ch === "\t" || ch === "\n")) {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") out.push(current);
  return out;
}

/**
 * Four decimals, trailing zeros trimmed, negative zero normalized - the same rule the
 * scroll-linked plane formats by, and for the same reason: three languages compare these
 * strings against one corpus.
 */
function format(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(Math.abs(value) * 10000) / 10000 * Math.sign(value || 1);
  if (rounded === 0) return "0";
  let text = rounded.toFixed(4);
  text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}
