//
//  review.ts — `despia review`: the DESIGN lint. `lint` decides whether markup is legal;
//  this decides whether a screen clears the objective floor of the design bar
//  (OpenSource/Skills/designing-an-app.md). Same severity ladder, same output shape, same
//  strictness contract as lint, so an agent that already closes the lint loop closes this
//  one with no new protocol.
//
//  ONLY OBJECTIVE CHECKS LIVE HERE. Taste ("too many accent uses", "this spacing feels
//  cramped") is judgement, and a judgement encoded as a threshold is a false-positive
//  factory somebody tunes until it stops firing. The five rules below are the ones with a
//  yes/no answer a reviewer would never argue with:
//
//    R1  an icon-only button with no accessible name        (error   — designing-an-app §7)
//    R2  a tappable sized under the 44pt floor              (warning — designing-an-app §7)
//    R3  a text fontSize off the type scale                 (warning — designing-an-app §3)
//    R4  three or more distinct raw hex colors in one file  (warning — designing-an-app §2)
//    R5  a data-bound screen with no conditional branch     (notice  — designing-an-app §5)
//    R6  hex text on a hex ground below the WCAG floor      (warning — designing-an-app §2)
//    R7  a tappable row of several texts, never grouped     (warning — designing-an-app §7)
//    R8  an on:drag control with no on:adjust               (warning — designing-an-app §7)
//
//  Static literals only: an interpolated `{{ … }}` value is unknowable here and is skipped,
//  never guessed at. R5 is a notice because "the states live on another screen" is a real
//  architecture; a notice informs and never fails a build. R6 judges only hex-on-hex pairs:
//  semantic tokens meet the floor by construction, and every hex pair the author invents,
//  the author owns. R7 stands down when the subtree mounts a component (its markup is not
//  in this file to judge).
//

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseDsx, DsxParseError, type XmlNode } from "@despia-native/compiler";

import type { Finding } from "./lint.ts";
import { formatFinding, tally } from "./lint.ts";
import { loadConfig, findProjectRoot, packageRoots, componentFiles, ConfigError, CONFIG_FILENAME } from "./config.ts";
import { lintAppSource, lintAppBudget } from "./studio-apps/applint.ts";
import type { Io } from "./cli.ts";

/** The type scale (designing-an-app.md §3): the iOS ramp plus the named-style sizes. */
export const TYPE_SCALE: ReadonlySet<number> = new Set([11, 12, 13, 15, 16, 17, 20, 22, 24, 28, 34]);

/** Tags whose tap is a press by construction; any other element becomes tappable via on:tap. */
const TAPPABLE_TAGS: ReadonlySet<string> = new Set(["button", "pressable", "row"]);

/** Attributes whose value is a color (the hex-habit scan reads these). */
const COLOR_ATTRS = ["color", "background", "tint"] as const;

const HEX_LITERAL = /#[0-9a-fA-F]{6,8}\b/g;

function interpolated(value: string): boolean {
  return value.includes("{{");
}

