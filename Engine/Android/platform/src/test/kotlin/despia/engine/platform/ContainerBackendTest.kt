//
//  ContainerBackendTest.kt — plain-JVM units for the SharedPreferences container engine.
//  SharedPreferences is a pure interface, so the rig drives the real encode/decode with a
//  fake in-memory implementation (no Robolectric): typed native slots, the tagged-string
//  encodings, apply()-not-commit(), and the end-to-end collapse contract through the
//  :core Container (scoped "<scheme>.<key>" keys landing as plain prefs keys).
//

package despia.engine.platform

import android.content.SharedPreferences
import despia.engine.Container
import despia.engine.ContainerKV
import despia.engine.Module
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ContainerBackendTest {

    /// In-memory SharedPreferences twin: typed slots, editor batching, apply/commit counters.
    private class FakePrefs : SharedPreferences {
        val store = LinkedHashMap<String, Any?>()
        var applies = 0
        var commits = 0

        override fun getAll(): MutableMap<String, *> = LinkedHashMap(store)
        override fun getString(key: String?, defValue: String?): String? = store[key] as? String ?: defValue
        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            store[key] as? MutableSet<String> ?: defValues
        override fun getInt(key: String?, defValue: Int): Int = store[key] as? Int ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = store[key] as? Long ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = store[key] as? Float ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = store[key] as? Boolean ?: defValue
        override fun contains(key: String?): Boolean = store.containsKey(key)
        override fun edit(): SharedPreferences.Editor = FakeEditor()
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}

        private object Tombstone

        inner class FakeEditor : SharedPreferences.Editor {
            private val pending = LinkedHashMap<String, Any?>()
            private var cleared = false
            override fun putString(key: String?, value: String?) = also { pending[key!!] = value }
            override fun putStringSet(key: String?, values: MutableSet<String>?) = also { pending[key!!] = values }
            override fun putInt(key: String?, value: Int) = also { pending[key!!] = value }
            override fun putLong(key: String?, value: Long) = also { pending[key!!] = value }
            override fun putFloat(key: String?, value: Float) = also { pending[key!!] = value }
            override fun putBoolean(key: String?, value: Boolean) = also { pending[key!!] = value }
            override fun remove(key: String?) = also { pending[key!!] = Tombstone }
            override fun clear() = also { cleared = true }
            override fun commit(): Boolean { commits += 1; flush(); return true }
            override fun apply() { applies += 1; flush() }
            private fun flush() {
                if (cleared) store.clear()
                for ((k, v) in pending) if (v === Tombstone) store.remove(k) else store[k] = v
            }
        }
    }

    private val prefs = FakePrefs()
    private val kv: ContainerKV = SharedPreferencesContainerKV(prefs)

    // The end-to-end test swaps the :core statics — save/restore around every test.
    private var savedBackend: ContainerKV? = null
    private var savedBundleId: String = ""

    @Before fun save() { savedBackend = Container.backend; savedBundleId = Container.bundleIdentifier }
    @After fun restore() { Container.backend = savedBackend; Container.bundleIdentifier = savedBundleId }

    // -- native typed slots (getAll hands them back typed, like the in-memory default) --

    @Test fun nativeTypesStoreInTypedSlots() {
        kv.set("s", "hello"); kv.set("f", true); kv.set("i", 42); kv.set("l", 42L); kv.set("fl", 1.5f)
        assertEquals("hello", prefs.store["s"])       // raw string, no tagging
        assertEquals(true, prefs.store["f"])
        assertEquals(42, prefs.store["i"])
        assertEquals(42L, prefs.store["l"])
        assertEquals(1.5f, prefs.store["fl"])
        assertEquals("hello", kv.get("s"))
        assertEquals(true, kv.get("f"))
        assertEquals(42, kv.get("i"))
        assertEquals(42L, kv.get("l"))
        assertEquals(1.5f, kv.get("fl"))
        assertNull(kv.get("missing"))
    }

    // -- tagged encodings (types SharedPreferences lacks) --

    @Test fun doubleRoundTripsExactly() {
        for (d in listOf(0.1, -2.5e-300, Double.MAX_VALUE, 1234567890.123456)) {
            kv.set("d", d)
            assertTrue("double must ride a tagged STRING (XML-safe)", prefs.store["d"] is String)
            assertEquals(d as Any, kv.get("d"))
        }
    }

    @Test fun byteArrayRoundTrips() {
        val bytes = byteArrayOf(0, 1, 2, -1, 127, -128)
        kv.set("b", bytes)
        assertTrue(prefs.store["b"] is String)
        assertArrayEquals(bytes, kv.get("b") as ByteArray)
    }

    @Test fun dateRoundTrips() {
        val date = java.util.Date(1720569600123L)
        kv.set("t", date)
        assertEquals(date, kv.get("t"))
    }

    @Test fun mapAndListRoundTripViaJson() {
        kv.set("m", mapOf("url" to "https://x", "on" to true, "n" to 3))
        assertEquals(mapOf("url" to "https://x", "on" to true, "n" to 3), kv.get("m"))
        kv.set("a", listOf(mapOf("id" to "a"), mapOf("id" to "b")))
        assertEquals(listOf(mapOf("id" to "a"), mapOf("id" to "b")), kv.get("a"))
    }

    @Test fun sentinelPrefixedPlainStringEscapes() {
        // A REAL string that happens to start with the sentinel must come back verbatim.
        for (s in listOf("dsx§d:1.5", "dsx§", "dsx§j:{}", "dsx§s:nested")) {
            kv.set("s", s)
            assertEquals(s, kv.get("s"))
        }
    }

    @Test fun unsupportedTypeIsDroppedNotCrashed() {
        kv.set("x", Any())
        assertFalse(prefs.store.containsKey("x"))
        assertNull(kv.get("x"))
    }

    @Test fun removeRemoves() {
        kv.set("k", "v")
        kv.remove("k")
        assertFalse(prefs.store.containsKey("k"))
        assertNull(kv.get("k"))
    }

    @Test fun writesUseApplyNeverCommit() {
        kv.set("k", "v"); kv.set("d", 0.5); kv.remove("k")
        assertEquals(3, prefs.applies)
        assertEquals(0, prefs.commits)
    }

    // -- the collapse contract: :core Container over this backend --

    private class StoreMod : Module() { override val scheme get() = "pt.store" }

    @Test fun containerScopedKeysLandAsPlainPrefsKeys() {
        Container.backend = kv
        val own = StoreMod().dsx.container
        own.set("origin", "https://staging.example")
        own.set("isFromPush", true)
        // "<scheme>.<key>" — the same key shape iOS puts in the suite plist, flat in the file.
        assertEquals("https://staging.example", prefs.store["pt.store.origin"])
        assertEquals(true, prefs.store["pt.store.isFromPush"])
        assertEquals("https://staging.example", own.string("origin"))
        assertTrue(own.bool("isFromPush"))
        // A direct prefs writer (the WidgetImageManager pattern: putInt on the same file)
        // reads back through the seam's coercions untouched.
        prefs.store["pt.store.widgetRefreshInterval"] = 15
        assertEquals(15, own.int("widgetRefreshInterval"))
        assertEquals("15", own.string("widgetRefreshInterval"))
    }
}
