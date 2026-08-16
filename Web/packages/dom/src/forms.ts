//
//  forms.ts - the semantic web twin of Foundation's public <form>/<field> pair.
//  The browser owns the controls (real form/input/select/label/button elements);
//  DSX owns the shared state namespace and the validation lifecycle.
//

import {
  charCount, graphemes, isDict, number, reDoSProne, string, truthy, type Dict,
} from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { ElementApi, ElementFactory } from "./elements.ts";
import type { MountCtx } from "./mount.ts";

export const FORM_ELEMENT_TAGS: ReadonlySet<string> = new Set(["form", "field"]);

/** Hard boundaries keep hostile remote markup from turning one field into unbounded
 * input, option or regexp work on the browser's single UI thread. */
export const FORM_LIMITS = Object.freeze({
  maxInputCharacters: 16_384,
  maxPatternCharacters: 512,
  maxValidationCharacters: 2_048,
  maxRules: 64,
  maxOptions: 1_000,
  maxOptionCharacters: 512,
});

export type FormFieldType = "text" | "email" | "number" | "phone" | "url" | "secure" | "toggle" | "picker";
export type ValidationRule = Readonly<{ name: string; argument: string }>;

const STATE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_TYPES: ReadonlySet<string> = new Set([
  "text", "email", "number", "phone", "url", "secure", "toggle", "picker",
]);

function stateName(value: string, fallback: string): string {
  const candidate = value.trim();
  return STATE_NAME.test(candidate) ? candidate : fallback;
}

function fieldType(value: string): FormFieldType {
  return VALID_TYPES.has(value) ? value as FormFieldType : "text";
}

function booleanAttribute(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "1";
}

export function normalizeFormInput(value: string): string {
  if (charCount(value) <= FORM_LIMITS.maxInputCharacters) return value;
  // Slice UTF-16 before segmenting so even a programmatic multi-megabyte assignment
  // has a fixed allocation ceiling; four code units per retained user character
  // covers normal surrogate/combining sequences without taxing the UI thread.
  return graphemes(value.substring(0, FORM_LIMITS.maxInputCharacters * 4))
    .slice(0, FORM_LIMITS.maxInputCharacters).join("");
}

export function parseValidationRules(source: string): ValidationRule[] {
  if (source.length > FORM_LIMITS.maxValidationCharacters) return [{ name: "invalid", argument: "" }];
  const out: ValidationRule[] = [];
  for (const raw of source.split(",")) {
    if (out.length >= FORM_LIMITS.maxRules) {
      out.push({ name: "invalid", argument: "" });
      break;
    }
    const value = raw.trim();
    if (value.length === 0) continue;
    const colon = value.indexOf(":");
    out.push(colon < 0
      ? { name: value, argument: "" }
      : { name: value.substring(0, colon), argument: value.substring(colon + 1) });
  }
  return out;
}

function messageFor(rule: ValidationRule): string {
  switch (rule.name) {
    case "required": return "Required";
    case "email": return "Enter a valid email";
    case "url": return "Enter a valid URL";
    case "phone": return "Enter a valid phone number";
    case "minLength": return `Must be at least ${rule.argument} characters`;
    case "maxLength": return `Must be at most ${rule.argument} characters`;
    case "regex":
    case "pattern": return "Invalid format";
    default: return "Invalid";
  }
}

function boundedLength(value: string): boolean {
  if (value.length > FORM_LIMITS.maxInputCharacters * 4) return false;
  return charCount(value) <= FORM_LIMITS.maxInputCharacters;
}

function patternPasses(value: string, pattern: string): boolean {
  // Match the Swift contract: an optional empty value passes pattern validation;
  // pair with `required` when emptiness must fail.
  if (value.length === 0 || pattern.length === 0) return true;
  if (pattern.length > FORM_LIMITS.maxPatternCharacters || !boundedLength(value) || reDoSProne(pattern)) return false;
  try { return new RegExp(pattern).test(value); } catch { return false; }
}

function integerArgument(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, FORM_LIMITS.maxInputCharacters)) : 0;
}

