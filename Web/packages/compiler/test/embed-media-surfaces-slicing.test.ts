import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { buildSync } from "esbuild";

import { MEDIA_PLAYBACK_CSS } from "../../dom/src/media-surfaces.ts";
import { renderEmbedFragment } from "../../server/src/render.ts";
import { compileComponent } from "../src/component.ts";
import { sliceRegistry } from "../src/expose.ts";
import type { Registry } from "../src/resolve.ts";
import {
  assertEmbedCompatible,
  embedEntrySource,
  registryFullApplicationTags,
  registryPlaybackMediaTags,
  type EmbedEntryFeatures,
} from "../bin/embed-entry.ts";

const LOCKED_EMBED_BUDGET_BYTES = 49 * 1024;

const noFeatures = (): EmbedEntryFeatures => ({
  universalGlobals: false,
  controlElements: false,
  formElements: false,
  richElements: false,
  nativeControls: false,
  structuralControls: false,
  overlayControls: false,
  dataControls: false,
  audioSurface: false,
  videoSurface: false,
  boundCollections: false,
});

function registryFor(name: string, markup: string): Registry {
  const component = compileComponent(name, "t", markup);
  return { components: { [`t.${name}`]: component }, globalPool: {}, css: "", schemes: [] };
}

function buildLocked(registry: Registry, component: string, features: EmbedEntryFeatures, metafile: boolean) {
  const web = resolve(import.meta.dirname, "../../..");
  const entry = embedEntrySource({ registry, tag: `t-${component.toLowerCase()}`, component: `t.${component}`, features });
  return buildSync({
    metafile,
    stdin: { contents: entry, sourcefile: `${component.toLowerCase()}-media-entry.ts`, resolveDir: web, loader: "ts" },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    write: false,
    absWorkingDir: web,
    logLevel: "silent",
    define: {
      "globalThis.__DSX_OPTIONAL_LINK__": "false",
      "globalThis.__DSX_OPTIONAL_ADOPT__": "false",
      "globalThis.__DSX_OPTIONAL_APIS__": "false",
      "globalThis.__DSX_OPTIONAL_GLOBALS__": "false",
      "globalThis.__DSX_OPTIONAL_RICH__": "false",
      "globalThis.__DSX_OPTIONAL_ICONS__": "false",
      "globalThis.__DSX_OPTIONAL_BOUND_COLLECTIONS__": "false",
      "globalThis.__DSX_OPTIONAL_SURFACES__": "false",
      "globalThis.__DSX_OPTIONAL_PRESSED__": "false",
      "globalThis.__DSX_OPTIONAL_ROLE__": "false",
      "globalThis.__DSX_OPTIONAL_CLASS_FORMULAS__": "false",
      "globalThis.__DSX_OPTIONAL_THEME__": "false",
      "globalThis.__DSX_OPTIONAL_DISABLED__": "false",
      "globalThis.__DSX_OPTIONAL_DESKTOP_INPUT__": "false",
      "globalThis.__DSX_OPTIONAL_GESTURES__": "false",
      "globalThis.__DSX_OPTIONAL_SCAFFOLD__": "false",
      "globalThis.__DSX_OPTIONAL_STATIC_ELEMENTS__": "false",
      "globalThis.__DSX_OPTIONAL_CONTROLS__": "false",
      "globalThis.__DSX_OPTIONAL_MARKDOWN__": "false",
      "globalThis.__DSX_OPTIONAL_JS_GLOBALS__": "false",
      "globalThis.__DSX_OPTIONAL_FETCH__": "false",
    },
  });
}

function lockedBundle(registry: Registry, component: string, features = noFeatures()): Uint8Array {
  return buildLocked(registry, component, features, false).outputFiles[0]!.contents;
}

