# Backend authoring — the server surface is a `.dsx` document

> **Status: LANDED (2026-08-12).** Every example below is the implemented grammar, verified by
> `ClosedSource/scripts/server_document_test.rb` (23) and
> `OpenSource/Web/packages/server/test/actions.test.ts` (24). Companions: `full-stack.md` (the
> law this serves), `full-stack-execution.md` (the backend infrastructure it sits on),
> `../../reference/dsx-anatomy.md` (the document law it obeys),
> `OpenSource/Conformance/actions/` (the corpus that gates the grammar on three runtimes).
>
> **In one sentence:** `full-stack.md` states as law that "business logic stays in the one action
> grammar … there is no second backend language, ever", and until this landed every server
> handler was hand-written TypeScript. A backend surface is now a `.dsx` document whose
> `<action>` bodies the host executes — the same grammar, lint, corpus and muscle memory as a
> tap handler.

---

## 1 · The gap this closed

The backend infrastructure was already done and live (identity, RLS-scoped repository, declared
CRUD, queues with database-enforced idempotency, webhooks with HMAC over raw bytes, realtime,
rate limits, tracing, cron, one-button deploy). What was missing was the **authoring surface**.

Adding one endpoint took **two files in two languages**, neither of which is the language the
same feature's UI is written in:

```jsonc
// ClosedSource/DSX/Modules/Custom/Orders/dsx.json — the declaration
{
  "name": "Orders", "scheme": "orders", "version": "1.0.0",
  "actions": {
    "create": { "resolves": { "id": "string" }, "provides": ["server"], "reach": ["app", "web"] }
  },
  "facets": {
    "schema": { "order": { "fields": { "title": "text", "total": "real" }, "ownership": "owner" } },
    "api":    { "create": { "method": "POST", "path": "/orders", "action": "create", "auth": "required" } }
  }
}
```

```ts
// …/Orders/web/server/index.ts — the logic
import { repoFor } from "../../../src/repo.ts";

export async function create(args: Record<string, unknown>, ctx: HostContext) {
  const title = String(args.title ?? "");
  if (!title) throw { reason: "invalid", message: "title is required" };
  const row = await repoFor(ctx).create("order", { title, total: Number(args.total ?? 0) });
  return { id: row.id };
}
```

Three consequences, in order of severity:

1. **Two typefaces.** The product thesis — one grammar, three renderers — stopped at the network
   boundary.
2. **Arbitrary code in a shared runtime.** A TypeScript handler can `import` anything, read
   `process.env`, open a socket and loop forever. Acceptable when the handler authors are us;
   not acceptable when they are thousands of developers whose functions share a deployment.
3. **Nothing to introspect.** A TypeScript body is opaque to the build. A declared body is a
   parsed tree: lintable, budgetable, diffable, and displayable in a dashboard.

## 2 · The document

Head = contract + state + logic; body = pure markup — the existing anatomy law, unchanged,
because **the structure of a server is its route surface**.

```dsx
<server>
  <head>
    <entity as="order" ownership="owner">
      <field as="title" type="text"/>
      <field as="total" type="real"/>
      <index on="title"/>
    </entity>

    <secret as="STRIPE_KEY" env="STRIPE_KEY"/>
    <egress host="api.stripe.com"/>

    <action as="create" inputs="title, total">
      if (!title) { throw { reason: 'invalid', message: 'title is required' } }
      const made = await dsx.module.data.order.create({ title: title, total: total })
      await dsx.module.queue.billing.push({ key: made.data.id, payload: { order: made.data.id } })
      return { id: made.data.id }
    </action>

    <action as="settle" inputs="order">
      const row = await dsx.module.data.order.get({ id: order })
      const key = await dsx.module.secret.read({ name: 'STRIPE_KEY' })
      const charged = await fetch('https://api.stripe.com/v1/charges', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key.data },
        body: { amount: row.data.total * 100 }
      })
      if (!charged.ok) { throw { reason: 'upstream', message: 'charge failed' } }
      await dsx.module.data.order.update({ id: order, values: { status: 'paid' } })
    </action>
  </head>

  <route method="POST" path="/orders" action="create" auth="required" reach="app, web"/>
  <route method="GET"  path="/orders" entity="order" op="list" auth="required"/>
  <worker queue="billing" action="settle" schedule="*/5 * * * *" idempotencyKey="order"/>
</server>
```

