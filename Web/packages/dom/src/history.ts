// Pure browser-history URL helpers kept DOM/kernel-free so navigation activation
// regressions can execute without constructing a renderer.

/** The history entry underneath a cold-opened detail route. A direct URL initially
 * owns the browser's current entry; if we stack that detail over the DSX entry frame,
 * the underneath entry must be rewritten to the app root. Otherwise Back reveals the
 * root DOM while leaving the detail URL in the address bar, and Reload reopens the
 * page the user just left. */
export function coldRootHistoryUrl(base: string, currentHref: string): string {
  return new URL(base, currentHref).href;
}
