package despia.engine

/**
 * WebMcp.kt — the platform-neutral half of WebMCP (proposals/webmcp.md), both directions.
 *
 * Twin of `@despia-native/kernel/mcp` webmcp.ts and `Engine/iOS/WebMcp.swift`; all three run
 * OpenSource/Conformance/webmcp/{project,registry}.json, which is where the law actually
 * lives. Pure Kotlin — no `android.webkit`, no Compose, no I/O — because the `<tool>` row
 * parses on every renderer and the page table's law must be identical wherever a shell
 * implements it.
 *
 * OUTBOUND: a `<tool>` head row projected as a W3C WebMCP tool descriptor. The row names a
 * declared action and carries no schema of its own — the descriptor's `inputSchema` is
 * DERIVED from that action's declared inputs, exactly as `facets.mcp` derives from an
 * action's `args`. One contract, one place it can change.
 *
 * INBOUND: the page tool table a shell keeps when a page registers through
 * `document.modelContext`. Policy-free: it records, validates and forgets.
 */
object WebMcp {

    /** The spec's tool-name grammar: 1..128 chars of ASCII alphanumeric plus `_`, `-`, `.`. */
    private val TOOL_NAME = Regex("^[A-Za-z0-9_.\\-]{1,128}$")

    fun isValidToolName(name: String): Boolean = TOOL_NAME.matches(name)

    // ── outbound: the projection ───────────────────────────────────────────────────────

    /** One `<tool>` head row, verbatim. `as` is optional and defaults to `action`. */
    data class ToolRow(
        val action: String,
        val description: String,
        val asName: String? = null,
        val mutates: String? = null,
    )

    data class Descriptor(
        val name: String,
        val description: String,
        /** Property names in declaration order; every property is the empty schema. */
        val inputs: List<String>,
        val readOnlyHint: Boolean,
    ) {
        /** The wire shape a browser adapter hands to `registerTool`. */
        fun toMap(): Map<String, Any?> {
            val properties = LinkedHashMap<String, Any?>()
            for (name in inputs) properties[name] = emptyMap<String, Any?>()
            val out = LinkedHashMap<String, Any?>()
            out["name"] = name
            out["description"] = description
            out["inputSchema"] = linkedMapOf<String, Any?>("type" to "object", "properties" to properties)
            // A mutating tool emits NO annotations: the spec's default for readOnlyHint is
            // already false, and restating it is a second place for one fact to live.
            if (readOnlyHint) out["annotations"] = linkedMapOf<String, Any?>("readOnlyHint" to true)
            return out
        }
    }

    enum class ProjectionErrorCode { UNKNOWN_ACTION, DUPLICATE_TOOL, INVALID_NAME, MISSING_DESCRIPTION;
        val wire: String
            get() = when (this) {
                UNKNOWN_ACTION -> "unknown_action"
                DUPLICATE_TOOL -> "duplicate_tool"
                INVALID_NAME -> "invalid_name"
                MISSING_DESCRIPTION -> "missing_description"
            }
    }

    data class ProjectionError(val code: ProjectionErrorCode, val name: String, val message: String)

    data class Projection(val descriptors: List<Descriptor>, val errors: List<ProjectionError>)

    /** The name a row projects under: `as` when given, the action name otherwise. */
    fun toolName(row: ToolRow): String {
        val given = row.asName?.trim().orEmpty()
        return if (given.isNotEmpty()) given else row.action
    }

