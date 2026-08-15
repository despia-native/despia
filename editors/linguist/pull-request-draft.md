<!--
  DRAFT PR body for the github-linguist/linguist submission (see README.md in
  this folder for the playbook and when to submit). Linguist rejects PRs that
  don't use their template — this is their template with our answers filled
  in and the non-applicable sections removed, as the template instructs.
  Fill every TODO the day you submit.
-->

## Description

This PR adds **DespiaScript** (`.dsx`), the markup + logic document format of
the [Despia](https://despia.com) native app framework. A `.dsx` file is XML
markup with `{{ JavaScript }}` expressions and inline JSON: the head declares
the document's contract, state, and logic (`<variable>`, `<action>`, `<api>`
blocks) and the body is pure markup, rendered natively on iOS, Android, and
the web by the framework's three engines.

- Grammar: <https://github.com/despia-native/vscode-dsx> (Apache-2.0), scope
  `text.dsx` — XML tokenization with the JavaScript grammar injected inside
  `{{ … }}` blocks.
- The extension is not currently claimed by any language in `languages.yml`.

## Checklist:

- [x] **I am adding a new language.**
  - [x] The extension of the new language is used in hundreds of repositories on GitHub.com.
    - Search results for each extension:
      - TODO: <https://github.com/search?type=code&q=NOT+is%3Afork+path%3A*.dsx>
      - TODO: <https://github.com/search?type=code&q=NOT+is%3Afork+path%3A*.dsx+vstack>
  - [x] I have included a real-world usage sample for all extensions added in this PR:
    - Sample source(s):
      - <https://github.com/despia-native/canvas-editor/tree/main/samples>
      - TODO: add the individual file URLs for each sample committed to `samples/DespiaScript/`
    - Sample license(s): Apache-2.0
  - [x] I have included a syntax highlighting grammar: <https://github.com/despia-native/vscode-dsx>
  - [x] I have added a color
    - Hex value: `#FF2D55`
    - Rationale: Despia's documented `accent` color token default (sRGB
      255,46,84) — the framework's signature color, used throughout its
      reference documentation and default theme.
  - [ ] I have updated the heuristics to distinguish my language from others using the same extension.
    - Not applicable: `.dsx` is not used by any language in `languages.yml`
      (TODO: re-verify against `main` on submission day; if the extension has
      been claimed since, add heuristics and check this box).
