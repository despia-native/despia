//
//  index.ts - @despia/element (/web/13 W10): define an EXPOSED DSX component as a REAL
//  custom element. The component head already IS the web-component contract:
//    <attribute as="productId"> → observed attribute `product-id` + JS property
//    `productId` (both converge on the same dsx.attribute signals — fine-grained,
//    no re-mount), <event as="purchase"> → el.dispatchEvent(new CustomEvent(...)),
//    body <slot name=…> → a NATIVE <slot> (the host page's light DOM projects).
//  Embeds render in shadow DOM (isolation both ways) with the design-system +
//  compiled app sheets adopted as ONE constructable stylesheet; theming pierces the
//  boundary via CSS custom properties. SSR: a pre-rendered declarative-shadow-DOM
//  fragment paints first and the upgrade replace-mounts the live view (the
//  @despia/server v0 client contract); no markup = plain client render on upgrade.
//

import { JSESeams, ModuleRegistry, isDict, number, type ApiSeed, type Dict, type WebModule } from "@despia/kernel";
import type { Registry } from "@despia/compiler/resolve";
import { LAYER_STATEMENT } from "@despia/compiler/cssmap";
import { instantiate, type Instance, type ScopedEnv } from "@despia/dom/mount";
import { TOKENS_CSS, ELEMENTS_CSS } from "@despia/dom/theme";

export type EmbedSpec = {
  /** the custom-element tag (dash required — the package prefix supplies it) */
  tag: string;
  /** qualified component name in the registry ("shop.Paywall") */
  component: string;
  /** the compiled registry carrying the component (and its requires chain) */
  registry: Registry;
  /** module chunks bundled with this embed (the honest subset — everything else
   *  reads dsx.has() === false) */
  modules?: WebModule[];
  /** the scoped environment (studio-apps.md §8), forwarded verbatim to instantiate —
   *  a host embedding a subtree it did not write threads its funnel/gate/budgets here */
  env?: ScopedEnv;
};

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const camel = (s: string): string => s.replace(/-([a-z0-9])/g, (_, c: string) => String(c).toUpperCase());

/** SSR fragment (doc 13 scenario 2): a pre-rendered DSD may carry an api-seed payload
 *  (renderEmbedFragmentAsync). Read + consume it from the shadow root and return it as
 *  the `apiSeeds` slice of instantiate's options so the upgrade adopts the server-
 *  resolved data and skips the initial fetch. Absent (CSR, or a no-api embed) → `{}` so
 *  the whole call spreads to nothing — this WHOLE function tree-shakes out when the embed
 *  has no <api> (__DSX_OPTIONAL_APIS__ fold, /web/13 byte budget). Fail-open on bad JSON. */
function embedSeedOpts(root: ShadowRoot): { apiSeeds?: { [as: string]: ApiSeed } } {
  const script = root.querySelector("script[data-dsx-ssr]");
  if (script === null) return {};
  script.remove(); // consumed once; the upgrade replaces the DSD content anyway
  try {
    const parsed: unknown = JSON.parse(script.textContent ?? "");
    if (!isDict(parsed)) return {};
    const seeds: { [as: string]: ApiSeed } = {};
    for (const [as, envelope] of Object.entries(parsed as Dict)) {
      if (isDict(envelope)) seeds[as] = envelope as ApiSeed;
    }
    return Object.keys(seeds).length > 0 ? { apiSeeds: seeds } : {};
  } catch { return {}; }
}

/** one adopted sheet per registry — layer statement → tokens → elements → app css */
const sheetCache = new WeakMap<Registry, CSSStyleSheet>();
function sheetFor(registry: Registry): CSSStyleSheet {
  let sheet = sheetCache.get(registry);
  if (sheet === undefined) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync([LAYER_STATEMENT, TOKENS_CSS, ELEMENTS_CSS, registry.css].join("\n"));
    sheetCache.set(registry, sheet);
  }
  return sheet;
}

/** attribute text → the declared default's type (13: coercion per default type;
 *  JSON text for rich data — parse failure = warn + ignore) */
function coerce(raw: string | null, def: string | undefined, as: string): unknown {
  if (raw === null) return def !== undefined ? coerce(def, undefined, as) : null;
  const t = raw.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { return JSON.parse(t); } catch {
      console.warn(`[dsx element] <${as}> attribute is not valid JSON — ignored`);
      return null;
    }
  }
  if (def !== undefined) {
    const d = def.trim();
    if (d === "true" || d === "false") return t !== "false" && t.length > 0;
    if (d.length > 0 && !Number.isNaN(Number(d))) { const n = number(t); return n ?? t; }
  }
  if (t === "true" || t === "false") return t === "true";
  return raw;
}

