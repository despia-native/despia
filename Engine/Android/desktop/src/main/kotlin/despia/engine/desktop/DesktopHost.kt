//
// DesktopHost.kt — production entry for the Kotlin desktop lane.
//
// The host is deliberately small: it establishes deploy-target identity, loads one
// bounded DSX document and mounts the Compose renderer. Framework behavior remains in
// :core and package capabilities remain modules. No Android API is reachable here.
//

package despia.engine.desktop

import despia.engine.JSE
import despia.engine.DSX
import despia.engine.DSXMessengerMount
import despia.engine.DSXModuleCallMount
import despia.engine.ModuleRegistry
import despia.engine.Platform
import despia.engine.PlatformAttrs
import despia.engine.StackNode
import despia.engine.StackStore
import despia.engine.StackXML
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.nio.charset.StandardCharsets
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.OpenOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.StandardCopyOption
import kotlin.system.exitProcess

object DesktopHost {
    const val MAX_DSX_BYTES: Long = 4L * 1024L * 1024L
    internal const val MAX_EXPANDED_DSX_NODES = 50_000
    internal const val MAX_EXPANDED_DSX_DEPTH = 256
    private const val WELCOME_RESOURCE = "/dsx/DesktopWelcome.dsx"
    private const val FAILURE_RESOURCE = "/dsx/DesktopFailure.dsx"
    internal const val APP_ENTRY_RESOURCE = "/dsx/AppEntry.dsx"
    internal const val APP_IDENTITY_RESOURCE = "/dsx/AppIdentity.properties"
    internal const val APP_IDENTITY_SCHEMA = "dev.dsx.desktop-app-identity/v1"
    internal const val APP_ASSETS_PREFIX = "/dsx/app-assets"
    private val APP_IDENTITY_KEYS = linkedSetOf(
        "dsx.identity.schema",
        "dsx.app.id",
        "dsx.app.title",
        "dsx.app.version",
        "dsx.app.build",
        "dsx.app.identity.locked",
        "dsx.app.entry.resource",
        "dsx.app.assets.prefix",
    )
    internal val DOCUMENT_LIMITS = StackXML.ParseLimits(
        maximumDepth = 128,
        maximumNodes = 10_000,
    )

    data class Options(
        val entry: Path? = null,
        val entryResource: String? = null,
        val title: String = "DSX",
        val appId: String? = null,
        val assetsRoot: Path? = null,
        val identityLocked: Boolean = false,
        val selfTest: Boolean = false,
        val selfTestOutput: Path? = null,
        val uiSmoke: Boolean = false,
        val help: Boolean = false,
    )

    data class Document(
        val source: String,
        val markup: String,
        val initialVariables: Map<String, Any?> = emptyMap(),
    )

    /** `os.name` to the exact platform-corpus deploy target. Unknown operating
     * systems return null and are refused at boot; pretending FreeBSD is Linux would
     * select Linux-only facets and packages that may not be ABI compatible. */
    fun detectOs(osName: String = System.getProperty("os.name") ?: ""): String? {
        val normalized = osName.trim().lowercase()
        return when {
            normalized.startsWith("windows") -> "windows"
            normalized == "mac os x" || normalized.startsWith("macos") || normalized.startsWith("darwin") -> "macos"
            normalized == "linux" || normalized.startsWith("linux ") -> "linux"
            else -> null
        }
    }

