//
//  film-document.ts - the `<film>` document reader (12-marketing-video.md, Phase 1).
//
//  A marketing film is a .dsx document - the same move `<server>` and `<cli>` made - so it is
//  typed, linted, Git-diffable, and the same file the Studio, the CLI and the MCP agent all
//  edit. This reader turns the markup into the kernel's `Film` (pure timeline data) and
//  refuses, naming the line, anything outside the closed grammar: a film that renders is a
//  film every renderer agrees about, and an unknown attribute silently ignored is how two
//  renders of one document stop agreeing.
//
//  THE GRAMMAR (closed, small on purpose - it grows only through the corpus):
//
//    <film id= duration= fps= size=>
//      <theme bg= ink= accent= font=/>
//      <state name=>
//        <value var=|global=>json-or-text</value>
//      </state>
//      <scene for= [document= state= device= float= glow= cut= frame= width=]>
//        <text role="hook|benefit|title|cta" [accent=]>the words</text>
//        <caption at= for=>the words</caption>
//        <camera at= for= [target=] [zoom=] [ease=]/>
//        <pose at= for= [turn= tilt= roll= x= y= scale=] [ease=]/>   the cinematic track
//        <tap at= target=/>
//        <set at= var= to=/>                                          an instant state write
//        <tween at= for= var= from= to= [ease=] [round=]/>            an animated state write
//        <apply at= state=/>                    a whole named state, applied mid-scene
//        <focus at= for= target=/>              spotlight a component
//        <morph target= for= [ease=]/>          the hero transition INTO this scene
//        <frame document= [state=] [width=] [x=] [y=] [depth=]/>  a supporting device
//      </scene>
//    </film>
//
//  Scene `at` is DERIVED (scenes are contiguous by law - the validator refuses gaps), so the
//  author writes only `for=` and reordering scenes is moving lines, never re-timing a film.
//
//  cut="hard" is the commercial fast cut (the incoming scene owns both edges of its
//  boundary). frame="none" is the frameless product shot: the component itself on the stage,
//  sized by width= instead of device=. Every ease word includes `spring` - the one physics
//  the three renderers already share.
//
//  THE STATE JOURNEY. <apply> turns a film into a walk through the app's OWN states: each
//  <state> block is a complete situation (the same vocabulary the sample plane and the shot
//  profiles speak), and applying one mid-scene makes data appear and update the way it does
//  in the running product. It compiles to the existing write law - one <set> per var, all
//  attributed to the same frame - so the kernel needs no new machinery and an agent that can
//  read a document's head (variables, samples, actions) can WRITE the journey: generate the
//  <state> blocks, sequence them with <apply>, sweeten the numbers with <tween>.
//

import { readFileSync } from "node:fs";

import { parseDsx, type XmlNode } from "@despia-native/compiler/xml";
import { parseMotion } from "@despia-native/kernel";
import {
  validateFilm, POSE_HOME,
  type Film, type FilmProblem, type FilmScene, type FilmStatePreset, type FilmTextRole,
} from "@despia-native/kernel/film";

export class FilmDocumentError extends Error {}

// ── little parsers, each refusing loudly ─────────────────────────────────────────────

/** "18s" | "2.5s" | "300ms" -> milliseconds. A bare number is refused: a duration without a
 *  unit has silently meant both in too many tools. */
export function parseTimeMs(text: string, where: string): number {
  const t = text.trim();
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(t);
  if (ms !== null) return Number(ms[1]);
  const s = /^(\d+(?:\.\d+)?)s$/.exec(t);
  if (s !== null) return Number(s[1]) * 1000;
  throw new FilmDocumentError(`${where}: "${text}" is not a duration - write 2.5s or 300ms`);
}

