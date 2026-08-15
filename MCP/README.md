# Despia MCP

Model Context Protocol, both directions, for iOS, Android, macOS, Windows and
Linux. Apache-2.0.

**Client** - the app talks to MCP servers the app declared, over Streamable
HTTP, through the official MCP SDKs. Discovered tools join one registry
namespaced by server.

**Server** - the app *is* an MCP server, on loopback, with no network, so the
in-app agent, the app's own web surface, and (on desktop, with consent) an
external agent host can call the app's declared tools.

**Status: 0.1.0 is still landing.** The **server** half is real on Kotlin/JVM
and Swift. Kotlin owns the bounded loopback listener, tokens, discovery file
and stdio launcher; Swift owns a strict, bounded JSON-RPC router for the same
declared rows, validation, approve/snapshot/dispatch sequence, and canonical
`tools/list`, `tools/call`, `resources/list`, and `resources/read` methods. Its
host transport must authenticate and apply origin/host checks before handing a
body to the router. The remote **client** transport remains unfinished, so the
client example below is still API direction rather than a callable wrapper.
[docs/client.md](docs/client.md) and [docs/server.md](docs/server.md) say plainly
which pieces are real.

## Install

```swift
.package(url: "https://github.com/despia-native/despia-mcp", from: "0.0.1")
```

```kotlin
implementation("com.despia:mcp:0.0.1")
```

## Use - client

```swift
import DespiaMCP

let client = DespiaMCPClient(declared: [
    .init(name: "notes", endpoint: notesURL, credential: .bearer(token)),
    .init(name: "docs",  endpoint: docsURL),
])

let connected = try await client.connect("notes")   // -> ["mcp.notes.search", …]
let result = try await client.call(tool: "mcp.notes.search", arguments: ["q": "invoice"])

client.registry.definitions()   // every discovered tool, namespaced, schema verbatim
```

Connecting to a name that is not in `declared` fails with
`DespiaMCPAbsence.serverNotDeclared` and opens no socket. A server that is down
raises `serverUnreachable`, contributes no tools, and changes nothing about the
servers that are up.

## Use - server

```kotlin
val server = DespiaMcpServer(
    rows = listOf(
        ServedRow("notes.search", "Search the user's notes.",
                  args = mapOf("q" to ArgSpec("string", required = true))),
        ServedRow("notes.add", "Add a note.", mutates = "base",
                  args = mapOf("text" to ArgSpec("string", required = true))),
    ),
    dispatcher = { name, arguments -> app.call(name, arguments) },
    approver = { request -> app.approve(request) },      // required for a mutating row
    snapshotter = { scope -> app.snapshot(scope) },      // required for a mutating row
    home = appContainerDirectory,
)
val port = server.start()             // 127.0.0.1, ephemeral port, fresh session token
server.grantExternalConsent(true)     // writes the 0600 discovery file + the launcher
```

Both hooks are required for a row that declares `mutates`, and their absence is a
refusal rather than a bypass: `approval_unavailable` and `snapshot_unavailable`
respectively, with nothing written either way.

`rows` are not written by hand in a shipped app: in Despia they are the
`facets.mcp` declarations of every enabled module, fanned in at build time. The
constructor takes them directly so the package can be used - and tested - on its
own.

## What is actually true of this package

- **The local server binds loopback and nothing else.** `127.0.0.1` and `::1`,
  numeric, on an OS-selected ephemeral port. There is no host setting. A test
  binds the real socket and fails if a wildcard bind ever appears.
- **The token is the boundary, not the interface.** On-device loopback is
  reachable by every co-resident app, so authentication is not optional and is
  not a formality: the token rides an `Authorization` header, is compared in
  constant time, and never appears in a URL, a query string or a log line. A
  missing token and a wrong token get the same answer.
- **External pairing is consent-scoped.** The discovery file - current port plus
  a pairing token that is NOT the in-app session token - is written 0600 and
  removed the moment consent is withdrawn. A host that cached the pairing token
  is refused afterwards.
- **A mutating served tool is approval-gated, and fails closed.** No approver
  present means the write does not happen; a denied approval means the write
  does not happen. The snapshot is taken before the write, not after.
- **Two servers may both offer `search`.** Discovered tools are namespaced by
  server id, so nothing silently shadows anything, and the model sees two
  distinct tools with their own schemas.
- **A tool description is untrusted input.** It rides to the model as data,
  tagged with the server it came from, and it changes no policy.
- **No HTTP server framework.** The Streamable-HTTP framing runs on this
  package's own bounded listener: capped headers, capped bodies, capped
  connections, deadlines on every phase.
- **No telemetry, no backdoors.** The package gate scans these sources for URL
  literals and analytics symbols and fails on either.

## Docs

- [docs/client.md](docs/client.md) - declared servers, connecting, the namespaced registry
- [docs/server.md](docs/server.md) - the loopback server, served rows, approvals
- [docs/apps.md](docs/apps.md) - MCP Apps: giving a tool an interactive view, and why it stays a text tool
- [docs/security.md](docs/security.md) - the threat model, stated plainly
- [docs/conformance.md](docs/conformance.md) - running the fixture corpus

## Issues and contributions

This repository is a generated standalone mirror; the tree is replaced on every sync. The
full framework, the documentation, and the single issue tracker live at
[despia-native/despia](https://github.com/despia-native/despia): report bugs and open pull
requests there, and read
[CONTRIBUTING.md](https://github.com/despia-native/despia/blob/main/CONTRIBUTING.md) for
how patches land with your authorship preserved. Maintained by the Despia team; part of
[Despia](https://despia.com), open source under Apache 2.0.

---

Despia LLC-FZ
Meydan Grandstand, 6th Floor, Meydan Road, Nad Al Sheba, Dubai, United Arab Emirates
support@despia.com
