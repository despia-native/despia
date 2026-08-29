package despia.engine.desktop

import despia.engine.GeneratedModuleSchemes
import despia.engine.Module
import despia.engine.ModuleRegistry
import despia.engine.Platform
import java.nio.charset.StandardCharsets

/** Full package-catalog support facts plus the generator-owned allowlist of enabled
 * desktop factories. The full catalog never loads code or promises availability by
 * itself: only explicit, compiled Windows/Linux facet records register. A package with
 * no implementation on this OS therefore receives `unsupported_platform`; an explicit
 * implementation excluded from this build remains the distinct `not_loaded` case. */
internal object DesktopPackageCatalog {
    private const val RESOURCE = "/dsx/ModulePlatformSupport.generated.tsv"
    private const val ACTION_RESOURCE = "/dsx/ModuleActionPlatformSupport.generated.tsv"
    private const val IMPLEMENTATIONS_RESOURCE = "/dsx/DesktopPackageImplementations.generated.tsv"
    // These are DSX routing keys/chains, not necessarily RFC URI schemes.
    // Keep the core/DSXGraph grammar, including structured underscore keys.
    private val routePattern = Regex("[a-z0-9][a-z0-9._-]{0,127}")
    private val classPattern = Regex("despia\\.modules(?:\\.[A-Za-z_][A-Za-z0-9_]*)+\\.[A-Z][A-Za-z0-9_]{0,127}")
    // The full catalog vocabulary, in DSXGraph.PLATFORM_SUPPORT_ORDER. `web` is a support
    // FACT like any other here — the desktop host never runs it, but a row that omitted it
    // would tell a Windows caller a browser-implemented action is implemented nowhere.
    private val platformOrder = listOf("ios", "android", "web", "macos", "windows", "linux")
    private val desktopTargetOrder = listOf("windows", "linux")
    private val installedTargets = HashSet<String>()
    private val requiredHeader = listOf(
        "# ModulePlatformSupport.generated.tsv",
        "# Generated from ClosedSource/DSX/Modules/**/dsx.json by prepare_modules_android.rb.",
        "# Support facts only: this file does not load or promise any package implementation.",
        "# scheme<TAB>comma-separated concrete implementation platforms",
    )

    private val requiredActionHeader = listOf(
        "# ModuleActionPlatformSupport.generated.tsv",
        "# Generated from ClosedSource/DSX/Modules/**/dsx.json `actions[].platforms` by prepare_modules_android.rb.",
        "# Support facts only: this file does not load or promise any package implementation.",
        "# scheme.action<TAB>comma-separated concrete implementation platforms",
    )

