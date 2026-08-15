# Read-only mirror

This repository is generated from the Despia monorepo folder `OpenSource`
(commit `18407e1ac3fb51dd6e11e7f74a4f9a376c54a6d3`).

- Please do not open pull requests here. Changes land in the monorepo, where
  the engine conformance gates run, and the next sync replaces this tree.
- `conformance/`, when present, is a vendored copy of the shared corpus that
  the Swift reference and the Kotlin kernel also run; `npm test` runs it
  standalone here.
- Tags are cut automatically when the package version changes upstream.
