import test from "node:test";
import assert from "node:assert/strict";

import {
  onInputEdge, registerInputDeclarations, resetInputRuntime,
} from "../src/input.ts";

type Listener = (event: Record<string, unknown>) => void;

class FakeWindow {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

const target = {
  tagName: "DIV",
  isContentEditable: false,
  closest: (): null => null,
};

function pointer(pointerType: "mouse" | "touch" | "pen", pointerId: number): Record<string, unknown> {
  return { pointerType, pointerId, clientX: 10, clientY: 10, target };
}

test("touch bindings ignore mouse focus clicks and accept each contact gesture once", () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const window = new FakeWindow();
  Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });

  const owner = {};
  const edges: string[] = [];
  const unregister = registerInputDeclarations(owner, [
    { as: "jump", keys: "Space", touch: "tap" },
  ]);
  const unsubscribe = onInputEdge("jump", (event) => edges.push(event.name));

  try {
    window.dispatch("pointerdown", pointer("mouse", 1));
    window.dispatch("pointerup", pointer("mouse", 1));
    assert.deepEqual(edges, [], "an ordinary mouse focus click is not touch=\"tap\"");

    let prevented = false;
    window.dispatch("keydown", {
      code: "Space", key: " ", repeat: false, isComposing: false, target,
      preventDefault: () => { prevented = true; },
    });
    window.dispatch("keyup", { code: "Space", key: " ", target });
    assert.equal(prevented, true);
    assert.deepEqual(edges, ["jump"], "the first Space press emits exactly one edge");

    window.dispatch("pointerdown", pointer("touch", 2));
    window.dispatch("pointerup", pointer("touch", 2));
    assert.deepEqual(edges, ["jump", "jump"], "a touchscreen tap emits exactly one edge");

    window.dispatch("pointerdown", pointer("pen", 3));
    window.dispatch("pointerup", pointer("pen", 3));
    assert.deepEqual(edges, ["jump", "jump", "jump"], "a pen tap is contact input too");
  } finally {
    unsubscribe();
    unregister();
    resetInputRuntime();
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", priorWindow);
  }
});
