package despia.engine

import java.io.File
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The notify conformance runner - executes OpenSource/Conformance/notify/{permission,schedule,
 * channels,presentation,routing}.json through THIS runtime's NotifyCore (parity/F02-notifications.md).
 * The TS twin (@despia-native/kernel notify.ts, notify-conformance.test.ts) and the Swift reference
 * (Engine/iOS NotifyCore) run the SAME files, so a reminder cannot fire at 09:00 on one platform
 * and 08:00 on another, provisional authorization cannot mean two things, and an undeclared
 * Android channel cannot be a silent drop on one renderer and a typed error on the next.
 *
 * Missing corpus = loud failure - a silently-skipped conformance suite is how drift starts.
 */
class NotifyConformanceTest {

    private fun corpusFile(name: String): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(dir, "OpenSource/Conformance/notify/$name.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile ?: error("OpenSource/Conformance/notify/$name.json not found")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun root(name: String): Map<String, Any?> {
        val root = json(corpusFile(name).readText()).foundationValue as? Map<String, Any?>
            ?: error("$name.json: not a JSON object")
        assertEquals(1, (root["version"] as? Number)?.toInt(), "$name.json version")
        return root
    }

    @Suppress("UNCHECKED_CAST")
    private fun cases(doc: Map<String, Any?>, key: String): List<Map<String, Any?>> {
        val list = doc[key] as? List<Map<String, Any?>> ?: error("no $key[]")
        assertTrue(list.isNotEmpty(), "$key corpus must not be empty")
        return list
    }

    private fun strings(value: Any?): List<String> =
        (value as? List<Any?>)?.map { it as String } ?: emptyList()

    private fun longs(value: Any?): List<Long> =
        (value as? List<Any?>)?.map { (it as Number).toLong() } ?: emptyList()

    private fun name(case: Map<String, Any?>): String = case["name"] as? String ?: "<unnamed>"

    @Suppress("UNCHECKED_CAST")
    private fun expectOf(case: Map<String, Any?>): Map<String, Any?> =
        case["expect"] as? Map<String, Any?> ?: error("${name(case)}: no expect")

    // -- permission ---------------------------------------------------------------------

    private fun request(row: Any?): NotifyCore.PermissionRequest {
        @Suppress("UNCHECKED_CAST")
        val map = row as? Map<String, Any?> ?: emptyMap()
        fun flag(key: String) = map[key] == true
        return NotifyCore.PermissionRequest(
            provisional = flag("provisional"),
            critical = flag("critical"),
            alert = flag("alert"),
            sound = flag("sound"),
            badge = flag("badge"),
            carPlay = flag("carPlay"),
            announcement = flag("announcement"),
        )
    }

    private fun state(row: Any?): NotifyCore.PermissionState {
        @Suppress("UNCHECKED_CAST")
        val map = row as? Map<String, Any?> ?: emptyMap()
        return NotifyCore.PermissionState(
            status = map["status"] as? String ?: "undetermined",
            promptShown = map["promptShown"] as? Boolean ?: false,
            criticalEntitled = map["criticalEntitled"] as? Boolean,
        )
    }

    @Test
    fun permissionVocabularyAgreesWithCorpus() {
        val doc = root("permission")
        assertEquals(strings(doc["statuses"]), NotifyCore.STATUSES, "statuses")
        assertEquals(strings(doc["options"]), NotifyCore.OPTIONS, "options")
        assertEquals(strings(doc["defaultOptions"]), NotifyCore.DEFAULT_OPTIONS, "defaultOptions")
        assertEquals(
            (doc["androidRuntimePermissionSdk"] as Number).toInt(),
            NotifyCore.ANDROID_RUNTIME_PERMISSION_SDK,
            "androidRuntimePermissionSdk",
        )
        @Suppress("UNCHECKED_CAST")
        val support = doc["support"] as Map<String, Any?>
        for ((platform, words) in support) {
            assertEquals(strings(words), NotifyCore.PLATFORM_OPTIONS[platform] ?: emptyList(), "support.$platform")
        }
    }