The document lives in the module's server residence (`web/server/*.dsx`). Every tag compiles to
a facet row `prepare_server.rb` already aggregates — `<entity>` is a `facets.schema` row,
`<route>` is a `facets.api` row, `<worker>` is an api row with `worker`/`schedule`/
`idempotencyKey` — so the merge happens **before any validator runs**. Method+path uniqueness,
`provides`/`reach`, the capability check and the schema vocabulary all see one set of rows and
cannot develop a second opinion about markup-declared ones.

**The vocabulary is closed.** An unknown tag or attribute aborts the build naming the line. A
document that half-works because an attribute was misspelled is the silent class every gate here
exists to prevent, and the attribute in question is usually `auth`.

### The tag reference

| Tag | Where | Attributes |
|---|---|---|
| `<entity>` | head | `as` · `ownership` (owner · public-read · service) |
| `<field>` | in `<entity>` | `as` · `type` (text · integer · real · boolean · timestamptz · jsonb · uuid) |
| `<index>` | in `<entity>` | `on` (space-separated declared field names) |
| `<secret>` | head | `as` · `env` — must be the SAME word; a body reads a secret by the name the deploy sets |
| `<egress>` | head | `host` — one per allowed host; absent ⇒ the document cannot make an outbound request |
| `<action>` | head | `as` · `inputs` (`"a, b"` or `"id: item.id"`); body is RAW code |
| `<route>` | body | `as` · `method` · `path` · `action` \| (`entity` + `op`) · `auth` · `rate` · `schedule` · `body` · `reach` |
| `<worker>` | body | `as` · `queue` · `action` · `path` · `schedule` · `idempotencyKey` · `rate` |

`as` on a route is optional: the key derives from method+path (`POST /orders` → `post-orders`),
and a collision is the existing uniqueness gate's to report. A `<worker>` fills in the whole
drain shape — POST, auth required, `reach: []` — because none of those is a decision an author
should be able to get wrong.

## 3 · What a body can reach, and nothing else

| Seam | What it is |
|---|---|
| `dsx.module.data.<entity>.{create,get,list,update,delete}` | the repository, scoped to the VERIFIED caller (RLS as the user) |
| `dsx.module.queue.<name>.push({ key, payload })` | enqueue; `key` is required because idempotency is a UNIQUE column, not a convention |
| `dsx.module.secret.read({ name })` | only the names this document declared; an undeclared name is `forbidden`, an unconfigured one is `unavailable` |
| `dsx.module.<scheme>.<action>` | a declared package (§5) or another module |
| `fetch(...)` | HTTPS only, and only to a declared `<egress>` host |
| `dsx.event` / `dsx.log` / `dsx.error` | the bus and the diagnostics plane |

There is no `import`, no `require`, no `process`, no `globalThis`, no member access into host
objects — **not by policy but by construction**: JSE is an interpreter over a closed statement
grammar, and a name it does not know is a name it cannot reach. That is the property that makes
third-party bodies co-tenantable, and it is the reason the declared path exists at all.

`dsx.component` / `dsx.route` / `dsx.screen` are surface namespaces and are a **lint error** in a
server document — a server has no router, so a body using them would silently do nothing.

### Execution model — interpreted, deliberately

A declared body runs through the **JSE interpreter**, not compiled JavaScript. The kernel does
own a JS tier (`compile/jstier.ts`, the /web/15 escalation) but only `packages/dom/src/boot.ts`
installs it, and the server does not — on purpose. That tier is a `with`-proxy fence around
`new Function`, which is a hardening layer for code the app's own author wrote; it is not an
isolate, and it is not the boundary to put between two tenants of one deployment. The
interpreter is the boundary, and the interpreter is the reason the seam list in §3 is
exhaustive rather than aspirational.

