// A stand-in app logo: a squircle tile with a mark, so the decoration layer can be tested with
// a real customer-shaped asset. zlib only, same as the device frame generator.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
const S = 320, R = 74, N = 5, SS = 3;
const sq = (px, py, x0, y0, x1, y1, r) => {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r), cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
  if (dx === 0 || dy === 0) return true;
  return (dx / r) ** N + (dy / r) ** N <= 1;
};
const rgba = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
    if (!sq(px, py, 0, 0, S, S, R)) continue;
    const t = py / S;
    let cr = Math.round(112 + t * 24), cg = Math.round(94 - t * 30), cb = Math.round(252 - t * 20);
    // the mark: a rounded chevron, offset so it reads at 40px
    const mx = px - S / 2, my = py - S / 2;
    const onMark = Math.abs(Math.abs(mx) * 0.92 + my + 26) < 21 && my < 52 && Math.abs(mx) < 84;
    if (onMark) { cr = 255; cg = 255; cb = 255; }
    r += cr; g += cg; b += cb; a += 255;
  }
  const n = SS * SS, i = (y * S + x) * 4;
  if (a > 0) { rgba[i] = Math.round(r / (a / 255)); rgba[i + 1] = Math.round(g / (a / 255)); rgba[i + 2] = Math.round(b / (a / 255)); }
  rgba[i + 3] = Math.round(a / n);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const table = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(t, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(process.argv[2] ?? "logo.png", Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
console.log(`wrote ${process.argv[2]} ${S}x${S}`);
