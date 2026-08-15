import { test } from "node:test";
import assert from "node:assert/strict";

import { installButtonKeyboardActivation } from "../src/keyboard.ts";
import { coldRootHistoryUrl } from "../src/history.ts";

type Listener = (event: FakeEvent) => void;

class FakeRoot {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: EventListener): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener as unknown as Listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type: string, listener: EventListener): void {
    const wanted = listener as unknown as Listener;
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== wanted));
  }
  dispatch(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeButton {
  readonly tagName = "BUTTON";
  disabled = false;
  isConnected = true;
  clicks = 0;
  private readonly onClick: () => void;
  constructor(onClick: () => void = () => {}) { this.onClick = onClick; }
  closest(selector: string): FakeButton | null { return selector === "button" ? this : null; }
  click(): void { this.clicks += 1; this.onClick(); }
}

class FakeEvent {
  defaultPrevented = false;
  isComposing = false;
  metaKey = false;
  ctrlKey = false;
  altKey = false;
  readonly target: FakeButton;
  readonly key: string;
  constructor(target: FakeButton, key: string) { this.target = target; this.key = key; }
  preventDefault(): void { this.defaultPrevented = true; }
}

function hardwareDefault(button: FakeButton, event: FakeEvent): void {
  if (!event.defaultPrevented && !button.disabled) button.click();
}

test("focused real buttons activate exactly once for Enter across hardware and bridge events", () => {
  const root = new FakeRoot();
  const dispose = installButtonKeyboardActivation(root as unknown as Document);
  assert.equal(installButtonKeyboardActivation(root as unknown as Document), dispose, "install is idempotent");
  const button = new FakeButton();
  const event = new FakeEvent(button, "Enter");

  root.dispatch("keydown", event);
  hardwareDefault(button, event); // models a browser that would also run its native default

  assert.equal(event.defaultPrevented, true);
  assert.equal(button.clicks, 1, "the DSX handler and browser default never double-fire");
  dispose();
});

test("Space activates on key-up once, never scrolls, and cancels when focus leaves", () => {
  const root = new FakeRoot();
  const dispose = installButtonKeyboardActivation(root as unknown as Document);
  const button = new FakeButton();
  const down = new FakeEvent(button, " ");
  root.dispatch("keydown", down);
  assert.equal(down.defaultPrevented, true, "Space key-down suppresses page scrolling");
  assert.equal(button.clicks, 0, "Space follows native key-up timing");

  const up = new FakeEvent(button, " ");
  root.dispatch("keyup", up);
  hardwareDefault(button, up);
  assert.equal(up.defaultPrevented, true);
  assert.equal(button.clicks, 1);

  root.dispatch("keydown", new FakeEvent(button, " "));
  root.dispatch("focusout", new FakeEvent(button, ""));
  root.dispatch("keyup", new FakeEvent(button, " "));
  assert.equal(button.clicks, 1, "a blurred Space press is cancelled");
  dispose();
});

test("disabled, modified, composed and already-handled key events remain inert", () => {
  const root = new FakeRoot();
  const dispose = installButtonKeyboardActivation(root as unknown as Document);
  const button = new FakeButton();

  button.disabled = true;
  root.dispatch("keydown", new FakeEvent(button, "Enter"));
  button.disabled = false;

  const modified = new FakeEvent(button, "Enter");
  modified.metaKey = true;
  root.dispatch("keydown", modified);

  const composing = new FakeEvent(button, "Enter");
  composing.isComposing = true;
  root.dispatch("keydown", composing);

  const handled = new FakeEvent(button, "Enter");
  handled.preventDefault();
  root.dispatch("keydown", handled);

  assert.equal(button.clicks, 0);
  dispose();
});

for (const mode of ["pointer", "keyboard"] as const) {
  test(`cold-route ${mode} Back reveals the root URL and Reload stays there`, () => {
    const detail = "https://example.test/demo/site/flex?density=compact";
    const rootUrl = coldRootHistoryUrl("/demo/site/", detail);
    const entries = [rootUrl, detail];
    let index = 1;
    const button = new FakeButton(() => { index = Math.max(0, index - 1); });

    if (mode === "pointer") {
      button.click();
    } else {
      const eventRoot = new FakeRoot();
      const dispose = installButtonKeyboardActivation(eventRoot as unknown as Document);
      eventRoot.dispatch("keydown", new FakeEvent(button, "Enter"));
      dispose();
    }

    assert.equal(button.clicks, 1, "Back activates exactly once");
    assert.equal(entries[index], rootUrl, "the revealed root frame and address bar agree");
    assert.equal(new URL(entries[index]!).pathname, "/demo/site/", "Reload resolves the root, not stale /flex");
  });
}
