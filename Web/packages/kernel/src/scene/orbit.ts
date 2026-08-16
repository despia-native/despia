//
//  scene/orbit.ts - the `controls="orbit"` camera math (dsx-scene.md P5), corpus
//  OpenSource/Conformance/scene/orbit.json. Pointer drags orbit the camera on
//  spherical coordinates around the look-at point; wheel/pinch zooms the radius,
//  clamped to [near, far]. All math is platform-neutral and corpus-pinned; each
//  renderer wires its own pointer events.
//
//  THE SPHERICAL LAW: offset = position − lookAt; distance = |offset|;
//  pitch = asin(offset.y / distance) degrees; yaw = atan2(offset.x, offset.z) degrees
//  (yaw 0 = the camera on the +Z side, growing toward +X). The inverse:
//  position = lookAt + distance · (cosPitch·sinYaw, sinPitch, cosPitch·cosYaw).
//
//  THE DRAG LAW: yaw −= dx · 0.4°/px, pitch += dy · 0.4°/px, pitch clamped to ±89°
//  (dragging right orbits the camera left, so the SCENE appears to turn right — the
//  grab-the-object convention).
//  THE ZOOM LAW: distance ×= e^(deltaY · 0.0015), clamped to [max(near, 1e-3), far].
//

import type { Vec3 } from "./math.ts";

export const ORBIT_DEG_PER_PX = 0.4;
export const ORBIT_ZOOM_RATE = 0.0015;
export const ORBIT_PITCH_LIMIT_DEG = 89;

const DEG = Math.PI / 180;

export type OrbitState = { yawDeg: number; pitchDeg: number; distance: number };

/** derive the orbit state from the authored camera (a degenerate zero offset answers
 *  the default camera's pose: yaw 0, pitch 0, distance 5 — failure is a value) */
export function orbitFromCamera(position: Vec3, lookAt: Vec3): OrbitState {
  const offset: Vec3 = [position[0] - lookAt[0], position[1] - lookAt[1], position[2] - lookAt[2]];
  const distance = Math.hypot(...offset);
  if (distance === 0) return { yawDeg: 0, pitchDeg: 0, distance: 5 };
  return {
    yawDeg: Math.atan2(offset[0], offset[2]) / DEG,
    pitchDeg: Math.asin(Math.min(Math.max(offset[1] / distance, -1), 1)) / DEG,
    distance,
  };
}

/** the spherical inverse: the camera position for a state around lookAt */
export function orbitPosition(state: OrbitState, lookAt: Vec3): Vec3 {
  const pitch = state.pitchDeg * DEG;
  const yaw = state.yawDeg * DEG;
  const flat = state.distance * Math.cos(pitch);
  return [
    lookAt[0] + flat * Math.sin(yaw),
    lookAt[1] + state.distance * Math.sin(pitch),
    lookAt[2] + flat * Math.cos(yaw),
  ];
}

/** the drag law (see the header): dx/dy in CSS pixels */
export function orbitDrag(state: OrbitState, dxPx: number, dyPx: number): OrbitState {
  return {
    yawDeg: state.yawDeg - dxPx * ORBIT_DEG_PER_PX,
    pitchDeg: Math.min(Math.max(state.pitchDeg + dyPx * ORBIT_DEG_PER_PX, -ORBIT_PITCH_LIMIT_DEG), ORBIT_PITCH_LIMIT_DEG),
    distance: state.distance,
  };
}

/** the zoom law (see the header): positive deltaY zooms out, clamped [near, far] */
export function orbitZoom(state: OrbitState, deltaY: number, near: number, far: number): OrbitState {
  const lower = Math.max(near, 1e-3);
  const distance = Math.min(Math.max(state.distance * Math.exp(deltaY * ORBIT_ZOOM_RATE), lower), far);
  return { yawDeg: state.yawDeg, pitchDeg: state.pitchDeg, distance };
}