export function validateFormValue(
  value: unknown,
  type: FormFieldType,
  validate: string,
  pattern = "",
  overrideMessage = "",
): string {
  const text = string(value);
  if (!boundedLength(text)) return overrideMessage || `Must be at most ${FORM_LIMITS.maxInputCharacters} characters`;
  for (const rule of parseValidationRules(validate)) {
    let pass = false;
    switch (rule.name) {
      case "required":
        pass = type === "toggle" ? truthy(value) : text.trim().length > 0;
        break;
      case "email": pass = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i.test(text); break;
      case "phone": pass = /^[+]?[0-9 ()\-]{7,}$/.test(text); break;
      case "url":
        try {
          const url = new URL(text);
          pass = url.protocol.length > 0 && url.hostname.length > 0;
        } catch { pass = false; }
        break;
      case "minLength": pass = charCount(text) >= integerArgument(rule.argument); break;
      case "maxLength": pass = charCount(text) <= integerArgument(rule.argument); break;
      case "regex":
      case "pattern": pass = patternPasses(text, rule.argument || pattern); break;
      default: pass = false;
    }
    if (!pass) return overrideMessage || messageFor(rule);
  }
  return "";
}

export type FormOption = Readonly<{ value: string; label: string }>;

export function normalizeFormOptions(
  source: unknown,
  valueField = "id",
  labelField = "label",
): FormOption[] {
  const raw = Array.isArray(source) ? source : [];
  const out: FormOption[] = [];
  for (const entry of raw) {
    if (out.length >= FORM_LIMITS.maxOptions) break;
    const value = isDict(entry) ? string((entry as Dict)[valueField]) : string(entry);
    const label = isDict(entry) ? string((entry as Dict)[labelField]) : string(entry);
    out.push({
      value: value.substring(0, FORM_LIMITS.maxOptionCharacters),
      label: label.substring(0, FORM_LIMITS.maxOptionCharacters),
    });
  }
  return out;
}

function staticOptions(source: string): FormOption[] {
  return normalizeFormOptions(source.split(",").map((part) => part.trim()).filter(Boolean));
}

function dict(value: unknown): Dict { return isDict(value) ? value as Dict : {}; }

/** ReactiveStore.setPath operates on the promoted vars table. Component variables
 * begin in the lazy `initials` table, so materialize the namespace before the first
 * field metadata write or that write would replace authored initial values. */
function ensureNamespace(ctx: MountCtx, namespace: string): void {
  if (ctx.store.vars.has(namespace)) return;
  const initial = ctx.store.eval(namespace, ctx.item);
  ctx.store.set(namespace, isDict(initial) ? { ...(initial as Dict) } : {});
}

function fieldMeta(ctx: MountCtx, namespace: string, name: string): Dict {
  return dict(ctx.store.getPath(`${namespace}.fields.${name}`));
}

function writeMeta(ctx: MountCtx, namespace: string, name: string, patch: Dict): void {
  ctx.store.setPath(`${namespace}.fields.${name}`, { ...fieldMeta(ctx, namespace, name), ...patch });
}

function activeOrder(ctx: MountCtx, namespace: string): string[] {
  const value = ctx.store.getPath(`${namespace}.fieldOrder`);
  return Array.isArray(value) ? value.map(string).filter((name) => STATE_NAME.test(name)) : [];
}

function recomputeValid(ctx: MountCtx, namespace: string): void {
  const fields = dict(ctx.store.getPath(`${namespace}.fields`));
  const order = activeOrder(ctx, namespace);
  const valid = order.length > 0 && order.every((name) => string(dict(fields[name])["error"]).length === 0);
  ctx.store.setPath(`${namespace}.valid`, valid);
}

type FocusableField = HTMLInputElement | HTMLSelectElement;
const controls = new WeakMap<MountCtx["store"], Map<string, Map<string, Set<FocusableField>>>>();
const formRoots = new WeakMap<MountCtx["store"], Map<string, HTMLFormElement>>();

function controlTable(ctx: MountCtx, namespace: string): Map<string, Set<FocusableField>> {
  let byNamespace = controls.get(ctx.store);
  if (byNamespace === undefined) { byNamespace = new Map(); controls.set(ctx.store, byNamespace); }
  let table = byNamespace.get(namespace);
  if (table === undefined) { table = new Map(); byNamespace.set(namespace, table); }
  return table;
}

