# Despia Kernel

The open application kernel of [Despia](https://github.com/despia-native/despia): the
message bus and its primitives, and the `dsx` API every module is written against.
Apache-2.0. Everything here is meant to be read, vendored, audited, and ported; that is the
whole point of publishing it.

The kernel **names nobody**: no module, no scheme, no platform, and zero WebKit. What sits
on top of it (the module catalog, the host shells, the build machinery, the hosted
platform) is commercial, and the boundary is described below.

This repository is the standalone mirror of the kernel. The full framework, the
documentation tree, the issue tracker, and the contribution flow live at
[`despia-native/despia`](https://github.com/despia-native/despia); report bugs and open
pull requests there.

## What's here

Layout: the **shared** files every platform bundles verbatim sit at this root
(`runtime.js`, `EngineConfig.json`); the **Swift kernel** (the reference
implementation) lives in `iOS/`; the **Kotlin kernel twin** lives in `Android/`
(see `Android/README.md`).

| File | Role |
|------|------|
| `iOS/Context.swift` | The `dsx` handle every handler receives, plus the `Registration` store behind it (per-call context, pre-filter then named dispatch, lifecycle). |
| `iOS/Module.swift` | The `Module` base class you subclass, and the registry that finds modules and routes calls to them. |
| `iOS/Bridge.swift` | The native side of the bridge: `emit`, typed params with smart-parsing, and the `window.virtual` transport. The wire format is `{ id, scheme, host, event, final, data, code }`. |
| `iOS/JSON.swift` | The JSON value modules return, with a fluent builder that reads the same on Swift, Kotlin, and Java. |
| `runtime.js` | `window.despia`, the call/watch/resolve/subscribe surface web code uses. |
| `custom.js` | An empty hook that runs after the runtime loads, for app-specific web code. |
| `SKILL.md` | The author's guide: how to write a module against `dsx`. |

## What is intentionally not here

Despia is open-core, and this is the open half. Kept commercial on purpose:

- **The module catalog**: payments, auth, sync and search, health, vision, audio, on-device
  AI, and the rest. A module is where a capability lives; this is the value.
- **The host app shells**: the composed application that boots a kernel, hosts the web
  surface, and serves content locally.
- **The build and release machinery**: codegen, packaging, signing, store delivery.
- **Generated configuration**, which carries per-customer URLs and license material and
  therefore never ships anywhere.

Nothing above is required to read, run, or port what is in this repository.

## Lifting this into its own package

Inside the app this all compiles as one module, so the runtime can reach the
generated `CoreConfig` and `GeneratedModuleSchemes` directly. To pull it into a
standalone package, put a protocol in front of the three host hooks it depends
on: the local CDN (`dsx.module.cdn.object("store")`), the host config (`CoreConfig`), and the
local-server flag (`dsx.flags()`).

## `conformance/`: how to check our parity claim instead of believing it

The published mirror carries `conformance/`, the platform-neutral fixture corpus this
repository holds all three kernels to. It is not a sample of the test suite; it is the
definition of correct behaviour, and the Swift kernel here, the Kotlin kernel in
`Android/`, and the TypeScript kernel (`@despia/kernel` on npm) each run the same files.
A behaviour change that does not land on every runtime that ships it fails a gate.

So "one application model, every renderer" is a falsifiable claim, and this folder is
where you falsify it. (Two further nodes run the same grammar off the screen: the server
and the command line. They consume the same kernel primitives and the same corpora.) Read
`conformance/README.md` for the corpus layout, then `conformance/jse/` for expression
semantics, `conformance/chains/` for module identity resolution, and
`conformance/defaults/tokens.json` for the unstyled baseline.

## Spec and docs

- `SKILL.md` here, for writing a module.
- [`Skills/despiascript.md`](https://github.com/despia-native/despia/blob/main/Skills/despiascript.md), the pattern itself.
- [`Skills/runtime-api.md`](https://github.com/despia-native/despia/blob/main/Skills/runtime-api.md), the full `dsx` surface and web contract.
- [docs.despia.com](https://docs.despia.com), the documentation site.

---

Proudly built in the United Arab Emirates 🇦🇪

Despia LLC-FZ · Dubai, United Arab Emirates · [despia.com](https://despia.com) · support@despia.com
