# State & computation in DSX

> The expression & logic engine is **JSE** — see [`jse.md`](./jse.md). Everything below (`{{ }}`, `visible-if`, action bodies) is JSE.

How DSX does what Alpine/Vue do with JavaScript — **declaratively**, without shipping
arbitrary code. The model: a reactive **store**, **expressions** that read/derive from it,
and **actions** (1:1 JS statements) that mutate it. It is deliberately **not** a general
programming language — and the last section explains exactly where that line is and why.

> **This is NOT JavaScript — it is JS-*lookalike* syntax compiled straight to native.**
> A JS dev reads and writes it 1:1, but **nothing runs JavaScript**: there is **no JS
> engine and no bridge** (no JavaScriptCore/Hermes). Every expression and statement is
> parsed and interpreted **directly into native values** (Swift on iOS, Kotlin on
> Android), reading straight from the native store — **bridgeless, instant, zero
> overhead**, with no marshaling across a JS↔native boundary on any read. (`eval` in the
> engine is the *interpreter* sense — "evaluate this in an environment" — never
> `JSContext.evaluateScript`.) Because it is also **bounded** (no unbounded loops or
> recursion — see §7), downloaded/OTA screens can't hang or DoS the UI by construction.

---

## 1. The store (your `$store` / `x-data`)

Two scopes, both reactive (any read re-renders when the value changes):

| Scope | Write | Read |
|---|---|---|
| **Surface** (this screen) | `dsx.variable.draft = 'hi'` | `{{ dsx.variable.draft }}` / `bind="dsx.variable.draft"` |
| **Global** (app-wide, `DSXState`) | `global.cart.total = 9` | `{{ global.cart.total }}` |
| **Route** | `route.path = '/home'` | `{{ route.params.id }}` |

Writes are **path- and index-aware** (`store.setPath`): `dsx.variable.feed.data.5.name = 'x'`
edits item 5 in place. A list row's `item.*` is a first-class writable scope too:
`<toggle bind="item.done"/>` edits that row.

**`dsx.this` — the current scope** (one name everywhere). In a list row, a `map`/`filter`
element, or a `<formula>`/`<action>` body, `dsx.this` is the current item / element / params, and
**`dsx.this.index`** is its position in the loop:

```xml
<list bind="dsx.variable.todos" key="id">
  <text>{{ dsx.this.index }}. {{ dsx.this.text }}</text>
</list>

{{ dsx.variable.users.filter((u, i) => u.active && i < 5) }}      <!-- element + its index -->
<formula as="greet" name="dsx.variable.user.name">return 'Hi ' + dsx.this.name</formula>
```

`dsx.this.x` is the same as `item.x` / bare `x` — it's just the explicit, JS-familiar way to say
"the current thing." `dsx.this.index` is injected by the iteration (lists/grids and `map`/`filter`
/`find`/…). (`$` is a valid identifier char, so `dsx.this` / `$index` parse as names.)

**Explicit `$`-namespaces (opt-in).** `dsx.this` generalizes — every scope has an explicit
`$`-prefixed spelling, so production / generated DSX can disambiguate at a glance. They are
**aliases**: the bare forms keep working and both resolve identically.

| Explicit | Bare equivalent | Scope |
|---|---|---|
| `dsx.variable.x` | `x` | this surface's state |
| `dsx.global.x` | `global.x` | app-wide (`DSXState`) |
| `dsx.route.x` | `route.x` | navigation / route state |
| `dsx.params.id` | `route.params.id` | dynamic path params |
| `dsx.query.ref` | `route.query.ref` | query params |
| `dsx.path` | `route.path` | the path string (writable → navigates) |
| `dsx.attribute.name` / `dsx.item.x` | `attribute.x` / `item.x` | a component's attribute (web-component model) / current item |
| `dsx.this.x` | `item.x` / bare `x` | the current row / element / payload |

Invocation mirrors this: **`dsx.action.name()`** runs a named `<action>` (an effect — keep the
`()`), and **`dsx.formula.name`** reads a `<formula>` (a value — **no** `()`). Navigation is just a
state write — `dsx.route.path = '/home'` (or bare `route.path = …`); there is no separate `href`.

