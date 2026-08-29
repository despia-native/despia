# graph - the formula-graph ⇄ JSE contract

`{graph, jse, scope, expected}` quads pinning the BIDIRECTIONAL projection
between the visual editor's formula-graph JSON and JSE text. The philosophy the
corpus enforces: **DSX/JSE text is the source of truth; the graph JSON is a
derived VIEW for visual tooling** (nodes are easier to render than markup).
Nothing runtime-side consumes graphs - the compiler emits the same JSE the
three engines already execute.

Laws every implementation must satisfy identically:

1. **compile(graph) === jse** - byte-stable, deterministic text (minimal
   parenthesization by the interpreter's precedence ladder, canonical spacing).
2. **evaluate(compile(graph), scope) == expected** - under the JSE corpus
   semantics (`../jse/`), inputs' `sample` values overlaying the scope and
   `functions` bound as callables.
3. **Round-trip:** `compile(lift(jse))` evaluates to `expected` for EVERY case,
   and equals `jse` byte-for-byte when the case is in canonical form
   (`canonical: false` opts out of the byte re-check only). Lift is TOTAL -
   constructs beyond the node vocabulary become `code` nodes, never a failure.

Case fields: `name`, `graph` (omitted for `liftOnly` cases), `jse`, `scope`,
`expected`, optional `canonical: false`, optional `liftOnly: true` (lift →
compile → evaluate only).

Runners: `OpenSource/LogicEditor/test/run-graph-fixtures.mjs` (the editor SDK)
and `OpenSource/DSXLens/test/run-graph-fixtures.mjs` (the standalone converter
package) - two implementations, ONE fixture file, so they can never drift;
the same discipline the JSE corpus applies across Swift/Kotlin/TS. Public
mirrors vendor this folder so `npm test` runs standalone there.
