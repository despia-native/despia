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
ruby ClosedSource/scripts/prepare_server.rb   # emits the routes, the migration, the handler
ruby ClosedSource/scripts/dsx_deploy.rb       # prints the plan; --apply runs it
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
| `unauthenticated` | 401 | | `rate_limited` | 429 |
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

## Gates

```bash
ruby ClosedSource/scripts/lint_dsx.rb --strict          # your document, checked
ruby ClosedSource/scripts/prepare_server.rb && ruby ClosedSource/scripts/prepare_server.rb
cd OpenSource/Web && node --test packages/server/test/actions.test.ts
```

The linter is stricter here than for a screen: the vocabulary is closed, so a misspelled
attribute is an error rather than a warning. That is on purpose — the attribute is usually
`auth`.
