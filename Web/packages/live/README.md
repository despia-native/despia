# @despia-native/live

The live-logs relay: one Cloudflare Worker plus one Durable Object class that YOU deploy to
YOUR Cloudflare account. Devices on test channels batch-POST their scrubbed diagnostic rows to
it; the Despia dashboard (or any viewer you authorize) reads them back over an SSE cursor
feed, about a second behind the device. The relay also stores one-shot `.dsxreport` uploads
and answers the report verifier.

Despia operates nothing here and is never in the byte path. The relay runs on your connected
hosting account; usage bills there. MIT, dependency-free beyond `@despia-native/kernel` (the shared
wire core), and small enough to read in one sitting.

Design law: `OpenSource/Documentation/architecture/proposals/live-logs.md` (section 3.2).

## Deploy in three commands

```bash
npm install @despia-native/live
npx wrangler deploy --config node_modules/@despia-native/live/wrangler.jsonc
npx wrangler secret put LIVE_ADMIN_KEY --config node_modules/@despia-native/live/wrangler.jsonc
```

The manifest binds the `LiveSession` Durable Object (SQLite-backed, available on the free
plan) and carries commented placeholders for the optional R2 archive. Without the
`LIVE_ADMIN_KEY` secret the relay refuses to mint sessions: `/pair` fails closed and reads
exactly like an unknown route.

## Routes

| Route | Method | Auth | What it does |
|---|---|---|---|
| `/pair` | POST | admin key (`x-dsx-live-key` header) | mints `{sid, deviceToken, viewerToken, ttlMs}` for one session |
| `/s/:sid/batch` | POST | device token (Bearer) | appends a wire batch `{v, sid, n, rows}`; idempotent by `n`; acks `{ok, viewers, ttlMs}` |
| `/s/:sid/attest` | POST | device token (Bearer) | stores the device integrity envelope verbatim |
| `/s/:sid/report` | POST | device token (Bearer) | stores a sealed `.dsxreport` and returns its verdict |
| `/s/:sid/rows?after=&limit=&token=` | GET | viewer token | cursor poll: `{rows: [{seq, row}], gap, last}` |
| `/s/:sid/feed?after=&token=` | GET | viewer token | SSE: replay after the cursor, then live rows as `id: <seq>` events; honors `Last-Event-ID`; self-closes (default 55s) so clients re-attach with a cursor |
| `/verify` | POST | none | paste text in, verdict out (`not_report`, `modified`, `genuine`); stores nothing |

Viewer routes accept the token as `?token=` because `EventSource` cannot set headers. Every
refusal is `{ok: false, error: {code, message}}`. CORS is permissive by default (the dashboard
is a cross-origin browser client by design); narrow it with the `LIVE_ALLOWED_ORIGIN` var.

## Session lifecycle and backpressure

A session exists from `/pair` until its deadline passes: each authenticated batch slides the
deadline by `LIVE_SESSION_TTL_MS` (default 15 minutes), capped by `LIVE_SESSION_MAX_AGE_MS`
(default 4 hours). Every batch ack carries `{viewers, ttlMs}`, which is the entire
backpressure contract: a device that sees zero viewers for long enough pauses its wire and
keeps recording locally; a device whose deadline passed stops. Duplicate batch indexes are
refused, so a retried POST can never double rows.

## Retention

By default the relay retains ONLY the in-memory replay ring (the newest 2000 rows per
session, write-through to Durable Object storage so a restart cannot lose the cursor space or
double rows). Nothing else is kept and nothing leaves your account.

Archiving is opt-in: bind an R2 bucket as `ARCHIVE` (commented template in
`wrangler.jsonc`) and each ended session folds into one JSON object under
`sessions/<sid>.json`. Put a lifecycle TTL on the bucket to bound retention; the relay
imposes none of its own.

## Attestation

`/s/:sid/attest` stores the device's integrity envelope (App Attest / Play Integrity)
verbatim and surfaces it beside the session. The relay deliberately does NOT judge it: the
Apple/Google verification round-trip is the platform's verify path (live-logs.md P3), because
a verdict computed by infrastructure the envelope was addressed to convince is not a verdict.
Report uploads likewise return the structural verdict (`genuine` means the seal verifies);
`assertion: true` only reports that an attestation rides the seal.

## Testing

```bash
node --test packages/live/test/live.test.ts              # the pure wire logic
node --test packages/live/test/workers/live.workers.test.ts   # the real thing, under workerd (miniflare)
```
