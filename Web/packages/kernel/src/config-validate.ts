//
//  config-validate.ts — the CONFIG VALIDATION grammar (D1).
//
//  A config entry may declare three words:
//
//    "pattern":  a regular expression the value must match
//    "validate": a JSE expression — `true` passes, `false` fails, a STRING fails with
//                that string as the message (computed reasons beat static ones)
//    "message":  the author's words when `pattern` fails, and the fallback when
//                `validate` returns a bare false
//
//  ONE implementation, three consumers: the dashboard's live form, the server's intake on
//  the way to the database, and (ported, not duplicated) the Ruby build gates in
//  config_schema.rb. A rule that passes at the form and fails at intake is the bug this
//  shape exists to prevent — the user sees a green field and a rejected save, and neither
//  side is obviously wrong.
//
//  TWO CONTRACTS WORTH READING TWICE.
//
//  1. AN EMPTY VALUE PASSES. `required` is the separate word that makes emptiness fail.
//     This is not a convenience; it is the contract packages/dom/src/forms.ts already
//     implements and the Swift form contract it was written against. An optional field
//     carrying a pattern would otherwise be impossible to leave blank.
//
//  2. EVERY FAILURE MODE FAILS CLOSED, never throws. A malformed regex, a catastrophic
//     one, an over-long one, a `validate` expression that reaches into nothing — each
//     produces a failed field, because this runs inside a request handler and inside a
//     keystroke handler, and an exception in either is a worse outcome than a red field.
//
//  Corpus: OpenSource/Conformance/config/validation.json.
//

import { JSE, StackStore } from "./jse/jse.ts";
import { reDoSProne } from "./jse/regex.ts";
import { string } from "./jse/values.ts";

/** The same ceilings packages/dom/src/forms.ts applies. A synchronous regex has no timeout
 *  on a single-threaded event loop, so an over-long pattern is refused unread. */
export const CONFIG_VALIDATION_LIMITS = Object.freeze({
  maxPatternCharacters: 512,
  maxMessageCharacters: 200,
});

export const DEFAULT_PATTERN_MESSAGE = "Invalid format";
export const DEFAULT_VALIDATE_MESSAGE = "Invalid";

/** The validation words a config entry may declare. Everything else on the entry (type,
 *  options, default) is read elsewhere; this reads only the rules. */
export interface ConfigValidationRules {
  pattern?: string;
  validate?: string;
  message?: string;
}

export interface ConfigValidationResult {
  ok: boolean;
  /** present only when ok is false */
  message?: string;
}

const PASS: ConfigValidationResult = Object.freeze({ ok: true });

function fail(message: string): ConfigValidationResult {
  const trimmed = message.length > CONFIG_VALIDATION_LIMITS.maxMessageCharacters
    ? message.slice(0, CONFIG_VALIDATION_LIMITS.maxMessageCharacters)
    : message;
  return { ok: false, message: trimmed };
}

/** Every scalar a value contributes. A list entry validates member by member, because a
 *  pattern on a list means "every entry matches" — one bad member fails the field. */
function scalars(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => string(v));
  return [string(value)];
}

/** Does one scalar satisfy the pattern? Empty passes; anything unrunnable fails closed. */
function patternPasses(value: string, pattern: string): boolean {
  if (value.length === 0 || pattern.length === 0) return true;
  if (pattern.length > CONFIG_VALIDATION_LIMITS.maxPatternCharacters) return false;
  // Refused UNREAD rather than executed. reDoSProne is the kernel's existing tri-runtime
  // heuristic (Jse.kt / Stack.swift carry the twins); this plane calls it, never reimplements.
  if (reDoSProne(pattern)) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/**
 * Validate one config value against its declared rules.
 *
 * Order is fixed — pattern, then validate — so the message a user sees never depends on
 * which rule an implementation happened to check first.
 */
export function validateConfigValue(value: unknown, rules: ConfigValidationRules): ConfigValidationResult {
  const parts = scalars(value);
  const nonEmpty = parts.filter((part) => part.length > 0);
  // The emptiness contract: nothing to validate, so nothing fails. `required` is elsewhere.
  if (nonEmpty.length === 0) return PASS;

  const pattern = typeof rules.pattern === "string" ? rules.pattern : "";
  const declared = typeof rules.message === "string" && rules.message.length > 0 ? rules.message : "";

  if (pattern.length > 0) {
    for (const part of nonEmpty) {
      if (!patternPasses(part, pattern)) return fail(declared.length > 0 ? declared : DEFAULT_PATTERN_MESSAGE);
    }
  }

  const expression = typeof rules.validate === "string" ? rules.validate : "";
  if (expression.length === 0) return PASS;

  for (const part of nonEmpty) {
    let verdict: unknown;
    try {
      // A fresh store per evaluation: `validate` is a pure predicate over one name, and a
      // shared store would let one field's expression observe another's writes.
      verdict = JSE.evalBlock(`return ${expression}`, new StackStore(), { value: part });
    } catch {
      return fail(declared.length > 0 ? declared : DEFAULT_VALIDATE_MESSAGE);
    }
    // A STRING is a computed reason and beats the static `message`: it is the whole reason
    // to reach for `validate` instead of `pattern`.
    if (typeof verdict === "string") {
      return fail(verdict.length > 0 ? verdict : (declared.length > 0 ? declared : DEFAULT_VALIDATE_MESSAGE));
    }
    if (verdict !== true) return fail(declared.length > 0 ? declared : DEFAULT_VALIDATE_MESSAGE);
  }
  return PASS;
}

/** Are these rules well formed? Used by the BUILD gates (and mirrored in config_schema.rb),
 *  so an unrunnable pattern is caught when it is authored rather than when a user types. */
export function checkConfigRules(rules: ConfigValidationRules): string[] {
  const problems: string[] = [];
  const pattern = typeof rules.pattern === "string" ? rules.pattern : "";
  if (pattern.length > CONFIG_VALIDATION_LIMITS.maxPatternCharacters) {
    problems.push(`pattern is longer than ${CONFIG_VALIDATION_LIMITS.maxPatternCharacters} characters`);
  } else if (pattern.length > 0) {
    if (reDoSProne(pattern)) problems.push("pattern is catastrophic-backtracking prone (star height 2) — rewrite it");
    else {
      try { new RegExp(pattern); } catch { problems.push("pattern is not a valid regular expression"); }
    }
  }
  if (typeof rules.message === "string" && rules.message.length > CONFIG_VALIDATION_LIMITS.maxMessageCharacters) {
    problems.push(`message is longer than ${CONFIG_VALIDATION_LIMITS.maxMessageCharacters} characters`);
  }
  return problems;
}
