# WebMCP conformance

The platform-neutral law for **WebMCP** support (`webmachinelearning/webmcp` — the W3C Web
Machine Learning CG draft behind `document.modelContext`, in Origin Trial in Chrome 149 and
Edge 150 and shipped in ChatGPT Desktop). Design: `architecture/proposals/webmcp.md`.

Two halves, two files, because they are two different laws with two different consumers.

| File | The law | Runners |
|---|---|---|
| `project.json` | **Outbound.** A `<tool>` head row projected as a WebMCP tool descriptor: name defaulting, the schema DERIVED from the named action's declared inputs, annotations derived from `mutates`, the four build-time refusals, and MCP-shaped results. | TS `packages/kernel/test/webmcp-conformance.test.ts` · Kotlin `:core WebMcpConformanceTest` · Swift `WebMcpConformance` (via `RecordMain.swift`) |
| `registry.json` | **Inbound.** The page tool table a shell keeps when a page registers through `document.modelContext`: spec validation, verbatim schemas, per-page lifetime, provenance, untrusted hints, abort, and the `toolchange` signal. | the same three |

Both files run on **all three renderers**, because the row parses on all three and the table's
law must be the same wherever a shell implements it. The `<tool>` row is an authoring surface,
so the unified-codebase law applies to it in full; what is web-only is the *projection target*
(`document.modelContext` is a browser API, the way SSR is a web-only renderer of the same
files). On a native surface the row is accepted, validated by the same fold, and inert until
its consumer exists.

## The case shapes

`project.json` — a case is either a **projection** case or a **result** case.

```jsonc
// projection
{ name, actions: { <action>: { inputs: { <name>: <expr> } } },
  tools: [ { as?, action, description, mutates? } ],
  expect: { descriptors: [ … ] | descriptorNames: [ … ] } }

// projection that must FAIL the build
{ name, actions, tools, expectError: { code, names: [ … ] } }

// result shaping
{ name, result: { value } | { thrown, correlationId }, expect: { result: { … } } }
```

`expectError.code` is one of `unknown_action` · `duplicate_tool` · `invalid_name` ·
`missing_description`.

`registry.json` — a case is an ordered list of steps against one table.

```jsonc
{ name,
  steps: [ { register: { surface, origin, tool } }
         | { commit: { surface, origin } }
         | { abort: { surface, name } } ],
  expect: { tools?: [ … ], toolNames?: [ … ], rejections?: [ … ], events?: [ … ] } }
```

An omitted `expect` key is not asserted. `tools` compares the whole recorded row including its
derived `approval`; `toolNames` compares order only.

## Why the `_note` blocks are load-bearing

Each file opens with the numbered law it encodes. That prose is the specification these
fixtures are the executable form of: a runner that passes while the note is false is a runner
that agreed with a bug. Read the note before changing a case.

A change to WebMCP semantics is illegal without a green corpus on every runtime that ships it,
the same discipline as `OpenSource/Conformance/jse` and `OpenSource/Conformance/api`.
