package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The geo conformance runner - executes OpenSource/Conformance/geo/{permission,geofence,
 * watch}.json through THIS runtime's GeoPolicy (parity/F09-geo.md). The TS twin
 * (@despia-native/kernel geo.ts, geo-conformance.test.ts) and the Swift reference (Engine/iOS
 * GeoPolicy) run the SAME files, so the permission ladder, the region cap and the battery
 * filter cannot mean one thing on one renderer and something else on another: a cold `always`
 * is refused everywhere, the twenty-first region is a typed error everywhere, and a
 * distanceFilter actually suppresses callbacks everywhere.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class GeoConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/geo/$name.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/geo/$name.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name.json version")
        return root
    }

    private fun strings(value: Any?): List<String> =
        (value as? List<Any?>)?.map { it as String } ?: emptyList()

    @Suppress("UNCHECKED_CAST")
    private fun state(row: Map<String, Any?>?): GeoPolicy.PermissionState = GeoPolicy.PermissionState(
        status = row?.get("status") as? String ?: "notDetermined",
        escalationOffered = row?.get("escalationOffered") as? Boolean ?: false,
        precise = row?.get("precise") as? Boolean ?: false,
    )

    @Test
    fun permissionVocabularyAgreesWithCorpus() {
        val doc = root("permission")
        assertEquals(strings(doc["statuses"]), GeoPolicy.STATUSES, "statuses")
        assertEquals(strings(doc["levels"]), GeoPolicy.LEVELS, "levels")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun permissionLadderAgreesWithCorpus() {
        val cases = root("permission")["plan"] as? List<Map<String, Any?>>
            ?: error("permission.json: no plan[]")
        assertTrue(cases.isNotEmpty(), "plan corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val plan = GeoPolicy.permissionPlan(
                case["level"] as? String, state(case["state"] as? Map<String, Any?>),
            )
            assertEquals(expect["action"] as String, plan.action, "$name: action")
            when (plan.action) {
                "prompt" -> assertEquals(expect["prompt"] as String, plan.prompt, "$name: prompt")
                "settle" -> {
                    assertEquals(expect["status"] as String, plan.status, "$name: status")
                    assertEquals(expect["prompted"] as Boolean, plan.prompted, "$name: prompted")
                }
                else -> assertEquals(expect["error"] as String, plan.error, "$name: refusal code")
            }
        }
    }

    @Test
    fun aColdAlwaysRequestIsRefused() {
        val cold = GeoPolicy.permissionPlan(
            "always", GeoPolicy.PermissionState(status = "notDetermined"),
        )
        assertEquals("refuse", cold.action)
        assertEquals("escalation_required", cold.error)
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun applyingAPromptResultAgreesWithCorpus() {
        val cases = root("permission")["apply"] as? List<Map<String, Any?>>
            ?: error("permission.json: no apply[]")
        assertTrue(cases.isNotEmpty(), "apply corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val next = GeoPolicy.applyPermission(
                state(case["state"] as? Map<String, Any?>),
                case["prompted"] as String,
                case["granted"] as Boolean,
            )
            assertEquals(expect["status"] as String, next.status, "$name: status")
            assertEquals(expect["escalationOffered"] as Boolean, next.escalationOffered, "$name: escalationOffered")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun escalationRouteAgreesWithCorpus() {
        val cases = root("permission")["route"] as? List<Map<String, Any?>>
            ?: error("permission.json: no route[]")
        assertTrue(cases.isNotEmpty(), "route corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val route = GeoPolicy.escalationRoute(
                case["platform"] as String, (case["sdk"] as Number).toInt(),
            )
            assertEquals(case["expect"] as String, route, name)
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun preciseDecisionAgreesWithCorpus() {
        val cases = root("permission")["precise"] as? List<Map<String, Any?>>
            ?: error("permission.json: no precise[]")
        assertTrue(cases.isNotEmpty(), "precise corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val outcome = GeoPolicy.preciseOutcome(
                case["requested"] as Boolean, case["granted"] as Boolean,
            )
            assertEquals(expect["ok"] as Boolean, outcome.ok, "$name: ok")
            if (outcome.ok) assertEquals(expect["precise"] as Boolean, outcome.precise, "$name: precise")
            else assertEquals(expect["error"] as String, outcome.error, "$name: error")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun regionCapsAgreeWithCorpus() {
        val caps = (root("geofence")["caps"] as? Map<String, Any?>)?.entries
            ?.associate { (k, v) -> k to (v as Number).toInt() } ?: emptyMap()
        assertEquals(caps, GeoPolicy.REGION_CAPS, "caps")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun regionAccountingAgreesWithCorpus() {
        val cases = root("geofence")["regions"] as? List<Map<String, Any?>>
            ?: error("geofence.json: no regions[]")
        assertTrue(cases.isNotEmpty(), "regions corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val ops = case["ops"] as? List<Map<String, Any?>> ?: error("$name: no ops")
            val expects = case["expect"] as? List<Map<String, Any?>> ?: error("$name: no expect")
            assertEquals(ops.size, expects.size, "$name: one expectation per op")

            val regions = GeoPolicy.RegionSet((case["cap"] as Number).toInt())
            ops.forEachIndexed { index, op ->
                val expect = expects[index]
                val where = "$name: op $index"
                if (op["list"] == true) {
                    assertEquals(strings(expect["ids"]), regions.list(), "$where: ids")
                    assertEquals((expect["count"] as Number).toInt(), regions.count, "$where: count")
                    return@forEachIndexed
                }
                val result = if (op.containsKey("add")) regions.add(op["add"] as? String)
                else regions.remove(op["remove"] as? String)
                assertEquals(expect["ok"] as Boolean, result.ok, "$where: ok")
                if (!result.ok) {
                    assertEquals(expect["error"] as String, result.error, "$where: error")
                    (expect["limit"] as? Number)?.let { assertEquals(it.toInt(), result.limit, "$where: limit") }
                    (expect["count"] as? Number)?.let { assertEquals(it.toInt(), result.count, "$where: count") }
                    return@forEachIndexed
                }
                assertEquals(expect["id"] as String, result.id, "$where: id")
                assertEquals((expect["count"] as Number).toInt(), result.count, "$where: count")
                if (expect.containsKey("removed")) {
                    assertEquals(expect["removed"] as Boolean, result.removed, "$where: removed")
                }
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun radiusClampAgreesWithCorpus() {
        val cases = root("geofence")["radius"] as? List<Map<String, Any?>>
            ?: error("geofence.json: no radius[]")
        assertTrue(cases.isNotEmpty(), "radius corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val clamped = GeoPolicy.radius((case["radius"] as Number).toDouble())
            assertEquals((expect["radius"] as Number).toDouble(), clamped.radius, "$name: radius")
            assertEquals(expect["clamped"] as Boolean, clamped.clamped, "$name: clamped")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun crossingDeliveryAgreesWithCorpus() {
        val cases = root("geofence")["delivery"] as? List<Map<String, Any?>>
            ?: error("geofence.json: no delivery[]")
        assertTrue(cases.isNotEmpty(), "delivery corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val plan = GeoPolicy.deliveryPlan(case["task"] as? String, case["screenMounted"] as Boolean)
            assertEquals(expect["broadcast"] as Boolean, plan.broadcast, "$name: broadcast")
            assertEquals(expect["background"] as Boolean, plan.background, "$name: background")
            assertEquals(expect["foreground"] as Boolean, plan.foreground, "$name: foreground")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun accuracyVocabularyAgreesWithCorpus() {
        val doc = root("watch")
        val rows = doc["accuracy"] as? List<Map<String, Any?>> ?: error("watch.json: no accuracy[]")
        assertEquals(rows.size, GeoPolicy.ACCURACIES.size, "accuracy row count")
        rows.forEachIndexed { index, row ->
            val entry = GeoPolicy.ACCURACIES[index]
            assertEquals(row["word"] as String, entry.word, "accuracy $index word")
            assertEquals(row["ios"] as String, entry.ios, "accuracy $index ios")
            assertEquals(row["android"] as String, entry.android, "accuracy $index android")
            assertEquals(row["web"] as String, entry.web, "accuracy $index web")
            assertEquals((row["meters"] as Number).toInt(), entry.meters, "accuracy $index meters")
        }
        assertEquals(doc["defaultAccuracy"] as String, GeoPolicy.DEFAULT_ACCURACY, "default accuracy")

        val folds = doc["accuracyFold"] as? List<Map<String, Any?>> ?: error("watch.json: no accuracyFold[]")
        for (case in folds) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val resolved = GeoPolicy.accuracy(case["word"] as? String)
            if (expect.containsKey("error")) {
                assertNull(resolved, "$name: expected a refusal")
            } else {
                assertNotNull(resolved, "$name: expected a resolved accuracy")
                assertEquals(expect["word"] as String, resolved.word, "$name: word")
            }
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun distanceAgreesWithCorpus() {
        val cases = root("watch")["distance"] as? List<Map<String, Any?>>
            ?: error("watch.json: no distance[]")
        assertTrue(cases.isNotEmpty(), "distance corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val from = case["from"] as Map<String, Any?>
            val to = case["to"] as Map<String, Any?>
            val meters = GeoPolicy.distanceMeters(
                (from["lat"] as Number).toDouble(), (from["lon"] as Number).toDouble(),
                (to["lat"] as Number).toDouble(), (to["lon"] as Number).toDouble(),
            )
            val expected = (case["expectMeters"] as Number).toDouble()
            val tolerance = (case["toleranceMeters"] as Number).toDouble()
            assertTrue(
                GeoPolicy.withinTolerance(meters, expected, tolerance),
                "$name: $meters is not within $tolerance of $expected",
            )
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun distanceFilterSuppressesCallbacks() {
        val cases = root("watch")["filter"] as? List<Map<String, Any?>>
            ?: error("watch.json: no filter[]")
        assertTrue(cases.isNotEmpty(), "filter corpus must not be empty")
        var suppressed = 0
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val lastRow = case["last"] as? Map<String, Any?>
            val nextRow = case["next"] as Map<String, Any?>
            val last = lastRow?.let {
                GeoPolicy.Fix(
                    (it["lat"] as Number).toDouble(), (it["lon"] as Number).toDouble(),
                    (it["at"] as Number).toLong(),
                )
            }
            val next = GeoPolicy.Fix(
                (nextRow["lat"] as Number).toDouble(), (nextRow["lon"] as Number).toDouble(),
                (nextRow["at"] as Number).toLong(),
            )
            val verdict = GeoPolicy.shouldDeliver(
                last, next,
                (case["distanceFilter"] as Number).toDouble(),
                (case["interval"] as Number).toLong(),
            )
            assertEquals(expect["deliver"] as Boolean, verdict.deliver, "$name: deliver")
            (expect["reason"] as? String)?.let { assertEquals(it, verdict.reason, "$name: reason") }
            if (!verdict.deliver) suppressed += 1
        }
        assertTrue(suppressed > 0, "the corpus must prove that a filter actually suppresses something")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun cacheFreshnessAgreesWithCorpus() {
        val cases = root("watch")["maxAge"] as? List<Map<String, Any?>>
            ?: error("watch.json: no maxAge[]")
        assertTrue(cases.isNotEmpty(), "maxAge corpus must not be empty")
        for (case in cases) {
            val name = case["name"] as? String ?: "<unnamed>"
            val expect = case["expect"] as? Map<String, Any?> ?: error("$name: no expect")
            val serves = GeoPolicy.cacheServes(
                (case["ageMs"] as Number).toLong(), (case["maxAgeMs"] as Number).toLong(),
            )
            assertEquals(expect["serve"] as Boolean, serves, name)
        }
    }
}
