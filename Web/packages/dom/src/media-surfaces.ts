//
//  media-surfaces.ts - bounded browser-native twins for DSX media primitives.
//
//  Playback deliberately rides the platform's HTMLMediaElement implementation;
//  DSX owns state/event adaptation, source policy, teardown, and neutral chrome.
//  SVG markup is never handed through directly: a small platform-neutral parser
//  accepts only the same static shape subset as the native Canvas renderer.
//


import { number, string, truthy, type Dict } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import { ELEMENTS, type ElementApi, type ElementFactory } from "./elements.ts";
import type { MountCtx } from "./mount.ts";
import { bindPresentation } from "./overlay-controls.ts";

export const MEDIA_SURFACE_TAGS: ReadonlySet<string> = new Set([
  "audio", "video", "svg", "lightbox",
]);

export const MEDIA_SURFACE_LIMITS = Object.freeze({
  urlCharacters: 4_096,
  eventMessageCharacters: 512,
  svgCharacters: 64 * 1_024,
  svgPrimitives: 512,
  svgPathTokens: 8_192,
  svgDimension: 16_384,
  svgViewBoxCharacters: 256,
  svgPaintCharacters: 96,
  lightboxImages: 256,
  lightboxCsvCharacters: 1_048_576,
  lightboxSourceFieldCharacters: 128,
  lightboxColorCharacters: 96,
  previewWidth: 240,
  previewHeight: 240,
  previewTimeoutMilliseconds: 5_000,
  loadTimeoutMilliseconds: 15_000,
});

