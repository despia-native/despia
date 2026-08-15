import { test } from "node:test";
import assert from "node:assert/strict";

import { compileComponent } from "../../compiler/src/component.ts";
import { CssCollector, extractComponentCss } from "../../compiler/src/css.ts";
import type { Registry } from "../../compiler/src/resolve.ts";
import { renderToString } from "../src/render.ts";

test("SSR media surfaces are deterministic, semantic, bounded and fetch-safe", () => {
  const component = compileComponent("Media", "t", `<stack>
    <head>
      <variable as="open">return true</variable>
      <variable as="closed">return false</variable>
      <variable as="photoIndex">return 1</variable>
      <variable as="photos">return [
        { url: "javascript:alert(1)" },
        { url: "/photos/two.jpg" },
        { url: "https://cdn.example.test/three.jpg" }
      ]</variable>
    </head>
    <audio class="safe-audio" src="/media/track.wav" loop="true" a11yHidden="true"/>
    <audio class="unsafe-audio" src="javascript:alert(1)"/>
    <video class="safe-video" surface="regular" src="https://cdn.example.test/movie.mp4" gravity="fit" muted="true" a11yLabel="Trailer" style="object-fit: {{ 'scale-down' }}"/>
    <svg class="safe-svg" src="&lt;svg viewBox='0 0 10 10'&gt;&lt;rect width='10' height='10' fill='#803366ff'/&gt;&lt;/svg&gt;" a11yLabel="Mark" width="64" height="32"/>
    <svg class="role-svg" d="M 0 0 L 10 10" a11yLabel="Grouped mark" role="group"/>
    <svg class="hidden-svg" d="M 0 0 L 10 10" a11yHidden="true"/>
    <svg class="unsafe-svg" src="&lt;svg&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;/svg&gt;"/>
    <lightbox class="open-box" present="open" images="photos" srcField="url" index="photoIndex" color="#803366ff" a11yLabel="Product photos"/>
    <lightbox class="closed-box" present="closed" urls="/private/closed.jpg"/>
    <lightbox class="bounded-box" present="closed" a11yLabel="{{ vars.hostileLabel }}"/>
  </stack>`);
  extractComponentCss(component, new CssCollector());
  const registry: Registry = { components: { "t.Media": component }, globalPool: {}, css: "", schemes: [] };
  const vars = { hostileLabel: "x".repeat(2 * 1024 * 1024) };
  const first = renderToString(registry, "t.Media", vars);
  const second = renderToString(registry, "t.Media", vars);

  assert.equal(first, second);
  assert.ok(!first.includes("dsx-unsupported"));
  assert.match(first, /<audio class="dsx-audio safe-audio"[^>]*src="\/media\/track\.wav"[^>]* loop/);
  const safeAudio = first.match(/<audio class="dsx-audio safe-audio"[^>]*>/)?.[0] ?? "";
  assert.equal(safeAudio.match(/\baria-hidden=/g)?.length ?? 0, 1, "headless audio never duplicates aria-hidden");
  assert.match(first, /<audio class="dsx-audio unsafe-audio"(?![^>]*src=)/);
  const video = first.match(/<video class="dsx-video safe-video dsx-surface-regular"[^>]*>/)?.[0] ?? "";
  assert.ok(video.length > 0, "video keeps authored and universal surface classes");
  assert.ok(video.includes('aria-label="Trailer"'));
  assert.ok(video.includes('src="https://cdn.example.test/movie.mp4"'));
  assert.ok(video.includes(' muted'));
  assert.ok(video.includes('style="object-fit: contain; object-fit: scale-down"'), "authored style follows and overrides the factory default");
  assert.match(first, /class="dsx-svg safe-svg"[^>]*style="width: 64px; height: 32px"[^>]*data-dsx-valid="true" role="img"/);
  assert.ok(first.includes('fill="#803366ff"'), "SVG preserves CSS #RRGGBBAA");
  const roleSvg = first.match(/<span class="dsx-svg role-svg"[^>]*>/)?.[0] ?? "";
  assert.equal(roleSvg.match(/\brole=/g)?.length ?? 0, 1, "an authored SVG role is never duplicated");
  assert.ok(roleSvg.includes('role="group"'));
  const hiddenSvg = first.match(/<span class="dsx-svg hidden-svg"[^>]*>/)?.[0] ?? "";
  assert.equal(hiddenSvg.match(/\baria-hidden=/g)?.length ?? 0, 1, "unlabelled SVG never duplicates aria-hidden");
  assert.match(first, /class="dsx-svg unsafe-svg"[^>]*data-dsx-valid="false" aria-hidden="true"><\/span>/);
  assert.ok(!first.includes("<script>"));
  assert.match(first, /class="dsx-lightbox-layer" style="--dsx-lightbox-color: #3366ff80"(?![^>]*hidden)/);
  assert.ok(first.includes('role="dialog" aria-modal="true" aria-label="Product photos"'));
  assert.ok(first.includes('src="https://cdn.example.test/three.jpg" alt="Photo 2 of 2"'));
  assert.ok(!first.includes("javascript:alert"));
  assert.match(first, /class="dsx-lightbox-host closed-box"><div class="dsx-lightbox-layer"[^>]* hidden inert aria-hidden="true"/);
  assert.ok(!first.includes('src="/private/closed.jpg"'), "closed SSR lightbox does not prefetch an image");
  const boundedSegment = first.slice(first.indexOf('class="dsx-lightbox-host bounded-box"'));
  const boundedLabels = [...boundedSegment.matchAll(/aria-label="(x+)"/g)].slice(0, 2).map((match) => match[1]!.length);
  assert.deepEqual(boundedLabels, [512, 512], "host and panel labels are bounded before hostile SSR output");
});