> **In native module code these names differ.** `dsx.variable("name", value)` is the *legacy*
> window-global injection verb, and `dsx.action("name") { … }` *registers* a scheme handler (the
> native runtime API, not these markup forms). See
> [Skills/runtime-api.md](../../Skills/runtime-api.md).

For history, the `route` module keeps a back-stack (`global.nav.stack`): `dsx.module.route.push({path})` /
`dsx.module.route.pop()` / `dsx.module.route.popTo({path})` (back to the deepest frame whose
concrete path matches, query strings ignored on both sides — one transition, not N pops; the
matching rule is pinned by the shared corpus `OpenSource/Conformance/router/popto.json`) /
`dsx.module.route.popToRoot()` / `dsx.module.route.replace({path})` /
`dsx.module.route.reset({path})`, with `nav.canPop` / `nav.depth` for affordances —
`route.path = …` stays a *replace*. Stack verbs never dismiss native `nav.modal`
presentations; on web (v1) sheets still ride the frame stack, so a multi-pop passes through
an open sheet — W4 aligns this.

Components present via `dsx.component.push(name, { attrs })` (a native SCREEN) or
`dsx.component.present(name, { as, touch, attrs })` — `as: "sheet" | "cover" | "overlay"`,
and for overlays `touch: "passthrough"` (default — only the overlay's drawn content is
tappable; a glass menu bar over a web view leaves the page live) or `touch: "block"` (the
full overlay — nothing reaches beneath). Planes: content < overlays < sheets/covers — a
drawer always opens above a menu-bar overlay. `dsx.component.dismiss([target])` closes by
tag or mode. **`attrs` is the component input contract**: the same attributes you would
write hard-coding the tag (`<Paywall plan="pro"/>` ≡ `push('Paywall', { attrs: { plan:
'pro' } })`), seeding the reactive `dsx.attribute.*` dict — passed value beats `default=`,
reads re-derive on change, and a live `dsx.component.update([target], { attrs })` merges
new values in and fires the declaration's `on:change` (see
[`dsx-anatomy.md`](./dsx-anatomy.md) §interface). `vars` remains as the legacy store-seed
channel (`vars.*`) — new code passes `attrs`. The machine is corpus-pinned:
`OpenSource/Conformance/router/present.json`.