    /** Establish identity before any package, parser or expression is evaluated. */
    fun boot(osName: String = System.getProperty("os.name") ?: ""): String {
        val os = detectOs(osName)
            ?: throw UnsupportedOperationException("Unsupported DSX desktop operating system: ${osName.ifBlank { "<empty>" }}")
        Platform.nodeTarget = null
        Platform.os = os
        // Bind the evaluator to the same authoritative global store published by
        // DesktopScreenStatePublisher. Without this host seam, `dsx.screen.*`,
        // `dsx.global.*` and route state all resolve empty even though Compose is
        // collecting and updating DSX.state correctly.
        JSE.stateVars = { DSX.state.vars }
        // The desktop host owns the same three registry-facing seams as Android:
        // capability expressions query the live compiled package set, mounted surface
        // calls enter at the untrusted tier, and authored/markup package calls enter at
        // the internal tier. DesktopHost is process-lifetime, so these bindings remain
        // installed until a test or embedding host deliberately replaces them.
        JSE.moduleAvailable = { scheme -> ModuleRegistry.shared.isAvailable(scheme) }
        // `JSE.componentAvailable` is DELIBERATELY left unbound here — not an oversight, and not
        // a copy of DespiaApp's line. That seam answers "is this component compiled into the
        // binary", and the phone host can answer it because :render owns a process-global table
        // (ComposeStackComponents). Desktop has no such table: components are DOCUMENT-scoped
        // (`desktopDeclaredComponents(root)`), resolved per loaded document, so any answer this
        // host could give would be false for a legitimately declared component and would turn a
        // working root candidate into `root.component_missing`. Unbound means "no registry
        // here", which the ROOT PLAN reads as fail-open (Router.kt `registered`) — the correct
        // degrade. Bind it only when desktop grows a process-global component registry.
        DSXMessengerMount.bindRegistry()
        DSXModuleCallMount.bindRegistry()
        installDesktopSourceStampStore()
        DesktopNetwork.install()
        DesktopPackageCatalog.install()
        // There are no implicit desktop package factories: only explicitly compiled
        // facets may register. Completing the normal registry lifecycle still matters
        // for deterministic late registration and honest unsupported-platform answers.
        ModuleRegistry.shared.bootstrap()
        return os
    }

    fun parseOptions(
        args: Array<String>,
        environment: Map<String, String> = System.getenv(),
        properties: Map<String, String> = runtimeProperties(),
    ): Options {
        val identityLocked = properties["dsx.app.identity.locked"]?.equals("true", ignoreCase = true) == true
        val packagedEntryResource = properties["dsx.app.entry.resource"]?.takeIf { it.isNotBlank() }
        val packagedTitle = properties["dsx.app.title"]?.takeIf { it.isNotBlank() }
        val packagedAppId = properties["dsx.app.id"]?.takeIf { it.isNotBlank() }
        if (identityLocked) {
            require(packagedAppId != null) { "A locked DSX desktop package requires dsx.app.id" }
            require(environment["DSX_ENTRY"].isNullOrBlank()) { "A packaged DSX entry cannot be replaced by DSX_ENTRY" }
            require(environment["DSX_ASSETS_ROOT"].isNullOrBlank()) { "Packaged DSX assets cannot be replaced by DSX_ASSETS_ROOT" }
            require(properties["dsx.assets.root"].isNullOrBlank()) {
                "Packaged DSX assets cannot be replaced by dsx.assets.root"
            }
            environment["DSX_APP_ID"]?.takeIf { it.isNotBlank() }?.let { override ->
                require(override.equals(packagedAppId, ignoreCase = true)) { "A packaged DSX app id cannot be replaced" }
            }
            environment["DSX_APP_TITLE"]?.takeIf { it.isNotBlank() }?.let { override ->
                require(override == (packagedTitle ?: "DSX")) { "A packaged DSX title cannot be replaced" }
            }
        }
        var entry: Path? = if (identityLocked) null
            else environment["DSX_ENTRY"]?.takeIf { it.isNotBlank() }?.let(Path::of)
        var entryResource = packagedEntryResource
        var title = if (identityLocked) packagedTitle ?: "DSX"
            else environment["DSX_APP_TITLE"]?.takeIf { it.isNotBlank() } ?: packagedTitle ?: "DSX"
        var appId = if (identityLocked) packagedAppId
            else environment["DSX_APP_ID"]?.takeIf { it.isNotBlank() } ?: packagedAppId
        var assetsRoot = if (identityLocked) null
            else environment["DSX_ASSETS_ROOT"]?.takeIf { it.isNotBlank() }?.let(Path::of)
                ?: properties["dsx.assets.root"]?.takeIf { it.isNotBlank() }?.let(Path::of)
        var selfTest = false
        var selfTestOutput: Path? = null
        var uiSmoke = false
        var help = false
        var i = 0
        while (i < args.size) {
            when (val arg = args[i]) {
                "--entry" -> {
                    require(i + 1 < args.size) { "--entry requires a .dsx path" }
                    require(!identityLocked) { "A packaged DSX entry cannot be replaced by --entry" }
                    entry = Path.of(args[++i])
                }
                "--entry-resource" -> {
                    require(i + 1 < args.size) { "--entry-resource requires a bundled .dsx resource" }
                    val candidate = args[++i]
                    require(!identityLocked || candidate == packagedEntryResource) {
                        "A packaged DSX entry resource cannot be replaced"
                    }
                    entryResource = candidate
                }
                "--title" -> {
                    require(i + 1 < args.size) { "--title requires a value" }
                    val candidate = args[++i].trim().also { require(it.isNotEmpty()) { "--title cannot be empty" } }
                    require(!identityLocked || candidate == title) { "A packaged DSX title cannot be replaced" }
                    title = candidate
                }
                "--app-id" -> {
                    require(i + 1 < args.size) { "--app-id requires a stable identifier" }
                    val candidate = args[++i]
                    require(!identityLocked || candidate.equals(appId, ignoreCase = true)) {
                        "A packaged DSX app id cannot be replaced"
                    }
                    appId = if (identityLocked) appId else candidate
                }
                "--assets-root" -> {
                    require(i + 1 < args.size) { "--assets-root requires a directory" }
                    require(!identityLocked) { "Packaged DSX assets cannot be replaced by --assets-root" }
                    assetsRoot = Path.of(args[++i])
                }
                "--dsx-self-test" -> selfTest = true
                "--dsx-self-test-output" -> {
                    require(i + 1 < args.size) { "--dsx-self-test-output requires a path" }
                    selfTestOutput = Path.of(args[++i])
                }
                "--dsx-ui-smoke" -> uiSmoke = true
                "--help", "-h" -> help = true
                else -> throw IllegalArgumentException("Unknown DSX desktop option: $arg")
            }
            i += 1
        }
        require(selfTest || selfTestOutput == null) { "--dsx-self-test-output requires --dsx-self-test" }
        require(isPortableTitle(title)) {
            "Invalid --title; expected 1-64 portable title characters"
        }
        appId?.let { candidate ->
            require(candidate.matches(Regex("[A-Za-z0-9][A-Za-z0-9.-]{1,127}"))) { "Invalid --app-id" }
        }
        require(entryResource == null || entryResource == APP_ENTRY_RESOURCE) {
            "Only the build-owned $APP_ENTRY_RESOURCE resource can be selected"
        }
        return Options(
            entry = entry,
            entryResource = entryResource,
            title = title,
            appId = appId,
            assetsRoot = assetsRoot,
            identityLocked = identityLocked,
            selfTest = selfTest,
            selfTestOutput = selfTestOutput,
            uiSmoke = uiSmoke,
            help = help,
        )
    }

