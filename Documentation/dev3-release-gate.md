# DEV 3.0 strict release gate

From the repository root, run one command:

```sh
node scripts/dev3-release-gate.mjs
```

The default command is safe for a macOS File Provider workspace. It takes a read-only
snapshot of the development candidate, creates an independent checkout under the local
system temporary directory as `despia-dev3-*`, applies the exact staged-and-unstaged tracked binary patch, and copies
every relevant untracked production-source file. It verifies a SHA-256 source identity
before running anything. It never stages, deletes, or rewrites files in the working copy.

The gate installs the lockfile-pinned web dependencies in that disposable checkout, performs
a complete environment preflight, and stops at the first failure. Its 14 ordered stages are:

1. Web conformance corpus
2. Complete web production tests
3. Demo production build
4. Crate Blaster winning playthrough
5. 3D browser/physics oracle
6. 2D sprite/physics oracle
7. Unified-input browser oracle
8. Bounded 2D/3D mass-scene certification
9. Sustained 2D/3D soak certification
10. Kotlin engine corpus
11. Swift RecordMain corpus and drift check
12. Android APK assembly
13. Selected-module graph materialization, idempotence proof, strict icon generation, and CocoaPods workspace verification
14. iOS Runtime simulator build

The stress and soak stages reuse the single demo build. The bounded soak defaults to its
production-safe 45-second minimum; use `DSX_SOAK_DURATION_SECONDS` to require a longer
release soak. After all stages pass, the gate recomputes the identity of both the disposable
checkout and the original candidate. It cleans the disposable checkout before printing the
release verdict. A changed source tree, failed cleanup, or mismatched identity can never
print `RELEASED`.

Every stage has a hard deadline (5–10 minutes for the functional browser lanes, the requested
soak duration plus a five-minute margin, and up to 35 minutes for native builds), plus a three-hour overall deadline configurable through
`DEV3_GATE_TIMEOUT_MINUTES`. A timed-out command receives `SIGTERM` as a process group and
then `SIGKILL`, so an oracle cannot leave an orphan browser or server. Timeout exit 124
fails the candidate.

```text
RESULT: RELEASE GATE PASSED — RELEASED source sha256:<identity> from <commit>
```

Inspect the plan and detected Node, browser, JDK, Android SDK, Xcode, and simulator setup
plus the lockfile-exact CocoaPods version and candidate provenance without creating a
checkout or running a gate. A CocoaPods generator-version mismatch fails preflight before
the expensive stages:

```sh
node scripts/dev3-release-gate.mjs --dry-run
```

Partial diagnostics require an explicit subsystem name: `--skip-web`, `--skip-browser`,
`--skip-kotlin`, `--skip-swift`, `--skip-android`, or `--skip-ios`. There is deliberately
no `--skip-all` or implicit platform skip. A partial run may pass its active checks, but
finishes `NOT RELEASED` with exit status 2. A gate failure or missing prerequisite exits 1;
invalid command-line usage exits 64.

## Source provenance and cleanliness

The identity includes the exact `HEAD`, complete binary tracked patch, and sorted
path/type/mode/content hashes of relevant untracked files under `.github`, `OpenSource`,
`ClosedSource`, root `scripts`, `codemagic.yaml`, and `settings.example.env`. Untracked files
outside those production scopes are reported but not copied. File Provider conflict-copy-like
paths such as `Foo 2.swift` are also reported and excluded; all excluded files remain untouched.
Unresolved merges and tracked-patch whitespace errors fail source preflight.

The default command and explicit alias below support an uncommitted development candidate:

```sh
node scripts/dev3-release-gate.mjs --local-stage
```

Clean CI checkouts may avoid the local copy with `--direct-clean`. That mode hard-fails if
there is any tracked delta or included untracked production source, and it still verifies
source identity after the gate:

```sh
node scripts/dev3-release-gate.mjs --direct-clean
```

The browser defaults to Playwright Chromium. When needed, set
`DSX_BROWSER_EXECUTABLE=/absolute/path/to/Chrome`. The gate selects a Gradle-compatible JDK
17–24 (JDK 21 preferred) and exports the discovered Android SDK to both standard variables.
The complete release command must run on macOS because Swift RecordMain and the iOS build
are mandatory.

Run the fast orchestration tests from the repository root with:

```sh
node --test scripts/dev3-release-gate.test.mjs
```
