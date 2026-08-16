# DSX on Linux - release boundary

Linux ships the shared native Compose Desktop host as `deb` and `rpm` packages.
The JVM, DSX kernel, and renderer are bundled; an end user does not install Java.
Signed release packages are built only on Codemagic's native x64 Linux runner;
GitHub's Ubuntu x64 runner produces short-retained unsigned validation candidates.

The secret-free `.github/workflows/linux-desktop-validation.yml` workflow compiles/tests
pull requests and `main` with the committed `linux-x64` dependency lock under strict
verification, builds both unsigned packages, validates archive
metadata and hardening, and binds each package to its one exact `app/bin/<title>`
launcher and adjacent `lib/app/<title>.cfg`; any additional executable below `app/bin`
is rejected. The configuration must name the exact DSX main class, contain no alternate
main JAR/module startup route, and list each classpath JAR as one canonical direct
`$APPDIR/<name>.jar` record. Classpath-overriding JVM options and host-class shadowing
including multi-release variants fail closed, as does a JAR-manifest `Class-Path`
extension. The entire JavaOptions multiset must exactly equal the pinned Compose
1.10.3/jpackage version, Swing-global initialization, DSX identity/optional entry,
and Skiko library-path records; missing, duplicate, Java-agent, module-patch, or any
other extra startup option is rejected. Only those resolved JARs may supply the exact ordered eight-key
`dsx/AppIdentity.properties`, entry, or app assets; decoy configurations,
off-classpath resources, duplicate resources, and non-exact DSX JVM options fail the
lane. Every extracted ELF and every dpkg- or rpm-owned installed ELF-including native entries
embedded in shipped JARs-must be
64-bit little-endian x86_64 (`e_machine=62`), and the deb/rpm plus extracted/installed
identity, resource, configuration, and ELF hashes must agree. The lane executes both
extracted runtimes, then performs real `dpkg --install` → self-test → Xvfb native-window smoke →
`dpkg --purge` and `rpm --install` → self-test → Xvfb native-window smoke → `rpm --erase`
lifecycles on the explicitly opted-in ephemeral Ubuntu runner. Cleanup failure is fatal, and a
failed verification makes a bounded emergency removal attempt without hiding the original error.

The Ubuntu RPM lifecycle executes RPM scriptlets and the RPM database, but it is not a substitute
for dnf/repository behavior on an RPM-family distribution. A distribution-native RPM repository
install, cross-version upgrade, and rollback remain publication gates.

Semver tag builds execute only the separate Codemagic `desktop-linux-release`
workflow. It receives the `dsx_linux_release_credentials` group, which must be
configured as a protected tag-only group in Codemagic. Public GitHub validation
does not declare a GitHub environment, use repository secrets, process tags, or
invoke the signer. The release group provides:

- `DSX_LINUX_SIGNING_PRIVATE_KEY_B64`
- `DSX_LINUX_SIGNING_KEY_FINGERPRINT`
- `DSX_LINUX_SIGNING_PASSPHRASE`

The committed public trust anchor is `ClosedSource/release/linux-signing-public-key.asc`,
pinned by byte digest, exact primary fingerprint
`7DD5628FFA46A6C690E82B4DD44D2CB2A1D87494`, and validity window in
`ClosedSource/release/linux-signing-trust.json`. The corresponding encrypted
private key and passphrase must be installed independently into the protected
Codemagic group; the private key must never be committed, uploaded as a public
validation artifact, or copied into a pull-request application.

The private key must contain exactly one dedicated OpenPGP release-signing primary identity and the
protected fingerprint must equal the Git-pinned 40-hex primary-key fingerprint. The lane imports the private key
into a temporary 0700 keyring, never places the passphrase on a process command
line or leaves the original secret variables exported to child processes. It creates SHA-256
detached ASCII signatures for both packages, the SHA-256 inventory, and one
source/build/app-identity provenance statement. It also builds an apt `stable/amd64`
repository with `Release.gpg` plus clear-signed `InRelease`, and an RPM `x86_64`
repository whose `repomd.xml` has a detached signature,
but only after recomputing the current deb/rpm checksums and requiring an exact
byte-for-byte match with the verifier-owned inventory. It verifies signatures from a fresh
public-only keyring that imports only the committed anchor, stages the complete report privately,
publishes only after every signature passes, and rolls back partially published
sidecars/repositories if publication fails. The independent `verify-linux-release.py` then
revalidates clean-source admission, provenance subjects, package/repository byte equality,
apt checksums, RPM repomd references, OpenPGP primary fingerprint, SHA-256 algorithm, and every
signed metadata surface. Private-workspace cleanup failure also fails the build. Missing or
mismatched signing material fails a tag build; PR/main builds are deliberately unsigned and
short-retained.

The Git-pinned key is the verifier trust root; an exported key from a build can
never replace it. Production promotion still requires evidence that the protected
credential group contains the matching private key, a successful immutable tag build,
publication of those exact signed repositories, and consumer-side verification from a
separately obtained copy of the public anchor. Distro-native apt/dnf install/upgrade/rollback,
exact native runner/JDK/packaging-tool pins, upgrade from the prior public version, physical
accessibility/IME/GPU coverage, and Linux ARM64 are release-candidate gates outside this x64
package-build lane.
