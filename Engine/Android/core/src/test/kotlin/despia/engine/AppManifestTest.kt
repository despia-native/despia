package despia.engine

import java.net.URI
import org.junit.jupiter.api.AfterEach
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * AppManifest — App.json parse (locale-ladder precedence, fail-open defaults, entry +
 * bundle_signing blocks), the startURL authority, the routing match semantics, and the
 * AppEnvironment channel (fail-closed default + the detector seam). Every seam swapped is
 * restored in teardown.
 */
class AppManifestTest {

    @AfterEach fun teardown() {
        AppManifest.manifestLoader = { null }
        AppManifest.engineConfigLoader = { null }
        AppManifest.regionCode = { java.util.Locale.getDefault().country.takeIf { it.isNotEmpty() } }
        AppManifest.dynamicHostSource = null
        AppManifest.devOriginSource = null
        DSXLocale.preferredLanguages = { listOf(java.util.Locale.getDefault().toLanguageTag()) }
        AppEnvironment.detector = { AppEnvironment.appstore }
        AppEnvironment.simulatedChannel = null
        KernelLog.enabled = false
    }

    private fun device(vararg languages: String, region: String? = "US") {
        DSXLocale.preferredLanguages = { languages.toList() }
        AppManifest.regionCode = { region }
    }

    // MARK: fail-open — no / malformed App.json leaves every pre-App.json app byte-for-byte

    @Test fun missingOrMalformedManifestFailsOpenEverywhere() {
        for (loader in listOf<() -> String?>({ null }, { "" }, { "not json" }, { "[1,2]" })) {
            AppManifest.manifestLoader = loader
            assertTrue(AppManifest.manifest.isEmpty())
            assertNull(AppManifest.appName)
            assertNull(AppManifest.resolvedHost())
            assertEquals("legacy.com", AppManifest.host(fallback = "legacy.com"))   // step 5: the legacy value stands
            assertNull(AppManifest.refreshURL)
            assertNull(AppManifest.bundleSigning)                                   // absent ⇒ signing OFF
            assertTrue(AppManifest.declaredHosts.isEmpty())
            assertEquals("/dsx", AppManifest.contentRoot)
            assertEquals(300, AppManifest.contentBudgetMB)
            assertEquals(240, AppManifest.contentMaxBlobMB)
            val entry = AppManifest.entry
            assertEquals("/", entry.root)
            assertNull(entry.ota)
            // No plan ⇒ the kernel names NO surface (the retired defaultView web floor is gone):
            // the derived fallback is empty and the boot diagnostic owns the state.
            assertTrue(entry.surfaces.isEmpty())
            assertEquals("", entry.fallback.view)
            assertEquals("", entry.fallback.src)
            assertEquals("", entry.fallback.origin)
        }
    }

    // MARK: the locale ladder (steps 1–4, case-insensitive keys, first-tag-only)

    @Test fun localeLadderPrecedence() {
        AppManifest.manifestLoader = {
            """{ "host": "x.com", "hosts": { "de": "de.x.com", "fr-CA": "ca.x.fr", "JP": "jp.x.com" } }"""
        }
        device("fr-CA")
        assertEquals("ca.x.fr", AppManifest.resolvedHost())       // 1. exact tag
        device("FR-ca")
        assertEquals("ca.x.fr", AppManifest.resolvedHost())       //    … case-insensitively
        device("de-AT")
        assertEquals("de.x.com", AppManifest.resolvedHost())      // 2. bare language
        device("en-US", region = "jp")
        assertEquals("jp.x.com", AppManifest.resolvedHost())      // 3. region ("JP" key, lowercased)
        device("en-US", region = "US")
        assertEquals("x.com", AppManifest.resolvedHost())         // 4. default host
        device("zz", "de-DE", region = "US")
        assertEquals("x.com", AppManifest.resolvedHost())         // ONLY the first tag runs the ladder (Swift .first)
        device("en-US", region = null)
        assertEquals("x.com", AppManifest.resolvedHost())         // no region → default host
    }

    @Test fun dynamicHostSourceIsConsultedFirstThenFallsThroughToBundled() {
        AppManifest.manifestLoader = { """{ "host": "x.com" }""" }
        device("en-US")
        AppManifest.dynamicHostSource = { AppManifest.HostSource(mapOf("EN" to "dyn.en.com"), "dyn.com") }
        assertEquals("dyn.en.com", AppManifest.resolvedHost())    // bare lang, case-insensitive keys
        AppManifest.dynamicHostSource = { AppManifest.HostSource(emptyMap(), null) }
        assertEquals("x.com", AppManifest.resolvedHost())         // dynamic miss → bundled ladder
        AppManifest.dynamicHostSource = null
        assertEquals("x.com", AppManifest.resolvedHost())         // absent seam == today's behavior
    }

