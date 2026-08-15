//
//  PlatformAttrs.kt - platform identity + the attribute-suffix fold (:core, pure JVM).
//  The law is the corpus: OpenSource/Conformance/platform/platform.json
//  (architecture/proposals/desktop-platforms.md; /web/14-platform-detection.md).
//
//  Identity is the DEPLOY TARGET: "android" on the Android renderer; the desktop
//  runtime (Windows/Linux — the Kotlin lane's Compose Desktop build) boots
//  Platform.os to its concrete target at startup. macOS rides the Swift lane and
//  never reaches this file. `desktop` is DERIVED, never an os value of its own.
//
//  The fold is the pure resolution every runtime implements (TS
//  packages/compiler/src/component.ts resolvePlatformAttrs; Swift Stack.swift
//  resolvePlatform): precedence exact target > :desktop > :native > bare,
//  most-specific wins, group suffixes fold to their member targets, suffixed keys
//  never survive, unrecognized suffixes pass through (on:tap / arg:rate are
//  namespaces, not platform tags — and on:tap:ios IS a platform tag on `on:tap`).
//

package despia.engine

/** The running deploy target + its derived constants (`dsx.platform.*`). A kernel
 *  constant, never a module, never null — set once at boot, read everywhere logic
 *  runs (interpolations, visible-if, actions). */
object Platform {
    /** "android" here by default; the desktop host boots "windows" | "linux". */
    var os: String = "android"
    /** Optional satellite render target. Wear keeps deployment identity `android`
     *  while resolving platform-suffixed attributes against exact target `wear`. */
    var nodeTarget: String? = null
    val attributeTarget: String get() = nodeTarget ?: os
    val native: Boolean get() = os != "web"
    val desktop: Boolean get() = isDesktop(os)
    /** third-party web-component embed seam — a web-lane concept; false on native. */
    val embed: Boolean = false

    val desktopOses: List<String> = listOf("macos", "windows", "linux")
    fun isDesktop(target: String): Boolean = target in desktopOses
}

object PlatformAttrs {
    /** Exact targets + group words — pinned 1:1 against the corpus `targets` table. */
    val exactTargets: List<String> =
        listOf("ios", "android", "web", "watch", "wear", "macos", "windows", "linux")
    val groups: Map<String, List<String>> = mapOf(
        "native" to listOf("ios", "android", "watch", "wear", "macos", "windows", "linux"),
        "desktop" to listOf("macos", "windows", "linux"),
    )
    private val suffixes: Set<String> = exactTargets.toSet() + groups.keys

    private fun suffixOf(key: String): String? {
        val colon = key.lastIndexOf(':')
        if (colon <= 0) return null
        val suffix = key.substring(colon + 1)
        return if (suffix in suffixes) suffix else null
    }

    /** The generic fold. Weakest → strongest so a later put is a precedence win:
     *  bare, then :native, then :desktop, then the exact target. */
    fun resolve(a: Map<String, String>, target: String): Map<String, String> {
        if (a.keys.none { suffixOf(it) != null }) return a
        val out = LinkedHashMap<String, String>()
        val bySuffix = HashMap<String, LinkedHashMap<String, String>>()
        for ((k, v) in a) {
            val suffix = suffixOf(k)
            if (suffix == null) out[k] = v
            else bySuffix.getOrPut(suffix) { LinkedHashMap() }[k.substring(0, k.lastIndexOf(':'))] = v
        }
        for (group in listOf("native", "desktop")) {
            if (target in (groups[group] ?: emptyList())) bySuffix[group]?.let { out.putAll(it) }
        }
        bySuffix[target]?.let { out.putAll(it) }
        return out
    }
}
