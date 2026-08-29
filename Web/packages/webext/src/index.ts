// @despia-native/webext — the page-side client for the Despia browser-extension envelope
// (OpenSource/Documentation/architecture/proposals/browser-extension.md).
//
// ONE import, total across every context a page can wake up in:
//   1. inside the Despia native app  → delegates to the real dsx.module.webextension
//   2. Safari next to the app        → envelope, native:true (the app owns state)
//   3. Chrome/Edge/Firefox standalone → envelope, native:false (THIS page is the app end)
//   4. extension absent / unmatched  → webext() resolves null (the timeout detect)
//
// The wire underneath is the postMessage envelope — { source:"dsx-webext", id,
// type, … } in, { source:"dsx-webext-reply", id, …result } back. This package
// deliberately does NOT mint a `dsx` global: `window.dsx` presence is the
// documented "inside the native app" detect and belongs to the kernel alone.
// Every settle is value-level ({ ok:false, error }), never a throw.

export type WebextVars = Record<string, string>;

export type WebextMessage = {
  event: string;
  payload: WebextVars;
  origin: string;
  ts: number;
};

export type WebextReply = {
  ok: boolean;
  /** Whether a NATIVE app answered (the app end is the app, not this page). */
  native: boolean;
  /** Whether this page runs inside the Despia native app itself. */
  inApp: boolean;
  error?: string;
  vars?: WebextVars;
  lastSeen?: number;
  queued?: number;
  used?: boolean;
  messages?: WebextMessage[];
};

export type WebextAuthReply = WebextReply & {
  authenticated?: boolean;
  accountId?: string;
  expiresAt?: number;
};

/**
 * The auth plane, page-side. Deliberately NO token(): the token's audience is
 * extension contexts only (popup/background) — a page has its own session; it
 * needs to know, not to hold. `grant` lends THIS page's session to the
 * extension (works where the page is the app end; a native surface answers
 * native_owns_state — there the APP grants via dsx.module.webextension.grant).
 */
export type WebextAuth = {
  status(): Promise<WebextAuthReply>;
  grant(grant: { token: string; accountId?: string; expiresAt?: number }): Promise<WebextReply>;
  signIn(): Promise<WebextAuthReply>;
  signOut(): Promise<WebextReply>;
};

export type Webext = {
  /** Discovered at detect time; every reply re-stamps it. */
  readonly native: boolean;
  readonly inApp: boolean;
  status(): Promise<WebextReply>;
  get(): Promise<WebextReply>;
  send(event: string, payload?: Record<string, unknown>): Promise<WebextReply>;
  update(vars: Record<string, unknown>): Promise<WebextReply>;
  clear(): Promise<WebextReply>;
  drain(): Promise<WebextReply>;
  auth: WebextAuth;
};

export type WebextOptions = {
  /** ms to wait for the content script before deciding the extension is absent (default 300). */
  timeout?: number;
  /** Injection point for tests / non-browser hosts; defaults to globalThis.window. */
  window?: Window;
};

const SOURCE = "dsx-webext";
const REPLY = "dsx-webext-reply";

type Envelope = {
  type: string;
  action?: string;
  event?: string;
  payload?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  token?: string;
  accountId?: string;
  expiresAt?: number;
};

