# MCP Apps conformance

The shared corpus for the **MCP Apps** extension
(`modelcontextprotocol/ext-apps`, specification `2026-01-26` — the first official MCP
extension, authored jointly by MCP core maintainers at Anthropic and OpenAI with the
mcp-ui creators). Design record: `OpenSource/Documentation/architecture/proposals/mcp-apps.md`.

Two files, because there are two halves and they fail differently:

| File | Half | Runners |
|---|---|---|
| `apps.json` | the **view** protocol — what runs inside the host's sandboxed iframe | TS (`packages/kernel/test/mcp-apps-conformance.test.ts`, per-PR) |
| `server.json` | the **server** shaping — tool metadata + the text fallback | TS (`packages/kernel/test/mcp-server-conformance.test.ts`, per-PR); the Kotlin and Swift routers in `OpenSource/MCP` run the same file as they land |

Both are deterministic: no timers, no network, no DOM. The view corpus drives a transport
double and asserts the exact JSON-RPC frames the view emits; the server corpus asserts exact
`CallToolResult` shapes. That is what makes them platform-neutral rather than TS tests
wearing a corpus costume.

## The laws these files pin

Read the `_note` at the top of each file for the full list. The two that matter most:

1. **A UI tool is a text tool that also has a view.** Every result carries meaningful
   `content` whatever the host can render, and the metadata (never the text) is what
   capability negotiation gates. A host without MCP Apps loses presentation, never function.
   This is the spec's own requirement and Article 7 at the same time.
2. **Nested metadata only** — `_meta.ui.resourceUri`. The flat `_meta["ui/resourceUri"]` is
   deprecated upstream and is never emitted.

## Re-verifying against upstream

The field names here were read off the published specification on 2026-08-12. The extension
is FINAL, so drift should be additive, but when adding a case check the current text at
`modelcontextprotocol/ext-apps/specification/<date>/apps.mdx` first and update the date in
this file's header along with the change.

One deliberate softness worth knowing about: the view runtime reads a `tool-input`
notification **tolerantly** — it accepts the `{ arguments: {…} }` envelope and also a bare
argument dict — because a lost input renders a blank view and the fail-open reading costs
nothing. The corpus pins the envelope form; the tolerance is a runtime property, not a
licence to emit the loose shape.
