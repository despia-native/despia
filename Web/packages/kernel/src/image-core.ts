//
//  image-core.ts — the `<image>` PURE CORE (U05). Everything the three renderers must agree
//  on before a single pixel is drawn: the contentFit x contentPosition geometry solver, the
//  cache-policy ladder (with the legacy binary `cache` folded in), the transition gate, the
//  decode-at-display-size ladder, placeholder classification, the recycling identity, and the
//  blurhash / thumbhash decoders.
//
//  The law is the corpus, OpenSource/Conformance/image/resolution.json
//  (parity/U05-image.md); the Kotlin twin is :core ImageCore.kt and the Swift twin is
//  Engine/iOS/ImageCore.swift. Everything platform-shaped lives OUTSIDE this file — the actual
//  network fetch, the NSCache/LruCache, ImageIO/BitmapFactory, `<img>` — because keeping the
//  DECISION separate from the PLUMBING is what lets one corpus judge three renderers.
//
//  The two hash decoders are re-implementations of the published BlurHash (Wolt, MIT) and
//  ThumbHash (Evan Wallace, MIT) formats. Nothing is vendored: this file is original code that
//  reads the same bytes, cross-checked against the reference algorithms and then pinned to
//  exact RGBA in the corpus, because a placeholder that differs per platform is worse than no
//  placeholder at all.
//

/** The five content modes, `cover` first because it is the default and today's behaviour. */
export type ContentFit = "cover" | "contain" | "fill" | "none" | "scaleDown";
export const CONTENT_FITS: readonly ContentFit[] = ["cover", "contain", "fill", "none", "scaleDown"];

/** The four cache policies. `memoryDisk` is the default; the legacy `cache="none"` folds to `none`. */
export type CachePolicy = "memory" | "disk" | "memoryDisk" | "none";
export const CACHE_POLICIES: readonly CachePolicy[] = ["memory", "disk", "memoryDisk", "none"];

/** Where a decoded image came from — reported to `on:load` and, crucially, the transition gate. */
export type CacheType = "memory" | "disk" | "none";

/** Fetch priority. A hero is `high`, an offscreen row is `low`; the queue is per-renderer. */
export type ImagePriority = "low" | "normal" | "high";
export const IMAGE_PRIORITIES: readonly ImagePriority[] = ["low", "normal", "high"];

/** The transition vocabulary. `crossDissolve` is the default and the only one every target
 *  realises natively; the flips and curls degrade to a cross-dissolve where they cannot. */
export type TransitionEffect =
  | "none" | "crossDissolve"
  | "flipFromLeft" | "flipFromRight" | "flipFromTop" | "flipFromBottom"
  | "curlUp" | "curlDown";
export const TRANSITION_EFFECTS: readonly TransitionEffect[] = [
  "none", "crossDissolve", "flipFromLeft", "flipFromRight",
  "flipFromTop", "flipFromBottom", "curlUp", "curlDown",
];

export interface ImageSize { readonly width: number; readonly height: number }
export interface ImageRect {
  readonly x: number; readonly y: number;
  readonly width: number; readonly height: number;
  /** The factor the source was multiplied by. 0 for `fill`, whose aspect ratio is not preserved. */
  readonly scale: number;
}

export const CONTENT_FIT_DEFAULT: ContentFit = "cover";
export const CONTENT_POSITION_DEFAULT = "center";
export const CACHE_POLICY_DEFAULT: CachePolicy = "memoryDisk";
export const TRANSITION_DURATION_DEFAULT = 200;

/** The named anchors, as fractions of the free space. Twin of the Kotlin/Swift tables. */
export const POSITION_ANCHORS: { readonly [name: string]: { readonly x: number; readonly y: number } } = {
  center: { x: 0.5, y: 0.5 },
  top: { x: 0.5, y: 0 },
  bottom: { x: 0.5, y: 1 },
  leading: { x: 0, y: 0.5 },
  left: { x: 0, y: 0.5 },
  trailing: { x: 1, y: 0.5 },
  right: { x: 1, y: 0.5 },
  topLeading: { x: 0, y: 0 },
  topTrailing: { x: 1, y: 0 },
  bottomLeading: { x: 0, y: 1 },
  bottomTrailing: { x: 1, y: 1 },
};

