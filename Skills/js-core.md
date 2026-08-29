# The JS core globals in JSE: app logic, 1:1, no browser

> JSE ships the boring, universal Web/JS primitives that make DSX **computationally
> complete for app logic** — URL math, dates, localization, JSON, uploads, async
> orchestration — with verbatim JS syntax and Foundation underneath. No JS engine.
>
> **The rule: core makes app logic portable; modules make device capabilities possible.**
> Auth, payments, push, camera, location, clipboard, keychain — those stay modules even
> when the web has an API for them. They're capabilities, not computation.

## URL / URLSearchParams

```js
const url = new URL('/checkout?plan=pro', dsx.variable.base)
const plan = url.searchParams.get('plan')        // 'pro'
url.searchParams.set('ref', 'push')              // statement → href/search resync
dsx.variable.next = url.href                        // 'https://…/checkout?plan=pro&ref=push'
```

Properties read like the web: `href` · `origin` · `protocol` · `host` / `hostname` / `port`
· `pathname` · `search` · `hash` · `searchParams`. Params: `get` / `getAll` / `has` / `set`
/ `append` / `delete` / `toString` (form-encoded, `+` for spaces). Standalone:
`new URLSearchParams('a=1&b=2')` or from an object.

## fetch, completed — Headers · Request · Response · FormData · Blob · AbortController

`await fetch` was already first-class; now the **surrounding objects** are too, so MDN/API
snippets run as written:

```js
const res = await fetch(dsx.variable.api + '/checkout', {
  method: 'POST',
  headers: new Headers({ authorization: 'Bearer ' + dsx.cookie.token }),
  body: JSON.stringify({ plan: 'pro' })
})
if (!res.ok) { dsx.event('fail', { status: res.status }); return }
const data = await res.json()
const ct = res.headers.get('content-type')
```

- **The result is Response-shaped**: `ok` · `status` · `statusText` · `headers` (lowercased,
  `.get(…)`) · `await res.json()` · `await res.text()` — plus the existing `data` / `error`
  fields, so `if (r.error)` keeps working. `json()` parses on 4xx too, like the web.
- **`new Request(url, opts)`** seeds a call: `await fetch(request)`.
- **Bodies**: a JSON object (as before) · a **string** (`JSON.stringify` output;
  `text/plain` unless you set a type) · a **`FormData`** → real `multipart/form-data` ·
  a **`Blob`/`File`** → raw bytes with its `type` · a **`URLSearchParams`** → form-encoded.

### Uploads

```js
const form = new FormData()
form.append('avatar', dsx.variable.photo)     // a File/Blob (e.g. from a module)
form.append('userId', dsx.variable.userId)
const r = await fetch(dsx.variable.api + '/upload', { method: 'POST', body: form })
```

`new Blob([parts], { type })` / `new File([parts], name, { type })` build from strings or
byte arrays. Modules hand files to DSX as the same shape (`{ __blob, type, name, size }`),
so camera/picker outputs plug straight into `FormData`.

### Cancellation

```js
const c = new AbortController()
const res = await fetch(dsx.variable.searchUrl, { signal: c.signal })
// elsewhere (a newer keystroke):
c.abort()    // the stale request settles { ok:false, error:'aborted' } — no stale writes
```

## Date

```js
const t = Date.now()                          // ms epoch
const d = new Date(dsx.variable.expiresAt)       // ISO string / ms / another Date
if (d.getTime() < Date.now()) { dsx.action.refreshToken() }
dsx.variable.label = d.toLocaleDateString()
dsx.variable.iso = new Date().toISOString()
```

Getters are local-time, JS semantics (`getMonth()` is 0-based; `getDay()` 0 = Sunday).
Dates **coerce to their ms** in math and sorting (`list.sortBy(x => new Date(x.at) - 0)`,
`b - a` diffs) and to ISO in strings and `JSON.stringify` (their `toJSON`). Invalid input →
a NaN date (`isNaN(d.getTime())` — the standard check).

## Intl — localization that maps to native formatters

