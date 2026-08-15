//
//  DefaultsTokensTest.kt — the SYSTEM-DEFAULTS corpus gate (the Kotlin runner of
//  OpenSource/Conformance/defaults/tokens.json — system-defaults.md), the twin of the
//  web's theme.test.ts drift gate:
//
//   • the ratified vocabulary is PINNED — a word added/removed in StackTheme.M3_ROLES
//     without the corpus (or vice versa) fails;
//   • every word's M3 role NAME must equal the corpus android column exactly;
//   • every role name resolves a real slot on a ColorScheme (roleColor total over the map);
//   • StackStyle.color: with a stamped scheme the semantic words ride the roles; with no
//     scheme the pinned iOS-dark table answers byte-identically to the pre-theme wave —
//     and author literals (white/hex/rgba) NEVER theme (the inert-landing invariant).
//
package despia.engine.render

import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import despia.engine.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File

class DefaultsTokensTest {

    // The corpus sits in the open drop — walk up from the working dir to the repo root
    // (the ElementParityTest convention). Missing corpus = loud failure, never a skip.
    private fun corpusFile(): File {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/defaults/tokens.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
                ?: error("OpenSource/Conformance/defaults/tokens.json not found walking up from ${System.getProperty("user.dir")}")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun corpusTokens(): Map<String, Map<String, Any?>> {
        val root = (json(corpusFile().readText()).foundationValue as? Map<String, Any?>)
            ?: error("tokens.json: not a JSON object")
        return (root["tokens"] as? Map<String, Map<String, Any?>>)
            ?: error("tokens.json: no tokens object")
    }

    private fun argb(c: Color): Int = c.toArgb()

    // ── the vocabulary is pinned (a change here without a spec change is drift) ────────

    @Test fun vocabularyMatchesTheCorpusExactly() {
        val words = corpusTokens().keys
        assertEquals(
            setOf("label", "secondary", "tertiary", "background", "groupedBackground",
                  "secondaryGroupedBackground", "fill", "separator", "accent", "destructive"),
            words)
        assertEquals(words, StackTheme.M3_ROLES.keys)
    }

    // ── every word's role NAME == the corpus android column ────────────────────────────

    @Test fun androidColumnMatchesM3Roles() {
        for ((word, entry) in corpusTokens()) {
            assertEquals("token `$word`", entry["android"] as? String, StackTheme.M3_ROLES[word])
        }
    }

    // ── roleColor is total over the corpus roles, and resolves the REAL scheme slots ──

    @Test fun everyCorpusRoleResolvesOnAScheme() {
        val s = lightColorScheme()
        for ((word, role) in StackTheme.M3_ROLES) {
            assertNotNull("role `$role` (token `$word`) must resolve", StackTheme.roleColor(s, role))
        }
        assertEquals(argb(s.onSurface), argb(StackTheme.roleColor(s, "onSurface")!!))
        assertEquals(argb(s.onSurfaceVariant), argb(StackTheme.roleColor(s, "onSurfaceVariant")!!))
        assertEquals(argb(s.outline), argb(StackTheme.roleColor(s, "outline")!!))
        assertEquals(argb(s.surface), argb(StackTheme.roleColor(s, "surface")!!))
        assertEquals(argb(s.surfaceContainer), argb(StackTheme.roleColor(s, "surfaceContainer")!!))
        assertEquals(argb(s.surfaceContainerHigh), argb(StackTheme.roleColor(s, "surfaceContainerHigh")!!))
        assertEquals(argb(s.surfaceContainerHighest), argb(StackTheme.roleColor(s, "surfaceContainerHighest")!!))
        assertEquals(argb(s.outlineVariant), argb(StackTheme.roleColor(s, "outlineVariant")!!))
        assertEquals(argb(s.primary), argb(StackTheme.roleColor(s, "primary")!!))
        assertEquals(argb(s.error), argb(StackTheme.roleColor(s, "error")!!))
    }

    // ── StackStyle.color under a stamped scheme: semantic words ride the theme roles ──

    @Test fun semanticWordsRideTheStampedScheme() {
        val s = lightColorScheme()
        StackTheme.scheme = s
        try {
            assertEquals(argb(s.onSurface), argb(StackStyle.color("label")))
            assertEquals(argb(s.onSurfaceVariant), argb(StackStyle.color("secondary")))
            assertEquals(argb(s.outline), argb(StackStyle.color("tertiary")))
            assertEquals(argb(s.surface), argb(StackStyle.color("background")))
            assertEquals(argb(s.surfaceContainer), argb(StackStyle.color("groupedBackground")))
            assertEquals(argb(s.surfaceContainerHigh), argb(StackStyle.color("secondaryGroupedBackground")))
            assertEquals(argb(s.surfaceContainerHighest), argb(StackStyle.color("fill")))
            assertEquals(argb(s.outlineVariant), argb(StackStyle.color("separator")))
            assertEquals(argb(s.primary), argb(StackStyle.color("accent")))
            assertEquals(argb(s.error), argb(StackStyle.color("destructive")))
            // the legacy alias spellings ride the corpus words they alias (StackTheme header)
            assertEquals(argb(s.onSurface), argb(StackStyle.color("text")))
            assertEquals(argb(s.onSurfaceVariant), argb(StackStyle.color("secondaryLabel")))
            assertEquals(argb(s.surface), argb(StackStyle.color("systemBackground")))
            assertEquals(argb(s.surfaceContainer), argb(StackStyle.color("secondaryBackground")))
            assertEquals(argb(s.surfaceContainerHigh), argb(StackStyle.color("tertiaryBackground")))
            assertEquals(argb(s.surfaceContainerHigh), argb(StackStyle.color("fillFaint")))
        } finally {
            StackTheme.scheme = null
        }
    }

    // ── theme-less: the pinned iOS-dark table answers, byte-identical to pre-theme ────

    @Test fun themelessFallbackIsThePinnedDarkTable() {
        StackTheme.scheme = null
        assertEquals(argb(Color.White), argb(StackStyle.color("label")))
        assertEquals(argb(Color.Black), argb(StackStyle.color("background")))
        assertEquals(0xFF1C1C1E.toInt(), argb(StackStyle.color("secondaryGroupedBackground")))
        assertEquals(0x5C787880, argb(StackStyle.color("fill")))   // iOS systemFill (dark) — the corpus `fill` slot
        assertEquals(0xA6545458.toInt(), argb(StackStyle.color("separator")))
        assertEquals(0xFFFF453A.toInt(), argb(StackStyle.color("destructive")))   // iOS systemRed (dark)
    }

    // ── author literals NEVER theme (the inert-landing invariant) ─────────────────────

    @Test fun authorLiteralsNeverTheme() {
        StackTheme.scheme = lightColorScheme()
        try {
            assertEquals(argb(Color.White), argb(StackStyle.color("white")))
            assertEquals(argb(Color.Black), argb(StackStyle.color("black")))
            assertEquals(argb(Color.Transparent), argb(StackStyle.color("clear")))
            assertEquals(0xFF112233.toInt(), argb(StackStyle.color("#112233")))
            assertEquals(0x80102030.toInt(), argb(StackStyle.color("rgba(16,32,48,0.5019608)")))
        } finally {
            StackTheme.scheme = null
        }
    }
}
