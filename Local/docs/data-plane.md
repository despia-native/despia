# The data plane

One SQLite file holds three shapes: relational rows, key/value documents, and
vectors. The access surface is identical from native code, from the page
surface, and from DSX markup, because it is the module's declared action
vocabulary rather than three hand-written APIs.

## Stores

A store is declared before it is written. `put` to an unknown store answers
`unknown_store` rather than creating one, because a data plane where any typo
becomes a new table is a data plane nobody can reason about six months later.

```
put    { store, key, value }   -> { ok: true }
get    { store, key }          -> { value }     // a miss is null, not an error
delete { store, key }          -> { deleted: n } // 0 when there was nothing
stats  { }                     -> { stores: [{ name, rows }] }
```

Values round-trip with their types intact. A number that went in comes back a
number.

## Queries

`where` and `order` are a small declared vocabulary - `eq`, `ne`, `gt`, `gte`,
`lt`, `lte`, `contains` - and not a SQL passthrough. That is what keeps every
value a parameter on every binding, and it is why the injection fixture is
boring: the hostile string is matched against, not executed.

```
query { store, where: { amount: { gte: 20 } },
        order: [{ field: "amount", dir: "desc" }] } -> { rows: [{ key, value }] }
```

A query whose result order is not pinned by an `order` clause is asserted as a
set in the corpus, never as a list. Relying on incidental ordering is how a test
suite starts failing on a different SQLite build.

## Durability

A committed write survives an abrupt process loss. The corpus asserts it with an
actual close-and-reopen rather than with a comment.
