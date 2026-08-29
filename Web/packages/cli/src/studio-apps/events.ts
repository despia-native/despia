//
//  studio-apps/events.ts — the editor-session event hub (studio-apps.md §7.1).
//
//  One SSE lane, admission-gated like every /edit door. The HOST is the only publisher:
//  the surgery door and the documents door emit document.saved, the dev server's rebuild
//  emits build.finished, and the apps endpoints emit app.installed/enabled/disabled. An
//  app SUBSCRIBES in its manifest (`events` on a contribution row) — there is no runtime
//  subscribe verb — and the AppMount facet dispatches each delivery to the app's declared
//  handler action through the scoped runner, budgeted per entry. Payload shapes are
//  corpus-pinned (Conformance/studio-apps/events.json).
//

import type { ServerResponse } from "node:http";

import { EDITOR_EVENTS } from "./manifest.ts";

export type AppEventHub = {
  subscribe(res: ServerResponse): void;
  emit(kind: string, payload: Record<string, unknown>): void;
  /** delivered count per kind — the projection surfaces it so a quiet lane is inspectable */
  counts(): Record<string, number>;
};

export function createAppEventHub(): AppEventHub {
  const clients = new Set<ServerResponse>();
  const counts: Record<string, number> = {};
  return {
    subscribe(res: ServerResponse): void {
      clients.add(res);
      res.on("close", () => clients.delete(res));
      res.write(": studio-apps event lane\n\n");
    },
    emit(kind: string, payload: Record<string, unknown>): void {
      if (!(EDITOR_EVENTS as readonly string[]).includes(kind)) {
        // the closed list is the contract — an unknown kind is a host defect, said loudly
        console.warn(`[despia apps] refused to emit unknown event kind "${kind}"`);
        return;
      }
      counts[kind] = (counts[kind] ?? 0) + 1;
      const frame = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of clients) client.write(frame);
    },
    counts(): Record<string, number> {
      return { ...counts };
    },
  };
}
