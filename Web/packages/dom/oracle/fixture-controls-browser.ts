// Real-engine parity gate for canonical base fixture attributes and touch geometry.
// It intentionally compiles static legacy attributes so both the generated
// dsx-attrs layer and the client factories are exercised together.

import { buildSync } from "esbuild";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const markup = String.raw`<vstack class="fixture-harness">
  <head>
    <variable as="enabled">return true</variable>
    <variable as="amount">return 0.5</variable>
    <variable as="quantity">return 2</variable>
  </head>
  <stack class="layout-stack" flexDirection="row" alignItems="flex-end" display="grid">
    <text value="First"/><text value="Second"/>
  </stack>
  <hstack class="default-hstack"><text value="H"/></hstack>
  <vstack class="default-vstack"><text value="V"/></vstack>
  <zstack class="default-zstack"><text value="Z"/></zstack>
  <scroll class="direction-scroll" direction="horizontal"><text value="Across"/></scroll>
  <divider class="tinted-divider" color="destructive"/>
  <toggle class="tinted-toggle" bind="dsx.variable.enabled" color="secondary"/>
  <slider class="tinted-slider" bind="dsx.variable.amount" color="tertiary"/>
  <spinner class="scaled-spinner" color="secondary" scale="1.5"/>
  <stepper class="named-stepper" bind="dsx.variable.quantity" label="Quantity" color="destructive"/>
  <segmented class="touch-segmented" bind="dsx.variable.mode" options="One,Two"/>
  <Checkbox bind="dsx.variable.enabled" label="Enabled" color="destructive"/>
</vstack>`;

const source = String.raw`
  import { compileComponent } from "@despia/compiler/component";
  import { CssCollector, extractComponentCss } from "./packages/compiler/src/css.ts";
  import { LAYER_STATEMENT } from "@despia/compiler/cssmap";
  import { instantiate } from "@despia/dom/mount";
  import { registerGlobalElements, registerRichElements } from "@despia/dom/elements";
  import { UNIVERSAL_GLOBAL_ELEMENTS, GLOBAL_ELEMENTS_CSS } from "@despia/dom/globals";
  import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS, RICH_ELEMENTS_CSS } from "@despia/dom/theme";

  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();
  const ir = compileComponent("FixtureControls", "test", ${JSON.stringify(markup)});
  const collector = new CssCollector();
  extractComponentCss(ir, collector);
  const generatedCss = collector.emit();
  const registry = { components: { "test.FixtureControls": ir }, globalPool: {}, css: generatedCss, schemes: [] };
  const style = document.createElement("style");
  style.textContent = [
    LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS,
    RICH_ELEMENTS_CSS, GLOBAL_ELEMENTS_CSS, generatedCss,
    "@layer dsx-components { * { box-sizing:border-box } body { margin:0 } .fixture-harness { width:320px; padding:12px; } }",
  ].join("\n");
  document.head.appendChild(style);
  const instance = instantiate(ir, registry);
  document.body.replaceChildren(instance.root);
  window.__DSX_FIXTURE_CONTROLS_READY__ = true;
`;