const SAFE_MEDIA_SCHEMES = new Set(["http", "https", "blob"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A URL policy shared by media, lightbox and SSR. Relative application assets,
 * HTTPS/HTTP CDNs and caller-owned blob URLs are accepted. Script, local-file,
 * data and custom schemes fail closed before reaching a browser fetch primitive. */
export function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MEDIA_SURFACE_LIMITS.urlCharacters) return null;
  const candidate = value.trim();
  if (candidate.length === 0
      || CONTROL_CHARACTERS.test(candidate) || candidate.includes("\\")) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(candidate)?.[1]?.toLowerCase();
  if (scheme !== undefined && !SAFE_MEDIA_SCHEMES.has(scheme)) return null;
  // A colon before any path/query delimiter is an unrecognised scheme even when
  // malformed enough to miss the RFC scheme expression above.
  if (scheme === undefined) {
    const colon = candidate.indexOf(":");
    const delimiter = candidate.search(/[/?#]/);
    if (colon >= 0 && (delimiter < 0 || colon < delimiter)) return null;
  }
  try { new URL(candidate, "https://dsx.invalid/"); } catch { return null; }
  return candidate;
}

export function boundedMediaText(value: unknown): string {
  const raw = typeof value === "string" ? value
    : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" ? String(value) : "";
  return Array.from(raw.substring(0, MEDIA_SURFACE_LIMITS.eventMessageCharacters * 4))
    .slice(0, MEDIA_SURFACE_LIMITS.eventMessageCharacters).join("");
}

function finite(value: unknown, fallback: number): number {
  const parsed = number(value);
  return parsed !== null && parsed !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

function enabled(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = string(value).trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on" || normalized === "") return true;
  return truthy(value);
}

export function normalizeMediaRate(value: unknown): number {
  return Math.min(Math.max(finite(value, 1), 0.25), 4);
}

function setBound(api: ElementApi, path: string | undefined, value: unknown): void {
  if (path !== undefined && path.trim().length > 0) api.writeBack(path, value);
}

type MediaKind = "audio" | "video";
type MediaElement = HTMLAudioElement | HTMLVideoElement;

export type MediaSessionOwner = Readonly<{
  element: MediaElement;
  clear(): void;
}>;

/** Media Session is page-global, while DSX widgets can carry independently bundled
 * copies of this module. Symbol.for gives every bundle one ownership ledger. */
export const MEDIA_SESSION_OWNER_SYMBOL = Symbol.for("dsx.mediaSessionOwner.v1");

function sharedMediaSessionOwner(): MediaSessionOwner | null {
  try {
    const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, MEDIA_SESSION_OWNER_SYMBOL);
    if (globalDescriptor === undefined || !("value" in globalDescriptor)
        || globalDescriptor.value === null || typeof globalDescriptor.value !== "object") return null;
    const element = Object.getOwnPropertyDescriptor(globalDescriptor.value, "element");
    const clear = Object.getOwnPropertyDescriptor(globalDescriptor.value, "clear");
    if (element === undefined || !("value" in element) || element.value === null
        || typeof element.value !== "object" || clear === undefined || !("value" in clear)
        || typeof clear.value !== "function") return null;
    // Return a plain snapshot of the proven data descriptors. Returning the
    // original object would let a hostile Proxy re-enter a throwing `get` trap
    // when callers later read owner.element/owner.clear outside this guard.
    return Object.freeze({
      element: element.value as MediaElement,
      clear: clear.value as () => void,
    });
  } catch { return null; }
}

function writeSharedMediaSessionOwner(owner: MediaSessionOwner | null): boolean {
  try {
    Object.defineProperty(globalThis, MEDIA_SESSION_OWNER_SYMBOL, {
      configurable: true, enumerable: false, writable: true, value: owner,
    });
    return true;
  } catch { return false; }
}

/** Internal lifecycle seam exported from the focused module for an isolated-bundle
 * regression. It is deliberately not re-exported by the package root. */
export function claimMediaSessionOwnership(owner: MediaSessionOwner): boolean {
  const previous = sharedMediaSessionOwner();
  if (!writeSharedMediaSessionOwner(owner)) return false;
  if (previous !== null && previous !== owner) {
    try { previous.clear(); } catch { /* a stale/foreign bundle cannot block the new owner */ }
  }
  return true;
}

export function releaseMediaSessionOwnership(element: MediaElement): void {
  const owner = sharedMediaSessionOwner();
  if (owner?.element !== element || !writeSharedMediaSessionOwner(null)) return;
  try { owner.clear(); } catch { /* disposal stays best effort */ }
}

function installMediaSession(
  element: MediaElement,
  title: string,
  artist: string,
  skip: number,
  api: ElementApi,
): void {
  const session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
  if (session === undefined) return;

  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
    try { session.setActionHandler(action, handler); } catch { /* action unsupported by this engine */ }
  };
  const seekBy = (delta: number): void => {
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    if (duration <= 0 || !Number.isFinite(delta)) return;
    try { element.currentTime = Math.min(Math.max(element.currentTime + delta, 0), duration); } catch { /* UA owns seekability */ }
  };
  const seekOffset = (value: number | undefined): number => Number.isFinite(value) && (value ?? 0) > 0
    ? Math.min(value!, 3_600) : skip;
  const clear = (): void => {
    for (const action of [
      "play", "pause", "seekbackward", "seekforward", "seekto", "nexttrack", "previoustrack",
    ] as const) set(action, null);
    try { session.metadata = null; } catch { /* old Media Session implementations */ }
  };
  if (!claimMediaSessionOwnership(Object.freeze({ element, clear }))) return;
  try {
    if (typeof MediaMetadata !== "undefined") {
      session.metadata = new MediaMetadata({
        title: boundedMediaText(title) || "Media",
        artist: boundedMediaText(artist),
      });
    }
  } catch { /* feature-detected enhancement; playback remains functional */ }

  set("play", () => { void element.play().catch(() => undefined); });
  set("pause", () => element.pause());
  set("seekbackward", (details) => seekBy(-seekOffset(details.seekOffset)));
  set("seekforward", (details) => seekBy(seekOffset(details.seekOffset)));
  set("seekto", (details) => {
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    if (details.seekTime === undefined || !Number.isFinite(details.seekTime) || duration <= 0) return;
    try { element.currentTime = Math.min(Math.max(details.seekTime, 0), duration); } catch { /* UA owns seekability */ }
  });
  set("nexttrack", () => api.handler("remoteNext"));
  set("previoustrack", () => api.handler("remotePrev"));
}

function updateMediaSessionPosition(element: MediaElement): void {
  if (sharedMediaSessionOwner()?.element !== element || typeof navigator === "undefined") return;
  const session = navigator.mediaSession;
  if (session?.setPositionState === undefined) return;
  const duration = element.duration;
  const position = element.currentTime;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
  try {
    session.setPositionState({
      duration,
      position: Math.min(Math.max(position, 0), duration),
      playbackRate: normalizeMediaRate(element.playbackRate),
    });
  } catch { /* browser owns the system integration */ }
}

function applyTextTracks(video: HTMLVideoElement, show: boolean): void {
  const candidates = Array.from(video.textTracks)
    .filter((track) => track.kind === "subtitles" || track.kind === "captions");
  const language = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  const preferred = candidates.find((track) => language.startsWith(track.language.toLowerCase())) ?? candidates[0];
  for (const track of candidates) track.mode = show && track === preferred ? "showing" : "disabled";
}

export function mediaErrorMessage(code: unknown): string {
  // Use the HTMLMediaError numeric contract directly. Some WebKit-derived hosts
  // expose `element.error` without installing a global MediaError constructor.
  if (code === 1) return "media loading was aborted";
  if (code === 2) return "media could not be loaded from the network";
  if (code === 3) return "media could not be decoded";
  if (code === 4) return "media source is not supported";
  return "media playback failed";
}

function browserMediaError(element: MediaElement): string {
  return mediaErrorMessage(element.error?.code);
}

function mediaFactory(kind: MediaKind): ElementFactory {
  return (node, ctx, api) => {
    const media = document.createElement(kind) as MediaElement;
    media.className = kind === "audio" ? "dsx-audio" : "dsx-video";
    media.preload = "metadata";
    media.controls = false;
    if (kind === "audio") {
      media.tabIndex = -1;
      media.setAttribute("aria-hidden", "true");
    } else {
      const video = media as HTMLVideoElement;
      video.playsInline = true;
      if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined) {
        video.setAttribute("aria-label", "Video");
      }
    }

    let disposed = false;
    let source = "";
    let sourceHref = "";
    let sourceEpoch = 0;
    let readyEpoch = -1;
    let errorEpoch = -1;
    let active = true;
    let autoplay = true;
    let authoredMuted = false;
    let authoredPaused = false;
    let hasPausedBinding = node.attrs["paused"] !== undefined;
    let loop = false;
    let start = 0;
    let startAppliedEpoch = -1;
    let scrubbing = false;
    let wasScrubbing = false;
    let fraction = 0;
    let lastPublishedFraction = -1;
    let lastPublishedSecond = -1;
    let lastDuration = -1;
    let lastBuffering: boolean | null = null;
    let lastReload: number | null = null;
    let subtitles = false;
    let allowPip = false;
    let nowPlaying = false;
    let nowTitle = "";
    let nowArtist = "";
    let remoteSkip = kind === "audio" ? 15 : 5;
    let previewUrl = "";
    let previewGeneration = 0;
    let lastPreviewSecond = -1;
    let previewDecoder: HTMLVideoElement | null = null;
    let previewDecoderSource = "";
    let previewTargetSeconds = 0;
    let previewTimer: ReturnType<typeof setTimeout> | null = null;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let initialized = false;
    let pendingError = "";
    let ignoreNextPause = false;
    const mediaListeners: Array<readonly [string, EventListener]> = [];

    const sourceIsCurrent = (): boolean => {
      if (sourceHref.length === 0) return false;
      const selected = media.currentSrc;
      return selected.length > 0 && selected === sourceHref && media.src === sourceHref;
    };

    const listen = (type: string, callback: () => void, sourceScoped = true): void => {
      const listener: EventListener = () => {
        if (!disposed && (!sourceScoped || sourceIsCurrent())) callback();
      };
      media.addEventListener(type, listener);
      mediaListeners.push([type, listener]);
    };

    const pauseInternally = (): void => {
      if (media.paused) return;
      ignoreNextPause = true;
      media.pause();
    };

    const destroyPreviewDecoder = (): void => {
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewTimer = null;
      const decoder = previewDecoder;
      previewDecoder = null;
      previewDecoderSource = "";
      if (decoder === null) return;
      decoder.onloadedmetadata = null;
      decoder.onloadeddata = null;
      decoder.onseeked = null;
      decoder.onerror = null;
      try { decoder.pause(); } catch { /* synthetic/tearing-down decoder */ }
      decoder.removeAttribute("src");
      try { decoder.load(); } catch { /* synthetic/tearing-down decoder */ }
    };

    const clearPreview = (publish = active): void => {
      previewGeneration += 1;
      destroyPreviewDecoder();
      if (previewUrl.length > 0) URL.revokeObjectURL(previewUrl);
      previewUrl = "";
      lastPreviewSecond = -1;
      if (!disposed && publish) setBound(api, node.attrs["preview"], "");
    };

    const clearLoadTimeout = (): void => {
      if (loadTimer !== null) clearTimeout(loadTimer);
      loadTimer = null;
    };

    const publishBuffering = (value: boolean): void => {
      if (disposed || !initialized || !active || lastBuffering === value) return;
      lastBuffering = value;
      setBound(api, node.attrs["buffering"], value);
    };

    const reportError = (message: string): void => {
      if (disposed) return;
      clearLoadTimeout();
      if (!initialized || !active) { pendingError = message; return; }
      if (errorEpoch === sourceEpoch) return;
      errorEpoch = sourceEpoch;
      pendingError = "";
      publishBuffering(false);
      api.handler("error", { message: boundedMediaText(message) } as Dict);
    };

    const scheduleLoadTimeout = (): void => {
      clearLoadTimeout();
      if (disposed || !initialized || !active || source.length === 0 || readyEpoch === sourceEpoch) return;
      const epoch = sourceEpoch;
      loadTimer = setTimeout(() => {
        loadTimer = null;
        if (disposed || !active || source.length === 0 || epoch !== sourceEpoch || readyEpoch === epoch) return;
        reportError(`${kind} loading timed out`);
      }, MEDIA_SURFACE_LIMITS.loadTimeoutMilliseconds);
    };

    const syncPlayback = (): void => {
      if (!initialized) return;
      if (disposed || source.length === 0 || !active || authoredPaused) {
        pauseInternally();
        return;
      }
      if (!hasPausedBinding && !autoplay) return;
      void media.play().catch(() => {
        // Autoplay permission is a user-agent policy, not a broken media source.
        // Keep DSX state truthful without misreporting a transport/decode failure.
        if (!disposed && hasPausedBinding) setBound(api, node.attrs["paused"], true);
      });
    };

    const publishTime = (): void => {
      if (disposed || !active || scrubbing || !Number.isFinite(media.duration) || media.duration <= 0) return;
      const time = Number.isFinite(media.currentTime) ? media.currentTime : 0;
      const nextFraction = Math.min(Math.max(time / media.duration, 0), 1);
      if (Math.abs(nextFraction - lastPublishedFraction) > 0.02) {
        lastPublishedFraction = nextFraction;
        fraction = nextFraction;
        setBound(api, node.attrs["bind"], nextFraction);
      }
      const second = Math.max(0, Math.trunc(time));
      if (second !== lastPublishedSecond) {
        lastPublishedSecond = second;
        setBound(api, node.attrs["time"], time);
        api.handler("timeupdate", { time, duration: media.duration } as Dict);
        updateMediaSessionPosition(media);
      }
    };

    const publishDuration = (): void => {
      const duration = media.duration;
      if (disposed || !active || !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - lastDuration) <= 0.5) return;
      lastDuration = duration;
      setBound(api, node.attrs["duration"], duration);
    };

    const publishActivationReadouts = (): void => {
      const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
      let time = duration > 0 && Number.isFinite(media.currentTime)
        ? Math.min(Math.max(media.currentTime, 0), duration) : 0;
      let nextFraction = duration > 0 ? time / duration : 0;
      if (nextFraction >= 0.995) {
        time = 0;
        nextFraction = 0;
        try { media.currentTime = 0; } catch { /* not seekable yet */ }
      }
      fraction = nextFraction;
      lastPublishedFraction = nextFraction;
      lastPublishedSecond = Math.trunc(time);
      lastDuration = duration;
      setBound(api, node.attrs["bind"], nextFraction);
      setBound(api, node.attrs["time"], time);
      setBound(api, node.attrs["duration"], duration);
      setBound(api, node.attrs["preview"], "");
      const buffering = source.length > 0 && readyEpoch !== sourceEpoch && errorEpoch !== sourceEpoch;
      lastBuffering = buffering;
      setBound(api, node.attrs["buffering"], buffering);
    };

    const seekFraction = (value: number, precise: boolean): void => {
      fraction = Math.min(Math.max(value, 0), 1);
      if (!Number.isFinite(media.duration) || media.duration <= 0) return;
      const target = fraction * media.duration;
      if (precise || Math.abs(target - media.currentTime) > 0.75) {
        try { media.currentTime = target; } catch { /* metadata may not be seekable yet */ }
      }
    };

    const failPreview = (generation: number): void => {
      if (disposed || generation !== previewGeneration) return;
      destroyPreviewDecoder();
      if (previewUrl.length > 0) URL.revokeObjectURL(previewUrl);
      previewUrl = "";
      if (active) setBound(api, node.attrs["preview"], "");
    };

    const drawPreviewFrame = (decoder: HTMLVideoElement, generation: number): void => {
      if (disposed || generation !== previewGeneration || decoder !== previewDecoder
          || decoder.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
          || Math.abs(decoder.currentTime - previewTargetSeconds) > 0.12
          || decoder.videoWidth <= 0 || decoder.videoHeight <= 0) return;
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewTimer = null;
      const scale = Math.min(
        MEDIA_SURFACE_LIMITS.previewWidth / decoder.videoWidth,
        MEDIA_SURFACE_LIMITS.previewHeight / decoder.videoHeight,
        1,
      );
      const width = Math.max(1, Math.round(decoder.videoWidth * scale));
      const height = Math.max(1, Math.round(decoder.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) { failPreview(generation); return; }
      try { context.drawImage(decoder, 0, 0, width, height); } catch {
        failPreview(generation);
        return;
      }
      try {
        canvas.toBlob((blob) => {
          if (blob === null) { failPreview(generation); return; }
          if (disposed || !active || generation !== previewGeneration) return;
          const next = URL.createObjectURL(blob);
          if (disposed || generation !== previewGeneration) { URL.revokeObjectURL(next); return; }
          if (previewUrl.length > 0) URL.revokeObjectURL(previewUrl);
          previewUrl = next;
          setBound(api, node.attrs["preview"], next);
        }, "image/jpeg", 0.78);
      } catch {
        // drawImage can succeed for a cross-origin frame while serialization is
        // the operation that discovers the tainted canvas. Preview is optional.
        failPreview(generation);
      }
    };

    const seekPreviewFrame = (decoder: HTMLVideoElement, generation: number): void => {
      if (disposed || generation !== previewGeneration || decoder !== previewDecoder) return;
      const duration = decoder.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      previewTargetSeconds = Math.min(Math.max(fraction * duration, 0), duration);
      if (decoder.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && Math.abs(decoder.currentTime - previewTargetSeconds) <= 0.12) {
        drawPreviewFrame(decoder, generation);
        return;
      }
      try { decoder.currentTime = previewTargetSeconds; } catch { failPreview(generation); }
    };

    const generatePreview = (): void => {
      if (disposed || !active || kind !== "video" || !scrubbing || node.attrs["preview"] === undefined || source.length === 0) return;
      const knownDuration = previewDecoder?.duration ?? media.duration;
      const target = Number.isFinite(knownDuration) && knownDuration > 0 ? fraction * knownDuration : Number.NaN;
      if (Number.isFinite(target) && Math.abs(target - lastPreviewSecond) < 0.25) return;
      if (Number.isFinite(target)) lastPreviewSecond = target;
      if (previewDecoder === null || previewDecoderSource !== source) destroyPreviewDecoder();
      const generation = ++previewGeneration;
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => failPreview(generation), MEDIA_SURFACE_LIMITS.previewTimeoutMilliseconds);

      if (previewDecoder === null) {
        const decoder = document.createElement("video");
        previewDecoder = decoder;
        previewDecoderSource = source;
        decoder.muted = true;
        decoder.playsInline = true;
        decoder.preload = "auto";
        decoder.crossOrigin = "anonymous";
        decoder.onloadedmetadata = () => seekPreviewFrame(decoder, previewGeneration);
        decoder.onloadeddata = () => seekPreviewFrame(decoder, previewGeneration);
        decoder.onseeked = () => drawPreviewFrame(decoder, previewGeneration);
        decoder.onerror = () => failPreview(previewGeneration);
        decoder.src = source;
        try { decoder.load(); } catch { failPreview(generation); }
        return;
      }
      seekPreviewFrame(previewDecoder, generation);
    };

    const metadataLoaded = (): void => {
      if (startAppliedEpoch !== sourceEpoch) {
        startAppliedEpoch = sourceEpoch;
        if (start > 0 && Number.isFinite(media.duration) && media.duration > 0) {
          try { media.currentTime = Math.min(start, media.duration); } catch { /* not seekable */ }
        }
      }
      publishDuration();
      if (kind === "video") applyTextTracks(media as HTMLVideoElement, subtitles);
    };

    const playable = (): void => {
      if (media.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
      clearLoadTimeout();
      publishBuffering(false);
      if (readyEpoch !== sourceEpoch) {
        readyEpoch = sourceEpoch;
        api.handler("ready");
      }
      syncPlayback();
    };

    listen("loadedmetadata", metadataLoaded);
    listen("loadeddata", playable);
    listen("durationchange", publishDuration);
    listen("timeupdate", publishTime);
    listen("ended", () => api.handler("ended"));
    listen("waiting", () => publishBuffering(true));
    listen("stalled", () => publishBuffering(true));
    listen("canplay", playable);
    listen("playing", () => {
      playable();
      if (hasPausedBinding) setBound(api, node.attrs["paused"], false);
      if (nowPlaying) installMediaSession(media, nowTitle, nowArtist, remoteSkip, api);
    });
    listen("pause", () => {
      if (ignoreNextPause) { ignoreNextPause = false; return; }
      if (!disposed && active && hasPausedBinding) setBound(api, node.attrs["paused"], true);
    }, false);
    listen("error", () => reportError(browserMediaError(media)));

    // Resolve activity before src. An inactive pager preload must never overwrite
    // the shared active clip's transport/readout bindings.
    api.bindText(node.attrs["active"] ?? "true", (value) => {
      const wasActive = active;
      active = kind === "audio" ? true : enabled(value, true);
      if (!active) {
        clearLoadTimeout();
        clearPreview(false);
        pauseInternally();
        releaseMediaSessionOwnership(media);
      } else {
        if (!wasActive) publishActivationReadouts();
        if (pendingError.length > 0) reportError(pendingError);
        if (source.length > 0 && readyEpoch !== sourceEpoch && errorEpoch !== sourceEpoch) scheduleLoadTimeout();
        syncPlayback();
      }
    });

    api.bindText(node.attrs["src"] ?? "", (raw) => {
      const next = safeMediaUrl(raw);
      const value = next ?? "";
      const hasAuthoredSource = raw.length > MEDIA_SURFACE_LIMITS.urlCharacters || raw.trim().length > 0;
      if (value === source && !(next === null && hasAuthoredSource)) return;
      sourceEpoch += 1;
      source = value;
      try { sourceHref = value.length === 0 ? "" : new URL(value, document.baseURI).href; } catch { sourceHref = ""; }
      readyEpoch = -1;
      errorEpoch = -1;
      startAppliedEpoch = -1;
      lastPublishedSecond = -1;
      lastPublishedFraction = -1;
      lastDuration = -1;
      const sourceBuffering = next !== null && active;
      lastBuffering = active ? sourceBuffering : null;
      pendingError = "";
      clearLoadTimeout();
      clearPreview();
      if (active) {
        setBound(api, node.attrs["time"], 0);
        setBound(api, node.attrs["duration"], 0);
        setBound(api, node.attrs["buffering"], sourceBuffering);
      }
      pauseInternally();
      if (next === null) {
        media.removeAttribute("src");
        media.load();
        if (hasAuthoredSource) reportError(`invalid ${kind} URL`);
        return;
      }
      media.src = next;
      media.load();
      scheduleLoadTimeout();
    });
    api.bindText(node.attrs["autoplay"] ?? "true", (value) => {
      autoplay = enabled(value, true);
      // DSX owns autoplay after every reactive input has been applied. Leaving the
      // native autoplay flag off prevents the browser racing an authored paused
      // binding while the element is still being configured.
      media.autoplay = false;
      syncPlayback();
    });
    api.bindText(node.attrs["loop"] ?? "false", (value) => { loop = enabled(value, false); media.loop = loop; });
    api.bindText(node.attrs["muted"] ?? "false", (value) => {
      authoredMuted = enabled(value, false);
      media.muted = authoredMuted;
    });
    api.bindText(node.attrs["speed"] ?? "1", (value) => {
      const rate = normalizeMediaRate(value);
      media.defaultPlaybackRate = rate;
      media.playbackRate = rate;
    });
    api.bindText(node.attrs["start"] ?? "0", (value) => { start = Math.max(0, finite(value, 0)); });
    api.bindText(node.attrs["reload"] ?? "0", (value) => {
      const reload = finite(value, 0);
      if (lastReload !== null && reload !== lastReload && source.length > 0) {
        sourceEpoch += 1;
        readyEpoch = -1;
        errorEpoch = -1;
        startAppliedEpoch = -1;
        lastPublishedSecond = -1;
        lastPublishedFraction = -1;
        lastDuration = -1;
        clearPreview();
        lastBuffering = active ? true : null;
        if (active) {
          setBound(api, node.attrs["time"], 0);
          setBound(api, node.attrs["duration"], 0);
          setBound(api, node.attrs["buffering"], true);
        }
        media.load();
        scheduleLoadTimeout();
      }
      lastReload = reload;
    });
    if (hasPausedBinding) {
      api.bindValue(node.attrs["paused"], (value) => {
        authoredPaused = truthy(value);
        syncPlayback();
      });
    }
    if (node.attrs["bind"] !== undefined) {
      api.bindValue(node.attrs["bind"], (value) => {
        if (!active) return;
        const next = Math.min(Math.max(finite(value, fraction), 0), 1);
        if (Math.abs(next - lastPublishedFraction) < 0.000_001) return;
        fraction = next;
        if (!scrubbing) seekFraction(next, false);
        else generatePreview();
      });
    }
    if (node.attrs["scrubbing"] !== undefined) {
      api.bindValue(node.attrs["scrubbing"], (value) => {
        scrubbing = truthy(value);
        if (wasScrubbing && !scrubbing) {
          if (active) seekFraction(fraction, true);
          clearPreview();
        } else if (scrubbing) generatePreview();
        wasScrubbing = scrubbing;
      });
    }
    if (kind === "video") {
      api.bindText(node.attrs["gravity"] ?? "fill", (value) => {
        (media as HTMLVideoElement).style.objectFit = value === "fit" ? "contain" : "cover";
      });
      api.bindText(node.attrs["subtitles"] ?? "false", (value) => {
        subtitles = enabled(value, false);
        applyTextTracks(media as HTMLVideoElement, subtitles);
      });
      api.bindText(node.attrs["pip"] ?? "false", (value) => {
        allowPip = enabled(value, false);
        const video = media as HTMLVideoElement & { disablePictureInPicture?: boolean };
        if ("disablePictureInPicture" in video) video.disablePictureInPicture = !allowPip;
      });
    }
    api.bindText(node.attrs["nowPlaying"] ?? "false", (value) => {
      nowPlaying = enabled(value, false);
      if (!nowPlaying) releaseMediaSessionOwnership(media);
      else if (!media.paused) installMediaSession(media, nowTitle, nowArtist, remoteSkip, api);
    });
    api.bindText(node.attrs["nowTitle"] ?? "", (value) => {
      nowTitle = boundedMediaText(value);
      if (nowPlaying && sharedMediaSessionOwner()?.element === media) installMediaSession(media, nowTitle, nowArtist, remoteSkip, api);
    });
    api.bindText(node.attrs["nowArtist"] ?? "", (value) => {
      nowArtist = boundedMediaText(value);
      if (nowPlaying && sharedMediaSessionOwner()?.element === media) installMediaSession(media, nowTitle, nowArtist, remoteSkip, api);
    });
    api.bindText(node.attrs["remoteSkip"] ?? (kind === "audio" ? "15" : "5"), (value) => {
      remoteSkip = Math.min(Math.max(finite(value, kind === "audio" ? 15 : 5), 1), 3_600);
      if (nowPlaying && sharedMediaSessionOwner()?.element === media) {
        installMediaSession(media, nowTitle, nowArtist, remoteSkip, api);
      }
    });
    initialized = true;
    if (active && pendingError.length > 0) reportError(pendingError);
    scheduleLoadTimeout();
    syncPlayback();

    ctx.disposers.push(() => {
      disposed = true;
      for (const [type, listener] of mediaListeners) media.removeEventListener(type, listener);
      mediaListeners.length = 0;
      clearLoadTimeout();
      releaseMediaSessionOwnership(media);
      clearPreview();
      pauseInternally();
      media.removeAttribute("src");
      source = "";
      sourceHref = "";
      media.load();
    });
    return media;
  };
}

