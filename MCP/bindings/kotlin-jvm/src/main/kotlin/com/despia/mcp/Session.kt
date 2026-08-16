// Despia MCP - the credential holder. The token IS the boundary.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// On-device loopback is reachable by every co-resident app. Nothing about the
// socket keeps another process out; the only thing that does is the value in
// this file. So the rules are stated here, once, and every other file asks this
// one rather than making its own decision:
//
//   * TWO tokens, never the same value. The SESSION token authenticates the
//     app's own surfaces. The PAIRING token is what an external agent host
//     reads out of the discovery file. They are separate so that withdrawing
//     external consent revokes exactly one of them - a single shared token
//     would mean revocation logs the app out of itself.
//   * NEITHER SURVIVES A RESTART. Both are minted from the platform CSPRNG at
//     start, held in memory only, and dropped at stop. A token that outlives
//     the process that minted it is a credential with no expiry story.
//   * MISSING AND WRONG ARE THE SAME ANSWER. `authorize` returns null for both.
//     A caller that could tell them apart has an oracle, and a co-resident app
//     can query an oracle a great many times a second.
//   * COMPARISON IS CONSTANT TIME AND NON-SHORT-CIRCUITING. Both candidates are
//     always compared, even when the first one already matched, because
//     "matched on the first try" is itself a timing signal about which
//     credential a caller holds.
//
// Withdrawal ROTATES rather than merely forgets: a host that cached the pairing
// token must be refused on its next request, and deleting a file it has already
// read would not accomplish that.

package com.despia.mcp

/** Who a request proved itself to be. There is no third answer. */
public enum class McpPrincipal {
    /** The app's own surfaces, holding the session token. */
    session,

    /** An external agent host, holding the pairing token while consent stands. */
    external,
}

/**
 * The tokens for one run of the local server.
 *
 * Every method is synchronized: requests arrive on a worker pool and consent is
 * granted from the UI thread, so the two touch this state concurrently by
 * construction.
 */
public class McpSession {

    private val lock = Any()
    private var session: String? = null
    private var pairing: String? = null

    /** The header scheme, spelled once. */
    public companion object {
        public const val BEARER_PREFIX: String = "Bearer "
    }

    /** True once [start] has minted a session token and [stop] has not run. */
    public val isOpen: Boolean get() = synchronized(lock) { session != null }

    /**
     * The current session token, for the app's own surfaces to present.
     *
     * It is deliberately readable: the in-app web surface and the in-app agent
     * loop both have to send it. What it must never do is travel in a URL, and
     * that is enforced where URLs are built, not by hiding it here.
     */
    public val sessionToken: String? get() = synchronized(lock) { session }

    /** The pairing token, present only while external consent stands. */
    public val pairingToken: String? get() = synchronized(lock) { pairing }

    /** Mints a fresh session token. Any previous one stops working immediately. */
    public fun start(): String = synchronized(lock) {
        val minted = LoopbackTokens.mint()
        session = minted
        minted
    }

    /** Drops both tokens. After this every request is `unauthorized`. */
    public fun stop() {
        synchronized(lock) {
            session = null
            pairing = null
        }
    }

    /**
     * Grants external pairing and returns the token the discovery file carries.
     *
     * Granting twice mints twice. That is not a wasted allocation: re-granting
     * is how a user re-pairs after a host misbehaved, and re-pairing that left
     * the old credential working would be a strange thing to offer.
     */
    public fun grantExternal(): String = synchronized(lock) {
        val minted = LoopbackTokens.mint()
        pairing = minted
        minted
    }

    /**
     * Withdraws external pairing.
     *
     * The token is dropped here; the file is removed by the caller. Both are
     * needed - the file removal is what a user can see, and this is what makes
     * the removal mean something.
     */
    public fun withdrawExternal() {
        synchronized(lock) { pairing = null }
    }

    /**
     * Resolves an `Authorization` header value to a principal, or null.
     *
     * The comparison runs against BOTH tokens with a non-short-circuiting `or`,
     * so the work done is the same whether the caller holds the session token,
     * the pairing token, or nothing at all.
     */
    public fun authorize(authorizationHeader: String?): McpPrincipal? {
        val currentSession: String?
        val currentPairing: String?
        synchronized(lock) {
            currentSession = session
            currentPairing = pairing
        }
        if (currentSession == null) return null
        val presented = bearerValue(authorizationHeader)
        val isSession = LoopbackTokens.constantTimeEquals(currentSession, presented)
        val isPairing = currentPairing != null &&
            LoopbackTokens.constantTimeEquals(currentPairing, presented)
        // `or`, not `||`: the second comparison runs either way.
        if (!(isSession or isPairing)) return null
        return if (isSession) McpPrincipal.session else McpPrincipal.external
    }

    /**
     * The token out of a `Bearer` header, or null.
     *
     * The scheme match is case-insensitive because RFC 7235 says it is, and a
     * transport that answered differently to `bearer` than to `Bearer` would be
     * one more thing an integrator has to discover by failing.
     */
    private fun bearerValue(header: String?): String? {
        val text = header?.trim() ?: return null
        if (text.length <= BEARER_PREFIX.length) return null
        if (!text.regionMatches(0, BEARER_PREFIX, 0, BEARER_PREFIX.length, ignoreCase = true)) return null
        val value = text.substring(BEARER_PREFIX.length).trim()
        return value.ifEmpty { null }
    }
}
