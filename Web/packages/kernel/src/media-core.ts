//
//  media-core.ts - the shared `media` module core: the pick plan, EXIF orientation
//  normalisation, the manipulate op-chain resolver, the decode hint that keeps a 12 MP
//  photo from ever being allocated whole, and the format/quality fold with its
//  per-platform support table. The law is the corpus, OpenSource/Conformance/media/
//  (parity/F04-media.md); the Kotlin twin is :core MediaCore.kt and the Swift twin is
//  Engine/iOS/MediaCore.swift.
//
//  WHY THESE PARTS AND NOT THE PIXELS. Opening a picker, decoding a JPEG and running a
//  CIFilter chain are entirely platform work (PHPickerViewController, PickVisualMedia,
//  <input type=file>; Core Image, Bitmap, OffscreenCanvas) and belong in the facets. What
//  cannot live there is the ARITHMETIC AND THE ORDER:
//
//   * crop-then-resize is not resize-then-crop, and an avatar that comes out 401 px on one
//     platform and 400 on another is a bug the author cannot fix from markup;
//   * a phone photo carries its rotation in EXIF, so a crop rect computed against the
//     stored pixels lands somewhere else than the one the user drew on screen - the
//     "sideways on one platform" bug, which is an ORDERING law, not a decoder setting;
//   * the decode hint is the difference between an error and an OOM kill: decode at the
//     size you need, never full then downscale.
//
//  Everything here is pure arithmetic over plain values. No I/O, no platform types.
//

/** The raster formats `manipulate` can be asked to write. */
export const MEDIA_FORMATS: readonly string[] = ["jpeg", "png", "webp", "heic"];

/** The resize fits. Deliberately three: the fourth spelling everyone invents ("inside",
 *  "outside", "scale-down") is `contain` with a clamp the caller can do itself. */
export const MEDIA_RESIZE_FITS: readonly string[] = ["contain", "cover", "fill"];

/** The pixel budget for one manipulation step, and the one number in this file that is a
 *  POLICY rather than arithmetic. It bounds what a caller may ASK FOR - a 20000x20000
 *  render is refused before anything is allocated - and deliberately does NOT bound what
 *  the camera produced: a 48 MP ProRAW photo is over the budget the moment it is opened,
 *  and a framework that refused to rotate it would be refusing the device's own output.
 *  So the check is on GROWTH: a step is `too_large` only when it pushes past the budget
 *  AND makes the image bigger than it already was. Shrinking a huge photo always works,
 *  and `mediaDecodeHint` is what keeps it from ever being resident whole. */
export const MEDIA_MAX_PIXELS = 40_000_000;

/** The ceiling on one multi-pick. A picker that hands back 400 assets has handed back an
 *  out-of-memory bug; the system pickers cap far lower in practice, and a caller who wants
 *  more should page. 0 from the caller means "the system's own maximum". */
export const MEDIA_PICK_MAX = 64;

export interface MediaBox { width: number; height: number }
export interface MediaRect { x: number; y: number; width: number; height: number }

/** One resolved step of an op chain: what the image measures after it, and - for the ops
 *  that select a region (crop, and the centre-crop half of `cover`) - the exact rect, in
 *  the coordinate space of the image AS IT WAS WHEN THE STEP RAN. */
export interface MediaStep {
  op: string;
  width: number;
  height: number;
  rect?: MediaRect;
}

export type MediaOpsResult =
  | { ok: true; width: number; height: number; steps: MediaStep[] }
  | { ok: false; error: "invalid_ops" | "too_large"; at: number };

// ── small numeric helpers ────────────────────────────────────────────────────────────────

/** Round half away from zero, then floor at one pixel. Every dimension in this file goes
 *  through it so three renderers cannot disagree about 400.5. */
function px(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  return Math.max(1, rounded);
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "number" ? value : Number(value);
  return Number.isFinite(raw) ? raw : null;
}

function positive(value: unknown): number | null {
  const raw = finite(value);
  return raw !== null && raw > 0 ? raw : null;
}

// ── the format / quality fold ────────────────────────────────────────────────────────────

/** Fold an author's format spelling; null is `unsupported_format`. An omitted format means
 *  "keep whatever the source was", which the facet answers, so it folds to null too - the
 *  caller distinguishes the two by whether it passed anything. */
export function foldMediaFormat(name: string | null | undefined): string | null {
  const key = String(name ?? "").trim().toLowerCase().replace(/^\./, "");
  if (key === "") return null;
  if (key === "jpg") return "jpeg";
  if (key === "heif") return "heic";
  return MEDIA_FORMATS.includes(key) ? key : null;
}