function registerControl(ctx: MountCtx, namespace: string, name: string, control: FocusableField): () => void {
  const table = controlTable(ctx, namespace);
  const set = table.get(name) ?? new Set<FocusableField>();
  set.add(control);
  table.set(name, set);
  return () => {
    set.delete(control);
    if (set.size === 0) table.delete(name);
  };
}

function focusField(ctx: MountCtx, namespace: string, name: string): boolean {
  const set = controls.get(ctx.store)?.get(namespace)?.get(name);
  const control = set === undefined ? undefined : [...set][0];
  if (control === undefined) return false;
  control.focus();
  return true;
}

function formRootTable(ctx: MountCtx): Map<string, HTMLFormElement> {
  let table = formRoots.get(ctx.store);
  if (table === undefined) { table = new Map(); formRoots.set(ctx.store, table); }
  return table;
}

function initialBoundText(node: XmlNode, api: ElementApi, name: string, fallback = ""): string {
  let value = fallback;
  api.bindText(node.attrs[name] ?? fallback, (next) => { value = next; });
  return value;
}

let fieldSequence = 0;

const formElement: ElementFactory = (node, ctx, api) => {
  const root = document.createElement("form");
  root.className = "dsx-form";
  root.noValidate = true;

  const namespace = stateName(initialBoundText(node, api, "as", "form"), "form");
  ensureNamespace(ctx, namespace);
  root.dataset["dsxForm"] = namespace;
  // The 12px default belongs to the weak stylesheet. Only an authored attribute
  // earns inline precedence, preserving normal CSS custom-property overrides.
  if (node.attrs["spacing"] !== undefined) {
    api.bindText(node.attrs["spacing"], (value) => {
      root.style.setProperty("--dsx-form-spacing", `${Math.max(0, number(value) ?? 12)}px`);
    });
  }
  if (booleanAttribute(initialBoundText(node, api, "scroll", "false"))) root.classList.add("dsx-form-scroll");

  const table = formRootTable(ctx);
  table.set(namespace, root);
  ctx.disposers.push(() => { if (table.get(namespace) === root) table.delete(namespace); });

  // Namespace inheritance is a mount-context value, not a DOM query. It therefore
  // survives visible-if remounts and authored layout wrappers between form and field.
  api.children(root, undefined, { formNamespace: namespace });

  let submit: HTMLButtonElement | null = null;
  if (node.attrs["submit"] !== undefined) {
    submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "dsx-button dsx-form-submit";
    api.bindText(node.attrs["submit"], (label) => { if (submit !== null) submit.textContent = label; });
    root.appendChild(submit);
  }

  const stampValidity = (raw: unknown): void => {
    const valid = truthy(raw);
    root.dataset["dsxValid"] = String(valid);
    submit?.setAttribute("data-dsx-valid", String(valid));
  };
  api.bindValue(`${namespace}.valid`, stampValidity);

  root.addEventListener("submit", (event) => {
    event.preventDefault();
    const valid = truthy(ctx.store.getPath(`${namespace}.valid`));
    if (valid) {
      ctx.store.setPath(`${namespace}.focus`, "");
      api.handler("submit", { values: dict(ctx.store.getPath(`${namespace}.values`)) });
      return;
    }
    const fields = dict(ctx.store.getPath(`${namespace}.fields`));
    const touched: Dict = {};
    for (const [name, raw] of Object.entries(fields)) touched[name] = { ...dict(raw), touched: true };
    ctx.store.batch(() => {
      ctx.store.setPath(`${namespace}.fields`, touched);
      ctx.store.setPath(`${namespace}.submitted`, true);
    });
    const firstInvalid = activeOrder(ctx, namespace).find((name) => string(dict(touched[name])["error"]).length > 0);
    if (firstInvalid !== undefined) focusField(ctx, namespace, firstInvalid);
  });
  return root;
};

function inputType(type: FormFieldType): string {
  switch (type) {
    case "email": return "email";
    case "number": return "number";
    case "phone": return "tel";
    case "url": return "url";
    case "secure": return "password";
    default: return "text";
  }
}

function inferredMaximum(rules: readonly ValidationRule[]): number {
  const authored = rules.find((rule) => rule.name === "maxLength");
  return authored === undefined ? FORM_LIMITS.maxInputCharacters : integerArgument(authored.argument);
}

