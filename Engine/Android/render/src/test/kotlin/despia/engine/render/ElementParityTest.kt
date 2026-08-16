//
//  ElementParityTest.kt — the ELEMENT PARITY harness: diffs every registered ElementSpec
//  (ElementSpec.kt — the :render element registry) against the cross-platform truth fixtures
//  in OpenSource/Conformance/elements/*.json (extracted line-by-line from the Swift reference
//  renderer; see that folder's README for the schema + enforcement matrix).
//
//  FAILS (drift — never allowlistable): a default/geometry/color/alias declared on BOTH
//  sides that disagrees; a spec-only key the fixture doesn't know; a spec without a fixture;
//  a fixture without a spec that is NOT in elements-gaps.json.
//  REPORTS (the wave list — println'd, CI stays green): fixtures allowlisted as
//  missing/module/dclass in elements-gaps.json; fixture keys the spec doesn't cover yet;
//  `partial`-allowlisted named divergences; stale allowlist entries whose spec has landed.
//  Empty elements-gaps.json = full enforcement.
//
package despia.engine.render

import despia.engine.json
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ElementParityTest {

    // Finder/iCloud conflict copies are workspace artefacts, not additional contracts.
    private val finderConflictCopy = Regex(".+ [0-9]+\\.json")

    // The corpus sits in the open drop — walk up from the working dir to the repo root
    // (the ConformanceTest convention). Missing corpus = loud failure, never a silent skip.
    private fun corpusDir(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/elements")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
                ?: error("OpenSource/Conformance/elements not found walking up from ${System.getProperty("user.dir")}")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun obj(file: File): Map<String, Any?> =
        (json(file.readText()).foundationValue as? Map<String, Any?>)
            ?: error("${file.name}: not a JSON object")

    private fun fixtureFiles(dir: File): List<File> =
        dir.listFiles { f ->
            f.isFile && f.extension == "json" && f.name != "elements-gaps.json" &&
                !finderConflictCopy.matches(f.name)
        }?.sortedBy { it.name } ?: emptyList()

    /// Canonical string form shared by both sides of the diff: numbers unpadded ("8", not
    /// "8.0"), booleans "true"/"false", null = no default. Descriptive fixture defaults
    /// (anything else) pass through as-is.
    private fun canon(v: Any?): String? = when (v) {
        null -> null
        is Boolean -> if (v) "true" else "false"
        is Double -> if (v == Math.floor(v) && !v.isInfinite()) v.toLong().toString() else v.toString()
        is Int -> v.toString()
        is Long -> v.toString()
        else -> v.toString()
    }

    @Suppress("UNCHECKED_CAST")
    @Test
    fun specsMatchFixtures() {
        val dir = corpusDir()
        val fixtureFiles = fixtureFiles(dir)
        require(fixtureFiles.isNotEmpty()) { "element parity corpus is empty — OpenSource/Conformance/elements/*.json" }

        // ── the allowlist (elements-gaps.json): known gaps report instead of fail ──
        val gapsFile = File(dir, "elements-gaps.json")
        val gaps = if (gapsFile.isFile) obj(gapsFile) else emptyMap()
        val missing = (gaps["missing"] as? List<Any?>)?.map { it.toString() }?.toSet() ?: emptySet()
        val module = ((gaps["module"] as? Map<String, Any?>)?.get("tags") as? List<Any?>)?.map { it.toString() }?.toSet() ?: emptySet()
        val dclass = ((gaps["dclass"] as? Map<String, Any?>)?.get("tags") as? List<Any?>)?.map { it.toString() }?.toSet() ?: emptySet()
        val partial = (gaps["partial"] as? Map<String, Any?>)?.mapValues { (_, v) ->
            (v as? List<Any?>)?.map { it.toString() }?.toSet() ?: emptySet()
        } ?: emptyMap()

        val specs = ElementSpecs.all()
        val failures = mutableListOf<String>()
        val report = StringBuilder("── ELEMENT PARITY REPORT ──\n")
        var enforced = 0; var gapMissing = 0; var gapModule = 0; var gapDclass = 0

        val fixtureTags = mutableSetOf<String>()
        for (file in fixtureFiles) {
            val fx = obj(file)
            val tag = fx["tag"] as? String ?: run { failures += "${file.name}: no tag"; continue }
            if (file.nameWithoutExtension != tag) {
                failures += "${file.name}: canonical fixture filename must be `$tag.json`"
            }
            fixtureTags += tag
            val spec = specs[tag]

            if (spec == null) {
                // A tag registered in the Compose component registry without a parity spec is
                // the exact drift this harness exists to catch. While the tag still sits in the
                // gaps file's `missing` list it REPORTS (loudly — a landing wave gets a grace
                // window on the shared branch); off the allowlist it FAILS. Empty allowlist =
                // full enforcement.
                val aliases = (fx["aliases"] as? List<Any?>)?.map { it.toString() } ?: emptyList()
                val implemented = (listOf(tag) + aliases).any {
                    ComposeStackComponents.nativeGlobal(it) != null || ComposeStackComponents.privilegedGlobal(it) != null
                }
                if (implemented && tag !in missing && tag !in module && tag !in dclass) {
                    failures += "<$tag>: registered in ComposeStackComponents but NO ElementSpec — declare its " +
                        "constants in ElementSpec.kt registerBuiltins() (see that file's header)."
                    continue
                }
                if (implemented) {
                    report.append("  IMPLEMENTED-UNSPECCED <$tag> — registered in ComposeStackComponents but no " +
                        "ElementSpec; register one in ElementSpec.kt registerBuiltins() and move the tag out of " +
                        "elements-gaps.json `missing`\n")
                    continue
                }
                when (tag) {
                    in missing -> { gapMissing++; report.append("  GAP  (missing on Android)  <$tag>\n") }
                    in module  -> { gapModule++;  report.append("  GAP  (module-implemented, outside :render) <$tag>\n") }
                    in dclass  -> { gapDclass++;  report.append("  GAP  (D-class, iOS-only by decision) <$tag>\n") }
                    else -> failures += "<$tag>: fixture exists but :render registers NO ElementSpec and the tag " +
                        "is not allowlisted in elements-gaps.json — implement it (and register a spec in " +
                        "ElementSpec.kt registerBuiltins()) or allowlist the gap."
                }
                continue
            }
            enforced++
            if (tag in missing || tag in module || tag in dclass) {
                report.append("  STALE allowlist entry: <$tag> has a spec now — remove it from elements-gaps.json\n")
            }
            val allowed = partial[tag] ?: emptySet()
            fun mismatch(key: String, msg: String) {
                if (key in allowed) report.append("  PARTIAL (allowlisted divergence) <$tag> $key — $msg\n")
                else failures += "<$tag> $key: $msg"
            }

            // aliases — exact set equality.
            val fxAliases = (fx["aliases"] as? List<Any?>)?.map { it.toString() }?.toSet() ?: emptySet()
            if (fxAliases != spec.aliases.toSet()) {
                mismatch("aliases", "fixture ${fxAliases.sorted()} vs spec ${spec.aliases.sorted()}")
            }

            // attributes — defaults must agree where both declare; spec-only names fail;
            // fixture-only names are the coverage wave list.
            val fxAttrs = (fx["attributes"] as? Map<String, Any?>) ?: emptyMap()
            for ((name, rawDef) in fxAttrs) {
                val def = canon((rawDef as? Map<String, Any?>)?.get("default"))
                if (!spec.attributes.containsKey(name)) {
                    report.append("  TODO <$tag> attribute `$name` not yet declared on Android (iOS default: ${def ?: "none"})\n")
                    continue
                }
                val specDef = spec.attributes[name]
                if (canon(specDef) != def) {
                    mismatch("attributes.$name", "default drift — fixture `${def}` vs spec `${canon(specDef)}` " +
                        "(_src: ${(rawDef as? Map<String, Any?>)?.get("_src")})")
                }
            }
            for (name in spec.attributes.keys - fxAttrs.keys) {
                mismatch("attributes.$name", "spec declares an attribute the fixture doesn't know — " +
                    "extract it into OpenSource/Conformance/elements/$tag.json (fixtures are the truth) or drop it")
            }

            // geometry — exact numeric equality where both declare; spec-only keys fail.
            val fxGeom = (fx["geometry"] as? Map<String, Any?>) ?: emptyMap()
            for ((name, rawVal) in fxGeom) {
                val entry = rawVal as? Map<String, Any?>
                val v = (entry?.get("value") as? Number)?.toDouble()
                val specV = spec.geometry[name]
                when {
                    specV == null -> report.append("  TODO <$tag> geometry `$name` (${v}) not yet pinned on Android\n")
                    v == null -> failures += "<$tag> geometry.$name: fixture value is not a number"
                    Math.abs(specV - v) > 1e-9 ->
                        mismatch("geometry.$name", "drift — fixture $v vs spec $specV (_src: ${entry.get("_src")})")
                }
            }
            for (name in spec.geometry.keys - fxGeom.keys) {
                mismatch("geometry.$name", "spec pins a constant the fixture doesn't know — extract it into the fixture or drop it")
            }

            // colors — semantic token equality where both declare; spec-only keys fail.
            val fxColors = (fx["colors"] as? Map<String, Any?>) ?: emptyMap()
            for ((name, rawVal) in fxColors) {
                val token = (rawVal as? Map<String, Any?>)?.get("token")?.toString()
                val specT = spec.colors[name]
                when {
                    specT == null -> report.append("  TODO <$tag> color `$name` ($token) not yet pinned on Android\n")
                    specT != token ->
                        mismatch("colors.$name", "token drift — fixture `$token` vs spec `$specT` (_src: ${(rawVal as? Map<String, Any?>)?.get("_src")})")
                }
            }
            for (name in spec.colors.keys - fxColors.keys) {
                mismatch("colors.$name", "spec declares a color role the fixture doesn't know — extract it or drop it")
            }
        }

        // Every spec must have a fixture — new elements land fixture-first.
        for (tag in specs.keys - fixtureTags) {
            failures += "<$tag>: ElementSpec registered but NO fixture at OpenSource/Conformance/elements/$tag.json — " +
                "extract the element's constants from the Swift source first (see the corpus README)."
        }

        report.append("── totals: ${fixtureFiles.size} fixtures · $enforced enforced specs · " +
            "$gapMissing missing / $gapModule module / $gapDclass d-class gaps ──")
        println(report)

        if (failures.isNotEmpty()) {
            fail("ELEMENT PARITY violations (${failures.size}):\n - " + failures.joinToString("\n - "))
        }
    }
}
