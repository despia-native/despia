# CLI authoring — the command-line surface is a `.dsx` document

> **Status: LANDED (2026-08-12).** Every example below is the implemented grammar, verified by
> `packages/cli/test/{document,dispatch,declared,dogfood}.test.ts` (61 assertions over the
> corpus) and `ClosedSource/scripts/lint_dsx_cli_test.rb` (9). Companions:
> `backend-authoring.md` (the design this follows almost line for line),
> `../../reference/dsx-anatomy.md` (the document law it obeys), `OpenSource/Conformance/cli/`
> (the platform-neutral corpus that gates it).
>
> **In one sentence:** a command-line program is a `.dsx` document whose `<action>` bodies the
> host executes — the same grammar, lint, corpus and muscle memory as a tap handler — and the
> `dsx` toolchain itself now runs on it.

---

## 1 · Why this exists

The constitution says the kernel names no platform and that a surface is a set of seams
attached to one bus. That claim had been demonstrated four times (iOS, Android, web, server)
and every one of those is a screen or a request. A command-line program is neither, which
makes it the honest test: if a node really is "a seam table and nothing else", then adding one
with a completely different job should cost a seam table and nothing else.

It did. `packages/cli/src/declared.ts` is the only file that differs in kind from
`packages/server/src/actions.ts`, and the two are close enough to read side by side. Same
runner, same grammar, same conformance corpora, same lint, same error vocabulary. **That is
the result this document is really reporting**, and it is worth more than the feature: the
architecture claim is now falsifiable by anyone who reads two files.

The practical gap it closes is smaller but real. A CLI's command table is conventionally
written at least twice — once in the parser, once in the help text — and they drift. Every
`dsx` command, flag and summary now comes from one document, so a command cannot exist in the
help and not in the parser, or accept a flag the help never mentions.

## 2 · The document

Head = contract + logic; body = pure markup — the existing anatomy law, unchanged, because
**the structure of a CLI is its command surface** exactly as the structure of a server is its
route surface.

```dsx
<cli as="tool" version="1.0.0" summary="what it does">
  <head>
    <env as="HOME"/>                  <!-- names this program may read -->
    <exec as="git"/>                  <!-- programs it may run -->
    <root as="project" path="."/>     <!-- where it may touch the filesystem -->

    <action as="greet" inputs="name, loud">
      const who = name ? name : 'world'
      dsx.module.out.print({ text: loud ? who.toUpperCase() : who })
      return 0
    </action>
  </head>

  <command as="greet" action="greet" summary="say hello">
    <flag as="name" type="string" summary="who to greet"/>
    <flag as="loud" type="boolean" summary="shout it"/>
  </command>
</cli>
```

