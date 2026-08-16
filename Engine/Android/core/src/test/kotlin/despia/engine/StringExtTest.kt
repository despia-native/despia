package despia.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class StringExtTest {

    // MARK: trim

    @Test fun trimStripsWhitespaceAndNewlines() {
        assertEquals("a b", " \n\t a b \r\n ".trim())
        assertEquals("x", "x".trim())
        assertEquals("", "  \n\t  ".trim())
        assertEquals("", "".trim())
    }

    // MARK: makeURL

    @Test fun makeURLParsesAPlainURL() {
        val url = "https://despia.com/path?q=1".makeURL()
        assertNotNull(url)
        assertEquals("https", url.scheme)
        assertEquals("despia.com", url.host)
        assertEquals("/path", url.path)
        assertEquals("q=1", url.query)
    }

    @Test fun makeURLParsesACustomScheme() {
        // The reason for java.net.URI over java.net.URL: no registered stream handler needed.
        val url = "despia://module/action".makeURL()
        assertNotNull(url)
        assertEquals("despia", url.scheme)
    }

    @Test fun makeURLPercentEncodesSpaces() {
        assertEquals("https://x.io/a%20b", "https://x.io/a b".makeURL().toString())
    }

    @Test fun makeURLEncodesUTF8BytesOfNonASCII() {
        assertEquals("https://x.io/%C3%A9", "https://x.io/é".makeURL().toString())
    }

    @Test fun makeURLReencodesAnExistingPercent() {
        // Faithful to Swift: "%" is outside .urlQueryAllowed, so pre-encoded input is re-encoded.
        assertEquals("https://x.io/a%2520b", "https://x.io/a%20b".makeURL().toString())
    }

    @Test fun makeURLEncodesTheHash() {
        // "#" is outside .urlQueryAllowed too — the fragment marker is escaped, as on iOS.
        assertEquals("https://x.io/p%23f", "https://x.io/p#f".makeURL().toString())
    }

    @Test fun makeURLAcceptsARelativeString() {
        assertEquals("foo%20bar", "foo bar".makeURL().toString())
    }

    @Test fun makeURLOfEmptyStringIsNull() {
        assertNull("".makeURL())   // Swift: URL(string: "") is nil
    }

    // MARK: length — fulfilled by the built-in String.length member (see StringExt.kt header)

    @Test fun lengthIsTheBuiltInMember() {
        assertEquals(3, "abc".length)
        assertEquals(0, "".length)
    }
}
