import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.zip.ZipFile

// :desktop — the Kotlin lane's production desktop runtime (desktop-platforms.md).
// :core is reused VERBATIM; Compose Multiplatform supplies the native desktop
// rendering surface. Windows and Linux ship from this build. macOS applications
// ride the Swift lane, although this JVM artifact remains useful to framework
// developers on macOS and identifies that host honestly.
plugins {
    kotlin("jvm")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.compose")
}

kotlin { jvmToolchain(21) }

val desktopAppId = providers.gradleProperty("dsxDesktopAppId")
    .orElse("dev.dsx.runtime").get().trim()
require(desktopAppId.matches(Regex("[A-Za-z0-9][A-Za-z0-9.-]{1,127}"))) {
    "Invalid dsxDesktopAppId; packaged IDs use 2-128 ASCII letters, digits, dots, or hyphens"
}
// Desktop persistence treats application identifiers case-insensitively. Use the
// same canonical spelling for installers so a case-only configuration change
// cannot fork an app's upgrade family while retaining its settings namespace.
val desktopCanonicalAppId = desktopAppId.lowercase()
val desktopAppTitle = providers.gradleProperty("dsxDesktopTitle")
    .orElse("DSX").get().trim()
require(desktopAppTitle.matches(Regex("[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}"))) {
    "Invalid dsxDesktopTitle; expected 1-64 portable title characters"
}
require(
    !desktopAppTitle.endsWith('.') &&
        !desktopAppTitle.matches(Regex("(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?", RegexOption.IGNORE_CASE))
) { "Invalid dsxDesktopTitle; Windows device names and trailing dots are not portable" }
val desktopPackageVersion = providers.gradleProperty("dsxDesktopVersion")
    .orElse("1.0.0").get().trim()
require(desktopPackageVersion.matches(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"))) {
    "Invalid dsxDesktopVersion; Windows/Linux packages require three numeric components"
}
val desktopVersionParts = desktopPackageVersion.split('.').map(String::toInt)
require(desktopVersionParts[0] <= 255 && desktopVersionParts[1] <= 255 && desktopVersionParts[2] <= 65_535) {
    "Invalid dsxDesktopVersion; MSI limits major/minor to 255 and build to 65535"
}
val desktopBuildNumber = providers.gradleProperty("dsxDesktopBuild")
    .orElse(desktopPackageVersion).get().trim()
require(desktopBuildNumber.matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,63}"))) {
    "Invalid dsxDesktopBuild"
}
val desktopLinuxPackageName = desktopCanonicalAppId
require(desktopLinuxPackageName.matches(Regex("[a-z0-9][a-z0-9+.-]{0,127}"))) {
    "dsxDesktopAppId cannot be represented as a Linux package name"
}
val desktopUpgradeUuid = UUID.nameUUIDFromBytes(
    "dev.dsx.desktop:$desktopCanonicalAppId".toByteArray(Charsets.UTF_8),
).toString()

fun normalizedDesktopHost(osName: String, archName: String): String {
    val os = osName.trim().lowercase()
    val arch = when (archName.trim().lowercase()) {
        "x86_64", "amd64" -> "x64"
        "aarch64", "arm64" -> "arm64"
        else -> throw GradleException("Unsupported DSX desktop build architecture: $archName")
    }
    return when {
        os.startsWith("linux") && arch == "x64" -> "linux-x64"
        os.startsWith("windows") && arch == "x64" -> "windows-x64"
        (os == "mac os x" || os.startsWith("macos") || os.startsWith("darwin")) -> "macos-$arch"
        else -> throw GradleException("Unsupported DSX desktop build host: $osName/$archName")
    }
}

val desktopHostTarget = normalizedDesktopHost(
    System.getProperty("os.name").orEmpty(),
    System.getProperty("os.arch").orEmpty(),
)
val supportedDependencyTargets = setOf("linux-x64", "windows-x64", "macos-x64", "macos-arm64")
val desktopDependencyTarget = providers.gradleProperty("dsxDesktopTarget")
    .orNull?.trim()?.takeIf(String::isNotEmpty) ?: desktopHostTarget
require(desktopDependencyTarget in supportedDependencyTargets) {
    "Invalid dsxDesktopTarget '$desktopDependencyTarget'; expected one of ${supportedDependencyTargets.sorted()}"
}

// OpenJFX 21 is the JDK-21/LTS native media lane. Classifier jars contain both
// the Java API and the target's native media engine; resolving them explicitly
// prevents a lock written on macOS from silently publishing macOS dylibs in a
// Windows or Linux package. macOS remains a developer-only renderer here.
val desktopJavaFxClassifier = when (desktopDependencyTarget) {
    "linux-x64" -> "linux"
    "windows-x64" -> "win"
    "macos-x64" -> "mac"
    "macos-arm64" -> "mac-aarch64"
    else -> error("unreachable desktop target: $desktopDependencyTarget")
}
val desktopJavaFxVersion = "21.0.8"

