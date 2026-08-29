//
//  route-module.test.ts — `dsx.module.route` exists on DSX Web and speaks the native
//  Router's names. The regression this pins: programmatic navigation from an action
//  (`dsx.module.route.replace({path})` after a sign-in) warned `not_loaded` on web while
//  working on iOS and Android — the declarative `href=` was the only wired spelling.
//
//  ORDER: the registry is one instance per test process and has no unregister, so the
//  fallback tests run FIRST (they need the scheme unowned / fallback-owned); the plain
//  registrations below then take ownership the normal way.
//

import assert from "node:assert/strict";
import test from "node:test";

import { ModuleRegistry, defineModule } from "@despia-native/kernel";

import { routeModule } from "../src/route-module.ts";
import type { FrameRouter } from "../src/router.ts";

function stub(): { log: string[]; router: FrameRouter } {
  const log: string[] = [];
  const router = {
    navigatePath: (path: string, mode: string) => { log.push(`${mode}:${path}`); return true; },
    pop: () => { log.push("pop"); },
    popTo: (path: string) => { log.push(`popTo:${path}`); },
    popToRoot: () => { log.push("popToRoot"); },
  } as unknown as FrameRouter;
  return { log, router };
}

test("route: a re-boot's fresh fallback replaces the previous fallback's stale router", async () => {
  const first = stub();
  ModuleRegistry.register(routeModule(first.router), { fallback: true });
  const second = stub();
  ModuleRegistry.register(routeModule(second.router), { fallback: true });
  await ModuleRegistry.call("route.push", { path: "/notes" });
  assert.deepEqual(first.log, []);
  assert.deepEqual(second.log, ["push:/notes"]);
});

// The regression this pins: boot registered its route twin UNMARKED, shadowing the
// bundled Routing facet — NavBar's `route.chrome` claim became unknown_action and the
// web system bar (title + Back) vanished on every pushed screen (the Demo /flex walk).
test("route: boot's fallback registration yields to a provided route module", async () => {
  const claims: string[] = [];
  ModuleRegistry.register(defineModule({
    scheme: "route",
    actions: { chrome: (c) => { claims.push(String(c.args("title"))); c.resolve(); } },
  }));
  const { log, router } = stub();
  ModuleRegistry.register(routeModule(router), { fallback: true });
  await ModuleRegistry.call("route.chrome", { title: "Flex layout" });
  assert.deepEqual(claims, ["Flex layout"]);
  assert.deepEqual(log, []);
});

test("route: the six navigation verbs map onto the router's own URL entry", async () => {
  const { log, router } = stub();
  ModuleRegistry.register(routeModule(router));

  await ModuleRegistry.call("route.push", { path: "/notes" });
  await ModuleRegistry.call("route.replace", { path: "/signin" });
  await ModuleRegistry.call("route.reset", { path: "/" });
  await ModuleRegistry.call("route.pop", {});
  await ModuleRegistry.call("route.popTo", { path: "/notes" });
  await ModuleRegistry.call("route.popToRoot", {});

  assert.deepEqual(log, [
    "push:/notes", "replace:/signin", "reset:/", "pop", "popTo:/notes", "popToRoot",
  ]);
});

test("route: a missing path falls back the way the natives do (push/replace → \"/\")", async () => {
  const { log, router } = stub();
  ModuleRegistry.register(routeModule(router));
  await ModuleRegistry.call("route.push", {});
  await ModuleRegistry.call("route.replace", {});
  assert.deepEqual(log, ["push:/", "replace:/"]);
});
