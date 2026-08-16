# DSX framework on Windows - app release boundary

Windows ships the shared Compose Desktop host as two native `jpackage`
containers: MSI and EXE. The JVM, DSX kernel, and renderer are bundled; an end
user does not install Java. Windows packages are built on a Windows runner,
because `jpackage` intentionally cannot cross-package MSI/EXE from macOS or
Linux. The verification scripts require PowerShell 7, matching the pinned
`windows-2025` runner.

The production lane is `.github/workflows/windows-desktop.yml`. Its neutral defaults are
`dev.dsx.runtime` / `DSX`; an application release can provide these repository variables without
forking framework source:

- `DSX_DESKTOP_APP_ID` - 2-128 letters, digits, dots, or hyphens; canonicalized to lowercase;
- `DSX_DESKTOP_TITLE` - product, launcher, installer, and native-window title;
- `DSX_DESKTOP_BUILD` - packaged runtime build identity (defaults to the Actions run number);
- `DSX_DESKTOP_ENTRY` - optional repository-relative `.dsx` entry; empty selects the bundled starter;
- `DSX_DESKTOP_ASSETS` - optional repository-relative asset directory; empty packages no app assets.

Both the ordinary MSI/EXE build and the tag-only signed `createDistributable` build receive the
same five explicit Gradle properties. The build job validates and exports the canonical values;
the signing job consumes those immutable job outputs. App entry/assets paths are forward-slash,
repository-relative, traversal-free inputs and are revalidated by Gradle before packaging.

Every change builds and checks the shared desktop module, creates both installers, validates
their container structure, and exercises the MSI and EXE as independent release surfaces. The
MSI harness performs a per-user install, runs the packaged kernel self-test twice (fresh install
and Windows Installer repair), opens a real visible native window, and uninstalls it. Before any
MSI mutation, the harness uses
`MsiQueryProductState` to require that the candidate ProductCode is unregistered, so it cannot
repair or remove a pre-existing product on the runner. It marks the install attempt before
launching `msiexec`, performs emergency cleanup after partial failures, and requires the final
product state to return to unregistered after uninstall. A tag matching `vMAJOR.MINOR.PATCH`
creates the application image first, preserves valid timestamped vendor
signatures, detects every PE by its header regardless of filename, requires each one to be x64,
Authenticode-signs every otherwise-unsigned PE (and always the application launcher), builds
MSI/EXE from that signed image, and then signs the outer
installers. The signed install is checked byte-for-byte against the payload
manifest; every installed native binary must have a valid timestamped signature
and `<app-title>.exe` must match the pinned publisher thumbprint. Product, payload,
installer, launcher, window, build, entry, and assets checks all use the resolved app
configuration rather than hard-coded DSX display identity. Before signing and after both install
and repair, a fail-closed inspector reads `app/<app-title>.cfg` and requires exact
`dsx.app.id`, title, version, build, identity-lock, and optional entry-resource JVM properties.
It also requires exactly one `app.mainclass=despia.engine.desktop.DesktopHostKt`, forbids
`app.mainjar`, accepts only individual canonical `$APPDIR\<file>.jar` `app.classpath` records, and
requires the complete pinned Compose 1.10.3 JavaOptions multiset: package version, Compose Swing
globals, exact DSX identity options, optional fixed entry, and `$APPDIR` Skiko library path. Missing,
duplicate, or additional options fail, including classpath switches, `javaagent`/`agentpath`, boot
classpath, and module-patching startup injection. Every selected JAR manifest is parsed
case-insensitively with continuation handling and must not define `Class-Path`. Exactly one selected
JAR must own `despia/engine/desktop/DesktopHostKt.class`; a dependency cannot shadow the native
host entry point. The inspector then follows that exact classpath, rejects shadowed DSX resources, and compares
the exact LF-only `/dsx/AppIdentity.properties` contract plus the path/size/SHA-256 inventory for
`/dsx/AppEntry.dsx` and `/dsx/app-assets/**` with the repository inputs. The identity resource and
launcher options must independently agree on app ID/title/version/build/lock/entry, while the
identity's assets prefix must agree with the packaged asset selection. The signed payload manifest
records this derived evidence and the install smoke
compares it with the installed configuration and JARs; it does not treat workflow `Expected*`
values copied into a manifest as packaging proof. The MSI upgrade UUID is the same
Java-compatible name UUID Gradle derives from `dev.dsx.desktop:<canonical-app-id>`, so unrelated
white-labelled apps cannot upgrade or uninstall one another. Both SHA-256 manifests
are covered by GitHub build provenance.

