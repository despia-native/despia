# Networking — two layers, and only two

**Status: PROPOSED v2.** How a Despia app reaches a network: its own server node, a hosted backend
(Supabase, Firebase, Convex), or any third-party API — plus constants, streaming, uploads and
sockets.

> v1 of this document proposed a `bases` registry and kept a shipped route table. Both are
> **withdrawn** — see *What this deletes*. They solved problems that a simpler shape does not have.

## Why this exists

Two things forced it, and both were found by building a real screen rather than by reading code.

**1 · The best-ergonomics mechanism does not work where you write screens.** `<api>` mounts only
for a *surface root*; inside a component it is "purely declarative" and silently does nothing. An
app's entry screen IS a component, so a Notes screen written with `<api>` rendered perfectly and
never issued a request — `notes.loading` and `notes.error` were not `false`/`null`, they were
**absent**. Nothing logged, because nothing was malformed. Nobody had hit it because **no shipped
markup uses `<api>` at all**.

**2 · There were four networking mechanisms and no story ranking them** — `<api>`, the `fetch`
action verb, the module bus, and a WebSocket module. All real, all on three runners (mostly), none
obviously first.

## The law

> **Layer 1 is universal and vendor-blind. Layer 2 is vendor-named and optional.
> Anything Layer 2 can do, Layer 1 can already do — worse, but it can do it.**

```
┌─ LAYER 1 — always present, knows no vendor ─────────────────────────┐
│  fetch()   ·   <api>                                                │
│  1:1 with the browser: any host, any method, streaming, upload.     │
└─────────────────────────────────────────────────────────────────────┘
┌─ LAYER 2 — optional, excludable, vendor-named ──────────────────────┐
│  dsx.module.supabase.*  ·  dsx.module.firebase.*  ·  …              │
│  Native SDKs, native OAuth, native realtime.                        │
└─────────────────────────────────────────────────────────────────────┘
```

This is the web model exactly — `fetch` plus optionally `supabase-js` — and it is what the
constitution already requires: *"vendor-specific power is always vendor-named
(`dsx.module.supabase.*`), never smuggled through the common interface"* (full-stack.md decision 1).

**The escape-hatch rule is what keeps Layer 2 honest:** if `fetch` cannot express something, a
vendor module must not be the only way to do it. Layer 2 is convenience, never a gate.

### `fetch` first, `<api>` as the upgrade

Both exist, and the ordering is deliberate: **a developer can build an entire app knowing only
`fetch`.** `<api>` is what you reach for on the second pass, when a button wants a spinner.

```
result = POST {{ dsx.const.api_url }}/notes body={ title: draft }   // knows nothing but fetch
```
```xml
<api as="create" url="{{ dsx.const.api_url }}/notes" method="POST"/>  <!-- + create.loading -->
```

The split is the industry's: Nuxt `$fetch`/`useFetch`, React Query fetch/`useMutation`,
SWR `mutate`/`useSWR`. Teaching order is the change, not the mechanism.

---

## N0 — `dsx.const`: constants, hardcoded OR dynamic

App-wide constants belong to the **app**, not to a module. `App.json` is already "the app-identity
manifest (kernel config plane)"; this extends it. **No module and no native code are required.**

**Hardcoded** — `ClosedSource/App.json`:

```jsonc
{
  "hosts":  { "": "myapp.com" },
  "consts": { "api_url": "https://xyz.supabase.co", "anon_key": "eyJhbGci…" }
}
```

**Dynamic** — one more line. The path is relative to `hosts`, so there is no chicken-and-egg:

```jsonc
"consts_url": "/env/const/public"
```

**Resolution ladder** (the content-plane rule, applied to config):

| | Source | Property |
|---|---|---|
| 1 | baked `consts` | always present, offline, synchronous at first frame |
| 2 | cached remote | only if newer than this build |
| 3 | fresh remote | applied when it lands; `dsx.const` is reactive, so screens update |

- **The baked values are a floor, not a last resort.** A failed, slow or malformed fetch changes
  nothing. There is no state in which the app has no constants.