const fieldElement: ElementFactory = (node, ctx, api) => {
  const root = document.createElement("div");
  root.className = "dsx-field";
  root.setAttribute("data-dsx-component", "field");

  const inherited = ctx.formNamespace ?? "form";
  const namespace = stateName(initialBoundText(node, api, "form", inherited), inherited);
  ensureNamespace(ctx, namespace);
  const rawName = initialBoundText(node, api, "name", "");
  const name = stateName(rawName, `field_${fieldSequence + 1}`);
  const declaredType = fieldType(initialBoundText(node, api, "type", "text"));
  const type: FormFieldType = booleanAttribute(initialBoundText(node, api, "secure", "false")) ? "secure" : declaredType;
  const valuePath = `${namespace}.values.${name}`;
  const metaPath = `${namespace}.fields.${name}`;
  const rules = parseValidationRules(node.attrs["validate"] ?? "");
  const required = rules.some((rule) => rule.name === "required");
  const id = `dsx-field-${++fieldSequence}`;
  const errorId = `${id}-error`;
  root.dataset["dsxFieldName"] = name;
  root.dataset["dsxFieldType"] = type;

  const labelText = initialBoundText(node, api, "label", "");
  const label = document.createElement("label");
  label.className = type === "toggle" ? "dsx-field-toggle-label" : "dsx-field-label";
  label.setAttribute("data-dsx-part", "label");
  label.htmlFor = id;
  const labelCopy = document.createElement("span");
  labelCopy.className = "dsx-field-label-copy";
  labelCopy.textContent = labelText;
  if (labelText.length > 0 || type === "toggle") root.appendChild(label);

  const error = document.createElement("span");
  error.id = errorId;
  error.className = "dsx-field-error";
  error.setAttribute("role", "alert");
  error.setAttribute("aria-live", "polite");
  error.hidden = true;
  error.setAttribute("data-dsx-part", "error");

  let control: FocusableField;
  let accessibleFallback = name;
  if (type === "picker") {
    const select = document.createElement("select");
    select.className = "dsx-field-control dsx-field-select";
    control = select;
    const placeholder = initialBoundText(node, api, "placeholder", "Select");
    accessibleFallback = placeholder || name;
    let options: FormOption[] = staticOptions(node.attrs["options"] ?? "");
    const renderOptions = (): void => {
      const current = string(ctx.store.getPath(valuePath));
      select.replaceChildren();
      if (placeholder.length > 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = placeholder;
        option.disabled = required;
        select.appendChild(option);
      }
      for (const item of options) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        select.appendChild(option);
      }
      select.value = current;
    };
    if (node.attrs["optionsKey"] !== undefined) {
      api.bindValue(node.attrs["optionsKey"], (value) => {
        options = normalizeFormOptions(value, node.attrs["valueField"] ?? "id", node.attrs["labelField"] ?? "label");
        renderOptions();
      });
    } else renderOptions();
    select.addEventListener("change", () => {
      api.writeBack(valuePath, select.value);
      writeMeta(ctx, namespace, name, { dirty: true, touched: true });
      validate();
      api.handler("change", { value: select.value });
    });
  } else {
    const input = document.createElement("input");
    input.className = type === "toggle" ? "dsx-field-toggle-input" : "dsx-field-control";
    input.type = type === "toggle" ? "checkbox" : inputType(type);
    if (type === "toggle") input.setAttribute("role", "switch");
    if (type === "email") input.setAttribute("autocomplete", node.attrs["autocomplete"] ?? "email");
    if (type === "secure") input.setAttribute("autocomplete", node.attrs["autocomplete"] ?? "current-password");
    if (type === "phone") input.setAttribute("autocomplete", node.attrs["autocomplete"] ?? "tel");
    if (type === "number") input.inputMode = node.attrs["inputMode"] ?? "decimal";
    if (type !== "toggle") {
      input.placeholder = initialBoundText(node, api, "placeholder", "");
      accessibleFallback = input.placeholder || name;
      if (type !== "number") input.maxLength = inferredMaximum(rules);
    }
    control = input;
    input.addEventListener("input", () => {
      if (type !== "toggle") {
        const limited = normalizeFormInput(input.value);
        if (limited !== input.value) input.value = limited;
      }
      const value: unknown = type === "toggle" ? input.checked : input.value;
      api.writeBack(valuePath, value);
      writeMeta(ctx, namespace, name, { dirty: true, ...(type === "toggle" ? { touched: true } : {}) });
      validate();
      api.handler("change", { value });
    });
  }

  control.id = id;
  control.setAttribute("data-dsx-part", type === "toggle" ? "toggle" : "control");
  control.setAttribute("name", name);
  control.required = required;
  control.setAttribute("aria-describedby", errorId);
  if (labelText.length === 0) control.setAttribute("aria-label", accessibleFallback);
  if (type === "toggle") {
    label.append(labelCopy, control);
  } else {
    if (label.parentNode !== null) label.appendChild(labelCopy);
    root.appendChild(control);
  }
  root.appendChild(error);

  let shownError = "";
  let touched = truthy(ctx.store.getPath(`${metaPath}.touched`));
  let submitted = truthy(ctx.store.getPath(`${namespace}.submitted`));
  const reveal = (): void => {
    const visible = shownError.length > 0 && (touched || submitted);
    error.hidden = !visible;
    root.dataset["dsxInvalid"] = String(shownError.length > 0);
    control.setAttribute("aria-invalid", String(shownError.length > 0));
    if (visible) control.setAttribute("aria-errormessage", errorId);
    else control.removeAttribute("aria-errormessage");
  };

  const validate = (): void => {
    const value = type === "toggle" ? truthy(ctx.store.getPath(valuePath)) : ctx.store.getPath(valuePath);
    const result = validateFormValue(
      value,
      type,
      node.attrs["validate"] ?? "",
      node.attrs["pattern"] ?? "",
      node.attrs["message"] ?? "",
    );
    writeMeta(ctx, namespace, name, { error: result });
    recomputeValid(ctx, namespace);
  };

  // Registration order is visual order and drives Return -> next. Preserve an
  // existing field's flags across a visible-if remount, like the native store.
  const order = activeOrder(ctx, namespace);
  if (!order.includes(name)) ctx.store.setPath(`${namespace}.fieldOrder`, [...order, name]);
  writeMeta(ctx, namespace, name, {
    touched: truthy(fieldMeta(ctx, namespace, name)["touched"]),
    dirty: truthy(fieldMeta(ctx, namespace, name)["dirty"]),
    error: string(fieldMeta(ctx, namespace, name)["error"]),
  });

  api.bindValue(valuePath, (value) => {
    if (type === "toggle") (control as HTMLInputElement).checked = truthy(value);
    else {
      const next = normalizeFormInput(string(value));
      if (control.value !== next) control.value = next;
    }
    validate();
  });
  api.bindValue(`${metaPath}.error`, (value) => {
    shownError = string(value);
    error.textContent = shownError;
    reveal();
  });
  api.bindValue(`${metaPath}.touched`, (value) => { touched = truthy(value); reveal(); });
  api.bindValue(`${namespace}.submitted`, (value) => { submitted = truthy(value); reveal(); });

  control.addEventListener("focus", () => {
    ctx.store.setPath(`${namespace}.focus`, name);
    api.handler("focus", { value: ctx.store.getPath(valuePath) });
  });
  control.addEventListener("blur", () => {
    writeMeta(ctx, namespace, name, { touched: true });
    validate();
    api.handler("blur", { value: ctx.store.getPath(valuePath) });
  });
  if (type !== "toggle" && type !== "picker") {
    control.addEventListener("keydown", (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const currentOrder = activeOrder(ctx, namespace);
      const index = currentOrder.indexOf(name);
      const next = index >= 0 ? currentOrder[index + 1] : undefined;
      if (next !== undefined && focusField(ctx, namespace, next)) return;
      const form = formRoots.get(ctx.store)?.get(namespace);
      if (form !== undefined) form.requestSubmit();
    });
  }

  const unregister = registerControl(ctx, namespace, name, control);
  ctx.disposers.push(() => {
    unregister();
    // Only remove shared state when the last same-name control leaves.
    if (controls.get(ctx.store)?.get(namespace)?.has(name) === true) return;
    const nextOrder = activeOrder(ctx, namespace).filter((entry) => entry !== name);
    const fields = { ...dict(ctx.store.getPath(`${namespace}.fields`)) };
    delete fields[name];
    ctx.store.batch(() => {
      ctx.store.setPath(`${namespace}.fieldOrder`, nextOrder);
      ctx.store.setPath(`${namespace}.fields`, fields);
    });
    recomputeValid(ctx, namespace);
  });

  validate();
  return root;
};

