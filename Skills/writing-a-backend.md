# Writing a backend in DSX

The law is `architecture/proposals/backend-authoring.md`. This is the recipe.

## The shortest complete backend

One file, in your module's server residence — `web/server/orders.dsx`:

```dsx
<server>
  <head>
    <entity as="order" ownership="owner">
      <field as="title" type="text"/>
      <field as="total" type="real"/>
    </entity>

    <action as="create" inputs="title, total">
      if (!title) { throw { reason: 'invalid', message: 'title is required' } }
      const made = await dsx.module.data.order.create({ title: title, total: total })
      return { id: made.data.id }
    </action>
  </head>

  <route method="POST" path="/orders"     action="create" auth="required"/>
  <route method="GET"  path="/orders"     entity="order" op="list" auth="required"/>
  <route method="GET"  path="/orders/:id" entity="order" op="get"  auth="required"/>
</server>
```

Then:

```bash
despia build                      # emits the routes, the migration, the handler and deploy/
despia deploy cloudflare          # prints the plan; nothing is changed
despia deploy cloudflare --apply  # runs it
```

You wrote no TypeScript, no SQL and no JSON. The table, its RLS policies, the route table, the
handler and the deploy plan are all emitted from that document.

## The five things worth knowing

**1 · CRUD needs no action.** A route naming `entity` + `op` gets a generated handler that is
scoped to the caller, restricted to the entity's declared fields, with `id`/`owner_id`/
`created_at` server-assigned. Write an `<action>` only for what CRUD cannot express — an
aggregate, a multi-step write, a third-party call.

**2 · The body is the same grammar as an `on:tap` handler.** `const`/`let`, `if`/`else`,
`for…of`, `while`, `try`/`catch`, `throw`, `return`, `await`. Every loop form works here — see
"Loops, speed and budgets" below for the one caveat, which only applies to an action you also
run on a screen.

**3 · Effects are seams, and the list is short.**

```
await dsx.module.data.<entity>.create({ …fields })
await dsx.module.data.<entity>.get({ id })
await dsx.module.data.<entity>.list({ filters: { … }, limit: 50 })
await dsx.module.data.<entity>.update({ id, values: { … } })
await dsx.module.data.<entity>.delete({ id })
await dsx.module.queue.<name>.push({ key: '…', payload: { … } })
await dsx.module.queue.<name>.drain({ action: 'handleOne', limit: 25 })
await dsx.module.secret.read({ name: 'STRIPE_KEY' })
await fetch(url, { method, headers, body })
```

Every one answers the module envelope: `{ ok: true, data }` or `{ ok: false, error }`. Check
`.ok` before reading `.data`, exactly as in a screen.

**4 · Rejections are values, faults are not.** Throw `{ reason, message }` with a reason from
the vocabulary and the caller gets that status and that message:

| reason | status | | reason | status |
|---|---|---|---|---|
| `invalid` / `bad_request` | 400 | | `conflict` | 409 |
| `unauthenticated` | 401 | | `rate_limited` / `spend_capped` | 429 |
| `forbidden` | 403 | | `upstream` | 502 |
| `not_found` | 404 | | `unavailable` | 503 |

Anything else that throws is a fault: 500, redacted, correlation id in the header, detail in the
server log. Never put a caller-facing explanation in a bare `Error`.

**5 · You cannot reach anything you did not declare.** No `import`, no `process`, no file system,
no sockets. To call out, declare the host:

```dsx
<secret as="STRIPE_KEY" env="STRIPE_KEY"/>
<egress host="api.stripe.com"/>
```

A secret's `as` and `env` must be the same word — you read it by the name the deploy sets. With
no `<egress>`, `fetch` is refused before the request leaves the process.

## Background work

```dsx
<action as="settle" inputs="order">
  const row = await dsx.module.data.order.get({ id: order })
  if (!row.ok) { throw { reason: 'not_found', message: 'no such order' } }
  await dsx.module.data.order.update({ id: order, values: { status: 'paid' } })
</action>

<worker queue="billing" action="settle" schedule="*/5 * * * *" idempotencyKey="order"/>
```

`<worker>` fills in the whole drain shape — POST, auth required, internal (`reach: []`), the
queue table with its UNIQUE idempotency column, and the pg_cron row. A stranger calling the drain
endpoint gets the byte-identical 404 an absent route returns.

To read the queue, name a per-message action rather than looping yourself:

```dsx
<action as="handleOne" inputs="message">
  const order = message.payload.order
  await dsx.module.data.order.update({ id: order, values: { status: 'paid' } })
</action>

<action as="drainBilling">
  return await dsx.module.queue.billing.drain({ action: 'handleOne', limit: 25 })
</action>
```

Return and the message is acked; THROW and it goes back for another attempt, until its attempts
are spent and it dead-letters with your message as the reason. One bad message never costs the
others. The lease, the claim, the release-versus-bury decision and the settle are the kernel's,
so the only thing you write is what one message means.

