# DSX Events — the model

> The expression & logic engine is **JSE** — see [`jse.md`](./jse.md). Every `on:*` body, `dsx.event(…)` call, and handler here is JSE.

One small, explicit model. **An event always goes to whoever emitted it** — a component's
consumer, or an action's caller. There is **no global bus** (no `<listener>`): for decoupled or
cross-screen reactions you use shared **state** (`global.*` + `computed`), not events.

---

## Two ways to handle an event

### 1. Component events → the consumer
A component emits; whoever placed it handles it with `on:<event>` — the same model as
React's `onX` callbacks / a Web Component's `CustomEvent`.

```xml
<Modal on:close="dsx.variable.showModal = false"/>                 <!-- consumer handles -->
<!-- inside Modal.dsx -->
<button on:tap="dsx.event('close')"/>                 <!-- emit the event -->
```

### 2. Action events → the caller (callbacks)
An action emits named outcomes; the **call site** passes inline handlers — the
`onSuccess`/`onError` / mutation-hook model. `dsx.this` = the event payload.

```xml
<action as="checkout">
  const order = await fetch('/checkout', { method: 'POST', body: dsx.variable.cart });
  if (order.error) dsx.event('error',   { msg: order.error });
  else             dsx.event('success', { id: order.data.id });
</action>

<button on:tap="dsx.action.checkout({ amount: 50 }, {
  success: () => { dsx.route.path = '/receipt/' + dsx.this.id },   // dsx.this = the payload
  error:   () => { dsx.module.toast.show({ text: dsx.this.msg }) }
})"/>
```

- 1st arg = the action's **input** (merged into its scope). 2nd arg = the **event callbacks**.
- Handler bodies are full bounded-JS (multi-line `() => { … }`), run with `dsx.this` = the payload.
- **Reusable:** two call sites handle the same action's events differently.

> **`await fetch(url, opts)`** is the web fetch JS API — it suspends, returns
> `{ data, error, status, ok }`, then the rest of the body runs (so the `if` sees the result).
> The reactive `fetch: dest = …` effect verb still exists for spinners (it writes a `{loading,error,data}`
> envelope to state); `await fetch` is for sequential logic.

---

## Filtering by emitter — `from:<event>`

Still the consumer model — no global bus. A `from:<event>` companion attribute on the **same
binding** narrows *which* emitter that `on:<event>` accepts, when several sources raise the same
event name:

```xml
<PlanRow on:select="buy()" from:select="action=choosePlan"/>   <!-- only events the choosePlan ACTION raised -->
<Cart    on:update="sync()" from:update="component=Cart"/>     <!-- only events the Cart COMPONENT raised -->
<Row     on:done="…"        from:done="checkout"/>              <!-- any source NAMED checkout (action or component) -->
```

Every `dsx.event(name, payload)` is auto-stamped with its emitter's identity — `payload.__from =
{ type, name }` (`type` is `"action"` for an event raised inside a named `<action>` body, or
`"component"` for one a native component emits; `name` is that action / component-tag). The
`from:<event>` filter matches against that stamp; a typed form (`action=` / `component=`) targets
exactly one even when an action and a component share a name, and a bare form (`from:done="checkout"`)
matches any source of that name. No `from:` → the binding accepts the event regardless (the
unfiltered default).

An event raised loose — directly in an `on:tap`, with no `<action>` on the call stack — is
**unstamped**, so a `from:action` filter won't match it (there is no action identity to match). Put
the instance id in the **payload**, never in the event name, and keep the name stable.

---

## Rate-limiting a handler — `.debounce` / `.throttle`

Declarative timing modifiers on an `on:<event>` binding, handled in the runner (no manual
`setTimeout` plumbing):

```xml
<field on:input.debounce="300" on:input="search()"/>     <!-- run 300ms after typing stops -->
<button on:tap.throttle="1000" on:tap="save()"/>          <!-- run now, then ignore taps for 1s -->
```

- **`.debounce="ms"`** — coalesce a burst: each fire cancels the pending run and reschedules `ms`
  ahead, so only the **last** call in a quiet-for-`ms` window runs (search-as-you-type, resize).
- **`.throttle="ms"`** — rate-limit: the **first** call runs immediately, then calls are dropped
  until `ms` has elapsed (scroll/tap spam, a submit button).

Both reuse the keyed-timer machinery (`store.timers`, the same one `setTimeout(…, key)` uses), so
they're **surface-scoped** — a pending debounced run is cancelled when the surface deallocates, never
firing into a dead screen — and bounded. No modifier → an immediate run, so existing bindings are
unchanged. (Available on the control / tappable-element `on:<event>` bindings — `tap`, `submit`,
`input`, …; the gate is per binding, so two debounced controls keep independent windows.)

---

## Everything else isn't an event

- **React to a value** → `computed` (`<variable as="badge" computed="true">dsx.variable.cart.lines.length</variable>`). Most "when X changes, update Y" is *state*, and state is automatic.
- **React to the screen loading/settling** → the shell publishes `dsx.screen.ready` (Bool) / `dsx.screen.phase` (`"loading"`|`"ready"`) as reactive state — `visible-if="!dsx.screen.ready"` for a loading state, no event needed. (Native module authors hook `screen.loading`/`screen.ready` instead — see [screen-lifecycle.md](screen-lifecycle.md).)
- **Cross-screen** → `global.*` + `computed`.
- **Native / cross-language** → a module taps any DSX event via `dsx.events.on('scheme')`
  (component-tag scheme, or an explicit `scheme:event` name). Cross-cutting effects
  (analytics, haptics) live in modules or the consumer's handler.

---

## Cheat-sheet

```
value change                → computed / global.*           (no event)
component → its consumer     → dsx.event('x')  +  on:x
action   → its caller        → dsx.event('x')  +  dsx.action.name(args, { x: () => … })
to a native module           → dsx.events.on('scheme')       (automatic)
```

**The three emit channels:** `dsx.event('x')` (component → consumer), `dsx.send('x')` (native
`ui.on`), `dsx.broadcast('x')` (cross-module bus + web). Most app code only needs the two above.
