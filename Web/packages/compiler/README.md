# @despia-native/compiler

The DSX build-time compiler for parsing `.dsx`, compiling component IR, resolving registries, and emitting scoped CSS.

```sh
npm install @despia-native/compiler
```

```ts
import { compileComponent } from "@despia-native/compiler";

const component = compileComponent(
  "Greeting",
  "demo",
  "<stack><text value=\"Hello\"/></stack>",
);
```

The package is ESM and ships compiled JavaScript plus declarations. Invalid or over-budget documents fail with bounded, deterministic parser errors.

See the [DSX Web documentation](https://github.com/despia-native/despia-framework/tree/main/OpenSource/Web) for authoring and compatibility details.
