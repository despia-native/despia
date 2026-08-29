# Legacy web API — do not use in new code

> The modern web API is **`window.dsx`** — every module call rooted at
> `window.dsx.module.<scheme>.<method>(...)`. This file is the *only* place the legacy
> forms are documented — it exists so old pages keep working and so a maintainer can
> recognise the old shapes, **not** as something to write.
>
> **The entire legacy surface is owned by ONE excludable module:**
> `ClosedSource/DSX/Modules/Core/Legacy` — THE LEGACY PACKAGE
> (`architecture/proposals/legacy-package.md`). It ships **included by default** (existing
> apps change nothing); excluding it is the hardened opt-out — no `despia.*` injection, no
> scheme-string routing, no legacy deeplink verbs; only `window.dsx` remains.
>
> **The v3 API is a CLOSED FINITE set — enumerated, never parsed.** Every legacy verb is a
> declared row in its owning module's manifest (`facets.legacy`: args template + modern
> action + the v3 response convention + push mappings); the injected `window.despia` shim
> is GENERATED from that table, and the native routers do closed-table lookups (splitting
> only the known `<verb>://` prefix). The exhaustive verb catalog is
> `OpenSource/Conformance/legacy/verbs.json`; verbs not yet declared are ledgered per-verb
> in the proposal doc.
>
> Modern reference: [`guides/despia-api.md`](guides/despia-api.md).

## The `window.despia` shim — the generated legacy surface

`window.despia` exposes **exactly the declared verbs** as functions, plus the kept
documented members (`supports · runtime · on · broadcast · packages · excluded ·
wasExcluded · hasPackage · package · version · global · navigate · log · error`). Each
verb calls the modern engine directly (the same one `window.dsx` uses — one pending-call
registry, one delivery sink) and re-delivers its reply the declared v3 way (a window
global and/or a page callback):

```js
// a declared verb — the dot form
window.despia.readvalue();          // → dsx.module.writevalue.read({}) + window.storedValues

// the string forms (route through the same closed table)
window.despia = "writevalue://my blob";   // → dsx.module.writevalue.write({ value: "my blob" })
despia("readvalue://", ["storedValues"]); // the watch-globals convention — resolves off the response global
```

- An **undeclared string form** falls through to the platform navigation untouched — the
  registry first-dibs (the modern extension point) still answers registered legacy
  schemes/aliases there, so URL-form verbs keep working while their declarations land.
- An **undeclared dot form** answers a callable that rejects the v3-shaped
  `unknown_verb` envelope + one `dsx.log` line (feature-sniffs stay truthy; nothing
  TypeErrors). Debug/test builds additionally log bare unknown-member access.
- A verb whose **owning module is excluded** keeps its function and rejects the honest
  `not_loaded` envelope (`despia.wasExcluded('<scheme>')` stays readable).

## Legacy forms (recognise, never write)

### 1. `window.virtual` — RETIRED

`window.virtual` was the raw transport the native runtime injected; `window.despia` was
built on top of it and **web code never touched it** (it was never part of the API). The
mirror was therefore its only caller, and it retired with the mirror: the modern
transport is the internal `window.__dsxWire` (frozen, structured-only, first-bind-wins
sink — the stable-sink design in `architecture/proposals/legacy-package.md`).

| Old spelling | Modern |
|---|---|
| `window.virtual.href = "scheme://…"` | `window.dsx.module.<scheme>.<method>(…)` |
| `window.virtual.send({ scheme, params })` | `window.dsx.module.<scheme>.<method>(params)` |
| `window.virtual.storage` | retired (never shipped); pass a `File`/`Blob` param — it auto-uploads |
| `window.virtual.capabilities` | `window.despia.supports` (`.events` / `.structured` / `.version`) |

### 2. The string-call forms — `despia("scheme://…")`

The old bridge was a single string-callable. The forms still work **for declared
verbs** (table-routed) and fall through to navigation otherwise; new code uses the dot
form on `window.dsx`.

