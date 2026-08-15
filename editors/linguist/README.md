# DespiaScript on GitHub - the Linguist submission kit

**Goal:** GitHub shows `.dsx` files as **DespiaScript** - in the repo language
bar, in PR diffs, in `language:DespiaScript` search - with our own grammar
(including the `{{ JS }}` injection) instead of plain XML.

**Why this needs an upstream PR:** the language bar and highlighting come from
[github-linguist/linguist](https://github.com/github-linguist/linguist), and a
repo-local `.gitattributes` `linguist-language=` override can only name a
language that already exists in Linguist's `languages.yml`. There is no
per-repo way to display a custom language name. Until DespiaScript is merged
upstream, the root `.gitattributes` maps `*.dsx` to XML - that is the ceiling.

## Status - 2026-07-16

| Piece | State |
|---|---|
| `.dsx` extension in Linguist | ✅ **Unclaimed** - no extension, name, or alias matches `dsx`/`despia` in `languages.yml` @ `main` (re-verify at submission) |
| Grammar (public, licensed) | ✅ Ready in-repo: [`../vscode-dsx/`](../vscode-dsx/) (Apache-2.0, scope `text.dsx`), mirrors to `despia-native/vscode-dsx` - needs the one-time mirror setup below |
| Samples (public, licensed) | ✅ Three public Apache-2.0 samples in `OpenSource/CanvasEditor/samples/` (live at [despia-native/canvas-editor](https://github.com/despia-native/canvas-editor)), deliberately varied so the grammar is exercised rather than merely present: `meals.dsx` (dashboard layout, computed state), `releases.dsx` (full head anatomy: attribute/api/variable/formula/action/watch, remote data, empty + error states), `checkout.dsx` (the form element family: textfield/toggle/picker/stepper/slider, per-row formulas, inline validation). All three lint clean under `lint_dsx.rb --strict` |
| **Usage threshold** | ❌ **The blocker.** Linguist wants wide in-the-wild usage before accepting a language (see Gate 1) |

## Gate 1 - usage in the wild (the real blocker)

From Linguist's CONTRIBUTING: a new language needs roughly **2,000+ files**
using the extension on public GitHub, indexed in the last year, **excluding
forks**, with a reasonable spread across unique `user/repo` combinations
(200+ for once-per-repo filenames - not our case; `.dsx` appears many times
per project).

Monitor with the search the PR must link (add DSX keywords to filter out
noise once other `.dsx` uses appear):

- <https://github.com/search?type=code&q=NOT+is%3Afork+path%3A*.dsx>
- <https://github.com/search?type=code&q=NOT+is%3Afork+path%3A*.dsx+vstack>

What moves the needle - only **public** repos count:

- Despia user projects pushed to public GitHub (every exported app with
  `.dsx` files counts toward the spread of unique repos).
- Publishing `vscode-dsx` to the VS Code Marketplace / Open VSX (drives
  adoption and makes the language legible to reviewers).
- Public examples, templates, and starters from us.

**Do not submit early** - under-threshold language PRs get closed, and a
closed PR is a worse starting position than a fresh one.

## Gate 2 - the public grammar repo (one-time setup)

Linguist vendors grammars as submodules from public repos with a detectable
approved license. Ours is the `vscode-dsx` extension folder, which carries a
[`mirror.json`](../vscode-dsx/mirror.json) so the standard mirror lane
publishes it - same machinery as `OpenSource/CanvasEditor` →
[despia-native/canvas-editor](https://github.com/despia-native/canvas-editor).

One-time steps (an operator with org + Codemagic access):

1. Create the empty public repo **`despia-native/vscode-dsx`** (no README -
   the mirror replaces the tree anyway).
2. Extend **`MIRROR_PUSH_TOKEN`** (the fine-grained PAT used by the
   `mirror-public` Codemagic lane, contents:write on mirror repos only) to
   cover the new repo.
3. Run the `mirror-public` lane (or locally:
   `ruby ClosedSource/scripts/mirror_public.rb OpenSource/editors/vscode-dsx`).
   The gate `ClosedSource/scripts/check_vscode_dsx.rb` must be green; the
   push cuts tag `v0.0.1` from `package.json`.
4. Optional but recommended: `vsce publish` from the mirror checkout
   (publisher `despia`) to put it on the Marketplace.

## The submission, step by step

When Gate 1 clears (and after re-verifying `.dsx` is still unclaimed -
`grep -in 'dsx' lib/linguist/languages.yml`):

1. **Fork** `github-linguist/linguist`, create a branch.

2. **Register the grammar** (adds the submodule + license check):

   ```sh
   script/add-grammar https://github.com/despia-native/vscode-dsx
   ```

3. **Add the language** to `lib/linguist/languages.yml` (alphabetical order,
   no `language_id` yet):

   ```yaml
   DespiaScript:
     type: markup
     color: "#FF2D55"
     extensions:
     - ".dsx"
     aliases:
     - dsx
     tm_scope: text.dsx
     ace_mode: xml
     codemirror_mode: xml
     codemirror_mime_type: text/xml
   ```

   `tm_scope` must equal the grammar's `scopeName` (`text.dsx` - guarded on
   our side by `check_vscode_dsx.rb`). `ace_mode`/`codemirror_mode` are the
   closest built-in editor modes; XML is correct for DSX markup.

4. **Generate the language id:** `script/update-ids`.

5. **Add samples** to `samples/DespiaScript/` - real-world files only
   ("hello world" samples are explicitly rejected), license must be stated.
   Use the public Apache-2.0 pool:

   ```sh
   cp <despia>/OpenSource/CanvasEditor/samples/meals.dsx samples/DespiaScript/
   # + whatever else lives in CanvasEditor/samples/ by then - 2-3 varied files
   ```

   Sample provenance URL for the PR:
   <https://github.com/despia-native/canvas-editor/tree/main/samples>.

6. **Heuristics:** none needed while `.dsx` is unclaimed. If another language
   has claimed it by then, add a disambiguation heuristic to
   `lib/linguist/heuristics.yml` (a `{{ … }}` interpolation or
   `dsx.variable.` regex is a strong DSX tell) and include ≥2 samples per
   contending language.

7. **Run the suite** (validates the yml, color distinctness, samples, grammar
   licensing): `script/bootstrap && bundle exec rake test`. If the
   color-proximity check objects to `#FF2D55` (nearby reds exist, e.g.
   Scala's `#c22d40`), nudge the shade rather than abandoning the brand hue.

8. **Open the PR** using [`pull-request-draft.md`](./pull-request-draft.md) -
   fill the TODOs (fresh search links, sample URLs) the day you submit.

## Color

`#FF2D55` - Despia's documented `accent` color token default
(`OpenSource/Documentation/reference/StackReference.md`: "`accent` =
`#FF2D55` (sRGB 255,46,84)"). That's the rationale the PR template asks for:
the framework's signature accent, not an arbitrary pick.

## After the merge

- The language ships with the **next Linguist release**, and github.com picks
  that up on its own deploy cadence - historically weeks to a couple of
  months. Nothing to do but wait.
- **Delete the `*.dsx linguist-language=XML` line from the root
  `.gitattributes`** (and tell users with their own overrides to do the
  same) - once DespiaScript exists, the override would keep forcing XML and
  suppress the real grammar.
- `.dsx` then highlights with our grammar everywhere on GitHub, the language
  bar shows **DespiaScript** with the `#FF2D55` dot, and
  `language:DespiaScript` works in search.
