# `files` conformance

The corpus behind `Core/Files` (parity/F03-files.md). Four fixtures, one shared pure core.

| Fixture | Pins | Runners |
|---|---|---|
| `paths.json` | the root vocabulary, the per-platform base table, the path fold (normalise, THEN refuse an escape), the post-realpath containment check, and the `list` glob grammar | TS `packages/kernel/test/files-conformance.test.ts` · Kotlin `:core FilesPathConformanceTest` · Swift `Engine/iOS/DSXFilePaths.swift` (the reference implementation; no record-lane runner yet) |
| `errors.json` | every error code, its `recoverable` verdict, and the typed-absence roster per platform | TS + Kotlin |
| `operations.json` | the CRUD matrix: overwrite semantics, recursion, the directory/file confusions, the free-space pre-check | TS + Kotlin (structural: every action, code and path literal runs through the shared vocabulary and the real parser); the per-renderer facets are judged against the same expectations by the module manifest's `tests` block |
| `transfer.json` | progress cadence and monotonicity, the fraction arithmetic, resume, hash verification, the SETTLE TABLE (2xx resolves · any other status is `http_error` with the status on `data` · no answer is `network_failed`), and "a failure leaves no partial file at the destination" | TS + Kotlin (same structural gate) |

**`transfer.json`'s `settle` table is the answer to one question, asked once.** What decides a
transfer's outcome: THE STATUS, not the transport. Only 2xx resolves. The row set exists because
the iOS lane got it wrong in exactly the way the platform invites — URLSession stopped reporting
HTTP status as a task error in iOS 9, so a 404 arrives on `didFinishDownloadingTo` with the error
page already staged and a nil error on `didCompleteWithError`, and the naive implementation moves
that page to the caller's path and resolves. There is deliberately no `cancelled` row: `Core/Files`
exposes no cancel verb, so a transfer has no cancellation outcome to pin.

**`paths.json` is a security boundary, not a convenience fixture.** A path that escapes its root
must be refused identically on three renderers, so the fold lives in the kernel
(`DSXFilePaths` / `parseFilePath`) and every facet calls it rather than re-implementing it.
Traversal attempts of every shape are pinned as refusals: `../`, an absolute path, a `~`, a
backslash, a second root token, a NUL or control character, and percent escapes that decode to a
dot segment or a separator. `contains[]` is the second half, asked after the OS has resolved
symlinks: `/a/bc` is not inside `/a/b`, which is the prefix bug every hand-rolled check ships once.
