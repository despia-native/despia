package despia.engine

import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The WebMCP conformance runner — executes OpenSource/Conformance/webmcp/
 * {project,registry}.json through THIS runtime's WebMcp fold. The TS kernel
 * (webmcp-conformance.test.ts) and the Swift twin (WebMcpConformance) run the SAME two
 * files: the `<tool>` row is an authoring surface, so the unified-codebase law applies to
 * it in full, and the page table's law must be identical wherever a shell implements it.
 *
 * Missing corpus = loud failure, never a silent zero-case pass.
 */
class WebMcpConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/webmcp/$name")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/webmcp/$name not found")
        }
    }

    private fun cases(name: String): List<Map<String, Any?>> {
        val doc = json(corpusFile(name).readText()).foundationValue as? Map<*, *>
            ?: error("$name: not a JSON object")
        @Suppress("UNCHECKED_CAST")
        val cases = doc["cases"] as? List<Map<String, Any?>> ?: error("$name: no cases[]")
        assertTrue(cases.isNotEmpty(), "$name is empty")
        return cases
    }

    /** Corpus JSON carries absent as NSNull; comparisons happen against real nulls. */
    private fun plain(v: Any?): Any? = when {
        v === NSNull -> null
        v is Map<*, *> -> v.entries.associate { (k, value) -> (k as String) to plain(value) }
        v is List<*> -> v.map { plain(it) }
        v is Int -> v.toDouble()
        v is Long -> v.toDouble()
        else -> v
    }

    @TestFactory
    fun projectCorpus(): List<DynamicTest> = cases("project.json").map { c ->
        DynamicTest.dynamicTest("webmcp-project/${c["name"]}") {
            @Suppress("UNCHECKED_CAST")
            val expect = plain(c["expect"]) as? Map<String, Any?> ?: emptyMap()

            // A RESULT case pins the MCP shaping a tool call answers with.
            @Suppress("UNCHECKED_CAST")
            val result = c["result"] as? Map<String, Any?>
            if (result != null) {
                val thrown = result["thrown"]
                val actual = if (thrown != null && thrown !== NSNull) {
                    WebMcpResult.error((plain(result["correlationId"]) as? String).orEmpty())
                } else {
                    WebMcpResult.value(plain(result["value"]))
                }
                assertEquals(plain(expect["result"]), plain(actual))
                return@dynamicTest
            }

            @Suppress("UNCHECKED_CAST")
            val actionsRaw = (plain(c["actions"]) as? Map<String, Any?>) ?: emptyMap()
            val actionInputs = LinkedHashMap<String, List<String>>()
            for ((name, decl) in actionsRaw) {
                @Suppress("UNCHECKED_CAST")
                val inputs = ((decl as? Map<String, Any?>)?.get("inputs") as? List<Any?>) ?: emptyList()
                actionInputs[name] = inputs.map { it as String }
            }

            @Suppress("UNCHECKED_CAST")
            val rows = ((plain(c["tools"]) as? List<Any?>) ?: emptyList()).map { raw ->
                val row = raw as Map<String, Any?>
                WebMcp.ToolRow(
                    action = row["action"] as? String ?: "",
                    description = row["description"] as? String ?: "",
                    asName = row["as"] as? String,
                    mutates = row["mutates"] as? String,
                )
            }

            val projection = WebMcp.project(rows, actionInputs)

            @Suppress("UNCHECKED_CAST")
            val expectError = plain(c["expectError"]) as? Map<String, Any?>
            if (expectError != null) {
                assertTrue(projection.errors.isNotEmpty(), "expected ${expectError["code"]}, got a clean projection")
                assertEquals(
                    List(projection.errors.size) { expectError["code"] },
                    projection.errors.map { it.code.wire },
                )
                assertEquals(expectError["names"], projection.errors.map { it.name })
                for (e in projection.errors) assertTrue(e.message.isNotEmpty(), "an error must carry a message")
                return@dynamicTest
            }

            assertEquals(emptyList(), projection.errors.map { it.message }, "unexpected projection errors")
            (expect["descriptorNames"] as? List<*>)?.let { names ->
                assertEquals(names, projection.descriptors.map { it.name })
            }
            (expect["descriptors"] as? List<*>)?.let { descriptors ->
                assertEquals(descriptors, projection.descriptors.map { plain(it.toMap()) })
            }
        }
    }

    @TestFactory
    fun registryCorpus(): List<DynamicTest> = cases("registry.json").map { c ->
        DynamicTest.dynamicTest("webmcp-registry/${c["name"]}") {
            val events = ArrayList<Map<String, Any?>>()
            val table = WebMcp.PageToolTable { surface ->
                events.add(linkedMapOf("event" to "toolchange", "surface" to surface))
            }
            val rejections = ArrayList<Map<String, Any?>>()

            @Suppress("UNCHECKED_CAST")
            val steps = (plain(c["steps"]) as? List<Any?>) ?: emptyList()
            for (raw in steps) {
                @Suppress("UNCHECKED_CAST")
                val step = raw as Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val register = step["register"] as? Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val commit = step["commit"] as? Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val abort = step["abort"] as? Map<String, Any?>
                when {
                    register != null -> {
                        @Suppress("UNCHECKED_CAST")
                        val tool = register["tool"] as Map<String, Any?>
                        @Suppress("UNCHECKED_CAST")
                        val rejected = table.register(
                            surface = register["surface"] as String,
                            origin = register["origin"] as String,
                            name = tool["name"] as? String ?: "",
                            description = tool["description"] as? String ?: "",
                            inputSchema = tool["inputSchema"] as? Map<String, Any?>,
                            annotations = tool["annotations"] as? Map<String, Any?>,
                        )
                        if (rejected != null) {
                            rejections.add(linkedMapOf("reason" to rejected.reason.wire, "name" to rejected.name))
                        }
                    }
                    commit != null -> table.commit(commit["surface"] as String)
                    abort != null -> table.abort(abort["surface"] as String, abort["name"] as String)
                    else -> error("unknown step: $step")
                }
            }

            @Suppress("UNCHECKED_CAST")
            val expect = plain(c["expect"]) as? Map<String, Any?> ?: emptyMap()
            (expect["tools"] as? List<*>)?.let { tools ->
                assertEquals(tools, table.tools().map { wire(it) })
            }
            (expect["toolNames"] as? List<*>)?.let { names ->
                assertEquals(names, table.tools().map { it.name })
            }
            (expect["rejections"] as? List<*>)?.let { expected -> assertEquals(expected, rejections) }
            (expect["events"] as? List<*>)?.let { expected -> assertEquals(expected, events) }
        }
    }

    /** The recorded row as the corpus writes it — provenance, the verbatim schema, approval. */
    private fun wire(tool: WebMcp.PageTool): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["surface"] = tool.surface
        out["origin"] = tool.origin
        out["name"] = tool.name
        out["description"] = tool.description
        out["inputSchema"] = plain(tool.inputSchema)
        if (tool.annotations != null) out["annotations"] = plain(tool.annotations)
        out["approval"] = tool.approval
        return out
    }
}