const output = buildSync({
  stdin: { contents: source, loader: "ts", resolveDir: process.cwd(), sourcefile: "fixture-controls-browser-entry.ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "silent",
}).outputFiles[0]?.text;
if (output === undefined) throw new Error("fixture-controls browser harness did not bundle");

const engine = browserEngine();
const browser = await launchBrowser(engine);
const errors: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  await page.setContent("<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>");
  await page.addScriptTag({ content: output });
  await page.waitForFunction(() => (window as unknown as { __DSX_FIXTURE_CONTROLS_READY__?: boolean }).__DSX_FIXTURE_CONTROLS_READY__ === true);

  const audit = await page.evaluate(() => {
    const one = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`missing ${selector}`);
      return element;
    };
    const style = (selector: string): CSSStyleDeclaration => getComputedStyle(one(selector));
    const size = (selector: string): { width: number; height: number } => {
      const rect = one(selector).getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    const customColor = (selector: string, property: string): string => {
      const parent = one(selector);
      const child = document.createElement("span");
      child.style.color = `var(${property})`;
      parent.appendChild(child);
      const color = getComputedStyle(child).color;
      child.remove();
      return color;
    };
    const probe = document.createElement("span");
    probe.style.color = "var(--dsx-destructive)";
    document.body.appendChild(probe);
    const destructive = getComputedStyle(probe).color;
    probe.style.color = "var(--dsx-secondary-label)";
    const secondary = getComputedStyle(probe).color;
    probe.style.color = "var(--dsx-tertiary-label)";
    const tertiary = getComputedStyle(probe).color;
    probe.remove();

    const layout = style(".layout-stack");
    const hstack = style(".default-hstack");
    const vstack = style(".default-vstack");
    const zstack = style(".default-zstack");
    const scroll = style(".direction-scroll");
    const stepper = one(".named-stepper");
    const stepperButtons = [...stepper.querySelectorAll<HTMLElement>(".dsx-stepper-btn")];
    const segmented = [...document.querySelectorAll<HTMLElement>(".touch-segmented > .dsx-segmented-option")];
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      layout: {
        display: layout.display,
        direction: layout.flexDirection,
        align: layout.alignItems,
        grid: one(".layout-stack").getAttribute("data-dsx-grid"),
        areas: [...one(".layout-stack").children].map((child) => getComputedStyle(child).gridArea),
      },
      defaults: {
        hGap: hstack.gap, hAlign: hstack.alignItems,
        vGap: vstack.gap, vAlign: vstack.alignItems,
        zAlign: zstack.alignItems, zJustify: zstack.justifyItems,
      },
      scroll: { direction: scroll.flexDirection, overflowX: scroll.overflowX },
      colors: {
        divider: style(".tinted-divider").backgroundColor,
        toggle: customColor(".tinted-toggle", "--dsx-control-tint"),
        slider: style(".tinted-slider").accentColor,
        spinner: style(".scaled-spinner").borderTopColor,
        checkbox: customColor(".dsx-checkbox", "--dsx-checkbox-color"),
        destructive, secondary, tertiary,
      },
      tintedChrome: {
        toggleChecked: one(".tinted-toggle input").matches(":checked"),
        checkboxChecked: one(".dsx-checkbox input").matches(":checked"),
        toggleImage: style(".tinted-toggle .dsx-toggle-track").backgroundImage,
        checkboxImage: style(".dsx-checkbox .dsx-checkbox-box").backgroundImage,
      },
      spinner: {
        scale: one(".scaled-spinner").style.getPropertyValue("--dsx-spinner-scale"),
        animation: style(".scaled-spinner").animationName,
      },
      stepper: {
        role: stepper.getAttribute("role"),
        label: stepper.getAttribute("aria-label"),
        buttons: stepperButtons.map((button) => ({ label: button.getAttribute("aria-label"), ...size(`.${button.className.split(" ").join(".")}:nth-of-type(${stepperButtons.indexOf(button) + 1})`) })),
      },
      segmented: segmented.map((option) => {
        const rect = option.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    };
  });

  if (!audit.coarse) errors.push("touch context did not expose a coarse pointer");
  if (audit.layout.display !== "grid" || audit.layout.direction !== "row" || audit.layout.align !== "flex-end") {
    errors.push(`stack layout attributes diverged: ${JSON.stringify(audit.layout)}`);
  }
  if (audit.layout.grid !== "true" || audit.layout.areas.length !== 2
      || audit.layout.areas[0] !== audit.layout.areas[1] || !audit.layout.areas[0]?.startsWith("1 / 1")) {
    errors.push(`grid stack did not overlap children: ${JSON.stringify(audit.layout)}`);
  }
  if (audit.defaults.hGap !== "8px" || audit.defaults.hAlign !== "center"
      || audit.defaults.vGap !== "8px" || audit.defaults.vAlign !== "start"
      || audit.defaults.zAlign !== "center" || audit.defaults.zJustify !== "center") {
    errors.push(`stack-family defaults diverged: ${JSON.stringify(audit.defaults)}`);
  }
  if (audit.scroll.direction !== "row" || audit.scroll.overflowX !== "auto") {
    errors.push(`scroll direction alias diverged: ${JSON.stringify(audit.scroll)}`);
  }
  for (const [name, actual, expected] of [
    ["divider", audit.colors.divider, audit.colors.destructive],
    ["toggle", audit.colors.toggle, audit.colors.secondary],
    ["slider", audit.colors.slider, audit.colors.tertiary],
    ["spinner", audit.colors.spinner, audit.colors.secondary],
    ["checkbox", audit.colors.checkbox, audit.colors.destructive],
  ] as const) {
    if (actual !== expected) errors.push(`${name} tint ${actual} != ${expected}`);
  }
  if (!audit.tintedChrome.toggleChecked || !audit.tintedChrome.checkboxChecked
      || audit.tintedChrome.toggleImage === "none" || audit.tintedChrome.checkboxImage === "none") {
    errors.push(`checked semantic tint did not reach gradient chrome: ${JSON.stringify(audit.tintedChrome)}`);
  }
  if (audit.spinner.scale !== "1.5" || audit.spinner.animation !== "dsx-spin") {
    errors.push(`spinner scale/animation diverged: ${JSON.stringify(audit.spinner)}`);
  }
  if (audit.stepper.role !== "group" || audit.stepper.label !== "Quantity"
      || audit.stepper.buttons[0]?.label !== "Decrease Quantity"
      || audit.stepper.buttons[1]?.label !== "Increase Quantity") {
    errors.push(`stepper accessible identity diverged: ${JSON.stringify(audit.stepper)}`);
  }
  for (const [name, target] of [
    ...audit.stepper.buttons.map((button, index) => [`stepper ${index}`, button] as const),
    ...audit.segmented.map((option, index) => [`segmented ${index}`, option] as const),
  ]) {
    if (target.width < 44 || target.height < 44) errors.push(`${name} target is ${target.width}x${target.height} (<44x44)`);
  }

  if (errors.length === 0) {
    console.log(`✓ [${engine}] fixture controls: layout aliases/defaults, semantic tint, named stepper, coarse 44x44 targets`);
  }
  await context.close();
} finally {
  await browser.close();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ [${engine}] ${error}`);
  process.exit(1);
}