    // MARK: identity fields, entry + bundle_signing blocks, strict-cast fidelity

    @Test fun identityEntryAndBundleSigningParse() {
        AppManifest.manifestLoader = {
            """{ "name": " My App ", "host": "x.com", "hosts": { "de": "de.x.com" },
                 "refresh_url": " https://x.com/app.json ",
                 "bundle_signing": { "keys": ["k1"] },
                 "entry": { "root": "/home", "ota": "/m.json",
                            "surfaces": [ { "view": "DSXView", "config": { "src": "/dsx/offline/", "origin": "app" } } ] } }"""
        }
        assertEquals("My App", AppManifest.appName)                       // cleaned
        assertEquals("https://x.com/app.json", AppManifest.refreshURL)
        assertEquals(mapOf("keys" to listOf("k1")), AppManifest.bundleSigning)
        assertEquals(setOf("de.x.com", "x.com"), AppManifest.declaredHosts.toSet())
        val entry = AppManifest.entry
        assertEquals("/home", entry.root)
        assertEquals("/m.json", entry.ota)
        assertEquals("DSXView", entry.fallback.view)
        assertEquals("/dsx/offline/", entry.fallback.src)
        assertEquals("app", entry.fallback.origin)
        // strict [String: String] cast: one bad value fails the WHOLE hosts map (Swift as?)
        AppManifest.manifestLoader = { """{ "host": "x.com", "hosts": { "de": 5 } }""" }
        assertEquals(listOf("x.com"), AppManifest.declaredHosts)
    }

    @Test fun engineConfigSetsTheContentLimits() {
        AppManifest.engineConfigLoader = {
            """{ "content": { "budget_mb": 120, "max_blob_mb": 512 } }"""
        }
        assertEquals(120, AppManifest.contentBudgetMB)
        assertEquals(512, AppManifest.contentMaxBlobMB)
        AppManifest.engineConfigLoader = { """{ "content": { "max_blob_mb": 0 } }""" }
        assertEquals(1, AppManifest.contentMaxBlobMB)
        AppManifest.engineConfigLoader = { """{ "content": { "max_blob_mb": 999999999999 } }""" }
        assertEquals(2048, AppManifest.contentMaxBlobMB)
        AppManifest.engineConfigLoader = { """{ "content": { "max_blob_mb": "bad" } }""" }
        assertEquals(240, AppManifest.contentMaxBlobMB)
        // The retired `defaults.view` never reaches the entry: no plan ⇒ no surface named.
        AppManifest.engineConfigLoader = { """{ "defaults": { "view": "DSXView" } }""" }
        AppManifest.manifestLoader = { """{ "entry": {} }""" }
        assertEquals("", AppManifest.entry.fallback.view)
    }

    @Test fun contentRootNormalization() {
        for ((raw, expect) in listOf("content/" to "/content", "/a/b/" to "/a/b",
                                     "/" to "", "" to "", " /dsx " to "/dsx")) {
            AppManifest.manifestLoader = { """{ "hosting": { "content_root": "$raw" } }""" }
            assertEquals(expect, AppManifest.contentRoot, "content_root \"$raw\"")
        }
    }

    // MARK: startURL — the single launch-URL authority

    @Test fun startURLKeepsTheLegacyURLByteForByteWithoutAManifest() {
        val legacy = "https://legacy.com/app?q=a%20b#frag"
        assertEquals(legacy, AppManifest.startURL(legacy, "fb.com").toString())
        assertEquals("https://fb.com", AppManifest.startURL("", "fb.com").toString())          // empty base
        assertEquals("https://fb.com", AppManifest.startURL("myapp.com", "fb.com").toString()) // hostless base isn't a base
        assertEquals("about:blank", AppManifest.startURL("", " ").toString())                  // nothing anywhere — never crash
    }

    @Test fun startURLSwapsTheResolvedHostIntoTheBase() {
        AppManifest.manifestLoader = { """{ "host": "myapp.com" }""" }
        device("en-US")
        assertEquals("https://myapp.com/app?q=a%20b#frag",
                     AppManifest.startURL("https://legacy.com/app?q=a%20b#frag", "fb").toString())
        assertEquals("http://myapp.com:8080/a",                        // base scheme + port ship unchanged
                     AppManifest.startURL("http://legacy.com:8080/a", "fb").toString())
        assertEquals("https://myapp.com",                              // no usable base → https://<resolved>
                     AppManifest.startURL("", "fb").toString())
    }

