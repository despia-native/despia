# Action contracts — inputs in, events out

**Foundational best practice.** How to write an action so it stays testable, reusable and
debuggable. This is not style: it is the difference between logic you can reason about and logic
you can only run.

> **The grammar law lives in [attribute-classes.md](attribute-classes.md)** — one attribute
> classification for every DSX block (`input:` · `on:` · `type:` · `given:` · `expect:` · `comment`,
> plus `<event>` / `<response>` / `<test>` children). This document is the ACTION-specific half:
> why a contract matters and how to write one well.

## Who this markup is for, in order

> **Agents first. The visual editor second. Humans third.**

Not because humans matter least — because **markup a machine can read completely is markup a human
can read at a glance**, and the reverse is not true. Every rule in this document follows from that
ordering:

| The rule | Because the first reader is a machine |
|---|---|
| Declare every input (`input:`) | an agent cannot infer what ambient state an action happens to read |
| Type every event payload | the editor renders a control; an agent knows what `dsx.this.x` holds |
| Samples are real data | preview runs before a backend exists; an agent sees actual shape |
| Contract nests inside the action | nothing can be orphaned, so a partial read is never a wrong read |
| `comment=` carries intent | 50 messages later, an agent sees WHY, not just what |

An agent reading a well-formed action needs **one node** to know its inputs, its outputs, their
shapes, its examples, and its intent. That is the bar.

## The law

> **An action takes its inputs as declared parameters and reports its outcome to its caller.
> It does not reach out for what it needs, and it does not reach out to write what it produced.**

Three rules, in order of how often they are broken:

1. **Declare every input.** If the action needs a value, it takes it as a parameter — never by
   reading ambient state the caller could have handed it.
2. **Report outcomes as events** (or, for a module action, as a declared `resolves`). An action
   should not decide what the screen does about its result.
3. **Handle the result at the invocation site**, inline, where the reader can see the flow.

## Why — this is not taste

| Property | With a contract | Without |
|---|---|---|
| **Testable** | `verify_module_tests.rb` runs the declared cases in CI, no device | untestable — the action needs a whole screen with the right ambient state |
| **Reusable** | works from any screen, any component, any caller | works only where those variables happen to exist |
| **Readable** | data flow is visible at the call site | you must read the action body to learn what it touches |
| **Safe to change** | the contract is the boundary | every ambient read is an invisible coupling |

The testability point is the load-bearing one. An action with `args`/`resolves` is validated
against its own fixtures by a gate **already in the CI chain**. An action that reads
`dsx.variable.draft` and writes `dsx.variable.status` cannot be tested at all — it has no
boundary, so there is nothing to test *against*.

---

## The grammar

### Inputs — every attribute except `as`

```xml
<action as="openLaneMenu" track="dsx.this.track" at="dsx.this.at">
  …use `track` and `at` as plain identifiers…
</action>
```

`as` is the name. **Every other attribute is an input**, evaluated in the CALLER's scope when the
action runs, and bound inside the body as a plain identifier. `dsx.this.*` is the invoking event's
payload.

Read the line as three parts — and note that `track` and `at` are words the AUTHOR chose, not
anything DSX knows:

```
<action as="openLaneMenu"  track="dsx.this.track"  at="dsx.this.at">
        │                  │                       │
        │                  │                       └─ a parameter named "at"     (author's word)
        │                  └───────────────────────── a parameter named "track"  (author's word)
        └──────────────────────────────────────────── the action's name          (LANGUAGE keyword)
```

Left of `=` is the parameter name inside the body; right of `=` is the expression that fills it.

**This is exactly why `input:` is proposed.** Reading the bare form, there is no way to tell a
language keyword from an author's parameter without already knowing the reserved list — and that
list is only `as` and `id`, so the language cannot grow an attribute (`once`, `guard`, `timeout`)
without either breaking markup that used the word or silently swallowing it. Neither is detectable
by a parser, a linter, an agent, or the visual editor. `input:at="…"` removes the ambiguity at a
glance and makes the language extensible.

### Outputs — events, because `return` is local

**A `return` inside a markup action returns from the ACTION, not to the caller.** Markup actions
are procedures. To report an outcome, raise an event:

```xml
<head>
  <event as="saved"  payload="id"/>     <!-- declare what this screen raises -->
  <event as="failed" payload="message"/>

  <action as="addNote" title="dsx.this.title">
    const r = await create.send({ title });
    if (r.ok) { dsx.event('saved',  { id: r.data.id }) }
    else      { dsx.event('failed', { message: r.error.message }) }
  </action>
</head>
```

`<event as="…">` is the outbound contract — `lint_dsx.rb` checks every `dsx.event('x')` against
these declarations, so a typo is a build error rather than an event nobody receives.

