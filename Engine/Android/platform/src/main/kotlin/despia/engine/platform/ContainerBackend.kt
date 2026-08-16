//
//  ContainerBackend.kt — :platform
//
//  The durable Android half of `dsx.container` — installs the :core Container seams
//  (Context.kt: `Container.backend` / `Container.filesRoot` / `Container.bundleIdentifier`)
//  with real Android services. Twin of iOS's `UserDefaults(suiteName: Container.groupID)`
//  (Context.swift's Container struct): :core owns ALL container semantics (subcontainer
//  scoping, coercions, the foreign-write guard, change signals); this file is ONLY the
//  storage engine behind the KV seam, plus the file-root and bundle-id seeds.
//
//  ── WHERE DATA LIVES (pinned) ──
//  • KV — ONE SharedPreferences file named `Container.groupID`
//    ("group.<applicationId>.container", MODE_PRIVATE — the reserved App Group name,
//    byte-identical to the iOS suite name). Keys arrive PRE-SCOPED by :core
//    ("<scheme>.<key>"; root writes unprefixed), so this backend never namespaces and the
//    key strings in the prefs file are the same strings iOS puts in the suite plist.
//    The Widgets module's process-surviving store (WidgetImageManager.kt) already targets
//    THIS file by name — with this backend installed the two collapse by construction
//    (same file, same keys), exactly as that header pinned.
//  • FILES — `filesDir/<groupID>/` seeds `Container.filesRoot`, so `dsx.container.url()`
//    hands each package a durable per-scheme folder and `isAvailable` reports true (the
//    iOS "group provisioned" signal; DevSettings' Persistence row reads it honestly).
//
//  ── VALUE ENCODING (the UserDefaults-plist set over the prefs type system) ──
//  String / Boolean / Int / Long / Float store NATIVELY in their typed prefs slots —
//  `getAll()` hands them back typed, so :core's read coercions behave exactly as over the
//  in-memory default (and Widgets' direct putInt/putString writes read back through the
//  seam unchanged). Types SharedPreferences lacks ride a TAGGED STRING (prefix "dsx§",
//  XML-safe — prefs files are XML, so no control-char sentinels):
//    Double         → "dsx§d:<toString>"   (exact round-trip; putFloat would lose bits)
//    ByteArray      → "dsx§b:<Base64>"     (the UserDefaults `data` twin; Okio's
//                                           platform-neutral codec is API-24-safe)
//    java.util.Date → "dsx§t:<epochMillis>"
//    Map / List     → "dsx§j:<JSON>"       (kernel JSON. ONE pinned divergence: JSON
//                                           normalization collapses whole doubles inside
//                                           nested values to ints; iOS's plist keeps them
//                                           doubles. Every current consumer stores strings/
//                                           bools/string-keyed maps — unaffected.)
//    a plain String that itself starts with "dsx§" escapes as "dsx§s:<value>"
//  A non-encodable type is DROPPED with a kernel log — iOS UserDefaults throws
//  NSInvalidArgumentException there; graceful degradation is this port's documented stance.
//
//  ── MAIN-SAFETY ──
//  Writes are `editor.apply()`: synchronous in-memory commit (a same-frame read sees the
//  write), asynchronous disk flush (the framework drains pending applies at lifecycle
//  stops). Reads come off the prefs in-memory map; the initial disk load kicks off at
//  install() (boot, before modules run), so first reads don't stall the critical path.
//
//  ── MIGRATION (pinned) ──
//  None needed, none performed: before this backend the Android container was the
//  documented in-memory default (per-process), so there is nothing durable to migrate.
//  The file name is FOREVER-stable (`Container.groupID`); renaming it later means
//  writing a real migration.
//
//  ── WHAT STAYS PER-PROCESS (pinned) ──
//  `ContainerObservers.transport` keeps its :core in-process default: this app has no
//  app/extension process split (widget receivers and Glance run in the app process), so
//  the Darwin cross-process ping's LOCAL loop-back half is the whole behavior. A future
//  multi-process build installs a real transport; the seam is already there.
//

package despia.engine.platform