// Generator-owned package fan-in. The catalog contains only explicit
// kotlin/desktop|windows|linux facets from enabled DSX packages. Paths are
// repository-relative, validated before Gradle adds them as compilation roots,
// and filtered to the selected OS so a Windows-only source can never leak into
// a Linux artifact (or vice versa).
val repositoryRoot = rootProject.projectDir.toPath().resolve("../../..").normalize()
val repositoryRealRoot = repositoryRoot.toRealPath()
val desktopModulesRelative = Path.of("ClosedSource/DSX/Modules")
var desktopModulesCursor = repositoryRealRoot
for (segment in desktopModulesRelative) {
    desktopModulesCursor = desktopModulesCursor.resolve(segment)
    require(!Files.isSymbolicLink(desktopModulesCursor)) {
        "DSX desktop package source root must not traverse symbolic links"
    }
}
val desktopModulesRealRoot = desktopModulesCursor.toRealPath()
require(
    desktopModulesRealRoot.startsWith(repositoryRealRoot) &&
        Files.isDirectory(desktopModulesRealRoot, LinkOption.NOFOLLOW_LINKS),
) { "Missing or unsafe DSX desktop package source root" }
val desktopDemoRepositoryPath = "OpenSource/Engine/Android/desktop/demo/DesktopDemo.dsx"
val desktopQaDemoRaw = providers.gradleProperty("dsxDesktopQaDemo").orNull?.trim()?.lowercase()
require(desktopQaDemoRaw == null || desktopQaDemoRaw == "true" || desktopQaDemoRaw == "false") {
    "dsxDesktopQaDemo must be true or false"
}
val desktopQaDemo = desktopQaDemoRaw == "true"
// The opt-in QA demo (`-PdsxDesktopQaDemo=true`) drives the audited fixture through the
// PRODUCTION desktop startup path (DesktopHostKt), whose identity guard
// (DesktopHost.runtimeProperties) requires the runtime identity to equal the EMBEDDED
// AppIdentity.properties. The QA demo runs under a fixed QA identity — the same one
// DesktopDemoHost.launch, the QA fixture, and both target-native smoke scripts assert
// (window title "DSX Desktop QA"). So when the QA demo is selected, the embedded identity
// AND every runtime identity setter below must carry it, or the guard aborts desktopDemoRun
// with exit 64 (a case-only spelling could never match the packaged id). Outside QA mode
// these fall back to the real package identity, so packaging is unaffected.
val desktopQaAppId = "dev.dsx.desktop.qa"
val desktopQaTitle = "DSX Desktop QA"
val desktopEffectiveAppId = if (desktopQaDemo) desktopQaAppId else desktopCanonicalAppId
val desktopEffectiveTitle = if (desktopQaDemo) desktopQaTitle else desktopAppTitle
val explicitDesktopEntry = providers.gradleProperty("dsxDesktopEntry").orNull
    ?.trim()?.takeIf(String::isNotEmpty)
require(!desktopQaDemo || explicitDesktopEntry == null) {
    "dsxDesktopQaDemo and dsxDesktopEntry are mutually exclusive"
}
val selectedDesktopEntry = if (desktopQaDemo) desktopDemoRepositoryPath else explicitDesktopEntry
val desktopEntryFile = selectedDesktopEntry?.let { raw ->
    val relative = Path.of(raw)
    require(!relative.isAbsolute && relative.none { it.toString() == "." || it.toString() == ".." }) {
        "dsxDesktopEntry must be a canonical repository-relative .dsx path"
    }
    require(relative.fileName?.toString()?.lowercase()?.endsWith(".dsx") == true) {
        "dsxDesktopEntry must use the .dsx extension"
    }
    var cursor = repositoryRealRoot
    for (segment in relative) {
        cursor = cursor.resolve(segment)
        require(!Files.isSymbolicLink(cursor)) {
            "dsxDesktopEntry must not traverse symbolic links"
        }
    }
    val resolved = repositoryRealRoot.resolve(relative).normalize()
    require(resolved.startsWith(repositoryRealRoot) && Files.isRegularFile(
        resolved,
        LinkOption.NOFOLLOW_LINKS,
    )) { "Missing or unsafe dsxDesktopEntry: $raw" }
    val real = runCatching { resolved.toRealPath() }.getOrElse {
        throw GradleException("Missing or unsafe dsxDesktopEntry: $raw", it)
    }
    require(
        real.startsWith(repositoryRealRoot) &&
            Files.isRegularFile(real, LinkOption.NOFOLLOW_LINKS),
    ) { "dsxDesktopEntry escapes the repository: $raw" }
    require(Files.size(real) <= 4L * 1024L * 1024L) {
        "dsxDesktopEntry exceeds the 4 MiB packaged-entry limit"
    }
    real.toFile()
}
val desktopDemoEntryPath = repositoryRealRoot.resolve(desktopDemoRepositoryPath).normalize()
var desktopDemoCursor = repositoryRealRoot
for (segment in Path.of(desktopDemoRepositoryPath)) {
    desktopDemoCursor = desktopDemoCursor.resolve(segment)
    require(!Files.isSymbolicLink(desktopDemoCursor)) {
        "DSX native desktop QA entry must not traverse symbolic links"
    }
}
val desktopDemoEntryRealPath = runCatching { desktopDemoEntryPath.toRealPath() }.getOrElse {
    throw GradleException("Missing DSX native desktop QA entry: $desktopDemoEntryPath", it)
}
require(
    desktopDemoEntryRealPath.startsWith(repositoryRealRoot) &&
        Files.isRegularFile(desktopDemoEntryRealPath, LinkOption.NOFOLLOW_LINKS),
) {
    "Missing or unsafe DSX native desktop QA entry: $desktopDemoEntryRealPath"
}
val desktopDemoEntryFile = desktopDemoEntryRealPath.toFile()
require(desktopDemoEntryFile.isFile) {
    "Missing DSX native desktop QA entry: ${desktopDemoEntryFile.path}"
}
val desktopAssetsDirectory = providers.gradleProperty("dsxDesktopAssets").orNull
    ?.trim()?.takeIf(String::isNotEmpty)?.let { raw ->
        val relative = Path.of(raw)
        require(!relative.isAbsolute && relative.none { it.toString() == "." || it.toString() == ".." }) {
            "dsxDesktopAssets must be a canonical repository-relative directory"
        }
        var cursor = repositoryRealRoot
        for (segment in relative) {
            cursor = cursor.resolve(segment)
            require(!Files.isSymbolicLink(cursor)) {
                "dsxDesktopAssets must not traverse symbolic links"
            }
        }
        val resolved = repositoryRealRoot.resolve(relative).normalize()
        require(resolved.startsWith(repositoryRealRoot) && Files.isDirectory(resolved, LinkOption.NOFOLLOW_LINKS)) {
            "Missing or unsafe dsxDesktopAssets directory: $raw"
        }
        val real = runCatching { resolved.toRealPath() }.getOrElse {
            throw GradleException("Missing or unsafe dsxDesktopAssets directory: $raw", it)
        }
        require(
            real.startsWith(repositoryRealRoot) &&
                Files.isDirectory(real, LinkOption.NOFOLLOW_LINKS),
        ) { "dsxDesktopAssets escapes the repository: $raw" }
        val entries = Files.walk(real).use { stream -> stream.toList() }
        val files = entries.filter { path -> path != real && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) }
        require(entries.drop(1).all { path ->
            !Files.isSymbolicLink(path) &&
                (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) || Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) &&
                runCatching { path.toRealPath().startsWith(real) }.getOrDefault(false)
        }) { "dsxDesktopAssets contains a symlink, escaping reparse point, or unsupported file type" }
        require(files.size <= 4_096) { "dsxDesktopAssets exceeds the 4096-file limit" }
        var totalBytes = 0L
        files.forEach { file ->
            val resourceName = real.relativize(file).joinToString("/")
            require(
                resourceName.length in 1..240 &&
                    !resourceName.contains('\\') &&
                    !resourceName.contains('\u0000') &&
                    resourceName.split('/').none { it.isEmpty() || it == "." || it == ".." }
            ) {
                "Unsafe or overlong desktop asset path: $resourceName"
            }
            val size = Files.size(file)
            require(size <= 64L * 1024L * 1024L) { "Desktop asset exceeds the 64 MiB per-file limit: $resourceName" }
            totalBytes = Math.addExact(totalBytes, size)
            require(totalBytes <= 256L * 1024L * 1024L) { "dsxDesktopAssets exceeds the 256 MiB total limit" }
        }
        real.toFile()
    }
