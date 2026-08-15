//
//  Router.swift — the KERNEL navigation runtime (the `route` scheme).
//
//  Navigation is a KERNEL PRIMITIVE, not a removable capability — every major framework owns its
//  Navigator (SwiftUI NavigationStack, UIKit UINavigationController, Flutter Navigator, React
//  Navigation). So `route` lives in the kernel and is ALWAYS present. It owns the nav STATE
//  (`global.nav.stack`, mirrored to `global.route`), the STACK verbs (push / pop / replace / reset),
//  the path → screen RESOLUTION (match the route table with a capability gate, else the configured
//  fallback — App.json `entry.fallback`), and the route.path OBSERVER (a plain `route.path` write
//  navigates). The kernel host (RouterHost) RENDERS this stack; DSXView renders each native screen.
//
//  The route TABLE has two sources, one grammar (the unified routes.json every renderer consumes —
//  /web/04-routing.md): the BUNDLED floor (`routes.json` shipped in the binary beside App.json —
//  AppManifest.bundledRoutesText; offline, day-one, no package needed) and the OTA plane (the
//  removable Routing package fetches and writes `global.routes`; a published table always wins).
//  A table entry's `component` mounts the NAMED native screen for its path — params + query become
//  the screen's vars, its bar seeds at push time — and `meta.title` titles the system bar for
//  pushed WEB frames (else a path-derived title), so a pushed web path is never a bar-less trap.
//  No table at all → every path resolves to the configured fallback. The Routing package triggers
//  a re-resolve through `route.sync` and a refetch through the `route.refresh` event.
//
//  THE LOAD GATE. Reading the remote table is the one place the engine trusts remote bundle content,
//  so the read goes through `trustedRoutes(forPath:)` → `RemoteBundleGate`: with bundle-signing ON
//  (App.json `bundle_signing`), an unverified manifest yields an EMPTY table (every path → fallback)
//  instead of rendering unsigned remote routes. OFF by default ⇒ unchanged. See
//  OpenSource/Skills/security.md and OpenSource/Documentation/architecture/remote-bundle-signing.md.
//
//  Kernel deps only (DSX.state, DSXPathMatch, AppManifest, RemoteBundleGate) — no package dependency,
//  so it ships in the floor. It uses the Module mechanism to own its `route` scheme + lifecycle bus.
//

import Foundation
import Combine
import SwiftUI   // Transaction/withTransaction — the reduced-motion commit below
import UIKit

final class Router: Module {
    override class var scheme: String { "route" }
    // Navigation is a kernel primitive and RouterHost can be the first visible frame. Register
    // its action/listener-only setup in the boot tier so the host never observes an absent
    // Router between the synchronous registry walk and deferred feature-SDK bootstrap.
    override class var bootEligible: Bool { true }

    /// The kernel host (`RouterHost`) reaches the runtime through this to report a back-swipe pop —
    /// kernel-internal (the Router and its host are one subsystem, like `DSX.state`). Weak; set in setup().
    static weak var shared: Router?

    private var cancellable: AnyCancellable?
    private var lastResolvedPath: String?
    private var publishing = false     // true while apply() is mid-publish — the path observer stands down (see resolveIfPathChanged)
    private var stack: [[String: Any]] = []   // the navigation back-stack (root … top); top == global.route
    private var modal: [[String: Any]] = []   // the presented-modal stack, published as global.nav.modal (state-backed present)
    private var frameSeq = 0                   // monotonic frame ids (stable render-surface store keys)
    private var chrome: [String: [String: Any]] = [:]   // frameId → system nav-bar spec, published as global.nav.chrome
    private var chromeGrace: Set<String> = []            // popped frames whose spec survives the exit animation — see apply()
    private var chromeMemory: [String: [String: Any]] = [:]   // component name → its last LIVE claim (reopen hints — see chromeHint)
    private var echoMemo: (key: String, at: Date)?   // the DOUBLE-TAP echo guard memo — see isEcho()

    override func setup() {
        Self.shared = self                       // let the kernel host (RouterHost) report back-swipe pops
        // Navigation API — the stack is state. Real-JS package form:
        //   route.push({ path: '/cart' })   grow history (slide in, back enabled)
        //   route.pop()                      back (slide out)
        //   route.popTo({ path: '/cart' })   back to the deepest matching frame (ONE transition,
        //                                    not N pops — RN popTo / Flutter popUntil parity)
        //   route.popToRoot()                back to the root frame (RN popToTop)
        //   route.replace({ path: '/x' })    swap the top, no history growth
        //   route.reset({ path: '/home' })   clear to a single root (tab switch / post-login)
        // `route.path = '/x'` (web despia.navigate / native `set: route.path = …`) stays a REPLACE.
        dsx.action("push")    { [weak self] c in self?.push((c.args("path") as? String) ?? "/"); c.resolve() }
        dsx.action("pop")     { [weak self] c in self?.pop(); c.resolve() }
        dsx.action("popTo")   { [weak self] c in self?.popTo((c.args("path") as? String) ?? ""); c.resolve() }
        dsx.action("popToRoot") { [weak self] c in self?.popToRoot(); c.resolve() }
        dsx.action("replace") { [weak self] c in self?.replace((c.args("path") as? String) ?? "/"); c.resolve() }
        dsx.action("reset")   { [weak self] c in self?.reset((c.args("path") as? String) ?? "/"); c.resolve() }
        // The OTA package calls this after it writes a fresh `global.routes` → re-resolve the
        // live frame against the new table (keeps the frame id when the mapping is unchanged).
        dsx.action("sync")    { [weak self] c in self?.resolveCurrent(); c.resolve() }
        // the route package's `reload` action → ask whoever owns the table to refetch (the OTA package hooks this).
        dsx.action("reload")  { [weak self] c in self?.dsx.delegate.send("route.refresh", combine: .void); c.resolve() }

        // Component presentation — open a component (by name) as a native nav FRAME (push) or a
        // state-backed MODAL (present), or DISMISS the top modal. These are the kernel `route` verbs
        // behind the public `dsx.component.push/present/dismiss` sugar (native + markup) AND the web
        // bridge (`window.despia.route.{pushComponent,presentComponent,dismiss}`). The component is
        // resolved in the caller's `scope` (passed explicitly — the kernel names nobody); a call with
        // no `scope` (web / cross-package) resolves the tag globally / by its `namespace.Name` qualifier.
        dsx.action("pushComponent")    { [weak self] c in
            self?.pushComponent(name: (c.args("component") as? String) ?? "",
                                scope: c.args("scope") as? String,
                                path: (c.args("path") as? String) ?? "",
                                vars: c.args("vars") as? [String: Any],
                                attrs: c.args("attrs") as? [String: Any]); c.resolve() }
        dsx.action("presentComponent") { [weak self] c in
            self?.presentComponent(name: (c.args("component") as? String) ?? "",
                                   scope: c.args("scope") as? String,
                                   mode: (c.args("as") as? String) ?? "sheet",
                                   vars: c.args("vars") as? [String: Any],
                                   detents: c.args("detents") as? [String],
                                   touch: c.args("touch") as? String,
                                   attrs: c.args("attrs") as? [String: Any]); c.resolve() }
        dsx.action("updateComponent")  { [weak self] c in
            self?.updateComponent(target: (c.args("target") as? String) ?? (c.args("component") as? String),
                                  attrs: (c.args("attrs") as? [String: Any]) ?? [:]); c.resolve() }
        dsx.action("dismiss")          { [weak self] c in self?.dismissModal(target: c.args("target") as? String); c.resolve() }

        // SYSTEM CHROME — a screen claims the REAL navigation bar for its frame (the host shows
        // `.navigationTitle` + the system back button; on iOS 26 the bar is Liquid Glass for free).
        // Called from markup on mount (Foundation's <NavBar system="true"> does) — navigation is
        // state, so the spec rides `global.nav.chrome` keyed by frame id and is pruned with the
        // stack (apply()). `show:"false"` releases the claim (back to hidden bar).
        // TARGETING: a claim names its OWN frame via the `__frame` framing key (the statement
        // runner stamps every markup package call with the calling surface's frame id — see
        // StackStore.frameId). SwiftUI re-fires `on:appear` when a covered screen resurfaces
        // during an interactive back-swipe, so targeting the TOP frame let a re-appearing
        // launcher restyle the OUTGOING screen's bar mid-gesture — the wrong-title /
        // large-title-flip / bar-flash trio. A stamped id that's no longer in the stack (a
        // popped frame's late claim, a SHEET surface's NavBar) is DROPPED: modal chrome must
        // never restyle the app bar beneath it. No stamp (a web caller, a mounted overlay)
        // keeps the previous top-frame behavior.
        // Flags accept BOTH spellings: markup sends strings (the attribute wire shape), a JS
        // caller sends real booleans — `large: true` must never read as a small bar (web parity).
        dsx.action("chrome") { [weak self] c in
            guard let self else { c.resolve(); return }
            let claimed = c.args("__frame").flatMap(NavFrame.intId)
            let frame = claimed == nil
                ? self.stack.last
                : self.stack.first(where: { $0["id"].flatMap(NavFrame.intId) == claimed })
            if let frame, let id = frame["id"] {
                if (c.args("show") as? String) == "false" || (c.args("show") as? Bool) == false {
                    self.chrome["\(id)"] = nil
                    if let comp = frame["component"] as? String { self.chromeMemory[comp] = nil }
                } else {
                    let spec: [String: Any] = ["title": (c.args("title") as? String) ?? "",
                                               "large": (c.args("large") as? String) == "true"
                                                        || (c.args("large") as? Bool) == true]
                    self.chrome["\(id)"] = spec
                    // Remember the LIVE claim by component name: the next push of this component
                    // seeds its bar from frame ONE (chromeHint), so even a dynamic title only
                    // ever arrives late on the component's very first open in a session.
                    if let comp = frame["component"] as? String { self.chromeMemory[comp] = spec }
                }
                self.apply()
            }
            c.resolve()
        }

        // Boot the nav runtime when this package is present (it's removable — a pure web app excludes
        // it). It seeds nav.stack + observes route.path; harmless if the root renderer isn't the route
        // surface (the stack just goes unrendered). NOT gated on OTA: navigation works without a table
        // (route.path writes navigate; unmatched paths fall to the configured fallback). The Routing
        // package, if present, fills `global.routes`.
        dsx.delegate.listen("lifecycle.launch") { [weak self] _ in
            self?.boot()
            return nil
        }
    }