```js
dsx.variable.price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(9.99)
dsx.variable.date  = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date())
dsx.variable.ago   = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day')   // "yesterday"
```

- **NumberFormat**: `style` decimal/currency/percent, `currency`, `minimumFractionDigits` /
  `maximumFractionDigits`, `useGrouping` → `NumberFormatter`.
- **DateTimeFormat**: `dateStyle`/`timeStyle` (full/long/medium/short) or component options
  (`year/month/day/hour/minute/second/weekday`) → a localized skeleton → `DateFormatter`.
- **RelativeTimeFormat**: units second…year; `numeric: 'auto'` gives "yesterday"/"tomorrow"
  → `RelativeDateTimeFormatter`. Empty locale = the device locale.

## JSON + encoding

```js
const body = JSON.stringify(dsx.variable.cart)          // Dates → ISO, URLs → href, no __internals
const obj  = JSON.parse(res.text)
const q    = encodeURIComponent(dsx.variable.query)     // also encodeURI / decode*
```

## Math, numbers, copies

```js
const page  = Math.floor(dsx.variable.index / 20)       // Math.* — incl. Math.PI, Math.random()
const n     = parseInt(dsx.variable.input)              // parseInt / parseFloat / isNaN
const price = Number(dsx.variable.raw) || 0             // Number / String / Boolean coercions

const next = structuredClone(dsx.variable.cart)         // copy-then-update state flows
next.push(item)
dsx.variable.cart = next
```

## Objects, Maps, Sets, arrays

```js
const ids = Object.keys(dsx.variable.byId)                  // also values / entries / fromEntries
dsx.variable.cfg = Object.assign({}, dsx.variable.cfg, patch)  // value semantics: assign returns the merge

const seen = new Set(dsx.variable.doneIds)
seen.add(id)                                             // statement → persists (like arr.push)
if (seen.has(id)) { return }

const byId = new Map()
byId.set(item.id, item)
dsx.variable.count = byId.size

list.sort((a, b) => a.price - b.price)                   // statement: sorts in place
list.sort((a, b) => b.points - a.points)                 // descending — the comparator you know
const top = list.flatMap(x => x.tags).flat().concat(extra).at(-1)

const sections = Object.groupBy(todos, t => t.tag)       // ES2024 → { work: [...], home: [...] }
const byId = Object.fromEntries(users.map(u => [u.id, u]))   // the JS lookup-table idiom
const dots = Array.from({ length: 5 }, (_, i) => i)      // the JS repeat-N idiom → [0,1,2,3,4]

const last4 = dsx.variable.phone.slice(-4)               // full JS slice: negatives, end index, strings too
const firstPage = feed.slice(0, 20)
if (email.endsWith('@gmail.com') || host.startsWith('api.')) { /* … */ }
const at = 'hello'.indexOf('ll')                         // 2 — strings, not just arrays

if (typeof res.data == 'object') { /* heterogeneous payloads branch safely */ }
if (Array.isArray(res.data)) { dsx.variable.rows = res.data }
```

`Map` keys compare by value (`JSE.equals`), `.size` is a live member, and — like every core
object — they're plain serializable dicts you can park in `dsx.variable.*`.

Three semantics worth naming (all corpus-pinned, identical on iOS/Android):

- **Arrows are closures** — a lambda snapshots its creation scope (row `item`, enclosing
  params, block locals), so `xs.map(x => ys.map(y => x + y))` composes. Value-semantic:
  it captures a *snapshot*, not a live reference.
- **`==`/`===` on plain dicts/arrays is structural** — deep, key-order-insensitive
  (`{ a: 1 } == { a: 1 }` is `true`). JSE has value semantics, so JS's always-false
  reference equality would be meaningless; Date/URL-style value objects keep their
  coerced-string equality (`u == 'https://…'`).
- **`typeof null` is `'undefined'`** — JSE doesn't split null from undefined (both are one
  missing value), so both report `'undefined'` instead of JS's `typeof null == 'object'` wart.

## RegExp — validation, parsing, cleanup

