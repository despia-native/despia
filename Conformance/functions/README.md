Global-function-library conformance (the `<functions global="true">` head block) — fixtures BEFORE
the wiring ships on any platform.

The GLOBAL FUNCTION LIBRARY (js-core.md "Shared logic — the global function library") is ONE
app-wide `function name(){…}` table shared by every surface. The kernel API landed ×3 first
(`JSE.registerGlobalFunctions(body)` / `JSE.clearGlobalFunctions()` — TS `jse/jse.ts` · Kotlin
`Jse.kt` · Swift `JSE.swift`); this corpus pins the MARKUP-level integration point beside it:

  `<functions global="true"> function tax(n) { … } </functions>`   — the app-wide block
  `<functions> … </functions>` / `<script> … </script>`             — the surface-local block

The `global` attribute's PRESENCE routes the block to the app-wide table (the canonical spelling is
`global="true"`; a bare `global` also parses on renderers whose DSX parser accepts bare attributes —
Apple's XMLParser does not, so author the valued form). Everything else is pinned here:

- **Shadowing order at a named call** `f(x)`: scope lambda → the surface's own function table
  (a surface-local name SHADOWS the global) → the global table → builtins (a global SHADOWS a
  builtin). Same `fnDepth` 32 recursion guard as every user function.
- **Last write wins**: a later `global` block re-registering a name replaces it.
- **No scope capture**: global functions are not closures — free names resolve against the
  CALLING surface's live store at call time (case `global-reads-the-calling-surfaces-live-store`).
- **Callable everywhere JSE runs**: expressions AND action statement bodies
  (case `action-body-calls-a-global-function` rides the actions runner).

`functions.json` case shape (the actions-corpus shape + `blocks`):
  { name, blocks: [{ global?: true, body }], actions, scope, run, runItem?, expectStore, expectEvents }
- `blocks` — the document's `<functions>`/`<functions global="true">` head blocks, mounted IN
  DOCUMENT ORDER: `global: true` → `JSE.registerGlobalFunctions(body)`, else →
  `JSE.registerFunctions(body, store)` (the per-surface table).
- the rest is byte-identical to `../actions/README.md` (`run` is the entry handler; `expectStore`
  dot-path assertions; `expectEvents` the ordered `dsx.event` names).
- Runners CLEAR the global table between cases (`JSE.clearGlobalFunctions()` — the app-reload
  contract; the table is process-static by design).

Runners:
  · TS: OpenSource/Web/packages/kernel/test/function-conformance.test.ts (per-PR, web-kernel lane).
    The compiler/mount routing (`<functions global="true">` → `head.globalScripts` →
    registerGlobalFunctions in @despia/dom instantiate + @despia/server renderInstance) is pinned by the
    compiler/dom/server suites beside it.
  · Kotlin: Engine/Android :core FunctionConformanceTest (per-PR, android-kernel lane), mounting
    blocks through the :core head seam `StackStore.registerHeadFunctions(attrs, body)` — the same
    routing the app renderer's head dispatch calls.
  · Swift: `JSE.registerGlobalFunctions` + the Stack.swift head mount (`StackHead.register` and the
    render-path `"script", "functions"` case route on the `global` attr) are the reference.
    Corpus EXECUTION rides the conformance-record lane (ConformanceHosts.swift) once that host
    grows a functions leg — manual-trigger, needs a Mac; until that run, the fidelity anchor is
    the Kotlin twin, exactly the actions-corpus arrangement.

Synchronous only (function bodies are expression blocks — branches, no loops), so every runtime
completes each case deterministically. The recursion case asserts CONTAINMENT (`?? 'contained'`),
never a frame count — the 32 guard is a safety net, not a contract.
