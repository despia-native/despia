# inline-surfaces/ — the INLINE VENDOR SURFACE core

> The law: `Documentation/architecture/proposals/inline-native-surfaces.md`.
> Build log: `ClosedSource/Documentation/v4-launch/parity/V01-stripe-inline.md`.

**A capability that has a UI exposes it as an inline DSX component, not only as a presented
overlay, and the module owns the session: the overlay face and the component face are two
views onto one state machine, never two integrations.**

`stripe.json` pins that law against the hardest vendor first. If the pattern survives
payments it survives anything, so payments is the exemplar rather than the last case.

| Section | What it pins |
|---|---|
| `sessionRef` | **The security boundary.** What a component attribute declared `role: "secret"` may carry. The rule is an ALLOWLIST OF REFERENCE SHAPES, never a denylist of key prefixes: a denylist is bypassed by whatever key format a vendor ships next quarter, an allowlist fails closed. Real-looking `pk_live_` / `sk_` / `rk_` / `whsec_` / `ek_` / `pi_..._secret_` / `seti_..._secret_` values are refusals, and so is a literal nobody would recognise as a key. The detected family only sharpens the message. |
| `machine` | **One session, two views.** A second attempt while one is in flight is refused `busy` (the double-charge guard); an outcome notifies BOTH faces, including one that already detached mid-confirm; detaching never cancels; a dismissed sheet cancels the ATTEMPT and leaves the intent reusable, while cancelling with nothing in flight abandons the SESSION and that is terminal. |
| `cardField` | **The field-validity fold.** The vendor's per-part verdicts folded into ONE `<form>` field, so a vendor input joins validity through the same aggregation `<field>` uses. The folded value is a sentinel (`complete` / `""`) and never card data. |
| `retain` | **Keyed identity.** The `SceneBind` law applied to an expensive, stateful vendor view: same key = same live view across reorder and unrelated re-render. The key derives from the session's REFERENCE, never its value, because keys land in diff logs. |

Three runners, one file: `@despia/kernel` `vendor-session.ts`
(`packages/kernel/test/vendor-session-conformance.test.ts`), `:core` `VendorSession.kt`
(`VendorSessionConformanceTest`), and the Swift reference `Engine/iOS/VendorSession.swift`.

The folder is named for the LAW, not for a vendor: `stripe.json` is the first file in it, and
the sections above are the contract every later vendor component (`stream.CallView`,
`clerk.SignIn`, `admob.Banner`, `revenuecat.Paywall`, `scanner.Preview`) is judged against.
It deliberately does not vendor anything; the OSS core carries no third-party source.

## The family, V02 to V06

`stripe.json` proved the law; these five apply it. Every one of them runs its `sessionRef`,
`machine` and `retain` sections through the SAME core `stripe.json` pins
(`vendor-session.ts` / `VendorSession.kt` / `VendorSession.swift`), which is the point: five
vendors, one session machine. What the family needed and V01 did not have is a sibling pure
core, `vendor-surface.ts` (+ `VendorSurface.kt` / `VendorSurface.swift`), and every fold in it
is judged here.

| File | Vendor sections beyond the shared three | The fold it pins |
|---|---|---|
| `stream.json` | `gate`, `roster` | the live-surface permission ladder; call tile order and grid columns |
| `clerk.json` | `ladder` | one rung of a vendor sign-in attempt, and what it puts on screen |
| `admob.json` | `slot`, `request` | IAB slot geometry (adaptive stays the SDK's answer); the consent policy gate |
| `revenuecat.json` | `paywall` | package order, default selection, and a savings badge only where the comparison is honest |
| `scanner.json` | `gate`, `scan` | the same permission ladder; the dedupe that stops a live preview firing thirty times |

Runners: `packages/kernel/test/vendor-surface-conformance.test.ts` (TS, all five files),
`:core VendorSurfaceConformanceTest` (Kotlin, all five), and the Swift reference
`Engine/iOS/VendorSurface.swift` in the record lane. Build log:
`ClosedSource/Documentation/v4-launch/parity/V02-V06-inline-surfaces.md`.
