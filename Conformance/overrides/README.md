# overrides/ — the style-override corpus

The component STYLE contract: attributes carry a component's data, overrides carry its
styling knobs. A component declares them in its head:

```xml
<override as="radius" type="length" default="12" min="0" max="48"/>  <!-- corner radius -->
<override as="tint"   type="color"  default="accent"/>
<override as="glass"  type="boolean" default="true"/>
```

a consumer sets them on the usage tag — literal, bound, or platform-suffixed:

```xml
<Card override:radius="6" override:tint="{{ dsx.global.theme.brand }}" override:glass:ios="false">
```

and the component's own markup spends them at any depth:

```xml
<stack radius="{{ dsx.override.radius }}" background="{{ dsx.override.tint }}">
```

Nothing auto-applies. Declaring an override does nothing until the component's markup reads
it — that explicitness is what keeps the contract enumerable (the editor lists exactly the
declared knobs) and the pixels owned by the component author.

`style-overrides.json` carries three pure laws in its `_note`, each a section:

| Section | The law |
|---|---|
| `split` | which usage-site attributes ARE overrides (`override:<identifier>`), and that a matched key leaves the props plane entirely |
| `resolve` | what a declared override is worth given a raw value — typed, fail-open coercion with default fallback and min/max clamping |
| `read` | what `dsx.override.<name>` returns: item `__overrides` (tag door) → store `dsx.override` var (mount/update door) → declaration default; undeclared reads null |

The type vocabulary is the style catalog's control set (`number · length · enum · multiEnum ·
color · gradient · ratio · boolean · text`) plus `css` (a raw declaration list for
`style="{{ dsx.override.x }}"` consumption). The `reserved` list pins the names an override
can never have: the platform-suffix fold (`Conformance/platform/platform.json`) consumes them
before the split ever runs.

| Runner | Reads | Runs |
|---|---|---|
| TS | `OpenSource/Web/packages/kernel/test/style-overrides-conformance.test.ts` | per-PR (`npm test`) |
| Kotlin | `:core StyleOverridesConformanceTest` | per-PR (`gradle test`, SDK-free) |
| Swift | `StyleOverridesConformance` (`OpenSource/Engine/iOS/StyleOverrides.swift` + `StyleOverridesConformance.swift`) | per-PR via `ClosedSource/scripts/swift_conformance_run_test.rb` (Apple-free), and `RecordMain.swift` on the record lane |

The renderer wiring above the pure laws (the usage-site split at each component mount, the
reactive re-seed, SSR) is asserted behaviorally per renderer:
`packages/dom/test/style-overrides.test.ts` + `packages/server/test` on web, the `:core`
conformance suite plus the render-layer component path on Android, and the Swift twin through
the record lane. Authoring guide: `OpenSource/Skills/style-overrides.md`; the law:
`OpenSource/Documentation/architecture/proposals/style-overrides.md`.

Every cross-runtime divergence bug becomes a fixture here in the same commit as its fix.