function parseSize(text: string, where: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(text.trim());
  if (m === null) throw new FilmDocumentError(`${where}: size is WxH, e.g. 1080x1920`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const TEXT_ROLES = new Set<FilmTextRole>(["hook", "benefit", "title", "cta"]);
const EASE_WORDS = new Set(["spring", "linear", "easeIn", "easeOut", "easeInOut"]);

/** How long the ONE shared spring (response 1s) takes to settle to its 0.1% envelope. */
const SPRING_UNIT_SETTLE_MS = parseMotion("spring", "1").durationMs;

/** An ease word to a MotionSpec for a move that OWNS a window of forMs. Curves take forMs as
 *  their duration directly. `spring` is different: parseMotion's second argument is the
 *  RESPONSE and the spring owns its own settle time - so the response is derived (settle is
 *  linear in response) to land the 0.1% envelope exactly on the authored window, which keeps
 *  `for=` meaning the same thing on every ease word and keeps hold-then-move snap-free. */
function filmEase(word: string, forMs: number): ReturnType<typeof parseMotion> {
  if (word === "spring") return parseMotion("spring", String(forMs / SPRING_UNIT_SETTLE_MS));
  return parseMotion(word, String(forMs / 1000));
}

function only(node: XmlNode, allowed: readonly string[], where: string): void {
  for (const name of Object.keys(node.attrs)) {
    if (!allowed.includes(name)) {
      throw new FilmDocumentError(`${where}: unknown attribute ${name}= - the film grammar is closed`);
    }
  }
}

function jsonOrText(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t) as unknown; } catch { return t; }
}

// ── the reader ───────────────────────────────────────────────────────────────────────

