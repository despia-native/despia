//
//  canvas-core.ts - the shared `<canvas>` core: the SVG path-data parser, the 2-D
//  transform plane, fill-rule resolution, gradient normalisation, the tier-1 display
//  list (+ its keyed diff and SVG serialisation), the tier-2 command recorder, the
//  `on:frame` schedule and the accessibility fold. The law is the corpus,
//  OpenSource/Conformance/canvas/ (parity/U04-canvas.md); the Kotlin twin is :core
//  CanvasCore.kt and the Swift twin is Engine/iOS/CanvasCore.swift.
//
//  WHY THIS IS A SHARED CORE AND NOT THREE RASTERISERS. Three rasterisers will never be
//  bit-identical, so the determinism split is deliberate: PIXELS are toleranced and belong
//  to the platform (GraphicsContext / DrawScope / canvas 2D), GEOMETRY is exact and lives
//  here. A path's normalized segment list, a transform's composed matrix, a gradient's
//  stop offsets, a display list's keys and diff, a tier-2 command stream and the frame
//  budget are all pure data folds, and a renderer that disagrees with one of them draws a
//  different picture no tolerance can excuse.
//

// ── numbers ──────────────────────────────────────────────────────────────────────────

/** the affine six: x' = a·x + c·y + e, y' = b·x + d·y + f (the SVG / Canvas2D spelling,
 *  never the scene kernel's column-major mat4 — a 2-D canvas has no third axis and
 *  borrowing the 3-D shape would invite silent index drift) */
export type CanvasMatrix = readonly [number, number, number, number, number, number];

export const CANVAS_IDENTITY: CanvasMatrix = [1, 0, 0, 1, 0, 0];

/** world = parentWorld · local, the same fold the scene kernel uses one dimension up */
export function canvasMatMul(a: CanvasMatrix, b: CanvasMatrix): CanvasMatrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function canvasApply(m: CanvasMatrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function canvasMatrixIsIdentity(m: CanvasMatrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

const DEG = Math.PI / 180;

function num(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

// ── path data (`d`) ──────────────────────────────────────────────────────────────────

/** one normalized ABSOLUTE segment. Every authored command folds to M / L / C / Q / Z:
 *  H and V become L, S and T resolve their reflected control point, and an elliptical
 *  arc becomes 1..4 cubics. */
export type CanvasSegment =
  | readonly ["M", number, number]
  | readonly ["L", number, number]
  | readonly ["Q", number, number, number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];

export type CanvasPathParse = { segments: CanvasSegment[]; diagnostics: string[] };

const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";

class PathScanner {
  private i = 0;
  private readonly s: string;

  constructor(source: string) {
    this.s = source;
  }

  private isSep(c: string): boolean {
    return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === ",";
  }

  skipSep(): void {
    while (this.i < this.s.length && this.isSep(this.s[this.i]!)) this.i += 1;
  }

  atEnd(): boolean {
    this.skipSep();
    return this.i >= this.s.length;
  }

  peek(): string {
    return this.s[this.i] ?? "";
  }

  advance(): void {
    this.i += 1;
  }

  /** the SVG number grammar: sign, digit runs, a bare leading '.', and exponents.
   *  '.5.5' is deliberately TWO numbers — a second '.' terminates the first. */
  number(): number | null {
    this.skipSep();
    const start = this.i;
    if (this.peek() === "+" || this.peek() === "-") this.i += 1;
    let digits = 0;
    while (this.i < this.s.length && this.s[this.i]! >= "0" && this.s[this.i]! <= "9") {
      this.i += 1;
      digits += 1;
    }
    if (this.peek() === ".") {
      this.i += 1;
      while (this.i < this.s.length && this.s[this.i]! >= "0" && this.s[this.i]! <= "9") {
        this.i += 1;
        digits += 1;
      }
    }
    if (digits === 0) {
      this.i = start;
      return null;
    }
    const e = this.peek();
    if (e === "e" || e === "E") {
      const mark = this.i;
      this.i += 1;
      if (this.peek() === "+" || this.peek() === "-") this.i += 1;
      let expDigits = 0;
      while (this.i < this.s.length && this.s[this.i]! >= "0" && this.s[this.i]! <= "9") {
        this.i += 1;
        expDigits += 1;
      }
      if (expDigits === 0) this.i = mark;
    }
    const value = Number(this.s.slice(start, this.i));
    if (!Number.isFinite(value)) {
      this.i = start;
      return null;
    }
    return value;
  }

  /** the two arc flags are SINGLE characters, so `a5 5 0 0110 0` is fa=0 fs=1 x=10 y=0 */
  flag(): number | null {
    this.skipSep();
    const c = this.peek();
    if (c === "0" || c === "1") {
      this.i += 1;
      return c === "1" ? 1 : 0;
    }
    return null;
  }
}

/** k for a cubic approximating a δ-radian elliptical sweep */
function arcK(delta: number): number {
  return (4 / 3) * Math.tan(delta / 4);
}

/** centre parameterisation → 1..4 cubics, split at ceil(|Δθ| / 90°) */
function arcCentreToCubics(
  cx: number, cy: number, rx: number, ry: number, phi: number,
  theta1: number, dtheta: number,
): CanvasSegment[] {
  const out: CanvasSegment[] = [];
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const point = (t: number): [number, number] => {
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    return [cx + cosPhi * x - sinPhi * y, cy + sinPhi * x + cosPhi * y];
  };
  const deriv = (t: number): [number, number] => {
    const x = -rx * Math.sin(t);
    const y = ry * Math.cos(t);
    return [cosPhi * x - sinPhi * y, sinPhi * x + cosPhi * y];
  };
  const count = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2) - 1e-9));
  const step = dtheta / count;
  const k = arcK(step);
  for (let i = 0; i < count; i += 1) {
    const t1 = theta1 + step * i;
    const t2 = t1 + step;
    const p1 = point(t1);
    const p2 = point(t2);
    const d1 = deriv(t1);
    const d2 = deriv(t2);
    out.push(["C",
      p1[0] + k * d1[0], p1[1] + k * d1[1],
      p2[0] - k * d2[0], p2[1] - k * d2[1],
      p2[0], p2[1],
    ]);
  }
  return out;
}

/** the F.6.5 endpoint→centre conversion plus the F.6.6 corrections: rx = |rx|, ry = |ry|;
 *  identical endpoints emit NOTHING; a zero radius degenerates to a line; radii too small
 *  are scaled by sqrt(Λ). */
export function canvasArcToCubics(
  x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number,
  largeArc: number, sweep: number, x2: number, y2: number,
): CanvasSegment[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [["L", x2, y2]];
  const phi = ((phiDeg % 360) + 360) % 360 * DEG;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const numerator = Math.max(0, rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p);
  const denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const coefficient = denominator === 0 ? 0 : Math.sqrt(numerator / denominator);
  const sign = largeArc === sweep ? -1 : 1;
  const cxp = sign * coefficient * ((rx * y1p) / ry);
  const cyp = sign * coefficient * (-(ry * x1p) / rx);
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  const theta2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
  let dtheta = theta2 - theta1;
  if (sweep === 0 && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep === 1 && dtheta < 0) dtheta += 2 * Math.PI;
  return arcCentreToCubics(cx, cy, rx, ry, phi, theta1, dtheta);
}

/**
 * The SVG path-data mini-language → the normalized ABSOLUTE segment list.
 *
 * ARTICLE 7: a malformed token STOPS the parse, keeps every segment already produced and
 * emits exactly ONE diagnostic — never a crash, never a partial number.
 */
export function parseCanvasPath(d: string | null | undefined): CanvasPathParse {
  const segments: CanvasSegment[] = [];
  const diagnostics: string[] = [];
  const source = typeof d === "string" ? d : "";
  const scan = new PathScanner(source);
  let cmd: string | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let reopen = false;

  const bad = (message: string): void => {
    diagnostics.push(message);
  };
  const openIfNeeded = (): void => {
    if (!reopen) return;
    segments.push(["M", cx, cy]);
    reopen = false;
  };

  while (!scan.atEnd()) {
    const head = scan.peek();
    if (/[A-Za-z]/.test(head)) {
      if (!COMMANDS.includes(head)) {
        bad(`canvas.path: unknown command '${head}'`);
        break;
      }
      cmd = head;
      scan.advance();
    } else {
      if (cmd === null) {
        bad("canvas.path: data does not start with a command");
        break;
      }
      if (cmd === "M") cmd = "L";
      else if (cmd === "m") cmd = "l";
      else if (cmd === "Z" || cmd === "z") {
        bad("canvas.path: an argument after closepath");
        break;
      }
    }

    const rel = cmd === cmd!.toLowerCase();
    const upper = cmd!.toUpperCase();
    let failed = false;
    const need = (): number => {
      const v = scan.number();
      if (v === null) {
        failed = true;
        return 0;
      }
      return v;
    };

    if (upper === "Z") {
      segments.push(["Z"]);
      cx = sx;
      cy = sy;
      lastCubic = null;
      lastQuad = null;
      reopen = true;
    } else if (upper === "M") {
      const x = need();
      const y = need();
      if (failed) { bad("canvas.path: truncated moveto"); break; }
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      sx = cx;
      sy = cy;
      segments.push(["M", cx, cy]);
      lastCubic = null;
      lastQuad = null;
      reopen = false;
    } else if (upper === "L") {
      const x = need();
      const y = need();
      if (failed) { bad("canvas.path: truncated lineto"); break; }
      openIfNeeded();
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      segments.push(["L", cx, cy]);
      lastCubic = null;
      lastQuad = null;
    } else if (upper === "H") {
      const x = need();
      if (failed) { bad("canvas.path: truncated horizontal lineto"); break; }
      openIfNeeded();
      cx = rel ? cx + x : x;
      segments.push(["L", cx, cy]);
      lastCubic = null;
      lastQuad = null;
    } else if (upper === "V") {
      const y = need();
      if (failed) { bad("canvas.path: truncated vertical lineto"); break; }
      openIfNeeded();
      cy = rel ? cy + y : y;
      segments.push(["L", cx, cy]);
      lastCubic = null;
      lastQuad = null;
    } else if (upper === "C" || upper === "S") {
      let c1x: number;
      let c1y: number;
      if (upper === "S") {
        const reflected = lastCubic ?? [cx, cy];
        c1x = 2 * cx - reflected[0];
        c1y = 2 * cy - reflected[1];
      } else {
        c1x = need();
        c1y = need();
        if (!failed) { c1x = rel ? cx + c1x : c1x; c1y = rel ? cy + c1y : c1y; }
      }
      let c2x = need();
      let c2y = need();
      let x = need();
      let y = need();
      if (failed) { bad("canvas.path: truncated cubic"); break; }
      c2x = rel ? cx + c2x : c2x;
      c2y = rel ? cy + c2y : c2y;
      x = rel ? cx + x : x;
      y = rel ? cy + y : y;
      openIfNeeded();
      segments.push(["C", c1x, c1y, c2x, c2y, x, y]);
      cx = x;
      cy = y;
      lastCubic = [c2x, c2y];
      lastQuad = null;
    } else if (upper === "Q" || upper === "T") {
      let qx: number;
      let qy: number;
      if (upper === "T") {
        const reflected = lastQuad ?? [cx, cy];
        qx = 2 * cx - reflected[0];
        qy = 2 * cy - reflected[1];
      } else {
        qx = need();
        qy = need();
        if (!failed) { qx = rel ? cx + qx : qx; qy = rel ? cy + qy : qy; }
      }
      let x = need();
      let y = need();
      if (failed) { bad("canvas.path: truncated quadratic"); break; }
      x = rel ? cx + x : x;
      y = rel ? cy + y : y;
      openIfNeeded();
      segments.push(["Q", qx, qy, x, y]);
      cx = x;
      cy = y;
      lastQuad = [qx, qy];
      lastCubic = null;
    } else if (upper === "A") {
      const rx = need();
      const ry = need();
      const rot = need();
      const fa = scan.flag();
      const fs = scan.flag();
      if (fa === null || fs === null) failed = true;
      let x = need();
      let y = need();
      if (failed) { bad("canvas.path: truncated arc"); break; }
      x = rel ? cx + x : x;
      y = rel ? cy + y : y;
      const cubics = canvasArcToCubics(cx, cy, rx, ry, rot, fa!, fs!, x, y);
      if (cubics.length > 0) {
        openIfNeeded();
        for (const seg of cubics) segments.push(seg);
        cx = x;
        cy = y;
      }
      lastCubic = null;
      lastQuad = null;
    }
  }
  return { segments, diagnostics };
}

