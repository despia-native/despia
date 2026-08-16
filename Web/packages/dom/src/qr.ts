//
//  qr.ts - dependency-free QR encoder for the web `<qrcode>` element.
//
//  Byte mode, QR versions 1...10 and all four ISO/IEC 18004 correction levels are
//  supported.  The renderer deliberately fails closed when a payload does not fit
//  that bounded surface instead of drawing a decorative, unscannable approximation.
//  All eight masks are scored and the deterministic lowest-penalty result is used so
//  repetitive production payloads remain easy for low-quality cameras to acquire.
//


export type QrCorrection = "L" | "M" | "Q" | "H";

export type QrMatrix = {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly modules: ReadonlyArray<ReadonlyArray<boolean>>;
};

const ECC_CODEWORDS_PER_BLOCK: Readonly<Record<QrCorrection, readonly number[]>> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

const NUM_ERROR_CORRECTION_BLOCKS: Readonly<Record<QrCorrection, readonly number[]>> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

const FORMAT_BITS: Readonly<Record<QrCorrection, number>> = { L: 1, M: 0, Q: 3, H: 2 };

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, correction: QrCorrection): number {
  return Math.floor(rawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[correction]![version]!
      * NUM_ERROR_CORRECTION_BLOCKS[correction]![version]!;
}

class Bits {
  readonly values: number[] = [];

  append(value: number, length: number): void {
    if (length < 0 || length > 31 || value >>> length !== 0) throw new RangeError("invalid QR bit value");
    for (let i = length - 1; i >= 0; i--) this.values.push((value >>> i) & 1);
  }
}

function makeData(bytes: Uint8Array, version: number, correction: QrCorrection): Uint8Array {
  const capacity = dataCodewords(version, correction) * 8;
  const bits = new Bits();
  bits.append(0x4, 4); // byte mode
  bits.append(bytes.length, version <= 9 ? 8 : 16);
  for (const value of bytes) bits.append(value, 8);
  if (bits.values.length > capacity) throw new RangeError("QR payload exceeds selected version");
  bits.append(0, Math.min(4, capacity - bits.values.length));
  while (bits.values.length % 8 !== 0) bits.values.push(0);

  const result: number[] = [];
  for (let i = 0; i < bits.values.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits.values[i + j]!;
    result.push(value);
  }
  for (let pad = 0; result.length < capacity / 8; pad++) result.push(pad % 2 === 0 ? 0xec : 0x11);
  return Uint8Array.from(result);
}

function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j]!, root);
      if (j + 1 < degree) result[j] ^= result[j + 1]!;
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const value of data) {
    const factor = value ^ result[0]!;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= multiply(divisor[i]!, factor);
  }
  return result;
}

