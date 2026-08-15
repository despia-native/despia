//
//  ScreenReadiness.kt — Kotlin twin of Engine/iOS/DSXScreen.swift's `DSXScreenReadiness`.
//
//  The NATIVE screen-readiness reporter — the native sibling of the web surface's PRIVATE
//  `surface.domStart` / `surface.domFinish` relay fires, and the thing that makes "web-optional native runtime"
//  TRUE at runtime instead of only structurally. Before this, only the web surface reported, so a
//  host-less native app never fired `screen.ready` (no page ever loaded) and every consumer of the
//  unified vocabulary — Splash's reveal, ScreenShield, Engagement, PostHog's route tracking — sat
//  waiting forever.
//
//  NINE INPUTS, ONE FUNNEL. The call sites never decide when to fire; this machine does, which IS
//  the once-per-frame guarantee:
//
//      mount(frame, path, surface)   a native frame entered the stack        -> `surface.viewStart`
//      manual(frame)                 its root declared `settle="manual"`     -> (defers the settle)
//      hostsWeb(frame)               it mounted a <DSXWebView/> web surface      -> (defers the settle)
//      rendered(frame)               its FIRST render pass completed         -> `surface.viewFinish` (auto)
//      settled(frame)                it reported readiness itself            -> `surface.viewFinish`
//      deadline(frame)               its bounded settle deadline elapsed     -> `surface.viewFinish` (fail-open)
//      release(frame)                the frame left the stack                -> (drops the record)
//      webStart()                    the app web surface began loading       -> (re-arms the gate)
//      webSettled()                  the app web surface settled             -> `surface.viewFinish` (gated frames)
//
//  THE LAW (corpus `OpenSource/Conformance/lifecycle/readiness.json`, 38 rows):
//   1. only a NATIVE frame is tracked — a `mount` whose surface is not "native" is ignored, so a
//      `DSXWebView` frame never double-reports alongside the relay's `dom*`;
//   2. `mount` fires `surface.viewStart` exactly once per frame INSTANCE and is idempotent while the record
//      lives (a covered screen resurfacing re-runs its mount seam);
//   3. DEFAULT is auto — the frame settles on its first completed render pass;
//   4. OPT-IN is manual — a root declaring `settle="manual"` makes `rendered` emit nothing;
//   5. a frame settles AT MOST ONCE — later `rendered`/`settled`/`manual`/`hostsWeb`/`deadline`
//      inputs are no-ops;
//   6. an explicit `settled` always WINS: it settles an auto frame early and clears a pending
//      `manual` AND a pending `hostsWeb` gate;
//   7. a frame RELEASED before it settled never settles — no late `surface.viewFinish` after the screen is
//      gone, and a re-`mount` of the same id is a fresh instance;
//   8. an input for an unknown/released frame is a silent no-op (Article 7, fail-open);
//   9. HYBRID ORDERING — a native frame hosting a `<DSXWebView/>` app web surface must not report
//      settled while that surface is still blank (Splash would reveal over an empty web view and
//      the page's own `surface.domStart` would re-open the phase a beat later). `hostsWeb` gates it, the
//      surface's own `webSettled()` releases it, and NOTHING about it is author-opt-in — the
//      component registers the gate. `webSettled` LATCHES: a frame that mounts while the page is
//      already up does not wait for a load that will never come, and `webStart` re-arms it. A
//      frame that also declared `manual` keeps its own ownership and `webSettled` skips it;
//  10. BOUNDED FALLBACK (Article 7) — every tracked frame carries a settle DEADLINE
//      (`SETTLE_DEADLINE_MS`), armed by this machine at `mount` and cancelled on settle/release.
//      When it elapses the frame settles anyway, so a `settle="manual"` screen that never calls
//      `dsx.screen.settled()` — or a hosted page that never loads — degrades to a late reveal
//      instead of a PERMANENT `loading` phase (which, on a hybrid app, would also freeze the WEB
//      surface's consumers, since there is ONE shared phase).
//
//  There is deliberately NO `viewFail`: a native frame ALWAYS settles (first render, or its own
//  `dsx.screen.settled()`), so there is no "terminated without finishing" case — `surface.domFail` exists
//  only because a WebViewClient navigation can die mid-flight. A native screen's failure is a value
//  on the ERROR plane (`dsx.error`), never a lifecycle phase.
//
//  The emitted payload is `{ path, surface: "native", frame }` — the relay's `{ url, surface }`
//  shape with `path` because a native frame carries a route path, not a URL. Translation into the
//  unified `screen.loading` / `screen.ready` vocabulary is the Lifecycle coordinator's job
//  (corpus `lifecycle/phase.json`); this object publishes NO state and knows no consumer.
//
//  THREAD MODEL — the twin's "main-thread only", expressed the Kotlin way: every input is a UI
//  seam (a composition, a DisposableEffect, a JSE statement) but Compose effects can land off the
//  main dispatcher in tests, so the record table is guarded by an explicit lock rather than by a
//  thread contract. Behavior is identical; the divergence is a hardening, not a semantic change.
//

