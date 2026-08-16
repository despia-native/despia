# Running the conformance corpus

```
node conformance/run.ts
```

The fixtures are `conformance/local` in the published package and
`OpenSource/Conformance/local` in the monorepo; one runner finds either.

Every lane runs them in VERIFY mode - hand-authored from the design, never
recorded from an implementation.

The TypeScript runner uses the SQLite that ships inside Node (`node:sqlite`), so
these are not simulated semantics: real savepoints, real rollback, real
`VACUUM INTO`, and a real close-and-reopen for the crash cases. A hand-rolled
in-memory approximation would agree with the fixtures for the wrong reasons and
then disagree with the native bindings for real ones.
