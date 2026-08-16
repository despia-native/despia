//
//  scene/sprite.ts - the DSX Scene 2D primitive (dsx-game.md G6), platform-neutral and
//  corpus-pinned (OpenSource/Conformance/scene/sprite.json — every law spelled out in
//  that file's _note and the corpus README "The 2D laws"). The shape:
//
//  - THE QUAD LAW: `<sprite src size position rotation scale color anchor flip>` is a
//    TEXTURED QUAD in the node's LOCAL XY plane facing +Z, riding the node's world
//    transform exactly like `<plane>`. In mode="2d" that IS camera-facing (the
//    orthographic camera looks down −Z); BILLBOARDING IN 3D IS A NAMED ABSENCE, so an
//    authored `rotation` keeps meaning what it means everywhere else.
//  - THE SIZE DEFAULT: unauthored, the quad is 1 unit TALL and as wide as the TEXTURE
//    ASPECT (1 when the texture is unknown or still loading — the honest square).
//  - THE ANCHOR LAW: `anchor` names WHICH POINT OF THE QUAD `position` names; the quad
//    CENTER sits at (−ax·w, −ay·h, 0) from the node origin.
//  - THE SHEET LAW: `frames` is "N" (a single row) or "cols rows" (2-D packed,
//    EXPLICIT — the kernel never guesses); frame n maps ROW-MAJOR to the UV rectangle
//    [col/cols, row/rows] … [(col+1)/cols, (row+1)/rows] with v0 the frame's TOP edge
//    (the P4 UV law verbatim). `flip` mirrors the rect.
//  - THE FPS LAW: a positive `fps` OWNS the index — advanced = floor(elapsed × fps),
//    wrapped by `loop` — and rides the SAME frame clock the on:frame budget rides,
//    never a second loop.
//  - THE 2D DRAW ORDER: z is the draw order; `sceneDrawOrder2d` sorts world z ASCENDING
//    (stable, document order breaking ties) and the renderers paint in that order with
//    depth testing OFF — higher z lands in front (the painter's algorithm).
//
//  This module owns the NUMBERS; the renderers own only the wiring.
//

import type { Vec3 } from "./math.ts";
import {
  SPRITE_ANCHORS, type SceneNodeProps,
} from "./ir.ts";

/** the unauthored quad height in scene units — the width follows the texture aspect */
export const SPRITE_DEFAULT_HEIGHT = 1;

/** the sprite quad's layout in the node's LOCAL frame */
export type SpriteQuad = {
  /** the quad CENTER's offset from the node origin (the anchor law) */
  center: Vec3;
  halfWidth: number;
  halfHeight: number;
  /** the frame's UV rectangle [u0, v0, u1, v1]; v0 is the frame's TOP edge */
  uv: [number, number, number, number];
};

/** THE SIZE LAW: an authored `size` wins; otherwise height = SPRITE_DEFAULT_HEIGHT and
 *  width = the texture aspect (image width / height) at that height, falling back to a
 *  square when the aspect is unknown, non-finite or non-positive. */
export function spriteSizeOf(
  props: SceneNodeProps, textureAspect?: number | null,
): [number, number] {
  if (props.spriteSizeAuthored) return [props.spriteSize[0], props.spriteSize[1]];
  const aspect = textureAspect === undefined || textureAspect === null ? 1 : textureAspect;
  const width = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return [width * SPRITE_DEFAULT_HEIGHT, SPRITE_DEFAULT_HEIGHT];
}

/** THE ANCHOR LAW: the quad CENTER offset from the node origin */
export function spriteAnchorOffset(props: SceneNodeProps, width: number, height: number): Vec3 {
  const anchor = SPRITE_ANCHORS.get(props.spriteAnchor) ?? [0, 0];
  return [-anchor[0]! * width, -anchor[1]! * height, 0];
}

/** the sheet's total cell count (cols · rows; 1 when no sheet is authored) */
export function spriteFrameCount(props: SceneNodeProps): number {
  return props.spriteFrames[0] * props.spriteFrames[1];
}

/** THE UV RECTANGLE LAW: frame n row-major over the [cols, rows] grid, `flip` swapping
 *  the u and/or v ends. The index arrives already floored + clamped (resolvedProps). */
export function spriteUvRect(
  props: SceneNodeProps, frame: number,
): [number, number, number, number] {
  const cols = props.spriteFrames[0];
  const rows = props.spriteFrames[1];
  const index = Math.min(Math.max(Math.floor(frame), 0), cols * rows - 1);
  const col = index % cols;
  const row = Math.floor(index / cols);
  let u0 = col / cols;
  let u1 = (col + 1) / cols;
  let v0 = row / rows;
  let v1 = (row + 1) / rows;
  if (props.spriteFlip.includes("x")) { const t = u0; u0 = u1; u1 = t; }
  if (props.spriteFlip.includes("y")) { const t = v0; v0 = v1; v1 = t; }
  return [u0, v0, u1, v1];
}

/** THE FPS LAW: a positive `fps` derives the index from the elapsed SECONDS on the
 *  shared frame clock — advanced = floor(elapsed × fps), wrapped (loop) or held
 *  (loop="false"); a non-positive elapsed reads frame 0. fps ≤ 0 (unauthored or
 *  malformed) hands back the authored/bound `frame` prop unchanged. */
export function spriteFrameAt(props: SceneNodeProps, elapsedSeconds: number): number {
  const total = spriteFrameCount(props);
  if (!(props.spriteFps > 0) || total <= 0) return props.spriteFrame;
  if (!(elapsedSeconds > 0) || !Number.isFinite(elapsedSeconds)) return 0;
  const advanced = Math.floor(elapsedSeconds * props.spriteFps);
  if (advanced <= 0) return 0;
  return props.spriteLoop ? advanced % total : Math.min(advanced, total - 1);
}

/** the whole layout in one call: size (texture-aspect aware) → anchor offset → UV rect */
export function spriteQuad(
  props: SceneNodeProps, textureAspect?: number | null, frame?: number,
): SpriteQuad {
  const [width, height] = spriteSizeOf(props, textureAspect);
  return {
    center: spriteAnchorOffset(props, width, height),
    halfWidth: width / 2,
    halfHeight: height / 2,
    uv: spriteUvRect(props, frame ?? props.spriteFrame),
  };
}

/** THE 2D DRAW-ORDER LAW: higher z draws IN FRONT, so painting runs world z ASCENDING
 *  with a STABLE sort — equal z keeps document order. Renderers walk this order with
 *  depth testing OFF (the painter's algorithm) inside `mode="2d"`. */
export function sceneDrawOrder2d(zs: readonly number[]): number[] {
  return zs.map((z, index) => ({ z, index }))
    .sort((a, b) => (a.z === b.z ? a.index - b.index : a.z - b.z))
    .map((entry) => entry.index);
}