```js
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dsx.variable.email)) { dsx.variable.error = 'Invalid email'; return }
dsx.variable.slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const parts = csv.split(/\s*,\s*/)
const m = dsx.variable.path.match(/^\/show\/(\d+)$/)         // [full, '42'] | null
if (m) { dsx.variable.showId = m[1] }
```

Literals use the standard JS lexer rule (`/` in prefix position starts a regex; after a
value it's division) and `new RegExp(pattern, flags)` builds the same value. ICU underneath
(`NSRegularExpression`, compiled patterns cached) — flags `i` / `m` / `s` map directly, `g`
drives match-all/replace-all, `u` is implicit. `$1` templates in `replace` are ICU-native.
String-argument `replace`/`split` are literal, like JS (`replace` = first occurrence,
`replaceAll` = every). Edges: spell `/` as `\/` inside a literal (JS requires it anyway).

## Logging + diagnostics

```js
console.log('checkout', { plan: plan, total: total })    // also info / debug / warn / error
const t0 = performance.now()
// …
console.warn('slow path', performance.now() - t0, 'ms')
```

`console.*` lands in NSLog (`[DSX console] …` — Console.app / Xcode) **and** a 500-line ring
buffer (`JSEConsole.shared.lines`). Objects pretty-print as JSON, and credential-looking keys
redact to `•••` (see `security.md`).

**The inspector is live**: `JSETrace` records capped ring buffers per category — **actions**
(name + duration), **state writes** (key, old → new, redacted + truncated), **fetches**
(method, URL with masked query secrets, status, ms), **module calls** (callee, outcome, ms),
**socket events**. ON in DEBUG builds, OFF in release (a single bool check per site).
Read it natively — `JSETrace.shared.dump()` in a DEBUG build (the `window.despia.statelab.*`
web accessor is retired with the StateLab harness; the Custom/Demo package is today's
on-device diagnostics surface).
`new Error('bad input')` gives `{ name, message }` error values (`'' + err` → `"Error: bad
input"`); `navigator.language/languages/platform/onLine` are the read-only metadata subset —
anything permission-based stays a module.

## Async orchestration — Promise combinators

Statement-level `await`, concurrent elements (fetch / `dsx.module.…` / `crypto.subtle.…`;
plain expressions settle immediately):

```js
const results = await Promise.all([ fetch(urlA), fetch(urlB), dsx.module.self.refresh({}) ])
if (results[0].ok && results[1].ok) { dsx.variable.feed = results[0].data.items }

const first = await Promise.race([ fetch(primary), fetch(mirror) ])
```

`all` binds results **in order**; `race`/`any` binds the first to settle; `allSettled`
wraps each as `{ status: 'fulfilled', value }`. JSE's async ops report failures **as
values** (`{ ok:false, error }`), so nothing ever rejects — `all` always completes.

## WebSocket — core networking, surface-scoped

```js
const ws = new WebSocket(dsx.variable.socketUrl, { key: 'chat' })   // key optional (default = url)
ws.onopen    = () => { ws.send(JSON.stringify({ type: 'hello' })); dsx.variable.connected = true }
ws.onmessage = e => { dsx.variable.messages.push(JSON.parse(e.data)) }
ws.onerror   = e => { dsx.variable.error = e.message }
ws.onclose   = e => {
  dsx.variable.connected = false
  setTimeout(() => { dsx.action.connect() }, 2000, 'ws-retry')      // reconnects are YOURS (keyed)
}
```

The standard shape with **DSX lifecycle rules** (this is the part that matters on mobile):

1. **Keyed** — the same `key` replaces the previous socket, so a re-run can't double-connect.
2. **Surface-scoped** — sockets live on the surface's store like keyed timers; route changes
   and dismissals close them. No leaked connections, ever.
3. **Foreground transport** — the OS suspends/kills the task in background; `onclose` fires
   on return. Long-lived background realtime (auto-reconnect, presence, push fallback) is a
   **module**, by design: core gives you the standard transport, modules give you
   production mobile lifecycle guarantees.
4. Text frames are strings, binary frames are byte arrays (the crypto convention) — and
   `ws.send(bytes)` sends binary. Liveness is your own `onopen`/`onclose` state writes (the
   handle is a value dict, not a live `readyState`).
5. Statement-only (it needs the surface): construct in action bodies, not `{{ }}` formulas.

## The syntax floor (wave 1 — corpus: `Conformance/jse/syntax-001.json`)

JS source forms that now lex and parse verbatim on all three kernels:

- **String escapes** — the JS set (`\n \t \r \b \f \v \0 \' \" \\ \xHH \uHHHH \u{…}`);
  an unknown escape is the character itself (`'\q'` → `q`).
- **Template literals** — `` `hi ${expr}` ``, multiline, nested quotes in holes. Parts
  string-coerce and CONCATENATE (`` `${1}${2}` `` is `"12"` — never the numeric-first `+`).
- **Comments** — `// …` and `/* … */` strip everywhere (expressions AND action bodies).
  Regex literals are never comments (`replace(/\//g, '-')` is safe); `://` is protocol
  syntax, so a bare fetch-effect URL survives.
- **Numeric literals** — exponents (`1e3`, `2.5e-2`), radix forms (`0xFF`, `0b101`,
  `0o17`), `_` digit separators (`1_000_000`).
- **Operators** — `**` (right-assoc, coerces like `*`), `??` (nullish = the ONE missing
  value: null/undefined/bound-null; eager like `&&`/`||`), `?.` and `?.[i]` (pure sugar —
  member access is already total), bitwise `& | ^ ~` and shifts `<< >> >>>` (JS
  Int32/Uint32 wrapping, masked counts), unary `+`, compound assigns `+= -= *= /= %= **=`
  and `i++`/`i--` as statements.
- **ASI** — a statement-boundary newline is a `;` on every runtime (web + expression-position
  blocks now match the native runners): `x = 1⏎y = 2` is two statements, while a line ending
  in an operator/comma/dot or a line starting `.method()` / `?` / `:` / `&&` / `||` continues.

Wave 2 (`syntax-002.json` + actions corpus) adds the declaration & call grammar:

- **Spread in literals** — `[...xs, 3]` / `{ ...cfg, extra: 1 }` (last-wins). Spread and
  `for…of` share one iterable coercion: arrays, strings → graphemes, `Set` → values,
  `Map` → entry pairs; anything else contributes nothing.
- **Stored lambdas are callable** — `const f = (x) => x + 1; f(2)` works (a scope value
  that IS a lambda; shadows same-named builtins, 32-frame guard). Passing them by name
  (`list.map(f)`) worked already.
- **Destructuring declarations** — `const { a, b: renamed } = obj` and
  `const [x, , z] = arr` (flat patterns — no defaults, no nesting), plus
  **multi-declarators** (`let a = 1, b = 2`) — in action bodies AND `{ }` expression blocks.
- **`for…of` upgrades** — iterate strings/Set/Map, and destructure the loop var:
  `for (const [k, v] of new Map(pairs)) { … }`.
- **`do { … } while (cond)`** — body-first loop, budgeted like every loop.
- **`in`** — `'key' in dict` / `2 in arr` membership at relational precedence.
- **Logical assigns** — `x ??= e`, `x &&= e`, `x ||= e` statement sugar.

Wave 3 (`syntax-003.json` + actions corpus) adds the call & loop grammar:

- **Arrow param defaults + rest** — `(a, b = 5) => …` (the default evaluates at CALL
  time in the callee scope — earlier params and the captured creation scope visible —
  whenever the arg is missing/null) and `(a, ...rest) => …` (rest binds the remaining
  args as an array; empty when none). Named params only — destructured `{a, b}` params
  take neither.
- **Call-position spread** — `f(...xs)` through every call shape (stored lambdas, user
  functions, method calls, variadic builtins like `Math.max(...nums)`); the same
  iterable coercion as literal spread.
- **Call-on-value / IIFE** — `((x) => x + 1)(4)`, `fs[1](5)`, curried `f(1)(2)`: a
  lambda VALUE followed by `( )` invokes under the shared 32-frame guard; a non-lambda
  base leaves the parens unconsumed.
- **Prefix `++i` / `--i`** — the statement forms rewrite exactly like their postfix twins.
- **`for…in`** — a dict's OWN keys (insertion order, `__`-internal keys skipped, so
  Set/Map/Date value objects iterate empty) or an array's indices `0..n-1` (as numbers);
  anything else iterates zero times. The `in` OPERATOR inside a classic `for (;;)`
  header still parses as the operator (the `;` gate).

