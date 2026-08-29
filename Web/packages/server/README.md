# @despia-native/server

The DSX v0 server renderer for HTML strings, full documents, redirects, static route export, and offline manifests.

```sh
npm install @despia-native/server @despia-native/dom @despia-native/compiler @despia-native/kernel
```

```ts
import { renderPage } from "@despia-native/server";

const html = renderPage(registry, "demo.Launcher", {}, { title: "DSX app" });
```

The package is ESM, ships compiled JavaScript and declarations, and supports Node 20+. The 0.1 line uses replace-mount client boot; adoptive hydration and streaming are not claimed by this release.

See the [DSX Web documentation](https://github.com/despia-native/despia-framework/tree/main/OpenSource/Web) for SSR and static-export details.
