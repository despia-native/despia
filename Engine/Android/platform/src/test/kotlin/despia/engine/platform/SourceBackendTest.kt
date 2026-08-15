package despia.engine.platform

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceBackendTest {
    @Test fun sourceInstantsAcceptTheKernelShapeAndLegalOffsets() {
        assertTrue(isParseableSourceInstant("2026-08-09T01:02:03Z"))
        assertTrue(isParseableSourceInstant("2026-08-09T01:02:03.123456789Z"))
        assertTrue(isParseableSourceInstant("2026-08-09T01:02:03+04:00"))
        assertTrue(isParseableSourceInstant("2026-08-09T01:02:03-18:00"))
    }

    @Test fun sourceInstantsRejectInvalidDatesPrecisionAndOffsets() {
        assertFalse(isParseableSourceInstant("2026-02-30T01:02:03Z"))
        assertFalse(isParseableSourceInstant("2026-08-09T24:02:03Z"))
        assertFalse(isParseableSourceInstant("2026-08-09T01:02:03.1234567890Z"))
        assertFalse(isParseableSourceInstant("2026-08-09T01:02:03+18:01"))
        assertFalse(isParseableSourceInstant("not-an-instant"))
    }
}