    // MARK: dev-origin override (non-production only; beats the dynamic source)

    @Test fun devOriginOverrideIsInertOnProductionAndWinsOffIt() {
        AppManifest.manifestLoader = { """{ "host": "myapp.com" }""" }
        device("en-US")
        AppManifest.devOriginSource = { URI("http://192.168.1.20:3000") }
        assertEquals("myapp.com", AppManifest.resolvedHost())          // prod (fail-closed default) ⇒ inert
        assertEquals("myapp.com", AppManifest.resolvedOriginString())
        AppEnvironment.detector = { AppEnvironment.debug }
        assertEquals("192.168.1.20", AppManifest.resolvedHost())
        assertEquals("http://192.168.1.20:3000", AppManifest.resolvedOriginString())  // scheme + port ride along
        assertEquals("http://192.168.1.20:3000/app?x=1",               // origin-level swap, path/query unchanged
                     AppManifest.startURL("https://legacy.com/app?x=1", "fb").toString())
        AppManifest.dynamicHostSource = { AppManifest.HostSource(emptyMap(), "dyn.com") }
        assertEquals("192.168.1.20", AppManifest.resolvedHost())       // the tester's choice beats the migration map
    }

    // MARK: routing match semantics

    @Test fun isHostMatchesOnDotBoundariesAfterNormalization() {
        assertTrue(AppManifest.isHost("blog.myapp.com", within = "myapp.com"))
        assertFalse(AppManifest.isHost("evilmyapp.com", within = "myapp.com"))   // the old hasSuffix hole
        assertTrue(AppManifest.isHost("www.MyApp.com", within = "myapp.com"))
        assertTrue(AppManifest.isHost("myapp.com", within = "WWW.myapp.com"))
        assertFalse(AppManifest.isHost(null, within = "myapp.com"))
        assertFalse(AppManifest.isHost("myapp.com", within = null))
        assertFalse(AppManifest.isHost(" ", within = "myapp.com"))
    }

    @Test fun isExactHostGrantsNoSubdomainBoundary() {
        assertTrue(AppManifest.isExactHost("www.myapp.com", within = "myapp.com"))
        assertFalse(AppManifest.isExactHost("blog.myapp.com", within = "myapp.com"))
    }

    @Test fun listMembershipIsExactUnlessExplicitlyWildcarded() {
        assertTrue(AppManifest.list(listOf("pay.com"), contains = "www.PAY.com"))  // exact normalized
        assertFalse(AppManifest.list(listOf("pay.com"), contains = "sub.pay.com")) // no implicit subdomains
        assertTrue(AppManifest.list(listOf("*.cdn.com"), contains = "a.b.cdn.com"))
        assertTrue(AppManifest.list(listOf("*.cdn.com"), contains = "cdn.com"))    // wildcard includes the apex
        assertFalse(AppManifest.list(emptyList(), contains = "x.com"))
        assertFalse(AppManifest.list(listOf("pay.com"), contains = null))
    }

    // MARK: AppEnvironment — the channel fails CLOSED

    @Test fun environmentFailsClosedToAppstore() {
        assertEquals(AppEnvironment.appstore, AppEnvironment.current)   // the seam's default
        assertTrue(AppEnvironment.current.isProduction)
        assertFalse(AppEnvironment.current.isTest)
        AppEnvironment.detector = { throw IllegalStateException("boom") }
        assertEquals(AppEnvironment.appstore, AppEnvironment.current)   // a failing detector is still production
    }

    @Test fun detectorSeamDrivesTheChannelAndDSXEnvReadsIt() {
        AppEnvironment.detector = { AppEnvironment.testflight }
        assertEquals("testflight", DSXEnv().channel)
        assertFalse(DSXEnv().isProduction)
        assertTrue(DSXEnv().isTest)
        AppEnvironment.detector = { AppEnvironment.simulator }
        assertEquals("simulator", AppEnvironment.current.rawValue)
    }

    @Test fun simulatedChannelIsHonoredOnlyUnderTheDebugSeam() {
        AppEnvironment.detector = { AppEnvironment.debug }
        AppEnvironment.simulatedChannel = AppEnvironment.appstore
        assertEquals(AppEnvironment.debug, AppEnvironment.current)      // seam off (release) → cannot be flipped
        KernelLog.enabled = true                                        // the port's DEBUG seam
        assertEquals(AppEnvironment.appstore, AppEnvironment.current)   // the prod-inertness test hook
        assertTrue(DSXEnv().isProduction)
    }
}
