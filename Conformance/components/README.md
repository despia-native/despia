# components/ — the Foundation component folds

One fixture per markup component, three runners. Each fixture executes the **shipped `.dsx`
file itself**, not a copy of its logic.

| Runner | Reads | Runs |
|---|---|---|
| TS | `OpenSource/Web/packages/compiler/test/component-fold-conformance.test.ts` | per-PR (`npm test`) |
| Kotlin | `:core ComponentFoldConformanceTest` | per-PR (`gradle test`, SDK-free) |
| Swift | `ComponentFoldConformance` | record lane |

## Why the component and not a pure core

Every other corpus here calls a pure function that three kernels implement three times
(`resolveDuration`, `KeyboardViewport.resolve`, `SnackbarQueue.apply`). A markup component has
no such function: its law lives in the `<variable computed="true">` and `<formula>` bodies of
its own head, and those bodies are the ONE implementation that all three renderers execute.
Extracting them into a kernel core would create a second owner of the same decision, which is
the thing the constitution refuses.

So the harness mounts the head. It parses the document with the runtime's own XML reader,
registers the head exactly as the renderer's head walk does — attribute defaults, then head
functions, then computed variables, then parameterized `<formula>`s — and evaluates the
fixture's expressions against that store. The renderers' head walks are
`dom/src/mount.ts`, `StackNodeView.kt` (`"variable" | "formula" | "attribute"`) and
`Stack.swift`'s `StackHead`; the harness mirrors those ten lines and nothing else, because
everything below them is body rendering, which a screenshot test judges.

## Fixture shape

```jsonc
{
  "version": 1,
  "component": "Pagination",
  "source": "ClosedSource/DSX/Modules/.../Pagination.dsx",
  "_note": "the law this fixture encodes, and why",
  "css": [ { "name": "…", "file": "…", "ordered": ["@media (…)", ".dsx-x", "display: none"] } ],
  "cases": [
    {
      "name": "…",
      "attributes": { "total": "482" },     // the string plane, as markup delivers it
      "vars":       { "spotlightIndex": 0 }, // non-computed <variable> state a case needs
      "item":       { "n": 3 },              // the list-row scope, for <formula> cases
      "expect": [ { "expr": "dsx.variable.paginationCells", "value": [ … ] } ],
      "root":   [ { "attr": "a11yLabel", "value": "Pagination, page 7 of 20" } ]
    }
  ]
}
```

- **`expect`** evaluates a JSE expression against the mounted head. `dsx.variable.x` reads a
  computed variable; `dsx.formula.x` runs a parameterized formula over `item`.
- **`root`** interpolates an attribute of the component's ROOT element (`JSE.interpolate`,
  the same call the renderer binds with). This is where the accessibility contract is
  pinned — at the element a user actually meets, not at a variable the markup might have
  forgotten to spend.
- **`css`** requires fragments to appear in order in a companion stylesheet. It exists for
  guarantees that live on the style plane rather than in a fold; today that is
  `<Confetti>`'s reduced-motion rule, which every renderer evaluates.
- Numbers compare numerically and `NSNull` compares equal to `null`, because Kotlin hands
  back Doubles and the three JSE runtimes spell present-null differently.

The only legitimate skip is a genuine open drop with no `ClosedSource/` tree. A missing
fixture, a missing document or an empty case list is a loud failure.

## What these fixtures caught

Written after the ten components shipped, and red on four of them immediately. All four were
invisible to `lint_dsx`, to the compiler and to a reading of the source, and all four were
the same class of mistake — assuming a computed value is JavaScript.

1. **A computed value has no loop grammar.** `JSEval` (the evaluator behind
   `<variable computed="true">`, `<formula>` and every lambda body) runs declarations,
   `if`/`return` and expressions. `for` and `while` are ACTION grammar, executed by the
   action runner with its loop budget — they are not in a pure value, and a local array does
   not mutate. `<Pagination>` rendered zero page buttons, `<CodeBlock>` rendered an empty
   block, `<Diff>` reported every line as changed, and `<AvatarGroup>`'s `+N` overflow disc
   never appeared. All four now fold with `map` / `filter` / `concat` / `flatMap` / `reduce`.
2. **`Array.from` does not take a Set.** It takes an array or an `{ length: n }` array-like,
   on all three runtimes. `[...set]` is the spelling that works.
3. **`value` is a reserved `<formula>` input name on the web compiler** and is dropped there
   while the native readers keep it, so `<Rating>`'s glyph formula read null on web and the
   right number on iOS and Android — every star drew empty on one renderer only.
4. **A list-row field must never be named after an attribute of its own component.** JSE
   resolves `dsx.attribute.x` against the row scope first, so `<Pagination>`'s cells carrying
   a `page` field shadowed the `page` attribute: every button read its own number as the
   current page, so all of them rendered selected and all of them announced the current-page
   suffix.

Adding a case here is the first step of any change to one of these components, on any
platform.
