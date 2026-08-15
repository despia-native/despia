// TokensTest - the token is the boundary, so its two properties are asserted.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// A comparison cannot be timed reliably in a unit test, so what is asserted here
// is the part that can be: the comparison never returns early on a length or a
// value, and it answers the same way for a missing token and a wrong one.

package com.despia.mcp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TokensTest {

    @Test
    fun `a minted token is 256 bits and URL-safe`() {
        val token = LoopbackTokens.mint()

        // 32 bytes, base64 without padding, so it survives being pasted into a
        // header, a config file or a shell argument unescaped.
        assertEquals(43, token.length)
        assertTrue(token.all { it.isLetterOrDigit() || it == '-' || it == '_' }, "not URL-safe: $token")
    }

    @Test
    fun `two tokens are never the same`() {
        val tokens = (1..64).map { LoopbackTokens.mint() }.toSet()

        assertEquals(64, tokens.size)
    }

    @Test
    fun `a token shorter than 256 bits is refused at the mint`() {
        assertFailsWith<IllegalArgumentException> { LoopbackTokens.mint(16) }
    }

    @Test
    fun `comparison accepts only the exact value`() {
        val token = LoopbackTokens.mint()

        assertTrue(LoopbackTokens.constantTimeEquals(token, token))
        assertTrue(LoopbackTokens.constantTimeEquals(token, String(token.toCharArray())))
        assertFalse(LoopbackTokens.constantTimeEquals(token, token.dropLast(1) + "x"))
        assertFalse(LoopbackTokens.constantTimeEquals(token, "x" + token.drop(1)))
    }

    @Test
    fun `a prefix, a longer value and a missing value all fail the same way`() {
        val token = LoopbackTokens.mint()

        assertFalse(LoopbackTokens.constantTimeEquals(token, token.take(20)))
        assertFalse(LoopbackTokens.constantTimeEquals(token, token + "extra"))
        assertFalse(LoopbackTokens.constantTimeEquals(token, ""))
        assertFalse(LoopbackTokens.constantTimeEquals(token, null))
        assertFalse(LoopbackTokens.constantTimeEquals(null, token))
        assertFalse(LoopbackTokens.constantTimeEquals(null, null))
    }
}
