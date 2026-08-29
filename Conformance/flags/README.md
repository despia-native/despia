# flags — the feature-flag plane

`plane.json` pins the pure fold behind `Core/PostHog`'s flags plane: how one evaluated flag
becomes what an app sees, on all three renderers.

Three lanes receive a flag three different ways:

| lane | source | payload arrives as |
|---|---|---|
| Swift | `PostHogSDK.getAllFeatureFlags()` → `PostHogFeatureFlagResult` | decoded |
| Kotlin | `PostHog.getAllFeatureFlags()` → `FeatureFlagResult` | decoded |
| TS/JS | `POST <host>/flags?v=2` per-flag envelope | a **JSON-encoded string** under `metadata.payload` |

What they must agree on is in three sections:

- **`fold`** — `value = variant ?? enabled`, a variant is always enabled, and the payload is the
  decoded JSON whatever its type (object, array, scalar, or an unparseable string passed through).
- **`absence`** — the three states an unreadable flag can be in. `known:false` (this project has no
  such flag) is terminal; `flags_pending` (the first evaluation has not landed) clears itself. Both
  are `enabled:false` in PostHog's own SDKs, which is how a typo'd flag key ships the control arm
  forever without anyone finding out.
- **`exposure`** — the `$feature_flag_called` dedupe key, `(flag, value, session)`. Experiments are
  computed from this event, so re-counting it on every re-render skews the result it measures.

Consumers: `ClosedSource/DSX/Modules/Core/PostHog/` — `web/index.js` (`foldFlag`),
`swift/PostHogBridge.swift` (`flagRow`), `kotlin/PostHogBridge.kt` (`flagRow`).

**Runner status.** The lanes that implement this fold are closed module facets, which the open web
test suite cannot import from `OpenSource/`. Today the corpus is executed against the JS lane by the
module harness recorded in `ClosedSource/Documentation/v4-launch/completeness/FEAT-analytics.md`;
wiring it as a standing per-PR gate is one file in `OpenSource/Web/packages/dom/test/`, named there.