// ── bounding box (TIGHT: curve extrema solved analytically) ──────────────────────────

export type CanvasBBox = readonly [number, number, number, number];

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function quadAt(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** the TIGHT bounding box — the geometry half of the determinism split, exact on every
 *  renderer. null for an empty path. */
export function canvasPathBBox(segments: readonly CanvasSegment[]): CanvasBBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const hit = (x: number, y: number): void => {
    seen = true;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const seg of segments) {
    if (seg[0] === "M") {
      cx = seg[1]; cy = seg[2]; sx = cx; sy = cy; hit(cx, cy);
    } else if (seg[0] === "L") {
      cx = seg[1]; cy = seg[2]; hit(cx, cy);
    } else if (seg[0] === "Q") {
      hit(seg[3], seg[4]);
      for (const [p0, p1, p2, axis] of [
        [cx, seg[1], seg[3], 0] as const, [cy, seg[2], seg[4], 1] as const,
      ]) {
        const denominator = p0 - 2 * p1 + p2;
        if (Math.abs(denominator) < 1e-12) continue;
        const t = (p0 - p1) / denominator;
        if (t <= 0 || t >= 1) continue;
        const v = quadAt(p0, p1, p2, t);
        if (axis === 0) hit(v, cy); else hit(cx, v);
      }
      cx = seg[3]; cy = seg[4];
    } else if (seg[0] === "C") {
      hit(seg[5], seg[6]);
      for (const t of cubicExtrema(cx, seg[1], seg[3], seg[5])) {
        hit(cubicAt(cx, seg[1], seg[3], seg[5], t), cy);
      }
      for (const t of cubicExtrema(cy, seg[2], seg[4], seg[6])) {
        hit(cx, cubicAt(cy, seg[2], seg[4], seg[6], t));
      }
      cx = seg[5]; cy = seg[6];
    } else {
      cx = sx; cy = sy;
    }
  }
  return seen ? [minX, minY, maxX, maxY] : null;
}

// ── the transform attribute ──────────────────────────────────────────────────────────

export type CanvasTransformParse = { matrix: CanvasMatrix; diagnostics: string[] };

const TRANSFORM_ARITY: { [name: string]: readonly number[] } = {
  translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1], matrix: [6],
};