## Receiving a webhook

```dsx
<secret as="STRIPE_HOOK" env="STRIPE_HOOK"/>
...
<webhook as="payments" queue="billing" secret="STRIPE_HOOK" idField="data.id"/>
```

That is the whole receiver. It is a public POST at `/webhooks/payments` that verifies an
HMAC-SHA256 over the RAW body (`hex(hmac(secret, "<timestamp>.<body>"))` on `X-DSX-Signature`,
with the same timestamp on `X-DSX-Timestamp`), refuses anything outside a five-minute window,
refuses a replay through the queue's UNIQUE key, and enqueues. Write no handler: the work is the
`<worker>` that drains the queue.

Two secrets (`secret="CURRENT, NEXT"`) is how you rotate one without dropping deliveries. Do not
put `auth` on it — a sender holds no account, and the signature is the credential.

## Serving a tool over MCP

```dsx
<tool action="create" description="Create an order." auth="required" mutates="true"/>
```

`<tool>` is to MCP what `<route>` is to HTTP: the same declared action, a second face. The
server answers MCP's streamable-HTTP transport at `/mcp` — initialize, tools/list, tools/call —
so any MCP client can call the tool by name. The input shape is the action's declared `inputs`
(a tool never carries a second contract), `auth="required"` is the same word with the same
meaning as on a route row (an anonymous caller is refused with 401 at the transport, never
with an in-band error a model might route around), and `mutates` surfaces as the protocol's
destructive-hint annotation. A tools-only document is legal; a document may also serve one
action both ways, as `/notes/summary` and the `noteSummary` tool do in the tree's own dogfood
(`Core/Server/Modules/Http/web/server/notes.dsx`). A handler failure never leaks its exception
text: the tool result carries `isError` and a correlation id, and the detail stays in the
server log (the same rule every route already follows).

## When you need a real library

Declare the package once in the manifest; use any of it from a body:

```jsonc
"web": { "server_dependencies": { "stripe": "17.5.0" } },
"facets": { "packages": { "stripe": { "package": "stripe", "scheme": "pay" } } }
```

```dsx
const made = await dsx.module.pay.charges.create({ amount: 2500, currency: 'usd' })
```

You do **not** enumerate the functions — `charges.create` resolves against the package at call
time, and nested methods keep their receiver. For the positional functions most of npm is made
of, pass `args`:

```dsx
const slug = await dsx.module.slug.default({ args: ['Hello World', { lower: true }] })
```

Three things to know:

- **The package is declared, the exports are not.** You cannot reach a coordinate the build did
  not install — a runtime import of an arbitrary name is invisible to the bundler, the licence
  gate and the build receipt.
- **A package hands back data, not objects.** The result is JSON-copied on the way in, so
  functions and class identity do not survive and a `Date` arrives as an ISO string.
- **A package is host-tier code**, so declaring one is a deliberate act with a build record. If
  you need more than a package can give you, write a TypeScript handler in `web/server/index.ts`
  and point a route at it — that path never went away.

## What you can write

The bar is: if you can write the data manipulation in JS, you can write it here. Measured, not
assumed — 117 constructs run through the real handler path against the JS answer.

```dsx
<action as="report" inputs="rows">
  const totals = rows.reduce((acc, r) => ({ ...acc, [r.region]: (acc[r.region] ?? 0) + r.amount }), {})
  const ranked = Object.entries(totals)
    .map(([region, total]) => ({ region: region, total: total }))
    .filter(x => x.total > 0)
    .sort((a, b) => b.total - a.total)
  const { region: top, ...restOfTop } = ranked[0] ?? { region: 'none', total: 0 }
  return { top: top, ranked: ranked.slice(0, 10), count: ranked.length }
</action>
```

Everything in that body works: computed keys, `Object.entries` with a destructured pair, chained
array methods, object rest, nullish defaults. All of `map/filter/reduce/find/sort/flatMap`,
`Object.*`, every string method including regex, template literals, `Math.*`, `JSON`, `Date`,
`try/catch`, closures and recursion are available.

**Three things behave differently from JS, on purpose:**

- `1 / 0` is `0`. Arithmetic is total — no `NaN`, no `Infinity`. Guard divisors yourself.
- A closure captures a snapshot, so a counter inside a closure does not persist across calls.
  Accumulate in a store variable instead.
- No labelled `break` (use a flag or a helper action). `[a, b] = [b, a]` and `o.f?.(…)` both
  work; object-pattern assignment still wants a declaration (`const { a } = o`).
- Loops live in `<action>` bodies. A `<variable>` body is a bounded expression block.

## Loops, speed and budgets

Every loop form works: `for…of`, `while`, and a classic `for (let i = 0; i < n; i++)` — authored
`let`/`const` are real block-scoped locals on this runner. (The store-shadow trap in the monorepo working rules is
about the iOS/Android runners, so it only constrains an action you share with a screen.)

