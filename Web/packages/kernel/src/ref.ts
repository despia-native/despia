//
//  ref.ts — the `ref="name"` universal attribute's shared core. The law is the corpus,
//  OpenSource/Conformance/input/ref.json; the Kotlin twin is :core StackRef.kt and the Swift
//  twin is Engine/iOS/StackRef.swift.
//
//  WHAT REF IS FOR: publishing an element's backing platform view into the shared-handle
//  registry so a MODULE can reach it — Core/Capture's element and pdf actions, <scroll>'s
//  toElement, <Spotlight>'s target rect. The kernel names none of those consumers: it publishes
//  under a derived key and any module resolves it over the bus, which is what keeps `ref` a
//  kernel primitive rather than a feature.
//
//  THE ONE NON-OBVIOUS RULE is list recycling. A recycled row mounts the INCOMING view before
//  it unmounts the outgoing one, so a naive clear-on-disappear would kill the ref the visible
//  row now owns. Clearing therefore checks provider identity: only the CURRENT provider may
//  clear, and a stale provider's teardown is a no-op.
//

/** The registry key for a ref name, or null when the name is not a ref.
 *
 *  Namespaced with `ref.` so an author's name can never collide with a first-class handle like
 *  `web` or `view`. Exact case: a name is opaque, not a keyword. */
export function refKey(name: string | null | undefined): string | null {
  const trimmed = String(name ?? "").trim();
  return trimmed === "" ? null : `ref.${trimmed}`;
}

/** What `resolve` answers. `unknown_ref` covers both never-published and published-then-gone,
 *  because a dead view must never read as a live one. */
export type RefResolution<V> =
  | { readonly ok: true; readonly view: V }
  | { readonly ok: false; readonly error: "unknown_ref" };

/**
 * The provider table behind `ref=`. Renderer-neutral so one corpus judges three runtimes; each
 * platform adapter owns the actual weak handle and calls in on appear and disappear.
 */
export class RefRegistry<V> {
  #entries = new Map<string, { view: V | null }>();

  /** Publish (or replace) the provider for `name`. The LAST provider wins. */
  provide(name: string, view: V): void {
    const key = refKey(name);
    if (key === null) return;
    this.#entries.set(key, { view });
  }

  /** Clear `name`, but ONLY if `view` is still the current provider — the recycling rule. */
  clear(name: string, view: V): void {
    const key = refKey(name);
    if (key === null) return;
    const entry = this.#entries.get(key);
    if (entry && entry.view === view) this.#entries.delete(key);
  }

  /** The platform's weak handle went away without a teardown call. */
  collect(name: string): void {
    const key = refKey(name);
    if (key === null) return;
    const entry = this.#entries.get(key);
    if (entry) entry.view = null;
  }

  resolve(name: string): RefResolution<V> {
    const key = refKey(name);
    if (key === null) return { ok: false, error: "unknown_ref" };
    const entry = this.#entries.get(key);
    if (!entry || entry.view === null) return { ok: false, error: "unknown_ref" };
    return { ok: true, view: entry.view };
  }
}
