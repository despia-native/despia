package despia.engine.desktop

import despia.engine.DSX
import despia.engine.DSXSource
import despia.engine.setPath
import java.util.UUID
import java.util.prefs.Preferences
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DesktopSourceTest {
    private var node: Preferences? = null

    @AfterEach
    fun restoreSourceStore() {
        DSXSource.installStampStore(null)
        DSX.state.setPath("source.view", null)
        node?.let { runCatching { it.removeNode() } }
        node = null
    }

    @Test
    fun desktopStampSurvivesAdapterReinstallWithoutPersistingTheOrigin() {
        val preferences = Preferences.userRoot().node(
            "/dev/dsx/tests/source/${UUID.randomUUID()}",
        ).also { node = it }
        val origin = "private-user-token.example.test"
        DSXSource.installStampStore(DesktopSourceStampStore(preferences))
        DSXSource.publish(
            "view",
            DSXSource.servingOrigin,
            fresh = true,
            key = origin,
        )
        assertEquals("live", DSXSource.state("view"))

        DSXSource.installStampStore(DesktopSourceStampStore(preferences))
        DSXSource.track("view", origin)
        assertEquals("stale", DSXSource.state("view"))

        val keys = preferences.keys().toList()
        assertEquals(1, keys.size)
        assertTrue(keys.single().matches(Regex("v1\\.[0-9a-f]{64}")))
        assertFalse(keys.single().contains(origin))
    }

    @Test
    fun malformedDurableStampIsIgnoredAndRepairedByTheNextFreshServe() {
        val preferences = Preferences.userRoot().node(
            "/dev/dsx/tests/source/${UUID.randomUUID()}",
        ).also { node = it }
        DSXSource.installStampStore(DesktopSourceStampStore(preferences))
        DSXSource.publish(
            "view",
            DSXSource.servingOrigin,
            fresh = true,
            key = "repair.example.test",
        )
        val key = preferences.keys().single()
        preferences.put(key, "truncated-not-an-instant")
        preferences.flush()

        DSXSource.installStampStore(DesktopSourceStampStore(preferences))
        DSXSource.track("view", "repair.example.test")
        assertEquals("never", DSXSource.state("view"))
        DSXSource.publish(
            "view",
            DSXSource.servingOrigin,
            fresh = true,
            key = "repair.example.test",
        )

        DSXSource.installStampStore(DesktopSourceStampStore(preferences))
        DSXSource.track("view", "repair.example.test")
        assertEquals("stale", DSXSource.state("view"))
        assertTrue(runCatching { java.time.Instant.parse(preferences.get(key, "")) }.isSuccess)
    }
}
