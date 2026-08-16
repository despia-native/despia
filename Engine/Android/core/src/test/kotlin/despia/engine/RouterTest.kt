package despia.engine

import java.io.File
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Router — the kernel nav runtime. RouterHost (SwiftUI/Compose) is NOT ported; these tests pin
 * its CONTRACT with the runtime: the state shapes published to `global.nav.*` / `global.route`
 * (stack verbs, chrome specs + pruning, hostTruncate depth math, the modal chain) and the
 * resolution ladder (table match, capability gate, guard/redirect, fallback).
 * `DSX.state` is a process singleton — each test resets the router keys and every seam it swaps.
 */
class RouterTest {

    private var router: Router? = null
    private val broadcasts = mutableListOf<Pair<String, JSON>>()
    private val popped = mutableListOf<Pair<Int, Any>>()
    private val dismissed = mutableListOf<Pair<Int, Any>>()

    @BeforeEach fun fresh() {
        DSX.state.set("route", emptyMap<String, Any?>())
        DSX.state.set("nav", emptyMap<String, Any?>())
        DSX.state.set("routes", emptyList<Any?>())
        DSX.state.set("session", emptyMap<String, Any?>())
        StackSurface.pushedFrames.clear()
        StackSurface.modalFrames.clear()
        StackSurface.onPop = { id, s -> popped.add(id to s) }
        StackSurface.onDismiss = { id, s -> dismissed.add(id to s) }
        // The default TEST plan (root-plan.md): boot mounts the plan's first candidate — the
        // retired no-manifest web floor is gone, so a rooted boot needs a declared plan. Tests
        // exercising other shapes install their own manifest (surfaces grammar only).
        AppManifest.manifestLoader = { """{ "entry": { "root": "/", "surfaces": ["DSXWebView"] } }""" }
    }

    @AfterEach fun teardown() {
        router?.shutdown()
        router = null
        Router.shared = null
        ScreenReadiness.suppressedDeadlineFrame = null   // the boot fold's handshake never leaks across tests
        StackSurface.onPop = { _, _ -> }
        StackSurface.onDismiss = { _, _ -> }
        StackSurface.pushedFrames.clear()
        StackSurface.modalFrames.clear()
        JSE.stateVars = { emptyMap() }
        JSE.moduleAvailable = { false }
        JSE.componentAvailable = null    // "no component registry here" — :core ships none
        ScreenReadiness.webSurfaceTags.clear()   // process-global, like every other seam here
        AppManifest.manifestLoader = { null }
        AppManifest.routesLoader = { null }
    }

    /** A module standing in for a dying surface: when the fold announces `root.failed`, it
     *  raises a root-attributed error, which is the window where `live` is already cleared but
     *  `root.live` is still true. Registered only by the between-attempts test. */
    private class TeardownRaiser : Module() {
        override val scheme get() = "rt.teardown"
        override fun setup() {
            dsx.delegate.listen("root.failed") { _ ->
                val next = ((DSX.state.getPath("dsx.errorCount") as? Int) ?: 0) + 1
                DSX.state.setPath("dsx.lastError", mapOf("origin" to "root", "code" to "teardown"))
                DSX.state.setPath("dsx.errorCount", next)
                null
            }
        }
    }

    /** The unstamped raiser's twin WITH the production stamp: it reads the failed attempt's
     *  index off the `root.failed` payload — the identity a real surface captures from
     *  `root.attempt` at emission (Dom.kt handleWebFailure) — and rides it as `data.attempt`.
     *  Its raise is re-entrant (inside the fire, inside a state-sink drain), so the mailbox
     *  DEFERS delivery until after the successor has mounted: exactly the window where an
     *  unstamped error kills the successor and a stamped one is dropped as stale. */
    private class StampedTeardownRaiser : Module() {
        override val scheme get() = "rt.stamped"
        override fun setup() {
            dsx.delegate.listen("root.failed") { input ->
                val idx = ((input as? Map<*, *>)?.get("index") as? Number)?.toInt()
                val next = ((DSX.state.getPath("dsx.errorCount") as? Int) ?: 0) + 1
                DSX.state.setPath("dsx.lastError", mapOf(
                    "origin" to "root", "code" to "teardown",
                    "data" to mapOf("attempt" to idx)))
                DSX.state.setPath("dsx.errorCount", next)
                null
            }
        }
    }

    private fun makeRouter(): Router {
        val r = Router()
        r.broadcast = { event, data -> broadcasts.add(event to data) }
        r.setup()
        r.boot()
        router = r
        return r
    }

    @Suppress("UNCHECKED_CAST")
    private fun navStack(): List<Map<String, Any?>> =
        (DSX.state.getPath("nav.stack") as List<*>).map { it as Map<String, Any?> }

    @Suppress("UNCHECKED_CAST")
    private fun navModal(): List<Map<String, Any?>> =
        (DSX.state.getPath("nav.modal") as List<*>).map { it as Map<String, Any?> }

    private fun navDepth(): Int = DSX.state.getPath("nav.depth") as Int
    private fun canPop(): Boolean = DSX.state.getPath("nav.canPop") as Boolean
    private fun topPath(): String? = DSX.state.getPath("route.path") as? String

    // MARK: boot — the RouterHost contract (state shapes)

    @Test fun bootSeedsARootFallbackFrameAndPublishesTheHostContract() {
        makeRouter()
        val nav = DSX.state.getPath("nav") as Map<*, *>
        assertEquals(setOf("stack", "canPop", "depth", "modal", "chrome"), nav.keys)  // the host reads exactly these
        assertEquals(1, navDepth())
        assertFalse(canPop())
        assertTrue(navModal().isEmpty())
        assertEquals("/", topPath())                              // entry.root default (no App.json)
        assertEquals("DSXWebView", DSX.state.getPath("route.view"))   // no table → configured fallback
        assertEquals("", DSX.state.getPath("route.src"))
        val top = navStack().last()
        assertTrue(setOf("path", "view", "src", "params", "query", "id").all { it in top.keys })
        assertEquals(top["id"], (DSX.state.getPath("route") as Map<*, *>)["id"])  // route == the top frame
    }

    @Test fun androidBackgroundProcessDefersRootDeadlineUntilTheSurfaceHostMounts() {
        val r = Router()
        r.setup()
        r.deferBootUntilSurfaceHost()
        router = r

        r.boot()
        assertEquals(null, DSX.state.getPath("nav.stack"))
        assertEquals(null, DSX.state.getPath("route.path"))

        r.surfaceHostMounted()
        assertEquals("DSXWebView", navStack().single()["view"])
        assertEquals("/", topPath())

        // Activity recreation must not replay or replace the live root.
        val firstId = navStack().single()["id"]
        r.surfaceHostMounted()
        assertEquals(firstId, navStack().single()["id"])
    }

    // MARK: stack verbs round-trip through DSX.state

    @Test fun pushPopRoundTrip() {
        val r = makeRouter()
        r.push("/cart")
        assertEquals(2, navDepth())
        assertTrue(canPop())
        assertEquals("/cart", topPath())
        r.pop()
        assertEquals(1, navDepth())
        assertFalse(canPop())
        assertEquals("/", topPath())
        r.pop()                                                   // pop at root is a documented no-op
        assertEquals(1, navDepth())
    }

    @Test fun replaceSwapsTheTopAndResetClearsToASingleRoot() {
        val r = makeRouter()
        r.push("/a")
        r.push("/b")
        assertEquals(3, navDepth())
        r.replace("/c")
        assertEquals(3, navDepth())                               // no history growth
        assertEquals("/c", topPath())
        r.reset("/home")
        assertEquals(1, navDepth())
        assertEquals("/home", topPath())
        assertFalse(canPop())
    }

    @Test fun aRoutePathWriteNavigatesInPlaceAsAReplace() {
        val r = makeRouter()
        r.push("/a")
        DSX.state.setPath("route.path", "/b")                     // web despia.navigate / `set: route.path = …`
        assertEquals(2, navDepth())                               // REPLACE, not a push
        assertEquals("/b", topPath())
    }

