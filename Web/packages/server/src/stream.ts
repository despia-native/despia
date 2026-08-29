//
//  stream.ts - out-of-order SSR streaming (doc 02 "Streaming", the W6 remainder — rides
//  the live adapter). The non-streaming pass is untouched: `executeSsrApis` awaits every
//  ssr-eligible NON-deferred block and the document flushes with their data. What this
//  adds is the other half of the `defer` contract: the document (deferred subtrees render
//  their loading branches) flushes IMMEDIATELY with a tiny inline queue hook, the
//  response stays open, the deferred blocks run concurrently server-side, and each
//  resolution flushes ONE `<script>` chunk pushing `{as, seed}` into
//  `window.__DSX_STREAM__` (+ nudging `__DSX_STREAM_APPLY__` when the client boot has
//  already installed it). The client (dom boot.ts/adopt.ts) seeds a still-loading block
//  and ignores a chunk for a block that already settled itself — data can only arrive
//  EARLIER than the client fetch, never flash backwards.
//
//  FAIL-OPEN at every arm (the executeSsrApis law): a deferred block that errors or
//  times out simply never flushes a chunk and keeps its client-fetch path. The walk
//  covers the WHOLE tree (route component + nested instances, the runInstanceSsrApis
//  shape), first-wins by `as` — the hydration payload's flat key space. A render
//  failure mid-stream flushes the ERROR MARKER comment before closing — never a
//  half-written stream without it (doc 02's failure semantics).
//

import type { Dict, ApiSeed } from "@despia/kernel";
import type { Registry } from "@despia/compiler/resolve";
import { executeSsrApis, executeStreamApis } from "./render.ts";
import { renderPageWithSeeds, serializeHydrationPayload, type ShellOptions } from "./page-render.ts";

/** doc 02: the error-marker chunk — a client/CDN reading a stream that carries this
 *  comment knows the tail is not a rendering artifact. */
export const STREAM_ERROR_MARKER = "<!-- dsx-stream-error -->";

const HOOK = `<script>window.__DSX_STREAM__=window.__DSX_STREAM__||[];</script>`;

function chunkScript(as: string, seed: ApiSeed): string {
  const payload = serializeHydrationPayload({ as, seed } as unknown as Dict);
  return `<script>window.__DSX_STREAM__.push(${payload});window.__DSX_STREAM_APPLY__&&window.__DSX_STREAM_APPLY__();</script>`;
}

/** One streamed SSR document. The FIRST enqueue is the complete document minus its
 *  closing tags (plus the queue hook); each deferred resolution enqueues its chunk; the
 *  closing tags end the stream. Callable wherever web streams exist (edge included —
 *  no Node built-ins). */
export function renderPageStream(
  registry: Registry,
  qualified: string,
  vars: Dict,
  meta: { title?: string; description?: string },
  opts: ShellOptions & { ssrTimeoutMs?: number } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const put = (s: string): void => controller.enqueue(encoder.encode(s));
      let tail = "";
      try {
        const ssrOpts = opts.ssrTimeoutMs !== undefined ? { timeoutMs: opts.ssrTimeoutMs } : {};
        const seeds = await executeSsrApis(registry, qualified, vars, ssrOpts);
        const html = renderPageWithSeeds(registry, qualified, vars, meta, opts, seeds);
        // Split ahead of the closing tags so chunks land INSIDE <body> (valid HTML all
        // the way down); a shell with no </body> streams after the full document, which
        // every parser accepts (the content is script-only).
        const close = html.lastIndexOf("</body>");
        const head = close === -1 ? html : html.slice(0, close);
        tail = close === -1 ? "" : html.slice(close);
        put(head + HOOK);
        await executeStreamApis(registry, qualified, vars, seeds, ssrOpts, (as, seed) => {
          put(chunkScript(as, seed));
        });
        put(tail);
        controller.close();
      } catch (e) {
        // Never a half-written stream without the marker; the tail still closes the
        // document so the flushed shell renders (its blocks keep the client-fetch path).
        try { put(STREAM_ERROR_MARKER + tail); } catch { /* the controller may be gone */ }
        try { controller.close(); } catch { /* already closed/errored */ }
        void e;
      }
    },
  });
}