import android.content.Context
import android.content.SharedPreferences
import despia.engine.Container
import despia.engine.ContainerKV
import despia.engine.JSON
import despia.engine.json
import despia.engine.kernelLog
import java.io.File
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString

/// The boot installer — ONE line in the bootloader's documented boot-bindings block
/// (DespiaApp.onCreate, before modules register/boot) binds every Container seam.
object ContainerBackend {

    /// Bind `dsx.container` to its durable Android home. Idempotent; call once at boot.
    fun install(context: Context) {
        val app = context.applicationContext
        // Bundle.main.bundleIdentifier twin — "host-seeded" per the seam doc (Context.kt);
        // LicenseCheck/Widgets read it, WidgetImageManager's lazy seed becomes a no-op.
        Container.bundleIdentifier = app.packageName
        Container.backend = SharedPreferencesContainerKV(
            app.getSharedPreferences(Container.groupID, Context.MODE_PRIVATE))
        // The shared FILE half (Swift: FileManager.containerURL(for: group)) — a durable
        // root under filesDir named after the same reserved group id. Created on demand;
        // an unlikely mkdirs failure reads as "not provisioned" (isAvailable false), the
        // documented graceful degradation.
        val root = File(app.filesDir, Container.groupID)
        Container.filesRoot = { if (root.isDirectory || root.mkdirs()) root else null }
    }
}

/// `ContainerKV` over ONE SharedPreferences file (see the header for the pinned design).
/// Public so the unit rig can drive it with a fake SharedPreferences (pure interface).
class SharedPreferencesContainerKV(private val prefs: SharedPreferences) : ContainerKV {

    override fun get(key: String): Any? = decode(prefs.all[key])

    override fun set(key: String, value: Any) {
        val editor = prefs.edit()
        when (value) {
            is String -> editor.putString(key, if (value.startsWith(PREFIX)) "${PREFIX}s:$value" else value)
            is Boolean -> editor.putBoolean(key, value)
            is Int -> editor.putInt(key, value)
            is Long -> editor.putLong(key, value)
            is Float -> editor.putFloat(key, value)
            is Short, is Byte -> editor.putInt(key, (value as Number).toInt())
            is Double -> editor.putString(key, "${PREFIX}d:$value")
            is ByteArray -> editor.putString(
                key, "${PREFIX}b:" + value.toByteString().base64())
            is java.util.Date -> editor.putString(key, "${PREFIX}t:${value.time}")
            is Map<*, *>, is List<*> -> editor.putString(key, "${PREFIX}j:" + JSON.from(value))
            else -> {
                // iOS UserDefaults would throw NSInvalidArgumentException; we log + drop.
                kernelLog("[container] dropped '$key': ${value::class.java.name} is not a " +
                          "container value (String/Bool/Int/Long/Float/Double/ByteArray/Date/Map/List).")
                return
            }
        }
        editor.apply()
    }

    override fun remove(key: String) { prefs.edit().remove(key).apply() }

    /// Natively-typed slots pass through untouched; a tagged string decodes back to the
    /// type it encoded. Unknown/garbage tags fail OPEN (the raw string / null) — corrupt
    /// data must never crash a read.
    private fun decode(stored: Any?): Any? {
        if (stored !is String || !stored.startsWith(PREFIX)) return stored
        // Shape: "<PREFIX><tag>:<body>" — anything else was written by someone else; hand it back.
        if (stored.length < PREFIX.length + 2 || stored[PREFIX.length + 1] != ':') return stored
        val body = stored.substring(PREFIX.length + 2)
        return when (stored[PREFIX.length]) {
            's' -> body
            'd' -> body.toDoubleOrNull()
            'b' -> body.decodeBase64()?.toByteArray()
            't' -> body.toLongOrNull()?.let { java.util.Date(it) }
            'j' -> json(body).foundationValue
            else -> stored
        }
    }

    private companion object {
        /// The tagged-encoding sentinel. "§" (U+00A7) is XML-legal (prefs files are XML;
        /// control chars are not), and a REAL string starting with it escapes via the
        /// "s" tag above — so the encoding is collision-free by construction.
        const val PREFIX = "dsx§"
    }
}
