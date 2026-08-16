# Despia Local

The on-device data plane: SQLite with vectors, snapshots and typed access, for
iOS, Android, macOS, Windows and Linux. Apache-2.0.

Useful with no AI involved - plenty of apps want a real local database and
nothing else. It is also the substrate the agentic write guarantee stands on:
when an agent edits local data, the backup that existed before it touched
anything is a Despia Local snapshot.

## Install

```swift
.package(url: "https://github.com/despia-native/despia-local", from: "0.0.1")
```

```kotlin
implementation("com.despia:local:0.0.1")
```

## Use

```swift
let base = try DespiaLocal(directory: appSupportURL)
try base.declare(store: "notes")

try base.put(store: "notes", key: "n1", value: ["title": "Invoice", "amount": 42])
let note = try base.get(store: "notes", key: "n1")

try base.snapshot(label: "before-agent")     // durable, point in time
try base.savepoint("tool")                   // cheap, transactional scope
// ... a tool writes ...
try base.rollback("tool")                    // or release("tool") to keep it
```

## What is actually true of this package

- **No network path at all.** It is a local database. The package gate scans the
  sources for URL literals and analytics symbols and fails on either.
- **A store must be declared.** Writing to an unknown store is a typed error,
  never an implicit create - silent schema creation is how data planes rot.
- **A value never becomes SQL.** Queries are a small declared vocabulary and
  every value is a parameter. There is a fixture whose query parameter would
  drop the table if it were concatenated.
- **Savepoints and snapshots are different things.** A savepoint is a cheap
  transactional scope that does not survive a crash. A snapshot is a durable
  point-in-time copy that later writes cannot reach and restore returns to
  exactly. The distinction is fixture-pinned, including by a crash.
- **Every vector records its embedding** - model, dimension, revision. A search
  whose query embedding disagrees is a typed error naming the reindex path, not
  a silently wrong ranking. A new embedder is the most common way a local RAG
  feature starts lying, and this is the check that stops it.
- **Snapshot references are container-relative.** `file:///snapshots/x.db`, not
  an absolute path: leaking the container layout buys the caller nothing.

Boundaries, stated plainly: this is the DEVICE data plane. The Despia server
node is the server data plane and they do not unify. A sync vendor's module
remains the sync path. A Base-to-server sync seam is a future proposal, not a
promise here.

## Docs

`docs/` - the data plane, snapshots and the agent guarantee, vectors and
embedding provenance, and running the conformance corpus. `llms.txt` indexes
them.

## Issues and contributions

This repository is a generated standalone mirror; the tree is replaced on every sync. The
full framework, the documentation, and the single issue tracker live at
[despia-native/despia](https://github.com/despia-native/despia): report bugs and open pull
requests there, and read
[CONTRIBUTING.md](https://github.com/despia-native/despia/blob/main/CONTRIBUTING.md) for
how patches land with your authorship preserved. Maintained by the Despia team; part of
[Despia](https://despia.com), open source under Apache 2.0.

---

Proudly built in the United Arab Emirates 🇦🇪

Despia LLC-FZ · Dubai, United Arab Emirates · [despia.com](https://despia.com) · support@despia.com