Bodies are **interpreted**, not compiled to JavaScript. Cost is about **10 µs per simple
iteration** — roughly 100 000 iterations a second — so a handler that validates, makes a few
database calls and returns never notices, and the network hop dominates anyway.

Per request: 50 000 loop iterations, 10 seconds wall clock, 64 module calls. Blow any of them and
the request answers **503 `budget_exceeded`** — it does not return partial work, and catching the
refusal inside the body does not rescue it. If you are hitting these, the work belongs on a queue.

## Cost ceilings — on by default, opted out in the open

The law is `architecture/proposals/cost-guardrails.md`. Beyond the per-request sandbox above,
every deployment carries **spend ceilings**: per-window counts on everything that costs money.
You declare nothing and get the guarded profile — per day: 250 000 requests, 25 000 calls to each
declared egress host, 50 000 messages per drained queue (10 000 outstanding), 500 000 row writes,
2 500 000 row reads. A real small app never meets these; a runaway loop meets them in minutes.

A `<budget>` head row tunes one, per attribute:

```dsx
<budget of="requests" per="day" max="1000000"/>
<budget of="egress:api.openai.com" per="hour" max="2000"/>
<budget of="queue:billing" max="unbounded" depth="500"/>
```

- `of` is a metered seam: `requests` · `data:reads` · `data:writes` · `egress:<host>` ·
  `queue:<name>`. The vocabulary is closed; an unknown seam aborts the build.
- `per` is `hour` · `day` · `month` (default `day`).
- `max="unbounded"` is the opt-out — a word, not an absence: the build prints every unbounded
  ceiling, the emitted table records it, and the dashboard badges the deployment unguarded on
  that seam. Units are always counts, never currency.
- `depth` (queue rows only) caps outstanding messages: a push past it answers the transient
  `saturated`, which is backpressure, not failure.

Crossing 80% of a ceiling lands `spend.warning` on the event feed; crossing it lands
`spend.tripped` and the window answers **429 `spend_capped`** naming the budget, with the real
reset time in `Retry-After` — before identity work, before the body is read, before anything
that costs. A capped `fetch` answers the refused shape (`status: -2`, the request never left);
a capped seam call answers `{ ok: false, error: "spend_capped" }`. The window rolling over
re-opens the ceiling and lands `spend.recovered`. Meters and trip state are readable at
`GET /dsx-internal/spend` (service role, the internal key, or the read-only
`DSX_SPEND_READ_TOKEN` — that last one exists so a dashboard can read meters browser-direct
without ever holding a service credential).

Two ceilings the build itself enforces: an `<egress>` host that admits the deployment's own
hostname (`server_url`) aborts unless the row says `self="allow"` — a body fetching its own
routes is the recursion-bill class — and a `<budget>` naming an undeclared host or an undrained
queue aborts as a typo, because a typo here must not read as a guard.

## Despia's own storage, inside your database

You own the database. Despia owns the reserved `dsx_` tables inside it, the way any framework
owns its own migration table — and it creates them, so you never write that SQL:

```bash
despia provision           # what is there, what is missing — changes nothing
despia provision --apply   # create what is missing, then verify by reading back
```

`despia deploy cloudflare --apply` runs it for you before publishing, and refuses to publish if
the storage is not ready: a worker that goes live against a database with no counter table meters
nothing and publishes no events. The reserved set is the spend and rate counters
(`dsx_rate_counter`), the event feed (`dsx_event`), and one table per drained queue. Your own
entity tables are declared by you and never touched by this.

Every run writes `deploy/receipt.json` — what Despia provisioned, when, and what it found. If a
`dsx_` table is later dropped, the next run recreates it and says so. If one has been ALTERED,
it is named and left exactly as it is rather than rewritten: restoring a column does not restore
the constraint it carried, so a silent repair could report success and leave the deployment
broken. Drop it and re-run to have it rebuilt.

Standalone projects carry the same plane: `despia build` merges your `<budget>` rows over the
guarded defaults and emits the table as `spendBudgets` in `server/generated/index.ts` — hand it
to `createHost` as `spend` beside `entities`/`routes`/`handlers`, and the build prints every
unbounded seam. In the Studio (`despia edit`), the server screen's **Spend** view lists every
ceiling with its provenance — declared, or the default nobody had to write — and tapping a row
shows the exact `<budget>` head line that enforces it, with its file and line.

## Gates

```bash
despia lint --strict              # your document, checked
despia build && despia build      # the emitters are idempotent: the second run is a no-diff
cd OpenSource/Web && node --test packages/server/test/actions.test.ts
```

The linter is stricter here than for a screen: the vocabulary is closed, so a misspelled
attribute is an error rather than a warning. That is on purpose — the attribute is usually
`auth`.