export const FORM_ELEMENTS: Readonly<Record<string, ElementFactory>> = Object.freeze({
  form: formElement,
  field: fieldElement,
});

/** Mobile-first, neutral web-native defaults. The layer is deliberately the weak
 * `dsx-elements` layer: theme sheets, component sidecars, inline styles and legacy
 * attribute mappings all outrank every declaration here. */
export const FORM_ELEMENTS_CSS = `@layer dsx-elements {
  .dsx-form {
    display: grid;
    align-content: start;
    gap: var(--dsx-form-spacing, 12px);
    width: 100%;
    min-width: 0;
    margin: 0;
  }
  .dsx-form-scroll { max-height: 100%; overflow: auto; overscroll-behavior: contain; }
  .dsx-field { display: grid; gap: 0.375rem; min-width: 0; color: var(--dsx-label); font: 400 1rem/1.35 var(--dsx-font); }
  .dsx-field-label {
    display: block;
    color: var(--dsx-secondary-label);
    font: 600 0.8125rem/1.25 var(--dsx-font);
    letter-spacing: 0.005em;
  }
  .dsx-field-label-copy { min-width: 0; }
  .dsx-field-control {
    appearance: none;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    margin: 0;
    padding: 0.6875rem 0.875rem;
    border: 0;
    border-radius: var(--dsx-radius);
    color: inherit;
    caret-color: var(--dsx-accent);
    background: var(--dsx-surface-recessed);
    box-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 7%, transparent);
    font: inherit;
    transition:
      background-color var(--dsx-motion-fast) ease;
  }
  .dsx-field-control::placeholder { color: var(--dsx-tertiary-label); opacity: 1; }
  .dsx-field-control:focus-visible {
    outline: none;
    background: var(--dsx-surface-level-1);
    box-shadow: inset 0 0 0 2px var(--dsx-accent);
  }
  .dsx-field[data-dsx-invalid="true"] .dsx-field-control {
    box-shadow: inset 0 0 0 2px var(--dsx-destructive);
  }
  .dsx-field-control:read-only {
    color: var(--dsx-secondary-label);
    background: color-mix(in srgb, var(--dsx-surface-recessed) 72%, transparent);
  }
  .dsx-field-control:disabled {
    cursor: not-allowed;
    opacity: .52;
  }
  .dsx-field-select {
    padding-inline-end: 2.5rem;
    background-image: linear-gradient(45deg, transparent 50%, var(--dsx-secondary-label) 50%),
                      linear-gradient(135deg, var(--dsx-secondary-label) 50%, transparent 50%);
    background-position: calc(100% - 1rem) 50%, calc(100% - .7rem) 50%;
    background-size: .35rem .35rem, .35rem .35rem;
    background-repeat: no-repeat;
  }
  .dsx-field-toggle-label {
    --dsx-field-toggle-width: 42px;
    --dsx-field-toggle-height: 24px;
    --dsx-field-toggle-thumb: 20px;
    --dsx-field-toggle-travel: 18px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.875rem;
    min-height: var(--dsx-control-height);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .dsx-field-toggle-input {
    appearance: none;
    position: relative;
    box-sizing: border-box;
    width: var(--dsx-field-toggle-width);
    height: var(--dsx-field-toggle-height);
    margin: 0;
    border: var(--dsx-hairline) solid var(--dsx-outline-soft);
    border-radius: 999px;
    background: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    box-shadow:
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 10%, transparent),
      inset 0 -1px 0 color-mix(in srgb, var(--dsx-control-knob) 36%, transparent);
    cursor: pointer;
    transition:
      background var(--dsx-motion-standard) ease,
      border-color var(--dsx-motion-fast) ease;
  }
  .dsx-field-toggle-input::after {
    content: "";
    position: absolute;
    box-sizing: border-box;
    width: var(--dsx-field-toggle-thumb);
    height: var(--dsx-field-toggle-thumb);
    inset: 1px auto auto 1px;
    border: var(--dsx-hairline) solid color-mix(in srgb, var(--dsx-label) 16%, transparent);
    border-radius: 50%;
    background: linear-gradient(165deg, var(--dsx-control-knob), var(--dsx-control-knob-shadow));
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 2px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 3px 7px color-mix(in srgb, var(--dsx-label) 14%, transparent);
    transition:
      transform var(--dsx-motion-standard) var(--dsx-ease-out),
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out);
  }
  .dsx-field-toggle-input:checked {
    border-color: color-mix(in srgb, var(--dsx-switch-on) 76%, var(--dsx-label));
    background: linear-gradient(
      165deg,
      color-mix(in srgb, var(--dsx-switch-on) 88%, var(--dsx-control-knob)),
      var(--dsx-switch-on)
    );
  }
  .dsx-field-toggle-input:checked::after { transform: translateX(var(--dsx-field-toggle-travel)); }
  [dir="rtl"] .dsx-field-toggle-input::after { transform: translateX(var(--dsx-field-toggle-travel)); }
  [dir="rtl"] .dsx-field-toggle-input:checked::after { transform: translateX(0); }
  .dsx-field-toggle-input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--dsx-switch-on);
  }
  .dsx-field-toggle-input:not(:disabled):active::after { transform: scale(1.06); }
  .dsx-field-toggle-input:checked:not(:disabled):active::after {
    transform: translateX(var(--dsx-field-toggle-travel)) scale(1.06);
  }
  [dir="rtl"] .dsx-field-toggle-input:not(:checked):not(:disabled):active::after {
    transform: translateX(var(--dsx-field-toggle-travel)) scale(1.06);
  }
  [dir="rtl"] .dsx-field-toggle-input:checked:not(:disabled):active::after { transform: scale(1.06); }
  .dsx-field-toggle-input:disabled { cursor: not-allowed; opacity: .48; }
  .dsx-field-error {
    min-height: 1em;
    color: var(--dsx-destructive);
    font: 500 0.8125rem/1.25 var(--dsx-font);
  }
  .dsx-field-error[hidden] { display: none; }
  .dsx-form-submit[data-dsx-valid="false"] { opacity: .5; }
  @media (hover: hover) and (pointer: fine) {
    .dsx-field-control:hover:not(:focus):not(:disabled) {
      background: color-mix(in srgb, var(--dsx-surface-recessed) 94%, var(--dsx-label));
      box-shadow:
        inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-label) 24%, var(--dsx-separator)),
        inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 8%, transparent);
    }
    .dsx-field-toggle-input:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--dsx-label) 24%, var(--dsx-separator));
    }
  }
  @media (min-width: 48rem) and (hover: hover) and (pointer: fine) {
    .dsx-field-control { min-height: 42px; padding-block: 0.625rem; }
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-field { gap: 0.25rem; font-size: 0.875rem; }
    .dsx-field-label, .dsx-field-error { font-size: 0.75rem; }
    .dsx-field-control {
      min-height: 38px;
      padding: 0.45rem 0.75rem;
    }
    .dsx-field-toggle-label {
      --dsx-field-toggle-width: 36px;
      --dsx-field-toggle-height: 20px;
      --dsx-field-toggle-thumb: 16px;
      --dsx-field-toggle-travel: 16px;
      min-height: var(--dsx-control-height);
      font-size: 0.875rem;
    }
  }
  @media (pointer: coarse) {
    .dsx-field-control,
    .dsx-field-toggle-label { min-height: 48px; font-size: 1rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-field-control, .dsx-field-toggle-input, .dsx-field-toggle-input::after { transition: none; }
  }
  @media (forced-colors: active) {
    .dsx-field-control, .dsx-field-toggle-input { border-color: CanvasText; }
    .dsx-field[data-dsx-invalid="true"] .dsx-field-control { border-color: Mark; }
    .dsx-field-control:focus-visible, .dsx-field-toggle-input:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: 2px;
      box-shadow: none;
    }
  }
}`;