/** Unknown word folds to `cover` — an image is never not drawn because a token was misspelled. */
export function resolveContentFit(fit: string | null | undefined): ContentFit {
  const word = (fit ?? "").trim();
  return (CONTENT_FITS as readonly string[]).includes(word) ? (word as ContentFit) : CONTENT_FIT_DEFAULT;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function positionScalar(token: string): number | null {
  const text = token.trim();
  if (text === "") return null;
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    return Number.isFinite(percent) ? clamp01(percent / 100) : null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? clamp01(value) : null;
}

/**
 * `contentPosition` → the anchor fractions the drawn rect is placed at. A named anchor, or an
 * `x y` pair in percentages or 0…1 fractions. Anything unparseable is `center`, because an
 * off-screen image is a worse failure than a mis-anchored one.
 */
export function resolveContentPosition(position: string | null | undefined): { x: number; y: number } {
  const text = (position ?? "").trim();
  if (text === "") return { x: 0.5, y: 0.5 };
  const anchor = POSITION_ANCHORS[text];
  if (anchor) return { x: anchor.x, y: anchor.y };
  const parts = text.replace(/,/g, " ").split(" ").filter((part) => part !== "");
  if (parts.length === 1) {
    const only = positionScalar(parts[0]!);
    return only === null ? { x: 0.5, y: 0.5 } : { x: only, y: 0.5 };
  }
  if (parts.length >= 2) {
    const x = positionScalar(parts[0]!);
    const y = positionScalar(parts[1]!);
    if (x === null || y === null) return { x: 0.5, y: 0.5 };
    return { x, y };
  }
  return { x: 0.5, y: 0.5 };
}

/**
 * THE GEOMETRY SOLVER. Given the source and the container, what rect is drawn?
 *
 * A negative x/y is the crop offset `cover` needs — the same sign convention CSS
 * `object-position` uses, so the web mapping is an identity and the two natives translate one
 * subtraction. Any non-positive dimension yields the empty rect rather than a NaN that
 * propagates into a layout pass.
 */
export function solveImageRect(
  fit: string | null | undefined,
  position: string | null | undefined,
  source: ImageSize,
  container: ImageSize,
): ImageRect {
  const mode = resolveContentFit(fit);
  const sw = source.width, sh = source.height, cw = container.width, ch = container.height;
  if (!(sw > 0) || !(sh > 0) || !(cw > 0) || !(ch > 0)) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  }
  let drawnWidth: number, drawnHeight: number;
  if (mode === "fill") {
    drawnWidth = cw;
    drawnHeight = ch;
  } else {
    let factor: number;
    if (mode === "cover") factor = Math.max(cw / sw, ch / sh);
    else if (mode === "contain") factor = Math.min(cw / sw, ch / sh);
    else if (mode === "none") factor = 1;
    else factor = Math.min(1, Math.min(cw / sw, ch / sh));
    drawnWidth = sw * factor;
    drawnHeight = sh * factor;
  }
  const anchor = resolveContentPosition(position);
  return {
    x: (cw - drawnWidth) * anchor.x,
    y: (ch - drawnHeight) * anchor.y,
    width: drawnWidth,
    height: drawnHeight,
    scale: mode === "fill" ? 0 : drawnWidth / sw,
  };
}

export interface CacheResolution {
  readonly policy: CachePolicy;
  readonly memory: boolean;
  readonly disk: boolean;
  /** `none` means REVALIDATE — the bytes still ride the content plane, they are never read back. */
  readonly revalidate: boolean;
}

/**
 * The cache-policy ladder. `cachePolicy` wins when it names one of the four words; otherwise
 * the legacy binary `cache` decides, so every app written against `cache="none"` keeps its
 * behaviour byte for byte. An unrecognised `cachePolicy` falls through to the legacy read
 * rather than disabling caching, because a typo must never turn a feed into a download loop.
 */
export function resolveCachePolicy(
  cachePolicy: string | null | undefined,
  cache?: string | null,
): CacheResolution {
  const word = (cachePolicy ?? "").trim();
  let policy: CachePolicy;
  if ((CACHE_POLICIES as readonly string[]).includes(word)) policy = word as CachePolicy;
  else policy = (cache ?? "").trim() === "none" ? "none" : CACHE_POLICY_DEFAULT;
  return {
    policy,
    memory: policy === "memory" || policy === "memoryDisk",
    disk: policy === "disk" || policy === "memoryDisk",
    revalidate: policy === "none",
  };
}

