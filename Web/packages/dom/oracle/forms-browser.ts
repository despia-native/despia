// Real-engine acceptance for Foundation <form>/<field>. This mounts an isolated
// compiled DSX surface into the built demo document, so it exercises the same ESM,
// registry, DOM factory, state runner and weak-layer CSS shipped to applications.

import { startServer } from "../../compiler/bin/serve.ts";
import { browserEngine, launchBrowser } from "./browser-engine.ts";

const engine = browserEngine();
const errors: string[] = [];
const { port, close } = await startServer(0);
const browser = await launchBrowser(engine);

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.goto(`http://localhost:${port}/demo/site/`, { waitUntil: "networkidle" });

  await page.evaluate(async () => {
    const compilerUrl = "/demo/site/dist/compiler/src/component.js";
    const mountUrl = "/demo/site/dist/dom/src/mount.js";
    const [compilerModule, mountModule] = await Promise.all([
      import(compilerUrl) as Promise<typeof import("../../compiler/src/component.ts")>,
      import(mountUrl) as Promise<typeof import("../src/mount.ts")>,
    ]);
    const { compileComponent } = compilerModule;
    const { instantiate } = mountModule;
    const source = `<form as="account" submit="Create account" spacing="14" on:submit="accept">
      <head>
        <variable as="account">return { values: { email: '', plan: '', terms: false, password: '' } }</variable>
        <variable as="accepted">return 0</variable>
        <action as="accept">dsx.variable.accepted += 1</action>
      </head>
      <field name="email" type="email" label="Email" placeholder="you@example.com" validate="required,email"/>
      <field name="plan" type="picker" label="Plan" placeholder="Choose a plan" options="Free,Pro" validate="required"/>
      <field name="terms" type="toggle" label="Accept the terms" validate="required"/>
      <field name="password" type="secure" label="Password" placeholder="At least 8 characters" validate="required,minLength:8"/>
      <text value="accepted {{ dsx.variable.accepted }}"/>
    </form>`;
    const ir = compileComponent("BrowserForm", "test", source);
    const registry = { components: { "test.BrowserForm": ir }, globalPool: {}, css: "", schemes: [] };
    const instance = instantiate(ir, registry);
    const host = document.querySelector("#app")!;
    host.replaceChildren(instance.root);
    host.id = "form-host";
    const override = document.createElement("style");
    override.textContent = `#form-host .dsx-field-control { border-radius: 3px; }`;
    document.head.appendChild(override);
    (globalThis as typeof globalThis & { __dsxFormTest?: typeof instance }).__dsxFormTest = instance;
  });

  const form = page.locator("form.dsx-form");
  await form.waitFor({ state: "visible" });
  const semantic = await form.evaluate((element) => {
    const labels = [...element.querySelectorAll("label[for]")];
    return {
      inputs: element.querySelectorAll("input").length,
      selects: element.querySelectorAll("select").length,
      switches: element.querySelectorAll('input[role="switch"]').length,
      labels: labels.length,
      brokenLabels: labels.filter((label) => document.getElementById((label as HTMLLabelElement).htmlFor) === null).length,
      duplicateIds: [...element.querySelectorAll("[id]")].map((node) => node.id)
        .filter((id, index, ids) => ids.indexOf(id) !== index).length,
    };
  });
  if (semantic.inputs !== 3 || semantic.selects !== 1 || semantic.switches !== 1) {
    errors.push(`semantic controls mismatch: ${JSON.stringify(semantic)}`);
  }
  if (semantic.labels !== 4 || semantic.brokenLabels !== 0 || semantic.duplicateIds !== 0) {
    errors.push(`label/id accessibility mismatch: ${JSON.stringify(semantic)}`);
  }

  const submit = form.getByRole("button", { name: "Create account" });
  const initialOpacity = Number(await submit.evaluate((button) => getComputedStyle(button).opacity));
  if (Math.abs(initialOpacity - 0.5) > 0.01) errors.push(`invalid submit opacity=${initialOpacity}, expected .5`);
  if (await form.locator('.dsx-field-error:not([hidden])').count() !== 0) errors.push("errors visible before touch/submit");
  const authoredRadius = await form.locator(".dsx-field-control").first().evaluate((control) => getComputedStyle(control).borderRadius);
  if (authoredRadius !== "3px") errors.push(`author CSS did not override weak defaults: radius=${authoredRadius}`);

  await submit.click();
  await page.waitForTimeout(50);
  if (await form.locator('.dsx-field-error:not([hidden])').count() !== 4) errors.push("invalid submit did not reveal every error");
  const invalidState = await page.evaluate(() => {
    const instance = (globalThis as typeof globalThis & { __dsxFormTest?: { ctx: { store: { getPath(path: string): unknown; eval(path: string, item: unknown): unknown }; item: unknown } } }).__dsxFormTest!;
    return {
      submitted: instance.ctx.store.getPath("account.submitted"),
      accepted: instance.ctx.store.eval("accepted", instance.ctx.item),
      touched: instance.ctx.store.getPath("account.fields.email.touched"),
    };
  });
  if (invalidState.submitted !== true || invalidState.touched !== true || invalidState.accepted !== 0) {
    errors.push(`invalid submit state/action mismatch: ${JSON.stringify(invalidState)}`);
  }
  const focusedName = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name ?? "");
  if (focusedName !== "email") errors.push(`invalid submit did not focus first invalid field: ${focusedName}`);

  const email = form.locator('input[name="email"]');
  await email.fill("person@example.com");
  await email.press("Enter");
  if (await page.evaluate(() => (document.activeElement as HTMLInputElement | HTMLSelectElement | null)?.name ?? "") !== "plan") {
    errors.push("Enter did not advance email to the picker");
  }
  await form.locator('select[name="plan"]').selectOption("Pro");
  await form.locator('input[name="terms"]').check();
  const password = form.locator('input[name="password"]');
  await password.fill("correct horse");
  await password.press("Enter");
  await page.waitForTimeout(250);

  const validState = await page.evaluate(() => {
    const instance = (globalThis as typeof globalThis & { __dsxFormTest?: { ctx: { store: { getPath(path: string): unknown; eval(path: string, item: unknown): unknown }; item: unknown } } }).__dsxFormTest!;
    return {
      valid: instance.ctx.store.getPath("account.valid"),
      accepted: instance.ctx.store.eval("accepted", instance.ctx.item),
      email: instance.ctx.store.getPath("account.values.email"),
      plan: instance.ctx.store.getPath("account.values.plan"),
      terms: instance.ctx.store.getPath("account.values.terms"),
      dirty: instance.ctx.store.getPath("account.fields.password.dirty"),
    };
  });
  if (validState.valid !== true || validState.accepted !== 1 || validState.email !== "person@example.com"
      || validState.plan !== "Pro" || validState.terms !== true || validState.dirty !== true) {
    errors.push(`valid submit/state mismatch: ${JSON.stringify(validState)}`);
  }
  const validOpacity = Number(await submit.evaluate((button) => getComputedStyle(button).opacity));
  if (Math.abs(validOpacity - 1) > 0.01) errors.push(`valid submit opacity=${validOpacity}, expected 1`);
  if (await form.locator('.dsx-field-error:not([hidden])').count() !== 0) errors.push("valid fields retained visible errors");

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    const layout = await form.evaluate((element) => ({
      overflow: element.scrollWidth - element.clientWidth,
      controlWidth: element.querySelector<HTMLInputElement>(".dsx-field-control")?.getBoundingClientRect().width ?? 0,
      controlHeight: element.querySelector<HTMLInputElement>(".dsx-field-control")?.getBoundingClientRect().height ?? 0,
      formWidth: element.getBoundingClientRect().width,
    }));
    if (layout.overflow > 1 || layout.controlWidth <= 0 || layout.controlWidth > layout.formWidth + 1) {
      errors.push(`${width}px responsive form geometry: ${JSON.stringify(layout)}`);
    }
    if (width === 320 && layout.controlHeight < 44) errors.push(`mobile control height ${layout.controlHeight}px is below 44px`);
    if (width === 1440 && (layout.controlHeight < 38 || layout.controlHeight > 40)) {
      errors.push(`desktop precision control height ${layout.controlHeight}px is outside 38-40px`);
    }
  }

  if (errors.length > 0) throw new Error(`form browser oracle [${engine}] failed:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  console.log(`✓ [${engine}] semantic forms: validation/state, a11y, keyboard, override cascade, and 320/768/1440px geometry`);
} finally {
  await browser.close();
  await close();
}