function transformFunction(name: string, a: readonly number[]): CanvasMatrix | null {
  switch (name) {
    case "translate": return [1, 0, 0, 1, a[0]!, a.length > 1 ? a[1]! : 0];
    case "scale": return [a[0]!, 0, 0, a.length > 1 ? a[1]! : a[0]!, 0, 0];
    case "rotate": {
      const r = a[0]! * DEG;
      const rot: CanvasMatrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
      if (a.length === 1) return rot;
      const to: CanvasMatrix = [1, 0, 0, 1, a[1]!, a[2]!];
      const back: CanvasMatrix = [1, 0, 0, 1, -a[1]!, -a[2]!];
      return canvasMatMul(canvasMatMul(to, rot), back);
    }
    case "skewX": return [1, 0, Math.tan(a[0]! * DEG), 1, 0, 0];
    case "skewY": return [1, Math.tan(a[0]! * DEG), 0, 1, 0, 0];
    case "matrix": return [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
    default: return null;
  }
}

/**
 * The SVG function list, applied LEFT TO RIGHT: the leftmost function is outermost, so
 * M = M1·M2·…·Mn and `translate(10,0) scale(2)` is NOT `scale(2) translate(10,0)`.
 *
 * ARTICLE 7: an unknown function, a wrong-arity function, a non-numeric argument or junk
 * between functions costs exactly ONE diagnostic and is SKIPPED — every other function in
 * the list still applies.
 */
export function parseCanvasTransform(input: string | null | undefined): CanvasTransformParse {
  const source = typeof input === "string" ? input : "";
  const diagnostics: string[] = [];
  let matrix: CanvasMatrix = CANVAS_IDENTITY;
  const pattern = /([A-Za-z][A-Za-z0-9]*)\s*\(([\s\S]*?)\)/g;
  let cursor = 0;
  const gap = (text: string): void => {
    if (text.replace(/[\s,]+/g, "") !== "") diagnostics.push(`canvas.transform: junk '${text.trim()}'`);
  };
  for (;;) {
    const match = pattern.exec(source);
    if (match === null) break;
    gap(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const name = match[1]!;
    const arity = TRANSFORM_ARITY[name];
    if (arity === undefined) {
      diagnostics.push(`canvas.transform: unknown function '${name}'`);
      continue;
    }
    const words = match[2]!.split(/[\s,]+/).filter((w) => w !== "");
    if (!arity.includes(words.length)) {
      diagnostics.push(`canvas.transform: ${name} takes ${arity.join(" or ")} arguments`);
      continue;
    }
    const args: number[] = [];
    let numeric = true;
    for (const word of words) {
      const value = Number(word);
      if (!Number.isFinite(value)) { numeric = false; break; }
      args.push(value);
    }
    if (!numeric) {
      diagnostics.push(`canvas.transform: ${name} has a non-numeric argument`);
      continue;
    }
    const local = transformFunction(name, args);
    if (local !== null) matrix = canvasMatMul(matrix, local);
  }
  gap(source.slice(cursor));
  return { matrix, diagnostics };
}

// ── flattening and the fill rules ────────────────────────────────────────────────────

/** uniform in t, never adaptive: adaptive subdivision is per-implementation and would
 *  make the fill-rule corpus unpinnable */
export const CANVAS_FLATTEN_SEGMENTS = 16;

export type CanvasFillRule = "nonzero" | "evenodd";

/** every subpath, closed, as a point list */
export function canvasFlatten(segments: readonly CanvasSegment[]): [number, number][][] {
  const out: [number, number][][] = [];
  let current: [number, number][] | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const push = (x: number, y: number): void => {
    if (current === null) { current = [[x, y]]; out.push(current); }
    else current.push([x, y]);
  };
  for (const seg of segments) {
    if (seg[0] === "M") {
      current = null;
      cx = seg[1]; cy = seg[2]; sx = cx; sy = cy;
      push(cx, cy);
    } else if (seg[0] === "L") {
      if (current === null) push(cx, cy);
      cx = seg[1]; cy = seg[2];
      push(cx, cy);
    } else if (seg[0] === "Q") {
      if (current === null) push(cx, cy);
      for (let i = 1; i <= CANVAS_FLATTEN_SEGMENTS; i += 1) {
        const t = i / CANVAS_FLATTEN_SEGMENTS;
        push(quadAt(cx, seg[1], seg[3], t), quadAt(cy, seg[2], seg[4], t));
      }
      cx = seg[3]; cy = seg[4];
    } else if (seg[0] === "C") {
      if (current === null) push(cx, cy);
      for (let i = 1; i <= CANVAS_FLATTEN_SEGMENTS; i += 1) {
        const t = i / CANVAS_FLATTEN_SEGMENTS;
        push(cubicAt(cx, seg[1], seg[3], seg[5], t), cubicAt(cy, seg[2], seg[4], seg[6], t));
      }
      cx = seg[5]; cy = seg[6];
    } else {
      cx = sx; cy = sy;
      current = null;
    }
  }
  return out.filter((sub) => sub.length > 1);
}

/** the signed shoelace area of the FLATTENED path — positive is clockwise in the y-down
 *  canvas space. It pins the flattening itself, not just the inside/outside verdicts. */
export function canvasPathArea(segments: readonly CanvasSegment[]): number {
  let total = 0;
  for (const sub of canvasFlatten(segments)) {
    for (let i = 0; i < sub.length; i += 1) {
      const a = sub[i]!;
      const b = sub[(i + 1) % sub.length]!;
      total += a[0] * b[1] - b[0] * a[1];
    }
  }
  return total / 2;
}

type Crossing = { winding: number; crossings: number };

function crossingsAt(segments: readonly CanvasSegment[], px: number, py: number): Crossing {
  let winding = 0;
  let crossings = 0;
  for (const sub of canvasFlatten(segments)) {
    for (let i = 0; i < sub.length; i += 1) {
      const a = sub[i]!;
      const b = sub[(i + 1) % sub.length]!;
      const up = a[1] <= py && py < b[1];
      const down = b[1] <= py && py < a[1];
      if (!up && !down) continue;
      const x = a[0] + ((py - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (!(x > px)) continue;
      crossings += 1;
      winding += up ? 1 : -1;
    }
  }
  return { winding, crossings };
}

/** the winding number at a point (half-open in y, crossings strictly right of the point) */
export function canvasWindingAt(segments: readonly CanvasSegment[], x: number, y: number): number {
  return crossingsAt(segments, x, y).winding;
}

export function canvasCrossingsAt(segments: readonly CanvasSegment[], x: number, y: number): number {
  return crossingsAt(segments, x, y).crossings;
}

/** is this point inside, under `rule`? */
export function canvasContains(
  segments: readonly CanvasSegment[], x: number, y: number, rule: CanvasFillRule,
): boolean {
  const c = crossingsAt(segments, x, y);
  return rule === "evenodd" ? c.crossings % 2 === 1 : c.winding !== 0;
}

// ── colour ───────────────────────────────────────────────────────────────────────────

export type CanvasRgba = readonly [number, number, number, number];

/** a resolved paint. A SEMANTIC TOKEN survives the pure core UNRESOLVED — the theme
 *  resolves it at paint time, so the core must not bake it. */
export type CanvasPaint =
  | { readonly kind: "rgba"; readonly rgba: CanvasRgba }
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "gradient"; readonly id: string };

export const CANVAS_BLACK: CanvasPaint = { kind: "rgba", rgba: [0, 0, 0, 1] };

/** the semantic colour words (the StackStyle.color vocabulary) → their web custom
 *  property. `clear` is the one word with no token: it is literally transparent. */
export const CANVAS_COLOR_TOKENS: { readonly [word: string]: string } = {
  clear: "transparent",
  label: "--dsx-label",
  text: "--dsx-label",
  secondary: "--dsx-secondary-label",
  secondaryLabel: "--dsx-secondary-label",
  tertiary: "--dsx-tertiary-label",
  tertiaryLabel: "--dsx-tertiary-label",
  quaternary: "--dsx-tertiary-label",
  accent: "--dsx-accent",
  destructive: "--dsx-destructive",
  separator: "--dsx-separator",
  fill: "--dsx-fill",
  fillFaint: "--dsx-fill",
  background: "--dsx-background",
  systemBackground: "--dsx-background",
  secondaryBackground: "--dsx-secondary-background",
  tertiaryBackground: "--dsx-tertiary-background",
  groupedBackground: "--dsx-grouped-background",
  secondaryGroupedBackground: "--dsx-secondary-grouped-background",
};

const LITERAL_WORDS: { readonly [word: string]: CanvasRgba } = {
  white: [1, 1, 1, 1],
  black: [0, 0, 0, 1],
};

/** `none` is the ABSENCE of a paint and is distinct from an unparseable one: none paints
 *  nothing with no diagnostic, garbage costs one diagnostic and falls back to black. */
export type CanvasPaintParse = { paint: CanvasPaint | null; ok: boolean };

export function parseCanvasPaint(input: string | null | undefined): CanvasPaintParse {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw === "") return { paint: null, ok: false };
  if (raw === "none" || raw === "transparent") return { paint: null, ok: true };
  const url = /^url\(\s*#([^)\s]+)\s*\)$/.exec(raw);
  if (url !== null) return { paint: { kind: "gradient", id: url[1]! }, ok: true };
  if (Object.prototype.hasOwnProperty.call(LITERAL_WORDS, raw)) {
    return { paint: { kind: "rgba", rgba: LITERAL_WORDS[raw]! }, ok: true };
  }
  if (Object.prototype.hasOwnProperty.call(CANVAS_COLOR_TOKENS, raw)) {
    return { paint: { kind: "token", token: raw }, ok: true };
  }
  const rgba = parseCanvasRgba(raw);
  if (rgba !== null) return { paint: { kind: "rgba", rgba }, ok: true };
  return { paint: null, ok: false };
}

/** `#rgb` · `#rgba` · `#rrggbb` · `#rrggbbaa` · `rgb(r,g,b)` · `rgba(r,g,b,a)`, in
 *  STRAIGHT (non-premultiplied) sRGB, components 0..1 */
export function parseCanvasRgba(input: string): CanvasRgba | null {
  const raw = input.trim();
  if (raw.startsWith("#")) {
    const hex = raw.slice(1);
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    const wide = (n: number): number => parseInt(hex[n]! + hex[n]!, 16) / 255;
    const pair = (n: number): number => parseInt(hex.slice(n, n + 2), 16) / 255;
    if (hex.length === 3) return [wide(0), wide(1), wide(2), 1];
    if (hex.length === 4) return [wide(0), wide(1), wide(2), wide(3)];
    if (hex.length === 6) return [pair(0), pair(2), pair(4), 1];
    if (hex.length === 8) return [pair(0), pair(2), pair(4), pair(6)];
    return null;
  }
  const call = /^rgba?\(([^)]*)\)$/i.exec(raw);
  if (call === null) return null;
  const parts = call[1]!.split(/[,/\s]+/).filter((p) => p !== "");
  if (parts.length < 3 || parts.length > 4) return null;
  const channel = (text: string): number | null => {
    const value = text.endsWith("%") ? Number(text.slice(0, -1)) * 2.55 : Number(text);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value / 255)) : null;
  };
  const r = channel(parts[0]!);
  const g = channel(parts[1]!);
  const b = channel(parts[2]!);
  if (r === null || g === null || b === null) return null;
  let a = 1;
  if (parts.length === 4) {
    const text = parts[3]!;
    const value = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
    if (!Number.isFinite(value)) return null;
    a = Math.min(1, Math.max(0, value));
  }
  return [r, g, b, a];
}

// ── gradients ────────────────────────────────────────────────────────────────────────

export type CanvasStopInput = {
  readonly offset?: number | string | null;
  readonly color?: string | null;
  readonly opacity?: number | string | null;
};

/** a normalized stop: an rgba stop has its `stop-opacity` already multiplied in; a TOKEN
 *  stop keeps the word and its opacity for the theme to resolve at paint time */
export type CanvasStop =
  | { readonly offset: number; readonly rgba: CanvasRgba }
  | { readonly offset: number; readonly token: string; readonly opacity: number };

export type CanvasStopsParse = { stops: CanvasStop[]; diagnostics: string[] };

function parseOffset(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  const text = value.trim();
  if (text === "") return null;
  const percent = text.endsWith("%");
  const parsed = Number(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(1, Math.max(0, percent ? parsed / 100 : parsed));
}

/**
 * THE LAW, in order: parse each offset (a number or a percentage) and CLAMP it into 0..1;
 * a missing FIRST offset is 0 and a missing LAST is 1; a run of missing interior offsets
 * spaces EVENLY between its two known neighbours; then walk left to right forcing
 * MONOTONIC non-decreasing offsets (a decreasing offset is raised to its predecessor —
 * never re-sorted, because author order is the paint order).
 */
export function normalizeCanvasStops(input: readonly CanvasStopInput[]): CanvasStopsParse {
  const diagnostics: string[] = [];
  if (input.length === 0) {
    diagnostics.push("canvas.gradient: no stops");
    return { stops: [], diagnostics };
  }
  const offsets: (number | null)[] = input.map((s) => parseOffset(s.offset));
  if (offsets[0] === null) offsets[0] = 0;
  if (offsets[offsets.length - 1] === null) offsets[offsets.length - 1] = 1;
  let i = 0;
  while (i < offsets.length) {
    if (offsets[i] !== null) { i += 1; continue; }
    let j = i;
    while (j < offsets.length && offsets[j] === null) j += 1;
    const before = offsets[i - 1]!;
    const after = offsets[j]!;
    const span = j - i + 1;
    for (let k = i; k < j; k += 1) offsets[k] = before + ((after - before) * (k - i + 1)) / span;
    i = j;
  }
  let previous = -Infinity;
  const stops: CanvasStop[] = [];
  for (let k = 0; k < input.length; k += 1) {
    const offset = Math.max(offsets[k]!, previous === -Infinity ? offsets[k]! : previous);
    previous = offset;
    const raw = input[k]!;
    const opacityValue = raw.opacity === null || raw.opacity === undefined ? 1 : num(raw.opacity, 1);
    const opacity = Math.min(1, Math.max(0, opacityValue));
    const parsed = parseCanvasPaint(raw.color);
    if (parsed.paint !== null && parsed.paint.kind === "token") {
      stops.push({ offset, token: parsed.paint.token, opacity });
      continue;
    }
    if (parsed.paint !== null && parsed.paint.kind === "rgba") {
      const c = parsed.paint.rgba;
      stops.push({ offset, rgba: [c[0], c[1], c[2], c[3] * opacity] });
      continue;
    }
    if (!parsed.ok) diagnostics.push(`canvas.gradient: unparseable colour '${String(raw.color)}'`);
    stops.push({ offset, rgba: [0, 0, 0, 1 * opacity] });
  }
  return { stops, diagnostics };
}

/** Sample the normalized stop list at t, interpolating componentwise in STRAIGHT
 *  (non-premultiplied) sRGB — not linear-light, not premultiplied, because that is what
 *  Canvas2D, CoreGraphics and Compose all do by default. Two stops at the SAME offset are
 *  a hard stop: the earlier stop owns the offset itself, the later one owns everything
 *  after it. A token stop cannot be sampled here — resolve the theme first. */
export function sampleCanvasStops(stops: readonly CanvasStop[], t: number): CanvasRgba | null {
  if (stops.length === 0) return null;
  const rgbaOf = (s: CanvasStop): CanvasRgba | null => ("rgba" in s ? s.rgba : null);
  if (t <= stops[0]!.offset) return rgbaOf(stops[0]!);
  let index = -1;
  for (let i = 1; i < stops.length; i += 1) {
    if (t <= stops[i]!.offset) { index = i; break; }
  }
  if (index === -1) return rgbaOf(stops[stops.length - 1]!);
  const a = rgbaOf(stops[index - 1]!);
  const b = rgbaOf(stops[index]!);
  if (a === null || b === null) return null;
  const span = stops[index]!.offset - stops[index - 1]!.offset;
  const u = span <= 0 ? 1 : (t - stops[index - 1]!.offset) / span;
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
    a[3] + (b[3] - a[3]) * u,
  ];
}