### Module actions — a real return value

A module action (`dsx.module.<chain>.<action>()`) *does* resolve a value, and declares its whole
contract in `dsx.json`:

```jsonc
"spend": {
  "args":       { "amount": "number" },        // inputs
  "resolves":   { "balance": "number" },       // output — awaited by the caller
  "broadcasts": ["creditsChanged"],            // fan-out, 0..N listeners
  "tests": [ { "name": "spends from balance",
               "given": { "context": { "credits": 100 } },
               "args":  { "amount": 30 },
               "resolve": { "balance": 70 } } ]
}
```

Those `tests` run in CI. That is the whole argument for declaring contracts.

### Requests vs subscriptions are different shapes

| Shape | Declares | Examples |
|---|---|---|
| **request** | `args` → `resolves` | a query · sign-in · a POST |
| **stream** | `args` → `events` **+ a handle to stop** | realtime · SSE · sensors |

```jsonc
"start": { "args": { "threshold": {"type":"number","optional":true} },
           "stream": true, "events": ["change"] }
```

A subscription declared as a request is a build error, not a runtime surprise.

---

## The anti-pattern, from real code

This is the historical Notes demo shape — **it is written the wrong way on purpose,
because it is the shape everyone writes first:**

```xml
<!-- ✗ WRONG -->
<action as="addNote">
  if (dsx.variable.draft == '') { return }
  const r = await create.send({ title: dsx.variable.draft });
  if (r.ok) { dsx.variable.draft = ''; dsx.variable.status = '' }
  else      { dsx.variable.status = 'could not save: ' + r.error.message }
</action>

<button label="Add" on:tap="addNote()"/>
```

Read the call site: `addNote()`. It tells you **nothing** — not what it reads, not what it writes,
not what happens on failure. Four hidden couplings (`draft` in, `draft`/`status` out), no way to
test it, and it only works on a screen that happens to define those three variables.

```xml
<!-- ✓ RIGHT — the contract is structurally inside the action -->
<action as="addNote" input:title="dsx.this.title">
  <event as="saved">{ "id": "note_7f3a" }</event>
  <event as="failed">{ "message": "title is required" }</event>
  <test name="saves"         input:title="Milk" expect:event="saved"/>
  <test name="rejects empty" input:title=""     expect:event="failed"/>

  if (title == '') { dsx.event('failed', { message: 'title is required' }); return }
  const r = await create.send({ title });
  if (r.ok) { dsx.event('saved') } else { dsx.event('failed', { message: r.error.message }) }
</action>

<button label="Add"
        on:tap="addNote({ title: draft })"
        on:saved="dsx.variable.draft = ''; dsx.variable.status = ''"
        on:failed="dsx.variable.status = dsx.this.message"/>
```

Now the call site is the documentation: **takes `draft`, clears it on success, shows a message on
failure.** The action works from any screen. The screen owns its own state. And the action can be
given fixtures, because it finally has a boundary.

## The specified grammar (PROPOSED — see *Migration* below)

An action's whole contract is **structurally inside the action**: inputs as prefixed attributes,
declarations and tests as children, code as the text body. Nothing about it can be orphaned,
pointed at the wrong action, or drift out of sight.

```xml
<action as="save" input:title="dsx.this.title">
  <event as="saved">{ "id": "note_7f3a" }</event>
  <event as="failed">{ "message": "title is required" }</event>

  <test name="saves a note"  input:title="Milk" expect:event="saved"/>
  <test name="rejects empty" input:title=""     expect:event="failed"/>

  if (title == '') { dsx.event('failed', { message: 'title is required' }); return }
  const r = await create.send({ title });
  if (r.ok) { dsx.event('saved') } else { dsx.event('failed', { message: r.error.message }) }
</action>
```

`StackNode` already carries **both `children` and `text`**, so this needs no parser change in shape
— the code stays the text body and the contract becomes children.

### An event declares a SAMPLE, not a field list

`<event as="saved" payload="id"/>` names a field and stops there. It does not say what the data
looks like, and — verified — **`lint_dsx.rb` does not check `payload` at all**: today the payload
half of the contract is unverified as well as unreadable. A caller writing `dsx.this.…` has to
guess, or go read the action body.

The declaration carries a **real example** instead. `<event>` is purely declarative at runtime
(it renders `EmptyView`), so the body is free:

```xml
<event as="saved">{ "id": "note_7f3a", "title": "Milk", "created_at": "2026-07-26T09:12:00Z" }</event>
<event as="failed">{ "message": "title is required" }</event>
<event as="progress">0.42</event>
```

One line, four properties instead of none:

