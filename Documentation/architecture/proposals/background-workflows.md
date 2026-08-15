# Background workflows — hosted JSON workflows the NATIVE side runs while the page is dead (status: PROPOSED)

> **Status:** PROPOSED (v0, 2026-08-08) — design, not landed. Companion docs:
> `../constitution.md` (the law this is judged against), `jse-platform.md` (the runner
> this rides), `legacy-package.md` (the v3 compat precedent this mirrors),
> `error-system.md` + `bundled-floor.md` (the ledger and the signing/serving ladder it
> reuses), `OpenSource/Conformance/actions/` (the corpus that already gates the grammar).
>
> **The one-sentence pitch:** a silent push wakes the NATIVE process while the web view
> stays suspended, so on d-ios/d-android there is currently nobody home to do the work —
> this gives an app a **hosted, signed JSON document of declared actions** that the native
> runner executes at wake time, and it is **not a new language**: the document is the
> serialization of the action grammar the kernel already runs on three runtimes.

---

## 1 · Why

Silent push wakes the **native app process**. The `WKWebView` content process (and the
Android renderer) stay suspended, so no page JavaScript runs at the moment the payload
arrives. That is an OS guarantee, not a runtime limitation, and no amount of engineering
changes it.

On the **v4 framework** that is already answered: `dsx.fire("push.silent", payload)` fires
into the native bus (`PushRouting.swift` / `PushRouting.kt`) and a module hooks it in
Swift or Kotlin. Real background work, page not involved.

On **v3 (d-ios, d-android)** there is no such seam. The app is a web view plus fixed
native code, and the customer supplies none of that native code. So today
`SilentPushManager` can honestly do exactly one thing: **queue the payload so it is not
lost** and hand it over when the page can run again. That is a reliable mailbox, not
background execution — the wake window is spent doing nothing.

This proposal fills that window. The same gap exists beyond push (a motion buffer that
wants flushing to a server, a content prefetch on app launch), so the seam is defined
around **wake events in general**, with silent push as the first trigger.

---

## 2 · The decision that shapes everything: JSON is a SERIALIZATION, not a language

The tempting move is to invent a small JSON workflow language for v3. **Do not.** This
codebase has spent its recent history deleting v3/v4 forks — one wire contract per
feature, one permission vocabulary, one payload cap. A v3-only workflow dialect
reintroduces that fork at the deepest possible layer, and "carry it over to v4" then
means v4 owns *two* workflow languages forever: the real one, and a compat interpreter
nobody can ever delete.

**The kernel already has the language.** `OpenSource/Conformance/actions/README.md` is
explicit: *DSX actions ARE workflows* (the Nordcraft analogue). A declared action runs the
bounded statement grammar — `if`/`else`, `while`, `for`/`for…of`, `switch`, `try`/`catch`,
`const`/`let`, assignment, array mutation, `dsx.event` — and actions call other actions,
depth-capped at 32 so a workflow is **bounded, never a hang**. Three runtimes execute it
identically under one corpus: TS kernel, Kotlin `:core`, and Swift `JSERunner`.

**And it is already JSON.** The corpus case shape is a JSON document whose actions carry
JSE **source strings** as bodies:

```json
{
  "actions": {
    "start":  { "body": "dsx.variable.a = 1; dsx.action.next()" },
    "next":   { "body": "dsx.variable.b = dsx.variable.a + 1" }
  },
  "run": "start"
}
```

That is the workflow document, minus the test assertions. Seventy-three cases ship in this
exact shape today. So the format the customer hosts is **the corpus case shape promoted to
a wire contract** — no new grammar, no AST encoding, no second parser, and the existing
corpus becomes the conformance suite for free.

> **Consequence, stated plainly:** "backwards support carried to v4" costs nothing,
> because v3 and v4 were never running different languages. v3 runs a **subset** of the
> verbs; v4 runs the same document with more verbs available.

---

## 3 · The document