export const audio: ElementFactory = mediaFactory("audio");
export const video: ElementFactory = mediaFactory("video");

// MARK: - Sanitized SVG subset

type SvgAttributes = Readonly<Record<string, string>>;
type SvgToken = Readonly<{ closing: boolean; name: string; attrs: SvgAttributes; selfClosing: boolean }>;

const SVG_SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polygon", "polyline"]);
const SVG_ROOT_ATTRIBUTES = new Set(["viewbox", "width", "height", "preserveaspectratio", "xmlns"]);
const SVG_SHAPE_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  path: new Set(["d", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity"]),
  circle: new Set(["cx", "cy", "r", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity"]),
  ellipse: new Set(["cx", "cy", "rx", "ry", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity"]),
  line: new Set(["x1", "y1", "x2", "y2", "stroke", "stroke-width", "opacity", "stroke-opacity", "stroke-linecap"]),
  polygon: new Set(["points", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linejoin"]),
  polyline: new Set(["points", "fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linejoin"]),
});

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseAttributes(source: string): SvgAttributes | null {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(source.slice(cursor));
    if (nameMatch === null) return null;
    const name = nameMatch[0].toLowerCase();
    cursor += nameMatch[0].length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "=") return null;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const quote = source[cursor];
    if (quote !== "\"" && quote !== "'") return null;
    cursor += 1;
    const end = source.indexOf(quote, cursor);
    if (end < 0) return null;
    const value = source.slice(cursor, end);
    if (value.includes("&") || value.includes("<") || CONTROL_CHARACTERS.test(value)
        || Object.prototype.hasOwnProperty.call(out, name)) return null;
    out[name] = value;
    cursor = end + 1;
  }
  return out;
}

function scanSvg(source: string): SvgToken[] | null {
  const tokens: SvgToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    const text = source.slice(cursor, start < 0 ? source.length : start);
    if (text.trim().length > 0) return null;
    if (start < 0) break;
    let end = start + 1;
    let quote = "";
    for (; end < source.length; end += 1) {
      const char = source[end]!;
      if (quote.length > 0) {
        if (char === quote) quote = "";
      } else if (char === "\"" || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end >= source.length || quote.length > 0) return null;
    let body = source.slice(start + 1, end).trim();
    if (body.startsWith("!") || body.startsWith("?")) return null;
    const closing = body.startsWith("/");
    if (closing) body = body.slice(1).trim();
    const selfClosing = !closing && body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1).trim();
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(body);
    if (nameMatch === null) return null;
    const name = nameMatch[0].toLowerCase();
    const attrSource = body.slice(nameMatch[0].length).trim();
    if (closing && attrSource.length > 0) return null;
    const attrs = closing ? {} : parseAttributes(attrSource);
    if (attrs === null) return null;
    tokens.push({ closing, name, attrs, selfClosing });
    cursor = end + 1;
  }
  return tokens;
}

function scalar(value: string, options: { positive?: boolean; unitInterval?: boolean; maxAbs?: number } = {}): string | null {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > (options.maxAbs ?? 1_000_000_000)) return null;
  if (options.positive === true && parsed < 0) return null;
  if (options.unitInterval === true && (parsed < 0 || parsed > 1)) return null;
  return String(Object.is(parsed, -0) ? 0 : parsed);
}

function numberList(value: string, exact?: number): string | null {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > MEDIA_SURFACE_LIMITS.svgPathTokens || (exact !== undefined && parts.length !== exact)) return null;
  const normalized = parts.map((part) => scalar(part));
  return normalized.some((part) => part === null) ? null : normalized.join(" ");
}

function paint(value: string): string | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  const tokens: Readonly<Record<string, string>> = {
    accent: "var(--dsx-accent)",
    label: "var(--dsx-label)",
    text: "var(--dsx-label)",
    secondary: "var(--dsx-secondary-label)",
    tertiary: "var(--dsx-tertiary-label)",
    fill: "var(--dsx-fill)",
    separator: "var(--dsx-separator)",
    destructive: "var(--dsx-destructive)",
  };
  if (tokens[lower] !== undefined) return tokens[lower]!;
  if (lower === "none" || lower === "transparent" || lower === "currentcolor") return lower === "currentcolor" ? "currentColor" : lower;
  // SVG follows CSS Color: eight digits are #RRGGBBAA. This is intentionally
  // different from StackStyle colors (for example lightbox), which are ARGB.
  if (/^#[0-9a-fA-F]{3,4}(?:[0-9a-fA-F]{3,4})?$/.test(trimmed)) return lower;
  if (/^[a-zA-Z]{1,24}$/.test(trimmed)) return lower;
  if (/^(?:rgb|rgba|hsl|hsla)\([0-9.,%+\-\s]+\)$/.test(trimmed) && trimmed.length <= 96) return trimmed;
  return null;
}

function pathData(value: string): string | null {
  if (value.length === 0 || value.length > MEDIA_SURFACE_LIMITS.svgCharacters) return null;
  const rawTokens = value.match(/[MmLlHhVvCcSsQqTtZz]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g);
  if (rawTokens === null || rawTokens.length > MEDIA_SURFACE_LIMITS.svgPathTokens) return null;
  const remainder = value.replace(/[MmLlHhVvCcSsQqTtZz]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g, "")
    .replace(/[\s,]/g, "");
  if (remainder.length > 0) return null;
  const arity: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };
  const out: string[] = [];
  let cursor = 0;
  let sawMove = false;
  while (cursor < rawTokens.length) {
    const command = rawTokens[cursor]!;
    if (!/^[A-Za-z]$/.test(command)) return null;
    const upper = command.toUpperCase();
    const width = arity[upper];
    if (width === undefined || (!sawMove && upper !== "M")) return null;
    cursor += 1;
    if (upper === "Z") { out.push(command); continue; }
    const start = cursor;
    while (cursor < rawTokens.length && !/^[A-Za-z]$/.test(rawTokens[cursor]!)) cursor += 1;
    const count = cursor - start;
    if (count === 0 || count % width !== 0) return null;
    out.push(command);
    for (let index = start; index < cursor; index += 1) {
      const normalized = scalar(rawTokens[index]!);
      if (normalized === null) return null;
      out.push(normalized);
    }
    if (upper === "M") sawMove = true;
  }
  return sawMove ? out.join(" ") : null;
}

