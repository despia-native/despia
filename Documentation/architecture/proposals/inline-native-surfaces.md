# Inline native surfaces — a vendor SDK's UI is a component, not only an overlay

> **Status: PROPOSED** (owner-directed 2026-08-20). The law this establishes:
>
> **A capability that has a UI exposes it as an inline DSX component, not only as a presented
> overlay. The module owns the session; the overlay face and the component face are two views
> onto one state machine, never two implementations.**
>
> Companion law: [`web-surface-policy.md`](../web-surface-policy.md) (the web view is one surface
> among peers) and [`../../Skills/native-components.md`](../../../Skills/native-components.md)
> (one tag, one contract, three twins). This proposal is those two applied to vendor SDKs.

## 1 · The debt, stated precisely

Read the `_note` of every vendor module in the tree and the same sentence shape appears:

| Module | Its own manifest note begins |
|---|---|
| `Core/Payments/Stripe` | "Native Stripe PaymentSheet (`window.dsx.module.stripe.payment`) … dispatched via `window.despia`" |
| `Core/Stream` | "Stream Video (GetStream) calling, dispatched via `window.despia.stream.<command>(...)`" |
| `Core/Clerk` | "Native Clerk authentication via `window.despia.clerk.<command>`" |
| `Core/AdMob` | "the package owns the **web-triggered** ads" |

Every one is written from the seat of a web page asking native to present something over it. That
was the correct design when the web view *was* the product. It is no longer: `<DSXView/>` and
`<DSXWebView/>` are equal consumers of the bus, and the majority of new surface is native markup.

**None of these four modules has a `Components/` folder.** They ship `swift/` and `kotlin/` and
nothing a `.dsx` screen can place. So today a checkout screen is either entirely yours with no
card field, or entirely Stripe's modal. There is no third option, and the third option is what
every real product ships.

**The mechanism is already here.** `Core/Charts` ships `<chart>` and `Core/Maps` ships `<map>` —
module-owned native elements, auto-registered by the same class sweep that finds modules, sized
with `height=`, corpus-pinned under `Conformance/elements/`. The vendor modules simply predate
that pattern. Nothing new needs inventing; something existing needs applying.

## 2 · Why this is infrastructure, not features

Three reasons it compounds rather than accumulates:

1. **It is the answer to "how does an extension expose UI?"** Any third-party extension API
   (`despia add @company/bluetooth-printer`) needs one answer to that question, or every vendor
   invents their own and the ecosystem fragments before it starts. This proposal *is* that answer,
   written against four vendors we control so the contract is proven before outsiders depend on it.
2. **It removes the last place the web view is privileged.** After this, no capability is
   reachable *only* by a page.
3. **The two highest-revenue screens in most apps are checkout and calling**, and both are
   currently modal-or-nothing.

## 3 · The three faces

A capability may have up to three. A module ships every face that applies, and they share state.

| Face | Spelling | Owns |
|---|---|---|
| **Action** | `dsx.module.stripe.payment({…})` | The vendor's own presented modal. Exists today, stays forever, unchanged. |
| **Component** | `<stripe.PaymentElement/>` | The vendor's view embedded in a DSX layout, participating in DSX layout, state, focus and events. **This is what is missing.** |
| **Page** | `window.dsx.module.stripe.payment({…})` | The same bus reachable from a `<DSXWebView/>` page. Already works by construction. |

**Scheme-scoped tags.** `<stripe.PaymentElement/>`, not `<PaymentElement/>` — the
`<store.PaywallVIP/>` precedent. A vendor namespace can never collide with the global component
set, and the tag names its owner, which matters when the owner is excluded from the build.

## 4 · The law that makes this cohere: one session, two views

The temptation is to implement the component as a second integration. That produces two session
models that disagree, and the disagreement surfaces as a double charge.

**The module owns the session.** A `PaymentIntent`, a Stream call, a Clerk sign-in attempt is
created and held by the module. The action face presents the vendor modal *over* that session; the
component face renders the vendor view *into* the layout for that same session. Starting a payment
with the action and completing it inline must be coherent, because there is only one state
machine.

Consequence: the component's attributes never carry the session. They carry a **reference** to it.

## 5 · Secrets never appear in markup

**A publishable key, client secret, call token or JWT must never be an attribute in a `.dsx`
document.** Markup travels over OTA into the content plane; an attribute is a value in a file on a
CDN.

The contract: a component reads its session from the module (which got it from the app's own
backend, or from `config.json`), never from a literal attribute. Expressed in the component's
declared attribute contract, and **lint-enforced**: an attribute whose declared `role` is
`secret` rejects a literal and accepts only a store/module reference.

This is the one rule in this document that is a security boundary rather than an ergonomic
preference, and it is the reason the component face cannot be "just pass the key in".

## 6 · What an inline vendor component must get right

The parts that separate a usable inline surface from a demo. Each is a corpus row, not a hope.