**Styling: classes + theme tokens.** Define reusable style classes with `<style as="card"
padding="16" background="#111" radius="12"/>` and apply them anywhere with `class="card"`
(multiple: `class="card wide"`; the element's own attrs win). Theme tokens live in
`global.theme`, read via `dsx.global.theme.*` (`color="{{ dsx.global.theme.primary }}"`) — swap `global.theme`
to flip light/dark.

---

## 2. Building values — literals + functions

Expressions (`{{ … }}`, `bind=`, `visible-if=`, and the RHS of action statements) now include:

- **Object literals** — `{ text: draft, done: false, id: now }`
- **Array literals** — `[1, 2, 3]` / `[{ a: 1 }, { a: 2 }]`
- **Functions** (pure, total): `upper`, `lower`, `cap`, `trim`, `len`/`count`, `abs`,
  `round`, `floor`, `ceil`, `min`, `max`, `int`, `pad`, `if`, `matches`,
  `first`, `last`, `reverse`, `sum`, `join`, `contains`, `keys`, `values`, `range`,
  the `typeof x` operator (runtime type branching — `'number'`/`'string'`/…),
  and **form validators** `required`, `email`, `url`, `phone`, `minLength(v,n)`,
  `maxLength(v,n)`, `regex(v,pattern)` — pure predicates that compose in a computed
  `errors` block (`if (!email(form.email)) { e.email = '…' }`).

```xml
<text>{{ upper(dsx.variable.user.name) }} — {{ count(dsx.variable.todos) }} items, {{ sum(dsx.variable.cart.lines) }} total</text>
```

These are the same in markup and in action RHS (action RHS uses **bare** expressions —
no `{{ }}` — e.g. `dsx.variable.total = sum(dsx.variable.cart.lines)`).

---

## 3. Mutating arrays — the JS array methods (`push` / `splice` / …)

Call a mutating method on the array at a state path (surface / `global.*` / `route.*` / nested
like `feed.data`); the engine mutates it in place and writes it back. The item is an
**expression** (so object literals work).

| JS you write | Does | Example |
|---|---|---|
| `arr.push(x)` | append | `dsx.variable.todos.push({ id: dsx.variable.now, text: dsx.variable.draft, done: false })` |
| `arr.unshift(x)` | prepend | `dsx.variable.feed.unshift(item)` |
| `arr.splice(N, 0, x)` | insert at N | `dsx.variable.todos.splice(0, 0, { text: 'top' })` |
| `arr.pop()` | drop last | `dsx.variable.undo.pop()` |
| `arr.shift()` | drop first | `dsx.variable.queue.shift()` |
| `arr.splice(start, count, …items)` | replace / remove a range | `dsx.variable.todos.splice(2, 1, { text: 'new' })` (replace) · `dsx.variable.todos.splice(2, 3)` (remove) |
| `arr.splice(0)` | empty it | `dsx.variable.cart.lines.splice(0)` |
| `remove: arr = val [key=f]` | remove by value/key | `remove: dsx.variable.todos = {{ item.id }}` · `remove: dsx.variable.cart = {{ item.sku }} key=sku` |
| `remove: arr where <pred>` | remove matching rows | `remove: dsx.variable.todos where done == true` |

`remove:` has **no JS spelling** (it filters by value/key/predicate) — it stays an effect verb,
written as a leaf statement inside the JS control flow.

**`remove … where` scoping:** the predicate runs **per row**. Use `{{ }}` for an outer
value (resolved once against the tapped row / store), and **bare** names for the row's own
fields: `remove: dsx.variable.todos where slug == '{{ item.slug }}'` → for each row, test
`slug == 'abc'`. This is also how you delete by a **custom key** (just name the field) or in
bulk (`remove: dsx.variable.todos where done == true`).

**Update a field in place** — a plain assignment with an index path (this is just `setPath`,
which is array-index- and nested-aware): `dsx.variable.todos.4.done = true` sets the **5th** item's `done`
(0-based, exactly like JS `dsx.variable.todos[4].done = true`). It even grows the array with empty objects
if that index doesn't exist yet. (For the *current* list row, prefer `bind="item.done"`.)

Statements **sequence** with `;` like any action:
`on:submit="dsx.variable.todos.push({ id: dsx.variable.now, text: dsx.variable.draft, done: false }); dsx.variable.draft = ''"`.

---

## 4. Deriving — bounded "loops + map" (higher-order functions)

`map` / `filter` / `reduce` / `find` / `some` / `every` / `sortBy` / `sumBy` / `reject` /
`forEach` / `groupBy` / `keyBy` call an **arrow function per element** — a real loop, but a
**bounded** one: it iterates a *finite* collection exactly once and always terminates. Method
`coll.map(fn)` or prefix `map(coll, fn)`; the 2nd arrow param is the index (`(x, i) => …`).
The grouping/repeat shapes are **1:1 JS**: `Object.groupBy(coll, fn)` (ES2024) returns
`{ key: [elements] }` (sectioned lists), `Object.fromEntries(coll.map(x => [x.k, x]))` builds
lookup tables, `Array.from({ length: 8 }, (_, i) => i)` is the repeat-N ladder a `<list>`
binds to, and descending sort is `sort((a, b) => b - a)`. (Prefix conveniences `groupBy` /
`keyBy` / `range(1, 8)` / `sortBy(coll, fn, 'desc')` are aliases in the `len`/`upper` family.)
Arrows are **closures** — they snapshot their creation scope, so nested arrows read enclosing
params/row fields:

```xml
{{ dsx.variable.todos.filter(t => t.done).length }}                        <!-- how many are done -->
{{ dsx.variable.products.filter(p => p.price < dsx.variable.budget) }}                  <!-- everything under budget -->
{{ dsx.variable.cart.lines.map(({ qty, price }) => qty * price) }}         <!-- line totals -->
{{ dsx.variable.cart.lines.reduce((s, { qty, price }) => s + qty * price, 0) }}   <!-- order total -->
{{ sortBy(dsx.variable.todos, t => t.priority) }}                          <!-- ordered -->
{{ dsx.variable.users.find(u => u.id == 7).name }}                         <!-- lookup -->
```

They **compose by chaining/nesting** — `dsx.variable.todos.filter(t => t.done).length`,
`dsx.variable.cart.filter(l => l.selected).reduce((s, l) => s + l.price, 0)` — the transforms apps actually
need, all 1:1 JS. Bind a derived value straight into a `<list>`:

```xml
<list bind="dsx.variable.todos.filter(t => !t.done)" key="id"> … </list>   <!-- only the open items -->
```

---

### Named variables & computed — `<variable>`
Declare state from inline code in the document **head** (see
[`dsx-anatomy.md`](./dsx-anatomy.md)). **One tag, two modes** via the `computed` flag; both
are referenced as **plain variables** (`{{ name }}` / `bind="name"`):

```xml
<screen>
  <head>
    <!-- plain (mutable) variable with a default — assignment / push() take over after -->
    <variable as="todos">return []</variable>
    <variable as="filter">'all'</variable>

    <!-- computed (reactive, read-only) — re-evaluated each read, in the current scope -->
    <variable as="openCount" computed="true">dsx.variable.todos.filter(t => !t.done).length</variable>   <!-- one-liner → implicit return -->
    <variable as="label" computed="true">item.done ? '✓ ' + item.text : item.text</variable>
  </head>
</screen>
```

- **Plain** (`<variable>` / `<var>` / `<let>`, no `computed`) → initialized **once** to the
  evaluated body, then an ordinary mutable variable (assignment / `push()` / `bind`).
- **Computed** (`computed="true"`) → a reactive formula re-evaluated on every read **in the
  current scope** — a body over `item.*` derives **per list row**, the same one is screen-level
  outside a list. Read-only.

The identifier is **`as`** — uniform with `<formula>` / `<action>`. (The legacy bare `name=`
identifier was removed.) Computed is the `computed="true"` flag on `<variable>`, not a separate tag.

The body is **bounded JS** — a single expression, **or a `{ }` function body** with
`if (…) { } else if { } else { }`, `const` / `let`, and `return` (early or implicit-last).
Use **explicit `return`** for the value (even trivial defaults read clearly with it —
`<variable as="todos">return []</variable>`). A one-liner may omit it (the bare expression is
the value), but anything multi-line should `return`.

```xml
<variable as="discount" computed="true">
  const subtotal = sumBy(dsx.variable.cart.lines, ({ qty, price }) => qty * price);
  if (subtotal > 100) { return subtotal * 0.2; }
  else if (subtotal > 50) { return subtotal * 0.1; }
  else { return 0; }
</variable>
```

A computed block is **pure**: `const` / `let` / `x = e` write a throwaway **local scope**
(never the store), and there are no loops — so reading it is side-effect-free and always
terminates. A real store-var assignment of the same name overrides a computed/default;
self-reference is depth-guarded.

So the read side mirrors the write side — `{{ }}` / `<variable>` = **data + computed**, and
assignment / `push()` / `<action>` = **mutations + methods** (the Vue/Alpine model, declarative).

### Parameterized formulas — `<formula>`
A `<formula>` is a reusable, reactive **function with named inputs**: each attribute is an
input (an expression evaluated where the formula is read), and the body computes from those
names as locals. Referenced like a computed (`{{ name }}` / `bind="name"`), recomputed on each
read.

```xml
<formula as="lineTotal" qty="item.qty" price="item.price">
  return qty * price
</formula>

<formula as="label" done="item.done" text="item.text">
  return done ? '✓ ' + text : text
</formula>

<list bind="dsx.variable.cart" key="id">
  <text>{{ label }} — {{ lineTotal }}</text>   <!-- inputs bind to each row -->
</list>
```

Same function-block body as a computed variable (`if/else`, `const`, `return`), but its free
variables are the **declared inputs**, wired at the formula — not pulled from ambient scope.
That makes the logic explicit and reusable: the *same* `<formula>` works in any scope that can
supply its inputs (a row, the screen, global). Declare it in the document head.

**Identifier — `as`.** The identifier is **`as`** (uniform with `<variable>` / `<action>`), so
*every* other attribute — including one literally called `name` or `id` — is an input. (The
legacy bare `name=` identifier was removed.)

```xml
<formula as="greet" name="dsx.variable.user.name">return 'Hi ' + name</formula>   <!-- `name` is now an input -->
```

**Actions take the same params.** A `<action>` is parameterized identically — `as` +
input attrs — bound in the caller's scope when it runs (layered on as locals):

```xml
<action as="addToCart" id="item.id" qty="1">
  dsx.variable.cart.push({ id: id, qty: qty });
  dsx.module.haptic.success()
</action>
<pressable on:tap="dsx.action.addToCart()"> … </pressable>   <!-- id/qty bind to the tapped row -->
```

### Reusable functions — `function name(params) { … }`
Define a callable, reusable function in a `<script>` (or any declaration body) — **1:1 JS**,
positional args, **depth-capped at 32** (bounded — can't hang). Call it from any expression
(`{{ discount(dsx.variable.cart) }}`, `bind`, an action). The body is the same bounded-JS block — **write raw
JS** — code-element bodies are read **1:1**, so `<` / `&&` / `]]>` and all need no escaping (no CDATA):

```xml
<script>
function discount(cart) {
  const subtotal = cart.lines.reduce((sum, { qty, price }) => sum + qty * price, 0);
  if (subtotal > 100) return subtotal * 0.2;
  if (subtotal > 50) return subtotal * 0.1;
  return 0;
}
</script>

<text>You save {{ discount(dsx.variable.cart) }}</text>
```

**Arrow functions** `(a, { x, y }) => expr | { … }` are first-class values — destructuring
params and all — consumed by the higher-order fns above (`map`/`filter`/`reduce`/…). A module
call takes a JS **options object** with named keys (`pkg.method({ a: b })`); a user function is
**positional** (`discount(cart)`) — both are real JS. (JSE only; see [`jse.md`](./jse.md).)
```

## 5. Worked example — a complete to-do app (pure markup)

```xml
<vstack spacing="8" padding="16">
  <hstack>
    <textfield bind="dsx.variable.draft" placeholder="New todo"
               on:submit="dsx.variable.todos.push({ id: dsx.variable.now, text: dsx.variable.draft, done: false }); dsx.variable.draft = ''"/>
    <text>{{ dsx.variable.todos.filter(t => !t.done).length }} left</text>
  </hstack>

  <list bind="dsx.variable.todos" key="id">
    <hstack spacing="10">
      <toggle bind="item.done"/>                                <!-- UPDATE in place -->
      <text>{{ item.text }}</text>
      <spacer/>
      <pressable on:tap="remove: dsx.variable.todos = {{ item.id }}">        <!-- REMOVE by key -->
        <image icon="trash"/>
      </pressable>
    </hstack>
  </list>

  <hstack>
    <pressable on:tap="remove: dsx.variable.todos where done == true"><text>Clear completed</text></pressable>
    <spacer/>
    <pressable on:tap="dsx.variable.todos.splice(0)"><text>Clear all</text></pressable>
  </hstack>
</vstack>
```
No native code, no JS — `push`/`remove`/`toggle`-via-bind/`filter`/`count` cover it.

---

## 6. Control flow & scaling action logic

### if / else inside actions
Actions are **bounded JS** — `if (cond) { … } else if (c) { … } else { … }` (nestable), `const`/
`let`, and statements (the effect verbs + JS forms) separated by `;` / newlines. Conditions are
normal expressions.

```xml
<pressable on:tap="
  if (dsx.variable.stock > 0) {
    dsx.module.cart.add({ id: item.id });
    dsx.variable.added = true;
  } else if (dsx.variable.waitlist) {
    dsx.module.cart.waitlist({ id: item.id });
  } else {
    dsx.module.haptic.error();
  }
"/>
```
With no `if`, the body just runs in order. Statements separate on `;` or newlines. **Note:** an
code elements (`<action>`/`<script>`/…) are read **1:1**, so write raw JS. An
`on:` *attribute* is parsed as XML, so an inline body using `<`/`&&` escapes them (`&lt;`,
`&amp;&amp;`) — or, better, lives in a named `<action>` (below).

### Local bindings — `const` / `let`
Inside any action (or `<action>` / `<variable>` body), `const x = expr` / `let x = expr` declares
an **execution-local** intermediate that later statements, conditions and verbs see — but the
store **never** persists it (a bare `x = expr` writes the store; `const`/`let` stay local). The
local scope is seeded with the current `item`, so `const` over row fields works in a list row too.

```xml
on:tap="
  const total = sumBy(dsx.variable.cart.lines, ({ qty, price }) => qty * price);
  const tax = total * 0.08;
  if (total > 100) { dsx.module.toast.show({ text: 'Big order!' }); }
  fetch: dsx.variable.order = POST /checkout body={ subtotal: total, tax: tax }
"
```
`const` keeps complex actions readable without polluting (or churning) global state.

### JS statement syntax
Action / `<action>` / block statements read as **JavaScript**:

| JS you write | does |
|---|---|
| `x = expr` (`const x =` / `let x =` for a local) | set a store var / local |
| `cart.push({ id, qty })` · `.pop()` · `.shift()` · `.unshift(x)` · `.splice(s, n, …)` | the array verbs |
| `dsx.module.haptic.success()` · `dsx.module.cart.add({ id: item.id })` | module call (options object) |
| `dsx.action.checkout()` | run a named `<action>` |
| `{ id, qty }` | object literal incl. shorthand `{ id } == { id: id }` |

```xml
on:tap="
  const total = sumBy(dsx.variable.cart.lines, ({ qty, price }) => qty * price);
  dsx.variable.cart.push({ id: item.id, qty });
  dsx.module.haptic.success()
"
```

**Effect verbs (no JS form):** `fetch:` and `remove: … where` stay verb-prefixed — framework
effects with no JS spelling, written as leaf statements inside the JS control flow. (The emit
channels do have JS forms — `dsx.event` / `dsx.send` / `dsx.broadcast`; see `events.md`.) A module
call passes a JS **options object** — `pkg.method({ a: b })`, real JS — so its args are named keys
rather than positional (a user **function** call stays positional, `discount(cart)`). The object
literal is the only form (JSE only; see [`jse.md`](./jse.md)).

**Sequencing a `fetch:` — `then=` / `catch=`.** A fetch is async; to run something *after* it
resolves, name a follow-up action: `fetch: dsx.variable.order = POST /checkout body=dsx.variable.cart then=goReceipt
catch=showError`. On a 2xx the `then=` action runs (with `dsx.variable.order.data` already written); on a
network/HTTP error the `catch=` action runs (with `dsx.variable.order.error` set). Each is an ordinary
`<action>` — the callback form of "submit → await → navigate" (a true inline `await` is pending).

### Code in XML — read 1:1 (and the one attribute caveat)
The body of every **code element** — `<script>` · `<action>` · `<formula>` ·
`<variable>` (and `<var>`/`<let>`) — is read **verbatim, 1:1**: the engine lifts it out before XML
parsing and only trims surrounding whitespace. So you write **raw JS** inside them — `<`, `<=`,
`&&`, `&`, even a literal `]]>` — with **no escaping and no `<![CDATA[ … ]]>`**. Multi-line is
fine (newlines preserved); an explicit `<![CDATA[ … ]]>` is still tolerated if a template has one.

The **one exception** is an inline `on:` **attribute** (e.g. `on:tap="…"`): an attribute value is
parsed as XML, so a `<` or `&&` *there* must be escaped (`&lt;`, `&amp;&amp;`) — or, better, moved
into a named `<action>` (a code element, read 1:1). Most inline handlers are `x()` or
simple assignments, so this rarely bites. (Attributes can still span lines; `;`/newlines separate.)

### Named action blocks — `<action>` (the way to scale)
Don't cram big logic into an attribute. Define it **once** as a named block and invoke it with
**`name()`**. The body is bounded JS — **write it raw** (code-element bodies are
read **1:1**, so `<` / `&&` need no escaping, no CDATA):

```xml
<screen>
  <action as="checkout">
    if (count(dsx.variable.cart.lines) == 0) {
      dsx.module.toast.show({ text: 'Cart is empty' });
    } else {
      dsx.variable.checking = true;
      fetch: dsx.variable.order = POST https://api/checkout body=dsx.variable.cart;
      if (dsx.variable.order.error) {
        dsx.variable.checking = false;
        dsx.module.haptic.error();
      } else {
        dsx.variable.cart.lines = [];
        dsx.variable.checking = false;
        route.path = '/receipt';
      }
    }
  </action>

  <!-- …UI… invoke it from anywhere, reuse freely -->
  <button label="Checkout" on:tap="dsx.action.checkout()"/>
  <pressable on:tap="dsx.action.checkout()"> … </pressable>
