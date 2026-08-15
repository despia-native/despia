//
//  facet.ts - module-provided components (/web/18): the web-facet contract. A module's
//  web entry may carry `components: { Name: { mount(host, ctx) } }` — an HTML/CSS/JS
//  implementation for the cases where that is genuinely what the component IS
//  (visualizations, embeds, editor-grade widgets — the same reason a component is
//  ever Swift). Compose before you facet: the .dsx registry always wins resolution,
//  a facet only fills a tag the registry cannot. The kernel stores facets opaquely
//  (it names no DOM); THIS file is the contract the renderer holds them to. State
//  stays deck-owned: a facet emits events the deck handles — it never writes the
//  store (the /web/12 bridge rule, unchanged).
//

import type { Dict } from "@despia/kernel";

/** the live context a facet instance holds for its lifetime */
export type FacetCtx = {
  /** declared-attribute values (the dsx.attribute twin) — refreshed IN PLACE before update() */
  attrs: Dict;
  /** dispatch a declared component event → the consumer's on:<name> (payload rides dsx.this) */
  emit(name: string, payload?: Dict): void;
  /** aborts on unmount — listeners/observers/fetches registered on it die with the instance */
  signal: AbortSignal;
};

/** what mount() may return — per-instance hooks (one facet object serves many instances) */
export type FacetInstance = {
  /** re-invoked after a bound attribute changes (ctx.attrs already carries the new value) */
  update?(changed: string[]): void;
  /** teardown beyond what ctx.signal already covers */
  destroy?(): void;
};

export type FacetComponent = {
  /** render into host — light DOM by default (app CSS can restyle it, the /web/17 promise) */
  mount(host: HTMLElement, ctx: FacetCtx): FacetInstance | void;
  /** declared isolation (/web/18): "shadow" mounts into an attached shadow root — the
   *  trade (app CSS can no longer reach in) is explicit and declared, never silent */
  isolation?: "shadow";
};

/** the renderer-side view of an opaque kernel-registered facet (shape-checked, never cast blind) */
export function asFacetComponent(impl: unknown): FacetComponent | null {
  if (impl === null || typeof impl !== "object") return null;
  const m = (impl as { mount?: unknown }).mount;
  return typeof m === "function" ? (impl as FacetComponent) : null;
}