export type CanvasGradientKind = "linear" | "radial" | "angular";

/** the 1-D paint coordinate for each gradient kind. linear is the CLAMPED projection onto
 *  the axis, radial the clamped distance ratio, angular the turn fraction from `start`,
 *  measured with atan2 in the y-down canvas space and wrapped into [0,1). */
export function canvasGradientT(
  kind: CanvasGradientKind, geom: readonly number[], x: number, y: number,
): number {
  if (kind === "linear") {
    const [x1, y1, x2, y2] = [geom[0] ?? 0, geom[1] ?? 0, geom[2] ?? 0, geom[3] ?? 0];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return 0;
    return Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / len2));
  }
  const cx = geom[0] ?? 0;
  const cy = geom[1] ?? 0;
  if (kind === "radial") {
    const r = geom[2] ?? 0;
    if (r <= 0) return 1;
    return Math.min(1, Math.max(0, Math.hypot(x - cx, y - cy) / r));
  }
  const start = geom[2] ?? 0;
  const degrees = Math.atan2(y - cy, x - cx) / DEG;
  const turn = (degrees - start) / 360;
  return turn - Math.floor(turn);
}

export type CanvasGradient = {
  readonly kind: CanvasGradientKind;
  readonly geom: readonly number[];
  readonly stops: readonly CanvasStop[];
};

// ── tier 1: the display list ─────────────────────────────────────────────────────────

export type CanvasMarkupNode = {
  readonly kind: string;
  readonly attrs?: { readonly [name: string]: unknown };
  readonly children?: readonly CanvasMarkupNode[];
};

export type CanvasEffect =
  | { readonly kind: "blur"; readonly radius: number }
  | { readonly kind: "shadow"; readonly dx: number; readonly dy: number; readonly radius: number; readonly color: CanvasPaint }
  | { readonly kind: "blend"; readonly mode: string };

export type CanvasClip = { readonly path: CanvasSegment[]; readonly transform: CanvasMatrix };

/** ONE drawing op. The path is in LOCAL coordinates and the matrix rides beside it — never
 *  a baked path, because tier 1 is RETAINED and only the matrix changes when a transform
 *  animates. */
export type CanvasOp = {
  key: string;
  kind: string;
  transform: CanvasMatrix;
  opacity: number;
  path?: CanvasSegment[];
  fill?: CanvasPaint | null;
  stroke?: CanvasPaint | null;
  strokeWidth?: number;
  fillRule?: CanvasFillRule;
  strokeLinecap?: string;
  strokeLinejoin?: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number | null;
  height?: number | null;
  fontSize?: number;
  textAnchor?: string;
  src?: string;
  clip?: CanvasClip;
  effects?: CanvasEffect[];
};

export type CanvasDisplayList = {
  ops: CanvasOp[];
  gradients: { [id: string]: CanvasGradient };
  diagnostics: string[];
};

const SHAPE_KINDS = new Set(["path", "rect", "circle", "ellipse", "line", "polygon", "polyline"]);
const WRAPPER_KINDS = new Set(["group", "blur", "shadow", "blend"]);

/** the ONE kind whose unstyled default fill is absent rather than SVG black: a line has
 *  no interior to fill */
const UNFILLED_KINDS = new Set(["line"]);

type Inherited = {
  fill: CanvasPaint | null | undefined;
  stroke: CanvasPaint | null | undefined;
  strokeWidth: number | undefined;
  fillRule: CanvasFillRule | undefined;
  strokeLinecap: string | undefined;
  strokeLinejoin: string | undefined;
};

function attr(node: CanvasMarkupNode, name: string): unknown {
  return node.attrs === undefined ? undefined : node.attrs[name];
}

