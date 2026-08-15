//
//  scene/math.ts - the DSX Scene math kernel (dsx-scene.md P1): column-major mat4 +
//  vec3, zero dependencies, platform-neutral (no DOM, no WebGL — the corpus law in
//  OpenSource/Conformance/scene/README.md). Conventions: column vectors (v' = M·v);
//  local = T · Rz · Ry · Rx · S (scale, then rotate X→Y→Z in degrees, then translate);
//  right-handed lookAt view space; GL projection with NDC z ∈ [-1, 1]. The Kotlin and
//  Swift twins (dsx-scene.md P2) must reproduce these numbers against the same corpus.
//

/** 16 numbers, column-major (index = column*4 + row) */
export type Mat4 = number[];
export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;

export function mat4Identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** out = a · b (apply b first, then a — the matrix composition convention) */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function mat4Scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

export function mat4RotationX(degrees: number): Mat4 {
  const c = Math.cos(degrees * DEG), s = Math.sin(degrees * DEG);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export function mat4RotationY(degrees: number): Mat4 {
  const c = Math.cos(degrees * DEG), s = Math.sin(degrees * DEG);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

export function mat4RotationZ(degrees: number): Mat4 {
  const c = Math.cos(degrees * DEG), s = Math.sin(degrees * DEG);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** the corpus rotation law: X applies to the object first, then Y, then Z — Rz·Ry·Rx */
export function mat4RotationXYZ(rx: number, ry: number, rz: number): Mat4 {
  return mat4Multiply(mat4Multiply(mat4RotationZ(rz), mat4RotationY(ry)), mat4RotationX(rx));
}

/** the node-local TRS: local = T · R · S (scale, then rotate, then translate) */
export function mat4Trs(position: Vec3, rotationDeg: Vec3, scale: Vec3): Mat4 {
  return mat4Multiply(
    mat4Multiply(mat4Translation(...position), mat4RotationXYZ(...rotationDeg)),
    mat4Scaling(...scale),
  );
}

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l === 0 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
}
export const vec3 = { sub, dot, cross, normalize } as const;

/** right-handed lookAt (gluLookAt). A degenerate up (looking straight along ±Y with
 *  up = +Y) swaps to +Z rather than producing NaNs — failure is a value. */
export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const f = normalize(sub(target, eye));
  let s = cross(f, up);
  if (Math.hypot(s[0], s[1], s[2]) < 1e-9) s = cross(f, [0, 0, 1]);
  s = normalize(s);
  const u = cross(s, f);
  return [
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ];
}

/** GL perspective: fovY in degrees, NDC z ∈ [-1, 1] */
export function mat4Perspective(fovYDeg: number, aspect: number, near: number, far: number): Mat4 {
  const t = 1 / Math.tan(fovYDeg * DEG / 2);
  return [
    t / aspect, 0, 0, 0,
    0, t, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, 2 * far * near / (near - far), 0,
  ];
}

/** the mode="2d" camera: halfHeight is the vertical HALF-extent (`size`), centered */
export function mat4Orthographic(halfHeight: number, aspect: number, near: number, far: number): Mat4 {
  const r = halfHeight * aspect;
  return [
    1 / r, 0, 0, 0,
    0, 1 / halfHeight, 0, 0,
    0, 0, -2 / (far - near), 0,
    0, 0, -(far + near) / (far - near), 1,
  ];
}

/** transform a point (w = 1) and divide by the resulting w */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  const d = w === 0 ? 1 : w;
  return [
    (m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!) / d,
    (m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!) / d,
    (m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!) / d,
  ];
}

/** world → NDC through a projection·view pair (the projection corpus contract) */
export function projectToNdc(proj: Mat4, view: Mat4, world: Vec3): Vec3 {
  return transformPoint(mat4Multiply(proj, view), world);
}

/** general 4×4 inverse (cofactor expansion); null for a singular matrix — the picking
 *  unproject fails closed instead of dividing by zero */