    /**
     * Project a document's `<tool>` rows into WebMCP descriptors.
     *
     * `actionInputs` maps every action the document declares to its declared input names in
     * declaration order. A row naming anything absent from that map is the stale-target
     * class and comes back as an error the caller fails the build with.
     */
    fun project(rows: List<ToolRow>, actionInputs: Map<String, List<String>>): Projection {
        val descriptors = ArrayList<Descriptor>()
        val errors = ArrayList<ProjectionError>()
        val seen = HashSet<String>()

        for (row in rows) {
            val name = toolName(row)
            if (!isValidToolName(name)) {
                errors.add(ProjectionError(ProjectionErrorCode.INVALID_NAME, name,
                    "tool name \"$name\" must be 1 to 128 characters of ASCII letters, digits, \"_\", \"-\" or \".\""))
                continue
            }
            if (seen.contains(name)) {
                errors.add(ProjectionError(ProjectionErrorCode.DUPLICATE_TOOL, name,
                    "tool \"$name\" is declared twice - the second registration would be refused by the browser and the tool would silently not exist"))
                continue
            }
            val description = row.description.trim()
            if (description.isEmpty()) {
                errors.add(ProjectionError(ProjectionErrorCode.MISSING_DESCRIPTION, name,
                    "tool \"$name\" has an empty description - the description is the whole basis on which an agent chooses this tool"))
                continue
            }
            val inputs = actionInputs[row.action]
            if (inputs == null) {
                errors.add(ProjectionError(ProjectionErrorCode.UNKNOWN_ACTION, row.action,
                    "tool \"$name\" names action \"${row.action}\", which this document does not declare"))
                continue
            }
            seen.add(name)
            descriptors.add(Descriptor(name, description, inputs, row.mutates?.trim().orEmpty().isEmpty()))
        }
        return Projection(descriptors, errors)
    }

    // ── inbound: the page tool table ───────────────────────────────────────────────────

    data class PageTool(
        val surface: String,
        val origin: String,
        val name: String,
        val description: String,
        val inputSchema: Map<String, Any?>,
        val annotations: Map<String, Any?>?,
    ) {
        /**
         * DERIVED and always `required` in v1: a page vouching for its own tool is not
         * evidence, so a recorded `readOnlyHint` never lowers the gate. The hint is kept
         * because a consumer may weigh it; the decision is the consumer's.
         */
        val approval: String get() = "required"
    }

    enum class RejectionReason { INVALID_NAME, MISSING_DESCRIPTION, DUPLICATE_NAME;
        val wire: String
            get() = when (this) {
                INVALID_NAME -> "invalid_name"
                MISSING_DESCRIPTION -> "missing_description"
                DUPLICATE_NAME -> "duplicate_name"
            }
    }

    data class Rejection(val reason: RejectionReason, val name: String)

    /**
     * The page tool table.
     *
     * Every mutation that changes the VISIBLE SET emits exactly one change for its surface;
     * one that changes nothing emits none, because an event for an unchanged set is a lie a
     * consumer acts on.
     */
    class PageToolTable(private val onChange: (String) -> Unit = {}) {
        private val rows = ArrayList<PageTool>()

        /** Record one registration, or refuse it typed. Returns null when it was recorded. */
        fun register(
            surface: String,
            origin: String,
            name: String,
            description: String,
            inputSchema: Map<String, Any?>? = null,
            annotations: Map<String, Any?>? = null,
        ): Rejection? {
            if (!isValidToolName(name)) return Rejection(RejectionReason.INVALID_NAME, name)
            if (description.trim().isEmpty()) return Rejection(RejectionReason.MISSING_DESCRIPTION, name)
            if (rows.any { it.surface == surface && it.name == name }) {
                return Rejection(RejectionReason.DUPLICATE_NAME, name)
            }
            rows.add(PageTool(
                surface = surface,
                origin = origin,
                name = name,
                description = description,
                // The page wrote the schema, so the page's schema is the contract and rides
                // through untouched. An ABSENT schema is normalized, which is a default
                // rather than a rewrite.
                inputSchema = inputSchema ?: linkedMapOf("type" to "object", "properties" to emptyMap<String, Any?>()),
                annotations = annotations,
            ))
            onChange(surface)
            return null
        }

        /**
         * A navigation committed on this surface: every row the previous document
         * registered is gone. A same-origin reload drops them too, because it is a NEW
         * document whose callback registry the old rows named and no longer exists.
         */
        fun commit(surface: String): Boolean = dropWhere(surface) { it.surface == surface }