    // MARK: resolution (table match + params/query, capability gate, guard, fallback)

    @Test fun routeTableResolutionExtractsParamsAndPercentDecodedQuery() {
        DSX.state.set("routes", listOf(mapOf("path" to "/p/{id}", "view" to "Product",
                                             "src" to "/dsx/p/", "origin" to "shop")))
        val r = makeRouter()
        r.push("/p/42?ref=a%20b&flag")
        assertEquals("Product", DSX.state.getPath("route.view"))
        assertEquals("/dsx/p/", DSX.state.getPath("route.src"))
        assertEquals("shop", DSX.state.getPath("route.origin"))
        assertEquals("/p/42?ref=a%20b&flag", topPath())           // the FULL path round-trips
        assertEquals("42", DSX.state.getPath("route.params.id"))
        assertEquals("a b", DSX.state.getPath("route.query.ref"))
        assertEquals("", DSX.state.getPath("route.query.flag"))   // bare key → ""
    }

    @Test fun missingCapabilityFallsThroughToFallbackAndBroadcasts() {
        DSX.state.set("routes", listOf(mapOf("path" to "/camera", "view" to "Camera",
                                             "requires" to listOf("camera"))))
        val r = makeRouter()
        r.push("/camera")
        assertEquals("DSXWebView", DSX.state.getPath("route.view"))   // unavailable → fell to fallback
        val (event, data) = broadcasts.last()
        assertEquals("route_unavailable", event)
        assertEquals(JSON.from(mapOf("path" to "/camera", "missing" to listOf("camera"),
                                     "reason" to "missing_capability")), data)
        // shipped capability → the route resolves
        JSE.moduleAvailable = { it == "camera" }
        r.push("/camera")
        assertEquals("Camera", DSX.state.getPath("route.view"))
    }

    @Test fun guardRedirectsOnFalsyStateAndDepthCapsCycles() {
        JSE.stateVars = { DSX.state.vars }                        // boot's binding (see Router.kt NOTES)
        DSX.state.set("routes", listOf(
            mapOf("path" to "/account", "view" to "Account",
                  "guard" to "global.session.token", "redirect" to "/login"),
            mapOf("path" to "/login", "view" to "Login")))
        val r = makeRouter()
        r.push("/account")                                        // no token → falsy → redirect
        assertEquals("Login", DSX.state.getPath("route.view"))
        assertEquals("/login", topPath())
        DSX.state.setPath("session.token", "abc")
        r.push("/account")                                        // truthy → access
        assertEquals("Account", DSX.state.getPath("route.view"))
        // a guard CYCLE is depth-capped (8), landing on the fallback — never a hang
        DSX.state.set("routes", listOf(
            mapOf("path" to "/x", "view" to "X", "guard" to "false", "redirect" to "/y"),
            mapOf("path" to "/y", "view" to "Y", "guard" to "false", "redirect" to "/x")))
        r.push("/x")
        assertEquals("DSXWebView", DSX.state.getPath("route.view"))
        // fail-open: guard falsy with NO redirect ⇒ the entry simply doesn't match
        DSX.state.set("routes", listOf(mapOf("path" to "/z", "view" to "Z", "guard" to "false")))
        r.push("/z")
        assertEquals("DSXWebView", DSX.state.getPath("route.view"))
    }

    // MARK: #1002 chrome — spec write + prune with the stack

    @Test fun chromeSpecWritesToTheTopFrameAndPrunesWithTheStack() {
        val r = makeRouter()
        r.push("/a")
        val topId = navStack().last()["id"]
        r.chrome(mapOf("title" to "Cart", "large" to "true"))
        val spec = DSX.state.getPath("nav.chrome.$topId") as Map<*, *>
        assertEquals("Cart", spec["title"])
        assertEquals(true, spec["large"])
        r.chrome(mapOf("title" to "Cart"))                        // large absent → false
        assertEquals(false, (DSX.state.getPath("nav.chrome.$topId") as Map<*, *>)["large"])
        r.chrome(mapOf("show" to "false"))                        // release the claim
        assertTrue((DSX.state.getPath("nav.chrome") as Map<*, *>).isEmpty())
        r.chrome(mapOf("title" to "Cart", "large" to true))       // JS callers send REAL booleans
        assertEquals(true, (DSX.state.getPath("nav.chrome.$topId") as Map<*, *>)["large"])
        r.chrome(mapOf("show" to false))                          // boolean release too
        assertTrue((DSX.state.getPath("nav.chrome") as Map<*, *>).isEmpty())
        r.chrome(mapOf("title" to "Again"))
        r.pop()                                                   // spec dies with its frame
        assertTrue((DSX.state.getPath("nav.chrome") as Map<*, *>).isEmpty())
        // reset prunes too (one prune in apply() covers every verb)
        r.push("/b")
        r.chrome(mapOf("title" to "B"))
        r.reset("/home")
        assertTrue((DSX.state.getPath("nav.chrome") as Map<*, *>).isEmpty())
    }

    // MARK: chrome frame targeting — a claim names its OWN frame via the `__frame` framing key
    // (Router.swift 1:1). A covered screen's re-fired `on:appear` mid-back-swipe must write to
    // ITS frame, never whatever is top; a stamped id that's not in the stack (a popped frame's
    // late claim, a MODAL surface's NavBar) is dropped.

    @Test fun chromeClaimTargetsItsStampedFrameNotTheTop() {
        val r = makeRouter()
        r.push("/covered")
        val coveredId = navStack().last()["id"]
        r.push("/top")
        val topId = navStack().last()["id"]
        // the COVERED screen re-claims mid-transition (its on:appear re-fired): the spec lands
        // on ITS frame — the outgoing top keeps its own bar (the wrong-title/flash bug). The
        // top's bar is its PUSH-TIME derived spec ("/top" → "Top" — every pushed web frame
        // gets one now), untouched by the covered frame's claim.
        r.chrome(mapOf("title" to "Covered", "large" to true, "__frame" to coveredId))
        assertEquals("Covered", (DSX.state.getPath("nav.chrome.$coveredId") as Map<*, *>)["title"])
        assertEquals(mapOf("title" to "Top", "large" to false), DSX.state.getPath("nav.chrome.$topId"))
        // the top claims its own — both specs coexist, each keyed to its frame
        r.chrome(mapOf("title" to "Top", "__frame" to topId))
        assertEquals("Top", (DSX.state.getPath("nav.chrome.$topId") as Map<*, *>)["title"])
        // a Double id (a JSON round-trip) still targets — NavFrame.intId parity
        r.chrome(mapOf("title" to "TopD", "__frame" to (topId as Int).toDouble()))
        assertEquals("TopD", (DSX.state.getPath("nav.chrome.$topId") as Map<*, *>)["title"])
        // frame-scoped release: show:"false" from the covered screen releases ITS claim only
        r.chrome(mapOf("show" to "false", "__frame" to coveredId))
        assertEquals(null, DSX.state.getPath("nav.chrome.$coveredId"))
        assertEquals("TopD", (DSX.state.getPath("nav.chrome.$topId") as Map<*, *>)["title"])
        // a stamped id that's NOT in the stack (a modal surface / a popped frame) is dropped
        r.chrome(mapOf("title" to "Sheet", "__frame" to 9999))
        assertEquals(null, DSX.state.getPath("nav.chrome.9999"))
        // no stamp → the previous top-frame behavior (web callers, mounted overlays)
        r.chrome(mapOf("title" to "Bare"))
        assertEquals("Bare", (DSX.state.getPath("nav.chrome.$topId") as Map<*, *>)["title"])
    }

    // MARK: push-time chrome — the bar rides the push (Router.swift chromeHint/chromeGrace 1:1):
    // a component's LIVE claim is remembered by name and seeds the NEXT push of that component in
    // the same publish that adds the frame (no bar-less first frames on reopen), and a popped
    // frame's spec survives through the deferChromePrune seam (inline by default — the immediate
    // prune the older tests pin; the render host wires the 0.6s exit-animation grace).