A command declares **exactly one** of `action=` (a declared JSE body) or `handler=` (a named
host function — the ejection hatch, identical in spirit to the server's TypeScript path).
Neither, or both, is a build abort: a command naming no implementation is the one shape that
looks complete and does nothing.

`inputs=` is a **checked contract**, not a comment. A body reads its arguments by bare name, so
a typo there does not fail — the name is simply absent and every branch reading it takes the
empty path. The reader pins the list against the command's declared flags and positionals, so
that silence becomes a build error.

## 3 · What a body can reach, and nothing else

| Seam | What it is |
|---|---|
| `dsx.module.out.{print,warn,error}` | stdout / stderr. Separate on purpose: a CLI whose diagnostics land on stdout cannot be piped |
| `dsx.module.env.read({ name })` | only the names this document declared |
| `dsx.module.fs.{read,write,list,exists}({ root, path })` | only inside a declared `<root>`; a path resolving outside it is refused |
| `dsx.module.exec.run({ name, args })` | only the programs this document declared |
| `dsx.module.<scheme>.<action>` | another module on the bus |
| `dsx.log` / `dsx.error` | the diagnostics plane |

There is no `import`, no `require`, no `process`, no `globalThis` and no member access into
host objects — **not by policy but by construction**: JSE is an interpreter over a closed
statement grammar, and a name it does not know is a name it cannot reach.

`dsx.component` / `dsx.route` / `dsx.screen` are surface namespaces and are a **lint error** in
a CLI document — a CLI has no router, so a body using them would silently do nothing.

### The difference from the server, stated plainly

A server body may not touch the filesystem, the environment or other programs. A CLI exists to
do exactly that. So instead of denying them, each is **declared**, and the trade is the one the
server already makes: declare it and you may reach it; what you did not declare is refused.

That is a genuinely weaker boundary than the server's, and it should be read that way. A
server's seam list is what makes third-party bodies co-tenantable; a CLI's is not doing that
job, because a CLI runs on your machine as you, with your privileges, the same as any program
you install. What the declaration buys here is **legibility and blast radius**: a reader can
see every file, variable and program a command can touch without reading its code, and
`--project` chooses the anchor, so a body physically cannot wander out of the directory it was
pointed at.

### Envelopes, and why a refusal does not throw

`await dsx.module.x.y(args)` settles to `{ ok: true, data }` or `{ ok: false, error }`. That is
the bus contract, identical to what the same call hands a tap handler, and keeping it is the
whole point — a body moves between a screen, a server and a command without learning new rules.
It also means a refused seam is **fail-open** by default, per the constitution's law that
absence degrades a feature rather than bricking the program.

A command that cannot do its job says so in one line, and the throw table turns it into an exit
code:

```js
const found = await dsx.module.fs.read({ root: 'project', path: 'dsx.json' })
if (!found.ok) { throw { reason: 'not_found', message: 'this is not a DSX project' } }
```

Without `await`, a call is fire-and-forget and evaluates to the absent marker. That is correct
for `out.print` and a bug anywhere a body reads the result.

## 4 · Exit codes

A body says how it ended and the host translates. Returning nothing is success, because the
common case should not need ceremony.

| Body did | Exit |
|---|---|
| returned nothing / `0` / `{ code: 0 }` | `0` |
| returned `n` or `{ code: n }` | `n` |
| threw `failed` | `1` |
| threw `invalid` / `bad_request` | `2` |
| threw `not_found` | `3` |
| threw `forbidden` | `4` |
| threw `unavailable` | `5` |
| threw `conflict` | `6` |
| threw `budget_exceeded` | `7` |
| threw anything else | `70` (EX_SOFTWARE) — a defect in the command, not a message to its user |
| argv did not match the declared shape | `2`, with the usage text |

## 5 · Budgets

The ceilings are minutes and millions rather than the server's seconds and thousands, because a
request that runs for ten seconds is broken and a build that runs for ten seconds is a build. A
caller may ask for less, never more.

They do not disappear, and the reason is worth stating: the runner **contains** a runaway loop
and lets the body carry on, which is right for a tap handler — a contained handler beats a
frozen screen — and wrong for a program whose stdout someone will pipe into another program. A
half-computed answer with exit `0` is the worst outcome available, so a blown budget is a
failure here exactly as it is on a request.

## 6 · Dogfooding: `dsx` runs on `dsx`

`OpenSource/Web/packages/cli/src/dsx.cli.dsx` is the shipped toolchain's command surface. It
declares `build`, `dev`, `lint` and `doctor`; `cli.ts` reads it at startup and dispatches from
it. The usage text, the command table and the set of value-taking flags are all **derived**
from it.

`build`, `dev` and `lint` keep `handler=`. They stream a watcher, hold a socket open and walk a
package tree through TypeScript that already exists and is already tested, and rewriting
working code to prove a point is not dogfooding, it is theatre. What matters is that they are
declared in the same place as everything else, so their argument contract and their help cannot
drift from the parser.

**`doctor` is the proof.** A real command doing real work with no author TypeScript anywhere:

```console
$ dsx doctor --project ./my-app
dsx doctor — ./my-app

  ok    dsx.json is present
  ok    dsx.json declares a scheme
  ok    dsx.config.json is present
  ok    dsx.config.json names an entry component
  ok    Components/ holds at least one .dsx
  ok    the entry component exists
  ok    @despia-native/kernel is installed

all checks passed — 1 component(s), scheme "myapp"
```

It reads JSON, filters a directory listing, calls a sibling action once per check, accumulates
a count in the store, writes passes to stdout and failures to stderr, and throws `failed` so
the shell sees a non-zero exit. Every one of those is ordinary DSX.

## 7 · What is deliberately not here

- **A Kotlin or Swift CLI host.** The corpus is platform-neutral by construction — every case
  is `(source, expected)` with no host types in it — so either can implement it without the
  fixtures being rewritten. Neither is written, and the honest position is the one the server
  node started from: `Conformance/actions` was TS-only before Kotlin and Swift joined. The
  unified-codebase law binds new *authoring surface* shipping to all three renderers; a node's
  *host* is a different thing, and the server is the precedent.
- **A Ruby document reader.** `lint_dsx.rb` owns the rule a reader cannot see — which names a
  body may mention — and the TypeScript reader owns structure. A malformed document cannot
  reach a user because `dsx` refuses to start on one.
- **Streaming, interactivity, prompts, colour.** A declared body prints lines and returns. When
  a command needs a TTY dance, that is what `handler=` is for.
- **`exec` beyond a declared name.** No shell string, ever. `exec.run` takes a program and an
  argument array, so there is nothing to quote and nothing to inject.

## 8 · Gates

```bash
cd OpenSource/Web
node --test packages/cli/test/document.test.ts     # the reader, over Conformance/cli/document.json
node --test packages/cli/test/dispatch.test.ts     # argv binding, over Conformance/cli/dispatch.json
node --test packages/cli/test/declared.test.ts     # the seams + exit codes, over Conformance/cli/seams.json
node --test packages/cli/test/dogfood.test.ts      # dsx running on dsx.cli.dsx
npm test                                            # picks all four up (it globs packages/*/test)

ruby ClosedSource/scripts/lint_dsx.rb --strict      # counts the cli document among its kinds
ruby ClosedSource/scripts/lint_dsx_cli_test.rb      # the body-name rules, proven on a bad body
```
