# facets/ — the facet resolution-ladder corpus

`facet-contracts.md`'s staged runtime phase executed as fixtures: **a call resolves
local → declared `reach` over the link → typed unavailable**, at each runtime's ONE
dispatch funnel. The caller never spells the route, so the same markup ships on every
surface and moving an action between facets changes no call site.

`facets.json` carries the law in its `_note`, one synthetic build (`world`: the compiled
per-facet capability table, the build-excluded overlay, the platform catalog) and the
resolution cases — each case is that same build seen from a different **facet word**.

## The frozen answers

The ladder returns one of three rungs. `local` and `reach` carry no code; `unavailable`
carries exactly one of the six frozen spellings, and the reason **is** the code
(durability.md P4):

| Code | Means |
|---|---|
| `unknown_action` | the module IS here, the action is not — a caller bug, never absence |
| `unsupported_platform` | never on this facet (the row neither `provides` nor `reach`es it), or the platform catalog's X-tier |
| `excluded` | this build dropped the chain — the `DespiaExcluded` entry rides verbatim as data |
| `prerequisites_missing` | the row PROMISES a local implementation here and nothing stood it up |
| `unreachable` | `reach` admits this facet but no transport is installed (or the transport failed) |
| `not_loaded` | nothing known at all |

`never_on_facet` is **retired grammar** — durability.md P4 kept `unsupported_platform`,
which already meant exactly this on the wire ("never repurpose a kept name" is P5's own
law). The corpus records the mapping in its `retired` block so a runner can assert the
draft spelling never appears.

Precedence is frozen by the shipped funnels: `local > reach > unknown_action >
unsupported_platform > excluded > prerequisites_missing > not_loaded`.

## The empty seam

A runtime that binds **no** facet word, with an empty table, answers exactly what the
funnels answered before this ladder existed — every facet-dependent rung is skipped.
That is the property that lets the ladder land in kernels whose builds have no facets
yet, and the last four cases pin it.

## Scope — what this corpus does and does not pin

Cases state the call as `chain/action` **directly**, so the ladder is gated independently of
each runtime's identity FOLD (`Conformance/chains`). That separation is deliberate, and it
also marks a real edge the ladder inherits rather than introduces: a runtime's identity set
is *registered chains ∪ build-excluded chains*, so a **nested** chain that is remote-only —
no local module, not excluded, reachable only over a link — does not fold today and arrives
as an action path on its parent. The generated client-link table has exactly the same edge
(`LinkSeam.routes` is keyed by the folded chain), so it is pre-existing. Closing it means
widening the identity set to include capability-table chains on all three runtimes **and**
in the frozen `chains` corpus `_note` — one change, three runners, its own slice. Until then
a remote-only chain must be depth-1 (which every shipped one is).

`linked` (the client-link rung) is likewise not asserted here: it is a web-only transport
today, so a platform-neutral corpus cannot pin it. `bus.ts`'s own link tests cover it.

## Runners

| Runtime | Runner |
|---|---|
| **TS** (per-PR, `web-kernel` lane) | `OpenSource/Web/packages/kernel/test/facets-conformance.test.ts` — the pure ladder (`resolveFacetLadder`, `bus.ts`) on the corpus world, plus the live funnel end-to-end through `FacetSeam` |
| **Kotlin `:core`** (per-PR, `android-kernel` lane) | `Engine/Android/core/src/test/kotlin/despia/engine/FacetsConformanceTest.kt` — the same pure ladder (`FacetLadder`, `Facets.kt`) plus the `Context` funnel integration |
| **Swift** | **NOT IMPLEMENTED.** No Swift runner loads this corpus yet — the same position `chains/` was in before its record-lane runner landed. When one lands it goes beside the other expectation corpora in `ClosedSource/scripts/conformance/RecordMain.swift` |

Every cross-runtime divergence bug becomes a fixture here in the same commit as its fix.
