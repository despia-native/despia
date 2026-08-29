//
//  webhook-declared.test.ts — the DECLARATION path: `<webhook>` → generated receiver → the host.
//
//  webhook.test.ts covers the verifier. This covers the wiring that was missing around it, and
//  the reason it matters is that the verifier was complete, tested, and REACHABLE BY NOTHING:
//  no declaration produced one, no route dispatched to one, so every backend that needed an
//  inbound webhook hand-rolled a public POST instead — which is what the platform's own document
//  had done. A plane nobody can declare is a plane nobody uses, and here that means the five
//  silent failures webhook.ts enumerates are shipped by whoever writes the endpoint themselves.
//
//  What is proven here is the whole path an author now gets from one row: a public endpoint that
//  verifies over raw bytes, refuses a replay, resolves its signing secrets from the environment
//  BY NAME at dispatch (so rotation is an env change and no secret is ever emitted), and needs
//  no handler code at all.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHost, type HostConfig, type ServerRoute } from "../src/host.ts";
import { QueueSeam, type QueueEnqueueRequest } from "../src/queue.ts";
import { webhookReceiver, type WebhookDeclaration } from "../src/webhook.ts";

const SECRET = "whsec_the_current_signing_secret_value";
const NEXT_SECRET = "whsec_the_secret_being_rotated_in";
const NOW = 1_760_000_000_000;

function installQueue(): { enqueues: QueueEnqueueRequest[] } {
  const enqueues: QueueEnqueueRequest[] = [];
  const keys = new Set<string>();
  QueueSeam.transport = {
    enqueue: async (request) => {
      enqueues.push(request);
      if (keys.has(request.key)) return { id: null, duplicate: true };
      keys.add(request.key);
      return { id: `id-${keys.size}`, duplicate: false };
    },
    claim: async () => [],
    settle: async () => ({ acked: 0, released: 0 }),
    deadLetter: async () => 0,
    listDeadLetters: async () => [],
    replayDeadLetters: async () => 0,
  };
  return { enqueues };
}

async function sign(secret: string, timestampSeconds: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestampSeconds}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The declaration exactly as prepare_server.rb writes it into webhooks.generated.ts. */
const ORDERS: WebhookDeclaration = {
  name: "orders",
  queue: "platform_events",
  secretEnv: ["ORDERS_WEBHOOK_SECRET", "ORDERS_WEBHOOK_SECRET_NEXT"],
  idField: "id",
};

/** The route exactly as prepare_server.rb writes it into routes.ts. */
const ROUTE: ServerRoute = {
  key: "post-events-orders",
  chain: "platform",
  action: "webhookOrders",
  method: "POST",
  path: "/events/orders",
  webhook: "orders",
  rate: "600/m",
  rawBody: true,
};

function host(env: Record<string, string>, options: { nowMs?: number } = {}): ReturnType<typeof createHost> {
  const config: HostConfig = {
    routes: [ROUTE],
    handlers: { platform: { webhookOrders: webhookReceiver(ORDERS, { nowMs: options.nowMs ?? NOW }) } },
  };
  const created = createHost(config);
  return {
    handle: (req: Request) => created.handle(req, { env: (key: string) => env[key] }),
  };
}

function delivery(body: string, headers: Record<string, string>): Request {
  return new Request("http://fixture.test/events/orders", { method: "POST", body, headers });
}

async function signed(body: string, secret = SECRET, atSeconds = Math.floor(NOW / 1000)): Promise<Request> {
  return delivery(body, {
    "content-type": "application/json",
    "x-dsx-signature": await sign(secret, atSeconds, body),
    "x-dsx-timestamp": String(atSeconds),
  });
}

test("declared webhook: a signed delivery is accepted and enqueued, with no handler code", async () => {
  const queue = installQueue();
  const body = JSON.stringify({ id: "evt_1", bundle_id: "com.acme.app", platform: "ios" });
  const res = await host({ ORDERS_WEBHOOK_SECRET: SECRET }).handle(await signed(body));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: true, duplicate: false });
  assert.equal(queue.enqueues.length, 1);
  assert.equal(queue.enqueues[0]!.queue, "platform_events");
  // The key namespaces the source and uses the SENDER's event id, so a re-signed retry of the
  // same event collapses instead of arriving twice.
  assert.equal(queue.enqueues[0]!.key, "orders:evt_1");
  assert.deepEqual(queue.enqueues[0]!.payload.body, { id: "evt_1", bundle_id: "com.acme.app", platform: "ios" });
});