/** What `on:load` reports, given where the bytes were actually found. */
export function cacheTypeFor(policy: CacheResolution, found: { memory?: boolean; disk?: boolean }): CacheType {
  if (policy.memory && found.memory === true) return "memory";
  if (policy.disk && found.disk === true) return "disk";
  return "none";
}

export interface TransitionResolution {
  readonly duration: number;
  readonly effect: TransitionEffect;
}

/** `transition` accepts a number of ms, a numeric string, an effect word, or `{duration,effect}`. */
export type TransitionSpec =
  | number | string | null | undefined
  | { duration?: unknown; effect?: unknown };

export function resolveTransition(spec: TransitionSpec): TransitionResolution {
  if (spec === null || spec === undefined) {
    return { duration: TRANSITION_DURATION_DEFAULT, effect: "crossDissolve" };
  }
  if (typeof spec === "number") return fromDuration(spec, "crossDissolve");
  if (typeof spec === "object") {
    const raw = spec as { duration?: unknown; effect?: unknown };
    const duration = typeof raw.duration === "number" && Number.isFinite(raw.duration)
      ? Math.max(0, Math.trunc(raw.duration))
      : TRANSITION_DURATION_DEFAULT;
    const word = typeof raw.effect === "string" ? raw.effect.trim() : "crossDissolve";
    const effect = (TRANSITION_EFFECTS as readonly string[]).includes(word)
      ? (word as TransitionEffect)
      : "crossDissolve";
    return normalise(duration, effect);
  }
  const text = String(spec).trim();
  if (text === "") return { duration: TRANSITION_DURATION_DEFAULT, effect: "crossDissolve" };
  if ((TRANSITION_EFFECTS as readonly string[]).includes(text)) {
    return normalise(text === "none" ? 0 : TRANSITION_DURATION_DEFAULT, text as TransitionEffect);
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return fromDuration(numeric, "crossDissolve");
  return { duration: TRANSITION_DURATION_DEFAULT, effect: "crossDissolve" };
}

function fromDuration(value: number, effect: TransitionEffect): TransitionResolution {
  return normalise(Math.max(0, Math.trunc(value)), effect);
}

/** Zero duration and `none` are the same statement; keep them from disagreeing. */
function normalise(duration: number, effect: TransitionEffect): TransitionResolution {
  if (duration === 0 || effect === "none") return { duration: 0, effect: "none" };
  return { duration, effect };
}

/**
 * THE RULE THAT MAKES A FAST APP LOOK FAST: an image already decoded in memory appears in the
 * same frame, with no fade. Fading in something that was instantly available is the tell that
 * an app is doing theatre instead of work.
 */
export function shouldTransition(transition: TransitionResolution, cacheType: CacheType): boolean {
  return transition.duration > 0 && transition.effect !== "none" && cacheType !== "memory";
}

export interface DecodeSize {
  readonly width: number;
  readonly height: number;
  readonly downscaled: boolean;
}

/**
 * `allowDownscaling` — decode at display size, the single biggest memory win in list-heavy
 * apps. A 4000 px hero in a 48 pt avatar decodes at 96 px on a @2x screen: 64 KB instead of
 * 64 MB. Never upscales (a factor above 1 is clamped), and an unknown display size decodes at
 * source rather than guessing.
 */
export function resolveDecodeSize(args: {
  fit?: string | null;
  source: ImageSize;
  display: ImageSize;
  scale?: number;
  allowDownscaling?: boolean;
}): DecodeSize {
  const sw = args.source.width, sh = args.source.height;
  if (!(sw > 0) || !(sh > 0)) return { width: 0, height: 0, downscaled: false };
  const allow = args.allowDownscaling !== false;
  const density = args.scale ?? 1;
  const dw = args.display.width, dh = args.display.height;
  if (!allow || !(dw > 0) || !(dh > 0) || !(density > 0)) {
    return { width: sw, height: sh, downscaled: false };
  }
  const targetWidth = dw * density, targetHeight = dh * density;
  const mode = resolveContentFit(args.fit);
  let required: number;
  if (mode === "cover" || mode === "fill") required = Math.max(targetWidth / sw, targetHeight / sh);
  else if (mode === "none") required = 1;
  else required = Math.min(targetWidth / sw, targetHeight / sh);
  const factor = Math.min(1, required);
  const width = Math.max(1, Math.round(sw * factor));
  const height = Math.max(1, Math.round(sh * factor));
  return { width, height, downscaled: width < sw || height < sh };
}

export type PlaceholderKind = "none" | "blurhash" | "thumbhash" | "color" | "asset";
export interface PlaceholderResolution { readonly kind: PlaceholderKind; readonly value: string }

const BASE83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** The semantic colour words `placeholder` may name. Hexes and `rgb(a)()` are recognised by shape. */
export const PLACEHOLDER_COLOR_TOKENS: readonly string[] = [
  "accent", "label", "separator", "white", "black", "clear", "transparent",
  "background", "secondaryLabel", "tertiaryLabel", "systemFill",
];

/** A blurhash carries its own component count, so the length check is exact — not a heuristic. */
export function isBlurhash(text: string): boolean {
  if (text.length < 6) return false;
  for (const character of text) if (!BASE83.includes(character)) return false;
  const flag = BASE83.indexOf(text[0]!);
  const numY = Math.floor(flag / 9) + 1;
  const numX = (flag % 9) + 1;
  return text.length === 4 + 2 * numX * numY;
}

/** Byte length of a well-formed base64 payload, or -1. Used to tell a thumbhash from an asset name. */
export function base64ByteLength(text: string): number {
  if (text.length < 8 || text.length % 4 !== 0) return -1;
  const body = text.replace(/=+$/, "");
  if (text.length - body.length > 2) return -1;
  for (const character of body) if (!BASE64.includes(character)) return -1;
  return Math.floor((body.length * 3) / 4);
}

/**
 * `placeholder` is one attribute carrying four different things, so the classification has to
 * be deterministic rather than clever: an explicit `blurhash:` / `thumbhash:` prefix always
 * wins, then colour by shape, then a blurhash by its self-describing length, then a thumbhash
 * by being well-formed base64 of at least the 5-byte header, and an asset name otherwise.
 */
export function classifyPlaceholder(value: string | null | undefined): PlaceholderResolution {
  const text = (value ?? "").trim();
  if (text === "") return { kind: "none", value: "" };
  if (text.startsWith("blurhash:")) return { kind: "blurhash", value: text.slice(9) };
  if (text.startsWith("thumbhash:")) return { kind: "thumbhash", value: text.slice(10) };
  if (text.startsWith("#") || text.startsWith("rgb(") || text.startsWith("rgba(")
      || PLACEHOLDER_COLOR_TOKENS.includes(text)) {
    return { kind: "color", value: text };
  }
  if (isBlurhash(text)) return { kind: "blurhash", value: text };
  if (base64ByteLength(text) >= 5) return { kind: "thumbhash", value: text };
  return { kind: "asset", value: text };
}

export interface RecyclingResolution { readonly key: string; readonly clear: boolean }

/**
 * `recyclingKey` — the fix for the bug every list in every app has: row A shows image 1, the
 * row is reused for item 47, and image 1 stays on screen under item 47's text until the new
 * bytes land. The identity ladder is author key → the list's row key (set automatically, so
 * the correct behaviour is the default) → src → asset.
 */
export function resolveRecycling(args: {
  recyclingKey?: string | null;
  rowKey?: string | null;
  src?: string | null;
  asset?: string | null;
  previousKey?: string | null;
}): RecyclingResolution {
  const candidates = [args.recyclingKey, args.rowKey, args.src, args.asset];
  let key = "";
  for (const candidate of candidates) {
    const text = (candidate ?? "").trim();
    if (text !== "") { key = text; break; }
  }
  return { key, clear: key !== (args.previousKey ?? "").trim() };
}

export interface DecodedPixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

function srgbToLinear(component: number): number {
  const value = component / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number): number {
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return clamped <= 0.0031308
    ? Math.trunc(clamped * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * Math.pow(clamped, 1 / 2.4) - 0.055) * 255 + 0.5);
}