    @Test
    fun permissionLadderAgreesWithCorpus() {
        for (case in cases(root("permission"), "plan")) {
            val label = name(case)
            val plan = NotifyCore.permissionPlan(
                request(case["request"]),
                state(case["state"]),
                case["platform"] as String,
                (case["sdk"] as? Number)?.toInt() ?: 0,
            )
            val expect = expectOf(case)
            assertEquals(expect["action"] as String, plan.action, "$label: action")
            (expect["prompted"] as? Boolean)?.let { assertEquals(it, plan.prompted, "$label: prompted") }
            (expect["quiet"] as? Boolean)?.let { assertEquals(it, plan.quiet, "$label: quiet") }
            (expect["escalation"] as? Boolean)?.let { assertEquals(it, plan.escalation, "$label: escalation") }
            (expect["status"] as? String)?.let { assertEquals(it, plan.status, "$label: status") }
            (expect["error"] as? String)?.let { assertEquals(it, plan.error, "$label: error") }
            if (expect.containsKey("options")) {
                assertEquals(strings(expect["options"]), plan.options, "$label: options")
            }
            if (expect.containsKey("dropped")) {
                assertEquals(strings(expect["dropped"]), plan.dropped, "$label: dropped")
            }
        }
    }

    @Test
    fun provisionalNeverPromptsWhichIsTheWholeReasonItExists() {
        val plan = NotifyCore.permissionPlan(
            NotifyCore.PermissionRequest(provisional = true),
            NotifyCore.PermissionState(status = "undetermined", promptShown = false),
            "ios",
        )
        assertEquals("authorize", plan.action)
        assertEquals(false, plan.prompted)
        assertEquals(true, plan.quiet)
    }

    @Test
    fun applyingAPromptResultAgreesWithCorpus() {
        for (case in cases(root("permission"), "apply")) {
            val label = name(case)
            val next = NotifyCore.applyPermission(
                state(case["state"]),
                case["action"] as String,
                case["escalation"] == true,
                case["granted"] == true,
            )
            val expect = expectOf(case)
            assertEquals(expect["status"] as String, next.status, "$label: status")
            assertEquals(expect["promptShown"] as Boolean, next.promptShown, "$label: promptShown")
        }
    }

    @Test
    fun aDeclinedEscalationKeepsTheQuietGrant() {
        val next = NotifyCore.applyPermission(
            NotifyCore.PermissionState(status = "provisional", promptShown = false),
            action = "prompt", escalation = true, granted = false,
        )
        assertEquals("provisional", next.status)
    }