/** Clamp a quality argument into 0...1, reading a value above 1 as a percent because
 *  everyone confuses the two exactly once. Identical semantics to the capture fold. */
export function mediaQuality(value: unknown, fallback = 0.9): number {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const unit = raw > 1 && raw <= 100 ? raw / 100 : raw;
  return Math.min(Math.max(unit, 0), 1);
}

/** What each renderer can actually ENCODE. `true` is unconditional, `"device"` means the
 *  hardware decides at runtime (HEIC on an older iPhone, HEIC below Android 30) and the
 *  facet must ask, `false` means never. A format that cannot be written falls back to
 *  jpeg - lossy but universal - and the resolve says so rather than lying about the file
 *  it produced. */
export const MEDIA_FORMAT_SUPPORT: Readonly<Record<string, Readonly<Record<string, boolean | "device">>>> = {
  ios: { jpeg: true, png: true, webp: false, heic: "device" },
  android: { jpeg: true, png: true, webp: true, heic: "device" },
  web: { jpeg: true, png: true, webp: true, heic: false },
};

/** png is lossless, so a quality argument against it is meaningless and is dropped rather
 *  than silently changing nothing - a caller reading the resolve sees the truth. */
export function mediaFormatLossless(format: string): boolean {
  return format === "png";
}

export type MediaFormatPlan =
  | { ok: true; format: string; requested: string; fellBack: boolean; lossless: boolean }
  | { ok: false; error: "unsupported_format" };

/**
 * Resolve the format a facet will actually write.
 *
 * `deviceCanEncode` answers the `"device"` rows: the facet asks its platform once (does
 * this iPhone encode HEIC? is this API level 30?) and passes the answer in. An unknown
 * platform is treated as the web row, which is the conservative one.
 */
export function mediaFormatPlan(
  requested: string | null | undefined,
  platform: string,
  deviceCanEncode = false,
  fallback = "jpeg",
): MediaFormatPlan {
  const format = foldMediaFormat(requested);
  if (format === null) return { ok: false, error: "unsupported_format" };
  const table = MEDIA_FORMAT_SUPPORT[platform] ?? MEDIA_FORMAT_SUPPORT["web"]!;
  const support = table[format];
  const writable = support === true || (support === "device" && deviceCanEncode);
  if (writable) {
    return { ok: true, format, requested: format, fellBack: false, lossless: mediaFormatLossless(format) };
  }
  return { ok: true, format: fallback, requested: format, fellBack: true, lossless: mediaFormatLossless(fallback) };
}

// ── EXIF orientation ─────────────────────────────────────────────────────────────────────

/**
 * The eight EXIF orientation values, as the transform that turns STORED pixels into what
 * the photographer saw. `rotate` is clockwise degrees; `mirrored` is a horizontal flip
 * applied BEFORE the rotation. `swaps` says whether the two axes trade places, which is
 * the whole reason a portrait photo reports 4032x3024.
 *
 * This table is the fix for the classic bug: one platform's decoder applies the tag and
 * another hands back raw pixels, so the same crop rect selects a different region. The
 * law that makes them agree is not "everyone applies the tag" - it is that the tag is
 * applied FIRST and the op chain then runs against normalised pixels on every renderer.
 */
export const EXIF_TRANSFORMS: Readonly<Record<number, { rotate: 0 | 90 | 180 | 270; mirrored: boolean; swaps: boolean }>> = {
  1: { rotate: 0, mirrored: false, swaps: false },
  2: { rotate: 0, mirrored: true, swaps: false },
  3: { rotate: 180, mirrored: false, swaps: false },
  4: { rotate: 180, mirrored: true, swaps: false },
  5: { rotate: 90, mirrored: true, swaps: true },
  6: { rotate: 90, mirrored: false, swaps: true },
  7: { rotate: 270, mirrored: true, swaps: true },
  8: { rotate: 270, mirrored: false, swaps: true },
};

export interface MediaOrientation {
  orientation: number;
  width: number;
  height: number;
  rotate: 0 | 90 | 180 | 270;
  mirrored: boolean;
  swaps: boolean;
}

/**
 * Normalise stored dimensions by an EXIF orientation tag. An absent, zero or out-of-range
 * tag is orientation 1 (the identity) rather than a refusal: a file with no EXIF block is
 * ordinary, not broken.
 */
