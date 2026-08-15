//
//  Http module — server residence (provides: ["server"]).
//  Fanned into the host by scripts/prepare_server.rb (generated/modules/server.http/).
//  Handler names are the module's declared action names; the routes table binds
//  method+path to them. STRUCTURALLY TYPED; the only paths it may name are the
//  workspace's own kernel planes (../../../src/*), because sources are COPIED to a
//  FIXED depth (generated/modules/<chain>/) — nothing outside the package root.
//  ctx.buildInfo carries the assembly receipt identity.
//

import { drainQueue, listDeadLetters, replayDeadLetters } from "../../../src/queue.ts";
import { parseCursor, subscriptionResponse } from "../../../src/realtime.ts";
import { receiveWebhook as receiveWebhookRequest, webhookResponse } from "../../../src/webhook.ts";

export async function health(
  _args: Record<string, unknown>,
  ctx: { buildInfo: Record<string, unknown> },
) {
  return {
    ok: true,
    version: String(ctx.buildInfo["version"] ?? ""),
    digest: String(ctx.buildInfo["digest"] ?? ""),
    modules: Number(ctx.buildInfo["modules"] ?? 0),
  };
}

//  T4 dogfood — the queue-drain worker (full-stack.md W-DOGFOOD: the class of
//  server code the docs used to ship as paste-this snippets, now a declared
//  worker row). Request-scoped by law: one drain pass per invocation, the
//  pg_cron row calls it every minute.
//
//  THE WHOLE HANDLER IS TWO STATEMENTS, and that is the point of the queue plane:
//  claiming under contention, the visibility lease, the delivery count, the poison
//  ceiling and the per-message failure isolation are all `drainQueue`'s, so the
//  thing an app author writes is the per-message work and nothing else. Idempotency
//  in particular is the queue table's UNIQUE key — a handler that re-implemented it
//  would be re-implementing it WRONG, since the row is what two concurrent enqueues
//  race on, not anything this function can see.
//
//  `drained` is what the queue ACTUALLY dequeued and acked, never a floor: it used
//  to report a hard 0 because no claim operation existed, and a drain that says 0
//  while working perfectly is the one answer a broken queue must not be able to
//  give. Nothing to drain still answers 0 — the difference is that it is now a
//  measurement. An unfilled queue seam does NOT answer 0 either; `drainQueue` throws
//  `no_provider` naming the fix, and host.ts turns that into a typed failure.
export async function drainWebhooks(
  _args: Record<string, unknown>,
  ctx: { buildInfo: Record<string, unknown>; identity?: { sub: string; role: string | null } | null },
) {
  const result = await drainQueue("webhooks", async (_message) => {
    // The dogfood's per-message work. A real webhook worker validates the payload and
    // dispatches here; THROWING is how it says "not this one" — that message alone is
    // released back to the queue and redelivered, and the rest of the batch still acks.
  });
  return { ok: true, queue: "webhooks", drained: result.drained, by: ctx.identity?.sub ?? null };
}

//  ── the INBOUND webhook boundary ──────────────────────────────────────────────────────
//
//  Public by construction: a sender has no user account and cannot present a bearer token, so
//  the HMAC over the raw body IS the credential. Everything that makes that safe lives in
//  webhook.ts; this handler's whole job is to turn the declared configuration into a source and
//  hand the request over.
//
//  A `Response` is returned rather than a value because a refusal is a 401. Answering 200 with a
//  sad object would tell every sender its delivery was accepted, and a webhook sender that
//  believes a delivery landed does not retry it.
export async function receiveWebhook(
  _args: Record<string, unknown>,
  ctx: { params: Record<string, string>; env: (key: string) => string | undefined; request: Request },
) {
  const name = ctx.params["source"] ?? "";
  const secrets = webhookSecretsFor(name, ctx.env("DSX_WEBHOOK_SECRETS"));
  const toleranceMs = numberFrom(ctx.env("DSX_WEBHOOK_TOLERANCE_SECONDS"), 300) * 1000;
  //  An UNKNOWN source and a CONFIGURED-BUT-SECRETLESS one take the same path on purpose: both
  //  end at `not_configured`, which answers the byte-identical 404 an absent route returns.
  //  Distinguishing them tells a prober which vendors this deployment integrates with.
  const outcome = await receiveWebhookRequest(
    { name: sourceName(name), secrets, queue: "webhooks", idField: "id", toleranceMs },
    ctx.request,
  );
  return webhookResponse(outcome);
}

//  `name=secret` pairs, comma separated. A name repeated carries BOTH secrets, which is the
//  rotation window: deliveries signed with either are accepted until the old one is dropped.
function webhookSecretsFor(name: string, declared: string | undefined): string[] {
  if (typeof declared !== "string" || declared === "" || name === "") return [];
  const wanted = sourceName(name);
  const secrets: string[] = [];
  for (const pair of declared.split(",")) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    if (pair.slice(0, at).trim() === wanted) secrets.push(pair.slice(at + 1).trim());
  }
  return secrets.filter((s) => s !== "");
}

//  A source name reaches the idempotency key, so it is held to the same identifier grammar every
//  other declared name is. Anything else collapses to a name no configuration can match, which
//  refuses the delivery rather than letting a crafted path segment shape a stored key.
function sourceName(raw: string): string {
  return /^[a-z][a-z0-9_]*$/.test(raw) ? raw : "";
}

function numberFrom(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

//  ── the SSE subscription ──────────────────────────────────────────────────────────────
//
//  `auth: required` on the row is what makes the per-row owner filter mean anything: the feed is
//  read for the VERIFIED subject, never for a value the subscriber sent. The cursor is the only
//  thing the client chooses, and a mangled one resumes from the beginning rather than failing.
export function subscribe(
  _args: Record<string, unknown>,
  ctx: {
    params: Record<string, string>;
    query: Record<string, string>;
    identity?: { sub: string } | null;
    request: Request;
  },
) {
  const subject = ctx.identity?.sub ?? "";
  //  `Last-Event-ID` WINS over the query cursor. The browser sets it automatically on a
  //  reconnect and a stale `?cursor=` in the original URL would otherwise replay everything the
  //  client already has, every time the connection drops.
  const cursor = parseCursor(ctx.request.headers.get("last-event-id") ?? ctx.query["cursor"]);
  return subscriptionResponse(ctx.params["channel"] ?? "", subject, cursor);
}

//  ── the dead-letter view (INTERNAL) ───────────────────────────────────────────────────

export async function listWebhookDeadLetters(_args: Record<string, unknown>, _ctx: unknown) {
  const stuck = await listDeadLetters("webhooks");
  return {
    queue: "webhooks",
    count: stuck.length,
    messages: stuck.map((m) => ({ id: m.id, key: m.key, attempts: m.attempt, reason: m.reason, deadLetteredAt: m.deadLetteredAt })),
  };
}

export async function replayWebhookDeadLetters(
  args: Record<string, unknown>,
  _ctx: unknown,
) {
  const ids = Array.isArray(args["ids"]) ? (args["ids"] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  return { queue: "webhooks", replayed: await replayDeadLetters("webhooks", ids) };
}
