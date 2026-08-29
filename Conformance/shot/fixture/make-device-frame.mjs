//
//  make-device-frame.mjs - a NEUTRAL DEVICE FRAME, rendered with real geometry.
//
//  A CSS rounded rectangle cannot be a device, for reasons that are specific rather than
//  aesthetic: `border-radius` draws a CIRCULAR corner where every phone shipped this decade
//  uses a squircle, a gradient border has no thickness so the chassis has no edge, and one
//  box-shadow is a blur rather than a shadow.
//
//  This draws the object:
//    - SUPERELLIPSE corners (|dx/r|^n + |dy/r|^n = 1, n = 5), the continuous-corner geometry
//    - a chassis lit by a SURFACE NORMAL, not by screen position: each edge pixel's outward
//      normal is dotted against a top-left key light, so the rail is bright along the top and
//      left, dark along the bottom and right, and curves continuously around every corner.
//      Position-based shading cannot do this - it produces a diagonal wash that looks painted
//      on rather than an edge that catches light.
//    - a rail that steps down into a black bezel, so the glass sits INSIDE the body
//    - side buttons on the silhouette, in a canvas with margin so they can protrude; the
//      outline is what reads as "phone" at thumbnail size more than any surface treatment
//    - 3x supersampled coverage, so curves are genuinely anti-aliased
//
//  Output is RGBA with a fully transparent screen window; the shot renderer composites a
//  screenshot behind it through the same `mockup=` path a studio's own licensed art uses.
//  zlib only: no image library, nothing vendored, reproducible from this file.
//
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : Number(hit.split("=")[1]);
};
const flag = (name) => process.argv.includes(`--${name}`);

const SCREEN_W = arg("screenW", 440);
const SCREEN_H = arg("screenH", 956);
const BEZEL = arg("bezel", 14);          // black border between glass and rail
const RAIL = arg("rail", 7);             // the metal band outboard of the bezel
const N = arg("n", 5);                   // superellipse exponent
const R_OUT = arg("radius", 104);
const MARGIN = arg("margin", 8);         // room for buttons to protrude
const SS = 3;
const ANDROID = flag("android");

const BODY_W = SCREEN_W + (BEZEL + RAIL) * 2;
const BODY_H = SCREEN_H + (BEZEL + RAIL) * 2;
const W = BODY_W + MARGIN * 2;
const H = BODY_H + MARGIN * 2;
const INSET = RAIL + BEZEL;

/** Inside the body silhouette, inset by `inset` pixels. The inset is applied to the EDGES and
 *  the radius, never by shrinking the rect around a moving centre - doing that keeps every
 *  left/top pixel exactly on the boundary at every depth, so the rail simply never resolves
 *  there. That bug shipped a frame with a chassis on two sides only. */
function insideBody(px, py, inset) {
  const x0 = MARGIN + inset, y0 = MARGIN + inset;
  const x1 = MARGIN + BODY_W - inset, y1 = MARGIN + BODY_H - inset;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const r = Math.max(R_OUT - inset, 1);
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
  if (dx === 0 || dy === 0) return true;
  return Math.pow(dx / r, N) + Math.pow(dy / r, N) <= 1;
}

function insideScreen(px, py) {
  const x0 = MARGIN + INSET, y0 = MARGIN + INSET;
  const x1 = x0 + SCREEN_W, y1 = y0 + SCREEN_H;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const r = Math.max(R_OUT - INSET, 1);
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
  if (dx === 0 || dy === 0) return true;
  return Math.pow(dx / r, N) + Math.pow(dy / r, N) <= 1;
}

/** How deep inside the silhouette this point is, in pixels. */
function depth(px, py) {
  if (!insideBody(px, py, 0)) return -1;
  for (let d = 1; d <= INSET; d += 1) if (!insideBody(px, py, d)) return d - 1;
  return INSET;
}

/** The outward surface normal at an edge pixel, from the local gradient of the silhouette.
 *  This is what makes the rail read as a rounded edge rather than a painted stripe. */
function normal(px, py) {
  const e = 1.5;
  const gx = (insideBody(px + e, py, 0) ? 0 : 1) - (insideBody(px - e, py, 0) ? 0 : 1);
  const gy = (insideBody(px, py + e, 0) ? 0 : 1) - (insideBody(px, py - e, 0) ? 0 : 1);
  if (gx === 0 && gy === 0) {
    const cx = MARGIN + BODY_W / 2, cy = MARGIN + BODY_H / 2;
    const vx = px - cx, vy = py - cy;
    const len = Math.hypot(vx, vy) || 1;
    return [vx / len, vy / len];
  }
  const len = Math.hypot(gx, gy) || 1;
  return [gx / len, gy / len];
}

