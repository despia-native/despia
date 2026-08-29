# @despia-native/element

Expose a compiled DSX component as a standards-based custom element with typed attributes, properties, events, slots, and shadow-DOM isolation.

```sh
npm install @despia-native/element @despia-native/dom @despia-native/compiler @despia-native/kernel
```

```ts
import { defineDsxElement } from "@despia-native/element";

defineDsxElement({ tag: "shop-paywall", component: "shop.Paywall", registry });
```

The package is ESM and ships compiled JavaScript and declarations. Call `defineDsxElement` in a browser; importing it has no registration side effects.

See the [DSX Web documentation](https://github.com/despia-native/despia-framework/tree/main/OpenSource/Web) for embed contracts and browser support.
