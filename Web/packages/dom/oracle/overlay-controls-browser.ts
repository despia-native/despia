// Real-engine accessibility, focus, dismissal, placement and responsive-layout
// gate for DSX's declarative overlay runtime. Runs in every locked browser engine.

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="overlay-harness">
  <head>
    <variable as="showSheet">return false</variable>
    <variable as="showAlert">return false</variable>
    <variable as="showConfirm">return false</variable>
    <variable as="showPopover">return false</variable>
    <variable as="name">return "Ada"</variable>
    <variable as="dismissals">return 0</variable>
    <variable as="items">return [
      { title: "Edit" },
      { title: "More", items: [{ title: "Duplicate", shortcut: "cmd+d", action: "overlaytest.select", args: { id: 7 } }] },
      { separator: true },
      { title: "Delete", role: "destructive" }
    ]</variable>
  </head>
  <button class="outside" label="Outside"/>
  <button class="sheet-trigger" label="Open sheet" on:tap="dsx.variable.showSheet = true"/>
  <sheet class="override-sheet" present="showSheet" detents="content,half,full" background="groupedBackground" title="Workspace settings" action="Save" actionIcon="star" on:action="dsx.variable.showSheet = false" on:dismiss="dsx.variable.dismissals = dsx.variable.dismissals + 1">
    <textfield class="sheet-field" bind="name" placeholder="Name"/>
    <button class="sheet-done" label="Done" on:tap="dsx.variable.showSheet = false"/>
  </sheet>
  <alert present="showAlert" title="Saved" message="Your changes are safe" buttons="[{ label: 'OK' }]" on:dismiss="dsx.variable.dismissals = dsx.variable.dismissals + 1"/>
  <confirmDialog present="showConfirm" title="Delete item?" message="This cannot be undone" buttons="[{ label: 'Delete', role: 'destructive' }]" on:dismiss="dsx.variable.dismissals = dsx.variable.dismissals + 1"/>
  <popover present="showPopover" arrow="top" on:dismiss="dsx.variable.dismissals = dsx.variable.dismissals + 1">
    <button class="popover-trigger" label="Details" on:tap="dsx.variable.showPopover = true"/>
    <vstack slot="content"><text value="Popover details"/><button class="popover-action" label="Action"/></vstack>
  </popover>
  <menu menu="items"><button class="menu-trigger-button" label="Menu"/></menu>
  <menu class="fallback-menu" menu="items"><text class="fallback-menu-copy" value="Fallback menu"/></menu>
  <contextmenu menu="items"><button class="context-trigger-button" label="Context"/></contextmenu>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "@despia-native/compiler/component";
  import { LAYER_STATEMENT } from "@despia-native/compiler/cssmap";
  import { instantiate } from "@despia-native/dom/mount";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS } from "@despia-native/dom/theme";
  import { OVERLAY_CONTROLS_CSS, registerOverlayControls } from "@despia-native/dom/overlay-controls";
  import { ROUTE_CHROME_CSS } from "./packages/dom/src/route-chrome-style.ts";
  import { ModuleRegistry } from "@despia-native/kernel";

  registerOverlayControls();
  ModuleRegistry.register({ scheme: "overlaytest", actions: { select(ctx) { window.__overlayAction = ctx.args(); return { ok: true }; } } });
  const ir = compileComponent("OverlayBrowser", "test", ${JSON.stringify(markup)});
  const registry = { components: { "test.OverlayBrowser": ir }, globalPool: {}, css: "", schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, OVERLAY_CONTROLS_CSS, ROUTE_CHROME_CSS,
    ".overlay-harness { box-sizing:border-box; gap:12px; width:min(100%,52rem); min-height:100vh; padding:24px; margin:auto; } .override-sheet .dsx-sheet-panel { border-radius:3px 3px 0 0; } .dsx-popover-host { position:fixed; inset:auto 4px 4px auto; }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  const routeBar = document.createElement("div");
  routeBar.className = "dsx-route-chrome";
  routeBar.textContent = "Route chrome";
  document.body.replaceChildren(routeBar, instance.root);
  window.__dsxOverlayRead = (expression) => instance.ctx.store.eval(expression, null);
  window.__dsxOverlaySet = (name, value) => instance.ctx.store.set(name, value);
  window.__DSX_OVERLAY_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "overlay-controls-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("overlay controls browser harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  await page.setContent("<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_OVERLAY_READY__?: boolean }).__DSX_OVERLAY_READY__ === true);

  const read = async (expression: string): Promise<unknown> => await page.evaluate((value) =>
    (window as unknown as { __dsxOverlayRead: (expr: string) => unknown }).__dsxOverlayRead(value), expression);
  const set = async (name: string, value: unknown): Promise<void> => { await page.evaluate(([key, next]) =>
    (window as unknown as { __dsxOverlaySet: (name: string, value: unknown) => void }).__dsxOverlaySet(key as string, next), [name, value]); };

  const outside = page.locator(".outside");
  await outside.focus();
  await set("showSheet", true);
  const sheet = page.locator(".dsx-sheet-panel");
  await sheet.waitFor({ state: "visible" });
  if (await sheet.getAttribute("role") !== "dialog" || await sheet.getAttribute("aria-modal") !== "true") {
    errors.push("sheet lacks modal dialog semantics");
  }
  const sheetState = await page.evaluate(() => ({
    outsideInert: (() => {
      let current = document.querySelector(".outside") as HTMLElement | null;
      while (current !== null) { if (current.inert) return true; current = current.parentElement; }
      return false;
    })(),
    overflow: document.documentElement.style.overflow,
    activeInside: document.querySelector(".dsx-sheet-panel")?.contains(document.activeElement) ?? false,
    radius: getComputedStyle(document.querySelector(".dsx-sheet-panel")!).borderTopLeftRadius,
    overlayZ: Number.parseInt(getComputedStyle(document.querySelector(".dsx-sheet-layer")!).zIndex, 10),
    routeZ: Number.parseInt(getComputedStyle(document.querySelector(".dsx-route-chrome")!).zIndex, 10),
    topHitIsOverlay: document.elementFromPoint(12, 12)?.closest(".dsx-sheet-layer") !== null,
  }));
  if (!sheetState.outsideInert) errors.push("modal sheet did not inert its background branch");
  if (sheetState.overflow !== "hidden") errors.push("modal sheet did not lock document scrolling");
  if (!sheetState.activeInside) errors.push("modal sheet did not take focus");
  if (sheetState.radius !== "3px") errors.push(`ordinary author CSS did not override weak sheet chrome (${sheetState.radius})`);
  if (await page.locator(".dsx-sheet-action svg").count() !== 1 || (await page.locator(".dsx-sheet-action").textContent())?.trim() !== "Save") {
    errors.push("sheet action did not preserve its icon-and-label contract");
  }
  if (!(sheetState.overlayZ > sheetState.routeZ) || !sheetState.topHitIsOverlay) {
    errors.push(`modal portal did not clear route chrome stacking (${sheetState.overlayZ} <= ${sheetState.routeZ})`);
  }

  // The grabber is a SLIDER (discrete detents with a current value): the role that
  // legitimizes its aria-value* state, keeping the detent keyboard contract intact.
  const grabber = page.locator(".dsx-sheet-grabber");
  if (await grabber.getAttribute("role") !== "slider" || await grabber.getAttribute("aria-orientation") !== "vertical"
      || await grabber.getAttribute("aria-valuemin") !== "1" || await grabber.getAttribute("aria-valuemax") !== "3"
      || await grabber.getAttribute("aria-valuenow") !== "1" || await grabber.getAttribute("aria-valuetext") !== "content") {
    errors.push("sheet grabber does not carry honest slider semantics for its detent value");
  }
  await grabber.focus();
  await grabber.press("ArrowUp");
  if (await grabber.getAttribute("aria-valuenow") !== "2" || await grabber.getAttribute("aria-valuetext") !== "half"
      || await sheet.getAttribute("data-dsx-detent") !== "half") {
    errors.push("grabber slider keyboard detent step regressed");
  }
  await grabber.press("Home");
  if (await grabber.getAttribute("aria-valuenow") !== "1") errors.push("grabber Home did not return to the first detent");

  const lastSheetControl = page.locator(".dsx-sheet-action");
  await lastSheetControl.focus();
  await lastSheetControl.press("Tab");
  if (!await page.evaluate(() => document.querySelector(".dsx-sheet-panel")?.contains(document.activeElement) ?? false)) {
    errors.push("Tab escaped the modal focus boundary");
  }
  // WebKit can move focus to a tabindex=-1 panel when a previously focused
  // control becomes disabled. That panel is inside the dialog but outside its
  // computed tab cycle; the shared trap must explicitly re-enter at the first
  // enabled control.
  await sheet.focus();
  await sheet.press("Tab");
  const panelFallback = await page.evaluate(() => ({
    inside: document.querySelector(".dsx-sheet-panel")?.contains(document.activeElement) ?? false,
    onPanel: document.activeElement === document.querySelector(".dsx-sheet-panel"),
  }));
  if (!panelFallback.inside || panelFallback.onPanel) {
    errors.push(`Tab from an inside-but-nontabbable panel did not re-enter the modal cycle: ${JSON.stringify(panelFallback)}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(30);
  if (await read("dsx.variable.showSheet") !== false) errors.push("Escape did not write the sheet binding false");
  if (await read("dsx.variable.dismissals") !== 1) errors.push("sheet dismissal did not fire exactly once");
  if (await page.evaluate(() => document.documentElement.style.overflow) !== "") errors.push("document scroll lock was not restored");
  if (!await outside.evaluate((element) => document.activeElement === element)) errors.push("sheet did not restore prior focus");
  if (await page.locator(".dsx-route-chrome").evaluate((element) => (element as HTMLElement).inert)) errors.push("route chrome inert state was not restored");

  await set("showAlert", true);
  const alert = page.locator(".dsx-alert-panel");
  await alert.waitFor({ state: "visible" });
  if (await alert.getAttribute("role") !== "alertdialog") errors.push("alert does not use alertdialog semantics");
  await page.locator(".dsx-alert-layer .dsx-overlay-scrim").click({ position: { x: 2, y: 2 } });
  if (await read("dsx.variable.showAlert") !== true) errors.push("alert dismissed from an unsafe scrim click");
  await page.locator(".dsx-alert-panel .dsx-dialog-action").click();
  await page.waitForTimeout(20);
  if (await read("dsx.variable.showAlert") !== false) errors.push("alert action did not dismiss");

  await set("showConfirm", true);
  const confirm = page.locator(".dsx-confirm-panel");
  await confirm.waitFor({ state: "visible" });
  // Measure at rest: mid-zoom the panel's translate(-50%,-50%) is composed after the
  // animated scale property, so the geometric center only settles with the animation.
  await confirm.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const confirmBox = await confirm.boundingBox();
  if (confirmBox === null || Math.abs(confirmBox.y + confirmBox.height / 2 - 450) > 3) {
    errors.push("tablet/desktop confirmDialog is not vertically centered");
  }
  if (await page.locator(".dsx-confirm-panel .dsx-dialog-action[data-dsx-role=cancel]").count() !== 1) {
    errors.push("confirmDialog did not append its safe Cancel fallback");
  }
  await page.locator(".dsx-confirm-layer .dsx-overlay-scrim").click({ position: { x: 2, y: 2 } });
  await page.waitForTimeout(20);
  if (await read("dsx.variable.showConfirm") !== false) errors.push("confirmDialog outside dismissal did not write false");

  await page.locator(".popover-trigger").click();
  const popover = page.locator(".dsx-popover-panel");
  await popover.waitFor({ state: "visible" });
  const popoverBox = await popover.boundingBox();
  if (popoverBox === null || popoverBox.x < 7 || popoverBox.y < 7 || popoverBox.x + popoverBox.width > 1273 || popoverBox.y + popoverBox.height > 893) {
    errors.push("popover collision placement escaped the viewport");
  }
  if (await popover.getAttribute("aria-modal") !== "false") errors.push("popover incorrectly claimed modal semantics");
  const popoverTrigger = page.locator(".popover-trigger");
  if (await popoverTrigger.getAttribute("aria-haspopup") !== "dialog" || await popoverTrigger.getAttribute("aria-expanded") !== "true"
      || await popoverTrigger.getAttribute("aria-controls") !== await popover.getAttribute("id")) {
    errors.push("popover semantics were not stamped on the actual focusable trigger");
  }
  await page.mouse.click(100, 100);
  await page.waitForTimeout(20);
  if (await read("dsx.variable.showPopover") !== false) errors.push("popover outside dismissal did not write false");

  const menuTrigger = page.locator(".menu-trigger-button");
  const menuId = await menuTrigger.getAttribute("aria-controls");
  await menuTrigger.click();
  const menu = page.locator(`#${menuId}`);
  await menu.waitFor({ state: "visible" });
  if (await menu.getAttribute("role") !== "presentation") errors.push("menu platter should be a semantic container, not a nested menu");
  if (await menu.locator(":scope > .dsx-menu-level[role=menu]").count() !== 1) errors.push("menu does not have exactly one top-level menu owner");
  if (await menuTrigger.getAttribute("aria-haspopup") !== "menu" || await menuTrigger.getAttribute("aria-expanded") !== "true") {
    errors.push("menu semantics were not stamped on the actual button trigger");
  }
  if (await page.evaluate(() => document.activeElement?.getAttribute("role")) !== "menuitem") errors.push("menu did not focus its first item");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  if (await page.evaluate(() => document.activeElement?.textContent?.trim()?.startsWith("Duplicate")) !== true) {
    errors.push("submenu keyboard traversal failed");
  }
  const duplicateHint = await page.evaluate(() => {
    const item = document.activeElement as HTMLElement | null;
    const hint = item?.querySelector<HTMLElement>(".dsx-menu-item-shortcut");
    return {
      keyshortcuts: item?.getAttribute("aria-keyshortcuts") ?? "",
      hintText: hint?.textContent ?? "",
      hintHidden: hint?.getAttribute("aria-hidden"),
    };
  });
  if (!/^(Meta|Control)\+D$/.test(duplicateHint.keyshortcuts) || duplicateHint.hintText.length === 0
      || duplicateHint.hintHidden !== "true") {
    errors.push(`menu shortcut hint plane is wrong (${JSON.stringify(duplicateHint)})`);
  }
  // Escape WALKS UP: the deepest submenu closes back to its parent row while the
  // menu itself stays open; only the next Escape dismisses the surface.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(20);
  const walked = await page.evaluate(() => ({
    focused: document.activeElement?.textContent?.trim(),
    submenuOpen: document.querySelector(".dsx-submenu:not([hidden])") !== null,
  }));
  if (walked.focused?.startsWith("More") !== true || walked.submenuOpen) {
    errors.push(`menu Escape did not walk up one submenu level (${JSON.stringify(walked)})`);
  }
  if (!await menu.isVisible()) errors.push("submenu Escape closed the whole menu platter");
  await page.keyboard.press("ArrowRight");
  if (await page.evaluate(() => document.activeElement?.textContent?.trim()?.startsWith("Duplicate")) !== true) {
    errors.push("submenu did not reopen after its Escape walk");
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(20);
  if (await menu.isVisible()) errors.push("menu selection did not close the platter");
  if (await page.evaluate(() => (window as unknown as { __overlayAction?: { id?: number } }).__overlayAction?.id) !== 7) {
    errors.push("menu leaf did not dispatch its bounded action arguments");
  }

  const fallbackTrigger = page.locator(".fallback-menu .dsx-menu-trigger");
  if (await fallbackTrigger.getAttribute("role") !== "button" || await fallbackTrigger.getAttribute("tabindex") !== "0") {
    errors.push("non-interactive menu content did not receive a keyboard-operable fallback trigger");
  }
  await fallbackTrigger.focus();
  await fallbackTrigger.press("Space");
  const fallbackId = await fallbackTrigger.getAttribute("aria-controls");
  if (!await page.locator(`#${fallbackId}`).isVisible() || await fallbackTrigger.getAttribute("aria-expanded") !== "true") {
    errors.push("fallback menu trigger did not open with Space");
  }
  await page.keyboard.press("Escape");

  const contextTrigger = page.locator(".context-trigger-button");
  const contextId = await contextTrigger.getAttribute("aria-controls");
  await contextTrigger.click({ button: "right", position: { x: 4, y: 4 } });
  await page.locator(`#${contextId}`).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(20);
  if (await page.locator(`#${contextId}`).isVisible()) errors.push("context menu ignored Escape");
  await contextTrigger.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 24, clientY: 24, button: 0 });
  await page.waitForTimeout(540);
  if (!await page.locator(`#${contextId}`).isVisible()) errors.push("context menu touch long-press did not open");
  await contextTrigger.dispatchEvent("pointerup", { pointerType: "touch", clientX: 24, clientY: 24, button: 0 });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 320, height: 780 });
  await set("showSheet", true);
  await sheet.waitFor({ state: "visible" });
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    width: document.querySelector(".dsx-sheet-panel")?.getBoundingClientRect().width ?? 0,
    action: document.querySelector(".dsx-sheet-action")?.getBoundingClientRect().height ?? 0,
  }));
  if (mobile.overflow > 1) errors.push(`320px overlay viewport overflowed by ${mobile.overflow}px`);
  if (mobile.width < 318 || mobile.width > 321) errors.push(`mobile sheet width is ${mobile.width}px`);
  if (mobile.action < 44) errors.push(`mobile sheet action target is ${mobile.action}px (<44px)`);
  await page.keyboard.press("Escape");

  if (errors.length === 0) {
    console.log(`✓ [${engine}] overlays: modal semantics/inert/focus, dismissals, menu keyboard, collision, author override, 320px`);
  }
} finally {
  await browser.close();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ [${engine}] ${error}`);
  process.exit(1);
}