// Only ever called when the gate has ALREADY tripped, so the extra build costs nothing on the
// green path. The failure this serves is the nasty kind: a kernel line lands in the common path
// and the break surfaces on whatever unrelated PR happened to be next, naming a media test that
// the author never touched. So the message has to carry its own diagnosis — what grew, by how
// much, and the one mechanism that fixes it.
function overBudgetDiagnosis(registry: Registry, component: string, bytes: number): string {
  const output = Object.values(buildLocked(registry, component, noFeatures(), true).metafile!.outputs)[0]!;
  const rows = Object.entries(output.inputs as Record<string, { bytesInOutput: number }>)
    .map(([path, v]) => [path.replace(/^.*OpenSource\/Web\//, ""), v.bytesInOutput] as const)
    .filter(([, b]) => b > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = rows.slice(0, 8)
    .map(([path, b]) => `      ${String(b).padStart(6)}B raw  ${path}`)
    .join("\n");
  return [
    `${component} playback embed is ${bytes}B gzip — ${bytes - LOCKED_EMBED_BUDGET_BYTES}B OVER the`,
    `${LOCKED_EMBED_BUDGET_BYTES}B media qualification.`,
    ``,
    `  This budget is NOT a number to bump. It is what lets <audio>/<video> ship in a`,
    `  self-contained embed at all; raising it silently is how the embed stops being embeddable.`,
    ``,
    `  MOST LIKELY CAUSE: you (or a commit you rebased onto) added a line to the embed COMMON`,
    `  path — the code every embed carries whether or not it uses the feature. Headroom here is`,
    `  single-digit bytes, so a few hundred bytes of new kernel is enough. Check the largest`,
    `  contributors below against your diff:`,
    ``,
    top,
    ``,
    `  THE FIX is normally to put the new code behind a __DSX_OPTIONAL_*__ flag (see`,
    `  build-demo.ts), NOT to raise the budget. One trap: esbuild cannot tree-shake a class`,
    `  METHOD, so a flag checked around a call site does nothing — the flag must fold INSIDE`,
    `  the method body, or the whole method still ships. That exact mistake is what put the`,
    `  link-table dispatch rungs in every embed.`,
  ].join("\n");
}

test("only oversized/host-modal media surfaces are rejected transitively from embeds", () => {
  const root = compileComponent("Root", "t", `<stack><Media/></stack>`);
  const media = compileComponent("Media", "t", `<stack>
    <audio src="/track.wav"/><video src="/movie.mp4"/><svg d="M0 0L1 1"/><lightbox urls="/photo.jpg"/>
  </stack>`);
  const registry: Registry = {
    components: { "t.Root": root, "t.Media": media }, globalPool: {}, css: "", schemes: [],
  };
  const slice = sliceRegistry(registry, "t.Root");
  assert.deepEqual(registryPlaybackMediaTags(slice), ["audio", "video"]);
  assert.deepEqual(registryFullApplicationTags(slice), ["lightbox", "svg"]);
  const message = /full-application-only media surface.*<lightbox>.*<svg>.*default 40KiB G10 widget budget.*declared 49KiB media qualification.*host-level modal ownership.*budget is not raised/;
  assert.throws(() => assertEmbedCompatible(slice, "t.Root"), message);
  assert.throws(() => embedEntrySource({
    registry: slice, tag: "t-root", component: "t.Root", features: noFeatures(),
  }), message, "entry generation cannot bypass the full-application policy");

  const playback = registryFor("Playback", `<stack><audio src="/track.wav"/><video src="/movie.mp4"/></stack>`);
  assert.doesNotThrow(() => assertEmbedCompatible(playback, "t.Playback"));
});

test("playback media imports/registers per tag and carries one shared weak sheet", () => {
  const audioRegistry = registryFor("Audio", `<audio src="/track.wav"/>`);
  const videoRegistry = registryFor("Video", `<video src="/movie.mp4"/>`);
  const combinedRegistry = registryFor("Combined", `<stack><audio src="/track.wav"/><video src="/movie.mp4"/></stack>`);
  const plainRegistry = registryFor("Plain", `<text value="plain"/>`);
  // Detection inside entry generation is deliberate: an alternate caller cannot
  // accidentally omit the playback runtime by passing stale feature flags.
  const audio = embedEntrySource({ registry: audioRegistry, tag: "t-audio", component: "t.Audio", features: noFeatures() });
  const video = embedEntrySource({ registry: videoRegistry, tag: "t-video", component: "t.Video", features: noFeatures() });
  const combined = embedEntrySource({ registry: combinedRegistry, tag: "t-combined", component: "t.Combined", features: noFeatures() });
  const plain = embedEntrySource({ registry: plainRegistry, tag: "t-plain", component: "t.Plain", features: noFeatures() });

  assert.match(audio, /import \{ registerAudioSurface, MEDIA_PLAYBACK_CSS \} from "@despia\/dom\/media-surfaces"/);
  assert.match(audio, /registerAudioSurface\(\);/);
  assert.doesNotMatch(audio, /registerVideoSurface/);
  assert.match(video, /import \{ registerVideoSurface, MEDIA_PLAYBACK_CSS \} from "@despia\/dom\/media-surfaces"/);
  assert.match(video, /registerVideoSurface\(\);/);
  assert.doesNotMatch(video, /registerAudioSurface/);
  assert.match(combined, /registerAudioSurface, registerVideoSurface, MEDIA_PLAYBACK_CSS/);
  assert.equal(combined.match(/registry\.css = \[MEDIA_PLAYBACK_CSS, registry\.css\]/g)?.length, 1);
  assert.doesNotMatch(plain, /media-surfaces|MEDIA_PLAYBACK_CSS|register(?:Audio|Video)Surface/);
});

test("audio, video, and combined playback stay inside the locked 49KiB media qualification", () => {
  const cases = [
    ["Audio", `<audio src="/track.wav"/>`],
    ["Video", `<video src="/movie.mp4"/>`],
    ["Combined", `<stack><audio src="/track.wav"/><video src="/movie.mp4"/></stack>`],
  ] as const;
  const measured: Record<string, number> = {};
  for (const [name, markup] of cases) {
    const bytes = gzipSync(lockedBundle(registryFor(name, markup), name)).length;
    measured[name] = bytes;
    if (bytes > LOCKED_EMBED_BUDGET_BYTES) {
      assert.fail(overBudgetDiagnosis(registryFor(name, markup), name, bytes));
    }
  }
  const plain = lockedBundle(registryFor("Plain", `<text value="plain"/>`), "Plain");
  assert.ok(!Buffer.from(plain).includes(Buffer.from("dsx.mediaSessionOwner.v1")), "plain embed excludes playback lifecycle code");
  assert.ok(measured.Audio > gzipSync(plain).length && measured.Video > gzipSync(plain).length,
    `playback measurements must include the sliced runtime: ${JSON.stringify(measured)}`);

  const ledger = JSON.parse(readFileSync(
    join(resolve(import.meta.dirname, "../../.."), "support/element-support.json"),
    "utf8",
  )) as { elements: Record<string, { knownLimits: string[] }> };
  const combined = measured.Combined!;
  const headroom = LOCKED_EMBED_BUDGET_BYTES - combined;
  for (const [name, bytes] of [["audio", measured.Audio!], ["video", measured.Video!]] as const) {
    const qualification = ledger.elements[name]?.knownLimits.find((limit) => limit.includes("self-contained embeds")) ?? "";
    assert.ok(qualification.includes(`measured ${bytes} bytes gzip for ${name}`),
      `${name} ledger must pin current bytes (${JSON.stringify(measured)})`);
    assert.ok(qualification.includes(`${combined} bytes for combined audio/video`),
      `${name} ledger must pin current combined bytes (${JSON.stringify(measured)})`);
    assert.ok(qualification.includes(`${headroom} bytes below its declared 50176-byte qualification budget`),
      `${name} ledger must pin current headroom (${JSON.stringify(measured)})`);
    assert.ok(qualification.includes("default self-contained widget budget remains 40960 bytes"),
      `${name} ledger must distinguish the ordinary G10 widget budget from its declared media qualification`);
  }
});

test("declarative-shadow-DOM first paint includes playback CSS only for playback slices", () => {
  const playback = registryFor("Audio", `<audio src="/track.wav"/>`);
  const plain = registryFor("Plain", `<text value="plain"/>`);
  const playbackFragment = renderEmbedFragment(playback, "t.Audio", "t-audio", MEDIA_PLAYBACK_CSS);
  const plainFragment = renderEmbedFragment(plain, "t.Plain", "t-plain", "");
  assert.ok(playbackFragment.includes(".dsx-video"));
  assert.ok(playbackFragment.includes(".dsx-audio"));
  assert.ok(!plainFragment.includes(".dsx-video"));

  const builder = readFileSync(join(resolve(import.meta.dirname, "../../.."), "packages/compiler/bin/build-demo.ts"), "utf8");
  assert.match(builder, /sliceUsesAudioSurface\(slice\) \|\| sliceUsesVideoSurface\(slice\) \? \[MEDIA_PLAYBACK_CSS\]/);
  assert.match(builder, /audioSurface: usesAudioSurface/);
  assert.match(builder, /videoSurface: usesVideoSurface/);
});