    @Test fun liveClaimSeedsTheNextPushOfTheSameComponent() {
        val r = makeRouter()
        r.pushComponent("Cart", scope = null, path = "", vars = null)
        r.chrome(mapOf("title" to "Your cart", "large" to true))       // the live claim (top-targeted)
        r.pop()                                                        // frame gone, spec pruned (inline seam)
        assertTrue((DSX.state.getPath("nav.chrome") as Map<*, *>).isEmpty())
        r.pushComponent("Cart", scope = null, path = "", vars = null)  // reopen
        val newId = navStack().last()["id"]
        val seeded = DSX.state.getPath("nav.chrome.$newId") as? Map<*, *>
        assertEquals("Your cart", seeded?.get("title"))                // seeded BEFORE any claim
        assertEquals(true, seeded?.get("large"))
        // a show:"false" release forgets the memory — the next push seeds nothing
        r.chrome(mapOf("show" to "false"))
        r.pop()
        r.pushComponent("Cart", scope = null, path = "", vars = null)
        assertEquals(null, DSX.state.getPath("nav.chrome.${navStack().last()["id"]}"))
    }

    @Test fun poppedFramesChromeIsGracedThroughTheExitAnimation() {
        val r = makeRouter()
        val pending = ArrayList<() -> Unit>()
        r.deferChromePrune = { pending.add(it) }                       // the render host's 0.6s post, captured
        r.push("/a")
        val id = navStack().last()["id"]
        r.chrome(mapOf("title" to "A"))
        r.pop()                                                        // exit animation begins
        assertEquals("A", (DSX.state.getPath("nav.chrome.$id") as? Map<*, *>)?.get("title"))   // spec survives the slide-out
        pending.forEach { it() }                                       // the grace expires
        assertTrue((DSX.state.getPath("nav.chrome") as Map<*, *>).isEmpty())
    }

    // MARK: the double-tap echo guard — an identical consecutive NAMED push/present inside the
    // window is one tap dispatched twice (the transition hasn't covered the screen yet), never
    // intent (Router.swift 1:1). Different inputs are intent; any reduction re-arms the guard;
    // URL pushes and unnamed held-surface frames (the corpus shape) bypass it entirely.

    @Test fun doubleTapEchoPushesAndPresentsAreDroppedAndReductionsRearm() {
        val r = makeRouter()
        r.pushComponent("Cart", scope = null, path = "", vars = null)
        r.pushComponent("Cart", scope = null, path = "", vars = null)          // the echo
        assertEquals(2, navDepth())                                            // root + ONE Cart
        r.pushComponent("Cart", scope = null, path = "", vars = mapOf("sku" to "gold"))
        assertEquals(3, navDepth())                                            // different vars = intent
        r.pop()                                                                // reduction re-arms
        assertEquals(2, navDepth())
        r.pushComponent("Cart", scope = null, path = "", vars = mapOf("sku" to "gold"))
        assertEquals(3, navDepth())                                            // replay after pop lands
        // presents: an identical consecutive present is the same echo; dismissal re-arms
        r.presentComponent("Paywall", scope = null, mode = "sheet", vars = null, detents = null)
        r.presentComponent("Paywall", scope = null, mode = "sheet", vars = null, detents = null)
        assertEquals(1, navModal().size)
        r.dismissModal(null)
        r.presentComponent("Paywall", scope = null, mode = "sheet", vars = null, detents = null)
        assertEquals(1, navModal().size)
        // unnamed held-surface frames (no component, no path) bypass the guard — the popTo
        // corpus pushes them back-to-back and every one must land
        r.pushNative(surface = "held", path = "")
        r.pushNative(surface = "held", path = "")
        assertEquals(5, navDepth())
    }

    // MARK: popTo / popToRoot — the multi-pop verbs (ONE truncation; RN popTo/popToTop,
    // Flutter popUntil parity). Matching is concrete and query-insensitive ON BOTH SIDES,
    // deepest wins, fail-open on no match / top match / empty path — the rule is pinned by
    // the SHARED corpus (OpenSource/Conformance/router/popto.json, executed below).

    @Test fun popToPopsToTheDeepestMatchAndPopToRootClearsToRoot() {
        val r = makeRouter()
        r.push("/a")
        r.push("/p?x=1")
        r.push("/b")
        r.push("/c")
        r.popTo("/nowhere")                                       // no match → no-op
        assertEquals(5, navDepth())
        r.popTo("")                                               // empty path → no-op
        assertEquals(5, navDepth())
        r.popTo("/c")                                             // deepest match IS the top → no-op
        assertEquals(5, navDepth())
        r.popTo("/p?x=9")                                         // query-insensitive on BOTH sides
        assertEquals(3, navDepth())
        assertEquals("/p?x=1", topPath())
        r.push("/b")
        r.popTo("/a")                                             // plain match truncates for real
        assertEquals(2, navDepth())
        assertEquals("/a", topPath())
        r.popToRoot()
        assertEquals(1, navDepth())
        assertFalse(canPop())
        r.popToRoot()                                             // at root → no-op
        assertEquals(1, navDepth())
    }

    @Test fun popToReleasesNativeFramesInThePoppedTailAndLeavesModalsPresented() {
        val r = makeRouter()
        r.push("/a")
        r.pushNative(surface = "held", path = "")                 // a module-pushed frame above /a
        r.push("/b")
        r.presentModal(surface = "m", mode = "sheet", component = "Confirm", vars = null, detents = null)
        r.popTo("/a")
        assertEquals(2, navDepth())
        assertEquals("/a", topPath())
        assertEquals(1, popped.size)                              // the tail's native surface ran onPop
        assertEquals(1, navModal().size)                          // stack verbs never dismiss modals
        // chrome pruned WITH the stack: only the live pushed web frame's own PUSH-TIME derived
        // bar ("/a" → "A" — materialize()'s pushed-web-frame rule) survives; the popped tail's
        // specs are gone.
        val chrome = DSX.state.getPath("nav.chrome") as Map<*, *>
        assertEquals(1, chrome.size)
        assertEquals("A", (chrome.values.single() as Map<*, *>)["title"])
    }

    /// The SHARED popTo corpus — the web dom test runs the SAME file over the pure rule;
    /// Router.swift is the compile-pending reference (the three-runtime law). Driven END-TO-END
    /// here: boot the runtime, push each corpus path (null = a module-pushed pathless frame,
    /// whose synthetic /__native/<id> path no real target names), run the verb, assert the
    /// truncation the expected index implies.
    @Test fun popToMatchesTheSharedConformanceCorpus() {
        val text = File("../../../Conformance/router/popto.json").readText()
        @Suppress("UNCHECKED_CAST")
        val cases = (json(text).foundationValue as Map<String, Any?>)["cases"] as List<Any?>
        assertTrue(cases.size >= 10, "expected a populated corpus, got ${cases.size}")
        for (raw in cases) {
            @Suppress("UNCHECKED_CAST")
            val case = raw as Map<String, Any?>
            val name = case["name"] as String
            val paths = case["paths"] as List<Any?>
            val target = case["target"] as String
            val expect = (case["expect"] as Number).toInt()
            assertEquals("/", paths.first(), "corpus roots must be the boot frame ($name)")

            DSX.state.set("route", emptyMap<String, Any?>())      // per-case reset (loop shares the singleton)
            DSX.state.set("nav", emptyMap<String, Any?>())
            val r = makeRouter()
            for (p in paths.drop(1)) {
                if (p is String) r.push(p) else r.pushNative(surface = "held", path = "")
            }
            assertEquals(paths.size, navDepth(), name)
            r.popTo(target)
            if (expect < 0 || expect == paths.size - 1) {
                assertEquals(paths.size, navDepth(), "$name — expected a no-op")
            } else {
                assertEquals(expect + 1, navDepth(), name)
                assertEquals(paths[expect], topPath(), name)
            }
            r.shutdown()                                          // cancel this case's observer before the next
            Router.shared = null
            StackSurface.pushedFrames.clear()
        }
    }

