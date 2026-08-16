package despia.engine.desktop

import despia.engine.Platform
import despia.engine.StackNode
import java.io.PrintStream
import java.nio.file.Path
import kotlin.system.exitProcess

/** Static admission contract for the QA document. The fixture deliberately stays within
 * the renderer intersection shipped by both Windows and Linux. */
internal object DesktopDemoContract {
    const val SCHEMA = "dev.dsx.desktop-demo/v1"

    private val supportedTags = setOf(
        "stack", "head", "variable", "action", "scroll", "vstack", "text",
        "textfield", "toggle", "slider", "progress", "segmented", "button",
        "divider", "spacer",
    )
    private val requiredIds = mapOf(
        "qa-root" to "stack",
        "qa-breakpoint" to "vstack",
        "qa-responsive-layout" to "stack",
        "qa-name" to "textfield",
        "qa-toggle" to "toggle",
        "qa-slider" to "slider",
        "qa-segment" to "segmented",
        "qa-hover" to "vstack",
        "qa-action" to "button",
        "qa-scroll-tail" to "text",
    )

    fun validate(document: DesktopHost.Document): StackNode {
        val root = requireNotNull(DesktopHost.parseDocument(document)) {
            "Desktop QA entry is malformed or exceeds the DSX admission limits"
        }
        val ids = LinkedHashMap<String, String>()
        var nodes = 0
        val pending = java.util.ArrayDeque<StackNode>()
        pending.addLast(root)
        while (pending.isNotEmpty()) {
            val node = pending.removeLast()
            nodes += 1
            require(node.tag in supportedTags) {
                "Desktop QA entry uses a tag outside the Windows/Linux native intersection: ${node.tag}"
            }
            node.attrs["id"]?.takeIf(String::isNotBlank)?.let { id ->
                require(ids.put(id, node.tag) == null) { "Desktop QA entry contains duplicate id: $id" }
            }
            for (index in node.children.indices.reversed()) pending.addLast(node.children[index])
        }
        requiredIds.forEach { (id, tag) ->
            require(ids[id] == tag) { "Desktop QA entry is missing $tag#$id" }
        }
        require(nodes >= 40) { "Desktop QA entry no longer exercises a representative native surface" }
        return root
    }
}

internal object DesktopDemoHost {
    fun selfTest(
        entry: Path,
        osName: String = System.getProperty("os.name").orEmpty(),
        out: PrintStream = System.out,
    ): Int = try {
        val os = DesktopHost.boot(osName)
        val document = DesktopHost.loadEntry(entry)
        DesktopDemoContract.validate(document)
        out.println(
            "DSX_DESKTOP_DEMO_SELF_TEST {\"schema\":\"${DesktopDemoContract.SCHEMA}\"," +
                "\"status\":\"ok\",\"os\":\"$os\",\"native\":true,\"renderer\":\"compose\"}",
        )
        0
    } catch (failure: Throwable) {
        val code = failure.message?.replace(Regex("[^A-Za-z0-9_.-]"), "_")?.take(96)
            ?: failure.javaClass.simpleName
        out.println(
            "DSX_DESKTOP_DEMO_SELF_TEST {\"schema\":\"${DesktopDemoContract.SCHEMA}\"," +
                "\"status\":\"error\",\"code\":\"$code\"}",
        )
        1
    }

    fun launch(entry: Path) {
        val options = DesktopHost.Options(
            entry = entry,
            title = "DSX Desktop QA",
            appId = "dev.dsx.desktop.qa",
        )
        DesktopHost.configureAppContext(options)
        DesktopHost.boot()
        val document = DesktopHost.loadEntry(entry)
        DesktopDemoContract.validate(document)
        DesktopApplication.launch(options.title, document)
    }
}

/** QA-only entry point used by Gradle tasks. Shipping packages continue to use DesktopHostKt. */
fun main(args: Array<String>) {
    if (args.size != 2 || args[0] !in setOf("--validate", "--run")) {
        System.err.println("Usage: DesktopDemoHostKt (--validate|--run) <DesktopDemo.dsx>")
        exitProcess(64)
    }
    val entry = runCatching { Path.of(args[1]) }.getOrElse {
        System.err.println("Invalid DesktopDemo.dsx path")
        exitProcess(64)
    }
    when (args[0]) {
        "--validate" -> exitProcess(DesktopDemoHost.selfTest(entry))
        else -> try {
            DesktopDemoHost.launch(entry)
        } catch (failure: Throwable) {
            System.err.println("DSX desktop QA launch failed: ${failure.message ?: failure.javaClass.simpleName}")
            Platform.os = "android"
            exitProcess(70)
        }
    }
}
