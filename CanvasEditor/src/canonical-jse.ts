/*
 * Canonical JSE bridge for the zero-dependency Canvas SDK.
 *
 * Canvas ships as plain JavaScript, but its expression semantics must remain
 * byte-for-byte aligned with the kernel interpreter that the web runtime uses.
 * The release builder bundles this small adapter and its kernel dependencies into
 * `canonical-jse.js`; Canvas then consumes it in both Node and its file:// page.
 */
import { JSE, JSESeams, StackStore } from "../../Web/packages/kernel/src/jse/jse.ts";
import { NSNull } from "../../Web/packages/kernel/src/jse/values.ts";

type Dict = Record<string, unknown>;
type CanvasScope = {
  vars?: Dict;
  item?: unknown;
  attrs?: Dict;
  platform?: string;
};

function toJseValue(value: unknown): unknown {
  if (value === null) return NSNull;
  if (Array.isArray(value)) return value.map(toJseValue);
  if (value !== null && typeof value === "object") {
    const out: Dict = {};
    for (const [key, child] of Object.entries(value as Dict)) out[key] = toJseValue(child);
    return out;
  }
  return value;
}

function evaluate(source: string, input: CanvasScope | Dict = {}): unknown {
  const spec: CanvasScope = "vars" in input || "item" in input || "attrs" in input
    ? input as CanvasScope
    : { vars: input as Dict };
  const vars = toJseValue(spec.vars ?? {}) as Dict;
  const store = new StackStore();
  for (const [key, value] of Object.entries(vars)) store.vars.set(key, value);

  // Canvas evaluates synchronously, so temporarily wiring the kernel's host seams
  // is deterministic and avoids a second, semantically-drifting namespace model.
  const priorState = JSESeams.stateVars;
  const priorCookie = JSESeams.cookieJar;
  const priorPlatform = JSESeams.platformOS;
  JSESeams.stateVars = () => vars;
  JSESeams.cookieJar = () => (vars.cookie && typeof vars.cookie === "object" ? vars.cookie as Dict : {});
  JSESeams.platformOS = spec.platform ?? "ios";
  try {
    const item = {
      ...(spec.item && typeof spec.item === "object" ? toJseValue(spec.item) as Dict : {}),
      ...(spec.attrs && typeof spec.attrs === "object" ? toJseValue(spec.attrs) as Dict : {}),
      item: toJseValue(spec.item ?? null),
      attribute: toJseValue(spec.attrs ?? {}),
    };
    return JSE.eval(String(source), store, item);
  } finally {
    JSESeams.stateVars = priorState;
    JSESeams.cookieJar = priorCookie;
    JSESeams.platformOS = priorPlatform;
  }
}

const api = { evaluate };
(globalThis as typeof globalThis & { DSXCanvasJSE?: typeof api }).DSXCanvasJSE = api;

export { api as DSXCanvasJSE };
