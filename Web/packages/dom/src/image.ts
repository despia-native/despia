//
//  image.ts — the `<image>` WEB ADAPTER (U05). Every decision lives in the shared core
//  (@despia/kernel image-core.ts, corpus OpenSource/Conformance/image/resolution.json); this
//  file is only the browser plumbing: the CSS mappings, the fetch hints, the transition gate,
//  the placeholder paint, and the recycling clear.
//
//  WHY THIS IS ITS OWN FILE. elements.ts is shared by every UI workstream, so the `<image>`
//  factory there keeps its icon/src/asset shape and calls in here with one line:
//  `applyImageAttributes(e, node.attrs, api)`.
//
//  THE WEB IS THE RENDERER THAT ALREADY HAD HALF OF THIS. `object-fit`/`object-position` are
//  `contentFit`/`contentPosition` exactly, `fetchpriority` is `priority`, and the HTTP cache is
//  a better `cachePolicy` than anything we would write. So the adapter's job is to map, not to
//  reimplement — and to be honest about the two places where there is nothing to map to.
//
//  THE TWO HONEST GAPS, MARKED RATHER THAN FAKED:
//    • `allowDownscaling` — the browser decodes at the size it paints and exposes no knob. The
//      attribute is accepted and inert here; the two natives do the real work.
//    • `on:progress` — an `<img>` reports no byte progress. Rather than invent one from a timer,
//      a bound handler marks the element `data-dsx-unsupported="progress"` so the absence is
//      inspectable, which is the typed-absence rule applied to an element attribute.
//
//  `cacheType` IS OBSERVABLE ONLY AS "memory OR not". An `<img>` whose `complete` is already
//  true in the same turn as the `src` write came out of the browser's decoded cache; anything
//  else took a load event and the browser will not say whether it hit disk. Reporting `disk`
//  from a guess would make `on:load` lie, so the payload reports what is knowable.
//

import {
  resolveContentFit,
  resolveContentPosition,
  resolveCachePolicy,
  resolveTransition,
  shouldTransition,
  classifyPlaceholder,
  decodePlaceholder,
  resolveRecycling,
  resolveImagePriority,
  imageMediaType,
  type CacheType,
  type DecodedPixels,
} from "@despia/kernel";

/** The live handle the factory keeps, so a reactive `src=` write can run the recycling ladder
 *  in the same turn it changes the identity. */
export interface ImageBinding {
  /** Returns true when the displayed image was CLEARED because the identity changed. */
  update(next: { src?: string; recyclingKey?: string; rowKey?: string; asset?: string }): boolean;
  readonly cacheType: CacheType;
}

/** What the adapter needs from the renderer; `ElementApi` satisfies it structurally. */
export interface ImageHooks {
  handler(name: string, payload?: Record<string, unknown>): void;
  hasHandler(name: string): boolean;
}

/** `contentFit` → the CSS keyword. Only `scaleDown` differs, and only in spelling. */
export function objectFitValue(fit: string | null | undefined): string {
  const word = resolveContentFit(fit);
  return word === "scaleDown" ? "scale-down" : word;
}

/** `contentPosition` → `object-position`, the same 0…1 anchors written as percentages.
 *
 *  Quantised to four decimals, the same place the scroll core publishes at: a raw `0.1 * 100`
 *  is a binary fraction, and a CSS string that reads `10.000000000000002%` is a diff nobody can
 *  review and a snapshot nobody can pin. */
function percent(fraction: number): string {
  return String(Math.round(fraction * 1000000) / 10000);
}

export function objectPositionValue(position: string | null | undefined): string {
  const anchor = resolveContentPosition(position);
  return `${percent(anchor.x)}% ${percent(anchor.y)}%`;
}

/** `priority` → the two fetch hints a browser actually reads. `low` is also the only one that
 *  earns `loading="lazy"`: lazily loading a hero is how a page gets a blank fold. */
export function fetchHints(priority: string | null | undefined): { fetchpriority: string; loading: string } {
  const word = resolveImagePriority(priority);
  if (word === "high") return { fetchpriority: "high", loading: "eager" };
  if (word === "low") return { fetchpriority: "low", loading: "lazy" };
  return { fetchpriority: "auto", loading: "eager" };
}

// ---------------------------------------------------------------------------- placeholder paint

