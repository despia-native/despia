package despia.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// Conformance tests for DSXPathMatch — behavior pinned to DSXPathMatch.swift.
class PathMatchTest {

    // -- literal --

    @Test fun literalMatchReturnsEmptyParams() {
        assertEquals(emptyMap(), DSXPathMatch.match("/users/list", "/users/list"))
    }

    @Test fun literalMismatchReturnsNull() {
        assertNull(DSXPathMatch.match("/users/list", "/users/detail"))
    }

    @Test fun rootMatchesRoot() {
        assertEquals(emptyMap(), DSXPathMatch.match("/", "/"))
    }

    // -- {param} --

    @Test fun bracedParamExtractsOneSegment() {
        assertEquals(mapOf("id" to "42"), DSXPathMatch.match("/users/42", "/users/{id}"))
    }

    @Test fun bracedParamDoesNotSpanSegments() {
        assertNull(DSXPathMatch.match("/users/42/posts", "/users/{id}"))
    }

    // -- :param --

    @Test fun colonParamExtractsOneSegment() {
        assertEquals(mapOf("slug" to "hello"), DSXPathMatch.match("/blog/hello", "/blog/:slug"))
    }

    @Test fun mixedParamStylesExtractTogether() {
        assertEquals(
            mapOf("id" to "42", "pid" to "7"),
            DSXPathMatch.match("/users/42/posts/7", "/users/{id}/posts/:pid"),
        )
    }

    // -- * (one segment, mid-path) --

    @Test fun midStarMatchesExactlyOneSegment() {
        assertEquals(emptyMap(), DSXPathMatch.match("/a/b/c", "/a/*/c"))
        assertNull(DSXPathMatch.match("/a/c", "/a/*/c"))       // '*' must consume a segment
        assertNull(DSXPathMatch.match("/a/b/x", "/a/*/c"))     // tail still literal
    }

    @Test fun midStarExtractsNoParams() {
        assertEquals(emptyMap(), DSXPathMatch.match("/a/anything/c", "/a/*/c"))
    }

    // -- catch-all --

    @Test fun bareStarMatchesAnything() {
        assertEquals(emptyMap(), DSXPathMatch.match("/any/thing/at/all", "*"))
        assertEquals(emptyMap(), DSXPathMatch.match("/any/thing", "/*"))
        assertEquals(emptyMap(), DSXPathMatch.match("/", "*"))
    }

    @Test fun emptyPatternIsCatchAll() {
        assertEquals(emptyMap(), DSXPathMatch.match("/whatever", ""))
    }

    @Test fun trailingStarSoaksRemainingSegments() {
        assertEquals(emptyMap(), DSXPathMatch.match("/files/a/b/c", "/files/*"))
    }

    @Test fun trailingStarMatchesZeroRemainingSegments() {
        // Pinned Swift behavior: the trailing '*' returns without requiring a segment.
        assertEquals(emptyMap(), DSXPathMatch.match("/files", "/files/*"))
    }

    @Test fun trailingStarKeepsEarlierParams() {
        assertEquals(mapOf("id" to "9"), DSXPathMatch.match("/u/9/deep/er", "/u/{id}/*"))
    }

    @Test fun trailingStarStillRequiresThePrefix() {
        assertNull(DSXPathMatch.match("/other/a/b", "/files/*"))
    }

    // -- trailing slash --

    @Test fun trailingSlashIsIgnoredOnBothSides() {
        assertEquals(emptyMap(), DSXPathMatch.match("/users/list/", "/users/list"))
        assertEquals(emptyMap(), DSXPathMatch.match("/users/list", "/users/list/"))
        assertEquals(mapOf("id" to "42"), DSXPathMatch.match("/users/42/", "/users/{id}/"))
    }

    // -- non-match by shape --

    @Test fun pathLongerThanPatternFails() {
        assertNull(DSXPathMatch.match("/a/b/c", "/a/b"))
    }

    @Test fun pathShorterThanPatternFails() {
        assertNull(DSXPathMatch.match("/a", "/a/b"))
        assertNull(DSXPathMatch.match("/a", "/a/{id}"))
    }

    // -- query / hash stripping --

    @Test fun queryAndHashAreStripped() {
        assertEquals(mapOf("id" to "42"), DSXPathMatch.match("/users/42?tab=posts", "/users/{id}"))
        assertEquals(mapOf("id" to "42"), DSXPathMatch.match("/users/42#top", "/users/{id}"))
        assertEquals(mapOf("id" to "42"), DSXPathMatch.match("/users/42?tab=posts#top", "/users/{id}"))
        assertEquals(emptyMap(), DSXPathMatch.match("/a", "/a?ignored=1"))
    }

    // -- matches() convenience --

    @Test fun matchesMirrorsMatch() {
        assertTrue(DSXPathMatch.matches("/users/42", "/users/{id}"))
        assertTrue(DSXPathMatch.matches("/anything", "*"))
        assertFalse(DSXPathMatch.matches("/users/42/extra", "/users/{id}"))
    }
}