function addEccAndInterleave(data: Uint8Array, version: number, correction: QrCorrection): Uint8Array {
  const blocks = NUM_ERROR_CORRECTION_BLOCKS[correction]![version]!;
  const eccLength = ECC_CODEWORDS_PER_BLOCK[correction]![version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - rawCodewords % blocks;
  const shortBlockLength = Math.floor(rawCodewords / blocks);
  const divisor = rsDivisor(eccLength);
  const parts: Uint8Array[] = [];
  let offset = 0;

  for (let i = 0; i < blocks; i++) {
    const dataLength = shortBlockLength - eccLength + (i < shortBlocks ? 0 : 1);
    const blockData = data.slice(offset, offset + dataLength);
    offset += dataLength;
    const ecc = rsRemainder(blockData, divisor);
    const part = new Uint8Array(shortBlockLength + 1);
    part.set(blockData);
    part.set(ecc, blockData.length + (i < shortBlocks ? 1 : 0));
    parts.push(part);
  }
  if (offset !== data.length) throw new Error("QR interleave invariant failed");

  const result: number[] = [];
  for (let i = 0; i < parts[0]!.length; i++) {
    for (let j = 0; j < parts.length; j++) {
      if (i !== shortBlockLength - eccLength || j >= shortBlocks) result.push(parts[j]![i]!);
    }
  }
  if (result.length !== rawCodewords) throw new Error("QR codeword count invariant failed");
  return Uint8Array.from(result);
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32
    ? 26
    : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

class MatrixBuilder {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly functionModules: boolean[][];
  private readonly version: number;
  private readonly correction: QrCorrection;

  constructor(version: number, correction: QrCorrection) {
    this.version = version;
    this.correction = correction;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
    this.functionModules = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.functionModules[y]![x] = true;
  }

  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFunction(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  private alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  functionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(this.size - 4, 3);
    this.finder(3, this.size - 4);

    const positions = alignmentPositions(this.version);
    for (let i = 0; i < positions.length; i++) {
      for (let j = 0; j < positions.length; j++) {
        if ((i === 0 && j === 0)
          || (i === 0 && j === positions.length - 1)
          || (i === positions.length - 1 && j === 0)) continue;
        this.alignment(positions[i]!, positions[j]!);
      }
    }
    this.format(0);
    this.versionBits();
  }

  private format(mask: number): void {
    const data = (FORMAT_BITS[this.correction] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true);
  }

  private versionBits(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + i % 3;
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  data(codewords: Uint8Array): void {
    let bitIndex = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? this.size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (this.functionModules[y]![x] || bitIndex >= codewords.length * 8) continue;
          const dark = ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) !== 0;
          this.modules[y]![x] = dark;
          bitIndex++;
        }
      }
    }
    if (bitIndex !== codewords.length * 8) throw new Error("QR placement invariant failed");
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.functionModules[y]![x]) continue;
        const product = x * y;
        const invert = mask === 0 ? (x + y) % 2 === 0
          : mask === 1 ? y % 2 === 0
          : mask === 2 ? x % 3 === 0
          : mask === 3 ? (x + y) % 3 === 0
          : mask === 4 ? (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
          : mask === 5 ? product % 2 + product % 3 === 0
          : mask === 6 ? (product % 2 + product % 3) % 2 === 0
          : ((x + y) % 2 + product % 3) % 2 === 0;
        this.modules[y]![x] = this.modules[y]![x] !== invert;
      }
    }
  }

  private penalty(): number {
    let result = 0;
    const lines: boolean[][] = [
      ...this.modules,
      ...Array.from({ length: this.size }, (_, x) => this.modules.map((row) => row[x]!)),
    ];
    for (const line of lines) {
      let runColor = line[0]!;
      let runLength = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === runColor) {
          runLength++;
        } else {
          if (runLength >= 5) result += runLength - 2;
          if (i < line.length) { runColor = line[i]!; runLength = 1; }
        }
      }
      for (let i = 0; i + 6 < line.length; i++) {
        if (line[i] && !line[i + 1] && line[i + 2] && line[i + 3]
          && line[i + 4] && !line[i + 5] && line[i + 6]) {
          const before = i < 4 || line.slice(i - 4, i).every((value) => !value);
          const after = i + 11 > line.length || line.slice(i + 7, i + 11).every((value) => !value);
          if (before || after) result += 40;
        }
      }
    }
    for (let y = 0; y + 1 < this.size; y++) {
      for (let x = 0; x + 1 < this.size; x++) {
        const color = this.modules[y]![x]!;
        if (this.modules[y]![x + 1] === color
          && this.modules[y + 1]![x] === color
          && this.modules[y + 1]![x + 1] === color) result += 3;
      }
    }
    const dark = this.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = this.size * this.size;
    result += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }

  selectMask(): number {
    let bestMask = 0;
    let bestPenalty = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.format(mask);
      const score = this.penalty();
      if (score < bestPenalty) { bestPenalty = score; bestMask = mask; }
      this.applyMask(mask);
    }
    this.applyMask(bestMask);
    this.format(bestMask);
    return bestMask;
  }
}

function encodedCodewords(value: string, correction: QrCorrection): { version: number; codewords: Uint8Array } {
  const normalized = correction.toUpperCase() as QrCorrection;
  if (!(normalized in ECC_CODEWORDS_PER_BLOCK)) throw new RangeError(`invalid QR correction level: ${correction}`);
  const bytes = new TextEncoder().encode(value);
  let version = 0;
  for (let candidate = 1; candidate <= 10; candidate++) {
    const countBits = candidate <= 9 ? 8 : 16;
    if (bytes.length < 2 ** countBits
      && 4 + countBits + bytes.length * 8 <= dataCodewords(candidate, normalized) * 8) {
      version = candidate;
      break;
    }
  }
  if (version === 0) {
    throw new RangeError("QR payload is too long for the built-in version 1-10 encoder");
  }
  return {
    version,
    codewords: addEccAndInterleave(makeData(bytes, version, normalized), version, normalized),
  };
}

export function qrMatrix(value: string, correction: QrCorrection = "M"): QrMatrix {
  const normalized = correction.toUpperCase() as QrCorrection;
  const encoded = encodedCodewords(value, normalized);
  const version = encoded.version;
  const builder = new MatrixBuilder(version, normalized);
  builder.functionPatterns();
  builder.data(encoded.codewords);
  const mask = builder.selectMask();
  return { version, size: builder.size, mask, modules: builder.modules };
}
