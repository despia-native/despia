package despia.engine.desktop

import despia.engine.DSXSource
import despia.engine.DSXSourceStampStore
import java.time.Instant
import java.util.prefs.Preferences

/** Durable, app-isolated provenance stamps for Windows/Linux/macOS JVM hosts. */
internal class DesktopSourceStampStore(
    private val preferences: Preferences,
) : DSXSourceStampStore {
    private val lock = Any()

    override fun read(key: String): String? = synchronized(lock) {
        if (!key.matches(Regex("v1\\.[0-9a-f]{64}"))) return@synchronized null
        runCatching { preferences.get(key, null) }
            .getOrNull()
            ?.takeIf { value ->
                value.length <= 64 && runCatching { Instant.parse(value) }.isSuccess
            }
    }

    override fun write(key: String, value: String) {
        if (!key.matches(Regex("v1\\.[0-9a-f]{64}")) || value.length > 64) return
        if (runCatching { Instant.parse(value) }.isFailure) return
        synchronized(lock) {
            runCatching {
                // DSXSource calls write only after read returned no valid stamp.
                // Replace a truncated/corrupt pre-existing value so one damaged
                // preference cannot pin this install to `never` forever.
                preferences.put(key, value)
                preferences.flush()
            }
        }
    }
}

internal fun installDesktopSourceStampStore() {
    // No app id means no durable namespace. Reset to the kernel's process-local
    // store rather than sharing provenance across unrelated developer launches.
    // A locked-down/headless host may deny java.util.prefs entirely; provenance
    // persistence is useful state, never a reason to prevent the app from booting.
    val durable = runCatching {
        DesktopAppIdentity.preferenceNode("source")?.let(::DesktopSourceStampStore)
    }.getOrNull()
    DSXSource.installStampStore(durable)
}
