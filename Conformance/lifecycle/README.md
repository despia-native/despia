# Screen-lifecycle conformance — the surface-agnostic loading/ready model

Two fixtures pin the whole of `OpenSource/Documentation/reference/screen-lifecycle.md` — the shell's
ONE loading/ready vocabulary (`screen.loading` / `screen.ready` + `global.screen.phase` /
`global.screen.ready`) and, new here, the **native reporter** that makes it true at runtime
instead of only structurally.

| File | Pins | Executors |
|---|---|---|
| `readiness.json` | the NATIVE reporter: a frame's `surface.viewStart` / `surface.viewFinish` state machine (default settle-on-first-render, opt-in defer, the hybrid `<DSXWebView/>` gate, the bounded settle deadline) | TS `packages/kernel/test/lifecycle-conformance.test.ts` → `src/screen.ts` · Kotlin `:core ScreenReadinessTest` · Swift `DSXScreenReadiness` (record lane) |
| `phase.json` | the COORDINATOR: `dom*` (web) **and** `view*` (native) → the unified `screen.*` fires + state | Swift `Mandatory/Lifecycle/swift/Lifecycle.swift` · Kotlin `…/kotlin/Lifecycle.kt` · TS `packages/kernel/src/screen.ts` |

## Why this corpus exists

The unified vocabulary already existed and every consumer already spoke it — but **only the web
surface reported**. `Lifecycle` hooked the Dom relay's `surface.domStart`/`surface.domFinish`/`surface.domFail` and nothing
else, so on a host-less native app no page ever loaded and `screen.ready` **never fired**: the
splash never revealed, `ScreenShield` never armed, `Engagement` never ran, `PostHog` tracked no
route. screen-lifecycle.md's closing section, *"Adding a native (`DSXView`) reporter — the additive
follow-up"*, was an explicit unimplemented TODO. This corpus is that follow-up, fixtures first.

## The two planes, and why they are two files

```
   the frame render layer                    the shell
   ──────────────────────                    ─────────
   mount / manual / rendered / settled  ──►  surface.viewStart · surface.viewFinish ──►  screen.loading · screen.ready
        (readiness.json)                          (phase.json)           global.screen.phase / .ready
   WKWebView / WebViewClient callbacks   ──►  surface.domStart · surface.domFinish · surface.domFail  ──►  (same)
```

`dom*` stays the **web** surface's private signal and `view*` is its **native sibling** — same
shape, same guard, same translation. Only the coordinator (and the documented web-DOM modules,
per screen-lifecycle.md) may hook either. **Every consumer keeps hooking `screen.*` and changes
nothing** — that is the whole point, and the reason this lands as a corpus rather than a patch.

## The authoring surface these fixtures gate

| Spelling | Plane | Means |
|---|---|---|
| *(nothing)* | default | the screen settles on its **first completed render pass** |
| `settle="manual"` | root-element attribute (root only, like `exit`) | this screen reports readiness **itself** |
| `dsx.screen.settled()` | JSE verb, any handler / action | "this screen has settled" — fires `surface.viewFinish` once |

Two machine behaviors are deliberately **not** authorable, because both exist to make wrong or
missing authoring harmless:

- **The hybrid gate.** A native frame that mounts a `<DSXWebView/>` app web surface registers `hostsWeb`
  from the COMPONENT and waits for that surface's own settle (`webSettled`, fed by the relay's
  `surface.domFinish`/`surface.domFail`). Without it the frame settles on first render, so Splash reveals over a
  blank web view and `surface.domStart` re-opens the phase a beat later. Unchanged markup must get the right
  order — this is a regression fix, not a feature.
- **The bounded deadline.** `settleDeadlineMs` (10 000) is armed BY THE MACHINE at `mount` and
  cancelled on settle/release; when it elapses the frame settles anyway (Article 7, fail-open). It is
  the runtime half of the `settle="manual"`-without-`dsx.screen.settled()` mistake; `lint_dsx.rb`
  is the build-time half and reports that file as an ERROR.

`settle` is the same word screen-lifecycle.md already uses for the concept ("a surface **settled**");
`dsx.screen.settled()` is a **call** and never collides with the existing reactive **property**
`dsx.screen.ready` (Bool) or `dsx.screen.phase` (String), which stay read-only state.

`dsx.screen.settled()` on a screen that never declared `settle="manual"` is harmless — it settles
the auto screen a beat early and the later first-render tick is a no-op (`readiness.json`, *"an
explicit settle wins over the pending first render"*).

## Ordering requirement on the renderers (not expressible as a fixture step)

The step list in `readiness.json` is explicit, so the machine is deterministic; wiring it correctly
requires one guarantee from each renderer:

- `manual` is registered during the frame's **first render pass** (head hoisting — `settle` is a root
  attribute, so it is known the moment the root node is read);
- `hostsWeb` is registered during that same pass, by `<DSXWebView/>` itself as it builds the surface;
- `rendered` is reported on a turn **strictly after** that first render pass completes (iOS: an
  `onAppear` + main-queue hop; Android: a `LaunchedEffect(frameId)`; web: a microtask after mount);
- `webStart` / `webSettled` are fed from wherever the renderer fires `surface.domStart` / `surface.domFinish`+`surface.domFail`
  for the APP surface (native: the `Dom` module's own hooks; the web renderer has no hosted web view
  at all, so it never reports them — the browser document *is* the host).

The deadline needs no wiring: the machine arms it inside `mount`, so a renderer cannot forget it.
Each executor stubs the timer seam and drives the `deadline` step directly, and additionally asserts
its constant equals the corpus `settleDeadlineMs` — the fail-open must degrade IDENTICALLY on all
three renderers or it is not a law.

A `manual` that arrives after the frame already settled is a no-op by design — it can never re-open
a settled frame (`readiness.json`, *"manual registered after the settle never re-opens the frame"*).

## Related corpora

- `../router/boot.json` — which source owns the ROOT frame (route table vs. the App.json entry
  fallback). A host-less native app cannot report readiness for a screen it never booted to, so the
  boot rule and the readiness rule ship together.
- `../platform/platform.json` — target identity; `../router/resolve.json` — route resolution.
