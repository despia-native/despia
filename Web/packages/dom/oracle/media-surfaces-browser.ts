// Real-engine acceptance for DSX media surfaces. The same source-bundled harness
// runs under every locked Playwright engine; no network service or codec CDN is
// involved, so failures identify renderer behavior rather than infrastructure.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const wav = readFileSync(resolve(
  import.meta.dirname,
  "../../../../../ClosedSource/DSX/Modules/Core/Extensions/Watch/WatchApp/Sounds/chime.wav",
)).toString("base64");

const markup = String.raw`<vstack class="media-harness">
  <head>
    <variable as="audioSrc">return ""</variable>
    <variable as="videoSrc">return ""</variable>
    <variable as="paused">return true</variable>
    <variable as="position">return 0</variable>
    <variable as="time">return 0</variable>
    <variable as="duration">return 0</variable>
    <variable as="buffering">return false</variable>
    <variable as="ready">return 0</variable>
    <variable as="ended">return 0</variable>
    <variable as="failures">return 0</variable>
    <variable as="videoPosition">return 0</variable>
    <variable as="videoScrubbing">return false</variable>
    <variable as="videoPreview">return ""</variable>
    <variable as="videoActive">return false</variable>
    <variable as="handoffSrc">return ""</variable>
    <variable as="handoffActive">return false</variable>
    <variable as="sharedPosition">return 0.25</variable>
    <variable as="sharedTime">return 7</variable>
    <variable as="sharedDuration">return 9</variable>
    <variable as="sharedBuffering">return false</variable>
    <variable as="sharedPreview">return "active-preview"</variable>
    <variable as="handoffScrubbing">return false</variable>
    <variable as="showPhotos">return false</variable>
    <variable as="showSheet">return false</variable>
    <variable as="photoIndex">return 0</variable>
    <variable as="photos">return []</variable>
    <variable as="dismisses">return 0</variable>
  </head>
  <audio src="{{ audioSrc }}" autoplay="false" paused="paused" bind="position"
    time="time" duration="duration" buffering="buffering" on:ready="dsx.variable.ready += 1"
    on:ended="dsx.variable.ended += 1" on:error="dsx.variable.failures += 1"/>
  <video class="test-video" src="{{ videoSrc }}" active="{{ videoActive }}" autoplay="false" gravity="fit" a11yLabel="Preview video"
    bind="videoPosition" scrubbing="videoScrubbing" preview="videoPreview"/>
  <video class="unsafe-video" src="javascript:alert(1)" active="false" autoplay="false"/>
  <video class="handoff-video" src="{{ handoffSrc }}" active="{{ handoffActive }}" autoplay="false"
    paused="paused" bind="sharedPosition" time="sharedTime" duration="sharedDuration"
    buffering="sharedBuffering" preview="sharedPreview" scrubbing="handoffScrubbing"/>
  <svg class="test-svg" d="M0 0 L100 0 L50 100 Z" viewBox="0 0 100 100" fill="#3366ff" width="120" height="80" a11yLabel="Triangle"/>
  <svg class="invalid-svg" d="M0 0 A5 5 0 0 1 10 10"/>
  <sheet present="showSheet"><button label="Nested surface"/></sheet>
  <lightbox present="showPhotos" images="photos" srcField="url" index="photoIndex"
    on:dismiss="dsx.variable.dismisses += 1"/>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "@despia/compiler/component";
  import { LAYER_STATEMENT } from "@despia/compiler/cssmap";
  import { instantiate } from "@despia/dom/mount";
  import { TOKENS_CSS, ELEMENTS_CSS } from "@despia/dom/theme";
  import { MEDIA_PLAYBACK_CSS, MEDIA_SVG_CSS, MEDIA_LIGHTBOX_CSS, registerMediaSurfaces } from "@despia/dom/media-surfaces";
  import { OVERLAY_CONTROLS_CSS, registerOverlayControls } from "@despia/dom/overlay-controls";

  registerOverlayControls();
  registerMediaSurfaces();
  const ir = compileComponent("MediaBrowser", "test", ${JSON.stringify(markup)});
  const registry = { components: { "test.MediaBrowser": ir }, globalPool: {}, css: "", schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, OVERLAY_CONTROLS_CSS, MEDIA_PLAYBACK_CSS, MEDIA_SVG_CSS, MEDIA_LIGHTBOX_CSS,
    "@layer dsx-components { .media-harness { box-sizing:border-box;inline-size:min(100%,48rem);gap:18px;padding:16px;margin:auto; } .test-video { block-size:180px;border-radius:3px; } .test-svg { color:rgb(28,84,180); } }",
  ].join("\n");
  document.head.appendChild(style);
  const launcher = document.createElement("button");
  launcher.id = "launcher";
  launcher.textContent = "Open photos";
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(launcher, instance.root);

  const bytes = Uint8Array.from(atob(${JSON.stringify(wav)}), (character) => character.charCodeAt(0));
  const audioUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const raceUrls = Array.from({ length: 3 }, () => URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
  // A valid audio-only media resource exercises HTMLVideoElement lifecycle without
  // the empty MP4 range/codec errors that would weaken the global console gate.
  const videoUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const makePhoto = (color, label) => URL.createObjectURL(new Blob([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="' + color + '"/><text x="160" y="108" text-anchor="middle" fill="white" font-size="28">' + label + '</text></svg>',
  ], { type: "image/svg+xml" }));
  const photoUrls = [makePhoto("#2457d6", "One"), makePhoto("#7845b8", "Two"), makePhoto("#b44a38", "Three")];
  instance.ctx.store.set("audioSrc", audioUrl);
  instance.ctx.store.set("videoSrc", videoUrl);
  instance.ctx.store.set("handoffSrc", videoUrl);
  instance.ctx.store.set("photos", photoUrls.map((url) => ({ url })));
  window.__dsxMediaRead = (expression) => instance.ctx.store.eval(expression, null);
  window.__dsxMediaSet = (name, value) => instance.ctx.store.set(name, value);
  window.__dsxMediaRaceUrls = raceUrls;
  const flushStore = async () => { await Promise.resolve(); await Promise.resolve(); };
  window.__dsxMediaPreviewFailure = async () => {
    const canvas = HTMLCanvasElement.prototype;
    const originalGetContext = canvas.getContext;
    const originalToBlob = canvas.toBlob;
    const originalCreateElement = document.createElement.bind(document);
    let calls = 0;
    const frames = [];
    try {
      instance.ctx.store.set("videoActive", true);
      await flushStore();
      document.createElement = ((name, options) => {
        const element = originalCreateElement(name, options);
        if (name.toLowerCase() !== "video") return element;
        let currentTime = 0;
        Object.defineProperties(element, {
          readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
          duration: { configurable: true, value: 10 },
          currentTime: {
            configurable: true,
            get() { return currentTime; },
            set(value) { currentTime = Number(value); element.dispatchEvent(new Event("seeked")); },
          },
          videoWidth: { configurable: true, value: 320 },
          videoHeight: { configurable: true, value: 180 },
          paused: { configurable: true, value: true },
        });
        element.load = () => {
          element.dispatchEvent(new Event("loadedmetadata"));
          element.dispatchEvent(new Event("loadeddata"));
        };
        element.pause = () => {};
        return element;
      }) as typeof document.createElement;
      canvas.getContext = (() => ({ drawImage(frame) { frames.push(frame.currentTime); } })) as typeof canvas.getContext;
      canvas.toBlob = (() => { calls += 1; throw new DOMException("tainted", "SecurityError"); }) as typeof canvas.toBlob;
      instance.ctx.store.set("videoPosition", 0.5);
      await flushStore();
      instance.ctx.store.set("videoScrubbing", true);
      await flushStore();
    } finally {
      instance.ctx.store.set("videoScrubbing", false);
      await flushStore();
      instance.ctx.store.set("videoActive", false);
      await flushStore();
      document.createElement = originalCreateElement as typeof document.createElement;
      canvas.getContext = originalGetContext;
      canvas.toBlob = originalToBlob;
    }
    return { calls, frames, preview: instance.ctx.store.eval("dsx.variable.videoPreview", null) };
  };
  window.__dsxMediaDispose = () => instance.unmount();
  window.__dsxMediaCleanup = () => { URL.revokeObjectURL(audioUrl); URL.revokeObjectURL(videoUrl); for (const url of [...raceUrls, ...photoUrls]) URL.revokeObjectURL(url); };
  window.__DSX_MEDIA_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "media-surfaces-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("media surfaces browser harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  let timeoutRouteReleased = false;
  let releaseTimeoutRoute = (): void => {};
  await page.route("https://media-timeout.invalid/**", async (route) => {
    if (!timeoutRouteReleased) {
      await new Promise<void>((resolve) => { releaseTimeoutRoute = resolve; });
    }
    await route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.from(wav, "base64") });
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
  await page.setContent("<!doctype html><html lang='en-US'><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_MEDIA_READY__?: boolean }).__DSX_MEDIA_READY__ === true);

  const read = async (expression: string): Promise<unknown> => await page.evaluate((value) =>
    (window as unknown as { __dsxMediaRead: (expr: string) => unknown }).__dsxMediaRead(value), expression);
  const set = async (name: string, value: unknown): Promise<void> => { await page.evaluate(async ([key, next]) => {
    (window as unknown as { __dsxMediaSet: (name: string, value: unknown) => void }).__dsxMediaSet(key as string, next);
    await Promise.resolve();
    await Promise.resolve();
  }, [name, value]); };

  const audio = page.locator("audio.dsx-audio");
  await page.waitForFunction(() => {
    const host = window as unknown as { __dsxMediaRead: (expr: string) => unknown };
    return Number(host.__dsxMediaRead("dsx.variable.duration")) > 0
      && Number(host.__dsxMediaRead("dsx.variable.ready")) > 0;
  });
  await page.waitForTimeout(50);
  if (!((await audio.getAttribute("src")) ?? "").startsWith("blob:")) errors.push("audio did not accept a caller-owned blob source");
  if (await audio.getAttribute("aria-hidden") !== "true") errors.push("headless audio leaked an unlabeled focus/AT control");
  const initialAudio = {
    duration: Number(await read("dsx.variable.duration")),
    ready: Number(await read("dsx.variable.ready")),
  };
  if (initialAudio.duration <= 0 || initialAudio.ready !== 1) {
    errors.push(`audio metadata did not publish duration/ready exactly once: ${JSON.stringify(initialAudio)}`);
  }
  await set("position", 0.5);
  await page.waitForTimeout(80);
  const seek = await audio.evaluate((element: HTMLAudioElement) => ({ current: element.currentTime, duration: element.duration }));
  if (Math.abs(seek.current - seek.duration * 0.5) > 0.25) errors.push(`audio fraction seek diverged: ${JSON.stringify(seek)}`);

  // A source swap resets stale readouts synchronously and a black-holed fetch is
  // converted into one bounded DSX error instead of buffering forever. The real
  // 15s production timer is accelerated only inside this oracle task.
  const failureBeforeTimeout = Number(await read("dsx.variable.failures"));
  const sourceReset = await page.evaluate(async () => {
    const host = window as unknown as {
      __dsxMediaRead: (expr: string) => unknown;
      __dsxMediaSet: (name: string, value: unknown) => void;
      __dsxRestoreMediaTimer?: () => void;
    };
    host.__dsxMediaSet("time", 9);
    host.__dsxMediaSet("duration", 10);
    host.__dsxMediaSet("position", 0.75);
    await Promise.resolve();
    await Promise.resolve();
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      nativeSetTimeout(handler, timeout === 15_000 ? 0 : timeout, ...args)) as typeof window.setTimeout;
    host.__dsxRestoreMediaTimer = () => { window.setTimeout = nativeSetTimeout as typeof window.setTimeout; };
    host.__dsxMediaSet("audioSrc", "https://media-timeout.invalid/hang.wav");
    await Promise.resolve();
    await Promise.resolve();
    const reset = {
      time: host.__dsxMediaRead("dsx.variable.time"),
      duration: host.__dsxMediaRead("dsx.variable.duration"),
      position: host.__dsxMediaRead("dsx.variable.position"),
      buffering: host.__dsxMediaRead("dsx.variable.buffering"),
    };
    const audio = document.querySelector<HTMLAudioElement>("audio.dsx-audio")!;
    Object.defineProperties(audio, {
      currentSrc: { configurable: true, writable: true, value: audio.src },
      readyState: { configurable: true, writable: true, value: HTMLMediaElement.HAVE_METADATA },
      duration: { configurable: true, writable: true, value: 12 },
    });
    audio.dispatchEvent(new Event("loadedmetadata"));
    await Promise.resolve();
    await Promise.resolve();
    return { ...reset, metadataDuration: host.__dsxMediaRead("dsx.variable.duration") };
  });
  if (sourceReset.time !== 0 || sourceReset.duration !== 0 || sourceReset.position !== 0.75
      || sourceReset.buffering !== true || sourceReset.metadataDuration !== 12) {
    errors.push(`media source swap retained stale readouts: ${JSON.stringify(sourceReset)}`);
  }
  await page.waitForFunction((before) => Number(
    (window as unknown as { __dsxMediaRead: (expr: string) => unknown }).__dsxMediaRead("dsx.variable.failures"),
  ) > before, failureBeforeTimeout);
  const timeoutState = {
    failures: Number(await read("dsx.variable.failures")),
    buffering: await read("dsx.variable.buffering"),
  };
  await page.evaluate(() => (window as unknown as { __dsxRestoreMediaTimer?: () => void }).__dsxRestoreMediaTimer?.());
  timeoutRouteReleased = true;
  releaseTimeoutRoute();
  await page.waitForTimeout(20);
  if (timeoutState.failures !== failureBeforeTimeout + 1 || timeoutState.buffering !== false) {
    errors.push(`media load timeout did not fail once and clear buffering: ${JSON.stringify(timeoutState)}`);
  }

  const rapidSwap = await page.evaluate(async () => {
    const host = window as unknown as {
      __dsxMediaRead: (expr: string) => unknown;
      __dsxMediaSet: (name: string, value: unknown) => void;
      __dsxMediaRaceUrls: string[];
    };
    const audio = document.querySelector<HTMLAudioElement>("audio.dsx-audio")!;
    const [a, b, c] = host.__dsxMediaRaceUrls;
    const readyBefore = Number(host.__dsxMediaRead("dsx.variable.ready"));
    host.__dsxMediaSet("audioSrc", a);
    await Promise.resolve();
    await Promise.resolve();
    host.__dsxMediaSet("audioSrc", b);
    await Promise.resolve();
    await Promise.resolve();
    host.__dsxMediaSet("audioSrc", c);
    await Promise.resolve();
    await Promise.resolve();
    Object.assign(audio as unknown as { currentSrc: string; readyState: number; duration: number }, {
      currentSrc: b!, readyState: HTMLMediaElement.HAVE_FUTURE_DATA, duration: 12,
    });
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("canplay"));
    const stale = {
      ready: Number(host.__dsxMediaRead("dsx.variable.ready")),
      duration: Number(host.__dsxMediaRead("dsx.variable.duration")),
    };
    (audio as unknown as { currentSrc: string }).currentSrc = c!;
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("canplay"));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
    return {
      readyBefore, stale,
      currentReady: Number(host.__dsxMediaRead("dsx.variable.ready")),
      currentDuration: Number(host.__dsxMediaRead("dsx.variable.duration")),
    };
  });
  if (rapidSwap.stale.ready !== rapidSwap.readyBefore || rapidSwap.stale.duration !== 0
      || rapidSwap.currentReady !== rapidSwap.readyBefore + 1 || rapidSwap.currentDuration !== 12) {
    errors.push(`rapid source swap attributed stale events to the newest epoch: ${JSON.stringify(rapidSwap)}`);
  }

  const video = page.locator("video.test-video");
  if (await video.getAttribute("aria-label") !== "Preview video") errors.push("video accessible label was not preserved");
  if (await video.evaluate((element) => getComputedStyle(element).objectFit) !== "contain") errors.push("video gravity=fit did not map to object-fit contain");
  if (await video.evaluate((element) => getComputedStyle(element).borderRadius) !== "3px") errors.push("ordinary author CSS did not override the weak media sheet");
  if (await page.locator("video.unsafe-video").getAttribute("src") !== null) errors.push("executable video URL reached the native media element");
  const previewFailure = await page.evaluate(() =>
    (window as unknown as { __dsxMediaPreviewFailure: () => Promise<{ calls: number; frames: number[]; preview: unknown }> }).__dsxMediaPreviewFailure());
  if (previewFailure.calls < 1 || Math.abs((previewFailure.frames.at(-1) ?? -1) - 5) > 0.01 || previewFailure.preview !== "") {
    errors.push(`tainted-canvas preview did not fail closed: ${JSON.stringify(previewFailure)}`);
  }

  const inactivePreload = {
    position: await read("dsx.variable.sharedPosition"),
    time: await read("dsx.variable.sharedTime"),
    duration: await read("dsx.variable.sharedDuration"),
    buffering: await read("dsx.variable.sharedBuffering"),
    preview: await read("dsx.variable.sharedPreview"),
  };
  if (JSON.stringify(inactivePreload) !== JSON.stringify({
    position: 0.25, time: 7, duration: 9, buffering: false, preview: "active-preview",
  })) errors.push(`inactive media preload clobbered shared transport: ${JSON.stringify(inactivePreload)}`);
  await page.locator("video.handoff-video").evaluate((element) => {
    Object.defineProperties(element, {
      duration: { configurable: true, value: 20 },
      currentTime: { configurable: true, writable: true, value: 8 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    });
  });
  await page.locator("video.handoff-video").evaluate((element: HTMLVideoElement) => { element.currentTime = 3; });
  await set("handoffScrubbing", true);
  await set("sharedPosition", 0.8);
  await set("handoffScrubbing", false);
  const inactiveCurrentTime = await page.locator("video.handoff-video").evaluate((element: HTMLVideoElement) => element.currentTime);
  if (inactiveCurrentTime !== 3) errors.push(`inactive media sought to the active owner's shared bind: ${inactiveCurrentTime}`);
  await page.locator("video.handoff-video").evaluate((element: HTMLVideoElement) => { element.currentTime = 8; });
  await set("handoffActive", true);
  const activeHandoff = {
    position: await read("dsx.variable.sharedPosition"),
    time: await read("dsx.variable.sharedTime"),
    duration: await read("dsx.variable.sharedDuration"),
    preview: await read("dsx.variable.sharedPreview"),
  };
  if (JSON.stringify(activeHandoff) !== JSON.stringify({ position: 0.4, time: 8, duration: 20, preview: "" })) {
    errors.push(`active media handoff did not publish its own transport: ${JSON.stringify(activeHandoff)}`);
  }
  await set("handoffActive", false);

  // session= (audio) / audio= (video): the AVAudioSession category pair is reflected
  // and normalized per kind (audio defaults playback, video defaults ambient).
  if (await page.locator("audio.dsx-audio").first().getAttribute("data-dsx-session") !== "playback") {
    errors.push("audio session category default did not reflect as playback");
  }
  if (await page.locator("video.test-video").getAttribute("data-dsx-session") !== "ambient") {
    errors.push("video audio= category default did not reflect as ambient");
  }
  if (await page.locator("video.test-video").getAttribute("aria-label") !== "Preview video") {
    errors.push("video authored a11yLabel missing");
  }
  if (await page.locator("video.unsafe-video").getAttribute("aria-label") !== "Video") {
    errors.push("video default accessible name missing");
  }
  const fit = await page.locator("video.test-video").evaluate((element) => getComputedStyle(element).objectFit);
  if (fit !== "contain") errors.push(`gravity="fit" did not declare object-fit contain: ${fit}`);

  const graphic = page.locator(".test-svg");
  if (await graphic.getAttribute("role") !== "img" || await graphic.getAttribute("aria-label") !== "Triangle") {
    errors.push("sanitized SVG lacks image semantics/label");
  }
  if (await graphic.locator("svg > path").count() !== 1 || await graphic.getAttribute("data-dsx-valid") !== "true") {
    errors.push("valid DSX path did not produce one sanitized SVG path");
  }
  if (await graphic.locator("script,style,foreignObject,[onload],[href]").count() !== 0) errors.push("SVG active content escaped sanitization");
  if (await page.locator(".invalid-svg").getAttribute("data-dsx-valid") !== "false"
      || await page.locator(".invalid-svg svg").count() !== 0) errors.push("unsupported SVG path grammar did not fail closed");

  await page.locator("#launcher").focus();
  await set("showPhotos", true);
  const layer = page.locator(".dsx-lightbox-layer");
  await layer.waitFor({ state: "visible" });
  await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.classList.contains("dsx-lightbox-close") === true);
  if (await layer.getAttribute("aria-hidden") !== null || await layer.evaluate((element: HTMLElement) => element.inert)
      || await page.locator(".dsx-lightbox-panel").getAttribute("aria-modal") !== "true") {
    errors.push("lightbox did not expose a visible modal dialog");
  }
  if (await page.locator(".dsx-lightbox-counter").textContent() !== "1 / 3") errors.push("lightbox initial counter/index diverged");
  await page.locator(".dsx-lightbox-next").click();
  if (await read("dsx.variable.photoIndex") !== 1 || await page.locator(".dsx-lightbox-counter").textContent() !== "2 / 3") {
    errors.push("lightbox next action did not write bound index");
  }
  await page.locator(".dsx-lightbox-next").focus();
  await page.keyboard.press("End");
  if (await read("dsx.variable.photoIndex") !== 2) errors.push("lightbox End key did not select the final image");
  if (!await page.evaluate(() => document.activeElement?.classList.contains("dsx-lightbox-previous") === true)) {
    errors.push("lightbox did not preserve focus when End disabled the focused Next control");
  }
  // Cross both boundaries reactively while the control that will be disabled owns
  // focus. The replacement starts disabled in the old DOM state, so this pins the
  // enable-target-before-focus ordering needed by WebKit.
  await set("photoIndex", 0);
  if (!await page.evaluate(() => document.activeElement?.classList.contains("dsx-lightbox-next") === true)) {
    errors.push("reactive first-image jump did not hand focused Previous to newly enabled Next");
  }
  await set("photoIndex", 2);
  if (!await page.evaluate(() => document.activeElement?.classList.contains("dsx-lightbox-previous") === true)) {
    errors.push("reactive last-image jump did not hand focused Next to newly enabled Previous");
  }
  const beforeTab = await page.evaluate(() => document.activeElement instanceof HTMLElement
    ? `${document.activeElement.tagName}.${document.activeElement.className}` : String(document.activeElement));
  await page.keyboard.press("Tab");
  if (!await page.evaluate(() => document.querySelector(".dsx-lightbox-panel")?.contains(document.activeElement))) {
    const focusState = await page.evaluate(() => ({
      active: document.activeElement instanceof HTMLElement
        ? `${document.activeElement.tagName}.${document.activeElement.className}` : String(document.activeElement),
      candidates: [...document.querySelectorAll<HTMLElement>(".dsx-lightbox-panel button:not([disabled]),.dsx-lightbox-panel [tabindex]:not([tabindex='-1'])")]
        .map((element) => ({
          tag: `${element.tagName}.${element.className}`,
          rects: element.getClientRects().length,
          hidden: element.hidden,
          inert: element.inert,
          display: getComputedStyle(element).display,
          visibility: getComputedStyle(element).visibility,
      })),
      layerConnected: document.querySelector(".dsx-lightbox-layer")?.isConnected,
    }));
    errors.push(`lightbox Tab escaped the focus trap: ${JSON.stringify({ beforeTab, ...focusState })}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.id === "launcher");
  if (await read("dsx.variable.showPhotos") !== false || await read("dsx.variable.dismisses") !== 1) {
    errors.push("Escape did not close/write/dismiss exactly once");
  }

  // The lightbox must join the same modal ledger as every other DSX overlay.
  // Opening it above a sheet inerts the application once, Escape closes only the
  // top layer, and focus/background state is restored through the shared stack.
  await set("showSheet", true);
  const sheet = page.locator(".dsx-sheet-layer");
  await sheet.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Nested surface" }).focus();
  await set("showPhotos", true);
  await layer.waitFor({ state: "visible" });
  const nested = await page.evaluate(() => ({
    sheetLevel: getComputedStyle(document.querySelector<HTMLElement>(".dsx-sheet-layer")!).getPropertyValue("--dsx-overlay-level").trim(),
    lightboxLevel: getComputedStyle(document.querySelector<HTMLElement>(".dsx-lightbox-layer")!).getPropertyValue("--dsx-overlay-level").trim(),
    backgroundInert: (document.querySelector("#launcher") as HTMLElement).inert,
  }));
  if (nested.sheetLevel !== "1" || nested.lightboxLevel !== "2" || !nested.backgroundInert) {
    errors.push(`nested modal ledger diverged: ${JSON.stringify(nested)}`);
  }
  await page.keyboard.press("Escape");
  if (await read("dsx.variable.showPhotos") !== false || await read("dsx.variable.showSheet") !== true
      || await read("dsx.variable.dismisses") !== 2) errors.push("nested Escape did not close only the top lightbox");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (document.querySelector("#launcher") as HTMLElement).inert === false);
  if (await read("dsx.variable.showSheet") !== false) errors.push("second Escape did not close the underlying sheet");

  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  await set("photoIndex", 0);
  await set("showPhotos", true);
  await layer.waitFor({ state: "visible" });
  await page.keyboard.press("ArrowLeft");
  if (await read("dsx.variable.photoIndex") !== 1) errors.push("RTL ArrowLeft did not move forward in inline order");
  await page.locator(".dsx-lightbox-stage").click({ position: { x: 2, y: 2 }, force: true });
  if (await read("dsx.variable.showPhotos") !== false || await read("dsx.variable.dismisses") !== 3) {
    errors.push("outside/scrim dismissal diverged");
  }
  await page.evaluate(() => { document.documentElement.dir = "ltr"; });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await set("showPhotos", true);
  await layer.waitFor({ state: "visible" });
  const reduced = await page.locator(".dsx-lightbox-close").evaluate((element) => ({
    animation: getComputedStyle(element).animationName,
    transition: getComputedStyle(element).transitionDuration,
  }));
  if (reduced.animation !== "none" || reduced.transition !== "0s") errors.push(`reduced motion leaked animation: ${JSON.stringify(reduced)}`);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 320, height: 720 });
  await set("photoIndex", 0);
  await set("showPhotos", true);
  await layer.waitFor({ state: "visible" });
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    controls: [...document.querySelectorAll<HTMLElement>(".dsx-lightbox-previous,.dsx-lightbox-next,.dsx-lightbox-close")]
      .map((element) => element.getBoundingClientRect().height),
  }));
  if (mobile.overflow > 1) errors.push(`320px media surface overflowed by ${mobile.overflow}px`);
  if (mobile.controls.some((height) => height < 44)) errors.push(`mobile lightbox target below 44px: ${mobile.controls.join(",")}`);
  const touchAction = await page.locator(".dsx-lightbox-stage").evaluate((element) => getComputedStyle(element).touchAction);
  if (touchAction !== "pinch-zoom") errors.push(`lightbox touch ownership diverged: ${touchAction}`);
  // A horizontal swipe with vertical jitter must navigate, never be reclassified
  // as a high-velocity vertical dismissal when synthetic events share a task.
  await page.locator(".dsx-lightbox-stage").evaluate((stage) => {
    const fire = (type: string, x: number, y: number, id: number): void => {
      stage.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: id, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y,
      }));
    };
    fire("pointerdown", 260, 200, 41);
    fire("pointerup", 120, 205, 41);
  });
  const horizontalJitter = {
    index: await read("dsx.variable.photoIndex"),
    presented: await read("dsx.variable.showPhotos"),
    dismisses: await read("dsx.variable.dismisses"),
  };
  if (JSON.stringify(horizontalJitter) !== JSON.stringify({ index: 1, presented: true, dismisses: 4 })) {
    errors.push(`touch horizontal swipe with jitter misclassified: ${JSON.stringify(horizontalJitter)}`);
  }
  await page.locator(".dsx-lightbox-stage").evaluate((stage) => {
    const fire = (type: string, x: number, y: number): void => {
      stage.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 42, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y,
      }));
    };
    fire("pointerdown", 160, 180);
    fire("pointerup", 164, 310);
  });
  if (await read("dsx.variable.showPhotos") !== false || await read("dsx.variable.dismisses") !== 5) {
    errors.push("touch vertical drag did not dismiss exactly once");
  }

  const audioHandle = await audio.elementHandle();
  const teardownBefore = {
    ready: await read("dsx.variable.ready"),
    ended: await read("dsx.variable.ended"),
    failures: await read("dsx.variable.failures"),
    buffering: await read("dsx.variable.buffering"),
  };
  await page.evaluate(() => (window as unknown as { __dsxMediaDispose: () => void }).__dsxMediaDispose());
  if (audioHandle !== null && await audioHandle.getAttribute("src") !== null) errors.push("media teardown retained a fetch source");
  if (audioHandle !== null) {
    await audioHandle.evaluate((element) => {
      for (const type of ["loadedmetadata", "ended", "waiting", "error"]) element.dispatchEvent(new Event(type));
    });
  }
  const teardownAfter = {
    ready: await read("dsx.variable.ready"),
    ended: await read("dsx.variable.ended"),
    failures: await read("dsx.variable.failures"),
    buffering: await read("dsx.variable.buffering"),
  };
  if (JSON.stringify(teardownAfter) !== JSON.stringify(teardownBefore)) {
    errors.push(`detached media emitted state/events after teardown: ${JSON.stringify({ teardownBefore, teardownAfter })}`);
  }
  await page.evaluate(() => (window as unknown as { __dsxMediaCleanup: () => void }).__dsxMediaCleanup());

  if (errors.length === 0) {
    console.log(`✓ [${engine}] media surfaces: URL policy, native audio/video, sanitized SVG, modal gallery, bindings, focus, RTL, responsive density`);
  }
} finally {
  await browser.close();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ [${engine}] ${error}`);
  process.exit(1);
}