**Measured cost (2026-08-12, Node 22):** ~**10 µs per simple loop iteration** in steady state
(~100 k iterations/second); a first call adds ~70 ms of tokenizing and warm-up. For a handler
that validates input, makes two or three database calls and returns, this is invisible — the
network hop dominates by orders of magnitude. For anything that would notice, the honest answer
is that the work belongs on a queue, not in a request.

**Loop idioms behave correctly here, all of them** — including a classic
`for (let i = 0; i < n; i++)`, because the TS runner gives authored `let`/`const` real block
scope. The store-shadow trap the monorepo working rules document is an iOS/Android-runner behaviour, so it
constrains an action shared with a screen, never a server-only body. If a future build wants
native JS speed, the path is build-time codegen of subset-clean bodies (`compileBlock` +
`classifyBody` already exist) — same semantics, same guarantees, no sandbox implication,
because the subset is exactly what the interpreter already permits. It is not wired today.

### Computational completeness — what a body can express

The bar is: **if data manipulation can be written in JS, it can be written in a body.** That was
measured rather than assumed — 117 constructs run through the real handler path, compared against
the JS answer. The result before these waves was 105/117; after them, 112/117, with the syntax-005 follow-up closing optional call and array-pattern assignment besides.

Already whole and unchanged: `map` · `filter` · `reduce` · `find` · `some` · `every` · `sort` ·
`slice` · `concat` · `join` · `flat` · `flatMap` · `includes` · `indexOf` · `reverse` · `at` ·
`Array.from` · `Array.isArray` · spread · `Object.keys/values/entries/assign/fromEntries` ·
object spread · every string method incl. regex `match`/`replace`/`test` · template literals ·
`Math.*` · `parseInt`/`parseFloat`/`Number` · `JSON.parse`/`stringify` · `Date` · ternary ·
optional chaining · nullish · `switch` · `try`/`catch`/`finally` · `typeof` · `in` · closures ·
recursion · default and rest params · `for…of` · `for…in` · `while` · `do…while` · labels aside.

**Added by this wave** (each was measured failing first, and the first two failed SILENTLY WRONG,
which is why they were worth grammar rather than a workaround):

| Construct | Was |
|---|---|
| `{ [k]: v }` computed keys | evaluated to `{ k: <value of k> }` — no error, just wrong |
| `([k, v]) => …` destructured params | bound the whole pair to one name; `Object.entries(o).map(([k, v]) => …)`, the single most common data idiom in JS, returned stringified rows |
| `const { a: { b } } = row` | nested patterns bound nothing |
| `const { a = 5 } = opts` | defaults were ignored |
| `const { id, ...rest } = row` | object rest bound nothing — the standard "omit a field" had no clean spelling |
| `const [a, ...tail] = xs` | array rest, same |
| `'a'.localeCompare('b')` | absent, so a comparator sort of strings silently did nothing |

Corpus: `OpenSource/Conformance/jse/syntax-004.json` (26 cases), run on TS (interpreter AND
compiled tiers) and Kotlin `:core`; the Swift twin is written and rides the next build, as Swift
always does here.

**Deliberate divergences, still true, all documented at their source:**

- **Arithmetic is TOTAL.** `1/0` is `0`, not `Infinity` (`Conformance/jse/core-001.json` states
  it). A body cannot produce NaN or Infinity, so `Number.isFinite` is always true for a computed
  number. This is the number model, not a gap; changing it is a MAJOR bump.
- **A lambda captures a scope SNAPSHOT.** A closure that mutates a captured local does not see
  its own writes across calls — use a store variable for accumulating state.
- **The expression tier has no loop statements.** `<variable>`/formula bodies are bounded blocks;
  loops live in `<action>` bodies, which is where server logic is written anyway.