function normalizedSvgAttribute(tag: string, name: string, value: string): string | null {
  if (tag === "svg") {
    if (name === "viewbox") {
      const list = numberList(value, 4);
      if (list === null) return null;
      const values = list.split(" ").map(Number);
      return values[2]! > 0 && values[3]! > 0 ? list : null;
    }
    if (name === "width" || name === "height") {
      return scalar(value, { positive: true, maxAbs: MEDIA_SURFACE_LIMITS.svgDimension });
    }
    if (name === "preserveaspectratio") {
      return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value.trim()) ? value.trim() : null;
    }
    if (name === "xmlns") return value === "http://www.w3.org/2000/svg" ? value : null;
    return null;
  }
  if (name === "d") return pathData(value);
  if (name === "points") {
    const list = numberList(value);
    return list !== null && list.split(" ").length >= 4 && list.split(" ").length % 2 === 0 ? list : null;
  }
  if (name === "fill" || name === "stroke") return paint(value);
  if (name === "opacity" || name === "fill-opacity" || name === "stroke-opacity") return scalar(value, { unitInterval: true });
  if (name === "stroke-width" || ["width", "height", "r", "rx", "ry"].includes(name)) return scalar(value, { positive: true });
  if (["x", "y", "cx", "cy", "x1", "x2", "y1", "y2"].includes(name)) return scalar(value);
  if (name === "stroke-linecap") return ["butt", "round", "square"].includes(value) ? value : null;
  if (name === "stroke-linejoin") return ["miter", "round", "bevel"].includes(value) ? value : null;
  return null;
}

