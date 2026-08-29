import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { charCount } from "@despia/kernel";
import { ELEMENTS } from "../src/elements.ts";
import {
  FORM_ELEMENTS,
  FORM_ELEMENTS_CSS,
  FORM_LIMITS,
  normalizeFormInput,
  normalizeFormOptions,
  parseValidationRules,
  validateFormValue,
} from "../src/forms.ts";

test("form and field are concrete public DOM primitives", () => {
  assert.equal(ELEMENTS.form, undefined, "unrelated embeds keep the form implementation out");
  Object.assign(ELEMENTS, FORM_ELEMENTS);
  assert.equal(typeof ELEMENTS.form, "function");
  assert.equal(typeof ELEMENTS.field, "function");
});

test("validation rules preserve pattern commas in the dedicated pattern attribute", () => {
  assert.deepEqual(parseValidationRules("required, email, minLength:8,pattern"), [
    { name: "required", argument: "" },
    { name: "email", argument: "" },
    { name: "minLength", argument: "8" },
    { name: "pattern", argument: "" },
  ]);
  assert.equal(validateFormValue("AB-1234", "text", "required,pattern", "^[A-Z]{2}-\\d{4}$"), "");
  assert.equal(validateFormValue("ABC-1234", "text", "required,pattern", "^[A-Z]{2}-\\d{4}$"), "Invalid format");
});

test("built-in validators and first-error/custom-message behavior match Foundation", () => {
  assert.equal(validateFormValue("   ", "text", "required,email"), "Required");
  assert.equal(validateFormValue("wrong", "email", "required,email"), "Enter a valid email");
  assert.equal(validateFormValue("person@example.com", "email", "required,email"), "");
  assert.equal(validateFormValue("+1 (212) 555-0100", "phone", "phone"), "");
  assert.equal(validateFormValue("123", "phone", "phone"), "Enter a valid phone number");
  assert.equal(validateFormValue("https://example.com/a", "url", "url"), "");
  assert.equal(validateFormValue("/relative", "url", "url"), "Enter a valid URL");
  assert.equal(validateFormValue("abc", "text", "minLength:4", "", "Use four characters"), "Use four characters");
  assert.equal(validateFormValue(true, "toggle", "required"), "");
  assert.equal(validateFormValue(false, "toggle", "required"), "Required");
});

test("length validation counts user-perceived characters", () => {
  const family = "👨‍👩‍👧‍👦";
  assert.equal(charCount(family), 1);
  assert.equal(validateFormValue(family, "text", "maxLength:1"), "");
  assert.equal(validateFormValue(`${family}x`, "text", "maxLength:1"), "Must be at most 1 characters");
});

test("regex and input work are bounded and catastrophic patterns fail closed", () => {
  assert.equal(validateFormValue("a".repeat(128), "text", "pattern", "^(a+)+$"), "Invalid format");
  assert.equal(
    validateFormValue("x", "text", "pattern", "a".repeat(FORM_LIMITS.maxPatternCharacters + 1)),
    "Invalid format",
  );
  assert.match(
    validateFormValue("x".repeat(FORM_LIMITS.maxInputCharacters + 1), "text", ""),
    /at most 16384/,
  );
  assert.equal(parseValidationRules("x,".repeat(FORM_LIMITS.maxRules + 10)).length, FORM_LIMITS.maxRules + 1);
  assert.equal(charCount(normalizeFormInput("🙂".repeat(FORM_LIMITS.maxInputCharacters + 100))), FORM_LIMITS.maxInputCharacters);
});

test("picker normalization accepts scalar/object rows and enforces allocation limits", () => {
  assert.deepEqual(normalizeFormOptions(["One", { key: 2, title: "Two" }], "key", "title"), [
    { value: "One", label: "One" },
    { value: "2", label: "Two" },
  ]);
  const many = normalizeFormOptions(Array.from({ length: FORM_LIMITS.maxOptions + 50 }, (_, i) => `v${i}`));
  assert.equal(many.length, FORM_LIMITS.maxOptions);
});

test("the multiline well keeps a three-line floor and grows (wave-7 F5)", () => {
  assert.match(
    FORM_ELEMENTS_CSS,
    /\.dsx-field-multiline\s*\{[^}]*min-height:\s*calc\(3lh \+ 1\.25rem \+ 2px\);[^}]*resize:\s*vertical;[^}]*field-sizing:\s*content;/s,
    "textarea rides the same well with a 3-line minimum, autogrow enhancement and a vertical handle",
  );
});

test("form defaults stay in the weak element layer and expose override handles", () => {
  assert.ok(FORM_ELEMENTS_CSS.startsWith("@layer dsx-elements {"));
  for (const handle of [".dsx-form", ".dsx-field", ".dsx-field-control", ".dsx-form-submit"]) {
    assert.ok(FORM_ELEMENTS_CSS.includes(handle));
  }
  assert.ok(!FORM_ELEMENTS_CSS.includes("!important"));
  assert.ok(FORM_ELEMENTS_CSS.includes("::placeholder { color: var(--dsx-tertiary-label)"));
  assert.ok(FORM_ELEMENTS_CSS.includes("@media (forced-colors: active)"));
  assert.ok(FORM_ELEMENTS_CSS.includes("outline: 2px solid Highlight"));
  assert.match(
    FORM_ELEMENTS_CSS,
    /\.dsx-field-control\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-height:\s*44px;/s,
    "mobile form controls keep a real 44px target after font and padding resolution",
  );
  assert.match(
    FORM_ELEMENTS_CSS,
    /@media \(min-width: 64rem\)[\s\S]*?\.dsx-field-control\s*\{[^}]*min-height:\s*38px;/,
    "precision-pointer form controls keep a 38px visual target",
  );
  const source = readFileSync(new URL("../src/forms.ts", import.meta.url), "utf8");
  assert.ok(source.includes('if (node.attrs["spacing"] !== undefined)'));
  assert.ok(source.includes('if (labelText.length === 0) control.setAttribute("aria-label", accessibleFallback)'));
});