export function exifNormalise(
  width: unknown, height: unknown, orientation: unknown,
): MediaOrientation {
  const w = positive(width) ?? 1;
  const h = positive(height) ?? 1;
  const raw = finite(orientation);
  const tag = raw !== null && Number.isInteger(raw) && raw >= 1 && raw <= 8 ? raw : 1;
  const t = EXIF_TRANSFORMS[tag]!;
  return {
    orientation: tag,
    width: t.swaps ? px(h) : px(w),
    height: t.swaps ? px(w) : px(h),
    rotate: t.rotate,
    mirrored: t.mirrored,
    swaps: t.swaps,
  };
}

// ── the op chain ─────────────────────────────────────────────────────────────────────────

function opName(op: unknown): string | null {
  if (typeof op !== "object" || op === null || Array.isArray(op)) return null;
  const keys = Object.keys(op as Record<string, unknown>).filter((k) => !k.startsWith("_"));
  // Exactly one verb per entry. Two keys is an ambiguity about ORDER, and order is the one
  // thing this resolver exists to make unambiguous.
  if (keys.length !== 1) return null;
  return keys[0]!;
}

function resizeStep(box: MediaBox, spec: unknown): { width: number; height: number; rect?: MediaRect } | null {
  if (typeof spec !== "object" || spec === null) return null;
  const s = spec as Record<string, unknown>;
  const tw = positive(s["width"]);
  const th = positive(s["height"]);
  if (tw === null && th === null) return null;

  const fitRaw = String(s["fit"] ?? "contain").trim().toLowerCase();
  if (!MEDIA_RESIZE_FITS.includes(fitRaw)) return null;

  // One dimension given: the aspect ratio decides the other, whatever `fit` says. There is
  // no box to fit inside, so `cover` and `contain` cannot differ.
  if (tw === null) return { width: px(box.width * (th! / box.height)), height: px(th!) };
  if (th === null) return { width: px(tw), height: px(box.height * (tw / box.width)) };

  if (fitRaw === "fill") return { width: px(tw), height: px(th) };

  const scale = fitRaw === "cover"
    ? Math.max(tw / box.width, th / box.height)
    : Math.min(tw / box.width, th / box.height);
  const scaledW = px(box.width * scale);
  const scaledH = px(box.height * scale);
  if (fitRaw === "contain") return { width: scaledW, height: scaledH };

  // cover: fill the box, then take the CENTRE of the overflow. Floor the offsets so a one
  // pixel remainder always lands on the bottom/right, identically on three renderers.
  const outW = Math.min(px(tw), scaledW);
  const outH = Math.min(px(th), scaledH);
  return {
    width: outW,
    height: outH,
    rect: { x: Math.floor((scaledW - outW) / 2), y: Math.floor((scaledH - outH) / 2), width: outW, height: outH },
  };
}

function cropStep(box: MediaBox, spec: unknown): { width: number; height: number; rect: MediaRect } | null {
  if (typeof spec !== "object" || spec === null) return null;
  const s = spec as Record<string, unknown>;
  const w = positive(s["width"]);
  const h = positive(s["height"]);
  if (w === null || h === null) return null;
  const x = finite(s["x"]) ?? 0;
  const y = finite(s["y"]) ?? 0;

  // A crop that hangs off the edge is INTERSECTED with the image, not refused: the caller
  // drew a rect on a screen, and a two pixel overhang from a rounding difference must not
  // lose the whole operation. A crop with no overlap at all IS refused - it selects
  // nothing, and silently handing back a 1x1 image is the worse answer.
  const x0 = Math.min(Math.max(Math.round(x), 0), box.width);
  const y0 = Math.min(Math.max(Math.round(y), 0), box.height);
  const x1 = Math.min(Math.max(Math.round(x + w), 0), box.width);
  const y1 = Math.min(Math.max(Math.round(y + h), 0), box.height);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw < 1 || ch < 1) return null;
  return { width: cw, height: ch, rect: { x: x0, y: y0, width: cw, height: ch } };
}

