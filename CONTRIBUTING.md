# Contributing to Despia

Thanks for wanting to make Despia better. This document is the whole process: how code flows,
where issues live, what a good report looks like, and what we promise back.

## How the repositories work

The public `despia` repository is a generated, read-only mirror of the Despia monorepo. That is
a deliberate layout (the same one Kubernetes and Chromium use for staged trees): one source of
truth, one public front door. It changes where things happen:

- **Issues and feature requests**: open them on `despia-native/despia`. That is the single
  tracker for the framework, all platforms.
- **Pull requests**: open them on `despia-native/despia` as usual. A maintainer imports your
  patch into the monorepo with your authorship preserved (`Co-authored-by` or direct
  authorship via `git am`), the full gate suite runs there, and the next mirror sync closes
  your PR with a reference to the landed commit. Your name stays on the commit.
- **Do not** open PRs against the standalone package repositories (`despia-kernel`,
  `despiabase`, `despia-ai`, `despia-mcp`). They are machine-written; anything pushed there
  is overwritten on the next sync.

## Before you open an issue

1. Search existing issues, including closed ones.
2. For bugs: reproduce on the latest release. Include the version (`dsx doctor` prints it),
   the platform (iOS, Android, web, server, CLI), and a minimal `.dsx` document or repo that
   shows the problem. A reproduction is the difference between a fix this week and a stall.
3. For feature requests: describe the outcome you need, not only the mechanism you imagine.
   The maintainers map requests onto the architecture, and the outcome is what survives that
   mapping.
4. Security problems never go in a public issue. See `SECURITY.md`.

## What makes a change land

Despia is corpus-driven: the three renderers (Swift, Kotlin, TypeScript) are held identical by
shared conformance fixtures. That shapes contributions:

- **New authoring surface ships on all three renderers, fixtures first, or it does not ship.**
  A new element, attribute, or builtin starts as a platform-neutral fixture under
  `Conformance/`, then the TypeScript implementation, then the Kotlin twin, then the Swift
  twin. If you can only do one leg, say so in the PR; a maintainer can pick up the twins, but
  the fixture is the part we cannot write for you, because it encodes what you meant.
- **Match the existing conventions.** The codebase style wins over personal preference.
- **Tests are part of the change**, not a follow-up.
- **Keep diffs focused.** One concern per PR. Refactors ride alone.

## Sign-off

We use the Developer Certificate of Origin (DCO). Add `Signed-off-by: Your Name
<you@example.com>` to each commit (`git commit -s`). It certifies you have the right to submit
the code under the project licence; there is no CLA and no copyright assignment.

## Versioning and releases

Versioning follows `Documentation/RELEASING.md` in this tree, and the short form is:

- Every package starts at `0.0.x`: no compatibility promised between patches, honestly.
- `0.1.0` means the shape is settled; breaking changes then bump the minor.
- `1.0.0` means the API is a contract and full semver applies.
- Releases are signed tags (`v<version>`), each with a GitHub Release whose body is the
  matching `CHANGELOG.md` section.
- Patch releases during `0.x` are cut from the latest minor only. Security fixes are
  backported to the latest published minor; older lines do not receive patches until `1.0`.

## Conduct

The project follows the Contributor Covenant; see `CODE_OF_CONDUCT.md`. Reports go to
conduct@despia.com and are handled confidentially.

## Licence

The framework is licensed under the Apache License 2.0, and every distributed folder
carries its own `LICENSE` file. By contributing you agree that your contributions are
licensed under the licence of the folder you are contributing to.