    @Test
    fun theSettingsChangedWhileBackgroundedTransitionAgreesWithCorpus() {
        for (case in cases(root("permission"), "observe")) {
            val label = name(case)
            val observed = NotifyCore.observePermission(state(case["state"]), case["os"] as String)
            val expect = expectOf(case)
            assertEquals(expect["status"] as String, observed.state.status, "$label: status")
            assertEquals(expect["promptShown"] as Boolean, observed.state.promptShown, "$label: promptShown")
            assertEquals(expect["changed"] as Boolean, observed.changed, "$label: changed")
            assertEquals(expect["broadcast"] as Boolean, observed.broadcast, "$label: broadcast")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theWholeLadderRunsAsASequenceNotJustAsIsolatedTransitions() {
        for (run in cases(root("permission"), "sequence")) {
            val runName = name(run)
            val platform = run["platform"] as String
            val sdk = (run["sdk"] as? Number)?.toInt() ?: 0
            var current = NotifyCore.PermissionState(status = "undetermined", promptShown = false)
            var plan = NotifyCore.permissionPlan(NotifyCore.PermissionRequest(), current, platform, sdk)
            for (step in run["steps"] as List<Map<String, Any?>>) {
                val verb = step["do"] as String
                val label = "$runName / $verb"
                val expect = step["expect"] as? Map<String, Any?> ?: error("$label: no expect")
                when (verb) {
                    "plan" -> {
                        plan = NotifyCore.permissionPlan(request(step["request"]), current, platform, sdk)
                        assertEquals(expect["action"] as String, plan.action, "$label: action")
                        (expect["quiet"] as? Boolean)?.let { assertEquals(it, plan.quiet, "$label: quiet") }
                        (expect["escalation"] as? Boolean)?.let { assertEquals(it, plan.escalation, "$label: escalation") }
                        (expect["status"] as? String)?.let { assertEquals(it, plan.status, "$label: status") }
                        (expect["error"] as? String)?.let { assertEquals(it, plan.error, "$label: error") }
                    }
                    "apply" -> {
                        current = NotifyCore.applyPermission(
                            current, plan.action, plan.escalation, step["granted"] == true,
                        )
                        assertEquals(expect["status"] as String, current.status, "$label: status")
                    }
                    else -> {
                        val observed = NotifyCore.observePermission(current, step["os"] as String)
                        current = observed.state
                        assertEquals(expect["status"] as String, current.status, "$label: status")
                        (expect["broadcast"] as? Boolean)?.let { assertEquals(it, observed.broadcast, "$label: broadcast") }
                    }
                }
            }
        }
    }

    // -- the trigger resolver -----------------------------------------------------------

    @Suppress("UNCHECKED_CAST")
    private fun zones(): Map<String, NotifyCore.ZoneRules> {
        val table = root("schedule")["zones"] as Map<String, Map<String, Any?>>
        return table.mapValues { (_, rules) ->
            NotifyCore.ZoneRules(
                base = (rules["base"] as Number).toInt(),
                transitions = (rules["transitions"] as? List<Map<String, Any?>> ?: emptyList()).map {
                    NotifyCore.ZoneTransition(
                        at = (it["at"] as Number).toLong(),
                        offset = (it["offset"] as Number).toInt(),
                    )
                },
            )
        }
    }

    private fun trigger(row: Any?): NotifyCore.Trigger {
        @Suppress("UNCHECKED_CAST")
        val map = row as? Map<String, Any?> ?: emptyMap()
        return NotifyCore.Trigger(
            at = map["at"],
            inSeconds = (map["in"] as? Number)?.toDouble(),
            cron = map["cron"] as? String,
            repeats = map["repeats"] as? String,
        )
    }

    @Test
    fun theScheduleVocabularyAgreesWithCorpus() {
        val doc = root("schedule")
        assertEquals((doc["searchDays"] as Number).toInt(), NotifyCore.CRON_SEARCH_DAYS, "searchDays")
        assertEquals(strings(doc["units"]), NotifyCore.REPEAT_UNITS, "units")
    }

    @Test
    fun everyFireTimeAgreesWithCorpusDstBoundariesAndLeapDayIncluded() {
        val table = zones()
        for (case in cases(root("schedule"), "resolve")) {
            val label = name(case)
            val plan = NotifyCore.fireTimes(
                trigger(case["trigger"]),
                (case["from"] as Number).toLong(),
                table[case["zone"] as? String],
                (case["count"] as Number).toInt(),
            )
            val expect = expectOf(case)
            assertTrue(plan.ok, "$label: expected a resolution, got ${plan.error}")
            assertEquals(expect["kind"] as String, plan.kind, "$label: kind")
            assertEquals(longs(expect["fires"]), plan.fires, "$label: fires")
            (expect["exhausted"] as? Boolean)?.let { assertEquals(it, plan.exhausted, "$label: exhausted") }
        }
    }

    @Test
    fun everyRejectedTriggerAgreesWithCorpus() {
        val utc = zones()["UTC"] ?: error("schedule.json: no UTC zone")
        for (case in cases(root("schedule"), "reject")) {
            val label = name(case)
            val plan = NotifyCore.fireTimes(trigger(case["trigger"]), 1767225600000L, utc, 3)
            assertTrue(!plan.ok, "$label: expected a refusal, got ${plan.fires}")
            assertEquals(expectOf(case)["error"] as String, plan.error, "$label: error")
        }
    }

    @Test
    fun theSpringForwardGapMovesAFireItNeverDropsOne() {
        val table = zones()
        val plan = NotifyCore.fireTimes(
            NotifyCore.Trigger(cron = "30 2 * * *"), 1772798400000L, table["America/New_York"], 4,
        )
        assertTrue(plan.ok)
        assertEquals(4, plan.fires.size, "four days, four fires - none skipped")
    }

    @Test
    fun anIsoInstantWithoutAZoneIsRefusedRatherThanGuessedAt() {
        assertNull(NotifyCore.parseInstant("2026-06-01T12:00:00"))
        assertEquals(1780315200000L, NotifyCore.parseInstant("2026-06-01T12:00:00Z"))
        assertEquals(1780315200000L, NotifyCore.parseInstant("2026-06-01T14:00:00+02:00"))
    }

    // -- channels -----------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theImportanceTableAgreesWithCorpus() {
        val doc = root("channels")
        val rows = doc["importance"] as List<Map<String, Any?>>
        assertEquals(rows.size, NotifyCore.IMPORTANCE.size, "importance row count")
        for ((index, row) in rows.withIndex()) {
            val entry = NotifyCore.IMPORTANCE[index]
            assertEquals(row["word"] as String, entry.word, "importance[$index].word")
            assertEquals((row["android"] as Number).toInt(), entry.android, "importance[$index].android")
            assertEquals(row["ios"] as String, entry.ios, "importance[$index].ios")
            assertEquals(row["headsUp"] as Boolean, entry.headsUp, "importance[$index].headsUp")
            assertEquals(row["sound"] as Boolean, entry.sound, "importance[$index].sound")
        }
        assertEquals(doc["defaultImportance"] as String, NotifyCore.DEFAULT_IMPORTANCE, "defaultImportance")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theChannelFoldAgreesWithCorpus() {
        for (case in cases(root("channels"), "fold")) {
            val label = name(case)
            val existingRow = case["existing"] as? Map<String, Any?>
            val existing = existingRow?.let {
                NotifyCore.ChannelState(
                    importance = it["importance"] as String,
                    userSet = it["userSet"] as? Boolean ?: false,
                    blocked = it["blocked"] as? Boolean ?: false,
                )
            }
            val fold = NotifyCore.channelFold(existing, case["requested"] as? String)
            val expect = expectOf(case)
            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(!fold.ok, "$label: expected a refusal")
                assertEquals(expectedError, fold.error, "$label: error")
                continue
            }
            assertTrue(fold.ok, "$label: expected a fold")
            assertEquals(expect["importance"] as String, fold.importance, "$label: importance")
            assertEquals(expect["created"] as Boolean, fold.created, "$label: created")
            assertEquals(expect["changed"] as Boolean, fold.changed, "$label: changed")
            assertEquals(expect["lockedByUser"] as Boolean, fold.lockedByUser, "$label: lockedByUser")
            (expect["blocked"] as? Boolean)?.let { assertEquals(it, fold.blocked, "$label: blocked") }
        }
    }

    @Test
    fun theChannelRequiredGateAgreesWithCorpus() {
        for (case in cases(root("channels"), "required")) {
            val label = name(case)
            val verdict = NotifyCore.channelRequired(
                case["platform"] as String,
                (case["sdk"] as? Number)?.toInt() ?: 0,
                case["channel"] as? String,
                strings(case["known"]),
            )
            val expect = expectOf(case)
            assertEquals(expect["ok"] as Boolean, verdict.ok, "$label: ok")
            if (verdict.ok) {
                assertEquals(expect["channel"] as? String, verdict.channel, "$label: channel")
            } else {
                assertEquals(expect["error"] as String, verdict.error, "$label: error")
                assertEquals(expect["channel"] as String, verdict.channel, "$label: the refusal NAMES the id")
            }
        }
    }

    // -- presentation -------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun thePresentationVocabularyAgreesWithCorpus() {
        val doc = root("presentation")
        assertEquals(strings(doc["words"]), NotifyCore.PRESENTATION_WORDS, "words")
        val aliases = (doc["aliases"] as Map<String, Any?>).mapValues { it.value as String }
        assertEquals(aliases, NotifyCore.PRESENTATION_ALIASES, "aliases")
        assertEquals(emptyList(), strings(doc["default"]), "default")
    }