function rotateStep(box: MediaBox, spec: unknown): { width: number; height: number } | null {
  const deg = finite(spec);
  if (deg === null) return null;
  const normal = ((Math.round(deg) % 360) + 360) % 360;
  // Only right angles. An arbitrary angle changes the canvas shape and needs a fill colour
  // and a resampling policy; refusing is honest, and `manipulate` is not an editor.
  if (normal % 90 !== 0) return null;
  return normal === 90 || normal === 270
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

function flipStep(box: MediaBox, spec: unknown): { width: number; height: number } | null {
  const word = String(spec ?? "").trim().toLowerCase();
  const known = word === "h" || word === "v" || word === "horizontal" || word === "vertical";
  return known ? { width: box.width, height: box.height } : null;
}

function blurStep(box: MediaBox, spec: unknown): { width: number; height: number } | null {
  const radius = finite(spec);
  if (radius === null || radius < 0 || radius > 100) return null;
  return { width: box.width, height: box.height };
}

/**
 * Run an op list over a source box and report the geometry at every step.
 *
 * The ops are applied IN ORDER, which is the contract: `[crop, resize]` and
 * `[resize, crop]` are different pictures and both must be exact. The budget is checked
 * after each step, so a chain that would blow up in the middle is refused before the
 * facet allocates anything.
 */
export function resolveMediaOps(
  source: MediaBox, ops: unknown, maxPixels = MEDIA_MAX_PIXELS,
): MediaOpsResult {
  const sw = positive(source?.width);
  const sh = positive(source?.height);
  if (sw === null || sh === null) return { ok: false, error: "invalid_ops", at: -1 };

  const list = ops === undefined || ops === null ? [] : ops;
  if (!Array.isArray(list)) return { ok: false, error: "invalid_ops", at: -1 };

  let box: MediaBox = { width: px(sw), height: px(sh) };
  const steps: MediaStep[] = [];

  for (let i = 0; i < list.length; i++) {
    const name = opName(list[i]);
    if (name === null) return { ok: false, error: "invalid_ops", at: i };
    const spec = (list[i] as Record<string, unknown>)[name];

    let next: { width: number; height: number; rect?: MediaRect } | null;
    switch (name) {
      case "resize": next = resizeStep(box, spec); break;
      case "crop":   next = cropStep(box, spec); break;
      case "rotate": next = rotateStep(box, spec); break;
      case "flip":   next = flipStep(box, spec); break;
      case "blur":   next = blurStep(box, spec); break;
      default:       next = null;
    }
    if (next === null) return { ok: false, error: "invalid_ops", at: i };
    const after = next.width * next.height;
    if (after > maxPixels && after > box.width * box.height) {
      return { ok: false, error: "too_large", at: i };
    }

    box = { width: next.width, height: next.height };
    steps.push(next.rect === undefined
      ? { op: name, width: box.width, height: box.height }
      : { op: name, width: box.width, height: box.height, rect: next.rect });
  }

  return { ok: true, width: box.width, height: box.height, steps };
}

// ── the decode hint ──────────────────────────────────────────────────────────────────────

export interface MediaDecodeHint {
  /** The power-of-two subsampling factor. 1 means "decode whole". Android passes it
   *  straight to BitmapFactory.Options.inSampleSize; iOS and the web use `width`/`height`
   *  as the downsample target (kCGImageSourceThumbnailMaxPixelSize / createImageBitmap). */
  sampleSize: number;
  width: number;
  height: number;
}

/**
 * The largest the source needs to be decoded at for this chain to be exact.
 *
 * A 12 MP photo resized to 400 px wide never needs 12 MP in memory: decoding at
 * sampleSize 8 gives 500x375, which still has more pixels than the output asks for, and
 * costs 0.2 MB instead of 48 MB. Decode at the size you need, never full then downscale -
 * this is the arithmetic behind that sentence, and it is shared so the three facets cannot
 * differ about when the phone is allowed to die.
 *
 * The factor is taken at the FIRST resize, relative to the box that reaches it: a crop
 * before the resize means the resize sees fewer pixels, so MORE of the source is needed
 * per output pixel, and the hint gets conservatively larger. A chain with no resize needs
 * the source whole - unless the source alone breaks the budget, in which case the hint
 * subsamples until it fits, because refusing to open a photo the camera produced is not an
 * option a framework has.
 */
export function mediaDecodeHint(
  source: MediaBox, ops: unknown, maxPixels = MEDIA_MAX_PIXELS,
): MediaDecodeHint {
  const sw = px(positive(source?.width) ?? 1);
  const sh = px(positive(source?.height) ?? 1);
  const list = Array.isArray(ops) ? ops : [];

  let box: MediaBox = { width: sw, height: sh };
  let needed = 1;
  for (const op of list) {
    const name = opName(op);
    if (name === null) break;
    const spec = (op as Record<string, unknown>)[name];
    if (name === "resize") {
      const step = resizeStep(box, spec);
      if (step === null) break;
      // `cover` crops after scaling, so the SCALED box is what the decode must reach.
      const scaledW = step.rect === undefined ? step.width : Math.max(step.width, step.rect.width);
      const scaledH = step.rect === undefined ? step.height : Math.max(step.height, step.rect.height);
      needed = Math.max(scaledW / box.width, scaledH / box.height);
      break;
    }
    const step = name === "crop" ? cropStep(box, spec)
      : name === "rotate" ? rotateStep(box, spec)
      : name === "flip" ? flipStep(box, spec)
      : name === "blur" ? blurStep(box, spec)
      : null;
    if (step === null) break;
    box = { width: step.width, height: step.height };
  }

  let sampleSize = 1;
  if (needed < 1) {
    const wantW = Math.ceil(sw * needed);
    const wantH = Math.ceil(sh * needed);
    while (sampleSize < 32
           && Math.floor(sw / (sampleSize * 2)) >= wantW
           && Math.floor(sh / (sampleSize * 2)) >= wantH) {
      sampleSize *= 2;
    }
  }
  // Whatever the chain asked for, never hand back a decode that breaks the budget.
  while (sampleSize < 32
         && Math.ceil(sw / sampleSize) * Math.ceil(sh / sampleSize) > maxPixels) {
    sampleSize *= 2;
  }
  return { sampleSize, width: Math.ceil(sw / sampleSize), height: Math.ceil(sh / sampleSize) };
}

// ── the pick plan ────────────────────────────────────────────────────────────────────────

export const MEDIA_PICK_TYPES: readonly string[] = ["image", "video", "any"];
export const MEDIA_PICK_SOURCES: readonly string[] = ["library", "camera"];

export interface MediaPickPlan {
  type: string;
  source: string;
  limit: number;
  multiple: boolean;
  ordered: boolean;
  /** `true` when the plan can run on the PERMISSION-FREE system picker. This is the whole
   *  privacy posture in one boolean: library picks never ask, camera picks do. */
  permissionFree: boolean;
}

/**
 * Fold pick arguments into the plan a facet executes.
 *
 * The rules exist because every one of them is a shape a caller gets wrong:
 *  - `multiple: false` pins the limit to 1 whatever `limit` says;
 *  - a `limit` above 1 IMPLIES multiple, because passing one without the other is what a
 *    caller means and refusing it teaches nothing;
 *  - `limit: 0` means "the system's own maximum", which is not the same as one;
 *  - the camera returns one shot per presentation, so `source: "camera"` is always limit 1;
 *  - `ordered` is only meaningful for a multi-pick and is folded off otherwise, so a facet
 *    never has to decide what an ordered single selection means.
 */
export function mediaPickPlan(
  args: { type?: unknown; multiple?: unknown; limit?: unknown; source?: unknown; ordered?: unknown } | null | undefined,
): { ok: true; plan: MediaPickPlan } | { ok: false; error: "unsupported_format" | "invalid_source" } {
  const a = args ?? {};
  const typeRaw = String(a.type ?? "any").trim().toLowerCase();
  const type = typeRaw === "" ? "any" : (typeRaw === "photo" ? "image" : typeRaw);
  if (!MEDIA_PICK_TYPES.includes(type)) return { ok: false, error: "unsupported_format" };

  const sourceRaw = String(a.source ?? "library").trim().toLowerCase();
  const source = sourceRaw === "" ? "library" : sourceRaw;
  if (!MEDIA_PICK_SOURCES.includes(source)) return { ok: false, error: "invalid_source" };

  const askedLimit = finite(a.limit);
  // An explicit `multiple: false` always wins: a caller who wrote it means it. A limit
  // above one with no `multiple` at all IMPLIES it, because that is what the caller means
  // and refusing the shorthand teaches nothing.
  const impliedMultiple = a.multiple === undefined && askedLimit !== null && askedLimit > 1;
  let multiple = a.multiple === true || impliedMultiple;
  let limit: number;
  if (!multiple) {
    limit = 1;
  } else if (askedLimit === null || askedLimit <= 0) {
    limit = 0;
  } else {
    limit = Math.min(Math.floor(askedLimit), MEDIA_PICK_MAX);
    if (limit === 1) multiple = false;
  }
  if (source === "camera") { multiple = false; limit = 1; }

  return {
    ok: true,
    plan: {
      type, source, limit, multiple,
      ordered: multiple && a.ordered === true,
      permissionFree: source === "library",
    },
  };
}

/** The MIME filter a facet hands its picker. `any` is an empty list, which every picker
 *  reads as "no filter" - a list of every type it might see would be wrong the first time
 *  a new codec shipped. */
export function mediaPickMimeTypes(type: string): string[] {
  if (type === "image") return ["image/*"];
  if (type === "video") return ["video/*"];
  return [];
}