    /// The presentation-machine corpus (present.json — Conformance/router/README): `as`/`touch`
    /// normalization + the dismissal topology, driven through the REAL runtime (presentModal /
    /// dismissModal); the web PresentLedger runs the same file, Router.swift is the reference.
    @Test fun presentMachineMatchesTheSharedConformanceCorpus() {
        val text = File("../../../Conformance/router/present.json").readText()
        @Suppress("UNCHECKED_CAST")
        val cases = (json(text).foundationValue as Map<String, Any?>)["cases"] as List<Any?>
        assertTrue(cases.size >= 8, "expected a populated corpus, got ${cases.size}")
        for (raw in cases) {
            @Suppress("UNCHECKED_CAST")
            val case = raw as Map<String, Any?>
            val name = case["name"] as String
            DSX.state.set("route", emptyMap<String, Any?>())      // per-case reset (shared singleton)
            DSX.state.set("nav", emptyMap<String, Any?>())
            StackSurface.modalFrames.clear()
            val r = makeRouter()
            @Suppress("UNCHECKED_CAST")
            for (rawStep in case["steps"] as List<Any?>) {
                val step = rawStep as Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                (step["present"] as? Map<String, Any?>)?.let { p ->
                    @Suppress("UNCHECKED_CAST")
                    r.presentModal(surface = "held", mode = (p["as"] as? String) ?: "",
                                   component = (p["component"] as? String) ?: "",
                                   vars = null, detents = null, touch = p["touch"] as? String,
                                   attrs = p["attrs"] as? Map<String, Any?>)
                }
                @Suppress("UNCHECKED_CAST")
                (step["update"] as? Map<String, Any?>)?.let { u ->
                    @Suppress("UNCHECKED_CAST")
                    r.updateComponent(u["target"] as? String,
                                      (u["attrs"] as? Map<String, Any?>) ?: emptyMap())
                }
                if (step.containsKey("dismiss")) {
                    @Suppress("UNCHECKED_CAST")
                    val d = step["dismiss"] as? Map<String, Any?> ?: emptyMap()
                    r.dismissModal(d["target"] as? String)
                }
            }
            @Suppress("UNCHECKED_CAST")
            val expect = case["modal"] as List<Any?>
            val got = navModal()
            assertEquals(expect.size, got.size, name)
            expect.forEachIndexed { i, e ->
                @Suppress("UNCHECKED_CAST")
                val em = e as Map<String, Any?>
                assertEquals(em["as"], got[i]["as"], "$name [$i].as")
                assertEquals(em["component"], got[i]["component"], "$name [$i].component")
                assertEquals(em["touch"], got[i]["touch"], "$name [$i].touch")
                assertEquals(em["attrs"], got[i]["attrs"], "$name [$i].attrs")
            }
            r.shutdown()
            Router.shared = null
            StackSurface.modalFrames.clear()
        }
    }

    // MARK: the attribute contract — attrs seed + live updateComponent (state side)

    @Test fun attrsRideEntriesAndUpdateComponentMergesByTarget() {
        val r = makeRouter()
        r.pushNative(surface = "held", path = "", component = "Canvas",
                     vars = null, attrs = mapOf("id" to "42"))
        assertEquals(mapOf("id" to "42"), navStack().last()["attrs"])
        r.presentModal(surface = "m", mode = "overlay", component = "Bar",
                       vars = null, detents = null, touch = "passthrough",
                       attrs = mapOf("theme" to "dark"))
        assertEquals(mapOf("theme" to "dark"), navModal().last()["attrs"])

        r.updateComponent("Bar", mapOf("theme" to "light", "badge" to "3"))   // modal wins, merge
        assertEquals(mapOf("theme" to "light", "badge" to "3"), navModal().last()["attrs"])
        assertEquals(mapOf("id" to "42"), navStack().last()["attrs"])          // stack untouched

        r.updateComponent(null, mapOf("badge" to "4"))                         // null → top-most presented
        assertEquals("4", (navModal().last()["attrs"] as Map<*, *>)["badge"])

        r.dismissModal(null)
        r.updateComponent("Canvas", mapOf("id" to "43"))                       // falls to the stack frame
        assertEquals(mapOf("id" to "43"), navStack().last()["attrs"])
        r.updateComponent("Nope", mapOf("x" to "1"))                           // unmatched → documented no-op
        assertEquals(mapOf("id" to "43"), navStack().last()["attrs"])
    }

    // MARK: RouterActions — the bus-facing action table (Router.swift setup() twin)

    /// Registers the binder in the real registry and dispatches the way every caller does
    /// (markup `dsx.module.route.*` / web `route.*` → ModuleRegistry.handle by scheme+action),
    /// so a NavBar `claimChrome` reaches the runtime end-to-end at the state level.
    @Test fun routerActionsPutTheRouteTableOnTheBus() {
        makeRouter()
        ModuleRegistry.shared._resetForTests()
        ModuleRegistry.shared.register { RouterActions() }
        fun call(action: String, args: Map<String, Any?> = emptyMap()): Boolean =
            ModuleRegistry.shared.handle(scheme = "route", actionPath = action,
                                         params = Bridge.Params(dict = args, requestID = null),
                                         includeInternal = true)

        assertTrue(call("push", mapOf("path" to "/cart")))
        assertEquals(2, navDepth())
        assertEquals("/cart", topPath())

        // The chrome claim, exactly the NavBar wire shape (string values).
        val topId = navStack().last()["id"]
        assertTrue(call("chrome", mapOf("title" to "Cart", "large" to "true")))
        val spec = DSX.state.getPath("nav.chrome.$topId") as Map<*, *>
        assertEquals("Cart", spec["title"])
        assertEquals(true, spec["large"])
        assertTrue(call("chrome", mapOf("show" to "false")))      // release
        assertTrue((DSX.state.getPath("nav.chrome") as Map<*, *>).isEmpty())

        assertTrue(call("pop"))
        assertEquals(1, navDepth())
        assertTrue(call("replace", mapOf("path" to "/x")))
        assertEquals("/x", topPath())
        assertTrue(call("push", mapOf("path" to "/deep")))
        assertTrue(call("popTo", mapOf("path" to "/x")))          // dispatch proof — semantics pinned above
        assertEquals(1, navDepth())
        assertTrue(call("push", mapOf("path" to "/deep")))
        assertTrue(call("popToRoot"))
        assertEquals(1, navDepth())
        assertTrue(call("reset", mapOf("path" to "/home")))
        assertEquals(1, navDepth())
        assertEquals("/home", topPath())

        // An unroutable scheme stays unhandled (nothing hijacks the bus).
        assertFalse(ModuleRegistry.shared.handle(scheme = "not-route", actionPath = "push",
                                                 params = Bridge.Params(dict = emptyMap(), requestID = null),
                                                 includeInternal = true))
        ModuleRegistry.shared._resetForTests()
    }

    /// setup() rebinds the Router's bus seams: `reload` now reaches a `route.refresh` hook
    /// through the registry (the OTA package's refetch trigger), and hook("lifecycle.launch") boots the
    /// runtime — the iOS relay, no direct bootloader call.
    @Test fun routerActionsBindTheBusSeamsAndBootOnLaunch() {
        val r = Router()
        r.setup()                                                 // shared set; NOT booted yet
        router = r
        var refreshes = 0
        var probeSawUnbootedNav = false
        ModuleRegistry.shared._resetForTests()
        ModuleRegistry.shared.register { RouterActions() }
        ModuleRegistry.shared.register {
            object : Module() {
                override val registersWithoutScheme get() = true
                override fun setup() {
                    dsx.delegate.listen("route.refresh") { refreshes += 1; null }
                    // The launch fan-out must reach every default-priority hook BEFORE the
                    // binder's floor-priority boot (the cached-OTA-table ordering the retired
                    // direct boot() call had) — this probe registers AFTER the binder yet
                    // must still observe a not-yet-booted nav.
                    dsx.delegate.listen("lifecycle.launch") { _ ->
                        probeSawUnbootedNav = (DSX.state.getPath("nav.stack") as? List<*>).isNullOrEmpty()
                        null
                    }
                }
            }
        }

        ModuleRegistry.shared.dispatch("lifecycle.launch", null, combine = ModuleRegistry.Combine.void)                // the binder's hook boots the runtime
        assertTrue(probeSawUnbootedNav)                           // boot ran AFTER the fan-out (floor priority)
        assertEquals(1, navDepth())
        assertEquals("/", topPath())

        assertTrue(ModuleRegistry.shared.handle(scheme = "route", actionPath = "reload",
                                                params = Bridge.Params(dict = emptyMap(), requestID = null),
                                                includeInternal = true))
        assertEquals(1, refreshes)                                // fire seam → the hook bus
        ModuleRegistry.shared._resetForTests()
    }

