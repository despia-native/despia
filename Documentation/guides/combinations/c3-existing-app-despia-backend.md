# C3: your app, plus a Despia backend only

You keep your React/Vite/Next/anything front end. Despia supplies the BACKEND beside it:
typed routes, queue workers, MCP tools, one deploy command — and touches nothing of yours.
`@despia/server` is standalone by construction; nothing in it assumes a DSX front end.

## The two shapes

**Declared** (the full story): a `server/` folder of `<server>` documents — entities, actions,
routes, workers, `<tool>` rows — compiled by `despia build` into the generated tables and the
`deploy/` artifacts, then published with `despia deploy`. Your front end calls the routes like
any HTTPS API. The recipe is
[writing-a-backend](../../../Skills/writing-a-backend.md); the reserved names (`server/`,
`deploy/`, the generated tables) are in [the contract](../reserved-directories.md).

**Standalone** (the ten-line story): hand a route table to the platform-free handler and host
it wherever you already host things. This is the whole program:

```js
// server.mjs — beside your existing app, changing none of it
import { createServer } from "node:http";
import { createEdgeHandler } from "@despia/server/bootloader-deno";

const handler = createEdgeHandler({
  routes: [{ key: "health", chain: "app", action: "health", method: "GET", path: "/health" }],
  handlers: { app: { health: () => ({ up: true }) } },
});

createServer((req, res) => {
  void (async () => {
    const out = await handler(new Request(new URL(req.url ?? "/", "http://localhost"), { method: req.method }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  })();
}).listen(8787);
```

The same handler shape runs unchanged on Deno/Supabase Edge and (as
`@despia/server/bootloader-workers`) on Cloudflare Workers — web-standard `Request` in,
`Response` out is the universality claim, and it is corpus-gated on all three.

## How it serves next to your app

Your host serves your app; the Despia backend serves its routes on its own port, path prefix
(`/dsx/*` is stripped automatically), or subdomain — whichever your host prefers. Nothing in
your build pipeline changes:

```bash
npx despia build                      # server/*.dsx -> server/generated/ + deploy/
npx despia deploy cloudflare          # prints the exact ordered commands, changes nothing
npx despia deploy cloudflare --apply  # runs them
```

`--apply` is the only mode that changes anything, so the plan is safe to run in review and is
what your CI can print for a human before it publishes.

## What CI proves, from tarballs

The matrix gate builds the standalone shape on every pull request: a plain existing app
(one `index.html`), `@despia/server` installed from its packed tarball, the ten-line server
booted, `/health` answered by the Despia handler, and the existing app's files verified
byte-untouched afterward.
