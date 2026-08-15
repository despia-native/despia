# cli/ — the command-line node corpus

A command-line program is a `.dsx` document. The head declares what the program may reach
and the `<action>` bodies; the body declares the command surface, because **the structure of
a CLI is its command surface** exactly as the structure of a server is its route surface.

Design and rationale: `OpenSource/Documentation/architecture/proposals/cli-authoring.md`.

| File | What it pins |
|---|---|
| `document.json` | parsing and the closed vocabulary — an unknown tag or attribute ABORTS naming the line, and every shape that would look complete while doing nothing is a named refusal |
| `dispatch.json` | argv → `(command, inputs)`. The declared shape decides the parse: a boolean flag never consumes the next token, a repeatable flag accumulates, a variadic positional takes the rest, `--` ends flag parsing |
| `seams.json` | what a body may reach (`out` · `env` · `fs` · `exec`), the declare-then-reach rule for each, and the return/throw → exit-code table |

## Why this is platform-neutral

Every case is `(source, expected)` or `(source, refusal)` with no host types in it, so the
same file drives any implementation. Today one host executes it — the TypeScript host in
`OpenSource/Web/packages/cli` — which is the same position the server node started from
(`Conformance/actions` was TS-only before Kotlin and Swift joined). A Swift or Kotlin CLI
host implements against this corpus without it being rewritten, which is the property that
made the corpus worth writing before the host.

## Runner

- **TS** — `node --test packages/cli/test/document.test.ts packages/cli/test/dispatch.test.ts packages/cli/test/declared.test.ts`,
  which `npm test` picks up automatically (it globs `packages/*/test`).

## The rule these fixtures encode

Declare it and you may reach it; what you did not declare is refused **with a reason**,
never answered emptily. An empty answer is indistinguishable from a real one, and that is
how a build silently does the wrong thing. The one deliberate exception is a declared-but-
unset environment variable, which answers `null` — because declared-and-absent is a
different fact from undeclared, and a body must be able to branch on it.
