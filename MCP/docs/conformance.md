# Running the fixtures and the package's own tests

Two things guard this package. The shared fixture corpus says what MCP must do,
and the JVM and Swift tests say that the pieces built so far actually do it.

## The fixtures

The MCP cases live in `conformance/mcp/mcp.json` (in the published package) or
`OpenSource/Conformance/ai/mcp/mcp.json` (in the monorepo). They are eight cases
inside the 99-case Despia AI corpus.

Three runners execute them:

```
node conformance/run.ts mcp                # from THIS package, or its mirror
node conformance/run.ts ai                 # from OpenSource/AI, or its mirror
cd bindings/kotlin-jvm && gradle test      # the same corpus, Kotlin side
swift test                                 # Swift protocol/router tests, package root
```

The two AI-side runners walk the whole `ai` tree, so the MCP cases are not
opt-in there either. A change that passes one runner and not the others is a bug
in the change, not in the runners.

This package's runner exists because the published repository has to be able to
run its own gate. The mirror grafts the corpus in at `conformance/mcp`, and the
mirror repository contains no sibling package, so a runner that reached into the
AI package's host would work in the monorepo and fail in the published tree -
the one thing a publish gate must not do. `conformance/host.ts` is therefore a
reference model of the eight cases living inside the package they belong to. It
is not the transport: the real listener, the real token comparison and the real
0600 file are exercised by the JVM tests below, against real sockets and real
files. The two are meant to be read together, and a disagreement between them is
a bug in one of them.

The fixtures are hand-authored from the design and run in verify mode. Nothing
records or regenerates them. They describe what the system should do, which is
why they exist before the transport does.

## What the eight cases pin

| Case | The rule |
| --- | --- |
| namespaced registry | two servers offering `search` become `mcp.notes.search` and `mcp.docs.search`, schemas verbatim |
| client round trip | a discovered tool called by the model dispatches with `source: "mcp"` and its result returns as a `tool` message |
| undeclared server | `connect` to a server nobody declared is refused typed and opens no connection at all |
| server down | an unreachable server loses its own tools and nothing else |
| served rows | the local tool list is derived from declared rows, `required` only when something is required |
| no token | a request without the session token is refused, and a wrong token is refused the same way |
| pairing | the discovery file is 0600, its token is not the session token, and withdrawing consent refuses the cached one |
| mutating tool | a write over MCP waits for approval and runs inside a snapshot |

The connect-count and bound-address assertions are part of those cases rather
than separate ones: a refused connect must leave the count at zero, and a start
must report loopback-only binding with no token in a URL.

## The package's own tests

The Kotlin/JVM face builds and tests with nothing but a JDK:

```
cd bindings/kotlin-jvm && gradle test
```

They are not simulations. They bind a real socket, read the bound addresses back
and fail on anything that is not a loopback literal, drive real client
connections through the header, body and overload limits, run real JSON-RPC
exchanges against a real `DespiaMcpServer`, and read the POSIX mode of a real
discovery file off the filesystem.

`SecurityGuardsTest` is the one to read first. It asserts the three properties
this package's safety rests on, and each is written so that weakening the thing
it guards makes it fail:

| Guard | How it is falsified |
| --- | --- |
| the bind address | it connects from this machine's own non-loopback address and requires the connection to be refused; a wildcard bind makes it pass, so the test fails |
| the token check | it drives a missing token, a wrong one, a prefix, a token in a query string and a token from a previous run, and requires all five to get the same 401 with the same empty body |
| the file mode | it reads the discovery file's POSIX mode back and requires exactly `0600` |

Each was verified by making the mutation and watching the test go red before it
was committed. A guard nobody has watched fail is not a guard.

The Swift face builds and tests from the package root:

```
swift test
```

Those tests cover strict JSON-RPC parsing and bounds, declaration-derived
schemas, argument validation, namespaced registry replacement, the exact
approve/snapshot/dispatch sequence, protocol-vs-tool error framing, and
declared-URI text/blob resources. They do not claim to prove a Swift socket or
credential boundary: the Swift router accepts only an already-authenticated
body, and the Kotlin live-socket suite remains the transport guard.

## The package gate

In the monorepo, the packaging rules are a separate check:

```
ruby ClosedSource/scripts/ai_package_gate.rb
```

It reads version discipline, the licence and NOTICE, the pin file, and this
docs index, and it greps the sources for URL literals and analytics symbols. The
no-telemetry claim in the README is only worth making because something fails
when it stops being true.