    fun configureAppContext(options: Options) {
        DesktopAppIdentity.configure(options.appId)
        if (options.identityLocked) System.clearProperty("dsx.assets.root")
        val root = options.assetsRoot ?: options.entry?.toAbsolutePath()?.normalize()?.parent
        root?.let { System.setProperty("dsx.assets.root", it.toAbsolutePath().normalize().toString()) }
    }

    /** Read an explicitly selected local DSX entry without following a final symlink,
     * with pre/post identity checks and a hard byte ceiling. The application packager
     * normally uses bundled resources; the path form is for generated app bundles and
     * developer launchers, not an ambient file-discovery mechanism. */
    fun loadEntry(path: Path): Document {
        require(path.fileName?.toString()?.lowercase()?.endsWith(".dsx") == true) {
            "Desktop entry must use the .dsx extension"
        }
        val absolute = path.toAbsolutePath().normalize()
        require(!Files.isSymbolicLink(absolute)) { "Desktop entry must not be a symbolic link" }
        val before = Files.readAttributes(
            absolute,
            java.nio.file.attribute.BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        require(before.isRegularFile) { "Desktop entry must be a regular file" }
        require(before.size() <= MAX_DSX_BYTES) { "Desktop entry exceeds the $MAX_DSX_BYTES-byte limit" }

        val options: Set<OpenOption> = setOf(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)
        val bytes = Files.newByteChannel(absolute, options).use { channel ->
            val out = ByteArrayOutputStream(minOf(before.size(), 64L * 1024L).toInt())
            val buffer = java.nio.ByteBuffer.allocate(16 * 1024)
            var total = 0L
            while (true) {
                buffer.clear()
                val count = channel.read(buffer)
                if (count < 0) break
                total += count
                require(total <= MAX_DSX_BYTES) { "Desktop entry grew beyond the $MAX_DSX_BYTES-byte limit while reading" }
                out.write(buffer.array(), 0, count)
            }
            out.toByteArray()
        }
        val after = Files.readAttributes(
            absolute,
            java.nio.file.attribute.BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        require(after.isRegularFile && before.fileKey() == after.fileKey() && after.size() == bytes.size.toLong()) {
            "Desktop entry changed while reading"
        }
        val text = decodeUtf8(bytes)
        require(!text.contains('\u0000')) { "Desktop entry contains NUL bytes" }
        return Document(absolute.toString(), text)
    }

    fun loadBundled(resource: String): Document {
        require(resource == WELCOME_RESOURCE || resource == FAILURE_RESOURCE || resource == APP_ENTRY_RESOURCE) {
            "Unknown bundled DSX resource"
        }
        val bytes = DesktopHost::class.java.getResourceAsStream(resource)?.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8 * 1024)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                require(total <= MAX_DSX_BYTES) { "Bundled DSX resource exceeds the byte limit" }
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        } ?: error("Missing bundled DSX resource: $resource")
        return Document(resource, decodeUtf8(bytes))
    }