    val byScheme: Map<String, List<String>> by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        parse(readResource(RESOURCE, "module-support"))
    }

    /** The ACTION rows — "<scheme>.<action>" → the platforms that one action runs on. Sparse:
     * only manifest-declared narrowings appear. Read with the same bounded, schema-pinned
     * parser as the scheme table; an EMPTY table is legal here (no narrowing is declared yet),
     * which is the one place the two catalogs differ. */
    val byAction: Map<String, List<String>> by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        parse(readResource(ACTION_RESOURCE, "action-support"), requiredActionHeader, allowEmpty = true)
    }

    internal data class Implementation(
        val targets: List<String>,
        val key: String,
        val scheme: String?,
        val aliases: List<String>,
        val className: String,
        val bootEligible: Boolean,
    )

    val implementations: List<Implementation> by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        parseImplementations(readResource(IMPLEMENTATIONS_RESOURCE, "package-implementation"))
    }

    private fun readResource(path: String, label: String): String {
        val stream = DesktopPackageCatalog::class.java.getResourceAsStream(path)
            ?: error("Missing desktop $label catalog: $path")
        return stream.use { input ->
            val bytes = input.readNBytes(1_048_577)
            require(bytes.size <= 1_048_576) { "Desktop $label catalog exceeds 1 MiB" }
            String(bytes, StandardCharsets.UTF_8)
        }
    }

    internal fun parse(
        text: String,
        header: List<String> = requiredHeader,
        allowEmpty: Boolean = false,
    ): Map<String, List<String>> {
        val canonical = canonicalLineEndings(text, "module-support")
        require(canonical.endsWith('\n')) { "Desktop module-support catalog must end with LF" }
        val lines = canonical.removeSuffix("\n").split('\n')
        require(lines.take(header.size) == header) {
            "Desktop module-support catalog schema/header mismatch"
        }
        val parsed = LinkedHashMap<String, List<String>>()
        var records = 0
        var previousScheme: String? = null
        lines.drop(header.size).forEachIndexed { recordIndex, line ->
            val index = recordIndex + header.size
            require(line.isNotEmpty() && !line.startsWith('#')) {
                "Blank/comment desktop module-support record at line ${index + 1}"
            }
            records += 1
            require(records <= 4096) { "Desktop module-support catalog has too many records" }
            val columns = line.split('\t')
            require(columns.size == 2) { "Invalid desktop module-support record at line ${index + 1}" }
            val scheme = columns[0]
            require(routePattern.matches(scheme)) { "Invalid desktop module scheme at line ${index + 1}" }
            val priorScheme = previousScheme
            require(priorScheme == null || scheme > priorScheme) {
                "Desktop module schemes must be unique and sorted at line ${index + 1}"
            }
            previousScheme = scheme
            val platforms = columns[1].split(',')
            require(platforms.isNotEmpty() && platforms.all { it in platformOrder }) {
                "Invalid desktop module platforms at line ${index + 1}"
            }
            require(platforms.distinct() == platforms) { "Duplicate desktop module platform at line ${index + 1}" }
            require(platforms.map(platformOrder::indexOf).zipWithNext().all { (a, b) -> a < b }) {
                "Unstable desktop module platform order at line ${index + 1}"
            }
            require(parsed.put(scheme, platforms.toList()) == null) {
                "Duplicate desktop module scheme at line ${index + 1}"
            }
        }
        require(allowEmpty || parsed.isNotEmpty()) { "Desktop module-support catalog is empty" }
        return parsed.mapValues { (_, platforms) -> platforms.toList() }.toMap()
    }

    internal fun parseImplementations(text: String): List<Implementation> {
        val canonical = canonicalLineEndings(text, "package implementation")
        require(canonical.endsWith('\n')) { "Desktop package implementation catalog must end with LF" }
        val required = listOf(
            "# DesktopPackageImplementations.generated.tsv",
            "# Generated from enabled desktop Module subclasses; loaded only from this allowlist.",
            "# targets<TAB>registry-key<TAB>scheme<TAB>aliases<TAB>class<TAB>boot-eligible",
        )
        val lines = canonical.removeSuffix("\n").split('\n')
        require(lines.take(required.size) == required) {
            "Desktop package implementation catalog schema/header mismatch"
        }
        val records = ArrayList<Implementation>()
        val routeClaims = HashMap<Pair<String, String>, String>()
        val classes = HashSet<Pair<String, String>>()
        val simpleClasses = HashSet<Pair<String, String>>()
        lines.drop(required.size).forEachIndexed { index, line ->
            require(line.isNotBlank() && !line.startsWith('#')) {
                "Blank/comment desktop package implementation at line ${index + required.size + 1}"
            }
            require(records.size < 4096) { "Desktop package implementation catalog has too many records" }
            val columns = line.split('\t')
            require(columns.size == 6) { "Invalid desktop package implementation at line ${index + required.size + 1}" }
            val targets = columns[0].split(',')
            require(
                targets.isNotEmpty() &&
                    targets.distinct() == targets &&
                    targets.all { it in desktopTargetOrder } &&
                    targets.map(desktopTargetOrder::indexOf).zipWithNext().all { (a, b) -> a < b }
            ) {
                "Invalid desktop implementation targets at line ${index + required.size + 1}"
            }
            val key = columns[1]
            require(routePattern.matches(key)) { "Invalid desktop implementation key at line ${index + required.size + 1}" }
            val scheme = columns[2].takeUnless { it == "-" }
            require(scheme == null || routePattern.matches(scheme)) {
                "Invalid desktop implementation scheme at line ${index + required.size + 1}"
            }
            val aliases = columns[3].takeUnless { it == "-" }?.split(',').orEmpty()
            require(
                aliases.distinct() == aliases &&
                    aliases == aliases.sorted() &&
                    aliases.all(routePattern::matches) &&
                    aliases.none { it == key || it == scheme }
            ) {
                "Invalid desktop implementation aliases at line ${index + required.size + 1}"
            }
            val claimedRoutes = listOfNotNull(key, scheme) + aliases
            require("dsx" !in claimedRoutes) {
                "Reserved desktop implementation route at line ${index + required.size + 1}"
            }
            val className = columns[4]
            val simpleClassName = className.substringAfterLast('.')
            require(classPattern.matches(className)) {
                "Invalid desktop implementation class at line ${index + required.size + 1}"
            }
            val bootEligible = when (columns[5]) {
                "true" -> true
                "false" -> false
                else -> throw IllegalArgumentException("Invalid desktop boot flag at line ${index + required.size + 1}")
            }
            targets.forEach { target ->
                require(classes.add(target to className) && simpleClasses.add(target to simpleClassName)) {
                    "Duplicate desktop implementation class '$className' or simple name '$simpleClassName' for $target"
                }
                claimedRoutes.distinct().forEach { route ->
                    val identity = target to route
                    val prior = routeClaims.putIfAbsent(identity, className)
                    require(prior == null) {
                        "Desktop implementation route '$route' for $target is claimed by both $prior and $className"
                    }
                }
            }
            records += Implementation(targets, key, scheme, aliases, className, bootEligible)
        }
        return records.toList()
    }

    private fun canonicalLineEndings(text: String, label: String): String {
        require(!text.contains('\u0000')) { "Desktop $label catalog contains NUL" }
        text.forEachIndexed { index, character ->
            require(character != '\r' || text.getOrNull(index + 1) == '\n') {
                "Desktop $label catalog contains a bare carriage return"
            }
        }
        return text.replace("\r\n", "\n")
    }

    @Synchronized
    fun install() {
        ModuleRegistry.shared.platformSupport = byScheme
        ModuleRegistry.shared.platformSupportByAction = byAction
        val os = Platform.os
        require(os == "windows" || os == "linux" || os == "macos") {
            "Desktop package catalog cannot install for platform '$os'"
        }
        // macOS product packages ride the Swift/Catalyst lane. The JVM host is a
        // developer renderer there and must not double-register another package set.
        if (os == "macos") return
        if (os in installedTargets) return

        val selected = implementations.filter { os in it.targets }
        val byClass = LinkedHashMap<String, String>()
        val aliasesByClass = LinkedHashMap<String, List<String>>()
        val factories = LinkedHashMap<String, () -> Module>()
        val boot = LinkedHashSet<String>()
        selected.forEach { implementation ->
            val loaded = Class.forName(implementation.className).asSubclass(Module::class.java)
            val constructor = loaded.getConstructor()
            val simpleName = loaded.simpleName
            implementation.scheme?.let { declared ->
                require(byClass.put(simpleName, declared) == null) {
                    "Duplicate desktop module simple class name: $simpleName"
                }
            }
            if (implementation.aliases.isNotEmpty()) {
                require(aliasesByClass.put(simpleName, implementation.aliases) == null) {
                    "Duplicate desktop module alias class name: $simpleName"
                }
            }
            factories[implementation.key] = {
                constructor.newInstance().also { module ->
                    implementation.scheme?.let { declared ->
                        require(module.resolvedScheme.equals(declared, ignoreCase = true)) {
                            "Desktop module ${implementation.className} resolved scheme " +
                                "'${module.resolvedScheme}' instead of '$declared'"
                        }
                    }
                }
            }
            if (implementation.bootEligible) boot += implementation.key
        }
        GeneratedModuleSchemes.byClassName = byClass.toMap()
        GeneratedModuleSchemes.aliasesByClassName = aliasesByClass.toMap()
        ModuleRegistry.shared.register(factories, bootEligible = boot)
        installedTargets += os
    }
}