/** Return canonical safe SVG or null. The entire document is rejected for unknown
 * elements/attributes, event handlers, scripts, styles, foreignObject, entities or
 * network references; there is no partial unsafe fallback. */
export function sanitizeSvgMarkup(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MEDIA_SURFACE_LIMITS.svgCharacters) return null;
  const source = value.trim();
  if (source.length === 0
      || /<\s*(?:script|style|foreignObject|image|use|a|iframe|object|embed|animate|set)\b/i.test(source)
      || /\bon[a-z]+\s*=/i.test(source) || /\b(?:href|src)\s*=/i.test(source)
      || /url\s*\(/i.test(source)) return null;
  const tokens = scanSvg(source);
  if (tokens === null || tokens.length < 2) return null;
  const stack: string[] = [];
  const out: string[] = [];
  let primitives = 0;
  let sawRoot = false;
  for (const token of tokens) {
    if (token.closing) {
      if (stack.pop() !== token.name) return null;
      out.push(`</${token.name}>`);
      continue;
    }
    if (!sawRoot) {
      if (token.name !== "svg" || token.selfClosing) return null;
      sawRoot = true;
    } else if (!SVG_SHAPES.has(token.name) || stack.length !== 1) return null;
    const allowed = token.name === "svg" ? SVG_ROOT_ATTRIBUTES : SVG_SHAPE_ATTRIBUTES[token.name];
    if (allowed === undefined) return null;
    const attrs: string[] = [];
    for (const [name, raw] of Object.entries(token.attrs)) {
      if (!allowed.has(name)) return null;
      const normalized = normalizedSvgAttribute(token.name, name, raw);
      if (normalized === null) return null;
      const outputName = name === "viewbox" ? "viewBox" : name === "preserveaspectratio" ? "preserveAspectRatio" : name;
      attrs.push(`${outputName}="${escapeAttribute(normalized)}"`);
    }
    if (token.name === "svg") {
      if (!("viewbox" in token.attrs)) attrs.push('viewBox="0 0 100 100"');
      if (!("xmlns" in token.attrs)) attrs.push('xmlns="http://www.w3.org/2000/svg"');
    } else {
      primitives += 1;
      if (primitives > MEDIA_SURFACE_LIMITS.svgPrimitives) return null;
    }
    const suffix = token.selfClosing ? "/>" : ">";
    out.push(`<${token.name}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}${suffix}`);
    if (!token.selfClosing) stack.push(token.name);
  }
  if (!sawRoot || stack.length !== 0 || primitives === 0) return null;
  return out.join("");
}

