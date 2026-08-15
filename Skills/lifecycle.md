# Lifecycle guarantees — every resource × every transition

> Timers and sockets being surface-scoped is not a convention, it's a contract. This doc
> states the contract for EVERY resource JSE/DSX can hold, across every app transition —
> from the code, not from intent. If a behavior below doesn't match the engine, that's a
> bug in the engine.

## The three laws

1. **Surface-scoped by default.** A resource created by a surface (timers, intervals,
   WebSockets, watches, sheets, video players) dies when the surface's store deallocates
   — route changes, dismissals, and overlay removals can never leak.
2. **Orphan completions are safe no-ops.** Work that was already in flight when the
   surface died (a fetch, a module call, a crypto derive) completes against the orphaned
   store: the writes land in memory nobody renders, then the store frees. No crash, no
   ghost UI, no special cancellation code required.
3. **Background means suspended, not running.** Core resources don't execute in the
   background — they pause and reconcile on return. Anything that must truly run in the
   background (push-driven sync, long-lived realtime, audio continuation) is a
   **module** with the OS entitlement that makes it honest.

## The matrix

| Resource | Surface dismissed / route change | Overlay removed (`ui.remove`) | App backgrounds | App returns | Process killed |
|---|---|---|---|---|---|
| `dsx.variable.*` state | Freed with the store | Freed | Held in memory | Unchanged | **Gone** (in-memory only — persistence is a module choice, e.g. the player's `UserDefaults` access cache) |
| `dsx.global` shared state | Survives (app-lifetime store) | Survives | Held | Unchanged | Gone unless a module persisted it |
| `setTimeout` / `setInterval` | **Cancelled** (`StackStore.deinit`) | **Cancelled** | Don't fire while suspended | Pending timeouts fire (late, coalesced); intervals resume their cadence | Gone |
| `WebSocket` | **Closed** (`deinit` closes every socket) | **Closed** | Task suspends; the OS may kill it | `onclose` fires (code 1006 path) — your reconnect (`onclose` → keyed `setTimeout`) runs | Gone |
| In-flight `await fetch` | Completes → orphan no-op (law 2) | Same | URLSession continues briefly / suspends with the process | Continuation runs on return if still queued | Gone (no resume) |
| In-flight `await dsx.module.…` | Resolve/error lands → orphan no-op | Same | Module-dependent (the handler owns it) | Continuation runs | Gone |
| In-flight `await crypto.subtle.…` | Computes → orphan no-op | Same | Utility queue suspends with the process | Completes on return | Gone |
| `Promise.all/race/…` | Each element follows its own row above; the combinator settles as an orphan | Same | Same | Same | Gone |
| `AbortController` flags | Process-global — `abort()` still discards a late settle | Same | Held | Held | Gone |
| `<watch>` / computed | Part of the store — freed | Freed | Inert (no renders while suspended) | Recompute on next render | Gone |
| `<sheet>` / drawers | Dismissed with the presenting surface | Dismissed | System-managed | Restored by the system | Gone |
| `<video>` (AVPlayer) | Coordinator dismantled: observers removed, preview tmp files cleaned, PiP stopped, NowPlaying widget cleared | Same | Pauses — unless `pip="true"` and playing (OS picture-in-picture takes over) | Resumes per `paused` state | Gone |
| `audio="playback"` session | Refcounted — **released with `.notifyOthersOnDeactivation`** when the last claiming video unmounts (the user's music resumes) | Same | OS policy | Reclaimed on play | Gone |
| Keyed resources (timers, sockets) | n/a | n/a | n/a | n/a | **Same key = replace** — a re-run can never double-arm or double-connect |

## Transition notes

- **Route change ≡ dismissal.** Routing presents/dismisses surfaces; there is no special
  route path — the store deinit IS the cleanup. If a surface survives a route change, it
  was retained on purpose (an overlay you chose to keep).
- **Offline** is not a lifecycle event: `fetch` settles `{ ok:false, error:"network" }`,
  sockets fail → `onerror` + `onclose`, and `navigator.onLine` (NWPathMonitor) is the
  branch point. Nothing queues automatically — offline queues are a module concern
  (PowerSync-class).
- **Restore after process death:** DSX state is in-memory by design. What survives:
  whatever modules persisted (`UserDefaults`, the container, storage modules) and
  server truth. The reconcile-on-start pattern (seed → `refreshAccess`-style poll) is the
  house answer — the player module is the reference implementation.
- **Hot reload / remote DSX refresh** mounts a **new surface** (new store). It composes
  with law 1: the old surface's resources die with it; keyed sockets in the NEW surface
  replace any same-key stragglers. There is no in-place patching of a live store.
- **Module "unload" doesn't exist** at runtime — modules are process-lifetime,
  excluded at build time (`excluded.json`). A call to an excluded module is
  `{ ok:false, error:"unavailable" }` / a typed throw, forever.

## What this means for authors

- Don't write cleanup code for timers/sockets/watches — you can't do it better than
  `deinit`, and `on:disappear` cleanup is a smell (the engine already does it).
- DO key your sockets and debounce timers (`{ key }` / the third `setTimeout` arg) —
  replacement-by-key is what makes re-entrant actions safe.
- Treat backgrounding as a hard stop for core transport: design `onclose` reconnects and
  on-foreground refresh (`dsx.hook("enterForeground")` on the native side, or a
  `dsx.module.self.refresh` poll) rather than pretending the socket survived.
- If a feature NEEDS background execution, it needs a module and an entitlement —
  that's the boundary rule, not a workaround.