function signedPow(value: number, exponent: number): number {
  return (value < 0 ? -1 : 1) * Math.pow(Math.abs(value), exponent);
}

function decode83(text: string): number {
  let value = 0;
  for (const character of text) {
    const digit = BASE83.indexOf(character);
    if (digit < 0) return -1;
    value = value * 83 + digit;
  }
  return value;
}

/**
 * Decode a BlurHash to RGBA at an arbitrary size. Returns null for a malformed hash rather
 * than throwing: a bad placeholder must degrade to no placeholder, never to a crashed row.
 */
export function decodeBlurhash(
  hash: string, width: number, height: number, punch = 1,
): DecodedPixels | null {
  if (!isBlurhash(hash) || !(width > 0) || !(height > 0)) return null;
  const flag = decode83(hash[0]!);
  const numY = Math.floor(flag / 9) + 1;
  const numX = (flag % 9) + 1;
  const maximum = ((decode83(hash[1]!) + 1) / 166) * punch;

  const colors: number[][] = new Array(numX * numY);
  const dc = decode83(hash.substring(2, 6));
  colors[0] = [srgbToLinear(dc >> 16), srgbToLinear((dc >> 8) & 255), srgbToLinear(dc & 255)];
  for (let index = 1; index < numX * numY; index++) {
    const value = decode83(hash.substring(4 + index * 2, 6 + index * 2));
    const quantR = Math.floor(value / (19 * 19));
    const quantG = Math.floor(value / 19) % 19;
    const quantB = value % 19;
    colors[index] = [
      signedPow((quantR - 9) / 9, 2) * maximum,
      signedPow((quantG - 9) / 9, 2) * maximum,
      signedPow((quantB - 9) / 9, 2) * maximum,
    ];
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let red = 0, green = 0, blue = 0;
      for (let j = 0; j < numY; j++) {
        const basisY = Math.cos((Math.PI * y * j) / height);
        for (let i = 0; i < numX; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * basisY;
          const color = colors[i + j * numX]!;
          red += color[0]! * basis;
          green += color[1]! * basis;
          blue += color[2]! * basis;
        }
      }
      const offset = y * stride + x * 4;
      rgba[offset] = linearToSrgb(red);
      rgba[offset + 1] = linearToSrgb(green);
      rgba[offset + 2] = linearToSrgb(blue);
      rgba[offset + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** Decode standard base64 to bytes without depending on a platform codec. */
function decodeBase64(text: string): Uint8Array | null {
  if (base64ByteLength(text) < 0) return null;
  const body = text.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((body.length * 3) / 4));
  let accumulator = 0, bits = 0, written = 0;
  for (const character of body) {
    accumulator = (accumulator << 6) | BASE64.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written++] = (accumulator >> bits) & 255;
    }
  }
  return bytes;
}