    fun resolveDocument(options: Options): Document = try {
        options.entryResource?.let(::loadBundled)
            ?: options.entry?.let(::loadEntry)
            ?: loadBundled(WELCOME_RESOURCE)
    } catch (failure: Throwable) {
        loadBundled(FAILURE_RESOURCE).copy(
            initialVariables = mapOf(
                "diagnostic" to (failure.message ?: failure.javaClass.simpleName),
                "source" to (options.entry?.toString() ?: options.entryResource ?: "bundled entry"),
            ),
        )
    }

    /** Display-free installed-runtime check. The output is one stable JSON line so
     * deb/rpm/msi/exe verification can assert it without locale-sensitive scraping. */
    fun selfTest(
        out: PrintStream = System.out,
        osName: String = System.getProperty("os.name") ?: "",
        output: Path? = null,
        properties: Map<String, String> = runtimeProperties(),
    ): Int = try {
        val os = boot(osName)
        val welcome = loadBundled(WELCOME_RESOURCE)
        val failure = loadBundled(FAILURE_RESOURCE)
        check(parseDocument(welcome) != null) { "welcome_parse" }
        check(parseDocument(failure) != null) { "failure_parse" }
        properties["dsx.app.entry.resource"]?.takeIf(String::isNotBlank)?.let { resource ->
            check(resource == APP_ENTRY_RESOURCE) { "packaged_entry_resource" }
            check(parseDocument(loadBundled(resource)) != null) { "packaged_entry_parse" }
        }
        val store = StackStore()
        check(JSE.eval("platform.desktop", store, null) == true) { "desktop_identity" }
        check(JSE.eval("platform.native", store, null) == true) { "native_identity" }
        check(ModuleRegistry.shared.currentPlatform == os) { "module_identity" }
        check(
            ModuleRegistry.shared.platformSupport.isNotEmpty() &&
                ModuleRegistry.shared.platformSupport == DesktopPackageCatalog.byScheme
        ) { "package_catalog" }
        if (os == "windows" || os == "linux") {
            check(ModuleRegistry.shared.isAvailable("global")) { "desktop_state_package" }
            check(ModuleRegistry.shared.isAvailable("multiapicall")) { "desktop_multicall_package" }
        }
        val attrs = PlatformAttrs.resolve(
            mapOf("value" to "base", "value:native" to "native", "value:desktop" to "desktop", "value:$os" to "exact"),
            os,
        )
        check(attrs["value"] == "exact") { "platform_suffix" }
        val json = "{\"schema\":\"dev.dsx.desktop-self-test/v1\",\"status\":\"ok\",\"os\":\"$os\",\"desktop\":true,\"native\":true,\"renderer\":\"compose\"}"
        output?.let { writeSelfTestOutput(it, json) }
        out.println("DSX_DESKTOP_SELF_TEST $json")
        0
    } catch (failure: Throwable) {
        val code = failure.message?.replace(Regex("[^A-Za-z0-9_.-]"), "_")?.take(80) ?: failure.javaClass.simpleName
        out.println("DSX_DESKTOP_SELF_TEST {\"schema\":1,\"status\":\"error\",\"code\":\"$code\"}")
        1
    }