function numericLiteral(value: string | undefined): number | null {
  if (value === undefined || interpolated(value)) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function lineOf(raw: string, offset: number | undefined): number {
  if (offset === undefined) return 1;
  let line = 1;
  for (let i = 0; i < offset && i < raw.length; i++) if (raw.charCodeAt(i) === 10) line += 1;
  return line;
}

/** WCAG relative luminance of a 6/8-digit hex (8-digit is AARRGGBB; alpha ignored — a
 *  translucent ground blends with what is under it, which static analysis cannot know,
 *  so the check reads the stated color and the author owns the blend). */
function luminance(hex: string): number {
  const digits = hex.replace("#", "");
  const rgb = digits.length === 8 ? digits.substring(2) : digits;
  const channel = (i: number): number => {
    const v = parseInt(rgb.substring(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function staticHex(value: string | undefined): string | null {
  if (value === undefined || interpolated(value)) return null;
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/** WCAG "large text": at or past 20 on the scale, or bold at 15+. */
function largeType(attrs: { [k: string]: string }): boolean {
  const size = numericLiteral(attrs["fontSize"]);
  if (size === null) return false;
  return size >= 20 || (size >= 15 && attrs["fontWeight"] === "bold");
}

/** Drawing surfaces own their pointer events; on:drag there is not a value control. */
const DRAG_EXEMPT_TAGS: ReadonlySet<string> = new Set(["canvas", "ink", "Signature"]);

const CONTAINER_TAGS: ReadonlySet<string> = new Set(["stack", "vstack", "hstack", "zstack"]);

/** R7's subtree read: texts counted, grouping honored, components = unknowable. */
function groupable(node: XmlNode): { texts: number; grouped: boolean; unknowable: boolean } {
  let texts = 0;
  let grouped = false;
  let unknowable = false;
  const walk = (n: XmlNode): void => {
    if ((n.attrs["a11yGroup"] ?? "") === "true" || n.attrs["role"] === "group") grouped = true;
    if (n.tag === "text") texts += 1;
    if (/^[A-Z]/.test(n.tag)) unknowable = true;
    for (const child of n.children) walk(child);
  };
  walk(node);
  return { texts, grouped, unknowable };
}

/** Review one document. Pure: same bytes in, same findings out. */
export function reviewSource(file: string, raw: string): Finding[] {
  const findings: Finding[] = [];
  let root: XmlNode;
  try {
    root = parseDsx(raw);
  } catch (e) {
    if (e instanceof DsxParseError) {
      // lint owns parse errors; review only says why it cannot review.
      return [{ file, line: 1, level: "notice", message: `not reviewed: ${e.message}` }];
    }
    throw e;
  }

  const hexes = new Map<string, { line: number }>();
  let boundData = false;
  let hasBranch = false;

  const walk = (node: XmlNode, inHead: boolean, ground: string | null): void => {
    const line = lineOf(raw, node.span?.start);
    const attrs = node.attrs;
    const head = inHead || node.tag === "head";
    // the effective STATIC ground: a hex background sets it, any other background
    // (token, interpolated) makes it unknown, no background inherits
    const nextGround = attrs["background"] === undefined ? ground : staticHex(attrs["background"]);

    if (!head) {
      // R1 — an icon-only button with no accessible name reads as "button" and nothing else.
      if (node.tag === "button" && (attrs["icon"] ?? "") !== "" && (attrs["label"] ?? "") === ""
        && (attrs["a11yLabel"] ?? "") === "" && (attrs["aria-label"] ?? "") === "") {
        findings.push({ file, line, level: "error", message: `<button icon="${attrs["icon"]}">: icon-only button with no accessible name — add a11yLabel (designing-an-app.md §7)` });
      }

      // R2 — an explicit size under the 44pt floor on something tappable.
      if (TAPPABLE_TAGS.has(node.tag) || attrs["on:tap"] !== undefined) {
        for (const dimension of ["width", "height"] as const) {
          const n = numericLiteral(attrs[dimension]);
          if (n !== null && n < 44) {
            findings.push({ file, line, level: "warning", message: `<${node.tag} ${dimension}="${attrs[dimension]}">: tappable sized under the 44pt floor (designing-an-app.md §7)` });
          }
        }
      }

      // R5 inputs — a bound collection means this screen renders data.
      if ((node.tag === "list" || node.tag === "grid") && (attrs["bind"] ?? "").length > 0) boundData = true;
      if (attrs["visible-if"] !== undefined) hasBranch = true;

      // R6 — a hex ink on a hex ground the author invented, below the WCAG floor.
      if (node.tag === "text") {
        const ink = staticHex(attrs["color"]);
        const on = staticHex(attrs["background"]) ?? ground;
        if (ink !== null && on !== null) {
          const floor = largeType(attrs) ? 3 : 4.5;
          const ratio = contrastRatio(ink, on);
          if (ratio < floor) {
            findings.push({ file, line, level: "warning", message: `<text color="${attrs["color"]}"> on ${on}: contrast ${ratio.toFixed(2)}:1 is under the ${floor}:1 floor (designing-an-app.md §2)` });
          }
        }
      }

      // R7 — a tappable built from several texts reads as fragments without a11yGroup.
      const tappableContainer = node.tag === "pressable" || node.tag === "row"
        || (CONTAINER_TAGS.has(node.tag) && attrs["on:tap"] !== undefined);
      if (tappableContainer) {
        const read = groupable(node);
        if (!read.grouped && !read.unknowable && read.texts >= 2) {
          findings.push({ file, line, level: "warning", message: `<${node.tag}> tappable with ${read.texts} texts and no a11yGroup — it reads as fragments, one per swipe (designing-an-app.md §7)` });
        }
      }

      // R8 — a custom drag control VoiceOver cannot adjust.
      if ((attrs["on:drag"] !== undefined || attrs["on:dragEnd"] !== undefined)
        && attrs["on:adjust"] === undefined && !DRAG_EXEMPT_TAGS.has(node.tag)) {
        findings.push({ file, line, level: "warning", message: `<${node.tag} on:drag>: a custom drag control without on:adjust is invisible to assistive swipe gestures — pair it with a11yValue (designing-an-app.md §7)` });
      }
    }

    // R3 — off-scale text size. Applies to <text> in the body and to <style as=> head
    // declarations, because a class is the shared spelling of the same decision.
    if (node.tag === "text" || (node.tag === "style" && head)) {
      const n = numericLiteral(attrs["fontSize"]);
      if (n !== null && !TYPE_SCALE.has(n)) {
        const scale = [...TYPE_SCALE].sort((a, b) => a - b);
        const nearest = scale.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), scale[0]!);
        findings.push({ file, line, level: "warning", message: `<${node.tag} fontSize="${attrs["fontSize"]}">: off the type scale (${scale.join(" ")}) — nearest is ${nearest} (designing-an-app.md §3)` });
      }
    }

    // R4 inputs — every static hex in a color attribute, first sighting wins the line.
    for (const attr of COLOR_ATTRS) {
      const value = attrs[attr];
      if (value === undefined || interpolated(value)) continue;
      for (const match of value.matchAll(HEX_LITERAL)) {
        const hex = match[0]!.toLowerCase();
        if (!hexes.has(hex)) hexes.set(hex, { line });
      }
    }

    for (const child of node.children) walk(child, head, nextGround);
  };
  walk(root, false, null);

  if (hexes.size >= 3) {
    const list = [...hexes.keys()].join(" ");
    const first = Math.min(...[...hexes.values()].map((h) => h.line));
    findings.push({ file, line: first, level: "warning", message: `${hexes.size} distinct raw hex colors (${list}) — semantic tokens adapt to light/dark for free; hex is for brand moments (designing-an-app.md §2)` });
  }

  if (boundData && !hasBranch) {
    findings.push({ file, line: 1, level: "notice", message: "a data-bound screen with no conditional branch — screens with data usually need loading, empty and error states (designing-an-app.md §5)" });
  }

  return findings.sort((a, b) => a.line - b.line);
}

/** The `despia review` command: same discovery, output and exit contract as `despia lint`. */
export function commandReview(flags: { [k: string]: string | boolean }, positional: string[], io: Io): number {
  const strict = flags["strict"] === true;
  const app = flags["app"] === true;
  const cwd = process.cwd();
  const explicitFiles = positional.map((f) => resolve(cwd, f));

  // --app reviews an APP PACKAGE (studio-apps.md §13): the root is a dir with a dsx.json,
  // not necessarily a project, and the app-lint tier (token-only colour, the remote-literal
  // ban, the byte budget) runs BESIDE the design floor over its whole authored surface.
  if (app) {
    const root = typeof flags["project"] === "string" ? resolve(cwd, flags["project"]) : cwd;
    if (!existsSync(join(root, "dsx.json"))) {
      throw new ConfigError(`despia review --app: ${root} has no dsx.json — point --project at the app package.`);
    }
    const surface = appSurfaceFiles(root);
    const findings: Finding[] = [];
    for (const { file, kind } of surface) {
      const source = readFileSync(file, "utf8");
      if (kind === "dsx") findings.push(...reviewSource(file, source));
      findings.push(...lintAppSource(file, source, kind));
    }
    findings.push(...lintAppBudget(surface.map(({ file }) => ({ file, bytes: statSync(file).size }))));
    for (const finding of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) io.out(formatFinding(finding));
    const counts = tally(findings);
    io.out(`despia review --app: ${surface.length} files · ${counts.errors} errors · ${counts.warnings} warnings · ${counts.notices} notices`);
    return counts.errors > 0 || (strict && counts.warnings > 0) ? 1 : 0;
  }

  let files: string[];
  if (explicitFiles.length > 0) {
    files = explicitFiles;
  } else {
    const projectRoot = typeof flags["project"] === "string" ? resolve(cwd, flags["project"]) : findProjectRoot(cwd);
    if (projectRoot === null) {
      throw new ConfigError(
        `no ${CONFIG_FILENAME} found in ${cwd} or any parent, and no files were named — ` +
        "run `despia review <file.dsx> …` or stand in a project.",
      );
    }
    files = packageRoots(loadConfig(projectRoot)).flatMap((root) => componentFiles(root));
  }

  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    if (!existsSync(file)) { io.err(`despia review: no such file: ${file}`); return 1; }
    findings.push(...reviewSource(file, readFileSync(file, "utf8")));
  }
  for (const finding of findings) io.out(formatFinding(finding));
  const counts = tally(findings);
  io.out(`despia review: ${files.length} files · ${counts.errors} errors · ${counts.warnings} warnings · ${counts.notices} notices`);
  return counts.errors > 0 || (strict && counts.warnings > 0) ? 1 : 0;
}

/** The app's authored surface: its markup, its sheets, its web facet — the bytes the
 *  sub-registry compiles and the shelf reviews. */
function appSurfaceFiles(root: string): Array<{ file: string; kind: "dsx" | "css" | "js" }> {
  const out: Array<{ file: string; kind: "dsx" | "css" | "js" }> = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules" && name !== ".git" && name !== "vendor") walk(full);
      } else if (name.endsWith(".dsx")) out.push({ file: full, kind: "dsx" });
      else if (name.endsWith(".css")) out.push({ file: full, kind: "css" });
      else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push({ file: full, kind: "js" });
    }
  };
  walk(root);
  return out;
}