function attrText(node: CanvasMarkupNode, name: string): string | undefined {
  const value = attr(node, name);
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function attrNum(node: CanvasMarkupNode, name: string, fallback: number): number {
  const value = attr(node, name);
  return value === undefined || value === null ? fallback : num(value, fallback);
}

function parsePoints(text: string): [number, number][] {
  const words = text.split(/[\s,]+/).filter((w) => w !== "");
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < words.length; i += 2) {
    const x = Number(words[i]);
    const y = Number(words[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) break;
    out.push([x, y]);
  }
  return out;
}

/** rect/circle/ellipse/roundRect all become paths through the SAME arc→cubic converter as
 *  `d`, so a circle is four cubics with k = 4/3·tan(π/8) on every renderer */
export function canvasRectPath(
  x: number, y: number, w: number, h: number, rxIn: number, ryIn: number,
): CanvasSegment[] {
  const rx = Math.min(Math.abs(rxIn), Math.abs(w) / 2);
  const ry = Math.min(Math.abs(ryIn), Math.abs(h) / 2);
  if (rx <= 0 || ry <= 0) {
    return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
  }
  const out: CanvasSegment[] = [["M", x + rx, y], ["L", x + w - rx, y]];
  const corner = (x1: number, y1: number, x2: number, y2: number): void => {
    for (const seg of canvasArcToCubics(x1, y1, rx, ry, 0, 0, 1, x2, y2)) out.push(seg);
  };
  corner(x + w - rx, y, x + w, y + ry);
  out.push(["L", x + w, y + h - ry]);
  corner(x + w, y + h - ry, x + w - rx, y + h);
  out.push(["L", x + rx, y + h]);
  corner(x + rx, y + h, x, y + h - ry);
  out.push(["L", x, y + ry]);
  corner(x, y + ry, x + rx, y);
  out.push(["Z"]);
  return out;
}

export function canvasEllipsePath(cx: number, cy: number, rx: number, ry: number): CanvasSegment[] {
  const out: CanvasSegment[] = [["M", cx + rx, cy]];
  for (const seg of arcCentreToCubics(cx, cy, rx, ry, 0, 0, 2 * Math.PI)) out.push(seg);
  out.push(["Z"]);
  return out;
}

function shapePath(node: CanvasMarkupNode, diagnostics: string[]): CanvasSegment[] {
  switch (node.kind) {
    case "path": {
      const parsed = parseCanvasPath(attrText(node, "d"));
      for (const d of parsed.diagnostics) diagnostics.push(d);
      return parsed.segments;
    }
    case "rect": {
      const rxRaw = attr(node, "rx");
      const ryRaw = attr(node, "ry");
      const rx = rxRaw === undefined || rxRaw === null ? (ryRaw === undefined || ryRaw === null ? 0 : num(ryRaw, 0)) : num(rxRaw, 0);
      const ry = ryRaw === undefined || ryRaw === null ? rx : num(ryRaw, 0);
      return canvasRectPath(
        attrNum(node, "x", 0), attrNum(node, "y", 0),
        attrNum(node, "width", 0), attrNum(node, "height", 0), rx, ry,
      );
    }
    case "circle": {
      const r = attrNum(node, "r", 0);
      return canvasEllipsePath(attrNum(node, "cx", 0), attrNum(node, "cy", 0), r, r);
    }
    case "ellipse":
      return canvasEllipsePath(
        attrNum(node, "cx", 0), attrNum(node, "cy", 0),
        attrNum(node, "rx", 0), attrNum(node, "ry", 0),
      );
    case "line":
      return [
        ["M", attrNum(node, "x1", 0), attrNum(node, "y1", 0)],
        ["L", attrNum(node, "x2", 0), attrNum(node, "y2", 0)],
      ];
    case "polygon":
    case "polyline": {
      const points = parsePoints(attrText(node, "points") ?? "");
      if (points.length === 0) return [];
      const out: CanvasSegment[] = [["M", points[0]![0], points[0]![1]]];
      for (let i = 1; i < points.length; i += 1) out.push(["L", points[i]![0], points[i]![1]]);
      if (node.kind === "polygon") out.push(["Z"]);
      return out;
    }
    default:
      return [];
  }
}

function readInherited(
  node: CanvasMarkupNode, parent: Inherited, diagnostics: string[],
): Inherited {
  const next: Inherited = { ...parent };
  const paint = (name: string): CanvasPaint | null | undefined => {
    const raw = attrText(node, name);
    if (raw === undefined) return undefined;
    const parsed = parseCanvasPaint(raw);
    if (!parsed.ok) {
      diagnostics.push(`canvas.${name}: unparseable colour '${raw}'`);
      return CANVAS_BLACK;
    }
    return parsed.paint;
  };
  const fill = paint("fill");
  if (fill !== undefined) next.fill = fill;
  const stroke = paint("stroke");
  if (stroke !== undefined) next.stroke = stroke;
  const width = attr(node, "strokeWidth");
  if (width !== undefined && width !== null) next.strokeWidth = num(width, 1);
  const rule = attrText(node, "fillRule");
  if (rule === "evenodd" || rule === "nonzero") next.fillRule = rule;
  const cap = attrText(node, "strokeLinecap");
  if (cap !== undefined) next.strokeLinecap = cap;
  const join = attrText(node, "strokeLinejoin");
  if (join !== undefined) next.strokeLinejoin = join;
  return next;
}

/**
 * THE BUILD LAW: walk the children in document order; a wrapper (group · blur · shadow ·
 * blend) emits NO op and instead folds into its descendants — transform composes,
 * opacity MULTIPLIES, paint attributes INHERIT, `clip` on a group rides every descendant
 * op with the matrix in force where the clip was authored, and each effect wrapper
 * APPENDS to the op's effect chain outermost-first. A `<gradient id>` child registers a
 * paint and emits no op. An unknown child tag is one diagnostic and no op — a canvas
 * draws, it does not lay out.
 *
 * THE KEY LAW (the `<list>` keying law verbatim): an authored `key` wins, an unkeyed node
 * keys on its KIND plus its position among same-kind siblings, a duplicate gets the `·n`
 * suffix in encounter order, and the key is PATH-PREFIXED by its ancestors' keys.
 */
export function buildCanvasDisplayList(tree: readonly CanvasMarkupNode[]): CanvasDisplayList {
  const ops: CanvasOp[] = [];
  const gradients: { [id: string]: CanvasGradient } = {};
  const diagnostics: string[] = [];

  const walk = (
    nodes: readonly CanvasMarkupNode[], prefix: string, world: CanvasMatrix, opacity: number,
    inherited: Inherited, effects: readonly CanvasEffect[], clip: CanvasClip | undefined,
  ): void => {
    const used = new Set<string>();
    const keyFor = (node: CanvasMarkupNode): string => {
      const authored = attrText(node, "key");
      const base = authored !== undefined && authored !== "" ? authored : node.kind;
      let key = base;
      let n = 1;
      while (used.has(key)) { key = `${base}·${n}`; n += 1; }
      used.add(key);
      return prefix === "" ? key : `${prefix}/${key}`;
    };

    for (const node of nodes) {
      if (node.kind === "gradient") {
        registerGradient(node, gradients, diagnostics);
        continue;
      }
      if (node.kind === "stop") continue;
      const isWrapper = WRAPPER_KINDS.has(node.kind);
      const isShape = SHAPE_KINDS.has(node.kind);
      const isText = node.kind === "text";
      const isImage = node.kind === "image";
      if (!isWrapper && !isShape && !isText && !isImage) {
        diagnostics.push(`canvas: <${node.kind}> is not a drawing primitive`);
        continue;
      }

      const key = keyFor(node);
      const local = parseCanvasTransform(attrText(node, "transform"));
      for (const d of local.diagnostics) diagnostics.push(d);
      const nodeWorld = canvasMatrixIsIdentity(local.matrix)
        ? world : canvasMatMul(world, local.matrix);
      const nodeOpacity = opacity * clampUnit(attrNum(node, "opacity", 1));
      const nodeInherited = readInherited(node, inherited, diagnostics);

      if (isWrapper) {
        let nodeEffects = effects;
        if (node.kind === "blur") {
          nodeEffects = [...effects, { kind: "blur", radius: attrNum(node, "radius", 0) }];
        } else if (node.kind === "shadow") {
          const parsed = parseCanvasPaint(attrText(node, "color") ?? "#000000");
          nodeEffects = [...effects, {
            kind: "shadow",
            dx: attrNum(node, "dx", 0),
            dy: attrNum(node, "dy", 0),
            radius: attrNum(node, "radius", 0),
            color: parsed.paint ?? CANVAS_BLACK,
          }];
        } else if (node.kind === "blend") {
          nodeEffects = [...effects, { kind: "blend", mode: attrText(node, "mode") ?? "normal" }];
        }
        let nodeClip = clip;
        const clipData = attrText(node, "clip");
        if (clipData !== undefined) {
          const parsed = parseCanvasPath(clipData);
          for (const d of parsed.diagnostics) diagnostics.push(d);
          // Nested clips are NOT intersected here: the innermost authored clip wins. Path
          // intersection is a rasteriser job and no two of them agree on it.
          nodeClip = { path: parsed.segments, transform: nodeWorld };
        }
        walk(node.children ?? [], key, nodeWorld, nodeOpacity, nodeInherited, nodeEffects, nodeClip);
        continue;
      }

      const op: CanvasOp = { key, kind: node.kind, transform: nodeWorld, opacity: nodeOpacity };
      if (isText) {
        op.text = attrText(node, "value") ?? "";
        op.x = attrNum(node, "x", 0);
        op.y = attrNum(node, "y", 0);
        op.fontSize = attrNum(node, "fontSize", 16);
        op.textAnchor = attrText(node, "textAnchor") ?? "start";
        op.fill = nodeInherited.fill !== undefined ? nodeInherited.fill : CANVAS_BLACK;
      } else if (isImage) {
        op.src = attrText(node, "src") ?? "";
        op.x = attrNum(node, "x", 0);
        op.y = attrNum(node, "y", 0);
        op.width = attr(node, "width") === undefined ? null : attrNum(node, "width", 0);
        op.height = attr(node, "height") === undefined ? null : attrNum(node, "height", 0);
      } else {
        op.path = shapePath(node, diagnostics);
        op.fill = nodeInherited.fill !== undefined
          ? nodeInherited.fill
          : (UNFILLED_KINDS.has(node.kind) ? null : CANVAS_BLACK);
        op.stroke = nodeInherited.stroke !== undefined ? nodeInherited.stroke : null;
        op.strokeWidth = nodeInherited.strokeWidth ?? 1;
        op.fillRule = nodeInherited.fillRule ?? "nonzero";
        op.strokeLinecap = nodeInherited.strokeLinecap ?? "butt";
        op.strokeLinejoin = nodeInherited.strokeLinejoin ?? "miter";
      }
      if (clip !== undefined) op.clip = clip;
      if (effects.length > 0) op.effects = [...effects];
      ops.push(op);
    }
  };

  const root: Inherited = {
    fill: undefined, stroke: undefined, strokeWidth: undefined,
    fillRule: undefined, strokeLinecap: undefined, strokeLinejoin: undefined,
  };
  walk(tree, "", CANVAS_IDENTITY, 1, root, [], undefined);
  return { ops, gradients, diagnostics };
}

function clampUnit(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function registerGradient(
  node: CanvasMarkupNode,
  into: { [id: string]: CanvasGradient },
  diagnostics: string[],
): void {
  const id = attrText(node, "id");
  if (id === undefined || id === "") {
    diagnostics.push("canvas.gradient: a gradient needs an id");
    return;
  }
  const word = attrText(node, "kind") ?? "linear";
  const kind: CanvasGradientKind =
    word === "radial" || word === "angular" ? word : "linear";
  const geom = kind === "linear"
    ? [attrNum(node, "x1", 0), attrNum(node, "y1", 0), attrNum(node, "x2", 0), attrNum(node, "y2", 0)]
    : kind === "radial"
      ? [attrNum(node, "cx", 0), attrNum(node, "cy", 0), attrNum(node, "r", 0)]
      : [attrNum(node, "cx", 0), attrNum(node, "cy", 0), attrNum(node, "start", 0)];
  const inputs: CanvasStopInput[] = (node.children ?? [])
    .filter((c) => c.kind === "stop")
    .map((c) => ({
      offset: (attr(c, "offset") ?? null) as number | string | null,
      color: attrText(c, "color") ?? null,
      opacity: (attr(c, "opacity") ?? null) as number | string | null,
    }));
  const normalized = normalizeCanvasStops(inputs);
  for (const d of normalized.diagnostics) diagnostics.push(d);
  into[id] = { kind, geom, stops: normalized.stops };
}

// ── the keyed diff ───────────────────────────────────────────────────────────────────

export type CanvasDiffEntry = {
  readonly op: "keep" | "update" | "move" | "insert" | "remove";
  readonly key: string;
  readonly to?: number;
  readonly from?: number;
};

function opContentEqual(a: CanvasOp, b: CanvasOp): boolean {
  const strip = (op: CanvasOp): unknown => {
    const { key: _key, ...rest } = op;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** the complement of a longest increasing subsequence of the retained previous indices,
 *  so a single item moved to the front is ONE move, not n */
function longestIncreasing(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const tails: number[] = [];
  const parents: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < values[i]!) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) parents[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: number[] = [];
  let cursor = tails[tails.length - 1]!;
  while (cursor !== -1) { out.push(cursor); cursor = parents[cursor]!; }
  return out.reverse();
}

/** THE DIFF LAW: keys present on both sides KEEP their identity across reorder. */
export function diffCanvasDisplayList(
  before: readonly CanvasOp[], after: readonly CanvasOp[],
): CanvasDiffEntry[] {
  const beforeIndex = new Map<string, number>();
  before.forEach((op, i) => beforeIndex.set(op.key, i));
  const afterKeys = new Set(after.map((op) => op.key));
  const out: CanvasDiffEntry[] = [];
  for (const op of before) {
    if (!afterKeys.has(op.key)) out.push({ op: "remove", key: op.key });
  }
  const retained: number[] = [];
  const retainedAt: number[] = [];
  after.forEach((op, i) => {
    const previous = beforeIndex.get(op.key);
    if (previous !== undefined) { retained.push(previous); retainedAt.push(i); }
  });
  const stable = new Set(longestIncreasing(retained).map((i) => retainedAt[i]!));
  after.forEach((op, i) => {
    const previous = beforeIndex.get(op.key);
    if (previous === undefined) { out.push({ op: "insert", key: op.key, to: i }); return; }
    if (!stable.has(i)) { out.push({ op: "move", key: op.key, from: previous, to: i }); return; }
    if (opContentEqual(before[previous]!, op)) out.push({ op: "keep", key: op.key, to: i });
    else out.push({ op: "update", key: op.key, to: i });
  });
  return out;
}

// ── the SSR SVG serialisation ────────────────────────────────────────────────────────

/** round to 6 decimals and trim: the ONE number spelling the SVG bytes are pinned to */
export function canvasNumberText(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1e6) / 1e6;
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function hexByte(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
}

export function canvasRgbaHex(rgba: CanvasRgba): string {
  return `#${hexByte(rgba[0])}${hexByte(rgba[1])}${hexByte(rgba[2])}`;
}

function paintText(paint: CanvasPaint | null): string {
  if (paint === null) return "none";
  if (paint.kind === "rgba") return canvasRgbaHex(paint.rgba);
  if (paint.kind === "gradient") return `url(#${paint.id})`;
  const token = CANVAS_COLOR_TOKENS[paint.token];
  if (token === undefined || token === "transparent") return "transparent";
  return `var(${token})`;
}

function paintAlpha(paint: CanvasPaint | null): number {
  return paint !== null && paint.kind === "rgba" ? paint.rgba[3] : 1;
}

export function canvasEscapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pathText(segments: readonly CanvasSegment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg[0] === "Z") { parts.push("Z"); continue; }
    parts.push(seg[0]);
    for (let i = 1; i < seg.length; i += 1) parts.push(canvasNumberText(seg[i] as number));
  }
  return parts.join(" ");
}

function matrixText(m: CanvasMatrix): string {
  return `matrix(${m.map(canvasNumberText).join(",")})`;
}

/**
 * The tier-1 tree renders SERVER-SIDE as SVG and hydrates onto a canvas with no repaint
 * flash: a capability neither RN nor Flutter has, and it costs one serialiser.
 *
 * NAMED ABSENCE: SVG has no conic-gradient primitive, so an `angular` gradient serialises
 * as a radialGradient with the same stops — the SSR frame approximates and the live canvas
 * paints the real sweep. Everything else is byte-pinned by the corpus.
 */
export function canvasToSvg(
  list: CanvasDisplayList, width: number, height: number,
): string {
  const defs: string[] = [];
  let fxCounter = 0;
  const fxId = (): string => { fxCounter += 1; return `dsx-fx-${fxCounter}`; };

  for (const [id, gradient] of Object.entries(list.gradients)) {
    const stops = gradient.stops.map((s) => {
      const bits = [`offset="${canvasNumberText(s.offset)}"`];
      if ("rgba" in s) {
        bits.push(`stop-color="${canvasRgbaHex(s.rgba)}"`);
        if (s.rgba[3] < 1) bits.push(`stop-opacity="${canvasNumberText(s.rgba[3])}"`);
      } else {
        const token = CANVAS_COLOR_TOKENS[s.token];
        bits.push(`stop-color="${token === undefined || token === "transparent" ? "transparent" : `var(${token})`}"`);
        if (s.opacity < 1) bits.push(`stop-opacity="${canvasNumberText(s.opacity)}"`);
      }
      return `<stop ${bits.join(" ")}/>`;
    }).join("");
    if (gradient.kind === "linear") {
      const g = gradient.geom;
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${canvasNumberText(g[0] ?? 0)}" y1="${canvasNumberText(g[1] ?? 0)}" x2="${canvasNumberText(g[2] ?? 0)}" y2="${canvasNumberText(g[3] ?? 0)}">${stops}</linearGradient>`);
    } else {
      const g = gradient.geom;
      const r = gradient.kind === "radial" ? (g[2] ?? 0) : Math.max(width, height) / 2;
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${canvasNumberText(g[0] ?? 0)}" cy="${canvasNumberText(g[1] ?? 0)}" r="${canvasNumberText(r)}">${stops}</radialGradient>`);
    }
  }

  const body: string[] = [];
  for (const op of list.ops) {
    let inner: string;
    if (op.kind === "text") {
      const bits = [
        `x="${canvasNumberText(op.x ?? 0)}"`,
        `y="${canvasNumberText(op.y ?? 0)}"`,
        `font-size="${canvasNumberText(op.fontSize ?? 16)}"`,
        `fill="${paintText(op.fill ?? null)}"`,
      ];
      if (paintAlpha(op.fill ?? null) < 1) bits.push(`fill-opacity="${canvasNumberText(paintAlpha(op.fill ?? null))}"`);
      bits.push(`text-anchor="${op.textAnchor ?? "start"}"`);
      inner = `<text ${bits.join(" ")}>${canvasEscapeXml(op.text ?? "")}</text>`;
    } else if (op.kind === "image") {
      const bits = [`x="${canvasNumberText(op.x ?? 0)}"`, `y="${canvasNumberText(op.y ?? 0)}"`];
      if (op.width !== null && op.width !== undefined) bits.push(`width="${canvasNumberText(op.width)}"`);
      if (op.height !== null && op.height !== undefined) bits.push(`height="${canvasNumberText(op.height)}"`);
      bits.push(`href="${canvasEscapeXml(op.src ?? "")}"`);
      inner = `<image ${bits.join(" ")}/>`;
    } else {
      const bits = [`d="${pathText(op.path ?? [])}"`, `fill="${paintText(op.fill ?? null)}"`];
      if (paintAlpha(op.fill ?? null) < 1) bits.push(`fill-opacity="${canvasNumberText(paintAlpha(op.fill ?? null))}"`);
      if ((op.fillRule ?? "nonzero") !== "nonzero") bits.push(`fill-rule="${op.fillRule}"`);
      if (op.stroke !== null && op.stroke !== undefined) {
        bits.push(`stroke="${paintText(op.stroke)}"`);
        bits.push(`stroke-width="${canvasNumberText(op.strokeWidth ?? 1)}"`);
        if (paintAlpha(op.stroke) < 1) bits.push(`stroke-opacity="${canvasNumberText(paintAlpha(op.stroke))}"`);
        if ((op.strokeLinecap ?? "butt") !== "butt") bits.push(`stroke-linecap="${op.strokeLinecap}"`);
        if ((op.strokeLinejoin ?? "miter") !== "miter") bits.push(`stroke-linejoin="${op.strokeLinejoin}"`);
      }
      inner = `<path ${bits.join(" ")}/>`;
    }

    const wrap: string[] = [];
    if (!canvasMatrixIsIdentity(op.transform)) wrap.push(`transform="${matrixText(op.transform)}"`);
    if (op.opacity !== 1) wrap.push(`opacity="${canvasNumberText(op.opacity)}"`);
    if (op.clip !== undefined) {
      const id = fxId();
      const clipTransform = canvasMatrixIsIdentity(op.clip.transform)
        ? "" : ` transform="${matrixText(op.clip.transform)}"`;
      defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${pathText(op.clip.path)}"${clipTransform}/></clipPath>`);
      wrap.push(`clip-path="url(#${id})"`);
    }
    if (wrap.length > 0) inner = `<g ${wrap.join(" ")}>${inner}</g>`;

    const effects = op.effects ?? [];
    for (let i = effects.length - 1; i >= 0; i -= 1) {
      const effect = effects[i]!;
      if (effect.kind === "blend") {
        inner = `<g style="mix-blend-mode:${effect.mode}">${inner}</g>`;
      } else if (effect.kind === "blur") {
        const id = fxId();
        defs.push(`<filter id="${id}"><feGaussianBlur stdDeviation="${canvasNumberText(effect.radius / 2)}"/></filter>`);
        inner = `<g filter="url(#${id})">${inner}</g>`;
      } else {
        const id = fxId();
        const rgba = effect.color.kind === "rgba" ? effect.color.rgba : ([0, 0, 0, 1] as CanvasRgba);
        defs.push(`<filter id="${id}"><feDropShadow dx="${canvasNumberText(effect.dx)}" dy="${canvasNumberText(effect.dy)}" stdDeviation="${canvasNumberText(effect.radius / 2)}" flood-color="${canvasRgbaHex(rgba)}" flood-opacity="${canvasNumberText(rgba[3])}"/></filter>`);
        inner = `<g filter="url(#${id})">${inner}</g>`;
      }
    }
    body.push(inner);
  }

  const defsText = defs.length === 0 ? "" : `<defs>${defs.join("")}</defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasNumberText(width)}" height="${canvasNumberText(height)}" viewBox="0 0 ${canvasNumberText(width)} ${canvasNumberText(height)}">${defsText}${body.join("")}</svg>`;
}

// ── tier 2: the command recorder ─────────────────────────────────────────────────────

export type CanvasCommand = readonly [string, ...unknown[]];

export type CanvasShadow = {
  readonly dx: number; readonly dy: number; readonly radius: number; readonly color: CanvasPaint;
};

export type CanvasDrawEntry = {
  alpha: number;
  ctm: CanvasMatrix;
  clip?: { path: CanvasSegment[]; rule: CanvasFillRule };
  shadow?: CanvasShadow;
  blend?: string;
  op: string;
  path?: CanvasSegment[];
  rect?: readonly [number, number, number, number] | null;
  src?: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number | null;
  height?: number | null;
  style?: CanvasPaint;
  fontSize?: number;
  rule?: CanvasFillRule;
  lineWidth?: number;
  cap?: string;
  join?: string;
};

export type CanvasMeasurement = {
  readonly text: string; readonly width: number;
  readonly ascent: number; readonly descent: number;
};

export type CanvasScriptResult = {
  log: CanvasDrawEntry[];
  measurements: CanvasMeasurement[];
  diagnostics: string[];
};

/** the fallback text metrics, pinned so the fallback itself cannot drift. A platform WITH
 *  real font metrics answers from them, and that divergence is documented, not silent. */
export const CANVAS_FALLBACK_ADVANCE = 0.6;
export const CANVAS_FALLBACK_ASCENT = 0.8;
export const CANVAS_FALLBACK_DESCENT = 0.2;

export function canvasFallbackMetrics(text: string, fontSize: number): CanvasMeasurement {
  return {
    text,
    width: CANVAS_FALLBACK_ADVANCE * fontSize * text.length,
    ascent: CANVAS_FALLBACK_ASCENT * fontSize,
    descent: CANVAS_FALLBACK_DESCENT * fontSize,
  };
}

type PaintState = {
  ctm: CanvasMatrix;
  fill: CanvasPaint;
  stroke: CanvasPaint;
  lineWidth: number;
  cap: string;
  join: string;
  alpha: number;
  shadow: CanvasShadow | null;
  blend: string | null;
  clip: { path: CanvasSegment[]; rule: CanvasFillRule } | null;
  fontSize: number;
};

/**
 * The Canvas2D subset as a RECORDER: every call folds into a command stream a renderer
 * replays, which is why this corpus is exact on all three renderers — it asserts the
 * stream, never the pixels.
 *
 * (1) The CTM is baked into each path point AT POINT-ADD TIME — the Canvas2D rule, not the
 * SVG one. (2) save/restore push and pop the matrix AND the paint state as one unit.
 * (3) `arc` takes RADIANS (the Canvas2D signature authors know), `rotate` takes DEGREES
 * (every other DSX angle). (4) A draw with an EMPTY path emits nothing at all.
 */
export class CanvasRecorder {
  readonly log: CanvasDrawEntry[] = [];
  readonly measurements: CanvasMeasurement[] = [];
  readonly diagnostics: string[] = [];

  private state: PaintState = {
    ctm: CANVAS_IDENTITY,
    fill: CANVAS_BLACK,
    stroke: CANVAS_BLACK,
    lineWidth: 1,
    cap: "butt",
    join: "miter",
    alpha: 1,
    shadow: null,
    blend: null,
    clip: null,
    fontSize: 10,
  };

  private stack: PaintState[] = [];
  private path: CanvasSegment[] = [];
  private userX = 0;
  private userY = 0;
  private startX = 0;
  private startY = 0;
  private hasCurrent = false;

  run(script: readonly CanvasCommand[]): CanvasScriptResult {
    for (const command of script) this.call(command);
    return { log: this.log, measurements: this.measurements, diagnostics: this.diagnostics };
  }

  private bad(message: string): void {
    this.diagnostics.push(message);
  }

  private baked(x: number, y: number): [number, number] {
    return canvasApply(this.state.ctm, x, y);
  }

  private moveTo(x: number, y: number): void {
    const p = this.baked(x, y);
    this.path.push(["M", p[0], p[1]]);
    this.userX = x;
    this.userY = y;
    this.startX = x;
    this.startY = y;
    this.hasCurrent = true;
  }

  private lineTo(x: number, y: number): void {
    const p = this.baked(x, y);
    if (!this.hasCurrent) { this.moveTo(x, y); return; }
    this.path.push(["L", p[0], p[1]]);
    this.userX = x;
    this.userY = y;
  }

  private entryHead(): CanvasDrawEntry {
    const entry: CanvasDrawEntry = { alpha: this.state.alpha, ctm: this.state.ctm, op: "" };
    if (this.state.clip !== null) entry.clip = this.state.clip;
    if (this.state.shadow !== null) entry.shadow = this.state.shadow;
    if (this.state.blend !== null) entry.blend = this.state.blend;
    return entry;
  }

  private numbers(command: CanvasCommand, count: number, from = 1): number[] | null {
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const raw = command[from + i];
      if (raw === undefined || raw === null) return null;
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) return null;
      out.push(value);
    }
    return out;
  }

  private call(command: CanvasCommand): void {
    const name = String(command[0] ?? "");
    const missing = (): void => this.bad(`canvas.ctx.${name}: missing argument`);
    switch (name) {
      case "beginPath":
        this.path = [];
        this.hasCurrent = false;
        return;
      case "closePath":
        if (this.path.length === 0) return;
        this.path.push(["Z"]);
        this.userX = this.startX;
        this.userY = this.startY;
        return;
      case "moveTo": {
        const a = this.numbers(command, 2);
        if (a === null) { missing(); return; }
        this.moveTo(a[0]!, a[1]!);
        return;
      }
      case "lineTo": {
        const a = this.numbers(command, 2);
        if (a === null) { missing(); return; }
        this.lineTo(a[0]!, a[1]!);
        return;
      }
      case "quadTo": {
        const a = this.numbers(command, 4);
        if (a === null) { missing(); return; }
        if (!this.hasCurrent) this.moveTo(a[0]!, a[1]!);
        const c = this.baked(a[0]!, a[1]!);
        const p = this.baked(a[2]!, a[3]!);
        this.path.push(["Q", c[0], c[1], p[0], p[1]]);
        this.userX = a[2]!;
        this.userY = a[3]!;
        return;
      }
      case "cubicTo": {
        const a = this.numbers(command, 6);
        if (a === null) { missing(); return; }
        if (!this.hasCurrent) this.moveTo(a[0]!, a[1]!);
        const c1 = this.baked(a[0]!, a[1]!);
        const c2 = this.baked(a[2]!, a[3]!);
        const p = this.baked(a[4]!, a[5]!);
        this.path.push(["C", c1[0], c1[1], c2[0], c2[1], p[0], p[1]]);
        this.userX = a[4]!;
        this.userY = a[5]!;
        return;
      }
      case "arc": {
        const a = this.numbers(command, 5);
        if (a === null) { missing(); return; }
        this.arc(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, command[6] === true);
        return;
      }
      case "arcTo": {
        const a = this.numbers(command, 5);
        if (a === null) { missing(); return; }
        this.arcTo(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!);
        return;
      }
      case "rect": {
        const a = this.numbers(command, 4);
        if (a === null) { missing(); return; }
        this.appendUserPath(canvasRectPath(a[0]!, a[1]!, a[2]!, a[3]!, 0, 0), a[0]!, a[1]!);
        return;
      }
      case "roundRect": {
        const a = this.numbers(command, 5);
        if (a === null) { missing(); return; }
        this.appendUserPath(canvasRectPath(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[4]!), a[0]!, a[1]!);
        return;
      }
      case "fill":
      case "stroke": {
        if (this.path.length === 0) return;
        const entry = this.entryHead();
        entry.op = name;
        entry.path = [...this.path];
        if (name === "fill") {
          entry.style = this.state.fill;
          entry.rule = command[1] === "evenodd" ? "evenodd" : "nonzero";
        } else {
          entry.style = this.state.stroke;
          entry.lineWidth = this.state.lineWidth;
          entry.cap = this.state.cap;
          entry.join = this.state.join;
        }
        this.log.push(entry);
        return;
      }
      case "clip": {
        if (this.path.length === 0) return;
        this.state = {
          ...this.state,
          clip: { path: [...this.path], rule: command[1] === "evenodd" ? "evenodd" : "nonzero" },
        };
        return;
      }
      case "clear": {
        const entry = this.entryHead();
        entry.op = "clear";
        const a = this.numbers(command, 4);
        entry.rect = a === null ? null : [a[0]!, a[1]!, a[2]!, a[3]!];
        this.log.push(entry);
        return;
      }
      case "save":
        this.stack.push({ ...this.state });
        return;
      case "restore": {
        const popped = this.stack.pop();
        if (popped === undefined) { this.bad("canvas.ctx.restore: the state stack is empty"); return; }
        this.state = popped;
        return;
      }
      case "translate": {
        const a = this.numbers(command, 2);
        if (a === null) { missing(); return; }
        this.compose([1, 0, 0, 1, a[0]!, a[1]!]);
        return;
      }
      case "scale": {
        const a = this.numbers(command, 2);
        if (a === null) { missing(); return; }
        this.compose([a[0]!, 0, 0, a[1]!, 0, 0]);
        return;
      }
      case "rotate": {
        const a = this.numbers(command, 1);
        if (a === null) { missing(); return; }
        const r = a[0]! * DEG;
        this.compose([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
        return;
      }
      case "transform": {
        const a = this.numbers(command, 6);
        if (a === null) { missing(); return; }
        this.compose([a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!]);
        return;
      }
      case "drawImage": {
        const src = command[1];
        if (typeof src !== "string") { missing(); return; }
        const a = this.numbers(command, 2, 2);
        if (a === null) { missing(); return; }
        const size = this.numbers(command, 2, 4);
        const entry = this.entryHead();
        entry.op = "drawImage";
        entry.src = src;
        entry.x = a[0]!;
        entry.y = a[1]!;
        entry.width = size === null ? null : size[0]!;
        entry.height = size === null ? null : size[1]!;
        this.log.push(entry);
        return;
      }
      case "fillText":
      case "strokeText": {
        const text = command[1];
        if (typeof text !== "string") { missing(); return; }
        const a = this.numbers(command, 2, 2);
        if (a === null) { missing(); return; }
        const entry = this.entryHead();
        entry.op = name;
        entry.text = text;
        entry.x = a[0]!;
        entry.y = a[1]!;
        entry.style = name === "fillText" ? this.state.fill : this.state.stroke;
        entry.fontSize = this.state.fontSize;
        if (name === "strokeText") entry.lineWidth = this.state.lineWidth;
        this.log.push(entry);
        return;
      }
      case "measureText": {
        const text = command[1];
        if (typeof text !== "string") { missing(); return; }
        this.measurements.push(canvasFallbackMetrics(text, this.state.fontSize));
        return;
      }
      case "setFillStyle":
      case "setStrokeStyle": {
        const raw = command[1];
        if (typeof raw !== "string") { missing(); return; }
        const parsed = parseCanvasPaint(raw);
        if (parsed.paint === null) {
          if (!parsed.ok) this.bad(`canvas.ctx.${name}: unparseable colour '${raw}'`);
          return;
        }
        this.state = name === "setFillStyle"
          ? { ...this.state, fill: parsed.paint }
          : { ...this.state, stroke: parsed.paint };
        return;
      }
      case "setLineWidth": {
        const a = this.numbers(command, 1);
        if (a === null) { missing(); return; }
        this.state = { ...this.state, lineWidth: a[0]! };
        return;
      }
      case "setLineCap": {
        const raw = command[1];
        if (typeof raw !== "string") { missing(); return; }
        this.state = { ...this.state, cap: raw };
        return;
      }
      case "setLineJoin": {
        const raw = command[1];
        if (typeof raw !== "string") { missing(); return; }
        this.state = { ...this.state, join: raw };
        return;
      }
      case "setShadow": {
        const a = this.numbers(command, 3);
        const raw = command[4];
        if (a === null || typeof raw !== "string") { missing(); return; }
        const parsed = parseCanvasPaint(raw);
        this.state = {
          ...this.state,
          shadow: { dx: a[0]!, dy: a[1]!, radius: a[2]!, color: parsed.paint ?? CANVAS_BLACK },
        };
        return;
      }
      case "setBlendMode": {
        const raw = command[1];
        if (typeof raw !== "string") { missing(); return; }
        this.state = { ...this.state, blend: raw };
        return;
      }
      case "setGlobalAlpha": {
        const a = this.numbers(command, 1);
        if (a === null) { missing(); return; }
        this.state = { ...this.state, alpha: clampUnit(a[0]!) };
        return;
      }
      case "setFont": {
        const a = this.numbers(command, 1);
        if (a === null) { missing(); return; }
        this.state = { ...this.state, fontSize: a[0]! };
        return;
      }
      default:
        this.bad(`canvas.ctx: unknown method '${name}'`);
    }
  }

  private compose(local: CanvasMatrix): void {
    this.state = { ...this.state, ctm: canvasMatMul(this.state.ctm, local) };
  }

  /** a user-space subpath, every point baked through the CTM as it is added */
  private appendUserPath(segments: readonly CanvasSegment[], endX: number, endY: number): void {
    for (const seg of segments) {
      if (seg[0] === "Z") { this.path.push(["Z"]); continue; }
      const baked: number[] = [];
      for (let i = 1; i < seg.length; i += 2) {
        const p = this.baked(seg[i] as number, seg[i + 1] as number);
        baked.push(p[0], p[1]);
      }
      this.path.push([seg[0], ...baked] as unknown as CanvasSegment);
    }
    this.userX = endX;
    this.userY = endY;
    this.startX = endX;
    this.startY = endY;
    this.hasCurrent = true;
  }

  /** joins from the current point with a line, sweeps clockwise unless anticlockwise is
   *  set, clamps at a full turn, and folds to cubics through the same converter as `d` */
  private arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw: boolean): void {
    const start: [number, number] = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
    if (this.hasCurrent) this.lineTo(start[0], start[1]);
    else this.moveTo(start[0], start[1]);
    const full = 2 * Math.PI;
    let delta = a1 - a0;
    if (!ccw) {
      if (delta >= full) delta = full;
      else { delta %= full; if (delta < 0) delta += full; }
    } else if (delta <= -full) delta = -full;
    else { delta %= full; if (delta > 0) delta -= full; }
    if (delta === 0) return;
    const cubics = arcCentreToCubics(cx, cy, r, r, 0, a0, delta);
    this.appendUserCurves(cubics);
    const end: [number, number] = [cx + r * Math.cos(a0 + delta), cy + r * Math.sin(a0 + delta)];
    this.userX = end[0];
    this.userY = end[1];
  }

  private appendUserCurves(segments: readonly CanvasSegment[]): void {
    for (const seg of segments) {
      const baked: number[] = [];
      for (let i = 1; i < seg.length; i += 2) {
        const p = this.baked(seg[i] as number, seg[i + 1] as number);
        baked.push(p[0], p[1]);
      }
      this.path.push([seg[0], ...baked] as unknown as CanvasSegment);
    }
  }

  private arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (!this.hasCurrent) { this.moveTo(x1, y1); return; }
    const x0 = this.userX;
    const y0 = this.userY;
    const v1x = x0 - x1;
    const v1y = y0 - y1;
    const v2x = x2 - x1;
    const v2y = y2 - y1;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    const cross = v1x * v2y - v1y * v2x;
    if (l1 === 0 || l2 === 0 || r <= 0 || Math.abs(cross) < 1e-12) { this.lineTo(x1, y1); return; }
    const u1x = v1x / l1;
    const u1y = v1y / l1;
    const u2x = v2x / l2;
    const u2y = v2y / l2;
    const angle = Math.acos(Math.min(1, Math.max(-1, u1x * u2x + u1y * u2y)));
    const d = r / Math.tan(angle / 2);
    const t1x = x1 + u1x * d;
    const t1y = y1 + u1y * d;
    const t2x = x1 + u2x * d;
    const t2y = y1 + u2y * d;
    let bx = u1x + u2x;
    let by = u1y + u2y;
    const bl = Math.hypot(bx, by);
    if (bl === 0) { this.lineTo(x1, y1); return; }
    bx /= bl;
    by /= bl;
    const centreDistance = r / Math.sin(angle / 2);
    const cx = x1 + bx * centreDistance;
    const cy = y1 + by * centreDistance;
    this.lineTo(t1x, t1y);
    const theta1 = Math.atan2(t1y - cy, t1x - cx);
    const theta2 = Math.atan2(t2y - cy, t2x - cx);
    let delta = theta2 - theta1;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    this.appendUserCurves(arcCentreToCubics(cx, cy, r, r, 0, theta1, delta));
    this.userX = t2x;
    this.userY = t2y;
  }
}

