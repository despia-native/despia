package despia.engine

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/// Conformance tests for the DSXStrings localization seam — behavior pinned to
/// DSXStrings.swift. DSXStrings is a process singleton caching ONE (lang, version)
/// table, so every scenario installs its own seams with a UNIQUE version string
/// (forcing the reload) and the seams are restored after each test.
class StringsTest {

    private companion object {
        /// JUnit 5 news up the test class per method — the version counter must
        /// survive instances, or (lang, version) pairs would repeat and hit the
        /// singleton's deliberately-stale cache across tests.
        var stamp = 0
    }

    /// Install all three seams for one scenario. `bundles` is the BUILD tier
    /// (lang tag → Strings.<lang>.json text); `runtime` the RUNTIME tier
    /// (lang tag → the `global.strings.<lang>` dict).
    private fun install(
        deviceLang: String = "en",
        locale: String? = null,
        bundles: Map<String, String> = emptyMap(),
        runtime: Map<String, Map<String, Any?>> = emptyMap(),
    ) {
        val version = "v${stamp++}"
        DSXStrings.deviceLang = deviceLang
        DSXStrings.loader = if (bundles.isEmpty()) null else ({ lang -> bundles[lang] })
        DSXStrings.statePath = { path ->
            when {
                path == "locale" -> locale
                path == "strings.version" -> version
                path.startsWith("strings.") -> runtime[path.removePrefix("strings.")]
                else -> null
            }
        }
    }

    @AfterTest fun restoreSeams() {
        DSXStrings.loader = null
        DSXStrings.statePath = { null }
        DSXStrings.deviceLang = "en"
    }

    // -- fail-open identity (Article 7) --

    @Test fun emptyInputIsIdentity() {
        install(deviceLang = "de", bundles = mapOf("de" to """{"Save":"Sichern"}"""))
        assertEquals("", DSXStrings.localize(""))
    }

    @Test fun missingLangTableFailsOpen() {
        install(deviceLang = "de")                       // no bundle tier, no runtime tier
        assertEquals("Save", DSXStrings.localize("Save"))
    }

    @Test fun missesInALoadedTableFailOpen() {
        install(deviceLang = "de", bundles = mapOf("de" to """{"Save":"Sichern"}"""))
        assertEquals("Sichern", DSXStrings.localize("Save"))
        assertEquals("Delete", DSXStrings.localize("Delete"))   // byte-for-byte identity
    }

    @Test fun englishSourceLanguageLoadsNoTable() {
        // The bare source tag is skipped outright — an "en" table can never apply.
        install(deviceLang = "en", bundles = mapOf("en" to """{"Save":"X"}"""))
        assertEquals("Save", DSXStrings.localize("Save"))
    }

    @Test fun regionalEnglishFullTagIsStillConsulted() {
        // Pinned Swift behavior: only the BARE "en" is the source-language skip —
        // the full tag ("en-us") is a legitimate table candidate.
        install(deviceLang = "en-us", bundles = mapOf("en-us" to """{"Colour":"Color"}"""))
        assertEquals("Color", DSXStrings.localize("Colour"))
    }

    // -- BCP-47: full tag, then bare language --

    @Test fun bareLanguageFallsBackWhenFullTagHasNoTable() {
        install(deviceLang = "pt-br", bundles = mapOf("pt" to """{"Save":"Salvar"}"""))
        assertEquals("Salvar", DSXStrings.localize("Save"))
    }

    @Test fun fullTagWinsOverBareLanguage() {
        install(deviceLang = "pt-br", bundles = mapOf(
            "pt-br" to """{"Save":"BR"}""",
            "pt" to """{"Save":"PT"}""",
        ))
        assertEquals("BR", DSXStrings.localize("Save"))
    }

    @Test fun underscoreVariantSplitsToBareLanguage() {
        install(deviceLang = "pt_br", bundles = mapOf("pt" to """{"Save":"Salvar"}"""))
        assertEquals("Salvar", DSXStrings.localize("Save"))
    }

    // -- the two tiers: bundle under runtime --

    @Test fun runtimeOverlayMergesOverTheBundleTable() {
        install(
            deviceLang = "de",
            bundles = mapOf("de" to """{"Save":"Bundle","Cancel":"Abbrechen"}"""),
            runtime = mapOf("de" to mapOf("Save" to "Runtime")),
        )
        assertEquals("Runtime", DSXStrings.localize("Save"))       // runtime tier wins
        assertEquals("Abbrechen", DSXStrings.localize("Cancel"))   // bundle survives underneath
    }

    @Test fun runtimeOnlyTableApplies() {
        install(deviceLang = "de", runtime = mapOf("de" to mapOf("Save" to "OTA")))
        assertEquals("OTA", DSXStrings.localize("Save"))
    }

    @Test fun nonStringEntriesAreSkippedInBothTiers() {
        install(
            deviceLang = "de",
            bundles = mapOf("de" to """{"Save":"Sichern","n":3}"""),
            runtime = mapOf("de" to mapOf("m" to 5)),
        )
        assertEquals("Sichern", DSXStrings.localize("Save"))
        assertEquals("n", DSXStrings.localize("n"))
        assertEquals("m", DSXStrings.localize("m"))
    }

    @Test fun invalidBundleJsonFailsOpen() {
        install(deviceLang = "de", bundles = mapOf("de" to "not json at all"))
        assertEquals("Save", DSXStrings.localize("Save"))
    }

    // -- `global.locale` --

    @Test fun localeOverridesDeviceLanguageAndLowercases() {
        install(deviceLang = "en", locale = "DE", bundles = mapOf("de" to """{"Save":"Sichern"}"""))
        assertEquals("Sichern", DSXStrings.localize("Save"))
    }

    @Test fun emptyLocaleFallsBackToDeviceLanguage() {
        install(deviceLang = "de", locale = "", bundles = mapOf("de" to """{"Save":"Sichern"}"""))
        assertEquals("Sichern", DSXStrings.localize("Save"))
    }

    @Test fun localeChangeReloadsTheTable() {
        // An in-app switcher's write stays live: a lang change alone reloads.
        var locale = "de"
        val version = "vloc-${stamp++}"
        DSXStrings.deviceLang = "en"
        DSXStrings.loader = { lang ->
            mapOf("de" to """{"Save":"Sichern"}""", "fr" to """{"Save":"Enregistrer"}""")[lang]
        }
        DSXStrings.statePath = { path ->
            when (path) { "locale" -> locale; "strings.version" -> version; else -> null }
        }
        assertEquals("Sichern", DSXStrings.localize("Save"))
        locale = "fr"
        assertEquals("Enregistrer", DSXStrings.localize("Save"))
    }

    // -- the (lang, version) reload contract --

    @Test fun tableReloadsOnlyOnVersionBump() {
        var text = """{"Save":"One"}"""
        var version = "va-${stamp++}"
        DSXStrings.deviceLang = "de"
        DSXStrings.loader = { lang -> if (lang == "de") text else null }
        DSXStrings.statePath = { path -> if (path == "strings.version") version else null }
        assertEquals("One", DSXStrings.localize("Save"))
        text = """{"Save":"Two"}"""
        assertEquals("One", DSXStrings.localize("Save"))   // same (lang, version): deliberately stale
        version = "vb-${stamp++}"
        assertEquals("Two", DSXStrings.localize("Save"))   // bump ⇒ reload
    }
}
