# @despia-native/dom

The browser renderer for DSX component IR. It owns DOM access, bindings, native browser elements, navigation, themes, hover input, and the offline floor.

```sh
npm install @despia-native/dom @despia-native/compiler @despia-native/kernel
```

```ts
import { bootDsx } from "@despia-native/dom/boot";

bootDsx({
  registry,
  host: document.querySelector("#app")!,
  entry: "demo.Launcher",
});
```

The package is ESM and ships compiled JavaScript, declarations, and the service-worker asset at `@despia-native/dom/sw/dsx-sw.js`. It targets the last two evergreen browser releases and Safari 16.4+. The repository gate runs the layout, UI, interaction, stress, offline, and editor oracles in locked Playwright Chromium, Firefox, and WebKit. That engine coverage does not replace release qualification on physical Safari, branded Edge, mobile Safari, or mobile Chrome at the supported versions.

See the [DSX Web documentation](https://github.com/despia-native/despia-framework/tree/main/OpenSource/Web) for boot, CSP, offline, and browser-support guidance.