export function svgFromPath(d: unknown, viewBox: unknown = "0 0 100 100", fill: unknown = "#000000"): string | null {
  if (typeof d !== "string" || typeof viewBox !== "string" || typeof fill !== "string") return null;
  if (d.length > MEDIA_SURFACE_LIMITS.svgCharacters
      || viewBox.length > MEDIA_SURFACE_LIMITS.svgViewBoxCharacters
      || fill.length > MEDIA_SURFACE_LIMITS.svgPaintCharacters) return null;
  return sanitizeSvgMarkup(`<svg viewBox="${viewBox}"><path d="${d}" fill="${fill}"/></svg>`);
}

export function sanitizeSvgSource(value: string): string | null {
  if (typeof value !== "string" || value.length > MEDIA_SURFACE_LIMITS.svgCharacters) return null;
  const source = value.trim();
  if (source.startsWith("<svg")) return sanitizeSvgMarkup(source);
  if (/^<(?:path|rect|circle|ellipse|line|polygon|polyline)\b/i.test(source)) {
    return sanitizeSvgMarkup(`<svg viewBox="0 0 100 100">${source}</svg>`);
  }
  return null;
}

export const svg: ElementFactory = (node, _ctx, api) => {
  const root = document.createElement("span");
  root.className = "dsx-svg";
  if (node.attrs["a11yLabel"] === undefined && node.attrs["aria-label"] === undefined) {
    root.setAttribute("aria-hidden", "true");
  } else {
    root.setAttribute("role", "img");
  }
  let asset = "";
  let src = "";
  let d = "";
  let viewBox = "0 0 100 100";
  let fill = "#000000";
  let width: number | null = null;
  let height: number | null = null;

  const render = (): void => {
    const candidate = sanitizeSvgSource(asset) ?? sanitizeSvgSource(src)
      ?? (d.length > 0 ? svgFromPath(d, viewBox, fill) : null);
    root.replaceChildren();
    root.setAttribute("data-dsx-valid", String(candidate !== null));
    if (candidate !== null) {
      const template = document.createElement("template");
      template.innerHTML = candidate;
      const graphic = template.content.firstElementChild;
      if (graphic !== null) root.appendChild(graphic);
    }
    if (width === null) root.style.removeProperty("width");
    else root.style.width = `${width}px`;
    if (height === null) root.style.removeProperty("height");
    else root.style.height = `${height}px`;
  };
  api.bindText(node.attrs["asset"] ?? "", (value) => { asset = value.substring(0, MEDIA_SURFACE_LIMITS.svgCharacters + 1); render(); });
  api.bindText(node.attrs["src"] ?? "", (value) => { src = value.substring(0, MEDIA_SURFACE_LIMITS.svgCharacters + 1); render(); });
  api.bindText(node.attrs["d"] ?? "", (value) => { d = value.substring(0, MEDIA_SURFACE_LIMITS.svgCharacters + 1); render(); });
  api.bindText(node.attrs["viewBox"] ?? "0 0 100 100", (value) => {
    viewBox = value.substring(0, MEDIA_SURFACE_LIMITS.svgViewBoxCharacters + 1);
    render();
  });
  api.bindText(node.attrs["fill"] ?? "#000000", (value) => {
    fill = value.substring(0, MEDIA_SURFACE_LIMITS.svgPaintCharacters + 1);
    render();
  });
  if (node.attrs["width"] !== undefined) {
    api.bindText(node.attrs["width"], (value) => {
      width = Math.min(Math.max(finite(value, 0), 0), MEDIA_SURFACE_LIMITS.svgDimension);
      render();
    });
  }
  if (node.attrs["height"] !== undefined) {
    api.bindText(node.attrs["height"], (value) => {
      height = Math.min(Math.max(finite(value, 0), 0), MEDIA_SURFACE_LIMITS.svgDimension);
      render();
    });
  }
  return root;
};

// MARK: - Lightbox

export type LightboxImage = Readonly<{ src: string }>;

function safeSourceField(value: unknown): string {
  const field = typeof value === "string" && value.length <= MEDIA_SURFACE_LIMITS.lightboxSourceFieldCharacters
    ? value.trim() : "";
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(field)
    && field !== "__proto__" && field !== "constructor" && field !== "prototype" ? field : "src";
}

export function normalizeLightboxImages(value: unknown, sourceField: unknown = "src"): LightboxImage[] {
  try { if (!Array.isArray(value)) return []; } catch { return []; }
  const field = safeSourceField(sourceField);
  const out: LightboxImage[] = [];
  let length = 0;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    length = descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "number"
      ? Math.min(Math.max(Math.trunc(descriptor.value), 0), MEDIA_SURFACE_LIMITS.lightboxImages) : 0;
  } catch { return out; }
  for (let index = 0; index < length; index += 1) {
    let raw: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) continue;
      raw = descriptor.value;
    } catch { continue; }
    let candidate = "";
    if (typeof raw === "string") candidate = raw;
    else if (typeof raw === "object" && raw !== null) {
      try { if (Array.isArray(raw)) continue; } catch { continue; }
      try {
        const descriptor = Object.getOwnPropertyDescriptor(raw as object, field);
        const fieldValue = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
        if (typeof fieldValue === "string") candidate = fieldValue;
      } catch { /* hostile descriptor proxies fail closed */ }
    }
    const src = safeMediaUrl(candidate);
    if (src !== null) out.push(Object.freeze({ src }));
  }
  return out;
}

export function parseLightboxUrls(value: unknown): LightboxImage[] {
  if (typeof value !== "string" || value.length > MEDIA_SURFACE_LIMITS.lightboxCsvCharacters) return [];
  const out: LightboxImage[] = [];
  let start = 0;
  let inspected = 0;
  while (start <= value.length && inspected < MEDIA_SURFACE_LIMITS.lightboxImages) {
    inspected += 1;
    const separator = value.indexOf(",", start);
    const end = separator < 0 ? value.length : separator;
    const src = safeMediaUrl(value.slice(start, end));
    if (src !== null) out.push(Object.freeze({ src }));
    if (separator < 0) break;
    start = separator + 1;
  }
  return out;
}

