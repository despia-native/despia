package despia.engine

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertContentEquals

/// THE CONTAINER SEAM CONTRACT — what ANY `ContainerKV` backend (the :platform
/// SharedPreferences engine, a test fake) receives from `dsx.container` and what it must
/// hand back for the :core coercions to behave like iOS's UserDefaults suite. A recording
/// fake pins both directions: key SHAPES (pre-scoped "<scheme>.<key>", root unprefixed,
/// sanitized names) and VALUE flow (raw pass-through on write, typed coercion on read).
/// The behavioral half (foreign guard, batch signals) rides ContextTest; this suite is
/// the wire contract the :platform backend implements against.
class ContainerSeamTest {

    private class RecordingKV : ContainerKV {
        val map = HashMap<String, Any>()
        val sets = ArrayList<Pair<String, Any>>()
        val removes = ArrayList<String>()
        override fun get(key: String): Any? = map[key]
        override fun set(key: String, value: Any) { sets.add(key to value); map[key] = value }
        override fun remove(key: String) { removes.add(key); map.remove(key) }
    }

    private class SeamMod : Module() { override val scheme get() = "cs.seam" }

    private var savedBackend: ContainerKV? = null
    private val kv = RecordingKV()

    @BeforeTest fun swapIn() { savedBackend = Container.backend; Container.backend = kv }
    @AfterTest fun swapOut() { Container.backend = savedBackend }

    // -- key shapes (the write side of the contract) --

    @Test fun writesArriveSchemeScopedWithRawValues() {
        val own = SeamMod().dsx.container
        own.set("player_id", "p1")
        own.set("count", 42)
        assertEquals(listOf("cs.seam.player_id" to "p1" as Any, "cs.seam.count" to 42 as Any), kv.sets)
        // null removes — the backend sees remove(scopedKey), never set(key, null).
        own.set("player_id", null)
        assertEquals(listOf("cs.seam.player_id"), kv.removes)
    }

    @Test fun rootContainerWritesUnprefixedKeys() {
        // The base Module has scheme "" — its container addresses the shared root.
        Module().dsx.container.set("k", 1)
        assertEquals(listOf("k" to 1 as Any), kv.sets)
    }

    @Test fun subcontainerNamesAreSanitizedInKeys() {
        // Letters/digits/._- survive; everything else drops (Context.kt sanitize).
        kv.map["weird-na.me_2.k"] = "v"
        assertEquals("v", Module().dsx.container["we!ird-na.me_2 "].string("k"))
    }

    @Test fun foreignWritesNeverReachTheBackend() {
        val foreign = Module().dsx.container["cs.seam"]
        foreign.set("k", "hacked")
        foreign.remove("k")
        assertTrue(kv.sets.isEmpty())
        assertTrue(kv.removes.isEmpty())
        // ...but foreign READS resolve against the named folder's keys.
        kv.map["cs.seam.k"] = "own"
        assertEquals("own", foreign.string("k"))
    }

    @Test fun batchWritesAllReachTheBackendScoped() {
        SeamMod().dsx.container.batch { it.set("a", 1); it.set("b", 2) }
        assertEquals(listOf("cs.seam.a" to 1 as Any, "cs.seam.b" to 2 as Any), kv.sets)
    }

    // -- read coercions (the read side: typed backend values → UserDefaults semantics) --

    @Test fun readsCoerceBackendValuesLikeUserDefaults() {
        val own = SeamMod().dsx.container
        // A backend may hand back platform-typed numbers (SharedPreferences: Int/Long/Float).
        kv.map["cs.seam.l"] = 7L
        assertEquals(7, own.int("l"))
        assertEquals(7.0, own.double("l"))
        assertEquals("7", own.string("l"))     // UserDefaults.string coerces numbers
        assertTrue(own.bool("l"))              // non-zero number reads true
        // Numeric strings coerce to numbers, truthy strings to bool.
        kv.map["cs.seam.s"] = "5"
        assertEquals(5, own.int("s"))
        assertEquals(5.0, own.double("s"))
        for (truthy in listOf("true", "TRUE", "yes", "1")) {
            kv.map["cs.seam.t"] = truthy
            assertTrue(own.bool("t"), "expected bool(\"$truthy\") == true")
        }
        kv.map["cs.seam.t"] = "0"
        assertFalse(own.bool("t"))
        // Booleans read as numbers — and STRING-read as "1"/"0": iOS stores Bool as
        // NSNumber, so UserDefaults.string(forKey:) coerces it (the dsx.list boolean pin's
        // twin; Kotlin's Boolean isn't a Number, so Container.string carries its own arm).
        kv.map["cs.seam.b"] = true
        assertEquals(1, own.int("b"))
        assertEquals(1.0, own.double("b"))
        assertEquals("1", own.string("b"))
        kv.map["cs.seam.b"] = false
        assertEquals("0", own.string("b"))
        // Data + raw value pass through untouched.
        val bytes = byteArrayOf(1, 2, 3)
        kv.map["cs.seam.d"] = bytes
        assertContentEquals(bytes, own.data("d"))
        kv.map["cs.seam.raw"] = mapOf("x" to 1)
        assertEquals(mapOf("x" to 1), own.value("raw"))
        // Missing keys read the UserDefaults defaults.
        assertNull(own.string("missing"))
        assertFalse(own.bool("missing"))
        assertEquals(0, own.int("missing"))
        assertEquals(0.0, own.double("missing"))
        assertNull(own.data("missing"))
        assertNull(own.value("missing"))
    }

    // -- the unprovisioned mode (backend == null — Swift's nil suite) --

    @Test fun nullBackendReadsDefaultsAndDropsWrites() {
        Container.backend = null
        val own = SeamMod().dsx.container
        own.set("k", "v")                      // dropped, never throws
        own.remove("k")
        assertNull(own.string("k"))
        assertFalse(own.bool("k"))
        assertEquals(0, own.int("k"))
        assertEquals(0.0, own.double("k"))
        assertNull(own.value("k"))
    }
}
