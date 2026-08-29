# @despia-native/kernel

The platform-neutral DSX web kernel: reactive state, JSE evaluation, actions, declarative API blocks, logging, and the module bus.

```sh
npm install @despia-native/kernel
```

```ts
import { DSXState } from "@despia-native/kernel";

DSXState.set("cart.count", 2);
console.log(DSXState.get("cart.count"));
```

The package is ESM, ships compiled JavaScript and declarations, has no runtime dependencies, and follows the shared DSX conformance corpus used by Swift and Kotlin. Node 20+ is supported for server/tooling use.

See the [DSX Web documentation](https://github.com/despia-native/despia-framework/tree/main/OpenSource/Web) for the API and compatibility policy.
