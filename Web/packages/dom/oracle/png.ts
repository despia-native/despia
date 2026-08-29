//
//  png.ts - decode a PNG far enough to compare two of them, with no dependency.
//
//  The appearance gate has to diff images, and every image library in reach is either a
//  transitive dependency nobody declared or a native build. Playwright writes 8-bit RGB or
//  RGBA, non-interlaced, so the subset that has to be understood here is small: the IHDR
//  header, the concatenated IDAT stream, and the five per-row filters PNG defines. zlib is
//  in node. That is the whole decoder.
//
//  It REFUSES what it cannot read rather than guessing. An interlaced or 16-bit or paletted
//  file throws by name, because a comparator that silently mis-decodes one side reports a
//  difference that is not there, and a flaky appearance gate is worse than none.
//

import { inflateSync } from "node:zlib";

export type Raster = { width: number; height: number; channels: 4; data: Uint8Array };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Paeth, straight from the PNG spec: the neighbour the prediction lands closest to. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer, label: string): Raster {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`${label}: not a PNG`);
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]!; colorType = body[9]!; interlace = body[12]!;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;                                  // len + type + body + crc
  }
  if (depth !== 8) throw new Error(`${label}: ${depth}-bit PNG, this decoder reads 8-bit only`);
  if (interlace !== 0) throw new Error(`${label}: interlaced PNG is not supported`);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`${label}: colour type ${colorType}, this decoder reads RGB and RGBA only`);
  }
  const src = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * src;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    raw.copy(line, 0, p, p + stride); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= src ? line[i - src]! : 0;
      const b = prev[i]!;
      const c = i >= src ? prev[i - src]! : 0;
      const x = line[i]!;
      line[i] = filter === 0 ? x
        : filter === 1 ? (x + a) & 0xff
        : filter === 2 ? (x + b) & 0xff
        : filter === 3 ? (x + ((a + b) >> 1)) & 0xff
        : filter === 4 ? (x + paeth(a, b, c)) & 0xff
        : (() => { throw new Error(`${label}: unknown row filter ${filter} at row ${y}`); })();
    }
    for (let x = 0; x < width; x++) {
      const s = x * src, d = (y * width + x) * 4;
      out[d] = line[s]!; out[d + 1] = line[s + 1]!; out[d + 2] = line[s + 2]!;
      out[d + 3] = src === 4 ? line[s + 3]! : 255;
    }
    prev.set(line);
  }
  return { width, height, channels: 4, data: out };
}

export type PixelDiff = {
  /** Pixels whose colour moved further than `perChannel` on any channel. */
  changed: number;
  /** changed / total, the number the threshold is set against. */
  fraction: number;
  total: number;
  /** The bounding box of everything that moved, so a report can say WHERE. */
  box: { x: number; y: number; w: number; h: number } | null;
};

/** Compare two rasters. `perChannel` absorbs the last bit of antialiasing noise without
 *  absorbing a real colour change: 2/255 is below any deliberate palette step. */
export function diffRaster(a: Raster, b: Raster, perChannel = 2): PixelDiff {
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: -1, fraction: 1, total: a.width * a.height, box: null };
  }
  let changed = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0, px = 0; i < a.data.length; i += 4, px++) {
    if (Math.abs(a.data[i]! - b.data[i]!) <= perChannel
      && Math.abs(a.data[i + 1]! - b.data[i + 1]!) <= perChannel
      && Math.abs(a.data[i + 2]! - b.data[i + 2]!) <= perChannel
      && Math.abs(a.data[i + 3]! - b.data[i + 3]!) <= perChannel) continue;
    changed++;
    const x = px % a.width, y = (px / a.width) | 0;
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const total = a.width * a.height;
  return {
    changed,
    fraction: total === 0 ? 0 : changed / total,
    total,
    box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
  };
}