// The dsx.module.webextension face this package delegates to in-app — the
// module's declared actions, nothing more (the module proxy is dynamic; this
// type is the CLIENT's contract with it).
type DsxWebextModule = {
  status(): Promise<{ used?: boolean; lastSeen?: number; queued?: number }>;
  update(args: { vars: Record<string, unknown> }): Promise<{ ok?: boolean }>;
  clear(): Promise<{ ok?: boolean }>;
  grant(args: { token: string; accountId?: string; expiresAt?: number }): Promise<{ ok?: boolean }>;
  authStatus(): Promise<{ authenticated?: boolean; accountId?: string; expiresAt?: number }>;
};

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `dsxw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function ask(win: Window, msg: Envelope, timeout: number): Promise<(WebextReply & { id?: string }) | null> {
  return new Promise((resolve) => {
    const id = randomId();
    const timer = setTimeout(() => {
      win.removeEventListener("message", on as EventListener);
      resolve(null);
    }, timeout);
    function on(e: MessageEvent) {
      const d = e.data as ({ source?: string; id?: string } & Partial<WebextReply>) | null;
      if (e.source !== win || !d || d.source !== REPLY || d.id !== id) return;
      clearTimeout(timer);
      win.removeEventListener("message", on as EventListener);
      resolve({ native: false, inApp: false, ...d, ok: d.ok === true });
    }
    win.addEventListener("message", on as EventListener);
    win.postMessage({ source: SOURCE, id, ...msg }, win.location?.origin ?? "*");
  });
}

function inAppModule(win: Window): DsxWebextModule | null {
  const dsx = (win as { dsx?: { module?: { webextension?: DsxWebextModule } } }).dsx;
  return dsx?.module?.webextension ?? null;
}

// Context 1 — inside the native app: the three verbs with real module actions
// delegate; the rest settle `in_app` (you ARE the destination — subscribe
// dsx.module.webextension.on("message", …) instead of draining).
function inAppHandle(mod: DsxWebextModule): Webext {
  const settle = (error: string): Promise<WebextReply> =>
    Promise.resolve({ ok: false, native: true, inApp: true, error });
  return {
    native: true,
    inApp: true,
    async status() {
      try {
        const s = await mod.status();
        return { ok: true, native: true, inApp: true, ...s };
      } catch {
        return { ok: false, native: true, inApp: true, error: "module_unavailable" };
      }
    },
    async update(vars) {
      try {
        await mod.update({ vars });
        return { ok: true, native: true, inApp: true };
      } catch {
        return { ok: false, native: true, inApp: true, error: "module_unavailable" };
      }
    },
    async clear() {
      try {
        await mod.clear();
        return { ok: true, native: true, inApp: true };
      } catch {
        return { ok: false, native: true, inApp: true, error: "module_unavailable" };
      }
    },
    get: () => settle("in_app"),
    send: () => settle("in_app"),
    drain: () => settle("in_app"),
    auth: {
      async status() {
        try {
          const s = await mod.authStatus();
          return { ok: true, native: true, inApp: true, ...s };
        } catch {
          return { ok: false, native: true, inApp: true, error: "module_unavailable" };
        }
      },
      async grant(g) {
        try {
          await mod.grant(g);
          return { ok: true, native: true, inApp: true };
        } catch {
          return { ok: false, native: true, inApp: true, error: "module_unavailable" };
        }
      },
      // In-app there is nothing to sign INTO from here — the app's own auth
      // flow is the sign-in; run it, then grant.
      signIn: () => settle("in_app"),
      signOut: () => settle("in_app"),
    },
  };
}

// Contexts 2 + 3 — the envelope: same six verbs; the hub decides native vs the
// extension-local floor and stamps every reply.
function envelopeHandle(win: Window, native: boolean, timeout: number): Webext {
  const call = async (msg: Envelope): Promise<WebextReply> =>
    (await ask(win, msg, timeout)) ?? { ok: false, native, inApp: false, error: "extension_unavailable" };
  return {
    native,
    inApp: false,
    status: () => call({ type: "status" }),
    get: () => call({ type: "get" }),
    send: (event, payload = {}) => call({ type: "send", event, payload }),
    update: (vars) => call({ type: "update", vars }),
    clear: () => call({ type: "clear" }),
    drain: () => call({ type: "drain" }),
    auth: {
      status: () => call({ type: "auth", action: "status" }),
      grant: (g) => call({ type: "auth", action: "grant", token: g.token, accountId: g.accountId, expiresAt: g.expiresAt }),
      signIn: () => call({ type: "auth", action: "signin" }),
      signOut: () => call({ type: "auth", action: "signout" }),
    },
  };
}

/**
 * Detect the extension and return a total handle for this context — or `null`
 * when there is genuinely nothing to talk to (no window at all, or no content
 * script answered within the timeout: not installed, or this page unmatched).
 */
export async function webext(opts: WebextOptions = {}): Promise<Webext | null> {
  const win = opts.window ?? (typeof window === "undefined" ? undefined : window);
  if (!win) return null; // SSR / worker: no page, no extension
  const mod = inAppModule(win);
  if (mod) return inAppHandle(mod);
  const timeout = opts.timeout ?? 300;
  const first = await ask(win, { type: "status" }, timeout);
  if (!first) return null;
  return envelopeHandle(win, first.native === true, timeout);
}
