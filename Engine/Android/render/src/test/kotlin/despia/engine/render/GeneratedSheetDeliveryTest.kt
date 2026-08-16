//
//  GeneratedSheetDeliveryTest.kt — the sheet-DELIVERY integration slice: a REAL generated
//  registry entry (despia/registry/DSXCSSStyles.generated.kt, emitted by
//  prepare_modules_android.rb §5f from Custom/Demo's Components/System.css + the app theme
//  Config/theme.css) decodes through the :core CSSEngine seam and resolves through the
//  renderer's four-layer cascade (resolvedAttrs layer 2), theme var() table included.
//  StackCascadeActionTest covers layer-2 PRECEDENCE with hand-written sheets; THIS file
//  pins the pipeline's actual output shape end-to-end.
//
//  FIXTURE HONESTY (the "read the generated file or embed a copy" decision): the open
//  kernel must build + test WITHOUT ClosedSource, so the fixtures below are VERBATIM
//  copies of the generated entries (the unescaped IR JSON — byte-identical to the Swift
//  registry, the generator's byte-stability contract) and the assertions always run.
//  When the full repo IS on disk (this tree development, CI), the drift gate below
//  re-escapes each fixture with the generator's kotlin_string rule and asserts the
//  generated file still carries it whenever its owning package is enabled. A production
//  profile that excludes Custom/Demo must omit System instead. In the open drop the
//  generated file is absent and the gate passes vacuously (documented, deliberate).
//

package despia.engine.render

import despia.engine.CSSEngine
import despia.engine.CSSResolver
import despia.engine.StackNode
import despia.engine.StackStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class GeneratedSheetDeliveryTest {

    // ── fixtures: VERBATIM from despia/registry/DSXCSSStyles.generated.kt (unescaped) ──

    /** The app theme — DSX/Modules/Config/theme.css compiled (`theme` in the registry).
     *  Post system-defaults: the surface/text trio rides the corpus WORDS (scheme-adaptive
     *  through StackStyle.color at paint), so the sheet is one :root rule — no media block. */
    private val themeIR =
        """{"interpolations":[],"rules":[{"children":[],"declarations":[{"custom":true,"property":"--bg","value":"groupedBackground"},{"custom":true,"property":"--surface","value":"secondaryGroupedBackground"},{"custom":true,"property":"--surface-raised","value":"fill"},{"custom":true,"property":"--text","value":"label"},{"custom":true,"property":"--text-secondary","value":"secondary"},{"custom":true,"property":"--text-tertiary","value":"tertiary"},{"custom":true,"property":"--accent","value":"accent"},{"custom":true,"property":"--ok","value":"#30d158"},{"custom":true,"property":"--warn","value":"#ff9f0a"},{"custom":true,"property":"--bad","value":"destructive"},{"custom":true,"property":"--pad","value":"1rem"},{"custom":true,"property":"--pad-tight","value":"0.875rem"},{"custom":true,"property":"--gap","value":"0.625rem"},{"custom":true,"property":"--radius-card","value":"14px"},{"custom":true,"property":"--radius-pill","value":"18px"}],"selector":":root","type":"rule"}]}"""

    /** Custom/Demo Components/System.css compiled (the `"System"` sheets entry) — its
     *  `.card` rule mixes a SEMANTIC background token (`secondaryGroupedBackground`, the
     *  system-defaults demo flip) with a theme var (`var(--radius-card)`). */
    private val systemIR =
        """{"rules":[{"children":[],"declarations":[{"property":"padding","value":"0.875rem"},{"property":"gap","value":"0.5rem"},{"property":"background","value":"secondaryGroupedBackground"},{"property":"border-radius","value":"var(--radius-card)"}],"selector":".card","type":"rule"}]}"""

    private fun ctx(classes: Set<String> = emptySet()) =
        CSSResolver.Context(isDark = true, windowWidth = 390.0, windowHeight = 844.0, classes = classes)

    // ── the delivery slice: real IR → CSSEngine → the renderer's cascade layer 2 ─────────

    @Test fun realGeneratedSheetResolvesThroughTheCascade() {
        CSSEngine.registerTheme(themeIR)
        CSSEngine.register("System", systemIR)
        try {
            // <vstack class="card"/> inside the System component (css-owner stamp) — the
            // exact shape ComposeStackComponents.defineNode hands the renderer.
            val n = StackNode("vstack", mapOf("css-owner" to "System", "class" to "card"), emptyList())
            val a = resolvedAttrs(n, StackStore(), null, ctx())
            assertEquals("14", a["padding"])          // 0.875rem → dp
            assertEquals("8", a["spacing"])           // gap 0.5rem → the vstack axis' spacing
            assertEquals("secondaryGroupedBackground", a["background"])  // the semantic word passes through — StackStyle.color resolves it at paint
            assertEquals("14", a["radius"])           // var(--radius-card) ← 14px theme token
            // No class match → the sheet stays silent (delivery registers, never leaks).
            val miss = resolvedAttrs(StackNode("vstack", mapOf("css-owner" to "System"), emptyList()),
                                     StackStore(), null, ctx())
            assertEquals(null, miss["padding"])
        } finally {
            // Neutralize the theme for the rest of the shared JVM (CSSEngine.reset() is
            // :core-internal; an empty theme yields an empty token table — equivalent).
            CSSEngine.registerTheme("""{"rules":[]}""")
        }
    }

    // ── the drift gate: the fixture must still BE the generated registry's entry ─────────

    @Test fun fixturesMatchTheGeneratedRegistryWhenPresent() {
        val generated = findGeneratedRegistry() ?: return   // open drop: no ClosedSource — vacuous, by design
        val text = generated.readText()
        assertTrue("theme fixture drifted from DSXCSSStyles.generated.kt — re-copy it (the generator changed?)",
                   text.contains("\"${kotlinEscape(themeIR)}\""))
        val systemEntry = "\"System\" to \"${kotlinEscape(systemIR)}\""
        if (text.contains("\"System\" to \"")) {
            assertTrue("System fixture drifted from DSXCSSStyles.generated.kt — re-copy it (the generator changed?)",
                       text.contains(systemEntry))
        } else {
            val exclusions = findCanonicalExclusions()
            assertTrue("System is absent but Custom/Demo is not excluded by the active profile",
                       exclusions?.readText()?.contains("\"Custom/Demo\"") == true)
        }
    }

    /** Walk up from the test working dir to the repo root that carries the closed build. */
    private fun findGeneratedRegistry(): File? {
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        repeat(6) {
            val f = File(dir, "ClosedSource/RuntimeAndroid/app/src/generated/kotlin/despia/registry/DSXCSSStyles.generated.kt")
            if (f.isFile) return f
            dir = dir?.parentFile ?: return null
        }
        return null
    }

    /** The active generated profile is the authority for an intentionally absent fixture. */
    private fun findCanonicalExclusions(): File? {
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        repeat(6) {
            val f = File(dir, "ClosedSource/DSX/Modules/Config/excluded.json")
            if (f.isFile) return f
            dir = dir?.parentFile ?: return null
        }
        return null
    }

    /** The generator's kotlin_string escaping (prepare_modules_android.rb) — JSON.generate
     *  output carries no raw control characters, so these three cover every byte. */
    private fun kotlinEscape(s: String) = buildString {
        for (ch in s) when (ch) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '$' -> append("\\$")
            else -> append(ch)
        }
    }
}
