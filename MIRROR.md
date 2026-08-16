# Read-only mirror

This repository is generated from the Despia monorepo folder `OpenSource`
(commit `15d58511c35680dce10bb322d5568b21b73505a6`).

- Please do not open pull requests here. Changes land in the monorepo, where
  the engine conformance gates run, and the next sync replaces this tree.
- `conformance/`, when present, is a vendored copy of the shared corpus that
  the Swift reference and the Kotlin kernel also run; `npm test` runs it
  standalone here.
- Tags are cut automatically when the package version changes upstream.