export function mat4Invert(m: Mat4): Mat4 | null {
  const inv = new Array<number>(16);
  inv[0] = m[5]! * m[10]! * m[15]! - m[5]! * m[11]! * m[14]! - m[9]! * m[6]! * m[15]!
    + m[9]! * m[7]! * m[14]! + m[13]! * m[6]! * m[11]! - m[13]! * m[7]! * m[10]!;
  inv[4] = -m[4]! * m[10]! * m[15]! + m[4]! * m[11]! * m[14]! + m[8]! * m[6]! * m[15]!
    - m[8]! * m[7]! * m[14]! - m[12]! * m[6]! * m[11]! + m[12]! * m[7]! * m[10]!;
  inv[8] = m[4]! * m[9]! * m[15]! - m[4]! * m[11]! * m[13]! - m[8]! * m[5]! * m[15]!
    + m[8]! * m[7]! * m[13]! + m[12]! * m[5]! * m[11]! - m[12]! * m[7]! * m[9]!;
  inv[12] = -m[4]! * m[9]! * m[14]! + m[4]! * m[10]! * m[13]! + m[8]! * m[5]! * m[14]!
    - m[8]! * m[6]! * m[13]! - m[12]! * m[5]! * m[10]! + m[12]! * m[6]! * m[9]!;
  inv[1] = -m[1]! * m[10]! * m[15]! + m[1]! * m[11]! * m[14]! + m[9]! * m[2]! * m[15]!
    - m[9]! * m[3]! * m[14]! - m[13]! * m[2]! * m[11]! + m[13]! * m[3]! * m[10]!;
  inv[5] = m[0]! * m[10]! * m[15]! - m[0]! * m[11]! * m[14]! - m[8]! * m[2]! * m[15]!
    + m[8]! * m[3]! * m[14]! + m[12]! * m[2]! * m[11]! - m[12]! * m[3]! * m[10]!;
  inv[9] = -m[0]! * m[9]! * m[15]! + m[0]! * m[11]! * m[13]! + m[8]! * m[1]! * m[15]!
    - m[8]! * m[3]! * m[13]! - m[12]! * m[1]! * m[11]! + m[12]! * m[3]! * m[9]!;
  inv[13] = m[0]! * m[9]! * m[14]! - m[0]! * m[10]! * m[13]! - m[8]! * m[1]! * m[14]!
    + m[8]! * m[2]! * m[13]! + m[12]! * m[1]! * m[10]! - m[12]! * m[2]! * m[9]!;
  inv[2] = m[1]! * m[6]! * m[15]! - m[1]! * m[7]! * m[14]! - m[5]! * m[2]! * m[15]!
    + m[5]! * m[3]! * m[14]! + m[13]! * m[2]! * m[7]! - m[13]! * m[3]! * m[6]!;
  inv[6] = -m[0]! * m[6]! * m[15]! + m[0]! * m[7]! * m[14]! + m[4]! * m[2]! * m[15]!
    - m[4]! * m[3]! * m[14]! - m[12]! * m[2]! * m[7]! + m[12]! * m[3]! * m[6]!;
  inv[10] = m[0]! * m[5]! * m[15]! - m[0]! * m[7]! * m[13]! - m[4]! * m[1]! * m[15]!
    + m[4]! * m[3]! * m[13]! + m[12]! * m[1]! * m[7]! - m[12]! * m[3]! * m[5]!;
  inv[14] = -m[0]! * m[5]! * m[14]! + m[0]! * m[6]! * m[13]! + m[4]! * m[1]! * m[14]!
    - m[4]! * m[2]! * m[13]! - m[12]! * m[1]! * m[6]! + m[12]! * m[2]! * m[5]!;
  inv[3] = -m[1]! * m[6]! * m[11]! + m[1]! * m[7]! * m[10]! + m[5]! * m[2]! * m[11]!
    - m[5]! * m[3]! * m[10]! - m[9]! * m[2]! * m[7]! + m[9]! * m[3]! * m[6]!;
  inv[7] = m[0]! * m[6]! * m[11]! - m[0]! * m[7]! * m[10]! - m[4]! * m[2]! * m[11]!
    + m[4]! * m[3]! * m[10]! + m[8]! * m[2]! * m[7]! - m[8]! * m[3]! * m[6]!;
  inv[11] = -m[0]! * m[5]! * m[11]! + m[0]! * m[7]! * m[9]! + m[4]! * m[1]! * m[11]!
    - m[4]! * m[3]! * m[9]! - m[8]! * m[1]! * m[7]! + m[8]! * m[3]! * m[5]!;
  inv[15] = m[0]! * m[5]! * m[10]! - m[0]! * m[6]! * m[9]! - m[4]! * m[1]! * m[10]!
    + m[4]! * m[2]! * m[9]! + m[8]! * m[1]! * m[6]! - m[8]! * m[2]! * m[5]!;
  const det = m[0]! * inv[0]! + m[1]! * inv[4]! + m[2]! * inv[8]! + m[3]! * inv[12]!;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return inv.map((v) => v / det);
}

/** the picking ray (v0): unproject an NDC point (x, y ∈ [-1, 1]) through the camera's
 *  proj·view into a world-space origin + unit direction. Null when the pair is singular. */
export function pickRay(proj: Mat4, view: Mat4, ndcX: number, ndcY: number):
  { origin: Vec3; dir: Vec3 } | null {
  const inverse = mat4Invert(mat4Multiply(proj, view));
  if (inverse === null) return null;
  const near = transformPoint(inverse, [ndcX, ndcY, -1]);
  const far = transformPoint(inverse, [ndcX, ndcY, 1]);
  const dir = normalize(sub(far, near));
  return { origin: near, dir };
}

/** ray ∩ sphere — the v0 picking primitive: the smallest non-negative hit distance,
 *  or null for a miss (dsx-scene.md: unproject against each node's bounding sphere) */
export function raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number): number | null {
  const oc = sub(origin, center);
  const b = dot(oc, dir);
  const c = dot(oc, oc) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t0 = -b - root;
  if (t0 >= 0) return t0;
  const t1 = -b + root;
  return t1 >= 0 ? t1 : null;
}