package despia.engine

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

object ScreenReadiness {

    /// THE BOUNDED FALLBACK (readiness.json `settleDeadlineMs`, rule 10). Corpus-pinned and
    /// IDENTICAL on all three renderers (TS `SETTLE_DEADLINE_MS`, Swift `settleDeadlineMs`).
    const val SETTLE_DEADLINE_MS: Long = 10_000L

    private class Record(val path: String?) {
        var manual = false
        var hostsWeb = false
        var settled = false
        var cancelDeadline: (() -> Unit)? = null
    }

    private val lock = Any()

    /// One record per LIVE frame id (the Router's `nav.stack` id). Absent = not tracked.
    private val records = LinkedHashMap<Int, Record>()

    /// Has the app web surface settled since its last start? A LATCH, not a counter (rule 9).
    private var webIsSettled = false

    /// The bounded-deadline clock. A single DAEMON thread — it must never hold the process open —
    /// which hands the callback to the main dispatcher through the same `JSE.afterRenderDispatch`
    /// seam every other off-thread engine edge uses, so `surface.viewFinish` reaches Compose state on the
    /// main Looper exactly like the render-side inputs do.
    private val deadlineClock: ScheduledExecutorService by lazy {
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "dsx-screen-deadline").apply { isDaemon = true }
        }
    }

    /// The shipping deadline timer — kept as a named value so a test can restore it verbatim.
    val defaultScheduleDeadline: (Long, () -> Unit) -> (() -> Unit) = { ms, fire ->
        val future = deadlineClock.schedule(
            Runnable { JSE.afterRenderDispatch { fire() } }, ms, TimeUnit.MILLISECONDS
        )
        val cancel: () -> Unit = { future.cancel(false) }
        cancel
    }

    /// The deadline timer seam — swapped by the conformance runner (which drives the `deadline`
    /// step directly) and by any host that owns its own clock. Returns the canceller.
    @Volatile
    var scheduleDeadline: (Long, () -> Unit) -> (() -> Unit) = defaultScheduleDeadline

    /// The WEB-SURFACE TAG REGISTRY — the seam that retired the host's hard-coded
    /// `view == "DSXWebView"` readiness ternary (root-plan.md §capability). A module whose
    /// component hosts a web surface registers ITS OWN tag at setup (Dom does), and the
    /// host derives `surface = "web" | "native"` by membership: the kernel and the host
    /// name nobody, and a future surface kind registers itself the same way.
    val webSurfaceTags: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /// The ROOT-PLAN handshake (root-plan.md): while a boot-plan attempt is live, ITS frame's
    /// bounded settle deadline is suspended — the candidate's own `timeoutMs` is the bounded
    /// fail-open, and a forced 10s "ready" here would defeat any longer surface fallback.
    /// The Router sets this per mount and clears it on `root.ready` / exhaustion; every other
    /// frame keeps the fail-open deadline untouched.
    @Volatile
    var suppressedDeadlineFrame: Int? = null

    /// The emission seam. Defaults to the kernel bus — the SAME way `Source.kt` / `Errors.kt`
    /// fire kernel-owned events (`dsx` is the bus handle for MODULE code; kernel primitives
    /// reach the registry directly). The conformance host swaps it for a capture sink so
    /// `readiness.json` runs against this exact machine.
    @Volatile
    var emit: (String, Map<String, Any?>) -> Unit = { name, payload ->
        ModuleRegistry.shared.dispatch(name, payload, combine = ModuleRegistry.Combine.void)
    }

    /// A native frame entered the stack. Idempotent while the record lives (rule 2); a non-native
    /// surface is dropped outright (rule 1). Arming the bounded deadline HERE (not at the call
    /// site) is what makes the fail-open impossible for a renderer to forget (rule 10).
    fun mount(frame: Int, path: String?, surface: String) {
        if (surface != "native") return
        val started = synchronized(lock) {
            if (records.containsKey(frame)) false
            else {
                val record = Record(path)
                records[frame] = record
                record.cancelDeadline = scheduleDeadline(SETTLE_DEADLINE_MS) { deadline(frame) }
                true
            }
        }
        if (started) emit("surface.viewStart", payload(frame, path))
    }

    /// This frame's root declared `settle="manual"` — it reports readiness itself, so its first
    /// render pass must NOT settle it. Registered between `mount` and the first `rendered`; a
    /// `manual` for an unknown or already-settled frame is a no-op (rules 5, 8).
    fun manual(frame: Int?) {
        if (frame == null) return
        synchronized(lock) {
            val record = records[frame] ?: return
            if (record.settled) return
            record.manual = true
        }
    }

    /// This frame mounted the app's `<DSXWebView/>` web surface (rule 9 — the HYBRID ordering law).
    /// Gated exactly like `manual`, released by `webSettled()`. No gate when the page has ALREADY
    /// settled: the content is on screen, so the frame is free to settle on its first render.
    /// Registered by the COMPONENT, never by the author — this is a regression fix, not a feature.
    fun hostsWeb(frame: Int?) {
        if (frame == null) return
        synchronized(lock) {
            if (webIsSettled) return
            val record = records[frame] ?: return
            if (record.settled) return
            record.hostsWeb = true
        }
    }

    /// The frame completed its FIRST render pass. Settles an AUTO frame; a deferred one waits.
    fun rendered(frame: Int?) {
        if (frame == null) return
        val path = synchronized(lock) {
            val record = records[frame] ?: return
            if (record.settled || record.manual || record.hostsWeb) return
            record.settled = true
            cancelDeadline(record)
            record.path
        }
        emit("surface.viewFinish", payload(frame, path))
    }

    /// The frame reported readiness ITSELF (`dsx.screen.settled()`, or `DSXView` on its
    /// ready/failed outcome). Always wins — settles an auto frame early and clears a pending
    /// manual / hosted gate (rule 6); repeats are no-ops (rule 5).
    fun settled(frame: Int?) {
        if (frame == null) return
        val path = synchronized(lock) {
            val record = records[frame] ?: return
            if (record.settled) return
            record.settled = true
            record.manual = false
            record.hostsWeb = false
            cancelDeadline(record)
            record.path
        }
        emit("surface.viewFinish", payload(frame, path))
    }

    /// The frame's bounded settle deadline elapsed (rule 10) — settle whatever it was waiting for.
    /// Deliberately blind to `manual` / `hostsWeb`: the deadline exists precisely for the screens
    /// those flags would otherwise hold open forever. Released/settled frames are silent no-ops.
    fun deadline(frame: Int?) {
        if (frame == null) return
        if (frame == suppressedDeadlineFrame) return   // a live root-plan attempt owns its own clock
        val path = synchronized(lock) {
            val record = records[frame] ?: return
            if (record.settled) return
            record.settled = true
            record.manual = false
            record.hostsWeb = false
            cancelDeadline(record)
            record.path
        }
        emit("surface.viewFinish", payload(frame, path))
    }

    /// The app web surface began loading (the relay's `surface.domStart`) — re-arms the hosted gate for
    /// frames that mount during this load. Frameless: there is exactly ONE app web surface.
    fun webStart() {
        synchronized(lock) { webIsSettled = false }
    }

    /// The app web surface settled (the relay's `surface.domFinish` OR `surface.domFail` — a failed load is still
    /// settled). Releases every frame gated on it, ascending, so a hybrid app's splash reveals over
    /// the loaded page instead of over a blank web view. A frame that ALSO declared
    /// `settle="manual"` keeps its own ownership and is untouched.
    fun webSettled() {
        val finished = ArrayList<Pair<Int, String?>>()
        synchronized(lock) {
            webIsSettled = true
            for (id in records.keys.sorted()) {
                val record = records[id] ?: continue
                if (record.settled || record.manual || !record.hostsWeb) continue
                record.settled = true
                record.hostsWeb = false
                cancelDeadline(record)
                finished.add(id to record.path)
            }
        }
        for ((id, path) in finished) emit("surface.viewFinish", payload(id, path))
    }

    /// The frame left the stack. Drops the record so no late `surface.viewFinish` can fire, and a re-mount
    /// of the same id starts a fresh instance (rule 7).
    fun release(frame: Int?) {
        if (frame == null) return
        synchronized(lock) { records.remove(frame)?.let { cancelDeadline(it) } }
    }

    /// Frame ids that have started but not settled — the shell is still `loading` for each.
    /// Exposed for the conformance corpus's `expectPending`; no runtime consumer reads it.
    val pendingFrames: List<Int>
        get() = synchronized(lock) { records.filterValues { !it.settled }.keys.sorted() }

    /// Drop every record — the conformance host's per-case reset. Never called by the app.
    fun resetForTesting() {
        synchronized(lock) {
            for (record in records.values) cancelDeadline(record)
            records.clear()
            webIsSettled = false
        }
    }

    /// Spend this record's deadline timer — called under the lock on every settle/release path.
    private fun cancelDeadline(record: Record) {
        val cancel = record.cancelDeadline
        record.cancelDeadline = null
        cancel?.invoke()
    }

    /// `{ path, surface: "native", frame }` — `path` is omitted when the frame carries none, so a
    /// routeless report translates to a null `screen.*` input (phase.json).
    private fun payload(frame: Int, path: String?): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["surface"] = "native"
        out["frame"] = frame
        if (path != null) out["path"] = path
        return out
    }
}
