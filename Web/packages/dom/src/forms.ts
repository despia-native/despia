//
//  forms.ts - the semantic web twin of Foundation's public <form>/<field> pair.
//  The browser owns the controls (real form/input/select/label/button elements);
//  DSX owns the shared state namespace and the validation lifecycle.
//

import {
  charCount, graphemes, isDict, number, reDoSProne, string, truthy, type Dict,
} from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
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

type FocusableField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
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
  } else if (type === "text" && booleanAttribute(initialBoundText(node, api, "multiline", "false"))) {
    // multiline="true" is a REAL textarea (wave-7 F5: the single-line input rendered
    // prose fields one line tall) — same well class, same value/limit/validation
    // seams; rows=3 is the floor and CSS owns growth (autogrow where field-sizing
    // exists, a vertical resize handle elsewhere).
    const area = document.createElement("textarea");
    area.className = "dsx-field-control dsx-field-multiline";
    area.rows = 3;
    area.placeholder = initialBoundText(node, api, "placeholder", "");
    accessibleFallback = area.placeholder || name;
    area.maxLength = inferredMaximum(rules);
    control = area;
    area.addEventListener("input", () => {
      const limited = normalizeFormInput(area.value);
      if (limited !== area.value) area.value = limited;
      api.writeBack(valuePath, area.value);
      writeMeta(ctx, namespace, name, { dirty: true });
      validate();
      api.handler("change", { value: area.value });
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
  // disabled= / disabled-if= (the W9 grammar wave): the field's real control carries
  // the native state — validation writes and Return-walk skip it via focusability,
  // and the sheet's :disabled discipline paints it. The root stamp lets the label
  // and helper slot dim with their control.
  {
    let declaredDisabled = false;
    let conditionalDisabled = false;
    const reflectDisabled = (): void => {
      const disabled = declaredDisabled || conditionalDisabled;
      control.disabled = disabled;
      root.dataset["dsxDisabled"] = String(disabled);
    };
    if (node.attrs["disabled"] !== undefined) {
      api.bindText(node.attrs["disabled"], (value) => { declaredDisabled = truthy(value); reflectDisabled(); });
    }
    if (node.attrs["disabled-if"] !== undefined) {
      api.bindValue(node.attrs["disabled-if"], (value) => { conditionalDisabled = truthy(value); reflectDisabled(); });
    }
  }
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
  // A multiline field keeps Enter for the newline it means there.
  if (type !== "toggle" && type !== "picker" && control.tagName !== "TEXTAREA") {
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
 * attribute mappings all outrank every declaration here.
 *
 * Wave-4 fidelity: motion is part of the default. Transform transitions ride
 * `--dsx-ease-spring` (overshoot on transform ONLY); color/background/box-shadow ride
 * `--dsx-dur-base` ease; opacity stays linear. Every duration token collapses to 0ms
 * under prefers-reduced-motion (theme.ts), and the explicit reduce block below keeps
 * the moving parts inert even when a stronger sheet re-pins a duration. */
export const FORM_ELEMENTS_CSS = `@layer dsx-elements {
  .dsx-form {
    display: grid;
    align-content: start;
    gap: var(--dsx-form-spacing, var(--dsx-space-3));
    width: 100%;
    min-width: 0;
    margin: 0;
  }
  .dsx-form-scroll {
    max-height: 100%;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-color: var(--dsx-separator) transparent;
  }
  .dsx-field {
    display: grid;
    gap: var(--dsx-space-2);
    min-width: 0;
    color: var(--dsx-label);
    font: 400 1rem/1.35 var(--dsx-font);
    letter-spacing: var(--dsx-type-body-tracking);
  }
  .dsx-field-label {
    display: block;
    color: var(--dsx-secondary-label);
    font: 500 var(--dsx-type-footnote-size)/1.3 var(--dsx-font);
    letter-spacing: var(--dsx-type-footnote-tracking);
    transition: color var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-field:focus-within > .dsx-field-label { color: var(--dsx-accent); }
  .dsx-field-label-copy { min-width: 0; }
  ` +
// The field WELL: a soft recessed fill seated by the xs elevation whisper (its
// contact line / inner highlight now defines the edge, so the hard separator border
// relaxes to the soft outline). Hover deepens the fill one step on the fast
// duration; focus takes the border to label ink under the accent ring. The radius
// rides the size rhythm through the tokens: --dsx-radius-lg is the regular/large
// well step (14px at mobile scale, 12px at the 64rem fine-pointer scale); a
// compact well re-pins --dsx-field-well-radius to var(--dsx-radius) (the 8px
// fine-pointer step).
`  .dsx-field-control {
    appearance: none;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    margin: 0;
    padding: 0.625rem calc(var(--dsx-control-padding-inline) - 1px);
    border: 1px solid var(--dsx-outline-soft);
    border-radius: var(--dsx-field-well-radius, var(--dsx-radius-lg));
    color: inherit;
    caret-color: var(--dsx-accent);
    background: var(--dsx-surface-recessed);
    box-shadow: var(--dsx-shadow-xs);
    font: inherit;
    transition:
      border-color var(--dsx-dur-base) var(--dsx-ease),
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      box-shadow var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-field-control::placeholder { color: var(--dsx-tertiary-label); opacity: 1; }
  .dsx-field-control:focus-visible {
    outline: none;
    border-color: var(--dsx-label);
    background: var(--dsx-background);
    box-shadow: var(--dsx-focus-ring), var(--dsx-shadow-xs);
  }
  .dsx-field-control:read-only:not(.dsx-field-select) {
    color: var(--dsx-secondary-label);
    background: var(--dsx-fill);
  }
  .dsx-field-control:disabled {
    cursor: not-allowed;
    opacity: .5;
    filter: saturate(.5);
  }
  .dsx-field[data-dsx-disabled="true"] :is(.dsx-field-label, .dsx-field-label-copy) { opacity: .5; }
  /* The MULTILINE well (wave-7 F5): a real textarea in the SAME well — a three-line
     floor (line box + block padding + borders, border-box), autogrow where
     field-sizing exists, a vertical resize handle everywhere else. The well's own
     look is untouched. */
  .dsx-field-multiline {
    min-height: calc(3lh + 1.25rem + 2px);
    resize: vertical;
    field-sizing: content;
    overflow-wrap: anywhere;
  }
  .dsx-field-select {
    padding-inline-end: 2.5rem;
    background-image: linear-gradient(45deg, transparent 50%, var(--dsx-secondary-label) 50%),
                      linear-gradient(135deg, var(--dsx-secondary-label) 50%, transparent 50%);
    background-position: calc(100% - 1rem) 50%, calc(100% - .7rem) 50%;
    background-size: .35rem .35rem, .35rem .35rem;
    background-repeat: no-repeat;
    cursor: pointer;
  }
  [dir="rtl"] .dsx-field-select { background-position: .7rem 50%, 1rem 50%; }
  .dsx-field-toggle-label {
    --dsx-field-toggle-width: 63px;
    --dsx-field-toggle-height: 28px;
    --dsx-field-toggle-thumb-width: 36px;
    --dsx-field-toggle-thumb: 24px;
    --dsx-field-toggle-inset: 2px;
    --dsx-field-toggle-stretch: 6px;
    --dsx-field-toggle-travel: calc(var(--dsx-field-toggle-width) - var(--dsx-field-toggle-thumb-width) - 2 * var(--dsx-field-toggle-inset));
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--dsx-space-3);
    min-height: var(--dsx-control-height);
    color: inherit;
    font: inherit;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  /* Web polyfill: iOS-26-ish capsule, glass-free. Flat track so the fill
     crossfades; white pill thumb. Tokens are the customization seam
     (--dsx-field-toggle-*, --dsx-switch-on). Hit target = the padded label
     row; held Space keeps :active, so keyboard presses animate like touch. */
  .dsx-field-toggle-input {
    appearance: none;
    position: relative;
    box-sizing: border-box;
    width: var(--dsx-field-toggle-width);
    height: var(--dsx-field-toggle-height);
    margin: 0;
    border: 0;
    border-radius: var(--dsx-radius-full);
    background: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    box-shadow: inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-label) 10%, transparent);
    cursor: pointer;
    transition:
      background-color var(--dsx-dur-base) var(--dsx-ease),
      box-shadow var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-field-toggle-input::after {
    content: "";
    position: absolute;
    box-sizing: border-box;
    inset: var(--dsx-field-toggle-inset) auto auto var(--dsx-field-toggle-inset);
    width: var(--dsx-field-toggle-thumb-width);
    height: var(--dsx-field-toggle-thumb);
    border-radius: var(--dsx-radius-full);
    background: var(--dsx-control-knob);
    box-shadow: var(--dsx-shadow-1);
    will-change: transform;
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-spring),
      width var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-field-toggle-input:checked {
    background: var(--dsx-switch-on);
    box-shadow: inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-switch-on) 84%, var(--dsx-label));
  }
  .dsx-field-toggle-input:checked::after { transform: translateX(var(--dsx-field-toggle-travel)); }
  [dir="rtl"] .dsx-field-toggle-input::after { transform: translateX(var(--dsx-field-toggle-travel)); }
  [dir="rtl"] .dsx-field-toggle-input:checked::after { transform: translateX(0); }
  .dsx-field-toggle-input:focus-visible {
    outline: none;
    box-shadow: var(--dsx-focus-ring);
  }
  /* Pressed: +6px stretch anchored to the near edge; the checked side subtracts it
     from the travel so the growth points back toward center. */
  .dsx-field-toggle-input:not(:disabled):active::after {
    width: calc(var(--dsx-field-toggle-thumb-width) + var(--dsx-field-toggle-stretch));
  }
  .dsx-field-toggle-input:checked:not(:disabled):active::after {
    transform: translateX(calc(var(--dsx-field-toggle-travel) - var(--dsx-field-toggle-stretch)));
  }
  [dir="rtl"] .dsx-field-toggle-input:not(:checked):not(:disabled):active::after {
    transform: translateX(calc(var(--dsx-field-toggle-travel) - var(--dsx-field-toggle-stretch)));
  }
  [dir="rtl"] .dsx-field-toggle-input:checked:not(:disabled):active::after { transform: translateX(0); }
  .dsx-field-toggle-input:disabled { cursor: not-allowed; opacity: .42; filter: saturate(.45); }
  /* The helper/error slot is RESERVED: hidden keeps the one-line box (min-height
     matches the 1.35 line box exactly), so revealing an error never jumps layout.
     visibility keeps the empty live region out of the accessibility tree. */
  .dsx-field-error {
    min-height: 1.35em;
    color: var(--dsx-danger);
    font: var(--dsx-type-footnote-weight) var(--dsx-type-footnote-size)/1.35 var(--dsx-font);
    letter-spacing: var(--dsx-type-footnote-tracking);
  }
  .dsx-field-error[hidden] { display: block; visibility: hidden; }
  /* Error reveal: color plus a 4px slide-in. Deliberately no shake. */
  .dsx-field-error:not([hidden]) { animation: dsx-field-error-in var(--dsx-dur-base) var(--dsx-ease); }
  @keyframes dsx-field-error-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .dsx-button.dsx-form-submit {
    --dsx-button-shadow:
      inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-accent) 74%, var(--dsx-label)),
      0 1px 2px color-mix(in srgb, var(--dsx-accent) 24%, transparent);
    width: 100%;
    background: var(--dsx-accent);
    color: var(--dsx-on-accent);
    padding-inline: 1rem;
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-spring),
      background-color var(--dsx-dur-base) var(--dsx-ease),
      box-shadow var(--dsx-dur-fast) var(--dsx-ease),
      filter var(--dsx-dur-fast) var(--dsx-ease),
      opacity var(--dsx-dur-fast) linear;
  }
  .dsx-form-submit[data-dsx-valid="false"] { opacity: .55; filter: saturate(.6); }
  @media (hover: hover) and (pointer: fine) {
    /* Hover deepens the well's fill one step and lifts the edge to the full
       separator (selects are :read-only by spec, so they need their own row; an
       authored readOnly text input keeps its distinct --dsx-fill wash). */
    .dsx-field-control:hover:not(:focus-visible):not(:disabled):not(:read-only),
    .dsx-field-select:hover:not(:focus-visible):not(:disabled) {
      border-color: var(--dsx-separator);
      background: color-mix(in srgb, var(--dsx-surface-recessed) 95%, var(--dsx-label));
    }
    .dsx-field-toggle-input:not(:checked):not(:disabled):hover {
      background: color-mix(in srgb, var(--dsx-secondary-label) 30%, var(--dsx-surface-recessed));
    }
    .dsx-button.dsx-form-submit:not(:disabled):not([aria-disabled="true"]):hover {
      background: var(--dsx-accent);
      background-image: linear-gradient(0deg, var(--dsx-state-layer-hover), var(--dsx-state-layer-hover));
      filter: saturate(1.06) brightness(1.03);
    }
  }
  .dsx-button.dsx-form-submit:not(:disabled):not([aria-disabled="true"]):active {
    --dsx-button-shadow:
      inset 0 0 0 var(--dsx-hairline) color-mix(in srgb, var(--dsx-accent) 78%, var(--dsx-label)),
      inset 0 2px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent);
    background: var(--dsx-accent);
    transform: scale(0.97);
    filter: saturate(.96) brightness(.96);
    transition-duration: var(--dsx-dur-fast);
    transition-timing-function: var(--dsx-ease);
  }
  /* The danger skin keys on the REVEALED error ([aria-errormessage] is stamped only
     once the field is touched or the form submitted, on both render paths), so a
     pristine required form does not open as a wall of red. */
  .dsx-field[data-dsx-invalid="true"] .dsx-field-control[aria-errormessage] {
    border-color: var(--dsx-danger);
  }
  .dsx-field[data-dsx-invalid="true"] .dsx-field-control[aria-errormessage]:focus-visible {
    border-color: var(--dsx-danger);
    box-shadow: var(--dsx-shadow-xs);
  }
  .dsx-field[data-dsx-invalid="true"] .dsx-field-toggle-input[aria-errormessage] {
    box-shadow: inset 0 0 0 var(--dsx-hairline) var(--dsx-danger);
  }
  ` +
// Form-plane adaptation: the checkbox/radio/stepper factories live in other files,
// so their pass lands here behind deterministic specificity (the attribute prefixes
// outrank the base sheets in any assembly order). The check DRAWS via a staged
// width/height reveal, vertex-anchored so the rotation never drifts.
`  .dsx-checkbox[data-dsx-component="checkbox"] { --dsx-checkbox-size: 20px; }
  .dsx-checkbox[data-dsx-component="checkbox"] .dsx-checkbox-box {
    border: 2px solid color-mix(in srgb, var(--dsx-secondary-label) 88%, transparent);
    border-radius: var(--dsx-radius-sm);
    background: var(--dsx-surface-recessed);
    box-shadow: none;
    transition: transform var(--dsx-dur-base) var(--dsx-ease-spring);
  }
  .dsx-checkbox[data-dsx-component="checkbox"] .dsx-checkbox-box::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: calc(var(--dsx-radius-sm) - 2px);
    background: var(--dsx-checkbox-color);
    opacity: 0;
    transform: scale(.5);
    transition: none;
  }
  .dsx-checkbox[data-dsx-component="checkbox"] .dsx-checkbox-box::after {
    inset: auto 8px 3px auto;
    width: 0;
    height: 0;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg) scale(1);
    transform-origin: 100% 100%;
    transition: none;
  }
  .dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box {
    border-color: var(--dsx-checkbox-color);
    background: var(--dsx-surface-recessed);
    box-shadow: none;
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-spring),
      border-color var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box::before {
    opacity: 1;
    transform: scale(1);
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-out),
      opacity var(--dsx-dur-base) linear;
  }
  .dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box::after {
    width: 5px;
    height: 10px;
    transition:
      width var(--dsx-dur-fast) var(--dsx-ease) var(--dsx-dur-base),
      height var(--dsx-dur-base) var(--dsx-ease) calc(var(--dsx-dur-base) + var(--dsx-dur-fast));
  }
  .dsx-checkbox[data-dsx-component="checkbox"] input:not(:disabled):active + .dsx-checkbox-box {
    transform: scale(.95);
    transition-duration: var(--dsx-dur-fast);
  }
  .dsx-radio-group[role="radiogroup"] .dsx-radio-mark {
    transition:
      background-color var(--dsx-dur-base) var(--dsx-ease),
      border-color var(--dsx-dur-base) var(--dsx-ease),
      transform var(--dsx-dur-base) var(--dsx-ease-spring);
  }
  .dsx-radio-group[role="radiogroup"] .dsx-radio-option:active .dsx-radio-mark {
    transform: scale(.95);
    transition-duration: var(--dsx-dur-fast);
  }
  .dsx-stepper .dsx-stepper-btn {
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-base) var(--dsx-ease-spring);
  }
  .dsx-stepper .dsx-stepper-btn:not(:disabled):active {
    transform: scale(0.97);
    transition-duration: var(--dsx-dur-fast);
  }
  @media (min-width: 48rem) and (hover: hover) and (pointer: fine) {
    .dsx-field-control { min-height: 42px; padding-block: 0.5rem; }
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-field {
      gap: var(--dsx-space-1);
      font-size: var(--dsx-type-callout-size);
      letter-spacing: var(--dsx-type-callout-tracking);
    }
    .dsx-field-label, .dsx-field-error { font-size: var(--dsx-type-caption-size); }
    .dsx-field-control {
      min-height: 38px;
      padding: 0.375rem calc(var(--dsx-control-padding-inline) - 1px);
    }
    .dsx-field-toggle-label {
      --dsx-field-toggle-width: 51px;
      --dsx-field-toggle-height: 24px;
      --dsx-field-toggle-thumb-width: 30px;
      --dsx-field-toggle-thumb: 20px;
      min-height: var(--dsx-control-height);
      font-size: var(--dsx-type-callout-size);
    }
    .dsx-button.dsx-form-submit { padding-inline: 0.75rem; }
  }
  @media (pointer: coarse) {
    .dsx-field-control,
    .dsx-field-toggle-label { min-height: 48px; font-size: var(--dsx-type-reading-size); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-field-control, .dsx-field-label,
    .dsx-field-toggle-input, .dsx-field-toggle-input::after,
    .dsx-button.dsx-form-submit,
    .dsx-checkbox[data-dsx-component="checkbox"] .dsx-checkbox-box,
    .dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box,
    .dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box::before,
    .dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box::after,
    .dsx-radio-group[role="radiogroup"] .dsx-radio-mark,
    .dsx-stepper .dsx-stepper-btn { transition: none; }
    .dsx-field-error:not([hidden]) { animation: none; }
  }
  @media (forced-colors: active) {
    .dsx-field-control, .dsx-field-toggle-input { border: 1px solid ButtonText; }
    .dsx-field-toggle-input::after { border: 1px solid ButtonText; }
    .dsx-field[data-dsx-invalid="true"] .dsx-field-control { border-color: Mark; }
    .dsx-field-control:focus-visible, .dsx-field-toggle-input:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: 2px;
      box-shadow: none;
    }
    .dsx-checkbox[data-dsx-component="checkbox"] .dsx-checkbox-box::before { display: none; }
    .dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box {
      border-color: Highlight;
      background: Highlight;
    }
    .dsx-checkbox[data-dsx-component="checkbox"] input:checked + .dsx-checkbox-box::after { transition: none; }
  }
}`;
