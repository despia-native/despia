# MCP Apps: giving a tool an interface

A tool can return an interactive view instead of only text. The host renders it in a
sandboxed iframe inside the conversation, the user interacts with it there, and the view
talks back through the host over JSON-RPC.

This is the **MCP Apps** extension (`modelcontextprotocol/ext-apps`, specification
`2026-01-26`) - the first official MCP extension, authored jointly by MCP core maintainers at
Anthropic and OpenAI with the mcp-ui creators. It shipped in Claude, VS Code and Goose on
2026-01-26, with ChatGPT following the same week. There is one extension to implement, not a
per-vendor fork.

Read [security.md](security.md) first if you are reviewing this. Everything below assumes it.

## The one rule that decides everything else

**A tool with a view is still a text tool.**

Most hosts, most agents, and every script that ever calls your server will take the text
path. The spec requires it - *"if host does not support MCP Apps, tool behaves as standard
tool (text-only fallback)"* - and a view that is load-bearing is a tool that silently does
nothing for most of its callers.

So the failure mode to design against is not "the view looks wrong", it is "the view was the
only place the answer existed". Everything in this package's shaping exists to make that
impossible:

```ts
import { mcpToolResult, hostSupportsUi, uiResourceUri } from "@despia/kernel/mcp";

const result = mcpToolResult(value, {
  resourceUri: uiResourceUri("catalogue", "search"),
  uiSupported: hostSupportsUi(clientCapabilities),
});
```

One call, one code path, both host classes. `content` always carries text derived from the
same value the view hydrates from; `_meta.ui` is attached only when the host declared
`io.modelcontextprotocol/ui`. Two representations cannot drift when there is one derivation.

Ask the capability question **before** advertising a UI-enabled tool. A host that never
declared the extension should not receive metadata it has to ignore.

## Declaring a view in a Despia app

A served tool is already a row (see [server.md](server.md)). A view is one more field on it:

```jsonc
"facets": {
  "mcp": {
    "catalogue_search": {
      "action": "search",
      "description": "Search the catalogue.",
      "ui": "Components/SearchResults.dsx"
    }
  }
}
```

`ui` names a `.dsx` component **this module owns**. The build compiles it into one
self-contained `text/html;profile=mcp-app` resource at `ui://despia/<scheme>.<action>`.

It names a component and nothing else, for the same reason a row has no `schema` field: the
action's `args` are already the validated input shape and its `resolve` is already the output
shape. A view adds a **rendering**, never a second contract. A row naming a component the
module does not carry fails the build, not the request.

## What a view may do, and what it may not

The host serves your view under a Content Security Policy whose default is:

```
default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'none';
```

That is not a Despia restriction, it is the spec, and it is the point: a view is a rendering
surface, not a second place your application reaches the network from.

| | |
|---|---|
| Data in | `ui/notifications/tool-result` - the tool already ran; the view hydrates against its value |
| The one egress | a host-proxied `tools/call` - in DSX, `dsx.module.mcp.call({ name, arguments })` |
| `fetch`, WebSocket, EventSource, XMLHttpRequest, `sendBeacon`, `<api>` | rejected **at build time**, with the fix named in the error |
| External scripts, fonts, images | only with `_meta.ui.csp` domains declared; otherwise blocked |

The build-time rejection matters more than it looks. Under this CSP a view that calls the
network compiles perfectly, renders perfectly in your browser, and fails silently inside the
host. Moving that to a build error is the difference between a bug you find and a bug your
users find.

**Think of it as server-side rendering.** The work happens outside the box: the tool runs on
the server with full network access, resolves a value, and the view is handed that value to
render. The box does presentation and interaction. Nothing about that shape is a compromise;
it is the same split that makes SSR fast.

## The handshake, in order

If you are implementing a view by hand rather than compiling one from DSX, the ordering is
not advisory:

1. The view sends the `ui/initialize` **request** first, declaring its display modes.
2. The host answers `hostCapabilities`, `hostInfo` and `hostContext`.
3. The view sends the `ui/notifications/initialized` **notification**.
4. Only then does tool data flow: `ui/notifications/tool-input`, then
   `ui/notifications/tool-result`.

`@despia/kernel/mcp` handles all of it - `createAppBridge` emits the initialize request on
construction, so there is no start step to forget. It also holds the parts that are easy to
get wrong: a call issued before the handshake is queued rather than reordered ahead of it,
data that arrives early is buffered rather than dropped, `tool-input-partial` never settles
the real input channel, a duplicate or unmatched response is a no-op, and a failed tool call
resolves as a value instead of throwing into your view.

Every one of those is pinned in `OpenSource/Conformance/mcp-apps/apps.json`, which is a
platform-neutral corpus rather than a TS test, so any runtime that grows a view host runs the
same file.

## Theming

The host passes its own CSS custom properties in `hostContext.styles.variables`
(`--color-text-primary`, `--font-sans`, `--border-radius-md`, …). `mountMcpApp` writes them
onto the view, and DSX reads through to them.

The practical consequence: **do not paint a background or hard-code a font.** An unstyled
view inherits the host's look, which is why the same component reads as native in Claude and
in VS Code without a per-host stylesheet. A view that paints its own chrome fights whichever
host it lands in.

## Sizing

If `hostContext.containerDimensions` is empty, the container is flexible and the view reports
its content size with `ui/notifications/size-changed`. If the host set fixed dimensions, it
owns the box and the view reports nothing. `mountMcpApp` observes the element you nominate
and coalesces repeats, so a resize loop cannot turn into a message storm.
