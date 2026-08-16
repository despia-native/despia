# The local server: declared rows, loopback, approve before execute

The app can be an MCP server itself, on loopback, so the in-app agent, the app's
own web surface and (on desktop, with consent) an external agent host all reach
the same declared tools.

Read [security.md](security.md) first if you are reviewing this side. It is the
threat model, and everything below follows from it.

## Rows are declared, not written by hand

A served tool is a row: an action name, a description, the action's declared
arguments, and `mutates` when the action writes something. In a Despia app the
rows are the `facets.mcp` declarations of every enabled module, fanned in at
build time. The package takes them as data so it can be used, and tested,
without a build system.

The input schema is derived from the row's arguments, the same derivation the
in-app tool registry uses for module tools. One grammar, two protocols. A served
tool cannot drift from the contract it describes because there is no second
place to state the shape.

Derivation is exact about one detail: `required` appears only when at least one
argument is required. An empty `required: []` means the same thing, but the
fixtures pin the terser form.

```
row:    notes.add, "Add a note.", text: string (required), mutates: base
tool:   { "name": "notes.add",
          "description": "Add a note.",
          "inputSchema": { "type": "object",
                           "properties": { "text": { "type": "string" } },
                           "required": [ "text" ] },
          "mutates": "base" }
```

`mutates` rides along in the tool list, so a settings screen showing what this
app exposes can tell which tools write without guessing from a description.

## The listener binds loopback and nothing else

Numeric `127.0.0.1`, plus `::1` when the platform offers it, on an
OS-selected ephemeral port. Not a hostname, because a hostname resolves and a
resolver is an input. Not a wildcard, because a wildcard puts a phone's MCP
server on the cafe Wi-Fi. There is no host parameter in the file and no config
key anywhere.

Every phase is bounded: header bytes, header count, request target length, body
bytes, concurrent connections, worker threads, and separate deadlines for the
header phase, the body phase and the response. The listener is a few hundred
lines instead of a server framework, which is the point. A reviewer can read all
of it, and the limits are visible rather than inherited from someone's defaults.

Duplicate header names take the last value rather than joining into a comma
list, so a repeated `Authorization` header can never become a string that
passes a comparison.

## The token is the boundary

Requests carry the session token in an `Authorization: Bearer` header. The token
is 256 bits from the platform CSPRNG, minted fresh at each start, and compared
in constant time over the whole value, so a caller learns nothing from how long
the answer took. Missing and wrong get the same refusal.

The token never appears in a URL. On-device loopback is reachable by every
co-resident app, so this is the only thing standing between them and the tools.

## Approve before execute, and fail closed

A row that declares `mutates` is approval-gated no matter which protocol asked.
The approval is requested before the tool runs, a snapshot is taken before the
write, and the absence of an approver is a refusal rather than a bypass. A write
requested over MCP takes the same path as a write requested by the in-app agent
loop, which is the whole reason both derive from one declaration.

## The framing

Streamable HTTP, one endpoint (`/mcp`), on the listener above. The checks happen
in a fixed order, and the order is the design - every one of them runs before a
row is looked up:

1. **Origin and Host must be loopback.** This is the DNS-rebinding defence: a
   page on a hostile site whose name resolves to `127.0.0.1` still arrives
   carrying its own `Host` header. It defends against browsers and nothing else;
   a co-resident app sends whatever headers it likes.
2. **Path and method.** `POST` and `DELETE`. `GET` would be the server-initiated
   SSE stream, which this server does not open, so it answers `405` rather than
   an empty stream nobody can tell apart from a hang.
3. **The token.** Missing and wrong are one answer.
4. **Content negotiation**, and the listener's body cap, already applied.
5. **The JSON-RPC envelope.** Batching left the protocol in the 2025-06-18
   revision and is refused rather than half-supported.
6. **The row**, and only then the approval.

`initialize` assigns an `Mcp-Session-Id`. It is an identifier, not a credential:
it is checked so a client holding a stale one is told to re-initialize rather
than silently talking to a server that restarted underneath it. The token is
what authenticates, and it is checked first.

Methods: `initialize`, `ping`, `tools/list`, `tools/call`. A tool that throws is
reported as a TOOL error (`isError` in the result) rather than a JSON-RPC error,
because the model is supposed to see it and react, which a protocol error would
deny it. A tool that is not in the derived table is `unknown_tool` whether or not
the caller authenticated.

## What exists today

The Kotlin/JVM face is complete and tested against real sockets and real files:

- `ServedRows.kt` - the row type and the schema derivation, matching the
  fixtures byte for byte.
- `Loopback.kt` - the bounded listener, plus `LoopbackTokens`.
- `Json.kt` - a strict JSON codec with a nesting cap, no third-party dependency.
- `Session.kt` - the two tokens, the constant-time comparison, the rotation.
- `Discovery.kt` - the 0600 discovery file and the stdio launcher.
- `StdioBridge.kt` - the launcher's other half, and a raw-socket loopback client.
- `Server.kt` - `DespiaMcpServer`: the framing above, tied to rows, a dispatcher,
  an approver and a snapshotter.

The Swift face now provides the same declaration-derived tool catalog and
fail-closed mutation funnel in `DespiaMCPServerRouter`. It parses strict JSON-RPC
with body/depth caps, validates declared arguments, and implements
`initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, and
`resources/read`. Resources are an exact-URI declaration table, so a caller URI
can never turn directly into filesystem or network I/O. SwiftPM tests pin
parsing, validation, dispatch order, tool error framing, and text/blob resource
reads.

The router deliberately starts after authentication: a native host transport
must apply the loopback, Origin/Host, and bearer-token guards before calling it.
Kotlin/JVM remains the complete reference transport and proves those guards
against real sockets and files. The remote CLIENT transport remains unfinished.
In a Despia app the wrapper module `Core/MCP` owns the `facets.mcp` namespace and
the bus surface; its transport seam answers `transport_unbound` until the host
wires one rather than pretending.