export function readFilmDocument(source: string): Film {
  const root = parseDsx(source);
  if (root.tag !== "film") {
    throw new FilmDocumentError(`a film document's root is <film>, not <${root.tag}>`);
  }
  only(root, ["id", "duration", "fps", "size"], "<film>");
  const id = root.attrs["id"] ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new FilmDocumentError("<film>: id= is required (lowercase, digits, hyphens)");
  }
  const durationMs = parseTimeMs(root.attrs["duration"] ?? "", "<film duration=>");
  const fps = Number(root.attrs["fps"] ?? "30");
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    throw new FilmDocumentError("<film>: fps must be an integer 1..60");
  }
  const format = parseSize(root.attrs["size"] ?? "1080x1920", "<film size=>");

  const theme: Film["theme"] = { bg: "#0b0d12", ink: "#f4f6fb", accent: "#34d399", font: "" };
  const states: FilmStatePreset[] = [];
  const scenes: FilmScene[] = [];
  // <apply> rows resolve AFTER the parse: a <state> block may lawfully follow the scene
  // that applies it, and half-resolved order-dependence is worse than a second pass
  const pendingApplies: Array<{ scene: FilmScene; where: string; atMs: number; name: string }> = [];
  // <frame state=> resolves in the same second pass: a <state> block may lawfully follow
  // the scene that names it, and a typo'd name silently falling back to document samples
  // would be the one open joint in a closed grammar
  const pendingFrameStates: Array<{ where: string; name: string }> = [];
  let cursorMs = 0;

  for (const child of root.children) {
    if (child.tag === "theme") {
      only(child, ["bg", "ink", "accent", "font", "scheme"], "<theme>");
      theme.bg = child.attrs["bg"] ?? theme.bg;
      theme.ink = child.attrs["ink"] ?? theme.ink;
      theme.accent = child.attrs["accent"] ?? theme.accent;
      theme.font = child.attrs["font"] ?? theme.font;
      const scheme = child.attrs["scheme"];
      if (scheme !== undefined) {
        if (scheme !== "light" && scheme !== "dark") {
          throw new FilmDocumentError("<theme>: scheme is light or dark");
        }
        theme.scheme = scheme;
      }
      continue;
    }
    if (child.tag === "state") {
      only(child, ["name"], "<state>");
      const name = child.attrs["name"] ?? "";
      if (name === "") throw new FilmDocumentError("<state>: name= is required");
      const preset: FilmStatePreset = { name, vars: {}, globals: {} };
      for (const row of child.children) {
        if (row.tag !== "value") {
          throw new FilmDocumentError(`<state ${name}>: <${row.tag}> is not a state row - use <value>`);
        }
        only(row, ["var", "global"], "<value>");
        const varName = row.attrs["var"];
        const globalName = row.attrs["global"];
        if ((varName === undefined) === (globalName === undefined)) {
          throw new FilmDocumentError(`<state ${name}>: a <value> names exactly one of var= or global=`);
        }
        if (varName !== undefined) preset.vars[varName] = jsonOrText(row.text);
        else preset.globals[globalName!] = jsonOrText(row.text);
      }
      states.push(preset);
      continue;
    }
    if (child.tag !== "scene") {
      throw new FilmDocumentError(`<film>: <${child.tag}> is not part of the grammar`);
    }

    only(child, ["for", "document", "state", "device", "float", "glow", "cut", "frame", "width"],
      "<scene>");
    const forMs = parseTimeMs(child.attrs["for"] ?? "", `scene ${scenes.length + 1} <scene for=>`);
    const cut = child.attrs["cut"] ?? "fade";
    if (cut !== "fade" && cut !== "hard") {
      throw new FilmDocumentError(`scene ${scenes.length + 1}: cut= is fade or hard`);
    }
    const frame = child.attrs["frame"] ?? "device";
    if (frame !== "device" && frame !== "none") {
      throw new FilmDocumentError(`scene ${scenes.length + 1}: frame= is device or none`);
    }
    if (frame === "none" && child.attrs["document"] === undefined) {
      throw new FilmDocumentError(
        `scene ${scenes.length + 1}: frame="none" is the frameless product shot - it needs a document to be the product of`);
    }
    // the mount width: device= sizes the chassis, width= sizes the frameless component -
    // one number in the kernel, two words in the grammar because they measure different things
    const widthWord = frame === "none" ? "width" : "device";
    if (child.attrs[frame === "none" ? "device" : "width"] !== undefined) {
      throw new FilmDocumentError(
        `scene ${scenes.length + 1}: a ${frame === "none" ? "frameless" : "device"} scene is sized by ${widthWord}=`);
    }
    const scene: FilmScene = {
      atMs: cursorMs,
      forMs,
      document: child.attrs["document"] ?? "",
      state: child.attrs["state"] ?? "",
      deviceWidth: child.attrs[widthWord] === undefined
        ? 0
        : Number((/^(\d+(?:\.\d+)?)%$/.exec(child.attrs[widthWord]!) ?? [null, NaN])[1]) / 100,
      texts: [], captions: [], camera: [], taps: [],
      poses: [],
      float: child.attrs["float"] !== "false" && child.attrs["document"] !== undefined,
      glow: child.attrs["glow"] ?? "accent",
      cut, frame, sets: [], tweens: [], focus: [], morph: null, frames: [],
    };
    if (child.attrs[widthWord] !== undefined && !(scene.deviceWidth > 0 && scene.deviceWidth <= 1)) {
      throw new FilmDocumentError(`scene ${scenes.length + 1}: ${widthWord}= is a percentage of the stage width, e.g. 78%`);
    }

    const where = `scene ${scenes.length + 1}`;
    for (const el of child.children) {
      if (el.tag === "text") {
        only(el, ["role", "accent"], `${where} <text>`);
        const role = (el.attrs["role"] ?? "title") as FilmTextRole;
        if (!TEXT_ROLES.has(role)) {
          throw new FilmDocumentError(`${where}: text role "${role}" is not hook|benefit|title|cta`);
        }
        scene.texts.push({ role, text: el.text.trim(), accent: el.attrs["accent"] ?? "" });
        continue;
      }
      if (el.tag === "caption") {
        only(el, ["at", "for"], `${where} <caption>`);
        scene.captions.push({
          text: el.text.trim(),
          atMs: parseTimeMs(el.attrs["at"] ?? "0s", `${where} <caption at=>`),
          forMs: parseTimeMs(el.attrs["for"] ?? "", `${where} <caption for=>`),
        });
        continue;
      }
      if (el.tag === "camera") {
        only(el, ["at", "for", "target", "zoom", "ease"], `${where} <camera>`);
        const ease = el.attrs["ease"] ?? "easeInOut";
        if (!EASE_WORDS.has(ease)) {
          throw new FilmDocumentError(`${where}: camera ease "${ease}" is not a motion word`);
        }
        const forMs = parseTimeMs(el.attrs["for"] ?? "", `${where} <camera for=>`);
        const zoom = Number(el.attrs["zoom"] ?? "1");
        if (!(zoom > 0 && zoom <= 8)) {
          throw new FilmDocumentError(`${where}: camera zoom must be in (0, 8]`);
        }
        scene.camera.push({
          atMs: parseTimeMs(el.attrs["at"] ?? "0s", `${where} <camera at=>`),
          forMs,
          target: el.attrs["target"] ?? "",
          zoom,
          ease: filmEase(ease, forMs),
        });
        continue;
      }
      if (el.tag === "pose") {
        only(el, ["at", "for", "turn", "tilt", "roll", "x", "y", "scale", "ease"], `${where} <pose>`);
        const ease = el.attrs["ease"] ?? "easeInOut";
        if (!EASE_WORDS.has(ease)) {
          throw new FilmDocumentError(`${where}: pose ease "${ease}" is not a motion word`);
        }
        const forMs = parseTimeMs(el.attrs["for"] ?? "", `${where} <pose for=>`);
        const deg = (name: string): number => {
          const raw = el.attrs[name];
          if (raw === undefined) return 0;
          const m = /^(-?\d+(?:\.\d+)?)deg$/.exec(raw.trim());
          if (m === null) throw new FilmDocumentError(`${where}: pose ${name}= is degrees, e.g. -18deg`);
          return Number(m[1]);
        };
        const frac = (name: string): number => {
          const raw = el.attrs[name];
          if (raw === undefined) return 0;
          const m = /^(-?\d+(?:\.\d+)?)%$/.exec(raw.trim());
          if (m === null) throw new FilmDocumentError(`${where}: pose ${name}= is a stage percentage, e.g. 6%`);
          return Number(m[1]) / 100;
        };
        const scale = el.attrs["scale"] === undefined ? 1 : Number(el.attrs["scale"]);
        if (!(scale > 0 && scale <= 4)) {
          throw new FilmDocumentError(`${where}: pose scale must be in (0, 4]`);
        }
        scene.poses.push({
          atMs: parseTimeMs(el.attrs["at"] ?? "0s", `${where} <pose at=>`),
          forMs,
          to: { ...POSE_HOME, turn: deg("turn"), tilt: deg("tilt"), roll: deg("roll"),
                x: frac("x"), y: frac("y"), scale },
          ease: filmEase(ease, forMs),
        });
        continue;
      }
      if (el.tag === "set") {
        only(el, ["at", "var", "to"], `${where} <set>`);
        const name = el.attrs["var"] ?? "";
        if (name === "") throw new FilmDocumentError(`${where}: <set> names its var=`);
        if (el.attrs["to"] === undefined) {
          throw new FilmDocumentError(`${where}: <set ${name}> needs to= (json or text)`);
        }
        scene.sets.push({
          atMs: parseTimeMs(el.attrs["at"] ?? "", `${where} <set at=>`),
          name,
          value: jsonOrText(el.attrs["to"]),
        });
        continue;
      }
      if (el.tag === "tween") {
        only(el, ["at", "for", "var", "from", "to", "ease", "round"], `${where} <tween>`);
        const name = el.attrs["var"] ?? "";
        if (name === "") throw new FilmDocumentError(`${where}: <tween> names its var=`);
        const ease = el.attrs["ease"] ?? "linear";
        if (!EASE_WORDS.has(ease)) {
          throw new FilmDocumentError(`${where}: tween ease "${ease}" is not a motion word`);
        }
        const round = el.attrs["round"] ?? "false";
        if (round !== "true" && round !== "false") {
          throw new FilmDocumentError(`${where}: tween round= is true or false`);
        }
        const num = (attr: string): number => {
          const raw = el.attrs[attr];
          const n = raw === undefined ? NaN : Number(raw);
          if (!Number.isFinite(n)) {
            throw new FilmDocumentError(`${where}: <tween ${name}> ${attr}= is a number - a tween animates a numeric value`);
          }
          return n;
        };
        const forMs = parseTimeMs(el.attrs["for"] ?? "", `${where} <tween for=>`);
        scene.tweens.push({
          atMs: parseTimeMs(el.attrs["at"] ?? "0s", `${where} <tween at=>`),
          forMs,
          name,
          from: num("from"),
          to: num("to"),
          ease: filmEase(ease, forMs),
          round: round === "true",
        });
        continue;
      }
      if (el.tag === "apply") {
        only(el, ["at", "state"], `${where} <apply>`);
        const name = el.attrs["state"] ?? "";
        if (name === "") throw new FilmDocumentError(`${where}: <apply> names its state=`);
        pendingApplies.push({
          scene, where,
          atMs: parseTimeMs(el.attrs["at"] ?? "", `${where} <apply at=>`),
          name,
        });
        continue;
      }
      if (el.tag === "focus") {
        only(el, ["at", "for", "target"], `${where} <focus>`);
        const target = el.attrs["target"] ?? "";
        if (!target.startsWith("#")) {
          throw new FilmDocumentError(`${where}: a focus target is a semantic landmark ("#id")`);
        }
        scene.focus.push({
          atMs: parseTimeMs(el.attrs["at"] ?? "0s", `${where} <focus at=>`),
          forMs: parseTimeMs(el.attrs["for"] ?? "", `${where} <focus for=>`),
          target,
        });
        continue;
      }
      if (el.tag === "morph") {
        only(el, ["target", "for", "ease"], `${where} <morph>`);
        if (scene.morph !== null) {
          throw new FilmDocumentError(`${where}: one morph per scene - a boundary is one edit`);
        }
        const target = el.attrs["target"] ?? "";
        if (!target.startsWith("#")) {
          throw new FilmDocumentError(`${where}: a morph target is a semantic landmark ("#id")`);
        }
        const ease = el.attrs["ease"] ?? "easeInOut";
        if (!EASE_WORDS.has(ease)) {
          throw new FilmDocumentError(`${where}: morph ease "${ease}" is not a motion word`);
        }
        const forMs = parseTimeMs(el.attrs["for"] ?? "", `${where} <morph for=>`);
        scene.morph = { target, forMs, ease: filmEase(ease, forMs) };
        continue;
      }
      if (el.tag === "frame") {
        only(el, ["document", "state", "width", "x", "y", "depth"], `${where} <frame>`);
        const doc = el.attrs["document"] ?? "";
        if (doc === "") throw new FilmDocumentError(`${where}: a supporting <frame> names its document=`);
        const pct = (name: string, fallback: number): number => {
          const raw = el.attrs[name];
          if (raw === undefined) return fallback;
          const m = /^(\d+(?:\.\d+)?)%$/.exec(raw.trim());
          if (m === null) {
            throw new FilmDocumentError(`${where}: <frame> ${name}= is a stage percentage, e.g. 34%`);
          }
          return Number(m[1]) / 100;
        };
        const depthWord = el.attrs["depth"] ?? "back";
        if (depthWord !== "back" && depthWord !== "front") {
          throw new FilmDocumentError(`${where}: <frame> depth= is back or front`);
        }
        const frameState = el.attrs["state"] ?? "";
        if (frameState !== "") pendingFrameStates.push({ where, name: frameState });
        scene.frames.push({
          document: doc,
          state: el.attrs["state"] ?? "",
          width: pct("width", 0.34),
          x: pct("x", 0.5),
          y: pct("y", 0.42),
          depth: depthWord === "back" ? -1 : 1,
        });
        continue;
      }
      if (el.tag === "tap") {
        only(el, ["at", "target"], `${where} <tap>`);
        const target = el.attrs["target"] ?? "";
        if (!target.startsWith("#")) {
          throw new FilmDocumentError(`${where}: a tap target is a semantic landmark ("#id"), never a coordinate`);
        }
        scene.taps.push({ atMs: parseTimeMs(el.attrs["at"] ?? "", `${where} <tap at=>`), target });
        continue;
      }
      throw new FilmDocumentError(`${where}: <${el.tag}> is not a scene layer`);
    }

    // a document scene: camera targets must be resolvable landmarks or the neutral ""
    if (scene.document === "") {
      if (scene.camera.some((m) => m.target !== "")) {
        throw new FilmDocumentError(`${where}: a camera target needs a mounted document to measure it in`);
      }
      if (scene.taps.length > 0) {
        throw new FilmDocumentError(`${where}: a tap needs a mounted document`);
      }
      if (scene.poses.length > 0) {
        throw new FilmDocumentError(`${where}: a device pose needs a mounted document`);
      }
      if (scene.sets.length > 0 || scene.tweens.length > 0) {
        throw new FilmDocumentError(`${where}: a state write needs a mounted app to write into`);
      }
      if (scene.focus.length > 0) {
        throw new FilmDocumentError(`${where}: a spotlight needs a mounted document to measure its target in`);
      }
      if (scene.morph !== null) {
        throw new FilmDocumentError(`${where}: a morph needs a document to carry the component into`);
      }
      if (scene.frames.length > 0) {
        throw new FilmDocumentError(`${where}: a supporting frame supports a primary mount - the scene needs a document`);
      }
    }
    scenes.push(scene);
    cursorMs += forMs;
  }

  // the state journey compiles to the write law: one set per var, all on one frame -
  // "the interface updates the way the running product does" needs no new kernel machinery
  for (const row of pendingFrameStates) {
    if (!states.some((s) => s.name === row.name)) {
      throw new FilmDocumentError(`${row.where}: <frame state="${row.name}"> names no declared <state>`);
    }
  }
  // the scene-level mount resolves through the same closed set: a typo'd name silently
  // booting the document's sample state is the open joint the grammar refuses to have
  for (const [i, scene] of scenes.entries()) {
    if (scene.state !== "" && !states.some((s) => s.name === scene.state)) {
      throw new FilmDocumentError(`scene ${i + 1}: state="${scene.state}" names no declared <state>`);
    }
  }
  for (const row of pendingApplies) {
    const preset = states.find((s) => s.name === row.name);
    if (preset === undefined) {
      throw new FilmDocumentError(`${row.where}: <apply state="${row.name}"> names no declared <state>`);
    }
    if (row.scene.document === "") {
      throw new FilmDocumentError(`${row.where}: a state write needs a mounted app to write into`);
    }
    for (const [name, value] of Object.entries(preset.vars)) {
      row.scene.sets.push({ atMs: row.atMs, name, value });
    }
    for (const [name, value] of Object.entries(preset.globals)) {
      row.scene.sets.push({ atMs: row.atMs, name: `global.${name}`, value });
    }
  }

  const film: Film = { id, durationMs, fps, format, theme, scenes, states };
  return film;
}

export function loadFilmDocument(path: string): { film: Film; problems: FilmProblem[] } {
  const film = readFilmDocument(readFileSync(path, "utf8"));
  return { film, problems: validateFilm(film) };
}
