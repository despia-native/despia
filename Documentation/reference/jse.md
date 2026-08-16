# JSE — the expression & logic engine powering DSX

**JSE (JavaScript Expressions)** is the small, fast expression-and-logic engine at the
heart of DSX. It evaluates every `{{ … }}`, every `visible-if`, and every `on:*` /
`<action>` body. It reads 1:1 like JavaScript — because it *is* JavaScript expression
syntax — but it is **evaluated by the platform**, not run on a JS VM.

> **DSX = XML markup + JSE + JSON.**
> The markup is the tree, JSON is inline data, and **JSE is the logic**.

## Why "Expressions", not "JavaScript"

JSE is the *expression language* of JavaScript plus a tight set of statement forms —
deliberately **not** a full runtime. That boundary is the whole point:

- **Declarative & safe** — a known grammar, never arbitrary code.
- **Reactive** — every read re-evaluates against state, so the UI tracks data for free.
- **Portable** — JSE is a defined grammar each renderer evaluates *natively* (iOS today,
  Jetpack Compose on Android), so the **same `.dsx` runs cross-platform**. Embedding a real
  JS engine wouldn't port — JSE does.

## The grammar

### Expressions (the core — used everywhere)
In `{{ … }}`, `visible-if`, and any value attribute:
- literals · `+ - * / %` · comparisons · `&& || !` · ternary `a ? b : c` · `typeof x`
  (`'number'`/`'string'`/`'boolean'`/`'object'`/`'function'`/`'undefined'` — null and a
  missing path both report `'undefined'`; JSE doesn't split them)
- comparisons are JS: string × string compares **lexicographically** (`'a' < 'b'`), a mixed
  pair numerically (`'5' < 10`); `==`/`===` on plain dicts/arrays is **structural** (deep,
  key-order-insensitive — `{ a: 1 } == { a: 1 }`), while Date/URL-style value objects keep
  their coerced-string equality (`u == 'https://…'`)
- member / index access: `user.email`, `items.0.name`
- object & array literals: `{ id: item.id, n: 3 }`, `[1, 2, 3]`
- function calls — built-ins (`mmss(t)`, `max(a, b)`, `floor(x)`, `len(arr)`, `range(1, 8)`
  = the bounded repeat-N ladder, `has('scheme')` = is that module in this build,
  `contains(arr, x)` / `set.has(k)` for membership, …) and the namespaces below
- arrow functions as callbacks: `items.map(x => x.price)`, `setTimeout(() => { … }, 800)` —
  real closures: an arrow **snapshots its creation scope** (row `item`, enclosing params,
  block locals), so nested arrows compose (`xs.map(x => ys.map(y => x + y))`)

### Statements (action bodies — `on:*` / `<action>`)
Separated by `;` / newlines:
- assignment: `x = e` · `user.email = e` · `item.done = true` · `x += e` · `i++`
- `if (cond) { … } else { … }`
- **loops** (budgeted — see below): `for (const x of arr) { … }` · `for (let i = 0; i < n; i++) { … }`
  · `while (cond) { … }`, with `break` / `continue`
- `switch (x) { case a: … break; default: … }` (JS fallthrough semantics)
- `try { … } catch (e) { … } finally { … }` + `throw e` · `return`
- `const` / `let` locals
- array mutation: `arr.push(x)` · `arr.pop()` · `arr.splice(i, 1)`
- `await fetch(url, { method, body, headers })` → `{ data, error, status, ok }`
- `const env = await fetch: dest = METHOD url [body=…] [headers=…]` — await the **reactive
  `fetch:` effect** inline: it writes its `{ loading, error, data }` envelope to `dest.*` (a bound
  spinner still works) AND suspends until it settles, binding the settled envelope to the `const`,
  then the body continues — so `if (env.error)` / `env.data` read sequentially over the effect. The
  `:` after `fetch` selects this form; `await fetch(…)` (parens) is the standalone JS API above.
- **`await dsx.module.scheme.method({ … })`** → `{ ok: true, data }` | `{ ok: false, error }` —
  a module call you can wait on (prices, queries, anything that resolves); `dsx.module.self.…`
  works; an uninstalled module returns `{ ok: false, error: "unavailable" }`
- timers: `setTimeout(() => { … }, ms[, key])` (keyed = debounce) ·
  `setInterval(() => { … }, ms[, key])` (repeating — polling/tickers; min 250 ms, dies with the
  surface) · `clearTimeout(key)` / `clearInterval(key)`
- **`await crypto.subtle.<method>(…)`** — the **Web Crypto API, 1:1** (see below); runs off
  the main thread, the rest of the body is the continuation (the fetch contract)
- **`await Promise.all([ fetch(a), fetch(b), dsx.module.x.y({…}) ])`** — the JS combinators
  (`all` / `race` / `any` / `allSettled`): the async elements run **concurrently**; `all`
  binds results in order, `race`/`any` the first to settle, `allSettled` wraps each as
  `{ status: 'fulfilled', value }` (JSE async ops report errors AS values — nothing rejects)
- **`const ws = new WebSocket(url[, { key }])`** — core networking, like fetch: KEYED
  (same key replaces — no double-connects; default key = url) + SURFACE-SCOPED (all
  sockets close when the surface's store deallocates — the timer contract). Handlers via
  `ws.onopen/onmessage/onerror/onclose = e => { … }`; `ws.send(text | bytes)` /
  `ws.close([code, reason])` statements. Binary frames = byte arrays. No background
  guarantee — long-lived realtime (reconnect/presence) is a module.
- calls: `dsx.event(…)` · `dsx.action.x(…)` · `dsx.module.s.m({ … })`

**Loops are budgeted, so JSE stays total.** Every iteration in an action draws on one shared
budget (100 000 per entry event); past it the loop aborts with a log instead of hanging the
main thread — remote DSX can never freeze the app. In `{{ }}` formulas (the reactive hot
path), keep iterating with `map`/`filter`/`reduce` — loops are action-body statements.

**`try/catch` is universal feature-detection.** Inside a `try`, calling a **module that
isn't installed / was never imported** — or an **action that doesn't exist** — throws
`{ code: "unavailable", call }`, so `catch (e)` runs the fallback. Outside a `try` it stays a
silent no-op (a missing *optional* module must never crash a surface). Both routes (a
`dsx.module.x.y(…)` call and a bare `name()` that matched no `<action>`) flow through the same
dispatch, so one guard covers them:

```js
try {
  dsx.module.biometric.authenticate({ reason: 'Unlock' })   // module may not be in this build
} catch (e) {
  dsx.variable.usePasscode = true                            // e.code == 'unavailable'
}
```

**Multiline is first-class.** Write statements like handwritten JS — blocks across lines,
`else` on its own line, a `for` body over many lines, multi-line object/array literals and
call arguments. A newline ends a statement (ASI) unless the line is clearly unfinished
(`x = a +`) or the next line can only continue it — a `.method()` chain, a formatted
ternary's `?` / `:`, `&&` / `||`:

```js
const r = await fetch(url, {
  method: 'POST',
  body: { id: item.id }
})
if (r.error) {
  dsx.event('fail', { reason: r.error })   // comments work too
  return
}
const names = r.data.items
  .filter(x => x.active)
  .map(x => x.name)
```

Comments are JS: `// to end of line` and `/* … */`. (A bare `https://…` URL in a verb is
never a comment — `//` directly after `:` is protocol syntax.)

### Web Crypto — `crypto.subtle`, 1:1, no JS engine

The standard [Web Crypto API](https://developer.mozilla.org/docs/Web/API/SubtleCrypto),
verbatim syntax, mapped straight to **CryptoKit / CommonCrypto / SecKey** (Android:
`javax.crypto` / `java.security`). Bytes travel as plain JSE number arrays — an
ArrayBuffer/Uint8Array is array-like, so MDN snippets run unchanged. `new` and `await` are
keyword-transparent in expressions (`new X(…)` calls X; `await v` on a non-promise is `v`);
statement-level `await crypto.subtle.*` genuinely suspends **off the main thread** (PBKDF2
iterations, RSA keygen never jank a surface), then the body continues — the fetch contract.

```js
// the MDN digest example, character for character
const msgUint8 = new TextEncoder().encode(message)
const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8)
const hashArray = Array.from(new Uint8Array(hashBuffer))
const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

// AES-GCM round-trip
const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
const iv = crypto.getRandomValues(new Uint8Array(12))
const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, 'hello')
const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, sealed)

// HMAC-signed request (key from the server, raw)
const k = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
const sig = await crypto.subtle.sign('HMAC', k, body)
```

| Operation | Algorithms |
|---|---|
| `digest` | SHA-1 · SHA-256 · SHA-384 · SHA-512 |
| `encrypt` / `decrypt` | AES-GCM · AES-CBC · AES-CTR · RSA-OAEP |
| `sign` / `verify` | HMAC · ECDSA (P-256/384/521, raw r‖s) · Ed25519 · RSASSA-PKCS1-v1_5 · RSA-PSS |
| `deriveBits` / `deriveKey` | PBKDF2 · HKDF · ECDH · X25519 |
| `generateKey` | AES-* · HMAC · EC · Ed25519/X25519 · RSA-* |
| `importKey` / `exportKey` | `raw` · `spki` · `pkcs8` · `jwk` |
| `wrapKey` / `unwrapKey` | any encrypt alg + AES-KW |
| `crypto.getRandomValues(…)` · `crypto.randomUUID()` | sync (SecRandomCopyBytes / UUID) |

**CryptoKeys** are CryptoKey-shaped dicts (`{ type, extractable, algorithm, usages }`)
carrying their material in internal fields — value semantics, no handle registry, and
`exportKey` honors `extractable`. **Companion globals** ship for the idioms:
`Uint8Array(n)` / `Uint8Array.fromHex/fromBase64` · `bytes.toHex()` / `.toBase64()` ·
`TextEncoder`/`TextDecoder` · `Array.from` · `btoa`/`atob` — plus `n.toString(16)` and
`s.padStart/padEnd` as general JS methods.

**Documented limits** (native constraints, logged + null instead of throwing): AES-GCM
`tagLength` is 128; RSA `publicExponent` is 65537; RSA-PSS `saltLength` must equal the hash
length (SecKey); RSA-OAEP labels unsupported; getRandomValues caps at 65536 bytes (the spec's
quota). Everything stays **total** — an unsupported algorithm/key logs `[JSE crypto]` and
yields null, never a crash.

### The JS core globals — computational completeness, no browser

The boring, universal web/JS primitives for **app logic** — verbatim syntax, mapped to
Foundation (no JS engine). The rule: **core makes app logic portable; modules make device
capabilities possible** — so URL math, dates, formatting, JSON, multipart bodies, and async
orchestration are core; camera/auth/payments/location stay modules. See
`Skills/js-core.md` for the full guide + recipes.

| Global | Surface |
|---|---|
| `URL` / `URLSearchParams` | `new URL('/checkout?plan=pro', base)` · `url.pathname` / `.origin` / `.search` / `.hash` · `url.searchParams.get/set/append/delete/has/getAll/toString` (mutations resync `href`/`search`) |
| fetch companions | `new Headers({…})` · `new Request(url, opts)` · `fetch(request)` — and the result is Response-shaped: `res.ok` / `.status` / `.statusText` / `.headers.get(…)` / `await res.json()` / `await res.text()` |
| `Blob` / `File` / `FormData` | `new FormData()` + `form.append('avatar', file)` → fetch body becomes **multipart/form-data**; a `Blob`/string body works too; `URLSearchParams` body → form-encoded |
| `Date` | `Date.now()` · `new Date(iso).getTime()` · `.toISOString()` · `.getFullYear/Month/Date/Day/Hours/Minutes/Seconds()` · `.toLocaleDateString()` — Dates coerce to their ms in math/sort (`b - a`) and to ISO in strings/JSON |
| `Intl` | `new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(9.99)` · `Intl.DateTimeFormat` (dateStyle/timeStyle or component options) · `Intl.RelativeTimeFormat` ("yesterday") |
| `JSON` + URI | `JSON.stringify` / `JSON.parse` · `encodeURIComponent` / `decodeURIComponent` / `encodeURI` / `decodeURI` |
| `Math` + numbers | `Math.floor/ceil/round/abs/min/max/pow/sqrt/random/…` · `Math.PI` · `parseInt` / `parseFloat` / `isNaN` / `Number` / `String` / `Boolean` |
| Arrays, completed | `map/filter/reduce/find/some/every/forEach/includes/indexOf/join/reverse` were in; now also **`sort`** (comparator; statement form mutates, expression returns a copy), `flatMap`, `flat`, `concat`, `findIndex`, `at(-1)`, full JS **`slice(start, end)`** (negatives count from the end; strings too), string `indexOf` / `startsWith` / `endsWith`, **`Object.groupBy(coll, fn)`** (ES2024) and **`Array.from({ length: n }, (_, i) => …)`** (the JS repeat-N idiom; array source + mapFn too). keyBy is `Object.fromEntries(xs.map(x => [x.k, x]))`, descending sort is `sort((a, b) => b - a)` — 1:1 JS. Prefix conveniences `groupBy`/`keyBy`/`range(a, b)`/`sortBy(coll, fn, 'desc')` are aliases in the `len`/`upper` family, never required |
| **RegExp** | literals `/^[a-z]+$/i` (standard prefix-position lexing — `/` after a value stays division) + `new RegExp(p, f)` → ICU (`NSRegularExpression`, cached). `re.test(s)` · `s.match(re)` · `s.replace(re\|str, '$1…')` / `replaceAll` · `s.split(re\|str[, limit])` · `s.search(re)`. Flags `i m s g` (`u` implicit — ICU is Unicode) |
| `structuredClone(x)` | deep copy for copy-then-update state flows |
| `Object.*` | `keys` / `values` / `entries` / `assign` / `fromEntries` (value semantics: `x = Object.assign({}, x, y)`) |
| `Map` / `Set` | value objects — `m.get/set/has/delete`, `s.add/has/delete`, `.size`; mutations are statements (the push pattern) |
| `console.*` | `log/info/debug/warn/error` → NSLog `[DSX console]` + a 500-line ring buffer (`JSEConsole`) for the inspector |
| `performance.now()` · `new Error(msg)` · `navigator.*` | monotonic ms · `{ name, message }` error values (`'' + err` → "Error: …") · read-only `language/languages/platform/onLine` |
| `AbortController` | `const c = new AbortController()` → `fetch(url, { signal: c.signal })` → `c.abort()` (the settle is discarded; `{ ok:false, error:'aborted' }` lands) |
| `Promise.all/race/any/allSettled` | statement-level `await` — concurrent fetch/dsx.module/crypto elements (see Statements) |

Value semantics throughout: these objects are dicts with internal `__` marker fields, so they
live in `dsx.variable.*`, serialize, and cross surfaces. **Mutating methods are statements**
(`url.searchParams.set('ref', 'push')` / `form.append(…)` / `headers.set(…)` / `c.abort()`) —
the runner reads, mutates, writes back, like `arr.push(x)`; in `{{ }}` expression position the
same calls return the modified copy. Timers (`setTimeout` / `setInterval` / `clear*`, keyed)
were already first-class. Not included on purpose: `localStorage` (state is `dsx.variable` /
`dsx.global` / the storage modules), `EventTarget` (events are `dsx.event` / `ui.on` /
`dsx.broadcast`), streams.

### Not in JSE (on purpose)
No **classes** — state is plain serializable data in the reactive store (it crosses the
native/web bridge and both renderers); components are the unit of composition. No
**imports** — modules and auto-registered components *are* the module system
(`dsx.module.*`, `<Tag/>`). No **`function` declarations in bodies** — DSX's functions are
**`<action as="x">`** (callable statements, `dsx.action.x(…)`) and **`<formula as="x">`**
(parameterized reactive computation), declared in XML; arrow functions stay available as
callbacks.

## The `$` namespaces — JSE's reserved words

`$` marks a platform namespace; these belong to JSE, so author state never collides:

| Namespace | Meaning |
|---|---|
| `dsx.this` | the current scope / row (an event payload becomes `dsx.this` in its handler) |
| `dsx.event(name, payload?)` | send an event **up** — to a consumer's `on:name`, a native `ui.on` host, or a subscriber |
| `dsx.action.name(args?)` | call a named `<action>` |
| `dsx.module.scheme.method({ … })` | call a native module |
| `dsx.module.self.method({ … })` | call **the module this component lives in** — no hard-coded scheme, so it can't go stale on a rename (resolves to the component's owning module) |
| `dsx.route` · `dsx.query` · `dsx.params` · `dsx.path` | the route |
| `dsx.screen` · `$element` | responsive metrics (media / container queries) |
| `dsx.variable` · `dsx.global` · `dsx.item` | state |
| `dsx.cookie.name` · `dsx.cookie` | the cookie jar — read one value or the whole `{ name: value }`, or **write** with `dsx.cookie.name = "…"` (set across web ↔ native ↔ DSX, reactive) |
| `dsx.attribute.name` | a component's **attributes** — like a web component's HTML attributes (set from native with `ui.attribute`) |

Bare forms remain valid shorthand (`name()` ≈ `dsx.action.name()`, `haptic.x()` ≈
`dsx.module.haptic.x()`), but the explicit `$` form reads unambiguously — action vs module
vs state at a glance.

**Variables are accessed with `dsx.variable.` — that's the rule**, parallel to `dsx.action.` /
`dsx.module.` for calls and `dsx.route` / `dsx.screen` for the other scopes. `dsx.variable.showRecs`,
`dsx.variable.count`: explicit and unambiguous — a surface variable, never mistaken for a prop or
a row field. Every scope is likewise explicit: attributes `dsx.attribute.name` (a component's inputs —
the ES6-web-component / HTML-attribute model), list rows `dsx.this.x` (or
`item.x`), route `dsx.route.x`, app store `dsx.global.x`. (A bare name still resolves to state for
back-compat, but write new DSX with `dsx.variable.` — there is no `$var` shorthand.)

**`dsx.*` is not JSE.** It's the **native** API (Swift / Kotlin): `dsx.event` / `dsx.send`
/ `dsx.events.on` / `dsx.action`. Author markup uses `dsx.event`; `dsx.*` is for module code.

## Where JSE runs

- **`{{ JSE }}`** — interpolation & conditions, re-evaluated **reactively** on every state change.
- **Action bodies** — `on:tap="…"`, `<action as="…">…</action>`, and the lifecycle hooks.

## Reactivity — derive, react, declare

Three reactive primitives, in order of preference. **Reach for the purest one that fits.**

**`<variable as="x" computed="true">expr</variable>` — DERIVE.** A read-only formula re-evaluated
on every read, in the **current scope** (so a formula over `dsx.item.*` derives per row). This is the
default for *"y is a function of x"*. It **cannot loop** (it never writes), so prefer it over a watch
whenever you're computing a value:

```xml
<variable as="locked" computed="true">dsx.item.locked &amp;&amp; !dsx.variable.premium &amp;&amp; !dsx.variable.unlocked.includes(dsx.item.id)</variable>
```
*(Inside a `<variable>` body — a code element — write raw `&&` / `<`; they're read 1:1. In an
attribute, escape them: `&amp;&amp;`.)*

**`<watch value="expr" on:change="…" immediate="true?"/>` — REACT (side effects).** Runs `on:change`
when `value` settles to a **new** value, evaluated in its scope — so a `<watch>` in a list row
observes that row's own `dsx.this`/`dsx.item` (one observer per row); a screen-level one observes
`dsx.variable`/`dsx.global`. In the handler, **`dsx.this` = the new value** (`dsx.this.key.key` for an object/row;
`dsx.this.value` for a scalar/array). `immediate="true"` also fires once on mount. Use it for **fetch,
navigation, analytics, an imperative write to *other* state** — not for deriving:

```xml
<watch value="dsx.variable.query" on:change="fetch: dsx.variable.results = GET /search?q={{ dsx.this }}"/>
```

**`<attribute as="x" default="[]" on:change="…"/>` — DECLARE a component prop.** Names a prop, gives
its default (used when the consumer omits it — `dsx.attribute.x` falls back to it), and optionally watches
it. Self-documenting; sugar for "a defaulted, optionally-watched `dsx.attribute.x`".

**The one rule — never let a watch write its own dependency.** A `<watch>` that rewrites what it
observes is a cycle. Equality dedup kills the trivial/converging cases; a per-runloop **budget
backstop aborts a runaway and logs it** (never hangs) — but the *fix* is to make derivations
`computed` (which can't loop) and keep watches for genuine side effects. A per-row watch should write
**row** state (`dsx.this.*`), not the shared `dsx.variable.x` it observes.

## Under the hood

On iOS the expression evaluator is the `JSE` type and the statement runner is `JSERunner` —
together they **are** JSE. Each renderer ships its own JSE evaluator over the *same* grammar,
which is exactly why the contract is "same `.dsx`, native evaluation per platform."

## Legacy (removed)

The old `verb:` action **aliases** — `set:` `emit:` `send:` `do:` `call:` `event:`
`broadcast:` `push:` `unshift:` `insert:` `pop:` `shift:` `clear:` `splice:` — predated JSE
and duplicated it. They have been **removed from the engine** — they no longer parse. Write JSE:

| removed verb | JSE |
|---|---|
| `set: x = e` | `x = e` |
| `emit: x` · `send: x` | `dsx.event('x')` |
| `do: name` | `dsx.action.name()` |
| `call: pkg.m a=b` | `dsx.module.pkg.m({ a: b })` |
| `push: arr = x` | `arr.push(x)` (also `.pop()` / `.shift()` / `.unshift()` / `.splice()`) |

The only `verb:` forms that **remain** are the *effect primitives with no JSE-expression
form* (not legacy): **`fetch:`** (the reactive `{loading, error, data}` spinner envelope —
`await fetch(…)` is the sequential JSE form), **`remove: … where`** (filter-delete),
**`animate:`**, and **`resolve:` / `error:`** (resolve / error the originating call).

Also removed from the markup layer (see [`dsx-anatomy.md`](./dsx-anatomy.md)): the bare
`name=` declaration identifier (the identifier is `as=`; on `formula`/`action`, `name` is an
ordinary input), the `prop` spelling of `attribute`, the `native` tag alias
(`<native name="x"/>` — write `<x/>`), and the `.xml` file-extension alias for remote DSX.