val generatedDesktopAppResources = layout.buildDirectory.dir("generated/dsxAppResources")
val desktopAppIdentity = buildString {
    appendLine("dsx.identity.schema=dev.dsx.desktop-app-identity/v1")
    appendLine("dsx.app.id=$desktopEffectiveAppId")
    appendLine("dsx.app.title=$desktopEffectiveTitle")
    appendLine("dsx.app.version=$desktopPackageVersion")
    appendLine("dsx.app.build=$desktopBuildNumber")
    appendLine("dsx.app.identity.locked=true")
    appendLine("dsx.app.entry.resource=${if (desktopEntryFile != null) "/dsx/AppEntry.dsx" else ""}")
    appendLine("dsx.app.assets.prefix=${if (desktopAssetsDirectory != null) "/dsx/app-assets" else ""}")
}
val prepareDesktopAppEntry = tasks.register<Sync>("prepareDesktopAppEntry") {
    group = "build setup"
    description = "Copies an explicitly selected application .dsx entry into the native desktop package."
    into(generatedDesktopAppResources)
    duplicatesStrategy = DuplicatesStrategy.FAIL
    from(resources.text.fromString(desktopAppIdentity)) {
        into("dsx")
        rename { "AppIdentity.properties" }
    }
    desktopEntryFile?.let { entry ->
        from(entry) {
            into("dsx")
            rename { "AppEntry.dsx" }
        }
    }
    desktopAssetsDirectory?.let { assets ->
        from(assets) { into("dsx/app-assets") }
    }
}

fun resolveDesktopPackageSourceDirectory(relative: String, recordLabel: String): File {
    require(relative.matches(Regex("ClosedSource/DSX/Modules/[A-Za-z0-9_./-]+/kotlin/(desktop|windows|linux)"))) {
        "Unsafe desktop package source path in $recordLabel"
    }
    require(relative.split('/').none { it == "." || it == ".." }) {
        "Non-canonical desktop package source path in $recordLabel"
    }
    val relativePath = Path.of(relative)
    var cursor = repositoryRealRoot
    for (segment in relativePath) {
        cursor = cursor.resolve(segment)
        require(!Files.isSymbolicLink(cursor)) {
            "Desktop package source path must not traverse symbolic links: $relative"
        }
    }
    val resolved = repositoryRealRoot.resolve(relativePath).normalize()
    val real = runCatching { resolved.toRealPath() }.getOrElse {
        throw GradleException("Missing desktop package source directory: $relative", it)
    }
    require(
        real.startsWith(desktopModulesRealRoot) &&
            Files.isDirectory(real, LinkOption.NOFOLLOW_LINKS),
    ) {
        "Missing or escaping desktop package source directory: $relative"
    }
    val unsafeDescendant = Files.walk(real).use { paths ->
        paths.filter { it != real }.map { path ->
            Files.isSymbolicLink(path) ||
                runCatching { !path.toRealPath().startsWith(real) }.getOrDefault(true)
        }.anyMatch { it }
    }
    require(!unsafeDescendant) {
        "Desktop package source directory contains a symlink or escaping descendant: $relative"
    }
    return real.toFile()
}

val desktopProjectRealRoot = project.projectDir.toPath().toRealPath()
require(desktopProjectRealRoot.startsWith(repositoryRealRoot)) {
    "DSX desktop project directory escapes the repository root"
}
val desktopGeneratedCatalogMaxBytes = 1_048_576

/** Reads a generator-owned catalog without trusting lexical containment alone.
 * Every path component must resolve to the same in-root path with and without
 * link following, and the final file's type, identity, size, and timestamps are
 * compared around a bounded no-follow read. Those portable checks reject every
 * indirection or replacement exposed by the active JDK provider. Retained native
 * Windows junction/reparse and replacement-race evidence remains a promotion
 * requirement: macOS source inspection cannot prove Windows provider semantics. */
