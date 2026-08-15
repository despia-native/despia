# Documenting a module

One short doc per module, written for the web developer who will *call* it.
Not a spec, not a tour of the framework. Most modules need half a screen.

## Where it goes

- A `README.md` **in the module folder** (`DSX/Modules/.../<Name>/README.md`), so
  the doc travels with the module. Disable or delete the module and the doc
  goes with it. The build already keeps `**/*.md` out of the app bundle, so a
  co-located doc costs nothing at runtime.
- How the module is built or wired → a comment in the code, or a link to the
  shared skills. Not the doc.

## What goes in

Title the doc with the modern face: `# <Name> (\`dsx.module.<scheme>\`)`. Lead
with a copy-paste example in the **modern default form — the dot API**,
`await dsx.module.<scheme>.<method>({ …JSON… })` (e.g.
`dsx.module.calendar.add({ title, start, end })` — the page surface is
`window.dsx`, the same `dsx.module` call root markup and native use). That's the
form to show everywhere. The legacy `window.despia.<scheme>.<method>(…)` alias
spelling stays documented in a clearly-labeled legacy/alias mention (compat is
documented history, never deleted); mention the
`window.despia("scheme://method", {…})` string form only as the escape hatch /
legacy path when a module needs it (deep links, dynamically-named methods,
back-compat). Then only what a caller can't guess on their own:

- the scheme + actions, params (with defaults), what comes back, error codes;
- gotchas that actually bite: permissions, device/OS support, call ordering.

Expose real **`scheme.action`s**, not a "scheme-only" scheme — actions are what make
the module callable as `dsx.module.<scheme>.<action>()`, the same face on the page
(`window.dsx`), in markup, and in native Swift (the only way one module drives
another); legacy pages spell it `window.despia.<scheme>.<action>()`. A scheme with
no action can't be named in that dot chain.

## Cross-module use (required if other modules call you)

If another module drives yours in Swift (`dsx.module.<scheme>.<action>()`), add a short
**Cross-module** section showing those calls: `try?` for fire-and-forget, `try await` for a
result, and what happens when your module is excluded from the build.
`Core/AppsFlyer/README.md` is the model; the three call shapes live in
`cross-module-calls.md`.

## What stays out (this is the bloat)

- **Framework re-explanation.** `dsx`, `window.despia`, the bridge, promises,
  the JSON shape. Link the skills, don't re-teach them in every doc.
- **Implementation detail.** Class names, file layout, internal helpers. It
  rots, and the code is already the source of truth.
- **The same fact three times** as prose *and* a table *and* an example. Pick
  the one that's clearest and stop.
- **Ceremony.** "Observable contract" preambles, empty "Overview"/"Notes"
  headers, exhaustive hedging, a section per heading whether or not it has
  anything to say.

## Voice

Write like you're telling a teammate how to use it. Plain sentences,
contractions, active voice. Reach for a table only when the data is genuinely
tabular (a param or enum list). If a paragraph reads like a press release or a
generated API dump, rewrite it in your own words.

**No em dashes** (`—`). They read as AI-generated. Use a period, a comma, a
colon, or parentheses instead. Same goes for "elegant", "seamless", "robust",
and the rest of the marketing vocabulary.

## The size check

If the doc is longer than the module is interesting, you're documenting the
framework, not the module. Link, don't duplicate. When in doubt, cut.

See `DSX/Modules/Core/Basics/Haptics/README.md` for the target shape.

## Checked by `lint_docs.rb`

`ClosedSource/scripts/lint_docs.rb` keeps this honest for every callable module (a `dsx.json` with a
`scheme`): a co-located `README.md` exists, it shows a dot-API form — the modern
`dsx.module.<scheme>.*` or the legacy-alias `window.despia.<scheme>.*` (not only `scheme://`) — and a scheme
that other modules call carries a Cross-module section. Findings are warnings today (the
backlog lives in `ClosedSource/Documentation/audits/package-scorecard.md`); run
`ruby ClosedSource/scripts/lint_docs.rb --strict` to make them block once it's clear.