    // MARK: boot + observe

    private func boot() {
        if DSX.state.getPath("route.path") == nil { DSX.state.setPath("route.path", AppManifest.entry.root) }
        // SEED BEFORE OBSERVING: the state publisher replays the current value on subscribe,
        // so observing an unseeded runtime would let that replay replace() into an empty stack
        // (the Kotlin twin's inline sink actually hit this; iOS's deferred sink merely made it
        // latent). Seeded + applied first, the replay sees path == lastResolvedPath and no-ops.
        let path = (DSX.state.getPath("route.path") as? String) ?? "/"
        // THE ROOT PLAN (root-plan.md; corpus `Conformance/router/root-plan.json`) — the ordered
        // first-ready fold over `App.json entry.surfaces` that RETIRED the two-arm
        // `bootsToEntryFallback` rule: no source decision, no web floor — the app's candidates
        // own the root, in array order. Each candidate mounts as the root frame and races frame
        // settle (`screen.ready`) vs a root-attributed `dsx.error` vs its `timeoutMs`; failure
        // always advances; an exhausted plan fires `root.exhausted` and the host shows the boot
        // diagnostic. Route rows with no `view` follow the BOOT WINNER (resolved()).
        // NOT cleared on a re-boot: `frameSeq` is monotonic and never reused, so the PREVIOUS
        // plan's frames must stay bound. Clearing would downgrade them from "stale, drop" to
        // "unmapped, settle the live attempt" — and retryRootPlan() is reached only from the
        // exhaustion diagnostic, i.e. exactly when a failed run's frames are still registered and
        // can still fire a late deadline (root-plan.md §5). But the STORED value is an attempt
        // index, which is meaningful only inside ONE fold: a retry restarts `live` at 0, so a
        // dead run's frame bound to 0 would then EQUAL the live index and crown the retry's
        // candidate on a corpse's signal. Entries are therefore stamped with the boot generation
        // and a foreign generation resolves to staleAttempt — kept and dropped, never aliased.
        rootBootGeneration += 1
        rootFramelessAttempt = nil
        let fold = RootPlan.Fold(plan: AppManifest.entry.surfaces, host: RootPlan.Host(
            mount: { [weak self] candidate, index in
                guard let self else { return }
                // RETIRE THE PREVIOUS CANDIDATE'S READINESS *before* the new frame exists.
                // `screen.ready` is LEVEL-triggered state, and the observe() sink reads the
                // level — so a `true` left standing by the candidate that just failed would
                // crown its successor in the same sink pass, before that successor rendered a
                // pixel (its own timeoutMs never applying). The new frame republishes through
                // viewStart/viewFinish like any other. Ordered ahead of `apply()` so a
                // synchronous first render's real `true` lands after this, not under it.
                DSX.state.setPath("screen.ready", false)
                self.stack = [self.candidateEntry(path, candidate)]
                self.apply()
                // The candidate's own timeoutMs is the bounded fail-open for the boot attempt —
                // suspend the frame's readiness deadline or it would force a fail-open "ready"
                // and defeat any longer surface fallback (RootPlan.swift header).
                let frame = self.stack.first?["id"].flatMap(NavFrame.intId)
                DSXScreenReadiness.suppressedDeadlineFrame = frame
                // BIND THE FRAME TO THE ATTEMPT. Readiness reports name their frame
                // (`screen.frame`), so the observe sink below can tell WHOSE settle it is
                // reading off the level. Frame ids are monotonic and never reused, so a
                // report from a retired candidate's frame resolves to ITS index and the fold
                // drops it as stale instead of crowning whoever is live now — retiring
                // `screen.ready` above closes the common race, this closes the rest.
                // ONLY the root frame: `stack` was replaced with exactly this candidate's entry
                // two statements above, and anything the candidate pushes LATER (an on:load
                // route.push, a presented sheet) allocates its id during rendering, after
                // `mount` has returned — so no loop here can reach it. Those ids stay UNMAPPED
                // and take the fail-open branch, as they did before the binding existed.
                // Coerced through NavFrame.intId, never `as? Int`: a store value that has
                // round-tripped through JSON arrives as Double, and a silent nil here would
                // disable the whole stale-drop (Router.kt frameIdOf is the twin).
                if let id = frame { self.rootAttemptFrame[id] = (self.rootBootGeneration, index) }
                // THE FRAMELESS SURFACE. A web-surface candidate is never tracked by
                // DSXScreenReadiness (only a NATIVE frame is), so its readiness arrives through
                // the frameless relay with `screen.frame` absent — the binding above is written
                // for an id no report will ever carry, and an unmapped/frameless settle would
                // crown whoever is live. Record the attempt that owns the frameless plane so a
                // late report from a RETIRED web candidate resolves to its own index and drops.
                // The kernel names no module: membership is the registry the surface owner fills.
                if DSXScreenReadiness.webSurfaceTags.contains(candidate.view) {
                    self.rootFramelessAttempt = (self.rootBootGeneration, index)
                }
                // WHICH attempt is live, then THAT one is live — identity before level, the
                // same publish law as `screen.frame` before `screen.ready` (phase.json rule 5):
                // a reader between the two writes must never see `root.live == true` paired
                // with the PREVIOUS attempt's index. A surface stamps the failure it reports
                // later with `data.attempt` read HERE, and the fold drops it if the plan has
                // moved on — `root.live` alone stays true across every attempt, so it cannot
                // distinguish a retired candidate's late failure from the live one's
                // (root-plan.md §failure attribution).
                DSX.state.setPath("root.attempt", index)
                // The LIVE-ATTEMPT flag, kernel-owned state: a surface module tags a terminal
                // failure origin "root" by READING this — it never infers its position.
                DSX.state.setPath("root.live", true)
            },
            now: { Int(Date().timeIntervalSince1970 * 1000) },
            setTimer: { ms, fire in DSXScreenReadiness.scheduleDeadline(Double(ms) / 1000, fire) },
            fire: { event, payload in ModuleRegistry.shared.dispatch(event, payload, .void) },
            // Membership is guaranteed at BUILD time (root_plan_schema.rb V2 aborts on an
            // unregistered view per platform), but the runtime still consults the REAL
            // registry: native frames settle on FIRST RENDER (the fail-open readiness law),
            // so an unregistered tag would otherwise "settle" as a blank winner instead of
            // failing forward as root.component_missing (corpus F-10) — reachable only in
            // validator-bypassed dev trees, which is exactly who needs the diagnostic.
            // `has` IS the canonical "shipped in this binary" predicate (Stack.swift) — the same
            // one a remote route's `requires` and the dynamic <node> resolver consult. Spelling
            // the chain out by hand here drifted twice: defs alone failed "DSXWebView"/"DSXView"
            // (native GlobalStackComponents live in nativeGlobals, not the XML table), and
            // defs+nativeGlobals still failed every PrivilegedStackComponent (scaffold, list,
            // tabs, grid, scroll, pager, carousel) and everything in `registry`.
            registered: { StackComponents.has($0) },
            diagnostic: { ledger in
                DSXScreenReadiness.suppressedDeadlineFrame = nil
                DSX.state.setPath("root.live", false)
                DSX.state.setPath("root.exhausted", ledger.map { [
                    "index": $0.index, "id": $0.id, "view": $0.view,
                    "code": $0.code, "elapsedMs": $0.elapsedMs,
                ] })
            }
        ), target: "app")
        rootFold = fold
        fold.start()
        // The high-water mark is captured AFTER start(), not before: there is no sink yet during
        // start(), and the sink delivers current state on subscribe — so an error raised while the
        // plan was folding synchronously (a `root.failed` hook tearing a candidate down) would be
        // replayed to whichever candidate ended up live and fail it at elapsedMs ~0, with the
        // dead one's code. An error nothing was listening for is not attributable to the
        // survivor. Pre-boot errors are excluded for the same reason they always were.
        lastSeenErrorCount = (DSX.state.getPath("dsx.errorCount") as? Int) ?? 0
        observe()   // the observe() sink also feeds frame settle to the fold (screen.ready state)
        // PROVENANCE floor — `dsx.source.routes` exists PACKAGELESS: with a bundled routes.json
        // the table serves from the binary (serving=bundle; never|stale per the persisted
        // per-origin stamp). Published only while no OTA table is up — the Routing package
        // overwrites with cache/origin at its own seams. No bundled table → no slice (honest
        // absence, Article 7). The kernel still names no module: this reports the kernel's OWN
        // floor, exactly like the fallback resolution above.
        if !Self.bundledTable.isEmpty,
           ((DSX.state.getPath("routes") as? [[String: Any]]) ?? []).isEmpty,
           (DSX.state.getPath("routes_signed") as? String) == nil {
            dsx.source.publish("routes", serving: DSXSource.servingBundle, fresh: false,
                               key: (AppManifest.resolvedHost() ?? "").lowercased())
        }
    }

    /// Re-resolve `global.route` whenever `global.route.path` changes. Observing all of `$vars`
    /// is coarse but cheap (the resolve is guarded + idempotent), and it makes navigation a pure
    /// state write — no nav goes through a package.
    /// The fold instance for THIS boot — `resolved()` reads the winner as the view-less route
    /// default, and the error plane forwards root-attributed failures here.
    var rootFold: RootPlan.Fold?

