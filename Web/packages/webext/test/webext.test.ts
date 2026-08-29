// @despia/webext — the four contexts, each proven: in-app delegation, envelope
// native, envelope local floor, and the absent-extension timeout. The fake
// window is an EventTarget with a postMessage that plays the content-script
// side of the wire (or stays silent, for the absent case).

import { test } from "node:test";
import assert from "node:assert/strict";
import { webext } from "../src/index.ts";

type Responder = (msg: Record<string, unknown>) => Record<string, unknown> | null;

class FakeMessageEvent extends Event {
  data: unknown;
  source: unknown;
  constructor(data: unknown, source: unknown) {
    super("message");
    this.data = data;
    this.source = source;
  }
}

// A window whose postMessage IS the content script: envelopes get a reply
// dispatched back (async, like the real world); `null` from the responder
// means silence (extension absent / page unmatched).
function fakeWindow(respond: Responder | null): Window {
  const target = new EventTarget() as EventTarget & Record<string, unknown>;
  target.location = { origin: "https://app.example" };
  target.postMessage = (data: Record<string, unknown>) => {
    if (!respond || !data || data.source !== "dsx-webext") return;
    const reply = respond(data);
    if (!reply) return;
    queueMicrotask(() => {
      target.dispatchEvent(new FakeMessageEvent({ source: "dsx-webext-reply", id: data.id, ...reply }, target));
    });
  };
  return target as unknown as Window;
}

test("absent extension: webext() resolves null on the timeout", async () => {
  const handle = await webext({ window: fakeWindow(null), timeout: 30 });
  assert.equal(handle, null);
});

test("native surface (Safari): verbs pass through; app-end writes refused by the handler", async () => {
  const win = fakeWindow((msg) => {
    switch (msg.type) {
      case "status": return { ok: true, native: true, vars: { plan: "pro" }, lastSeen: 9, queued: 1 };
      case "send":   return { ok: true, native: true };
      case "update": return { ok: false, native: true, error: "native_owns_state" };
      default:       return { ok: false, native: true, error: "unknown_type" };
    }
  });
  const ext = await webext({ window: win, timeout: 50 });
  assert.ok(ext);
  assert.equal(ext.native, true);
  assert.equal(ext.inApp, false);
  assert.equal((await ext.status()).vars?.plan, "pro");
  assert.equal((await ext.send("ping", { a: 1 })).ok, true);
  assert.equal((await ext.update({ plan: "max" })).error, "native_owns_state");
});

test("local floor (Chrome/Firefox standalone): this page is the app end", async () => {
  const vars: Record<string, string> = {};
  const queue: Array<Record<string, unknown>> = [];
  const win = fakeWindow((msg) => {
    switch (msg.type) {
      case "status": return { ok: true, native: false, vars, queued: queue.length };
      case "update": Object.assign(vars, msg.vars as Record<string, string>); return { ok: true, native: false };
      case "send":   queue.push({ event: msg.event, payload: msg.payload }); return { ok: true, native: false };
      case "drain": { const out = queue.splice(0); return { ok: true, native: false, messages: out }; }
      default:       return { ok: false, native: false, error: "unknown_type" };
    }
  });
  const ext = await webext({ window: win, timeout: 50 });
  assert.ok(ext);
  assert.equal(ext.native, false);
  await ext.update({ plan: "pro" });
  await ext.send("saved", { url: "https://x" });
  const drained = await ext.drain();
  assert.equal(drained.messages?.length, 1);
  assert.equal((await ext.status()).vars?.plan, "pro");
  assert.equal((await ext.drain()).messages?.length, 0);
});

test("in-app: delegates the real module actions, refuses the rest as in_app", async () => {
  const calls: string[] = [];
  const win = fakeWindow(null) as Window & { dsx?: unknown };
  win.dsx = {
    module: {
      webextension: {
        status: async () => { calls.push("status"); return { used: true, lastSeen: 7, queued: 0 }; },
        update: async (_a: { vars: Record<string, unknown> }) => { calls.push("update"); return { ok: true }; },
        clear:  async () => { calls.push("clear"); return { ok: true }; },
      },
    },
  };
  const ext = await webext({ window: win, timeout: 30 });
  assert.ok(ext);
  assert.equal(ext.inApp, true);
  assert.equal(ext.native, true);
  const s = await ext.status();
  assert.equal(s.ok, true);
  assert.equal(s.used, true);
  assert.equal((await ext.update({ a: 1 })).ok, true);
  assert.equal((await ext.send("x")).error, "in_app");
  assert.equal((await ext.drain()).error, "in_app");
  assert.deepEqual(calls, ["status", "update"]);
});

test("auth plane, local mode: the site grants, status reflects, no token method exists on the page API", async () => {
  let stored: Record<string, unknown> | null = null;
  const win = fakeWindow((msg) => {
    if (msg.type === "status") return { ok: true, native: false };
    if (msg.type !== "auth") return { ok: false, native: false, error: "unknown_type" };
    switch (msg.action) {
      case "grant":  stored = { token: msg.token, accountId: msg.accountId }; return { ok: true, native: false };
      case "status": return { ok: true, native: false, authenticated: !!stored, accountId: (stored?.accountId as string) ?? "" };
      case "signout": stored = null; return { ok: true, native: false };
      default: return { ok: false, native: false, error: "unknown_action" };
    }
  });
  const ext = await webext({ window: win, timeout: 50 });
  assert.ok(ext);
  assert.equal((await ext.auth.status()).authenticated, false);
  assert.equal((await ext.auth.grant({ token: "ext_abc", accountId: "u1" })).ok, true);
  const s = await ext.auth.status();
  assert.equal(s.authenticated, true);
  assert.equal(s.accountId, "u1");
  assert.equal((await ext.auth.signOut()).ok, true);
  assert.equal((await ext.auth.status()).authenticated, false);
  assert.equal("token" in ext.auth, false); // the page never holds the credential
});

test("auth plane, in-app: delegates grant/authStatus to the module; signIn is the app's act", async () => {
  const calls: string[] = [];
  const win = fakeWindow(null) as Window & { dsx?: unknown };
  win.dsx = {
    module: {
      webextension: {
        status: async () => ({ used: true, lastSeen: 1, queued: 0 }),
        update: async () => ({ ok: true }),
        clear: async () => ({ ok: true }),
        grant: async (_g: { token: string }) => { calls.push("grant"); return { ok: true }; },
        authStatus: async () => { calls.push("authStatus"); return { authenticated: true, accountId: "u9", expiresAt: 0 }; },
      },
    },
  };
  const ext = await webext({ window: win, timeout: 30 });
  assert.ok(ext);
  assert.equal((await ext.auth.grant({ token: "t" })).ok, true);
  assert.equal((await ext.auth.status()).accountId, "u9");
  assert.equal((await ext.auth.signIn()).error, "in_app");
  assert.deepEqual(calls, ["grant", "authStatus"]);
});

test("replies correlate by id: a stranger's reply is ignored, the timeout stands", async () => {
  const target = fakeWindow(null) as Window;
  // A rogue reply with the wrong id, fired immediately on any envelope.
  (target as unknown as Record<string, unknown>).postMessage = (data: Record<string, unknown>) => {
    if (data?.source !== "dsx-webext") return;
    queueMicrotask(() => {
      (target as unknown as EventTarget).dispatchEvent(
        new FakeMessageEvent({ source: "dsx-webext-reply", id: "not-yours", ok: true }, target));
    });
  };
  assert.equal(await webext({ window: target, timeout: 30 }), null);
});