- **A new build resets the floor** — cached values older than the current build are discarded, so
  shipping a fix in `App.json` cannot be overridden by a stale cached value. That is the recovery
  path when a bad remote value goes out.
- **Non-blocking at boot.** A spinner on cold start is worse than a value that sharpens.

**Read identically everywhere** — a screen never knows which source won:

```xml
<api as="notes" url="{{ dsx.const.api_url }}/rest/v1/notes"
     headers="{ apikey: dsx.const.anon_key }"/>
```

**Security.** Everything in `consts` is public — it ships in the binary and is served from an
endpoint named `public`. Secrets belong on a server, never here. `consts_url` is fetched from the
app's OWN `hosts` origin, which the app already trusts for its content and routes, so it adds no
new trust — but it does add reach: a hostile response could repoint `api_url` and the bearer token
would follow. Therefore: **https only**, flat JSON of scalars, bounded size, and **signing
available** (`const_public_key`, the existing detached-signature contract from
remote-bundle-signing.md). Signing is optional for a feature flag and the right default the moment
a const decides where credentials go.

**Gates:** the ladder (baked → cached → fresh), build-stamp invalidation, offline keeps the floor,
a malformed/unsigned payload changes nothing, `dsx.const` reactivity. Three runners, fixtures first.

> **Landed (2026-07-28) — the read plane.** `dsx.const.<name>` is a reserved namespace that folds
> to the app-wide reactive store (`normalizeScope: const → global.const`), so it is read identically
> everywhere, is reactive for free (a const change re-materializes every `<api>` that read it — same
> plane as `env`), and is typed-absent (missing → null). Corpus-gated in `Conformance/api/`
> (`const-materializes-into-request`, `const-change-refetches`) on TS + Kotlin (green); Swift
> compile-pending (rides the record lane). The web host seeds it at boot from `App.json` `consts`
> (`bootDsx` `opts.consts`). **Deferred (host/content-plane machinery, not the authoring surface):**
> the dynamic `consts_url` fetch, the baked→cached→fresh ladder, build-stamp invalidation, and
> signing (`const_public_key`) — these belong to the content plane and touch remote-bundle-signing,
> so they land as a follow-up, not in this Track-F slice.

---

## N1 — `<api>` mounts in a component *(the blocker)*

Until markup-where-you-write-it can issue a request, everything else is decoration. Today
`StackHead.hoist` collects `<api>` for surface roots and `StackSurface` mounts them once; the
component path returns `EmptyView()`.

**Fix:** a component instance owns its api blocks — mounted when it mounts, disposed when it
unmounts, keyed per instance. The existing duplicate-`as` guard stays.

**Gates:** an `<api>` in a component fires exactly once; two instances of one component get
independent blocks; unmount disposes and cancels in-flight; the duplicate guard still fires.

**Until this lands, `<api>` is not the recommended form and the reference must say so** — a silent
no-op is worse than a missing feature.

> **Landed.** The mount itself is on all three renderers: web mounts per `instantiate()` (component
> `attrs` are the scope), Android via `StackApiView` at the render pass (`claimApiHandle` guard), and
> iOS via `StackApiMountView` + `StackStore.mountApiBlock` (commit 9354a32f, "P1: `<api>` mounts
> inside a component (iOS)") — iOS was the last renderer to close. Added 2026-07-28: a shared corpus
> fixture (`Conformance/api/api-blocks.json` → `api-in-component-scope-materializes`) proves the
> block materializes its request from the **component's scope** (the block's `item`) on TS + Kotlin
> (green; Swift compile-pending). The remaining N1 gates that the single-block shared harness cannot
> express — two instances get independent blocks, unmount disposes + cancels in-flight, the duplicate
> `as` guard — stay covered by each renderer's own mount-layer integration tests (the iOS recorder
> check in 9354a32f; Android Compose `DisposableEffect`; the web `mount.ts` teardown).

---

## N2 — Layer 1 completeness (`fetch` 1:1 with the browser)

This is the layer that cannot be half-done, because it is the escape hatch.