fun readTrustedDesktopCatalog(relative: String, label: String): List<String> {
    val relativePath = Path.of(relative)
    require(
        !relativePath.isAbsolute &&
            relativePath.none { it.toString() == "." || it.toString() == ".." } &&
            relative.matches(Regex("[A-Za-z0-9_./-]+")),
    ) { "Unsafe generated desktop $label catalog path: $relative" }
    val candidate = desktopProjectRealRoot.resolve(relativePath).normalize()
    require(candidate.startsWith(desktopProjectRealRoot)) {
        "Generated desktop $label catalog escapes the desktop project"
    }
    val segments = relativePath.toList()
    var cursor = desktopProjectRealRoot
    segments.forEachIndexed { index, segment ->
        cursor = cursor.resolve(segment)
        val componentAttributes = runCatching {
            Files.readAttributes(cursor, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        }.getOrElse {
            throw GradleException("Missing generated DSX desktop $label catalog component: $cursor", it)
        }
        val finalComponent = index == segments.lastIndex
        require(
            !Files.isSymbolicLink(cursor) &&
                !componentAttributes.isSymbolicLink &&
                !componentAttributes.isOther &&
                (if (finalComponent) componentAttributes.isRegularFile else componentAttributes.isDirectory)
        ) {
            "Generated desktop $label catalog path must not traverse a link, junction/reparse alias, or unsupported type"
        }
        val noFollowReal = runCatching { cursor.toRealPath(LinkOption.NOFOLLOW_LINKS) }.getOrElse {
            throw GradleException("Could not resolve generated desktop $label catalog component without links: $cursor", it)
        }
        val followedReal = runCatching { cursor.toRealPath() }.getOrElse {
            throw GradleException("Could not resolve generated desktop $label catalog component: $cursor", it)
        }
        require(
            noFollowReal.startsWith(desktopProjectRealRoot) &&
                followedReal.startsWith(desktopProjectRealRoot) &&
                noFollowReal == followedReal
        ) {
            "Generated desktop $label catalog path escapes or traverses a junction/reparse alias"
        }
    }
    val realBefore = candidate.toRealPath()
    require(realBefore.startsWith(desktopProjectRealRoot)) {
        "Generated desktop $label catalog resolves outside the desktop project"
    }
    val before = runCatching {
        Files.readAttributes(candidate, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    }.getOrElse {
        throw GradleException("Missing generated DSX desktop $label catalog: $candidate", it)
    }
    val beforeType = listOf(before.isRegularFile, before.isDirectory, before.isSymbolicLink, before.isOther)
    // fileKey() is null on the Windows default filesystem provider (a BasicFileAttributes
    // read there carries no volume-serial/file-index), so it cannot be REQUIRED here without
    // aborting every Windows desktop configuration. The inode-identity cross-check below
    // (after.fileKey() == beforeKey) still enforces stable identity where a key exists
    // (Linux/macOS) and is a null==null no-op on Windows; the size/mtime/creationTime/realpath
    // re-checks carry the TOCTOU guard on every platform.
    val beforeKey = before.fileKey()
    // A null key is ONLY legitimate on Windows (the default provider carries no
    // volume-serial/file-index). On Linux/macOS a null key means an exotic mount
    // (network/FUSE) where inode identity CANNOT be re-validated — fail loudly there
    // instead of silently degrading the cross-check below to null==null. Without this,
    // the relaxation that was scoped "for Windows" in the comment above actually
    // applied everywhere.
    require(beforeKey != null || System.getProperty("os.name").lowercase().contains("windows")) {
        "Generated desktop $label catalog filesystem reports no file key on a non-Windows platform - " +
            "inode identity cannot be re-validated (network/FUSE mount?); build from a local filesystem"
    }
    require(
        before.isRegularFile &&
            !before.isDirectory &&
            !before.isSymbolicLink &&
            !before.isOther &&
            before.size() <= desktopGeneratedCatalogMaxBytes
    ) {
        "Generated desktop $label catalog must be a regular file no larger than 1 MiB"
    }
    val bytes = runCatching {
        Files.newInputStream(candidate, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { input ->
            input.readNBytes(desktopGeneratedCatalogMaxBytes + 1)
        }
    }.getOrElse {
        throw GradleException("Could not safely read generated desktop $label catalog", it)
    }
    require(bytes.size <= desktopGeneratedCatalogMaxBytes) {
        "Generated desktop $label catalog exceeds 1 MiB"
    }
    val after = runCatching {
        Files.readAttributes(candidate, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    }.getOrElse {
        throw GradleException("Generated desktop $label catalog disappeared while being read", it)
    }
    val afterType = listOf(after.isRegularFile, after.isDirectory, after.isSymbolicLink, after.isOther)
    val noFollowRealAfter = runCatching { candidate.toRealPath(LinkOption.NOFOLLOW_LINKS) }.getOrElse {
        throw GradleException("Could not re-resolve generated desktop $label catalog without links", it)
    }
    val realAfter = runCatching { candidate.toRealPath() }.getOrElse {
        throw GradleException("Could not re-resolve generated desktop $label catalog", it)
    }
    require(
        afterType == beforeType &&
            after.isRegularFile &&
            after.fileKey() == beforeKey &&
            after.size() == before.size() &&
            bytes.size.toLong() == before.size() &&
            after.lastModifiedTime() == before.lastModifiedTime() &&
            after.creationTime() == before.creationTime() &&
            noFollowRealAfter == realAfter &&
            realAfter == realBefore &&
            realAfter.startsWith(desktopProjectRealRoot)
    ) {
        "Generated desktop $label catalog changed or was replaced while being read"
    }
    val text = runCatching {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    }.getOrElse {
        throw GradleException("Generated desktop $label catalog is not canonical UTF-8", it)
    }
    require('\u0000' !in text && '\r' !in text && text.endsWith('\n')) {
        "Generated desktop $label catalog must be NUL-free canonical LF text ending in LF"
    }
    val lines = text.removeSuffix("\n").split('\n')
    require(lines.size <= 4_100) { "Generated desktop $label catalog has too many lines" }
    return lines
}

data class DesktopPackageSourceRecord(val targets: List<String>, val relative: String)

fun parseDesktopPackageSourceRecords(
    lines: List<String>,
    requiredHeader: List<String>,
    label: String,
): List<DesktopPackageSourceRecord> {
    require(lines.take(requiredHeader.size) == requiredHeader) {
        "DSX desktop $label source catalog schema/header mismatch"
    }
    val targetOrder = listOf("windows", "linux")
    val identities = HashSet<Pair<String, String>>()
    val records = lines.drop(requiredHeader.size).mapIndexed { index, line ->
        val lineNumber = index + requiredHeader.size + 1
        require(line.isNotEmpty() && !line.startsWith('#')) {
            "Blank/comment DSX desktop $label source record at line $lineNumber"
        }
        val columns = line.split('\t')
        require(columns.size == 2) { "Invalid DSX desktop $label source record at line $lineNumber" }
        val targets = columns[0].split(',')
        require(
            targets.isNotEmpty() &&
                targets.distinct() == targets &&
                targets.all { it in targetOrder } &&
                targets.map(targetOrder::indexOf).zipWithNext().all { (a, b) -> a < b }
        ) { "Invalid or noncanonical DSX desktop $label targets at line $lineNumber" }
        val relative = columns[1]
        targets.forEach { target ->
            require(identities.add(target to relative)) {
                "Duplicate DSX desktop $label target/path identity '$target/$relative' at line $lineNumber"
            }
        }
        DesktopPackageSourceRecord(targets, relative)
    }
    require(records.isNotEmpty()) { "DSX desktop $label source catalog is empty" }
    return records
}

val desktopPackageSourceCatalogPath = "src/main/resources/dsx/DesktopPackageSources.generated.tsv"
val desktopPackageSourceHeader = listOf(
    "# DesktopPackageSources.generated.tsv",
    "# Generated from enabled ClosedSource/DSX/Modules/**/kotlin/{desktop,windows,linux} facets.",
    "# targets<TAB>repository-relative Kotlin source directory",
)
val desktopPackageSourceLines = readTrustedDesktopCatalog(desktopPackageSourceCatalogPath, "package-source")
val desktopPackageSourceRecords = parseDesktopPackageSourceRecords(
    desktopPackageSourceLines,
    desktopPackageSourceHeader,
    "package",
)
val selectedDesktopOs = desktopDependencyTarget.substringBefore('-')
val desktopPackageSourceDirs = desktopPackageSourceRecords
    .mapNotNull { record ->
        val targets = record.targets
        val relative = record.relative
        val real = resolveDesktopPackageSourceDirectory(
            relative,
            "package source record for $relative",
        )
        // A common desktop facet is pure JVM and also compiles on the macOS
        // developer renderer so cross-OS boot/registry contracts stay testable;
        // it is still registered only for Windows/Linux at runtime.
        if (targets.toSet() == setOf("windows", "linux") || selectedDesktopOs in targets) real else null
    }

val desktopPackageQualificationSourceCatalogPath =
    "src/test/resources/dsx/DesktopPackageQualificationSources.generated.tsv"
val desktopPackageQualificationSourceHeader = listOf(
    "# DesktopPackageQualificationSources.generated.tsv",
    "# Generated from every manifest-offered ClosedSource/DSX/Modules/**/kotlin/{desktop,windows,linux} facet.",
    "# Test compilation only; these paths never enter the production runtime source set.",
    "# targets<TAB>repository-relative Kotlin source directory",
)
val desktopPackageQualificationSourceLines = readTrustedDesktopCatalog(
    desktopPackageQualificationSourceCatalogPath,
    "package-qualification-source",
)
val desktopPackageQualificationSourceRecords = parseDesktopPackageSourceRecords(
    desktopPackageQualificationSourceLines,
    desktopPackageQualificationSourceHeader,
    "package qualification",
)
val desktopPackageQualificationSourceDirs = desktopPackageQualificationSourceRecords
    .mapNotNull { record ->
        val targets = record.targets
        val real = resolveDesktopPackageSourceDirectory(
            record.relative,
            "package qualification source record for ${record.relative}",
        )
        if (targets.toSet() == setOf("windows", "linux") || selectedDesktopOs in targets) real else null
    }

kotlin.sourceSets.named("main") {
    kotlin.srcDirs(desktopPackageSourceDirs)
    resources.srcDir(generatedDesktopAppResources)
}
kotlin.sourceSets.named("test") {
    kotlin.srcDirs(desktopPackageQualificationSourceDirs)
    resources.srcDir(layout.projectDirectory.dir("demo"))
}
tasks.named("processResources") { dependsOn(prepareDesktopAppEntry) }
if (desktopDependencyTarget != desktopHostTarget) {
    val requestedTasks = gradle.startParameter.taskNames.map { it.substringAfterLast(':') }
    val isCrossHostLockWrite =
        gradle.startParameter.isWriteDependencyLocks &&
            requestedTasks.isNotEmpty() &&
            requestedTasks.all { it == "resolveAndLockStableDependencies" }
    val isCrossHostLockVerification =
        !gradle.startParameter.isWriteDependencyLocks &&
            requestedTasks.isNotEmpty() &&
            requestedTasks.all { it == "verifyDesktopDependencyLockTarget" }
    require(
        isCrossHostLockWrite || isCrossHostLockVerification
    ) {
        "Cross-host DSX desktop access is allowed only for an explicit lock write " +
            "or :desktop:verifyDesktopDependencyLockTarget invocation"
    }
}

dependencyLocking {
    lockFile.set(layout.projectDirectory.file("gradle/locks/$desktopDependencyTarget.lockfile"))
}

val desktopDependencyLock = layout.projectDirectory.file("gradle/locks/$desktopDependencyTarget.lockfile")
val desktopRuntimeClasspath = configurations.named("runtimeClasspath")
val verifyDesktopDependencyLockTarget = tasks.register("verifyDesktopDependencyLockTarget") {
    group = "verification"
    description = "Rejects dependency locks containing another desktop platform runtime."
    inputs.file(desktopDependencyLock)
    doLast {
        val lock = desktopDependencyLock.asFile
        require(lock.isFile) { "Missing DSX desktop dependency lock: ${lock.path}" }
        val platformArtifact = Regex(
            "(?:desktop-jvm|skiko-awt-runtime)-(linux-x64|windows-x64|macos-x64|macos-arm64):"
        )
        val lockedTargets = platformArtifact.findAll(lock.readText())
            .map { it.groupValues[1] }
            .toSortedSet()
        require(lockedTargets == sortedSetOf(desktopDependencyTarget)) {
            "DSX desktop lock ${lock.name} contains platform runtimes $lockedTargets; " +
                "expected only $desktopDependencyTarget"
        }
        // Gradle lock entries identify a Maven module but not its classifier. Resolve
        // the locked external artifact view and prove that the native JavaFX jars for
        // THIS target — and no host-default jars — are what packaging will consume.
        val javaFxFiles = desktopRuntimeClasspath.get().incoming.artifactView {
            componentFilter { identifier ->
                val module = identifier as? org.gradle.api.artifacts.component.ModuleComponentIdentifier
                module?.group == "org.openjfx" && module.version == desktopJavaFxVersion
            }
        }.files.files
        val expectedJavaFxFiles = setOf("base", "graphics", "media", "swing").mapTo(sortedSetOf()) { module ->
            "javafx-$module-$desktopJavaFxVersion-$desktopJavaFxClassifier.jar"
        }
        val actualJavaFxFiles = javaFxFiles.mapTo(sortedSetOf()) { it.name }
        require(actualJavaFxFiles == expectedJavaFxFiles) {
            "DSX desktop JavaFX artifacts $actualJavaFxFiles do not match $desktopDependencyTarget " +
                "classifier $desktopJavaFxClassifier ($expectedJavaFxFiles)"
        }
        val requiredNativeEntries = when (desktopDependencyTarget) {
            "linux-x64" -> mapOf(
                "graphics" to setOf("libglassgtk3.so", "libprism_sw.so"),
                "media" to setOf("libjfxmedia.so", "libgstreamer-lite.so", "libfxplugins.so"),
            )
            "windows-x64" -> mapOf(
                "graphics" to setOf("glass.dll", "prism_d3d.dll", "prism_sw.dll"),
                "media" to setOf("jfxmedia.dll", "gstreamer-lite.dll", "fxplugins.dll"),
            )
            "macos-x64", "macos-arm64" -> mapOf(
                "graphics" to setOf("libglass.dylib", "libprism_sw.dylib"),
                "media" to setOf("libjfxmedia.dylib", "libjfxmedia_avf.dylib", "libgstreamer-lite.dylib"),
            )
            else -> error("unreachable desktop target: $desktopDependencyTarget")
        }
        requiredNativeEntries.forEach { (module, required) ->
            val artifact = javaFxFiles.single { it.name.startsWith("javafx-$module-") }
            ZipFile(artifact).use { archive ->
                val names = archive.entries().asSequence().map { it.name }.toSet()
                require(names.containsAll(required)) {
                    "${artifact.name} lacks target-native runtime entries ${required - names}"
                }
            }
        }
        val compottieFiles = desktopRuntimeClasspath.get().incoming.artifactView {
            componentFilter { identifier ->
                val module = identifier as? org.gradle.api.artifacts.component.ModuleComponentIdentifier
                module?.group == "io.github.alexzhirkevich" && module.module.startsWith("compottie")
            }
        }.files.files.mapTo(sortedSetOf()) { it.name }
        val requiredCompottieFiles = setOf(
            "compottie-core-desktop-2.1.0.jar",
            "compottie-desktop-2.1.0.jar",
            "compottie-dot-desktop-2.1.0.jar",
        )
        require(compottieFiles.containsAll(requiredCompottieFiles)) {
            "DSX desktop Lottie runtime is incomplete: missing ${requiredCompottieFiles - compottieFiles}"
        }
    }
}

dependencies {
    api(project(":core"))
    implementation(
        when (desktopDependencyTarget) {
            "linux-x64" -> compose.desktop.linux_x64
            "windows-x64" -> compose.desktop.windows_x64
            // The JVM Mac lane is developer-only; the product ships the Swift/Catalyst
            // host. Explicit coordinates keep both Intel and Apple Silicon development
            // locks reproducible instead of silently inheriting the resolver host.
            "macos-x64" -> compose.desktop.macos_x64
            "macos-arm64" -> compose.desktop.macos_arm64
            else -> error("unreachable desktop target: $desktopDependencyTarget")
        },
    )
    // First-party native DSX <audio>/<video> surfaces. OpenJFX media ships its
    // own target-native playback engine; Swing is used only as Compose's native
    // interop host (never as a browser or HTML renderer).
    listOf("base", "graphics", "media", "swing").forEach { module ->
        implementation("org.openjfx:javafx-$module:$desktopJavaFxVersion:$desktopJavaFxClassifier") {
            isTransitive = false
        }
    }
    // Pure Kotlin/Skia Lottie renderer. 2.1.0 is the newest line built against
    // Compose 1.10.x; dot adds the canonical .lottie archive format.
    implementation("io.github.alexzhirkevich:compottie:2.1.0")
    implementation("io.github.alexzhirkevich:compottie-dot:2.1.0")
    // Used for the bounded structural admission pass before untrusted animation
    // bytes are handed to Compottie. Keep it explicit rather than relying on the
    // renderer's transitive graph.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    testImplementation(kotlin("test"))
    // Exercise the real Skia/Compose scene, semantics tree and input pipeline without
    // depending on an installed Windows/Linux display server. Target-native installer
    // UI remains in the OS CI lanes; these renderer laws run identically on every host.
    testImplementation("org.jetbrains.compose.ui:ui-test:1.10.3")
    // TEST-ONLY: the real Material 3 Switch, the same component the Android :render
    // system path mounts. DesktopSwitchAnimationUiTest drives it through the DSX store
    // round-trip under a hand-stepped clock — the one runnable oracle for the M3 control
    // motion contract on a device-free box. The shipped desktop renderer stays Material 2.
    testImplementation(compose.material3)
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

compose.desktop {
    application {
        mainClass = "despia.engine.desktop.DesktopHostKt"
        jvmArgs += buildList {
            add("-Ddsx.app.id=$desktopCanonicalAppId")
            add("-Ddsx.app.title=$desktopAppTitle")
            add("-Ddsx.app.version=$desktopPackageVersion")
            add("-Ddsx.app.build=$desktopBuildNumber")
            add("-Ddsx.app.identity.locked=true")
            if (desktopEntryFile != null) add("-Ddsx.app.entry.resource=/dsx/AppEntry.dsx")
        }
        nativeDistributions {
            // DesktopMediaGateway is a loopback-only HttpServer. jpackage's
            // minimized runtime must retain its JDK module for offline playback.
            // DesktopNetwork's shared HttpClient (the DSX fetch/api/content plane) lives
            // in the SEPARATE java.net.http module, and boot() constructs that client
            // during install(); the stripped runtime must retain it too, or class-loading
            // DesktopNetwork throws NoClassDefFoundError: java/net/http/HttpTimeoutException
            // (which surfaces as the self-test error code java_net_http_HttpTimeoutException).
            modules("jdk.httpserver", "java.net.http")
            // Compose only builds the formats supported by the current host. Linux CI
            // therefore emits deb/rpm; Windows CI emits msi/exe. Cross-packaging is
            // intentionally forbidden because it cannot validate the embedded runtime.
            val hostOs = System.getProperty("os.name").lowercase()
            when {
                hostOs.startsWith("linux") -> targetFormats(
                    org.jetbrains.compose.desktop.application.dsl.TargetFormat.Deb,
                    org.jetbrains.compose.desktop.application.dsl.TargetFormat.Rpm,
                )
                hostOs.startsWith("windows") -> targetFormats(
                    org.jetbrains.compose.desktop.application.dsl.TargetFormat.Msi,
                    org.jetbrains.compose.desktop.application.dsl.TargetFormat.Exe,
                )
                // The product macOS runtime is the Swift/AppKit lane. A developer can
                // still compile/run this shared JVM renderer on macOS, but it must not
                // accidentally publish a second Mac distribution.
                else -> Unit
            }
            packageName = desktopAppTitle
            packageVersion = desktopPackageVersion
            vendor = "DSX"
            description = "DSX native desktop runtime"
            copyright = "Copyright DSX"
            linux {
                packageName = desktopLinuxPackageName
                shortcut = true
                menuGroup = "Development"
                appRelease = providers.gradleProperty("dsxDesktopRelease").orElse("1").get()
            }
            windows {
                packageName = desktopAppTitle
                menuGroup = "DSX"
                shortcut = true
                perUserInstall = true
                // Per-app identity prevents independently white-labelled DSX apps
                // from upgrading or uninstalling one another.
                upgradeUuid = desktopUpgradeUuid
            }
        }
    }
}

// Several kernel seams are process-wide singletons by design. Give every test
// class a fresh JVM so a class that deliberately boots or installs a package
// catalog cannot contaminate another class. Keep execution serialized as well:
// deterministic isolation matters more than worker throughput in this lane.
tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
    useJUnitPlatform()
    forkEvery = 1
    maxParallelForks = 1
    // A failure here has to say what it saw. The Windows lane surfaces the gradle CONSOLE and
    // uploads installers, not the HTML/XML test report, so Gradle's default one-line
    // "AssertionFailedError at File.kt:240" was the whole record of a red - which is why
    // DesktopRendererUiTest's paint assertions carry measured values in their messages and why
    // its diagnosis ledger calls the message "the ONE channel the Windows lane surfaces". That
    // channel was closed. FULL prints the assertion message and its stack on every failure.
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showExceptions = true
        showCauses = true
        showStackTraces = true
    }
}

// The pure-JVM law, desktop edition (checkPureJvm family — desktop-status.md).
tasks.register("checkPureJvm") {
    doLast {
        val sourceTrees = listOf(fileTree("src") { include("**/*.kt") }) +
            desktopPackageSourceDirs.map { source -> fileTree(source) { include("**/*.kt") } }
        val bad = files(sourceTrees).asFileTree.filter { f ->
            f.readText().lineSequence().any { it.trimStart().startsWith("import android.") }
        }.files
        if (bad.isNotEmpty()) throw GradleException("android.* import in pure-JVM :desktop -> ${bad.map { it.name }}")
    }
}
val desktopRuntimeJar = tasks.named<org.gradle.jvm.tasks.Jar>("jar")
val verifyDesktopMediaRuntimePackage = tasks.register("verifyDesktopMediaRuntimePackage") {
    group = "verification"
    description = "Proves native media classes and exact third-party notices ship in the desktop runtime JAR."
    dependsOn(desktopRuntimeJar)
    inputs.file(desktopRuntimeJar.flatMap { it.archiveFile })
    doLast {
        val archiveFile = desktopRuntimeJar.get().archiveFile.get().asFile
        require(archiveFile.isFile) { "Missing DSX desktop runtime JAR: ${archiveFile.path}" }
        ZipFile(archiveFile).use { archive ->
            val names = archive.entries().asSequence().map { it.name }.toSet()
            val runtimeClasses = setOf(
                "despia/engine/desktop/DesktopNativeMediaRendererKt.class",
                "despia/engine/desktop/DesktopLottieRendererKt.class",
                "despia/engine/desktop/DesktopMediaGateway.class",
            )
            val legalRoot = "META-INF/legal/dsx-desktop-media/"
            val legalFiles = setOf(
                "Compottie-LICENSE.txt",
                "Keight-LICENSE.txt",
                "Kotlinx-Coroutines-LICENSE.txt",
                "Kotlinx-Datetime-LICENSE.txt",
                "Kotlinx-Serialization-LICENSE.txt",
                "Okio-LICENSE.txt",
                "OpenJFX-ADDITIONAL_LICENSE_INFO.txt",
                "OpenJFX-ASSEMBLY_EXCEPTION.txt",
                "OpenJFX-LICENSE.txt",
                "OpenJFX-javafx.media-directshow.md",
                "OpenJFX-javafx.media-glib.md",
                "OpenJFX-javafx.media-gstreamer.md",
                "OpenJFX-javafx.media-libffi.md",
                "THIRD-PARTY-NOTICES.txt",
            ).mapTo(mutableSetOf()) { legalRoot + it }
            require(names.containsAll(runtimeClasses)) {
                "DSX desktop JAR lacks native media runtime classes ${runtimeClasses - names}"
            }
            require(names.containsAll(legalFiles)) {
                "DSX desktop JAR lacks required media notices ${legalFiles - names}"
            }
        }
    }
}
tasks.named("check") {
    dependsOn("checkPureJvm", verifyDesktopDependencyLockTarget, verifyDesktopMediaRuntimePackage)
}

// A deterministic, display-free smoke entry used against the installed runtime
// in Linux/Windows packaging CI. It proves the packaged JVM, DSX parser, JSE,
// platform identity and bundled native failure surface without requiring X11,
// Wayland or an interactive desktop session.
tasks.register<JavaExec>("desktopSelfTest") {
    group = "verification"
    description = "Runs the machine-readable DSX desktop runtime self-test."
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("despia.engine.desktop.DesktopHostKt")
    systemProperty("dsx.app.id", desktopEffectiveAppId)
    systemProperty("dsx.app.title", desktopEffectiveTitle)
    systemProperty("dsx.app.version", desktopPackageVersion)
    systemProperty("dsx.app.build", desktopBuildNumber)
    systemProperty("dsx.app.identity.locked", "true")
    if (desktopEntryFile != null) systemProperty("dsx.app.entry.resource", "/dsx/AppEntry.dsx")
    args("--dsx-self-test")
}

// The QA demo is source-only by default: it is neither selected as AppEntry.dsx nor
// included in a shipping package. `-PdsxDesktopQaDemo=true` deliberately routes the
// exact same fixture through the normal packaged application entry for target-OS QA.
tasks.register<JavaExec>("desktopDemoSelfTest") {
    group = "verification"
    description = "Validates the exact DSX desktop QA entry without opening a window."
    dependsOn("classes")
    inputs.file(desktopDemoEntryFile)
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("despia.engine.desktop.DesktopDemoHostKt")
    args("--validate", desktopDemoEntryFile.absolutePath)
}

tasks.register<JavaExec>("desktopDemoRun") {
    group = "application"
    description = "Opens the packaged DSX QA entry through the production desktop startup path."
    dependsOn("classes")
    inputs.file(desktopDemoEntryFile)
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("despia.engine.desktop.DesktopHostKt")
    // The runtime identity MUST equal the embedded AppIdentity.properties, exactly as
    // version/build below already do, or DesktopHost.runtimeProperties' identity guard
    // aborts with exit 64. desktopDemoRun requires the QA demo (doFirst below), so the
    // effective identity is the fixed QA identity — the same one the embedded AppIdentity
    // now carries and the target-native smoke asserts (window title "DSX Desktop QA").
    // Previously these were hardcoded to the QA identity while the embedded identity used
    // the default package identity, so they never matched and every desktopDemoRun failed.
    systemProperty("dsx.app.id", desktopEffectiveAppId)
    systemProperty("dsx.app.title", desktopEffectiveTitle)
    systemProperty("dsx.app.version", desktopPackageVersion)
    systemProperty("dsx.app.build", desktopBuildNumber)
    systemProperty("dsx.app.identity.locked", "true")
    systemProperty("dsx.app.entry.resource", "/dsx/AppEntry.dsx")
    args("--dsx-ui-smoke")
    doFirst {
        require(desktopQaDemo) {
            "desktopDemoRun requires -PdsxDesktopQaDemo=true so /dsx/AppEntry.dsx is the audited QA fixture"
        }
    }
}

tasks.named("check") { dependsOn("desktopSelfTest", "desktopDemoSelfTest") }

// The parity capture plane (OpenSource/Conformance/parity/README.md, "The desktop capture
// plane"). It renders the whole fixture corpus offscreen and REWRITES the committed
// reference/desktop plane, so it is deliberately not part of the unit lane: `test` stays a
// read-only suite, `parityCapture` is the recorder the CI step and the host-side differ
// consume. The Skiko UI gate is forced on here because the capture asserts geometry, never
// pixels, so software rasterization is sufficient and a headless runner must still record.
val parityFixturesDir = repositoryRealRoot.resolve("OpenSource/Conformance/parity/fixtures").toFile()
val parityDesktopPlaneDir = repositoryRealRoot.resolve("OpenSource/Conformance/parity/reference/desktop").toFile()
val parityCaptureTestClass = "despia.engine.desktop.DesktopParityCaptureTest"
// Text measurement is font-dependent, so a capture is only byte-reproducible on the host
// that recorded it: CI records its OWN plane into the build directory and diffs that,
// while `-PdsxParityRecord=true` refreshes the committed reference/desktop plane.
val parityRecordPlane = providers.gradleProperty("dsxParityRecord").orNull
    ?.equals("true", ignoreCase = true) == true

tasks.named<Test>("test") {
    filter { excludeTestsMatching(parityCaptureTestClass) }
}

tasks.register<Test>("parityCapture") {
    group = "verification"
    description = "Records the Compose Desktop parity capture plane from Conformance/parity/fixtures " +
        "(build/parity-desktop; -PdsxParityRecord=true rewrites reference/desktop)."
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    filter { includeTestsMatching(parityCaptureTestClass) }
    environment("DSX_DESKTOP_UI_TESTS", "1")
    systemProperty("dsx.repo.root", repositoryRealRoot.toString())
    val captureOut = if (parityRecordPlane) parityDesktopPlaneDir
    else layout.buildDirectory.dir("parity-desktop").get().asFile
    systemProperty("dsx.parity.capture.out", captureOut.absolutePath)
    doFirst { logger.lifecycle("parityCapture -> ${captureOut.absolutePath}") }
    inputs.dir(parityFixturesDir).withPathSensitivity(PathSensitivity.RELATIVE)
    outputs.upToDateWhen { false }
}
