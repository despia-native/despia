package despia.engine.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import despia.engine.DSX
import despia.engine.StackStore
import despia.engine.varsFlow
import java.util.concurrent.atomic.AtomicLong

/** Machine-readable evidence for `--dsx-ui-smoke`. Only the fixed, non-sensitive QA
 * fields are emitted; arbitrary application state is never logged. The native runner
 * can therefore prove that resize/keyboard/pointer input changed the DSX runtime, not
 * merely that a window process survived. */
internal object DesktopUiSmokeProbe {
    const val PREFIX = "DSX_DESKTOP_UI_STATE "
    private const val SCHEMA = "dev.dsx.desktop-ui-smoke/v1"
    private const val MAX_TEXT = 256
    private val sequence = AtomicLong()

    internal fun snapshot(
        local: Map<String, Any?>,
        screen: Map<String, Any?>,
        index: Long,
    ): String {
        val fields = linkedMapOf<String, Any?>(
            "schema" to SCHEMA,
            "sequence" to index,
            "name" to local["name"],
            "notifications" to local["notifications"],
            "volume" to local["volume"],
            "density" to local["density"],
            "count" to local["count"],
            "status" to local["status"],
            "hovered" to local["hovered"],
            "screen" to linkedMapOf(
                "width" to screen["width"],
                "height" to screen["height"],
                "sizeClass" to screen["sizeClass"],
                "orientation" to screen["orientation"],
                "breakpoint" to screen["breakpoint"],
            ),
        )
        return PREFIX + json(fields)
    }

    fun next(local: Map<String, Any?>, global: Map<String, Any?>): String {
        val screen = (global["screen"] as? Map<*, *>)
            ?.entries?.mapNotNull { (key, value) -> (key as? String)?.let { it to value } }
            ?.toMap().orEmpty()
        return snapshot(local, screen, sequence.incrementAndGet())
    }

    private fun json(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> value.toString()
        is Byte, is Short, is Int, is Long -> value.toString()
        is Float -> if (value.isFinite()) value.toString() else "null"
        is Double -> if (value.isFinite()) value.toString() else "null"
        is Number -> value.toString()
        is Map<*, *> -> value.entries.joinToString(prefix = "{", postfix = "}") { (key, item) ->
            json(key?.toString().orEmpty()) + ":" + json(item)
        }
        else -> jsonString(value.toString().take(MAX_TEXT))
    }

    private fun jsonString(value: String): String = buildString(value.length + 2) {
        append('"')
        for (char in value) {
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (char.code < 0x20 || char.isSurrogate()) {
                    append("\\u")
                    append(char.code.toString(16).padStart(4, '0'))
                } else {
                    append(char)
                }
            }
        }
        append('"')
    }
}

@Composable
internal fun DesktopUiSmokeStateProbe(store: StackStore) {
    val local = store.varsFlow.collectAsState().value
    val global = DSX.state.varsFlow.collectAsState().value
    LaunchedEffect(local, global) {
        println(DesktopUiSmokeProbe.next(local, global))
    }
}
