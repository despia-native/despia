# Conformance — build expressions

The corpus behind **build-time JSE expressions** in `{{ }}` manifest placeholders
(`dsx.json` / `config.json`). Contract: `OpenSource/Documentation/architecture/build-expressions-spec.md`;
rationale: `architecture/proposals/build-expressions.md`.

## Runners — and the three-renderer-law exemption

Build expressions are **erased at build and never reach a device**, so the monorepo working rules'
three-renderer law does not apply to *this* corpus: there is no runtime behaviour for
Kotlin or Swift to match. (The *language* being evaluated is already pinned on all three
renderers by `../jse/` — this folder covers only the build-side contract on top of it.)

Two runners, both per-PR:

| File | Contract | Runners |
|---|---|---|
| `classification-001.json` | path vs expression vs escaped-literal split (spec §2) | `ClosedSource/scripts/build_expressions_test.rb` (Ruby owns classification) |
| `evaluation-001.json` | evaluator semantics: context roots, determinism bans, the node-side `BX` errors (spec §3–§8) | `OpenSource/Web/packages/kernel/test/build-expressions.test.ts` (drives the real CLI over stdin) **and** `build_expressions_test.rb` (drives the same CLI through the Ruby batch layer) |

Position rules, the per-target type-mapping matrix, and the Ruby-side errors
(`BX06`/`BX07`/`BX08`/`BX09`/`BX11`) live in `build_expressions_test.rb` alone — both
consuming pipelines (iOS + Android prepare) share the one Ruby implementation, so a
second runner would re-test the same code, not a twin.

## Fixture shape

`evaluation-001.json` cases:

```jsonc
{ "name": "domains-derivation",
  "source": "config.domains.flatMap(h => ['applinks:' + h])",   // the {{ }} body
  "context": { "config": {…}, "app": {…}, "env": {…},
               "platform": "ios", "modules": ["app", "dom"] },   // all five roots, always
  "expect": { "ok": true, "value": ["applinks:example.com"] } }  // or { "ok": false, "code": "BX05" }
```

`classification-001.json` cases: `{ "name", "body", "kind": "path" | "expression" }` —
the body is the text between `{{` and `}}`, already extracted; escaped-`{{` handling is
covered by the `strings` section (`{ "string", "spans", "literal" }`), since escaping is
a property of the surrounding string, not of a body.

Failure expectations pin the **code**, not the message — messages may sharpen without a
corpus change; codes are frozen API (spec §8).