export function runCanvasScript(script: readonly CanvasCommand[]): CanvasScriptResult {
  return new CanvasRecorder().run(script);
}

// ── `on:frame`: the display-link contract ────────────────────────────────────────────

/** the 60/s budget — the SAME constant the scene kernel uses, deliberately shared */
export const CANVAS_FRAME_MIN_INTERVAL_MS = 1000 / 60;

export type CanvasFramePayload = { readonly time: number; readonly delta: number; readonly frame: number };

export type CanvasFrameEvent =
  | { readonly type: "mount" }
  | { readonly type: "unmount" }
  | { readonly type: "visible"; readonly value: boolean }
  | { readonly type: "tick"; readonly at: number };

export type CanvasFrameFold = {
  emitted: CanvasFramePayload[];
  installs: number;
  uninstalls: number;
  installed: boolean;
};

/**
 * An always-running frame callback is a BATTERY BUG, so the law is enforced by fixture,
 * not by intent. The loop is installed ONLY while an `on:frame` handler is bound AND the
 * canvas is mounted AND it is on screen; ticks arriving while the loop is not installed
 * are DROPPED, never queued; `delta` is 0 on the first tick after every install and `time`
 * is accumulated delta, so it EXCLUDES offscreen intervals; `frame` counts emissions.
 */