## The stdlib floor (corpus: `Conformance/jse/stdlib-001.json`)

The core-library fill, identical on all three kernels:

- **String** — `repeat` · `substring` (clamp + swap) · `lastIndexOf` · `trimStart`/`trimEnd`
  · `charAt` · `charCodeAt`/`codePointAt` (the code point of the i-th grapheme's first
  scalar — JSE exposes no UTF-16 halves) · `normalize(form)` · `matchAll` (arrays of match
  arrays) · `String.fromCharCode`.
- **Array** — `lastIndexOf` · `fill` · `findLast`/`findLastIndex` · `reduceRight` ·
  `toSorted`/`toReversed`/`toSpliced`/`with` · `entries`/`keys`/`values` (as arrays) ·
  `flat(Infinity)` fully flattens · `Array.of`.
- **Number** — `toFixed` (half-away-from-zero on the scaled double) and the STRICT
  statics `Number.isInteger`/`isFinite`/`isSafeInteger`/`isNaN` (no coercion) +
  `Number.parseInt`/`parseFloat`.
- **Object** — `Object.hasOwn`.
- **Math** — `atan`/`asin`/`acos`, the hyperbolics (+ inverses), `log1p`/`expm1`,
  `fround`/`clz32`/`imul`.
- **Date** — the full `getUTC*` getter set, `getTimezoneOffset`, `Date.UTC`, and the
  SETTERS (`setTime`/`setFullYear`/`setMonth`/`setDate`/`setHours`/`setMinutes`/
  `setSeconds`/`setMilliseconds`) — setters are value-object mutations: statement
  position persists them (`d.setHours(5)`), expression position returns the new ms.

