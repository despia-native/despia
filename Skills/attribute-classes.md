# Attribute classes — one classification for every DSX block

**Foundational grammar law.** Every attribute in DSX markup belongs to exactly one class, and the
class is visible in the spelling. A reader — human, agent, linter, or visual editor — can tell what
an attribute IS without knowing a reserved list.

> **Agents first. The visual editor second. Humans third.**
> Markup a machine can classify completely is markup a human reads at a glance. The reverse is not
> true, which is why the ordering is not an insult to humans.

## The problem this fixes

Today `<action>`/`<formula>` treat **every attribute except a reserved few** as an author-declared
input. That has three consequences, all verified in this repository:

1. **You cannot read it.** In `<action as="openLaneMenu" track="…" at="…">`, nothing distinguishes
   `as` (a language keyword) from `at` (a word the author invented). The framework's own author
   could not tell them apart when reading it back.
2. **The language cannot grow.** Adding any attribute — `once`, `guard`, `timeout`, `debounce` —
   either breaks every action that used that word as an input, or is silently swallowed as one and
   does nothing. Neither is detectable.
3. **THE RENDERERS ALREADY DISAGREE.** The reserved lists were maintained three times and drifted:

   | Renderer | Reserves | Source |
   |---|---|---|
   | Swift | `as`, `id` | `Stack.swift` ×4 sites |
   | Kotlin | `as`, `id` | `StackNodeView.kt` ×2 sites |
   | **TS** | **`as`, `computed`, `value`** | `component.ts:109` |

   So `<formula as="x" value="v">` declares an input named `value` on iOS and Android, and **no
   input at all** on web. Same markup, different behaviour, no error anywhere. `on:tap="…"` on an
   `<action>` becomes an *input* on every platform, because nothing strips handler attributes
   either.

A shared reserved list maintained in three languages does not stay shared. A prefix needs no list.

## The classification

| Class | Spelling | Meaning | Who owns the name |
|---|---|---|---|
| **language** | bare — `as` `id` `url` `method` `style` `visible-if` | the framework's own vocabulary | **DSX** |
| **input** | `input:name` | a value the author declares and the caller supplies | **the author** |
| **handler** | `on:event` | what to run when an event arrives | DSX names the event, author names the code |
| **type hint** | `type:field` | an explicit type where a sample is ambiguous | the author |
| **test input** | `input:` on `<test>` | the case's arguments | the author |
| **test precondition** | `given:path` | state seeded before the case | the author |
| **test assertion** | `expect:key` | what the case asserts | the author |
| **intent** | `comment` | why this exists — survives to tooling, unlike `<!-- -->` | the author |

**The rule in one line: bare attributes belong to DSX; prefixed attributes belong to you.**
The language can therefore add any bare attribute forever without touching a single app.

### `input:` means two different things, and the difference is the block

The left side is always the parameter NAME. The right side depends on where it is written:

| Written on | Right side is | Example |
|---|---|---|
| `<action>` `<formula>` `<api>` | an **EXPRESSION**, evaluated in the caller's scope | `input:tag="filterTag"` → the value of the variable `filterTag` |
| `<test>` | a **LITERAL fixture** — plain data for that case | `<test input:tag="all">` → the string `"all"` |

Verified in the kernel: `scope[k] = evalBlock(e, store:item:)` — a declaration's right side is
evaluated, never taken literally. So on a declaration:

```xml
input:tag="filterTag"      <!-- the variable filterTag        -->
input:tag="dsx.this.tag"   <!-- the event payload's tag field -->
input:tag="'all'"          <!-- the literal string "all" — QUOTES REQUIRED -->
```

A bare word on a declaration is a **variable read**. `input:title="Milk"` does not pass the string
"Milk"; it reads an undefined variable called `Milk` and passes null.

Test fixtures are literal on purpose: a `<test>` is data, and demanding `input:title="'Milk'"` in
every case would be hostile — it also matches the JSON tests that already ship, where
`"args": { "amount": 30 }` are plain values. **A declaration binds; a test supplies.**

## Children declare the interface

Attributes carry values; **children carry contracts**. Nested, so nothing can be orphaned or
pointed at the wrong parent.

| Child | Declares | Valid in |
|---|---|---|
| `<event as="x">{sample}</event>` | an event this block raises, with a real sample payload | `<action>`, components |
| `<response status="200">{sample}</response>` | what a call returns for that status | `<api>` |
| `<test name="…">` | an executable case | `<action>`, `<formula>`, `<api>` |

## Applied per block

### `<action>` — effects, reports via events

```xml
<action as="save" input:title="dsx.this.title"
        comment="Optimistic; the caller owns refreshing the list.">
  <event as="saved">{ "id": "note_7f3a" }</event>
  <event as="failed">{ "message": "title is required" }</event>
  <test name="saves"         input:title="Milk" expect:event="saved"/>
  <test name="rejects empty" input:title=""     expect:event="failed"/>

  …body…
</action>
```

### `<formula>` — pure, reactive, returns a value

Same input machinery (both compile to `StackFormula(inputs:body:)`), different intent — so it
declares a **result sample** rather than events:

```xml
<formula as="lineTotal" input:qty="item.qty" input:price="item.price"
         comment="Rounds half-up at 2dp — the invoice total must match the server's.">
  <result>12.50</result>
  <test name="multiplies" input:qty="2" input:price="6.25" expect:result="12.50"/>
  return round(qty * price, 2)
</formula>
```