```json
{
  "format": "dsx:workflow@1",
  "id": "nightly-sync",
  "version": 7,
  "on": ["push.silent"],
  "actions": {
    "main": { "body": "const r = await net.get(dsx.variable.syncUrl); store.set('cursor', r.cursor); dsx.event('synced')" }
  },
  "run": "main",
  "budget": { "ms": 20000, "requests": 4 }
}
```

| Field | Meaning |
| --- | --- |
| `format` | Envelope discriminator, versioned exactly like every other generated artifact here. |
| `id` / `version` | Identity and monotonic revision. A lower `version` than the one on disk is refused, so a replayed old document cannot downgrade behaviour. |
| `on` | Which wake events run this document. v0: `push.silent`. Later: `app.launch`, `motion.flush`. |
| `actions` / `run` | The corpus case shape verbatim — named actions, JSE bodies, one entry. |
| `budget` | Per-run caps, clamped by the native ceiling (§5). A document may lower them, never raise them. |

Serving and caching ride the **existing** ladder rather than a new one: hosted under the
app's content root, atomically generationed, stale-while-revalidate, seeds are generation
zero (`bundled-floor.md`, `source-plane.md`). A workflow is content, and the content plane
already knows how to serve content.

---

## 4 · The async seam and the CLOSED verb allowlist

The actions corpus is deliberately **synchronous only** — fetch, timers and module calls
have their own seams. Background work is inherently async, so v0 adds a small awaitable
surface. It is a **closed allowlist**, not a bridge to the module bus:

| Verb | Bound |
| --- | --- |
| `net.get(url)` / `net.post(url, body)` | HTTPS only, allowlisted hosts, per-run request cap, response size cap, hard timeout |
| `store.get(k)` / `store.set(k, v)` | The existing value store, size-capped |
| `content.prefetch(url)` | Hands off to the content plane; does not block the budget |
| `badge.set(n)` | Integer, clamped |
| `notify.local(title, body)` | Rate-limited per run |
| `dsx.event(name, payload)` | Queued for the page, drained on next open — the existing channel |

**No dynamic dispatch.** No `dsx.module[expr]`, no eval of a verb name from the document.
The verb table is compiled into the binary; a document naming an unknown verb fails
closed with a ledger entry rather than degrading to something clever. This is not only a
safety property — it is the compliance argument in §7.

---

## 5 · Bounds, because this runs where nobody is watching

iOS grants roughly 30 seconds for a background-notification handler; Android's is
different and Doze-dependent. A workflow that overruns is killed mid-flight by the OS,
which is the worst failure mode: partially applied state and no report.

- **Wall clock:** native ceiling (target 20s, under the OS budget), non-negotiable from
  the document.
- **Statements:** the existing loop budget and the depth-32 action cap already make the
  grammar terminating; they carry over unchanged.
- **Requests:** capped per run, and every request individually timed out.
- **Writes are transactional per run.** Either the run's store writes commit or none do.
  A workflow killed at 19.9s must not leave a half-applied cursor, because the next run
  would then sync from a position that never happened.

---

## 6 · Trust — signing is mandatory, and it already exists

A document fetched over the network and executed natively is a remote-code-execution
vector if unsigned. This is the single most dangerous part of the proposal and it gets no
"v1 will add it" treatment: **an unsigned workflow never runs.**

The framework already signs remote bundles with Ed25519 — that is precisely why
`Core/LegacyCrypto` exists as an availability floor (Android 24–32 has no platform Ed25519
provider, so a device there would otherwise fail every signature closed and never take an
update). Workflows reuse that path: same key material, same verification, same failure
semantics. Nothing new is invented, which is the point.

---

## 7 · Store compliance — the reason the allowlist is closed

Executing remotely-hosted logic natively sits near Apple's DPLA §3.3.2 line. The
distinction that matters in practice:

- **Data-driven interpretation with a fixed verb set** is well-trodden and ships
  everywhere (remote config, feature flags, server-driven UI).