    // MARK: hostTruncate — back-swipe depth math

    @Test fun hostTruncateIsOnlyEverAReduction() {
        val r = makeRouter()
        r.push("/a")
        r.push("/b")
        r.push("/c")                                              // root, /a, /b, /c
        r.hostTruncate(5)                                         // ≥ count → no-op (never grows)
        assertEquals(4, navDepth())
        r.hostTruncate(4)                                         // == count → no-op
        assertEquals(4, navDepth())
        r.hostTruncate(0)                                         // < 1 → no-op (root survives)
        assertEquals(4, navDepth())
        r.hostTruncate(2)                                         // keep root … depth
        assertEquals(2, navDepth())
        assertEquals("/a", topPath())
        assertTrue(canPop())
    }

    @Test fun hostTruncateReleasesNativeFramesInThePoppedTail() {
        val r = makeRouter()
        r.push("/a")
        r.pushNative("SURFACE", path = "")                        // depth 3, native top
        val id = navStack().last()["id"] as Int
        r.hostTruncate(1)
        assertEquals(1, navDepth())
        assertEquals(listOf(id to "SURFACE" as Any), popped)      // onPop ran
        assertTrue(StackSurface.pushedFrames.isEmpty())           // held reference freed
    }

    // MARK: native frames

    @Test fun pushNativeRecordsComponentVarsAndSwallowsPathWritesWhileTop() {
        val r = makeRouter()
        r.pushNative("SURFACE", path = "", component = "Player", vars = mapOf("id" to 7))
        val top = navStack().last()
        assertEquals(true, top["native"])
        assertEquals("__native", top["view"])
        assertEquals("Player", top["component"])
        assertEquals(mapOf("id" to 7), top["vars"])
        assertEquals("/__native/${top["id"]}", top["path"])       // empty path → synthetic
        assertEquals("SURFACE", StackSurface.pushedFrames[top["id"]])
        DSX.state.setPath("route.path", "/elsewhere")             // background write while native owns the screen
        assertEquals(2, navDepth())                               // swallowed — no replace
        assertEquals(true, navStack().last()["native"])
        r.pop()                                                   // web navigation resumes; surface released
        assertEquals(1, navDepth())
        assertEquals(1, popped.size)
        assertTrue(StackSurface.pushedFrames.isEmpty())
    }

    @Test fun pushComponentBuildsFromTheTagAndFailsOpenWhenUnparsable() {
        val r = makeRouter()
        r.pushComponent("Cart", scope = null, path = "", vars = mapOf("sku" to "gold"))
        val top = navStack().last()
        assertEquals("Cart", top["component"])
        assertEquals(mapOf("sku" to "gold"), top["vars"])
        assertTrue(StackSurface.pushedFrames[top["id"]] is StackNode)  // default factory → the parsed root
        r.pop()
        r.pushComponent("", scope = null, path = "", vars = null)      // empty tag → logged no-op
        assertEquals(1, navDepth())
        r.pushComponent("   ", scope = null, path = "", vars = null)   // whitespace-only → no-op
        assertEquals(1, navDepth())
        r.surfaceFactory = { _, _, _ -> null }                         // failed factory build → no-op
        r.pushComponent("Cart", scope = null, path = "", vars = null)
        assertEquals(1, navDepth())
    }

    // MARK: modals — the state-backed chain (global.nav.modal)

    @Test fun presentComponentRecordsAStateBackedModalEntry() {
        val r = makeRouter()
        r.presentComponent("Paywall", scope = null, mode = "", vars = mapOf("plan" to "pro"),
                           detents = listOf("medium", "large"))
        val e = navModal().single()
        assertEquals("sheet", e["as"])                            // empty mode defaults to sheet
        assertEquals("Paywall", e["component"])
        assertEquals(mapOf("plan" to "pro"), e["vars"])
        assertEquals(listOf("medium", "large"), e["detents"])
        assertEquals(1, StackSurface.modalFrames.size)
    }

    @Test fun dismissingAChainEntryRemovesItsDescendantsButNotOverlays() {
        val r = makeRouter()
        r.presentModal("A", "sheet", "Paywall", null, null)
        val idA = navModal().last()["id"] as Int
        r.presentModal("O", "overlay", "Toast", null, null)
        val idO = navModal().last()["id"] as Int
        r.presentModal("B", "cover", "Details", null, null)
        val idB = navModal().last()["id"] as Int
        r.dismissModal("Paywall")                                 // chain parent → it + later chain entries go
        assertEquals(listOf(idO), navModal().map { it["id"] })    // the overlay is independent — it stays
        assertEquals(listOf(idA to "A" as Any, idB to "B" as Any), dismissed)  // parent-first onDismiss
        assertEquals(setOf(idO), StackSurface.modalFrames.keys)
        r.hostDismissedModal(idA)                                 // identity-keyed → already gone is a no-op
        assertEquals(1, navModal().size)
        r.dismissModal(null)                                      // default: pop the top
        assertTrue(navModal().isEmpty())
        r.dismissModal(null)                                      // dismiss-when-empty → documented no-op
        assertTrue(navModal().isEmpty())
    }

    @Test fun dismissingAnOverlayRemovesJustItAndTargetsMatchComponentOrMode() {
        val r = makeRouter()
        r.presentModal("A", "sheet", "Paywall", null, null)
        r.presentModal("O", "overlay", "Toast", null, null)
        r.dismissModal("overlay")                                 // target matches the `as:` mode
        assertEquals(listOf("Paywall"), navModal().map { it["component"] })
        r.dismissModal("nope")                                    // unmatched target → no-op
        assertEquals(1, navModal().size)
        val idA = navModal().single()["id"] as Int
        r.hostDismissedModal(idA)                                 // interactive dismissal report
        assertTrue(navModal().isEmpty())
        assertTrue(StackSurface.modalFrames.isEmpty())
    }

    // MARK: route.sync — re-resolve keeps the frame id when the mapping is unchanged

    @Test fun resolveCurrentKeepsTheFrameIdUnlessTheTableRemapped() {
        DSX.state.set("routes", listOf(mapOf("path" to "/p", "view" to "P", "src" to "1")))
        val r = makeRouter()
        r.push("/p")
        val id1 = navStack().last()["id"]
        r.resolveCurrent()                                        // unchanged mapping → same id (no reload)
        assertEquals(id1, navStack().last()["id"])
        DSX.state.set("routes", listOf(mapOf("path" to "/p", "view" to "P", "src" to "2")))
        r.resolveCurrent()                                        // remapped → a fresh frame id
        assertNotEquals(id1, navStack().last()["id"])
        assertEquals("2", DSX.state.getPath("route.src"))
        assertEquals(2, navDepth())                               // lower frames left as-is
    }

    // MARK: the unified table grammar — `component` mounts + `meta` bars (Router.swift materialize 1:1)

    @Test fun componentRouteMountsTheNamedNativeScreenWithSeededBarAndVars() {
        DSX.state.set("routes", listOf(mapOf(
            "path" to "/p/{id}", "component" to "shop.Product",
            "meta" to mapOf("title" to "Product"))))
        JSE.moduleAvailable = { it == "shop.Product" }
        val r = makeRouter()
        r.push("/p/7?ref=mail")
        val top = navStack().last()
        assertEquals(true, top["native"])                          // a REAL native mount, not a web frame
        assertEquals(true, top["route"])                           // …but URL-resolvable, unlike a module push
        assertEquals("__native", top["view"])
        assertEquals("shop.Product", top["component"])
        assertEquals("/p/7?ref=mail", top["path"])                 // popTo/deep-link addressable
        assertEquals(mapOf("id" to "7", "ref" to "mail"), top["vars"])   // params + query → vars (web parity)
        assertTrue(StackSurface.pushedFrames[top["id"]] is StackNode)    // held exactly like a module push
        // the bar seeded AT PUSH TIME from meta.title (no live claim, no chromeHint memory)
        assertEquals(mapOf("title" to "Product", "large" to false),
                     DSX.state.getPath("nav.chrome.${top["id"]}"))
        r.pop()                                                    // releases the held surface like any native frame
        assertEquals(1, popped.size)
        assertTrue(StackSurface.pushedFrames.isEmpty())
    }