    @Test
    fun theForegroundFoldAgreesWithCorpus() {
        for (case in cases(root("presentation"), "fold")) {
            val label = name(case)
            val configured = if (case["configured"] == null) null else strings(case["configured"])
            val fold = NotifyCore.presentation(
                configured,
                case["claimed"] == true,
                case["platform"] as String,
                case["importance"] as? String,
            )
            val expect = expectOf(case)
            val expectedError = expect["error"] as? String
            if (expectedError != null) {
                assertTrue(!fold.ok, "$label: expected a refusal")
                assertEquals(expectedError, fold.error, "$label: error")
                continue
            }
            assertTrue(fold.ok, "$label: expected a fold")
            assertEquals(strings(expect["present"]), fold.present, "$label: present")
            assertEquals(expect["suppressed"] as Boolean, fold.suppressed, "$label: suppressed")
            assertEquals(expect["headsUp"] as Boolean, fold.headsUp, "$label: headsUp")
            assertEquals(strings(expect["dropped"]), fold.dropped, "$label: dropped")
            assertEquals(strings(expect["degraded"]), fold.degraded, "$label: degraded")
        }
    }

    @Test
    fun aClaimedNotifyReceivedSuppressesThePresentationOnEveryPlatform() {
        for (platform in listOf("ios", "android", "web")) {
            val fold = NotifyCore.presentation(listOf("alert", "sound"), true, platform, "high")
            assertTrue(fold.ok, platform)
            assertEquals(true, fold.suppressed, platform)
            assertEquals(emptyList(), fold.present, platform)
        }
    }