export class CanvasFrameLoop {
  private mounted = false;
  private visible = true;
  private installedFlag = false;
  private lastEmitted: number | null = null;
  private time = 0;
  private frame = 0;

  installs = 0;
  uninstalls = 0;

  private bound: boolean;

  constructor(bound: boolean) {
    this.bound = bound;
  }

  get installed(): boolean {
    return this.installedFlag;
  }

  setBound(value: boolean): void {
    this.bound = value;
    this.settle();
  }

  setMounted(value: boolean): void {
    this.mounted = value;
    this.settle();
  }

  setVisible(value: boolean): void {
    this.visible = value;
    this.settle();
  }

  private settle(): void {
    const want = this.bound && this.mounted && this.visible;
    if (want && !this.installedFlag) {
      this.installedFlag = true;
      this.installs += 1;
      this.lastEmitted = null;
    } else if (!want && this.installedFlag) {
      this.installedFlag = false;
      this.uninstalls += 1;
    }
  }

  /** one raw platform tick (ms); the payload to emit, or null when dropped or coalesced */
  tick(nowMs: number): CanvasFramePayload | null {
    if (!this.installedFlag) return null;
    if (this.lastEmitted === null) {
      this.lastEmitted = nowMs;
      const payload = { time: this.time, delta: 0, frame: this.frame };
      this.frame += 1;
      return payload;
    }
    const gap = nowMs - this.lastEmitted;
    if (gap < CANVAS_FRAME_MIN_INTERVAL_MS) return null;
    this.lastEmitted = nowMs;
    const delta = gap / 1000;
    this.time += delta;
    const payload = { time: this.time, delta, frame: this.frame };
    this.frame += 1;
    return payload;
  }
}

