//
//  route-module.ts — `dsx.module.route` on DSX Web, backed by the live FrameRouter.
//
//  The reference documents route.push/replace/pop/popTo/popToRoot/reset as ONE surface on
//  every renderer, and both natives register a `route` module (Router.kt RouterActions,
//  Router.swift) — but the web renderer only ever wired the DECLARATIVE twin (`href=`), so
//  a programmatic navigation in an action (the sign-in redirect every app has) warned
//  `not_loaded` here and worked everywhere else. This module closes that gap with the same
//  action names over the router's own URL entry (`navigatePath`), which carries the guard,
//  redirect and echo behavior a link tap gets — one navigation law, two spellings.
//
//  The component verbs (pushComponent/presentComponent/updateComponent) stay native-only
//  for now: their web twin is frame-mount plumbing, tracked in the parity floor.
//
//  Re-boot registers a fresh instance bound to the new router (register() replaces by
//  scheme); a disposed router refuses every navigation itself, so a stale handle is inert.
//

import { defineModule, type WebModule } from "@despia/kernel";

import type { FrameRouter } from "./router.ts";

function pathArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

export function routeModule(router: FrameRouter): WebModule {
  return defineModule({
    scheme: "route",
    actions: {
      push:      (c) => { router.navigatePath(pathArg(c.args("path"), "/"), "push"); c.resolve(); },
      replace:   (c) => { router.navigatePath(pathArg(c.args("path"), "/"), "replace"); c.resolve(); },
      reset:     (c) => { router.navigatePath(pathArg(c.args("path"), "/"), "reset"); c.resolve(); },
      pop:       (c) => { router.pop(); c.resolve(); },
      popTo:     (c) => { router.popTo(pathArg(c.args("path"), "")); c.resolve(); },
      popToRoot: (c) => { router.popToRoot(); c.resolve(); },
    },
  });
}