/** Define `spec.component` as `<spec.tag>` — the compile target over contracts that
 *  already exist (zero changes to how DSX works). Idempotent per tag. */
export function defineDsxElement(spec: EmbedSpec): void {
  if (customElements.get(spec.tag) !== undefined) return;
  const ir = spec.registry.components[spec.component];
  if (ir === undefined) throw new Error(`[dsx element] unknown component ${spec.component}`);
  for (const m of spec.modules ?? []) ModuleRegistry.register(m);

  const attrDecls = ir.head.attributes;
  const defaults = new Map(attrDecls.map((a) => [a.as, a.default]));
  const observed = attrDecls.map((a) => kebab(a.as));

  class DsxEmbedElement extends HTMLElement {
    static observedAttributes = observed;
    #instance: Instance | null = null;
    /** the live attrs dict the instance reads (dsx.attribute.*) */
    #attrs: Dict = {};
    /** property writes staged before connect (rich data — `el.items = […]`) */
    #staged: Dict = {};

    connectedCallback(): void {
      if (this.#instance !== null) return;
      // the embed seam: markup can branch on dsx.platform.embed (/web/14)
      JSESeams.platformEmbed = true;
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      root.adoptedStyleSheets = [sheetFor(spec.registry)];
      for (const a of attrDecls) {
        const fromDom = this.getAttribute(kebab(a.as));
        this.#attrs[a.as] = Object.prototype.hasOwnProperty.call(this.#staged, a.as)
          ? this.#staged[a.as]
          : coerce(fromDom, a.default, a.as);
      }
      this.#instance = instantiate(ir, spec.registry, {
        attrs: this.#attrs,
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        // SSR api-seed (scenario 2): read from the DSD before the upgrade replaces it.
        // Gated on __DSX_OPTIONAL_APIS__ so a no-api embed folds embedSeedOpts out AND
        // this spread collapses to nothing — byte-identical to v0 (/web/13 byte budget).
        ...((globalThis as typeof globalThis & { __DSX_OPTIONAL_APIS__?: boolean })
          .__DSX_OPTIONAL_APIS__ !== false ? embedSeedOpts(root) : {}),
        emitEvent: (name, payload) => {
          this.dispatchEvent(new CustomEvent(name, { detail: payload, bubbles: true, composed: true }));
        },
      });
      // markup present = it painted first (DSD); the upgrade replace-mounts the
      // live view (the @despia/server v0 client contract — adopt-hydration is W6)
      root.replaceChildren(this.#instance.root);
    }

    disconnectedCallback(): void {
      this.#instance?.unmount();
      this.#instance = null;
    }

    attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
      const as = camel(name);
      this.write(as, coerce(value, defaults.get(as), as));
    }

    /** attribute + property writes converge here → the same signals (no re-mount).
     *  ONE store.set — it writes jse.vars itself; a manual pre-write would make the
     *  deep-equal dedupe see prev == next and elide the notification. */
    write(as: string, value: unknown): void {
      if (this.#instance === null) { this.#staged[as] = value; return; }
      this.#attrs[as] = value;
      this.#instance.ctx.store.set("dsx.attribute", { ...this.#attrs });
    }

    read(as: string): unknown {
      if (this.#instance !== null) return this.#attrs[as];
      if (Object.prototype.hasOwnProperty.call(this.#staged, as)) return this.#staged[as];
      return coerce(this.getAttribute(kebab(as)), defaults.get(as), as);
    }

    static {
      // JS properties (rich data: `pw.items = […]` — no JSON round-trip)
      for (const a of attrDecls) {
        Object.defineProperty(this.prototype, a.as, {
          get(this: DsxEmbedElement) { return this.read(a.as); },
          set(this: DsxEmbedElement, v: unknown) { this.write(a.as, v); },
          enumerable: true,
          configurable: true,
        });
      }
    }
  }

  customElements.define(spec.tag, DsxEmbedElement);
}

/** the default tag for an exposed component: `<package>-<component>` lowercased —
 *  the dash requirement satisfied by construction (13: naming) */
export function defaultTag(scheme: string, component: string): string {
  return `${scheme.toLowerCase()}-${component.toLowerCase()}`;
}
