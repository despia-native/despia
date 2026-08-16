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
`fallback`: the deliberate degraded UX the DOM renderer shows for the missing behavior —
the functional twin a `partial` still mounts, or the labelled `dsx-unsupported` placeholder
an `unsupported` surface renders. `element-support-ledger.test.ts` both REQUIRES that field
and RENDERS it (the unsupported placeholders through the real mount dispatch, the flips
through their factories), so a future partial/unsupported row that ships without a declared,
honest fallback fails the gate.

Current inventory: **52 of 76 canonical elements supported, 11 partial, 13 unsupported**
(plus 10 of 15 aliases supported, 1 partial, 4 unsupported) — 62 of 91 names supported
overall. `list` was the last canonical row the element-closure wave left open, and it is
now `supported`: `group_by`, the swipe rails, drag reorder, `on:move` and the `autoscroll`
marquee all ship in the bound reconciler AND in the SSR twin. The remaining partial and
unsupported rows are the native nested-app, Studio/audio-analysis, 3D/Godot/360 and Lottie
surfaces (unsupported by design) plus the declared platform adaptations, each with its
reason, limits and fallback in `element-support.json`.

Platform-adaptive Web chrome is not itself a parity failure. Silent attributes, missing
aliases, or substituting a generic browser element for a larger DSX media/Studio contract
are. Native nested-app surfaces, Studio/audio-analysis tools, 3D/Godot/360, and Lottie
remain unsupported. SVG, lightbox, and DSX audio/video have functional but deliberately
partial Web contracts; their exact limits are recorded in the ledger rather than called red.

`packages/dom/test/element-support-ledger.test.ts` is the inventory/registry gate: it fails
when a fixture or alias is added, removed, duplicated, miscounted, or disagrees with the
registered full-application DOM factory set. Factory presence alone is not behavioral
proof. Each supported behavior is pinned in the focused compiler/DOM/server tests and,
where layout or platform CSS matters, a locked real-browser oracle. Changing a status
therefore requires the implementation, those focused gates, and an updated reason/limits
entry in the same change.

This ledger does not certify pixel identity, browser-version qualification, SSR hydration,
or physical-device behavior. Those remain separate release gates.