- **A general-purpose interpreter with open native reach** starts to look like a
  code-delivery platform, which is the thing that gets rejected.

So the closed allowlist, the absence of dynamic dispatch, and the refusal to expose the
module bus are not merely defensive engineering — they are what keeps this configuration
rather than a runtime-within-a-runtime. The workflow may not change the app's primary
purpose, and the verb table is the mechanism that guarantees it cannot.

---

## 8 · Observability

A workflow that fails at 3am with nobody watching is worse than one that never ran. It
reports into the **existing** primitives, never a bespoke channel: `dsx.log` → the log
ring (cap 500), `dsx.error` → the error ledger (ring 128), both surfaced on next open and
in the DevSettings drawer on test installs (`error-system.md`). Each run additionally
records a compact receipt — id, version, trigger, duration, verb counts, outcome — so
"did last night's sync actually run" is answerable without a debugger.

---

## 9 · The v3 backport

This is the part that is real work, and it is a **port of tested code**, not an invention:

1. Vendor `JSERunner` (`OpenSource/Engine/iOS/Stack.swift`) into d-ios, and the Kotlin
   `:core` runner into d-android. Both arrive with the shared corpus, which becomes the
   legacy apps' test suite on day one.
2. Wire the trigger: `SilentPushManager.handle` already owns the wake. It gains "if a
   signed workflow is present and its `on` includes `push.silent`, run it inside the
   budget" — ahead of the queue-for-the-page behaviour, which stays exactly as it is.
3. Ship the verb table (§4) against the legacy apps' existing native surface.
4. Gate it. A workflow runner is a capability like any other and follows the same law as
   everything else in this session: excluded by default, opt-in per app.

v4 gets the same document through the module path, where the verb set can be wider
because a module can legitimately reach the bus.

---

## 10 · Fixtures first — the law this must satisfy

The constitution's unified-codebase law: *new authoring surface ships on all three
renderers, fixtures first, or it doesn't ship.* A hosted workflow document is new
authoring surface, so the order is fixed and not negotiable:

1. `OpenSource/Conformance/workflows/` — platform-neutral corpus: envelope validation,
   version-downgrade refusal, budget exhaustion, verb allowlist rejection, transactional
   rollback, unsigned refusal.
2. TS kernel (per-PR).
3. Kotlin twin (gradle-gated).
4. Swift twin (compile-pending, rides the record lane).

The async verbs need their own corpus seam since the actions corpus is synchronous by
construction — expect a fixture harness with a scripted network, not live requests.

---

## 11 · What this is NOT

Worth stating so it is not sold as more than it is:

- **Not a reliable background job runner.** APNs and FCM throttle silent pushes hard,
  Apple guarantees no delivery, and an iOS app the user force-quit receives none at all.
  This is "warm the app when the OS lets us," and the docs must say so.
- **Not a way to run your page's JavaScript in the background.** Nothing is. The document
  is native-executed; page code still runs only when the page runs.
- **Not a general native scripting surface.** The verb table is closed on purpose (§7),
  and requests to "just expose the module bus" should be refused on compliance grounds,
  not convenience.

---

## 12 · Open questions

1. **Authoring.** Customers write JSE bodies as strings in JSON. Acceptable for v0, but a
   `<workflow>` markup form compiling to this document is the obvious follow-on — and
   would make v4 authoring identical to every other DSX surface.
2. **Host allowlist origin.** Per-app config, or derived from the app's existing content
   root? The second is tighter and needs no new field.
3. **Multiple documents.** One per app, or a set keyed by `on`? A set is more flexible and
   strictly more to verify; v0 should probably take exactly one.
4. **AOT.** `jse-platform.md` proposes compiling bodies once instead of re-walking them.
   A wake window with a hard ceiling is the strongest argument for that work, and this
   proposal should not pre-empt its design.
5. **Android divergence.** Doze and background-execution limits differ enough from iOS
   that the budget may need to be per-platform rather than one number. Needs device
   evidence before it is pinned.
