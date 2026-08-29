//
//  wire-fixtures.ts — the ONE fixture table for the host wire contract, shared by every
//  bootloader's suite (host.test.ts on node, the deno edge section, and the workerd leg in
//  test/workers/). W1's parity claim is "same fixtures as node and deno"; sharing the table
//  is what keeps that sentence checkable instead of three suites drifting apart.
//

import type { HostConfig, HostContext, ServerRoute } from "../src/host.ts";

// :id listed BEFORE /orders/summary on purpose — the sorted table, not input order, must decide
export const wireRoutes: ServerRoute[] = [
  { key: "root", chain: "server.http", action: "root", method: "GET", path: "/" },
  { key: "health", chain: "server.http", action: "health", method: "GET", path: "/health" },
  { key: "order", chain: "shop", action: "order", method: "GET", path: "/orders/:id" },
  { key: "summary", chain: "shop", action: "summary", method: "GET", path: "/orders/summary" },
  { key: "create", chain: "shop", action: "create", method: "post", path: "/orders" }, // lowercase method on purpose
  { key: "merge", chain: "shop", action: "merge", method: "POST", path: "/merge/:c" },
  { key: "boom", chain: "shop", action: "boom", method: "GET", path: "/boom" },
  { key: "ghost", chain: "shop", action: "ghost", method: "GET", path: "/ghost" }, // no registered handler
  { key: "nothing", chain: "shop", action: "nothing", method: "GET", path: "/nothing" },
  { key: "ctx", chain: "shop", action: "echoCtx", method: "GET", path: "/ctx" },
];

export const wireConfig: HostConfig = {
  routes: wireRoutes,
  buildInfo: { digest: "fixture-digest" },
  handlers: {
    "server.http": {
      root: () => "root",
      health: () => ({ up: true }),
    },
    shop: {
      order: (args) => ({ got: args }),
      summary: () => "summary-route",
      create: async (args) => ({ created: args }),
      merge: (args) => args,
      boom: () => {
        throw new Error("kaboom");
      },
      nothing: () => undefined,
      echoCtx: (_args, ctx: HostContext) => ({ buildInfo: ctx.buildInfo, identity: ctx.identity, envX: ctx.env("X") ?? null }),
    },
  },
};
