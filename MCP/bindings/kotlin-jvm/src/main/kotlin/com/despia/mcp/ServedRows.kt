// Despia MCP - what the local server serves, DERIVED from declarations.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The local server's tool list is not written by hand. It comes from rows that
// name an action and a description, and the input schema is DERIVED from that
// action's already-declared argument vocabulary - the same derivation the
// in-app tool registry uses for module tools. One grammar, two protocols.
//
// That is the point of the whole design: a served tool cannot drift from the
// contract it describes, because there is no second place to state the shape.
//
// In a Despia app the rows are the `facets.mcp` declarations of every enabled
// module, fanned in at build time. This file takes them as data so the package
// is usable, and testable, without a build system.

package com.despia.mcp

/** One declared argument: its type, and whether the action requires it. */
public data class ArgSpec(val type: String, val required: Boolean = false)

/**
 * One `facets.mcp` row.
 *
 * [mutates] names what the action changes when it changes anything. A row that
 * declares it is approval-gated, no matter which protocol asked - the local
 * server is not a soft path into the user's data.
 */
public data class ServedRow(
    val action: String,
    val description: String,
    val args: Map<String, ArgSpec> = emptyMap(),
    val mutates: String? = null,
) {
    /** True when calling this tool needs an approval before it executes. */
    val requiresApproval: Boolean get() = !mutates.isNullOrEmpty()
}

/**
 * The derived MCP tool list.
 *
 * Shape note, deliberate: `inputSchema` is `{ "type": "object", "properties": …
 * }` and `required` is present only when at least one argument is required. An
 * empty `required: []` is legal JSON Schema and semantically identical, but the
 * corpus pins the terser form and matching it exactly is free.
 */
public object ServedCatalog {

    public fun deriveSchema(args: Map<String, ArgSpec>): Map<String, Any?> {
        val properties = LinkedHashMap<String, Any?>()
        val required = ArrayList<String>()
        for ((name, spec) in args) {
            properties[name] = mapOf("type" to spec.type)
            if (spec.required) required += name
        }
        val schema = LinkedHashMap<String, Any?>()
        schema["type"] = "object"
        schema["properties"] = properties
        if (required.isNotEmpty()) schema["required"] = required
        return schema
    }

    /**
     * The `tools/list` payload: one entry per row, in declaration order.
     *
     * `mutates` rides along so a caller that is not the model - a settings
     * screen listing what this app exposes, say - can see which tools write
     * without inferring it from a description.
     */
    public fun toolList(rows: List<ServedRow>): List<Map<String, Any?>> = rows.map { row ->
        val entry = LinkedHashMap<String, Any?>()
        entry["name"] = row.action
        entry["description"] = row.description
        entry["inputSchema"] = deriveSchema(row.args)
        if (!row.mutates.isNullOrEmpty()) entry["mutates"] = row.mutates
        entry
    }

    public fun find(rows: List<ServedRow>, name: String): ServedRow? = rows.firstOrNull { it.action == name }
}
