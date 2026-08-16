package despia.engine.desktop

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import java.nio.charset.StandardCharsets

/**
 * The desktop CAPABILITY TABLE — the seam that retired this renderer's hard-coded
 * `when (tag)` branches over surface names.
 *
 * A surface tag does not "mean something" to the engine; it REQUIRES a native capability.
 * The table says which — as data (`resources/dsx/DesktopCapabilities.tsv`, header-pinned and
 * validated exactly like [DesktopPackageCatalog]) — and this object answers two questions
 * about it:
 *
 *   • `renderer(capability)` — does this build bundle an implementation? If so, render it.
 *   • `failure(tag)`         — if not, what does the app honestly report?
 *
 * That inversion is the point (root-plan.md rule 18, "the kernel names no surface"). Before
 * it, `desktopNativeUnavailableTags` listed five component names in Kotlin and a `when`
 * branched on a sixth, so shipping a desktop 3D engine — or a new surface of any kind —
 * meant editing the renderer. Now a capability is bound in code, a tag is declared in data,
 * and neither one spells the other's name.
 *
 * A tag with a row but no bound renderer is NOT a blank box and NOT an unsafe fallback: it
 * gets the first-party failure surface carrying the row's code/capability/message, which is
 * the same machine-readable contract [DesktopUnavailableElement] always emitted.
 */
internal object DesktopCapabilities {

    private const val RESOURCE = "/dsx/DesktopCapabilities.tsv"
    private val idPattern = Regex("[a-z0-9][a-z0-9-]{0,63}")
    private val tagPattern = Regex("[A-Za-z][A-Za-z0-9_.-]{0,127}")
    private val requiredHeader = listOf(
        "# DesktopCapabilities.tsv",
        "# The desktop CAPABILITY table: which native capability a surface tag needs, and what a",
        "# build that does not bundle that capability answers. DATA, not code — the engine names",
        "# capabilities, never surfaces (root-plan.md rule 18). Presence here is not certification.",
        "# capability<TAB>id<TAB>failure-code<TAB>message      (\"-\" code/message = a bound capability)",
        "# tag<TAB>component-tag<TAB>capability-id",
    )

    /** The generic answer for a tag the table claims but no row explains — the shape the
     *  hand-written `else ->` branch always produced. */
    private val unknownFailure = DesktopCapabilityFailure(
        "native_capability_unavailable",
        "unknown",
        "This native DSX capability is unavailable in the current desktop build.",
    )

    internal data class Declaration(
        val capabilities: Map<String, DesktopCapabilityFailure>,
        val tags: Map<String, String>,
    )

    private val declaration: Declaration by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        parse(readResource())
    }

    /** Every tag the table claims. The renderer dispatches on membership, never on a name. */
    val tags: Set<String> get() = declaration.tags.keys

    /**
     * Capability implementations present in THIS build. Built-ins are bound here — a
     * capability→composable map, which is the direction that stays legal: code may name a
     * CAPABILITY, never a surface. A desktop-capable package may add its own at boot.
     */
    private val lock = Any()
    private val bound = LinkedHashMap<String, @Composable (DesktopElementContext, Modifier) -> Unit>(
        linkedMapOf<String, @Composable (DesktopElementContext, Modifier) -> Unit>(
            "remote-dsx-document" to { context, modifier -> DesktopRemoteDsxView(context, modifier) },
        )
    )

    /** Register an implementation for a capability id. Idempotent (replaces). */
    fun bind(capability: String, renderer: @Composable (DesktopElementContext, Modifier) -> Unit) {
        val key = capability.trim()
        require(idPattern.matches(key)) { "Invalid DSX desktop capability id" }
        synchronized(lock) { bound[key] = renderer }
    }

    /** The implementation for the capability this TAG requires, or null when the build
     *  does not bundle one (→ [failure] explains what is missing). */
    internal fun renderer(tag: String): (@Composable (DesktopElementContext, Modifier) -> Unit)? {
        val capability = declaration.tags[tag] ?: return null
        return synchronized(lock) { bound[capability] }
    }

    /** What an unbundled capability honestly reports for this tag. */
    internal fun failure(tag: String): DesktopCapabilityFailure {
        val capability = declaration.tags[tag] ?: return unknownFailure
        return declaration.capabilities[capability] ?: unknownFailure
    }

    private fun readResource(): String {
        val stream = DesktopCapabilities::class.java.getResourceAsStream(RESOURCE)
            ?: error("Missing desktop capability table: $RESOURCE")
        return stream.use { input ->
            val bytes = input.readNBytes(1_048_577)
            require(bytes.size <= 1_048_576) { "Desktop capability table exceeds 1 MiB" }
            String(bytes, StandardCharsets.UTF_8)
        }
    }

    internal fun parse(text: String): Declaration {
        require(!text.contains('\u0000')) { "Desktop capability table contains NUL" }
        text.forEachIndexed { index, character ->
            require(character != '\r' || text.getOrNull(index + 1) == '\n') {
                "Desktop capability table contains a bare carriage return"
            }
        }
        val canonical = text.replace("\r\n", "\n")
        require(canonical.endsWith('\n')) { "Desktop capability table must end with LF" }
        val lines = canonical.removeSuffix("\n").split('\n')
        require(lines.take(requiredHeader.size) == requiredHeader) {
            "Desktop capability table schema/header mismatch"
        }
        val capabilities = LinkedHashMap<String, DesktopCapabilityFailure>()
        val tags = LinkedHashMap<String, String>()
        lines.drop(requiredHeader.size).forEachIndexed { recordIndex, line ->
            val at = recordIndex + requiredHeader.size + 1
            require(line.isNotEmpty() && !line.startsWith('#')) {
                "Blank/comment desktop capability record at line $at"
            }
            require(capabilities.size + tags.size < 4096) { "Desktop capability table has too many records" }
            val columns = line.split('\t')
            when (columns.firstOrNull()) {
                "capability" -> {
                    require(columns.size == 4) { "Invalid desktop capability record at line $at" }
                    val id = columns[1]
                    require(idPattern.matches(id)) { "Invalid desktop capability id at line $at" }
                    val code = columns[2]
                    val message = columns[3]
                    // "-" declares a capability this build is expected to BIND; it has no
                    // failure copy of its own and degrades to the generic answer if unbound.
                    val failure = if (code == "-") unknownFailure
                    else DesktopCapabilityFailure(code, id, message)
                    require(capabilities.put(id, failure) == null) {
                        "Duplicate desktop capability '$id' at line $at"
                    }
                }
                "tag" -> {
                    require(columns.size == 3) { "Invalid desktop tag record at line $at" }
                    val tag = columns[1]
                    val capability = columns[2]
                    require(tagPattern.matches(tag)) { "Invalid desktop capability tag at line $at" }
                    require(idPattern.matches(capability)) { "Invalid desktop capability id at line $at" }
                    require(capability in capabilities) {
                        "Desktop tag at line $at names capability '$capability' declared after it (or not at all)"
                    }
                    require(tags.put(tag, capability) == null) { "Duplicate desktop tag at line $at" }
                }
                else -> throw IllegalArgumentException("Unknown desktop capability record kind at line $at")
            }
        }
        require(tags.isNotEmpty()) { "Desktop capability table declares no tags" }
        return Declaration(capabilities.toMap(), tags.toMap())
    }
}
