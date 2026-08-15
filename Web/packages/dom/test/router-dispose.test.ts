//
//  router-dispose.test.ts — a FrameRouter must be able to DIE. The ROOT PLAN builds one
//  router per candidate into the SAME host element, so a candidate that fails forward
//  leaves a router behind: `host.replaceChildren()` strips its DOM but not its `window`
//  listeners, not its `route.path` state sink, and not its readiness records. A zombie
//  router keeps asserting its own frame depth against the live router's URL.
//
//  Everything below runs in bare node against a MINIMAL window stub — the constructor's
//  binding is guarded only by `typeof window !== "undefined"`, so the register/remove
//  contract is testable without a DOM. The start()-bound half (popstate + the DSXState
//  sink) needs a real document and is proven by the demo walk; what this file pins is
//  that the teardown ledger exists, is spent exactly once, and leaves nothing behind.
//
//  Runs in its own process (node --test isolates per file), so the window stub installed
//  here cannot leak into router.test.ts's corpus cases.
//

import { test } from "node:test";
import assert from "node:assert/strict";

type Listener = (e: unknown) => void;

/** The smallest thing FrameRouter's constructor will accept as a window, with a ledger of
 *  what is still bound. `removeEventListener` must actually drop the SAME function object
 *  the constructor registered — passing an arrow that merely looks alike silently leaks. */
function installWindowStub(): { live: () => Array<[string, Listener]>; restore: () => void } {
  const bound: Array<[string, Listener]> = [];
  const stub = {
    addEventListener(type: string, fn: Listener) { bound.push([type, fn]); },
    removeEventListener(type: string, fn: Listener) {
      const i = bound.findIndex(([t, f]) => t === type && f === fn);
      if (i >= 0) bound.splice(i, 1);
    },
    innerWidth: 1024,
  };
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const prev = g.window;
  g.window = stub;
  return {
    live: () => bound,
    restore: () => { if (had) g.window = prev; else delete g.window; },
  };
}

const REGISTRY = { components: {}, routes: [], css: "" };

test("dispose removes every window listener the router bound", async () => {
  const win = installWindowStub();
  try {
    const { FrameRouter } = await import("../src/router.ts");
    const router = new FrameRouter(
      REGISTRY as unknown as ConstructorParameters<typeof FrameRouter>[0],
      null as unknown as HTMLElement,
    );
    assert.deepEqual(win.live().map(([t]) => t).sort(), ["pagehide", "resize"],
                     "the constructor binds resize AND pagehide on window (pagehide banks the "
                     + "leaving scroll offsets, which is the write side of the restore ledger)");
    router.dispose();
    assert.deepEqual(win.live(), [], "dispose leaves nothing bound");
  } finally {
    win.restore();
  }
});

test("dispose is idempotent — a second call is inert, not a double-remove", async () => {
  const win = installWindowStub();
  try {
    const { FrameRouter } = await import("../src/router.ts");
    const a = new FrameRouter(
      REGISTRY as unknown as ConstructorParameters<typeof FrameRouter>[0],
      null as unknown as HTMLElement,
    );
    const b = new FrameRouter(
      REGISTRY as unknown as ConstructorParameters<typeof FrameRouter>[0],
      null as unknown as HTMLElement,
    );
    assert.equal(win.live().length, 4, "two routers, two window listeners each");
    a.dispose();
    a.dispose();
    assert.equal(win.live().length, 2,
                 "only A's listeners went — a repeat dispose must not reach into B's");
    b.dispose();
    assert.deepEqual(win.live(), []);
  } finally {
    win.restore();
  }
});

test("a router per candidate does not accumulate listeners when each is disposed", async () => {
  const win = installWindowStub();
  try {
    const { FrameRouter } = await import("../src/router.ts");
    // The root-plan advance shape: mount candidate N+1 only after retiring candidate N.
    let live: InstanceType<typeof FrameRouter> | null = null;
    for (let i = 0; i < 5; i += 1) {
      live?.dispose();
      live = new FrameRouter(
        REGISTRY as unknown as ConstructorParameters<typeof FrameRouter>[0],
        null as unknown as HTMLElement,
      );
      assert.equal(win.live().length, 2, `attempt ${i}: exactly one live router, with its two listeners`);
    }
    live?.dispose();
    assert.deepEqual(win.live(), [], "an exhausted plan leaves no router behind either");
  } finally {
    win.restore();
  }
});
