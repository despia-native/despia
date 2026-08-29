//
//  mcp-app.ts - the DOM binding for the MCP Apps view protocol (proposals/mcp-apps.md).
//  The kernel owns the protocol (packages/kernel/src/mcp/apps.ts — pure, corpus-gated);
//  this file owns the three things that touch the document, and it is the only place they
//  are allowed to live: window postMessage, CSS custom properties, and size observation.
//
//  The host renders us in a sandboxed iframe under a CSP whose default is
//  `connect-src 'none'`, so there is deliberately no fetch anywhere below: data arrives on
//  `ui/notifications/tool-result` and egress is a host-proxied `tools/call`. That is the
//  SSR shape, not a limitation — the work happens outside the box and the box renders it.
//

import { createAppBridge, type AppBridge, type AppFrame, type AppHostContext } from "@despia-native/kernel/mcp";

export type MountedApp = {
  bridge: AppBridge;
  /** Stop listening and observing. Idempotent. */
  dispose: () => void;
};

export type MountAppOptions = {
  /** Defaults to the current window; injectable for tests. */
  window?: Window;
  /** Element whose size is reported when the host container is flexible. */
  sizeTarget?: Element | null;
  /** Element the host's theme variables are written onto. Defaults to documentElement. */
  themeTarget?: HTMLElement | null;
  displayModes?: string[];
  onData?: (result: unknown) => void;
  onInput?: (input: { toolName: string | null; arguments: Record<string, unknown> }) => void;
  onReady?: (context: AppHostContext) => void;
};

/**
 * Wire a view to its host. Returns as soon as the initialize request is out; readiness is
 * observable on the bridge and through `onReady`.
 */
export function mountMcpApp(options: MountAppOptions = {}): MountedApp {
  const win = options.window ?? globalThis.window;
  if (win === undefined) throw new Error("[mcp-app] no window to bind to");

  // The host is the frame that embedded us. `parent` is correct for the sandboxed-iframe
  // model the spec mandates; targetOrigin stays "*" because a sandboxed frame is opaque
  // and the host, not us, enforces the boundary.
  const post = (frame: AppFrame): void => {
    win.parent?.postMessage(frame, "*");
  };

  const themeTarget = options.themeTarget ?? win.document?.documentElement ?? null;

  const bridge = createAppBridge({
    send: post,
    displayModes: options.displayModes,
    onData: options.onData,
    onInput: options.onInput,
    onReady: (context) => {
      applyTokens(themeTarget, bridge.tokens());
      options.onReady?.(context);
      reportNow();
    },
  });

  const onMessage = (event: MessageEvent): void => {
    // Only the embedder speaks to us. Anything else on the channel is not our host.
    if (event.source !== null && event.source !== win.parent) return;
    const data = event.data as AppFrame | undefined;
    if (typeof data !== "object" || data === null) return;
    bridge.receive(data);
  };
  win.addEventListener("message", onMessage);

  const target = options.sizeTarget ?? win.document?.documentElement ?? null;
  const reportNow = (): void => {
    if (target === null) return;
    const rect = target.getBoundingClientRect();
    // Round: sub-pixel jitter would otherwise defeat the bridge's repeat coalescing.
    bridge.reportSize(Math.ceil(rect.width), Math.ceil(rect.height));
  };

  let observer: ResizeObserver | null = null;
  const Observer = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (Observer !== undefined && target !== null) {
    observer = new Observer(() => reportNow());
    observer.observe(target);
  }

  let disposed = false;
  return {
    bridge,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      win.removeEventListener("message", onMessage);
      observer?.disconnect();
    },
  };
}

/**
 * Write the host's variables onto the view. They are the host's own token names
 * (`--color-text-primary`, `--font-sans`, …) and are applied verbatim: the DSX theme layer
 * reads through to them, which is how an unstyled view looks native per host without
 * anybody writing a per-host stylesheet.
 */
export function applyTokens(target: HTMLElement | null, tokens: Record<string, string>): void {
  if (target === null) return;
  for (const [name, value] of Object.entries(tokens)) {
    if (!name.startsWith("--")) continue; // a host cannot set arbitrary CSS through this door
    target.style.setProperty(name, value);
  }
}
