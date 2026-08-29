# lint/ — the three-runner lint anti-drift corpus

**STATUS: LIVE.** Implemented and wired since 2026-08-07; the shipped `dsx lint` joined as a
third runner on 2026-08-13.

`*.dsx` input + `*.expected.json` diagnostics, so a rule change cannot land green on one
runner and silently drift on another.

| File | Role |
|---|---|
| `facts.json` | the SHARED rule ground truth (doc 09 step 1): built-in tags, capitalized global element tags (kernel elements like `Table` that need no package component — the Ruby gate resolves them from the Swift Foundation pool, the repo's ground truth; the shipped CLI carries the tethered literal), code/declaration tags, head order and ranks, handler budgets, identifier tags, keyed collections. Edit it and every runner that loads it changes at once |
| `cases/shared/*.dsx` + `.expected.json` | the rules all runners own — run on all three |
| `cases/web/*` | the WEB-ONLY rules (the doc 05 `<api>` flags, the doc 04 route-table checks) — TS side only |

## The runners

| Runner | Command | Notes |
|---|---|---|
| **Ruby** — `ClosedSource/scripts/lint_dsx.rb`, the authoritative repo gate | `ruby ClosedSource/scripts/lint_conformance.rb` | wired into the codemagic gate chains beside `lint_dsx.rb --strict` |
| **TS dev-loop twin** — `OpenSource/Web/packages/compiler/src/lint.ts` | `npm test` (`compiler/test/lint.test.ts`) | loads `facts.json` at runtime; repo-anchored, deliberately not exported from the package index |
| **TS shipped CLI** — `OpenSource/Web/packages/cli/src/lint.ts` (`dsx lint`) | `npm test` (`cli/test/lint-corpus.test.ts`) | ships in `@despia/cli` and must run with no repo checkout, so its rule tables are LITERALS; the test tethers them by asserting `BUILTIN_TAGS` equals `facts.json`'s `builtinTags` exactly |

The third runner exists because a literal copy of a rule table is precisely the thing that
drifts — and it had. The shipped linter was missing twelve tags `facts.json` and the Ruby
gate both carried, with every gate green, because nothing compared the copy to the source.

## The comparison

`(line, level, rule)`. Message **wording is deliberately uncompared**, so any runner may
improve its prose freely; each runner maps its own messages to the corpus rule IDs by the
stable phrase that names the defect (`RULE_MAP` in `lint_conformance.rb`, ported into
`cli/test/lint-corpus.test.ts`).

Findings outside the corpus-pinned ruleset are uncompared here — every linter checks far
more than the corpus pins. Those stay covered by each runner's own suite and by the Ruby
gate's repo-wide green run, which remains authoritative for everything beyond this corpus.
