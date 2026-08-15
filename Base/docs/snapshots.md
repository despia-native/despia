# Savepoints, snapshots, and the agent guarantee

Two mechanisms, two jobs. Confusing them is how "there is always a backup" turns
out to be false at the worst moment.

## Savepoints - the cheap scope

A savepoint is the transactional scope a single tool call runs inside. Nested
savepoints unwind by name, so one failed call inside a successful sequence undoes
only itself.

```
savepoint { name }   // enter
release   { name }   // keep the writes
rollback  { name }   // discard them, atomically
```

A savepoint does NOT survive a crash. That is not a limitation, it is the
definition: it is a scope, not a backup.

## Snapshots - the durable backup

A snapshot is a point-in-time copy of the whole store. Writes after it cannot
reach it. Restoring returns the store to exactly that point - rows added since
are gone, rows changed are back, and rows deleted BEFORE it was taken do not
come back, because a restore is not an undo of all history.

```
snapshot  { label }   -> { ok, label, url }
snapshots { }         -> { snapshots: [{ label, bytes, url }] }
restore   { label }
export    { label }   -> { url, bytes }
```

Snapshots are listable and exportable because a backup nobody can find is not a
backup. The URL is container-relative (`file:///snapshots/x.db`); export hands
back a reference, never bytes.

## The agent guarantee

When an agent is about to write, the loop takes a snapshot BEFORE the first
mutating dispatch, then runs each tool inside a savepoint. Ordering is the whole
assertion: a backup taken after the first write would satisfy the word "backup"
and break the promise. The corpus pins the ordering, not the intention.

A failed tool rolls its savepoint back and the store shows no partial state. The
model is told the tool failed and can say so.
