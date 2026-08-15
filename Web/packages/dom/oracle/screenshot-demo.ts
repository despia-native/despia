//
//  screenshot-demo.ts - drive the built Demo site in the selected locked Playwright
//  engine: mount the Launcher, walk into pages, exercise reactivity (the Flex
//  direction flip), and save screenshots as W2 acceptance evidence.
//

import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const engine = browserEngine();
const outDir = process.argv[2] ?? join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  "demo/shots",
  engine,
);
mkdirSync(outDir, { recursive: true });

const errors: string[] = [];

const { port, close } = await startServer(0);
let serverClosed = false;
const browser = await launchBrowser(engine);
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()} (${m.location().url})`);
  });

  await page.goto(`http://localhost:${port}/demo/site/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".dsx-list .dsx-row", { timeout: 8000 });
  await page.screenshot({ path: join(outDir, "01-launcher.png") });
  console.log("✓ Launcher rendered", await page.locator(".dsx-list .dsx-row").count(), "rows");

  // → Flex page (a ROUTED push — the URL must follow, /web/04)
  await page.getByText("Flex layout", { exact: true }).first().click();
  await page.waitForSelector('[data-dsx-owner="Flex"]', { timeout: 8000 });
  if (!new URL(page.url()).pathname.endsWith("/flex")) errors.push(`routed push did not sync URL: ${page.url()}`);
  await page.screenshot({ path: join(outDir, "02-flex.png") });
  console.log("✓ Flex page rendered (url → /flex)");

  // reactivity: flip flex-direction through the store
  const flip = page.getByRole("button", { name: /Flip flex-direction/ });
  const before = await flip.textContent();
  await flip.click();
  await page.waitForTimeout(120);
  const after = await flip.textContent();
  if (before === after) errors.push(`flex flip label did not change: ${String(before)}`);
  await page.screenshot({ path: join(outDir, "03-flex-flipped.png") });
  console.log(`✓ Flex direction flipped (${String(before).trim()} → ${String(after).trim()})`);

  // display: none toggle
  await page.getByRole("button", { name: /Hide \(display: none\)/ }).click();
  await page.waitForTimeout(120);
  console.log("✓ display toggle ran");

  // ← back to Launcher via NavBar (dsx.module.route.pop through the bus)
  await page.getByRole("button", { name: "Back" }).first().click();
  await page.waitForTimeout(200);

  // → Basics page (haptics/clipboard/share buttons; buttons must not crash)
  await page.getByText("Basics", { exact: true }).first().click();
  await page.waitForSelector('[data-dsx-owner="Basics"]', { timeout: 8000 });
  await page.getByRole("button", { name: "Light" }).click();
  await page.screenshot({ path: join(outDir, "04-basics.png") });
  console.log("✓ Basics page rendered; haptic tap survived");

  // → back, then System page (toast module renders its overlay)
  await page.getByRole("button", { name: "Back" }).first().click();
  await page.waitForTimeout(200);
  await page.getByText("System & app", { exact: true }).first().click();
  await page.waitForSelector('[data-dsx-owner="System"]', { timeout: 8000 });
  const system = page.locator('[data-dsx-owner="System"]');
  await system.getByRole("button", { name: "Top toast (3s)" }).click();
  await page.waitForSelector('[data-dsx-module="toast"] [role="status"]', { timeout: 4000 });
  console.log("✓ toast module rendered its overlay");
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, "05-system.png") });
  console.log("✓ System page rendered");

  // deep link: a routed URL cold-loads its page ON TOP of the entry (Back works)
  await page.goto(`http://localhost:${port}/demo/site/basics`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-dsx-owner="Basics"]', { timeout: 8000 });
  console.log("✓ deep link /basics cold-loaded");
  await page.goBack();
  await page.waitForTimeout(250);
  const launcherVisible = await page.locator('[data-dsx-owner="Launcher"]').count();
  if (launcherVisible === 0) errors.push("browser Back after deep link did not pop to the Launcher");
  else console.log("✓ browser Back popped to the Launcher");

  // route.* publishes: the store's route view must carry the path
  await page.goto(`http://localhost:${port}/demo/site/flex`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-dsx-owner="Flex"]', { timeout: 8000 });
  await page.screenshot({ path: join(outDir, "06-deeplink-flex.png") });
  console.log("✓ deep link /flex cold-loaded");

  // → Errors & logs: the diagnostics spine end-to-end (Conformance/{errors,logs} live)
  await page.goto(`http://localhost:${port}/demo/site/errors`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-dsx-owner="Errors"]', { timeout: 8000 });
  const counter = page.locator('[data-dsx-owner="Errors"] .dsx-text', { hasText: /^\d+$/ }).first();
  const countBefore = Number((await counter.textContent())?.trim() ?? "0");
  await page.getByRole("button", { name: /dsx\.error — the ambient emission/ }).click();
  await page.getByRole("button", { name: /throw — captured uncaught/ }).click();
  await page.getByRole("button", { name: /failing module call/ }).click();
  await page.waitForTimeout(250);
  const countAfter = Number((await counter.textContent())?.trim() ?? "0");
  if (countAfter !== countBefore + 3) {
    errors.push(`error ledger counter: expected ${countBefore + 3}, got ${countAfter} (raised + uncaught + call must each record)`);
  } else {
    console.log(`✓ error ledger counted raised + uncaught + call (${countBefore} → ${countAfter})`);
  }
  const logBtn = page.getByRole("button", { name: /dsx\.log a line|Logged — check/ });
  await logBtn.click();
  await page.waitForTimeout(120);
  if (!/Logged — check/.test((await logBtn.textContent()) ?? "")) errors.push("dsx.log button label did not flip");
  else console.log("✓ dsx.log ran (label flipped)");
  await page.screenshot({ path: join(outDir, "07-errors.png") });

  // href renders a REAL anchor and SPA-navigates (the /web/04 link contract)
  const link = page.locator('[data-dsx-owner="Errors"] a.dsx-pressable').first();
  const hrefValue = await link.getAttribute("href");
  if (hrefValue === null || !hrefValue.endsWith("/system")) errors.push(`href link did not render a real anchor: ${String(hrefValue)}`);
  await link.click();
  await page.waitForSelector('[data-dsx-owner="System"]', { timeout: 8000 });
  if (!new URL(page.url()).pathname.endsWith("/system")) errors.push(`href click did not push /system: ${page.url()}`);
  else console.log("✓ href link is a real <a> and SPA-pushed /system");
  await page.goBack();
  await page.waitForSelector('[data-dsx-owner="Errors"]', { timeout: 8000 });

  // navigation is pure state: a route.path write navigates (replace — native parity)
  await page.getByRole("button", { name: /pure-state nav/ }).click();
  await page.waitForSelector('[data-dsx-owner="System"]', { timeout: 8000 });
  if (!new URL(page.url()).pathname.endsWith("/system")) errors.push(`route.path write did not navigate: ${page.url()}`);
  else console.log("✓ route.path write navigated (pure-state, replace)");

  // → the themed capability pages render on web too — a native-only module reads as its
  // honest error envelope in a value cell, never a blank or a crash
  await page.goto(`http://localhost:${port}/demo/site/data`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-dsx-owner="Data"]', { timeout: 8000 });
  await page.getByText("writevalue store", { exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, "08-data.png") });
  console.log("✓ Data & integrations page rendered (value cells answer honestly)");
  await page.goto(`http://localhost:${port}/demo/site/media`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-dsx-owner="Media"]', { timeout: 8000 });
  console.log("✓ Media & files page rendered");

  // → Gestures: the universal event/measure surface driven with REAL pointers —
  // on:drag scrubber (payload fraction/phase), on:adjust (keyboard), on:longpress
  // (hold + tap-suppression), on:disappear (visible-if removal), measure=, container
  const gestureResizeErrors: string[] = [];
  const recordGestureResizeError = (error: Error): void => {
    if (error.message.includes("ResizeObserver")) gestureResizeErrors.push(error.message);
  };
  page.on("pageerror", recordGestureResizeError);
  await page.goto(`http://localhost:${port}/demo/site/gestures`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-dsx-owner="Gestures"]', { timeout: 8000 });
  const gestures = page.locator('[data-dsx-owner="Gestures"]');
  const readout = gestures.locator(".dsx-text", { hasText: /^fraction/ }).first();
  await page.waitForTimeout(300); // ResizeObserver's first observation = the onAppear write
  const measured = /track (\d+)×(\d+)/.exec((await readout.textContent()) ?? "");
  if (measured === null || Number(measured[1]) <= 0 || Number(measured[2]) <= 0) {
    errors.push(`measure= did not write the track size: ${String(await readout.textContent())}`);
  } else console.log(`✓ measure= wrote the track size (${measured[1]}×${measured[2]})`);

  const bar = gestures.locator('[aria-label="seek bar"]');
  const box = await bar.boundingBox();
  if (box === null) errors.push("gestures scrubber not found");
  else {
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const t = (await readout.textContent()) ?? "";
    const frac = /fraction (\d+)%/.exec(t);
    if (frac === null || Math.abs(Number(frac[1]) - 90) > 4) errors.push(`on:drag expected ≈90%, got: ${t}`);
    else if (!/phase end/.test(t)) errors.push(`on:drag release did not deliver phase "end": ${t}`);
    else console.log(`✓ on:drag scrubbed to ${frac[1]}% and the release delivered phase "end"`);

    await bar.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    const t2 = (await readout.textContent()) ?? "";
    const frac2 = /fraction (\d+)%/.exec(t2);
    if (frac2 === null || Number(frac2[1]) <= Number(frac?.[1] ?? "0")) errors.push(`on:adjust ArrowRight did not increment: ${t2}`);
    else console.log(`✓ on:adjust incremented via ArrowRight (${String(frac?.[1])}% → ${frac2[1]}%)`);
  }

  const hold = gestures.getByText(/press and hold this row/);
  const hb = await hold.boundingBox();
  if (hb === null) errors.push("longpress row not found");
  else {
    await page.mouse.move(hb.x + 12, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    await page.waitForTimeout(200);
    if ((await gestures.getByText(/recognized — the hold landed/).count()) === 0) {
      errors.push("on:longpress did not recognize a 650ms hold (or the release tap reset it — suppression broken)");
    } else {
      await gestures.getByText(/recognized — the hold landed/).click(); // a plain tap resets (on:tap)
      await page.waitForTimeout(150);
      if ((await gestures.getByText(/press and hold this row/).count()) === 0) errors.push("on:tap after longpress did not reset the row");
      else console.log("✓ on:longpress recognized the hold, consumed the release tap, and a plain tap still works");
    }
  }

  await gestures.getByText(/tap to remove the box below/).click();
  await page.waitForTimeout(200);
  if ((await gestures.getByText(/disappear fired 1×/).count()) === 0) errors.push("on:disappear did not fire on visible-if removal");
  else console.log("✓ on:disappear fired when visible-if removed the element");

  const containerText = (await gestures.getByText(/px wide \(live/).textContent()) ?? "";
  const cw = /is (\d+)px wide/.exec(containerText);
  if (cw === null || Number(cw[1]) <= 0) errors.push(`container/dsx.element.* did not publish a live width: ${containerText}`);
  else console.log(`✓ container published dsx.element.width (${cw[1]}px)`);
  const containerValues = await gestures.getByText(/px wide \(live/).evaluate(async (node) => {
    const values = new Set<string>([(node.textContent ?? "").trim()]);
    const observer = new MutationObserver(() => values.add((node.textContent ?? "").trim()));
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 320));
    observer.disconnect();
    return [...values];
  });
  page.off("pageerror", recordGestureResizeError);
  if (containerValues.length !== 1) {
    errors.push(`container/dsx.element.* did not converge after layout: ${containerValues.join(" ↔ ")}`);
  }
  if (gestureResizeErrors.length > 0) {
    errors.push(`Gestures emitted ${gestureResizeErrors.length} ResizeObserver page error(s): ${gestureResizeErrors[0]}`);
  }
  if (containerValues.length === 1 && gestureResizeErrors.length === 0) {
    console.log("✓ container width readout converged with no ResizeObserver page errors");
  }

  // the TextField trio (on:focus / on:blur / on:submit — TextField.swift's contract)
  const field = gestures.locator("input.dsx-textfield").first();
  const fieldState = gestures.locator(".dsx-text", { hasText: /^field state/ }).first();
  await field.click();
  await page.waitForTimeout(120);
  if (!/field state focused/.test((await fieldState.textContent()) ?? "")) errors.push("textfield on:focus did not fire");
  await gestures.getByText(/tap to remove the box below|tap to bring it back/).click(); // focus leaves the field
  await page.waitForTimeout(120);
  if (!/field state blurred/.test((await fieldState.textContent()) ?? "")) errors.push("textfield on:blur did not fire");
  await field.click();
  await field.fill("abc");
  await field.press("Enter");
  await page.waitForTimeout(120);
  const submitted = (await fieldState.textContent()) ?? "";
  if (!/field state submitted: abc/.test(submitted)) errors.push(`textfield on:submit did not deliver the value: ${submitted}`);
  else console.log("✓ textfield on:focus / on:blur / on:submit fired (submit carried the value)");

  // on:doubleTap — fires ADDITIONALLY on the second tap; on:tap keeps firing on each
  const dbl = gestures.getByText(/^tap \d+× · double \d+×$/);
  await dbl.dblclick();
  await page.waitForTimeout(150);
  const dblText = (await dbl.textContent()) ?? "";
  if (!/tap 2× · double 1×/.test(dblText)) errors.push(`on:doubleTap expected "tap 2× · double 1×", got: ${dblText}`);
  else console.log("✓ on:doubleTap fired on the second tap (and on:tap on both)");
  await page.screenshot({ path: join(outDir, "09-gestures.png") });

  // → the web-component embed (gate G10): a PLAIN page — no DSX app, one script tag.
  // The custom element upgrades, attributes drive signals, <event> dispatches a
  // composed CustomEvent, the named slot projects the host's light DOM.
  await page.goto(`http://localhost:${port}/demo/site/embed-host.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("demo-embedcard")?.shadowRoot?.querySelector(".dsx-text") !== null, undefined, { timeout: 8000 });
  const embedText = async (): Promise<string> => await page.evaluate(() =>
    [...(document.querySelector("demo-embedcard")?.shadowRoot?.querySelectorAll(".dsx-text") ?? [])].map((t) => t.textContent).join(" | "));
  const seeded = await embedText();
  if (!seeded.includes("Third-party page") || !seeded.includes("attribute count: 3")) {
    errors.push(`embed attributes did not seed the component: ${seeded}`);
  } else console.log("✓ embed upgraded on a plain page and seeded its attributes");
  const clientTokens = await page.evaluate(() => {
    const host = document.querySelector("demo-embedcard") as HTMLElement | null;
    if (host === null) return null;
    const style = getComputedStyle(host);
    return {
      label: style.getPropertyValue("--dsx-label").trim(),
      background: style.getPropertyValue("--dsx-background").trim(),
      control: style.getPropertyValue("--dsx-control-height").trim(),
    };
  });
  if (clientTokens === null || clientTokens.label.length === 0 || clientTokens.background.length === 0 || clientTokens.control !== "40px") {
    errors.push(`client embed did not own mobile-first shadow tokens: ${JSON.stringify(clientTokens)}`);
  } else console.log("✓ client embed owns light/dark-safe mobile tokens on a plain host");
  const pinnedTokens = await page.evaluate(() => {
    const host = document.querySelector("demo-embedcard") as HTMLElement;
    host.setAttribute("data-dsx-theme", "dark");
    const style = getComputedStyle(host);
    const result = {
      label: style.getPropertyValue("--dsx-label").trim(),
      background: style.getPropertyValue("--dsx-background").trim(),
    };
    host.removeAttribute("data-dsx-theme");
    return result;
  });
  if (pinnedTokens.label !== "#f4f4f5" || pinnedTokens.background !== "#101012") {
    errors.push(`client embed host theme pin did not override the OS scheme: ${JSON.stringify(pinnedTokens)}`);
  } else console.log("✓ client embed host theme pin overrides the OS scheme");
  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopControl = await page.evaluate(() => {
    const host = document.querySelector("demo-embedcard") as HTMLElement;
    return getComputedStyle(host).getPropertyValue("--dsx-control-height").trim();
  });
  if (desktopControl !== "32px") errors.push(`client embed missed precision-pointer density: ${desktopControl}`);
  else console.log("✓ client embed switches to precision-pointer desktop density");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#drive");
  await page.waitForTimeout(150);
  const driven = await embedText();
  if (!driven.includes("attribute count: 7")) errors.push(`embed attribute write did not re-render: ${driven}`);
  else console.log("✓ embed attribute write converged on the signal (no re-mount)");
  await page.evaluate(() => (document.querySelector("demo-embedcard")?.shadowRoot?.querySelector("button") as HTMLButtonElement).click());
  await page.waitForTimeout(150);
  const cheer = (await page.locator("#log").textContent()) ?? "";
  if (!cheer.startsWith("cheer:") || !cheer.includes("7")) errors.push(`embed <event> did not dispatch a CustomEvent with payload: ${cheer}`);
  else console.log(`✓ embed <event> dispatched a composed CustomEvent (${cheer})`);
  const slotted = await page.evaluate(() => {
    const s = document.querySelector("demo-embedcard")?.shadowRoot?.querySelector("slot[name=footer]") as HTMLSlotElement | null;
    return s === null ? "NO SLOT" : s.assignedElements().map((e) => e.textContent).join();
  });
  if (slotted !== "light-dom footer") errors.push(`embed named slot did not project light DOM: ${slotted}`);
  else console.log("✓ embed named slot projects the host page's light DOM");
  const acao = await page.evaluate(async () => (await fetch("/demo/site/embed/demo/EmbedCard.js")).headers.get("access-control-allow-origin"));
  if (acao !== "*") errors.push(`embed CORS (origins ["*"]) did not emit the header: ${String(acao)}`);
  else console.log("✓ embed assets carry the declared CORS allowlist");
  await page.screenshot({ path: join(outDir, "10-embed.png") });

  // the DSD variant: the pre-rendered fragment paints WITHOUT JavaScript
  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 800, height: 600 } });
  const staticPage = await noJs.newPage();
  await staticPage.goto(`http://localhost:${port}/demo/site/embed-host-dsd.html`, { waitUntil: "domcontentloaded" });
  const dsdPaint = await staticPage.evaluate(() => document.querySelector("demo-embedcard")?.shadowRoot?.textContent ?? "NO SHADOW ROOT");
  if (!dsdPaint.includes("Third-party page")) errors.push(`DSD fragment did not paint without JS: ${dsdPaint.slice(0, 80)}`);
  else console.log("✓ DSD fragment painted with JavaScript disabled (server-side shadow root)");
  const dsdTokens = await staticPage.evaluate(() => {
    const host = document.querySelector("demo-embedcard") as HTMLElement | null;
    if (host === null) return null;
    const style = getComputedStyle(host);
    return {
      label: style.getPropertyValue("--dsx-label").trim(),
      background: style.getPropertyValue("--dsx-background").trim(),
      control: style.getPropertyValue("--dsx-control-height").trim(),
    };
  });
  if (dsdTokens === null || dsdTokens.label.length === 0 || dsdTokens.background.length === 0 || dsdTokens.control !== "40px") {
    errors.push(`DSD embed did not own computed shadow tokens without JS: ${JSON.stringify(dsdTokens)}`);
  } else console.log("✓ DSD fragment owns computed mobile tokens before JavaScript");
  await noJs.close();
  // …and with JS on, the upgrade takes over the same markup (drive still works)
  await page.goto(`http://localhost:${port}/demo/site/embed-host-dsd.html`, { waitUntil: "networkidle" });
  await page.click("#drive");
  await page.waitForTimeout(200);
  const dsdDriven = await embedText();
  if (!dsdDriven.includes("attribute count: 7")) errors.push(`DSD upgrade did not take over the pre-rendered element: ${dsdDriven}`);
  else console.log("✓ DSD element upgraded in place and stays drivable");
  // the dynamic fragment endpoint (scenario 2: a third-party server fetches it)
  const fragment = await page.evaluate(async () => await (await fetch("/demo/site/embed/demo/EmbedCard.html?title=From%20query&count=42")).text());
  if (!fragment.includes('shadowrootmode="open"') || !fragment.includes("From query") || !fragment.includes("attribute count: 42")) {
    errors.push(`dynamic DSD endpoint did not render query attributes: ${fragment.slice(0, 120)}`);
  } else console.log("✓ /embed fragment endpoint renders query attributes server-side");

  // → gate G10-editor: the TOOL-GRADE embed — the canvas editor (StackEditor.dsx +
  // the EditorCanvas facet + the StackCanvas SDK) as ONE custom element on a plain
  // page. Upgrade → the deck attribute (rich JSON) renders as editable nodes; a
  // pointer press selects (SDK "select" → composed CustomEvent); driving the
  // preview attribute flips the live simulator on and off.
  await page.goto(`http://localhost:${port}/demo/site/editor-host.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const world = document.querySelector("despia-editor")?.shadowRoot?.querySelector(".sc-world");
    return world !== null && world !== undefined && world.querySelectorAll("[data-id]").length >= 3;
  }, undefined, { timeout: 8000 });
  const editorSeed = await page.evaluate(() => {
    const root = document.querySelector("despia-editor")?.shadowRoot;
    return {
      nodes: root?.querySelectorAll(".sc-world [data-id]").length ?? 0,
      text: root?.querySelector(".sc-world")?.textContent ?? "",
      styled: root?.querySelector("style[data-stack-canvas]") !== null,
    };
  });
  if (editorSeed.nodes < 3 || !editorSeed.text.includes("Hello embed")) {
    errors.push(`editor embed did not render the deck attribute: ${editorSeed.nodes} nodes, "${editorSeed.text.slice(0, 60)}"`);
  } else console.log(`✓ editor embed upgraded and rendered the deck (${editorSeed.nodes} editable nodes)`);
  if (!editorSeed.styled) errors.push("editor embed missing the SDK sheet inside the shadow root (injectStyles shadow twin)");
  else console.log("✓ SDK stylesheet landed inside the shadow root (document styles can't cross)");
  const editorLog = page.locator("#log");
  await page.waitForFunction(() => document.querySelector("#log")?.textContent?.includes("ready") === true);
  if (!((await editorLog.textContent()) ?? "").includes("ready")) errors.push("editor embed did not dispatch the ready CustomEvent");
  await page.locator("despia-editor").getByText("Hello embed").click();
  await page.waitForTimeout(200);
  const selLog = (await editorLog.textContent()) ?? "";
  if (!selLog.includes("select:id")) errors.push(`editor select did not dispatch a CustomEvent with the node id: ${selLog}`);
  else console.log("✓ editor pointer selection dispatched select (payload carries the node id)");
  await page.click("#preview");
  await page.waitForTimeout(300);
  const prevLog = (await editorLog.textContent()) ?? "";
  if (!prevLog.includes('preview:{"on":true}')) errors.push(`editor preview attribute did not start the simulator: ${prevLog}`);
  else console.log("✓ editor preview attribute drove the live simulator (attribute → signal → SDK)");
  await page.screenshot({ path: join(outDir, "11-editor-embed.png") });

  // → DSX Scene (dsx-scene.md P1): the /scene-element route (a package-contributed
  // route — scene-demo's dsx.json; /scene itself belongs to the app's native
  // scene3d/Godot page). REAL WebGL under this walk: the canvas must paint non-blank
  // (never one flat color), a store write must re-render the transforms (reactive
  // spin), and tap picking v0 must fire the node's handler.
  await page.goto(`http://localhost:${port}/demo/site/scene-element`, { waitUntil: "networkidle" });
  await page.waitForSelector(".dsx-scene-canvas", { timeout: 8000 });
  await page.waitForTimeout(250); // first rAF draw + resize settle
  const probeScene = async (): Promise<{ colors: number; hash: number }> => await page.evaluate(() => {
    const canvas = document.querySelector(".dsx-scene-canvas") as HTMLCanvasElement;
    const probe = document.createElement("canvas");
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx2d = probe.getContext("2d")!;
    ctx2d.drawImage(canvas, 0, 0);
    const data = ctx2d.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set<number>();
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      const pixel = ((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!) >>> 0;
      colors.add(pixel);
      hash = ((hash * 31) + pixel) >>> 0;
    }
    return { colors: colors.size, hash };
  });
  const scenePaint = await probeScene();
  if (scenePaint.colors < 4) errors.push(`scene canvas is (nearly) one flat color: ${scenePaint.colors} distinct colors`);
  else console.log(`✓ scene canvas painted non-blank (${scenePaint.colors} distinct colors)`);
  await page.screenshot({ path: join(outDir, "12-scene.png") });
  // reactive transforms: one store write (the spin variable) = a new frame
  await page.getByRole("button", { name: /Spin 15°/ }).click();
  await page.waitForTimeout(250);
  const sceneSpun = await probeScene();
  if (sceneSpun.hash === scenePaint.hash) errors.push("scene did not re-render after the spin store write");
  else console.log("✓ scene re-rendered reactively on the spin store write");
  const spinLabel = (await page.getByText(/Rotation: \d+°/).textContent()) ?? "";
  if (!spinLabel.includes("Rotation: 15°")) errors.push(`spin variable did not advance: ${spinLabel}`);
  await page.screenshot({ path: join(outDir, "12-scene-spun.png") });
  // tap picking v0: the ball sits at world (1,0,0) ⇒ ndc x ≈ +0.228 (spin is ignored
  // for the SPHERE's center only when spin=15° moves it — click the projected point
  // for the CURRENT rotation, computed the corpus way: Ry(15°)·(1,0,0))
  const spinRad = 15 * Math.PI / 180;
  const ballWorld = { x: Math.cos(spinRad), z: -Math.sin(spinRad) };
  const canvasBox = await page.locator(".dsx-scene-canvas").first().boundingBox();
  if (canvasBox === null) errors.push("scene canvas has no layout box");
  else {
    // project Ry(15°)·(1,0,0) through the demo camera (0,1.5,4)→origin, fov 60, the
    // canvas's real aspect — the same math the corpus pins (projection.json law)
    const aspect = canvasBox.width / canvasBox.height;
    const eye = [0, 1.5, 4] as const;
    const f = (() => { const l = Math.hypot(eye[0], eye[1], eye[2]); return [-eye[0] / l, -eye[1] / l, -eye[2] / l] as const; })();
    const s = (() => { const c = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]; const l = Math.hypot(c[0]!, c[1]!, c[2]!); return [c[0]! / l, c[1]! / l, c[2]! / l] as const; })();
    const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]] as const;
    const p = [ballWorld.x - eye[0], 0 - eye[1], ballWorld.z - eye[2]] as const;
    const vx = s[0] * p[0] + s[1] * p[1] + s[2] * p[2];
    const vy = u[0] * p[0] + u[1] * p[1] + u[2] * p[2];
    const vz = f[0] * p[0] + f[1] * p[1] + f[2] * p[2];
    const t = 1 / Math.tan((60 / 2) * Math.PI / 180);
    const ndcX = (t / aspect) * vx / vz;
    const ndcY = t * vy / vz;
    await page.mouse.click(
      canvasBox.x + (ndcX + 1) / 2 * canvasBox.width,
      canvasBox.y + (1 - ndcY) / 2 * canvasBox.height,
    );
    await page.waitForTimeout(200);
    const picked = (await page.getByText(/Picked: /).textContent()) ?? "";
    if (!picked.includes("Picked: ball")) errors.push(`scene tap picking did not select the ball: ${picked}`);
    else console.log("✓ scene tap picking fired the ball's on:tap handler");
  }

  // → DSX Scene P4 (dsx-scene.md P4): the second scene on the same route — a textured
  // box (the UV law), a <text3d> billboard, and an on:frame tick loop. The canvas must
  // paint non-blank with MORE distinct colors than a flat scene (texture + glyphs),
  // and two probes a few frames apart must differ (the budgeted loop is spinning the
  // rig through the runner — the store variable advances too).
  const probeP4 = async (): Promise<{ colors: number; hash: number }> => await page.evaluate(() => {
    const canvas = document.querySelectorAll(".dsx-scene-canvas")[1] as HTMLCanvasElement;
    const probe = document.createElement("canvas");
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx2d = probe.getContext("2d")!;
    ctx2d.drawImage(canvas, 0, 0);
    const data = ctx2d.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set<number>();
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      const pixel = ((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!) >>> 0;
      colors.add(pixel);
      hash = ((hash * 31) + pixel) >>> 0;
    }
    return { colors: colors.size, hash };
  });
  await page.getByRole("img", { name: /P4 scene/ }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(400); // texture/glyph upload + a few on:frame ticks
  const p4First = await probeP4();
  if (p4First.colors < 6) errors.push(`P4 scene canvas is too flat for a textured+labelled rig: ${p4First.colors} distinct colors`);
  else console.log(`✓ P4 scene painted textured+labelled (${p4First.colors} distinct colors)`);
  await page.screenshot({ path: join(outDir, "12-scene-p4.png") });
  await page.waitForTimeout(350);
  const p4Second = await probeP4();
  if (p4Second.hash === p4First.hash) errors.push("P4 scene did not animate — the on:frame loop is not re-rendering");
  else console.log("✓ P4 scene animates under on:frame (two probes differ)");
  const autoLabel = (await page.getByText(/auto = \d+°/).textContent()) ?? "";
  const autoValue = Number(/auto = (\d+)°/.exec(autoLabel)?.[1] ?? "0");
  if (autoValue <= 0) errors.push(`the on:frame handler did not advance the store variable: ${autoLabel}`);
  else console.log(`✓ on:frame handler advanced the store variable (auto = ${autoValue}°)`);

  // → DSX Scene P5 (dsx-scene.md P5): the third scene — a looping <animate> tween
  // (frames must differ across samples WITHOUT any on:frame handler), a bound enemy
  // group (a store write spawns a keyed row that appears on the canvas), and an
  // implicit transition (tapping Slide glides the cube — the canvas ends elsewhere).
  const probeP5 = async (): Promise<{ colors: number; hash: number }> => await page.evaluate(() => {
    const canvas = document.querySelectorAll(".dsx-scene-canvas")[2] as HTMLCanvasElement;
    const probe = document.createElement("canvas");
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx2d = probe.getContext("2d")!;
    ctx2d.drawImage(canvas, 0, 0);
    const data = ctx2d.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set<number>();
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      const pixel = ((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!) >>> 0;
      colors.add(pixel);
      hash = ((hash * 31) + pixel) >>> 0;
    }
    return { colors: colors.size, hash };
  });
  await page.getByRole("img", { name: /P5 scene/ }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(400); // first draws + the tween loop under way
  const p5First = await probeP5();
  if (p5First.colors < 6) errors.push(`P5 scene canvas is too flat for a lit multi-node rig: ${p5First.colors} distinct colors`);
  else console.log(`✓ P5 scene painted (point light + fog + rows: ${p5First.colors} distinct colors)`);
  await page.screenshot({ path: join(outDir, "12-scene-p5.png") });
  await page.waitForTimeout(400);
  const p5Second = await probeP5();
  if (p5Second.hash === p5First.hash) errors.push("P5 scene did not animate — the looping <animate> tween is not re-rendering");
  else console.log("✓ P5 looping tween animates (two probes differ — no on:frame handler authored)");
  // a spawned row appears after a store write (the bound group's keyed reconcile)
  const enemiesBefore = (await page.getByText(/Enemies: \d+/).textContent()) ?? "";
  await page.getByRole("button", { name: /Spawn an enemy/ }).click();
  await page.waitForTimeout(300);
  const enemiesAfter = (await page.getByText(/Enemies: \d+/).textContent()) ?? "";
  const beforeCount = Number(/Enemies: (\d+)/.exec(enemiesBefore)?.[1] ?? "0");
  const afterCount = Number(/Enemies: (\d+)/.exec(enemiesAfter)?.[1] ?? "0");
  if (afterCount !== beforeCount + 1) errors.push(`spawn did not add a bound row: ${enemiesBefore} → ${enemiesAfter}`);
  else console.log(`✓ a store write spawned a bound scene row (${beforeCount} → ${afterCount})`);
  // the implicit transition: Slide glides the blue cube from the left half to the
  // right half. The looping tween changes the whole-canvas hash every frame, so the
  // honest check is REGIONAL: count blue-dominant pixels (the glider's #2563eb) in
  // the lower half's left vs right thirds before and after.
  const probeGlider = async (): Promise<{ left: number; right: number }> => await page.evaluate(() => {
    const canvas = document.querySelectorAll(".dsx-scene-canvas")[2] as HTMLCanvasElement;
    const probe = document.createElement("canvas");
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx2d = probe.getContext("2d")!;
    ctx2d.drawImage(canvas, 0, 0);
    const data = ctx2d.getImageData(0, 0, probe.width, probe.height).data;
    let left = 0, right = 0;
    for (let y = Math.floor(probe.height * 0.5); y < probe.height; y += 1) {
      for (let x = 0; x < probe.width; x += 1) {
        const i = (y * probe.width + x) * 4;
        if (data[i + 2]! > data[i]! + 80) { // blue-dominant = the glider cube
          if (x < probe.width / 3) left += 1;
          else if (x > probe.width * 2 / 3) right += 1;
        }
      }
    }
    return { left, right };
  });
  const preSlide = await probeGlider();
  await page.getByRole("button", { name: /Slide the cube/ }).click();
  await page.waitForTimeout(900); // the 500ms ease-out glide + settle
  const postSlide = await probeGlider();
  if (!(preSlide.left > preSlide.right * 2) || !(postSlide.right > postSlide.left * 2)) {
    errors.push(`the transition= glide did not move the cube left→right: before ${JSON.stringify(preSlide)}, after ${JSON.stringify(postSlide)}`);
  } else console.log(`✓ transition= glided the cube across the canvas (left ${preSlide.left}px → right ${postSlide.right}px)`);
  await page.screenshot({ path: join(outDir, "12-scene-p5-after.png") });

  // → DSX Scene G2 (dsx-game.md §2 G2): the fourth scene — the fixed-tick physics
  // showcase. The ball must REST at the corpus-pinned height (physics.json
  // "sim/resting": rest center y = 0.494319 for r 0.5 on a floor topped at 0),
  // projected through the demo camera ((0,1.5,6) → (0,1,0), fov 60) the corpus way.
  // The check is REGIONAL like P5's glide: the orange-dominant pixel centroid sits in
  // the projected band, jumps ABOVE it right after the bus velocity write (the
  // impulse verb), and returns once re-settled. The tick counter pins the fixed-tick
  // loop: it advances while the body is awake and STOPS once asleep.
  const probePhysics = async (): Promise<{ count: number; fraction: number }> => await page.evaluate(() => {
    const canvas = document.querySelectorAll(".dsx-scene-canvas")[3] as HTMLCanvasElement;
    const probe = document.createElement("canvas");
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx2d = probe.getContext("2d")!;
    ctx2d.drawImage(canvas, 0, 0);
    const data = ctx2d.getImageData(0, 0, probe.width, probe.height).data;
    let count = 0, ySum = 0;
    for (let y = 0; y < probe.height; y += 1) {
      for (let x = 0; x < probe.width; x += 1) {
        const i = (y * probe.width + x) * 4;
        // orange-dominant = the ball (#f59e0b under the demo lights)
        if (data[i]! > 120 && data[i + 2]! < 110 && data[i]! > data[i + 2]! + 60 && data[i + 1]! > data[i + 2]!) {
          count += 1;
          ySum += y;
        }
      }
    }
    return { count, fraction: count === 0 ? -1 : ySum / count / probe.height };
  });
  await page.getByRole("img", { name: /G2 physics/ }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(3000); // drop + bounces + rest + sleep (~tick 148 — the loop stops)
  // the corpus resting y projected through the demo camera (the projection.json law)
  const restNdcY = (() => {
    const eye = [0, 1.5, 6] as const, target = [0, 1, 0] as const, restY = 0.494319;
    const fLen = Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
    const f = [(target[0] - eye[0]) / fLen, (target[1] - eye[1]) / fLen, (target[2] - eye[2]) / fLen] as const;
    const s = [-f[2], 0, f[0]] as const; // f × up, up = +Y
    const sLen = Math.hypot(s[0], s[1], s[2]);
    const sn = [s[0] / sLen, s[1] / sLen, s[2] / sLen] as const;
    const u = [sn[1] * f[2] - sn[2] * f[1], sn[2] * f[0] - sn[0] * f[2], sn[0] * f[1] - sn[1] * f[0]] as const;
    const p = [0 - eye[0], restY - eye[1], 0 - eye[2]] as const;
    const vy = u[0] * p[0] + u[1] * p[1] + u[2] * p[2];
    const vz = f[0] * p[0] + f[1] * p[1] + f[2] * p[2];
    return (1 / Math.tan((60 / 2) * Math.PI / 180)) * vy / vz;
  })();
  const restFraction = (1 - restNdcY) / 2;
  const atRest = await probePhysics();
  if (atRest.count === 0) errors.push("G2 physics: no orange ball pixels found at rest");
  else if (Math.abs(atRest.fraction - restFraction) > 0.1) {
    errors.push(`G2 physics: the ball is not resting at the corpus height (centroid ${atRest.fraction.toFixed(3)} vs projected ${restFraction.toFixed(3)})`);
  } else console.log(`✓ G2 ball rests at the corpus-pinned height (centroid ${atRest.fraction.toFixed(3)} ~ projected ${restFraction.toFixed(3)})`);
  const ticksLabel = (await page.getByText(/Ticks: \d+/).textContent()) ?? "";
  const ticksAtRest = Number(/Ticks: (\d+)/.exec(ticksLabel)?.[1] ?? "0");
  if (ticksAtRest <= 0) errors.push(`G2 physics: on:tick did not advance the store: ${ticksLabel}`);
  else console.log(`✓ on:tick fired per fixed step through the runner (${ticksAtRest} ticks to rest + sleep)`);
  await page.screenshot({ path: join(outDir, "12-scene-g2-rest.png") });
  await page.getByRole("button", { name: /Launch the ball/ }).click();
  await page.waitForTimeout(320); // ~19 fixed steps of upward flight (y ≈ 2.19)
  const inFlight = await probePhysics();
  if (inFlight.count === 0 || !(inFlight.fraction < restFraction - 0.12)) {
    errors.push(`G2 physics: the bus velocity write did not launch the ball (centroid ${inFlight.fraction.toFixed(3)} vs rest ${restFraction.toFixed(3)})`);
  } else console.log(`✓ the bus velocity write (the impulse verb) launched the ball (centroid ${inFlight.fraction.toFixed(3)})`);
  await page.screenshot({ path: join(outDir, "12-scene-g2-flight.png") });
  await page.waitForTimeout(3800); // fall + bounces + re-rest + sleep again (~tick 190)
  const settled = await probePhysics();
  const ticksAfterLabel = (await page.getByText(/Ticks: \d+/).textContent()) ?? "";
  const ticksSettled = Number(/Ticks: (\d+)/.exec(ticksAfterLabel)?.[1] ?? "0");
  if (settled.count === 0 || Math.abs(settled.fraction - restFraction) > 0.1) {
    errors.push(`G2 physics: the ball did not re-settle at the corpus height (centroid ${settled.fraction.toFixed(3)})`);
  } else console.log("✓ G2 ball re-settled at the corpus-pinned height after the launch");
  if (ticksSettled <= ticksAtRest) errors.push("G2 physics: the loop did not resume ticking after the launch");
  else console.log(`✓ the loop resumed on the write and slept again (${ticksAtRest} → ${ticksSettled} ticks)`);
  await page.screenshot({ path: join(outDir, "12-scene-g2-settled.png") });

  // back out so the matrix below starts from the launcher exactly as before
  await page.goto(`http://localhost:${port}/demo/site/`, { waitUntil: "networkidle" });

  // Production viewport/accessibility matrix: exercise the same built output at
  // the compact-phone floor, tablet, and a desktop viewport. These are behavior
  // gates (content, overflow, usable names), not screenshot-only approvals.
  const matrix = [
    { name: "compact-phone", viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, colorScheme: "light" as const, reducedMotion: "reduce" as const },
    { name: "tablet", viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, colorScheme: "dark" as const, reducedMotion: "no-preference" as const },
    { name: "desktop", viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, colorScheme: "light" as const, reducedMotion: "reduce" as const },
  ];
  for (const entry of matrix) {
    const context = await browser.newContext({
      viewport: entry.viewport,
      isMobile: entry.isMobile,
      hasTouch: entry.hasTouch,
      colorScheme: entry.colorScheme,
      reducedMotion: entry.reducedMotion,
    });
    const matrixPage = await context.newPage();
    matrixPage.on("pageerror", (e) => errors.push(`${entry.name} pageerror: ${e.message}`));
    await matrixPage.goto(`http://localhost:${port}/demo/site/`, { waitUntil: "networkidle" });
    await matrixPage.waitForSelector(".dsx-list .dsx-row", { timeout: 8000 });
    const audit = await matrixPage.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((el) => el.id).filter(Boolean);
      const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const unnamedButtons = [...document.querySelectorAll("button")].filter((el) => {
        const button = el as HTMLButtonElement;
        return !((button.getAttribute("aria-label") ?? button.textContent ?? button.title).trim());
      }).length;
      return {
        rows: document.querySelectorAll(".dsx-list .dsx-row").length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        duplicates,
        unnamedButtons,
      };
    });
    // 24 since `macwindow` reached the web tier. That commit moved the three sibling pins
    // (render.test.ts ×2, demo-craft.test.ts) and missed this one, which only a browser run
    // surfaces — so the walk had been red on every viewport since.
    if (audit.rows !== 24) errors.push(`${entry.name}: expected 24 launcher rows, got ${audit.rows}`);
    if (audit.overflow > 1) errors.push(`${entry.name}: horizontal overflow ${audit.overflow}px`);
    if (audit.duplicates.length > 0) errors.push(`${entry.name}: duplicate ids ${audit.duplicates.join(", ")}`);
    if (audit.unnamedButtons > 0) errors.push(`${entry.name}: ${audit.unnamedButtons} unnamed button(s)`);
    await matrixPage.screenshot({ path: join(outDir, `matrix-${entry.name}.png`), fullPage: false });
    console.log(`✓ ${entry.name} matrix: rows, overflow, IDs, and button names`);

    // Gallery visual-regression matrix. Keep this to one deterministic viewport
    // capture per breakpoint while varying the state intentionally:
    //   compact → untouched defaults
    //   tablet  → dark theme with populated/selected controls
    //   desktop → precision-pointer hover plus keyboard focus
    // This gives reviewers the three responsive compositions and the important
    // interaction states without tripling every screenshot in this oracle.
    await matrixPage.goto(`http://localhost:${port}/demo/site/gallery`, { waitUntil: "networkidle" });
    const gallery = matrixPage.locator('[data-dsx-owner="Gallery"]').last();
    await gallery.waitFor({ state: "visible", timeout: 8000 });

    // The Gallery is a TABBED scaffold, and `visible-if` OMITS an inactive panel from the DOM
    // rather than hiding it, so exactly one panel exists at a time. The audit therefore walks
    // the four sections and measures each in turn. Doing it before the interaction states below
    // matters: switching tabs would discard the focus/hover/populated states the screenshot is
    // meant to capture.
    const SECTIONS = ["Controls", "Inputs", "Feedback", "Patterns"] as const;
    let sectionsRendered = 0;
    let totalControls = 0;
    for (const section of SECTIONS) {
      await gallery.locator(`.gallery-rail-target[aria-label="${section}"]`).click();
      const panel = await gallery.evaluate((surface, wideInputs: boolean) => {
        const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
        const panels = [...surface.querySelectorAll<HTMLElement>(".gallery-panel")];
        const active = panels[0];
        const body = active?.querySelector<HTMLElement>(".gallery-panel-body");
        const raw = body === null || body === undefined ? "" : getComputedStyle(body).gridTemplateColumns;
        const width = active?.clientWidth ?? 0;
        return {
          count: panels.length,
          controls: surface.querySelectorAll("button,input,textarea,select,[role=switch],[role=radio]").length,
          // A single-column panel does not have to BE a grid — at narrow widths the body stacks
          // as a flex/block column and `grid-template-columns` computes to `none`. That is one
          // column, not zero; only a real track list reports more.
          columns: raw === "" || raw === "none" ? 1 : raw.trim().split(/\s+/).length,
          expected: wideInputs && width >= 66 * rootRem ? 3 : width >= 42 * rootRem ? 2 : 1,
        };
      }, section === "Inputs");
      if (panel.count !== 1) {
        errors.push(`${entry.name} gallery: section ${section} rendered ${panel.count} panel(s), expected exactly 1`);
        continue; // geometry below is meaningless without exactly one panel to measure
      }
      sectionsRendered += 1;
      totalControls += panel.controls;
      if (panel.columns !== panel.expected) {
        errors.push(`${entry.name} gallery: ${section} grid has ${panel.columns} columns, expected ${panel.expected}`);
      }
    }
    if (sectionsRendered !== SECTIONS.length) {
      errors.push(`${entry.name} gallery: only ${sectionsRendered} of ${SECTIONS.length} sections rendered a panel`);
    }
    if (totalControls < 20) {
      errors.push(`${entry.name} gallery: only ${totalControls} interactive controls rendered across all sections`);
    }
    // Back to a pristine default section for the interaction states and the screenshot — by
    // RELOAD rather than a rail click. Clicking sets the input modality to pointer, and
    // `:focus-visible` then correctly refuses to match the programmatic focus the desktop case
    // asserts below; a reload leaves no modality at all.
    await matrixPage.reload({ waitUntil: "networkidle" });
    await gallery.waitFor({ state: "visible", timeout: 8000 });

    if (entry.name === "tablet") {
      // The filter chips live in Controls (the default section); the text field lives in Inputs.
      // Each has to be asserted before moving on — after the tab switch the chip no longer
      // exists to be read back.
      const openFilter = gallery.locator('.dsx-chip[aria-pressed]', { hasText: /^Open$/ }).first();
      await openFilter.click();
      if ((await openFilter.getAttribute("aria-pressed")) !== "true") {
        errors.push("tablet gallery: selected filter state did not render");
      }

      await gallery.locator('.gallery-rail-target[aria-label="Inputs"]').click();
      const projectName = gallery.getByLabel("Project name");
      await projectName.fill("Aurora workspace");
      if ((await projectName.inputValue()) !== "Aurora workspace") {
        errors.push("tablet gallery: populated text-field state did not persist");
      }
      await gallery.locator(".gallery-panel-inputs").scrollIntoViewIfNeeded();
    } else if (entry.name === "desktop") {
      const focusTarget = gallery.locator('.dsx-button[data-dsx-variant="prominent"]').first();
      const hoverTarget = gallery.locator(".gallery-pressable").first();
      await focusTarget.focus();
      await hoverTarget.hover();
      const interactionState = await gallery.evaluate((surface) => ({
        focusVisible: surface.querySelector('.dsx-button[data-dsx-variant="prominent"]')?.matches(":focus-visible") ?? false,
        hovered: surface.querySelector(".gallery-pressable")?.matches(":hover") ?? false,
      }));
      if (!interactionState.focusVisible) errors.push("desktop gallery: keyboard focus state is not visible");
      if (!interactionState.hovered) errors.push("desktop gallery: precision-pointer hover state did not activate");
    }

    // Whole-surface properties, measured on whichever section the interaction block left active.
    // Per-panel grid geometry is covered by the section walk above.
    const galleryAudit = await gallery.evaluate((surface) => {
      const scrollSurface = surface.closest(".dsx-scroll") as HTMLElement | null;
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        surfaceOverflow: scrollSurface === null ? 0 : scrollSurface.scrollWidth - scrollSurface.clientWidth,
        prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
      };
    });
    if (galleryAudit.documentOverflow > 1 || galleryAudit.surfaceOverflow > 1) {
      errors.push(`${entry.name} gallery: horizontal overflow document=${galleryAudit.documentOverflow}px surface=${galleryAudit.surfaceOverflow}px`);
    }
    if (galleryAudit.prefersDark !== (entry.colorScheme === "dark")) {
      errors.push(`${entry.name} gallery: requested ${entry.colorScheme} theme did not reach the page`);
    }
    await matrixPage.screenshot({
      path: join(outDir, `matrix-gallery-${entry.name}.png`),
      fullPage: false,
      animations: "disabled",
      caret: "hide",
    });
    console.log(`✓ ${entry.name} Gallery: responsive grid, ${entry.colorScheme} theme, states, and screenshot`);
    await context.close();
  }

  // Keyboard-only routing: a launcher row must accept focus and Enter without a
  // pointer. This protects desktop, hardware-keyboard iPad, and switch-control
  // users from a visually-correct but pointer-only row implementation.
  const keyboardPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  keyboardPage.on("pageerror", (e) => errors.push(`keyboard pageerror: ${e.message}`));
  await keyboardPage.goto(`http://localhost:${port}/demo/site/`, { waitUntil: "networkidle" });
  const flexControl = keyboardPage.locator(".dsx-list .dsx-row", { hasText: "Flex layout" }).first().getByRole("button");
  await flexControl.focus();
  if (!(await flexControl.evaluate((el) => el === document.activeElement))) {
    errors.push("keyboard: launcher control did not accept focus");
  } else {
    await keyboardPage.keyboard.press("Enter");
    await keyboardPage.waitForTimeout(250);
    if (!new URL(keyboardPage.url()).pathname.endsWith("/flex")) errors.push(`keyboard: Enter did not route to /flex (${keyboardPage.url()})`);
    else console.log("✓ keyboard-only launcher focus + Enter routed to /flex");
  }
  await keyboardPage.close();

  // Repeated-action stress: an even number of state flips must converge back to
  // the original label with no lost updates or action-queue corruption.
  const stressPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  stressPage.on("pageerror", (e) => errors.push(`stress pageerror: ${e.message}`));
  await stressPage.goto(`http://localhost:${port}/demo/site/flex`, { waitUntil: "networkidle" });
  const stressFlip = stressPage.getByRole("button", { name: /Flip flex-direction/ });
  const stressBefore = (await stressFlip.textContent())?.trim() ?? "";
  for (let i = 0; i < 100; i += 1) await stressFlip.click();
  const stressAfter = (await stressFlip.textContent())?.trim() ?? "";
  if (stressAfter !== stressBefore) errors.push(`100-tap stress did not converge: "${stressBefore}" → "${stressAfter}"`);
  else console.log("✓ 100-action tap stress converged with no lost state updates");
  await stressPage.close();

  // Offline floor: after installation/activation, both the shell and a routed
  // page must reload while the selected browser engine is fully offline.
  const offlineContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  const offlinePage = await offlineContext.newPage();
  offlinePage.on("pageerror", (e) => errors.push(`offline pageerror: ${e.message}`));
  await offlinePage.goto(`http://localhost:${port}/demo/site/`, { waitUntil: "networkidle" });
  await offlinePage.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("service workers unavailable");
    await navigator.serviceWorker.ready;
  });
  // One controlled online reload guarantees the active worker owns the client
  // before the network is removed.
  await offlinePage.reload({ waitUntil: "networkidle" });
  const offlineState = await offlinePage.evaluate(async () => {
    const meta = await caches.open("dsx-meta");
    const current = await meta.match("/__dsx_current__");
    return {
      controlled: navigator.serviceWorker.controller !== null,
      current: current === undefined ? null : await current.text(),
      caches: await caches.keys(),
    };
  });
  if (!offlineState.controlled || offlineState.current === null) {
    errors.push(`offline floor did not install a current generation: ${JSON.stringify(offlineState)}`);
  } else {
    // Playwright WebKit's context-level offline switch and request interception
    // are implemented by Web Inspector and can block a service-worker navigation
    // before the worker sees it. Stop the local origin instead: a successful
    // reload can then only come from the active worker/cache. Chromium/Firefox
    // keep the engine-native offline switch.
    if (engine === "webkit") {
      await close();
      serverClosed = true;
    } else {
      await offlineContext.setOffline(true);
    }
    try {
      await offlinePage.reload({ waitUntil: "domcontentloaded" });
      await offlinePage.waitForSelector(".dsx-list .dsx-row", { timeout: 8000 });
      await offlinePage.goto(`http://localhost:${port}/demo/site/flex`, { waitUntil: "domcontentloaded" });
      await offlinePage.waitForSelector('[data-dsx-owner="Flex"]', { timeout: 8000 });
      console.log("✓ service-worker floor reloaded shell + /flex fully offline");
    } catch (e) {
      errors.push(`offline floor reload failed with generation ${offlineState.current}: ${String(e)}`);
    }
  }
  await offlineContext.close();
} finally {
  await browser.close();
  if (!serverClosed) await close();
}

const fatal = errors.filter((e) => !e.includes("favicon"));
if (fatal.length > 0) {
  console.error(`✗ ${fatal.length} page error(s):`);
  for (const e of fatal) console.error("  " + e);
  process.exit(1);
}
console.log(`\nall pages [${engine}] green → ${outDir}`);