export function normalizeLightboxColor(value: unknown): string {
  const tokens: Readonly<Record<string, string>> = {
    white: "#ffffff",
    black: "#000000",
    clear: "transparent",
    accent: "var(--dsx-accent)",
    label: "var(--dsx-label)",
    secondary: "var(--dsx-secondary-label)",
    secondaryLabel: "var(--dsx-secondary-label)",
    tertiary: "var(--dsx-tertiary-label)",
    tertiaryLabel: "var(--dsx-tertiary-label)",
    background: "var(--dsx-background)",
    systemBackground: "var(--dsx-background)",
    secondaryBackground: "var(--dsx-secondary-background)",
    tertiaryBackground: "var(--dsx-tertiary-background)",
    groupedBackground: "var(--dsx-grouped-background)",
    secondaryGroupedBackground: "var(--dsx-secondary-grouped-background)",
    fill: "var(--dsx-fill)",
    fillFaint: "color-mix(in srgb, var(--dsx-fill) 50%, transparent)",
    separator: "var(--dsx-separator)",
    destructive: "var(--dsx-destructive)",
  };
  if (typeof value !== "string" || value.length > MEDIA_SURFACE_LIMITS.lightboxColorCharacters) return "#ffffff";
  const raw = value.trim();
  if (tokens[raw] !== undefined) return tokens[raw]!;
  const argb = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{6})$/.exec(raw);
  if (argb !== null) return `#${argb[2]!.toLowerCase()}${argb[1]!.toLowerCase()}`;
  if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^rgba?\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+(?:\s*,\s*[0-9.]+)?\s*\)$/i.test(raw)) return raw;
  return "#ffffff";
}

export const lightbox: ElementFactory = (node, ctx, api) => {
  const host = document.createElement("span");
  const layer = document.createElement("div");
  const scrim = document.createElement("button");
  const panel = document.createElement("section");
  const stage = document.createElement("div");
  const image = document.createElement("img");
  const empty = document.createElement("p");
  const chrome = document.createElement("div");
  const counter = document.createElement("span");
  const previous = document.createElement("button");
  const next = document.createElement("button");
  const close = document.createElement("button");

  host.className = "dsx-lightbox-host";
  layer.className = "dsx-lightbox-layer";
  scrim.className = "dsx-lightbox-scrim";
  panel.className = "dsx-lightbox-panel";
  stage.className = "dsx-lightbox-stage";
  image.className = "dsx-lightbox-image";
  empty.className = "dsx-lightbox-empty";
  chrome.className = "dsx-lightbox-chrome";
  counter.className = "dsx-lightbox-counter";
  previous.className = "dsx-lightbox-previous";
  next.className = "dsx-lightbox-next";
  close.className = "dsx-lightbox-close";
  scrim.type = previous.type = next.type = close.type = "button";
  scrim.tabIndex = -1;
  scrim.setAttribute("aria-label", "Close photo viewer");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.tabIndex = -1;
  counter.setAttribute("aria-live", "polite");
  counter.setAttribute("aria-atomic", "true");
  previous.setAttribute("aria-label", "Previous photo");
  next.setAttribute("aria-label", "Next photo");
  close.setAttribute("aria-label", "Close photo viewer");
  previous.textContent = "‹";
  next.textContent = "›";
  close.textContent = "×";
  image.draggable = false;
  empty.textContent = "No photos available";
  stage.append(image, empty);
  chrome.append(previous, counter, next, close);
  panel.append(stage, chrome);
  layer.append(scrim, panel);
  host.appendChild(layer);
  layer.hidden = true;
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");

  let images: LightboxImage[] = [];
  let index = 0;
  let presented = false;
  let pointer: { id: number; x: number; y: number; at: number } | null = null;

  const resetDragVisuals = (): void => {
    panel.removeAttribute("data-dsx-dragging");
    layer.removeAttribute("data-dsx-dragging");
    panel.style.removeProperty("--dsx-lightbox-drag-y");
    scrim.style.removeProperty("--dsx-lightbox-scrim-opacity");
  };

  const clearPointer = (): void => {
    const pointerId = pointer?.id;
    pointer = null;
    resetDragVisuals();
    if (pointerId === undefined) return;
    try {
      if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
    } catch { /* detached/synthetic pointer */ }
  };

  const reflect = (): void => {
    index = images.length === 0 ? 0 : Math.min(Math.max(Math.trunc(index), 0), images.length - 1);
    const current = images[index];
    image.hidden = current === undefined;
    empty.hidden = current !== undefined;
    if (current === undefined || !presented) image.removeAttribute("src");
    else if (image.getAttribute("src") !== current.src) image.src = current.src;
    image.alt = current === undefined ? "" : `Photo ${index + 1} of ${images.length}`;
    counter.textContent = images.length === 0 ? "0 / 0" : `${index + 1} / ${images.length}`;
    counter.setAttribute("aria-label", images.length === 0 ? "No photos" : `Photo ${index + 1} of ${images.length}`);
    const focusedNavigation = document.activeElement === previous ? previous
      : document.activeElement === next ? next : null;
    const previousDisabled = images.length < 2 || index <= 0;
    const nextDisabled = images.length < 2 || index >= images.length - 1;
    if (presented && (focusedNavigation === previous ? previousDisabled
      : focusedNavigation === next ? nextDisabled : false)) {
      const replacement = focusedNavigation === previous ? next : previous;
      const replacementDisabled = replacement === previous ? previousDisabled : nextDisabled;
      const target = replacementDisabled ? close : replacement;
      // A reactive image/index jump can make the replacement newly enabled while
      // it is still disabled in the old DOM state. Enable that target first so
      // focus() cannot silently fail, then disable the old focused control.
      if (target === previous) previous.disabled = false;
      if (target === next) next.disabled = false;
      target.focus({ preventScroll: true });
    }
    previous.disabled = previousDisabled;
    next.disabled = nextDisabled;
  };

  const changeIndex = (nextIndex: number, write: boolean): void => {
    const clamped = images.length === 0 ? 0 : Math.min(Math.max(Math.trunc(nextIndex), 0), images.length - 1);
    if (clamped === index) return;
    index = clamped;
    reflect();
    if (write) setBound(api, node.attrs["index"], index);
  };

  const onNavigationKey = (event: KeyboardEvent): void => {
    if (!presented) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      const rtl = getComputedStyle(panel).direction === "rtl";
      const forward = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
      changeIndex(index + (forward ? 1 : -1), true);
      return;
    }
    if (event.key === "Home") { event.preventDefault(); changeIndex(0, true); return; }
    if (event.key === "End") { event.preventDefault(); changeIndex(images.length - 1, true); return; }
  };
  panel.addEventListener("keydown", onNavigationKey);

  const controller = bindPresentation(node, ctx, api, layer, panel, {
    modal: true,
    initialFocus: () => close,
    onOpen: () => { presented = true; reflect(); },
    onClose: () => {
      presented = false;
      image.removeAttribute("src");
      clearPointer();
    },
  });

  scrim.addEventListener("click", () => controller.dismiss("outside"));
  stage.addEventListener("click", (event) => { if (event.target === stage) controller.dismiss("outside"); });
  close.addEventListener("click", () => controller.dismiss("close"));
  previous.addEventListener("click", () => changeIndex(index - 1, true));
  next.addEventListener("click", () => changeIndex(index + 1, true));
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointer !== null) return;
    pointer = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      at: event.timeStamp,
    };
    panel.setAttribute("data-dsx-dragging", "true");
    layer.setAttribute("data-dsx-dragging", "true");
    try { stage.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
  });
  stage.addEventListener("pointermove", (event) => {
    if (pointer?.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (Math.abs(dy) <= Math.abs(dx)) return;
    if (event.cancelable) event.preventDefault();
    panel.style.setProperty("--dsx-lightbox-drag-y", `${dy}px`);
    const opacity = Math.max(0.4, 1 - Math.min(Math.abs(dy) / 600, 0.6));
    scrim.style.setProperty("--dsx-lightbox-scrim-opacity", String(opacity));
  });
  stage.addEventListener("pointerup", (event) => {
    if (pointer?.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    const elapsed = Math.max(event.timeStamp - pointer.at, 1);
    const velocityY = dy / elapsed;
    const predictedY = dy + velocityY * 180;
    clearPointer();
    // Lock to the full gesture's axis before considering velocity. A tiny vertical
    // jitter at the end of a fast horizontal swipe must never become a dismissal.
    // The 300px predicted threshold mirrors the native lightbox contract; the
    // direct 120px threshold keeps a deliberate slow drag useful.
    const verticallyLocked = Math.abs(dy) > Math.abs(dx) * 1.15;
    if (verticallyLocked && (Math.abs(dy) >= 120 || Math.abs(predictedY) >= 300)) {
      controller.dismiss("drag");
      return;
    }
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy)) return;
    const rtl = getComputedStyle(panel).direction === "rtl";
    const forward = rtl ? dx > 0 : dx < 0;
    changeIndex(index + (forward ? 1 : -1), true);
  });
  stage.addEventListener("pointercancel", clearPointer);
  stage.addEventListener("lostpointercapture", (event) => {
    if (pointer?.id === event.pointerId) clearPointer();
  });

  if (node.attrs["images"] !== undefined) {
    api.bindValue(node.attrs["images"], (value) => {
      images = normalizeLightboxImages(value, node.attrs["srcField"] ?? "src");
      reflect();
    });
  } else {
    api.bindText(node.attrs["urls"] ?? "", (value) => { images = parseLightboxUrls(value); reflect(); });
  }
  if (node.attrs["index"] !== undefined) {
    api.bindValue(node.attrs["index"], (value) => { index = Math.trunc(finite(value, 0)); reflect(); });
  }
  api.bindText(node.attrs["color"] ?? "white", (value) => {
    layer.style.setProperty("--dsx-lightbox-color", normalizeLightboxColor(value));
  });
  api.bindText(node.attrs["a11yLabel"] ?? node.attrs["aria-label"] ?? "Photo viewer", (value) => {
    panel.setAttribute("aria-label", boundedMediaText(value) || "Photo viewer");
  });
  reflect();

  ctx.disposers.push(() => {
    presented = false;
    image.removeAttribute("src");
    clearPointer();
  });
  return host;
};

