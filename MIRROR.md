# Read-only mirror

This repository is generated from the Despia monorepo folder `OpenSource`
(commit `4cf21428379ae5e3c1d3b949a1297963fa0185f7`).

- Please do not open pull requests here. Changes land in the monorepo, where
  the engine conformance gates run, and the next sync replaces this tree.
- `conformance/`, when present, is a vendored copy of the shared corpus that
  the Swift reference and the Kotlin kernel also run.
- Tags are cut automatically when the package version changes upstream.
- Documentation may reference monorepo paths: a path written `OpenSource/X`
  corresponds to `X/` in this repository, and `ClosedSource/...` refers to the
  commercial layer, which is not part of this tree.
