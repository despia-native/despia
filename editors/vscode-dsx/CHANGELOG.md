# Changelog

## 0.0.1 - 2026-07-16

Initial release.

- TextMate grammar for DSX / DespiaScript (`.dsx`), scope `text.dsx`: XML
  markup colouring (tags, attributes, strings, comments, entities) with the
  JavaScript grammar injected inside every `{{ … }}` block, so expressions and
  object/array literals highlight as real JS.
- Language configuration: `<!-- -->` comments, bracket pairs, auto-closing
  (including `{{ }}`), surrounding pairs.
- This repository is also the grammar source vendored by GitHub Linguist for
  DespiaScript.