/**
 * Decode a ThumbHash to RGBA. Unlike a blurhash the size is not the caller's choice — the hash
 * carries its own aspect ratio and the decode is defined at ≤32 px on the long edge, which is
 * exactly why it is worth the extra bytes over a blurhash: the placeholder has the right shape.
 * `hash` is the base64 transport form (with or without the `thumbhash:` prefix).
 */
export function decodeThumbhash(hash: string): DecodedPixels | null {
  const text = hash.startsWith("thumbhash:") ? hash.slice(10) : hash;
  const bytes = decodeBase64(text.trim());
  if (bytes === null || bytes.length < 5) return null;

  const header24 = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16);
  const header16 = bytes[3]! | (bytes[4]! << 8);
  const lDc = (header24 & 63) / 63;
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  const lScale = ((header24 >> 18) & 31) / 31;
  const hasAlpha = (header24 >> 23) !== 0;
  if (hasAlpha && bytes.length < 6) return null;
  const pScale = ((header16 >> 3) & 63) / 63;
  const qScale = ((header16 >> 9) & 63) / 63;
  const isLandscape = (header16 >> 15) !== 0;
  const lx = Math.max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
  const ly = Math.max(3, isLandscape ? header16 & 7 : hasAlpha ? 5 : 7);
  const aDc = hasAlpha ? (bytes[5]! & 15) / 15 : 1;
  const aScale = hasAlpha ? (bytes[5]! >> 4) / 15 : 0;

  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  let overran = false;
  const channel = (nx: number, ny: number, scale: number): number[] => {
    const factors: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = cy === 0 ? 1 : 0; cx * ny < nx * (ny - cy); cx++) {
        const byteIndex = acStart + (acIndex >> 1);
        if (byteIndex >= bytes.length) { overran = true; factors.push(0); acIndex++; continue; }
        const nibble = (bytes[byteIndex]! >> ((acIndex & 1) << 2)) & 15;
        acIndex++;
        factors.push((nibble / 7.5 - 1) * scale);
      }
    }
    return factors;
  };
  const lAc = channel(lx, ly, lScale);
  const pAc = channel(3, 3, pScale * 1.25);
  const qAc = channel(3, 3, qScale * 1.25);
  const aAc = hasAlpha ? channel(5, 5, aScale) : [];
  if (overran) return null;

  const ratio = lx / ly;
  const width = Math.round(ratio > 1 ? 32 : 32 * ratio);
  const height = Math.round(ratio > 1 ? 32 / ratio : 32);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const fx: number[] = [];
  const fy: number[] = [];
  const coefficientsX = Math.max(lx, hasAlpha ? 5 : 3);
  const coefficientsY = Math.max(ly, hasAlpha ? 5 : 3);

  for (let y = 0, offset = 0; y < height; y++) {
    for (let cy = 0; cy < coefficientsY; cy++) fy[cy] = Math.cos((Math.PI / height) * (y + 0.5) * cy);
    for (let x = 0; x < width; x++, offset += 4) {
      for (let cx = 0; cx < coefficientsX; cx++) fx[cx] = Math.cos((Math.PI / width) * (x + 0.5) * cx);
      let luminance = lDc, chromaP = pDc, chromaQ = qDc, alpha = aDc;
      for (let cy = 0, j = 0; cy < ly; cy++) {
        const doubled = fy[cy]! * 2;
        for (let cx = cy === 0 ? 1 : 0; cx * ly < lx * (ly - cy); cx++, j++) {
          luminance += lAc[j]! * fx[cx]! * doubled;
        }
      }
      for (let cy = 0, j = 0; cy < 3; cy++) {
        const doubled = fy[cy]! * 2;
        for (let cx = cy === 0 ? 1 : 0; cx < 3 - cy; cx++, j++) {
          const basis = fx[cx]! * doubled;
          chromaP += pAc[j]! * basis;
          chromaQ += qAc[j]! * basis;
        }
      }
      if (hasAlpha) {
        for (let cy = 0, j = 0; cy < 5; cy++) {
          const doubled = fy[cy]! * 2;
          for (let cx = cy === 0 ? 1 : 0; cx < 5 - cy; cx++, j++) {
            alpha += aAc[j]! * fx[cx]! * doubled;
          }
        }
      }
      const blue = luminance - (2 / 3) * chromaP;
      const red = (3 * luminance - blue + chromaQ) / 2;
      const green = red - chromaQ;
      rgba[offset] = Math.max(0, Math.trunc(255 * Math.min(1, red)));
      rgba[offset + 1] = Math.max(0, Math.trunc(255 * Math.min(1, green)));
      rgba[offset + 2] = Math.max(0, Math.trunc(255 * Math.min(1, blue)));
      rgba[offset + 3] = Math.max(0, Math.trunc(255 * Math.min(1, alpha)));
    }
  }
  return { width, height, rgba };
}

