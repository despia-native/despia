//
//  The preview worker entry: ONE worker fronts every `*.<apex>` preview app
//  (preview-hosting.md). Hand-maintained platform infrastructure — this is Despia's own
//  worker, not a per-project emission, so prepare_server does not own it.
//
//  Bindings (wrangler.jsonc):
//    · BUCKET   — the R2 object store holding immutable `apps/{app}/{deployment}/…` trees
//    · POINTERS — the KV namespace holding the ONLY mutable plane, the hostname pointers
//    · DSX_PREVIEW_ADMIN_KEY — the control-plane secret (wrangler secret put, never here);
//      absent ⇒ the control plane answers 404, fail closed
//    · DSX_PREVIEW_APEX — the tenant apex (a var, e.g. "despia.app")
//
//  Boot is LAZY and per-env (Workers env is an argument, not a global) — the
//  bootloader-workers.ts precedent, keyed on the env object itself.
//

import {
  createPreviewHandler,
  type PreviewObjectStore,
  type PreviewPointerStore,
} from "../../../src/preview-workers.ts";

interface PreviewEnv {
  BUCKET: PreviewObjectStore;
  POINTERS: PreviewPointerStore;
  DSX_PREVIEW_ADMIN_KEY?: string;
  DSX_PREVIEW_APEX?: string;
}

const booted = new WeakMap<object, (req: Request) => Promise<Response>>();

export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    let handler = booted.get(env);
    if (handler === undefined) {
      handler = createPreviewHandler({
        bucket: env.BUCKET,
        pointers: env.POINTERS,
        apex: env.DSX_PREVIEW_APEX ?? "despia.app",
        adminKey: env.DSX_PREVIEW_ADMIN_KEY,
      });
      booted.set(env, handler);
    }
    return handler(request);
  },
};