- **Still absent, each with a workaround:** labelled `break` (use a flag or a helper action)
  and object-pattern ASSIGNMENT without a declaration (`({a} = o)` — a `const` covers it).
  Optional call `o.f?.(…)` and array-pattern assignment `[a, b] = [b, a]` landed 2026-08-12
  (`Conformance/jse/syntax-005.json`, three runtimes; the swap works at the runner level too,
  where it writes wherever `a = …` would have).

### Budgets### Budgets

Per request, clamped by the platform (`ACTION_LOOP_CAP` 50 000 · `ACTION_DEADLINE_MS` 10 000 ·
`ACTION_CALL_CAP` 64). A document may ask for less, never more: a budget an author can raise is
not a budget. The loop budget and the wall clock are enforced at the runner's single loop choke
point, so a non-terminating body is contained rather than merely abandoned.

**Containment is not the answer to the caller.** The runner stops the loop and the body runs on,
which is right for a surface — a contained tap handler beats a frozen screen — but on a request
it would return whatever the body had accumulated when the loop was cut. Measured before the
check existed: `while (true) { n = n + 1 }` answered `200 {"n":20000}`, a half-computed value
indistinguishable from a real one. `declaredHandler` therefore inspects all three ledgers after
the run and answers **503 `budget_exceeded`** naming which budget went, regardless of what the
body chose to return — including when the body caught the refused module call and returned
something cheerful.

### Failure

A `throw { reason, message }` becomes its real status: `invalid`/`bad_request` 400 ·
`unauthenticated` 401 · `forbidden` 403 · `not_found` 404 · `conflict` 409 · `rate_limited` 429 ·
`upstream` 502 · `unavailable` 503. The author's message survives, because it is the author's
words about the CALLER's input. Anything thrown outside that vocabulary is a **fault**: 500,
redacted, correlation id, detail to the failure sink — the same path any handler exception takes.

## 4 · TypeScript stays, as the ejection hatch

`provides: ["server"]` TypeScript handlers work unchanged, and a module may carry hand-written
handlers, declared CRUD and declared bodies at once (`server.http` does — it is the dogfood). A
module that needs `pg` or a vendor SDK writes TypeScript and lives at a higher trust tier. This
mirrors the system-defaults law exactly: the declared path is the default, and authoring past it
is an explicit, visible ejection. The emitter aborts on any name collision between the three
sets rather than letting one silently shadow another.

## 5 · The import primitive

A body cannot write an `import` statement by construction, so `Core/Server/Modules/Import`
registers the **`packages`** declaration namespace. A row binds a pinned npm coordinate to a bus
scheme; the build compiles the adapter:

```jsonc
{
  "web": { "server_dependencies": { "stripe": "17.5.0" } },
  "facets": { "packages": { "stripe": { "package": "stripe", "scheme": "pay" } } }
}
```

```dsx
<action as="charge" inputs="amount">
  const made = await dsx.module.pay.charges.create({ amount: amount, currency: 'usd' })
  return { id: made.data.id }
</action>
```

**Every export is reachable by path — nothing is enumerated.** The chain remainder after the
scheme (`charges.create`) resolves against the imported namespace at call time, so an SDK needs
no manifest entry per method and cannot go stale when the vendor ships a new one. A nested method
keeps its receiver, so `this`-dependent SDKs work unchanged.

Three calling conventions, because npm has no single one:

| Call site | Becomes |
|---|---|
| `dsx.module.pay.charges.create({ amount: 1 })` | `stripe.charges.create({ amount: 1 })` — the modern single-object shape |
| `dsx.module.slug.default({ args: ['Hi', { lower: true }] })` | `slugify('Hi', { lower: true })` — positional, the general escape hatch |
| a declared `params` row | named keys mapped to positions, so the call site reads in names |