    /// Frame id → (boot generation, the root-plan attempt that mounted it). The stale-signal
    /// token made concrete: a readiness report carries its frame, this says which candidate owned
    /// that frame, and the fold drops a settle whose attempt is no longer live (root-plan.md §5).
    /// Bounded by the plan length (one root frame per attempt) times the number of boots this
    /// process has run; ids are monotonic, so entries stay valid across a retry and are never
    /// cleared — the GENERATION is what keeps a dead run's index from aliasing the new fold's.
    private var rootAttemptFrame: [Int: (Int, Int)] = [:]

    /// The attempt that owns the FRAMELESS readiness plane (a web-surface candidate — see
    /// `mount`), same (generation, index) shape. Nil until such a candidate mounts, which is
    /// what keeps a pure-native plan on the legacy fail-open.
    private var rootFramelessAttempt: (Int, Int)?

    /// Bumped once per `boot()`. Stamps every binding above so a retry cannot inherit them.
    private var rootBootGeneration = 0

    /// A binding that resolves to a RETIRED boot. Never equals a live attempt index (those are
    /// >= 0 while the fold races), so `settle`/`rootError` always drop it.
    private static let staleAttempt = -1

    /// The attempt a report belongs to, or nil when nothing binds it (fail-open: settle the live
    /// attempt). A binding from a PREVIOUS boot resolves to `staleAttempt`, which is never a live
    /// index, so the fold drops it — retained-and-dropped, never aliased onto the current fold.
    private func boundAttempt(_ frame: Int?) -> Int? {
        // A PRESENT-but-unmapped frame stays unbound (fail-open) — it must NOT fall through to
        // the frameless record, which belongs to the web surface and would drop a cold
        // deep-link's honest settle. Only an ABSENT frame reads the frameless plane.
        let record = frame != nil ? rootAttemptFrame[frame!] : rootFramelessAttempt
        guard let record else { return nil }
        return record.0 == rootBootGeneration ? record.1 : Self.staleAttempt
    }