| Legacy string call | Modern |
|---|---|
| `window.despia = "scheme://"` | `window.dsx.module.<scheme>.<method>()` |
| `despia("verb://tail")` | `await window.dsx.module.<chain>.<action>({ … })` |
| `await despia("verb://", ["global"])` (watch a `window.*` global) | `await window.dsx.module.<chain>.<action>({ … })` (resolves directly) |

> The `scheme://action` spelling inside the structured envelope is the engine's internal
> wire FRAMING (the dot API builds it to talk to native). That's an implementation
> detail — you never write it, and no page string is ever parsed against it.

### 3. eSIM provisioning

The kernel used to special-case `window.despia = "esim://?carddata=…"` and redirect to
Apple's eSIM URL. That hardcode is **removed** — it named a single SDK, which the kernel
must not. A page that wants eSIM provisioning navigates to the Apple URL directly:

```js
window.location.href =
  "https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=" + encodeURIComponent(cardData);
```

(Or, if a build ships an eSIM **module**, call it the modern way: `window.dsx.module.esim.setup({ cardData })`.)

### 4. Health data verbs

Declared rows on `Core/HealthKit` (chain `healthkit`); the identifiers ride the HOST slot,
so each row hands its verbatim tail to the modern action.

| Legacy form | Route | v3 response |
|---|---|---|
| `readhealthkit://<Id>[,<Id>…]?days=N[&raw=true]` | `healthkit.read({ query: "<tail>" })` | `window.healthkitResponse` = object keyed by type: daily `{ date, value, unit }`, raw `{ startDate, endDate, value, unit, source }`, sleep `{ startDate, endDate, value, label }` |
| `writehealthkit://<Identifier>//<Value>` | `healthkit.write({ body: "<tail>" })` | `window.healthkitWriteResponse` = `{ ok, identifier, value[, error, message] }` (additive — v3 writes historically reported nothing) |
| `healthkit://state[?types=<Id>,…]` | `healthkit.status({ types })` (routed in the module pre-filter — `state` is a reserved proxy member) | `window.healthkitState` = `{ available, reason?, requested, types }` |

When the health store is unavailable, both rows' `push` mappings re-deliver the module's
`unavailable` broadcast into the same globals as `{ error: "healthkit_unavailable", code,
message }`, so a page polling them settles instead of timing out. Modern code uses
`window.dsx.module.healthkit.read/write/status(...)` and the context plane
(`dsx.module.healthkit.context.available`).

---

## Why these are legacy

`window.dsx.module.<scheme>.<method>()` is feature-detectable (`window.dsx.has`), mirrors
the native and Android call shapes exactly, and needs no string handling. The `window.despia`
shim and the string forms predate it and survive only for already-shipped pages — as a
closed, declared, per-verb contract. New DSX, generated code, and all documentation use
**`window.dsx.module.*`** — nothing here.

---

## The legacy verb catalog — where it lives

The **authoritative, generated** catalog has two layers:

- **Declared verbs** — each module's `dsx.json` `facets.legacy` rows (args → modern
  action → response convention → push), aggregated by the facet-declaration fan-in into
  `Core/Legacy`'s generated `LegacyMap` (native tables + the substituted page shim), and
  pinned exhaustively by `OpenSource/Conformance/legacy/verbs.json`.
- **Registry aliases** — each module's `dsx.json` `aliases`, rolled up into
  `ClosedSource/Registry/ModuleSchemes.generated.swift` (`aliasesByClassName`) and its
  Kotlin twin — these keep the URL forms of not-yet-declared verbs routing (the registry
  first-dibs), and feed introspection (`despia.hasPackage('readvalue')`). An iOS-only
  legacy scheme answers the graceful `unsupported_platform` envelope via
  `ModulePlatformSupport.generated.*`.

To add or check a legacy verb, edit/read the owning module's `dsx.json`, not this file —
the generated map is the source of truth. The migration ledger (declared now vs deferred,
per verb with reasons) lives in `architecture/proposals/legacy-package.md`.