    private fun writeSelfTestOutput(rawPath: Path, json: String) {
        val path = rawPath.toAbsolutePath().normalize()
        require(!Files.isSymbolicLink(path)) { "self-test output must not be a symbolic link" }
        val parent = path.parent ?: throw IllegalArgumentException("self-test output needs a parent directory")
        require(Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) { "self-test output parent is not a directory" }
        val temporary = Files.createTempFile(parent, ".dsx-self-test-", ".json")
        try {
            Files.writeString(temporary, "$json\n", StandardCharsets.UTF_8, StandardOpenOption.TRUNCATE_EXISTING)
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(temporary)
        }
    }

    private fun decodeUtf8(bytes: ByteArray): String = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(java.nio.ByteBuffer.wrap(bytes))
        .toString()

    internal fun parseDocument(document: Document): StackNode? {
        val root = StackXML.parse(document.markup, DOCUMENT_LIMITS) ?: return null
        val rejection = componentExpansionRejection(root)
        if (rejection != null) {
            StackXML.kernelLog("[Stack] Desktop component admission failed — $rejection. Surface will be empty.")
            return null
        }
        return root
    }

    fun usage(): String = """
        DSX native desktop runtime
          --entry <file.dsx>    mount a local DSX entry (default: bundled welcome screen)
          --entry-resource <resource>  mount the build-owned packaged application entry
          --title <name>        set the native window title
          --app-id <identifier> namespace app-owned persistence (or DSX_APP_ID)
          --assets-root <dir>   grant local image access within one app-owned directory
          --dsx-self-test       run the display-free installed-runtime verification
          --dsx-self-test-output <json>  atomically write the self-test result
          --dsx-ui-smoke        open the real native Compose window for UI automation
    """.trimIndent()

    private fun desktopSystemProperties(): Map<String, String> = listOf(
        "dsx.app.entry.resource",
        "dsx.app.title",
        "dsx.app.id",
        "dsx.app.version",
        "dsx.app.build",
        "dsx.app.identity.locked",
        "dsx.app.assets.prefix",
        "dsx.assets.root",
    ).mapNotNull { key ->
        runCatching { System.getProperty(key) }.getOrNull()
            ?.takeIf(String::isNotBlank)?.let { key to it }
    }.toMap()

    /** The generated classpath identity is the package authority. Launcher JVM
     * options remain useful evidence for OS package inspection, but JVM injection
     * mechanisms such as `_JAVA_OPTIONS` cannot replace or unlock this record. */
    internal fun runtimeProperties(
        systemProperties: Map<String, String> = desktopSystemProperties(),
        packagedIdentity: Map<String, String>? = loadPackagedIdentity(),
    ): Map<String, String> {
        if (packagedIdentity == null) return systemProperties
        APP_IDENTITY_KEYS.forEach { key ->
            systemProperties[key]?.let { supplied ->
                require(supplied == packagedIdentity.getValue(key)) {
                    "Packaged DSX identity property $key does not match the embedded identity"
                }
            }
        }
        return systemProperties + packagedIdentity
    }

