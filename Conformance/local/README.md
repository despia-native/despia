# The Despia Local corpus

Platform-neutral fixtures for the on-device data plane
(`OpenSource/Documentation/architecture/proposals/local-ai-engine.md` §4.7 — Despia Local:
SQLite plus sqlite-vec, snapshots and restores as first-class verbs). Same authority model
as `ai/`: hand-authored, every lane runs them in verify mode, no recording.

| Runtime | Runner | Lane |
|---|---|---|
| TS binding | `OpenSource/Local/conformance/run.ts` | per-PR |
| Kotlin binding (JVM SQLite) | `OpenSource/Local/bindings/kotlin` JUnit | per-PR |
| Swift binding | the `conformance-ai` mac lane | per-PR once the lane exists |

## Why these three folders

- **`crud/`** — the typed access surface every consumer sees: stores, keys, values, queries,
  and the type vocabulary that crosses native, page and markup identically.
- **`vector/`** — the AI joint. Vectors live here, not in the AI package, and every index
  entry records the embedding that produced it (model id, dimension, revision). The drift
  case is the reason: a new embedder silently invalidates every stored vector, so a mismatch
  is a typed error with an explicit reindex path, never a quietly wrong search result.
- **`snapshot/`** — the substrate the agentic write guarantee stands on. Savepoints are the
  cheap transactional scope, snapshots are the durable pre-agent backup, and restore is what
  makes *"there is always a backup from before it touched anything"* a fixture instead of a
  promise.

## Case shape

```jsonc
{
  "name": "…",
  "seed":  { "<store>": [ { … } ] },          // rows present before the case
  "steps": [ { "call": { "scheme": "base", "action": "put", "args": { … },
                         "mode": "await", "as": "w" } } ],
  "expect": { "results": { … }, "store": { … }, "errors": [ … ] }
}
```

Steps are the `ai/` step vocabulary (`call`, `tick`) plus `crash` — an abrupt process loss
between two steps, which is how the durability cases assert that a committed write survives
and an open savepoint does not.

`expect.store` is a subset match over the final contents of each named store; `results` is
per-label subset match on the awaited call result; `errors` is the ordered typed-error list.

## Working rules

- The same law as `ai/`: fixtures land in the same commit as, or earlier than, the code.
- Deterministic ordering only. A query whose result order is not pinned by an `order` clause
  is asserted as a set, never as a list.
- No timers, no wall-clock values in expectations.