</screen>
```

`name()` runs the block in the **caller's scope** (a list row's `item` is
available). Declare actions in the **document head** so they're always mounted/registered;
recursion is depth-guarded. This is DSX's equivalent of a component **method** — the logic lives
in one named place, the UI just calls it, and an action can call another to compose.

### Events

The event model lives in [`events.md`](events.md): **component events** (`dsx.event` → the
consumer's `on:<name>`, declared in the head with `<event as="…">`) and **action callbacks**
(`dsx.action.name(args, { success, error })`), plus `computed`/`global.*` for value reactions
and `dsx.events.on` for native modules. There is **no global event bus** — the old `listener`
tag was removed.

## 7. Computational completeness — where the line is, and why

Is DSX "computationally complete"? **The system is; the expression language deliberately is
not — and that's the design, not a gap.**

- **Two layers, both total (bounded), not Turing-complete.**
  - **Expressions** (`{{ }}`, `visible-if`, `bind`, computed `<formula>` — the reactive render
    path): data, paths, arithmetic/logic, object/array literals, functions, and **bounded**
    iteration (`map`/`filter`/`reduce` over finite collections). **No loops, no assignment, no
    recursion** — every expression is *guaranteed to terminate* and *cannot block the UI*. The
    render path stays pure, on purpose.
  - **Statements** (action bodies — `on:*`, `<action>`): full JS control flow — `if` / `switch`,
    `try/catch`, and **`for` / `for…of` / `while` with `break` / `continue`**. Loops are
    **budget-bounded**: every iteration in an event draws on one shared ledger (100 000), and
    past the cap the loop aborts with a log. So statements stay *total too* — they can't hang
    the app — via a **budget** rather than via "no loops."

  This is the same total-by-construction choice as Starlark (Bazel), SQL, Dhall, CUE:
  expressive enough for essentially all view logic, provably safe.

- **Why bounded (a budget), never unbounded?** Three hard costs, all load-bearing for DSX:
  1. **It would freeze the app.** An unbounded loop hangs the main thread. The budget keeps
     "can't block" a guarantee — on the render path (no loops at all) and in event handlers
     (loops abort past the cap).
  2. **It breaks the OTA security boundary.** A *downloaded* screen that could run arbitrary
     unbounded computation is a DoS / abuse vector. Budget-bounded statements can't.
  3. **It isn't needed.** View logic is data transformation + events, which the bounded layer
     covers — now including event-time loops.

- **Genuine Turing-complete computation has a home: modules (native).** Real algorithms —
  recursion, unbounded loops, anything heavy — belong in compiled Swift/Kotlin, invoked from
  markup as a module call:
  ```xml
  <pressable on:tap="dsx.module.pricing.recompute({ cartId: dsx.variable.cart.id })"/>
  ```
  Modules are fully Turing-complete, run off the render path, and stay **OTA-safe** (they
  ship in the binary, reviewed — they can't be hot-downloaded). This is the same
  declarative-layer + native-modules split as the rest of DSX (the HTML/CSS-vs-JS analogue).

**So the complete picture:** markup composes · expressions derive (bounded, total) · statements
mutate & branch & loop (budget-bounded, total) · **modules compute** (Turing-complete, native,
safe). The *system* computes anything; the *declarative layer* stays terminating and
sandboxed — which is exactly what makes OTA + cross-platform + never-freeze possible.

> Rule of thumb: a **bounded** `for` / `while` over your data in an event handler is fine — it's
> budget-capped. Reach for a **module** when you need *unbounded* iteration, recursion, or a
> heavy algorithm: that wants to be native (or a backend call), off the render path.