/** the pure fold the corpus pins: a bound flag plus a lifecycle/tick event list */
export function canvasFrameSchedule(
  bound: boolean, events: readonly CanvasFrameEvent[],
): CanvasFrameFold {
  const loop = new CanvasFrameLoop(bound);
  const emitted: CanvasFramePayload[] = [];
  for (const event of events) {
    if (event.type === "mount") loop.setMounted(true);
    else if (event.type === "unmount") loop.setMounted(false);
    else if (event.type === "visible") loop.setVisible(event.value);
    else {
      const payload = loop.tick(event.at);
      if (payload !== null) emitted.push(payload);
    }
  }
  return { emitted, installs: loop.installs, uninstalls: loop.uninstalls, installed: loop.installed };
}

// ── accessibility ────────────────────────────────────────────────────────────────────

/** the gesture words that make a canvas INTERACTIVE. `on:draw` and `on:frame` are
 *  deliberately absent: a painted background is decorative. */
export const CANVAS_GESTURE_HANDLERS: readonly string[] = [
  "on:tap", "on:doubletap", "on:longpress", "on:drag", "on:pan",
  "on:pinch", "on:rotate", "on:swipe", "on:press", "on:adjust",
];

export const CANVAS_A11Y_LINT_CODE = "canvas-a11y-label";
export const CANVAS_A11Y_LINT_MESSAGE =
  "<canvas> with a gesture handler needs a11yLabel — a canvas is opaque to assistive tech";

export type CanvasA11yChild = {
  readonly role: string; readonly label: string; readonly value: string | null;
};

export type CanvasA11yLint = { readonly code: string; readonly level: string; readonly message: string };

export type CanvasA11yVerdict = {
  readonly interactive: boolean;
  readonly label: string | null;
  readonly children: CanvasA11yChild[];
  readonly role: "none" | "group" | "button" | "image";
  readonly hidden: boolean;
  readonly lint: CanvasA11yLint | null;
};

/**
 * A canvas is OPAQUE to assistive tech by construction — there is no view tree to inspect,
 * only pixels — so the semantics are declared or they do not exist. One fold, one rule,
 * three surfaces: this is what all three renderers apply AND what `lint_dsx.rb` enforces.
 */
export function canvasA11y(
  attrs: { readonly [name: string]: unknown },
  a11yChildren?: readonly { role?: string; label?: string; value?: string | null }[] | null,
): CanvasA11yVerdict {
  const interactive = CANVAS_GESTURE_HANDLERS.some((name) => {
    const raw = attrs[name];
    return raw !== undefined && raw !== null && String(raw).trim() !== "";
  });
  const rawLabel = attrs["a11yLabel"];
  const trimmed = rawLabel === undefined || rawLabel === null ? "" : String(rawLabel).trim();
  const label = trimmed === "" ? null : trimmed;
  const children: CanvasA11yChild[] = (a11yChildren ?? []).map((child) => ({
    role: child.role ?? "image",
    label: child.label ?? "",
    value: child.value ?? null,
  }));
  const declared = label !== null || children.length > 0;
  const role: CanvasA11yVerdict["role"] = children.length > 0
    ? "group"
    : interactive
      ? (label !== null ? "button" : "group")
      : (label !== null ? "image" : "none");
  return {
    interactive,
    label,
    children,
    role,
    hidden: !interactive && !declared,
    lint: interactive && !declared
      ? { code: CANVAS_A11Y_LINT_CODE, level: "error", message: CANVAS_A11Y_LINT_MESSAGE }
      : null,
  };
}
