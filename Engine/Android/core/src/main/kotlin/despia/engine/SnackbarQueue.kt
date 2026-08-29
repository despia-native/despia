package despia.engine

import kotlin.math.max
import kotlin.math.roundToInt

/**
 * SnackbarQueue.kt — the snackbar contract, Kotlin twin.
 *
 * The law and the reasoning live in OpenSource/Conformance/overlays/README.md; the cases live in
 * snackbar.json and run against THIS file (:core SnackbarConformanceTest), against the TS twin
 * (packages/kernel/src/snackbar.ts) and against the Swift twin (Engine/iOS/SnackbarQueue.swift).
 *
 * Everything here is pure: requests and endings in, the visible card / the queue / the
 * settlements out. The surface work — presenting the card, running the timer, reading the insets,
 * animating the swipe — belongs to Core/Toast's kotlin facet. Keeping the decision separate from
 * the plumbing is what lets one corpus judge three runtimes, and is why this lives in :core and
 * runs without an Android SDK.
 */

/** How a snackbar ended. This is what `toast.show` resolves with. */
enum class SnackbarResult(val word: String) {
    DISMISSED("dismissed"),
    ACTION("action"),
    TIMEOUT("timeout"),
    REPLACED("replaced"),
}

enum class SnackbarEdge(val word: String) {
    BOTTOM("bottom"),
    TOP("top"),
}

data class SnackbarAction(val label: String, val id: String)

/** What a caller asked for. */
data class SnackbarRequest(
    val id: String,
    val message: String = "",
    val action: SnackbarAction? = null,
    /** `short` (4s) · `long` (10s) · a NUMBER OF SECONDS (the unit Core/Toast ships). */
    val duration: Any? = null,
    val tone: String? = null,
    val icon: String? = null,
    val position: String? = null,
    val dismissible: Boolean? = null,
    val replace: Boolean = false,
)

/** A normalized card: what the presenter needs and nothing else. */
data class SnackbarEntry(
    val id: String,
    val message: String,
    val action: SnackbarAction?,
    val durationMs: Int,
    val tone: String,
    val icon: String,
    val position: SnackbarEdge,
    val dismissible: Boolean,
)

data class SnackbarSettlement(val id: String, val result: SnackbarResult)

data class SnackbarState(
    /** The card on screen, or null. */
    val current: SnackbarEntry? = null,
    /** Cards waiting, in FIFO order. Never includes [current]. */
    val queue: List<SnackbarEntry> = emptyList(),
    /** Every settlement so far, in the order they happened. */
    val settled: List<SnackbarSettlement> = emptyList(),
) {
    /** Cards waiting behind the visible one — what `toast.queue()` resolves. */
    val pending: Int get() = queue.size
}

sealed interface SnackbarOp {
    data class Show(val request: SnackbarRequest) : SnackbarOp
    object Elapse : SnackbarOp
    object Action : SnackbarOp
    object Dismiss : SnackbarOp
    data class Hide(val id: String? = null) : SnackbarOp
}

object SnackbarQueue {

    /** Material's two words, in milliseconds. */
    const val SHORT_MS: Int = 4000
    const val LONG_MS: Int = 10_000
    /** The duration Core/Toast has shipped since it existed, kept as the wordless default. */
    const val DEFAULT_MS: Int = 2000
    /** A toast nobody can finish reading is not a toast. */
    const val MIN_MS: Int = 1000
    /** A ceiling, so a bad number cannot pin a card to the screen forever (one day). */
    const val MAX_MS: Int = 86_400_000
    /** The inset between the card and whatever is under it. */
    const val GAP: Int = 16
    /** A top-edge card sits closer: it is a banner, not a floating capsule. */
    const val TOP_GAP: Int = 12

    /**
     * How long the card stays up, in milliseconds.
     *
     * The WORDS are Material's. A NUMBER STAYS SECONDS: that is the unit
     * `toast.show({ duration })` has always taken, and redefining it under the same key would
     * halve or double every toast already shipped. An unrecognized word falls back to the default
     * rather than failing a build.
     *
     * The default is the shipped 2s — EXCEPT when the caller supplied an action button, where two
     * seconds is not enough time to notice an Undo and reach it, so `short` takes over.
     */
    fun resolveDuration(duration: Any?, hasAction: Boolean = false): Int {
        val fallback = if (hasAction) SHORT_MS else DEFAULT_MS
        if (duration == null) return fallback
        // A boolean bridges to a number on the native lanes; a `true` duration is nonsense.
        if (duration is Boolean) return fallback
        if (duration is Number) return milliseconds(duration.toDouble(), fallback)
        val word = duration.toString().trim().lowercase()
        if (word == "short") return SHORT_MS
        if (word == "long") return LONG_MS
        if (word.isEmpty()) return fallback
        val seconds = word.toDoubleOrNull() ?: return fallback
        return milliseconds(seconds, fallback)
    }

    /**
     * Seconds to milliseconds, total: NaN and infinity fall back, and the result is clamped into
     * `[MIN_MS, one day]` so no reported number can pin a card to the screen forever.
     */
    private fun milliseconds(seconds: Double, fallback: Int): Int {
        if (seconds.isNaN() || seconds.isInfinite()) return fallback
        val ms = (seconds * 1000).roundToInt()
        return max(MIN_MS, minOf(max(ms, 0), MAX_MS))
    }