Deliberately still out: `toPrecision` and `localeCompare` (collation/exponent formats
diverge across ICU hosts — use `Intl.NumberFormat` / explicit compares).

## The semantics to remember

1. **Value objects.** Every core object is a plain dict with internal `__` markers — store
   it in `dsx.variable.*`, pass it to actions, serialize it. No handles, no leaks.
2. **Mutations are statements.** `url.searchParams.set(…)`, `form.append(…)`,
   `headers.set(…)`, `c.abort()` persist when written as statements (read → mutate → write
   back, like `arr.push(x)`). In `{{ }}` expression position they return the modified copy.
3. **Total.** Bad input logs `[JSE core]` and yields `null` — never a crash, never a hang.
4. **Timers were already here**: `setTimeout(fn, ms, key)` / `setInterval` (keyed = debounce
   / replace; intervals die with the surface) / `clearTimeout` / `clearInterval`.

## Hardening notes (corpus: `Conformance/jse/hardening-001.json`)

- **ASI never splits before `else` / `while` / `catch` / `finally`** when the line above
  ends a `{ }` block those keywords attach to — a branch or a `do { … }` body on its own
  line stays attached (`}` + newline + `else` joins; a `while` joins only after a `do`
  block, so a fresh `while` loop on its own line still starts a new statement).
- **Regex literals are allowed after keywords** — `return /ab/.test(s)`, `case /a/…:`,
  `typeof /x/`, `throw /x/` lex as regex, not division, and the comment stripper never
  eats a `/*` inside such a literal (`return /^\/*/.test(s)` survives whole).
- **Parser depth cap 200.** Expression nesting (parens, brackets) beyond 200 abandons the
  parse to `null` — total, never a blown native stack; template-hole nesting in the
  tokenizer is capped the same way (~32, deeper holes ride as literal text).
- **Date setters clamp instead of crash.** `d.setDate(NaN)` / huge component values keep
  the date total on every kernel (`getTime()` stays a number — possibly `NaN`, never a
  trap); `new Date(y, m0, d, …)` builds a LOCAL date from components on all three.