        /** The spec's unregister path: the AbortSignal passed at registration fired. */
        fun abort(surface: String, name: String): Boolean =
            dropWhere(surface) { it.surface == surface && it.name == name }

        /** Every recorded row, in registration order; one surface's when named. */
        fun tools(surface: String? = null): List<PageTool> =
            if (surface == null) rows.toList() else rows.filter { it.surface == surface }

        private fun dropWhere(surface: String, match: (PageTool) -> Boolean): Boolean {
            val before = rows.size
            rows.removeAll(match)
            val changed = rows.size != before
            if (changed) onChange(surface)
            return changed
        }
    }
}

/**
 * The MCP result shaping a WebMCP tool call answers with — the Kotlin twin of the kernel's
 * `mcpToolResult` / `fallbackText` (packages/kernel/src/mcp/result.ts), pinned by
 * Conformance/webmcp/project.json.
 *
 * A WebMCP agent and an MCP client must never be told different things about one call, so
 * the shape is the protocol's: a text `content` array that always carries something a model
 * can read, plus `structuredContent` for a host that wants the value itself.
 *
 * The scalar formatting is JS's `String(x)` and deliberately NOT `JSE.string(x)`: the JSE
 * coercion renders a boolean as "1"/"0" because that is the shipped BRIDGE behaviour, and
 * this is display text a model reads.
 */
object WebMcpResult {

    /** A resolved action value, MCP-shaped. */
    fun value(value: Any?): Map<String, Any?> = shape(value, text(value), false)

    /**
     * A thrown action is an error RESULT, never a transport failure: a rejection would tell
     * the agent the call never happened. The text carries the id an operator can grep and
     * never the exception, which may quote arguments the model supplied.
     */
    fun error(correlationId: String): Map<String, Any?> =
        shape(null, "tool failed (correlation $correlationId)", true)

    private fun shape(value: Any?, text: String, isError: Boolean): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["content"] = listOf(linkedMapOf<String, Any?>("type" to "text", "text" to text))
        out["structuredContent"] = value
        if (isError) out["isError"] = true
        return out
    }

    /** Deliberately plain and deterministic: a fallback, not a formatting engine. */
    fun text(value: Any?): String = when {
        value == null || value === NSNull -> "(no result)"
        value is String -> value
        value is Number || value is Boolean -> scalar(value)
        value is List<*> ->
            if (value.isEmpty()) "(no items)"
            else value.mapIndexed { i, v -> "${i + 1}. ${text(v)}" }.joinToString("\n")
        // Keys SORTED: the corpus pins this text on three renderers and a Swift dictionary
        // has no order, so sorting is the only ordering all three can produce identically.
        value is Map<*, *> ->
            if (value.isEmpty()) "(empty)"
            else value.entries.sortedBy { it.key.toString() }.joinToString("\n") { (k, v) -> "$k: ${scalarish(v)}" }
        else -> scalar(value)
    }

    /** One level of nesting is summarized rather than exploded - a fallback stays readable. */
    private fun scalarish(value: Any?): String = when {
        value == null || value === NSNull -> "null"
        value is List<*> -> "[${value.size} item${if (value.size == 1) "" else "s"}]"
        value is Map<*, *> -> JSON.from(value).toString()
        else -> scalar(value)
    }

    private fun scalar(value: Any?): String = when (value) {
        is Boolean -> if (value) "true" else "false"
        is Number -> {
            val d = value.toDouble()
            when {
                d.isNaN() -> "NaN"
                d == Double.POSITIVE_INFINITY -> "Infinity"
                d == Double.NEGATIVE_INFINITY -> "-Infinity"
                d == Math.floor(d) && Math.abs(d) < 1e21 -> d.toLong().toString()
                else -> d.toString()
            }
        }
        else -> value.toString()
    }
}