    /** The requested edge, normalized. A typo is BOTTOM, never a build failure. */
    fun resolveEdge(position: String?): SnackbarEdge =
        if (position?.trim()?.lowercase() == "top") SnackbarEdge.TOP else SnackbarEdge.BOTTOM

    /** A request, normalized into the card the presenter draws. */
    fun normalize(request: SnackbarRequest): SnackbarEntry {
        val action = request.action?.takeIf { it.label.isNotEmpty() }
        return SnackbarEntry(
            id = request.id,
            message = request.message,
            action = action,
            durationMs = resolveDuration(request.duration, action != null),
            tone = request.tone ?: "default",
            icon = request.icon ?: "",
            position = resolveEdge(request.position),
            dismissible = request.dismissible ?: true,
        )
    }

    private fun settle(state: SnackbarState, entry: SnackbarEntry, result: SnackbarResult): SnackbarState =
        state.copy(settled = state.settled + SnackbarSettlement(entry.id, result))

    /** The visible card ended: record it and promote the head of the queue. */
    private fun promote(state: SnackbarState, result: SnackbarResult): SnackbarState {
        val current = state.current ?: return state
        val after = settle(state, current, result)
        return after.copy(current = after.queue.firstOrNull(), queue = after.queue.drop(1))
    }

    /**
     * The whole queue, in one reducer.
     *
     * ONE AT A TIME, FIFO. Stacking snackbars is how a bottom sheet becomes unreachable, so a
     * second `show` waits its turn — unless it asks to `replace`, which settles the visible card
     * as REPLACED and takes its place. Replace is a SWAP, not a reset: the cards already waiting
     * keep waiting, because the caller asked to change what is on screen, not to cancel a backlog.
     *
     * Every card settles EXACTLY ONCE, which is what makes `show` resolvable on outcome: an
     * awaited `show` that never settles is a leaked promise, and one that settles twice is a
     * double undo.
     */
    fun applyOp(state: SnackbarState, op: SnackbarOp): SnackbarState = when (op) {
        is SnackbarOp.Show -> {
            val entry = normalize(op.request)
            when {
                // The shipped rule, kept: an empty message is a no-op, not an empty card.
                entry.message.isEmpty() -> state
                state.current == null -> state.copy(current = entry)
                op.request.replace -> settle(state, state.current, SnackbarResult.REPLACED).copy(current = entry)
                else -> state.copy(queue = state.queue + entry)
            }
        }
        SnackbarOp.Elapse -> promote(state, SnackbarResult.TIMEOUT)
        // A tap on a button that is not there is not an outcome.
        SnackbarOp.Action -> if (state.current?.action == null) state else promote(state, SnackbarResult.ACTION)
        // A swipe obeys `dismissible`; see Hide for the API route that does not.
        SnackbarOp.Dismiss -> if (state.current?.dismissible != true) state else promote(state, SnackbarResult.DISMISSED)
        is SnackbarOp.Hide -> {
            val id = op.id ?: ""
            if (id.isEmpty() || state.current?.id == id) {
                // `hide()` is an API call, not a gesture: it settles a non-dismissible card too.
                if (state.current == null) state else promote(state, SnackbarResult.DISMISSED)
            } else {
                val queued = state.queue.firstOrNull { it.id == id }
                if (queued == null) {
                    state
                } else {
                    settle(state, queued, SnackbarResult.DISMISSED)
                        .let { it.copy(queue = it.queue.filterNot { e -> e.id == id }) }
                }
            }
        }
    }

    data class Chrome(
        val position: String? = null,
        val safeAreaTop: Int = 0,
        val safeAreaBottom: Int = 0,
        /** A tab bar / bottom navigation, 0 when there is none. */
        val bottomBar: Int = 0,
        /** The height a floating action button occupies above the bar, 0 when there is none. */
        val fab: Int = 0,
        /** What the soft keyboard covers of the layout viewport. */
        val keyboard: Int = 0,
    )

    data class Lift(
        val edge: SnackbarEdge,
        /** Points from that edge to the near side of the card. */
        val inset: Int,
        /** The invariant, reported rather than assumed. */
        val clearsHomeIndicator: Boolean,
    )

    private fun positive(n: Int): Int = if (n > 0) n else 0

    /**
     * Where the card sits.
     *
     * The keyboard, when it is up, IS the obstruction: it already covers the bottom bar, the FAB
     * and the safe area, so adding them would push the card into the middle of the screen.
     * Otherwise the obstruction is the safe area plus the bar plus whatever the FAB occupies above
     * it. The GAP goes on top of whichever won.
     *
     * THE INVARIANT: the bottom inset is never less than the safe-area inset plus the gap, so no
     * geometry a platform reports — including nonsense from a rotation race — can put the card on
     * the home indicator.
     */
    fun resolveLift(chrome: Chrome): Lift {
        val edge = resolveEdge(chrome.position)
        val safeBottom = positive(chrome.safeAreaBottom)
        if (edge == SnackbarEdge.TOP) {
            return Lift(edge, positive(chrome.safeAreaTop) + TOP_GAP, clearsHomeIndicator = true)
        }
        val keyboard = positive(chrome.keyboard)
        val chromeStack = safeBottom + positive(chrome.bottomBar) + positive(chrome.fab)
        val obstruction = if (keyboard > 0) max(keyboard, safeBottom) else chromeStack
        val inset = obstruction + GAP
        return Lift(edge, inset, clearsHomeIndicator = inset >= safeBottom + GAP)
    }
}
