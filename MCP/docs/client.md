# The client side: declared servers, one namespaced registry

The app talks to MCP servers the app itself declared. Tools discovered from them
join one registry, namespaced by the server they came from, and the model sees
that one list.

## Declared servers are the allowlist

A server is reachable only if the app declared it, with a name, an endpoint and
an optional credential. Connecting to a name that is not in that list fails
typed with `server_not_declared` and opens no socket, so a model cannot talk the
app into a new network peer by asking nicely.

There is no dynamic registration path. Adding a peer is a change to the app's
declarations, which is a diff someone reviews.

## The namespace is the server id

A tool called `search` on the server `notes` is `mcp.notes.search`. Two servers
that both offer `search` produce two entries and neither shadows the other:

```
mcp.notes.search    Search notes.
mcp.docs.search     Search docs.
```

Collision handling is not last-writer-wins and it is not first-writer-wins.
Both of those quietly change which server the model is talking to, which is a
correctness bug wearing a naming bug's clothes.

## A foreign schema passes through verbatim

A module tool derives its JSON Schema from the action's declared arguments. An
MCP tool already has a schema, so the registry carries it through unchanged:
`oneOf`, nested objects, formats, all of it. Re-deriving it could only lose
information about what the server accepts.

Descriptions ride along as untrusted data. Every entry carries its provenance
(`mcp:<server>`), because a description is text written by whoever wrote the
server and it changes no policy on this side.

## Degradation is per-server

A declared server that is down contributes no tools and raises
`server_unreachable`. Every other server's tools keep working and a completion
that uses them still runs. Dropping one server's registrations touches nothing
else, which is what makes that sentence true rather than aspirational.

Re-connecting a server replaces its rows rather than merging them, so a tool the
server dropped between two connects leaves no ghost behind.

## What exists today

The registry is real and tested on Kotlin/JVM and Swift. `Registry.kt` and
`bindings/swift/Sources/DespiaMCP/ToolRegistry.swift` implement the same
namespacing, verbatim-schema, provenance, per-server replacement and removal
laws.

The transport is not written yet. Nothing in this package opens a connection to
a remote server, so `connect` is a semantic pinned by fixtures rather than code
you can call here. The SDK pins that transport will use are already recorded in
`vendor/VERSIONS` and `Package.swift` (Swift 0.12.1, Kotlin 0.15.0, both exact),
The official Swift SDK is exact-pinned and re-exported by the Swift product;
the declared-server connection wrapper around its transport is still missing.
The TypeScript face is still absent.

The behaviour above is pinned by the `mcp` fixtures in the shared corpus and is
executed today by the two Despia AI host runners. See
[conformance.md](conformance.md) for how to run them.