    @Test fun componentRouteQueryWinsVarCollisionsAndChromeHintBeatsMeta() {
        DSX.state.set("routes", listOf(mapOf(
            "path" to "/p/{id}", "component" to "shop.Product",
            "meta" to mapOf("title" to "Product"))))
        JSE.moduleAvailable = { true }
        val r = makeRouter()
        r.chromeHintResolver = { component, _ ->
            if (component == "shop.Product") mapOf("title" to "Live", "large" to true) else null
        }
        r.push("/p/7?id=9")
        val top = navStack().last()
        assertEquals(mapOf("id" to "9"), top["vars"])              // query wins — navigatePath's {...params, ...query}
        assertEquals(mapOf("title" to "Live", "large" to true),    // the component's OWN claim beats the table meta
                     DSX.state.getPath("nav.chrome.${top["id"]}"))
    }

    @Test fun explicitMissingComponentRendersNativeUnavailableInsteadOfWebFallback() {
        DSX.state.set("routes", listOf(mapOf(
            "path" to "/p", "component" to "shop.Product",
            "meta" to mapOf("title" to "Product"))))
        JSE.moduleAvailable = { false }                            // excluded from this binary
        val r = makeRouter()
        r.push("/p")
        val top = navStack().last()
        assertEquals(null, top["native"])                          // dynamic compiled DSX route, no held surface needed
        assertEquals("", top["view"])   // bare kernel: unclaimed route.nativeUnavailable = empty view (Routing claims the real screen)
        assertEquals("shop.Product", top["requestedComponent"])
        assertEquals("component_unavailable", top["unavailableReason"])
        assertEquals(null, top["component"])
        assertTrue(StackSurface.pushedFrames.isEmpty())
        assertEquals(mapOf("title" to "Product", "large" to false),   // pushed screen keeps native back chrome
                     DSX.state.getPath("nav.chrome.${top["id"]}"))
        assertEquals("route_unavailable", broadcasts.last().first)
        assertEquals(JSON.from(mapOf("path" to "/p", "component" to "shop.Product",
                                     "reason" to "component_unavailable")),
                     broadcasts.last().second)
    }

    @Test fun explicitUnbuildableComponentUsesNativeUnavailableEvenWhenFactoryRejectsIt() {
        DSX.state.set("routes", listOf(mapOf("path" to "/broken", "component" to "shop.Broken")))
        JSE.moduleAvailable = { true }
        val r = makeRouter()
        r.surfaceFactory = { root, _, _ -> if (root.tag == "shop.Broken") null else root }
        r.push("/broken")
        val top = navStack().last()
        assertEquals("", top["view"])   // bare kernel: unclaimed route.nativeUnavailable = empty view (Routing claims the real screen)
        assertEquals("shop.Broken", top["requestedComponent"])
        assertEquals("component_unbuildable", top["unavailableReason"])
        assertEquals(null, top["native"])
        assertTrue(StackSurface.pushedFrames.isEmpty())
    }

    @Test fun pushedWebPathClaimsTheSystemBarFromMetaElseDerivedAndHonorsTheOptOut() {
        DSX.state.set("routes", listOf(
            mapOf("path" to "/help", "view" to "DSXWebView", "meta" to mapOf("title" to "Support Center")),
            mapOf("path" to "/bare", "view" to "DSXWebView", "meta" to mapOf("title" to ""))))
        val r = makeRouter()
        assertTrue((DSX.state.getPath("nav.chrome") as Map<*, *>).isEmpty())   // the ROOT never claims
        r.push("/help")                                            // declared meta.title
        assertEquals("Support Center",
                     (DSX.state.getPath("nav.chrome.${navStack().last()["id"]}") as Map<*, *>)["title"])
        r.push("/faq-page")                                        // unmatched → derived from the last segment
        assertEquals("Faq page",
                     (DSX.state.getPath("nav.chrome.${navStack().last()["id"]}") as Map<*, *>)["title"])
        r.push("/bare")                                            // explicit empty meta.title = "no bar"
        assertEquals(null, DSX.state.getPath("nav.chrome.${navStack().last()["id"]}"))
    }

