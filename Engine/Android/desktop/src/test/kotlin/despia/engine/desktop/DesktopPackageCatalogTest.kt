package despia.engine.desktop

import org.junit.jupiter.api.Test
import despia.engine.ModuleRegistry
import despia.engine.Platform
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DesktopPackageCatalogTest {
    private val header = """
        # ModulePlatformSupport.generated.tsv
        # Generated from ClosedSource/DSX/Modules/**/dsx.json by prepare_modules_android.rb.
        # Support facts only: this file does not load or promise any package implementation.
        # scheme<TAB>comma-separated concrete implementation platforms
    """.trimIndent()
    private val implementationHeader = """
        # DesktopPackageImplementations.generated.tsv
        # Generated from enabled desktop Module subclasses; loaded only from this allowlist.
        # targets<TAB>registry-key<TAB>scheme<TAB>aliases<TAB>class<TAB>boot-eligible
    """.trimIndent()

    @Test
    fun schemaAndCanonicalRowsParseExactly() {
        val expected = mapOf("sample" to listOf("ios", "android", "macos"), "scene3d" to listOf("ios"))
        assertEquals(expected, DesktopPackageCatalog.parse("$header\nsample\tios,android,macos\nscene3d\tios\n"))
        assertEquals(
            expected,
            DesktopPackageCatalog.parse("$header\nsample\tios,android,macos\nscene3d\tios\n".replace("\n", "\r\n")),
        )
    }

    @Test
    fun schemaMismatchBlankRecordsAndMissingFinalLfFailClosed() {
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parse("${header.replace("generated.tsv", "v2.tsv")}\nscene3d\tios\n")
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parse("$header\n\nscene3d\tios\n")
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parse("$header\nscene3d\tios")
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parse("$header\rscene3d\tios\n")
        }
    }

    @Test
    fun duplicatesUnknownPlatformsAndUnstableOrderFailClosed() {
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parse("$header\nscene3d\tios\nscene3d\tios\n")
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parse("$header\nsample\tfreebsd\n")
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parse("$header\nsample\tandroid,ios\n")
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parse("$header\nzeta\tios\nalpha\tios\n")
        }
    }

    @Test
    fun desktopImplementationAllowlistIsStrictAndTargetScoped() {
        val parsed = DesktopPackageCatalog.parseImplementations(
            "$implementationHeader\n" +
                "windows,linux\tglobal\tglobal\tstate\tdespia.modules.state.DesktopStateBridge\tfalse\n",
        )
        assertEquals(listOf("windows", "linux"), parsed.single().targets)
        assertEquals("global", parsed.single().key)
        assertEquals(listOf("state"), parsed.single().aliases)
        assertEquals(
            parsed,
            DesktopPackageCatalog.parseImplementations(
                ("$implementationHeader\n" +
                    "windows,linux\tglobal\tglobal\tstate\tdespia.modules.state.DesktopStateBridge\tfalse\n")
                    .replace("\n", "\r\n"),
            ),
        )

        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parseImplementations(
                "$implementationHeader\n" +
                    "windows,android\tglobal\tglobal\t-\tdespia.modules.state.DesktopStateBridge\tfalse\n",
            )
        }
        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parseImplementations(
                "$implementationHeader\n" +
                    "windows\tglobal\tglobal\t-\tjava.lang.Runtime\tfalse\n",
            )
        }

        // Windows and Linux may deliberately ship target-specific twins with
        // the same simple class name; only overlapping target sets conflict.
        val disjointTargetTwins = DesktopPackageCatalog.parseImplementations(
            "$implementationHeader\n" +
                "windows\talpha\talpha\t-\tdespia.modules.alpha.SharedModule\tfalse\n" +
                "linux\tbeta\tbeta\t-\tdespia.modules.beta.SharedModule\tfalse\n",
        )
        assertEquals(2, disjointTargetTwins.size)

        assertFailsWith<IllegalArgumentException> {
            DesktopPackageCatalog.parseImplementations(
                "$implementationHeader\n" +
                    "windows,linux\talpha\talpha\t-\tdespia.modules.alpha.SharedModule\tfalse\n" +
                    "linux\tbeta\tbeta\t-\tdespia.modules.beta.SharedModule\tfalse\n",
            )
        }
    }

    @Test
    fun implementationRoutesAreUnambiguousTargetLocalAndReserveDsx() {
        // The routing-key grammar intentionally includes underscores; these
        // are DSX chains and aliases, not exclusively RFC URI schemes.
        val underscored = DesktopPackageCatalog.parseImplementations(
            "$implementationHeader\n" +
                "windows\tgodot_test\tgodot_test\tlegacy_test\t" +
                "despia.modules.godot.DesktopGodotTest\tfalse\n",
        )
        assertEquals("godot_test", underscored.single().key)

        listOf(
            // alias versus another record's primary route
            "windows\talpha\talpha\tshared\tdespia.modules.alpha.AlphaModule\tfalse\n" +
                "windows\tshared\tshared\t-\tdespia.modules.shared.SharedModule\tfalse\n",
            // alias versus alias
            "windows\talpha\talpha\tshared\tdespia.modules.alpha.AlphaModule\tfalse\n" +
                "windows\tbeta\tbeta\tshared\tdespia.modules.beta.BetaModule\tfalse\n",
            // reserved primary and reserved alias
            "windows\tdsx\tdsx\t-\tdespia.modules.alpha.AlphaModule\tfalse\n",
            "windows\talpha\talpha\tdsx\tdespia.modules.alpha.AlphaModule\tfalse\n",
            // canonical target order is windows,linux, never normalized.
            "linux,windows\talpha\talpha\t-\tdespia.modules.alpha.AlphaModule\tfalse\n",
        ).forEach { records ->
            assertFailsWith<IllegalArgumentException> {
                DesktopPackageCatalog.parseImplementations("$implementationHeader\n$records")
            }
        }

        // The same spelling is valid for disjoint target records.
        val disjointRoute = DesktopPackageCatalog.parseImplementations(
            "$implementationHeader\n" +
                "windows\talpha\talpha\tshared\tdespia.modules.alpha.WindowsAlpha\tfalse\n" +
                "linux\tbeta\tbeta\tshared\tdespia.modules.beta.LinuxBeta\tfalse\n",
        )
        assertEquals(2, disjointRoute.size)
    }

    @Test
    fun packageInstallationIsIdempotentForOneProcessTarget() {
        // install() intentionally mutates production singletons. The desktop
        // Gradle lane runs this whole class in its own one-class JVM fork, so
        // there is no test-only production reset seam and no cross-class leak.
        val previous = Platform.os
        try {
            Platform.os = "linux"
            DesktopPackageCatalog.install()
            val first = ModuleRegistry.shared.registeredSchemes
            DesktopPackageCatalog.install()
            assertEquals(first, ModuleRegistry.shared.registeredSchemes)
        } finally {
            Platform.os = previous
        }
    }
}
