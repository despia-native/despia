# Changelog

Despia Local's own version. Independent of the DSX kernel's and of Despia AI's -
they release for their own reasons.

## 0.0.1

The data plane's contract, executed against real SQLite.

- The typed access surface: stores, keys, values, filtered and ordered queries,
  and a size summary. Parameterised throughout - a value never becomes SQL.
- Savepoints as the cheap transactional scope, nested and unwound by name.
- Snapshots as the durable pre-agent backup: point-in-time copies that later
  writes cannot reach, restore that returns the store exactly, and listing and
  export so a backup is findable.
- Vector indexes where every entry records the embedding that produced it -
  model, dimension, revision - and a mismatch is a typed error naming the
  reindex path rather than a silently wrong ranking.
- Conformance: OpenSource/Conformance/local runs green on the TS binding.