test("declared webhook: a replay of the same delivery is a duplicate, not a second row", async () => {
  const queue = installQueue();
  const body = JSON.stringify({ id: "evt_2" });
  const request = await signed(body);
  const first = await host({ ORDERS_WEBHOOK_SECRET: SECRET }).handle(request);
  // A fresh Request with the identical bytes and signature — a real sender's retry.
  const second = await host({ ORDERS_WEBHOOK_SECRET: SECRET }).handle(await signed(body));

  assert.equal(first.status, 200);
  // 200, never an error: a sender retrying a delivery it already made must get the same answer,
  // or it retries forever.
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: true, duplicate: true });
  assert.equal(queue.enqueues.filter((e) => e.key === "orders:evt_2").length, 2, "both reached the queue");
});

test("declared webhook: the second declared secret verifies too — that IS the rotation window", async () => {
  installQueue();
  const body = JSON.stringify({ id: "evt_3" });
  const res = await host({
    ORDERS_WEBHOOK_SECRET: SECRET,
    ORDERS_WEBHOOK_SECRET_NEXT: NEXT_SECRET,
  }).handle(await signed(body, NEXT_SECRET));
  assert.equal(res.status, 200);
});

test("declared webhook: a secret the environment does not set is 404, never an accepted delivery", async () => {
  installQueue();
  // The failure mode this refuses is the dangerous one: an unset variable read as the empty
  // secret would make every delivery "verify" against "".
  const res = await host({}).handle(await signed(JSON.stringify({ id: "evt_4" })));
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { reason: string }).reason, "webhook_refused");
});

test("declared webhook: a forged signature is 401 and nothing is enqueued", async () => {
  const queue = installQueue();
  const body = JSON.stringify({ id: "evt_5", credits: 999_999 });
  const res = await host({ ORDERS_WEBHOOK_SECRET: SECRET }).handle(await signed(body, "whsec_not_the_secret"));
  assert.equal(res.status, 401);
  assert.deepEqual(queue.enqueues, []);
});

test("declared webhook: a body altered after signing is 401 — the RAW bytes are what verified", async () => {
  const queue = installQueue();
  const honest = JSON.stringify({ id: "evt_6", credits: 200 });
  const tampered = JSON.stringify({ id: "evt_6", credits: 200_000 });
  const request = delivery(tampered, {
    "content-type": "application/json",
    "x-dsx-signature": await sign(SECRET, Math.floor(NOW / 1000), honest),
    "x-dsx-timestamp": String(Math.floor(NOW / 1000)),
  });
  const res = await host({ ORDERS_WEBHOOK_SECRET: SECRET }).handle(request);
  assert.equal(res.status, 401);
  assert.deepEqual(queue.enqueues, []);
});

test("declared webhook: a delivery captured yesterday is outside the window", async () => {
  installQueue();
  const stale = Math.floor((NOW - 24 * 60 * 60 * 1000) / 1000);
  const res = await host({ ORDERS_WEBHOOK_SECRET: SECRET })
    .handle(await signed(JSON.stringify({ id: "evt_7" }), SECRET, stale));
  assert.equal(res.status, 401);
});

test("declared webhook: the route reaches the receiver even though it declares no auth", async () => {
  // The whole point of the row: a sender holds no account and presents no bearer token, so the
  // endpoint must be anonymous and the signature must be the credential. If `auth` ever crept
  // onto a webhook row, every delivery would 401 while the endpoint looked healthy.
  installQueue();
  assert.equal(ROUTE.auth, undefined);
  const res = await host({ ORDERS_WEBHOOK_SECRET: SECRET }).handle(await signed(JSON.stringify({ id: "evt_8" })));
  assert.equal(res.status, 200);
});

test("declared webhook: an unsigned POST from a stranger never reaches the queue", async () => {
  const queue = installQueue();
  const res = await host({ ORDERS_WEBHOOK_SECRET: SECRET })
    .handle(delivery(JSON.stringify({ id: "evt_9" }), { "content-type": "application/json" }));
  assert.equal(res.status, 401);
  assert.deepEqual(queue.enqueues, []);
});