/** Decode whatever kind of hash `placeholder` turned out to be, at the size the caller wants. */
export function decodePlaceholder(
  placeholder: PlaceholderResolution, width = 32, height = 32,
): DecodedPixels | null {
  if (placeholder.kind === "blurhash") return decodeBlurhash(placeholder.value, width, height);
  if (placeholder.kind === "thumbhash") return decodeThumbhash(placeholder.value);
  return null;
}

/** `priority` — unknown words are `normal`, never a silent demotion to `low`. */
export function resolveImagePriority(priority: string | null | undefined): ImagePriority {
  const word = (priority ?? "").trim();
  return (IMAGE_PRIORITIES as readonly string[]).includes(word) ? (word as ImagePriority) : "normal";
}

/** The `on:load` payload, assembled in one place so all three renderers report the same shape. */
export interface ImageLoadPayload {
  readonly width: number;
  readonly height: number;
  readonly mediaType: string;
  readonly cacheType: CacheType;
}

/** Map the sniffed container to the media type `on:load` reports. Unknown bytes stay unknown. */
export function imageMediaType(extensionOrType: string | null | undefined): string {
  const text = (extensionOrType ?? "").trim().toLowerCase();
  if (text === "") return "unknown";
  if (text.includes("/")) return text;
  const table: { [extension: string]: string } = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", heic: "image/heic", heif: "image/heif",
    svg: "image/svg+xml", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  };
  return table[text.replace(/^\./, "")] ?? "unknown";
}
