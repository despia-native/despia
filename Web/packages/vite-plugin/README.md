# @despia/vite-plugin

Compile `.dsx` on import in a Vite app. **Version 0.1.**

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { dsx } from "@despia/vite-plugin";

export default defineConfig({ plugins: [dsx()] });
```

```ts
// two import shapes
import App from "./Components/App.dsx";     // the compiled component IR (+ its CSS, injected)
import registry from "virtual:dsx-registry"; // the whole compiled registry - boot with @despia/dom

import { bootDsx } from "@despia/dom/boot";
bootDsx({ registry, host: document.getElementById("app")!, entry: App.scheme + "." + App.name });
```

ESM only. Node ≥ 22.18. **Vite is a peer dependency and is never imported by this package** -
the plugin is a plain object with the hook shape Vite calls, which is why its entire contract
is unit-tested without a bundler installed. The only runtime dependency is `@despia/compiler`.

## What it does

| Hook | Behavior |
|---|---|
| `transform` | any `.dsx` id → an ES module exporting the compiled `ComponentIR` as `default`, plus `name`, `scheme`, `qualified`, and `css` |
| | the component's static CSS is injected once per component into a keyed `<style>`, under the DSX cascade layers (`@layer dsx-tokens, dsx-elements, dsx-theme, dsx-sheets, dsx-inline, dsx-attrs`). `injectCss: false` exports the CSS and injects nothing. |
| `resolveId` / `load` | `virtual:dsx-registry` → the registry `buildRegistry` compiles from the configured package roots (default: the Vite root) |
| `handleHotUpdate` | a `.dsx` change invalidates the virtual registry and triggers a **full page reload** |

Class handles (`c0`, `a1`, …) come from **one collector shared by the whole plugin
instance**, so two files can never be handed the same handle for different declarations -
a per-file collector would silently collide in the page's cascade.

```ts
dsx({
  packages: ["./", "../design-system"],  // roots folded into virtual:dsx-registry
  scheme: "app",                          // fallback when a .dsx has no dsx.json above it
  injectCss: true,                        // default
});
```

## What it does NOT do - read this before expecting HMR

- **There is no hot module replacement in v0.1.** A `.dsx` edit is a **full page reload**.
  Nothing is hot-swapped, component state is not preserved, and CSS changes are not applied
  in isolation. Component-level hot swap needs the runtime to re-instantiate a mounted
  surface against a new IR while keeping its store; that is a `@despia/dom` capability this
  plugin does not have yet, and pretending otherwise would be the worst kind of lie in a dev
  loop. When it lands, this section changes and the version moves.
- **No SSR integration.** `vite-plugin-ssr` / `ssrLoadModule` flows are untested; use
  `@despia/server` directly, or `dsx build` for static export.
- **No sidecar `.css` handling.** `buildRegistry` (behind `virtual:dsx-registry`) scopes a
  component's sibling `Foo.css`; a direct `import "./Foo.dsx"` carries only the component's
  own *inline/attribute* CSS. Import the sheet yourself if you need it in that path.
- **No route generation.** The route table is `dsx.config.json`'s (`@despia/cli`) or your app's.
- **No module web facets, no `web.expose` embed artifacts.**
- **No source maps.** `transform` returns `map: null`; the emitted module is generated code
  and does not map back to the `.dsx` document.
- **Not verified against a real Vite server.** Vite is not installed in this repository, so
  the hooks are proven by their contract (arguments in, exact bytes out) rather than by a
  live `vite dev` run. The hook shapes are structurally typed against what Vite calls.

## Release status

`@despia/vite-plugin` is part of the tagged release set - the **tooling face** of the
eight-package release (`RELEASE_DIRS` in `scripts/release-packages.ts`). It is packed and
consumed from its tarball per PR by `npm run pack:check` alongside the other seven.