    private func observe() {
        cancellable = DSX.state.$vars
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.resolveIfPathChanged()
                // Frame settle reaches the ROOT-PLAN fold as STATE (`global.screen.ready`,
                // written by the Lifecycle coordinator) — the kernel names no module and hooks
                // no bus (Article 1); after the winner settles, the fold drops every later flip.
                // Root-attributed FAILURES first — through the error system's reactive keys
                // (`global.dsx.lastError` / `errorCount`, error-system.md): an ambient emission
                // with origin "root" during a live attempt advances the plan. Checked BEFORE the
                // settle plane because a failed web load also translates into `screen.ready`
                // ("a failed load is still settled") — in a same-turn race the FAILURE must win
                // or the dead candidate would be crowned. Any other origin never touches the root.
                // NOT guarded by `fold.active`: the mark must advance whenever the ledger grows,
                // or an error raised while the fold is between attempts is left UNCONSUMED and
                // re-read against the next candidate. `fail()` clears `live` BEFORE firing
                // `root.failed`, so that window is `!done && live < 0` — active is false there
                // while `root.live` is still true, which is exactly when a dying candidate's
                // teardown raises. `rootError` self-guards on `done`/`live`, so forwarding
                // unconditionally is safe and keeps consume-and-drop.
                if let fold = self.rootFold,
                   let count = DSX.state.getPath("dsx.errorCount") as? Int, count > self.lastSeenErrorCount {
                    self.lastSeenErrorCount = count
                    if let e = DSX.state.getPath("dsx.lastError") as? [String: Any],
                       (e["origin"] as? String) == "root" {
                        // An attempt-BOUND failure (the surface stamped `data.attempt` from the
                        // kernel-owned `root.attempt`) is delivered only while that attempt is
                        // live; an unstamped one stays unbound and lands on the live attempt, as
                        // before. The kernel reads a value, never a module (root-plan.md §7.1).
                        // NavFrame.intId, not `as? Int`: the stamp must survive a JSON
                        // round-trip (a Double) exactly like the frame ids do.
                        let stamped = ((e["data"] as? [String: Any])?["attempt"]).flatMap(NavFrame.intId)
                        fold.rootError(code: (e["code"] as? String) ?? "error", origin: "root",
                                       attemptIndex: stamped)
                    }
                }
                if let fold = self.rootFold, fold.active,
                   (DSX.state.getPath("screen.ready") as? Bool) == true {
                    // FRAME-BOUND SETTLE: `screen.frame` is the identity of the report that
                    // produced this level (phase.json rule 5) — a native frame's id, or absent
                    // for a frameless one (the web relay names no frame). A frame THIS PLAN
                    // mounted resolves to its attempt; once the fold has moved on that index is
                    // stale and the signal is dropped. An unmapped/frameless report settles the
                    // live attempt, unchanged — a cold deep-link frame settling still proves
                    // the app interactive.
                    let reporting = DSX.state.getPath("screen.frame").flatMap(NavFrame.intId)
                    let bound = self.boundAttempt(reporting)
                    fold.settle(attemptIndex: bound)
                    if fold.winner != nil {
                        DSXScreenReadiness.suppressedDeadlineFrame = nil
                        DSX.state.setPath("root.live", false)
                    }
                    // NO RETIRE-THE-LEVEL BRANCH HERE — the Kotlin twin's deliberate divergence
                    // (Router.kt), not an omission. That branch exists because an INLINE sink
                    // observes each write separately and can catch a fresh `screen.frame` paired
                    // with a corpse's `true`. THIS sink is `.receive(on: RunLoop.main)` and
                    // re-reads state at delivery, so it only ever sees the pair Lifecycle.publish
                    // wrote in one call stack — the half-published state the branch guards
                    // against is unobservable here, leaving it pure cost. And it is worse than
                    // useless: with several reports in one runloop turn every delivery reads the
                    // FINAL pair, so a retired frame landing after the live candidate's settle
                    // would refuse that settle and then write `screen.ready = false`, destroying
                    // a level nothing republishes (readiness is once-per-frame) and killing a
                    // healthy candidate at its timeoutMs.
                }
            }
    }

    /// High-water mark of the error ledger the fold has already inspected (observe() above).
    private var lastSeenErrorCount = 0

    private func resolveIfPathChanged() {
        // NEVER react mid-publish: apply() writes `nav` then `route`, and between the two the
        // published state is inconsistent (`lastResolvedPath` advanced, `route.path` stale) — a
        // naive replace here re-resolves (and, for a route-mounted native frame, RELEASES) the
        // frame just pushed. On iOS the observer is DEFERRED to the next runloop turn
        // (`.receive(on: RunLoop.main)`), so this window never opens — the guard is the
        // documented twin of the Kotlin runtime, whose bare-kernel sink runs INLINE. The
        // observer is level-triggered (compares state, not edges): skipping loses nothing.
        guard !publishing else { return }
        guard !stack.isEmpty else { return }             // pre-boot: the seed owns the first frame, never the observer
        let path = (DSX.state.getPath("route.path") as? String) ?? "/"
        guard path != lastResolvedPath else { return }   // ignore unrelated global writes
        // A MODULE-pushed native frame OWNS the screen — don't let a background route.path write
        // replace it; swallow the write (sync lastResolvedPath so we don't re-fire), and the web's
        // navigation resumes once the native screen is popped. A TABLE-resolved native frame
        // (`route: true`) is URL-addressed like any web frame — a path write re-routes it.
        if let top = stack.last, (top["native"] as? Bool) == true, (top["route"] as? Bool) != true {
            lastResolvedPath = path
            return
        }
        // An external path write (web despia.navigate, `set: route.path = …`) navigates in place —
        // REPLACE the top, preserving single-route semantics. History is opt-in via route.push.
        replace(path)
    }

    // MARK: resolve (match the OTA table + capability gate + web fallback)

    /// Resolve a path to a route entry — match against `global.routes` (the table the OTA package
    /// fills) with the capability gate (a route's `requires` must ALL be shipped), else the web
    /// fallback (DSXWebView). An unavailable match reports `route_unavailable` and falls through.
    private func resolved(_ path: String, depth: Int = 0) -> [String: Any] {
        let query = Self.parseQuery(path)
        let routes = trustedRoutes(forPath: path)
        for r in routes {
            guard let pattern = r["path"] as? String,
                  let params = DSXPathMatch.match(path, pattern) else { continue }   // named params → route.params.*
            let missing = ((r["requires"] as? [String]) ?? []).filter { !Self.available($0) }
            if !missing.isEmpty {
                // Requested but unavailable in THIS binary → don't switch; report + fall through
                // (ultimately /* → DSXWebView). Reaches web as despia.on("route", e => e.event === "route_unavailable").
                dsx.broadcast("route_unavailable",
                              JSON.from(["path": path, "missing": missing, "reason": "missing_capability"]))
                continue
            }
            // Declarative GUARD (App.json route entry `guard`/`redirect`): an entry may gate on APP
            // STATE, so resolution is total over (URL × state), not just URL. `guard` is a bounded JSE
            // PREDICATE over `global.*` — the app/session state that decides ACCESS (e.g.
            // `"global.session.token"` or `"global.user.plan == 'pro'"`); when it evaluates falsy,
            // resolution REDIRECTS to `redirect` (a login wall, a paywall, an onboarding gate) — matching
            // go_router `redirect` / React Router loaders. Guards read `global.*`, NOT the incoming
            // route: resolution runs BEFORE `apply()` publishes the new top, so `route.*` here is still
            // the CURRENT (pre-navigation) route — gate on session/entitlement state, not the target's
            // params (the path pattern already carries those). The predicate is TOTAL (JSE is
            // terminating, depth-budgeted, and PURE here — a throwaway store, so it can only READ state,
            // never write) and FAIL-OPEN: no `redirect` target ⇒ this entry simply doesn't match (fall
            // through to the next / fallback), and redirects are depth-capped so a guard cycle can never
            // loop. Absent `guard` ⇒ unchanged.
            if let g = r["guard"] as? String, !g.isEmpty,
               !Self.truthy(JSE.eval(g, store: Self.guardStore, item: nil)) {
                if let to = r["redirect"] as? String, !to.isEmpty, to != path, depth < 8 {
                    return resolved(to, depth: depth + 1)
                }
                continue
            }
            // An UNCONDITIONAL redirect entry ({ "path": "/home", "redirect": "/" } — a PURE
            // redirect: no component, no guard, no view/src of its own) resolves through to its
            // target before matching completes — web resolveUrl parity (corpus-pinned:
            // Conformance/router/resolve.json). A guard-carrying entry keeps `redirect` as its
            // guard FALLBACK (handled above), and a view/src entry with a stray redirect stays
            // a renderable route (back-compat). Depth-capped like the guard form; at the cap it
            // simply doesn't match (fail-open).
            if let to = r["redirect"] as? String, !to.isEmpty,
               r["component"] == nil, r["guard"] == nil, r["view"] == nil, r["src"] == nil {
                if to != path, depth < 8 { return resolved(to, depth: depth + 1) }
                continue
            }
            var route: [String: Any] = ["path": path,        // keep the FULL path — query rides along + round-trips
                                        // A row with no `view` follows the BOOT WINNER — the
                                        // root-plan candidate that settled (root-plan.md; corpus
                                        // "route rows with no view follow the boot winner").
                                        // Before a winner exists, the plan's first candidate
                                        // stands in; the kernel names no surface either way.
                                        "view": (r["view"] as? String)
                                            ?? rootFold?.winner?.view
                                            ?? AppManifest.entry.surfaces.first?.view
                                            ?? "",
                                        "src": (r["src"] as? String) ?? "",
                                        "params": params,    // named path segments → route.params.id / dsx.params.id
                                        "query": query]      // parsed ?query string → route.query.ref / dsx.query.ref
            if let origin = r["origin"] as? String { route["origin"] = origin }
            // The UNIFIED grammar (the same keys the web renderer has always consumed):
            // `component` names the native screen this path mounts (materialize() builds it);
            // `meta` rides along — its `title` seeds the system bar for pushed frames.
            if let comp = r["component"] as? String, !comp.isEmpty { route["component"] = comp }
            if let meta = r["meta"] as? [String: Any], !meta.isEmpty { route["meta"] = meta }
            return route
        }
        // Nothing matched (or no table) → the CONFIGURED fallback (App.json `entry.fallback`;
        // default DSXWebView/web). Data-driven, not hardcoded — an app can declare a native fallback.
        let fb = AppManifest.entry.fallback
        var route: [String: Any] = ["path": path, "view": fb.view, "src": fb.src, "params": [:], "query": query]
        if !fb.origin.isEmpty { route["origin"] = fb.origin }
        return route
    }

    /// THE LOAD GATE for the remote route table (the one place the engine trusts remote bundle
    /// content — see `RemoteBundleGate` + OpenSource/Skills/security.md "The load gate").
    ///
    /// Returns the `global.routes` table to match against — UNCHANGED when bundle-signing is OFF
    /// (`RemoteBundleGate.requiresVerification == false`), i.e. today's behavior, byte-for-byte.
    ///
    /// When signing is ON, the trusted table is parsed DIRECTLY from the verified signed bytes the
    /// table-source records at `global.routes_signed` — NOT from `global.routes`. So the table the
    /// engine matches is provably the bytes the gate verified: there is no "table key vs signed key"
    /// desync to exploit, and `global.routes` (which a fetch writes pre-verification) is never the
    /// trusted source while signing is on. `routes_signed` is the signed routes.json (the JSON array of
    /// route objects — the same shape the Router already consumes); for real table-content integrity
    /// the build signs THOSE bytes (an asset-LIST-only deploy manifest authenticates the path list, not
    /// the table contents — see remote-bundle-signing.md). Missing / unverified / unparsable ⇒ EMPTY
    /// table so every path falls through to the configured `entry.fallback` (Article 7: degrade to the
    /// app's offline/web surface — never brick, never render unsigned remote content) + a clear
    /// `route_unavailable` broadcast for the web/native layer.
    ///
    /// This is the engine CONSUMING the verification (constitution Art.1/3 + locked-decision #3): one
    /// trust check for the whole table, no per-route / per-node-kind branching. A bundled or fallback
    /// screen is never gated — only the remote table is.
    private func trustedRoutes(forPath path: String) -> [[String: Any]] {
        guard RemoteBundleGate.requiresVerification else {
            let published = (DSX.state.getPath("routes") as? [[String: Any]]) ?? []
            return published.isEmpty ? Self.bundledTable : published   // a PUBLISHED table wins; bundled is the floor
        }
        // ON ⇒ trust ONLY the verified signed bytes, and derive the table from them.
        if let signed = DSX.state.getPath("routes_signed") as? String,
           RemoteBundleGate.isVerified(manifestText: signed),
           let table = Self.parseRouteTable(signed), !table.isEmpty {
            return table
        }
        // The BUNDLED table stays the floor under signing too: it is code-signed BINARY content,
        // not remote bytes — exactly as trusted as the bundled screens it names (the gate exists
        // for the REMOTE plane; "a bundled or fallback screen is never gated" extends to the
        // bundled table). An attacker can't downgrade INTO it — it's what shipped.
        if !Self.bundledTable.isEmpty { return Self.bundledTable }
        let hadSigned = (DSX.state.getPath("routes_signed") as? String) != nil
        dsx.broadcast("route_unavailable",
                      JSON.from(["path": path,
                                 "reason": hadSigned ? "signature_invalid" : "unverified_manifest"]))
        return []
    }

    /// The BUNDLED route table — the app's own `routes.json` shipped in the binary
    /// (`AppManifest.bundledRoutesText`, read beside App.json), parsed once with the same
    /// both-shapes grammar as the OTA bytes. The native OFFLINE FLOOR: with it, path routing —
    /// `component` mounts, `meta` bars, deep links — works with no network and no Routing
    /// package, day one, matching the web build (which compiles this same file in). Empty when
    /// the app ships none (⇒ behavior before the floor existed, byte-for-byte).
    private static let bundledTable: [[String: Any]] = {
        AppManifest.bundledRoutesText.flatMap(parseRouteTable) ?? []
    }()

    /// Parse the route table out of the signed routes.json text. Accepts BOTH manifest shapes (the
    /// signature covers the whole document either way, so both are equally trusted once verified):
    ///   • the OBJECT form `{ "version": <int>, "routes": [ … ] }` (C1/C2) — the route array is `routes`;
    ///   • the bare ARRAY form `[ … ]` (the original, unversioned form) — BACK-COMPAT, treated as the
    ///     route array directly. An existing signed deploy that still serves a bare array keeps working.
    /// nil on any malformed input (treated as "no trusted table" → fallback). Kept here so the trusted
    /// table is derived inside the engine's trust boundary, never taken from a separately-written key.
    private static func parseRouteTable(_ text: String) -> [[String: Any]]? {
        guard let data = text.data(using: .utf8),
              let top = try? JSONSerialization.jsonObject(with: data) else { return nil }
        if let array = top as? [[String: Any]] { return array }                    // bare array (old) — back-compat
        if let obj = top as? [String: Any] { return obj["routes"] as? [[String: Any]] }  // { version, routes:[…] } (new)
        return nil
    }

    // MARK: route_unavailable — the engine-owned broadcast (C1 rollback · C2 asset integrity)

    /// The Router OWNS the `route_unavailable` broadcast contract (the `route` scheme + the
    /// `{ path, reason }` envelope web reads via `despia.on("route", …)`). The table-source and the
    /// asset consumers detect rejections the gate can't (a version rollback happens in the courier
    /// before any table is published; an asset hash mismatch happens deep in a render surface), so they
    /// trigger the SAME broadcast through here rather than minting their own channel — keeping the
    /// contract and the channel inside the engine (monorepo working rules rule 1: through `dsx`, never a side-channel).
    /// No-op if the Router isn't booted (a pure web app without the route runtime). Reasons today:
    /// `missing_capability` · `component_unavailable` · `component_unbuildable` ·
    /// `unverified_manifest` · `signature_invalid` (here in `trustedRoutes`), `rollback_detected`
    /// (C1, fired by Routing) and `asset_integrity` (C2, fired by an asset consumer).
    static func reportRouteUnavailable(path: String, reason: String) {
        Self.shared?.dsx.broadcast("route_unavailable", JSON.from(["path": path, "reason": reason]))
    }

    /// Parse `?a=1&b=hi%20there` → `["a": "1", "b": "hi there"]` (percent-decoded; string values,
    /// like the web — read as `route.query.x` / `dsx.query.x`). No query → `[:]`.
    private static func parseQuery(_ path: String) -> [String: String] {
        guard let q = path.firstIndex(of: "?") else { return [:] }
        var out: [String: String] = [:]
        for pair in path[path.index(after: q)...].split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            guard let raw = kv.first.map(String.init), !raw.isEmpty else { continue }
            let key = raw.removingPercentEncoding ?? raw
            let val = kv.count > 1 ? String(kv[1]) : ""
            out[key] = val.removingPercentEncoding ?? val
        }
        return out
    }

    /// A fresh stack entry for `path` — a resolved route stamped with a unique frame id (and, for
    /// a `component` route, its native mount + seeded bar — materialize()). `depth` is the frame's
    /// stack position (0 = root): pushed WEB frames (depth ≥ 1) claim the system bar, the root
    /// never does (the app's own web surface owns its chrome). `mount: false` (boot's seed)
    /// resolves WITHOUT mounting components — see materialize().
    private func entry(_ path: String, depth: Int, mount: Bool = true) -> [String: Any] {
        materialize(resolved(path), depth: depth, mount: mount)
    }

    /// A fresh root frame built directly from the framework starter fallback. This deliberately
    /// bypasses route resolution only for that safe starter boot; client-authored entries and all
    /// push/replace/reset/path writes resolve the route table exactly as before.
    private func fallbackEntry(_ path: String) -> [String: Any] {
        let fallback = AppManifest.entry.fallback
        var route: [String: Any] = ["path": path,
                                    "view": fallback.view,
                                    "src": fallback.src,
                                    "params": [String: String](),
                                    "query": Self.parseQuery(path)]
        if !fallback.origin.isEmpty { route["origin"] = fallback.origin }
        return materialize(route, depth: 0, mount: false)
    }

    /// A fresh root frame for ONE root-plan candidate — the fold's mount. Bypasses route
    /// resolution exactly like fallbackEntry (the plan owns the root; the table owns
    /// navigation). `config` rides the route map verbatim as the surface's attributes —
    /// recognized keys (`src`, `origin`) land in their existing slots, everything else is
    /// component-owned.
    private func candidateEntry(_ path: String, _ c: AppManifest.Entry.Surface) -> [String: Any] {
        var route: [String: Any] = ["path": path,
                                    "view": c.view,
                                    "src": (c.config["src"] as? String) ?? "",
                                    "params": [String: String](),
                                    "query": Self.parseQuery(path)]
        if let origin = c.config["origin"] as? String, !origin.isEmpty { route["origin"] = origin }
        for (k, v) in c.config where k != "src" && k != "origin" && route[k] == nil { route[k] = v }
        return materialize(route, depth: 0, mount: false)
    }

    /// Give a RESOLVED route its frame identity — and its native mount + system bar:
    ///   • a `component` route (the unified routes.json grammar the web renderer has always
    ///     consumed — /web/04-routing.md) mounts the NAMED component as a native frame: the kernel
    ///     builds the surface (global scope — table names are qualified, `demo.Cart`), holds it
    ///     exactly like a module push, and seeds `vars` with the matched params + query (query
    ///     wins on collision — web parity: navigatePath's `{ ...params, ...query }`). The frame
    ///     is stamped `route: true` — URL-RESOLVABLE, unlike a module-pushed screen — so path
    ///     writes and table refreshes may re-route it. Its bar seeds from the component's own
    ///     claim (chromeHint) with `meta.title` as the fallback. A route that EXPLICITLY names a
    ///     missing/unbuildable native component resolves to compiled DSXNativeUnavailable—never
    ///     implicitly to DSXWebView. Routes without `component` keep ordinary fallback semantics.
    ///   • a WEB route at PUSHED depth (≥ 1) claims the system bar: `meta.title` when the table
    ///     declares one, else a title derived from the path's last segment — a pushed web path is
    ///     never a bar-less trap (it gets the REAL system bar + back button, the in-app-browser
    ///     shape). An EXPLICIT empty `meta.title` ("") opts the route out. The ROOT frame
    ///     (depth 0) never claims. Seeds ride the same publish that adds the frame (chromeHint's
    ///     native-ordering rule); the screen's own live claim still corrects or releases.
    /// `mount` gates the component branch: EXPLICIT NAVIGATION (push / replace / reset / a
    /// route.path write) mounts; boot's root seed passes false so the app's boot surface stays
    /// the App.json entry (web home + splash/ready choreography, byte-stable) even when the
    /// table maps "/" to a component — the web build boots its table root, native boots its
    /// entry; ONE navigation later they converge. Passive table refreshes never convert a live
    /// web frame either (resolveCurrent keeps the old web comparison).
    private func materialize(_ route: [String: Any], depth: Int, mount: Bool = true) -> [String: Any] {
        var e = route
        frameSeq += 1
        let id = frameSeq
        e["id"] = id
        let meta = route["meta"] as? [String: Any]
        let path = (route["path"] as? String) ?? "/"
        if mount, let comp = route["component"] as? String, !comp.isEmpty {
            var vars: [String: Any] = ((route["params"] as? [String: String]) ?? [:])
            for (k, v) in (route["query"] as? [String: String]) ?? [:] { vars[k] = v }   // query wins — web parity
            // Registry-checked FIRST: surfaces build lazily (tags resolve at render), so an
            // excluded component would otherwise mount an empty frame.
            let registered = StackComponents.resolve(comp, pkg: nil) != nil
            if registered,
               let surface = buildSurface(comp, scope: nil, vars: vars.isEmpty ? nil : vars) {
                StackSurface.pushedFrames[id] = surface
                surface.store.frameId = id        // frame-scoped claims (route.chrome) — see StackStore.frameId
                if let hint = chromeHint(component: comp, scope: nil) ?? Self.metaChrome(meta) {
                    chrome["\(id)"] = hint
                }
                e["view"] = "__native"
                e["src"] = ""
                e["native"] = true
                e["route"] = true
                if !vars.isEmpty { e["vars"] = vars }
                return e
            }
            let reason = registered ? "component_unbuildable" : "component_unavailable"
            kernelLog("[Router] route \"\(path)\" names component \"\(comp)\" — \(reason); rendering native DSX status UI")
            dsx.broadcast("route_unavailable",
                          JSON.from(["path": path, "component": comp, "reason": reason]))
            // A dynamic route-frame component is still fully native DSX, but needs no held
            // StackSurface. This also survives the requested surface factory returning nil.
            e["component"] = nil
            e["requestedComponent"] = comp
            e["unavailableReason"] = reason
            e["view"] = Self.nativeUnavailableView
            e["src"] = ""
        }
        if depth >= 1, let spec = Self.metaChrome(meta) ?? Self.derivedChrome(path: path, meta: meta) {
            chrome["\(id)"] = spec
        }
        return e
    }

    /// The native-route-unavailable surface is a CLAIMED role (`route.nativeUnavailable` —
    /// Foundation claims it with its compiled status screen), never a kernel-named component
    /// (root-plan.md §capability; the retired literal was a rule-13 violation). Unclaimed ⇒
    /// an empty view: the kernel names no surface, and an explicit native route still never
    /// silently becomes a browser surface when its requested component is absent (Article 7 —
    /// the degrade stays native-shaped, just blank).
    private static var nativeUnavailableView: String {
        (ModuleRegistry.shared.dispatch("route.nativeUnavailable", nil, .claim) as? String) ?? ""
    }

    /// `meta.title` → a chrome spec. nil when the table declares none (or an empty one — the
    /// explicit opt-out is derivedChrome's business to honor).
    private static func metaChrome(_ meta: [String: Any]?) -> [String: Any]? {
        guard let t = meta?["title"] as? String, !t.isEmpty else { return nil }
        return ["title": t, "large": false]
    }

    /// The DERIVED bar title for a pushed web frame with no declared `meta.title`: the path's
    /// last segment, prettified ("/help/faq-page" → "Faq page"), so a deep-linked or pushed web
    /// path always has a titled system bar + back button. An EXPLICIT empty `meta.title` ("")
    /// declares "no bar" → nil; the bare root ("/") has no segment → nil (no claim).
    private static func derivedChrome(path: String, meta: [String: Any]?) -> [String: Any]? {
        if let t = meta?["title"] as? String, t.isEmpty { return nil }   // declared opt-out
        let clean = String(path.prefix(while: { $0 != "?" && $0 != "#" }))
        guard let seg = clean.split(separator: "/").last.map(String.init), !seg.isEmpty else { return nil }
        let words = seg.replacingOccurrences(of: "-", with: " ")
                       .replacingOccurrences(of: "_", with: " ")
                       .trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return nil }
        return ["title": String(first).uppercased() + words.dropFirst(), "large": false]
    }

    /// Re-resolve the TOP on a routes-table refresh. KEEPS the frame id when the mapping is
    /// unchanged (a background refresh never reloads the live screen); mints a new id only if the
    /// table remapped this path. Lower frames are left as-is. A MODULE-pushed native frame isn't
    /// URL-resolvable and is never touched; a TABLE-resolved native frame (`route: true`) IS —
    /// same component ⇒ the live screen stays (id + surface kept), remapped ⇒ swapped like any
    /// table change (the old surface released after the publish, like a pop).
    private func resolveCurrent() {
        let path = (stack.last?["path"] as? String) ?? (DSX.state.getPath("route.path") as? String) ?? "/"
        guard let top = stack.last else { stack = [entry(path, depth: 0)]; apply(); return }
        if (top["native"] as? Bool) == true {
            guard (top["route"] as? Bool) == true else { return }   // a module MOUNT owns its screen; leave it
            let re = resolved(path)
            if (re["component"] as? String) == (top["component"] as? String) { return }
            stack[stack.count - 1] = materialize(re, depth: stack.count - 1)
            apply()
            releaseNative([top])
            return
        }
        // A WEB top on a table refresh keeps the OLD comparison — a PASSIVE refresh never
        // converts a live web frame to a native mount (only explicit navigation mounts);
        // the inert `component`/`meta` keys ride the frame dict, which readers ignore.
        var re = resolved(path)
        let same = ["view", "src", "origin"].allSatisfy { (re[$0] as? String) == (top[$0] as? String) }
        if same { re["id"] = top["id"] }
        else { frameSeq += 1; re["id"] = frameSeq }
        stack[stack.count - 1] = re
        apply()
    }

    // MARK: navigation (the stack is state — push / pop / popTo / popToRoot / replace / reset)

    private func push(_ path: String) {
        stack.append(entry(path, depth: stack.count))
        beginUIQualificationTransition("push")
        apply()
    }
    private func pop()                   { guard stack.count > 1 else { return }; echoMemo = nil; let gone = Array(stack.suffix(1)); stack.removeLast(); apply(); releaseNative(gone) }
    private func replace(_ path: String) {
        echoMemo = nil
        let gone = stack.isEmpty ? [] : Array(stack.suffix(1))
        if stack.isEmpty {
            stack = [entry(path, depth: 0)]
        } else {
            stack[stack.count - 1] = entry(path, depth: stack.count - 1)
        }
        beginUIQualificationTransition("replace")
        apply()
        releaseNative(gone)
    }
    private func reset(_ path: String) {
        echoMemo = nil
        let gone = Array(stack)
        stack = [entry(path, depth: 0)]
        beginUIQualificationTransition("reset")
        apply()
        releaseNative(gone)
    }

    private func beginUIQualificationTransition(_ operation: String) {
        #if DEBUG
        guard let frame = stack.last?["id"].flatMap(NavFrame.intId) else { return }
        RouterUIQualificationProbe.shared.begin(operation: operation, expectedFrame: frame)
        #endif
    }

    #if DEBUG
    /// XCUITest can tap the public route verbs once the host is visible, but cannot inject two
    /// pre-existing native frames for a rapid-Back test. This DEBUG-only seam seeds those frames
    /// through the same private path primitive; it is unavailable to release artifacts.
    func pushUIQualificationPath(_ path: String) { push(path) }
    #endif

    /// popTo — pop back to the DEEPEST frame whose path matches `path`: one state mutation, one
    /// host transition (NavigationStack animates the multi-pop once), instead of N chained pops —
    /// the React-Navigation `popTo` / Flutter `popUntil` / go_router-parity verb. Matching is
    /// CONCRETE and QUERY-INSENSITIVE ON BOTH SIDES — the frame's stored path and the target
    /// compare with their query strings stripped (frames here store the full pushed path; the
    /// web runtime stores it query-stripped, so stripping both sides is the one rule all three
    /// renderers can share) — never a route-table pattern. Pinned by the SHARED corpus
    /// OpenSource/Conformance/router/popto.json (the Kotlin and web runtimes execute it; this
    /// file is the reference). No match / already the top / empty path → no-op (fail-open).
    /// Modals are untouched — `nav.modal` presentations survive stack verbs, like pop/reset.
    private func popTo(_ path: String) {
        guard let idx = deepestMatch(path) else { return }
        truncate(toDepth: idx + 1)
    }

    /// popToRoot — clear back to the root frame (React Navigation's `popToTop`). At root → no-op.
    private func popToRoot() { truncate(toDepth: 1) }

    /// The deepest stack index whose frame path matches `path` (see popTo for the rule), nil when
    /// nothing matches. Walks top-down so the nearest previous instance wins.
    private func deepestMatch(_ path: String) -> Int? {
        let want = String(path.prefix(while: { $0 != "?" }))
        guard !want.isEmpty else { return nil }
        for i in stack.indices.reversed() {
            guard let p = stack[i]["path"] as? String else { continue }
            if String(p.prefix(while: { $0 != "?" })) == want { return i }
        }
        return nil
    }

    /// The kernel host (`RouterHost`) popped via back-swipe → truncate the live stack to `depth`
    /// (root … depth). Only ever a REDUCTION — every push originates in a verb — so it never grows.
    func hostTruncate(toDepth depth: Int) { truncate(toDepth: depth) }

    /// Re-run the ROOT PLAN once — the boot diagnostic's Retry (root-plan.md §9). Clears the
    /// exhaustion state and folds the plan again from candidate 0; a second exhaustion simply
    /// republishes the diagnostic. Never invoked while a winner is live (§4.6 — the plan never
    /// re-runs after `root.ready`).
    func retryRootPlan() {
        // Only from the EXHAUSTED state (the diagnostic's button) — never while a fold is
        // live (a double-tap must not race two concurrent folds over one stack).
        guard rootFold?.winner == nil,
              ((DSX.state.getPath("root.exhausted") as? [[String: Any]])?.isEmpty == false) else { return }
        rootFold?.close()   // late timers/signals from the exhausted run are inert
        DSX.state.setPath("root.exhausted", [[String: Any]]())   // empty = no diagnostic (the hosts treat empty as absent)
        boot()
    }

    /// The one truncation funnel (hostTruncate / popTo / popToRoot): slice, publish, release the
    /// popped tail's native surfaces. A no-op unless it strictly REDUCES depth (never below root).
    private func truncate(toDepth depth: Int) {
        guard depth >= 1, depth < stack.count else { return }
        echoMemo = nil                    // a reduction re-arms the double-tap echo guard
        let gone = Array(stack[depth...])
        stack = Array(stack.prefix(depth))
        apply()
        releaseNative(gone)               // run onPop + free any held surfaces in the popped tail
    }

    // MARK: push-time chrome (the native-feel rule: the bar rides the push, never pops in later)

    /// The chrome spec a component's screen will claim, known AT PUSH TIME. A claim normally
    /// lands from markup `on:appear` — AFTER the pushed surface's first full render, which on
    /// device is visibly late: the screen slides on bar-less and the title pops in up to a
    /// second later. Native sets the title BEFORE the transition, so the bar animates in WITH
    /// the push. The kernel can know the claim early WITHOUT naming any component, because it
    /// owns the claim CONTRACT (`dsx.module.route.chrome({ … })`):
    ///   1. the LIVE memory — the last claim this component actually made (chromeMemory,
    ///      recorded by the chrome action) — covers every reopen, dynamic titles included;
    ///   2. the STATIC scan — walk the pushed component's registered template for a child
    ///      whose OWN resolved template contains the claim call, and evaluate the call's arg
    ///      object against that child's usage attributes (`dsx.attribute.x` resolves to the
    ///      usage attr `x` — the attribute contract), so a literal
    ///      `<NavBar title="Cart" large="true"/>` hints { title: "Cart", large: true } on the
    ///      component's very FIRST open too. A usage that opts out of the system bar
    ///      (`system="false"` — the claim guard's documented flag) is skipped, and a `{{ }}`-
    ///      bound title stays a live-claim-only case (never guess a dynamic value).
    /// The hint only SEEDS `nav.chrome` before apply() — the real claim still runs on appear
    /// and confirms, corrects, or releases it. Fail-open everywhere: no hint → exactly the
    /// late-claim behavior this exists to soften.
    private func chromeHint(component: String, scope: String?) -> [String: Any]? {
        if let remembered = chromeMemory[component] { return remembered }
        guard let (template, owningScope) = StackComponents.resolve(component, pkg: scope) else { return nil }
        var queue: [StackNode] = [template], visited = 0
        while let node = queue.first {
            queue.removeFirst()
            visited += 1
            if visited > 64 { return nil }                       // bounded — a page template is small
            queue.append(contentsOf: node.children)
            guard node.tag != template.tag,
                  let (childTemplate, _) = StackComponents.resolve(node.tag, pkg: owningScope ?? scope),
                  let argStr = Self.claimArgs(in: childTemplate) else { continue }
            if node.attrs["system"] == "false" { return nil }    // the usage opted out of the system bar
            if node.attrs.values.contains(where: { $0.contains("{{") }) { return nil }   // dynamic inputs — live claim only
            var item: [String: Any] = [:]
            for (k, v) in node.attrs { item[k] = v }             // dsx.attribute.x → the usage attr x
            guard let spec = JSE.eval(argStr, store: Self.hintStore, item: item) as? [String: Any],
                  let title = spec["title"] as? String, !title.isEmpty else { return nil }
            return ["title": title,
                    "large": (spec["large"] as? String) == "true" || (spec["large"] as? Bool) == true]
        }
        return nil
    }

    /// The claim call's argument object, found anywhere in a template (an `on:appear` attr or a
    /// head `<action>` body — NavBar routes through `dsx.action.claimChrome()`): the balanced
    /// `{ … }` following the kernel's own `dsx.module.route.chrome(` marker. nil = no claim.
    private static func claimArgs(in template: StackNode) -> String? {
        var queue = [template]
        while let node = queue.first {
            queue.removeFirst()
            queue.append(contentsOf: node.children)
            for text in [node.text ?? ""] + Array(node.attrs.values) {
                guard let mark = text.range(of: "dsx.module.route.chrome(") else { continue }
                var depth = 0
                var i = mark.upperBound
                let start = i
                while i < text.endIndex {
                    let ch = text[i]
                    if ch == "(" || ch == "{" { depth += 1 }
                    if ch == "}" { depth -= 1 }
                    if ch == ")" {
                        if depth == 0 { return String(text[start..<i]) }
                        depth -= 1
                    }
                    i = text.index(after: i)
                }
                return nil
            }
        }
        return nil
    }

    /// A throwaway store for static hint evaluation (the guardStore pattern — reads only).
    private static let hintStore = StackStore()

    // MARK: the double-tap echo guard (pushNative + presentModal)

    /// True when a NAMED push/present with identity `key` is an ECHO of the one just before it
    /// (identical, inside 500ms). Two taps land faster than a push/present transition covers
    /// the screen (~350ms), so one row tap can dispatch twice — pushing the same screen twice
    /// (a duplicate under Back: "I popped and the same page was there again") or stacking two
    /// copies of one sheet. An identical consecutive verb inside the window is that echo, not
    /// intent — dropped, logged by the caller. A non-echo arms the memo; every stack REDUCTION
    /// and modal removal clears it (pop/replace/reset/truncate/removeModal), so an intentional
    /// open → close → open replay is never eaten. UNNAMED frames (no component, no caller
    /// path — the corpus' pathless held-surface shape) bypass the guard at the call sites, and
    /// URL pushes (`route.push` — programmatic) are untouched.
    private func isEcho(_ key: String) -> Bool {
        if let last = echoMemo, last.key == key, Date().timeIntervalSince(last.at) < 0.5 { return true }
        echoMemo = (key, Date())
        return false
    }

    /// One stable identity for a named push/present: verb + component + caller path + the
    /// vars/attrs seeds (key-sorted). Both seeds participate so two same-component opens with
    /// DIFFERENT inputs (two product screens raced open by a deep link + a tap) both land —
    /// only a byte-identical repeat reads as a double-tap echo.
    private static func echoKey(_ verb: String, component: String?, path: String = "",
                                vars: [String: Any]?, attrs: [String: Any]?) -> String {
        func digest(_ d: [String: Any]?) -> String {
            guard let d, !d.isEmpty else { return "" }
            return d.keys.sorted().map { "\($0)=\(d[$0].map { "\($0)" } ?? "")" }.joined(separator: "&")
        }
        return "\(verb):\(component ?? "")|\(path)|\(digest(vars))|\(digest(attrs))"
    }

    // MARK: native frames (a module-pushed component surface — StackSurface.push)

    /// Push a module-owned surface as a NATIVE nav frame. The frame carries NO route-table resolution —
    /// it's marked `native`, and the host renders the held surface for it (RouterHost looks it up in
    /// `StackSurface.pushedFrames` by id). Grows history like `push`, so a back-swipe / `route.pop`
    /// removes it and `releaseNative` runs the surface's onPop + frees it. The web view (a lower frame)
    /// stays alive underneath, so the surface's `dsx.broadcast` state events keep flowing to web.
    func pushNative(_ surface: StackSurface, path: String, component: String? = nil, vars: [String: Any]? = nil,
                    attrs: [String: Any]? = nil, scope: String? = nil) {
        if component?.isEmpty == false || !path.isEmpty,
           isEcho(Self.echoKey("push", component: component, path: path, vars: vars, attrs: attrs)) {
            kernelLog("[Router] pushNative(\"\(component ?? path)\") dropped — identical to the push just before it (double-tap echo)")
            return
        }
        frameSeq += 1
        let id = frameSeq
        StackSurface.pushedFrames[id] = surface
        surface.store.frameId = id        // frame-scoped package calls (route.chrome) — see StackStore.frameId
        // PUSH-TIME CHROME SEED (chromeHint): the spec rides the SAME publish that adds the
        // frame, so the destination renders its bar on frame ONE and the title animates in
        // WITH the push — native ordering, instead of the bar popping in after the surface's
        // first full render. The live on:appear claim still confirms, corrects, or releases.
        if let component, !component.isEmpty, let hint = chromeHint(component: component, scope: scope) {
            chrome["\(id)"] = hint
        }
        let p = path.isEmpty ? "/__native/\(id)" : path
        // Stamp the component NAME + serializable inputs onto the observable stack entry (the render
        // surface still lives in `pushedFrames`, but the entry now describes WHAT is on screen — a test
        // can assert "action X pushed frame `component` with `attrs`" without a host, and the frame is
        // seeded-state-restorable if an app maps it to a route). `attrs` is THE component input
        // contract — the same attributes a hard-coding consumer writes, live in the surface's reactive
        // `dsx.attribute` dict; `vars` stays the LEGACY seed namespace. `native:true` keeps the host
        // rendering the held surface. NavFrame reads only the keys it knows, so extra keys are inert.
        var frame: [String: Any] = ["id": id, "view": "__native", "path": p, "src": "",
                                    "params": [:], "query": [:], "native": true]
        if let component, !component.isEmpty { frame["component"] = component }
        if let vars, !vars.isEmpty { frame["vars"] = vars }
        if let attrs, !attrs.isEmpty { frame["attrs"] = attrs }
        stack.append(frame)
        apply()
    }

    /// Release any NATIVE (held-surface) frames in `gone` — run each surface's onPop (the module's
    /// teardown) and free the held reference. Called AFTER the stack mutation + apply(), so the frame
    /// is already out of `nav.stack` (the host is animating its pop) before the surface is freed — no
    /// missing-surface flash. A no-op for ordinary URL frames.
    private func releaseNative(_ gone: [[String: Any]]) {
        for f in gone where (f["native"] as? Bool) == true {
            if let id = f["id"] as? Int { StackSurface.releasePushed(id) }
        }
    }

    // MARK: modals (a STATE-BACKED presented surface — the observable `global.nav.modal`)

    /// Present a module-owned surface as a MODAL. Unlike the fire-and-forget UIKit present
    /// (`StackSurface.present(from:)`), a modal is STATE: it appends an entry to `global.nav.modal`
    /// that the kernel host (RouterHost) renders, so `dsx.resolve` can never claim "opened" while
    /// nothing is on screen (the two-sources-of-truth desync our own mounting-components docs warn
    /// about). `mode` picks the container the host renders: `sheet` → a drawer; `cover` → full-screen;
    /// `overlay` → the state-backed overlay LAYER over the current screen (no UIKit presentation,
    /// so it can never silently fail). An overlay carries `touch` — "passthrough" (default: only
    /// its DRAWN content is tappable, everything else reaches the screen beneath — the
    /// menu-bar-over-web shape) or "block" (the FULL overlay: every touch stops at the layer —
    /// the lock-screen shape). NORMALIZED HERE so published state is the contract, pinned by
    /// OpenSource/Conformance/router/present.json: unknown `as` fails open to sheet, unknown
    /// touch to passthrough, chain entries never carry touch. PLANES (the host contract): the
    /// content stack renders under every overlay, and the chain plane (sheet/cover) presents
    /// above every overlay — a drawer always covers a menu bar. The entry records the component
    /// tag + serializable `vars` (testable without a host). The surface is held by id in
    /// `StackSurface.modalFrames`, exactly like a pushed frame.
    func presentModal(_ surface: StackSurface, mode: String, component: String, vars: [String: Any]?,
                      detents: [String]?, touch: String? = nil, attrs: [String: Any]? = nil) {
        if !component.isEmpty,
           isEcho(Self.echoKey("present:\(mode)", component: component, vars: vars, attrs: attrs)) {
            kernelLog("[Router] presentModal(\"\(component)\") dropped — identical to the present just before it (double-tap echo)")
            return
        }
        frameSeq += 1
        let id = frameSeq
        StackSurface.modalFrames[id] = surface
        surface.store.frameId = id        // a modal's chrome claim carries ITS id (never in nav.stack) → dropped, not the app bar's
        let kind = (mode == "cover" || mode == "overlay") ? mode : "sheet"
        var e: [String: Any] = ["id": id, "as": kind, "component": component]
        if kind == "overlay" { e["touch"] = touch == "block" ? "block" : "passthrough" }
        if let vars, !vars.isEmpty { e["vars"] = vars }                 // LEGACY seed (documented)
        if let attrs, !attrs.isEmpty { e["attrs"] = attrs }             // THE input contract (dsx.attribute.*)
        if let detents, !detents.isEmpty { e["detents"] = detents }
        modal.append(e)
        apply()
    }

    /// Dismiss a presented modal. Default (`target` nil) pops the TOP of the presentation stack; a
    /// `target` matching a component tag or an `as:` mode removes that specific one.
    /// Dismiss-when-empty / unmatched-target is a documented no-op (never a crash).
    func dismissModal(target: String?) {
        guard !modal.isEmpty else { return }
        if let t = target, !t.isEmpty {
            guard let idx = modal.lastIndex(where: { ($0["component"] as? String) == t || ($0["as"] as? String) == t }) else { return }
            removeModal(at: idx)
        } else {
            removeModal(at: modal.count - 1)
        }
    }

    /// The kernel host reports an INTERACTIVE dismissal (swipe / tap-away) of the modal carrying `id`.
    /// Keyed by IDENTITY, not position, so the report is IDEMPOTENT: SwiftUI also writes nil back to an
    /// item binding after a PROGRAMMATIC dismissal completes (and a cascade tears down several
    /// presentations at once, each writing nil) — an id that's already gone is simply a no-op, never an
    /// over-pop of an unrelated modal. The modal twin of `hostTruncate`: `global.nav.modal` stays the
    /// single source of truth (SwiftUI never dismisses behind the model's back).
    func hostDismissedModal(id: Int) {
        guard let idx = modal.firstIndex(where: { ($0["id"] as? Int) == id }) else { return }
        removeModal(at: idx)
    }

    /// Remove the modal at `idx` plus its presentation DESCENDANTS, honoring the topology the host
    /// renders: a CHAIN entry (sheet / cover) is the presentation parent of every LATER chain entry
    /// (RouterHost nests them — each is presented from within the previous one), so a child cannot
    /// outlive its parent, and removing only a middle chain entry would shift its descendants down a
    /// positional slot and force the exact non-nil→non-nil item swap the nested host avoids. An
    /// OVERLAY is an independent, non-presenting layer: dismissing one removes just it (chain
    /// positions skip overlays, so nothing shifts), and a chain dismiss leaves later overlays alive.
    /// Each removed surface's onDismiss runs (parent-first) + it frees via `releaseModal`.
    private func removeModal(at idx: Int) {
        echoMemo = nil                    // a modal removal re-arms the double-tap echo guard
        func isOverlay(_ e: [String: Any]) -> Bool { (e["as"] as? String) == "overlay" }
        var gone = [modal[idx]]
        if !isOverlay(modal[idx]), idx + 1 < modal.count {
            gone += modal[(idx + 1)...].filter { !isOverlay($0) }   // later chain entries = descendants
        }
        let goneIds = gone.compactMap { $0["id"] as? Int }
        modal.removeAll { e in (e["id"] as? Int).map(goneIds.contains) ?? false }
        apply()
        for id in goneIds { StackSurface.releaseModal(id) }
    }

    // MARK: name-only entry (markup / web — the kernel builds the surface in the caller's scope)

    /// Build a surface for a component `tag`, scoped to `scope` (the caller's package; nil → global /
    /// qualified). The kernel names nobody: the tag resolves against the component registry in that
    /// scope at render time. nil for an empty / unparsable tag (fail-open — the verb no-ops).
    private func buildSurface(_ component: String, scope: String?, vars: [String: Any]?,
                              attrs: [String: Any]? = nil) -> StackSurface? {
        let tag = component.trimmingCharacters(in: .whitespaces)
        guard !tag.isEmpty, let root = StackXML.parse("<\(tag)/>") else { return nil }
        let surface = StackSurface(root: root, webView: dsx.shared.use("web") as? UIView, scope: scope, dsx: dsx)
        if let vars, !vars.isEmpty { surface.store.set("vars", vars) }   // LEGACY seed (documented)
        // THE input contract: seed the reactive `dsx.attribute` dict through the same pipe a
        // hard-coding consumer's props ride (surface.attribute — runtime values win over the
        // head's `default=`s; later updateComponent writes recalc bindings + fire on:change).
        if let attrs { for (k, v) in attrs { surface.attribute(k, v) } }
        return surface
    }

    /// Push a component (by name, caller-scoped) as a native nav frame — the name-only twin of
    /// `StackSurface.push(from:)` behind the markup / web `dsx.component.push` verb.
    /// A failed surface build is LOGGED, never silent — the caller's resolve may already have
    /// fired (resolve-first callers), so this log is the only trace a screen never appeared.
    func pushComponent(name: String, scope: String?, path: String, vars: [String: Any]?,
                       attrs: [String: Any]? = nil) {
        guard let surface = buildSurface(name, scope: scope, vars: vars, attrs: attrs) else {
            kernelLog("[Router] pushComponent(\"\(name)\") no-op — empty or unparsable component tag; no frame was pushed")
            return
        }
        pushNative(surface, path: path, component: name, vars: vars, attrs: attrs, scope: scope)
    }

    /// Present a component (by name, caller-scoped) as a state-backed modal — the name-only twin of
    /// `presentModal` behind the markup / web `dsx.component.present` verb. Failed build → logged (see pushComponent).
    func presentComponent(name: String, scope: String?, mode: String, vars: [String: Any]?,
                          detents: [String]?, touch: String? = nil, attrs: [String: Any]? = nil) {
        guard let surface = buildSurface(name, scope: scope, vars: vars, attrs: attrs) else {
            kernelLog("[Router] presentComponent(\"\(name)\") no-op — empty or unparsable component tag; nothing was presented")
            return
        }
        presentModal(surface, mode: mode, component: name, vars: vars, detents: detents, touch: touch,
                     attrs: attrs)
    }

    /// updateComponent — LIVE attribute updates on an open frame/modal: the reactive half of the
    /// attribute contract. Merges into the entry's published `attrs` (state stays the truth —
    /// entries are REPLACED, never mutated in place) AND re-seeds the held surface's reactive
    /// `dsx.attribute` dict through the same pipe a hard-coding consumer's prop change rides —
    /// bindings recalc and `<attribute on:change>` fires. Target matching = the dismiss rule
    /// (component tag or `as:` mode, deepest-last, modals first then stack frames); nil → the
    /// top-most presented entry, else the top frame. Unmatched → documented no-op.
    func updateComponent(target: String?, attrs: [String: Any]) {
        guard !attrs.isEmpty else { return }
        func updated(_ e: [String: Any]) -> [String: Any] {
            var copy = e
            var merged = (e["attrs"] as? [String: Any]) ?? [:]
            for (k, v) in attrs { merged[k] = v }
            copy["attrs"] = merged
            return copy
        }
        func reseed(_ e: [String: Any]) {
            if let id = e["id"] as? Int,
               let surface = StackSurface.modalFrames[id] ?? StackSurface.pushedFrames[id] {
                for (k, v) in attrs { surface.attribute(k, v) }
            }
        }
        let mIdx: Int?
        if let t = target, !t.isEmpty {
            mIdx = modal.lastIndex(where: { ($0["component"] as? String) == t || ($0["as"] as? String) == t })
        } else {
            mIdx = modal.isEmpty ? nil : modal.count - 1
        }
        if let idx = mIdx {
            modal[idx] = updated(modal[idx])
            reseed(modal[idx])
            apply()
            return
        }
        let sIdx: Int?
        if let t = target, !t.isEmpty {
            sIdx = stack.lastIndex(where: { ($0["component"] as? String) == t })
        } else {
            sIdx = stack.isEmpty ? nil : stack.count - 1
        }
        if let idx = sIdx {
            stack[idx] = updated(stack[idx])
            reseed(stack[idx])
            apply()
        }
    }

    /// Publish the stack: `nav.stack` (frames) + `nav.canPop` / `nav.depth` (back affordances), and
    /// `route` = the top (so every `route.*` reader keeps working). `lastResolvedPath` is synced so
    /// the path observer doesn't re-fire on our own writes.
    private func apply() {
        let top = stack.last ?? ["path": "/",
                                 "view": rootFold?.winner?.view ?? AppManifest.entry.surfaces.first?.view ?? "",
                                 "src": "", "params": [:]]
        lastResolvedPath = top["path"] as? String
        // Chrome specs live and die with their frames — but a POPPED frame's spec gets a GRACE
        // through the exit animation (0.6s, the releasePushed window): pruning at pop start
        // blanked the outgoing screen's bar while it was still sliding out (the "flashes on
        // the way out" report). Frame ids are monotonic, so a graced id can never be reclaimed;
        // the deferred drop re-runs apply(), so published state still converges to pruned.
        let live = Set(stack.compactMap { $0["id"].map { "\($0)" } })
        for key in chrome.keys where !live.contains(key) && !chromeGrace.contains(key) {
            chromeGrace.insert(key)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                guard let self else { return }
                self.chromeGrace.remove(key)
                if self.chrome.removeValue(forKey: key) != nil { self.apply() }
            }
        }
        // The path observer stands down until BOTH writes land (see resolveIfPathChanged).
        // Saved/restored, not cleared: a nested publish must never un-guard an outer one.
        let wasPublishing = publishing
        publishing = true
        defer { publishing = wasPublishing }
        // One observable commit: RouterHost must never render a new NavigationStack path against
        // the previous `route`, and a route verb must not pay for two full SwiftUI passes before
        // its native destination can become interactive.
        // REDUCE MOTION REMOVES THE TRANSITION, it does not outlast it. RouterHost's
        // `.modifier(RouterReducedMotionTransaction())` governs that view's OWN updates; it never
        // reaches the UIKit push NavigationStack performs in response to THIS commit, so the slide
        // kept running under Reduce Motion — measured 0.323s of visual settle against a 0.20s
        // budget, and flat across a 15x swing in machine load, which is the signature of a fixed
        // animation cost rather than contention. The state change IS the animation trigger, so the
        // suppression has to wrap the commit itself. The modifier stays: it still covers the
        // surrounding view updates, and both halves are pinned as native-identity anchors.
        //
        // One publish, not two branches: `disablesAnimations = false` is exactly the old behaviour,
        // so the normal path is unchanged and the atomic-publication anchor below stays verbatim.
        // `withTransaction`'s closure is non-escaping, which is what keeps `stack`/`modal`/`chrome`
        // spelled bare here — a `let commit = { … }` variable would force `self.` and silently
        // break `apple-atomic-router-publication`.
        var transaction = Transaction()
        transaction.disablesAnimations = Router.reducedMotionActive
        withTransaction(transaction) {
            DSX.state.setTopLevelAtomically([
                "nav": ["stack": stack, "canPop": stack.count > 1, "depth": stack.count,
                        "modal": modal, "chrome": chrome],
                "route": top,
            ])
        }
    }

    /// The system Reduce Motion switch, plus the DEBUG qualification mirror. The fixture cannot
    /// flip a real accessibility setting, so it launches with `-UIAccessibilityReduceMotionEnabled
    /// YES`, which lands in UserDefaults and NOT in `UIAccessibility.isReduceMotionEnabled` — the
    /// same pair `RouterReducedMotionTransaction` reads, kept in lock-step with it deliberately.
    private static var reducedMotionActive: Bool {
        if UIAccessibility.isReduceMotionEnabled { return true }
        #if DEBUG
        return RouterUIQualificationProbe.shared.enabled
            && UserDefaults.standard.bool(forKey: "UIAccessibilityReduceMotionEnabled")
        #else
        return false
        #endif
    }

    /// Truthiness of a `global.*` state value for a route `guard` — nil / NSNull / false / 0 / "" /
    /// "false" / "0" / empty collection are falsy; everything else is truthy. (Total, allocation-free.)
    private static func truthy(_ v: Any?) -> Bool {
        switch v {
        case .none, is NSNull:        return false
        case let b as Bool:           return b
        case let n as NSNumber:       return n.doubleValue != 0
        case let s as String:         return !s.isEmpty && s != "false" && s != "0"
        case let a as [Any]:          return !a.isEmpty
        case let d as [String: Any]:  return !d.isEmpty
        default:                      return true
        }
    }

    /// A throwaway store for evaluating route `guard` predicates. JSE resolves `global.*` / `route.*`
    /// against `DSX.state` (NOT this store), and `JSE.eval` self-restores its depth budget (`defer`),
    /// so ONE reused main-thread store is safe and allocation-free — a guard can only READ app state.
    private static let guardStore = StackStore()

    /// "In scope" = compiled into this binary AND not excluded: a package scheme (ModuleRegistry)
    /// or a component tag (StackComponents). The capability floor. (Static capability query — the
    /// kernel asking its own registries; not cross-package signaling.)
    private static func available(_ name: String) -> Bool {
        ModuleRegistry.shared.isAvailable(name) || StackComponents.has(name)
    }
}