export const MEDIA_SURFACE_ELEMENTS: Readonly<Record<string, ElementFactory>> = /* @__PURE__ */ Object.freeze({
  audio, video, svg, lightbox,
});

export function registerAudioSurface(): void { ELEMENTS["audio"] = audio; }
export function registerVideoSurface(): void { ELEMENTS["video"] = video; }
export function registerSvgSurface(): void { ELEMENTS["svg"] = svg; }
export function registerLightboxSurface(): void { ELEMENTS["lightbox"] = lightbox; }

export function registerMediaSurfaces(): void {
  registerAudioSurface();
  registerVideoSurface();
  registerSvgSurface();
  registerLightboxSurface();
}

export const MEDIA_PLAYBACK_CSS = `@layer dsx-elements {
  .dsx-audio {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .dsx-video {
    display: block;
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 100%;
    block-size: auto;
    min-block-size: 1px;
    color: var(--dsx-label);
    background: var(--dsx-fill);
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-video { scroll-behavior: auto; transition: none; animation: none; }
  }
  @media (forced-colors: active) {
    .dsx-video { border: 1px solid CanvasText; forced-color-adjust: auto; }
  }
}`;

export const MEDIA_SVG_CSS = `@layer dsx-elements {
  .dsx-svg {
    display: inline-grid;
    place-items: center;
    box-sizing: border-box;
    min-inline-size: 0;
    max-inline-size: 100%;
    color: currentColor;
    overflow: hidden;
  }
  .dsx-svg > svg { display: block; inline-size: 100%; block-size: 100%; max-inline-size: 100%; }
  @media (forced-colors: active) {
    .dsx-svg { border: 1px solid CanvasText; forced-color-adjust: auto; }
  }
}`;

export const MEDIA_LIGHTBOX_CSS = `@layer dsx-elements {
  .dsx-lightbox-host { display: contents; }
  .dsx-lightbox-layer {
    position: fixed;
    inset: 0;
    z-index: calc(var(--dsx-overlay-z-index, 10000) + var(--dsx-overlay-level, 0));
    display: grid;
    color: var(--dsx-lightbox-color, #fff);
    font-family: var(--dsx-font);
    isolation: isolate;
  }
  .dsx-lightbox-layer[hidden] { display: none; }
  .dsx-lightbox-layer * { box-sizing: border-box; }
  .dsx-lightbox-scrim {
    position: absolute;
    inset: 0;
    padding: 0;
    border: 0;
    background: rgb(0 0 0 / .94);
    opacity: var(--dsx-lightbox-scrim-opacity, 1);
    transition: opacity 180ms ease-out;
    cursor: default;
  }
  .dsx-lightbox-panel {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    inline-size: 100%;
    block-size: 100%;
    min-inline-size: 0;
    min-block-size: 0;
    outline: none;
    transform: translate3d(0, var(--dsx-lightbox-drag-y, 0), 0);
    transition: transform 180ms ease-out;
  }
  .dsx-lightbox-panel[data-dsx-dragging="true"],
  .dsx-lightbox-layer[data-dsx-dragging="true"] .dsx-lightbox-scrim { transition: none; }
  .dsx-lightbox-stage {
    display: grid;
    place-items: center;
    min-inline-size: 0;
    min-block-size: 0;
    padding: max(56px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 12px max(16px, env(safe-area-inset-left));
    overflow: hidden;
    touch-action: pinch-zoom;
    user-select: none;
  }
  .dsx-lightbox-image {
    display: block;
    max-inline-size: 100%;
    max-block-size: 100%;
    object-fit: contain;
    -webkit-user-drag: none;
  }
  .dsx-lightbox-empty { margin: 0; color: color-mix(in srgb, currentColor 72%, transparent); text-align: center; }
  .dsx-lightbox-chrome {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) 44px 44px;
    align-items: center;
    gap: 4px;
    min-block-size: calc(60px + env(safe-area-inset-bottom));
    padding: 8px max(10px, env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
    border-block-start: 1px solid rgb(255 255 255 / .18);
    background: rgb(12 12 14 / .76);
    -webkit-backdrop-filter: blur(20px) saturate(1.1);
    backdrop-filter: blur(20px) saturate(1.1);
  }
  .dsx-lightbox-previous, .dsx-lightbox-next, .dsx-lightbox-close {
    appearance: none;
    display: grid;
    place-items: center;
    inline-size: 44px;
    block-size: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: inherit;
    background: rgb(255 255 255 / .12);
    font: inherit;
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
  }
  .dsx-lightbox-previous:disabled, .dsx-lightbox-next:disabled { opacity: .28; cursor: default; }
  .dsx-lightbox-counter { min-inline-size: 0; text-align: center; font-size: .875rem; font-variant-numeric: tabular-nums; }
  .dsx-lightbox-previous:focus-visible, .dsx-lightbox-next:focus-visible, .dsx-lightbox-close:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
  [dir="rtl"] .dsx-lightbox-previous, [dir="rtl"] .dsx-lightbox-next { transform: scaleX(-1); }
  @media (min-width: 48rem) and (hover: hover) and (pointer: fine) {
    .dsx-lightbox-stage { padding-inline: 72px; }
    .dsx-lightbox-chrome {
      position: absolute;
      inset: 16px 16px auto auto;
      grid-template-columns: 38px auto 38px 38px;
      min-block-size: 0;
      padding: 6px;
      border: 1px solid rgb(255 255 255 / .18);
      border-radius: 999px;
    }
    .dsx-lightbox-previous, .dsx-lightbox-next, .dsx-lightbox-close { inline-size: 38px; block-size: 38px; }
    .dsx-lightbox-counter { min-inline-size: 64px; padding-inline: 8px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-lightbox-layer * { scroll-behavior: auto; transition: none; animation: none; }
  }
  @media (forced-colors: active) {
    .dsx-lightbox-scrim { background: Canvas; }
    .dsx-lightbox-chrome { border-color: CanvasText; background: Canvas; }
    .dsx-lightbox-previous, .dsx-lightbox-next, .dsx-lightbox-close { border: 1px solid ButtonText; background: ButtonFace; color: ButtonText; forced-color-adjust: auto; }
  }
}`;