| | |
|---|---|
| **Readable** | the shape is visible without opening the action |
| **Typed** | names AND types inferred from the example — no second type language to learn |
| **Executable** | it IS the fixture: preview and `<test>` compare against it |
| **Checkable** | lint can verify `dsx.event('saved', {…})` emits those keys — today it verifies nothing |

This matters most for the audience the framework is for. Someone writing
`on:saved="dsx.variable.lastId = dsx.this.id"` can SEE that `id` exists. And because the sample is
real data, a screen's handlers can be wired and previewed **before the backend exists** — you watch
it work against `note_7f3a` and know the wiring is right.

**The rule generalises: the contract and the fixture are the same text.** `<test input:title="Milk">` is
both the fixture and the preview seed. Two things that are one text cannot drift apart.

### Two prefixes, one noun, three verbs

| | |
|---|---|
| **`input:`** | data **in** — the only way to declare an action/formula parameter |
| **`on:`** | events **out**, handled at the CALL site |
| bare attributes | reserved for the LANGUAGE (`as`, `id`, and whatever is added later) |

`event` is always the noun; each verb keeps the word that fits its direction:

| Spelling | Role |
|---|---|
| `<event as="x"/>` | **declare** — "this action raises x" |
| `dsx.event('x', {…})` | **emit** — raise it now |
| `on:x="…"` | **handle** — at the call site |

**`on:` is deliberately NOT renamed to `event:`.** They are opposite ends of one contract, not two
names for one thing: `on:tap` reads as English and matches every framework a developer arrives
from (Svelte `on:click`, Vue `v-on:`, HTML `onclick`, Angular `(click)`). `event:tap="…"` would be
ambiguous — declaring or handling? A rename would spend a migration to make the language less
readable.

### Why `input:` and not bare attributes

Today `<action>` reserves exactly `as` and `id`; **every other attribute silently becomes an
input.** So the moment the language adds an attribute — `debounce`, `once`, `guard`, `timeout` — it
either breaks every action using that word as an input, or is silently swallowed and does nothing.
Neither is detectable. With `input:`, the namespaces cannot collide and the language stays
extensible.

### Inline tests

`<test>` maps 1:1 onto the shape `verify_module_tests.rb` already validates — **one vocabulary, one
gate, two syntaxes.** A second test semantics would be a liability, not a feature.

| XML | Existing JSON |
|---|---|
| `input:title="Milk"` | `args: { title: "Milk" }` |
| `given:x="…"` | `given: { … }` (precondition) |
| `expect:event="saved"` | `broadcasts` / `emits` |
| `expect:error="…"` | `expectError` |

One declaration, three consumers: the **CI gate**, the **canvas preview** (StackCanvas already runs
module-action tests as live simulations — `OpenSource/CanvasEditor`), and **documentation that
cannot rot** because it is executed.

**The first `<test>` is the preview seed** — tap the action in the canvas and it runs with those
inputs. No separate "default input" attribute to drift.

### `comment=` — intent, on every block

XML comments are **stripped by the parser**: `StackNode` carries `tag` / `attrs` / `children` /
`text` and nothing else, so a `<!-- … -->` reaches no catalog, no editor and no agent. It is
invisible to every reader that is not a human with the file open.

`comment=` survives as data — the markup twin of the `_note` convention manifests already use
**545 times** (288 in `dsx.json`, 257 in `config.json`). Same idea, same purpose, finally available
where screens are written:

```xml
<action as="save" input:title="dsx.this.title"
        comment="Optimistic: the row is added locally, then reconciled when `saved` lands.
                 Do NOT refresh the list here — the caller owns that.">
  <event as="saved">{ "id": "note_7f3a" }</event>
  …
</action>

<list bind="notes.data" key="id"
      comment="Server order is authoritative — do not sort here or paging breaks."/>
```

**Supported on every DSX block**, and it reaches the editor catalog and any agent reading the
parsed model. Use it for the WHY — a constraint, a gotcha, a decision someone will otherwise
undo. Not for restating the code.

> Keep `<!-- … -->` for prose that is genuinely only for a human reading the file: a section
> banner, a licence header. Anything a tool or an agent should know goes in `comment=`.

### Events that carry a list, and events that fire repeatedly

Two different things, often confused, and they declare differently.

**A list INSIDE one event.** One representative element is enough — the sample declares SHAPE, and
the element type is inferred from the first entry:

```xml
<event as="loaded" comment="Fires once per page. `cursor` is null on the last page.">
  { "items": [ { "id": "n1", "title": "Milk" } ], "total": 42, "cursor": "eyJ…" }
</event>
```

Do NOT paste a realistic thirty-item response. The sample is a contract, not a fixture dump: one
element defines the element type, and a long sample makes the shape harder to see, not easier.