| Area | Required |
|---|---|
| Methods | GET · POST · PUT · PATCH · DELETE · HEAD · OPTIONS |
| Body | JSON · text · form · **multipart/file** · binary |
| Headers | arbitrary, per request |
| Streaming | SSE, promoted to a **declared** `stream="true"` |
| Control | abort/cancel · timeout · retry policy · redirect policy |
| Response | status · headers · body, **no envelope imposed** on a third-party API |
| Progress | upload and download |

`stream="true"` is declared on purpose: a connection that stays open should be something the
author asked for.

**Gates:** corpus rows per capability on three runners — chunk order, mid-stream error, cancel, a
stream that never EOFs, multipart round-trip, timeout, abort during upload.

> **Landed (2026-07-29) — the declared Layer-1 surface.** `stream=` (declared streaming, no
> content-type sniffing: `true` also streams a non-SSE body as newline-delimited chunks, `false`
> reads an event-stream as one payload), `timeout=` (per-request ms, terminal `timeout` error),
> `redirect=` (`follow` default | `error`), `encode=` (`json` default | `text` | `form` |
> `multipart` — the kernel materializes the wire form, multipart as `parts` sorted by field name),
> and `on:progress` + `<as>.progress` all ship in the three kernels (`api.ts` · `ApiBlock.kt` ·
> `ApiBlock.swift`), corpus-gated by five `Conformance/api/` rows on TS + Kotlin (Swift
> compile-pending, record lane). The web transport half is unit-gated in
> `packages/kernel/test/api-transport-controls.test.ts`.
> **Ratified as-is (the "Control" row's residue):** `retry` stays IMMEDIATE-ONLY — doc 05 already
> states v1 carries no delay/backoff schedule, and adding one requires a new shared TIMING corpus,
> which the seamed hosts (injected clock, synchronous natives) cannot express today; the corpus row
> `terminal-response-errors-do-not-retry` pins that a `-2` terminal response is never amplified.
> `abort/cancel` is landed and unchanged (`cancel()` on all three + `cancel-clears-inflight-flags`).
> **Deferred, declared:** UPLOAD progress needs a request-stream-capable transport — the native
> URLSession/OkHttp transports have one, the browser `fetch()` does not, so on web `progress` is
> download-side. Binary request bodies beyond the `{ __blob }` multipart part are not yet a
> declared `encode=` word.

---

## N3 — `Core/Supabase`: the vendor layer

Not a new kind of thing. `Core/Payments/Stripe` is the working template: a module declaring a
**native SDK** on both platforms from its own manifest.

```jsonc
// ClosedSource/DSX/Modules/Core/Supabase/dsx.json
{
  "name": "Supabase", "scheme": "supabase",
  "pods":   ["Supabase"],
  "gradle": { "dependencies": ["io.github.jan-tennert.supabase:postgrest-kt:…"] },
  "dependencies": ["websocket"],
  "config":  { "url": …, "anon_key": … }
}
```

**A REQUEST AND A SUBSCRIPTION ARE DIFFERENT DECLARED SHAPES.** An action carries `args` /
`resolves` / `stream` / `events` / `broadcasts`, and the difference is not stylistic: a request
resolves once, a subscription emits over time and must be stoppable. `Core/Basics/Gyroscope`
already ships the streaming shape (`args` + `stream: true` + `events: ["change"]`), and
`verify_module_tests.rb` — in the CI chain — validates every action against its declaration, so a
subscription mis-declared as a request fails the build.

| Shape | Declares | Examples |
|---|---|---|
| **request** | `args` → `resolves` | PostgREST query · auth sign-in · a POST |
| **stream** | `args` → `events` + a handle to stop | realtime · SSE · sockets · sensors |

```jsonc
"from":              { "args": { "table": "string", "select": "string" },
                       "resolves": { "rows": "array" } },
"realtime.subscribe":{ "args": { "table": "string" },
                       "stream": true, "events": ["insert","update","delete"],
                       "resolves": { "id": "string" } }     // the handle, so it can be stopped
```

```xml
<action as="signIn">await dsx.module.supabase.auth.signInWithOAuth({ provider: 'apple' })</action>
<action as="load">  await dsx.module.supabase.from({ table: 'notes', select: '*' })</action>

<action as="live">
  const s = await dsx.module.supabase.realtime.subscribe({ table: 'notes' });
  dsx.variable.sub = s.data.id;
</action>
<watch on="supabase.insert" do="notes.refresh()"/>   <!-- outputs are EVENTS, not a return value -->
<action as="stop">await dsx.module.supabase.realtime.unsubscribe({ id: dsx.variable.sub })</action>
```

Order within the phase: **auth → PostgREST → realtime** — auth is what `fetch` genuinely cannot do
well (native OAuth via ASWebAuthenticationSession / Custom Tabs), and realtime last because it is
the one that must get the streaming shape right.

**Exclusion is the switch**: drop the module and the SDK, the pods, the Gradle deps and the verbs
all leave with it — the push-provider precedent (OneSignal · Pushwoosh · Firebase), unchanged.

**Firebase and Convex are copies of this manifest**, not new designs.

---

## N4 — sockets and uploads, named honestly

- **WebSocket stays a module** (`Core/WebSocket`). A socket is a long-lived object with a
  lifecycle, not a request; pretending otherwise produces two half-APIs. Vendor modules may depend
  on it or bring their own.
- **Upload is `fetch`/`<api>` with a file body** plus the existing file modules — no new stack, but
  it needs a documented recipe and progress, because a 20 MB upload with no progress is the worst
  UX in any app.

---

## What this deletes

Both were built this week and both are **withdrawn**, because the simpler shape does not have the
problem they solved:

| Deleted | Why |
|---|---|
| `generated/link.json` + `link.ts` — the shipped route table | A client that stores paths can drift from a server that changes them. A **convention** (`/dsx/call/<chain>/<action>`) cannot — tRPC, Firebase callables, gRPC and Supabase all compute the path. Nothing to synchronise. |
| `src/link-refresh.ts` + signing fixtures + anti-rollback | Machinery to keep that table in sync. Deleting the table deletes the need. **Signing stays for content/OTA**, where author-authored bytes really are shipped. |
| the `bases` registry / `@name` syntax (v1 of this doc) | `dsx.const` already is the global constant system. A second naming scheme earned nothing. |

**The by-name server call is KEPT, as explicitly optional sugar.** `dsx.module.orders.submit({…})`
resolves by convention to the app's own server node. It is the only construct that makes moving an
action between client and server free at the call site, it is already built and proven end-to-end,
and with convention paths it costs no table and no refresh. The test it must always pass: **if it
vanished, every app still works** via `<api url="{{ dsx.const.api_url }}/orders/submit"/>`.

---

## Constitutional check

- **The kernel names no vendor.** Layer 1 cannot tell Supabase from any other HTTPS host, and must
  never be able to. If `base="@supabase"` would ever mean something `base="@backend"` does not,
  the design has become a vendor integration wearing a config file — reject at review.
- **Vendor power is vendor-named and excludable** — Layer 2, per full-stack.md decision 1.
- **Constants are the author's**: `App.json` belongs to the app, and Despia ships `consts` empty.
- **Unified-codebase law**: every new authoring surface (`stream`, `<api>`-in-component,
  `dsx.const`) ships fixtures-first on TS · Kotlin · Swift.

## Order, and why

1. **N0 `dsx.const`** — both layers read it; nothing else can be configured without it
2. **N1 `<api>` in components** — the actual blocker
3. **N2 Layer 1 completeness** — with this, a Supabase-backed app ships **today** on `fetch` + consts
4. **N3 `Core/Supabase`** — makes it pleasant; never makes it possible
5. **N4 recipes** · then Firebase / Convex as copies

## Verification

Per phase, all green: `npm test` · `npm run conformance` (three runners) · `npm run typecheck` ·
`prepare_modules` ×2 · `lint_dsx --strict` · `check_module_rules` — plus, for anything touching a
screen, **run it in the simulator**. The `<api>`-in-component defect passed every static gate in
this repo and was only visible in a running app.

## What could ruin it

Two mechanisms that drift. If `fetch`, `<api>` and the by-name call stop sharing one transport, one
constant source and one failure vocabulary, this document has produced a fourth mechanism instead
of a story. The gate: each must be expressible in terms of the primitive, and each corpus-tested on
three runners — the bar the rest of the authoring surface already meets.
