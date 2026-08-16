package despia.engine

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * StackSurface — the held-surface stores' release contract (Router.kt §StackSurface, the
 * Stack.swift releasePushed/releaseModal twin). Pins the `deferRemoval` seam: teardown fires
 * immediately (iOS order), the DEFAULT removal is inline (a bare kernel must not change), and
 * a host-wired deferral keeps the handle renderable for the exit transition while preserving
 * the at-most-once teardown guarantee.
 */
class StackSurfaceTest {

    private val pops = mutableListOf<Int>()
    private val dismisses = mutableListOf<Int>()

    @BeforeEach fun fresh() {
        StackSurface.pushedFrames.clear()
        StackSurface.modalFrames.clear()
        StackSurface.releasing.clear()
        StackSurface.onPop = { id, _ -> pops.add(id) }
        StackSurface.onDismiss = { id, _ -> dismisses.add(id) }
    }

    @AfterEach fun teardown() {
        StackSurface.deferRemoval = { it() }
        StackSurface.onPop = { _, _ -> }
        StackSurface.onDismiss = { _, _ -> }
        StackSurface.coverPresenter = null
        StackSurface.pushedFrames.clear()
        StackSurface.modalFrames.clear()
        StackSurface.releasing.clear()
    }

    // ── the default: inline removal — today's bare-kernel behavior, byte-for-byte ────────

    @Test fun defaultReleaseRemovesInline() {
        StackSurface.pushedFrames[1] = "SURFACE"
        StackSurface.releasePushed(1)
        assertEquals(listOf(1), pops)                          // teardown ran
        assertTrue(StackSurface.pushedFrames.isEmpty())        // handle freed immediately
        assertTrue(StackSurface.releasing.isEmpty())           // nothing left pending
    }

    @Test fun defaultModalReleaseRemovesInline() {
        StackSurface.modalFrames[2] = "SURFACE"
        StackSurface.releaseModal(2)
        assertEquals(listOf(2), dismisses)
        assertTrue(StackSurface.modalFrames.isEmpty())
        assertTrue(StackSurface.releasing.isEmpty())
    }

    // ── the host-wired deferral: teardown NOW, the handle lingers for the exit render ────

    @Test fun deferredReleaseKeepsTheHandleUntilTheHostRuns() {
        val pending = mutableListOf<() -> Unit>()
        StackSurface.deferRemoval = { pending.add(it) }
        StackSurface.modalFrames[7] = "SURFACE"
        StackSurface.releaseModal(7)
        assertEquals(listOf(7), dismisses)                     // teardown fired immediately (iOS order)
        assertEquals("SURFACE", StackSurface.modalFrames[7])   // still renderable on the way out
        pending.forEach { it() }                               // the host's 0.6s post lands
        assertTrue(StackSurface.modalFrames.isEmpty())
        assertTrue(StackSurface.releasing.isEmpty())
    }

    @Test fun teardownFiresAtMostOnceWhileRemovalIsPending() {
        val pending = mutableListOf<() -> Unit>()
        StackSurface.deferRemoval = { pending.add(it) }
        StackSurface.pushedFrames[3] = "SURFACE"
        StackSurface.releasePushed(3)
        StackSurface.releasePushed(3)                          // double-release during the hold
        assertEquals(listOf(3), pops)                          // onPop once — Swift's nil-the-callback twin
        pending.forEach { it() }
        assertTrue(StackSurface.pushedFrames.isEmpty())
        StackSurface.releasePushed(3)                          // and idempotent after removal too
        assertEquals(listOf(3), pops)
    }

    @Test fun deferredModalDoubleReleaseFiresOnDismissOnce() {
        val pending = mutableListOf<() -> Unit>()
        StackSurface.deferRemoval = { pending.add(it) }
        StackSurface.modalFrames[4] = "SURFACE"
        StackSurface.releaseModal(4)
        StackSurface.releaseModal(4)
        assertEquals(listOf(4), dismisses)
        pending.forEach { it() }
        assertTrue(StackSurface.modalFrames.isEmpty())
    }

    // ── the native-frame cover seam (coverPresenter — the module full-screen-cover shape) ─

    @Test fun coverSeamDefaultsToNotInstalled() {
        // No presenter installed → null: the module keeps its hand-rolled content-frame
        // attach (the pinned module-side default) — a bare kernel changes nothing.
        assertEquals(null, StackSurface.presentCover("HOST", "VIEW"))
    }

    @Test fun installedCoverPresenterReceivesBothHandlesAndReturnsItsDismiss() {
        val seen = mutableListOf<Pair<Any, Any>>()
        var dismissed = 0
        StackSurface.coverPresenter = { host, view ->
            seen.add(host to view)
            ({ dismissed += 1 })
        }
        val dismiss = StackSurface.presentCover("HOST", "VIEW")
        assertEquals(listOf<Pair<Any, Any>>("HOST" to "VIEW"), seen)   // opaque handles, verbatim
        dismiss?.invoke()
        assertEquals(1, dismissed)                                     // the presenter's own dismiss
    }

    @Test fun decliningCoverPresenterSendsTheCallerToItsFallback() {
        StackSurface.coverPresenter = { _, _ -> null }                 // installed but declines
        assertEquals(null, StackSurface.presentCover("HOST", "VIEW"))
    }

    // ── unknown ids: a documented no-op, never a crash ───────────────────────────────────

    @Test fun releaseOfAnUnknownIdIsANoOp() {
        StackSurface.releasePushed(99)
        StackSurface.releaseModal(99)
        assertTrue(pops.isEmpty())
        assertTrue(dismisses.isEmpty())
        assertTrue(StackSurface.releasing.isEmpty())
    }
}