`Test-DsxWindowsExeLifecycle.ps1` drives the jpackage EXE itself, never substitutes the sibling
MSI for lifecycle success, and refuses to start if the deterministic app upgrade UUID already has
any registered product or either target shortcut already exists. CI derives a strictly lower,
bounded three-part fixture version and gives it the same app ID/upgrade UUID but a distinct build
identity. The harness performs: previous EXE install; deliberate packaged-JAR damage followed by
previous EXE repair; current EXE cross-version upgrade; deliberate damage followed by current EXE
repair; current EXE uninstall plus previous EXE reinstall as a controlled rollback; and previous
EXE final uninstall. At each mounted version it requires exactly one related ProductCode, exact
version/name/publisher, x64 native payload, launcher configuration and classpath/resource truth,
self-test success, exact desktop/Start-menu shortcut targets, and (unless explicitly disabled) a
visible native window. Upgrade must retire the previous ProductCode; rollback must restore the
same prior ProductCode; final state must contain no related product, launcher, or shortcut.

The protected tag lane repeats this complete lifecycle with independently signed previous/current
fixtures. It binds each outer EXE to the artifact manifest, binds every installed byte and native
signature to the payload manifest, pins the launcher to the protected publisher thumbprint, and
writes `dev.dsx.windows-exe-lifecycle/v1` evidence containing source commit, workflow run/attempt,
installer and manifest SHA-256 digests, ProductCodes, transition evidence, repair canaries, UI
results, and zero-residue final state. GitHub provenance covers the current release, lifecycle
evidence, and short-lived previous fixture. The previous fixture is retained for seven days for
audit and is not a release candidate.

Windows Installer versions are restricted to `MAJOR.MINOR.BUILD` with major/minor at most 255 and
build at most 65535. The workflow, signer, verifier, and install smoke all fail closed on larger
values before packaging or installation.

The release is x64-only. The outer jpackage EXE may be PE32/i386 because the WiX bootstrapper used
for an x64 installer is itself an i386 stub; the verifier labels only that compatibility case and
also accepts a native x64 outer EXE. It rejects ARM64 and every other outer machine type. This does
not weaken the payload boundary: the installed launcher and every PE found anywhere in the installed
application image must be x86-64 before launch and again after repair.

Required protected-environment secrets for a tagged release:

- `DSX_WINDOWS_SIGNING_PFX_BASE64`
- `DSX_WINDOWS_SIGNING_PFX_PASSWORD`
- `DSX_WINDOWS_SIGNING_CERT_SHA1`

The environment must be named `windows-production` and require human approval.
The bounded PFX must contain exactly one private identity matching the protected thumbprint; the
certificate must be currently valid and carry the Code Signing EKU. The signing script imports it
only into `CurrentUser\\My`, never puts its password on a process command line,
and deletes both the identity and temporary PFX in a `finally` block.

This x64 lane remains preview/release-candidate infrastructure, not a GA support declaration. The
checked-in workflow now requires the synthetic EXE install/repair/upgrade/rollback/uninstall matrix,
but source alone is not retained native execution evidence. Physical accessibility, IME,
GPU-driver, sleep/resume, enterprise-policy, SmartScreen reputation, an upgrade from the actual
previous public release, representative Windows 10/11 x64 hardware, and Windows 11 ARM64 remain
external qualification gates; signing and CI definitions cannot manufacture that evidence.