- **±Infinity saturates in index math** (`safeInt`): `'hi'.substring(0, Infinity)` is the
  whole string, `toSpliced(Infinity, …)` splices at the end, `padStart` is bounded at
  10 000 like `repeat`.
- **Interior `await` is an authoring error** (jse-audit `interior-await`): only
  statement-leading `await` suspends; mid-expression a live Promise coerces to `null`
  (with a runner warn), never `"[object Promise]"` concat.

## Shared logic — the global function library

Common logic (validation, pricing, formatting) is written **once** and shared by every
surface: an app-wide function table that sits in the named-call lookup order right after
each surface's own functions. All three kernels expose the same API (TS `jse.ts` ·
Kotlin `Jse.kt` · Swift `JSE.swift`):

```js
JSE.registerGlobalFunctions(body)   // string-scan body's top-level `function name(){…}` decls
JSE.clearGlobalFunctions()          // drop them all (tests; a full reload)
```

- **Lookup order at a named call `f(x)`** — identical on the interpreter Parser and the
  compiled `$.call`: scope lambda (a `const f = …` in scope) → the surface's own
  function table (a **surface-local name shadows the global**) → the **global table** →
  builtins. Same `fnDepth` 32 recursion guard.
- **No scope capture** — global registration uses the same scanner as per-surface
  `registerFunctions`: top-level functions are not closures; free names resolve against
  the *calling* surface's live store at call time. Global functions can call each other
  (and themselves — the depth guard contains runaway recursion).
