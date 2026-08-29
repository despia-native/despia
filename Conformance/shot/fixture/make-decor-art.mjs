//
//  make-decor-art.mjs - the drawn marks a store slide needs and CSS cannot make.
//
//  A laurel wreath is two curved branches of rotated leaves; a curved arrow is a swept stroke
//  with a solid head. Both are geometry, both are in every reference set, and neither is
//  expressible as a border-radius. Drawn here at 3x supersample, emitted as RGBA with a
//  transparent ground so a slide composites them anywhere.
//
//  Deliberately NOT a store award mark: no Play laurel, no App Store badge, no wording that
//  implies an editorial award. A laurel is a generic decorative device, and what it encloses
//  is a claim the customer can substantiate.
//
//  zlib only. No image library, nothing vendored, reproducible from this file.
//
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SS = 3;
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h === undefined ? d : h.split("=")[1]; };

function encode(W, H, rgba, path) {
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const table = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(t, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

/** Supersampled rasteriser: `f(x,y)` returns [r,g,b,a] or null. */
function raster(W, H, f) {
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const s = f(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      if (s === null) continue;
      r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
    }
    const i = (y * W + x) * 4;
    if (a > 0) { rgba[i] = Math.round(r / a); rgba[i + 1] = Math.round(g / a); rgba[i + 2] = Math.round(b / a); }
    rgba[i + 3] = Math.round(a / (SS * SS));
  }
  return rgba;
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// ── the laurel: two mirrored branches of rotated leaves ─────────────────────────────
function laurel(colour, W = 360, H = 300) {
  const [cr, cg, cb] = hex(colour);
  const leaves = [];
  const CX = W / 2, CY = H * 0.50;
  const RX = W * 0.34, RY = H * 0.40;
  // A wreath is two arcs that START AT THE BOTTOM and open at the top. Parameterise from the
  // bottom (a = 0) upward, so x = CX + side*RX*sin(a) and y = CY + RY*cos(a): at a = 0 both
  // sides meet at the base, and at a = 2.5 they are high on each flank with a gap between.
  // The first version swept from 0.52pi to 1.32pi, which is most of a circle starting at the
  // side - it scattered leaves across the whole box instead of drawing a wreath.
  const A0 = 0.18, A1 = 2.52, COUNT = 13;
  for (const side of [-1, 1]) {
    for (let i = 0; i <= COUNT; i++) {
      const t = i / COUNT;
      const a = A0 + t * (A1 - A0);
      const px = CX + side * RX * Math.sin(a);
      const py = CY + RY * Math.cos(a);
      // The tangent of the branch at this point, so a leaf lies ALONG the stem rather than at
      // a fixed angle - that is the difference between a wreath and a ring of petals.
      const tx = side * RX * Math.cos(a), ty = -RY * Math.sin(a);
      const tang = Math.atan2(ty, tx);
      const size = 6.5 + Math.sin(Math.min(t, 0.92) * Math.PI) * 8.5;
      // two leaves per node, splayed off the stem to each side
      for (const splay of [0.62, -0.62]) {
        const rot = tang + splay * side;
        const off = size * 0.62;
        leaves.push({
          x: px + Math.cos(rot) * off, y: py + Math.sin(rot) * off,
          rx: size, ry: size * 0.40, rot,
        });
      }
    }
    // the stem itself, a thin continuous arc
    for (let i = 0; i <= 90; i++) {
      const a = A0 + (i / 90) * (A1 - A0);
      leaves.push({ x: CX + side * RX * Math.sin(a), y: CY + RY * Math.cos(a), rx: 1.7, ry: 1.7, rot: 0 });
    }
  }
  return { W, H, f: (x, y) => {
    for (const l of leaves) {
      const dx = x - l.x, dy = y - l.y;
      const c = Math.cos(-l.rot), s = Math.sin(-l.rot);
      const ux = (dx * c - dy * s) / l.rx, uy = (dx * s + dy * c) / l.ry;
      if (ux * ux + uy * uy <= 1) return [cr, cg, cb, 255];
    }
    return null;
  } };
}

// ── the curved arrow: a swept stroke with a solid head ──────────────────────────────
function arrow(colour, W = 260, H = 200, bend = 0.5, flip = false) {
  const [cr, cg, cb] = hex(colour);
  const P0 = { x: W * 0.06, y: H * 0.12 };
  const P2 = { x: W * 0.88, y: H * 0.84 };
  const P1 = { x: W * (flip ? 0.86 : 0.10), y: H * (flip ? 0.14 : 0.86) * bend + H * 0.2 };
  const at = (t) => ({
    x: (1 - t) ** 2 * P0.x + 2 * (1 - t) * t * P1.x + t * t * P2.x,
    y: (1 - t) ** 2 * P0.y + 2 * (1 - t) * t * P1.y + t * t * P2.y,
  });
  const pts = [];
  for (let i = 0; i <= 160; i++) pts.push({ ...at(i / 160), t: i / 160 });
  const tip = at(1), before = at(0.955);
  const ang = Math.atan2(tip.y - before.y, tip.x - before.x);
  const HEAD = W * 0.115;
  const head = [tip,
    { x: tip.x - HEAD * Math.cos(ang - 0.42), y: tip.y - HEAD * Math.sin(ang - 0.42) },
    { x: tip.x - HEAD * Math.cos(ang + 0.42), y: tip.y - HEAD * Math.sin(ang + 0.42) }];
  const inTri = (px, py, [a, b, c]) => {
    const d = (p, q, r) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
    const d1 = d({ x: px, y: py }, a, b), d2 = d({ x: px, y: py }, b, c), d3 = d({ x: px, y: py }, c, a);
    return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
  };
  return { W, H, f: (x, y) => {
    if (inTri(x, y, head)) return [cr, cg, cb, 255];
    for (const p of pts) {
      if (p.t > 0.94) continue;                       // the head owns the tip
      const w = (2.4 + p.t * 2.6);                    // the stroke thickens toward the head
      const dx = x - p.x, dy = y - p.y;
      if (dx * dx + dy * dy <= w * w) return [cr, cg, cb, 255];
    }
    return null;
  } };
}

const kind = arg("kind", "laurel");
const colour = arg("colour", "#111318");
const out = process.argv[2] ?? `${kind}.png`;
const spec = kind === "laurel" ? laurel(colour)
  : arrow(colour, 260, 200, Number(arg("bend", "0.5")), arg("flip", "0") === "1");
encode(spec.W, spec.H, raster(spec.W, spec.H, spec.f), out);
console.log(`${out} ${spec.W}x${spec.H} ${kind} ${colour}`);
