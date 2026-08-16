// Despia MCP - the namespaced tool registry.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// ONE law lives here and it is worth stating before any code: a tool discovered
// from server `s` is exposed as `mcp.<s>.<tool>`, and two servers offering the
// same tool name produce two distinct entries. Collision handling is not
// last-writer-wins and it is not first-writer-wins - both of those silently
// change which server a model is talking to, which is a correctness bug that
// looks like a naming bug.
//
// The registry also carries two properties the loop depends on:
//
//   * A FOREIGN schema passes through VERBATIM. A module tool derives its
//     schema from a declared args block; an MCP tool already has a JSON Schema
//     and re-deriving it could only lose information.
//   * A description is UNTRUSTED input. It rides to the model as data, tagged
//     with the server it came from, and it changes no policy - which is why
//     provenance is a field here and not a comment.
//
// Degradation is per-server: dropping one server's tools leaves every other
// server's registrations untouched. That is what makes "a server that is down
// removes only its own tools" true rather than aspirational.

package com.despia.mcp

/** The namespace prefix every discovered tool carries. */
public const val MCP_TOOL_NAMESPACE: String = "mcp"

/**
 * One model-facing tool definition.
 *
 * [parameters] is the tool's JSON Schema as the source gave it: for an MCP tool
 * that is the server's own `inputSchema`, unmodified.
 */
public data class ToolDefinition(
    val name: String,
    val description: String?,
    val parameters: Map<String, Any?>,
    val source: String,
    val server: String? = null,
) {
    /** Where the description came from, so untrusted text stays labelled. */
    val provenance: String
        get() = when (source) {
            "mcp" -> "$MCP_TOOL_NAMESPACE:${server ?: "unknown"}"
            else -> source
        }
}

/** A tool as a server advertised it, before namespacing. */
public data class DiscoveredTool(
    val name: String,
    val description: String?,
    val inputSchema: Map<String, Any?>,
)

/**
 * The one registry discovered tools join.
 *
 * Registration order is insertion order, because a model sees the list and a
 * list that reshuffles between runs makes a completion non-reproducible for no
 * reason.
 */
public class ToolRegistry {

    private val entries = LinkedHashMap<String, ToolDefinition>()
    private val byServer = LinkedHashMap<String, MutableSet<String>>()

    /** `mcp.<server>.<tool>` - the only place this string is built. */
    public fun namespaced(server: String, tool: String): String = "$MCP_TOOL_NAMESPACE.$server.$tool"

    /**
     * Registers everything [server] advertised, replacing whatever that server
     * had registered before. Returns the namespaced names, in order.
     *
     * Re-registering a server is a full replace rather than a merge: a server
     * that dropped a tool between two connects must not leave a ghost behind.
     */
    public fun register(server: String, tools: List<DiscoveredTool>): List<String> {
        remove(server)
        val names = ArrayList<String>(tools.size)
        val owned = LinkedHashSet<String>()
        for (tool in tools) {
            val key = namespaced(server, tool.name)
            entries[key] = ToolDefinition(
                name = key,
                description = tool.description,
                parameters = tool.inputSchema,
                source = "mcp",
                server = server,
            )
            owned += key
            names += key
        }
        if (owned.isNotEmpty()) byServer[server] = owned
        return names
    }

    /**
     * Drops one server's tools. Everything else stays exactly as it was - this
     * is the whole of "degradation is per-server".
     */
    public fun remove(server: String) {
        val owned = byServer.remove(server) ?: return
        for (key in owned) entries.remove(key)
    }

    public fun definitions(): List<ToolDefinition> = entries.values.toList()

    public fun definition(name: String): ToolDefinition? = entries[name]

    public fun names(): List<String> = entries.keys.toList()

    public fun serversWithTools(): List<String> = byServer.keys.toList()

    /**
     * Splits a namespaced name back into (server, tool), or null when the name
     * is not one of ours. Used on the dispatch path so a tool call can find the
     * connection that owns it without a second lookup table.
     */
    public fun split(name: String): Pair<String, String>? {
        val prefix = "$MCP_TOOL_NAMESPACE."
        if (!name.startsWith(prefix)) return null
        val rest = name.substring(prefix.length)
        val cut = rest.indexOf('.')
        if (cut <= 0 || cut == rest.length - 1) return null
        return rest.substring(0, cut) to rest.substring(cut + 1)
    }

    public fun clear() {
        entries.clear()
        byServer.clear()
    }
}