**An event that fires MANY TIMES** — that is a stream, and it is declared as one:

```xml
<action as="watchNotes" stream="true"
        comment="Fires `row` per change until stopped. Caller must call stop().">
  <event as="row">{ "id": "n1", "title": "Milk" }</event>
  <test name="emits a row per change" expect:event="row" expect:count="2"/>
</action>
```

### What a test asserts

**The sample declares shape. A test asserts shape, unless you write exact values.**

```xml
<test name="loads a page"  expect:event="loaded"/>                        <!-- shape only -->
<test name="reports total" expect:event="loaded" expect:total="42"/>      <!-- exact value -->
<test name="emits twice"   expect:event="row"    expect:count="2"/>       <!-- occurrences -->
```

That default is deliberate: a test asserting every field of a realistic payload breaks on any
harmless change, so people delete it. Assert the shape always; assert a value only when that value
is the point of the test.

### Migration

| | |
|---|---|
| Scope | **4 parameterized actions + 3 formulas** — seven sites in the whole repository |
| Transition | accept bare inputs with a lint **warning** for one release, then error — nothing breaks silently |
| Parity | three runners, fixtures first, per the unified-codebase law |

## Five kinds of name, and how each is spelled

The single most common beginner error is writing a variable the wrong way. **Reads are bare;
writes are always `dsx.variable.`** — the repository votes 767 to 9 for the explicit form, and the
reason is not style: a bare `x = e` DOES write the store on native, but a `let x` shadows it, which
is precisely the non-portable loop bug the monorepo working rules document. The explicit spelling is unambiguous
on all three runners.

| Kind | Declared | Read | Write |
|---|---|---|---|
| **variable** — screen state | `<variable as="draft">` | bare — `{{ draft }}`, `bind="draft"`, `visible-if="draft != ''"` | **`dsx.variable.draft = …`** |
| **const** — app config | `App.json → consts` | `{{ dsx.const.api_url }}` | never — read-only |
| **input** — action/formula parameter | `<action as="x" title="…">` | bare `title` inside the body | never — it is a local |
| **event payload** | `<event as="saved" payload="id"/>` | `dsx.this.id` in the handler | never — inbound only |
| **formula** — derived value | `<formula as="total" qty="…">` | bare `{{ total }}` | never — computed |

## `<action>` and `<formula>` are the same mechanism

Both compile to `StackFormula(inputs:body:)`: `as` is the name, **every other attribute is an
input** bound in the caller's scope. One parameterization model, two intents:

```xml
<formula as="total"  qty="item.qty" price="item.price">  return qty * price      </formula>
<action  as="save"   title="dsx.this.title">             …effects, then events…  </action>
```

- **formula** — pure, reactive, produces a value.
- **action** — effectful, procedural, reports via events.

So "declare your inputs" is ONE rule covering both. It matters even more for a formula: a formula
that reads ambient state instead of taking it as a parameter **loses its reactivity**, because
nothing declared the dependency — it will not recompute when that state changes.

## Expected outcomes are events; faults are `throw`

`throw` is the one thing that crosses the boundary by design — into the caller's `try`/`catch`, the
error ledger (`dsx.errors`), `module.callFailed`, and the page mirror.

| Situation | Channel |
|---|---|
| An expected outcome — validation failed, nothing found, user cancelled | **event** |
| A genuine fault — a bug, an impossible state, a broken invariant | **`throw`** |

Do not `throw` because the user typed nothing: that is an ordinary outcome and the caller wants to
handle it inline. Do not swallow a real fault into an event: that is how a bug becomes invisible
to the ledger that exists to catch it.

## Rules of thumb

- **If you typed `dsx.variable.` inside an action for a value the caller already had — stop.**
  That is a missing parameter.
- **If an action ends by assigning screen state — stop.** That is a missing event.
- **Name events for what HAPPENED, not what should follow.** `saved`, not `clearTheField`. The
  action reports; the caller decides.
- **Local scratch state inside an action is fine.** The rule is about the action's *boundary*, not
  its internals.
- **`throw` is the exception** — it is the one thing that crosses the boundary by design, into the
  caller's `try`/`catch` and the error ledger.

## Gates

- `lint_dsx.rb --strict` — every `dsx.event('x')` must have a matching `<event as="x"/>`
- `verify_module_tests.rb` — every module action's declared `args`/`resolves` validated against its
  fixtures; **in the CI chain**, so a broken contract fails the build

## See also

- `OpenSource/Skills/cross-module-calls.md` — the three call shapes
- `OpenSource/Documentation/reference/dsx-anatomy.md` — head = contract + state + logic
- `OpenSource/Documentation/architecture/proposals/networking.md` — the same split applied to the
  network layer (request vs stream)
