//
//  capture-core.ts - the shared `capture` module core: the format fold, scale resolution,
//  the pixel budget, and the PDF page geometry. The law is the corpus,
//  OpenSource/Conformance/capture/ (parity/F11-capture.md); the Kotlin twin is :core
//  CaptureCore.kt and the Swift twin is Engine/iOS/CaptureCore.swift.
//
//  WHY THESE PARTS AND NOT THE RASTERISING. Turning a view into pixels is entirely platform
//  work (UIGraphicsImageRenderer, View.draw/PixelCopy, a canvas painter) and belongs in the
//  facets. What cannot live there is the ARITHMETIC: an OG card asked for at 1200x630 has to
//  come out at exactly 1200x630 on every renderer or the share image is the wrong shape, and
//  the guard that refuses a 20000x20000 request before the device tries to allocate it has
//  to trip at the same point everywhere. Same for a PDF's page box: "a4" is one size.
//

/** The raster formats. webp is offered because it is half the bytes of a png for a share
 *  card, and refused honestly where a platform cannot write it. */
export const CAPTURE_FORMATS: readonly string[] = ["png", "jpeg", "webp"];

/** The pixel budget for one capture. Roughly a 6300x6300 square, or 8000x5000: comfortably
 *  larger than any share card, poster or receipt, and far below the point where a phone
 *  dies trying to allocate the bitmap. A request past it is `too_large` BEFORE any
 *  allocation, which is the difference between an error and a crash. */
export const CAPTURE_MAX_PIXELS = 40_000_000;

/** Fold an author's format spelling; null is `unsupported_format`. */
export function foldCaptureFormat(name: string | null | undefined): string | null {
  const key = String(name ?? "").trim().toLowerCase().replace(/^\./, "");
  if (key === "") return "png";
  if (key === "jpg") return "jpeg";
  return CAPTURE_FORMATS.includes(key) ? key : null;
}

/** Clamp a quality argument into 0...1. Anything outside is a caller confusing percent with
 *  fraction, which is worth silently fixing rather than refusing. */
export function captureQuality(value: unknown, fallback = 0.9): number {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const unit = raw > 1 && raw <= 100 ? raw / 100 : raw;
  return Math.min(Math.max(unit, 0), 1);
}

/**
 * Resolve `scale`. A number is a multiplier; the word `device` (and an omitted value) means
 * the surface's own pixel ratio, which is what makes a capture look as sharp as the screen
 * it came from. Zero, negative and non-numeric are refusals rather than a silent 1.
 */
export function resolveCaptureScale(
  scale: unknown, deviceScale: number,
): { ok: true; scale: number } | { ok: false; error: "invalid_scale" } {
  const device = Number.isFinite(deviceScale) && deviceScale > 0 ? deviceScale : 1;
  if (scale === undefined || scale === null || scale === "" || scale === "device") return { ok: true, scale: device };
  const raw = typeof scale === "number" ? scale : Number(scale);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 16) return { ok: false, error: "invalid_scale" };
  return { ok: true, scale: raw };
}

/**
 * Point size times scale, rounded to whole pixels, checked against the budget. Rounding is
 * half away from zero and happens per AXIS before the multiply, so 1200x630 at scale 1 is
 * exactly 1200x630 and never 1199 on one renderer.
 */
export function capturePixelSize(
  pointWidth: number, pointHeight: number, scale: number, maxPixels = CAPTURE_MAX_PIXELS,
): { ok: true; width: number; height: number } | { ok: false; error: "invalid_size" | "too_large" } {
  if (![pointWidth, pointHeight, scale].every((n) => Number.isFinite(n))) return { ok: false, error: "invalid_size" };
  if (pointWidth <= 0 || pointHeight <= 0 || scale <= 0) return { ok: false, error: "invalid_size" };
  const width = Math.round(pointWidth * scale);
  const height = Math.round(pointHeight * scale);
  if (width < 1 || height < 1) return { ok: false, error: "invalid_size" };
  if (width * height > maxPixels) return { ok: false, error: "too_large" };
  return { ok: true, width, height };
}

/** Named page boxes in PostScript points (72 per inch), the unit every PDF writer takes. */
export const PDF_PAGE_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
};

/**
 * Resolve a page size. A name from the table, `name/landscape` to swap the axes, or an
 * explicit `{ width, height }` in points. Unknown names are a refusal, not a fallback to
 * A4: a document silently printed at the wrong size is worse than one that did not print.
 */
export function pdfPageSize(
  spec: unknown,
): { ok: true; width: number; height: number } | { ok: false; error: "invalid_page_size" } {
  if (spec === undefined || spec === null || spec === "") {
    const [width, height] = PDF_PAGE_SIZES["a4"]!;
    return { ok: true, width, height };
  }
  if (typeof spec === "object") {
    const box = spec as { width?: unknown; height?: unknown };
    const width = Number(box.width);
    const height = Number(box.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { ok: false, error: "invalid_page_size" };
    }
    return { ok: true, width, height };
  }
  const text = String(spec).trim().toLowerCase();
  const landscape = text.endsWith("/landscape") || text.endsWith(" landscape");
  const name = text.replace(/[/ ]landscape$/, "").trim();
  const found = PDF_PAGE_SIZES[name];
  if (found === undefined) return { ok: false, error: "invalid_page_size" };
  return landscape
    ? { ok: true, width: found[1], height: found[0] }
    : { ok: true, width: found[0], height: found[1] };
}

/** A margin box in points. A bare number is all four sides; an object fills the sides it
 *  names and defaults the rest to the same 36 points (half an inch) a bare omission gets. */
export function pdfMargins(spec: unknown, fallback = 36): {
  top: number; right: number; bottom: number; left: number;
} {
  const of = (value: unknown, or: number) => {
    const raw = Number(value);
    return Number.isFinite(raw) && raw >= 0 ? raw : or;
  };
  if (typeof spec === "number" || typeof spec === "string") {
    const all = of(spec, fallback);
    return { top: all, right: all, bottom: all, left: all };
  }
  if (typeof spec === "object" && spec !== null) {
    const box = spec as { [k: string]: unknown };
    return {
      top: of(box["top"], fallback),
      right: of(box["right"], fallback),
      bottom: of(box["bottom"], fallback),
      left: of(box["left"], fallback),
    };
  }
  return { top: fallback, right: fallback, bottom: fallback, left: fallback };
}