/**
 * Decoded placeholder pixels → a `data:` URL, with no canvas and no codec dependency.
 *
 * BMP because it is the only raster format a browser accepts that can be written with a header
 * and a memcpy: PNG would need a deflate stream and a CRC table, and pulling either into the
 * renderer to paint a 32 px blur is the wrong trade. 24-bit, bottom-up, 4-byte row padding —
 * the format's own rules, and opaque on purpose, since a placeholder that shows the page
 * through it is not a placeholder.
 */
export function pixelsToBmpDataUrl(pixels: DecodedPixels): string {
  const { width, height } = pixels;
  const rowBytes = width * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const pixelBytes = (rowBytes + padding) * height;
  const size = 54 + pixelBytes;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  let offset = 54;
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      out[offset] = pixels.rgba[source + 2] ?? 0;
      out[offset + 1] = pixels.rgba[source + 1] ?? 0;
      out[offset + 2] = pixels.rgba[source] ?? 0;
      offset += 3;
    }
    offset += padding;
  }
  let binary = "";
  for (const byte of out) binary += String.fromCharCode(byte);
  const encode = (globalThis as unknown as { btoa?: (s: string) => string }).btoa;
  const base64 = encode !== undefined
    ? encode(binary)
    : (globalThis as unknown as { Buffer: { from(s: string, e: string): { toString(e: string): string } } })
        .Buffer.from(binary, "binary").toString("base64");
  return `data:image/bmp;base64,${base64}`;
}

/** The CSS a `placeholder` resolves to: a colour, a decoded hash as a stretched background, or
 *  nothing at all. An unparseable hash yields nothing rather than a broken image icon. */
export function placeholderStyle(
  placeholder: string | null | undefined,
  placeholderFit: string | null | undefined,
): { backgroundColor?: string; backgroundImage?: string; backgroundSize?: string } {
  const resolved = classifyPlaceholder(placeholder);
  if (resolved.kind === "none") return {};
  if (resolved.kind === "color") return { backgroundColor: resolved.value };
  if (resolved.kind === "asset") return { backgroundImage: `url("${resolved.value}")`, backgroundSize: objectFitValue(placeholderFit) };
  const pixels = decodePlaceholder(resolved, 32, 32);
  if (pixels === null) return {};
  return {
    backgroundImage: `url("${pixelsToBmpDataUrl(pixels)}")`,
    backgroundSize: objectFitValue(placeholderFit),
  };
}

// ---------------------------------------------------------------------------- the adapter

/**
 * THE CALL SITE. `applyImageAttributes(e, node.attrs, api)` at the end of the `<img>` branch of
 * elements.ts's image factory. Everything U05 adds to `<image>` rides this one call; the
 * icon branch above it is untouched, because a symbol has no content box to fit.
 */
