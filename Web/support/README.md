# DSX Web element support ledger

[`element-support.json`](element-support.json) is the release-facing inventory for every
canonical element fixture and alias in `OpenSource/Conformance/elements/`. It answers one
narrow question: does the built-in Web renderer provide a functional implementation for
this spelling today?

The statuses are deliberately stricter than “does markup avoid crashing”:

- `supported` means the primary rendering and interaction contract is implemented;
- `partial` means a real Web control exists, but listed fixture behaviors remain open;
- `unsupported` means the runtime intentionally shows its explicit unsupported fallback.

**Zero silent gaps.** Every non-supported row additionally carries a machine-readable
`fallback`: the deliberate degraded UX the DOM renderer shows for the missing behavior,
the functional twin a `partial` still mounts, or the labelled `dsx-unsupported` placeholder
an `unsupported` surface renders. `element-support-ledger.test.ts` both REQUIRES that field
and RENDERS it (the unsupported placeholders through the real mount dispatch, the flips
through their factories), so a future partial/unsupported row that ships without a declared,
honest fallback fails the gate.

Current inventory, read from the ledger's own generated `summary` block: **60 of 79
canonical elements supported, 7 partial, 12 unsupported** (plus 11 of 15 aliases supported,
0 partial, 4 unsupported), so **71 of 94 names supported overall**. Regenerate the numbers
rather than retyping them:

```sh
ruby -rjson -e 'puts JSON.pretty_generate(JSON.parse(File.read("OpenSource/Web/support/element-support.json"))["summary"])'
```

The 18 non-supported canonical rows are three groups and nothing else:

| Group | Rows | What ships instead |
|---|---|---|
| Declared platform adaptations (`partial`) | `chart`, `lightbox`, `map`, `wheelpicker` | a functional control with the missing behavior named in its `limits`, never a blank surface |
| Nested app surfaces (`partial`) | `WebView`, `DSXWebView`, `DSXView` | the policy-constrained iframe / compiled-registry host; bridge-dependent behavior is absent rather than imitated |
| No web equivalent worth faking (`unsupported`) | `Scene3D`, `Scene360`, `Godot`, `StudioTimeline`, `StudioTrim`, `StudioPitchEditor`, `StudioShow`, `StudioTimecode`, `Waveform`, `LevelMeter`, `lottie` | the labelled `dsx-unsupported` marker carrying the element's own name |

`lottie` is the one row that is not permanent: it is a MODULE element, and registering the
`Core/Lottie` web facet (the vendored MIT player, pinned) fills the tag.

Three universal attributes are also inert on web and carry rows for it: `exit` (root-only
dismiss motion, deferred to the router's motion lane; `enter` covers appear) and the
`dynamicType` / `dynamicTypeMax` pair (the OS text-size ramp has no per-element web
equivalent, and rem-based sizing already follows browser text scaling).

The reader-facing version of all of this is
[`Documentation/guides/platform-support.md`](../../Documentation/guides/platform-support.md),
which also states what native fidelity is and is not proven to be.

Platform-adaptive Web chrome is not itself a parity failure. Silent attributes, missing
aliases, or substituting a generic browser element for a larger DSX media/Studio contract
are. `chart`, `lightbox`, `map` and `wheelpicker` have functional but deliberately partial
Web contracts; their exact limits are recorded in the ledger rather than called red.

`packages/dom/test/element-support-ledger.test.ts` is the inventory/registry gate: it fails
when a fixture or alias is added, removed, duplicated, miscounted, or disagrees with the
registered full-application DOM factory set. Factory presence alone is not behavioral
proof. Each supported behavior is pinned in the focused compiler/DOM/server tests and,
where layout or platform CSS matters, a locked real-browser oracle. Changing a status
therefore requires the implementation, those focused gates, and an updated reason/limits
entry in the same change.

This ledger does not certify pixel identity, browser-version qualification, SSR hydration,
or physical-device behavior. Those remain separate release gates.