// Key light from the top-left, slightly in front.
const LX = -0.62, LY = -0.78;

const buttons = ANDROID
  ? [{ side: 1, y: 0.26, h: 0.075 }, { side: 1, y: 0.355, h: 0.13 }]
  : [{ side: -1, y: 0.20, h: 0.045 }, { side: -1, y: 0.275, h: 0.085 },
     { side: -1, y: 0.375, h: 0.085 }, { side: 1, y: 0.30, h: 0.125 }];

function insideButton(px, py) {
  for (const b of buttons) {
    const y0 = MARGIN + b.y * BODY_H, y1 = y0 + b.h * BODY_H;
    if (py < y0 - 2 || py > y1 + 2) continue;
    const r = 3;
    const cy = Math.min(Math.max(py, y0 + r), y1 - r);
    if (Math.abs(py - cy) > r) continue;
    const x0 = b.side < 0 ? MARGIN - 5 : MARGIN + BODY_W - 2;
    const x1 = b.side < 0 ? MARGIN + 2 : MARGIN + BODY_W + 5;
    if (px >= x0 && px <= x1) return b.side;
  }
  return 0;
}

function sample(px, py) {
  if (insideScreen(px, py)) return [0, 0, 0, 0];
  const d = depth(px, py);
  const btn = insideButton(px, py);

  if (d < 0) {
    if (btn === 0) return [0, 0, 0, 0];
    // A button is a small rounded bar, so it gets its own cross-section shading rather than a
    // flat fill: bright where its face turns toward the key light, falling off across its
    // width. A flat tab reads as a sticker on the silhouette.
    const bx = btn < 0 ? MARGIN + 2 - px : px - (MARGIN + BODY_W - 2);
    const across = Math.min(Math.max(bx / 5, 0), 1);
    const face = btn < 0 ? 1 - across * 0.55 : 0.30 + across * 0.18;
    const v = Math.round(34 + face * 150);
    return [v, v, v + 7, 255];
  }

  const [nx, ny] = normal(px, py);
  //  1 facing the light, -1 facing away. Squared-ish falloff keeps the lit side from blowing out.
  const lambert = Math.max(0, nx * LX + ny * LY);
  const rim = Math.pow(lambert, 0.75);
  const away = Math.max(0, -(nx * LX + ny * LY));

  if (d <= RAIL) {
    // The metal rail: a bright specular line at the very edge falling to a machined mid tone,
    // plus a dark occlusion on the side facing away from the light.
    const t = d / RAIL;                                  // 0 at the outer edge
    const base = 132 - t * 70;
    // AMBIENT FLOOR. A key light alone drove the unlit side to near-black, so the chassis
    // simply vanished on the right and bottom and the phone read as lit from one side only.
    // Real metal in a real room takes bounce; without a floor term the shading is technically
    // a lambert and visually a mistake.
    const v = Math.round(Math.min(240,
      base * (0.52 + rim * 0.92) + (1 - t) * rim * 66 - away * base * 0.07));
    return [Math.max(14, v), Math.max(14, v), Math.max(16, v + 7), 255];
  }
  // The bezel: near-black, with the faintest inner occlusion where it meets the glass.
  const t = Math.min((d - RAIL) / Math.max(BEZEL - 1, 1), 1);
  const v = Math.round(17 - t * 9 + rim * 4);
  return [v, v, v + 2, 255];
}

const rgba = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += sr * sa; g += sg * sa; b += sb * sa; a += sa;
      }
    }
    const i = (y * W + x) * 4;
    if (a > 0) { rgba[i] = Math.round(r / a); rgba[i + 1] = Math.round(g / a); rgba[i + 2] = Math.round(b / a); }
    rgba[i + 3] = Math.round(a / (SS * SS));
  }
}

const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const table = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(process.argv[2] ?? "device-frame.png", Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]));

const left = MARGIN + INSET, top = MARGIN + INSET;
console.log(JSON.stringify({
  file: process.argv[2], art: `${W}x${H}`, screen: `${SCREEN_W}x${SCREEN_H}`,
  screenTop: `${(top / H * 100).toFixed(3)}%`, screenLeft: `${(left / W * 100).toFixed(3)}%`,
  screenWidth: `${(SCREEN_W / W * 100).toFixed(3)}%`, screenHeight: `${(SCREEN_H / H * 100).toFixed(3)}%`,
  windowAspect: (SCREEN_W / SCREEN_H).toFixed(5),
}, null, 1));