    internal fun loadPackagedIdentity(): Map<String, String>? {
        val name = APP_IDENTITY_RESOURCE.removePrefix("/")
        val resources = DesktopHost::class.java.classLoader.getResources(name).toList()
        if (resources.isEmpty()) return null
        require(resources.size == 1) { "A DSX package must contain exactly one $APP_IDENTITY_RESOURCE" }
        val bytes = resources.single().openStream().use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(4 * 1024)
            var total = 0
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total = Math.addExact(total, count)
                require(total <= 16 * 1024) { "Packaged DSX identity exceeds 16 KiB" }
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        }
        return parsePackagedIdentity(decodeUtf8(bytes))
    }

    internal fun parsePackagedIdentity(text: String): Map<String, String> {
        require(!text.contains('\r') && text.endsWith('\n')) {
            "Packaged DSX identity must be LF-only and newline terminated"
        }
        val values = LinkedHashMap<String, String>()
        text.dropLast(1).split('\n').forEach { line ->
            require(line.isNotEmpty() && !line.startsWith('#') && !line.startsWith('!')) {
                "Packaged DSX identity contains an invalid line"
            }
            val separator = line.indexOf('=')
            require(separator > 0 && line.indexOf('=', separator + 1) < 0) {
                "Packaged DSX identity must use one unescaped key=value pair per line"
            }
            val key = line.substring(0, separator)
            require(key in APP_IDENTITY_KEYS && values.put(key, line.substring(separator + 1)) == null) {
                "Packaged DSX identity contains an unknown or duplicate key"
            }
        }
        require(values.keys == APP_IDENTITY_KEYS) { "Packaged DSX identity key set is incomplete" }
        require(values.getValue("dsx.identity.schema") == APP_IDENTITY_SCHEMA) { "Packaged DSX identity schema mismatch" }
        require(values.getValue("dsx.app.identity.locked") == "true") { "Packaged DSX identity must be locked" }
        val appId = values.getValue("dsx.app.id")
        require(appId.matches(Regex("[a-z0-9][a-z0-9.-]{1,127}"))) { "Invalid packaged DSX app id" }
        val title = values.getValue("dsx.app.title")
        require(isPortableTitle(title)) { "Invalid packaged DSX app title" }
        val version = values.getValue("dsx.app.version")
        val versionParts = version.split('.').map { it.toLongOrNull() }
        require(
            version.matches(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")) &&
                versionParts.size == 3 && versionParts[0] != null && versionParts[0]!! <= 255L &&
                versionParts[1] != null && versionParts[1]!! <= 255L &&
                versionParts[2] != null && versionParts[2]!! <= 65_535L
        ) { "Invalid packaged DSX version" }
        require(values.getValue("dsx.app.build").matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,63}"))) {
            "Invalid packaged DSX build"
        }
        require(values.getValue("dsx.app.entry.resource") in setOf("", APP_ENTRY_RESOURCE)) {
            "Invalid packaged DSX entry resource"
        }
        require(values.getValue("dsx.app.assets.prefix") in setOf("", APP_ASSETS_PREFIX)) {
            "Invalid packaged DSX asset prefix"
        }
        return values
    }

    private fun isPortableTitle(title: String): Boolean =
        title.matches(Regex("[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}")) &&
            !title.endsWith('.') &&
            !title.matches(Regex("(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?", RegexOption.IGNORE_CASE))

    private data class ComponentSlotEnvironment(
        val children: List<StackNode>,
        val parent: ComponentSlotEnvironment?,
    )

    private data class ExpansionFrame(
        val node: StackNode,
        val depth: Int,
        val slots: ComponentSlotEnvironment?,
    )

    /** Proves a finite upper bound for the actual component/slot expansion before
     * recursive Compose functions see it. This rejects dormant cycles too: a signed
     * application must not contain a payload that becomes unsafe after a state change. */
    internal fun componentExpansionRejection(
        root: StackNode,
        admittedComponents: Map<String, StackNode>? = null,
    ): String? {
        // A normal document owns declarations embedded in its own tree. Remote
        // folders pass the final additive table instead: its templates live in
        // separate files, so validating each parsed file in isolation cannot see
        // a cross-file cycle or exponential fan-out.
        val components = LinkedHashMap(admittedComponents ?: desktopDeclaredComponents(root))
        if (components.isEmpty()) return null

        fun namedStyleMaySupplyStructuralAttribute(authored: Map<String, String>): Boolean {
            if (authored["class"]?.isNotBlank() == true) return true
            val style = authored["style"] ?: return false
            // Class/style classification happens after interpolation in the renderer.
            // An authored ternary such as `{{useCard ? 'card' : 'padding: 8px'}}`
            // contains a colon here but may resolve to a colon-free named style at
            // runtime. Treat every interpolated style as a possible named structural
            // source before applying the static inline-CSS distinction.
            if (style.contains("{{") || style.contains("${'$'}{")) return true
            // The desktop cascade treats colon-free `style` values as legacy
            // named-style references. Inline CSS and css-owner sheets pass
            // through CSSBridge, whose mapping cannot emit `tag` or `name`.
            return style.isNotBlank() && !style.contains(':')
        }

        fun effectiveTag(node: StackNode): String? {
            if (node.tag !in setOf("node", "dynamic")) return node.tag
            val authored = PlatformAttrs.resolve(node.attrs, Platform.attributeTarget)
            val rawTag = authored["tag"]
            // A named style can provide `tag` when no explicit value exists.
            // Such a target is state/style dependent and therefore has no finite
            // static component-expansion proof.
            if (rawTag == null && namedStyleMaySupplyStructuralAttribute(authored)) {
                return null
            }
            val tag = rawTag.orEmpty()
            if (tag.contains("{{") || tag.contains("${'$'}{")) return null
            return tag.ifEmpty { node.tag }
        }

        val graph = components.keys.associateWith { LinkedHashSet<String>() }.toMutableMap()
        for ((owner, template) in components) {
            val dependencyNodes = java.util.ArrayDeque<StackNode>()
            dependencyNodes.addLast(template)
            while (dependencyNodes.isNotEmpty()) {
                val node = dependencyNodes.removeLast()
                if (node.tag == "component") continue
                val tag = effectiveTag(node)
                    ?: return "dynamic component target in component $owner cannot be bounded"
                if (tag in components) graph.getValue(owner).add(tag)
                for (index in node.children.indices.reversed()) dependencyNodes.addLast(node.children[index])
            }
        }

        val indegree = components.keys.associateWith { 0 }.toMutableMap()
        graph.values.forEach { dependencies ->
            dependencies.forEach { dependency -> indegree[dependency] = indegree.getValue(dependency) + 1 }
        }
        val ready = java.util.ArrayDeque<String>()
        indegree.filterValues { it == 0 }.keys.forEach(ready::addLast)
        var visited = 0
        while (ready.isNotEmpty()) {
            val owner = ready.removeFirst()
            visited += 1
            graph.getValue(owner).forEach { dependency ->
                val remaining = indegree.getValue(dependency) - 1
                indegree[dependency] = remaining
                if (remaining == 0) ready.addLast(dependency)
            }
        }
        if (visited != components.size) return "component dependency cycle"

        val pending = java.util.ArrayDeque<ExpansionFrame>()
        pending.addLast(ExpansionFrame(root, 1, null))
        var expandedNodes = 0
        val inert = setOf("event", "expects", "action", "variable", "var", "let", "formula", "script", "functions", "style", "attribute", "component")
        while (pending.isNotEmpty()) {
            val frame = pending.removeLast()
            expandedNodes += 1
            if (expandedNodes > MAX_EXPANDED_DSX_NODES) return "expanded document exceeds $MAX_EXPANDED_DSX_NODES nodes"
            if (frame.depth > MAX_EXPANDED_DSX_DEPTH) return "expanded document exceeds depth $MAX_EXPANDED_DSX_DEPTH"
            val tag = effectiveTag(frame.node)
                ?: return "dynamic component target cannot be bounded"
            val template = components[tag]
            if (template != null) {
                val slots = frame.node.children.takeIf { it.isNotEmpty() }?.let { children ->
                    ComponentSlotEnvironment(children, frame.slots)
                }
                pending.addLast(ExpansionFrame(template, frame.depth + 1, slots))
                continue
            }
            if (tag == "slot") {
                val environment = frame.slots
                val children = if (environment == null) frame.node.children else {
                    val authored = PlatformAttrs.resolve(frame.node.attrs, Platform.attributeTarget)
                    val name = authored["name"]
                    val styleCanSupplyName = name == null && namedStyleMaySupplyStructuralAttribute(authored)
                    if (styleCanSupplyName || name?.contains("{{") == true || name?.contains("${'$'}{") == true) environment.children
                    else environment.children.filter { child -> child.attrs["slot"] == name }
                }
                val parent = environment?.parent
                for (index in children.indices.reversed()) {
                    pending.addLast(ExpansionFrame(children[index], frame.depth + 1, parent))
                }
                continue
            }
            if (tag in inert) continue
            for (index in frame.node.children.indices.reversed()) {
                pending.addLast(ExpansionFrame(frame.node.children[index], frame.depth + 1, frame.slots))
            }
        }
        return null
    }
}

fun main(args: Array<String>) {
    val options = try {
        DesktopHost.parseOptions(args)
    } catch (failure: IllegalArgumentException) {
        System.err.println(failure.message)
        System.err.println(DesktopHost.usage())
        exitProcess(64)
    }
    if (options.help) {
        println(DesktopHost.usage())
        return
    }
    DesktopHost.configureAppContext(options)
    if (options.selfTest) exitProcess(DesktopHost.selfTest(output = options.selfTestOutput))

    try {
        DesktopHost.boot()
        // `--dsx-ui-smoke` intentionally follows the same production launch path. Its
        // presence is a stable automation contract; the visible title remains the
        // immutable app-specific package title.
        DesktopApplication.launch(options.title, DesktopHost.resolveDocument(options), options.uiSmoke)
    } catch (failure: Throwable) {
        System.err.println("DSX desktop launch failed: ${failure.message ?: failure.javaClass.simpleName}")
        exitProcess(70)
    }
}