A formula that reads ambient state instead of declaring it **silently loses its reactivity** —
nothing declared the dependency, so nothing recomputes. Inputs matter more here, not less.

### `<api>` — a request, with a sample per status

An `<api>` needs no events (it is a request, not a stream), but it does need **the shape of each
outcome**. This is OpenAPI's responses-by-status, inline where the screen is written:

```xml
<api as="notes" url="{{ dsx.const.api_url }}/notes" input:tag="filterTag"
     comment="Server order is authoritative — do not re-sort or paging breaks.">
  <response status="200">{ "items": [ { "id": "n1", "title": "Milk" } ], "cursor": null }</response>
  <response status="400">{ "message": "unknown tag" }</response>
  <response status="404">{ "message": "not found" }</response>

  <test name="lists notes" input:tag="all" expect:status="200"/>
</api>
```

What that buys, none of which exists today:

- **`notes.data` has a known shape** — the editor offers `item.id`/`item.title` as bindings, an
  agent knows what it may reference.
- **`notes.error` has a known shape** per status, so error UI can be built and previewed.
- **The screen runs before the backend does** — the 200 sample is the mock.
- **Lint can check** that a handler references fields the declared responses actually contain.

A **stream** stays a stream: `stream="true"` plus `<event>` children, because chunks arrive over
time and a status sample cannot describe them.

## Value rules — where a value comes from must be unambiguous

Three questions about the same thing: *what does this expression evaluate to, and can I tell by
reading it?* One is already fine; two are silent-failure hazards.

### 1 · An input may already contain full logic — no change needed

`evalBlock` has two modes and picks automatically: a plain single expression takes a fast path;
anything containing `;`, a newline, `{`, or a leading `return`/`const`/`let`/`if`/`function` runs as
a block. So this works **today**:

```xml
<api as="notes" url="…"
     input:tag="if (dsx.variable.showAll) { return 'all' } return dsx.variable.filterTag">
```

An input is a full JSE body, not a variable slot. That should be documented, not changed.

### 2 · A bare name is ambiguous — `formula()` must be explicit *(hazard)*

Resolution today, from the kernel:

```swift
if store.vars[first] == nil, let f = store.formulas[first] { …run the formula… }
```

**A formula resolves ONLY when no variable of that name exists.** So `filterTag` means "the
variable, or if there isn't one, the formula" — and the day someone adds
`<variable as="filterTag">`, every reference silently stops calling the formula and starts reading
the variable. No error, no warning, different values.

**Proposed:** a formula is invoked with parentheses, like every language a developer arrives from.

```xml
input:tag="filterTag()"     <!-- the FORMULA — unambiguous            -->
input:tag="filterTag"       <!-- the VARIABLE — unambiguous           -->
```

A bare name is then always a value read, a `name()` is always a call, and a variable can never
shadow a formula by accident. Legacy bare-formula references warn for one release, then error.

### 3 · `return` must be explicit *(hazard)*

`exprStatement` assigns the block's result on **every bare expression statement**, not only the
last:

```swift
result = evalExpr(toks)     // in exprStatement — runs for ANY bare expression
```

So a stray expression anywhere in a body silently becomes the value:

```xml
<formula as="total" input:qty="…" input:price="…">
  const net = qty * price
  net * 0.2            <!-- meant as a scratch line — SILENTLY becomes the result -->
  return net
</formula>
```

Here the author's `return net` does win (it executes last), but reorder the lines, wrap one in an
`if` that does not run, or leave a debug expression behind, and the value changes with no
diagnostic. JavaScript does not behave this way — a function with no `return` yields `undefined`,
loudly and predictably. **JSE looking like JS while returning a different value is the worst
possible combination**, because the reader's instinct is wrong and nothing says so.

**Proposed:** a `<formula>`/`<action>`/`input:` body that is a BLOCK must end its value path with
an explicit `return`. A block with no reachable `return` is a **lint error**, not a silent null.
The single-expression fast path is unaffected — `input:qty="item.qty"` needs no `return`, because
there is nowhere for ambiguity to hide.

This is the same principle as the rest of this document, applied to values instead of attributes:
**the reader should never have to simulate the evaluator to know what a line produces.**

## What is NOT changing

- `on:` stays `on:`. It is the *handler* end of an event, not a second name for `<event>`; it reads
  as English and matches Svelte / Vue / HTML / Angular. One noun (`event`), three verbs: `<event>`
  declares, `dsx.event()` emits, `on:` handles.
- `<!-- … -->` stays for prose only a human reading the file needs. Anything a tool should know is
  `comment=`, because XML comments are stripped by the parser and reach nothing.

## Migration

| | |
|---|---|
| **Scope in this repo** | 4 parameterized actions + 3 formulas — **7 sites** |
| **Transition** | bare inputs keep working, with a `lint_dsx` **warning**, for one release; then error |
| **Precedence** | if any `input:` is present on a block, ONLY prefixed attributes are inputs — no silent mixing |
| **Parity** | one shared helper per kernel, replacing the three drifted lists; corpus rows first, three runners |

## Gates

- `lint_dsx --strict` — warns on legacy bare inputs; errors on an `on:`/`type:`/unknown prefix used
  where it is not valid; checks `dsx.event('x')` against `<event>` declarations
- `verify_module_tests.rb` — declared contracts vs their fixtures, already in the CI chain
- **A parity corpus row** asserting all three renderers extract the SAME input set from the same
  markup — the check whose absence let the lists drift