- **Registration**: a module or the app boot calls
  `JSE.registerGlobalFunctions(sharedBody)` at startup, **or markup declares the
  block** — **`<functions global="true">`** in a `<head>`. The `global` attribute's
  PRESENCE routes the block into the app-wide table (the valued spelling is
  canonical: the strict-XML native parsers reject a bare `global`; the web parser
  accepts both). Re-registration replaces (last write wins). Wired on all three
  renderers — web: compiler `head.globalScripts` → `registerGlobalFunctions` in
  @despia/dom `instantiate` + @despia/server `renderInstance` · iOS: `StackHead.register`
  + the render-path `"script", "functions"` case (Stack.swift, compile-pending) ·
  Android: the :core head seam `StackStore.registerHeadFunctions(attrs, body)`
  (JseRunner.kt; the :render head dispatch still calls `registerFunctions` directly —
  its one-line switch to the seam is the remaining app-side hookup, and the
  ClosedSource watch/wear satellite head mounts adopt the same attr routing).
  Body caveat: the NATIVE parsers (StackNode.swift/StackNode.kt `codeTags`) do not
  yet lift `<functions>` bodies as raw JS (web's parser does), so avoid a bare `<`
  in a functions body (`a < b`) until that one-word twin addition lands — lint
  mirrors the native parsers here by law.
- Corpus: `OpenSource/Conformance/functions/` (shadowing order, last-write-wins,
  no-capture, the action-statement path) — TS `function-conformance.test.ts` +
  Kotlin `FunctionConformanceTest.kt` per-PR; Swift is the reference
  (record-lane execution pending, the actions-corpus arrangement). Dual-executor
  lookup tests: `packages/kernel/test/global-functions.test.ts` ·
  Engine/Android `GlobalFunctionsTest.kt`.

## Deliberately NOT core

- **`localStorage`** — state is `dsx.variable` / `dsx.global` / the storage modules; a second
  storage door would blur the one reactive model.
- **`EventTarget`** — eventing is `dsx.event` / `ui.on` / `dsx.broadcast`; one bus, not two.
- **Streams** — add only when fetch/file workloads demand them.
- **Every device capability** (auth, payments, push, camera, location, contacts, clipboard,
  health, widgets, keychain) — modules, by design, even where web APIs exist.

## The coverage gate — jse-audit

JSE fails **open** at runtime: a JS construct the engine doesn't run evaluates to a silent
`null`. The gate turns that into a fail-**loud** authoring-time error. The policy:
**unsupported JS is an authoring-time error, never a silent null at runtime — satellite
surfaces (watch, keyboard) have no JS fallback by hardware reality, so the gate is the
fallback.**

```bash
cd OpenSource/Web
node packages/kernel/bin/jse-audit.ts                    # audit every .dsx in the repo
node packages/kernel/bin/jse-audit.ts --strict path/     # CI mode: exit 1 on any finding
node packages/kernel/bin/jse-audit.ts --json Comp.dsx    # machine-readable findings
```

It extracts every JSE code site from `.dsx` markup — `{{ }}` segments in attributes and
text, `on:*` handler bodies, `<action>/<variable>/<function>/<formula>` blocks,
`visible-if`, `<watch value>` — and runs the **kernel's own tokenizer and parser** over
each (the public exports are the oracle; no second grammar). What it reports, each with
the JSE spelling to use instead:

- **banned-construct** — `class`/`extends`, `yield`/`function*`, `import`/`export`,
  `void`, `delete`, `instanceof`, `async` fn syntax, `new Promise`, labeled loops.
- **promise-chain** — `.then/.catch/.finally(…)` → statement-level `await` (failures are
  values: `r.ok` / `r.error`).
- **unsupported-method** — the documented non-goals `localeCompare` / `toPrecision`.
- **unknown-op** — tokens the lexer doesn't know (`@`, `#`, …).
- **parse-residue** — a `{{ }}` expression with a dead tail the parser never consumed
  (exactly what the runtime would silently ignore).
- **unsafe-number-literal** — a numeric literal above 2^53: it runs, but lossily (doubles
  cannot hold the integer exactly), so 64-bit backend IDs ride as STRINGS.

Dict keys named like keywords (`{ class: 'chip' }`), `Map.delete(k)`, `try/catch/finally`,
and `visible-if="has:scheme"` are all recognized as the legal forms they are — the
supported modern floor (templates, `??`, `?.`, spread, destructuring) never flags.
Tests: `node --test packages/kernel/test/jse-audit.test.ts`.

## Testing your logic — dsx-test

Complex apps unit-test THEIR actions the way the kernel tests itself. Write a fixture
file named `<anything>.dsxtest.json` next to your component — **exactly the actions-corpus
shape** (`OpenSource/Conformance/actions/actions.json`); the in-repo example to copy is
`OpenSource/Conformance/examples/cart.dsxtest.json`:

```jsonc
{ "cases": [ {
  "name": "addItem-recomputes-total",
  "actions": {                                  // your <action> declarations, verbatim bodies
    "addItem": { "body": "dsx.variable.cart.push({ sku: sku }); dsx.action.total()" },
    "total":   { "body": "dsx.variable.total = dsx.variable.cart.length" }
  },
  "scope": { "cart": [] },                      // seeds the store (a JSON null seeds nil)
  "run": "dsx.action.addItem()",                // a bare action name works too
  "runItem": { "sku": "tea" },                  // optional dsx.this / declared-inputs payload
  "expectStore": { "total": 1, "err": null },   // JSE equality; null asserts absent/nil
  "expectEvents": ["saved"]                     // dsx.event order, exact
} ] }
```

```bash
cd OpenSource/Web
node packages/kernel/bin/dsx-test.ts                     # sweep the whole repo for *.dsxtest.json
node packages/kernel/bin/dsx-test.ts path/to/Comp.dsxtest.json   # one fixture
node packages/kernel/bin/dsx-test.ts --json src/         # machine-readable results
```

Each case runs on a **fresh store** (no bleed between cases) through the **same
`ActionRunner` the actions corpus gates** — the full grammar (templates, destructuring,
`await Promise.all`, action chaining, events) with the same bug-for-bug semantics, so a
green fixture is the same promise the kernel makes to itself. Failures print the
mismatched path with actual vs expected (JSE string coercion) plus a per-case wall
clock, and the CLI exits 1 — CI-ready as-is. Unknown case keys fail loudly (a typo'd
`expectstore` never silently asserts nothing); keys starting with `_` are notes.
Harness tests: `node --test packages/kernel/test/dsx-test.test.ts`.
