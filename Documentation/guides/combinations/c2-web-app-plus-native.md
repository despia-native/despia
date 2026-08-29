# C2: your web app, plus DSX native parts

You keep your web codebase — framework, bundler, deploy, all of it. Despia adds the NATIVE
half beside it: real native components and modules your pages reach over `window.dsx`. The
two codebases live in one repo without either owning the other.

## The layout

```
their-app/
  src/                    # your web codebase — untouched, forever
  package.json            # yours
  native/
    Modules/
      Badge/
        dsx.json          # the module manifest: name, scheme, version, actions
        swift/
          Badge.swift     # the iOS facet
        kotlin/
          Badge.kt        # the Android facet
```

The rules that keep this honest:

- **The lane names the toolchain.** A module's Swift lives in `swift/`, its Kotlin in
  `kotlin/` — there is no default platform (constitution rule 11; `ios/`/`android/` are
  accepted legacy aliases for existing zips).
- **The manifest is the contract.** `dsx.json` declares the module's actions with their args
  and resolve shapes. Your page calls `window.dsx.module.badge.set({ count: 3 })` and gets a
  promise; the native side implements the action. Dot notation IS the API.
- **Your pages stay yours.** The bridge is origin-gated and injected by the app shell
  (`<DSXWebView/>`); your web deploy does not change.

## How it builds

The `native/Modules/` tree is packaged as a per-app Custom module zip and built by the app
lanes (where signing identities live) — `DSXGraph.lane_dir` resolves the lane folders, and
the module joins the app's registry like any first-party module. The matrix gate validates
the LAYOUT from a clean machine on every pull request: the manifest parses with its identity
fields, both lane folders exist, and your web codebase sits beside it untouched — the native
compile itself is the app lane's job, and this guide says so rather than pretending
otherwise.

The same module folders are also exportable: put them in a DSX project's `Modules/` and
[`dsx export`](../native-export.md) compiles them into a native project you build yourself —
the module grammar is one grammar, wherever it is built.

## Reaching native from your pages

```js
// anywhere in your existing app, once it runs inside the shell:
const { ok } = await window.dsx.module.badge.set({ count: 3 });
window.dsx.on("badge", (event) => render(event));
```

A page outside the shell (your plain web deploy) sees no `window.dsx`; feature-detect and
degrade — the same page serves both audiences.
