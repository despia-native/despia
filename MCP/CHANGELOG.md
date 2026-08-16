# Changelog

All notable changes to Despia MCP. The version is this package's own semver and
is independent of the kernel, of Despia AI, and of the `Core/MCP` wrapper
module's manifest version.

## 0.0.1

First cut. Both directions of the protocol, one package.

### Client

- Streamable HTTP client over the official MCP SDKs (Swift 0.12.1, Kotlin
  0.15.0), pinned exactly. No stdio transport on device.
- A **declared-server allowlist**: `connect` against a server the app never
  declared is refused with a typed `server_not_declared`, so a model cannot talk
  the app into a new network peer.
- Discovered tools join the one tool registry **namespaced by server**
  (`mcp.<server>.<tool>`), carrying their JSON Schema through verbatim. Two
  servers offering `search` produce two distinct tools and neither shadows the
  other.
- **Per-server degradation**: an unreachable server contributes no tools and
  raises `server_unreachable`; every other server's tools keep working.
- Bearer credentials are read from the host at connect time and never written to
  the registry, a log line, or a URL.

### Server

- A loopback-only MCP server. Streamable-HTTP framing on this package's own
  bounded listener - no HTTP server framework on either lane.
- **Loopback only, asserted**: the listener binds numeric `127.0.0.1` / `::1` on
  an OS-selected ephemeral port. A hostname or wildcard bind is not a
  configuration option; there is no code path that reaches one.
- **Per-session token.** Every request carries it in an `Authorization: Bearer`
  header. A missing token and a wrong token are refused identically
  (`unauthorized`), with no hint about which part was wrong. The token never
  appears in a URL.
- **External pairing through a 0600 discovery file** carrying the current port
  and a pairing token distinct from the in-app session token, written only while
  consent stands and removed when it is withdrawn. A host that cached the old
  pairing token is refused after withdrawal.
- A **stdio launcher** so a static agent-host config can reach a dynamic port.
- What the server serves is **declared, not coded**: `facets.mcp` rows map
  manifest actions to MCP tools, deriving the input schema from the action's
  declared args - the same derivation the in-app tool registry uses.
- A **mutating** served tool takes the same approve-before-execute path and the
  same snapshot as an in-app one, and is refused when no approver is present.
  The protocol is not a bypass.

### Gates

- The `ai/mcp` conformance corpus runs from this package (`node conformance/run.ts
  mcp`) and from the Despia AI package, over the same eight cases.
- The Kotlin/JVM face carries live security guards that bind a real socket:
  bind address, token check and discovery-file mode each fail the suite when
  regressed. Each was proven by making the mutation and watching the test go red.

### Not in this cut

Written down rather than left to be discovered:

- The **client transport** is designed and fixture-pinned but not implemented;
  the SDK pins in `vendor/VERSIONS` are the dependency it will take.
- The Swift face provides the declaration registry and the authenticated-body
  server router, but not a loopback listener/token/discovery implementation.
  The host must enforce those transport guards before calling the router;
  Kotlin/JVM remains their real-socket reference.
- A served tool's `inputSchema` derives from the target action's declared `args`.
  In the Despia wrapper module that table is still landing, so a served tool
  currently advertises `{"type":"object"}` - an unconstrained object, which is
  true - rather than a properties block it cannot yet derive.
