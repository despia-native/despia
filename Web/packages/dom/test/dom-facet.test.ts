import { test } from "node:test";
import assert from "node:assert/strict";

import dom from "../../../../../ClosedSource/DSX/Modules/Mandatory/Dom/web/index.js";

type Failure = { code: string; message: string; recoverable: boolean };

function context(values: Record<string, unknown> = {}): {
  ctx: { args(name: string): unknown; fail(code: string, message: string, recoverable: boolean): void };
  failures: Failure[];
} {
  const failures: Failure[] = [];
  return {
    ctx: {
      args: (name) => values[name],
      fail: (code, message, recoverable) => failures.push({ code, message, recoverable }),
    },
    failures,
  };
}

test("Dom browser facet targets named WebView controllers", () => {
  const calls: unknown[][] = [];
  const controller = {
    load: (url: string) => calls.push(["load", url]),
    reload: () => calls.push(["reload"]),
    back: () => calls.push(["back"]),
    forward: () => calls.push(["forward"]),
    stop: () => calls.push(["stop"]),
    eval: (script: string) => { calls.push(["eval", script]); return "result"; },
    call: (name: string, args: unknown[]) => { calls.push(["call", name, args]); return 7; },
    set: (name: string, value: unknown) => calls.push(["set", name, value]),
    css: (name: string, value: string) => calls.push(["css", name, value]),
  };
  (globalThis as Record<symbol, unknown>)[Symbol.for("dsx.web-surfaces.v1")] = new Map([["checkout", controller]]);

  const load = context({ target: "checkout", url: "https://example.com" });
  dom.actions.load(load.ctx);
  const evaluate = context({ target: "checkout", js: "document.title" });
  assert.equal(dom.actions.eval(evaluate.ctx), "result");
  const call = context({ target: "checkout", fn: "window.onNative", args: ["ok"] });
  assert.equal(dom.actions.call(call.ctx), 7);
  assert.deepEqual(calls, [
    ["load", "https://example.com"],
    ["eval", "document.title"],
    ["call", "window.onNative", ["ok"]],
  ]);
  assert.deepEqual([...load.failures, ...evaluate.failures, ...call.failures], []);
});

test("Dom browser facet fails missing surfaces and invalid scripts structurally", () => {
  (globalThis as Record<symbol, unknown>)[Symbol.for("dsx.web-surfaces.v1")] = new Map();
  const absent = context({ target: "gone" });
  dom.actions.reload(absent.ctx);
  assert.equal(absent.failures[0]?.code, "no_webview");

  const invalid = context({ js: "" });
  dom.actions.eval(invalid.ctx);
  assert.equal(invalid.failures[0]?.code, "missing_js");
  assert.equal(invalid.failures[0]?.recoverable, false);
});

test("Dom browser facet exposes cross-origin denial instead of swallowing it", () => {
  const controller = {
    eval: () => { throw new DOMException("Blocked a frame with origin", "SecurityError"); },
  };
  (globalThis as Record<symbol, unknown>)[Symbol.for("dsx.web-surfaces.v1")] = new Map([["web", controller]]);
  const denied = context({ js: "document.title" });
  dom.actions.eval(denied.ctx);
  assert.equal(denied.failures[0]?.code, "origin_denied");
  assert.equal(denied.failures[0]?.recoverable, true);
});