export function applyImageAttributes(
  image: HTMLImageElement,
  attributes: Record<string, string | undefined>,
  hooks: ImageHooks,
): ImageBinding {
  const style = image.style;
  style.setProperty("object-fit", objectFitValue(attributes["contentFit"]));
  style.setProperty("object-position", objectPositionValue(attributes["contentPosition"]));

  const hints = fetchHints(attributes["priority"]);
  image.setAttribute("fetchpriority", hints.fetchpriority);
  image.setAttribute("loading", hints.loading);
  image.setAttribute("decoding", "async");

  const placeholder = placeholderStyle(attributes["placeholder"], attributes["placeholderFit"] ?? attributes["contentFit"]);
  if (placeholder.backgroundColor !== undefined) style.setProperty("background-color", placeholder.backgroundColor);
  if (placeholder.backgroundImage !== undefined) {
    style.setProperty("background-image", placeholder.backgroundImage);
    style.setProperty("background-repeat", "no-repeat");
    style.setProperty("background-position", "center");
  }
  if (placeholder.backgroundSize !== undefined) style.setProperty("background-size", placeholder.backgroundSize);

  const filters: string[] = [];
  const blur = Number(attributes["blurRadius"] ?? "");
  if (Number.isFinite(blur) && blur > 0) filters.push(`blur(${blur}px)`);
  if (filters.length > 0) style.setProperty("filter", filters.join(" "));

  // `tint` is template rendering: the image becomes a stencil for one colour. `mask-image` is
  // the only way to do it to a raster without a canvas round-trip, and it is what the two
  // natives do too (a template UIImage / a ColorFilter). The mask follows the source, so it is
  // (re)written by `update()` rather than once at wire time.
  const tint = attributes["tint"];
  const applyTint = (source: string): void => {
    if (tint === undefined || tint.length === 0) return;
    style.setProperty("background-color", tint);
    style.setProperty("-webkit-mask-image", `url("${source}")`);
    style.setProperty("mask-image", `url("${source}")`);
    style.setProperty("mask-size", objectFitValue(attributes["contentFit"]));
  };

  const transition = resolveTransition(attributes["transition"]);
  const policy = resolveCachePolicy(attributes["cachePolicy"], attributes["cache"]);
  // The browser owns the bytes, so `memoryDisk`/`disk`/`memory` are all "use the HTTP cache" and
  // only `none` has anything to add — the cache-bust the existing factory already writes. What
  // the policy DOES decide here is whether a hit may be reported as a memory hit at all.
  const mayReportMemory = policy.memory;

  // `allowDownscaling` is inert on the web by construction (see the header). Recorded so a
  // reader of the DOM can see the attribute was understood rather than ignored.
  if (attributes["allowDownscaling"] === "false") image.setAttribute("data-dsx-downscaling", "false");
  if (hooks.hasHandler("progress")) image.setAttribute("data-dsx-unsupported", "progress");

  let previousKey: string | null = null;

  // Captured at wire time, which is the only moment the answer is knowable: an <img> whose
  // `complete` is already true in this turn came out of the browser's decoded cache.
  let cacheType: CacheType = "none";
  const startOpacity = (): void => {
    cacheType = image.complete && mayReportMemory ? "memory" : "none";
    if (shouldTransition(transition, cacheType)) {
      style.setProperty("opacity", "0");
      style.setProperty("transition", `opacity ${transition.duration}ms ease`);
    } else {
      style.setProperty("opacity", "1");
      style.removeProperty("transition");
    }
  };
  startOpacity();

  image.addEventListener("load", () => {
    style.setProperty("opacity", "1");
    if (!hooks.hasHandler("load")) return;
    const source = image.getAttribute("src") ?? "";
    const dot = source.lastIndexOf(".");
    const extension = dot < 0 ? "" : source.slice(dot + 1).split("?")[0] ?? "";
    hooks.handler("load", {
      width: image.naturalWidth,
      height: image.naturalHeight,
      mediaType: imageMediaType(extension),
      cacheType,
    });
  });

  const fallback = attributes["fallback"];
  image.addEventListener("error", () => {
    const url = image.getAttribute("src") ?? "";
    if (fallback !== undefined && fallback.length > 0 && url !== fallback) {
      image.setAttribute("src", fallback);
      return;
    }
    style.setProperty("opacity", "1");
    if (hooks.hasHandler("error")) {
      hooks.handler("error", { error: "image_load_failed", url });
    }
  });

  const binding: ImageBinding = {
    /**
     * Called on every reactive `src`/`recyclingKey` write, BEFORE the new source lands.
     *
     * THE BUG THIS FIXES: the row was reused and the OLD image is still painted under the new
     * row's text until the new bytes arrive. Clearing in the same turn as the identity change is
     * the whole point — a clear that waits for the load event has not fixed anything. The ladder
     * is the core's: author key, then the list's row key, then src, then asset.
     */
    update(next) {
      const recycling = resolveRecycling({
        recyclingKey: next.recyclingKey ?? attributes["recyclingKey"],
        rowKey: next.rowKey ?? attributes["data-dsx-row-key"],
        src: next.src ?? attributes["src"],
        asset: next.asset ?? attributes["asset"],
        previousKey,
      });
      // Three conditions, all necessary. `clear` alone is true on the FIRST resolution (there is
      // no previous identity to differ from), and an element with no src has nothing stale to
      // remove — so seeding the ladder from a raw `{{ }}` attribute before the first interpolated
      // write cannot blank an image that was never painted.
      const cleared = recycling.clear && previousKey !== null && image.getAttribute("src") !== null;
      if (cleared) {
        image.removeAttribute("src");
        style.setProperty("opacity", "0");
      }
      previousKey = recycling.key;
      applyTint(next.src ?? image.getAttribute("src") ?? "");
      return cleared;
    },
    get cacheType() { return cacheType; },
  };
  binding.update({ src: attributes["src"], recyclingKey: attributes["recyclingKey"] });
  return binding;
}