    // -- routing ------------------------------------------------------------------------

    @Test
    @Suppress("UNCHECKED_CAST")
    fun theRoutingVocabularyAgreesWithCorpus() {
        val doc = root("routing")
        assertEquals(strings(doc["defaultActionIds"]), NotifyCore.DEFAULT_ACTION_IDS, "defaultActionIds")
        assertEquals(strings(doc["dismissActionIds"]), NotifyCore.DISMISS_ACTION_IDS, "dismissActionIds")
        val bounds = doc["bounds"] as Map<String, Any?>
        assertEquals((bounds["path"] as Number).toInt(), NotifyCore.PATH_BYTES, "bounds.path")
        assertEquals((bounds["url"] as Number).toInt(), NotifyCore.URL_BYTES, "bounds.url")
        assertEquals((bounds["event"] as Number).toInt(), NotifyCore.EVENT_BYTES, "bounds.event")
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun everyTapShapeNormalisesToTheSamePayload() {
        for (case in cases(root("routing"), "open")) {
            val label = name(case)
            val raw = case["raw"] as Map<String, Any?>
            val payload = NotifyCore.openPayload(
                NotifyCore.RawOpen(
                    id = raw["id"] as? String,
                    actionId = raw["actionId"] as? String,
                    userText = raw["userText"] as? String,
                    data = raw["data"] as? Map<String, Any?>,
                ),
                case["coldStart"] == true,
            )
            val expect = expectOf(case)
            assertEquals(expect["kind"] as String, payload.kind, "$label: kind")
            assertEquals(expect["id"] as String, payload.id, "$label: id")
            if (expect["kind"] == "dismissed") continue
            assertEquals(expect["data"] as Map<String, Any?>, payload.data, "$label: data")
            assertEquals(expect["coldStart"] as Boolean, payload.coldStart, "$label: coldStart")
            assertEquals(expect["actionId"] as? String, payload.actionId, "$label: actionId")
            assertEquals(expect["userText"] as? String, payload.userText, "$label: userText")
        }
    }

    @Test
    @Suppress("UNCHECKED_CAST")
    fun thePushRoutingRecordAgreesWithCorpusBoundsAndAll() {
        val doc = root("routing")
        val repeat = doc["repeatToken"] as Map<String, Any?>
        val token = repeat["token"] as String
        val filler = (repeat["char"] as String).repeat((repeat["count"] as Number).toInt())
        for (case in cases(doc, "record")) {
            val label = name(case)
            val payload = case["payload"] as Map<String, Any?>
            val data = (payload["data"] as Map<String, Any?>).mapValues { (_, value) ->
                if (value is String) value.replace(token, filler) else value
            }
            val record = NotifyCore.routingRecord(data)
            val expect = expectOf(case)
            assertEquals(expect["path"] as? String, record.path, "$label: path")
            assertEquals(expect["url"] as? String, record.url, "$label: url")
        }
    }
}