    @Test fun explicitManifestFallbackWinsAtBootButNavigationStillMountsTheTableComponent() {
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": ["DSXStartup"] } }"""
        }
        AppManifest.routesLoader = {
            """{ "routes": [ { "path": "/", "component": "demo.Launcher" } ] }"""
        }
        JSE.moduleAvailable = { true }
        val r = makeRouter()                                       // boot "/" — the bundled demo maps it…
        assertEquals(null, navStack().last()["native"])            // …but the explicit ROOT stays the App.json entry surface
        assertEquals("DSXStartup", DSX.state.getPath("route.view"))
        assertTrue(StackSurface.pushedFrames.isEmpty())
        r.push("/")                                                // the SAME path via explicit navigation mounts
        assertEquals("demo.Launcher", navStack().last()["component"])
        assertEquals(true, navStack().last()["native"])
    }

    @Test fun webPlanOwnsBootAndTheTableStillDrivesNavigation() {
        // ROOT-PLAN law: boot mounts the plan's first candidate VERBATIM — the retired
        // table-first arm is gone (the plan owns the root; the table owns navigation).
        AppManifest.manifestLoader = {
            """{
                "host": "app.example.com",
                "entry": { "root": "/", "surfaces": ["DSXWebView"] }
            }"""
        }
        AppManifest.routesLoader = {
            """{ "routes": [ { "path": "/", "view": "ClientWeb", "src": "/home" } ] }"""
        }
        val r = makeRouter()
        assertEquals("DSXWebView", DSX.state.getPath("route.view"))    // plan[0], not the table row
        assertEquals("", DSX.state.getPath("route.src"))
        r.push("/")                                                // navigation resolves the table
        assertEquals("ClientWeb", DSX.state.getPath("route.view"))
        assertEquals("/home", DSX.state.getPath("route.src"))
    }

    // MARK: the ROOT PLAN's production wiring — frame-bound settle identity (root-plan.md §5)

    /** Drive the coordinator's publish (Lifecycle's `publish`) the way it really lands:
     *  IDENTITY BEFORE LEVEL — `screen.frame`, then `screen.phase`, then `screen.ready`. This
     *  renderer's state sink runs INLINE, so the order is load-bearing, not cosmetic. */
    private fun reportScreen(ready: Boolean, frame: Int?) {
        DSX.state.setPath("screen.frame", frame)
        DSX.state.setPath("screen.phase", if (ready) "ready" else "loading")
        DSX.state.setPath("screen.ready", ready)
    }

    /** Fail the LIVE attempt through the real error plane the Router observes (`dsx.errorCount`
     *  high-water + `dsx.lastError` with origin "root" — error-system.md). `lastError` lands
     *  first so the count edge finds it already in place. */
    private fun failRootAttempt(code: String) {
        // The ledger only ever GROWS, and the Router watches the high-water mark it captured at
        // boot — so the count must advance past whatever earlier tests left in the shared store.
        val next = ((DSX.state.getPath("dsx.errorCount") as? Int) ?: 0) + 1
        DSX.state.setPath("dsx.lastError", mapOf("origin" to "root", "code" to code))
        DSX.state.setPath("dsx.errorCount", next)
    }

    @Test fun aStaleFramesSettleNeverCrownsTheSuccessorCandidate() {
        // Long timeouts: nothing in this test may terminate by deadline.
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [
                    { "view": "A", "timeoutMs": 600000 },
                    { "view": "B", "timeoutMs": 600000 } ] } }"""
        }
        val r = makeRouter()
        val frameA = navStack().last()["id"] as Int
        assertEquals("A", DSX.state.getPath("route.view"))

        failRootAttempt("boom")                          // A fails → the fold advances to B
        assertEquals("B", DSX.state.getPath("route.view"))
        val frameB = navStack().last()["id"] as Int
        assertTrue(frameB != frameA, "each candidate mounts its OWN frame")

        // THE ZOMBIE: a late readiness report from the RETIRED candidate's frame. Before the
        // frame binding this crowned B on A's signal, with B's own timeoutMs never applying.
        reportScreen(ready = true, frame = frameA)
        assertEquals(null, r.rootFold?.winner, "a retired candidate's frame cannot crown its successor")
        // …and the REFUSED level is retired with it. A dropped settle that left `screen.ready`
        // standing would be only half a fix: this sink runs INLINE on every write, so B's very
        // next report writes `screen.frame = frameB` FIRST and would pair a fresh identity with
        // the corpse's `true` — crowning B on a `loading` report, blank, timeoutMs never applying.
        // Asserting the level here is what makes the two lines below a real test instead of a
        // coincidence: without it they pass whether or not B was already (wrongly) crowned.
        assertEquals(false, DSX.state.getPath("screen.ready"), "the refused level is retired, not left standing")

        // B's viewSTART — a `loading` report. It must not crown anything.
        reportScreen(ready = false, frame = frameB)
        assertEquals(null, r.rootFold?.winner, "a loading report never crowns the live candidate")

        // B's OWN settle still wins — the stale drop does not consume the live attempt's chance.
        reportScreen(ready = true, frame = frameB)
        assertEquals("B", r.rootFold?.winner?.view)
        assertEquals(false, DSX.state.getPath("root.live"))
        assertEquals(null, ScreenReadiness.suppressedDeadlineFrame)
    }

    @Test fun anUnshippedRootCandidateFailsForwardInsteadOfMountingBlank() {
        // Corpus F-10 on the PRODUCTION path. :core carries no component table, so the fold's
        // `registered` reads the seam the host binds from :render — bind a real one here and the
        // unshipped candidate fails forward instead of mounting an empty frame that would settle
        // as the winner on first render.
        JSE.componentAvailable = { it == "B" }
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [
                    { "view": "Ghost", "timeoutMs": 600000 },
                    { "view": "B", "timeoutMs": 600000 } ] } }"""
        }
        val r = makeRouter()
        assertEquals("B", DSX.state.getPath("route.view"), "Ghost is not in the build — the fold advanced")
        assertEquals("Ghost", r.rootFold?.ledger?.firstOrNull()?.view)
        assertEquals("root.component_missing", r.rootFold?.ledger?.firstOrNull()?.code)
    }

    @Test fun anUnboundComponentSeamFailsOpen() {
        // TYPED ABSENCE: null means "no registry to consult", never "no such component". A
        // runtime with no render layer must still boot its plan — the pre-seam behavior.
        JSE.componentAvailable = null
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [{ "view": "Ghost", "timeoutMs": 600000 }] } }"""
        }
        makeRouter()
        assertEquals("Ghost", DSX.state.getPath("route.view"))
    }

    @Test fun theCapabilityGateUnionsPackagesAndComponentsLikeSwift() {
        // Router.swift `available` = ModuleRegistry.isAvailable || StackComponents.has. A route
        // `requires`-ing a COMPONENT tag must resolve when that component ships, even though no
        // package answers to the name.
        DSX.state.set("routes", listOf(mapOf("path" to "/gallery", "view" to "Gallery",
                                             "requires" to listOf("Carousel"))))
        val r = makeRouter()
        r.push("/gallery")
        assertEquals("DSXWebView", DSX.state.getPath("route.view"))   // neither registry has it
        JSE.componentAvailable = { it == "Carousel" }
        r.push("/gallery")
        assertEquals("Gallery", DSX.state.getPath("route.view"))      // the component half satisfies it
    }

    @Test fun aFramelessReportStillSettlesTheLiveAttempt() {
        // The web relay's `dom*` describes the ONE app web surface and names no frame, so
        // `screen.frame` is null. Absence must NOT be read as "belongs to another attempt" —
        // it means "unbound", and the live attempt settles exactly as it always did.
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [{ "view": "A", "timeoutMs": 600000 }] } }"""
        }
        val r = makeRouter()
        reportScreen(ready = true, frame = null)
        assertEquals("A", r.rootFold?.winner?.view)
    }

    @Test fun aFrameThisPlanNeverMountedSettlesTheLiveAttempt() {
        // A cold deep-link frame settling also proves the app interactive: an id the plan does
        // not own resolves to no attempt, which is "unbound", not "stale".
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [{ "view": "A", "timeoutMs": 600000 }] } }"""
        }
        val r = makeRouter()
        reportScreen(ready = true, frame = 9_999)
        assertEquals("A", r.rootFold?.winner?.view)
    }

    @Test fun aRetiredWebCandidatesFramelessReportNeverCrownsItsSuccessor() {
        // THE DEFAULT WEB PLAN. A web-surface candidate is never tracked by ScreenReadiness
        // (only NATIVE frames are), so its readiness arrives frameless through the dom* relay —
        // which means the frame binding written at mount is for an id no report ever carries.
        // Without the frameless binding, candidate 0's late settle reads as "unbound" and crowns
        // whoever is live: the successor, before it rendered, its own timeoutMs never applying.
        ScreenReadiness.webSurfaceTags.add("DSXWebView")
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [
                    { "view": "DSXWebView", "timeoutMs": 600000 },
                    { "view": "Home", "timeoutMs": 600000 } ] } }"""
        }
        val r = makeRouter()
        failRootAttempt("web.main_frame_failed")
        assertEquals("Home", DSX.state.getPath("route.view"), "the fold advanced to Home")
        val homeFrame = ScreenReadiness.suppressedDeadlineFrame

        // The abandoned page finally finishes loading and settles — frameless, as the relay
        // always reports it. It belongs to the RETIRED attempt and must crown nobody.
        reportScreen(ready = true, frame = null)
        assertEquals(null, r.rootFold?.winner,
                     "a retired web candidate's frameless report crowned its successor")

        // Home's OWN report still settles it — the drop is targeted, not a blanket refusal.
        reportScreen(ready = true, frame = homeFrame)
        assertEquals("Home", r.rootFold?.winner?.view, "the live candidate can still be crowned")
    }

    @Test fun anErrorRaisedWhileTheFoldIsBetweenAttemptsNeverFailsTheSuccessor() {
        // `fail()` clears `live` BEFORE firing root.failed, so across that fire the fold is
        // neither live nor done — and `root.live` is still true, so a dying candidate's teardown
        // still tags its failure origin "root". That error must be CONSUMED in the window it
        // arrives in; leaving the high-water mark unadvanced re-delivers it to the successor,
        // which is then failed at elapsedMs ~0 with the dead candidate's code.
        // Failure must reach the fold from OUTSIDE a state-sink drain, or the raiser's write is
        // queued by the publication mailbox and observed only after the successor has mounted —
        // a different path with a different (and unfixable-without-a-stamp) answer. The
        // component_missing branch runs synchronously inside fold.start(), which is that window.
        ModuleRegistry.shared.register { TeardownRaiser() }
        JSE.componentAvailable = { it == "B" }
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [
                    { "view": "Ghost", "timeoutMs": 600000 },
                    { "view": "B", "timeoutMs": 600000 } ] } }"""
        }
        val r = makeRouter()
        assertEquals("B", DSX.state.getPath("route.view"), "the fold advanced to B")
        assertEquals(1, r.rootFold?.ledger?.size,
                     "B was failed by the error Ghost raised while dying")
        assertEquals("root.component_missing", r.rootFold?.ledger?.firstOrNull()?.code)
        assertEquals(null, DSX.state.getPath("root.exhausted"),
                     "the plan should not have exhausted")
    }

    @Test fun aRetryNeverInheritsThePreviousBootsFrameBindings() {
        // Frame ids are monotonic, but the value bound to them is an attempt INDEX — meaningful
        // only inside one fold. A retry restarts `live` at 0, so a dead run's frame bound to 0
        // would match the new fold's live index and crown its candidate on a corpse's signal.
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [{ "view": "A", "timeoutMs": 600000 }] } }"""
        }
        val r = makeRouter()
        val deadFrame = ScreenReadiness.suppressedDeadlineFrame
        failRootAttempt("boom")
        assertNotNull(DSX.state.getPath("root.exhausted"), "the one-candidate plan exhausted")

        r.retryRootPlan()
        assertEquals(null, r.rootFold?.winner, "the retry starts uncrowned")
        // The DEAD boot's frame reports late — exactly what retryRootPlan's comment says is
        // still registered and can still fire.
        reportScreen(ready = true, frame = deadFrame)
        assertEquals(null, r.rootFold?.winner,
                     "a dead boot's frame crowned the retry's candidate 0")
    }

    @Test fun aStampedTeardownErrorDeferredPastTheAdvanceNeverFailsTheSuccessor() {
        // THE MAILBOX-DEFERRED WINDOW. The raiser writes from inside the `root.failed` fire,
        // which is inside a state-sink drain — so its publication is QUEUED and delivered only
        // after `attempt(i+1)` has mounted the successor and made it live. An unstamped error
        // read there lands on the successor (the pre-existing hole); the stamp binds it to the
        // attempt that actually died, and the fold drops it as stale. This is the production
        // contract: Dom stamps `data.attempt` from `root.attempt` at emission.
        ModuleRegistry.shared._resetForTests()
        ModuleRegistry.shared.register { StampedTeardownRaiser() }
        AppManifest.manifestLoader = {
            """{ "entry": { "root": "/", "surfaces": [
                    { "view": "A", "timeoutMs": 600000 },
                    { "view": "B", "timeoutMs": 600000 } ] } }"""
        }
        val r = makeRouter()
        failRootAttempt("boom")
        assertEquals("B", DSX.state.getPath("route.view"), "the fold advanced to B")
        assertEquals(1, r.rootFold?.ledger?.size,
                     "the deferred teardown error was re-attributed to B")
        assertEquals("boom", r.rootFold?.ledger?.firstOrNull()?.code)
        assertEquals(null, r.rootFold?.winner)
        assertEquals(null, DSX.state.getPath("root.exhausted"),
                     "the plan should not have exhausted")
        ModuleRegistry.shared._resetForTests()   // the raiser must not bleed into other tests
    }

    @Test fun bundledTableIsTheOfflineFloorAndAPublishedTableWins() {
        AppManifest.routesLoader = {
            """{ "routes": [ { "path": "/p", "view": "Bundled", "src": "b" } ] }"""
        }
        val r = makeRouter()                                       // NO published table (global.routes empty)
        r.push("/p")
        assertEquals("Bundled", DSX.state.getPath("route.view"))   // the floor resolves offline, day one
        DSX.state.set("routes", listOf(mapOf("path" to "/p", "view" to "Published", "src" to "p")))
        r.resolveCurrent()                                         // a PUBLISHED (OTA) table always wins
        assertEquals("Published", DSX.state.getPath("route.view"))
    }

    @Test fun pathWritesReRouteATableResolvedNativeTopUnlikeAModulePush() {
        DSX.state.set("routes", listOf(mapOf("path" to "/a", "component" to "pages.A")))
        JSE.moduleAvailable = { true }
        val r = makeRouter()
        r.push("/a")
        assertEquals(true, navStack().last()["route"])
        DSX.state.setPath("route.path", "/b")                      // a URL-addressed screen re-routes in place
        assertEquals(2, navDepth())
        assertEquals("/b", topPath())
        assertEquals(null, navStack().last()["native"])            // /b is unmatched → the web fallback
        assertEquals(1, popped.size)                               // the replaced native surface was released
    }

    @Test fun resolveCurrentKeepsARouteResolvedNativeScreenUnlessTheTableRemapsIt() {
        DSX.state.set("routes", listOf(mapOf("path" to "/a", "component" to "pages.A")))
        JSE.moduleAvailable = { true }
        val r = makeRouter()
        r.push("/a")
        val id1 = navStack().last()["id"]
        r.resolveCurrent()                                         // same mapping → the LIVE screen stays
        assertEquals(id1, navStack().last()["id"])
        assertTrue(popped.isEmpty())
        DSX.state.set("routes", listOf(mapOf("path" to "/a", "component" to "pages.B")))
        r.resolveCurrent()                                         // remapped → swapped + old surface released
        assertNotEquals(id1, navStack().last()["id"])
        assertEquals("pages.B", navStack().last()["component"])
        assertEquals(1, popped.size)
    }

    /// The SHARED resolution corpus (Conformance/router/resolve.json) — the unified table
    /// grammar: `component` mounts, params+query→vars (query wins), `meta.title`. The web dom
    /// test drives the SAME file over the real FrameRouter.resolveUrl; Router.swift
    /// resolved()/materialize() is the compile-pending reference (the three-runtime law).
    /// END-TO-END here: seed the table, push the path, assert the frame + the seeded bar.
    @Test fun resolveMatchesTheSharedConformanceCorpus() {
        val text = File("../../../Conformance/router/resolve.json").readText()
        @Suppress("UNCHECKED_CAST")
        val cases = (json(text).foundationValue as Map<String, Any?>)["cases"] as List<Any?>
        assertTrue(cases.size >= 8, "expected a populated corpus, got ${cases.size}")
        for (raw in cases) {
            @Suppress("UNCHECKED_CAST")
            val case = raw as Map<String, Any?>
            val name = case["name"] as String
            val table = case["table"] as List<Any?>
            val path = case["path"] as String
            @Suppress("UNCHECKED_CAST")
            val expect = case["expect"] as Map<String, Any?>

            DSX.state.set("route", emptyMap<String, Any?>())      // per-case reset (loop shares the singleton)
            DSX.state.set("nav", emptyMap<String, Any?>())
            DSX.state.set("routes", table)
            JSE.moduleAvailable = { true }                        // every corpus component is "in this binary"
            StackSurface.pushedFrames.clear()
            val r = makeRouter()
            r.push(path)
            val top = navStack().last()
            val component = expect["component"] as? String
            if (component == null) {
                assertEquals(null, top["native"], name)           // degraded to the web fallback frame
                assertEquals("DSXWebView", top["view"], name)
            } else {
                assertEquals(component, top["component"], name)
                assertEquals(true, top["native"], name)
                assertEquals(true, top["route"], name)
                @Suppress("UNCHECKED_CAST")
                val vars = (expect["vars"] as? Map<String, Any?>) ?: emptyMap()
                assertEquals(if (vars.isEmpty()) null else vars, top["vars"], name)
                val title = expect["title"] as? String
                val spec = DSX.state.getPath("nav.chrome.${top["id"]}")
                if (title == null) assertEquals(null, spec, name) // no declared title → no seeded bar
                else assertEquals(title, (spec as Map<*, *>)["title"], name)
            }
            r.shutdown()
            router = null
        }
    }

    // MARK: the engine-owned broadcast + the reload verb

    @Test fun reportRouteUnavailableRoutesThroughTheSharedRouterAndNoOpsUnbooted() {
        makeRouter()
        Router.reportRouteUnavailable("/x", "rollback_detected")
        assertEquals("route_unavailable" to JSON.from(mapOf("path" to "/x", "reason" to "rollback_detected")),
                     broadcasts.last())
        val count = broadcasts.size
        Router.shared = null
        Router.reportRouteUnavailable("/y", "asset_integrity")    // unbooted → no-op, never a crash
        assertEquals(count, broadcasts.size)
    }

    @Test fun reloadFiresTheRouteRefreshHookThroughTheSeam() {
        val r = makeRouter()
        val fired = mutableListOf<String>()
        r.fire = { fired.add(it) }
        r.reload()
        assertEquals(listOf("route.refresh"), fired)
    }
}
