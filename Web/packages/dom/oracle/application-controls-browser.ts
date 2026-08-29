// Real-engine release gate for DSX application chrome. The same bundled harness
// runs in Chromium, Firefox and WebKit through DSX_BROWSER.

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="application-harness">
  <head>
    <variable as="drawerOpen">return false</variable>
    <variable as="vars">return {
      selected: 0,
      dark: false,
      tint: "accent",
      items: [
        { id: "home", name: "Home", icon: "star" },
        { id: "search", name: "Search", icon: "heart" },
        { id: "settings", name: "Settings", icon: "gear" },
        { id: "disabled", name: "Disabled", icon: "bell", disabled: true }
      ]
    }</variable>
    <variable as="selects">return 0</variable>
    <variable as="closes">return 0</variable>
    <variable as="lastId">return ""</variable>
    <variable as="nestedOpen">return false</variable>
    <variable as="nestedClicks">return 0</variable>
    <variable as="topOpen">return false</variable>
  </head>
  <button class="outside" label="Outside"/>
  <button class="drawer-trigger" label="Open drawer" on:tap="dsx.variable.drawerOpen = true"/>
  <Drawer class="override-drawer" present="drawerOpen" a11yLabel="Project drawer"
    on:close="dsx.variable.closes = dsx.variable.closes + 1">
    <textfield class="drawer-field" bind="lastId" placeholder="Project name"/>
    <popover present="nestedOpen">
      <button class="nested-trigger" label="Open details" on:tap="dsx.variable.nestedOpen = true"/>
      <vstack slot="content"><button class="nested-hidden" label="Hidden action"/><button class="nested-action" label="Use details" on:tap="dsx.variable.nestedClicks = dsx.variable.nestedClicks + 1; dsx.variable.nestedOpen = false"/></vstack>
    </popover>
    <button class="drawer-action" label="Continue"/>
  </Drawer>
  <MenuBar class="override-menu" selected="2"
    on:select="dsx.variable.selects = dsx.variable.selects + 1; dsx.variable.lastId = dsx.this.id"/>
  <popover present="topOpen">
    <button class="top-trigger" label="Open top" on:tap="dsx.variable.topOpen = true"/>
    <vstack slot="content"><button class="top-action" label="Top action"/></vstack>
  </popover>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "@despia-native/compiler/component";
  import { LAYER_STATEMENT } from "@despia-native/compiler/cssmap";
  import { instantiate } from "@despia-native/dom/mount";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS } from "@despia-native/dom/theme";
  import { APPLICATION_CONTROLS_CSS, registerApplicationControls } from "@despia-native/dom/application-controls";
  import { OVERLAY_CONTROLS_CSS, registerOverlayControls } from "@despia-native/dom/overlay-controls";
  import { ROUTE_CHROME_CSS } from "./packages/dom/src/route-chrome-style.ts";

  const presentationListeners = new Set<unknown>();
  const originalDocumentAdd = document.addEventListener.bind(document);
  const originalDocumentRemove = document.removeEventListener.bind(document);
  (document as any).addEventListener = (type: string, listener: unknown, options?: unknown) => {
    if (type === "keydown" || type === "focusin") presentationListeners.add(listener);
    return originalDocumentAdd(type as any, listener as any, options as any);
  };
  (document as any).removeEventListener = (type: string, listener: unknown, options?: unknown) => {
    if (type === "keydown" || type === "focusin") presentationListeners.delete(listener);
    return originalDocumentRemove(type as any, listener as any, options as any);
  };

  registerApplicationControls();
  registerOverlayControls();
  const ir = compileComponent("ApplicationBrowser", "test", ${JSON.stringify(markup)});
  const registry = { components: { "test.ApplicationBrowser": ir }, globalPool: {}, css: "", schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, OVERLAY_CONTROLS_CSS, APPLICATION_CONTROLS_CSS, ROUTE_CHROME_CSS,
    ".application-harness { box-sizing:border-box; gap:12px; width:min(100%,64rem); min-height:100vh; padding:24px; margin:auto; } .override-drawer .dsx-drawer-panel { border-radius:7px 7px 0 0; } .override-menu { --dsx-menu-bar-surface:var(--dsx-secondary-background); }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  const routeBar = document.createElement("div");
  routeBar.className = "dsx-route-chrome";
  routeBar.textContent = "Route chrome";
  document.body.replaceChildren(routeBar, instance.root);
  window.__dsxApplicationRead = (expression) => instance.ctx.store.eval(expression, null);
  window.__dsxApplicationSet = (name, value) => instance.ctx.store.set(name, value);
  window.__dsxPresentationListenerCount = () => presentationListeners.size;
  window.__DSX_APPLICATION_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "application-controls-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("application controls browser harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  // 1024 = 64rem: desktop-compact chrome, still BELOW the 69rem standing/bar step,
  // so the modal-drawer and dock phases below exercise the compact presentations.
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  await page.setContent("<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_APPLICATION_READY__?: boolean }).__DSX_APPLICATION_READY__ === true);

  const read = async (expression: string): Promise<unknown> => await page.evaluate((value) =>
    (window as unknown as { __dsxApplicationRead: (expr: string) => unknown }).__dsxApplicationRead(value), expression);
  const set = async (name: string, value: unknown): Promise<void> => { await page.evaluate(([key, next]) =>
    (window as unknown as { __dsxApplicationSet: (name: string, value: unknown) => void }).__dsxApplicationSet(key as string, next), [name, value]); };
  const presentationListenerCount = async (): Promise<number> => await page.evaluate(() =>
    (window as unknown as { __dsxPresentationListenerCount: () => number }).__dsxPresentationListenerCount());

  if (await presentationListenerCount() !== 0) errors.push("dormant presentation controls installed document listeners");

  const outside = page.locator(".outside");
  await outside.focus();
  await set("drawerOpen", true);
  const drawer = page.locator(".dsx-drawer-panel");
  await drawer.waitFor({ state: "visible" });
  const openState = await page.evaluate(() => ({
    role: document.querySelector(".dsx-drawer-panel")?.getAttribute("role"),
    layerRole: document.querySelector(".dsx-drawer-layer")?.getAttribute("role"),
    modal: document.querySelector(".dsx-drawer-panel")?.getAttribute("aria-modal"),
    activeInside: document.querySelector(".dsx-drawer-panel")?.contains(document.activeElement) ?? false,
    outsideInert: (() => {
      let current = document.querySelector(".outside") as HTMLElement | null;
      while (current !== null) { if (current.inert) return true; current = current.parentElement; }
      return false;
    })(),
    overflow: document.documentElement.style.overflow,
    radius: getComputedStyle(document.querySelector(".dsx-drawer-panel")!).borderTopLeftRadius,
    overlayZ: Number.parseInt(getComputedStyle(document.querySelector(".dsx-drawer-layer")!).zIndex, 10),
    routeZ: Number.parseInt(getComputedStyle(document.querySelector(".dsx-route-chrome")!).zIndex, 10),
  }));
  if (openState.role !== "dialog" || openState.modal !== "true" || openState.layerRole !== "presentation") errors.push("Drawer lacks modal dialog semantics");
  if (!openState.activeInside) errors.push("Drawer did not take focus");
  if (!openState.outsideInert) errors.push("Drawer did not inert its background branch");
  if (openState.overflow !== "hidden") errors.push("Drawer did not lock document scrolling");
  if (openState.radius !== "7px") errors.push(`ordinary author CSS did not override Drawer (${openState.radius})`);
  if (!(openState.overlayZ > openState.routeZ)) errors.push(`Drawer did not clear route chrome (${openState.overlayZ} <= ${openState.routeZ})`);
  if (await presentationListenerCount() !== 2) errors.push("open Drawer did not own exactly two shared document listeners");

  const nestedTrigger = page.locator(".nested-trigger");
  await page.locator(".nested-hidden").evaluate((element) => { (element as HTMLElement).hidden = true; });
  await nestedTrigger.click();
  const nestedPopover = page.locator(".dsx-popover-panel:has(.nested-action)");
  await nestedPopover.waitFor({ state: "visible" });
  const nestedState = await page.evaluate(() => {
    const panel = document.querySelector(".dsx-popover-panel:has(.nested-action)") as HTMLElement | null;
    let current: HTMLElement | null = panel;
    let inert = false;
    let hidden = false;
    while (current !== null) {
      inert ||= current.inert;
      hidden ||= current.getAttribute("aria-hidden") === "true";
      current = current.parentElement;
    }
    const trigger = document.querySelector(".nested-trigger");
    return {
      inert,
      hidden,
      activeInside: panel?.contains(document.activeElement) ?? false,
      focusedClass: (document.activeElement as HTMLElement | null)?.className ?? "",
      expanded: trigger?.getAttribute("aria-expanded"),
      popup: trigger?.getAttribute("aria-haspopup"),
    };
  });
  if (nestedState.inert || nestedState.hidden) errors.push("Drawer made its foreground popover inert/hidden");
  if (!nestedState.activeInside) errors.push("Drawer redirected focus away from its foreground popover");
  if (!nestedState.focusedClass.includes("nested-action")) errors.push("overlay focus chose a hidden descendant");
  if (nestedState.expanded !== "true" || nestedState.popup !== "dialog") errors.push("nested popover trigger ARIA is incomplete");
  if (await presentationListenerCount() !== 4) errors.push("nested presentation listener ownership is not depth-bounded");
  await page.locator(".nested-action").click();
  await page.waitForTimeout(25);
  if (await read("dsx.variable.nestedClicks") !== 1 || await read("dsx.variable.nestedOpen") !== false) {
    errors.push("foreground popover inside Drawer was not clickable/dismissible");
  }
  if (!await nestedTrigger.evaluate((element) => document.activeElement === element)) {
    errors.push("nested popover did not restore focus inside Drawer");
  }
  if (await presentationListenerCount() !== 2) errors.push("closing nested popover leaked document listeners");

  await page.locator(".drawer-action").focus();
  await page.locator(".drawer-action").press("Tab");
  if (!await page.evaluate(() => document.querySelector(".dsx-drawer-panel")?.contains(document.activeElement) ?? false)) {
    errors.push("Tab escaped the Drawer focus boundary");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(25);
  if (await read("dsx.variable.drawerOpen") !== false) errors.push("Escape did not write Drawer present=false");
  if (await read("dsx.variable.closes") !== 1) errors.push("Escape did not emit one Drawer close event");
  if (!await outside.evaluate((element) => document.activeElement === element)) errors.push("Drawer did not restore prior focus");
  if (await page.evaluate(() => document.documentElement.style.overflow) !== "") errors.push("Drawer did not restore document scrolling");
  if (await presentationListenerCount() !== 0) errors.push("closing Drawer leaked document listeners");

  await set("drawerOpen", true);
  await drawer.waitFor({ state: "visible" });
  await page.locator(".dsx-drawer-scrim").click({ position: { x: 3, y: 3 } });
  await page.waitForTimeout(25);
  if (await read("dsx.variable.drawerOpen") !== false || await read("dsx.variable.closes") !== 2) {
    errors.push("outside dismissal did not close Drawer exactly once");
  }

  await set("drawerOpen", true);
  await drawer.waitFor({ state: "visible" });
  const handle = page.locator(".dsx-drawer-handle");
  const handleBox = await handle.boundingBox();
  if (handleBox === null) errors.push("Drawer handle has no layout box");
  else {
    const x = handleBox.x + handleBox.width / 2;
    const y = handleBox.y + handleBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, Math.min(y + 160, 895), { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(25);
    if (await read("dsx.variable.drawerOpen") !== false || await read("dsx.variable.closes") !== 3) {
      const drag = await drawer.evaluate((element) => ({
        offset: (element as HTMLElement).style.getPropertyValue("--dsx-drawer-drag-y"),
        dragging: element.getAttribute("data-dsx-dragging"),
      }));
      errors.push(`Drawer did not close beyond its 120px drag threshold (${JSON.stringify(drag)})`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(25);
    }
  }

  // Closing an underlying modal must compact the shared level ledger while the
  // foreground popover survives; a subsequent popover must still stack above it.
  await set("drawerOpen", true);
  await drawer.waitFor({ state: "visible" });
  await nestedTrigger.click();
  await nestedPopover.waitFor({ state: "visible" });
  await set("drawerOpen", false);
  await page.waitForTimeout(25);
  await set("topOpen", true);
  const topPopover = page.locator(".dsx-popover-panel:has(.top-action)");
  await topPopover.waitFor({ state: "visible" });
  const stackState = await page.evaluate(() => {
    const nested = document.querySelector(".nested-action")?.closest<HTMLElement>(".dsx-popover-layer");
    const top = document.querySelector(".top-action")?.closest<HTMLElement>(".dsx-popover-layer");
    return {
      nestedVisible: nested?.hidden === false,
      nestedLevel: nested?.style.getPropertyValue("--dsx-overlay-level"),
      topLevel: top?.style.getPropertyValue("--dsx-overlay-level"),
      nestedZ: nested === null || nested === undefined ? 0 : Number.parseInt(getComputedStyle(nested).zIndex, 10),
      topZ: top === null || top === undefined ? 0 : Number.parseInt(getComputedStyle(top).zIndex, 10),
    };
  });
  if (!stackState.nestedVisible || stackState.nestedLevel !== "1" || stackState.topLevel !== "2"
      || !(stackState.topZ > stackState.nestedZ)) {
    errors.push(`overlay levels were not compact/strict after underlying Drawer close (${JSON.stringify(stackState)})`);
  }
  await set("topOpen", false);
  await set("nestedOpen", false);
  await page.waitForTimeout(25);

  const menu = page.locator(".dsx-menu-bar");
  const menuItems = menu.locator(".dsx-menu-bar-item");
  if (await menu.getAttribute("aria-label") !== "Primary navigation") errors.push("MenuBar navigation label missing");
  if (await menu.getAttribute("data-dsx-tone") !== "light"
      || await menu.evaluate((element) => (element as HTMLElement).style.getPropertyValue("--dsx-menu-bar-tint").trim()) !== "var(--dsx-accent)") {
    errors.push("attribute-less MenuBar did not consume seeded dark/tint values");
  }
  if (await menu.locator("[role=menubar]").count() !== 1 || await menuItems.count() !== 4
      || await menu.locator("[role=menubar]").getAttribute("aria-label") !== "Primary navigation") {
    errors.push("MenuBar ARIA ownership/item count is wrong");
  }
  if (await menuItems.nth(0).getAttribute("aria-current") !== "page" || await menuItems.nth(0).getAttribute("tabindex") !== "0") {
    errors.push("MenuBar surface-state selection (and selected= attr isolation) is wrong");
  }
  await menuItems.nth(2).click();
  await page.waitForTimeout(25);
  if (await read("dsx.variable.selected") !== 2 || await read("dsx.variable.selects") !== 1 || await read("dsx.variable.lastId") !== "settings") {
    errors.push("MenuBar pointer selection did not write/emit the selected item");
  }
  await menuItems.nth(2).press("ArrowRight");
  await page.waitForTimeout(25);
  if (await read("dsx.variable.selected") !== 0) errors.push("MenuBar ArrowRight did not wrap past a disabled item");

  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  // The pill intentionally animates geometry changes for 240ms.
  await page.waitForTimeout(300);
  const rtlPillAlignment = await page.evaluate(() => {
    const pill = document.querySelector<HTMLElement>(".dsx-menu-bar-pill")?.getBoundingClientRect();
    const activeElement = document.querySelector<HTMLElement>('.dsx-menu-bar-item[data-dsx-selected="true"]');
    const active = activeElement?.getBoundingClientRect();
    const pillElement = document.querySelector<HTMLElement>(".dsx-menu-bar-pill");
    return {
      error: pill === undefined || active === undefined
        ? 999
        : Math.abs((pill.left + pill.width / 2) - (active.left + active.width / 2)),
      pillLeft: pill?.left,
      activeLeft: active?.left,
      activeOffset: activeElement?.offsetLeft,
      x: pillElement?.style.getPropertyValue("--dsx-menu-bar-pill-x"),
    };
  });
  if (rtlPillAlignment.error > 1) errors.push(`MenuBar pill did not follow live RTL geometry (${JSON.stringify(rtlPillAlignment)})`);
  await menuItems.nth(0).focus();
  await menuItems.nth(0).press("ArrowRight");
  await page.waitForTimeout(25);
  const rtlSelection = await read("dsx.variable.selected");
  if (rtlSelection !== 2) {
    const direction = await menu.locator("[role=menubar]").evaluate((element) => getComputedStyle(element).direction);
    errors.push(`MenuBar ArrowRight did not mirror in RTL (selected=${String(rtlSelection)}, direction=${direction})`);
  }
  await page.evaluate(() => { document.documentElement.dir = ""; });

  await menuItems.nth(1).focus();
  await menuItems.nth(1).evaluate((element) => { (element as HTMLElement).dataset["identity"] = "preserved"; });
  await set("items", [
    { id: "settings", name: "Settings updated", icon: "gear" },
    { id: "search", name: "Search", icon: "heart" },
    { id: "home", name: "Home", icon: "star" },
  ]);
  await page.waitForTimeout(35);
  const keyed = await page.evaluate(() => ({
    identity: document.querySelector('[data-dsx-key="search:0"]')?.getAttribute("data-identity"),
    focused: (document.activeElement as HTMLElement | null)?.dataset["dsxKey"],
  }));
  if (keyed.identity !== "preserved" || keyed.focused !== "search:0") errors.push("MenuBar keyed update lost DOM identity/focus");

  await set("drawerOpen", true);
  await drawer.waitFor({ state: "visible" });
  await page.waitForTimeout(35);
  const desktop = await page.evaluate(() => {
    const bar = document.querySelector(".dsx-menu-bar")!;
    const item = document.querySelector(".dsx-menu-bar-item")!;
    const pill = document.querySelector(".dsx-menu-bar-pill")!;
    const panel = document.querySelector(".dsx-drawer-panel")!;
    return {
      fine: matchMedia("(hover: hover) and (pointer: fine)").matches,
      itemHeight: item.getBoundingClientRect().height,
      direction: getComputedStyle(item).flexDirection,
      pillWidth: pill.getBoundingClientRect().width,
      pillHeight: pill.getBoundingClientRect().height,
      menuOverflow: bar.scrollWidth - bar.clientWidth,
      drawerWidth: panel.getBoundingClientRect().width,
    };
  });
  if (desktop.fine && (desktop.itemHeight < 37 || desktop.itemHeight > 41 || desktop.direction !== "row")) {
    errors.push(`desktop MenuBar is not compact (${desktop.itemHeight}px, ${desktop.direction})`);
  }
  if (desktop.pillWidth <= 0 || desktop.pillHeight <= 0) errors.push("MenuBar selection pill was not measured");
  if (desktop.menuOverflow > 1) errors.push(`MenuBar overflowed its desktop surface by ${desktop.menuOverflow}px`);
  if (desktop.drawerWidth > 514) errors.push(`desktop Drawer is not compact (${desktop.drawerWidth}px)`);

  await page.setViewportSize({ width: 820, height: 800 });
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".override-drawer");
    host?.setAttribute("dir", "rtl");
    host?.setAttribute("lang", "ar");
    host?.style.setProperty("--dsx-portal-probe", "17px");
  });
  await page.waitForTimeout(35);
  const scoped = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".dsx-drawer-panel");
    const scope = document.querySelector<HTMLElement>(".dsx-drawer-layer")?.parentElement;
    const bounds = panel?.getBoundingClientRect();
    return {
      direction: scope === null || scope === undefined ? "" : getComputedStyle(scope).direction,
      dir: scope?.dir,
      lang: scope?.lang,
      probe: scope?.style.getPropertyValue("--dsx-portal-probe") ?? "",
      centerError: bounds === undefined ? 999 : Math.abs((bounds.left + bounds.width / 2) - innerWidth / 2),
    };
  });
  if (scoped.direction !== "rtl" || scoped.dir !== "rtl" || scoped.lang !== "ar"
      || scoped.probe.trim() !== "17px" || scoped.centerError > 1) {
    errors.push(`Drawer portal did not preserve live RTL/language/tokens and physical centering (${JSON.stringify(scoped)})`);
  }
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".override-drawer");
    host?.removeAttribute("dir");
    host?.removeAttribute("lang");
    host?.style.removeProperty("--dsx-portal-probe");
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(() => ({
    drawer: getComputedStyle(document.querySelector(".dsx-drawer-panel")!).transitionDuration,
    pill: getComputedStyle(document.querySelector(".dsx-menu-bar-pill")!).transitionDuration,
  }));
  if (reduced.drawer !== "0s" || reduced.pill !== "0s") errors.push("reduced motion did not disable application chrome transitions");

  await page.setViewportSize({ width: 320, height: 780 });
  await page.waitForTimeout(35);
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    target: document.querySelector(".dsx-menu-bar-item")?.getBoundingClientRect().height ?? 0,
    drawerWidth: document.querySelector(".dsx-drawer-panel")?.getBoundingClientRect().width ?? 0,
  }));
  if (mobile.overflow > 1) errors.push(`320px application chrome overflowed by ${mobile.overflow}px`);
  if (mobile.target < 44) errors.push(`mobile MenuBar target is ${mobile.target}px (<44px)`);
  if (mobile.drawerWidth < 318 || mobile.drawerWidth > 321) errors.push(`mobile Drawer width is ${mobile.drawerWidth}px`);

  await set("drawerOpen", false);
  await page.waitForTimeout(25);
  if (await presentationListenerCount() !== 0) errors.push("application-control teardown left document listeners active");

  // ── THE DESKTOP STEP (>= 69rem, fine pointer): standing drawer + menubar ──
  // (reduced motion stays emulated from the phase above, deliberately: geometry
  // assertions read final values without waiting out width transitions.)
  await page.emulateMedia({ reducedMotion: "reduce" });
  const closesBefore = await read("dsx.variable.closes");
  await page.setViewportSize({ width: 1280, height: 900 });
  // Same engine-capability gate as the desktop dock checks above: an engine that
  // reports no fine hover pointer keeps the compact presentations by design.
  const wideCapable = await page.evaluate(() => matchMedia("(min-width: 69rem) and (hover: hover) and (pointer: fine)").matches);
  if (!wideCapable) console.log(`[${engine}] no fine hover pointer reported; standing/bar phase verified on engines that have one`);
  if (wideCapable) {
  await set("drawerOpen", true);
  await page.waitForTimeout(40);
  const standingState = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".dsx-drawer-host");
    const panel = document.querySelector<HTMLElement>(".dsx-drawer-panel");
    const layer = document.querySelector<HTMLElement>(".dsx-drawer-layer");
    const scrim = document.querySelector<HTMLElement>(".dsx-drawer-scrim");
    return {
      presentation: host?.getAttribute("data-dsx-presentation"),
      hostRole: host?.getAttribute("role"),
      role: panel?.getAttribute("role"),
      modal: panel?.getAttribute("aria-modal"),
      layerPosition: layer === null ? "" : getComputedStyle(layer).position,
      scrimDisplay: scrim === null ? "" : getComputedStyle(scrim).display,
      width: Math.round(host?.getBoundingClientRect().width ?? 0),
      overflow: document.documentElement.style.overflow,
      inBody: layer?.parentElement?.classList.contains("dsx-drawer-host") === true,
    };
  });
  if (standingState.presentation !== "standing" || standingState.role !== "complementary" || standingState.modal !== null) {
    errors.push(`standing drawer semantics are wrong (${JSON.stringify(standingState)})`);
  }
  if (standingState.hostRole !== "group") errors.push("drawer host span lost its honest group role");
  if (standingState.layerPosition !== "static" || standingState.scrimDisplay !== "none" || !standingState.inBody) {
    errors.push(`standing drawer did not leave the overlay plane (${JSON.stringify(standingState)})`);
  }
  if (standingState.width !== 288) errors.push(`standing drawer default width is ${standingState.width}px (wanted 288)`);
  if (standingState.overflow !== "") errors.push("standing drawer locked document scrolling");
  if (await presentationListenerCount() !== 0) errors.push("standing drawer installed modal document listeners");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(25);
  if (await read("dsx.variable.drawerOpen") !== true) errors.push("Escape dismissed the standing (non-modal) drawer");

  const resizerHandle = page.locator(".dsx-drawer-resizer");
  await resizerHandle.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(30);
  let standingWidth = await page.evaluate(() => Math.round(document.querySelector(".dsx-drawer-host")!.getBoundingClientRect().width));
  if (standingWidth !== 304) errors.push(`keyboard resize step landed at ${standingWidth}px (wanted 304)`);
  await page.keyboard.press("End");
  await page.waitForTimeout(30);
  standingWidth = await page.evaluate(() => Math.round(document.querySelector(".dsx-drawer-host")!.getBoundingClientRect().width));
  if (standingWidth !== 480) errors.push(`End did not clamp the standing drawer to max (${standingWidth}px)`);
  if (await resizerHandle.getAttribute("aria-valuenow") !== "480"
      || await resizerHandle.getAttribute("aria-valuemin") !== "200"
      || await resizerHandle.getAttribute("role") !== "separator") {
    errors.push("resizer separator value semantics are wrong");
  }
  await page.keyboard.press("Home");
  await page.waitForTimeout(30);
  const resizerBox = await resizerHandle.boundingBox();
  if (resizerBox === null) errors.push("standing resizer has no layout box");
  else {
    const grabY = resizerBox.y + resizerBox.height / 2;
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, grabY);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x + resizerBox.width / 2 + 60, grabY, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(30);
    standingWidth = await page.evaluate(() => Math.round(document.querySelector(".dsx-drawer-host")!.getBoundingClientRect().width));
    if (Math.abs(standingWidth - 260) > 2) errors.push(`drag resize landed at ${standingWidth}px (wanted ~260)`);
    if (await page.evaluate(() => document.querySelector(".dsx-drawer-host")?.hasAttribute("data-dsx-resizing"))) {
      errors.push("resize release left the dragging state");
    }
  }

  const collapseControl = page.locator(".dsx-drawer-collapse");
  await collapseControl.click();
  await page.waitForTimeout(320);
  const railState = await page.evaluate(() => ({
    collapsed: document.querySelector(".dsx-drawer-host")?.getAttribute("data-dsx-collapsed"),
    width: Math.round(document.querySelector(".dsx-drawer-host")!.getBoundingClientRect().width),
    contentHidden: (document.querySelector(".dsx-drawer-content") as HTMLElement | null)?.hidden,
    expanded: document.querySelector(".dsx-drawer-collapse")?.getAttribute("aria-expanded"),
  }));
  if (railState.collapsed !== "true" || railState.width !== 56 || railState.contentHidden !== true || railState.expanded !== "false") {
    errors.push(`collapse-to-rail state is wrong (${JSON.stringify(railState)})`);
  }
  await collapseControl.click();
  await page.waitForTimeout(320);
  if (await page.evaluate(() => Math.round(document.querySelector(".dsx-drawer-host")!.getBoundingClientRect().width)) !== 260) {
    errors.push("expanding the rail did not restore the resized width");
  }

  await set("drawerOpen", false);
  await page.waitForTimeout(25);
  if (await page.evaluate(() => getComputedStyle(document.querySelector(".dsx-drawer-host")!).display) !== "none") {
    errors.push("present=false did not hide the standing drawer");
  }
  await set("drawerOpen", true);
  await page.waitForTimeout(25);
  if (await read("dsx.variable.closes") !== closesBefore) {
    errors.push("presentation swaps or standing visibility emitted phantom close events");
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForTimeout(40);
  const backToModal = await page.evaluate(() => ({
    presentation: document.querySelector(".dsx-drawer-host")?.getAttribute("data-dsx-presentation"),
    role: document.querySelector(".dsx-drawer-panel")?.getAttribute("role"),
    modal: document.querySelector(".dsx-drawer-panel")?.getAttribute("aria-modal"),
    activeInside: document.querySelector(".dsx-drawer-panel")?.contains(document.activeElement) ?? false,
  }));
  if (backToModal.presentation !== "modal" || backToModal.role !== "dialog" || backToModal.modal !== "true" || !backToModal.activeInside) {
    errors.push(`narrowing did not re-present the open drawer modally (${JSON.stringify(backToModal)})`);
  }
  if (await read("dsx.variable.closes") !== closesBefore) errors.push("the standing->modal swap emitted a phantom close");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(25);
  if (await read("dsx.variable.drawerOpen") !== false) errors.push("modal drawer did not dismiss after the presentation round-trip");

  // ── the WAI-ARIA menubar presentation ──
  await page.setViewportSize({ width: 1280, height: 900 });
  await set("items", [
    {
      id: "file", name: "File",
      items: [
        { title: "New note", shortcut: "cmd+n" },
        { separator: true },
        { title: "Export", items: [{ title: "Markdown" }, { title: "PDF" }] },
      ],
    },
    { id: "edit", name: "Edit", items: [{ title: "Undo", shortcut: "cmd+z" }] },
    { id: "home", name: "Home", icon: "star" },
  ]);
  await page.waitForTimeout(40);
  const barState = await page.evaluate(() => {
    const bar = document.querySelector(".dsx-menu-bar");
    const roots = [...document.querySelectorAll<HTMLElement>(".dsx-menu-bar-item")];
    return {
      presentation: bar?.getAttribute("data-dsx-presentation"),
      fileRole: roots[0]?.getAttribute("role"),
      filePopup: roots[0]?.getAttribute("aria-haspopup"),
      homeRole: roots[2]?.getAttribute("role"),
      fileIconHidden: (roots[0]?.querySelector(".dsx-menu-bar-icon") as HTMLElement | null)?.hidden,
      homeIconHidden: (roots[2]?.querySelector(".dsx-menu-bar-icon") as HTMLElement | null)?.hidden,
    };
  });
  if (barState.presentation !== "bar" || barState.fileRole !== "menuitem" || barState.filePopup !== "menu"
      || barState.homeRole !== "menuitemradio") {
    errors.push(`menubar root semantics are wrong (${JSON.stringify(barState)})`);
  }
  if (barState.fileIconHidden !== true || barState.homeIconHidden !== false) {
    errors.push("bar presentation did not keep declared icons while dropping fallback glyphs");
  }
  // The strip is app chrome on the ambient tokens: the authored dark= tone (seeded
  // false above, consumed by the dock phase) must not pin the desktop bar's scheme.
  const barChrome = await page.evaluate(() => {
    const bar = document.querySelector(".dsx-menu-bar")!;
    const probe = document.createElement("div");
    probe.style.color = "var(--dsx-label)";
    document.body.appendChild(probe);
    const ambient = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(bar);
    return { scheme: style.colorScheme, color: style.color, ambient };
  });
  if (barChrome.scheme !== "normal" || barChrome.color !== barChrome.ambient) {
    errors.push(`bar strip does not ride ambient chrome (${JSON.stringify(barChrome)}); dark= stays a dock-only tone`);
  }
  const fileRoot = page.locator(".dsx-menu-bar-item").nth(0);
  await fileRoot.focus();
  await page.keyboard.press("ArrowDown");
  const flyout = page.locator(".dsx-menu-bar-flyout");
  await flyout.waitFor({ state: "visible" });
  const flyoutState = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".dsx-menu-bar-flyout");
    const active = document.activeElement as HTMLElement | null;
    const shortcutted = panel?.querySelector<HTMLElement>("[aria-keyshortcuts]");
    const hint = shortcutted?.querySelector<HTMLElement>(".dsx-menu-item-shortcut");
    const label = shortcutted?.querySelector<HTMLElement>(".dsx-menu-item-label");
    return {
      shadow: panel === null ? "none" : getComputedStyle(panel).boxShadow,
      focusedRole: active?.getAttribute("role"),
      focusedText: active?.textContent?.trim(),
      expanded: document.querySelector(".dsx-menu-bar-item")?.getAttribute("aria-expanded"),
      keyshortcuts: shortcutted?.getAttribute("aria-keyshortcuts") ?? "",
      hintHidden: hint?.getAttribute("aria-hidden"),
      hintRightOfLabel: hint !== null && hint !== undefined && label !== null && label !== undefined
        ? hint.getBoundingClientRect().left > label.getBoundingClientRect().right - 1 : false,
    };
  });
  if (flyoutState.shadow === "none") errors.push("menubar flyout is not elevated (no shadow-3)");
  if (flyoutState.focusedRole !== "menuitem" || flyoutState.focusedText?.startsWith("New note") !== true
      || flyoutState.expanded !== "true") {
    errors.push(`Down did not open the root flyout on its first item (${JSON.stringify(flyoutState)})`);
  }
  if (!/^(Meta|Control)\+N$/.test(flyoutState.keyshortcuts) || flyoutState.hintHidden !== "true" || !flyoutState.hintRightOfLabel) {
    errors.push(`shortcut hint plane is wrong (${JSON.stringify(flyoutState)})`);
  }
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(30);
  if (await page.evaluate(() => document.activeElement?.textContent?.trim()?.startsWith("Undo")) !== true) {
    errors.push("ArrowRight on a leaf did not hop to the next menubar root's flyout");
  }
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(30);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(30);
  if (await page.evaluate(() => document.activeElement?.textContent?.trim()) !== "Markdown") {
    errors.push("submenu keyboard walk inside the menubar flyout failed");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(30);
  const walkedUp = await page.evaluate(() => ({
    focused: document.activeElement?.textContent?.trim(),
    flyoutVisible: (document.querySelector(".dsx-menu-bar-flyout-layer") as HTMLElement | null)?.hidden === false,
  }));
  if (walkedUp.focused?.startsWith("Export") !== true || !walkedUp.flyoutVisible) {
    errors.push(`Escape did not walk up one level (${JSON.stringify(walkedUp)})`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(30);
  const closedBar = await page.evaluate(() => ({
    flyoutVisible: (document.querySelector(".dsx-menu-bar-flyout-layer") as HTMLElement | null)?.hidden === false,
    focusedRoot: (document.activeElement as HTMLElement | null)?.classList.contains("dsx-menu-bar-item"),
    expanded: document.querySelector(".dsx-menu-bar-item")?.getAttribute("aria-expanded"),
  }));
  if (closedBar.flyoutVisible || closedBar.focusedRoot !== true || closedBar.expanded !== "false") {
    errors.push(`Escape did not close the flyout back to its root (${JSON.stringify(closedBar)})`);
  }
  if (await presentationListenerCount() !== 0) errors.push("closed menubar flyout leaked document listeners");
  const selectsBefore = await read("dsx.variable.selects");
  await page.locator(".dsx-menu-bar-item").nth(2).click();
  await page.waitForTimeout(25);
  if (await read("dsx.variable.selected") !== 2 || await read("dsx.variable.selects") !== (selectsBefore as number) + 1) {
    errors.push("plain menubar root did not keep the selection contract");
  }
  }

  if (errors.length === 0) {
    console.log(`✓ [${engine}] application controls: Drawer modal+standing (rail/resize/no-phantom-close) + MenuBar dock+menubar (flyouts/shortcuts/Escape-walk) + keyboard/RTL/keyed/adaptive`);
  }
} finally {
  await browser.close();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ [${engine}] ${error}`);
  process.exit(1);
}
