package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The V02..V06 inline-vendor-surface conformance runner - executes
 * OpenSource/Conformance/inline-surfaces/{stream,clerk,admob,revenuecat,scanner}.json
 * through THIS runtime (architecture/proposals/inline-native-surfaces.md,
 * parity/V02-V06-inline-surfaces.md). The TS twin
 * (packages/kernel/test/vendor-surface-conformance.test.ts) and the Swift twin
 * (Engine/iOS/VendorSurface.swift) run the SAME five files.
 *
 * Two things are proven at once. THE SHARED CORE IS SHARED: every vendor's sessionRef,
 * machine and retain section runs through V01's VendorSessionRef / VendorSessionMachine /
 * VendorRetain unchanged, so five vendors have ONE session machine between them. THE FAMILY
 * FOLDS AGREE: the permission ladder, the call roster, the ad slot and request gate, the
 * paywall ordering, the sign-in ladder and the scan dedupe are one implementation each.
 *
 * Missing corpus = loud failure. A silently-skipped conformance suite is how drift starts,
 * and the drift here is a camera surface that asks for permission on one platform and
 * refuses on another.
 */
class VendorSurfaceConformanceTest {

    private val vendors = listOf("stream", "clerk", "admob", "revenuecat", "scanner", "pay")

    private fun corpusFile(vendor: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/inline-surfaces/$vendor.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/inline-surfaces/$vendor.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(vendor: String): Map<String, Any?> {
        val root = json(corpusFile(vendor).readText()).foundationValue as? Map<String, Any?>
            ?: error("$vendor.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$vendor.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(vendor: String, name: String): Map<String, Any?>? =
        root(vendor)[name] as? Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    private fun cases(section: Map<String, Any?>, key: String = "cases"): List<Map<String, Any?>> =
        section[key] as? List<Map<String, Any?>> ?: error("no $key[]")

    @Suppress("UNCHECKED_CAST")
    private fun strings(value: Any?): List<String> =
        (value as? List<Any?>)?.map { it as String } ?: emptyList()

    private fun number(value: Any?, fallback: Int = 0): Int = (value as? Number)?.toInt() ?: fallback

    /** Every section of this name, across all five files. */
    private fun everySection(name: String): List<Pair<String, Map<String, Any?>>> {
        val found = vendors.mapNotNull { v -> section(v, name)?.let { v to it } }
        assertTrue(found.isNotEmpty(), "no corpus declares a $name section")
        return found
    }

    // -- 1 - the SHARED secret boundary, five vendors -------------------------------------

    @Test
    fun everyVendorsSessionReferenceRunsThroughTheOneSharedResolver() {
        for ((vendor, section) in everySection("sessionRef")) {
            val kinds = strings(section["kinds"]).toSet()
            val refusals = strings(section["refusals"]).toSet()
            val families = strings(section["families"]).toSet()
            val reached = HashSet<String>()
            val rows = cases(section)
            assertTrue(rows.isNotEmpty(), "$vendor: sessionRef corpus must not be empty")

            for (row in rows) {
                val where = "$vendor: ${row["name"]}"
                @Suppress("UNCHECKED_CAST")
                val expect = row["expect"] as Map<String, Any?>
                val result = VendorSessionRef.resolve(row["value"] as? String)

                val expectedError = expect["error"] as? String
                if (expectedError != null) {
                    assertTrue(result.isFailure, "$where: expected refusal $expectedError, got ${result.getOrNull()}")
                    assertTrue(refusals.contains(expectedError), "$where: undeclared refusal $expectedError")
                    val failure = result.exceptionOrNull() as VendorSessionRef.RefusalError
                    assertEquals(expectedError, VendorSessionRef.code(failure.refusal), "$where: refusal code")
                    val expectedFamily = expect["family"] as? String
                    assertEquals(
                        expectedFamily,
                        failure.family?.let { VendorSessionRef.code(it) },
                        "$where: credential family",
                    )
                    if (expectedFamily != null) {
                        assertTrue(families.contains(expectedFamily), "$where: undeclared family $expectedFamily")
                        reached.add(expectedFamily)
                    }
                    continue
                }

                assertTrue(result.isSuccess, "$where: expected a reference, got ${result.exceptionOrNull()?.message}")
                val ref = result.getOrThrow()
                assertTrue(kinds.contains(expect["kind"] as String), "$where: undeclared kind ${expect["kind"]}")
                assertEquals(expect["kind"] as String, VendorSessionRef.code(ref.kind), "$where: kind")
                assertEquals(expect["path"] as String, ref.path, "$where: path")
            }
            for (family in families) {
                assertTrue(reached.contains(family), "$vendor: family $family is declared but no row pins it")
            }
        }
    }

    // -- 2 - the SHARED session machine, five vendors -------------------------------------

    @Test
    fun everyVendorsLifecycleRunsOnTheOneSharedSessionMachine() {
        for ((vendor, section) in everySection("machine")) {
            assertEquals(listOf("overlay", "inline"), strings(section["views"]), "$vendor: canonical view order")
            assertEquals(VENDOR_VIEWS, strings(section["views"]), "$vendor: the kernel's own view order")
            val states = strings(section["states"]).toSet()
            val refusals = strings(section["refusals"]).toSet()
            val rows = cases(section)
            assertTrue(rows.isNotEmpty(), "$vendor: machine corpus must not be empty")

            for (row in rows) {
                val name = "$vendor: ${row["name"]}"
                @Suppress("UNCHECKED_CAST")
                val steps = row["steps"] as List<Map<String, Any?>>
                @Suppress("UNCHECKED_CAST")
                val expect = row["expect"] as List<Map<String, Any?>>
                assertEquals(steps.size, expect.size, "$name: one expectation per step")

                val machine = VendorSessionMachine()
                steps.forEachIndexed { index, step ->
                    val where = "$name: step $index (${step["op"]})"
                    val result = machine.step(
                        VendorSessionMachine.Step(
                            op = step["op"] as String,
                            view = step["view"] as? String,
                            code = step["code"] as? String,
                        )
                    )
                    val expected = expect[index]
                    val expectedState = expected["state"] as String
                    assertTrue(states.contains(expectedState), "$where: undeclared state $expectedState")

                    val expectedError = expected["error"] as? String
                    if (expectedError != null) {
                        assertTrue(!result.ok, "$where: expected refusal $expectedError, got $result")
                        assertTrue(refusals.contains(expectedError), "$where: undeclared refusal $expectedError")
                        assertEquals(expectedError, result.error, "$where: refusal code")
                        assertEquals(expectedState, result.state, "$where: state after a refusal")
                        assertEquals(expectedState, machine.state, "$where: a refusal never moves the machine")
                        return@forEachIndexed
                    }

                    assertTrue(result.ok, "$where: expected a step, got $result")
                    assertEquals(expectedState, result.state, "$where: state")
                    assertEquals(strings(expected["notify"]), result.notify, "$where: notify audience")
                    assertEquals(number(expected["attempts"]), result.attempts, "$where: attempts")
                    assertEquals(expected["outcome"] as? String, result.outcome, "$where: outcome")
                    assertEquals(expected["by"] as? String, result.by, "$where: originating view")
                    assertEquals(expected["code"] as? String, result.code, "$where: failure code")
                }
            }
        }
    }

    @Test
    fun theDoubleAttemptGuardHoldsForEveryVendorInTheFamily() {
        // Whatever the vendor calls its attempt - a join, a submit, an ad request, a
        // purchase, a delivered code - a second one while the first is in flight is refused,
        // from EITHER face.
        for (originator in VENDOR_VIEWS) {
            val other = if (originator == "inline") "overlay" else "inline"
            val machine = VendorSessionMachine()
            machine.step(VendorSessionMachine.Step("open"))
            machine.step(VendorSessionMachine.Step("attach", originator))
            machine.step(VendorSessionMachine.Step("attach", other))
            machine.step(VendorSessionMachine.Step("start", originator))
            val second = machine.step(VendorSessionMachine.Step("start", other))
            assertTrue(!second.ok, "$originator: a second attempt must be refused")
            assertEquals("busy", second.error, "$originator: the double-attempt guard")
        }
    }

    // -- 3 - keyed identity, five vendors --------------------------------------------------

    @Test
    fun everyVendorsRetainKeysAgreeWithCorpus() {
        for ((vendor, section) in everySection("retain")) {
            val rows = cases(section, "keys")
            assertTrue(rows.isNotEmpty(), "$vendor: retain corpus must not be empty")
            for (row in rows) {
                @Suppress("UNCHECKED_CAST")
                val input = row["input"] as Map<String, Any?>
                val key = VendorRetain.key(
                    tag = input["tag"] as String,
                    key = input["key"] as? String,
                    session = input["session"] as? String,
                    index = number(input["index"]),
                )
                assertEquals(row["expect"] as String, key, "$vendor: ${row["name"]}")
            }
        }
    }

    // -- 4 - the live-surface permission ladder ---------------------------------------------

    @Test
    fun theSurfaceGateAgreesWithCorpus() {
        for ((vendor, section) in everySection("gate")) {
            val renders = strings(section["renders"]).toSet()
            val codes = strings(section["codes"]).toSet()
            val rows = cases(section)
            assertTrue(rows.isNotEmpty(), "$vendor: gate corpus must not be empty")
            for (row in rows) {
                val name = "$vendor: ${row["name"]}"
                @Suppress("UNCHECKED_CAST")
                val input = row["input"] as Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val expect = row["expect"] as Map<String, Any?>
                val gate = VendorSurfaceGate.gate(
                    capability = VendorSurfaceGate.capability(input["capability"] as? String),
                    permission = VendorSurfaceGate.permission(input["permission"] as? String),
                    subject = (input["subject"] as? String).orEmpty(),
                )
                assertEquals(expect["render"] as String, gate.renderCode, "$name: render")
                assertEquals(expect["code"] as String, gate.code, "$name: code")
                assertEquals(expect["message"] as String, gate.message, "$name: message")
                assertEquals(expect["recoverable"] as Boolean, gate.recoverable, "$name: recoverable")
                assertTrue(renders.contains(gate.renderCode), "$name: undeclared render")
                assertTrue(codes.contains(gate.code), "$name: undeclared code")
                assertEquals(gate.code.isEmpty(), gate.render == SurfaceRender.SURFACE,
                    "$name: only the live surface is codeless")
            }
        }
    }

    // -- 5 - the call roster ------------------------------------------------------------------

    @Test
    fun theCallRosterAgreesWithCorpus() {
        val section = section("stream", "roster") ?: error("stream.json: no roster section")
        val rows = cases(section)
        assertTrue(rows.isNotEmpty(), "roster corpus must not be empty")
        for (row in rows) {
            val name = row["name"] as String
            @Suppress("UNCHECKED_CAST")
            val input = row["input"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val people = (input["participants"] as List<Map<String, Any?>>).map {
                VendorRoster.Participant(
                    id = it["id"] as String,
                    local = it["local"] as? Boolean ?: false,
                    pinned = it["pinned"] as? Boolean ?: false,
                    dominant = it["dominant"] as? Boolean ?: false,
                    screenShare = it["screenShare"] as? Boolean ?: false,
                    joinedAt = ((it["joinedAt"] as? Number)?.toLong()) ?: 0L,
                )
            }
            val fold = VendorRoster.fold(people, number(input["max"]), (input["layout"] as? String).orEmpty())
            assertEquals(strings(expect["order"]), fold.order, "$name: order")
            assertEquals(strings(expect["visible"]), fold.visible, "$name: visible")
            assertEquals(number(expect["overflow"]), fold.overflow, "$name: overflow")
            assertEquals(expect["spotlight"] as String, fold.spotlight, "$name: spotlight")
            assertEquals(number(expect["columns"]), fold.columns, "$name: columns")
            assertEquals(number(expect["rows"]), fold.rows, "$name: rows")
            assertTrue(fold.rows * fold.columns >= fold.visible.size, "$name: the grid must fit its tiles")
        }
    }

    // -- 6 - the ad slot and the request gate -------------------------------------------------

    @Test
    fun theAdSlotGeometryAgreesWithCorpus() {
        val section = section("admob", "slot") ?: error("admob.json: no slot section")
        for (size in strings(section["sizes"])) {
            if (size == "adaptive") continue
            assertTrue(VendorAdSlot.SIZES.containsKey(size), "declared size $size has no geometry")
        }
        for (row in cases(section)) {
            val name = row["name"] as String
            @Suppress("UNCHECKED_CAST")
            val input = row["input"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val slot = VendorAdSlot.slot(input["size"] as? String, number(input["width"]))
            assertEquals(number(expect["width"]), slot.width, "$name: width")
            assertEquals(number(expect["height"]), slot.height, "$name: height")
            assertEquals(expect["adaptive"] as Boolean, slot.adaptive, "$name: adaptive")
            assertEquals(expect["code"] as String, slot.code, "$name: code")
            assertTrue(!(slot.adaptive && slot.height > 0), "$name: an adaptive slot carries no guessed height")
        }
    }

    @Test
    fun theAdRequestGateAgreesWithCorpus() {
        val section = section("admob", "request") ?: error("admob.json: no request section")
        val codes = strings(section["codes"]).toSet()
        for (row in cases(section)) {
            val name = row["name"] as String
            @Suppress("UNCHECKED_CAST")
            val input = row["input"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val gate = VendorAdSlot.requestGate(
                unitId = input["unitId"] as? String,
                enabled = input["enabled"] as? Boolean ?: true,
                consent = (input["consent"] as? String) ?: "unknown",
                asserted = input["asserted"] as? String,
            )
            assertEquals(expect["request"] as Boolean, gate.request, "$name: request")
            assertEquals(expect["code"] as String, gate.code, "$name: code")
            assertEquals(expect["recoverable"] as Boolean, gate.recoverable, "$name: recoverable")
            assertTrue(codes.contains(gate.code), "$name: undeclared code")
            assertEquals(gate.request, gate.code.isEmpty(), "$name: a refused request must name a code")
        }
    }

    // -- 7 - the paywall --------------------------------------------------------------------

    @Test
    fun thePaywallFoldAgreesWithCorpus() {
        val section = section("revenuecat", "paywall") ?: error("revenuecat.json: no paywall section")
        assertEquals(strings(section["packageOrder"]), VendorPaywall.PACKAGE_ORDER, "package order")
        @Suppress("UNCHECKED_CAST")
        val months = (section["comparableMonths"] as Map<String, Any?>).mapValues { (it.value as Number).toInt() }
        assertEquals(months, VendorPaywall.PACKAGE_MONTHS.toMap(), "comparable months")

        for (row in cases(section)) {
            val name = row["name"] as String
            @Suppress("UNCHECKED_CAST")
            val input = row["input"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val packages = (input["packages"] as List<Map<String, Any?>>).map {
                VendorPaywall.Package(
                    id = it["id"] as String,
                    type = (it["type"] as? String) ?: "unknown",
                    price = ((it["price"] as? Number)?.toDouble()) ?: 0.0,
                )
            }
            val fold = VendorPaywall.fold(packages, input["selected"] as? String)
            assertEquals(strings(expect["order"]), fold.order, "$name: order")
            assertEquals(expect["defaultId"] as String, fold.defaultId, "$name: defaultId")
            assertEquals(expect["badgeId"] as String, fold.badgeId, "$name: badgeId")
            assertEquals(number(expect["savings"]), fold.savings, "$name: savings")
            assertEquals(fold.badgeId.isEmpty(), fold.savings == 0, "$name: a badge and a saving travel together")
        }
    }

    // -- 8 - the sign-in ladder ----------------------------------------------------------------

    @Test
    fun theSignInLadderAgreesWithCorpus() {
        val section = section("clerk", "ladder") ?: error("clerk.json: no ladder section")
        assertEquals(strings(section["strategyOrder"]), VendorSignIn.STRATEGY_ORDER, "strategy order")
        val steps = strings(section["steps"]).toSet()
        for (row in cases(section)) {
            val name = row["name"] as String
            @Suppress("UNCHECKED_CAST")
            val input = row["input"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val ladder = VendorSignIn.ladder(
                status = input["status"] as? String,
                strategies = strings(input["strategies"]),
                missing = strings(input["missing"]),
            )
            assertEquals(expect["step"] as String, ladder.step, "$name: step")
            assertEquals(strings(expect["fields"]), ladder.fields, "$name: fields")
            assertEquals(strings(expect["strategies"]), ladder.strategies, "$name: strategies")
            assertEquals(expect["terminal"] as Boolean, ladder.terminal, "$name: terminal")
            assertEquals(expect["code"] as String, ladder.code, "$name: code")
            assertTrue(steps.contains(ladder.step), "$name: undeclared step ${ladder.step}")
            assertTrue(ladder.terminal || ladder.step == "restart" || ladder.fields.isNotEmpty(),
                "$name: a non-terminal rung must ask for something")
        }
    }

    // -- 9 - the scan dedupe ---------------------------------------------------------------------

    @Test
    fun theScanGateAgreesWithCorpus() {
        val section = section("scanner", "scan") ?: error("scanner.json: no scan section")
        assertEquals(number(section["defaultDebounceMs"]).toLong(), VendorScan.DEFAULT_DEBOUNCE_MS, "default window")
        val reasons = strings(section["reasons"]).toSet()
        for (row in cases(section)) {
            val name = row["name"] as String
            @Suppress("UNCHECKED_CAST")
            val input = row["input"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val expect = row["expect"] as Map<String, Any?>
            val gate = VendorScan.gate(
                value = (input["value"] as? String).orEmpty(),
                format = (input["format"] as? String).orEmpty(),
                at = ((input["at"] as? Number)?.toLong()) ?: 0L,
                formats = strings(input["formats"]),
                mode = (input["mode"] as? String) ?: "once",
                debounceMs = ((input["debounceMs"] as? Number)?.toLong()) ?: VendorScan.DEFAULT_DEBOUNCE_MS,
                lastValue = (input["lastValue"] as? String).orEmpty(),
                lastAt = ((input["lastAt"] as? Number)?.toLong()) ?: 0L,
                emitted = input["emitted"] as? Boolean ?: false,
            )
            assertEquals(expect["emit"] as Boolean, gate.emit, "$name: emit")
            assertEquals(expect["reason"] as String, gate.reason, "$name: reason")
            assertTrue(reasons.contains(gate.reason), "$name: undeclared reason ${gate.reason}")
        }
    }

    @Test
    fun aLivePreviewCannotFireTheSameCodeTwiceInsideOneWindow() {
        // Thirty frames of the same code, the bug this fold exists to stop.
        var last = ""
        var lastAt = 0L
        var fired = 0
        for (frame in 0 until 30) {
            val at = frame * 33L
            val gate = VendorScan.gate(
                value = "https://despia.com", format = "qr", at = at,
                mode = "continuous", lastValue = last, lastAt = lastAt,
            )
            if (gate.emit) {
                fired += 1
                last = "https://despia.com"
                lastAt = at
            }
        }
        assertEquals(1, fired, "one code, one event")
    }
}
