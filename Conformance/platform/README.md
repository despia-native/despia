# platform — identity + attribute-suffix fold

One fixture file, `platform.json`, every runtime resolves it (the corpus `_note` carries
the law). Two sections:

- **`fold`** — the attribute-suffix resolution: precedence `exact > :desktop > :native >
  bare`, group membership from `targets.groups`, unrecognized suffixes untouched. Each
  case's `expect` is keyed by target; a runner asserts every target it can represent
  (the TS runner asserts the full matrix through the generic resolver; the web compiler
  additionally IS `resolve(attrs, "web")`; native renderers pin their own compile-time
  target and the record lane pins the Swift reference).
- **`identity`** — `dsx.platform.os` → derived `native` / `desktop` constants
  (`/web/14`; `embed` is the web separate-artifact seam, asserted in the TS runner only).
- **`nodes`** — deployment identity stays `ios`/`android` on wrist satellites while
  the attribute fold targets exact `watch`/`wear`; phone rows pin the no-override case.

Runners: TS `packages/compiler/test/platform-conformance.test.ts` +
`packages/kernel/test/platform-conformance.test.ts` · Kotlin `:core`
`PlatformConformanceTest.kt` · Swift `Stack.swift` `resolvePlatform` (reference).

Adding a target = a row in `targets.exact` (+ group membership) + token columns in
`defaults/tokens.json` + a runner column. Never a markup dialect.