**a · Keyed identity and retain policy.** A vendor view is expensive and stateful. It must not be
torn down and rebuilt on an unrelated re-render. Reuse the existing keyed-identity law
(`SceneBind`: "keys keeping their instantiated subtree — identity survives reorder"). A component
declares its identity key; same key = same live view.

**b · Layout participation.** The view reports an intrinsic size or accepts a declared `height=`,
and never breaks the flex pass. `<video>` and `<map>` already solved this; copy them.

**c · Focus, keyboard and forms.** A card input is a text field. It must join `<form>` validity,
lift with the keyboard (`KeyboardViewport` exists), and honour return-key traversal. **This is the
one most often skipped and the one users feel first** — a card field that hides under the keyboard
is worse than a modal.

**d · Events up, attributes down**, the existing component contract: `on:ready`, `on:change`,
`on:success`, `on:error`, `on:cancel`, with `dsx.this` payloads and the uniform
`{code, message, recoverable, data}` shape on failure.

**e · Accessibility, not doubled.** The vendor's view brings its own accessibility tree. Wrap it,
do not relabel it; the component contributes a group label only where the vendor gives none.

**f · Exclusion is still file presence.** Module excluded ⇒ tag unresolved ⇒ the existing
`DSXNativeUnavailable` path renders, never a crash and never a blank rectangle.

## 7 · The web twin is a real implementation, not a degradation

The unified-codebase law says new authoring surface ships on all three renderers. For vendor
components that is satisfied honestly, because these vendors ship first-class web SDKs:

| Component | iOS | Android | Web |
|---|---|---|---|
| `<stripe.PaymentElement/>` | Stripe iOS `PaymentSheet.FlowController` / `CardField` | Stripe Android `PaymentSheet` / `CardInputWidget` | **Stripe.js Elements** |
| `<stream.CallView/>` | StreamVideo SwiftUI | StreamVideo Compose | **Stream Video JS SDK** |
| `<clerk.SignIn/>` | clerk-ios | clerk-android | **Clerk.js** |
| `<admob.Banner/>` | GADBannerView | AdView | AdSense, or typed absence |

Where a vendor genuinely has no web SDK, the twin is a **typed `unsupported_platform` render**,
declared in the element contract so `dsx doctor` and the editor can both say so before build.

## 8 · The component set

Ordered by value. Each row is a component contract in its module's `dsx.json` plus a fixture under
`Conformance/elements/`.

**`Core/Payments/Stripe`** — the exemplar, and deliberately first because payments is the hardest:
if the pattern survives PCI scope, keyed retain and keyboard behaviour, it survives anything.
- `<stripe.PaymentElement/>` — the full payment method picker inline
- `<stripe.CardInput/>` — just the card field, for a bespoke checkout
- `<stripe.ExpressCheckout/>` — the Apple Pay / Google Pay button, which today requires `Core/Pay`
  (F17) or a modal
- `<stripe.AddressElement/>` — pairs with `<addressfield>` (U08)

**`Core/Stream`**
- `<stream.CallView/>` · `<stream.ParticipantTile/>` · `<stream.CallControls/>` · `<stream.Lobby/>`
  A call as a tile in your layout with your controls, rather than Stream's full-screen UI.

**`Core/Clerk`**
- `<clerk.SignIn/>` · `<clerk.SignUp/>` · `<clerk.UserButton/>` · `<clerk.UserProfile/>`
  These pair with the existing `<AuthLogin/>` / `<AuthSignup/>` Foundation components, which are
  deliberately decoupled — one is your design, the other is Clerk's.

**`Core/AdMob`**
- `<admob.Banner/>` · `<admob.Native/>` — a native ad placed in a feed is the highest-CPM format
  and is impossible today.

**`Core/RevenueCat`**
- `<revenuecat.Paywall/>` — inline, beside the twenty `store.Paywall*` components that already
  exist as pure markup.

**`Core/QRScanner`**
- `<scanner.Preview/>` — the live camera surface it already owns, placeable in a layout instead of
  presented full-screen.

## 9 · Sequencing

- **V01 — the law plus one exemplar.** This document, the attribute-`role: secret` lint rule, the
  keyed retain contract, and `<stripe.CardInput/>` on three renderers with a fixture. Nothing else
  starts until the exemplar has survived a real checkout screen.
- **V02–V06** — the remaining Stripe set, then Stream, Clerk, AdMob, RevenueCat, QRScanner.

`<chart>` and `<map>` are back-documented as the precedent they already are, so the pattern reads
as one family rather than a new invention.

## 10 · What this does not change

- The action faces. Every `dsx.module.stripe.payment(…)` call keeps working, unchanged, forever.
  Overlay is a legitimate choice — a full-screen Stripe sheet is the right answer for a one-off
  purchase, and remains the default for `<DSXWebView/>` apps.
- The web surface policy. WebKit still lives only in Dom.
- The exclusion model. Every component above dies with its module.