`exports` remains available as an **alias** map (`{ "make": "default" }`) for a friendlier word.
It is never a permission list: enumerating a package's surface in a manifest would be a
hand-maintained second copy of it, stale the first time the vendor adds a method.

### What stays declared, and why it is the package rather than the export

A body cannot name a **coordinate** the build did not install. A runtime import of an arbitrary
name is invisible to esbuild, to the licence gate and to the assembly receipt — and a dependency
the build cannot see is one nobody can audit, pin, or exclude. So the operator declares *which*
packages exist; the author uses *whatever* those packages offer.

### The two guards that make arbitrary paths safe

1. **The escape path is refused at every step.** `constructor`, `__proto__` and `prototype` are
   never reachable export names — `Function("return process")()` is how every JS sandbox that has
   fallen has fallen. Resolution also requires **own** properties: the prototype chain is where
   the ambient lives, and none of it is a package's real surface.
2. **A package returns DATA, never a live object.** The result is copied to a JSON shape before
   it crosses into the body, so functions, symbols, class identity and getters do not survive,
   cycles answer `null` at the cycle, and an oversized result is a typed refusal. Without this a
   package that returned something holding `process` would leak the environment one property read
   at a time, and a getter would fire inside the body's read path as an undeclared side effect.

A package still runs at the **host** trust tier — it is ordinary JavaScript with the full reach of
the process. Declaring one is an operator act with a build record; the point of the declaration is
that the act is visible in the build rather than buried in an import statement.

`lane` defaults to `server` and is the only lane this primitive emits. The other two already have
their own: a browser bundle resolves npm through the app's own bundler, and a native module's
binary dependencies are the `build` primitive (`OpenSource/Skills/module-frameworks.md`).

## 6 · How it is wired

| Piece | Where |
|---|---|
| The document reader | `ClosedSource/scripts/server_document.rb` (+ `_test.rb`, 23) |
| Row merge + emission | `ClosedSource/scripts/prepare_server.rb` — `actions.generated.ts` per chain, following the declared-CRUD precedent |
| The executor | `OpenSource/Web/packages/server/src/actions.ts` — `declaredHandler` returns an ordinary `HostHandler`, so `host.ts` needed no change |
| The import runtime | `OpenSource/Web/packages/server/src/packages.ts`, bound at boot by every bootloader |
| The kernel's share | `RunEnv.callModule` (request-scoped funnel) · `RunEnv.egress` · `loopCap`/`deadlineAt`/`callBudget` · `ActionRunner.takeThrow()`. All unset on every surface, so nothing about an app changes |
| Lint | `lint_dsx.rb` routes a `<server>` root to the document reader — stricter than the element linter, since the vocabulary is closed |

The kernel additions are deliberately four lines each: `runner.ts` ships in every bundle
including a self-contained embed, so the server-shaped logic lives in `@despia/server` where no
embed pays for it. The measured cost of the whole capability is **186 bytes gzip**, and the
media-qualification ledger was re-pinned in the same change rather than quietly drifting.

## 7 · What this is NOT

- Not a replacement for the backend infrastructure — a front door onto it.
- Not a removal of TypeScript handlers (§4).
- Not a new deployment story: the same emitters, the same bundle, the same one-button deploy.
- Not a fourth renderer: the server node executes actions, it does not paint.

## 8 · Known limits, named rather than hidden

- **Sugar.** `dsx.data.order.create(…)` would read better than
  `dsx.module.data.order.create(…)`, but a new `dsx.*` root is authoring surface and the
  unified-codebase law would require it on all three renderers first. The module form is the
  law-abiding spelling and works today.
- **`<field>` carries `as` and `type` only.** `required` and `default` are not in the schema
  facet's vocabulary, so they are refused rather than silently ignored; widening the vocabulary
  is a schema-facet change on both provider compilers, not a document-reader change.
- **The queue plane is Postgres-only** (`full-stack-execution.md`), so a `<worker>` in a
  Firestore-configured tree gets a typed `no_provider`, never a silent `drained: 0`.
